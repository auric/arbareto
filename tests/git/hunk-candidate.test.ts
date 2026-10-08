// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T109: research R3 steps 6 to 10, contract §4 "Candidate time", "Split index", and "Hunk eligibility and publication".
// The canonical index stays byte-identical in every case (tests/git/git-oracle.ts). Git's own `add -p` and `reset -p` give the expected candidate.

import { describe, expect } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { MUTATION_RAW_INDEX_BYTES } from "../../src/contracts/limits";
import type { GitInstallation } from "../../src/git-service/git-installation";
import { applyCachedArgs, readTreeEmptyArgs } from "../../src/git-service/commands";
import { parsePatch, type PatchHunk } from "../../src/git-service/diff-parser";
import type { GitRunner } from "../../src/git-service/git-runner";
import { prepareCandidate } from "../../src/git-service/hunk-candidate";
import { createIndexLock } from "../../src/git-service/index-lock";
import { createRegistrations } from "../../src/git-service/registration";
import { printOrigin } from "../origin";
import { createBunRunner } from "./bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF01, buildF02, buildF10, put } from "./fixtures";
import { indexEntries, sha256 } from "./git-oracle";
import { candidateFiles, copyRepo, git, gitPath, gitPathOf, gitText, oraclePatch, repoOf, repoState, scriptedPatch, TIMEOUT_MS } from "./hunk-harness";
import { caseTest } from "./service-harness";

printOrigin("../../src/git-service/hunk-candidate.ts", import.meta.dir);
type Target = Parameters<typeof prepareCandidate>[0];

const TASK = "T109";
useFixtureRoot();

const ZERO = "0".repeat(40);

// A workspace that the shell double registers, as `discovery.test.ts` does.
async function registered(name: string, repo: string) {
  const g = gitPath();
  const runner = createBunRunner({ git: g, directory: fixtureDir(`${name}-runner`), environment: serviceEnv() });
  const gitInstallationId = crypto.randomUUID();
  await runner.register({ operationId: crypto.randomUUID(), bootstrapId: runner.addContext("gitProbe", g), gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false });
  const installation: GitInstallation = {
    gitInstallationId,
    selectedPath: g,
    executablePath: g,
    version: "2.55.0",
    admission: "admitted",
    executableIdentity: { file: { volumeSerial: "0".repeat(16), fileId: "0".repeat(31) + "1" }, versionOutput: "2.55.0", digest: "c".repeat(64) },
  };
  const registrations = createRegistrations({ runner, unfinishedMutation: () => false });
  const done = await registrations.register({ operationId: crypto.randomUUID(), bootstrapId: runner.addContext("repositoryDiscovery", repo), installation, signal: new AbortController().signal });
  if (!done.ok || !("repositoryId" in done.result)) throw new Error(`registration failed: ${JSON.stringify(done)}`);
  return { runner, workspace: registrations.get(done.result.repositoryId)! };
}

// The mode and object of `path` in HEAD and in the index, as a status record names them.
function sides(repo: string, path: string) {
  const head = gitText(repo, ["ls-tree", "HEAD", "--", path], {}).trim();
  const index = gitText(repo, ["ls-files", "-s", "--", path]).trim();
  const h = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(head);
  const i = /^(\d{6}) ([0-9a-f]+) 0\t/.exec(index);
  return { modes: [h?.[1] ?? "000000", i?.[1] ?? "000000", "100644"], oids: [h?.[2] ?? ZERO, i?.[2] ?? ZERO] };
}

type Scope = Target["comparison"]["scope"];

