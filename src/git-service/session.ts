// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { validateRequest, type RequestEnvelope } from "../contracts/envelope";
import { codeFitsState, type ErrorCode } from "../contracts/errors";
import {
  GIT_PROCESS_DEADLINE_MS,
  PENDING_READS_GLOBAL,
  PUBLIC_FRAME_BODY_BYTES,
  RECOVERY_MARKER_BYTES,
  RECOVERY_MARKERS_PER_HANDSHAKE,
  TRUST_RECORD_BYTES,
  TRUST_RECORDS,
  WEBVIEW2_VERSION_BYTES,
} from "../contracts/limits";
import { isFingerprint, isIdentifier, MUTATIONS, REPOSITORY_BOUND, type OperationName } from "../contracts/operations";
import { decodeStrictJson } from "../contracts/strict-json";
import { isChannelPath, RunnerRefusal, type GitRunner } from "./git-runner";
import { getEnvironment } from "./environment";
import { failure, probeGit, revalidateSavedGit, type GitProbeResult } from "./git-installation";
import { createSessionLog } from "./log";
import { createOperationRegistry, type Response } from "./operations";
import { isFrameKind, type Frame, type FrameWriter, type Incoming } from "./transport";

type Check = (value: unknown) => boolean;
type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isHex = (digits: number): Check => (v) => typeof v === "string" && v.length === digits && /^[0-9a-f]+$/.test(v);
const oneOf =
  (...allowed: unknown[]): Check =>
  (v) =>
    allowed.includes(v);
const arrayOf =
  (max: number, item: Check): Check =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(item);

// Contract §6 "Startup handshake": UTC times in RFC 3339 form.
const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;
const isUtcTime: Check = (v) => {
  const m = typeof v === "string" ? UTC_TIME.exec(v) : null;
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  // RFC 3339 §5.6 permits the leap second 60.
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h < 24 && mi < 60 && s <= 60;
};
const isAscii: Check = (v) => typeof v === "string" && v.length <= WEBVIEW2_VERSION_BYTES && /^[\x00-\x7f]*$/.test(v);
// The register `version` rule of contract §6 "Context rules".
const isPrintable: Check = (v) => typeof v === "string" && v.length <= WEBVIEW2_VERSION_BYTES && /^[\x20-\x7e]*$/.test(v);
// Contract §5 bounds each record by the bytes of its JSON encoding.
const withinBytes =
  (max: number, check: Check): Check =>
  (v) =>
    check(v) && new TextEncoder().encode(JSON.stringify(v)).length <= max;

function exact(fields: Record<string, Check>, optional: string[] = []): Check {
  return (v) => {
    if (!isObject(v) || Object.keys(v).some((k) => !Object.hasOwn(fields, k))) return false;
    return Object.entries(fields).every(([k, check]) => (Object.hasOwn(v, k) ? check(v[k]) : optional.includes(k)));
  };
}

// Contract §6 "Process fields": a Windows identity reply.
const isIdentity = exact({ volumeSerial: isHex(16), fileId: isHex(32) });
const isMarker = withinBytes(RECOVERY_MARKER_BYTES, exact({
  markerId: isIdentifier,
  kind: oneOf(...MUTATIONS),
  startedAt: isUtcTime,
  worktreeRoot: isChannelPath,
  commonDirectory: isChannelPath,
  commonIdentity: isIdentity,
}));
// Contract §6 "Startup handshake": also the record form of a `confirm` reply.
export const isTrustRecord = withinBytes(TRUST_RECORD_BYTES, exact({
  commonDirectory: isChannelPath,
  commonIdentity: isIdentity,
  worktreeRoot: isChannelPath,
  gitDirectory: isChannelPath,
  worktreeIdentity: (v) => Array.isArray(v) && v.length === 2 && v.every(isIdentity),
  configurationFingerprint: isFingerprint,
  approvedAt: isUtcTime,
  gitInstallationDigest: isFingerprint,
}));
const isHandshake = exact(
  {
    version: oneOf(1),
    restarted: (v) => typeof v === "boolean",
    platformScope: oneOf("qualification-target", "other"),
    osBuild: isCount,
    webView2Version: isAscii,
    // `commit` is a SHA-1 or SHA-256 commit ID.
    buildIdentity: exact({ version: isPrintable, commit: (v) => typeof v === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})(-dirty)?$/.test(v), signing: oneOf("unsigned") }),
    markers: arrayOf(RECOVERY_MARKERS_PER_HANDSHAKE, isMarker),
    unloadedMarkers: isCount,
    trustRecords: arrayOf(TRUST_RECORDS, isTrustRecord),
    savedGit: exact({ bootstrapId: isIdentifier, executablePath: isChannelPath, version: isPrintable, digest: isFingerprint }),
  },
  ["savedGit"],
);

