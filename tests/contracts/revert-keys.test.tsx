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
import { alertDialog, COMPARISON, diffBody, filesPlan, filesReviewed, HUNKS, markRow, openFiles, PatchDouble, revertKey, rowKey, selectFirstHunk, selectLines, shownDiff } from "./revert-fake";
import { answer, button, click, settle, succeeded, unmountAll } from "./sync-fake";

// tasks.md T027 and T031 (feature 008, WP5). Stories US1, US2. Spec FR-006, FR-012, FR-018, FR-042, FR-046. Plan D12 "Keys".

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

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(() => unmountAll());

const reviews = (double: Awaited<ReturnType<typeof shownDiff>>["double"]) => double.calls.filter((c) => c.operation === "reviewWorkbench");

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
