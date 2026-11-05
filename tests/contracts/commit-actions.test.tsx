// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { describedBy, pressKey, statusBar } from "./commit-fake";
import { A, B, C, historyList, keyMenu, menuWorld, P2, pickPlan, popover, radio, refused, resetPlan, reviewed, reviews, short, tagPlan, TOKEN, TOKEN_2 } from "./commit-menu-fake";
import { stubLayout } from "./history-fake";
import { alertDialog } from "./revert-fake";
import { answer, button, buttons, click, menuItem, mountWorkbench, settle, succeeded, text, unmountAll, type World } from "./sync-fake";

// tasks.md T013 (feature 010, WP5). Stories US2, US3, US4. Spec FR-003, FR-006, FR-007, FR-014, FR-020, FR-030, FR-032, FR-034, FR-040, FR-042 to FR-044, FR-050, FR-052, FR-053, SC-009.
// Plan D2 to D5, D11, D13 "Actions hook" and "Hard dialog". Data-model §3, §4, §6.

printOrigin("../../src/frontend/history/CommitActions.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/commit-texts.ts", import.meta.dir);
printOrigin("../../src/frontend/branches/BranchActions.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/RevertConfirm.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(unmountAll);

type Double = Awaited<ReturnType<typeof mountWorkbench>>;
const field = (label: string, from: ParentNode) => [...from.querySelectorAll("label")].find((l) => text(l).startsWith(label))!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
const unavailable = (control: Element) => control.getAttribute("aria-disabled") === "true";
const run = (double: Double) => double.pending("runWorkbench")!;
const ran = (action: string, fields: Record<string, unknown> = {}) => succeeded({ action, head: { state: "branch", target: "refs/heads/main", oid: B }, refs: [], ...fields });

describe("Check out (FR-020, plan D2)", () => {
  const switchPlan = (fields: Record<string, unknown> = {}) => ({ target: { detach: B }, trackedChanges: 3, unreachable: null, heldBy: null, choice: "keep", inTheWay: null, ...fields });

  test("the confirmation names the commit and the detach note, Cancel has the first focus, and Discard names its button", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    await keyMenu(B);
    await click(menuItem("Check out this commit (detached HEAD)…"));
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "switch", target: { detach: B }, choice: "keep" });
    await answer(review, reviewed("switch", switchPlan()));
    const p = popover()!;
    expect(text(p)).toContain(`Check out commit ${short(B)}?`);
    expect(text(p)).toContain("No branch. New commits belong to no branch (detached HEAD).");
    expect(document.activeElement).toBe(button("Cancel", p));
    expect(buttons("Check out", p)).toHaveLength(1);
    await click(radio("Discard changes", p));
    expect(button("Discard and check out", p).className).toContain("danger-button");
    await click(radio("Keep changes", p));
    await click(button("Check out", p));
    expect(run(double).args[1]).toEqual({ workbenchToken: TOKEN, start: true });
    await answer(run(double), succeeded({ action: "switch", head: { state: "detached", oid: B }, refs: [], stash: null, conflicted: 0 }));
    expect(statusBar()).toContain(`Checked out ${short(B)}. HEAD is detached.`);
  });

  test("a clean tree still confirms", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    await keyMenu(B);
    await click(menuItem("Check out this commit (detached HEAD)…"));
    await answer(double.pending("reviewWorkbench"), reviewed("switch", switchPlan({ trackedChanges: 0 })));
    expect(text(popover()!)).toContain(`Check out commit ${short(B)}?`);
    expect(double.count("runWorkbench")).toBe(0);
  });
});

