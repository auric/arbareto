// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import { DamagedMarker, TRUST_BOUNDS, UtcTime } from "./channel";
import { ERROR_CODES, TERMINAL_STATES, WSL_UNAVAILABLE_REASONS, type ErrorCode } from "./errors";
import * as limits from "./limits";
import { COMMIT_MESSAGE_BYTES, HISTORY_PARENTS_PER_COMMIT, HISTORY_STREAM_ROWS, PUBLIC_REQUEST_BYTES, REGISTERED_WORKSPACES } from "./limits";
import { ChannelPath, Count, Fingerprint, Identifier, isOperationName, MutationKind, OPERATION_NAMES, SHELL_ONLY, Text, type OperationName } from "./operations";
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
// A response repeats the `repositoryGeneration` and `selectionId` of its validated envelope. A `readWorkspace` result generation replaces the first.
export const Response = z.strictObject({
  requestId: Identifier.nullable(),
  operationId: Identifier.optional(),
  state: z.enum(TERMINAL_STATES),
  code: ErrorCodeSchema.optional(),
  repositoryGeneration: Generation.optional(),
  selectionId: Identifier.optional(),
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

// Contract §9 "Commit failure output": an output tail stays within 16 KiB and 100 lines.
const tailLines = (tail: string) => (tail === "" ? 0 : tail.split("\n").length - (tail.endsWith("\n") ? 1 : 0));
export const OutputTail = Text.refine((tail) => new TextEncoder().encode(tail).length <= limits.COMMIT_OUTPUT_TAIL_BYTES && tailLines(tail) <= limits.COMMIT_OUTPUT_TAIL_LINES);

// Contract §3 `chooseRepository` and `restoreWorkspace`: both operations share this result. The response `code` names each refusal.
// `path`, `remedy`, and `outputTail` follow contract §6 "Registration bootstrap". `limit` follows contract §9 `WORKSPACE_LIMIT`.
export const RegistrationResult = z.union([
  z.strictObject({ repositoryId: Identifier, generation: Generation, worktreeKey: Fingerprint }).meta({ title: "Registered" }),
  z
    .strictObject({
      path: z.string().optional(),
      remedy: z.strictObject({ text: z.string().optional(), command: z.string().nullable().optional() }).optional(),
      outputTail: OutputTail.optional(),
    })
    .meta({ title: "RegistrationRefused" }),
  z.strictObject({ limit: z.literal(REGISTERED_WORKSPACES) }).meta({ title: "WorkspaceLimit" }),
  // Contract §9 and §11: a WSL refusal. `reason` names the §9 reason of the response code, and `text` holds its §9 or §11 text.
  // `detail` holds the bounded `wsl.exe` text of `start-failed`. `command` holds the Git PPA remedy of an Ubuntu distro.
  z
    .strictObject({
      reason: z.enum([...WSL_UNAVAILABLE_REASONS, "version", "windows-git", "no-fs-uuid", "wsl-path", "mixed-location"]).optional(),
      text: z.string(),
      detectedVersion: z.string().optional(),
      minimumVersion: z.string().optional(),
      detail: OutputTail.optional(),
      command: z.string().optional(),
    })
    .meta({ title: "WslRefused" }),
]);
export type RegistrationResult = z.infer<typeof RegistrationResult>;
export const ChooseRepositoryResult = RegistrationResult;
export const RestoreWorkspaceResult = RegistrationResult;

// Git `config.c` `config_scope_name`: the scopes that `config list --show-scope` prints.
export const ConfigScope = z.enum(["system", "global", "local", "worktree", "command", "submodule", "unknown"]);
export type ConfigScope = z.infer<typeof ConfigScope>;
const TrustPersistence = z.enum(["stored", "session"]);
const Remedy = z.strictObject({ text: z.string().min(1) });

// Contract §7 "Program file digests": a failed trust listing. The text names the path and the errno name.
const TrustListingFailed = z.strictObject({ remedy: Remedy }).meta({ title: "TrustListingFailed" });

// Contract §7 "Value display allowlist": `value` appears only for an allowlisted key. Each text is redacted (contract §7 "URL user information").
export const TrustEntry = z.strictObject({ key: z.string().min(1), scope: ConfigScope, origin: z.string(), value: z.string().optional() }).meta({ title: "TrustEntry" });

// Contract §7 "Hook registrations". `scope` is the scope of the last `hook.<name>.event` entry, as `git hook list --show-scope` prints it.
// `commandScope` and `commandOrigin` belong to the `hook.<name>.command` entry, which decides `repositoryControlled`. A disabled hook can lack that entry.
export const TrustHook = z.union([
  z
    .strictObject({
      event: z.string().min(1),
      // Git accepts an empty subsection, so a friendly name can be empty.
      name: z.string(),
      scope: ConfigScope,
      commandScope: ConfigScope.optional(),
      commandOrigin: z.string().optional(),
      disabled: z.boolean(),
      repositoryControlled: z.boolean(),
    })
    .meta({ title: "ConfiguredHook" }),
  z.strictObject({ event: z.string().min(1), path: z.string().min(1), repositoryControlled: z.boolean() }).meta({ title: "FolderHook" }),
]);

// Contract §3 `readTrust` and data-model §3. `bound` names the reached contract §7 "Program file digests" bound, which gives `persistence` `session`.
// `inputLimited` marks a listing above the contract §5 "Effective configuration/trust input" bound. Only an approved or changed state carries a `trustId`.
export const ReadTrustResult = z
  .union([
    z
      .strictObject({
        generation: Generation,
        fingerprint: Fingerprint,
        state: z.enum(["untrusted", "approved", "changed", "revoked"]),
        persistence: TrustPersistence,
        trustId: Identifier.optional(),
        approvalRequired: z.strictObject({ reads: z.boolean(), commit: z.boolean() }),
        bound: z.enum(TRUST_BOUNDS).optional(),
        inputLimited: z.literal(true).optional(),
        entries: z.array(TrustEntry),
        hooks: z.array(TrustHook),
      })
      .refine((r) => (r.bound === undefined || r.persistence === "session") && ((r.state === "approved" || r.state === "changed") === (r.trustId !== undefined)))
      .meta({ title: "TrustReport" }),
    TrustListingFailed,
  ])
  .meta({ title: "ReadTrustResult" });

// Contract §3 `approveTrust`: `saveFailed` is true only after a `persist: true` confirmation that the shell could not store.
export const ApproveTrustResult = z
  .union([
    z
      .strictObject({ trustId: Identifier, persistence: TrustPersistence, saveFailed: z.boolean() })
      .refine((r) => !r.saveFailed || r.persistence === "session")
      .meta({ title: "TrustApproved" }),
    TrustListingFailed,
  ])
  .meta({ title: "ApproveTrustResult" });

// Contract §3 `revokeTrust`: the process count of the shell `revoke` reply.
export const RevokeTrustResult = z.strictObject({ endedProcesses: Count }).meta({ title: "RevokeTrustResult" });

// Data-model §2 `objectFormat`: SHA-1 and SHA-256 object IDs in lowercase hex.
const ObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
// git-status(1) "Porcelain Format Version 2": octal modes.
const FileMode = z.string().regex(/^[0-7]{6}$/);

// Data-model §2 `head`: a symbolic target with its object ID, a detached object ID, or an unborn branch.
export const Head = z
  .discriminatedUnion("state", [
    z.strictObject({ state: z.literal("branch"), target: z.string().min(1), oid: ObjectId }).meta({ title: "BranchHead" }),
    z.strictObject({ state: z.literal("detached"), oid: ObjectId }).meta({ title: "DetachedHead" }),
    z.strictObject({ state: z.literal("unborn"), target: z.string().min(1) }).meta({ title: "UnbornHead" }),
  ])
  .meta({ title: "Head" });

// Contract §9: `limited` carries `OUTPUT_LIMIT` with the export name of the reached contract §5 bound, `OBJECT_MISSING`, or `WORKTREE_CHANGING`.
const LIMIT_NAMES = Object.keys(limits) as [string, ...string[]];
export const Completeness = z
  .discriminatedUnion("state", [
    z.strictObject({ state: z.literal("complete") }).meta({ title: "Complete" }),
    z
      .strictObject({ state: z.literal("limited"), code: z.enum(["OUTPUT_LIMIT", "OBJECT_MISSING", "WORKTREE_CHANGING"]), reason: z.enum(LIMIT_NAMES).optional() })
      .refine((c) => (c.code === "OUTPUT_LIMIT") === (c.reason !== undefined))
      .meta({ title: "Limited" }),
    z.strictObject({ state: z.literal("failed"), code: ErrorCodeSchema }).meta({ title: "Failed" }),
  ])
  .meta({ title: "Completeness" });

// Data-model §5 "Change entry". `pathBytes` and `sourcePathBytes` hold the literal path bytes in base64. `path` and `sourcePath` are display text.
// `xy`, `submodule`, `modes`, `oids`, and `score` repeat the fields of the git-status(1) porcelain v2 record in its order.
// `flags` is absent when the index listing gives no single entry for the path.
export const ChangeEntry = z
  .strictObject({
    entryId: Identifier,
    category: z.enum(["staged", "unstaged", "untracked", "conflicted"]),
    path: z.string(),
    pathBytes: z.base64().min(1),
    xy: z.string().regex(/^[.MTADRCU]{2}$/).optional(),
    submodule: z.string().regex(/^(?:N\.\.\.|S[C.][M.][U.])$/).optional(),
    modes: z.array(FileMode).min(3).max(4).optional(),
    oids: z.array(ObjectId).min(2).max(3).optional(),
    score: z.string().regex(/^[RC][0-9]{1,3}$/).optional(),
    sourcePath: z.string().optional(),
    sourcePathBytes: z.base64().min(1).optional(),
    flags: z.strictObject({ intentToAdd: z.boolean(), assumeUnchanged: z.boolean(), skipWorktree: z.boolean() }).optional(),
  })
  .refine((e) => (e.sourcePath === undefined) === (e.sourcePathBytes === undefined))
  .meta({ title: "ChangeEntry" });

// Contract §4 "Hunk eligibility and publication", in the order of its list. Null: the read holds no raw index bytes to decide from.
export const HunkEligibility = z
  .union([
    z.strictObject({ eligible: z.literal(true) }).meta({ title: "Eligible" }),
    z.strictObject({ eligible: z.literal(false), reason: z.enum(["sparse-index", "split-index", "index-change-hook", "executable-monitor", "unqualified-monitor"]) }).meta({ title: "Ineligible" }),
  ])
  .nullable();

// Data-model §2 `operationState` and `recoveryState`.
export const WorkspaceOperationState = z.enum(["normal", "conflicted", "merging", "rebasing", "cherry-picking", "reverting", "sequencer-active", "unknown"]);
export const RecoveryState = z.enum(["ready", "refreshing", "reconciling", "unknown", "unavailable"]);

// Contract §3 `readWorkspace` with a retained snapshot: the summary, `entryCount`, the first page, and the cursor of the next page or null.
export const WorkspaceSnapshot = z
  .strictObject({
    generation: Generation,
    snapshotId: Identifier,
    identity: z.strictObject({
      worktreeRoot: ChannelPath,
      gitDirectory: ChannelPath,
      commonDirectory: ChannelPath,
      indexPath: ChannelPath,
      objectFormat: z.enum(["sha1", "sha256"]),
      refFormat: z.enum(["files", "reftable"]),
    }),
    head: Head,
    operationState: WorkspaceOperationState,
    recoveryState: RecoveryState,
    completeness: Completeness,
    hunkEligibility: HunkEligibility,
    // Contract §12 "Discovery notice": `paths` holds display paths within the §5 submodule review bound.
    submoduleNotice: z.strictObject({ count: Count, paths: z.array(z.string()).max(limits.SUBMODULE_REVIEW_SUBMODULES) }),
    entryCount: Count,
    entries: z.array(ChangeEntry),
    cursor: Identifier.nullable(),
  })
  .refine((r) => r.completeness.state !== "failed" && (r.cursor === null ? r.entries.length === r.entryCount : r.entries.length > 0 && r.entries.length < r.entryCount))
  .meta({ title: "WorkspaceSnapshot" });

// Contract §3 `readWorkspace` without a snapshot: a failed read, or a missing object (contract §7 "Missing objects"). It holds no entry, so it never reports a clean working tree.
export const WorkspaceRefusal = z
  .strictObject({ completeness: Completeness, recoveryState: RecoveryState, remedy: Remedy.optional() })
  .refine((r) => r.completeness.state === "failed" || (r.completeness.state === "limited" && r.completeness.code === "OBJECT_MISSING"))
  .meta({ title: "WorkspaceRefusal" });

export const ReadWorkspaceResult = z.union([WorkspaceSnapshot, WorkspaceRefusal]).meta({ title: "ReadWorkspaceResult" });
export type ReadWorkspaceResult = z.infer<typeof ReadWorkspaceResult>;
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>;
export type WorkspaceRefusal = z.infer<typeof WorkspaceRefusal>;
export type ChangeEntry = z.infer<typeof ChangeEntry>;
export type Completeness = z.infer<typeof Completeness>;

// Contract §3 `readEntries`: one later page with at least one entry, and the cursor of the next page or null.
export const ReadEntriesResult = z.strictObject({ entries: z.array(ChangeEntry).min(1), cursor: Identifier.nullable() }).meta({ title: "ReadEntriesResult" });
export type ReadEntriesResult = z.infer<typeof ReadEntriesResult>;

// Contract §3 "HistoryPage result" and data-model §4 "History page". `parents` holds the effective parents in Git order.
// `date` is the author time in seconds (Git `ident.c` `split_ident_line`). `encoding` is the `encoding` header value without control characters, or null.
export const HistoryRow = z
  .strictObject({
    oid: ObjectId,
    parents: z.array(ObjectId).max(HISTORY_PARENTS_PER_COMMIT),
    subject: z.string(),
    author: z.strictObject({ name: z.string(), email: z.string() }),
    date: Count,
    encoding: z.string().regex(/^[^\u0000-\u001f\u007f-\u009f]*$/).nullable(),
  })
  .meta({ title: "HistoryRow" });

// Contract §3 `readHistory`: at most 100 rows of the captured checkout, child before parent. The first row is the captured HEAD commit.
// `boundaries.page` holds the parents outside the page. `boundaries.shallow` holds the raw parents that a shallow commit of the page hides.
// `remedy` holds the contract §7 "Missing objects" text of an `OBJECT_MISSING` page.
export const HistoryPage = z
  .strictObject({
    generation: Generation,
    scope: z.literal("current-checkout"),
    head: Head,
    shallowFingerprint: Fingerprint.nullable(),
    rows: z.array(HistoryRow).max(HISTORY_STREAM_ROWS),
    boundaries: z.strictObject({ page: z.array(ObjectId), shallow: z.array(ObjectId) }),
    completeness: Completeness,
    remedy: Remedy.optional(),
  })
  .refine((p) => p.completeness.state !== "failed" && (p.head.state === "unborn" ? p.rows.length === 0 : p.rows.length === 0 || p.rows[0]!.oid === p.head.oid))
  .meta({ title: "HistoryPage" });

// Contract §3 `readHistory` without a page: a refused gate, a failed read, or a damaged object store (contract §7 "Missing objects"). It holds no row.
export const HistoryRefusal = z
  .strictObject({ completeness: Completeness, remedy: Remedy.optional() })
  .refine((r) => r.completeness.state === "failed")
  .meta({ title: "HistoryRefusal" });

export const ReadHistoryResult = z.union([HistoryPage, HistoryRefusal]).meta({ title: "ReadHistoryResult" });
export type HistoryRow = z.infer<typeof HistoryRow>;
export type HistoryPage = z.infer<typeof HistoryPage>;
export type HistoryRefusal = z.infer<typeof HistoryRefusal>;

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
