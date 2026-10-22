// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import type { Amend } from "../../src/frontend/state/workbench";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { stubLayout } from "./history-fake";
import { answer, button, buttons, click, createWorld, itemLabel, keyboardFocus, mountWorkbench, press, settle, snapshot as snapshotOf, succeeded, text, tooltipText, unmountAll, type World } from "./sync-fake";

// tasks.md T042 (feature 004, WP14). Story US4 and the FR-098 box of US11. Spec FR-029 to FR-048, FR-086, FR-098, SC-006, SC-014.
// Plan D8, D9, D15 ("Commit view layout", "Virtual tree", "Limited status", "Multi-select", "Line selection", "Row and hunk buttons", "Ignore items", "Message editor"), D16, and O-11.

printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
printOrigin("../../src/frontend/changes/file-tree.ts", import.meta.dir);
printOrigin("../../src/frontend/changes/file-actions.ts", import.meta.dir);
printOrigin("../../src/frontend/changes/hunk-mapping.ts", import.meta.dir);
printOrigin("../../src/frontend/changes/HunkControls.tsx", import.meta.dir);
printOrigin("../../src/frontend/commit/CommitTray.tsx", import.meta.dir);
printOrigin("../../src/frontend/commit/MessageGuide.tsx", import.meta.dir);
printOrigin("../../src/frontend/commit/WorkingSummary.tsx", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/keyboard/shortcuts.ts", import.meta.dir);

// Pierre and its worker need the Vite build (T160). The double renders each hunk button that Pierre renders as a hunk annotation,
// and it keeps the line-selection callback that Pierre calls when a pointer selection over the line numbers ends.
const pierre: { onLines: ((range: unknown) => void) | null; lines: unknown } = { onLines: null, lines: null };
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({
  default: ({ patch, hunkAction, onLines, lines }: { patch: string; hunkAction?: (index: number) => ReactNode; onLines?: (range: unknown) => void; lines?: unknown }) => {
    pierre.onLines = onLines ?? null;
    pierre.lines = lines ?? null;
    const count = patch.split("\n").filter((l) => l.startsWith("@@")).length;
    return (
      <div data-slot="patch-double">
        <pre>{patch}</pre>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} data-hunk={i}>
            {hunkAction?.(i)}
          </div>
        ))}
      </div>
    );
  },
}));
registerDom();
const { createRoot } = await import("react-dom/client");
const workbench = await import("../../src/frontend/app/Workbench");
const { ChangesPane, HELP_LINE } = await import("../../src/frontend/changes/ChangesPane");
const { changesRows, countsText, derivedRequest, stagedRows } = await import("../../src/frontend/changes/file-tree");
const { patchRows, pickLines, stepRange } = await import("../../src/frontend/changes/hunk-mapping");
const { LINE_TEXT, STALE_TEXT } = await import("../../src/frontend/changes/HunkControls");
const { CommitTray } = await import("../../src/frontend/commit/CommitTray");
const { guideStyle } = await import("../../src/frontend/commit/MessageGuide");
const { createDrafts } = await import("../../src/frontend/state/drafts");
const { RUNNING_REASON } = await import("../../src/frontend/sync/SyncToolbar");

let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());
const roots: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of roots.splice(0)) await unmount();
  await unmountAll();
});
async function render(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  roots.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  return host;
}

// --- Fixtures -------------------------------------------------------------------------------------------------

let next = 0x9000;
const b64 = (s: string) => Buffer.from(s).toString("base64");
function entry(category: ChangeEntry["category"], path: string, xy?: string): ChangeEntry {
  return { entryId: fixtureId(next++), category, path, pathBytes: b64(path), ...(xy === undefined ? {} : { xy }) } as ChangeEntry;
}
// The approved Commit board: tracked changes, folders, untracked folders, and staged files.
function board() {
  const tracked = [entry("unstaged", "README.md", ".M"), entry("unstaged", "src/auth/login.ts", ".M"), entry("unstaged", "src/auth/session.ts", ".M"), entry("unstaged", "src/ui/menu.ts", ".M")];
  const untracked = [entry("untracked", "docs/drafts/a.md"), entry("untracked", "logs/1.log"), entry("untracked", "logs/2.log"), entry("untracked", "notes.txt"), entry("untracked", "src/new.ts")];
  const staged = [entry("staged", "CHANGELOG.md", "M."), entry("staged", "src/api/client.ts", "M."), entry("staged", "src/api/retry.ts", "A.")];
  return { tracked, untracked, staged, all: [...tracked, ...untracked, ...staged] };
}

const commitView = () => document.querySelector<HTMLElement>('section[aria-label="Commit view"]');
const views = () => document.querySelector<HTMLElement>('header nav[aria-label="Views"]')!;
const tree = (name: string, from: ParentNode = document) => from.querySelector<HTMLElement>(`[role="tree"][aria-label="${name}"]`)!;
const items = (name: string) => [...tree(name).querySelectorAll<HTMLElement>('[role="treeitem"]')];
const item = (name: string, label: string) => {
  const found = items(name).filter((i) => i.getAttribute("aria-label") === label || i.getAttribute("aria-label")?.startsWith(`${label}, `));
  if (found.length !== 1) throw new Error(`expected one row "${label}" in ${name}, found ${found.length}: ${items(name).map((i) => i.getAttribute("aria-label")).join(" | ")}`);
  return found[0]!;
};
const describedBy = (element: Element) => (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
async function openCommitView(world: World) {
  const double = await mountWorkbench(workbench, world);
  await click(button("Commit", views()));
  return double;
}
async function clickWith(element: Element, init: MouseEventInit) {
  await act(async () => void element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })));
  await settle();
}
async function contextMenu(element: Element) {
  await act(async () => void element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await settle();
}
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((e) => !e.closest('[role="menubar"]'));
const menuItem = (label: string) => menuItems().find((i) => itemLabel(i) === label)!;

// A scroll box for the file trees: happy-dom has no layout.
function sizeTrees(height: number) {
  const proto = HTMLElement.prototype;
  const keys = ["offsetHeight", "clientHeight", "clientWidth", "scrollTop"] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  const tops = new WeakMap<Element, number>();
  const sized = (e: Element) => e.hasAttribute("data-file-tree") || e.getAttribute("data-slot") === "changes-pane";
  const base = (key: (typeof keys)[number]) => saved.find(([k]) => k === key)![1];
  for (const key of ["offsetHeight", "clientHeight", "clientWidth"] as const)
    Object.defineProperty(proto, key, {
      configurable: true,
      get: function (this: Element) {
        return sized(this) ? height : (base(key)?.get?.call(this) ?? 0);
      },
    });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get: function (this: Element) {
      return sized(this) ? (tops.get(this) ?? 0) : (base("scrollTop")?.get?.call(this) ?? 0);
    },
    set: function (this: Element, value: number) {
      if (sized(this)) tops.set(this, value);
      else base("scrollTop")?.set?.call(this, value);
    },
  });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete (proto as unknown as Record<string, unknown>)[key];
      else Object.defineProperty(proto, key, descriptor);
    }
  };
}

// --- Layout -------------------------------------------------------------------------------------------------------

describe("commit view layout (FR-029, FR-033)", () => {
  test("the Commit view shows the Changes and Staged lists, the diff, and the message editor at once, each in its own region, with splitters", async () => {
    const { all } = board();
    const restore = sizeTrees(600);
    try {
      await openCommitView(createWorld({ entries: all }));
      const view = commitView()!;
      expect(view).not.toBeNull();
      expect(tree("Changes", view.querySelector('[data-section="workingChanges"]')!)).not.toBeNull();
      expect(tree("Staged", view.querySelector('[data-section="staged"]')!)).not.toBeNull();
      expect(view.querySelector('[data-section="comparison"]')).not.toBeNull();
      expect(view.querySelector('[data-section="composer"] textarea[aria-label="Commit message"]')).not.toBeNull();
      // Each region scrolls by itself.
      for (const name of ["Changes", "Staged"]) expect(tree(name).className.split(/\s+/)).toContain("overflow-y-auto");
      const separators = [...view.querySelectorAll('[role="separator"]')].map((s) => s.getAttribute("aria-label"));
      for (const name of ["Resize Changes and Staged", "Resize commit tray"]) expect(separators).toContain(name);
      // No docked panel heading: the Commit view region names itself.
      expect(view.querySelector('section[aria-label="Commit panel"]')).toBeNull();
    } finally {
      restore();
    }
  });

  test("in the wide profile, the message editor sits below the diff and the lists take the left column", async () => {
    const happy = (window as unknown as { happyDOM: { setInnerWidth(n: number): void; setInnerHeight(n: number): void } }).happyDOM;
    const before = { width: window.innerWidth, height: window.innerHeight };
    happy.setInnerWidth(1600);
    happy.setInnerHeight(900);
    try {
      await openCommitView(createWorld({ entries: board().all }));
      const grid = commitView()!.querySelector<HTMLElement>('[data-section="workingChanges"]')!.parentElement!;
      expect(document.querySelector("[data-profile]")!.getAttribute("data-profile")).toBe("wide");
      expect(grid.style.gridTemplateAreas).toBe('"lane laneSplit comparison" "lane laneSplit traySplit" "lane laneSplit tray"');
    } finally {
      happy.setInnerWidth(before.width);
      happy.setInnerHeight(before.height);
    }
  });

  test("at 960 DIPs (narrow), the Commit view has no sidebar, so the lists sit left of the diff and the lane keeps its D16 bounds (plan D15, D16 Geometry)", async () => {
    const happy = (window as unknown as { happyDOM: { setInnerWidth(n: number): void; setInnerHeight(n: number): void } }).happyDOM;
    const before = { width: window.innerWidth, height: window.innerHeight };
    happy.setInnerWidth(960);
    happy.setInnerHeight(900);
    try {
      await openCommitView(createWorld({ entries: board().all }));
      const view = commitView()!;
      const grid = view.querySelector<HTMLElement>('[data-section="workingChanges"]')!.parentElement!;
      expect(document.querySelector("[data-profile]")!.getAttribute("data-profile")).toBe("narrow");
      expect(grid.style.gridTemplateAreas).toBe('"lane laneSplit comparison" "lane laneSplit traySplit" "lane laneSplit tray"');
      // Changes stand above Staged in the list column.
      expect(view.querySelector('[data-slot="changes-pane"]')!.className.split(/\s+/)).toContain("flex-col");
      const lane = view.querySelector<HTMLElement>('[role="separator"][aria-label="Resize file lane"]')!;
      expect(lane !== null).toBe(true);
      // The 520 DIP diff and the 8 DIP splitter beside the lane in the 960 DIP view: max = min(400, 960 - 528).
      expect([lane.getAttribute("aria-valuemin"), lane.getAttribute("aria-valuemax"), lane.getAttribute("aria-valuenow")]).toEqual(["240", "400", "280"]);
    } finally {
      happy.setInnerWidth(before.width);
      happy.setInnerHeight(before.height);
    }
  });
});

