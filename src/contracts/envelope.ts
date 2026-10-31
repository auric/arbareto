// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import { BRANCH_NAME_BYTES } from "./branch-name";
import { DamagedMarker, decodedBytes, FILE_FACT_ERRORS, LinuxPath, REPLACE_ERRORS, REPLACE_REFUSALS, SYNC_ACTIONS, SyncAction, TRUST_ACTIONS, TrustDetails, UtcTime } from "./channel";
import { DictionaryFileName, LANGUAGE_NOTICES, LANGUAGE_STATES, LanguageId } from "./dictionaries";
import {
  BLAME_UNAVAILABLE_REASONS,
  DESTINATION_NOT_EMPTY_REASONS,
  DICTIONARY_UNAVAILABLE_REASONS,
  ERROR_CODES,
  HISTORY_CHANGED_REASONS,
  HISTORY_OUTPUT_LIMIT_REASONS,
  PUSH_REJECTED_REASONS,
  PUTTY_PROGRAMS,
  PUTTY_UNAVAILABLE_REASONS,
  REVERT_FILE_REASONS,
  SEARCH_UNSUPPORTED_REASONS,
  STALE_REVIEW_REASONS,
  STASH_KEPT_REASONS,
  SUBMODULE_UNAVAILABLE_REASONS,
  SYNC_OUTPUT_LIMIT_REASONS,
  SYNC_UNAVAILABLE_REASONS,
  TERMINAL_STATES,
  UNKNOWN_TARGET_REASONS,
  UNSUPPORTED_FILTER_TEXT_REASONS,
  UNTRACKED_IN_WAY_REASONS,
  WORKBENCH_UNAVAILABLE_REASONS,
  WSL_UNAVAILABLE_REASONS,
  type ErrorCode,
  type WorkbenchUnavailableReason,
} from "./errors";
import { FILE_ACTION_REASONS, LINE_ACTION_REASONS, type FileActionReason, type LineActionReason } from "./file-action";
import * as limits from "./limits";
import {
  BLAME_FILE_BYTES,
  BLAME_FILE_LINES,
  CANONICAL_DIFF_LINES,
  CLONE_URL_BYTES,
  COMMIT_MESSAGE_BYTES,
  DICTIONARY_CATALOG_ENTRIES,
  DICTIONARY_CHUNK_BYTES,
  DICTIONARY_LANGUAGE_BYTES,
  FILE_FACT_ENTRIES,
  GRAPH_LANES,
  HISTORY_PAGE_BYTES,
  HISTORY_PARENTS_PER_COMMIT,
  HISTORY_ROWS_PER_REQUEST,
  HISTORY_VIEW_COMMITS,
  IGNORE_TARGET_BYTES,
  KEY_FILE_ENTRIES,
  MERGE_MESSAGE_BYTES,
  MULTI_FILE_ACTION_FILES,
  PREVIEW_GROUP_PATHS,
  PUBLIC_REQUEST_BYTES,
  REF_LISTING_RECORDS,
  REGISTERED_WORKSPACES,
  SPELLING_LANGUAGES,
  STATUS_LISTING_RECORDS,
  SYNC_FETCH_LISTED_REFS,
  SYNC_LEASE_COMMITS,
  SYNC_REFS_RECORDS,
  SYNC_REMOTES,
  WORKTREE_RECORDS,
} from "./limits";
import {
  ChannelPath,
  ConfigScope,
  Count,
  Direction,
  DistroName,
  FileDirection,
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
// zod `max` counts code points, which never exceed UTF-8 bytes. The refinement checks the byte bound.
const message = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine((m) => m.isWellFormed() && !m.includes("\u0000") && !/^[ \t\n\r]*$/.test(m) && new TextEncoder().encode(m).length <= bytes);
// Contract §5 for a commit. Feature 004 contract Δ5 for a merge: the `-m` item must fit the command line (plan D5).
const CommitMessage = message(COMMIT_MESSAGE_BYTES);
const MergeMessage = message(MERGE_MESSAGE_BYTES);
const ReadWorkspacePayload = z
  .strictObject({ refresh: z.boolean(), check: z.enum(["full", "changes"]) })
  .refine((p) => !(p.refresh && p.check !== "full"));

// Contract §3 names the values. The field names `snapshotId`, `entryId`, `trustId`, `comparisonId`, `hunkId`, `operationId`, `choice`, and `markerId` follow test T012.
const GetEnvironment = op("getEnvironment", {}, empty());
const ReadWorkspace = op("readWorkspace", { ...repository, repositoryGeneration: Generation.optional() }, ReadWorkspacePayload);
// Contract §3 fixes no cursor form. The service issues each cursor, so it is a contract §2 identifier.
const ReadEntries = op("readEntries", snapshot, z.strictObject({ snapshotId: Identifier, cursor: Identifier }));
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
// `from` is an inclusive view row index where a match search starts (contract Δ3).
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
// Feature 004 contract Δ7: the payload names the action of the dialog. No fingerprint binds the approval (data-model §10).
const ApproveTrust = op("approveTrust", repository, z.strictObject({ action: z.enum(TRUST_ACTIONS) }));
const RevokeTrust = op("revokeTrust", repository, z.strictObject({ trustId: Identifier }));
// Feature 004 data-model §6: ascending unique ordinals of `+` and `-` lines of the retained hunk. The 001 canonical diff bound caps a hunk body.
const LineOrdinals = z
  .array(z.int().min(1).max(CANONICAL_DIFF_LINES))
  .min(1)
  .max(CANONICAL_DIFF_LINES)
  .refine((lines) => lines.every((line, i) => i === 0 || line > lines[i - 1]!));
const ApplyHunk = op(
  "applyHunk",
  snapshot,
  z.strictObject({ comparisonId: Identifier, hunkId: Identifier, snapshotId: Identifier, direction: Direction, lines: LineOrdinals.optional() }),
);
const ApplyFile = op("applyFile", snapshot, z.strictObject({ comparisonId: Identifier, snapshotId: Identifier, direction: FileDirection }));
// Feature 004 contract Δ3: only an amend review can rewrite the upstream, so `confirmRewrite` comes only with `amend`.
const ReviewCommit = op("reviewCommit", snapshot, z.strictObject({ snapshotId: Identifier, amend: z.literal(true).optional() }));
const Commit = op(
  "commit",
  snapshot,
  z
    .strictObject({ reviewToken: Identifier, message: CommitMessage, confirmFullScope: z.literal(true), amend: z.literal(true).optional(), confirmRewrite: z.literal(true).optional() })
    .refine((p) => p.confirmRewrite === undefined || p.amend === true),
);
// Feature 004 contract Δ12: `scope` names one row, and the review covers it and its nested rows.
const ReviewSubmodules = op("reviewSubmodules", snapshot, z.strictObject({ snapshotId: Identifier, scope: z.strictObject({ path: Text.min(1) }).optional() }));
const UpdateSubmodules = op("updateSubmodules", snapshot, z.strictObject({ submoduleReviewToken: Identifier, start: z.literal(true), confirmHosts: z.literal(true).optional() }));
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

// ---- Feature 003 operations (contract Δ1 to Δ3) ----

// A name from `git remote`. The service checks membership and refuses another name with INVALID_REQUEST.
const RemoteName = Text.min(1);
const SyncMode = z.enum(["rebase", "merge"]);
// The service checks `refs/heads/<branch>` with `isRefName`.
const PushDestinationChoice = z.strictObject({ remote: RemoteName, branch: Text.min(1), setUpstream: z.boolean() }).meta({ title: "PushDestinationChoice" });
const ReviewSyncPayload = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("fetch"), remote: RemoteName.optional() }).meta({ title: "ReviewFetch" }),
  z.strictObject({ action: z.literal("fetch-all") }).meta({ title: "ReviewFetchAll" }),
  z.strictObject({ action: z.literal("pull"), mode: SyncMode.optional() }).meta({ title: "ReviewPull" }),
  z.strictObject({ action: z.literal("integrate"), mode: SyncMode }).meta({ title: "ReviewIntegrate" }),
  z.strictObject({ action: z.literal("push"), destination: PushDestinationChoice.optional() }).meta({ title: "ReviewPush" }),
  z.strictObject({ action: z.literal("force-push") }).meta({ title: "ReviewForcePush" }),
  z.strictObject({ action: z.literal("abort") }).meta({ title: "ReviewAbort" }),
  z.strictObject({ action: z.literal("continue") }).meta({ title: "ReviewContinue" }),
  z.strictObject({ action: z.literal("skip") }).meta({ title: "ReviewSkip" }),
]);
// Contract Δ3 `clone`: 1 to 4,096 UTF-8 bytes and no control character (Unicode category Cc).
const CloneUrl = z
  .string()
  .min(1)
  .max(CLONE_URL_BYTES)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/)
  .refine((url) => url.isWellFormed() && new TextEncoder().encode(url).length <= CLONE_URL_BYTES);
// Data-model §10.
export const DEFAULT_PULL_ACTIONS = ["pull", "pull-merge", "pull-rebase", "fetch", "fetch-all"] as const;
// Data-model §10: a key file belongs to one worktree and remote. The other targets name neither.
const SyncPathTarget = z
  .strictObject({ target: z.enum(["plink", "remoteKey", "cloneFolder"]), worktreeKey: Fingerprint.optional(), remote: RemoteName.optional() })
  .refine((p) => (p.target === "remoteKey") === (p.worktreeKey !== undefined) && (p.target === "remoteKey") === (p.remote !== undefined));

const ReadTracking = op("readTracking", snapshot, empty());
const ReviewSync = op("reviewSync", snapshot, ReviewSyncPayload);
const Sync = op("sync", repository, z.strictObject({ syncReviewToken: Identifier, start: z.literal(true) }));
const Clone = op("clone", {}, z.strictObject({ url: CloneUrl, destination: ChannelPath, keyFile: z.enum(["none", "picked"]) }));
// Data-model §11: a clone target without a workspace has no repository.
const ConnectInTerminal = op("connectInTerminal", { repositoryId: Identifier.optional() }, z.strictObject({ operationId: Identifier }));
const ReadSyncSettings = op("readSyncSettings", {}, empty());
const SetSshClient = op("setSshClient", {}, z.strictObject({ kind: z.enum(["git", "plink"]) }));
const SetDefaultPullAction = op("setDefaultPullAction", {}, z.strictObject({ action: z.enum(DEFAULT_PULL_ACTIONS) }));
const ChooseSyncPath = op("chooseSyncPath", {}, SyncPathTarget);
const ClearSyncPath = op("clearSyncPath", {}, SyncPathTarget);
const LaunchPuttygen = op("launchPuttygen", {}, empty());

// ---- Feature 004 operations (contract Δ1 to Δ3, data-model §2 to §13) ----

// Plan D4 name rule: 1 to 255 UTF-8 bytes, well-formed, no NUL. The service refuses `@` and runs `check-ref-format`.
const BranchName = Text.min(1)
  .max(BRANCH_NAME_BYTES)
  .refine((name) => new TextEncoder().encode(name).length <= BRANCH_NAME_BYTES);
// Contract Δ3: `<ref>` is a full ref name from the review. Data-model §1: a branch is under `refs/heads/` or `refs/remotes/`.
const refUnder = (...prefixes: string[]) => Text.refine((ref) => prefixes.some((prefix) => ref.length > prefix.length && ref.startsWith(prefix)));
const LocalRef = refUnder("refs/heads/");
const RemoteRef = refUnder("refs/remotes/");
const BranchRef = refUnder("refs/heads/", "refs/remotes/");
// Contract Δ3 `choose-side` and `mergetool` name an entry of the shown snapshot.
const shownEntry = { snapshotId: Identifier, entryId: Identifier };
// Contract Δ5 "Config changes per Save". It is no output bound, so `limits.ts` does not list it.
const CONFIG_CHANGES = 32;
const ConfigChanges = z
  .array(z.strictObject({ key: Text.min(1), value: Text.nullable() }))
  .min(1)
  .max(CONFIG_CHANGES)
  .refine((changes) => new Set(changes.map((c) => c?.key)).size === changes.length);
