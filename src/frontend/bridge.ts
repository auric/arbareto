// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// Type-only imports keep zod out of the renderer bundle.
import type { ProgressEvent, RequestOf, Response } from "../contracts/envelope";
import type { OperationName } from "../contracts/operations";

export type BridgeResponse = Response;
export type { ProgressEvent };
export type OnProgress = (event: ProgressEvent) => void;

// The envelope fields that a caller supplies: the repository target and the payload (contract §2).
type Target<K extends OperationName> = Omit<RequestOf<K>, "version" | "sessionId" | "requestId" | "operation" | "payload">;
type Payload<K extends OperationName> = RequestOf<K>["payload"];

const encoder = new TextEncoder();

// `onSessionChange` runs after a `service-session` event, when the bridge holds the new session.
// `onTextScale` gets the payload of each `text-scale` event.
export function createBridge(onSessionChange?: () => void, onTextScale?: (value: unknown) => void) {
  const pending = new Map<string, { resolve: (response: BridgeResponse) => void; onProgress?: OnProgress; operationId?: string }>();

  function send(operation: OperationName, envelope: Record<string, unknown>, onProgress?: OnProgress): Promise<BridgeResponse> {
    const requestId = crypto.randomUUID();
    const request = { version: 1, ...envelope, requestId, operation };
    return new Promise((resolve) => {
      pending.set(requestId, { resolve, onProgress });
      // Contract §1 "Renderer request body": the raw UTF-8 JSON bytes, never a JSON invoke body.
      // Contract §9: a shell that cannot take the request gives `SERVICE_UNAVAILABLE`, which is always `rejected`.
      invoke(command(operation), encoder.encode(JSON.stringify(request))).then(
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
    listen<ProgressEvent | null>("operation-progress", ({ payload: event }) => {
      const waiting = typeof event?.requestId === "string" ? pending.get(event.requestId) : undefined;
      if (!event || !waiting) return;
      waiting.operationId = event.operationId;
      waiting.onProgress?.(event);
    }),
    // Contract §2: the Windows text scale factor after each `TextScaleFactorChanged` event.
    listen<unknown>("text-scale", ({ payload }) => onTextScale?.(payload)),
  ];
  for (const subscription of subscriptions) subscription.catch(() => {});
  let session = readSession();

  async function call<K extends OperationName>(operation: K, target: Target<K>, payload: Payload<K>, onProgress?: OnProgress): Promise<BridgeResponse> {
    const sessionId = await session;
    if (sessionId === undefined) return { requestId: null, state: "rejected", code: "SERVICE_UNAVAILABLE" };
    return send(operation, { sessionId, ...target, payload }, onProgress);
  }

  return {
    getEnvironment: (onProgress?: OnProgress) => call("getEnvironment", {}, {}, onProgress),
    chooseGit: (onProgress?: OnProgress) => call("chooseGit", {}, {}, onProgress),
    chooseRepository: (onProgress?: OnProgress) => call("chooseRepository", {}, {}, onProgress),
    restoreWorkspace: (onProgress?: OnProgress) => call("restoreWorkspace", {}, {}, onProgress),
    readWorkspace: (target: Target<"readWorkspace">, payload: Payload<"readWorkspace">, onProgress?: OnProgress) => call("readWorkspace", target, payload, onProgress),
    readEntries: (target: Target<"readEntries">, payload: Payload<"readEntries">, onProgress?: OnProgress) => call("readEntries", target, payload, onProgress),
    readHistory: (target: Target<"readHistory">, onProgress?: OnProgress) => call("readHistory", target, {}, onProgress),
    readComparison: (target: Target<"readComparison">, payload: Payload<"readComparison">, onProgress?: OnProgress) =>
      call("readComparison", target, payload, onProgress),
    readTrust: (target: Target<"readTrust">, onProgress?: OnProgress) => call("readTrust", target, {}, onProgress),
    approveTrust: (target: Target<"approveTrust">, payload: Payload<"approveTrust">, onProgress?: OnProgress) => call("approveTrust", target, payload, onProgress),
    revokeTrust: (target: Target<"revokeTrust">, payload: Payload<"revokeTrust">, onProgress?: OnProgress) => call("revokeTrust", target, payload, onProgress),
    applyHunk: (target: Target<"applyHunk">, payload: Payload<"applyHunk">, onProgress?: OnProgress) => call("applyHunk", target, payload, onProgress),
    applyFile: (target: Target<"applyFile">, payload: Payload<"applyFile">, onProgress?: OnProgress) => call("applyFile", target, payload, onProgress),
    reviewCommit: (target: Target<"reviewCommit">, payload: Payload<"reviewCommit">, onProgress?: OnProgress) => call("reviewCommit", target, payload, onProgress),
    commit: (target: Target<"commit">, payload: Payload<"commit">, onProgress?: OnProgress) => call("commit", target, payload, onProgress),
    reviewSubmodules: (target: Target<"reviewSubmodules">, payload: Payload<"reviewSubmodules">, onProgress?: OnProgress) =>
      call("reviewSubmodules", target, payload, onProgress),
    updateSubmodules: (target: Target<"updateSubmodules">, payload: Payload<"updateSubmodules">, onProgress?: OnProgress) =>
      call("updateSubmodules", target, payload, onProgress),
    cancel: (payload: Payload<"cancel">, onProgress?: OnProgress) => call("cancel", {}, payload, onProgress),
    getOperation: (payload: Payload<"getOperation">, onProgress?: OnProgress) => call("getOperation", {}, payload, onProgress),
    requestClose: (payload: Payload<"requestClose">, onProgress?: OnProgress) => call("requestClose", {}, payload, onProgress),
    // Contract §3: both `currentSession` results carry `textScale`.
    currentSession: (onProgress?: OnProgress) => send("currentSession", { payload: {} }, onProgress),
    dismissRecoveryMarker: (payload: Payload<"dismissRecoveryMarker">, onProgress?: OnProgress) => call("dismissRecoveryMarker", {}, payload, onProgress),
  };
}

// Tauri invokes a command by its Rust function name in `src-tauri/build.rs`.
const command = (operation: OperationName) => operation.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
