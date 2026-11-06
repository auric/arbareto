// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 010 plan.md D3 read 1: the tag name rule before Git's own `check-ref-format refs/tags/<name>`.
// The service and the renderer import this module. It imports only `branch-name.ts` and does not use `process`.

import { BRANCH_NAME_BYTES } from "./branch-name";

export type TagNameRefusal = { code: "INVALID_REQUEST" } | { code: "WORKBENCH_UNAVAILABLE"; reason: "invalid-name" | "reserved-name" };

// Data-model §3: no control character (Unicode category Cc).
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// Null: the name goes to Git's check. Research.md R2 P9: `check-ref-format` accepts `-x`, `HEAD`, and `@`, but `git tag` refuses `-x` and `HEAD`.
// A revision reads `@` as HEAD.
export function tagNameRefusal(name: string): TagNameRefusal | null {
  if (typeof name !== "string" || !name.isWellFormed() || CONTROL.test(name)) return { code: "INVALID_REQUEST" };
  const bytes = new TextEncoder().encode(name).length;
  if (bytes === 0 || bytes > BRANCH_NAME_BYTES) return { code: "INVALID_REQUEST" };
  if (name.startsWith("-")) return { code: "WORKBENCH_UNAVAILABLE", reason: "invalid-name" };
  return name === "HEAD" || name === "@" ? { code: "WORKBENCH_UNAVAILABLE", reason: "reserved-name" } : null;
}
