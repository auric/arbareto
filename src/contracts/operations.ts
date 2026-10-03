// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { CHANNEL_PATH_UNITS, COMMIT_MESSAGE_BYTES, IDENTIFIER_BYTES } from "./limits";

// Contract §3: the closed list of public operations.
const OPERATION_NAMES = [
  "getEnvironment",
  "chooseGit",
  "chooseRepository",
  "restoreWorkspace",
  "readWorkspace",
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
export const MUTATIONS: readonly OperationName[] = ["applyHunk", "applyFile", "commit", "updateSubmodules"];

// Contract §3: the shell answers these natively and never forwards them to the service.
export const SHELL_ONLY: readonly OperationName[] = ["requestClose", "currentSession"];

// Contract §2 envelope field rules.
export const REPOSITORY_BOUND: readonly OperationName[] = [
  "readWorkspace",
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
];
export const GENERATION_REQUIRED: readonly OperationName[] = [
  "readHistory",
  "readComparison",
  "applyHunk",
  "applyFile",
  "reviewCommit",
  "commit",
  "reviewSubmodules",
  "updateSubmodules",
  "approveTrust",
];
export const GENERATION_OPTIONAL: readonly OperationName[] = ["readWorkspace"];
export const SELECTION_REQUIRED: readonly OperationName[] = ["readComparison"];
export const SESSIONLESS: readonly OperationName[] = ["currentSession"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= IDENTIFIER_BYTES && UUID.test(value);
}

// Contract §6: `configurationFingerprint` is 64 lowercase hex digits.
export const isFingerprint = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
// Contract §3 `chooseGit`: the §6 channel path rule. Microsoft Learn "File path formats on Windows systems": a fully qualified path starts with a drive letter and a separator, or with two separators.
const isWindowsPath = (value: unknown) =>
  typeof value === "string" && value.length <= CHANNEL_PATH_UNITS && !value.includes("\u0000") && value.isWellFormed() && /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![.?][\\/]))/.test(value);
const isTrue = (value: unknown) => value === true;
const isBoolean = (value: unknown) => typeof value === "boolean";
const oneOf =
  (...allowed: string[]) =>
  (value: unknown) =>
    typeof value === "string" && allowed.includes(value);

// Git 2.55.0 rejects a `commit -F` message that holds only U+0020, U+0009, U+000A, and U+000D. U+000B, U+000C, U+00A0, and U+3000 commit.
function isCommitMessage(value: unknown): boolean {
  if (typeof value !== "string" || !value.isWellFormed()) return false;
  if (value.includes("\u0000") || /^[ \t\n\r]*$/.test(value)) return false;
  return new TextEncoder().encode(value).length <= COMMIT_MESSAGE_BYTES;
}

type Check = (value: unknown) => boolean;
export type PayloadValidator = (payload: Record<string, unknown>) => boolean;

function exact(fields: Record<string, Check>, extra: PayloadValidator = () => true): PayloadValidator {
  const names = Object.keys(fields);
  return (payload) => {
    const keys = Object.keys(payload);
    if (keys.length !== names.length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(fields, key) || !fields[key](payload[key])) return false;
    }
    return extra(payload);
  };
}

const empty = exact({});
const bootstrap = exact({ bootstrapId: isIdentifier });

// Contract §3 names the values. The field names `snapshotId`, `entryId`, `trustId`, `comparisonId`, `hunkId`, `operationId`, `choice`, and `markerId` follow test T012.
export const PAYLOAD_VALIDATORS: Record<OperationName, { renderer: PayloadValidator; service: PayloadValidator }> = {
  getEnvironment: { renderer: empty, service: empty },
  chooseGit: { renderer: empty, service: exact({ bootstrapId: isIdentifier, executablePath: isWindowsPath }) },
  chooseRepository: { renderer: empty, service: bootstrap },
  restoreWorkspace: { renderer: empty, service: bootstrap },
  readWorkspace: same(exact({ refresh: isBoolean, check: oneOf("full", "changes") }, (p) => !(p.refresh === true && p.check !== "full"))),
  readHistory: same(empty),
  readComparison: same(exact({ snapshotId: isIdentifier, entryId: isIdentifier })),
  readTrust: same(empty),
  approveTrust: same(exact({ fingerprint: isFingerprint, approve: isTrue })),
  revokeTrust: same(exact({ trustId: isIdentifier })),
  applyHunk: same(exact({ comparisonId: isIdentifier, hunkId: isIdentifier, snapshotId: isIdentifier, direction: oneOf("stage", "unstage") })),
  applyFile: same(exact({ comparisonId: isIdentifier, snapshotId: isIdentifier, direction: oneOf("stage", "unstage") })),
  reviewCommit: same(exact({ snapshotId: isIdentifier })),
  commit: same(exact({ reviewToken: isIdentifier, message: isCommitMessage, confirmFullScope: isTrue })),
  reviewSubmodules: same(exact({ snapshotId: isIdentifier })),
  updateSubmodules: same(exact({ submoduleReviewToken: isIdentifier, start: isTrue })),
  cancel: same(exact({ operationId: isIdentifier })),
  getOperation: same(exact({ operationId: isIdentifier })),
  requestClose: same(exact({ choice: oneOf("stay", "closeIfIdle", "interruptAndClose") })),
  currentSession: same(empty),
  dismissRecoveryMarker: { renderer: exact({ markerId: isIdentifier }), service: exact({ markerId: isIdentifier, bootstrapId: isIdentifier }) },
};

function same(validator: PayloadValidator) {
  return { renderer: validator, service: validator };
}
