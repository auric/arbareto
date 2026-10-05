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
export const HISTORY_STREAM_ROWS = 100;
export const HISTORY_STREAM_BYTES = 128 * KIB;
export const HISTORY_PARENTS_PER_COMMIT = 64;
export const HISTORY_PARENTS_PER_PAGE = 1024;
export const SHALLOW_METADATA_BYTES = 4 * MIB;
export const HISTORY_COMMIT_OBJECT_BYTES = 256 * KIB;
// The encoded result of each `readHistory` response.
export const HISTORY_PAGE_BYTES = 8 * MIB;
export const GRAPH_LANES = 24;
export const GRAPH_PATH_SEGMENTS = 4096;
export const TRUST_INPUT_BYTES = 4 * MIB;
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
