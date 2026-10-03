// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeGit } from "../git/git-binary";
import { FIXTURE_ROOT, fixtureDir, ownedGit, removeTree, useFixtureRoot } from "../git/fixture-root";
import { buildPerfRepo, C8_PATH, copyPerfFixture, copyPerfMD, ensurePerfFixture, MD_PATH, MIXED_PATH, PERF_L, PERF_M, semanticDigest, type PerfFacts, type PerfSpec } from "./perf-fixtures";

// This file imports no `src/` module, so it prints no ORIGIN line for `src/`.

const MiB = 1024 * 1024;
const paths = (out: Buffer) => out.toString("utf8").split("\0").filter((p) => p !== "").sort();

function checkShared(git: string, repo: string, facts: PerfFacts): void {
  const g = (args: string[]) => ownedGit(git, FIXTURE_ROOT, repo, ["--no-optional-locks", ...args]);
  expect(paths(g(["diff-index", "--cached", "--name-only", "-z", "HEAD"]))).toEqual(facts.staged);
  expect(paths(g(["diff-files", "--name-only", "-z"]))).toEqual(facts.unstaged);
  expect(paths(g(["ls-files", "-o", "-z", "--exclude-standard"]))).toEqual([...facts.untracked].sort());
  const hunks = (args: string[]) => (g([...args, "-p", "--", MIXED_PATH]).toString().match(/^@@ /gm) ?? []).length;
  expect([hunks(["diff-index", "--cached", "HEAD"]), hunks(["diff-files"])]).toEqual([2, 1]);
  console.log(`PERF ${facts.spec.name} C8 file ${C8_PATH}; staged and unstaged hunks ${MIXED_PATH}`);
}

function checkCounts(facts: PerfFacts, spec: PerfSpec, approxBytes: number): void {
  const c = facts.counts;
  console.log(`PERF ${spec.name} counts: objects ${c.objects}, files ${c.files}, commits ${c.commits}, refs ${c.refs}, bytes ${c.bytes}; semantic digest ${facts.semanticDigest}`);
  expect([c.files, c.commits, c.refs]).toEqual([spec.files, spec.commits, spec.refs]);
  expect(Math.abs(c.bytes - approxBytes) / approxBytes).toBeLessThan(0.1);
}

describeGit("performance fixtures", (git) => {
  useFixtureRoot();

  test("a small spec builds twice to equal object IDs and semantic digests", () => {
    const spec: PerfSpec = { name: "tiny", files: 300, commits: 120, refs: 8, largeText: true };
    const build = (n: string) => {
      const dir = fixtureDir(n);
      return buildPerfRepo(git, FIXTURE_ROOT, join(dir, "repo"), spec, join(dir, "tiny.fast-import"), true);
    };
    const a = build("perf-tiny-1");
    const b = build("perf-tiny-2");
    expect(b).toEqual(a);
    expect([a.counts.files, a.counts.commits, a.counts.refs]).toEqual([300, 120, 8]);
    expect(readFileSync(join(FIXTURE_ROOT, "perf-tiny-1", "tiny.fast-import"))).toEqual(readFileSync(join(FIXTURE_ROOT, "perf-tiny-2", "tiny.fast-import")));
    checkShared(git, join(FIXTURE_ROOT, "perf-tiny-1", "repo"), a);
  }, 120_000);

  test("M builds once per seed, reuses its cache, and gives copies and M-D", () => {
    let started = performance.now();
    const m = ensurePerfFixture(git, PERF_M);
    console.log(`PERF M ${m.reused ? "reused" : "built"} in ${(performance.now() - started).toFixed(0)} ms at ${m.folder}`);
    checkCounts(m.manifest.facts, PERF_M, 20 * MiB);
    expect(existsSync(m.stream!)).toBe(true);
    started = performance.now();
    const again = ensurePerfFixture(git, PERF_M);
    console.log(`PERF M reuse check ${(performance.now() - started).toFixed(0)} ms`);
    expect([again.reused, again.manifest.facts.semanticDigest]).toEqual([true, m.manifest.facts.semanticDigest]);
    started = performance.now();
    const copy = copyPerfFixture(git, m, "perf-m-copy");
    console.log(`PERF M copy ${(performance.now() - started).toFixed(0)} ms`);
    expect(semanticDigest(git, copy)).toBe(m.manifest.facts.semanticDigest);
    checkShared(git, copy, m.manifest.facts);
    const md = copyPerfMD(git, m, "perf-m-d");
    const numstat = ownedGit(git, FIXTURE_ROOT, md, ["diff-files", "--numstat", "--", MD_PATH]).toString().trim();
    expect(numstat).toBe(`9000\t9000\t${MD_PATH}`);
    expect(semanticDigest(git, m.repo)).toBe(m.manifest.facts.semanticDigest);
    // The root removal hook has the default 5-second limit, so large copies go here.
    for (const dir of [copy, md]) removeTree(dir);
  }, 900_000);

  test("L builds once per seed and reuses its cache", () => {
    const started = performance.now();
    const l = ensurePerfFixture(git, PERF_L);
    console.log(`PERF L ${l.reused ? "reused" : "built"} in ${(performance.now() - started).toFixed(0)} ms at ${l.folder}`);
    checkCounts(l.manifest.facts, PERF_L, 100 * MiB);
    expect(l.stream).toBeNull();
  }, 1_800_000);
});
