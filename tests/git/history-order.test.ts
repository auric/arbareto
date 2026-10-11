// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T003: Git order facts of the history view (plan.md P0.2, research.md R1 and R4).
// A fact that fails is a finding, not a red test (tasks.md "Test harness rules"). The test prints it as an OBSERVATION line.
// The test asserts the documented `--date-order` rule, the commit set, and the unchanged repository bytes (SC-013).

import { expect, test } from "bun:test";
import { PERF_CACHE_ROOT } from "../windows/perf-fixtures";
import { FIXTURE_ROOT, fixtureDir, ownedGit, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { buildSmallFixtures, H1M, H200K, largeCase, largeFixture, MARKER_WORD, repositoryDigest, rng, startPoints, withCommitGraph, type LargeSpec, type SmallFixture } from "./history-fixtures";

// This file imports no `src/` module. `fixture-root.ts` and `history-fixtures.ts` print the ORIGIN lines of the contract files they read.

const TASK = "T003";
const EXPECTED_GIT = "git version 2.56.0.windows.1";
const SMALL_TIMEOUT_MS = 600_000;
const LARGE_TIMEOUT_MS = 60 * 60_000;

// Contract Δ3 `loadHistory` and `searchHistory`.
const VIEW = ["--no-lazy-fetch", "--no-optional-locks", "rev-list", "--parents", "--date-order", "--stdin"];
const SEARCH = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "-c", "i18n.logOutputEncoding=UTF-8", "rev-list", "--date-order", "--fixed-strings", "--regexp-ignore-case", `--grep=${MARKER_WORD}`, "--stdin"];

const FACTS = [
  "two runs give the same bytes",
  "--skip=k equals the suffix",
  "the output is equal with and without a commit-graph",
  "a shuffled stdin gives the same bytes",
  "a reversed stdin gives the same bytes",
  "--grep equals the full order without the non-matches",
] as const;
type Fact = (typeof FACTS)[number];
const results = new Map<Fact, { held: string[]; failed: string[] }>(FACTS.map((f) => [f, { held: [], failed: [] }]));
const notes: string[] = [];

function record(fact: Fact, where: string, held: boolean): void {
  results.get(fact)![held ? "held" : "failed"].push(where);
  if (!held) console.log(`OBSERVATION ${TASK}: ${where}: the fact "${fact}" failed (experiment)`);
}

interface Variant {
  label: string;
  root: string;
  repo: string;
  // The expected `--grep` OIDs in full-history order, or the expected match count.
  matches: (oids: string[]) => string[] | number;
}

