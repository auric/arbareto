// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { validateRequest, type RequestEnvelope } from "../contracts/envelope";
import { codeFitsState, type ErrorCode } from "../contracts/errors";
import {
  PUBLIC_FRAME_BODY_BYTES,
  RECOVERY_MARKERS_PER_HANDSHAKE,
  TRUST_RECORDS,
  WEBVIEW2_VERSION_BYTES,
} from "../contracts/limits";
import { isFingerprint, isIdentifier, MUTATIONS, REPOSITORY_BOUND, type OperationName } from "../contracts/operations";
import { decodeStrictJson } from "../contracts/strict-json";
import { isChannelPath, type GitRunner } from "./git-runner";
import { createSessionLog } from "./log";
import { createOperationRegistry, type Response } from "./operations";
import { isFrameKind, type Frame, type FrameWriter, type Incoming } from "./transport";

type Check = (value: unknown) => boolean;
type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isString: Check = (v) => typeof v === "string";
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

function exact(fields: Record<string, Check>, optional: string[] = []): Check {
  return (v) => {
    if (!isObject(v) || Object.keys(v).some((k) => !Object.hasOwn(fields, k))) return false;
    return Object.entries(fields).every(([k, check]) => (Object.hasOwn(v, k) ? check(v[k]) : optional.includes(k)));
  };
}

// Contract §6 "Process fields": a Windows identity reply.
const isIdentity = exact({ volumeSerial: isHex(16), fileId: isHex(32) });
const isMarker = exact({
  markerId: isIdentifier,
  kind: oneOf(...MUTATIONS),
  startedAt: isUtcTime,
  worktreeRoot: isChannelPath,
  commonDirectory: isChannelPath,
  commonIdentity: isIdentity,
});
// Contract §6 "Startup handshake": also the record form of a `confirm` reply.
export const isTrustRecord = exact({
  commonDirectory: isChannelPath,
  commonIdentity: isIdentity,
  worktreeRoot: isChannelPath,
  gitDirectory: isChannelPath,
  worktreeIdentity: (v) => Array.isArray(v) && v.length === 2 && v.every(isIdentity),
  configurationFingerprint: isFingerprint,
  approvedAt: isUtcTime,
  gitInstallationDigest: isFingerprint,
});
const isHandshake = exact(
  {
    version: oneOf(1),
    restarted: (v) => typeof v === "boolean",
    platformScope: oneOf("qualification-target", "other"),
    osBuild: isCount,
    webView2Version: isAscii,
    // `commit` is a SHA-1 or SHA-256 commit ID.
    buildIdentity: exact({ version: isString, commit: (v) => typeof v === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})(-dirty)?$/.test(v), signing: oneOf("unsigned") }),
    markers: arrayOf(RECOVERY_MARKERS_PER_HANDSHAKE, isMarker),
    unloadedMarkers: isCount,
    trustRecords: arrayOf(TRUST_RECORDS, isTrustRecord),
    savedGit: exact({ bootstrapId: isIdentifier, executablePath: isChannelPath, version: isString, digest: isFingerprint }),
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
}

export function createSession({ writer, runner, fail }: SessionOptions) {
  let sessionId: string | null = null;
  let handshake: Handshake | null = null;
  const seenRequests = new Set<string>();
  const repositories = new Set<string>();
  const log = createSessionLog();

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

  // `undefined`: a later task adds the handler. The request then gets SERVICE_UNAVAILABLE.
  const handlers: Record<ServiceOperation, ((request: RequestEnvelope) => void) | undefined> = {
    getEnvironment: undefined,
    chooseGit: undefined,
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
      return reply({ sessionId });
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
      if (frame.kind === "public") return receivePublic(frame, incoming.body.length);
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