const SwitchTarget = z.union([
  z.strictObject({ ref: LocalRef }).meta({ title: "SwitchLocal" }),
  z.strictObject({ track: z.strictObject({ ref: RemoteRef, name: BranchName }) }).meta({ title: "SwitchTrack" }),
  z.strictObject({ detach: ObjectId }).meta({ title: "SwitchDetach" }),
]);
const WorktreeBranch = z.union([
  z.strictObject({ new: BranchName, start: ObjectId }).meta({ title: "WorktreeNewBranch" }),
  z.strictObject({ existing: LocalRef }).meta({ title: "WorktreeExistingBranch" }),
  z.strictObject({ track: z.strictObject({ ref: RemoteRef, name: BranchName }) }).meta({ title: "WorktreeTrackBranch" }),
]);
// Contract Δ3: the renderer sends the path, and the shell forwards the `bootstrapId` of its `worktreeAdd` binding.
const worktreeAdd = <T extends z.ZodRawShape>(binding: T) => z.strictObject({ action: z.literal("worktree-add"), branch: WorktreeBranch, ...binding }).meta({ title: "ReviewWorktreeAdd" });
const WorktreeAddRenderer = worktreeAdd({ path: ChannelPath });

// ---- Feature 005 payload parts (contract Δ3, data-model §7, §8, §10) ----

const IgnoreTarget = z.enum(["gitignore", "exclude"]);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// Contract Δ3 `previewIgnore`: base64 of at most 1 MiB of strict UTF-8 bytes. `atob` exists in Bun and in WebView2.
// zod runs a refinement also after a failed format check, and `atob` throws on other text.
const editorText = (allowNul: boolean) =>
  z.base64().refine((data) => {
    try {
      if (decodedBytes(data) > IGNORE_TARGET_BYTES) return false;
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      strictUtf8.decode(bytes);
      return allowNul || !bytes.includes(0);
    } catch {
      return false;
    }
  });
const PreviewText = editorText(false);
// Contract Δ3 `ignore-save`: a NUL in the text gives the review refusal `ignore-nul`, so the schema passes it.
const SaveText = editorText(true);
// Plan.md D8: the line-ending form that Save writes for all lines.
const SaveLineEnding = z.enum(["lf", "crlf"]);
// Data-model §6 `expected`: the loaded state of the ignore file.
const IgnoreExpected = z.union([z.literal("absent"), z.strictObject({ size: Count.max(IGNORE_TARGET_BYTES), sha256: Fingerprint }).meta({ title: "IgnoreDigest" })]);
const DeleteMode = z.enum(["recycle", "permanent"]);
const uniqueIds = (ids: unknown) => Array.isArray(ids) && new Set(ids).size === ids.length;

const reviewWorkbench = <A extends z.ZodObject>(add: A) =>
  z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("switch"), target: SwitchTarget, choice: z.enum(["keep", "stash", "discard"]) }).meta({ title: "ReviewSwitch" }),
    z.strictObject({ action: z.literal("create-branch"), name: BranchName, start: ObjectId, switchTo: z.boolean() }).meta({ title: "ReviewCreateBranch" }),
    z.strictObject({ action: z.literal("rename-branch"), ref: LocalRef, name: BranchName }).meta({ title: "ReviewRenameBranch" }),
    z.strictObject({ action: z.literal("delete-branch"), ref: LocalRef }).meta({ title: "ReviewDeleteBranch" }),
    // Data-model §5: Squash disables No fast-forward and Don't commit, and sends no message (plan D5, research R21 F30).
    z
      .strictObject({ action: z.literal("merge"), ref: BranchRef, result: z.enum(["merge", "squash"]), noFastForward: z.boolean(), noCommit: z.boolean(), message: MergeMessage.nullable() })
      .refine((p) => p.result !== "squash" || (p.noFastForward === false && p.noCommit === false && p.message === null))
      .meta({ title: "ReviewMerge" }),
    z.strictObject({ action: z.literal("rebase"), ref: BranchRef, autostash: z.boolean(), autosquash: z.boolean() }).meta({ title: "ReviewRebase" }),
    z.strictObject({ action: z.literal("choose-side"), ...shownEntry, side: z.enum(["ours", "theirs"]) }).meta({ title: "ReviewChooseSide" }),
    z.strictObject({ action: z.literal("mergetool"), ...shownEntry }).meta({ title: "ReviewMergetool" }),
    add,
    // Contract Δ11: the record path of a WSL repository is a Linux path, so the service matches the text with a fresh list.
    z.strictObject({ action: z.literal("worktree-remove"), worktree: Text.min(1), force: z.boolean(), deleteBranch: z.boolean() }).meta({ title: "ReviewWorktreeRemove" }),
    z.strictObject({ action: z.literal("worktree-prune") }).meta({ title: "ReviewWorktreePrune" }),
    z.strictObject({ action: z.literal("config-save"), scope: z.enum(["local", "global"]), changes: ConfigChanges }).meta({ title: "ReviewConfigSave" }),
    // Feature 005 contract Δ3. `folder` holds the base64 folder bytes of a folder row.
    z
      .strictObject({ action: z.literal("delete"), snapshotId: Identifier, entryIds: z.array(Identifier).min(1).max(MULTI_FILE_ACTION_FILES), folder: z.base64().min(1).optional(), mode: DeleteMode })
      .refine((p) => uniqueIds(p.entryIds))
      .meta({ title: "ReviewDelete" }),
    z.strictObject({ action: z.literal("ignore-save"), target: IgnoreTarget, text: SaveText, expected: IgnoreExpected, lineEnding: SaveLineEnding.optional() }).meta({ title: "ReviewIgnoreSave" }),
    // Feature 008 data-model §1. Without `lines`, the whole hunk. The renderer sends no path, no byte, and no count.
    z.strictObject({ action: z.literal("revert-lines"), snapshotId: Identifier, comparisonId: Identifier, hunkId: Identifier, lines: LineOrdinals.optional() }).meta({ title: "ReviewRevertLines" }),
    z
      .strictObject({ action: z.literal("revert-files"), snapshotId: Identifier, entryIds: z.array(Identifier).min(1).max(MULTI_FILE_ACTION_FILES) })
      .refine((p) => uniqueIds(p.entryIds))
      .meta({ title: "ReviewRevertFiles" }),
    z.strictObject({ action: z.literal("revert-unstaged"), snapshotId: Identifier }).meta({ title: "ReviewRevertUnstaged" }),
  ]);
// Data-model §6 and plan D8: Stage all untracked and Stage all changes stage, and Unstage all unstages. `folder` holds the folder path bytes in base64.
const STAGE_KINDS: readonly string[] = ["all-untracked", "all-changes"];
const ApplyFilesPayload = z
  .strictObject({
    snapshotId: Identifier,
    entryIds: z.array(Identifier).min(1).max(MULTI_FILE_ACTION_FILES),
    direction: Direction,
    kind: z.enum(["selected", "folder", "all-untracked", "all-changes", "all-staged"]),
    folder: z.base64().min(1).optional(),
  })
  .refine(
    (p) =>
      Array.isArray(p.entryIds) &&
      new Set(p.entryIds).size === p.entryIds.length &&
      (p.kind === "folder") === (p.folder !== undefined) &&
      (p.kind === "all-staged" ? p.direction === "unstage" : !STAGE_KINDS.includes(p.kind) || p.direction === "stage"),
  );

const ReadBranches = op("readBranches", snapshot, empty());
const ReadWorktrees = op("readWorktrees", snapshot, empty());
// Contract Δ3: without `repositoryId`, the read runs in the `globalConfig` context.
const ReadGitSettings = op("readGitSettings", { repositoryId: Identifier.optional() }, empty());
const ReviewWorkbench = op("reviewWorkbench", snapshot, reviewWorkbench(WorktreeAddRenderer));
const RunWorkbench = op("runWorkbench", repository, z.strictObject({ workbenchToken: Identifier, start: z.literal(true) }));
const ApplyFiles = op("applyFiles", repository, ApplyFilesPayload);
// Contract Δ3: `path` is the record path. The shell checks it by the 001 Windows rules or the §11 WSL route.
const OpenWorktree = op("openWorktree", {}, z.strictObject({ repositoryId: Identifier, path: Text.min(1) }));
// Contract Δ3: the service maps the entry of its current read to a path and sends the private `reveal` request.
// Feature 005 contract Δ3: `folder` holds the base64 bytes of a proper prefix of the entry path that a `/` follows. The service checks the prefix.
const RevealPath = op("revealPath", {}, z.strictObject({ repositoryId: Identifier, entryId: Identifier, folder: z.base64().min(1).optional() }));
// Data-model §13: `discard` is no stored choice (spec FR-010).
const SwitchChoice = z.enum(["keep", "stash"]);
const SetSwitchChoice = op("setSwitchChoice", {}, z.strictObject({ choice: SwitchChoice }));
// Contract Δ3: the shell checks the picked folder against the route of this repository.
const ChooseWorktreeFolder = op("chooseWorktreeFolder", {}, z.strictObject({ repositoryId: Identifier }));

// ---- Feature 005 operations (contract Δ1 to Δ3) ----

// `fileId` is the 0-based record ordinal of the retained listing (data-model §1).
const changesFile = { changesId: Identifier, fileId: z.int().min(0).max(STATUS_LISTING_RECORDS - 1) };
const ReadCommitChanges = op("readCommitChanges", snapshot, z.strictObject({ viewId: Identifier, oid: ObjectId, parent: z.int().min(0).max(HISTORY_PARENTS_PER_COMMIT - 1) }));
const ReadCommitFile = op("readCommitFile", snapshot, z.strictObject(changesFile));
const BlameSource = z.union([
  z.strictObject(changesFile).meta({ title: "BlameCommitFile" }),
  z.strictObject({ snapshotId: Identifier, entryId: Identifier }).meta({ title: "BlameWorkingFile" }),
  z.strictObject({ blameId: Identifier, line: z.int().min(1).max(BLAME_FILE_LINES) }).meta({ title: "BlameBefore" }),
  z.strictObject({ blameId: Identifier }).meta({ title: "BlameRerun" }),
]);
const BlameOptions = z.strictObject({ ignoreWhitespace: z.boolean(), detectMoves: z.boolean(), detectCopies: z.boolean(), ignoreList: z.boolean() }).meta({ title: "BlameOptions" });
const ReadBlame = op("readBlame", snapshot, z.strictObject({ source: BlameSource, options: BlameOptions }));
const ReadIgnoreFile = op("readIgnoreFile", snapshot, z.strictObject({ target: IgnoreTarget }));
const PreviewIgnore = op("previewIgnore", snapshot, z.strictObject({ target: IgnoreTarget, text: PreviewText, snapshotId: Identifier, lineEnding: SaveLineEnding.optional() }));
// Contract Δ3 `openSubmodule`: worktree-relative text with `/` separators. The shell also checks each component by the 001 §6 rule.
const SubmodulePath = Text.min(1).refine((path) => path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const OpenSubmodule = op("openSubmodule", {}, z.strictObject({ repositoryId: Identifier, path: SubmodulePath }));

// ---- Feature 006 operations (contract Δ1 to Δ3, data-model §5 to §8) ----

// Contract Δ3: the service checks `language` against the catalog, and the shell against its embedded catalog.
const language = () => z.strictObject({ language: LanguageId });
// Data-model §8: 0 to 3 unique IDs in the user's order.
export const SpellingSetting = z
  .strictObject({ enabled: z.boolean(), languages: z.array(LanguageId).max(SPELLING_LANGUAGES).refine((ids) => new Set(ids).size === ids.length) })
  .meta({ title: "SpellingSetting" });
const ListDictionaries = op("listDictionaries", {}, empty());
// Contract Δ3: the service checks that `offset` lies below the file size.
const ReadDictionary = op("readDictionary", {}, z.strictObject({ language: LanguageId, file: DictionaryFileName, offset: Count.multipleOf(DICTIONARY_CHUNK_BYTES) }));
const DownloadDictionary = op("downloadDictionary", {}, language());
// Contract Δ3: the renderer never sends a path. The shell forwards the picked folder.
const ImportDictionary = op("importDictionary", {}, language());
const RemoveDictionary = op("removeDictionary", {}, language());
const SetSpelling = op("setSpelling", {}, SpellingSetting);
// Contract Δ3: the renderer never sends a URL.
const OpenLicenceLink = op("openLicenceLink", {}, language());

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
  ReadTracking,
  ReviewSync,
  Sync,
  Clone,
  ConnectInTerminal,
  ReadSyncSettings,
  SetSshClient,
  SetDefaultPullAction,
  ChooseSyncPath,
  ClearSyncPath,
  LaunchPuttygen,
  ReadBranches,
  ReadWorktrees,
  ReadGitSettings,
  ReviewWorkbench,
  RunWorkbench,
  ApplyFiles,
  OpenWorktree,
  RevealPath,
  SetSwitchChoice,
  ChooseWorktreeFolder,
  ReadCommitChanges,
  ReadCommitFile,
  ReadBlame,
  ReadIgnoreFile,
  PreviewIgnore,
  OpenSubmodule,
  ListDictionaries,
  ReadDictionary,
  DownloadDictionary,
  ImportDictionary,
  RemoveDictionary,
  SetSpelling,
  OpenLicenceLink,
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
  // Feature 003 contract Δ1.
  Clone,
  ReadSyncSettings,
  SetSshClient,
  SetDefaultPullAction,
  ChooseSyncPath,
  ClearSyncPath,
  LaunchPuttygen,
  // Feature 004 contract Δ1: only the `worktree-add` review is native-first.
  op("reviewWorkbench", snapshot, WorktreeAddRenderer),
  OpenWorktree,
  SetSwitchChoice,
  ChooseWorktreeFolder,
  // Feature 005 contract Δ1.
  OpenSubmodule,
  // Feature 006 contract Δ1.
  ImportDictionary,
  SetSpelling,
  OpenLicenceLink,
]);

