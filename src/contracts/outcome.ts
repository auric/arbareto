// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { codeFitsState, type ErrorCode, TERMINAL_STATES, type TerminalState } from "./errors";
import * as limits from "./limits";
import { MUTATIONS } from "./operations";

// Data-model §7 "Operation and outcome". The service issues `operationId` in the accepted event (contract §2). `requestId` correlates a request with exactly one terminal response.

export const OPERATION_STATES = ["accepted", "running", "cancel-requested", "reconciling", ...TERMINAL_STATES] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const ATTRIBUTION_REASONS = ["ambiguous", "evidence-limit", "no-retained-request"] as const;
export const DEADLINE_REASONS = ["inactivity", "ceiling"] as const;

export interface OperationSnapshot {
  operation: string;
  state: string;
  code?: string;
  cause?: string;
  reason?: string;
  stalled?: boolean;
  endProcesses?: boolean;
  lingering?: boolean;
  lingeringDescendants?: number;
  rowId?: string;
}

export type OperationEvent =
  | { type: "valid-read" }
  | { type: "marker-recorded" }
  | { type: "marker-refused"; code: "BUSY" | "RECOVERY_MARKER_FAILED" }
  | { type: "exclusion-unavailable"; code: string }
  | { type: "invalid-approval"; code: string }
  | { type: "cancel" }
  | { type: "read-complete"; result: "succeeded" | "limited" | "failed"; code?: string }
  | { type: "execution-ended"; lingeringDescendants: number }
  | { type: "read-deadline" }
  | { type: "program-confirmation-declined" }
  | { type: "recheck-changed"; code: string }
  | { type: "stall" }
  | { type: "activity" }
  | { type: "row-refused" | "row-read-failed" | "level-read-failed"; rowId: string }
  | { type: "update-process-deadline"; reason: string }
  | { type: "mutation-deadline" }
  | { type: "processes-stopped"; lingeringDescendants?: number }
  | { type: "cancel-deadline"; lingeringDescendants?: number }
  | { type: "intended-effects-confirmed" }
  // `reason`: only with `OUTPUT_LIMIT`, the name of the reached bound (contract §9).
  | { type: "no-effects"; observed: "canceled" | "failed"; code?: string; reason?: string }
  | { type: "differing-effects" }
  | { type: "failed-with-effects" }
  | { type: "attribution-undetermined"; reason: string }
  | { type: "reconciliation-read-deadline" }
  // A reconciliation read failed with `code` before its deadline. `code` goes to the session log, not to the outcome (contract §8).
  | { type: "reconciliation-read-failed"; code: ErrorCode }
  // Contract §5 "Deadline outcomes": the `started` reply carried `deadline`, so no marker exists.
  | { type: "started-deadline" }
  | { type: "interrupt-and-close" }
  | { type: "revoke-trust"; endedProcesses?: number };

// The caller adds `operation` to a result to form the next snapshot.
export interface TransitionResult extends Omit<OperationSnapshot, "operation"> {
  actions: string[];
  // True only when this step enters a terminal state.
  terminalResponse: boolean;
  endedProcesses?: number;
  rowResult?: "refused" | "failed" | "nested-failed";
}

const ROW_RESULTS = { "row-refused": "refused", "row-read-failed": "failed", "level-read-failed": "nested-failed" } as const;

const isTerminal = (state: string): state is TerminalState => (TERMINAL_STATES as readonly string[]).includes(state);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function noRow(snapshot: OperationSnapshot, event: { type: string }): never {
  throw new Error(`no data-model §7 transition for ${snapshot.operation} in ${snapshot.state} on ${event.type}`);
}

