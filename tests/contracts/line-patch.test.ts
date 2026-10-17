// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { parsePatch, type PatchHunk } from "../../src/git-service/diff-parser";
import { applyToContent } from "../../src/git-service/hunk-candidate";
import { subHunk, type LineRefusal } from "../../src/git-service/line-patch";

printOrigin("../../src/git-service/line-patch.ts", import.meta.dir);

// Contract Δ4, data-model §6, plan.md D8, and research.md R11, R21 F25 (T009).
// The patches are `diff-files -p` output of Git 2.56.0.windows.2 for the staging-hunks fixture of `tests/git/workbench-fixtures.ts`.
// A staged patch of the same change has the same hunk. The expected content comes from the selection rule below, not from `src/`.

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join("");
const head = (path: string, index: string) => `diff --git a/${path} b/${path}\nindex ${index}\n--- a/${path}\n+++ b/${path}\n`;

interface Fixture {
  path: string;
  old: string;
  new: string;
  patch: string;
}

const FIXTURES: Fixture[] = [
  {
    path: "added.txt",
    old: TEN,
    new: TEN.replace("line 5\n", "line 5\nadded 1\nadded 2\n"),
    patch: `${head("added.txt", "fa2da6e..ecd91c9 100644")}@@ -3,6 +3,8 @@ line 2\n line 3\n line 4\n line 5\n+added 1\n+added 2\n line 6\n line 7\n line 8\n`,
  },
  {
    path: "removed.txt",
    old: TEN,
    new: TEN.replace("line 5\nline 6\n", ""),
    patch: `${head("removed.txt", "fa2da6e..19d742a 100644")}@@ -2,8 +2,6 @@ line 1\n line 2\n line 3\n line 4\n-line 5\n-line 6\n line 7\n line 8\n line 9\n`,
  },
  {
    path: "mixed.txt",
    old: TEN,
    new: TEN.replace("line 5\nline 6\n", "mixed 5a\nmixed 5b\n"),
    patch: `${head("mixed.txt", "fa2da6e..635c16a 100644")}@@ -2,8 +2,8 @@ line 1\n line 2\n line 3\n line 4\n-line 5\n-line 6\n+mixed 5a\n+mixed 5b\n line 7\n line 8\n line 9\n`,
  },
  {
    path: "single.txt",
    old: "x\n",
    new: "y\n",
    patch: `${head("single.txt", "587be6b..975fbec 100644")}@@ -1 +1 @@\n-x\n+y\n`,
  },
  {
    path: "eof.txt",
    old: "one\ntwo\nthree",
    new: "one\ntwo\nthree changed",
    patch: `${head("eof.txt", "54d55bf..c43d932 100644")}@@ -1,3 +1,3 @@\n one\n two\n-three\n\\ No newline at end of file\n+three changed\n\\ No newline at end of file\n`,
  },
  {
    path: "ctxeof.txt",
    old: "tail\nlast",
    new: "tail changed\nlast",
    patch: `${head("ctxeof.txt", "84c533f..9d3c86f 100644")}@@ -1,2 +1,2 @@\n-tail\n+tail changed\n last\n\\ No newline at end of file\n`,
  },
];

const DELETED = "diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\nindex 71779d2..0000000\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n";
const ADDED = "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..5804e55\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,3 @@\n+n1\n+n2\n+n3\n";

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function parsed(patch: string, path: string): { header: Uint8Array; hunk: PatchHunk } {
  const result = parsePatch(enc(patch), enc(path));
  if (!result.ok || result.patch.hunks.length !== 1) throw new Error(`fixture patch refused: ${path}`);
  return { header: result.patch.header, hunk: result.patch.hunks[0]! };
}

interface Line {
  kind: " " | "-" | "+" | "\\";
  text: string;
}