describe("Create tag (FR-030 to FR-034, plan D3)", () => {
  async function openTag(double: Double, signs = { light: false, annotated: false }) {
    await keyMenu(B);
    await click(menuItem("Create tag here…"));
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "create-tag", name: null, target: B, message: null });
    await answer(review, reviewed("create-tag", tagPlan({ signs }), null));
    const p = popover()!;
    return { p, name: field("Tag name", p) as HTMLInputElement, message: field("Message", p) as HTMLTextAreaElement, create: () => button("Create tag", p) };
  }

  test("Lightweight tag is preselected under the Tag kind legend, Tag name has the first focus, and an empty name keeps Create tag unavailable", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const t = await openTag(double);
    expect(text(t.p)).toContain(`Create tag at ${short(B)}`);
    expect(text(t.p.querySelector("fieldset legend")!)).toBe("Tag kind");
    expect(radio("Lightweight tag", t.p).checked).toBe(true);
    expect(radio("Annotated tag", t.p).checked).toBe(false);
    expect(text(t.p)).toContain("A name for this commit. Git stores no message.");
    expect(text(t.p)).toContain("Git stores a tag object with your name, the date, and a message.");
    expect(document.activeElement).toBe(t.name);
    expect(unavailable(t.create())).toBe(true);
    await type(t.name, "v1.0");
    expect(unavailable(t.create())).toBe(false);
  });

  test("the signing facts of the open review: Annotated tag shows the signing line, Lightweight tag shows tag-signing and blocks Create tag; a kind switch starts no review", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const t = await openTag(double, { light: true, annotated: true });
    await type(t.name, "v1.0");
    expect(text(t.p)).toContain("Your Git configuration signs every tag, and a signed tag needs a message. Select Annotated tag.");
    expect(unavailable(t.create())).toBe(true);
    await click(radio("Annotated tag", t.p));
    await type(t.message, "Release");
    expect(text(t.p)).toContain("Git signs this tag. Your Git configuration asks for it.");
    expect(text(t.p)).not.toContain("Select Annotated tag.");
    expect(unavailable(t.create())).toBe(false);
    expect(double.count("reviewWorkbench")).toBe(1);
  });

  test("no signing line shows when the configuration does not sign", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const t = await openTag(double);
    await click(radio("Annotated tag", t.p));
    expect(text(t.p)).not.toContain("Git signs this tag.");
  });

  test("a typed message selects Annotated tag, a switch back to Lightweight tag clears it, and a blank annotated message blocks Create tag", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const t = await openTag(double);
    await type(t.name, "v1.0");
    await type(t.message, "Release notes");
    expect(radio("Annotated tag", t.p).checked).toBe(true);
    await click(radio("Lightweight tag", t.p));
    expect(field("Message", t.p).value).toBe("");
    await click(radio("Annotated tag", t.p));
    expect(unavailable(t.create())).toBe(true);
    expect(describedBy(t.create())).toBe("Type a message for an annotated tag.");
    await type(field("Message", t.p) as HTMLTextAreaElement, "   ");
    expect(unavailable(t.create())).toBe(true);
  });

  test("Create tag reviews again with the name and the message, then runs with the new token and states the outcome", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const t = await openTag(double);
    await type(t.name, "v1.0");
    await type(t.message, "Release");
    await click(t.create());
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "create-tag", name: "v1.0", target: B, message: "Release" });
    await answer(review, reviewed("create-tag", tagPlan({ name: "v1.0", annotated: true }), TOKEN_2));
    expect(run(double).args[1]).toEqual({ workbenchToken: TOKEN_2, start: true });
    await answer(run(double), ran("create-tag", { tag: { name: "v1.0", oid: P2, annotated: true } }));
    expect(statusBar()).toContain(`Created tag v1.0 at ${short(B)}. Arbareto does not push tags.`);
  });

  test("a lightweight tag sends a null message", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const t = await openTag(double);
    await type(t.name, "v1.0");
    await click(t.create());
    expect(reviews(double).at(-1)).toEqual({ action: "create-tag", name: "v1.0", target: B, message: null });
  });

  for (const [reason, shown] of [
    ["invalid-name", "Git does not accept this tag name."],
    ["reserved-name", "Git reads HEAD and @ as names of the current commit. Use another tag name."],
    ["name-exists", "The tag v1.0 exists. Use another name."],
    ["tag-signing", "Your Git configuration signs every tag, and a signed tag needs a message. Select Annotated tag."],
    ["message-size", "The message is too long. Use at most 8 KiB."],
    ["invalid-config", "A tag setting in your Git configuration is not valid, so Git stops."],
  ] as const) {
    test(`the refusal ${reason} shows in the popover after Create tag`, async () => {
      const double = await mountWorkbench(workbench, menuWorld());
      const t = await openTag(double);
      await type(t.name, "v1.0");
      await click(t.create());
      await answer(double.pending("reviewWorkbench"), refused("WORKBENCH_UNAVAILABLE", { reason, ...(reason === "name-exists" ? { ref: "refs/tags/v1.0" } : {}) }));
      expect(text(popover()!.querySelector('[role="alert"]')!)).toBe(shown);
      expect(double.count("runWorkbench")).toBe(0);
    });
  }
});

