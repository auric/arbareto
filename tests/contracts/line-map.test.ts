// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T020: feature 005 data-model §11 and spec FR-056 "Blame before this commit". The byte fixtures copy Git 2.56.0.windows.2 output of
// `diff -U0 --inter-hunk-context=0` between two blobs (probe of 2026-10-22).

import { describe, expect, test } from "bun:test";
import { mapLine, parseHunks, type Hunk } from "../../src/git-service/line-map";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/line-map.ts", import.meta.dir);

const bytes = (text: string) => new TextEncoder().encode(text);
const HEAD = "diff --git a/1111111 b/2222222\nindex 1111111..2222222 100644\n--- a/1111111\n+++ b/2222222\n";
// Old lines 1 to 12. New: line 3 changed, line 6 replaced by two lines, line 9 deleted.
const THREE = `${HEAD}@@ -3 +3 @@\n-line 3\n+line three\n@@ -6 +6,2 @@\n-line 6\n+line six\n+line six b\n@@ -9 +9,0 @@\n-line 9\n`;
const h = (oldStart: number, oldCount: number, newStart: number, newCount: number): Hunk => ({ oldStart, oldCount, newStart, newCount });

describe("hunk headers of a zero-context diff", () => {
  test("each header gives a, b, c, d, and an omitted count is 1", () => {
    expect(parseHunks(bytes(THREE))).toEqual([h(3, 1, 3, 1), h(6, 1, 6, 2), h(9, 1, 9, 0)]);
  });

  test("no difference gives no hunk", () => {
    expect(parseHunks(new Uint8Array())).toEqual([]);
  });

  const malformed: [string, string][] = [
    ["a body shorter than its counts", THREE.replace("+line six b\n", "")],
    ["a body longer than its counts", `${THREE}+extra\n`],
    ["a hunk without the file header", "@@ -1 +1 @@\n-a\n+b\n"],
    ["a context line in a zero-context hunk", THREE.replace("-line 3\n", " line 3\n")],
    ["a header with a leading zero", THREE.replace("@@ -3 +3 @@", "@@ -03 +3 @@")],
    ["a binary notice", `${HEAD.slice(0, HEAD.indexOf("---"))}Binary files a/1111111 and b/2222222 differ\n`],
    ["no final newline", THREE.slice(0, -1)],
  ];
  for (const [name, text] of malformed) test(`${name} gives null`, () => expect(parseHunks(bytes(text))).toBeNull());
});

describe("the FR-056 line map", () => {
  const hunks = [h(3, 1, 3, 1), h(6, 1, 6, 2), h(9, 1, 9, 0)];

  test("a line inside a changed hunk maps to the hunk's old start", () => {
    expect(mapLine(3, hunks, 12)).toBe(3);
    expect(mapLine(6, hunks, 12)).toBe(6);
    expect(mapLine(7, hunks, 12)).toBe(6);
  });

  test("a line outside every hunk moves by the sum of (b - d) of the hunks before it", () => {
    expect([1, 2, 4, 5].map((o) => mapLine(o, hunks, 12))).toEqual([1, 2, 4, 5]);
    // After the second hunk: 1 - 2 = -1.
    expect(mapLine(8, hunks, 12)).toBe(7);
    // New line 9 is old line 8. After the deletion of old line 9: -1 + 1 = 0.
    expect([9, 10, 11, 12].map((o) => mapLine(o, hunks, 12))).toEqual([8, 10, 11, 12]);
  });

  test("a pure deletion ends before the new line that follows its position", () => {
    // `@@ -5,2 +4,0 @@`: new line 4 is old line 4, new line 5 is old line 7 (xdiff `xdl_emit_hunk_hdr` prints the line before an empty range).
    const deletion = [h(5, 2, 4, 0)];
    expect([3, 4, 5].map((o) => mapLine(o, deletion, 10))).toEqual([3, 4, 7]);
  });

  test("a line of a pure insertion maps to the old start plus 1", () => {
    const insertion = [h(4, 0, 5, 2)];
    expect([4, 5, 6, 7].map((o) => mapLine(o, insertion, 10))).toEqual([4, 5, 5, 5]);
    expect(mapLine(1, [h(0, 0, 1, 2)], 10)).toBe(1);
  });

  test("the result clamps to 1 and the old line count", () => {
    expect(mapLine(5, [h(3, 0, 4, 3)], 3)).toBe(3);
    expect(mapLine(1, [h(3, 2, 1, 0)], 5)).toBe(1);
  });

  test("an empty previous version has no line, so the map gives null", () => {
    // P holds an empty file, and X adds two lines: `@@ -0,0 +1,2 @@`.
    expect(mapLine(1, [h(0, 0, 1, 2)], 0)).toBeNull();
    expect(mapLine(2, [h(1, 3, 1, 0)], 0)).toBeNull();
  });
});
