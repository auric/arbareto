// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { describedBy, entry, expectChromiumFocus, item, pressKey, typeInto } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { alertDialog, changesHeader, confirmFor, diffBody, filesPlan, filesReviewed, filterField, markRow, openFiles, PatchDouble, plan, revertAllUnstaged, revertKey, rowKey, selectFirstHunk, selectLines, shownDiff, unstagedPlan, unstagedReviewed } from "./revert-fake";
import { answer, button, click, text, unmountAll } from "./sync-fake";

// tasks.md T027, T031, and T036 (feature 008, WP5). Stories US1, US2, US3. Spec FR-008 to FR-010, FR-042, FR-047. Plan D11, D12 "Modal" (boards Confirm-lines, Confirm-hunk, Confirm-files).

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

  // tasks.md T040 (feature 008, WP5). Story US4. Spec FR-009 (board Confirm-staged-lines).
  test("the staged lines and staged hunk texts with their singular forms, each with You cannot undo this.", async () => {
    const cases: [number | null, string, string][] = [
      [2, "Revert 2 staged lines in login.ts?", "Revert lines"],
      [1, "Revert 1 staged line in login.ts?", "Revert line"],
      [null, "Revert this staged hunk in login.ts?", "Revert hunk"],
    ];
    for (const [lines, title, action] of cases) {
      const { double } = await shownDiff(workbench, { category: "staged" });
      if (lines === null) await selectFirstHunk();
      else await selectLines({ start: 2, side: "additions", end: lines === 1 ? 2 : 3 });
      await revertKey();
      const dialog = await confirmFor(double, plan(lines, "staged"));
      expect(text(document.getElementById(dialog.getAttribute("aria-labelledby")!)!)).toBe(title);
      expect(describedBy(dialog)).toBe("Arbareto removes the selected changes from the index and from the working file.");
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
    // Spec US4 scenario 4.
    expect(line("stale")).toBe("Arbareto removed the changes from the index. It did not change login.ts, because the file changed after the review.");
    expect(line("error", "disk-full")).toBe("Arbareto removed the changes from the index. It did not change login.ts, because the write failed: disk-full.");
  });
});

// tasks.md T036 (feature 008, WP4). Story US3. Spec FR-009, FR-010. Plan D11, D12 "Modal" (board Confirm-unstaged), data-model §5 `hidden`.
/** Opens the Commit view with `entries`, types `filter`, selects Revert all unstaged changes…, then answers the review with `p`. */
async function unstagedModal(entries: ReturnType<typeof entry>[], p: ReturnType<typeof unstagedPlan>, filter = "") {
  const { double } = await openFiles(workbench, entries);
  if (filter !== "") await typeInto(filterField(), filter);
  await revertAllUnstaged();
  await answer(double.pending("reviewWorkbench"), unstagedReviewed(p));
  return { double, dialog: alertDialog()! };
}
const SUBMODULES = /Submodule changes stay\./;
const HIDDEN = /Filter files hides\./;

