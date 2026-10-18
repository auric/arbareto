// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, itemLabel, mountWorkbench, oid, press, settings, settle, succeeded, text, unmountAll, type World } from "./sync-fake";
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
const local = (name: string, fields: Entry = {}): Entry => ({ ref: `refs/heads/${name}`, kind: "local", name, invalidUtf8: false, oid: oid(4), upstream: null, tracking: null, heldBy: null, current: false, localName: null, hasLocal: false, ...fields });
const remote = (name: string, fields: Entry = {}): Entry => ({ ref: `refs/remotes/${name}`, kind: "remote", name, invalidUtf8: false, oid: oid(9), upstream: null, tracking: null, heldBy: null, current: false, localName: null, hasLocal: false, ...fields });
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

  test("a rebase shows Rebasing", async () => {
    await mountWorkbench(workbench, branchWorld(undefined, { operationState: "rebasing" }));
    expect(text(branchButton()!)).toContain("Rebasing");
  });
});

describe("branch list (FR-008, FR-009, FR-013, SC-003)", () => {
  test("the list shows local then remote branches, gives the filter the first focus, and ends with New branch… (Ctrl+B)", async () => {
    await mountWorkbench(workbench, branchWorld());
    await openList();
    expect(document.activeElement).toBe(filterField());
    const names = options().map((o) => o.getAttribute("aria-label") ?? text(o));
    expect(names.slice(0, 5).map((n) => n.split(",")[0])).toEqual(["login-form", "main", "signup", "origin/login-page", "origin/main"]);
    expect(text(options().at(-1)!)).toBe("New branch… (Ctrl+B)");
    // The current branch is bold, without the word Current.
    const main = options()[1]!;
    expect(main.querySelector(".font-semibold")?.textContent).toBe("main");
    expect(text(main)).not.toContain("Current");
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
    const world = branchWorld((p) => (p.choice === "discard" ? { requestId: "r", state: "rejected", code: "UNTRACKED_IN_WAY", result: { reason: "untracked-in-way", paths: ["build/out.txt"], more: 0 } } : reviewed("switch", switchPlan({ trackedChanges: 1, choice: p.choice }))));
    const double = await mountWorkbench(workbench, world);
    await doubleClick(await sidebarRow("login-form"));
    await click(radio("Discard changes")!);
    await click(button("Discard and switch"));
    expect(text(popup()!)).toContain("build/out.txt");
    expect(double.count("runWorkbench")).toBe(0);
  });
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
    const double = await mountWorkbench(workbench, branchWorld(() => ({ requestId: "r", state: "rejected", code: "WORKBENCH_UNAVAILABLE", result: { reason: "reserved-name" } })));
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
  const refused = (code: string, result: Record<string, unknown>) => refusalText({ requestId: "r", state: "rejected", code, result } as never, "login-form");
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
    expect(refused("WORKBENCH_UNAVAILABLE", { reason: "name-exists", ref: "refs/heads/login-form" })).toBe("The branch login-form exists. Use another name.");
    expect(refused("STALE_REVIEW", {})).toBe("The action did not start: STALE_REVIEW.");
  });

  test("the delete confirmation states config-in-include and offers no Delete", async () => {
    await mountWorkbench(workbench, branchWorld(() => ({ requestId: "r", state: "rejected", code: "WORKBENCH_UNAVAILABLE", result: { reason: "config-in-include" } })));
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
    await act(async () => (run.args[2] as (e: unknown) => void)({ requestId: "r", operationId: fixtureId(0x511), state: "running", phase: "switch-checkout", counters: {} }));
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

  test("name-exists offers a switch to the existing branch (plan D3)", async () => {
    const double = await mountWorkbench(
      workbench,
      branchWorld((p) => ("track" in (p.target as object) ? { requestId: "r", state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "name-exists", ref: "refs/heads/login-form" } } : reviewed("switch", switchPlan({ target: p.target, choice: p.choice })))),
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
    expect(headings().map((h) => text(h))).toEqual(["Local branches", "Remote branches"]);
    expect(headings()[0]!.nextElementSibling?.getAttribute("aria-label")?.split(",")[0]).toBe("login-form");
    expect(headings()[1]!.nextElementSibling?.getAttribute("aria-label")?.split(",")[0]).toBe("origin/login-page");
    for (const h of headings()) expect(h.getAttribute("role")).not.toBe("option");
    await type(filterField(), "origin");
    expect(headings().map((h) => text(h))).toEqual(["Remote branches"]);
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
