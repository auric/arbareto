// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 revert fixture R (research.md R12, tasks.md T048). Git runs with `fixtureEnv`, so a caller must hold an owned root through `useFixtureRoot`.
// R is the maintained M fixture from the kept M stream, plus one commit with the revert files, then the changes below.
// R has its own cache entry, digest, lock, and temporary folder. It reads the M entry through `ensurePerfFixture` only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fixtureEnv, ownedGit, ownedPath, removeTree, type OwnedGitOptions } from "../git/fixture-root";
import { fiCommit } from "../git/fixtures";
import { fixtureGitPath } from "../git/git-binary";
import { sha256 } from "../git/git-oracle";
import { acquireLock, builderDigest, ensurePerfFixture, hasCommitGraph, PERF_CACHE_ROOT, PERF_M, PERF_SEED, perfReuseState, type PerfReuseState } from "./perf-fixtures";

export const RV_TEXT = "rv/a/big.txt";
export const RV_BINARY = "rv/a/blob.bin";
export const RV_SMALL = 1_000;
export const RV_BOTH = 100;
export const rvSmallPath = (i: number) => `rv/u/f${String(i).padStart(4, "0")}.txt`;
export const rvBothPath = (i: number) => `rv/b/f${String(i).padStart(3, "0")}.txt`;
const RV_LINE_BYTES = 64;
const RV_SMALL_LINES = 64;
// 16,384 lines of 64 bytes give exactly COMPARED_RAW_VERSION_BYTES (1 MiB), the largest size that the 001 support rule shows.
const RV_TEXT_LINES = 16_384;
// One hunk: 1,000 removed and 1,000 added lines give the 2,000-line diff of R12.
const RV_TEXT_CHANGED = { from: 5_001, to: 6_000 };
const RV_BINARY_BYTES = 8 * 1024 * 1024;
const RV_BINARY_CHANGED = 64 * 1024;
// perf-fixtures.ts: commit k of M has 2020-01-01T00:00:00Z plus k seconds.
const EPOCH_2020 = Date.UTC(2020, 0, 1) / 1000;

// A copy of the perf-fixtures.ts mulberry32 generator, so a seed gives the same bytes on every host.
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

const rvLine = (tag: string, n: number) => `${`${tag} ${n} `.padEnd(RV_LINE_BYTES - 1, "-")}\n`;
const rvLines = (path: string, count: number, changed: (n: number) => string | null) => Array.from({ length: count }, (_, k) => rvLine(changed(k + 1) ?? path, k + 1)).join("");

/** A 4 KiB file. `staged` changes line 1 and `unstaged` also changes line 64. */
export const rvSmall = (path: string, version: "head" | "staged" | "unstaged") => rvLines(path, RV_SMALL_LINES, (n) => (n === 1 && version !== "head" ? `${path} staged` : n === RV_SMALL_LINES && version === "unstaged" ? `${path} unstaged` : null));
export const rvText = (changed: boolean) => rvLines(RV_TEXT, RV_TEXT_LINES, (n) => (changed && n >= RV_TEXT_CHANGED.from && n <= RV_TEXT_CHANGED.to ? `${RV_TEXT} changed` : null));
/** 8 MiB of generator bytes. The changed form inverts the first 64 KiB. The bytes hold NUL, so Git treats the file as binary. */
export function rvBinary(changed: boolean): Uint8Array {
  const r = rng(PERF_SEED + 8);
  const words = new Uint32Array(RV_BINARY_BYTES / 4);
  for (let i = 0; i < words.length; i++) words[i] = Math.floor(r() * 4294967296);
  const bytes = new Uint8Array(words.buffer);
  if (changed) for (let i = 0; i < RV_BINARY_CHANGED; i++) bytes[i] = bytes[i]! ^ 0xff;
  return bytes;
}

/** Writes the R changes into `repo` under `root`: the staged part of the both files through Git, then the unstaged working bytes. */
export function applyRevertChanges(git: string, root: string, repo: string, parts: { small?: boolean; both?: boolean; text?: boolean; binary?: boolean } = { small: true, both: true, text: true, binary: true }): void {
  if (parts.both) {
    const paths = Array.from({ length: RV_BOTH }, (_, i) => rvBothPath(i));
    for (const p of paths) writeFileSync(join(repo, p), rvSmall(p, "staged"));
    ownedGit(git, root, repo, ["--literal-pathspecs", "add", "--", ...paths]);
    for (const p of paths) writeFileSync(join(repo, p), rvSmall(p, "unstaged"));
  }
  if (parts.small) for (let i = 0; i < RV_SMALL; i++) writeFileSync(join(repo, rvSmallPath(i)), rvSmall(rvSmallPath(i), "unstaged"));
  if (parts.text) writeFileSync(join(repo, RV_TEXT), rvText(true));
  if (parts.binary) writeFileSync(join(repo, RV_BINARY), rvBinary(true));
}

export interface RevertFacts {
  seed: number;
  // The M tip that the R commit has as its parent.
  base: string;
  tip: string;
  unstaged: number;
  staged: number;
}

const nulList = (out: Buffer) => out.toString("utf8").split("\0").filter((p) => p !== "");

