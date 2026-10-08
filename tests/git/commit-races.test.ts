// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T099: commit races before and after handoff, attribution bounds, and the recovery refresh (contract §4, §8, §9). `commit.ts`, `reconcile.ts`, `attribution.ts`, and `recovery.ts` come with T112 to T114.

import { describe, expect, setSystemTime } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { APPROVAL_LIFETIME_MS, STATUS_LISTING_RECORDS } from "../../src/contracts/limits";
import { useFixtureRoot } from "./fixture-root";
import { buildChanged, buildF11, buildF20, type F20Variant } from "./fixtures";
import { refState } from "./git-oracle";
import {
  applyHunk,
  approve,
  barrier,
  commit,
  commitCalls,
  copyRepo,
  git,
  gitPath,
  gitPathOf,
  gitText,
  indexTree,
  one,
  outcome,
  putHook,
  readOk,
  repoOf,
  reviewOk,
  selectHunks,
  subcommand,
  SUCCEEDED,
  todoCase,
  treeOf,
  underTest,
  valuesOf,
  withService,
} from "./hunk-harness";
import type { Built } from "./fixtures";
import type { Capability, Service, ServiceResponse, WorkspaceResult } from "./service-harness";

const TASK = "T099";
const BEFORE = "(needs T112/T115)";
const AFTER = "(needs T112/T113/T115)";
const RECOVERY = "(needs T110/T112/T113/T114/T115)";
const SHELL: Capability[] = ["shell-double"];

useFixtureRoot();

// Contract §8: an outcome after handoff is the observed result or `unknown`, never ordinary success.
const AFTER_HANDOFF = ["completed-with-effects", "failed-with-effects", "failed", "unknown"];
const STATE_UNKNOWN = { state: "rejected", code: "STATE_UNKNOWN" };

// F09 changes before handoff. Each one ignores the canonical index lock, as an independent writer can.
type Prepared = { index: Uint8Array; commit: string };
const CHANGES: Record<"index" | "HEAD" | "same-OID branch", (repo: string, p: Prepared) => void> = {
  index: (repo, p) => writeFileSync(gitPathOf(repo, "index"), p.index),
  HEAD: (repo, p) => void git(repo, ["update-ref", "refs/heads/main", p.commit]),
  // F09 `twin` points at the HEAD commit, so only the HEAD target changes.
  "same-OID branch": (repo) => void git(repo, ["symbolic-ref", "HEAD", "refs/heads/twin"]),
};

// The index of a copy with `staged.txt` unstaged, and a new commit on the HEAD tree. Neither touches the fixture.
function prepare(repo: string, name: string): Prepared {
  const copy = copyRepo(repo, `${name}-prepared`);
  git(copy, ["reset", "-q", "--", "staged.txt"]);
  return { index: readFileSync(gitPathOf(copy, "index")), commit: gitText(repo, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "external"]).trim() };
}

// A competing commit by another Git process while the `post-commit` hook of the request waits. The outcome of the request comes back.
async function competing(service: Service, built: Built): Promise<{ repositoryId: string; response: ServiceResponse }> {
  const repo = repoOf(built);
  const gate = barrier(built.root, "post-commit");
  putHook(repo, "post-commit", gate.body);
  const { repositoryId } = await service.register(repo);
  await approve(service, repositoryId);
  const r = await reviewOk(service, repositoryId);
  const pending = commit(service, repositoryId, r, "request\n");
  await gate.reached();
  git(repo, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "competing"]);
  gate.release();
  return { repositoryId, response: await pending };
}

// The `unknown` attribution: the outcome names no current HEAD as its commit.
function expectUnknown(repo: string, response: ServiceResponse, reason?: string): void {
  expect(outcome(response)).toEqual({ state: "unknown", code: "STATE_UNKNOWN" });
  expect(valuesOf(response.result, "commitOid")).not.toContain(refState(gitPath(), repo).headOid);
  if (reason !== undefined) expect(valuesOf(response.result, "reason")).toContain(reason);
}

// A hunk stage of F20 `multi.txt` from a fresh read.
async function stageHunk(service: Service, repositoryId: string): Promise<ServiceResponse> {
  const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
  return applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage");
}

