// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { anchorFallback, createWorkspaceContexts, selectEntry, type ViewContext } from "../../src/frontend/state/workspace-context";

printOrigin("../../src/frontend/state/workspace-context.ts", import.meta.dir);

// plan.md "Selection, scroll, and stored context". Entry IDs change with each read, so a selection keys on category and path bytes (data-model §5).
const WORKTREE_A = "a".repeat(64);
const WORKTREE_B = "b".repeat(64);
const SNAPSHOT = crypto.randomUUID();
const COMPARISON = crypto.randomUUID();
const PATH = Buffer.from("src/app.ts").toString("base64");
const OTHER_PATH = Buffer.from("README.md").toString("base64");

const context = (fields: Partial<ViewContext> = {}): ViewContext => ({
  snapshotId: SNAPSHOT,
  category: "unstaged",
  selections: { unstaged: PATH },
  commitId: "c".repeat(40),
  anchor: { id: "row-7", offset: 12 },
  focus: "workingChanges",
  hunk: null,
  ...fields,
});
const current = { snapshotId: SNAPSHOT, comparisonId: COMPARISON };

describe("stored view context", () => {
  test("each worktree and docked panel keeps its own category, entry, selected commit ID, scroll anchor, and focus target", () => {
    const contexts = createWorkspaceContexts();
    const commitA = context();
    const detailsA = context({ category: null, selections: {}, commitId: "d".repeat(40), anchor: { id: "d".repeat(40), offset: 0 }, focus: "historyList" });
    const commitB = context({ category: "staged", selections: { staged: OTHER_PATH }, anchor: { id: "row-1", offset: 3 }, focus: "staged" });
    contexts.save(WORKTREE_A, "commit", commitA);
    contexts.save(WORKTREE_A, "details", detailsA);
    contexts.save(WORKTREE_B, "commit", commitB);
    expect(contexts.restore(WORKTREE_A, "commit", current)).toEqual(commitA);
    expect(contexts.restore(WORKTREE_A, "details", current)).toEqual(detailsA);
    expect(contexts.restore(WORKTREE_B, "commit", current)).toEqual(commitB);
    expect(contexts.restore(WORKTREE_B, "details", current)).toBeNull();
  });

  test("a scroll anchor is a stable ID plus an offset", () => {
    const contexts = createWorkspaceContexts();
    contexts.save(WORKTREE_A, "commit", context({ anchor: { id: "row-7", offset: 12.5 } }));
    expect(contexts.restore(WORKTREE_A, "commit", current)?.anchor).toEqual({ id: "row-7", offset: 12.5 });
  });

  test("the four category selections of one path stay distinct", () => {
    let view = context({ category: null, selections: {} });
    for (const category of ["staged", "unstaged", "untracked", "conflicted"] as const) view = selectEntry(view, { category, pathBytes: PATH });
    expect(view.selections).toEqual({ staged: PATH, unstaged: PATH, untracked: PATH, conflicted: PATH });
    expect(view.category).toBe("conflicted");
    view = selectEntry(view, { category: "unstaged", pathBytes: OTHER_PATH });
    expect(view.selections).toEqual({ staged: PATH, unstaged: OTHER_PATH, untracked: PATH, conflicted: PATH });
    view = selectEntry(view, { category: "staged", pathBytes: PATH });
    expect(view.category).toBe("staged");
    expect(view.selections.unstaged).toBe(OTHER_PATH);
  });

  test("a panel return restores the context only while identity and snapshot stay valid", () => {
    const contexts = createWorkspaceContexts();
    contexts.save(WORKTREE_A, "commit", context());
    expect(contexts.restore(WORKTREE_A, "commit", { snapshotId: crypto.randomUUID(), comparisonId: COMPARISON })).toBeNull();
    expect(contexts.restore(WORKTREE_B, "commit", current)).toBeNull();
    expect(contexts.restore(WORKTREE_A, "commit", current)).toEqual(context());
  });

  test("an obsolete hunk selection or approval never returns", () => {
    const contexts = createWorkspaceContexts();
    contexts.save(WORKTREE_A, "commit", context({ hunk: { comparisonId: COMPARISON, hunkId: crypto.randomUUID() } }));
    const restored = contexts.restore(WORKTREE_A, "commit", { snapshotId: SNAPSHOT, comparisonId: crypto.randomUUID() });
    expect(restored?.hunk).toBeNull();
    expect(restored?.selections).toEqual({ unstaged: PATH });
    expect(contexts.restore(WORKTREE_A, "commit", { snapshotId: SNAPSHOT, comparisonId: null })?.hunk).toBeNull();
  });

  test("the draft survives every panel change, also when the view context does not", () => {
    const contexts = createWorkspaceContexts();
    const draft = { text: "Fix the parser\n\nKeep the caret.", caret: 7 };
    contexts.saveDraft(WORKTREE_A, draft);
    contexts.save(WORKTREE_A, "commit", context());
    expect(contexts.restore(WORKTREE_A, "commit", { snapshotId: crypto.randomUUID(), comparisonId: null })).toBeNull();
    expect(contexts.draft(WORKTREE_A)).toEqual(draft);
    expect(contexts.restore(WORKTREE_A, "details", current)).toBeNull();
    expect(contexts.draft(WORKTREE_A)).toEqual(draft);
    expect(contexts.draft(WORKTREE_B)).toBeNull();
  });
});

describe("scroll anchor fallback", () => {
  const before = ["a", "b", "c", "d", "e"];

  test("a surviving anchor stays as it is", () => {
    expect(anchorFallback({ id: "c", offset: 7 }, before, ["a", "c", "e"])).toEqual({ id: "c", offset: 7 });
  });

  test("a missing anchor falls back to the nearest surviving row", () => {
    expect(anchorFallback({ id: "c", offset: 7 }, before, ["a", "d", "e"])?.id).toBe("d");
    expect(anchorFallback({ id: "c", offset: 7 }, before, ["b", "e"])?.id).toBe("b");
  });

  test("no surviving row gives no anchor", () => {
    expect(anchorFallback({ id: "c", offset: 7 }, before, [])).toBeNull();
    expect(anchorFallback({ id: "c", offset: 7 }, before, ["x"])).toBeNull();
  });
});
