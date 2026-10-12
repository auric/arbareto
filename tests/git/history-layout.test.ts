// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T005: the layout equivalence proof (plan.md P0.3 and D3, data-model.md §4, spec FR-011, FR-014, FR-015, FR-016, SC-004).

import { expect, test } from "bun:test";
import { GRAPH_LANES } from "../../src/contracts/limits";
import { CHECKPOINT_ROWS, EMPTY_STATE, HistoryLayout, layoutStep, type Cell, type LaneState, type LayoutRow } from "../../src/git-service/history-layout";
import { printOrigin } from "../origin";
import { PERF_CACHE_ROOT } from "../windows/perf-fixtures";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { buildSmallFixtures, H200K, largeCase, largeFixture, repositoryDigest, rng, shallowCommits, startPoints, type SmallName } from "./history-fixtures";
import { VIEW } from "./history-order-facts";

printOrigin("../../src/git-service/history-layout.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);

const TASK = "T005";
const SMALL_TIMEOUT_MS = 300_000;
const LARGE_TIMEOUT_MS = 60 * 60_000;
// The chunk sizes of the random feed.
const MAX_CHUNK = 700;

interface Proof {
  rows: number;
  limited: number;
  // Lanes that end at their parent node through the cell lines.
  traced: number;
  // Lanes that end at a limited parent row, and edges that start at a limited row.
  atLimited: number;
  handed: number;
  roots: number;
  shallow: number;
  lanes: number;
}

interface Folded {
  cell: Cell;
  before: LaneState;
  after: LaneState;
}

// One pass of `layoutStep` over all rows, one row per call. Each input state is frozen, so a step that changes its input throws.
function fold(rows: readonly LayoutRow[]): () => Folded {
  let state = EMPTY_STATE;
  let at = 0;
  return () => {
    for (const lane of state.open) if (lane !== null) Object.freeze(lane);
    Object.freeze(state.open);
    Object.freeze(state);
    const step = layoutStep(state, rows[at++]!);
    const folded = { cell: step.cell, before: state, after: step.state };
    state = step.state;
    return folded;
  };
}

function sameCell(at: number, rebuilt: Cell | undefined, folded: Cell, how: string): void {
  if (!Bun.deepEquals(rebuilt, folded, true)) throw new Error(`row ${at}: ${how} ${JSON.stringify(rebuilt)} differs from the fold ${JSON.stringify(folded)}`);
}

function prove(label: string, rows: readonly LayoutRow[]): Proof {
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };
  const proof: Proof = { rows: rows.length, limited: 0, traced: 0, atLimited: 0, handed: 0, roots: 0, shallow: 0, lanes: EMPTY_STATE.lanes };
  const layout = new HistoryLayout((i) => rows[i]!);
  const random = rng(42);
  // Each lane holds the parent that an edge drawn above the row waits for.
  const pending = new Map<number, string>();
  const frontier = new Set<string>();
  const wrongLimit: string[] = [];
  const reference = fold(rows);

  for (let loaded = 0; loaded < rows.length; ) {
    const end = Math.min(rows.length, loaded + 1 + Math.floor(random() * MAX_CHUNK));
    layout.extend(end);
    // The range starts inside a block, so the rebuild starts at the checkpoint ⌊loaded/256⌋·256.
    const cells = layout.cellsOf({ start: loaded, end });
    expect(cells.length).toBe(end - loaded);
    for (let i = loaded; i < end; i++) {
      const row = rows[i]!;
      const { cell, before, after } = reference();
      sameCell(i, cells[i - loaded], cell, "the cell rebuilt from a checkpoint");

      // FR-016 and data-model.md §4: distinct commits need distinct lanes. A row needs the larger of two counts: its open lanes above plus one lane for a new node, and its open lanes below.
      const above = frontier.size + (frontier.has(row.oid) ? 0 : 1);
      frontier.delete(row.oid);
      for (const p of row.parents) frontier.add(p);
      const need = Math.max(above, frontier.size);
      if (cell.limited !== need > GRAPH_LANES) wrongLimit.push(`row ${i} needs ${need} lanes, limited ${cell.limited}`);
      if (after.lanes < before.lanes || after.lanes > GRAPH_LANES) fail(`row ${i}: the lane count goes from ${before.lanes} to ${after.lanes}`);
      proof.lanes = after.lanes;
      if (cell.merge !== row.parents.length > 1) fail(`row ${i}: merge is ${cell.merge}`);

      // FR-015: a row without parents is a root or a shallow boundary, by its mark and by its shape.
      const kind = row.parents.length > 0 ? [] : [row.shallow ? "shallow" : "root"];
      if (!Bun.deepEquals(cell.marks, kind)) fail(`row ${i}: marks ${JSON.stringify(cell.marks)}, expected ${JSON.stringify(kind)}`);
      if (kind[0] === "root") proof.roots++;
      if (kind[0] === "shallow") proof.shallow++;
      const stub = cell.segments.some((s) => s.shape === "stub");
      if (stub !== (kind[0] === "shallow" && !cell.limited)) fail(`row ${i}: stub ${stub} for marks ${JSON.stringify(kind)}`);

      if (cell.limited) {
        // FR-016: a limited row draws no lane. Its edges continue in the lane state, so the parent identities stay.
        proof.limited++;
        if (cell.node !== 0 || cell.segments.length !== 0) fail(`limited row ${i} draws ${JSON.stringify(cell)}`);
        // The lanes below a limited row can move, so the edges follow their parents by OID.
        const waiting = [...pending.values()].filter((parent) => parent !== row.oid);
        proof.atLimited += pending.size - waiting.length;
        pending.clear();
        for (const parent of [...waiting, ...row.parents]) {
          const lane = after.open.findIndex((l) => l?.oid === parent);
          if (lane === -1) fail(`limited row ${i} loses the lane of ${parent}`);
          pending.set(lane, parent);
        }
        proof.handed += row.parents.length;
        continue;
      }

      const reach = Math.max(cell.node, ...cell.segments.map((s) => (s.shape === "stub" ? s.lane : Math.max(s.from.lane, s.to.lane))));
      if (reach >= GRAPH_LANES) fail(`row ${i} reaches lane ${reach} and is not limited`);
      // Every line from the top edge continues an edge from above: down to the node of its parent, or straight down.
      const tops = cell.segments.flatMap((s) => (s.shape === "line" && s.from.at === "top" ? [s] : []));
      for (const s of tops) if (!pending.has(s.from.lane)) fail(`row ${i}: a line starts in lane ${s.from.lane} without an edge above it`);
      for (const [lane, parent] of [...pending]) {
        const s = tops.find((t) => t.from.lane === lane);
        if (s === undefined) fail(`row ${i}: the edge to ${parent} stops in lane ${lane}`);
        else if (s.to.at === "node") {
          if (s.to.lane !== cell.node || row.oid !== parent) fail(`row ${i}: the edge to ${parent} ends at the node of ${row.oid}`);
          pending.delete(lane);
          proof.traced++;
        } else if (s.to.at !== "bottom" || s.to.lane !== lane) fail(`row ${i}: the edge to ${parent} moves from lane ${lane}`);
      }
      // The node-to-bottom segments follow the Git parent order.
      const outs = cell.segments.flatMap((s) => (s.shape === "line" && s.from.at === "node" ? [s] : []));
      if (outs.length !== row.parents.length) fail(`row ${i}: ${outs.length} edges for ${row.parents.length} parents`);
      outs.forEach((s, k) => {
        const parent = row.parents[k]!;
        if (s.from.lane !== cell.node || s.to.at !== "bottom") fail(`row ${i}: edge ${k} does not run from the node to the bottom edge`);
        const held = pending.get(s.to.lane);
        if (held !== undefined && held !== parent) fail(`row ${i}: the edge to ${parent} joins the lane of ${held}`);
        pending.set(s.to.lane, parent);
      });
    }
    loaded = end;
  }
  if (pending.size > 0) fail(`edges never reach their parents: ${JSON.stringify([...pending])}`);
  if (wrongLimit.length > 0) fail(`${wrongLimit.length} rows have the wrong limited flag, first ${wrongLimit[0]}`);

  // Each cell rebuilt from its own checkpoint equals the fold.
  const again = fold(rows);
  for (let start = 0; start < rows.length; start += CHECKPOINT_ROWS) {
    const cells = layout.cellsOf({ start, end: Math.min(rows.length, start + CHECKPOINT_ROWS) });
    cells.forEach((cell, k) => sameCell(start + k, cell, again().cell, "the block rebuilt from its checkpoint"));
  }
  expect(layout.rows).toBe(rows.length);
  expect(() => layout.cellsOf({ start: 0, end: rows.length + 1 })).toThrow(RangeError);
  return proof;
}

