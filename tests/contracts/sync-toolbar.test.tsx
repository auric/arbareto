// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, buttons, click, createWorld, keyboardFocus, menuItem, mountWorkbench, oid, press, settle, succeeded, text, tooltipText, unmountAll, type Call, type World } from "./sync-fake";
import { fixtureId } from "./bridge-contract";

// tasks.md T056 (feature 003). Spec FR-001 to FR-004, FR-017, FR-028, FR-039, FR-041. Plan D2, D12. Contract Δ2, Δ3, Δ8.

printOrigin("../../src/frontend/sync/SyncToolbar.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/status/OperationStatus.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");
const { BLOCKED_TEXT } = await import("../../src/frontend/changes/HunkControls");
const { createShortcutHandler } = await import("../../src/frontend/keyboard/shortcuts");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(unmountAll);

const TOKEN = fixtureId(0x105);
const reviewed = (action: string, plan: Record<string, unknown>) => succeeded({ action, plan: { remotes: ["origin"], ...plan }, syncReviewToken: TOKEN });
const progress = (call: Call, event: Record<string, unknown>) => act(async () => (call.args[2] as (e: unknown) => void)({ requestId: "r", operationId: fixtureId(0x211), counters: {}, ...event }));
const statusText = () => text(document.querySelector("footer")!);
const reasonOf = (control: HTMLElement) => {
  const id = control.getAttribute("aria-describedby");
  return id === null ? null : text(document.getElementById(id)!);
};
const disabled = (control: HTMLElement) => control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true";

async function open(fields: Partial<World> = {}) {
  const world = createWorld(fields);
  const double = await mountWorkbench(workbench, world);
  return { world, double };
}

/** Starts an action from the toolbar and answers its review. It gives the `sync` call. */
async function started(double: Awaited<ReturnType<typeof open>>["double"], control: HTMLElement, action: string, plan: Record<string, unknown> = {}) {
  await click(control);
  const review = double.pending("reviewSync")!;
  expect((review.args[1] as { action: string }).action).toBe(action);
  await answer(review, reviewed(action, plan));
  const sync = double.pending("sync")!;
  expect(sync.args[1]).toEqual({ syncReviewToken: TOKEN, start: true });
  return sync;
}

describe("toolbar controls (FR-039)", () => {
  test("Fetch, Pull, and Push are icon buttons with names, keys, and tooltips that name the action and its key", async () => {
    await open();
    for (const [label, aria, tip] of [
      ["Fetch", "Control+Shift+ArrowDown", "Fetch (Ctrl+Shift+Down)"],
      ["Pull", "Control+ArrowDown", "Pull (Ctrl+Down)"],
      ["Push", "Control+ArrowUp", "Push (Ctrl+Up)"],
    ] as const) {
      const control = button(label);
      expect(control.getAttribute("aria-keyshortcuts")).toBe(aria);
      expect(control.querySelector("svg")).not.toBeNull();
      await keyboardFocus(control);
      expect(tooltipText()).toStartWith(tip);
    }
  });

  test("the Fetch options and Pull options triggers are at least 24 px wide", async () => {
    await open();
    for (const label of ["Fetch options", "Pull options"]) expect(parseFloat(button(label).style.width)).toBeGreaterThanOrEqual(24);
  });

  test("the Pull main part states that the default pull action is still loading", async () => {
    await open({ answers: { readSyncSettings: undefined } });
    expect(reasonOf(document.querySelector<HTMLElement>('button[data-slot="pull-main"]')!)).toContain("The default pull action is still loading…");
  });

  test("a menu beside Fetch offers Fetch all remotes, and its item sends reviewSync fetch-all", async () => {
    const { double } = await open();
    const trigger = button("Fetch options");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await click(trigger);
    await click(menuItem("Fetch all remotes"));
    expect(double.pending("reviewSync")!.args[1]).toEqual({ action: "fetch-all" });
  });

  test("no Git network operation starts at open, at focus return, or on a timer (FR-041)", async () => {
    const { double } = await open();
    await act(async () => void window.dispatchEvent(new Event("blur")));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 1200))));
    expect(double.count("reviewSync")).toBe(0);
    expect(double.count("sync")).toBe(0);
  });
});

