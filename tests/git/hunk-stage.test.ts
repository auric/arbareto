// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T094: `applyHunk` stage (contract §4 "Hunk eligibility and publication"). `src/git-service/hunk-publish.ts` comes with T110.

import { describe, expect } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { useFixtureRoot } from "./fixture-root";
import { buildF01, buildF02, buildF03, buildF04, buildF06, buildF07, buildF10, put, type F04Variant } from "./fixtures";
import { indexEntries, rawIndexDigest, workingFileDigests } from "./git-oracle";
import {
  applyHunk,
  blobOf,
  candidateFiles,
  copyRepo,
  git,
  gitDirOf,
  gitPath,
  gitPathOf,
  gitText,
  outcome,
  repoOf,
  repoState,
  scriptedPatch,
  selectHunks,
  SUCCEEDED,
  TIMEOUT_MS,
  underTest,
  withoutPath,
  withService,
} from "./hunk-harness";
import { caseTest, type Capability, type HunkCheckpoint, type Service } from "./service-harness";

const TASK = "T094";
const SHELL: Capability[] = ["shell-double"];
const RACY_RUNS = 20;
// The F04 and racy cases build 10 and 20 fixtures, each with its own service.
const LONG_TIMEOUT_MS = 600_000;

useFixtureRoot();

// Stages the first hunk of the unstaged comparison of `path`. Returns the response.
async function stageFirst(service: Service, repo: string, path: string, category: "unstaged" | "untracked" = "unstaged") {
  const { repositoryId } = await service.register(repo);
  const c = await selectHunks(service, repositoryId, path, category);
  return applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage");
}

// The `run` calls of `apply`: contract §4 needs `apply --cached` and never `--index`.
const applyCalls = (service: Service) => service.runner.calls.filter((c) => c.arguments.includes("apply")).map((c) => c.arguments);

