// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T100: cancellation, reconciliation, recovery markers, service restart, deadlines, and lingering Jobs of mutations (contract §5, §6, §8). `recovery.ts` comes with T114.

import { describe, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_ROOT, fixtureDir, useFixtureRoot } from "./fixture-root";
import { buildChanged, buildF07, buildF12, buildF14, buildF20, put, type Built } from "./fixtures";
import { rawIndexDigest, refState } from "./git-oracle";
import {
  afterCommitCall,
  applyHunk,
  approve,
  barrier,
  commit,
  commitCalls,
  commitPayload,
  copyRepo,
  git,
  gitDirOf,
  gitPath,
  gitPathOf,
  gitText,
  indexTree,
  isCommitCall,
  leftoverMarkers,
  markerOf,
  mutationFrames,
  one,
  outcome,
  progressStates,
  putHook,
  readOk,
  repoOf,
  reviewOk,
  scriptedPatch,
  blobOf,
  selectHunks,
  shortDeadline,
  shQuote,
  SUCCEEDED,
  todoCase,
  treeOf,
  underTest,
  until,
  valuesOf,
  withService,
  type Marker,
  type Review,
} from "./hunk-harness";
import { openService, type Capability, type HunkCheckpoint, type Service, type ServiceResponse } from "./service-harness";

const TASK = "T100";
const NEEDS = "(needs T110/T112/T113/T114/T115)";
const HUNK = "(needs T110/T114/T115)";
const SHELL: Capability[] = ["shell-double"];
// Contract §6 "Lingering Jobs" and §8: the child ends within 5 seconds.
const END_MS = 5_000;
// The maintenance and deadline cases wait for Git maintenance and a 20-second deadline.
const LONG_TIMEOUT_MS = 300_000;

useFixtureRoot();

const STATE_UNKNOWN = { state: "rejected", code: "STATE_UNKNOWN" };
const FAILED_DEADLINE = { state: "failed", code: "DEADLINE" };
const DISMISS_REMEDY = "Open this repository and use Refresh.";
const MARKER_REMEDY = "Arbareto could not save its recovery record. Free disk space or restore write access to this folder, then try again.";

type Recovery = { outcome: string; attribution?: { result: string; reason?: string }; indexMatch?: string };

// Sends a commit and returns its request ID and operation ID before the outcome.
async function startCommit(service: Service, repositoryId: string, r: Review, message: string) {
  const requestId = service.send("commit", commitPayload(r, message), { repositoryId, repositoryGeneration: r.read.generation });
  return { requestId, operationId: await service.operationId(requestId) };
}

async function stageHunk(service: Service, repositoryId: string): Promise<ServiceResponse> {
  const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
  return applyHunk(service, repositoryId, c, c.hunkIds[0]!, "stage");
}

// Registers, approves trust, and reviews.
async function approvedReview(service: Service, repo: string) {
  const { repositoryId } = await service.register(repo);
  await approve(service, repositoryId);
  return { repositoryId, r: await reviewOk(service, repositoryId) };
}

const refresh = (service: Service, repositoryId: string) => service.readWorkspace(repositoryId, { refresh: true, check: "full" });
const endedFrame = (service: Service, operationId: string) => service.runner.frames.find((f) => f.type === "ended" && f.operationId === operationId);

// The marker of the repository at `repo`, built from the identity log of a first session.
async function markerFor(name: string, repo: string, kind: Marker["kind"] = "commit"): Promise<Marker> {
  let marker: Marker | null = null;
  await withService({ name: `${name}-first` }, async (service) => {
    const { repositoryId } = await service.register(repo);
    marker = markerOf(service, await readOk(service, repositoryId), kind);
  });
  return marker!;
}

// Every file under the Git directory, relative to it.
const gitFiles = (repo: string) => (readdirSync(gitDirOf(repo), { recursive: true }) as string[]).map(String).sort();