describe("unavailable reasons (FR-017, FR-028)", () => {
  test("a detached checkout makes Pull and Push unavailable with the visible reason; Fetch stays available", async () => {
    await open({ head: { state: "detached", oid: oid(1) }, branches: [] });
    for (const label of ["Pull", "Push"]) {
      expect(disabled(button(label))).toBe(true);
      expect(reasonOf(button(label))).toContain("No branch checked out");
    }
    expect(disabled(button("Fetch"))).toBe(false);
  });

  test("an unborn branch makes Pull and Push unavailable with the visible reason", async () => {
    await open({ head: { state: "unborn", target: "refs/heads/main" }, branches: [], oids: [] });
    for (const label of ["Pull", "Push"]) {
      expect(disabled(button(label))).toBe(true);
      expect(reasonOf(button(label))).toContain("The branch has no commits yet.");
    }
  });

  test("a branch without an upstream makes Pull unavailable; Push stays available for the panel", async () => {
    await open({ branches: [{ name: "main", objectId: oid(1), upstream: null, upstreamObjectId: null, track: { state: "none" }, current: true }], remotes: [] });
    expect(disabled(button("Pull"))).toBe(true);
    expect(reasonOf(button("Pull"))).toContain("The branch has no upstream.");
    expect(disabled(button("Push"))).toBe(false);
  });

  test("an operation in progress makes Pull and Push unavailable; Fetch stays available", async () => {
    await open({ operationState: "merging" });
    for (const label of ["Pull", "Push"]) {
      expect(disabled(button(label))).toBe(true);
      expect(reasonOf(button(label))).toContain(BLOCKED_TEXT.operation);
    }
    expect(disabled(button("Fetch"))).toBe(false);
  });

  // Contract Δ3 `reviewSync`: pull checks the operation state before the HEAD form, and push checks the HEAD form first.
  test("a rebase with a detached HEAD gives Pull the Notices band reason and Push the detached reason", async () => {
    await open({ operationState: "rebasing", head: { state: "detached", oid: oid(1) } });
    expect(disabled(button("Pull"))).toBe(true);
    expect(reasonOf(button("Pull"))).toContain(BLOCKED_TEXT.operation);
    expect(disabled(button("Push"))).toBe(true);
    expect(reasonOf(button("Push"))).toContain("No branch checked out.");
    expect(disabled(button("Fetch"))).toBe(false);
  });

  // Feature 003 FR-030: only a merge or a rebase has the conflict row. Every other state keeps the 001 text.
  test("an operation without the conflict row keeps the 001 reason", async () => {
    for (const operationState of ["cherry-picking", "reverting", "sequencer-active", "unknown", "conflicted"] as const) {
      await open({ operationState });
      expect(reasonOf(button("Pull"))).toContain(BLOCKED_TEXT.conflicted);
      expect(reasonOf(button("Pull"))).not.toContain(BLOCKED_TEXT.operation);
      await unmountAll();
    }
  });

  test("a missing remote shows at the review: the toolbar keeps Fetch available and shows the typed refusal", async () => {
    const { double } = await open();
    await click(button("Fetch"));
    await answer(double.pending("reviewSync"), { requestId: "r", state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "remote-missing" } });
    expect(statusText()).toContain("SYNC_UNAVAILABLE");
    expect(statusText()).toContain("remote-missing");
    expect(double.count("sync")).toBe(0);
  });
});

