// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describeGit } from "./git-binary";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { indexEntries, operationMarkers, rawIndexDigest, refState, workingFileDigests } from "./git-oracle";
import * as F from "./fixtures";

// This file imports no `src/` module, so it prints no ORIGIN line for `src/`. `fixture-root.ts` prints the ORIGIN of its contract file.

const TIMEOUT = 300_000;

// Git for Windows stores no device or inode number, and the builder fixes the creation time, so only there the raw index repeats.
const RAW_INDEX_REPEATS = process.platform === "win32";

function snapshot(git: string, repo: string) {
  return {
    entries: indexEntries(git, repo),
    rawIndex: RAW_INDEX_REPEATS ? rawIndexDigest(git, repo) : "not compared",
    files: workingFileDigests(repo),
    refs: refState(git, repo),
    markers: operationMarkers(git, repo),
  };
}

const paths = (out: Buffer) => [...new Set(out.toString("utf8").split("\0").filter((p) => p !== ""))].sort();

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
  const entries = indexEntries(git, repo);
  for (const expected of facts.entries) expect(entries).toContainEqual(expect.objectContaining(expected));
}

function canaryRuns(built: F.Built): Record<string, boolean> {
  return Object.fromEntries(Object.entries(built.facts.canaries).map(([name, log]) => [name, existsSync(join(built.root, log))]));
}

// Builds twice, then compares the facts, the oracle snapshots, and Git with the facts.
function check(git: string, label: string, build: (name: string) => F.Built, extra?: (git: string, built: F.Built) => void): void {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const started = performance.now();
  let a: F.Built;
  try {
    a = build(`${slug}-1`);
  } catch (error) {
    if (!(error instanceof F.CapabilitySkip)) throw error;
    console.log(`SKIP ${label}: missing capability ${error.capability} (unverified)`);
    return;
  }
  const first = performance.now();
  const b = build(`${slug}-2`);
  console.log(`BUILD ${label} ${(first - started).toFixed(0)} ms, rebuild ${(performance.now() - first).toFixed(0)} ms`);
  for (const built of [a, b]) {
    const runs = canaryRuns(built);
    expect(runs).toEqual(Object.fromEntries(Object.keys(runs).map((k) => [k, false])));
  }
  expect(b.facts).toEqual(a.facts);
  expect(Object.keys(a.facts.repos).length).toBeGreaterThan(0);
  for (const [key, facts] of Object.entries(a.facts.repos)) {
    const one = snapshot(git, join(a.root, key));
    expect(snapshot(git, join(b.root, key))).toEqual(one);
    if (key === Object.keys(a.facts.repos)[0]) console.log(`FACTS ${label} ${key}: head ${facts.head.target ?? "detached"} ${facts.head.oid ?? "unborn"}, index ${one.entries.length} entries ${one.rawIndex ?? "absent"}, staged ${facts.staged.length}, unstaged ${facts.unstaged.length}, untracked ${facts.untracked.length}, conflicted ${facts.conflicted.length}, markers [${facts.markers.join(",")}]`);
    verify(git, join(a.root, key), facts, a.facts.disarm);
  }
  extra?.(git, a);
  for (const name of (a.facts.notes.unverified as string[] | undefined) ?? []) console.log(`SKIP ${label}: missing capability ${name} (unverified)`);
}

const git1 = (git: string, cwd: string, args: string[], allowExit = [0]) => ownedGit(git, FIXTURE_ROOT, cwd, args, { allowExit });

