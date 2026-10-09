// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/changes/ComparisonView.tsx", import.meta.dir);
registerDom();
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { ComparisonHeading, fitComparisonHeading } = await import("../../src/frontend/changes/ComparisonView");

// T145 waits for T117. A template path keeps `tsc` from resolving the module before it exists.
const NEEDS = "(needs T145)";
type Props = Record<string, unknown>;
type HunkModule = {
  HunkControls: (props: Props) => ReactNode;
  wrapHunkToolbar: (widths: Record<string, number>, width: number) => string[][];
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
    hunks: Array.from({ length: count }, (_, i) => ({ hunkId: crypto.randomUUID(), ordinal: i + 1, oldStart: 10 * i + 1, oldCount: 1, newStart: 10 * i + 1, newCount: 2, digest: String(i).repeat(64) })),
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
  const found = elements(root).filter((e) => typeof e.props.onClick === "function" && text(e).includes(label));
  expect(found).toHaveLength(1);
  (found[0]!.props.onClick as () => void)();
}

type Tag = { name: string; attrs: string; text: string; index: number };
// Opening tag, attributes, and plain text of each element of one kind. The checked elements hold no element of their own kind.
function tags(html: string, name: string): Tag[] {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`, "g"))].map((m) => ({ name, attrs: m[1]!, text: m[2]!.replace(/<[^>]+>/g, ""), index: m.index! }));
}
const attr = (tag: Tag, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag.attrs)?.[1];
function button(html: string, label: string): Tag {
  const found = tags(html, "button").filter((b) => b.text.includes(label));
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
const expectEnabled = (html: string, label: string) => {
  const b = button(html, label);
  expect(attr(b, "aria-disabled") ?? "false").toBe("false");
  expect(attr(b, "disabled")).toBeUndefined();
};

describe("hunk selection", () => {
  test.todo(`without a selection, Next hunk selects hunk 1 and Previous hunk selects hunk 3 ${NEEDS}`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const root = tree(() => HunkControls(s.props));
    click(root, "Next hunk");
    click(root, "Previous hunk");
    expect(s.selected).toEqual([s.id(1), s.id(3)]);
    expect(s.double.calls).toEqual([]);
  });

  test.todo(`with hunk 2 anchored after a hunk action, each of them selects hunk 2 ${NEEDS}`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const root = tree(() => HunkControls({ ...s.props, anchoredHunk: s.id(2) }));
    click(root, "Next hunk");
    click(root, "Previous hunk");
    expect(s.selected).toEqual([s.id(2), s.id(2)]);
  });

  test.todo(`with hunk 2 selected, Next hunk selects hunk 3 and Previous hunk selects hunk 1 ${NEEDS}`, async () => {
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

  test.todo(`at hunk 3, Next hunk is disabled with the visible reason and stays focusable ${NEEDS}`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const html = renderToStaticMarkup(<HunkControls {...s.props} selectedHunk={s.id(3)} />);
    expectFocusableDisabled(html, "Next hunk", "No next hunk");
    expectEnabled(html, "Previous hunk");
  });

  test.todo(`at hunk 1, Previous hunk is disabled with the visible reason and stays focusable ${NEEDS}`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const html = renderToStaticMarkup(<HunkControls {...s.props} selectedHunk={s.id(1)} />);
    expectFocusableDisabled(html, "Previous hunk", "No previous hunk");
    expectEnabled(html, "Next hunk");
  });

  test.todo(`in a one-hunk comparison with that hunk selected, both are disabled ${NEEDS}`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup({}, 1);
    const html = renderToStaticMarkup(<HunkControls {...s.props} selectedHunk={s.id(1)} />);
    expectFocusableDisabled(html, "Next hunk", "No next hunk");
    expectFocusableDisabled(html, "Previous hunk", "No previous hunk");
  });
});

describe("toolbar layout", () => {
  test.todo(`the toolbar holds Previous hunk, Next hunk, the hunk action, and the file-action slot, in that order ${NEEDS}`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const html = renderToStaticMarkup(<HunkControls {...s.props} fileAction={<button type="button">file action double</button>} />);
    const order = ["Previous hunk", "Next hunk", "Stage selected hunk", "file action double"].map((label) => button(html, label).index);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  test.todo(`Staged shows Unstage selected hunk ${NEEDS}`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup({ category: "staged" } as Partial<Props>);
    const html = renderToStaticMarkup(<HunkControls {...s.props} />);
    button(html, "Unstage selected hunk");
    expect(tags(html, "button").some((b) => b.text.includes("Stage selected hunk") && !b.text.includes("Unstage"))).toBe(false);
  });

  test.todo(`the toolbar owns one reason line below its buttons, on one line with an end ellipsis, and the disabled control takes it as its description ${NEEDS}`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup({ comparison: comparison(0, "binary") } as Partial<Props>);
    const html = renderToStaticMarkup(<HunkControls {...s.props} fileAction={<button type="button">file action double</button>} />);
    const action = button(html, "Stage selected hunk");
    expect(attr(action, "aria-disabled")).toBe("true");
    expect(attr(action, "disabled")).toBeUndefined();
    const reason = byId(html, attr(action, "aria-describedby")!);
    expect(reason.text.trim()).not.toBe("");
    expect(reason.index).toBeGreaterThan(button(html, "file action double").index);
    expect(attr(reason, "class")?.split(/\s+/)).toContain("truncate");
    // The 18/20 DIP reason line height (plan.md density table, T124 token).
    expect(reason.attrs).toContain("--h-reason-line");
  });

  test.todo(`the wrap function moves the file-action slot to the second row first, then the hunk action ${NEEDS}`, async () => {
    const { wrapHunkToolbar } = await hunkControls();
    const widths = { previous: 100, next: 100, hunkAction: 100, fileAction: 100 };
    expect(wrapHunkToolbar(widths, 450)).toEqual([["previous", "next", "hunkAction", "fileAction"]]);
    expect(wrapHunkToolbar(widths, 350)).toEqual([["previous", "next", "hunkAction"], ["fileAction"]]);
    expect(wrapHunkToolbar(widths, 250)).toEqual([["previous", "next"], ["hunkAction", "fileAction"]]);
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

  test("its accessible name holds the full path, scope, and sides, and it keeps the pane heading height", () => {
    const html = renderToStaticMarkup(<ComparisonHeading {...heading} />);
    const named = [...html.matchAll(/<(\w+)\b([^>]*)\saria-label="([^"]*)"/g)].find((m) => m[3]!.includes(path));
    expect(named).toBeDefined();
    expect(named![3]).toContain(heading.scope);
    expect(named![3]).toContain(heading.sides);
    // The 32/36 DIP pane heading height (plan.md density table, T124 token).
    expect(html.slice(0, html.indexOf(">"))).toContain("--h-pane-heading");
  });

  test("Copy path is a row button with a Tab stop that copies the full path", () => {
    const html = renderToStaticMarkup(<ComparisonHeading {...heading} />);
    const copy = button(html, "Copy path");
    expect(attr(copy, "tabindex")).not.toBe("-1");
    expect(attr(copy, "disabled")).toBeUndefined();
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
    click(tree(() => ComparisonHeading(heading)), "Copy path");
    expect(written).toEqual([path]);
  });

  test("the fit function shrinks the folder, then the file name, then the sides, then the scope, and never Copy path", () => {
    const parts = { copyPath: 80, folder: { full: 300, min: 20 }, file: { full: 100, min: 30 }, sides: { full: 120, min: 20 }, scope: { full: 100, min: 20 } };
    expect(fitComparisonHeading({ ...parts, width: 700 })).toEqual({ folder: 300, file: 100, sides: 120, scope: 100 });
    expect(fitComparisonHeading({ ...parts, width: 600 })).toEqual({ folder: 200, file: 100, sides: 120, scope: 100 });
    expect(fitComparisonHeading({ ...parts, width: 400 })).toEqual({ folder: 20, file: 80, sides: 120, scope: 100 });
    expect(fitComparisonHeading({ ...parts, width: 300 })).toEqual({ folder: 20, file: 30, sides: 70, scope: 100 });
    expect(fitComparisonHeading({ ...parts, width: 200 })).toEqual({ folder: 20, file: 30, sides: 20, scope: 50 });
    expect(fitComparisonHeading({ ...parts, width: 100 })).toEqual({ folder: 20, file: 30, sides: 20, scope: 20 });
  });

  // Alt+Up and Alt+Down reach the selection through the comparison pane and the T127 handler. The keys go to the focused hunk toolbar button.
  test.todo(`at hunk 3, Alt+Down selects nothing, and at hunk 1, Alt+Up selects nothing ${NEEDS}`, async () => {
    const { HunkControls } = await hunkControls();
    const s = setup();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const alt = async (selected: number, label: string, key: "ArrowUp" | "ArrowDown") => {
      await act(async () => root.render(<HunkControls {...s.props} selectedHunk={s.id(selected)} />));
      const found = [...host.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));
      expect(found).toHaveLength(1);
      await act(async () => {
        found[0]!.focus();
        found[0]!.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, altKey: true, bubbles: true, cancelable: true }));
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
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
