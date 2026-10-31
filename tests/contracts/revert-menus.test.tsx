// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Undo03Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { describedBy, menuItem, menuItems, menuLabels } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { COMPARISON, DELETED, hunk, hunkRow, HUNKS, PatchDouble, selectLines, shownDiff } from "./revert-fake";
import { button, buttons, click, unmountAll } from "./sync-fake";

// tasks.md T027 (feature 008, WP5). Story US1. Spec FR-012, FR-013, FR-038, FR-045. Plan D11 item labels, D12 "Diff" (board Menu-hunk).

printOrigin("../../src/frontend/changes/HunkControls.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/revert-text.ts", import.meta.dir);
printOrigin("../../src/frontend/components/action-menu.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: PatchDouble }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

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
