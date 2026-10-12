// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import { DamagedMarker, LinuxPath, TRUST_BOUNDS, UtcTime } from "./channel";
import {
  ERROR_CODES,
  HISTORY_CHANGED_REASONS,
  HISTORY_OUTPUT_LIMIT_REASONS,
  SEARCH_UNSUPPORTED_REASONS,
  TERMINAL_STATES,
  UNSUPPORTED_FILTER_TEXT_REASONS,
  WSL_UNAVAILABLE_REASONS,
  type ErrorCode,
} from "./errors";
import { FILE_ACTION_REASONS } from "./file-action";
import * as limits from "./limits";
import {
  COMMIT_MESSAGE_BYTES,
  GRAPH_LANES,
  HISTORY_PAGE_BYTES,
  HISTORY_PARENTS_PER_COMMIT,
  HISTORY_ROWS_PER_REQUEST,
  HISTORY_STREAM_ROWS,
  HISTORY_VIEW_COMMITS,
  PUBLIC_REQUEST_BYTES,
  REF_LISTING_RECORDS,
  REGISTERED_WORKSPACES,
} from "./limits";
import {
  ChannelPath,
  Count,
  Direction,
  DistroName,
  Fingerprint,
  Identifier,
  isOperationName,
  MutationKind,
  OPERATION_NAMES,
  OutputTail,
  Phase,
  PHASES,
  ProgressEvent,
  SHELL_ONLY,
  Text,
  type OperationName,
} from "./operations";
import { ATTRIBUTION_REASONS, OPERATION_STATES } from "./outcome";
import { decodeStrictJson, hasFractionOrExponent, isObject } from "./strict-json";
import { StallRemedy, SubmoduleRowResult } from "./submodules";

const ErrorCodeSchema = z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]);

// Contract §2 envelope fields.
const Generation = Count;
const repository = { repositoryId: Identifier };
const snapshot = { repositoryId: Identifier, repositoryGeneration: Generation };
const empty = () => z.strictObject({});
// Data-model §2 `objectFormat`: SHA-1 and SHA-256 object IDs in lowercase hex.
const ObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
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
// Contract §3 `readRefs`: no renderer ref, pattern, or format.
const ReadRefs = op("readRefs", snapshot, empty());
// Feature 002 contract Δ2 and Δ3. `viewId` and `searchId` are §2 identifiers that the service issues. The service checks the object format of an `oid`.
const OpenHistory = op("openHistory", snapshot, z.strictObject({ scope: z.enum(["all", "current"]) }));
const HistoryNeed = z.union([
  z.strictObject({ row: z.int().min(0).max(HISTORY_VIEW_COMMITS) }).meta({ title: "NeedRow" }),
  z.strictObject({ oid: ObjectId }).meta({ title: "NeedOid" }),
  z.strictObject({ end: z.literal(true) }).meta({ title: "NeedEnd" }),
]);
const LoadHistory = op("loadHistory", repository, z.strictObject({ viewId: Identifier, need: HistoryNeed }));
// `from` is the row index where a match search starts.
const RowsAt = z.union([
  z.strictObject({ row: Count }).meta({ title: "AtRow" }),
  z.strictObject({ oid: ObjectId }).meta({ title: "AtOid" }),
  z.strictObject({ match: z.enum(["next", "previous"]), from: Count }).meta({ title: "AtMatch" }),
  z.strictObject({ end: z.literal(true) }).meta({ title: "AtEnd" }),
]);
const ReadHistoryRows = op(
  "readHistoryRows",
  repository,
  z
    .strictObject({
      viewId: Identifier,
      mode: z.enum(["full", "filter"]),
      searchId: Identifier.optional(),
      at: RowsAt,
      count: z.int().min(1).max(HISTORY_ROWS_PER_REQUEST),
      text: z.enum(["none", "rows", "details"]),
    })
    .refine((p) => (p.mode !== "filter" || p.searchId !== undefined) && (p.text !== "details" || p.count === 1)),
);
// Contract Δ3: the service refuses a nonempty text with UNSUPPORTED_FILTER_TEXT, so the schema takes any nonempty string.
const SearchHistory = op("searchHistory", repository, z.strictObject({ viewId: Identifier, text: z.string().min(1) }));
const CloseHistory = op("closeHistory", repository, z.strictObject({ viewId: Identifier }));
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
// Contract §3 "Recent repositories": the renderer sends back only an `entryId` that the shell issued.
const ListRecentRepositories = op("listRecentRepositories", {}, empty());
const OpenRecentRepository = op("openRecentRepository", {}, z.strictObject({ entryId: Identifier }));
const RemoveRecentRepository = op("removeRecentRepository", {}, z.strictObject({ entryId: Identifier }));

