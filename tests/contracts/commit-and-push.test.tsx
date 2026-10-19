// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { BridgeResponse } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, mountWorkbench, oid, settle, snapshot, succeeded, text, unmountAll } from "./sync-fake";
import { contractChecked, fixtureId } from "./bridge-contract";

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
    await t.reply("reviewCommit", ok({ reviewToken: fixtureId(0x106) }));
    expect(t.pushes).toEqual([]);
    await t.reply("commit", ok({ commitOid: oid(7) }));
    expect(t.pushes).toEqual([1]);
  });

  for (const state of ["failed", "completed-with-effects", "unknown", "failed-with-effects", "canceled"] as const) {
    test(`a ${state} commit starts no push`, async () => {
      const t = await tray();
      await click(button("Commit and push", t.host));
      await t.reply("readTrust", ok(REPORT));
      await t.reply("reviewCommit", ok({ reviewToken: fixtureId(0x106) }));
      await t.reply("commit", { requestId: "r", operationId: fixtureId(0x201), state, code: state === "unknown" ? "STATE_UNKNOWN" : undefined, result: { commitOid: oid(7) } } as BridgeResponse);
      expect(t.pushes).toEqual([]);
      });
  }

  test("Commit alone starts no push", async () => {
    const t = await tray();
    await click(button("Commit (Ctrl+Enter)", t.host));
    await t.reply("readTrust", ok(REPORT));
    await t.reply("reviewCommit", ok({ reviewToken: fixtureId(0x106) }));
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
    await answer(double.pending("reviewCommit"), ok({ reviewToken: fixtureId(0x106) }));
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

  test("a rejected push after a commit keeps the commit and shows the push-rejected notice", async () => {
    const world = createWorld({ entries: [{ entryId: "e1", category: "staged", path: "a.ts", pathBytes: "YS50cw==" }] as never });
    const double = await mountWorkbench(workbench, world);
    // Feature 004 T042 (plan.md P5 risk): the Commit view replaces the docked commit panel.
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    const field = document.querySelector("textarea")!;
    await typeInto(field, "Fix the parser");
    await click(button("Commit and push"));
    await answer(double.pending("readTrust"), ok(REPORT));
    await answer(double.pending("reviewCommit"), ok({ reviewToken: fixtureId(0x106) }));
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
    expect(double.names().filter((n) => !["readWorkspace", "readRefs", "readTracking", "readBranches", "readWorktrees", "readSyncSettings", "openHistory", "loadHistory", "readHistoryRows", "closeHistory", "readTrust", "listRecentRepositories", "readComparison"].includes(n))).toEqual(["reviewCommit", "commit", "reviewSync", "sync"]);
  });
});
