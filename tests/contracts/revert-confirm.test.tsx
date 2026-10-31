// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { describedBy, entry, expectChromiumFocus, item, pressKey } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { alertDialog, confirmFor, diffBody, filesPlan, filesReviewed, markRow, openFiles, PatchDouble, plan, revertKey, rowKey, selectFirstHunk, selectLines, shownDiff } from "./revert-fake";
import { answer, button, click, text, unmountAll } from "./sync-fake";

// tasks.md T027 and T031 (feature 008, WP5). Stories US1, US2. Spec FR-008 to FR-010, FR-042, FR-047. Plan D11, D12 "Modal" (boards Confirm-lines, Confirm-hunk, Confirm-files).

printOrigin("../../src/frontend/changes/RevertConfirm.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/revert-text.ts", import.meta.dir);
printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: PatchDouble }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");
const { outcomeLine } = await import("../../src/frontend/changes/revert-text");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(() => unmountAll());

/** R with 3 selected lines in the first hunk, then the review answer. */
async function linesModal(lines = 3) {
  const { double } = await shownDiff(workbench);
  await selectLines({ start: 2, side: "deletions", end: 3, endSide: "additions" });
  await revertKey();
  const dialog = await confirmFor(double, plan(lines));
  return { double, dialog };
}

describe("revert confirmation (FR-008, FR-047)", () => {
  test("the modal is an alert dialog: its name is the title and its description is the text", async () => {
    const { dialog } = await linesModal();
    expect(dialog).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const title = document.getElementById(dialog.getAttribute("aria-labelledby")!)!;
    expect(text(title)).toBe("Revert 3 lines in login.ts?");
    expect(describedBy(dialog)).toBe("Arbareto removes the selected changes from the working file. The index does not change.");
  });

  test("Cancel has the first focus", async () => {
    await linesModal();
    expect(text(document.activeElement!)).toBe("Cancel");
    expectChromiumFocus(document.activeElement);
  });

  test("Enter on Cancel, Escape, and a held R change nothing", async () => {
    const { double, dialog } = await linesModal();
    await pressKey(button("Cancel", dialog), "Enter");
    await pressKey(dialog, "r");
    await pressKey(dialog, "r", { repeat: true });
    expect(double.count("runWorkbench")).toBe(0);
    await pressKey(document.activeElement ?? dialog, "Escape");
    expect(alertDialog()).toBeNull();
    expect(double.count("runWorkbench")).toBe(0);
  });

  test("no default button: no form, no submit button, no access key; Cancel comes before the danger button", async () => {
    const { dialog } = await linesModal();
    expect(dialog.querySelector("form")).toBeNull();
    expect(dialog.querySelector('[type="submit"]')).toBeNull();
    expect(dialog.querySelector("[accesskey]")).toBeNull();
    expect([...dialog.querySelectorAll("button")].map((b) => text(b))).toEqual(["Cancel", "Revert lines"]);
    expect(button("Revert lines", dialog).getAttribute("data-danger")).toBe("true");
  });

  test("the lines and hunk texts with their singular forms, each with You cannot undo this.", async () => {
    const cases: [number | null, string, string][] = [
      [3, "Revert 3 lines in login.ts?", "Revert lines"],
      [1, "Revert 1 line in login.ts?", "Revert line"],
      [null, "Revert this hunk in login.ts?", "Revert hunk"],
    ];
    for (const [lines, title, action] of cases) {
      const { double } = await shownDiff(workbench);
      if (lines === null) await selectFirstHunk();
      else await selectLines({ start: 2, side: "deletions", end: 2 });
      await revertKey();
      const dialog = await confirmFor(double, plan(lines));
      expect(text(document.getElementById(dialog.getAttribute("aria-labelledby")!)!)).toBe(title);
      expect(text(dialog)).toContain("Arbareto removes the selected changes from the working file. The index does not change.");
      expect(text(dialog)).toContain("You cannot undo this.");
      expect([...dialog.querySelectorAll("button")].map((b) => text(b))).toEqual(["Cancel", action]);
      await unmountAll();
    }
  });

  test("the focus returns to the opener: the diff after R, the More actions button after its menu", async () => {
    const { dialog } = await linesModal();
    await click(button("Cancel", dialog));
    expect(alertDialog()).toBeNull();
    expect(document.activeElement).toBe(diffBody());
    await unmountAll();

    const { double } = await shownDiff(workbench);
    const more = button("More actions", document.querySelector('[data-hunk="0"]')!);
    await click(more);
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => text(i).startsWith("Revert hunk…"))!);
    const second = await confirmFor(double, plan(null));
    await pressKey(second, "Escape");
    expect(alertDialog()).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});

