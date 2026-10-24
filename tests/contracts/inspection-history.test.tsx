// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 T043: the changed files and the diff of the selected commit in History (spec FR-005 to FR-014, FR-017, FR-067, FR-068, plan.md D3 and D15).

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import type { BridgeResponse, OnProgress } from "../../src/frontend/bridge";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked, fixtureId } from "./bridge-contract";
import { createFake, oid as fakeOid, stubLayout, TARGET } from "./history-fake";
import { latinKeyCode } from "./key-codes";

printOrigin("../../src/frontend/history/CommitChanges.tsx", import.meta.dir);
printOrigin("../../src/frontend/history/CommitDetails.tsx", import.meta.dir);
printOrigin("../../src/frontend/state/history-view.ts", import.meta.dir);
printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
registerDom();

// The PatchView double records its props. Pierre needs the Vite build (T160).
const patchProps: Record<string, unknown>[] = [];
mock.module("../../src/frontend/changes/PatchView", () => ({
  default: (props: Record<string, unknown>) => {
    patchProps.push(props);
    return <pre data-slot="patch-double" data-hunk-action={String(props.hunkAction !== undefined)} data-lines={String(props.onLines !== undefined)}>{props.patch as string}</pre>;
  },
}));

mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));

const { createRoot } = await import("react-dom/client");
const { ViewCommitDetails } = await import("../../src/frontend/history/CommitDetails");
const { CommitChanges, HISTORY_PANES } = await import("../../src/frontend/history/CommitChanges");
type ChangesProps = Omit<import("../../src/frontend/history/CommitChanges").CommitChangesProps, "panes" | "onPanes">;
// The Workbench keeps the Changed files width and layout. This wrapper keeps them for the tests.
function WithPanes(props: ChangesProps) {
  const [panes, setPanes] = useState(HISTORY_PANES);
  return <CommitChanges {...props} panes={panes} onPanes={(next) => setPanes((p) => ({ ...p, ...next }))} />;
}
const { createHistoryView, createInspection } = await import("../../src/frontend/state/history-view");
type HistoryView = import("../../src/frontend/state/history-view").HistoryView;
type Inspection = import("../../src/frontend/state/history-view").Inspection;

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  patchProps.length = 0;
});
async function show(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, rerender: (next: ReactNode) => act(async () => root.render(next)) };
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
let restoreLayout: () => void = () => {};
beforeAll(() => void (restoreLayout = stubLayout(800)));
afterAll(() => restoreLayout());

// ---- The inspection bridge double ----

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const P1 = "1".repeat(40);
const P2 = "2".repeat(40);
const SUB_OLD = "a".repeat(40);
const SUB_NEW = "b".repeat(40);
type Call = { operation: string; target: unknown; payload: Record<string, unknown>; operationId: string; resolve(response: BridgeResponse): void; onProgress?: OnProgress };

function inspectionDouble() {
  const calls: Call[] = [];
  const canceled: string[] = [];
  let n = 0;
  const call = (operation: string) => (target: unknown, payload: Record<string, unknown>, onProgress?: OnProgress) =>
    new Promise<BridgeResponse>((resolve) => {
      const operationId = fixtureId(0x3000 + ++n);
      calls.push({ operation, target, payload, operationId, resolve, onProgress });
      // Contract §2: the accepted event carries the `operationId` that `cancel` names.
      queueMicrotask(() => onProgress?.({ requestId: "r", operationId, state: "accepted", counters: {} } as never));
    });
  const bridge = contractChecked({
    readCommitChanges: call("readCommitChanges"),
    readCommitFile: call("readCommitFile"),
    readBlame: call("readBlame"),
    cancel: (payload: { operationId: string }) => {
      canceled.push(payload.operationId);
      const held = calls.find((c) => c.operationId === payload.operationId);
      held?.resolve({ requestId: null, operationId: payload.operationId, state: "canceled" } as BridgeResponse);
      return Promise.resolve({ requestId: null, state: "succeeded" } as BridgeResponse);
    },
  });
  const last = (operation: string) => calls.filter((c) => c.operation === operation).at(-1)!;
  return { bridge, calls, canceled, last, of: (operation: string) => calls.filter((c) => c.operation === operation) };
}
const succeeded = (result: unknown): BridgeResponse => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result }) as BridgeResponse;
const failed = (code: string, result?: unknown): BridgeResponse => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "failed", code, ...(result === undefined ? {} : { result }) }) as BridgeResponse;
async function answer(call: Call, response: BridgeResponse) {
  await act(async () => call.resolve(response));
  await settle();
}

