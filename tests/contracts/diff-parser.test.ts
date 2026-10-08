// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { CANONICAL_DIFF_BYTES, CANONICAL_DIFF_LINES } from "../../src/contracts/limits";
import { type NumstatResult, parseNumstat, parsePatch, type PatchResult } from "../../src/git-service/diff-parser";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/diff-parser.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);

// T102: contract §5 "Canonical diff" and data-model §5 "Hunk". The byte fixtures copy Git 2.56.0.windows.1 output of the T101 builders (probe of 2026-10-08).

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const sha256 = (value: Uint8Array): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const MALFORMED = { ok: false, completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } };
const limited = (reason: string) => ({ ok: false, completeness: { state: "limited", code: "OUTPUT_LIMIT", reason } });

function ok(result: PatchResult) {
  if (!result.ok) throw new Error(`parse failed: ${JSON.stringify(result.completeness)}`);
  return result.patch;
}

const MODIFIED = "diff --git a/sp ace.txt b/sp ace.txt\nindex 422c2b7..55dce13 100644\n--- a/sp ace.txt\t\n+++ b/sp ace.txt\t\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n";
const NO_EOL = "diff --git a/noeol.txt b/noeol.txt\nindex ef073cc..08b9811 100644\n--- a/noeol.txt\n+++ b/noeol.txt\n@@ -1 +1 @@\n-n\n\\ No newline at end of file\n+m\n\\ No newline at end of file\n";
const UNTRACKED = "diff --git a/u sp.txt b/u sp.txt\nnew file mode 100644\nindex 0000000..cf806e4\n--- /dev/null\n+++ b/u sp.txt\t\n@@ -0,0 +1 @@\n+u u\n";
const QUOTED = 'diff --git "a/\\303\\251 b.txt" "b/\\303\\251 b.txt"\nnew file mode 100644\nindex 0000000..74b863c\n--- /dev/null\n+++ "b/\\303\\251 b.txt"\t\n@@ -0,0 +1 @@\n+x y\n';
const UNQUOTED = "diff --git a/é b.txt b/é b.txt\nnew file mode 100644\nindex 0000000..74b863c\n--- /dev/null\n+++ b/é b.txt\t\n@@ -0,0 +1 @@\n+x y\n";