// Contract §6 "Dismissal": without `bootstrapId`, the stored worktree path does not exist.
export const ServiceEnvelope = z.discriminatedUnion("operation", [
  GetEnvironment,
  op("chooseGit", {}, z.strictObject({ bootstrapId: Identifier, executablePath: ChannelPath })),
  op("chooseRepository", {}, z.strictObject({ bootstrapId: Identifier })),
  op("restoreWorkspace", {}, z.strictObject({ bootstrapId: Identifier })),
  ReadWorkspace,
  ReadEntries,
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
  ReadTracking,
  ReviewSync,
  Sync,
  // Feature 003 contract Δ3 `clone`: the shell binds the destination and forwards its IDs.
  op("clone", {}, z.strictObject({ url: CloneUrl, bootstrapId: Identifier, cloneId: Identifier })),
  ConnectInTerminal,
  ReadBranches,
  ReadWorktrees,
  ReadGitSettings,
  // Feature 004 contract Δ3: the shell binds the `worktree-add` path and forwards its `bootstrapId`.
  op("reviewWorkbench", snapshot, reviewWorkbench(worktreeAdd({ bootstrapId: Identifier }))),
  RunWorkbench,
  ApplyFiles,
  op("openWorktree", {}, z.strictObject({ repositoryId: Identifier, bootstrapId: Identifier })),
  RevealPath,
  ReadCommitChanges,
  ReadCommitFile,
  ReadBlame,
  ReadIgnoreFile,
  PreviewIgnore,
  // Feature 005 contract Δ3: the shell binds the joined path to a `repositoryDiscovery` context and forwards its `bootstrapId`.
  op("openSubmodule", {}, z.strictObject({ repositoryId: Identifier, bootstrapId: Identifier, path: SubmodulePath })),
  ListDictionaries,
  ReadDictionary,
  DownloadDictionary,
  // Feature 006 contract Δ3 `importDictionary`: `folder` is the channel path that the shell picker returned.
  op("importDictionary", {}, z.strictObject({ language: LanguageId, folder: ChannelPath })),
  RemoveDictionary,
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

export { ConfigScope };
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

// Contract §3 `readTrust` and feature 004 data-model §10. `persistence` is `session` only after a failed store.
// `inputLimited` marks a listing above the contract §5 "Effective configuration/trust input" bound. Only an approved or changed state carries a `trustId`.
// `programs` names the repository-controlled programs for the status chip (spec FR-073), as the `confirm` frame `details` do.
export const ReadTrustResult = z
  .union([
    z
      .strictObject({
        generation: Generation,
        state: z.enum(["untrusted", "approved", "changed", "revoked"]),
        persistence: TrustPersistence,
        trustId: Identifier.optional(),
        // Feature 003 contract Δ7 adds `sync`. Feature 004 contract Δ7 adds `workbench` (T033) and `mergetool` (T060).
        approvalRequired: z.strictObject({ reads: z.boolean(), commit: z.boolean(), sync: z.boolean(), workbench: z.boolean(), mergetool: z.boolean() }),
        inputLimited: z.literal(true).optional(),
        entries: z.array(TrustEntry).max(limits.TRUST_REPORT_ENTRIES),
        hooks: z.array(TrustHook).max(limits.TRUST_REPORT_HOOKS),
        programs: TrustDetails,
      })
      .refine((r) => (r.state === "approved" || r.state === "changed") === (r.trustId !== undefined))
      .meta({ title: "TrustReport" }),
    TrustListingFailed,
    TrustReportLimited,
  ])
  .meta({ title: "ReadTrustResult" });

// Contract §3 `approveTrust`: `saveFailed` is true only after an approval that the shell could not store.
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
const INELIGIBLE_REASONS = ["sparse-index", "split-index", "index-change-hook", "executable-monitor", "unqualified-monitor", "shared-repository"] as const;
export const HunkEligibility = z
  .union([
    z.strictObject({ eligible: z.literal(true) }).meta({ title: "Eligible" }),
    z
      .strictObject({ eligible: z.literal(false), reason: z.enum(INELIGIBLE_REASONS) })
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
// A `retained` result holds no page: `entries` is empty and `cursor` is null.
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
    // Feature 004 contract Δ4 "Status cut": `untracked` keeps every tracked, unmerged, and staged entry. Null for a complete read.
    cut: z.enum(["untracked", "other"]).nullable().optional(),
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
  .refine(
    (r) =>
      r.completeness.state !== "failed" &&
      (r.readKind === "retained" ? r.entries.length === 0 && r.cursor === null : r.cursor === null ? r.entries.length === r.entryCount : r.entries.length > 0 && r.entries.length < r.entryCount),
  )
  .refine((r) => r.cut === undefined || r.cut === null || r.completeness.state === "limited")
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

export type HistoryRow = z.infer<typeof HistoryRow>;

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
    // Feature 005 contract Δ3 (001 §3): the raw name bytes in base64, present exactly when `invalidUtf8` is true. The tree order keys on them.
    nameBytes: z.base64().min(1).optional(),
    commitId: ObjectId.nullable(),
  })
  .refine((r) => r.invalidUtf8 === (r.nameBytes !== undefined))
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
// `complete` states the view. A refused load of a stale complete view carries `complete: true` and the stale reason. An `OUTPUT_LIMIT` bound stops the load, so its view is never complete.
export const LoadHistoryResult = z
  .strictObject({ rows: Count.max(HISTORY_VIEW_COMMITS), complete: z.boolean(), reason: ViewReason.optional(), remedy: ViewRemedy.optional() })
  .refine((r) => !r.complete || (r.reason !== "HISTORY_VIEW_COMMITS" && r.reason !== "HISTORY_PARENTS_PER_COMMIT"))
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
// `layoutStep` (src/git-service/history-layout.ts) draws one line per open lane above and one line per parent lane or one stub below.
export const GraphCell = z
  .strictObject({ node: Lane, color: Count, merge: z.boolean(), limited: z.boolean(), segments: z.array(GraphSegment).max(2 * GRAPH_LANES), marks: z.array(z.enum(["root", "shallow"])) })
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
    labels: z.array(z.strictObject({ kind: z.enum(["branch", "remote", "tag", "stash"]), name: z.string(), invalidUtf8: z.boolean() })).max(REF_LISTING_RECORDS),
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

// `rowCount` is the rows that the view holds. `lanes` is the most lanes so far. `bytes` is the encoded result size for the renderer cache.
const RowsState = { rowCount: Count.max(HISTORY_VIEW_COMMITS), lanes: z.int().min(1).max(GRAPH_LANES), complete: z.boolean(), bytes: Count.max(HISTORY_PAGE_BYTES) };
// Only `target: "found"` carries rows.
export const ReadHistoryRowsResult = z
  .union([
    z
      .strictObject({ target: z.literal("found"), rows: z.array(HistoryViewRow).max(HISTORY_ROWS_PER_REQUEST), cut: z.boolean(), ...RowsState })
      .refine((r) => r.rows.every((row, i) => row.index < r.rowCount && (i === 0 || row.index > r.rows[i - 1]!.index)))
      .meta({ title: "HistoryRows" }),
    z.strictObject({ target: z.enum(["unknown", "none"]), ...RowsState }).meta({ title: "HistoryRowsTarget" }),
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
// Feature 003 contract Δ3 and Δ4: `resolve` accepts a conflicted entry. Feature 004 data-model §6: a line refusal never occurs here.
const LINE_REASONS: readonly string[] = LINE_ACTION_REASONS;
const FileActionValue = z.enum(["stage", "unstage", "resolve", "state", ...FILE_ACTION_REASONS.filter((r): r is Exclude<FileActionReason, "blob-proof" | LineActionReason> => r !== "blob-proof" && !LINE_REASONS.includes(r))]);
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

// ---- Feature 003 results (contract Δ3, data-model §1 to §10) ----

// Data-model §1. `upstream` is null without an upstream, and only then the track is `none`.
export const TrackingEntry = z
  .strictObject({
    name: z.string(),
    invalidUtf8: z.boolean(),
    objectId: ObjectId,
    upstream: z.string().nullable(),
    upstreamObjectId: ObjectId.nullable(),
    track: z.discriminatedUnion("state", [
      z.strictObject({ state: z.literal("none") }).meta({ title: "TrackNone" }),
      z.strictObject({ state: z.literal("gone") }).meta({ title: "TrackGone" }),
      z.strictObject({ state: z.literal("counts"), ahead: Count, behind: Count }).meta({ title: "TrackCounts" }),
    ]),
    current: z.boolean(),
  })
  .refine((e) => (e.upstream === null) === (e.track?.state === "none") && (e.upstream !== null || e.upstreamObjectId === null))
  .meta({ title: "TrackingEntry" });
// Contract Δ3 `readTracking`: the entries, or the `readRefs` refusal form for a bound or a failed read. At most one entry is current.
export const ReadTrackingResult = z
  .union([
    z
      .strictObject({ entries: z.array(TrackingEntry).max(REF_LISTING_RECORDS) })
      .refine((r) => !Array.isArray(r.entries) || r.entries.filter((e) => e?.current === true).length <= 1)
      .meta({ title: "TrackingList" }),
    RefsRefusal,
  ])
  .meta({ title: "ReadTrackingResult" });

export { SYNC_ACTIONS };
// A display remedy: a copyable command, or null when the URL holds user information (contract Δ3 "Remedies").
const SyncRemedy = z.strictObject({ text: z.string().min(1), command: z.string().nullable() }).meta({ title: "SyncRemedy" });

// Data-model §3. `url` is the one push URL, redacted for display. `matching` always gives `panel`.
export const PushDestination = z
  .strictObject({
    remote: RemoteName,
    ref: Text.min(1),
    trackingRef: Text.min(1).nullable(),
    url: z.string(),
    setUpstream: z.boolean(),
    // Contract Δ3 Set upstream: the write of `branch.<name>.rebase` applies. Only with `setUpstream`.
    upstreamRebase: z.boolean(),
    source: z.enum(["remote-push-refspec", "push-default-upstream", "push-default-branch", "push-default-triangular", "panel"]),
  })
  .refine((d) => d.setUpstream || !d.upstreamRebase)
  .meta({ title: "PushDestination" });
// Plan.md D5: the commits that the force push removes. `count` is exact, and `commits` holds the first of them.
const Lease = z
  .strictObject({
    trackingRef: Text.min(1),
    expect: ObjectId,
    count: Count,
    commits: z.array(z.strictObject({ objectId: ObjectId, subject: z.string().nullable() }).meta({ title: "LeaseCommit" })).max(SYNC_LEASE_COMMITS),
  })
  .refine((l) => Array.isArray(l.commits) && l.commits.length === Math.min(l.count, SYNC_LEASE_COMMITS))
  .meta({ title: "Lease" });
// Plan.md D4 step 0 and FR-016: the panel lists the remotes, pre-fills a destination when Git gives one, and states the Set upstream default.
const NeedsDestination = z
  .strictObject({
    remotes: z.array(RemoteName).min(1).max(SYNC_REMOTES),
    prefill: z.strictObject({ remote: RemoteName, ref: Text.min(1) }).meta({ title: "PanelPrefill" }).nullable(),
    setUpstream: z.boolean(),
    // Contract Δ3 Set upstream: the panel names `branch.<name>.rebase` among the keys when it is true.
    upstreamRebase: z.boolean(),
  })
  .meta({ title: "NeedsDestination" });
// Data-model §2: the bound values for display.
export const SyncPlan = z
  .strictObject({
    remotes: z.array(RemoteName).max(SYNC_REMOTES),
    upstream: z.strictObject({ ref: Text.min(1), objectId: ObjectId }).meta({ title: "PlanUpstream" }).optional(),
    destination: PushDestination.optional(),
    lease: Lease.optional(),
    mode: SyncMode.nullable().optional(),
    operationState: z.enum(["merging", "rebasing"]).optional(),
    // Contract Δ3 read 8. `subject` is null for a commit object above `HISTORY_COMMIT_OBJECT_BYTES`.
    skippedCommit: z.strictObject({ objectId: ObjectId, subject: z.string().nullable() }).meta({ title: "SkippedCommit" }).optional(),
    needsDestination: NeedsDestination.optional(),
  })
  .meta({ title: "SyncPlan" });
// Contract Δ3 `reviewSync`: a push without a destination gives `needsDestination` and no token.
// A refusal names its `SYNC_UNAVAILABLE` or `OUTPUT_LIMIT` reason, or the unmerged count of `CONFLICTED`.
export const ReviewSyncResult = z
  .union([
    z
      .strictObject({ action: SyncAction, plan: SyncPlan, syncReviewToken: Identifier.optional() })
      .refine(
        (r) =>
          (r.syncReviewToken === undefined) === (r.plan?.needsDestination !== undefined) &&
          (r.plan?.needsDestination === undefined || r.action === "push") &&
          (r.plan?.skippedCommit !== undefined) === (r.action === "skip"),
      )
      .meta({ title: "SyncReviewed" }),
    // `remedy`: the terminal command of a `rebase-exec` refusal.
    z.strictObject({ reason: z.enum([...SYNC_UNAVAILABLE_REASONS, ...SYNC_OUTPUT_LIMIT_REASONS]).optional(), unmerged: Count.optional(), remedy: SyncRemedy.optional() }).meta({ title: "SyncRefused" }),
  ])
  .meta({ title: "ReviewSyncResult" });

// git-fetch(1) OUTPUT: the flags of a `--porcelain` line.
export const FETCH_FLAGS = [" ", "+", "-", "t", "*", "!", "="] as const;
const FetchFlag = z.enum(FETCH_FLAGS);
// Data-model §4. `updates` lists the first lines of each remote. `counts` covers all its lines.
const FetchRemote = z
  .strictObject({
    name: RemoteName,
    state: z.enum(["succeeded", "failed", "canceled", "deadline", "not-started"]),
    updates: z.array(z.strictObject({ flag: FetchFlag, oldObjectId: ObjectId, newObjectId: ObjectId, ref: Text.min(1) }).meta({ title: "FetchUpdate" })).max(SYNC_FETCH_LISTED_REFS),
    counts: z.record(FetchFlag, Count),
    outputTail: OutputTail,
  })
  .meta({ title: "FetchRemote" });
// `observed`: the ref changes of the before and after listings that no line names. Null: the ref is absent on that side.
export const FetchResult = z
  .strictObject({
    remotes: z.array(FetchRemote).max(SYNC_REMOTES),
    observed: z.array(z.strictObject({ ref: Text.min(1), oldObjectId: ObjectId.nullable(), newObjectId: ObjectId.nullable() }).meta({ title: "ObservedRef" })).max(SYNC_REFS_RECORDS),
  })
  .meta({ title: "FetchResult" });
// Data-model §5. `reasonText` is display text only (FR-015).
export const PushResult = z
  .strictObject({
    status: z.enum(["pushed", "forced", "created", "up-to-date", "rejected", "remote-rejected", "remote-failure", "none"]),
    oldObjectId: ObjectId.nullable(),
    newObjectId: ObjectId.nullable(),
    reasonText: z.string().nullable(),
    lease: z.boolean(),
    upstreamWritten: z.boolean(),
    // Contract Δ3 Set upstream: a write after a successful push did not exit 0.
    upstreamNotSet: z.boolean(),
    outputTail: OutputTail,
  })
  .meta({ title: "PushResult" });
// Data-model §7.
export const Integration = z
  .discriminatedUnion("state", [
    z.strictObject({ state: z.literal("none") }).meta({ title: "IntegrationNone" }),
    z.strictObject({ state: z.literal("up-to-date") }).meta({ title: "IntegrationUpToDate" }),
    z.strictObject({ state: z.literal("mode-required") }).meta({ title: "IntegrationModeRequired" }),
    z.strictObject({ state: z.literal("done") }).meta({ title: "IntegrationDone" }),
    z.strictObject({ state: z.literal("stopped"), operation: z.enum(["merging", "rebasing"]), unmerged: Count }).meta({ title: "IntegrationStopped" }),
    z.strictObject({ state: z.literal("refused"), outputTail: OutputTail }).meta({ title: "IntegrationRefused" }),
  ])
  .meta({ title: "Integration" });
const FETCHING: readonly string[] = ["fetch", "fetch-all", "pull"];
const PUSHING: readonly string[] = ["push", "force-push"];
const INTEGRATING: readonly string[] = ["pull", "integrate", "abort", "continue", "skip"];
// Contract Δ3 "Results and states": the `SYNC_UNAVAILABLE` reasons that a pull or integrate result holds after the fetch or the count.
const PULL_REFUSAL_REASONS = ["ff-only", "interactive-rebase", "upstream-gone"] as const;
// Data-model §4 to §8: the parts of the action. The response state holds the outcome.
export const SyncResult = z
  .strictObject({
    action: SyncAction,
    fetch: FetchResult.optional(),
    push: PushResult.optional(),
    counts: z.strictObject({ ahead: Count, behind: Count }).meta({ title: "SyncCounts" }).optional(),
    integration: Integration.optional(),
    // Data-model §6. Null: no payload and no configuration value decided.
    modeSource: z.enum(["payload", "branch", "pull", "pull-ff"]).nullable().optional(),
    remedy: SyncRemedy.optional(),
    // Contract Δ9: the `PUSH_REJECTED` reason, the `PUTTY_UNAVAILABLE` reason with the program and its path after a fetched remote,
    // or the `SYNC_UNAVAILABLE` reason of a pull or integrate refusal after the fetch or the count.
    reason: z.enum([...PUSH_REJECTED_REASONS, ...PUTTY_UNAVAILABLE_REASONS, ...PULL_REFUSAL_REASONS]).optional(),
    program: z.enum(PUTTY_PROGRAMS).optional(),
    path: ChannelPath.optional(),
    // Data-model §11: the service holds a connect target for this operation.
    connectTarget: z.literal(true).optional(),
  })
  .refine(
    (r) =>
      (r.fetch === undefined || FETCHING.includes(r.action)) &&
      (r.push === undefined || PUSHING.includes(r.action)) &&
      (r.integration === undefined || INTEGRATING.includes(r.action)) &&
      ((r.counts === undefined && r.modeSource === undefined) || r.action === "pull" || r.action === "integrate") &&
      (!(PULL_REFUSAL_REASONS as readonly string[]).includes(r.reason ?? "") || r.action === "pull" || r.action === "integrate") &&
      (!(PUSH_REJECTED_REASONS as readonly string[]).includes(r.reason ?? "") || PUSHING.includes(r.action)) &&
      ((r.program !== undefined && r.path !== undefined) === (PUTTY_UNAVAILABLE_REASONS as readonly string[]).includes(r.reason ?? "")) &&
      ((r.program === undefined) === (r.path === undefined)),
  )
  .meta({ title: "SyncResult" });

// Contract Δ9 `PUTTY_UNAVAILABLE`: the program and its path.
export const PuttyRefused = z
  .strictObject({ reason: z.enum(PUTTY_UNAVAILABLE_REASONS), program: z.enum(PUTTY_PROGRAMS), path: ChannelPath })
  .meta({ title: "PuttyRefused" });
// Contract Δ3 `clone`: the `chooseRepository` result after exit 0, else the destination state of FR-050, or a refusal before the start.
// `connectTarget` (data-model §11): the service holds a connect target for this operation. Without a destination read, it stands alone.
export const CloneResult = z
  .union([
    RegistrationResult,
    z.strictObject({ exists: z.boolean(), empty: z.boolean(), outputTail: OutputTail, remedy: SyncRemedy, connectTarget: z.literal(true).optional() }).meta({ title: "CloneFailed" }),
    z.strictObject({ connectTarget: z.literal(true) }).meta({ title: "CloneConnectTarget" }),
    z.strictObject({ reason: z.enum(DESTINATION_NOT_EMPTY_REASONS), path: ChannelPath }).meta({ title: "DestinationRefused" }),
    PuttyRefused,
  ])
  .meta({ title: "CloneResult" });

// Data-model §10 and contract Δ3 `readSyncSettings`. No passphrase, credential, key content, or repository value.
// Feature 004 data-model §13 and contract Δ14: the shell setting `switchChoice` reaches the renderer here, as `defaultPullAction` does.
// `programs`: one entry for each PuTTY program in the plink folder with a set `plinkPath`, else none.
export const SyncSettings = z
  .strictObject({
    sshClient: z.enum(["git", "plink"]),
    defaultPullAction: z.enum(DEFAULT_PULL_ACTIONS),
    switchChoice: SwitchChoice,
    plinkPath: ChannelPath.nullable(),
    programs: z.array(z.strictObject({ program: z.enum(PUTTY_PROGRAMS), path: ChannelPath, present: z.boolean() }).meta({ title: "SyncProgram" })).max(PUTTY_PROGRAMS.length),
    remoteKeyFiles: z.array(z.strictObject({ worktreeKey: Fingerprint, remote: RemoteName, path: ChannelPath }).meta({ title: "KeyFile" })).max(KEY_FILE_ENTRIES),
    defaultCloneFolder: ChannelPath.nullable(),
    lastCloneParent: ChannelPath.nullable(),
    // Feature 006 contract Δ12: data-model §8 `spelling`.
    spelling: SpellingSetting,
  })
  .refine((s) => Array.isArray(s.programs) && new Set(s.programs.map((p) => p?.program)).size === s.programs.length && s.programs.length === (s.plinkPath === null ? 0 : PUTTY_PROGRAMS.length))
  .meta({ title: "SyncSettings" });
// The six settings operations and feature 004 `setSwitchChoice` give the settings, or a PuTTY refusal of `chooseSyncPath` and `launchPuttygen`.
export const SyncSettingsResult = z.union([SyncSettings, PuttyRefused]).meta({ title: "SyncSettingsResult" });

// ---- Feature 004 results (contract Δ3 and Δ10, data-model §2 to §7) ----

// Contract Δ3 `chooseWorktreeFolder`: the picked parent folder.
export const ChooseWorktreeFolderResult = z.strictObject({ path: ChannelPath }).meta({ title: "ChooseWorktreeFolderResult" });

// ---- Feature 006 results (contract Δ3 and Δ9, data-model §4 and §7) ----

type DictionaryReason = (typeof DICTIONARY_UNAVAILABLE_REASONS)[number];
const FOLDER_REASONS: readonly string[] = ["save", "import-unreadable", "remove"];
// Contract Δ9: `http-status` carries `status`, `save`, `import-unreadable`, and `remove` carry `folder`, and `link` carries `url`.
const dictionaryRefusal = (reasons: readonly [DictionaryReason, ...DictionaryReason[]], title: string) =>
  z
    .strictObject({ reason: z.enum(reasons), status: z.int().min(100).max(599).optional(), folder: ChannelPath.optional(), url: Text.min(1).optional() })
    .refine((r) => (r.reason === "http-status") === (r.status !== undefined) && FOLDER_REASONS.includes(r.reason) === (r.folder !== undefined) && (r.reason === "link") === (r.url !== undefined))
    .meta({ title });
export const DictionaryRefusal = dictionaryRefusal(DICTIONARY_UNAVAILABLE_REASONS, "DictionaryRefusal");
// Data-model §4. `removed` holds the first DICTIONARY_CATALOG_ENTRIES `catalog-removed` notices of this service process, and `more` counts the rest.
// Contract Δ3: a throw in a check step gives the refusal `changed`.
export const ListDictionariesResult = z
  .union([
    z
      .strictObject({
        languages: z
          .array(z.strictObject({ language: LanguageId, state: z.enum(LANGUAGE_STATES), notice: z.enum(LANGUAGE_NOTICES).optional() }).meta({ title: "DictionaryLanguage" }))
          .max(DICTIONARY_CATALOG_ENTRIES)
          .refine((rows) => new Set(rows.map((row) => row?.language)).size === rows.length),
        // Data-model §2 `name`: 1 to 64 code points.
        removed: z.array(z.strictObject({ language: LanguageId, name: Text.refine((name) => [...name].length >= 1 && [...name].length <= 64) }).meta({ title: "RemovedLanguage" })).max(DICTIONARY_CATALOG_ENTRIES),
        more: Count,
      })
      .meta({ title: "DictionaryStates" }),
    dictionaryRefusal(["changed"], "ListDictionariesRefusal"),
  ])
  .meta({ title: "ListDictionariesResult" });
// Data-model §7: the base64 of the bytes from `offset`, up to DICTIONARY_CHUNK_BYTES.
const base64Bytes = (text: string) => (text.length / 4) * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
export const ReadDictionaryResult = z
  .union([
    z
      .strictObject({
        language: LanguageId,
        file: DictionaryFileName,
        size: z.int().min(1).max(DICTIONARY_LANGUAGE_BYTES),
        offset: Count.multipleOf(DICTIONARY_CHUNK_BYTES),
        bytes: z.base64().max(4 * Math.ceil(DICTIONARY_CHUNK_BYTES / 3)),
      })
      .refine((c) => typeof c.bytes === "string" && c.offset < c.size && base64Bytes(c.bytes) === Math.min(DICTIONARY_CHUNK_BYTES, c.size - c.offset))
      .meta({ title: "DictionaryChunk" }),
    dictionaryRefusal(["absent", "changed"], "ReadDictionaryRefusal"),
  ])
  .meta({ title: "ReadDictionaryResult" });
// Data-model §5 and §6: `downloadDictionary` and `importDictionary` share this result.
export const DictionaryRunResult = z
  .union([
    z.strictObject({ language: LanguageId, state: z.literal("ready") }).meta({ title: "DictionaryReady" }),
    dictionaryRefusal(
      ["busy", "not-https", "redirect", "http-not-found", "http-rate-limit", "http-status", "transport", "mismatch", "save", "import-mismatch", "import-unreadable"],
      "DictionaryRunRefusal",
    ),
  ])
  .meta({ title: "DictionaryRunResult" });
export const RemoveDictionaryResult = z
  .union([z.strictObject({ language: LanguageId, removed: z.boolean() }).meta({ title: "DictionaryRemoved" }), dictionaryRefusal(["busy", "remove"], "RemoveDictionaryRefusal")])
  .meta({ title: "RemoveDictionaryResult" });
export const OpenLicenceLinkResult = z.union([empty().meta({ title: "LicenceLinkOpened" }), dictionaryRefusal(["link"], "LicenceLinkRefusal")]).meta({ title: "OpenLicenceLinkResult" });
// T034 adds the actions of batch 2: switch, the branch actions, merge, rebase, and ignore. Later tasks add the plans of their actions.

// Contract Δ5: 100 paths in a result, plus a count.
const IN_THE_WAY_PATHS = 100;
// Contract Δ5 "Moved branches listed in the rebase panel".
const MOVED_BRANCHES_LISTED = 100;
const FullRef = Text.min(1);
const RefObject = z.strictObject({ ref: FullRef, oid: ObjectId }).meta({ title: "RefObject" });
// Data-model §5: the configuration entry that gives a value, or Git's default.
const ConfigSource = z.union([z.literal("default"), z.strictObject({ scope: ConfigScope, origin: z.string() }).meta({ title: "ConfigOrigin" })]);

// Data-model §3. A branch that another worktree holds and a path in the way refuse the review, so the plan holds neither.
const SwitchPlan = z
  .strictObject({
    target: z.union([
      z.strictObject({ local: FullRef }).meta({ title: "SwitchPlanLocal" }),
      z.strictObject({ track: z.strictObject({ ref: FullRef, name: Text.min(1) }) }).meta({ title: "SwitchPlanTrack" }),
      z.strictObject({ detach: ObjectId }).meta({ title: "SwitchPlanDetach" }),
    ]),
    trackedChanges: Count,
    unreachable: ObjectId.nullable(),
    heldBy: z.null(),
    choice: z.enum(["keep", "stash", "discard"]),
    inTheWay: z.null(),
  })
  .meta({ title: "SwitchPlan" });
const CreateBranchPlan = z.strictObject({ name: Text.min(1), start: ObjectId, switchTo: z.boolean() }).meta({ title: "CreateBranchPlan" });
const RenameBranchPlan = z.strictObject({ ref: FullRef, oid: ObjectId, name: Text.min(1) }).meta({ title: "RenameBranchPlan" });
// Data-model §4. The current branch and a branch that another worktree holds refuse the review.
const DeleteBranchPlan = z.strictObject({ ref: FullRef, oid: ObjectId, onlyHere: Count, reflogKeeps: z.boolean(), heldBy: z.null(), current: z.literal(false) }).meta({ title: "DeleteBranchPlan" });
// Data-model §5. `preview` is null when the preview holds more than MERGE_MESSAGE_BYTES bytes.
const MergePlan = z
  .strictObject({
    source: RefObject,
    result: z.enum(["merge", "squash"]),
    noFastForward: z.boolean(),
    noCommit: z.boolean(),
    preview: z.string().nullable(),
    message: z.string().nullable(),
    facts: z.strictObject({ ahead: Count, behind: Count, fastForward: z.boolean(), mergeFf: z.strictObject({ value: z.enum(["true", "false", "only"]), source: ConfigSource }) }).meta({ title: "MergeFacts" }),
  })
  .meta({ title: "MergePlan" });
const RebasePlan = z
  .strictObject({
    onto: RefObject,
    moved: Count,
    rewritten: Count,
    held: Count,
    forceNote: z.strictObject({ trackingRef: FullRef }).meta({ title: "ForceNote" }).nullable(),
    movedBranches: z.strictObject({ refs: z.array(FullRef).max(MOVED_BRANCHES_LISTED), more: Count }).meta({ title: "MovedBranches" }).nullable(),
    autostash: z.strictObject({ value: z.boolean(), source: ConfigSource }),
    autosquash: z.literal(false),
  })
  .meta({ title: "RebasePlan" });
// Plan.md D10. `path` is the bound path in Git's form for the route (contract Δ6).
const WorktreeAddPlan = z
  .strictObject({
    branch: z.union([
      z.strictObject({ new: Text.min(1), start: ObjectId }).meta({ title: "WorktreeAddNew" }),
      z.strictObject({ existing: FullRef, oid: ObjectId }).meta({ title: "WorktreeAddExisting" }),
      z.strictObject({ track: z.strictObject({ ref: FullRef, name: Text.min(1) }), oid: ObjectId }).meta({ title: "WorktreeAddTrack" }),
    ]),
    path: Text.min(1),
    destination: z.enum(["absent", "empty"]),
  })
  .meta({ title: "WorktreeAddPlan" });
// Spec FR-055 and FR-056: the counts of that worktree, and the data-model §4 facts of its branch for "Also delete the branch".
const WorktreeRemovePlan = z
  .strictObject({
    worktree: Text.min(1),
    branch: FullRef.nullable(),
    head: ObjectId.nullable(),
    tracked: Count,
    untracked: Count,
    force: z.boolean(),
    deleteBranch: z.strictObject({ ref: FullRef, oid: ObjectId, onlyHere: Count, reflogKeeps: z.boolean() }).meta({ title: "WorktreeBranchDelete" }).nullable(),
    // git-worktree(1): a worktree with submodules needs `--force`, as one with changes does.
    submodules: z.boolean(),
  })
  .refine((p) => (p.deleteBranch === null || p.deleteBranch.ref === p.branch) && (!p.force || p.tracked + p.untracked > 0 || p.submodules))
  .meta({ title: "WorktreeRemovePlan" });
// Spec FR-057. `reason` is Git's untrusted text.
const WorktreePrunePlan = z
  .strictObject({ prunable: z.array(z.strictObject({ path: Text.min(1), reason: z.string().nullable() }).meta({ title: "PrunableWorktree" })).min(1).max(WORKTREE_RECORDS) })
  .meta({ title: "WorktreePrunePlan" });
// Data-model §11 and plan.md D7. `stages` holds the unmerged stages of the path. A side names the refs at its commit, and a side without a commit fact is null.
const ResolveStage = z.strictObject({ stage: z.int().min(1).max(3), mode: FileMode, oid: ObjectId }).meta({ title: "ResolveStage" });
const SideName = z.strictObject({ oid: ObjectId, refs: z.array(FullRef).max(REF_LISTING_RECORDS) }).meta({ title: "SideName" }).nullable();
const SideNames = z.strictObject({ ours: SideName, theirs: SideName }).meta({ title: "SideNames" });
// Contract Δ3: the stage refusals of `choose-side` and `mergetool` carry the side names, so a DD conflict shows them too.
const SIDE_REFUSALS: readonly string[] = ["side-missing", "stages-missing", "side-not-regular"];
const resolvePlan = {
  path: z.base64().min(1),
  kind: z.strictObject({ xy: z.enum(["UU", "AA", "AU", "UA", "DU", "UD", "DD"]), text: Text.min(1) }).meta({ title: "ConflictKind" }),
  stages: z.array(ResolveStage).min(1).max(3),
  names: SideNames,
  operation: WorkspaceOperationState,
};
const ChooseSidePlan = z.strictObject({ ...resolvePlan, side: z.enum(["ours", "theirs"]) }).meta({ title: "ChooseSidePlan" });
// Spec FR-093: the effective `merge.tool` value with its scope and origin.
const MergetoolPlan = z.strictObject({ ...resolvePlan, tool: z.strictObject({ name: Text.min(1), scope: ConfigScope, origin: z.string() }).meta({ title: "MergeTool" }) }).meta({ title: "MergetoolPlan" });
// Data-model §2 `config-save`: each changed key in Git's canonical form with the one earlier entry of the scope, or null. Every text passes the URL redaction.
const ConfigSavePlan = z
  .strictObject({
    scope: z.enum(["local", "global"]),
    changes: z
      .array(
        z
          .strictObject({
            key: Text.min(1),
            value: Text.nullable(),
            earlier: z.strictObject({ origin: Text.min(1), value: Text.nullable() }).meta({ title: "ConfigEarlier" }).nullable(),
          })
          .meta({ title: "ConfigSaveChange" }),
      )
      .min(1)
      .max(CONFIG_CHANGES),
  })
  .meta({ title: "ConfigSavePlan" });
// git-config(1) "EXIT STATUS" 1 to 6.
export const CONFIG_EXIT_REASONS = ["invalid-key", "no-section-or-name", "invalid-file", "cannot-write", "nothing-set", "invalid-pattern"] as const;
// Feature 005 contract Δ5 "Delete confirmation paths": 20 paths, plus a count. It is no output bound, so `limits.ts` does not list it.
const DELETE_CONFIRMATION_PATHS = 20;
// Data-model §4 plan fields. `files.paths` holds the first confirmation paths in tree order, as base64 bytes. `tracked` counts the tracked files.
const DeletePlan = z
  .strictObject({
    mode: DeleteMode,
    entryIds: z.array(Identifier).min(1).max(MULTI_FILE_ACTION_FILES),
    files: z.strictObject({ count: Count, paths: z.array(z.base64().min(1)).max(DELETE_CONFIRMATION_PATHS) }).meta({ title: "DeleteFiles" }),
    tracked: Count,
    folder: z.base64().min(1).nullable(),
    wsl: z.boolean(),
  })
  // Contract Δ6: a WSL workspace has no Recycle Bin request.
  .refine(
    (p) =>
      uniqueIds(p.entryIds) &&
      p.files?.count === p.entryIds.length &&
      Array.isArray(p.files.paths) &&
      p.files.paths.length === Math.min(p.files.count, DELETE_CONFIRMATION_PATHS) &&
      p.tracked <= p.files.count &&
      !(p.wsl && p.mode === "recycle"),
  )
  .meta({ title: "DeletePlan" });
// Contract Δ3 `ignore-save` plan: the target file in Git's form, and the size and SHA-256 of the new bytes.
const IgnoreSavePlan = z.strictObject({ target: IgnoreTarget, file: Text.min(1), size: Count.max(IGNORE_TARGET_BYTES), sha256: Fingerprint }).meta({ title: "IgnoreSavePlan" });
// Feature 008 data-model §5. `paths` holds the first confirmation paths in tree order, as base64 bytes. `lines` is null for a whole hunk.
const firstPaths = (p: { count?: unknown; paths?: unknown }) => typeof p.count === "number" && Array.isArray(p.paths) && p.paths.length === Math.min(p.count, DELETE_CONFIRMATION_PATHS);
const confirmationPaths = { count: Count.min(1).max(MULTI_FILE_ACTION_FILES), paths: z.array(z.base64().min(1)).max(DELETE_CONFIRMATION_PATHS) };
const RevertLinesPlan = z
  .strictObject({ scope: z.enum(["unstaged", "staged"]), fileBytes: z.base64().min(1), lines: z.int().min(1).max(CANONICAL_DIFF_LINES).nullable() })
  .meta({ title: "RevertLinesPlan" });
// `newFiles`: staged new files that keep their working file, so each one also counts in `staged`.
const RevertFilesPlan = z
  .strictObject({ ...confirmationPaths, newFiles: Count, staged: Count, unstaged: Count })
  .refine((p) => firstPaths(p) && p.staged <= p.count && p.unstaged <= p.count && p.newFiles <= p.staged)
  .meta({ title: "RevertFilesPlan" });
// `submodules`: the covered entries that stay unchanged. The renderer computes the hidden count.
const RevertUnstagedPlan = z
  .strictObject({ ...confirmationPaths, submodules: Count })
  .refine(firstPaths)
  .meta({ title: "RevertUnstagedPlan" });
// Feature 008 data-model §7: a revert review refuses with UNSUPPORTED_COMPARISON and a support or line reason, or with UNSUPPORTED_HUNK_PROFILE
// and an eligibility reason and its remedy. The service never gives `several-hunks` (`line-patch.ts`).
const UNAVAILABLE: readonly string[] = WORKBENCH_UNAVAILABLE_REASONS;
const SUPPORT_REFUSALS = SupportValue.options.filter((r): r is Exclude<z.infer<typeof SupportValue>, "supported"> => r !== "supported");
const LINE_REFUSALS = LINE_ACTION_REASONS.filter((r): r is Exclude<LineActionReason, "several-hunks"> => r !== "several-hunks");
const REVERT_REFUSALS = [...SUPPORT_REFUSALS.filter((r): r is Exclude<(typeof SUPPORT_REFUSALS)[number], WorkbenchUnavailableReason> => !UNAVAILABLE.includes(r)), ...LINE_REFUSALS, ...INELIGIBLE_REASONS];
const INELIGIBLE: readonly string[] = INELIGIBLE_REASONS;
// Spec FR-022 and FR-029: the first refused files in tree order with their reasons. `more` counts the rest.
const RevertRefusedFile = z
  .strictObject({ path: z.base64().min(1), reason: z.enum([...SUPPORT_REFUSALS, ...LINE_REFUSALS, ...REVERT_FILE_REASONS]) })
  .meta({ title: "RevertRefusedFile" });
const reviewed = <A extends string, P extends z.ZodType>(action: A, plan: P, title: string) => z.strictObject({ action: z.literal(action), plan, workbenchToken: Identifier }).meta({ title });
// Feature 008: the remedy of an eligibility reason, or of a LOCKED refusal with the lock `path` (001 FR-016).
const WorkbenchRemedy = z.strictObject({ text: Text.min(1) }).meta({ title: "WorkbenchRemedy" });
// Contract Δ3 "Result": `{action, plan, workbenchToken}`, or a refusal value: the Δ9 reason with its facts, the in-the-way paths, or the CONFLICTED count.
// A `merge` or `rebase` refusal after the counts carries the plan (contract Δ3).
export const ReviewWorkbenchResult = z
  .union([
    z.discriminatedUnion("action", [
      reviewed("switch", SwitchPlan, "SwitchReviewed"),
      reviewed("create-branch", CreateBranchPlan, "CreateBranchReviewed"),
      reviewed("rename-branch", RenameBranchPlan, "RenameBranchReviewed"),
      reviewed("delete-branch", DeleteBranchPlan, "DeleteBranchReviewed"),
      reviewed("merge", MergePlan, "MergeReviewed"),
      reviewed("rebase", RebasePlan, "RebaseReviewed"),
      reviewed("worktree-add", WorktreeAddPlan, "WorktreeAddReviewed"),
      reviewed("worktree-remove", WorktreeRemovePlan, "WorktreeRemoveReviewed"),
      reviewed("worktree-prune", WorktreePrunePlan, "WorktreePruneReviewed"),
      reviewed("choose-side", ChooseSidePlan, "ChooseSideReviewed"),
      reviewed("mergetool", MergetoolPlan, "MergetoolReviewed"),
      reviewed("config-save", ConfigSavePlan, "ConfigSaveReviewed"),
      reviewed("delete", DeletePlan, "DeleteReviewed"),
      reviewed("ignore-save", IgnoreSavePlan, "IgnoreSaveReviewed"),
      reviewed("revert-lines", RevertLinesPlan, "RevertLinesReviewed"),
      reviewed("revert-files", RevertFilesPlan, "RevertFilesReviewed"),
      reviewed("revert-unstaged", RevertUnstagedPlan, "RevertUnstagedReviewed"),
    ]),
    z
      .strictObject({
        // Feature 005 contract Δ3: an `ignore-save` review gives STALE_REVIEW with reason `ignore-changed`.
        reason: z.enum([...WORKBENCH_UNAVAILABLE_REASONS, ...UNTRACKED_IN_WAY_REASONS, ...DESTINATION_NOT_EMPTY_REASONS, ...STALE_REVIEW_REASONS, ...REVERT_REFUSALS]).optional(),
        worktree: Text.min(1).optional(),
        ref: FullRef.optional(),
        remotes: z.array(RemoteName).min(2).max(SYNC_REMOTES).optional(),
        // A `dirty-tree` refusal of `worktree-remove` carries the counts (spec FR-055).
        plan: z.union([MergePlan, RebasePlan, WorktreeRemovePlan]).optional(),
        paths: z.array(Text.min(1)).min(1).max(IN_THE_WAY_PATHS).optional(),
        more: Count.optional(),
        unmerged: Count.optional(),
        // The REPOSITORY_UNAVAILABLE refusal of `worktree-add`: the bound path that the shell could not read (contract Δ3).
        path: Text.min(1).optional(),
        // Plan.md O-20: the gate of a TRUST_REQUIRED or TRUST_CHANGED refusal. `target` is the listing of the worktree that `worktree-remove` names.
        trustGate: z.enum(["repository", "target"]).optional(),
        names: SideNames.optional(),
        remedy: WorkbenchRemedy.optional(),
        files: z.array(RevertRefusedFile).min(1).max(DELETE_CONFIRMATION_PATHS).optional(),
      })
      .refine(
        (r) =>
          (r.worktree === undefined || r.reason === "other-worktree" || r.reason === "head-unresolved") &&
          (r.ref === undefined || r.reason === "name-exists") &&
          (r.remotes === undefined || r.reason === "several-tracking-remotes") &&
          (r.paths !== undefined) === (r.reason === "untracked-in-way") &&
          (r.paths === undefined || r.files === undefined) &&
          (r.paths !== undefined || r.files !== undefined) === (r.more !== undefined) &&
          (r.files === undefined || r.files[0]?.reason === r.reason) &&
          (r.remedy === undefined || (r.reason === undefined ? r.path !== undefined : INELIGIBLE.includes(r.reason))) &&
          (r.unmerged === undefined || r.reason === undefined) &&
          (r.path === undefined || r.reason === undefined) &&
          (r.trustGate === undefined || Object.keys(r).length === 1) &&
          (r.names === undefined || (r.reason !== undefined && SIDE_REFUSALS.includes(r.reason))),
      )
      .meta({ title: "WorkbenchRefused" }),
  ])
  .meta({ title: "ReviewWorkbenchResult" });

// Feature 004 contract Δ3 `reviewCommit` with `amend`. Without an upstream, nothing is rewritten. A present upstream gives a fact, and an absent one `unknown`.
const AmendReview = z
  .strictObject({
    headOid: ObjectId,
    message: z.string(),
    upstream: z.strictObject({ name: Text.min(1).nullable(), present: z.boolean() }).meta({ title: "AmendUpstream" }).nullable(),
    rewritesUpstream: z.union([z.boolean(), z.literal("unknown")]),
  })
  .refine((a) => (a.upstream === null ? a.rewritesUpstream === false : a.upstream.present ? a.upstream.name !== null && a.rewritesUpstream !== "unknown" : a.rewritesUpstream === "unknown"))
  .meta({ title: "AmendReview" });
// Contract §3 `reviewCommit` and data-model §6 "Commit review". An empty staged scope gets a token only for an amend, and the amend names the HEAD commit.
export const ReviewCommitResult = z
  .union([
    z
      .strictObject({
        generation: Generation,
        head: Head,
        scope: z
          .array(z.strictObject({ status: z.enum(["A", "D", "M", "T", "U"]), path: z.string(), pathBytes: z.base64().min(1) }).meta({ title: "CommitScopeEntry" }))
          .max(limits.STATUS_LISTING_RECORDS),
        disclosure: z.strictObject({ approvalRequired: z.boolean(), trust: z.enum(["untrusted", "approved", "changed", "revoked"]) }).meta({ title: "CommitDisclosure" }),
        limitations: z.array(Text.min(1)).min(1),
        reviewToken: Identifier.optional(),
        amend: AmendReview.optional(),
      })
      .refine((r) => (r.reviewToken !== undefined) === (r.scope.length > 0 || r.amend !== undefined) && (r.amend === undefined || (r.head.state !== "unborn" && r.amend.headOid === r.head.oid)))
      .meta({ title: "CommitReviewed" }),
    // Contract Δ3: an amend of an unborn HEAD gives WORKBENCH_UNAVAILABLE.
    z.strictObject({ reason: z.literal("unborn") }).meta({ title: "CommitReviewUnborn" }),
    z
      .strictObject({ completeness: Completeness })
      .refine((r) => r.completeness.state === "limited")
      .meta({ title: "CommitReviewLimited" }),
  ])
  .meta({ title: "ReviewCommitResult" });
export type ReviewCommitResult = z.infer<typeof ReviewCommitResult>;

// Data-model §1 `readBranches`. Only a remote entry maps to a local name, and only a local entry is current or holds a tracking entry.
// `invalidUtf8`: the ref bytes are no valid UTF-8, so `ref` is display text only.
// `oid` is a commit, peeled for a ref that names an annotated tag. `tracking` keeps the 003 ref values, so its upstream OID can be the tag object.
const BranchEntry = z
  .strictObject({
    ref: FullRef,
    kind: z.enum(["local", "remote"]),
    name: Text.min(1),
    invalidUtf8: z.boolean(),
    oid: ObjectId,
    upstream: FullRef.nullable(),
    tracking: TrackingEntry.nullable(),
    heldBy: Text.min(1).nullable(),
    current: z.boolean(),
    localName: Text.min(1).nullable(),
    // Feature 005 contract Δ3: false for no upstream or the 003 track state `gone` of the paired tracking entry. Null: no paired entry, so the state is unknown.
    upstreamPresent: z.boolean().nullable(),
  })
  .refine((e) => (e.kind === "local" ? e.localName === null : !e.current && e.tracking === null) && (e.upstreamPresent !== true || e.upstream !== null))
  .meta({ title: "BranchEntry" });
// Contract Δ3 `readBranches`: the entries, or the `readRefs` refusal form for a bound or a failed read. At most one entry is current.
export const ReadBranchesResult = z
  .union([
    z
      .strictObject({ entries: z.array(BranchEntry).max(REF_LISTING_RECORDS) })
      .refine((r) => !Array.isArray(r.entries) || r.entries.filter((e) => e?.current === true).length <= 1)
      .meta({ title: "BranchList" }),
    RefsRefusal,
  ])
  .meta({ title: "ReadBranchesResult" });

// Data-model §8 `readWorktrees`. `invalidUtf8`: the path or the branch bytes are no valid UTF-8, so they are display text only. Reasons are Git's untrusted text.
const WorktreeEntry = z
  .strictObject({
    path: Text.min(1),
    invalidUtf8: z.boolean(),
    head: ObjectId.nullable(),
    branch: FullRef.nullable(),
    bare: z.boolean(),
    detached: z.boolean(),
    headUnresolved: z.boolean(),
    locked: z.strictObject({ reason: z.string().nullable() }).meta({ title: "WorktreeLock" }).nullable(),
    prunable: z.strictObject({ reason: z.string().nullable() }).meta({ title: "WorktreePrunable" }).nullable(),
    main: z.boolean(),
    current: z.boolean(),
  })
  .refine((e) => (!e.detached || e.branch === null) && e.headUnresolved === (!e.bare && e.branch === null && !e.detached) && (!e.headUnresolved || e.head === null))
  .meta({ title: "WorktreeEntry" });
// Contract Δ3 `readWorktrees`: the records in Git's order, so only the first is main, and at most one is current. A bound gives OUTPUT_LIMIT with its reason.
export const ReadWorktreesResult = z
  .union([
    z
      .strictObject({ entries: z.array(WorktreeEntry).max(WORKTREE_RECORDS) })
      .refine((r) => !Array.isArray(r.entries) || (r.entries.every((e, i) => e?.main === (i === 0)) && r.entries.filter((e) => e?.current === true).length <= 1))
      .meta({ title: "WorktreeList" }),
    z.strictObject({ reason: z.enum(["WORKTREE_RECORDS", "WORKTREE_LISTING_BYTES", "UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION"]) }).meta({ title: "WorktreeListLimited" }),
  ])
  .meta({ title: "ReadWorktreesResult" });

// Data-model §9 "Configuration value". `reading` is the value as Git reads it for the key type, or null. Every text passed the URL redaction.
const ConfigValueEntry = z.strictObject({ scope: ConfigScope, origin: Text, value: Text.nullable(), reading: Text.nullable() }).meta({ title: "ConfigValueEntry" });
const CONFIG_READ_ONLY = ["multi-value", "included", "unreadable-value"] as const;
const ConfigValue = z
  .strictObject({
    key: Text.min(1),
    type: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("bool") }).meta({ title: "ConfigBool" }),
        z.strictObject({ kind: z.literal("enum"), values: z.array(Text.min(1)).min(1) }).meta({ title: "ConfigEnum" }),
        z.strictObject({ kind: z.literal("text") }).meta({ title: "ConfigText" }),
      ])
      .meta({ title: "ConfigType" }),
    entries: z.array(ConfigValueEntry),
    effective: ConfigValueEntry.nullable(),
    scopes: z
      .strictObject({ system: z.array(ConfigValueEntry), global: z.array(ConfigValueEntry), local: z.array(ConfigValueEntry), worktree: z.array(ConfigValueEntry), command: z.array(ConfigValueEntry) })
      .meta({ title: "ConfigScopes" }),
    readOnly: z.strictObject({ local: z.enum(CONFIG_READ_ONLY).nullable(), global: z.enum(CONFIG_READ_ONLY).nullable() }).meta({ title: "ConfigReadOnly" }),
  })
  .meta({ title: "ConfigValue" });
