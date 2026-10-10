// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { HistoryPage, HistoryRow } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/history/HistoryView.tsx", import.meta.dir);
// `HistoryView.tsx` loads Base UI. Base UI must first evaluate with a DOM (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const { HistoryView } = await import("../../src/frontend/history/HistoryView");

// tasks.md T144 and plan.md "History graph design" and "Keyboard and focus" (Roles, File/history list).

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
const text = (host: Element) => (host.textContent ?? "").replace(/\s+/g, " ").trim();
const options = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="option"]')];

const oid = (n: number) => n.toString(16).padStart(4, "0").repeat(10);
const short = (n: number) => oid(n).slice(0, 12);
const row = (n: number, parents: number[], subject = `Change ${n}`): HistoryRow => ({ oid: oid(n), parents: parents.map(oid), subject, author: { name: "Ada", email: "ada@example.invalid" }, date: 1577836800 + n, encoding: null, shallow: false, invalidUtf8: false });
const page = (rows: HistoryRow[], head: HistoryPage["head"] = { state: "branch", target: "refs/heads/main", oid: rows[0]!.oid }, boundaries = { page: [] as string[], shallow: [] as string[] }): HistoryPage => ({
  generation: 1,
  scope: "current-checkout",
  head,
  shallowFingerprint: null,
  rows,
  boundaries,
  completeness: { state: "complete" },
});
// 3 is a merge of 2 and the outside-page commit 9. 2 has parent 1, the root.
const MERGE = page([row(3, [2, 9], "Merge"), row(2, [1]), row(1, [])], undefined, { page: [oid(9)], shallow: [] });
const props = { entries: [], density: "compact" as const, profile: "wide" as const, onSelect: () => {} };

