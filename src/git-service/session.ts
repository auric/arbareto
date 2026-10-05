// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Handshake } from "../contracts/channel";
import { validateRequest, type Response, type ServiceRequest } from "../contracts/envelope";
import { codeFitsState, type ErrorCode } from "../contracts/errors";
import { GIT_PROCESS_DEADLINE_MS, PENDING_READS_GLOBAL, PUBLIC_FRAME_BODY_BYTES, RECORDED_REQUEST_IDS } from "../contracts/limits";
import { isIdentifier, type OperationName } from "../contracts/operations";
import { decodeStrictJson, hasFractionOrExponent } from "../contracts/strict-json";
import { RunnerRefusal, type GitRunner } from "./git-runner";
import { getEnvironment } from "./environment";
import { failure, probeGit, revalidateSavedGit, type GitInstallation, type GitProbeResult } from "./git-installation";
import { createHistoryReader, type HistoryOutcome } from "./history";
import { createSessionLog } from "./log";
import { createOperationRegistry } from "./operations";
import { createReadScheduler, type ReadEnd, type RereadTarget } from "./read-scheduler";
import { createRegistrations, type RegistrationOutcome } from "./registration";
import { createWorkspaceReader, type ReadOutcome } from "./status";
import { isFrameKind, type Frame, type FrameWriter, type Incoming } from "./transport";
import { createTrust, type ServiceEnvironment, type TrustOutcome } from "./trust";
import { watchWorkspace } from "./watch";

export type { Handshake } from "../contracts/channel";

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);

// Contract §3 without the shell-only `requestClose` and `currentSession`.
type ServiceOperation = Exclude<OperationName, "requestClose" | "currentSession">;
type Handler<K extends ServiceOperation> = (request: Extract<ServiceRequest, { operation: K }>) => void;

export interface SessionOptions {
  writer: FrameWriter;
  runner: GitRunner & { receive(frame: Frame): boolean };
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
}

// The outcome forms of the reads that `read-scheduler.ts` runs.
type ReadResult =
  | { result: "succeeded" | "limited" | "failed"; code?: ErrorCode; value?: unknown }
  | { result: "canceled" }
  | { result: "deadline" };

