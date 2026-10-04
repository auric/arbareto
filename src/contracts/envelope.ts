// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import { DamagedMarker, UtcTime } from "./channel";
import { ERROR_CODES, TERMINAL_STATES, type ErrorCode } from "./errors";
import { COMMIT_MESSAGE_BYTES, PUBLIC_REQUEST_BYTES } from "./limits";
import { ChannelPath, Count, Fingerprint, Identifier, isOperationName, MutationKind, OPERATION_NAMES, SHELL_ONLY, type OperationName } from "./operations";
import { OPERATION_STATES } from "./outcome";
import { decodeStrictJson, hasFractionOrExponent } from "./strict-json";

const ErrorCodeSchema = z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]);

// Contract §2 envelope fields.
const Generation = Count;
const repository = { repositoryId: Identifier };
const snapshot = { repositoryId: Identifier, repositoryGeneration: Generation };
const empty = () => z.strictObject({});
const pascal = (name: string) => name[0].toUpperCase() + name.slice(1);

function op<N extends OperationName, T extends z.ZodRawShape, P extends z.ZodType>(operation: N, target: T, payload: P) {
  const title = pascal(operation);
  return z
    .strictObject({
      version: z.literal(1),
      sessionId: Identifier,
      requestId: Identifier,
      operation: z.literal(operation),
      ...target,
      payload: payload.meta({ title: `${title}Payload` }),
    })
    .meta({ title: `${title}Request` });
}

const Direction = z.enum(["stage", "unstage"]);
// Git 2.55.0 rejects a `commit -F` message that holds only U+0020, U+0009, U+000A, and U+000D. U+000B, U+000C, U+00A0, and U+3000 commit.
// zod `max` counts code points, which never exceed UTF-8 bytes. The refinement checks the contract §5 byte bound.
const CommitMessage = z
  .string()
  .max(COMMIT_MESSAGE_BYTES)
  .refine((m) => m.isWellFormed() && !m.includes("\u0000") && !/^[ \t\n\r]*$/.test(m) && new TextEncoder().encode(m).length <= COMMIT_MESSAGE_BYTES);
const ReadWorkspacePayload = z
  .strictObject({ refresh: z.boolean(), check: z.enum(["full", "changes"]) })
  .refine((p) => !(p.refresh && p.check !== "full"));

// Contract §3 names the values. The field names `snapshotId`, `entryId`, `trustId`, `comparisonId`, `hunkId`, `operationId`, `choice`, and `markerId` follow test T012.
const GetEnvironment = op("getEnvironment", {}, empty());
const ReadWorkspace = op("readWorkspace", { ...repository, repositoryGeneration: Generation.optional() }, ReadWorkspacePayload);
// Contract §3 fixes no cursor form. The service issues each cursor, so it is a contract §2 identifier.
const ReadEntries = op("readEntries", snapshot, z.strictObject({ snapshotId: Identifier, cursor: Identifier }));
const ReadHistory = op("readHistory", snapshot, empty());
const ReadComparison = op("readComparison", { ...snapshot, selectionId: Identifier }, z.strictObject({ snapshotId: Identifier, entryId: Identifier }));
const ReadTrust = op("readTrust", repository, empty());
const ApproveTrust = op("approveTrust", snapshot, z.strictObject({ fingerprint: Fingerprint, approve: z.literal(true) }));
const RevokeTrust = op("revokeTrust", repository, z.strictObject({ trustId: Identifier }));
const ApplyHunk = op(
  "applyHunk",
  snapshot,
  z.strictObject({ comparisonId: Identifier, hunkId: Identifier, snapshotId: Identifier, direction: Direction }),
);
const ApplyFile = op("applyFile", snapshot, z.strictObject({ comparisonId: Identifier, snapshotId: Identifier, direction: Direction }));
const ReviewCommit = op("reviewCommit", snapshot, z.strictObject({ snapshotId: Identifier }));
const Commit = op("commit", snapshot, z.strictObject({ reviewToken: Identifier, message: CommitMessage, confirmFullScope: z.literal(true) }));
const ReviewSubmodules = op("reviewSubmodules", snapshot, z.strictObject({ snapshotId: Identifier }));
const UpdateSubmodules = op("updateSubmodules", snapshot, z.strictObject({ submoduleReviewToken: Identifier, start: z.literal(true) }));
const Cancel = op("cancel", {}, z.strictObject({ operationId: Identifier }));
const GetOperation = op("getOperation", {}, z.strictObject({ operationId: Identifier }));
const RequestClose = op("requestClose", {}, z.strictObject({ choice: z.enum(["stay", "closeIfIdle", "interruptAndClose"]) }));
// Contract §2: `currentSession` is the only request without `sessionId`.
const CurrentSession = op("currentSession", {}, empty()).omit({ sessionId: true }).meta({ title: "CurrentSessionRequest" });

