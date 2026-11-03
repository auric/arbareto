// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import type { BridgeResponse } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { entry, item, pressKey, statusBar, tree } from "./commit-fake";
import { createFake, oid, stubLayout, TARGET } from "./history-fake";
import { alertDialog, commitView, COMPARISON, confirmFor, diffBody, filesPlan, filesReviewed, hunk, HUNKS, markRow, PATCH, openFiles, PatchDouble, plan, revertAllUnstaged, revertKey, rowKey, selectFirstHunk, selectLines, shownDiff, unstagedPlan, unstagedReviewed } from "./revert-fake";
import { answer, button, click, NO_POLL, settle, snapshot, succeeded, text, unmountAll } from "./sync-fake";

// tasks.md T027, T031, T036, and T059 (feature 008). Stories US1, US2, US3. Spec FR-006, FR-012, FR-018, FR-042, FR-046. Plan D12 "Keys".

printOrigin("../../src/frontend/changes/ComparisonView.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/HunkControls.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/CommitChanges.tsx", import.meta.dir);
printOrigin("../../src/frontend/keyboard/shortcuts.ts", import.meta.dir);
printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: PatchDouble }));
registerDom();
const { createRoot } = await import("react-dom/client");
const workbench = await import("../../src/frontend/app/Workbench");
const { CommitChanges, HISTORY_PANES } = await import("../../src/frontend/history/CommitChanges");
const { createHistoryView, createInspection } = await import("../../src/frontend/state/history-view");
const { RESET_NOTICE } = await import("../../src/frontend/changes/ComparisonView");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(() => unmountAll());

const reviews = (double: Awaited<ReturnType<typeof shownDiff>>["double"]) => double.calls.filter((c) => c.operation === "reviewWorkbench");
const refresh = async () => {
  await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true })));
  await settle();
  await settle();
};
/** Each later status read gives the snapshot that the review names, as an equal full read does (contract 001 §8). */
const keepSnapshot = (world: Awaited<ReturnType<typeof shownDiff>>["world"], double: Awaited<ReturnType<typeof shownDiff>>["double"]) => {
  const { snapshotId } = reviews(double)[0]!.args[1] as { snapshotId: string };
  world.answers.readWorkspace = () => succeeded({ ...snapshot(world), snapshotId });
};
/** Each later comparison read gives `patch` and `hunks`. */
const changePatch = (world: Awaited<ReturnType<typeof shownDiff>>["world"], patch: string, hunks: unknown[]) => {
  const previous = world.answers.readComparison!;
  world.answers.readComparison = (args) => {
    const response = previous(args) as { result: Record<string, unknown> };
    return { ...response, result: { ...response.result, patch: Buffer.from(patch).toString("base64"), hunks } };
  };
};
// PATCH after the revert of its first hunk.
const AFTER = ["diff --git a/login.ts b/login.ts", "index 1..3 100644", "--- a/login.ts", "+++ b/login.ts", "@@ -10,2 +10,3 @@", " x", "+y", " z", ""].join("\n");

describe("R in the Commit view diff (FR-012, FR-046)", () => {
  test("with a line selection, R opens the review of exactly those lines", async () => {
    const { double } = await shownDiff(workbench);
    await selectLines({ start: 2, side: "deletions", end: 3, endSide: "additions" });
    const event = await revertKey();
    expect(event.defaultPrevented).toBe(true);
    expect(reviews(double)).toHaveLength(1);
    expect(reviews(double)[0]!.args[1]).toEqual({ action: "revert-lines", snapshotId: expect.any(String), comparisonId: COMPARISON, hunkId: HUNKS[0]!.hunkId, lines: [2, 3, 4] });
    expect(statusBar()).toContain("Checking 1 file…");
  });

  test("with only a selected hunk, R opens the review of that hunk", async () => {
    const { double } = await shownDiff(workbench);
    await selectFirstHunk();
    await revertKey();
    expect(reviews(double)).toHaveLength(1);
    expect(reviews(double)[0]!.args[1]).toEqual({ action: "revert-lines", snapshotId: expect.any(String), comparisonId: COMPARISON, hunkId: HUNKS[0]!.hunkId });
  });

  test("without a line selection or a selected hunk, R sends nothing and shows No hunk is selected.", async () => {
    const { double } = await shownDiff(workbench);
    await revertKey();
    expect(reviews(double)).toHaveLength(0);
    expect(alertDialog()).toBeNull();
    expect(statusBar()).toContain("No hunk is selected.");
  });

  test("R does nothing during an IME composition, in an editable field, or as a key repeat", async () => {
    const { double } = await shownDiff(workbench);
    await selectFirstHunk();
    await revertKey({ isComposing: true });
    await revertKey({ repeat: true });
    const field = diffBody().appendChild(document.createElement("textarea"));
    await act(async () => field.focus());
    await pressKey(field, "r");
    field.remove();
    expect(reviews(double)).toHaveLength(0);
  });
});

