// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Undo03Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contextMenu, describedBy, entry, item, menuItem, menuItems, menuLabels, pressKey, statusBar } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { changesHeader, COMPARISON, DELETED, hunk, hunkRow, HUNKS, markRow, openFiles, PatchDouble, revertKey, rowKey, selectLines, shownDiff } from "./revert-fake";
import { button, buttons, click, text, unmountAll } from "./sync-fake";

// tasks.md T027, T031, and T036 (feature 008, WP5). Stories US1, US2, US3. Spec FR-012, FR-013, FR-018, FR-023, FR-038, FR-045. Plan D11 item labels and BLOCKED_BY, D12 "Diff", "Changes list row menu", "Staged list row menu" (boards Menu-hunk, Menu-changes-row, Menu-changes-row-unavailable, Menu-staged-row).

printOrigin("../../src/frontend/changes/HunkControls.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/revert-text.ts", import.meta.dir);
printOrigin("../../src/frontend/components/action-menu.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: PatchDouble }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");
const { revertSetReason, unstagedReason } = await import("../../src/frontend/changes/revert-text");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(() => unmountAll());

// The SVG path data of a Hugeicons icon, in its own element order.
const iconPaths = (icon: unknown) => (icon as [string, Record<string, string>][]).map(([, attrs]) => attrs.d).filter(Boolean);
const shownPaths = (element: Element | null) => [...(element?.querySelectorAll("path") ?? [])].map((p) => p.getAttribute("d"));
const openMore = (index: number) => click(button("More actions", hunkRow(index)));

