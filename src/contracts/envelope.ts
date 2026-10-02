// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { PUBLIC_REQUEST_BYTES } from "./limits";
import {
  GENERATION_OPTIONAL,
  GENERATION_REQUIRED,
  isIdentifier,
  isOperationName,
  PAYLOAD_VALIDATORS,
  REPOSITORY_BOUND,
  SELECTION_REQUIRED,
  SESSIONLESS,
  SHELL_ONLY,
  type OperationName,
} from "./operations";
import { decodeStrictJson } from "./strict-json";

export type Side = "renderer" | "service";

export interface RequestEnvelope {
  version: 1;
  sessionId?: string;
  requestId: string;
  operation: string;
  repositoryId?: string;
  repositoryGeneration?: number;
  selectionId?: string;
  payload: Record<string, unknown>;
}

export type RequestResult = { ok: true; request: RequestEnvelope } | { ok: false; code: string };

const FIELDS = ["version", "sessionId", "requestId", "operation", "repositoryId", "repositoryGeneration", "selectionId", "payload"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function decodeRequest(bytes: Uint8Array, side: Side): RequestResult {
  if (bytes.length > PUBLIC_REQUEST_BYTES) return { ok: false, code: "FRAME_LIMIT" };
  const decoded = decodeStrictJson(bytes);
  if (!decoded.ok) return decoded;
  return validateRequest(decoded.value, side);
}

export function validateRequest(value: unknown, side: Side): RequestResult {
  const invalid = { ok: false, code: "INVALID_REQUEST" } as const;
  if (!isObject(value) || !Object.hasOwn(value, "version")) return invalid;
  if (value.version !== 1) return { ok: false, code: "PROTOCOL_VERSION" };
  const operation = value.operation;
  if (typeof operation !== "string") return invalid;
  if (!isOperationName(operation) || (side === "service" && SHELL_ONLY.includes(operation))) {
    return { ok: false, code: "UNKNOWN_OPERATION" };
  }
  if (Object.keys(value).some((key) => !FIELDS.includes(key))) return invalid;

  const has = (key: string) => Object.hasOwn(value, key);
  if (!isIdentifier(value.requestId)) return invalid;
  if (!presence(has("sessionId"), SESSIONLESS.includes(operation) ? "absent" : "required")) return invalid;
  if (has("sessionId") && !isIdentifier(value.sessionId)) return invalid;
  if (!presence(has("repositoryId"), REPOSITORY_BOUND.includes(operation) ? "required" : "absent")) return invalid;
  if (has("repositoryId") && !isIdentifier(value.repositoryId)) return invalid;
  const generation = GENERATION_REQUIRED.includes(operation) ? "required" : GENERATION_OPTIONAL.includes(operation) ? "optional" : "absent";
  if (!presence(has("repositoryGeneration"), generation)) return invalid;
  if (has("repositoryGeneration")) {
    const g = value.repositoryGeneration;
    if (typeof g !== "number" || !Number.isSafeInteger(g) || g < 0) return invalid;
  }
  if (!presence(has("selectionId"), SELECTION_REQUIRED.includes(operation) ? "required" : "absent")) return invalid;
  if (has("selectionId") && !isIdentifier(value.selectionId)) return invalid;
  if (!isObject(value.payload) || !PAYLOAD_VALIDATORS[operation][side](value.payload)) return invalid;

  return { ok: true, request: value as unknown as RequestEnvelope };
}

function presence(present: boolean, rule: "required" | "optional" | "absent"): boolean {
  return rule === "optional" || present === (rule === "required");
}
