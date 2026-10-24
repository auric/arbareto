// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T348 and T042: the "Selected commit" details of `src/frontend/history/CommitDetails.tsx` (plan.md "History graph design", commit details rules, and "Keyboard and focus" Roles).

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { useSyncExternalStore } from "react";
import { createFake, oid as fakeOid, stubLayout, TARGET, viewIdOf } from "./history-fake";

printOrigin("../../src/frontend/history/CommitDetails.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { ViewCommitDetails } = await import("../../src/frontend/history/CommitDetails");
const { HistoryList } = await import("../../src/frontend/history/HistoryList");
const { createHistoryView, PAGE_ROWS, SPECIAL_ROWS } = await import("../../src/frontend/state/history-view");
type ViewRow = import("../../src/frontend/state/history-view").ViewRow;

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
afterEach(() => {
  if (original) Object.defineProperty(globalThis.navigator, "clipboard", original);
  else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
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
const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();

// A pinned zone and locale keep the test independent of the machine.
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const BODY = "First body line.\nSecond line keeps its break.";
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

// The fake history: row i has the parent i + 1, and row 9 is the root. Its details fields come from `fields`.
async function details(selected: number, fields: (i: number) => Partial<ViewRow> = () => ({})) {
  const fake = createFake({ total: 10, loaded: 10, details: (i) => ({ body: i === 2 ? BODY : "", ...fields(i) }) });
  const view = createHistoryView(fake.bridge, TARGET);
  await act(async () => void (await view.open("all", false)));
  const host = await show(<ViewCommitDetails view={view} oid={fakeOid(selected)} dateFormat={dateFormat} />);
  await settle();
  return Object.assign(host, { view });
}
const field = (host: HTMLElement, label: string) => {
  const term = [...host.querySelectorAll("dt")].find((d) => text(d) === label);
  expect(term).toBeDefined();
  return term!.nextElementSibling as HTMLElement;
};

describe("Selected commit", () => {
  test("the region is named by its visible heading, and the heading row holds no button", async () => {
    const host = await details(2);
    const region = host.querySelector("section")!;
    const heading = host.querySelector(`#${CSS.escape(region.getAttribute("aria-labelledby")!)}`)!;
    expect(heading.textContent).toContain("Selected commit");
    expect(heading.parentElement!.querySelectorAll("button")).toHaveLength(0);
  });

  test("Copy commit ID sits in the ID row and copies the full ID, and Copy message sits after the subject and copies the subject, a blank line, and the body", async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
    const host = await details(2);
    const id = field(host, "ID").querySelector<HTMLElement>('button[aria-label="Copy commit ID"]')!;
    const message = host.querySelector<HTMLElement>('button[aria-label="Copy message"]')!;
    expect(host.querySelectorAll('button[aria-label="Copy commit ID"]')).toHaveLength(1);
    expect(text(message.parentElement!)).toBe("Commit 2");
    await act(async () => id.click());
    await act(async () => message.click());
    expect(written).toEqual([fakeOid(2), `Commit 2\n\n${BODY}`]);
  });

  test("a commit over the text limit keeps Copy commit ID next to its ID", async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
    const host = await details(3, (i) => (i === 3 ? { textLimit: true } : {}));
    const button = host.querySelector<HTMLElement>('button[aria-label="Copy commit ID"]')!;
    expect(text(button.parentElement!)).toBe(fakeOid(3));
    await act(async () => button.click());
    expect(written).toEqual([fakeOid(3)]);
  });

  test("each parent has its own Copy parent ID button, and it copies that parent", async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
    // The two parents differ in the first 12 hex digits, so each name names its own parent.
    const parents = ["a".repeat(40), "b".repeat(40)];
    const host = await details(2, (i) => (i === 2 ? { parents } : {}));
    const rows = [...field(host, "Parents").querySelectorAll("li")];
    expect(rows.map((li) => [...li.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent))).toEqual([
      [parents[0], `Copy parent ID ${"a".repeat(12)}`],
      [parents[1], `Copy parent ID ${"b".repeat(12)}`],
    ]);
    for (const li of rows) await act(async () => li.querySelector<HTMLElement>('button[aria-label^="Copy parent ID"]')!.click());
    expect(written).toEqual(parents);
  });

  test("it shows the subject, the full ID, the author and the committer with their local and ISO 8601 UTC times", async () => {
    const host = await details(2);
    expect(text(host)).toContain("Commit 2");
    expect(text(field(host, "ID"))).toBe(fakeOid(2));
    expect(text(field(host, "Author"))).toContain("Ada <ada@example.invalid>");
    expect(text(field(host, "Author"))).toContain("2020-01-01T00:00:02Z");
    expect(text(field(host, "Author"))).toContain(dateFormat.format((1577836800 + 2) * 1000).replace(/\s+/g, " "));
    expect(text(field(host, "Committer"))).toContain("Grace <grace@example.invalid>");
    expect(text(field(host, "Committer"))).toContain("2020-01-01T01:00:02Z");
  });

  test("the parents keep Git order, and a parent action selects that commit in the history list", async () => {
    const host = await details(2, (i) => (i === 2 ? { parents: [fakeOid(5), fakeOid(3)] } : {}));
    const buttons = [...field(host, "Parents").querySelectorAll<HTMLElement>('button:not([aria-label^="Copy"])')];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([fakeOid(5), fakeOid(3)]);
    await act(async () => buttons[1]!.click());
    await settle();
    expect(host.view.getState().selection?.id).toBe(fakeOid(3));
  });

  test("Children lists the child commits in Git order and selects them", async () => {
    const host = await details(2, (i) => (i === 2 ? { children: [fakeOid(1), fakeOid(0)] } : {}));
    const children = [...field(host, "Children").querySelectorAll("button")];
    expect(children.map((b) => b.getAttribute("aria-label"))).toEqual([fakeOid(1), fakeOid(0)]);
    await act(async () => children[1]!.click());
    await settle();
    expect(host.view.getState().selection?.id).toBe(fakeOid(0));
    expect(field(await details(0), "Children").querySelectorAll("button")).toHaveLength(0);
  });

  test("the 268 px region cuts no meaning: parent and child links show the short ID with the full ID as name and tooltip, and the values wrap (T070)", async () => {
    const parents = ["a".repeat(40), "b".repeat(40)];
    const host = await details(2, (i) => (i === 2 ? { parents, children: [fakeOid(1)], author: { name: "Ada", email: "ada.lovelace.with.a.very.long.address@analytical-engine.example.invalid" } } : {}));
    const links = [...host.querySelectorAll<HTMLElement>('dd button:not([aria-label^="Copy"])')];
    expect(links.map((b) => [text(b), b.getAttribute("aria-label"), b.getAttribute("title")])).toEqual([
      ["a".repeat(12), parents[0], parents[0]],
      ["b".repeat(12), parents[1], parents[1]],
      [fakeOid(1).slice(0, 12), fakeOid(1), fakeOid(1)],
    ]);
    // 001 plan.md:396: the commit itself keeps its full ID.
    expect(text(field(host, "ID"))).toBe(fakeOid(2));
    // A grid track of `1fr` has the content width as its minimum, so a long value widens the region. The value track starts at zero.
    expect(host.querySelector("dl")!.className.split(" ")).toContain("grid-cols-[auto_minmax(0,1fr)]");
    const person = [...field(host, "Author").querySelectorAll("span")].find((e) => text(e).includes("@"))!;
    expect(person.className.split(" ")).toContain("[overflow-wrap:anywhere]");
  });

  test("a root commit lists the root text as its parent text", async () => {
    expect(text(field(await details(9), "Parents"))).toContain("None. This is a root commit.");
  });

  test("the message shows as wrapped plain text, and an uncut message has no cut line", async () => {
    const host = await details(2);
    const message = host.querySelector<HTMLElement>("[data-slot=message]")!;
    expect(message.textContent).toBe(BODY);
    expect(message.querySelector("*")).toBeNull();
    expect(text(host)).not.toContain("Arbareto shows the first 16 KiB of this message.");
    // T380: the body sets `user-select: none`, so the details values must sit in a `select-text` region. The heading stays chrome.
    for (const value of [message, field(host, "ID"), field(host, "Author")]) expect(value.closest(".select-text")).not.toBeNull();
    expect(host.querySelector("h2")!.closest(".select-text")).toBeNull();
  });

  test("the 001 static line is gone (feature 005 FR-005), and the details hold no Git action", async () => {
    const host = await details(4, (i) => (i === 4 ? { children: [] } : {}));
    expect(text(host)).not.toContain("Changed files are not shown in this version.");
    const labels = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? text(b));
    expect(labels).toEqual(["Copy message", "Copy commit ID", fakeOid(5), `Copy parent ID ${fakeOid(5).slice(0, 12)}`]);
  });

  test("the declared encoding and the invalid-bytes sentences follow the plan.md text", async () => {
    expect(text(await details(1, () => ({ encoding: "ISO-8859-1", invalidUtf8: true })))).toContain(
      "Declared encoding: ISO-8859-1. Arbareto shows the subject and the author as UTF-8 without conversion. Bytes that are not valid UTF-8 show as replacement characters. Some bytes of this commit are not valid UTF-8 and show as replacement characters.",
    );
    const invalid = await details(1, () => ({ invalidUtf8: true }));
    expect(text(invalid)).toContain("Some bytes of this commit are not valid UTF-8 and show as replacement characters.");
    expect(text(invalid)).not.toContain("Declared encoding");
  });
});

