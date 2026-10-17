// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, click, createWorld, mountWorkbench, oid, press, refList, settle, succeeded, text, unmountAll, type World } from "./sync-fake";
import { fixtureId } from "./bridge-contract";

// tasks.md T058 (feature 003). Spec FR-019 to FR-022. Plan D8. Data-model §1.

printOrigin("../../src/frontend/state/tracking.ts", import.meta.dir);
printOrigin("../../src/frontend/refs/ReferencesSidebar.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const { createRoot } = await import("react-dom/client");
const workbench = await import("../../src/frontend/app/Workbench");
const { ReferencesSidebar } = await import("../../src/frontend/refs/ReferencesSidebar");
const { COUNTS_TOOLTIP, NO_BRANCH, refIndex, trackingLabels, trackLabel } = await import("../../src/frontend/state/tracking");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
const sidebars: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of sidebars.splice(0)) await dispose();
  await unmountAll();
});

const entry = (fields: Record<string, unknown> = {}) => ({ name: "main", invalidUtf8: false, objectId: oid(1), upstream: "refs/remotes/origin/main", upstreamObjectId: oid(9), track: { state: "counts", ahead: 2, behind: 3 }, current: true, ...fields }) as never;
const index = (world: World = createWorld()) => refIndex(refList(world) as never);
const count = () => document.querySelector('[data-slot="tracking-count"]');

describe("label rule (data-model §1, FR-020, FR-021)", () => {
  test("counts show arrows with numbers and the text alternative", () => {
    expect(trackLabel(entry(), index())).toEqual({ text: "↑2 ↓3", label: "2 ahead, 3 behind" });
  });

  test("0 and 0 shows the equal mark", () => {
    expect(trackLabel(entry({ track: { state: "counts", ahead: 0, behind: 0 } }), index())).toEqual({ text: "=", label: "0 ahead, 0 behind" });
  });

  test("no upstream and a gone upstream show their texts", () => {
    expect(trackLabel(entry({ upstream: null, upstreamObjectId: null, track: { state: "none" } }), index())).toEqual({ text: "No upstream", label: "No upstream" });
    expect(trackLabel(entry({ upstreamObjectId: null, track: { state: "gone" } }), index())).toEqual({ text: "Upstream gone", label: "Upstream gone" });
  });

  test("a count above 10,000 shows 10000+", () => {
    expect(trackLabel(entry({ track: { state: "counts", ahead: 10_001, behind: 10_000 } }), index())).toEqual({ text: "↑10000+ ↓10000", label: "10000+ ahead, 10000 behind" });
  });

  test("a count shows only when both OIDs equal the newest readRefs values", () => {
    expect(trackLabel(entry({ objectId: oid(5) }), index())).toBeNull();
    expect(trackLabel(entry({ upstreamObjectId: oid(5) }), index())).toBeNull();
    expect(trackLabel(entry(), refIndex(null))).toBeNull();
  });

  test("labels join by branch name", () => {
    const labels = trackingLabels([entry(), entry({ name: "dev", objectId: oid(5), current: false })] as never, refList(createWorld()) as never);
    expect(labels.get("main")).toEqual({ text: "↑2 ↓3", label: "2 ahead, 3 behind" });
    expect(labels.get("dev")).toBeNull();
  });
});

describe("references sidebar (FR-019, FR-022)", () => {
  test("a local branch row shows its counts, names them, and states that they compare with the last fetch", async () => {
    const world = createWorld();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    sidebars.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    const labels = trackingLabels(world.branches.map((b) => ({ ...b, invalidUtf8: false })) as never, refList(world) as never);
    await act(async () => root.render(<ReferencesSidebar refs={refList(world) as never} failure={null} onSelectCommit={async () => null} onRefresh={() => {}} repository="r" tracking={labels} />));
    const row = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((e) => e.getAttribute("aria-label")?.startsWith("main,"))!;
    expect(text(row)).toContain("↑2 ↓3");
    expect(row.getAttribute("aria-label")).toContain("2 ahead, 3 behind");
    expect(row.querySelector("[title]")?.getAttribute("title")).toContain(COUNTS_TOOLTIP);
  });
});

describe("toolbar counts (FR-019 to FR-022)", () => {
  test("the toolbar shows the counts of the current branch, their text alternative, and the last-fetch statement", async () => {
    await mountWorkbench(workbench, createWorld());
    expect(text(count()!)).toContain("↑2 ↓3");
    expect(text(count()!)).toContain("2 ahead, 3 behind");
    expect(count()!.getAttribute("title")).toContain(COUNTS_TOOLTIP);
  });

  test("a stale count shows no number", async () => {
    const world = createWorld();
    world.branches = world.branches.map((b) => ({ ...b, objectId: oid(4) }));
    await mountWorkbench(workbench, world);
    expect(count()?.textContent ?? "").not.toMatch(/[0-9]/);
  });

  test("a detached HEAD shows No branch checked out and no counts", async () => {
    await mountWorkbench(workbench, createWorld({ head: { state: "detached", oid: oid(1) }, branches: [{ name: "main", objectId: oid(1), upstream: "refs/remotes/origin/main", upstreamObjectId: oid(9), track: { state: "counts", ahead: 2, behind: 3 }, current: false }] }));
    expect(text(count()!)).toBe(NO_BRANCH);
    expect(text(count()!)).not.toMatch(/[↑↓]/);
  });

  test("a failed readTracking shows its code and no counts", async () => {
    const world = createWorld();
    world.answers.readTracking = () => ({ requestId: "r", operationId: fixtureId(0x201), state: "failed", code: "GIT_FAILED" });
    await mountWorkbench(workbench, world);
    expect(text(count()!)).toBe("Counts did not load: GIT_FAILED.");
  });

  test("readTracking runs for each new refsDigest, each outcome, and each focus return", async () => {
    const world = createWorld();
    const double = await mountWorkbench(workbench, world);
    expect(double.count("readTracking")).toBe(1);
    // The same digest starts no read.
    await press(document.body, "F5");
    await settle();
    expect(double.count("readTracking")).toBe(1);
    world.refsDigest = "e".repeat(64);
    await press(document.body, "F5");
    await settle();
    expect(double.count("readTracking")).toBe(2);
    await act(async () => void window.dispatchEvent(new Event("blur")));
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(double.count("readTracking")).toBe(3);
    await click(button("Fetch"));
    await answer(double.pending("reviewSync"), succeeded({ action: "fetch", plan: { remotes: ["origin"] }, syncReviewToken: fixtureId(0x101) }));
    await answer(double.pending("sync"), { requestId: "r", operationId: fixtureId(0x201), state: "succeeded", result: { action: "fetch", fetch: { remotes: [], observed: [] } } });
    expect(double.count("readTracking")).toBe(4);
  });
});