// The body lines of the patch text, each with its LF. A marker removes the LF of the line before it in the content.
function body(patch: string): Line[] {
  const rows = patch.slice(patch.indexOf("\n@@ ") + 1).split("\n").slice(1, -1);
  return rows.map((row) => ({ kind: row[0] as Line["kind"], text: `${row.slice(1)}\n` }));
}

// Ordinals are 1-based positions in the hunk body (data-model §6).
const changeOrdinals = (lines: Line[]) => lines.flatMap((l, i) => (l.kind === "-" || l.kind === "+" ? [i + 1] : []));

function subsets(ordinals: number[]): number[][] {
  const out: number[][] = [];
  for (let mask = 1; mask < 1 << ordinals.length; mask++) out.push(ordinals.filter((_, i) => (mask & (1 << i)) !== 0));
  return out;
}

// Contract Δ4: stage removes a selected `-` line and adds a selected `+` line in the index.
// Unstage restores a selected `-` line and removes a selected `+` line in the index.
function expected(base: string, patch: string, hunk: PatchHunk, picked: ReadonlySet<number>, direction: "stage" | "unstage"): string {
  const lines = body(patch);
  const region: string[] = [];
  let lastKept = false;
  lines.forEach((l, i) => {
    if (l.kind === "\\") {
      if (lastKept) region[region.length - 1] = region.at(-1)!.slice(0, -1);
      return;
    }
    const selected = picked.has(i + 1);
    lastKept = l.kind === " " || (direction === "stage" ? (l.kind === "-") !== selected : (l.kind === "+") !== selected);
    if (lastKept) region.push(l.text);
  });
  const [start, count] = direction === "stage" ? [hunk.oldStart, hunk.oldCount] : [hunk.newStart, hunk.newCount];
  const all = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const at = count === 0 ? start : start - 1;
  return [...all.slice(0, at), ...region, ...all.slice(at + count)].join("");
}

describe("sub-hunk rules for every selection (contract Δ4)", () => {
  for (const f of FIXTURES) {
    for (const direction of ["stage", "unstage"] as const) {
      test(`${direction} ${f.path}`, () => {
        const { header, hunk } = parsed(f.patch, f.path);
        // Stage applies to the index blob of the old side. Unstage applies the staged hunk in reverse to the index blob of the new side.
        const base = direction === "stage" ? f.old : f.new;
        const ordinals = changeOrdinals(body(f.patch));
        const eof = body(f.patch).some((l) => l.kind === "\\");
        let checked = 0;
        for (const picked of subsets(ordinals)) {
          const result = subHunk(header, hunk, direction, picked);
          if (eof && picked.length < ordinals.length) {
            expect(result).toEqual({ ok: false, code: "UNSUPPORTED_COMPARISON", reason: "eof-newline" });
            continue;
          }
          if (!result.ok) throw new Error(`refused ${JSON.stringify(picked)}: ${JSON.stringify(result)}`);
          const content = applyToContent(enc(base), result.hunk, direction === "unstage");
          expect(content === null ? null : dec(content)).toBe(expected(base, f.patch, hunk, new Set(picked), direction));
          // The header holds the counts of the kept lines in Git's own form, so the 001 parser reads the sub-hunk back.
          const again = parsePatch(new Uint8Array([...header, ...result.hunk.bytes]), enc(f.path));
          expect(again.ok && again.patch.hunks.map(({ oldStart, oldCount, newStart, newCount, digest }) => ({ oldStart, oldCount, newStart, newCount, digest }))).toEqual([
            { oldStart: result.hunk.oldStart, oldCount: result.hunk.oldCount, newStart: result.hunk.newStart, newCount: result.hunk.newCount, digest: result.hunk.digest },
          ]);
          checked++;
        }
        expect(checked).toBeGreaterThan(0);
      });
    }
  }

  test("every + and - line selected gives the retained hunk unchanged", () => {
    for (const f of FIXTURES) {
      const { header, hunk } = parsed(f.patch, f.path);
      for (const direction of ["stage", "unstage"] as const) expect(subHunk(header, hunk, direction, changeOrdinals(body(f.patch)))).toEqual({ ok: true, hunk });
    }
  });
});

