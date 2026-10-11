// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import { CHANNEL_PATH_UNITS, COMMIT_OUTPUT_TAIL_BYTES, COMMIT_OUTPUT_TAIL_LINES, IDENTIFIER_BYTES } from "./limits";
import { NATIVE } from "./native-path";

// Contract §3: the closed list of public operations.
export const OPERATION_NAMES = [
  "getEnvironment",
  "chooseGit",
  "chooseRepository",
  "restoreWorkspace",
  "listRecentRepositories",
  "openRecentRepository",
  "removeRecentRepository",
  "readWorkspace",
  "readEntries",
  "readHistory",
  "readRefs",
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
// The shell forwards `openRecentRepository` as `restoreWorkspace`, so the service never gets that name.
export const SHELL_ONLY: readonly OperationName[] = ["requestClose", "currentSession", "listRecentRepositories", "openRecentRepository", "removeRecentRepository"];

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
export const Phase = z.enum(PHASES);
export type Phase = z.infer<typeof Phase>;

// Contract §11 "Distro checks": a name that `wsl.exe --list --quiet` prints holds no control character.
export const DistroName = z.string().min(1).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/);

// Contract §3 `applyHunk` and `applyFile`.
export const Direction = z.enum(["stage", "unstage"]);

// Contract §2: exactly these fields. A progress event holds no command, configuration, environment, patch content, Git text, or credential.
// The fields without `distro`. Only phase `wsl-starting` carries `distro`.
export const ProgressFields = z.strictObject({
  requestId: Identifier,
  operationId: Identifier,
  state: z.enum(["accepted", "running", "cancel-requested", "reconciling"]),
  phase: Phase.optional(),
  counters: z.record(z.string(), Count),
  stalled: z.boolean().optional(),
  // Contract §12 "Progress": only `updateSubmodules` events carry the row path.
  path: Text.optional(),
});
// Contract §11 "Distro start": `distro` is the listed name of the starting distro.
export const ProgressEvent = ProgressFields.extend({ distro: DistroName.optional() }).refine((e) => (e.phase === "wsl-starting") === (e.distro !== undefined));
export type ProgressEvent = z.infer<typeof ProgressEvent>;

// Contract §9 "Commit failure output": an output tail stays within 16 KiB and 100 lines.
const tailLines = (tail: string) => (tail === "" ? 0 : tail.split("\n").length - (tail.endsWith("\n") ? 1 : 0));
export const OutputTail = Text.refine((tail) => new TextEncoder().encode(tail).length <= COMMIT_OUTPUT_TAIL_BYTES && tailLines(tail) <= COMMIT_OUTPUT_TAIL_LINES);
