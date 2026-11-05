// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { describedBy } from "./commit-fake";
import { A, B, C, TOKEN, groups, historyList, keyMenu, liveText, menu, menuName, menuWorld, option, rightClick, selectRow, short } from "./commit-menu-fake";
import { stubLayout } from "./history-fake";
import { answer, button, click, itemLabel, menuItem, mountWorkbench, press, settle, snapshot, succeeded, text, unmountAll } from "./sync-fake";

// tasks.md T012 (feature 010, WP5). Story US1. Spec FR-010 to FR-015, FR-021, FR-022, SC-009. Plan D1, D2, D11 "Menu", D13 "Menu". Data-model §1.

printOrigin("../../src/frontend/history/HistoryList.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/CommitActions.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/commit-texts.ts", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
afterEach(async () => {
  await unmountAll();
  if (clipboard) Object.defineProperty(globalThis.navigator, "clipboard", clipboard);
  else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
});

// Plan D11 "Menu".
const ITEMS = [
  ["Check out this commit (detached HEAD)…", "Create branch here…", "Create tag here…"],
  ["Cherry-pick commit…", "Revert commit…"],
  ["Reset current branch (main) to here…"],
  ["Copy commit ID"],
];
const ACTIONS = ITEMS.flat().filter((label) => label !== "Copy commit ID");
const RUNNING = "A Git operation is running. Its progress and Cancel are in the status bar.";
const UNKNOWN = "State unknown. Select Refresh (F5) first.";
const OPERATION = "A merge, a rebase, a cherry-pick, or a revert is in progress. Finish it with Mark resolved and the actions in the Notices band.";
const CONFLICTED = "Arbareto blocks changes until the Git operation ends outside Arbareto. Then select Refresh (F5).";
const DETACHED = "HEAD is detached. Switch to a branch first.";
const UNBORN = "The current branch has no commit yet.";
const AT_COMMIT = "HEAD is at this commit.";

const conflicted = (path: string): ChangeEntry => ({ entryId: crypto.randomUUID(), category: "conflicted", path, pathBytes: Buffer.from(path).toString("base64") }) as ChangeEntry;
/** The reason of each item of the open menu, or null. */
const reasons = () => Object.fromEntries(groups().flat().map((label) => [label, describedBy(menuItem(label)) || null]));

describe("opening the commit menu (FR-010, FR-011, FR-015)", () => {
  test("a right-click on a commit row selects the row, docks its details, and opens the commit menu at the row", async () => {
    await mountWorkbench(workbench, menuWorld());
    await rightClick(option(B));
    expect(option(B).getAttribute("aria-selected")).toBe("true");
    expect(menuName()).toBe(`Actions for commit ${short(B)}`);
    expect(groups()).toEqual(ITEMS);
    // The details of the selected commit dock, as for a click.
    expect(text(document.body)).toContain(B);
  });

  test("a right-click on a branch chip keeps the 004 branch menu", async () => {
    await mountWorkbench(workbench, menuWorld());
    await rightClick(option(A).querySelector('.chip[data-kind="branch"]')!);
    expect(menuName()).toBe("Actions for main");
  });

  for (const [name, init] of [
    ["Shift+F10", { key: "F10", shiftKey: true }],
    ["the Menu key", { key: "ContextMenu" }],
  ] as const) {
    test(`${name} with no active label opens the commit menu, also on a row with a branch label, and focuses the first item`, async () => {
      await mountWorkbench(workbench, menuWorld());
      for (const oid of [A, B]) {
        await selectRow(oid);
        await press(historyList(), init.key, init);
        expect(menuName()).toBe(`Actions for commit ${short(oid)}`);
        expect(document.activeElement).toBe(menuItem(ITEMS[0]![0]!));
        await press(document.activeElement!, "Escape");
        // The option is no focus target under aria-activedescendant, so the focus goes back to the list.
        expect(menu()).toBeNull();
        expect(document.activeElement).toBe(historyList());
      }
    });
  }

  test("Right makes the first label active and Shift+F10 then opens its branch menu; Left on the first label goes back to the commit and states it", async () => {
    await mountWorkbench(workbench, menuWorld());
    await selectRow(A);
    const list = historyList();
    await press(list, "ArrowRight");
    expect(liveText()).toContain("main, branch label 1 of 1.");
    await press(list, "F10", { shiftKey: true });
    expect(menuName()).toBe("Actions for main");
    await press(document.activeElement!, "Escape");
    await act(async () => list.focus());
    await press(list, "ArrowLeft");
    expect(liveText()).toContain(`Commit ${short(A)}.`);
    expect(document.querySelector("[data-label-active]")).toBeNull();
    await press(list, "ContextMenu");
    expect(menuName()).toBe(`Actions for commit ${short(A)}`);
  });

  test("the Working directory and Index rows open no menu", async () => {
    await mountWorkbench(workbench, menuWorld());
    for (const id of ["working-directory", "commit-index"]) {
      const row = [...historyList().querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.dataset.rowId !== A && o.dataset.rowId !== B && o.dataset.rowId !== C && (id === "working-directory" ? o.dataset.item === "0" : o.dataset.item === "1"))!;
      await rightClick(row);
      expect(menu()).toBeNull();
      await click(row);
      await act(async () => historyList().focus());
      await press(historyList(), "F10", { shiftKey: true });
      expect(menu()).toBeNull();
    }
  });
});

describe("items (FR-012, FR-013, FR-021, FR-022)", () => {
  test("Create branch here shows Ctrl+B, and it opens the 004 Create branch popover at the commit", async () => {
    await mountWorkbench(workbench, menuWorld());
    await keyMenu(B);
    const item = menuItem("Create branch here…");
    expect(item.getAttribute("aria-keyshortcuts")).toBe("Control+B");
    expect(text(item)).toContain("Ctrl+B");
    await click(item);
    expect(text(document.querySelector('[data-slot="popover-content"]')!)).toContain(`Create branch at ${short(B)}`);
  });

  test("Copy commit ID copies the full object ID and is always available", async () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: (value: string) => (copied.push(value), Promise.resolve()) } });
    await mountWorkbench(workbench, menuWorld({ operationState: "merging" }));
    await keyMenu(C);
    expect(menuItem("Copy commit ID").getAttribute("aria-disabled")).not.toBe("true");
    await click(menuItem("Copy commit ID"));
    expect(copied).toEqual([C]);
    expect(menu()).toBeNull();
  });

  test("every item has an icon and an accessible name", async () => {
    await mountWorkbench(workbench, menuWorld());
    await keyMenu(B);
    for (const item of menu()!.querySelectorAll('[role="menuitem"]')) {
      expect(item.querySelector('[data-slot="menu-icon"] svg')).not.toBeNull();
      expect(itemLabel(item)).not.toBe("");
    }
  });
});