describe("Reset (FR-040 to FR-044, plan D4)", () => {
  async function openReset(double: Double, plan = resetPlan()) {
    await keyMenu(B);
    await click(menuItem("Reset current branch (main) to here…"));
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "reset", target: B, mode: "mixed" });
    await answer(review, reviewed("reset", plan));
    return popover()!;
  }
  async function hardReview(double: Double, p: HTMLElement, response: unknown) {
    await click(radio("Hard", p));
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "reset", target: B, mode: "hard" });
    await answer(review, response);
    return popover()!;
  }

  test("Mixed is preselected and focused under the Reset mode legend, with each mode hint, and Hard in the danger text", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const p = await openReset(double);
    expect(text(p)).toContain(`Reset main to ${short(B)}?`);
    expect(text(p.querySelector("fieldset legend")!)).toBe("Reset mode");
    expect(radio("Mixed", p).checked).toBe(true);
    expect(document.activeElement).toBe(radio("Mixed", p));
    expect(text(p)).toContain("Git keeps the index and the working files. The differences show as staged changes.");
    expect(text(p)).toContain("Git keeps the working files and resets the index. All changes show as unstaged changes.");
    expect(text(p)).toContain("Git resets the index and the working files. Git deletes all changes to tracked files.");
    expect(radio("Hard", p).closest("label")!.querySelector(".danger-text")).not.toBeNull();
    expect(button("Reset", p).className).not.toContain("danger");
  });

  test("the counts and notes of the plan, in plural and singular forms", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const p = await openReset(double, resetPlan({ leave: 4, gain: 2, reflogOnly: 3, forceNote: { trackingRef: "refs/remotes/origin/main" }, trackedChanges: 3 }));
    expect(text(p)).toContain("4 commits leave main.");
    expect(text(p)).toContain("main gets 2 commits.");
    expect(text(p)).toContain("3 of these commits are on no other branch or tag. Only Git's reflog keeps them for a limited time.");
    expect(text(p)).toContain("The reset removes commits that origin/main holds, so the next push needs Force push with lease.");
    expect(text(p)).toContain("You have 3 changes to tracked files.");
    await unmountAll();
    const second = await mountWorkbench(workbench, menuWorld());
    const one = await openReset(second, resetPlan({ leave: 1, gain: 1, reflogOnly: 1, trackedChanges: 1 }));
    expect(text(one)).toContain("1 commit leaves main.");
    expect(text(one)).toContain("main gets 1 commit.");
    expect(text(one)).toContain("1 of these commits is on no other branch or tag. Only Git's reflog keeps it for a limited time.");
    expect(text(one)).toContain("You have 1 change to tracked files.");
  });

  test("a mode change reviews again, and Reset runs the token of the new review with the outcome text", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const p = await openReset(double);
    await click(radio("Soft", p));
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "reset", target: B, mode: "soft" });
    await answer(review, reviewed("reset", resetPlan({ mode: "soft" }), TOKEN_2));
    await click(button("Reset", popover()!));
    expect(run(double).args[1]).toEqual({ workbenchToken: TOKEN_2, start: true });
    await answer(run(double), ran("reset", { mode: "soft", trackedChanges: 0 }));
    expect(statusBar()).toContain(`Reset main to ${short(B)}.`);
  });

  test("Hard names its button Reset hard… and opens the alert dialog: Cancel first, no default button, Enter on Cancel and Escape change nothing", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const p = await hardReview(double, await openReset(double), reviewed("reset", resetPlan({ mode: "hard", leave: 4, reflogOnly: 3, trackedChanges: 3, ignoredReplaced: 2 }), TOKEN_2));
    const hard = button("Reset hard…", p);
    expect(hard.className).toContain("danger-button");
    await click(hard);
    const d = alertDialog()!;
    expect(d).not.toBeNull();
    expect(text(document.getElementById(d.getAttribute("aria-labelledby")!)!)).toBe(`Reset main hard to ${short(B)}?`);
    expect(text(d)).toContain("Git deletes 3 changes to tracked files, also staged new files. Untracked files stay.");
    expect(text(d)).toContain(`Git replaces 2 ignored files with the files of ${short(B)}.`);
    expect(text(d)).toContain("3 of these commits are on no other branch or tag. Only Git's reflog keeps them for a limited time.");
    expect(text(d)).toContain("You cannot undo this.");
    expect(document.activeElement).toBe(button("Cancel", d));
    expect(d.querySelector("form")).toBeNull();
    expect(d.querySelector('[type="submit"]')).toBeNull();
    expect(d.querySelector("[accesskey]")).toBeNull();
    expect([...d.querySelectorAll("button")].map((b) => text(b))).toEqual(["Cancel", "Reset hard"]);
    await pressKey(button("Cancel", d), "Enter");
    expect(double.count("runWorkbench")).toBe(0);
    await pressKey(document.activeElement ?? d, "Escape");
    await settle();
    expect(alertDialog()).toBeNull();
    expect(double.count("runWorkbench")).toBe(0);
  });

  test("Reset hard runs the reviewed token", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const p = await hardReview(double, await openReset(double), reviewed("reset", resetPlan({ mode: "hard", trackedChanges: 1, ignoredReplaced: 1 }), TOKEN_2));
    await click(button("Reset hard…", p));
    const d = alertDialog()!;
    expect(text(d)).toContain("Git deletes 1 change to tracked files, also staged new files. Untracked files stay.");
    expect(text(d)).toContain(`Git replaces 1 ignored file with the file of ${short(B)}.`);
    expect(text(d)).not.toContain("reflog");
    await click(button("Reset hard", d));
    expect(run(double).args[1]).toEqual({ workbenchToken: TOKEN_2, start: true });
  });

  test("a clean Hard reset states what Git sets", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    const p = await hardReview(double, await openReset(double), reviewed("reset", resetPlan({ mode: "hard" }), TOKEN_2));
    await click(button("Reset hard…", p));
    expect(text(alertDialog()!)).toContain(`Git sets the index and the working files to ${short(B)}.`);
  });

  for (const [more, tail] of [
    [0, "Move or delete them first."],
    [3, "3 more paths do not show. Move or delete them first."],
    [1, "1 more path does not show. Move or delete them first."],
  ] as const) {
    test(`the in-the-way refusal lists the paths and its tail (more ${more}), and offers only Cancel`, async () => {
      const double = await mountWorkbench(workbench, menuWorld());
      const p = await hardReview(double, await openReset(double), refused("UNTRACKED_IN_WAY", { reason: "untracked-in-way", paths: ["docs/guide.md", "src/parser.ts"], more }));
      expect(text(p)).toContain("These untracked paths are in the way of Hard reset:");
      expect([...p.querySelectorAll("li")].map((li) => text(li))).toEqual(["docs/guide.md", "src/parser.ts"]);
      expect(text(p)).toContain(tail);
      if (more === 0) expect(text(p)).not.toContain("do not show");
      expect([...p.querySelectorAll("button")].map((b) => text(b))).toEqual(["Cancel"]);
    });
  }
});

