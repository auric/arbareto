// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T208: WSL reads through the public operations (contract §3, §11). Every case needs Git 2.55.0 in the distro.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { OPERATION_MARKERS } from "../../src/git-service/commands";
import { buildF21, buildF25, buildF26, distroGit, globalConfig, seamRepository, startSession, writeLinux, type WslSession } from "./fixtures";
import { inDistro, uncPath, useWslFolder, WSL_EXE, wslHost, wslTest, type WslCapability, type WslHost } from "./wsl-host";

const CASE_TIMEOUT_MS = 180_000;
const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"];
// The service environment of the T208 environment case. WSL forwards only the names that `WSLENV` holds (research R13 P4).
const CANARY_ENV = { WSLENV: "GIT_TRACE/u:GIT_ARBARETO_CANARY/u", GIT_TRACE: "1", GIT_ARBARETO_CANARY: "1", GIT_DIR: "C:\\arbareto-canary-git-dir" };

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
// Each dispose ends the WSL scopes of the runner through `wsl.exe`, so the hook takes the case bound.
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
}, CASE_TIMEOUT_MS);

function setup(host: WslHost, environment = serviceEnv()): { runner: BunRunner; s: WslSession } {
  const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment, wslGlobalConfig: globalConfig(host) });
  runners.push(runner);
  return { runner, s: startSession(runner) };
}

interface Workspace {
  repositoryId: string;
  generation: number;
}

async function register(s: WslSession, path: string): Promise<Workspace> {
  const response = await s.response(s.chooseRepository(path));
  expect(response).toMatchObject({ state: "succeeded" });
  return response.result as unknown as Workspace;
}

async function read(s: WslSession, w: Workspace, operation: string, payload: object = {}, generation = false) {
  const extra = { repositoryId: w.repositoryId, ...(generation ? { repositoryGeneration: w.generation } : {}) };
  return s.response(s.request(operation, payload, extra));
}

// Contract §3 `readComparison`: the envelope carries `repositoryId`, `repositoryGeneration`, and `selectionId`.
async function compareEntry(s: WslSession, w: Workspace, snapshot: { snapshotId: string; generation: number }, entryId: string) {
  return s.response(s.request("readComparison", { snapshotId: snapshot.snapshotId, entryId }, { repositoryId: w.repositoryId, repositoryGeneration: snapshot.generation, selectionId: crypto.randomUUID() }));
}

async function approve(s: WslSession, w: Workspace): Promise<void> {
  const trust = await read(s, w, "readTrust");
  const fingerprint = (trust.result as { fingerprint: string }).fingerprint;
  expect(await read(s, w, "approveTrust", { fingerprint, approve: true }, true)).toMatchObject({ state: "succeeded" });
}

const sortedLines = (text: string) => text.split("\n").filter((l) => l !== "").sort();

