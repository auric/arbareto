// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 data-model §11 and spec FR-056 "Blame before this commit". Pure logic over untrusted Git output.

const LF = 0x0a;
// xdiff `xdl_emit_hunk_hdr`: `@@ -a[,b] +c[,d] @@`, with an omitted count of 1. A function heading can follow.
const HUNK = /^@@ -(0|[1-9][0-9]{0,8})(?:,(0|[1-9][0-9]{0,8}))? \+(0|[1-9][0-9]{0,8})(?:,(0|[1-9][0-9]{0,8}))? @@(?: [^]*)?$/;
// diff.c `builtin_diff` file header lines of two blob arguments.
const FILE_HEADER = /^(?:diff --git |index |--- |\+\+\+ )/;

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

// The hunks of `diff -U0` between two blobs. Each body must hold exactly `b` removed and `d` added lines. Null for any other form.
export function parseHunks(out: Uint8Array): Hunk[] | null {
  if (out.length === 0) return [];
  if (out[out.length - 1] !== LF) return null;
  const lines = Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString("latin1").split("\n");
  lines.pop();
  const hunks: Hunk[] = [];
  let i = 0;
  if (!lines[0]?.startsWith("diff --git ")) return null;
  while (i < lines.length && !lines[i]!.startsWith("@@ ")) {
    if (!FILE_HEADER.test(lines[i]!)) return null;
    i++;
  }
  while (i < lines.length) {
    const m = HUNK.exec(lines[i++]!);
    if (m === null) return null;
    const hunk = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) };
    let removed = 0;
    let added = 0;
    while (i < lines.length && !lines[i]!.startsWith("@@ ")) {
      const c = lines[i++]!.charCodeAt(0);
      if (c === 0x2d && added === 0 && removed < hunk.oldCount) removed++;
      else if (c === 0x2b && added < hunk.newCount) added++;
      // apply.c `adjust_incomplete`: a `\ ` marker line follows the last line of a side.
      else if (c !== 0x5c || removed + added === 0) return null;
    }
    if (removed !== hunk.oldCount || added !== hunk.newCount) return null;
    hunks.push(hunk);
  }
  return hunks;
}

// Spec FR-056: `line` is a line of the new version. A line inside a hunk with new lines maps to the old start, or to the old start plus 1 for a pure insertion.
// Every other line moves by the sum of (old count - new count) of the hunks that end before it. A hunk with new count 0 ends after its new start line,
// because xdiff prints the line before an empty range as its start. The result clamps to 1 and the old line count.
export function mapLine(line: number, hunks: readonly Hunk[], oldLines: number): number {
  const clamp = (n: number) => Math.max(1, Math.min(n, oldLines));
  let shift = 0;
  for (const h of hunks) {
    if (h.newCount > 0 && h.newStart <= line && line < h.newStart + h.newCount) return clamp(h.oldCount === 0 ? h.oldStart + 1 : h.oldStart);
    const end = h.newCount > 0 ? h.newStart + h.newCount - 1 : h.newStart;
    if (end < line) shift += h.oldCount - h.newCount;
  }
  return clamp(line + shift);
}