// Contract §3: the renderer payload of a native-first operation. The shell replaces it with the service payload.
const ChooseGit = op("chooseGit", {}, empty());
const ChooseRepository = op("chooseRepository", {}, empty());
const RestoreWorkspace = op("restoreWorkspace", {}, empty());
const DismissRecoveryMarker = op("dismissRecoveryMarker", {}, z.strictObject({ markerId: Identifier }));

export const RendererEnvelope = z.discriminatedUnion("operation", [
  GetEnvironment,
  ChooseGit,
  ChooseRepository,
  RestoreWorkspace,
  ReadWorkspace,
  ReadEntries,
  ReadHistory,
  ReadComparison,
  ReadTrust,
  ApproveTrust,
  RevokeTrust,
  ApplyHunk,
  ApplyFile,
  ReviewCommit,
  Commit,
  ReviewSubmodules,
  UpdateSubmodules,
  Cancel,
  GetOperation,
  RequestClose,
  CurrentSession,
  DismissRecoveryMarker,
]);
export type RendererRequest = z.infer<typeof RendererEnvelope>;
export type RequestOf<K extends OperationName> = Extract<RendererRequest, { operation: K }>;

// Contract §1 step 6: the shell reads these renderer envelopes into its generated types.
export const NativeFirstEnvelope = z.discriminatedUnion("operation", [ChooseGit, ChooseRepository, RestoreWorkspace, DismissRecoveryMarker]);

// Contract §6 "Dismissal": without `bootstrapId`, the stored worktree path does not exist.
export const ServiceEnvelope = z.discriminatedUnion("operation", [
  GetEnvironment,
  op("chooseGit", {}, z.strictObject({ bootstrapId: Identifier, executablePath: ChannelPath })),
  op("chooseRepository", {}, z.strictObject({ bootstrapId: Identifier })),
  op("restoreWorkspace", {}, z.strictObject({ bootstrapId: Identifier })),
  ReadWorkspace,
  ReadEntries,
  ReadHistory,
  ReadComparison,
  ReadTrust,
  ApproveTrust,
  RevokeTrust,
  ApplyHunk,
  ApplyFile,
  ReviewCommit,
  Commit,
  ReviewSubmodules,
  UpdateSubmodules,
  Cancel,
  GetOperation,
  op("dismissRecoveryMarker", {}, z.strictObject({ markerId: Identifier, bootstrapId: Identifier.optional() })),
]);
export type ServiceRequest = z.infer<typeof ServiceEnvelope>;

export type Side = "renderer" | "service";
type Result<T> = { ok: true; request: T } | { ok: false; code: ErrorCode };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function decodeRequest(bytes: Uint8Array, side: "renderer"): Result<RendererRequest>;
export function decodeRequest(bytes: Uint8Array, side: "service"): Result<ServiceRequest>;
export function decodeRequest(bytes: Uint8Array, side: Side): Result<RendererRequest | ServiceRequest>;
export function decodeRequest(bytes: Uint8Array, side: Side): Result<RendererRequest | ServiceRequest> {
  if (bytes.length > PUBLIC_REQUEST_BYTES) return { ok: false, code: "FRAME_LIMIT" };
  const decoded = decodeStrictJson(bytes);
  if (!decoded.ok) return decoded;
  return validateRequest(decoded.value, side);
}

