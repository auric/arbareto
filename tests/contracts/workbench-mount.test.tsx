// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { act, Profiler, useEffect, type ReactNode } from "react";
import type { ChangeEntry, Environment, WorkspaceSnapshot } from "../../src/contracts/envelope";
import type { OnProgress } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { commitReviewed, contractChecked, fixtureId } from "./bridge-contract";

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
// Pierre and its worker need the Vite build (T160). The doubles count the pool provider mounts.
const pool = { mounts: 0, unmounts: 0 };
function PoolDouble({ children }: { children: ReactNode }) {
  useEffect(() => {
    pool.mounts++;
    return () => void pool.unmounts++;
  }, []);
  return <>{children}</>;
}
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: PoolDouble }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre data-slot="patch-double">{patch}</pre> }));
// `Workbench.tsx` loads Base UI. Base UI must first evaluate with a DOM (tests/dom.ts).
registerDom();
const { createRoot } = await import("react-dom/client");
const { ChangesPaneMount, ComparisonViewMount, HistoryViewMount, Workbench } = await import("../../src/frontend/app/Workbench");
const { HELP_LINE } = await import("../../src/frontend/changes/ChangesPane");
const { DEFAULT_PREFERENCES, readPreferences, writePreferences } = await import("../../src/frontend/state/preferences");

// tasks.md T354: the single-view frame. plan.md "Chosen layout: one view", "Dock region", "Measurements and budgets" (ready frames), and "Required visible states".

type Call = { operation: string; args: unknown[]; resolve(response: unknown): void };
// Each request stays pending until the test resolves it.
function bridgeDouble() {
  const calls: Call[] = [];
  const bridge = new Proxy(
    {},
    {
      get: (_, name) =>
        (...args: unknown[]) =>
          new Promise((resolve) => calls.push({ operation: String(name), args, resolve })),
    },
  );
  const pending = (operation: string) => calls.find((c) => c.operation === operation)!;
  return { bridge: contractChecked(bridge), calls, pending };
}

const REGISTRATION = { repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "a".repeat(64) };
const succeeded = (result: unknown) => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result });
const HEAD = "1".repeat(40);
function snapshot(fields: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    generation: 1,
    snapshotId: crypto.randomUUID(),
    readKind: "full",
    identity: { worktreeRoot: "C:\\repo", gitDirectory: "C:\\repo\\.git", commonDirectory: "C:\\repo\\.git", indexPath: "C:\\repo\\.git\\index", objectFormat: "sha1", refFormat: "files" },
    head: { state: "branch", target: "refs/heads/main", oid: HEAD },
    operationState: "normal",
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
    location: { kind: "native" },
    submoduleNotice: { count: 0, paths: [], filter: "applied" },
    entryCount: 0,
    entries: [],
    cursor: null,
    ...fields,
  };
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  localStorage.clear();
});
// Lets the responses settle, React commit, and the next animation frame run.
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 50))));
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
// The change poll never fires, so a test that counts reads sees only the reads it starts.
const NO_POLL = { setInterval: () => 0, clearInterval: () => {}, setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (id: unknown) => clearTimeout(id as number) };

async function mount(restore: unknown, environment: Environment | null = null) {
  const double = bridgeDouble();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <Workbench
        bridge={double.bridge as never}
        environment={environment}
        restored={Promise.resolve(restore) as never}
        ChangesPane={ChangesPaneMount}
        ComparisonView={ComparisonViewMount}
        HistoryView={HistoryViewMount}
        clock={NO_POLL}
      />,
    ),
  );
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  return double;
}
async function resolve(call: Call, response: unknown) {
  await act(async () => call.resolve(response));
  await settle();
}
// Feature 002: the history list sizes its window from the list element. happy-dom has no layout, so the T038 stub gives it a viewport.
let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());

const HISTORY_CALLS = new Set(["openHistory", "loadHistory", "readHistoryRows", "searchHistory", "closeHistory"]);
const answered = new WeakSet<object>();
// Answers each pending history call of the double from `oids`: a linear history with `oids[0]` at row 0 and HEAD there (contract Δ3).
// Every commit matches a search.
async function serveHistory(double: { calls: Call[] }, oids: readonly string[] = DEFAULT) {
  const person = { name: "A", email: "a@example.invalid" };
  const viewRow = (i: number, text: string) => ({
    index: i,
    oid: oids[i]!,
    parents: i + 1 < oids.length ? [oids[i + 1]!] : [],
    cell: { node: 0, color: 0, merge: false, limited: false, segments: [], marks: i + 1 < oids.length ? [] : ["root"] },
    labels: [],
    checkout: i === 0,
    ...(text === "none" ? {} : { subject: i === 0 && oids === DEFAULT ? "First" : `Commit ${oids[i]!.slice(0, 4)}`, author: person, date: 1_700_000_000, encoding: null, invalidUtf8: false }),
    ...(text === "details" ? { body: "", bodyCut: false, committer: person, committerDate: 1_700_000_000, children: i > 0 ? [oids[i - 1]!] : [] } : {}),
  });
  const counts = { rowCount: oids.length, lanes: 1, complete: true, bytes: 1024 };
  for (let round = 0; round < 20; round++) {
    const open = double.calls.filter((c) => !answered.has(c) && HISTORY_CALLS.has(c.operation));
    if (open.length === 0) return;
    for (const call of open) {
      answered.add(call);
      const payload = call.args[1] as { scope?: string; at?: Record<string, unknown>; count?: number; text?: string };
      let result: unknown = {};
      if (call.operation === "openHistory")
        result = { viewId: crypto.randomUUID(), scope: payload.scope, generation: 1, head: { state: "branch", target: "refs/heads/main", oid: oids[0]! }, startCount: 1, refsDigest: "0".repeat(64), shallow: false };
      else if (call.operation === "loadHistory") result = { rows: oids.length, complete: true };
      else if (call.operation === "searchHistory") {
        // Contract Δ2: the accepted event carries the `operationId` that is the `searchId`.
        await act(async () => (call.args[2] as OnProgress)({ requestId: "r", operationId: fixtureId(0x401), state: "accepted", counters: { matches: 0, settled: 0 } }));
        result = { matches: oids.length, shallow: false };
      }
      else if (call.operation === "readHistoryRows") {
        const at = payload.at!;
        const first = "row" in at ? (at.row as number) : "oid" in at ? oids.indexOf(at.oid as string) : "match" in at ? (at.from as number) : oids.length - 1;
        const rows = first < 0 || first >= oids.length ? [] : Array.from({ length: Math.min(payload.count!, oids.length - first) }, (_, k) => viewRow(first + k, payload.text!));
        result = rows.length === 0 ? { target: "none", ...counts } : { target: "found", rows, cut: false, ...counts };
      }
      await act(async () => call.resolve(succeeded(result)));
    }
    await settle();
  }
  throw new Error("the history calls did not settle");
}
const DEFAULT = [HEAD];
// Clicks a history option by its row ID: "working-directory", "index", or a commit OID.
async function selectRow(id: string) {
  const option = document.querySelector<HTMLElement>(`section[aria-label="History"] [role="option"][data-row-id="${id}"]`);
  expect(option !== null).toBe(true);
  await act(async () => option!.click());
  await settle();
}
// Feature 004 T042 (plan.md P5 risk): the 001 commit panel tests run in the Commit view, which replaces the docked commit panel.
async function switchView(name: "Commit" | "History") {
  const nav = document.querySelector<HTMLElement>('header nav[aria-label="Views"]')!;
  await act(async () => [...nav.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === name)!.click());
  await settle();
}
const openCommitView = () => switchView("Commit");
const COMMIT_VIEW = 'section[aria-label="Commit view"]';
// The commit view grid: the lane, the comparison, and the tray cells.
const commitGrid = () => document.querySelector<HTMLElement>(`${COMMIT_VIEW} [data-section="workingChanges"]`)!.parentElement!;