describe("availability (FR-014, plan D1)", () => {
  test("on a clean branch every item is available", async () => {
    await mountWorkbench(workbench, menuWorld());
    await keyMenu(B);
    expect(Object.values(reasons())).toEqual(ITEMS.flat().map(() => null));
  });

  test("a running mutation blocks all but Copy with the quiet running reason", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    await click(button("Fetch", document.querySelector("header")!));
    await answer(double.pending("reviewSync"), succeeded({ action: "fetch", plan: { remotes: ["origin"] }, syncReviewToken: TOKEN }));
    await keyMenu(B);
    for (const label of ACTIONS) {
      const item = menuItem(label);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(describedBy(item)).toBe(RUNNING);
      expect(document.getElementById(item.getAttribute("aria-describedby")!)!.hidden).toBe(true);
    }
    expect(describedBy(menuItem("Copy commit ID"))).toBe("");
  });

  for (const [name, fields, reason] of [
    ["an unknown state", { recoveryState: "unknown" }, UNKNOWN],
    ["a refresh read", { recoveryState: "refreshing" }, "Refreshing…"],
  ] as const) {
    test(`${name} blocks all but Copy`, async () => {
      const world = menuWorld();
      world.answers.readWorkspace = () => succeeded({ ...snapshot(world), ...fields });
      await mountWorkbench(workbench, world);
      await keyMenu(B);
      for (const label of ACTIONS) expect(describedBy(menuItem(label))).toBe(reason);
      expect(describedBy(menuItem("Copy commit ID"))).toBe("");
    });
  }

  for (const operationState of ["merging", "rebasing", "cherry-picking", "reverting"] as const) {
    test(`${operationState} blocks all but Copy with the operation reason`, async () => {
      await mountWorkbench(workbench, menuWorld({ operationState, ...(operationState === "rebasing" ? { head: { state: "detached", oid: A } } : {}) }));
      await keyMenu(B);
      for (const label of groups().flat().filter((l) => l !== "Copy commit ID")) expect(describedBy(menuItem(label))).toBe(OPERATION);
      expect(describedBy(menuItem("Copy commit ID"))).toBe("");
    });
  }

  for (const operationState of ["conflicted", "sequencer-active", "unknown"] as const) {
    test(`${operationState} blocks all but Copy with the outside reason`, async () => {
      await mountWorkbench(workbench, menuWorld({ operationState, entries: operationState === "conflicted" ? [conflicted("a.txt")] : [] }));
      await keyMenu(B);
      for (const label of ACTIONS) expect(describedBy(menuItem(label))).toBe(CONFLICTED);
    });
  }

  test("a detached HEAD blocks Cherry-pick, Revert, and Reset, and the Reset label drops the branch name", async () => {
    await mountWorkbench(workbench, menuWorld({ head: { state: "detached", oid: A }, branches: [] }));
    await keyMenu(B);
    expect(groups()[2]).toEqual(["Reset current branch to here…"]);
    expect(reasons()).toEqual({
      "Check out this commit (detached HEAD)…": null,
      "Create branch here…": null,
      "Create tag here…": null,
      "Cherry-pick commit…": DETACHED,
      "Revert commit…": DETACHED,
      "Reset current branch to here…": DETACHED,
      "Copy commit ID": null,
    });
  });

  test("an unborn current branch blocks Cherry-pick, Revert, and Reset", async () => {
    await mountWorkbench(workbench, menuWorld({ head: { state: "unborn", target: "refs/heads/main" }, branches: [] }));
    await keyMenu(B);
    for (const label of ["Cherry-pick commit…", "Revert commit…", "Reset current branch (main) to here…"]) expect(describedBy(menuItem(label))).toBe(UNBORN);
    expect(describedBy(menuItem("Check out this commit (detached HEAD)…"))).toBe("");
  });

  test("a HEAD detached at this commit blocks Check out with its reason; another row keeps it", async () => {
    await mountWorkbench(workbench, menuWorld({ head: { state: "detached", oid: A }, branches: [] }));
    await keyMenu(A);
    const item = menuItem("Check out this commit (detached HEAD)…");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(item)).toBe(AT_COMMIT);
    await press(document.activeElement!, "Escape");
    await keyMenu(B);
    expect(describedBy(menuItem("Check out this commit (detached HEAD)…"))).toBe("");
  });

  test("an unavailable item stays focusable and runs nothing", async () => {
    const double = await mountWorkbench(workbench, menuWorld({ operationState: "merging" }));
    await keyMenu(B);
    const item = menuItem("Revert commit…");
    expect(item.getAttribute("tabindex")).not.toBeNull();
    await click(item);
    await settle();
    expect(double.count("reviewWorkbench")).toBe(0);
  });
});
