// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { MERGE_MESSAGE_BYTES } from "../../src/contracts/limits";
import { ReviewWorkbenchResult, RunWorkbenchResult } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import type { IntegratePanelProps } from "../../src/frontend/integrate/IntegratePanel";
import type { StatusOperation } from "../../src/frontend/status/OperationStatus";
import { answer, button, click, keyboardFocus, oid, press, settle, text, tooltipText, type Call } from "./sync-fake";

// tasks.md T041 (feature 004, WP13). Story US3. Spec FR-021 to FR-028. Plan D5, D6, D15, D16. Contract Δ3, Δ5, Δ9.

printOrigin("../../src/frontend/integrate/IntegratePanel.tsx", import.meta.dir);
printOrigin("../../src/frontend/integrate/texts.ts", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { IntegratePanel } = await import("../../src/frontend/integrate/IntegratePanel");
const { ConflictRow } = await import("../../src/frontend/sync/ConflictActions");

const TARGET = { repositoryId: fixtureId(1), repositoryGeneration: 1 };
const LOGIN = { ref: "refs/heads/feature/login", oid: oid(2) };
const TOKEN = fixtureId(10);
const PREVIEW = "Merge branch 'feature/login'\n";

type Facts = { ahead: number; behind: number; fastForward: boolean; mergeFf: { value: "true" | "false" | "only"; source: unknown } };
const facts = (over: Partial<Facts> = {}): Facts => ({ ahead: 2, behind: 2, fastForward: false, mergeFf: { value: "true", source: "default" }, ...over });
const mergePlan = (over: Record<string, unknown> = {}) => ({ source: LOGIN, result: "merge", noFastForward: false, noCommit: false, preview: PREVIEW, message: null, facts: facts(), ...over });
const rebasePlan = (over: Record<string, unknown> = {}) => ({
  onto: LOGIN,
  moved: 2,
  rewritten: 2,
  held: 1,
  forceNote: { trackingRef: "refs/remotes/origin/main" },
  movedBranches: { refs: ["refs/heads/main", "refs/heads/fix/crash-on-start"], more: 0 },
  autostash: { value: true, source: { scope: "local", origin: "file:.git/config" } },
  autosquash: false,
  ...over,
});
// Each fixture result passes the contract result schema.
function reviewed(action: "merge" | "rebase", plan: unknown) {
  const result = ReviewWorkbenchResult.parse({ action, plan, workbenchToken: TOKEN });
  return { requestId: fixtureId(20), operationId: fixtureId(21), state: "succeeded", repositoryGeneration: 1, result };
}
function refused(code: string, result?: Record<string, unknown>) {
  if (result !== undefined) ReviewWorkbenchResult.parse(result);
  return { requestId: fixtureId(20), state: code === "WORKBENCH_UNAVAILABLE" ? "failed" : "rejected", code, ...(result === undefined ? {} : { result }) };
}
function ran(state: string, code: string | undefined, operationState: string, unmerged: number) {
  const result = RunWorkbenchResult.parse({ action: "merge", head: { state: "branch", target: "refs/heads/main", oid: oid(1) }, refs: [], operationState, unmerged, stash: null });
  return { requestId: fixtureId(22), operationId: fixtureId(23), state, ...(code === undefined ? {} : { code }), repositoryGeneration: 1, result };
}

function createDouble() {
  const calls: Call[] = [];
  const make = (operation: string) => (...args: unknown[]) =>
    new Promise((resolve) => {
      const call: Call = { operation, args, done: false, resolve: (r) => void ((call.done = true), resolve(r)) };
      calls.push(call);
    });
  const bridge = contractChecked({ reviewWorkbench: make("reviewWorkbench"), runWorkbench: make("runWorkbench") }) as unknown as IntegratePanelProps["bridge"];
  const of = (operation: string) => calls.filter((c) => c.operation === operation);
  return { bridge, calls, of, pending: (operation: string) => of(operation).find((c) => !c.done) };
}
type Double = ReturnType<typeof createDouble>;
const payloads = (d: Double) => d.of("reviewWorkbench").map((c) => c.args[1] as Record<string, unknown>);

const roots: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of roots.splice(0)) await unmount();
});
async function render(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  roots.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  return host;
}
type Mount = { double: Double; ended: unknown[]; closed: number[]; opener: HTMLButtonElement; ops: StatusOperation[] };
async function mount(action: "merge" | "rebase", fields: { blockedReason?: string | null; operationRunning?: boolean } = {}): Promise<Mount> {
  const double = createDouble();
  const ended: unknown[] = [];
  const closed: number[] = [];
  const ops: StatusOperation[] = [];
  const opener = document.body.appendChild(document.createElement("button"));
  opener.textContent = "opener";
  opener.focus();
  const request = action === "merge" ? { action, ref: LOGIN.ref, name: "feature/login" } : { action, ref: LOGIN.ref, name: "feature/login" };
  await render(
    <IntegratePanel
      request={request}
      current="main"
      bridge={double.bridge}
      target={TARGET}
      blockedReason={fields.blockedReason ?? null}
      operationRunning={fields.operationRunning ?? false}
      onOperation={(op) => ops.push(op)}
      onEnded={(response) => ended.push(response)}
      onClose={() => closed.push(1)}
    />,
  );
  return { double, ended, closed, opener, ops };
}
const panel = () => document.querySelector("section[aria-labelledby]")!;
const input = (label: string) => {
  const found = [...document.querySelectorAll("label")].find((l) => text(l).startsWith(label));
  if (found === undefined) throw new Error(`no control "${label}"`);
  return found.querySelector("input")!;
};
const primary = (label: string) => button(`${label} (Ctrl+Enter)`);
const message = () => document.querySelector<HTMLTextAreaElement>("textarea");
async function setText(area: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

describe("Merge panel (FR-021, FR-022, plan D5)", () => {
  test("states the counts, fast-forward, and merge.ff with its source, and prefills the preview", async () => {
    const { double } = await mount("merge");
    expect(payloads(double)).toEqual([{ action: "merge", ref: LOGIN.ref, result: "merge", noFastForward: false, noCommit: false, message: null }]);
    expect(primary("Merge").hasAttribute("data-disabled") || primary("Merge").getAttribute("aria-disabled") === "true").toBe(true);
    expect(text(panel())).toContain("Arbareto reads the Git facts.");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    expect(text(panel())).toContain("Merge feature/login into main");
    expect(text(panel())).toContain("feature/login has 2 commits that main lacks.");
    expect(text(panel())).toContain("Fast-forward is not possible: main has 2 commits that feature/login lacks.");
    expect(text(panel())).toContain("merge.ff is not set, so Git uses its default (true).");
    expect(message()!.value).toBe(PREVIEW);
    expect(input("Merge commit").checked).toBe(true);
    expect(input("No fast-forward").checked).toBe(false);
    expect(input("Don't commit").checked).toBe(false);
  });

  test("a possible fast-forward and merge.ff from a file", async () => {
    const { double } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan({ facts: facts({ ahead: 0, fastForward: true, mergeFf: { value: "only", source: { scope: "global", origin: "file:C:/Users/a/.gitconfig" } } }) })));
    expect(text(panel())).toContain("Fast-forward is possible.");
    expect(text(panel())).toContain("merge.ff is only in global (file:C:/Users/a/.gitconfig).");
  });

  test("Squash disables No fast-forward and Don't commit, hides the message, and sends no message", async () => {
    const { double } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    await click(input("Squash"));
    expect(input("No fast-forward").disabled).toBe(true);
    expect(input("Don't commit").disabled).toBe(true);
    expect(text(panel())).toContain("Git refuses No fast-forward with Squash.");
    expect(text(panel())).toContain("Squash never commits.");
    expect(message()).toBeNull();
    expect(text(panel())).toContain("Stage all changes as one. No merge commit. You commit later.");
    expect(payloads(double).at(-1)).toEqual({ action: "merge", ref: LOGIN.ref, result: "squash", noFastForward: false, noCommit: false, message: null });
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan({ result: "squash" })));
    const before = double.of("reviewWorkbench").length;
    await press(primary("Merge"), "Enter", { ctrlKey: true });
    expect(double.of("reviewWorkbench").length).toBe(before + 1);
    expect(payloads(double).at(-1)).toEqual({ action: "merge", ref: LOGIN.ref, result: "squash", noFastForward: false, noCommit: false, message: null });
  });

  test("Don't commit with a possible fast-forward selects No fast-forward and locks it", async () => {
    const { double } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan({ facts: facts({ ahead: 0, fastForward: true }) })));
    await click(input("Don't commit"));
    expect(input("No fast-forward").checked).toBe(true);
    expect(input("No fast-forward").disabled).toBe(true);
    expect(text(panel())).toContain("Git fast-forwards without a merge commit, so Don't commit needs No fast-forward.");
    expect(payloads(double).at(-1)).toMatchObject({ result: "merge", noFastForward: true, noCommit: true });
  });

  test("merge.ff false makes Squash unavailable with reason squash-no-ff", async () => {
    const { double } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan({ facts: facts({ mergeFf: { value: "false", source: { scope: "local", origin: "file:.git/config" } } }) })));
    expect(input("Squash").disabled).toBe(true);
    expect(text(panel())).toContain("merge.ff is false in local (file:.git/config), so Git refuses Squash.");
  });

  test("the editor enforces MERGE_MESSAGE_BYTES, and an edited message is sent", async () => {
    const { double } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    // Two UTF-8 bytes per code point: the byte bound, not the code point count, decides.
    await setText(message()!, "é".repeat(MERGE_MESSAGE_BYTES / 2 + 1));
    expect(text(panel())).toContain("The merge message is above 8 KiB (8,192 UTF-8 bytes), the limit of the Git command line.");
    expect(primary("Merge").getAttribute("aria-disabled") === "true" || primary("Merge").hasAttribute("disabled")).toBe(true);
    const reviews = double.of("reviewWorkbench").length;
    await press(primary("Merge"), "Enter", { ctrlKey: true });
    expect(double.of("reviewWorkbench").length).toBe(reviews);
    await setText(message()!, "Merge the login form");
    expect(text(panel())).not.toContain("above 8 KiB");
    await press(message()!, "Enter", { ctrlKey: true });
    expect(payloads(double).at(-1)).toEqual({ action: "merge", ref: LOGIN.ref, result: "merge", noFastForward: false, noCommit: false, message: "Merge the login form" });
  });

  test("a preview above the bound makes Merge commit unavailable with message-size", async () => {
    const { double } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), refused("WORKBENCH_UNAVAILABLE", { reason: "message-size", plan: mergePlan({ preview: null }) }));
    expect(text(panel())).toContain("feature/login has 2 commits that main lacks.");
    expect(text(panel())).toContain("The merge message is above 8 KiB (8,192 UTF-8 bytes), the limit of the Git command line.");
    expect(primary("Merge").getAttribute("aria-disabled") === "true" || primary("Merge").hasAttribute("disabled")).toBe(true);
  });

  test("ff-only keeps the facts and states the reason", async () => {
    const { double } = await mount("merge");
    const plan = mergePlan({ facts: facts({ mergeFf: { value: "only", source: { scope: "local", origin: "file:.git/config" } } }) });
    await answer(double.pending("reviewWorkbench"), refused("WORKBENCH_UNAVAILABLE", { reason: "ff-only", plan }));
    expect(text(panel())).toContain("Fast-forward is not possible");
    expect(text(panel())).toContain("merge.ff is only in local (file:.git/config), and Git cannot fast-forward here. Select No fast-forward to create a merge commit.");
  });
});

