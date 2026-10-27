// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 T008: the branch card and the gone mark (spec FR-064 to FR-067, SC-008, plan.md D13, D15 "Branch card", D16, O-1).
// Stories US8 and US9. "Cut" is `scrollWidth > clientWidth` of the name element, so each case stubs both values.

import { afterEach, describe, expect, test } from "bun:test";
import { Unlink01Icon } from "@hugeicons/core-free-icons";
import { act, type ReactNode } from "react";
import type { RefEntry, RefsResult } from "../../src/contracts/envelope";
import type { BranchEntry } from "../../src/frontend/state/workbench";
import type { TrackLabel } from "../../src/frontend/state/tracking";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { hoverTooltip } from "./sync-fake";

printOrigin("../../src/frontend/branches/BranchCard.tsx", import.meta.dir);
printOrigin("../../src/frontend/branches/BranchButton.tsx", import.meta.dir);
printOrigin("../../src/frontend/refs/ReferencesSidebar.tsx", import.meta.dir);
printOrigin("../../src/frontend/components/ui/hover-card.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { HugeiconsIcon } = await import("@hugeicons/react");
const { ReferencesSidebar } = await import("../../src/frontend/refs/ReferencesSidebar");
const { BranchButton } = await import("../../src/frontend/branches/BranchButton");

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
async function show(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}
const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const wait = (ms: number) => act(async () => void (await new Promise((done) => setTimeout(done, ms))));
const settle = () => wait(0);

// Base UI PreviewCard `OPEN_DELAY` (preview-card/utils/constants.mjs).
const OPEN_DELAY = 600;

function stubCut(element: HTMLElement, cut: boolean) {
  Object.defineProperty(element, "clientWidth", { configurable: true, value: 100 });
  Object.defineProperty(element, "scrollWidth", { configurable: true, value: cut ? 240 : 100 });
}
async function hover(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseenter"));
    element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
}
async function leave(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseleave"));
  });
}
const focus = (element: HTMLElement) => act(async () => element.focus());
const press = (element: Element, key: string) => act(async () => void element.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true })));
const card = () => document.querySelector<HTMLElement>('[data-slot="hover-card-content"]:not([data-ending-style])');
const cardLines = () => [...card()!.children].map((c) => text(c));

const A = "a".repeat(40);
const B = "b".repeat(40);
// No `/`, so the row shows at the top level of the open Branches group.
const LONG = "redesign-the-login-page-with-password-strength-meter";
const ref = (kind: RefEntry["kind"], name: string, fields: Partial<RefEntry> = {}): RefEntry => ({ kind, name, invalidUtf8: false, objectId: A, objectType: "commit", peeledId: null, peeledType: null, symref: null, upstream: null, upstreamPresent: false, commitId: A, ...fields });
const REFS: RefsResult = {
  generation: 1,
  refs: [
    ref("branch", LONG, { upstream: `refs/remotes/origin/${LONG}`, upstreamPresent: true }),
    ref("branch", "fix-old-cache", { upstream: "refs/remotes/origin/fix-old-cache", upstreamPresent: false }),
    ref("branch", "main", { upstream: "refs/remotes/origin/main", upstreamPresent: true }),
    ref("branch", "removed-remote", { upstream: null }),
    ref("branch", "spike", { upstream: null }),
    // `readRefs` lists no refs/tags upstream as present for a branch, but the 003 track state counts it: no mark.
    ref("branch", "tagged", { upstream: "refs/tags/v1", upstreamPresent: false }),
    ref("remote", `origin/${LONG}`),
    ref("remote", "origin/main"),
  ],
  current: { name: "main", objectId: A },
  refsDigest: "0".repeat(64),
  completeness: { state: "complete" },
};
const TRACKING = new Map<string, TrackLabel>([
  [LONG, { text: "↑3 ↓1", label: "3 ahead, 1 behind", state: "counts" }],
  ["main", { text: "=", label: "0 ahead, 0 behind", state: "counts" }],
  ["tagged", { text: "=", label: "0 ahead, 0 behind", state: "counts" }],
  ["fix-old-cache", { text: "Upstream gone", label: "Upstream gone", state: "gone" }],
  ["spike", { text: "No upstream", label: "No upstream", state: "none" }],
  ["removed-remote", { text: "No upstream", label: "No upstream", state: "none" }],
]);
const entry = (kind: "local" | "remote", name: string, fields: Partial<BranchEntry> = {}): BranchEntry => ({ ref: `refs/${kind === "local" ? "heads" : "remotes"}/${name}`, kind, name, invalidUtf8: false, oid: B, upstream: null, tracking: null, heldBy: null, current: false, localName: null, upstreamPresent: false, ...fields });
const BRANCHES: BranchEntry[] = [
  entry("local", LONG, { upstream: `refs/remotes/origin/${LONG}`, upstreamPresent: true, heldBy: "C:/Repos/sample-repo-login" }),
  entry("local", "fix-old-cache", { upstream: "refs/remotes/origin/fix-old-cache", upstreamPresent: false }),
  entry("local", "main", { upstream: "refs/remotes/origin/main", upstreamPresent: true, current: true, heldBy: "C:/Repos/sample-repo" }),
  entry("local", "removed-remote"),
  entry("local", "spike"),
  // Contract Δ3: null is an unpaired tracking entry, so the gone state is unknown and no mark shows.
  entry("local", "unknown", { upstream: "refs/remotes/origin/unknown", upstreamPresent: null }),
  entry("remote", `origin/${LONG}`),
  entry("remote", "origin/main"),
];

