// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 010 T018: fixture M-R of plan.md D9. It derives from the maintained M of perf-fixtures.ts and lies beside it in PERF_CACHE_ROOT.
// A change of perf-fixtures.ts changes the M and L builder digest and rebuilds both, so M-R has its own module and digest.
// Git runs with `fixtureEnv`, so a caller must hold an owned root through `useFixtureRoot`. Never delete PERF_CACHE_ROOT.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_ROOT, fixturePath, ownedGit, ownedPath, removeTree } from "../git/fixture-root";
import { fiCommit } from "../git/fixtures";
import { acquireLock, builderDigest, ensurePerfFixture, PERF_CACHE_ROOT, PERF_M, PERF_SEED } from "./perf-fixtures";

// Plan.md D9: the reset target is 100 commits back, with about 1,000 changed paths.
export const MR_COMMITS = 100;
export const MR_FILES_PER_COMMIT = 10;
export const MR_CHANGED_PATHS = MR_COMMITS * MR_FILES_PER_COMMIT;

export interface MrFacts {
  // The main tip of M-R. Each of its 100 commits changes 10 paths that no other commit changes.
  tip: string;
  // The M tip: main~100, the Hard and the detached checkout target.
  target: string;
  // Branch `pick`: one commit on `tip` that changes 10 other paths. Cherry-pick applies it to main without a conflict.
  pick: string;
  // Branch `conflict`: one commit on main~1 that changes `conflictPath`, which `tip` also changes. A cherry-pick of it stops with one conflict.
  conflict: string;
  conflictPath: string;
  // The 10 paths of `tip`. Revert of `tip` changes them.
  tipPaths: string[];
}

interface Manifest {
  seed: number;
  builderDigest: string;
  // The M manifest values that M-R derives from.
  mDigest: string;
  mTip: string;
  // `for-each-ref --format=%(objectname) %(refname)` and `status --porcelain=v2 -z --untracked-files=all` of the built repository.
  refs: string;
  status: string;
  facts: MrFacts;
}

export interface CachedMr {
  repo: string;
  facts: MrFacts;
  reused: boolean;
}

// 2020-01-01T00:00:00Z plus 1 second per commit, after the 5,000 M commits (perf-fixtures.ts "Reproducibility").
const EPOCH_2020 = Date.UTC(2020, 0, 1) / 1000;
const currentDigest = () => builderDigest(readFileSync(import.meta.path));
const line = (text: string) => `${text.padEnd(70, " ").slice(0, 70)}\n`;
const content = (tag: string, n: number) => Array.from({ length: 24 }, (_, j) => line(`export const ${tag}_${n}_${j} = ${n * 100 + j};`)).join("");

function probe(git: string, repo: string): { refs: string; status: string } {
  const g = (args: string[]) => ownedGit(git, PERF_CACHE_ROOT, repo, ["--no-optional-locks", ...args]).toString("utf8");
  return { refs: g(["for-each-ref", "--format=%(objectname) %(refname)"]), status: g(["status", "--porcelain=v2", "-z", "--untracked-files=all"]) };
}

