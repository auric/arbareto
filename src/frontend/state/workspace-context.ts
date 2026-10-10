// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry } from "../../contracts/envelope";
import type { Panel, Section } from "../keyboard/shortcuts";

// plan.md "Selection, scroll, and stored context". Entry IDs change with each read, so a selection keys on category and path bytes (data-model §5).

export type Category = ChangeEntry["category"];
export type Anchor = { id: string; offset: number };
export type HunkSelection = { comparisonId: string; hunkId: string };
export type ViewContext = {
  snapshotId: string;
  category: Category | null;
  selections: Partial<Record<Category, string>>;
  commitId: string | null;
  anchor: Anchor | null;
  focus: Section;
  hunk: HunkSelection | null;
};
export type Draft = { text: string; caret: number };
export type Current = { snapshotId: string; comparisonId: string | null };

/** Keeps one view context per worktree and docked panel, and one draft per worktree, in renderer memory. */
export function createWorkspaceContexts() {
  const contexts = new Map<string, ViewContext>();
  const drafts = new Map<string, Draft>();
  // A worktree key is 64 hex digits, so the separator never occurs in it.
  const key = (worktreeKey: string, panel: Panel) => `${worktreeKey}/${panel}`;

  return {
    save(worktreeKey: string, panel: Panel, context: ViewContext): void {
      contexts.set(key(worktreeKey, panel), context);
    },
    /** Null when the context is missing or its snapshot is no longer current. The hunk returns only with its comparison. */
    restore(worktreeKey: string, panel: Panel, current: Current): ViewContext | null {
      const context = contexts.get(key(worktreeKey, panel));
      if (!context || context.snapshotId !== current.snapshotId) return null;
      const hunk = context.hunk !== null && context.hunk.comparisonId === current.comparisonId ? context.hunk : null;
      return { ...context, hunk };
    },
    saveDraft(worktreeKey: string, draft: Draft): void {
      drafts.set(worktreeKey, draft);
    },
    draft(worktreeKey: string): Draft | null {
      return drafts.get(worktreeKey) ?? null;
    },
  };
}

/** Selects one entry of one category. The other categories keep their selections. A changed entry drops the hunk selection. */
export function selectEntry(view: ViewContext, entry: { category: Category; pathBytes: string }): ViewContext {
  const same = view.category === entry.category && view.selections[entry.category] === entry.pathBytes;
  return { ...view, category: entry.category, selections: { ...view.selections, [entry.category]: entry.pathBytes }, hunk: same ? view.hunk : null };
}

/**
 * Keeps a surviving anchor. Otherwise it takes the surviving row nearest to the anchor position in `before`, with offset 0.
 * On equal distance, the following row wins, so the rows below the anchor keep their place.
 */
export function anchorFallback(anchor: Anchor, before: readonly string[], after: readonly string[]): Anchor | null {
  const surviving = new Set(after);
  if (surviving.has(anchor.id)) return anchor;
  const index = before.indexOf(anchor.id);
  if (index < 0) return null;
  for (let distance = 1; distance < before.length; distance++) {
    for (const candidate of [before[index + distance], before[index - distance]]) {
      if (candidate !== undefined && surviving.has(candidate)) return { id: candidate, offset: 0 };
    }
  }
  return null;
}
