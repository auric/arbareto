// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { isErrorCode, type ErrorCode } from "../contracts/errors";
import { SESSION_LOG_ENTRIES } from "../contracts/limits";
import { isIdentifier, isOperationName, type OperationName } from "../contracts/operations";

// Contract §7: the log holds only allowlisted operation kinds, internal IDs, durations, safe codes, diagnostic causes, counts, and reconciled effect summaries. It stays in memory and writes no file.

export interface EffectSummary {
  head: boolean;
  index: boolean;
  workingFiles: boolean;
  operationState: boolean;
}

// Contract §9: the causes of a failed hunk or file step.
export const STEP_CAUSES = ["lock-create", "candidate-copy", "candidate-time", "publish-time", "verification", "write", "replace"] as const;
// A step cause, or the code of a failed reconciliation observation (contract §8).
export type DiagnosticCause = (typeof STEP_CAUSES)[number] | ErrorCode;

export interface LogEntry {
  kind: OperationName;
  operationId?: string;
  durationMs?: number;
  code?: ErrorCode;
  cause?: DiagnosticCause;
  count?: number;
  effects?: EffectSummary;
}

const isCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const EFFECT_FIELDS = ["head", "index", "workingFiles", "operationState"];

function isEffectSummary(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === EFFECT_FIELDS.length && keys.every((k) => EFFECT_FIELDS.includes(k) && typeof (value as Record<string, unknown>)[k] === "boolean");
}

const FIELD_CHECKS: Record<string, (value: unknown) => boolean> = {
  kind: isOperationName,
  operationId: isIdentifier,
  durationMs: isCount,
  code: isErrorCode,
  cause: (value) => (STEP_CAUSES as readonly unknown[]).includes(value) || isErrorCode(value),
  count: isCount,
  effects: isEffectSummary,
};

export function createSessionLog() {
  const entries: LogEntry[] = [];
  return {
    // A refused entry throws without its content, so no field name or value reaches the error text.
    record(entry: LogEntry): void {
      const source = entry as unknown as Record<string, unknown>;
      const keys = Object.keys(source);
      if (!keys.includes("kind") || keys.some((k) => !Object.hasOwn(FIELD_CHECKS, k) || !FIELD_CHECKS[k](source[k]))) {
        throw new TypeError("session log entry refused");
      }
      const copy: Record<string, unknown> = {};
      for (const k of keys) copy[k] = k === "effects" ? Object.freeze({ ...(source[k] as EffectSummary) }) : source[k];
      entries.push(Object.freeze(copy) as unknown as LogEntry);
      // Contract §5 "Session log entries".
      if (entries.length > SESSION_LOG_ENTRIES) entries.shift();
    },
    entries(): readonly LogEntry[] {
      return [...entries];
    },
  };
}

export type SessionLog = ReturnType<typeof createSessionLog>;
