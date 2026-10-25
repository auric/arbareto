// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, itemLabel, mountWorkbench, oid, press, settings, settle, sizeSwitcherList, succeeded, text, unmountAll, type World } from "./sync-fake";
import { fixtureId } from "./bridge-contract";

// tasks.md T040 (feature 004, WP12). Stories US1 and US2. Spec FR-007 to FR-020, SC-003, SC-014. Plan D3, D4, D15, D16. Data-model §1, §3, §4. Contract Δ3, Δ9, Δ14.

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/branches/BranchButton.tsx", import.meta.dir);
printOrigin("../../src/frontend/branches/BranchActions.tsx", import.meta.dir);
printOrigin("../../src/frontend/branches/texts.ts", import.meta.dir);
printOrigin("../../src/frontend/refs/ReferencesSidebar.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");
const { refusalText } = await import("../../src/frontend/branches/texts");
const { metrics, workAreaHeight } = await import("../../src/frontend/layout/profiles");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
afterEach(async () => {
  await unmountAll();
  if (clipboard) Object.defineProperty(globalThis.navigator, "clipboard", clipboard);
  else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
});

const TOKEN = fixtureId(0x500);
type Entry = Record<string, unknown>;
// Data-model §1 entries. The service orders local entries first, each kind by `ref` bytes.
const local = (name: string, fields: Entry = {}): Entry => ({ ref: `refs/heads/${name}`, kind: "local", name, invalidUtf8: false, oid: oid(4), upstream: null, tracking: null, heldBy: null, current: false, localName: null, ...fields });
const remote = (name: string, fields: Entry = {}): Entry => ({ ref: `refs/remotes/${name}`, kind: "remote", name, invalidUtf8: false, oid: oid(9), upstream: null, tracking: null, heldBy: null, current: false, localName: null, ...fields });
const MAIN = local("main", { oid: oid(1), upstream: "refs/remotes/origin/main", current: true });
const LOGIN = local("login-form");
const SIGNUP = local("signup", { heldBy: "C:\\wt\\sample-signup", upstream: "refs/remotes/origin/signup" });
const ORIGIN_MAIN = remote("origin/main");
const ORIGIN_LOGIN = remote("origin/login-page", { localName: "login-page" });
const ENTRIES = [LOGIN, MAIN, SIGNUP, ORIGIN_LOGIN, ORIGIN_MAIN];

type Plan = Record<string, unknown>;
const switchPlan = (fields: Plan = {}): Plan => ({ target: { local: "refs/heads/login-form" }, trackedChanges: 0, unreachable: null, heldBy: null, choice: "keep", inTheWay: null, ...fields });
const reviewed = (action: string, plan: Plan) => succeeded({ action, plan, workbenchToken: TOKEN });
const switched = succeeded({ action: "switch", head: { state: "branch", target: "refs/heads/login-form", oid: oid(4) }, refs: [], stash: null, conflicted: 0 });

/** A world with the branches of `ENTRIES`. `review` answers each `reviewWorkbench` payload. */
function branchWorld(review: (payload: Record<string, unknown>) => unknown = (p) => reviewed("switch", switchPlan({ choice: p.choice })), fields: Partial<World> = {}): World {
  const world = createWorld({
    branches: [
      { name: "login-form", objectId: oid(4), upstream: null, upstreamObjectId: null, track: { state: "none" }, current: false },
      { name: "main", objectId: oid(1), upstream: "refs/remotes/origin/main", upstreamObjectId: oid(9), track: { state: "counts", ahead: 2, behind: 3 }, current: true },
      { name: "signup", objectId: oid(4), upstream: "refs/remotes/origin/signup", upstreamObjectId: oid(9), track: { state: "counts", ahead: 0, behind: 0 }, current: false },
    ],
    remotes: [
      { name: "origin/login-page", objectId: oid(9) },
      { name: "origin/main", objectId: oid(9) },
      { name: "origin/signup", objectId: oid(9) },
    ],
    ...fields,
  });
  world.answers.readBranches = () => succeeded({ entries: ENTRIES });
  world.answers.reviewWorkbench = (args) => review(args[1] as Record<string, unknown>);
  world.answers.runWorkbench = () => switched;
  return world;
}

