// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Performance fixtures M and L of the plan.md "Reference hardware and fixtures" table (T164).
// Git runs with `fixtureEnv`, so a caller must hold an owned root through `useFixtureRoot`.

import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { FIXTURE_ROOT, fixturePath, ownedGit, ownedPath, removeTree, type OwnedGitOptions } from "../git/fixture-root";
import { fiCommit } from "../git/fixtures";
import { indexEntries, refState, sha256, workingFileDigests } from "../git/git-oracle";

// The 8.3 form of the temporary directory differs from the form that Git prints, so the root holds the long form.
export const PERF_CACHE_ROOT = join(realpathSync.native(tmpdir()), "arbareto-perf-fixtures");
export const PERF_SEED = 42;
export const C8_PATH = "perf/c8.ts";
export const MIXED_PATH = "perf/mixed.ts";
export const MD_PATH = "perf/md.txt";

export interface PerfSpec {
  name: string;
  files: number;
  commits: number;
  refs: number;
  // Adds the 10,000-line file that M-D modifies.
  largeText: boolean;
}

export const PERF_M: PerfSpec = { name: "M", files: 10_000, commits: 5_000, refs: 32, largeText: true };
export const PERF_L: PerfSpec = { name: "L", files: 50_000, commits: 100_000, refs: 256, largeText: false };

export interface PerfCounts {
  objects: number;
  files: number;
  commits: number;
  refs: number;
  bytes: number;
}

export interface PerfFacts {
  seed: number;
  spec: PerfSpec;
  tip: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  // Staged and unstaged hunks by changed line number.
  mixed: { path: string; stagedLines: number[]; unstagedLines: number[] };
  c8: { path: string; changedLines: number[] };
  counts: PerfCounts;
  semanticDigest: string;
}

export interface PerfManifest {
  seed: number;
  builderDigest: string;
  facts: PerfFacts;
}

// 2020-01-01T00:00:00Z. Commit k has this time plus k seconds (plan.md "Reproducibility").
const EPOCH_2020 = Date.UTC(2020, 0, 1) / 1000;
const LINE_BYTES = 70;

// mulberry32: a fixed 32-bit generator, so a seed gives the same sequence on every host.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (text: string) => `${text.padEnd(LINE_BYTES, " ").slice(0, LINE_BYTES)}\n`;
const generatedPath = (i: number) => `src/d${String(Math.floor(i / 100)).padStart(3, "0")}/f${String(i).padStart(5, "0")}.ts`;

// File `i` at `version`: 22 to 38 lines of TypeScript. Each version rewrites one line in place.
function generated(i: number, version: number): string {
  const r = rng(PERF_SEED * 1_000_003 + i);
  const count = 22 + Math.floor(r() * 17);
  const lines: string[] = [];
  for (let j = 0; j < count; j++) lines.push(pad(`export const v${i}_${j} = ${Math.floor(r() * 1e9)}; // ${Math.floor(r() * 1e12).toString(16)}`));
  if (version > 0) lines[version % count] = pad(`export const v${i}_${version % count} = ${version}; // version ${version}`);
  return lines.join("");
}

const numbered = (count: number, prefix: string, changed: number[] = []) =>
  Array.from({ length: count }, (_, k) => pad(`${changed.includes(k + 1) ? "export const changed" : "export const line"}${k + 1} = "${prefix}";`)).join("");

function mdText(changed: boolean): string {
  return Array.from({ length: 10_000 }, (_, k) => {
    const n = k + 1;
    const line = `md line ${String(n).padStart(5, "0")}: ${"x".repeat(60)}`;
    return `${changed && n >= 501 && n <= 9_500 ? `${line} changed` : line}\n`;
  }).join("");
}

export function builderDigest(): string {
  return sha256(readFileSync(import.meta.path));
}

export function semanticDigest(git: string, repo: string): string {
  return sha256(Buffer.from(JSON.stringify({ refs: refState(git, repo), entries: indexEntries(git, repo), files: workingFileDigests(repo) })));
}

