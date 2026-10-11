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
const { HistoryView, WORKING_ROW, INDEX_ROW, fitChips } = await import("../../src/frontend/history/HistoryView");

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
const row = (n: number, parents: number[], subject = `Change ${n}`): HistoryRow => ({ oid: oid(n), parents: parents.map(oid), subject, author: { name: "Ada", email: "ada@example.invalid" }, date: 1577836800 + n, encoding: null, shallow: false, invalidUtf8: false, committer: { name: "Ada", email: "ada@example.invalid" }, committerDate: 1577836800 + n, body: "", bodyCut: false });
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
// The commit rows, after the Working directory and Index options.
const commits = (host: HTMLElement) => options(host).filter((o) => o.dataset.oid !== undefined);

describe("History view", () => {
  test("rows keep service order in one listbox with one Tab stop, and only the selected option has aria-selected true", async () => {
    const host = await show(<HistoryView {...props} page={MERGE} selected={oid(2)} />);
    expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    expect(commits(host).map((o) => o.dataset.oid)).toEqual([oid(3), oid(2), oid(1)]);
    expect(options(host).map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "false", "false", "true", "false"]);
    expect(host.querySelector('[role="listbox"]')!.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(host.querySelector("svg [tabindex], svg[tabindex]")).toBeNull();
  });

  test("the accessible name starts with the HEAD labels and holds the parents and boundary texts, and the badges sit outside the graph cell", async () => {
    const host = await show(<HistoryView {...props} page={MERGE} selected={null} />);
    const [merge, , root] = commits(host).map((o) => o.getAttribute("aria-label")!);
    expect(merge.startsWith(`HEAD, branch main, Merge, ${short(3)}`)).toBe(true);
    expect(merge).toContain(`2 parents, ${short(2)}, ${short(9)}, Outside loaded page`);
    expect(root).toContain("Root commit");
    expect(commits(host)[0]!.querySelector("svg")!.textContent).toBe("");
    expect([...commits(host)[0]!.querySelectorAll(".badge")].map((b) => b.textContent)).toEqual(["HEAD", "main"]);
  });

  test("a detached HEAD row starts with HEAD, detached and shows only the HEAD badge", async () => {
    const detached = page([row(1, [])], { state: "detached", oid: oid(1) });
    const host = await show(<HistoryView {...props} page={detached} selected={null} />);
    expect(commits(host)[0]!.getAttribute("aria-label")!.startsWith("HEAD, detached, ")).toBe(true);
    expect([...host.querySelectorAll(".badge")].map((b) => b.textContent)).toEqual(["HEAD"]);
  });

  test("arrow keys, Home, and End move focus and select the focused row at once; Enter and a click select too", async () => {
    const selected: string[] = [];
    const host = await show(<HistoryView {...props} page={MERGE} selected={null} onSelect={(o) => selected.push(o)} />);
    const key = async (target: HTMLElement, k: string) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
    await act(async () => options(host)[0]!.focus());
    await key(options(host)[0]!, "ArrowDown");
    expect(document.activeElement).toBe(options(host)[1]!);
    expect(selected).toEqual([INDEX_ROW]);
    await key(options(host)[1]!, "End");
    expect(document.activeElement).toBe(options(host)[4]!);
    await key(options(host)[4]!, "Home");
    expect(selected).toEqual([INDEX_ROW, oid(1), WORKING_ROW]);
    await key(options(host)[0]!, "Enter");
    await act(async () => options(host)[2]!.click());
    expect(selected).toEqual([INDEX_ROW, oid(1), WORKING_ROW, WORKING_ROW, oid(3)]);
  });

  test("an unborn branch says No commits yet and keeps the Working directory and Index options", async () => {
    const host = await show(<HistoryView {...props} page={{ ...page([], { state: "unborn", target: "refs/heads/main" }) }} selected={null} />);
    expect(text(host)).toContain("No commits yet");
    expect(commits(host)).toHaveLength(0);
    expect(options(host)).toHaveLength(2);
  });

  test("only the shallow field sets the end of a row without parents: false gives Root commit, true gives Shallow history boundary", async () => {
    const mixed = page([row(2, []), { ...row(1, []), shallow: true }], undefined, { page: [], shallow: [oid(9)] });
    const host = await show(<HistoryView {...props} page={mixed} selected={oid(1)} />);
    const [root, shallow] = commits(host).map((o) => o.getAttribute("aria-label")!);
    expect(root!.endsWith("Root commit")).toBe(true);
    expect(shallow!.endsWith("Shallow history boundary")).toBe(true);
    expect(text(host)).not.toContain("cannot tell");
  });

  test("a non-null encoding ends the row name with the declared encoding", async () => {
    const declared = page([{ ...row(1, []), encoding: "ISO-8859-1" }]);
    const host = await show(<HistoryView {...props} page={declared} selected={oid(1)} />);
    expect(commits(host)[0]!.getAttribute("aria-label")!.endsWith("Declared encoding: ISO-8859-1")).toBe(true);
  });

  const INVALID = "Some bytes of this commit are not valid UTF-8 and show as replacement characters.";

  test("invalidUtf8 with a null encoding ends the row name with the invalid-bytes sentence", async () => {
    const host = await show(<HistoryView {...props} page={page([{ ...row(1, [], "Caf�"), invalidUtf8: true }])} selected={oid(1)} />);
    expect(commits(host)[0]!.getAttribute("aria-label")!.endsWith(INVALID)).toBe(true);
    expect(text(host)).not.toContain("Declared encoding");
  });

  test("invalidUtf8 with an encoding adds the invalid-bytes sentence after the declared encoding", async () => {
    const both = page([{ ...row(1, []), encoding: "ISO-8859-1", invalidUtf8: true }]);
    const host = await show(<HistoryView {...props} page={both} selected={oid(1)} />);
    expect(commits(host)[0]!.getAttribute("aria-label")!.endsWith(`Declared encoding: ISO-8859-1, ${INVALID}`)).toBe(true);
  });

  test("the row line shows the Invalid UTF-8 badge for a true invalidUtf8, after the encoding name when both are set", async () => {
    const rows = page([{ ...row(3, []), invalidUtf8: true }, { ...row(2, [3]), encoding: "ISO-8859-1", invalidUtf8: true }, row(1, [2])]);
    const host = await show(<HistoryView {...props} page={rows} selected={null} />);
    const line = (i: number) => commits(host)[i]!.textContent!;
    expect(line(0)).toContain("Invalid UTF-8");
    expect(line(0)).not.toContain("ISO-8859-1");
    expect(line(1)).toMatch(/ISO-8859-1Invalid UTF-8/);
    expect(line(2)).not.toContain("Invalid UTF-8");
  });

  test("only the encoding and invalidUtf8 fields set the label: a subject with replacement characters, a null encoding, and invalidUtf8 false shows none", async () => {
    const host = await show(<HistoryView {...props} page={page([row(1, [], "Caf�")])} selected={oid(1)} />);
    expect(text(host)).not.toContain("Declared encoding");
    expect(text(host)).not.toContain(INVALID);
  });

  test("rows show the author time through the injected formatter, without the ISO 8601 UTC time", async () => {
    // A pinned zone and locale keep the test independent of the machine. Tokyo is UTC+9 without daylight saving time.
    const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" });
    const local = dateFormat.format(new Date((1577836800 + 1) * 1000));
    expect(local).toContain("9:00");
    const host = await show(<HistoryView {...props} page={page([row(1, [])])} selected={oid(1)} dateFormat={dateFormat} />);
    expect(commits(host)[0]!.getAttribute("aria-label")).toContain(`, Ada, ${local}`);
    expect(text(commits(host)[0]!)).toContain(local.replace(/\s+/g, " "));
    expect(text(commits(host)[0]!)).not.toContain("2020-01-01T00:00:01Z");
  });

  test("a short ID is the first 12 hex digits", async () => {
    const host = await show(<HistoryView {...props} page={page([row(1, [])])} selected={null} />);
    expect(commits(host)[0]!.getAttribute("aria-label")).toContain(`, ${oid(1).slice(0, 12)}, `);
    expect(commits(host)[0]!.getAttribute("aria-label")).not.toContain(oid(1).slice(0, 13));
  });

  test("a layout limit gives node-only rows, and the limit text is the list's accessible description", async () => {
    const wide = page([row(1, Array.from({ length: 25 }, (_, i) => 100 + i))], undefined, { page: Array.from({ length: 25 }, (_, i) => oid(100 + i)), shallow: [] });
    const host = await show(<HistoryView {...props} page={wide} selected={null} />);
    const list = host.querySelector('[role="listbox"]')!;
    expect(host.querySelector(`#${CSS.escape(list.getAttribute("aria-describedby")!)}`)!.textContent).toBe("Graph layout limited: more than 24 lanes");
    expect(commits(host)[0]!.querySelectorAll("svg path:not(.working-line)")).toHaveLength(0);
  });
});