const branchButton = () => document.querySelector<HTMLElement>('header [data-slot="branch-button"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Branches"] [role="option"]')];
const filterField = () => document.querySelector<HTMLInputElement>('input[aria-label="Find a branch"]')!;
const reviews = (double: { calls: { operation: string; args: unknown[] }[] }) => double.calls.filter((c) => c.operation === "reviewWorkbench").map((c) => c.args[1] as Record<string, unknown>);
const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]:not([data-closed])') ?? document.querySelector<HTMLElement>('[role="dialog"]');
const openMenuItems = () => [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-content"] [role="menuitem"]')];
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function openList() {
  await click(branchButton()!);
}
/** A sidebar row by the start of its accessible name. The filter opens the folders on its path. */
async function sidebarRow(name: string): Promise<HTMLElement> {
  const toggle = document.querySelector<HTMLElement>('button[aria-label="Show references"]');
  if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
  await type(document.querySelector<HTMLInputElement>('input[aria-label="Filter references"]')!, name);
  const found = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((e) => (e.getAttribute("aria-label") ?? "").startsWith(`${name},`));
  if (found.length !== 1) throw new Error(`expected one sidebar row "${name}", found ${found.length}`);
  return found[0]!;
}
async function contextMenu(element: Element) {
  await act(async () => void element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await settle();
}
async function doubleClick(element: Element) {
  await act(async () => void element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
  await settle();
}
const radio = (label: string) => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => text(r.closest("label") ?? r).startsWith(label));

describe("branch button (FR-007)", () => {
  test("it shows the current branch with the 003 counts", async () => {
    await mountWorkbench(workbench, branchWorld());
    const b = branchButton();
    expect(b).not.toBeNull();
    expect(text(b!)).toContain("main");
    expect(text(b!)).toContain("↑2 ↓3");
    expect(b!.getAttribute("aria-label")).toBe("main, 2 ahead, 3 behind");
  });

  test("a detached HEAD shows Detached at <short ID>", async () => {
    await mountWorkbench(workbench, branchWorld(undefined, { head: { state: "detached", oid: oid(1) } }));
    expect(text(branchButton()!)).toContain(`Detached at ${oid(1).slice(0, 12)}`);
  });

  test("during a merge it shows Merging, and the list states why the switch is unavailable", async () => {
    const double = await mountWorkbench(workbench, branchWorld(undefined, { operationState: "merging" }));
    expect(text(branchButton()!)).toContain("Merging");
    await openList();
    expect(text(popup()!)).toContain("A merge or a rebase is in progress.");
    expect(options()).toHaveLength(0);
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("during a merge, the inline sync reason line takes only the width that the branch button leaves (plan.md D15 Top bar row)", async () => {
    await mountWorkbench(workbench, branchWorld(undefined, { operationState: "merging" }));
    const group = document.querySelector<HTMLElement>('header [role="group"][aria-label="Remote sync"]')!;
    const line = [...group.querySelectorAll<HTMLElement>("[title]")].find((e) => (e.getAttribute("title") ?? "").includes("A merge or a rebase is in progress."));
    expect(line).toBeDefined();
    expect(text(line!)).toBe("Pull, Push: A merge or a rebase is in progress. Finish it with Mark resolved and the actions in the Notices band.");
    // `contain: inline-size` gives the reason no content width, so it never claims the width of the branch text. The control names stay whole.
    const [names, reason] = [...line!.children] as HTMLElement[];
    expect(text(names!)).toBe("Pull, Push:");
    expect(names!.className.split(" ")).toContain("shrink-0");
    expect(reason!.style.getPropertyValue("contain")).toBe("inline-size");
    expect(Number(reason!.style.flexGrow)).toBeGreaterThan(0);
    // The branch text counts in the width of the branch button: a zero flex basis gave it no width.
    expect(document.querySelector<HTMLElement>('header [data-slot="branch-text"]')!.style.flexBasis).toBe("auto");
    // T115: the button itself keeps its text width in one row too. A zero basis left it 18 DIPs at 960 DIPs. The header wraps instead.
    expect(branchButton()!.style.flexBasis).toBe("auto");
    expect(document.querySelector("header")!.className.split(/\s+/)).toContain("flex-wrap");
    // The branch button grows first, up to its text width. The sync group takes the rest.
    const wrapper = group.parentElement!;
    expect(Number(wrapper.style.flexGrow)).toBeGreaterThan(0);
    expect(Number(branchButton()!.style.flexGrow)).toBeGreaterThanOrEqual(1000 * Number(wrapper.style.flexGrow));
  });

  test("a narrow branch button keeps the branch name first: the counts shrink first and end with an ellipsis, and the hidden text and the accessible name hold the full text (T112)", async () => {
    await mountWorkbench(workbench, branchWorld());
    const b = branchButton()!;
    const counts = b.querySelector<HTMLElement>('[data-slot="branch-counts"]')!;
    expect(text(counts)).toBe("↑2 ↓3");
    // T115: a zero minimum let the counts vanish without an ellipsis. One em keeps the ellipsis while the branch name shrinks.
    expect(counts.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-[1em]", "truncate", "shrink-[1000]"]));
    expect(counts.getAttribute("title")).toBe("2 ahead, 3 behind");
    const name = b.querySelector<HTMLElement>('[data-slot="branch-text"]')!;
    expect(name.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(b.getAttribute("aria-label")).toBe("main, 2 ahead, 3 behind");
    // Feature 005: the branch card and the hidden text hold the full name in place of the native title.
    expect(name.getAttribute("title")).toBeNull();
    expect(name.querySelector(".sr-only")!.textContent).toBe("main");
  });

  test("a rebase shows Rebasing", async () => {
    await mountWorkbench(workbench, branchWorld(undefined, { operationState: "rebasing" }));
    expect(text(branchButton()!)).toContain("Rebasing");
  });
});

describe("branch list (FR-008, FR-009, FR-013, SC-003)", () => {
  for (const [name, response, sentence] of [
    ["a failed readBranches names its code", { requestId: fixtureId(0x530), state: "failed", code: "GIT_FAILED" }, "Arbareto cannot read the branches: GIT_FAILED."],
    ["a succeeded readBranches of unknown form names the unknown form (plan D15)", succeeded({}), "The branches did not load: the result has an unknown form."],
  ] as const) {
    test(name, async () => {
      const world = branchWorld();
      world.answers.readBranches = () => response;
      await mountWorkbench(workbench, world);
      await openList();
      expect(text(popup()!)).toContain(sentence);
    });
  }

  test("the list shows local then remote branches, gives the filter the first focus, and ends with New branch… (Ctrl+B)", async () => {
    await mountWorkbench(workbench, branchWorld());
    await openList();
    expect(document.activeElement).toBe(filterField());
    const names = options().map((o) => o.getAttribute("aria-label") ?? text(o));
    expect(names.slice(0, 5).map((n) => n.split(",")[0])).toEqual(["login-form", "main", "signup", "origin/login-page", "origin/main"]);
    expect(options().at(-1)!.getAttribute("aria-label")).toBe("New branch… (Ctrl+B)");
    // The current branch is bold, without the word Current.
    const main = options()[1]!;
    expect(main.querySelector(".font-semibold")?.textContent).toBe("main");
    expect(text(main)).not.toContain("Current");
  });

  test("the option of the current branch states current after the branch name (plan D15 Branch list)", async () => {
    await mountWorkbench(workbench, branchWorld());
    await openList();
    const names = options().map((o) => o.getAttribute("aria-label"));
    expect(names[1]!.startsWith("main, current, local branch, 2 ahead, 3 behind")).toBe(true);
    expect(names.filter((n) => n?.includes(", current,"))).toHaveLength(1);
  });

  test("the group headings scale with the text size and the density, as the rows do, also in the virtual list (225% text)", async () => {
    const m = metrics("compact", 2.25);
    await mountWorkbench(workbench, branchWorld(), undefined, { textScale: 2.25 });
    await openList();
    const headings = [...document.querySelectorAll<HTMLElement>('[data-slot="list-heading"]')];
    expect(headings).toHaveLength(2);
    for (const heading of headings) expect(heading.style.height).toBe(`${m.subgroupHeading}px`);
    await unmountAll();
    // Above 200 rows the list is virtual. Its size estimate counts each heading at the heading height and each option at the row height.
    const many = Array.from({ length: 260 }, (_, i) => local(`topic/${String(i).padStart(3, "0")}`));
    const world = branchWorld();
    world.answers.readBranches = () => succeeded({ entries: [MAIN, ...many, ORIGIN_MAIN] });
    await mountWorkbench(workbench, world, undefined, { textScale: 2.25 });
    await openList();
    const total = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Branches"] > [role="presentation"]')!;
    // Two headings, 262 branches, and New branch….
    expect(total.style.height).toBe(`${2 * m.subgroupHeading + 263 * m.row}px`);
  });

  test("the list follows the D16 geometry: search icon and placeholder, Muted group counts, the current mark, the key column, and 380 px aligned to the button's end (T088)", async () => {
    await mountWorkbench(workbench, branchWorld());
    await openList();
    const field = filterField();
    expect(field.getAttribute("placeholder")).toBe("Find a branch");
    const icon = field.parentElement!.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    // The headings: "Local branches <n>" and "Remote branches <n>" with the count in Muted text, and the groups named "<heading>, <n>".
    const headings = [...document.querySelectorAll<HTMLElement>('[data-slot="list-heading"]')];
    expect(headings.map(text)).toEqual(["Local branches 3", "Remote branches 2"]);
    for (const heading of headings) expect(heading.querySelector('[data-slot="list-count"]')?.className.split(/\s+/)).toContain("text-muted-text");
    const group = (name: string) => [...document.querySelectorAll<HTMLElement>(`[role="listbox"][aria-label="Branches"] [role="group"][aria-label="${name}"] [role="option"]`)].map((o) => (o.getAttribute("aria-label") ?? "").split(",")[0]);
    expect(group("Local branches, 3")).toEqual(["login-form", "main", "signup"]);
    expect(group("Remote branches, 2")).toEqual(["origin/login-page", "origin/main"]);
    // The current branch shows a check mark that assistive technology skips.
    const marks = options().map((o) => o.querySelector('[data-slot="current-mark"]'));
    expect(marks.map((m) => m?.querySelector("svg") !== null && m?.querySelector("svg") !== undefined)).toEqual([false, true, false, false, false, false]);
    expect(marks[1]!.getAttribute("aria-hidden")).toBe("true");
    // "New branch… (Ctrl+B)" shows its key in a right-aligned Muted column.
    const footer = options().at(-1)!;
    expect(footer.getAttribute("aria-keyshortcuts")).toBe("Control+B");
    const key = footer.querySelector<HTMLElement>('[data-slot="option-key"]')!;
    expect(text(key)).toBe("Ctrl+B");
    expect(key.getAttribute("aria-hidden")).toBe("true");
    expect(key.className.split(/\s+/)).toEqual(expect.arrayContaining(["ml-auto", "text-muted-text"]));
    expect(text(popup()!)).not.toContain("Manage branches");
    // The popover is 380 px wide and aligned to the end of the branch button.
    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
    expect(content.className).toContain("w-[min(380px,calc(100vw-32px))]");
    expect(content.getAttribute("data-align")).toBe("end");
  });

  test("No upstream shows in the list and in the accessible names, and never as visible sidebar text (FR-008, 003 FR-020)", async () => {
    await mountWorkbench(workbench, branchWorld());
    await openList();
    const login = options()[0]!;
    expect(text(login)).toContain("No upstream");
    expect(login.getAttribute("aria-label")).toContain("No upstream");
    await press(filterField(), "Escape");
    const row = await sidebarRow("login-form");
    expect(row.getAttribute("aria-label")).toContain("No upstream");
    expect(text(row)).not.toContain("No upstream");
  });

  // Feature 005 T011, spec FR-066: the Workbench passes the newest `readBranches` entries to the sidebar card.
  test("the branch card of a cut sidebar row names the other worktree that holds the branch", async () => {
    await mountWorkbench(workbench, branchWorld());
    const row = await sidebarRow("signup");
    const name = row.querySelector<HTMLElement>('[data-slot="ref-name"]')!;
    Object.defineProperty(name, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(name, "scrollWidth", { configurable: true, value: 240 });
    await act(async () => row.focus());
    const card = document.querySelector<HTMLElement>('[data-slot="hover-card-content"]');
    expect(text(card!)).toContain("Checked out in C:\\wt\\sample-signup");
  });

  test("open, type, and Enter switch to the first match on a clean tree: three inputs (SC-003)", async () => {
    const double = await mountWorkbench(workbench, branchWorld());
    await openList();
    await type(filterField(), "LOG");
    expect(options().map((o) => (o.getAttribute("aria-label") ?? text(o)).split(",")[0])).toEqual(["login-form", "origin/login-page", "New branch… (Ctrl+B)"]);
    await press(filterField(), "Enter");
    await settle();
    expect(reviews(double)).toEqual([{ action: "switch", target: { ref: "refs/heads/login-form" }, choice: "keep" }]);
    expect(double.calls.find((c) => c.operation === "runWorkbench")?.args[1]).toEqual({ workbenchToken: TOKEN, start: true });
    // The confirmation never opened.
    expect(text(document.body)).not.toContain("Switch to login-form?");
  });

  test("a branch that another worktree holds offers Open <worktree> instead of a switch", async () => {
    const world = branchWorld();
    world.answers.openWorktree = () => succeeded({});
    const double = await mountWorkbench(workbench, world);
    await openList();
    const signup = options()[2]!;
    expect(text(signup)).toContain("Open C:\\wt\\sample-signup");
    await click(signup);
    expect(double.calls.find((c) => c.operation === "openWorktree")?.args[0]).toEqual({ repositoryId: fixtureId(1), path: "C:\\wt\\sample-signup" });
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("in a held branch row, the branch name gets its width first, and the Open <worktree> note shrinks first (T116, plan D15 Rows)", async () => {
    await mountWorkbench(workbench, branchWorld());
    await openList();
    const signup = options()[2]!;
    const note = [...signup.querySelectorAll<HTMLElement>("[title]")].find((s) => s.title === "Open C:\\wt\\sample-signup")!;
    // A zero basis: the note takes only the width that the name leaves, so the name never shrinks for it.
    expect(note.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex-1", "min-w-0", "truncate"]));
    const name = [...signup.querySelectorAll("span")].find((s) => s.textContent === "signup")!;
    expect(name.className.split(/\s+/)).not.toContain("flex-1");
    expect(signup.getAttribute("aria-label")).toContain("Open C:\\wt\\sample-signup");
  });

  test("an Open <worktree> that ends UNKNOWN_TARGET shows the D15 worktree text, not the raw code", async () => {
    const world = branchWorld();
    world.answers.openWorktree = () => ({ requestId: fixtureId(0x5fe), state: "failed", code: "UNKNOWN_TARGET", result: {} });
    await mountWorkbench(workbench, world);
    await openList();
    await click(options()[2]!);
    expect(text(document.body)).toContain("Arbareto cannot match this worktree with a fresh worktree list.");
    expect(text(document.body)).not.toContain("UNKNOWN_TARGET");
  });

  test("a remote branch opens the panel with Create local branch and its refspec name, and Check out the commit only", async () => {
    const double = await mountWorkbench(workbench, branchWorld((p) => reviewed("switch", switchPlan({ target: p.target, choice: p.choice }))));
    await openList();
    await click(options()[3]!);
    expect(double.count("reviewWorkbench")).toBe(0);
    expect(text(popup()!)).toContain("Switch to origin/login-page?");
    expect(radio("Create local branch")?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Branch name"]')?.value).toBe("login-page");
    expect(radio("Check out the commit only")).toBeDefined();
    await click(radio("Check out the commit only")!);
    expect(text(popup()!)).toContain("No branch. New commits belong to no branch (detached HEAD).");
    await click(radio("Create local branch")!);
    await click(button("Create and switch"));
    expect(reviews(double)[0]).toEqual({ action: "switch", target: { track: { ref: "refs/remotes/origin/login-page", name: "login-page" } }, choice: "keep" });
  });
});

describe("switch confirmation (FR-009 to FR-011)", () => {
  test("a double-click in the sidebar always opens Switch to <branch>? next to the row with Cancel focused, also on a clean tree", async () => {
    const double = await mountWorkbench(workbench, branchWorld());
    await doubleClick(await sidebarRow("login-form"));
    expect(text(popup()!)).toContain("Switch to login-form?");
    expect(text(document.activeElement!)).toBe("Cancel");
    expect(double.count("runWorkbench")).toBe(0);
    await click(button("Switch"));
    expect(double.count("runWorkbench")).toBe(1);
  });

  test("tracked changes show the count and three choices, the stored switchChoice preselects, and Discard changes the button and states FR-011", async () => {
    const world = branchWorld((p) => reviewed("switch", switchPlan({ trackedChanges: 4, choice: p.choice })));
    world.answers.readSyncSettings = () => succeeded({ ...settings("pull"), switchChoice: "stash" });
    const double = await mountWorkbench(workbench, world);
    await doubleClick(await sidebarRow("login-form"));
    expect(reviews(double)[0]!.choice).toBe("stash");
    const shown = text(popup()!);
    expect(shown).toContain("You have 4 changes to tracked files.");
    expect(shown).toContain("Default");
    for (const label of ["Keep changes", "Stash and reapply", "Discard changes"]) expect(radio(label)).toBeDefined();
    expect(radio("Stash and reapply")!.checked).toBe(true);
    expect(radio("Discard changes")!.checked).toBe(false);
    expect(shown).not.toContain("Don't ask again");
    await click(radio("Discard changes")!);
    expect(buttons("Discard and switch")).toHaveLength(1);
    expect(text(popup()!)).toContain("Delete changes to tracked files. Untracked files stay. You cannot undo this.");
    await click(button("Discard and switch"));
    expect(reviews(double).at(-1)!.choice).toBe("discard");
    expect(double.count("runWorkbench")).toBe(1);
  });

  test("an untracked file in the way refuses Discard and names the file", async () => {
    const world = branchWorld((p) => (p.choice === "discard" ? { requestId: fixtureId(0x5ff), state: "rejected", code: "UNTRACKED_IN_WAY", result: { reason: "untracked-in-way", paths: ["build/out.txt"], more: 0 } } : reviewed("switch", switchPlan({ trackedChanges: 1, choice: p.choice }))));
    const double = await mountWorkbench(workbench, world);
    await doubleClick(await sidebarRow("login-form"));
    await click(radio("Discard changes")!);
    await click(button("Discard and switch"));
    expect(text(popup()!)).toContain("build/out.txt");
    expect(double.count("runWorkbench")).toBe(0);
  });
});

describe("a changed review before the run (FR-011, data safety)", () => {
  test("a Discard switch whose new review finds other tracked changes shows the new plan and does not run", async () => {
    let tracked = 1;
    const double = await mountWorkbench(workbench, branchWorld((p) => reviewed("switch", switchPlan({ trackedChanges: tracked, choice: p.choice }))));
    await doubleClick(await sidebarRow("login-form"));
    expect(text(popup()!)).toContain("You have 1 change to tracked files.");
    await click(radio("Discard changes")!);
    tracked = 5;
    await click(button("Discard and switch"));
    expect(reviews(double).at(-1)!.choice).toBe("discard");
    expect(double.count("runWorkbench")).toBe(0);
    expect(text(popup()!)).toContain("You have 5 changes to tracked files.");
    expect(radio("Discard changes")!.checked).toBe(true);
    await click(button("Discard and switch"));
    expect(double.count("runWorkbench")).toBe(1);
  });

  test("a new review that finds an unreachable commit shows it before the run", async () => {
    let unreachable: string | null = null;
    const double = await mountWorkbench(workbench, branchWorld((p) => reviewed("switch", switchPlan({ trackedChanges: 2, unreachable, choice: p.choice }))));
    await doubleClick(await sidebarRow("login-form"));
    await click(radio("Discard changes")!);
    unreachable = oid(7);
    await click(button("Discard and switch"));
    expect(double.count("runWorkbench")).toBe(0);
    expect(text(popup()!)).toContain(`Commit ${oid(7).slice(0, 12)} is on no branch.`);
  });

  test("after a failed readSyncSettings, no choice shows the Default tag", async () => {
    const world = branchWorld((p) => reviewed("switch", switchPlan({ trackedChanges: 2, choice: p.choice })));
    world.answers.readSyncSettings = () => ({ requestId: fixtureId(0x520), state: "rejected", code: "SERVICE_UNAVAILABLE" });
    await mountWorkbench(workbench, world);
    await doubleClick(await sidebarRow("login-form"));
    expect(text(popup()!)).toContain("You have 2 changes to tracked files.");
    expect(text(popup()!)).not.toContain("Default");
  });
});

describe("keys during IME composition and the keyboard path to the history labels", () => {
  test("Ctrl+. during an IME composition does nothing on a branch row", async () => {
    const double = await mountWorkbench(workbench, branchWorld());
    const row = await sidebarRow("login-form");
    await act(async () => row.focus());
    await press(row, ".", { ctrlKey: true, isComposing: true });
    expect(double.count("reviewWorkbench")).toBe(0);
  });

  test("Ctrl+B during an IME composition does nothing on a history row", async () => {
    await mountWorkbench(workbench, branchWorld());
    const row = document.querySelector('[data-slot="row-labels"] .chip[data-kind="branch"]')!.closest<HTMLElement>('[role="option"]')!;
    await click(row);
    const list = row.closest<HTMLElement>('[role="listbox"]')!;
    await press(list, "b", { ctrlKey: true, isComposing: true });
    expect(document.querySelector('input[aria-label="Branch name"]')).toBeNull();
    await press(list, "b", { ctrlKey: true });
    expect(document.querySelector('input[aria-label="Branch name"]')).not.toBeNull();
  });

  for (const [name, init] of [
    ["Shift+F10", { key: "F10", shiftKey: true }],
    ["the Menu key", { key: "ContextMenu" }],
  ] as const) {
    test(`${name} on a history row opens the branch menu of its branch label`, async () => {
      await mountWorkbench(workbench, branchWorld());
      const chip = document.querySelector<HTMLElement>('[data-slot="row-labels"] .chip[data-kind="branch"]')!;
      const row = chip.closest<HTMLElement>('[role="option"]')!;
      await click(row);
      await press(row.closest('[role="listbox"]')!, init.key, init);
      expect(openMenuItems().map(itemLabel)[0]).toBe("Switch");
      expect(document.querySelector('[data-slot="dropdown-menu-content"]')!.getAttribute("aria-label")).toBe(`Actions for ${text(chip.querySelector("[data-chip-name]")!)}`);
    });

    test(`${name} on a sidebar branch row moves the focus to the first menu item, so the focus outline shows (D16)`, async () => {
      await mountWorkbench(workbench, branchWorld());
      const row = await sidebarRow("login-form");
      await act(async () => row.focus());
      await press(row, init.key, init);
      await settle();
      expect(document.activeElement).toBe(openMenuItems()[0]!);
    });

    test(`${name} on a history row moves the focus to the first menu item, so the focus outline shows (D16)`, async () => {
      await mountWorkbench(workbench, branchWorld());
      const row = document.querySelector('[data-slot="row-labels"] .chip[data-kind="branch"]')!.closest<HTMLElement>('[role="option"]')!;
      await click(row);
      await press(row.closest('[role="listbox"]')!, init.key, init);
      await settle();
      expect(document.activeElement).toBe(openMenuItems()[0]!);
    });
  }
});

describe("the menu of each label on a History row with several branch labels (FR-014, SC-014, T101)", () => {
  /** A world whose row 0 carries the labels `main` and `feature/login`, and whose row 1 carries `old`. */
  function labelsWorld(): World {
    const world = branchWorld();
    world.branches = [
      { name: "feature/login", objectId: oid(1), upstream: null, upstreamObjectId: null, track: { state: "none" }, current: false },
      { name: "main", objectId: oid(1), upstream: null, upstreamObjectId: null, track: { state: "none" }, current: true },
      { name: "old", objectId: oid(2), upstream: null, upstreamObjectId: null, track: { state: "none" }, current: false },
    ];
    world.answers.readBranches = () => succeeded({ entries: [local("feature/login", { oid: oid(1) }), local("main", { oid: oid(1), current: true }), local("old", { oid: oid(2) })] });
    return world;
  }
  const historyList = () => document.querySelector<HTMLElement>("[data-history-list]")!;
  const menuName = () => document.querySelector('[data-slot="dropdown-menu-content"]')?.getAttribute("aria-label") ?? null;
  const activeChip = () => [...document.querySelectorAll<HTMLElement>('[data-slot="row-labels"] .chip[data-label-active]')].map((c) => text(c.querySelector("[data-chip-name]")!));
  const status = () => text(historyList().parentElement!.querySelector('p[role="status"]')!);
  async function selectRow0() {
    const chip = [...document.querySelectorAll<HTMLElement>('[data-slot="row-labels"] .chip[data-kind="branch"]')].find((c) => text(c.querySelector("[data-chip-name]")!) === "main")!;
    await click(chip.closest<HTMLElement>('[role="option"]')!);
    await act(async () => historyList().focus());
  }

  test("Right and Left move the active label, and Shift+F10 opens the menu of the active label; the list stays one Tab stop", async () => {
    await mountWorkbench(workbench, labelsWorld());
    await selectRow0();
    const list = historyList();
    // The row orders its labels as Git lists them: `feature/login`, then `main`.
    const names = [...document.querySelectorAll<HTMLElement>('[data-row-id] [data-slot="row-labels"] .chip[data-kind="branch"]')].slice(0, 2).map((c) => text(c.querySelector("[data-chip-name]")!));
    expect(names).toEqual(["feature/login", "main"]);
    await press(list, "F10", { shiftKey: true });
    expect(menuName()).toBe("Actions for feature/login");
    await press(document.activeElement!, "Escape");
    await act(async () => list.focus());
    await press(list, "ArrowRight");
    expect(activeChip()).toEqual(["main"]);
    expect(status()).toContain("main, branch label 2 of 2.");
    expect(document.activeElement).toBe(list);
    await press(list, "ContextMenu");
    expect(menuName()).toBe("Actions for main");
    await press(document.activeElement!, "Escape");
    await act(async () => list.focus());
    // Right stops at the last label. Left goes back to the first one.
    await press(list, "ArrowRight");
    expect(activeChip()).toEqual(["main"]);
    await press(list, "ArrowLeft");
    expect(activeChip()).toEqual(["feature/login"]);
    await press(list, "F10", { shiftKey: true });
    expect(menuName()).toBe("Actions for feature/login");
    // No label is a Tab stop.
    for (const chip of document.querySelectorAll('[data-slot="row-labels"] .chip')) expect(chip.hasAttribute("tabindex")).toBe(false);
  });

  test("a new selected row starts at its first label", async () => {
    await mountWorkbench(workbench, labelsWorld());
    await selectRow0();
    const list = historyList();
    await press(list, "ArrowRight");
    expect(activeChip()).toEqual(["main"]);
    await press(list, "ArrowDown");
    expect(activeChip()).toEqual([]);
    await press(list, "ArrowUp");
    await press(list, "F10", { shiftKey: true });
    expect(menuName()).toBe("Actions for feature/login");
  });
});

describe("virtual branch list (FR-086, SC-007, T100)", () => {
  // The case presses 253 keys over 252 options in happy-dom: about 2.3 s alone and up to 5 s in a loaded run, near the 5 s Bun default.
  test("more than 200 branches create only the options near the view, the arrow keys reach the last option, and each option states its position and set size", async () => {
    const restore = sizeSwitcherList(300);
    try {
      const names = Array.from({ length: 250 }, (_, i) => `b${String(i).padStart(3, "0")}`);
      const world = branchWorld();
      world.answers.readBranches = () => succeeded({ entries: [...names.map((n) => local(n)), ORIGIN_MAIN] });
      await mountWorkbench(workbench, world);
      await openList();
      const bounded = () => expect(options().length).toBeLessThan(60);
      bounded();
      const field = filterField();
      const active = () => document.getElementById(field.getAttribute("aria-activedescendant") ?? "");
      const place = (o: Element | null) => [o?.getAttribute("aria-label")?.split(",")[0], o?.getAttribute("aria-posinset"), o?.getAttribute("aria-setsize")];
      expect(place(active())).toEqual(["b000", "1", "250"]);
      // 250 local branches, 1 remote branch, and New branch… make 252 options.
      for (let i = 0; i < 251; i++) await act(async () => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
      await settle();
      expect(place(active())).toEqual(["New branch… (Ctrl+B)", "1", "1"]);
      bounded();
      await press(field, "ArrowUp");
      expect(place(active())).toEqual(["origin/main", "1", "1"]);
      await press(field, "ArrowUp");
      expect(place(active())).toEqual(["b249", "250", "250"]);
      expect(active()!.closest('[role="group"]')?.getAttribute("aria-label")).toBe("Local branches, 250");
      bounded();
    } finally {
      restore();
    }
  }, 30_000);
});

function buttons(label: string) {
  return [...document.querySelectorAll<HTMLElement>("button")].filter((b) => (b.getAttribute("aria-label") ?? text(b)) === label);
}

describe("branch context menu (FR-014, FR-017, FR-020, 002 FR-049)", () => {
  test("a local branch menu holds the FR-014 items in order, each named by its label only, with its key", async () => {
    await mountWorkbench(workbench, branchWorld());
    await contextMenu(await sidebarRow("login-form"));
    const items = openMenuItems();
    expect(items.map(itemLabel)).toEqual(["Switch", "Merge into current branch (main)…", "Rebase current branch (main) onto login-form…", "Create branch here…", "Rename…", "Delete…", "Push", "Copy branch name"]);
    expect(items.map((i) => i.getAttribute("aria-keyshortcuts"))).toEqual(["Control+.", "Control+M", "Control+Shift+E", "Control+B", "F2", "Delete", null, null]);
    for (const item of items) expect(item.hasAttribute("aria-label")).toBe(false);
    for (const key of document.querySelectorAll('[data-slot="dropdown-menu-content"] [data-slot$="shortcut"]')) expect(key.getAttribute("aria-hidden")).toBe("true");
    // Push on another branch stays focusable and states its reason.
    const push = items[6]!;
    expect(text(document.getElementById(push.getAttribute("aria-describedby")!)!)).toBe("Push sends the current branch only.");
  });

  test("the menu groups and icons follow D16, with a separator between groups (T089)", async () => {
    const groups = () =>
      [...document.querySelectorAll('[data-slot="dropdown-menu-content"] [data-slot="dropdown-menu-group"]')].map((g) => [...g.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(itemLabel));
    const separators = () => document.querySelectorAll('[data-slot="dropdown-menu-content"] [data-slot="dropdown-menu-separator"]').length;
    await mountWorkbench(workbench, branchWorld());
    await contextMenu(await sidebarRow("login-form"));
    expect(groups()).toEqual([
      ["Switch", "Merge into current branch (main)…", "Rebase current branch (main) onto login-form…"],
      ["Create branch here…", "Rename…", "Delete…"],
      ["Push", "Copy branch name"],
    ]);
    expect(separators()).toBe(2);
    for (const item of openMenuItems()) expect(item.querySelector('[data-slot="menu-icon"] svg')).not.toBeNull();
    // Push on another branch states its reason inside the item line.
    const push = openMenuItems().find((i) => itemLabel(i) === "Push")!;
    expect(push.contains(document.getElementById(push.getAttribute("aria-describedby")!))).toBe(true);
    await press(document.activeElement!, "Escape");
    await contextMenu(await sidebarRow("origin/login-page"));
    expect(groups()).toEqual([["Switch", "Merge into current branch (main)…", "Rebase current branch (main) onto origin/login-page…"], ["Create branch here…"], ["Copy branch name"]]);
  });

  test("a remote branch menu holds the FR-014 subset", async () => {
    await mountWorkbench(workbench, branchWorld());
    await contextMenu(await sidebarRow("origin/login-page"));
    expect(openMenuItems().map(itemLabel)).toEqual(["Switch", "Merge into current branch (main)…", "Rebase current branch (main) onto origin/login-page…", "Create branch here…", "Copy branch name"]);
  });

  test("the current branch keeps Show only this branch's history, and its unavailable items state their reasons", async () => {
    await mountWorkbench(workbench, branchWorld());
    await contextMenu(await sidebarRow("main"));
    const items = openMenuItems();
    expect(items.map(itemLabel)).toContain("Show only this branch's history");
    const reason = (label: string) => {
      const item = items.find((i) => itemLabel(i) === label)!;
      const id = item.getAttribute("aria-describedby");
      return id === null ? null : text(document.getElementById(id)!);
    };
    expect(reason("Switch")).toBe("main is the current branch.");
    expect(reason("Delete…")).toBe("You cannot delete the current branch. Switch to another branch first.");
  });

  test("Delete is unavailable for a branch that another worktree holds (FR-017)", async () => {
    await mountWorkbench(workbench, branchWorld());
    await contextMenu(await sidebarRow("signup"));
    const item = openMenuItems().find((i) => itemLabel(i) === "Delete…")!;
    expect(text(document.getElementById(item.getAttribute("aria-describedby")!)!)).toBe("The worktree C:\\wt\\sample-signup holds this branch. Open that worktree, or remove it first.");
  });

  test("Copy branch name writes the short name (FR-020)", async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
    await mountWorkbench(workbench, branchWorld());
    await contextMenu(await sidebarRow("origin/login-page"));
    await click(openMenuItems().find((i) => itemLabel(i) === "Copy branch name")!);
    expect(written).toEqual(["origin/login-page"]);
  });

  test("Ctrl+. on a focused branch row starts the switch (D15 map)", async () => {
    const double = await mountWorkbench(workbench, branchWorld());
    const row = await sidebarRow("login-form");
    await act(async () => row.focus());
    await press(row, ".", { ctrlKey: true });
    expect(reviews(double)[0]).toEqual({ action: "switch", target: { ref: "refs/heads/login-form" }, choice: "keep" });
  });

  test("a branch label in the history opens the same menu", async () => {
    await mountWorkbench(workbench, branchWorld());
    const chip = document.querySelector('[data-slot="row-labels"] .chip[data-kind="branch"]');
    expect(chip).not.toBeNull();
    await contextMenu(chip!);
    expect(openMenuItems().map(itemLabel)[0]).toBe("Switch");
    expect(openMenuItems().map(itemLabel)).toContain("Show only this branch's history");
  });
});

describe("docked panel height (plan D15 \"Docked panel\", T090)", () => {
  test("a Merge panel docks at its content height, at most 60% of the work area, and only its content scrolls", async () => {
    await mountWorkbench(workbench, branchWorld(() => new Promise(() => {})));
    await contextMenu(await sidebarRow("login-form"));
    await click(openMenuItems().find((i) => itemLabel(i) === "Merge into current branch (main)…")!);
    const dock = document.querySelector<HTMLElement>('section[aria-label="Dock"]')!;
    const panel = dock.querySelector<HTMLElement>("section[aria-labelledby]")!;
    expect(panel).not.toBeNull();
    const profile = document.querySelector("[data-profile]")!.getAttribute("data-profile");
    const client = { width: window.innerWidth, height: window.innerHeight };
    const workArea = profile === "constrained" ? client.height : workAreaHeight(client, 1, "compact");
    expect(dock.style.flex).toBe("0 0 auto");
    expect(dock.style.maxHeight).toBe(`${0.6 * workArea}px`);
    // The panel takes its content height. Only its content scrolls, so the head and the foot stay visible.
    expect(panel.className.split(/\s+/)).not.toContain("h-full");
    const body = panel.querySelector<HTMLElement>('[data-slot="panel-body"]')!;
    expect(body.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-0", "overflow-auto"]));
    expect(body.className.split(/\s+/)).not.toContain("flex-1");
  });
});

describe("branch dialogs (FR-015 to FR-019)", () => {
  test("the delete confirmation states the count and the HEAD reflog sentence, with Cancel first", async () => {
    const double = await mountWorkbench(workbench, branchWorld(() => reviewed("delete-branch", { ref: "refs/heads/login-form", oid: oid(4), onlyHere: 2, reflogKeeps: true, heldBy: null, current: false })));
    const row = await sidebarRow("login-form");
    await act(async () => row.focus());
    await press(row, "Delete");
    await settle();
    expect(reviews(double)[0]).toEqual({ action: "delete-branch", ref: "refs/heads/login-form" });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(text(dialog)).toContain("login-form has 2 commits that no other branch has. Deleting the branch loses them.");
    expect(text(dialog)).toContain(`Git's HEAD reflog keeps commit ${oid(4).slice(0, 12)} for a limited time.`);
    expect(text(document.activeElement!)).toBe("Cancel");
    await click(button("Cancel"));
    expect(double.count("runWorkbench")).toBe(0);
  });

  test("a branch that the others hold loses no commit, and no reflog keeps its tip", async () => {
    await mountWorkbench(workbench, branchWorld(() => reviewed("delete-branch", { ref: "refs/heads/login-form", oid: oid(4), onlyHere: 0, reflogKeeps: false, heldBy: null, current: false })));
    await contextMenu(await sidebarRow("login-form"));
    await click(openMenuItems().find((i) => itemLabel(i) === "Delete…")!);
    const dialog = text(document.querySelector('[role="dialog"]')!);
    expect(dialog).toContain("Deleting login-form loses no commit.");
    expect(dialog).toContain(`No reflog keeps commit ${oid(4).slice(0, 12)} after the delete.`);
  });

  test("New branch… takes a name, Switch to the new branch starts checked, and a refused name shows its reason", async () => {
    const double = await mountWorkbench(workbench, branchWorld(() => ({ requestId: fixtureId(0x5ff), state: "rejected", code: "WORKBENCH_UNAVAILABLE", result: { reason: "reserved-name" } })));
    await openList();
    await click(options().at(-1)!);
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Branch name"]')!;
    expect(document.activeElement).toBe(field);
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    await type(field, "@");
    await click(button("Create"));
    expect(reviews(double)[0]).toEqual({ action: "create-branch", name: "@", start: oid(1), switchTo: true });
    expect(text(popup()!)).toContain("Git reads @ as HEAD. Use another branch name.");
    expect(double.count("runWorkbench")).toBe(0);
  });

  test("F2 opens Rename with the current name", async () => {
    const double = await mountWorkbench(workbench, branchWorld(() => reviewed("rename-branch", { ref: "refs/heads/login-form", oid: oid(4), name: "login-ui" })));
    const row = await sidebarRow("login-form");
    await act(async () => row.focus());
    await press(row, "F2");
    const field = document.querySelector<HTMLInputElement>('input[aria-label="New name"]')!;
    expect(field.value).toBe("login-form");
    await type(field, "login-ui");
    await click(button("Rename"));
    expect(reviews(double)[0]).toEqual({ action: "rename-branch", ref: "refs/heads/login-form", name: "login-ui" });
    expect(double.count("runWorkbench")).toBe(1);
  });
});

describe("refusal texts (contract Δ9, plan D3, D4, D15)", () => {
  const refused = (code: string, result: Record<string, unknown>) => refusalText({ requestId: fixtureId(0x5ff), state: "rejected", code, result } as never, "login-form");
  test("each reason gives its D15 text", () => {
    expect(refused("UNTRACKED_IN_WAY", { reason: "untracked-in-way", paths: ["a.txt", "b/c.txt"], more: 3 })).toBe("Discard would overwrite these untracked files: a.txt, b/c.txt, and 3 more.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "no-tracking-refspec" })).toBe("No refspec of a remote maps this branch, so Git cannot set up tracking. Check out the commit only.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "several-tracking-remotes", remotes: ["origin", "fork"] })).toBe("The refspecs of origin, fork map this branch, so Git cannot set up tracking. Check out the commit only.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "same-branch" })).toBe("login-form is the current branch.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "unborn" })).toBe("The current branch has no commit yet. Git can stash only after the first commit.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "reserved-name" })).toBe("Git reads @ as HEAD. Use another branch name.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "invalid-name" })).toBe("Git does not accept this branch name.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "config-in-include" })).toBe("An included configuration file sets branch.login-form. Git cannot remove that setting here, so delete the branch in a terminal.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "current-branch" })).toBe("You cannot delete the current branch. Switch to another branch first.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "other-worktree", worktree: "C:\\wt\\x" })).toBe("The worktree C:\\wt\\x holds this branch. Open that worktree, or remove it first.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "head-unresolved", worktree: "C:\\wt\\long" })).toBe("Git cannot read the HEAD of the worktree C:\\wt\\long, so Arbareto cannot tell which branch it holds. Fix or remove that worktree first.");
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "name-exists", ref: "refs/heads/login-form" })).toBe("The branch login-form exists. Use another name.");
    expect(refused("STALE_REVIEW", {})).toBe("The action did not start: STALE_REVIEW.");
    // Plan D15 "Malformed result": a succeeded review without a token never shows its state as a code.
    expect(refusalText({ requestId: fixtureId(0x5ff), state: "succeeded", result: {} } as never, "login-form")).toBe("The action did not complete: the result has an unknown form.");
    expect(refused("CONFLICTED", { unmerged: 1 })).toBe("Resolve the 1 conflicted file first.");
    expect(refused("CONFLICTED", { unmerged: 1200 })).toBe("Resolve the 1,200 conflicted files first.");
  });

  test("the delete confirmation states config-in-include and offers no Delete", async () => {
    await mountWorkbench(workbench, branchWorld(() => ({ requestId: fixtureId(0x5ff), state: "rejected", code: "WORKBENCH_UNAVAILABLE", result: { reason: "config-in-include" } })));
    await contextMenu(await sidebarRow("login-form"));
    await click(openMenuItems().find((i) => itemLabel(i) === "Delete…")!);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(text(dialog)).toContain("An included configuration file sets branch.login-form.");
    expect(buttons("Delete")).toHaveLength(0);
  });
});