// Builds `spec` into `repo` under `root` through `git fast-import`. Writes the stream to `streamPath` and keeps it when `keepStream` holds.
export function buildPerfRepo(git: string, root: string, repo: string, spec: PerfSpec, streamPath: string, keepStream: boolean): PerfFacts {
  const g = (args: string[], options?: OwnedGitOptions) => ownedGit(git, root, repo, args, options).toString();
  mkdirSync(ownedPath(root, relative(root, repo)), { recursive: true });
  g(["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]]) g(["config", key!, value!]);

  // `-text` keeps checked-out bytes equal under every user line-ending setting.
  const extras: Record<string, string> = { ".gitattributes": "* -text\n", [C8_PATH]: numbered(300, "c8"), [MIXED_PATH]: numbered(300, "mixed") };
  if (spec.largeText) extras[MD_PATH] = mdText(false);
  const generatedCount = spec.files - Object.keys(extras).length;
  const versions = new Uint32Array(generatedCount);
  const pick = rng(PERF_SEED);
  const fd = openSync(streamPath, "w");
  try {
    for (let k = 0; k < spec.commits; k++) {
      const files: Record<string, string> = k === 0 ? { ...extras } : {};
      const from = Math.floor((k * generatedCount) / spec.commits);
      const to = Math.floor(((k + 1) * generatedCount) / spec.commits);
      for (let i = from; i < to; i++) files[generatedPath(i)] = generated(i, 0);
      if (k > 0 && from > 0) {
        const i = Math.floor(pick() * from);
        versions[i]! += 1;
        files[generatedPath(i)] = generated(i, versions[i]!);
      }
      writeSync(fd, fiCommit({ mark: k + 1, time: EPOCH_2020 + k, message: `commit ${k}\n`, files }));
    }
    for (let j = 1; j < spec.refs; j++) {
      const mark = Math.floor((j * spec.commits) / spec.refs);
      writeSync(fd, `reset refs/heads/branch-${String(j).padStart(3, "0")}\nfrom :${mark}\n\n`);
    }
  } finally {
    closeSync(fd);
  }
  // ponytail: the whole stream goes through memory (about 330 MB for L); stream it from the file if memory matters.
  g(["fast-import", "--quiet"], { input: readFileSync(streamPath) });
  if (!keepStream) rmSync(streamPath);
  g(["reset", "-q", "--hard"]);

  const chosen = new Set<number>();
  const choose = () => {
    for (;;) {
      const i = Math.floor(pick() * generatedCount);
      if (!chosen.has(i)) return chosen.add(i), i;
    }
  };
  const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
  const changeFirstLine = (i: number, word: string) => write(generatedPath(i), pad(`export const ${word}${i} = true;`) + generated(i, versions[i]!).slice(LINE_BYTES + 1));
  const staged = Array.from({ length: 10 }, () => choose());
  const unstaged = Array.from({ length: 9 }, () => choose());
  for (const i of staged) changeFirstLine(i, "staged");
  write(MIXED_PATH, numbered(300, "mixed", [50, 150]));
  g(["--literal-pathspecs", "add", "--", ...staged.map(generatedPath), MIXED_PATH]);
  write(MIXED_PATH, numbered(300, "mixed", [50, 150, 250]));
  for (const i of unstaged) changeFirstLine(i, "unstaged");
  write(C8_PATH, numbered(300, "c8", [100, 200]));
  const untracked = Array.from({ length: 10 }, (_, n) => `perf/untracked/u${n}.ts`);
  mkdirSync(join(repo, "perf", "untracked"), { recursive: true });
  for (const path of untracked) write(path, pad(`export const untracked = "${path}";`));
  g(["update-index", "-q", "--refresh"], { allowExit: [0, 1] });

  // plan.md "C8 rows": two hunks of 9 lines each, the `@@` lines included, so 18 rows after the `+++` line.
  const c8 = g(["diff-files", "-p", "--", C8_PATH]).split("\n");
  const rows = c8.slice(c8.findIndex((l) => l.startsWith("+++ ")) + 1).filter((l) => l !== "");
  const hunkStarts = rows.flatMap((l, n) => (l.startsWith("@@") ? [n] : []));
  if (rows.length !== 18 || hunkStarts.join() !== "0,9") throw new Error(`C8 diff has ${rows.length} rows and hunks at ${hunkStarts.join()}`);

  const tracked = g(["ls-files", "-z"]).split("\0").filter((p) => p !== "");
  const objects = Object.fromEntries(g(["count-objects", "-v"]).trim().split("\n").map((l) => l.split(": ") as [string, string]));
  return {
    seed: PERF_SEED,
    spec,
    tip: g(["rev-parse", "HEAD"]).trim(),
    staged: [...staged.map(generatedPath), MIXED_PATH].sort(),
    unstaged: [...unstaged.map(generatedPath), MIXED_PATH, C8_PATH].sort(),
    untracked,
    mixed: { path: MIXED_PATH, stagedLines: [50, 150], unstagedLines: [250] },
    c8: { path: C8_PATH, changedLines: [100, 200] },
    counts: {
      objects: Number(objects.count) + Number(objects["in-pack"]),
      files: tracked.length,
      commits: Number(g(["rev-list", "--count", "--all"]).trim()),
      refs: g(["for-each-ref", "--format=%(refname)"]).trim().split("\n").length,
      bytes: tracked.reduce((sum, p) => sum + (existsSync(join(repo, p)) ? statSync(join(repo, p)).size : 0), 0),
    },
    semanticDigest: semanticDigest(git, repo),
  };
}

export interface CachedPerfFixture {
  folder: string;
  repo: string;
  manifest: PerfManifest;
  reused: boolean;
  // The M stream for T245, or null for L.
  stream: string | null;
}

// Builds `spec` once per seed under the cache root. Reuses it only when the seed, the builder digest, and a recomputed semantic digest match.
export function ensurePerfFixture(git: string, spec: PerfSpec): CachedPerfFixture {
  mkdirSync(PERF_CACHE_ROOT, { recursive: true });
  const folder = ownedPath(PERF_CACHE_ROOT, `${spec.name}-seed${PERF_SEED}`);
  const repo = join(folder, "repo");
  const manifestPath = join(folder, "manifest.json");
  const streamPath = join(folder, `${spec.name}.fast-import`);
  const keepStream = spec.name === PERF_M.name;
  const digest = builderDigest();
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PerfManifest;
    if (manifest.seed === PERF_SEED && manifest.builderDigest === digest && semanticDigest(git, repo) === manifest.facts.semanticDigest) {
      return { folder, repo, manifest, reused: true, stream: keepStream ? streamPath : null };
    }
  }
  if (existsSync(folder)) removeTree(folder);
  mkdirSync(folder);
  const facts = buildPerfRepo(git, PERF_CACHE_ROOT, repo, spec, streamPath, keepStream);
  const manifest: PerfManifest = { seed: PERF_SEED, builderDigest: digest, facts };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { folder, repo, manifest, reused: false, stream: keepStream ? streamPath : null };
}

// An independent copy under the owned root. Tests and measurements use copies only and never change a cached fixture.
// A copy gets new creation times, so the refresh restores the stat data that a fresh checkout has.
export function copyPerfFixture(git: string, cached: CachedPerfFixture, name: string): string {
  const dest = fixturePath(name);
  if (existsSync(dest)) throw new Error(`copy target exists: ${dest}`);
  cpSync(cached.repo, dest, { recursive: true });
  ownedGit(git, FIXTURE_ROOT, dest, ["update-index", "-q", "--refresh"], { allowExit: [0, 1] });
  return dest;
}

// M-D: a copy of M whose 10,000-line file has lines 501 to 9,500 changed.
export function copyPerfMD(git: string, cachedM: CachedPerfFixture, name: string): string {
  if (!cachedM.manifest.facts.spec.largeText) throw new Error("M-D needs the M fixture");
  const dest = copyPerfFixture(git, cachedM, name);
  writeFileSync(join(dest, MD_PATH), mdText(true));
  return dest;
}