// --- Lists ----------------------------------------------------------------------------------------------------------

describe("lists (FR-030, FR-031, FR-086)", () => {
  test("tracked changes come first, and the Untracked section starts collapsed with its count and no untracked rows", async () => {
    const { all } = board();
    await openCommitView(createWorld({ entries: all }));
    const labels = items("Changes").map((i) => i.getAttribute("aria-label"));
    const section = labels.indexOf("Untracked, 5");
    expect(section).toBeGreaterThan(0);
    expect(labels.slice(0, section).every((l) => !l!.startsWith("logs") && l !== "notes.txt")).toBe(true);
    expect(item("Changes", "Untracked").getAttribute("aria-expanded")).toBe("false");
    expect(labels).not.toContain("notes.txt");
    await click(item("Changes", "Untracked"));
    expect(item("Changes", "Untracked").getAttribute("aria-expanded")).toBe("true");
    expect(items("Changes").map((i) => i.getAttribute("aria-label"))).toContain("notes.txt");
  });

  test("a collapsed section of 100,000 untracked files creates no rows, and an open one shows only its collapsed folders", async () => {
    const untracked = Array.from({ length: 100_000 }, (_, i) => entry("untracked", `out/f${i}.bin`));
    const entries = [entry("unstaged", "a.ts", ".M"), ...untracked];
    expect(changesRows(entries, "tree", new Set(), false)).toHaveLength(2);
    const host = await render(<ChangesPane entries={entries} selection={null} onSelect={() => {}} onFileAction={() => new Promise(() => {})} />);
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
    await click(host.querySelector('[data-section-row="untracked"]')!);
    // The untracked folders start collapsed: one row for "out" with its count.
    expect([...host.querySelectorAll('[role="treeitem"]')].map((i) => i.getAttribute("aria-label"))).toEqual(["a.ts", "Untracked, 100,000", "out, 100,000"]);
  });

  test("the tree layout shows folders with the count of the files below them, and the flat layout shows only file rows", async () => {
    const { all } = board();
    await openCommitView(createWorld({ entries: all }));
    expect(item("Changes", "src").getAttribute("aria-expanded")).toBe("true");
    expect(item("Changes", "src").getAttribute("aria-label")).toBe("src, 3");
    expect(item("Changes", "src/auth").getAttribute("aria-label")).toBe("src/auth, 2");
    expect(item("Changes", "src/auth/login.ts").getAttribute("aria-level")).toBe("3");
    expect(item("Staged", "src/api").getAttribute("aria-label")).toBe("src/api, 2");
    // A folder with one folder child joins it.
    await click(item("Changes", "Untracked"));
    expect(items("Changes").map((i) => i.getAttribute("aria-label"))).toContain("docs/drafts, 1");
    await click(button("Flat layout"));
    expect(button("Flat layout").getAttribute("aria-pressed")).toBe("true");
    expect(items("Changes").filter((i) => i.hasAttribute("aria-expanded") && i.dataset.sectionRow === undefined)).toHaveLength(0);
    expect(item("Changes", "src/auth/login.ts").getAttribute("aria-level")).toBe("1");
  });

  test("the layout and the Untracked state stay for the window session when the view changes (data-model §14)", async () => {
    await openCommitView(createWorld({ entries: board().all }));
    await click(button("Flat layout"));
    await click(item("Changes", "Untracked"));
    await click(button("History", views()));
    await click(button("Commit", views()));
    expect(button("Flat layout").getAttribute("aria-pressed")).toBe("true");
    expect(item("Changes", "Untracked").getAttribute("aria-expanded")).toBe("true");
  });

  test("each list is one Tab stop with roving focus, and ArrowRight and ArrowLeft open and close a folder", async () => {
    await openCommitView(createWorld({ entries: board().all }));
    expect(items("Changes").filter((i) => i.tabIndex === 0)).toHaveLength(1);
    expect(items("Staged").filter((i) => i.tabIndex === 0)).toHaveLength(1);
    const src = item("Changes", "src");
    await act(async () => src.focus());
    await press(src, "ArrowLeft");
    expect(item("Changes", "src").getAttribute("aria-expanded")).toBe("false");
    await press(item("Changes", "src"), "ArrowRight");
    expect(item("Changes", "src").getAttribute("aria-expanded")).toBe("true");
    await press(item("Changes", "src"), "ArrowDown");
    expect(document.activeElement).toBe(item("Changes", "src/auth"));
    expect(items("Changes").filter((i) => i.tabIndex === 0)).toEqual([item("Changes", "src/auth")]);
  });
});

// --- Row buttons ----------------------------------------------------------------------------------------------------

describe("row buttons (FR-032)", () => {
  test("each file row holds a stage or unstage button that shows on pointer hover and on focus, named by the action and the file name", async () => {
    await openCommitView(createWorld({ entries: board().all }));
    const stage = button("Stage file login.ts", item("Changes", "src/auth/login.ts"));
    const unstage = button("Unstage file client.ts", item("Staged", "src/api/client.ts"));
    for (const b of [stage, unstage]) {
      const classes = b.className.split(/\s+/);
      for (const c of ["invisible", "group-hover:visible", "group-focus-within:visible"]) expect(classes).toContain(c);
      // The row is the Tab stop. The row button is no extra stop.
      expect(b.tabIndex).toBe(-1);
      expect(b.getAttribute("aria-keyshortcuts")).toBe("Space");
    }
    expect(button("Stage folder auth", item("Changes", "src/auth"))).not.toBeNull();
  });

  test("a row button acts on its file only: it selects the file, and the 001 file action runs on its comparison", async () => {
    const actions: unknown[] = [];
    const [a, b] = [entry("unstaged", "a.ts", ".M"), entry("unstaged", "b.ts", ".M")];
    function Harness() {
      const [selection, setSelection] = useState<{ entryId: string; comparisonId: string | null } | null>(null);
      return (
        <ChangesPane
          entries={[a, b]}
          selection={selection}
          onSelect={(entryId) => setSelection({ entryId, comparisonId: `c-${entryId}` })}
          onFileAction={async (action) => (actions.push(action), { state: "failed" })}
        />
      );
    }
    const host = await render(<Harness />);
    await click(button("Stage file b.ts", host));
    expect(actions).toEqual([{ direction: "stage", comparisonId: `c-${b.entryId}`, entryId: b.entryId }]);
  });
});

// --- Multi-select and header actions -------------------------------------------------------------------------------

