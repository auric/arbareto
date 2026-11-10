// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { printOrigin } from "../origin";
import { fixtureDir, ownedPath, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { cached, runGit } from "./history-diff-fixtures";

// This file imports no `src/` module, so it prints no ORIGIN line for `src/`.
printOrigin("./history-diff-fixtures.ts", import.meta.dir);

useFixtureRoot();

describeGit("T122 cached history-diff fixture reuse", (git) => {
  test("an entry without its index or a work-tree file is rebuilt, and an intact entry is reused", () => {
    // Never PERF_CACHE_ROOT: this test damages its entry.
    const root = fixtureDir("history-diff-cache");
    const build = (repo: string) => {
      mkdirSync(ownedPath(root, relative(root, repo)), { recursive: true });
      const g = (args: string[]) => runGit(git, root, repo, args).toString("utf8");
      g(["init", "-q", "-b", "main"]);
      writeFileSync(join(repo, "a.txt"), "a\n");
      g(["add", "--", "a.txt"]);
      g(["commit", "-q", "--no-verify", "-m", "a"]);
      return { name: "tiny", objectFormat: "sha1" as const, oids: { tip: g(["rev-parse", "HEAD"]).trim() }, trees: { tip: { "a.txt": "100644" } }, parents: { tip: 0 }, changes: { tip: 1 } };
    };
    const marker = join(root, "f005-tiny", "marker");
    for (const damaged of [[".git", "index"], ["a.txt"]]) {
      const first = cached(git, "tiny", build, root);
      writeFileSync(marker, "");
      rmSync(join(first.repo, ...damaged));
      const second = cached(git, "tiny", build, root);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(second.repo, ...damaged))).toBe(true);
    }
    writeFileSync(marker, "");
    cached(git, "tiny", build, root);
    expect(existsSync(marker)).toBe(true);
  });
});