export interface Handshake {
  version: 1;
  restarted: boolean;
  platformScope: "qualification-target" | "other";
  osBuild: number;
  webView2Version: string;
  buildIdentity: { version: string; commit: string; signing: "unsigned" };
  markers: Fields[];
  unloadedMarkers: number;
  trustRecords: Fields[];
  savedGit?: { bootstrapId: string; executablePath: string; version: string; digest: string };
}

// Contract §3 without the shell-only `requestClose` and `currentSession`.
type ServiceOperation = Exclude<OperationName, "requestClose" | "currentSession">;

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
  // Contract §2: the service records each valid requestId, also of a rejected request. A repeated one gives INVALID_REQUEST.
  const claim = (requestId: string | null) => {
    if (requestId === null) return true;
    if (seenRequests.has(requestId)) return false;
    seenRequests.add(requestId);
    return true;
  };
  const registry = createOperationRegistry(respond, (progress) => writer.write({ kind: "public", progress }), log, runner);

  const operationTarget = (request: RequestEnvelope, answer: (view: object) => void) => {
    const view = registry.get(request.payload.operationId as string);
    if (!view) return reject(request.requestId, "UNKNOWN_TARGET");
    answer(view);
  };

  const chooseGit = (request: RequestEnvelope) => {
    const { operationId, signal } = registry.start("chooseGit", request.requestId);
    registry.apply(operationId, { type: "valid-read" });
    const target = request.payload as { bootstrapId: string; executablePath: string };
    const finish = (result: Awaited<ReturnType<typeof probeGit>> | { ok: false; gitCode: ErrorCode }) => {
      if (registry.get(operationId)?.state === "cancel-requested" || (!result.ok && "canceled" in result)) {
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
      const { gitInstallationId, executablePath, version, executableIdentity } = result.installation;
      // The shell persists the path, the version text, and the digest after this result (data-model §1).
      registry.apply(operationId, { type: "read-complete", result: "succeeded" }, { gitInstallationId, executablePath, version, digest: executableIdentity.digest });
    };
    probeGit(runner, target, { operationId, signal, confirm: true }).then(finish, () => finish({ ok: false, gitCode: "GIT_FAILED" }));
  };

  // `undefined`: a later task adds the handler. The request then gets SERVICE_UNAVAILABLE.
  const handlers: Record<ServiceOperation, ((request: RequestEnvelope) => void) | undefined> = {
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
        const view = registry.cancel(request.payload.operationId as string);
        respond({ requestId: request.requestId, state: "succeeded", result: view });
      }),
    getOperation: (request) => operationTarget(request, (view) => respond({ requestId: request.requestId, state: "succeeded", result: view })),
    dismissRecoveryMarker: undefined,
  };

  function receiveHandshake(frame: Fields) {
    const body = frame.handshake;
    const reply = (handshake: Fields) => writer.write({ kind: "handshake", handshake });
    if (sessionId !== null) return reply({ code: "INVALID_REQUEST" });
    if (Object.keys(frame).length === 2 && isHandshake(body)) {
      handshake = body as unknown as Handshake;
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
    const version = isObject(body) && Object.hasOwn(body, "version") && body.version !== 1;
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
    const operation = request.operation as ServiceOperation;
    if (REPOSITORY_BOUND.includes(operation) && !repositories.has(request.repositoryId as string)) return reject(requestId, "UNKNOWN_TARGET");
    const handler = handlers[operation];
    if (!handler) return reject(requestId, "SERVICE_UNAVAILABLE");
    handler(request);
  }

  return {
    receive(incoming: Incoming): void {
      if (incoming.type === "oversize") return reject(null, "FRAME_LIMIT");
      const decoded = decodeStrictJson(incoming.body);
      if (!decoded.ok) return reject(null, "INVALID_REQUEST");
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