// The sidebar has no bridge. Each callback counts as a call that the card must not start.
const calls: string[] = [];
let repositories = 0;
const sidebar = (fields: Record<string, unknown> = {}) =>
  show(
    <ReferencesSidebar
      refs={REFS}
      failure={null}
      onSelectCommit={async () => (calls.push("select"), "found" as const)}
      onRefresh={() => void calls.push("refresh")}
      onBranchAction={() => void calls.push("action")}
      repository={`t008-${++repositories}`}
      tracking={TRACKING}
      {...fields}
    />,
  );
const row = (host: HTMLElement, start: string) => {
  const found = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((i) => i.getAttribute("aria-label")!.startsWith(start));
  expect(found.length).toBe(1);
  return found[0]!;
};
const nameOf = (element: HTMLElement) => element.querySelector<HTMLElement>('[data-slot="ref-name"]')!;
async function openRemotes(host: HTMLElement) {
  await act(async () => row(host, "Remotes,").click());
  await act(async () => row(host, "origin, folder").click());
}

describe("the card shows only for a cut name (spec FR-065, US8-1, US8-2)", () => {
  test("a cut sidebar branch row shows the card on hover after the PreviewCard delay, and not before", async () => {
    const host = await sidebar();
    const target = row(host, `${LONG},`);
    stubCut(nameOf(target), true);
    await hover(target);
    await wait(OPEN_DELAY / 2);
    expect(card()).toBeNull();
    await wait(OPEN_DELAY / 2 + 100);
    expect(card()).not.toBeNull();
    expect(cardLines()[0]).toBe(LONG);
  });

  test("a cut sidebar branch row shows the card at once on keyboard focus, without motion", async () => {
    const host = await sidebar();
    const target = row(host, `${LONG},`);
    stubCut(nameOf(target), true);
    await focus(target);
    expect(card()).not.toBeNull();
    expect(card()!.hasAttribute("data-instant")).toBe(true);
  });

  test("a sidebar name that fits shows no card on hover and on focus", async () => {
    const host = await sidebar();
    const target = row(host, "spike,");
    stubCut(nameOf(target), false);
    await hover(target);
    await wait(OPEN_DELAY + 100);
    expect(card()).toBeNull();
    await focus(target);
    await wait(OPEN_DELAY + 100);
    expect(card()).toBeNull();
  });

  test("a cut sidebar remote row shows a card with only the full name (US8-4)", async () => {
    const host = await sidebar();
    await openRemotes(host);
    const target = row(host, `origin/${LONG},`);
    stubCut(nameOf(target), true);
    await focus(target);
    expect(cardLines()).toEqual([`origin/${LONG}`]);
  });
});

describe("card content (spec FR-066)", () => {
  test("a local branch card states the full name, the upstream, the counts of the 003 tracking state, and the other worktree that holds it", async () => {
    const host = await sidebar({ branches: BRANCHES });
    const target = row(host, `${LONG},`);
    stubCut(nameOf(target), true);
    await focus(target);
    expect(cardLines()).toEqual([LONG, `Upstream: origin/${LONG}`, "3 ahead, 1 behind", "Checked out in C:/Repos/sample-repo-login"]);
    expect(card()!.querySelector("code")?.textContent).toBe("C:/Repos/sample-repo-login");
  });

  test("without a loaded readBranches result, the card leaves out the worktree line", async () => {
    const host = await sidebar();
    const target = row(host, `${LONG},`);
    stubCut(nameOf(target), true);
    await focus(target);
    expect(cardLines()).toEqual([LONG, `Upstream: origin/${LONG}`, "3 ahead, 1 behind"]);
  });

  test("zero ahead and zero behind give Up to date, and the open worktree is no other worktree", async () => {
    const host = await sidebar({ branches: BRANCHES });
    const target = row(host, "main,");
    stubCut(nameOf(target), true);
    await focus(target);
    expect(cardLines()).toEqual(["main", "Upstream: origin/main", "Up to date"]);
  });

  test("the gone rule gives the gone line in place of the counts", async () => {
    const host = await sidebar();
    const target = row(host, "fix-old-cache,");
    stubCut(nameOf(target), true);
    await focus(target);
    expect(cardLines()).toEqual(["fix-old-cache", "Upstream: origin/fix-old-cache", "Upstream gone: origin/fix-old-cache no longer exists"]);
  });

  test("no upstream and a removed remote both state No upstream (US9-2, US9-3)", async () => {
    for (const name of ["spike", "removed-remote"]) {
      const host = await sidebar();
      const target = row(host, `${name},`);
      stubCut(nameOf(target), true);
      await focus(target);
      expect([name, cardLines()]).toEqual([name, [name, "No upstream"]]);
      await act(async () => target.blur());
    }
  });
});