describe("Refusal texts (plan D15)", () => {
  const cases: [action: "merge" | "rebase", code: string, reason: string | undefined, expected: string][] = [
    ["merge", "WORKBENCH_UNAVAILABLE", "merge-options", "branch.main.mergeoptions sets merge options that Arbareto cannot check. Remove the setting to merge here, or merge in a terminal."],
    ["merge", "WORKBENCH_UNAVAILABLE", "unknown-operation", "Arbareto cannot tell which operation is in progress. Finish it in a terminal."],
    ["rebase", "WORKBENCH_UNAVAILABLE", "invalid-config", "A Git setting has a value that Git cannot read, so Git stops the rebase. Correct the setting first."],
    ["merge", "TRUST_REQUIRED", undefined, "This action runs programs of this repository. Trust the repository first with the trust chip in the status bar."],
    ["rebase", "TRUST_REQUIRED", undefined, "This action runs programs of this repository. Trust the repository first with the trust chip in the status bar."],
    ["merge", "OPERATION_IN_PROGRESS", undefined, "A Git operation is in progress. Finish it first."],
    ["rebase", "WORKBENCH_UNAVAILABLE", "detached", "HEAD is detached. Switch to a branch first."],
    ["merge", "WORKBENCH_UNAVAILABLE", "unborn", "The current branch has no commit yet."],
    ["merge", "WORKBENCH_UNAVAILABLE", "same-branch", "feature/login is the current branch. Select another branch to merge into it."],
    ["rebase", "WORKBENCH_UNAVAILABLE", "same-branch", "feature/login is the current branch. Select another branch to rebase onto."],
    ["merge", "CONFLICTED", "1", "Resolve the 1 conflicted file first."],
    ["rebase", "CONFLICTED", "3", "Resolve the 3 conflicted files first."],
  ];
  for (const [action, code, reason, expected] of cases) {
    test(`${action} ${reason ?? code}`, async () => {
      const { double } = await mount(action);
      // A CONFLICTED case carries the unmerged count in `reason`.
      const result = code === "CONFLICTED" ? { unmerged: Number(reason) } : reason === undefined ? undefined : { reason };
      await answer(double.pending("reviewWorkbench"), refused(code, result));
      expect(text(panel())).toContain(expected);
      expect(primary(action === "merge" ? "Merge" : "Rebase").getAttribute("aria-describedby")).not.toBeNull();
    });
  }

  test("a succeeded review without a token names the unknown form (plan D15)", async () => {
    const { double } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), { requestId: fixtureId(0x5f0), state: "succeeded", repositoryGeneration: 1, result: {} });
    expect(text(panel())).toContain("Merge did not complete: the result has an unknown form.");
    expect(text(panel())).not.toContain("succeeded");
  });

  test("apply-backend names the scope and file, and Autosquash selects the merge backend", async () => {
    const { double } = await mount("rebase");
    await answer(double.pending("reviewWorkbench"), refused("WORKBENCH_UNAVAILABLE", { reason: "apply-backend" }));
    // The refusal carries no plan, so the source is not known. The text names the setting only.
    expect(text(panel())).toContain("rebase.backend is apply, so Git ignores rebase.updateRefs. Select Autosquash to use the merge backend, or rebase in a terminal.");
    await click(input("Autosquash"));
    expect(payloads(double).at(-1)).toEqual({ action: "rebase", ref: LOGIN.ref, autostash: false, autosquash: true });
  });

  test("dirty-tree keeps the facts", async () => {
    const { double } = await mount("rebase");
    await answer(double.pending("reviewWorkbench"), refused("WORKBENCH_UNAVAILABLE", { reason: "dirty-tree", plan: rebasePlan({ autostash: { value: false, source: "default" } }) }));
    expect(text(panel())).toContain("Commit or stash your changes, or select Autostash.");
    expect(text(panel())).toContain("Moves the 2 commits of main that feature/login lacks on top of feature/login.");
  });

  test("a blocked workbench keeps the primary action unavailable", async () => {
    const { double } = await mount("merge", { blockedReason: "Unavailable while another operation runs." });
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    expect(text(panel())).toContain("Unavailable while another operation runs.");
    await press(primary("Merge"), "Enter", { ctrlKey: true });
    expect(double.of("runWorkbench").length).toBe(0);
  });

  test("while an operation runs, the running reason is only in the hidden description and the tooltip (plan D15 running rule)", async () => {
    const RUNNING = "A Git operation is running. Its progress and Cancel are in the status bar.";
    const { double } = await mount("merge", { blockedReason: RUNNING, operationRunning: true });
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    const described = document.getElementById(primary("Merge").getAttribute("aria-describedby")!)!;
    expect(described.textContent).toBe(RUNNING);
    expect(described.classList.contains("sr-only")).toBe(true);
    await keyboardFocus(primary("Merge"));
    expect(tooltipText()).toBe(RUNNING);
  });
});