describeGit("history layout equivalence", (git) => {
  useFixtureRoot();

  function rowsOf(root: string, repo: string): LayoutRow[] {
    const shallow = shallowCommits(git, root, repo);
    const input = Buffer.from(startPoints(git, root, repo).map((s) => `${s}\n`).join(""));
    return ownedGit(git, root, repo, VIEW, { input }).toString("latin1").split("\n").filter((l) => l !== "").map((l) => {
      const [oid, ...parents] = l.split(" ");
      return { oid: oid!, parents, shallow: shallow.has(oid!) };
    });
  }

  function check(label: string, root: string, repo: string): Proof {
    const before = repositoryDigest(repo);
    const proof = prove(label, rowsOf(root, repo));
    expect(repositoryDigest(repo)).toBe(before);
    console.log(`OBSERVATION ${TASK}: ${label}: ${proof.rows} rows; each cell rebuilt from a checkpoint equals the fold; ${proof.traced} lanes traced through the cells to their parent nodes; ${proof.limited} limited rows start ${proof.handed} edges and end ${proof.atLimited} lanes through the lane state; ${proof.roots} roots, ${proof.shallow} shallow boundaries; ${proof.lanes} lanes`);
    return proof;
  }

  test("every small fixture: cells from checkpoints equal one fold, and edges end at their Git parents", () => {
    const proofs = new Map<SmallName, Proof>(buildSmallFixtures(git, "t005").map((f) => [f.name, check(f.name, FIXTURE_ROOT, f.repo)]));
    for (const [name, p] of proofs) {
      if (name === "tips-50" || name === "octopus-65") expect({ name, limited: p.limited > 0 }).toEqual({ name, limited: true });
      else expect({ name, limited: p.limited, atLimited: p.atLimited }).toEqual({ name, limited: 0, atLimited: 0 });
      if (name === "shallow") expect({ name, shallow: p.shallow }).toEqual({ name, shallow: 1 });
      else if (p.rows > 0) expect({ name, roots: p.roots > 0 }).toEqual({ name, roots: true });
    }
    expect(proofs.get("tips-50")!.lanes).toBe(GRAPH_LANES);
  }, SMALL_TIMEOUT_MS);

  largeCase(TASK, "H200K: cells from checkpoints equal one fold, and edges end at their Git parents", H200K, () => {
    check(H200K.name, PERF_CACHE_ROOT, largeFixture(git, H200K, false).repo);
  }, LARGE_TIMEOUT_MS);
});