describe("header counts and starts", () => {
  const mixed = parsed(FIXTURES[2]!.patch, "mixed.txt");
  const single = parsed(FIXTURES[3]!.patch, "single.txt");
  const text = (r: ReturnType<typeof subHunk>) => (r.ok ? dec(r.hunk.bytes) : JSON.stringify(r));

  test("stage keeps the old side and counts the kept lines", () => {
    // Body: 1-3 context, 4 `-line 5`, 5 `-line 6`, 6 `+mixed 5a`, 7 `+mixed 5b`, 8-10 context.
    expect(text(subHunk(mixed.header, mixed.hunk, "stage", [4, 6]))).toBe("@@ -2,8 +2,8 @@\n line 2\n line 3\n line 4\n-line 5\n line 6\n+mixed 5a\n line 7\n line 8\n line 9\n");
    expect(text(subHunk(mixed.header, mixed.hunk, "stage", [6, 7]))).toBe("@@ -2,8 +2,10 @@\n line 2\n line 3\n line 4\n line 5\n line 6\n+mixed 5a\n+mixed 5b\n line 7\n line 8\n line 9\n");
  });

  test("unstage keeps the new side and counts the kept lines", () => {
    expect(text(subHunk(mixed.header, mixed.hunk, "unstage", [4, 6]))).toBe("@@ -2,8 +2,8 @@\n line 2\n line 3\n line 4\n-line 5\n+mixed 5a\n mixed 5b\n line 7\n line 8\n line 9\n");
    expect(text(subHunk(mixed.header, mixed.hunk, "unstage", [6]))).toBe("@@ -2,7 +2,8 @@\n line 2\n line 3\n line 4\n+mixed 5a\n mixed 5b\n line 7\n line 8\n line 9\n");
  });

  // xdiff `xdl_emit_hunk_hdr`: a count of 0 prints the line before the change, and a count of 1 prints no count.
  test("a side with count 0 takes the start of the line before", () => {
    expect(subHunk(single.header, single.hunk, "stage", [1])).toMatchObject({ ok: true, hunk: { oldStart: 1, oldCount: 1, newStart: 0, newCount: 0 } });
    expect(text(subHunk(single.header, single.hunk, "stage", [1]))).toBe("@@ -1 +0,0 @@\n-x\n");
    expect(text(subHunk(single.header, single.hunk, "stage", [2]))).toBe("@@ -1 +1,2 @@\n x\n+y\n");
    expect(subHunk(single.header, single.hunk, "unstage", [2])).toMatchObject({ ok: true, hunk: { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 } });
    expect(text(subHunk(single.header, single.hunk, "unstage", [2]))).toBe("@@ -0,0 +1 @@\n+y\n");
  });

  test("the sub-hunk keeps the ordinal of the retained hunk and digests its bytes", () => {
    const r = subHunk(mixed.header, mixed.hunk, "stage", [4]);
    if (!r.ok) throw new Error("refused");
    expect(r.hunk.ordinal).toBe(mixed.hunk.ordinal);
    expect(r.hunk.digest).toBe(new Bun.CryptoHasher("sha256").update(r.hunk.bytes).digest("hex"));
  });

  test("a partial selection of a new untracked file stages those lines", () => {
    const { header, hunk } = parsed(ADDED, "new.txt");
    const r = subHunk(header, hunk, "stage", [2]);
    expect(text(r)).toBe("@@ -0,0 +1 @@\n+n2\n");
    if (!r.ok) throw new Error("refused");
    expect(dec(applyToContent(new Uint8Array(), r.hunk, false)!)).toBe("n2\n");
  });
});