// `-text` of M covers the R files, so the checked-out bytes equal the blob bytes.
export function buildRevertRepo(git: string, root: string, repo: string, mStream: string, mTip: string): RevertFacts {
  const g = (args: string[], options?: OwnedGitOptions) => ownedGit(git, root, repo, args, options);
  mkdirSync(ownedPath(root, relative(root, repo)), { recursive: true });
  g(["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]]) g(["config", key!, value!]);
  const files: Record<string, string | Uint8Array> = { [RV_TEXT]: rvText(false), [RV_BINARY]: rvBinary(false) };
  for (let i = 0; i < RV_SMALL; i++) files[rvSmallPath(i)] = rvSmall(rvSmallPath(i), "head");
  for (let i = 0; i < RV_BOTH; i++) files[rvBothPath(i)] = rvSmall(rvBothPath(i), "head");
  // The M stream gives commit k the mark k + 1, so its last commit has the mark PERF_M.commits.
  const commit = fiCommit({ mark: PERF_M.commits + 1, time: EPOCH_2020 + PERF_M.commits, message: "revert fixture\n", from: PERF_M.commits, files });
  g(["fast-import", "--quiet"], { input: Buffer.concat([readFileSync(mStream), commit]) });
  g(["commit-graph", "write", "--reachable"]);
  g(["reset", "-q", "--hard"]);
  const base = g(["rev-parse", "HEAD^"]).toString().trim();
  if (base !== mTip) throw new Error(`the R parent ${base} is not the M tip ${mTip}`);
  // 005 T113: a build without refs stops, so the reuse state never records an empty ref list.
  if (g(["for-each-ref", "--format=%(refname)"]).toString().trim() === "") throw new Error(`for-each-ref listed no refs in ${repo}`);
  applyRevertChanges(git, root, repo);
  g(["update-index", "-q", "--refresh"], { allowExit: [0, 1] });
  const unstaged = nulList(g(["diff-files", "--name-only", "-z"])).length;
  const staged = nulList(g(["diff-index", "--cached", "--name-only", "-z", "HEAD"])).length;
  if (unstaged !== RV_SMALL + RV_BOTH + 2 || staged !== RV_BOTH) throw new Error(`R has ${unstaged} unstaged and ${staged} staged paths`);
  return { seed: PERF_SEED, base, tip: g(["rev-parse", "HEAD"]).toString().trim(), unstaged, staged };
}

// The perf-fixtures.ts reuse check for R. A Git read that exits nonzero gives false, so a damaged entry rebuilds (005 T113).
function reuseMatches(git: string, repo: string, expected: PerfReuseState): boolean {
  if (!existsSync(repo)) return false;
  const g = (args: string[]) => {
    const proc = Bun.spawnSync([fixtureGitPath(git), "--no-optional-locks", ...args], { cwd: ownedPath(PERF_CACHE_ROOT, relative(PERF_CACHE_ROOT, repo)), env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return proc.exitCode === 0 ? proc.stdout : null;
  };
  const [tip, refs, index, status] = [g(["rev-parse", "HEAD"]), g(["for-each-ref", "--format=%(objectname) %(refname)"]), g(["ls-files", "-s", "-z"]), g(["status", "--porcelain=v2", "-z", "--untracked-files=all"])];
  if (tip === null || refs === null || index === null || status === null) return false;
  if (tip.toString().trim() !== expected.tip || sha256(refs) !== expected.refs || sha256(index) !== expected.index || sha256(status) !== expected.status || hasCommitGraph(git, repo) !== expected.commitGraph) return false;
  return Object.entries(expected.files).every(([path, digest]) => existsSync(join(repo, path)) && sha256(readFileSync(join(repo, path))) === digest);
}

interface RevertManifest {
  seed: number;
  builderDigest: string;
  facts: RevertFacts;
  reuse: PerfReuseState;
}

const NAME = `R-seed${PERF_SEED}`;

/** Builds R once per builder digest and M tip under the cache root. The lock and the temporary folder follow `ensurePerfFixture`. */
export function ensureRevertFixture(git: string): { folder: string; repo: string; facts: RevertFacts; reused: boolean } {
  const m = ensurePerfFixture(git, PERF_M);
  const mTip = m.manifest.facts.tip;
  if (m.stream === null) throw new Error("the maintained M fixture has no kept stream");
  const folder = ownedPath(PERF_CACHE_ROOT, NAME);
  const lock = ownedPath(PERF_CACHE_ROOT, `${NAME}.lock`);
  const temp = ownedPath(PERF_CACHE_ROOT, `${NAME}.tmp`);
  const repo = join(folder, "repo");
  const manifestPath = join(folder, "manifest.json");
  const digest = builderDigest(readFileSync(import.meta.path));
  acquireLock(lock);
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RevertManifest;
      if (manifest.seed === PERF_SEED && manifest.builderDigest === digest && manifest.facts.base === mTip && reuseMatches(git, repo, manifest.reuse)) return { folder, repo, facts: manifest.facts, reused: true };
    }
    if (existsSync(temp)) removeTree(temp);
    mkdirSync(temp);
    const facts = buildRevertRepo(git, PERF_CACHE_ROOT, join(temp, "repo"), m.stream, mTip);
    const manifest: RevertManifest = { seed: PERF_SEED, builderDigest: digest, facts, reuse: perfReuseState(git, join(temp, "repo")) };
    writeFileSync(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(folder)) removeTree(folder);
    renameSync(temp, folder);
    return { folder, repo, facts, reused: false };
  } finally {
    removeTree(lock);
  }
}