describe("progress (FR-002, FR-003)", () => {
  test("a fetch shows Fetching from <remote>… with Cancel, and a percentage only from the event percent", async () => {
    const { double } = await open();
    const sync = await started(double, button("Fetch"), "fetch");
    await progress(sync, { state: "running", phase: "sync-fetch" });
    expect(statusText()).toContain("Fetching from origin…");
    expect(statusText()).not.toContain("%");
    expect(buttons("Cancel")).toHaveLength(1);
    await progress(sync, { state: "running", phase: "sync-fetch", counters: { percent: 42 } });
    expect(statusText()).toContain("42%");
    await click(button("Cancel"));
    expect(double.pending("cancel")!.args[0]).toEqual({ operationId: fixtureId(0x211) });
  });

  test("pull, merge, rebase, and push steps show their texts", async () => {
    const { double } = await open();
    const pull = await started(double, button("Pull"), "pull");
    await progress(pull, { state: "running", phase: "sync-fetch" });
    expect(statusText()).toContain("Pulling from origin…");
    await progress(pull, { state: "running", phase: "sync-rebase" });
    expect(statusText()).toContain("Rebasing…");
    await progress(pull, { state: "running", phase: "sync-merge" });
    expect(statusText()).toContain("Merging…");
    await answer(pull, { requestId: "r", operationId: fixtureId(0x211), state: "succeeded", result: { action: "pull", integration: { state: "done" } } });
    const push = await started(double, button("Push"), "push", { remotes: ["upstream"], destination: { remote: "upstream", ref: "refs/heads/main", trackingRef: "refs/remotes/upstream/main", url: "https://example.invalid/r.git", setUpstream: false, source: "push-default-branch" } });
    await progress(push, { state: "running", phase: "sync-push" });
    expect(statusText()).toContain("Pushing to upstream…");
  });

  test("Fetch all remotes names the remote of the event remoteIndex", async () => {
    const { double } = await open();
    await click(button("Fetch options"));
    const sync = await started(double, menuItem("Fetch all remotes"), "fetch-all", { remotes: ["origin", "upstream"] });
    await progress(sync, { state: "running", phase: "sync-fetch", counters: { remoteIndex: 2, remoteCount: 2 } });
    expect(statusText()).toContain("Fetching from upstream…");
  });

  test("the stall notice names a hidden prompt and a sign-in window, and offers Cancel and the copyable command", async () => {
    const { double } = await open();
    const sync = await started(double, button("Fetch"), "fetch");
    await progress(sync, { state: "running", phase: "sync-fetch", stalled: true });
    const command = "& 'C:\\Git\\cmd\\git.exe' --no-lazy-fetch -C 'C:\\repo' fetch -- 'origin'";
    await answer(double.pending("getOperation"), succeeded({ operationId: fixtureId(0x211), operation: "sync", state: "running", stalled: true, stallRemedy: { text: "Run this command in a terminal.", command } }));
    const notice = document.querySelector('[data-slot="stall-notice"]')!;
    expect(text(notice)).toContain("prompt");
    expect(text(notice)).toContain("sign-in window");
    expect(text(notice)).toContain(command);
    expect(buttons("Copy command")).toHaveLength(1);
    expect(buttons("Cancel")).toHaveLength(1);
  });

  test("the status names a sync by its action, and a canceled push states that the remote can hold it", async () => {
    const { double } = await open();
    const sync = await started(double, button("Push"), "push", { destination: { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, source: "push-default-branch" } });
    await answer(sync, { requestId: "r", operationId: fixtureId(0x211), state: "canceled", result: { action: "push" } });
    expect(statusText()).toContain("Push canceled");
    expect(statusText()).toContain("The remote can hold this push. Fetch to see the remote state.");
  });
});

