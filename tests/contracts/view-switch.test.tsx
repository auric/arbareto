// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
registerDom();
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { Workbench } = await import("../../src/frontend/app/Workbench");

// plan.md "Selection, scroll, and stored context". T128 takes the changes pane and the comparison view as injected components.
// A named operation answers with its response. Every other request stays pending.
function bridgeDouble(answers: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const bridge = new Proxy({}, { get: (_, name) => () => (calls.push(String(name)), String(name) in answers ? Promise.resolve(answers[String(name)]) : new Promise(() => {})) });
  return { bridge, calls };
}
const ChangesPaneDouble = () => <div>changes pane double</div>;
const ComparisonViewDouble = () => <div>comparison view double</div>;
const HistoryViewDouble = () => <div>history view double</div>;
// Docks the commit panel as a click on the Working directory row does.
const SelectingHistoryView = ({ onSelectRow }: { onSelectRow(id: string): void }) => (
  <button type="button" onClick={() => onSelectRow("working-directory")}>
    Select Working directory
  </button>
);

describe("View menu", () => {
  test("the menu bar holds the View menu, and rendering sends no bridge request", () => {
    const { bridge, calls } = bridgeDouble();
    const html = renderToStaticMarkup(<Workbench bridge={bridge as never} ChangesPane={ChangesPaneDouble} ComparisonView={ComparisonViewDouble} HistoryView={HistoryViewDouble} />);
    const menubar = html.indexOf('role="menubar"');
    expect(menubar).toBeGreaterThanOrEqual(0);
    expect(html.slice(menubar)).toMatch(/<button[^>]*role="menuitem"[^>]*>View<\/button>/);
    expect(calls).toEqual([]);
  });
});

// The doubles hold the selected entry and the selected hunk in their own state. A remount loses that state and counts one more mount.
const mounts = { changes: 0, comparison: 0 };
function SelectingChangesPane() {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => void (mounts.changes += 1), []);
  return (
    <div data-double="changes">
      <button type="button" onClick={() => setSelected("src/a.ts")}>
        Select src/a.ts
      </button>
      <span>{selected === null ? "No entry selected" : `Selected Unstaged entry ${selected}`}</span>
    </div>
  );
}
function HunkComparisonView() {
  const [hunk, setHunk] = useState<number | null>(null);
  useEffect(() => void (mounts.comparison += 1), []);
  return (
    <div data-double="comparison">
      <button type="button" onClick={() => setHunk(2)}>
        Select hunk 2
      </button>
      <span>{hunk === null ? "No hunk selected" : `Selected hunk ${hunk}`}</span>
    </div>
  );
}

// Contract §3 `chooseRepository`: the folder dialog was accepted, and the repository is registered.
const registered = () => ({
  requestId: crypto.randomUUID(),
  state: "succeeded",
  result: { repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "a".repeat(64) },
});
// index.css: `data-theme` absent means System, and `data-density` absent means Compact.
// plan.md "Dark palettes": View ▸ Theme ▸ System, Light, and Dark ▸ Graphite, Ink, Warm dark. A palette choice selects Dark too.
const CHOICES = [
  { path: ["Theme", "Light"], attribute: "data-theme", value: "light" },
  { path: ["Theme", "Dark", "Graphite"], attribute: "data-theme", value: "dark" },
  { path: ["Theme", "System"], attribute: "data-theme", value: null },
  { path: ["Comfortable"], attribute: "data-density", value: "comfortable" },
  { path: ["Compact"], attribute: "data-density", value: null },
] as const;
const DRAFT = "Fix the parser\n\nKeep the caret here.";
const CARET = 9;

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
  document.documentElement.removeAttribute("data-dark-palette");
});

// Let the injected responses settle and React commit.
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
const text = (element: Element) => (element.textContent ?? "").trim();
function named(selector: string, label: string, from: ParentNode = document): HTMLElement[] {
  return [...from.querySelectorAll<HTMLElement>(selector)].filter((e) => (e.getAttribute("aria-label") ?? text(e)).includes(label));
}
function one(selector: string, label: string): HTMLElement {
  const found = named(selector, label);
  expect(found).toHaveLength(1);
  return found[0]!;
}
async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }));
  });
  await settle();
}

