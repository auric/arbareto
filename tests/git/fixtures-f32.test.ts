// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture builder F32 (T251). `fixture-root.ts` prints the ORIGIN of its contract file.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectHunks, fixtureChecks, git1, TIMEOUT } from "./fixture-checks";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import * as F from "./fixtures";

describeGit("fixture builders: F32", (git) => {
  useFixtureRoot();

  describe("cases", () => {
    const { check, filemodeTest } = fixtureChecks(git);

    test("F32", () =>
      check("F32", (n) => F.buildF32(git, n), (g, b) => {
        const repo = join(b.root, "repo");
        const facts = b.facts.repos.repo!;
        expect(Number(git1(g, repo, ["rev-list", "--count", "HEAD"]).toString().trim())).toBe(b.facts.notes.commits as number);
        expect(b.facts.notes.commits).toBe(150);
        // Porcelain v2 ordinary records: `1 XY sub mH mI mW hH hI path`. No renames, no untracked or unmerged records.
        const records = git1(g, repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=all"]).toString("utf8").split("\0").filter((r) => r !== "");
        expect(records.every((r) => r.startsWith("1 "))).toBe(true);
        const fields = records.map((r) => ({ xy: r.slice(2, 4), path: r.split(" ").slice(8).join(" ") }));
        expect(fields.filter((f) => f.xy[1] !== ".").map((f) => f.path).sort()).toEqual(facts.unstaged);
        expect(fields.filter((f) => f.xy[0] !== ".").map((f) => f.path).sort()).toEqual(facts.staged);
        expect(facts.unstaged).toEqual([...F.F32_PANEL_FILES, "multi.txt"].sort());
        expectHunks(g, repo, b);
        // With three context lines, each one-line hunk starts three lines before its changed line on both sides.
        const hunks = b.facts.notes.hunks as Record<string, { unstaged: number[] }>;
        const headers = [...git1(g, repo, ["diff-files", "-p", "-U3", "--no-ext-diff", "--no-textconv", "--", "multi.txt"]).toString().matchAll(/^@@ .* @@/gm)].map((m) => m[0]);
        expect(headers).toEqual(hunks["multi.txt"]!.unstaged.map((n) => `@@ -${n - 3},7 +${n - 3},7 @@`));
      }), TIMEOUT);

    filemodeTest();
  });
});