describe("start", () => {
  test("a canceled restoreWorkspace, which means no stored repository, shows the start page, No repository open, and no refusal", async () => {
    const double = await mount({ requestId: null, state: "canceled" });
    expect(document.querySelector('section[aria-label="Start page"]')).not.toBeNull();
    expect(document.querySelector('footer [role="status"]')?.textContent).toBe("No repository open");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    // Only the start page reads the recent list (plan.md "Cold-start critical path").
    expect(double.calls.map((c) => c.operation)).toEqual(["listRecentRepositories"]);
  });

  test("a restoreWorkspace registration shows the one view without mode tabs and sends the full read, openHistory, and readTrust", async () => {
    const double = await mount(succeeded(REGISTRATION));
    // Feature 003 data-model §10: the Pull main part reads `readSyncSettings`.
    expect(double.calls.map((c) => c.operation).sort()).toEqual(["openHistory", "readBranches", "readSyncSettings", "readTrust", "readWorkspace", "readWorktrees"]);
    expect(double.pending("readWorkspace").args[1]).toEqual({ refresh: false, check: "full" });
    expect(document.querySelector('[role="tab"], [role="tablist"]')).toBeNull();
    expect(document.querySelector('section[aria-label="History"]')).not.toBeNull();
    expect(text()).toContain("Select the Working directory row to commit, or a commit to see its details.");
  });

  test("a refused restoreWorkspace shows the Repository refused state with its code", async () => {
    await mount({ requestId: crypto.randomUUID(), state: "failed", code: "UNSUPPORTED_REPOSITORY" });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("UNSUPPORTED_REPOSITORY");
  });

  test("a failed clipboard write shows the copy failure text in the status bar", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
    try {
      await mount({ requestId: crypto.randomUUID(), state: "failed", code: "UNSUPPORTED_REPOSITORY", result: { remedy: { text: "Use Git.", command: "git status" } } });
      const copy = [...document.querySelectorAll("button")].find((b) => b.textContent === "Copy command")!;
      await act(async () => copy.click());
      await settle();
      const status = [...document.querySelectorAll('footer [role="status"]')].map((s) => s.textContent);
      expect(status).toContain("Copy failed. Select the text and copy it with Ctrl+C.");
    } finally {
      if (original) Object.defineProperty(globalThis.navigator, "clipboard", original);
      else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

// T385: a no-change poll renders nothing. The Profiler counts each commit of the workbench tree.
describe("change poll", () => {
  test("10 retained polls with the same snapshotId commit no render", async () => {
    const focus = spyOn(document, "hasFocus").mockReturnValue(true);
    try {
      const ticks: (() => void)[] = [];
      const clock = { ...NO_POLL, setInterval: (run: () => void) => (ticks.push(run), 0) };
      const double = bridgeDouble();
      const host = document.body.appendChild(document.createElement("div"));
      const root = createRoot(host);
      let commits = 0;
      await act(async () =>
        root.render(
          <Profiler id="workbench" onRender={() => void commits++}>
            <Workbench bridge={double.bridge as never} restored={Promise.resolve(succeeded(REGISTRATION)) as never} ChangesPane={ChangesPaneMount} ComparisonView={ComparisonViewMount} HistoryView={HistoryViewMount} clock={clock} />
          </Profiler>,
        ),
      );
      unmounts.push(async () => {
        await act(async () => root.unmount());
        host.remove();
      });
      await settle();
      await serveHistory(double);
      const shown = snapshot();
      await resolve(double.pending("readWorkspace"), succeeded(shown));
      expect(ticks).toHaveLength(1);
      async function poll() {
        const reads = double.calls.filter((c) => c.operation === "readWorkspace").length;
        await act(async () => ticks[0]!());
        const sent = double.calls.filter((c) => c.operation === "readWorkspace");
        expect(sent).toHaveLength(reads + 1);
        expect(sent.at(-1)!.args[1]).toEqual({ refresh: false, check: "changes" });
        await resolve(sent.at(-1)!, succeeded({ ...shown, readKind: "retained" }));
      }
      // The first read went out before the history view opened. The first poll records the HEAD for the notice (contract Δ8).
      await poll();
      const before = commits;
      for (let i = 0; i < 10; i++) await poll();
      expect(commits - before).toBe(0);
    } finally {
      focus.mockRestore();
    }
  });
});

describe("History", () => {
  test("the history-painted mark waits for the counts of a complete read", async () => {
    const mark = spyOn(performance, "mark");
    try {
      const double = await mount(succeeded(REGISTRATION));
      await serveHistory(double);
      expect(mark.mock.calls.filter(([name]) => name === "arbareto:history-painted")).toHaveLength(0);
      await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
      expect(mark.mock.calls.filter(([name]) => name === "arbareto:history-painted")).toHaveLength(1);
    } finally {
      mark.mockRestore();
    }
  });

  test("a limited read gives no history-painted mark", async () => {
    const mark = spyOn(performance, "mark");
    try {
      const double = await mount(succeeded(REGISTRATION));
      await serveHistory(double);
      await resolve(double.pending("readWorkspace"), { ...succeeded(snapshot({ completeness: { state: "limited", code: "WORKTREE_CHANGING" } })), state: "limited" });
      expect(mark.mock.calls.filter(([name]) => name === "arbareto:history-painted")).toHaveLength(0);
    } finally {
      mark.mockRestore();
    }
  });

  test("the history list holds no inspector; the dock below it holds one panel at a time", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    const history = document.querySelector('section[aria-label="History"]')!;
    expect(history.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    expect(history.querySelector("section")).toBeNull();
    await selectRow(HEAD);
    const dock = document.querySelector('section[aria-label="Dock"]')!;
    expect(dock.textContent).toContain("Selected commit");
    expect(dock.querySelector('section[aria-label="Working directory summary"]')).toBeNull();
    expect(document.querySelector(COMMIT_VIEW)).toBeNull();
  });
});

describe("mounted controls", () => {
  // T148: the commit tray replaces the T330 commit place. An empty Staged list disables Commit with its reason.
  test("the commit panel holds the message field, Commit (Ctrl+Enter) with its disabled reason, the hook disclosure, and the summary line", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    await openCommitView();
    const panel = document.querySelector(COMMIT_VIEW)!;
    expect(panel.querySelectorAll("textarea")).toHaveLength(1);
    const commit = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Commit (Ctrl+Enter)")!;
    expect(commit.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(commit.getAttribute("aria-describedby")!)?.textContent).toBe("The Staged list is empty.");
    expect(panel.textContent).toContain("Git will run approved hooks. They or other Git tools can change the result during execution.");
    expect(panel.textContent).toContain("main, 0 staged files");
    expect(panel.textContent).not.toContain("available after batch 3");
  });

});

// T235 and T148: the submodule row, the feature 004 one-click update (T073, no review dialog), and the T138 status region across the update.
describe("submodule update mount", () => {
  const NOTICE = { submoduleNotice: { count: 2, paths: ["a", "b"], filter: "applied" as const } };
  const REVIEW = () => ({ generation: 1, rows: [], programs: [], refusals: [], hosts: [], submoduleReviewToken: crypto.randomUUID() });
  const bandButton = () => document.querySelector<HTMLElement>('[data-slot="notice-band"] button');
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const footerButton = (label: string) => [...document.querySelectorAll<HTMLElement>("footer button")].find((b) => b.textContent === label);
  const areaHeading = () => document.querySelector<HTMLElement>('section[data-slot="status-area"] h2');
  async function started() {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    const shown = snapshot(NOTICE);
    await resolve(double.pending("readWorkspace"), succeeded(shown));
    await act(async () => bandButton()!.click());
    await settle();
    expect(latest(double, "reviewSubmodules").args.slice(0, 2)).toEqual([{ repositoryId: REGISTRATION.repositoryId, repositoryGeneration: shown.generation }, { snapshotId: shown.snapshotId }]);
    // Feature 004 FR-076: a review without refusals and host lines starts the update at once.
    const token = REVIEW();
    await resolve(latest(double, "reviewSubmodules"), succeeded(token));
    expect(dialog()).toBeNull();
    const update = latest(double, "updateSubmodules");
    expect(update.args[1]).toEqual({ submoduleReviewToken: token.submoduleReviewToken, start: true });
    const onProgress = update.args[2] as (event: unknown) => void;
    await act(async () => onProgress({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "accepted", counters: {} }));
    await act(async () => onProgress({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "running", phase: "preflight", counters: {}, stalled: false }));
    await settle();
    expect(dialog()).toBeNull();
    expect(footerButton("Cancel")).toBeDefined();
    return { double, update };
  }
  const RUNNING_TEXT = "A Git operation is running. Wait for its result, or select Cancel.";
  const describedBy = (element: Element) => (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((ref) => document.getElementById(ref)?.textContent ?? "").join(" ");
  const openRepositoryMenu = async () => {
    const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === "Repository")!;
    await act(async () => trigger.focus());
    await act(async () => trigger.click());
    await settle();
    return [...document.querySelectorAll<HTMLElement>('[data-slot="menubar-content"] [role="menuitem"]')].find((e) => e.textContent === "Update submodules")!;
  };

  test("B4-1: after a read during the update, an expired token after the accepted event reviews the current snapshot and generation, and the rejection starts no read", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
    await act(async () => bandButton()!.click());
    await settle();
    await resolve(latest(double, "reviewSubmodules"), succeeded(REVIEW()));
    const update = latest(double, "updateSubmodules");
    // Contract §8: a full read gives a new snapshot ID. A changed observation also gives a new generation.
    await act(async () => document.querySelector<HTMLElement>('header button[aria-label="Refresh"]')!.click());
    await settle();
    const later = snapshot({ ...NOTICE, generation: 2 });
    await resolve(latest(double, "readWorkspace"), { ...succeeded(later), repositoryGeneration: 2 });
    await act(async () => (update.args[2] as (event: unknown) => void)({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "accepted", counters: {} }));
    await settle();
    const reads = double.calls.filter((c) => c.operation === "readWorkspace").length;
    await resolve(update, { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "rejected", code: "APPROVAL_EXPIRED" });
    expect(dialog()).toBeNull();
    expect(double.calls.filter((c) => c.operation === "reviewSubmodules")).toHaveLength(3);
    expect(latest(double, "reviewSubmodules").args.slice(0, 2)).toEqual([{ repositoryId: REGISTRATION.repositoryId, repositoryGeneration: 2 }, { snapshotId: later.snapshotId }]);
    // Contract §9: an expired token starts no Git process. The new review answers it, so no read follows it.
    expect(double.calls.filter((c) => c.operation === "readWorkspace")).toHaveLength(reads);
  });

  test("plan.md Switch repository: while a mutation runs, the switcher entries and Open folder are disabled with the running reason", async () => {
    const { double } = await started();
    await act(async () => document.querySelector<HTMLElement>('header button[aria-keyshortcuts="Control+R"]')!.click());
    await settle();
    await resolve(latest(double, "listRecentRepositories"), succeeded({ entries: [{ entryId: crypto.randomUUID(), path: "C:\other", location: { kind: "native" }, openedAt: "2026-10-10T08:00:00Z", current: false }] }));
    const options = [...document.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Recent repositories"] [role="option"]')];
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.getAttribute("aria-disabled")).toBe("true");
      expect(describedBy(option)).toBe(RUNNING_TEXT);
    }
    await act(async () => options[1]!.click());
    await settle();
    expect(double.calls.filter((c) => c.operation === "openRecentRepository")).toHaveLength(0);
  });

  test("B4-1: a rejected REPOSITORY_CHANGED update still starts one full read", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
    await act(async () => bandButton()!.click());
    await settle();
    await resolve(latest(double, "reviewSubmodules"), succeeded(REVIEW()));
    const update = latest(double, "updateSubmodules");
    const reads = double.calls.filter((c) => c.operation === "readWorkspace").length;
    await resolve(update, { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "rejected", code: "REPOSITORY_CHANGED" });
    const after = double.calls.filter((c) => c.operation === "readWorkspace").slice(reads);
    expect(after.map((c) => c.args[1])).toEqual([{ refresh: false, check: "full" }]);
    expect(double.calls.filter((c) => c.operation === "reviewSubmodules")).toHaveLength(2);
  });

  test("B4-2: while a mutation runs, the band button and the menu item stay focusable, show the running reason as their description, and send nothing", async () => {
    const { double } = await started();
    const reviews = double.calls.filter((c) => c.operation === "reviewSubmodules").length;
    const band = bandButton()!;
    expect(band.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(band)).toBe(RUNNING_TEXT);
    expect(document.querySelector('[data-slot="notice-band"]')!.textContent).toContain(RUNNING_TEXT);
    await act(async () => band.click());
    await settle();
    const item = await openRepositoryMenu();
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(item)).toBe(RUNNING_TEXT);
    // Base UI MenuGroupLabel names its group and hides itself. A reason must not become a group name.
    expect(item.closest('[role="group"]')!.hasAttribute("aria-labelledby")).toBe(false);
    await act(async () => item.click());
    await settle();
    expect(double.calls.filter((c) => c.operation === "reviewSubmodules")).toHaveLength(reviews);
  });

  test("feature 003 plan D12: while a submodule update runs, Fetch, Pull, and Push are disabled with the tooltip-only running reason, and the toolbar shows no inline line", async () => {
    await started();
    const SYNC_RUNNING = "A Git operation is running. Its progress and Cancel are in the status bar.";
    const group = document.querySelector<HTMLElement>('[role="group"][aria-label="Remote sync"]')!;
    expect(group.textContent).not.toContain(RUNNING_TEXT);
    expect(group.querySelector('[data-slot="sync-running"]')).toBeNull();
    for (const label of ["Fetch", "Push"]) {
      const control = group.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!;
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(describedBy(control)).toBe(SYNC_RUNNING);
      expect(document.getElementById(control.getAttribute("aria-describedby")!)!.classList.contains("sr-only")).toBe(true);
    }
    // The default pull action never loads in this world. That reason is not the running reason, so it keeps its inline line.
    expect(describedBy(group.querySelector('button[data-slot="pull-main"]')!)).toBe("Pull: The default pull action is still loading…");
  });

  test("the band shows the service count and Update submodules with its icon, and the row leaves after a read without such submodules", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
    const band = document.querySelector('[data-slot="notice-band"]')!;
    expect(band.textContent).toContain("Some submodules are not initialized or not at their recorded commit. Count: 2.");
    expect(band.textContent).not.toContain("available after batch 3");
    expect(bandButton()?.textContent).toBe("Update submodules");
    expect(bandButton()!.querySelector("svg")).not.toBeNull();
    await act(async () => document.querySelector<HTMLElement>('header button[aria-label="Refresh"]')!.click());
    await settle();
    await resolve(latest(double, "readWorkspace"), succeeded(snapshot()));
    expect(document.querySelector('[data-slot="submodule-notice"]')).toBeNull();
  });

  test("when the focused row leaves, focus moves to the band heading while a row stays, else to the next F6 stop", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
    const refresh = async (fields: Partial<WorkspaceSnapshot>) => {
      await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", code: "F5", bubbles: true, cancelable: true })));
      await settle();
      await resolve(latest(double, "readWorkspace"), succeeded(snapshot(fields)));
    };
    await act(async () => bandButton()!.focus());
    await refresh(NOTICE);
    expect(document.activeElement === bandButton()).toBe(true);
    await refresh({ operationState: "merging" });
    expect(document.activeElement === document.querySelector('[data-slot="notice-band"] h2')).toBe(true);
    await refresh(NOTICE);
    await act(async () => bandButton()!.focus());
    await refresh({});
    expect(document.activeElement!.closest("[data-section]")?.getAttribute("data-section")).toBe("references");
  });

  test("the repository menu item sends reviewSubmodules for the shown snapshot and starts the update with no dialog", async () => {
    const double = await mount(succeeded(REGISTRATION));
    const shown = snapshot();
    await resolve(double.pending("readWorkspace"), succeeded(shown));
    const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === "Repository")!;
    await act(async () => trigger.focus());
    await act(async () => trigger.click());
    await settle();
    const item = [...document.querySelectorAll<HTMLElement>('[data-slot="menubar-content"] [role="menuitem"]')].find((e) => e.textContent === "Update submodules")!;
    await act(async () => item.click());
    await settle();
    expect(latest(double, "reviewSubmodules").args[1]).toEqual({ snapshotId: shown.snapshotId });
    await resolve(latest(double, "reviewSubmodules"), succeeded(REVIEW()));
    expect(dialog()).toBeNull();
    expect(double.calls.filter((c) => c.operation === "updateSubmodules")).toHaveLength(1);
  });

  test("feature 004 FR-078: in the Commit view, a refusal switches to the History view and focuses its line in the Submodules group", async () => {
    await sized(1600, 900, async () => {
      const double = await mount(succeeded(REGISTRATION));
      await serveHistory(double);
      await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
      await openCommitView();
      expect(document.querySelector(COMMIT_VIEW)).not.toBeNull();
      // The History view stays mounted but hidden, so the group is out of sight.
      expect(document.querySelector<HTMLElement>('[data-view="history"]')!.hidden).toBe(true);
      await act(async () => bandButton()!.click());
      await settle();
      const refusal = "Submodule a is not active, and Arbareto does not activate submodules. Activate it with the command, then update it again.";
      await resolve(latest(double, "reviewSubmodules"), succeeded({ ...REVIEW(), refusals: [{ code: "UNSUPPORTED_SUBMODULE", reason: "inactive", path: "a", text: refusal, remedy: null }] }));
      await settle();
      expect(document.querySelector(COMMIT_VIEW)).toBeNull();
      expect(document.querySelector<HTMLElement>('[data-view="history"]')!.hidden).toBe(false);
      const line =document.querySelector<HTMLElement>('[data-slot="submodules-group"] [data-slot="refusal-line"]');
      expect(line?.textContent).toContain(refusal);
      expect(document.activeElement === line).toBe(true);
      expect(double.calls.filter((c) => c.operation === "updateSubmodules")).toHaveLength(0);
    });
  });

  test("tasks.md T114: in the constrained profile, a host line from the Repository menu expands the collapsed references section and takes focus", async () => {
    await sized(720, 480, async () => {
      const double = await mount(succeeded(REGISTRATION));
      await serveHistory(double);
      await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
      expect(document.querySelector<HTMLElement>("[data-profile]")!.dataset.profile).toBe("constrained");
      const toggle = () => document.querySelector<HTMLElement>('[data-section="references"] button[aria-label="Show references"]')!;
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('[data-slot="submodules-group"]') === null).toBe(true);
      const item = await openRepositoryMenu();
      await act(async () => item.click());
      await settle();
      const hosts = [{ path: "a", fetch: { kind: "host", name: "git.example.net" }, settings: { kind: "unknown" } }];
      await resolve(latest(double, "reviewSubmodules"), succeeded({ ...REVIEW(), hosts }));
      await settle();
      // Plan D15: a host line never waits unseen.
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      const line = document.querySelector<HTMLElement>('[data-section="references"] [data-slot="submodules-group"] [data-slot="host-line"]');
      expect(line === null).toBe(false);
      expect(document.activeElement === line).toBe(true);
    });
  });

  test("tasks.md T114: a canceled update that the group Update submodules button started returns focus to that button", async () => {
    await sized(1600, 900, async () => {
      const double = await mount(succeeded(REGISTRATION));
      await serveHistory(double);
      await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
      const groupButton = () => document.querySelector<HTMLElement>('[data-slot="submodules-group"] [data-slot="group-header"] button:not([aria-expanded])')!;
      await act(async () => groupButton().focus());
      await act(async () => groupButton().click());
      await settle();
      await resolve(latest(double, "reviewSubmodules"), succeeded(REVIEW()));
      const update = latest(double, "updateSubmodules");
      await act(async () => bandButton()!.focus());
      await resolve(update, { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "canceled", result: {} });
      expect(document.activeElement === groupButton()).toBe(true);
    });
  });

  test("a failed review shows its code in the status bar and opens no dialog", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
    await act(async () => bandButton()!.click());
    await settle();
    await resolve(latest(double, "reviewSubmodules"), { requestId: crypto.randomUUID(), state: "failed", code: "DEADLINE" });
    expect(dialog()).toBeNull();
    expect([...document.querySelectorAll('footer [role="status"]')].map((s) => s.textContent)).toContain("Submodule review did not complete: DEADLINE");
    expect(document.querySelector("footer code")?.textContent).toBe("DEADLINE");
  });

  test("a canceled outcome after a declined Run confirmation returns focus to the band button", async () => {
    const { update } = await started();
    await resolve(update, { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "canceled", result: {} });
    expect(document.activeElement === bandButton()).toBe(true);
  });

  test("the status region stays mounted across a read between Cancel and the outcome, so a canceled outcome focuses the area heading", async () => {
    const { double, update } = await started();
    await act(async () => footerButton("Cancel")!.click());
    await settle();
    expect(double.calls.filter((c) => c.operation === "cancel")).toHaveLength(1);
    // A read refresh re-renders the workbench before the outcome.
    await act(async () => document.querySelector<HTMLElement>('header button[aria-label="Refresh"]')!.click());
    await settle();
    await resolve(latest(double, "readWorkspace"), succeeded(snapshot(NOTICE)));
    await resolve(update, { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "canceled", result: {} });
    expect(areaHeading()?.textContent).toBe("Update submodules details");
    expect(document.activeElement === areaHeading()).toBe(true);
    expect(document.activeElement === bandButton()).toBe(false);
  });

  // plan.md "Status area", Cancel sender. The `cancel` senders in src/frontend: the status-bar Cancel (OperationStatus),
  // the WslStarting Cancel (only during a `wsl-starting` phase), and the poll cancel of a user read (requests.ts, only the poll operationId).
  // The Submodules group Cancel sends through the same status-bar request guard.
  test("T369: while an update runs, only the status-bar Cancel sends cancel with its operationId", async () => {
    const OP = crypto.randomUUID();
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
    await act(async () => bandButton()!.click());
    await settle();
    await resolve(latest(double, "reviewSubmodules"), succeeded(REVIEW()));
    const update = latest(double, "updateSubmodules");
    const onProgress = update.args[2] as (event: unknown) => void;
    const cancels = () => double.calls.filter((c) => c.operation === "cancel" && (c.args[0] as { operationId?: string }).operationId === OP);
    await act(async () => onProgress({ requestId: crypto.randomUUID(), operationId: OP, state: "accepted", counters: {} }));
    await settle();
    await act(async () => onProgress({ requestId: crypto.randomUUID(), operationId: OP, state: "running", phase: "preflight", counters: {}, stalled: false }));
    await settle();
    expect(dialog()).toBeNull();
    // A user read can cancel only a poll. Refresh and F5 start user reads.
    await act(async () => document.querySelector<HTMLElement>('header button[aria-label="Refresh"]')!.click());
    await settle();
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", code: "F5", bubbles: true, cancelable: true })));
    await settle();
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })));
    await settle();
    expect(cancels()).toHaveLength(0);
    await act(async () => footerButton("Cancel")!.click());
    await settle();
    expect(cancels().map((c) => c.args[0])).toEqual([{ operationId: OP }]);
    expect(double.calls.filter((c) => c.operation === "cancel")).toHaveLength(1);
  });

  for (const [width, height, profile] of [[1600, 900, "wide"], [960, 900, "narrow"], [720, 480, "constrained"]] as const) {
    test(`at ${width}x${height} (${profile}), F6 in the Commit view visits the header, the band, Changes, Staged, the diff, the message, and wraps (plan D15)`, async () => {
      await sized(width, height, async () => {
        const double = await mount(succeeded(REGISTRATION));
        expect(document.querySelector("[data-profile]")!.getAttribute("data-profile")).toBe(profile);
        await serveHistory(double);
        await resolve(double.pending("readWorkspace"), succeeded(snapshot(NOTICE)));
        await openCommitView();
        const sectionOf = () => document.activeElement!.closest("[data-section]")?.getAttribute("data-section");
        await act(async () => document.querySelector<HTMLElement>('header button[aria-keyshortcuts="Control+R"]')!.focus());
        const seen: (string | null | undefined)[] = [];
        for (let i = 0; i < 6; i++) {
          await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", code: "F6", bubbles: true, cancelable: true })));
          await settle();
          seen.push(sectionOf());
        }
        expect(seen).toEqual(["noticeHeading", "workingChanges", "staged", "comparison", "composer", "header"]);
        expect(document.activeElement === document.querySelector('header button[aria-keyshortcuts="Control+R"]')).toBe(true);
      });
    });
  }
});

