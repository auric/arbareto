// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import * as sync from "../../src/git-service/sync-commands";

printOrigin("../../src/git-service/sync-commands.ts", import.meta.dir);

// Contract Δ3 and plan.md D3 to D7: the argv vectors of `sync-commands.ts` (T014).

const L = "--no-lazy-fetch";
const R = [L, "--no-optional-locks"];
const HEAD = "1".repeat(40);
const T = "2".repeat(40);
const U = "3".repeat(64);

const READS: [string, string[], string[]][] = [
  [
    "readTracking for-each-ref",
    sync.trackingArgs(),
    [...R, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)", "refs/heads", "refs/remotes"],
  ],
  [
    "D4 review record",
    sync.pushRecordArgs("feature/x"),
    [
      ...R,
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push)%00%(push:remotename)%00%(push:remoteref)",
      "refs/heads/feature/x",
    ],
  ],
  ["remote", sync.remoteListArgs(), [...R, "remote"]],
  ["remote get-url --push --all", sync.pushUrlArgs("origin"), [...R, "remote", "get-url", "--push", "--all", "--", "origin"]],
  ["lease count", sync.leaseCountArgs(T, HEAD, "sha1"), [...R, "rev-list", "--count", T, `^${HEAD}`]],
  ["lease subjects", sync.leaseCommitsArgs(T, HEAD, "sha1"), [...R, "rev-list", "--max-count=100", T, `^${HEAD}`]],
  ["sync refs listing", sync.syncRefsArgs(), [...R, "for-each-ref", "--format=%(refname)%00%(objectname)"]],
  ["ahead and behind count", sync.aheadBehindArgs("4".repeat(64), U, "sha256"), [...R, "rev-list", "--left-right", "--count", `${"4".repeat(64)}...${U}`]],
];

const WRITES: [string, string[], string[]][] = [
  ["fetch", sync.fetchArgs("origin"), [L, "fetch", "--porcelain", "--progress", "--no-recurse-submodules", "--", "origin"]],
  [
    "push",
    sync.pushArgs("origin", "main", "refs/heads/main", { setUpstream: false, lease: null }, "sha1"),
    [L, "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", "--", "origin", "refs/heads/main:refs/heads/main"],
  ],
  [
    "push with --set-upstream",
    sync.pushArgs("up/stream", "a/b", "refs/heads/a/b", { setUpstream: true, lease: null }, "sha1"),
    [L, "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", "--set-upstream", "--", "up/stream", "refs/heads/a/b:refs/heads/a/b"],
  ],
  [
    "triangular push",
    sync.pushArgs("fork", "topic", "refs/heads/topic", { setUpstream: false, lease: null }, "sha1"),
    [L, "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", "--", "fork", "refs/heads/topic:refs/heads/topic"],
  ],
  [
    "force push with lease",
    sync.pushArgs("origin", "main", "refs/heads/trunk", { setUpstream: false, lease: T }, "sha1"),
    [L, "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", `--force-with-lease=refs/heads/trunk:${T}`, "--", "origin", "refs/heads/main:refs/heads/trunk"],
  ],
  ["fast-forward", sync.fastForwardArgs("refs/remotes/origin/main"), [L, "merge", "--ff-only", "--no-autostash", "refs/remotes/origin/main"]],
  ["merge --ff", sync.mergeArgs("refs/remotes/origin/main", "--ff"), [L, "merge", "--no-edit", "--no-autostash", "--ff", "refs/remotes/origin/main"]],
  ["merge --no-ff", sync.mergeArgs("refs/remotes/origin/main", "--no-ff"), [L, "merge", "--no-edit", "--no-autostash", "--no-ff", "refs/remotes/origin/main"]],
  ["merge without ff option", sync.mergeArgs("refs/remotes/origin/main", null), [L, "merge", "--no-edit", "--no-autostash", "refs/remotes/origin/main"]],
  ["rebase", sync.rebaseArgs("refs/remotes/origin/main", false), [L, "rebase", "--no-autostash", "--fork-point", "refs/remotes/origin/main"]],
  ["rebase --rebase-merges", sync.rebaseArgs("refs/remotes/origin/main", true), [L, "rebase", "--no-autostash", "--fork-point", "--rebase-merges", "refs/remotes/origin/main"]],
  ["abort a merge", sync.abortArgs("merging"), [L, "merge", "--abort"]],
  ["abort a rebase", sync.abortArgs("rebasing"), [L, "rebase", "--abort"]],
  ["continue a merge", sync.continueArgs("merging"), [L, "commit", "--quiet"]],
  ["continue a rebase", sync.continueArgs("rebasing"), [L, "rebase", "--continue"]],
  ["skip", sync.skipArgs(), [L, "rebase", "--skip"]],
  ["clone", sync.cloneArgs("https://example.test/team/tool.git", "D:\\src\\tool"), [L, "clone", "--progress", "--no-recurse-submodules", "--", "https://example.test/team/tool.git", "D:\\src\\tool"]],
];

