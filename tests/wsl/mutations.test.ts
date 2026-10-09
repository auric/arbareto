// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T213: WSL mutations with F21 copies (contract §4 "WSL index publication", "Process end", §6 "WSL file work", §11).
// The T214 routes of `hunk-publish.ts`, `file-publish.ts`, and `commit.ts` come with T214. The oracle is the distro Git in a disposable copy.

import { afterEach, describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import type { WslFileResult, WslFilesCall } from "../../src/contracts/channel";
import type { WalkStop } from "../../src/git-service/git-runner";
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
const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"];
const HUNK = "(needs T214/T115)";
const FILE = "(needs T214/T115)";
const COMMIT = "(needs T112/T214/T115)";
const BOTH = "(needs T214/T115)";
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

type Module = "hunk-publish" | "file-publish" | "commit";
// Prints the ORIGIN line of each module under test and loads it. Before its task, a module is missing, and this throws.
async function underTest(...modules: Module[]): Promise<void> {
  for (const module of modules) {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
    await import(`../../src/git-service/${module}.ts`);
  }
}

// A todo case of a module that does not exist yet. A missing capability skips it and names the capability, as `wslTest` does.
function wslTodo(name: string, needs: readonly WslCapability[], body: (host: WslHost) => Promise<void>, extra: { capability: string; present: boolean } | null = null): void {
  const missing = missingCapability(needs) ?? (extra !== null && !extra.present ? extra.capability : null);
  if (missing !== null) {
    console.log(`SKIP ${missing}: ${name}`);
    test.skip(`${name} (SKIP: ${missing})`, () => {});
    return;
  }
  test.todo(name, () => body(wslHost()!), CASE_TIMEOUT_MS);
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
  const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment: serviceEnv(), wslGlobalConfig: globalConfig(host) });
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
  return { runner, s, files, seam, indexFiles };
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
  expect(response.state).toBe("succeeded");
  return response.result as unknown as Read;
}

