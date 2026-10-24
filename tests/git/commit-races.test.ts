// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T099: commit races before and after handoff, attribution bounds, and the recovery refresh (contract §4, §8, §9). `commit.ts`, `reconcile.ts`, `attribution.ts`, and `recovery.ts` come with T112 to T114.

import { describe, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceSnapshot } from "../../src/contracts/envelope";
import { APPROVAL_LIFETIME_MS, STATUS_LISTING_RECORDS } from "../../src/contracts/limits";
import { useFixtureRoot } from "./fixture-root";
import { buildChanged, buildF11, buildF20, CapabilitySkip, inflateHeadReflog, type F20Variant, type RefFormat } from "./fixtures";
import { refState } from "./git-oracle";
import {
  applyHunk,
  approve,
  barrier,
  commit,
  commitCalls,
  commitPayload,
  copyRepo,
  git,
  gitPath,
  gitPathOf,
  gitText,
  indexTree,
  isCommitCall,
  one,
  outcome,
  putHook,
  readOk,
  repoOf,
  reviewOk,
  selectHunks,
  subcommand,
  SUCCEEDED,
  TIMEOUT_MS,
  treeOf,
  underTest,
  until,
  valuesOf,
  withService,
} from "./hunk-harness";
import type { Built } from "./fixtures";
import { caseTest, type Capability, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

const TASK = "T099";
const SHELL: Capability[] = ["shell-double"];

useFixtureRoot();

// Contract §8: an outcome after handoff is the observed result or `unknown`, never ordinary success.
const AFTER_HANDOFF = ["completed-with-effects", "failed-with-effects", "failed", "unknown"];
const STATE_UNKNOWN = { state: "rejected", code: "STATE_UNKNOWN" };
// The contract §8 recovery statement of a read. The strict schema fails on a wrong result shape.
const recoveryOf = (read: ServiceResponse) => WorkspaceSnapshot.parse(read.result).recovery;

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
// `--no-verify` still runs `post-commit` (git-commit(1)), so the competing commit gets a hook folder without hooks.
// The F20 evidence of the variant lands inside the attribution window, after the competing commit.
async function competing(service: Service, built: Built, refFormat: RefFormat = "files"): Promise<{ repositoryId: string; response: ServiceResponse }> {
  const repo = repoOf(built);
  const gate = barrier(built.root, "post-commit");
  putHook(repo, "post-commit", gate.body);
  const { repositoryId } = await service.register(repo);
  await approve(service, repositoryId);
  const r = await reviewOk(service, repositoryId);
  const pending = commit(service, repositoryId, r, "request\n");
  await gate.reached();
  git(repo, ["-c", `core.hooksPath=${join(built.root, "no-hooks")}`, "commit", "-q", "--no-verify", "--allow-empty", "-m", "competing"]);
  inflateHeadReflog(repo, built.variant as F20Variant, refFormat);
  gate.release();
  return { repositoryId, response: await pending };
}

// F20 on `refFormat`. Null: this Git cannot make a reftable repository, and the case skips.
function f20(name: string, variant: F20Variant, refFormat: RefFormat): Built | null {
  try {
    return buildF20(gitPath(), name, variant, refFormat);
  } catch (error) {
    if (!(error instanceof CapabilitySkip)) throw error;
    console.log(`SKIP ${name}: missing capability ${error.capability} (unverified)`);
    return null;
  }
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
    caseTest(TASK, `F09: a ${change} change before handoff, with no read between the change and commit, gives STALE_REVIEW, and no commit process starts`, SHELL, () => {
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
    }, TIMEOUT_MS);
  }

  caseTest(TASK, `F09: a readWorkspace between the change and commit gives REPOSITORY_CHANGED at acceptance, and no Git process starts`, SHELL, () =>
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
    TIMEOUT_MS,
  );

  // Contract §9: the code of a review token that is no longer valid.
  caseTest(TASK, `a review token older than 60 seconds on an injected clock gives APPROVAL_EXPIRED at acceptance, and no Git process starts`, SHELL, () => {
    // The approval lifetime runs on the monotonic service clock (T110 decision G5). The case moves that clock.
    let elapsed = 0;
    const approvalClock = () => performance.now() + elapsed;
    return withService({ name: "t099-expired", approvalClock }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t099-expired", "F09"));
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      const from = service.runner.calls.length;
      elapsed = APPROVAL_LIFETIME_MS + 1;
      const response = await commit(service, repositoryId, r, "expired\n");
      expect({ ...outcome(response), runs: service.runner.calls.length - from }).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED", runs: 0 });
    });
  }, TIMEOUT_MS);

  // Contract §8: a `refresh: true` read invalidates the token. An equal observation keeps the generation, so acceptance sees a released ID (§2).
  caseTest(TASK, `a review token that a refresh: true readWorkspace invalidated without a change gives UNKNOWN_TARGET at acceptance, and no Git process starts`, SHELL, () =>
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
    TIMEOUT_MS,
  );

  // Contract §8: a `refresh: false` read with an unchanged fingerprint keeps the token. The later change reaches the commit preflight.
  caseTest(TASK, `a review token that a refresh: false read kept gives STALE_REVIEW after an index change, and no commit process starts`, SHELL, () =>
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
    TIMEOUT_MS,
  );

  // Research R4 step 4: a refusal before handoff leaves the token unconsumed. The later commit of the unchanged review succeeds (T113).
  caseTest("T112", `F09: STALE_REVIEW leaves the review token unconsumed; after the index bytes come back, the same token reaches one commit process in a new operation`, SHELL, () =>
    withService({ name: "t112-consume-after" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t112-consume-after", "F09"));
      const prepared = prepare(repo, "t112-consume-after");
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      const original = readFileSync(gitPathOf(repo, "index"));
      CHANGES.index(repo, prepared);
      const stale = await commit(service, repositoryId, r, "consume\n");
      expect({ ...outcome(stale), commits: commitCalls(service).length }).toEqual({ state: "failed", code: "STALE_REVIEW", commits: 0 });
      writeFileSync(gitPathOf(repo, "index"), original);
      const again = await commit(service, repositoryId, r, "consume\n");
      expect({ other: again.operationId !== stale.operationId, state: again.state, commits: commitCalls(service).length }).toEqual({ other: true, state: "succeeded", commits: 1 });
    }),
    TIMEOUT_MS,
  );

  // Contract §9: a stop decides first at the commit preflight. The held Git process is the first one after the `started` reply.
  caseTest("T112", `a cancel during the preflight gives canceled, starts no commit process, and leaves no index.lock; the same token then reaches one commit process`, SHELL, () => {
    let commitOperation = "";
    return withService({ name: "t112-cancel-preflight", onStarted: (frame) => void (commitOperation = frame.operationId) }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t112-cancel-preflight", "F09"));
      await underTest("commit");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      let reached = () => {};
      const held = new Promise<void>((resolve) => (reached = resolve));
      let first = true;
      const release = service.runner.holdStart((call) => {
        if (!first || call.operationId !== commitOperation) return false;
        first = false;
        reached();
        return true;
      });
      const requestId = crypto.randomUUID();
      try {
        service.send("commit", commitPayload(r, "cancel\n"), { repositoryId, repositoryGeneration: r.read.generation, requestId });
        await held;
        expect((await service.cancel(commitOperation)).state).toBe("succeeded");
      } finally {
        release();
      }
      const canceled = await service.response(requestId);
      expect({ ...outcome(canceled), commits: commitCalls(service).length, lock: existsSync(gitPathOf(repo, "index.lock")) }).toEqual({ state: "canceled", code: "CANCELED", commits: 0, lock: false });
      const again = await commit(service, repositoryId, r, "cancel\n");
      expect({ other: again.operationId !== canceled.operationId, state: again.state, commits: commitCalls(service).length }).toEqual({ other: true, state: "succeeded", commits: 1 });
    });
  }, TIMEOUT_MS);
});

