// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 010 WP5 (T012, T013): the History commit menu helpers. The caller registers the DOM, mocks PatchView and PatchPool, and passes the Workbench module.

import { act } from "react";
import { fixtureId } from "./bridge-contract";
import { createWorld, itemLabel, press, settle, succeeded, text, type World } from "./sync-fake";

/** Three commits with distinct short IDs. Row 0 is the checkout on `main`. */
export const A = "a1b2c3d4e5f6".padEnd(40, "1");
export const B = "b2c3d4e5f6a1".padEnd(40, "2");
export const C = "c3d4e5f6a1b2".padEnd(40, "3");
export const P2 = "d4e5f6a1b2c3".padEnd(40, "4");
export const short = (oid: string) => oid.slice(0, 12);
export const TOKEN = fixtureId(0x1010);
export const TOKEN_2 = fixtureId(0x1011);

/** A world whose history is A, B, C. `main` holds A. */
export function menuWorld(fields: Partial<World> = {}): World {
  const world = createWorld({
    head: { state: "branch", target: "refs/heads/main", oid: A },
    oids: [A, B, C],
    branches: [{ name: "main", objectId: A, upstream: "refs/remotes/origin/main", upstreamObjectId: A, track: { state: "counts", ahead: 0, behind: 0 }, current: true }],
    remotes: [{ name: "origin/main", objectId: A }],
    ...fields,
  });
  // Feature 004 data-model §1 entries of `readBranches`, so a branch label has its branch menu.
  world.answers.readBranches = () =>
    succeeded({
      entries: world.branches.map((b) => ({ ref: `refs/heads/${b.name}`, kind: "local", name: b.name, invalidUtf8: false, oid: b.objectId, upstream: b.upstream, tracking: null, heldBy: null, current: b.current, localName: null })),
    });
  return world;
}

export const historyList = () => document.querySelector<HTMLElement>("[data-history-list]")!;
export const option = (oid: string) => historyList().querySelector<HTMLElement>(`[data-row-id="${oid}"]`)!;
export const menu = () => document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
export const menuName = () => menu()?.getAttribute("aria-label") ?? null;
export const groups = () => [...(menu()?.querySelectorAll('[role="group"]') ?? [])].map((g) => [...g.querySelectorAll('[role="menuitem"]')].map(itemLabel));
export const popover = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]:not([data-closed])');
export const liveText = () => text(historyList().parentElement!.querySelector('p[role="status"]')!);
export const radio = (label: string, from: ParentNode = document) => [...from.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => text(r.closest("label") ?? r).startsWith(label))!;
export const reviews = (double: { calls: { operation: string; args: unknown[] }[] }) => double.calls.filter((c) => c.operation === "reviewWorkbench").map((c) => c.args[1] as Record<string, unknown>);

export async function rightClick(element: Element, clientX = 0) {
  await act(async () => void element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX })));
  await settle();
}

/** Selects the row of `oid` by a click, so the list has the focus. */
export async function selectRow(oid: string) {
  await act(async () => option(oid).click());
  await settle();
  await act(async () => historyList().focus());
}

/** Opens the commit menu of `oid` with Shift+F10. */
export async function keyMenu(oid: string) {
  await selectRow(oid);
  await press(historyList(), "F10", { shiftKey: true });
}

export const reviewed = (action: string, plan: Record<string, unknown>, token: string | null = TOKEN) => succeeded({ action, plan, ...(token === null ? {} : { workbenchToken: token }) });
export const refused = (code: string, result: Record<string, unknown> = {}) => ({ requestId: fixtureId(0x10ff), state: "rejected", code, result });
export const resetPlan = (fields: Record<string, unknown> = {}) => ({ target: B, mode: "mixed", branch: "refs/heads/main", from: A, leave: 0, gain: 0, reflogOnly: 0, forceNote: null, trackedChanges: 0, ignoredReplaced: 0, ...fields });
export const pickPlan = (fields: Record<string, unknown> = {}) => ({ commit: B, parents: [{ oid: C, subject: "Commit 2" }], mainline: null, branch: "refs/heads/main", ...fields });
export const tagPlan = (fields: Record<string, unknown> = {}) => ({ name: null, target: B, annotated: false, signs: { light: false, annotated: false }, ...fields });