export const RendererEnvelope = z.discriminatedUnion("operation", [
  GetEnvironment,
  ChooseGit,
  ChooseRepository,
  RestoreWorkspace,
  ListRecentRepositories,
  OpenRecentRepository,
  RemoveRecentRepository,
  ReadWorkspace,
  ReadEntries,
  ReadHistory,
  OpenHistory,
  LoadHistory,
  ReadHistoryRows,
  SearchHistory,
  CloseHistory,
  ReadRefs,
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
export const NativeFirstEnvelope = z.discriminatedUnion("operation", [
  ChooseGit,
  ChooseRepository,
  RestoreWorkspace,
  DismissRecoveryMarker,
  ListRecentRepositories,
  OpenRecentRepository,
  RemoveRecentRepository,
]);

// Contract §6 "Dismissal": without `bootstrapId`, the stored worktree path does not exist.
export const ServiceEnvelope = z.discriminatedUnion("operation", [
  GetEnvironment,
  op("chooseGit", {}, z.strictObject({ bootstrapId: Identifier, executablePath: ChannelPath })),
  op("chooseRepository", {}, z.strictObject({ bootstrapId: Identifier })),
  op("restoreWorkspace", {}, z.strictObject({ bootstrapId: Identifier })),
  ReadWorkspace,
  ReadEntries,
  ReadHistory,
  OpenHistory,
  LoadHistory,
  ReadHistoryRows,
  SearchHistory,
  CloseHistory,
  ReadRefs,
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

export { OutputTail, Phase, PHASES, ProgressEvent };

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

// Contract §3 `chooseRepository` and `restoreWorkspace`: both operations share this result. The response `code` names each refusal.
// `path`, `remedy`, and `outputTail` follow contract §6 "Registration bootstrap". `limit` follows contract §9 `WORKSPACE_LIMIT`.
export const RegistrationResult = z.union([
  // `worktreeRoot` is the Git-resolved worktree root, and for WSL its UNC identity path.
  z.strictObject({ repositoryId: Identifier, generation: Generation, worktreeKey: Fingerprint, worktreeRoot: ChannelPath }).meta({ title: "Registered" }),
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

// Contract §9: the shell refuses an `openRecentRepository` of a not-found Windows folder with `REPOSITORY_UNAVAILABLE`.
export const RecentAbsent = z
  .strictObject({ reason: z.literal("absent"), path: ChannelPath, text: z.string(), remedy: z.strictObject({ text: z.string() }) })
  .meta({ title: "RecentAbsent" });
// Contract §3 `openRecentRepository`: the result of `restoreWorkspace`, or the shell refusal above.
export const OpenRecentRepositoryResult = z.union([RegistrationResult, RecentAbsent]).meta({ title: "OpenRecentRepositoryResult" });

// Contract §5 "Recent repositories": the native settings hold at most 20 entries. It is no output bound, so `limits.ts` does not list it.
const RECENT_REPOSITORIES = 20;
// Contract §3 `listRecentRepositories` and `removeRecentRepository`: newest `openedAt` first. The shell checks no folder.
// `location` comes from the contract §11 route rule of the stored path, never from a renderer guess.
export const RecentRepositoriesResult = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        entryId: Identifier,
        path: ChannelPath,
        location: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("native") }).meta({ title: "RecentNativeLocation" }),
          z.strictObject({ kind: z.literal("wsl"), distro: DistroName }).meta({ title: "RecentWslLocation" }),
        ]),
        openedAt: UtcTime,
        // The shell sets it from `worktreeKey` equality with the open workspace. The key stays out of the entry.
        current: z.boolean(),
      }),
    )
    .max(RECENT_REPOSITORIES),
});
export type RecentRepositoriesResult = z.infer<typeof RecentRepositoriesResult>;

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