// Byte offset and parent count of each LF-ended line.
function linesOf(out: Buffer): { starts: number[]; parents: number[]; oids: string[] } {
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
function checkDocumentedOrder(out: Buffer, where: string): void {
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

describeGit("history order facts", (git) => {
  useFixtureRoot();
  const run = (v: Variant, args: string[], starts: string[]) => ownedGit(git, v.root, v.repo, args, { input: Buffer.from(starts.map((s) => `${s}\n`).join("")) });

  test("the Git version under test", () => {
    const version = ownedGit(git, FIXTURE_ROOT, fixtureDir("t003-version"), ["version"]).toString().trim();
    console.log(`OBSERVATION ${TASK}: ${version}`);
    if (version !== EXPECTED_GIT) console.log(`OBSERVATION ${TASK}: the Git version is not ${EXPECTED_GIT}; record the facts below for ${version}`);
    expect(version.startsWith("git version ")).toBe(true);
  });

  // Runs every fact on one variant. Returns the full output for the commit-graph comparison.
  function facts(v: Variant): Buffer {
    const before = repositoryDigest(v.repo);
    const starts = startPoints(git, v.root, v.repo);
    const full = run(v, VIEW, starts);
    checkDocumentedOrder(full, v.label);
    const rows = linesOf(full);
    const n = rows.starts.length;

    record("two runs give the same bytes", v.label, run(v, VIEW, starts).equals(full));

    const fixed = [1, 255, 256, 257, n - 1];
    const mergeRun = rows.parents.findIndex((p, i) => i > 0 && !fixed.includes(i) && p >= 2 && rows.parents[i - 1]! >= 2 && (rows.parents[i + 1] ?? 0) >= 2);
    const ks = [...new Set([...fixed, mergeRun])].filter((k) => k > 0 && k < n).sort((a, b) => a - b);
    const skipped = ks.filter((k) => !run(v, [...VIEW, `--skip=${k}`], starts).equals(full.subarray(rows.starts[k])));
    record("--skip=k equals the suffix", `${v.label} k in {${ks.join(", ")}}${mergeRun > 0 ? ` (merge run at ${mergeRun})` : ""}`, skipped.length === 0);
    if (skipped.length > 0) console.log(`OBSERVATION ${TASK}: ${v.label}: --skip differs from the suffix for k = ${skipped.join(", ")}`);

    const random = rng(42);
    const shuffled = [...starts];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    for (const [fact, order] of [["a shuffled stdin gives the same bytes", shuffled], ["a reversed stdin gives the same bytes", [...starts].reverse()]] as const) {
      const other = run(v, VIEW, order);
      record(fact, `${v.label} (${starts.length} start points)`, other.equals(full));
      if (other.equals(full)) continue;
      checkDocumentedOrder(other, `${v.label} ${fact}`);
      const sorted = (b: Buffer) => b.toString("latin1").split("\n").sort().join("\n");
      const first = linesOf(other).oids.findIndex((oid, i) => oid !== rows.oids[i]);
      console.log(`OBSERVATION ${TASK}: ${v.label}: with another stdin order the rows ${sorted(other) === sorted(full) ? "are the same set" : "differ as a set"}, and the order first differs at row ${first}`);
    }

    const found = linesOf(run(v, SEARCH, starts)).oids;
    const inFound = new Set(found);
    const subsequence = rows.oids.filter((oid) => inFound.has(oid));
    const expected = v.matches(rows.oids);
    const setHeld = typeof expected === "number" ? found.length === expected : JSON.stringify(found) === JSON.stringify(expected);
    record("--grep equals the full order without the non-matches", `${v.label} (${found.length} of ${n} rows match)`, JSON.stringify(found) === JSON.stringify(subsequence));
    // The match set is the matching probe's subject (T004). Here it only shows that the word reached Git.
    expect({ where: v.label, matchSet: setHeld }).toEqual({ where: v.label, matchSet: true });

    expect(repositoryDigest(v.repo)).toBe(before);
    if (n === 0) notes.push(`${v.label}: rev-list --stdin with no start point exits 0 and prints nothing (experiment)`);
    return full;
  }

  const smallVariant = (f: SmallFixture): Variant => ({
    label: `${f.name}${f.commitGraph ? " with commit-graph" : ""}`,
    root: FIXTURE_ROOT,
    repo: f.repo,
    matches: (oids) => oids.filter((oid) => f.messages.get(oid)!.toString("utf8").toLowerCase().includes(MARKER_WORD)),
  });

  test("small fixtures: order facts with and without a commit-graph", () => {
    for (const f of buildSmallFixtures(git, "t003")) {
      const plain = facts(smallVariant(f));
      const graph = facts(smallVariant(withCommitGraph(git, f)));
      record("the output is equal with and without a commit-graph", f.name, graph.equals(plain));
    }
  }, SMALL_TIMEOUT_MS);

  function large(spec: LargeSpec): void {
    const [plain, graph] = [false, true].map((commitGraph) => {
      const f = largeFixture(git, spec, commitGraph);
      // Every 50th commit has the marker word (`history-fixtures.ts` `largeMessage`).
      return facts({ label: `${spec.name}${commitGraph ? " with commit-graph" : ""}`, root: PERF_CACHE_ROOT, repo: f.repo, matches: () => Math.ceil(spec.commits / 50) });
    });
    record("the output is equal with and without a commit-graph", spec.name, graph!.equals(plain!));
  }

  largeCase(TASK, "H200K: order facts with and without a commit-graph", H200K, () => large(H200K), LARGE_TIMEOUT_MS);
  largeCase(TASK, "H1M: order facts with and without a commit-graph", H1M, () => large(H1M), LARGE_TIMEOUT_MS);

  test("report the facts for research.md", () => {
    for (const [fact, { held, failed }] of results) {
      console.log(`OBSERVATION ${TASK}: "${fact}" held on ${held.length} of ${held.length + failed.length} fixture runs (experiment)${failed.length > 0 ? `; failed on: ${failed.join("; ")}` : ""}`);
    }
    console.log(`OBSERVATION ${TASK}: the --skip runs: ${results.get("--skip=k equals the suffix")!.held.join("; ")}`);
    for (const note of notes) console.log(`OBSERVATION ${TASK}: ${note}`);
    expect(results.get("two runs give the same bytes")!.held.length + results.get("two runs give the same bytes")!.failed.length).toBeGreaterThan(0);
  });
});
