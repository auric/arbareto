// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, useEffect, type ReactNode } from "react";
import type { ChangeEntry, Environment, HistoryPage, WorkspaceSnapshot } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

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
const { ChangesPaneMount, ComparisonViewMount, HistoryViewMount, INTERIM_HELP_LINE, LATER, Workbench } = await import("../../src/frontend/app/Workbench");
const { readPreferences } = await import("../../src/frontend/state/preferences");

// tasks.md T330: the interim read-only mount. plan.md "Measurements and budgets" (History-ready frame) and "Required visible states".

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
  return { bridge, calls, pending };
}

const REGISTRATION = { repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "a".repeat(64) };
const succeeded = (result: unknown) => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result });
const HEAD = "1".repeat(40);
function snapshot(fields: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    generation: 1,
    snapshotId: crypto.randomUUID(),
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
const PAGE: HistoryPage = {
  generation: 1,
  scope: "current-checkout",
  head: { state: "branch", target: "refs/heads/main", oid: HEAD },
  shallowFingerprint: null,
  rows: [{ oid: HEAD, parents: [], subject: "First", author: { name: "A", email: "a@example.invalid" }, date: 1_700_000_000, encoding: null, shallow: false, invalidUtf8: false }],
  boundaries: { page: [], shallow: [] },
  completeness: { state: "complete" },
};

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  localStorage.clear();
});
// Lets the responses settle, React commit, and the next animation frame run.
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 50))));
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

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

describe("start", () => {
  test("a canceled restoreWorkspace, which means no stored repository, shows No repository and no refusal", async () => {
    const double = await mount({ requestId: null, state: "canceled" });
    expect(text()).toContain("No repository");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(double.calls.map((c) => c.operation)).toEqual([]);
  });

  test("a restoreWorkspace registration opens History and sends the full read, readHistory, and readTrust", async () => {
    const double = await mount(succeeded(REGISTRATION));
    expect(double.calls.map((c) => c.operation).sort()).toEqual(["readHistory", "readTrust", "readWorkspace"]);
    expect(double.pending("readWorkspace").args[1]).toEqual({ refresh: false, check: "full" });
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("History");
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

describe("History", () => {
  test("the history-painted mark waits for the counts of a complete read", async () => {
    const mark = spyOn(performance, "mark");
    try {
      const double = await mount(succeeded(REGISTRATION));
      await resolve(double.pending("readHistory"), succeeded(PAGE));
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
      await resolve(double.pending("readHistory"), succeeded(PAGE));
      await resolve(double.pending("readWorkspace"), { ...succeeded(snapshot({ completeness: { state: "limited", code: "WORKTREE_CHANGING" } })), state: "limited" });
      expect(mark.mock.calls.filter(([name]) => name === "arbareto:history-painted")).toHaveLength(0);
    } finally {
      mark.mockRestore();
    }
  });

  test("History shows one inspector and no bottom region splitter of its own", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readHistory"), succeeded(PAGE));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    const history = document.querySelector('section[aria-label="History"]')!;
    expect(history.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    expect((history.textContent ?? "").split("Select a commit to see its details")).toHaveLength(2);
    expect(history.querySelector('[role="separator"]')).toBeNull();
  });
});

describe("read-only places", () => {
  test("the commit place states that commit is available after batch 3", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    expect(document.querySelector('section[aria-label="Changes"]')?.textContent).toContain(LATER.commit);
  });

  test("the submodule row shows the service count and no Update submodules button", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot({ submoduleNotice: { count: 2, paths: ["a", "b"], filter: "applied" } })));
    const band = document.querySelector('[data-slot="notice-band"]')!;
    expect(band.textContent).toContain(`Some submodules are not initialized or not at their recorded commit. Count: 2. ${LATER.submodules}`);
    expect(band.querySelector("button")).toBeNull();
  });
});

