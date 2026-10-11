// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

registerDom();
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");

async function comparisonView() {
  printOrigin("../../src/frontend/changes/ComparisonView.tsx", import.meta.dir);
  return await import("../../src/frontend/changes/ComparisonView");
}

// T145 waits for T117. A template path keeps `tsc` from resolving the module before it exists.
const NEEDS = "(needs T145)";
type Props = Record<string, unknown>;
type HunkModule = {
  HunkControls: (props: Props) => ReactNode;
  /** Each width includes the gap after its control. `heading` is the heading width less 120 DIPs of path text and Copy path. */
  wrapHunkToolbar: (widths: Record<string, number>, room: { heading: number; row: number }) => { heading: string[]; rows: string[][] };
};
async function hunkControls(): Promise<HunkModule> {
  const module = "HunkControls";
  printOrigin(`../../src/frontend/changes/${module}.tsx`, import.meta.dir);
  return (await import(`../../src/frontend/changes/${module}.tsx`)) as HunkModule;
}

// plan.md "Task flow and command placement" ("Select a hunk"), "Hunk toolbar layout", and "Long text".

function bridgeDouble() {
  const calls: string[] = [];
  const bridge = new Proxy({}, { get: (_, name) => () => (calls.push(String(name)), new Promise(() => {})) });
  return { bridge: bridge as never, calls };
}

// The T331 comparison value: the shipped `src/git-service/comparison.ts` value plus `digest` on each hunk (data-model §5 Hunk).
function comparison(count: number, support = "supported") {
  return {
    comparisonId: crypto.randomUUID(),
    snapshotId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    scope: "index-to-worktree" as const,
    completeness: { state: "complete" as const },
    patch: Buffer.from("diff --git a/x b/x\n").toString("base64"),
    hunks: Array.from({ length: count }, (_, i) => ({ hunkId: crypto.randomUUID(), ordinal: i, oldStart: 10 * i + 1, oldCount: 1, newStart: 10 * i + 1, newCount: 2, digest: String(i).repeat(64) })),
    support,
    fileAction: "stage",
    remedy: null,
  };
}

function setup(fields: Partial<Props> = {}, count = 3) {
  const value = comparison(count);
  const selected: string[] = [];
  const double = bridgeDouble();
  const props = { bridge: double.bridge, comparison: value, category: "unstaged", selectedHunk: null, anchoredHunk: null, onSelectHunk: (id: string) => void selected.push(id), ...fields } as Props;
  const id = (n: number) => value.hunks[n - 1]!.hunkId;
  return { value, selected, double, props, id };
}

// A direct component call inside a render keeps the hooks valid and returns the element tree.
function tree(render: () => ReactNode): ReactNode {
  let result: ReactNode;
  const Probe = () => ((result = render()), null);
  renderToStaticMarkup(<Probe />);
  return result;
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...elements(node.props.children)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : "";
}
function click(root: ReactNode, label: string) {
  const found = elements(root).filter((e) => typeof e.props.onClick === "function" && (e.props["aria-label"] === label || text(e).includes(label)));
  expect(found).toHaveLength(1);
  (found[0]!.props.onClick as () => void)();
}