describeGit("fixture builders", (git) => {
  useFixtureRoot();

  test("F01 empty", () => check(git, "F01 empty", (n) => F.buildF01(git, n, "empty"), (g, b) => expect(rawIndexDigest(g, join(b.root, "repo"))).toBeNull()), TIMEOUT);
  test("F01 unborn-added", () => check(git, "F01 unborn-added", (n) => F.buildF01(git, n, "unborn-added")), TIMEOUT);

  test("F02", () =>
    check(git, "F02", (n) => F.buildF02(git, n), (g, b) => {
      const repo = join(b.root, "repo");
      const hunks = (args: string[]) => (git1(g, repo, ["--literal-pathspecs", ...args, "-p", "--", "multi.txt"]).toString().match(/^@@ /gm) ?? []).length;
      const expected = (b.facts.notes.hunks as Record<string, { staged: number[]; unstaged: number[] }>)["multi.txt"]!;
      expect(hunks(["diff", "--cached", "--no-ext-diff"])).toBe(expected.staged.length);
      expect(hunks(["diff-files"])).toBe(expected.unstaged.length);
    }), TIMEOUT);

  test("F03", () =>
    check(git, "F03", (n) => F.buildF03(git, n), (g, b) => {
      const repo = join(b.root, "repo");
      const long = b.facts.notes.longPath as { path: string; utf16Units: number; bunWrote: boolean };
      expect(long.utf16Units).toBeGreaterThanOrEqual(260);
      if (long.bunWrote) expect(Object.keys(workingFileDigests(repo))).toContain(long.path);
      const raw = git1(g, repo, ["ls-files", "-z", "--stage"]);
      expect(raw.includes(Buffer.from(b.facts.notes.invalidUtf8IndexPath as string, "hex"))).toBe(true);
      console.log(`OBSERVATION T066: F03 long path of ${long.utf16Units} UTF-16 units: Bun wrote and read it back = ${long.bunWrote}; Git without core.longpaths lists it as untracked = ${paths(git1(g, repo, ["ls-files", "-o", "-z"])).includes(long.path)}`);
    }), TIMEOUT);

  test("F05", () =>
    check(git, "F05", (n) => F.buildF05(git, n), (g, b) => {
      const subs = b.facts.notes.submodules as Record<string, { recorded: string; checkedOut: string }>;
      for (const [path, s] of Object.entries(subs)) expect(git1(g, join(b.root, "super", path), ["rev-parse", "HEAD"]).toString().trim()).toBe(s.checkedOut);
      expect(readFileSync(join(b.root, "super", ".gitmodules"), "utf8")).toContain("url = ../sub-src");
    }), TIMEOUT);

  test("F06", () => check(git, "F06", (n) => F.buildF06(git, n)), TIMEOUT);

  test("F07", () =>
    check(git, "F07", (n) => F.buildF07(git, n), (g, b) => {
      for (const [alias, target] of Object.entries((b.facts.notes.junctions as Record<string, string>) ?? {})) {
        expect(lstatSync(join(b.root, alias)).isSymbolicLink()).toBe(true);
        expect(realpathSync.native(join(b.root, alias))).toBe(realpathSync.native(join(b.root, target)));
      }
      const common = (wt: string) => git1(g, join(b.root, wt), ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
      const own = (wt: string) => git1(g, join(b.root, wt), ["rev-parse", "--path-format=absolute", "--git-dir"]).toString().trim();
      expect(common("wt-a")).toBe(common("main"));
      expect(new Set([own("main"), own("wt-a"), own("wt-b")]).size).toBe(3);
      expect(git1(g, join(b.root, "bare.git"), ["rev-parse", "--is-bare-repository"]).toString().trim()).toBe("true");
      expect(git1(g, join(b.root, "broken"), ["rev-parse", "--git-dir"], [128]).length).toBe(0);
    }), TIMEOUT);

  for (const variant of ["sha1", "sha256", "detached"] as const) {
    test(`F08 ${variant}`, () => check(git, `F08 ${variant}`, (n) => F.buildF08(git, n, variant)), TIMEOUT);
  }

  for (const variant of ["lock", "merge", "rebase", "cherry-pick", "revert", "split-index", "split-config", "flags", "sparse"] as const) {
    test(`F10 ${variant}`, () =>
      check(git, `F10 ${variant}`, (n) => F.buildF10(git, n, variant), (g, b) => {
        const gitDir = join(b.root, "repo", ".git");
        const shared = readdirSync(gitDir).filter((f) => f.startsWith("sharedindex."));
        expect(shared.length).toBe(variant === "split-index" ? 1 : 0);
        if (variant === "split-config") expect(git1(g, join(b.root, "repo"), ["config", "--local", "core.splitIndex"]).toString().trim()).toBe("true");
        if (variant === "lock") for (const lock of b.facts.notes.locks as string[]) expect(existsSync(join(b.root, "repo", lock))).toBe(true);
      }), TIMEOUT);
  }

  test("F15", () =>
    check(git, "F15", (n) => F.buildF15(git, n), (_g, b) => {
      expect(existsSync(join(b.root, "plain", ".git"))).toBe(false);
      expect((b.facts.notes.hostile as string[]).length).toBe(F.POWERSHELL_QUOTES.length);
      expect(readdirSync(join(b.root, "hostile")).sort()).toEqual([...(b.facts.notes.hostile as string[])].sort());
    }), TIMEOUT);

  for (const variant of ["at-limit", "over-limit"] as const) {
    test(`F16 status ${variant}`, () =>
      check(git, `F16 status ${variant}`, (n) => F.buildF16Status(git, n, variant), (_g, b) => {
        expect(b.facts.repos.repo!.unstaged.length).toBe(F.F16_STATUS_RECORDS + (variant === "over-limit" ? 1 : 0));
      }), TIMEOUT);
  }

  for (const variant of ["parents-64", "parents-65", "parent-refs", "object-at-limit", "object-over-limit", "traversal"] as const) {
    test(`F16 history ${variant}`, () =>
      check(git, `F16 history ${variant}`, (n) => F.buildF16History(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        const rows = git1(g, repo, ["rev-list", "--parents", "--date-order", "--max-count=100", "HEAD"]).toString().trim().split("\n");
        const parentRefs = rows.reduce((sum, row) => sum + row.split(" ").length - 1, 0);
        const maxParents = Math.max(...rows.map((row) => row.split(" ").length - 1));
        if (variant === "parents-64") expect(maxParents).toBe(64);
        if (variant === "parents-65") expect(maxParents).toBe(65);
        if (variant === "parent-refs") expect([parentRefs > 1024, maxParents <= 64]).toEqual([true, true]);
        if (variant.startsWith("object")) expect(Number(git1(g, repo, ["cat-file", "-s", "HEAD"]).toString())).toBe(b.facts.notes.objectBytes as number);
        if (variant === "traversal") {
          const text = git1(g, repo, ["rev-list", "--max-count=100", "--format=%H %P %s", "HEAD"]);
          expect([rows.length, text.length > 128 * 1024]).toEqual([100, true]);
          expect(Math.max(...rows.map((r) => Number(git1(g, repo, ["cat-file", "-s", r.split(" ")[0]!]).toString())))).toBeLessThan(F.F16_OBJECT_LIMIT);
        }
        console.log(`FACTS F16 history ${variant}: rows ${rows.length}, parent references ${parentRefs}, max parents ${maxParents}`);
      }), TIMEOUT);
  }

  test("F17 trust", () =>
    check(git, "F17 trust", (n) => F.buildF17(git, n, "trust"), (g, b) => {
      const repo = join(b.root, "repo");
      const local = git1(g, repo, ["config", "--local", "--list"]).toString();
      for (const key of ["filter.canary.clean=./tools/clean.sh", "filter.proc.process=", "core.fsmonitor=", "diff.external=", "diff.tcv.textconv="]) expect(local).toContain(key);
      expect(existsSync(join(repo, "tools", "clean.sh"))).toBe(true);
      // The clean canary must be live: `hash-object --path` applies the clean filter of that path.
      expect(canaryRuns(b).clean).toBe(false);
      ownedGit(git, FIXTURE_ROOT, repo, ["hash-object", "--path=data.dat", "--stdin"], { input: Buffer.from("x\n") });
      expect(canaryRuns(b).clean).toBe(true);
    }), TIMEOUT);

  for (const variant of ["partial-reset-soft", "partial-read-tree"] as const) {
    test(`F17 ${variant}`, () =>
      check(git, `F17 ${variant}`, (n) => F.buildF17(git, n, variant), (g, b) => {
        const clone = join(b.root, "clone");
        const missing = b.facts.notes.missingBlobs as string[];
        expect(missing.length).toBe(2);
        for (const oid of missing) expect(git1(g, clone, ["--no-lazy-fetch", "cat-file", "-e", oid], [1, 128]).length).toBe(0);
        expect(canaryRuns(b)).toEqual({ uploadpack: false });
        // The canary must be live: one lazy fetch outside the facts runs it.
        git1(g, clone, ["cat-file", "-p", missing[0]!]);
        expect(canaryRuns(b)).toEqual({ uploadpack: true });
      }), TIMEOUT);
  }

  for (const variant of ["files", "reftable"] as const) {
    test(`F18 ${variant}`, () =>
      check(git, `F18 ${variant}`, (n) => F.buildF18(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        expect(git1(g, repo, ["rev-parse", "--show-ref-format"]).toString().trim()).toBe(variant);
        if (variant === "files") expect(readFileSync(join(repo, ".git", "packed-refs"), "utf8")).toContain("refs/heads/packed");
      }), TIMEOUT);
  }

  for (const variant of ["linear", "merge", "octopus", "skewed", "roots", "long", "wide", "encoding", "shallow", "sha256"] as const) {
    test(`F19 ${variant}`, () =>
      check(git, `F19 ${variant}`, (n) => F.buildF19(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        const expected = b.facts.notes.parents as Record<string, string[]>;
        const shallow = (b.facts.notes.shallow as string[] | undefined) ?? [];
        const rows = git1(g, repo, ["rev-list", "--parents", "HEAD"]).toString().trim().split("\n").map((r) => r.split(" "));
        for (const [oid, ...parents] of rows) if (!shallow.includes(oid!)) expect(parents).toEqual(expected[oid!]!);
        if (variant === "shallow") {
          expect(readFileSync(join(repo, ".git", "shallow"), "utf8").trim().split("\n")).toEqual(shallow);
          expect(rows.length).toBe(b.facts.notes.depth as number);
        } else {
          expect(rows.length).toBe(Object.keys(expected).length);
        }
        if (variant === "encoding") {
          const raw = git1(g, repo, ["cat-file", "commit", "HEAD"]);
          expect(raw.includes(Buffer.from("encoding ISO-8859-1\n"))).toBe(true);
          expect(raw.includes(Buffer.from([0x4a, 0x6f, 0x73, 0xe9]))).toBe(true);
        }
      }), TIMEOUT);
  }
});
