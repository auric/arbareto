// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T027: the Commit view diff helpers of the revert tests. The caller mocks PatchView with `PatchDouble`, mocks PatchPool, registers the DOM, and passes the Workbench module.

import { act, type ReactNode } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { fixtureId } from "./bridge-contract";
import { b64, entry, openCommitView, pressKey } from "./commit-fake";
import { answer, button, click, createWorld, settle, succeeded } from "./sync-fake";

type WorkbenchModule = typeof import("../../src/frontend/app/Workbench");

// Pierre needs the Vite build (T160). The double renders each hunk annotation, the new start line of the anchor hunk, and whether a line selection shows, and keeps the line-selection callback.
export const pierre: { onLines: ((range: unknown) => void) | null } = { onLines: null };
export function PatchDouble({ patch, hunkAction, onLines, anchor, lines }: { patch: string; hunkAction?: (index: number) => ReactNode; onLines?: (range: unknown) => void; anchor?: { additionStart: number } | null; lines?: unknown }) {
  pierre.onLines = onLines ?? null;
  const count = patch.split("\n").filter((l) => l.startsWith("@@")).length;
  return (
    <div data-slot="patch-double" data-anchor={anchor?.additionStart} data-lines={lines == null ? undefined : "selected"}>
      <pre>{patch}</pre>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} data-hunk={i}>
          {hunkAction?.(i)}
        </div>
      ))}
    </div>
  );
}

// Rows: " a"(1) "-b"(2) "+B"(3) "+C"(4) " d"(5) " e"(6); then " x"(1) "+y"(2) " z"(3).
export const PATCH = ["diff --git a/login.ts b/login.ts", "index 1..2 100644", "--- a/login.ts", "+++ b/login.ts", "@@ -1,4 +1,5 @@", " a", "-b", "+B", "+C", " d", " e", "@@ -10,2 +11,3 @@", " x", "+y", " z", ""].join("\n");
export const DELETED = ["diff --git a/login.ts b/login.ts", "deleted file mode 100644", "index 1..0", "--- a/login.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b", ""].join("\n");
export const COMPARISON = fixtureId(0x8ff);
export const hunk = (ordinal: number, oldStart: number, oldCount: number, newStart: number, newCount: number) => ({ hunkId: fixtureId(0x800 + ordinal), ordinal, oldStart, oldCount, newStart, newCount, digest: String(ordinal).repeat(64) });
export const HUNKS = [hunk(0, 1, 4, 1, 5), hunk(1, 10, 2, 11, 3)];
export const TOKEN = fixtureId(0x8d0);

export const commitView = () => document.querySelector<HTMLElement>('section[aria-label="Commit view"]')!;
export const diffBody = () => commitView().querySelector<HTMLElement>('[data-slot="diff-body"]')!;
export const alertDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
export const hunkRow = (index: number) => commitView().querySelector<HTMLElement>(`[data-hunk="${index}"]`)!;

/** Opens the Commit view with one file and shows its diff. With `freshIds`, each comparison read has a new `comparisonId`, as in the service. */
export async function shownDiff(module: WorkbenchModule, { category = "unstaged", path = "login.ts", patch = PATCH, hunks = HUNKS, others = [], freshIds = false }: { category?: ChangeEntry["category"]; path?: string; patch?: string; hunks?: unknown[]; others?: ChangeEntry[]; freshIds?: boolean } = {}) {
  const file = entry(category, path);
  const world = createWorld({ entries: [file, ...others] });
  const scope = category === "staged" ? "head-to-index" : category === "untracked" ? "empty-to-untracked" : "index-to-worktree";
  let reads = 0;
  world.answers.readComparison = (args) => {
    const payload = args[1] as { snapshotId: string; entryId: string };
    return succeeded({ comparisonId: freshIds ? fixtureId(0x900 + reads++) : COMPARISON, snapshotId: payload.snapshotId, entryId: payload.entryId, scope, completeness: { state: "complete" }, patch: Buffer.from(patch).toString("base64"), hunks, support: "supported", fileAction: category === "staged" ? "unstage" : "stage", remedy: null });
  };
  const double = await openCommitView(module, world);
  const tree = category === "staged" ? "Staged" : "Changes";
  const row = [...document.querySelectorAll<HTMLElement>(`[role="tree"][aria-label="${tree}"] [role="treeitem"]`)].find((i) => i.getAttribute("aria-label")?.startsWith(`${path}, `) || i.getAttribute("aria-label") === path)!;
  await click(row);
  await settle();
  return { double, file, world };
}

