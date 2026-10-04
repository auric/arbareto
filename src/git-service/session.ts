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
import { failure, probeGit, revalidateSavedGit, type GitProbeResult } from "./git-installation";
import { createSessionLog } from "./log";
import { createOperationRegistry } from "./operations";
import { isFrameKind, type Frame, type FrameWriter, type Incoming } from "./transport";

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
}

export function createSession({ writer, runner, fail, startupDeadlineMs = GIT_PROCESS_DEADLINE_MS }: SessionOptions) {
  let sessionId: string | null = null;
  let handshake: Handshake | null = null;
  const seenRequests = new Set<string>();
  const repositories = new Set<string>();
  const log = createSessionLog();
  // Null until the startup revalidation or a `chooseGit` gives a result.
  let git: GitProbeResult | null = null;
  // Contract §6 "Startup contexts": public requests wait for the revalidation of `savedGit`. Contract §5 "Pending reads" caps the queue.
  let startup: (() => void)[] | null = null;

  const respond = (response: Response) => {
    if (response.state === "rejected" && !codeFitsState("rejected", response.code)) throw new Error("rejected response needs an error code");
    writer.write({ kind: "public", response });
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
      // Contract §3 `chooseGit`: a new `gitInstallationId` releases the previous one.
      if (git?.ok && git.installation.gitInstallationId !== result.installation.gitInstallationId) runner.release({ gitInstallationId: git.installation.gitInstallationId });
      git = result;
      const { gitInstallationId, selectedPath, executablePath, version, executableIdentity } = result.installation;
      // The shell persists this digest with the paths and the version that Use this Git approved (data-model §1).
      registry.apply(operationId, { type: "read-complete", result: "succeeded" }, { gitInstallationId, selectedPath, executablePath, version, digest: executableIdentity.digest });
    };
    probeGit(runner, target, { operationId, signal, confirm: true }).then(finish, () => finish({ ok: false, gitCode: "GIT_FAILED" }));
  };

  // `undefined`: a later task adds the handler. The request then gets SERVICE_UNAVAILABLE.
  const handlers: { [K in ServiceOperation]: Handler<K> | undefined } = {
    getEnvironment: (request) => {
      const { operationId } = registry.start("getEnvironment", request.requestId);
      registry.apply(operationId, { type: "valid-read" });
      registry.apply(operationId, { type: "read-complete", result: "succeeded" }, getEnvironment(handshake as Handshake, git));
    },
    chooseGit,
    chooseRepository: undefined,
    restoreWorkspace: undefined,
    readWorkspace: undefined,
    readHistory: undefined,
    readComparison: undefined,
    readTrust: undefined,
    approveTrust: undefined,
    revokeTrust: undefined,
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
    if (request.sessionId !== sessionId) return reject(requestId, "UNKNOWN_TARGET");
    if ("repositoryId" in request && !repositories.has(request.repositoryId)) return reject(requestId, "UNKNOWN_TARGET");
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
  };
}
