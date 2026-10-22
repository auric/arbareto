// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fixture builds in the T164 performance cache (T324). Git runs with `fixtureEnv`, so a caller must hold an owned root through `useFixtureRoot`.
// Only a builder whose repositories record no absolute path may use this cache, because each case gets a copy in another folder.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureEnv, fixturePath, ownedPath, removeTree } from "../git/fixture-root";
import { fixtureGitPath } from "../git/git-binary";
import { buildF16History, buildF16Status, type Built, type F16HistoryVariant, type F16PageVariant } from "../git/fixtures";
import { sha256 } from "../git/git-oracle";
import { acquireLock, builderDigest, PERF_CACHE_ROOT } from "./perf-fixtures";

// The sources that the builders run, and this file.
const SOURCES = ["../git/fixtures.ts", "../git/fixture-root.ts", "../git/git-oracle.ts", "fixture-cache.ts"].map((p) => join(import.meta.dir, p));

function gitBuildOptions(git: string): string {
  const proc = Bun.spawnSync([fixtureGitPath(git), "version", "--build-options"], { cwd: PERF_CACHE_ROOT, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git version --build-options exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

// The path, type, and SHA-256 of each entry, sorted by path. Any other entry type refuses the tree.
export function treeDigest(dir: string): string {
  const records: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) {
        records.push(`d ${path}`);
        walk(path);
      } else if (stat.isFile()) records.push(`f ${path} ${sha256(readFileSync(join(dir, path)))}`);
      else throw new Error(`unexpected entry type in ${dir}: ${path}`);
    }
  };
  walk("");
  return sha256(Buffer.from(records.join("\n")));
}

interface Manifest {
  key: string;
  tree: string;
  built: Omit<Built, "root">;
}

// Builds `builder` with `variant` once under the cache root and gives each case an independent copy under the fixture root.
// The key covers the builder, the variant, the builder sources, and the Git build, so a changed input never reuses a stale build.
// The tree digest must match the build, so a changed cache file causes a rebuild. The copy keeps the raw index bytes of the build.
function cachedBuild(git: string, builder: string, variant: string, name: string, build: (name: string) => Built): { built: Built; reused: boolean } {
  mkdirSync(PERF_CACHE_ROOT, { recursive: true });
  const inputs = { builder, variant, sources: SOURCES.map((p) => builderDigest(readFileSync(p))), git: gitBuildOptions(git) };
  const key = sha256(Buffer.from(JSON.stringify(inputs)));
  const id = `${builder}-${variant}-${key.slice(0, 16)}`;
  const folder = ownedPath(PERF_CACHE_ROOT, id);
  const lock = ownedPath(PERF_CACHE_ROOT, `${id}.lock`);
  const temp = ownedPath(PERF_CACHE_ROOT, `${id}.tmp`);
  const tree = join(folder, "tree");
  const manifestPath = join(folder, "manifest.json");
  // The builder accepts an existing folder, such as a service folder, so the copy goes into it and never replaces an entry.
  const dest = fixturePath(name);
  acquireLock(lock);
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    let manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest) : undefined;
    const reused = manifest !== undefined && manifest.key === key && existsSync(tree) && treeDigest(tree) === manifest.tree;
    if (!reused) {
      if (existsSync(temp)) removeTree(temp);
      mkdirSync(temp);
      const { root, ...fresh } = build(`${name}-cache-build`);
      renameSync(root, join(temp, "tree"));
      manifest = { key, tree: treeDigest(join(temp, "tree")), built: fresh };
      writeFileSync(join(temp, "manifest.json"), JSON.stringify(manifest));
      if (existsSync(folder)) removeTree(folder);
      renameSync(temp, folder);
    }
    // The copy runs under the lock, so no rebuild removes the tree during the copy.
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(tree)) {
      if (existsSync(join(dest, entry))) throw new Error(`copy target exists: ${join(dest, entry)}`);
      cpSync(join(tree, entry), join(dest, entry), { recursive: true });
    }
    return { built: { ...manifest!.built, root: dest }, reused };
  } finally {
    removeTree(lock);
  }
}

export const cachedF16Status = (git: string, name: string, variant: "at-limit" | "over-limit") => cachedBuild(git, "F16-status", variant, name, (n) => buildF16Status(git, n, variant));

export const cachedF16History = (git: string, name: string, variant: F16HistoryVariant | F16PageVariant) => cachedBuild(git, "F16-history", variant, name, (n) => buildF16History(git, n, variant));
