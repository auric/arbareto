// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §9 "Error codes".
export const ERROR_CODES_BY_CATEGORY = {
  requestBoundary: ["INVALID_REQUEST", "PROTOCOL_VERSION", "UNKNOWN_OPERATION", "UNKNOWN_TARGET", "FRAME_LIMIT", "BUSY", "WORKSPACE_LIMIT"],
  prerequisites: ["GIT_UNAVAILABLE", "GIT_CHANGED", "GIT_UNSUPPORTED", "WEBVIEW_UNAVAILABLE", "WEBVIEW_UNSUPPORTED", "WSL_UNAVAILABLE"],
  repositoryState: [
    "REPOSITORY_UNAVAILABLE",
    "REPOSITORY_CHANGED",
    "UNSUPPORTED_REPOSITORY",
    "OPERATION_IN_PROGRESS",
    "CONFLICTED",
    "LOCKED",
    "UNSUPPORTED_SUBMODULE",
  ],
  trustAndApproval: ["TRUST_REQUIRED", "TRUST_CHANGED", "STALE_SELECTION", "STALE_REVIEW", "APPROVAL_EXPIRED", "UNSUPPORTED_HUNK_PROFILE"],
  dataAndDisplay: [
    "MALFORMED_GIT_OUTPUT",
    "OUTPUT_LIMIT",
    "OBJECT_MISSING",
    "UNSUPPORTED_COMPARISON",
    "DISPLAY_MAPPING_FAILED",
    "GRAPH_LAYOUT_LIMITED",
    "WORKTREE_CHANGING",
  ],
  execution: [
    "IDENTITY_REQUIRED",
    "HOOK_FAILED",
    "SIGNING_FAILED",
    "GIT_FAILED",
    "PROCESS_OWNERSHIP_FAILED",
    "PICKER_FAILED",
    "DEADLINE",
    "CANCELED",
    "COMMIT_ENCODING_UNSUPPORTED",
  ],
  recovery: ["COMPLETED_WITH_EFFECTS", "FAILED_WITH_EFFECTS", "STATE_UNKNOWN", "SERVICE_UNAVAILABLE", "RECOVERY_MARKER_FAILED"],
  // Feature 002 contract Δ9. The contract gives these codes no 001 category.
  history: ["HISTORY_CHANGED", "UNSUPPORTED_FILTER_TEXT", "SEARCH_UNSUPPORTED"],
  // Feature 003 contract Δ9. The contract gives these codes no 001 category.
  sync: ["SYNC_UNAVAILABLE", "PUSH_REJECTED", "PUTTY_UNAVAILABLE", "DESTINATION_NOT_EMPTY"],
  // Feature 004 contract Δ9. The contract gives these codes no 001 category.
  workbench: ["WORKBENCH_UNAVAILABLE", "UNTRACKED_IN_WAY", "STASH_KEPT"],
} as const;

export type ErrorCategory = keyof typeof ERROR_CODES_BY_CATEGORY;
export type ErrorCode = (typeof ERROR_CODES_BY_CATEGORY)[ErrorCategory][number];

export const ERROR_CODES: readonly ErrorCode[] = Object.values(ERROR_CODES_BY_CATEGORY).flat();

// Contract §9: the reasons of `WSL_UNAVAILABLE`.
export const WSL_UNAVAILABLE_REASONS = ["wsl-missing", "distro-missing", "not-wsl2", "no-user-manager", "scope-arguments", "no-setsid", "no-coreutils", "no-perl", "start-failed"] as const;
export type WslUnavailableReason = (typeof WSL_UNAVAILABLE_REASONS)[number];

// Feature 002 contract Δ9: the reasons of the new codes.
export const HISTORY_CHANGED_REASONS = ["order", "topology"] as const;
export type HistoryChangedReason = (typeof HISTORY_CHANGED_REASONS)[number];
export const UNSUPPORTED_FILTER_TEXT_REASONS = ["line-break", "nul", "quote-end", "length"] as const;
export type UnsupportedFilterTextReason = (typeof UNSUPPORTED_FILTER_TEXT_REASONS)[number];
export const SEARCH_UNSUPPORTED_REASONS = ["matching"] as const;
// Contract Δ9: the new `OUTPUT_LIMIT` reasons. Each is the export name of its `limits.ts` bound.
export const HISTORY_OUTPUT_LIMIT_REASONS = ["HISTORY_PARENTS_PER_COMMIT", "HISTORY_VIEW_COMMITS"] as const;
export type HistoryOutputLimitReason = (typeof HISTORY_OUTPUT_LIMIT_REASONS)[number];

