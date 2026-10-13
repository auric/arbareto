// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 002 plan.md P5, D4, and D5. Contract Δ3 `searchHistory`, "Merge into the view", and "Matching probe". Data-model §6 and §7.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GIT_PROCESS_DEADLINE_MS } from "../contracts/limits";
import { MATCHING_PROBE_STREAM, MATCHING_PROBE_TIP, MATCHING_PROBE_WSL_FOLDER } from "../contracts/matching-probe";
import { NATIVE } from "../contracts/native-path";
import { isObjectId, probeImportArgs, probeInitArgs, probeScriptArgs, probeSearchArgs, type ObjectFormat } from "./commands";
import { RunnerRefusal, type Collector, type GitRunner } from "./git-runner";
import { small, type Stop } from "./history";
import { HistoryLayout, type Cell } from "./history-layout";
import { ReducedGraph } from "./history-reduced";
import { grow, type HistoryTopology } from "./history-topology";
import { contextOf, latin1, type ReadTarget } from "./read-steps";

const LF = 0x0a;

export const MATCHING_REMEDY = "Git did not match the probe messages as the search requires. Use a Git build with PCRE2 and a UTF-8 locale. Then search again.";

/** The stdout of a search: one `<oid>` line per match. A malformed line sets `malformed`, and `limited` then stops Git. */
export function matchStream(objectFormat: ObjectFormat, onOid: (oid: string) => void) {
  const width = objectFormat === "sha1" ? 40 : 64;
  let partial = "";
  let bytes = 0;
  let malformed = false;
  return {
    push(chunk: Uint8Array): void {
      bytes += chunk.length;
      for (let at = 0; !malformed && at < chunk.length; ) {
        const lf = chunk.indexOf(LF, at);
        const piece = latin1(chunk.subarray(at, lf === -1 ? chunk.length : lf));
        if (partial.length + piece.length > width) malformed = true;
        else if (lf === -1) {
          partial += piece;
          return;
        } else {
          const line = partial + piece;
          partial = "";
          if (isObjectId(line, objectFormat)) onOid(line);
          else malformed = true;
          at = lf + 1;
        }
      }
    },
    get bytes() {
      return bytes;
    },
    records: 0,
    get limited() {
      return malformed;
    },
    /** A malformed line, or a partial line at the end of the stream. */
    get malformed() {
      return malformed || partial.length > 0;
    },
  };
}

/**
 * One search of one view. Match sequence number q is the q-th match in view order.
 * The match rows rise, so `at: {match}` finds its target by binary search (plan.md D5).
 */
export class SearchMerge {
  private matchRows = new Int32Array(64);
  /** The matches whose rows the view serves. */
  count = 0;
  // Contract Δ3 "Merge into the view": the IDs of the matches whose rows the view does not serve yet, in stream order.
  private queue: number[] = [];
  private head = 0;
  private readonly queued = new Set<number>();
  private served = 0;
  private scanned = 0;
  private processed = 0;
  private ended = false;
  /** Contract Δ3: a break of the match order fails the search with HISTORY_CHANGED reason `order`. */
  broken = false;
  private readonly reduced = new ReducedGraph();
  // The reduced edges of each match as a list: `first[q]` is the newest edge from match q, and `next[e]` is the edge before edge e. -1 ends a list.
  private first = new Int32Array(64).fill(-1);
  private next = new Int32Array(64);
  /** The filter-mode layout over the settled matches (plan.md D4). */
  readonly layout: HistoryLayout;

  constructor(
    private readonly topology: HistoryTopology,
    shallow: (oid: string) => boolean,
    // Contract Δ5 `HISTORY_VIEW_COMMITS`: each match is one row of the view.
    private readonly bound: number,
  ) {
    this.layout = new HistoryLayout((q) => {
      const oid = topology.oid(this.matchRows[q]!);
      return { oid, parents: this.edgesOf(q).map(([to]) => topology.oid(this.matchRows[to]!)), shallow: shallow(oid) };
    });
  }

  /** The matches that wait for their rows. */
  get waiting(): number {
    return this.queue.length - this.head;
  }

  /** True when every match of the stream has its row. */
  get final(): boolean {
    return this.ended && this.waiting === 0;
  }

  /** The rows with a known match state (data-model §6). */
  get known(): number {
    if (this.ended || this.waiting > 0) return this.served;
    return this.count === 0 ? 0 : this.matchRows[this.count - 1]! + 1;
  }

  /** No later reduced edge starts at a match below this number (plan.md D4). */
  get settled(): number {
    return this.reduced.settled();
  }

