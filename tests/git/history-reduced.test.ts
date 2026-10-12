// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T013: the filter-mode reduced graph against a brute-force BFS oracle (plan.md P1 and D4, data-model.md §7, spec FR-033, FR-034, SC-008).

import { expect, test } from "bun:test";
import { ReducedGraph } from "../../src/git-service/history-reduced";
import { printOrigin } from "../origin";
import { PERF_CACHE_ROOT } from "../windows/perf-fixtures";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { buildSmallFixtures, H200K, largeCase, largeFixture, rng, shallowCommits, startPoints } from "./history-fixtures";
import { VIEW } from "./history-order-facts";

printOrigin("../../src/git-service/history-reduced.ts", import.meta.dir);

const TASK = "T013";
const SMALL_TIMEOUT_MS = 300_000;
const LARGE_TIMEOUT_MS = 60 * 60_000;
// The chunk sizes of the random feed. A chunk end is a point where the test checks the settled prefix.
const MAX_CHUNK = 300;

interface Rows {
  oids: string[];
  // Row indices of the Git parents, in Git order.
  parents: number[][];
  shallow: boolean[];
}

interface Tally {
  matches: number;
  edges: number;
  skips: number;
  noEarlier: number;
  roots: number;
  boundaries: number;
  stepMs: number;
}

// The FR-033 definition by brute force: from each match, walk the parent paths and stop at the first match on each path.
function oracle(rows: Rows, match: boolean[]): Map<number, Map<number, boolean>> {
  const nearest = new Map<number, Map<number, boolean>>();
  for (let m = 0; m < rows.oids.length; m++) {
    if (!match[m]) continue;
    const found = new Map<number, boolean>();
    const seen = new Set<number>();
    const queue = [...rows.parents[m]!];
    while (queue.length > 0) {
      const x = queue.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      if (match[x]) found.set(x, rows.parents[m]!.includes(x));
      else queue.push(...rows.parents[x]!);
    }
    nearest.set(m, found);
  }
  return nearest;
}

// True when match row `m` reaches a row at or after `processed` through processed rows that do not match.
function reachesUnprocessed(rows: Rows, match: boolean[], m: number, processed: number): boolean {
  const seen = new Set<number>();
  const queue = [...rows.parents[m]!];
  while (queue.length > 0) {
    const x = queue.pop()!;
    if (x >= processed) return true;
    if (seen.has(x) || match[x]) continue;
    seen.add(x);
    queue.push(...rows.parents[x]!);
  }
  return false;
}

function prove(label: string, rows: Rows, match: boolean[], seed: number): Tally {
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };
  const expected = oracle(rows, match);
  // The row of each match sequence number.
  const rowOf = match.flatMap((x, i) => (x ? [i] : []));
  const emitted = rowOf.map(() => new Map<number, boolean>());
  const graph = new ReducedGraph();
  const random = rng(seed);
  let settled = 0;
  let edges = 0;
  let stepMs = 0;
  for (let processed = 0; processed < rows.oids.length; ) {
    const end = Math.min(rows.oids.length, processed + 1 + Math.floor(random() * MAX_CHUNK));
    const before = performance.now();
    for (; processed < end; processed++) graph.step(processed, rows.parents[processed]!, match[processed]!);
    stepMs += performance.now() - before;
    for (; edges < graph.edges; edges++) {
      const e = graph.edgeAt(edges);
      if (e.from < settled) fail(`edge ${JSON.stringify(e)} starts below the settled prefix ${settled}`);
      if (emitted[e.from]!.has(rowOf[e.to]!)) fail(`edge ${JSON.stringify(e)} repeats`);
      emitted[e.from]!.set(rowOf[e.to]!, e.direct);
    }
    const now = graph.settled();
    if (now < settled || now > graph.matches) fail(`the settled prefix goes from ${settled} to ${now} with ${graph.matches} matches`);
    // plan.md D4: a settled match has all its edges.
    for (; settled < now; settled++) {
      const m = rowOf[settled]!;
      if (!Bun.deepEquals(sorted(emitted[settled]!), sorted(expected.get(m)!))) fail(`settled match ${settled} (row ${m}) has edges ${JSON.stringify(sorted(emitted[settled]!))}, the oracle gives ${JSON.stringify(sorted(expected.get(m)!))}`);
    }
    // plan.md D4: the first match that is not settled can still get an edge.
    if (now < graph.matches && !reachesUnprocessed(rows, match, rowOf[now]!, processed)) fail(`match ${now} after row ${processed - 1} has all its edges, but it is not settled`);
  }
  if (settled !== rowOf.length || graph.matches !== rowOf.length) fail(`${settled} settled of ${graph.matches} processed matches, ${rowOf.length} expected`);

  const tally: Tally = { matches: rowOf.length, edges: graph.edges, skips: 0, noEarlier: 0, roots: 0, boundaries: 0, stepMs };
  rowOf.forEach((m, q) => {
    for (const direct of emitted[q]!.values()) if (!direct) tally.skips++;
    const none = expected.get(m)!.size === 0;
    const parentless = rows.parents[m]!.length === 0;
    // data-model.md §7: "No earlier matching commit", except for a true root or a shallow boundary.
    if (graph.noEarlier(q) !== (none && !parentless)) fail(`match ${q} (row ${m}): noEarlier ${graph.noEarlier(q)}, ${expected.get(m)!.size} nearest, ${rows.parents[m]!.length} parents`);
    if (none && !parentless) tally.noEarlier++;
    if (parentless && rows.shallow[m]) tally.boundaries++;
    else if (parentless) tally.roots++;
  });
  expect(() => graph.edgeAt(graph.edges)).toThrow(RangeError);
  return tally;
}

