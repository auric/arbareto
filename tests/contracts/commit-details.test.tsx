// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T348: the "Selected commit" details of `src/frontend/history/CommitDetails.tsx` (plan.md "History graph design", commit details rules, and "Keyboard and focus" Roles).

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { HistoryPage, HistoryRow } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/history/CommitDetails.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { CommitDetails } = await import("../../src/frontend/history/CommitDetails");
const { layoutHistory } = await import("../../src/frontend/history/lanes");

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

const oid = (n: number) => n.toString(16).padStart(4, "0").repeat(10);
const row = (n: number, parents: number[], fields: Partial<HistoryRow> = {}): HistoryRow => ({
  oid: oid(n),
  parents: parents.map(oid),
  subject: `Change ${n}`,
  author: { name: "Ada", email: "ada@example.invalid" },
  date: 1577836800 + n,
  encoding: null,
  shallow: false,
  invalidUtf8: false,
  committer: { name: "Grace", email: "grace@example.invalid" },
  committerDate: 1577840400 + n,
  body: "",
  bodyCut: false,
  ...fields,
});
const page = (rows: HistoryRow[], boundaries = { page: [] as string[], shallow: [] as string[] }): HistoryPage => ({
  generation: 1,
  scope: "current-checkout",
  head: { state: "branch", target: "refs/heads/main", oid: rows[0]!.oid },
  shallowFingerprint: null,
  rows,
  boundaries,
  completeness: { state: "complete" },
});
// 4 and 3 are children of 2. 3 is a merge of 2 and the outside-page commit 9. 2 has parent 1, the root.
const BODY = "First body line.\nSecond line keeps its break.";
const PAGE = page([row(4, [2]), row(3, [2, 9], { subject: "Merge" }), row(2, [1], { body: BODY }), row(1, [])], { page: [oid(9)], shallow: [] });
// A pinned zone and locale keep the test independent of the machine.
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

async function details(selected: number, data: HistoryPage = PAGE, onSelect: (oid: string) => void = () => {}) {
  return await show(<CommitDetails page={data} layout={layoutHistory(data)} oid={oid(selected)} onSelect={onSelect} dateFormat={dateFormat} />);
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
    expect(written).toEqual([oid(2), `Change 2\n\n${BODY}`]);
  });

  test("it shows the subject, the full ID, the author and the committer with their local and ISO 8601 UTC times", async () => {
    const host = await details(2);
    expect(text(host)).toContain("Change 2");
    expect(text(field(host, "ID"))).toBe(oid(2));
    expect(text(field(host, "Author"))).toContain("Ada <ada@example.invalid>");
    expect(text(field(host, "Author"))).toContain("2020-01-01T00:00:02Z");
    expect(text(field(host, "Author"))).toContain(dateFormat.format((1577836800 + 2) * 1000).replace(/\s+/g, " "));
    expect(text(field(host, "Committer"))).toContain("Grace <grace@example.invalid>");
    expect(text(field(host, "Committer"))).toContain("2020-01-01T01:00:02Z");
  });

  test("the parents keep Git order with the boundary texts, and a parent action selects only a loaded OID", async () => {
    const selected: string[] = [];
    const host = await details(3, PAGE, (o) => selected.push(o));
    const parents = field(host, "Parents");
    expect([...parents.querySelectorAll("li")].map((li) => text(li))).toEqual([oid(2), `${oid(9)}Outside loaded page`]);
    const buttons = [...parents.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual([oid(2)]);
    await act(async () => buttons[0]!.click());
    expect(selected).toEqual([oid(2)]);
  });

  test("Children on this checkout lists the page rows whose parents include the commit, in page order, and selects them", async () => {
    const selected: string[] = [];
    const host = await details(2, PAGE, (o) => selected.push(o));
    const children = [...field(host, "Children on this checkout").querySelectorAll("button")];
    expect(children.map((b) => b.textContent)).toEqual([oid(4), oid(3)]);
    await act(async () => children[1]!.click());
    expect(selected).toEqual([oid(3)]);
    expect(field(await details(4), "Children on this checkout").querySelectorAll("button")).toHaveLength(0);
  });

  test("a root commit lists Root commit as its parent text", async () => {
    expect(text(field(await details(1), "Parents"))).toContain("Root commit");
  });

  test("the message shows as wrapped plain text, and a cut message ends with the cut line", async () => {
    const host = await details(2);
    const message = host.querySelector<HTMLElement>("[data-slot=message]")!;
    expect(message.textContent).toBe(BODY);
    expect(message.querySelector("*")).toBeNull();
    expect(text(host)).not.toContain("Arbareto shows the first 16 KiB of this message.");
    const cut = await details(1, page([row(1, [], { body: "x".repeat(100), bodyCut: true })]));
    expect(text(cut)).toContain("Arbareto shows the first 16 KiB of this message.");
  });

  test("the static line stays, and the details hold no Git action", async () => {
    const host = await details(4);
    expect(text(host)).toContain("Changed files are not shown in this version.");
    const labels = [...host.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? text(b));
    expect(labels).toEqual(["Copy commit ID", "Copy message", oid(2)]);
  });

  test("the declared encoding and the invalid-bytes sentences follow the plan.md text", async () => {
    const both = page([row(1, [], { encoding: "ISO-8859-1", invalidUtf8: true })]);
    expect(text(await details(1, both))).toContain(
      "Declared encoding: ISO-8859-1. Arbareto shows the subject and the author as UTF-8 without conversion. Bytes that are not valid UTF-8 show as replacement characters. Some bytes of this commit are not valid UTF-8 and show as replacement characters.",
    );
    const invalid = page([row(1, [], { invalidUtf8: true })]);
    expect(text(await details(1, invalid))).toContain("Some bytes of this commit are not valid UTF-8 and show as replacement characters.");
    expect(text(await details(1, invalid))).not.toContain("Declared encoding");
  });
});
