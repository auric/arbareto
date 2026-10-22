// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 T006: `readBranches` `upstreamPresent` and the gone rule (contract Δ3, data-model §1, plan.md D13, spec FR-064, SC-008).
// Git's own `for-each-ref` output of the same repository is the oracle.

import { describe, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { put, run, type Repo } from "./fixtures";
import { gitPath, withService } from "./hunk-harness";
import { caseTest, type Capability, type Service } from "./service-harness";

printOrigin("../../src/git-service/branches.ts", import.meta.dir);
printOrigin("../../src/git-service/workbench-parsers.ts", import.meta.dir);
useFixtureRoot();

const TASK = "T006";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 120_000;

interface Entry {
  ref: string;
  kind: string;
  upstream: string | null;
  upstreamPresent?: boolean;
  tracking: { track: { state: string } } | null;
}

// The branch cases: a pruned upstream, a removed remote, no upstream, and a present upstream.
function build(name: string): Repo {
  const root = fixtureDir(name);
  const up: Repo = { git: gitPath(), dir: join(root, "up"), pre: [] };
  const r: Repo = { git: gitPath(), dir: join(root, "repo"), pre: [] };
  for (const repo of [up, r]) {
    mkdirSync(repo.dir, { recursive: true });
    run(repo, ["init", "-q", "-b", "main"]);
    for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.filemode", "false"]]) run(repo, ["config", key!, value!]);
  }
  put(up.dir, "a.txt", "a\n");
  run(up, ["add", "--", "a.txt"]);
  run(up, ["commit", "-q", "--no-verify", "-m", "up"]);
  for (const branch of ["old", "keep"]) run(up, ["branch", branch]);
  run(r, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "base"]);
  run(r, ["remote", "add", "origin", up.dir]);
  run(r, ["remote", "add", "other", up.dir]);
  run(r, ["fetch", "-q", "origin"]);
  run(r, ["fetch", "-q", "other"]);
  run(r, ["branch", "--track", "pruned", "origin/old"]);
  run(r, ["branch", "--track", "present", "origin/keep"]);
  run(r, ["branch", "--track", "removed", "other/keep"]);
  run(r, ["branch", "--no-track", "none", "main"]);
  // The pruned upstream: the remote branch goes, and `fetch --prune` drops its remote-tracking ref.
  run(up, ["branch", "-D", "old"]);
  run(r, ["fetch", "-q", "--prune", "origin"]);
  run(r, ["remote", "remove", "other"]);
  return r;
}

// `%(upstream)` and `%(upstream:track,nobracket)` of each local branch, and every listed ref of the same read (git-for-each-ref(1)).
function oracle(r: Repo) {
  const records = run(r, ["for-each-ref", "--format=%(refname)%00%(upstream)%00%(upstream:track,nobracket)", "refs/heads", "refs/remotes"])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\0") as [string, string, string]);
  const listed = new Set(records.map(([ref]) => ref));
  return new Map(records.filter(([ref]) => ref.startsWith("refs/heads/")).map(([ref, upstream, track]) => [ref, { upstream: upstream === "" ? null : upstream, present: upstream !== "" && listed.has(upstream), track }]));
}

const gone = (e: Entry) => e.upstream !== null && !e.upstreamPresent;

describe("readBranches upstreamPresent and the gone rule (contract Δ3, spec FR-064)", () => {
  caseTest(TASK, "upstreamPresent equals Git's listing, the gone rule holds only for the pruned upstream, and it agrees with the 003 track state gone", SHELL, () =>
    withService({ name: "t006-branch-gone" }, async (service: Service) => {
      const r = build("t006-branch-gone");
      const registered = await service.register(r.dir);
      const from = service.runner.calls.length;
      const response = await service.request<{ entries: Entry[] }>("readBranches", {}, { repositoryId: registered.repositoryId, repositoryGeneration: registered.generation });
      expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
      const local = response.result!.entries.filter((e) => e.kind === "local");
      const git = oracle(r);
      expect(local.map((e) => e.ref).sort()).toEqual([...git.keys()].sort());
      for (const e of local) expect({ ref: e.ref, upstream: e.upstream, upstreamPresent: e.upstreamPresent }).toEqual({ ref: e.ref, upstream: git.get(e.ref)!.upstream, upstreamPresent: git.get(e.ref)!.present });
      const byRef = new Map(local.map((e) => [e.ref, e]));
      expect(byRef.get("refs/heads/pruned")).toMatchObject({ upstream: "refs/remotes/origin/old", upstreamPresent: false });
      expect(byRef.get("refs/heads/present")).toMatchObject({ upstream: "refs/remotes/origin/keep", upstreamPresent: true });
      // remote.c `branch_get_upstream`: a removed remote gives no upstream.
      expect(byRef.get("refs/heads/removed")).toMatchObject({ upstream: null, upstreamPresent: false });
      expect(byRef.get("refs/heads/none")).toMatchObject({ upstream: null, upstreamPresent: false });
      expect(local.filter(gone).map((e) => e.ref)).toEqual(["refs/heads/pruned"]);
      // Spec Assumptions: the rule agrees with the 003 track state of the same read and with Git's own `gone`.
      for (const e of local) expect([e.ref, gone(e)]).toEqual([e.ref, e.tracking?.track.state === "gone"]);
      for (const e of local) expect([e.ref, gone(e)]).toEqual([e.ref, git.get(e.ref)!.track === "gone"]);
      // Contract Δ3: no new command. The read runs the 004 branch listing, the 003 tracking listing, and the worktree list.
      const listings = service.runner.calls.slice(from).filter((c) => c.arguments.includes("for-each-ref"));
      expect(listings.length).toBe(2);
      expect(service.runner.calls.slice(from).filter((c) => c.arguments.includes("worktree")).length).toBe(1);
    }),
    TIMEOUT_MS,
  );
});
