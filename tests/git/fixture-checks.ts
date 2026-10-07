// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The shared checks of the fixture builder test files (`tests/git/fixtures-*.test.ts`).

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { FIXTURE_ROOT, ownedGit } from "./fixture-root";
import { indexEntries, operationMarkers, rawIndexDigest, refState, submoduleUpdateOracle, workingFileDigests } from "./git-oracle";
import * as F from "./fixtures";

export const TIMEOUT = 300_000;

// Git for Windows stores no device or inode number, and the builder fixes the creation time, so only there the raw index repeats.
const RAW_INDEX_REPEATS = process.platform === "win32";

// `disarm` keeps the index read from starting a fixture monitor.
function snapshot(git: string, repo: string, disarm: string[]) {
  return {
    entries: indexEntries(git, repo, disarm),
    rawIndex: RAW_INDEX_REPEATS ? rawIndexDigest(git, repo) : "not compared",
    files: workingFileDigests(repo),
    refs: refState(git, repo),
    markers: operationMarkers(git, repo),
  };
}

export const paths = (out: Buffer) => [...new Set(out.toString("utf8").split("\0").filter((p) => p !== ""))].sort();

// Checks one repository against the facts of its builder through Git plumbing and the oracle.
function verify(git: string, repo: string, facts: F.RepoFacts, disarm: string[]): void {
  const g = (args: string[], allowExit = [0]) => ownedGit(git, FIXTURE_ROOT, repo, ["--no-optional-locks", ...disarm, ...args], { allowExit });
  expect(g(["rev-parse", "--show-object-format"]).toString().trim()).toBe(facts.objectFormat);
  const refs = refState(git, repo);
  expect(refs.refs).toEqual(facts.refs);
  expect({ target: refs.headTarget, oid: refs.headOid }).toEqual(facts.head);
  expect(operationMarkers(git, repo)).toEqual(facts.markers);
  expect(paths(g(["diff", "--cached", "--no-renames", "--no-ext-diff", "--name-only", "-z"]))).toEqual(facts.staged);
  expect(paths(g(["diff-files", "--no-renames", "--ignore-submodules=dirty", "--name-only", "-z"]))).toEqual(facts.unstaged);
  expect(paths(g(["ls-files", "-o", "-z", "--exclude-standard"]))).toEqual(facts.untracked);
  const unmerged = g(["ls-files", "-u", "-z"]).toString("utf8").split("\0").filter((r) => r !== "").map((r) => r.slice(r.indexOf("\t") + 1));
  expect([...new Set(unmerged)].sort()).toEqual(facts.conflicted);
  const entries = indexEntries(git, repo, disarm);
  for (const expected of facts.entries) expect(entries).toContainEqual(expect.objectContaining(expected));
}

export function canaryRuns(built: F.Built): Record<string, boolean> {
  return Object.fromEntries(Object.entries(built.facts.canaries).map(([name, log]) => [name, existsSync(join(built.root, log))]));
}

export const git1 = (git: string, cwd: string, args: string[], allowExit = [0]) => ownedGit(git, FIXTURE_ROOT, cwd, args, { allowExit });