describe("changes before handoff (contract §9 STALE_REVIEW)", () => {
  for (const change of Object.keys(CHANGES) as (keyof typeof CHANGES)[]) {
    todoCase(TASK, `F09: a ${change} change before handoff, with no read between the change and commit, gives STALE_REVIEW, and no commit process starts ${BEFORE}`, SHELL, () => {
      const name = `t099-${change.replaceAll(" ", "-").toLowerCase()}`;
      return withService({ name }, async (service) => {
        const repo = repoOf(buildChanged(gitPath(), name, "F09"));
        const prepared = prepare(repo, name);
        await underTest("commit");
        const { repositoryId } = await service.register(repo);
        const r = await reviewOk(service, repositoryId);
        CHANGES[change](repo, prepared);
        const after = refState(gitPath(), repo);
        expect({ change, ...outcome(await commit(service, repositoryId, r, "stale\n")), commits: commitCalls(service).length }).toEqual({ change, state: "failed", code: "STALE_REVIEW", commits: 0 });
        expect(refState(gitPath(), repo)).toEqual(after);
      });
    });
  }

  todoCase(TASK, `F09: a readWorkspace between the change and commit gives REPOSITORY_CHANGED at acceptance, and no Git process starts ${BEFORE}`, SHELL, () =>
    withService({ name: "t099-generation" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t099-generation", "F09"));
      const prepared = prepare(repo, "t099-generation");
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      CHANGES.index(repo, prepared);
      expect((await readOk(service, repositoryId)).generation).toBeGreaterThan(r.read.generation);
      const from = service.runner.calls.length;
      const response = await commit(service, repositoryId, r, "stale\n");
      expect({ ...outcome(response), runs: service.runner.calls.length - from }).toEqual({ state: "rejected", code: "REPOSITORY_CHANGED", runs: 0 });
    }),
  );

  // Contract §9: the code of a review token that is no longer valid.
  todoCase(TASK, `a review token older than 60 seconds on an injected clock gives APPROVAL_EXPIRED at acceptance, and no Git process starts ${BEFORE}`, SHELL, () =>
    withService({ name: "t099-expired" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t099-expired", "F09"));
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      const from = service.runner.calls.length;
      // Bun `setSystemTime` moves `Date.now()` only. Timers and `performance.now()` keep running.
      setSystemTime(new Date(Date.now() + APPROVAL_LIFETIME_MS + 1));
      let response: ServiceResponse;
      try {
        response = await commit(service, repositoryId, r, "expired\n");
      } finally {
        setSystemTime();
      }
      expect({ ...outcome(response), runs: service.runner.calls.length - from }).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED", runs: 0 });
    }),
  );

  // Contract §8: a `refresh: true` read invalidates the token. An equal observation keeps the generation, so acceptance sees a released ID (§2).
  todoCase(TASK, `a review token that a refresh: true readWorkspace invalidated without a change gives UNKNOWN_TARGET at acceptance, and no Git process starts ${BEFORE}`, SHELL, () =>
    withService({ name: "t099-refreshed" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t099-refreshed", "F09"));
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      const refresh = await service.readWorkspace(repositoryId, { refresh: true, check: "full" });
      expect({ ...outcome(refresh), generation: refresh.result?.generation }).toEqual({ ...SUCCEEDED, generation: r.read.generation });
      const from = service.runner.calls.length;
      const response = await commit(service, repositoryId, r, "refreshed\n");
      expect({ ...outcome(response), runs: service.runner.calls.length - from }).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
    }),
  );

  // Contract §8: a `refresh: false` read with an unchanged fingerprint keeps the token. The later change reaches the commit preflight.
  todoCase(TASK, `a review token that a refresh: false read kept gives STALE_REVIEW after an index change, and no commit process starts ${BEFORE}`, SHELL, () =>
    withService({ name: "t099-kept-stale" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t099-kept-stale", "F09"));
      const prepared = prepare(repo, "t099-kept-stale");
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      const kept = await service.readWorkspace(repositoryId, { refresh: false, check: "full" });
      expect({ ...outcome(kept), generation: kept.result?.generation }).toEqual({ ...SUCCEEDED, generation: r.read.generation });
      CHANGES.index(repo, prepared);
      expect({ ...outcome(await commit(service, repositoryId, r, "stale\n")), commits: commitCalls(service).length }).toEqual({ state: "failed", code: "STALE_REVIEW", commits: 0 });
    }),
  );
});

