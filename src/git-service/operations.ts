// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { TERMINAL_STATES, type ErrorCode } from "../contracts/errors";
import { FINISHED_OPERATION_RECORDS } from "../contracts/limits";
import { MUTATIONS, type OperationName } from "../contracts/operations";
import { transition, type OperationEvent, type OperationSnapshot, type TransitionResult } from "../contracts/outcome";
import type { GitRunner } from "./git-runner";
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
  // The shell replied to `started` with a marker ID.
  marker: boolean;
}

const isCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTerminal = (state: string) => (TERMINAL_STATES as readonly string[]).includes(state);

export function createOperationRegistry(
  respond: (response: Response) => void,
  progress: (event: ProgressEvent) => void,
  log: SessionLog,
  runner: Pick<GitRunner, "closeJob" | "ended">,
) {
  const entries = new Map<string, Entry>();
  // Contract §5 "Finished operation records": the terminal records that a new terminal record can remove, oldest first.
  const finished = new Set<string>();

  function retire(operationId: string, view: OperationView): void {
    // Contract §2 and §5: a mutation record that consumed its approval stays. Such a mutation passed `marker-recorded`, so it ends in any terminal state except `rejected`.
    if ((MUTATIONS as readonly string[]).includes(view.operation) && view.state !== "rejected") return;
    finished.add(operationId);
    if (finished.size <= FINISHED_OPERATION_RECORDS) return;
    const [oldest] = finished;
    finished.delete(oldest);
    entries.delete(oldest);
  }

  const entry = (operationId: string): Entry => {
    const found = entries.get(operationId);
    if (!found) throw new Error("operation not issued");
    return found;
  };

  return {
    start(operation: OperationName, requestId: string): { operationId: string; signal: AbortSignal } {
      const operationId = crypto.randomUUID();
      const controller = new AbortController();
      entries.set(operationId, { view: { operationId, operation, state: "accepted" }, requestId, startedAt: performance.now(), controller, marker: false });
      progress({ requestId, operationId, state: "accepted", counters: {} });
      return { operationId, signal: controller.signal };
    },

    // `result` goes into the terminal response only.
    apply(operationId: string, event: OperationEvent, result?: unknown): TransitionResult {
      const e = entry(operationId);
      const next = transition(e.view, event);
      const { actions, terminalResponse, endedProcesses, rowResult, ...fields } = next;
      e.view = { ...fields, operationId, operation: e.view.operation, phase: e.view.phase };
      if (event.type === "marker-recorded") e.marker = true;
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
        // Contract §6: `ended` follows the terminal response of a mutation with a marker. Every other operation gets `closeJob`.
        if (e.marker) runner.ended(operationId, e.view.endProcesses === true);
        else runner.closeJob(operationId);
        retire(operationId, e.view);
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
