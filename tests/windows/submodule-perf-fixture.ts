// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T108: the SC-012 fixtures of plan.md D19 and O-11. A superproject with `count` initialized clean submodules of one library commit.
// The cache follows tests/git/history-diff-fixtures.ts `cached` (T113): the manifest records the exact refs of every repository of the entry.
// Git runs with `fixtureEnv`, so a caller must hold an owned root through `useFixtureRoot`. Never delete PERF_CACHE_ROOT.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedPath, removeTree } from "../git/fixture-root";
import { gitExit, runGit } from "../git/history-diff-fixtures";
import { acquireLock, builderDigest, PERF_CACHE_ROOT } from "./perf-fixtures";

// The last gitlink in index order: "m/..." sorts before "mark", because "/" (0x2F) is below "a" (0x61).
export const MARKED = "mark";
export const PARENT_FILE = "p.txt";
export const PARENT_TEXT = "p\n";

export interface SubmoduleWorld {
  repo: string;
  // The library commit of every gitlink.
  oid: string;
  // Every gitlink path in index order. The last one is MARKED.
  paths: string[];
}

interface Manifest {
  builderDigest: string;
  // The exact `for-each-ref --format=%(objectname) %(refname)` output of the superproject and of each gitlink, in `paths` order.
  refs: string[];
  built: Omit<SubmoduleWorld, "repo">;
}

const currentDigest = () => builderDigest(readFileSync(import.meta.path));
const gitIn = (exe: string) => (cwd: string, args: string[], input?: Uint8Array) => runGit(exe, PERF_CACHE_ROOT, cwd, args, { input });

// Null when one Git run fails, so a damaged entry never counts as reusable.
function refLists(exe: string, repo: string, paths: string[]): string[] | null {
  const lists: string[] = [];
  for (const dir of [repo, ...paths.map((p) => join(repo, ...p.split("/")))]) {
    const proc = gitExit(exe, PERF_CACHE_ROOT, dir, ["--no-optional-locks", "for-each-ref", "--format=%(objectname) %(refname)"]);
    if (proc.exitCode !== 0) return null;
    lists.push(proc.stdout.toString("utf8"));
  }
  return lists;
}

function build(exe: string, repo: string, count: number): Omit<SubmoduleWorld, "repo"> {
  const git = gitIn(exe);
  const lib = join(repo, "..", "lib");
  mkdirSync(ownedPath(PERF_CACHE_ROOT, lib), { recursive: true });
  mkdirSync(ownedPath(PERF_CACHE_ROOT, repo), { recursive: true });
  git(lib, ["init", "-q", "-b", "main"]);
  writeFileSync(join(lib, "f.txt"), "lib\n");
  git(lib, ["add", "--", "f.txt"]);
  git(lib, ["commit", "-q", "--no-verify", "-m", "lib"]);
  const oid = git(lib, ["rev-parse", "HEAD"]).toString("utf8").trim();
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, PARENT_FILE), PARENT_TEXT);
  git(repo, ["add", "--", PARENT_FILE]);
  git(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
  const paths = [...Array.from({ length: count - 1 }, (_, i) => `m/${String(i).padStart(3, "0")}`), MARKED];
  for (const path of paths) cpSync(lib, join(repo, ...path.split("/")), { recursive: true });
  git(repo, ["update-index", "--index-info"], Buffer.from(paths.map((p) => `160000 ${oid}\t${p}\n`).join("")));
  git(repo, ["commit", "-q", "--no-verify", "-m", "submodules"]);
  return { oid, paths };
}

// Builds once per builder digest and `count` under the cache root. The lock and the temporary folder follow `ensureLargeFixture`.
export function submoduleWorld(gitExe: string, count: number): SubmoduleWorld {
  const name = `f005-submodules-${count}`;
  mkdirSync(PERF_CACHE_ROOT, { recursive: true });
  const folder = ownedPath(PERF_CACHE_ROOT, name);
  const lock = ownedPath(PERF_CACHE_ROOT, `${name}.lock`);
  const temp = ownedPath(PERF_CACHE_ROOT, `${name}.tmp`);
  const manifestPath = join(folder, "manifest.json");
  acquireLock(lock);
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      const repo = join(folder, "repo");
      if (manifest.builderDigest === currentDigest() && existsSync(repo) && JSON.stringify(refLists(gitExe, repo, manifest.built.paths)) === JSON.stringify(manifest.refs)) return { ...manifest.built, repo };
    }
    if (existsSync(temp)) removeTree(temp);
    mkdirSync(temp);
    const built = build(gitExe, join(temp, "repo"), count);
    const refs = refLists(gitExe, join(temp, "repo"), built.paths);
    if (refs === null || refs.some((r) => r === "")) throw new Error(`for-each-ref failed or listed no refs in ${join(temp, "repo")}`);
    writeFileSync(join(temp, "manifest.json"), `${JSON.stringify({ builderDigest: currentDigest(), refs, built } satisfies Manifest, null, 2)}\n`);
    if (existsSync(folder)) removeTree(folder);
    renameSync(temp, folder);
    return { ...built, repo: join(folder, "repo") };
  } finally {
    removeTree(lock);
  }
}
