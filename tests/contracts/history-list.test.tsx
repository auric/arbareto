// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T038: the feature 002 history list of `src/frontend/history/HistoryList.tsx` and `src/frontend/state/history-view.ts` (plan.md D6, data-model §8).
// Spec FR-009 to FR-013, FR-015, FR-016, FR-050, FR-053, FR-054. The fake bridge holds no structure of the history size.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { HISTORY_LOAD_MARGIN } from "../../src/contracts/limits";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { createFake, oid, stubLayout, TARGET, viewIdOf, type FakeOptions } from "./history-fake";

printOrigin("../../src/frontend/history/HistoryList.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { HistoryList, MAX_LAYOUT_PX, scrollHeightOf, scrollTopOf, virtualTopOf, MORE_TEXT } = await import("../../src/frontend/history/HistoryList");
const { createHistoryView } = await import("../../src/frontend/state/history-view");
const { createShortcutHandler } = await import("../../src/frontend/keyboard/shortcuts");
const { LIMIT_TEXT } = await import("../../src/frontend/history/HistoryView");

const HEIGHT = 800;
let restore: () => void = () => {};
beforeAll(() => void (restore = stubLayout(HEIGHT)));
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
/** Lets the fake responses and the effects that follow them run. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

const UTC = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
const DENSITIES = [
  ["compact", 26],
  ["comfortable", 34],
] as const;

async function mount(options: FakeOptions, density: "compact" | "comfortable" = "compact", cacheLimit?: number) {
  const fake = createFake(options);
  const view = createHistoryView(fake.bridge, TARGET, cacheLimit);
  const selected: string[] = [];
  const host = await show(<HistoryList view={view} entries={[]} density={density} profile="wide" dateFormat={UTC} onSelect={(id) => void selected.push(id)} onScope={() => {}} />);
  await act(async () => void (await view.open("all", false)));
  await settle();
  const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
  return { fake, view, host, list, selected };
}
const options = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
const item = (host: HTMLElement, n: number) => host.querySelector<HTMLElement>(`[role="option"][data-item="${n}"]`);
/** The top of an option within the viewport. */
const viewportTop = (list: HTMLElement, option: HTMLElement) => parseFloat(option.style.top) - list.scrollTop;
async function scrollTo(list: HTMLElement, top: number) {
  await act(async () => {
    list.scrollTop = top;
    list.dispatchEvent(new Event("scroll"));
  });
  await settle();
}
async function key(target: HTMLElement, name: string, extra: KeyboardEventInit = {}) {
  await act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra })));
  await settle();
}
const maxScrollTop = (list: HTMLElement) => list.scrollHeight - list.clientHeight;
const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("plan.md D6 window arithmetic", () => {
  for (const [density, rowHeight] of DENSITIES)
    for (const total of [1_000_000, 4_000_000])
      test(`${total} rows at ${rowHeight} DIPs: row 0 at the top at scrollTop 0, and the last row ends at the viewport bottom at maxScrollTop`, async () => {
        const { list, host } = await mount({ total, loaded: total }, density);
        const items = total + 2;
        expect(list.scrollHeight).toBe(Math.min(items * rowHeight, MAX_LAYOUT_PX));
        expect(viewportTop(list, item(host, 0)!)).toBe(0);
        await scrollTo(list, maxScrollTop(list));
        const last = item(host, items - 1)!;
        expect(last).not.toBeNull();
        expect(viewportTop(list, last) + rowHeight).toBeCloseTo(HEIGHT, 6);
      });

  test("1,000,000 rows at 26 DIPs are not compressed: row i is at i·rowHeight for any scrollTop", async () => {
    const { list, host } = await mount({ total: 1_000_000, loaded: 1_000_000 }, "compact");
    expect(list.scrollHeight).toBe(1_000_002 * 26);
    for (const top of [0, 13, 26 * 4_321 + 7, maxScrollTop(list)]) {
      await scrollTo(list, top);
      for (const option of options(host)) expect(parseFloat(option.style.top)).toBe(Number(option.dataset.item) * 26);
    }
  });

  test("a short list (maxScrollTop ≤ 0) gives virtualTop 0", () => {
    expect(virtualTopOf(120, 5, 26, HEIGHT, 5 * 26)).toBe(0);
    expect(scrollTopOf(300, 5, 26, HEIGHT, 5 * 26)).toBe(0);
    expect(scrollHeightOf(2_000_000, 34)).toBe(MAX_LAYOUT_PX);
  });

  for (const [density, rowHeight] of DENSITIES)
    test(`End shows the last row fully visible at ${rowHeight} DIPs`, async () => {
      const { list, host, fake } = await mount({ total: 1_000_000 }, density);
      await act(async () => list.focus());
      await key(list, "End");
      expect(fake.of("loadHistory").at(-1)).toEqual({ viewId: viewIdOf(1), need: { end: true } });
      const last = item(host, 1_000_001)!;
      expect(last.getAttribute("aria-selected")).toBe("true");
      expect(viewportTop(list, last) + rowHeight).toBeCloseTo(HEIGHT, 6);
    });
});

