// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T001: the self-check of the feature 002 history fixtures (plan.md P0.1).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_BODY_BYTES } from "../../src/contracts/envelope";
import { REF_LISTING_RECORDS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { hasCommitGraph, PERF_CACHE_ROOT, semanticDigest } from "../windows/perf-fixtures";
import { FIXTURE_ROOT, fixtureDir, ownedGit, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { refState } from "./git-oracle";
import { buildLargeRepo, buildSmallFixtures, H1M, H200K, largeCase, largeFixture, LONG_BODY_WORD, repositoryDigest, SMALL_NAMES, withCommitGraph, type LargeSpec, type SmallFixture } from "./history-fixtures";

printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);

const TASK = "T001";
const SMALL_TIMEOUT_MS = 300_000;
// The H1M build runs once per builder digest (plan.md P0.1 "Build time for 1M commits").
const LARGE_TIMEOUT_MS = 60 * 60_000;

const lines = (out: Buffer) => out.toString("utf8").split("\n").filter((l) => l !== "");

describeGit("history fixtures", (git) => {
  useFixtureRoot();
  const g = (repo: string, args: string[], allowExit?: number[]) => ownedGit(git, FIXTURE_ROOT, repo, ["--no-optional-locks", ...args], { allowExit });

  // commit-graph.c `commit_graph_compatible` refuses a shallow repository. An empty repository has no commit to write.
  const graphExpected = (f: SmallFixture) => f.commitGraph && f.name !== "shallow" && f.name !== "empty";

  function checkSmall(f: SmallFixture): void {
    const before = repositoryDigest(f.repo);
    const revList = lines(g(f.repo, ["rev-list", "--parents", "--all"])).sort();
    expect({ name: f.name, revList }).toEqual({ name: f.name, revList: f.expect.revList });
    expect({ name: f.name, refs: lines(g(f.repo, ["for-each-ref", "--format=%(refname)"])).sort() }).toEqual({ name: f.name, refs: f.expect.refs });
    const head = refState(git, f.repo);
    expect({ name: f.name, target: head.headTarget, oid: head.headOid }).toEqual({ name: f.name, target: f.expect.headTarget, oid: f.expect.headOid });
    expect({ name: f.name, commitGraph: hasCommitGraph(git, f.repo) }).toEqual({ name: f.name, commitGraph: graphExpected(f) });
    expect(repositoryDigest(f.repo)).toBe(before);
    const parentCounts = revList.map((l) => l.split(" ").length - 1);
    console.log(`HISTORY_FIXTURE ${f.name}${f.commitGraph ? " commit-graph" : ""}: ${revList.length} commits, ${f.expect.refs.length} refs, most parents ${Math.max(0, ...parentCounts)}`);
  }

  test("each small fixture holds the expected commits, parents, refs, and HEAD, with and without a commit-graph", () => {
    const fixtures = buildSmallFixtures(git, "t001");
    expect(fixtures.map((f) => f.name)).toEqual([...SMALL_NAMES]);
    for (const f of fixtures) {
      checkSmall(f);
      checkSmall(withCommitGraph(git, f));
    }
    const by = new Map(fixtures.map((f) => [f.name, f]));

    const octopus = by.get("octopus-65")!;
    expect(octopus.expect.revList.some((l) => l.split(" ").length === 66)).toBe(true);
    expect(by.get("octopus-10")!.expect.revList.some((l) => l.split(" ").length === 11)).toBe(true);
    expect(by.get("refs-10001")!.expect.refs.length).toBe(REF_LISTING_RECORDS + 1);

    // `log -g` walks the reflog, newest entry first (git-log(1)).
    const stash = by.get("stash")!;
    expect(lines(g(stash.repo, ["log", "-g", "--format=%H", "refs/stash"]))).toEqual([stash.oids.get(7)!, stash.oids.get(5)!]);

    // technical/shallow.adoc: `$GIT_DIR/shallow` lists the commits that Git treats as roots.
    const shallow = by.get("shallow")!;
    expect(g(shallow.repo, ["rev-parse", "--is-shallow-repository"]).toString().trim()).toBe("true");
    const shallowFile = g(shallow.repo, ["rev-parse", "--path-format=absolute", "--git-path", "shallow"]).toString().trim();
    expect(lines(readFileSync(shallowFile))).toEqual([shallow.oids.get(4)!]);

    // FR-019: the word starts after the 16 KiB body bound.
    const long = by.get("long-body")!;
    const object = g(long.repo, ["cat-file", "commit", long.oids.get(2)!]);
    const body = object.subarray(object.indexOf("\n\n") + 2);
    const subjectEnd = body.indexOf("\n\n") + 2;
    expect(body.indexOf(LONG_BODY_WORD) - subjectEnd).toBeGreaterThan(HISTORY_BODY_BYTES);
  }, SMALL_TIMEOUT_MS);

  test("the repository digest is equal for an unchanged repository and differs after one update-ref", () => {
    const [f] = buildSmallFixtures(git, "t001-digest", ["criss-cross"]);
    const first = repositoryDigest(f!.repo);
    expect(repositoryDigest(f!.repo)).toBe(first);
    g(f!.repo, ["update-ref", "refs/heads/digest-check", f!.oids.get(1)!]);
    expect(repositoryDigest(f!.repo)).not.toBe(first);
  }, SMALL_TIMEOUT_MS);

  test("the large-fixture builder gives equal refs and semantic digests in two builds, with and without a commit-graph", () => {
    const spec: LargeSpec = { name: "H3K", commits: 3_000, cachedByDefault: false };
    const build = (n: string, commitGraph: boolean) => {
      const dir = fixtureDir(n);
      const repo = join(dir, "repo");
      return { repo, facts: buildLargeRepo(git, FIXTURE_ROOT, repo, spec, join(dir, "stream"), commitGraph) };
    };
    const a = build("t001-h3k-1", false);
    const b = build("t001-h3k-2", false);
    const cg = build("t001-h3k-3", true);
    expect(b.facts).toEqual(a.facts);
    expect(refState(git, cg.repo)).toEqual(refState(git, a.repo));
    expect([a.facts.commits, a.facts.commitGraph, cg.facts.commitGraph]).toEqual([spec.commits, false, true]);
    expect([hasCommitGraph(git, a.repo), hasCommitGraph(git, cg.repo)]).toEqual([false, true]);
    expect(lines(g(a.repo, ["rev-list", "--count", "--all"]))).toEqual([String(spec.commits)]);
    expect(Number(lines(g(a.repo, ["rev-list", "--merges", "--count", "--all"]))[0])).toBeGreaterThan(0);
    // `%e` is the encoding header of the commit (git-log(1) "PRETTY FORMATS").
    expect(new Set(lines(g(a.repo, ["log", "--all", "--format=%e"])))).toEqual(new Set(["windows-1251"]));
    console.log(`HISTORY_FIXTURE H3K: ${a.facts.commits} commits, ${a.facts.refs} refs, semantic digest ${a.facts.semanticDigest}`);
  }, SMALL_TIMEOUT_MS);

  // Two independent builds of the same stream give the same refs, so the object IDs are stable (plan.md P0.1).
  function checkLarge(spec: LargeSpec): void {
    const variants = [false, true].map((commitGraph) => {
      const f = largeFixture(git, spec, commitGraph);
      const before = repositoryDigest(f.repo);
      expect([f.manifest.facts.commits, f.manifest.facts.commitGraph]).toEqual([spec.commits, commitGraph]);
      expect(lines(ownedGit(git, PERF_CACHE_ROOT, f.repo, ["--no-optional-locks", "rev-list", "--count", "--all"]))).toEqual([String(spec.commits)]);
      expect(hasCommitGraph(git, f.repo)).toBe(commitGraph);
      expect(semanticDigest(git, f.repo)).toBe(f.manifest.facts.semanticDigest);
      expect(repositoryDigest(f.repo)).toBe(before);
      console.log(`HISTORY_FIXTURE ${spec.name}${commitGraph ? " commit-graph" : ""}: ${f.reused ? "reused" : "built"} at ${f.folder}; semantic digest ${f.manifest.facts.semanticDigest}`);
      return f;
    });
    expect(refState(git, variants[1]!.repo)).toEqual(refState(git, variants[0]!.repo));
  }

  largeCase(TASK, "H200K has 200,000 commits, the commit-graph state of each variant, and a stable semantic digest", H200K, () => checkLarge(H200K), LARGE_TIMEOUT_MS);
  largeCase(TASK, "H1M has 1,000,000 commits, the commit-graph state of each variant, and a stable semantic digest", H1M, () => checkLarge(H1M), LARGE_TIMEOUT_MS);
});