export function createSession({ writer, runner, fail, startupDeadlineMs = GIT_PROCESS_DEADLINE_MS, environment = process.env, readDeadlineMs, watchHints = true }: SessionOptions) {
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
  const respond = (response: Response) => {
    if (response.state === "rejected" && !codeFitsState("rejected", response.code)) throw new Error("rejected response needs an error code");
    const echo = response.requestId === null ? undefined : echoes.get(response.requestId);
    if (echo === undefined) return writer.write({ kind: "public", response });
    echoes.delete(response.requestId!);
    // Contract §2: a `readWorkspace` response with a result carries the generation of that result.
    const generation = echo.operation === "readWorkspace" && isObject(response.result) && typeof response.result.generation === "number" ? response.result.generation : echo.repositoryGeneration;
    writer.write({
      kind: "public",
      response: { ...response, ...(generation === undefined ? {} : { repositoryGeneration: generation }), ...(echo.selectionId === undefined ? {} : { selectionId: echo.selectionId }) },
    });
  };
  const reject = (requestId: string | null, code: ErrorCode) => respond({ requestId, state: "rejected", code });
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
  const reader = createWorkspaceReader({ runner, trust });
  const history = createHistoryReader({ runner, trust, listingTuple: reader.listingTuple, markUnavailable: reader.markUnavailable });
  // Plan.md "Freshness and reconciliation": the worktree, the worktree administration directory, and the common directory.
  const watchers = new Map<string, () => void>();
  // No mutation handler exists yet, so no mutation can be unfinished.
  const registrations = createRegistrations({
    runner,
    unfinishedMutation: () => false,
    onRegister: (w) => {
      if (watchHints) watchers.set(w.repositoryId, watchWorkspace([w.worktreeRoot, w.gitDirectory, w.commonDirectory], (lost) => reader.hint(w.repositoryId, lost)));
    },
    onRelease: (workspace) => {
      watchers.get(workspace.repositoryId)?.();
      watchers.delete(workspace.repositoryId);
      scheduler.release(workspace.repositoryId);
      reader.release(workspace.repositoryId);
      trust.release(workspace);
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

  const register = (request: Extract<ServiceRequest, { operation: "chooseRepository" | "restoreWorkspace" }>) => {
    if (!git?.ok) return reject(request.requestId, git ? git.gitCode : "GIT_UNAVAILABLE");
    const { operationId, signal } = registry.start(request.operation, request.requestId);
    registry.apply(operationId, { type: "valid-read" });
    const finish = (outcome: RegistrationOutcome) => {
      if (registry.get(operationId)?.state === "cancel-requested") return registry.apply(operationId, { type: "processes-stopped" });
      if (outcome.ok) return registry.apply(operationId, { type: "read-complete", result: "succeeded" }, outcome.result);
      registry.apply(operationId, { type: "read-complete", result: "failed", code: outcome.code }, outcome.result);
    };
    const target = { operationId, bootstrapId: request.payload.bootstrapId, installation: git.installation, signal };
    registrations.register(target).then(finish, () => finish({ ok: false, code: "GIT_FAILED" }));
  };

  // T080 wiring of `approveTrust` and `revokeTrust`. T089 moves them behind `read-scheduler.ts`.
  // `accept` runs the acceptance check of contract §9 before any Git process. A refusal ends `rejected`.
  const trustOperation = <R>(
    request: Extract<ServiceRequest, { operation: "readTrust" | "approveTrust" | "revokeTrust" }>,
    accept: () => ErrorCode | null,
    run: (target: { operationId: string; signal: AbortSignal; installation: GitInstallation }) => Promise<TrustOutcome<R>>,
  ) => {
    if (!git?.ok) return reject(request.requestId, git ? git.gitCode : "GIT_UNAVAILABLE");
    const { installation } = git;
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
    registry.apply(operationId, { type: "read-complete", result: outcome.result, ...(outcome.code === undefined ? {} : { code: outcome.code }) }, outcome.value);
  };

  // Contract §5 "Concurrent reads" and "Pending reads". A read that can neither start nor wait gets BUSY before admission. Contract §5 names no code for it.
  // `failed` is the outcome of a `run` that throws.
  const scheduleRead = (
    request: { requestId: string; operation: "readWorkspace" | "readHistory" | "readTrust"; repositoryId: string },
    run: (target: { operationId: string; signal: AbortSignal }) => Promise<ReadResult>,
    reread: (target: RereadTarget) => Promise<ReadResult | null>,
    failed: ReadResult,
  ) => {
    if (!scheduler.accepts(request.repositoryId)) return reject(request.requestId, "BUSY");
    const { operationId, signal } = registry.start(request.operation, request.requestId);
    registry.apply(operationId, { type: "valid-read" });
    scheduler.schedule<ReadResult, ReadResult | null>({
      operationId,
      repositoryId: request.repositoryId,
      signal,
      run: (work) => run({ operationId, signal: work }).catch(() => failed),
      failed: (outcome) => outcome.result === "failed" || outcome.result === "deadline",
      reread: (target) => reread(target).catch(() => null),
      end: (end) => endRead(operationId, end),
    });
  };

  // Contract §3 `readWorkspace`.
  const readWorkspace: Handler<"readWorkspace"> = (request) => {
    if (!git?.ok) return reject(request.requestId, git ? git.gitCode : "GIT_UNAVAILABLE");
    const { installation } = git;
    const workspace = workspaceOf(request.repositoryId);
    scheduleRead(
      request,
      (t) =>
        reader.readWorkspace({
          ...t,
          installation,
          workspace,
          refresh: request.payload.refresh,
          check: request.payload.check,
          ...(request.repositoryGeneration === undefined ? {} : { requestGeneration: request.repositoryGeneration }),
        }),
      (t) => reader.recheck({ ...t, workspace }),
      { result: "failed", code: "GIT_FAILED", value: { completeness: { state: "failed", code: "GIT_FAILED" }, recoveryState: "ready" } } satisfies ReadOutcome,
    );
  };

  // Contract §3 `readHistory`. Contract §2 and §9: a `repositoryGeneration` other than the current workspace generation gives REPOSITORY_CHANGED at acceptance, and no Git process starts.
  const readHistory: Handler<"readHistory"> = (request) => {
    if (!git?.ok) return reject(request.requestId, git ? git.gitCode : "GIT_UNAVAILABLE");
    const { installation } = git;
    const workspace = workspaceOf(request.repositoryId);
    if (request.repositoryGeneration !== workspace.generation) {
      const { operationId } = registry.start("readHistory", request.requestId);
      return void registry.apply(operationId, { type: "invalid-approval", code: "REPOSITORY_CHANGED" });
    }
    scheduleRead(
      request,
      (t) => history.readHistory({ ...t, installation, workspace, generation: request.repositoryGeneration }),
      async (t) =>
        (await reader.recheck({ ...t, workspace })) === null ? null : { result: "failed", code: "REPOSITORY_UNAVAILABLE", value: { completeness: { state: "failed", code: "REPOSITORY_UNAVAILABLE" } } },
      { result: "failed", code: "GIT_FAILED", value: { completeness: { state: "failed", code: "GIT_FAILED" } } } satisfies HistoryOutcome,
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
    readHistory,
    readComparison: undefined,
    readTrust: (request) => {
      if (!git?.ok) return reject(request.requestId, git ? git.gitCode : "GIT_UNAVAILABLE");
      const { installation } = git;
      const workspace = workspaceOf(request.repositoryId);
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
      trustOperation(request, () => trust.acceptRevoke(workspace, request.payload.trustId), (t) => trust.revokeTrust({ ...t, workspace }));
    },
    applyHunk: undefined,
    applyFile: undefined,
    reviewCommit: undefined,
    commit: undefined,
    reviewSubmodules: undefined,
    updateSubmodules: undefined,
    cancel: (request) =>
      operationTarget(request, () => {
        const view = registry.cancel(request.payload.operationId);
        respond({ requestId: request.requestId, state: "succeeded", result: view });
      }),
    getOperation: (request) => operationTarget(request, (view) => respond({ requestId: request.requestId, state: "succeeded", result: view })),
    dismissRecoveryMarker: undefined,
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
    if ("repositoryId" in request && !registrations.has(request.repositoryId)) return reject(requestId, "UNKNOWN_TARGET");
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