describe("trust", () => {
  const report = (state: string, reads: boolean) => ({
    generation: 1,
    programs: {},
    state,
    persistence: "stored",
    approvalRequired: { reads, commit: false },
    entries: [],
    hooks: [],
  });

  // Feature 004 spec FR-072: a read that needs trust never prompts by itself.
  test("no dialog and no approval start when reads need an approval", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readTrust"), succeeded(report("untrusted", true)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(double.calls.some((c) => c.operation === "approveTrust")).toBe(false);
  });

  test("no dialog opens when reads need no approval", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readTrust"), succeeded(report("untrusted", false)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("T372: with TRUST_REQUIRED, a trust read above a report row bound shows its code and reason in the status bar", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code: "TRUST_REQUIRED" });
    await resolve(double.pending("readTrust"), { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code: "OUTPUT_LIMIT", result: { reason: "TRUST_REPORT_ENTRIES" } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect([...document.querySelectorAll('footer [role="status"]')].map((s) => s.textContent)).toContain("Trust review did not complete: OUTPUT_LIMIT TRUST_REPORT_ENTRIES");
  });
});

// Contract §3 `getEnvironment` and §6 "Dismissal".
describe("recovery markers", () => {
  const environment = (fields: Partial<Environment> = {}): Environment => ({
    buildIdentity: { version: "0.1.0", commit: "c".repeat(40), signing: "unsigned" },
    platformScope: "qualification-target",
    detectedVersion: "2.55.0.windows.3",
    minimumVersion: "2.55.0.windows.3",
    qualification: "unverified",
    markers: [],
    damagedMarkers: [],
    ...fields,
  });
  const MARKER = { markerId: crypto.randomUUID(), kind: "commit", startedAt: "2026-10-01T10:00:00Z", worktreeRoot: "C:\repo" } as Environment["markers"][number];
  const section = () => document.querySelector('[data-slot="recovery-markers"]');

  test("markers show with Dismiss above a mounted workbench", async () => {
    await mount(succeeded(REGISTRATION), environment({ markers: [MARKER] }));
    const markers = section();
    expect(markers?.textContent).toContain("Recovery markers");
    expect([...markers!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Dismiss"]);
    expect(markers!.compareDocumentPosition(document.querySelector("header")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[role="menubar"]')).not.toBeNull();
  });

  test("a dismissal re-reads the environment, and a result without markers removes the section", async () => {
    const double = await mount(succeeded(REGISTRATION), environment({ markers: [MARKER] }));
    await act(async () => section()!.querySelector("button")!.click());
    await settle();
    const dismissal = double.pending("dismissRecoveryMarker");
    expect(dismissal.args[0]).toEqual({ markerId: MARKER.markerId });
    await resolve(dismissal, succeeded({}));
    await resolve(double.pending("getEnvironment"), succeeded(environment()));
    expect(section()).toBeNull();
  });

  test("no section shows without markers", async () => {
    await mount(succeeded(REGISTRATION), environment());
    expect(section()).toBeNull();
  });
});

describe("help line", () => {
  test("the No selection help line states the staging sentence", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    await openCommitView();
    const changes = document.querySelector(COMMIT_VIEW)!.textContent ?? "";
    expect(changes).toContain(HELP_LINE);
    expect(changes).not.toContain("available after batch 3");
  });
});

// Review fixes of the UI batch. Each test renders the shipped mount with request state, or the workbench with the bridge double.
const latest = (double: { calls: Call[] }, operation: string) => double.calls.filter((c) => c.operation === operation).at(-1)!;
const changeEntry = (path: string): ChangeEntry => ({ entryId: crypto.randomUUID(), category: "unstaged", path, pathBytes: Buffer.from(path).toString("base64") }) as ChangeEntry;
const DIFF = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n+n\n b\n";
const shownComparison = (entryId: string, patch: string) => ({
  ...succeeded({
    comparisonId: crypto.randomUUID(),
    snapshotId: crypto.randomUUID(),
    entryId,
    scope: "index-to-worktree",
    completeness: { state: "complete" },
    patch: Buffer.from(patch).toString("base64"),
    hunks: [{ hunkId: crypto.randomUUID(), ordinal: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 3, digest: "1".repeat(64) }],
    support: "supported",
    fileAction: "stage",
    remedy: null,
  }),
  entryId,
});
const PANE = { density: "compact", profile: "wide", textScale: 1, menuOpen: false, modalOpen: false, onStatus: () => {}, selected: null, onSelectRow: () => {}, history: null as never, workbench: null as never, filterRef: { current: null } } as const;

async function render(node: () => ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node()));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, rerender: async (next: () => ReactNode) => act(async () => root.render(next())) };
}