describe("trust", () => {
  const report = (state: string, reads: boolean) => ({
    generation: 1,
    fingerprint: "f".repeat(64),
    state,
    persistence: "stored",
    approvalRequired: { reads, commit: false },
    entries: [],
    hooks: [],
  });

  test("the Trust required dialog opens when reads need an approval", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readTrust"), succeeded(report("untrusted", true)));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Trust required");
  });

  test("no dialog opens when reads need no approval", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readTrust"), succeeded(report("untrusted", false)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
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
  test("the No selection help line states the interim staging sentence", async () => {
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
    const changes = document.querySelector('section[aria-label="Changes"]')!.textContent ?? "";
    expect(changes).toContain(INTERIM_HELP_LINE);
    expect(changes).not.toContain("Space stages or unstages it");
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
const PANE = { density: "compact", profile: "wide", textScale: 1, menuOpen: false, modalOpen: false, onStatus: () => {} } as const;

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
  const row = (oid: string) => ({ oid, parents: [], subject: `Commit ${oid.slice(0, 4)}`, author: { name: "A", email: "a@example.invalid" }, date: 1_700_000_000, encoding: null, shallow: false, invalidUtf8: false });
  const [first, second] = ["1".repeat(40), "2".repeat(40)];
  const pageOf = (...oids: string[]): HistoryPage => ({ ...PAGE, head: { state: "branch", target: "refs/heads/main", oid: oids[0]! }, rows: oids.map(row) });
  const selected = (host: HTMLElement) => host.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? null;
  const clickRow = (host: HTMLElement, index: number) => act(async () => host.querySelectorAll<HTMLElement>('[role="option"]')[index]!.click());

  test("the selected OID stays across a page refresh while the new page holds it, and clears when it does not or on a repository open", async () => {
    const view = (history: HistoryPage | null, repository: object = REGISTRATION) => () => (
      <HistoryViewMount {...PANE} requests={{ refresh: () => {} } as never} state={{ repository, history, historyFailure: null, workspace: null, entries: [] } as never} />
    );
    const shown = await render(view(pageOf(second, first)));
    await clickRow(shown.host, 1);
    expect(selected(shown.host)).toContain("Commit 1111");
    await shown.rerender(view(null));
    await shown.rerender(view(pageOf(second, first)));
    expect(selected(shown.host)).toContain("Commit 1111");
    await shown.rerender(view(pageOf(second)));
    expect(selected(shown.host)).toBeNull();
    await shown.rerender(view(pageOf(second, first)));
    expect(selected(shown.host)).toBeNull();
    await clickRow(shown.host, 1);
    expect(selected(shown.host)).toContain("Commit 1111");
    await shown.rerender(view(pageOf(second, first), { ...REGISTRATION }));
    expect(selected(shown.host)).toBeNull();
  });
});

describe("repository menu", () => {
  test("the revoke result text leaves when another repository opens", async () => {
    const double = await mount(succeeded(REGISTRATION));
    const report = { generation: 1, fingerprint: "f".repeat(64), trustId: crypto.randomUUID(), state: "approved", persistence: "stored", approvalRequired: { reads: false, commit: false }, entries: [], hooks: [] };
    await resolve(latest(double, "readTrust"), succeeded(report));
    const openMenu = async () => {
      const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => e.textContent === "Repository")!;
      await act(async () => trigger.focus());
      await act(async () => trigger.click());
      await settle();
    };
    const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === label)!;
    await openMenu();
    await act(async () => item("Revoke trust").click());
    await settle();
    await resolve(latest(double, "revokeTrust"), succeeded({ endedProcesses: 0 }));
    expect(text()).toContain("Trust revoked.");
    await act(async () => item("Open repository").click());
    await settle();
    await resolve(latest(double, "chooseRepository"), succeeded({ repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "b".repeat(64) }));
    await openMenu();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(text()).not.toContain("Trust revoked.");
  });
});