describe("Cherry-pick and Revert (FR-050 to FR-053, plan D5)", () => {
  const mergeWorld = (): World => menuWorld({ parents: { [B]: [C, P2] } });
  const parents = [
    { oid: C, subject: "Commit 2" },
    { oid: P2, subject: "Side change" },
  ];

  test("a plain commit: the popover names the branch, Git's message and author, and Amend last commit; Cherry-pick runs and states the outcome", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    await keyMenu(B);
    await click(menuItem("Cherry-pick commit…"));
    const review = double.pending("reviewWorkbench")!;
    expect(review.args[1]).toEqual({ action: "cherry-pick", commit: B, mainline: null });
    await answer(review, reviewed("cherry-pick", pickPlan()));
    const p = popover()!;
    expect(text(p)).toContain(`Cherry-pick ${short(B)} to main?`);
    expect(text(p)).toContain("Git applies the changes of this commit to main as a new commit. Git copies its message and its author. To change the message, use Amend last commit.");
    expect(p.querySelector('input[type="radio"]')).toBeNull();
    await click(button("Cherry-pick", p));
    expect(run(double).args[1]).toEqual({ workbenchToken: TOKEN, start: true });
    await answer(run(double), ran("cherry-pick", { operationState: "normal", unmerged: 0 }));
    expect(statusBar()).toContain(`Cherry-picked ${short(B)} to main.`);
  });

  test("a merge commit preselects and focuses parent 1, shows the parents of the review, and a parent change reviews again", async () => {
    const double = await mountWorkbench(workbench, mergeWorld());
    await keyMenu(B);
    await click(menuItem("Cherry-pick commit…"));
    expect(reviews(double).at(-1)).toEqual({ action: "cherry-pick", commit: B, mainline: 1 });
    await answer(double.pending("reviewWorkbench"), reviewed("cherry-pick", pickPlan({ parents, mainline: 1 })));
    const p = popover()!;
    expect(text(p.querySelector("fieldset legend")!)).toBe("This is a merge commit. Select the parent that Git compares it with.");
    const first = radio(`Parent 1: ${short(C)} Commit 2`, p);
    expect(first.checked).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(radio(`Parent 2: ${short(P2)} Side change`, p).checked).toBe(false);
    await click(radio("Parent 2", p));
    expect(reviews(double).at(-1)).toEqual({ action: "cherry-pick", commit: B, mainline: 2 });
  });

  test("Revert of a merge commit uses its own legend and title", async () => {
    const double = await mountWorkbench(workbench, mergeWorld());
    await keyMenu(B);
    await click(menuItem("Revert commit…"));
    expect(reviews(double).at(-1)).toEqual({ action: "revert-commit", commit: B, mainline: 1 });
    await answer(double.pending("reviewWorkbench"), reviewed("revert-commit", pickPlan({ parents, mainline: 1 })));
    const p = popover()!;
    expect(text(p)).toContain(`Revert ${short(B)} on main?`);
    expect(text(p)).toContain("Git creates a new commit on main that undoes the changes of this commit. Git writes the commit message. To change it, use Amend last commit.");
    expect(text(p.querySelector("fieldset legend")!)).toBe("This is a merge commit. Select the parent to keep.");
    expect(radio("Parent 1", p).checked).toBe(true);
    await click(button("Revert", p));
    await answer(run(double), ran("revert-commit", { operationState: "normal", unmerged: 0 }));
    expect(statusBar()).toContain(`Reverted ${short(B)} on main.`);
  });

  test("a mainline-needed refusal shows the parent choice with parent 1 preselected and reviews with it", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    await keyMenu(B);
    await click(menuItem("Cherry-pick commit…"));
    await answer(double.pending("reviewWorkbench"), refused("WORKBENCH_UNAVAILABLE", { reason: "mainline-needed", parents }));
    expect(radio("Parent 1", popover()!).checked).toBe(true);
    expect(reviews(double).at(-1)).toEqual({ action: "cherry-pick", commit: B, mainline: 1 });
  });

  for (const [action, item, reason, shown] of [
    ["cherry-pick", "Cherry-pick commit…", "already-on-branch", "main already has this commit."],
    ["cherry-pick", "Cherry-pick commit…", "dirty-tree", "Commit or stash your changes first. Git cherry-picks only onto a clean working tree."],
    ["revert-commit", "Revert commit…", "dirty-tree", "Commit or stash your changes first. Git reverts only on a clean working tree."],
    ["cherry-pick", "Cherry-pick commit…", "not-merge", "This commit is no merge commit."],
  ] as const) {
    test(`${action}: the refusal ${reason} shows its text`, async () => {
      const double = await mountWorkbench(workbench, menuWorld());
      await keyMenu(B);
      await click(menuItem(item));
      await answer(double.pending("reviewWorkbench"), refused("WORKBENCH_UNAVAILABLE", { reason }));
      expect(text(popover()!)).toContain(shown);
    });
  }

  for (const [action, item, unmerged, shown] of [
    ["cherry-pick", "Cherry-pick commit…", 2, "The cherry-pick stopped with 2 conflicted files. Resolve them, then select Continue in the Notices band."],
    ["cherry-pick", "Cherry-pick commit…", 1, "The cherry-pick stopped with 1 conflicted file. Resolve it, then select Continue in the Notices band."],
    ["revert-commit", "Revert commit…", 2, "The revert stopped with 2 conflicted files. Resolve them, then select Continue in the Notices band."],
    ["revert-commit", "Revert commit…", 1, "The revert stopped with 1 conflicted file. Resolve it, then select Continue in the Notices band."],
  ] as const) {
    test(`${action} that stops with ${unmerged} conflicted files states it`, async () => {
      const double = await mountWorkbench(workbench, menuWorld());
      await keyMenu(B);
      await click(menuItem(item));
      await answer(double.pending("reviewWorkbench"), reviewed(action, pickPlan()));
      await click(button(action === "cherry-pick" ? "Cherry-pick" : "Revert", popover()!));
      await answer(run(double), { requestId: "r", operationId: "o", state: "failed-with-effects", code: "FAILED_WITH_EFFECTS", result: { action, head: { state: "branch", target: "refs/heads/main", oid: A }, refs: [], operationState: action === "cherry-pick" ? "cherry-picking" : "reverting", unmerged } });
      expect(statusBar()).toContain(shown);
    });
  }

  test("a stop without conflicts states it and shows the output tail as plain text", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    await keyMenu(B);
    await click(menuItem("Cherry-pick commit…"));
    await answer(double.pending("reviewWorkbench"), reviewed("cherry-pick", pickPlan()));
    await click(button("Cherry-pick", popover()!));
    const tail = "<b>The previous cherry-pick is now empty</b>";
    await answer(run(double), { requestId: "r", operationId: "o", state: "failed-with-effects", code: "FAILED_WITH_EFFECTS", result: { action: "cherry-pick", head: { state: "branch", target: "refs/heads/main", oid: A }, refs: [], operationState: "cherry-picking", unmerged: 0, outputTail: tail } });
    expect(statusBar()).toContain("The cherry-pick stopped. Read the Git output, then select Continue or Abort in the Notices band.");
    const pre = [...document.querySelectorAll("pre")].find((e) => e.textContent === tail);
    expect(pre).toBeDefined();
    expect(pre!.querySelector("b")).toBeNull();
  });

  for (const [action, item, name] of [
    ["cherry-pick", "Cherry-pick commit…", "Cherry-pick"],
    ["revert-commit", "Revert commit…", "Revert commit"],
  ] as const) {
    test(`an expired ${action} review states that nothing changed`, async () => {
      const double = await mountWorkbench(workbench, menuWorld());
      await keyMenu(B);
      await click(menuItem(item));
      await answer(double.pending("reviewWorkbench"), reviewed(action, pickPlan()));
      await click(button(action === "cherry-pick" ? "Cherry-pick" : "Revert", popover()!));
      await answer(run(double), { requestId: "r", state: "rejected", code: "APPROVAL_EXPIRED" });
      expect(statusBar()).toContain(`The review expired. Arbareto changed nothing. Select ${name} again.`);
    });
  }

  test("Cancel closes the popover, runs nothing, and returns the focus to the list", async () => {
    const double = await mountWorkbench(workbench, menuWorld());
    await keyMenu(B);
    await click(menuItem("Cherry-pick commit…"));
    await answer(double.pending("reviewWorkbench"), reviewed("cherry-pick", pickPlan()));
    await click(button("Cancel", popover()!));
    expect(popover()).toBeNull();
    expect(double.count("runWorkbench")).toBe(0);
    expect(document.activeElement).toBe(historyList());
  });
});