describe("WSL reads (T208)", () => {
  wslTest(
    "F21 status, history, and the trust listing equal the distro Git's own output",
    NEEDS,
    async (host) => {
      const f21 = buildF21(host);
      const { s } = setup(host);
      const w = await register(s, f21.paths[1]!);
      const status = await read(s, w, "readWorkspace", { refresh: false, check: "full" });
      expect(status).toMatchObject({ state: "succeeded" });
      // T339 (a) and (c): the location names the listed distro and the approved distro Git of the confirmation.
      expect(status.result?.location).toEqual({ kind: "wsl", distro: host.distro, git: { path: host.probe.paths.git, version: host.gitVersion } });
      const text = JSON.stringify(status.result);
      const own = distroGit(f21.repo, ["status", "--porcelain=v2", "--untracked-files=all"]);
      for (const line of sortedLines(own)) expect(text).toContain(line.split(" ").at(-1)!);
      const history = await read(s, w, "readHistory", {}, true);
      expect(history).toMatchObject({ state: "succeeded" });
      for (const oid of sortedLines(distroGit(f21.repo, ["rev-list", "HEAD"]))) expect(JSON.stringify(history.result)).toContain(oid);
      const trust = await read(s, w, "readTrust");
      const keys = sortedLines(distroGit(f21.repo, ["config", "--list", "--name-only", "--show-scope"])).map((l) => l.split("\t").at(-1)!);
      for (const key of keys) expect(JSON.stringify(trust.result)).toContain(key);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "F21 comparisons equal the distro Git's own diff hunks",
    NEEDS,
    async (host) => {
      const f21 = buildF21(host);
      const { s } = setup(host);
      const w = await register(s, f21.paths[1]!);
      const status = await read(s, w, "readWorkspace", { refresh: false, check: "full" });
      const result = status.result as { entries: { entryId: string; path: string; category: string }[]; snapshotId: string; generation: number };
      // `git diff` compares the index with the working tree, so the unstaged entry is the one to compare.
      const entry = result.entries.find((e) => e.path === "multi.txt" && e.category === "unstaged");
      const comparison = await compareEntry(s, w, result, entry!.entryId);
      expect(comparison).toMatchObject({ state: "succeeded" });
      const hunks = sortedLines(distroGit(f21.repo, ["diff", "--no-ext-diff", "--no-textconv", "--", "multi.txt"])).filter((l) => l.startsWith("@@"));
      expect((comparison.result as { hunks: unknown[] }).hunks).toHaveLength(hunks.length);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "program-file digests come from the WSL fileFacts probe, and an edit gives TRUST_CHANGED",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      const { s } = setup(host);
      const w = await register(s, uncPath(host, f25.filter.dir));
      expect(await read(s, w, "readWorkspace", { refresh: false, check: "full" })).toMatchObject({ code: "TRUST_REQUIRED" });
      await approve(s, w);
      expect(await read(s, w, "readWorkspace", { refresh: false, check: "full" })).toMatchObject({ state: "succeeded" });
      writeLinux(host, `${f25.filter.dir}/clean.sh`, "#!/bin/sh\nexec cat\n", "755");
      expect(await read(s, w, "readWorkspace", { refresh: false, check: "full" })).toMatchObject({ code: "TRUST_CHANGED" });
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "the bare-name candidates of absolute Linux PATH entries stay locations, so no fileFacts request names them",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      distroGit(f25.filter, ["config", "filter.canary.clean", "arbareto-bare-canary"]);
      expect((host.probe.pathEnv ?? "").split(":").every((e) => e.startsWith("/"))).toBe(true);
      const { runner, s } = setup(host);
      const w = await register(s, uncPath(host, f25.filter.dir));
      expect(await read(s, w, "readTrust")).toMatchObject({ state: "succeeded" });
      // Contract §7 and §11: a candidate outside the repository roots stays a location only. tests/wsl/trust.test.ts covers a relative PATH entry.
      const calls = runner.fileFactCalls.filter((c) => c.repositoryId === w.repositoryId);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.flatMap((c) => c.files.map((f) => f.path.join("/"))).filter((p) => p.includes("arbareto-bare-canary"))).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "no Windows variable of the service environment reaches Linux Git, also one that WSLENV names",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      const log = `${f25.filter.dir}/../filter-env.log`;
      writeLinux(host, `${f25.filter.dir}/clean.sh`, `#!/bin/sh\nenv > '${log}'\nexec cat\n`, "755");
      const { s } = setup(host, serviceEnv(CANARY_ENV));
      const w = await register(s, uncPath(host, f25.filter.dir));
      await approve(s, w);
      expect(await read(s, w, "readWorkspace", { refresh: true, check: "full" })).toMatchObject({ state: "succeeded" });
      const env = inDistro(host.distro, ["/usr/bin/cat", "--", log]);
      console.log(`OBSERVATION T208: filter environment names ${sortedLines(env).map((l) => l.split("=")[0]).join(" ")}`);
      expect(env).not.toMatch(/^GIT_TRACE=/m);
      expect(env).not.toMatch(/^GIT_ARBARETO_CANARY=/m);
      expect(env).not.toContain(CANARY_ENV.GIT_DIR);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "an entry with \\ in its Linux name gets reason path",
    NEEDS,
    async (host) => {
      if (GIT === null) throw new Error("F26 needs the Windows Git");
      const f26 = buildF26(host, GIT);
      const { s } = setup(host);
      const w = await register(s, f26.entries.path);
      const status = await read(s, w, "readWorkspace", { refresh: false, check: "full" });
      const result = status.result as { entries: { entryId: string; path: string }[]; snapshotId: string; generation: number };
      const entry = result.entries.find((e) => e.path === f26.entries.entry);
      expect(entry).toBeDefined();
      const comparison = await compareEntry(s, w, result, entry!.entryId);
      // T093 names the decisions `support` and `fileAction`.
      expect(comparison.result).toMatchObject({ support: "path", fileAction: "path" });
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a filtered unstaged entry carries the contract §11 add remedy, and each value doubles its quote characters",
    NEEDS,
    async (host) => {
      // A `filter` attribute without a driver gives reason `filter`. The folder and the file name hold all five quote characters of contract §4.
      const dir = `${host.folder}/t105-remedy-${crypto.randomUUID().slice(0, 8)} q'‘/repo`;
      const name = "f'’‚‛.txt";
      inDistro(host.distro, ["/usr/bin/mkdir", "-p", "--", dir]);
      const r = { host, dir };
      distroGit(r, ["init", "-q", "-b", "main"]);
      writeLinux(host, `${dir}/.gitattributes`, "*.txt filter=t105\n");
      writeLinux(host, `${dir}/${name}`, "one\n");
      distroGit(r, ["--literal-pathspecs", "add", "--", ".gitattributes", name]);
      distroGit(r, ["-c", "user.name=T105", "-c", "user.email=t105@example.invalid", "commit", "-q", "--no-verify", "-m", "base"]);
      writeLinux(host, `${dir}/${name}`, "two\n");
      const { s } = setup(host);
      const w = await register(s, uncPath(host, dir));
      const status = await read(s, w, "readWorkspace", { refresh: false, check: "full" });
      const result = status.result as { entries: { entryId: string; path: string; category: string }[]; snapshotId: string; generation: number };
      const entry = result.entries.find((e) => e.path === name && e.category === "unstaged");
      expect(entry).toBeDefined();
      const comparison = await compareEntry(s, w, result, entry!.entryId);
      expect(comparison).toMatchObject({ state: "succeeded" });
      // Contract §4 "Quoting rule": each of U+0027 and U+2018 to U+201B is doubled inside single quotes.
      const q = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
      const command = `& ${q(WSL_EXE)} --distribution ${q(host.distro)} --cd / --exec ${q(host.probe.paths.git!)} --literal-pathspecs -C ${q(dir)} add -- ${q(name)}`;
      const text = "This command stages or unstages the whole file with your Git settings. Run it in a terminal.";
      expect(comparison.result).toMatchObject({ fileAction: "filter", remedy: { text, command } });
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "the candidate of a read never exists, and no watcher starts for a WSL workspace",
    NEEDS,
    async (host) => {
      const f21 = buildF21(host);
      const watch = spyOn(fs, "watch");
      try {
        const { s } = setup(host);
        const w = await register(s, f21.paths[0]!);
        await read(s, w, "readWorkspace", { refresh: true, check: "full" });
        await read(s, w, "readHistory", {}, true);
        const gitDir = distroGit(f21.repo, ["rev-parse", "--absolute-git-dir"]).trim();
        const names = inDistro(host.distro, ["/usr/bin/ls", "-A", "--", gitDir]);
        expect(names).not.toContain("arbareto-candidate-");
        expect(watch).not.toHaveBeenCalled();
      } finally {
        watch.mockRestore();
      }
    },
    CASE_TIMEOUT_MS,
  );
});


// T212 review: a seam read whose Git output is fixed, so it needs no Git 2.55.0. Only the trust listing `fileFacts` probe runs in the distro.
describe("WSL read seams (T212)", () => {
  wslTest(
    "a clean WSL repository reads operation state normal from its Linux marker paths, and the read resolves no change-tuple ref file",
    ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "perl"],
    async (host) => {
      const { runner, s } = setup(host);
      const repo = seamRepository(host, runner);
      const registration = runner.inject.stdout!;
      // Linux Git prints Linux paths for `rev-parse --path-format=absolute --git-path`.
      const reads: [string, string][] = [
        ["--git-path MERGE_HEAD", OPERATION_MARKERS.map((name) => `${repo.linux}/.git/${name}`).join("\n") + "\n"],
        ["--git-path refs/", `${repo.linux}/.git/refs/heads/main\n`],
        ["status --porcelain=v2", `# branch.oid ${"1".repeat(40)}\0# branch.head main\0`],
        ["ls-files", ""],
      ];
      runner.inject.stdout = (call) => {
        const text = call.arguments.join(" ");
        const found = reads.find(([marker]) => text.includes(marker));
        return found ? new TextEncoder().encode(found[1]) : registration(call);
      };
      const w = await register(s, repo.path);
      const response = await read(s, w, "readWorkspace", { refresh: false, check: "full" });
      expect(response).toMatchObject({ state: "succeeded", result: { operationState: "normal" } });
      // Contract §11 "Change polling": a WSL read uses no stat tuple, so it resolves no ref file for one.
      expect(runner.calls.filter((call) => call.arguments.join(" ").includes("--git-path refs/"))).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});