describe("listbox and DOM bounds", () => {
  test("the DOM row count and the held cache stay bounded and equal for 1,000,000 and 4,000,000 rows", async () => {
    const counts: number[] = [];
    const cached: number[] = [];
    for (const total of [1_000_000, 4_000_000]) {
      const { host, view, list } = await mount({ total, loaded: total });
      await scrollTo(list, Math.floor(maxScrollTop(list) / 2));
      counts.push(options(host).length);
      cached.push(view.cachedPages().length);
    }
    expect(counts[0]).toBe(counts[1]!);
    expect(counts[0]!).toBeLessThanOrEqual(Math.ceil(HEIGHT / 26) + 1);
    // The cache holds the pages read so far, which depend on the window, not on the history size.
    for (const pages of cached) expect(pages).toBeLessThanOrEqual(3);
  });

  test("focus stays on the list with aria-activedescendant, and options carry aria-posinset", async () => {
    const { list, host } = await mount({ total: 50, loaded: 50 });
    await act(async () => list.focus());
    await key(list, "ArrowDown");
    await key(list, "ArrowDown");
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("aria-activedescendant")).toBe(item(host, 2)!.id);
    expect(item(host, 2)!.getAttribute("aria-selected")).toBe("true");
    expect(options(host).map((o) => Number(o.getAttribute("aria-posinset")))).toEqual(options(host).map((o) => Number(o.dataset.item) + 1));
  });

  test("aria-setsize is -1 until the count is known, and the scroll range holds the loaded rows and one more-rows row", async () => {
    const { list, host, fake, view } = await mount({ total: 1_000_000, hold: { load: true } });
    await act(async () => fake.release());
    await settle();
    const loaded = fake.loaded();
    expect(view.getState().complete).toBe(false);
    expect(options(host).every((o) => o.getAttribute("aria-setsize") === "-1")).toBe(true);
    expect(list.scrollHeight).toBe((loaded + 3) * 26);
    await scrollTo(list, maxScrollTop(list));
    const more = host.querySelector<HTMLElement>("[data-more]")!;
    expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(text(more)).toStartWith(MORE_TEXT);
    const done = await mount({ total: 40, loaded: 40 });
    expect(options(done.host).every((o) => o.getAttribute("aria-setsize") === "42")).toBe(true);
    expect(done.host.querySelector("[data-more]")).toBeNull();
  });

  test("history-load progress grows the scroll range before the load ends, and a lower progress count never shrinks it", async () => {
    const { list, fake, view } = await mount({ total: 1_000_000, hold: { load: true } });
    await act(async () => fake.release());
    await settle();
    await scrollTo(list, maxScrollTop(list));
    expect(fake.held()).toBe(1);
    const before = view.getState().viewRows;
    await act(async () => fake.progress(before + 5_000));
    await settle();
    expect(fake.held()).toBe(1);
    expect(view.getState().viewRows).toBe(before + 5_000);
    expect(list.scrollHeight).toBe((before + 5_000 + 3) * 26);
    await act(async () => fake.progress(before + 10));
    await settle();
    expect(list.scrollHeight).toBe((before + 5_000 + 3) * 26);
  });

  test("the heading states that more rows exist until the count is final", async () => {
    const open = await mount({ total: 1_000_000 });
    expect(text(open.host)).toContain(`${open.fake.loaded().toLocaleString("en-US")} commits loaded. More commits exist.`);
    const done = await mount({ total: 3, loaded: 3 });
    expect(text(done.host)).toContain("3 commits");
    expect(text(done.host)).not.toContain("More commits exist");
  });
});