// Contract Δ3 `readGitSettings`: the FR-060 keys and the tool keys of the effective tools, and the file that a save of each scope writes, or null.
// `appSettings` of data-model §9 come from `readSyncSettings` (contract Δ3). The 20 FR-060 keys and at most 4 tool keys.
export const ReadGitSettingsResult = z
  .strictObject({
    values: z.array(ConfigValue).min(1).max(24),
    files: z.strictObject({ local: Text.min(1).nullable(), global: Text.min(1).nullable(), system: Text.min(1).nullable() }).meta({ title: "ConfigFiles" }),
  })
  .meta({ title: "ReadGitSettingsResult" });

// A ref whose value differs between the listings before and after the steps.
const RefChange = z.strictObject({ ref: FullRef }).meta({ title: "RefChange" });
const RefChanges = z.array(RefChange).max(SYNC_REFS_RECORDS);
// Data-model §3 `stash.state`: `dropped`, or `kept-` with the contract Δ9 STASH_KEPT reason.
const STASH_STATES = ["dropped", ...STASH_KEPT_REASONS.map((reason) => `kept-${reason}` as const)] as const;
const BRANCH_ACTIONS = ["create-branch", "rename-branch", "delete-branch"] as const;
const WORKTREE_ACTIONS = ["worktree-add", "worktree-remove", "worktree-prune"] as const;
const RESOLVE_ACTIONS = ["choose-side", "mergetool"] as const;
const REVERT_ACTIONS = ["revert-lines", "revert-files", "revert-unstaged"] as const;
const RUN_ACTIONS = ["switch", ...BRANCH_ACTIONS, "merge", "rebase", ...WORKTREE_ACTIONS, ...RESOLVE_ACTIONS, "config-save", "delete", "ignore-save", ...REVERT_ACTIONS] as const;
// Data-model §5: the outcome of each path and each candidate folder. Only `error` carries `code`, and only `recycled` carries `recycledPath`.
const DeleteFileOutcome = z
  .strictObject({
    entryId: Identifier,
    outcome: z.enum(["recycled", "deleted", "kept", "changed", "absent", "not-regular", "error", "stopped"]),
    code: z.enum(FILE_FACT_ERRORS).optional(),
    recycledPath: ChannelPath.optional(),
  })
  .refine((o) => (o.code !== undefined) === (o.outcome === "error") && (o.recycledPath !== undefined) === (o.outcome === "recycled"))
  .meta({ title: "DeleteFileOutcome" });
