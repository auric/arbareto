// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// tasks.md T144 and T049: the feature 001 history list rules on the feature 002 list (plan.md "History graph design", "Keyboard and focus").
// The rows come from `readHistoryRows` through the T038 fake bridge.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { createFake, oid, stubLayout, TARGET, type FakeOptions } from "./history-fake";

printOrigin("../../src/frontend/history/HistoryList.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/HistoryView.tsx", import.meta.dir);
// `HistoryList.tsx` loads Base UI. Base UI must first evaluate with a DOM (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const { HistoryList, fitChips } = await import("../../src/frontend/history/HistoryList");
const { WORKING_ROW, INDEX_ROW } = await import("../../src/frontend/history/HistoryView");
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
const text = (host: Element) => (host.textContent ?? "").replace(/\s+/g, " ").trim();
const options = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
// The commit rows, after the Working directory and Index options.
const commits = (host: HTMLElement) => options(host).filter((o) => Number(o.dataset.item) >= 2 && !o.hasAttribute("data-more"));
const short = (n: number) => oid(n).slice(0, 12);
const UTC = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
type Entry = { category: "unstaged" | "untracked" | "staged" | "conflicted" };

async function mount(options: Partial<FakeOptions> = {}, { entries = [] as Entry[] | null, dateFormat = UTC } = {}) {
  const fake = createFake({ total: 3, loaded: 3, ...options });
  const view = createHistoryView(fake.bridge, TARGET);
  const selected: string[] = [];
  const host = await show(<HistoryList view={view} entries={entries} density="compact" profile="wide" dateFormat={dateFormat} onSelect={(id) => void selected.push(id)} onScope={() => {}} />);
  await act(async () => void (await view.open("all", false)));
  await settle();
  return { fake, view, host, selected, list: host.querySelector<HTMLElement>('[role="listbox"]')! };
}

