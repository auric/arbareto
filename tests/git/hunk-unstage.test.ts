// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T095: `applyHunk` unstage (contract §4, research.md R3 step 8). `src/git-service/hunk-publish.ts` comes with T110.

import { describe, expect } from "bun:test";
import { useFixtureRoot } from "./fixture-root";
import { buildF01, buildF02, buildF06 } from "./fixtures";
import { indexEntries, workingFileDigests } from "./git-oracle";
import { applyHunk, gitPath, outcome, repoOf, repoState, scriptedPatch, selectHunks, SUCCEEDED, todoCase, underTest, withService } from "./hunk-harness";
import type { Capability, Service } from "./service-harness";

const TASK = "T095";
const NEEDS = "(needs T110/T115)";
const SHELL: Capability[] = ["shell-double"];

useFixtureRoot();

// Unstages the first hunk of the staged comparison of `path`.
async function unstageFirst(service: Service, repo: string, path: string) {
  const { repositoryId } = await service.register(repo);
  const c = await selectHunks(service, repositoryId, path, "staged");
  return applyHunk(service, repositoryId, c, c.hunkIds[0]!, "unstage");
}

describe("unstage one hunk (contract §4)", () => {
  todoCase(TASK, `F02: one of two staged hunks leaves the index as scripted git reset -p does, while the file keeps more unstaged edits, and working bytes stay unchanged ${NEEDS}`, SHELL, () =>
    withService({ name: "t095-f02" }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), "t095-f02", "staged-hunks"));
      const before = repoState(repo);
      const oracle = scriptedPatch(repo, "t095-f02-oracle", "reset", "multi.txt", ["y", "n"]);
      await underTest("hunk-publish");
      expect(outcome(await unstageFirst(service, repo, "multi.txt"))).toEqual(SUCCEEDED);
      expect(indexEntries(gitPath(), repo)).toEqual(indexEntries(gitPath(), oracle));
      expect(workingFileDigests(repo)).toEqual(before.files);
    }),
  );

  todoCase(TASK, `F06: unstaging the only hunk of an added file removes the entry ${NEEDS}`, SHELL, () =>
    withService({ name: "t095-f06" }, async (service) => {
      const repo = repoOf(buildF06(gitPath(), "t095-f06"));
      const before = repoState(repo);
      const oracle = scriptedPatch(repo, "t095-f06-oracle", "reset", "added.txt", ["y"]);
      expect(indexEntries(gitPath(), oracle).filter((e) => e.path === "added.txt")).toEqual([]);
      await underTest("hunk-publish");
      expect(outcome(await unstageFirst(service, repo, "added.txt"))).toEqual(SUCCEEDED);
      expect(indexEntries(gitPath(), repo)).toEqual(indexEntries(gitPath(), oracle));
      expect(workingFileDigests(repo)).toEqual(before.files);
    }),
  );

  todoCase(TASK, `F01: unstaging in an unborn repository works against the empty baseline ${NEEDS}`, SHELL, () =>
    withService({ name: "t095-f01" }, async (service) => {
      const repo = repoOf(buildF01(gitPath(), "t095-f01", "unborn-added"));
      const before = repoState(repo);
      const oracle = scriptedPatch(repo, "t095-f01-oracle", "reset", "first.txt", ["y"]);
      expect(indexEntries(gitPath(), oracle).map((e) => e.path)).toEqual(["empty.txt"]);
      await underTest("hunk-publish");
      expect(outcome(await unstageFirst(service, repo, "first.txt"))).toEqual(SUCCEEDED);
      expect(indexEntries(gitPath(), repo)).toEqual(indexEntries(gitPath(), oracle));
      expect(workingFileDigests(repo)).toEqual(before.files);
    }),
  );
});
