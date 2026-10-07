// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeGit } from "./git-binary";
import { fixtureDir, fixtureGit, useFixtureRoot } from "./fixture-root";
import { indexEntries, operationMarkers, rawIndexDigest, refState, sha256, workingFileDigests } from "./git-oracle";

// This file imports no `src/` module, so it prints no ORIGIN line.

// The case runs about 25 Git processes in sequence and asserts no time.
const TIMEOUT_MS = 120_000;

describeGit("git oracle", (git) => {
  useFixtureRoot();

  test("reads index flags, stages, digests, refs, and markers", () => {
    const repo = fixtureDir("oracle-repo");
    const run = (...args: string[]) => fixtureGit(git, repo, args);
    run("init", "--quiet");
    expect(refState(git, repo)).toEqual({ refs: {}, headTarget: "refs/heads/main", headOid: null });
    expect(rawIndexDigest(git, repo)).toBeNull();

    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    writeFileSync(join(repo, "c.txt"), "c\n");
    run("add", "a.txt", "b.txt", "c.txt");
    run("commit", "--quiet", "-m", "base");
    run("update-index", "--assume-unchanged", "a.txt");
    run("update-index", "--skip-worktree", "b.txt");
    writeFileSync(join(repo, "d.txt"), "d\n");
    run("add", "--intent-to-add", "d.txt");

    const byPath = Object.fromEntries(indexEntries(git, repo).map((e) => [e.path, e]));
    const blobA = run("hash-object", "a.txt").trim();
    expect(byPath["a.txt"]).toEqual({ path: "a.txt", stage: 0, mode: "100644", oid: blobA, assumeUnchanged: true, skipWorktree: false, intentToAdd: false });
    expect(byPath["b.txt"]).toMatchObject({ assumeUnchanged: false, skipWorktree: true, intentToAdd: false });
    expect(byPath["c.txt"]).toMatchObject({ assumeUnchanged: false, skipWorktree: false, intentToAdd: false });
    expect(byPath["d.txt"]).toMatchObject({ assumeUnchanged: false, skipWorktree: false, intentToAdd: true });

    expect(rawIndexDigest(git, repo)).toBe(sha256(readFileSync(join(repo, ".git", "index"))));
    expect(workingFileDigests(repo)).toEqual({
      "a.txt": sha256(Buffer.from("a\n")),
      "b.txt": sha256(Buffer.from("b\n")),
      "c.txt": sha256(Buffer.from("c\n")),
      "d.txt": sha256(Buffer.from("d\n")),
    });

    run("update-index", "--no-assume-unchanged", "a.txt");
    run("update-index", "--no-skip-worktree", "b.txt");
    run("rm", "--cached", "--quiet", "d.txt");
    const base = refState(git, repo);
    expect(base.headTarget).toBe("refs/heads/main");
    expect(base.refs["refs/heads/main"]).toBe(base.headOid!);

    run("switch", "--quiet", "-c", "side");
    writeFileSync(join(repo, "c.txt"), "side\n");
    run("commit", "--quiet", "-am", "side");
    run("switch", "--quiet", "main");
    writeFileSync(join(repo, "c.txt"), "main\n");
    run("commit", "--quiet", "-am", "main");
    expect(operationMarkers(git, repo)).toEqual([]);
    expect(() => run("merge", "--quiet", "side")).toThrow();
    expect(operationMarkers(git, repo)).toEqual(["MERGE_HEAD"]);
    const stages = indexEntries(git, repo).filter((e) => e.path === "c.txt").map((e) => e.stage);
    expect(stages).toEqual([1, 2, 3]);

    run("merge", "--abort");
    run("switch", "--quiet", "--detach", "side");
    const detached = refState(git, repo);
    expect(detached.headTarget).toBeNull();
    expect(detached.headOid).toBe(detached.refs["refs/heads/side"]!);
    expect(Object.keys(detached.refs).sort()).toEqual(["refs/heads/main", "refs/heads/side"]);
  }, TIMEOUT_MS);
});