describe("changes after handoff (contract §4, §8)", () => {
  caseTest(TASK, `F11: an approved pre-commit hook that stages another file gives completed-with-effects with the created OID and no retry`, SHELL, () =>
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
    TIMEOUT_MS,
  );

  // The change runs while the approved `pre-commit` hook waits. Git reads the index again after the hook (research.md R4 "post-hook index read").
  const LATE: Record<"index" | "checkout", (repo: string, p: Prepared) => void> = {
    index: CHANGES.index,
    checkout: CHANGES["same-OID branch"],
  };
  for (const change of Object.keys(LATE) as (keyof typeof LATE)[]) {
    caseTest(TASK, `F20: an ${change} change after handoff, through a hook barrier, gives the observed result or unknown, never succeeded`, SHELL, () => {
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
    }, TIMEOUT_MS);
  }

  // T113 adds the reftable variants (research R4 "T113 probes").
  const LIMITS: Record<Exclude<F20Variant, "base">, string> = { "reflog-bytes": "4 MiB", "reflog-records": "10,000 reference and reflog records" };
  for (const [task, refFormat, on, suffix] of [[TASK, "files", "", ""], ["T113", "reftable", " reftable", "-reftable"]] as const) {
    caseTest(task, `F20${on}: a competing commit by another Git process gives unknown, and the service never attributes the current HEAD to the request`, SHELL, () =>
      withService({ name: `t099-competing${suffix}` }, async (service) => {
        const built = f20(`t099-competing${suffix}`, "base", refFormat);
        if (built === null) return;
        await underTest("attribution");
        const { response } = await competing(service, built, refFormat);
        expectUnknown(repoOf(built), response);
      }),
      TIMEOUT_MS,
    );

    for (const [variant, bound] of Object.entries(LIMITS) as [Exclude<F20Variant, "base">, string][]) {
      caseTest(task, `F20${on} ${variant}: attribution evidence above ${bound} gives unknown with reason evidence-limit`, SHELL, () => {
        const name = `t099-${variant}${suffix}`;
        return withService({ name }, async (service) => {
          const built = f20(name, variant, refFormat);
          if (built === null) return;
          await underTest("attribution");
          const { response } = await competing(service, built, refFormat);
          expectUnknown(repoOf(built), response, "evidence-limit");
        });
      }, TIMEOUT_MS);
    }
  }
});