// tasks.md T040 (feature 008, WP5). Story US4. Spec FR-012, FR-016, FR-017, FR-040. Plan D4, D11 `REVERT_PARTIAL`, D12.
describe("R in the staged diff (US4)", () => {
  test("R opens the staged review of the selected lines, and of the selected hunk", async () => {
    const { double } = await shownDiff(workbench, { category: "staged" });
    await selectLines({ start: 2, side: "deletions", end: 3, endSide: "additions" });
    await revertKey();
    expect(reviews(double)).toHaveLength(1);
    expect(reviews(double)[0]!.args[1]).toEqual({ action: "revert-lines", snapshotId: expect.any(String), comparisonId: COMPARISON, hunkId: HUNKS[0]!.hunkId, lines: [2, 3, 4] });
    await unmountAll();

    const second = await shownDiff(workbench, { category: "staged" });
    await selectFirstHunk();
    await revertKey();
    expect(reviews(second.double)).toHaveLength(1);
    expect(reviews(second.double)[0]!.args[1]).toEqual({ action: "revert-lines", snapshotId: expect.any(String), comparisonId: COMPARISON, hunkId: HUNKS[0]!.hunkId });
  });

  test("a file that also has unstaged changes: no modal opens, and the status names the reason", async () => {
    const { double } = await shownDiff(workbench, { category: "staged" });
    await selectLines({ start: 2, side: "deletions", end: 3, endSide: "additions" });
    await revertKey();
    await answer(double.pending("reviewWorkbench"), { ...succeeded({ reason: "unstaged-changes" }), state: "failed", code: "WORKBENCH_UNAVAILABLE" });
    expect(alertDialog()).toBeNull();
    expect(double.count("runWorkbench")).toBe(0);
    expect(statusBar()).toContain("Revert 3 lines is unavailable.");
    expect(text(statusArea()!)).toContain("This file also has unstaged changes. Revert or stage them first.");
  });

  /** R on 2 selected staged lines, Revert lines in the confirmation, then the pending run. */
  async function runStaged() {
    const { double, file } = await shownDiff(workbench, { category: "staged" });
    await selectLines({ start: 2, side: "additions", end: 3 });
    await revertKey();
    const dialog = await confirmFor(double, plan(2, "staged"));
    await click(button("Revert lines", dialog));
    return { file, runCall: double.pending("runWorkbench")! };
  }
  const linesRun = (entryId: string, outcome: Record<string, unknown>) => ({ action: "revert-lines", files: [{ entryId, ...outcome }], foldersCreated: [], index: "published" });

  test("success: Arbareto reverted 2 lines in login.ts.", async () => {
    const { file, runCall } = await runStaged();
    await answer(runCall, succeeded(linesRun(file.entryId, { outcome: "reverted" })));
    expect(statusBar()).toContain("Arbareto reverted 2 lines in login.ts.");
  });

  // Spec US4 scenario 4: another program changed the file after the index part.
  test("the index part stays and the file changed: the FR-017 partial result", async () => {
    const PARTIAL = "Arbareto removed the changes from the index. It did not change login.ts, because the file changed after the review.";
    for (const outcome of [{ outcome: "changed-outside" }, { outcome: "unstaged-only", code: "stale" }]) {
      const { file, runCall } = await runStaged();
      await answer(runCall, { ...succeeded(linesRun(file.entryId, outcome)), state: "failed-with-effects" });
      expect({ outcome, status: statusBar() }).toEqual({ outcome, status: expect.stringContaining(PARTIAL) });
      expect(statusBar()).not.toContain("Arbareto changed nothing");
      await unmountAll();
    }
  });

  test("the index part stays and the write failed: the FR-017 partial result names the reason", async () => {
    const { file, runCall } = await runStaged();
    await answer(runCall, { ...succeeded(linesRun(file.entryId, { outcome: "unstaged-only", code: "error", reason: "sharing-violation" })), state: "failed-with-effects" });
    expect(statusBar()).toContain("Arbareto removed the changes from the index. It did not change login.ts, because another program has it open.");
  });
});

