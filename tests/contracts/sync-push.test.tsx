// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, buttons, click, createWorld, expectChromiumFocus, mountWorkbench, oid, press, settle, succeeded, text, unmountAll } from "./sync-fake";
import { fixtureId } from "./bridge-contract";

// tasks.md T059 (feature 003). Spec FR-014 to FR-016. Plan D4. Data-model §3, §5. Contract Δ3 `reviewSync` (`needsDestination`).

printOrigin("../../src/frontend/sync/PushPanel.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const { createRoot } = await import("react-dom/client");
const workbench = await import("../../src/frontend/app/Workbench");
const { PushPanel } = await import("../../src/frontend/sync/PushPanel");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
const panels: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of panels.splice(0)) await dispose();
  await unmountAll();
});

const NO_UPSTREAM = { name: "feature/x", objectId: oid(1), upstream: null, upstreamObjectId: null, track: { state: "none" as const }, current: true };
const panelPlan = (fields: Record<string, unknown> = {}) => ({ remotes: ["origin", "backup"], prefill: null, setUpstream: true, upstreamRebase: false, ...fields });
const panel = () => document.querySelector<HTMLElement>('section[data-slot="push-panel"]');
const radios = () => [...panel()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const branchField = () => panel()!.querySelector<HTMLInputElement>('input[type="text"]')!;
const setUpstream = () => panel()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

async function renderPanel(plan = panelPlan(), branch = "feature/x") {
  const pushes: unknown[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<PushPanel branch={branch} plan={plan as never} onPush={(choice) => void pushes.push(choice)} onCancel={() => {}} />));
  panels.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { pushes };
}

describe("push panel (FR-016)", () => {
  test("it lists the remotes with a choice, defaults the remote branch to the local name, and selects Set upstream with its configuration text", async () => {
    const p = await renderPanel();
    expect(radios().map((r) => r.value)).toEqual(["origin", "backup"]);
    expect(radios().find((r) => r.checked)?.value).toBe("origin");
    expect(branchField().value).toBe("feature/x");
    expect(setUpstream().checked).toBe(true);
    expect(text(panel()!)).toContain("Writes branch.feature/x.remote and .merge for origin/feature/x.");
    expect(text(panel()!)).toContain("Destination: refs/heads/feature/x on origin");
    expect(p.pushes).toEqual([]);
  });

  test("the Set upstream note names .rebase when upstreamRebase is true, and ends after the keys without a remote", async () => {
    await renderPanel(panelPlan({ remotes: ["backup", "second"], upstreamRebase: true }));
    expect(text(panel()!)).toContain("Writes branch.feature/x.remote, .merge, and .rebase.");
    await act(async () => radios()[0]!.click());
    expect(text(panel()!)).toContain("Writes branch.feature/x.remote, .merge, and .rebase for backup/feature/x.");
  });

  test("the remote branch field has a name and no autocomplete, and only the legend names the remote group", async () => {
    await renderPanel();
    expect(branchField().name).not.toBe("");
    expect(branchField().getAttribute("autocomplete")).toBe("off");
    expect(panel()!.querySelector('[aria-label="Remote"]')).toBeNull();
    expect(text(panel()!.querySelector("legend")!)).toBe("Remote");
  });

  test("a branch with an upstream shows Set upstream not selected, and the prefill fills the destination", async () => {
    await renderPanel(panelPlan({ remotes: ["origin"], prefill: { remote: "origin", ref: "refs/heads/release/2.9" }, setUpstream: false }), "release/2.9");
    expect(setUpstream().checked).toBe(false);
    expect(branchField().value).toBe("release/2.9");
  });

  test("Push starts only at the explicit start and sends the chosen destination", async () => {
    const p = await renderPanel();
    await act(async () => radios()[1]!.click());
    await click(button("Push", panel()!));
    expect(p.pushes).toEqual([{ remote: "backup", branch: "feature/x", setUpstream: true }]);
  });
});

