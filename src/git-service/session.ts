// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Handshake } from "../contracts/channel";
import { validateRequest, type Response, type ServiceRequest } from "../contracts/envelope";
import { codeFitsState, type ErrorCode } from "../contracts/errors";
import { GIT_PROCESS_DEADLINE_MS, HISTORY_VIEW_COMMITS, PENDING_READS_GLOBAL, PUBLIC_FRAME_BODY_BYTES, RECORDED_REQUEST_IDS } from "../contracts/limits";
import { isIdentifier } from "../contracts/operations";
import { decodeStrictJson, hasFractionOrExponent, isObject } from "../contracts/strict-json";
import { isWindows } from "../contracts/native-path";
import { wslIdentityPath } from "../contracts/wsl-route";
import { RunnerRefusal, type GitRunner, type SyncRunner, type WslRunner } from "./git-runner";
import { createApprovals } from "./approvals";
import { createCloner, type RouteTarget } from "./clone";
import { createCommitter } from "./commit";
import { createCommitReviewer } from "./commit-review";
import { createComparisonReader } from "./comparison";
import { getEnvironment } from "./environment";
import { createExclusion } from "./exclusion";
import { createFilePublisher, fileApproval } from "./file-publish";
import { failure, probeGit, revalidateSavedGit, type GitProbeResult } from "./git-installation";
import type { ProbeRun } from "./history-search";
import { createHistoryViews } from "./history-view";
import { createHunkPublisher, hunkApprovals, type HunkPublisherOptions } from "./hunk-publish";
import { createSessionLog, type DiagnosticCause } from "./log";
import { createOperationRegistry } from "./operations";
import { createReadScheduler, type ReadEnd, type RereadTarget } from "./read-scheduler";
import { createRefsReader, type RefsOutcome } from "./refs";
import { createRecovery } from "./recovery";
import { createRegistrations, dismissMarker, dismissWslMarker, type DismissalOutcome, type RegistrationOutcome, type Workspace } from "./registration";
import type { ReadInstallation } from "./snapshot";
import { createSubmoduleReviewer } from "./submodule-review";
import { createSubmoduleUpdater, type SubmoduleUpdaterOptions } from "./submodule-update";
import { createWorkspaceReader, type ReadOutcome, type WorkspaceReaderOptions } from "./status";
import { createSyncer } from "./sync";
import { createSyncReviewer } from "./sync-review";
import { createTrackingReader } from "./tracking";
import { FrameBoundError, isFrameKind, type Frame, type FrameWriter, type Incoming } from "./transport";
import { createTrust, type ServiceEnvironment, type TrustOutcome } from "./trust";
import { watchWorkspace } from "./watch";
import { approveWslGit, probeWslGit, routeRegistration, type WslGit } from "./wsl";

export type { Handshake } from "../contracts/channel";

type Fields = Record<string, unknown>;

// The `reviewSync` actions of batch 2 (feature 003 tasks.md T040 to T042).
const REVIEWED_ACTIONS: readonly string[] = ["fetch", "fetch-all", "push", "force-push"];

// Contract §3 without the shell-only operations. The shell forwards `openRecentRepository` as `restoreWorkspace`.
type ServiceOperation = ServiceRequest["operation"];
type Handler<K extends ServiceOperation> = (request: Extract<ServiceRequest, { operation: K }>) => void;

export interface SessionOptions {
  writer: FrameWriter;
  runner: GitRunner & WslRunner & SyncRunner & { receive(frame: Frame): boolean };
  // Called after a failed handshake reply. The service then exits.
  fail(): void;
  // Contract §5 "Other Git process deadline" bounds the startup revalidation. Tests set a shorter value.
  startupDeadlineMs?: number;
  // The service environment. The trust listing reads the child `PATH` and `HOME` values from it (contract §7). Git applies `GIT_CONFIG_*` to the `git var` lines itself. Tests pass the owned environment.
  environment?: ServiceEnvironment;
  // Contract §5 "Ordinary read deadline". Tests set a shorter value.
  readDeadlineMs?: number;
  // `false` starts no watcher, so only the contract §8 stat tuple starts a full read. Tests use it.
  watchHints?: boolean;
  // Test seam only. Production never sets it.
  readRawIndex?: WorkspaceReaderOptions["readRawIndex"];
  // Test seam only. Production never sets it. The service awaits it after research R3 steps 5, 11, and 13 of a hunk publication.
  // A file publication uses the same numbers: 5 after the Git step, 11 after the final recheck, and 13 after publication.
  hunkCheckpoint?: HunkPublisherOptions["hunkCheckpoint"];
  // Test seam only. Production uses the monotonic `performance.now()` for the contract §5 approval lifetime.
  approvalClock?: () => number;
  // Test seam only. Production never sets it. The service awaits it before each folder check and clone check of an update row,
  // and before the program re-check of a nested active-set read.
  submoduleCheckpoint?: SubmoduleUpdaterOptions["submoduleCheckpoint"];
  // Feature 002 contract Δ5 `HISTORY_VIEW_COMMITS`. Tests set a lower value.
  historyViewCommits?: number;
  // Feature 002 contract Δ3 "Matching probe": the probe commits that each run must list. Only tests set other sets.
  historyProbeRuns?: readonly ProbeRun[];
}

// The outcome forms of the reads that `read-scheduler.ts` runs. `cause` goes only into the session log entry (contract §8).
type ReadResult =
  | { result: "succeeded" | "limited" | "failed"; code?: ErrorCode; value?: unknown; cause?: DiagnosticCause }
  | { result: "canceled" }
  | { result: "deadline" };

