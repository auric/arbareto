// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeGit } from "../git/git-binary";
import { FIXTURE_ROOT, fixtureDir, ownedGit, removeTree, useFixtureRoot } from "../git/fixture-root";
import { sha256 } from "../git/git-oracle";
import { builderDigest, buildPerfRepo, C8_PATH, copyPerfFixture, copyPerfMD, ensurePerfFixture, hasCommitGraph, MD_PATH, MIXED_PATH, PERF_CACHE_ROOT, PERF_L, PERF_M, PERF_SEED, semanticDigest, type PerfFacts, type PerfSpec } from "./perf-fixtures";

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

test("the builder digest ignores CRLF line ends and keeps the LF digest", () => {
  const lf = Buffer.from("export const a = 1;\nexport const b = 2;\n");
  const crlf = Buffer.from("export const a = 1;\r\nexport const b = 2;\r\n");
  expect(builderDigest(crlf)).toBe(builderDigest(lf));
  expect(builderDigest(lf)).toBe(sha256(lf));
});

const variant = (commitGraph: boolean) => (commitGraph ? "with commit-graph" : "without commit-graph");

function checkCounts(git: string, repo: string, facts: PerfFacts, spec: PerfSpec, approxBytes: number, commitGraph: boolean): void {
  const c = facts.counts;
  const present = hasCommitGraph(git, repo);
  console.log(`PERF ${spec.name} ${variant(commitGraph)} counts: objects ${c.objects}, files ${c.files}, commits ${c.commits}, refs ${c.refs}, bytes ${c.bytes}, commit-graph file ${present}; semantic digest ${facts.semanticDigest}`);
  expect([facts.commitGraph, present]).toEqual([commitGraph, commitGraph]);
  expect([c.files, c.commits, c.refs]).toEqual([spec.files, spec.commits, spec.refs]);
  expect(Math.abs(c.bytes - approxBytes) / approxBytes).toBeLessThan(0.1);
}

