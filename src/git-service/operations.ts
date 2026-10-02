// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { TERMINAL_STATES, type ErrorCode } from "../contracts/errors";
import type { OperationName } from "../contracts/operations";
import { transition, type OperationEvent, type OperationSnapshot, type TransitionResult } from "../contracts/outcome";
import type { SessionLog } from "./log";

// Data-model §7 `phase`.
export const PHASES = [
  "wsl-starting",
  "preflight",
  "candidate-verification",
  "publication",
  "commit-handoff",
  "submodule-confirmation",
  "fetch",
  "update",
  "reconciliation",
] as const;
export type Phase = (typeof PHASES)[number];

// Contract §2: exactly these fields. A progress event holds no command, configuration, environment, patch content, Git text, or credential.
export interface ProgressEvent {
  requestId: string;
  operationId: string;
  state: "accepted" | "running" | "cancel-requested" | "reconciling";
  phase?: Phase;
  counters: Record<string, number>;
  stalled?: boolean;
}

export interface OperationView extends OperationSnapshot {
  operationId: string;
  phase?: Phase;
}

export interface Response {
  requestId: string | null;
  operationId?: string;
  state: string;
  code?: ErrorCode;
  result?: unknown;
}

interface Entry {
  view: OperationView;
  requestId: string;
  startedAt: number;
  controller: AbortController;
}

const isCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTerminal = (state: string) => (TERMINAL_STATES as readonly string[]).includes(state);

export function createOperationRegistry(respond: (response: Response) => void, progress: (event: ProgressEvent) => void, log: SessionLog) {
  const entries = new Map<string, Entry>();

  const entry = (operationId: string): Entry => {
    const found = entries.get(operationId);
    if (!found) throw new Error("operation not issued");
    return found;
  };

  return {
    start(operation: OperationName, requestId: string): { operationId: string; signal: AbortSignal } {
      const operationId = crypto.randomUUID();
      const controller = new AbortController();
      entries.set(operationId, { view: { operationId, operation, state: "accepted" }, requestId, startedAt: performance.now(), controller });
      progress({ requestId, operationId, state: "accepted", counters: {} });
      return { operationId, signal: controller.signal };
    },

    // `result` goes into the terminal response only.
    apply(operationId: string, event: OperationEvent, result?: unknown): TransitionResult {
      const e = entry(operationId);
      const next = transition(e.view, event);
      const { actions, terminalResponse, endedProcesses, rowResult, ...fields } = next;
      e.view = { ...fields, operationId, operation: e.view.operation, phase: e.view.phase };
      if (actions.includes("signal-owned-processes")) e.controller.abort();
      if (terminalResponse) {
        const code = e.view.code as ErrorCode | undefined;
        respond({ requestId: e.requestId, operationId, state: e.view.state, ...(code ? { code } : {}), ...(result === undefined ? {} : { result }) });
        log.record({
          kind: e.view.operation as OperationName,
          operationId,
          durationMs: Math.round(performance.now() - e.startedAt),
          ...(code ? { code } : {}),
        });
      }
      return next;
    },

    progress(operationId: string, phase: Phase, counters: Record<string, number> = {}): void {
      const e = entry(operationId);
      // Contract §2: no progress event follows the terminal response.
      if (isTerminal(e.view.state) || !PHASES.includes(phase) || !Object.values(counters).every(isCount)) throw new TypeError("progress event refused");
      e.view = { ...e.view, phase };
      const state = e.view.state as ProgressEvent["state"];
      progress({ requestId: e.requestId, operationId, state, phase, counters: { ...counters }, ...(e.view.stalled === undefined ? {} : { stalled: e.view.stalled }) });
    },

    get(operationId: string): OperationView | undefined {
      const found = entries.get(operationId);
      return found && { ...found.view };
    },

    // Data-model §7 has a cancel row only for `running` and `reconciling`. Other states stay unchanged.
    cancel(operationId: string): OperationView | undefined {
      const found = entries.get(operationId);
      if (!found) return undefined;
      if (found.view.state === "running" || found.view.state === "reconciling") this.apply(operationId, { type: "cancel" });
      return { ...found.view };
    },
  };
}

export type OperationRegistry = ReturnType<typeof createOperationRegistry>;