/** R on `paths[0]` after the rows are marked, then the review answer with `p`. */
async function filesModal(paths: string[], p: ReturnType<typeof filesPlan>, category: "unstaged" | "staged" = "unstaged") {
  const { double } = await openFiles(workbench, paths.map((path) => entry(category, path)));
  const list = category === "staged" ? "Staged" : "Changes";
  if (paths.length > 1) {
    await click(item(list, paths[0]!));
    await markRow(item(list, paths.at(-1)!), "range");
  }
  await rowKey(item(list, paths[0]!));
  await answer(double.pending("reviewWorkbench"), filesReviewed(p));
  return { double, dialog: alertDialog()! };
}
const title = (dialog: HTMLElement) => text(document.getElementById(dialog.getAttribute("aria-labelledby")!)!);
const listed = (dialog: HTMLElement) => [...dialog.querySelectorAll("li")].map((li) => li.textContent);
const BODY = "Arbareto sets each file to its version in the last commit, in the index and in the working file. Their staged and unstaged changes are lost.";

describe("files confirmation (FR-009, FR-010, board Confirm-files)", () => {
  test("the files texts: title, text, You cannot undo this., Cancel first with the focus, and Revert files", async () => {
    const { double, dialog } = await filesModal(["a.ts", "b.ts"], filesPlan(["a.ts", "b.ts"]));
    expect(title(dialog)).toBe("Revert 2 files?");
    expect(describedBy(dialog)).toBe(BODY);
    expect(text(dialog)).toContain("You cannot undo this.");
    expect([...dialog.querySelectorAll("button")].map((b) => text(b))).toEqual(["Cancel", "Revert files"]);
    expect(button("Revert files", dialog).getAttribute("data-danger")).toBe("true");
    expect(text(document.activeElement!)).toBe("Cancel");
    await pressKey(dialog, "r");
    expect(double.count("runWorkbench")).toBe(0);
  });

  test("one file uses the singular texts", async () => {
    const { dialog } = await filesModal(["a.ts"], filesPlan(["a.ts"]));
    expect(title(dialog)).toBe("Revert 1 file?");
    expect(describedBy(dialog)).toBe("Arbareto sets the file to its version in the last commit, in the index and in the working file. Its staged and unstaged changes are lost.");
    expect([...dialog.querySelectorAll("button")].map((b) => text(b))).toEqual(["Cancel", "Revert file"]);
  });

  test("the first 20 paths in the plan order, then and <m> more files. or and 1 more file.", async () => {
    const paths = Array.from({ length: 23 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    // The service gives the tree order; the renderer keeps it.
    const order = [...paths].reverse();
    const { dialog } = await filesModal(paths, filesPlan(order));
    expect(title(dialog)).toBe("Revert 23 files?");
    expect(listed(dialog)).toEqual(order.slice(0, 20));
    expect(text(dialog)).toContain("and 3 more files.");
    await unmountAll();

    const one = await filesModal(paths.slice(0, 21), filesPlan(paths.slice(0, 21)));
    expect(listed(one.dialog)).toHaveLength(20);
    expect(text(one.dialog)).toContain("and 1 more file.");
    expect(text(one.dialog)).not.toContain("more files.");
  });

  test("the new-files line, singular and plural", async () => {
    const { dialog } = await filesModal(["a.ts", "b.ts"], filesPlan(["a.ts", "b.ts"], { newFiles: 1, staged: 1, unstaged: 0 }), "staged");
    expect(text(dialog)).toContain("The last commit does not have 1 of these files. Arbareto unstages it and keeps the file. Git then shows it as untracked.");
    await unmountAll();

    const two = await filesModal(["a.ts", "b.ts", "c.ts"], filesPlan(["a.ts", "b.ts", "c.ts"], { newFiles: 2, staged: 3, unstaged: 0 }), "staged");
    expect(text(two.dialog)).toContain("The last commit does not have 2 of these files. Arbareto unstages them and keeps the files. Git then shows them as untracked.");
  });

  test("paths show as plain text", async () => {
    const path = '<img src="x" onerror="1">.ts';
    const { dialog } = await filesModal([path], filesPlan([path]));
    expect(listed(dialog)).toEqual([path]);
    expect(dialog.querySelector("img")).toBeNull();
  });
});

describe("unstaged-only outcome lines (FR-017, FR-039)", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  test("without a code: <file>: Unstaged only.", () => {
    expect(outcomeLine("login.ts", { entryId: id, outcome: "unstaged-only" }, false)).toBe("login.ts: Unstaged only.");
  });
  test("with a code: the index part stays, and the line names the reason", () => {
    const line = (code: "stale" | "refused" | "error", reason?: string) => outcomeLine("login.ts", { entryId: id, outcome: "unstaged-only", code, ...(reason === undefined ? {} : { reason }) } as never, false);
    expect(line("error", "sharing-violation")).toBe("Arbareto removed the changes from the index. It did not change login.ts, because another program has it open.");
    expect(line("refused", "read-only")).toBe("Arbareto removed the changes from the index. It did not change login.ts, because login.ts is read-only. Arbareto does not change it.");
    expect(line("stale")).toBe("Arbareto removed the changes from the index. It did not change login.ts, because login.ts changed after the review. Arbareto changed nothing. Check the changes, then try again.");
    expect(line("error", "disk-full")).toBe("Arbareto removed the changes from the index. It did not change login.ts, because the write failed: disk-full.");
  });
});