// Contract §5 "Trust report rows": an `OUTPUT_LIMIT` `readTrust` names the reached bound and carries no report.
const TRUST_REPORT_BOUNDS = ["TRUST_REPORT_ENTRIES", "TRUST_REPORT_HOOKS"] as const;
const TrustReportLimited = z.strictObject({ reason: z.enum(TRUST_REPORT_BOUNDS) }).meta({ title: "TrustReportLimited" });

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
        entries: z.array(TrustEntry).max(limits.TRUST_REPORT_ENTRIES),
        hooks: z.array(TrustHook).max(limits.TRUST_REPORT_HOOKS),
      })
      .refine((r) => (r.bound === undefined || r.persistence === "session") && ((r.state === "approved" || r.state === "changed") === (r.trustId !== undefined)))
      .meta({ title: "TrustReport" }),
    TrustListingFailed,
    TrustReportLimited,
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
    z
      .strictObject({ eligible: z.literal(false), reason: z.enum(["sparse-index", "split-index", "index-change-hook", "executable-monitor", "unqualified-monitor", "shared-repository"]) })
      .meta({ title: "Ineligible" }),
  ])
  .nullable();

// Data-model §2 `operationState` and `recoveryState`.
export const WorkspaceOperationState = z.enum(["normal", "conflicted", "merging", "rebasing", "cherry-picking", "reverting", "sequencer-active", "unknown"]);
export const RecoveryState = z.enum(["ready", "refreshing", "reconciling", "unknown", "unavailable"]);

// Contract §8 "Observed locks": `applyHunk` and `applyFile` name at most 6 files. The restart list of foreign files uses the same bound.
export const RECOVERY_FOREIGN_CAP = 6;

// Contract §8: the statement of a recovery refresh. `foreignTotal` counts the foreign files when the list is cut.
export const RecoveryStatement = z
  .strictObject({
    outcome: z.enum(["unknown", "none"]),
    attribution: z
      .discriminatedUnion("result", [
        z.strictObject({ result: z.literal("identified"), commitOid: ObjectId }).meta({ title: "AttributionIdentified" }),
        z.strictObject({ result: z.literal("none") }).meta({ title: "AttributionNone" }),
        z.strictObject({ result: z.literal("unknown"), reason: z.enum(ATTRIBUTION_REASONS) }).meta({ title: "AttributionUnknown" }),
      ])
      .optional(),
    indexMatch: z.enum(["published", "not-published", "neither"]).optional(),
    // Contract §8: the `updateSubmodules` row states of the retained plan.
    submoduleResults: z.array(SubmoduleRowResult).max(limits.SUBMODULE_REVIEW_SUBMODULES).optional(),
    foreign: z.array(ChannelPath).max(RECOVERY_FOREIGN_CAP).optional(),
    foreignTotal: Count.optional(),
  })
  .meta({ title: "RecoveryStatement" });
export type RecoveryStatement = z.infer<typeof RecoveryStatement>;

// Data-model §2 `location`: the native route, or a WSL distro by its listed name with the approved Git of that distro (contract §11 "Git per distro").
export const WorkspaceLocation = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("native") }).meta({ title: "NativeLocation" }),
    z.strictObject({ kind: z.literal("wsl"), distro: DistroName, git: z.strictObject({ path: LinuxPath, version: Text.min(1) }) }).meta({ title: "WslLocation" }),
  ])
  .meta({ title: "WorkspaceLocation" });

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
    location: WorkspaceLocation,
    // Contract §12 "Discovery notice": `count` has no bound. `paths` holds the first display paths in index order, within the §5 submodule review bound.
    submoduleNotice: z.strictObject({ count: Count, paths: z.array(z.string()).max(limits.SUBMODULE_REVIEW_SUBMODULES), filter: z.enum(["applied", "skipped"]) }),
    entryCount: Count,
    entries: z.array(ChangeEntry),
    cursor: Identifier.nullable(),
    recovery: RecoveryStatement.optional(),
    // Contract §3 `readWorkspace`: `retained` when the change check returned the last snapshot without a Git process.
    readKind: z.enum(["full", "retained"]),
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