describe("integration with the status bar and the panels (plan D15)", () => {
  const RUNNING = "A Git operation is running. Its progress and Cancel are in the status bar.";
  const footer = () => document.querySelector("footer")!;

  test("a switch run shows its progress and Cancel in the status bar, blocks the other mutations, and ends with its outcome", async () => {
    const world = branchWorld();
    world.answers.runWorkbench = undefined;
    const double = await mountWorkbench(workbench, world);
    await openList();
    await type(filterField(), "login-form");
    await press(filterField(), "Enter");
    await settle();
    const run = double.pending("runWorkbench")!;
    await act(async () => (run.args[2] as (e: unknown) => void)({ requestId: fixtureId(0x5ff), operationId: fixtureId(0x511), state: "running", phase: "switch-checkout", counters: {} }));
    await settle();
    expect(text(footer())).toContain("Switching in");
    expect(buttons("Cancel").filter((b) => footer().contains(b))).toHaveLength(1);
    expect(button("Fetch").getAttribute("aria-disabled")).toBe("true");
    await openList();
    expect(text(popup()!)).toContain(RUNNING);
    expect(options()).toHaveLength(0);
    await press(filterField(), "Escape");
    await click(buttons("Cancel").find((b) => footer().contains(b))!);
    expect(double.calls.find((c) => c.operation === "cancel")?.args[0]).toEqual({ operationId: fixtureId(0x511) });
    await answer(run, switched);
    expect(text(footer())).toContain("Switch completed");
    expect(text(footer())).toContain("Switched to login-form.");
    expect(buttons("Cancel").filter((b) => footer().contains(b))).toHaveLength(0);
    expect(button("Fetch").getAttribute("aria-disabled")).not.toBe("true");
  });

  test("Merge into current and Rebase current onto open the docked panels", async () => {
    const double = await mountWorkbench(workbench, branchWorld());
    await contextMenu(await sidebarRow("login-form"));
    await click(openMenuItems().find((i) => itemLabel(i) === "Merge into current branch (main)…")!);
    expect(text(document.querySelector('[data-slot="integrate-panel"]')!.closest("section")!)).toContain("Merge login-form into main");
    expect(reviews(double).at(-1)).toMatchObject({ action: "merge", ref: "refs/heads/login-form" });
    await press(document.activeElement!, "Escape");
    await contextMenu(await sidebarRow("login-form"));
    await click(openMenuItems().find((i) => itemLabel(i) === "Rebase current branch (main) onto login-form…")!);
    expect(text(document.querySelector('[data-slot="integrate-panel"]')!.closest("section")!)).toContain("Rebase main onto login-form");
    expect(reviews(double).at(-1)).toMatchObject({ action: "rebase", ref: "refs/heads/login-form" });
  });

  test("Escape on a panel that a branch menu item opened returns the focus to the branch row", async () => {
    await mountWorkbench(workbench, branchWorld());
    const row = await sidebarRow("login-form");
    await contextMenu(row);
    await click(openMenuItems().find((i) => itemLabel(i) === "Merge into current branch (main)…")!);
    const section = document.querySelector('[data-slot="integrate-panel"]')!.closest("section")!;
    expect(section.contains(document.activeElement)).toBe(true);
    await press(document.activeElement!, "Escape");
    expect(document.querySelector('[data-slot="integrate-panel"]')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  test("the branch name and filter fields have no spell check and no autocomplete", async () => {
    await mountWorkbench(workbench, branchWorld());
    await openList();
    const off = (input: HTMLInputElement) => [input.getAttribute("spellcheck"), input.getAttribute("autocomplete")];
    expect(off(filterField())).toEqual(["false", "off"]);
    await click(options()[3]!);
    expect(off(document.querySelector<HTMLInputElement>('input[aria-label="Branch name"]')!)).toEqual(["false", "off"]);
    await click(button("Cancel"));
    await openList();
    await click(options().at(-1)!);
    expect(off(document.querySelector<HTMLInputElement>('input[aria-label="Branch name"]')!)).toEqual(["false", "off"]);
  });

  test("name-exists offers a switch to the existing branch (plan D3)", async () => {
    const double = await mountWorkbench(
      workbench,
      branchWorld((p) => ("track" in (p.target as object) ? { requestId: fixtureId(0x5ff), state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "name-exists", ref: "refs/heads/login-form" } } : reviewed("switch", switchPlan({ target: p.target, choice: p.choice })))),
    );
    await openList();
    await click(options()[3]!);
    await click(button("Create and switch"));
    expect(text(popup()!)).toContain("The branch login-form exists. Use another name.");
    await click(button("Switch to login-form"));
    expect(reviews(double).at(-1)).toEqual({ action: "switch", target: { ref: "refs/heads/login-form" }, choice: "keep" });
    expect(double.count("runWorkbench")).toBe(1);
  });

  test("the list shows the headings Local branches and Remote branches", async () => {
    await mountWorkbench(workbench, branchWorld());
    await openList();
    const headings = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Branches"] [data-slot="list-heading"]')];
    expect(headings().map((h) => text(h))).toEqual(["Local branches 3", "Remote branches 2"]);
    expect(headings()[0]!.nextElementSibling?.getAttribute("aria-label")?.split(",")[0]).toBe("login-form");
    expect(headings()[1]!.nextElementSibling?.getAttribute("aria-label")?.split(",")[0]).toBe("origin/login-page");
    for (const h of headings()) expect(h.getAttribute("role")).not.toBe("option");
    await type(filterField(), "origin");
    // The counts keep the values of the read.
    expect(headings().map((h) => text(h))).toEqual(["Remote branches 2"]);
  });

  test("each new refs digest reads the branches again, and an unchanged digest does not", async () => {
    const world = branchWorld();
    const double = await mountWorkbench(workbench, world);
    const start = double.count("readBranches");
    await click(button("Refresh"));
    await settle();
    expect(double.count("readBranches")).toBe(start);
    world.refsDigest = "e".repeat(64);
    await click(button("Refresh"));
    await settle();
    expect(double.count("readBranches")).toBe(start + 1);
  });
});