const DeleteFolderOutcome = z
  .strictObject({ pathBytes: z.base64().min(1), outcome: z.enum(["removed", "kept", "absent", "not-regular", "error"]), code: z.enum(FILE_FACT_ERRORS).optional() })
  .refine((o) => (o.code !== undefined) === (o.outcome === "error"))
  .meta({ title: "DeleteFolderOutcome" });
// Data-model §8 result. `stale`, `not-regular`, `stopped`, `interrupted`, and `error` are the `fileReplace` replies.
const IGNORE_SAVE_OUTCOMES = ["replaced", "stale", "not-regular", "stopped", "interrupted", "error"] as const;
const STALE_ACTIONS: Readonly<Record<string, string>> = {
  delete: "files-changed",
  "ignore-save": "ignore-changed",
  ...Object.fromEntries(REVERT_ACTIONS.map((action) => [action, "revert-changed"])),
};
// Feature 008 data-model §8 and §9. Only `not-changed` carries the reply `code`. `refused` names the reply reason, and `error` the reply code, as `reason`.
const REVERT_REASONS: Readonly<Record<string, readonly string[]>> = { refused: REPLACE_REFUSALS, error: REPLACE_ERRORS };
const RevertFileOutcome = z
  .strictObject({
    entryId: Identifier,
    outcome: z.enum(["reverted", "unstaged-only", "not-changed", "changed-outside", "not-started"]),
    code: z.enum(["stale", "refused", "error"]).optional(),
    reason: z.enum([...REPLACE_REFUSALS, ...REPLACE_ERRORS]).optional(),
  })
  .refine((o) => (o.code === undefined || o.outcome === "not-changed") && (o.reason === undefined ? o.code === undefined || !Object.hasOwn(REVERT_REASONS, o.code) : o.code !== undefined && Object.hasOwn(REVERT_REASONS, o.code) && REVERT_REASONS[o.code]!.includes(o.reason)))
  .meta({ title: "RevertFileOutcome" });