describe("plan.md D6 load trigger", () => {
  test("the first load asks for the last row of the first window, and a later load starts only when fewer than 1,024 loaded rows lie below", async () => {
    const { list, fake } = await mount({ total: 1_000_000 });
    const fits = Math.floor((HEIGHT - 1) / 26) - 2;
    expect(fake.of("loadHistory")).toEqual([{ viewId: viewIdOf(1), need: { row: fits } }]);
    const loaded = fake.loaded();
    expect(loaded).toBe(fits + 1 + 2 * HISTORY_LOAD_MARGIN);
    // The last window row n keeps at least 1,024 loaded rows below it: no load.
    const quiet = loaded - 1 - HISTORY_LOAD_MARGIN;
    await scrollTo(list, (quiet + 2 + 1) * 26 - HEIGHT);
    expect(fake.of("loadHistory")).toHaveLength(1);
    await scrollTo(list, (quiet + 2 + 2) * 26 - HEIGHT);
    expect(fake.of("loadHistory")).toHaveLength(2);
    expect(fake.of("loadHistory")[1]).toEqual({ viewId: viewIdOf(1), need: { row: quiet + 1 } });
  });

  test("no load starts while a load runs, and a scrollbar drag to the bottom shows the more-rows row and starts a load", async () => {
    const { list, fake, host } = await mount({ total: 1_000_000, hold: { load: true } });
    expect(fake.of("loadHistory")).toHaveLength(1);
    await scrollTo(list, maxScrollTop(list));
    expect(fake.of("loadHistory")).toHaveLength(1);
    await act(async () => fake.release());
    await settle();
    await scrollTo(list, maxScrollTop(list));
    expect(host.querySelector("[data-more]")).not.toBeNull();
    expect(fake.of("loadHistory")).toHaveLength(2);
    expect(fake.of("loadHistory")[1]).toEqual({ viewId: viewIdOf(1), need: { row: fake.loaded() } });
  });

  test("a Cancel of a held scroll load halts loads until the more-rows row shows again", async () => {
    const { list, fake, host, view } = await mount({ total: 1_000_000, hold: { load: true } });
    await act(async () => fake.release());
    await settle();
    const loaded = fake.loaded();
    await scrollTo(list, maxScrollTop(list));
    expect(fake.of("loadHistory")).toHaveLength(2);
    const cancel = [...host.querySelectorAll("button")].find((b) => text(b) === "Cancel")!;
    expect(text(cancel.parentElement)).toContain("Loading more commits…");
    await act(async () => cancel.click());
    await settle();
    expect(fake.of("cancel")).toHaveLength(1);
    expect(view.getState().halted).toBe(true);
    expect(fake.loaded()).toBe(loaded);
    // The more-rows row still shows: no new load. Away and back shows it again.
    await scrollTo(list, maxScrollTop(list) - 2);
    expect(fake.of("loadHistory")).toHaveLength(2);
    await scrollTo(list, 0);
    expect(fake.of("loadHistory")).toHaveLength(2);
    await scrollTo(list, maxScrollTop(list));
    expect(fake.of("loadHistory")).toHaveLength(3);
  });

  test("a DEADLINE halts loads and shows the copyable remedy", async () => {
    let n = 0;
    const remedy = { text: "Write a commit-graph to make history reads faster.", command: "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\repo' commit-graph write --reachable" };
    const { list, fake, host, view } = await mount({
      total: 1_000_000,
      loadResponse: () => (++n === 2 ? { requestId: "r", state: "failed", code: "DEADLINE", result: { rows: 2077, complete: false, remedy } } : null),
    });
    await scrollTo(list, maxScrollTop(list));
    expect(view.getState().halted).toBe(true);
    expect(text(host)).toContain(remedy.text);
    expect(text(host)).toContain(remedy.command);
    expect([...host.querySelectorAll("button")].some((b) => text(b) === "Copy command")).toBe(true);
    await scrollTo(list, 0);
    expect(fake.of("loadHistory")).toHaveLength(2);
  });

  for (const code of ["BUSY", "TRUST_CHANGED", "WSL_UNAVAILABLE", "PROCESS_OWNERSHIP_FAILED"] as const)
    test(`a load that ends ${code} halts loads and shows the code`, async () => {
      const { fake, host, view } = await mount({ total: 1_000_000, loadResponse: () => ({ requestId: "r", state: "rejected", code }) });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await settle();
      expect(fake.of("loadHistory")).toHaveLength(1);
      expect(view.getState()).toMatchObject({ halted: true, loadFailure: { code } });
      expect(text(host)).toContain(`Loading more commits stopped: ${code}.`);
    });

  test("Retry on a load failure clears the halt, demands the window again, and moves focus to the list", async () => {
    let n = 0;
    const { fake, host, view, list } = await mount({ total: 1_000_000, loadResponse: () => (++n === 1 ? { requestId: "r", state: "rejected", code: "BUSY" } : null) });
    await settle();
    expect(view.getState()).toMatchObject({ halted: true, loadFailure: { code: "BUSY" } });
    const retry = [...host.querySelectorAll("button")].find((b) => text(b) === "Retry")!;
    expect(retry.getAttribute("type")).toBe("button");
    await act(async () => retry.focus());
    await act(async () => retry.click());
    await settle();
    expect(fake.of("loadHistory")).toHaveLength(2);
    expect(fake.of("loadHistory")[1]).toEqual(fake.of("loadHistory")[0]);
    expect(view.getState()).toMatchObject({ halted: false, loadFailure: null });
    expect(view.getState().viewRows).toBe(fake.loaded());
    expect(text(host)).not.toContain("Loading more commits stopped");
    expect(document.activeElement).toBe(list);
  });

  test("End during a scroll load cancels it first and waits for its terminal response", async () => {
    const { list, fake } = await mount({ total: 1_000_000, hold: { load: true } });
    expect(fake.held()).toBe(1);
    await act(async () => list.focus());
    await key(list, "End");
    expect(fake.calls.map((c) => c.operation).filter((o) => o === "loadHistory" || o === "cancel")).toEqual(["loadHistory", "cancel", "loadHistory"]);
    expect(fake.of("loadHistory")[1]).toEqual({ viewId: viewIdOf(1), need: { end: true } });
  });

  test("End shows progress with Cancel, and Cancel keeps the rows and the selection", async () => {
    const { list, fake, host, view } = await mount({ total: 1_000_000, hold: { load: true } });
    await act(async () => fake.release());
    await settle();
    await act(async () => list.focus());
    await key(list, "ArrowDown");
    const loaded = fake.loaded();
    await key(list, "End");
    expect(text(host)).toContain("Loading all commits…");
    // Input stays live during the load.
    await key(list, "ArrowUp");
    expect(view.getState().selection?.id).toBe("working-directory");
    const cancel = [...host.querySelectorAll("button")].find((b) => text(b) === "Cancel")!;
    await act(async () => cancel.click());
    await settle();
    expect(fake.of("cancel")).toHaveLength(1);
    expect(fake.loaded()).toBe(loaded);
    expect(view.getState().viewRows).toBe(loaded);
    expect(view.getState().selection?.id).toBe("working-directory");
    expect(text(host)).not.toContain("Loading all commits…");
  });

  for (const [density, rowHeight] of DENSITIES)
    for (const total of [1_000_000, 4_000_000])
      test(`when the count grows, the first visible row keeps its offset (${total} rows at ${rowHeight} DIPs)`, async () => {
        const half = total / 2;
        const { list, host, fake } = await mount({ total, loaded: half, hold: { load: true } }, density);
        await scrollTo(list, Math.floor(maxScrollTop(list) / 3));
        const first = options(host)[0]!;
        const before = { item: first.dataset.item, top: viewportTop(list, first) };
        await act(async () => fake.release());
        await settle();
        expect(fake.loaded()).toBeGreaterThan(half);
        const again = item(host, Number(before.item))!;
        expect(viewportTop(list, again)).toBeCloseTo(before.top, 0);
      });
});