// T042: the feature 002 details pane reads the body only when it shows the commit (spec FR-017, FR-018).
describe("Selected commit of a feature 002 view", () => {
  async function opened(details?: Parameters<typeof createFake>[0]["details"]) {
    const fake = createFake({ total: 10, loaded: 10, details });
    const view = createHistoryView(fake.bridge, TARGET);
    await act(async () => void (await view.open("all", false)));
    return { fake, view };
  }
  const detailReads = (fake: ReturnType<typeof createFake>) => fake.of("readHistoryRows").filter((p) => p.text === "details");

  test("the body comes only from readHistoryRows with text details, when the pane shows the commit", async () => {
    const { fake, view } = await opened();
    expect(detailReads(fake)).toHaveLength(0);
    const host = await show(<ViewCommitDetails view={view} oid={fakeOid(3)} dateFormat={dateFormat} />);
    await settle();
    expect(detailReads(fake)).toEqual([{ viewId: viewIdOf(1), mode: "full", at: { oid: fakeOid(3) }, count: 1, text: "details" }]);
    expect(text(host)).toContain("Body of 3");
    expect(field(host, "Parents").querySelector(`button[aria-label="${fakeOid(4)}"]`)).not.toBeNull();
    expect(field(host, "Children").querySelector(`button[aria-label="${fakeOid(2)}"]`)).not.toBeNull();
    expect(text(host)).not.toContain("Arbareto shows the first 16 KiB of this message.");
  });

  test("Refresh with the selected commit reads its details only after the new view loads it (T068)", async () => {
    const fake = createFake({ total: 10, loaded: 10, hold: { load: true } });
    const view = createHistoryView(fake.bridge, TARGET);
    await act(async () => void (await view.open("all", false)));
    await act(async () => view.select(fakeOid(3), 3, "full"));
    const host = await show(<ViewCommitDetails view={view} oid={fakeOid(3)} dateFormat={dateFormat} />);
    await settle();
    expect(detailReads(fake)).toHaveLength(1);
    let refreshed: Promise<void> = Promise.resolve();
    await act(async () => void (refreshed = view.refresh()));
    await settle();
    // The new view does not hold the row before the held load ends (contract Δ3 target `unknown`).
    expect(fake.held()).toBe(1);
    expect(detailReads(fake)).toHaveLength(1);
    await act(async () => (fake.release(), await refreshed));
    await settle();
    expect(detailReads(fake).map((p) => p.viewId)).toEqual([viewIdOf(1), viewIdOf(2)]);
    expect(text(host)).toContain("Body of 3");
    expect(text(host)).not.toContain("This commit is not in the loaded history rows.");
  });

  test("a cut body states that it is cut, and a root commit says so", async () => {
    const { view } = await opened((i) => (i === 9 ? { body: "x".repeat(16 * 1024), bodyCut: true } : {}));
    const host = await show(<ViewCommitDetails view={view} oid={fakeOid(9)} dateFormat={dateFormat} />);
    await settle();
    expect(text(host)).toContain("Arbareto shows the first 16 KiB of this message.");
    expect(text(field(host, "Parents"))).toContain("None. This is a root commit.");
  });

  // plan.md D7: the Details-ready mark follows `onRead`, so only a painted `found` read runs it.
  test("onRead runs for a found commit only, never for a failed read or a none or unknown target", async () => {
    const reads = async (view: ReturnType<typeof createHistoryView>, oid: string) => {
      let count = 0;
      const host = await show(<ViewCommitDetails view={view} oid={oid} dateFormat={dateFormat} onRead={() => void count++} />);
      await settle();
      return { count, host };
    };
    const { view } = await opened();
    const found = await reads(view, fakeOid(3));
    expect(found.count).toBe(1);
    expect(text(found.host)).toContain("Body of 3");
    expect((await reads(view, fakeOid(999))).count).toBe(0);
    const partial = createFake({ total: 10, loaded: 5 });
    const unknown = createHistoryView(partial.bridge, TARGET);
    await act(async () => void (await unknown.open("all", false)));
    expect((await reads(unknown, fakeOid(7))).count).toBe(0);
    const broken = createFake({ total: 10, loaded: 10 });
    const failing = { ...broken.bridge, readHistoryRows: async () => ({ requestId: "r", state: "failed" as const, code: "GIT_FAILED" as const }) };
    const failed = createHistoryView(failing, TARGET);
    await act(async () => void (await failed.open("all", false)));
    const failedRead = await reads(failed, fakeOid(3));
    expect(failedRead.count).toBe(0);
    expect(text(failedRead.host)).toContain("Arbareto cannot read this commit: GIT_FAILED.");
    // Feature 004 plan D15 "Malformed result": a succeeded details read without a target never shows its state.
    const odd = createFake({ total: 10, loaded: 10 });
    const malformed = { ...odd.bridge, readHistoryRows: (async (target, payload, ...rest) => (payload.text === "details" ? { requestId: "r", state: "succeeded" as const, result: {} } : odd.bridge.readHistoryRows(target, payload, ...rest))) as typeof odd.bridge.readHistoryRows };
    const unknownForm = createHistoryView(malformed, TARGET);
    await act(async () => void (await unknownForm.open("all", false)));
    const unknownRead = await reads(unknownForm, fakeOid(3));
    expect(unknownRead.count).toBe(0);
    expect(text(unknownRead.host)).toContain("The commit did not load: the result has an unknown form.");
  });
});