describeGit("performance fixtures", (git) => {
  useFixtureRoot();

  test("a small spec builds twice to equal object IDs and semantic digests in each variant", () => {
    const spec: PerfSpec = { name: "tiny", files: 300, commits: 120, refs: 8, largeText: true };
    const build = (n: string, commitGraph: boolean) => {
      const dir = fixtureDir(n);
      return buildPerfRepo(git, FIXTURE_ROOT, join(dir, "repo"), spec, join(dir, "tiny.fast-import"), true, commitGraph);
    };
    const a = build("perf-tiny-1", true);
    const b = build("perf-tiny-2", true);
    const plain = build("perf-tiny-3", false);
    expect(b).toEqual(a);
    expect([a.commitGraph, hasCommitGraph(git, join(FIXTURE_ROOT, "perf-tiny-1", "repo"))]).toEqual([true, true]);
    expect([plain.commitGraph, hasCommitGraph(git, join(FIXTURE_ROOT, "perf-tiny-3", "repo"))]).toEqual([false, false]);
    // The variants differ only in the commit-graph file.
    expect(plain.semanticDigest).not.toBe(a.semanticDigest);
    expect({ ...plain, commitGraph: true, semanticDigest: a.semanticDigest }).toEqual(a);
    expect([a.counts.files, a.counts.commits, a.counts.refs]).toEqual([300, 120, 8]);
    expect(readFileSync(join(FIXTURE_ROOT, "perf-tiny-1", "tiny.fast-import"))).toEqual(readFileSync(join(FIXTURE_ROOT, "perf-tiny-2", "tiny.fast-import")));
    checkShared(git, join(FIXTURE_ROOT, "perf-tiny-1", "repo"), a);
  }, 120_000);

  test("M without commit-graph builds once per seed and reuses its cache", () => {
    let started = performance.now();
    const m = ensurePerfFixture(git, PERF_M, false);
    console.log(`PERF M ${variant(false)} ${m.reused ? "reused" : "built"} in ${(performance.now() - started).toFixed(0)} ms at ${m.folder}`);
    checkCounts(git, m.repo, m.manifest.facts, PERF_M, 20 * MiB, false);
    expect(m.stream).toBeNull();
    started = performance.now();
    const again = ensurePerfFixture(git, PERF_M, false);
    console.log(`PERF M ${variant(false)} reuse check ${(performance.now() - started).toFixed(0)} ms`);
    expect([again.reused, again.manifest.facts.semanticDigest]).toEqual([true, m.manifest.facts.semanticDigest]);
    const copy = copyPerfFixture(git, m, "perf-m-plain-copy");
    expect([hasCommitGraph(git, copy), semanticDigest(git, copy)]).toEqual([false, m.manifest.facts.semanticDigest]);
    removeTree(copy);
  }, 900_000);

  test("M with commit-graph builds once per seed, reuses its cache, and gives copies and M-D", () => {
    let started = performance.now();
    const m = ensurePerfFixture(git, PERF_M);
    console.log(`PERF M ${variant(true)} ${m.reused ? "reused" : "built"} in ${(performance.now() - started).toFixed(0)} ms at ${m.folder}`);
    checkCounts(git, m.repo, m.manifest.facts, PERF_M, 20 * MiB, true);
    expect(existsSync(m.stream!)).toBe(true);
    started = performance.now();
    const again = ensurePerfFixture(git, PERF_M);
    console.log(`PERF M ${variant(true)} reuse check ${(performance.now() - started).toFixed(0)} ms`);
    expect([again.reused, again.manifest.facts.semanticDigest]).toEqual([true, m.manifest.facts.semanticDigest]);
    started = performance.now();
    const copy = copyPerfFixture(git, m, "perf-m-copy");
    console.log(`PERF M copy ${(performance.now() - started).toFixed(0)} ms`);
    expect(semanticDigest(git, copy)).toBe(m.manifest.facts.semanticDigest);
    checkShared(git, copy, m.manifest.facts);
    const md = copyPerfMD(git, m, "perf-m-d");
    const numstat = ownedGit(git, FIXTURE_ROOT, md, ["diff-files", "--numstat", "--", MD_PATH]).toString().trim();
    expect(numstat).toBe(`9000\t9000\t${MD_PATH}`);
    expect(hasCommitGraph(git, md)).toBe(true);
    expect(semanticDigest(git, m.repo)).toBe(m.manifest.facts.semanticDigest);
    // The root removal hook has the default 5-second limit, so large copies go here.
    for (const dir of [copy, md]) removeTree(dir);
  }, 900_000);

  test("concurrent builders of one fixture build it once and wait on its lock", async () => {
    const spec: PerfSpec = { name: `lock-${process.pid}`, files: 300, commits: 120, refs: 8, largeText: false };
    const folder = join(PERF_CACHE_ROOT, `${spec.name}-seed${PERF_SEED}-commit-graph`);
    const lock = `${folder}.lock`;
    const script = join(fixtureDir("perf-lock"), "child.ts");
    writeFileSync(
      script,
      [
        `import { mkdirSync, writeFileSync } from "node:fs";`,
        `import { FIXTURE_GLOBAL_CONFIG, FIXTURE_HOME, FIXTURE_ROOT, removeTree } from ${JSON.stringify(join(import.meta.dir, "../git/fixture-root.ts"))};`,
        `import { ensurePerfFixture } from ${JSON.stringify(join(import.meta.dir, "perf-fixtures.ts"))};`,
        `console.log("ORIGIN " + Bun.resolveSync("./perf-fixtures.ts", ${JSON.stringify(import.meta.dir)}));`,
        `mkdirSync(FIXTURE_HOME, { recursive: true });`,
        `writeFileSync(FIXTURE_GLOBAL_CONFIG, "");`,
        `try {`,
        `  const f = ensurePerfFixture(process.argv[2], JSON.parse(process.argv[3]));`,
        `  console.log("RESULT " + JSON.stringify({ reused: f.reused, digest: f.manifest.facts.semanticDigest }));`,
        `} finally {`,
        `  removeTree(FIXTURE_ROOT);`,
        `}`,
      ].join("\n"),
    );
    mkdirSync(PERF_CACHE_ROOT, { recursive: true });
    mkdirSync(lock);
    try {
      const children = [0, 1].map(() => Bun.spawn([process.execPath, script, git, JSON.stringify(spec)], { stdout: "pipe", stderr: "inherit" }));
      // Both children wait while the test holds the lock.
      await Bun.sleep(3_000);
      expect([existsSync(folder), children.map((c) => c.exitCode)]).toEqual([false, [null, null]]);
      removeTree(lock);
      const outputs = await Promise.all(children.map(async (c) => [await c.exited, await new Response(c.stdout).text()] as const));
      for (const [, out] of outputs) for (const line of out.split(/\r?\n/)) if (line.startsWith("ORIGIN ")) console.log(line);
      expect(outputs.map(([code]) => code)).toEqual([0, 0]);
      const results = outputs.map(([, out]) => JSON.parse(out.split(/\r?\n/).find((l) => l.startsWith("RESULT "))!.slice(7)) as { reused: boolean; digest: string });
      console.log(`PERF lock children reused=${results.map((r) => r.reused).join(",")}`);
      expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
      expect(results[0]!.digest).toBe(results[1]!.digest);
      expect([existsSync(lock), existsSync(`${folder}.tmp`)]).toEqual([false, false]);

      // A lock older than the stale bound belongs to a dead builder.
      mkdirSync(lock);
      const old = new Date(Date.now() - 2 * 60 * 60_000);
      utimesSync(lock, old, old);
      const reused = ensurePerfFixture(git, spec);
      expect([reused.reused, reused.manifest.facts.semanticDigest, existsSync(lock)]).toEqual([true, results[0]!.digest, false]);

      // A fresh lock whose owner PID does not exist is stale at once. The child limit stops a waiter that ignores the owner.
      const gone = Bun.spawnSync([process.execPath, "-e", "0"]).pid;
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: gone, start: new Date().toISOString() }));
      const started = performance.now();
      const child = Bun.spawn([process.execPath, script, git, JSON.stringify(spec)], { stdout: "pipe", stderr: "inherit", timeout: 30_000 });
      const [code, out] = [await child.exited, await new Response(child.stdout).text()];
      console.log(`PERF dead-owner lock child exit ${code} in ${(performance.now() - started).toFixed(0)} ms`);
      expect([code, out.includes(`"reused":true`), existsSync(lock)]).toEqual([0, true, false]);
    } finally {
      for (const dir of [lock, folder]) if (existsSync(dir)) removeTree(dir);
    }
  }, 120_000);

  test("reuse refuses a cached fixture with a changed clean file or a changed listed file", () => {
    const spec: PerfSpec = { name: `tamper-${process.pid}`, files: 300, commits: 120, refs: 8, largeText: false };
    const first = ensurePerfFixture(git, spec);
    try {
      const { facts, reuse } = first.manifest;
      expect(first.reused).toBe(false);
      expect([reuse.tip, Object.keys(reuse.files).sort()]).toEqual([facts.tip, [...new Set([...facts.staged, ...facts.unstaged, ...facts.untracked])].sort()]);
      const listed = new Set(Object.keys(reuse.files));
      const clean = paths(ownedGit(git, PERF_CACHE_ROOT, first.repo, ["ls-files", "-z"])).find((p) => p.startsWith("src/") && !listed.has(p))!;
      const later = new Date(Date.now() + 60_000);

      // A clean tracked file with new bytes, size, and mtime. Git status reports it.
      writeFileSync(join(first.repo, clean), `${readFileSync(join(first.repo, clean), "utf8")}// tampered\n`);
      utimesSync(join(first.repo, clean), later, later);
      const afterClean = ensurePerfFixture(git, spec);
      expect([afterClean.reused, afterClean.manifest.facts.semanticDigest]).toEqual([false, facts.semanticDigest]);

      // An untracked file with one byte changed and the same size. Git status stays equal, so only the path hash sees it.
      const untracked = join(afterClean.repo, facts.untracked[0]!);
      const bytes = readFileSync(untracked);
      bytes[0] = bytes[0] === 0x65 ? 0x66 : 0x65;
      writeFileSync(untracked, bytes);
      const afterListed = ensurePerfFixture(git, spec);
      expect([afterListed.reused, afterListed.manifest.facts.semanticDigest]).toEqual([false, facts.semanticDigest]);

      expect(ensurePerfFixture(git, spec).reused).toBe(true);
    } finally {
      removeTree(first.folder);
    }
  }, 120_000);

  for (const commitGraph of [true, false]) {
    test(`L ${variant(commitGraph)} builds once per seed and reuses its cache`, () => {
      let started = performance.now();
      const l = ensurePerfFixture(git, PERF_L, commitGraph);
      console.log(`PERF L ${variant(commitGraph)} ${l.reused ? "reused" : "built"} in ${(performance.now() - started).toFixed(0)} ms at ${l.folder}`);
      checkCounts(git, l.repo, l.manifest.facts, PERF_L, 100 * MiB, commitGraph);
      expect(l.stream).toBeNull();
      started = performance.now();
      const again = ensurePerfFixture(git, PERF_L, commitGraph);
      console.log(`PERF L ${variant(commitGraph)} reuse check ${(performance.now() - started).toFixed(0)} ms`);
      expect([again.reused, again.manifest.facts.semanticDigest]).toEqual([true, l.manifest.facts.semanticDigest]);
    }, 1_800_000);
  }
});