async function approve(s: WslSession, repositoryId: string): Promise<void> {
  const trust = await s.response(s.request("readTrust", {}, { repositoryId }));
  const { fingerprint, generation } = trust.result as { fingerprint: string; generation: number };
  expect(await s.response(s.request("approveTrust", { fingerprint, approve: true }, { repositoryId, repositoryGeneration: generation }))).toMatchObject({ state: "succeeded" });
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
// The owned files that remain in the Git directory (contract §8: `index.lock` and the `arbareto-candidate-` prefix).
const ownedLeftovers = (r: WslRepo) =>
  inDistro(r.host.distro, ["/usr/bin/ls", "-A", "--", `${r.dir}/.git`])
    .split("\n")
    .filter((n) => n === "index.lock" || n.startsWith("arbareto-candidate-"));

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
  wslTodo(
    `applyHunk stages as git add -p does in a copy; the lock, candidate, and publication run through wslFiles, and working files stay ${HUNK}`,
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
    wslTodo(
      `applyFile ${direction} of ${path} equals git ${command[1]} in a copy; the lock, candidate, and publication run through wslFiles, and working files stay ${FILE}`,
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

  wslTodo(
    `commit gives the tree, parent, and message of git commit in a copy, and the pre-commit hook runs as the Linux user ${COMMIT}`,
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
      expect({ commit: commitFacts(repo), index: stagedIndex(repo), files: workingDigests(repo) }).toEqual({ commit: commitFacts(oracle), index: stagedIndex(oracle), files });
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
    wslTodo(
      `core.sharedRepository at ${scope} scope makes readWorkspace report shared-repository and refuses applyHunk and applyFile with UNSUPPORTED_HUNK_PROFILE; the index keeps its bytes, no owned lock or candidate remains, and no config process starts; without the key, the same request publishes ${BOTH}`,
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

  for (const after of [true, false]) {
    wslTodo(
      after
        ? `a deadline after Perl created and wrote the lock: no remove or indexDigest decision comes before the process-end fact, and remove with the token then gives removed ${FILE}`
        : `a deadline before the lock create: after the process-end fact, remove with the token gives notOwned ${FILE}`,
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
        console.log(`OBSERVATION ${TASK}: lock walk stopped ${after ? "after" : "before"} the create: outcome ${response.state} ${response.code ?? ""}`);
      },
    );
  }

  wslTodo(
    `a publish walk stopped by a deadline after the rename is decided from indexDigest after the process-end fact, and the index equals git add in a copy ${FILE}`,
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
      console.log(`OBSERVATION ${TASK}: publish walk stopped after the rename: outcome ${response.state} ${response.code ?? ""}`);
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
    wslTodo(
      `a lock with ${swap} gives publish notOwned with no rename ${FILE}`,
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
        const response = await applyFile(s, id, await compare(s, id, "multi.txt", "unstaged"), "stage");
        const publish = log.filter((f) => f.request.operationId === response.operationId && f.request.mode === "publish");
        expect(publish.map((f) => f.reply)).toEqual([[{ kind: "notOwned" }]]);
        expect({ sha: sha256(host, indexPath(repo)), inode: inode(host, indexPath(repo)) }).toEqual(index);
        // `remove` with the `lock` reply checks the device and inode, so a copy at another inode stays. The original inode never returns.
        const lockAfter = exists(host, lockPath(repo)) ? inode(host, lockPath(repo)) : null;
        expect({ swap, sameLock: lockAfter === lockInode }).toEqual({ swap, sameLock: swap !== "another inode" });
        expect({ swap, state: response.state, code: response.code }).toEqual({ swap, state: "failed", code: "STALE_SELECTION" });
        console.log(`OBSERVATION ${TASK}: publish with ${swap}: lock after ${lockAfter === null ? "absent" : lockAfter === lockInode ? "kept" : "other inode"}`);
      },
    );
  }
});

describe("WSL repository state and processes (contract §4, §6 \"Lingering Jobs\", §9)", () => {
  wslTodo(
    `no step reads working-file or index bytes through UNC while the index digest is unchanged ${BOTH}`,
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
        expect({ op, ...outcome(value), opens: calls.filter((call) => call.name === "open" && call.path.startsWith("\\\\")), rawReads: seam.rawReads - reads }).toEqual({ op, ...SUCCEEDED, opens: [], rawReads: 0 });
      }
    },
  );

  wslTodo(
    `a held index.lock gives LOCKED for applyFile and applyHunk, and the lock keeps its bytes ${BOTH}`,
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
        expect({ code: response.code, lock: content(host, lockPath(repo)), index: sha256(host, indexPath(repo)) }).toEqual({ code: "LOCKED", lock: "foreign lock\n", index });
        console.log(`OBSERVATION ${TASK}: LOCKED path ${JSON.stringify(valuesOf(response.result, "path"))}`);
      }
    },
  );

  wslTodo(
    `a post-commit hook's setsid child gives lingeringDescendants 1 from the anchor ${COMMIT}`,
    NEEDS,
    async (host) => {
      await underTest("commit");
      const { repo } = buildF21(host);
      writeLinux(host, `${repo.dir}/.git/hooks/post-commit`, `#!/bin/sh\n'${host.probe.paths.setsid}' /usr/bin/sleep 60 >/dev/null 2>&1 &\nexit 0\n`, "755");
      const { s } = setup(host);
      const id = await register(s, repo);
      await approve(s, id);
      const response = await commit(s, id, "T213 lingering\n");
      expect({ ...outcome(response), lingering: one<number>(response.result, "lingeringDescendants") }).toEqual({ ...SUCCEEDED, lingering: 1 });
    },
  );

  const shell = Bun.which("pwsh") ?? Bun.which("powershell");
  wslTodo(
    `each WSL remedy command, run in PowerShell, gives the index of the distro's own command in a copy ${FILE}`,
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
