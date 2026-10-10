// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { HistoryPage, HistoryRow } from "../../contracts/envelope";
import { GRAPH_LANES, GRAPH_PATH_SEGMENTS } from "../../contracts/limits";

// plan.md "History graph design" and data-model.md "History page": one ancestry cell per row from its input and output lanes.

export type BoundaryKind = "outside" | "shallow" | "root";
export const BOUNDARY_TEXT: Record<BoundaryKind, string> = {
  outside: "Outside loaded page",
  shallow: "Shallow history boundary",
  root: "Root commit",
};

// The plan.md lane roles in color index order.
export const LANE_ROLES = ["teal", "sky", "violet", "magenta"] as const;

export type Lane = { oid: string; color: number };
export type Point = { lane: number; at: "top" | "node" | "bottom" };
export type Segment =
  | { shape: "line"; from: Point; to: Point; color: number }
  // The open continuation to an outside-page parent: dashed, from the node to the bottom edge.
  | { shape: "continuation"; from: Point; to: Point; color: number }
  // The shallow boundary: a stub below the node that ends in two bars.
  | { shape: "stub"; lane: number; color: number };
export type Mark = { kind: BoundaryKind; text: string; parent: string | null };

export interface Cell {
  oid: string;
  node: number;
  color: number;
  merge: boolean;
  input: (Lane | null)[];
  output: (Lane | null)[];
  segments: Segment[];
  // Parent text for the accessible name and the inspector. A layout limit keeps it.
  marks: Mark[];
  // A row without parents on a page with shallow boundaries, when the page cannot tell a root from a shallow commit.
  unresolved: boolean;
}

export interface Layout {
  cells: Cell[];
  lanes: number;
  limit: { code: "GRAPH_LAYOUT_LIMITED"; reached: "lanes" | "segments" } | null;
}

const mark = (kind: BoundaryKind, parent: string | null): Mark => ({ kind, text: BOUNDARY_TEXT[kind], parent });

/** Lays out the rows in service order. The same page gives the same layout. */
export function layoutHistory(page: { rows: readonly Pick<HistoryRow, "oid" | "parents">[]; boundaries: HistoryPage["boundaries"] }): Layout {
  const { rows } = page;
  const loaded = new Set(rows.map((r) => r.oid));
  // The last child row of each outside-page parent draws its one open continuation.
  const lastChild = new Map<string, number>();
  rows.forEach((row, at) => row.parents.forEach((p) => loaded.has(p) || lastChild.set(p, at)));
  // Contract §3 rows carry no shallow flag. `boundaries.shallow` holds the hidden parents of the shallow rows, and a shallow row has no effective parent.
  // So with no hidden parent, a row without parents is a root. With one row without parents, that row holds the hidden parents.
  const parentless = rows.filter((r) => r.parents.length === 0).length;
  const end: BoundaryKind | null = page.boundaries.shallow.length === 0 ? "root" : parentless === 1 ? "shallow" : null;

  let lanes: (Lane | null)[] = [];
  let width = 0;
  let count = 0;
  const cells: Cell[] = rows.map((row, at) => {
    const input = lanes;
    const work = input.slice();
    const segments: Segment[] = [];
    const marks: Mark[] = [];
    const into = input.flatMap((lane, i) => (lane?.oid === row.oid ? [i] : []));
    let node: number;
    let color: number;
    if (into.length > 0) {
      node = into[0]!;
      color = input[node]!.color;
      for (const i of into) {
        segments.push({ shape: "line", from: { lane: i, at: "top" }, to: { lane: node, at: "node" }, color: input[i]!.color });
        work[i] = null;
      }
    } else {
      node = free(work);
      color = pick(work, node, null);
    }
    input.forEach((lane, i) => {
      if (lane !== null && lane.oid !== row.oid) segments.push({ shape: "line", from: { lane: i, at: "top" }, to: { lane: i, at: "bottom" }, color: lane.color });
    });

    row.parents.forEach((parent, k) => {
      const outside = !loaded.has(parent);
      if (outside) marks.push(mark("outside", parent));
      let lane = work.findIndex((l) => l?.oid === parent);
      if (lane === -1) {
        // The first parent keeps the node lane and its color.
        lane = k === 0 ? node : free(work);
        work[lane] = { oid: parent, color: k === 0 ? color : pick(work, lane, color) };
      }
      const shape = outside && lastChild.get(parent) === at ? "continuation" : "line";
      segments.push({ shape, from: { lane: node, at: "node" }, to: { lane, at: "bottom" }, color: work[lane]!.color });
    });
    if (row.parents.length === 0 && end !== null) {
      marks.push(mark(end, null));
      if (end === "shallow") segments.push({ shape: "stub", lane: node, color });
    }
    // Lanes of outside-page parents end at their continuation.
    work.forEach((lane, i) => {
      if (lane !== null && !loaded.has(lane.oid) && lastChild.get(lane.oid) === at) work[i] = null;
    });
    while (work.length > 0 && work[work.length - 1] === null) work.pop();

    const reach = segments.map((s) => (s.shape === "stub" ? s.lane : Math.max(s.from.lane, s.to.lane)) + 1);
    width = Math.max(width, input.length, node + 1, ...reach);
    count += segments.length;
    lanes = work;
    return { oid: row.oid, node, color, merge: row.parents.length > 1, input, output: work, segments, marks, unresolved: row.parents.length === 0 && end === null };
  });

  const reached = width > GRAPH_LANES ? "lanes" : count > GRAPH_PATH_SEGMENTS ? "segments" : null;
  if (reached === null) return { cells, lanes: width, limit: null };
  // plan.md: the whole page switches to node-only cells in one lane, with no edge or boundary mark.
  return {
    cells: cells.map((cell) => ({ ...cell, node: 0, color: 0, input: [], output: [], segments: [] })),
    lanes: 1,
    limit: { code: "GRAPH_LAYOUT_LIMITED", reached },
  };
}

/** The lowest free lane. */
function free(work: (Lane | null)[]): number {
  const i = work.indexOf(null);
  return i === -1 ? work.length : i;
}

/** The lowest color that differs from the left neighbor, the right neighbor, and the originating lane. Four colors always leave one. */
function pick(work: (Lane | null)[], lane: number, origin: number | null): number {
  const taken = [work[lane - 1]?.color, work[lane + 1]?.color, origin];
  return LANE_ROLES.findIndex((_, c) => !taken.includes(c));
}