  /** One OID of the search stream. `served` is the row count that the view serves. */
  add(oid: string, served: number): void {
    if (this.broken) return;
    const id = this.topology.intern(oid);
    if (this.queued.has(id)) return void (this.broken = true);
    const row = this.topology.rowOfId(id);
    if (row >= 0 && row < served) {
      if (this.waiting > 0 || (this.count > 0 && row <= this.matchRows[this.count - 1]!)) return void (this.broken = true);
      return this.record(row);
    }
    if (this.count + this.waiting >= this.bound) return void (this.broken = true);
    this.queue.push(id);
    this.queued.add(id);
  }

  /** Merges the rows that the view serves, and steps the reduced graph over the rows with a known match state. */
  advance(served: number): void {
    this.served = served;
    if (this.broken) return;
    if (this.waiting === 0) this.scanned = served;
    for (; this.scanned < served; this.scanned++) {
      const id = this.topology.idOf(this.scanned);
      if (!this.queued.has(id)) continue;
      // Contract Δ3: a streamed row that is in the queue must be at its head.
      if (this.queue[this.head] !== id) return void (this.broken = true);
      this.queued.delete(id);
      this.head++;
      this.record(this.scanned);
      // The empty queue needs no scan up to `served`. The loop step must not run after it, or row `served` stays unscanned.
      if (this.waiting === 0) {
        this.queue = [];
        this.head = 0;
        this.scanned = served;
        break;
      }
    }
    for (const known = this.known; this.processed < known; this.processed++) {
      const row = this.processed;
      const q = this.reduced.matches;
      const edges = this.reduced.edges;
      this.reduced.step(this.topology.idOf(row), this.topology.parentIdsOf(row), q < this.count && this.matchRows[q] === row);
      for (let e = edges; e < this.reduced.edges; e++) this.link(e);
    }
    this.layout.extend(this.reduced.settled());
  }

  /** The search stream ended with exit 0. Every match OID arrived. */
  endStream(served: number): void {
    this.ended = true;
    this.advance(served);
  }

  /** The match state of `row`, or null while it is not known. */
  stateOf(row: number): boolean | null {
    return row < this.known ? this.seqOf(row) >= 0 : null;
  }

  /** The number of the match at `row`, or -1. */
  seqOf(row: number): number {
    const k = this.lower(row);
    return k < this.count && this.matchRows[k] === row ? k : -1;
  }

  rowOf(q: number): number {
    return this.matchRows[q]!;
  }

  /** Contract Δ3 `at: {match, from}`: the number of the first match at row `from` or later, or of the last match at row `from` or earlier. */
  matchTarget(direction: "next" | "previous", from: number): number | "none" | "unknown" {
    if (direction === "next") {
      const k = this.lower(from);
      return k < this.count ? k : this.final ? "none" : "unknown";
    }
    if (!this.final && from >= this.known) return "unknown";
    const k = this.lower(from + 1) - 1;
    return k >= 0 ? k : "none";
  }

  /** The filter-mode cells of matches `start` to `end - 1`. A match that is not settled has no cell yet. */
  cells(start: number, end: number): (Cell | null)[] {
    const built = Math.min(end, this.layout.rows);
    const cells: (Cell | null)[] = start < built ? this.layout.cellsOf({ start, end: built }).map((cell, i) => this.filterCell(start + i, cell)) : [];
    while (cells.length < end - start) cells.push(null);
    return cells;
  }

  // Spec FR-034: the node-to-bottom segment of an edge that skips commits carries `skip`. A match with Git parents gets no root mark.
  private filterCell(q: number, cell: Cell): Cell {
    const direct = this.edgesOf(q).map(([, d]) => d);
    let k = 0;
    const segments = cell.segments.map((s) => (s.shape === "line" && s.from.at === "node" && !direct[k++] ? { ...s, skip: true as const } : s));
    return { ...cell, segments, marks: this.topology.parentIdsOf(this.matchRows[q]!).length > 0 ? [] : cell.marks };
  }

  // The nearest matching ancestors of match q with their `direct` flags, in stream order.
  private edgesOf(q: number): [number, boolean][] {
    const out: [number, boolean][] = [];
    for (let e = q < this.first.length ? this.first[q]! : -1; e >= 0; e = this.next[e]!) {
      const edge = this.reduced.edgeAt(e);
      out.push([edge.to, edge.direct]);
    }
    return out.reverse();
  }

  private link(e: number): void {
    const { from } = this.reduced.edgeAt(e);
    this.next = grow(this.next, e + 1);
    this.first = grow(this.first, from + 1, -1);
    this.next[e] = this.first[from]!;
    this.first[from] = e;
  }

  private record(row: number): void {
    this.matchRows = grow(this.matchRows, this.count + 1);
    this.matchRows[this.count++] = row;
  }

  // The first match at row `row` or later.
  private lower(row: number): number {
    let low = 0;
    let high = this.count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.matchRows[mid]! < row) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}

/** One probe run: the patterns and the probe commits that the run must list. */
export type ProbeRun = { readonly grep: readonly string[]; readonly matches: readonly string[] };

