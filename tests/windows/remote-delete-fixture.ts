// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 T020: fixture M-D of plan.md D11. It derives from the maintained M of perf-fixtures.ts and lies beside it in PERF_CACHE_ROOT.
// perf-fixtures.ts `copyPerfMD` (feature 001) uses the same name for another fixture. This module calls the 011 fixture RD.
// A change of perf-fixtures.ts changes the M and L builder digest and rebuilds both, so RD has its own module and digest (as commit-menu-fixture.ts).
// Git runs with `fixtureEnv`, so a caller must hold an owned root through `useFixtureRoot`. Never delete PERF_CACHE_ROOT.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_ROOT, fixturePath, ownedGit, ownedPath, removeTree } from "../git/fixture-root";
import { fiCommit } from "../git/fixtures";
import { acquireLock, builderDigest, ensurePerfFixture, PERF_CACHE_ROOT, PERF_M, PERF_SEED } from "./perf-fixtures";

// Plan.md D11 "Fixture M-D": 64 fetched branches d01 to d64, `d01` with 150 commits that no other ref holds, and 11 run branches per run measure.
export const RD_REMOTE = "origin";
export const RD_BRANCHES = 64;
export const RD_ONLY_COMMITS = 150;
export const RD_RUNS = 11;
const two = (n: number) => String(n).padStart(2, "0");
export const RD_NAMES = Array.from({ length: RD_BRANCHES }, (_, i) => `d${two(i + 1)}`);
// SC-009c deletes one remote branch per run. SC-009d deletes one local branch and its upstream per run.
export const RD_REMOTE_RUNS = Array.from({ length: RD_RUNS }, (_, i) => `rr${two(i + 1)}`);
export const RD_COMBINED_RUNS = Array.from({ length: RD_RUNS }, (_, i) => `rc${two(i + 1)}`);

export interface RdFacts {
  // The M tip. `main`, d02 to d64, and every run branch point at it.
  mTip: string;
  // The tip of `d01`: 150 commits on the M tip. Only `refs/remotes/origin/d01` holds them.
  d01: string;
}

interface Manifest {
  seed: number;
  builderDigest: string;
  // The M manifest values that RD derives from.
  mDigest: string;
  mTip: string;
  // `for-each-ref --format=%(objectname) %(refname)` and `status --porcelain=v2 -z --untracked-files=all` of the work repository, and `for-each-ref` of the bare remote.
  refs: string;
  status: string;
  remoteRefs: string;
  facts: RdFacts;
}

export interface CachedRd {
  folder: string;
  repo: string;
  remote: string;
  facts: RdFacts;
  reused: boolean;
}

// 2020-01-01T00:00:00Z plus 1 second per commit, after the 5,000 M commits (perf-fixtures.ts "Reproducibility").
const EPOCH_2020 = Date.UTC(2020, 0, 1) / 1000;
const currentDigest = () => builderDigest(readFileSync(import.meta.path));
const REFS = ["for-each-ref", "--format=%(objectname) %(refname)"];

function probe(git: string, repo: string, remote: string): { refs: string; status: string; remoteRefs: string } {
  const g = (cwd: string, args: string[]) => ownedGit(git, PERF_CACHE_ROOT, cwd, ["--no-optional-locks", ...args]).toString("utf8");
  return { refs: g(repo, REFS), status: g(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]), remoteRefs: g(remote, REFS) };
}