describe("comparison mount", () => {
  test("the Pierre worker pool mounts once at the first diff and stays across selections, Loading, and patch changes", async () => {
    pool.mounts = 0;
    pool.unmounts = 0;
    const [a, b] = [changeEntry("a.txt"), changeEntry("b.txt")];
    const base = { repository: REGISTRATION, entries: [a, b], selectedHunk: null } as const;
    const view = (fields: Record<string, unknown>) => () => <ComparisonViewMount {...PANE} requests={{ refresh: () => {} } as never} state={{ ...base, ...fields } as never} />;
    const shown = await render(view({ selection: { entryId: a.entryId }, comparison: null }));
    expect(pool.mounts).toBe(0);
    await shown.rerender(view({ selection: { entryId: a.entryId }, comparison: shownComparison(a.entryId, DIFF) }));
    await settle();
    expect(shown.host.querySelector('[data-slot="patch-double"]')).not.toBeNull();
    await shown.rerender(view({ selection: { entryId: b.entryId }, comparison: shownComparison(a.entryId, DIFF) }));
    await settle();
    expect(shown.host.textContent).toContain("Loading…");
    await shown.rerender(view({ selection: { entryId: b.entryId }, comparison: shownComparison(b.entryId, DIFF.replace("+n", "+m")) }));
    await settle();
    await shown.rerender(view({ selection: null, comparison: null }));
    await settle();
    expect(pool).toEqual({ mounts: 1, unmounts: 0 });
  });

  test("the reset notice shows only when a new comparison of the same category and pathBytes has another patch", async () => {
    const NOTICE = "The file changed outside Arbareto. The view shows the new version.";
    const a = changeEntry("a.txt");
    // A new snapshot gives new entry IDs. The category and the path bytes identify the file.
    const again = { ...a, entryId: crypto.randomUUID() };
    const staged = { ...a, entryId: crypto.randomUUID(), category: "staged" } as ChangeEntry;
    const b = changeEntry("b.txt");
    const other = DIFF.replace("+n", "+m");
    const view = (entry: ChangeEntry, patch: string | null) => () => (
      <ComparisonViewMount
        {...PANE}
        requests={{ refresh: () => {} } as never}
        state={{ repository: REGISTRATION, entries: [entry], selectedHunk: null, selection: { entryId: entry.entryId }, comparison: patch === null ? null : shownComparison(entry.entryId, patch) } as never}
      />
    );
    const shown = await render(view(a, DIFF));
    await settle();
    const notice = () => shown.host.textContent!.includes(NOTICE);
    expect(notice()).toBe(false);
    await shown.rerender(view(again, DIFF));
    await settle();
    expect(notice()).toBe(false);
    await shown.rerender(view(again, null));
    await shown.rerender(view(again, other));
    await settle();
    expect(notice()).toBe(true);
    expect(shown.host.querySelector('[role="status"]')?.textContent).toBe(NOTICE);
    await shown.rerender(view(staged, DIFF));
    await settle();
    expect(notice()).toBe(false);
    await shown.rerender(view(b, other));
    await settle();
    expect(notice()).toBe(false);
  });
});

describe("history selection", () => {
  const [first, second] = ["1".repeat(40), "2".repeat(40)];

  test("the selected commit stays across a refresh while the new refs reach it, and else the checkout commit is selected (feature 002 spec FR-008)", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double, [second, first]);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot({ head: { state: "branch", target: "refs/heads/main", oid: second } })));
    await selectRow(first);
    await serveHistory(double, [second, first]);
    expect(document.querySelector('section[aria-label="Dock"]')!.textContent).toContain("Commit 1111");
    await act(async () => document.querySelector<HTMLElement>('button[aria-label="Refresh"]')!.click());
    await settle();
    await serveHistory(double, [second, first]);
    expect(double.calls.filter((c) => c.operation === "loadHistory").at(-1)!.args[1]).toEqual({ viewId: expect.any(String), need: { oid: first } });
    expect(document.querySelector('section[aria-label="Dock"]')!.textContent).toContain("Commit 1111");
    await act(async () => document.querySelector<HTMLElement>('button[aria-label="Refresh"]')!.click());
    await settle();
    await serveHistory(double, [second]);
    expect(document.querySelector('section[aria-label="Dock"]')!.textContent).toContain("Commit 2222");
  });
});

describe("repository menu", () => {
  // Feature 004 plan.md D12: Stop trusting sits in the status bar chip.
  test("the Stop trusting result text leaves when another repository opens", async () => {
    const double = await mount(succeeded(REGISTRATION));
    const report = { generation: 1, programs: {}, trustId: crypto.randomUUID(), state: "approved", persistence: "stored", approvalRequired: { reads: false, commit: true }, entries: [], hooks: [] };
    await resolve(latest(double, "readTrust"), succeeded(report));
    const openMenu = async () => {
      const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === "Repository")!;
      await act(async () => trigger.focus());
      await act(async () => trigger.click());
      await settle();
    };
    const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === label)!;
    await act(async () => document.querySelector<HTMLElement>('footer [data-slot="trust-chip"]')!.click());
    await settle();
    await act(async () => item("Stop trusting this repository").click());
    await settle();
    await resolve(latest(double, "revokeTrust"), succeeded({ endedProcesses: 0 }));
    expect(text()).toContain("Arbareto no longer trusts this repository.");
    await openMenu();
    await act(async () => item("Open folder…Ctrl+O").click());
    await settle();
    await resolve(latest(double, "chooseRepository"), succeeded({ repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "b".repeat(64) }));
    await openMenu();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(text()).not.toContain("Arbareto no longer trusts this repository.");
  });
});

// T364: plan.md "Store pane sizes in logical units".
describe("remembered pane sizes", () => {
  test("a stored sidebar width shows after a reload, a key step stores it, and Reset pane sizes stores every default", async () => {
    const before = window.innerWidth;
    (window as unknown as { happyDOM: { setInnerWidth(width: number): void } }).happyDOM.setInnerWidth(1600);
    try {
      writePreferences(localStorage, { ...DEFAULT_PREFERENCES, panes: { ...DEFAULT_PREFERENCES.panes, sidebar: 300, detailsDock: 240 } });
      await mount(succeeded(REGISTRATION));
      const splitter = document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize references sidebar"]')!;
      expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(300);
      await act(async () => void splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
      expect(readPreferences(localStorage).panes).toEqual({ ...DEFAULT_PREFERENCES.panes, sidebar: 308, detailsDock: 240 });
      expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(308);
      const view = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === "View")!;
      await act(async () => view.focus());
      await act(async () => view.click());
      await settle();
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === "Reset pane sizes")!.click());
      await settle();
      expect(readPreferences(localStorage).panes).toEqual(DEFAULT_PREFERENCES.panes);
      expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(DEFAULT_PREFERENCES.panes.sidebar);
    } finally {
      (window as unknown as { happyDOM: { setInnerWidth(width: number): void } }).happyDOM.setInnerWidth(before);
    }
  });

  // plan.md "Dock region": pointer and keyboard resizing change the docked panel height in both directions.
  test("the Working directory summary takes the History dock height, not the commit dock height", async () => {
    const before = window.innerWidth;
    (window as unknown as { happyDOM: { setInnerWidth(width: number): void } }).happyDOM.setInnerWidth(1600);
    try {
      const double = await mount(succeeded(REGISTRATION));
      await serveHistory(double);
      await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
      await selectRow(HEAD);
      const splitter = () => document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize dock"]')!;
      const details = Number(splitter().getAttribute("aria-valuenow"));
      await selectRow("working-directory");
      expect(Number(splitter().getAttribute("aria-valuenow"))).toBe(details);
      await act(async () => void splitter().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
      expect(Math.round(readPreferences(localStorage).panes.detailsDock!)).toBe(details - 8);
      expect(readPreferences(localStorage).panes.commitDock).toBeNull();
    } finally {
      (window as unknown as { happyDOM: { setInnerWidth(width: number): void } }).happyDOM.setInnerWidth(before);
    }
  });

  test("a keyboard shrink step lowers the History dock and stores it, and a grow step raises it", async () => {
    const before = window.innerWidth;
    (window as unknown as { happyDOM: { setInnerWidth(width: number): void } }).happyDOM.setInnerWidth(1600);
    try {
      const double = await mount(succeeded(REGISTRATION));
      await serveHistory(double);
      await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
      await selectRow(HEAD);
      const splitter = document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize dock"]')!;
      const key = (k: string) => act(async () => void splitter.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
      const start = Number(splitter.getAttribute("aria-valuenow"));
      expect(Number(splitter.getAttribute("aria-valuemin"))).toBeLessThan(start);
      // The dock sits below the splitter, so ArrowDown shrinks it.
      await key("ArrowDown");
      expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(start - 8);
      expect(Math.round(readPreferences(localStorage).panes.detailsDock!)).toBe(start - 8);
      await key("ArrowUp");
      expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(start);
      expect(Math.round(readPreferences(localStorage).panes.detailsDock!)).toBe(start);
    } finally {
      (window as unknown as { happyDOM: { setInnerWidth(width: number): void } }).happyDOM.setInnerWidth(before);
    }
  });
});

