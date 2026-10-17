// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, buttons, click, createWorld, mountWorkbench, oid, press, settle, succeeded, text, unmountAll } from "./sync-fake";

// tasks.md T060 (feature 003). Spec FR-023 to FR-026. Plan D5. Data-model §5. Contract Δ9 `PUSH_REJECTED`.

printOrigin("../../src/frontend/app/NoticeBand.tsx", import.meta.dir);
printOrigin("../../src/frontend/sync/ForcePushConfirm.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(unmountAll);

const DESTINATION = { remote: "origin", ref: "refs/heads/main", trackingRef: "refs/remotes/origin/main", url: "u", setUpstream: false, source: "push-default-branch" };
const pushResult = (status: string, lease = false) => ({ status, oldObjectId: oid(9), newObjectId: oid(9), reasonText: status === "rejected" ? (lease ? "stale info" : "fetch first") : null, lease, upstreamWritten: false, outputTail: "" });
const band = () => document.querySelector('[data-slot="notice-band"]')!;
const bandButtons = () => [...band().querySelectorAll<HTMLElement>("button")].map((b) => b.getAttribute("aria-label") ?? text(b));
const REJECTED = "Push rejected. origin/main can hold commits that main does not have, so the push cannot fast-forward.";
const STALE = "The remote branch changed since the last fetch.";
const LEASE = { trackingRef: "refs/remotes/origin/main", expect: oid(9), count: 3, commits: [{ objectId: oid(21), subject: "Validate IDs" }, { objectId: oid(22), subject: "Retry posting" }, { objectId: oid(23), subject: null }] };

async function rejected(world = createWorld()) {
  const double = await mountWorkbench(workbench, world);
  await click(button("Push"));
  await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination: DESTINATION }, syncReviewToken: "t" }));
  await answer(double.pending("sync"), { requestId: "r", operationId: "o", state: "failed", code: "PUSH_REJECTED", result: { action: "push", push: pushResult("rejected") } });
  await settle();
  return { world, double };
}

describe("push-rejected notice (FR-023)", () => {
  test("the band row states the cause and offers Pull with rebase, Pull with merge, Fetch, and Force push with lease, in this order", async () => {
    await rejected();
    expect(text(band())).toContain(REJECTED);
    expect(bandButtons().filter((b) => b !== "Dismiss notice")).toEqual(["Pull with rebase", "Pull with merge", "Fetch", "Force push with lease…"]);
    const force = button("Force push with lease…", band());
    expect(force.querySelector("svg")).not.toBeNull();
    expect(band().querySelector('[aria-haspopup="menu"]')).toBeNull();
  });

  test("the actions send the pull modes, the fetch of the push remote, and the force-push review", async () => {
    const { double } = await rejected();
    for (const [label, payload] of [
      ["Pull with rebase", { action: "pull", mode: "rebase" }],
      ["Pull with merge", { action: "pull", mode: "merge" }],
      ["Fetch", { action: "fetch", remote: "origin" }],
      ["Force push with lease…", { action: "force-push" }],
    ] as const) {
      await click(button(label, band()));
      const review = double.pending("reviewSync")!;
      expect(review.args[1]).toEqual(payload);
      await answer(review, { requestId: "r", state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "no-upstream" } });
    }
  });

  test("the notice stays after a refresh, and leaves on dismiss", async () => {
    await rejected();
    await press(document.body, "F5");
    expect(text(band())).toContain(REJECTED);
    await click(button("Dismiss notice", band()));
    expect(text(band())).not.toContain(REJECTED);
  });

  test("the notice leaves when the HEAD target changes", async () => {
    const { world } = await rejected();
    world.head = { state: "branch", target: "refs/heads/dev", oid: oid(1) };
    await press(document.body, "F5");
    await settle();
    expect(text(band())).not.toContain(REJECTED);
  });

  test("the notice leaves after a later push succeeds", async () => {
    const { double } = await rejected();
    await click(button("Push"));
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination: DESTINATION }, syncReviewToken: "t2" }));
    await answer(double.pending("sync"), { requestId: "r", operationId: "o2", state: "succeeded", result: { action: "push", push: pushResult("pushed") } });
    expect(text(band())).not.toContain(REJECTED);
  });

  test("after a successful pull from the notice, it offers Push (FR-026)", async () => {
    const { double } = await rejected();
    await click(button("Pull with rebase", band()));
    await answer(double.pending("reviewSync"), succeeded({ action: "pull", plan: { remotes: ["origin"], mode: "rebase", upstream: { ref: "refs/remotes/origin/main", objectId: oid(9) } }, syncReviewToken: "t3" }));
    await answer(double.pending("sync"), { requestId: "r", operationId: "o3", state: "succeeded", result: { action: "pull", integration: { state: "done" } } });
    expect(bandButtons().filter((b) => b !== "Dismiss notice")).toEqual(["Push"]);
    await click(button("Push", band()));
    expect(double.pending("reviewSync")!.args[1]).toEqual({ action: "push" });
  });
});