describe("R in the History commit diff (FR-006)", () => {
  test("R in the History diff does nothing", async () => {
    const fake = createFake({ total: 10, loaded: 10 });
    const view = createHistoryView(fake.bridge, TARGET);
    await act(async () => void (await view.open("all", false)));
    await act(async () => view.select(oid(2), 2, "full"));
    const calls: { operation: string; payload: Record<string, unknown>; resolve(response: BridgeResponse): void }[] = [];
    const call = (operation: string) => (_: unknown, payload: Record<string, unknown>) => new Promise<BridgeResponse>((resolve) => void calls.push({ operation, payload, resolve }));
    const inspection = createInspection(contractChecked({ readCommitChanges: call("readCommitChanges"), readCommitFile: call("readCommitFile"), readBlame: call("readBlame"), cancel: () => Promise.resolve({ requestId: null, state: "succeeded" } as BridgeResponse) }), TARGET);
    function WithPanes() {
      const [panes, setPanes] = useState(HISTORY_PANES);
      return <CommitChanges inspection={inspection} view={view} oid={oid(2)} profile="wide" onTrust={async () => true} onBlame={() => {}} panes={panes} onPanes={(next) => setPanes((p) => ({ ...p, ...next }))} />;
    }
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<WithPanes />));
    await settle();
    const changesId = fixtureId(0x8a0);
    const viewId = view.getState().view!.viewId;
    const files = [{ fileId: 0, status: "modified", pathBytes: Buffer.from("login.ts").toString("base64"), kind: "file" }];
    await act(async () => calls.find((c) => c.operation === "readCommitChanges")!.resolve(succeeded({ changesId, viewId, oid: oid(2), parents: ["1".repeat(40)], base: { kind: "parent", index: 0, oid: "1".repeat(40) }, files, completeness: { state: "complete" } }) as BridgeResponse));
    await settle();
    await act(async () => calls.find((c) => c.operation === "readCommitFile")!.resolve(succeeded({ changesId, fileId: 0, facts: {}, binary: false, patch: Buffer.from("diff --git a/login.ts b/login.ts\n--- a/login.ts\n+++ b/login.ts\n@@ -1 +1 @@\n-a\n+b\n").toString("base64"), completeness: { state: "complete" } }) as BridgeResponse));
    await settle();
    const body = host.querySelector<HTMLElement>('[data-slot="history-diff"] [data-slot="diff-body"]')!;
    expect(body).not.toBeNull();
    await act(async () => body.focus());
    const before = calls.length;
    const event = await pressKey(body, "r");
    expect(event.defaultPrevented).toBe(false);
    expect(calls.length).toBe(before);
    expect(alertDialog()).toBeNull();
    await act(async () => root.unmount());
    host.remove();
  });
});

type Double = Awaited<ReturnType<typeof openFiles>>["double"];
const reviewOf = (double: Double) => double.pending("reviewWorkbench")?.args[1] as { action: string; snapshotId: string; entryIds: string[] } | undefined;