describe("cancellation and reconciliation (contract §8)", () => {
  todoCase(TASK, `F13: cancellation near commit completion reports the created commit as succeeded and never claims rollback ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-cancel-late" }, async (service) => {
      const built = buildChanged(gitPath(), "t100-cancel-late", "F13");
      const repo = repoOf(built);
      const gate = barrier(built.root, "post-commit");
      putHook(repo, "post-commit", gate.body);
      const before = refState(gitPath(), repo);
      const reviewedTree = indexTree(repo);
      await underTest("recovery");
      const { repositoryId, r } = await approvedReview(service, repo);
      const { requestId, operationId } = await startCommit(service, repositoryId, r, "late cancel\n");
      await gate.reached();
      expect((await service.cancel(operationId)).state).not.toBe("rejected");
      gate.release();
      const response = await service.response(requestId);
      expect(outcome(response)).toEqual(SUCCEEDED);
      const after = refState(gitPath(), repo);
      expect({ parent: gitText(repo, ["rev-parse", "HEAD^"]).trim(), tree: treeOf(repo, "HEAD"), commitOid: one<string>(response.result, "commitOid") }).toEqual({ parent: before.headOid!, tree: reviewedTree, commitOid: after.headOid! });
    }),
  );

  todoCase(TASK, `F13: an interrupted commit passes through reconciling and reports its exact effects ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-interrupted" }, async (service) => {
      const built = buildChanged(gitPath(), "t100-interrupted", "F13");
      const repo = repoOf(built);
      const gate = barrier(built.root, "pre-commit");
      putHook(repo, "pre-commit", `echo hooked >> hooked.txt\ngit add -- hooked.txt\n${gate.body}`);
      const head = refState(gitPath(), repo);
      await underTest("recovery");
      const { repositoryId, r } = await approvedReview(service, repo);
      const { requestId, operationId } = await startCommit(service, repositoryId, r, "interrupted\n");
      await gate.reached();
      await service.cancel(operationId);
      const response = await service.response(requestId);
      expect(progressStates(service, requestId)).toContain("reconciling");
      expect(outcome(response)).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
      expect(one<object>(response.result, "effects")).toEqual({ head: false, index: true, workingFiles: true, operationState: false });
      expect(refState(gitPath(), repo)).toEqual(head);
      gate.release();
    }),
  );

  todoCase(TASK, `a reconciliation read past its deadline gives unknown, keeps the marker, sends no resolved, and blocks further mutations in the workspace ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-reconcile-deadline" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t100-reconcile-deadline", "F09"));
      await underTest("recovery");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      shortDeadline(service, afterCommitCall()).arm();
      const response = await commit(service, repositoryId, r, "deadline\n");
      expect(outcome(response)).toEqual({ state: "unknown", code: "STATE_UNKNOWN" });
      await until(() => mutationFrames(service, response.operationId!).includes("ended"), "ended frame");
      expect(mutationFrames(service, response.operationId!)).toEqual(["started", "ended"]);
      expect([...service.runner.markers.values()].map((m) => m.operationId)).toEqual([response.operationId!]);
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(STATE_UNKNOWN);
      expect(outcome(await refresh(service, repositoryId))).toEqual(SUCCEEDED);
      await until(() => mutationFrames(service, response.operationId!).length === 3, "resolved frame");
      expect(mutationFrames(service, response.operationId!)).toEqual(["started", "ended", "resolved"]);
    }),
  );

  todoCase(TASK, `cancel during reconciling while the F14 child runs: reconciliation completes with its observed outcome, lingeringDescendants is 0, ended sets endProcesses, and the child ends within 5 seconds ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-cancel-reconciling" }, async (service) => {
      const repo = repoOf(buildF14(gitPath(), "t100-cancel-reconciling", "lingering"));
      await underTest("recovery");
      const { repositoryId, r } = await approvedReview(service, repo);
      const release = service.runner.holdStart(afterCommitCall());
      const { requestId, operationId } = await startCommit(service, repositoryId, r, "cancel reconciling\n");
      try {
        await until(() => progressStates(service, requestId).includes("reconciling"), "reconciling", 60_000);
        expect((await service.cancel(operationId)).state).not.toBe("rejected");
      } finally {
        release();
      }
      const response = await service.response(requestId);
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(one<number>(response.result, "lingeringDescendants")).toBe(0);
      await until(() => endedFrame(service, operationId) !== undefined, "ended frame");
      expect(endedFrame(service, operationId)!.endProcesses).toBe(true);
      await until(() => service.runner.liveRecorded() === 0, "child end", END_MS);
    }),
  );

  todoCase(TASK, `interrupt and close during reconciling sends no terminal response, the marker stays, and the next handshake makes that workspace unknown ${NEEDS}`, SHELL, async () => {
    const name = "t100-interrupt-close";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    let leftover: Marker[] = [];
    await underTest("recovery");
    // The double models Interrupt and close as `failService` and then a session close. The real shell ends the service process.
    const service = await openService({ git: gitPath(), name });
    try {
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      service.runner.holdStart(afterCommitCall());
      const { requestId } = await startCommit(service, repositoryId, r, "interrupt\n");
      await until(() => progressStates(service, requestId).includes("reconciling"), "reconciling", 60_000);
      expect({ responses: service.responses.filter((s) => s.requestId === requestId), resolved: service.runner.frames.filter((f) => f.type === "resolved") }).toEqual({ responses: [], resolved: [] });
      service.runner.failService();
      leftover = leftoverMarkers(service);
    } finally {
      await service.dispose();
    }
    expect(leftover.length).toBe(1);
    await withService({ name: `${name}-next`, markers: leftover }, async (service) => {
      const { repositoryId } = await service.register(repo);
      expect((await readOk(service, repositoryId)).recoveryState).toBe("unknown");
    });
  });
});