describe("changes after handoff (contract §4, §8)", () => {
  todoCase(TASK, `F11: an approved pre-commit hook that stages another file gives completed-with-effects with the created OID and no retry ${AFTER}`, SHELL, () =>
    withService({ name: "t099-f11-changing" }, async (service) => {
      const built = buildF11(gitPath(), "t099-f11-changing", "changing");
      const repo = repoOf(built);
      const reviewedTree = indexTree(repo);
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const response = await commit(service, repositoryId, await reviewOk(service, repositoryId), "changing\n");
      expect(outcome(response)).toEqual({ state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" });
      expect(one<string>(response.result, "commitOid")).toBe(refState(gitPath(), repo).headOid!);
      expect(commitCalls(service).length).toBe(1);
      const tree = treeOf(repo, "HEAD");
      expect({ hooked: tree.some((e) => e.path === built.facts.notes.hookAdds), reviewed: JSON.stringify(tree) === JSON.stringify(reviewedTree) }).toEqual({ hooked: true, reviewed: false });
    }),
  );

  // The change runs while the approved `pre-commit` hook waits. Git reads the index again after the hook (research.md R4 "post-hook index read").
  const LATE: Record<"index" | "checkout", (repo: string, p: Prepared) => void> = {
    index: CHANGES.index,
    checkout: CHANGES["same-OID branch"],
  };
  for (const change of Object.keys(LATE) as (keyof typeof LATE)[]) {
    todoCase(TASK, `F20: an ${change} change after handoff, through a hook barrier, gives the observed result or unknown, never succeeded ${AFTER}`, SHELL, () => {
      const name = `t099-late-${change}`;
      return withService({ name }, async (service) => {
        const built = buildF20(gitPath(), name, "base");
        const repo = repoOf(built);
        const prepared = prepare(repo, name);
        const gate = barrier(built.root, "pre-commit");
        putHook(repo, "pre-commit", gate.body);
        await underTest("commit");
        const { repositoryId } = await service.register(repo);
        await approve(service, repositoryId);
        const pending = commit(service, repositoryId, await reviewOk(service, repositoryId), "late\n");
        await gate.reached();
        LATE[change](repo, prepared);
        gate.release();
        const response = await pending;
        expect({ change, state: AFTER_HANDOFF.includes(response.state) }).toEqual({ change, state: true });
        expect(commitCalls(service).length).toBe(1);
      });
    });
  }

  todoCase(TASK, `F20: a competing commit by another Git process gives unknown, and the service never attributes the current HEAD to the request ${AFTER}`, SHELL, () =>
    withService({ name: "t099-competing" }, async (service) => {
      const built = buildF20(gitPath(), "t099-competing", "base");
      await underTest("attribution");
      const { response } = await competing(service, built);
      expectUnknown(repoOf(built), response);
    }),
  );

  const LIMITS: Record<Exclude<F20Variant, "base">, string> = { "reflog-bytes": "4 MiB", "reflog-records": "10,000 reference and reflog records" };
  for (const [variant, bound] of Object.entries(LIMITS) as [Exclude<F20Variant, "base">, string][]) {
    todoCase(TASK, `F20 ${variant}: attribution evidence above ${bound} gives unknown with reason evidence-limit ${AFTER}`, SHELL, () => {
      const name = `t099-${variant}`;
      return withService({ name }, async (service) => {
        const built = buildF20(gitPath(), name, variant);
        await underTest("attribution");
        const { response } = await competing(service, built);
        expectUnknown(repoOf(built), response, "evidence-limit");
      });
    });
  }
});

describe("recovery refresh (contract §8)", () => {
  todoCase(TASK, `F20: a status-only readWorkspace leaves mutations blocked; an explicit refresh with complete reconciliation enables them, also with attribution unknown, and states that outcome and its reason ${RECOVERY}`, SHELL, () =>
    withService({ name: "t099-recovery" }, async (service) => {
      const built = buildF20(gitPath(), "t099-recovery", "reflog-bytes");
      await underTest("recovery");
      const { repositoryId, response } = await competing(service, built);
      expectUnknown(repoOf(built), response, "evidence-limit");
      expect((await readOk(service, repositoryId)).recoveryState).toBe("unknown");
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(STATE_UNKNOWN);
      const refresh = await service.readWorkspace(repositoryId, { refresh: true, check: "full" });
      expect(outcome(refresh)).toEqual(SUCCEEDED);
      expect({ recoveryState: refresh.result!.recoveryState, completeness: refresh.result!.completeness.state }).toEqual({ recoveryState: "ready", completeness: "complete" });
      const recovery = one<{ outcome: string; attribution: { result: string; reason?: string } }>(refresh.result, "recovery");
      expect({ outcome: recovery.outcome, attribution: recovery.attribution.result, reason: recovery.attribution.reason }).toEqual({ outcome: "unknown", attribution: "unknown", reason: "evidence-limit" });
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(SUCCEEDED);
    }),
  );

  // A status listing above STATUS_LISTING_RECORDS gives a `limited` snapshot (contract §5).
  todoCase(TASK, `F20: a recovery refresh with a limited snapshot keeps mutations blocked ${RECOVERY}`, SHELL, () =>
    withService({ name: "t099-limited" }, async (service) => {
      const built = buildF20(gitPath(), "t099-limited", "reflog-bytes");
      const repo = repoOf(built);
      await underTest("recovery");
      const { repositoryId, response } = await competing(service, built);
      expectUnknown(repo, response, "evidence-limit");
      const extra = Buffer.from(Array.from({ length: STATUS_LISTING_RECORDS + 1 }, (_, i) => `? t099-untracked/${i}\0`).join(""));
      service.runner.inject.stdout = (call) => (subcommand(call.arguments) === "status" ? Buffer.concat([git(repo, [...call.arguments]), extra]) : undefined);
      let refresh: ServiceResponse<WorkspaceResult>;
      try {
        refresh = await service.readWorkspace(repositoryId, { refresh: true, check: "full" });
      } finally {
        service.runner.inject.stdout = undefined;
      }
      expect({ state: refresh.state, completeness: refresh.result?.completeness.state, recoveryState: refresh.result?.recoveryState }).toEqual({ state: "limited", completeness: "limited", recoveryState: "unknown" });
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(STATE_UNKNOWN);
    }),
  );
});
