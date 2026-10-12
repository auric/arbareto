// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The P0.2 order facts of T003 and T010 (plan.md P0.2, research.md R1 and R4). The caller gives the Git run, so Windows Git and distro Git share the facts.
// A fact that fails is a finding, not a red test (tasks.md "Test harness rules"). It prints an OBSERVATION line.

import { expect } from "bun:test";
import { rng } from "./history-fixtures";

// Contract Δ3 `loadHistory` and `searchHistory`.
export const VIEW = ["--no-lazy-fetch", "--no-optional-locks", "rev-list", "--parents", "--date-order", "--stdin"];
export const searchArgs = (...words: string[]) => ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "-c", "i18n.logOutputEncoding=UTF-8", "rev-list", "--date-order", "--fixed-strings", "--regexp-ignore-case", ...words.map((w) => `--grep=${w}`), "--stdin"];

export const FACTS = [
  "two runs give the same bytes",
  "--skip=k equals the suffix",
  "the output is equal with and without a commit-graph",
  "a shuffled stdin gives the same bytes",
  "a reversed stdin gives the same bytes",
  "--grep equals the full order without the non-matches",
] as const;
export type Fact = (typeof FACTS)[number];

export class FactLog {
  readonly results = new Map<Fact, { held: string[]; failed: string[] }>(FACTS.map((f) => [f, { held: [], failed: [] }]));
  readonly notes: string[] = [];
  constructor(readonly task: string) {}

  record(fact: Fact, where: string, held: boolean): void {
    this.results.get(fact)![held ? "held" : "failed"].push(where);
    if (!held) console.log(`OBSERVATION ${this.task}: ${where}: the fact "${fact}" failed (experiment)`);
  }

  report(): void {
    for (const [fact, { held, failed }] of this.results) {
      console.log(`OBSERVATION ${this.task}: "${fact}" held on ${held.length} of ${held.length + failed.length} fixture runs (experiment)${failed.length > 0 ? `; failed on: ${failed.join("; ")}` : ""}`);
    }
    console.log(`OBSERVATION ${this.task}: the --skip runs: ${this.results.get("--skip=k equals the suffix")!.held.join("; ")}`);
    for (const note of this.notes) console.log(`OBSERVATION ${this.task}: ${note}`);
  }
}

export interface FactSubject {
  label: string;
  // Runs Git with `args` and the start points on stdin, one per line. Returns stdout. `search` selects the `search` policy.
  run: (args: string[], starts: string[], search?: boolean) => Buffer;
  starts: string[];
  searchArgs: string[];
  // The expected `--grep` OIDs in full-history order, or the expected match count.
  matches: (oids: string[]) => string[] | number;
}

// Byte offset and parent count of each LF-ended line.
export function linesOf(out: Buffer): { starts: number[]; parents: number[]; oids: string[] } {
  const starts: number[] = [];
  const parents: number[] = [];
  const oids: string[] = [];
  for (let at = 0; at < out.length; ) {
    const end = out.indexOf(0x0a, at);
    if (end === -1) throw new Error(`the output does not end with LF at byte ${at}`);
    const line = out.subarray(at, end);
    starts.push(at);
    oids.push(line.subarray(0, line.indexOf(0x20) === -1 ? line.length : line.indexOf(0x20)).toString("latin1"));
    let spaces = 0;
    for (const b of line) if (b === 0x20) spaces++;
    parents.push(spaces);
    at = end + 1;
  }
  return { starts, parents, oids };
}

// git-rev-list(1) "--date-order": no parent shows before all of its children. Each commit shows once.
export function checkDocumentedOrder(out: Buffer, where: string): void {
  const text = out.toString("latin1").split("\n").slice(0, -1);
  const index = new Map(text.map((l, i) => [l.slice(0, l.indexOf(" ") === -1 ? l.length : l.indexOf(" ")), i]));
  expect({ where, unique: index.size }).toEqual({ where, unique: text.length });
  text.forEach((l, i) => {
    for (const parent of l.split(" ").slice(1)) {
      const at = index.get(parent);
      if (at === undefined || at <= i) throw new Error(`${where}: row ${i} has parent ${parent} at ${at ?? "no row"}`);
    }
  });
}

// Runs every fact on one subject. Returns the full output for the commit-graph comparison.
export function orderFacts(s: FactSubject, log: FactLog): Buffer {
  const { label, run, starts } = s;
  const full = run(VIEW, starts);
  checkDocumentedOrder(full, label);
  const rows = linesOf(full);
  const n = rows.starts.length;

  log.record("two runs give the same bytes", label, run(VIEW, starts).equals(full));

  const fixed = [1, 255, 256, 257, n - 1];
  const mergeRun = rows.parents.findIndex((p, i) => i > 0 && !fixed.includes(i) && p >= 2 && rows.parents[i - 1]! >= 2 && (rows.parents[i + 1] ?? 0) >= 2);
  const ks = [...new Set([...fixed, mergeRun])].filter((k) => k > 0 && k < n).sort((a, b) => a - b);
  const skipped = ks.filter((k) => !run([...VIEW, `--skip=${k}`], starts).equals(full.subarray(rows.starts[k])));
  log.record("--skip=k equals the suffix", `${label} k in {${ks.join(", ")}}${mergeRun > 0 ? ` (merge run at ${mergeRun})` : ""}`, skipped.length === 0);
  if (skipped.length > 0) console.log(`OBSERVATION ${log.task}: ${label}: --skip differs from the suffix for k = ${skipped.join(", ")}`);

  const random = rng(42);
  const shuffled = [...starts];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  for (const [fact, order] of [["a shuffled stdin gives the same bytes", shuffled], ["a reversed stdin gives the same bytes", [...starts].reverse()]] as const) {
    const other = run(VIEW, order);
    log.record(fact, `${label} (${starts.length} start points)`, other.equals(full));
    if (other.equals(full)) continue;
    checkDocumentedOrder(other, `${label} ${fact}`);
    const sorted = (b: Buffer) => b.toString("latin1").split("\n").sort().join("\n");
    const first = linesOf(other).oids.findIndex((oid, i) => oid !== rows.oids[i]);
    console.log(`OBSERVATION ${log.task}: ${label}: with another stdin order the rows ${sorted(other) === sorted(full) ? "are the same set" : "differ as a set"}, and the order first differs at row ${first}`);
  }

  const found = linesOf(run(s.searchArgs, starts, true)).oids;
  const inFound = new Set(found);
  const subsequence = rows.oids.filter((oid) => inFound.has(oid));
  const expected = s.matches(rows.oids);
  const setHeld = typeof expected === "number" ? found.length === expected : JSON.stringify(found) === JSON.stringify(expected);
  log.record("--grep equals the full order without the non-matches", `${label} (${found.length} of ${n} rows match)`, JSON.stringify(found) === JSON.stringify(subsequence));
  // The match set is the matching probe's subject (T004). Here it only shows that the word reached Git.
  expect({ where: label, matchSet: setHeld }).toEqual({ where: label, matchSet: true });

  if (n === 0) log.notes.push(`${label}: rev-list --stdin with no start point exits 0 and prints nothing (experiment)`);
  return full;
}
