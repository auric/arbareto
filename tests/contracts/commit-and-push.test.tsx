// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { BridgeResponse } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, itemLabel, mountWorkbench, oid, press, settle, snapshot, succeeded, text, unmountAll } from "./sync-fake";
import { commitReviewed, contractChecked, fixtureId } from "./bridge-contract";

// tasks.md T061 (feature 003). Spec FR-038. Plan D12 "Commit and push".

printOrigin("../../src/frontend/commit/CommitTray.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const { createRoot } = await import("react-dom/client");
const workbench = await import("../../src/frontend/app/Workbench");
const { CommitTray } = await import("../../src/frontend/commit/CommitTray");
const { createDrafts } = await import("../../src/frontend/state/drafts");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
const trays: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of trays.splice(0)) await dispose();
  await unmountAll();
});

type Call = { operation: string; args: unknown[]; resolve(response: BridgeResponse): void };
const KEY = "a".repeat(64);
const TARGET = { repositoryId: fixtureId(1), repositoryGeneration: 1 };
const HEAD = { state: "branch", target: "refs/heads/main", oid: oid(1) } as const;
const ok = (result: unknown): BridgeResponse => ({ requestId: "r", operationId: fixtureId(0x201), state: "succeeded", result }) as BridgeResponse;
const REPORT = { generation: 1, programs: {}, state: "approved", persistence: "repository", approvalRequired: { reads: false, commit: false, sync: false }, entries: [], hooks: [], trustId: "trust-1" };
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const typeInto = (field: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

async function tray() {
  const calls: Call[] = [];
  const bridge = contractChecked(new Proxy({}, { get: (_, operation) => (...args: unknown[]) => new Promise<BridgeResponse>((resolve) => calls.push({ operation: String(operation), args, resolve })) }));
  const drafts = createDrafts({ write: async () => "saved", remove: async () => "saved", read: async () => null } as never);
  const pushes: number[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const props = { bridge, target: TARGET, snapshotId: fixtureId(0x301), worktreeKey: KEY, drafts, head: HEAD, staged: 1, status: null, requestTrust: async () => true, onPush: () => void pushes.push(1) };
  await act(async () => root.render(<CommitTray {...(props as unknown as Parameters<typeof CommitTray>[0])} />));
  await typeInto(host.querySelector("textarea")!, "Fix the parser");
  const reply = async (operation: string, response: BridgeResponse) => {
    await act(async () => calls.findLast((c) => c.operation === operation)!.resolve(response));
    await flush();
  };
  trays.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, calls, pushes, reply };
}

describe("Commit and push (FR-038)", () => {
  test("Commit and push sits beside Commit", async () => {
    const t = await tray();
    const labels = [...t.host.querySelectorAll("button")].map((b) => text(b));
    expect(labels.slice(0, 2)).toEqual(["Commit (Ctrl+Enter)", "Commit and push"]);
  });

  test("the push starts only after a succeeded commit", async () => {
    const t = await tray();
    await click(button("Commit and push", t.host));
    await t.reply("readTrust", ok(REPORT));
    await t.reply("reviewCommit", ok(commitReviewed(fixtureId(0x106))));
    expect(t.pushes).toEqual([]);
    await t.reply("commit", ok({ commitOid: oid(7) }));
    expect(t.pushes).toEqual([1]);
  });

  for (const state of ["failed", "completed-with-effects", "unknown", "failed-with-effects", "canceled"] as const) {
    test(`a ${state} commit starts no push`, async () => {
      const t = await tray();
      await click(button("Commit and push", t.host));
      await t.reply("readTrust", ok(REPORT));
      await t.reply("reviewCommit", ok(commitReviewed(fixtureId(0x106))));
      await t.reply("commit", { requestId: "r", operationId: fixtureId(0x201), state, code: state === "unknown" ? "STATE_UNKNOWN" : undefined, result: { commitOid: oid(7) } } as BridgeResponse);
      expect(t.pushes).toEqual([]);
      });
  }

  test("Commit alone starts no push", async () => {
    const t = await tray();
    await click(button("Commit (Ctrl+Enter)", t.host));
    await t.reply("readTrust", ok(REPORT));
    await t.reply("reviewCommit", ok(commitReviewed(fixtureId(0x106))));
    await t.reply("commit", ok({ commitOid: oid(7) }));
    expect(t.pushes).toEqual([]);
  });

  test("an unborn branch keeps Commit and push available; the push review decides", async () => {
    const world = createWorld({ head: { state: "unborn", target: "refs/heads/main" }, branches: [], oids: [], entries: [{ entryId: "e1", category: "staged", path: "a.ts", pathBytes: "YS50cw==" }] as never });
    await mountWorkbench(workbench, world);
    // Feature 004 T042 (plan.md P5 risk): the Commit view replaces the docked commit panel.
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    await typeInto(document.querySelector("textarea")!, "First commit");
    const control = button("Commit and push");
    expect(control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true").toBe(false);
    expect(text()).not.toContain("Commit and push: The branch has no commits yet.");
    expect(button("Push").getAttribute("aria-disabled")).toBe("true");
  });

  test("the push review takes the target after the reconcile read of the commit", async () => {
    const world = createWorld({ entries: [{ entryId: "e1", category: "staged", path: "a.ts", pathBytes: "YS50cw==" }] as never });
    const double = await mountWorkbench(workbench, world);
    // Feature 004 T042 (plan.md P5 risk): the Commit view replaces the docked commit panel.
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    await typeInto(document.querySelector("textarea")!, "Fix the parser");
    await click(button("Commit and push"));
    await answer(double.pending("readTrust"), ok(REPORT));
    await answer(double.pending("reviewCommit"), ok(commitReviewed(fixtureId(0x106))));
    // Contract §8 "Token invalidation": the reconcile read records the new HEAD and advances the generation.
    world.answers.readWorkspace = undefined;
    await answer(double.pending("commit"), ok({ commitOid: oid(7) }));
    const reconcile = double.pending("readWorkspace");
    expect(reconcile).toBeDefined();
    expect(double.count("reviewSync")).toBe(0);
    delete world.answers.readWorkspace;
    await answer(reconcile, succeeded({ ...snapshot(world), generation: 2 }, { repositoryGeneration: 2 }));
    expect(double.pending("reviewSync")!.args[0]).toEqual({ repositoryId: fixtureId(1), repositoryGeneration: 2 });
  });

  // tasks.md T381 (feature 001). The service advances the generation before the reconcile read answers (contract §8), so a review before it gets `REPOSITORY_CHANGED`.
  const RECONCILING = "The status read after the last operation is still running.";
  const disabled = (control: HTMLElement) => control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true";
  async function syncWaitsForReconcile(double: Awaited<ReturnType<typeof mountWorkbench>>, world: ReturnType<typeof createWorld>, generation: number) {
    const reconcile = double.pending("readWorkspace");
    expect(reconcile).toBeDefined();
    expect(disabled(button("Fetch"))).toBe(true);
    // Plan D12: the reconcile reason follows the running reason rule. It shows only in the tooltip and the accessible description.
    const shown = [...document.querySelectorAll('[role="group"][aria-label="Remote sync"] span')].filter((s) => !s.closest(".sr-only") && text(s).includes(RECONCILING)).map((s) => text(s));
    expect(shown).toEqual([]);
    expect(text(document.getElementById(button("Fetch").getAttribute("aria-describedby")!)!)).toBe(RECONCILING);
    await click(button("Fetch"));
    expect(double.count("reviewSync")).toBe(0);
    delete world.answers.readWorkspace;
    await answer(reconcile, succeeded({ ...snapshot(world), generation }, { repositoryGeneration: generation }));
    expect(disabled(button("Fetch"))).toBe(false);
    expect(text()).not.toContain(RECONCILING);
    await click(button("Fetch"));
    expect(double.pending("reviewSync")!.args).toEqual([{ repositoryId: fixtureId(1), repositoryGeneration: generation }, { action: "fetch" }]);
  }

  test("T381: toolbar Fetch waits for the reconcile read after a staged hunk; Commit and push does not", async () => {
    const file = { entryId: fixtureId(0x501), category: "unstaged", path: "a.ts", pathBytes: "YS50cw==" };
    const staged = { entryId: fixtureId(0x502), category: "staged", path: "b.ts", pathBytes: "Yi50cw==" };
    const world = createWorld({ entries: [file, staged] as never });
    world.answers.readComparison = (args) => {
      const { snapshotId, entryId } = args[1] as { snapshotId: string; entryId: string };
      const patch = Buffer.from("diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n a\n+n\n b\n").toString("base64");
      const hunks = [{ hunkId: fixtureId(0x401), ordinal: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 3, digest: "1".repeat(64) }];
      return { ...succeeded({ comparisonId: fixtureId(0x402), snapshotId, entryId, scope: "index-to-worktree", completeness: { state: "complete" }, patch, hunks, support: "supported", fileAction: "stage", remedy: null }), entryId };
    };
    const double = await mountWorkbench(workbench, world);
    // Feature 004 T042 (plan.md P5 risk): the Commit view replaces the docked commit panel.
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    await typeInto(document.querySelector("textarea")!, "Fix the parser");
    await click(document.querySelector(`[role="treeitem"][data-entry-id="${file.entryId}"]`)!);
    await click(button("Next hunk"));
    await click(button("Stage selected hunk"));
    world.answers.readWorkspace = undefined;
    world.entries = [{ ...file, category: "staged" }, staged] as never;
    await answer(double.pending("applyHunk"), succeeded({ lingeringDescendants: 0 }));
    // Commit and push waits for its own reconcile read before the push review, so the read does not block it.
    expect(disabled(button("Commit and push"))).toBe(false);
    expect(text(document.querySelector('[data-section="composer"]')!)).not.toContain(RECONCILING);
    await syncWaitsForReconcile(double, world, 2);
  });

  test("T381: toolbar Fetch waits for the reconcile read after a commit", async () => {
    const world = createWorld({ entries: [{ entryId: "e1", category: "staged", path: "a.ts", pathBytes: "YS50cw==" }] as never });
    const double = await mountWorkbench(workbench, world);
    // Feature 004 T042 (plan.md P5 risk): the Commit view replaces the docked commit panel.
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    await typeInto(document.querySelector("textarea")!, "Fix the parser");
    await click(button("Commit (Ctrl+Enter)"));
    await answer(double.pending("readTrust"), ok(REPORT));
    await answer(double.pending("reviewCommit"), ok(commitReviewed(fixtureId(0x106))));
    world.answers.readWorkspace = undefined;
    world.entries = [];
    await answer(double.pending("commit"), ok({ commitOid: oid(7) }));
    await syncWaitsForReconcile(double, world, 2);
  });

  // A band control that holds focus keeps it when the reconcile read ends, so the band does not move focus to its heading.
  const focusAndReconcile = async (double: Awaited<ReturnType<typeof mountWorkbench>>, world: ReturnType<typeof createWorld>, control: HTMLElement) => {
    const reconcile = double.pending("readWorkspace");
    expect(reconcile).toBeDefined();
    await act(async () => control.focus());
    expect(document.activeElement === control).toBe(true);
    delete world.answers.readWorkspace;
    await answer(reconcile, succeeded(snapshot(world)));
    expect(document.activeElement === control).toBe(true);
  };

  test("T381: a focused push-rejected action keeps focus when the reconcile read ends", async () => {
    const world = createWorld();
    const double = await mountWorkbench(workbench, world);
    await click(button("Push"));
    const destination = { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, source: "push-default-branch" };
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination }, syncReviewToken: fixtureId(0x101) }));
    world.answers.readWorkspace = undefined;
    await answer(double.pending("sync"), {
      requestId: "r",
      operationId: fixtureId(0x202),
      state: "failed",
      code: "PUSH_REJECTED",
      result: { action: "push", push: { status: "rejected", oldObjectId: oid(9), newObjectId: oid(9), reasonText: "fetch first", lease: false, upstreamWritten: false, outputTail: "" } },
    });
    await focusAndReconcile(double, world, button("Fetch", document.querySelector('[data-slot="notice-band"]')!));
  });

  test("T381: a focused conflict action keeps focus when the reconcile read ends", async () => {
    const file = { entryId: fixtureId(0x503), category: "conflicted", path: "a.txt", pathBytes: "YS50eHQ=" };
    const world = createWorld({ operationState: "merging", entries: [file] as never });
    world.answers.readComparison = (args) => {
      const { snapshotId, entryId } = args[1] as { snapshotId: string; entryId: string };
      const patch = Buffer.from("diff --cc a.txt\n").toString("base64");
      return { ...succeeded({ comparisonId: fixtureId(0x504), snapshotId, entryId, scope: "index-to-worktree", completeness: { state: "complete" }, patch, hunks: [], support: "state", fileAction: "resolve", remedy: null }), entryId };
    };
    world.answers.applyFile = undefined;
    const double = await mountWorkbench(workbench, world);
    // Feature 004 T042 (plan.md P5 risk): the Commit view replaces the docked commit panel.
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    const option = document.querySelector<HTMLElement>(`[role="treeitem"][data-entry-id="${file.entryId}"]`)!;
    await click(option);
    await press(option, " ");
    world.answers.readWorkspace = undefined;
    world.entries = [{ ...file, entryId: fixtureId(0x505), category: "staged" }] as never;
    await answer(double.pending("applyFile"), succeeded({}));
    await focusAndReconcile(double, world, button("Abort merge…", document.querySelector('[data-slot="conflict-row"]')!));
  });

  // A rejected push leaves the reconcile read pending.
  async function rejectedPush(world: ReturnType<typeof createWorld>) {
    world.answers.readBranches = () =>
      succeeded({ entries: [{ ref: "refs/heads/main", kind: "local", name: "main", invalidUtf8: false, oid: oid(1), upstream: "refs/remotes/origin/main", tracking: null, heldBy: null, current: true, localName: null }] });
    const double = await mountWorkbench(workbench, world);
    await click(button("Push"));
    const destination = { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, source: "push-default-branch" };
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination }, syncReviewToken: fixtureId(0x101) }));
    world.answers.readWorkspace = undefined;
    await answer(double.pending("sync"), {
      requestId: "r",
      operationId: fixtureId(0x202),
      state: "failed",
      code: "PUSH_REJECTED",
      result: { action: "push", push: { status: "rejected", oldObjectId: oid(9), newObjectId: oid(9), reasonText: "fetch first", lease: false, upstreamWritten: false, outputTail: "" } },
    });
    expect(double.pending("readWorkspace")).toBeDefined();
    return double;
  }
  const shownWith = (from: Element, value: string) => [...from.querySelectorAll("*")].filter((e) => e.children.length === 0 && text(e) === value && e.closest("[hidden], .sr-only") === null);
  const description = (element: Element) => text(document.getElementById(element.getAttribute("aria-describedby") ?? "") ?? document.createElement("span"));
  const openMenu = () => document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')!;

  test("tasks.md T114: during the reconcile read, the branch menu Push item and the Pull and Fetch menus show no visible reason line; the item description holds it", async () => {
    await rejectedPush(createWorld());
    const toggle = document.querySelector<HTMLElement>('button[aria-label="Show references"]');
    if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
    const main = [...document.querySelectorAll<HTMLElement>('[data-section="references"] [role="treeitem"]')].find((i) => (i.getAttribute("aria-label") ?? "").startsWith("main,"))!;
    await act(async () => void main.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await settle();
    const push = [...openMenu().querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => itemLabel(i) === "Push")!;
    expect(description(push)).toBe(RECONCILING);
    expect(shownWith(openMenu(), RECONCILING).length).toBe(0);
    await press(document.activeElement!, "Escape");
    for (const [trigger, labels] of [
      ["Pull options", ["Pull (use Git's configuration)", "Pull with merge", "Pull with rebase", "Fetch", "Fetch all remotes"]],
      ["Fetch options", ["Fetch all remotes"]],
    ] as const) {
      await click(button(trigger));
      const items = [...openMenu().querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((i) => (labels as readonly string[]).includes(itemLabel(i)));
      expect(items.map(itemLabel)).toEqual([...labels]);
      for (const item of items) expect(description(item)).toBe(RECONCILING);
      expect(shownWith(openMenu(), RECONCILING).length).toBe(0);
      await press(document.activeElement!, "Escape");
    }
  });

  test("tasks.md T114: during a run, the branch menu items with the running reason show no visible reason line; the item description holds it", async () => {
    const RUNNING = "A Git operation is running. Its progress and Cancel are in the status bar.";
    const world = createWorld();
    world.answers.readBranches = () =>
      succeeded({ entries: [{ ref: "refs/heads/main", kind: "local", name: "main", invalidUtf8: false, oid: oid(1), upstream: "refs/remotes/origin/main", tracking: null, heldBy: null, current: true, localName: null }] });
    const double = await mountWorkbench(workbench, world);
    await click(button("Push"));
    const destination = { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, source: "push-default-branch" };
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination }, syncReviewToken: fixtureId(0x101) }));
    expect(double.pending("sync")).toBeDefined();
    const toggle = document.querySelector<HTMLElement>('button[aria-label="Show references"]');
    if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
    const main = [...document.querySelectorAll<HTMLElement>('[data-section="references"] [role="treeitem"]')].find((i) => (i.getAttribute("aria-label") ?? "").startsWith("main,"))!;
    await act(async () => void main.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await settle();
    const items = [...openMenu().querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((i) => ["Create branch here…", "Rename…", "Push"].includes(itemLabel(i)));
    expect(items.map(itemLabel)).toEqual(["Create branch here…", "Rename…", "Push"]);
    for (const item of items) expect(description(item)).toBe(RUNNING);
    expect(shownWith(openMenu(), RUNNING).length).toBe(0);
    // The own reason of the current branch keeps its visible line.
    expect(shownWith(openMenu(), "main is the current branch.").length).toBe(1);
  });

  test("tasks.md T114: a state-unknown read during the reconcile read keeps the visible unknown-state line in the toolbar", async () => {
    const world = createWorld();
    const double = await rejectedPush(world);
    const reconcile = double.pending("readWorkspace");
    await press(document.body, "F5");
    const refresh = double.pending("readWorkspace");
    expect(refresh === reconcile).toBe(false);
    await answer(refresh, succeeded({ ...snapshot(world), recoveryState: "unknown" }));
    expect(reconcile!.done).toBe(false);
    const group = document.querySelector<HTMLElement>('[role="group"][aria-label="Remote sync"]')!;
    expect(shownWith(group, "State unknown. Select Refresh (F5) first.").length).toBe(1);
    expect(description(button("Fetch", group))).toBe("Fetch, Pull, Push: State unknown. Select Refresh (F5) first.");
  });

  test("a rejected push after a commit keeps the commit and shows the push-rejected notice", async () => {
    const world = createWorld({ entries: [{ entryId: "e1", category: "staged", path: "a.ts", pathBytes: "YS50cw==" }] as never });
    const double = await mountWorkbench(workbench, world);
    // Feature 004 T042 (plan.md P5 risk): the Commit view replaces the docked commit panel.
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    const field = document.querySelector("textarea")!;
    await typeInto(field, "Fix the parser");
    await click(button("Commit and push"));
    await answer(double.pending("readTrust"), ok(REPORT));
    await answer(double.pending("reviewCommit"), ok(commitReviewed(fixtureId(0x106))));
    await answer(double.pending("commit"), ok({ commitOid: oid(7) }));
    expect(double.pending("reviewSync")!.args[1]).toEqual({ action: "push" });
    const destination = { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, source: "push-default-branch" };
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination }, syncReviewToken: fixtureId(0x101) }));
    await answer(double.pending("sync"), {
      requestId: "r",
      operationId: fixtureId(0x202),
      state: "failed",
      code: "PUSH_REJECTED",
      result: { action: "push", push: { status: "rejected", oldObjectId: oid(9), newObjectId: oid(9), reasonText: "fetch first", lease: false, upstreamWritten: false, outputTail: "" } },
    });
    await settle();
    expect(text(document.querySelector('[data-slot="notice-band"]')!)).toContain("Push rejected.");
    expect(double.names().filter((n) => n === "commit")).toHaveLength(1);
    expect(double.names().filter((n) => !["readWorkspace", "readRefs", "readTracking", "readBranches", "readWorktrees", "readSyncSettings", "openHistory", "loadHistory", "readHistoryRows", "closeHistory", "readTrust", "listRecentRepositories", "readComparison", "reviewSubmodules"].includes(n))).toEqual(["reviewCommit", "commit", "reviewSync", "sync"]);
  });
});