describe("History list", () => {
  test("rows keep service order in one listbox with one Tab stop, and only the selected option has aria-selected true", async () => {
    const { host, view } = await mount();
    await act(async () => view.select(oid(1), 1));
    expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    expect(commits(host).map((o) => o.dataset.rowId)).toEqual([oid(0), oid(1), oid(2)]);
    expect(options(host).map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "false", "false", "true", "false"]);
    const list = host.querySelector('[role="listbox"]')!;
    expect(list.getAttribute("tabindex")).toBe("0");
    expect(list.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(host.querySelector("svg [tabindex], svg[tabindex]")).toBeNull();
  });

  test("the accessible name starts with the HEAD labels and holds the parents and boundary texts, and the labels sit outside the graph cell", async () => {
    const { host } = await mount();
    const [head, , root] = commits(host).map((o) => o.getAttribute("aria-label")!);
    expect(head!.startsWith(`HEAD, branch main, Branches: main, Commit 0, ${short(0)}`)).toBe(true);
    expect(head).toContain(`1 parent, ${short(1)}`);
    expect(root).toContain("Root commit");
    expect(commits(host)[0]!.querySelector("svg")!.textContent).toBe("");
    expect([...commits(host)[0]!.querySelectorAll(".badge, .chip")].map((b) => text(b))).toEqual(["HEAD", "main"]);
  });

  test("arrow keys, Home, and End move the active row and select it at once; a click selects too", async () => {
    const { host, list, selected } = await mount();
    const key = async (k: string) => {
      await act(async () => void list.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
      await settle();
    };
    await act(async () => list.focus());
    await key("ArrowDown");
    expect(list.getAttribute("aria-activedescendant")).toBe(options(host)[1]!.id);
    expect(selected).toEqual([INDEX_ROW]);
    await key("End");
    expect(selected.at(-1)).toBe(oid(2));
    await key("Home");
    expect(list.getAttribute("aria-activedescendant")).toBe(options(host)[0]!.id);
    await act(async () => options(host)[2]!.click());
    await settle();
    expect(selected).toEqual([INDEX_ROW, oid(2), WORKING_ROW, oid(0)]);
  });

  test("an unborn branch says No commits yet and keeps the Working directory and Index options", async () => {
    const { host } = await mount({ total: 0, loaded: 0, startCount: 0, head: { state: "unborn", target: "refs/heads/main" } });
    expect(text(host)).toContain("No commits yet");
    expect(commits(host)).toHaveLength(0);
    expect(options(host)).toHaveLength(2);
  });

  const INVALID = "Some bytes of this commit are not valid UTF-8 and show as replacement characters.";

  test("a non-null encoding ends the row name with the declared encoding", async () => {
    const { host } = await mount({ total: 1, loaded: 1, text: () => ({ encoding: "ISO-8859-1" }) });
    expect(commits(host)[0]!.getAttribute("aria-label")!.endsWith("Declared encoding: ISO-8859-1")).toBe(true);
  });

  test("invalidUtf8 with a null encoding ends the row name with the invalid-bytes sentence", async () => {
    const { host } = await mount({ total: 1, loaded: 1, text: () => ({ subject: "Caf�", invalidUtf8: true }) });
    expect(commits(host)[0]!.getAttribute("aria-label")!.endsWith(INVALID)).toBe(true);
    expect(text(host)).not.toContain("Declared encoding");
  });

  test("invalidUtf8 with an encoding adds the invalid-bytes sentence after the declared encoding", async () => {
    const { host } = await mount({ total: 1, loaded: 1, text: () => ({ encoding: "ISO-8859-1", invalidUtf8: true }) });
    expect(commits(host)[0]!.getAttribute("aria-label")!.endsWith(`Declared encoding: ISO-8859-1, ${INVALID}`)).toBe(true);
  });

  test("the row line shows the Invalid UTF-8 label for a true invalidUtf8, after the encoding name when both are set", async () => {
    const { host } = await mount({ text: (i) => (i === 0 ? { invalidUtf8: true } : i === 1 ? { encoding: "ISO-8859-1", invalidUtf8: true } : {}) });
    const line = (i: number) => commits(host)[i]!.textContent!;
    expect(line(0)).toContain("Invalid UTF-8");
    expect(line(0)).not.toContain("ISO-8859-1");
    expect(line(1)).toMatch(/ISO-8859-1Invalid UTF-8/);
    expect(line(2)).not.toContain("Invalid UTF-8");
  });

  test("only the encoding and invalidUtf8 fields set the label: a subject with replacement characters, a null encoding, and invalidUtf8 false shows none", async () => {
    const { host } = await mount({ total: 1, loaded: 1, text: () => ({ subject: "Caf�" }) });
    expect(text(host)).not.toContain("Declared encoding");
    expect(text(host)).not.toContain(INVALID);
    expect(text(host)).not.toContain("Invalid UTF-8");
  });

  test("rows show the author time through the injected formatter, without the ISO 8601 UTC time", async () => {
    // A pinned zone and locale keep the test independent of the machine. Tokyo is UTC+9 without daylight saving time.
    const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" });
    const local = dateFormat.format(new Date(1577836800 * 1000));
    expect(local).toContain("9:00");
    const { host } = await mount({ total: 1, loaded: 1 }, { dateFormat });
    expect(commits(host)[0]!.getAttribute("aria-label")).toContain(`, Ada, ${local}`);
    expect(text(commits(host)[0]!)).toContain(local.replace(/\s+/g, " "));
    expect(text(commits(host)[0]!)).not.toContain("2020-01-01T00:00:00Z");
  });

  test("a short ID is the first 12 hex digits", async () => {
    const { host } = await mount({ total: 1, loaded: 1 });
    expect(commits(host)[0]!.getAttribute("aria-label")).toContain(`, ${short(0)}, `);
    expect(commits(host)[0]!.getAttribute("aria-label")).not.toContain(oid(0).slice(0, 13));
  });
});

// plan.md "History graph design": the Working directory and Index rows sit above the commits.
describe("Working directory and Index rows", () => {
  const entry = (category: Entry["category"]): Entry => ({ category });
  const ENTRIES = [entry("unstaged"), entry("untracked"), entry("untracked"), entry("staged"), entry("staged")];

  test("they come first with the plan.md names and counts", async () => {
    const { host } = await mount({}, { entries: ENTRIES });
    const [working, index] = options(host);
    expect(working!.getAttribute("aria-label")).toBe("Working directory, 3 working changes");
    expect(index!.getAttribute("aria-label")).toBe("Index, 2 staged");
    for (const part of ["Working directory", "3 working changes"]) expect(text(working!)).toContain(part);
    for (const part of ["Index", "2 staged"]) expect(text(index!)).toContain(part);
  });

  test("a count of 1 takes the singular, a clean complete read reads Working tree clean, and conflicts add the Warning icon and the count", async () => {
    const one = await mount({}, { entries: [entry("unstaged")] });
    expect(options(one.host)[0]!.getAttribute("aria-label")).toBe("Working directory, 1 working change");
    const clean = await mount({}, { entries: [] });
    expect(options(clean.host)[0]!.getAttribute("aria-label")).toBe("Working directory, Working tree clean");
    expect(options(clean.host)[1]!.getAttribute("aria-label")).toBe("Index, 0 staged");
    const conflicted = await mount({}, { entries: [entry("conflicted"), entry("conflicted"), entry("unstaged")] });
    const row = options(conflicted.host)[0]!;
    expect(row.getAttribute("aria-label")).toBe("Working directory, 1 working change, 2 conflicted");
    // The row holds the Warning icon beside the conflict count, outside the graph cell.
    expect(row.querySelectorAll("svg:not(.graph-cell)")).toHaveLength(1);
    expect(options(clean.host)[0]!.querySelectorAll("svg:not(.graph-cell)")).toHaveLength(0);
  });

  test("before a complete read, both rows show the Loading placeholder", async () => {
    const { host } = await mount({}, { entries: null });
    expect(options(host).slice(0, 2).map((o) => o.getAttribute("aria-label"))).toEqual(["Working directory, Loading…", "Index, Loading…"]);
  });

  test("selecting either row calls the dock callback with its row ID", async () => {
    const { host, view, selected } = await mount({}, { entries: ENTRIES });
    await act(async () => view.select(INDEX_ROW, null));
    await settle();
    expect(options(host).map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false", "false"]);
    await act(async () => options(host)[0]!.click());
    await settle();
    expect(selected).toEqual([INDEX_ROW, WORKING_ROW]);
  });

  test("their cells draw the dotted lane-0 line down to the HEAD node, and no node of their own", async () => {
    const { host } = await mount({}, { entries: ENTRIES });
    for (const special of options(host).slice(0, 2)) {
      expect(special.querySelectorAll("svg .working-line")).toHaveLength(1);
      expect(special.querySelectorAll("svg circle")).toHaveLength(0);
    }
    // The HEAD row continues the line from its top edge to its node.
    expect(commits(host)[0]!.querySelectorAll("svg .working-line")).toHaveLength(1);
    expect(commits(host)[1]!.querySelectorAll("svg .working-line")).toHaveLength(0);
  });

  test("an unborn branch draws no line", async () => {
    const { host } = await mount({ total: 0, loaded: 0, startCount: 0, head: { state: "unborn", target: "refs/heads/main" } }, { entries: ENTRIES });
    expect(host.querySelectorAll(".working-line")).toHaveLength(0);
  });
});

// T358 and T362: row labels (plan.md "History graph design"). Feature 002 rows carry their own labels (contract Δ3), so the 001 pairing rule is gone.
describe("row labels", () => {
  const LONG = "feature/ACS-10545-a-very-long-branch-name-that-goes-on-and-on-and-on";
  const labels = (i: number) =>
    i === 0
      ? {
          labels: [
            { kind: "branch" as const, name: "main", invalidUtf8: false },
            { kind: "branch" as const, name: "topic", invalidUtf8: false },
            { kind: "remote" as const, name: "origin/main", invalidUtf8: false },
            { kind: "tag" as const, name: "v1", invalidUtf8: false },
          ],
        }
      : i === 1
        ? { labels: [{ kind: "branch" as const, name: "old", invalidUtf8: false }] }
        : {};
  const chips = (option: HTMLElement) => [...option.querySelectorAll<HTMLElement>(".chip")].map((c) => text(c));

  test("labels follow the HEAD badge: local branches, then remote-tracking branches, then tags", async () => {
    const { host } = await mount({ text: labels });
    const [head, second] = commits(host);
    expect([...head!.querySelectorAll(".badge")].map((b) => b.textContent)).toEqual(["HEAD"]);
    expect(chips(head!)).toEqual(["main", "topic", "origin/main", "v1"]);
    expect(chips(second!)).toEqual(["old"]);
    expect(head!.getAttribute("aria-label")!.startsWith("HEAD, branch main, Branches: main, topic, remote-tracking: origin/main, tags: v1, Commit 0, ")).toBe(true);
    expect(second!.getAttribute("aria-label")!.startsWith("Branches: old, Commit 1, ")).toBe(true);
  });

  test("each label has its kind icon, and its name ends with an ellipsis beyond 160 DIPs", async () => {
    const { host } = await mount({ text: labels });
    for (const chip of commits(host)[0]!.querySelectorAll<HTMLElement>(".chip")) {
      expect(chip.querySelector("svg")).not.toBeNull();
      const name = chip.querySelector<HTMLElement>("[data-chip-name]")!;
      expect(name.className.split(/\s+/)).toEqual(expect.arrayContaining(["truncate", "max-w-[160px]"]));
    }
  });

  test("the labels of one row take at most half of the subject cell; the rest collapse into one +<n> chip", () => {
    expect(fitChips([50, 50, 50], 200, 30)).toBe(3);
    expect(fitChips([50, 50, 50], 120, 30)).toBe(1);
    expect(fitChips([50, 50, 50], 140, 30)).toBe(2);
    expect(fitChips([50, 50, 50], 20, 30)).toBe(0);
  });

  test("the labels share one region that takes at most half of the subject cell and clips at its edge", async () => {
    const long = (i: number) => (i === 0 ? { subject: "Change 1", labels: [{ kind: "branch" as const, name: LONG, invalidUtf8: false }, { kind: "remote" as const, name: `origin/${LONG}`, invalidUtf8: false }] } : {});
    const { host } = await mount({ total: 1, loaded: 1, text: long, head: { state: "branch", target: `refs/heads/${LONG}`, oid: oid(0) } });
    const option = commits(host)[0]!;
    const region = option.querySelector<HTMLElement>('[data-slot="row-labels"]')!;
    expect(region !== null).toBe(true);
    expect(region.className.split(/\s+/)).toEqual(expect.arrayContaining(["max-w-[50%]", "overflow-hidden", "min-w-0"]));
    // The subject sits outside the label region and keeps its own ellipsis.
    const subject = [...option.querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === "Change 1")!;
    expect(region.contains(subject)).toBe(false);
    expect(subject.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(option.getAttribute("aria-label")!.startsWith(`HEAD, branch ${LONG}, Branches: ${LONG}, remote-tracking: origin/${LONG}, Change 1`)).toBe(true);
  });
});
