// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { button, click, createWorld, mountWorkbench, oid, settle, text, unmountAll } from "./sync-fake";

// 001 plan.md "Icons": Arbareto shows no native `title` hover text. Every hover text uses the tooltip component.

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/HistoryList.tsx", import.meta.dir);
printOrigin("../../src/frontend/refs/ReferencesSidebar.tsx", import.meta.dir);
printOrigin("../../src/frontend/components/text-tooltip.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(() => unmountAll());

/** Each element that carries a `title` attribute now or got one while the test ran. */
function titleWatch() {
  const seen = new Set<Element>();
  const observer = new MutationObserver((records) => {
    for (const r of records) if (r.target instanceof Element && r.target.hasAttribute("title")) seen.add(r.target);
  });
  observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["title"] });
  return {
    found: () => [...new Set([...seen, ...document.querySelectorAll("[title]")])].map((e) => `<${e.tagName.toLowerCase()} title=${JSON.stringify(e.getAttribute("title"))}>`),
    stop: () => observer.disconnect(),
  };
}

async function openView(name: string) {
  const views = document.querySelector('header[data-section="header"] nav[aria-label="Views"]')!;
  await click(button(name, views));
}

describe("no native title (001 plan.md \"Icons\")", () => {
  test("the History, Commit, and Settings views render no element with a title attribute", async () => {
    const head = oid(1);
    // Labels on the checkout row, counts on the current branch, and a gone upstream.
    const world = createWorld({
      branches: [
        { name: "main", objectId: head, upstream: "refs/remotes/origin/main", upstreamObjectId: oid(9), track: { state: "counts", ahead: 2, behind: 3 }, current: true },
        { name: "feature/a-long-branch-name", objectId: head, upstream: null, upstreamObjectId: null, track: { state: "none" }, current: false },
        { name: "old", objectId: oid(2), upstream: "refs/remotes/origin/old", upstreamObjectId: null, track: { state: "gone" }, current: false },
      ],
    });
    const watch = titleWatch();
    try {
      await mountWorkbench(workbench, world);
      const toggle = document.querySelector<HTMLElement>('button[aria-label="Show references"]');
      if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
      await settle();
      // The fixture reaches the parts that held a native title before.
      expect(document.querySelector('[data-slot="row-labels"]')).not.toBeNull();
      expect(text(document.querySelector('[data-slot="tracking-count"]')!)).toContain("2 ahead, 3 behind");
      expect(watch.found()).toEqual([]);
      await openView("Commit");
      await settle();
      expect(watch.found()).toEqual([]);
      const viewMenu = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => text(e) === "View")!;
      await act(async () => viewMenu.focus());
      await click(viewMenu);
      const settings = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => !e.closest('[role="menubar"]') && text(e).startsWith("Settings…"))!;
      await click(settings);
      await settle();
      expect(document.querySelector('[data-view="settings"]')).not.toBeNull();
      expect(watch.found()).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
