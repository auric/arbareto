// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, useState, type Dispatch, type SetStateAction } from "react";
import type { ChangeEntry } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/changes/ChangesPane.tsx", import.meta.dir);
registerDom();
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { ChangesPane } = await import("../../src/frontend/changes/ChangesPane");

// plan.md "Task flow and command placement" (Stage or unstage), "Long text", and "Keyboard and focus" (Stage key row).
const HELP = "Enter shows a file. Space stages or unstages it. The toolbar stages one hunk.";

const entry = (category: ChangeEntry["category"], path: string): ChangeEntry => ({
  entryId: crypto.randomUUID(),
  category,
  path,
  pathBytes: Buffer.from(path).toString("base64"),
});
const entries = [entry("unstaged", "src/a.ts"), entry("unstaged", "src/b.ts"), entry("untracked", "notes.txt"), entry("staged", "src/a.ts")];
const render = () => renderToStaticMarkup(<ChangesPane entries={entries} selection={null} onSelect={() => {}} onFileAction={() => new Promise(() => {})} />);

const attr = (attrs: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
function textById(html: string, id: string): string {
  const open = new RegExp(`<(\\w+)\\b[^>]*\\sid="${id}"[^>]*>`).exec(html);
  expect(open).not.toBeNull();
  return html.slice(open!.index + open![0].length, html.indexOf(`</${open![1]}>`, open!.index)).replace(/<[^>]+>/g, "");
}
// The accessible name of an element: its `aria-label`, or the text of its `aria-labelledby` targets.
const nameOf = (html: string, attrs: string) => attr(attrs, "aria-label") ?? (attr(attrs, "aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => textById(html, id)).join(" ");

describe("Unstaged help line", () => {
  test("the help line shows the plan.md text on one line with an end ellipsis", () => {
    const html = render();
    const line = [...html.matchAll(/<(\w+)\b([^>]*)>([^<]*)<\/\1>/g)].filter((m) => m[3] === HELP);
    expect(line).toHaveLength(1);
    expect(attr(line[0]![2]!, "class")?.split(/\s+/)).toContain("truncate");
    // The 18/20 DIP help line height (plan.md density table, T124 token).
    expect(line[0]![2]).toContain("--h-help-line");
  });

  test("the Unstaged listbox carries the help text as its accessible description, and no other listbox does", () => {
    const html = render();
    const listboxes = [...html.matchAll(/<\w+\b([^>]*\srole="listbox"[^>]*)>/g)].map((m) => m[1]!);
    for (const name of ["Unstaged", "Untracked", "Staged"]) expect(listboxes.some((attrs) => nameOf(html, attrs).includes(name))).toBe(true);
    const described = listboxes.filter((attrs) => (attr(attrs, "aria-describedby") ?? "").split(/\s+/).filter(Boolean).some((id) => textById(html, id).includes(HELP)));
    expect(described).toHaveLength(1);
    expect(nameOf(html, described[0]!)).toContain("Unstaged");
  });
});

// plan.md "Keyboard and focus", Stage key row. The harness owns the selection, as the workbench does.
// `onSelect` selects an entry and starts its comparison read, as Enter does. The harness then holds `comparisonId: null` until the test delivers the comparison.
// `onReason` feeds the T145 reason line. `onStatus` feeds the second live element of the status bar. `toolbarSuccess` takes a new object after each T202 button success.
type Direction = "stage" | "unstage";
type FileAction = { direction: Direction; comparisonId: string };
type FileActionResult = { state: "succeeded" } | { state: "failed" } | { state: "refused"; text: string };
type Selection = { entryId: string; comparisonId: string | null } | null;
type Flags = { fileActionRunning: boolean; operationRunning: boolean; modalOpen: boolean; menuOpen: boolean; toolbarSuccess: { entryId: string } | null };

const BUSY = "A file action is running. Wait for its result.";
const REFUSAL = "Stage file is unavailable: the file has a conflict";
const LABEL: Record<ChangeEntry["category"], string> = { conflicted: "Conflicted", unstaged: "Unstaged", untracked: "Untracked", staged: "Staged" };

const [unstagedA, unstagedB, untracked, stagedA] = entries as [ChangeEntry, ChangeEntry, ChangeEntry, ChangeEntry];
const conflicted = entry("conflicted", "src/c.ts");
const id = () => crypto.randomUUID();
const never = () => new Promise<FileActionResult>(() => {});

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

async function mount(initial: Selection) {
  const actions: FileAction[] = [];
  const reads: string[] = [];
  const reasons: (string | null)[] = [];
  const statuses: (string | null)[] = [];
  let respond: (action: FileAction) => Promise<FileActionResult> = never;
  let setSelection!: Dispatch<SetStateAction<Selection>>;
  let setFlags!: Dispatch<SetStateAction<Flags>>;
  function Harness() {
    const [selection, select] = useState<Selection>(initial);
    const [flags, flag] = useState<Flags>({ fileActionRunning: false, operationRunning: false, modalOpen: false, menuOpen: false, toolbarSuccess: null });
    setSelection = select;
    setFlags = flag;
    return (
      <ChangesPane
        entries={[conflicted, ...entries]}
        selection={selection}
        onSelect={(entryId: string) => {
          reads.push(entryId);
          select({ entryId, comparisonId: null });
        }}
        onFileAction={(action: FileAction) => (actions.push(action), respond(action))}
        onReason={(text: string | null) => void reasons.push(text)}
        onStatus={(text: string | null) => void statuses.push(text)}
        {...flags}
      />
    );
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  unmounts.push(unmount);
  return {
    actions,
    reads,
    reasons,
    statuses,
    respond: (next: (action: FileAction) => Promise<FileActionResult>) => void (respond = next),
    // The comparison read of `entryId` arrives. It changes nothing when another entry is selected.
    arrive: (entryId: string, comparisonId: string) => act(async () => setSelection((s) => (s?.entryId === entryId ? { entryId, comparisonId } : s))),
    select: (selection: Selection) => act(async () => setSelection(selection)),
    flag: (fields: Partial<Flags>) => act(async () => setFlags((f) => ({ ...f, ...fields }))),
  };
}

// The accessible name: `aria-label`, else the text of the `aria-labelledby` targets, else the text content.
function accessibleName(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label !== null) return label;
  const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  return ids.length > 0 ? ids.map((ref) => document.getElementById(ref)?.textContent ?? "").join(" ") : (element.textContent ?? "");
}
function option(e: ChangeEntry): HTMLElement {
  const boxes = [...document.querySelectorAll('[role="listbox"]')].filter((box) => accessibleName(box).includes(LABEL[e.category]));
  expect(boxes).toHaveLength(1);
  const found = [...boxes[0]!.querySelectorAll('[role="option"]')].filter((o) => accessibleName(o).includes(e.path));
  expect(found).toHaveLength(1);
  return found[0] as HTMLElement;
}
function heading(label: string): Element {
  const found = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].filter((h) => (h.textContent ?? "").includes(label));
  expect(found).toHaveLength(1);
  return found[0]!;
}
const statusTexts = () => [...document.querySelectorAll('[role="status"]')].map((s) => s.textContent);

const focus = (element: HTMLElement) => act(async () => element.focus());
async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  const code = key === " " ? "Space" : key;
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...init }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true, cancelable: true, ...init }));
  });
}
const space = (target: Element, init?: KeyboardEventInit) => press(target, " ", init);
// Space on the focused, selected entry, with an injected result.
async function spaceWith(e: ChangeEntry, result: FileActionResult) {
  const pane = await mount({ entryId: e.entryId, comparisonId: id() });
  pane.respond(() => Promise.resolve(result));
  await focus(option(e));
  await space(option(e));
  return pane;
}