describe("Rebase panel (FR-024 to FR-026, plan D6)", () => {
  test("states the moved, rewritten, and held counts, the force note, the moved branches, and the options", async () => {
    const { double } = await mount("rebase");
    expect(payloads(double)[0]).toEqual({ action: "rebase", ref: LOGIN.ref, autostash: false, autosquash: false });
    await answer(double.pending("reviewWorkbench"), reviewed("rebase", rebasePlan()));
    const all = text(panel());
    expect(all).toContain("Rebase main onto feature/login");
    expect(all).toContain("Moves the 2 commits of main that feature/login lacks on top of feature/login.");
    expect(all).toContain("The rebase rewrites 2 commits. A remote-tracking branch holds 1 of them.");
    expect(all).toContain("The rebase rewrites commits that origin/main holds, so the next push needs Force push with lease.");
    expect(all).toContain("These branches may move with the rebase:");
    expect([...panel().querySelectorAll("li")].map((li) => text(li))).toEqual(["main", "fix/crash-on-start"]);
    expect(input("Autostash").checked).toBe(true);
    expect(all).toContain("From rebase.autoStash in local (file:.git/config).");
    expect(input("Autosquash").checked).toBe(false);
    expect(input("Interactive").disabled).toBe(true);
    expect(all).toContain("Not in this version");
    // Autostash from the plan is a new choice, so the review runs again with it.
    expect(payloads(double).at(-1)).toEqual({ action: "rebase", ref: LOGIN.ref, autostash: true, autosquash: false });
  });

  test("no force note without forceNote, no list without movedBranches, and the default source", async () => {
    const { double } = await mount("rebase");
    await answer(double.pending("reviewWorkbench"), reviewed("rebase", rebasePlan({ forceNote: null, movedBranches: null, held: 0, autostash: { value: false, source: "default" } })));
    const all = text(panel());
    expect(all).not.toContain("Force push with lease");
    expect(all).not.toContain("These branches may move");
    expect(all).toContain("rebase.autoStash is not set, so Autostash starts off.");
    expect(input("Autostash").checked).toBe(false);
  });

  test("the moved-branch list states the count above the listed branches", async () => {
    const { double } = await mount("rebase");
    await answer(double.pending("reviewWorkbench"), reviewed("rebase", rebasePlan({ movedBranches: { refs: ["refs/heads/a"], more: 3 } })));
    expect(text(panel())).toContain("3 more branches may move.");
  });
});