describe("data-model §8 renderer cache", () => {
  test("pages of 128 rows stay in an LRU cache within its byte bound, the visible pages stay, and one row read is in flight", async () => {
    // The fake gives 1,024 bytes per row, so one page is 128 KiB. The bound holds two pages.
    const { list, host, view, fake } = await mount({ total: 10_000, loaded: 10_000 }, "compact", 2 * 128 * 1024);
    const name0 = item(host, 2)!.getAttribute("aria-label");
    for (let page = 1; page < 10; page++) await scrollTo(list, page * 128 * 26);
    expect(view.cacheBytes()).toBeLessThanOrEqual(2 * 128 * 1024);
    const visible = Math.floor((Number(options(host)[0]!.dataset.item) - 2) / 128);
    expect(view.cachedPages()).toContain(visible);
    expect(view.cachedPages()).not.toContain(0);
    expect(fake.maxReads()).toBe(1);
    await scrollTo(list, 0);
    // A row that comes back after eviction shows the same commit, text, and cell.
    expect(item(host, 2)!.getAttribute("aria-label")).toBe(name0);
    expect(item(host, 2)!.querySelector("svg")!.innerHTML).toContain("circle");
  });
});

describe("graph, labels, and rows", () => {
  test("the graph column never shrinks during a view", async () => {
    let lanes = 5;
    const { list, host } = await mount({ total: 5_000, loaded: 5_000, lanes: () => lanes });
    const width = () => Number(item(host, 2)?.querySelector("svg")?.getAttribute("width") ?? 0);
    const wide = width();
    lanes = 2;
    await scrollTo(list, 3_000 * 26);
    await scrollTo(list, 0);
    expect(width()).toBe(wide);
  });

  test("a limited row states the limit, and its parents stay readable without color or pointer", async () => {
    const { host } = await mount({ total: 10, loaded: 10, cell: (i) => (i === 3 ? { node: 0, color: 0, merge: false, limited: true, segments: [], marks: [] } : null) });
    const name = item(host, 5)!.getAttribute("aria-label")!;
    expect(name).toContain(LIMIT_TEXT.lanes);
    expect(name).toContain(`1 parent, ${oid(4).slice(0, 12)}`);
    expect(text(item(host, 5))).toContain(LIMIT_TEXT.lanes);
  });

  test("root and shallow marks differ by shape and text", async () => {
    const shallow = { node: 0, color: 0, merge: false, limited: false, segments: [{ shape: "stub" as const, lane: 0, color: 0 }], marks: ["shallow" as const] };
    const { host } = await mount({ total: 3, loaded: 3, cell: (i) => (i === 1 ? shallow : null) });
    const shallowRow = item(host, 3)!;
    const rootRow = item(host, 4)!;
    expect(shallowRow.getAttribute("aria-label")).toContain("Shallow history boundary");
    expect(rootRow.getAttribute("aria-label")).toContain("Root commit");
    expect(shallowRow.querySelector(".boundary-stub")).not.toBeNull();
    expect(rootRow.querySelector(".boundary-stub")).toBeNull();
  });

  test("Working directory and Index stay above the commits, and the dotted lead-in shows only when HEAD is row 0", async () => {
    const atTop = await mount({ total: 5, loaded: 5 });
    expect(options(atTop.host).slice(0, 2).map((o) => o.getAttribute("aria-label")!.split(",")[0])).toEqual(["Working directory", "Index"]);
    expect(atTop.host.querySelectorAll(".working-line")).toHaveLength(3);
    const elsewhere = await mount({ total: 5, loaded: 5, head: { state: "detached", oid: oid(2) } });
    expect(elsewhere.host.querySelectorAll(".working-line")).toHaveLength(0);
  });

  test("labels and the checkout mark come from the rows, and a detached HEAD shows as detached", async () => {
    const branch = await mount({ total: 3, loaded: 3 });
    const row0 = item(branch.host, 2)!;
    expect(row0.getAttribute("aria-label")).toStartWith("HEAD, branch main, Branches: main, Commit 0");
    expect([...row0.querySelectorAll(".badge, .chip")].map((e) => text(e))).toEqual(["HEAD", "main"]);
    const detached = await mount({ total: 3, loaded: 3, head: { state: "detached", oid: oid(1) } });
    expect(item(detached.host, 3)!.getAttribute("aria-label")).toStartWith("HEAD, detached, Commit 1");
    expect(text(item(detached.host, 3)!.querySelector(".badge"))).toBe("HEAD, detached");
  });
});

