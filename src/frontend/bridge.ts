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

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type Listen = (event: string, handler: (event: { payload: unknown }) => void) => Promise<unknown>;

type Repository = { repositoryId: string };
type ReadTarget = Repository & { repositoryGeneration?: number };
type Snapshot = Repository & { repositoryGeneration: number };
type Target = Partial<Snapshot> & { selectionId?: string };
type Direction = "stage" | "unstage";

export function createBridge(invoke: Invoke, listen: Listen) {
  const pending = new Map<string, (response: BridgeResponse) => void>();

  function send(operation: OperationName, envelope: Omit<RequestEnvelope, "version" | "requestId" | "operation">): Promise<BridgeResponse> {
    const requestId = crypto.randomUUID();
    const request: RequestEnvelope = { version: 1, ...envelope, requestId, operation };
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      // Contract §9: a shell that cannot take the request gives `SERVICE_UNAVAILABLE`, which is always `rejected`.
      invoke(command(operation), { request }).then(
        (response) => settle(requestId, response as BridgeResponse),
        () => settle(requestId, { requestId, state: "rejected", code: "SERVICE_UNAVAILABLE" }),
      );
    });
  }

  function settle(requestId: string, response: BridgeResponse) {
    const resolve = pending.get(requestId);
    pending.delete(requestId);
    resolve?.(response);
  }

  const readSession = () =>
    send("currentSession", { payload: {} }).then((response) => {
      const result = response.result as { sessionId?: unknown } | undefined;
      return response.state === "succeeded" && typeof result?.sessionId === "string" ? result.sessionId : undefined;
    });

  let session = readSession();

  async function call(operation: OperationName, target: Target, payload: Record<string, unknown>): Promise<BridgeResponse> {
    const sessionId = await session;
    if (sessionId === undefined) return { requestId: null, state: "rejected", code: "SERVICE_UNAVAILABLE" };
    return send(operation, { sessionId, ...target, payload });
  }

  // Contract §2: the page calls `currentSession` at load and after each `service-session` event.
  listen("service-session", () => {
    session = readSession();
  });
  // Contract §2: a service exit makes each request without a terminal response State unknown.
  listen("service-stopped", () => {
    for (const requestId of [...pending.keys()]) settle(requestId, { requestId, state: "unknown", code: "STATE_UNKNOWN" });
  });

  return {
    getEnvironment: () => call("getEnvironment", {}, {}),
    chooseGit: () => call("chooseGit", {}, {}),
    chooseRepository: () => call("chooseRepository", {}, {}),
    restoreWorkspace: () => call("restoreWorkspace", {}, {}),
    readWorkspace: (target: ReadTarget, payload: { refresh: boolean; check: "full" | "changes" }) => call("readWorkspace", target, payload),
    readHistory: (target: Snapshot) => call("readHistory", target, {}),
    readComparison: (target: Snapshot & { selectionId: string }, payload: { snapshotId: string; entryId: string }) => call("readComparison", target, payload),
    readTrust: (target: Repository) => call("readTrust", target, {}),
    approveTrust: (target: Snapshot, payload: { fingerprint: string; approve: true }) => call("approveTrust", target, payload),
    revokeTrust: (target: Repository, payload: { trustId: string }) => call("revokeTrust", target, payload),
    applyHunk: (target: Snapshot, payload: { comparisonId: string; hunkId: string; snapshotId: string; direction: Direction }) => call("applyHunk", target, payload),
    applyFile: (target: Snapshot, payload: { comparisonId: string; snapshotId: string; direction: Direction }) => call("applyFile", target, payload),
    reviewCommit: (target: Snapshot, payload: { snapshotId: string }) => call("reviewCommit", target, payload),
    commit: (target: Snapshot, payload: { reviewToken: string; message: string; confirmFullScope: true }) => call("commit", target, payload),
    reviewSubmodules: (target: Snapshot, payload: { snapshotId: string }) => call("reviewSubmodules", target, payload),
    updateSubmodules: (target: Snapshot, payload: { submoduleReviewToken: string; start: true }) => call("updateSubmodules", target, payload),
    cancel: (payload: { operationId: string }) => call("cancel", {}, payload),
    getOperation: (payload: { operationId: string }) => call("getOperation", {}, payload),
    requestClose: (payload: { choice: "stay" | "closeIfIdle" | "interruptAndClose" }) => call("requestClose", {}, payload),
    currentSession: () => send("currentSession", { payload: {} }),
    dismissRecoveryMarker: (payload: { markerId: string }) => call("dismissRecoveryMarker", {}, payload),
  };
}

// Tauri invokes a command by its Rust function name in `src-tauri/build.rs`.
const command = (operation: OperationName) => operation.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