describe("canonical single-file patches", () => {
  test("a modified file gives one hunk with its ranges, bytes, and SHA-256", () => {
    const raw = bytes(MODIFIED);
    const patch = ok(parsePatch(raw, bytes("sp ace.txt")));
    expect(patch.lines).toBe(8);
    expect(new TextDecoder().decode(patch.header)).toBe(MODIFIED.slice(0, MODIFIED.indexOf("@@")));
    expect(patch.hunks).toHaveLength(1);
    const hunk = patch.hunks[0]!;
    const hunkBytes = bytes("@@ -1,2 +1,2 @@\n a\n-b\n+B\n");
    expect({ ordinal: hunk.ordinal, oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart, newCount: hunk.newCount }).toEqual({ ordinal: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 });
    expect(hunk.bytes).toEqual(hunkBytes);
    expect(hunk.digest).toBe(sha256(hunkBytes));
  });

  test("no-newline markers count as patch lines and not as hunk lines", () => {
    const patch = ok(parsePatch(bytes(NO_EOL), bytes("noeol.txt")));
    expect(patch.lines).toBe(9);
    expect(patch.hunks.map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount])).toEqual([[1, 1, 1, 1]]);
  });

  test("an untracked creation patch has a tab only after the label with a space", () => {
    const patch = ok(parsePatch(bytes(UNTRACKED), bytes("u sp.txt")));
    expect(patch.hunks.map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount])).toEqual([[0, 0, 1, 1]]);
  });

  test("a C-quoted path and the core.quotePath=false form both match the path bytes", () => {
    expect(ok(parsePatch(bytes(QUOTED), bytes("é b.txt"))).hunks).toHaveLength(1);
    expect(ok(parsePatch(bytes(UNQUOTED), bytes("é b.txt"))).hunks).toHaveLength(1);
  });

  test("metadata-only patches have no selectable hunk", () => {
    const modeOnly = "diff --git a/e.txt b/e.txt\nold mode 100644\nnew mode 100755\n";
    const emptyNew = "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..e69de29\n";
    const emptyDeleted = "diff --git a/e.txt b/e.txt\ndeleted file mode 100644\nindex e69de29..0000000\n";
    for (const [text, path] of [
      [modeOnly, "e.txt"],
      [emptyNew, "new.txt"],
      [emptyDeleted, "e.txt"],
    ] as const) {
      expect(ok(parsePatch(bytes(text), bytes(path))).hunks).toEqual([]);
    }
  });

  test("an empty diff output is a complete patch without hunks", () => {
    const patch = ok(parsePatch(new Uint8Array(), bytes("a.txt")));
    expect([patch.lines, patch.hunks.length, patch.header.length]).toEqual([0, 0, 0]);
  });

  test("a mode change with content keeps the index line without a mode", () => {
    const text = "diff --git a/f b/f\nold mode 100644\nnew mode 100755\nindex 1234567..89abcde\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n";
    expect(ok(parsePatch(bytes(text), bytes("f"))).hunks).toHaveLength(1);
  });

  test("CRLF content lines and a function heading are accepted", () => {
    const text = "diff --git a/c.txt b/c.txt\nindex 1234567..89abcde 100644\n--- a/c.txt\n+++ b/c.txt\n@@ -1,2 +1,2 @@ fn main\n a\r\n-b\r\n+c\r\n";
    expect(ok(parsePatch(bytes(text), bytes("c.txt"))).hunks).toHaveLength(1);
  });

  test("two hunks keep their order, ranges, and ordinals", () => {
    const text =
      "diff --git a/t.txt b/t.txt\nindex 1234567..89abcde 100644\n--- a/t.txt\n+++ b/t.txt\n" +
      "@@ -1,4 +1,5 @@\n l1\n+n1\n l2\n l3\n l4\n" +
      "@@ -15,5 +16,4 @@\n l15\n l16\n-l17\n l18\n l19\n";
    const patch = ok(parsePatch(bytes(text), bytes("t.txt")));
    expect(patch.hunks.map((h) => [h.ordinal, h.oldStart, h.oldCount, h.newStart, h.newCount])).toEqual([
      [0, 1, 4, 1, 5],
      [1, 15, 5, 16, 4],
    ]);
  });
});

