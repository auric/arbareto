// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { ComparisonHunk } from "../../contracts/envelope";
import type { LineActionReason } from "../../contracts/file-action";

// Contract §4: Pierre parses the canonical service patch for display only.
// research.md R9: strict `parsePatchFiles` accepts text without a patch, so this module checks the file and hunk counts itself.

export type HunkMapping = { ok: true; file: FileDiffMetadata; hunkIds: string[] } | { ok: false; code: "DISPLAY_MAPPING_FAILED" };

const FAILED = { ok: false, code: "DISPLAY_MAPPING_FAILED" } as const;

/** Maps each Pierre hunk to the service hunk with the same ordinal and the same header ranges. Any disagreement fails. */
export function mapHunks(patch: string, hunks: readonly ComparisonHunk[]): HunkMapping {
  let files: FileDiffMetadata[];
  try {
    files = parsePatchFiles(patch, undefined, true).flatMap((p) => p.files);
  } catch {
    return FAILED;
  }
  if (files.length !== 1) return FAILED;
  const file = files[0]!;
  if (file.hunks.length !== hunks.length) return FAILED;
  for (let i = 0; i < hunks.length; i++) {
    const shown = file.hunks[i]!;
    const service = hunks[i]!;
    if (service.ordinal !== i || shown.deletionStart !== service.oldStart || shown.deletionCount !== service.oldCount || shown.additionStart !== service.newStart || shown.additionCount !== service.newCount) return FAILED;
  }
  return { ok: true, file, hunkIds: hunks.map((h) => h.hunkId) };
}

// Feature 004 contract Δ4, data-model §6, plan.md D8 and D15 "Line selection".
// A line ordinal is the 1-based position in the hunk body of the canonical patch. A `\` marker line counts, but it is no row.

export type Side = "deletions" | "additions";
/** Pierre `SelectedLineRange`: a start and an end point, each a line number on one side. */
export type LineRange = { start: number; side?: Side; end: number; endSide?: Side };
export type LineRow = { hunk: number; ordinal: number; type: " " | "-" | "+"; old: number | null; new: number | null };
export type Patch = { header: string[]; rows: LineRow[]; markers: ReadonlySet<number> };
export type LinePick = { ok: true; hunk: number; lines: number[] } | { ok: false; reason: LineActionReason };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The rows of every hunk of a one-file canonical patch, in patch order. `markers` holds the hunks with a `\` line. */
export function patchRows(patch: string): Patch {
  const header: string[] = [];
  const rows: LineRow[] = [];
  const markers = new Set<number>();
  let hunk = -1;
  let ordinal = 0;
  let old = 0;
  let next = 0;
  for (const line of patch.split("\n")) {
    const start = HUNK_HEADER.exec(line);
    if (start !== null) {
      hunk++;
      ordinal = 0;
      old = Number(start[1]);
      next = Number(start[2]);
      continue;
    }
    if (hunk < 0) {
      header.push(line);
      continue;
    }
    const type = line[0];
    if (type === "\\") {
      ordinal++;
      markers.add(hunk);
    } else if (type === " " || type === "-" || type === "+") {
      ordinal++;
      rows.push({ hunk, ordinal, type, old: type === "+" ? null : old++, new: type === "-" ? null : next++ });
    }
  }
  return { header, rows, markers };
}

/** The row of a Pierre point. A deletions point names an old line, and any other point a new line. Each number names one row. */
export function rowOf(rows: readonly LineRow[], lineNumber: number, side: Side | undefined): number {
  return side === "deletions" ? rows.findIndex((r) => r.old === lineNumber && r.type !== "+") : rows.findIndex((r) => r.new === lineNumber && r.type !== "-");
}

/** The Pierre point of a row. A context row takes its new line number. */
export const pointOf = (row: LineRow): { lineNumber: number; side: Side } => (row.type === "-" ? { lineNumber: row.old!, side: "deletions" } : { lineNumber: row.new!, side: "additions" });

/** The `+` and `-` rows between the two points of `range`, in all hunks. Null when a point names no row. */
export function changeRows(patch: Patch, range: LineRange): LineRow[] | null {
  const a = rowOf(patch.rows, range.start, range.side);
  const b = rowOf(patch.rows, range.end, range.endSide ?? range.side);
  if (a < 0 || b < 0) return null;
  return patch.rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((r) => r.type !== " ");
}

/**
 * Contract Δ4 and plan.md D8: the ordinals of the selected `+` and `-` lines of one hunk, or the refusal reason.
 * Null when a point names no row: the display disagrees with the canonical patch (contract §4 `DISPLAY_MAPPING_FAILED`).
 * The checks follow the service order (src/git-service/line-patch.ts). Only the renderer gives `several-hunks` and `context-only`.
 */
export function pickLines(patch: Patch, range: LineRange, direction: "stage" | "unstage"): LinePick | null {
  const a = rowOf(patch.rows, range.start, range.side);
  const b = rowOf(patch.rows, range.end, range.endSide ?? range.side);
  if (a < 0 || b < 0) return null;
  const picked = patch.rows.slice(Math.min(a, b), Math.max(a, b) + 1);
  const hunk = picked[0]!.hunk;
  if (picked.some((r) => r.hunk !== hunk)) return { ok: false, reason: "several-hunks" };
  // apply.c `parse_single_patch`: a partial deletion needs a modify header. Unstage applies a staged addition in reverse.
  if (patch.header.some((l) => l.startsWith("deleted file mode "))) return { ok: false, reason: "deleted-file" };
  if (direction === "unstage" && patch.header.some((l) => l.startsWith("new file mode "))) return { ok: false, reason: "new-file" };
  const lines = picked.filter((r) => r.type !== " ").map((r) => r.ordinal);
  if (lines.length === 0) return { ok: false, reason: "context-only" };
  const changes = patch.rows.filter((r) => r.hunk === hunk && r.type !== " ").length;
  // Research.md R21 F25: a part of a hunk with a `\` line refuses. The whole hunk passes.
  if (lines.length !== changes && patch.markers.has(hunk)) return { ok: false, reason: "eof-newline" };
  return { ok: true, hunk, lines };
}

/** Shift+Up and Shift+Down (plan.md D15): move the end of the range by one row. Without a range, the first change row of `from` starts it. */
export function stepRange(patch: Patch, range: LineRange | null, direction: "next" | "previous", from: number): LineRange | null {
  const rows = patch.rows;
  if (rows.length === 0) return null;
  if (range === null) {
    const first = rows.findIndex((r) => r.hunk === from && r.type !== " ");
    const at = first >= 0 ? first : Math.max(0, rows.findIndex((r) => r.hunk === from));
    const p = pointOf(rows[at]!);
    return { start: p.lineNumber, side: p.side, end: p.lineNumber };
  }
  const end = rowOf(rows, range.end, range.endSide ?? range.side);
  if (end < 0) return range;
  const to = Math.min(rows.length - 1, Math.max(0, end + (direction === "next" ? 1 : -1)));
  const p = pointOf(rows[to]!);
  const side = range.side ?? "additions";
  return { start: range.start, side, end: p.lineNumber, ...(p.side === side ? {} : { endSide: p.side }) };
}