// Contract Δ3: a newer text read cancels an unfinished one of the same view. The fake models it.
describe("details reads beside page reads", () => {
  function Pair({ view }: { view: ReturnType<typeof createHistoryView> }) {
    const state = useSyncExternalStore(view.subscribe, view.getState);
    const id = state.selection?.id;
    return (
      <>
        <HistoryList view={view} entries={[]} density="compact" profile="wide" onSelect={() => {}} onScope={() => {}} />
        <div data-pane="">{id !== undefined && id.length === 40 ? <ViewCommitDetails view={view} oid={id} dateFormat={dateFormat} /> : null}</div>
      </>
    );
  }

  test("a held arrow key across pages never shows the not-in-list text, and the pane ends on the selected commit", async () => {
    // A short viewport renders fewer rows per press. The row count does not change the page reads.
    const restore = stubLayout(160);
    try {
      const fake = createFake({ total: 2_000, loaded: 2_000 });
      const view = createHistoryView(fake.bridge, TARGET);
      const host = await show(<Pair view={view} />);
      await act(async () => void (await view.open("all", false)));
      await settle();
      const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
      const pane = host.querySelector<HTMLElement>("[data-pane]")!;
      let wrong = 0;
      const observer = new MutationObserver(() => void (text(pane).includes("not in the history list") && wrong++));
      observer.observe(pane, { subtree: true, childList: true, characterData: true });
      await act(async () => list.focus());
      // The list starts on item 0. These presses end on commit 2·PAGE_ROWS, so the selection crosses two page boundaries.
      const presses = SPECIAL_ROWS + 2 * PAGE_ROWS;
      // A timed-out test unmounts the list. The loop then stops before the DOM teardown.
      for (let i = 0; i < presses && list.isConnected; i++) {
        await act(async () => void list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
        if (i % 4 === 0) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
      }
      await settle();
      await settle();
      observer.disconnect();
      expect(wrong).toBe(0);
      // The page reads and the details reads never cancel each other.
      expect(fake.canceledTexts()).toBe(0);
      expect(fake.of("readHistoryRows").some((p) => p.text === "details")).toBe(true);
      expect(fake.of("readHistoryRows").flatMap((p) => (p.text === "rows" ? [(p.at as { row: number }).row] : []))).toEqual([0, PAGE_ROWS, 2 * PAGE_ROWS]);
      const selected = view.getState().selection!.id;
      expect(selected).toBe(fakeOid(2 * PAGE_ROWS));
      expect(text(pane)).toContain(`Body of ${parseInt(selected, 16)}`);
    } finally {
      restore();
    }
    // The case presses keys across 2,000 rows in happy-dom and takes 3 to 4 s, near the 5 s Bun default.
  }, 30_000);
});
