// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { ReadTrustResult } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { fixtureId } from "./bridge-contract";
import { answer, button, buttons, click, createWorld, itemLabel, keyboardFocus, menuItem, mountWorkbench, settle, succeeded, text, tooltipText, unmountAll, type World } from "./sync-fake";

// tasks.md T066 (feature 004, WP23). Story US7. Spec FR-069 to FR-075. Plan D12, D14, D15.

printOrigin("../../src/frontend/trust/TrustChip.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/RepositoryMenu.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(() => unmountAll());

const REPOSITORY = fixtureId(1);
const TRUST_ID = fixtureId(0x501);
const NONE = { names: [], more: 0 };
const NO_PROGRAMS = { hooks: NONE, filters: NONE, monitors: NONE, mergeDrivers: NONE, mergeTools: NONE, signing: NONE, other: NONE };
const HOOKS = { ...NO_PROGRAMS, hooks: { names: [{ event: "pre-commit", folder: "C:\\repo\\.git\\hooks" }], more: 0 } };
const CLASSES = { reads: false, commit: false, sync: false, workbench: false, mergetool: false };
// Contract §3 `readTrust` and data-model §10. Each fixture passes the result schema.
function report(fields: { state?: string; programs?: unknown; approvalRequired?: Partial<typeof CLASSES> } = {}) {
  const state = fields.state ?? "untrusted";
  return ReadTrustResult.parse({
    generation: 1,
    state,
    persistence: "stored",
    ...(state === "approved" || state === "changed" ? { trustId: TRUST_ID } : {}),
    approvalRequired: { ...CLASSES, commit: true, ...fields.approvalRequired },
    entries: [],
    hooks: [{ event: "pre-commit", path: "C:\\repo\\.git\\hooks\\pre-commit", repositoryControlled: true }],
    programs: fields.programs ?? HOOKS,
  });
}
const APPROVED = { trustId: TRUST_ID, persistence: "stored", saveFailed: false };
const CANCELED = { requestId: fixtureId(0x502), state: "canceled" };

const STAGED = [{ entryId: "e1", category: "staged", path: "a.ts", pathBytes: "YS50cw==" }];
async function mount(trust: unknown, fields: Partial<World> = {}) {
  const world = createWorld(fields);
  world.answers.readTrust = () => succeeded(trust);
  const double = await mountWorkbench(workbench, world);
  return { world, double };
}
const chip = () => document.querySelector<HTMLElement>('footer [data-slot="trust-chip"]');
const statusText = () => [...document.querySelectorAll('footer [role="status"]')].map((s) => text(s)).join(" | ");
const unavailable = (e: Element) => e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true" || e.hasAttribute("data-disabled");
const reasonOf = (item: Element) => text(item.querySelector('[data-slot="menu-reason"]') ?? document.createElement("i"));
const typeInto = (field: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
async function openCommit() {
  await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
  await typeInto(document.querySelector("textarea")!, "Fix the parser");
  await settle();
}

const COMMIT_TEXT = "Commit needs trust. Select Not trusted in the status bar to trust this repository.";
const READS_TEXT = "Arbareto reads no changes until you trust this repository.";
const STOPPED = "Arbareto no longer trusts this repository.";

describe("trust chip (FR-073)", () => {
  test("a repository without its own programs shows no chip and asks nothing", async () => {
    const { double } = await mount(report({ programs: NO_PROGRAMS, approvalRequired: { commit: false } }));
    expect(double.count("readTrust")).toBeGreaterThan(0);
    expect(chip() === null).toBe(true);
    expect(double.count("approveTrust")).toBe(0);
    expect(document.querySelector('[role="dialog"]') === null).toBe(true);
  });

  test("a repository with programs shows Not trusted, with the D12 tooltip and accessible name", async () => {
    await mount(report());
    expect(text(chip()!)).toBe("Not trusted");
    expect(chip()!.getAttribute("aria-label")).toBe("Not trusted. Git does not run this repository's own programs.");
    expect(chip()!.getAttribute("aria-haspopup")).toBe("menu");
    await keyboardFocus(chip()!);
    expect(tooltipText()).toBe("Git does not run this repository's own programs.");
  });

  test("an approved repository shows Trusted with its tooltip", async () => {
    await mount(report({ state: "approved" }));
    expect(text(chip()!)).toBe("Trusted");
    expect(chip()!.getAttribute("aria-label")).toBe("Trusted. Git runs this repository's own programs.");
    await keyboardFocus(chip()!);
    expect(tooltipText()).toBe("Git runs this repository's own programs.");
  });

  test("a changed approval shows Not trusted", async () => {
    await mount(report({ state: "changed" }));
    expect(text(chip()!)).toBe("Not trusted");
  });

  test("the menu holds Trust this repository… and Stop trusting this repository, and the item for the current state is unavailable", async () => {
    await mount(report());
    await click(chip()!);
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    expect(items.map(itemLabel)).toEqual(["Trust this repository…", "Stop trusting this repository"]);
    expect(unavailable(menuItem("Trust this repository…"))).toBe(false);
    expect(unavailable(menuItem("Stop trusting this repository"))).toBe(true);
    expect(reasonOf(menuItem("Stop trusting this repository"))).toBe("Not trusted now");
  });

  test("an approved repository offers only Stop trusting this repository", async () => {
    await mount(report({ state: "approved" }));
    await click(chip()!);
    expect(unavailable(menuItem("Trust this repository…"))).toBe(true);
    expect(reasonOf(menuItem("Trust this repository…"))).toBe("Trusted now");
    expect(unavailable(menuItem("Stop trusting this repository"))).toBe(false);
  });

  test("Trust this repository… sends approveTrust with only the repository ID and the action, and a success reads again", async () => {
    const { double } = await mount(report());
    const reads = double.count("readTrust");
    await click(chip()!);
    await click(menuItem("Trust this repository…"));
    expect(double.pending("approveTrust")!.args).toEqual([{ repositoryId: REPOSITORY }, { action: "commit" }]);
    expect(document.querySelector('[role="dialog"]') === null).toBe(true);
    await answer(double.pending("approveTrust"), succeeded(APPROVED));
    expect(double.count("readTrust")).toBe(reads + 1);
  });

  test("Not now from the chip stores nothing and keeps Not trusted", async () => {
    const { double } = await mount(report());
    await click(chip()!);
    await click(menuItem("Trust this repository…"));
    const reads = double.count("readTrust");
    await answer(double.pending("approveTrust"), CANCELED);
    expect(double.count("readTrust")).toBe(reads);
    expect(text(chip()!)).toBe("Not trusted");
  });

  test.each([
    [0, STOPPED],
    [1, `${STOPPED} It stopped 1 program that was still running.`],
    [2, `${STOPPED} It stopped 2 programs that were still running.`],
  ])("Stop trusting with %i ended processes states the FR-074 result", async (ended, expected) => {
    const { double } = await mount(report({ state: "approved" }));
    await click(chip()!);
    await click(menuItem("Stop trusting this repository"));
    expect(double.pending("revokeTrust")!.args).toEqual([{ repositoryId: REPOSITORY }, { trustId: TRUST_ID }]);
    await answer(double.pending("revokeTrust"), succeeded({ endedProcesses: ended }));
    expect(statusText()).toContain(expected);
    if (ended === 0) expect(statusText()).not.toContain("It stopped");
  });

  test("Stop trusting at its deadline states that the count is unknown", async () => {
    const { double } = await mount(report({ state: "approved" }));
    await click(chip()!);
    await click(menuItem("Stop trusting this repository"));
    await answer(double.pending("revokeTrust"), { requestId: fixtureId(0x503), state: "failed", code: "DEADLINE" });
    expect(statusText()).toContain(`${STOPPED} Arbareto does not know how many programs it stopped, because Stop trusting reached its deadline.`);
  });
});

describe("the ask (FR-069, FR-070, FR-072)", () => {
  test("Commit asks through approveTrust with the commit action, and no in-app dialog opens", async () => {
    const { double } = await mount(report(), { entries: STAGED as never });
    await openCommit();
    await click(button("Commit (Ctrl+Enter)"));
    expect(double.pending("approveTrust")!.args).toEqual([{ repositoryId: REPOSITORY }, { action: "commit" }]);
    expect(document.querySelector('[role="dialog"]') === null).toBe(true);
    expect(double.count("reviewCommit")).toBe(0);
  });

  test("after Not now, Commit states its inline reason, stays unavailable, and asks no second time", async () => {
    const { double } = await mount(report(), { entries: STAGED as never });
    await openCommit();
    await click(button("Commit (Ctrl+Enter)"));
    await answer(double.pending("approveTrust"), CANCELED);
    expect(text()).toContain(COMMIT_TEXT);
    expect(unavailable(button("Commit (Ctrl+Enter)"))).toBe(true);
    await click(button("Commit (Ctrl+Enter)"));
    expect(double.count("approveTrust")).toBe(1);
    expect(double.count("reviewCommit")).toBe(0);
  });

  test("after Trust, the commit continues with the review of the read after the approval", async () => {
    const { world, double } = await mount(report(), { entries: STAGED as never });
    await openCommit();
    await click(button("Commit (Ctrl+Enter)"));
    world.answers.readTrust = () => succeeded(report({ state: "approved" }));
    await answer(double.pending("approveTrust"), succeeded(APPROVED));
    await settle();
    expect(double.calls.filter((c) => c.operation === "readWorkspace").at(-1)!.args[1]).toEqual({ refresh: false, check: "full" });
    expect(double.count("reviewCommit")).toBe(1);
    expect(text()).not.toContain(COMMIT_TEXT);
  });

  test("a read that needs trust states the FR-072 text with Trust…, and never prompts by itself", async () => {
    const { world, double } = await mount(report({ approvalRequired: { reads: true } }), {
      answers: { readWorkspace: () => ({ requestId: fixtureId(0x504), operationId: fixtureId(0x505), state: "rejected", code: "TRUST_REQUIRED" }) },
    });
    await click(button("Commit", document.querySelector('header nav[aria-label="Views"]')!));
    expect(text()).toContain(READS_TEXT);
    expect(double.count("approveTrust")).toBe(0);
    expect(document.querySelector('[role="dialog"]') === null).toBe(true);
    delete world.answers.readWorkspace;
    await click(button("Trust…"));
    expect(double.pending("approveTrust")!.args).toEqual([{ repositoryId: REPOSITORY }, { action: "read" }]);
  });

  test("a failed approval states its code in the status bar", async () => {
    const { double } = await mount(report());
    await click(chip()!);
    await click(menuItem("Trust this repository…"));
    await answer(double.pending("approveTrust"), { requestId: fixtureId(0x506), state: "failed", code: "DEADLINE" });
    expect(statusText()).toContain("Trust approval did not complete: DEADLINE");
  });
});

describe("the old trust surface is gone (001 FR-025 UI change)", () => {
  test("the in-app TrustDialog no longer exists", () => {
    expect(existsSync(join(import.meta.dir, "../../src/frontend/trust/TrustDialog.tsx"))).toBe(false);
  });

  test("the Repository menu holds no trust items", async () => {
    await mount(report({ state: "approved" }));
    const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === "Repository")!;
    await act(async () => trigger.focus());
    await click(trigger);
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map(itemLabel);
    expect(labels).toContain("Open folder…");
    expect(labels.filter((l) => /trust/i.test(l))).toEqual([]);
    expect(buttons("Approve")).toHaveLength(0);
  });
});