describe("lost responses and tokens (contract §2, data-model §6)", () => {
  todoCase(TASK, `after a lost response, getOperation returns the retained terminal state and never retries ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-lost" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t100-lost", "F09"));
      await underTest("recovery");
      const { repositoryId } = await service.register(repo);
      const { operationId, requestId } = await startCommit(service, repositoryId, await reviewOk(service, repositoryId), "lost\n");
      const first = await service.response(requestId);
      const from = service.runner.calls.length;
      const state = await service.getOperation(operationId);
      expect({ state: (state.result as { state?: string }).state, runs: service.runner.calls.length - from, commits: commitCalls(service).length }).toEqual({ state: first.state, runs: 0, commits: 1 });
    }),
  );

  todoCase(TASK, `after a lost commit response, the same requestId gives INVALID_REQUEST, and a new requestId gets succeeded with the first operationId; neither retry starts a Git process ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-retry" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t100-retry", "F09"));
      await underTest("recovery");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      const { requestId, operationId } = await startCommit(service, repositoryId, r, "retry\n");
      await service.response(requestId);
      const from = service.runner.calls.length;
      service.send("commit", commitPayload(r, "retry\n"), { repositoryId, repositoryGeneration: r.read.generation, requestId });
      await until(() => service.responses.filter((s) => s.requestId === requestId).length === 2, "repeated requestId response");
      expect(outcome(service.responses.filter((s) => s.requestId === requestId)[1]!)).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      const fresh = await commit(service, repositoryId, r, "retry\n");
      expect({ ...outcome(fresh), operationId: fresh.operationId }).toEqual({ ...SUCCEEDED, operationId });
      expect(fresh.result).toEqual((await service.getOperation(operationId)).result);
      expect({ runs: service.runner.calls.length - from, commits: commitCalls(service).length }).toEqual({ runs: 0, commits: 1 });
    }),
  );

  // Data-model §6: "Tokens expire on refresh, relevant state change, service restart, or successful consumption." Contract §9 gives UNKNOWN_TARGET.
  todoCase(TASK, `a new service session invalidates all tokens: a commit with an earlier review token gives UNKNOWN_TARGET and cannot replay ${NEEDS}`, SHELL, async () => {
    const repo = repoOf(buildChanged(gitPath(), "t100-new-session", "F09"));
    await underTest("recovery");
    const service = await openService({ git: gitPath(), name: "t100-new-session" });
    const { repositoryId } = await service.register(repo);
    const r = await reviewOk(service, repositoryId);
    const head = refState(gitPath(), repo);
    const next = await service.restart();
    try {
      const restored = await next.restoreWorkspace(repo);
      const id = (restored.result as { repositoryId: string }).repositoryId;
      expect(outcome(await refresh(next, id))).toEqual(SUCCEEDED);
      const read = await readOk(next, id);
      const from = next.runner.calls.length;
      const response = await next.request("commit", commitPayload(r, "replay\n"), { repositoryId: id, repositoryGeneration: read.generation });
      expect({ ...outcome(response), runs: next.runner.calls.length - from }).toEqual({ state: "rejected", code: "UNKNOWN_TARGET", runs: 0 });
      expect(refState(gitPath(), repo)).toEqual(head);
    } finally {
      await next.dispose();
    }
  });
});

