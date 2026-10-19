// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry } from "../../contracts/envelope";

// plan.md "History graph design" and "Required visible states": the parts of the history list that feature 002 keeps from feature 001.

export const LIMIT_TEXT = { lanes: "Graph layout limited: more than 24 lanes" } as const;
const LOADING = "Loading…";
const CLEAN = "Working tree clean";
/** The option IDs of the Working directory and Index rows. A commit OID is hex, so it never equals them. */
export const WORKING_ROW = "working-directory";
export const INDEX_ROW = "index";

// Git ref names: a local branch is `refs/heads/<name>` (git-check-ref-format(1)).
export const branchName = (target: string) => (target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : target);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type Counted = { category: ChangeEntry["category"] };

/** plan.md "History graph design": the visible parts of the Working directory and Index rows. Null parts show Loading. */
export function specialParts(entries: readonly Counted[] | null, unread: string | null = null): { working: string[]; conflicted: string | null; index: string[] } {
  // Feature 004 spec FR-072: a read that the trust gate refused is no load in progress.
  if (entries === null) return { working: ["Working directory", unread ?? LOADING], conflicted: null, index: ["Index", unread ?? LOADING] };
  let conflicted = 0;
  let working = 0;
  let staged = 0;
  for (const { category } of entries) {
    if (category === "conflicted") conflicted++;
    else if (category === "staged") staged++;
    else working++;
  }
  const clean = working === 0 && conflicted === 0;
  return {
    working: ["Working directory", clean ? CLEAN : plural(working, "working change", "working changes")],
    conflicted: conflicted > 0 ? `${conflicted} conflicted` : null,
    index: ["Index", `${staged} staged`],
  };
}