describe("R in the Changes and Staged lists (FR-018, FR-046)", () => {
  for (const [list, category] of [["Changes", "unstaged"], ["Staged", "staged"]] as const) {
    test(`R in ${list} opens the review of the focused row, and of the marked rows`, async () => {
      const files = [entry(category, "a.ts"), entry(category, "b.ts"), entry(category, "c.ts")];
      const { double } = await openFiles(workbench, files);
      const event = await rowKey(item(list, "b.ts"));
      expect(event.defaultPrevented).toBe(true);
      expect(double.count("reviewWorkbench")).toBe(1);
      expect(reviewOf(double)).toEqual({ action: "revert-files", snapshotId: expect.any(String), entryIds: [files[1]!.entryId] });
      expect(statusBar()).toContain("Checking 1 file…");
      await answer(double.pending("reviewWorkbench"), succeeded({ reason: "unreadable" }, { state: "rejected", code: "WORKBENCH_UNAVAILABLE" }));

      await markRow(item(list, "a.ts"));
      await markRow(item(list, "c.ts"));
      await rowKey(item(list, "c.ts"));
      expect(double.count("reviewWorkbench")).toBe(2);
      expect(new Set(reviewOf(double)!.entryIds)).toEqual(new Set([files[0]!.entryId, files[2]!.entryId]));
      expect(statusBar()).toContain("Checking 2 files…");
    });
  }

  test("R on a Conflicted row shows the CONFLICTED reason and opens no review (FR-002)", async () => {
    const { double } = await openFiles(workbench, [entry("conflicted", "c.ts", { xy: "UU" })]);
    const event = await rowKey(item("Conflicted", "c.ts"));
    expect(event.defaultPrevented).toBe(true);
    expect(statusBar()).toContain("Resolve the 1 conflicted file first.");
    expect(double.count("reviewWorkbench")).toBe(0);
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(0);
  });

  test("a key repeat opens nothing, and a second R during the review sends no second review", async () => {
    const { double } = await openFiles(workbench, [entry("unstaged", "a.ts")]);
    await rowKey(item("Changes", "a.ts"), { repeat: true });
    expect(double.count("reviewWorkbench")).toBe(0);
    await rowKey(item("Changes", "a.ts"));
    await rowKey(item("Changes", "a.ts"));
    expect(double.count("reviewWorkbench")).toBe(1);
    await answer(double.pending("reviewWorkbench"), filesReviewed(filesPlan(["a.ts"])));
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
  });

  test("after a success, the focus goes to the next entry, then to the previous entry, then to the list heading (FR-042)", async () => {
    const files = [entry("unstaged", "a.ts"), entry("unstaged", "b.ts"), entry("unstaged", "c.ts")];
    const { world, double } = await openFiles(workbench, files);
    const revert = async (path: string, rest: typeof files) => {
      const gone = files.find((f) => f.path === path)!;
      await rowKey(item("Changes", path));
      await answer(double.pending("reviewWorkbench"), filesReviewed(filesPlan([path])));
      await click(button("Revert file", alertDialog()!));
      world.entries = rest;
      await answer(double.pending("runWorkbench"), succeeded({ action: "revert-files", files: [{ entryId: gone.entryId, outcome: "reverted" }], foldersCreated: [], index: "none" }));
      await settle();
    };
    await revert("b.ts", [files[0]!, files[2]!]);
    expect(document.activeElement).toBe(item("Changes", "c.ts"));
    expect(item("Changes", "c.ts").getAttribute("aria-selected")).toBe("true");
    expect(statusBar()).toContain("Arbareto reverted 1 file.");
    await revert("c.ts", [files[0]!]);
    expect(document.activeElement).toBe(item("Changes", "a.ts"));
    await revert("a.ts", []);
    expect(document.activeElement).toBe(tree("Changes").parentElement!.querySelector('[data-list-heading="Changes"]'));
  });
});

