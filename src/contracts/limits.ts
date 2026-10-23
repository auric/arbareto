// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §5 "Finite bounds". The first reached bound wins.

const KIB = 1024;
const MIB = 1024 * KIB;
const SECOND_MS = 1000;

export const PUBLIC_REQUEST_BYTES = 1 * MIB;
// The shell wraps the envelope in `{"kind":"public","request":` and `}`, which add 28 bytes.
export const PUBLIC_FRAME_BODY_BYTES = PUBLIC_REQUEST_BYTES + 28;
export const PIPE_FRAME_BYTES = 16 * MIB;
export const JSON_NESTING_LEVELS = 16;
export const IDENTIFIER_BYTES = 64;
export const WEBVIEW2_VERSION_BYTES = 64;
export const COMMIT_MESSAGE_BYTES = 64 * KIB;
export const COMPARED_RAW_VERSION_BYTES = 1_048_576;
export const COMPARED_NORMALIZED_VERSION_BYTES = 1_048_576;
export const WHOLE_FILE_STAGE_INPUT_BYTES = 536_870_912;
export const CANONICAL_DIFF_LINES = 20_000;
export const CANONICAL_DIFF_BYTES = 4 * MIB;
export const STATUS_LISTING_BYTES = 32 * MIB;
export const STATUS_LISTING_RECORDS = 100_000;
// The encoded result of each `readWorkspace` first page and each `readEntries` page.
export const STATUS_PAGE_BYTES = 8 * MIB;
export const MUTATION_RAW_INDEX_BYTES = 64 * MIB;
export const ATTRIBUTION_EVIDENCE_BYTES = 4 * MIB;
export const ATTRIBUTION_EVIDENCE_RECORDS = 10_000;
// Also the feature 002 contract Δ5 bound of a `rev-list --parents` line.
export const HISTORY_PARENTS_PER_COMMIT = 64;
export const HISTORY_PARENTS_PER_PAGE = 1024;
export const SHALLOW_METADATA_BYTES = 4 * MIB;
export const HISTORY_COMMIT_OBJECT_BYTES = 256 * KIB;
// The encoded result of each `readHistoryRows` response.
export const HISTORY_PAGE_BYTES = 8 * MIB;
// Contract §5 "Reference listing": the `readRefs` Git output.
export const REF_LISTING_RECORDS = 10_000;
export const REF_LISTING_BYTES = 4 * MIB;
export const GRAPH_LANES = 24;
export const TRUST_INPUT_BYTES = 4 * MIB;
// Contract §5 "Trust report rows": the `readTrust` report rows that the Trust dialog renders. Above either bound, `readTrust` refuses the whole report.
export const TRUST_REPORT_ENTRIES = 4096;
export const TRUST_REPORT_HOOKS = 256;
// Feature 004 contract Δ7 removes the 001 row "Trust program file digests" for a repository listing. Only the contract §12 submodule listing still digests program files within these bounds.
export const TRUST_DIGEST_FILES = 64;
export const TRUST_DIGEST_FILE_BYTES = 1 * MIB;
export const TRUST_DIGEST_TOTAL_BYTES = 8 * MIB;
export const TRUST_LINK_HOPS = 8;
export const FILE_FACT_ENTRIES = 64;
// Contract §6 "File facts": the Windows file name component limit.
export const FILE_FACT_COMPONENT_UNITS = 255;
export const GIT_EXECUTABLE_DIGEST_BYTES = 256 * MIB;
export const DIAGNOSTIC_RETAINED_BYTES_PER_STREAM = 64 * KIB;
export const UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION = 4 * MIB;
export const NATIVE_CHUNK_BYTES = 64 * KIB;
export const QUEUED_PIPE_CHUNKS_PER_STREAM = 8;
export const UNACKNOWLEDGED_INPUT_CHUNKS = 8;
export const INLINE_PROCESS_INPUT_BYTES = 64 * KIB;
export const STREAMED_PROCESS_INPUT_BYTES = WHOLE_FILE_STAGE_INPUT_BYTES;
export const FINISHED_OPERATION_RECORDS = 256;
export const REGISTERED_WORKSPACES = 8;
export const TRUST_RECORD_BYTES = 4 * KIB;
export const TRUST_RECORDS = 256;
export const RETAINED_COMPARISONS = 4;
export const RETAINED_COMPARISON_BYTES = 128 * MIB;
export const APPROVAL_LIFETIME_MS = 60 * SECOND_MS;
export const CONCURRENT_READS_PER_WORKSPACE = 2;
export const CONCURRENT_READS_GLOBAL = 4;
export const PENDING_READS_GLOBAL = 8;
export const MUTATIONS_PER_COMMON_REPOSITORY = 1;
export const READ_DEADLINE_MS = 30 * SECOND_MS;
export const COMMIT_PROCESS_DEADLINE_MS = 120 * SECOND_MS;
export const GIT_PROCESS_DEADLINE_MS = 30 * SECOND_MS;
export const SUBMODULE_UPDATE_INACTIVITY_MS = 300 * SECOND_MS;
export const SUBMODULE_UPDATE_CEILING_MS = 4 * 60 * 60 * SECOND_MS;
export const STALL_NOTICE_MS = 15 * SECOND_MS;
export const SUBMODULE_REVIEW_SUBMODULES = 256;
export const SUBMODULE_REVIEW_NESTING_LEVELS = 8;
export const SUBMODULE_GITMODULES_BYTES = 1 * MIB;
export const SUBMODULE_PROGRESS_EVENTS_PER_SECOND = 4;
export const WSL_DISTRO_START_MS = 60 * SECOND_MS;
export const WSL_POLL_GAP_MS = 1 * SECOND_MS;
export const WSL_ANCHOR_LINE_INTERVAL_MS = 1 * SECOND_MS;
export const COMMIT_OUTPUT_TAIL_BYTES = 16 * KIB;
export const COMMIT_OUTPUT_TAIL_LINES = 100;
export const RECONCILIATION_TARGET_MS = 5 * SECOND_MS;
export const RECOVERY_MARKER_BYTES = 4 * KIB;
export const RECOVERY_MARKERS_PER_HANDSHAKE = 64;
export const DAMAGED_MARKERS_PER_HANDSHAKE = 64;
// Contract §6 "Startup handshake" `damagedMarkers`: the Windows file name component limit.
export const DAMAGED_MARKER_FILE_NAME_UNITS = 255;
export const RECORDED_REQUEST_IDS = 65_536;
export const SESSION_LOG_ENTRIES = 1_000;
export const CLOSE_CLEANUP_TARGET_MS = 5 * SECOND_MS;