describe("file lane splitter", () => {
  type HappyWindow = { happyDOM: { setInnerWidth(width: number): void } };
  test("a pointer drag saves the wide file lane once, on pointer up", async () => {
    const before = window.innerWidth;
    (window as unknown as HappyWindow).happyDOM.setInnerWidth(1600);
    // happy-dom binds each Storage method on its first read, so a Storage.prototype spy misses later writes. A wrapper counts the writes.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    const real = localStorage;
    let writes = 0;
    const counting = {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => {
        writes++;
        real.setItem(key, value);
      },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => counting });
    try {
      const double = await mount(succeeded(REGISTRATION));
      await serveHistory(double);
      await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
      await openCommitView();
      const splitter = document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize file lane"]')!;
      expect(splitter).not.toBeNull();
      const start = Number(splitter.getAttribute("aria-valuenow"));
      const pointer = (type: string, clientX: number) => act(async () => void splitter.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX, bubbles: true })));
      await pointer("pointerdown", 500);
      await pointer("pointermove", 520);
      await pointer("pointermove", 540);
      expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(start + 40);
      expect(writes).toBe(0);
      await pointer("pointerup", 540);
      expect(writes).toBe(1);
      expect(readPreferences(localStorage).panes.fileLane).toBe(start + 40);
      // A drag back to its start value still ends the live width, so a later preference write shows.
      await pointer("pointerdown", 540);
      await pointer("pointermove", 560);
      await pointer("pointermove", 540);
      await pointer("pointerup", 540);
      const view = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === "View")!;
      await act(async () => view.focus());
      await act(async () => view.click());
      await settle();
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === "Reset pane sizes")!.click());
      await settle();
      expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(readPreferences(localStorage).panes.fileLane);
      expect(Number(splitter.getAttribute("aria-valuenow"))).not.toBe(start + 40);
    } finally {
      Object.defineProperty(globalThis, "localStorage", descriptor);
      (window as unknown as HappyWindow).happyDOM.setInnerWidth(before);
    }
  });
});

type SizedWindow = { happyDOM: { setInnerWidth(width: number): void; setInnerHeight(height: number): void } };
async function sized(width: number, height: number, run: () => Promise<void>) {
  const before = { width: window.innerWidth, height: window.innerHeight };
  const happy = (window as unknown as SizedWindow).happyDOM;
  happy.setInnerWidth(width);
  happy.setInnerHeight(height);
  try {
    await run();
  } finally {
    happy.setInnerWidth(before.width);
    happy.setInnerHeight(before.height);
  }
}

// plan.md "Keyboard and focus", File list row: a click and each navigation key select an entry and read its comparison.
describe("selection follows focus", () => {
  test("a click and fast ArrowDown presses each read one comparison, and only the last response shows", async () => {
    const entries = ["a.txt", "b.txt", "c.txt"].map(changeEntry);
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot({ entries, entryCount: entries.length })));
    await openCommitView();
    const first = document.querySelector<HTMLElement>(`${COMMIT_VIEW} [role="treeitem"]`)!;
    await act(async () => {
      first.focus();
      first.click();
    });
    for (let i = 0; i < 2; i++) await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true })));
    const reads = double.calls.filter((c) => c.operation === "readComparison");
    expect(reads.map((c) => (c.args[1] as { entryId: string }).entryId)).toEqual(entries.map((e) => e.entryId));
    expect(new Set(reads.map((c) => (c.args[0] as { selectionId: string }).selectionId)).size).toBe(3);
    // The last response arrives first. The superseded responses arrive after it and show nothing.
    for (const i of [2, 0, 1]) await resolve(reads[i]!, shownComparison(entries[i]!.entryId, DIFF.replace("+n", `+line${i}`)));
    const shown = document.querySelector('[data-slot="patch-double"]')?.textContent ?? "";
    expect(shown).toContain("+line2");
    expect(shown).not.toContain("+line0");
    expect(shown).not.toContain("+line1");
  });
});

// plan.md "Section minima" and "Constrained sizes": each pane scrolls inside its own bounds, and the work area does not scroll.
describe("pane scrolling", () => {
  const scrolls = (e: Element) => /\boverflow-(y-)?auto\b/.test(e.getAttribute("class") ?? "");
  const scroller = (e: Element | null) => {
    for (let n = e; n !== null; n = n.parentElement) if (scrolls(n)) return n;
    return null;
  };
  const staged = (path: string) => ({ ...changeEntry(path), category: "staged" }) as ChangeEntry;

  for (const [width, height, profile] of [
    [1600, 900, "wide"],
    [1000, 900, "narrow"],
    [720, 480, "constrained"],
  ] as const) {
    test(`at ${width}x${height} (${profile}), each pane has its own scroll container, and the work area has none`, async () => {
      await sized(width, height, async () => {
        const entries = [changeEntry("a.txt"), changeEntry("b.txt"), staged("c.txt")];
        const double = await mount(succeeded(REGISTRATION));
        await serveHistory(double);
        await resolve(double.pending("readWorkspace"), succeeded(snapshot({ entries, entryCount: entries.length, submoduleNotice: { count: 1, paths: ["s"], filter: "applied" } })));
        expect(document.querySelector("[data-profile]")?.getAttribute("data-profile")).toBe(profile);
        const main = document.querySelector("main")!;
        expect(scroller(main) === null).toBe(true);
        // Booleans only: a failed DOM comparison would print the whole window.
        const own = (pane: Element | null) => {
          expect(pane !== null).toBe(true);
          const s = scroller(pane);
          expect(s !== null && s !== main && main.contains(s)).toBe(true);
          return s === pane;
        };
        const band = document.querySelector<HTMLElement>('[data-slot="notice-band"]')!;
        expect(own(band)).toBe(true);
        expect(band.style.maxHeight).not.toBe("");
        const area = document.querySelector<HTMLElement>('[data-slot="status-area"]')!;
        expect(own(area)).toBe(true);
        expect(area.style.maxHeight).not.toBe("");

        // The references sidebar scrolls inside its own region.
        const tree = document.querySelector('[data-section="references"]')!;
        expect(tree !== null).toBe(true);
        await openCommitView();
        const changes = commitGrid();
        const listboxes = [...changes.querySelectorAll('[role="tree"]')];
        expect(listboxes).toHaveLength(2);
        for (const box of listboxes) expect(own(box)).toBe(true);
        const cells = [...changes.children].filter((c) => ["lane", "comparison", "tray"].includes((c as HTMLElement).style.gridArea.split(" ")[0]!));
        expect(cells).toHaveLength(3);
        for (const cell of cells) expect(own(cell)).toBe(true);
        // Changes and Staged each scroll inside their own section.
        const sections = [...changes.querySelectorAll('[role="tree"]')].map((box) => box.closest("section:not([aria-label])"));
        expect(new Set(sections).size).toBe(2);
        for (const section of sections) expect(scrolls(section!)).toBe(true);
        // The constrained file band holds both sections side by side ("Chosen layout, sizes, and DPI"). The narrow Commit view uses the list column (004 plan D16 "Geometry").
        expect(sections[0]!.parentElement!.className.split(/\s+/)).toContain(profile === "constrained" ? "flex-row" : "flex-col");

        await switchView("History");
        const history = document.querySelector('section[aria-label="History"]')!;
        const list = history.querySelector('[role="listbox"]')!;
        expect(own(list)).toBe(true);
        await selectRow(HEAD);
        const details = document.querySelector('[data-section="commitDetails"] section')!;
        const body = [...details.querySelectorAll("div")].find((d) => scrolls(d))!;
        expect(own(body)).toBe(true);
        expect(scroller(main) === null).toBe(true);
      });
    });
  }

  test("at 720x480 compact with one band row, the file band and the tray take the reduced pane minimum", async () => {
    await sized(720, 480, async () => {
      const double = await mount(succeeded(REGISTRATION));
      await serveHistory(double);
      await resolve(double.pending("readWorkspace"), succeeded(snapshot({ entries: [changeEntry("a.txt")], entryCount: 1, submoduleNotice: { count: 1, paths: ["s"], filter: "applied" } })));
      await openCommitView();
      const rows = commitGrid().style.gridTemplateRows.split(/\s+(?![^(]*\))/);
      expect(rows).toEqual(["58px", "0", "minmax(0px, 1fr)", "0", "58px"]);
    });
  });
});

