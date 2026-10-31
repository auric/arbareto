// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import type { BridgeResponse } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { pressKey, statusBar } from "./commit-fake";
import { createFake, oid, stubLayout, TARGET } from "./history-fake";
import { alertDialog, COMPARISON, diffBody, HUNKS, PatchDouble, revertKey, selectFirstHunk, selectLines, shownDiff } from "./revert-fake";
import { settle, succeeded, unmountAll } from "./sync-fake";

// tasks.md T027 (feature 008, WP5). Story US1. Spec FR-006, FR-012, FR-046. Plan D12 "Keys".

printOrigin("../../src/frontend/changes/ComparisonView.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/HunkControls.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/CommitChanges.tsx", import.meta.dir);
printOrigin("../../src/frontend/keyboard/shortcuts.ts", import.meta.dir);
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