describe("stage one hunk (contract §4, research.md R3)", () => {
  caseTest(TASK, `F02: one of two unstaged hunks stages as scripted git add -p does, every unrelated entry and working file stays equal, apply runs with --cached and never --index, and no trust approval is needed`, SHELL, () =>
    withService({ name: "t094-f02" }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), "t094-f02"));
      const before = repoState(repo);
      const oracle = scriptedPatch(repo, "t094-f02-oracle", "add", "multi.txt", ["y", "n"]);
      await underTest("hunk-publish");
      expect(outcome(await stageFirst(service, repo, "multi.txt"))).toEqual(SUCCEEDED);
      expect(blobOf(repo, "multi.txt")).toBe(blobOf(oracle, "multi.txt"));
      expect(withoutPath(indexEntries(gitPath(), repo), "multi.txt")).toEqual(withoutPath(before.entries, "multi.txt"));
      expect(workingFileDigests(repo)).toEqual(before.files);
      const applies = applyCalls(service);
      expect(applies.length).toBeGreaterThan(0);
      expect(applies.filter((args) => !args.includes("--cached") || args.includes("--index"))).toEqual([]);
      expect(service.trustStore.records).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F04: for CRLF and each line-ending policy, the canonical index bytes equal scripted git add -p, and raw working bytes stay unchanged, also under core.safecrlf=true`, SHELL, async () => {
    const variants: [F04Variant, string[]][] = [
      ["autocrlf-false", [""]],
      ["autocrlf-true", [""]],
      ["autocrlf-input", [""]],
      ["eol-crlf", [""]],
      ["safecrlf", [""]],
      ["attributes", ["text/", "auto/", "binary/", "eol/", "crlf/"]],
    ];
    const cases = variants.flatMap(([variant, folders]) =>
      folders.map((folder) => {
        const name = `t094-f04-${variant}-${folder.replace("/", "") || "root"}`;
        const repo = repoOf(buildF04(gitPath(), name, variant));
        const path = `${folder}crlf.txt`;
        return { name, variant, repo, path, before: repoState(repo), oracle: scriptedPatch(repo, `${name}-oracle`, "add", path, ["y", "n"]) };
      }),
    );
    await underTest("hunk-publish");
    for (const { name, variant, repo, path, before, oracle } of cases) {
      await withService({ name }, async (service) => {
        expect({ variant, path, ...outcome(await stageFirst(service, repo, path)) }).toEqual({ variant, path, ...SUCCEEDED });
        expect({ variant, path, blob: blobOf(repo, path) }).toEqual({ variant, path, blob: blobOf(oracle, path) });
        expect({ variant, path, files: workingFileDigests(repo) }).toEqual({ variant, path, files: before.files });
      });
    }
  }, LONG_TIMEOUT_MS);

  caseTest(TASK, `F06: deleted text removes the entry, and untracked text creates it, as scripted git add -p does`, SHELL, async () => {
    const cases = ([["deleted.txt", "unstaged"], ["untracked.txt", "untracked"], ["replaced.txt", "untracked"]] as const).map(([path, category]) => {
      const name = `t094-f06-${path.replace(".txt", "")}`;
      const repo = repoOf(buildF06(gitPath(), name));
      // research.md R3: an untracked file stages through `add -N`, then `add -p`.
      const oracle = scriptedPatch(repo, `${name}-oracle`, "add", path, ["y"], category === "untracked" ? [["--literal-pathspecs", "add", "-N", "--", path]] : []);
      return { name, path, category, repo, before: repoState(repo), oracle };
    });
    await underTest("hunk-publish");
    for (const { name, path, category, repo, before, oracle } of cases) {
      await withService({ name }, async (service) => {
        expect({ path, ...outcome(await stageFirst(service, repo, path, category)) }).toEqual({ path, ...SUCCEEDED });
        expect({ path, entries: indexEntries(gitPath(), repo) }).toEqual({ path, entries: indexEntries(gitPath(), oracle) });
        expect({ path, files: workingFileDigests(repo) }).toEqual({ path, files: before.files });
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, `F01: an unborn repository without an index gets its first index through Git, never a zero-byte file`, SHELL, () =>
    withService({ name: "t094-f01" }, async (service) => {
      const repo = repoOf(buildF01(gitPath(), "t094-f01", "empty"));
      put(repo, "first.txt", "first line\nsecond line\n");
      expect(existsSync(gitPathOf(repo, "index"))).toBe(false);
      const oracle = scriptedPatch(repo, "t094-f01-oracle", "add", "first.txt", ["y"], [["add", "-N", "--", "first.txt"]]);
      await underTest("hunk-publish");
      expect(outcome(await stageFirst(service, repo, "first.txt", "untracked"))).toEqual(SUCCEEDED);
      expect(statSync(gitPathOf(repo, "index")).size).toBeGreaterThan(0);
      expect(indexEntries(gitPath(), repo)).toEqual(indexEntries(gitPath(), oracle));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F03: Unicode, spaced, and option-like paths stage as scripted git add -p does`, SHELL, async () => {
    const cases = ["space dir/雪 café.txt", "-rf", "--output=x"].map((path, i) => {
      const name = `t094-f03-${i}`;
      const repo = repoOf(buildF03(gitPath(), name));
      put(repo, path, `${path} first\n${Array.from({ length: 10 }, (_, n) => `keep ${n}\n`).join("")}`);
      return { name, path, repo, oracle: scriptedPatch(repo, `${name}-oracle`, "add", path, ["y"]) };
    });
    await underTest("hunk-publish");
    for (const { name, path, repo, oracle } of cases) {
      await withService({ name }, async (service) => {
        expect({ path, ...outcome(await stageFirst(service, repo, path)) }).toEqual({ path, ...SUCCEEDED });
        expect({ path, entries: indexEntries(gitPath(), repo) }).toEqual({ path, entries: indexEntries(gitPath(), oracle) });
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, `F07: staging in one linked worktree leaves the index bytes of the other worktree unchanged`, SHELL, () =>
    withService({ name: "t094-f07" }, async (service) => {
      const built = buildF07(gitPath(), "t094-f07");
      const a = join(built.root, "wt-a");
      const b = join(built.root, "wt-b");
      put(a, "shared.txt", "shared changed in a\n");
      const other = rawIndexDigest(gitPath(), b);
      await underTest("hunk-publish");
      expect(outcome(await stageFirst(service, a, "shared.txt"))).toEqual(SUCCEEDED);
      expect(gitText(a, ["diff", "--cached", "--name-only"]).trim()).toBe("a-only.txt\nshared.txt");
      expect(rawIndexDigest(gitPath(), b)).toBe(other);
    }),
    TIMEOUT_MS,
  );
});

describe("index flags and racy entries (contract §4 \"Candidate time\")", () => {
  caseTest(TASK, `F10 flags: report for research.md whether apply --cached keeps the flags of unrelated entries`, SHELL, () =>
    withService({ name: "t094-flags" }, async (service) => {
      const repo = repoOf(buildF10(gitPath(), "t094-flags", "flags"));
      // Oracle only: Git's own `apply --cached` of a new-file patch in a copy.
      const copy = copyRepo(repo, "t094-flags-oracle");
      const flags = (dir: string) => indexEntries(gitPath(), dir).filter((e) => e.path !== "extra.txt").map(({ path, intentToAdd, assumeUnchanged, skipWorktree }) => ({ path, intentToAdd, assumeUnchanged, skipWorktree }));
      const before = flags(copy);
      git(copy, ["apply", "--cached"], { input: Buffer.from("diff --git a/extra.txt b/extra.txt\nnew file mode 100644\n--- /dev/null\n+++ b/extra.txt\n@@ -0,0 +1 @@\n+extra\n") });
      const after = flags(copy);
      console.log(`OBSERVATION ${TASK}: ${gitText(copy, ["version"]).trim()} apply --cached ${JSON.stringify(after) === JSON.stringify(before) ? "kept" : "changed"} the flags of unrelated entries (F10 flags): before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
      // The service path keeps them too: stage a hunk of an unflagged file.
      put(repo, "extra.txt", "extra\n");
      await underTest("hunk-publish");
      expect(outcome(await stageFirst(service, repo, "extra.txt", "untracked"))).toEqual(SUCCEEDED);
      expect(flags(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F02 racy: in ${RACY_RUNS} runs a hunk publication keeps the unrelated racy change visible to git status, the candidate time never exceeds the canonical index time, and the published time never exceeds the verified candidate time`, SHELL, async () => {
    const runs = Array.from({ length: RACY_RUNS }, (_, run) => {
      const name = `t094-racy-${run}`;
      const built = buildF02(gitPath(), name, "racy");
      return { run, name, repo: repoOf(built), racy: (built.facts.notes.racy as { path: string }).path };
    });
    await underTest("hunk-publish");
    for (const { run, name, repo, racy } of runs) {
      const times: { candidate: bigint; index: bigint }[] = [];
      // Contract §4 "Candidate time" is the time of the copy before any Git step. `apply --cached` then rewrites the candidate through its own lock file, so the observer reads the time when `apply` starts.
      const observe = (call: { arguments: readonly string[] }) => {
        if (!call.arguments.includes("apply")) return false;
        const candidates = candidateFiles(repo);
        expect(candidates.length).toBe(1);
        times.push({ candidate: statSync(join(gitDirOf(repo), candidates[0]!), { bigint: true }).mtimeNs, index: statSync(gitPathOf(repo, "index"), { bigint: true }).mtimeNs });
        return false;
      };
      // Contract §4 "Published time": the published index time is the verified candidate time or earlier. Nothing writes the candidate after step 10.
      const published: { verified?: bigint; index?: bigint } = {};
      const hunkCheckpoint = ({ step }: HunkCheckpoint) => {
        if (step === 11) published.verified = statSync(join(gitDirOf(repo), candidateFiles(repo)[0]!), { bigint: true }).mtimeNs;
        if (step === 13) published.index = statSync(gitPathOf(repo, "index"), { bigint: true }).mtimeNs;
      };
      await withService({ name, hunkCheckpoint }, async (service) => {
        service.runner.holdStart(observe);
        expect({ run, ...outcome(await stageFirst(service, repo, "multi.txt")) }).toEqual({ run, ...SUCCEEDED });
      });
      expect(times.length).toBe(1);
      expect({ run, earlierOrEqual: times[0]!.candidate <= times[0]!.index, published: published.index! <= published.verified! }).toEqual({ run, earlierOrEqual: true, published: true });
      // Git's own status must still see the same-size racy change.
      const status = gitText(repo, ["status", "--porcelain=v2", "-z"]).split("\0");
      expect({ run, listed: status.some((r) => r.startsWith("1 .M ") && r.endsWith(` ${racy}`)) }).toEqual({ run, listed: true });
      expect(candidateFiles(repo)).toEqual([]);
    }
  }, LONG_TIMEOUT_MS);
});