describe("automatic maintenance (contract §4, research.md R4)", () => {
  // Git trace2 events (api-trace2): the root process writes `child_exit` before its own `exit` only when it waited for the child.
  function maintenanceOracle(repo: string, name: string) {
    const copy = copyRepo(repo, name);
    const trace = join(fixtureDir(`${name}-trace`), "trace2.json");
    git(copy, ["commit", "--quiet", "--no-verify", "--file=-"], { input: Buffer.from("maintenance\n"), env: { GIT_TRACE2_EVENT: trace } });
    const events = readFileSync(trace, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    const root = events[0]!.sid as string;
    const at = (match: (e: Record<string, unknown>) => boolean) => events.findIndex(match);
    const start = events.find((e) => e.sid === root && e.event === "child_start" && (e.argv as string[]).includes("--auto") && ["maintenance", "gc"].some((c) => (e.argv as string[]).includes(c)));
    const exitAt = at((e) => e.sid === root && e.event === "exit");
    const childExitAt = start ? at((e) => e.sid === root && e.event === "child_exit" && e.child_id === start.child_id) : -1;
    const descendants = [...new Set(events.map((e) => e.sid as string).filter((sid) => sid.startsWith(`${root}/`)))];
    const outlives = descendants.some((sid) => {
      const end = at((e) => e.sid === sid && e.event === "exit");
      return end < 0 || end > exitAt;
    });
    return { argv: (start?.argv as string[] | undefined) ?? null, waits: childExitAt >= 0 && childExitAt < exitAt, durationMs: childExitAt >= 0 ? Number(events[childExitAt]!.t_rel) * 1000 : null, outlives, files: gitFiles(copy) };
  }

  todoCase(TASK, `F12 gc.auto=1: report whether git commit waits for automatic maintenance, how long it runs, and whether it outlives the commit; the service outcome reports the created commit and counts a lingering maintenance process ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-gc-auto" }, async (service) => {
      const repo = repoOf(buildF12(gitPath(), "t100-gc-auto", "gc-auto"));
      const oracle = maintenanceOracle(repo, "t100-gc-auto-oracle");
      const version = gitText(repo, ["version"]).trim();
      console.log(`OBSERVATION ${TASK}: ${version} git commit with local gc.auto=1 started ${JSON.stringify(oracle.argv)} and ${oracle.waits ? "waited for" : "did not wait for"} it (trace2 child_exit before exit)`);
      console.log(`OBSERVATION ${TASK}: ${version} automatic maintenance ran ${oracle.durationMs} ms (trace2 child_exit t_rel)`);
      console.log(`OBSERVATION ${TASK}: ${version} a maintenance process ${oracle.outlives ? "outlived" : "did not outlive"} the commit process`);
      expect(oracle.argv).not.toBeNull();
      await underTest("recovery");
      const { repositoryId } = await service.register(repo);
      const response = await commit(service, repositoryId, await reviewOk(service, repositoryId), "maintenance\n");
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(one<string>(response.result, "commitOid")).toBe(refState(gitPath(), repo).headOid!);
      // Contract §4: a detached maintenance process stays in the operation Job and counts as lingering.
      const lingering = one<number>(response.result, "lingeringDescendants");
      expect({ outlives: oracle.outlives, counted: lingering > 0 }).toEqual({ outlives: oracle.outlives, counted: oracle.outlives });
    }),
    LONG_TIMEOUT_MS,
  );

  // `git gc --auto` runs the `pre-auto-gc` hook before it collects (githooks(5)), so the hook barrier holds the commit inside maintenance.
  todoCase(TASK, `F12 gc.auto=1: a 20-second injected deadline that fires during maintenance reconciles from observed state and reports the created commit; report the files that the interruption leaves ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-gc-deadline" }, async (service) => {
      const built = buildF12(gitPath(), "t100-gc-deadline", "gc-auto");
      const repo = repoOf(built);
      const gate = barrier(built.root, "pre-auto-gc");
      putHook(repo, "pre-auto-gc", gate.body);
      const files = gitFiles(repo);
      const before = refState(gitPath(), repo);
      const reviewedTree = indexTree(repo);
      await underTest("recovery");
      const { repositoryId, r } = await approvedReview(service, repo);
      shortDeadline(service, isCommitCall, 20_000).arm();
      const { requestId } = await startCommit(service, repositoryId, r, "maintenance deadline\n");
      await gate.reached();
      const response = await service.response(requestId);
      const after = refState(gitPath(), repo);
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect({ commitOid: one<string>(response.result, "commitOid"), parent: gitText(repo, ["rev-parse", "HEAD^"]).trim(), tree: treeOf(repo, "HEAD") }).toEqual({ commitOid: after.headOid!, parent: before.headOid!, tree: reviewedTree });
      const left = gitFiles(repo).filter((f) => !files.includes(f) && !f.startsWith("objects") && !f.startsWith("logs"));
      console.log(`OBSERVATION ${TASK}: a commit deadline during automatic maintenance left these new Git-directory files outside objects and logs: ${JSON.stringify(left)}`);
      gate.release();
    }),
    LONG_TIMEOUT_MS,
  );
});