describe("force push with lease (FR-024, FR-025)", () => {
  async function confirm() {
    const r = await rejected();
    await click(button("Force push with lease…", band()));
    await answer(r.double.pending("reviewSync"), succeeded({ action: "force-push", plan: { remotes: ["origin"], destination: DESTINATION, lease: LEASE }, syncReviewToken: "f" }));
    return { ...r, dialog: document.querySelector<HTMLElement>('[role="dialog"]')! };
  }

  test("the modal names the destination, the count, and the subjects, states that other people can lose work, and focuses Cancel", async () => {
    const { double, dialog } = await confirm();
    expect(dialog).not.toBeNull();
    expect(text(dialog)).toContain("refs/heads/main");
    expect(text(dialog)).toContain("origin");
    expect(text(dialog)).toContain("3 commits");
    expect(text(dialog)).toContain("Validate IDs");
    expect(text(dialog)).toContain("Retry posting");
    expect(text(dialog)).toContain(oid(23).slice(0, 12));
    expect(text(dialog)).toContain("Other people can lose work.");
    expect(document.activeElement).toBe(button("Cancel", dialog));
    expect(double.count("sync")).toBe(1);
  });

  test("Cancel starts no push; the confirm button starts the reviewed force push", async () => {
    const first = await confirm();
    await click(button("Cancel", first.dialog));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(first.double.count("sync")).toBe(1);
    await click(button("Force push with lease…", band()));
    await answer(first.double.pending("reviewSync"), succeeded({ action: "force-push", plan: { remotes: ["origin"], destination: DESTINATION, lease: LEASE }, syncReviewToken: "f2" }));
    await click(button("Force push with lease", document.querySelector('[role="dialog"]')!));
    expect(first.double.pending("sync")!.args[1]).toEqual({ syncReviewToken: "f2", start: true });
  });

  test("a stale-lease result states that the remote branch changed since the last fetch and offers Fetch", async () => {
    const { double, dialog } = await confirm();
    await click(button("Force push with lease", dialog));
    await answer(double.pending("sync"), { requestId: "r", operationId: "o4", state: "failed", code: "PUSH_REJECTED", result: { action: "force-push", push: pushResult("rejected", true) } });
    expect(text(band())).toContain(STALE);
    expect(bandButtons().filter((b) => b !== "Dismiss notice")).toEqual(["Fetch"]);
    expect(buttons("Force push with lease…", band())).toHaveLength(0);
  });

  for (const [label, plan] of [
    ["no lease", { remotes: ["origin"], destination: DESTINATION }],
    ["no destination", { remotes: ["origin"], lease: LEASE }],
  ] as const) {
    test(`a force-push review with ${label} shows a refusal and starts no push`, async () => {
      const { double } = await rejected();
      await click(button("Force push with lease…", band()));
      await answer(double.pending("reviewSync"), succeeded({ action: "force-push", plan, syncReviewToken: "f" }));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(double.count("sync")).toBe(1);
      expect(text(document.querySelector("footer")!)).toContain("Force push with lease did not start: the review is incomplete.");
    });
  }

  test("a review without a sync token shows a refusal and starts nothing", async () => {
    const double = await mountWorkbench(workbench, createWorld());
    await click(button("Push"));
    await answer(double.pending("reviewSync"), succeeded({ action: "push", plan: { remotes: ["origin"], destination: DESTINATION } }));
    expect(double.count("sync")).toBe(0);
    expect(text(document.querySelector("footer")!)).toContain("Push did not start: the review is incomplete.");
  });
});