function build(git: string, repo: string, source: string, mTip: string, streamPath: string): MrFacts {
  const g = (args: string[], input?: Uint8Array) => ownedGit(git, PERF_CACHE_ROOT, repo, args, input === undefined ? {} : { input }).toString("utf8");
  cpSync(source, repo, { recursive: true });
  // M-R keeps the untracked files of M for the in-the-way check. The tracked changes of M go, so Cherry-pick and Revert can run.
  g(["reset", "-q", "--hard"]);
  const generated = g(["ls-files", "-z", "--", "src"]).split("\0").filter((p) => p !== "").sort();
  const need = MR_CHANGED_PATHS + MR_FILES_PER_COMMIT;
  if (generated.length < need) throw new Error(`M has ${generated.length} paths under src, M-R needs ${need}`);
  const stride = Math.floor(generated.length / need);
  const paths = Array.from({ length: need }, (_, i) => generated[i * stride]!);
  const commitPaths = (k: number) => paths.slice(k * MR_FILES_PER_COMMIT, (k + 1) * MR_FILES_PER_COMMIT);
  const files = (k: number, tag: string) => Object.fromEntries(commitPaths(k).map((p, j) => [p, content(tag, k * MR_FILES_PER_COMMIT + j)]));
  const time = (k: number) => EPOCH_2020 + PERF_M.commits + k;
  // git-fast-import(1) `reset`: the branch starts at the M tip, and the next `commit` without `from` takes it as parent.
  const parts: Buffer[] = [Buffer.from(`reset refs/heads/main\nfrom ${mTip}\n\n`)];
  for (let k = 0; k < MR_COMMITS; k++) parts.push(fiCommit({ mark: k + 1, time: time(k), message: `m-r commit ${k}\n`, files: files(k, "mr") }));
  parts.push(fiCommit({ mark: MR_COMMITS + 1, ref: "refs/heads/pick", time: time(MR_COMMITS), message: "m-r pick\n", from: MR_COMMITS, files: files(MR_COMMITS, "pick") }));
  const conflictPath = commitPaths(MR_COMMITS - 1)[0]!;
  parts.push(fiCommit({ mark: MR_COMMITS + 2, ref: "refs/heads/conflict", time: time(MR_COMMITS + 1), message: "m-r conflict\n", from: MR_COMMITS - 1, files: { [conflictPath]: content("conflict", 0) } }));
  writeFileSync(streamPath, Buffer.concat(parts));
  g(["fast-import", "--quiet"], readFileSync(streamPath));
  g(["reset", "-q", "--hard"]);
  g(["commit-graph", "write", "--reachable"]);
  const rev = (name: string) => g(["rev-parse", "--verify", "--end-of-options", `${name}^{commit}`]).trim();
  const facts: MrFacts = { tip: rev("refs/heads/main"), target: rev("refs/heads/main~100"), pick: rev("refs/heads/pick"), conflict: rev("refs/heads/conflict"), conflictPath, tipPaths: commitPaths(MR_COMMITS - 1).sort() };
  // The build oracle: Git's own diff gives the D9 shape.
  const changed = (a: string, b: string) => g(["diff", "--no-renames", "--name-only", "-z", a, b, "--"]).split("\0").filter((p) => p !== "").length;
  const shape = { target: facts.target, changed: changed(facts.target, facts.tip), pick: changed(facts.tip, facts.pick), tip: changed(`${facts.tip}~1`, facts.tip), tracked: g(["diff-index", "--name-only", "-z", "HEAD", "--"]) };
  const expected = { target: mTip, changed: MR_CHANGED_PATHS, pick: MR_FILES_PER_COMMIT, tip: MR_FILES_PER_COMMIT, tracked: "" };
  if (JSON.stringify(shape) !== JSON.stringify(expected)) throw new Error(`M-R shape ${JSON.stringify(shape)} is not ${JSON.stringify(expected)}`);
  return facts;
}

// Builds M-R once per builder digest and M state. The lock and the temporary folder follow `ensurePerfFixture`.
export function ensureMr(git: string): CachedMr {
  const m = ensurePerfFixture(git, PERF_M);
  const name = `MR-seed${PERF_SEED}-commit-graph`;
  const folder = ownedPath(PERF_CACHE_ROOT, name);
  const lock = ownedPath(PERF_CACHE_ROOT, `${name}.lock`);
  const temp = ownedPath(PERF_CACHE_ROOT, `${name}.tmp`);
  const repo = join(folder, "repo");
  const manifestPath = join(folder, "manifest.json");
  acquireLock(lock);
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    if (existsSync(manifestPath) && existsSync(repo)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      if (manifest.seed === PERF_SEED && manifest.builderDigest === currentDigest() && manifest.mDigest === m.manifest.facts.semanticDigest && manifest.mTip === m.manifest.facts.tip) {
        const now = probe(git, repo);
        if (now.refs === manifest.refs && now.status === manifest.status) return { repo, facts: manifest.facts, reused: true };
      }
    }
    if (existsSync(temp)) removeTree(temp);
    mkdirSync(temp);
    const facts = build(git, join(temp, "repo"), m.repo, m.manifest.facts.tip, join(temp, "MR.fast-import"));
    const built = probe(git, join(temp, "repo"));
    const manifest: Manifest = { seed: PERF_SEED, builderDigest: currentDigest(), mDigest: m.manifest.facts.semanticDigest, mTip: m.manifest.facts.tip, ...built, facts };
    writeFileSync(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(folder)) removeTree(folder);
    renameSync(temp, folder);
    return { repo, facts, reused: false };
  } finally {
    removeTree(lock);
  }
}

// An independent copy under the owned root, as perf-fixtures.ts `copyPerfFixture`.
export function copyMr(git: string, cached: CachedMr, name: string): string {
  const dest = fixturePath(name);
  if (existsSync(dest)) throw new Error(`copy target exists: ${dest}`);
  cpSync(cached.repo, dest, { recursive: true });
  ownedGit(git, FIXTURE_ROOT, dest, ["update-index", "-q", "--refresh"], { allowExit: [0, 1] });
  return dest;
}