describe("frames and markers (contract §6 \"Recovery markers\", §8)", () => {
  todoCase(TASK, `the applyHunk mutation frames arrive as started, ended, then resolved, and started precedes the lock creation ${HUNK}`, SHELL, async () => {
    const name = "t100-hunk-frames";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    const lock = gitPathOf(repo, "index.lock");
    const seen: { lock: boolean; runs: number }[] = [];
    let current: Service | null = null;
    const onStarted = (frame: { operationId: string }) => void seen.push({ lock: existsSync(lock), runs: current!.runner.calls.filter((c) => c.operationId === frame.operationId).length });
    await withService({ name, onStarted }, async (service) => {
      current = service;
      await underTest("recovery");
      const { repositoryId } = await service.register(repo);
      const response = await stageHunk(service, repositoryId);
      expect(outcome(response)).toEqual(SUCCEEDED);
      await until(() => mutationFrames(service, response.operationId!).length === 3, "mutation frames");
      expect(mutationFrames(service, response.operationId!)).toEqual(["started", "ended", "resolved"]);
      expect(seen).toEqual([{ lock: false, runs: 0 }]);
    });
  });

  todoCase(TASK, `a leftover marker in the startup handshake makes the matching workspace unknown; its recovery refresh reports no-retained-request, resolves the marker, and enables mutations ${NEEDS}`, SHELL, async () => {
    const name = "t100-leftover";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    const marker = await markerFor(name, repo);
    await underTest("recovery");
    await withService({ name, markers: [marker] }, async (service) => {
      const { repositoryId } = await service.register(repo);
      expect((await readOk(service, repositoryId)).recoveryState).toBe("unknown");
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(STATE_UNKNOWN);
      const refreshed = await refresh(service, repositoryId);
      expect(outcome(refreshed)).toEqual(SUCCEEDED);
      expect(one<Recovery>(refreshed.result, "recovery").attribution).toEqual({ result: "unknown", reason: "no-retained-request" });
      expect(service.runner.frames.filter((f) => f.type === "resolved").map((f) => f.markerId)).toEqual([marker.markerId]);
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(SUCCEEDED);
    });
  });

  todoCase(TASK, `an injected failed marker write gives RECOVERY_MARKER_FAILED with its failure class, folder, and remedy, and no lock or Git process appears ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-marker-failed" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t100-marker-failed", "F09"));
      await underTest("recovery");
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      service.runner.inject.markerFailure = "disk-full";
      const from = service.runner.calls.length;
      const response = (await commit(service, repositoryId, r, "marker\n")) as ServiceResponse<{ failure?: string; path?: string; remedy?: { text?: string } }>;
      expect({ code: response.code, failure: response.result?.failure, path: response.result?.path, text: response.result?.remedy?.text }).toEqual({
        code: "RECOVERY_MARKER_FAILED",
        failure: "disk-full",
        path: join(fixtureDir("t100-marker-failed"), "recovery"),
        text: MARKER_REMEDY,
      });
      expect({ runs: service.runner.calls.length - from, lock: existsSync(gitPathOf(repo, "index.lock")) }).toEqual({ runs: 0, lock: false });
    }),
  );

  // Contract §5 "Recovery markers": above 64 marker files, every mutation stays blocked. The 64 loaded markers name other folders.
  todoCase(TASK, `a handshake that reports the marker limit makes every mutation give STATE_UNKNOWN, also in a fixture without a marker ${NEEDS}`, SHELL, async () => {
    const name = "t100-marker-limit";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    const elsewhere = (i: number) => join(FIXTURE_ROOT, "t100-elsewhere", `m${i}`);
    const markers: Marker[] = Array.from({ length: 64 }, (_, i) => ({
      markerId: crypto.randomUUID(),
      kind: "commit",
      startedAt: new Date().toISOString(),
      worktreeRoot: elsewhere(i),
      commonDirectory: join(elsewhere(i), ".git"),
      commonIdentity: { volumeSerial: "f".repeat(16), fileId: i.toString(16).padStart(32, "0") },
    }));
    await underTest("recovery");
    await withService({ name, markers, unloadedMarkers: 1 }, async (service) => {
      const { repositoryId } = await service.register(repo);
      expect(outcome(await stageHunk(service, repositoryId))).toEqual(STATE_UNKNOWN);
      expect(outcome(await commit(service, repositoryId, await reviewOk(service, repositoryId), "limit\n"))).toEqual(STATE_UNKNOWN);
    });
  });

  todoCase(TASK, `opening another repository while a commit runs gives BUSY, and both linked worktree registrations stay ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-open-busy" }, async (service) => {
      const built = buildF07(gitPath(), "t100-open-busy");
      const other = repoOf(buildChanged(gitPath(), "t100-open-busy-other", "F09"));
      await underTest("recovery");
      const a = await service.register(join(built.root, "wt-a"));
      const b = await service.register(join(built.root, "wt-b"));
      const r = await reviewOk(service, a.repositoryId);
      const release = service.runner.holdStart(isCommitCall);
      const pending = commit(service, a.repositoryId, r, "busy\n");
      try {
        await until(() => commitCalls(service).length === 1, "commit process");
        expect((await service.chooseRepository(other)).code).toBe("BUSY");
      } finally {
        release();
      }
      expect(outcome(await pending)).toEqual(SUCCEEDED);
      await readOk(service, a.repositoryId);
      await readOk(service, b.repositoryId);
    }),
  );

  todoCase(TASK, `an applyHunk left unknown recovers without an attribution step, and its refresh reports published from the retained digests ${HUNK}`, SHELL, async () => {
    const name = "t100-hunk-unknown";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    const oracle = scriptedPatch(repo, `${name}-oracle`, "add", "multi.txt", ["y", "n"]);
    let current: Service | null = null;
    let deadline: { arm(): void } | null = null;
    const hunkCheckpoint = ({ step }: HunkCheckpoint) => {
      if (step === 13) deadline!.arm();
    };
    await underTest("recovery");
    await withService({ name, hunkCheckpoint }, async (service) => {
      current = service;
      deadline = shortDeadline(current);
      const { repositoryId } = await service.register(repo);
      expect(outcome(await stageHunk(service, repositoryId))).toEqual({ state: "unknown", code: "STATE_UNKNOWN" });
      const refreshed = await refresh(service, repositoryId);
      expect(outcome(refreshed)).toEqual(SUCCEEDED);
      expect({ indexMatch: one<Recovery>(refreshed.result, "recovery").indexMatch, attribution: valuesOf(refreshed.result, "attribution") }).toEqual({ indexMatch: "published", attribution: [] });
      expect(blobOf(repo, "multi.txt")).toBe(blobOf(oracle, "multi.txt"));
    });
  });
});