describe("all-unstaged confirmation (FR-009, FR-010, board Confirm-unstaged)", () => {
  test("the texts: title, text, the paths, You cannot undo this., Cancel first with the focus, and Revert unstaged changes", async () => {
    const paths = ["a.ts", "b.ts", "c.ts"];
    const { double, dialog } = await unstagedModal(paths.map((p) => entry("unstaged", p)), unstagedPlan(paths));
    expect(title(dialog)).toBe("Revert all unstaged changes?");
    expect(describedBy(dialog)).toBe("Arbareto sets 3 files to their version in the index. Staged changes stay. Untracked files stay.");
    expect(listed(dialog)).toEqual(paths);
    expect(text(dialog)).toContain("You cannot undo this.");
    expect(text(dialog)).not.toMatch(SUBMODULES);
    expect(text(dialog)).not.toMatch(HIDDEN);
    expect([...dialog.querySelectorAll("button")].map((b) => text(b))).toEqual(["Cancel", "Revert unstaged changes"]);
    expect(button("Revert unstaged changes", dialog).getAttribute("data-danger")).toBe("true");
    expect(text(document.activeElement!)).toBe("Cancel");
    await pressKey(dialog, "r");
    expect(double.count("runWorkbench")).toBe(0);
  });

  test("one file uses the singular text", async () => {
    const { dialog } = await unstagedModal([entry("unstaged", "a.ts")], unstagedPlan(["a.ts"]));
    expect(describedBy(dialog)).toBe("Arbareto sets 1 file to its version in the index. Staged changes stay. Untracked files stay.");
  });

  test("the submodules line, plural and singular", async () => {
    const files = [entry("unstaged", "a.ts"), entry("unstaged", "lib", { submodule: "SC..", xy: ".M" }), entry("unstaged", "vendor", { submodule: "SC..", xy: ".M" })];
    const { dialog } = await unstagedModal(files, unstagedPlan(["a.ts"], { submodules: 2 }));
    expect(text(dialog)).toContain("Submodule changes stay. Arbareto does not change 2 submodules.");
    await unmountAll();

    const one = await unstagedModal(files.slice(0, 2), unstagedPlan(["a.ts"], { submodules: 1 }));
    expect(text(one.dialog)).toContain("Submodule changes stay. Arbareto does not change 1 submodule.");
  });

  test("the hidden line counts the covered files that Filter files hides, plural and singular", async () => {
    // Staged, untracked, and submodule rows that the filter hides are not covered files.
    const files = [entry("unstaged", "src/a.ts"), entry("unstaged", "src/b.ts"), entry("unstaged", "docs/c.md"), entry("unstaged", "docs/d.md"), entry("staged", "docs/e.md"), entry("untracked", "docs/f.txt"), entry("unstaged", "docs/lib", { submodule: "SC..", xy: ".M" })];
    const p = unstagedPlan(["docs/c.md", "docs/d.md", "src/a.ts", "src/b.ts"], { submodules: 1 });
    const { dialog } = await unstagedModal(files, p, "src");
    expect(text(dialog)).toContain("This covers 2 files that Filter files hides.");
    // The list keeps every covered path of the plan.
    expect(listed(dialog)).toEqual(["docs/c.md", "docs/d.md", "src/a.ts", "src/b.ts"]);
    await unmountAll();

    const other = await unstagedModal(files, p, "c.md");
    expect(text(other.dialog)).toContain("This covers 3 files that Filter files hides.");
    await unmountAll();

    const single = await unstagedModal(files.slice(0, 3), unstagedPlan(["docs/c.md", "src/a.ts", "src/b.ts"]), "src");
    expect(text(single.dialog)).toContain("This covers 1 file that Filter files hides.");
  });

  test("the first 20 paths in the plan order, then and <m> more files. or and 1 more file.", async () => {
    const paths = Array.from({ length: 23 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const order = [...paths].reverse();
    const { dialog } = await unstagedModal(paths.map((p) => entry("unstaged", p)), unstagedPlan(order));
    expect(listed(dialog)).toEqual(order.slice(0, 20));
    expect(text(dialog)).toContain("and 3 more files.");
    await unmountAll();

    const one = await unstagedModal(paths.slice(0, 21).map((p) => entry("unstaged", p)), unstagedPlan(paths.slice(0, 21)));
    expect(listed(one.dialog)).toHaveLength(20);
    expect(text(one.dialog)).toContain("and 1 more file.");
  });

  test("Cancel returns the focus to the More actions button", async () => {
    const { dialog } = await unstagedModal([entry("unstaged", "a.ts")], unstagedPlan(["a.ts"]));
    await click(button("Cancel", dialog));
    expect(alertDialog()).toBeNull();
    expect(document.activeElement).toBe(button("More actions", changesHeader()));
  });
});