describe("History view", () => {
  test("rows keep service order in one listbox with one Tab stop, and only the selected option has aria-selected true", async () => {
    const host = await show(<HistoryView {...props} page={MERGE} selectedOid={oid(2)} />);
    expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    expect(options(host).map((o) => o.dataset.oid)).toEqual([oid(3), oid(2), oid(1)]);
    expect(options(host).map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(host.querySelector('[role="listbox"]')!.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(host.querySelector("svg [tabindex], svg[tabindex]")).toBeNull();
  });

  test("the accessible name starts with the HEAD labels and holds the parents and boundary texts, and the badges sit outside the graph cell", async () => {
    const host = await show(<HistoryView {...props} page={MERGE} selectedOid={null} />);
    const [merge, , root] = options(host).map((o) => o.getAttribute("aria-label")!);
    expect(merge.startsWith(`HEAD, branch main, Merge, ${short(3)}`)).toBe(true);
    expect(merge).toContain(`2 parents, ${short(2)}, ${short(9)}, Outside loaded page`);
    expect(root).toContain("Root commit");
    expect(options(host)[0]!.querySelector("svg")!.textContent).toBe("");
    expect([...options(host)[0]!.querySelectorAll(".badge")].map((b) => b.textContent)).toEqual(["HEAD", "main"]);
  });

  test("a detached HEAD row starts with HEAD, detached and shows only the HEAD badge", async () => {
    const detached = page([row(1, [])], { state: "detached", oid: oid(1) });
    const host = await show(<HistoryView {...props} page={detached} selectedOid={null} />);
    expect(options(host)[0]!.getAttribute("aria-label")!.startsWith("HEAD, detached, ")).toBe(true);
    expect([...host.querySelectorAll(".badge")].map((b) => b.textContent)).toEqual(["HEAD"]);
  });

  test("without a selection, the inspector region says so", async () => {
    const host = await show(<HistoryView {...props} page={MERGE} selectedOid={null} />);
    const region = host.querySelector("section")!;
    expect(host.querySelector(`#${CSS.escape(region.getAttribute("aria-labelledby")!)}`)!.textContent).toBe("Selected commit");
    expect(text(region)).toContain("Select a commit to see its details");
  });

  test("the inspector shows the full ID, ordered parents, boundary texts, and the static line; a parent action selects only a loaded OID", async () => {
    const selected: string[] = [];
    const host = await show(<HistoryView {...props} page={MERGE} selectedOid={oid(3)} onSelect={(o) => selected.push(o)} />);
    const region = host.querySelector("section")!;
    for (const part of [oid(3), oid(9), "Outside loaded page", "Changed files are not shown in this version."]) expect(text(region)).toContain(part);
    const parents = [...region.querySelectorAll("button")];
    expect(parents.map((b) => b.textContent)).toEqual([oid(2)]);
    await act(async () => parents[0]!.click());
    expect(selected).toEqual([oid(2)]);
  });

  test("arrow keys move focus without selecting, and Enter selects the focused row", async () => {
    const selected: string[] = [];
    const host = await show(<HistoryView {...props} page={MERGE} selectedOid={null} onSelect={(o) => selected.push(o)} />);
    const key = async (target: HTMLElement, k: string) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
    await act(async () => options(host)[0]!.focus());
    await key(options(host)[0]!, "ArrowDown");
    expect(document.activeElement).toBe(options(host)[1]!);
    await key(options(host)[1]!, "End");
    expect(document.activeElement).toBe(options(host)[2]!);
    expect(selected).toEqual([]);
    await key(options(host)[2]!, "Enter");
    expect(selected).toEqual([oid(1)]);
  });

  test("an unborn branch says No commits yet", async () => {
    const host = await show(<HistoryView {...props} page={{ ...page([], { state: "unborn", target: "refs/heads/main" }) }} selectedOid={null} />);
    expect(text(host)).toContain("No commits yet");
    expect(options(host)).toHaveLength(0);
  });

  test("only the shallow field sets the end of a row without parents: false gives Root commit, true gives Shallow history boundary", async () => {
    const mixed = page([row(2, []), { ...row(1, []), shallow: true }], undefined, { page: [], shallow: [oid(9)] });
    const host = await show(<HistoryView {...props} page={mixed} selectedOid={oid(1)} />);
    const [root, shallow] = options(host).map((o) => o.getAttribute("aria-label")!);
    expect(root!.endsWith("Root commit")).toBe(true);
    expect(shallow!.endsWith("Shallow history boundary")).toBe(true);
    expect(text(host.querySelector("section")!)).toContain("Shallow history boundary");
    expect(text(host)).not.toContain("cannot tell");
  });

  test("a non-null encoding ends the row name with the declared encoding, and the inspector shows the full sentence", async () => {
    const declared = page([{ ...row(1, []), encoding: "ISO-8859-1" }]);
    const host = await show(<HistoryView {...props} page={declared} selectedOid={oid(1)} />);
    expect(options(host)[0]!.getAttribute("aria-label")!.endsWith("Declared encoding: ISO-8859-1")).toBe(true);
    expect(text(host.querySelector("section")!)).toContain(
      "Declared encoding: ISO-8859-1. Arbareto shows the subject and the author as UTF-8 without conversion. Bytes that are not valid UTF-8 show as replacement characters.",
    );
  });

  const INVALID = "Some bytes of this commit are not valid UTF-8 and show as replacement characters.";

  test("invalidUtf8 with a null encoding ends the row name with the invalid-bytes sentence, and the inspector shows it", async () => {
    const host = await show(<HistoryView {...props} page={page([{ ...row(1, [], "Caf�"), invalidUtf8: true }])} selectedOid={oid(1)} />);
    expect(options(host)[0]!.getAttribute("aria-label")!.endsWith(INVALID)).toBe(true);
    expect(text(host.querySelector("section")!)).toContain(INVALID);
    expect(text(host)).not.toContain("Declared encoding");
  });

  test("invalidUtf8 with an encoding adds the invalid-bytes sentence after the declared encoding", async () => {
    const both = page([{ ...row(1, []), encoding: "ISO-8859-1", invalidUtf8: true }]);
    const host = await show(<HistoryView {...props} page={both} selectedOid={oid(1)} />);
    expect(options(host)[0]!.getAttribute("aria-label")!.endsWith(`Declared encoding: ISO-8859-1, ${INVALID}`)).toBe(true);
    expect(text(host.querySelector("section")!)).toContain(
      `Declared encoding: ISO-8859-1. Arbareto shows the subject and the author as UTF-8 without conversion. Bytes that are not valid UTF-8 show as replacement characters. ${INVALID}`,
    );
  });

  test("only the encoding and invalidUtf8 fields set the label: a subject with replacement characters, a null encoding, and invalidUtf8 false shows none", async () => {
    const host = await show(<HistoryView {...props} page={page([row(1, [], "Caf�")])} selectedOid={oid(1)} />);
    expect(text(host)).not.toContain("Declared encoding");
    expect(text(host)).not.toContain(INVALID);
  });

  test("rows and the inspector show the author time through the injected formatter, and the inspector adds the ISO 8601 UTC time", async () => {
    // A pinned zone and locale keep the test independent of the machine. Tokyo is UTC+9 without daylight saving time.
    const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" });
    const local = dateFormat.format(new Date((1577836800 + 1) * 1000));
    expect(local).toContain("9:00");
    const host = await show(<HistoryView {...props} page={page([row(1, [])])} selectedOid={oid(1)} dateFormat={dateFormat} />);
    expect(options(host)[0]!.getAttribute("aria-label")).toContain(`, Ada, ${local}`);
    expect(text(options(host)[0]!)).toContain(local.replace(/\s+/g, " "));
    const region = text(host.querySelector("section")!);
    expect(region).toContain(local.replace(/\s+/g, " "));
    expect(region).toContain("2020-01-01T00:00:01Z");
    expect(text(options(host)[0]!)).not.toContain("2020-01-01T00:00:01Z");
  });

  test("a short ID is the first 12 hex digits", async () => {
    const host = await show(<HistoryView {...props} page={page([row(1, [])])} selectedOid={null} />);
    expect(options(host)[0]!.getAttribute("aria-label")).toContain(`, ${oid(1).slice(0, 12)}, `);
    expect(options(host)[0]!.getAttribute("aria-label")).not.toContain(oid(1).slice(0, 13));
  });

  test("a layout limit gives node-only rows, and the limit text is the list's accessible description", async () => {
    const wide = page([row(1, Array.from({ length: 25 }, (_, i) => 100 + i))], undefined, { page: Array.from({ length: 25 }, (_, i) => oid(100 + i)), shallow: [] });
    const host = await show(<HistoryView {...props} page={wide} selectedOid={null} />);
    const list = host.querySelector('[role="listbox"]')!;
    expect(host.querySelector(`#${CSS.escape(list.getAttribute("aria-describedby")!)}`)!.textContent).toBe("Graph layout limited: more than 24 lanes");
    expect(options(host)[0]!.querySelectorAll("svg path")).toHaveLength(0);
  });
});