// Contract §5 "History message body" and "Reference result". Neither is an OUTPUT_LIMIT reason, so `limits.ts` does not list them.
// A cut body sets `bodyCut`. A `readRefs` result above its bound gives reason REF_LISTING_BYTES.
export const HISTORY_BODY_BYTES = 16 * 1024;
export const REF_RESULT_BYTES = 8 * 1024 * 1024;

// Contract §3 "HistoryPage result" and data-model §4 "History page". `parents` holds the effective parents in Git order.
// `date` is the author time in seconds (Git `ident.c` `split_ident_line`). `encoding` is the `encoding` header value without control characters, or null.
// `shallow` is true when the shallow file lists the commit. `invalidUtf8` is true when the raw subject, author, committer, or body bytes are not valid UTF-8.
// `committerDate` is the committer time in seconds. `body` holds at most the contract §5 "History message body" bound, and `bodyCut` marks a cut body.
export const HistoryRow = z
  .strictObject({
    oid: ObjectId,
    parents: z.array(ObjectId).max(HISTORY_PARENTS_PER_COMMIT),
    subject: z.string(),
    author: z.strictObject({ name: z.string(), email: z.string() }),
    date: Count,
    encoding: z.string().regex(/^[^\u0000-\u001f\u007f-\u009f]*$/).nullable(),
    shallow: z.boolean(),
    invalidUtf8: z.boolean(),
    committer: z.strictObject({ name: z.string(), email: z.string() }),
    committerDate: Count,
    // zod `max` counts UTF-16 units, which never exceed UTF-8 bytes. The refinement checks the byte bound.
    body: z
      .string()
      .max(HISTORY_BODY_BYTES)
      .refine((b) => new TextEncoder().encode(b).length <= HISTORY_BODY_BYTES),
    bodyCut: z.boolean(),
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

// Contract §3 "References result" and data-model §4 "Reference list". `name` has no kind prefix. An empty Git field gives null.
// `commitId` is `objectId` for a commit, `peeledId` for a tag that Git peels to a commit, and otherwise null.
export const RefEntry = z
  .strictObject({
    kind: z.enum(["branch", "remote", "tag", "stash"]),
    name: z.string(),
    invalidUtf8: z.boolean(),
    objectId: ObjectId,
    objectType: z.enum(["commit", "tag", "tree", "blob"]),
    peeledId: ObjectId.nullable(),
    peeledType: z.enum(["commit", "tree", "blob"]).nullable(),
    symref: z.string().nullable(),
    upstream: z.string().nullable(),
    upstreamPresent: z.boolean(),
    commitId: ObjectId.nullable(),
  })
  .meta({ title: "RefEntry" });

// Contract §3 `readRefs`: the complete list in Git's `refname` order, and the branch that `%(HEAD)` marks.
// Feature 002 contract Δ3: `refsDigest` is computed as in `openHistory`.
export const RefList = z
  .strictObject({
    generation: Generation,
    refs: z.array(RefEntry).max(REF_LISTING_RECORDS),
    refsDigest: Fingerprint,
    current: z.strictObject({ name: z.string(), objectId: ObjectId }).meta({ title: "CurrentBranch" }).nullable(),
    completeness: Completeness,
  })
  .refine((r) => r.completeness.state === "complete")
  .meta({ title: "RefList" });

// Contract §3 `readRefs` without a list: a refused gate, a failed read, or a §5 bound. Contract §9: an OUTPUT_LIMIT result keeps no records.
export const RefsRefusal = z
  .strictObject({ completeness: Completeness, remedy: Remedy.optional() })
  .refine((r) => r.completeness.state === "failed" || (r.completeness.state === "limited" && r.completeness.code === "OUTPUT_LIMIT"))
  .meta({ title: "RefsRefusal" });

export const ReadRefsResult = z.union([RefList, RefsRefusal]).meta({ title: "ReadRefsResult" });
export type RefEntry = z.infer<typeof RefEntry>;
export type RefsResult = z.infer<typeof RefList>;
export type RefsRefusal = z.infer<typeof RefsRefusal>;

// ---- Feature 002 history views (contract Δ3) ----

// A remedy text, and a copyable command or null. A `DEADLINE` load carries the 001 commit-graph command.
const ViewRemedy = z.strictObject({ text: z.string().min(1), command: z.string().nullable() }).meta({ title: "ViewRemedy" });
// The reason of the response code (contract Δ8, Δ9). An `OUTPUT_LIMIT` reason is the export name of its `limits.ts` bound.
const ViewReason = z.enum([
  ...HISTORY_CHANGED_REASONS,
  ...UNSUPPORTED_FILTER_TEXT_REASONS,
  ...SEARCH_UNSUPPORTED_REASONS,
  ...HISTORY_OUTPUT_LIMIT_REASONS,
  "REF_LISTING_RECORDS",
  "REF_LISTING_BYTES",
  "object-missing",
]);
// A view operation that ended without its result value.
export const HistoryViewRefusal = z.strictObject({ reason: ViewReason.optional(), remedy: ViewRemedy.optional() }).meta({ title: "HistoryViewRefusal" });

// `startCount`: the unique commits of at most REF_LISTING_RECORDS records, plus HEAD.
export const OpenHistoryResult = z
  .union([
    z
      .strictObject({
        viewId: Identifier,
        scope: z.enum(["all", "current"]),
        generation: Generation,
        head: Head,
        startCount: Count.max(REF_LISTING_RECORDS + 1),
        refsDigest: Fingerprint,
        shallow: z.boolean(),
      })
      .meta({ title: "HistoryViewOpened" }),
    HistoryViewRefusal,
  ])
  .meta({ title: "OpenHistoryResult" });

// `rows`: the rows that the view holds after the load. `reason` and `remedy` follow the response code.
export const LoadHistoryResult = z
  .strictObject({ rows: Count.max(HISTORY_VIEW_COMMITS), complete: z.boolean(), reason: ViewReason.optional(), remedy: ViewRemedy.optional() })
  .refine((r) => !r.complete || r.reason === undefined)
  .meta({ title: "LoadHistoryResult" });

const Lane = z.int().min(0).max(GRAPH_LANES - 1);
const GraphPoint = z.strictObject({ lane: Lane, at: z.enum(["top", "node", "bottom"]) }).meta({ title: "GraphPoint" });
// Data-model §4. `skip` marks a filter-mode edge that skips commits (spec FR-034).
const GraphSegment = z
  .discriminatedUnion("shape", [
    z.strictObject({ shape: z.literal("line"), from: GraphPoint, to: GraphPoint, color: Count, skip: z.literal(true).optional() }).meta({ title: "GraphLine" }),
    z.strictObject({ shape: z.literal("stub"), lane: Lane, color: Count }).meta({ title: "GraphStub" }),
  ])
  .meta({ title: "GraphSegment" });
export const GraphCell = z
  .strictObject({ node: Lane, color: Count, merge: z.boolean(), limited: z.boolean(), segments: z.array(GraphSegment), marks: z.array(z.enum(["root", "shallow"])) })
  .meta({ title: "GraphCell" });
const Person = z.strictObject({ name: z.string(), email: z.string() });

// The row form of `readHistoryRows`. `text: "rows"` adds ROW_TEXT, or `textLimit` for an object above HISTORY_COMMIT_OBJECT_BYTES. `text: "details"` also adds ROW_DETAILS.
const ROW_TEXT = ["subject", "author", "date", "encoding", "invalidUtf8"] as const;
const ROW_DETAILS = ["body", "bodyCut", "committer", "committerDate", "children"] as const;
const allOf = (row: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => row[k] !== undefined);
const noneOf = (row: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => row[k] === undefined);
export const HistoryViewRow = z
  .strictObject({
    index: Count.max(HISTORY_VIEW_COMMITS - 1),
    oid: ObjectId,
    parents: z.array(ObjectId).max(HISTORY_PARENTS_PER_COMMIT),
    // Null in filter mode for a row that is not settled yet.
    cell: GraphCell.nullable(),
    labels: z.array(z.strictObject({ kind: z.enum(["branch", "remote", "tag", "stash"]), name: z.string(), invalidUtf8: z.boolean() })),
    checkout: z.boolean(),
    // Present when the request has `searchId`. Null while the match state of the row is not known.
    match: z.boolean().nullable().optional(),
    subject: z.string().optional(),
    author: Person.optional(),
    date: Count.optional(),
    encoding: z.string().regex(/^[^\u0000-\u001f\u007f-\u009f]*$/).nullable().optional(),
    invalidUtf8: z.boolean().optional(),
    textLimit: z.literal(true).optional(),
    body: z
      .string()
      .max(HISTORY_BODY_BYTES)
      .refine((b) => new TextEncoder().encode(b).length <= HISTORY_BODY_BYTES)
      .optional(),
    bodyCut: z.boolean().optional(),
    committer: Person.optional(),
    committerDate: Count.optional(),
    children: z.array(ObjectId).optional(),
  })
  .refine(
    (r) =>
      (allOf(r, ROW_TEXT) || noneOf(r, ROW_TEXT)) &&
      (allOf(r, ROW_DETAILS) || noneOf(r, ROW_DETAILS)) &&
      (noneOf(r, ROW_DETAILS) || allOf(r, ROW_TEXT)) &&
      (r.textLimit === undefined || (noneOf(r, ROW_TEXT) && noneOf(r, ROW_DETAILS))),
  )
  .meta({ title: "HistoryViewRow" });

// `target` is `found` when the requested row exists. `lanes` is the most lanes so far. `bytes` is the encoded result size for the renderer cache.
export const ReadHistoryRowsResult = z
  .union([
    z
      .strictObject({
        target: z.enum(["found", "unknown", "none"]),
        rows: z.array(HistoryViewRow).max(HISTORY_ROWS_PER_REQUEST),
        lanes: z.int().min(1).max(GRAPH_LANES),
        complete: z.boolean(),
        cut: z.boolean(),
        bytes: Count.max(HISTORY_PAGE_BYTES),
      })
      .refine((r) => (r.target === "found" || r.rows.length === 0) && r.rows.every((row, i) => i === 0 || row.index > r.rows[i - 1]!.index))
      .meta({ title: "HistoryRows" }),
    HistoryViewRefusal,
  ])
  .meta({ title: "ReadHistoryRowsResult" });

// Contract Δ3: the final match count. `shallow` states that the search covered only the commits that the clone holds.
export const SearchHistoryResult = z
  .union([z.strictObject({ matches: Count.max(HISTORY_VIEW_COMMITS), shallow: z.boolean() }).meta({ title: "SearchFinished" }), HistoryViewRefusal])
  .meta({ title: "SearchHistoryResult" });

// Data-model §5 "Support decision". `src/git-service/support.ts` `SUPPORT_REASONS` holds the same list.
const SupportValue = z.enum(["supported", "binary", "encoding", "size", "rename", "mode", "type", "symlink", "submodule", "LFS", "filter", "state", "line-endings", "index-flag", "path"]);
// Data-model §5 "File-action decision". `state` is the operation-state refusal. Contract §4: `blob-proof` never occurs in `readComparison`.
const FileActionValue = z.enum(["stage", "unstage", "state", ...FILE_ACTION_REASONS.filter((r) => r !== "blob-proof")]);
// Contract §4 "Limitation remedies": a refused file action can carry a copyable command. A null `command` shows the refused value in `text`.
const FileRemedy = z.strictObject({ text: z.string().min(1), command: z.string().nullable() }).meta({ title: "FileRemedy" }).nullable();
const ComparisonScope = z.enum(["head-to-index", "index-to-worktree", "empty-to-untracked"]);

// Data-model §5 "Hunk". `ordinal` counts from 0 in patch order. `digest` is the SHA-256 hex of the canonical hunk bytes.
export const ComparisonHunk = z
  .strictObject({ hunkId: Identifier, ordinal: Count, oldStart: Count, oldCount: Count, newStart: Count, newCount: Count, digest: Fingerprint })
  .meta({ title: "ComparisonHunk" });

// Contract §3 `readComparison` with a retained comparison: `succeeded`, or `limited` with `OUTPUT_LIMIT`. `patch` holds the canonical patch in base64.
// Hunks exist only for a supported comparison. A line-ending listing limit gives `support: null` (contract §4 "Comparison limits").
export const Comparison = z
  .strictObject({
    comparisonId: Identifier,
    snapshotId: Identifier,
    entryId: Identifier,
    scope: ComparisonScope,
    completeness: Completeness,
    patch: z.base64(),
    hunks: z.array(ComparisonHunk),
    support: SupportValue.nullable(),
    fileAction: FileActionValue,
    remedy: FileRemedy,
  })
  .refine(
    (c) =>
      (c.completeness.state === "complete" || (c.completeness.state === "limited" && c.completeness.code === "OUTPUT_LIMIT")) &&
      (c.hunks.length === 0 || c.support === "supported") &&
      c.hunks.every((h, i) => h.ordinal === i),
  )
  .meta({ title: "Comparison" });

// Contract §4 "Comparison limits" and §7 "Missing objects": no `comparisonId`, patch, or hunks. `objectRemedy` holds the §7 remedy text.
export const ComparisonObjectMissing = z
  .strictObject({
    completeness: z.strictObject({ state: z.literal("limited"), code: z.literal("OBJECT_MISSING") }),
    scope: ComparisonScope,
    support: z.null(),
    fileAction: FileActionValue,
    remedy: FileRemedy,
    objectRemedy: Remedy,
  })
  .meta({ title: "ComparisonObjectMissing" });

// Contract §4 "Comparison limits": an entry without index `flags` in a limited snapshot gets only the snapshot completeness.
export const ComparisonWithoutFlags = z
  .strictObject({ completeness: Completeness })
  .refine((c) => c.completeness.state === "limited")
  .meta({ title: "ComparisonWithoutFlags" });

// Contract §3 `readComparison`: a `failed` or `canceled` result carries no value.
export const ReadComparisonResult = z.union([Comparison, ComparisonObjectMissing, ComparisonWithoutFlags]).meta({ title: "ReadComparisonResult" });
export type ReadComparisonResult = z.infer<typeof ReadComparisonResult>;
export type Comparison = z.infer<typeof Comparison>;
export type ComparisonHunk = z.infer<typeof ComparisonHunk>;

// Contract §3 `cancel` and `getOperation`: the current or retained state of an issued operation (data-model §7).
// Contract §6 "Activity and stall notice": `stallRemedy` exists only while `stalled` is true.
export const OperationResult = z
  .strictObject({
    operationId: Identifier,
    operation: z.enum(OPERATION_NAMES),
    state: z.enum(OPERATION_STATES),
    phase: Phase.optional(),
    code: ErrorCodeSchema.optional(),
    cause: z.string().optional(),
    reason: z.string().optional(),
    stalled: z.boolean().optional(),
    stallRemedy: StallRemedy.optional(),
    endProcesses: z.boolean().optional(),
    lingering: z.boolean().optional(),
    lingeringDescendants: Count.optional(),
    rowId: Identifier.optional(),
  })
  .refine((r) => r.stallRemedy === undefined || r.stalled === true);

// Contract §3 `currentSession`: plan.md "Windows text size" gives the factor range.
export const SessionResult = z.strictObject({ sessionId: Identifier, textScale: z.number().min(1).max(2.25) });