describe("sync argv vectors", () => {
  for (const [name, actual, expected] of [...READS, ...WRITES]) test(name, () => expect(actual).toEqual(expected));

  test("every array starts with --no-lazy-fetch", () => {
    for (const [, args] of [...READS, ...WRITES]) expect(args[0]).toBe(L);
  });

  test("every read array has --no-optional-locks before the command", () => {
    for (const [, args] of READS) expect(args.slice(0, 2)).toEqual(R);
  });

  test("no array carries a prune, tag, autostash, or plain force option", () => {
    const refused = /^(?:--prune.*|-p|--tags|-t|--no-tags|--autostash|--force|-f|\+.*)$/;
    for (const [, args] of [...READS, ...WRITES]) for (const item of args) expect(refused.test(item)).toBe(false);
  });

  // Contract Δ3 `reviewSync` and plan.md D4: the review contacts no remote.
  test("no review array contacts a remote", () => {
    const network = ["fetch", "push", "pull", "clone", "ls-remote", "--dry-run", "remote-https", "upload-pack", "receive-pack"];
    for (const [, args] of READS) for (const item of args) expect(network).not.toContain(item);
  });

  test("fetch, push, and clone carry --no-recurse-submodules", () => {
    for (const [name, args] of WRITES) if (/^(?:fetch|push|force|clone)/.test(name)) expect(args).toContain("--no-recurse-submodules");
  });
});

describe("names that start with '-' stay after --", () => {
  test("remote names", () => {
    expect(sync.fetchArgs("-x").slice(-2)).toEqual(["--", "-x"]);
    expect(sync.pushUrlArgs("--upload-pack=y").slice(-2)).toEqual(["--", "--upload-pack=y"]);
    expect(sync.pushArgs("-x", "main", "refs/heads/main", { setUpstream: false, lease: null }, "sha1").slice(-3)).toEqual(["--", "-x", "refs/heads/main:refs/heads/main"]);
  });

  test("clone URL and destination", () => {
    expect(sync.cloneArgs("-u", "-d").slice(-3)).toEqual(["--", "-u", "-d"]);
  });
});

describe("refused inputs", () => {
  const throws = (f: () => unknown) => expect(f).toThrow(TypeError);

  test("an empty or NUL item", () => {
    throws(() => sync.fetchArgs(""));
    throws(() => sync.fetchArgs("a\0b"));
    throws(() => sync.pushUrlArgs(""));
    throws(() => sync.cloneArgs("", "D:\\x"));
    throws(() => sync.cloneArgs("u", ""));
    throws(() => sync.cloneArgs("u\0", "D:\\x"));
  });

  test("a branch or ref that fails isRefName", () => {
    throws(() => sync.pushRecordArgs("bad..name"));
    throws(() => sync.pushRecordArgs("x*"));
    throws(() => sync.pushArgs("origin", "a b", "refs/heads/main", { setUpstream: false, lease: null }, "sha1"));
    throws(() => sync.pushArgs("origin", "main", "main", { setUpstream: false, lease: null }, "sha1"));
    throws(() => sync.fastForwardArgs("origin/main"));
    throws(() => sync.mergeArgs("refs/remotes/origin/main~1", "--ff"));
    throws(() => sync.rebaseArgs("-x", false));
  });

  test("an object ID of another format", () => {
    throws(() => sync.leaseCountArgs(T, HEAD, "sha256"));
    throws(() => sync.leaseCommitsArgs("HEAD", HEAD, "sha1"));
    throws(() => sync.aheadBehindArgs(HEAD, U, "sha1"));
    throws(() => sync.pushArgs("origin", "main", "refs/heads/main", { setUpstream: false, lease: "x" }, "sha1"));
  });

  test("an unknown operation kind or ff option", () => {
    throws(() => sync.abortArgs("am" as "merging"));
    throws(() => sync.continueArgs("" as "merging"));
    throws(() => sync.mergeArgs("refs/remotes/origin/main", "--ff-only" as "--ff"));
  });
});