describe("file lane splitter", () => {
  type HappyWindow = { happyDOM: { setInnerWidth(width: number): void } };
  test("a pointer drag saves the wide file lane once, on pointer up", async () => {
    const before = window.innerWidth;
    (window as unknown as HappyWindow).happyDOM.setInnerWidth(1600);
    const setItem = spyOn(Storage.prototype, "setItem");
    try {
      const double = await mount(succeeded(REGISTRATION));
      await resolve(double.pending("readWorkspace"), succeeded(snapshot()));
      const splitter = document.querySelector<HTMLElement>('[role="separator"][aria-label="Resize file lane"]')!;
      expect(splitter).not.toBeNull();
      const start = Number(splitter.getAttribute("aria-valuenow"));
      const pointer = (type: string, clientX: number) => act(async () => void splitter.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX, bubbles: true })));
      setItem.mockClear();
      await pointer("pointerdown", 500);
      await pointer("pointermove", 520);
      await pointer("pointermove", 540);
      expect(Number(splitter.getAttribute("aria-valuenow"))).toBe(start + 40);
      expect(setItem).not.toHaveBeenCalled();
      await pointer("pointerup", 540);
      expect(setItem).toHaveBeenCalledTimes(1);
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
      setItem.mockRestore();
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
const tab = (label: string) => act(async () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.includes(label))!.click());

// plan.md "Keyboard and focus", File list row: a click and each navigation key select an entry and read its comparison.
describe("selection follows focus", () => {
  test("a click and fast ArrowDown presses each read one comparison, and only the last response shows", async () => {
    const entries = ["a.txt", "b.txt", "c.txt"].map(changeEntry);
    const double = await mount(succeeded(REGISTRATION));
    await resolve(double.pending("readWorkspace"), succeeded(snapshot({ entries, entryCount: entries.length })));
    await tab("Changes");
    await settle();
    const first = document.querySelector<HTMLElement>('section[aria-label="Changes"] [role="option"]')!;
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
        await resolve(double.pending("readHistory"), succeeded(PAGE));
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

        await tab("Changes");
        await settle();
        const changes = document.querySelector<HTMLElement>('section[aria-label="Changes"]')!;
        const listboxes = [...changes.querySelectorAll('[role="listbox"]')];
        expect(listboxes).toHaveLength(2);
        for (const box of listboxes) expect(own(box)).toBe(true);
        const cells = [...changes.children].filter((c) => ["lane", "comparison", "tray"].includes((c as HTMLElement).style.gridArea.split(" ")[0]!));
        expect(cells).toHaveLength(3);
        for (const cell of cells) expect(own(cell)).toBe(true);
        // Working changes and Staged each scroll inside their own section.
        const sections = [...changes.querySelectorAll('[role="listbox"]')].map((box) => box.closest("section:not([aria-label])"));
        expect(new Set(sections).size).toBe(2);
        for (const section of sections) expect(scrolls(section!)).toBe(true);
        // The narrow and constrained file band holds both sections side by side ("Chosen layout, sizes, and DPI").
        expect(sections[0]!.parentElement!.className.split(/\s+/)).toContain(profile === "wide" ? "flex-col" : "flex-row");

        await tab("History");
        await settle();
        const history = document.querySelector('section[aria-label="History"]')!;
        const list = history.querySelector('[role="listbox"]')!;
        expect(own(list)).toBe(true);
        const inspector = [...history.querySelectorAll("section")].find((s) => s.textContent?.startsWith("Selected commit"))!;
        expect(own(inspector)).toBe(true);
        expect(scroller(main) === null).toBe(true);
      });
    });
  }

  test("at 720x480 compact with one band row, the file band and the tray take the reduced pane minimum", async () => {
    await sized(720, 480, async () => {
      const double = await mount(succeeded(REGISTRATION));
      await resolve(double.pending("readWorkspace"), succeeded(snapshot({ entries: [changeEntry("a.txt")], entryCount: 1, submoduleNotice: { count: 1, paths: ["s"], filter: "applied" } })));
      const rows = document.querySelector<HTMLElement>('section[aria-label="Changes"]')!.style.gridTemplateRows.split(/\s+(?![^(]*\))/);
      expect(rows).toEqual(["58px", "0", "minmax(0px, 1fr)", "0", "58px"]);
    });
  });
});