// Contract Δ6: each `fileReplace` creates at most FILE_FACT_ENTRIES folders.
const RevertRun = z
  .strictObject({
    action: z.enum(REVERT_ACTIONS),
    files: z.array(RevertFileOutcome).min(1).max(MULTI_FILE_ACTION_FILES),
    foldersCreated: z.array(z.base64().min(1)).max(MULTI_FILE_ACTION_FILES * FILE_FACT_ENTRIES),
    index: z.enum(["published", "none", "refused"]),
  })
  .refine((r) => r.action !== "revert-lines" || (Array.isArray(r.files) && r.files.length === 1))
  .meta({ title: "RevertRun" });
// Contract Δ3 `runWorkbench` "Results": the observed effects. A failed step adds its `outputTail`. An unknown outcome names the action only.
// A refusal before any step can carry the CONFLICTED count. A repeated request gets the `getOperation` result of its operation (contract §2).
export const RunWorkbenchResult = z
  .union([
    z
      .strictObject({
        action: z.literal("switch"),
        head: Head,
        refs: RefChanges,
        stash: z.strictObject({ oid: ObjectId.nullable(), state: z.enum(STASH_STATES) }).meta({ title: "SwitchStash" }).nullable(),
        conflicted: Count,
        remedy: SyncRemedy.optional(),
        outputTail: OutputTail.optional(),
      })
      .meta({ title: "SwitchRun" }),
    z.strictObject({ action: z.enum(BRANCH_ACTIONS), head: Head, refs: RefChanges, outputTail: OutputTail.optional() }).meta({ title: "BranchRun" }),
    z
      .strictObject({
        action: z.enum(["merge", "rebase"]),
        head: Head,
        refs: RefChanges,
        operationState: WorkspaceOperationState,
        unmerged: Count,
        stash: z.strictObject({ oid: ObjectId }).meta({ title: "AutostashKept" }).nullable(),
        outputTail: OutputTail.optional(),
      })
      .meta({ title: "MergeRebaseRun" }),
    z.strictObject({ action: z.enum(WORKTREE_ACTIONS), head: Head, refs: RefChanges, outputTail: OutputTail.optional() }).meta({ title: "WorktreeRun" }),
    // Spec FR-096: `staged` comes from the fresh index read. It is true when the path has no stage above 0.
    z.strictObject({ action: z.enum(RESOLVE_ACTIONS), staged: z.boolean(), operationState: WorkspaceOperationState, outputTail: OutputTail.optional() }).meta({ title: "ResolveRun" }),
    // Plan.md D11: `written` comes from the fresh listing. `failed` names the stopped key, `stale` a key whose entries changed before its write.
    z
      .strictObject({
        action: z.literal("config-save"),
        scope: z.enum(["local", "global"]),
        written: z.array(Text.min(1)).max(CONFIG_CHANGES),
        failed: z
          .strictObject({ key: Text.min(1), exitCode: z.int().min(0).max(limits.PROCESS_EXIT_CODE_MAX).nullable(), reason: z.enum(CONFIG_EXIT_REASONS).optional() })
          .meta({ title: "ConfigSaveFailed" })
          .optional(),
        stale: Text.min(1).optional(),
        outputTail: OutputTail.optional(),
      })
      .meta({ title: "ConfigSaveRun" }),
    // Feature 005 data-model §5 and §8.
    z
      .strictObject({ action: z.literal("delete"), entries: z.array(DeleteFileOutcome).max(MULTI_FILE_ACTION_FILES), folders: z.array(DeleteFolderOutcome).max(MULTI_FILE_ACTION_FILES) })
      .meta({ title: "DeleteRun" }),
    z
      .strictObject({ action: z.literal("ignore-save"), outcome: z.enum(IGNORE_SAVE_OUTCOMES), code: z.enum(FILE_FACT_ERRORS).optional() })
      .refine((r) => (r.code !== undefined) === (r.outcome === "error"))
      .meta({ title: "IgnoreSaveRun" }),
    RevertRun,
    // Feature 005 contract Δ3: a fact that changed after the review gives STALE_REVIEW with the reason of its action.
    z
      .strictObject({ action: z.enum(["delete", "ignore-save", ...REVERT_ACTIONS]), reason: z.enum(STALE_REVIEW_REASONS) })
      .refine((r) => STALE_ACTIONS[r.action] === r.reason)
      .meta({ title: "WorkbenchStale" }),
    z.strictObject({ action: z.enum(RUN_ACTIONS) }).meta({ title: "WorkbenchUnread" }),
    z.strictObject({ unmerged: Count }).meta({ title: "WorkbenchConflicted" }),
    // Feature 008 contract Δ3: an `index.lock` at the run start gives LOCKED with the lock path and the 001 remedy, as the review does.
    z.strictObject({ path: Text.min(1), remedy: WorkbenchRemedy }).meta({ title: "WorkbenchLocked" }),
    // Plan.md O-20: a TRUST_REQUIRED or TRUST_CHANGED run refusal names its gate, as the review refusal does.
    z.strictObject({ trustGate: z.enum(["repository", "target"]) }).meta({ title: "WorkbenchTrustRefused" }),
    OperationResult.meta({ title: "WorkbenchRepeat" }),
  ])
  .meta({ title: "RunWorkbenchResult" });

