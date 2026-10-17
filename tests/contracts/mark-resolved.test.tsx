// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import type { BridgeResponse } from "../../src/frontend/bridge";
import { LIMITATION_TEXT } from "../../src/frontend/changes/limitation-text";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { answer, button, buttons, click, createWorld, mountWorkbench, press, settle, succeeded, text, unmountAll } from "./sync-fake";

// tasks.md T069 (feature 003). Spec FR-052, FR-053. Plan D7, D12. Data-model §9. Contract Δ3 `applyFile` direction `resolve`.

printOrigin("../../src/frontend/changes/FileControls.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
printOrigin("../../src/frontend/status/OperationStatus.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const { createRoot } = await import("react-dom/client");
const { FileControls, runFileAction } = await import("../../src/frontend/changes/FileControls");
const { STALE_TEXT } = await import("../../src/frontend/changes/HunkControls");
const workbench = await import("../../src/frontend/app/Workbench");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
afterEach(unmountAll);

const MISSING = "The working file of this conflicted path is missing.";
const TARGET = { repositoryId: "repository-1", repositoryGeneration: 1 };

function comparison(fileAction: string, entryId: string = crypto.randomUUID(), snapshotId: string = crypto.randomUUID()) {
  return {
    comparisonId: crypto.randomUUID(),
    snapshotId,
    entryId,
    scope: "index-to-worktree" as const,
    completeness: { state: "complete" as const },
    patch: Buffer.from("diff --cc a.txt\n").toString("base64"),
    hunks: [],
    support: "state",
    fileAction,
    remedy: null,
  };
}

type Call = { operation: string; target: unknown; payload: Record<string, unknown>; resolve(response: BridgeResponse): void };
function double() {
  const calls: Call[] = [];
  const bridge = new Proxy({}, { get: (_, operation) => (target: unknown, payload: Record<string, unknown>) => new Promise<BridgeResponse>((resolve) => calls.push({ operation: String(operation), target, payload, resolve })) });
  return { bridge: bridge as never, calls };
}

async function mount(props: Record<string, unknown>) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<FileControls {...({ reasonId: "reason", ...props } as Parameters<typeof FileControls>[0])} />));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("Mark resolved in the stage bar (FR-052)", () => {
  test("a Conflicted entry with the decision resolve offers Mark resolved (Space) also while the operation is in progress, and sends applyFile resolve", async () => {
    const d = double();
    const value = comparison("resolve");
    const outcomes: string[] = [];
    const view = await mount({ bridge: d.bridge, target: TARGET, comparison: value, category: "conflicted", blocked: "conflicted", onOutcome: (t: string) => void outcomes.push(t) });
    try {
      const b = button("Mark resolved (Space)", view.host);
      expect(b.getAttribute("aria-disabled")).toBeNull();
      expect(b.getAttribute("aria-keyshortcuts")).toBe("Space");
      await act(async () => b.click());
      expect(d.calls.map((c) => [c.operation, c.payload])).toEqual([["applyFile", { comparisonId: value.comparisonId, snapshotId: value.snapshotId, direction: "resolve" }]]);
      await act(async () => d.calls[0]!.resolve({ requestId: "r", operationId: "o", state: "succeeded", result: {} } as BridgeResponse));
      expect(outcomes).toEqual(["File marked resolved"]);
    } finally {
      await view.unmount();
    }
  });

  test("a refusal names its reason, also missing, and sends nothing", async () => {
    for (const [fileAction, reason] of [
      ["missing", MISSING],
      ["symlink", LIMITATION_TEXT.symlink],
      ["filter", LIMITATION_TEXT.filter],
    ] as const) {
      const d = double();
      const reasons: (string | null)[] = [];
      const view = await mount({ bridge: d.bridge, target: TARGET, comparison: comparison(fileAction), category: "conflicted", blocked: "conflicted", onReason: (t: string | null) => void reasons.push(t) });
      try {
        const b = button("Mark resolved (Space)", view.host);
        expect(b.getAttribute("aria-disabled")).toBe("true");
        expect(reasons.at(-1)).toBe(reason);
        await act(async () => b.click());
        expect(d.calls).toEqual([]);
      } finally {
        await view.unmount();
      }
      expect(await runFileAction({ bridge: d.bridge, target: TARGET, comparison: comparison(fileAction) as never, category: "conflicted" })).toEqual({ state: "refused", text: `Mark resolved is unavailable: ${reason}` });
    }
  });

  test("another state block still disables Mark resolved", async () => {
    const view = await mount({ bridge: double().bridge, target: TARGET, comparison: comparison("resolve"), category: "conflicted", blocked: "running" });
    try {
      expect(button("Mark resolved (Space)", view.host).getAttribute("aria-disabled")).toBe("true");
    } finally {
      await view.unmount();
    }
  });

  test("STALE_SELECTION asks for a new read", async () => {
    const d = double();
    const view = await mount({ bridge: d.bridge, target: TARGET, comparison: comparison("resolve"), category: "conflicted", blocked: "conflicted" });
    try {
      await act(async () => button("Mark resolved (Space)", view.host).click());
      await act(async () => d.calls[0]!.resolve({ requestId: "r", operationId: "o", state: "rejected", code: "STALE_SELECTION", result: {} } as BridgeResponse));
      expect(view.host.textContent).toContain(STALE_TEXT);
    } finally {
      await view.unmount();
    }
  });
});

describe("Mark resolved in the workbench (FR-053)", () => {
  const entry = (category: ChangeEntry["category"], path: string): ChangeEntry => ({ entryId: crypto.randomUUID(), category, path, pathBytes: Buffer.from(path).toString("base64") }) as ChangeEntry;
  const status = () => [...document.querySelectorAll('footer [role="status"]')].map((s) => text(s)).join(" | ");

  test("Space and the button send resolve, the file leaves Conflicted and shows as staged, and Continue becomes available", async () => {
    const file = entry("conflicted", "a.txt");
    const world = createWorld({ operationState: "merging", entries: [file] });
    world.answers.readComparison = (args) => {
      const payload = args[1] as { snapshotId: string; entryId: string };
      return { ...succeeded(comparison(payload.entryId === file.entryId ? "resolve" : "stage", payload.entryId, payload.snapshotId)), entryId: payload.entryId };
    };
    world.answers.applyFile = undefined;
    const d = await mountWorkbench(workbench, world);
    const row = () => document.querySelector('[data-slot="conflict-row"]')!;
    expect(button("Continue", row()).getAttribute("aria-disabled")).toBe("true");
    const working = document.querySelector<HTMLElement>('section[aria-label="History"] [role="option"][data-row-id="working-directory"]')!;
    await click(working);
    const option = () => document.querySelector<HTMLElement>(`[role="option"][data-entry-id="${file.entryId}"]`);
    await click(option()!);
    await settle();
    expect(buttons("Mark resolved (Space)")).toHaveLength(1);
    await press(option()!, " ");
    const call = d.pending("applyFile")!;
    expect((call.args[1] as { direction: string }).direction).toBe("resolve");
    expect(status()).toContain("Marking resolved");
    const staged = entry("staged", "a.txt");
    world.entries = [staged];
    await answer(call, succeeded({}));
    await settle();
    expect(status()).toContain("File marked resolved");
    expect(option()).toBeNull();
    expect(document.querySelector(`[role="option"][data-entry-id="${staged.entryId}"]`)).not.toBeNull();
    expect(button("Continue", row()).getAttribute("aria-disabled")).toBeNull();
  });
});
