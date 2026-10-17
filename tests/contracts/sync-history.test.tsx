// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, mountWorkbench, oid, settle, succeeded, text, unmountAll } from "./sync-fake";

// tasks.md T057 (feature 003). Spec FR-013, FR-019, FR-020, FR-040. Contract Δ8.

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/HistoryList.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(unmountAll);

const REFS_CHANGED = "References changed.";
const option = (id: string) => document.querySelector<HTMLElement>(`section[aria-label="History"] [role="option"][data-row-id="${id}"]`);
const ended = (action: string, extra: Record<string, unknown> = {}) => ({ requestId: "r", operationId: "op-1", state: "succeeded", result: { action, ...extra } });

async function runToEnd(double: Awaited<ReturnType<typeof mountWorkbench>>, control: string, action: string, result: unknown, plan: Record<string, unknown> = {}) {
  await click(button(control));
  await answer(double.pending("reviewSync"), succeeded({ action, plan: { remotes: ["origin"], ...plan }, syncReviewToken: "t" }));
  await answer(double.pending("sync"), result);
  await settle();
}

describe("history after a sync outcome (FR-013, FR-040)", () => {
  test("after a fetch outcome, the view opens again with the selected commit, keeps it, and shows no refs-changed notice", async () => {
    const world = createWorld();
    const double = await mountWorkbench(workbench, world);
    const selected = world.oids[1]!;
    await click(option(selected)!);
    expect(option(selected)!.getAttribute("aria-selected")).toBe("true");
    const opens = double.count("openHistory");
    // The fetch moves origin/main, so the refs digest changes.
    world.remotes = [{ name: "origin/main", objectId: oid(10) }];
    world.branches = world.branches.map((b) => ({ ...b, upstreamObjectId: oid(10) }));
    world.refsDigest = "e".repeat(64);
    await runToEnd(double, "Fetch", "fetch", ended("fetch", { fetch: { remotes: [{ name: "origin", state: "succeeded", updates: [{ flag: " ", oldObjectId: oid(9), newObjectId: oid(10), ref: "refs/remotes/origin/main" }], counts: { " ": 1 }, outputTail: "" }], observed: [] } }));
    expect(double.count("openHistory")).toBe(opens + 1);
    const loads = double.calls.filter((c) => c.operation === "loadHistory").map((c) => (c.args[1] as { need: unknown }).need);
    expect(loads.at(-1)).toEqual({ oid: selected });
    expect(option(selected)!.getAttribute("aria-selected")).toBe("true");
    expect(text()).not.toContain(REFS_CHANGED);
  });

  test("after a push outcome, the history opens again by the 002 rules", async () => {
    const world = createWorld();
    const double = await mountWorkbench(workbench, world);
    const opens = double.count("openHistory");
    const destination = { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, source: "push-default-branch" };
    await runToEnd(double, "Push", "push", ended("push", { push: { status: "pushed", oldObjectId: oid(9), newObjectId: oid(1), reasonText: null, lease: false, upstreamWritten: false, outputTail: "" } }), { destination });
    expect(double.count("openHistory")).toBe(opens + 1);
  });
});

describe("history labels (FR-019, FR-020)", () => {
  test("a local branch label shows its counts, joined by branch name, with a text alternative", async () => {
    const world = createWorld();
    await mountWorkbench(workbench, world);
    const row = option(world.oids[0]!)!;
    const chip = row.querySelector('[data-kind="branch"]')!;
    expect(text(chip)).toContain("main");
    expect(text(chip)).toContain("↑2 ↓3");
    expect(row.getAttribute("aria-label")).toContain("main 2 ahead, 3 behind");
  });

  test("a label whose branch OID differs from the newest readRefs value shows no number", async () => {
    const world = createWorld();
    world.branches = world.branches.map((b) => ({ ...b, upstreamObjectId: oid(8) }));
    await mountWorkbench(workbench, world);
    const chip = option(world.oids[0]!)!.querySelector('[data-kind="branch"]')!;
    expect(text(chip)).toBe("main");
  });
});