// ---- Feature 005 results (contract Δ3, data-model §1, §2, §6, §7, §10) ----

const PathBytes = z.base64().min(1);
// Contract Δ3: a non-zero exit in a promisor repository gives OBJECT_MISSING with the 001 remedy and no value.
const InspectionObjectMissing = z.strictObject({ remedy: Remedy }).meta({ title: "InspectionObjectMissing" });
const FileKind = z.enum(["file", "link", "submodule"]);

// Data-model §1. `score` and `oldPathBytes` exist only for `renamed`. `fileId` is the record ordinal.
// The `empty-tree` base holds the `hash-object -t tree --stdin` result, so the schema checks only its form.
const CommitChangeEntry = z
  .strictObject({
    fileId: Count,
    status: z.enum(["added", "deleted", "modified", "renamed", "type-changed"]),
    score: z.int().min(0).max(100).optional(),
    pathBytes: PathBytes,
    oldPathBytes: PathBytes.optional(),
    kind: FileKind,
  })
  .refine((e) => (e.status === "renamed") === (e.score !== undefined) && (e.status === "renamed") === (e.oldPathBytes !== undefined))
  .meta({ title: "CommitChangeEntry" });
const CommitBase = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("parent"), index: z.int().min(0).max(HISTORY_PARENTS_PER_COMMIT - 1), oid: ObjectId }).meta({ title: "ParentBase" }),
    z.strictObject({ kind: z.literal("empty-tree"), oid: ObjectId }).meta({ title: "EmptyTreeBase" }),
    z.strictObject({ kind: z.literal("shallow") }).meta({ title: "ShallowBase" }),
  ])
  .meta({ title: "CommitBase" });