describe("push flow (FR-014 to FR-016)", () => {
  test("a push without a destination opens the panel and starts no sync until the explicit start", async () => {
    const world = createWorld({ branches: [NO_UPSTREAM], head: { state: "branch", target: "refs/heads/feature/x", oid: oid(1) }, remotes: [] });
    const double = await mountWorkbench(workbench, world);
    await click(button("Push"));
    expect(double.pending("reviewSync")!.args[1]).toEqual({ action: "push" });
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin", "backup"], needsDestination: panelPlan() } }));
    expect(panel()).not.toBeNull();
    expect(double.count("sync")).toBe(0);
    await click(button("Push", panel()!));
    expect(double.pending("reviewSync")!.args[1]).toEqual({ action: "push", destination: { remote: "origin", branch: "feature/x", setUpstream: true } });
    const destination = { remote: "origin", ref: "refs/heads/feature/x", trackingRef: null, url: "u", setUpstream: true, source: "panel" };
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination }, syncReviewToken: fixtureId(0x101) }));
    expect(double.pending("sync")!.args[1]).toEqual({ syncReviewToken: fixtureId(0x101), start: true });
    expect(panel()).toBeNull();
  });

  test("focus moves into the panel when it opens, and back to the opener when it closes", async () => {
    const world = createWorld({ branches: [NO_UPSTREAM], head: { state: "branch", target: "refs/heads/feature/x", oid: oid(1) }, remotes: [] });
    const double = await mountWorkbench(workbench, world);
    const opener = button("Push");
    await act(async () => opener.focus());
    await click(opener);
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin", "backup"], needsDestination: panelPlan() } }));
    expect(panel()!.contains(document.activeElement)).toBe(true);
    await press(document.activeElement!, "Escape");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  // T121 (001 FR-005): the Commit view hides the commit workspace while the push panel shows, so focus stays in the panel.
  test("T121: the Commit icon with the push panel open keeps focus in the panel, not on the body or in the hidden workspace", async () => {
    const world = createWorld({ branches: [NO_UPSTREAM], head: { state: "branch", target: "refs/heads/feature/x", oid: oid(1) }, remotes: [] });
    const double = await mountWorkbench(workbench, world);
    await click(button("Push"));
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin", "backup"], needsDestination: panelPlan() } }));
    expect(panel()!.contains(document.activeElement)).toBe(true);
    await click(document.querySelector<HTMLElement>('header button[aria-label^="Commit:"]')!);
    expect(document.querySelector('section[aria-label="Commit view"]')).not.toBeNull();
    expect(panel()!.contains(document.activeElement)).toBe(true);
    expectChromiumFocus(document.activeElement);
  });

  test("Rejected by the remote shows the remote message as plain text and offers no pull or force choice", async () => {
    const world = createWorld();
    const double = await mountWorkbench(workbench, world);
    await click(button("Push"));
    const destination = { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, source: "push-default-branch" };
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination }, syncReviewToken: fixtureId(0x101) }));
    const message = "<b>protected branch hook declined</b>";
    await answer(double.pending("sync"), {
      requestId: "r",
      operationId: fixtureId(0x201),
      state: "failed",
      code: "PUSH_REJECTED",
      result: { action: "push", push: { status: "remote-rejected", oldObjectId: oid(9), newObjectId: oid(9), reasonText: message, lease: false, upstreamWritten: false, outputTail: "" } },
    });
    expect(text()).toContain("Rejected by the remote");
    expect(text()).toContain(message);
    expect(document.querySelector("b")).toBeNull();
    for (const label of ["Pull with rebase", "Pull with merge", "Force push with lease…"]) expect(buttons(label)).toHaveLength(0);
  });

  test("after a push, the toolbar counts show 0 ahead", async () => {
    const world = createWorld();
    const double = await mountWorkbench(workbench, world);
    await click(button("Push"));
    const destination = { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, source: "push-default-branch" };
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination }, syncReviewToken: fixtureId(0x101) }));
    world.remotes = [{ name: "origin/main", objectId: oid(1) }];
    world.branches = world.branches.map((b) => ({ ...b, upstreamObjectId: oid(1), track: { state: "counts", ahead: 0, behind: 0 } }));
    world.refsDigest = "e".repeat(64);
    await answer(double.pending("sync"), { requestId: "r", operationId: fixtureId(0x201), state: "succeeded", result: { action: "push", push: { status: "pushed", oldObjectId: oid(9), newObjectId: oid(1), reasonText: null, lease: false, upstreamWritten: false, outputTail: "" } } });
    await settle();
    expect(text(document.querySelector('[data-slot="tracking-count"]')!)).toContain("0 ahead, 0 behind");
  });
});
