// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T213: WSL mutations with F21 copies (contract §4 "WSL index publication", "Process end", §6 "WSL file work", §11).
// The T214 routes of `hunk-publish.ts`, `file-publish.ts`, and `commit.ts` come with T214. The oracle is the distro Git in a disposable copy.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import type { WslFileResult, WslFilesCall } from "../../src/contracts/channel";
import type { WalkStop } from "../../src/git-service/git-runner";
import { STEP_FAILED_TEXT } from "../../src/git-service/hunk-publish";
import { readRawIndex } from "../../src/git-service/status";
import { printOrigin } from "../origin";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, fixtureEnv, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { buildF02 } from "../git/fixtures";
import { GIT } from "../git/git-binary";
import { git, gitPath, one, psQuote, readOk, repoOf, subcommand, valuesOf, withService } from "../git/hunk-harness";
import { caseTest, withFsCalls } from "../git/service-harness";
import { buildF21, distroGit, globalConfig, startSession, writeLinux, type PublicResponse, type WslRepo, type WslSession } from "./fixtures";
import { inDistro, missingCapability, uncPath, useWslFolder, WSL_EXE, wslExec, wslHost, type WslCapability, type WslHost } from "./wsl-host";

const TASK = "T213";
const CASE_TIMEOUT_MS = 240_000;
// Upper bound of the wait for the start of a pre-commit hook. The hook itself sleeps 20 s.
const HOOK_START_MS = 60_000;
const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"];
// Contract §4 "Limitation remedies".
const REMEDY_TEXT = "This command stages or unstages the whole file with your Git settings. Run it in a terminal.";

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
// Each dispose ends the WSL scopes of the runner through `wsl.exe`, so the hook takes the case bound.
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
}, CASE_TIMEOUT_MS);

type Module = "hunk-publish" | "file-publish" | "commit" | "recovery";
// Prints the ORIGIN line of each module under test and loads it. Before its task, a module is missing, and this throws.
async function underTest(...modules: Module[]): Promise<void> {
  for (const module of modules) {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
    await import(`../../src/git-service/${module}.ts`);
  }
}

// A WSL case with an optional extra capability. A missing capability skips it and names the capability, as `wslTest` does.
function wslCase(name: string, needs: readonly WslCapability[], body: (host: WslHost) => Promise<void>, extra: { capability: string; present: boolean } | null = null): void {
  const missing = missingCapability(needs) ?? (extra !== null && !extra.present ? extra.capability : null);
  if (missing !== null) {
    console.log(`SKIP ${missing}: ${name}`);
    test.skip(`${name} (SKIP: ${missing})`, () => {});
    return;
  }
  test(name, () => body(wslHost()!), CASE_TIMEOUT_MS);
}

// ---- The double with a `wslFiles` log ----

type Reply = WslFileResult[] | WalkStop;
// A test stop of one walk. `forward` runs the real Perl walk. Returning `{ stop }` gives the service the walk deadline or cancel reply.
type Stop = (request: WslFilesCall, forward: () => Promise<Reply>) => Promise<Reply>;
interface FilesEntry {
  // `performance.now()` at the request and at the reply.
  at: number;
  done: number;
  request: WslFilesCall;
  reply: Reply;
}

// The double logs no `wslFiles` request and has no stop after the read (seam gap). The wrapper adds both before `startSession` copies the runner.
function setup(host: WslHost, stop: Stop | null = null) {
  const directory = fixtureDir(`runner-${crypto.randomUUID()}`);
  const runner = createBunRunner({ git: GIT ?? "git", directory, environment: serviceEnv(), wslGlobalConfig: globalConfig(host) });
  runners.push(runner);
  const files: FilesEntry[] = [];
  const wslFiles = runner.wslFiles;
  runner.wslFiles = async (request, signal) => {
    const at = performance.now();
    const forward = () => wslFiles(request, signal);
    const reply = await (stop === null ? forward() : stop(request, forward));
    files.push({ at, done: performance.now(), request, reply });
    return reply;
  };
  // `readRawIndex` reads the index bytes through UNC (contract §6 "WSL file work": only after a changed index digest).
  const seam = { rawReads: 0 };
  const s = startSession(runner, {
    readRawIndex: (path) => {
      seam.rawReads++;
      return readRawIndex(path);
    },
  });
  // `RecordedCall` holds no transaction. The start barrier sees the `GitCall` with `transaction.indexFile`.
  const indexFiles: { operationId: string; indexFile: string }[] = [];
  runner.holdStart((call) => {
    const { transaction } = call as typeof call & { transaction?: { indexFile: string } };
    if (transaction !== undefined) indexFiles.push({ operationId: call.operationId, indexFile: transaction.indexFile });
    return false;
  });
  return { runner, directory, s, files, seam, indexFiles };
}

const modesOf = (files: FilesEntry[], operationId: string) => files.filter((f) => f.request.operationId === operationId).map((f) => f.request.mode);

// ---- Public requests ----

interface Read {
  snapshotId: string;
  generation: number;
  entries: { entryId: string; path: string; category: string }[];
  hunkEligibility: { eligible: boolean; reason?: string };
  identity: { worktreeRoot: string; gitDirectory: string };
}

async function register(s: WslSession, r: WslRepo): Promise<string> {
  const response = await s.response(s.chooseRepository(uncPath(r.host, r.dir)));
  expect(response).toMatchObject({ state: "succeeded" });
  return (response.result as { repositoryId: string }).repositoryId;
}

async function readWs(s: WslSession, repositoryId: string): Promise<Read> {
  const response = await s.response(s.request("readWorkspace", { refresh: false, check: "full" }, { repositoryId }));
  expect(outcome(response)).toEqual(SUCCEEDED);
  return response.result as unknown as Read;
}

async function approve(s: WslSession, repositoryId: string): Promise<void> {
  const trust = await s.response(s.request("readTrust", {}, { repositoryId }));
  expect(trust).toMatchObject({ state: "succeeded" });
  expect(await s.response(s.request("approveTrust", { action: "commit" }, { repositoryId }))).toMatchObject({ state: "succeeded" });
}

interface Compared {
  read: Read;
  comparisonId: string;
  hunkIds: string[];
}

