// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A Workbench bridge double for the feature 003 sync tests. The read operations answer from `world`; every other operation waits until the test answers it.
// The results follow contract Δ3 and data-model §1 to §10. The double invents no field.

import { act } from "react";
import type { WorkspaceSnapshot } from "../../src/contracts/envelope";
import { contractChecked, fixtureId } from "./bridge-contract";

export const oid = (n: number) => n.toString(16).padStart(40, "0");
export const REGISTRATION = { repositoryId: fixtureId(1), generation: 1, worktreeKey: "a".repeat(64) };
export const succeeded = (result: unknown, fields: Record<string, unknown> = {}) => ({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result, ...fields });

type Head = WorkspaceSnapshot["head"];
type Track = { state: "none" } | { state: "gone" } | { state: "counts"; ahead: number; behind: number };
export type World = {
  head: Head;
  operationState: WorkspaceSnapshot["operationState"];
  entries: WorkspaceSnapshot["entries"];
  /** History commits, newest first. Row 0 is the checkout. */
  oids: string[];
  /** Local branches: name, objectId, upstream (full name), upstream objectId, track, current. */
  branches: { name: string; objectId: string; upstream: string | null; upstreamObjectId: string | null; track: Track; current: boolean }[];
  /** `refs/remotes/<name>` entries of `readRefs`. */
  remotes: { name: string; objectId: string }[];
  refsDigest: string;
  defaultPullAction: "pull" | "pull-merge" | "pull-rebase" | "fetch" | "fetch-all";
  /** Overrides of the automatic answers. `undefined` keeps the call pending. */
  answers: Record<string, ((args: unknown[]) => unknown) | undefined>;
};

export function createWorld(fields: Partial<World> = {}): World {
  const head = oid(1);
  return {
    head: { state: "branch", target: "refs/heads/main", oid: head },
    operationState: "normal",
    entries: [],
    oids: [head, oid(2), oid(3)],
    branches: [{ name: "main", objectId: head, upstream: "refs/remotes/origin/main", upstreamObjectId: oid(9), track: { state: "counts", ahead: 2, behind: 3 }, current: true }],
    remotes: [{ name: "origin/main", objectId: oid(9) }],
    refsDigest: "d".repeat(64),
    defaultPullAction: "pull",
    answers: {},
    ...fields,
  };
}

export function snapshot(world: World): WorkspaceSnapshot {
  return {
    generation: 1,
    snapshotId: crypto.randomUUID(),
    readKind: "full",
    identity: { worktreeRoot: "C:\\repo", gitDirectory: "C:\\repo\\.git", commonDirectory: "C:\\repo\\.git", indexPath: "C:\\repo\\.git\\index", objectFormat: "sha1", refFormat: "files" },
    head: world.head,
    operationState: world.operationState,
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
    location: { kind: "native" },
    submoduleNotice: { count: 0, paths: [], filter: "applied" },
    entryCount: world.entries.length,
    entries: world.entries,
    cursor: null,
  } as WorkspaceSnapshot;
}

const refEntry = (kind: "branch" | "remote", name: string, objectId: string, upstream: string | null = null) => ({
  kind,
  name,
  invalidUtf8: false,
  objectId,
  objectType: "commit",
  peeledId: null,
  peeledType: null,
  symref: null,
  upstream,
  upstreamPresent: upstream !== null,
  commitId: objectId,
});

/** Contract §3 `RefList` (feature 002 Δ3 `refsDigest`). */
export function refList(world: World) {
  const current = world.branches.find((b) => b.current) ?? null;
  return {
    generation: 1,
    refs: [...world.branches.map((b) => refEntry("branch", b.name, b.objectId, b.upstream)), ...world.remotes.map((r) => refEntry("remote", r.name, r.objectId))],
    refsDigest: world.refsDigest,
    current: current === null ? null : { name: current.name, objectId: current.objectId },
    completeness: { state: "complete" },
  };
}

/** Data-model §1 `readTracking` entries. */
export function trackingList(world: World) {
  return { entries: world.branches.map((b) => ({ name: b.name, invalidUtf8: false, objectId: b.objectId, upstream: b.upstream, upstreamObjectId: b.upstreamObjectId, track: b.track, current: b.current })) };
}

/** Data-model §10 `readSyncSettings`. */
export const settings = (defaultPullAction: World["defaultPullAction"]) => ({ sshClient: "git", defaultPullAction, switchChoice: "keep", plinkPath: null, programs: [], remoteKeyFiles: [], defaultCloneFolder: null, lastCloneParent: null });

// Feature 002 contract Δ3: a linear history of `world.oids` with the checkout at row 0.
function history(world: World, operation: string, args: unknown[]): unknown {
  const oids = world.oids;
  const person = { name: "A", email: "a@example.invalid" };
  const payload = (args[1] ?? {}) as { scope?: string; at?: Record<string, unknown>; count?: number; text?: string };
  const viewRow = (i: number, text: string) => ({
    index: i,
    oid: oids[i]!,
    parents: i + 1 < oids.length ? [oids[i + 1]!] : [],
    cell: { node: 0, color: 0, merge: false, limited: false, segments: [], marks: i + 1 < oids.length ? [] : ["root"] },
    labels: world.branches.filter((b) => b.objectId === oids[i]).map((b) => ({ kind: "branch", name: b.name, invalidUtf8: false })),
    checkout: i === 0,
    ...(text === "none" ? {} : { subject: `Commit ${i}`, author: person, date: 1_700_000_000, encoding: null, invalidUtf8: false }),
    ...(text === "details" ? { body: "", bodyCut: false, committer: person, committerDate: 1_700_000_000, children: i > 0 ? [oids[i - 1]!] : [] } : {}),
  });
  const counts = { rowCount: oids.length, lanes: 1, complete: true, bytes: 1024 };
  if (operation === "openHistory") return succeeded({ viewId: crypto.randomUUID(), scope: payload.scope, generation: 1, head: world.head, startCount: 1, refsDigest: world.refsDigest, shallow: false });
  if (operation === "loadHistory") return succeeded({ rows: oids.length, complete: true });
  if (operation === "closeHistory") return succeeded({});
  const at = payload.at!;
  const first = "row" in at ? (at.row as number) : "oid" in at ? oids.indexOf(at.oid as string) : oids.length - 1;
  const rows = first < 0 || first >= oids.length ? [] : Array.from({ length: Math.min(payload.count!, oids.length - first) }, (_, k) => viewRow(first + k, payload.text!));
  return succeeded(rows.length === 0 ? { target: "none", ...counts } : { target: "found", rows, cut: false, ...counts });
}

