// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, itemLabel, keyboardFocus, mountWorkbench, oid, press, settle, succeeded, text, tooltipText, unmountAll, type World } from "./sync-fake";
import { fixtureId } from "./bridge-contract";

// tasks.md T064 (feature 004, WP21). Story US5. Spec FR-049 to FR-057. Plan D10, D15. Data-model §8. Contract Δ3, Δ9.

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/worktrees/WorktreeActions.tsx", import.meta.dir);
printOrigin("../../src/frontend/worktrees/texts.ts", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(async () => unmountAll());

const TOKEN = fixtureId(0x600);
type Entry = Record<string, unknown>;
// Data-model §8 records in Git's order. Only the first is main.
const wt = (path: string, fields: Entry = {}): Entry => ({ path, invalidUtf8: false, head: oid(1), branch: null, bare: false, detached: false, locked: null, prunable: null, main: false, current: false, ...fields });
const MAIN = wt("C:/repo", { branch: "refs/heads/main", main: true });
const SIGNUP = wt("C:/wt/repo-signup", { branch: "refs/heads/signup", current: true });
const HOTFIX = wt("C:/wt/repo-hotfix", { branch: "refs/heads/fix/crash", head: oid(4) });
const LOCKED = wt("C:/wt/repo-locked", { branch: "refs/heads/locked", locked: { reason: "on a USB disk" } });
const GONE = wt("C:/wt/repo-gone", { head: oid(5), detached: true, prunable: { reason: "gitdir file points to non-existent location" } });
const ALL = [MAIN, SIGNUP, HOTFIX, LOCKED, GONE];

// Data-model §1 entries for the existing-branch list of Add worktree.
const local = (name: string, fields: Entry = {}): Entry => ({ ref: `refs/heads/${name}`, kind: "local", name, invalidUtf8: false, oid: oid(4), upstream: null, tracking: null, heldBy: null, current: false, localName: null, hasLocal: false, ...fields });
const BRANCHES = [local("@"), local("fix/crash", { heldBy: "C:/wt/repo-hotfix" }), local("login"), local("main", { heldBy: "C:/repo" }), local("signup", { current: true })];

type Plan = Record<string, unknown>;
const removePlan = (fields: Plan = {}): Plan => ({ worktree: "C:/wt/repo-hotfix", branch: "refs/heads/fix/crash", head: oid(4), tracked: 0, untracked: 0, force: false, deleteBranch: null, submodules: false, ...fields });
const reviewed = (action: string, plan: Plan) => succeeded({ action, plan, workbenchToken: TOKEN });
const refused = (code: string, result: Record<string, unknown> = {}) => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code, repositoryGeneration: 1, result });
const NOT_NOW = { requestId: fixtureId(0x602), state: "canceled" };
const APPROVED = { trustId: fixtureId(0x601), persistence: "stored", saveFailed: false };
const CLASSES = { reads: false, commit: false, sync: false, workbench: true, mergetool: false };
const NONE = { names: [], more: 0 };
// Contract §3 `readTrust`, data-model §10.
const trustReport = (state: string) => ({ generation: 1, state, persistence: "stored", ...(state === "approved" ? { trustId: fixtureId(0x601) } : {}), approvalRequired: CLASSES, entries: [], hooks: [], programs: { hooks: NONE, filters: NONE, monitors: NONE, mergeDrivers: NONE, mergeTools: NONE, signing: NONE, other: NONE } });
const worktreeRun = (action: string, worktrees: string[]) => succeeded({ action, head: { state: "branch", target: "refs/heads/signup", oid: oid(1) }, refs: [], worktrees });

function worktreeWorld(entries: Entry[] = ALL, review: (payload: Record<string, unknown>) => unknown = () => reviewed("worktree-remove", removePlan()), fields: Partial<World> = {}): World {
  const world = createWorld({ head: { state: "branch", target: "refs/heads/signup", oid: oid(1) }, ...fields });
  world.answers.readWorktrees = () => succeeded({ entries });
  world.answers.readBranches = () => succeeded({ entries: BRANCHES });
  world.answers.reviewWorkbench = (args) => review(args[1] as Record<string, unknown>);
  world.answers.runWorkbench = () => worktreeRun("worktree-remove", ["C:/repo", "C:/wt/repo-signup"]);
  // Plan D12 "Ask": the shell task dialog ends Not now unless a test approves.
  world.answers.approveTrust = () => NOT_NOW;
  return world;
}

