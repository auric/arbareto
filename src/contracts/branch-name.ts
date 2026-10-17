// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// FR-015 and plan.md D4: the branch name rule before Git's own `check-ref-format --branch`.
// The service and the renderer import this module. It has no runtime import and does not use `process`.

// Contract Δ5 "Branch name".
export const BRANCH_NAME_BYTES = 255;

export type BranchNameRefusal = { code: "INVALID_REQUEST" } | { code: "WORKBENCH_UNAVAILABLE"; reason: "reserved-name" };

// Null: the name goes to Git's check. Git accepts `@` (research.md R21 F11) but reads it as HEAD in a revision (F29).
export function branchNameRefusal(name: string): BranchNameRefusal | null {
  if (typeof name !== "string" || !name.isWellFormed() || name.includes("\0")) return { code: "INVALID_REQUEST" };
  const bytes = new TextEncoder().encode(name).length;
  if (bytes === 0 || bytes > BRANCH_NAME_BYTES) return { code: "INVALID_REQUEST" };
  return name === "@" ? { code: "WORKBENCH_UNAVAILABLE", reason: "reserved-name" } : null;
}