const sameSet = (found: ReadonlySet<string>, expected: readonly string[]) => found.size === expected.length && expected.every((oid) => found.has(oid));

/**
 * Contract Δ3 "Matching probe" WSL output: for each run, OID lines and then `end <exit code>`.
 * Only exactly two `end 0` lines with nothing after the last give an answer. An `end` line with another exit code gives GIT_FAILED.
 */
function probeOutput(stdout: ReturnType<typeof small>, runs: readonly ProbeRun[]): "pass" | "mismatch" | Stop {
  const lines = latin1(stdout.take()).split("\n");
  if (stdout.limited || lines.pop() !== "") return { failed: "MALFORMED_GIT_OUTPUT" };
  let done = 0;
  let found = new Set<string>();
  let same = true;
  for (const line of lines) {
    if (done === runs.length) return { failed: "MALFORMED_GIT_OUTPUT" };
    if (isObjectId(line, "sha1")) found.add(line);
    else if (line === "end 0") {
      same = sameSet(found, runs[done]!.matches) && same;
      done++;
      found = new Set();
    } else if (/^end [1-9][0-9]*$/.test(line)) return { failed: "GIT_FAILED" };
    else return { failed: "MALFORMED_GIT_OUTPUT" };
  }
  if (done !== runs.length) return { failed: "MALFORMED_GIT_OUTPUT" };
  return same ? "pass" : "mismatch";
}

/**
 * Contract Δ3 "Matching probe". On the service host: a new folder in `os.tmpdir()`, the fixed stream, one run per pattern set, and the removal of the folder.
 * In WSL: one run of the `matchingProbe` script, which creates and removes its own folder in the distro.
 * `mismatch`: every step exited 0, and a run listed other commits. A failed step gives its `Stop`, so the probe gives no answer.
 * `removeFailed` runs when the folder removal on the service host fails.
 */
export async function probeMatching(runner: GitRunner, t: ReadTarget, runs: readonly ProbeRun[], removeFailed: () => void): Promise<"pass" | "mismatch" | Stop> {
  const run = async (args: string[], input: Uint8Array | undefined, stdout: Collector, script?: "matchingProbe"): Promise<number | null | Stop> => {
    if (t.signal.aborted) return { stop: "canceled" };
    try {
      const exit = await runner.run({
        operationId: t.operationId,
        context: contextOf(t.workspace),
        arguments: args,
        ...(input === undefined ? {} : { input }),
        ...(script === undefined ? {} : { script }),
        environmentPolicy: "search",
        limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS },
        stdout,
        stderr: small(),
        signal: t.signal,
      });
      if (t.signal.aborted) return { stop: "canceled" };
      if (exit.deadline !== undefined) return { stop: "deadline" };
      if (exit.diagnosticLimit) return { failed: "OUTPUT_LIMIT" };
      return exit.exitCode;
    } catch (error) {
      if (error instanceof RunnerRefusal) return { failed: error.code };
      if (t.signal.aborted) return { stop: "canceled" };
      throw error;
    }
  };
  if (t.workspace.wsl !== undefined) {
    const stdout = small();
    const args = probeScriptArgs(`${MATCHING_PROBE_WSL_FOLDER}${crypto.randomUUID()}`, MATCHING_PROBE_TIP, runs.map((probe) => probe.grep));
    const exit = await run(args, MATCHING_PROBE_STREAM, stdout, "matchingProbe");
    if (exit !== 0) return typeof exit === "object" && exit !== null ? exit : { failed: "GIT_FAILED" };
    return probeOutput(stdout, runs);
  }
  let dir: string;
  try {
    dir = await mkdtemp(NATIVE.path.join(tmpdir(), "arbareto-probe-"));
  } catch {
    // Contract gap: no code names a failed probe folder. GIT_FAILED is the generic failure of a read.
    return { failed: "GIT_FAILED" };
  }
  try {
    for (const [args, input] of [
      [probeInitArgs(dir), undefined],
      [probeImportArgs(dir), MATCHING_PROBE_STREAM],
    ] as const) {
      const exit = await run(args, input, small());
      if (exit !== 0) return typeof exit === "object" && exit !== null ? exit : { failed: "GIT_FAILED" };
    }
    let same = true;
    for (const probe of runs) {
      const found = new Set<string>();
      const out = matchStream("sha1", (oid) => void found.add(oid));
      const exit = await run(probeSearchArgs(dir, probe.grep), new TextEncoder().encode(`${MATCHING_PROBE_TIP}\n`), out);
      if (exit !== 0) return typeof exit === "object" && exit !== null ? exit : { failed: "GIT_FAILED" };
      if (out.malformed) return { failed: "MALFORMED_GIT_OUTPUT" };
      same &&= sameSet(found, probe.matches);
    }
    return same ? "pass" : "mismatch";
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(removeFailed);
  }
}