// Gives the `check` of one test file. Call it once inside the `describeGit` block that calls `useFixtureRoot`, and call `filemodeTest` after the last case.
// The state is per call, because a serial `bun test` run shares one module registry across files.
export function fixtureChecks(git: string) {
  // Each repository that a case of this file builds. `filemodeTest` reads its `core.filemode` after the last case.
  const builtRepos: string[] = [];
  // A builder that sets local `core.filemode=true` names the repository in `notes.filemode`.
  const filemodeExceptions = new Map<string, string>();

  // Builds twice, then compares the facts, the oracle snapshots, and Git with the facts.
  // `rebuild` gives the second build. A cached second build must equal the fresh first build.
  function check(label: string, build: (name: string) => F.Built, extra?: (git: string, built: F.Built) => void, rebuild = build): void {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    let a: F.Built;
    try {
      a = build(`${slug}-1`);
      builtRepos.push(...Object.keys(a.facts.repos).map((key) => join(a.root, key)));
      for (const [key, value] of Object.entries((a.facts.notes.filemode as Record<string, string> | undefined) ?? {})) filemodeExceptions.set(join(a.root, key), value);
    } catch (error) {
      if (!(error instanceof F.CapabilitySkip)) throw error;
      console.log(`SKIP ${label}: missing capability ${error.capability} (unverified)`);
      return;
    }
    const b = rebuild(`${slug}-2`);
    for (const built of [a, b]) {
      const runs = canaryRuns(built);
      expect(runs).toEqual(Object.fromEntries(Object.keys(runs).map((k) => [k, false])));
    }
    expect(b.facts).toEqual(a.facts);
    expect(Object.keys(a.facts.repos).length).toBeGreaterThan(0);
    for (const [key, facts] of Object.entries(a.facts.repos)) {
      const one = snapshot(git, join(a.root, key), a.facts.disarm);
      expect(snapshot(git, join(b.root, key), b.facts.disarm)).toEqual(one);
      if (key === Object.keys(a.facts.repos)[0]) console.log(`FACTS ${label} ${key}: head ${facts.head.target ?? "detached"} ${facts.head.oid ?? "unborn"}, index ${one.entries.length} entries ${one.rawIndex ?? "absent"}, staged ${facts.staged.length}, unstaged ${facts.unstaged.length}, untracked ${facts.untracked.length}, conflicted ${facts.conflicted.length}, markers [${facts.markers.join(",")}]`);
      verify(git, join(a.root, key), facts, a.facts.disarm);
    }
    extra?.(git, a);
    for (const name of (a.facts.notes.unverified as string[] | undefined) ?? []) console.log(`SKIP ${label}: missing capability ${name} (unverified)`);
  }

  // Git on Linux and macOS sets `core.filemode` from a probe. The builders fix it at local scope, to false unless `notes.filemode` names another value.
  const filemodeTest = () =>
    test("each built repository has its fixed core.filemode", () => {
      expect(builtRepos.length).toBeGreaterThan(0);
      const key = (repo: string) => relative(FIXTURE_ROOT, repo).replaceAll("\\", "/");
      const values = Object.fromEntries(builtRepos.map((repo) => [key(repo), git1(git, repo, ["config", "--local", "--get", "core.filemode"], [0, 1]).toString().trim()]));
      expect(values).toEqual(Object.fromEntries(builtRepos.map((repo) => [key(repo), filemodeExceptions.get(repo) ?? "false"])));
    }, TIMEOUT);

  return { check, builtRepos, filemodeTest };
}

// Checks the submodule HEADs and kept Git folders of `notes`, then Git's own update in a copy against `notes.oracle`.
export function checkSubmodules(git: string, b: F.Built): void {
  const sup = join(b.root, "super");
  for (const [path, s] of Object.entries(b.facts.notes.submodules as Record<string, { head: string | null }>)) {
    if (s.head !== null) expect(`${path} ${git1(git, join(sup, path), ["rev-parse", "--verify", "-q", "HEAD"]).toString().trim()}`).toBe(`${path} ${s.head}`);
  }
  for (const [path, dir] of Object.entries((b.facts.notes.kept as Record<string, string> | undefined) ?? {})) {
    // research.md R14 S11: a kept folder whose `core.worktree` is absent needs `--work-tree` beside `--git-dir`.
    const absolute = git1(git, b.root, ["--git-dir", join(b.root, dir), "--work-tree", join(b.root, dir), "rev-parse", "--absolute-git-dir"]).toString().trim();
    expect(`${path} ${relative(b.root, absolute).replaceAll("\\", "/")}`).toBe(`${path} ${dir}`);
  }
  const oracle = b.facts.notes.oracle as { exit: number; heads?: Record<string, string> } | null;
  if (oracle === null) return;
  const result = submoduleUpdateOracle(git, sup, join(b.root, "oracle-copy"), { GIT_CONFIG_GLOBAL: join(b.root, b.facts.notes.globalConfig as string) });
  expect(oracle.heads === undefined ? { exit: result.exitCode } : { exit: result.exitCode, heads: result.heads }).toEqual(oracle);
}

// Counts the `@@ ` hunk headers of each path in `notes.hunks`, for the staged and the unstaged side.
export function expectHunks(git: string, repo: string, b: F.Built): void {
  const hunks = (args: string[], path: string) => (git1(git, repo, ["--literal-pathspecs", ...args, "-p", "--no-ext-diff", "--no-textconv", "--", path]).toString().match(/^@@ /gm) ?? []).length;
  for (const [path, expected] of Object.entries(b.facts.notes.hunks as Record<string, { staged?: number[]; unstaged: number[] }>)) {
    expect(`${path} ${hunks(["diff", "--cached"], path)}`).toBe(`${path} ${expected.staged?.length ?? 0}`);
    expect(`${path} ${hunks(["diff-files"], path)}`).toBe(`${path} ${expected.unstaged.length}`);
  }
}