describe("Run, conflicts, and keys (FR-023, FR-027, plan D15)", () => {
  test("Ctrl+Enter reviews again, runs the token, and a stop with conflicts closes the panel for the 003 conflict row", async () => {
    const { double, ended, closed } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    await press(input("No fast-forward"), "Enter", { ctrlKey: true });
    expect(double.of("runWorkbench").length).toBe(0);
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    expect(double.of("runWorkbench")[0]!.args.slice(0, 2)).toEqual([{ repositoryId: TARGET.repositoryId }, { workbenchToken: TOKEN, start: true }]);
    expect(text(panel())).toContain("The merge runs.");
    const response = ran("failed-with-effects", "FAILED_WITH_EFFECTS", "merging", 2);
    await answer(double.pending("runWorkbench"), response);
    expect(ended).toEqual([response]);
    expect(closed.length).toBe(1);
    // The panel holds no conflict action of its own.
    expect([...document.querySelectorAll("button")].some((b) => ["Abort…", "Abort merge…", "Abort rebase…", "Continue", "Skip"].includes(text(b)))).toBe(false);
  });

  for (const action of ["merge", "rebase"] as const) {
    test(`a ${action} run reports its start, progress, and outcome as one runWorkbench status operation, so the status bar shows progress and Cancel`, async () => {
      const names: [string, string, string] = action === "merge" ? ["Merge", "Merging", "Merge details"] : ["Rebase", "Rebasing", "Rebase details"];
      const { double, ops } = await mount(action);
      await answer(double.pending("reviewWorkbench"), reviewed(action, action === "merge" ? mergePlan() : rebasePlan({ autostash: { value: false, source: "default" } })));
      await press(primary(names[0]!), "Enter", { ctrlKey: true });
      await answer(double.pending("reviewWorkbench"), reviewed(action, action === "merge" ? mergePlan() : rebasePlan({ autostash: { value: false, source: "default" } })));
      const run = double.pending("runWorkbench")!;
      expect(ops.map((o) => [o.kind, o.texts, o.response])).toEqual([["runWorkbench", names, null]]);
      const event = { requestId: fixtureId(0x5ff), operationId: fixtureId(0x530), state: "running", phase: action, counters: {} };
      await act(async () => (run.args[2] as (e: unknown) => void)(event));
      expect(ops.at(-1)!.progress).toEqual(event as never);
      const response = ran("succeeded", undefined, "normal", 0);
      await answer(run, response);
      expect(ops.at(-1)!.response).toEqual(response as never);
      expect(new Set(ops.map((o) => o.requestId)).size).toBe(1);
    });
  }

  test("a rebase whose new review before the run rewrites other commits shows the new facts and does not run", async () => {
    const { double } = await mount("rebase");
    const plan = (rewritten: number) => rebasePlan({ rewritten, autostash: { value: false, source: "default" } });
    await answer(double.pending("reviewWorkbench"), reviewed("rebase", plan(2)));
    expect(text(panel())).toContain("The rebase rewrites 2 commits.");
    await press(primary("Rebase"), "Enter", { ctrlKey: true });
    await answer(double.pending("reviewWorkbench"), reviewed("rebase", plan(5)));
    expect(double.of("runWorkbench").length).toBe(0);
    expect(text(panel())).toContain("The rebase rewrites 5 commits.");
    expect(text(panel())).not.toContain("The rebase runs.");
    await press(primary("Rebase"), "Enter", { ctrlKey: true });
    await answer(double.pending("reviewWorkbench"), reviewed("rebase", plan(5)));
    expect(double.of("runWorkbench").length).toBe(1);
  });

  test("a merge whose new review before the run finds other counts shows them and does not run", async () => {
    const { double } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    await press(primary("Merge"), "Enter", { ctrlKey: true });
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan({ facts: facts({ behind: 7 }) })));
    expect(double.of("runWorkbench").length).toBe(0);
    expect(text(panel())).toContain("feature/login has 7 commits that main lacks.");
  });

  test("an edited message alone does not count as a changed fact", async () => {
    const { double } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    await setText(message()!, "Merge the login form");
    await press(message()!, "Enter", { ctrlKey: true });
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan({ message: "Merge the login form" })));
    expect(double.of("runWorkbench").length).toBe(1);
  });

  test("a run that fails without a stop stays open with the code", async () => {
    const { double, ended, closed } = await mount("merge");
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    await press(primary("Merge"), "Enter", { ctrlKey: true });
    await answer(double.pending("reviewWorkbench"), reviewed("merge", mergePlan()));
    await answer(double.pending("runWorkbench"), { requestId: fixtureId(22), state: "rejected", code: "STALE_REVIEW" });
    expect(ended.length).toBe(1);
    expect(closed.length).toBe(0);
    expect(text(panel())).toContain("Merge did not complete: STALE_REVIEW");
  });

  test("Escape and Cancel close the panel and restore the focus", async () => {
    const first = await mount("rebase");
    await answer(first.double.pending("reviewWorkbench"), reviewed("rebase", rebasePlan()));
    expect(panel().contains(document.activeElement)).toBe(true);
    await press(input("Autosquash"), "Escape");
    expect(first.closed.length).toBe(1);
    expect(document.activeElement).toBe(first.opener);
    await click(button("Cancel"));
    expect(first.closed.length).toBe(2);
  });

  for (const action of ["merge", "rebase"] as const) {
    test(`the ${action} panel head shows the Accent ${action} glyph before the title, and the foot puts Cancel, then the primary button, at the right (D16, T090)`, async () => {
      await mount(action);
      const heading = panel().querySelector("h2")!;
      const head = heading.parentElement!;
      const glyph = head.firstElementChild!;
      expect(glyph.getAttribute("data-slot")).toBe("panel-icon");
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
      expect(glyph.className.split(/\s+/)).toContain("text-accent-role");
      expect(glyph.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(head.lastElementChild!.getAttribute("aria-label")).toBe(action === "merge" ? "Close merge panel" : "Close rebase panel");
      const foot = panel().querySelector<HTMLElement>('[data-slot="panel-foot"]')!;
      expect(foot.className.split(/\s+/)).toEqual(expect.arrayContaining(["border-t", "justify-end", "px-3", "py-2"]));
      expect([...foot.querySelectorAll("button")].map(text)).toEqual(["Cancel", action === "merge" ? "Merge (Ctrl+Enter)" : "Rebase (Ctrl+Enter)"]);
    });
  }

  test("the 003 conflict row shows Abort in the Removed text (plan D16)", async () => {
    await render(<ConflictRow operationState="rebasing" conflicted={2} reason={null} onAction={async () => null} onResolve={() => {}} />);
    const abort = [...document.querySelectorAll("button")].find((b) => text(b).startsWith("Abort"))!;
    expect(abort.className).toContain("text-removed");
  });
});