export function createSession({ writer, runner, fail, startupDeadlineMs = GIT_PROCESS_DEADLINE_MS, environment = process.env, readDeadlineMs, watchHints = true, readRawIndex, hunkCheckpoint, approvalClock, submoduleCheckpoint, historyViewCommits = HISTORY_VIEW_COMMITS, historyProbeRuns }: SessionOptions) {
  let sessionId: string | null = null;
  let handshake: Handshake | null = null;
  const seenRequests = new Set<string>();
  const log = createSessionLog();
  // Null until the startup revalidation or a `chooseGit` gives a result.
  let git: GitProbeResult | null = null;
  // Contract §6 "Startup contexts": public requests wait for the revalidation of `savedGit`. Contract §5 "Pending reads" caps the queue.
  let startup: (() => void)[] | null = null;

  // Contract §2: the envelope fields that the response of a validated request repeats, by `requestId`.
  const echoes = new Map<string, { operation: string; repositoryGeneration?: number; selectionId?: string }>();
  // Returns the response that the writer sent.
  const respond = (response: Response): Response => {
    if (response.state === "rejected" && !codeFitsState("rejected", response.code)) throw new Error("rejected response needs an error code");
    const echo = response.requestId === null ? undefined : echoes.get(response.requestId);
    const send = (sent: Response) => {
      // Contract §2: a `readWorkspace` response with a result carries the generation of that result.
      const generation = echo?.operation === "readWorkspace" && isObject(sent.result) && typeof sent.result.generation === "number" ? sent.result.generation : echo?.repositoryGeneration;
      writer.write({
        kind: "public",
        response: { ...sent, ...(generation === undefined ? {} : { repositoryGeneration: generation }), ...(echo?.selectionId === undefined ? {} : { selectionId: echo.selectionId }) },
      });
      return sent;
    };
    try {
      return send(response);
    } catch (error) {
      if (!(error instanceof FrameBoundError)) throw error;
      // Contract §2: a response that cannot be encoded within the frame bound becomes a terminal `failed` response with OUTPUT_LIMIT.
      return send({ requestId: response.requestId, ...(response.operationId === undefined ? {} : { operationId: response.operationId }), state: "failed", code: "OUTPUT_LIMIT" });
    } finally {
      if (echo !== undefined) echoes.delete(response.requestId!);
    }
  };
  const reject = (requestId: string | null, code: ErrorCode) => void respond({ requestId, state: "rejected", code });
  const requestIdOf = (envelope: unknown) => (isObject(envelope) && isIdentifier(envelope.requestId) ? envelope.requestId : null);
  // Contract §1: the shell forwards a body that its own JSON parse accepts. So a plain parse finds the `requestId` of a refused body.
  const plainRequestId = (body: Uint8Array) => {
    try {
      return requestIdOf((JSON.parse(new TextDecoder().decode(body)) as Fields | null)?.request);
    } catch {
      return null;
    }
  };
  // Contract §2: the service records each valid requestId, also of a rejected request. A repeated one gives INVALID_REQUEST.
  // Contract §5 "Recorded request IDs": a Set iterates in insertion order, so the first value is the oldest.
  const claim = (requestId: string | null) => {
    if (requestId === null) return true;
    if (seenRequests.has(requestId)) return false;
    seenRequests.add(requestId);
    if (seenRequests.size > RECORDED_REQUEST_IDS) seenRequests.delete(seenRequests.values().next().value as string);
    return true;
  };
  const registry = createOperationRegistry(respond, (progress) => writer.write({ kind: "public", progress }), log, runner);
  const scheduler = createReadScheduler({ closeJob: (operationId) => runner.closeJob(operationId), cancel: (operationId) => void registry.cancel(operationId), readDeadlineMs });
  const trust = createTrust({
    runner,
    environment,
    configFiles: (gitInstallationId) => (git?.ok && git.installation.gitInstallationId === gitInstallationId ? git.installation.configFiles : undefined),
  });
  const reader = createWorkspaceReader({
    runner,
    trust,
    readRawIndex,
    unknown: (w) => recovery.unknown(w),
    reconciling: (w) => exclusion.running(w.commonIdentity).some((operationId) => registry.get(operationId)?.state === "reconciling"),
  });
  const refs = createRefsReader({ runner, trust, listingTuple: reader.listingTuple });
  const tracking = createTrackingReader({ runner, trust, listingTuple: reader.listingTuple });
  const views = createHistoryViews({ runner, trust, listingTuple: reader.listingTuple, markUnavailable: reader.markUnavailable, registry, viewCommits: historyViewCommits, ...(historyProbeRuns === undefined ? {} : { probeRuns: historyProbeRuns }), reject: (requestId, code) => reject(requestId, code) });
  const approvals = createApprovals(approvalClock);
  // Contract §5: comparison eviction invalidates its approvals.
  const comparisons = createComparisonReader({ runner, trust, onDrop: (comparisonId) => approvals.forget(comparisonId) });
  const reviews = createCommitReviewer({ runner, trust, approvals, now: approvalClock });
  const submoduleReviews = createSubmoduleReviewer({ runner, trust, approvals, environment, ...(approvalClock === undefined ? {} : { now: approvalClock }) });
  // The registry sends `ended` or `closeJob` at the terminal response (operations.ts), so the exclusion sends neither.
  // A release of a workspace with an unfinished mutation gives BUSY, so the workspace of a settled mutation is still registered.
  const exclusion = createExclusion(
    { started: (frame) => runner.started(frame), ended: () => {}, closeJob: () => {} },
    { blocked: (w) => recovery.blocked(w), settled: (entry, markerId) => recovery.settled(entry, markerId, registrations.get(entry.workspace.repositoryId)?.worktreeIdentity) },
  );
  const publisher = createHunkPublisher({ runner, trust, reader, comparisons, approvals, registry, exclusion, respond, ...(hunkCheckpoint === undefined ? {} : { hunkCheckpoint }) });
  // Contract §5 and §8: both publishers keep their retained digests and approval owners in one store, because recovery (T114) reads it.
  const files = createFilePublisher({ runner, trust, reader, comparisons, approvals, registry, exclusion, respond, retained: publisher.retained, owners: publisher.owners, ...(hunkCheckpoint === undefined ? {} : { hunkCheckpoint }) });
  const committer = createCommitter({ runner, trust, reader, reviews, approvals, registry, exclusion, respond });
  const updater = createSubmoduleUpdater({ runner, trust, reader, reviews: submoduleReviews, approvals, registry, exclusion, respond, ...(submoduleCheckpoint === undefined ? {} : { submoduleCheckpoint }) });
  const syncReviews = createSyncReviewer({ runner, trust, reader, approvals, listingTuple: reader.listingTuple });
  const syncs = createSyncer({ runner, trust, reader, approvals, registry, exclusion, respond });
  const recovery = createRecovery({ runner, registry, trust, reader, publications: publisher.retained, commits: committer.retained, updates: updater.retained });
  // Plan.md "Freshness and reconciliation": the worktree, the worktree administration directory, and the common directory.
  const watchers = new Map<string, () => void>();
  const registrations = createRegistrations({
    runner,
    unfinishedMutation: (repositoryId) => exclusion.holds(repositoryId),
    onRegister: (w) => {
      recovery.register(w);
      // Contract §11 "Change polling": a WSL workspace gets no watcher.
      if (watchHints && w.wsl === undefined) watchers.set(w.repositoryId, watchWorkspace([w.worktreeRoot, w.gitDirectory, w.commonDirectory], (lost) => reader.hint(w.repositoryId, lost)));
    },
    onRelease: (workspace) => {
      watchers.get(workspace.repositoryId)?.();
      watchers.delete(workspace.repositoryId);
      scheduler.release(workspace.repositoryId);
      views.releaseRepository(workspace.repositoryId);
      reader.release(workspace.repositoryId);
      comparisons.release(workspace.repositoryId);
      reviews.release(workspace.repositoryId);
      submoduleReviews.release(workspace.repositoryId);
      syncs.release(workspace.repositoryId);
      approvals.invalidate((a) => a.repositoryId === workspace.repositoryId);
      trust.release(workspace);
      recovery.release(workspace);
    },
  });

  const operationTarget = (request: { requestId: string; payload: { operationId: string } }, answer: (view: object) => void) => {
    const view = registry.get(request.payload.operationId);
    if (!view) return reject(request.requestId, "UNKNOWN_TARGET");
    answer(view);
  };

  const chooseGit: Handler<"chooseGit"> = (request) => {
    const { operationId, signal } = registry.start("chooseGit", request.requestId);
    registry.apply(operationId, { type: "valid-read" });
    const target = request.payload;
    const finish = (result: Awaited<ReturnType<typeof probeGit>> | { ok: false; gitCode: ErrorCode }) => {
      if (registry.get(operationId)?.state === "cancel-requested" || (!result.ok && "canceled" in result)) {
        // The shell bound this ID, and no service state owns it after a cancel.
        if (result.ok) runner.release({ gitInstallationId: result.installation.gitInstallationId });
        if (registry.get(operationId)?.state === "running") registry.apply(operationId, { type: "cancel" });
        return registry.apply(operationId, { type: "processes-stopped" });
      }
      if (!result.ok) {
        const { gitCode, ok: _ok, ...versions } = result;
        return registry.apply(operationId, { type: "read-complete", result: "failed", code: gitCode }, versions);
      }
      // Contract §3 `chooseGit`: a new `gitInstallationId` releases the previous one and every workspace bound to it.
      // A cancel that arrives before the release keeps the current selection (`stopped`).
      const previous = git?.ok && git.installation.gitInstallationId !== result.installation.gitInstallationId ? git.installation.gitInstallationId : null;
      const released = previous === null ? Promise.resolve("released" as const) : registrations.releaseInstallation(previous, () => registry.get(operationId)?.state !== "cancel-requested");
      released.then(
        (outcome) => {
          if (outcome === "stopped") return finish(result);
          if (outcome === "busy") {
            // The shell bound the new ID, and no service state owns it.
            runner.release({ gitInstallationId: result.installation.gitInstallationId });
            return finish(failure("BUSY"));
          }
          git = result;
          const { gitInstallationId, selectedPath, executablePath, version, executableIdentity } = result.installation;
          // The shell persists this digest with the paths and the version that Use this Git approved (data-model §1).
          registry.apply(operationId, { type: "read-complete", result: "succeeded" }, { gitInstallationId, selectedPath, executablePath, version, digest: executableIdentity.digest });
        },
        () => finish({ ok: false, gitCode: "GIT_FAILED" }),
      );
    };
    probeGit(runner, target, { operationId, signal, confirm: true }).then(finish, () => finish({ ok: false, gitCode: "GIT_FAILED" }));
  };

  // Contract §11 "Git per distro": the approved WSL Git of each distro GUID in this session.
  const wslGits = new Map<string, WslGit>();
  const gitCode = (): ErrorCode => (git && !git.ok ? git.gitCode : "GIT_UNAVAILABLE");

  // Contract §11 "Route". The service holds only the bootstrap ID, so the shell names the context path. A WSL path needs no Windows Git.
  // The reply path, and for a WSL path the approved WSL Git of the distro. The caller handles a runner refusal.
  async function routeGit(target: RouteTarget): Promise<{ ok: true; path: string; wsl?: { git: WslGit; linuxPath: string; identityPath: string } } | Exclude<RegistrationOutcome, { ok: true }>> {
    const { operationId, bootstrapId, signal } = target;
    const reply = await runner.wslDistros({ operationId, bootstrapId });
    const route = routeRegistration(reply);
    if ("ok" in route) return route;
    if (route.kind === "windows") return { ok: true, path: reply.path };
    const probed = await probeWslGit(runner, route, { ...target, starting: () => registry.progress(operationId, "wsl-starting", {}, route.distro) });
    if (!probed.ok) return "canceled" in probed ? { ok: false, code: "CANCELED" } : probed;
    const approved = await approveWslGit(runner, target, probed.git, wslGits.get(route.guid), route.saved);
    if (!approved.ok) return "canceled" in approved ? { ok: false, code: "CANCELED" } : approved;
    if (!approved.reused) {
      // A new Git of the distro releases every workspace of the previous one, as `chooseGit` does (contract §6 "Registration reuse and release").
      const previous = wslGits.get(route.guid);
      const released = previous === undefined ? "released" : await registrations.releaseInstallation(previous.gitInstallationId, () => !signal.aborted);
      if (released !== "released") {
        runner.release({ gitInstallationId: approved.git.gitInstallationId });
        return { ok: false, code: released === "busy" ? "BUSY" : "CANCELED" };
      }
      wslGits.set(route.guid, approved.git);
    }
    if (approved.changed) return { ok: false, code: "GIT_CHANGED" };
    return { ok: true, path: reply.path, wsl: { git: approved.git, linuxPath: route.linuxPath, identityPath: route.identityPath } };
  }

  const refusedRoute = (error: unknown, signal: AbortSignal): { ok: false; code: ErrorCode } => {
    if (error instanceof RunnerRefusal) return { ok: false, code: error.code };
    if (signal.aborted) return { ok: false, code: "CANCELED" };
    throw error;
  };

  // `destination`: feature 003 contract Δ3 `clone` step 5.
  async function registerRouted(target: RouteTarget & { destination?: string }, windows: () => Promise<RegistrationOutcome>): Promise<RegistrationOutcome> {
    try {
      const routed = await routeGit(target);
      if (!routed.ok) return routed;
      return routed.wsl === undefined ? await windows() : await registrations.registerWsl(target, routed.wsl.git);
    } catch (error) {
      return refusedRoute(error, target.signal);
    }
  }

  const register = (request: Extract<ServiceRequest, { operation: "chooseRepository" | "restoreWorkspace" }>) => {
    // Contract §11 "Route": only a Windows service routes WSL paths.
    if (!isWindows && !git?.ok) return reject(request.requestId, gitCode());
    const { operationId, signal } = registry.start(request.operation, request.requestId);
    registry.apply(operationId, { type: "valid-read" });
    const finish = (outcome: RegistrationOutcome) => {
      if (registry.get(operationId)?.state === "cancel-requested") return registry.apply(operationId, { type: "processes-stopped" });
      // Cancel in the WSL Git confirmation: the registration ends `canceled` (contract §11 "Git per distro").
      if (!outcome.ok && outcome.code === "CANCELED") {
        registry.apply(operationId, { type: "cancel" });
        return registry.apply(operationId, { type: "processes-stopped" });
      }
      if (outcome.ok) return registry.apply(operationId, { type: "read-complete", result: "succeeded" }, outcome.result);
      registry.apply(operationId, { type: "read-complete", result: "failed", code: outcome.code }, outcome.result);
    };
    const target = { operationId, bootstrapId: request.payload.bootstrapId, signal };
    (isWindows ? registerRouted(target, windowsRegistration(target)) : windowsRegistration(target)()).then(finish, () => finish({ ok: false, code: "GIT_FAILED" }));
  };
  const windowsRegistration = (target: RouteTarget & { destination?: string }) => (): Promise<RegistrationOutcome> =>
    git?.ok ? registrations.register({ ...target, installation: git.installation }) : Promise.resolve({ ok: false, code: gitCode() });

  // Feature 003 contract Δ3 `clone`. Step 1 and step 5 take the route of `chooseRepository` with the same `bootstrapId`.
  const cloner = createCloner({
    runner,
    registry,
    route: (target) => routeGit(target).catch((error: unknown) => refusedRoute(error, target.signal)),
    windowsGit: () => (git?.ok ? git.installation : gitCode()),
    register: (target) => registerRouted(target, windowsRegistration(target)),
  });

  // The Git of a read: the WSL Git of a WSL workspace, otherwise the selected Windows Git.
  // T212 decision W8: a WSL trust record names the UNC form of the WSL Git path.
  const installationOf = (w: Workspace): ReadInstallation | null => {
    if (w.wsl) return { gitInstallationId: w.wsl.gitInstallationId, selectedPath: wslIdentityPath(w.wsl.distro, w.wsl.path), executablePath: w.wsl.path, wsl: { identity: w.wsl.identity, version: w.wsl.version } };
    return git?.ok ? git.installation : null;
  };

  // `approveTrust` and `revokeTrust` take no read slot. Contract §6: a release cancels neither, and `approveTrust` waits for the native confirmation.
  // `accept` runs the acceptance check of contract §9 before any Git process. A refusal ends `rejected`.
  const trustOperation = <R>(
    request: Extract<ServiceRequest, { operation: "readTrust" | "approveTrust" | "revokeTrust" }>,
    accept: () => ErrorCode | null,
    run: (target: { operationId: string; signal: AbortSignal; installation: ReadInstallation }) => Promise<TrustOutcome<R>>,
  ) => {
    const installation = installationOf(workspaceOf(request.repositoryId));
    if (installation === null) return reject(request.requestId, gitCode());
    const { operationId, signal } = registry.start(request.operation, request.requestId);
    const refused = accept();
    if (refused !== null) return void registry.apply(operationId, { type: "invalid-approval", code: refused });
    registry.apply(operationId, { type: "valid-read" });
    const finish = (outcome: TrustOutcome<R>) => {
      const state = registry.get(operationId)?.state;
      if (state === "cancel-requested") return registry.apply(operationId, outcome.result === "deadline" ? { type: "read-deadline" } : { type: "processes-stopped" });
      if (outcome.result === "deadline") return registry.apply(operationId, { type: "read-deadline" });
      if (outcome.result === "canceled") {
        registry.apply(operationId, { type: "cancel" });
        return registry.apply(operationId, { type: "processes-stopped" });
      }
      if (outcome.result === "failed") return registry.apply(operationId, { type: "read-complete", result: "failed", code: outcome.code }, outcome.value);
      registry.apply(operationId, { type: "read-complete", result: outcome.result, ...(outcome.result === "limited" ? { code: outcome.code } : {}) }, outcome.value);
    };
    run({ operationId, signal, installation }).then(finish, () => finish({ result: "failed", code: "GIT_FAILED" }));
  };
  const workspaceOf = (repositoryId: string) => registrations.get(repositoryId)!;

  // Data-model §7 read rows. A failed outcome takes the REPOSITORY_UNAVAILABLE result of its re-read.
  const endRead = (operationId: string, end: ReadEnd<ReadResult, ReadResult | null>) => {
    if (end.kind === "canceled") return void registry.apply(operationId, { type: "processes-stopped" });
    if (end.kind === "deadline") return void registry.apply(operationId, { type: "read-deadline" });
    const outcome = end.outcome.result === "failed" && end.reread !== null ? end.reread : end.outcome;
    if (outcome.result === "deadline") return void registry.apply(operationId, { type: "read-deadline" });
    if (outcome.result === "canceled") {
      registry.apply(operationId, { type: "cancel" });
      return void registry.apply(operationId, { type: "processes-stopped" });
    }
    registry.apply(operationId, { type: "read-complete", result: outcome.result, ...(outcome.code === undefined ? {} : { code: outcome.code }) }, outcome.value, outcome.cause);
  };

  // Contract §5 "Concurrent reads" and "Pending reads". A read that can neither start nor wait gets BUSY before admission. Contract §5 names no code for it.
  // `failed` is the outcome of a `run` that throws.
  const scheduleRead = (
    request: { requestId: string; operation: "readWorkspace" | "openHistory" | "readRefs" | "readTrust" | "readComparison" | "reviewCommit" | "reviewSubmodules" | "readTracking" | "reviewSync"; repositoryId: string },
    run: (target: { operationId: string; signal: AbortSignal }) => Promise<ReadResult>,
    reread: (target: RereadTarget) => Promise<ReadResult | null>,
    failed: ReadResult,
    selection?: string,
  ) => {
    if (!scheduler.accepts(request.repositoryId)) return reject(request.requestId, "BUSY");
    const { operationId, signal } = registry.start(request.operation, request.requestId);
    registry.apply(operationId, { type: "valid-read" });
    scheduler.schedule<ReadResult, ReadResult | null>({
      operationId,
      repositoryId: request.repositoryId,
      signal,
      ...(selection === undefined ? {} : { selection }),
      run: (work) => run({ operationId, signal: work }).catch(() => failed),
      failed: (outcome) => outcome.result === "failed" || outcome.result === "deadline",
      reread: (target) => reread(target).catch(() => null),
      end: (end) => endRead(operationId, end),
    });
  };

  // Contract §3 `readWorkspace`.
  const readWorkspace: Handler<"readWorkspace"> = (request) => {
    const workspace = workspaceOf(request.repositoryId);
    const installation = installationOf(workspace);
    if (installation === null) return reject(request.requestId, gitCode());
    // Contract §8 "Token invalidation": a refresh invalidates every dependent token before its result arrives.
    if (request.payload.refresh) approvals.invalidate((a) => a.repositoryId === request.repositoryId);
    scheduleRead(
      request,
      async (t) => {
        const outcome = await reader.readWorkspace({
          ...t,
          installation,
          workspace,
          refresh: request.payload.refresh,
          check: request.payload.check,
          ...(request.repositoryGeneration === undefined ? {} : { requestGeneration: request.repositoryGeneration }),
        });
        // Contract §8: only a refresh performs recovery reconciliation, inside the read slot and its deadline.
        return request.payload.refresh ? recovery.refresh({ ...t, workspace, installation }, outcome) : outcome;
      },
      (t) => reader.recheck({ ...t, workspace }),
      { result: "failed", code: "GIT_FAILED", value: { completeness: { state: "failed", code: "GIT_FAILED" }, recoveryState: reader.recoveryState(workspace) } } satisfies ReadOutcome,
    );
  };

  // Feature 002 contract Δ2 and Δ3 `openHistory`: one read slot. Contract §2 and §9: a `repositoryGeneration` other than the current workspace generation gives REPOSITORY_CHANGED at acceptance, and no Git process starts.
  const openHistory: Handler<"openHistory"> = (request) => {
    const workspace = workspaceOf(request.repositoryId);
    const installation = installationOf(workspace);
    if (installation === null) return reject(request.requestId, gitCode());
    if (request.repositoryGeneration !== workspace.generation) {
      const { operationId } = registry.start("openHistory", request.requestId);
      return void registry.apply(operationId, { type: "invalid-approval", code: "REPOSITORY_CHANGED" });
    }
    scheduleRead(
      request,
      (t) => views.open({ ...t, installation, workspace, generation: request.repositoryGeneration }, request.payload.scope),
      async (t) => ((await reader.recheck({ ...t, workspace })) === null ? null : { result: "failed", code: "REPOSITORY_UNAVAILABLE", value: {} }),
      { result: "failed", code: "GIT_FAILED", value: {} },
    );
  };

  // Contract §3 `readRefs`. The generation decides at acceptance as for `openHistory`. Contract §5 "Pending reads": a new `readRefs` cancels each unfinished one of its workspace.
  const readRefs: Handler<"readRefs"> = (request) => {
    const workspace = workspaceOf(request.repositoryId);
    const installation = installationOf(workspace);
    if (installation === null) return reject(request.requestId, gitCode());
    if (request.repositoryGeneration !== workspace.generation) {
      const { operationId } = registry.start("readRefs", request.requestId);
      return void registry.apply(operationId, { type: "invalid-approval", code: "REPOSITORY_CHANGED" });
    }
    scheduleRead(
      request,
      (t) => refs.readRefs({ ...t, installation, workspace, generation: request.repositoryGeneration }),
      async (t) =>
        (await reader.recheck({ ...t, workspace })) === null ? null : { result: "failed", code: "REPOSITORY_UNAVAILABLE", value: { completeness: { state: "failed", code: "REPOSITORY_UNAVAILABLE" } } },
      { result: "failed", code: "GIT_FAILED", value: { completeness: { state: "failed", code: "GIT_FAILED" } } } satisfies RefsOutcome,
      "readRefs",
    );
  };

  // Feature 003 contract Δ3 `readTracking`: one read slot, and the generation decides at acceptance as for `readRefs`.
  const readTracking: Handler<"readTracking"> = (request) => {
    const workspace = workspaceOf(request.repositoryId);
    const installation = installationOf(workspace);
    if (installation === null) return reject(request.requestId, gitCode());
    if (request.repositoryGeneration !== workspace.generation) {
      const { operationId } = registry.start("readTracking", request.requestId);
      return void registry.apply(operationId, { type: "invalid-approval", code: "REPOSITORY_CHANGED" });
    }
    scheduleRead(
      request,
      (t) => tracking.readTracking({ ...t, installation, workspace, generation: request.repositoryGeneration }),
      async (t) => ((await reader.recheck({ ...t, workspace })) === null ? null : { result: "failed", code: "REPOSITORY_UNAVAILABLE", value: { completeness: { state: "failed", code: "REPOSITORY_UNAVAILABLE" } } }),
      { result: "failed", code: "GIT_FAILED", value: { completeness: { state: "failed", code: "GIT_FAILED" } } },
    );
  };

  // Feature 003 contract Δ3 `reviewSync`: one read slot. Batch 3 adds the actions `pull`, `integrate`, `abort`, `continue`, and `skip`.
  const reviewSync: Handler<"reviewSync"> = (request) => {
    const workspace = workspaceOf(request.repositoryId);
    const installation = installationOf(workspace);
    if (installation === null) return reject(request.requestId, gitCode());
    if (!REVIEWED_ACTIONS.includes(request.payload.action)) return reject(request.requestId, "SERVICE_UNAVAILABLE");
    if (request.repositoryGeneration !== workspace.generation) {
      const { operationId } = registry.start("reviewSync", request.requestId);
      return void registry.apply(operationId, { type: "invalid-approval", code: "REPOSITORY_CHANGED" });
    }
    scheduleRead(
      request,
      (t) => syncReviews.reviewSync({ ...t, installation, workspace, generation: request.repositoryGeneration }, request.payload),
      async (t) => ((await reader.recheck({ ...t, workspace })) === null ? null : { result: "failed", code: "REPOSITORY_UNAVAILABLE" }),
      { result: "failed", code: "GIT_FAILED" },
    );
  };

  // Contract §3 `readEntries` and §5 "Concurrent reads": it takes no read slot and starts no Git process. Each refusal ends `rejected` (§9).
  const readEntries: Handler<"readEntries"> = (request) => {
    const { operationId } = registry.start("readEntries", request.requestId);
    const page = reader.readEntries(request.repositoryId, request.repositoryGeneration, request.payload.snapshotId, request.payload.cursor);
    if (!page.ok) return void registry.apply(operationId, { type: "invalid-approval", code: page.code });
    registry.apply(operationId, { type: "valid-read" });
    registry.apply(operationId, { type: "read-complete", result: "succeeded" }, page.value);
  };

  // Contract §3 `readComparison`. Contract §9: the generation, the snapshot, and the entry decide at acceptance, and no Git process starts.
  // Contract §5 "Pending reads": a new `readComparison` cancels each unfinished one of its workspace.
  const readComparison: Handler<"readComparison"> = (request) => {
    const workspace = workspaceOf(request.repositoryId);
    const installation = installationOf(workspace);
    if (installation === null) return reject(request.requestId, gitCode());
    const found = reader.entry(request.repositoryId, request.repositoryGeneration, request.payload.snapshotId, request.payload.entryId);
    if (!found.ok) {
      const { operationId } = registry.start("readComparison", request.requestId);
      return void registry.apply(operationId, { type: "invalid-approval", code: found.code });
    }
    // Data-model §6: the hunk and file approvals of a succeeded comparison, issued before its response.
    // A working-file comparison issues hunk approvals only after its working version joins the read observation (data-model §4 `workingVersions`).
    // A working version above the compared bound cannot join it. Its file approval relies on the whole-file digests of steps 3 and 7.
    // A WSL read folds no working version. Its hunk checkpoints compare the whole-file digest that a `stage` file action binds (contract §4 "Binding").
    // `fact`: the contract §8 "Change check" fact of the entry path, taken before the comparison reads the working file.
    const path = new Uint8Array(Buffer.from(found.entry.pathBytes, "base64"));
    const issue = (o: ReadResult, fact: string | null): ReadResult => {
      const id = o.result === "succeeded" ? (o.value as { comparisonId?: unknown } | undefined)?.comparisonId : undefined;
      const c = typeof id === "string" ? comparisons.get(id) : undefined;
      if (c === undefined || workspace.generation !== c.generation) return o;
      const v = c.workingVersion;
      const bound =
        c.scope === "head-to-index" ||
        (workspace.wsl !== undefined ? c.fileAction.direction === "stage" : v !== null && reader.bind(request.repositoryId, c.generation, v, Buffer.compare(v.path, path) === 0 ? fact : null));
      if (bound) for (const approval of hunkApprovals(c, found.snapshot, workspace)) approvals.issue(approval);
      const file = bound || c.workingVersion === null ? fileApproval(c, found.snapshot, workspace) : null;
      if (file !== null) approvals.issue(file);
      return o;
    };
    scheduleRead(
      request,
      async (t) => {
        const fact = workspace.wsl === undefined ? await reader.workingFact(workspace, path) : null;
        return issue(await comparisons.readComparison({ ...t, installation, workspace, snapshot: found.snapshot, entry: found.entry }), fact);
      },
      async (t) => ((await reader.recheck({ ...t, workspace })) === null ? null : { result: "failed", code: "REPOSITORY_UNAVAILABLE" }),
      { result: "failed", code: "GIT_FAILED" },
      "readComparison",
    );
  };

  // Contract §3 `reviewCommit`. Contract §9: the generation and the snapshot decide at acceptance, and no Git process starts.
  const reviewCommit: Handler<"reviewCommit"> = (request) => {
    const workspace = workspaceOf(request.repositoryId);
    const installation = installationOf(workspace);
    if (installation === null) return reject(request.requestId, gitCode());
    const found = reader.snapshot(request.repositoryId, request.repositoryGeneration, request.payload.snapshotId);
    if (!found.ok) {
      const { operationId } = registry.start("reviewCommit", request.requestId);
      return void registry.apply(operationId, { type: "invalid-approval", code: found.code });
    }
    scheduleRead(
      request,
      (t) => reviews.reviewCommit({ ...t, installation, workspace, snapshot: found.snapshot }),
      async (t) => ((await reader.recheck({ ...t, workspace })) === null ? null : { result: "failed", code: "REPOSITORY_UNAVAILABLE" }),
      { result: "failed", code: "GIT_FAILED" },
    );
  };

  // Contract §3 `reviewSubmodules`. Contract §9: the generation and the snapshot decide at acceptance, and no Git process starts.
  const reviewSubmodules: Handler<"reviewSubmodules"> = (request) => {
    const workspace = workspaceOf(request.repositoryId);
    const installation = installationOf(workspace);
    if (installation === null) return reject(request.requestId, gitCode());
    const found = reader.snapshot(request.repositoryId, request.repositoryGeneration, request.payload.snapshotId);
    if (!found.ok) {
      const { operationId } = registry.start("reviewSubmodules", request.requestId);
      return void registry.apply(operationId, { type: "invalid-approval", code: found.code });
    }
    scheduleRead(
      request,
      (t) => submoduleReviews.reviewSubmodules({ ...t, installation, workspace, snapshot: found.snapshot }),
      async (t) => ((await reader.recheck({ ...t, workspace })) === null ? null : { result: "failed", code: "REPOSITORY_UNAVAILABLE" }),
      { result: "failed", code: "GIT_FAILED" },
    );
  };

  // Contract §6 "Dismissal". A payload without `bootstrapId` starts no Git process. The result states that the outcome stays unknown.
  // The marker stays in recovery: the shell deletes its file only after the native confirmation.
  const dismissRecoveryMarker: Handler<"dismissRecoveryMarker"> = (request) => {
    const { markerId, bootstrapId } = request.payload;
    const h = handshake as Handshake;
    const marker = h.markers.find((m) => m.markerId === markerId);
    if (marker === undefined && !h.damagedMarkers.some((m) => m.markerId === markerId)) return reject(request.requestId, "UNKNOWN_TARGET");
    let discover: ((target: { operationId: string; signal: AbortSignal }) => Promise<DismissalOutcome>) | null = null;
    if (bootstrapId !== undefined) {
      // Contract §6: the shell sends a damaged marker without a context, so a damaged marker has no stored identity to compare.
      if (marker === undefined) return reject(request.requestId, "INVALID_REQUEST");
      if ("distroGuid" in marker.commonIdentity) {
        // Contract §11 "Distro start": a dismissal of a WSL marker enters phase `wsl-starting` as registration and restore do.
        discover = (t) =>
          dismissWslMarker(runner, { ...t, bootstrapId, starting: (distro) => registry.progress(t.operationId, "wsl-starting", {}, distro) }, marker, wslGits);
      } else {
        if (!git?.ok) return reject(request.requestId, gitCode());
        const installation = git.installation;
        discover = (t) => dismissMarker(runner, { ...t, bootstrapId, installation }, marker);
      }
    }
    const { operationId, signal } = registry.start("dismissRecoveryMarker", request.requestId);
    registry.apply(operationId, { type: "valid-read" });
    const finish = (outcome: DismissalOutcome) => {
      if (registry.get(operationId)?.state === "cancel-requested") return registry.apply(operationId, { type: "processes-stopped" });
      if (outcome.ok) return registry.apply(operationId, { type: "read-complete", result: "succeeded" }, { outcome: "unknown" });
      if (outcome.code === "CANCELED") {
        registry.apply(operationId, { type: "cancel" });
        return registry.apply(operationId, { type: "processes-stopped" });
      }
      registry.apply(operationId, { type: "read-complete", result: "failed", code: outcome.code }, outcome.result);
    };
    if (discover === null) return void finish({ ok: true });
    discover({ operationId, signal }).then(finish, () => finish({ ok: false, code: "GIT_FAILED" }));
  };

  // Feature 003 contract Δ3 `connectInTerminal` and data-model §11. A `sync` target needs the `repositoryId` of its workspace, and a `clone` target has none.
  // The target text leaves the service only in the `terminal` request.
  const connectInTerminal: Handler<"connectInTerminal"> = (request) => {
    const { repositoryId } = request;
    const target = repositoryId === undefined ? cloner.connectTarget() : syncs.connectTarget(repositoryId);
    if (target?.operationId !== request.payload.operationId) return reject(request.requestId, "UNKNOWN_TARGET");
    const { operationId, signal } = registry.start("connectInTerminal", request.requestId);
    registry.apply(operationId, { type: "valid-read" });
    const finish = (code: ErrorCode | null, result?: unknown) => {
      if (registry.get(operationId)?.state === "cancel-requested") return registry.apply(operationId, { type: "processes-stopped" });
      registry.apply(operationId, code === null ? { type: "read-complete", result: "succeeded" } : { type: "read-complete", result: "failed", code }, result);
    };
    const connect = async (): Promise<void> => {
      if (repositoryId !== undefined) {
        // Contract Δ3: the current trust listing decides before the console starts. A clone target has no repository.
        const workspace = workspaceOf(repositoryId);
        const installation = installationOf(workspace);
        if (installation === null) return void finish(gitCode());
        const listed = await trust.listTrust({ operationId, signal, workspace });
        if (!listed.ok) return void finish("stop" in listed ? (listed.stop === "deadline" ? "DEADLINE" : "CANCELED") : listed.code);
        const gate = trust.gate(workspace, listed.listing, installation, "sync");
        if (gate !== null) return void finish(gate);
      }
      const reply = await runner.terminal({ operationId, gitInstallationId: target.gitInstallationId, ...(repositoryId === undefined ? {} : { repositoryId }), target: target.target });
      if (reply.result === "started") return void finish(null);
      finish("PUTTY_UNAVAILABLE", { reason: reply.reason, program: reply.program, path: reply.path });
    };
    connect().catch((error: unknown) => finish(error instanceof RunnerRefusal ? error.code : "GIT_FAILED"));
  };

  // `undefined`: a later task adds the handler. The request then gets SERVICE_UNAVAILABLE.
  const handlers: { [K in ServiceOperation]: Handler<K> | undefined } = {
    getEnvironment: (request) => {
      const { operationId } = registry.start("getEnvironment", request.requestId);
      registry.apply(operationId, { type: "valid-read" });
      registry.apply(operationId, { type: "read-complete", result: "succeeded" }, getEnvironment(handshake as Handshake, git));
    },
    chooseGit,
    chooseRepository: register,
    restoreWorkspace: register,
    readWorkspace,
    readEntries,
    openHistory,
    loadHistory: (request) => views.load(request),
    readHistoryRows: (request) => views.rows(request),
    searchHistory: (request) => views.search(request),
    closeHistory: (request) => views.close(request),
    readRefs,
    readComparison,
    readTrust: (request) => {
      const workspace = workspaceOf(request.repositoryId);
      const installation = installationOf(workspace);
      if (installation === null) return reject(request.requestId, gitCode());
      scheduleRead(
        request,
        (t) => trust.readTrust({ ...t, workspace, installation }, workspace.generation),
        // ReadTrustResult `TrustListingFailed` names a file and an errno name. The re-read refusal names neither, so its response carries only the code.
        async (t) => ((await reader.recheck({ ...t, workspace })) === null ? null : { result: "failed", code: "REPOSITORY_UNAVAILABLE" }),
        { result: "failed", code: "GIT_FAILED" },
      );
    },
    approveTrust: (request) => {
      const workspace = workspaceOf(request.repositoryId);
      const { fingerprint } = request.payload;
      trustOperation(
        request,
        () => trust.acceptApprove(request.repositoryId, fingerprint, request.repositoryGeneration),
        (t) => trust.approveTrust({ ...t, workspace }, fingerprint),
      );
    },
    revokeTrust: (request) => {
      const workspace = workspaceOf(request.repositoryId);
      trustOperation(
        request,
        () => trust.acceptRevoke(workspace, request.payload.trustId),
        (t) => {
          // Contract §6 "Lingering Jobs": a revoke after `started` sets `endProcesses` on the `ended` frame of each unfinished mutation of that common directory.
          for (const operationId of exclusion.running(workspace.commonIdentity)) {
            const state = registry.get(operationId)?.state;
            if (state === "running" || state === "cancel-requested" || state === "reconciling") registry.apply(operationId, { type: "revoke-trust" });
          }
          return trust.revokeTrust({ ...t, workspace });
        },
      );
    },
    applyHunk: (request) => {
      const workspace = workspaceOf(request.repositoryId);
      const installation = installationOf(workspace);
      if (installation === null) return reject(request.requestId, gitCode());
      publisher.applyHunk(request, workspace, installation);
    },
    applyFile: (request) => {
      const workspace = workspaceOf(request.repositoryId);
      const installation = installationOf(workspace);
      if (installation === null) return reject(request.requestId, gitCode());
      files.applyFile(request, workspace, installation);
    },
    reviewCommit,
    commit: (request) => {
      const workspace = workspaceOf(request.repositoryId);
      const installation = installationOf(workspace);
      if (installation === null) return reject(request.requestId, gitCode());
      committer.commit(request, workspace, installation);
    },
    reviewSubmodules,
    updateSubmodules: (request) => {
      const workspace = workspaceOf(request.repositoryId);
      const installation = installationOf(workspace);
      if (installation === null) return reject(request.requestId, gitCode());
      // Contract §12 "Update protocol" step 5: the probed version of the Git that runs the update selects the fallback remote rule.
      updater.updateSubmodules(request, workspace, installation, workspace.wsl !== undefined ? workspace.wsl.version : git?.ok ? git.installation.version : null);
    },
    cancel: (request) =>
      operationTarget(request, () => {
        const view = registry.cancel(request.payload.operationId);
        respond({ requestId: request.requestId, state: "succeeded", result: view });
      }),
    getOperation: (request) => operationTarget(request, (view) => respond({ requestId: request.requestId, state: "succeeded", result: view })),
    dismissRecoveryMarker,
    readTracking,
    reviewSync,
    sync: (request) => {
      const workspace = workspaceOf(request.repositoryId);
      const installation = installationOf(workspace);
      if (installation === null) return reject(request.requestId, gitCode());
      syncs.sync(request, workspace, installation);
    },
    clone: (request) => cloner.clone(request),
    connectInTerminal,
  };

  function receiveHandshake(frame: Fields) {
    const body = frame.handshake;
    const reply = (handshake: Fields) => writer.write({ kind: "handshake", handshake });
    if (sessionId !== null) return reply({ code: "INVALID_REQUEST" });
    const version = isObject(body) && Object.hasOwn(body, "version") && (body.version !== 1 || hasFractionOrExponent(body, "version"));
    const parsed = Handshake.safeParse(body);
    if (Object.keys(frame).length === 2 && !version && parsed.success) {
      handshake = parsed.data;
      trust.loadRecords(handshake.trustRecords);
      recovery.load(handshake);
      sessionId = crypto.randomUUID();
      reply({ sessionId });
      const saved = handshake.savedGit;
      if (!saved) return;
      // Contract §6 "Context rules": the startup `gitProbe` context has no public operation.
      const operationId = crypto.randomUUID();
      startup = [];
      let settled = false;
      const settle = (result: GitProbeResult) => {
        // A registration that ends after the deadline binds an ID that no service state owns.
        if (settled) return void (result.ok && runner.release({ gitInstallationId: result.installation.gitInstallationId }));
        settled = true;
        clearTimeout(timer);
        git = result;
        runner.closeJob(operationId);
        const waiting = startup ?? [];
        startup = null;
        for (const next of waiting) next();
      };
      const timer = setTimeout(() => settle(failure("DEADLINE")), startupDeadlineMs);
      revalidateSavedGit(runner, saved, operationId).then(settle, (error) => settle(failure(error instanceof RunnerRefusal ? error.code : "GIT_FAILED")));
      return;
    }
    reply({ code: version ? "PROTOCOL_VERSION" : "INVALID_REQUEST" });
    fail();
  }

  function receivePublic(frame: Fields, size: number) {
    const requestId = requestIdOf(frame.request);
    if (sessionId === null) return reject(requestId, "SERVICE_UNAVAILABLE");
    if (size > PUBLIC_FRAME_BODY_BYTES) return reject(null, "FRAME_LIMIT");
    if (!claim(requestId) || Object.keys(frame).length !== 2 || !Object.hasOwn(frame, "request")) return reject(requestId, "INVALID_REQUEST");
    const checked = validateRequest(frame.request, "service");
    if (!checked.ok) return reject(requestId, checked.code as ErrorCode);
    const request = checked.request;
    const echo = { operation: request.operation, ...("repositoryGeneration" in request && request.repositoryGeneration !== undefined ? { repositoryGeneration: request.repositoryGeneration } : {}), ...("selectionId" in request ? { selectionId: request.selectionId } : {}) };
    if (request.operation === "readWorkspace" || "repositoryGeneration" in echo || "selectionId" in echo) echoes.set(request.requestId, echo);
    if (request.sessionId !== sessionId) return reject(requestId, "UNKNOWN_TARGET");
    // Feature 003 `connectInTerminal` names no repository for a clone target.
    if ("repositoryId" in request && request.repositoryId !== undefined && !registrations.has(request.repositoryId)) return reject(requestId, "UNKNOWN_TARGET");
    const handler = handlers[request.operation] as Handler<ServiceOperation> | undefined;
    if (!handler) return reject(requestId, "SERVICE_UNAVAILABLE");
    handler(request as never);
  }

  return {
    receive(incoming: Incoming): void {
      if (incoming.type === "oversize") return reject(null, "FRAME_LIMIT");
      const decoded = decodeStrictJson(incoming.body);
      if (!decoded.ok) return reject(plainRequestId(incoming.body), "INVALID_REQUEST");
      const frame = decoded.value;
      if (!isObject(frame) || !isFrameKind(frame.kind)) {
        const requestId = isObject(frame) ? requestIdOf(frame.request) : null;
        if (sessionId !== null) claim(requestId);
        return reject(requestId, "INVALID_REQUEST");
      }
      if (frame.kind === "handshake") return receiveHandshake(frame);
      if (frame.kind === "public") {
        const size = incoming.body.length;
        if (!startup) return receivePublic(frame, size);
        // A held oversize frame keeps only its answer, not its decoded body.
        if (size > PUBLIC_FRAME_BODY_BYTES) return void (startup.length < PENDING_READS_GLOBAL ? startup.push(() => reject(null, "FRAME_LIMIT")) : reject(null, "FRAME_LIMIT"));
        if (startup.length < PENDING_READS_GLOBAL) return void startup.push(() => receivePublic(frame, size));
        const requestId = requestIdOf(frame.request);
        return reject(requestId, claim(requestId) ? "SERVICE_UNAVAILABLE" : "INVALID_REQUEST");
      }
      if (!runner.receive(frame as Frame)) reject(null, "INVALID_REQUEST");
    },
    get sessionId() {
      return sessionId;
    },
    get handshake() {
      return handshake;
    },
    registry,
    log,
    // Stops every watcher. The service process needs no call, because its exit ends them.
    close(): void {
      for (const stop of watchers.values()) stop();
      watchers.clear();
    },
  };
}
