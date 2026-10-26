// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { fixtureId } from "./bridge-contract";
import { entry, item, openCommitView, pressKey, statusBar } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, settle, succeeded, unmountAll } from "./sync-fake";

// tasks.md T091 (feature 005). Spec SC-009: an operation-state change renders only the parts that read it.
// The References sidebar and the History list stay mounted while the Commit view shows, and a Delete run must not render them.

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/refs/ReferencesSidebar.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/HistoryList.tsx", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre data-slot="patch-double">{patch}</pre> }));
registerDom();

// The doubles count each call of the real component function. Each one renders the real component.
const renders = { sidebar: 0, history: 0 };
const refs = { ...(await import("../../src/frontend/refs/ReferencesSidebar")) };
const list = { ...(await import("../../src/frontend/history/HistoryList")) };
function CountedSidebar(props: Parameters<typeof refs.ReferencesSidebar>[0]) {
  renders.sidebar++;
  return refs.ReferencesSidebar(props);
}
function CountedList(props: Parameters<typeof list.HistoryList>[0]) {
  renders.history++;
  return list.HistoryList(props);
}
mock.module("../../src/frontend/refs/ReferencesSidebar", () => ({ ...refs, ReferencesSidebar: CountedSidebar }));
mock.module("../../src/frontend/history/HistoryList", () => ({ ...list, HistoryList: CountedList }));
// Another test file of this process can load Workbench first. The query gives a new module instance, so it binds the doubles.
const WORKBENCH: string = "../../src/frontend/app/Workbench.tsx?renders";
const workbench = (await import(WORKBENCH)) as typeof import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(() => unmountAll());

const TOKEN = fixtureId(0x7e0);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

test("a Delete start and its progress render neither the References sidebar nor the History list", async () => {
  const files: ChangeEntry[] = [entry("untracked", "a.txt"), entry("untracked", "b.txt")];
  const world = createWorld({ entries: files });
  const double = await openCommitView(workbench, world);
  expect(renders.sidebar).toBeGreaterThan(0);
  expect(renders.history).toBeGreaterThan(0);

  const row = item("Changes", "a.txt");
  await act(async () => row.focus());
  await pressKey(row, "Delete");
  const plan = { mode: "recycle", entryIds: [files[0]!.entryId], files: { count: 1, paths: [files[0]!.pathBytes] }, tracked: 0, folder: null, wsl: false };
  await answer(double.pending("reviewWorkbench"), succeeded({ action: "delete", plan, workbenchToken: TOKEN }));
  const before = { ...renders };
  await click(button("Move to Recycle Bin", dialog()!));
  const run = double.pending("runWorkbench")!;
  expect(run.args.slice(0, 2)).toEqual([{ repositoryId: fixtureId(1) }, { workbenchToken: TOKEN, start: true }]);
  const onProgress = run.args[2] as (event: unknown) => void;
  await act(async () => onProgress({ requestId: fixtureId(0x7e1), operationId: fixtureId(0x7e2), state: "running", phase: "delete-files", counters: { fileIndex: 1, fileCount: 1 }, stalled: false }));
  await settle();
  expect(statusBar()).toContain("Deleting files (1 of 1)…");
  expect(renders).toEqual(before);
});