describe("dismissal (contract §6 \"Dismissal\")", () => {
  const dismiss = (service: Service, markerId: string, path?: string) =>
    service.request("dismissRecoveryMarker", path === undefined ? { markerId } : { markerId, bootstrapId: service.runner.addContext("repositoryDiscovery", path) });

  todoCase(TASK, `dismissRecoveryMarker is allowed for a marker whose worktree path Git reports unavailable, and the result states that the outcome stays unknown ${NEEDS}`, [...SHELL, "no-enclosing-repository"], async () => {
    const name = "t100-dismiss-unavailable";
    const plain = fixtureDir(`${name}-plain`);
    put(plain, "file.txt", "plain\n");
    const marker: Marker = { markerId: crypto.randomUUID(), kind: "commit", startedAt: new Date().toISOString(), worktreeRoot: plain, commonDirectory: join(plain, ".git"), commonIdentity: { volumeSerial: "f".repeat(16), fileId: "f".repeat(32) } };
    await underTest("recovery");
    await withService({ name, markers: [marker] }, async (service) => {
      const response = await dismiss(service, marker.markerId, plain);
      expect({ ...outcome(response), outcome: valuesOf(response.result, "outcome") }).toEqual({ ...SUCCEEDED, outcome: ["unknown"] });
    });
  });

  todoCase(TASK, `dismissRecoveryMarker is allowed for a marker whose resolved common-directory identity differs ${NEEDS}`, SHELL, async () => {
    const name = "t100-dismiss-other";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    const real = await markerFor(name, repo);
    const marker: Marker = { ...real, commonIdentity: { volumeSerial: "f".repeat(16), fileId: "f".repeat(32) } };
    expect(marker.commonIdentity).not.toEqual(real.commonIdentity);
    await underTest("recovery");
    await withService({ name, markers: [marker] }, async (service) => {
      const response = await dismiss(service, marker.markerId, repo);
      expect({ ...outcome(response), outcome: valuesOf(response.result, "outcome") }).toEqual({ ...SUCCEEDED, outcome: ["unknown"] });
    });
  });

  todoCase(TASK, `dismissRecoveryMarker for an available matching repository gives STATE_UNKNOWN with the remedy "${DISMISS_REMEDY}" ${NEEDS}`, SHELL, async () => {
    const name = "t100-dismiss-matching";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    const marker = await markerFor(name, repo);
    await underTest("recovery");
    await withService({ name, markers: [marker] }, async (service) => {
      const response = await dismiss(service, marker.markerId, repo);
      expect({ code: response.code, text: (response.result as { remedy?: { text?: string } } | undefined)?.remedy?.text }).toEqual({ code: "STATE_UNKNOWN", text: DISMISS_REMEDY });
    });
  });
});

describe("service restart (contract §8 \"Service restart\")", () => {
  todoCase(TASK, `after a handshake with restarted true and no marker, restoreWorkspace gives an unknown workspace; applyHunk and commit give STATE_UNKNOWN, also after a refresh false read; a refresh true read states that no outcome is pending, and a hunk stage then succeeds ${NEEDS}`, SHELL, async () => {
    const repo = repoOf(buildChanged(gitPath(), "t100-restart", "F09"));
    await underTest("recovery");
    const service = await openService({ git: gitPath(), name: "t100-restart" });
    await service.register(repo);
    const next = await service.restart();
    try {
      const restored = await next.restoreWorkspace(repo);
      expect(restored.state).toBe("succeeded");
      const id = (restored.result as { repositoryId: string }).repositoryId;
      expect((await readOk(next, id)).recoveryState).toBe("unknown");
      expect(outcome(await stageHunk(next, id))).toEqual(STATE_UNKNOWN);
      expect(outcome(await commit(next, id, await reviewOk(next, id), "restart\n"))).toEqual(STATE_UNKNOWN);
      const refreshed = await refresh(next, id);
      expect({ ...outcome(refreshed), recovery: one<Recovery>(refreshed.result, "recovery").outcome, recoveryState: refreshed.result!.recoveryState }).toEqual({ ...SUCCEEDED, recovery: "none", recoveryState: "ready" });
      expect(outcome(await stageHunk(next, id))).toEqual(SUCCEEDED);
    } finally {
      await next.dispose();
    }
  });
});

