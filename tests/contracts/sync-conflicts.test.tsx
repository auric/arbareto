// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { fixtureId } from "./bridge-contract";
import { answer, button, buttons, click, createWorld, keyboardFocus, mountWorkbench, oid, press, settle, succeeded, text, tooltipText, unmountAll, type World } from "./sync-fake";

// tasks.md T068 (feature 003). Spec FR-030, FR-042 to FR-045. Plan D7, D12. Data-model §7, §8. Contract Δ3 `reviewSync` and `sync` abort, continue, skip.

printOrigin("../../src/frontend/sync/ConflictActions.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/NoticeBand.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(unmountAll);

const TOKEN = fixtureId(101);
const TOKEN_2 = fixtureId(102);

const OUTSIDE = "Arbareto blocks changes until you finish it outside Arbareto and select Refresh (F5).";
const SKIP_TOOLTIP = "Skip leaves the current commit out of the rebased branch.";
const RESTORE = (kind: string) => `Git returns the branch, the index, and the working files to their state before the ${kind}.`;
const MERGE_LIMIT = "Git can fail to restore uncommitted changes from before the merge.";
const DISCARD = "Git discards the index and working-file changes of this step.";
const EXEC_TEXT = "This rebase holds exec lines, and Git runs them as shell commands. Arbareto does not run them. Read the todo list, then continue in a terminal.";
const EXEC_COMMAND = "& 'C:\\Program Files\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\repo' rebase --continue";
const NO_SKIP = "Skip is unavailable: Git names no commit at this rebase stop.";
const UNKNOWN = "Arbareto cannot identify the Git operation in progress.";

const conflicted = (path: string): ChangeEntry => ({ entryId: crypto.randomUUID(), category: "conflicted", path, pathBytes: Buffer.from(path).toString("base64") }) as ChangeEntry;
const band = () => document.querySelector('[data-slot="notice-band"]')!;
const row = () => band().querySelector('[data-slot="conflict-row"]');
const actions = () => [...(row()?.querySelectorAll<HTMLElement>("button") ?? [])].map((b) => b.getAttribute("aria-label") ?? text(b)).filter((b) => b !== "Copy command");
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
const refused = (reason: string, fields: Record<string, unknown> = {}) => ({ requestId: "r", state: "failed", code: "SYNC_UNAVAILABLE", result: { reason, ...fields } });
// A rebase in progress detaches HEAD.
const DETACHED: World["head"] = { state: "detached", oid: oid(1) };

async function open(operationState: World["operationState"], entries: ChangeEntry[] = []) {
  const w = createWorld({ operationState, entries, ...(operationState === "rebasing" ? { head: DETACHED } : {}) });
  const double = await mountWorkbench(workbench, w);
  return { double, w };
}

describe("conflict row (FR-030)", () => {
  test("a merge in progress shows at once with its kind, Abort and Continue, no Skip, and no 001 outside text", async () => {
    await open("merging", [conflicted("a.txt")]);
    expect(row()).not.toBeNull();
    expect(text(band())).toContain("A merge is in progress, with 1 conflicted file.");
    expect(text(band())).not.toContain(OUTSIDE);
    expect(actions()).toEqual(["Abort…", "Continue"]);
    expect(button("Abort…", row()!).querySelector("svg")).not.toBeNull();
  });

  test("a rebase in progress offers Abort, Continue, and Skip, and the Skip tooltip states that it leaves the commit out (FR-044)", async () => {
    await open("rebasing");
    expect(text(band())).toContain("A rebase is in progress.");
    expect(text(band())).not.toContain(OUTSIDE);
    expect(actions()).toEqual(["Abort…", "Continue", "Skip…"]);
    await keyboardFocus(button("Skip…", row()!));
    expect(tooltipText()).toBe(SKIP_TOOLTIP);
  });

  test("Continue is unavailable while the unmerged count is above 0 and states the count (FR-043)", async () => {
    for (const [entries, reason] of [
      [[conflicted("a.txt")], "Continue is unavailable while 1 file is unmerged. Mark it resolved first."],
      [[conflicted("a.txt"), conflicted("b.txt")], "Continue is unavailable while 2 files are unmerged. Mark them resolved first."],
    ] as const) {
      const { double } = await open("rebasing", [...entries]);
      const cont = button("Continue", row()!);
      expect(cont.getAttribute("aria-disabled")).toBe("true");
      expect(text(row()!)).toContain(reason);
      expect(document.getElementById(cont.getAttribute("aria-describedby")!)?.textContent).toBe(reason);
      await click(cont);
      expect(double.count("reviewSync")).toBe(0);
      await unmountAll();
    }
  });

  test("a state that Git's markers do not establish offers no action", async () => {
    await open("unknown");
    expect(row()).toBeNull();
    expect(text(band())).toContain(UNKNOWN);
    expect(buttons("Abort…")).toHaveLength(0);
    expect(buttons("Continue")).toHaveLength(0);
  });
});

describe("Abort (FR-042)", () => {
  for (const kind of ["merge", "rebase"] as const) {
    test(`Abort of a ${kind} opens a confirmation that states what Git restores, with Cancel focused`, async () => {
      const { double } = await open(kind === "merge" ? "merging" : "rebasing");
      await click(button("Abort…", row()!));
      const review = double.pending("reviewSync")!;
      expect(review.args[1]).toEqual({ action: "abort" });
      await answer(review, succeeded({ action: "abort", plan: { remotes: [], operationState: kind === "merge" ? "merging" : "rebasing" }, syncReviewToken: TOKEN }));
      const d = dialog()!;
      expect(d).not.toBeNull();
      expect(text(d)).toContain(`Abort the ${kind}?`);
      expect(text(d)).toContain(RESTORE(kind));
      if (kind === "merge") expect(text(d)).toContain(MERGE_LIMIT);
      else expect(text(d)).not.toContain(MERGE_LIMIT);
      expect(document.activeElement).toBe(button("Cancel", d));
      await click(button("Cancel", d));
      expect(dialog()).toBeNull();
      expect(double.count("sync")).toBe(0);
      await click(button("Abort…", row()!));
      await answer(double.pending("reviewSync"), succeeded({ action: "abort", plan: { remotes: [], operationState: kind === "merge" ? "merging" : "rebasing" }, syncReviewToken: TOKEN_2 }));
      await click(button(`Abort ${kind}`, dialog()!));
      expect(double.pending("sync")!.args[1]).toEqual({ syncReviewToken: TOKEN_2, start: true });
    });
  }

  test("an abort review without the operation kind starts nothing and opens no confirmation", async () => {
    const { double } = await open("merging");
    await click(button("Abort…", row()!));
    await answer(double.pending("reviewSync"), succeeded({ action: "abort", plan: { remotes: [] }, syncReviewToken: TOKEN }));
    expect(dialog()).toBeNull();
    expect(double.count("sync")).toBe(0);
  });
});

describe("Continue (FR-043, FR-045)", () => {
  test("Continue starts after its review without a confirmation, and a rebase that stops again shows the row again", async () => {
    const { double, w } = await open("rebasing");
    await click(button("Continue", row()!));
    const review = double.pending("reviewSync")!;
    expect(review.args[1]).toEqual({ action: "continue" });
    await answer(review, succeeded({ action: "continue", plan: { remotes: [], operationState: "rebasing" }, syncReviewToken: TOKEN }));
    expect(dialog()).toBeNull();
    const start = double.pending("sync")!;
    expect(start.args[1]).toEqual({ syncReviewToken: TOKEN, start: true });
    w.entries = [conflicted("c.txt")];
    await answer(start, { requestId: "r", operationId: "o", state: "failed-with-effects", code: "FAILED_WITH_EFFECTS", result: { action: "continue", integration: { state: "stopped", operation: "rebasing", unmerged: 1 } } });
    await settle();
    expect(row()).not.toBeNull();
    expect(text(band())).toContain("A rebase is in progress, with 1 conflicted file.");
    expect(actions()).toEqual(["Abort…", "Continue", "Skip…"]);
  });

  test("rebase-exec shows its reason and the terminal command, and offers Abort only", async () => {
    const { double } = await open("rebasing");
    await click(button("Continue", row()!));
    await answer(double.pending("reviewSync"), refused("rebase-exec", { remedy: { text: EXEC_TEXT, command: EXEC_COMMAND } }));
    expect(text(row()!)).toContain(EXEC_TEXT);
    expect(text(row()!)).toContain(EXEC_COMMAND);
    expect(buttons("Copy command", row()!)).toHaveLength(1);
    expect(actions()).toEqual(["Abort…"]);
    expect(button("Abort…", row()!).getAttribute("aria-disabled")).not.toBe("true");
  });

  test("unknown-operation shows its reason and offers no action", async () => {
    const { double } = await open("merging");
    await click(button("Continue", row()!));
    await answer(double.pending("reviewSync"), refused("unknown-operation"));
    expect(text(row()!)).toContain(UNKNOWN);
    expect(actions()).toEqual([]);
  });
});

describe("Skip (FR-044)", () => {
  const skipReview = (subject: string | null) => succeeded({ action: "skip", plan: { remotes: [], operationState: "rebasing", skippedCommit: { objectId: oid(77), subject } }, syncReviewToken: TOKEN });

  test("Skip opens a confirmation that names the short ID and subject of the skipped commit and the discarded changes, with Cancel focused", async () => {
    const { double } = await open("rebasing");
    await click(button("Skip…", row()!));
    const review = double.pending("reviewSync")!;
    expect(review.args[1]).toEqual({ action: "skip" });
    await answer(review, skipReview("Fix parser"));
    const d = dialog()!;
    expect(text(d)).toContain(`Skip leaves commit ${oid(77).slice(0, 12)} out of the rebased branch.`);
    expect(text(d)).toContain("Fix parser");
    expect(text(d)).toContain(DISCARD);
    expect(document.activeElement).toBe(button("Cancel", d));
    await click(button("Skip commit", d));
    expect(double.pending("sync")!.args[1]).toEqual({ syncReviewToken: TOKEN, start: true });
  });

  test("a null subject shows the ID only", async () => {
    const { double } = await open("rebasing");
    await click(button("Skip…", row()!));
    await answer(double.pending("reviewSync"), skipReview(null));
    const d = dialog()!;
    expect(text(d)).toContain(oid(77).slice(0, 12));
    expect(d.querySelectorAll("li")).toHaveLength(1);
    expect(text(d.querySelector("li")!)).toBe(oid(77).slice(0, 12));
    await press(d, "Escape");
    expect(dialog()).toBeNull();
    expect(double.count("sync")).toBe(0);
  });

  test("a skip review without the skipped commit starts nothing", async () => {
    const { double } = await open("rebasing");
    await click(button("Skip…", row()!));
    await answer(double.pending("reviewSync"), succeeded({ action: "skip", plan: { remotes: [], operationState: "rebasing" }, syncReviewToken: TOKEN }));
    expect(dialog()).toBeNull();
    expect(double.count("sync")).toBe(0);
  });

  test("no-skip-commit shows its reason and offers no Skip", async () => {
    const { double } = await open("rebasing");
    await click(button("Skip…", row()!));
    await answer(double.pending("reviewSync"), refused("no-skip-commit"));
    expect(text(row()!)).toContain(NO_SKIP);
    expect(actions()).toEqual(["Abort…", "Continue"]);
  });

  test("rebase-exec on Skip offers Abort only", async () => {
    const { double } = await open("rebasing");
    await click(button("Skip…", row()!));
    await answer(double.pending("reviewSync"), refused("rebase-exec", { remedy: { text: EXEC_TEXT, command: null } }));
    expect(text(row()!)).toContain(EXEC_TEXT);
    expect(actions()).toEqual(["Abort…"]);
  });
});

// plan.md "Overflow": the band reserves one layout row for each shown notice row, at most two. The history list takes the rest.
describe("band rows", () => {
  // A wide window gives the history list a computed height (plan.md "Chosen layout, sizes, and DPI").
  type SizedWindow = { happyDOM: { setInnerWidth(width: number): void; setInnerHeight(height: number): void } };
  const happy = () => (window as unknown as SizedWindow).happyDOM;
  let before = { width: 0, height: 0 };
  beforeEach(() => {
    before = { width: window.innerWidth, height: window.innerHeight };
    happy().setInnerWidth(1600);
    happy().setInnerHeight(1000);
  });
  afterEach(() => {
    happy().setInnerWidth(before.width);
    happy().setInnerHeight(before.height);
  });
  const listHeight = () => Number.parseFloat(document.querySelector<HTMLElement>('[data-section="historyList"]')!.style.height);
  const connectFailure = (action: string) => ({ requestId: fixtureId(201), operationId: fixtureId(202), state: "failed", code: "GIT_FAILED", result: { action, connectTarget: true } });
  async function failFetchWithConnect(double: Awaited<ReturnType<typeof mountWorkbench>>) {
    await click(button("Fetch", document.querySelector("header")!));
    await answer(double.pending("reviewSync"), succeeded({ action: "fetch", plan: { remotes: ["origin"] }, syncReviewToken: TOKEN }));
    await answer(double.pending("sync"), connectFailure("fetch"));
  }

  test("the connect row and the conflict row each take a band row", async () => {
    const { double } = await open("merging", [conflicted("a.txt")]);
    const one = listHeight();
    await failFetchWithConnect(double);
    expect(buttons("Connect in a terminal", band())).toHaveLength(1);
    expect(row()).not.toBeNull();
    const two = listHeight();
    expect(two).toBeLessThan(one);
  });

  test("a third row scrolls inside the two reserved rows", async () => {
    const double = await mountWorkbench(workbench, createWorld());
    await click(document.querySelector<HTMLElement>('button[data-slot="pull-main"]')!);
    await answer(double.pending("reviewSync"), succeeded({ action: "pull", plan: { remotes: ["origin"], mode: null }, syncReviewToken: TOKEN }));
    await answer(double.pending("sync"), succeeded({ action: "pull", counts: { ahead: 2, behind: 3 }, integration: { state: "mode-required" }, modeSource: null }));
    const one = listHeight();
    await click(button("Push"));
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination: { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, upstreamRebase: false, source: "push-default-branch" } }, syncReviewToken: TOKEN_2 }));
    await answer(double.pending("sync"), { requestId: fixtureId(203), operationId: fixtureId(204), state: "failed", code: "PUSH_REJECTED", result: { action: "push", push: { status: "rejected", oldObjectId: oid(9), newObjectId: oid(9), reasonText: "fetch first", lease: false, upstreamWritten: false, upstreamNotSet: false, outputTail: "" } } });
    const two = listHeight();
    expect(two).toBeLessThan(one);
    await failFetchWithConnect(double);
    expect(text(band())).toContain("Push rejected.");
    expect(text(band())).toContain("Choose Rebase or Merge for this pull.");
    expect(buttons("Connect in a terminal", band())).toHaveLength(1);
    expect(listHeight()).toBe(two);
  });
});