// Contract §6 "Process fields" and "Channel frames".
// Microsoft Learn `CreateProcessW`: the command line, with the terminating null.
export const WINDOWS_COMMAND_LINE_UNITS = 32_767;
export const CHANNEL_PATH_UNITS = 32_767;
export const IDENTITY_PATHS = 8;
export const BOOTSTRAP_DEADLINE_CAP_MS = 30 * SECOND_MS;
export const REGISTERED_DEADLINE_CAP_MS = 120 * SECOND_MS;
export const PROCESS_EXIT_CODE_MAX = 4_294_967_295;
export const REGISTER_VERSION_BYTES = 64;

// Feature 002 contract Δ5 "Finite bounds". The 001 bounds above stay in force.
// The text object bound of a `readHistoryRows` row is HISTORY_COMMIT_OBJECT_BYTES.
export const HISTORY_VIEWS_PER_SESSION = 1;
export const HISTORY_PROCESS_DEADLINE_MS = 120 * SECOND_MS;
export const HISTORY_TEXT_DEADLINE_MS = 30 * SECOND_MS;
export const HISTORY_ROWS_PER_REQUEST = 512;
export const HISTORY_VIEW_COMMITS = 4_000_000;
export const HISTORY_LOAD_MARGIN = 1024;
export const FILTER_TEXT_BYTES = 1024;
export const HISTORY_PROGRESS_EVENTS_PER_SECOND = 4;
export const HISTORY_CHECKPOINT_ROWS = 256;
export const HISTORY_RENDERER_CACHE_BYTES = 8 * MIB;
export const HISTORY_PROCESSES_PER_VIEW = 3;