// zod reports no contract §9 code. So the version and operation checks come first, in the contract order.
export function validateRequest(value: unknown, side: "renderer"): Result<RendererRequest>;
export function validateRequest(value: unknown, side: "service"): Result<ServiceRequest>;
export function validateRequest(value: unknown, side: Side): Result<RendererRequest | ServiceRequest>;
export function validateRequest(value: unknown, side: Side): Result<RendererRequest | ServiceRequest> {
  if (!isObject(value) || !Object.hasOwn(value, "version")) return { ok: false, code: "INVALID_REQUEST" };
  if (value.version !== 1 || hasFractionOrExponent(value, "version")) return { ok: false, code: "PROTOCOL_VERSION" };
  const operation = value.operation;
  if (typeof operation !== "string") return { ok: false, code: "INVALID_REQUEST" };
  if (!isOperationName(operation) || (side === "service" && SHELL_ONLY.includes(operation))) return { ok: false, code: "UNKNOWN_OPERATION" };
  const parsed = (side === "renderer" ? RendererEnvelope : ServiceEnvelope).safeParse(value);
  return parsed.success ? { ok: true, request: parsed.data } : { ok: false, code: "INVALID_REQUEST" };
}

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

// Contract §2: exactly these fields. A progress event holds no command, configuration, environment, patch content, Git text, or credential.
export const ProgressEvent = z.strictObject({
  requestId: Identifier,
  operationId: Identifier,
  state: z.enum(["accepted", "running", "cancel-requested", "reconciling"]),
  phase: Phase.optional(),
  counters: z.record(z.string(), Count),
  stalled: z.boolean().optional(),
});
export type ProgressEvent = z.infer<typeof ProgressEvent>;

// Contract §2: one terminal response for each request. A response without an issued operation has no `operationId`.
export const Response = z.strictObject({
  requestId: Identifier.nullable(),
  operationId: Identifier.optional(),
  state: z.enum(TERMINAL_STATES),
  code: ErrorCodeSchema.optional(),
  result: z.unknown().optional(),
});
export type Response = z.infer<typeof Response>;

// ---- Results of the implemented operations (contract §3). Later tasks add the others. ----

// Contract §3 `getEnvironment` `reason`: why the startup check found no Git.
export const GitReason = z.enum(["selected-missing", "resolution-failed", "resolved-missing", "outside-installation"]);
export type GitReason = z.infer<typeof GitReason>;

// Contract §3 `getEnvironment`. No environment variable enters this result.
export const EnvironmentResult = z.strictObject({
  buildIdentity: z.strictObject({ version: z.string(), commit: z.string(), signing: z.literal("unsigned") }),
  platformScope: z.enum(["qualification-target", "other"]),
  selectedPath: z.string().optional(),
  executablePath: z.string().optional(),
  detectedVersion: z.string().optional(),
  // The saved version when this startup admitted another version.
  previousVersion: z.string().optional(),
  minimumVersion: z.string(),
  admission: z.enum(["admitted", "unsupported"]).optional(),
  qualification: z.enum(["unverified", "passed"]),
  gitCode: ErrorCodeSchema.optional(),
  reason: GitReason.optional(),
  path: z.string().optional(),
  markers: z.array(z.strictObject({ markerId: Identifier, kind: MutationKind, startedAt: UtcTime, worktreeRoot: ChannelPath })),
  markerLimit: Count.optional(),
  unloadedMarkers: Count.optional(),
  damagedMarkers: z.array(DamagedMarker),
});
export type Environment = z.infer<typeof EnvironmentResult>;

// Contract §3 `chooseGit`. A failed probe reports the versions that it found.
export const ChooseGitResult = z.union([
  z
    .strictObject({ gitInstallationId: Identifier, selectedPath: ChannelPath, executablePath: ChannelPath, version: z.string(), digest: Fingerprint })
    .meta({ title: "ChooseGitSelected" }),
  z
    .strictObject({ detectedVersion: z.string().optional(), reason: GitReason.optional(), path: z.string().optional(), minimumVersion: z.string() })
    .meta({ title: "ChooseGitFailed" }),
]);

// Contract §3 `cancel` and `getOperation`: the current or retained state of an issued operation (data-model §7).
export const OperationResult = z.strictObject({
  operationId: Identifier,
  operation: z.enum(OPERATION_NAMES),
  state: z.enum(OPERATION_STATES),
  phase: Phase.optional(),
  code: ErrorCodeSchema.optional(),
  cause: z.string().optional(),
  reason: z.string().optional(),
  stalled: z.boolean().optional(),
  endProcesses: z.boolean().optional(),
  lingering: z.boolean().optional(),
  lingeringDescendants: Count.optional(),
  rowId: Identifier.optional(),
});

// Contract §3 `currentSession`.
export const SessionResult = z.strictObject({ sessionId: Identifier });