async function compare(s: WslSession, repositoryId: string, path: string, category: string): Promise<Compared> {
  const read = await readWs(s, repositoryId);
  const entry = read.entries.find((e) => e.path === path && e.category === category);
  expect({ path, category, listed: entry !== undefined }).toEqual({ path, category, listed: true });
  const response = await s.response(s.request("readComparison", { snapshotId: read.snapshotId, entryId: entry!.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() }));
  return { read, comparisonId: valuesOf(response.result, "comparisonId")[0] as string, hunkIds: valuesOf(response.result, "hunkId") as string[] };
}

const envelopeOf = (repositoryId: string, c: Compared) => ({ repositoryId, repositoryGeneration: c.read.generation });
const applyFile = (s: WslSession, repositoryId: string, c: Compared, direction: "stage" | "unstage") =>
  s.response(s.request("applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction }, envelopeOf(repositoryId, c)));
const applyHunk = (s: WslSession, repositoryId: string, c: Compared, direction: "stage" | "unstage") =>
  s.response(s.request("applyHunk", { comparisonId: c.comparisonId, hunkId: c.hunkIds[0], snapshotId: c.read.snapshotId, direction }, envelopeOf(repositoryId, c)));

async function commit(s: WslSession, repositoryId: string, message: string): Promise<PublicResponse> {
  const read = await readWs(s, repositoryId);
  const envelope = { repositoryId, repositoryGeneration: read.generation };
  const review = await s.response(s.request("reviewCommit", { snapshotId: read.snapshotId }, envelope));
  expect(review).toMatchObject({ state: "succeeded" });
  const reviewToken = (review.result as { reviewToken: string }).reviewToken;
  return s.response(s.request("commit", { reviewToken, message, confirmFullScope: true }, envelope));
}

const outcome = (response: PublicResponse) => ({ state: response.state, code: response.code });
const SUCCEEDED = { state: "succeeded", code: undefined };

// ---- Distro facts ----

const copyOf = (r: WslRepo, tag: string): WslRepo => {
  const dir = `${r.dir}-${tag}`;
  inDistro(r.host.distro, ["/usr/bin/cp", "-a", "--", r.dir, dir]);
  return { host: r.host, dir };
};
const sha256 = (host: WslHost, path: string) => inDistro(host.distro, ["/usr/bin/sha256sum", "--", path]).split(" ")[0]!;
const exists = (host: WslHost, path: string) => wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/test", "-e", path]).exitCode === 0;
const content = (host: WslHost, path: string) => inDistro(host.distro, ["/usr/bin/cat", "--", path]);
const inode = (host: WslHost, path: string) => inDistro(host.distro, ["/usr/bin/stat", "--format=%i", "--", path]).trim();
const indexPath = (r: WslRepo) => `${r.dir}/.git/index`;
const lockPath = (r: WslRepo) => `${r.dir}/.git/index.lock`;
// The logical index: `ls-files --stage -z` gives mode, object ID, stage, and path.
const stagedIndex = (r: WslRepo) => distroGit(r, ["ls-files", "--stage", "-z"]);
// The SHA-256 of every working file, without the Git directory.
const workingDigests = (r: WslRepo) =>
  inDistro(r.host.distro, ["/usr/bin/find", r.dir, "-path", `${r.dir}/.git`, "-prune", "-o", "-type", "f", "-exec", "/usr/bin/sha256sum", "--", "{}", "+"])
    .split("\n")
    .filter((l) => l !== "")
    .sort();
// Contract §8: the fixed name prefix of candidate files.
const CANDIDATE_PREFIX = "arbareto-candidate-";
// The owned files that remain in the Git directory (contract §8: `index.lock` and the candidate prefix).
const ownedLeftovers = (r: WslRepo) =>
  inDistro(r.host.distro, ["/usr/bin/ls", "-A", "--", `${r.dir}/.git`])
    .split("\n")
    .filter((n) => n === "index.lock" || n.startsWith(CANDIDATE_PREFIX));
// Contract §11 "Paths and file access": every WSL result path has the UNC form of the Git-resolved path.
const uncBeside = (read: Read, name: string) => `${read.identity.gitDirectory}\\${name}`;
const uncLock = (read: Read) => uncBeside(read, "index.lock");
const pathOf = (response: PublicResponse) => (response.result as { path?: string } | undefined)?.path;
const foreignOf = (response: PublicResponse) => (response.result as { foreign?: string[] } | undefined)?.foreign;

// gitformat-commit: header lines, one empty line, then the message bytes. The dates differ per run.
function commitFacts(r: WslRepo): { tree: string; parents: string[]; body: string } {
  const raw = distroGit(r, ["cat-file", "commit", "HEAD"]);
  const split = raw.indexOf("\n\n");
  const headers = raw.slice(0, split).split("\n");
  const field = (name: string) => headers.filter((h) => h.startsWith(`${name} `)).map((h) => h.slice(name.length + 1));
  return { tree: field("tree")[0]!, parents: field("parent"), body: raw.slice(split + 2) };
}

// Contract §4 "WSL index publication": the lock, the candidate copy, and the publication run inside the distro, and the published index has the verified candidate digest.
function checkPublication(files: FilesEntry[], indexFiles: { operationId: string; indexFile: string }[], r: WslRepo, read: Read, operationId: string): void {
  const own = files.filter((f) => f.request.operationId === operationId);
  const modes = own.map((f) => f.request.mode);
  const lock = modes.indexOf("lock");
  const candidate = modes.indexOf("candidate");
  const publish = modes.indexOf("publish");
  expect({ lock: lock >= 0, candidate: candidate > lock, publish: publish > candidate }).toEqual({ lock: true, candidate: true, publish: true });
  const copy = own[candidate]!;
  const [copied] = copy.reply as WslFileResult[];
  if (copy.request.mode !== "candidate" || copied?.kind !== "candidate") throw new Error(`candidate: ${JSON.stringify(copy.reply)}`);
  // Contract §4 "Candidate time": at or before the canonical time.
  expect(BigInt(copied.candidate.mtime) <= BigInt(copied.index.mtime)).toBe(true);
  // The Git steps use that candidate in the Linux Git directory.
  const used = indexFiles.filter((f) => f.operationId === operationId).map((f) => ({ folder: dirname(f.indexFile), name: f.indexFile.slice(dirname(f.indexFile).length + 1) }));
  expect(used.length).toBeGreaterThan(0);
  for (const u of used) expect(u).toEqual({ folder: read.identity.gitDirectory, name: copy.request.candidate });
  const published = own[publish]!;
  const [result] = published.reply as WslFileResult[];
  if (published.request.mode !== "publish" || result?.kind !== "published") throw new Error(`publish: ${JSON.stringify(published.reply)}`);
  expect({ reply: result.sha256, index: sha256(r.host, indexPath(r)) }).toEqual({ reply: published.request.expected, index: published.request.expected });
}

describe("WSL mutations equal the distro Git (T213)", () => {
  wslCase(
    `applyHunk stages as git add -p does in a copy; the lock, candidate, and publication run through wslFiles, and working files stay`,
    NEEDS,
    async (host) => {
      await underTest("hunk-publish");
      const { repo } = buildF21(host);
      const oracle = copyOf(repo, "oracle");
      distroGit(oracle, ["-c", "core.pager=cat", "--literal-pathspecs", "add", "-p", "--", "multi.txt"], { input: Buffer.from("y\nn\n") });
      const files = workingDigests(repo);
      const { s, files: log, indexFiles } = setup(host);
      const id = await register(s, repo);
      const c = await compare(s, id, "multi.txt", "unstaged");
      const response = await applyHunk(s, id, c, "stage");
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect({ index: stagedIndex(repo), files: workingDigests(repo), leftovers: ownedLeftovers(repo) }).toEqual({ index: stagedIndex(oracle), files, leftovers: [] });
      checkPublication(log, indexFiles, repo, c.read, response.operationId!);
    },
  );

  for (const [direction, path, category, command] of [
    ["stage", "multi.txt", "unstaged", ["--literal-pathspecs", "add", "--", "multi.txt"]],
    ["unstage", "other-a.txt", "staged", ["--literal-pathspecs", "restore", "--staged", "--", "other-a.txt"]],
  ] as const) {
    wslCase(
      `applyFile ${direction} of ${path} equals git ${command[1]} in a copy; the lock, candidate, and publication run through wslFiles, and working files stay`,
      NEEDS,
      async (host) => {
        await underTest("file-publish");
        const { repo } = buildF21(host);
        const oracle = copyOf(repo, "oracle");
        distroGit(oracle, [...command]);
        const files = workingDigests(repo);
        const { s, files: log, indexFiles } = setup(host);
        const id = await register(s, repo);
        const c = await compare(s, id, path, category);
        const response = await applyFile(s, id, c, direction);
        expect(outcome(response)).toEqual(SUCCEEDED);
        expect({ index: stagedIndex(repo), files: workingDigests(repo), leftovers: ownedLeftovers(repo) }).toEqual({ index: stagedIndex(oracle), files, leftovers: [] });
        checkPublication(log, indexFiles, repo, c.read, response.operationId!);
      },
    );
  }

  wslCase(
    `commit gives the tree, parent, and message of git commit in a copy, and the pre-commit hook runs as the Linux user`,
    NEEDS,
    async (host) => {
      await underTest("commit");
      const { repo } = buildF21(host);
      const log = `${repo.dir}-hook.log`;
      writeLinux(host, `${repo.dir}/.git/hooks/pre-commit`, `#!/bin/sh\n/usr/bin/id -u >> '${log}'\n`, "755");
      const oracle = copyOf(repo, "oracle");
      const message = "T213 commit\n";
      distroGit(oracle, ["commit", "--quiet", "--no-verify", "--file=-"], { input: Buffer.from(message) });
      const files = workingDigests(repo);
      const { s } = setup(host);
      const id = await register(s, repo);
      await approve(s, id);
      expect(outcome(await commit(s, id, message))).toEqual(SUCCEEDED);
      expect({ commit: commitFacts(repo), index: stagedIndex(repo), files: workingDigests(repo), leftovers: ownedLeftovers(repo) }).toEqual({ commit: commitFacts(oracle), index: stagedIndex(oracle), files, leftovers: [] });
      expect(content(host, log)).toBe(inDistro(host.distro, ["/usr/bin/id", "-u"]));
    },
  );
});

describe("core.sharedRepository (contract §4 \"WSL index publication\", §9)", () => {
  type Scope = "local" | "global" | "worktree";
  const set = (r: WslRepo, scope: Scope) => {
    if (scope === "worktree") distroGit(r, ["config", "--local", "extensions.worktreeConfig", "true"]);
    distroGit(r, ["config", `--${scope}`, "core.sharedRepository", "group"]);
  };
  const unset = (r: WslRepo, scope: Scope) => distroGit(r, ["config", `--${scope}`, "--unset", "core.sharedRepository"]);

  for (const scope of ["local", "global", "worktree"] satisfies Scope[]) {
    wslCase(
      `core.sharedRepository at ${scope} scope makes readWorkspace report shared-repository and refuses applyHunk and applyFile with UNSUPPORTED_HUNK_PROFILE; the index keeps its bytes, no owned lock or candidate remains, and no config process starts; without the key, the same request publishes`,
      NEEDS,
      async (host) => {
        await underTest("hunk-publish", "file-publish");
        const { repo } = buildF21(host);
        set(repo, scope);
        try {
          const { runner, s } = setup(host);
          const id = await register(s, repo);
          expect((await readWs(s, id)).hunkEligibility).toEqual({ eligible: false, reason: "shared-repository" });
          const index = sha256(host, indexPath(repo));
          const hunk = await compare(s, id, "multi.txt", "unstaged");
          const file = await compare(s, id, "multi.txt", "unstaged");
          for (const response of [await applyHunk(s, id, hunk, "stage"), await applyFile(s, id, file, "stage")]) {
            expect({ code: response.code, reason: (response.result as { reason?: string } | undefined)?.reason }).toEqual({ code: "UNSUPPORTED_HUNK_PROFILE", reason: "shared-repository" });
            const configRuns = runner.calls.filter((call) => call.operationId === response.operationId && subcommand(call.arguments) === "config");
            expect({ index: sha256(host, indexPath(repo)), leftovers: ownedLeftovers(repo), configRuns }).toEqual({ index, leftovers: [], configRuns: [] });
          }
          unset(repo, scope);
          const again = await compare(s, id, "multi.txt", "unstaged");
          expect(again.read.hunkEligibility).toEqual({ eligible: true });
          expect(outcome(await applyFile(s, id, again, "stage"))).toEqual(SUCCEEDED);
        } finally {
          // The owned global file serves every case of this file.
          if (scope === "global") distroGit(repo, ["config", "--global", "--unset-all", "core.sharedRepository"], { allowExit: [0, 5] });
        }
      },
    );
  }

  caseTest(TASK, "a Windows repository with core.sharedRepository stays eligible", ["shell-double"], () =>
    withService({ name: "t213-windows-shared" }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), "t213-windows-shared"));
      git(repo, ["config", "--local", "core.sharedRepository", "group"]);
      const { repositoryId } = await service.register(repo);
      expect((await readOk(service, repositoryId)).hunkEligibility).toEqual({ eligible: true });
    }),
    CASE_TIMEOUT_MS,
  );
});

