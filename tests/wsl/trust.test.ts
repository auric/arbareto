// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T212 decision W8: the `gitSelectedPath` of a WSL trust approval is the UNC form of the approved Git path (contract §11 `wslIdentityPath`).
// Each case uses a seam registration (`seamRepository`), so it needs no Git 2.55.0. The trust listing runs the real Perl `fileFacts` probe.

import { afterEach, describe, expect, test } from "bun:test";
import type { FileFact } from "../../src/contracts/channel";
import { isWindows } from "../../src/contracts/native-path";
import { configListArgs } from "../../src/git-service/commands";
import type { FileFactsRequest, GitRunner } from "../../src/git-service/git-runner";
import type { Workspace } from "../../src/git-service/registration";
import { createTrust, type ListingOutcome } from "../../src/git-service/trust";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { printOrigin } from "../origin";
import { globalConfig, seamRepository, startSession, writeLinux, type SeamRepo, type WslSession } from "./fixtures";
import { listScopes, uncPath, useWslFolder, wslTest, type WslHost } from "./wsl-host";

printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);

const CASE_TIMEOUT_MS = 180_000;
const NEEDS = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "perl"] as const;

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
// Each dispose ends the WSL scopes of the runner through `wsl.exe`, so the hook takes the case bound.
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
}, CASE_TIMEOUT_MS);

function setup(host: WslHost): { runner: BunRunner; s: WslSession } {
  const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment: serviceEnv(), wslGlobalConfig: globalConfig(host) });
  runners.push(runner);
  return { runner, s: startSession(runner) };
}

// A repository-controlled clean filter makes reads need approval (contract §7). Its program lies in the owned folder.
function filterConfig(host: WslHost): string {
  const program = `${host.folder}/clean.sh`;
  writeLinux(host, program, "#!/bin/sh\nexec cat\n", "755");
  return `local\0file:.git/config\0filter.canary.clean\n${program}\0`;
}

async function register(s: WslSession, repo: SeamRepo): Promise<{ repositoryId: string; generation: number }> {
  const response = await s.response(s.chooseRepository(repo.path));
  expect(response).toMatchObject({ state: "succeeded" });
  return response.result as { repositoryId: string; generation: number };
}

async function approve(s: WslSession, w: { repositoryId: string; generation: number }) {
  const trust = await s.response(s.request("readTrust", {}, { repositoryId: w.repositoryId }));
  expect(trust).toMatchObject({ state: "succeeded" });
  const fingerprint = (trust.result as { fingerprint: string }).fingerprint;
  return s.response(s.request("approveTrust", { fingerprint, approve: true }, { repositoryId: w.repositoryId, repositoryGeneration: w.generation }));
}

