// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T040: the message filter and filter mode of `src/frontend/history/HistoryFilter.tsx` and `HistoryList.tsx` (plan.md D4, D5, D6).
// Spec FR-025, FR-027 to FR-032, FR-034, FR-035, SC-009.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { SearchHistoryResult } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { createFake, oid, operationIdOf, stubLayout, TARGET, viewIdOf, type FakeOptions } from "./history-fake";

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

async function mount(options: FakeOptions) {
  const fake = createFake(options);
  const view = createHistoryView(fake.bridge, TARGET);
  const host = await show(<HistoryList view={view} entries={[]} density="compact" profile="wide" onSelect={() => {}} onScope={() => {}} />);
  await act(async () => void (await view.open("all", false)));
  await settle();
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter commit messages"]')!;
  return { fake, view, host, input };
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function key(target: HTMLElement, name: string) {
  await act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
  await settle();
}
const commitNames = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('[role="option"]')].filter((o) => Number(o.dataset.item) >= 2 && !o.hasAttribute("data-more")).map((o) => o.getAttribute("aria-label")!);

describe("spec FR-027 to FR-031: the filter text", () => {
  test("the filter has its accessible name and the Ctrl+F shortcut; only Enter starts a search, and a pause starts none", async () => {
    const { fake, input } = await mount({ total: 100, loaded: 100, matches: (i) => i % 10 === 0 });
    expect(input.getAttribute("aria-keyshortcuts")).toBe("Control+F");
    await type(input, "Commit");
    await new Promise((resolve) => setTimeout(resolve, 600));
    await settle();
    expect(fake.of("searchHistory")).toHaveLength(0);
    await key(input, "Enter");
    expect(fake.of("searchHistory")).toEqual([{ viewId: viewIdOf(1), text: "Commit" }]);
  });

  for (const [value, sentence] of [
    ["fix\\Eit", 'It holds a backslash followed by "E" (\\E).'],
    ["a\u0000b", "It holds a NUL character."],
    ["a\nb", "It holds a line break."],
    ["x".repeat(1025), "It is longer than 1,024 bytes in UTF-8."],
  ] as const)
    test(`the renderer refuses ${JSON.stringify(value.slice(0, 8))} before any request and names the character`, async () => {
      const { fake, input, host, view } = await mount({ total: 10, loaded: 10 });
      // A text box drops line breaks from a typed value, so the store takes the value as a paste can give it.
      if (value.includes(String.fromCharCode(10))) await act(async () => void (await view.search(value, "filter")));
      else {
        await type(input, value);
        await key(input, "Enter");
      }
      expect(fake.of("searchHistory")).toHaveLength(0);
      expect(text(host)).toContain(`Cannot search this text. ${sentence}`);
    });

  test("a changed text, a cleared text, Escape, and a repository close stop the running search, and the full history returns with the selection kept", async () => {
    for (const stop of ["changed", "cleared", "escape", "close"] as const) {
      const { fake, input, view, host } = await mount({ total: 100, loaded: 100, matches: (i) => i % 10 === 0, hold: { search: true } });
      await act(async () => view.select(oid(20), 20));
      await settle();
      await type(input, "Commit");
      await key(input, "Enter");
      expect(view.getState().search?.state).toBe("running");
      if (stop === "changed") await type(input, "Commit 2");
      else if (stop === "cleared") await type(input, "");
      else if (stop === "escape") await key(input, "Escape");
      else await act(async () => view.close());
      await settle();
      expect(fake.of("cancel").map((c) => c.operationId)).toEqual([operationIdOf(2)]);
      expect(view.getState().search).toBeNull();
      if (stop !== "close") {
        expect(view.getState().selection?.id).toBe(oid(20));
        expect(text(host)).not.toContain("so far, more can follow");
        expect(text(host)).not.toContain("search complete");
      }
    }
  });
});