// T354: plan.md "Chosen layout: one view", "Header layout", "Dock region", "Keyboard and focus", and "Measurements and budgets".
describe("single view", () => {
  const WSL_SNAPSHOT = { location: { kind: "wsl", distro: "Ubuntu-26.04", git: { path: "/usr/bin/git", version: "2.55.0" } }, identity: { ...snapshot().identity, worktreeRoot: "\\\\wsl.localhost\\Ubuntu-26.04\\home\\me\\repo" } } as unknown as Partial<WorkspaceSnapshot>;
  const opened = async (fields: Partial<WorkspaceSnapshot> = {}, environment: Environment | null = null) => {
    const double = await mount(succeeded(REGISTRATION), environment);
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot(fields)));
    return double;
  };
  const follows = (a: Element | null, b: Element | null) => a !== null && b !== null && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  test("the toolbar holds the switcher, the WSL label, the branch text, the menu bar, Refresh, and Commit, in that order", async () => {
    await opened(WSL_SNAPSHOT);
    const header = document.querySelector("header")!;
    const items = [
      header.querySelector('button[aria-keyshortcuts="Control+R"]'),
      header.querySelector('[data-slot="wsl-badge"]'),
      header.querySelector('[data-slot="branch-text"]'),
      header.querySelector('[role="menubar"]'),
      header.querySelector('button[aria-label="Refresh"]'),
      header.querySelector('button[aria-label^="Commit:"]'),
    ];
    expect(items.map((i) => i !== null)).toEqual([true, true, true, true, true, true]);
    for (let i = 1; i < items.length; i++) expect(follows(items[i - 1]!, items[i]!)).toBe(true);
    expect(header.querySelector('[data-slot="branch-text"]')!.getAttribute("title")).toBe("main");
    expect(header.querySelector('button[aria-label="Refresh"]')!.getAttribute("aria-keyshortcuts")).toBe("F5");
  });

  test("the Commit button names both counts and opens the Commit view (plan D15 top bar)", async () => {
    const entries = [changeEntry("a.txt"), { ...changeEntry("b.txt"), category: "staged" } as ChangeEntry];
    await opened({ entries, entryCount: 2 });
    const commit = document.querySelector<HTMLElement>('header button[aria-label^="Commit:"]')!;
    expect(commit.getAttribute("aria-label")).toBe("Commit: 1 working change, 1 staged");
    await act(async () => commit.click());
    await settle();
    const view = document.querySelector(COMMIT_VIEW);
    expect(view).not.toBeNull();
    expect(view!.closest("[hidden]")).toBeNull();
    expect(document.querySelector('header nav[aria-label="Views"] button[aria-current="page"]')?.textContent).toBe("Commit");
  });

  test("one notice band spans the width above the sidebar and the history list", async () => {
    await opened({ submoduleNotice: { count: 1, paths: ["s"], filter: "applied" } });
    expect(document.querySelectorAll('[data-slot="notice-band"]')).toHaveLength(1);
    expect(follows(document.querySelector('[data-slot="notice-band"]'), document.querySelector('[data-section="references"]'))).toBe(true);
  });

  test("the references sidebar is a column with its splitter, and the constrained profile collapses it to its toggle", async () => {
    await sized(1600, 900, async () => {
      await opened();
      expect(document.querySelector('[data-section="references"] h2')?.textContent).toBe("References");
      expect(document.querySelector('[role="separator"][aria-label="Resize references sidebar"]')).not.toBeNull();
    });
    await sized(720, 480, async () => {
      await opened();
      const toggles = document.querySelectorAll('button[aria-label="Show references"]');
      expect(toggles.length).toBeGreaterThan(0);
      expect(toggles[toggles.length - 1]!.getAttribute("aria-expanded")).toBe("false");
    });
  });

  test("a row selection changes the dock; only a commit row reads its details text (feature 002 spec FR-017)", async () => {
    const double = await opened();
    const before = double.calls.length;
    await selectRow("working-directory");
    expect(document.querySelector('section[aria-label="Working directory summary"]')!.closest("[hidden]")).toBeNull();
    await selectRow("index");
    expect(double.calls.slice(before).map((c) => c.operation)).toEqual([]);
    await selectRow(HEAD);
    expect(document.querySelector('section[aria-label="Dock"]')!.textContent).toContain("Selected commit");
    expect(double.calls.slice(before).map((c) => [c.operation, (c.args[1] as { text?: string }).text])).toEqual([["readHistoryRows", "details"]]);
  });

  test("the History-ready, Commit-panel-ready, and Details-ready marks follow their states once each", async () => {
    const mark = spyOn(performance, "mark");
    try {
      const double = await opened();
      const count = (name: string) => mark.mock.calls.filter(([n]) => n === name).length;
      expect(count("arbareto:history-painted")).toBe(1);
      expect(count("arbareto:commit-panel-ready")).toBe(0);
      await selectRow("working-directory");
      expect(count("arbareto:commit-panel-ready")).toBe(1);
      await selectRow(HEAD);
      // The Details-ready mark waits for the details read.
      expect(count("arbareto:details-ready")).toBe(0);
      await serveHistory(double);
      expect(count("arbareto:details-ready")).toBe(1);
      await selectRow("index");
      expect(count("arbareto:commit-panel-ready")).toBe(2);
    } finally {
      mark.mockRestore();
    }
  });

  test("F6 moves from the header to the references sidebar, then to the history list, and wraps", async () => {
    await opened();
    const f6 = async () => {
      await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", code: "F6", bubbles: true, cancelable: true })));
      await settle();
    };
    await act(async () => document.querySelector<HTMLElement>('header button[aria-keyshortcuts="Control+R"]')!.focus());
    await f6();
    expect(document.activeElement!.closest("[data-section]")?.getAttribute("data-section")).toBe("references");
    await f6();
    expect(document.activeElement!.closest("[data-section]")?.getAttribute("data-section")).toBe("historyList");
    await f6();
    expect(document.activeElement!.closest("[data-section]")?.getAttribute("data-section")).toBe("header");
  });

  test("Ctrl+O runs the folder dialog, and Ctrl+R opens the switcher", async () => {
    const double = await opened();
    const key = (k: string) => act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: `Key${k.toUpperCase()}`, keyCode: k.toUpperCase().charCodeAt(0), ctrlKey: true, bubbles: true, cancelable: true })));
    await key("o");
    await settle();
    expect(double.calls.filter((c) => c.operation === "chooseRepository")).toHaveLength(1);
    await key("r");
    await settle();
    expect(document.querySelector('[role="combobox"]')).not.toBeNull();
    expect(double.calls.filter((c) => c.operation === "listRecentRepositories")).toHaveLength(1);
  });

  test("the status bar ends with Git <version> outside every live region", async () => {
    const environment = { buildIdentity: { version: "0.1.0", commit: "c".repeat(40), signing: "unsigned" }, platformScope: "qualification-target", detectedVersion: "2.55.0.windows.3", minimumVersion: "2.55.0.windows.3", qualification: "unverified", markers: [], damagedMarkers: [] } as unknown as Environment;
    await opened({}, environment);
    const version = document.querySelector('footer [data-slot="git-version"]')!;
    expect(version.textContent).toBe("Git 2.55.0.windows.3");
    expect(version.closest('[role="status"]')).toBeNull();
    expect(document.querySelector("footer")!.lastElementChild).toBe(version);
  });

  test("a WSL workspace names its distro after the Git version", async () => {
    await opened(WSL_SNAPSHOT);
    expect(document.querySelector('footer [data-slot="git-version"]')!.textContent).toBe("Git 2.55.0 (WSL: Ubuntu-26.04)");
  });

  // Feature 003 FR-038 and FR-039 add Fetch, Pull, Push, and Commit and push. Stash, Clone, and settings stay absent.
  test("no Stash, Clone, or settings control renders anywhere (FR-056)", async () => {
    await opened();
    await openCommitView();
    const names = [...document.querySelectorAll('button, [role="menuitem"], [role="tab"], a')].map((e) => `${e.getAttribute("aria-label") ?? ""} ${e.textContent ?? ""}`);
    for (const name of names) expect(name).not.toMatch(/\b(stash|clone|settings)\b/i);
  });
});

// Contract §3 `chooseGit`: Select Git in the repository menu shows a refused selection in the status bar. A canceled one shows nothing.
describe("Select Git result", () => {
  test("a rejected chooseGit shows its code in the status bar, and a canceled one shows nothing", async () => {
    const responses = [
      { requestId: crypto.randomUUID(), state: "canceled" },
      { requestId: crypto.randomUUID(), state: "rejected", code: "GIT_UNAVAILABLE", result: { minimumVersion: "2.55.0.windows.3" } },
    ];
    const double = bridgeDouble();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <Workbench
          bridge={double.bridge as never}
          restored={Promise.resolve(succeeded(REGISTRATION)) as never}
          onSelectGit={async () => responses.shift() as never}
          ChangesPane={ChangesPaneMount}
          ComparisonView={ComparisonViewMount}
          HistoryView={HistoryViewMount}
        />,
      ),
    );
    unmounts.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    await settle();
    const status = () => [...document.querySelectorAll('footer [role="status"]')].map((s) => s.textContent).join(" | ");
    const choose = async () => {
      const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === "Repository")!;
      await act(async () => trigger.focus());
      await act(async () => trigger.click());
      await settle();
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === "Select Git")!.click());
      await settle();
    };
    await choose();
    expect(status()).not.toContain("Select Git did not complete");
    await choose();
    expect(status()).toContain("Select Git did not complete: GIT_UNAVAILABLE");
    // B4-5: a text that ends in a code has no final period (plan.md "Status and fallback texts").
    expect(status()).not.toContain("GIT_UNAVAILABLE.");
  });
});

// plan.md "Motion": a popup that the keyboard opens shows at once. Base UI sets no `data-instant` for the Ctrl+R open, which has no trigger event.
describe("switcher open motion", () => {
  const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]');
  test("a Ctrl+R open has data-instant, and a pointer open does not", async () => {
    await mount(succeeded(REGISTRATION));
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", keyCode: 82, ctrlKey: true, bubbles: true, cancelable: true })));
    await settle();
    expect(popup()).not.toBeNull();
    expect(popup()!.hasAttribute("data-instant")).toBe(true);
    await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })));
    await settle();
    expect(popup()).toBeNull();
    const trigger = document.querySelector<HTMLElement>('header button[aria-keyshortcuts="Control+R"]')!;
    // A pointer click carries `detail` 1. Base UI reads `detail` 0 as a keyboard click.
    await act(async () => void trigger.dispatchEvent(new MouseEvent("click", { detail: 1, button: 0, bubbles: true, cancelable: true })));
    await settle();
    expect(popup()).not.toBeNull();
    expect(popup()!.hasAttribute("data-instant")).toBe(false);
  });
});

// plan.md "Switch repository": a switch never discards a draft. The draft store keeps each worktree's draft.
describe("drafts across a switch", () => {
  // T121 and T148: contract §2. A `service-session` event runs `restoreWorkspace` again and keeps the page.
  test("after a `service-session` event, the Workbench keeps the composer text and the page does not reload", async () => {
    const double = bridgeDouble();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const restored = Promise.resolve(succeeded(REGISTRATION)) as never;
    const render = (session: number) =>
      act(async () => root.render(<Workbench bridge={double.bridge as never} restored={restored} session={session} ChangesPane={ChangesPaneMount} ComparisonView={ComparisonViewMount} HistoryView={HistoryViewMount} />));
    unmounts.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    await render(0);
    await settle();
    await openCommitView();
    const field = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Unsent draft");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const header = document.querySelector("header");
    const environments = double.calls.filter((c) => c.operation === "getEnvironment").length;
    await render(1);
    await settle();
    expect(double.calls.filter((c) => c.operation === "getEnvironment").length).toBe(environments + 1);
    await resolve(latest(double, "restoreWorkspace"), succeeded(REGISTRATION));
    // The same Workbench tree stays mounted, so the page did not reload.
    expect(document.querySelector("header")).toBe(header);
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Unsent draft");
  });

  // The history list options stay outside the switcher popup.
  const switcherOptions = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter((o) => o.closest('section[aria-label="History"]') === null);

  test("an unsent message draft stays in the draft store after a switch through the repository switcher, and returns with its worktree", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await openCommitView();
    const field = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Unsent draft");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLElement>('header button[aria-keyshortcuts="Control+R"]')!.click());
    await settle();
    await resolve(latest(double, "listRecentRepositories"), succeeded({ entries: [{ entryId: crypto.randomUUID(), path: "C:\other", location: { kind: "native" }, openedAt: "2026-10-10T08:00:00Z", current: false }] }));
    await act(async () => switcherOptions()[1]!.click());
    await resolve(latest(double, "openRecentRepository"), succeeded({ repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "b".repeat(64), worktreeRoot: "C:\other" }));
    expect(double.calls.some((c) => c.operation === "removeDraft")).toBe(false);
    // The other worktree has no draft. Its field shows no text. Data-model §14: each worktree keeps its own view, so the other one opens in History.
    await openCommitView();
    expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    // A switch back restores the draft of the first worktree.
    await act(async () => document.querySelector<HTMLElement>('header button[aria-keyshortcuts="Control+R"]')!.click());
    await settle();
    await resolve(latest(double, "listRecentRepositories"), succeeded({ entries: [{ entryId: crypto.randomUUID(), path: "C:\\repo", location: { kind: "native" }, openedAt: "2026-10-10T08:00:00Z", current: false }] }));
    await act(async () => switcherOptions()[1]!.click());
    await resolve(latest(double, "openRecentRepository"), succeeded(REGISTRATION));
    expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Unsent draft");
  });
});