type Tag = { name: string; attrs: string; text: string; index: number };
// Opening tag, attributes, and plain text of each element of one kind. The checked elements hold no element of their own kind.
function tags(html: string, name: string): Tag[] {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`, "g"))].map((m) => ({ name, attrs: m[1]!, text: m[2]!.replace(/<[^>]+>/g, ""), index: m.index! }));
}
const attr = (tag: Tag, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag.attrs)?.[1];
// A button by its accessible name: `aria-label`, else its text.
function button(html: string, label: string): Tag {
  const found = tags(html, "button").filter((b) => (attr(b, "aria-label") ?? b.text).includes(label));
  expect(found).toHaveLength(1);
  return found[0]!;
}
function byId(html: string, id: string): Tag {
  const open = new RegExp(`<(\\w+)\\b([^>]*\\sid="${id}"[^>]*)>`).exec(html);
  expect(open).not.toBeNull();
  const [, name, attrs] = open!;
  const end = html.indexOf(`</${name}>`, open!.index);
  return { name: name!, attrs: attrs!, text: html.slice(open!.index + open![0].length, end).replace(/<[^>]+>/g, ""), index: open!.index };
}
// Base UI `focusableWhenDisabled` renders `aria-disabled="true"` and no `disabled` attribute, so the control keeps its Tab stop.
function expectFocusableDisabled(html: string, label: string, reason: string) {
  const b = button(html, label);
  expect(attr(b, "aria-disabled")).toBe("true");
  expect(attr(b, "disabled")).toBeUndefined();
  expect(attr(b, "tabindex")).not.toBe("-1");
  expect(byId(html, attr(b, "aria-describedby")!).text).toContain(reason);
}
// plan.md "Icons": the tooltip opens on keyboard focus and closes on Escape. Base UI opens it only when the trigger matches `:focus-visible`.
async function keyboardFocus(element: HTMLElement) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true }));
    element.focus();
  });
}
async function escape(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  });
}
const tooltipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;

const expectEnabled = (html: string, label: string) => {
  const b = button(html, label);
  expect(attr(b, "aria-disabled") ?? "false").toBe("false");
  expect(attr(b, "disabled")).toBeUndefined();
};

describe("hunk selection", () => {
  test(`without a selection, Next hunk selects hunk 1 and Previous hunk selects hunk 3`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const root = tree(() => HunkControls(s.props));
    click(root, "Next hunk");
    click(root, "Previous hunk");
    expect(s.selected).toEqual([s.id(1), s.id(3)]);
    expect(s.double.calls).toEqual([]);
  });

  test(`with hunk 2 anchored after a hunk action, each of them selects hunk 2`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const root = tree(() => HunkControls({ ...s.props, anchoredHunk: s.id(2) }));
    click(root, "Next hunk");
    click(root, "Previous hunk");
    expect(s.selected).toEqual([s.id(2), s.id(2)]);
  });

  test(`with hunk 2 selected, Next hunk selects hunk 3 and Previous hunk selects hunk 1`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const props = { ...s.props, selectedHunk: s.id(2) };
    const html = renderToStaticMarkup(<HunkControls {...props} />);
    expectEnabled(html, "Next hunk");
    expectEnabled(html, "Previous hunk");
    const root = tree(() => HunkControls(props));
    click(root, "Next hunk");
    click(root, "Previous hunk");
    expect(s.selected).toEqual([s.id(3), s.id(1)]);
    expect(s.double.calls).toEqual([]);
  });

  test(`at hunk 3, Next hunk is disabled with the visible reason and stays focusable`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const html = renderToStaticMarkup(<HunkControls {...s.props} selectedHunk={s.id(3)} />);
    expectFocusableDisabled(html, "Next hunk", "No next hunk");
    expectEnabled(html, "Previous hunk");
  });

  test(`at hunk 1, Previous hunk is disabled with the visible reason and stays focusable`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const html = renderToStaticMarkup(<HunkControls {...s.props} selectedHunk={s.id(1)} />);
    expectFocusableDisabled(html, "Previous hunk", "No previous hunk");
    expectEnabled(html, "Next hunk");
  });

  test(`in a one-hunk comparison with that hunk selected, both are disabled`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup({}, 1);
    const html = renderToStaticMarkup(<HunkControls {...s.props} selectedHunk={s.id(1)} />);
    expectFocusableDisabled(html, "Next hunk", "No next hunk");
    expectFocusableDisabled(html, "Previous hunk", "No previous hunk");
  });
});

describe("toolbar layout", () => {
  test(`the controls are Previous hunk, Next hunk, and the hunk action, in that order, with no file-action slot`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const html = renderToStaticMarkup(<HunkControls {...s.props} />);
    const order = ["Previous hunk", "Next hunk", "Stage selected hunk"].map((label) => button(html, label).index);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(tags(html, "button")).toHaveLength(3);
  });

  test(`Previous hunk and Next hunk are icon buttons with names, aria-keyshortcuts, and the key in the tooltip`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const html = renderToStaticMarkup(<HunkControls {...s.props} selectedHunk={s.id(2)} />);
    for (const [label, keys] of [
      ["Previous hunk", "Alt+ArrowUp"],
      ["Next hunk", "Alt+ArrowDown"],
    ] as const) {
      const b = button(html, label);
      expect(attr(b, "aria-label")).toBe(label);
      expect(attr(b, "aria-keyshortcuts")).toBe(keys);
      expect(b.text.trim()).toBe("");
      expect(b.attrs + b.text).not.toContain(label + " (");
    }
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(<HunkControls {...s.props} selectedHunk={s.id(2)} />));
      for (const [label, tip] of [
        ["Previous hunk", "Previous hunk (Alt+Up)"],
        ["Next hunk", "Next hunk (Alt+Down)"],
      ] as const) {
        const trigger = host.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!;
        await keyboardFocus(trigger);
        expect(tooltipText()).toBe(tip);
        await escape(trigger);
        expect(tooltipText()).toBeNull();
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  test(`Staged shows Unstage selected hunk`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup({ category: "staged" } as Partial<Props>);
    const html = renderToStaticMarkup(<HunkControls {...s.props} />);
    button(html, "Unstage selected hunk");
    expect(tags(html, "button").some((b) => b.text.includes("Stage selected hunk") && !b.text.includes("Unstage"))).toBe(false);
  });

  test(`the controls own one reason line after their buttons, on one line with an end ellipsis, and each disabled control takes only its own part as its description`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup({ comparison: comparison(0, "binary") } as Partial<Props>);
    const html = renderToStaticMarkup(<HunkControls {...s.props} />);
    const action = button(html, "Stage selected hunk");
    expect(attr(action, "aria-disabled")).toBe("true");
    expect(attr(action, "disabled")).toBeUndefined();
    const reason = byId(html, attr(action, "aria-describedby")!);
    expect(reason.text).toBe("Git reports binary content in this file");
    expect(reason.index).toBeGreaterThan(action.index);
    const lines = tags(html, "p").filter((p) => attr(p, "data-slot") === "reason-line");
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.index).toBeLessThan(reason.index);
    expect(attr(line, "class")?.split(/\s+/)).toContain("truncate");
    // The 18/20 DIP reason line height (plan.md density table, T124 token).
    expect(line.attrs).toContain("--h-reason-line");
    // The action reason comes first, ". " joins the parts, and no text repeats.
    expect(line.text).toBe("Git reports binary content in this file. No previous hunk. No next hunk.");
    expect(byId(html, attr(button(html, "Next hunk"), "aria-describedby")!).text).toBe("No next hunk");
  });

  test(`a part with the text of an earlier part stays hidden and keeps the description of its control`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup({ blocked: "busy", reasons: [{ id: "file-reason", text: "A file action is running. Wait for its result." }] } as Partial<Props>);
    const html = renderToStaticMarkup(<HunkControls {...s.props} />);
    const visible = /<p[^>]*data-slot="reason-line"[^>]*>([\s\S]*?)<\/p>/.exec(html)![1]!.replace(/<span[^>]*hidden[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "");
    expect(visible).toBe("A file action is running. Wait for its result.");
    expect(byId(html, "file-reason").text).toBe("A file action is running. Wait for its result");
    expect(byId(html, "file-reason").attrs).toContain("hidden");
  });

  // plan.md "Hunk toolbar layout": the controls stay in the heading beside 120 DIPs of path text, else move to a row below it, else the hunk action moves to a second row.
  test(`the wrap function keeps the controls in the heading, then moves them to one row, then moves the hunk action to a second row`, async () => {
    const { wrapHunkToolbar } = await hunkControls();
    const widths = { previous: 24, next: 24, hunkAction: 152 };
    expect(wrapHunkToolbar(widths, { heading: 200, row: 400 })).toEqual({ heading: ["previous", "next", "hunkAction"], rows: [] });
    expect(wrapHunkToolbar(widths, { heading: 199, row: 400 })).toEqual({ heading: [], rows: [["previous", "next", "hunkAction"]] });
    expect(wrapHunkToolbar(widths, { heading: 100, row: 199 })).toEqual({ heading: [], rows: [["previous", "next"], ["hunkAction"]] });
  });
});

describe("comparison heading", () => {
  const path = "src/frontend/changes/a-very-long-folder-name/ComparisonView.tsx";
  const heading = { path, scope: "Unstaged", sides: "Index to working file" };
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis.navigator, "clipboard", original);
    else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
  });

  test("its accessible name holds the full path, scope, and sides, and it keeps the pane heading height", async () => {
    const { ComparisonHeading } = await comparisonView();
    const html = renderToStaticMarkup(<ComparisonHeading {...heading} />);
    const named = [...html.matchAll(/<(\w+)\b([^>]*)\saria-label="([^"]*)"/g)].find((m) => m[3]!.includes(path));
    expect(named).toBeDefined();
    expect(named![3]).toContain(heading.scope);
    expect(named![3]).toContain(heading.sides);
    // The 32/36 DIP pane heading height (plan.md density table, T124 token).
    expect(html.slice(0, html.indexOf(">"))).toContain("--h-pane-heading");
  });

  test("Copy path is an icon button with its name, a Tab stop, and no visible text, and it copies the full path", async () => {
    const { ComparisonHeading } = await comparisonView();
    const html = renderToStaticMarkup(<ComparisonHeading {...heading} />);
    const copy = button(html, "Copy path");
    expect(attr(copy, "aria-label")).toBe("Copy path");
    expect(copy.text.trim()).toBe("");
    expect(copy.attrs + html.slice(copy.index, html.indexOf("</button>", copy.index))).toContain("<svg");
    expect(attr(copy, "tabindex")).not.toBe("-1");
    expect(attr(copy, "disabled")).toBeUndefined();
    // Copy path has no key.
    expect(attr(copy, "aria-keyshortcuts")).toBeUndefined();
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(<ComparisonHeading {...heading} />));
      await act(async () => host.querySelector<HTMLElement>('button[aria-label="Copy path"]')!.click());
      expect(written).toEqual([path]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  test("the Copy path tooltip reads Copy path without the path, opens on keyboard focus, and closes on Escape", async () => {
    const { ComparisonHeading } = await comparisonView();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(<ComparisonHeading {...heading} />));
      const copy = host.querySelector<HTMLElement>('button[aria-label="Copy path"]')!;
      expect(tooltipText()).toBeNull();
      await keyboardFocus(copy);
      expect(tooltipText()).toBe("Copy path");
      await escape(copy);
      expect(tooltipText()).toBeNull();
      expect(document.activeElement).toBe(copy);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  test("the heading holds the hunk controls after Copy path, so Tab reaches Copy path first", async () => {
    const { ComparisonHeading } = await comparisonView();
    const html = renderToStaticMarkup(<ComparisonHeading {...heading} controls={<button type="button">hunk controls double</button>} />);
    expect(button(html, "Copy path").index).toBeLessThan(button(html, "hunk controls double").index);
  });

  test("the fit function shrinks the folder, then the file name, then the sides, then the scope, and never Copy path", async () => {
    const { fitComparisonHeading } = await comparisonView();
    const parts = { copyPath: 80, folder: { full: 300, min: 20 }, file: { full: 100, min: 30 }, sides: { full: 120, min: 20 }, scope: { full: 100, min: 20 } };
    expect(fitComparisonHeading({ ...parts, width: 700 })).toEqual({ folder: 300, file: 100, sides: 120, scope: 100 });
    expect(fitComparisonHeading({ ...parts, width: 600 })).toEqual({ folder: 200, file: 100, sides: 120, scope: 100 });
    expect(fitComparisonHeading({ ...parts, width: 400 })).toEqual({ folder: 20, file: 80, sides: 120, scope: 100 });
    expect(fitComparisonHeading({ ...parts, width: 300 })).toEqual({ folder: 20, file: 30, sides: 70, scope: 100 });
    expect(fitComparisonHeading({ ...parts, width: 200 })).toEqual({ folder: 20, file: 30, sides: 20, scope: 50 });
    expect(fitComparisonHeading({ ...parts, width: 100 })).toEqual({ folder: 20, file: 30, sides: 20, scope: 20 });
  });

  // Alt+Up and Alt+Down reach the selection through the comparison pane and the T127 handler. The test mounts the controls in a pane with that handler.
  test(`at hunk 3, Alt+Down selects nothing, and at hunk 1, Alt+Up selects nothing`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const { createShortcutHandler } = await import("../../src/frontend/keyboard/shortcuts");
    const host = document.body.appendChild(document.createElement("div"));
    const stepRef: { current: ((direction: "next" | "previous") => void) | null } = { current: null };
    const handle = createShortcutHandler();
    const onKey = (event: KeyboardEvent) => {
      const action = handle(event, { messageField: null, comparisonPane: host, modalOpen: false, menuOpen: false, commitEnabled: false });
      if (action?.type === "selectHunk") stepRef.current?.(action.direction);
    };
    window.addEventListener("keydown", onKey);
    const root = createRoot(host);
    const alt = async (selected: number, label: string, key: "ArrowUp" | "ArrowDown") => {
      await act(async () => root.render(<HunkControls {...s.props} stepRef={stepRef} selectedHunk={s.id(selected)} />));
      const found = [...host.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
      expect(found).toHaveLength(1);
      await act(async () => {
        found[0]!.focus();
        // happy-dom reports AltGraph for every Alt key. A real Alt key has no AltGraph state (UI Events getModifierState).
        const down = new KeyboardEvent("keydown", { key, code: key, altKey: true, bubbles: true, cancelable: true });
        Object.defineProperty(down, "getModifierState", { value: () => false });
        found[0]!.dispatchEvent(down);
        found[0]!.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, altKey: true, bubbles: true, cancelable: true }));
      });
    };
    try {
      await alt(3, "Next hunk", "ArrowDown");
      await alt(1, "Previous hunk", "ArrowUp");
      expect(s.selected).toEqual([]);
      // Control: from hunk 2, the same keys select hunk 3 and hunk 1.
      await alt(2, "Next hunk", "ArrowDown");
      await alt(2, "Previous hunk", "ArrowUp");
      expect(s.selected).toEqual([s.id(3), s.id(1)]);
      expect(s.double.calls).toEqual([]);
    } finally {
      window.removeEventListener("keydown", onKey);
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
