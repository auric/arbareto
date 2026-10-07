// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture builders F16 (T066). `fixture-root.ts` prints the ORIGIN of its contract file.

import { describe, expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_DIFF_BYTES, CANONICAL_DIFF_LINES, WHOLE_FILE_STAGE_INPUT_BYTES } from "../../src/contracts/limits";
import { cachedF16Status } from "../windows/fixture-cache";
import { fixtureChecks, git1, TIMEOUT } from "./fixture-checks";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import * as F from "./fixtures";

describeGit("fixture builders: F16", (git) => {
  useFixtureRoot();

  describe("cases", () => {
    const { check, filemodeTest } = fixtureChecks(git);

    for (const variant of ["side-at-limit", "side-over-limit", "lines-at-limit", "lines-over-limit", "patch-bytes"] as const) {
      test(`F16 comparison ${variant}`, () =>
        check(`F16 comparison ${variant}`, (n) => F.buildF16Comparison(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          const patch = git1(g, repo, ["diff-files", "-p", "--no-ext-diff", "--no-textconv", "--", "big.txt"]);
          // Contract §5: count every patch line, headers included, and ignore the empty segment after the final newline.
          const patchLines = patch.toString("utf8").split("\n").length - 1;
          const sides = [Number(git1(g, repo, ["cat-file", "-s", "HEAD:big.txt"]).toString()), lstatSync(join(repo, "big.txt")).size];
          if (variant.startsWith("side")) expect(sides).toEqual([b.facts.notes.sideBytes as number, b.facts.notes.sideBytes as number]);
          if (variant.startsWith("lines")) expect(patchLines).toBe(b.facts.notes.diffLines as number);
          if (variant === "patch-bytes") expect([patch.length > CANONICAL_DIFF_BYTES, patchLines < CANONICAL_DIFF_LINES]).toEqual([true, true]);
          console.log(`FACTS F16 comparison ${variant}: sides ${sides.join("/")} bytes, patch ${patchLines} lines, ${patch.length} bytes`);
        }), TIMEOUT);
    }

    test("F16 stage-input", () =>
      check("F16 stage-input", (n) => F.buildF16StageInput(git, n), (_g, b) => {
        const sizes = b.facts.notes.sizes as Record<string, number>;
        expect(Object.values(sizes)).toEqual([WHOLE_FILE_STAGE_INPUT_BYTES, WHOLE_FILE_STAGE_INPUT_BYTES + 1]);
        for (const [path, bytes] of Object.entries(sizes)) expect(lstatSync(join(b.root, "repo", path)).size).toBe(bytes);
      }), TIMEOUT);

    for (const variant of ["at-limit", "over-limit"] as const) {
      test(`F16 status ${variant}`, () =>
        check(`F16 status ${variant}`, (n) => F.buildF16Status(git, n, variant), (_g, b) => {
          expect(b.facts.repos.repo!.unstaged.length).toBe(F.F16_STATUS_RECORDS + (variant === "over-limit" ? 1 : 0));
        }, (n) => cachedF16Status(git, n, variant).built), TIMEOUT);
    }

    for (const variant of ["parents-64", "parents-65", "parent-refs", "object-at-limit", "object-over-limit", "traversal"] as const) {
      test(`F16 history ${variant}`, () =>
        check(`F16 history ${variant}`, (n) => F.buildF16History(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          const rows = git1(g, repo, ["rev-list", "--parents", "--date-order", "--max-count=100", "HEAD"]).toString().trim().split("\n");
          const parentRefs = rows.reduce((sum, row) => sum + row.split(" ").length - 1, 0);
          const maxParents = Math.max(...rows.map((row) => row.split(" ").length - 1));
          if (variant === "parents-64") expect(maxParents).toBe(64);
          if (variant === "parents-65") expect(maxParents).toBe(65);
          if (variant === "parent-refs") expect([parentRefs > 1024, maxParents <= 64]).toEqual([true, true]);
          if (variant.startsWith("object")) expect(Number(git1(g, repo, ["cat-file", "-s", "HEAD"]).toString())).toBe(b.facts.notes.objectBytes as number);
          if (variant === "traversal") {
            const text = git1(g, repo, ["rev-list", "--max-count=100", "--format=%H %P %s", "HEAD"]);
            expect([rows.length, text.length > 128 * 1024]).toEqual([100, true]);
            expect(Math.max(...rows.map((r) => Number(git1(g, repo, ["cat-file", "-s", r.split(" ")[0]!]).toString())))).toBeLessThan(F.F16_OBJECT_LIMIT);
          }
          console.log(`FACTS F16 history ${variant}: rows ${rows.length}, parent references ${parentRefs}, max parents ${maxParents}`);
        }), TIMEOUT);
    }

    filemodeTest();
  });
});