// Opens a repository from the start page, docks the commit panel, and selects an Unstaged entry with its shown comparison and hunk 2.
async function openChanges() {
  const double = bridgeDouble({ chooseRepository: registered() });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<Workbench bridge={double.bridge as never} ChangesPane={SelectingChangesPane} ComparisonView={HunkComparisonView} HistoryView={SelectingHistoryView} />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await click(one('section[aria-label="Start page"] [role="option"]', "Open folder"));
  await click(one("button", "Select Working directory"));
  await click(one("button", "Select src/a.ts"));
  await click(one("button", "Select hunk 2"));
  const field = document.querySelector("textarea");
  return { double, field, changes: document.querySelector('[data-double="changes"]'), comparison: document.querySelector('[data-double="comparison"]'), counts: { ...mounts } };
}

// A menu item by its visible label. "System" also matches "System (dark: <palette>)".
function menuItem(label: string): HTMLElement {
  const menubar = document.querySelector('[role="menubar"]')!;
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')].filter(
    (e) => !menubar.contains(e) && (text(e) === label || text(e).startsWith(`${label} (`) || text(e).startsWith(`${label}, `)),
  );
  expect(found.map(text)).toHaveLength(1);
  return found[0]!;
}

async function openView() {
  const menubar = document.querySelector('[role="menubar"]');
  expect(menubar).not.toBeNull();
  const view = named('[role="menuitem"]', "View", menubar!).filter((e) => text(e) === "View");
  expect(view).toHaveLength(1);
  await act(async () => view[0]!.focus());
  await click(view[0]!);
}

// Chooses one View menu item along its submenu path with the pointer, then closes the menus with Escape.
async function choose(path: readonly string[]) {
  await openView();
  for (const label of path) await click(menuItem(label));
  while (document.querySelector('[data-slot="menubar-content"], [data-slot="menubar-sub-content"]') && document.activeElement && document.activeElement !== document.body) await press(document.activeElement, "Escape");
}

const selectedEntry = () => named("span", "Selected Unstaged entry src/a.ts");
const selectedHunk = () => named("span", "Selected hunk 2");