describe("spec FR-032 to FR-035: filter mode", () => {
  const skip = (i: number) =>
    i % 10 === 0
      ? { node: 0, color: 0, merge: false, limited: false, segments: [{ shape: "line" as const, from: { lane: 0, at: "node" as const }, to: { lane: 0, at: "bottom" as const }, color: 0, skip: true as const }], marks: [] }
      : null;

  test("filter mode shows only the matches in history order, and a skip edge is dashed and has an accessible text", async () => {
    const { input, host, view } = await mount({ total: 100, loaded: 100, matches: (i) => i % 10 === 0, cell: skip });
    await type(input, "Commit");
    await key(input, "Enter");
    expect(view.getState().search).toMatchObject({ state: "finished", matches: 10, mode: "filter" });
    const names = commitNames(host);
    expect(names.map((n) => /Commit (\d+)/.exec(n)![1])).toEqual(["0", "10", "20", "30", "40", "50", "60", "70", "80", "90"]);
    expect(names.every((n) => n.includes("Skips commits that do not match"))).toBe(true);
    const dashed = host.querySelector('[role="option"][data-item="2"] .skip-edge')!;
    expect(dashed.getAttribute("stroke-dasharray")).not.toBeNull();
    expect(text(host)).toContain('Only commits whose message contains "Commit" show.');
    expect(text(host)).toContain("10 matches, search complete");
  });

  test("no match states that no commit message contains the text", async () => {
    const { input, host } = await mount({ total: 30, loaded: 30, matches: () => false });
    await type(input, "nothing");
    await key(input, "Enter");
    expect(text(host)).toContain("No commit message contains the text");
    expect(text(host)).toContain("0 matches, search complete");
  });

  test("a shallow view states the searched scope", async () => {
    const { input, host } = await mount({ total: 30, loaded: 30, matches: (i) => i === 3, shallow: true });
    await type(input, "Commit 3");
    await key(input, "Enter");
    expect(text(host)).toContain("The search covered only the commits that this shallow clone holds.");
  });

  test("Cancel of a running filter search ends its searchId: the full list returns, and the view does not go stale (contract Δ3)", async () => {
    const { input, host, view, fake } = await mount({ total: 1_000, loaded: 1_000, matches: (i) => i % 100 === 5, hold: { search: true } });
    await type(input, "Commit");
    await key(input, "Enter");
    expect(view.filterMode()).toBe(true);
    const reads = fake.of("readHistoryRows").length;
    const cancel = [...host.querySelectorAll("button")].find((b) => text(b) === "Cancel")!;
    await act(async () => cancel.click());
    await settle();
    expect(view.getState().search?.state).toBe("stopped");
    expect(view.getState().stale).toBeNull();
    expect(view.filterMode()).toBe(false);
    expect(commitNames(host)[0]).toContain("Commit 0,");
    expect(fake.of("readHistoryRows").slice(reads).every((p) => p.searchId === undefined)).toBe(true);
  });

  for (const [name, response] of [
    ["limited", { requestId: "r", state: "limited", code: "OUTPUT_LIMIT", result: { reason: "HISTORY_VIEW_COMMITS" } }],
    ["failed", { requestId: "r", state: "failed", code: "DEADLINE", result: { remedy: { text: "Write a commit-graph.", command: null } } }],
  ] as const)
    test(`a ${name} search ends its searchId, so the full list stays and the view does not go stale`, async () => {
      const { input, host, view, fake } = await mount({ total: 300, loaded: 300, matches: (i) => i % 10 === 5, searchResponse: () => response });
      await type(input, "Commit");
      await key(input, "Enter");
      expect(view.filterMode()).toBe(false);
      expect(view.getState().stale).toBeNull();
      expect(commitNames(host)[0]).toContain("Commit 0,");
      expect(fake.of("readHistoryRows").filter((p) => p.searchId !== undefined)).toHaveLength(0);
    });

  test("F3 in filter mode with a selection from the full list moves to the next match after it (contract Δ3 `from`)", async () => {
    const { input, view } = await mount({ total: 2_000, loaded: 2_000, matches: (i) => i % 100 === 5, hold: { search: true } });
    await act(async () => view.select(oid(1000), 1000, "full"));
    await type(input, "Commit");
    await key(input, "Enter");
    expect(view.filterMode()).toBe(true);
    expect(view.getState().selection).toMatchObject({ id: oid(1000), mode: "full" });
    await act(async () => void (await view.match("next")));
    await settle();
    expect(view.getState().selection).toMatchObject({ id: oid(1005), index: 10, mode: "filter" });
  });

  test("SEARCH_UNSUPPORTED shows its remedy", async () => {
    const remedy = { text: "Install the C.UTF-8 locale in Ubuntu-26.04, then press Enter again.", command: null };
    const { input, host, view } = await mount({ total: 30, loaded: 30, searchResponse: () => ({ requestId: "r", state: "failed", code: "SEARCH_UNSUPPORTED", result: { reason: "matching", remedy } }) });
    await type(input, "Виправлення");
    await key(input, "Enter");
    expect(view.getState().search?.state).toBe("refused");
    expect(text(host)).toContain(`Search is not available here. ${remedy.text}`);
  });

  test("a service UNSUPPORTED_FILTER_TEXT refusal carries only its reason, and the reason names the character (contract Δ9)", async () => {
    expect(SearchHistoryResult.safeParse({ reason: "quote-end" }).success).toBe(true);
    expect(SearchHistoryResult.safeParse({ reason: "quote-end", found: "\\E" }).success).toBe(false);
    const { input, host, view } = await mount({ total: 30, loaded: 30, searchResponse: () => ({ requestId: "r", state: "rejected", code: "UNSUPPORTED_FILTER_TEXT", result: { reason: "quote-end" } }) });
    await type(input, "Commit");
    await key(input, "Enter");
    expect(view.getState().search).toMatchObject({ state: "refused", code: "UNSUPPORTED_FILTER_TEXT", reason: "quote-end" });
    expect(text(host)).toContain('Cannot search this text. It holds a backslash followed by "E" (\\E).');
  });
});
