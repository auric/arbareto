// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, itemLabel, keyboardFocus, menuItem, mountWorkbench, oid, press, settings, succeeded, text, tooltipText, unmountAll, type World } from "./sync-fake";

// tasks.md T085 (feature 003). Spec FR-039, FR-055 to FR-057. Plan D12. Data-model §10. Contract Δ3 `setDefaultPullAction`.

printOrigin("../../src/frontend/sync/PullSplitButton.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(unmountAll);

const ITEMS = ["Pull (use Git's configuration)", "Pull with merge", "Pull with rebase", "Fetch", "Fetch all remotes", "Set default action"];
const PAYLOADS = [{ action: "pull" }, { action: "pull", mode: "merge" }, { action: "pull", mode: "rebase" }, { action: "fetch" }, { action: "fetch-all" }];
const ACTIONS = ["pull", "pull-merge", "pull-rebase", "fetch", "fetch-all"] as const;
const MAIN = { pull: "Pull", "pull-merge": "Pull with merge", "pull-rebase": "Pull with rebase", fetch: "Fetch", "fetch-all": "Fetch all remotes" } as const;
const mainPart = () => document.querySelector<HTMLElement>('button[data-slot="pull-main"]')!;
const menu = () => document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
const items = (from: ParentNode) => [...from.querySelectorAll<HTMLElement>(':scope [role="menuitem"], :scope [role="menuitemradio"]')].filter((e) => e.closest('[data-slot="dropdown-menu-content"]') === from || from === document);
const refused = { requestId: "r", state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "no-remotes" } };

const open = (fields: Partial<World> = {}) => mountWorkbench(workbench, createWorld(fields));
async function openMenu() {
  await click(button("Pull options"));
  expect(menu()).not.toBeNull();
}

describe("Pull split button (FR-055)", () => {
  test("the menu lists its items in order", async () => {
    await open();
    await openMenu();
    expect(items(menu()!).map(itemLabel)).toEqual(ITEMS);
  });

  test("each action item sends its reviewSync payload", async () => {
    const double = await open();
    for (const [i, payload] of PAYLOADS.entries()) {
      await openMenu();
      await click(menuItem(ITEMS[i]!));
      const review = double.pending("reviewSync")!;
      expect(review.args[1]).toEqual(payload);
      await answer(review, refused);
    }
  });

  test("a rebase item opens no confirmation and goes straight to the reviewed start (FR-057)", async () => {
    const double = await open();
    await openMenu();
    await click(menuItem("Pull with rebase"));
    await answer(double.pending("reviewSync"), succeeded({ action: "pull", plan: { remotes: ["origin"], mode: "rebase", upstream: { ref: "refs/remotes/origin/main", objectId: oid(9) } }, syncReviewToken: "t" }));
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    expect(double.pending("sync")!.args[1]).toEqual({ syncReviewToken: "t", start: true });
  });

  test("an unavailable pull item states its reason; the fetch items stay available", async () => {
    await open({ head: { state: "detached", oid: oid(1) }, branches: [] });
    await openMenu();
    for (const label of ITEMS.slice(0, 3)) {
      const item = menuItem(label);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(text(document.getElementById(item.getAttribute("aria-describedby")!)!)).toContain("No branch checked out");
    }
    for (const label of ["Fetch", "Fetch all remotes"]) expect(menuItem(label).getAttribute("aria-disabled")).not.toBe("true");
  });

  test("a pull before batch 3 shows the honest unavailable state", async () => {
    const double = await open();
    await click(button("Pull"));
    await answer(double.pending("reviewSync"), { requestId: null, state: "rejected", code: "SERVICE_UNAVAILABLE" });
    expect(text(document.querySelector("footer")!)).toContain("Pull did not start: SERVICE_UNAVAILABLE");
    expect(double.count("sync")).toBe(0);
  });
});

describe("default action (FR-056)", () => {
  for (const action of ACTIONS) {
    test(`with the default ${action}, the submenu checks it, and the main part names and runs it`, async () => {
      const double = await open({ defaultPullAction: action });
      const main = mainPart();
      expect(main.getAttribute("aria-label")).toBe(MAIN[action]);
      expect(main.getAttribute("aria-keyshortcuts")).toBe("Control+ArrowDown");
      await keyboardFocus(main);
      expect(tooltipText()).toStartWith(`${MAIN[action]} (Ctrl+Down)`);
      await openMenu();
      await click(menuItem("Set default action"));
      const radios = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      expect(radios.map(itemLabel)).toEqual(ITEMS.slice(0, 5));
      expect(radios.filter((r) => r.getAttribute("aria-checked") === "true").map(itemLabel)).toEqual([ITEMS[ACTIONS.indexOf(action)]!]);
      await press(document.activeElement!, "Escape");
      await press(document.activeElement!, "Escape");
      await click(main);
      expect(double.pending("reviewSync")!.args[1]).toEqual(PAYLOADS[ACTIONS.indexOf(action)]);
    });
  }

  test("a radio selection sends setDefaultPullAction and no Git operation, and the main part follows the stored value", async () => {
    const double = await open();
    await openMenu();
    await click(menuItem("Set default action"));
    await click(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[2]!);
    expect(double.pending("setDefaultPullAction")!.args[0]).toEqual({ action: "pull-rebase" });
    await answer(double.pending("setDefaultPullAction"), succeeded(settings("pull-rebase")));
    expect(double.count("reviewSync")).toBe(0);
    expect(double.count("sync")).toBe(0);
    expect(mainPart().getAttribute("aria-label")).toBe("Pull with rebase");
  });

  test("Ctrl+Down runs the main part", async () => {
    const double = await open({ defaultPullAction: "fetch-all" });
    await press(document.body, "ArrowDown", { ctrlKey: true });
    expect(double.pending("reviewSync")!.args[1]).toEqual({ action: "fetch-all" });
  });
});

describe("keyboard (FR-039)", () => {
  test("the keyboard reaches the main part, the menu, the submenu, and each radio item", async () => {
    await open();
    const main = mainPart();
    const trigger = button("Pull options");
    expect(main.tabIndex).toBe(0);
    expect(trigger.tabIndex).toBe(0);
    await act(async () => trigger.focus());
    await press(trigger, "ArrowDown");
    expect(menu()).not.toBeNull();
    const sub = menuItem("Set default action");
    await act(async () => sub.focus());
    await press(sub, "ArrowRight");
    const radios = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(radios).toHaveLength(5);
    for (const radio of radios) {
      await act(async () => radio.focus());
      expect(document.activeElement).toBe(radio);
    }
  });
});