describe("Continue while the status read loads", () => {
  test("Continue is unavailable with the loading reason until every entry page arrives", async () => {
    const { ConflictRow } = await import("../../src/frontend/sync/ConflictActions");
    const { BLOCKED_TEXT } = await import("../../src/frontend/changes/HunkControls");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    let reviews = 0;
    await act(async () => root.render(<ConflictRow operationState="rebasing" conflicted={0} reason={null} loading onAction={async () => (reviews++, null)} />));
    const cont = button("Continue", host);
    expect(cont.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(cont.getAttribute("aria-describedby")!)?.textContent).toBe(BLOCKED_TEXT.loading);
    await act(async () => cont.click());
    expect(reviews).toBe(0);
    await act(async () => root.unmount());
    host.remove();
  });
});

describe("conflict row while an operation runs (plan D12)", () => {
  const RUNNING = "A Git operation is running. Its progress and Cancel are in the status bar.";
  const describedText = (control: Element) => document.getElementById(control.getAttribute("aria-describedby") ?? "")?.textContent ?? null;
  const visuallyHidden = (control: Element) => document.getElementById(control.getAttribute("aria-describedby")!)!.classList.contains("sr-only");

  test("while a fetch runs, the actions stay disabled and focusable, and the running reason is only in the tooltip and a hidden description", async () => {
    const { double } = await open("rebasing", [conflicted("a.txt")]);
    await click(button("Fetch"));
    await answer(double.pending("reviewSync"), succeeded({ action: "fetch", plan: { remotes: ["origin"] }, syncReviewToken: TOKEN }));
    const sync = double.pending("sync")!;
    await act(async () => (sync.args[2] as (e: unknown) => void)({ requestId: "r", operationId: fixtureId(0x211), state: "running", phase: "sync-fetch", counters: {} }));
    await settle();
    expect(text(row()!)).not.toContain("A Git operation is running. Wait for its result, or select Cancel.");
    for (const label of ["Abort…", "Continue", "Skip…"]) {
      const control = button(label, row()!);
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.tabIndex).toBe(0);
      expect(describedText(control)).toBe(RUNNING);
      expect(visuallyHidden(control)).toBe(true);
      await keyboardFocus(control);
      expect(tooltipText()).toContain(RUNNING);
    }
    await keyboardFocus(button("Skip…", row()!));
    expect(tooltipText()).toContain(SKIP_TOOLTIP);
  });

  test("a reason other than a running operation stays visible", async () => {
    const { ConflictRow } = await import("../../src/frontend/sync/ConflictActions");
    const { BLOCKED_TEXT } = await import("../../src/frontend/changes/HunkControls");
    const { createRoot } = await import("react-dom/client");
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<ConflictRow operationState="rebasing" conflicted={0} reason={BLOCKED_TEXT.unknown} onAction={async () => null} />));
    for (const label of ["Abort…", "Continue", "Skip…"]) {
      const control = button(label, host);
      expect(describedText(control)).toBe(BLOCKED_TEXT.unknown);
      expect(visuallyHidden(control)).toBe(false);
    }
    await act(async () => root.unmount());
    host.remove();
  });
});
