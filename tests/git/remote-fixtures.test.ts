// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T001: the self-check of `tests/git/remote-fixtures.ts` (plan.md P0.1). Values come from `for-each-ref`, `rev-list`, and `tests/git/git-oracle.ts`.

import { expect, test } from "bun:test";
import { describeGit } from "./git-binary";
import { useFixtureRoot } from "./fixture-root";
import { indexEntries, operationMarkers } from "./git-oracle";
import {
  buildAutostash,
  buildCounts,
  buildEmptyRemote,
  buildFetchAll,
  buildFetchFlags,
  buildHooks,
  buildMany,
  buildMergeConflict,
  buildPartialClone,
  buildPull,
  buildPush,
  buildRebaseConflict,
  buildRebaseSkip,
  buildSubmodule,
  configDigests,
  COUNT_BRANCHES,
  credentialHelper,
  FETCH_ALL_REMOTES,
  gitOut,
  gitRun,
  KIND_STAGES,
  leftRight,
  MANY_BRANCHES,
  manyCounts,
  manyName,
  MARKER_TEXT,
  nativeHost,
  PULL_ROWS,
  pullRowCopy,
  PUSH_VARIANTS,
  pushVariant,
  refMap,
  revParse,
  UNRELATED_COMMITS,
  urlWithCredential,
  type ConflictFixture,
  type GitHost,
} from "./remote-fixtures";

useFixtureRoot();

const BUILD_MS = 300_000;

