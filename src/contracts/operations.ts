// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import { CHANNEL_PATH_UNITS, IDENTIFIER_BYTES } from "./limits";
import { NATIVE } from "./native-path";

// Contract §3: the closed list of public operations.
export const OPERATION_NAMES = [
  "getEnvironment",
  "chooseGit",
  "chooseRepository",
  "restoreWorkspace",
  "readWorkspace",
  "readEntries",
  "readHistory",
  "readComparison",
  "readTrust",
  "approveTrust",
  "revokeTrust",
  "applyHunk",
  "applyFile",
  "reviewCommit",
  "commit",
  "reviewSubmodules",
  "updateSubmodules",
  "cancel",
  "getOperation",
  "requestClose",
  "currentSession",
  "dismissRecoveryMarker",
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];
export const OPERATIONS: readonly string[] = OPERATION_NAMES;

export function isOperationName(value: unknown): value is OperationName {
  return typeof value === "string" && OPERATIONS.includes(value);
}

// Contract §2: these operations carry a one-use approval as their repeat key.
const MUTATION_NAMES = ["applyHunk", "applyFile", "commit", "updateSubmodules"] as const;
export const MUTATIONS: readonly OperationName[] = MUTATION_NAMES;
export const MutationKind = z.enum(MUTATION_NAMES);

// Contract §3: the shell answers these natively and never forwards them to the service.
export const SHELL_ONLY: readonly OperationName[] = ["requestClose", "currentSession"];

// Contract §2: UUID-shaped ASCII identifiers.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const Identifier = z.string().max(IDENTIFIER_BYTES).regex(UUID);
export const isIdentifier = (value: unknown): value is string => Identifier.safeParse(value).success;

// Contract §6: `configurationFingerprint`, `fingerprint`, and `digest` are 64 lowercase hex digits.
export const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
export const isFingerprint = (value: unknown): value is string => Fingerprint.safeParse(value).success;

// A nonnegative safe integer.
export const Count = z.int().nonnegative();

// Contract §6 "Process fields": no string holds NUL or a lone surrogate. A Rust `String` cannot hold a lone surrogate.
export const Text = z
  .string()
  .regex(/^[^\u0000]*$/)
  .refine((value) => value.isWellFormed());

// Contract §6 "Channel frames": a native absolute path with 1 to 32,767 UTF-16 units. JSON Schema gets only the rules of every platform.
export const ChannelPath = z
  .string()
  .max(CHANNEL_PATH_UNITS)
  .regex(/^[^\u0000]*$/)
  // zod `max` and JSON Schema `maxLength` count code points. This check counts the UTF-16 units.
  .refine((value) => value.length <= CHANNEL_PATH_UNITS && value.isWellFormed() && NATIVE.isAbsolute(value));
export const isChannelPath = (value: unknown): value is string => ChannelPath.safeParse(value).success;