type FileSpec = { status?: "added" | "deleted" | "modified" | "renamed" | "type-changed"; path: string; old?: string; score?: number; kind?: "file" | "link" | "submodule" };
let changesSeq = 0;
function changesResult(viewId: string, oid: string, files: FileSpec[], fields: Record<string, unknown> = {}) {
  return {
    changesId: fixtureId(0x5000 + ++changesSeq),
    viewId,
    oid,
    parents: [P1],
    base: { kind: "parent", index: 0, oid: P1 },
    files: files.map((f, i) => ({
      fileId: i,
      status: f.status ?? "modified",
      ...(f.status === "renamed" ? { score: f.score ?? 92, oldPathBytes: b64(f.old!) } : {}),
      pathBytes: b64(f.path),
      kind: f.kind ?? "file",
    })),
    completeness: { state: "complete" },
    ...fields,
  };
}
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@\n-x\n+y\n";
function fileResult(changesId: string, fileId: number, fields: Record<string, unknown> = {}) {
  return { changesId, fileId, facts: {}, binary: false, patch: b64(PATCH), completeness: { state: "complete" }, ...fields };
}

// The fake history view: 10 commits, row i has parent i + 1, and row 9 is the root.
async function historyView(): Promise<HistoryView> {
  const fake = createFake({ total: 10, loaded: 10 });
  const view = createHistoryView(fake.bridge, TARGET);
  await act(async () => void (await view.open("all", false)));
  return view;
}

type Mounted = { host: HTMLElement; view: HistoryView; inspection: Inspection; double: ReturnType<typeof inspectionDouble>; viewId: string; trusts: number[]; blames: unknown[]; rerender(oid: string): Promise<void> };
// The Workbench passes the selected commit, and T068 reads only a commit that the current view selected.
const rowOf = (oid: string) => Array.from({ length: 10 }, (_, i) => fakeOid(i)).indexOf(oid);
const selectIn = (view: HistoryView, oid: string) => act(async () => view.select(oid, rowOf(oid), "full"));
async function mountChanges(oid = fakeOid(2), profile: "wide" | "narrow" | "constrained" = "wide", given?: HistoryView): Promise<Mounted> {
  const view = given ?? (await historyView());
  await selectIn(view, oid);
  const double = inspectionDouble();
  const inspection = createInspection(double.bridge, TARGET);
  const trusts: number[] = [];
  const blames: unknown[] = [];
  const node = (o: string) => (
    <ViewCommitDetails
      view={view}
      oid={o}
      profile={profile}
      changes={<WithPanes inspection={inspection} view={view} oid={o} profile={profile} onTrust={async () => (trusts.push(1), true)} onBlame={(request) => blames.push(request)} />}
    />
  );
  const { host, rerender } = await show(node(oid));
  await settle();
  return { host, view, inspection, double, viewId: view.getState().view!.viewId, trusts, blames, rerender: async (o) => (await selectIn(view, o), await rerender(node(o)), await settle()) };
}
/** Mounts and answers the first `readCommitChanges` with `files`. */
async function loaded(files: FileSpec[], fields: Record<string, unknown> = {}, oid = fakeOid(2), profile: "wide" | "narrow" | "constrained" = "wide") {
  const m = await mountChanges(oid, profile);
  const result = changesResult(m.viewId, oid, files, fields);
  await answer(m.double.last("readCommitChanges"), succeeded(result));
  return { ...m, result };
}
const tree = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="changed-files"] [role="tree"]')!;
const items = (host: HTMLElement) => [...tree(host).querySelectorAll<HTMLElement>('[role="treeitem"]')];
const labels = (host: HTMLElement) => items(host).map((e) => e.getAttribute("aria-label"));
const item = (host: HTMLElement, label: string) => items(host).find((e) => e.getAttribute("aria-label") === label)!;
const diff = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="history-diff"]')!;
const key = (element: Element, k: string, init: KeyboardEventInit = {}) => act(async () => void element.dispatchEvent(new KeyboardEvent("keydown", { key: k, keyCode: latinKeyCode(k), bubbles: true, cancelable: true, ...init })));
const click = (element: Element) => act(async () => (element as HTMLElement).click());