describe("reconciliation reads beside the stop of a limited read (contract §6 `stop`)", () => {
  // The window read stops at the preflight tip, so the native runner sends `stop`, and the shell ends only that process.
  // The first HEAD read after the commit process gets the output of Git's own read as injected bytes. The stdout barrier holds them, so the call runs until the release.
  // The release comes when every other call of the operation after the commit process has an exit.
  caseTest("T391", `T391: F09: a reconciliation HEAD read that runs while the window read stops at the preflight tip gives succeeded with commitOid at HEAD and resolves the marker`, SHELL, () => {
    let commitOperation = "";
    return withService({ name: "t391-window", onStarted: (frame) => void (commitOperation = frame.operationId) }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t391-window", "F09"));
      await underTest("reconcile");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      const own = () => service.runner.calls.filter((c) => c.operationId === commitOperation);
      const isHeadRead = (call: { operationId: string; arguments: readonly string[] }) =>
        call.operationId === commitOperation && own().some(isCommitCall) && call.arguments.includes("rev-parse") && call.arguments.includes("--verify");
      let heldRecord: (typeof service.runner.calls)[number] | undefined;
      service.runner.inject.stdout = (call) => {
        if (heldRecord !== undefined || !isHeadRead(call)) return undefined;
        heldRecord = own().findLast((c) => c.exit === undefined && c.arguments.join("\0") === call.arguments.join("\0"));
        return git(repo, [...call.arguments]);
      };
      let heldCall: object | null = null;
      const release = service.runner.pauseStdout((call) => {
        if (heldCall === null && heldRecord !== undefined && isHeadRead(call)) heldCall = call;
        return call === heldCall;
      });
      const pending = commit(service, repositoryId, r, "window\n");
      try {
        await until(() => heldRecord !== undefined, "the held HEAD read", 60_000);
        const others = () => own().slice(own().findIndex(isCommitCall) + 1).filter((c) => c !== heldRecord);
        await until(() => others().every((c) => c.exit !== undefined || c.refused !== undefined), "the other reconciliation calls end", 60_000);
      } finally {
        release();
      }
      const response = await pending;
      service.runner.inject.stdout = undefined;
      const entry = service.log().find((e) => (e as { operationId?: string }).operationId === commitOperation) as { cause?: string } | undefined;
      expect({ ...outcome(response), commitOid: valuesOf(response.result, "commitOid")[0], cause: entry?.cause, markers: service.runner.markers.size }).toEqual({
        ...SUCCEEDED,
        commitOid: refState(gitPath(), repo).headOid,
        cause: undefined,
        markers: 0,
      });
    });
  }, TIMEOUT_MS);
});

describe("recovery refresh (contract §8)", () => {
  caseTest(TASK, `F20: a status-only readWorkspace leaves mutations blocked; an explicit refresh with complete reconciliation enables them, also with attribution unknown, and states that outcome and its reason`, SHELL, () =>
    withService({ name: "t099-recovery" }, async (service) => {
      const built = buildF20(gitPath(), "t099-recovery", "reflog-bytes");
      await underTest("recovery");
      const { repositoryId, response } = await competing(service, built);
      expectUnknown(repoOf(built), response, "evidence-limit");
      expect((await readOk(service, repositoryId)).recoveryState).toBe("unknown");
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(STATE_UNKNOWN);
      const refresh = await service.readWorkspace(repositoryId, { refresh: true, check: "full" });
      // Contract §8: the refresh runs one attribution attempt from the retained preflight tip. The HEAD log stays above 4 MiB.
      expect({ ...outcome(refresh), recoveryState: refresh.result?.recoveryState, completeness: refresh.result?.completeness.state, recovery: recoveryOf(refresh) }).toEqual({
        ...SUCCEEDED,
        recoveryState: "ready",
        completeness: "complete",
        recovery: { outcome: "unknown", attribution: { result: "unknown", reason: "evidence-limit" } },
      });
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(SUCCEEDED);
    }),
    TIMEOUT_MS,
  );

  // A status listing above STATUS_LISTING_RECORDS gives a `limited` snapshot (contract §5).
  caseTest(TASK, `F20: a recovery refresh with a limited snapshot keeps mutations blocked`, SHELL, () =>
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
      // Contract §8 "Recovery statement": a read without a successful recovery reconciliation carries no `recovery`.
      expect({ state: refresh.state, completeness: refresh.result?.completeness.state, recoveryState: refresh.result?.recoveryState, recovery: recoveryOf(refresh) }).toEqual({ state: "limited", completeness: "limited", recoveryState: "unknown", recovery: undefined });
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(STATE_UNKNOWN);
    }),
    TIMEOUT_MS,
  );
});