/** Selects lines through the Pierre callback. */
export async function selectLines(range: unknown) {
  await act(async () => pierre.onLines!(range));
  await settle();
}

/** Selects the first hunk through Next hunk. */
export const selectFirstHunk = () => click(button("Next hunk", commitView()));

/** R in the diff body. */
export async function revertKey(init: KeyboardEventInit = {}) {
  await act(async () => diffBody().focus());
  return pressKey(diffBody(), "r", init);
}

export const plan = (lines: number | null, scope: "unstaged" | "staged" = "unstaged", path = "login.ts") => ({ scope, fileBytes: Buffer.from(path).toString("base64"), lines });
export const reviewed = (p: ReturnType<typeof plan>) => succeeded({ action: "revert-lines", plan: p, workbenchToken: TOKEN });

/** Answers the pending revert review with `p`, so the confirmation opens. */
export async function confirmFor(double: Awaited<ReturnType<typeof shownDiff>>["double"], p: ReturnType<typeof plan>) {
  await answer(double.pending("reviewWorkbench"), reviewed(p));
  return alertDialog()!;
}

// Feature 008 T031: the Changes and Staged list helpers of the Revert file tests.

/** Contract `RevertFilesPlan`: `paths` holds the first 20 paths in the given order. */
export const filesPlan = (paths: string[], fields: Partial<{ count: number; newFiles: number; staged: number; unstaged: number }> = {}) => {
  const count = fields.count ?? paths.length;
  return { count, paths: paths.slice(0, 20).map(b64), newFiles: 0, staged: 0, unstaged: count, ...fields };
};
export const filesReviewed = (p: ReturnType<typeof filesPlan>) => succeeded({ action: "revert-files", plan: p, workbenchToken: TOKEN });

/** Opens the Commit view with `entries`. */
export async function openFiles(module: WorkbenchModule, entries: ChangeEntry[]) {
  const world = createWorld({ entries });
  const double = await openCommitView(module, world);
  return { world, double };
}

/** Ctrl+click toggles the mark of a row, and Shift+click marks the range from the anchor. */
export async function markRow(row: HTMLElement, mode: "toggle" | "range" = "toggle") {
  await act(async () => void row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: mode === "toggle", shiftKey: mode === "range" })));
  await settle();
}

// Feature 008 T036: the Revert all unstaged changes helpers.

/** Contract `RevertUnstagedPlan`: `paths` holds the first 20 paths in the given order. */
export const unstagedPlan = (paths: string[], fields: Partial<{ count: number; submodules: number }> = {}) => ({ count: fields.count ?? paths.length, paths: paths.slice(0, 20).map(b64), submodules: fields.submodules ?? 0 });
export const unstagedReviewed = (p: ReturnType<typeof unstagedPlan>) => succeeded({ action: "revert-unstaged", plan: p, workbenchToken: TOKEN });
export const changesHeader = () => document.querySelector('[role="tree"][aria-label="Changes"]')!.closest("section")!.querySelector('[data-list-heading="Changes"]')!.parentElement!;
export const filterField = () => document.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!;

/** Opens the Changes header menu and selects Revert all unstaged changes…. */
export async function revertAllUnstaged() {
  await click(button("More actions", changesHeader()));
  await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.startsWith("Revert all unstaged changes…"))!);
}

/** R on a list row. */
export async function rowKey(row: HTMLElement, init: KeyboardEventInit = {}) {
  await act(async () => row.focus());
  return pressKey(row, "r", init);
}
