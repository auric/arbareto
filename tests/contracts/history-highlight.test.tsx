// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T041: highlight mode, match moves, the count, and the mode switch (plan.md D5, D6). Spec FR-036 to FR-042.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { createFake, oid, stubLayout, TARGET, type FakeOptions } from "./history-fake";

printOrigin("../../src/frontend/history/HistoryFilter.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { HistoryList } = await import("../../src/frontend/history/HistoryList");
const { createHistoryView } = await import("../../src/frontend/state/history-view");

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
const button = (host: ParentNode, name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === name || b.getAttribute("aria-label") === name)!;

async function mount(options: FakeOptions) {
  const fake = createFake(options);
  const view = createHistoryView(fake.bridge, TARGET);
  const host = await show(<HistoryList view={view} entries={[]} density="compact" profile="wide" onSelect={() => {}} onScope={() => {}} />);
  await act(async () => void (await view.open("all", false)));
  await settle();
  return { fake, view, host };
}
async function highlight(host: HTMLElement, value = "Commit") {
  await act(async () => button(host, "Highlight matching commits").click());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter commit messages"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await settle();
}
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
// Matches at rows 5, 105, ..., 905.
const MATCHES = (i: number) => i % 100 === 5;

describe("spec FR-036 to FR-040: highlight mode", () => {
  test("highlight mode keeps the full graph, and each match row shows a mark that does not depend on color", async () => {
    const { host, view } = await mount({ total: 1_000, loaded: 1_000, matches: MATCHES });
    await highlight(host);
    expect(view.getState().search).toMatchObject({ mode: "highlight", state: "finished", matches: 10 });
    const rows = [...host.querySelectorAll<HTMLElement>('[role="option"]')].filter((o) => Number(o.dataset.item) >= 2);
    expect(rows.length).toBeGreaterThan(20);
    const match = host.querySelector<HTMLElement>('[role="option"][data-item="7"]')!;
    expect(match.querySelector('[data-slot="match-mark"]')).not.toBeNull();
    expect(match.getAttribute("aria-label")).toContain("Match, Commit 5");
    const other = host.querySelector<HTMLElement>('[role="option"][data-item="8"]')!;
    expect(other.querySelector('[data-slot="match-mark"]')).toBeNull();
  });

  test("Next match and Previous match have accessible names and keys, and move across all matches", async () => {
    const { host, view, fake } = await mount({ total: 1_000, loaded: 1_000, matches: MATCHES });
    await highlight(host);
    const next = button(host, "Next match");
    const previous = button(host, "Previous match");
    expect(next.getAttribute("aria-keyshortcuts")).toBe("F3");
    expect(previous.getAttribute("aria-keyshortcuts")).toBe("Shift+F3");
    await click(next);
    expect(view.getState().selection?.id).toBe(oid(5));
    await click(next);
    expect(view.getState().selection?.id).toBe(oid(105));
    await click(previous);
    expect(view.getState().selection?.id).toBe(oid(5));
    expect(fake.of("readHistoryRows").filter((p) => "match" in (p.at as object)).map((p) => p.at)).toEqual([
      { match: "next", from: 0 },
      { match: "next", from: 6 },
      { match: "previous", from: 104 },
    ]);
  });

  test("at the ends, the selection stays and the view states that no earlier or later match exists", async () => {
    const { host, view } = await mount({ total: 1_000, loaded: 1_000, matches: MATCHES });
    await highlight(host);
    await act(async () => view.select(oid(905), 905));
    await click(button(host, "Next match"));
    expect(view.getState().selection?.id).toBe(oid(905));
    expect(text(host)).toContain("No later match. This is the last match.");
    await act(async () => view.select(oid(5), 5));
    await click(button(host, "Previous match"));
    expect(view.getState().selection?.id).toBe(oid(5));
    expect(text(host)).toContain("No earlier match. This is the first match.");
  });

  test("the count states that more can follow until the search ends, and then that it is final; a target that is not loaded waits with progress and Cancel", async () => {
    const { host, view, fake } = await mount({ total: 100_000, matches: (i) => i === 50_000, hold: { search: true } });
    await highlight(host);
    expect(text(host)).toContain("0 matches so far, more can follow");
    await click(button(host, "Next match"));
    expect(view.getState().waiting).toBe(true);
    expect(text(host)).toContain("Searching commit messages…");
    expect(button(host, "Cancel")).toBeDefined();
    await act(async () => fake.release());
    await settle();
    expect(view.getState().selection?.id).toBe(oid(50_000));
    expect(text(host)).toContain("1 match, search complete");
  });

  test("Cancel of a waiting match move stops the search and shows no count as final", async () => {
    const { host, view } = await mount({ total: 100_000, matches: (i) => i === 50_000, hold: { search: true } });
    await highlight(host);
    await click(button(host, "Next match"));
    await click(button(host, "Cancel"));
    expect(view.getState().search?.state).toBe("stopped");
    expect(view.getState().waiting).toBe(false);
    expect(text(host)).toContain("Search stopped");
    expect(text(host)).not.toContain("search complete");
  });
});

describe("spec FR-041, FR-042: modes and selection", () => {
  test("a mode switch with unchanged text sends no new search", async () => {
    const { host, view, fake } = await mount({ total: 1_000, loaded: 1_000, matches: MATCHES });
    await highlight(host);
    await click(button(host, "Show only matching commits"));
    expect(view.getState().search?.mode).toBe("filter");
    await click(button(host, "Highlight matching commits"));
    expect(view.getState().search?.mode).toBe("highlight");
    expect(fake.of("searchHistory")).toHaveLength(1);
  });

  test("in filter mode, a selection that does not match moves to the next match, else to the last match", async () => {
    for (const [from, to, position] of [
      [7, 105, 1],
      [997, 905, 9],
      [305, 305, 3],
    ] as const) {
      const { host, view } = await mount({ total: 1_000, loaded: 1_000, matches: MATCHES });
      await highlight(host);
      await act(async () => view.select(oid(from), from));
      await click(button(host, "Show only matching commits"));
      expect(view.getState().selection).toMatchObject({ id: oid(to), index: position, mode: "filter" });
    }
  });
});