const COMMIT_CHANGES_BOUNDS = ["STATUS_LISTING_RECORDS", "STATUS_LISTING_BYTES", "COMMIT_CHANGES_RESULT_BYTES"] as const;
export const CommitChanges = z
  .strictObject({
    changesId: Identifier,
    viewId: Identifier,
    oid: ObjectId,
    parents: z.array(ObjectId).max(HISTORY_PARENTS_PER_COMMIT),
    base: CommitBase,
    files: z.array(CommitChangeEntry).max(STATUS_LISTING_RECORDS),
    completeness: z
      .discriminatedUnion("state", [
        z.strictObject({ state: z.literal("complete") }).meta({ title: "ChangesComplete" }),
        z.strictObject({ state: z.literal("limited"), code: z.literal("OUTPUT_LIMIT"), reason: z.enum(COMMIT_CHANGES_BOUNDS), shown: Count }).meta({ title: "ChangesLimited" }),
      ])
      .meta({ title: "ChangesCompleteness" }),
  })
  .refine((c) => {
    if (!Array.isArray(c.files) || !Array.isArray(c.parents) || c.base === undefined || c.completeness === undefined) return false;
    const base = c.base.kind === "parent" ? c.base.index < c.parents.length && c.parents[c.base.index] === c.base.oid : c.parents.length === 0;
    const files = c.files.every((f, i) => f?.fileId === i) && (c.base.kind !== "shallow" || c.files.length === 0);
    return base && files && (c.completeness.state !== "limited" || c.completeness.shown === c.files.length);
  })
  .meta({ title: "CommitChanges" });
export const ReadCommitChangesResult = z.union([CommitChanges, InspectionObjectMissing]).meta({ title: "ReadCommitChangesResult" });
export type CommitChanges = z.infer<typeof CommitChanges>;

// Data-model §2. A binary file, a submodule, and a type change carry no patch. Only an OBJECT_MISSING patch carries `remedy`.
export const CommitFile = z
  .strictObject({
    changesId: Identifier,
    fileId: Count,
    facts: z
      .strictObject({
        rename: z.strictObject({ oldPath: PathBytes, score: z.int().min(0).max(100) }).meta({ title: "RenameFact" }).optional(),
        mode: z.strictObject({ old: FileMode, new: FileMode }).meta({ title: "ModeFact" }).optional(),
        submodule: z.strictObject({ old: ObjectId.nullable(), new: ObjectId.nullable() }).meta({ title: "SubmoduleFact" }).optional(),
        typeChange: z.strictObject({ old: FileKind, new: FileKind }).meta({ title: "TypeChangeFact" }).optional(),
      })
      .meta({ title: "CommitFileFacts" }),
    binary: z.boolean(),
    patch: z.base64().nullable(),
    completeness: z
      .union([
        z.strictObject({ state: z.literal("complete") }).meta({ title: "PatchComplete" }),
        z.strictObject({ state: z.literal("limited"), code: z.literal("OUTPUT_LIMIT"), reason: z.enum(["CANONICAL_DIFF_BYTES", "CANONICAL_DIFF_LINES"]) }).meta({ title: "PatchLimited" }),
        z.strictObject({ state: z.literal("limited"), code: z.literal("OBJECT_MISSING") }).meta({ title: "PatchObjectMissing" }),
      ])
      .meta({ title: "PatchCompleteness" }),
    remedy: Remedy.optional(),
  })
  .refine(
    (f) =>
      (f.remedy !== undefined) === (f.completeness?.state === "limited" && f.completeness.code === "OBJECT_MISSING") &&
      (f.patch === null || (!f.binary && f.facts?.submodule === undefined && f.facts?.typeChange === undefined)),
  )
  .meta({ title: "CommitFile" });
// Contract Δ3: UNSUPPORTED_COMPARISON with the 001 reason `path` for a path that is no valid UTF-8.
const CommitFileRefused = z.strictObject({ reason: z.enum(["path"]) }).meta({ title: "CommitFileRefused" });
export const ReadCommitFileResult = z.union([CommitFile, InspectionObjectMissing, CommitFileRefused]).meta({ title: "ReadCommitFileResult" });
export type CommitFile = z.infer<typeof CommitFile>;

// Data-model §6. `text` has LF line ends and no BOM. The renderer shows it as plain text only.
const READ_IGNORE_REASONS = ["ignore-link", "ignore-folder", "ignore-not-regular", "ignore-size", "ignore-not-utf8", "ignore-nul", "ignore-lone-cr", "unreadable", "path"] as const;
export const IgnoreFile = z
  .strictObject({
    target: IgnoreTarget,
    file: Text.min(1),
    state: z.enum(["absent", "file"]),
    text: Text.refine((t) => new TextEncoder().encode(t).length <= IGNORE_TARGET_BYTES),
    lineEnding: z.enum(["lf", "crlf", "none", "mixed"]),
    // Data-model §6: only a mixed file carries the counts, and each form occurs at least once.
    lineCounts: z.strictObject({ lf: Count.min(1), crlf: Count.min(1) }).optional(),
    bom: z.boolean(),
    expected: IgnoreExpected,
  })
  .refine(
    (f) =>
      (f.state === "absent") === (f.expected === "absent") &&
      (f.state === "file" || (f.text === "" && !f.bom && f.lineEnding === "none")) &&
      (f.lineEnding === "mixed") === (f.lineCounts !== undefined),
  )
  .meta({ title: "IgnoreFile" });
export const ReadIgnoreFileResult = z.union([IgnoreFile, z.strictObject({ reason: z.enum(READ_IGNORE_REASONS) }).meta({ title: "IgnoreFileRefused" })]).meta({ title: "ReadIgnoreFileResult" });
export type IgnoreFile = z.infer<typeof IgnoreFile>;

// Data-model §7. Each group holds its count and at most 1,000 paths in `comparePaths` order. Contract Δ5: 100 notices, plus a count.
const PREVIEW_NOTICES = 100;
const PreviewGroup = z
  .strictObject({ count: Count, paths: z.array(PathBytes).max(PREVIEW_GROUP_PATHS) })
  .refine((g) => Array.isArray(g.paths) && g.paths.length === Math.min(g.count, PREVIEW_GROUP_PATHS))
  .meta({ title: "PreviewGroup" });
export const PreviewIgnoreResult = z
  .union([
    z
      .strictObject({
        preview: z
          .strictObject({
            newlyIgnored: PreviewGroup,
            noLongerIgnored: PreviewGroup,
            trackedMatched: Count,
            notices: z
              .strictObject({ entries: z.array(z.strictObject({ kind: z.enum(["link", "inside-ignored"]), pathBytes: PathBytes }).meta({ title: "PreviewNotice" })).max(PREVIEW_NOTICES), more: Count })
              .meta({ title: "PreviewNotices" }),
          })
          .meta({ title: "PreviewGroups" }),
      })
      .meta({ title: "IgnorePreview" }),
    z
      .strictObject({
        unavailable: z
          .strictObject({ reason: z.enum(["paths", "listing", "name-case", "shadow-copy", "self-check", "unreadable", "deadline"]), bound: z.enum(LIMIT_NAMES).optional() })
          .meta({ title: "PreviewUnavailableReason" }),
      })
      .meta({ title: "PreviewUnavailable" }),
  ])
  .meta({ title: "PreviewIgnoreResult" });

// Data-model §10. Text fields hold Git's stored bytes in base64, because blame runs with `--encoding=none`.
const RawBytes = z.base64();
const BlameCommit = z
  .strictObject({
    oid: ObjectId,
    author: RawBytes,
    authorMail: RawBytes,
    authorTime: z.int(),
    authorTz: z.string().regex(/^[+-][0-9]{4}$/),
    summary: RawBytes,
    previous: z.strictObject({ oid: ObjectId, pathBytes: PathBytes }).meta({ title: "BlamePrevious" }).nullable(),
    filenameBytes: PathBytes,
    shallow: z.boolean(),
  })
  .meta({ title: "BlameCommit" });
// `commit` is an index into `commits`. `ignored` and `unblamable` come only from the porcelain markers.
const BlameGroup = z
  .strictObject({ commit: Count, origStart: z.int().min(1), finalStart: z.int().min(1), count: z.int().min(1), ignored: z.boolean(), unblamable: z.boolean() })
  .meta({ title: "BlameGroup" });
// The groups cover the lines 1 to N exactly once, in final line order.
const coversLines = (groups: readonly { finalStart: number; count: number; commit: number }[], lines: number, commits: number) => {
  let next = 1;
  for (const g of groups) {
    if (g?.finalStart !== next || !(g.commit < commits)) return false;
    next += g.count;
  }
  return next === lines + 1;
};
export const Blame = z
  .strictObject({
    blameId: Identifier,
    commit: ObjectId,
    pathBytes: PathBytes,
    content: z.base64().refine((data) => decodedBytes(data) <= BLAME_FILE_BYTES),
    lines: Count.max(BLAME_FILE_LINES),
    ignoreList: z.enum(["none", "on", "off"]),
    groups: z.array(BlameGroup).max(BLAME_FILE_LINES),
    commits: z.array(BlameCommit).max(BLAME_FILE_LINES),
    // Data-model §10 and §11: only a `{blameId, line}` source carries the mapped line. A result without lines has none.
    focusLine: z.int().min(1).max(BLAME_FILE_LINES).optional(),
  })
  .refine((b) => Array.isArray(b.groups) && Array.isArray(b.commits) && coversLines(b.groups, b.lines, b.commits.length) && (b.focusLine === undefined || b.focusLine <= b.lines))
  .meta({ title: "Blame" });
// Contract Δ3 `readBlame` errors: the BLAME_UNAVAILABLE reason, the OBJECT_MISSING remedy, or the GIT_FAILED output tail.
// Only `ignore-revs-file-missing` carries `path`, the value as configured.
const BlameRefused = z
  .strictObject({ reason: z.enum(BLAME_UNAVAILABLE_REASONS).optional(), path: Text.min(1).optional(), remedy: Remedy.optional(), outputTail: OutputTail.optional() })
  .refine((r) => (r.path !== undefined) === (r.reason === "ignore-revs-file-missing") && [r.reason, r.remedy, r.outputTail].filter((v) => v !== undefined).length === 1)
  .meta({ title: "BlameRefused" });
export const ReadBlameResult = z.union([Blame, BlameRefused]).meta({ title: "ReadBlameResult" });
export type Blame = z.infer<typeof Blame>;

// Contract Δ3 `openSubmodule`: the 001 `chooseRepository` result, or the SUBMODULE_UNAVAILABLE reason.
export const OpenSubmoduleResult = z
  .union([RegistrationResult, z.strictObject({ reason: z.enum(SUBMODULE_UNAVAILABLE_REASONS) }).meta({ title: "SubmoduleRefused" })])
  .meta({ title: "OpenSubmoduleResult" });

// Contract Δ3 `revealPath`: the `reveal` reply `absent` gives UNKNOWN_TARGET with this reason. A shown path gives no value.
export const RevealPathResult = z.strictObject({ reason: z.enum(UNKNOWN_TARGET_REASONS) }).meta({ title: "RevealPathResult" });
