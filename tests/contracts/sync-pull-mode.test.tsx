// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { fixtureId } from "./bridge-contract";
import { answer, button, buttons, click, createWorld, mountWorkbench, press, settle, succeeded, text, unmountAll } from "./sync-fake";

// tasks.md T067 (feature 003). Spec FR-027, FR-057. Plan D6, D12. Data-model §6, §7. Contract Δ3 `reviewSync` `integrate`.

printOrigin("../../src/frontend/sync/PullModeChoice.tsx", import.meta.dir);
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

const QUESTION = "The branch and its upstream have diverged. Choose Rebase or Merge for this pull. Arbareto does not change the Git configuration.";
const band = () => document.querySelector('[data-slot="notice-band"]')!;
const status = () => [...document.querySelectorAll('footer [role="status"]')].map((s) => text(s)).join(" | ");
const pullResult = (integration: Record<string, unknown>, modeSource: string | null) => ({ action: "pull", counts: { ahead: 2, behind: 3 }, integration, modeSource });
const done = (action: string, modeSource: string | null) => succeeded({ action, counts: { ahead: 2, behind: 3 }, integration: { state: "done" }, modeSource });

// Pull (use Git's configuration) on a diverged branch without a configured mode.
async function modeRequired() {
  const double = await mountWorkbench(workbench, createWorld());
  await click(document.querySelector<HTMLElement>('button[data-slot="pull-main"]')!);
  const review = double.pending("reviewSync")!;
  expect(review.args[1]).toEqual({ action: "pull" });
  await answer(review, succeeded({ action: "pull", plan: { remotes: ["origin"], mode: null }, syncReviewToken: TOKEN }));
  await answer(double.pending("sync"), succeeded(pullResult({ state: "mode-required" }, null)));
  return double;
}

describe("pull mode choice (FR-027)", () => {
  test("integration mode-required shows the question with Rebase and Merge, and states that no configuration changes", async () => {
    await modeRequired();
    expect(text(band())).toContain(QUESTION);
    const group = band().querySelector('[role="group"][aria-label="Pull mode"]')!;
    expect(group).not.toBeNull();
    expect([...group.querySelectorAll("button")].map((b) => text(b))).toEqual(["Rebase", "Merge", "Cancel"]);
    expect(status()).not.toContain("Pull completed");
  });

  test("each choice sends reviewSync integrate with its mode, and Rebase opens no further confirmation (FR-057)", async () => {
    for (const mode of ["rebase", "merge"] as const) {
      const double = await modeRequired();
      await click(button(mode === "rebase" ? "Rebase" : "Merge", band()));
      const review = double.pending("reviewSync")!;
      expect(review.args[1]).toEqual({ action: "integrate", mode });
      await answer(review, succeeded({ action: "integrate", plan: { remotes: ["origin"], mode }, syncReviewToken: TOKEN_2 }));
      expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
      const start = double.pending("sync")!;
      expect(start.args[1]).toEqual({ syncReviewToken: TOKEN_2, start: true });
      expect(text(band())).not.toContain(QUESTION);
      await answer(start, done("integrate", "payload"));
      await unmountAll();
    }
  });

  test("the keyboard reaches both choices, and Escape cancels with no request", async () => {
    const double = await modeRequired();
    const rebase = button("Rebase", band());
    const merge = button("Merge", band());
    expect(document.activeElement).toBe(rebase);
    for (const b of [rebase, merge]) {
      expect(b.getAttribute("aria-disabled")).not.toBe("true");
      expect(b.tabIndex).toBe(0);
    }
    const reviews = double.count("reviewSync");
    await press(document.activeElement!, "Escape");
    expect(text(band())).not.toContain(QUESTION);
    expect(double.count("reviewSync")).toBe(reviews);
    expect(double.count("sync")).toBe(1);
  });

  test("Cancel removes the question with no request", async () => {
    const double = await modeRequired();
    await click(button("Cancel", band()));
    expect(text(band())).not.toContain(QUESTION);
    expect(double.count("reviewSync")).toBe(1);
  });

  test("the result names the mode source", async () => {
    for (const [source, line] of [
      ["payload", "Pull completed. The choice for this pull selected the mode."],
      ["branch", "Pull completed. branch.main.rebase selected the mode."],
      ["pull", "Pull completed. pull.rebase selected the mode."],
      ["pull-ff", "Pull completed. pull.ff selected the mode."],
    ] as const) {
      const double = await mountWorkbench(workbench, createWorld());
      await click(document.querySelector<HTMLElement>('button[data-slot="pull-main"]')!);
      await answer(double.pending("reviewSync"), succeeded({ action: "pull", plan: { remotes: ["origin"], mode: null }, syncReviewToken: TOKEN }));
      await answer(double.pending("sync"), done("pull", source));
      expect(status()).toContain(line);
      await unmountAll();
    }
  });

  test("a pull result without mode-required shows no question", async () => {
    const double = await mountWorkbench(workbench, createWorld());
    await click(document.querySelector<HTMLElement>('button[data-slot="pull-main"]')!);
    await answer(double.pending("reviewSync"), succeeded({ action: "pull", plan: { remotes: ["origin"], mode: null }, syncReviewToken: TOKEN }));
    await answer(double.pending("sync"), succeeded(pullResult({ state: "up-to-date" }, null)));
    await settle();
    expect(buttons("Rebase")).toHaveLength(0);
    expect(text(document.body)).not.toContain(QUESTION);
  });
});
