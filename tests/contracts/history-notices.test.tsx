// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T039: the "References changed" notice, Refresh, stale views, and the branch scope (plan.md D6, contract Δ8). Spec FR-005 to FR-008, FR-049, SC-012.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { RefEntry, RefsResult } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { createFake, oid, stubLayout, TARGET, type FakeOptions } from "./history-fake";

printOrigin("../../src/frontend/history/HistoryList.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/NoticeBand.tsx", import.meta.dir);
printOrigin("../../src/frontend/refs/ReferencesSidebar.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { HistoryList, CHIP_TEXT } = await import("../../src/frontend/history/HistoryList");
const { createHistoryView, refsChanged } = await import("../../src/frontend/state/history-view");
const { NoticeBand } = await import("../../src/frontend/app/NoticeBand");
const { ReferencesSidebar, SHOW_BRANCH_HISTORY } = await import("../../src/frontend/refs/ReferencesSidebar");

let restore: () => void = () => {};
beforeAll(() => void (restore = stubLayout(800)));
afterAll(() => restore());

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
async function show(node: ReactNode): Promise<HTMLElement> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (host: ParentNode, name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === name || b.getAttribute("aria-label") === name);

async function mount(options: FakeOptions) {
  const fake = createFake(options);
  const view = createHistoryView(fake.bridge, TARGET);
  const scopes: string[] = [];
  const host = await show(<HistoryList view={view} entries={[]} density="compact" profile="wide" onSelect={() => {}} onScope={(scope) => void scopes.push(scope)} />);
  await act(async () => void (await view.open("all", false)));
  await settle();
  const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
  return { fake, view, host, list, scopes };
}
async function run(step: () => Promise<unknown> | unknown) {
  await act(async () => void (await step()));
  await settle();
}

describe("contract Δ8: References changed", () => {
  test("a newer refsDigest or workspace HEAD shows the notice, and the view keeps its rows and labels", async () => {
    const { view, fake, host } = await mount({ total: 10, loaded: 10 });
    const opened = view.getState().view!;
    expect(refsChanged(opened, opened.refsDigest, opened.head)).toBe(false);
    expect(refsChanged(opened, "b".repeat(64), opened.head)).toBe(true);
    expect(refsChanged(opened, opened.refsDigest, { state: "detached", oid: oid(3) })).toBe(true);
    expect(refsChanged(null, "b".repeat(64), null)).toBe(false);
    const before = [...host.querySelectorAll('[role="option"]')].map((o) => o.getAttribute("aria-label"));
    let refreshed = 0;
    const band = await show(<NoticeBand operationState="normal" conflicted={0} refsChanged={<button onClick={() => void refreshed++}>Refresh</button>} />);
    expect(text(band)).toContain("References changed. History still shows the references from when it opened.");
    await act(async () => button(band, "Refresh")!.click());
    expect(refreshed).toBe(1);
    expect([...host.querySelectorAll('[role="option"]')].map((o) => o.getAttribute("aria-label"))).toEqual(before);
    expect(fake.of("openHistory")).toHaveLength(1);
    expect(await show(<NoticeBand operationState="normal" conflicted={0} />).then((h) => h.childElementCount)).toBe(0);
  });

  test("Refresh keeps the selected commit through loadHistory need {oid}, with progress and Cancel", async () => {
    const { view, fake, host, list } = await mount({ total: 1_000_000, hold: { load: true } });
    await run(() => fake.release());
    await act(async () => list.focus());
    for (let i = 0; i < 4; i++) await act(async () => void list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    expect(view.getState().selection?.id).toBe(oid(2));
    void view.refresh();
    await settle();
    expect(fake.of("openHistory")).toHaveLength(2);
    expect(fake.of("loadHistory").at(-1)).toEqual({ viewId: "view-2", need: { oid: oid(2) } });
    expect(text(host)).toContain("Loading commits up to the selected commit…");
    expect(button(host, "Cancel")).toBeDefined();
    await run(() => fake.release());
    expect(view.getState().selection?.id).toBe(oid(2));
  });

  test("Refresh without the selected commit selects the checkout commit", async () => {
    const { view, fake } = await mount({ total: 50, loaded: 50 });
    await run(() => view.select(oid(40), 40));
    fake.setTotal(10);
    await run(() => view.refresh());
    expect(fake.of("loadHistory").at(-1)).toEqual({ viewId: "view-2", need: { oid: oid(40) } });
    expect(view.getState().selection?.id).toBe(oid(0));
  });

  test("Cancel of the Refresh load selects the checkout commit when it is loaded, else the first commit row", async () => {
    for (const [head, expected] of [
      [{ state: "branch" as const, target: "refs/heads/main", oid: oid(1) }, oid(1)],
      [{ state: "detached" as const, oid: oid(900) }, oid(0)],
    ] as const) {
      const { view, fake, host } = await mount({ total: 1_000, loaded: 3, head, hold: { load: true } });
      await run(() => fake.release());
      await run(() => view.select(oid(2), 2));
      void view.refresh();
      await settle();
      await act(async () => button(host, "Cancel")!.click());
      await settle();
      expect(view.getState().selection?.id).toBe(expected);
    }
  });

  test("a stale view keeps its rows, states its typed reason, and offers Refresh", async () => {
    let n = 0;
    const { view, fake, host, list } = await mount({ total: 1_000_000, loadResponse: () => (++n === 2 ? { requestId: "r", state: "failed", code: "HISTORY_CHANGED", result: { rows: 2077, complete: false, reason: "order" } } : null) });
    const rows = host.querySelectorAll('[role="option"]').length;
    await act(async () => {
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event("scroll"));
    });
    await settle();
    expect(view.getState().stale).toEqual({ code: "HISTORY_CHANGED", reason: "order" });
    expect(text(host)).toContain("History changed: Git listed the commits in a different order. The shown rows stay, but no more rows load. Refresh to start a new history list.");
    expect(host.querySelectorAll('[role="option"]').length).toBeGreaterThanOrEqual(rows - 1);
    await act(async () => button(host, "Refresh")!.click());
    await settle();
    expect(fake.of("openHistory")).toHaveLength(2);
    expect(view.getState().stale).toBeNull();
  });

  test("a service restart marks the view stale", async () => {
    const { view, host } = await mount({ total: 10, loaded: 10 });
    await run(() => view.markStale());
    expect(text(host)).toContain("The Git service restarted, so this history list ended.");
    expect(button(host, "Refresh")).toBeDefined();
  });
});

describe("spec FR-049: the branch scope", () => {
  test("the scope has no tabs and defaults to all branches; the current-branch scope shows the removable chip", async () => {
    const { view, fake, host, scopes } = await mount({ total: 10, loaded: 10 });
    expect(fake.of("openHistory")[0]).toEqual({ scope: "all" });
    expect(document.querySelector('[role="tab"], [role="tablist"]')).toBeNull();
    expect(host.querySelector('[data-slot="scope-chip"]')).toBeNull();
    await run(() => view.setScope("current"));
    expect(fake.of("openHistory")[1]).toEqual({ scope: "current" });
    const chip = host.querySelector('[data-slot="scope-chip"]')!;
    expect(text(chip)).toContain(CHIP_TEXT);
    const remove = button(chip, "Show all branches")!;
    // A native button: Enter and Space activate it.
    expect(remove.tagName).toBe("BUTTON");
    expect(remove.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+B");
    await act(async () => remove.click());
    expect(scopes).toEqual(["all"]);
  });

  test("a scope switch opens a new view and keeps the selected commit through need {oid}", async () => {
    const { view, fake } = await mount({ total: 50, loaded: 50 });
    await run(() => view.select(oid(7), 7));
    await run(() => view.setScope("current"));
    expect(fake.of("loadHistory").at(-1)).toEqual({ viewId: "view-2", need: { oid: oid(7) } });
    expect(view.getState().selection).toMatchObject({ id: oid(7), index: 7 });
  });

  test("with an active filter, a scope switch sends only searchHistory and keeps the mode", async () => {
    const { view, fake } = await mount({ total: 50, loaded: 50, matches: (i) => i % 10 === 0 });
    await run(() => view.search("Commit", "highlight"));
    const loads = fake.of("loadHistory").length;
    await run(() => view.setScope("current"));
    expect(fake.of("loadHistory")).toHaveLength(loads);
    expect(fake.of("searchHistory").at(-1)).toEqual({ viewId: "view-2", text: "Commit" });
    expect(view.getState().search).toMatchObject({ mode: "highlight", state: "finished" });
  });

  test("an empty repository and an unborn current branch show the empty state, and the filter is unavailable with its reason", async () => {
    for (const head of [{ state: "branch" as const, target: "refs/heads/main", oid: oid(0) }, { state: "unborn" as const, target: "refs/heads/main" }]) {
      const { host, fake } = await mount({ total: 0, startCount: 0, head });
      expect(text(host)).toContain("No commits yet");
      expect(text(host)).toContain("The filter needs at least one commit.");
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Filter commit messages"]')!.disabled).toBe(true);
      expect(fake.of("loadHistory")).toHaveLength(0);
    }
  });
});

describe("spec FR-049: the branch context menu", () => {
  const entry = (name: string, commitId: string): RefEntry => ({
    kind: "branch",
    name,
    invalidUtf8: false,
    objectId: commitId,
    objectType: "commit",
    peeledId: null,
    peeledType: null,
    symref: null,
    upstream: null,
    upstreamPresent: false,
    commitId,
  });
  const REFS: RefsResult = { generation: 1, refs: [entry("feature", oid(1)), entry("main", oid(0))], refsDigest: "a".repeat(64), current: { name: "main", objectId: oid(0) }, completeness: { state: "complete" } };
  const row = (host: HTMLElement, start: string) => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((i) => i.getAttribute("aria-label")!.startsWith(start))!;
  const menuItem = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => text(i).startsWith(SHOW_BRANCH_HISTORY));

  async function sidebar() {
    const calls: number[] = [];
    const host = await show(<ReferencesSidebar refs={REFS} failure={null} onSelectCommit={async () => "found" as const} onRefresh={() => {}} repository="menu-repository" onShowBranchHistory={() => void calls.push(1)} />);
    return { host, calls };
  }

  test("only the current branch opens the menu, and its item selects the current-branch scope", async () => {
    const { host, calls } = await sidebar();
    await act(async () => void row(host, "feature,").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await settle();
    expect(menuItem()).toBeUndefined();
    expect(row(host, "main,").getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => void row(host, "main,").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await settle();
    expect(menuItem()).toBeDefined();
    await act(async () => menuItem()!.click());
    await settle();
    expect(calls).toEqual([1]);
  });

  for (const [name, init] of [
    ["Shift+F10", { key: "F10", shiftKey: true }],
    ["the Menu key", { key: "ContextMenu" }],
  ] as const)
    test(`${name} opens the menu, and the item works from the keyboard`, async () => {
      const { host, calls } = await sidebar();
      const main = row(host, "main,");
      await act(async () => main.focus());
      await act(async () => void main.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
      await settle();
      const item = menuItem()!;
      expect(item).toBeDefined();
      await act(async () => item.focus());
      await act(async () => void item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
      await settle();
      expect(calls).toEqual([1]);
    });
});