// T362: plan.md "Compact token system" (Icons, repository menu) and "Status area".
describe("menus", () => {
  const openMenu = async (name: string) => {
    const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === name)!;
    await act(async () => trigger.focus());
    await act(async () => trigger.click());
    await settle();
    return document.querySelector<HTMLElement>('[data-slot="menubar-content"]')!;
  };

  test("the repository menu holds actions only, with keys in a right-aligned column that never wraps", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    const menu = await openMenu("Repository");
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const label = (e: HTMLElement) => [...e.childNodes].filter((n) => !(n instanceof HTMLElement && n.dataset.slot === "menubar-shortcut")).map((n) => n.textContent).join("").trim();
    // Feature 003 plan.md D12 adds Clone… and Settings….
    expect(items.map(label)).toEqual(["Open folder…", "Recent repositories", "Clone…", "Select Git", "Settings…", "Update submodules"]);
    const keys = [...menu.querySelectorAll<HTMLElement>('[data-slot="menubar-shortcut"]')];
    expect(keys.map((k) => k.textContent)).toEqual(["Ctrl+O", "Ctrl+R"]);
    for (const k of keys) expect(k.className.split(/\s+/)).toEqual(expect.arrayContaining(["ml-auto", "whitespace-nowrap", "text-muted-text"]));
    expect(items.slice(0, 2).map((e) => e.getAttribute("aria-keyshortcuts"))).toEqual(["Control+O", "Control+R"]);
    for (const absent of ["C:\\repo", "HEAD:", "Git:", "Version"]) expect(menu.textContent).not.toContain(absent);
    expect(menu.className.split(/\s+/)).toContain("min-w-[220px]");
  });

  test("the View menu keeps the 220 DIP minimum width", async () => {
    await mount(succeeded(REGISTRATION));
    expect((await openMenu("View")).className.split(/\s+/)).toContain("min-w-[220px]");
  });

  test("the Unqualified platform label follows the Git version in the status bar, outside every live region", async () => {
    const environment = { buildIdentity: { version: "0.1.0", commit: "c".repeat(40), signing: "unsigned" }, platformScope: "other", detectedVersion: "2.55.0.windows.3", minimumVersion: "2.55.0.windows.3", qualification: "unverified", markers: [], damagedMarkers: [] } as unknown as Environment;
    await mount(succeeded(REGISTRATION), environment);
    const segment = document.querySelector('footer [data-slot="git-version"]')!;
    expect(segment.textContent).toBe("Git 2.55.0.windows.3Unqualified platform");
    expect(segment.closest('[role="status"]')).toBeNull();
  });
});

// T362: plan.md "Header layout" and "Long text": the branch text of a very long branch name.
describe("toolbar branch text", () => {
  const LONG = "feature/ACS-10545-a-very-long-branch-name-that-goes-on-and-on-and-on";
  test('it shows a middle ellipsis, holds the full name in its tooltip and accessible text, and the branch button takes the free width (004 plan.md D15 "Top bar row")', async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot({ head: { state: "branch", target: `refs/heads/${LONG}`, oid: HEAD } })));
    const branch = document.querySelector<HTMLElement>('header [data-slot="branch-text"]')!;
    expect(branch.getAttribute("title")).toBe(LONG);
    expect(branch.querySelector(".sr-only")?.textContent).toBe(LONG);
    const parts = [...branch.querySelectorAll<HTMLElement>("[data-branch-part]")].map((p) => [p.dataset.branchPart, p.textContent, p.className.split(/\s+/).includes("truncate")]);
    expect(parts).toEqual([
      ["folder", "feature/", true],
      ["last", "ACS-10545-a-very-long-branch-name-that-goes-on-and-on-and-on", true],
    ]);
    // T109: the text counts in the button width. The button takes the free width (plan.md D15 "Top bar row").
    expect(branch.style.flex).toBe("0 1 auto");
    expect(branch.closest<HTMLElement>('[data-slot="branch-button"]')!.style.flexGrow).toBe("1000");
    expect(branch.className.split(/\s+/)).toContain("min-w-0");
  });
});

// T148 review fixes: the commit trust gate, the status bar notice, and the failed file action output.
describe("mounted staging and commit", () => {
  const trustReport = (commit: boolean) => ({ generation: 1, programs: {}, state: "untrusted", persistence: "stored", approvalRequired: { reads: false, commit }, entries: [], hooks: [] });
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
  const typeMessage = async (text: string) => {
    const field = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return field;
  };
  const stagedEntry = () => ({ ...changeEntry("a.txt"), category: "staged" }) as ChangeEntry;
  async function openCommitPanel() {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    const entry = stagedEntry();
    const shown = snapshot({ entries: [entry], entryCount: 1 });
    await resolve(latest(double, "readWorkspace"), succeeded(shown));
    await openCommitView();
    await typeMessage("Fix the parser");
    return { double, entry, shown };
  }
  async function approveCommitTrust(double: Awaited<ReturnType<typeof openCommitPanel>>["double"]) {
    await resolve(latest(double, "readTrust"), succeeded(trustReport(false)));
    await act(async () => button("Commit (Ctrl+Enter)").click());
    await settle();
    await resolve(latest(double, "readTrust"), succeeded(trustReport(true)));
    await resolve(latest(double, "approveTrust"), succeeded({ trustId: crypto.randomUUID(), persistence: "stored", saveFailed: false }));
  }

  // T121 and T148: plan.md "Stored drafts". A suggested commit message stays until the user clears it.
  test("the Clear message button of the status area clears the composer draft", async () => {
    const { double } = await openCommitPanel();
    await resolve(latest(double, "readTrust"), succeeded(trustReport(false)));
    await act(async () => button("Commit (Ctrl+Enter)").click());
    await settle();
    await resolve(latest(double, "readTrust"), succeeded(trustReport(false)));
    await resolve(latest(double, "reviewCommit"), succeeded(commitReviewed(crypto.randomUUID())));
    const effects = { head: true, index: true, workingFiles: false, operationState: false };
    await resolve(latest(double, "commit"), { ...succeeded({ commitOid: "2".repeat(40), effects, lingeringDescendants: 0 }), state: "completed-with-effects" });
    const field = document.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(field.value).toBe("Fix the parser");
    await act(async () => button("Clear message").click());
    await settle();
    expect(field.value).toBe("");
  });

  test("a read after the approval that returns the shown snapshot ends the gate, and reviewCommit names that snapshot", async () => {
    const { double, shown } = await openCommitPanel();
    await approveCommitTrust(double);
    const after = latest(double, "readWorkspace");
    expect(after.args[1]).toEqual({ refresh: false, check: "full" });
    expect(double.calls.some((c) => c.operation === "reviewCommit")).toBe(false);
    await resolve(after, succeeded(shown));
    expect(latest(double, "reviewCommit").args[1]).toEqual({ snapshotId: shown.snapshotId });
  });

  test("a failed read after the approval also ends the gate", async () => {
    const { double, shown } = await openCommitPanel();
    await approveCommitTrust(double);
    await resolve(latest(double, "readWorkspace"), { requestId: crypto.randomUUID(), state: "failed", code: "GIT_FAILED" });
    expect(latest(double, "reviewCommit").args[1]).toEqual({ snapshotId: shown.snapshotId });
  });

  test("a read that started before the approval does not end the gate", async () => {
    const { double } = await openCommitPanel();
    await resolve(latest(double, "readTrust"), succeeded(trustReport(false)));
    await act(async () => document.querySelector<HTMLElement>('header button[aria-label="Refresh"]')!.click());
    await settle();
    const before = latest(double, "readWorkspace");
    await act(async () => button("Commit (Ctrl+Enter)").click());
    await settle();
    await resolve(latest(double, "readTrust"), succeeded(trustReport(true)));
    await resolve(latest(double, "approveTrust"), succeeded({ trustId: crypto.randomUUID(), persistence: "stored", saveFailed: false }));
    const own = latest(double, "readWorkspace");
    expect(own).not.toBe(before);
    await resolve(before, succeeded(snapshot({ entries: [stagedEntry()], entryCount: 1 })));
    expect(double.calls.some((c) => c.operation === "reviewCommit")).toBe(false);
    const after = snapshot({ entries: [stagedEntry()], entryCount: 1 });
    await resolve(own, succeeded(after));
    expect(latest(double, "reviewCommit").args[1]).toEqual({ snapshotId: after.snapshotId });
  });

  test("a read after the approval that empties the Staged list stops the commit, sends no reviewCommit, and focuses the message field", async () => {
    const { double } = await openCommitPanel();
    await approveCommitTrust(double);
    await resolve(latest(double, "readWorkspace"), succeeded(snapshot()));
    expect(double.calls.some((c) => c.operation === "reviewCommit")).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("textarea"));
  });

  test("after a commit trust approval, reviewCommit names the snapshot of the read after the approval, and the status notice shows beside the outcome", async () => {
    const { double, entry } = await openCommitPanel();
    await resolve(latest(double, "readTrust"), succeeded(trustReport(false)));
    await act(async () => button("Commit (Ctrl+Enter)").click());
    await settle();
    await resolve(latest(double, "readTrust"), succeeded(trustReport(true)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(latest(double, "approveTrust").args[1]).toEqual({ action: "commit" });
    await resolve(latest(double, "approveTrust"), succeeded({ trustId: crypto.randomUUID(), persistence: "stored", saveFailed: false }));
    expect(double.calls.some((c) => c.operation === "reviewCommit")).toBe(false);
    const after = snapshot({ entries: [{ ...entry, entryId: crypto.randomUUID() }], entryCount: 1 });
    await resolve(latest(double, "readWorkspace"), succeeded(after));
    expect(latest(double, "reviewCommit").args[1]).toEqual({ snapshotId: after.snapshotId });
    await resolve(latest(double, "reviewCommit"), succeeded(commitReviewed(crypto.randomUUID())));
    await resolve(latest(double, "commit"), succeeded({ commitOid: "2".repeat(40) }));
    const status = () => [...document.querySelectorAll('footer [role="status"]')].map((s) => s.textContent).join(" | ");
    expect(status()).toContain("Committed 222222222222 to main");
    await act(async () => document.querySelector<HTMLElement>('header button[aria-label="Refresh"]')!.click());
    await settle();
    expect(status()).toContain("Refreshing…");
    expect(status()).toContain("Committed 222222222222 to main");
  });

  test("a late first trust read keeps the pending commit approval, and the approval continues the commit", async () => {
    const { double, shown } = await openCommitPanel();
    const initial = latest(double, "readTrust");
    await act(async () => button("Commit (Ctrl+Enter)").click());
    await settle();
    await resolve(latest(double, "readTrust"), succeeded(trustReport(true)));
    await resolve(initial, succeeded(trustReport(false)));
    expect(double.calls.filter((c) => c.operation === "approveTrust")).toHaveLength(1);
    expect(double.calls.some((c) => c.operation === "reviewCommit")).toBe(false);
    await resolve(latest(double, "approveTrust"), succeeded({ trustId: crypto.randomUUID(), persistence: "stored", saveFailed: false }));
    await resolve(latest(double, "readWorkspace"), succeeded(shown));
    expect(latest(double, "reviewCommit").args[1]).toEqual({ snapshotId: shown.snapshotId });
  });

  test("a failed Stage file shows its output below the comparison heading, also after the next read issues a new comparison ID", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    const entry = changeEntry("a.txt");
    const first = snapshot({ entries: [entry], entryCount: 1 });
    await resolve(latest(double, "readWorkspace"), succeeded(first));
    await resolve(latest(double, "readTrust"), succeeded(trustReport(false)));
    await openCommitView();
    await act(async () => document.querySelector<HTMLElement>(`[role="treeitem"][data-entry-id="${entry.entryId}"]`)!.click());
    await settle();
    const shown = shownComparison(entry.entryId, DIFF);
    await resolve(latest(double, "readComparison"), { ...shown, result: { ...(shown.result as object), snapshotId: first.snapshotId } });
    await act(async () => button("Stage file (Space)").click());
    await settle();
    const TAIL = "error: <b>stopped</b>\n";
    const COMMAND = "git --literal-pathspecs add -- a.txt";
    await resolve(latest(double, "applyFile"), { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code: "GIT_FAILED", result: { outputTail: TAIL, remedy: { text: "Run it in a terminal.", command: COMMAND } } });
    const comparison = () => document.querySelector('[data-section="comparison"]')!;
    const tail = () => [...comparison().querySelectorAll("pre")].some((p) => p.textContent === TAIL);
    expect(tail()).toBe(true);
    expect(comparison().querySelector("b")).toBeNull();
    expect(comparison().textContent).toContain(COMMAND);
    const again = { ...entry, entryId: crypto.randomUUID() };
    const second = snapshot({ entries: [again], entryCount: 1 });
    await resolve(latest(double, "readWorkspace"), succeeded(second));
    const next = shownComparison(again.entryId, DIFF);
    await resolve(latest(double, "readComparison"), { ...next, result: { ...(next.result as object), snapshotId: second.snapshotId } });
    expect(tail()).toBe(true);
  });
});