function sorted(edges: Map<number, boolean>): [number, boolean][] {
  return [...edges].sort((a, b) => a[0] - b[0]);
}

// Seeded random match sets, plus the empty and the full set. One set also holds every row without parents.
function matchSets(rows: Rows, seed: number): { name: string; match: boolean[] }[] {
  const n = rows.oids.length;
  const random = rng(seed);
  const share = (p: number) => Array.from({ length: n }, () => random() < p);
  const single = Math.floor(random() * n);
  return [
    { name: "none", match: share(0) },
    { name: "all", match: share(1) },
    { name: "one", match: Array.from({ length: n }, (_, i) => i === single) },
    { name: "p0.5", match: share(0.5) },
    { name: "p0.1", match: share(0.1) },
    { name: "p0.01", match: share(0.01) },
    { name: "p0.3+parentless", match: share(0.3).map((x, i) => x || rows.parents[i]!.length === 0) },
  ];
}

describeGit("history reduced graph", (git) => {
  useFixtureRoot();

  function rowsOf(root: string, repo: string): Rows {
    const boundary = shallowCommits(git, root, repo);
    const lines = ownedGit(git, root, repo, VIEW, { input: Buffer.from(startPoints(git, root, repo).map((p) => `${p}\n`).join("")) }).toString("latin1").split("\n").filter((l) => l !== "").map((l) => l.split(" "));
    const index = new Map(lines.map(([oid], i) => [oid!, i]));
    return {
      oids: lines.map(([oid]) => oid!),
      parents: lines.map(([, ...parents]) => parents.map((p) => index.get(p) ?? -1)),
      shallow: lines.map(([oid]) => boundary.has(oid!)),
    };
  }

  function check(label: string, rows: Rows, seed: number): Tally {
    for (const [i, ps] of rows.parents.entries()) if (ps.includes(-1) || ps.some((p) => p <= i)) throw new Error(`${label}: row ${i} has a parent outside the later rows`);
    const total: Tally = { matches: 0, edges: 0, skips: 0, noEarlier: 0, roots: 0, boundaries: 0, stepMs: 0 };
    const started = performance.now();
    const sets = matchSets(rows, seed);
    for (const { name, match } of sets) {
      const t = prove(`${label} ${name}`, rows, match, seed);
      for (const k of Object.keys(total) as (keyof Tally)[]) total[k] += t[k];
    }
    console.log(`OBSERVATION ${TASK}: ${label}: ${rows.oids.length} rows, ${sets.length} match sets (${sets.map((s) => s.name).join(", ")}); ${total.matches} matches, ${total.edges} reduced edges equal the BFS oracle (${total.skips} skip commits); ${total.noEarlier} show "No earlier matching commit"; ${total.roots} matching roots, ${total.boundaries} matching shallow boundaries; ${Math.round(total.stepMs)} ms in step; ${Math.round(performance.now() - started)} ms with the oracle checks`);
    return total;
  }

  test("every small fixture: the reduced edges equal the BFS oracle, and the settled prefix holds", () => {
    const total: Tally = { matches: 0, edges: 0, skips: 0, noEarlier: 0, roots: 0, boundaries: 0, stepMs: 0 };
    for (const f of buildSmallFixtures(git, "t013")) {
      const t = check(f.name, rowsOf(FIXTURE_ROOT, f.repo), 13);
      for (const k of Object.keys(total) as (keyof Tally)[]) total[k] += t[k];
    }
    // Each case of the oracle shows at least once.
    expect({ edges: total.edges > 0, skips: total.skips > 0, noEarlier: total.noEarlier > 0, roots: total.roots > 0, boundaries: total.boundaries > 0 }).toEqual({ edges: true, skips: true, noEarlier: true, roots: true, boundaries: true });
  }, SMALL_TIMEOUT_MS);

  largeCase(TASK, "H200K: the reduced edges equal the BFS oracle, and the settled prefix holds", H200K, () => {
    check(H200K.name, rowsOf(PERF_CACHE_ROOT, largeFixture(git, H200K, false).repo), 200);
  }, LARGE_TIMEOUT_MS);
});