describe("deadlines (contract §5 \"Deadline outcomes\")", () => {
  todoCase(TASK, `an applyHunk Git step past a short deadline closes the Job, passes through reconciling, and ends failed with DEADLINE; the canonical index bytes stay, and the owned lock is gone ${HUNK}`, SHELL, async () => {
    const name = "t100-hunk-deadline";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    let deadline: { arm(): void } | null = null;
    const hunkCheckpoint = ({ step }: HunkCheckpoint) => {
      if (step === 5) deadline!.arm();
    };
    await underTest("recovery");
    await withService({ name, hunkCheckpoint }, async (service) => {
      deadline = shortDeadline(service);
      const { repositoryId } = await service.register(repo);
      const c = await selectHunks(service, repositoryId, "multi.txt", "unstaged");
      const index = rawIndexDigest(gitPath(), repo);
      const requestId = service.send("applyHunk", { comparisonId: c.comparisonId, hunkId: c.hunkIds[0], snapshotId: c.read.snapshotId, direction: "stage" }, { repositoryId, repositoryGeneration: c.read.generation });
      const response = await service.response(requestId);
      expect({ ...outcome(response), reconciling: progressStates(service, requestId).includes("reconciling") }).toEqual({ ...FAILED_DEADLINE, reconciling: true });
      expect({ index: rawIndexDigest(gitPath(), repo), lock: existsSync(gitPathOf(repo, "index.lock")) }).toEqual({ index, lock: false });
    });
  });

  todoCase(TASK, `a commit preflight read past a short deadline ends failed with DEADLINE through reconciling; no commit process starts, and the review token stays unconsumed ${NEEDS}`, SHELL, async () => {
    const name = "t100-preflight-deadline";
    const repo = repoOf(buildChanged(gitPath(), name, "F09"));
    let deadline: { arm(): void } | null = null;
    await underTest("recovery");
    await withService({ name, onStarted: () => deadline!.arm() }, async (service) => {
      deadline = shortDeadline(service);
      const { repositoryId } = await service.register(repo);
      const r = await reviewOk(service, repositoryId);
      const { requestId, operationId } = await startCommit(service, repositoryId, r, "preflight\n");
      const response = await service.response(requestId);
      expect({ ...outcome(response), reconciling: progressStates(service, requestId).includes("reconciling"), commits: commitCalls(service).length }).toEqual({ ...FAILED_DEADLINE, reconciling: true, commits: 0 });
      expect(existsSync(gitPathOf(repo, "index.lock"))).toBe(false);
      deadline = { arm: () => {} };
      const again = await commit(service, repositoryId, r, "preflight\n");
      expect({ ...outcome(again), replay: again.operationId === operationId }).toEqual({ ...SUCCEEDED, replay: false });
    });
  });

  todoCase(TASK, `a bootstrap probe past a short deadline gives DEADLINE and registers nothing ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-bootstrap-deadline" }, async (service) => {
      const repo = repoOf(buildChanged(gitPath(), "t100-bootstrap-deadline", "F09"));
      await underTest("recovery");
      shortDeadline(service).arm();
      const response = await service.chooseRepository(repo);
      expect({ ...outcome(response), repositoryIds: valuesOf(response.result, "repositoryId") }).toEqual({ ...FAILED_DEADLINE, repositoryIds: [] });
    }),
  );
});

describe("lingering Jobs and revoke (contract §6 \"Lingering Jobs\")", () => {
  // The F14 hook child of `lingering` with a barrier before the hook exits, in a repository whose reflog holds more than 4 MiB (F20 `reflog-bytes`).
  function lingeringBigReflog(name: string): { built: Built; repo: string; gate: ReturnType<typeof barrier> } {
    const f14 = buildF14(gitPath(), name, "lingering");
    const built = buildF20(gitPath(), `${name}-f20`, "reflog-bytes");
    const repo = repoOf(built);
    const gate = barrier(built.root, "post-commit");
    putHook(repo, "post-commit", readFileSync(gitPathOf(repoOf(f14), "hooks/post-commit"), "utf8").replace("#!/bin/sh\n", "").replace("exit 0\n", `${gate.body}exit 0\n`));
    return { built, repo, gate };
  }

  todoCase(TASK, `a commit that leaves the F14 child running ends unknown through attribution evidence above 4 MiB, and its recovery refresh succeeds while the child still runs ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-linger-unknown" }, async (service) => {
      const { repo, gate } = lingeringBigReflog("t100-linger-unknown");
      await underTest("recovery");
      const { repositoryId, r } = await approvedReview(service, repo);
      const pending = commit(service, repositoryId, r, "linger unknown\n");
      await gate.reached();
      git(repo, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "competing"]);
      gate.release();
      const response = await pending;
      expect(outcome(response)).toEqual({ state: "unknown", code: "STATE_UNKNOWN" });
      expect(service.runner.liveRecorded()).toBe(1);
      const refreshed = await refresh(service, repositoryId);
      expect({ ...outcome(refreshed), recoveryState: refreshed.result!.recoveryState, live: service.runner.liveRecorded() }).toEqual({ ...SUCCEEDED, recoveryState: "ready", live: 1 });
    }),
  );

  todoCase(TASK, `after an F14 commit, revokeTrust ends the lingering child within 5 seconds and returns count 1 ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-revoke-after" }, async (service) => {
      const repo = repoOf(buildF14(gitPath(), "t100-revoke-after", "lingering"));
      await underTest("recovery");
      const { repositoryId, r } = await approvedReview(service, repo);
      expect(outcome(await commit(service, repositoryId, r, "revoke after\n"))).toEqual(SUCCEEDED);
      expect(service.runner.liveRecorded()).toBe(1);
      const trustId = (await service.readTrust(repositoryId)).result!.trustId!;
      const revoked = await service.revokeTrust(repositoryId, trustId);
      expect({ ...outcome(revoked), ended: revoked.result?.endedProcesses }).toEqual({ ...SUCCEEDED, ended: 1 });
      await until(() => service.runner.liveRecorded() === 0, "child end", END_MS);
    }),
  );

  todoCase(TASK, `a revoke during a running commit cancels nothing, ended sets endProcesses, and the child ends ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-revoke-during" }, async (service) => {
      const built = buildF14(gitPath(), "t100-revoke-during", "lingering");
      const repo = repoOf(built);
      const gate = barrier(built.root, "pre-commit");
      putHook(repo, "pre-commit", gate.body);
      await underTest("recovery");
      const { repositoryId, r } = await approvedReview(service, repo);
      const trustId = (await service.readTrust(repositoryId)).result!.trustId!;
      const { requestId, operationId } = await startCommit(service, repositoryId, r, "revoke during\n");
      await gate.reached();
      expect((await service.revokeTrust(repositoryId, trustId)).state).toBe("succeeded");
      gate.release();
      const response = await service.response(requestId);
      expect({ ...outcome(response), lingering: one<number>(response.result, "lingeringDescendants") }).toEqual({ ...SUCCEEDED, lingering: 0 });
      await until(() => endedFrame(service, operationId) !== undefined, "ended frame");
      expect(endedFrame(service, operationId)!.endProcesses).toBe(true);
      await until(() => service.runner.liveRecorded() === 0, "child end", END_MS);
    }),
  );

  todoCase(TASK, `a lingering child from an earlier service session also ends at revoke ${NEEDS}`, [...SHELL, "restart-keeps-lingering"], async () => {
    const name = "t100-revoke-restart";
    const repo = repoOf(buildF14(gitPath(), name, "lingering"));
    await underTest("recovery");
    const service = await openService({ git: gitPath(), name });
    const { repositoryId, r } = await approvedReview(service, repo);
    expect(outcome(await commit(service, repositoryId, r, "earlier session\n"))).toEqual(SUCCEEDED);
    const next = await service.restart();
    try {
      const id = ((await next.restoreWorkspace(repo)).result as { repositoryId: string }).repositoryId;
      const trustId = (await next.readTrust(id)).result!.trustId!;
      expect((await next.revokeTrust(id, trustId)).result?.endedProcesses).toBe(1);
      await until(() => next.runner.liveRecorded() === 0, "child end", END_MS);
    } finally {
      await next.dispose();
    }
  });

  todoCase(TASK, `F14 ref lock: the next commit gives GIT_FAILED with the observed lock path, and the lock stays; after the child removes its lock and exits, a refresh and a new commit succeed ${NEEDS}`, SHELL, () =>
    withService({ name: "t100-ref-lock" }, async (service) => {
      const built = buildChanged(gitPath(), "t100-ref-lock", "F09");
      const repo = repoOf(built);
      const lock = gitPathOf(repo, "refs/heads/main.lock");
      const gate = barrier(built.root, "ref-lock");
      putHook(repo, "post-commit", `( : > ${shQuote(lock)}\n${gate.body}rm -f ${shQuote(lock)}\n) </dev/null >/dev/null 2>&1 &\nexit 0\n`);
      await underTest("recovery");
      const { repositoryId, r } = await approvedReview(service, repo);
      expect(outcome(await commit(service, repositoryId, r, "first\n"))).toEqual(SUCCEEDED);
      await gate.reached();
      put(repo, "staged.txt", "staged second\n");
      git(repo, ["add", "--", "staged.txt"]);
      const head = refState(gitPath(), repo).headOid;
      const failed = await commit(service, repositoryId, await reviewOk(service, repositoryId), "second\n");
      expect({ ...outcome(failed), head: refState(gitPath(), repo).headOid, lock: existsSync(lock) }).toEqual({ state: "failed", code: "GIT_FAILED", head, lock: true });
      expect(valuesOf(failed.result, "foreign").flat()).toContain(lock);
      gate.release();
      await until(() => !existsSync(lock), "lock removal");
      expect(outcome(await refresh(service, repositoryId))).toEqual(SUCCEEDED);
      expect(outcome(await commit(service, repositoryId, await reviewOk(service, repositoryId), "third\n"))).toEqual(SUCCEEDED);
    }),
  );
});