describe("non-canonical patches give MALFORMED_GIT_OUTPUT", () => {
  const cases: [string, string, string][] = [
    ["a hunk body longer than its header counts", MODIFIED + " extra\n", "sp ace.txt"],
    ["a hunk body shorter than its header counts", MODIFIED.replace("+B\n", ""), "sp ace.txt"],
    ["an explicit count of 1", NO_EOL.replace("@@ -1 +1 @@", "@@ -1,1 +1,1 @@"), "noeol.txt"],
    ["a leading zero in a range", MODIFIED.replace("@@ -1,2", "@@ -01,2"), "sp ace.txt"],
    ["a missing tab after a label with a space", MODIFIED.replace("+++ b/sp ace.txt\t\n", "+++ b/sp ace.txt\n"), "sp ace.txt"],
    ["a tab after a label without a space", NO_EOL.replace("--- a/noeol.txt\n", "--- a/noeol.txt\t\n"), "noeol.txt"],
    ["a tab after /dev/null", UNTRACKED.replace("--- /dev/null\n", "--- /dev/null\t\n"), "u sp.txt"],
    ["another path", MODIFIED, "other.txt"],
    ["a rename header pair", MODIFIED.replace("diff --git a/sp ace.txt b/sp ace.txt", "diff --git a/sp ace.txt b/x.txt"), "sp ace.txt"],
    ["a binary patch line", "diff --git a/bin.dat b/bin.dat\nindex 20b5be9..88f3700 100644\nBinary files a/bin.dat and b/bin.dat differ\n", "bin.dat"],
    ["a second file", MODIFIED + MODIFIED, "sp ace.txt"],
    ["no final newline", MODIFIED.slice(0, -1), "sp ace.txt"],
    ["a body line without a prefix", MODIFIED.replace(" a\n", "a\n"), "sp ace.txt"],
    ["a removed line after the old side ended", "diff --git a/n b/n\nindex 1234567..89abcde 100644\n--- a/n\n+++ b/n\n@@ -1,2 +1 @@\n-a\n\\ No newline at end of file\n-b\n+c\n", "n"],
    ["a marker before any body line", MODIFIED.replace("@@ -1,2 +1,2 @@\n", "@@ -1,2 +1,2 @@\n\\ No newline at end of file\n"), "sp ace.txt"],
    ["a short marker line", NO_EOL.replace("-n\n\\ No newline at end of file\n", "-n\n\\ No\n"), "noeol.txt"],
    ["a new side start that ignores the earlier hunks", MODIFIED.replace("@@ -1,2 +1,2 @@", "@@ -1,2 +2,2 @@"), "sp ace.txt"],
    ["an index line without the mode of a plain change", MODIFIED.replace(" 100644\n", "\n"), "sp ace.txt"],
    ["a mode on the index line of a new file", UNTRACKED.replace("..cf806e4\n", "..cf806e4 100644\n"), "u sp.txt"],
    ["a plain change without hunks", "diff --git a/f b/f\nindex 1234567..89abcde 100644\n", "f"],
    ["a new file whose old label is not /dev/null", UNTRACKED.replace("--- /dev/null", "--- a/u sp.txt\t"), "u sp.txt"],
    ["equal old and new modes", "diff --git a/e b/e\nold mode 100644\nnew mode 100644\n", "e"],
    ["an unknown escape in a quoted label", QUOTED.replaceAll("\\303", "\\q03"), "é b.txt"],
    ["an octal escape above \\377", QUOTED.replaceAll("\\303", "\\403"), "é b.txt"],
    ["an uppercase abbreviated object ID", MODIFIED.replace("422c2b7", "422C2B7"), "sp ace.txt"],
    ["a line before the file header", "x\n" + MODIFIED, "sp ace.txt"],
    ["a space after the hunk header without a heading", MODIFIED.replace("@@ -1,2 +1,2 @@\n", "@@ -1,2 +1,2 @@ \n"), "sp ace.txt"],
  ];
  for (const [name, text, path] of cases) {
    test(name, () => expect(parsePatch(bytes(text), bytes(path))).toEqual(MALFORMED as PatchResult));
  }
});