// Feature 002 T045: the branch scope controls, the shortcuts, and the "References changed" notice in the workbench (plan.md D6, contract Δ8).
describe("history scope and shortcuts", () => {
  const ref = (name: string, commitId: string) => ({ kind: "branch" as const, name, invalidUtf8: false, objectId: commitId, objectType: "commit" as const, peeledId: null, peeledType: null, symref: null, upstream: null, upstreamPresent: false, commitId });
  const refsList = (refsDigest: string) => ({ generation: 1, refs: [ref("feature", "2".repeat(40)), ref("main", HEAD)], refsDigest, current: { name: "main", objectId: HEAD }, completeness: { state: "complete" as const } });
  const opened = async () => {
    const double = await mount(succeeded(REGISTRATION));
    await serveHistory(double);
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    await resolve(latest(double, "readRefs"), succeeded(refsList("0".repeat(64))));
    return double;
  };
  const scopes = (double: { calls: Call[] }) => double.calls.filter((c) => c.operation === "openHistory").map((c) => (c.args[1] as { scope: string }).scope);
  const chip = () => document.querySelector<HTMLElement>('section[aria-label="History"] [data-slot="scope-chip"]');
  const press = async (init: KeyboardEventInit, target: EventTarget = document.activeElement ?? document.body) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => void target.dispatchEvent(event));
    await settle();
    return event;
  };
  const viewMenu = async () => {
    const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === "View")!;
    await act(async () => trigger.focus());
    await act(async () => trigger.click());
    await settle();
    return [...document.querySelectorAll<HTMLElement>('[data-slot="menubar-content"] [role="menuitemcheckbox"]')].find((e) => (e.textContent ?? "").startsWith("Current branch only"))!;
  };

  test("the View menu checkbox Current branch only names Ctrl+Shift+B, switches the scope, and shows its state", async () => {
    const double = await opened();
    const item = await viewMenu();
    expect(item.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+B");
    expect(item.getAttribute("aria-checked")).toBe("false");
    expect(item.textContent).toContain("Ctrl+Shift+B");
    await act(async () => item.click());
    await settle();
    await serveHistory(double);
    expect(scopes(double)).toEqual(["all", "current"]);
    expect(chip()?.textContent).toContain("Current branch only");
    // A checkbox item keeps its menu open.
    const shown = [...document.querySelectorAll<HTMLElement>('[data-slot="menubar-content"] [role="menuitemcheckbox"]')].find((e) => (e.textContent ?? "").startsWith("Current branch only"))!;
    expect(shown.getAttribute("aria-checked")).toBe("true");
  });

  test("Ctrl+Shift+B toggles the scope, also from the filter text box", async () => {
    const double = await opened();
    await press({ key: "B", code: "KeyB", keyCode: 66, ctrlKey: true, shiftKey: true }, document.body);
    await serveHistory(double);
    expect(scopes(double)).toEqual(["all", "current"]);
    expect(chip()).not.toBeNull();
    const filter = document.querySelector<HTMLInputElement>('input[aria-label="Filter commit messages"]')!;
    await act(async () => filter.focus());
    const event = await press({ key: "B", code: "KeyB", keyCode: 66, ctrlKey: true, shiftKey: true }, filter);
    expect(event.defaultPrevented).toBe(true);
    await serveHistory(double);
    expect(scopes(double)).toEqual(["all", "current", "all"]);
    expect(chip()).toBeNull();
  });

  // happy-dom has no native button activation. The test proves that no handler takes Enter or Space from the native button, then runs its activation.
  for (const key of ["Enter", " "])
    test(`the chip remove control is a native button with an accessible name, and ${key === " " ? "Space" : "Enter"} reaches it unhandled`, async () => {
      const double = await opened();
      await press({ key: "B", code: "KeyB", keyCode: 66, ctrlKey: true, shiftKey: true }, document.body);
      await serveHistory(double);
      const remove = chip()!.querySelector<HTMLButtonElement>('button[aria-label="Show all branches"]')!;
      expect(remove.tagName).toBe("BUTTON");
      expect(remove.disabled).toBe(false);
      expect(remove.getAttribute("type")).toBe("button");
      await act(async () => remove.focus());
      expect(document.activeElement).toBe(remove);
      const event = await press({ key, code: key === " " ? "Space" : "Enter" }, remove);
      expect(event.defaultPrevented).toBe(false);
      expect(scopes(double)).toEqual(["all", "current"]);
      await act(async () => remove.click());
      await settle();
      await serveHistory(double);
      expect(scopes(double)).toEqual(["all", "current", "all"]);
      expect(chip()).toBeNull();
    });

  for (const [name, init] of [
    ["Shift+F10", { key: "F10", code: "F10", shiftKey: true }],
    ["the Menu key", { key: "ContextMenu", code: "ContextMenu" }],
  ] as const)
    test(`${name} on the current branch opens its context menu, and Show only this branch's history selects the current-branch scope`, async () => {
      // The wide profile shows the sidebar expanded.
      await sized(1600, 900, async () => {
        const double = await opened();
        const main = [...document.querySelectorAll<HTMLElement>('[data-section="references"] [role="treeitem"]')].find((i) => (i.getAttribute("aria-label") ?? "").startsWith("main,"))!;
        await act(async () => main.focus());
        await press(init, main);
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => (i.textContent ?? "").startsWith("Show only this branch's history"))!;
        expect(item).toBeDefined();
        await act(async () => item.focus());
        await press({ key: "Enter", code: "Enter" }, item);
        await serveHistory(double);
        expect(scopes(double)).toEqual(["all", "current"]);
        expect(chip()).not.toBeNull();
      });
    });

  test("Ctrl+F focuses the filter, and F3 and Shift+F3 move between the matches of filter mode", async () => {
    const double = await opened();
    await press({ key: "f", code: "KeyF", keyCode: 70, ctrlKey: true }, document.body);
    const filter = document.querySelector<HTMLInputElement>('input[aria-label="Filter commit messages"]')!;
    expect(document.activeElement).toBe(filter);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "First");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press({ key: "Enter", code: "Enter" }, filter);
    await serveHistory(double);
    await press({ key: "F3", code: "F3" }, filter);
    await serveHistory(double);
    // Filter mode lists the matches, so the next match is filter row 0 (contract Δ3 `readHistoryRows`).
    const reads = double.calls.filter((c) => c.operation === "readHistoryRows").map((c) => c.args[1]);
    expect(reads).toContainEqual({ viewId: expect.any(String), mode: "filter", searchId: fixtureId(0x401), at: { row: 0 }, count: 1, text: "none" });
    expect(document.querySelector(`section[aria-label="History"] [data-row-id="${HEAD}"]`)!.getAttribute("aria-selected")).toBe("true");
    await press({ key: "F3", code: "F3", shiftKey: true }, filter);
    expect(text()).toContain("No earlier match. This is the first match.");
  });

  test("a newer refsDigest shows the References changed notice with Refresh, and Refresh opens a new view and reads the refs again", async () => {
    const double = await opened();
    const band = () => document.querySelector<HTMLElement>('[data-slot="notice-band"]')!;
    expect(band().textContent).not.toContain("References changed.");
    await act(async () => void (window.dispatchEvent(new Event("blur")), window.dispatchEvent(new Event("focus"))));
    await settle();
    await resolve(latest(double, "readWorkspace"), succeeded(snapshot()));
    await resolve(latest(double, "readRefs"), succeeded(refsList("1".repeat(64))));
    expect(band().textContent).toContain("References changed. History still shows the references from when it opened.");
    const refresh = [...band().querySelectorAll("button")].find((b) => b.textContent === "Refresh")!;
    const opens = scopes(double).length;
    await act(async () => refresh.click());
    await settle();
    expect(latest(double, "readWorkspace").args[1]).toEqual({ refresh: true, check: "full" });
    expect(scopes(double)).toHaveLength(opens + 1);
    await serveHistory(double);
    await resolve(latest(double, "readWorkspace"), succeeded(snapshot()));
    await resolve(latest(double, "readRefs"), succeeded(refsList("0".repeat(64))));
    expect(band().textContent).not.toContain("References changed.");
  });

  // WebView2 rounds `performance.now()`, so a refs read and the open response can get equal clock stamps.
  test("a refs read sent after the open response shows the notice when both fall in the same clock tick", async () => {
    const now = performance.now;
    performance.now = () => 1000;
    try {
      const double = await opened();
      const band = () => document.querySelector<HTMLElement>('[data-slot="notice-band"]')!;
      await act(async () => void (window.dispatchEvent(new Event("blur")), window.dispatchEvent(new Event("focus"))));
      await settle();
      await resolve(latest(double, "readWorkspace"), succeeded(snapshot()));
      await resolve(latest(double, "readRefs"), succeeded(refsList("1".repeat(64))));
      expect(band().textContent).toContain("References changed. History still shows the references from when it opened.");
    } finally {
      performance.now = now;
    }
  });
});