describeGit("remote fixtures (T001)", (git) => {
  let host: GitHost;
  const h = () => (host ??= nativeHost(git));

  test("counts: refs, ahead and behind values, untracked branches", () => {
    const f = buildCounts(h());
    const local = refMap(h(), f.clone, ["refs/heads"]);
    for (const [name, oid] of Object.entries(f.localOids)) expect(local[`refs/heads/${name}`]).toBe(oid);
    const remote = refMap(h(), f.remote, ["refs/heads"]);
    for (const [name, oid] of Object.entries(f.remoteOids)) expect(remote[`refs/heads/${name}`]).toBe(oid);
    const tracking = refMap(h(), f.clone, ["refs/remotes"]);
    for (const [branch, c] of Object.entries(COUNT_BRANCHES)) {
      const upstream = gitOut(h(), f.clone, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`]).trim();
      expect(upstream).toBe(c.upstream);
      expect(tracking[c.upstream]).toBeDefined();
      expect(leftRight(h(), f.clone, `refs/heads/${branch}`, c.upstream)).toEqual([c.ahead, c.behind]);
    }
    expect(gitOut(h(), f.clone, ["rev-list", "--count", "refs/remotes/origin/unrelated"]).trim()).toBe(String(UNRELATED_COMMITS));
    expect(gitRun(h(), f.clone, ["merge-base", "refs/heads/unrelated", "refs/remotes/origin/unrelated"], { allowExit: [1] }).exitCode).toBe(1);
    expect(gitRun(h(), f.clone, ["config", "--get", "branch.no-upstream.remote"], { allowExit: [1] }).exitCode).toBe(1);
    expect(tracking["refs/remotes/origin/gone"]).toBeUndefined();
    expect(gitOut(h(), f.clone, ["config", "--get", "branch.gone.merge"]).trim()).toBe("refs/heads/gone");
    expect(gitOut(h(), f.clone, ["config", "--get", "branch.ghost-remote.remote"]).trim()).toBe("nowhere");
    expect(gitOut(h(), f.clone, ["remote"]).trim().split("\n")).toEqual(["origin", "team/up"]);
    expect(operationMarkers(git, f.clone)).toEqual([]);
  }, BUILD_MS);

  test("200 branches track 200 remote branches", () => {
    const f = buildMany(h());
    const heads = refMap(h(), f.clone, ["refs/heads"]);
    const remotes = refMap(h(), f.clone, ["refs/remotes/origin"]);
    expect(Object.keys(heads).filter((r) => r.startsWith("refs/heads/b")).length).toBe(MANY_BRANCHES);
    for (let i = 0; i < MANY_BRANCHES; i++) {
      const name = manyName(i);
      expect(heads[`refs/heads/${name}`]).toBe(i % 2 === 0 ? f.tip : f.base);
      expect(remotes[`refs/remotes/origin/${name}`]).toBe(f.tip);
    }
    for (const i of [0, 1, 198, 199]) expect(leftRight(h(), f.clone, `refs/heads/${manyName(i)}`, `refs/remotes/origin/${manyName(i)}`)).toEqual(manyCounts(i));
  }, BUILD_MS);

  const checkConflict = (f: ConflictFixture, marker: string) => {
    expect(operationMarkers(git, f.repo)).toEqual([marker]);
    const entries = indexEntries(git, f.repo);
    for (const [path, kind] of Object.entries(f.kinds)) expect(entries.filter((e) => e.path === path).map((e) => e.stage)).toEqual([...KIND_STAGES[kind]]);
    expect(entries.filter((e) => e.path === "link").map((e) => e.mode)).toEqual(["120000", "120000", "120000"]);
    expect(entries.filter((e) => e.path === "exec.sh").map((e) => e.mode).sort()).toEqual(["100644", "100644", "100755"]);
    expect(entries.filter((e) => e.path === f.resolvedPath).map((e) => e.stage)).toEqual([0]);
    expect(h().read(`${f.repo}/${f.resolvedPath}`)?.toString()).toBe(MARKER_TEXT);
    expect(gitOut(h(), f.repo, ["check-attr", "filter", "--", "filtered.txt"]).trim()).toBe("filtered.txt: filter: arbtest");
  };

  test("merge conflict: every unmerged kind, a symbolic link stage, exec bits, a filter path, marker-like text", () => {
    checkConflict(buildMergeConflict(h()), "MERGE_HEAD");
  }, BUILD_MS);

  test("rebase conflict: every unmerged kind with rebase-merge", () => {
    checkConflict(buildRebaseConflict(h()), "rebase-merge");
  }, BUILD_MS);

  test("rebase skip: both rebases stop on their first step", () => {
    const f = buildRebaseSkip(h());
    for (const repo of [f.clean, f.stops]) {
      expect(operationMarkers(git, repo)).toEqual(["rebase-merge"]);
      expect(indexEntries(git, repo).filter((e) => e.path === "a.txt").map((e) => e.stage)).toEqual([1, 2, 3]);
    }
    expect(revParse(h(), f.clean, "up")).toBe(f.upstream);
  }, BUILD_MS);

  test("remote hooks: pre-receive files exist", () => {
    const f = buildHooks(h());
    expect(h().read(`${f.refuse}/hooks/pre-receive`)?.toString()).toBe("#!/bin/sh\nexit 1\n");
    expect(h().read(`${f.esc}/hooks/pre-receive`)?.toString()).toContain("\\033[31m");
  }, BUILD_MS);

  test("push matrix: each variant's configuration and branch", () => {
    const f = buildPush(h());
    PUSH_VARIANTS.forEach((v, i) => {
      const repo = pushVariant(h(), f, v, `${h().root}/push-variant-${i}`);
      // An invalid `push.default` makes `symbolic-ref` die, so the test reads the HEAD file (gitrepository-layout(5)).
      expect(h().read(`${repo}/.git/HEAD`)?.toString()).toBe(`ref: refs/heads/${v.branch}
`);
      const keys = new Map<string, string[]>();
      for (const [k, value] of v.config) keys.set(k, [...(keys.get(k) ?? []), value.replace("{origin}", f.origin).replace("{second}", f.second)]);
      for (const [k, values] of keys) expect(gitOut(h(), repo, ["config", "--get-all", k]).trim().split("\n")).toEqual(values);
    });
    expect(gitOut(h(), f.clone, ["for-each-ref", "--format=%(upstream)", "refs/heads/renamed"]).trim()).toBe("refs/remotes/origin/other-name");
  }, BUILD_MS);

  test("partial clone, gitlink move, submodule, empty remote", () => {
    const p = buildPartialClone(h());
    expect(gitOut(h(), p.clone, ["config", "--get", "remote.origin.promisor"]).trim()).toBe("true");
    expect(gitOut(h(), p.clone, ["config", "--get", "remote.origin.partialclonefilter"]).trim()).toBe("blob:none");
    const s = buildSubmodule(h());
    expect(revParse(h(), s.clone, "HEAD")).toBe(s.c1);
    expect(revParse(h(), s.clone, "refs/remotes/origin/main")).toBe(s.c2);
    expect(gitOut(h(), s.clone, ["ls-tree", "HEAD", "--", "sub"]).trim()).toBe(`160000 commit ${s.s1}\tsub`);
    expect(gitOut(h(), s.clone, ["ls-tree", "refs/remotes/origin/main", "--", "sub"]).trim()).toBe(`160000 commit ${s.s2}\tsub`);
    expect(revParse(h(), `${s.clone}/sub`, "HEAD")).toBe(s.s1);
    expect(gitOut(h(), s.clone, ["config", "--get", "submodule.sub.url"]).trim()).toBe(s.sub);
    const empty = buildEmptyRemote(h());
    expect(refMap(h(), empty)).toEqual({});
  }, BUILD_MS);

  test("credential URL and helper value", () => {
    expect(urlWithCredential("http://127.0.0.1:1/x.git", "u", "p")).toBe("http://u:p@127.0.0.1:1/x.git");
    expect(credentialHelper("u", "p").startsWith("!")).toBe(true);
  });

  test("autostash: diverged with a modified working file", () => {
    const f = buildAutostash(h());
    expect(leftRight(h(), f.clone, "HEAD", "refs/remotes/origin/main")).toEqual([1, 1]);
    expect(gitRun(h(), f.clone, ["diff-files", "--quiet"], { allowExit: [1] }).exitCode).toBe(1);
    for (const key of ["rebase.autoStash", "merge.autoStash"]) expect(gitOut(h(), f.clone, ["config", "--get", key]).trim()).toBe("true");
  }, BUILD_MS);

  test("pull matrix: branches, counts, and each row's configuration", () => {
    const f = buildPull(h());
    expect(leftRight(h(), f.clone, "refs/heads/p-equal", "refs/remotes/origin/p-equal")).toEqual([0, 0]);
    expect(leftRight(h(), f.clone, "refs/heads/p-behind", "refs/remotes/origin/p-behind")).toEqual([0, 1]);
    expect(leftRight(h(), f.clone, "refs/heads/p-diverged", "refs/remotes/origin/p-diverged")).toEqual([1, 1]);
    // The clone has not fetched the rewritten remote branch.
    expect(revParse(h(), f.clone, "refs/remotes/origin/rewrite")).toBe(f.dropped);
    expect(revParse(h(), f.origin, "refs/heads/rewrite")).not.toBe(f.dropped);
    PULL_ROWS.forEach((row, i) => {
      const repo = pullRowCopy(h(), f, row, `${h().root}/pull-row-${i}`);
      expect(gitOut(h(), repo, ["symbolic-ref", "HEAD"]).trim()).toBe(`refs/heads/${row.branch}`);
      for (const [k, v] of row.config) expect(gitOut(h(), repo, ["config", "--get", k]).trim()).toBe(v);
    });
  }, BUILD_MS);

  test("fetch flags and fetch all", () => {
    const f = buildFetchFlags(h());
    expect(refMap(h(), f.clone, ["refs/remotes/origin/gone-soon"])).not.toEqual({});
    expect(refMap(h(), f.origin, ["refs/heads/gone-soon"])).toEqual({});
    expect(refMap(h(), f.origin, ["refs/heads/new"])).not.toEqual({});
    const repo = buildFetchAll(h());
    expect(gitOut(h(), repo, ["remote"]).trim().split("\n")).toEqual(Object.keys(FETCH_ALL_REMOTES));
    expect(gitOut(h(), repo, ["config", "--get-all", "remote.r4.skipDefaultUpdate"]).trim()).toBe("true");
  }, BUILD_MS);

  test("configuration digests: equal when unchanged, different after one write", () => {
    const f = buildPush(nativeHost(git, "digests"));
    const before = configDigests(h(), f.clone);
    expect(before.local.sha256).not.toBeNull();
    expect(configDigests(h(), f.clone)).toEqual(before);
    gitRun(h(), f.clone, ["config", "arbareto.probe", "1"]);
    const after = configDigests(h(), f.clone);
    expect(after.system.sha256).toBe(before.system.sha256);
    expect(after.global.sha256).toBe(before.global.sha256);
    expect(after.local.sha256).not.toBe(before.local.sha256);
  }, BUILD_MS);
});
