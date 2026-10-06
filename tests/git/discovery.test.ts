// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { COMMIT_OUTPUT_TAIL_BYTES } from "../../src/contracts/limits";
import { buildSubmoduleOutputTail } from "../../src/contracts/submodules";
import * as discoveryModule from "../../src/git-service/discovery";
import { discoverRepository, type DiscoveryResult } from "../../src/git-service/discovery";
import type { GitInstallation } from "../../src/git-service/git-installation";
import { createCollector, RunnerRefusal, type GitExit, type GitRunner, type IdentityReply, type RefusedCode } from "../../src/git-service/git-runner";
import { createRegistrations, type RegistrationOutcome } from "../../src/git-service/registration";
import { printOrigin } from "../origin";
import { createBunRunner, type BunRunner } from "./bun-runner";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, realGlobalConfigDigests, removeTree, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF01, buildF07, buildF08, buildF10, buildF15, buildF17, F15_MARKER, POWERSHELL_QUOTES, put, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import { sha256 } from "./git-oracle";
import { caseTest, openService, type Refusal, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";

printOrigin("../../src/git-service/discovery.ts", import.meta.dir);
printOrigin("../../src/git-service/registration.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);
printOrigin("../../src/contracts/submodules.ts", import.meta.dir);

const TASK = "T068";
const MERGED = "T308";
const TIMEOUT_MS = 120_000;
const STREAM_BYTES = 64 * 1024;

// Research R2: the first discovery query. Contract §6: discovery runs under the fixed C locale.
const FIRST_QUERY = ["--no-lazy-fetch", "rev-parse", "--is-bare-repository", "--is-inside-git-dir"];
// Git `t/README`: this knob makes the ownership check fail for every repository.
const OTHER_OWNER = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };

// Data-model §2 and contract §6 remedy texts.
const REMEDY = {
  bare: "Open a worktree of it, or clone it",
  administrationFolder: "Open the working folder that contains it",
  unavailable: "Run `git status` in this folder",
  fileId: "Open the repository from an NTFS or ReFS volume",
};

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const slash = (path: string) => path.replaceAll("\\", "/");
const encode = (value: string) => new TextEncoder().encode(value);
// Contract §9 "Commit failure output" with the §12 "Output tail" change. No byte was dropped before the buffer.
const outputTail = (stderr: Uint8Array) => buildSubmoduleOutputTail(stderr, false);

function probeDiscovery(git: string, directory: string, extra: Record<string, string> = {}): { exitCode: number; stderr: Uint8Array } {
  const proc = Bun.spawnSync([git, ...FIRST_QUERY], { cwd: directory, env: fixtureEnv({ LC_ALL: "C", ...extra }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stderr: new Uint8Array(proc.stderr) };
}

// `buildF15` makes the hostile folders only on Windows. Off Windows, this makes the same names in the F15 folder.
function hostileRepositories(git: string, built: Built): string[] {
  const names = built.facts.notes.hostile as string[];
  if (names.length > 0) return names.map((name) => join(built.root, "hostile", name));
  return POWERSHELL_QUOTES.map((q) => {
    const dir = fixtureDir(relative(FIXTURE_ROOT, join(built.root, "hostile", `x${q}$(ni ${F15_MARKER})${q}`)));
    ownedGit(git, FIXTURE_ROOT, dir, ["init", "-q"]);
    return dir;
  });
}

const markers = () => (readdirSync(FIXTURE_ROOT, { recursive: true }) as string[]).filter((p) => basename(p) === F15_MARKER);

// Contract §6 "Registration bootstrap": the merged refusal of discovery call 1. `path` is compared only when the caller knows the selected folder.
function expectMerged(label: string, refusal: { code?: string; path?: string; remedy?: { text?: string; command?: string | null }; outputTail?: unknown } | undefined, stderr: Uint8Array, path?: string): void {
  const seen = { label, code: refusal?.code, text: refusal?.remedy?.text, command: refusal?.remedy?.command ?? null, outputTail: refusal?.outputTail };
  const expected = { label, code: "REPOSITORY_UNAVAILABLE", text: REMEDY.unavailable, command: null, outputTail: outputTail(stderr) };
  if (path === undefined) return void expect(seen).toEqual(expected);
  expect({ ...seen, path: refusal?.path }).toEqual({ ...expected, path });
}

type Wrap = (runner: BunRunner) => GitRunner;
const isFirstQuery = (call: { arguments: readonly string[] }) => call.arguments.join(" ") === FIRST_QUERY.join(" ");

// Discovery call 1 runs in the double with own collectors. `replace` then gives the stderr bytes and the exit status of that call.
// The stdout of the double reaches the call only when the exit status stays.
function replaceFirst(replace: (exit: GitExit, stderr: Uint8Array) => { exitCode: number | null; stderr: Uint8Array }): Wrap {
  return (r) => ({
    ...r,
    run: async (call) => {
      if (!isFirstQuery(call)) return r.run(call);
      const stdout = createCollector({ maxBytes: STREAM_BYTES });
      const stderr = createCollector({ maxBytes: STREAM_BYTES });
      const exit = await r.run({ ...call, stdout, stderr });
      const out = replace(exit, stderr.take());
      if (out.exitCode === exit.exitCode) call.stdout.push(stdout.take());
      call.stderr.push(out.stderr);
      return { ...exit, exitCode: out.exitCode };
    },
  });
}

// Keeps the reply of discovery call 1 and records its stderr bytes.
const recordFirst = (seen: Uint8Array[]): Wrap => replaceFirst((exit, stderr) => (seen.push(stderr), { exitCode: exit.exitCode, stderr }));

// The probe policy removes `GIT_TEST_*` (`src/contracts/git-environment.json`), so the knob never reaches Git through the double or the service environment seam.
// Discovery call 1 still runs in the double. Its stderr bytes and exit status come from the same query with the knob in the same folder.
const ownerKnob = (git: string, directory: string, seen: Uint8Array[]): Wrap =>
  replaceFirst(() => {
    const knob = probeDiscovery(git, directory, OTHER_OWNER);
    seen.push(knob.stderr);
    return knob;
  });

interface Double {
  discover(directory: string, wrap?: Wrap): Promise<DiscoveryResult>;
  register(directory: string, wrap?: Wrap): Promise<RegistrationOutcome>;
}

// Direct discovery and registration through wrappers of one shell double. Discovery knows the selected folder, and registration does not (contract §3).
async function withDouble(name: string, body: (double: Double) => Promise<void>): Promise<void> {
  const git = gitPath();
  const runner = createBunRunner({ git, directory: fixtureDir(`${name}-runner`), environment: serviceEnv() });
  try {
    const gitInstallationId = crypto.randomUUID();
    const probe = runner.addContext("gitProbe", git);
    expect(await runner.register({ operationId: crypto.randomUUID(), bootstrapId: probe, gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false })).toEqual({ result: "approved" });
    const installation: GitInstallation = {
      gitInstallationId,
      selectedPath: git,
      executablePath: git,
      version: "2.55.0",
      admission: "admitted",
      executableIdentity: { file: { volumeSerial: "0".repeat(16), fileId: "0".repeat(31) + "1" }, versionOutput: "2.55.0", digest: "c".repeat(64) },
    };
    const wrapped = (wrap?: Wrap): GitRunner => (wrap ? wrap(runner) : runner);
    await body({
      discover: (directory, wrap) =>
        discoverRepository(wrapped(wrap), { operationId: crypto.randomUUID(), bootstrapId: runner.addContext("repositoryDiscovery", directory), gitInstallationId, directory, gitSelectedPath: git }),
      register: (directory, wrap) =>
        createRegistrations({ runner: wrapped(wrap), unfinishedMutation: () => false }).register({
          operationId: crypto.randomUUID(),
          bootstrapId: runner.addContext("repositoryDiscovery", directory),
          installation,
          signal: new AbortController().signal,
        }),
    });
  } finally {
    await runner.dispose();
  }
}

const refusalOf = (result: DiscoveryResult) => (result.ok ? undefined : (result.refusal as Parameters<typeof expectMerged>[1]));
const outcomeRefusal = (outcome: RegistrationOutcome) => (outcome.ok ? undefined : { code: outcome.code, ...(outcome.result as object | undefined) });

describe("merged discovery refusal through the shell double (contract §6 \"Registration bootstrap\", plan.md F15)", () => {
  caseTest(
    MERGED,
    "F15 with GIT_TEST_ASSUME_DIFFERENT_OWNER=1: Git's ownership refusal gives REPOSITORY_UNAVAILABLE with the selected folder, the remedy text, Git's message in outputTail, and no command",
    ["shell-double"],
    () =>
      withDouble("t308-owner", async (double) => {
        const git = gitPath();
        const repo = join(buildF15(git, "t308-owner").root, "repo");
        const seen: Uint8Array[] = [];
        const refusal = refusalOf(await double.discover(repo, ownerKnob(git, repo, seen)));
        expect({ calls: seen.length, exitCode: probeDiscovery(git, repo, OTHER_OWNER).exitCode, bytes: seen[0]!.length > 0 }).toEqual({ calls: 1, exitCode: 128, bytes: true });
        expectMerged("owner", refusal, seen[0]!, repo);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    MERGED,
    "each of the eight F15 hostile names gives the merged refusal with the selected folder and Git's message as plain text, and no marker appears",
    ["shell-double"],
    () =>
      withDouble("t308-hostile", async (double) => {
        const git = gitPath();
        const repos = hostileRepositories(git, buildF15(git, "t308-hostile"));
        expect(repos.length).toBe(POWERSHELL_QUOTES.length);
        for (const repo of repos) {
          const seen: Uint8Array[] = [];
          const refusal = refusalOf(await double.discover(repo, ownerKnob(git, repo, seen)));
          expect({ repo, calls: seen.length }).toEqual({ repo, calls: 1 });
          expectMerged(repo, refusal, seen[0]!, repo);
        }
        expect(markers()).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    MERGED,
    "F15: a plain folder gives the merged refusal with Git's message in outputTail",
    ["shell-double", "no-enclosing-repository"],
    () =>
      withDouble("t308-plain", async (double) => {
        const plain = join(buildF15(gitPath(), "t308-plain").root, "plain");
        const seen: Uint8Array[] = [];
        const refusal = refusalOf(await double.discover(plain, recordFirst(seen)));
        expect({ calls: seen.length, bytes: seen[0]!.length > 0 }).toEqual({ calls: 1, bytes: true });
        expectMerged("plain", refusal, seen[0]!, plain);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    MERGED,
    "F07: a .git file with a missing target gives the merged refusal with Git's message in outputTail",
    ["shell-double"],
    () =>
      withDouble("t308-broken", async (double) => {
        const built = buildF07(gitPath(), "t308-broken");
        const broken = join(built.root, (built.facts.notes.unopenable as { missingGitdir: string }).missingGitdir);
        const seen: Uint8Array[] = [];
        const refusal = refusalOf(await double.discover(broken, recordFirst(seen)));
        expect({ calls: seen.length, bytes: seen[0]!.length > 0 }).toEqual({ calls: 1, bytes: true });
        expectMerged("broken", refusal, seen[0]!, broken);
      }),
    TIMEOUT_MS,
  );

  // The service reads no stderr text for this decision, so any bytes keep the code. A localized Git prints another ownership line.
  const OTHER_STDERR: [string, Uint8Array][] = [
    ["other text", encode("error: other bytes\n")],
    ["a localized ownership line", encode("fatal: zweifelhafter Besitz im Repository unter '/x'\n")],
    ["the C-locale not-a-repository line", encode("fatal: not a git repository (or any of the parent directories): .git\n")],
    ["bytes that are not UTF-8", new Uint8Array([0x66, 0xff, 0xfe, 0x0a])],
  ];
  caseTest(
    MERGED,
    "other stderr bytes in place of Git's message keep REPOSITORY_UNAVAILABLE for the owner, plain-folder, and broken-gitfile cases",
    ["shell-double", "no-enclosing-repository"],
    () =>
      withDouble("t308-other-stderr", async (double) => {
        const git = gitPath();
        const f15 = buildF15(git, "t308-other-stderr");
        const f07 = buildF07(git, "t308-other-stderr-f07");
        const folders: [string, string, boolean][] = [
          ["owner", join(f15.root, "repo"), true],
          ["plain", join(f15.root, "plain"), false],
          ["broken", join(f07.root, (f07.facts.notes.unopenable as { missingGitdir: string }).missingGitdir), false],
        ];
        for (const [folder, directory, knob] of folders) {
          for (const [label, bytes] of OTHER_STDERR) {
            const wrap = replaceFirst((exit) => ({ exitCode: knob ? probeDiscovery(git, directory, OTHER_OWNER).exitCode : exit.exitCode, stderr: bytes }));
            expectMerged(`${folder}: ${label}`, refusalOf(await double.discover(directory, wrap)), bytes, directory);
          }
        }
      }),
    TIMEOUT_MS,
  );

  // Contract §9 "Commit failure output": the tail keeps the last 16 KiB and drops their first partial line. A URL cut there never shows its user information.
  caseTest(
    MERGED,
    "call-1 stderr above 16 KiB gives the outputTail of its last 16 KiB without their first partial line, and no part of the user information of a URL across the cut remains",
    ["shell-double"],
    () =>
      withDouble("t308-long-stderr", async (double) => {
        const f07 = buildF07(gitPath(), "t308-long-stderr");
        const broken = join(f07.root, (f07.facts.notes.unopenable as { missingGitdir: string }).missingGitdir);
        const secret = "CANARYUSER:CANARYPASSWORD";
        const url = `fatal: remote https://${secret}@example.invalid/repo.git\n`;
        const last = "fatal: remote https://LASTUSER:LASTPASSWORD@example.invalid/x.git\n";
        // ASCII text, so each length is a byte count. The cut falls in the middle of the user information.
        const half = Math.floor(secret.length / 2);
        const cut = url.indexOf(secret) + half;
        const after = COMMIT_OUTPUT_TAIL_BYTES - (url.length - cut) - last.length;
        // The kept bytes hold fewer than 100 lines, so only the partial-line rule can remove the cut URL.
        const line = `${"y".repeat(199)}\n`;
        const rest = after % line.length;
        const stderr = encode(line.repeat(100) + url + line.repeat(Math.floor(after / line.length)) + (rest > 0 ? `${"z".repeat(rest - 1)}\n` : "") + last);
        const kept = stderr.subarray(stderr.length - COMMIT_OUTPUT_TAIL_BYTES);
        expect(new TextDecoder().decode(kept).startsWith(url.slice(cut))).toBe(true);
        const refusal = refusalOf(await double.discover(broken, replaceFirst((exit) => ({ exitCode: exit.exitCode, stderr }))));
        expect({ code: refusal?.code, path: refusal?.path, outputTail: refusal?.outputTail }).toEqual({ code: "REPOSITORY_UNAVAILABLE", path: broken, outputTail: buildSubmoduleOutputTail(kept, true) });
        expect(["CANARY", "PASSWORD", "USER:", secret.slice(half)].filter((canary) => String(refusal?.outputTail).includes(canary))).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    MERGED,
    "registration passes the outputTail of the merged refusal through, and the discovery module no longer exports the classifier or the dubious-ownership command",
    ["shell-double", "no-enclosing-repository"],
    () =>
      withDouble("t308-registration", async (double) => {
        const git = gitPath();
        const built = buildF15(git, "t308-registration");
        const plain: Uint8Array[] = [];
        expectMerged("plain", outcomeRefusal(await double.register(join(built.root, "plain"), recordFirst(plain))), plain[0]!);
        const owner: Uint8Array[] = [];
        const repo = join(built.root, "repo");
        expectMerged("owner", outcomeRefusal(await double.register(repo, ownerKnob(git, repo, owner))), owner[0]!);
        // T310 removes the T082 classification and the dubious-ownership command.
        expect(Object.keys(discoveryModule).filter((name) => ["classifyDiscoveryFailure", "safeDirectoryCommand"].includes(name))).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});

// Service cases. `bun-runner.ts` runs only on Windows.

async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

function expectRefusal(response: ServiceResponse<RegistrationResult | Refusal>, code: string, remedy: string): void {
  const result = response.result as Refusal | undefined;
  expect({ state: response.state === "succeeded" ? "succeeded" : "refused", code: response.code, text: result?.remedy?.text }).toEqual({ state: "refused", code, text: remedy });
}

// The Git-resolved paths of a worktree, from the oracle.
function gitPaths(git: string, dir: string) {
  const out = ownedGit(git, FIXTURE_ROOT, dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--git-path", "index"]);
  const [worktreeRoot, gitDirectory, commonDirectory, indexPath] = out.toString("utf8").trimEnd().split("\n").map(slash);
  return { worktreeRoot, gitDirectory, commonDirectory, indexPath };
}

// The identity reply that the service received for a Git-resolved path.
function identityReply(service: Service, path: string): unknown {
  for (const call of service.runner.identityCalls) {
    const at = call.paths.findIndex((p) => slash(p) === slash(path));
    if (at >= 0 && call.replies[at] !== undefined) return call.replies[at];
  }
  throw new Error(`no identity request for ${path}`);
}

const discoveryCalls = (service: Service) => service.runner.calls.filter((c) => c.contextKind === "repositoryDiscovery");

describe("F07 worktree identities (data-model §2, contract §3 \"Worktree key\")", () => {
  caseTest(
    TASK,
    "each linked worktree gets its own worktreeRoot, gitDirectory, indexPath, worktreeIdentity, and 64-hex worktreeKey, and all share one commonIdentity",
    ["shell-double"],
    () =>
      withService("t068-f07-identity", async (service) => {
        const git = gitPath();
        const built = buildF07(git, "t068-f07-identity");
        const names = ["main", "wt-a", "wt-b"];
        const seen: Record<"worktreeRoot" | "gitDirectory" | "commonDirectory" | "indexPath" | "key" | "worktreeIdentity" | "commonIdentity", string | undefined>[] = [];
        for (const name of names) {
          const dir = join(built.root, name);
          const registered = await service.register(dir);
          expect(registered.worktreeKey).toMatch(HEX64);
          const read = await service.readWorkspace(registered.repositoryId);
          expect(read.state).toBe("succeeded");
          const identity = read.result!.identity;
          const oracle = gitPaths(git, dir);
          const paths = { worktreeRoot: slash(identity.worktreeRoot), gitDirectory: slash(identity.gitDirectory), commonDirectory: slash(identity.commonDirectory), indexPath: slash(identity.indexPath) };
          expect({ name, paths }).toEqual({ name, paths: oracle });
          seen.push({
            ...paths,
            key: registered.worktreeKey,
            worktreeIdentity: JSON.stringify([identityReply(service, paths.worktreeRoot), identityReply(service, paths.gitDirectory)]),
            commonIdentity: JSON.stringify(identityReply(service, paths.commonDirectory)),
          });
        }
        for (const field of ["worktreeRoot", "gitDirectory", "indexPath", "key", "worktreeIdentity"] as const) {
          expect({ field, distinct: new Set(seen.map((s) => s[field])).size }).toEqual({ field, distinct: names.length });
        }
        for (const field of ["commonDirectory", "commonIdentity"] as const) {
          expect({ field, distinct: new Set(seen.map((s) => s[field])).size }).toEqual({ field, distinct: 1 });
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the worktreeKey stays equal after a new service session, and the repositoryId does not",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const built = buildF07(git, "t068-f07-restart");
      let service = await openService({ git, name: "t068-f07-restart" });
      try {
        const before: RegistrationResult[] = [];
        for (const name of ["main", "wt-a", "wt-b"]) before.push(await service.register(join(built.root, name)));
        service = await service.restart();
        const after: RegistrationResult[] = [];
        for (const name of ["main", "wt-a", "wt-b"]) after.push(await service.register(join(built.root, name)));
        expect(after.map((r) => r.worktreeKey)).toEqual(before.map((r) => r.worktreeKey));
        for (const [i, r] of after.entries()) expect(r.repositoryId).not.toBe(before[i]!.repositoryId);
      } finally {
        await service.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a junction alias gives the same identities, repositoryId, and worktreeKey",
    ["shell-double", "ntfs-junction"],
    () =>
      withService("t068-f07-junction", async (service) => {
        const git = gitPath();
        const built = buildF07(git, "t068-f07-junction");
        const aliases = built.facts.notes.junctions as Record<string, string> | undefined;
        expect(aliases).toBeDefined();
        for (const [alias, target] of Object.entries(aliases!)) {
          const real = await service.register(join(built.root, target));
          const realRead = await service.readWorkspace(real.repositoryId);
          const viaAlias = await service.register(join(built.root, alias));
          const aliasRead = await service.readWorkspace(viaAlias.repositoryId);
          expect({ alias, repositoryId: viaAlias.repositoryId, key: viaAlias.worktreeKey }).toEqual({ alias, repositoryId: real.repositoryId, key: real.worktreeKey });
          const identities = (read: typeof realRead) => {
            const id = read.result!.identity;
            return [id.worktreeRoot, id.gitDirectory, id.commonDirectory].map((p) => identityReply(service, p));
          };
          expect({ alias, identities: identities(aliasRead) }).toEqual({ alias, identities: identities(realRead) });
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a submodule checkout opened directly and a separate Git directory open normally",
    ["shell-double"],
    () =>
      withService("t068-f07-open", async (service) => {
        const git = gitPath();
        const built = buildF07(git, "t068-f07-open");
        for (const name of ["super/sub", "separate"]) {
          const dir = join(built.root, name);
          const registered = await service.register(dir);
          const read = await service.readWorkspace(registered.repositoryId);
          expect({ name, state: read.state }).toEqual({ name, state: "succeeded" });
          const identity = read.result!.identity;
          expect({ name, gitDirectory: slash(identity.gitDirectory), commonDirectory: slash(identity.commonDirectory) }).toEqual({
            name,
            gitDirectory: gitPaths(git, dir).gitDirectory,
            commonDirectory: gitPaths(git, dir).commonDirectory,
          });
        }
      }),
    TIMEOUT_MS,
  );
});

describe("Windows worktree key known answer (contract §3 \"Worktree key\")", () => {
  // The identity reply of the worktree root: volume serial 0x0123456789ABCDEF and the file ID bytes 00 11 22 ... FF in array order.
  const VOLUME_SERIAL = 0x0123456789abcdefn;
  const FILE_ID = Array.from({ length: 16 }, (_, i) => i * 0x11);
  const REPLY: IdentityReply = { volumeSerial: "0123456789abcdef", fileId: "00112233445566778899aabbccddeeff" };
  // `sha256sum` of the same 24 bytes, computed outside this repository.
  const KNOWN_KEY = "b66aafd73088ede7ee5a4baecc19477a220e228e1c2c559d2df436a65d3da453";

  caseTest(
    "T321",
    "the worktreeKey of a Windows worktree is the SHA-256 of the 8 big-endian volume serial bytes and then the 16 file ID bytes",
    ["shell-double"],
    () =>
      withDouble("t321-worktree-key", async (double) => {
        const input = new Uint8Array(24);
        new DataView(input.buffer).setBigUint64(0, VOLUME_SERIAL, false);
        input.set(FILE_ID, 8);
        expect(sha256(input)).toBe(KNOWN_KEY);
        const repo = join(buildF08(gitPath(), "t321-worktree-key", "sha1").root, "repo");
        const outcome = await double.register(repo, (r) => ({
          ...r,
          identities: async (...args) => {
            const replies = await r.identities(...args);
            return Array.isArray(replies) ? [REPLY, ...replies.slice(1)] : replies;
          },
        }));
        expect(outcome.ok && "worktreeKey" in outcome.result ? outcome.result.worktreeKey : outcome).toBe(KNOWN_KEY);
      }),
    TIMEOUT_MS,
  );
});

describe("registration refusals (contract §6, data-model §2)", () => {
  caseTest(
    TASK,
    "a bare repository, a Git administration folder, and a .git file with a missing target give their codes and remedy texts",
    ["shell-double"],
    () =>
      withService("t068-refusals", async (service) => {
        const built = buildF07(gitPath(), "t068-refusals");
        const unopenable = built.facts.notes.unopenable as Record<"bare" | "missingGitdir" | "administrationFolder", string>;
        expectRefusal(await service.chooseRepository(join(built.root, unopenable.bare)), "UNSUPPORTED_REPOSITORY", REMEDY.bare);
        expectRefusal(await service.chooseRepository(join(built.root, unopenable.administrationFolder)), "UNSUPPORTED_REPOSITORY", REMEDY.administrationFolder);
        expectRefusal(await service.chooseRepository(join(built.root, unopenable.missingGitdir)), "REPOSITORY_UNAVAILABLE", REMEDY.unavailable);
      }),
    TIMEOUT_MS,
  );

  // Contract §3: the service payload holds only `bootstrapId`, so these cases do not compare `path`. The direct discovery cases above compare it.
  caseTest(
    MERGED,
    "F15 plain folder and F07 broken gitfile: chooseRepository gives the merged refusal with Git's message in outputTail and no command",
    ["shell-double", "no-enclosing-repository"],
    () =>
      withService("t308-merged-service", async (service) => {
        const git = gitPath();
        const f15 = buildF15(git, "t308-merged-service");
        const f07 = buildF07(git, "t308-merged-service-f07");
        for (const directory of [join(f15.root, f15.facts.notes.plain as string), join(f07.root, (f07.facts.notes.unopenable as { missingGitdir: string }).missingGitdir)]) {
          const response = await service.chooseRepository(directory);
          const git1 = probeDiscovery(git, directory);
          expect({ directory, state: response.state, exitCode: git1.exitCode }).toEqual({ directory, state: "failed", exitCode: 128 });
          expectMerged(directory, { code: response.code, ...(response.result as Refusal | undefined) }, git1.stderr);
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F15: a removed path gives the UNKNOWN_TARGET refusal of the context check",
    ["shell-double"],
    () =>
      withService("t068-removed", async (service) => {
        const repo = join(buildF15(gitPath(), "t068-removed").root, "repo");
        removeTree(repo);
        const response = await service.chooseRepository(repo);
        expect({ state: response.state, code: response.code, result: response.result }).toEqual({ state: "failed", code: "UNKNOWN_TARGET", result: undefined });
      }),
    TIMEOUT_MS,
  );

  // A fixture cannot make a folder that another account owns, and the probe policy removes the GIT_TEST_ knob. The direct discovery cases use the knob.
  caseTest(
    MERGED,
    "dubious ownership gives the merged refusal through the service, with Git's message in outputTail, no command, and no safe.directory call",
    ["shell-double", "other-account-owner"],
    () =>
      withService("t308-dubious-service", async (service) => {
        const git = gitPath();
        const repo = join(buildF15(git, "t308-dubious-service").root, "repo");
        const response = await service.chooseRepository(repo);
        expectMerged("dubious", { code: response.code, ...(response.result as Refusal | undefined) }, probeDiscovery(git, repo).stderr);
        expect(service.runner.calls.filter((c) => c.arguments.some((a) => a.includes("safe.directory")))).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  for (const [label, fill] of [
    ["all-zero", 0x00],
    ["all-ones", 0xff],
  ] as const) {
    caseTest(
      TASK,
      `an injected ${label} file ID gives UNSUPPORTED_REPOSITORY with the NTFS or ReFS remedy`,
      ["shell-double"],
      () =>
        withService(`t068-file-id-${label}`, async (service) => {
          const repo = join(buildF08(gitPath(), `t068-file-id-${label}`, "sha1").root, "repo");
          // The service sends Git-resolved paths, so each spelling gets the injected ID.
          for (const path of [repo, join(repo, ".git")]) for (const spelling of [path, slash(path)]) service.runner.inject.fileIds.set(spelling, new Uint8Array(16).fill(fill));
          expectRefusal(await service.chooseRepository(repo), "UNSUPPORTED_REPOSITORY", REMEDY.fileId);
        }),
      TIMEOUT_MS,
    );
  }
});

// Contract §6 "Channel frames": a `refused` reply keeps its code. Only a failed identity gives `UNSUPPORTED_REPOSITORY`.
describe("runner refusals during registration (contract §6)", () => {
  const SYMBOLIC = "--no-lazy-fetch symbolic-ref -q HEAD";
  const refuse = (code: RefusedCode) => Promise.reject(new RunnerRefusal(code));

  // Registers through a wrapper of the shell double. Each wrapper changes one reply of one request.
  async function registerWith(name: string, wrap: (runner: BunRunner) => GitRunner): Promise<RegistrationOutcome> {
    const git = gitPath();
    const repo = join(buildF08(git, name, "sha1").root, "repo");
    const runner = createBunRunner({ git, directory: fixtureDir(`${name}-runner`), environment: serviceEnv() });
    try {
      const gitInstallationId = crypto.randomUUID();
      const probe = runner.addContext("gitProbe", git);
      expect(await runner.register({ operationId: crypto.randomUUID(), bootstrapId: probe, gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false })).toEqual({ result: "approved" });
      const installation: GitInstallation = {
        gitInstallationId,
        selectedPath: git,
        executablePath: git,
        version: "2.55.0",
        admission: "admitted",
        executableIdentity: { file: { volumeSerial: "0".repeat(16), fileId: "0".repeat(31) + "1" }, versionOutput: "2.55.0", digest: "c".repeat(64) },
      };
      const registrations = createRegistrations({ runner: wrap(runner), unfinishedMutation: () => false });
      return await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: runner.addContext("repositoryDiscovery", repo), installation, signal: new AbortController().signal });
    } finally {
      await runner.dispose();
    }
  }

  const passThrough: [string, RefusedCode, (runner: BunRunner) => GitRunner][] = [
    ["the first discovery call", "GIT_CHANGED", (r) => ({ ...r, run: (call) => (call.arguments.join(" ") === FIRST_QUERY.join(" ") ? refuse("GIT_CHANGED") : r.run(call)) })],
    ["a later discovery call", "UNKNOWN_TARGET", (r) => ({ ...r, run: (call) => (call.arguments.join(" ") === SYMBOLIC ? refuse("UNKNOWN_TARGET") : r.run(call)) })],
    ["the identity request", "INVALID_REQUEST", (r) => ({ ...r, identities: () => refuse("INVALID_REQUEST") })],
    ["the register request", "GIT_CHANGED", (r) => ({ ...r, register: () => refuse("GIT_CHANGED") })],
    ["the register request", "UNKNOWN_TARGET", (r) => ({ ...r, register: () => refuse("UNKNOWN_TARGET") })],
  ];
  for (const [step, code, wrap] of passThrough) {
    caseTest(
      TASK,
      `${code} from ${step} keeps its code and carries no result`,
      ["shell-double"],
      async () => expect(await registerWith(`t068-refused-${code.toLowerCase()}-${step.split(" ").at(-2)}`, wrap)).toEqual({ ok: false, code }),
      TIMEOUT_MS,
    );
  }

  const failedIdentity: [string, (replies: IdentityReply[]) => IdentityReply[]][] = [
    ["an UNSUPPORTED_REPOSITORY entry", (replies) => [replies[0]!, { code: "UNSUPPORTED_REPOSITORY" }, ...replies.slice(2)]],
    ["an all-zero file ID", (replies) => [{ volumeSerial: "0".repeat(16), fileId: "0".repeat(32) }, ...replies.slice(1)]],
    ["a reply list of the wrong length", (replies) => replies.slice(1)],
  ];
  for (const [label, change] of failedIdentity) {
    caseTest(
      TASK,
      `${label} in the identity reply gives UNSUPPORTED_REPOSITORY with the NTFS or ReFS remedy`,
      ["shell-double"],
      async () => {
        const outcome = await registerWith(`t068-identity-${label.split(" ").at(-1)!.toLowerCase()}`, (r) => ({
          ...r,
          identities: async (...args) => {
            const replies = await r.identities(...args);
            return Array.isArray(replies) ? change(replies) : replies;
          },
        }));
        expect(outcome).toEqual({ ok: false, code: "UNSUPPORTED_REPOSITORY", result: { remedy: { text: REMEDY.fileId } } });
      },
      TIMEOUT_MS,
    );
  }

  // Contract §5 "Deadline outcomes": a walk deadline of a registration gives DEADLINE. The service holds only `bootstrapId`, so no refusal names the folder.
  for (const [stop, code] of [
    ["deadline", "DEADLINE"],
    ["canceled", "CANCELED"],
  ] as const) {
    caseTest(
      "T312",
      `an identity walk that ends ${stop} gives ${code}`,
      ["shell-double"],
      async () => expect(await registerWith(`t312-identity-${stop}`, (r) => ({ ...r, identities: async () => ({ stop }) }))).toEqual({ ok: false, code }),
      TIMEOUT_MS,
    );
  }

  // Contract §6 "Walks" (T314): the identity read of a `register` is a walk, and its deadline reply gives DEADLINE.
  caseTest(
    "T314",
    "a register deadline reply gives DEADLINE",
    ["shell-double"],
    async () => expect(await registerWith("t314-register-deadline", (r) => ({ ...r, register: async () => ({ stop: "deadline" as const }) }))).toEqual({ ok: false, code: "DEADLINE" }),
    TIMEOUT_MS,
  );
});

describe("F08 object format and HEAD (data-model §2)", () => {
  const HEX = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };

  for (const variant of ["sha1", "sha256"] as const) {
    caseTest(
      TASK,
      `${variant}: objectFormat is Git-reported, and head is the symbolic target plus an OID of that format`,
      ["shell-double"],
      () =>
        withService(`t068-f08-${variant}`, async (service) => {
          const built = buildF08(gitPath(), `t068-f08-${variant}`, variant);
          const { second } = built.facts.notes.commits as { first: string; second: string };
          expect(second).toMatch(HEX[variant]);
          const { repositoryId } = await service.register(join(built.root, "repo"));
          const read = await service.readWorkspace(repositoryId);
          expect(read.result?.identity.objectFormat).toBe(variant);
          expect(read.result?.head).toEqual({ state: "branch", target: "refs/heads/main", oid: second });
        }),
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "detached: head is the detached object ID",
    ["shell-double"],
    () =>
      withService("t068-f08-detached", async (service) => {
        const built = buildF08(gitPath(), "t068-f08-detached", "detached");
        const { first } = built.facts.notes.commits as { first: string; second: string };
        const { repositoryId } = await service.register(join(built.root, "repo"));
        expect((await service.readWorkspace(repositoryId)).result?.head).toEqual({ state: "detached", oid: first });
      }),
    TIMEOUT_MS,
  );

  // git-symbolic-ref(1) `-q`: a detached HEAD gives a non-zero status without a message.
  caseTest(
    TASK,
    "F08 detached: exit status 1 of symbolic-ref -q without stderr gives a detached HEAD, and one stderr byte refuses",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const built = buildF08(git, "t068-f08-detached-quiet", "detached");
      const { first } = built.facts.notes.commits as { first: string; second: string };
      const repo = join(built.root, "repo");
      const symbolic = "--no-lazy-fetch symbolic-ref -q HEAD";
      const runner = createBunRunner({ git, directory: fixtureDir("t068-f08-detached-quiet-runner"), environment: serviceEnv() });
      try {
        const gitInstallationId = crypto.randomUUID();
        const probe = runner.addContext("gitProbe", git);
        expect(await runner.register({ operationId: crypto.randomUUID(), bootstrapId: probe, gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false })).toEqual({ result: "approved" });
        const discover = (wrapped: GitRunner) =>
          discoverRepository(wrapped, { operationId: crypto.randomUUID(), bootstrapId: runner.addContext("repositoryDiscovery", repo), gitInstallationId, directory: repo, gitSelectedPath: git });

        // The real `symbolic-ref -q HEAD` call gives status 1 and no stderr byte.
        const seen: { exitCode: number | null; stderr: number }[] = [];
        const observed: GitRunner = {
          ...runner,
          run: async (call) => {
            if (call.arguments.join(" ") !== symbolic) return runner.run(call);
            const real = createCollector({ maxBytes: 64 * 1024 });
            const exit = await runner.run({ ...call, stderr: real });
            seen.push({ exitCode: exit.exitCode, stderr: real.bytes });
            return exit;
          },
        };
        const detached = await discover(observed);
        expect(seen).toEqual([{ exitCode: 1, stderr: 0 }]);
        expect(detached.ok ? detached.repository.head : detached.refusal).toEqual({ state: "detached", oid: first });

        // One stderr byte follows the real output of that call.
        const oneByte: GitRunner = {
          ...runner,
          run: async (call) => {
            const exit = await runner.run(call);
            if (call.arguments.join(" ") === symbolic) call.stderr.push(new Uint8Array([0x0a]));
            return exit;
          },
        };
        const refused = await discover(oneByte);
        expect(refused.ok ? refused.repository.head : refused.refusal.code).toBe("REPOSITORY_UNAVAILABLE");
      } finally {
        await runner.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F01 unborn: head is a validated unborn branch",
    ["shell-double"],
    () =>
      withService("t068-f01-unborn", async (service) => {
        const built = buildF01(gitPath(), "t068-f01-unborn", "empty");
        const { repositoryId } = await service.register(join(built.root, "repo"));
        expect((await service.readWorkspace(repositoryId)).result?.head).toEqual({ state: "unborn", target: "refs/heads/main" });
      }),
    TIMEOUT_MS,
  );

  // git-show-ref(1) `--exists`: status 0 for an existing ref, 2 for a missing ref, and 1 for another lookup error.
  caseTest(
    TASK,
    "F01 unborn: exit status 2 of show-ref --exists decides the unborn HEAD, other stderr bytes keep it, and status 1 refuses",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const repo = join(buildF01(git, "t068-f01-exists", "empty").root, "repo");
      const verify = "--no-lazy-fetch show-ref --head --verify HEAD";
      const exists = "--no-lazy-fetch show-ref --exists refs/heads/main";
      await withService("t068-f01-exists", async (service) => {
        expect((await service.readWorkspace((await service.register(repo)).repositoryId)).result?.head).toEqual({ state: "unborn", target: "refs/heads/main" });
        const calls = discoveryCalls(service).map((c) => ({ args: c.arguments.join(" "), exitCode: c.exit?.exitCode }));
        const at = calls.findIndex((c) => c.args === verify);
        expect(calls.slice(at, at + 2)).toEqual([{ args: verify, exitCode: 128 }, { args: exists, exitCode: 2 }]);
      });

      // A direct discovery through the shell double. Each wrapper changes one fact of one call.
      const runner = createBunRunner({ git, directory: fixtureDir("t068-f01-exists-runner"), environment: serviceEnv() });
      try {
        const gitInstallationId = crypto.randomUUID();
        const probe = runner.addContext("gitProbe", git);
        expect(await runner.register({ operationId: crypto.randomUUID(), bootstrapId: probe, gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false })).toEqual({ result: "approved" });
        const discover = (wrapped: GitRunner) =>
          discoverRepository(wrapped, { operationId: crypto.randomUUID(), bootstrapId: runner.addContext("repositoryDiscovery", repo), gitInstallationId, directory: repo, gitSelectedPath: git });

        // Other stderr bytes replace the stderr of the failed `show-ref --head --verify HEAD`.
        const gitStderr: Uint8Array[] = [];
        const otherStderr: GitRunner = {
          ...runner,
          run: async (call) => {
            if (call.arguments.join(" ") !== verify) return runner.run(call);
            const real = createCollector({ maxBytes: 64 * 1024 });
            const exit = await runner.run({ ...call, stderr: real });
            gitStderr.push(real.take());
            call.stderr.push(new TextEncoder().encode("error: other bytes\n"));
            return exit;
          },
        };
        const unborn = await discover(otherStderr);
        expect(gitStderr.length).toBe(1);
        expect(gitStderr[0]!.length).toBeGreaterThan(0);
        expect(unborn.ok ? unborn.repository.head : unborn.refusal).toEqual({ state: "unborn", target: "refs/heads/main" });

        // Status 1 replaces the status of `show-ref --exists`. Git 2.55.0 gives 1 for a corrupt loose ref of the HEAD target.
        const failedLookup: GitRunner = {
          ...runner,
          run: async (call) => {
            const exit = await runner.run(call);
            return call.arguments.join(" ") === exists ? { ...exit, exitCode: 1 } : exit;
          },
        };
        const failed = await discover(failedLookup);
        expect(failed.ok ? failed.repository.head : failed.refusal.code).toBe("REPOSITORY_UNAVAILABLE");
      } finally {
        await runner.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // Contract §6: a failed HEAD lookup gives REPOSITORY_UNAVAILABLE. No probe verified the Git 2.55.0 exit statuses, so the case reports them for research.md.
  caseTest(
    MERGED,
    "a corrupt loose ref of the HEAD target gives REPOSITORY_UNAVAILABLE and never reads as unborn",
    ["shell-double"],
    () =>
      withService("t308-corrupt-ref", async (service) => {
        const git = gitPath();
        const repo = join(buildF08(git, "t308-corrupt-ref", "sha1").root, "repo");
        put(repo, ".git/refs/heads/main", "not an object ID\n");
        const response = await service.chooseRepository(repo);
        const result = response.result as Refusal | undefined;
        expect({ state: response.state, code: response.code, text: result?.remedy?.text, command: result?.remedy?.command ?? null }).toEqual({
          state: "failed",
          code: "REPOSITORY_UNAVAILABLE",
          text: REMEDY.unavailable,
          command: null,
        });
        const version = ownedGit(git, FIXTURE_ROOT, repo, ["version"]).toString().trim();
        for (const args of [["symbolic-ref", "-q", "HEAD"], ["show-ref", "--head", "--verify", "HEAD"], ["show-ref", "--exists", "refs/heads/main"]]) {
          const proc = Bun.spawnSync([git, "--no-lazy-fetch", ...args], { cwd: repo, env: fixtureEnv({ LC_ALL: "C" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
          console.log(`OBSERVATION ${MERGED}: ${version}: corrupt loose ref of the HEAD target: \`${args.join(" ")}\` exits with ${proc.exitCode}`);
        }
        const steps = discoveryCalls(service).map((c) => ({ args: c.arguments.slice(1).join(" "), exitCode: c.exit?.exitCode }));
        console.log(`OBSERVATION ${MERGED}: ${version}: discovery calls for a corrupt loose ref of the HEAD target: ${JSON.stringify(steps)}`);
      }),
    TIMEOUT_MS,
  );
});

// Every configuration file that Git reads for the F07 main worktree under the owned environment.
function configDigests(git: string, common: string): Record<string, string> {
  const files = [join(common, "config"), FIXTURE_GLOBAL_CONFIG];
  const worktrees = join(common, "worktrees");
  if (existsSync(worktrees)) for (const name of readdirSync(worktrees)) files.push(join(worktrees, name, "config.worktree"));
  const digests: Record<string, string> = {};
  for (const file of files) digests[file] = existsSync(file) ? sha256(readFileSync(file)) : "missing";
  for (const line of realGlobalConfigDigests(git)) digests[line] = "real global";
  return digests;
}

describe("registration effects", () => {
  caseTest(
    TASK,
    "repositoryId is a random session identifier, not a path or revision; opening creates no worktree and keeps every configuration file digest",
    ["shell-double"],
    () =>
      withService("t068-effects", async (service) => {
        const git = gitPath();
        const built = buildF07(git, "t068-effects");
        const main = join(built.root, "main");
        const common = join(main, ".git");
        const worktrees = () => ownedGit(git, FIXTURE_ROOT, main, ["worktree", "list", "--porcelain", "-z"]).toString("utf8");
        const before = { worktrees: worktrees(), configs: configDigests(git, common) };
        const ids: string[] = [];
        for (const name of ["main", "wt-a", "super/sub", "separate"]) {
          const registered = await service.register(join(built.root, name));
          expect((await service.readWorkspace(registered.repositoryId)).state).toBe("succeeded");
          ids.push(registered.repositoryId);
          expect(registered.repositoryId).toMatch(UUID);
          expect(registered.repositoryId).not.toBe(registered.worktreeKey);
          const resolves = Bun.spawnSync([git, "rev-parse", "--verify", "-q", registered.repositoryId], { cwd: main, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
          expect(resolves.exitCode).not.toBe(0);
        }
        expect(new Set(ids).size).toBe(ids.length);
        expect({ worktrees: worktrees(), configs: configDigests(git, common) }).toEqual(before);
      }),
    TIMEOUT_MS,
  );
});

// Research R2: the traditional hook names of githooks(5).
const TRADITIONAL_HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change",
];
// Git `Documentation/config/gpg.adoc`.
const SIGNING_KEYS = ["gpg.program", "gpg.openpgp.program", "gpg.x509.program", "gpg.ssh.program", "gpg.ssh.defaultKeyCommand"];

// Adds the research R2 canaries that F17 lacks. Returns every canary log path of the fixture.
function armDiscoveryCanaries(git: string, built: Built): string[] {
  const repo = join(built.root, "repo");
  const logs = Object.values(built.facts.canaries).map((log) => join(built.root, log));
  const canary = (name: string) => {
    const log = join(built.root, "canaries", `t068-${name}.log`);
    const script = put(built.root, `canaries/t068-${name}.sh`, `#!/bin/sh\necho "${name} $*" >> '${slash(log)}'\nexit 1\n`);
    chmodSync(script, 0o755);
    logs.push(log);
    return `'${slash(script)}'`;
  };
  const config = (key: string, value: string) => ownedGit(git, FIXTURE_ROOT, repo, ["config", key, value]);
  config("filter.canary.smudge", canary("smudge"));
  for (const key of SIGNING_KEYS) config(key, canary(key));
  config("hook.t068.command", canary("configured-hook"));
  config("hook.t068.event", "pre-commit");
  for (const hook of TRADITIONAL_HOOKS) {
    if (hook === "pre-commit") continue;
    chmodSync(put(repo, `.git/hooks/${hook}`, `#!/bin/sh\nexec ${canary(`hook-${hook}`)}\n`), 0o755);
  }
  // A stat-dirty file with the clean filter: its content stays, and its time changes.
  utimesSync(join(repo, "data.dat"), new Date(), new Date(Date.now() + 60_000));
  return logs;
}

describe("discovery canaries (research R2)", () => {
  caseTest(
    TASK,
    "registration and restoreWorkspace run no canary, never send rev-parse --shared-index-path, and use only the discovery commands",
    ["shell-double"],
    async () => {
      const git = gitPath();
      const built = buildF17(git, "t068-canaries", "trust");
      const logs = armDiscoveryCanaries(git, built);
      const repo = join(built.root, "repo");
      let service = await openService({ git, name: "t068-canaries" });
      try {
        await service.register(repo);
        expect((await service.restoreWorkspace(repo)).state).toBe("succeeded");
        const first = service.runner.calls;
        service = await service.restart();
        expect((await service.restoreWorkspace(repo)).state).toBe("succeeded");
        const calls = [...first, ...service.runner.calls];
        expect(calls.filter((c) => c.arguments.includes("--shared-index-path"))).toEqual([]);
        const discovery = calls.filter((c) => c.contextKind === "repositoryDiscovery");
        expect(discovery.length).toBeGreaterThan(0);
        for (const c of discovery) expect({ args: c.arguments, command: c.arguments[1] }).toEqual({ args: c.arguments, command: expect.stringMatching(/^(rev-parse|symbolic-ref|show-ref)$/) });
        expect(logs.filter((log) => existsSync(log))).toEqual([]);
      } finally {
        await service.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F10 split index registers, and its split state comes only from the raw link extension",
    ["shell-double"],
    () =>
      withService("t068-split-index", async (service) => {
        const built = buildF10(gitPath(), "t068-split-index", "split-index");
        const { repositoryId } = await service.register(join(built.root, "repo"));
        const read = await service.readWorkspace(repositoryId);
        expect(read.result?.hunkEligibility).toEqual({ eligible: false, reason: "split-index" });
        expect(service.runner.calls.filter((c) => c.arguments.includes("--shared-index-path"))).toEqual([]);
        expect(discoveryCalls(service).filter((c) => c.arguments.includes("ls-files"))).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});