describe("multi-select and multi-file actions (FR-034 to FR-036, FR-038 to FR-040)", () => {
  test("Ctrl+click, Shift+click, and Shift+Down select several files, and Stage selected (n) sends one applyFiles for them", async () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"].map((p) => entry("unstaged", p, ".M"));
    const world = createWorld({ entries: files });
    const double = await openCommitView(world);
    const selected = () => items("Changes").filter((i) => i.getAttribute("aria-selected") === "true").map((i) => i.getAttribute("aria-label"));
    await click(item("Changes", "a.ts"));
    await clickWith(item("Changes", "c.ts"), { ctrlKey: true });
    expect(selected()).toEqual(["a.ts", "c.ts"]);
    expect(button("Stage selected (2)")).not.toBeNull();
    // A plain click selects one file again.
    await click(item("Changes", "a.ts"));
    expect(selected()).toEqual(["a.ts"]);
    expect(buttons("Stage selected (2)")).toHaveLength(0);
    await clickWith(item("Changes", "c.ts"), { shiftKey: true });
    expect(selected()).toEqual(["a.ts", "b.ts", "c.ts"]);
    await act(async () => item("Changes", "c.ts").focus());
    await press(item("Changes", "c.ts"), "ArrowDown", { shiftKey: true });
    expect(selected()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
    await click(button("Stage selected (4)"));
    expect(double.count("applyFiles")).toBe(1);
    const call = double.pending("applyFiles")!;
    expect(call.args[0]).toEqual({ repositoryId: fixtureId(1) });
    expect(call.args[1]).toMatchObject({ entryIds: files.map((f) => f.entryId), direction: "stage", kind: "selected" });
  });

  test("Space on a selection of several files stages them in one applyFiles", async () => {
    const files = ["a.ts", "b.ts"].map((p) => entry("unstaged", p, ".M"));
    const double = await openCommitView(createWorld({ entries: files }));
    await click(item("Changes", "a.ts"));
    await clickWith(item("Changes", "b.ts"), { ctrlKey: true });
    await act(async () => item("Changes", "b.ts").focus());
    await press(item("Changes", "b.ts"), " ");
    expect(double.pending("applyFiles")!.args[1]).toMatchObject({ entryIds: files.map((f) => f.entryId), kind: "selected", direction: "stage" });
  });

  test("Stage all changes, Stage all untracked, and Unstage all send the derived kinds with every entry of their set (plan D8)", async () => {
    const { all, tracked, untracked, staged } = board();
    const world = createWorld({ entries: all });
    const double = await openCommitView(world);
    await click(button("Stage all changes"));
    expect(double.pending("applyFiles")!.args[1]).toMatchObject({ kind: "all-changes", direction: "stage", entryIds: [...tracked, ...untracked].map((e) => e.entryId) });
    await act(async () => double.pending("applyFiles")!.resolve({ requestId: fixtureId(0x5ff), state: "failed", code: "CANCELED" }));
    await settle();
    await click(button("Stage all untracked"));
    expect(double.pending("applyFiles")!.args[1]).toMatchObject({ kind: "all-untracked", direction: "stage", entryIds: untracked.map((e) => e.entryId) });
    await act(async () => double.pending("applyFiles")!.resolve({ requestId: fixtureId(0x5ff), state: "failed", code: "CANCELED" }));
    await settle();
    await click(button("Unstage all"));
    expect(double.pending("applyFiles")!.args[1]).toMatchObject({ kind: "all-staged", direction: "unstage", entryIds: staged.map((e) => e.entryId) });
  });

  test("Stage folder covers exactly the Changes entries below the folder, tracked and untracked, and Unstage folder the Staged entries", async () => {
    const { all } = board();
    const double = await openCommitView(createWorld({ entries: all }));
    await contextMenu(item("Changes", "src"));
    await click(menuItem("Stage folder"));
    const src = all.filter((e) => e.category !== "staged" && e.path.startsWith("src/"));
    expect(double.pending("applyFiles")!.args[1]).toEqual({ snapshotId: expect.any(String), entryIds: src.map((e) => e.entryId), direction: "stage", kind: "folder", folder: b64("src") });
    await act(async () => double.pending("applyFiles")!.resolve({ requestId: fixtureId(0x5ff), state: "failed", code: "CANCELED" }));
    await settle();
    await click(button("Unstage folder src/api", item("Staged", "src/api")));
    expect(double.pending("applyFiles")!.args[1]).toMatchObject({ kind: "folder", direction: "unstage", folder: b64("src/api"), entryIds: all.filter((e) => e.category === "staged" && e.path.startsWith("src/api/")).map((e) => e.entryId) });
  });

  test("above 10,000 files, a derived action is unavailable with the stated limit and sends nothing (FR-040)", async () => {
    const many = Array.from({ length: 10_001 }, (_, i) => entry("untracked", `n/${i}.txt`));
    const double = await openCommitView(createWorld({ entries: many }));
    const all = button("Stage all changes");
    expect(all.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(all)).toBe("Stage all changes is unavailable: One action covers at most 10,000 files and 512 MiB of working files.");
    expect(text(commitView()!)).toContain("Stage all untracked is unavailable: One action covers at most 10,000 files and 512 MiB of working files.");
    await click(all);
    expect(double.count("applyFiles")).toBe(0);
  });

  test("a refused set names the file and its reason, and the limit refusal states the limit (FR-038, FR-040)", async () => {
    const files = ["a.ts", "b.ts"].map((p) => entry("unstaged", p, ".M"));
    const double = await openCommitView(createWorld({ entries: files }));
    await click(button("Stage all changes"));
    await act(async () => double.pending("applyFiles")!.resolve({ requestId: fixtureId(0x5ff), state: "rejected", code: "UNSUPPORTED_COMPARISON", result: { reason: "symlink", entryId: files[1]!.entryId } }));
    await settle();
    expect(text(document.querySelector("footer")!)).toContain("Stage files did not start: b.ts. This entry is a symbolic link.");
    await click(button("Stage all changes"));
    await act(async () => double.pending("applyFiles")!.resolve({ requestId: fixtureId(0x5ff), state: "rejected", code: "WORKBENCH_UNAVAILABLE", result: { reason: "limit" } }));
    await settle();
    expect(text(document.querySelector("footer")!)).toContain("Stage files did not start: One action covers at most 10,000 files and 512 MiB of working files.");
  });

  test("the stage-files counters show in the status bar with Cancel, and the running reason goes only into the tooltip and the description (D15)", async () => {
    const files = ["a.ts", "b.ts"].map((p) => entry("unstaged", p, ".M"));
    const double = await openCommitView(createWorld({ entries: files }));
    await click(button("Stage all changes"));
    const call = double.pending("applyFiles")!;
    const onProgress = call.args[2] as (event: unknown) => void;
    await act(async () => onProgress({ requestId: fixtureId(0x5ff), operationId: fixtureId(0x500), state: "accepted", counters: {} }));
    await act(async () => onProgress({ requestId: fixtureId(0x5ff), operationId: fixtureId(0x500), state: "running", phase: "stage-files", counters: { fileIndex: 3, fileCount: 10 }, stalled: false }));
    await settle();
    const footer = document.querySelector("footer")!;
    expect(text(footer)).toContain("Staging files (3 of 10)…");
    expect(buttons("Cancel", footer)).toHaveLength(1);
    const all = button("Stage all changes");
    expect(all.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(all)).toBe(`Stage all changes is unavailable: ${RUNNING_REASON}`);
    // No visible element of the Commit view states the running reason.
    const stated = [...commitView()!.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && (e.textContent ?? "").includes(RUNNING_REASON));
    expect(stated.length).toBeGreaterThan(0);
    expect(stated.every((e) => e.closest("[hidden]") !== null)).toBe(true);
    await act(async () => call.resolve(succeeded({})));
    await settle();
    expect(text(footer)).toContain("Files staged");
  });

  test("a cut inside the untracked records keeps the tracked lists and Commit available and states the cut (plan D15 Limited status)", async () => {
    const files = [entry("staged", "a.ts", "M."), entry("untracked", "x.txt"), entry("untracked", "y.txt")];
    const world = createWorld({ entries: files });
    world.answers.readWorkspace = () => {
      const s = { ...snapshotOf(world), completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_RECORDS" }, cut: "untracked" };
      return succeeded(s);
    };
    await openCommitView(world);
    expect(text(commitView()!)).toContain("At least 2 untracked files. Git lists more than Arbareto reads.");
    expect(describedBy(button("Stage all changes"))).toBe("Stage all changes is unavailable: Git lists more untracked files than Arbareto reads.");
    const field = commitView()!.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Message");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const commit = button("Commit (Ctrl+Enter)");
    expect(commit.getAttribute("aria-disabled")).not.toBe("true");
    expect(text(document.querySelector("footer")!)).toContain("1 staged file. At least 2 changes, at least 2 of them untracked.");
  });
});

// --- Untracked menu and ignore lines ---------------------------------------------------------------------------------

describe("Untracked menu and ignore items (FR-045, FR-046, plan D9)", () => {
  const PLAN = (line: string, target: "gitignore" | "exclude") => ({ target, path: b64("logs"), folder: true, line, prefixNewline: false, expected: "absent" });

  test("an Untracked folder offers Stage folder, Add to .gitignore, Add to info/exclude, Copy path, and Show in Explorer, each named by its label only", async () => {
    await openCommitView(createWorld({ entries: board().all }));
    await click(item("Changes", "Untracked"));
    await contextMenu(item("Changes", "logs"));
    expect(menuItems().map(itemLabel)).toEqual(["Stage folder", "Add to .gitignore", "Add to info/exclude", "Copy path", "Show in Explorer"]);
    for (const i of menuItems()) expect(i.getAttribute("aria-label")).toBeNull();
    expect(menuItem("Stage folder").getAttribute("aria-keyshortcuts")).toBe("Space");
    expect(menuItem("Stage folder").querySelector('[data-slot="dropdown-menu-shortcut"][aria-hidden="true"]')?.textContent).toBe("Space");
    // Contract Δ3 `revealPath` takes one entry, so a folder row states the reason.
    expect(describedBy(menuItem("Show in Explorer"))).toBe("Show in Explorer takes one file. Select a file in the folder.");
  });

  test("Add to .gitignore reviews the ignore, shows the exact line and the target before the write, and Add line runs the token", async () => {
    const { all } = board();
    const world = createWorld({ entries: all });
    const double = await openCommitView(world);
    await click(item("Changes", "Untracked"));
    await contextMenu(item("Changes", "logs"));
    await click(menuItem("Add to .gitignore"));
    const review = double.pending("reviewWorkbench")!;
    const logs = all.find((e) => e.path === "logs/1.log")!;
    expect(review.args[0]).toEqual({ repositoryId: fixtureId(1), repositoryGeneration: 1 });
    expect(review.args[1]).toEqual({ action: "ignore", snapshotId: expect.any(String), entryId: logs.entryId, target: "gitignore", folder: b64("logs") });
    await act(async () => review.resolve(succeeded({ action: "ignore", plan: PLAN("/logs/", "gitignore"), workbenchToken: fixtureId(0x600) })));
    await settle();
    const popover = document.querySelector('[data-slot="popover-content"]')!;
    expect(text(popover)).toContain("Add to .gitignore?");
    expect(text(popover)).toContain("Arbareto adds this line to .gitignore in the worktree folder:");
    expect(popover.querySelector('[data-slot="ignore-line"]')!.textContent).toBe("/logs/");
    expect(double.count("runWorkbench")).toBe(0);
    // Cancel has the first focus.
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(button("Add line"));
    expect(double.pending("runWorkbench")!.args.slice(0, 2)).toEqual([{ repositoryId: fixtureId(1) }, { workbenchToken: fixtureId(0x600), start: true }]);
  });

  for (const [reason, expected] of [
    ["ignore-exists", "Add to .gitignore is unavailable: .gitignore already holds this line."],
    ["ignore-not-text", "Add to .gitignore is unavailable: .gitignore is not UTF-8 text, or it holds a NUL character."],
    ["ignore-size", "Add to .gitignore is unavailable: .gitignore is larger than 1 MiB."],
    ["ignore-not-regular", "Add to .gitignore is unavailable: .gitignore is a symbolic link, a folder, or another special file."],
    ["limit", "Add to .gitignore is unavailable: The ignore line is longer than 4,096 bytes."],
  ] as const) {
    test(`a review refusal with reason ${reason} shows its plan D9 text and opens no confirmation`, async () => {
      const double = await openCommitView(createWorld({ entries: board().all }));
      await click(item("Changes", "Untracked"));
      await contextMenu(item("Changes", "notes.txt"));
      await click(menuItem("Add to .gitignore"));
      await act(async () => double.pending("reviewWorkbench")!.resolve({ requestId: fixtureId(0x5ff), state: "rejected", code: "WORKBENCH_UNAVAILABLE", result: { reason } }));
      await settle();
      expect(text(document.querySelector("footer")!)).toContain(expected);
      expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
      expect(double.count("runWorkbench")).toBe(0);
    });
  }

  test("Show in Explorer on a file sends revealPath with the entry ID", async () => {
    const { all } = board();
    const double = await openCommitView(createWorld({ entries: all }));
    await click(item("Changes", "Untracked"));
    await contextMenu(item("Changes", "notes.txt"));
    await click(menuItem("Show in Explorer"));
    expect(double.pending("revealPath")!.args[0]).toEqual({ repositoryId: fixtureId(1), entryId: all.find((e) => e.path === "notes.txt")!.entryId });
  });

  // T120: each full status read gives each file a new entry ID (src/git-service/status.ts). The open row menu acts on the entry of the latest read.
  async function newRead(world: World, double: Awaited<ReturnType<typeof openCommitView>>, entries: ChangeEntry[]) {
    const reads = double.count("readWorkspace");
    world.entries = entries;
    await act(async () => void (window.dispatchEvent(new Event("blur")), window.dispatchEvent(new Event("focus"))));
    await settle();
    expect(double.count("readWorkspace")).toBe(reads + 1);
  }
  async function readWhileMenuOpen(after: (old: ChangeEntry[]) => ChangeEntry[]) {
    const old = [entry("untracked", "m.txt"), entry("untracked", "n.txt")];
    const world = createWorld({ entries: old });
    const double = await openCommitView(world);
    await click(item("Changes", "Untracked"));
    const anchor = item("Changes", "m.txt");
    await contextMenu(anchor);
    expect(menuItems().length).toBeGreaterThan(0);
    await newRead(world, double, after(old));
    return { double, anchor, b: world.entries.find((e) => e.path === "m.txt") };
  }
  const renewed = (old: ChangeEntry[]) => old.map((e) => ({ ...e, entryId: fixtureId(next++) }));

  test("T120: Show in Explorer after a new read sends revealPath with the entry ID of the new read", async () => {
    const { double, b } = await readWhileMenuOpen(renewed);
    await click(menuItem("Show in Explorer"));
    expect(double.pending("revealPath")!.args[0]).toEqual({ repositoryId: fixtureId(1), entryId: b!.entryId });
  });

  test("T120: Stage file after a new read acts on the entry of the new read", async () => {
    const { double, b } = await readWhileMenuOpen(renewed);
    await click(menuItem("Stage file"));
    expect((double.calls.findLast((c) => c.operation === "readComparison")!.args[1] as { entryId: string }).entryId).toBe(b!.entryId);
  });

  test("T120: Add to .gitignore after a new read reviews the entry of the new read", async () => {
    const { double, b } = await readWhileMenuOpen(renewed);
    await click(menuItem("Add to .gitignore"));
    expect((double.pending("reviewWorkbench")!.args[1] as { entryId: string }).entryId).toBe(b!.entryId);
  });

  test("T120: after a new read, the menu anchor is the shown m.txt row, and Escape returns focus to it", async () => {
    const { anchor } = await readWhileMenuOpen(renewed);
    expect(anchor.isConnected).toBe(true);
    expect(item("Changes", "m.txt")).toBe(anchor);
    await press(document.activeElement!, "Escape");
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(item("Changes", "m.txt"));
  });

  test("T120: a new read without the file closes the row menu, moves focus to the next row, and no request goes out", async () => {
    const { double } = await readWhileMenuOpen((old) => renewed(old.filter((e) => e.path !== "m.txt")));
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(item("Changes", "n.txt"));
    const sent = double.calls.length;
    await settle();
    expect(double.calls.slice(sent).map((c) => c.operation)).toEqual([]);
    expect(double.count("revealPath") + double.count("reviewWorkbench")).toBe(0);
  });

  test("T120: a row menu opened by Shift+F10 acts on the entry of the new read", async () => {
    const old = [entry("untracked", "m.txt"), entry("untracked", "n.txt")];
    const world = createWorld({ entries: old });
    const double = await openCommitView(world);
    await click(item("Changes", "Untracked"));
    const row = item("Changes", "m.txt");
    await act(async () => row.focus());
    await press(row, "F10", { shiftKey: true });
    expect(document.activeElement).toBe(menuItems()[0]!);
    await newRead(world, double, renewed(old));
    expect(row.isConnected).toBe(true);
    await click(menuItem("Show in Explorer"));
    expect(double.pending("revealPath")!.args[0]).toEqual({ repositoryId: fixtureId(1), entryId: world.entries.find((e) => e.path === "m.txt")!.entryId });
  });

  test("T120: a new read that moves the file to Staged closes the row menu, and no request goes out", async () => {
    const { double } = await readWhileMenuOpen((old) => old.map((e) => (e.path === "m.txt" ? { ...e, entryId: fixtureId(next++), category: "staged" as const, xy: "A." } : { ...e, entryId: fixtureId(next++) })));
    expect(menuItems()).toHaveLength(0);
    const sent = double.calls.length;
    await settle();
    expect(double.calls.slice(sent).map((c) => c.operation)).toEqual([]);
    expect(double.count("revealPath") + double.count("reviewWorkbench")).toBe(0);
  });

  test("T120: a new read that removes the folder of an open folder menu moves focus to the next row", async () => {
    const old = [entry("untracked", "logs/1.log"), entry("untracked", "logs/2.log"), entry("untracked", "notes.txt")];
    const world = createWorld({ entries: old });
    const double = await openCommitView(world);
    await click(item("Changes", "Untracked"));
    await contextMenu(item("Changes", "logs"));
    expect(menuItems().length).toBeGreaterThan(0);
    await newRead(world, double, renewed(old.filter((e) => e.path === "notes.txt")));
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(item("Changes", "notes.txt"));
  });

  test("T120: a new read that hides the focused file in a collapsed folder moves focus to the heading", async () => {
    const old = [entry("untracked", "a/b/x.txt")];
    const world = createWorld({ entries: old });
    const double = await openCommitView(world);
    await click(item("Changes", "Untracked"));
    await click(item("Changes", "a/b"));
    const row = item("Changes", "a/b/x.txt");
    await act(async () => row.focus());
    await newRead(world, double, [...renewed(old), entry("untracked", "a/c.txt")]);
    expect(row.isConnected).toBe(false);
    expect(document.activeElement).toBe(tree("Changes").parentElement!.querySelector('[data-list-heading="Changes"]'));
  });

  test("T120: a new read keeps keyboard focus on the focused file row", async () => {
    const old = [entry("unstaged", "a.ts", ".M"), entry("unstaged", "b.ts", ".M")];
    const world = createWorld({ entries: old });
    const double = await openCommitView(world);
    const row = item("Changes", "b.ts");
    await act(async () => row.focus());
    await newRead(world, double, renewed(old));
    expect(row.isConnected).toBe(true);
    expect(document.activeElement).toBe(item("Changes", "b.ts"));
  });

  for (const [name, init] of [
    ["Shift+F10", { key: "F10", shiftKey: true }],
    ["the Menu key", { key: "ContextMenu" }],
  ] as const)
    test(`${name} on a focused row moves the focus to the first menu item, so the focus outline shows (D16)`, async () => {
      await openCommitView(createWorld({ entries: board().all }));
      const row = item("Changes", "src");
      await act(async () => row.focus());
      await press(row, init.key, init);
      expect(menuItems().length).toBeGreaterThan(0);
      expect(document.activeElement).toBe(menuItems()[0]!);
    });
});

// --- Hunks and lines --------------------------------------------------------------------------------------------------

// Two hunks: the first mixes removed and added lines, the second adds one line.
const PATCH = ["diff --git a/f.ts b/f.ts", "index 1..2 100644", "--- a/f.ts", "+++ b/f.ts", "@@ -1,4 +1,5 @@", " a", "-b", "+B", "+C", " d", " e", "@@ -10,2 +11,3 @@", " x", "+y", " z", ""].join("\n");
const hunk = (ordinal: number, oldStart: number, oldCount: number, newStart: number, newCount: number) => ({ hunkId: fixtureId(0x700 + ordinal), ordinal, oldStart, oldCount, newStart, newCount, digest: String(ordinal).repeat(64) });

async function shownDiff(category: "unstaged" | "staged" = "unstaged", patch = PATCH, hunks = [hunk(0, 1, 4, 1, 5), hunk(1, 10, 2, 11, 3)]) {
  const file = entry(category, "f.ts", category === "staged" ? "M." : ".M");
  const world = createWorld({ entries: [file] });
  world.answers.readComparison = (args) => {
    const payload = args[1] as { snapshotId: string; entryId: string };
    return succeeded({
      comparisonId: fixtureId(0x7ff),
      snapshotId: payload.snapshotId,
      entryId: payload.entryId,
      scope: category === "staged" ? "head-to-index" : "index-to-worktree",
      completeness: { state: "complete" },
      patch: b64(patch),
      hunks,
      support: "supported",
      fileAction: category === "staged" ? "unstage" : "stage",
      remedy: null,
    });
  };
  const double = await openCommitView(world);
  await click(item(category === "staged" ? "Staged" : "Changes", "f.ts"));
  await settle();
  return { double, file };
}
const diffBody = () => commitView()!.querySelector<HTMLElement>('[data-slot="diff-body"]')!;

describe("hunk buttons (FR-037)", () => {
  test("each hunk shows its Stage hunk button, the heading keeps Previous hunk and Next hunk, and a hunk button stages only that hunk", async () => {
    const { double } = await shownDiff();
    const pane = commitView()!.querySelector('[data-section="comparison"]')!;
    expect(buttons("Stage hunk", pane)).toHaveLength(2);
    for (const name of ["Previous hunk", "Next hunk"]) expect(buttons(name, pane)).toHaveLength(1);
    await click(button("Stage hunk", pane.querySelector('[data-hunk="1"]')!));
    const call = double.pending("applyHunk")!;
    expect(call.args[1]).toEqual({ comparisonId: fixtureId(0x7ff), hunkId: fixtureId(0x701), snapshotId: expect.any(String), direction: "stage" });
  });

  test("T389: the diff body Tab stop is a group with the accessible name Diff", async () => {
    await shownDiff();
    expect(diffBody().getAttribute("role")).toBe("group");
    expect(diffBody().getAttribute("aria-label")).toBe("Diff");
    expect(diffBody().tabIndex).toBe(0);
  });

  test("a staged diff shows Unstage hunk", async () => {
    await shownDiff("staged");
    expect(buttons("Unstage hunk", commitView()!)).toHaveLength(2);
  });
});

describe("line selection (FR-041 to FR-044, contract Δ4)", () => {
  const rows = patchRows(PATCH);

  test("the mapping gives the 1-based body ordinals of the selected + and - lines of one hunk", () => {
    // Rows: " a"(1) "-b"(2) "+B"(3) "+C"(4) " d"(5) " e"(6); then " x"(1) "+y"(2) " z"(3).
    expect(pickLines(rows, { start: 2, side: "deletions", end: 3, endSide: "additions" }, "stage")).toEqual({ ok: true, hunk: 0, lines: [2, 3, 4] });
    expect(pickLines(rows, { start: 2, side: "additions", end: 2 }, "stage")).toEqual({ ok: true, hunk: 0, lines: [3] });
    expect(pickLines(rows, { start: 12, side: "additions", end: 12 }, "stage")).toEqual({ ok: true, hunk: 1, lines: [2] });
  });

  test("the refusals: context-only, several-hunks, deleted-file, new-file for an unstage, and eof-newline for a part; the whole marker hunk passes", () => {
    expect(pickLines(rows, { start: 1, side: "additions", end: 1 }, "stage")).toEqual({ ok: false, reason: "context-only" });
    expect(pickLines(rows, { start: 4, side: "additions", end: 12 }, "stage")).toEqual({ ok: false, reason: "several-hunks" });
    const deleted = patchRows("diff --git a/f b/f\ndeleted file mode 100644\n--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n");
    expect(pickLines(deleted, { start: 1, side: "deletions", end: 1 }, "stage")).toEqual({ ok: false, reason: "deleted-file" });
    const added = patchRows("diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(pickLines(added, { start: 1, side: "additions", end: 1 }, "unstage")).toEqual({ ok: false, reason: "new-file" });
    expect(pickLines(added, { start: 1, side: "additions", end: 1 }, "stage")).toEqual({ ok: true, hunk: 0, lines: [1] });
    const eof = patchRows("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
    expect(pickLines(eof, { start: 2, side: "deletions", end: 2 }, "stage")).toEqual({ ok: false, reason: "eof-newline" });
    // The marker line counts in the ordinals: " a"(1) "-b"(2) "\"(3) "+c"(4) "\"(5).
    expect(pickLines(eof, { start: 2, side: "deletions", end: 2, endSide: "additions" }, "stage")).toEqual({ ok: true, hunk: 0, lines: [2, 4] });
  });

  test("Shift+Down from no selection starts at the first changed row of the hunk and extends one row per key", () => {
    const first = stepRange(rows, null, "next", 0)!;
    expect(first).toEqual({ start: 2, side: "deletions", end: 2 });
    expect(stepRange(rows, first, "next", 0)).toEqual({ start: 2, side: "deletions", end: 2, endSide: "additions" });
  });

  test("a line selection shows Stage 3 lines (S); S in the diff stages exactly those ordinals, and U does nothing in an unstaged diff", async () => {
    const { double } = await shownDiff();
    await act(async () => pierre.onLines!({ start: 2, side: "deletions", end: 3, endSide: "additions" }));
    await settle();
    const stage = button("Stage 3 lines (S)");
    expect(stage.getAttribute("aria-keyshortcuts")).toBe("S");
    await press(diffBody(), "u");
    expect(double.count("applyHunk")).toBe(0);
    await press(diffBody(), "s");
    expect(double.pending("applyHunk")!.args[1]).toEqual({ comparisonId: fixtureId(0x7ff), hunkId: fixtureId(0x700), snapshotId: expect.any(String), direction: "stage", lines: [2, 3, 4] });
  });

  test("S outside the diff does nothing (FR-087)", async () => {
    const { double } = await shownDiff();
    await act(async () => pierre.onLines!({ start: 2, side: "deletions", end: 2 }));
    await settle();
    await press(item("Changes", "f.ts"), "s");
    expect(double.count("applyHunk")).toBe(0);
  });

  test("a selection in two hunks shows its reason and sends no request (renderer several-hunks)", async () => {
    const { double } = await shownDiff();
    await act(async () => pierre.onLines!({ start: 4, side: "additions", end: 12 }));
    await settle();
    const stage = button("Stage 1 line (S)");
    expect(stage.getAttribute("aria-disabled")).toBe("true");
    // The reason line drops the final period of each part (001 plan.md "Long text").
    expect(describedBy(stage)).toBe(`Stage 1 line is unavailable: ${LINE_TEXT["several-hunks"].slice(0, -1)}`);
    await press(diffBody(), "s");
    await click(stage);
    expect(double.count("applyHunk")).toBe(0);
  });

  test("Shift+Down in the diff starts a line selection, and the selection goes to Pierre as the controlled range", async () => {
    await shownDiff();
    await press(diffBody(), "ArrowDown", { shiftKey: true });
    expect(pierre.lines).toEqual({ start: 2, side: "deletions", end: 2 });
    await press(diffBody(), "ArrowDown", { shiftKey: true });
    expect(button("Stage 2 lines (S)")).not.toBeNull();
  });

  test("U unstages selected lines of a staged diff, and a staged new file refuses with new-file", async () => {
    const added = "diff --git a/f.ts b/f.ts\nnew file mode 100644\n--- /dev/null\n+++ b/f.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n";
    const { double } = await shownDiff("staged", added, [hunk(0, 0, 0, 1, 2)]);
    await act(async () => pierre.onLines!({ start: 1, side: "additions", end: 1 }));
    await settle();
    const unstage = button("Unstage 1 line (U)");
    expect(describedBy(unstage)).toBe("Unstage 1 line is unavailable: Git cannot unstage part of a new file");
    await press(diffBody(), "u");
    expect(double.count("applyHunk")).toBe(0);
  });

  test("S, U, and Shift+Down on a hunk toolbar button do nothing: the keys act only in the diff body (FR-087)", async () => {
    const { double } = await shownDiff();
    await act(async () => pierre.onLines!({ start: 2, side: "deletions", end: 3, endSide: "additions" }));
    await settle();
    const toolbar = commitView()!.querySelector<HTMLElement>('[role="toolbar"][aria-label="Hunk controls"]')!;
    const lines = button("Stage 3 lines (S)", toolbar);
    await act(async () => lines.focus());
    await press(lines, "s");
    expect(double.count("applyHunk")).toBe(0);
    await press(lines, "ArrowDown", { shiftKey: true });
    expect(pierre.lines).toEqual({ start: 2, side: "deletions", end: 3, endSide: "additions" });
    await press(button("Previous hunk", toolbar), "s");
    expect(double.count("applyHunk")).toBe(0);
  });

  test("a point that names no row gives no line pick: the line action states the mapping failure and sends nothing (contract §4)", async () => {
    expect(pickLines(rows, { start: 99, side: "additions", end: 2 }, "stage")).toBeNull();
    const { double } = await shownDiff();
    await act(async () => pierre.onLines!({ start: 99, side: "additions", end: 99 }));
    await settle();
    const action = commitView()!.querySelector<HTMLElement>('[data-slot="line-action"]')!;
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(action)).toContain("DISPLAY_MAPPING_FAILED");
    expect(describedBy(action)).not.toContain(LINE_TEXT["context-only"].slice(0, -1));
    await press(diffBody(), "s");
    await click(action);
    expect(double.count("applyHunk")).toBe(0);
  });

  test("while an operation runs, the hunk and line buttons give the running reason only in the tooltip and the description (D15)", async () => {
    const { double } = await shownDiff();
    await act(async () => pierre.onLines!({ start: 2, side: "deletions", end: 3, endSide: "additions" }));
    await settle();
    await click(button("Stage all changes"));
    const call = double.pending("applyFiles")!;
    await act(async () => (call.args[2] as (event: unknown) => void)({ requestId: fixtureId(0x5ff), operationId: fixtureId(0x501), state: "accepted", counters: {} }));
    await settle();
    const pane = commitView()!.querySelector<HTMLElement>('[data-section="comparison"]')!;
    for (const name of ["Stage selected hunk", "Stage 3 lines (S)"]) expect(describedBy(button(name, pane))).toContain(RUNNING_REASON.slice(0, -1));
    expect(describedBy(button("Stage hunk", pane.querySelector('[data-hunk="0"]')!))).toBe(RUNNING_REASON);
    const stated = [...pane.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && (e.textContent ?? "").includes(RUNNING_REASON.slice(0, -1)));
    expect(stated.length).toBeGreaterThan(0);
    expect(stated.every((e) => e.closest("[hidden]") !== null)).toBe(true);
    await keyboardFocus(button("Stage hunk", pane.querySelector('[data-hunk="0"]')!));
    expect(tooltipText()).toBe(RUNNING_REASON);
  });

  test("a STALE_SELECTION from a hunk's own Stage hunk button shows the stale text", async () => {
    const { double } = await shownDiff();
    const pane = commitView()!.querySelector('[data-section="comparison"]')!;
    await click(button("Stage hunk", pane.querySelector('[data-hunk="1"]')!));
    await answer(double.pending("applyHunk"), { requestId: fixtureId(0x5ff), state: "rejected", code: "STALE_SELECTION" });
    expect(text(commitView()!)).toContain(STALE_TEXT.slice(0, -1));
  });
});

// --- Message editor ----------------------------------------------------------------------------------------------------

describe("message editor (FR-047) and Amend last commit (FR-098)", () => {
  const HEAD = { state: "branch", target: "refs/heads/main", oid: "1".repeat(40) } as const;
  async function tray(fields: Record<string, unknown> = {}) {
    const calls: { operation: string; args: unknown[] }[] = [];
    const bridge = contractChecked(new Proxy({}, { get: (_, name) => (...args: unknown[]) => (calls.push({ operation: String(name), args }), new Promise(() => {})) }));
    const drafts = createDrafts({ write: async () => "saved", remove: async () => "saved", read: async () => null } as never);
    const host = await render(
      <CommitTray
        {...({
          bridge: bridge as object,
          target: { repositoryId: fixtureId(1), repositoryGeneration: 1 },
          snapshotId: fixtureId(2),
          worktreeKey: "a".repeat(64),
          drafts,
          head: HEAD,
          staged: 2,
          status: null,
          requestTrust: () => new Promise(() => {}),
          ...fields,
        } as unknown as Parameters<typeof CommitTray>[0])}
      />,
    );
    const field = host.querySelector("textarea")!;
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    };
    return { host, field, type, calls, drafts };
  }

  test("an 80-character summary shows 80/72 with a non-color cue, the guide marks column 72, and Commit stays available", async () => {
    const t = await tray();
    const summary = "x".repeat(80);
    await t.type(`${summary}\n\nBody`);
    const counter = t.host.querySelector('[data-slot="summary-counter"]')!;
    expect(text(counter)).toBe("Summary 80/72");
    expect(counter.querySelector("svg")).not.toBeNull();
    expect(t.field.getAttribute("data-guide-column")).toBe("72");
    expect(guideStyle(8).backgroundImage).toContain("calc(72ch + 8px)");
    const commit = [...t.host.querySelectorAll("button")].find((b) => b.textContent === "Commit (Ctrl+Enter)")!;
    expect(commit.getAttribute("aria-disabled")).not.toBe("true");
    // The marks never change the text.
    expect(t.field.value).toBe(`${summary}\n\nBody`);
    expect(describedBy(t.field)).toContain("Summary 80/72");
  });

  test("columns count Unicode code points, and a 47-character summary shows 47/72 without the cue", async () => {
    const t = await tray();
    await t.type(`${"😀".repeat(47)}`);
    const counter = t.host.querySelector('[data-slot="summary-counter"]')!;
    expect(text(counter)).toBe("Summary 47/72");
    expect(counter.querySelector("svg")).toBeNull();
  });

  test("a non-empty line 2 gets the Warning mark with its text, and Commit stays available", async () => {
    const t = await tray();
    await t.type("Summary\nnot blank");
    expect(text(t.host.querySelector('[data-slot="line-two-mark"]')!)).toBe("Line 2 is not blank.");
    const commit = [...t.host.querySelectorAll("button")].find((b) => b.textContent === "Commit (Ctrl+Enter)")!;
    expect(commit.getAttribute("aria-disabled")).not.toBe("true");
    await t.type("Summary\n\nBody");
    expect(t.host.querySelector('[data-slot="line-two-mark"]')).toBeNull();
  });

  test("the help line and the reason lines stay in the editor column, and the amend column spans the editor and the lines below it", async () => {
    const t = await tray({ operationState: "merging", amend: { value: null, onChange: () => {} } });
    const cell = (e: Element) => {
      let at: Element = e;
      while (at.parentElement !== null && at.parentElement !== t.host.firstElementChild) at = at.parentElement;
      return at as HTMLElement;
    };
    const guide = [...t.host.querySelectorAll("span")].find((s) => text(s).startsWith("Keep the summary at 72 characters"))!;
    const commit = [...t.host.querySelectorAll("button")].find((b) => b.textContent === "Commit (Ctrl+Enter)")!;
    expect(cell(guide).style.getPropertyValue("grid-column")).toBe("1");
    expect(cell(commit).style.getPropertyValue("grid-column")).toBe("2");
    expect(cell(commit).style.getPropertyValue("grid-row")).toBe("2 / span 2");
    expect(cell(t.host.querySelector("textarea")!)).not.toBe(cell(guide));
  });

  test("the summary line and the Commit reason line wrap in the editor column and show the full text, not an ellipsis (T115)", async () => {
    const t = await tray({ amend: { value: null, onChange: () => {} } });
    const commit = [...t.host.querySelectorAll("button")].find((b) => b.textContent === "Commit (Ctrl+Enter)")!;
    const reason = document.getElementById(commit.getAttribute("aria-describedby")!)!;
    expect(text(reason)).toBe("The commit message is empty.");
    const summary = reason.parentElement!.querySelector("p")!;
    expect(text(summary)).toContain("staged");
    for (const line of [summary, reason]) expect(line.className.split(/\s+/)).not.toContain("truncate");
  });

  test("Amend last commit sits next to the message editor and states its reason for an unborn branch and during a merge or a rebase", async () => {
    const box = { value: null, onChange: () => {} };
    const unborn = await tray({ head: { state: "unborn", target: "refs/heads/main" }, amend: box });
    const check = unborn.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(text(check.closest("label")!)).toBe("Amend last commit");
    expect(describedBy(check)).toBe("The branch has no commits yet.");
    await act(async () => check.click());
    expect(unborn.calls).toEqual([]);
    for (const operationState of ["merging", "rebasing"]) {
      const t = await tray({ operationState, amend: box });
      expect(describedBy(t.host.querySelector('input[type="checkbox"]')!)).toBe("A merge or a rebase is in progress.");
    }
  });

  test("checking the box sends reviewCommit with amend, and a checked box states Commit replaces commit <short ID> and shows its text, not the draft", async () => {
    let value: Amend | null = null;
    const t = await tray({ amend: { value, onChange: (v: typeof value) => void (value = v) } });
    await t.type("My draft");
    await act(async () => t.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(t.calls.at(-1)).toEqual({ operation: "reviewCommit", args: [{ repositoryId: fixtureId(1), repositoryGeneration: 1 }, { snapshotId: fixtureId(2), amend: true }] });
    const checked = await tray({ amend: { value: { headOid: "e".repeat(40), message: "Add login form", text: "Add login form" } satisfies Amend, onChange: () => {} } });
    expect(checked.field.value).toBe("Add login form");
    expect(text(checked.host)).toContain(`Commit replaces commit ${"e".repeat(12)}.`);
  });
});

// --- Status bar, dock summary, and view switch -----------------------------------------------------------------------

describe("status bar counts (FR-048)", () => {
  test("the Commit view states the staged count, the change count, and the untracked count", async () => {
    const entries = [
      ...Array.from({ length: 3 }, (_, i) => entry("staged", `s${i}.ts`, "M.")),
      ...Array.from({ length: 10 }, (_, i) => entry("unstaged", `m${i}.ts`, ".M")),
      ...Array.from({ length: 1248 }, (_, i) => entry("untracked", `u/${i}.txt`)),
    ];
    await openCommitView(createWorld({ entries }));
    expect(text(document.querySelector("footer")!)).toContain("3 staged files. 1,258 changes, 1,248 of them untracked.");
    expect(countsText([entry("staged", "a", "M."), entry("unstaged", "b", ".M")], false)).toBe("1 staged file. 1 change, 0 of them untracked.");
  });
});

describe("Working directory row (plan D15, O-11)", () => {
  const working = () => document.querySelector<HTMLElement>('section[aria-label="History"] [role="option"][data-row-id="working-directory"]')!;
  const historyList = () => document.querySelector<HTMLElement>("[data-history-list]")!;

  test("a selection docks the summary with the counts and Open Commit view (Enter), and the button opens the Commit view", async () => {
    await mountWorkbench(workbench, createWorld({ entries: board().all }));
    await click(working());
    const dock = document.querySelector('section[aria-label="Dock"]')!;
    expect(text(dock)).toContain("9 working changes, 3 staged");
    expect(commitView()).toBeNull();
    await click(button("Open Commit view (Enter)", dock));
    expect(commitView()).not.toBeNull();
  });

  test("Enter on the selected row opens the Commit view, and arrow keys never switch the view", async () => {
    await mountWorkbench(workbench, createWorld({ entries: board().all }));
    await click(working());
    await press(historyList(), "ArrowDown");
    await press(historyList(), "ArrowUp");
    expect(commitView()).toBeNull();
    await press(historyList(), "Enter");
    expect(commitView()).not.toBeNull();
  });

  test("the summary counts have thousands separators", async () => {
    const { WorkingSummary } = await import("../../src/frontend/commit/WorkingSummary");
    const host = await render(<WorkingSummary working={12_345} staged={1_200} onOpen={() => {}} />);
    expect(text(host)).toContain("12,345 working changes, 1,200 staged");
  });

  test("a double-click on the row opens the Commit view", async () => {
    await mountWorkbench(workbench, createWorld({ entries: board().all }));
    await act(async () => void working().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await settle();
    expect(commitView()).not.toBeNull();
  });
});

// --- Virtual list performance ----------------------------------------------------------------------------------------

describe("virtual list (FR-086, SC-007 component check)", () => {
  test("10,000 rows render and scroll with only the rows near the view, and a scroll adds no full set of rows", async () => {
    const restore = sizeTrees(400);
    try {
      const entries = Array.from({ length: 10_000 }, (_, i) => entry("unstaged", `f${String(i).padStart(5, "0")}.ts`, ".M"));
      const started = performance.now();
      const host = await render(<ChangesPane entries={entries} selection={null} onSelect={() => {}} onFileAction={() => new Promise(() => {})} layout="flat" />);
      const changes = host.querySelector<HTMLElement>('[data-file-tree="changes"]')!;
      const shown = () => changes.querySelectorAll('[role="treeitem"]').length;
      expect(shown()).toBeGreaterThan(0);
      expect(shown()).toBeLessThan(60);
      let added = 0;
      const observer = new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.getAttribute("role") === "treeitem") added++;
      });
      observer.observe(changes, { childList: true, subtree: true });
      for (const top of [26 * 5000, 26 * 9990]) {
        await act(async () => {
          changes.scrollTop = top;
          changes.dispatchEvent(new Event("scroll"));
        });
        await settle();
      }
      observer.disconnect();
      expect(shown()).toBeLessThan(60);
      expect(added).toBeLessThan(120);
      expect(changes.querySelector('[aria-label="f09999.ts"]')).not.toBeNull();
      console.log(`virtual list: 10,000 rows, ${added} row nodes added over two scrolls, ${Math.round(performance.now() - started)} ms`);
    } finally {
      restore();
    }
  });

  test("a virtual row in the middle of 10,000 rows reports its true position and set size", async () => {
    const restore = sizeTrees(400);
    try {
      const entries = Array.from({ length: 10_000 }, (_, i) => entry("unstaged", `f${String(i).padStart(5, "0")}.ts`, ".M"));
      const host = await render(<ChangesPane entries={entries} selection={null} onSelect={() => {}} onFileAction={() => new Promise(() => {})} layout="flat" />);
      const changes = host.querySelector<HTMLElement>('[data-file-tree="changes"]')!;
      await act(async () => {
        changes.scrollTop = 26 * 5000;
        changes.dispatchEvent(new Event("scroll"));
      });
      await settle();
      const middle = changes.querySelector('[aria-label="f05000.ts"]')!;
      expect([middle.getAttribute("aria-posinset"), middle.getAttribute("aria-setsize")]).toEqual(["5001", "10000"]);
    } finally {
      restore();
    }
  });

  test("tree rows report the position and the set size of their level", async () => {
    await openCommitView(createWorld({ entries: board().all }));
    const at = (label: string) => [item("Changes", label).getAttribute("aria-posinset"), item("Changes", label).getAttribute("aria-setsize")];
    // Level 1 holds README.md, src, and the Untracked section row.
    expect(at("README.md")).toEqual(["1", "3"]);
    expect(at("src")).toEqual(["2", "3"]);
    expect(at("Untracked")).toEqual(["3", "3"]);
    expect(at("src/auth")).toEqual(["1", "2"]);
    expect(at("src/auth/session.ts")).toEqual(["2", "2"]);
    await click(item("Changes", "Untracked"));
    // The untracked level: docs/drafts, logs, notes.txt, and src.
    expect(at("notes.txt")).toEqual(["3", "4"]);
    const staged = item("Staged", "CHANGELOG.md");
    expect([staged.getAttribute("aria-posinset"), staged.getAttribute("aria-setsize")]).toEqual(["1", "2"]);
  });

  test("stage-files progress events re-render no visible file row", async () => {
    let reads = 0;
    // Only the file row reads `xy` (its status letter), so each read is one row render.
    const counted = (path: string) => Object.defineProperty(entry("unstaged", path), "xy", { enumerable: true, get: () => (reads++, ".M") }) as ChangeEntry;
    const files = ["a.ts", "b.ts", "c.ts"].map(counted);
    const double = await openCommitView(createWorld({ entries: files }));
    expect(reads).toBeGreaterThan(0);
    await click(button("Stage all changes"));
    const onProgress = double.pending("applyFiles")!.args[2] as (event: unknown) => void;
    await act(async () => onProgress({ requestId: fixtureId(0x5ff), operationId: fixtureId(0x502), state: "accepted", counters: {} }));
    await settle();
    reads = 0;
    for (const fileIndex of [1, 2, 3]) {
      await act(async () => onProgress({ requestId: fixtureId(0x5ff), operationId: fixtureId(0x502), state: "running", phase: "stage-files", counters: { fileIndex, fileCount: 3 }, stalled: false }));
      await settle();
    }
    expect(text(document.querySelector("footer")!)).toContain("Staging files (3 of 3)…");
    expect(reads).toBe(0);
  });

  test("the help line shows only in the diff empty state, and the Changes list keeps it as its description (T091)", async () => {
    const host = await render(<ChangesPane entries={[entry("unstaged", "a.ts", ".M")]} selection={null} onSelect={() => {}} onFileAction={() => new Promise(() => {})} />);
    const line = [...host.querySelectorAll("p")].find((p) => p.textContent === HELP_LINE);
    expect(line).toBeDefined();
    expect(line!.hidden).toBe(true);
    expect(describedBy(tree("Changes", host))).toBe(HELP_LINE);
    await openCommitView(createWorld({ entries: board().all }));
    const visible = [...commitView()!.querySelectorAll("p")].filter((p) => p.textContent === HELP_LINE && p.closest("[hidden]") === null);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.closest('[data-section="comparison"]')).not.toBeNull();
    expect(stagedRows([entry("staged", "a", "M.")], "flat", new Set())).toHaveLength(1);
    expect(derivedRequest([entry("staged", "a", "M.")], "all-staged").direction).toBe("unstage");
  });
});

