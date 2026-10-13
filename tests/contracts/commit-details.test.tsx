// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T348 and T042: the "Selected commit" details of `src/frontend/history/CommitDetails.tsx` (plan.md "History graph design", commit details rules, and "Keyboard and focus" Roles).

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { useSyncExternalStore } from "react";
import { createFake, oid as fakeOid, stubLayout, TARGET } from "./history-fake";

printOrigin("../../src/frontend/history/CommitDetails.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { ViewCommitDetails } = await import("../../src/frontend/history/CommitDetails");
const { HistoryList } = await import("../../src/frontend/history/HistoryList");
const { createHistoryView } = await import("../../src/frontend/state/history-view");
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
  test("the region is named by its visible heading, and the heading holds Copy commit ID and Copy message icon buttons", async () => {
    const host = await details(2);
    const region = host.querySelector("section")!;
    const heading = host.querySelector(`#${CSS.escape(region.getAttribute("aria-labelledby")!)}`)!;
    expect(heading.textContent).toContain("Selected commit");
    const copies = [...heading.parentElement!.querySelectorAll("button")].map((b) => [b.getAttribute("aria-label"), text(b)]);
    expect(copies).toEqual([
      ["Copy commit ID", ""],
      ["Copy message", ""],
    ]);
  });

  test("Copy commit ID copies the full ID, and Copy message copies the subject, a blank line, and the body", async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
    const host = await details(2);
    const button = (label: string) => host.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!;
    await act(async () => button("Copy commit ID").click());
    await act(async () => button("Copy message").click());
    expect(written).toEqual([fakeOid(2), `Commit 2\n\n${BODY}`]);
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
    const buttons = [...field(host, "Parents").querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual([fakeOid(5), fakeOid(3)]);
    await act(async () => buttons[1]!.click());
    await settle();
    expect(host.view.getState().selection?.id).toBe(fakeOid(3));
  });

  test("Children lists the child commits in Git order and selects them", async () => {
    const host = await details(2, (i) => (i === 2 ? { children: [fakeOid(1), fakeOid(0)] } : {}));
    const children = [...field(host, "Children").querySelectorAll("button")];
    expect(children.map((b) => b.textContent)).toEqual([fakeOid(1), fakeOid(0)]);
    await act(async () => children[1]!.click());
    await settle();
    expect(host.view.getState().selection?.id).toBe(fakeOid(0));
    expect(field(await details(0), "Children").querySelectorAll("button")).toHaveLength(0);
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
  });

  test("the static line stays, and the details hold no Git action", async () => {
    const host = await details(4, (i) => (i === 4 ? { children: [] } : {}));
    expect(text(host)).toContain("Changed files are not shown in this version.");
    const labels = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? text(b));
    expect(labels).toEqual(["Copy commit ID", "Copy message", fakeOid(5)]);
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
    expect(detailReads(fake)).toEqual([{ viewId: "view-1", mode: "full", at: { oid: fakeOid(3) }, count: 1, text: "details" }]);
    expect(text(host)).toContain("Body of 3");
    expect(text(field(host, "Parents"))).toContain(fakeOid(4));
    expect(text(field(host, "Children"))).toContain(fakeOid(2));
    expect(text(host)).not.toContain("Arbareto shows the first 16 KiB of this message.");
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
    expect((await reads(failed, fakeOid(3))).count).toBe(0);
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
    const restore = stubLayout(800);
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
      for (let i = 0; i < 400; i++) {
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
      const selected = view.getState().selection!.id;
      expect(text(pane)).toContain(`Body of ${parseInt(selected, 16)}`);
    } finally {
      restore();
    }
  });
});
