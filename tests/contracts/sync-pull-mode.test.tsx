// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { fixtureId } from "./bridge-contract";
import { answer, button, buttons, click, createWorld, mountWorkbench, oid, press, settle, succeeded, text, unmountAll } from "./sync-fake";

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
async function modeRequired(world = createWorld()) {
  const double = await mountWorkbench(workbench, world);
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

  test("another pull that ends done removes the question", async () => {
    const double = await modeRequired();
    expect(text(band())).toContain(QUESTION);
    await click(document.querySelector<HTMLElement>('button[data-slot="pull-main"]')!);
    await answer(double.pending("reviewSync"), succeeded({ action: "pull", plan: { remotes: ["origin"], mode: null }, syncReviewToken: TOKEN_2 }));
    await answer(double.pending("sync"), done("pull", "pull"));
    expect(text(band())).not.toContain(QUESTION);
  });

  test("a new HEAD commit on the same branch removes the question", async () => {
    const world = createWorld();
    await modeRequired(world);
    expect(text(band())).toContain(QUESTION);
    world.head = { state: "branch", target: "refs/heads/main", oid: oid(5) };
    world.branches = world.branches.map((b) => ({ ...b, objectId: oid(5) }));
    await press(document.body, "F5");
    await settle();
    expect(text(band())).not.toContain(QUESTION);
  });

  // The workbench later moves focus back by its own rules, so this test renders the row alone.
  test("the question takes no focus from an input, a textarea, or a contenteditable element, and takes it otherwise", async () => {
    const { PullModeChoice } = await import("../../src/frontend/sync/PullModeChoice");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const editable = () => {
      const div = document.createElement("div");
      div.contentEditable = "true";
      return div;
    };
    for (const [make, keeps] of [[() => document.createElement("input"), true], [() => document.createElement("textarea"), true], [editable, true], [() => document.createElement("button"), false]] as const) {
      const field = document.body.appendChild(make());
      field.focus();
      expect(document.activeElement).toBe(field);
      const host = document.body.appendChild(document.createElement("div"));
      const root = createRoot(host);
      await act(async () => root.render(<PullModeChoice onChoose={() => {}} onCancel={() => {}} reason={null} />));
      expect(document.activeElement === field).toBe(keeps);
      if (!keeps) expect(document.activeElement).toBe(button("Rebase", host));
      await act(async () => root.unmount());
      host.remove();
      field.remove();
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

describe("pull mode row while an operation runs (plan D12)", () => {
  const RUNNING = "A Git operation is running. Its progress and Cancel are in the status bar.";
  async function render(props: { reason: string | null; running?: boolean }) {
    const { PullModeChoice } = await import("../../src/frontend/sync/PullModeChoice");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    let chosen = 0;
    await act(async () => root.render(<PullModeChoice onChoose={() => void chosen++} onCancel={() => {}} {...props} />));
    return {
      host,
      chosen: () => chosen,
      done: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }
  const described = (control: Element) => document.getElementById(control.getAttribute("aria-describedby") ?? "");

  test("Rebase and Merge stay disabled and focusable; the running reason is only in the tooltip and a hidden description", async () => {
    const { BLOCKED_TEXT } = await import("../../src/frontend/changes/HunkControls");
    const { keyboardFocus, tooltipText } = await import("./sync-fake");
    const view = await render({ reason: BLOCKED_TEXT.running, running: true });
    expect(text(view.host)).not.toContain(BLOCKED_TEXT.running);
    for (const label of ["Rebase", "Merge"]) {
      const control = button(label, view.host);
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.tabIndex).toBe(0);
      expect(described(control)?.textContent).toBe(RUNNING);
      expect(described(control)!.classList.contains("sr-only")).toBe(true);
      await keyboardFocus(control);
      expect(tooltipText()).toBe(RUNNING);
      await click(control);
    }
    expect(view.chosen()).toBe(0);
    await view.done();
  });

  test("a reason other than a running operation stays visible", async () => {
    const { BLOCKED_TEXT } = await import("../../src/frontend/changes/HunkControls");
    const view = await render({ reason: BLOCKED_TEXT.unknown });
    const control = button("Rebase", view.host);
    expect(described(control)?.textContent).toBe(BLOCKED_TEXT.unknown);
    expect(described(control)!.classList.contains("sr-only")).toBe(false);
    expect(text(view.host)).toContain(BLOCKED_TEXT.unknown);
    await view.done();
  });
});