describe("WSL trust approval of the selected Git (T212 decision W8)", () => {
  wslTest(
    "a WSL approveTrust stores the UNC form of the approved Git path",
    NEEDS,
    async (host) => {
      const { runner, s } = setup(host);
      const repo = seamRepository(host, runner, { config: filterConfig(host) });
      const approved = await approve(s, await register(s, repo));
      expect(approved).toMatchObject({ state: "succeeded", result: { persistence: "stored", saveFailed: false } });
      const record = runner.trustStore.records.at(-1)!;
      expect(record.gitSelectedPath).toBe(uncPath(host, host.probe.paths.git!));
      expect(record.commonIdentity).toMatchObject({ distroGuid: host.guid });
      expect(listScopes(host)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a Git path that Windows cannot show refuses readTrust with the approveTrust refusal, so no approval is offered",
    NEEDS,
    async (host) => {
      const { runner, s } = setup(host);
      const git = "/opt/a:b/git";
      const repo = seamRepository(host, runner, { config: filterConfig(host), probe: { git } });
      const w = await register(s, repo);
      // T318: `readTrust` issues no fingerprint, so `approveTrust` cannot follow. tests/git/trust.test.ts checks that both give one refusal.
      const refused = await s.response(s.request("readTrust", {}, { repositoryId: w.repositoryId }));
      expect(refused).toMatchObject({
        state: "failed",
        code: "UNSUPPORTED_REPOSITORY",
        result: { remedy: { text: `The Git path ${git} in ${host.distro} holds a name that Windows cannot show. Install Git in another folder of the distro, then approve again.` } },
      });
      // No native confirmation ran, so no record and no session approval exist.
      expect(runner.trustStore.persists).toEqual([]);
      expect(runner.trustStore.records).toEqual([]);
      expect(listScopes(host)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a later read whose selected Git has another UNC form gives TRUST_CHANGED",
    NEEDS,
    async (host) => {
      const { runner, s } = setup(host);
      const config = filterConfig(host);
      const repo = seamRepository(host, runner, { config });
      expect(await approve(s, await register(s, repo))).toMatchObject({ state: "succeeded", result: { persistence: "stored" } });
      // The same Git file at another path: a new confirmation, and a new installation of the distro.
      seamRepository(host, runner, { config, probe: { git: "/usr/local/bin/git" } });
      const w = await register(s, repo);
      const read = await s.response(s.request("readWorkspace", { refresh: false, check: "full" }, { repositoryId: w.repositoryId }));
      expect(read).toMatchObject({ code: "TRUST_CHANGED" });
      expect(runner.wslConfirmations).toHaveLength(2);
      expect(listScopes(host)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});

// gaps.md "Service consequences" and W5: a WSL workspace lists with the POSIX rules on the Linux paths of its distro.
// A stub runner answers the two listing processes, `fileFacts`, and `identity`, so these cases need no distro.
describe("WSL trust listing rules (T212 decisions W3 to W5)", () => {
  const DISTRO = "Ubuntu-24.04";
  const GUID = "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}";
  const unc = (linux: string) => ["\\\\wsl.localhost", DISTRO, ...linux.split("/").filter((s) => s !== "")].join("\\");
  const id = (inode: string) => ({ distroGuid: GUID, fileSystemId: "fedc9aa3bd65bc57", inode });
  const workspace = (pathEnv: string) =>
    ({
      repositoryId: crypto.randomUUID(),
      gitInstallationId: crypto.randomUUID(),
      worktreeRoot: unc("/home/u/r"),
      gitDirectory: unc("/home/u/r/.git"),
      commonDirectory: unc("/home/u/r/.git"),
      worktreeIdentity: [id("100"), id("101")],
      commonIdentity: id("101"),
      wsl: { gitInstallationId: crypto.randomUUID(), distro: DISTRO, guid: GUID, path: "/usr/bin/git", version: "2.55.0", identity: "fedc9aa3bd65bc57:7:1:1", pathEnv },
    }) as unknown as Workspace;
  const file = (execute: boolean): FileFact => ({ kind: "file", size: 1, lastWrite: "0", executable: execute, ownerExecute: execute });
  const link = (component: number, target: string): FileFact => ({ kind: "link", component, tag: "symlink", target, relative: !target.startsWith("/") });

  // `facts` maps `<root>:<components joined by />` to the phase-1 fact. Each other entry is absent.
  function stub(config: string, facts: Record<string, FileFact>, identity: (path: string) => unknown = () => ({ code: "UNSUPPORTED_REPOSITORY", reason: "absent" })) {
    const requests: FileFactsRequest[] = [];
    const identityPaths: string[] = [];
    const runner = {
      async run(call: { arguments: readonly string[]; stdout: { push(b: Uint8Array): void } }) {
        call.stdout.push(new TextEncoder().encode(call.arguments.join(" ") === configListArgs().join(" ") ? config : ".git/hooks\n"));
        return { exitCode: 0, activeDescendants: 0 };
      },
      async fileFacts(request: FileFactsRequest) {
        requests.push(request);
        return request.files.map(({ root, path }) => {
          const fact = facts[`${root}:${path.join("/")}`] ?? { kind: "absent" };
          return request.digest && fact.kind === "file" ? { kind: "file", size: 1, lastWrite: "0", digest: "a".repeat(64) } : fact;
        });
      },
      async identities(_operationId: string, _context: unknown, paths: readonly string[]) {
        identityPaths.push(...paths);
        return paths.map(identity);
      },
    } as unknown as GitRunner;
    const entries = () => requests.flatMap((r) => r.files.map((f) => `${r.digest ? "digest " : ""}${f.root}:${f.path.join("/")}`));
    return { runner, entries, identityPaths };
  }
  const list = (runner: GitRunner, w: Workspace): Promise<ListingOutcome> =>
    createTrust({ runner, environment: { PATH: "C:\\Windows", HOME: "C:\\Users\\u" } }).listTrust({ operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace: w });

  test("an absolute Linux link target maps below its root, letter case counts, and a hook needs the X_OK result", async () => {
    const { runner, entries } = stub("", {
      "gitDirectory:hooks": { kind: "directory" },
      "gitDirectory:hooks/pre-commit": link(2, "/home/u/r/scripts/pre-commit"),
      "worktreeRoot:scripts/pre-commit": file(true),
      "gitDirectory:hooks/commit-msg": file(false),
      "gitDirectory:hooks/pre-push": link(2, "/home/u/R/scripts/pre-push"),
    });
    const outcome = await list(runner, workspace("/usr/bin"));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    const { listing } = outcome;
    // Linux Git adds no suffix, and the folder path is the Linux path that Git printed, resolved against the worktree root.
    expect(listing.hooksDirectory).toBe("/home/u/r/.git/hooks");
    expect(entries().filter((e) => e.endsWith(".exe"))).toEqual([]);
    expect(entries()).toContain("worktreeRoot:scripts/pre-commit");
    expect(entries()).toContain("digest worktreeRoot:scripts/pre-commit");
    // `/home/u/R` is another folder on Linux, so the target lies outside every root and gets no entry.
    expect(entries().some((e) => e.includes("pre-push") && !e.startsWith("gitDirectory:hooks/"))).toBe(false);
    // hook.c `find_hook`: POSIX Git lists an entry only after `access(X_OK)`.
    expect(listing.hooks.folder.map((h) => [h.event, h.path])).toEqual([
      ["pre-commit", "/home/u/r/.git/hooks/pre-commit"],
      ["pre-push", "/home/u/r/.git/hooks/pre-push"],
    ]);
  });

  test("a bare-name program takes the first Linux PATH candidate with the owner execute bit", async () => {
    const { runner, entries } = stub("local\0file:.git/config\0filter.x.clean\ntool\0", {
      "worktreeRoot:bin/tool": file(false),
      "worktreeRoot:other/tool": file(true),
    });
    const outcome = await list(runner, workspace("bin:other:/usr/bin"));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome.listing.approvalRequired.reads).toBe(true);
    // run-command.c `locate_in_PATH` skips a file without `S_IXUSR`, so only the second candidate is digested.
    expect(entries().filter((e) => e.startsWith("digest "))).toEqual(["digest worktreeRoot:other/tool"]);
  });

  test("a protected Linux program path outside the roots gets identity requests in the UNC form, and a name without that form fails the listing", async () => {
    let inode = 200;
    const { runner, identityPaths } = stub("global\0file:/home/u/.gitconfig\0gpg.program\n/opt/gpg/bin/gpg\0", {}, () => id(String(inode++)));
    const outcome = await list(runner, workspace("/usr/bin"));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome.listing.integrations.map((i) => [i.key, i.repositoryControlled])).toEqual([["gpg.program", false]]);
    expect(identityPaths).toContain(unc("/opt/gpg/bin/gpg"));
    expect(identityPaths).toContain(unc("/home/u/.gitconfig"));
    expect(identityPaths.every((path) => path.startsWith(unc("/")))).toBe(true);

    const unmapped = stub("global\0file:/home/u/.gitconfig\0gpg.program\n/opt/a:b/gpg\0", {}, () => id(String(inode++)));
    expect(await list(unmapped.runner, workspace("/usr/bin"))).toEqual({ ok: false, code: "REPOSITORY_UNAVAILABLE" });
  });

  // T212 decision W10: WSL roots lie on ext4 (contract §11), so a path on another file system cannot alias a root.
  test("a protected program on drvfs or tmpfs stays outside as a location only, and another identity error still fails the listing", async () => {
    let inode = 300;
    const reason = (path: string) => (path.startsWith(unc("/mnt/c")) ? "mixed-location" : path.startsWith(unc("/tmp")) ? "no-fs-uuid" : null);
    const identity = (path: string) => {
      const found = reason(path);
      return found === null ? id(String(inode++)) : { code: "UNSUPPORTED_REPOSITORY", reason: found };
    };
    const config = "global\0file:/home/u/.gitconfig\0gpg.program\n/mnt/c/Program Files/GnuPG/bin/gpg.exe\0global\0file:/home/u/.gitconfig\0diff.external\n/tmp/tools/difftool\0";
    const { runner, entries, identityPaths } = stub(config, {}, identity);
    const outcome = await list(runner, workspace("/usr/bin"));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect(outcome.listing.integrations.map((i) => [i.key, i.repositoryControlled])).toEqual([
      ["gpg.program", false],
      ["diff.external", false],
    ]);
    expect(outcome.listing.approvalRequired).toEqual({ reads: false, commit: false, sync: false, workbench: false });
    expect(identityPaths).toContain(unc("/mnt/c/Program Files/GnuPG/bin/gpg.exe"));
    expect(identityPaths).toContain(unc("/tmp/tools/difftool"));
    // A location only: no `fileFacts` entry names either program.
    expect(entries().filter((e) => e.includes("gpg") || e.includes("difftool"))).toEqual([]);

    const failed = stub(config, {}, (path) => (reason(path) === null ? id(String(inode++)) : { code: "UNSUPPORTED_REPOSITORY" }));
    expect(await list(failed.runner, workspace("/usr/bin"))).toEqual({ ok: false, code: "REPOSITORY_UNAVAILABLE" });
  });

  // A Windows workspace in the same stub. The Windows path rules apply only on a Windows service.
  const windows = () =>
    ({
      repositoryId: crypto.randomUUID(),
      gitInstallationId: crypto.randomUUID(),
      worktreeRoot: "C:\\r",
      gitDirectory: "C:\\r\\.git",
      commonDirectory: "C:\\r\\.git",
      worktreeIdentity: [FILE_ID("1"), FILE_ID("2")],
      commonIdentity: FILE_ID("2"),
    }) as unknown as Workspace;
  const FILE_ID = (n: string) => ({ volumeSerial: "0123456789abcdef", fileId: n.repeat(32) });
  const GLOBAL_GPG = "global\0file:C:/Users/u/.gitconfig\0gpg.program\nC:/gpg/gpg.exe\0";

  // T212 review V4: W10 is a WSL rule. A Windows listing keeps the old outcome for both reasons.
  test.skipIf(!isWindows)("in a Windows listing, mixed-location and no-fs-uuid replies still fail the listing", async () => {
    for (const reason of ["mixed-location", "no-fs-uuid"]) {
      const { runner } = stub(GLOBAL_GPG, {}, () => ({ code: "UNSUPPORTED_REPOSITORY", reason }));
      expect({ reason, outcome: await list(runner, windows()) }).toEqual({ reason, outcome: { ok: false, code: "REPOSITORY_UNAVAILABLE" } });
    }
  });

  // T212 review V1: an identity of another form, or of another distro, can never match a root, so the reply is malformed.
  test.skipIf(!isWindows)("an identity reply of another form or another distro GUID gives PROCESS_OWNERSHIP_FAILED", async () => {
    let n = 3;
    const wslReply = stub(GLOBAL_GPG, {}, () => id(String(n++)));
    expect(await list(wslReply.runner, windows())).toEqual({ ok: false, code: "PROCESS_OWNERSHIP_FAILED" });
    const config = "global\0file:/home/u/.gitconfig\0gpg.program\n/opt/gpg/bin/gpg\0";
    const windowsReply = stub(config, {}, () => FILE_ID(String(n++ % 10)));
    expect(await list(windowsReply.runner, workspace("/usr/bin"))).toEqual({ ok: false, code: "PROCESS_OWNERSHIP_FAILED" });
    const otherDistro = stub(config, {}, () => ({ ...id(String(n++)), distroGuid: "{8f51b15e-5f05-4b6d-8d78-5765530f558a}" }));
    expect(await list(otherDistro.runner, workspace("/usr/bin"))).toEqual({ ok: false, code: "PROCESS_OWNERSHIP_FAILED" });
    // The control: identities of the workspace form and GUID give a listing.
    const same = stub(config, {}, () => id(String(n++)));
    expect(await list(same.runner, workspace("/usr/bin"))).toMatchObject({ ok: true });
  });
});