function build(git: string, temp: string, source: string, mTip: string): RdFacts {
  const repo = join(temp, "repo");
  const remote = join(temp, "remote.git");
  const g = (args: string[], input?: Uint8Array) => ownedGit(git, PERF_CACHE_ROOT, repo, args, input === undefined ? {} : { input }).toString("utf8");
  cpSync(source, repo, { recursive: true });
  // U5 (research.md R5): M holds no remote-tracking ref and no remote.
  const before = { tracking: g(["for-each-ref", "--format=%(refname)", "refs/remotes/"]), remotes: g(["remote"]) };
  if (JSON.stringify(before) !== JSON.stringify({ tracking: "", remotes: "" })) throw new Error(`M is not free of remotes: ${JSON.stringify(before)}`);
  const runs = [...RD_REMOTE_RUNS, ...RD_COMBINED_RUNS];
  const all = [...RD_NAMES, ...runs];
  // git-fast-import(1) `reset`: the branch starts at the M tip, and the next `commit` without `from` takes it as parent.
  const parts: Buffer[] = all.map((name) => Buffer.from(`reset refs/heads/${name}\nfrom ${mTip}\n\n`));
  for (let k = 0; k < RD_ONLY_COMMITS; k++) {
    parts.push(fiCommit({ mark: k + 1, ref: "refs/heads/d01", time: EPOCH_2020 + PERF_M.commits + k, message: `rd d01 commit ${k}\n`, files: { [`perf/rd/d01-${String(k).padStart(3, "0")}.txt`]: `rd d01 commit ${k}\n` } }));
  }
  const stream = join(temp, "RD.fast-import");
  writeFileSync(stream, Buffer.concat(parts));
  g(["fast-import", "--quiet"], readFileSync(stream));
  const d01 = g(["rev-parse", "--verify", "--end-of-options", "refs/heads/d01^{commit}"]).trim();
  ownedGit(git, PERF_CACHE_ROOT, temp, ["init", "-q", "--bare", "-b", "main", remote]);
  g(["remote", "add", RD_REMOTE, remote]);
  g(["push", "-q", RD_REMOTE, ...["main", ...all].map((name) => `refs/heads/${name}:refs/heads/${name}`)]);
  g(["fetch", "-q", RD_REMOTE]);
  // Plan.md D4 step 6: the review needs `refs/remotes/<R>/HEAD`. git-remote(1) `set-head <name> <branch>` sets it without a remote call.
  g(["remote", "set-head", RD_REMOTE, "main"]);
  // Only `d01` and the combined run branches stay local. Local `d01` stays at the M tip, so the 150 commits stay on its upstream only.
  const drop = [...RD_NAMES.slice(1), ...RD_REMOTE_RUNS].map((name) => `delete refs/heads/${name}\n`);
  g(["update-ref", "--stdin"], Buffer.from([`update refs/heads/d01 ${mTip}\n`, ...drop].join("")));
  for (const name of ["d01", ...RD_COMBINED_RUNS]) g(["branch", "-q", `--set-upstream-to=refs/remotes/${RD_REMOTE}/${name}`, name]);
  g(["commit-graph", "write", "--reachable"]);
  // The build oracle: Git's own reads give the D11 shape.
  const lines = (text: string) => text.split("\n").filter((l) => l !== "");
  const shape = {
    tracking: lines(g(["for-each-ref", "--format=%(refname)", `refs/remotes/${RD_REMOTE}/`])).length,
    head: g(["symbolic-ref", "-q", `refs/remotes/${RD_REMOTE}/HEAD`]).trim(),
    remoteHeads: lines(ownedGit(git, PERF_CACHE_ROOT, remote, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).toString("utf8")).length,
    // git-rev-parse(1) `--exclude`: the pattern drops `origin/d01` from the next `--remotes`.
    only: Number(g(["rev-list", "--count", d01, "--not", `--exclude=${RD_REMOTE}/d01`, "--remotes", "--branches", "--tags"]).trim()),
    local: lines(g(["for-each-ref", "--format=%(refname) %(objectname) %(upstream)", "refs/heads/d01", ...RD_COMBINED_RUNS.map((n) => `refs/heads/${n}`)])),
    dropped: lines(g(["for-each-ref", "--format=%(refname)", ...[...RD_NAMES.slice(1), ...RD_REMOTE_RUNS].map((n) => `refs/heads/${n}`)])).length,
  };
  const expected = {
    tracking: 1 + 1 + RD_BRANCHES + 2 * RD_RUNS,
    head: `refs/remotes/${RD_REMOTE}/main`,
    remoteHeads: 1 + RD_BRANCHES + 2 * RD_RUNS,
    only: RD_ONLY_COMMITS,
    local: ["d01", ...RD_COMBINED_RUNS].map((n) => `refs/heads/${n} ${mTip} refs/remotes/${RD_REMOTE}/${n}`),
    dropped: 0,
  };
  if (JSON.stringify(shape) !== JSON.stringify(expected)) throw new Error(`RD shape ${JSON.stringify(shape)} is not ${JSON.stringify(expected)}`);
  return { mTip, d01 };
}

// Builds RD once per builder digest and M state. The lock and the temporary folder follow `ensurePerfFixture`.
export function ensureRd(git: string): CachedRd {
  const m = ensurePerfFixture(git, PERF_M);
  const name = `RD-seed${PERF_SEED}-commit-graph`;
  const folder = ownedPath(PERF_CACHE_ROOT, name);
  const lock = ownedPath(PERF_CACHE_ROOT, `${name}.lock`);
  const temp = ownedPath(PERF_CACHE_ROOT, `${name}.tmp`);
  const repo = join(folder, "repo");
  const remote = join(folder, "remote.git");
  const manifestPath = join(folder, "manifest.json");
  acquireLock(lock);
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    if (existsSync(manifestPath) && existsSync(repo) && existsSync(remote)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      if (manifest.seed === PERF_SEED && manifest.builderDigest === currentDigest() && manifest.mDigest === m.manifest.facts.semanticDigest && manifest.mTip === m.manifest.facts.tip) {
        const now = probe(git, repo, remote);
        if (now.refs === manifest.refs && now.status === manifest.status && now.remoteRefs === manifest.remoteRefs) return { folder, repo, remote, facts: manifest.facts, reused: true };
      }
    }
    if (existsSync(temp)) removeTree(temp);
    mkdirSync(temp);
    const facts = build(git, temp, m.repo, m.manifest.facts.tip);
    // The cached work repository keeps the URL of the temporary remote path. Only a copy pushes, and it names its own remote (`copyRd`).
    const built = probe(git, join(temp, "repo"), join(temp, "remote.git"));
    const manifest: Manifest = { seed: PERF_SEED, builderDigest: currentDigest(), mDigest: m.manifest.facts.semanticDigest, mTip: m.manifest.facts.tip, ...built, facts };
    writeFileSync(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(folder)) removeTree(folder);
    renameSync(temp, folder);
    return { folder, repo, remote, facts, reused: false };
  } finally {
    removeTree(lock);
  }
}

// An independent copy of the work repository and its bare remote under the owned root, as perf-fixtures.ts `copyPerfFixture`.
// The copy pushes to its own remote only. It never changes the cache.
export function copyRd(git: string, cached: CachedRd, name: string): { repo: string; remote: string } {
  const dest = fixturePath(name);
  if (existsSync(dest)) throw new Error(`copy target exists: ${dest}`);
  mkdirSync(dest, { recursive: true });
  const repo = join(dest, "repo");
  const remote = join(dest, "remote.git");
  cpSync(cached.repo, repo, { recursive: true });
  cpSync(cached.remote, remote, { recursive: true });
  ownedGit(git, FIXTURE_ROOT, repo, ["remote", "set-url", RD_REMOTE, remote]);
  ownedGit(git, FIXTURE_ROOT, repo, ["update-index", "-q", "--refresh"], { allowExit: [0, 1] });
  return { repo, remote };
}