describe("lock ownership and the process-end fact (contract §4 \"WSL index publication\", \"Process end\")", () => {
  const isFact = (call: { arguments: readonly string[]; environmentPolicy: string }) => call.arguments.length === 2 && call.arguments[0] === "--no-lazy-fetch" && call.arguments[1] === "version" && call.environmentPolicy === "mutation";

  // After the stop, no `remove` and no `indexDigest` request comes before the end of a `git version` run whose exit has `activeDescendants` 0.
  function checkOrder(runner: BunRunner, files: FilesEntry[], operationId: string, stopAt: number): { decisions: FilesEntry[] } {
    const facts = runner.calls.filter((c) => c.operationId === operationId && isFact(c) && c.at >= stopAt && c.exit?.activeDescendants === 0 && c.durationMs !== undefined);
    expect(facts.length).toBeGreaterThan(0);
    const factEnd = Math.min(...facts.map((c) => c.at + c.durationMs!));
    const decisions = files.filter((f) => f.request.operationId === operationId && f.at >= stopAt && (f.request.mode === "remove" || f.request.mode === "indexDigest"));
    expect(decisions.filter((f) => f.at < factEnd).map((f) => f.request.mode)).toEqual([]);
    return { decisions };
  }

  // Stops the first walk of `mode` with a deadline reply, after the real walk when `after` holds.
  function stopFirst(mode: WslFilesCall["mode"], after: boolean, at: { stop: number }): Stop {
    let done = false;
    return async (request, forward) => {
      if (done || request.mode !== mode) return forward();
      done = true;
      if (after) await forward();
      at.stop = performance.now();
      return { stop: "deadline" };
    };
  }

  // T116 B3-3, contract §4 "Commit process end": the Cancel closes the Job of the commit process while its hook runs.
  wslCase(
    `a commit canceled in its pre-commit hook starts no reconciliation process or walk before the process-end fact, and ends canceled without a commit`,
    NEEDS,
    async (host) => {
      await underTest("commit");
      const { repo } = buildF21(host);
      const started = `${repo.dir}-hook.started`;
      writeLinux(host, `${repo.dir}/.git/hooks/pre-commit`, `#!/bin/sh\n: > '${started}'\n/usr/bin/sleep 60\n`, "755");
      const head = distroGit(repo, ["rev-parse", "HEAD"]);
      const { runner, s, files } = setup(host);
      const id = await register(s, repo);
      await approve(s, id);
      const read = await readWs(s, id);
      const envelope = { repositoryId: id, repositoryGeneration: read.generation };
      const review = await s.response(s.request("reviewCommit", { snapshotId: read.snapshotId }, envelope));
      const reviewToken = (review.result as { reviewToken: string }).reviewToken;
      const requestId = s.request("commit", { reviewToken, message: "T116 canceled\n", confirmFullScope: true }, envelope);
      const deadline = Date.now() + 60_000;
      while (!exists(host, started)) {
        if (Date.now() > deadline) throw new Error("the pre-commit hook did not start within 60000 ms");
        await Bun.sleep(200);
      }
      const operationId = s.progressOf(requestId)[0]!.operationId!;
      s.request("cancel", { operationId });
      const response = await s.response(requestId);
      const committed = runner.calls.find((c) => c.operationId === operationId && subcommand(c.arguments) === "commit");
      expect({ exitCode: committed?.exit?.exitCode, ended: committed?.durationMs !== undefined }).toEqual({ exitCode: null, ended: true });
      const stopAt = committed!.at + committed!.durationMs!;
      const facts = runner.calls.filter((c) => c.operationId === operationId && isFact(c) && c.at >= stopAt && c.exit?.activeDescendants === 0 && c.exit.exitCode !== null && c.durationMs !== undefined);
      expect(facts.length).toBeGreaterThan(0);
      const factEnd = Math.min(...facts.map((c) => c.at + c.durationMs!));
      const early = [...runner.calls.filter((c) => c.operationId === operationId && c.at >= stopAt && c.at < factEnd && !isFact(c)).map((c) => c.arguments.join(" ")), ...files.filter((f) => f.request.operationId === operationId && f.at >= stopAt && f.at < factEnd).map((f) => f.request.mode)];
      expect({ early, ...outcome(response), head: distroGit(repo, ["rev-parse", "HEAD"]) }).toEqual({ early: [], state: "canceled", code: "CANCELED", head });
    },
  );

  for (const after of [true, false]) {
    wslCase(
      after
        ? `a deadline after Perl created and wrote the lock: no remove or indexDigest decision comes before the process-end fact, and remove with the token then gives removed`
        : `a deadline before the lock create: after the process-end fact, remove with the token gives notOwned`,
      NEEDS,
      async (host) => {
        await underTest("file-publish");
        const { repo } = buildF21(host);
        const index = sha256(host, indexPath(repo));
        const files = workingDigests(repo);
        const at = { stop: Number.POSITIVE_INFINITY };
        const { runner, s, files: log } = setup(host, stopFirst("lock", after, at));
        const id = await register(s, repo);
        const response = await applyFile(s, id, await compare(s, id, "multi.txt", "unstaged"), "stage");
        const lock = log.find((f) => f.request.operationId === response.operationId && f.request.mode === "lock")!;
        const token = lock.request.mode === "lock" ? lock.request.token : "";
        const { decisions } = checkOrder(runner, log, response.operationId!, at.stop);
        const remove = decisions.find((f) => f.request.mode === "remove");
        expect({ token: remove?.request.mode === "remove" ? remove.request.token : null, reply: remove?.reply }).toEqual({ token, reply: [{ kind: after ? "removed" : "notOwned" }] });
        expect({ lock: exists(host, lockPath(repo)), index: sha256(host, indexPath(repo)), files: workingDigests(repo) }).toEqual({ lock: false, index, files });
        expect(outcome(response)).toEqual({ state: "failed", code: "DEADLINE" });
      },
    );
  }

  wslCase(
    `a publish walk stopped by a deadline after the rename is decided from indexDigest after the process-end fact, and the index equals git add in a copy`,
    NEEDS,
    async (host) => {
      await underTest("file-publish");
      const { repo } = buildF21(host);
      const oracle = copyOf(repo, "oracle");
      distroGit(oracle, ["--literal-pathspecs", "add", "--", "multi.txt"]);
      const at = { stop: Number.POSITIVE_INFINITY };
      const { runner, s, files: log } = setup(host, stopFirst("publish", true, at));
      const id = await register(s, repo);
      const response = await applyFile(s, id, await compare(s, id, "multi.txt", "unstaged"), "stage");
      const publish = log.find((f) => f.request.operationId === response.operationId && f.request.mode === "publish")!;
      const expected = publish.request.mode === "publish" ? publish.request.expected : "";
      const { decisions } = checkOrder(runner, log, response.operationId!, at.stop);
      expect(decisions.map((f) => f.request.mode)).toContain("indexDigest");
      expect({ index: sha256(host, indexPath(repo)), entries: stagedIndex(repo) }).toEqual({ index: expected, entries: stagedIndex(oracle) });
      expect(["succeeded", "completed-with-effects"]).toContain(response.state);
    },
  );

  // ext4 gives a freed inode to the next new file at once, so the other lock is created before the rename over the name.
  const SWAPS = {
    "another inode": (r: WslRepo) => {
      inDistro(r.host.distro, ["/usr/bin/cp", "-p", "--", lockPath(r), `${lockPath(r)}.other`]);
      inDistro(r.host.distro, ["/usr/bin/mv", "-f", "--", `${lockPath(r)}.other`, lockPath(r)]);
    },
    "the same inode and other content": (r: WslRepo) => void inDistro(r.host.distro, ["/usr/bin/dd", `of=${lockPath(r)}`, "conv=notrunc", "status=none"], { input: Buffer.from("x".repeat(64)) }),
  };
  for (const [swap, change] of Object.entries(SWAPS)) {
    wslCase(
      `a lock with ${swap} gives publish notOwned with no rename`,
      NEEDS,
      async (host) => {
        await underTest("file-publish");
        const { repo } = buildF21(host);
        const index = { sha: sha256(host, indexPath(repo)), inode: inode(host, indexPath(repo)) };
        let lockInode = "";
        const swapLock: Stop = async (request, forward) => {
          if (request.mode !== "publish") return forward();
          lockInode = inode(host, lockPath(repo));
          change(repo);
          return forward();
        };
        const { s, files: log } = setup(host, swapLock);
        const id = await register(s, repo);
        const c = await compare(s, id, "multi.txt", "unstaged");
        const response = await applyFile(s, id, c, "stage");
        const publish = log.filter((f) => f.request.operationId === response.operationId && f.request.mode === "publish");
        expect(publish.map((f) => f.reply)).toEqual([[{ kind: "notOwned" }]]);
        expect({ sha: sha256(host, indexPath(repo)), inode: inode(host, indexPath(repo)) }).toEqual(index);
        // After `notOwned`, no owned lock exists, so no `remove` follows and the lock at the path stays. The original inode never returns.
        const lockAfter = exists(host, lockPath(repo)) ? inode(host, lockPath(repo)) : null;
        expect({ swap, kept: lockAfter !== null, sameLock: lockAfter === lockInode }).toEqual({ swap, kept: true, sameLock: swap !== "another inode" });
        expect({ swap, state: response.state, code: response.code, path: pathOf(response) }).toEqual({ swap, state: "failed", code: "STALE_SELECTION", path: uncLock(c.read) });
      },
    );
  }

  // ---- Contract §4 "Outcome after a stopped walk" rows ----

  const causeOf = (s: WslSession, operationId: string) => s.session.log.entries().find((e) => e.operationId === operationId)?.cause;
  const remedyOf = (response: PublicResponse) => (response.result as { remedy?: unknown } | undefined)?.remedy;
  const STEP_FAILED = { text: STEP_FAILED_TEXT };
  const ofMode = (files: FilesEntry[], operationId: string, mode: WslFilesCall["mode"]) => files.filter((f) => f.request.operationId === operationId && f.request.mode === mode);
  // The lock identity of the `lock` reply and the token of its request.
  function lockOf(files: FilesEntry[], operationId: string): { identity: { device: string; inode: string } | null; token: string } {
    const [entry] = ofMode(files, operationId, "lock");
    if (entry?.request.mode !== "lock") throw new Error("no lock request");
    const [reply] = Array.isArray(entry.reply) ? entry.reply : [];
    return { identity: reply?.kind === "lock" ? { device: reply.device, inode: reply.inode } : null, token: entry.request.token };
  }
  // Each lock `remove`: the lock form names the identity, and the token-only form names none.
  const lockRemoves = (files: FilesEntry[], operationId: string) =>
    ofMode(files, operationId, "remove").flatMap((f) => (f.request.mode === "remove" && f.request.token !== undefined ? [{ lock: f.request.lock ?? null, token: f.request.token, reply: f.reply }] : []));

  for (const ending of ["cancel", "error"] as const) {
    wslCase(
      ending === "cancel"
        ? `a lock walk stopped by cancel after the create gives canceled after the process-end fact and a token-only remove that gives removed`
        : `a lock reply error after the create gives GIT_FAILED with cause lock-create after the process-end fact and a token-only remove that gives removed`,
      NEEDS,
      async (host) => {
        await underTest("file-publish");
        const { repo } = buildF21(host);
        const index = sha256(host, indexPath(repo));
        const files = workingDigests(repo);
        const at = { stop: Number.POSITIVE_INFINITY };
        const held: { s: WslSession | null } = { s: null };
        const stopLock: Stop = async (request, forward) => {
          if (request.mode !== "lock" || at.stop !== Number.POSITIVE_INFINITY) return forward();
          await forward();
          if (ending === "cancel") held.s!.request("cancel", { operationId: request.operationId });
          at.stop = performance.now();
          return ending === "cancel" ? { stop: "canceled" } : [{ kind: "error", component: 0, code: "io-error" }];
        };
        const { runner, s, files: log } = setup(host, stopLock);
        held.s = s;
        const id = await register(s, repo);
        const response = await applyFile(s, id, await compare(s, id, "multi.txt", "unstaged"), "stage");
        const operationId = response.operationId!;
        checkOrder(runner, log, operationId, at.stop);
        const { token } = lockOf(log, operationId);
        expect(lockRemoves(log, operationId)).toEqual([{ lock: null, token, reply: [{ kind: "removed" }] }]);
        if (ending === "cancel") expect({ ...outcome(response), foreign: foreignOf(response) }).toEqual({ state: "canceled", code: "CANCELED", foreign: undefined });
        else expect({ ...outcome(response), cause: causeOf(s, operationId), remedy: remedyOf(response), foreign: foreignOf(response) }).toEqual({ state: "failed", code: "GIT_FAILED", cause: "lock-create", remedy: STEP_FAILED, foreign: undefined });
        expect({ lock: exists(host, lockPath(repo)), index: sha256(host, indexPath(repo)), files: workingDigests(repo), leftovers: ownedLeftovers(repo) }).toEqual({ lock: false, index, files, leftovers: [] });
      },
    );
  }

  for (const reply of ["time", "bound"] as const) {
    wslCase(
      reply === "time"
        ? `a candidate time above the canonical time gives GIT_FAILED with cause candidate-time, no Git step uses the candidate, the lock is removed, and the unverified candidate is foreign`
        : `a candidate reply bound gives OUTPUT_LIMIT with reason MUTATION_RAW_INDEX_BYTES, no Git step uses a candidate, and the lock is removed`,
      NEEDS,
      async (host) => {
        await underTest("file-publish");
        const { repo } = buildF21(host);
        const index = sha256(host, indexPath(repo));
        const fake: Stop = async (request, forward) => {
          if (request.mode !== "candidate") return forward();
          // Perl checks the size bound before it creates the candidate, so a `bound` reply leaves no candidate.
          if (reply === "bound") return [{ kind: "bound" }];
          const real = await forward();
          const first = Array.isArray(real) ? real[0] : undefined;
          if (first?.kind !== "candidate") return real;
          return [{ ...first, candidate: { ...first.candidate, mtime: (BigInt(first.index.mtime) + 1n).toString() } }];
        };
        const { s, files: log, indexFiles } = setup(host, fake);
        const id = await register(s, repo);
        const c = await compare(s, id, "multi.txt", "unstaged");
        const response = await applyFile(s, id, c, "stage");
        const operationId = response.operationId!;
        const [copy] = ofMode(log, operationId, "candidate");
        const name = copy?.request.mode === "candidate" ? copy.request.candidate : "";
        const { identity, token } = lockOf(log, operationId);
        expect(lockRemoves(log, operationId)).toEqual([{ lock: identity, token, reply: [{ kind: "removed" }] }]);
        expect(indexFiles.filter((f) => f.operationId === operationId)).toEqual([]);
        const result = { ...outcome(response), reason: (response.result as { reason?: string } | undefined)?.reason, cause: causeOf(s, operationId), remedy: remedyOf(response), foreign: foreignOf(response) };
        if (reply === "time") expect(result).toEqual({ state: "failed", code: "GIT_FAILED", reason: undefined, cause: "candidate-time", remedy: STEP_FAILED, foreign: [uncBeside(c.read, name)] });
        else expect({ ...result, cause: undefined, remedy: undefined }).toEqual({ state: "failed", code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES", cause: undefined, remedy: undefined, foreign: undefined });
        expect({ lock: exists(host, lockPath(repo)), index: sha256(host, indexPath(repo)), leftovers: ownedLeftovers(repo) }).toEqual({ lock: false, index, leftovers: reply === "time" ? [name] : [] });
      },
    );
  }

  wslCase(
    `a lock with another inode at the candidate request and a candidate reply bound: the lock form of remove gives notOwned, and the other lock stays`,
    NEEDS,
    async (host) => {
      await underTest("file-publish");
      const { repo } = buildF21(host);
      let lockInode = "";
      const swap: Stop = async (request, forward) => {
        if (request.mode !== "candidate") return forward();
        lockInode = inode(host, lockPath(repo));
        SWAPS["another inode"](repo);
        return [{ kind: "bound" }];
      };
      const { s, files: log } = setup(host, swap);
      const id = await register(s, repo);
      const c = await compare(s, id, "multi.txt", "unstaged");
      const response = await applyFile(s, id, c, "stage");
      const operationId = response.operationId!;
      const { identity, token } = lockOf(log, operationId);
      expect(lockRemoves(log, operationId)).toEqual([{ lock: identity, token, reply: [{ kind: "notOwned" }] }]);
      const lockAfter = exists(host, lockPath(repo)) ? inode(host, lockPath(repo)) : null;
      expect({ kept: lockAfter !== null, sameLock: lockAfter === lockInode, content: lockAfter === null ? null : content(host, lockPath(repo)) }).toEqual({ kept: true, sameLock: false, content: token });
      // Contract §8 "Observed locks": the other lock exists after the outcome, so the result names it.
      expect({ ...outcome(response), reason: (response.result as { reason?: string } | undefined)?.reason, foreign: foreignOf(response) }).toEqual({ state: "failed", code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES", foreign: [uncLock(c.read)] });
    },
  );

  wslCase(
    `a candidate changed before publish gives publish mismatch and STALE_SELECTION, nothing is published, and the lock form of remove gives removed`,
    NEEDS,
    async (host) => {
      await underTest("file-publish");
      const { repo } = buildF21(host);
      const index = { sha: sha256(host, indexPath(repo)), inode: inode(host, indexPath(repo)) };
      const change: Stop = async (request, forward) => {
        if (request.mode === "publish") writeLinux(host, `${repo.dir}/.git/${request.candidate}`, "changed candidate\n");
        return forward();
      };
      const { s, files: log } = setup(host, change);
      const id = await register(s, repo);
      const response = await applyFile(s, id, await compare(s, id, "multi.txt", "unstaged"), "stage");
      const operationId = response.operationId!;
      expect(ofMode(log, operationId, "publish").map((f) => f.reply)).toEqual([[{ kind: "mismatch" }]]);
      const { identity, token } = lockOf(log, operationId);
      expect(lockRemoves(log, operationId)).toEqual([{ lock: identity, token, reply: [{ kind: "removed" }] }]);
      expect({ ...outcome(response), lock: exists(host, lockPath(repo)), sha: sha256(host, indexPath(repo)), inode: inode(host, indexPath(repo)) }).toEqual({ state: "failed", code: "STALE_SELECTION", lock: false, ...index });
    },
  );

  wslCase(
    `a publish reply error is a failed replace step: after the process-end fact, indexDigest shows the before digest, the lock form of remove gives removed, and the outcome is GIT_FAILED with the step remedy`,
    NEEDS,
    async (host) => {
      await underTest("file-publish");
      const { repo } = buildF21(host);
      const index = sha256(host, indexPath(repo));
      const at = { stop: Number.POSITIVE_INFINITY };
      const fail: Stop = async (request, forward) => {
        if (request.mode !== "publish") return forward();
        at.stop = performance.now();
        return [{ kind: "error", component: 0, code: "io-error" }];
      };
      const { runner, s, files: log } = setup(host, fail);
      const id = await register(s, repo);
      const response = await applyFile(s, id, await compare(s, id, "multi.txt", "unstaged"), "stage");
      const operationId = response.operationId!;
      const { decisions } = checkOrder(runner, log, operationId, at.stop);
      expect(decisions.map((f) => f.request.mode)).toContain("indexDigest");
      const { identity, token } = lockOf(log, operationId);
      expect(lockRemoves(log, operationId)).toEqual([{ lock: identity, token, reply: [{ kind: "removed" }] }]);
      expect({ ...outcome(response), cause: causeOf(s, operationId), remedy: remedyOf(response), foreign: foreignOf(response) }).toEqual({ state: "failed", code: "GIT_FAILED", cause: "replace", remedy: STEP_FAILED, foreign: undefined });
      expect({ lock: exists(host, lockPath(repo)), index: sha256(host, indexPath(repo)), leftovers: ownedLeftovers(repo) }).toEqual({ lock: false, index, leftovers: [] });
    },
  );

  wslCase(
    `a closeJob during publish gives unknown with the lock and the candidate in foreign and keeps the marker; a refresh then states indexMatch not-published with the lock and the candidate in foreign, sends resolved, and removes nothing`,
    NEEDS,
    async (host) => {
      await underTest("file-publish", "recovery");
      const { repo } = buildF21(host);
      const index = sha256(host, indexPath(repo));
      const held: { runner: BunRunner | null } = { runner: null };
      // A `closeJob` stops the walk before Perl runs and makes the operation ID inactive (contract §6 "Channel frames").
      const close: Stop = async (request, forward) => {
        if (request.mode !== "publish") return forward();
        held.runner!.closeJob(request.operationId);
        return { stop: "canceled" };
      };
      const { runner, s, files: log } = setup(host, close);
      held.runner = runner;
      const id = await register(s, repo);
      const c = await compare(s, id, "multi.txt", "unstaged");
      const response = await applyFile(s, id, c, "stage");
      const operationId = response.operationId!;
      const [copy] = ofMode(log, operationId, "candidate");
      const name = copy?.request.mode === "candidate" ? copy.request.candidate : "";
      const { token } = lockOf(log, operationId);
      const markerId = runner.frames.find((f) => f.type === "started" && f.operationId === operationId)?.markerId;
      const resolvedFrames = () => runner.frames.filter((f) => f.type === "resolved" && f.markerId === markerId).length;
      expect({ ...outcome(response), foreign: [...(foreignOf(response) ?? [])].sort(), resolved: resolvedFrames(), removes: ofMode(log, operationId, "remove") }).toEqual({
        state: "unknown",
        code: "STATE_UNKNOWN",
        foreign: [uncLock(c.read), uncBeside(c.read, name)].sort(),
        resolved: 0,
        removes: [],
      });
      const kept = { lock: content(host, lockPath(repo)), leftovers: ownedLeftovers(repo).sort(), index: sha256(host, indexPath(repo)) };
      expect(kept).toEqual({ lock: token, leftovers: ["index.lock", name].sort(), index });
      const refreshed = await s.response(s.request("readWorkspace", { refresh: true, check: "full" }, { repositoryId: id }));
      expect({ ...outcome(refreshed), recovery: (refreshed.result as { recovery?: unknown } | undefined)?.recovery, resolved: resolvedFrames() }).toEqual({
        ...SUCCEEDED,
        recovery: { outcome: "unknown", indexMatch: "not-published", foreign: [uncLock(c.read), uncBeside(c.read, name)] },
        resolved: 1,
      });
      expect({ lock: content(host, lockPath(repo)), leftovers: ownedLeftovers(repo).sort(), index: sha256(host, indexPath(repo)) }).toEqual(kept);
    },
  );

  wslCase(
    `a working-file change after the comparison gives applyHunk STALE_SELECTION, the external bytes stay, and nothing is published`,
    NEEDS,
    async (host) => {
      await underTest("hunk-publish");
      const { repo } = buildF21(host);
      const index = sha256(host, indexPath(repo));
      const external = "external change\n";
      const write: Stop = async (request, forward) => {
        const reply = await forward();
        if (request.mode === "lock") writeLinux(host, `${repo.dir}/multi.txt`, external);
        return reply;
      };
      const { s } = setup(host, write);
      const id = await register(s, repo);
      const response = await applyHunk(s, id, await compare(s, id, "multi.txt", "unstaged"), "stage");
      expect({ ...outcome(response), index: sha256(host, indexPath(repo)), file: content(host, `${repo.dir}/multi.txt`), leftovers: ownedLeftovers(repo) }).toEqual({ state: "failed", code: "STALE_SELECTION", index, file: external, leftovers: [] });
    },
  );
});

describe("WSL repository state and processes (contract §4, §6 \"Lingering Jobs\", §9)", () => {
  wslCase(
    `no step reads working-file or index bytes through UNC while the index digest is unchanged`,
    NEEDS,
    async (host) => {
      await underTest("hunk-publish", "file-publish");
      const { repo } = buildF21(host);
      const { s, seam } = setup(host);
      const id = await register(s, repo);
      for (const [op, path, category] of [["applyHunk", "multi.txt", "unstaged"], ["applyFile", "other-a.txt", "staged"]] as const) {
        const c = await compare(s, id, path, category);
        const reads = seam.rawReads;
        const { value, calls } = await withFsCalls(() => (op === "applyHunk" ? applyHunk(s, id, c, "stage") : applyFile(s, id, c, "unstage")));
        // The §4 `link` check reads the candidate through UNC.
        const opens = calls.filter((call) => call.name === "open" && call.path.startsWith("\\\\") && !win32.basename(call.path).startsWith(CANDIDATE_PREFIX));
        expect({ op, ...outcome(value), opens, rawReads: seam.rawReads - reads }).toEqual({ op, ...SUCCEEDED, opens: [], rawReads: 0 });
      }
    },
  );

  wslCase(
    `a held index.lock gives LOCKED for applyFile and applyHunk, and the lock keeps its bytes`,
    NEEDS,
    async (host) => {
      await underTest("hunk-publish", "file-publish");
      const { repo } = buildF21(host);
      writeLinux(host, lockPath(repo), "foreign lock\n");
      const index = sha256(host, indexPath(repo));
      const { s } = setup(host);
      const id = await register(s, repo);
      const c = await compare(s, id, "multi.txt", "unstaged");
      for (const response of [await applyFile(s, id, c, "stage"), await applyHunk(s, id, await compare(s, id, "multi.txt", "unstaged"), "stage")]) {
        expect({ code: response.code, path: pathOf(response), lock: content(host, lockPath(repo)), index: sha256(host, indexPath(repo)) }).toEqual({ code: "LOCKED", path: uncLock(c.read), lock: "foreign lock\n", index });
      }
    },
  );

  wslCase(
    `a post-commit hook's setsid child gives lingeringDescendants 1 from the anchor`,
    NEEDS,
    async (host) => {
      await underTest("commit");
      const { repo } = buildF21(host);
      writeLinux(host, `${repo.dir}/.git/hooks/post-commit`, `#!/bin/sh\n'${host.probe.paths.setsid}' /usr/bin/sleep 60 >/dev/null 2>&1 &\nexit 0\n`, "755");
      const { runner, directory, s } = setup(host);
      const id = await register(s, repo);
      await approve(s, id);
      const response = await commit(s, id, "T213 lingering\n");
      expect({ ...outcome(response), lingering: one<number>(response.result, "lingeringDescendants") }).toEqual({ ...SUCCEEDED, lingering: 1 });
      // No `wsl.exe` or `wslhost.exe` of the double has the launch folder as its current directory.
      runners = runners.filter((r) => r !== runner);
      await runner.dispose();
      rmdirSync(join(directory, "launch"));
    },
  );

  wslCase(
    `the launch folder can move while a WSL commit hook runs`,
    NEEDS,
    async (host) => {
      await underTest("commit");
      const { repo } = buildF21(host);
      const started = `${repo.dir}/.git/arbareto-hook-started`;
      writeLinux(host, `${repo.dir}/.git/hooks/pre-commit`, `#!/bin/sh\n: > '${started}'\n/usr/bin/sleep 20\nexit 0\n`, "755");
      const { directory, s } = setup(host);
      const id = await register(s, repo);
      await approve(s, id);
      const response = commit(s, id, "T117 launch folder\n");
      for (const until = performance.now() + HOOK_START_MS; !existsSync(uncPath(host, started)); await Bun.sleep(100)) {
        if (performance.now() > until) throw new Error(`the pre-commit hook did not start within ${HOOK_START_MS} ms`);
      }
      // Windows refuses to rename a folder that a live process has as its current directory.
      const launch = join(directory, "launch");
      renameSync(launch, `${launch}-moved`);
      renameSync(`${launch}-moved`, launch);
      expect(outcome(await response)).toEqual(SUCCEEDED);
    },
  );

  const shell = Bun.which("pwsh") ?? Bun.which("powershell");
  wslCase(
    `each WSL remedy command, run in PowerShell, gives the index of the distro's own command in a copy`,
    NEEDS,
    async (host) => {
      await underTest("file-publish");
      const { repo } = buildF21(host);
      const git = host.probe.paths.git!;
      // A filtered Unstaged file gets the add form, and a staged type change gets the restore --staged form (contract §4 "Limitation remedies", §11 "Remedy commands").
      writeLinux(host, `${repo.dir}/.gitattributes`, "*.cf filter=custom\n");
      writeLinux(host, `${repo.dir}/custom.cf`, "custom\n");
      writeLinux(host, `${repo.dir}/type.txt`, "type\n");
      distroGit(repo, ["-c", "filter.custom.clean=cat", "--literal-pathspecs", "add", "--", ".gitattributes", "custom.cf", "type.txt"]);
      distroGit(repo, ["-c", "filter.custom.clean=cat", "commit", "-q", "--no-verify", "-m", "remedies"]);
      distroGit(repo, ["config", "filter.custom.clean", "cat"]);
      writeLinux(host, `${repo.dir}/custom.cf`, "custom changed\n");
      const link = distroGit(repo, ["hash-object", "-w", "--stdin"], { input: Buffer.from("custom.cf") }).trim();
      distroGit(repo, ["update-index", "-z", "--index-info"], { input: Buffer.from(`120000 ${link} 0\ttype.txt\0`) });
      const oracle = copyOf(repo, "oracle");
      distroGit(oracle, ["--literal-pathspecs", "add", "--", "custom.cf"]);
      distroGit(oracle, ["--literal-pathspecs", "restore", "--staged", "--", "type.txt"]);
      const { s } = setup(host);
      const id = await register(s, repo);
      await approve(s, id);
      const head = `& ${psQuote(WSL_EXE)} --distribution ${psQuote(host.distro)} --cd / --exec ${psQuote(git)} --literal-pathspecs -C ${psQuote(repo.dir)}`;
      const commands: string[] = [];
      for (const [path, category, direction, reason, form] of [
        ["custom.cf", "unstaged", "stage", "filter", "add --"],
        ["type.txt", "staged", "unstage", "type", "restore --staged --"],
      ] as const) {
        const response = await applyFile(s, id, await compare(s, id, path, category), direction);
        const result = response.result as { reason?: string; remedy?: { text: string; command: string | null } } | undefined;
        expect({ path, code: response.code, reason: result?.reason, remedy: result?.remedy }).toEqual({ path, code: "UNSUPPORTED_COMPARISON", reason, remedy: { text: REMEDY_TEXT, command: `${head} ${form} ${psQuote(path)}` } });
        commands.push(result!.remedy!.command!);
      }
      for (const command of commands) {
        const proc = Bun.spawnSync([shell!, "-NoProfile", "-Command", command], { cwd: fixtureDir("t213-remedy-cwd"), env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        expect({ command, exit: proc.exitCode }).toEqual({ command, exit: 0 });
      }
      expect(stagedIndex(repo)).toBe(stagedIndex(oracle));
    },
    { capability: "powershell", present: shell !== null },
  );
});