type Double = Awaited<ReturnType<typeof mountWorkbench>>;
const worktreeButton = () => document.querySelector<HTMLElement>('header [data-slot="worktree-button"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Worktrees"] [role="option"]')];
const filterField = () => document.querySelector<HTMLInputElement>('input[aria-label="Filter worktrees"]')!;
const reviews = (double: Double) => double.calls.filter((c) => c.operation === "reviewWorkbench").map((c) => c.args[1] as Record<string, unknown>);
const opened = (double: Double) => double.calls.filter((c) => c.operation === "openWorktree").map((c) => c.args[0] as Record<string, unknown>);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const groupRows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="worktrees-group"] [role="option"]')];
const addPanel = () => [...document.querySelectorAll<HTMLElement>("section")].find((s) => s.querySelector("h2")?.textContent === "Add worktree") ?? null;
const checkbox = (label: string, from: ParentNode = document) => [...from.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((c) => text(c.closest("label") ?? c).startsWith(label)) ?? null;
const radio = (label: string, from: ParentNode = document) => [...from.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => text(r.closest("label") ?? r).startsWith(label)) ?? null;
const folderField = (panel: HTMLElement) => document.getElementById([...panel.querySelectorAll("label")].find((l) => text(l) === "Folder")!.htmlFor) as HTMLInputElement;
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-content"] [role="menuitem"]')];
const menuItem = (label: string) => menuItems().find((i) => itemLabel(i) === label) ?? null;
const reasonOf = (item: HTMLElement) => text(item.querySelector('[data-slot="menu-reason"]') ?? document.createElement("span"));

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function check(input: HTMLInputElement) {
  await click(input);
}
async function openList() {
  await click(worktreeButton()!);
}
async function contextMenu(element: Element) {
  await act(async () => void element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await settle();
}
async function doubleClick(element: Element) {
  await act(async () => void element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
  await settle();
}
/** The sidebar row whose accessible name starts with `name`. The constrained profile shows the references first. */
async function groupRow(name: string): Promise<HTMLElement> {
  const toggle = document.querySelector<HTMLElement>('button[aria-label="Show references"]');
  if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
  const found = groupRows().filter((r) => (r.getAttribute("aria-label") ?? "").startsWith(`${name},`));
  if (found.length !== 1) throw new Error(`expected one Worktrees row "${name}", found ${found.length}`);
  return found[0]!;
}
async function rowMenu(name: string) {
  await contextMenu(await groupRow(name));
}

describe("worktree button and list (FR-049)", () => {
  test("the button shows the current worktree folder name and the worktree count", async () => {
    await mountWorkbench(workbench, worktreeWorld());
    const b = worktreeButton();
    expect(b).not.toBeNull();
    expect(text(b!)).toContain("repo-signup");
    expect(text(b!)).toContain("5");
    expect(b!.getAttribute("aria-label")).toBe("repo-signup, 5 worktrees");
  });

  test("the list gives the filter the first focus and shows each record with its branch, states, and marks", async () => {
    await mountWorkbench(workbench, worktreeWorld());
    await openList();
    expect(document.activeElement).toBe(filterField());
    const rows = options();
    // Five records, then Add worktree… and Prune missing worktrees.
    expect(rows).toHaveLength(7);
    expect(text(rows[0]!)).toContain("repo");
    expect(text(rows[0]!)).toContain("C:/repo");
    expect(text(rows[0]!)).toContain("Main worktree");
    expect(text(rows[1]!)).toContain("signup");
    expect(text(rows[1]!)).toContain("Current");
    expect(text(rows[2]!)).toContain("fix/crash");
    expect(text(rows[3]!)).toContain("Locked: on a USB disk");
    expect(text(rows[4]!)).toContain(`Detached at ${oid(5).slice(0, 12)}`);
    expect(text(rows[4]!)).toContain("Folder missing");
    expect(rows[1]!.getAttribute("aria-label")).toBe("repo-signup, signup, C:/wt/repo-signup, Current");
    expect(itemLabel(rows[5]!)).toBe("Add worktree…");
    expect(itemLabel(rows[6]!)).toStartWith("Prune missing worktrees");
  });

  test("the filter is a literal substring match without regard to case, and Enter opens the first match", async () => {
    const double = await mountWorkbench(workbench, worktreeWorld());
    await openList();
    await type(filterField(), "HOTFIX");
    expect(options().map((o) => o.getAttribute("aria-label")).slice(0, 1)).toEqual(["repo-hotfix, fix/crash, C:/wt/repo-hotfix"]);
    expect(options()).toHaveLength(3);
    await press(filterField(), "Enter");
    expect(opened(double)).toEqual([{ repositoryId: fixtureId(1), path: "C:/wt/repo-hotfix" }]);
  });

  test("a filter without a match states it, and the actions stay", async () => {
    await mountWorkbench(workbench, worktreeWorld());
    await openList();
    await type(filterField(), "x.y");
    expect(text(document.body)).toContain("No worktree matches the filter.");
    expect(options()).toHaveLength(2);
  });

  test("a pick of the current worktree opens nothing", async () => {
    const double = await mountWorkbench(workbench, worktreeWorld());
    await openList();
    await type(filterField(), "signup");
    await press(filterField(), "Enter");
    expect(opened(double)).toHaveLength(0);
  });

  test("a failed read shows its code and no worktree", async () => {
    const world = worktreeWorld();
    world.answers.readWorktrees = () => refused("UNSUPPORTED_REPOSITORY");
    await mountWorkbench(workbench, world);
    await openList();
    expect(text(document.body)).toContain("Arbareto cannot read the worktrees: UNSUPPORTED_REPOSITORY.");
    expect(options()).toHaveLength(0);
  });

  test("a succeeded read without entries shows the unknown-form text, not its state", async () => {
    const world = worktreeWorld();
    world.answers.readWorktrees = () => succeeded({});
    await mountWorkbench(workbench, world);
    await openList();
    expect(text(document.body)).toContain("Worktree list did not complete: the result has an unknown form.");
    expect(text(document.body)).not.toContain("succeeded");
    expect(options()).toHaveLength(0);
  });

  test("Delete on the active record removes it only with the caret at the end of the filter, and the main worktree states why not", async () => {
    const double = await mountWorkbench(workbench, worktreeWorld());
    await openList();
    await press(filterField(), "Delete");
    expect(text(document.body)).toContain("You cannot remove the main worktree.");
    expect(reviews(double)).toHaveLength(0);
    await press(filterField(), "ArrowDown");
    await press(filterField(), "ArrowDown");
    await press(filterField(), "Delete");
    expect(reviews(double)).toEqual([{ action: "worktree-remove", worktree: "C:/wt/repo-hotfix", force: false, deleteBranch: false }]);
  });
});

describe("sidebar Worktrees group (FR-050, FR-051)", () => {
  test("it lists the same worktrees, and a double-click opens one that is not current", async () => {
    const double = await mountWorkbench(workbench, worktreeWorld());
    const row = await groupRow("repo-hotfix");
    expect(groupRows()).toHaveLength(5);
    await doubleClick(row);
    expect(opened(double)).toEqual([{ repositoryId: fixtureId(1), path: "C:/wt/repo-hotfix" }]);
    await doubleClick(await groupRow("repo-signup"));
    expect(opened(double)).toHaveLength(1);
  });

  test("the group is one Tab stop, and Enter opens the active row", async () => {
    const double = await mountWorkbench(workbench, worktreeWorld());
    await groupRow("repo");
    const list = document.querySelector<HTMLElement>('[data-slot="worktrees-group"] [role="listbox"]')!;
    expect(list.tabIndex).toBe(0);
    expect(groupRows().every((r) => r.tabIndex === -1 || !r.hasAttribute("tabindex"))).toBe(true);
    list.focus();
    await press(list, "ArrowDown");
    await press(list, "ArrowDown");
    await press(list, "Enter");
    expect(opened(double)).toEqual([{ repositoryId: fixtureId(1), path: "C:/wt/repo-hotfix" }]);
  });
});

describe("Remove (FR-054 to FR-056)", () => {
  test("Remove is unavailable with its reason for the main, the current, a locked, and a prunable worktree", async () => {
    const double = await mountWorkbench(workbench, worktreeWorld());
    const cases: [string, string][] = [
      ["repo", "You cannot remove the main worktree."],
      ["repo-signup", "You cannot remove the open worktree. Open another worktree first."],
      ["repo-locked", "The worktree is locked. Git removes a locked worktree only after git worktree unlock."],
      ["repo-gone", "The worktree folder is missing. Use Prune to remove its record."],
    ];
    for (const [name, reason] of cases) {
      await rowMenu(name);
      const item = menuItem("Remove worktree…");
      expect(item).not.toBeNull();
      expect(reasonOf(item!)).toBe(reason);
      expect(item!.getAttribute("aria-keyshortcuts")).toBe("Delete");
      await click(item!);
      await press(document.activeElement ?? document.body, "Escape");
    }
    expect(reviews(double)).toHaveLength(0);
  });

  test("the confirmation names the folder, gives Cancel the first focus, and Remove runs the reviewed token", async () => {
    const double = await mountWorkbench(workbench, worktreeWorld());
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    const d = dialog();
    expect(d).not.toBeNull();
    expect(text(d!)).toContain("Remove worktree C:/wt/repo-hotfix?");
    expect(text(d!)).toContain("The folder is deleted. The commits stay in the repository.");
    expect(document.activeElement).toBe(button("Cancel", d!));
    const names = [...d!.querySelectorAll("button")].map((b) => text(b));
    expect(names.indexOf("Cancel")).toBeLessThan(names.indexOf("Remove worktree"));
    await click(button("Remove worktree", d!));
    const runs = double.calls.filter((c) => c.operation === "runWorkbench");
    expect(runs.map((c) => c.args[1])).toEqual([{ workbenchToken: TOKEN, start: true }]);
    expect(text(document.body)).toContain("Removed the worktree C:/wt/repo-hotfix.");
  });

  test("uncommitted changes show both counts, and Remove waits for Delete my uncommitted changes too", async () => {
    const double = await mountWorkbench(
      workbench,
      worktreeWorld(ALL, (p) =>
        p.force === true ? reviewed("worktree-remove", removePlan({ tracked: 3, untracked: 1, force: true })) : refused("WORKBENCH_UNAVAILABLE", { reason: "dirty-tree", plan: removePlan({ tracked: 3, untracked: 1 }) }),
      ),
    );
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    const d = dialog()!;
    expect(text(d)).toContain("3 uncommitted changes and 1 untracked file.");
    expect(text(d)).toContain("They are in no commit and no stash. Removing deletes them for good.");
    const remove = button("Remove worktree and changes", d);
    expect(remove.hasAttribute("disabled") || remove.getAttribute("aria-disabled") === "true").toBe(true);
    await click(remove);
    expect(double.count("runWorkbench")).toBe(0);
    await check(checkbox("Delete my uncommitted changes too", d)!);
    expect(reviews(double).at(-1)).toEqual({ action: "worktree-remove", worktree: "C:/wt/repo-hotfix", force: true, deleteBranch: false });
    const ready = button("Remove worktree and changes", dialog()!);
    expect(ready.hasAttribute("disabled") || ready.getAttribute("aria-disabled") === "true").toBe(false);
    await click(ready);
    expect(double.count("runWorkbench")).toBe(1);
  });

  test("submodules without changes need the force box, with their own text and label", async () => {
    const double = await mountWorkbench(
      workbench,
      worktreeWorld(ALL, (p) =>
        p.force === true ? reviewed("worktree-remove", removePlan({ submodules: true, force: true })) : refused("WORKBENCH_UNAVAILABLE", { reason: "dirty-tree", plan: removePlan({ submodules: true }) }),
      ),
    );
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    const d = dialog()!;
    expect(text(d)).toContain("This worktree has submodules. Git removes it only with its force option.");
    expect(text(d)).not.toContain("uncommitted change");
    expect(checkbox("Delete my uncommitted changes too", d)).toBeNull();
    // The remove needs force for its submodules only, so the button names them (plan D15).
    expect(isOff(button("Remove worktree and submodules", d))).toBe(true);
    expect([...d.querySelectorAll("button")].map((x) => text(x))).not.toContain("Remove worktree");
    await click(button("Remove worktree and submodules", d));
    expect(double.count("runWorkbench")).toBe(0);
    await check(checkbox("Delete the worktree with its submodules too", d)!);
    expect(reviews(double).at(-1)).toEqual({ action: "worktree-remove", worktree: "C:/wt/repo-hotfix", force: true, deleteBranch: false });
    await click(button("Remove worktree and submodules", dialog()!));
    expect(double.count("runWorkbench")).toBe(1);
  });

  test("while a worktree run runs, Remove, Prune, and Open start nothing and show no running reason in the status bar (plan D15 running rule)", async () => {
    const world = worktreeWorld();
    // The run waits for the test, so an operation runs.
    world.answers.runWorkbench = undefined;
    const double = await mountWorkbench(workbench, world);
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    await click(button("Remove worktree", dialog()!));
    expect(double.count("runWorkbench")).toBe(1);
    const before = reviews(double).length;
    const footer = () => text(document.querySelector("footer")!);
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    await press(document.activeElement ?? document.body, "Escape");
    await openList();
    await click(options().find((o) => itemLabel(o).startsWith("Prune missing worktrees"))!);
    await press(document.activeElement ?? document.body, "Escape");
    await doubleClick(await groupRow("repo-hotfix"));
    expect(reviews(double)).toHaveLength(before);
    expect(opened(double)).toHaveLength(0);
    expect(footer()).not.toContain("A Git operation is running.");
  });

  test("submodules with changes show both facts and the changes label", async () => {
    await mountWorkbench(workbench, worktreeWorld(ALL, () => refused("WORKBENCH_UNAVAILABLE", { reason: "dirty-tree", plan: removePlan({ tracked: 2, untracked: 0, submodules: true }) })));
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    const d = dialog()!;
    expect(text(d)).toContain("2 uncommitted changes and 0 untracked files.");
    expect(text(d)).toContain("This worktree has submodules. Git removes it only with its force option.");
    expect(checkbox("Delete my uncommitted changes too", d)).not.toBeNull();
    expect(isOff(button("Remove worktree and changes", d))).toBe(true);
  });

  test("a clean plan without submodules shows no force box", async () => {
    await mountWorkbench(workbench, worktreeWorld());
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    const d = dialog()!;
    expect(text(d)).not.toContain("submodules");
    expect([...d.querySelectorAll('input[type="checkbox"]')]).toHaveLength(1);
    expect(isOff(button("Remove worktree", d))).toBe(false);
  });

  test("Also delete the branch states the commits that only this branch holds and the reflog fact", async () => {
    const facts = { ref: "refs/heads/fix/crash", oid: oid(4), onlyHere: 2, reflogKeeps: false };
    const double = await mountWorkbench(workbench, worktreeWorld(ALL, (p) => reviewed("worktree-remove", removePlan({ deleteBranch: p.deleteBranch === true ? facts : null }))));
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    await check(checkbox("Also delete the branch", dialog()!)!);
    expect(reviews(double).at(-1)).toEqual({ action: "worktree-remove", worktree: "C:/wt/repo-hotfix", force: false, deleteBranch: true });
    const d = dialog()!;
    expect(text(d)).toContain("fix/crash has 2 commits that no other branch has. Deleting the branch loses them.");
    expect(text(d)).toContain(`No reflog keeps commit ${oid(4).slice(0, 12)} after the delete.`);
    await click(button("Remove worktree", d));
    expect(text(document.body)).toContain("Removed the worktree C:/wt/repo-hotfix and deleted fix/crash.");
  });

  test("a detached worktree offers no branch delete", async () => {
    const detached = wt("C:/wt/repo-detached", { head: oid(6), detached: true });
    await mountWorkbench(workbench, worktreeWorld([MAIN, SIGNUP, detached], () => reviewed("worktree-remove", removePlan({ worktree: "C:/wt/repo-detached", branch: null, head: oid(6) }))));
    await rowMenu("repo-detached");
    await click(menuItem("Remove worktree…")!);
    expect(checkbox("Also delete the branch", dialog()!)).toBeNull();
  });

  test("a trust refusal tells the user to trust the worktree in that worktree", async () => {
    const double = await mountWorkbench(workbench, worktreeWorld(ALL, () => refused("TRUST_REQUIRED")));
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    expect(text(dialog()!)).toContain("To trust the worktree C:/wt/repo-hotfix, open it and trust it there.");
    // Not now keeps the first refusal.
    expect(double.count("approveTrust")).toBe(1);
    expect(reviews(double)).toHaveLength(1);
  });

  test("other-worktree and current-branch refusals of the branch delete show their texts", async () => {
    let reason = "other-worktree";
    await mountWorkbench(workbench, worktreeWorld(ALL, (p) => (p.deleteBranch === true ? refused("WORKBENCH_UNAVAILABLE", reason === "other-worktree" ? { reason, worktree: "C:/wt/other" } : { reason }) : reviewed("worktree-remove", removePlan()))));
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    await check(checkbox("Also delete the branch", dialog()!)!);
    expect(text(dialog()!)).toContain("The worktree C:/wt/other holds this branch. Open that worktree, or remove it first.");
    expect(buttons("Remove worktree", dialog()!)).toHaveLength(1);
    expect(isOff(button("Remove worktree", dialog()!))).toBe(true);
    reason = "current-branch";
    await check(checkbox("Also delete the branch", dialog()!)!);
    await check(checkbox("Also delete the branch", dialog()!)!);
    expect(text(dialog()!)).toContain("You cannot delete the current branch. Switch to another branch first.");
  });
});

const buttons = (label: string, from: ParentNode) => [...from.querySelectorAll<HTMLElement>("button")].filter((b) => (b.getAttribute("aria-label") ?? text(b)) === label);
const isOff = (b: HTMLElement) => b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true";

describe("the ask of the worktree actions (FR-069, plan D12 \"Ask\", O-20)", () => {
  /** A world whose reviews answer `answers` in turn. An approval makes `readTrust` approved. */
  function askWorld(answers: unknown[]) {
    const queue = [...answers];
    const world = worktreeWorld(ALL, () => queue.shift() ?? refused("STALE_REVIEW"));
    world.answers.readTrust = () => succeeded(trustReport("untrusted"));
    world.answers.approveTrust = () => {
      world.answers.readTrust = () => succeeded(trustReport("approved"));
      return succeeded(APPROVED);
    };
    return world;
  }
  const approvals = (double: Double) => double.calls.filter((c) => c.operation === "approveTrust").map((c) => c.args);
  /** The ask chain spans several bridge answers. The wait stops after 100 settles (3 s), and the assertions after it decide. */
  async function until(check: () => boolean) {
    for (let i = 0; i < 100 && !check(); i++) await settle();
    await settle();
  }
  const reviewsDone = (double: Double, n: number) => () => double.calls.filter((c) => c.operation === "reviewWorkbench" && c.done).length === n;

  test("a Remove review that needs trust asks for this repository with the worktree action, then reviews once more and runs the new token", async () => {
    const double = await mountWorkbench(workbench, askWorld([refused("TRUST_REQUIRED"), reviewed("worktree-remove", removePlan())]));
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    await until(reviewsDone(double, 2));
    expect(approvals(double)).toEqual([[{ repositoryId: fixtureId(1) }, { action: "worktree" }]]);
    expect(reviews(double)).toHaveLength(2);
    expect(reviews(double)[1]).toEqual({ action: "worktree-remove", worktree: "C:/wt/repo-hotfix", force: false, deleteBranch: false });
    expect(text(dialog()!)).not.toContain("To trust the worktree");
    await click(button("Remove worktree", dialog()!));
    await until(() => double.count("runWorkbench") === 1);
    expect(double.calls.filter((c) => c.operation === "runWorkbench").map((c) => c.args[1])).toEqual([{ workbenchToken: TOKEN, start: true }]);
  });

  test("a repeated Remove refusal after the approval keeps the text that names this repository and the target worktree", async () => {
    const double = await mountWorkbench(workbench, askWorld([refused("TRUST_REQUIRED"), refused("TRUST_REQUIRED")]));
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    await until(reviewsDone(double, 2));
    expect(approvals(double)).toHaveLength(1);
    expect(reviews(double)).toHaveLength(2);
    expect(text(dialog()!)).toContain("To trust the worktree C:/wt/repo-hotfix, open it and trust it there.");
    expect(double.count("runWorkbench")).toBe(0);
  });

  test("an Add review that ends TRUST_CHANGED asks, then reviews once more and runs", async () => {
    const world = askWorld([refused("TRUST_CHANGED"), reviewed("worktree-add", { branch: { new: "feat/login", start: oid(1) }, path: "C:\\repo-login", destination: "absent" })]);
    world.answers.runWorkbench = () => worktreeRun("worktree-add", ["C:/repo", "C:/wt/repo-signup", "C:/repo-login"]);
    const double = await mountWorkbench(workbench, world);
    await openList();
    await click(options().find((o) => itemLabel(o) === "Add worktree…")!);
    await type(addPanel()!.querySelector<HTMLInputElement>('input[aria-label="New branch name"]')!, "feat/login");
    await click(button("Add worktree (Ctrl+Enter)", addPanel()!));
    await until(() => double.count("runWorkbench") === 1);
    expect(approvals(double)).toEqual([[{ repositoryId: fixtureId(1) }, { action: "worktree" }]]);
    expect(reviews(double)).toHaveLength(2);
    expect(double.count("runWorkbench")).toBe(1);
  });

  test("a refusal of the target worktree gate asks nothing for this repository and shows only the O-20 text", async () => {
    const double = await mountWorkbench(workbench, askWorld([refused("TRUST_REQUIRED", { trustGate: "target" })]));
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    await until(() => text(dialog()!).includes("To trust the worktree"));
    expect(approvals(double)).toEqual([]);
    expect(reviews(double)).toHaveLength(1);
    expect(text(dialog()!)).toContain("To trust the worktree C:/wt/repo-hotfix, open it and trust it there.");
    expect(text(dialog()!)).not.toContain("Trust the repository first");
    expect(double.count("runWorkbench")).toBe(0);
  });

  test("a refusal of the repository gate asks for this repository and, after Not now, names only this repository", async () => {
    const world = askWorld([refused("TRUST_REQUIRED", { trustGate: "repository" })]);
    world.answers.approveTrust = () => NOT_NOW;
    const double = await mountWorkbench(workbench, world);
    await rowMenu("repo-hotfix");
    await click(menuItem("Remove worktree…")!);
    await until(() => text(dialog()!).includes("Trust the repository first"));
    expect(approvals(double)).toEqual([[{ repositoryId: fixtureId(1) }, { action: "worktree" }]]);
    expect(text(dialog()!)).toContain("This action runs programs of this repository. Trust the repository first with the trust chip in the status bar.");
    expect(text(dialog()!)).not.toContain("To trust the worktree");
  });

  test("Prune asks once and shows the trust text after Not now", async () => {
    const world = askWorld([refused("TRUST_REQUIRED")]);
    world.answers.approveTrust = () => NOT_NOW;
    const double = await mountWorkbench(workbench, world);
    await openList();
    await click(options().at(-1)!);
    await until(() => text(document.body).includes("Trust the repository first"));
    expect(approvals(double)).toEqual([[{ repositoryId: fixtureId(1) }, { action: "worktree" }]]);
    expect(reviews(double)).toHaveLength(1);
    expect(text(document.body)).toContain("Trust the repository first with the trust chip in the status bar.");
  });
});

describe("Prune missing worktrees (FR-057)", () => {
  test("without a prunable record it states No worktree is missing and starts nothing", async () => {
    const double = await mountWorkbench(workbench, worktreeWorld([MAIN, SIGNUP, HOTFIX]));
    await openList();
    const prune = options().at(-1)!;
    expect(text(prune)).toContain("No worktree is missing");
    await click(prune);
    expect(reviews(double)).toHaveLength(0);
    await rowMenu("repo");
    expect(reasonOf(menuItem("Prune missing worktrees")!)).toBe("No worktree is missing");
  });

  test("with a prunable record it reviews and runs Git's worktree prune", async () => {
    const world = worktreeWorld(ALL, () => reviewed("worktree-prune", { prunable: [{ path: "C:/wt/repo-gone", reason: "gitdir file points to non-existent location" }] }));
    world.answers.runWorkbench = () => worktreeRun("worktree-prune", ["C:/repo", "C:/wt/repo-signup", "C:/wt/repo-hotfix", "C:/wt/repo-locked"]);
    const double = await mountWorkbench(workbench, world);
    await openList();
    await click(options().at(-1)!);
    expect(reviews(double)).toEqual([{ action: "worktree-prune" }]);
    expect(double.count("runWorkbench")).toBe(1);
    expect(text(document.body)).toContain("Removed the records of 1 missing worktree.");
  });
});

describe("Add worktree (FR-052, FR-053)", () => {
  async function openAdd(world: World = worktreeWorld()) {
    const double = await mountWorkbench(workbench, world);
    await openList();
    await click(options().find((o) => itemLabel(o) === "Add worktree…")!);
    return double;
  }

  test("the docked panel offers a new branch from the selected commit, a folder suggestion, and Switch to it after creating", async () => {
    await openAdd();
    const panel = addPanel();
    expect(panel).not.toBeNull();
    expect(panel!.closest('section[aria-label="Dock"]')).not.toBeNull();
    expect(radio("New branch", panel!)!.checked).toBe(true);
    expect(text(panel!)).toContain(`Starts at commit ${oid(1).slice(0, 12)}.`);
    expect(checkbox("Switch to it after creating", panel!)).not.toBeNull();
    const name = panel!.querySelector<HTMLInputElement>('input[aria-label="New branch name"]')!;
    await type(name, "feat/login");
    const folder = folderField(panel!);
    expect(folder.value).toBe("C:\\repo-login");
    await type(folder, "D:\\work\\login");
    await type(name, "feat/other");
    expect(folder.value).toBe("D:\\work\\login");
  });

  test("Add reviews the new branch and the folder, runs the token, and opens the worktree when the box is checked", async () => {
    const world = worktreeWorld(ALL, () => reviewed("worktree-add", { branch: { new: "feat/login", start: oid(1) }, path: "C:\\repo-login", destination: "absent" }));
    world.answers.runWorkbench = () => worktreeRun("worktree-add", ["C:/repo", "C:/wt/repo-signup", "C:/repo-login"]);
    const double = await openAdd(world);
    const panel = addPanel()!;
    await type(panel.querySelector<HTMLInputElement>('input[aria-label="New branch name"]')!, "feat/login");
    await check(checkbox("Switch to it after creating", panel)!);
    await click(button("Add worktree (Ctrl+Enter)", panel));
    expect(reviews(double)).toEqual([{ action: "worktree-add", branch: { new: "feat/login", start: oid(1) }, path: "C:\\repo-login" }]);
    expect(double.count("runWorkbench")).toBe(1);
    expect(opened(double)).toEqual([{ repositoryId: fixtureId(1), path: "C:\\repo-login" }]);
    expect(addPanel()).toBeNull();
  });

  test("the existing-branch list leaves out held branches and states why, and @ is refused before any request", async () => {
    const double = await openAdd();
    const panel = addPanel()!;
    await check(radio("Existing branch", panel)!);
    const select = panel.querySelector<HTMLSelectElement>('select[aria-label="Branch"]')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["@", "login"]);
    expect(text(panel)).toContain("Branches checked out in another worktree are not listed. Git allows each branch in one worktree only.");
    await act(async () => {
      select.value = "refs/heads/@";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(text(addPanel()!)).toContain("Git reads @ as HEAD. Use another branch name.");
    await click(button("Add worktree (Ctrl+Enter)", addPanel()!));
    expect(reviews(double)).toHaveLength(0);
  });

  const addRefusal = async (response: unknown, expected: string) => {
    const double = await openAdd(worktreeWorld(ALL, () => response));
    const panel = addPanel()!;
    await type(panel.querySelector<HTMLInputElement>('input[aria-label="New branch name"]')!, "feat/login");
    await click(button("Add worktree (Ctrl+Enter)", panel));
    expect(text(addPanel()!)).toContain(expected);
    expect(double.count("runWorkbench")).toBe(0);
  };

  test("REPOSITORY_UNAVAILABLE names the folder that Arbareto cannot read", () => addRefusal(refused("REPOSITORY_UNAVAILABLE", { path: "C:\\repo-login" }), "Arbareto cannot read the folder C:\\repo-login."));
  test("DESTINATION_NOT_EMPTY states the destination fact", () => addRefusal(refused("DESTINATION_NOT_EMPTY", { reason: "not-empty" }), "The folder is not empty. Select a new or empty folder."));
  test("other-worktree names the worktree that holds the branch", () =>
    addRefusal(refused("WORKBENCH_UNAVAILABLE", { reason: "other-worktree", worktree: "C:/wt/repo-hotfix" }), "The worktree C:/wt/repo-hotfix holds this branch. Open that worktree, or remove it first."));
  test("current-branch states that this worktree holds the branch", () => addRefusal(refused("WORKBENCH_UNAVAILABLE", { reason: "current-branch" }), "This worktree holds the branch. Git allows each branch in one worktree only."));
  test("a trust refusal points to the trust chip", () => addRefusal(refused("TRUST_REQUIRED"), "This action runs programs of this repository. Trust the repository first with the trust chip in the status bar."));

  // T094 (spec FR-052, plan D14 and D15, contract Δ3 `chooseWorktreeFolder`).
  const browse = (panel: HTMLElement) => [...panel.querySelectorAll("button")].find((b) => text(b) === "Browse…") ?? null;
  async function browseWith(response: unknown) {
    const double = await openAdd();
    const panel = addPanel()!;
    await type(panel.querySelector<HTMLInputElement>('input[aria-label="New branch name"]')!, "feat/login");
    await click(browse(panel)!);
    const call = double.pending("chooseWorktreeFolder");
    expect(call?.args[0]).toEqual({ repositoryId: fixtureId(1) });
    await answer(call, response);
    return { double, panel: addPanel()! };
  }

  test("Browse… follows the Folder field as one Tab stop with its tooltip", async () => {
    await openAdd();
    const panel = addPanel()!;
    const button = browse(panel)!;
    expect(button).not.toBeNull();
    expect(button.tabIndex).toBe(0);
    const focusable = [...panel.querySelectorAll<HTMLElement>("input, select, button")].filter((e) => e.tabIndex >= 0);
    expect(focusable[focusable.indexOf(folderField(panel)) + 1]).toBe(button);
    await keyboardFocus(button);
    expect(tooltipText()).toBe("Select the parent folder in the folder picker.");
  });

  test("a chosen parent sets the folder to the parent and the suggested name, and the suggestion then stays", async () => {
    const { panel } = await browseWith(succeeded({ path: "D:\\work\\" }));
    const folder = folderField(panel);
    expect(folder.value).toBe("D:\\work\\repo-login");
    expect(document.activeElement).toBe(folder);
    await type(panel.querySelector<HTMLInputElement>('input[aria-label="New branch name"]')!, "feat/other");
    expect(folder.value).toBe("D:\\work\\repo-login");
    await type(folder, "D:\\work\\mine");
    expect(folder.value).toBe("D:\\work\\mine");
  });

  test("a WSL parent keeps its UNC form", async () => {
    const { panel } = await browseWith(succeeded({ path: "\\\\wsl.localhost\\Ubuntu\\home\\u" }));
    expect(folderField(panel).value).toBe("\\\\wsl.localhost\\Ubuntu\\home\\u\\repo-login");
  });

  test("Cancel changes nothing, and the suggestion still follows the branch name", async () => {
    const { double, panel } = await browseWith({ requestId: fixtureId(0x603), state: "canceled", code: "CANCELED" });
    const folder = folderField(panel);
    expect(folder.value).toBe("C:\\repo-login");
    expect(document.activeElement).toBe(folder);
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    await type(panel.querySelector<HTMLInputElement>('input[aria-label="New branch name"]')!, "feat/other");
    expect(folder.value).toBe("C:\\repo-other");
    expect(reviews(double)).toHaveLength(0);
  });

  const browseRefusal = async (code: string, expected: string) => {
    const { panel } = await browseWith({ requestId: fixtureId(0x604), state: "rejected", code });
    expect(folderField(panel).value).toBe("C:\\repo-login");
    expect(text(panel.querySelector('[role="alert"]')!)).toBe(expected);
  };
  test("a folder of the other route states the 001 mixed-location text", () => browseRefusal("UNSUPPORTED_REPOSITORY", "The worktree and its Git directories must all lie inside one WSL distro, or all on Windows."));
  test("a failed picker states that Browse can run again", () => browseRefusal("PICKER_FAILED", "The folder picker failed. Select Browse… again."));
  test("another code is no folder", () => browseRefusal("SERVICE_UNAVAILABLE", "Arbareto cannot use the folder picker: SERVICE_UNAVAILABLE."));

  test("Escape restores the earlier dock content", async () => {
    await openAdd();
    const panel = addPanel()!;
    await press(panel.querySelector("input")!, "Escape");
    expect(addPanel()).toBeNull();
  });
});