describe("contract §5 canonical diff bounds", () => {
  // A creation patch: five header lines, one hunk header, and `count` added lines.
  function creation(count: number, line = "x"): string {
    return `diff --git a/f b/f\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/f\n@@ -0,0 +${count === 1 ? "1" : `1,${count}`} @@\n${`+${line}\n`.repeat(count)}`;
  }

  test("20,000 lines are accepted, and the empty segment after the final newline does not count", () => {
    const patch = ok(parsePatch(bytes(creation(CANONICAL_DIFF_LINES - 6)), bytes("f")));
    expect(patch.lines).toBe(CANONICAL_DIFF_LINES);
  });

  test("line 20,001 gives limited with CANONICAL_DIFF_LINES", () => {
    expect(parsePatch(bytes(creation(CANONICAL_DIFF_LINES - 5)), bytes("f"))).toEqual(limited("CANONICAL_DIFF_LINES") as PatchResult);
  });

  test("4 MiB of patch bytes are accepted, and one more byte gives limited with CANONICAL_DIFF_BYTES", () => {
    const head = creation(1).length - 3;
    const fill = CANONICAL_DIFF_BYTES - head - 2;
    const exact = creation(1, "y".repeat(fill));
    expect(exact.length).toBe(CANONICAL_DIFF_BYTES);
    expect(ok(parsePatch(bytes(exact), bytes("f"))).hunks).toHaveLength(1);
    expect(parsePatch(bytes(creation(1, "y".repeat(fill + 1))), bytes("f"))).toEqual(limited("CANONICAL_DIFF_BYTES") as PatchResult);
  });

  test("the first reached bound wins: line 20,001 after byte 4 MiB gives CANONICAL_DIFF_BYTES", () => {
    const wide = "y".repeat(Math.ceil(CANONICAL_DIFF_BYTES / CANONICAL_DIFF_LINES));
    expect(parsePatch(bytes(creation(CANONICAL_DIFF_LINES, wide)), bytes("f"))).toEqual(limited("CANONICAL_DIFF_BYTES") as PatchResult);
  });

  test("a bound wins over a malformed body", () => {
    const text = creation(CANONICAL_DIFF_LINES - 5).replace("@@ -0,0 +1,", "@@ -0,0 +2,");
    expect(parsePatch(bytes(text), bytes("f"))).toEqual(limited("CANONICAL_DIFF_LINES") as PatchResult);
  });
});

// git-diff(1) "Other diff formats", `--numstat` with `-z`: added, TAB, deleted, TAB, then `path NUL`, or `NUL preimage NUL postimage NUL` for two paths.
describe("numstat -z records", () => {
  const BINARY: NumstatResult = { ok: true, binary: true };
  const TEXT: NumstatResult = { ok: true, binary: false };
  const DEV_NULL = bytes("/dev/null");

  test("two `-` fields mean binary, and two decimal counts mean text", () => {
    expect(parseNumstat(bytes("-\t-\thb.dat\0"), bytes("hb.dat"), null)).toEqual(BINARY);
    expect(parseNumstat(bytes("1\t1\tcr.txt\0"), bytes("cr.txt"), null)).toEqual(TEXT);
    expect(parseNumstat(bytes("0\t0\te.txt\0"), bytes("e.txt"), null)).toEqual(TEXT);
    expect(parseNumstat(bytes("-\t-\t\0/dev/null\0u.bin\0"), bytes("u.bin"), DEV_NULL)).toEqual(BINARY);
    expect(parseNumstat(bytes("1\t0\t\0/dev/null\0u sp.txt\0"), bytes("u sp.txt"), DEV_NULL)).toEqual(TEXT);
  });

  test("an empty output has no change and no binary side", () => {
    expect(parseNumstat(new Uint8Array(), bytes("a.txt"), null)).toEqual(TEXT);
  });

  const cases: [string, string, string, Uint8Array | null][] = [
    ["one `-` and one count", "-\t3\ta\0", "a", null],
    ["a leading zero", "01\t1\ta\0", "a", null],
    ["a sign", "+1\t1\ta\0", "a", null],
    ["a missing TAB", "1 1\ta\0", "a", null],
    ["a missing final NUL", "1\t1\ta", "a", null],
    ["another path", "1\t1\tb\0", "a", null],
    ["a second record", "1\t1\ta\0" + "1\t1\ta\0", "a", null],
    ["a two-path record for a one-path read", "1\t1\t\0/dev/null\0a\0", "a", null],
    ["a one-path record for a two-path read", "1\t1\ta\0", "a", DEV_NULL],
    ["another preimage", "1\t1\t\0nul\0a\0", "a", DEV_NULL],
  ];
  for (const [name, text, path, from] of cases) {
    test(`${name} gives MALFORMED_GIT_OUTPUT`, () => expect(parseNumstat(bytes(text), bytes(path), from)).toEqual(MALFORMED as NumstatResult));
  }
});