export function transition(snapshot: OperationSnapshot, event: OperationEvent): TransitionResult {
  const mutation = (MUTATIONS as readonly string[]).includes(snapshot.operation);
  const submodules = snapshot.operation === "updateSubmodules";
  // Feature 003 contract Δ2: `sync` and `clone` events carry `stalled`. Feature 004 plan.md D2: so do `runWorkbench` events.
  const stallTracked = snapshot.operation === "commit" || submodules || snapshot.operation === "sync" || snapshot.operation === "clone" || snapshot.operation === "runWorkbench";
  const ended = snapshot.endProcesses === true;

  const next = (state: OperationState, fields: Partial<TransitionResult> = {}, actions: string[] = []): TransitionResult => {
    const { cause, reason, endProcesses, lingeringDescendants, lingering } = snapshot;
    const result: TransitionResult = {
      state,
      cause,
      reason,
      endProcesses,
      lingeringDescendants,
      lingering,
      ...(state === "running" ? { stalled: snapshot.stalled } : {}),
      ...fields,
      actions,
      terminalResponse: isTerminal(state) && !isTerminal(snapshot.state),
    };
    if (isTerminal(state) && result.terminalResponse && !codeFitsState(state, result.code)) {
      throw new Error(`code ${String(result.code)} does not fit terminal state ${state}`);
    }
    return result;
  };

  switch (snapshot.state) {
    case "accepted":
      if (event.type === "valid-read" && !mutation) return next("running");
      if (event.type === "marker-recorded" && mutation) return next("running");
      if (event.type === "marker-refused" && mutation && (event.code === "BUSY" || event.code === "RECOVERY_MARKER_FAILED")) {
        return next("rejected", { code: event.code }, ["release-exclusion", "start-no-process"]);
      }
      if (event.type === "exclusion-unavailable" && mutation) return next("rejected", { code: event.code }, ["no-queue", "start-no-process"]);
      if (event.type === "invalid-approval" && event.code !== "RECOVERY_MARKER_FAILED") return next("rejected", { code: event.code }, ["start-no-process"]);
      if (event.type === "started-deadline" && mutation) return next("failed", { code: "DEADLINE", cause: "DEADLINE", reason: "deadline" }, ["close-job"]);
      break;

    case "running":
      switch (event.type) {
        case "cancel":
          return next("cancel-requested", {}, ["signal-owned-processes"]);
        case "read-complete":
          if (mutation) break;
          return next(event.result, { code: event.code }, ["check-generation"]);
        case "execution-ended":
          if (!mutation) break;
          if (!isCount(event.lingeringDescendants)) throw new Error("lingeringDescendants must be a non-negative safe integer");
          return next("reconciling", { lingeringDescendants: ended ? 0 : event.lingeringDescendants }, ["block-mutations"]);
        case "read-deadline":
          if (mutation) break;
          return next("failed", { code: "DEADLINE" }, ["close-job", "refresh-state"]);
        case "program-confirmation-declined":
          if (!submodules) break;
          return next("canceled", { code: "CANCELED" }, ["start-no-process", "resolve-marker"]);
        case "recheck-changed":
          if (!submodules || (event.code !== "STALE_REVIEW" && event.code !== "TRUST_CHANGED")) break;
          return next("failed", { code: event.code }, ["keep-token-consumed", "start-no-process", "no-reconciliation", "resolve-marker"]);
        case "stall":
          if (!stallTracked) break;
          return next("running", { stalled: true }, ["show-stall-notice"]);
        case "activity":
          if (!stallTracked) break;
          return next("running", { stalled: false }, ["clear-stall-notice"]);
        case "row-refused":
        case "row-read-failed":
        case "level-read-failed":
          if (!submodules) break;
          return next("running", { rowId: event.rowId, rowResult: ROW_RESULTS[event.type] }, ["start-no-process-for-row-and-nested"]);
        case "update-process-deadline":
          if (!submodules || !(DEADLINE_REASONS as readonly string[]).includes(event.reason)) break;
          return next("reconciling", { cause: "DEADLINE", reason: event.reason, lingeringDescendants: 0 }, ["close-job", "start-no-later-process"]);
        case "mutation-deadline":
          if (!mutation) break;
          return next("reconciling", { cause: "DEADLINE", reason: "deadline", lingeringDescendants: 0 }, submodules ? ["close-job", "start-no-later-process"] : ["close-job"]);
        case "revoke-trust":
          if (!mutation) break;
          return next("running", { endProcesses: true });
      }
      break;

    case "cancel-requested":
      if (event.type === "revoke-trust" && mutation) return next("cancel-requested", { endProcesses: true });
      if (mutation && (event.type === "processes-stopped" || event.type === "cancel-deadline")) {
        const count = ended ? 0 : (event.lingeringDescendants ?? snapshot.lingeringDescendants);
        if (count !== undefined && !isCount(count)) throw new Error("lingeringDescendants must be a non-negative safe integer");
        // Contract §5 "Deadline outcomes": a later `canceled` keeps the deadline reason.
        return next("reconciling", { lingeringDescendants: count, ...(event.type === "cancel-deadline" ? { cause: "DEADLINE", reason: "deadline" } : {}) });
      }
      if (!mutation && event.type === "processes-stopped") return next("canceled", { code: "CANCELED" }, ["refresh-state"]);
      if (!mutation && event.type === "read-deadline") return next("failed", { code: "DEADLINE" }, ["close-job", "refresh-state"]);
      break;

    case "reconciling":
      if (!mutation) break;
      switch (event.type) {
        case "intended-effects-confirmed":
          return next("succeeded", { cause: undefined, reason: undefined });
        case "no-effects":
          if (event.reason !== undefined && (event.observed !== "failed" || event.code !== "OUTPUT_LIMIT" || !Object.hasOwn(limits, event.reason))) break;
          if (event.observed === "canceled") return next("canceled", { code: "CANCELED" });
          return next("failed", { code: event.code ?? snapshot.cause, ...(event.reason === undefined ? {} : { reason: event.reason }) });
        case "differing-effects":
          return next("completed-with-effects", { code: "COMPLETED_WITH_EFFECTS" }, [
            "identify-grounded-results",
            "preserve-draft",
            "require-fresh-review",
          ]);
        case "failed-with-effects":
          return next("failed-with-effects", { code: "FAILED_WITH_EFFECTS" }, ["report-actual-state", "preserve-draft"]);
        case "attribution-undetermined":
          if (!(ATTRIBUTION_REASONS as readonly string[]).includes(event.reason)) break;
          return next("unknown", { code: "STATE_UNKNOWN", reason: event.reason }, ["block-mutations", "keep-marker"]);
        case "cancel":
          return next("reconciling", { endProcesses: true, lingeringDescendants: 0 }, ["continue-reconciliation-reads"]);
        case "reconciliation-read-deadline":
          return next("unknown", { code: "STATE_UNKNOWN" }, ["close-job", "block-mutations", "keep-marker"]);
        case "reconciliation-read-failed":
          return next("unknown", { code: "STATE_UNKNOWN" }, ["block-mutations", "keep-marker"]);
        case "interrupt-and-close":
          return next("reconciling", {}, ["close-job", "keep-marker", "follow-application-close"]);
        case "revoke-trust":
          return next("reconciling", { endProcesses: true, lingeringDescendants: 0 });
      }
      break;

    default:
      if (isTerminal(snapshot.state) && mutation && snapshot.lingering === true && event.type === "revoke-trust") {
        if (!isCount(event.endedProcesses)) throw new Error("endedProcesses must be a non-negative safe integer");
        return next(snapshot.state, { code: snapshot.code, lingering: false, endedProcesses: event.endedProcesses }, ["close-lingering-job"]);
      }
  }
  return noRow(snapshot, event);
}