describe("layout (spec FR-005, Main and HistoryStates boards)", () => {
  test("the Selected commit region holds Commit details, Changed files (<n>), and the diff, with splitters", async () => {
    const { host } = await loaded([{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }]);
    const region = host.querySelector("section")!;
    expect(text(region.querySelector("h2")!)).toBe("Selected commit");
    expect(host.querySelector('[data-slot="commit-details-body"]')).not.toBeNull();
    expect(text(host.querySelector('[data-slot="changed-files"] h3')!)).toBe("Changed files (3)");
    expect(diff(host)).not.toBeNull();
    const splitters = [...host.querySelectorAll('[role="separator"]')].map((s) => s.getAttribute("aria-label"));
    expect(splitters).toEqual(["Resize commit details", "Resize changed files"]);
    expect(host.querySelector('[role="tablist"]')).toBeNull();
  });

  test("the constrained profile shows the tabs Commit and Changes, with the file list above the diff", async () => {
    const { host } = await loaded([{ path: "a.txt" }], {}, fakeOid(2), "constrained");
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((t) => text(t));
    expect(tabs).toEqual(["Commit", "Changes"]);
    expect(host.querySelector('[role="separator"]')).toBeNull();
  });

  test("the 001 line Changed files are not shown in this version. is gone", async () => {
    const { host } = await loaded([{ path: "a.txt" }]);
    expect(text(host)).not.toContain("Changed files are not shown in this version.");
  });
});

describe("reads (spec FR-007, plan.md D3 Selection)", () => {
  test("a row selection sends readCommitChanges {viewId, oid, parent: 0}, then readCommitFile for the first file in tree order", async () => {
    const m = await mountChanges();
    expect(m.double.calls.map((c) => [c.operation, c.payload])).toEqual([["readCommitChanges", { viewId: m.viewId, oid: fakeOid(2), parent: 0 }]]);
    // Git order: b.txt, A/x.txt, a.txt. Tree order: the folder A first, then a.txt and b.txt (spec FR-015).
    const result = changesResult(m.viewId, fakeOid(2), [{ path: "b.txt" }, { path: "A/x.txt" }, { path: "a.txt" }]);
    await answer(m.double.last("readCommitChanges"), succeeded(result));
    expect(m.double.last("readCommitFile").payload).toEqual({ changesId: result.changesId, fileId: 1 });
  });

  test("the rows follow comparePaths order: folders first, then names by folded bytes", async () => {
    const { host } = await loaded([{ path: "b.txt" }, { path: "Z.txt" }, { path: "a/y.txt" }, { path: "a.txt" }, { path: "B/x.txt" }]);
    expect(labels(host)).toEqual(["a, 1", "y.txt, modified", "B, 1", "x.txt, modified", "a.txt, modified", "b.txt, modified", "Z.txt, modified"]);
  });

  test("a fast move cancels the earlier file read; the latest read wins", async () => {
    const m = await loaded([{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }]);
    const first = m.double.last("readCommitFile");
    await click(item(m.host, "b.txt, modified"));
    await click(item(m.host, "c.txt, modified"));
    const reads = m.double.of("readCommitFile");
    expect(reads.map((c) => c.payload.fileId)).toEqual([0, 1, 2]);
    expect(m.double.canceled).toEqual([first.operationId, reads[1]!.operationId]);
    // A late answer of a superseded read shows nothing.
    await answer(reads[1]!, succeeded(fileResult(m.result.changesId, 1, { patch: b64("diff --git a/b b/b\n@@ -1 +1 @@\n-late\n+late\n") })));
    expect(text(diff(m.host))).toContain("Arbareto reads the diff.");
    await answer(reads[2]!, succeeded(fileResult(m.result.changesId, 2)));
    expect(diff(m.host).querySelector('[data-slot="patch-double"]')!.textContent).toBe(PATCH);
  });

  test("Refresh with a selected commit sends readCommitChanges only after the new view loads the commit (T068)", async () => {
    const fake = createFake({ total: 10, loaded: 10, hold: { load: true } });
    const view = createHistoryView(fake.bridge, TARGET);
    await act(async () => void (await view.open("all", false)));
    const m = await mountChanges(fakeOid(2), "wide", view);
    await answer(m.double.last("readCommitChanges"), succeeded(changesResult(m.viewId, fakeOid(2), [{ path: "a.txt" }])));
    const heading = () => text(m.host.querySelector('[data-slot="changed-files"] h3')!);
    expect(heading()).toBe("Changed files (1)");
    // The act scope ends before the held load ends, so a failed check leaves no open scope.
    let refreshed: Promise<void> = Promise.resolve();
    await act(async () => void (refreshed = view.refresh()));
    await settle();
    // `open()` holds the load of the selected commit. The new view does not hold the row yet (contract Δ3 `commitTarget`).
    expect(fake.held()).toBe(1);
    const newView = view.getState().view!.viewId;
    expect(newView).not.toBe(m.viewId);
    expect(m.double.of("readCommitChanges")).toHaveLength(1);
    await act(async () => (fake.release(), await refreshed));
    await settle();
    expect(m.double.of("readCommitChanges").map((c) => c.payload)).toEqual([
      { viewId: m.viewId, oid: fakeOid(2), parent: 0 },
      { viewId: newView, oid: fakeOid(2), parent: 0 },
    ]);
    await answer(m.double.last("readCommitChanges"), succeeded(changesResult(newView, fakeOid(2), [{ path: "a.txt" }, { path: "b.txt" }])));
    expect(heading()).toBe("Changed files (2)");
  });

  test("Refresh in filter mode keeps the selected match and reads its changes only after the new search selects it (T068)", async () => {
    const fake = createFake({ total: 10, loaded: 10, matches: (i) => i % 2 === 0, hold: { search: true } });
    const view = createHistoryView(fake.bridge, TARGET);
    await act(async () => void (await view.open("all", false)));
    let searched: Promise<void> = Promise.resolve();
    await act(async () => void (searched = view.search("Commit", "filter")));
    await settle();
    await act(async () => (fake.release(), await searched));
    await settle();
    expect(view.filterMode()).toBe(true);
    const m = await mountChanges(fakeOid(4), "wide", view);
    await act(async () => view.select(fakeOid(4), 2, "filter"));
    await settle();
    expect(m.double.of("readCommitChanges").map((c) => c.payload)).toEqual([{ viewId: m.viewId, oid: fakeOid(4), parent: 0 }]);
    let refreshed: Promise<void> = Promise.resolve();
    await act(async () => void (refreshed = view.refresh()));
    await settle();
    // The new view runs the search again (plan.md D6). The selection waits for it.
    expect(fake.held()).toBe(1);
    expect(m.double.of("readCommitChanges")).toHaveLength(1);
    await act(async () => (fake.release(), await refreshed));
    await settle();
    const newView = view.getState().view!.viewId;
    expect(view.getState().selection).toEqual({ id: fakeOid(4), index: 2, mode: "filter" });
    expect(m.double.of("readCommitChanges").map((c) => c.payload)).toEqual([
      { viewId: m.viewId, oid: fakeOid(4), parent: 0 },
      { viewId: newView, oid: fakeOid(4), parent: 0 },
    ]);
  });

  test("another commit sends a new readCommitChanges and cancels the running one", async () => {
    const m = await mountChanges();
    const first = m.double.last("readCommitChanges");
    await m.rerender(fakeOid(3));
    expect(m.double.last("readCommitChanges").payload).toEqual({ viewId: m.viewId, oid: fakeOid(3), parent: 0 });
    expect(m.double.canceled).toContain(first.operationId);
  });
});