// The retained comparison input of one entry: the canonical patch, the entry, and its parsed hunks.
function selection(repo: string, path: string, scope: Scope) {
  const pathBytes = new TextEncoder().encode(path);
  const patch =
    scope === "empty-to-untracked"
      ? git(repo, ["--no-optional-locks", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", path], { allowExit: [1] })
      : oraclePatch(repo, path, scope);
  const parsed = parsePatch(new Uint8Array(patch), pathBytes);
  if (!parsed.ok) throw new Error(`patch: ${JSON.stringify(parsed.completeness)}`);
  const category: ChangeEntry["category"] = scope === "head-to-index" ? "staged" : scope === "empty-to-untracked" ? "untracked" : "unstaged";
  const entry = { entryId: crypto.randomUUID(), category, path, pathBytes: Buffer.from(pathBytes).toString("base64"), ...(scope === "empty-to-untracked" ? {} : sides(repo, path)) } as ChangeEntry;
  return { comparison: { entry, scope, patch: new Uint8Array(patch) }, hunks: parsed.patch.hunks };
}

// `wrap` replaces the `run` of the shell double. It is a test seam of this file only.
type Run = GitRunner["run"];
async function prepare(name: string, repo: string, path: string, scope: Scope, pick: (hunks: PatchHunk[]) => PatchHunk, extra: Partial<Target> = {}, wrap?: (run: Run) => Run) {
  const registration = await registered(name, repo);
  const runner = wrap ? { ...registration.runner, run: wrap(registration.runner.run) } : registration.runner;
  const { workspace } = registration;
  try {
    const { comparison, hunks } = selection(repo, path, scope);
    const rawIndexDigest = repoState(repo).rawIndex;
    return await prepareCandidate({ runner, operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace, rawIndexDigest, comparison, hunk: pick(hunks), ...extra });
  } finally {
    await registration.runner.dispose();
  }
}

// The oracle entries of candidate bytes: a copy of the repository reads them as its index.
function candidateEntries(repo: string, name: string, bytes: Uint8Array) {
  const copy = copyRepo(repo, name);
  writeFileSync(gitPathOf(copy, "index"), Buffer.from(bytes));
  return indexEntries(gitPath(), copy);
}

function okCandidate(outcome: Awaited<ReturnType<typeof prepareCandidate>>, repo: string) {
  if (!outcome.ok) throw new Error(`candidate refused: ${JSON.stringify(outcome, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
  const c = outcome.candidate;
  expect(dirname(c.path)).toBe(dirname(gitPathOf(repo, "index")));
  expect(candidateFiles(repo)).toEqual([basename(c.path)]);
  expect(sha256(new Uint8Array(readFileSync(c.path)))).toBe(c.digest);
  expect(c.digest).toBe(sha256(c.bytes));
  return c;
}

describe("hunk candidate (T109)", () => {
  caseTest(
    TASK,
    "stage: the candidate holds the selected hunk exactly as git add -p stages it, and the canonical index stays",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-stage"));
      const before = repoState(repo);
      const c = okCandidate(await prepare("t109-stage", repo, "multi.txt", "index-to-worktree", (h) => h[1]!), repo);
      expect(repoState(repo)).toEqual(before);
      const oracle = scriptedPatch(repo, "t109-stage-oracle", "add", "multi.txt", ["n", "y"]);
      expect(candidateEntries(repo, "t109-stage-copy", c.bytes)).toEqual(indexEntries(gitPath(), oracle));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "unstage: the candidate reverses the selected staged hunk exactly as git reset -p does",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-unstage", "staged-hunks"));
      const before = repoState(repo);
      const c = okCandidate(await prepare("t109-unstage", repo, "multi.txt", "head-to-index", (h) => h[0]!), repo);
      expect(repoState(repo)).toEqual(before);
      const oracle = scriptedPatch(repo, "t109-unstage-oracle", "reset", "multi.txt", ["y", "n"]);
      expect(candidateEntries(repo, "t109-unstage-copy", c.bytes)).toEqual(indexEntries(gitPath(), oracle));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "index version 4: the prefix-compressed names give the same exact entry checks",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-v4"));
      git(repo, ["update-index", "--index-version", "4"]);
      expect(readFileSync(gitPathOf(repo, "index")).readUInt32BE(4)).toBe(4);
      const before = repoState(repo);
      const c = okCandidate(await prepare("t109-v4", repo, "multi.txt", "index-to-worktree", (h) => h[1]!), repo);
      expect(repoState(repo)).toEqual(before);
      const oracle = scriptedPatch(repo, "t109-v4-oracle", "add", "multi.txt", ["n", "y"]);
      expect(candidateEntries(repo, "t109-v4-copy", c.bytes)).toEqual(indexEntries(gitPath(), oracle));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a line without a final LF keeps its form on both sides of the hunk",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-tail"));
      put(repo, "tail.txt", "a\nb");
      git(repo, ["add", "--", "tail.txt"]);
      put(repo, "tail.txt", "a\nc");
      const before = repoState(repo);
      const c = okCandidate(await prepare("t109-tail", repo, "tail.txt", "index-to-worktree", (h) => h[0]!), repo);
      expect(repoState(repo)).toEqual(before);
      const oracle = scriptedPatch(repo, "t109-tail-oracle", "add", "tail.txt", ["y"]);
      expect(candidateEntries(repo, "t109-tail-copy", c.bytes)).toEqual(indexEntries(gitPath(), oracle));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "untracked: the candidate adds the new entry as git add does",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-untracked"));
      put(repo, "new.txt", "one\ntwo\n");
      const before = repoState(repo);
      const c = okCandidate(await prepare("t109-untracked", repo, "new.txt", "empty-to-untracked", (h) => h[0]!), repo);
      expect(repoState(repo)).toEqual(before);
      const oracle = copyRepo(repo, "t109-untracked-oracle");
      git(oracle, ["add", "--", "new.txt"]);
      expect(candidateEntries(repo, "t109-untracked-copy", c.bytes)).toEqual(indexEntries(gitPath(), oracle));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an absent index: Git creates the candidate through read-tree --empty, and no canonical index appears",
    [],
    async () => {
      const repo = repoOf(buildF01(gitPath(), "t109-absent", "empty"));
      put(repo, "first.txt", "first\n");
      const before = repoState(repo);
      expect(before.rawIndex).toBeNull();
      const c = okCandidate(await prepare("t109-absent", repo, "first.txt", "empty-to-untracked", (h) => h[0]!), repo);
      expect(repoState(repo)).toEqual(before);
      expect(existsSync(gitPathOf(repo, "index"))).toBe(false);
      const oracle = copyRepo(repo, "t109-absent-oracle");
      git(oracle, ["add", "--", "first.txt"]);
      expect(candidateEntries(repo, "t109-absent-copy", c.bytes)).toEqual(indexEntries(gitPath(), oracle));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "unrelated entries keep their intent-to-add, assume-unchanged, and skip-worktree flags",
    [],
    async () => {
      const repo = repoOf(buildF10(gitPath(), "t109-flags", "flags"));
      put(repo, "plain.txt", "a\nb\nc\n");
      git(repo, ["add", "--", "plain.txt"]);
      put(repo, "plain.txt", "a\nB\nc\n");
      const before = repoState(repo);
      const c = okCandidate(await prepare("t109-flags", repo, "plain.txt", "index-to-worktree", (h) => h[0]!), repo);
      expect(repoState(repo)).toEqual(before);
      const entries = candidateEntries(repo, "t109-flags-copy", c.bytes);
      expect(entries.filter((e) => e.path !== "plain.txt")).toEqual(before.entries.filter((e) => e.path !== "plain.txt"));
      expect(entries.filter((e) => e.intentToAdd || e.assumeUnchanged || e.skipWorktree).map((e) => e.path).sort()).toEqual(["conflict.txt", "ita.txt", "keep.txt"]);
      const oracle = scriptedPatch(repo, "t109-flags-oracle", "add", "plain.txt", ["y"]);
      expect(entries).toEqual(indexEntries(gitPath(), oracle));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "candidate time: a racily clean entry stays racy in the candidate, so Git still sees its change",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-racy", "racy"));
      const before = repoState(repo);
      const c = okCandidate(await prepare("t109-racy", repo, "multi.txt", "index-to-worktree", (h) => h[0]!), repo);
      expect(repoState(repo)).toEqual(before);
      const changed = gitText(repo, ["--no-optional-locks", "diff-files", "--name-only"], { env: { GIT_INDEX_FILE: c.path } }).split("\n");
      expect(changed).toContain("racy.txt");
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a candidate time later than the set time refuses before any Git step",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-time"));
      const before = repoState(repo);
      const late = (path: string) => utimesSync(path, new Date(Date.now() + 3_600_000), new Date(Date.now() + 3_600_000));
      const outcome = await prepare("t109-time", repo, "multi.txt", "index-to-worktree", (h) => h[0]!, { afterCandidateTime: late });
      expect(outcome).toMatchObject({ ok: false, failure: { reason: "candidate-time" } });
      expect(repoState(repo)).toEqual(before);
      // The refused candidate still holds the canonical bytes. No Git step ran on it.
      if (outcome.ok || outcome.path === null) throw new Error("no candidate path");
      expect(sha256(new Uint8Array(readFileSync(outcome.path)))).toBe(before.rawIndex!);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a split index refuses with reason split-index",
    [],
    async () => {
      const repo = repoOf(buildF10(gitPath(), "t109-split", "split-index"));
      put(repo, "keep.txt", "keep\nmore\n");
      const before = repoState(repo);
      const outcome = await prepare("t109-split", repo, "keep.txt", "index-to-worktree", (h) => h[0]!);
      expect(outcome).toMatchObject({ ok: false, failure: { reason: "split-index" } });
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an index that differs from the captured digest refuses, and no candidate exists",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-changed"));
      const before = repoState(repo);
      const outcome = await prepare("t109-changed", repo, "multi.txt", "index-to-worktree", (h) => h[0]!, { rawIndexDigest: "f".repeat(64) });
      expect(outcome).toEqual({ ok: false, path: null, failure: { reason: "index-changed" } });
      expect(candidateFiles(repo)).toEqual([]);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a hunk that does not fit the captured index blob fails the verification",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-verify"));
      const before = repoState(repo);
      const { runner, workspace } = await registered("t109-verify", repo);
      try {
        const { comparison, hunks } = selection(repo, "multi.txt", "index-to-worktree");
        // The captured entry names the blob of another path, so the expected content cannot come from the patch.
        const other = sides(repo, "keep.txt");
        const entry = { ...comparison.entry, oids: [comparison.entry.oids![0]!, other.oids[1]!] };
        const outcome = await prepareCandidate({ runner, operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace, rawIndexDigest: before.rawIndex, comparison: { ...comparison, entry }, hunk: hunks[0]! });
        expect(outcome).toMatchObject({ ok: false, failure: { reason: "verification", detail: "content" } });
      } finally {
        await runner.dispose();
      }
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a canceled request starts no Git step and creates no candidate",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-cancel"));
      const before = repoState(repo);
      const abort = new AbortController();
      abort.abort();
      const outcome = await prepare("t109-cancel", repo, "multi.txt", "index-to-worktree", (h) => h[0]!, { signal: abort.signal });
      expect(outcome).toEqual({ ok: false, path: null, failure: { reason: "canceled" } });
      expect(candidateFiles(repo)).toEqual([]);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a selected entry with another mode than the expected one fails the verification with selected-entry",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-selected"));
      const before = repoState(repo);
      const { runner, workspace } = await registered("t109-selected", repo);
      try {
        const { comparison, hunks } = selection(repo, "multi.txt", "index-to-worktree");
        // The captured index side names mode 100755 with the right blob. Git keeps 100644, so only the mode differs.
        const modes = [...comparison.entry.modes!];
        modes[1] = "100755";
        const entry = { ...comparison.entry, modes } as ChangeEntry;
        const outcome = await prepareCandidate({ runner, operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace, rawIndexDigest: before.rawIndex, comparison: { ...comparison, entry }, hunk: hunks[1]! });
        expect(outcome).toMatchObject({ ok: false, failure: { reason: "verification", detail: "selected-entry" } });
      } finally {
        await runner.dispose();
      }
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an unrelated entry that changes in the candidate fails the verification with unrelated-entries",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-unrelated"));
      const before = repoState(repo);
      // After the apply step, another writer sets the executable bit of keep.txt in the candidate.
      const wrap =
        (run: Run): Run =>
        async (call) => {
          const exit = await run(call);
          if (Bun.deepEquals(call.arguments, applyCachedArgs())) git(repo, ["update-index", "--chmod=+x", "--", "keep.txt"], { env: { GIT_INDEX_FILE: call.transaction!.indexFile } });
          return exit;
        };
      const outcome = await prepare("t109-unrelated", repo, "multi.txt", "index-to-worktree", (h) => h[1]!, {}, wrap);
      expect(outcome).toMatchObject({ ok: false, failure: { reason: "verification", detail: "unrelated-entries" } });
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a captured index blob that the object store lacks gives object-missing, not malformed",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-missing"));
      const before = repoState(repo);
      const { runner, workspace } = await registered("t109-missing", repo);
      try {
        const { comparison, hunks } = selection(repo, "multi.txt", "index-to-worktree");
        // `cat-file` answers `<oid> missing` for an object ID that no object has.
        const entry = { ...comparison.entry, oids: [comparison.entry.oids![0]!, "1".repeat(40)] } as ChangeEntry;
        const outcome = await prepareCandidate({ runner, operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace, rawIndexDigest: before.rawIndex, comparison: { ...comparison, entry }, hunk: hunks[1]! });
        expect(outcome).toMatchObject({ ok: false, failure: { reason: "object-missing" } });
      } finally {
        await runner.dispose();
      }
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a canonical index above MUTATION_RAW_INDEX_BYTES gives bound, and no candidate exists",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-bound"));
      const { runner, workspace } = await registered("t109-bound", repo);
      try {
        const { comparison, hunks } = selection(repo, "multi.txt", "index-to-worktree");
        const rawIndexDigest = repoState(repo).rawIndex;
        writeFileSync(gitPathOf(repo, "index"), new Uint8Array(MUTATION_RAW_INDEX_BYTES + 1));
        const outcome = await prepareCandidate({ runner, operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace, rawIndexDigest, comparison, hunk: hunks[0]! });
        expect(outcome).toEqual({ ok: false, path: null, failure: { reason: "bound" } });
        expect(candidateFiles(repo)).toEqual([]);
      } finally {
        await runner.dispose();
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an error after the candidate exists returns its path with reason unavailable",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-leak"));
      const before = repoState(repo);
      const wrap = (): Run => async () => {
        throw new Error("channel closed");
      };
      const outcome = await prepare("t109-leak", repo, "multi.txt", "index-to-worktree", (h) => h[0]!, {}, wrap);
      if (outcome.ok) throw new Error("candidate accepted");
      expect(outcome.failure).toEqual({ reason: "unavailable", errno: "unknown" });
      expect(outcome.path).not.toBeNull();
      expect(candidateFiles(repo)).toEqual([basename(outcome.path!)]);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an absent index whose read-tree step creates no file returns no candidate path",
    [],
    async () => {
      const repo = repoOf(buildF01(gitPath(), "t109-absent-failed", "empty"));
      put(repo, "first.txt", "first\n");
      const before = repoState(repo);
      const wrap =
        (run: Run): Run =>
        async (call) =>
          Bun.deepEquals(call.arguments, readTreeEmptyArgs()) ? { exitCode: 1, activeDescendants: 0 } : run(call);
      const outcome = await prepare("t109-absent-failed", repo, "first.txt", "empty-to-untracked", (h) => h[0]!, {}, wrap);
      expect(outcome).toMatchObject({ ok: false, path: null, failure: { reason: "git-failed", step: "read-tree" } });
      expect(candidateFiles(repo)).toEqual([]);
      expect(repoState(repo)).toEqual(before);
    },
    TIMEOUT_MS,
  );

  // Research R3 step 9 branches without a kept entry or without an index entry. Git's own `add -p` and `reset -p` give the expected index.
  for (const c of [
    { name: "staging a working deletion removes the entry", path: "keep.txt", scope: "index-to-worktree" as const, command: "add" as const, setup: (repo: string) => rmSync(join(repo, "keep.txt")) },
    { name: "unstaging an addition removes the entry", path: "other-b.txt", scope: "head-to-index" as const, command: "reset" as const, setup: () => {} },
    { name: "unstaging a staged deletion restores the HEAD entry", path: "keep.txt", scope: "head-to-index" as const, command: "reset" as const, setup: (repo: string) => void git(repo, ["rm", "-q", "--cached", "--", "keep.txt"]) },
  ]) {
    caseTest(
      TASK,
      `${c.name}, exactly as git ${c.command} -p does`,
      [],
      async () => {
        const slug = `t109-${c.command}-${c.path.replace(".", "-")}`;
        const repo = repoOf(buildF02(gitPath(), slug));
        c.setup(repo);
        const before = repoState(repo);
        const candidate = okCandidate(await prepare(slug, repo, c.path, c.scope, (h) => h[0]!), repo);
        expect(repoState(repo)).toEqual(before);
        const oracle = scriptedPatch(repo, `${slug}-oracle`, c.command, c.path, ["y"]);
        expect(indexEntries(gitPath(), oracle)).not.toEqual(before.entries);
        expect(candidateEntries(repo, `${slug}-copy`, candidate.bytes)).toEqual(indexEntries(gitPath(), oracle));
      },
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "published time: a same-size change after the candidate write stays visible after a publication one second later",
    [],
    async () => {
      const repo = repoOf(buildF02(gitPath(), "t109-published", "racy"));
      const index = gitPathOf(repo, "index");
      const keep = join(repo, "keep.txt");
      // keep.txt gets a stat time ahead of every index write of this case. Git for Windows compares whole seconds.
      const ahead = Math.floor(Date.now() / 1000) + 4;
      utimesSync(keep, ahead, ahead);
      git(repo, ["add", "--", "keep.txt"]);
      const c = okCandidate(await prepare("t109-published", repo, "multi.txt", "index-to-worktree", (h) => h[0]!), repo);
      expect(c.mtimeNs).toBe(statSync(c.path, { bigint: true }).mtimeNs);
      // Precondition: Git wrote the candidate in or before the entry second. Otherwise widen the margin.
      expect(Number(c.mtimeNs / 1_000_000_000n)).toBeLessThanOrEqual(ahead);
      // A same-size change that keeps the stat time of the index entry.
      writeFileSync(keep, "KEEP\n");
      utimesSync(keep, ahead, ahead);
      // At most five seconds, because `ahead` is four seconds after the start.
      while (Date.now() < (ahead + 1) * 1000) await Bun.sleep(50);
      const created = await createIndexLock(index);
      if (!created.ok) throw new Error(`lock refused: ${JSON.stringify(created)}`);
      expect(await created.lock.publish(c.bytes, c.mtimeNs)).toEqual({ published: true });
      expect(statSync(index, { bigint: true }).mtimeNs).toBeLessThanOrEqual(c.mtimeNs);
      expect(gitText(repo, ["--no-optional-locks", "diff-files", "--name-only"]).split("\n")).toContain("keep.txt");
    },
    TIMEOUT_MS,
  );
});