export type Call = { operation: string; args: unknown[]; resolve(response: unknown): void; done: boolean };

/** The bridge double. Reads answer after one macrotask, so React sees them as ordinary async results. */
export function createSyncBridge(world: World) {
  const calls: Call[] = [];
  const auto: Record<string, (args: unknown[]) => unknown> = {
    readWorkspace: () => succeeded(snapshot(world)),
    readRefs: () => succeeded(refList(world)),
    readTracking: () => succeeded(trackingList(world)),
    readSyncSettings: () => succeeded(settings(world.defaultPullAction)),
    openHistory: (args) => history(world, "openHistory", args),
    loadHistory: (args) => history(world, "loadHistory", args),
    readHistoryRows: (args) => history(world, "readHistoryRows", args),
    closeHistory: (args) => history(world, "closeHistory", args),
  };
  const bridge = contractChecked(new Proxy(
    {},
    {
      get: (_, name) =>
        (...args: unknown[]) =>
          new Promise((resolve) => {
            const operation = String(name);
            const call: Call = { operation, args, done: false, resolve: (response) => ((call.done = true), resolve(response)) };
            calls.push(call);
            const answer = operation in world.answers ? world.answers[operation] : auto[operation];
            if (answer !== undefined) setTimeout(() => call.resolve(answer(args)), 0);
          }),
    },
  ));
  return {
    bridge,
    calls,
    /** The operation names in call order. */
    names: () => calls.map((c) => c.operation),
    count: (operation: string) => calls.filter((c) => c.operation === operation).length,
    /** The newest call of `operation` that has no answer yet. */
    pending: (operation: string) => calls.findLast((c) => c.operation === operation && !c.done),
  };
}

// The change poll never fires, so a test that counts reads sees only the reads it starts.
export const NO_POLL = { setInterval: () => 0, clearInterval: () => {}, setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (id: unknown) => clearTimeout(id as number) };

type WorkbenchModule = typeof import("../../src/frontend/app/Workbench");
const unmounts: (() => Promise<void>)[] = [];
/** Unmounts every Workbench of `mountWorkbench`. Call it in `afterEach`. */
export async function unmountAll() {
  for (const unmount of unmounts.splice(0)) await unmount();
  localStorage.clear();
}

/** Mounts the Workbench with a restored registration of `world`. The caller registers the DOM and imports the module first. */
export async function mountWorkbench(module: WorkbenchModule, world: World, HistoryView: WorkbenchModule["HistoryViewMount"] = module.HistoryViewMount) {
  const { createRoot } = await import("react-dom/client");
  const double = createSyncBridge(world);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <module.Workbench
        bridge={double.bridge as never}
        restored={Promise.resolve(succeeded(REGISTRATION)) as never}
        ChangesPane={module.ChangesPaneMount}
        ComparisonView={module.ComparisonViewMount}
        HistoryView={HistoryView}
        clock={NO_POLL}
      />,
    ),
  );
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await settle();
  await settle();
  return double;
}

// Lets the responses settle, React commit, and the next animation frame run.
export const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));

export async function answer(call: Call | undefined, response: unknown) {
  if (call === undefined) throw new Error("no pending call");
  await act(async () => call.resolve(response));
  await settle();
}

export const text = (element: Element = document.body) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
export async function click(element: Element) {
  await act(async () => (element as HTMLElement).click());
  await settle();
}
export async function press(target: Element | Window, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true, ...init }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}
/** A button by its accessible name: `aria-label`, else its text. */
export function buttons(label: string, from: ParentNode = document): HTMLElement[] {
  return [...from.querySelectorAll<HTMLElement>("button")].filter((b) => (b.getAttribute("aria-label") ?? text(b)) === label);
}
export function button(label: string, from: ParentNode = document): HTMLElement {
  const found = buttons(label, from);
  if (found.length !== 1) throw new Error(`expected one button "${label}", found ${found.length}: ${[...from.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? text(b)).join(" | ")}`);
  return found[0]!;
}
/** The text of a menu item without its key column. */
export function itemLabel(item: Element): string {
  const copy = item.cloneNode(true) as Element;
  for (const key of copy.querySelectorAll('[data-slot$="shortcut"]')) key.remove();
  return text(copy);
}
/** An open menu item by its label text. */
export function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].filter((e) => itemLabel(e) === label);
  if (found.length !== 1) throw new Error(`expected one menu item "${label}", found ${found.length}`);
  return found[0]!;
}
/** Base UI opens a tooltip only when its trigger matches `:focus-visible`. */
export async function keyboardFocus(element: HTMLElement) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true }));
    element.focus();
  });
  await settle();
}
export const tooltipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