describe("rows (spec FR-006, FR-017, 004 D16 colors)", () => {
  test("a file row shows the file icon and a submodule row the cube icon; the icon has no name (Main board, T073)", async () => {
    const { File01Icon, CubeIcon } = await import("@hugeicons/core-free-icons");
    const paths = (icon: readonly (readonly [string, Record<string, unknown>])[]) => icon.filter(([tag]) => tag === "path").map(([, a]) => a.d as string);
    const { host } = await loaded([{ path: "a.txt" }, { status: "added", path: "units-data", kind: "submodule" }]);
    const icon = (label: string) => item(host, label).querySelector('[data-slot="row-icon"]')!;
    expect([...icon("a.txt, modified").querySelectorAll("path")].map((p) => p.getAttribute("d"))).toEqual(paths(File01Icon));
    expect([...icon("units-data, submodule, added").querySelectorAll("path")].map((p) => p.getAttribute("d"))).toEqual(paths(CubeIcon));
    expect(icon("a.txt, modified").getAttribute("aria-hidden")).toBe("true");
  });

  test("names, rename and submodule suffixes, status letters, and their colors", async () => {
    const { host } = await loaded([
      { status: "added", path: "n.txt" },
      { status: "deleted", path: "d.txt" },
      { status: "modified", path: "m.txt" },
      { status: "renamed", path: "r.txt", old: "src/old.txt", score: 92 },
      { status: "type-changed", path: "t.txt" },
      { status: "modified", path: "core", kind: "submodule" },
    ]);
    expect(labels(host)).toEqual(["core, submodule, modified", "d.txt, deleted", "m.txt, modified", "n.txt, added", "r.txt, renamed, renamed from src/old.txt", "t.txt, type changed"]);
    const letter = (label: string) => item(host, label).querySelector<HTMLElement>('[data-slot="status-letter"]')!;
    expect([...items(host)].map((e) => e.querySelector('[data-slot="status-letter"]')!.textContent)).toEqual(["M", "D", "M", "A", "R", "T"]);
    expect(letter("n.txt, added").className).toContain("text-added");
    expect(letter("d.txt, deleted").className).toContain("text-removed");
    expect(letter("m.txt, modified").className).toContain("text-warning");
    expect(letter("r.txt, renamed, renamed from src/old.txt").className).toContain("text-text");
    expect(letter("t.txt, type changed").className).toContain("text-text");
  });
});