// --- Batch 3 follow-up: D16 status letters and the Staged block (T091) -------------------------------------------

describe("status letters and the Staged block (plan D16, T091)", () => {
  test("M uses Warning text, A and ? Added text, D Removed text, and every other letter Text", async () => {
    const entries = [
      entry("unstaged", "m.ts", ".M"),
      entry("unstaged", "d.ts", ".D"),
      entry("unstaged", "t.ts", ".T"),
      entry("conflicted", "c.ts", "UU"),
      entry("untracked", "u.ts"),
      entry("staged", "a.ts", "A."),
      entry("staged", "r.ts", "R."),
    ];
    const host = await render(<ChangesPane entries={entries} selection={null} onSelect={() => {}} onFileAction={() => new Promise(() => {})} layout="flat" untrackedOpen />);
    const letterOf = (path: string) => {
      const row = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((r) => r.getAttribute("aria-label") === path)!;
      const mark = row.querySelector<HTMLElement>('[data-slot="status-letter"]')!;
      return [mark.textContent, mark.className.split(/\s+/).find((c) => /^text-(warning|added|removed|text|muted-text)$/.test(c))];
    };
    expect(letterOf("m.ts")).toEqual(["M", "text-warning"]);
    expect(letterOf("d.ts")).toEqual(["D", "text-removed"]);
    expect(letterOf("t.ts")).toEqual(["T", "text-text"]);
    expect(letterOf("c.ts")).toEqual(["U", "text-text"]);
    expect(letterOf("u.ts")).toEqual(["?", "text-added"]);
    expect(letterOf("a.ts")).toEqual(["A", "text-added"]);
    expect(letterOf("r.ts")).toEqual(["R", "text-text"]);
  });

  test("without a shown comparison, the Staged list starts directly below the splitter, with no empty stage bar", async () => {
    const restore = sizeTrees(600);
    try {
      await openCommitView(createWorld({ entries: board().all }));
      const staged = commitView()!.querySelector<HTMLElement>('[data-section="staged"]')!;
      expect(staged.previousElementSibling?.getAttribute("aria-label")).toBe("Resize Changes and Staged");
      expect(commitView()!.innerHTML).not.toContain("--h-stage-bar");
    } finally {
      restore();
    }
  });
});