export type WorkspaceState = "none" | "unknown" | "ready";

export type WorkspaceEvent =
  | { type: "read"; refresh: boolean; observation: string; priorOutcome?: { state: string; reason?: string } | null }
  | { type: "registration"; marker: boolean; retainedRequest: boolean; restarted: boolean };

export interface WorkspaceResult {
  state: WorkspaceState;
  reason?: string;
  priorOutcome?: { state: string; reason?: string } | null;
  actions: string[];
}

const OBSERVATIONS = ["complete", "failed", "limited"];

// Data-model §7 rows for the `unknown` gate. Other workspace states have no row in that table.
export function workspaceTransition(state: WorkspaceState, event: WorkspaceEvent): WorkspaceResult {
  if (state === "unknown" && event.type === "read" && OBSERVATIONS.includes(event.observation)) {
    if (event.refresh && event.observation === "complete") {
      return { state: "ready", priorOutcome: event.priorOutcome ?? null, actions: ["resolve-marker", "invalidate-prior-tokens"] };
    }
    return { state: "unknown", actions: ["block-mutations", "keep-marker"] };
  }
  if (state === "none" && event.type === "registration") {
    if (event.marker) {
      return { state: "unknown", ...(event.retainedRequest ? {} : { reason: "no-retained-request" }), actions: ["block-mutations"] };
    }
    if (event.restarted) return { state: "unknown", actions: ["block-mutations"] };
  }
  throw new Error(`no data-model §7 transition for workspace ${state} on ${event.type}`);
}