describe("outcome (FR-004, FR-039)", () => {
  test("after an outcome, the renderer runs readWorkspace, readRefs, and readTracking", async () => {
    const { double } = await open();
    const sync = await started(double, button("Fetch"), "fetch");
    const before = { workspace: double.count("readWorkspace"), refs: double.count("readRefs"), tracking: double.count("readTracking") };
    await answer(sync, { requestId: "r", operationId: fixtureId(0x211), state: "failed", code: "GIT_FAILED", result: { action: "fetch", fetch: { remotes: [{ name: "origin", state: "failed", updates: [], counts: {}, outputTail: "" }], observed: [] } } });
    await settle();
    expect(double.count("readWorkspace")).toBeGreaterThan(before.workspace);
    expect(double.count("readRefs")).toBeGreaterThan(before.refs);
    expect(double.count("readTracking")).toBeGreaterThan(before.tracking);
  });

  test("Fetch all remotes lists each remote with its outcome", async () => {
    const { double } = await open();
    await click(button("Fetch options"));
    const sync = await started(double, menuItem("Fetch all remotes"), "fetch-all", { remotes: ["origin", "upstream"] });
    const remote = (name: string, state: string) => ({ name, state, updates: [], counts: {}, outputTail: "" });
    await answer(sync, { requestId: "r", operationId: fixtureId(0x211), state: "failed", code: "GIT_FAILED", result: { action: "fetch-all", fetch: { remotes: [remote("origin", "succeeded"), remote("upstream", "failed")], observed: [] } } });
    const area = text(document.querySelector('section[data-slot="status-area"]')!);
    expect(area).toContain("origin: Fetched");
    expect(area).toContain("upstream: Failed");
  });
});

describe("keys (plan D12)", () => {
  test("Ctrl+Shift+Down fetches, Ctrl+Down runs the Pull main part, and Ctrl+Up pushes", async () => {
    const { double } = await open();
    for (const [key, shift, action] of [
      ["ArrowDown", true, "fetch"],
      ["ArrowDown", false, "pull"],
      ["ArrowUp", false, "push"],
    ] as const) {
      await press(document.body, key, { ctrlKey: true, shiftKey: shift });
      const review = double.pending("reviewSync")!;
      expect((review.args[1] as { action: string }).action).toBe(action);
      await answer(review, { requestId: "r", state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "no-remotes" } });
    }
  });

  test("the keys do nothing in a text field", async () => {
    const { double } = await open();
    const field = document.querySelector<HTMLInputElement>('section[aria-label="History"] input')!;
    await act(async () => field.focus());
    await press(field, "ArrowDown", { ctrlKey: true });
    await press(field, "ArrowUp", { ctrlKey: true });
    expect(double.count("reviewSync")).toBe(0);
  });

  // Conflict check against the 001 map (tests/contracts/shortcuts.test.ts) and the 002 keys: no existing action uses Ctrl+Up, Ctrl+Down, or Ctrl+Shift+Down.
  test("the sync keys do not change the 001 and 002 shortcut actions", () => {
    const handle = createShortcutHandler();
    const event = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean }, path: unknown[]) => ({
      type: "keydown",
      key,
      code: key,
      ctrlKey: mods.ctrl ?? false,
      shiftKey: mods.shift ?? false,
      altKey: mods.alt ?? false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      getModifierState: () => false,
      preventDefault() {},
      composedPath: () => path,
    });
    const pane = { tagName: "SECTION" };
    const context = { messageField: null, comparisonPane: pane, modalOpen: false, menuOpen: false, commitEnabled: false };
    expect(handle(event("ArrowDown", { alt: true }, [pane]) as never, context)).toEqual({ type: "selectHunk", direction: "next" });
    expect(handle(event("ArrowUp", { alt: true }, [pane]) as never, context)).toEqual({ type: "selectHunk", direction: "previous" });
    expect(handle(event("ArrowDown", { ctrl: true, alt: true }, [pane]) as never, context)).toBeNull();
    expect(handle(event("ArrowDown", { ctrl: true }, [pane]) as never, context)).toEqual({ type: "sync", control: "pull" });
    expect(handle(event("ArrowDown", { ctrl: true, shift: true }, [pane]) as never, context)).toEqual({ type: "sync", control: "fetch" });
    expect(handle(event("ArrowUp", { ctrl: true }, [pane]) as never, context)).toEqual({ type: "sync", control: "push" });
    expect(handle(event("ArrowUp", { ctrl: true, shift: true }, [pane]) as never, context)).toBeNull();
    expect(handle(event("ArrowDown", { ctrl: true }, [pane]) as never, { ...context, menuOpen: true })).toBeNull();
    expect(handle(event("ArrowDown", { ctrl: true }, [{ tagName: "TEXTAREA" }]) as never, context)).toBeNull();
  });
});