describe("View menu choices", () => {
  test("Light, Dark, and System from the View menu each change the root theme attribute and keep the selected entry", async () => {
    const w = await openChanges();
    for (const c of CHOICES.filter((c) => c.attribute === "data-theme")) {
      await choose(c.path);
      expect(document.documentElement.getAttribute("data-theme")).toBe(c.value);
      expect(selectedEntry()).toHaveLength(1);
      expect(mounts.changes).toBe(w.counts.changes);
    }
  });

  test("Comfortable and Compact from the View menu each change the root density attribute and keep the selected entry", async () => {
    const w = await openChanges();
    for (const c of CHOICES.filter((c) => c.attribute === "data-density")) {
      await choose(c.path);
      expect(document.documentElement.getAttribute("data-density")).toBe(c.value);
      expect(selectedEntry()).toHaveLength(1);
      expect(mounts.changes).toBe(w.counts.changes);
    }
  });

  // plan.md "Dark palettes": Theme ▸ Dark ▸ palette. A palette choice selects Dark and that palette in one step.
  test("each palette under Dark selects the Dark theme and that palette in one step from any theme, keeps the selected entry, and sends no bridge request", async () => {
    const w = await openChanges();
    for (const [from, palette, value] of [[["Theme", "Light"], "Ink", "ink"], [["Theme", "System"], "Warm dark", "warm"], [["Theme", "Light"], "Graphite", null]] as const) {
      await choose(from);
      const before = w.double.calls.length;
      await choose(["Theme", "Dark", palette]);
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(document.documentElement.getAttribute("data-dark-palette")).toBe(value);
      expect(selectedEntry()).toHaveLength(1);
      expect(w.double.calls.slice(before)).toEqual([]);
    }
    const stored = JSON.parse(localStorage.getItem("arbareto.preferences.v1")!);
    expect([stored.theme, stored.darkPalette]).toEqual(["dark", "graphite"]);
  });

  test("System names the palette it uses when Windows is dark, Light names none, and the Theme submenu holds no palette item outside Dark", async () => {
    await openChanges();
    await choose(["Theme", "Dark", "Ink"]);
    await choose(["Theme", "Light"]);
    await openView();
    await click(menuItem("Theme"));
    const theme = document.querySelectorAll<HTMLElement>('[data-slot="menubar-sub-content"]');
    expect(theme).toHaveLength(1);
    const labels = [...theme[0]!.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].map(text);
    expect(labels).toEqual(["System (dark: Ink)", "Light", "Dark"]);
    for (const palette of ["Graphite", "Ink", "Warm dark"]) expect(labels).not.toContain(palette);
    // Exactly one of System, Light, and Dark is checked.
    expect([...theme[0]!.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')].map(text)).toEqual(["Light"]);
    expect(menuItem("Dark").getAttribute("data-checked")).toBeNull();
    await click(menuItem("Dark"));
    const dark = document.querySelectorAll<HTMLElement>('[data-slot="menubar-sub-content"]');
    expect(dark).toHaveLength(2);
    expect([...dark[1]!.querySelectorAll('[role="menuitemradio"]')].map((e) => [text(e), e.getAttribute("aria-checked")])).toEqual([
      ["Graphite", "false"],
      ["Ink", "true"],
      ["Warm dark", "false"],
    ]);
    await press(document.activeElement!, "Escape");
  });

  test("with the Dark theme, the Theme submenu checks Dark and no other item", async () => {
    await openChanges();
    await choose(["Theme", "Dark", "Warm dark"]);
    await openView();
    await click(menuItem("Theme"));
    expect([...document.querySelectorAll('[data-slot="menubar-sub-content"] [role="menuitemradio"][aria-checked="true"]')]).toHaveLength(0);
    expect(menuItem("Dark").getAttribute("data-checked")).toBe("true");
    expect(text(menuItem("Dark"))).toBe("Dark, Warm dark");
    await press(document.activeElement!, "Escape");
  });

  test("the submenus open with ArrowRight and close with ArrowLeft", async () => {
    await openChanges();
    await openView();
    const theme = menuItem("Theme");
    await act(async () => theme.focus());
    await press(theme, "ArrowRight");
    expect(document.querySelectorAll('[data-slot="menubar-sub-content"]')).toHaveLength(1);
    const dark = menuItem("Dark");
    await act(async () => dark.focus());
    await press(dark, "ArrowRight");
    expect(document.querySelectorAll('[data-slot="menubar-sub-content"]')).toHaveLength(2);
    await press(document.activeElement!, "ArrowLeft");
    expect(document.querySelectorAll('[data-slot="menubar-sub-content"]')).toHaveLength(1);
    await press(document.activeElement!, "Escape");
  });

  test("a theme or density choice sends no bridge request", async () => {
    const w = await openChanges();
    for (const c of CHOICES) {
      const before = w.double.calls.length;
      await choose(c.path);
      expect(w.double.calls.slice(before)).toEqual([]);
    }
  });

  test("a theme or density choice keeps the component key of the comparison, so it does not remount", async () => {
    const w = await openChanges();
    expect(w.comparison).not.toBeNull();
    for (const c of CHOICES) {
      await choose(c.path);
      expect(mounts.comparison).toBe(w.counts.comparison);
      expect(w.comparison!.isConnected).toBe(true);
      expect(w.changes!.isConnected).toBe(true);
    }
  });

  // T148 cases: they need T145 and T146. The composer is the real T146 tray, so its message field is the only textarea.
  async function withDraft() {
    const w = await openChanges();
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
    const field = w.field!;
    await act(async () => {
      field.focus();
      // The prototype setter bypasses the React value tracker, so React sees one input event.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, DRAFT);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.setSelectionRange(CARET, CARET);
    });
    expect(field.value).toBe(DRAFT);
    return { ...w, field };
  }

  test(`a theme or density choice keeps the draft text, the caret offset, and the selected hunk`, async () => {
    const w = await withDraft();
    for (const c of CHOICES) {
      await act(async () => w.field.focus());
      await choose(c.path);
      expect(w.field.value).toBe(DRAFT);
      expect([w.field.selectionStart, w.field.selectionEnd]).toEqual([CARET, CARET]);
      expect(selectedHunk()).toHaveLength(1);
    }
  });

  test(`after the menu closes, the reported focus target is the message field again`, async () => {
    const w = await withDraft();
    for (const c of CHOICES) {
      await act(async () => w.field.focus());
      await choose(c.path);
      expect(document.activeElement).toBe(w.field);
    }
  });

  test(`a theme or density choice keeps the component key of the composer, so it does not remount`, async () => {
    const w = await withDraft();
    for (const c of CHOICES) {
      await choose(c.path);
      expect(w.field.isConnected).toBe(true);
      expect(document.querySelector("textarea")).toBe(w.field);
    }
  });
});