// --- Filter files (FR-101, quickstart Q29, T092) --------------------------------------------------------------------

describe("Filter files (FR-101, Q29)", () => {
  const filesField = () => document.querySelector<HTMLInputElement>('input[aria-label="Filter files"]');
  async function typeIn(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  }
  const labels = (name: string) => items(name).map((i) => i.getAttribute("aria-label"));

  test("Ctrl+F focuses Filter files in the Commit view and the history filter in the History view", async () => {
    await mountWorkbench(workbench, createWorld({ entries: board().all }));
    await press(document.body, "f", { ctrlKey: true });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Filter commit messages");
    await click(button("Commit", views()));
    await press(document.body, "f", { ctrlKey: true });
    expect(document.activeElement).toBe(filesField());
    // Ctrl+F also leaves the message field for Filter files.
    const message = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!;
    await act(async () => message.focus());
    await press(message, "f", { ctrlKey: true });
    expect(document.activeElement).toBe(filesField());
    await click(button("History", views()));
    await press(document.body, "f", { ctrlKey: true });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Filter commit messages");
  });

  test("the field shows the search icon, the placeholder, the key, and the tooltip Filter files (Ctrl+F) above both lists", async () => {
    await openCommitView(createWorld({ entries: board().all }));
    const field = filesField()!;
    expect(field.getAttribute("placeholder")).toBe("Filter files");
    expect(field.getAttribute("aria-keyshortcuts")).toBe("Control+F");
    expect(field.parentElement!.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    for (const name of ["Changes", "Staged"]) expect(field.compareDocumentPosition(tree(name)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await keyboardFocus(field);
    expect(tooltipText()).toBe("Filter files (Ctrl+F)");
  });

  test("login shows only the rows whose path holds it, and Stage all changes still stages every change (Q29)", async () => {
    const { all, tracked, untracked } = board();
    const double = await openCommitView(createWorld({ entries: all }));
    const status = text(document.querySelector("footer")!);
    await typeIn(filesField()!, "login");
    // Folder, heading, and status bar counts keep the counts of the status read.
    expect(labels("Changes")).toEqual(["src, 3", "src/auth, 2", "src/auth/login.ts", "Untracked, 5"]);
    expect(labels("Staged")).toEqual([]);
    expect(document.querySelector('[data-list-heading="Changes"] .num')?.textContent).toBe("9");
    expect(document.querySelector('[data-list-heading="Staged"] .num')?.textContent).toBe("3");
    expect(text(document.querySelector("footer")!)).toBe(status);
    await click(button("Stage all changes"));
    expect(double.pending("applyFiles")!.args[1]).toMatchObject({ kind: "all-changes", direction: "stage", entryIds: [...tracked, ...untracked].map((e) => e.entryId) });
  });

  test("the match is a literal substring of the display path without regard to letter case, and no match states it", async () => {
    const files = [entry("unstaged", "a.ts", ".M"), entry("unstaged", "axts", ".M"), entry("unstaged", "dir/A.TS", ".M")];
    await openCommitView(createWorld({ entries: files }));
    await click(button("Flat layout"));
    await typeIn(filesField()!, "a.ts");
    expect(labels("Changes")).toEqual(["a.ts", "dir/A.TS"]);
    expect(text(commitView()!)).not.toContain("No file matches the filter.");
    await typeIn(filesField()!, ".*");
    expect(labels("Changes")).toEqual([]);
    expect(text(commitView()!)).toContain("No file matches the filter.");
    await typeIn(filesField()!, "");
    expect(labels("Changes")).toEqual(["a.ts", "axts", "dir/A.TS"]);
  });

  test("the no-match line is an always-present status region that holds the text only when nothing matches", async () => {
    await openCommitView(createWorld({ entries: [entry("unstaged", "a.ts", ".M")] }));
    const region = () => commitView()!.querySelector('[data-slot="changes-workspace"] > [role="status"]');
    const first = region();
    expect(first !== null).toBe(true);
    expect(text(first!)).toBe("");
    await typeIn(filesField()!, "zz");
    expect(region() === first).toBe(true);
    expect(text(first!)).toBe("No file matches the filter.");
    await typeIn(filesField()!, "a");
    expect(region() === first).toBe(true);
    expect(text(first!)).toBe("");
  });

  test("Stage folder and Unstage all keep their full scope under a filter", async () => {
    const { all, staged } = board();
    const double = await openCommitView(createWorld({ entries: all }));
    await typeIn(filesField()!, "login");
    await click(button("Stage folder src", item("Changes", "src")));
    expect(double.pending("applyFiles")!.args[1]).toMatchObject({ kind: "folder", direction: "stage", entryIds: all.filter((e) => e.category !== "staged" && e.path.startsWith("src/")).map((e) => e.entryId) });
    await act(async () => double.pending("applyFiles")!.resolve({ requestId: fixtureId(0x5ff), state: "failed", code: "CANCELED" }));
    await settle();
    await click(button("Unstage all"));
    expect(double.pending("applyFiles")!.args[1]).toMatchObject({ kind: "all-staged", direction: "unstage", entryIds: staged.map((e) => e.entryId) });
  });

  test("a row that the filter hides leaves the selection, so Stage selected covers only shown rows", async () => {
    const files = ["keep-1.ts", "drop.ts", "keep-2.ts"].map((p) => entry("unstaged", p, ".M"));
    const double = await openCommitView(createWorld({ entries: files }));
    await click(item("Changes", "keep-1.ts"));
    await clickWith(item("Changes", "drop.ts"), { ctrlKey: true });
    await clickWith(item("Changes", "keep-2.ts"), { ctrlKey: true });
    expect(button("Stage selected (3)")).not.toBeNull();
    await typeIn(filesField()!, "keep");
    await click(button("Stage selected (2)"));
    expect(double.pending("applyFiles")!.args[1]).toMatchObject({ kind: "selected", entryIds: [files[0]!.entryId, files[2]!.entryId] });
    await act(async () => double.pending("applyFiles")!.resolve({ requestId: fixtureId(0x5ff), state: "failed", code: "CANCELED" }));
    await settle();
    // The hidden row stays out of the selection after the filter clears.
    await typeIn(filesField()!, "");
    expect(items("Changes").filter((i) => i.getAttribute("aria-selected") === "true").map((i) => i.getAttribute("aria-label"))).toEqual(["keep-1.ts", "keep-2.ts"]);
  });

  test("a filter that hides the selected file clears the selection: the diff shows its empty state, and no other file gets selected (review)", async () => {
    const files = ["login.ts", "menu.ts"].map((p) => entry("unstaged", p, ".M"));
    const double = await openCommitView(createWorld({ entries: files }));
    await click(item("Changes", "menu.ts"));
    expect(item("Changes", "menu.ts").getAttribute("aria-selected")).toBe("true");
    const reads = double.count("readComparison");
    await typeIn(filesField()!, "login");
    expect(items("Changes").filter((i) => i.getAttribute("aria-selected") === "true")).toHaveLength(0);
    const diff = commitView()!.querySelector('[data-section="comparison"]')!;
    expect(text(diff)).toContain(HELP_LINE);
    expect(double.count("readComparison")).toBe(reads);
    // A filter that keeps the selected file keeps the selection.
    await typeIn(filesField()!, "");
    await click(item("Changes", "login.ts"));
    await typeIn(filesField()!, "LOG");
    expect(item("Changes", "login.ts").getAttribute("aria-selected")).toBe("true");
  });

  test("a clean tree shows Working tree clean and no no-match line under a filter (review)", async () => {
    const host = await render(<ChangesPane entries={[]} selection={null} onSelect={() => {}} onFileAction={() => new Promise(() => {})} complete />);
    await typeIn(host.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!, "x");
    expect(text(host)).toContain("Working tree clean");
    expect(text(host)).not.toContain("No file matches the filter.");
  });

  test("a collapsed Untracked section of 100,000 files creates no rows under a filter", async () => {
    const untracked = Array.from({ length: 100_000 }, (_, i) => entry("untracked", `out/f${i}.bin`));
    const entries = [entry("unstaged", "a.ts", ".M"), ...untracked];
    const host = await render(<ChangesPane entries={entries} selection={null} onSelect={() => {}} onFileAction={() => new Promise(() => {})} />);
    await typeIn(host.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!, "f1");
    expect([...host.querySelectorAll('[role="treeitem"]')].map((i) => i.getAttribute("aria-label"))).toEqual(["Untracked, 100,000"]);
    // The section can still hold matches, so the pane states no "no match".
    expect(text(host)).not.toContain("No file matches the filter.");
  });
});