describe("research.md R13: the plan.md D6 keys against the 001 keyboard map", () => {
  test("Ctrl+F, F3, Shift+F3, and Ctrl+Shift+B map to their 002 actions and take no 001 key", () => {
    const context = { messageField: null, comparisonPane: null, modalOpen: false, menuOpen: false, commitEnabled: false };
    const press = (init: Partial<KeyboardEvent>, target: object = { tagName: "DIV" }) =>
      createShortcutHandler()(
        {
          type: "keydown",
          key: "",
          code: "",
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          metaKey: false,
          repeat: false,
          isComposing: false,
          getModifierState: () => false,
          preventDefault: () => {},
          composedPath: () => [target],
          ...init,
        } as never,
        context,
      );
    const input = { tagName: "INPUT", type: "text" };
    for (const target of [{ tagName: "DIV" }, input]) {
      expect(press({ key: "f", keyCode: 70, ctrlKey: true }, target)).toEqual({ type: "focusFilter" });
      expect(press({ key: "F3" }, target)).toEqual({ type: "match", direction: "next" });
      expect(press({ key: "F3", shiftKey: true }, target)).toEqual({ type: "match", direction: "previous" });
      expect(press({ key: "B", keyCode: 66, ctrlKey: true, shiftKey: true }, target)).toEqual({ type: "toggleScope" });
    }
    // The 001 keys keep their actions.
    expect(press({ key: "F5" })).toEqual({ type: "refresh" });
    expect(press({ key: "o", keyCode: 79, ctrlKey: true })).toEqual({ type: "openFolder" });
    expect(press({ key: "r", keyCode: 82, ctrlKey: true })).toEqual({ type: "openSwitcher" });
    // A modal or an open menu blocks them, as it blocks the 001 keys.
    expect(createShortcutHandler()({ type: "keydown", key: "F3", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, getModifierState: () => false, preventDefault: () => {}, composedPath: () => [] } as never, { ...context, modalOpen: true })).toBeNull();
  });
});