describe("keys and names (spec FR-066, FR-067, US8-3)", () => {
  test("Escape closes the card, and the focus stays on the row", async () => {
    const host = await sidebar();
    const target = row(host, `${LONG},`);
    stubCut(nameOf(target), true);
    await focus(target);
    expect(card()).not.toBeNull();
    await press(target, "Escape");
    await settle();
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(target);
  });

  test("the row keeps its accessible name, and the card text is its accessible description while the card shows", async () => {
    const host = await sidebar();
    const target = row(host, `${LONG},`);
    const name = target.getAttribute("aria-label");
    // 001 plan.md "Icons": the counts tooltip text stays the description without the card.
    const closed = () => (target.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(closed()).toEqual(["Counts compare with the remote-tracking branch from the last fetch, not with the remote itself."]);
    stubCut(nameOf(target), true);
    await focus(target);
    expect(target.getAttribute("aria-label")).toBe(name);
    const described = (target.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id));
    expect(described).toContain(card());
    await press(target, "Escape");
    await settle();
    expect(closed()).toEqual(["Counts compare with the remote-tracking branch from the last fetch, not with the remote itself."]);
  });

  test("the card starts no bridge call and calls no sidebar callback", async () => {
    calls.length = 0;
    const host = await sidebar({ branches: BRANCHES });
    const target = row(host, `${LONG},`);
    stubCut(nameOf(target), true);
    await focus(target);
    await hover(target);
    await wait(OPEN_DELAY + 100);
    expect(card()).not.toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("the gone mark (spec FR-064, US9-1 to US9-3, plan.md O-1)", () => {
  const reference = async () => {
    const host = await show(<HugeiconsIcon icon={Unlink01Icon} strokeWidth={2} className="size-4" />);
    return host.querySelector("svg")!;
  };
  const paths = (svg: Element) => [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d"));
  const colors = (svg: Element) => [...svg.querySelectorAll("*"), svg].flatMap((e) => ["stroke", "fill", "color"].map((a) => e.getAttribute(a))).filter((v) => v !== null && v !== "none" && v !== "currentColor");

  test("a pruned upstream shows the Unlink01Icon mark at 16 px with currentColor and its tooltip; the name says upstream gone, and the visible upstream text stays", async () => {
    const host = await sidebar();
    const target = row(host, "fix-old-cache,");
    const mark = target.querySelector<HTMLElement>('[data-slot="gone-mark"]')!;
    expect(mark).not.toBeNull();
    expect(mark.hasAttribute("title")).toBe(false);
    expect(await hoverTooltip(mark)).toEqual(["The upstream origin/fix-old-cache no longer exists."]);
    const svg = mark.querySelector("svg")!;
    expect(paths(svg)).toEqual(paths(await reference()));
    expect(svg.getAttribute("class")?.split(" ")).toContain("size-4");
    expect(colors(svg)).toEqual([]);
    // The mark comes after the name.
    expect(nameOf(target).compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(target.getAttribute("aria-label")).toBe("fix-old-cache, local branch, → origin/fix-old-cache, upstream gone");
    expect(text(target)).toContain("→ origin/fix-old-cache");
    expect(text(target)).not.toContain("not present");
  });

  test("no upstream, a removed remote, a present upstream, a tag upstream that the 003 track state counts, and a remote row show no mark", async () => {
    const host = await sidebar();
    // Booleans only: a DOM node inside a failed toEqual makes Bun walk the whole DOM.
    for (const start of ["spike,", "removed-remote,", "main,", "tagged,", `${LONG},`]) expect([start, row(host, start).querySelector('[data-slot="gone-mark"]') !== null]).toEqual([start, false]);
    await openRemotes(host);
    expect(row(host, "origin/main,").querySelector('[data-slot="gone-mark"]')).toBeNull();
  });

  test("the card shows the mark on its gone line", async () => {
    const host = await sidebar();
    const target = row(host, "fix-old-cache,");
    stubCut(nameOf(target), true);
    await focus(target);
    const line = [...card()!.children].find((c) => text(c).startsWith("Upstream gone:"))!;
    expect(paths(line.querySelector("svg")!)).toEqual(paths(await reference()));
  });
});

// ---- The branch button and the branch list (004 FR-009) ----

type Actions = Parameters<typeof BranchButton>[0]["actions"];
function actions(entries: BranchEntry[] | null) {
  const used: string[] = [];
  const fake = { entries, failure: null, refresh: () => void used.push("refresh"), pick: () => void used.push("pick"), create: () => void used.push("create") } as unknown as Actions;
  return { fake, used };
}
const button = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="branch-button"]')!;
const branchButton = (fake: Actions, target = "refs/heads/main") =>
  show(<BranchButton headingHeight={24} head={{ state: "branch", target, oid: A }} operationState="normal" counts={{ text: "=", label: "Up to date", state: "counts" }} tracking={TRACKING} actions={fake} blockedReason={null} rowHeight={26} />);
const options = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const option = (name: string) => options().find((o) => o.getAttribute("aria-label")!.startsWith(`${name},`))!;
const listName = (element: HTMLElement) => element.querySelector<HTMLElement>('[data-slot="branch-name"]')!;

describe("the branch button (spec FR-065)", () => {
  // LONG is the current branch here. The open worktree holds it, so the card has no worktree line.
  const ON_LONG = BRANCHES.map((e) => ({ ...e, current: e.name === LONG }));

  test("a cut branch button shows the card of the current branch at once on keyboard focus, and Escape closes it with the focus kept", async () => {
    const { fake, used } = actions(ON_LONG);
    const host = await branchButton(fake, `refs/heads/${LONG}`);
    // The card and the hidden text carry the full name, so the name has no native title.
    expect(button(host).querySelector('[data-slot="branch-text"]')!.getAttribute("title")).toBeNull();
    stubCut(button(host).querySelector<HTMLElement>('[data-branch-part="last"]')!, true);
    await focus(button(host));
    expect(cardLines()).toEqual([LONG, `Upstream: origin/${LONG}`, "3 ahead, 1 behind"]);
    expect(button(host).getAttribute("aria-describedby")?.split(" ")).toContain(card()!.id);
    await press(button(host), "Escape");
    await settle();
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(button(host));
    expect(used).toEqual([]);
  });

  test("a cut branch button shows the card on hover after the PreviewCard delay; a name that fits shows none", async () => {
    const { fake } = actions(BRANCHES);
    const host = await branchButton(fake, `refs/heads/${LONG}`);
    const last = button(host).querySelector<HTMLElement>('[data-branch-part="last"]')!;
    // A browser fires mouseenter on each entered ancestor. The synthetic event goes to the trigger itself.
    const name = button(host).querySelector<HTMLElement>('[data-slot="branch-text"]')!;
    stubCut(last, false);
    await hover(name);
    await wait(OPEN_DELAY + 100);
    expect(card()).toBeNull();
    await leave(name);
    await wait(OPEN_DELAY);
    stubCut(last, true);
    await hover(name);
    await wait(OPEN_DELAY / 2);
    expect(card()).toBeNull();
    await wait(OPEN_DELAY / 2 + 100);
    expect(cardLines()[0]).toBe(LONG);
  });
});

describe("the branch list rows (spec FR-064, FR-065)", () => {
  async function openList(fake: Actions) {
    const host = await branchButton(fake);
    await act(async () => button(host).click());
    await settle();
    expect(options().length).toBeGreaterThan(0);
    return host;
  }

  test("a cut branch list row shows the card on hover after the delay, and a row that fits shows none", async () => {
    const { fake } = actions(BRANCHES);
    await openList(fake);
    stubCut(listName(option("spike")), false);
    await hover(listName(option("spike")));
    await wait(OPEN_DELAY + 100);
    expect(card()).toBeNull();
    stubCut(listName(option(LONG)), true);
    await hover(listName(option(LONG)));
    await wait(OPEN_DELAY / 2);
    expect(card()).toBeNull();
    await wait(OPEN_DELAY / 2 + 100);
    expect(cardLines()).toEqual([LONG, `Upstream: origin/${LONG}`, "3 ahead, 1 behind", "Checked out in C:/Repos/sample-repo-login"]);
  });

  test("the active option is the keyboard focus: a cut row shows its card at once and names it as its description", async () => {
    const { fake } = actions(BRANCHES);
    await openList(fake);
    // The list starts on its first option, the cut LONG row. Move away and back, so the measure runs on the stubbed layout.
    const field = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    stubCut(listName(option(LONG)), true);
    await press(field, "ArrowDown");
    await press(field, "ArrowUp");
    expect(option(LONG).getAttribute("aria-selected")).toBe("true");
    expect(card()).not.toBeNull();
    expect(option(LONG).getAttribute("aria-describedby")?.split(" ")).toContain(card()!.id);
    await press(field, "ArrowDown");
    await settle();
    expect(card()).toBeNull();
  });

  test("the gone mark shows after the name of a gone row only, and the row name says upstream gone", async () => {
    const { fake } = actions(BRANCHES);
    await openList(fake);
    const gone = option("fix-old-cache");
    const mark = gone.querySelector<HTMLElement>('[data-slot="gone-mark"]')!;
    expect(mark.hasAttribute("title")).toBe(false);
    expect(await hoverTooltip(mark)).toEqual(["The upstream origin/fix-old-cache no longer exists."]);
    expect(listName(gone).compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Contract Δ14: the 003 note "Upstream gone" stays visible, and the name says it once.
    expect(text(gone)).toContain("Upstream gone");
    expect(gone.getAttribute("aria-label")!.toLowerCase().split("upstream gone").length - 1).toBe(1);
    expect(gone.getAttribute("aria-label")).toContain(", upstream gone");
    // "unknown" has a null upstreamPresent: the tracking entry did not pair, so the state is unknown.
    for (const name of ["spike", "removed-remote", "main", "unknown", LONG, "origin/main"]) expect([name, option(name).querySelector('[data-slot="gone-mark"]') !== null]).toEqual([name, false]);
  });

  test("Escape closes an open card and keeps the branch list open; a second Escape closes the list", async () => {
    const { fake } = actions(BRANCHES);
    await openList(fake);
    const field = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    stubCut(listName(option(LONG)), true);
    await press(field, "ArrowDown");
    await press(field, "ArrowUp");
    expect(card()).not.toBeNull();
    await press(field, "Escape");
    await settle();
    expect(card()).toBeNull();
    expect(options().length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(field);
    await press(field, "Escape");
    await settle();
    expect(options()).toEqual([]);
  });

  test("the Upstream gone note and the gone mark keep their width, only the name cuts, and the card anchors to the option row (T069)", async () => {
    const { fake } = actions(BRANCHES);
    await openList(fake);
    const note = (name: string) => [...option(name).children].at(-1) as HTMLElement;
    const classes = note("fix-old-cache").className.split(" ");
    expect([classes.includes("shrink-0"), classes.includes("flex-1"), classes.includes("min-w-0")]).toEqual([true, false, false]);
    expect(listName(option("fix-old-cache")).className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(text(note("fix-old-cache"))).toBe("Upstream gone");
    // Feature 004 T116 keeps its rule: the name of a held row gets its width first, and the Open note shrinks first.
    expect(note(LONG).className.split(" ")).toEqual(expect.arrayContaining(["flex-1", "min-w-0", "truncate"]));
    expect(option("fix-old-cache").querySelector('[data-slot="gone-mark"]')!.className.split(" ")).toContain("shrink-0");
    // Plan.md D15 "Branch card": beside the row at its end edge, so the anchor is the option row.
    const rect = (left: number, right: number) => ({ x: left, y: 100, left, right, top: 100, bottom: 126, width: right - left, height: 26, toJSON: () => ({}) }) as DOMRect;
    const target = option("fix-old-cache");
    target.getBoundingClientRect = () => rect(0, 546);
    listName(target).getBoundingClientRect = () => rect(40, 300);
    stubCut(listName(target), true);
    await hover(listName(target));
    await wait(OPEN_DELAY + 100);
    expect(card()).not.toBeNull();
    // Floating UI sizes `--anchor-width` from the rectangle of the anchor: the row gives 546 px, the name span 260 px. happy-dom has no viewport for the side.
    expect(card()!.parentElement!.style.getPropertyValue("--anchor-width")).toBe("546px");
  });

  test("a cut remote row card shows only the full name", async () => {
    const { fake } = actions(BRANCHES);
    await openList(fake);
    stubCut(listName(option(`origin/${LONG}`)), true);
    await hover(listName(option(`origin/${LONG}`)));
    await wait(OPEN_DELAY + 100);
    expect(cardLines()).toEqual([`origin/${LONG}`]);
  });
});
