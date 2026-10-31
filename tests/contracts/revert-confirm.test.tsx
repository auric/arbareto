// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { describedBy, expectChromiumFocus, pressKey } from "./commit-fake";
import { stubLayout } from "./history-fake";
import { alertDialog, confirmFor, diffBody, PatchDouble, plan, revertKey, selectFirstHunk, selectLines, shownDiff } from "./revert-fake";
import { button, click, text, unmountAll } from "./sync-fake";

// tasks.md T027 (feature 008, WP5). Story US1. Spec FR-008, FR-009, FR-042, FR-047. Plan D11, D12 "Modal" (boards Confirm-lines, Confirm-hunk).

printOrigin("../../src/frontend/changes/RevertConfirm.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/revert-text.ts", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: PatchDouble }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

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