// Feature 003 contract Δ5 "Finite bounds". The 001 network limits, the read deadline, and the output tail stay in force.
// Listed fetch updates per remote. The counts by flag cover all lines.
export const SYNC_FETCH_LISTED_REFS = 1_000;
// Lines of `git remote`.
export const SYNC_REMOTES = 256;
// Lease subjects. The count stays exact.
export const SYNC_LEASE_COMMITS = 100;
// Above this count, the label shows "10000+".
export const TRACKING_COUNT_DISPLAY = 10_000;
// The `sync` refs listing.
export const SYNC_REFS_RECORDS = 100_000;
export const SYNC_REFS_BYTES = 32 * MIB;
// `rebase-merge/git-rebase-todo` of a Continue or Skip review. Above it, the review refuses with `rebase-exec`.
export const SYNC_REBASE_TODO_BYTES = 4 * MIB;
export const PAGEANT_READY_MS = 30 * SECOND_MS;
// UTF-8 bytes of a clone URL.
export const CLONE_URL_BYTES = 4096;
// Key file entries in the shell settings.
export const KEY_FILE_ENTRIES = 256;

// Feature 004 contract Δ5 "Finite bounds". The 001 and 003 bounds above stay in force.
// Files and working bytes of one `applyFiles` action.
export const MULTI_FILE_ACTION_FILES = 10_000;
export const MULTI_FILE_ACTION_BYTES = STREAMED_PROCESS_INPUT_BYTES;
// Plan.md O-17: the per-file blob proofs and working-file digests of one `applyFiles` action that run at once.
export const MULTI_FILE_PROOF_CONCURRENCY = 8;
// Plan.md O-17: the `update-index` step and each step 7 status read of `applyFiles` get GIT_PROCESS_DEADLINE_MS plus this time per file, at most REGISTERED_DEADLINE_CAP_MS.
export const MULTI_FILE_STEP_MS_PER_FILE = 15;
// The `check-attr` output of one `applyFiles` action.
export const MULTI_FILE_ATTRIBUTE_BYTES = 64 * MIB;
// Candidate paths of the plan D3 Discard check.
export const DISCARD_CHECK_PATHS = 20_000;
// The `worktree list --porcelain -z` output.
export const WORKTREE_RECORDS = 1000;
export const WORKTREE_LISTING_BYTES = 4 * MIB;
// Entries of one stash or HEAD reflog read.
export const REFLOG_SCAN_ENTRIES = 10_000;
// The `-m` item of the merge argv. Plan D5: 2 × 8,192 + 3 units leave 16,380 of the 32,767 command-line units.
export const MERGE_MESSAGE_BYTES = 8 * KIB;

// Feature 006 contract Δ5 "Finite bounds". The 001 to 004 bounds above stay in force.
// Contract Δ5 "Catalog entries": the folders of the pinned commit.
export const DICTIONARY_CATALOG_ENTRIES = 92;
// The files of one language together. The FR-017 gate.
export const DICTIONARY_LANGUAGE_BYTES = 12 * MIB;
// The bounded read of `entry.json`.
export const DICTIONARY_MANIFEST_BYTES = 64 * KIB;
// One `readDictionary` chunk, 1,398,104 bytes as base64.
export const DICTIONARY_CHUNK_BYTES = 1 * MIB;
// One download or import run.
export const DICTIONARY_DOWNLOAD_DEADLINE_MS = REGISTERED_DEADLINE_CAP_MS;
// One worker load, from the first `readDictionary` call.
export const DICTIONARY_LOAD_DEADLINE_MS = READ_DEADLINE_MS;
export const DICTIONARY_PROGRESS_EVENTS_PER_SECOND = 4;
// Selected languages, English included. Also the concurrent `readDictionary` calls.
export const SPELLING_LANGUAGES = 3;
export const SPELLING_SUGGESTIONS = 5;
export const PERSONAL_WORDS = 10_000;
export const PERSONAL_WORD_CODE_POINTS = 100;
// Test only: the packaged gate of plan.md D3.
export const DICTIONARY_LOAD_GATE_MS = 10 * SECOND_MS;
export const DICTIONARY_LANGUAGE_MEMORY_BYTES = 256 * MIB;