describe("open revert dialogs follow the shown read (data-model §10) and one review at a time", () => {
  test("two quick R presses in the diff send one review", async () => {
    const { double } = await shownDiff(workbench);
    await selectFirstHunk();
    await revertKey();
    await revertKey();
    expect(reviews(double)).toHaveLength(1);
  });

  test("the lines dialog closes when the shown comparison changes", async () => {
    const { double, world } = await shownDiff(workbench);
    await selectFirstHunk();
    await revertKey();
    await answer(double.pending("reviewWorkbench"), succeeded({ action: "revert-lines", plan: { scope: "unstaged", fileBytes: Buffer.from("login.ts").toString("base64"), lines: null }, workbenchToken: fixtureId(0x8d0) }));
    expect(alertDialog()).not.toBeNull();
    const previous = world.answers.readComparison!;
    world.answers.readComparison = (args) => {
      const response = previous(args) as { result: Record<string, unknown> };
      return { ...response, result: { ...response.result, comparisonId: fixtureId(0x8fe), patch: Buffer.from("diff --git a/login.ts b/login.ts\n--- a/login.ts\n+++ b/login.ts\n@@ -1 +1 @@\n-a\n+b\n").toString("base64"), hunks: [HUNKS[0]] } };
    };
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true })));
    await settle();
    await settle();
    expect(double.count("readComparison")).toBeGreaterThan(1);
    expect(alertDialog()).toBeNull();
    expect(double.count("runWorkbench")).toBe(0);
  });

  // Data-model §10: only a new snapshot or a new patch clears the review. The service gives each comparison read a new comparisonId.
  test("a comparison read with a new comparisonId, the same snapshot, and the same patch keeps the review and the open confirmation", async () => {
    const { double, world } = await shownDiff(workbench, { freshIds: true });
    await selectFirstHunk();
    await revertKey();
    keepSnapshot(world, double);
    const first = double.count("readComparison");
    await refresh();
    expect(double.count("readComparison")).toBeGreaterThan(first);
    expect(alertDialog()).toBeNull();
    await confirmFor(double, plan(null));
    expect(alertDialog()).not.toBeNull();
    const second = double.count("readComparison");
    await refresh();
    expect(double.count("readComparison")).toBeGreaterThan(second);
    expect(alertDialog()).not.toBeNull();
    await click(button("Revert hunk", alertDialog()!));
    expect(double.count("runWorkbench")).toBe(1);
  });

  for (const change of ["a new snapshot", "a changed patch"] as const) {
    test(`the lines dialog closes on ${change}`, async () => {
      const { double, world } = await shownDiff(workbench, { freshIds: true });
      await selectFirstHunk();
      await revertKey();
      await confirmFor(double, plan(null));
      expect(alertDialog()).not.toBeNull();
      if (change === "a changed patch") {
        keepSnapshot(world, double);
        changePatch(world, AFTER, [hunk(0, 10, 2, 10, 3)]);
      }
      const reads = double.count("readComparison");
      await refresh();
      expect(double.count("readComparison")).toBeGreaterThan(reads);
      expect(alertDialog()).toBeNull();
      expect(double.count("runWorkbench")).toBe(0);
    });
  }

  // plan.md "Task flow and command placement": a successful own hunk action anchors the next patch, as Stage hunk does.
  test("after Revert lines succeeds, the next patch shows the anchored hunk without the reset notice", async () => {
    const { double, world, file } = await shownDiff(workbench, { freshIds: true });
    await selectLines({ start: 2, side: "deletions", end: 3, endSide: "additions" });
    await revertKey();
    await click(button("Revert lines", await confirmFor(double, plan(3))));
    changePatch(world, AFTER, [hunk(0, 10, 2, 10, 3)]);
    const reads = double.count("readComparison");
    await answer(double.pending("runWorkbench")!, succeeded({ action: "revert-lines", files: [{ entryId: file.entryId, outcome: "reverted" }], foldersCreated: [], index: "none" }));
    await refresh();
    expect(double.count("readComparison")).toBeGreaterThan(reads);
    expect(text(commitView())).toContain("+y");
    expect(text(commitView())).not.toContain("+B");
    expect(text(commitView())).not.toContain(RESET_NOTICE);
    expect(commitView().querySelector('[data-slot="patch-double"]')!.getAttribute("data-anchor")).toBe("10");
  });

  // Data-model §14: the line selection belongs to the shown diff. A later patch with the same text must not bring it back.
  test("after Revert lines succeeds, a patch equal to the one before the revert shows no line selection, and R sends no line review", async () => {
    const { double, world, file } = await shownDiff(workbench, { freshIds: true });
    await selectLines({ start: 2, side: "deletions", end: 3, endSide: "additions" });
    expect(commitView().querySelector('[data-slot="patch-double"]')!.getAttribute("data-lines")).toBe("selected");
    await revertKey();
    await click(button("Revert lines", await confirmFor(double, plan(3))));
    changePatch(world, AFTER, [hunk(0, 10, 2, 10, 3)]);
    await answer(double.pending("runWorkbench")!, succeeded({ action: "revert-lines", files: [{ entryId: file.entryId, outcome: "reverted" }], foldersCreated: [], index: "none" }));
    await refresh();
    expect(text(commitView())).toContain("+y");
    changePatch(world, PATCH, HUNKS);
    await refresh();
    expect(text(commitView())).toContain("+B");
    expect(commitView().querySelector('[data-slot="patch-double"]')!.getAttribute("data-lines")).toBeNull();
    await revertKey();
    expect(reviews(double)).toHaveLength(1);
    expect(statusBar()).toContain("No hunk is selected.");
  });

  test("the files dialog closes when the snapshot changes", async () => {
    const { double } = await openFiles(workbench, [entry("unstaged", "a.ts")]);
    await rowKey(item("Changes", "a.ts"));
    await answer(double.pending("reviewWorkbench"), filesReviewed(filesPlan(["a.ts"])));
    expect(alertDialog()).not.toBeNull();
    const reads = double.count("readWorkspace");
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true, cancelable: true })));
    await settle();
    await settle();
    expect(double.count("readWorkspace")).toBeGreaterThan(reads);
    expect(alertDialog()).toBeNull();
    expect(double.count("runWorkbench")).toBe(0);
  });
});

// tasks.md T036 (feature 008, WP4). Story US3. Spec FR-007, FR-030, FR-039, FR-040. Plan D11 REVERT_CHECKING, REVERT_PROGRESS, REVERT_COUNTS, OUTCOME_LABEL, D12 "Busy and progress", "Result" (boards Progress-checking, Progress-reverting, Result-success, Result-mixed).
const footer = () => document.querySelector("footer")!;
const statusArea = () => document.querySelector('section[data-slot="status-area"]');
const runResult = (files: unknown[], fields: Record<string, unknown> = {}) => ({ action: "revert-unstaged", files, foldersCreated: [], index: "none", ...fields });