// plan.md "History graph design": the Working directory and Index rows sit above the commits.
describe("Working directory and Index rows", () => {
  const entry = (category: "unstaged" | "untracked" | "staged" | "conflicted") => ({ category });
  const ENTRIES = [entry("unstaged"), entry("untracked"), entry("untracked"), entry("staged"), entry("staged")];

  test("they come first with the plan.md names and counts", async () => {
    const host = await show(<HistoryView {...props} entries={ENTRIES} page={MERGE} selected={null} />);
    const [working, index] = options(host);
    expect(working!.getAttribute("aria-label")).toBe("Working directory, 3 working changes");
    expect(index!.getAttribute("aria-label")).toBe("Index, 2 staged");
    for (const part of ["Working directory", "3 working changes"]) expect(text(working!)).toContain(part);
    for (const part of ["Index", "2 staged"]) expect(text(index!)).toContain(part);
  });

  test("a count of 1 takes the singular, a clean complete read reads Working tree clean, and conflicts add the Warning icon and the count", async () => {
    const one = await show(<HistoryView {...props} entries={[entry("unstaged")]} page={MERGE} selected={null} />);
    expect(options(one)[0]!.getAttribute("aria-label")).toBe("Working directory, 1 working change");
    const clean = await show(<HistoryView {...props} entries={[]} page={MERGE} selected={null} />);
    expect(options(clean)[0]!.getAttribute("aria-label")).toBe("Working directory, Working tree clean");
    expect(options(clean)[1]!.getAttribute("aria-label")).toBe("Index, 0 staged");
    const conflicted = await show(<HistoryView {...props} entries={[entry("conflicted"), entry("conflicted"), entry("unstaged")]} page={MERGE} selected={null} />);
    const row = options(conflicted)[0]!;
    expect(row.getAttribute("aria-label")).toBe("Working directory, 1 working change, 2 conflicted");
    // The row holds the Warning icon beside the conflict count, outside the graph cell.
    expect(row.querySelectorAll("svg:not(.graph-cell)")).toHaveLength(1);
    expect(options(clean)[0]!.querySelectorAll("svg:not(.graph-cell)")).toHaveLength(0);
  });

  test("before a complete read, both rows show the Loading placeholder", async () => {
    const host = await show(<HistoryView {...props} entries={null} page={MERGE} selected={null} />);
    expect(options(host).slice(0, 2).map((o) => o.getAttribute("aria-label"))).toEqual(["Working directory, Loading…", "Index, Loading…"]);
  });

  test("selecting either row calls the dock callback with its row ID", async () => {
    const selected: string[] = [];
    const host = await show(<HistoryView {...props} entries={ENTRIES} page={MERGE} selected={INDEX_ROW} onSelect={(o) => selected.push(o)} />);
    expect(options(host).map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false", "false"]);
    await act(async () => options(host)[0]!.click());
    expect(selected).toEqual([WORKING_ROW]);
  });

  test("their cells draw the dotted lane-0 line down to the HEAD node, and no node of their own", async () => {
    const host = await show(<HistoryView {...props} entries={ENTRIES} page={MERGE} selected={null} />);
    for (const special of options(host).slice(0, 2)) {
      expect(special.querySelectorAll("svg .working-line")).toHaveLength(1);
      expect(special.querySelectorAll("svg circle")).toHaveLength(0);
    }
    // The HEAD row continues the line from its top edge to its node.
    expect(commits(host)[0]!.querySelectorAll("svg .working-line")).toHaveLength(1);
    expect(commits(host)[1]!.querySelectorAll("svg .working-line")).toHaveLength(0);
  });

  test("an unborn branch draws no line", async () => {
    const host = await show(<HistoryView {...props} entries={ENTRIES} page={page([], { state: "unborn", target: "refs/heads/main" })} selected={null} />);
    expect(host.querySelectorAll(".working-line")).toHaveLength(0);
  });
});


// T358: reference chips (plan.md "History graph design", contract §3 "References result" and "Pairing with the history page").
describe("reference chips", () => {
  const ref = (kind: "branch" | "remote" | "tag", name: string, commit: number, fields: Record<string, unknown> = {}) => ({
    kind,
    name,
    invalidUtf8: false,
    objectId: oid(commit),
    objectType: "commit" as const,
    peeledId: null,
    peeledType: null,
    symref: null,
    upstream: null,
    upstreamPresent: false,
    commitId: oid(commit),
    ...fields,
  });
  // Git refname order inside each kind; the result lists tags before the remote here to prove the kind order.
  const REFS = {
    generation: 1,
    refs: [
      ref("branch", "main", 3),
      ref("branch", "old", 2),
      ref("branch", "topic", 3),
      ref("tag", "v1", 3),
      ref("remote", "origin/HEAD", 3, { symref: "refs/remotes/origin/main" }),
      ref("remote", "origin/main", 3),
    ],
    current: { name: "main", objectId: oid(3) },
    completeness: { state: "complete" as const },
  };
  const chips = (option: HTMLElement) => [...option.querySelectorAll<HTMLElement>(".chip")].map((c) => text(c));

  test("a paired result adds chips after the HEAD badges: local branches, then remote-tracking branches, then tags; no symbolic chip", async () => {
    const host = await show(<HistoryView {...props} page={MERGE} selected={null} refs={REFS} />);
    const [head, second] = commits(host);
    expect([...head!.querySelectorAll(".badge")].map((b) => b.textContent)).toEqual(["HEAD", "main"]);
    expect(chips(head!)).toEqual(["topic", "origin/main", "v1"]);
    expect(chips(second!)).toEqual(["old"]);
    expect(head!.getAttribute("aria-label")!.startsWith("HEAD, branch main, Branches: topic, remote-tracking: origin/main, tags: v1, Merge, ")).toBe(true);
    expect(second!.getAttribute("aria-label")!.startsWith("Branches: old, Change 2, ")).toBe(true);
  });

  test("each chip has its kind icon, and its name ends with an ellipsis beyond 160 DIPs", async () => {
    const host = await show(<HistoryView {...props} page={MERGE} selected={null} refs={REFS} />);
    for (const chip of commits(host)[0]!.querySelectorAll<HTMLElement>(".chip")) {
      expect(chip.querySelector("svg")).not.toBeNull();
      const name = chip.querySelector<HTMLElement>("[data-chip-name]")!;
      expect(name.className.split(/\s+/)).toContain("truncate");
      expect(name.className.split(/\s+/)).toContain("max-w-[160px]");
    }
  });

  test("without a pair, only HEAD and the current branch show", async () => {
    for (const current of [{ name: "main", objectId: oid(2) }, { name: "other", objectId: oid(3) }, null]) {
      const host = await show(<HistoryView {...props} page={MERGE} selected={null} refs={{ ...REFS, current }} />);
      expect(host.querySelectorAll(".chip")).toHaveLength(0);
      expect(commits(host)[1]!.getAttribute("aria-label")!.startsWith("Change 2, ")).toBe(true);
    }
  });

  test("a detached HEAD pairs with a null current", async () => {
    const detached = page([row(1, [])], { state: "detached", oid: oid(1) });
    const host = await show(<HistoryView {...props} page={detached} selected={null} refs={{ ...REFS, refs: [ref("tag", "v0", 1)], current: null }} />);
    expect(chips(commits(host)[0]!)).toEqual(["v0"]);
  });

  test("the chips of one row take at most half of the subject cell; the rest collapse into one +<n> chip", () => {
    expect(fitChips([50, 50, 50], 200, 30)).toBe(3);
    expect(fitChips([50, 50, 50], 120, 30)).toBe(1);
    expect(fitChips([50, 50, 50], 140, 30)).toBe(2);
    expect(fitChips([50, 50, 50], 20, 30)).toBe(0);
  });
});

// T362: very long reference names never push the labels into the ID column (plan.md "History graph design").
describe("label region bound", () => {
  const LONG = "feature/ACS-10545-a-very-long-branch-name-that-goes-on-and-on-and-on";
  const longPage = page([row(1, [])], { state: "branch", target: `refs/heads/${LONG}`, oid: oid(1) });
  const longRefs = {
    generation: 1,
    refs: [
      { kind: "branch" as const, name: LONG, invalidUtf8: false, objectId: oid(1), objectType: "commit" as const, peeledId: null, peeledType: null, symref: null, upstream: null, upstreamPresent: false, commitId: oid(1) },
      { kind: "remote" as const, name: `origin/${LONG}`, invalidUtf8: false, objectId: oid(1), objectType: "commit" as const, peeledId: null, peeledType: null, symref: null, upstream: null, upstreamPresent: false, commitId: oid(1) },
      { kind: "tag" as const, name: `release/${LONG}`, invalidUtf8: false, objectId: oid(1), objectType: "commit" as const, peeledId: null, peeledType: null, symref: null, upstream: null, upstreamPresent: false, commitId: oid(1) },
    ],
    current: { name: LONG, objectId: oid(1) },
    completeness: { state: "complete" as const },
  };

  test("the badges and chips share one label region that takes at most half of the subject cell and clips at its edge", async () => {
    const host = await show(<HistoryView {...props} page={longPage} selected={null} refs={longRefs} />);
    const option = commits(host)[0]!;
    const labels = option.querySelector<HTMLElement>('[data-slot="row-labels"]')!;
    expect(labels !== null).toBe(true);
    expect(labels.className.split(/\s+/)).toEqual(expect.arrayContaining(["max-w-[50%]", "overflow-hidden", "min-w-0"]));
    expect([...labels.querySelectorAll(".badge")].map((b) => b.textContent)).toEqual(["HEAD", LONG]);
    expect(labels.querySelectorAll(".chip").length).toBeGreaterThan(0);
    // The subject sits outside the label region and keeps its own ellipsis.
    const subject = [...option.querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === "Change 1")!;
    expect(labels.contains(subject)).toBe(false);
    expect(subject.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
  });

  test("the current-branch badge name ends with an ellipsis beyond 160 DIPs, as a chip name does", async () => {
    const host = await show(<HistoryView {...props} page={longPage} selected={null} refs={longRefs} />);
    const badge = [...commits(host)[0]!.querySelectorAll<HTMLElement>(".badge")].find((b) => b.textContent === LONG)!;
    expect(badge.className.split(/\s+/)).toEqual(expect.arrayContaining(["max-w-[160px]", "truncate"]));
    expect(commits(host)[0]!.getAttribute("aria-label")!.startsWith(`HEAD, branch ${LONG}, remote-tracking: origin/${LONG}, tags: release/${LONG}, Change 1`)).toBe(true);
  });
});
