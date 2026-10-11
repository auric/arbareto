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
} as const;

export type ErrorCategory = keyof typeof ERROR_CODES_BY_CATEGORY;
export type ErrorCode = (typeof ERROR_CODES_BY_CATEGORY)[ErrorCategory][number];

export const ERROR_CODES: readonly ErrorCode[] = Object.values(ERROR_CODES_BY_CATEGORY).flat();

// Contract §9: the reasons of `WSL_UNAVAILABLE`.
export const WSL_UNAVAILABLE_REASONS = ["wsl-missing", "distro-missing", "not-wsl2", "no-user-manager", "no-setsid", "no-coreutils", "no-perl", "start-failed"] as const;
export type WslUnavailableReason = (typeof WSL_UNAVAILABLE_REASONS)[number];

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