/** Revert all unstaged changes of `files` up to Revert unstaged changes in the confirmation. */
async function runUnstaged(files: ReturnType<typeof entry>[]) {
  const { double, world } = await openFiles(workbench, files);
  await revertAllUnstaged();
  const covered = files.filter((f) => f.category === "unstaged" && f.submodule === undefined);
  await answer(double.pending("reviewWorkbench"), unstagedReviewed(unstagedPlan(covered.map((f) => f.path))));
  await click(button("Revert unstaged changes", alertDialog()!));
  return { double, world, runCall: double.pending("runWorkbench")! };
}

describe("Revert all unstaged changes: progress and result (FR-007, FR-030, FR-040)", () => {
  test("the review shows Checking <n> files… with Cancel; the confirmation opens after it", async () => {
    const { double } = await openFiles(workbench, [entry("unstaged", "a.ts"), entry("unstaged", "b.ts"), entry("unstaged", "lib", { submodule: "SC..", xy: ".M" }), entry("staged", "c.ts"), entry("untracked", "n.txt")]);
    await revertAllUnstaged();
    expect(statusBar()).toContain("Checking 2 files…");
    expect(button("Cancel", footer())).toBeDefined();
    expect(alertDialog()).toBeNull();
    await answer(double.pending("reviewWorkbench"), unstagedReviewed(unstagedPlan(["a.ts", "b.ts"], { submodules: 1 })));
    expect(alertDialog()).not.toBeNull();
    expect(statusBar()).not.toContain("Checking");
  });

  for (const [reason, line] of [
    ["nothing-to-revert", "No unstaged changes."],
    ["limit", "Arbareto reverts at most 10,000 files at a time. Select fewer files, then use Revert file."],
  ] as const) {
    test(`a review refusal with reason ${reason} shows its text`, async () => {
      const { double } = await openFiles(workbench, [entry("unstaged", "a.ts")]);
      await revertAllUnstaged();
      await answer(double.pending("reviewWorkbench"), succeeded({ reason }, { state: "rejected", code: "WORKBENCH_UNAVAILABLE" }));
      expect(statusBar()).toContain("Revert all unstaged changes is unavailable.");
      expect(text(statusArea()!)).toContain(line);
      expect(text(statusArea()!)).not.toContain(reason);
      expect(alertDialog()).toBeNull();
    });
  }

  test("one file: Checking 1 file…", async () => {
    await openFiles(workbench, [entry("unstaged", "a.ts")]);
    await revertAllUnstaged();
    expect(statusBar()).toContain("Checking 1 file…");
  });

  test("the run shows Reverting <i> of <n>… with Cancel", async () => {
    const files = Array.from({ length: 12 }, (_, i) => entry("unstaged", `f${i}.ts`));
    const { runCall } = await runUnstaged(files);
    expect(runCall.args.slice(0, 2)).toEqual([{ repositoryId: fixtureId(1) }, { workbenchToken: fixtureId(0x8d0), start: true }]);
    const onProgress = runCall.args[2] as (event: unknown) => void;
    await act(async () => onProgress({ requestId: fixtureId(0x7d2), operationId: fixtureId(0x7d3), state: "running", phase: "revert-files", counters: { fileIndex: 4, fileCount: 12 }, stalled: false }));
    await settle();
    expect(statusBar()).toContain("Reverting 4 of 12…");
    expect(button("Cancel", footer())).toBeDefined();
  });

  test("success: Arbareto reverted the unstaged changes of <n> files., and of 1 file.", async () => {
    const files = [entry("unstaged", "a.ts"), entry("unstaged", "b.ts")];
    const { runCall } = await runUnstaged(files);
    await answer(runCall, succeeded(runResult(files.map((f) => ({ entryId: f.entryId, outcome: "reverted" })))));
    expect(statusBar()).toContain("Arbareto reverted the unstaged changes of 2 files.");
    expect(statusArea()).toBeNull();
    await unmountAll();

    const one = [entry("unstaged", "a.ts")];
    const second = await runUnstaged(one);
    await answer(second.runCall, succeeded(runResult([{ entryId: one[0]!.entryId, outcome: "reverted" }])));
    expect(statusBar()).toContain("Arbareto reverted the unstaged changes of 1 file.");
  });

  test("a mixed result: the count of each outcome, the heading, the first 20 files that did not revert in tree order, and and <m> more files.", async () => {
    const files = Array.from({ length: 25 }, (_, i) => entry("unstaged", `f${String(i).padStart(2, "0")}.ts`));
    const { runCall } = await runUnstaged(files);
    // f00 and f01 reverted; f02 not changed with a sharing violation; f03 not started; f04 to f24 changed outside Arbareto.
    const outcomes = files.map((f, i) => ({ entryId: f.entryId, outcome: i < 2 ? "reverted" : i === 2 ? "not-changed" : i === 3 ? "not-started" : "changed-outside", ...(i === 2 ? { code: "error", reason: "sharing-violation" } : {}) }));
    await answer(runCall, { ...succeeded(runResult([...outcomes].reverse())), state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
    const count = "2 files reverted. 1 file not changed. 21 files changed outside Arbareto. 1 file not started.";
    expect(statusBar()).toContain(count);
    const area = statusArea()!;
    expect(area).not.toBeNull();
    expect(text(area)).toContain("Revert all unstaged changes");
    expect(text(area)).toContain(count);
    expect(text(area)).toContain("Another program has f02.ts open. Arbareto did not change it. Close the file, then try again.");
    expect(text(area)).toContain("f03.ts: Not started.");
    expect(text(area)).toContain("f04.ts: Changed outside Arbareto.");
    // 23 files did not revert: the first 20 (f02 to f21), then the rest.
    expect(text(area)).toContain("f21.ts: Changed outside Arbareto.");
    expect(text(area)).not.toContain("f22.ts");
    expect(text(area)).toContain("and 3 more files.");
    expect(text(area)).not.toContain("f00.ts");
  });
});

// tasks.md T059 (feature 008, renderer part). Plan D11 multi-file STALE_REVIEW text, contract "Contract gaps" (RevertRun `reason`).
describe("run refusals with a RevertRun reason (T059)", () => {
  const notStarted = (files: ReturnType<typeof entry>[]) => files.map((f) => ({ entryId: f.entryId, outcome: "not-started" }));
  async function runFiles(paths: string[]) {
    const files = paths.map((p) => entry("unstaged", p));
    const { double } = await openFiles(workbench, files);
    if (files.length > 1) {
      await click(item("Changes", paths[0]!));
      await markRow(item("Changes", paths.at(-1)!), "range");
    }
    await rowKey(item("Changes", paths[0]!));
    await answer(double.pending("reviewWorkbench"), filesReviewed(filesPlan(paths)));
    await click(button(paths.length === 1 ? "Revert file" : "Revert files", alertDialog()!));
    return { files, runCall: double.pending("runWorkbench")! };
  }
  const STALE = "The files changed after the review. Arbareto changed nothing. Check the changes, then try again.";
  const filesRun = (files: ReturnType<typeof entry>[], fields: Record<string, unknown>) => ({ action: "revert-files", files: notStarted(files), foldersCreated: [], index: "none", ...fields });

  test("a multi-file STALE_REVIEW with reason revert-changed shows the multi-file text", async () => {
    const { files, runCall } = await runFiles(["a.ts", "b.ts"]);
    await answer(runCall, { ...succeeded(filesRun(files, { reason: "revert-changed" })), state: "failed", code: "STALE_REVIEW" });
    expect(statusBar()).toContain(STALE);
  });

  test("Revert all unstaged changes: a STALE_REVIEW with reason revert-changed shows the multi-file text", async () => {
    const files = [entry("unstaged", "a.ts"), entry("unstaged", "b.ts")];
    const { runCall } = await runUnstaged(files);
    await answer(runCall, { ...succeeded(runResult(notStarted(files), { reason: "revert-changed" })), state: "failed", code: "STALE_REVIEW" });
    expect(statusBar()).toContain(STALE);
  });

  test("a one-file STALE_REVIEW names its file", async () => {
    const { files, runCall } = await runFiles(["a.ts"]);
    await answer(runCall, { ...succeeded(filesRun(files, { reason: "revert-changed" })), state: "failed", code: "STALE_REVIEW" });
    expect(statusBar()).toContain("a.ts changed after the review. Arbareto changed nothing. Check the changes, then try again.");
  });

  test("an index-part refusal shows its reason text; an eligibility reason shows the service remedy text", async () => {
    const first = await runFiles(["a.ts"]);
    await answer(first.runCall, { ...succeeded(filesRun(first.files, { index: "refused", reason: "read-only" })), state: "failed", code: "WORKBENCH_UNAVAILABLE" });
    expect(statusBar()).toContain("a.ts is read-only. Arbareto does not change it.");
    await unmountAll();

    const second = await runFiles(["a.ts", "b.ts"]);
    const remedy = "Sample remedy text of the service.";
    await answer(second.runCall, { ...succeeded(filesRun(second.files, { index: "refused", reason: "shared-repository", remedy: { text: remedy } })), state: "failed", code: "UNSUPPORTED_HUNK_PROFILE" });
    expect(statusBar()).toContain(remedy);
    expect(statusBar()).not.toContain("2 files not started.");
  });
});

// Feature 008 contract Δ8. Git's `checkout-index --temp` files of a running revert are no working change.
describe("change polls during a revert run", () => {
  test("the Windows interval poll sends no status read while a revert run is in flight; the reconcile read and later polls stay", async () => {
    const ticks: (() => void)[] = [];
    const files = [entry("unstaged", "a.ts")];
    const { double, world } = await openFiles(workbench, files, { clock: { ...NO_POLL, setInterval: (run: () => void) => (ticks.push(run), 0) } });
    const tick = async () => {
      await act(async () => ticks.forEach((run) => run()));
      await settle();
    };
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await settle();
    let reads = double.count("readWorkspace");
    await tick();
    expect(double.count("readWorkspace")).toBe(reads + 1);
    await rowKey(item("Changes", "a.ts"));
    await answer(double.pending("reviewWorkbench"), filesReviewed(filesPlan(["a.ts"])));
    await click(button("Revert file", alertDialog()!));
    expect(double.pending("runWorkbench")).toBeDefined();
    reads = double.count("readWorkspace");
    await tick();
    await tick();
    expect(double.count("readWorkspace")).toBe(reads);
    world.entries = [];
    await answer(double.pending("runWorkbench")!, succeeded({ action: "revert-files", files: [{ entryId: files[0]!.entryId, outcome: "reverted" }], foldersCreated: [], index: "none" }));
    await settle();
    expect(double.count("readWorkspace")).toBe(reads + 1);
    await tick();
    expect(double.count("readWorkspace")).toBe(reads + 2);
  });
});

// Data-model 001 §2 `recoveryState` `refreshing`: a refresh read runs. plan.md 001 "Loading" names its marker "Refreshing…".
describe("block reasons of a status read that is not ready", () => {
  test("recoveryState refreshing gives the Refreshing… reason, not the State unknown reason", async () => {
    const { double, world } = await openFiles(workbench, [entry("unstaged", "a.ts")]);
    world.answers.readWorkspace = () => succeeded({ ...snapshot(world), recoveryState: "refreshing" });
    await refresh();
    await rowKey(item("Changes", "a.ts"));
    expect(double.count("reviewWorkbench")).toBe(0);
    expect(statusBar()).toContain("Refreshing…");
    expect(statusBar()).not.toContain("Select Refresh (F5) first");
  });
});

// Feature 008 spec US4 scenario 4: a staged revert that published the index changed the patch itself.
describe("anchor after a staged revert that ends with effects", () => {
  async function stagedRun() {
    const { double, world, file } = await shownDiff(workbench, { category: "staged", freshIds: true });
    await selectLines({ start: 2, side: "additions", end: 3 });
    await revertKey();
    await click(button("Revert lines", await confirmFor(double, plan(2, "staged"))));
    changePatch(world, AFTER, [hunk(0, 10, 2, 10, 3)]);
    return { double, file, runCall: double.pending("runWorkbench")! };
  }
  const patchDouble = () => commitView().querySelector('[data-slot="patch-double"]')!;

  test("failed-with-effects with the index published: the next patch shows the anchored hunk, no reset notice, and no line selection", async () => {
    const { double, file, runCall } = await stagedRun();
    const reads = double.count("readComparison");
    await answer(runCall, { ...succeeded({ action: "revert-lines", files: [{ entryId: file.entryId, outcome: "changed-outside" }], foldersCreated: [], index: "published" }), state: "failed-with-effects" });
    await refresh();
    expect(double.count("readComparison")).toBeGreaterThan(reads);
    expect(text(commitView())).toContain("+y");
    expect(text(commitView())).not.toContain(RESET_NOTICE);
    expect(patchDouble().getAttribute("data-anchor")).toBe("10");
    expect(patchDouble().getAttribute("data-lines")).toBeNull();
  });

  test("a failed run with no effects sets no anchor: a changed patch shows the reset notice", async () => {
    const { file, runCall } = await stagedRun();
    await answer(runCall, { ...succeeded({ action: "revert-lines", files: [{ entryId: file.entryId, outcome: "not-started" }], foldersCreated: [], index: "none", reason: "revert-changed" }), state: "failed", code: "STALE_REVIEW" });
    await refresh();
    expect(text(commitView())).toContain("+y");
    expect(text(commitView())).toContain(RESET_NOTICE);
    expect(patchDouble().getAttribute("data-anchor")).toBeNull();
  });
});
