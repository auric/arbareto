// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// plan.md D3 and data-model.md §4: the lane layout as a pure step over the rows of one `rev-list --parents --date-order` stream.
// The lane rules are those of the retired feature 001 renderer layout, except that a limited row closes the free lane slots (plan.md O-5). In a complete stream every parent is a later row, so no lane ends outside the stream.

import { GRAPH_LANES, HISTORY_CHECKPOINT_ROWS as CHECKPOINT_ROWS } from "../contracts/limits";

// 001 plan.md "History graph design": four lane colors.
const COLORS = 4;

export interface LayoutRow {
  oid: string;
  parents: readonly string[];
  // The shallow file lists the commit, so Git shows no parents for it.
  shallow: boolean;
}

export interface Lane {
  readonly oid: string;
  readonly color: number;
}

export type Point = { lane: number; at: "top" | "node" | "bottom" };
export type Segment =
  | { shape: "line"; from: Point; to: Point; color: number }
  // The shallow boundary: a stub below the node.
  | { shape: "stub"; lane: number; color: number };
export type Mark = "root" | "shallow";

export interface Cell {
  node: number;
  color: number;
  merge: boolean;
  // FR-016: the row needs more than GRAPH_LANES lanes. The cell then has a node in lane 0 and no segment.
  limited: boolean;
  segments: Segment[];
  marks: Mark[];
}

export interface LaneState {
  // The lanes below the last row. Each lane holds the parent that it leads to.
  readonly open: readonly (Lane | null)[];
  // The most lanes so far, 1 to GRAPH_LANES (data-model.md §1). It never shrinks (FR-016).
  readonly lanes: number;
}

export const EMPTY_STATE: LaneState = { open: [], lanes: 1 };

/** The cell of `row` and the state after it. The function changes neither argument. */
export function layoutStep(state: LaneState, row: LayoutRow): { cell: Cell; state: LaneState } {
  const input = state.open;
  const work = input.slice();
  const segments: Segment[] = [];
  // Data-model §3: the distinct parents in the order of first occurrence. Git may repeat a parent inside one line.
  const parents = row.parents.length > 1 ? [...new Set(row.parents)] : row.parents;
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
  parents.forEach((parent, k) => {
    let lane = work.findIndex((l) => l?.oid === parent);
    if (lane === -1) {
      // The first parent keeps the node lane and its color.
      lane = k === 0 ? node : free(work);
      work[lane] = { oid: parent, color: k === 0 ? color : pick(work, lane, color) };
    }
    segments.push({ shape: "line", from: { lane: node, at: "node" }, to: { lane, at: "bottom" }, color: work[lane]!.color });
  });
  const marks: Mark[] = parents.length > 0 ? [] : [row.shallow ? "shallow" : "root"];
  if (parents.length === 0 && row.shallow) segments.push({ shape: "stub", lane: node, color });
  while (work.length > 0 && work[work.length - 1] === null) work.pop();

  const width = Math.max(input.length, node + 1, ...segments.map((s) => (s.shape === "stub" ? s.lane : Math.max(s.from.lane, s.to.lane)) + 1));
  const limited = width > GRAPH_LANES;
  const merge = parents.length > 1;
  return {
    // 001 plan.md: a row above the limit has a node in one lane, with no edge. The state keeps the lane of every parent.
    // A limited row draws no edge, so its output closes the free slots and keeps the lane order.
    cell: limited ? { node: 0, color: 0, merge, limited, segments: [], marks } : { node, color, merge, limited, segments, marks },
    state: { open: limited ? work.filter((lane) => lane !== null) : work, lanes: Math.min(GRAPH_LANES, Math.max(state.lanes, width)) },
  };
}

/** The lanes of one stream: the state after the loaded rows and a checkpoint every CHECKPOINT_ROWS rows. `rowAt` reads a loaded row. */
export class HistoryLayout {
  private readonly checkpoints: LaneState[] = [EMPTY_STATE];
  private state = EMPTY_STATE;
  private loaded = 0;

  constructor(private readonly rowAt: (index: number) => LayoutRow) {}

  get rows(): number {
    return this.loaded;
  }

  /** The most lanes over the loaded rows (data-model.md §1). */
  get lanes(): number {
    return this.state.lanes;
  }

  /** Steps the state to `rows` loaded rows. */
  extend(rows: number): void {
    while (this.loaded < rows) {
      this.state = layoutStep(this.state, this.rowAt(this.loaded)).state;
      this.loaded++;
      if (this.loaded % CHECKPOINT_ROWS === 0) this.checkpoints.push(this.state);
    }
  }

  /** The cells of rows `start` to `end - 1`, rebuilt from the checkpoint at ⌊start/256⌋·256 (plan.md D3). */
  cellsOf(range: { start: number; end: number }): Cell[] {
    const { start, end } = range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > this.loaded) {
      throw new RangeError(`rows ${start} to ${end} are outside the ${this.loaded} loaded rows`);
    }
    const first = Math.floor(start / CHECKPOINT_ROWS);
    let state = this.checkpoints[first]!;
    const cells: Cell[] = [];
    for (let i = first * CHECKPOINT_ROWS; i < end; i++) {
      const step = layoutStep(state, this.rowAt(i));
      if (i >= start) cells.push(step.cell);
      state = step.state;
    }
    return cells;
  }
}

/** The lowest free lane. */
function free(work: (Lane | null)[]): number {
  const i = work.indexOf(null);
  return i === -1 ? work.length : i;
}

/** The lowest color that differs from the left neighbor, the right neighbor, and the originating lane. Four colors always leave one. */
function pick(work: (Lane | null)[], lane: number, origin: number | null): number {
  const taken = [work[lane - 1]?.color, work[lane + 1]?.color, origin];
  return Array.from({ length: COLORS }, (_, c) => c).find((c) => !taken.includes(c))!;
}
