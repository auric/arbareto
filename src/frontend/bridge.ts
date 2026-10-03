// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { RequestEnvelope } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import type { OperationName } from "../contracts/operations";
import type { OperationState } from "../contracts/outcome";

export type BridgeResponse = {
  requestId: string | null;
  operationId?: string;
  state: OperationState;
  code?: ErrorCode;
  result?: unknown;
};

// Contract §2 progress event. The shell checks its fields.
export type ProgressEvent = {
  requestId: string;
  operationId: string;
  state: "accepted" | "running" | "cancel-requested" | "reconciling";
  phase?: string;
  counters: Record<string, number>;
  stalled?: boolean;
};
export type OnProgress = (event: ProgressEvent) => void;

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type Listen = (event: string, handler: (event: { payload: unknown }) => void) => Promise<unknown>;

type Repository = { repositoryId: string };
type ReadTarget = Repository & { repositoryGeneration?: number };
type Snapshot = Repository & { repositoryGeneration: number };
type Target = Partial<Snapshot> & { selectionId?: string };
type Direction = "stage" | "unstage";

// `onSessionChange` runs after a `service-session` event, when the bridge holds the new session.
export function createBridge(invoke: Invoke, listen: Listen, onSessionChange?: () => void) {
  const pending = new Map<string, { resolve: (response: BridgeResponse) => void; onProgress?: OnProgress; operationId?: string }>();

  function send(operation: OperationName, envelope: Omit<RequestEnvelope, "version" | "requestId" | "operation">, onProgress?: OnProgress): Promise<BridgeResponse> {
    const requestId = crypto.randomUUID();
    const request: RequestEnvelope = { version: 1, ...envelope, requestId, operation };
    return new Promise((resolve) => {
      pending.set(requestId, { resolve, onProgress });
      // Contract §9: a shell that cannot take the request gives `SERVICE_UNAVAILABLE`, which is always `rejected`.
      invoke(command(operation), { request }).then(
        (response) => settle(requestId, response as BridgeResponse),
        () => settle(requestId, { requestId, state: "rejected", code: "SERVICE_UNAVAILABLE" }),
      );
    });
  }

  function settle(requestId: string, response: BridgeResponse) {
    const waiting = pending.get(requestId);
    pending.delete(requestId);
    // Contract §2: a response carries the issued `operationId`. A shell or bridge response cannot know it.
    const operationId = response.operationId ?? waiting?.operationId;
    waiting?.resolve(operationId === undefined ? response : { ...response, operationId });
  }

  const readSession = () =>
    send("currentSession", { payload: {} }).then((response) => {
      const result = response.result as { sessionId?: unknown } | undefined;
      return response.state === "succeeded" && typeof result?.sessionId === "string" ? result.sessionId : undefined;
    });

  // Contract §2: the page calls `currentSession` at load and after each `service-session` event.
  // The subscriptions start before the first `currentSession` call. A failed subscription still lets requests run.
  const subscriptions = [
    listen("service-session", () => {
      session = readSession();
      void session.then(() => onSessionChange?.());
    }),
    // Contract §2: a service exit makes each request without a terminal response State unknown.
    listen("service-stopped", () => {
      for (const requestId of [...pending.keys()]) settle(requestId, { requestId, state: "unknown", code: "STATE_UNKNOWN" });
    }),
    // Contract §2: the bridge routes each progress event by `requestId`. An event without a pending request is dropped.
    listen("operation-progress", ({ payload }) => {
      const event = payload as ProgressEvent | null;
      const waiting = typeof event?.requestId === "string" ? pending.get(event.requestId) : undefined;
      if (!event || !waiting) return;
      waiting.operationId = event.operationId;
      waiting.onProgress?.(event);
    }),
  ];
  for (const subscription of subscriptions) subscription.catch(() => {});
  let session = readSession();

  async function call(operation: OperationName, target: Target, payload: Record<string, unknown>, onProgress?: OnProgress): Promise<BridgeResponse> {
    const sessionId = await session;
    if (sessionId === undefined) return { requestId: null, state: "rejected", code: "SERVICE_UNAVAILABLE" };
    return send(operation, { sessionId, ...target, payload }, onProgress);
  }

  return {
    getEnvironment: (onProgress?: OnProgress) => call("getEnvironment", {}, {}, onProgress),
    chooseGit: (onProgress?: OnProgress) => call("chooseGit", {}, {}, onProgress),
    chooseRepository: (onProgress?: OnProgress) => call("chooseRepository", {}, {}, onProgress),
    restoreWorkspace: (onProgress?: OnProgress) => call("restoreWorkspace", {}, {}, onProgress),
    readWorkspace: (target: ReadTarget, payload: { refresh: boolean; check: "full" | "changes" }, onProgress?: OnProgress) => call("readWorkspace", target, payload, onProgress),
    readHistory: (target: Snapshot, onProgress?: OnProgress) => call("readHistory", target, {}, onProgress),
    readComparison: (target: Snapshot & { selectionId: string }, payload: { snapshotId: string; entryId: string }, onProgress?: OnProgress) =>
      call("readComparison", target, payload, onProgress),
    readTrust: (target: Repository, onProgress?: OnProgress) => call("readTrust", target, {}, onProgress),
    approveTrust: (target: Snapshot, payload: { fingerprint: string; approve: true }, onProgress?: OnProgress) => call("approveTrust", target, payload, onProgress),
    revokeTrust: (target: Repository, payload: { trustId: string }, onProgress?: OnProgress) => call("revokeTrust", target, payload, onProgress),
    applyHunk: (target: Snapshot, payload: { comparisonId: string; hunkId: string; snapshotId: string; direction: Direction }, onProgress?: OnProgress) =>
      call("applyHunk", target, payload, onProgress),
    applyFile: (target: Snapshot, payload: { comparisonId: string; snapshotId: string; direction: Direction }, onProgress?: OnProgress) =>
      call("applyFile", target, payload, onProgress),
    reviewCommit: (target: Snapshot, payload: { snapshotId: string }, onProgress?: OnProgress) => call("reviewCommit", target, payload, onProgress),
    commit: (target: Snapshot, payload: { reviewToken: string; message: string; confirmFullScope: true }, onProgress?: OnProgress) =>
      call("commit", target, payload, onProgress),
    reviewSubmodules: (target: Snapshot, payload: { snapshotId: string }, onProgress?: OnProgress) => call("reviewSubmodules", target, payload, onProgress),
    updateSubmodules: (target: Snapshot, payload: { submoduleReviewToken: string; start: true }, onProgress?: OnProgress) =>
      call("updateSubmodules", target, payload, onProgress),
    cancel: (payload: { operationId: string }, onProgress?: OnProgress) => call("cancel", {}, payload, onProgress),
    getOperation: (payload: { operationId: string }, onProgress?: OnProgress) => call("getOperation", {}, payload, onProgress),
    requestClose: (payload: { choice: "stay" | "closeIfIdle" | "interruptAndClose" }, onProgress?: OnProgress) => call("requestClose", {}, payload, onProgress),
    currentSession: (onProgress?: OnProgress) => send("currentSession", { payload: {} }, onProgress),
    dismissRecoveryMarker: (payload: { markerId: string }, onProgress?: OnProgress) => call("dismissRecoveryMarker", {}, payload, onProgress),
  };
}

// Tauri invokes a command by its Rust function name in `src-tauri/build.rs`.
const command = (operation: OperationName) => operation.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