describe("refusals before any apply", () => {
  const mixed = parsed(FIXTURES[2]!.patch, "mixed.txt");
  const eof = parsed(FIXTURES[4]!.patch, "eof.txt");
  const ctxeof = parsed(FIXTURES[5]!.patch, "ctxeof.txt");
  const refusal = (reason: LineRefusal) => ({ ok: false, code: "UNSUPPORTED_COMPARISON", reason }) as const;
  const INVALID = { ok: false, code: "INVALID_REQUEST" } as const;

  test("no + or - line gives context-only", () => {
    expect(subHunk(mixed.header, mixed.hunk, "stage", [])).toEqual(refusal("context-only"));
    expect(subHunk(mixed.header, mixed.hunk, "unstage", [])).toEqual(refusal("context-only"));
  });

  test("a hunk of a deleted file gives deleted-file for every selection", () => {
    const { header, hunk } = parsed(DELETED, "deleted.txt");
    for (const direction of ["stage", "unstage"] as const) {
      expect(subHunk(header, hunk, direction, [1])).toEqual(refusal("deleted-file"));
      expect(subHunk(header, hunk, direction, [])).toEqual(refusal("deleted-file"));
    }
  });

  // apply.c `parse_single_patch`: a new-file patch with old lines fails. Unstage applies the staged addition in reverse, which deletes the file.
  test("unstaging lines of a staged new file gives new-file", () => {
    const { header, hunk } = parsed(ADDED, "new.txt");
    expect(subHunk(header, hunk, "unstage", [2])).toEqual(refusal("new-file"));
    expect(subHunk(header, hunk, "unstage", [1, 2, 3])).toEqual(refusal("new-file"));
    expect(subHunk(header, hunk, "unstage", [])).toEqual(refusal("new-file"));
  });

  // research.md R21 F25: `apply --cached` joins two lines with exit 0, and `applyToContent` computes the same blob.
  test("every partial selection in an end-of-file hunk gives eof-newline, on either side", () => {
    // eof.txt body: 1 ` one`, 2 ` two`, 3 `-three`, 4 marker, 5 `+three changed`, 6 marker.
    for (const direction of ["stage", "unstage"] as const) {
      expect(subHunk(eof.header, eof.hunk, direction, [3])).toEqual(refusal("eof-newline"));
      expect(subHunk(eof.header, eof.hunk, direction, [5])).toEqual(refusal("eof-newline"));
      expect(subHunk(eof.header, eof.hunk, direction, [3, 5])).toEqual({ ok: true, hunk: eof.hunk });
      // ctxeof.txt body: 1 `-tail`, 2 `+tail changed`, 3 ` last`, 4 marker after a context line.
      expect(subHunk(ctxeof.header, ctxeof.hunk, direction, [1])).toEqual(refusal("eof-newline"));
      expect(subHunk(ctxeof.header, ctxeof.hunk, direction, [1, 2])).toEqual({ ok: true, hunk: ctxeof.hunk });
    }
  });

  // data-model §6: ascending unique ordinals of `+` or `-` lines in the body of that retained hunk, 1 to the hunk line count.
  test("an ordinal that names a context line, a marker, or a line outside the hunk gives INVALID_REQUEST", () => {
    const cases: number[][] = [[1], [8], [0], [11], [-1], [4.5], [Number.NaN], [6, 4], [4, 4], [4, 11]];
    for (const lines of cases) expect(subHunk(mixed.header, mixed.hunk, "stage", lines)).toEqual(INVALID);
    expect(subHunk(eof.header, eof.hunk, "stage", [4])).toEqual(INVALID);
    expect(subHunk(eof.header, eof.hunk, "stage", [3, 6])).toEqual(INVALID);
    expect(subHunk(eof.header, eof.hunk, "stage", [7])).toEqual(INVALID);
  });

  test("an invalid ordinal decides before the hunk refusals", () => {
    const { header, hunk } = parsed(DELETED, "deleted.txt");
    expect(subHunk(header, hunk, "stage", [2])).toEqual(INVALID);
    expect(subHunk(eof.header, eof.hunk, "stage", [1, 3])).toEqual(INVALID);
  });
});