// Feature 003 contract Δ9: the reasons of the new codes.
export const SYNC_UNAVAILABLE_REASONS = [
  "detached",
  "unborn",
  "no-upstream",
  "remote-missing",
  "no-remotes",
  "local-upstream",
  "several-merge-refs",
  "push-urls",
  "mirror",
  "push-remote-differs",
  "invalid-config",
  "no-lease",
  "ff-only",
  "interactive-rebase",
  "upstream-gone",
  "no-operation",
  "unknown-operation",
  "not-rebasing",
  "no-skip-commit",
  "rebase-exec",
] as const;
export type SyncUnavailableReason = (typeof SYNC_UNAVAILABLE_REASONS)[number];
export const PUSH_REJECTED_REASONS = ["rejected", "stale-lease", "remote-rejected", "remote-failure"] as const;
export const PUTTY_UNAVAILABLE_REASONS = ["missing", "unreadable", "version", "exit", "not-ready"] as const;
export const DESTINATION_NOT_EMPTY_REASONS = ["not-empty", "file", "other"] as const;
// Contract Δ5: the new `OUTPUT_LIMIT` reason. It is the export name of its `limits.ts` bound.
export const SYNC_OUTPUT_LIMIT_REASONS = ["SYNC_REMOTES"] as const;
// Contract Δ9: `PUTTY_UNAVAILABLE` names the program. O-7: Pageant and PuTTYgen sit in the plink folder.
export const PUTTY_PROGRAMS = ["plink", "pageant", "puttygen"] as const;

// Feature 004 contract Δ9: the reasons of the new codes.
export const WORKBENCH_UNAVAILABLE_REASONS = [
  "detached",
  "unborn",
  "current-branch",
  "other-worktree",
  "name-exists",
  "invalid-name",
  "reserved-name",
  "same-branch",
  "ff-only",
  "dirty-tree",
  "interactive",
  "no-merge-tool",
  "merge-tool-name",
  "side-missing",
  "side-not-regular",
  "stages-missing",
  "main-worktree",
  "current-worktree",
  "locked",
  "prunable",
  "nothing-to-prune",
  "multi-value",
  "limit",
  "push-current-only",
  "ignore-exists",
  "ignore-not-text",
  "ignore-not-regular",
  "ignore-size",
  "path",
  "message-size",
  "unreadable",
  "no-tracking-refspec",
  "several-tracking-remotes",
  "squash-no-ff",
  "merge-options",
  "invalid-config",
  "unknown-operation",
  "apply-backend",
  "config-in-include",
] as const;
export type WorkbenchUnavailableReason = (typeof WORKBENCH_UNAVAILABLE_REASONS)[number];
export const UNTRACKED_IN_WAY_REASONS = ["untracked-in-way"] as const;
export const STASH_KEPT_REASONS = ["conflicts", "failed-apply", "failed-checkout", "not-found", "stash-changed"] as const;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export const TERMINAL_STATES = [
  "succeeded",
  "limited",
  "failed",
  "canceled",
  "completed-with-effects",
  "failed-with-effects",
  "unknown",
  "rejected",
] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

// `none`: the state carries no code. `specific`: the state carries the specific failure or refusal code.
export const TERMINAL_STATE_CODES: Record<TerminalState, "none" | "specific" | readonly ErrorCode[]> = {
  succeeded: "none",
  limited: ["OUTPUT_LIMIT", "OBJECT_MISSING", "WORKTREE_CHANGING"],
  failed: "specific",
  canceled: ["CANCELED"],
  "completed-with-effects": ["COMPLETED_WITH_EFFECTS"],
  "failed-with-effects": ["FAILED_WITH_EFFECTS"],
  unknown: ["STATE_UNKNOWN"],
  rejected: "specific",
};

export function codeFitsState(state: TerminalState, code: unknown): boolean {
  const rule = TERMINAL_STATE_CODES[state];
  if (rule === "none") return code === undefined || code === null;
  if (!isErrorCode(code)) return false;
  // Contract §9: `SERVICE_UNAVAILABLE` is always a `rejected` result.
  if (code === "SERVICE_UNAVAILABLE") return state === "rejected";
  return rule === "specific" || rule.includes(code);
}
