// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 WP7 (T048 to T050): the Commit view helpers of the file action tests. The caller registers the DOM, mocks PatchView and PatchPool, and passes the Workbench module.

import { act } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { fixtureId } from "./bridge-contract";
import { latinKeyCode } from "./key-codes";
import { button, click, expectChromiumFocus, itemLabel, mountWorkbench, settle, text, type World } from "./sync-fake";

type WorkbenchModule = typeof import("../../src/frontend/app/Workbench");

let next = 0xa000;
export const b64 = (s: string) => Buffer.from(s).toString("base64");
export const id = () => fixtureId(next++);
export function entry(category: ChangeEntry["category"], path: string, fields: Partial<ChangeEntry> = {}): ChangeEntry {
  return { entryId: id(), category, path, pathBytes: b64(path), ...(category === "untracked" ? {} : { xy: category === "staged" ? "M." : ".M" }), ...fields } as ChangeEntry;
}

export const commitView = () => document.querySelector<HTMLElement>('section[aria-label="Commit view"]');
export const views = () => document.querySelector<HTMLElement>('header nav[aria-label="Views"]')!;
export const tree = (name: string) => document.querySelector<HTMLElement>(`[role="tree"][aria-label="${name}"]`)!;
const items = (name: string) => [...tree(name).querySelectorAll<HTMLElement>('[role="treeitem"]')];
/** A row of the named tree by its accessible name, or by the name before its first comma. */
export function item(name: string, label: string): HTMLElement {
  const found = items(name).filter((i) => i.getAttribute("aria-label") === label || i.getAttribute("aria-label")?.startsWith(`${label}, `));
  if (found.length !== 1) throw new Error(`expected one row "${label}" in ${name}, found ${found.length}: ${items(name).map((i) => i.getAttribute("aria-label")).join(" | ")}`);
  return found[0]!;
}
export const describedBy = (element: Element) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((ref) => document.getElementById(ref)?.textContent ?? "")
    .join(" ");
export async function contextMenu(element: Element) {
  await act(async () => void element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await settle();
}
export const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((e) => !e.closest('[role="menubar"]'));
export const menuLabels = () => menuItems().map(itemLabel);
export function menuItem(label: string): HTMLElement {
  const found = menuItems().filter((i) => itemLabel(i) === label);
  if (found.length !== 1) throw new Error(`expected one menu item "${label}", found ${found.length}: ${menuLabels().join(" | ")}`);
  return found[0]!;
}
export const statusBar = () => text(document.querySelector("footer")!);

/** Mounts the Workbench of `world` and opens the Commit view with the Untracked section open. */
export async function openCommitView(module: WorkbenchModule, world: World) {
  const double = await mountWorkbench(module, world);
  await click(button("Commit", views()));
  const untracked = tree("Changes").querySelector<HTMLElement>('[data-section-row="untracked"]');
  if (untracked !== null && untracked.getAttribute("aria-expanded") === "false") await click(untracked);
  return double;
}

/** A keydown and keyup with the US-layout `keyCode` (plan D15 keyboard map, 004 T126). Returns the keydown. */
export async function pressKey(target: Element, key: string, init: KeyboardEventInit = {}) {
  let event: KeyboardEvent | null = null;
  await act(async () => {
    event = new KeyboardEvent("keydown", { key, code: key, keyCode: latinKeyCode(key), bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    target.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, keyCode: latinKeyCode(key), bubbles: true, cancelable: true, ...init }));
  });
  await settle();
  return event! as KeyboardEvent;
}
export { expectChromiumFocus };

/** Sets the value of a text field as typing does, so React sees an input event. */
export async function typeInto(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