describe("Stage key", () => {
  test("Space on a focused, selected Unstaged or Untracked entry calls the callback once with direction stage and the shown comparison ID, and starts no read", async () => {
    for (const e of [unstagedA, untracked]) {
      const comparisonId = id();
      const pane = await mount({ entryId: e.entryId, comparisonId });
      await focus(option(e));
      await space(option(e));
      expect(pane.actions).toHaveLength(1);
      expect(pane.actions[0]).toMatchObject({ direction: "stage", comparisonId });
      expect(pane.reads).toEqual([]);
      await unmounts.pop()!();
    }
  });

  test("Space on a focused, selected Staged entry calls the callback once with direction unstage", async () => {
    const comparisonId = id();
    const pane = await mount({ entryId: stagedA.entryId, comparisonId });
    await focus(option(stagedA));
    await space(option(stagedA));
    expect(pane.actions).toHaveLength(1);
    expect(pane.actions[0]).toMatchObject({ direction: "unstage", comparisonId });
    expect(pane.reads).toEqual([]);
  });

  test("Space on an unselected focused entry first selects it, and the callback runs after its comparison arrives with the new comparison ID", async () => {
    const pane = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    await focus(option(unstagedB));
    await space(option(unstagedB));
    expect(pane.reads).toEqual([unstagedB.entryId]);
    expect(pane.actions).toEqual([]);
    const comparisonId = id();
    await pane.arrive(unstagedB.entryId, comparisonId);
    expect(pane.actions).toHaveLength(1);
    expect(pane.actions[0]).toMatchObject({ direction: "stage", comparisonId });
  });

  test("a focus or selection change before the comparison arrives cancels the pending action", async () => {
    const moved = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    await focus(option(unstagedB));
    await space(option(unstagedB));
    await focus(option(untracked));
    await moved.arrive(unstagedB.entryId, id());
    expect(moved.reads).toEqual([unstagedB.entryId]);
    expect(moved.actions).toEqual([]);
    await unmounts.pop()!();

    const reselected = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    await focus(option(unstagedB));
    await space(option(unstagedB));
    await reselected.select({ entryId: unstagedA.entryId, comparisonId: id() });
    await reselected.select({ entryId: unstagedB.entryId, comparisonId: id() });
    expect(reselected.actions).toEqual([]);
  });

  test("after succeeded, a second Space on the next entry with a pending comparison starts no second read and runs the callback once after it arrives", async () => {
    const pane = await spaceWith(unstagedA, { state: "succeeded" });
    pane.respond(never);
    expect(pane.reads).toEqual([unstagedB.entryId]);
    expect(document.activeElement).toBe(option(unstagedB));
    await space(option(unstagedB));
    expect(pane.reads).toEqual([unstagedB.entryId]);
    expect(pane.actions).toHaveLength(1);
    const comparisonId = id();
    await pane.arrive(unstagedB.entryId, comparisonId);
    expect(pane.actions).toHaveLength(2);
    expect(pane.actions[1]).toMatchObject({ direction: "stage", comparisonId });
  });

  test("a selection change before that comparison arrives cancels the second Space", async () => {
    const pane = await spaceWith(unstagedA, { state: "succeeded" });
    pane.respond(never);
    await space(option(unstagedB));
    await pane.select({ entryId: untracked.entryId, comparisonId: id() });
    await pane.select({ entryId: unstagedB.entryId, comparisonId: id() });
    expect(pane.actions).toHaveLength(1);
  });

  test("while an injected file action runs, Space calls nothing and the pane reports the busy reason, and the role=status text stays unchanged", async () => {
    const pane = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    await pane.flag({ fileActionRunning: true });
    await focus(option(unstagedA));
    const before = statusTexts();
    await space(option(unstagedA));
    expect(pane.actions).toEqual([]);
    expect(pane.reads).toEqual([]);
    expect(pane.reasons.at(-1)).toBe(BUSY);
    expect(statusTexts()).toEqual(before);
    expect(pane.statuses.filter((text) => text !== null)).toEqual([]);
  });

  test("the busy reason clears when the action ends", async () => {
    const pane = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    await pane.flag({ fileActionRunning: true });
    await focus(option(unstagedA));
    await space(option(unstagedA));
    expect(pane.reasons.at(-1)).toBe(BUSY);
    await pane.flag({ fileActionRunning: false });
    expect(pane.reasons.at(-1)).toBeNull();
  });

  test("after succeeded, focus and selection move to the next entry, else the previous entry, else the category heading, and the new entry requests its comparison", async () => {
    const next = await spaceWith(unstagedA, { state: "succeeded" });
    expect(next.reads).toEqual([unstagedB.entryId]);
    expect(document.activeElement).toBe(option(unstagedB));
    await unmounts.pop()!();

    const previous = await spaceWith(unstagedB, { state: "succeeded" });
    expect(previous.reads).toEqual([unstagedA.entryId]);
    expect(document.activeElement).toBe(option(unstagedA));
    await unmounts.pop()!();

    const empty = await spaceWith(stagedA, { state: "succeeded" });
    expect(empty.actions[0]).toMatchObject({ direction: "unstage" });
    expect(empty.reads).toEqual([]);
    expect(heading("Staged").contains(document.activeElement)).toBe(true);
  });

  test("an injected toolbar button success moves focus and selection the same way", async () => {
    const pane = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    const toolbar = document.body.appendChild(document.createElement("button"));
    await focus(toolbar);
    await pane.flag({ toolbarSuccess: { entryId: unstagedA.entryId } });
    expect(pane.reads).toEqual([unstagedB.entryId]);
    expect(document.activeElement).toBe(option(unstagedB));
    expect(pane.actions).toEqual([]);
    toolbar.remove();
  });

  test("a failed result keeps focus and selection", async () => {
    const pane = await spaceWith(unstagedA, { state: "failed" });
    expect(pane.actions).toHaveLength(1);
    expect(pane.reads).toEqual([]);
    expect(document.activeElement).toBe(option(unstagedA));
  });

  test("without a running operation, a refusal shows in the status bar and keeps focus; with a running operation, the status bar keeps the operation text", async () => {
    const idle = await spaceWith(unstagedA, { state: "refused", text: REFUSAL });
    expect(idle.statuses).toContain(REFUSAL);
    expect(idle.reads).toEqual([]);
    expect(document.activeElement).toBe(option(unstagedA));
    await unmounts.pop()!();

    const busy = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    busy.respond(() => Promise.resolve({ state: "refused", text: REFUSAL }));
    await busy.flag({ operationRunning: true });
    await focus(option(unstagedA));
    await space(option(unstagedA));
    expect(busy.actions).toHaveLength(1);
    expect(busy.statuses.filter((text) => text !== null)).toEqual([]);
    expect(document.activeElement).toBe(option(unstagedA));
  });

  test("a Conflicted entry gives a refusal", async () => {
    const pane = await spaceWith(conflicted, { state: "refused", text: REFUSAL });
    expect(pane.actions).toHaveLength(1);
    expect(pane.statuses).toContain(REFUSAL);
    expect(pane.reads).toEqual([]);
    expect(document.activeElement).toBe(option(conflicted));
  });

  test("Space with Ctrl, Shift, or Alt, with repeat true, in an editable target, during composition, or with a dialog or menu open calls nothing", async () => {
    const pane = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    await focus(option(unstagedA));
    for (const init of [{ ctrlKey: true }, { shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }]) await space(option(unstagedA), init);
    const field = option(unstagedA).appendChild(document.createElement("input"));
    await focus(field);
    await space(field);
    field.remove();
    await focus(option(unstagedA));
    for (const open of [{ modalOpen: true }, { menuOpen: true }]) {
      await pane.flag(open);
      await space(option(unstagedA));
      await pane.flag({ modalOpen: false, menuOpen: false });
    }
    expect(pane.actions).toEqual([]);
    expect(pane.reads).toEqual([]);
    // Control: the same pane acts on a plain Space.
    await space(option(unstagedA));
    expect(pane.actions).toHaveLength(1);
  });

  test("a second Space while the callback runs calls nothing", async () => {
    const pane = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    await focus(option(unstagedA));
    await space(option(unstagedA));
    await space(option(unstagedA));
    expect(pane.actions).toHaveLength(1);
  });

  test("Enter selects and calls no callback", async () => {
    const pane = await mount({ entryId: unstagedA.entryId, comparisonId: id() });
    await focus(option(unstagedB));
    await press(option(unstagedB), "Enter");
    expect(pane.reads).toEqual([unstagedB.entryId]);
    await pane.arrive(unstagedB.entryId, id());
    expect(pane.actions).toEqual([]);
  });
});