describe("parent picker (spec FR-008, US1-3)", () => {
  test("a merge commit shows Compare with, Parent 1 selected, and a change sends a new read", async () => {
    const m = await mountChanges();
    const result = changesResult(m.viewId, fakeOid(2), [{ path: "a.txt" }], { parents: [P1, P2], base: { kind: "parent", index: 0, oid: P1 } });
    await answer(m.double.last("readCommitChanges"), succeeded(result));
    const group = m.host.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Compare with");
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.labels?.[0]?.textContent ?? r.getAttribute("aria-label"))).toEqual([`Parent 1 ${P1.slice(0, 12)}`, `Parent 2 ${P2.slice(0, 12)}`]);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    await click(radios[1]!);
    await settle();
    expect(m.double.last("readCommitChanges").payload).toEqual({ viewId: m.viewId, oid: fakeOid(2), parent: 1 });
  });

  test("a commit with one parent shows no picker", async () => {
    const { host } = await loaded([{ path: "a.txt" }]);
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  });
});

describe("texts of plan.md D3 (spec FR-009 to FR-012)", () => {
  test("root commit", async () => {
    const { host } = await loaded([{ status: "added", path: "a.txt" }], { parents: [], base: { kind: "empty-tree", oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" } });
    expect(text(host)).toContain("Compared with an empty tree. This is a root commit.");
  });

  test("shallow: the heading without a count, and the shallow text", async () => {
    const { host } = await loaded([], { parents: [], base: { kind: "shallow" } });
    expect(text(host.querySelector('[data-slot="changed-files"] h3')!)).toBe("Changed files");
    expect(text(host)).toContain("Arbareto cannot show the changes. The parent of this commit is not in this shallow clone.");
  });

  test("limit, with the shown count and the en-US separator", async () => {
    const files = Array.from({ length: 3 }, (_, i) => ({ path: `f${i}.txt` }));
    const { host } = await loaded(files, { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS", shown: 3 } });
    expect(text(host)).toContain("This commit changes more files than Arbareto shows. Arbareto shows the first 3.");
    expect(text(host.querySelector('[data-slot="changed-files"] h3')!)).toBe("Changed files (3)");
  });

  test("the two empty-list texts", async () => {
    const root = await loaded([], { parents: [], base: { kind: "empty-tree", oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" } });
    expect(text(root.host)).toContain("This commit changes no file.");
    expect(text(root.host)).not.toContain("compared with parent");
    const merge = await mountChanges();
    await answer(merge.double.last("readCommitChanges"), succeeded(changesResult(merge.viewId, fakeOid(2), [], { parents: [P1, P2], base: { kind: "parent", index: 0, oid: P1 } })));
    await click(merge.host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!);
    await answer(merge.double.last("readCommitChanges"), succeeded(changesResult(merge.viewId, fakeOid(2), [], { parents: [P1, P2], base: { kind: "parent", index: 1, oid: P2 } })));
    expect(text(merge.host)).toContain("This commit changes no file compared with parent 2.");
  });

  test("loading, failure, and the trust text with Trust…", async () => {
    const m = await mountChanges();
    expect(text(m.host)).toContain("Arbareto reads the changed files.");
    await answer(m.double.last("readCommitChanges"), failed("GIT_FAILED"));
    expect(text(m.host)).toContain("Arbareto cannot read the changed files: GIT_FAILED.");
    const t = await mountChanges(fakeOid(3));
    await answer(t.double.last("readCommitChanges"), failed("TRUST_REQUIRED"));
    expect(text(t.host)).toContain("Arbareto reads no changes until you trust this repository.");
    const trust = [...t.host.querySelectorAll("button")].find((b) => text(b) === "Trust…")!;
    await click(trust);
    await settle();
    expect(t.trusts.length).toBe(1);
    // After the approval the read runs again.
    expect(t.double.of("readCommitChanges").length).toBe(2);
  });

  test("OBJECT_MISSING of the listing shows the 001 remedy", async () => {
    const m = await mountChanges();
    await answer(m.double.last("readCommitChanges"), failed("OBJECT_MISSING", { remedy: { text: "Fetch the missing objects, then refresh." } }));
    expect(text(m.host)).toContain("Fetch the missing objects, then refresh.");
  });

  test("the fact rows above the diff", async () => {
    const cases: [FileSpec, Record<string, unknown>, string][] = [
      [{ status: "renamed", path: "src/new.ts", old: "src/old.ts", score: 92 }, { facts: { rename: { oldPath: b64("src/old.ts"), score: 92 } } }, "Renamed from src/old.ts (92% similar)."],
      [{ path: "build.sh" }, { facts: { mode: { old: "100644", new: "100755" } } }, "Mode 100644 → 100755."],
      [{ path: "core", kind: "submodule" }, { facts: { submodule: { old: SUB_OLD, new: SUB_NEW } }, patch: null }, `Submodule commit ${SUB_OLD.slice(0, 12)} → ${SUB_NEW.slice(0, 12)}.`],
      [{ status: "added", path: "core", kind: "submodule" }, { facts: { submodule: { old: null, new: SUB_NEW } }, patch: null }, `Submodule commit added: ${SUB_NEW.slice(0, 12)}.`],
      [{ status: "deleted", path: "core", kind: "submodule" }, { facts: { submodule: { old: SUB_OLD, new: null } }, patch: null }, `Submodule commit removed: ${SUB_OLD.slice(0, 12)}.`],
      [{ path: "logo.png" }, { binary: true, patch: null }, "Binary file. Arbareto does not show its changes."],
      [{ status: "type-changed", path: "t" }, { facts: { typeChange: { old: "file", new: "link" } }, patch: null }, "Type changed from file to symbolic link."],
    ];
    for (const [spec, fields, expected] of cases) {
      const m = await loaded([spec]);
      await answer(m.double.last("readCommitFile"), succeeded(fileResult(m.result.changesId, 0, fields)));
      expect(text(diff(m.host))).toContain(expected);
      for (const unmount of unmounts.splice(0)) await unmount();
    }
  });

  test("the diff states, the 001 OBJECT_MISSING remedy, and the 001 limit text", async () => {
    const m = await loaded([{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }]);
    expect(text(diff(m.host))).toContain("Arbareto reads the diff.");
    await answer(m.double.last("readCommitFile"), failed("GIT_FAILED"));
    expect(text(diff(m.host))).toContain("Arbareto cannot read the diff: GIT_FAILED.");
    await click(item(m.host, "b.txt, modified"));
    await answer(m.double.last("readCommitFile"), failed("OBJECT_MISSING", { remedy: { text: "Fetch the missing objects, then refresh." } }));
    expect(text(diff(m.host))).toContain("Fetch the missing objects, then refresh.");
    await click(item(m.host, "c.txt, modified"));
    await answer(m.double.last("readCommitFile"), succeeded(fileResult(m.result.changesId, 2, { patch: null, completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "CANONICAL_DIFF_BYTES" } })));
    expect(text(diff(m.host))).toContain("Incomplete: OUTPUT_LIMIT CANONICAL_DIFF_BYTES.");
  });
});

describe("the diff header and body (spec FR-014)", () => {
  test("path, <n> hunks, Copy path, Previous hunk, Next hunk, and Blame; PatchView gets no hunk action and no line selection", async () => {
    const m = await loaded([{ path: "src/a.txt" }]);
    await answer(m.double.last("readCommitFile"), succeeded(fileResult(m.result.changesId, 0)));
    const header = diff(m.host).querySelector<HTMLElement>('[data-slot="diff-header"]')!;
    expect(text(header)).toContain("src/a.txt");
    expect(text(header)).toContain("2 hunks");
    const names = [...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? text(b));
    expect(names).toEqual(["Copy path", "Previous hunk", "Next hunk", "Blame"]);
    expect(header.querySelector('[aria-label="Previous hunk"]')!.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp");
    expect(header.querySelector('[aria-label="Next hunk"]')!.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowDown");
    const stub = diff(m.host).querySelector('[data-slot="patch-double"]')!;
    expect(stub.getAttribute("data-hunk-action")).toBe("false");
    expect(stub.getAttribute("data-lines")).toBe("false");
    expect(text(diff(m.host))).not.toMatch(/Stage|Unstage/);
  });

  test("Blame sends the blame request of the shown file", async () => {
    const m = await loaded([{ path: "src/a.txt" }]);
    await answer(m.double.last("readCommitFile"), succeeded(fileResult(m.result.changesId, 0)));
    await click([...diff(m.host).querySelectorAll("button")].find((b) => text(b) === "Blame")!);
    expect(m.blames).toEqual([{ source: { changesId: m.result.changesId, fileId: 0 }, path: "src/a.txt", oid: fakeOid(2) }]);
  });

  test("a deleted row blames at the chosen parent", async () => {
    const m = await loaded([{ status: "deleted", path: "gone.txt" }]);
    await answer(m.double.last("readCommitFile"), succeeded(fileResult(m.result.changesId, 0)));
    await click([...diff(m.host).querySelectorAll("button")].find((b) => text(b) === "Blame")!);
    expect(m.blames).toEqual([{ source: { changesId: m.result.changesId, fileId: 0 }, path: "gone.txt", oid: P1 }]);
  });
});

describe("keys (spec FR-013)", () => {
  test("one Tab stop with roving focus; Up and Down show the diff at once; Home and End", async () => {
    const m = await loaded([{ path: "a.txt" }, { path: "b.txt" }, { path: "c.txt" }]);
    expect(items(m.host).filter((e) => e.tabIndex === 0).length).toBe(1);
    const start = item(m.host, "a.txt, modified");
    await act(async () => start.focus());
    await key(start, "ArrowDown");
    expect(m.double.last("readCommitFile").payload.fileId).toBe(1);
    expect(document.activeElement).toBe(item(m.host, "b.txt, modified"));
    expect(item(m.host, "b.txt, modified").getAttribute("aria-selected")).toBe("true");
    await key(document.activeElement!, "End");
    expect(m.double.last("readCommitFile").payload.fileId).toBe(2);
    await key(document.activeElement!, "Home");
    expect(m.double.last("readCommitFile").payload.fileId).toBe(0);
    await key(document.activeElement!, "ArrowUp");
    expect(document.activeElement).toBe(item(m.host, "a.txt, modified"));
    expect(items(m.host).filter((e) => e.tabIndex === 0).length).toBe(1);
  });

  test("Left and Right collapse and expand a folder", async () => {
    const m = await loaded([{ path: "src/a.txt" }, { path: "z.txt" }]);
    const folder = item(m.host, "src, 1");
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    await act(async () => folder.focus());
    await key(folder, "ArrowLeft");
    expect(item(m.host, "src, 1").getAttribute("aria-expanded")).toBe("false");
    expect(labels(m.host)).toEqual(["src, 1", "z.txt, modified"]);
    await key(item(m.host, "src, 1"), "ArrowRight");
    expect(labels(m.host)).toEqual(["src, 1", "a.txt, modified", "z.txt, modified"]);
  });

  test("Alt+Up and Alt+Down in the diff step through the hunks", async () => {
    const m = await loaded([{ path: "a.txt" }]);
    await answer(m.double.last("readCommitFile"), succeeded(fileResult(m.result.changesId, 0)));
    const body = diff(m.host).querySelector<HTMLElement>('[data-slot="diff-body"]')!;
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true });
    await act(async () => void body.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("Filter files (spec FR-013, 004 FR-101)", () => {
  test("a literal substring without regard to case; a hidden selected row leaves the selection; the no-match line", async () => {
    const m = await loaded([{ path: "src/Login.ts" }, { path: "readme.md" }]);
    const field = m.host.querySelector<HTMLInputElement>('[data-slot="changed-files"] input[aria-label="Filter files"]')!;
    expect(field.getAttribute("aria-keyshortcuts")).toBe("Control+F");
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    };
    // The first file in tree order is src/Login.ts.
    expect(item(m.host, "Login.ts, modified").getAttribute("aria-selected")).toBe("true");
    await type("READ");
    expect(labels(m.host)).toEqual(["readme.md, modified"]);
    expect(items(m.host).some((e) => e.getAttribute("aria-selected") === "true")).toBe(false);
    // Counts keep the values of the read.
    expect(text(m.host.querySelector('[data-slot="changed-files"] h3')!)).toBe("Changed files (2)");
    await type("nothing");
    expect(text(m.host)).toContain("No file matches the filter.");
  });
});

describe("virtual rows (spec FR-068)", () => {
  test("a 100,000-file list creates rows only near the visible area", async () => {
    const files = Array.from({ length: 100_000 }, (_, i) => ({ path: `f${String(i).padStart(6, "0")}.txt` }));
    const m = await loaded(files, { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS", shown: 100_000 } });
    expect(text(m.host.querySelector('[data-slot="changed-files"] h3')!)).toBe("Changed files (100,000)");
    expect(items(m.host).length).toBeLessThan(200);
  });
});

// ---- The Workbench wiring: Ctrl+F and F6 (spec FR-013, plan.md D15 "F6 order") ----

describe("workbench keys", () => {
  test("Ctrl+F focuses Filter files only in Changed files or the diff; F6 reaches Changed files and then the diff after the commit details", async () => {
    const { mountWorkbench } = await import("./inspection-workbench");
    const w = await mountWorkbench();
    unmounts.push(w.unmount);
    await w.selectCommit();
    // The constrained profile shows the regions as tabs. The Changes tab holds the list and the diff.
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t) === "Changes");
    if (tab !== undefined) await click(tab);
    const files = document.querySelector<HTMLElement>('[data-slot="changed-files"]')!;
    const filter = files.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!;
    const historyFilter = document.querySelector<HTMLInputElement>('section[aria-label="History"] input')!;
    // Ctrl+F in the history list keeps the 002 history filter.
    const row = document.querySelector<HTMLElement>('section[aria-label="History"] [data-history-list]')!;
    await act(async () => row.focus());
    await key(row, "f", { ctrlKey: true });
    expect(document.activeElement).toBe(historyFilter);
    const first = files.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')!;
    await act(async () => first.focus());
    await key(first, "f", { ctrlKey: true });
    expect(document.activeElement).toBe(filter);
    // happy-dom has no layout, so the Workbench takes the constrained profile, where the Changes tab holds both regions.
    // F6 from the History list reaches the shown dock regions in order: the commit details tabs, Changed files, then the diff.
    const list = document.querySelector<HTMLElement>('section[aria-label="History"] [data-history-list]')!;
    await act(async () => list.focus());
    await key(list, "F6");
    expect(document.activeElement?.closest('[data-section="commitDetails"]')).not.toBeNull();
    expect(files.contains(document.activeElement)).toBe(false);
    await key(document.activeElement!, "F6");
    expect(files.contains(document.activeElement)).toBe(true);
    await key(document.activeElement!, "F6");
    expect(document.querySelector('[data-slot="history-diff"]')!.contains(document.activeElement)).toBe(true);
    await key(document.activeElement!, "F6", { shiftKey: true });
    expect(files.contains(document.activeElement)).toBe(true);
  });

  test("a remembered control in the hidden Changes tab does not take F6 (review fix 1)", async () => {
    const { mountWorkbench } = await import("./inspection-workbench");
    const w = await mountWorkbench();
    unmounts.push(w.unmount);
    await w.selectCommit();
    const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t) === name)!;
    await click(tab("Changes"));
    const files = document.querySelector<HTMLElement>('[data-slot="changed-files"]')!;
    const first = files.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')!;
    await act(async () => first.focus());
    await click(tab("Commit"));
    expect(first.closest("[hidden]")).not.toBeNull();
    const list = document.querySelector<HTMLElement>('section[aria-label="History"] [data-history-list]')!;
    await act(async () => list.focus());
    await key(list, "F6");
    expect(document.activeElement?.closest('[data-section="commitDetails"]')).not.toBeNull();
    await key(document.activeElement!, "F6");
    expect(first.closest("[hidden]")?.contains(document.activeElement) ?? false).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
  });
});

// ---- Review fixes of WP6 (4, 5) ----

describe("generation and path refusals", () => {
  test("REPOSITORY_CHANGED sends one new readCommitChanges, and a second one shows the failure (001 contract §9)", async () => {
    const m = await mountChanges();
    await answer(m.double.last("readCommitChanges"), failed("REPOSITORY_CHANGED"));
    expect(m.double.of("readCommitChanges").length).toBe(2);
    await answer(m.double.last("readCommitChanges"), failed("REPOSITORY_CHANGED"));
    expect(m.double.of("readCommitChanges").length).toBe(2);
    expect(text(m.host)).toContain("Arbareto cannot read the changed files: REPOSITORY_CHANGED.");
  });

  test("REPOSITORY_CHANGED, then a result: the list shows", async () => {
    const m = await mountChanges();
    await answer(m.double.last("readCommitChanges"), failed("REPOSITORY_CHANGED"));
    await answer(m.double.last("readCommitChanges"), succeeded(changesResult(m.viewId, fakeOid(2), [{ path: "a.txt" }])));
    expect(labels(m.host)).toEqual(["a.txt, modified"]);
  });

  test("UNSUPPORTED_COMPARISON with the reason path shows the path text (plan.md D3)", async () => {
    const m = await loaded([{ path: "a.txt" }]);
    await answer(m.double.last("readCommitFile"), failed("UNSUPPORTED_COMPARISON", { reason: "path" }));
    expect(text(diff(m.host))).toContain("Arbareto cannot pass this file name to Git, because it is not valid UTF-8.");
  });

  test("no hunk count without hunks, and 1 hunk for one", async () => {
    const one = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const m = await loaded([{ path: "a.txt" }, { path: "b.png" }]);
    await answer(m.double.last("readCommitFile"), succeeded(fileResult(m.result.changesId, 0, { patch: b64(one) })));
    expect(text(diff(m.host).querySelector('[data-slot="diff-header"]')!)).toContain("1 hunk");
    expect(text(diff(m.host).querySelector('[data-slot="diff-header"]')!)).not.toContain("hunks");
    await click(item(m.host, "b.png, modified"));
    await answer(m.double.last("readCommitFile"), succeeded(fileResult(m.result.changesId, 1, { binary: true, patch: null })));
    expect(text(diff(m.host).querySelector('[data-slot="diff-header"]')!)).not.toContain("hunk");
  });
});