describe("hunk More actions menu (FR-012, FR-045, board Menu-hunk)", () => {
  test("each hunk has a More actions icon button after Stage hunk, with its tooltip and accessible name", async () => {
    await shownDiff(workbench);
    for (const index of [0, 1]) {
      const row = hunkRow(index);
      const labels = [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
      expect(labels).toEqual(["Stage hunk", "More actions"]);
    }
    const more = button("More actions", hunkRow(0));
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    await click(more);
    expect(document.querySelector('[role="menu"]')!.getAttribute("aria-label")).toBe("More actions");
    expect(buttons("More actions", hunkRow(1))).toHaveLength(1);
  });

  test("the menu holds one destructive group with Revert hunk… (R); a line selection in that hunk adds Revert <n> lines… (R)", async () => {
    await shownDiff(workbench);
    await openMore(0);
    expect(menuLabels()).toEqual(["Revert hunk…"]);
    expect(document.querySelectorAll('[role="menu"] [role="group"]')).toHaveLength(1);
    await click(button("More actions", hunkRow(0)));

    await selectLines({ start: 2, side: "deletions", end: 3, endSide: "additions" });
    await openMore(0);
    expect(menuLabels()).toEqual(["Revert hunk…", "Revert 3 lines…"]);
    for (const label of ["Revert hunk…", "Revert 3 lines…"]) {
      const item = menuItem(label);
      expect(item.getAttribute("aria-keyshortcuts")).toBe("R");
      expect(item.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toBe("R");
      expect(item.getAttribute("data-danger")).toBe("true");
      expect(item.getAttribute("aria-disabled")).not.toBe("true");
      expect(shownPaths(item.querySelector('[data-slot="menu-icon"]'))).toEqual(iconPaths(Undo03Icon));
    }
    await click(button("More actions", hunkRow(0)));
    // The selection lies in the first hunk, so the second hunk offers only its hunk.
    await openMore(1);
    expect(menuLabels()).toEqual(["Revert hunk…"]);
  });

  test("one selected line gives the singular label, and Revert hunk… sends the review of that hunk", async () => {
    const { double } = await shownDiff(workbench);
    await selectLines({ start: 2, side: "deletions", end: 2 });
    await openMore(0);
    expect(menuLabels()).toEqual(["Revert hunk…", "Revert 1 line…"]);
    await click(menuItem("Revert 1 line…"));
    expect(double.pending("reviewWorkbench")!.args[1]).toEqual({ action: "revert-lines", snapshotId: expect.any(String), comparisonId: COMPARISON, hunkId: HUNKS[0]!.hunkId, lines: [2] });
    await unmountAll();

    const second = await shownDiff(workbench);
    await openMore(1);
    await click(menuItem("Revert hunk…"));
    expect(second.double.pending("reviewWorkbench")!.args[1]).toEqual({ action: "revert-lines", snapshotId: expect.any(String), comparisonId: COMPARISON, hunkId: HUNKS[1]!.hunkId });
  });

  test("the unavailable reasons: context-only lines, an untracked file, and a deleted file; an unavailable item sends nothing", async () => {
    const { double } = await shownDiff(workbench);
    await selectLines({ start: 1, side: "additions", end: 1 });
    await openMore(0);
    expect(menuItem("Revert hunk…").getAttribute("aria-disabled")).not.toBe("true");
    expect(menuItem("Revert 0 lines…").getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(menuItem("Revert 0 lines…"))).toBe("The selection holds only context lines. Select added or removed lines.");
    await click(menuItem("Revert 0 lines…"));
    expect(double.count("reviewWorkbench")).toBe(0);
    await unmountAll();

    const untracked = await shownDiff(workbench, { category: "untracked", path: "notes.txt", patch: "diff --git a/notes.txt b/notes.txt\nnew file mode 100644\n--- /dev/null\n+++ b/notes.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n", hunks: [hunk(0, 0, 0, 1, 2)] });
    await openMore(0);
    expect(menuItem("Revert hunk…").getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(menuItem("Revert hunk…"))).toBe("Arbareto does not revert an untracked file. Use Delete.");
    await click(menuItem("Revert hunk…"));
    expect(untracked.double.count("reviewWorkbench")).toBe(0);
    await unmountAll();

    await shownDiff(workbench, { patch: DELETED, hunks: [hunk(0, 1, 2, 0, 0)] });
    await openMore(0);
    expect(describedBy(menuItem("Revert hunk…"))).toBe("Arbareto does not revert lines or hunks of a deleted file. Use Revert file.");
    expect(menuItems()).toHaveLength(1);
  });
});

// tasks.md T040 (feature 008, WP5). Story US4. Spec FR-016: the status record of the shown snapshot decides.
describe("staged diff of a file that also has unstaged changes (FR-016)", () => {
  const REASON = "This file also has unstaged changes. Revert or stage them first.";
  // Porcelain v2 `MM`: the record gives a Staged entry and a Changes entry with the same path bytes.
  const both = { xy: "MM" } as const;
  test("Revert hunk… and Revert <n> lines… are unavailable with the reason; R and the items send no review", async () => {
    const { double } = await shownDiff(workbench, { category: "staged", others: [entry("unstaged", "login.ts", both)] });
    await selectLines({ start: 2, side: "deletions", end: 3, endSide: "additions" });
    await openMore(0);
    for (const label of ["Revert hunk…", "Revert 3 lines…"]) {
      expect(menuItem(label).getAttribute("aria-disabled")).toBe("true");
      expect(describedBy(menuItem(label))).toBe(REASON);
    }
    await click(menuItem("Revert 3 lines…"));
    if (document.querySelector('[role="menu"]') !== null) await click(button("More actions", hunkRow(0)));
    await revertKey();
    expect(double.count("reviewWorkbench")).toBe(0);
    expect(statusBar()).toContain(`Revert 3 lines is unavailable. ${REASON}`);
  });

  test("another file with unstaged changes does not block the staged revert", async () => {
    const { double } = await shownDiff(workbench, { category: "staged", others: [entry("unstaged", "other.ts")] });
    await openMore(0);
    expect(menuItem("Revert hunk…").getAttribute("aria-disabled")).not.toBe("true");
    await click(menuItem("Revert hunk…"));
    expect(double.count("reviewWorkbench")).toBe(1);
  });
});

// The groups of the open menu: the label of each group, or null, and the item labels.
const menuGroups = () =>
  [...document.querySelectorAll('[role="menu"] [role="group"]')].map((g) => ({
    label: g.querySelector('[data-slot="dropdown-menu-label"]') === null ? null : text(g.querySelector('[data-slot="dropdown-menu-label"]')!),
    items: [...g.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((i) => text(i.querySelector('[data-slot="menu-label"]')!)),
  }));
const expectRevertItem = (label: string) => {
  const revert = menuItem(label);
  expect(revert.getAttribute("aria-keyshortcuts")).toBe("R");
  expect(revert.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toBe("R");
  expect(revert.getAttribute("data-danger")).toBe("true");
  expect(shownPaths(revert.querySelector('[data-slot="menu-icon"]'))).toEqual(iconPaths(Undo03Icon));
  return revert;
};
const closeMenu = () => pressKey(document.activeElement ?? document.body, "Escape");

describe("Revert file in the row menus (FR-018, FR-023, FR-045, boards Menu-changes-row, Menu-staged-row)", () => {
  test("the Changes row menu holds Revert file… (R) in its own group directly above the Delete from disk group", async () => {
    await openFiles(workbench, [entry("unstaged", "a.ts"), entry("unstaged", "b.ts"), entry("unstaged", "c.ts")]);
    await contextMenu(item("Changes", "a.ts"));
    expect(menuLabels()).toEqual(["Stage file", "Blame", "Copy path", "Show in Explorer", "Revert file…", "Delete…", "Delete permanently…"]);
    const groups = menuGroups();
    const at = groups.findIndex((g) => g.items.includes("Revert file…"));
    expect(groups[at]).toEqual({ label: null, items: ["Revert file…"] });
    expect(groups[at + 1]).toEqual({ label: "Delete from disk", items: ["Delete…", "Delete permanently…"] });
    expect(expectRevertItem("Revert file…").getAttribute("aria-disabled")).not.toBe("true");
    await closeMenu();

    // Several marked rows: the item names their count.
    await markRow(item("Changes", "a.ts"));
    await markRow(item("Changes", "b.ts"));
    await markRow(item("Changes", "c.ts"));
    await contextMenu(item("Changes", "b.ts"));
    expectRevertItem("Revert 3 files…");
    expect(menuGroups().find((g) => g.items.includes("Revert 3 files…"))!.items).toEqual(["Revert 3 files…"]);
  });

  test("with several marked rows, an unavailable Revert names the first blocking file in tree order", async () => {
    const { double } = await openFiles(workbench, [entry("unstaged", "zeta.ts"), entry("unstaged", "lib", { submodule: "SC..", xy: ".M" }), entry("untracked", "notes.txt")]);
    await markRow(item("Changes", "notes.txt"));
    await markRow(item("Changes", "zeta.ts"));
    await markRow(item("Changes", "lib"));
    await contextMenu(item("Changes", "zeta.ts"));
    const revert = menuItem("Revert 3 files…");
    expect(revert.getAttribute("aria-disabled")).toBe("true");
    // A submodule sorts as a folder, so lib comes first (005 FR-015).
    expect(describedBy(revert)).toBe("lib: This entry is a submodule or a nested repository.");
    await click(revert);
    expect(double.count("reviewWorkbench")).toBe(0);
    await closeMenu();

    // One row shows its reason alone.
    await click(item("Changes", "lib"));
    await contextMenu(item("Changes", "lib"));
    expect(describedBy(menuItem("Revert file…"))).toBe("This entry is a submodule or a nested repository.");
  });

  test("the Staged row menu holds Revert file… (R) in a separate group after the 005 groups", async () => {
    await openFiles(workbench, [entry("staged", "b.ts")]);
    await contextMenu(item("Staged", "b.ts"));
    expect(menuLabels()).toEqual(["Unstage file", "Blame", "Copy path", "Show in Explorer", "Revert file…"]);
    const groups = menuGroups();
    expect(groups.at(-1)).toEqual({ label: null, items: ["Revert file…"] });
    expect(groups.length).toBeGreaterThan(1);
    expect(expectRevertItem("Revert file…").getAttribute("aria-disabled")).not.toBe("true");
  });

  test("a folder row: Revert file… is unavailable with the folder reason, and R shows that reason and sends nothing", async () => {
    const { double } = await openFiles(workbench, [entry("unstaged", "src/a.ts"), entry("unstaged", "src/b.ts")]);
    await contextMenu(item("Changes", "src"));
    const revert = menuItem("Revert file…");
    expect(revert.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(revert)).toBe("Arbareto does not revert a folder. Select its files.");
    await click(revert);
    await closeMenu();
    await rowKey(item("Changes", "src"));
    expect(statusBar()).toContain("Arbareto does not revert a folder. Select its files.");
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("an untracked row: Revert file… is unavailable with the untracked reason and sends nothing", async () => {
    const { double } = await openFiles(workbench, [entry("untracked", "notes.txt")]);
    await contextMenu(item("Changes", "notes.txt"));
    const revert = menuItem("Revert file…");
    expect(revert.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(revert)).toBe("Arbareto does not revert an untracked file. Use Delete.");
    await click(revert);
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("a Conflicted row: Revert file… is unavailable with the CONFLICTED reason and sends nothing (FR-002)", async () => {
    const { double } = await openFiles(workbench, [entry("conflicted", "c.ts", { xy: "UU" })]);
    await contextMenu(item("Conflicted", "c.ts"));
    const revert = menuItem("Revert file…");
    expect(revert.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(revert)).toBe("Resolve the 1 conflicted file first.");
    await click(revert);
    expect(double.count("reviewWorkbench")).toBe(0);
  });
});

// tasks.md T036 (feature 008, WP4). Story US3. Spec FR-026. Plan D11 item labels, D12 "Changes header" (board Menu-changes-header).

describe("Changes header More actions menu (FR-026, board Menu-changes-header)", () => {
  test("a More actions icon button sits last in the Changes header, after the layout buttons; its menu holds one destructive group without a key", async () => {
    await openFiles(workbench, [entry("unstaged", "a.ts"), entry("staged", "b.ts")]);
    const labels = [...changesHeader().querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? text(b));
    expect(labels.slice(-3)).toEqual(["Tree layout", "Flat layout", "More actions"]);
    const more = button("More actions", changesHeader());
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    await click(more);
    expect(document.querySelector('[role="menu"]')!.getAttribute("aria-label")).toBe("More actions");
    expect(menuGroups()).toEqual([{ label: null, items: ["Revert all unstaged changes…"] }]);
    const revert = menuItem("Revert all unstaged changes…");
    expect(revert.getAttribute("aria-keyshortcuts")).toBeNull();
    expect(revert.querySelector('[data-slot="dropdown-menu-shortcut"]')).toBeNull();
    expect(revert.getAttribute("data-danger")).toBe("true");
    expect(revert.getAttribute("aria-disabled")).not.toBe("true");
    expect(shownPaths(revert.querySelector('[data-slot="menu-icon"]'))).toEqual(iconPaths(Undo03Icon));
  });

  test("the item sends the revert-unstaged review of the shown snapshot, with no entry, path, or count", async () => {
    const { double } = await openFiles(workbench, [entry("unstaged", "a.ts"), entry("unstaged", "b.ts"), entry("untracked", "n.txt")]);
    await click(button("More actions", changesHeader()));
    await click(menuItem("Revert all unstaged changes…"));
    expect(double.count("reviewWorkbench")).toBe(1);
    expect(double.pending("reviewWorkbench")!.args[1]).toEqual({ action: "revert-unstaged", snapshotId: expect.any(String) });
  });

  test("a gitlink row (mode 160000) without an S submodule field is no covered file (plan D6)", async () => {
    const { double } = await openFiles(workbench, [entry("unstaged", "a.ts"), entry("unstaged", "vendor", { xy: ".M", modes: ["160000", "160000", "160000"] })]);
    await click(button("More actions", changesHeader()));
    await click(menuItem("Revert all unstaged changes…"));
    expect(double.count("reviewWorkbench")).toBe(1);
    expect(statusBar()).toContain("Checking 1 file…");
  });

  test("with only submodule changes, the item is unavailable with the submodules reason and sends nothing", async () => {
    const { double } = await openFiles(workbench, [entry("unstaged", "lib", { submodule: "SC..", xy: ".M" }), entry("staged", "b.ts")]);
    await click(button("More actions", changesHeader()));
    const revert = menuItem("Revert all unstaged changes…");
    expect(revert.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(revert)).toBe("Only submodules have unstaged changes. Arbareto does not change submodules.");
    await click(revert);
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("without unstaged changes, the item is unavailable with No unstaged changes. and sends nothing", async () => {
    const { double } = await openFiles(workbench, [entry("staged", "b.ts"), entry("untracked", "n.txt")]);
    await click(button("More actions", changesHeader()));
    const revert = menuItem("Revert all unstaged changes…");
    expect(revert.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(revert)).toBe("No unstaged changes.");
    await click(revert);
    expect(double.count("reviewWorkbench")).toBe(0);
  });
});

describe("Revert file limit (FR-022)", () => {
  test("above 10,000 files, Revert file is unavailable with the limit stated; 10,000 files have no reason", () => {
    const many = Array.from({ length: 10_001 }, (_, i) => entry("unstaged", `f${i}.ts`));
    expect(revertSetReason(many)).toBe("Arbareto reverts at most 10,000 files at a time. Select fewer files.");
    expect(revertSetReason(many.slice(0, 10_000))).toBeNull();
    // The limit comes before a file reason.
    expect(revertSetReason([...many, entry("untracked", "a.txt")])).toBe("Arbareto reverts at most 10,000 files at a time. Select fewer files.");
  });

  test("above 10,000 covered files, Revert all unstaged changes is unavailable with the limit stated; 10,000 files have no reason", () => {
    const many = Array.from({ length: 10_001 }, (_, i) => entry("unstaged", `f${i}.ts`));
    expect(unstagedReason(many)).toBe("Arbareto reverts at most 10,000 files at a time. Select fewer files, then use Revert file.");
    expect(unstagedReason(many.slice(0, 10_000))).toBeNull();
  });
});
