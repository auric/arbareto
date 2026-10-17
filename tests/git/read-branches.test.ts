// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T034: `readBranches` (contract Δ3, data-model §1, plan.md D1 and D3). Git's own `for-each-ref` and `worktree list` output is the oracle.

import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { gitPath, withService } from "./hunk-harness";
import { caseTest, type Capability, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { buildWorkbench, canary, repoOf, wb, type WbFixture, type WbFixtureName } from "./workbench-fixtures";

printOrigin("../../src/git-service/branches.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);
useFixtureRoot();

const TASK = "T034";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 120_000;

interface Entry {
  ref: string;
  kind: string;
  name: string;
  oid: string;
  upstream: string | null;
  tracking: { objectId: string; upstreamObjectId: string | null; track: { state: string; ahead?: number; behind?: number } } | null;
  heldBy: string | null;
  current: boolean;
  localName: string | null;
  hasLocal: boolean;
}

let builds = 0;
const build = (name: WbFixtureName): WbFixture => buildWorkbench(gitPath(), name, `t034-branches-${name}-${++builds}`);
const out = (f: WbFixture, args: string[]) => wb(repoOf(f), args).stdout.toString("utf8");
const readBranches = (service: Service, r: RegistrationResult, generation = r.generation): Promise<ServiceResponse<{ entries: Entry[] }>> => service.request("readBranches", {}, { repositoryId: r.repositoryId, repositoryGeneration: generation });
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });

// The branch records that Git lists, without the symbolic refs, in Git's order (git-for-each-ref(1) sorts by refname).
function gitBranches(f: WbFixture): { ref: string; oid: string; upstream: string | null; current: boolean }[] {
  return out(f, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00%(symref)", "refs/heads", "refs/remotes"])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\0"))
    .filter((field) => field[4] === "")
    .map(([ref, oid, upstream, head]) => ({ ref: ref!, oid: oid!, upstream: upstream === "" ? null : upstream!, current: head === "*" }));
}

// git-worktree(1) "Porcelain Format": the path of each record that has `branch <ref>`.
function gitHolders(f: WbFixture): Map<string, string> {
  const holders = new Map<string, string>();
  for (const record of out(f, ["worktree", "list", "--porcelain", "-z"]).split("\0\0")) {
    const lines = record.split("\0");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
    if (path !== undefined && branch !== undefined && !holders.has(branch)) holders.set(branch, path);
  }
  return holders;
}

// `%(upstream:track,nobracket)` of each local branch (feature 003 data-model §1).
function gitTrack(f: WbFixture): Map<string, string> {
  return new Map(
    out(f, ["for-each-ref", "--format=%(refname)%00%(upstream:track,nobracket)", "refs/heads"])
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split("\0") as [string, string]),
  );
}

describe("readBranches (contract Δ3, data-model §1)", () => {
  caseTest(TASK, "every entry equals Git's own listing: the order, the object IDs, the upstream, the current branch, the worktree that holds each branch, and the paired tracking counts", SHELL, () =>
    withService({ name: "t034-branches" }, async (service) => {
      const f = build("branches");
      // An upstream that exists, so its counts pair with this read.
      wb(repoOf(f), ["config", "branch.held.remote", "origin"]);
      wb(repoOf(f), ["config", "branch.held.merge", "refs/heads/held"]);
      const r = await service.register(f.repo);
      const response = await readBranches(service, r);
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      const entries = response.result!.entries;
      const holders = gitHolders(f);
      const track = gitTrack(f);
      expect(entries.map((e) => ({ ref: e.ref, oid: e.oid, upstream: e.upstream, current: e.current }))).toEqual(gitBranches(f));
      expect(entries.map((e) => [e.ref, e.heldBy])).toEqual(entries.map((e) => [e.ref, holders.get(e.ref) ?? null]));
      expect(entries.filter((e) => e.heldBy !== null).map((e) => e.ref).sort()).toEqual(["refs/heads/main", "refs/heads/wt-held"]);
      // Local entries come first, then remote entries (data-model §1).
      expect(entries.map((e) => e.kind)).toEqual([...entries.filter((e) => e.kind === "local"), ...entries.filter((e) => e.kind === "remote")].map((e) => e.kind));
      const local = entries.filter((e) => e.kind === "local");
      expect(local.every((e) => e.tracking !== null && e.tracking.objectId === e.oid)).toBe(true);
      const states = local.map((e) => [e.ref, e.tracking!.track.state]);
      expect(states).toEqual(local.map((e) => [e.ref, track.get(e.ref) === "gone" ? "gone" : e.upstream === null ? "none" : "counts"]));
      const held = local.find((e) => e.ref === "refs/heads/held")!;
      expect(held.tracking).toMatchObject({ upstreamObjectId: out(f, ["rev-parse", "refs/remotes/origin/held"]).trim(), track: { state: "counts", ahead: 0, behind: 0 } });
      // Plan.md D3: the one fetch refspec of `origin` maps the remote ref to `held`, and that local branch exists.
      const remote = entries.find((e) => e.ref === "refs/remotes/origin/held")!;
      expect({ localName: remote.localName, hasLocal: remote.hasLocal, tracking: remote.tracking }).toEqual({ localName: "held", hasLocal: true, tracking: null });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "plan.md D3: one mapping fetch refspec gives the local name, and zero or two mapping refspecs give none", SHELL, () =>
    withService({ name: "t034-local-names" }, async (service) => {
      const f = build("switch-clean");
      const r = await service.register(f.repo);
      const response = await readBranches(service, r);
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      const names = Object.fromEntries(response.result!.entries.filter((e) => e.kind === "remote").map((e) => [e.ref, [e.localName, e.hasLocal]]));
      expect(names).toEqual({ "refs/remotes/one/topic": ["topic", false], "refs/remotes/two/x/topic": [null, false], "refs/remotes/zero/topic": [null, false] });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "contract §7 read gate: an unapproved read program refuses with TRUST_REQUIRED, the worktree list never runs, and the canary stays silent; after approval the read passes", SHELL, () =>
    withService({ name: "t034-branches-gate" }, async (service) => {
      const f = build("switch-clean");
      const run = canary(f.root, "t034-branches-gate");
      wb(repoOf(f), ["config", "filter.canary.clean", run.command]);
      const r = await service.register(f.repo);
      const from = service.runner.calls.length;
      const refused = await readBranches(service, r);
      expect(outcome(refused)).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(service.runner.calls.slice(from).some((c) => c.arguments.includes("worktree"))).toBe(false);
      expect(existsSync(run.log)).toBe(false);
      const trust = await service.readTrust(r.repositoryId);
      expect((await service.approveTrust(r.repositoryId, trust.result!.fingerprint, r.generation)).state).toBe("succeeded");
      expect(outcome(await readBranches(service, r))).toEqual({ state: "succeeded", code: undefined });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "contract §2: a repositoryGeneration other than the current one gives REPOSITORY_CHANGED at acceptance, and no Git process starts", SHELL, () =>
    withService({ name: "t034-branches-generation" }, async (service) => {
      const f = build("switch-clean");
      const r = await service.register(f.repo);
      const from = service.runner.calls.length;
      expect(outcome(await readBranches(service, r, r.generation + 1))).toEqual({ state: "rejected", code: "REPOSITORY_CHANGED" });
      expect(service.runner.calls.length).toBe(from);
    }),
    TIMEOUT_MS,
  );
});
