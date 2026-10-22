// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Copy01Icon, Delete02Icon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { act, useEffect, useRef, useState, type ReactNode } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { stubLayout } from "./history-fake";
import { readFileSync } from "node:fs";
import { button, click, createWorld, keyboardFocus, mountWorkbench, oid, press, settle, snapshot, succeeded, text, tooltipText, unmountAll } from "./sync-fake";
import { contractChecked, fixtureId } from "./bridge-contract";

// tasks.md T037 (feature 004, WP11). Stories US1 to US4. Spec FR-033, FR-068, FR-085, FR-086. Plan D15, D16. Data-model §14. Contract Δ8.

printOrigin("../../src/frontend/app/Workbench.tsx", import.meta.dir);
printOrigin("../../src/frontend/state/workbench.ts", import.meta.dir);
printOrigin("../../src/frontend/components/switcher-popover.tsx", import.meta.dir);
printOrigin("../../src/frontend/components/action-menu.tsx", import.meta.dir);
printOrigin("../../src/frontend/components/confirm-popover.tsx", import.meta.dir);
printOrigin("../../src/frontend/components/docked-panel.tsx", import.meta.dir);
printOrigin("../../src/frontend/components/segmented.tsx", import.meta.dir);
mock.module("../../src/frontend/changes/PatchPool", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
mock.module("../../src/frontend/changes/PatchView", () => ({ default: ({ patch }: { patch: string }) => <pre>{patch}</pre> }));
registerDom();
const { createRoot } = await import("react-dom/client");
const workbench = await import("../../src/frontend/app/Workbench");
const { createWorkbench } = await import("../../src/frontend/state/workbench");
const { SwitcherPopover } = await import("../../src/frontend/components/switcher-popover");
const { ActionMenu } = await import("../../src/frontend/components/action-menu");
const { ConfirmPopover } = await import("../../src/frontend/components/confirm-popover");
const { DockedPanel, DockRegion } = await import("../../src/frontend/components/docked-panel");
const { Button } = await import("../../src/frontend/components/ui/button");

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

/** The accessible name of an element without `aria-label`: its text without the `aria-hidden` parts. */
function accessibleName(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label !== null) return label;
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return text(copy);
}
const shown = (element: Element | null) => element !== null && element.closest("[hidden]") === null;
const header = () => document.querySelector('header[data-section="header"]')!;
const views = () => header().querySelector('nav[aria-label="Views"]');
const historySection = () => document.querySelector('section[aria-label="History"]');
const commitView = () => document.querySelector('section[aria-label="Commit view"]');
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
const openItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')].filter((e) => !e.closest('[role="menubar"]'));
async function openMenubar(name: string) {
  const trigger = [...document.querySelectorAll<HTMLElement>('[role="menubar"] [role="menuitem"]')].find((e) => text(e) === name)!;
  await act(async () => trigger.focus());
  await click(trigger);
}
/** The constrained profile collapses the references section. */
async function showReferences() {
  const toggle = document.querySelector<HTMLElement>('button[aria-label="Show references"]');
  if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
}
async function closeMenus() {
  while (document.querySelector('[data-slot="menubar-content"], [data-slot="dropdown-menu-content"]') && document.activeElement && document.activeElement !== document.body) await press(document.activeElement, "Escape");
}

describe("views (FR-033, FR-068, data-model §14)", () => {
  test("the store keeps one view per worktree, and Settings returns to the earlier view", () => {
    const store = createWorkbench({ bridge: contractChecked({ readBranches: () => new Promise(() => {}) }), target: () => null, mutationEnded: async () => {}, refreshHistory: () => {} });
    expect(store.view("a")).toBe("history");
    store.setView("a", "commit");
    expect(store.view("a")).toBe("commit");
    expect(store.view("b")).toBe("history");
    store.setView("a", "settings");
    expect(store.view("a")).toBe("settings");
    store.closeSettings("a");
    expect(store.view("a")).toBe("commit");
    store.setView("b", "settings");
    store.closeSettings("b");
    expect(store.view("b")).toBe("history");
    // Spec FR-093: the resolve view opens Settings on the page Editor and tools. A later open has no page.
    store.setView("a", "settings", { page: "Editor and tools" });
    expect(store.settingsPage("a")).toBe("Editor and tools");
    store.closeSettings("a");
    expect(store.settingsPage("a")).toBeUndefined();
    store.setView("a", "settings");
    expect(store.settingsPage("a")).toBeUndefined();
  });

  test("the History and Commit control switches the view, has no key, and every view keeps the top bar and the status bar", async () => {
    await mountWorkbench(workbench, createWorld());
    const nav = views();
    expect(nav).not.toBeNull();
    const [history, commit] = [button("History", nav!), button("Commit", nav!)];
    for (const b of [history, commit]) expect(b.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(history.getAttribute("aria-current")).toBe("page");
    expect(shown(historySection())).toBe(true);
    expect(commitView()).toBeNull();
    await click(commit);
    expect(commit.getAttribute("aria-current")).toBe("page");
    expect(history.hasAttribute("aria-current")).toBe(false);
    expect(shown(historySection())).toBe(false);
    expect(shown(commitView())).toBe(true);
    // FR-033: the Commit view has no references sidebar.
    expect(shown(document.querySelector('[data-section="references"]'))).toBe(false);
    expect(shown(commitView()!.querySelector('[data-section="workingChanges"]'))).toBe(true);
    expect(shown(header())).toBe(true);
    expect(shown(document.querySelector("footer"))).toBe(true);
    await click(history);
    expect(shown(historySection())).toBe(true);
    expect(commitView()).toBeNull();
  });

  test("View ▸ Settings… opens the Settings view with the top bar and the status bar, and Close returns to the earlier view (FR-068)", async () => {
    await mountWorkbench(workbench, createWorld());
    await click(button("Commit", views()!));
    await openMenubar("View");
    const item = openItems().find((e) => accessibleName(e) === "Settings…");
    expect(item).toBeDefined();
    await click(item!);
    await closeMenus();
    const page = document.querySelector('[data-section="pageContent"]');
    expect(shown(page)).toBe(true);
    // WP22: the view heading sits in the scope bar, the first Settings section (plan D15 F6 order).
    expect(document.querySelector('[data-view="settings"] [data-section="scopeBar"] h2')).not.toBeNull();
    expect(shown(commitView())).toBe(false);
    expect(shown(header())).toBe(true);
    expect(shown(document.querySelector("footer"))).toBe(true);
    // Plan D15 keyboard map: Ctrl+F focuses Find a setting in the Settings view.
    await press(window, "f", { ctrlKey: true });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Find a setting");
    await click(button("Close settings"));
    expect(document.querySelector('[data-section="pageContent"]')).toBeNull();
    expect(shown(commitView())).toBe(true);
  });

  test("the top bar order follows plan.md D15", async () => {
    await mountWorkbench(workbench, createWorld());
    const bar = header();
    const parts = [
      bar.querySelector('[aria-keyshortcuts="Control+R"]'),
      bar.querySelector('[data-slot="branch-text"]'),
      bar.querySelector('[role="group"][aria-label="Remote sync"] [data-sync-slot="fetch"]'),
      bar.querySelector('[data-sync-slot="pull"]'),
      bar.querySelector('[data-sync-slot="push"]'),
      bar.querySelector('nav[aria-label="Views"]'),
      bar.querySelector('[role="menubar"]'),
      bar.querySelector('button[aria-label="Refresh"]'),
      bar.querySelector('button[aria-label^="Commit: "]'),
    ];
    for (const part of parts) expect(part).not.toBeNull();
    for (let i = 1; i < parts.length; i++) expect(parts[i - 1]!.compareDocumentPosition(parts[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The flex `order` of the top bar items never moves an item before an earlier one.
    const orders = [...bar.children].map((child) => Number((child as HTMLElement).style.order || 0));
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // Plan D16: the segmented parts are standard buttons, 28 px in the compact density.
    for (const part of bar.querySelectorAll<HTMLElement>('nav[aria-label="Views"] button')) expect(part.style.height).toBe("var(--h-button)");
  });

  test("the top bar wraps only when its controls do not fit (T115), and the repository button shows the folder name only, with the full path in its tooltip and accessible name (T087)", async () => {
    const root = "C:\\Users\\sample\\AppData\\Local\\Temp\\a-long-sample-folder-name-that-fills-the-top-bar\\nested\\deeper\\sample-repo";
    const world = createWorld();
    world.answers.readWorkspace = () => {
      const shot = snapshot(world);
      return succeeded({ ...shot, identity: { ...shot.identity, worktreeRoot: root } });
    };
    await mountWorkbench(workbench, world);
    // Plan D15 "Top bar row" (T115): the header is one row while its controls fit, and wraps when they do not. The DOM test has no layout, so it checks the wrap only.
    expect(header().className.split(/\s+/)).toContain("flex-wrap");
    const repository = header().querySelector<HTMLElement>('[aria-keyshortcuts="Control+R"]')!;
    expect(text(repository)).toBe("sample-repo");
    expect(repository.getAttribute("aria-label")).toBe(`sample-repo, ${root}`);
    await keyboardFocus(repository);
    expect(tooltipText()).toContain(root);
  });

  test("the repository tooltip stacks the path over its key text, and a path without break points wraps anywhere (T087 review)", async () => {
    const root = `C:\${"x".repeat(300)}\sample-repo`;
    const world = createWorld();
    world.answers.readWorkspace = () => {
      const shot = snapshot(world);
      return succeeded({ ...shot, identity: { ...shot.identity, worktreeRoot: root } });
    };
    await mountWorkbench(workbench, world);
    await keyboardFocus(header().querySelector<HTMLElement>('[aria-keyshortcuts="Control+R"]')!);
    const content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
    expect(content.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex-col", "items-start"]));
    const path = [...content.querySelectorAll("span")].find((e) => e.textContent === root)!;
    expect(path.className.split(/\s+/)).toContain("[overflow-wrap:anywhere]");
    expect(text(content)).toBe(`${root} Recent repositories (Ctrl+R)`);
  });
});

describe("constrained sidebar (plan.md D15 P2 regions, T112)", () => {
  test("the Submodules group sits inside the references section, shows only while it is expanded, and the section scrolls as one region", async () => {
    await mountWorkbench(workbench, createWorld({ operationState: "merging" }));
    expect(document.querySelector<HTMLElement>("[data-profile]")!.dataset.profile).toBe("constrained");
    const section = document.querySelector<HTMLElement>('[data-section="references"]')!;
    // 001 plan.md "References sidebar": collapsed, the section holds only its heading row, so no group draws over the history list.
    expect(document.querySelector('[data-slot="submodules-group"]')).toBeNull();
    // 001 plan.md "Section minima": the sidebar scrolls inside its own bounds, so the heading and the filter never leave the groups at 0 height.
    expect(section.className.split(/\s+/)).toContain("overflow-y-auto");
    expect(section.className.split(/\s+/)).not.toContain("flex");
    await showReferences();
    const group = document.querySelector('[data-slot="submodules-group"]');
    expect(group === null).toBe(false);
    expect(group!.closest("[data-references-scroll]") === null).toBe(false);
  });
  test("with 5,000 branches, the expanded tree keeps a bounded scroll region, so the rendered row count stays bounded and the first rows show", async () => {
    const head = oid(1);
    const branches = [
      { name: "main", objectId: head, upstream: null, upstreamObjectId: null, track: { state: "none" } as const, current: true },
      ...Array.from({ length: 4_999 }, (_, i) => ({ name: `branch-${String(i).padStart(5, "0")}`, objectId: head, upstream: null, upstreamObjectId: null, track: { state: "none" } as const, current: false })),
    ];
    await mountWorkbench(workbench, createWorld({ branches }));
    expect(document.querySelector<HTMLElement>("[data-profile]")!.dataset.profile).toBe("constrained");
    await showReferences();
    await settle();
    const section = document.querySelector<HTMLElement>('[data-section="references"]')!;
    // tasks.md T114: the section is the only scroll region of the tree. The virtual tree uses it as its scroll element, so the wheel never stops at a nested scroller.
    expect(section.style.maxHeight).not.toBe("");
    expect(section.hasAttribute("data-references-scroll")).toBe(true);
    expect(section.querySelector("[data-references-scroll]") === null).toBe(true);
    const tree = section.querySelector<HTMLElement>('[role="tree"]')!;
    for (let at = tree.parentElement; at !== null && at !== section; at = at.parentElement) {
      expect(at.className.split(/\s+/)).not.toContain("overflow-y-auto");
      expect(at.style.maxHeight).toBe("");
    }
    const items = [...section.querySelectorAll('[role="treeitem"]')];
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(80);
    expect(items[0]!.getAttribute("aria-label")!.startsWith("Branches")).toBe(true);
    // The case renders 5,000 branches in happy-dom and takes 4 to 6 s, above the 5 s Bun default.
  }, 30_000);
});

describe("switcher popover (plan.md D15)", () => {
  const ITEMS = ["main", "feature/Login", "fix.x", "fixAx", "release"];
  function Switcher({ onPick, startOpen = true }: { onPick(item: string): void; startOpen?: boolean }) {
    const [open, setOpen] = useState(startOpen);
    return (
      <SwitcherPopover
        open={open}
        onOpenChange={setOpen}
        trigger={<Button aria-label="Branch main. Switch branch" />}
        tooltip="Switch branch"
        filterLabel="Filter branches"
        listLabel="Branches"
        rowHeight={26}
        headingHeight={26}
        items={ITEMS}
        itemKey={(item) => item}
        itemText={(item) => item}
        renderItem={(item) => item}
        onPick={(item) => {
          onPick(item);
          setOpen(false);
        }}
        footer={{ label: "New branch… (Ctrl+B)", onPick: () => onPick("new") }}
        emptyText="No branches."
        noMatchText="No branch matches the filter."
      >
        main
      </SwitcherPopover>
    );
  }
  const filter = () => document.querySelector<HTMLInputElement>('input[aria-label="Filter branches"]')!;
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Branches"] [role="option"]')].map(accessibleName);

  test("the filter field has the first focus, filters by a literal case-insensitive substring, and Enter picks the first match", async () => {
    const picked: string[] = [];
    await render(<Switcher onPick={(item) => picked.push(item)} />);
    expect(document.activeElement).toBe(filter());
    expect(options()).toEqual([...ITEMS, "New branch… (Ctrl+B)"]);
    await type(filter(), "LOGIN");
    expect(options()).toEqual(["feature/Login", "New branch… (Ctrl+B)"]);
    // A literal match: "." is no pattern character.
    await type(filter(), "fix.x");
    expect(options()).toEqual(["fix.x", "New branch… (Ctrl+B)"]);
    await type(filter(), "i");
    expect(filter().getAttribute("aria-activedescendant")).toBe(document.querySelector('[role="option"]')!.id);
    await press(filter(), "Enter");
    expect(picked).toEqual(["main"]);
  });

  test("Escape closes the popover and returns focus to the button", async () => {
    await render(<Switcher onPick={() => {}} />);
    await press(filter(), "Escape");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(accessibleName(document.activeElement!)).toBe("Branch main. Switch branch");
  });
});

describe("action menu (FR-014, FR-085, plan.md D15, D16)", () => {
  const REASON = "Test reason: this item cannot run.";
  function Menu({ ran }: { ran: string[] }) {
    const [open, setOpen] = useState(false);
    return (
      <ActionMenu
        label="Branch actions"
        open={open}
        onOpenChange={setOpen}
        trigger={<Button>Actions</Button>}
        groups={[
          [
            { label: "Switch", icon: GitBranchIcon, keys: { aria: "Control+.", text: "Ctrl+." }, onSelect: () => ran.push("switch") },
            { label: "Delete…", icon: Delete02Icon, keys: { aria: "Delete", text: "Del" }, reason: REASON, danger: true, onSelect: () => ran.push("delete") },
          ],
          [{ label: "Copy branch name", icon: Copy01Icon, onSelect: () => ran.push("copy") }],
        ]}
      />
    );
  }

  test("each item is named by its label only, gives its key in aria-keyshortcuts, and hides the key column", async () => {
    await render(<Menu ran={[]} />);
    await click(button("Actions"));
    const items = openItems();
    expect(items.map(accessibleName)).toEqual(["Switch", "Delete…", "Copy branch name"]);
    expect(items.map((e) => e.getAttribute("aria-keyshortcuts"))).toEqual(["Control+.", "Delete", null]);
    for (const item of items.slice(0, 2)) {
      const key = item.querySelector('[data-slot="dropdown-menu-shortcut"]')!;
      expect(key.getAttribute("aria-hidden")).toBe("true");
    }
    expect(text(items[0]!.querySelector('[data-slot="dropdown-menu-shortcut"]')!)).toBe("Ctrl+.");
  });

  test("an unavailable item stays focusable, states its reason inline, uses the danger text, and runs nothing", async () => {
    const ran: string[] = [];
    await render(<Menu ran={ran} />);
    await click(button("Actions"));
    const item = openItems().find((e) => accessibleName(e) === "Delete…")!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("data-danger")).toBe("true");
    await act(async () => item.focus());
    expect(document.activeElement).toBe(item);
    const reason = document.getElementById(item.getAttribute("aria-describedby")!);
    expect(reason).not.toBeNull();
    expect(text(reason!)).toBe(REASON);
    expect(shown(reason)).toBe(true);
    await click(item);
    expect(ran).toEqual([]);
    await click(openItems().find((e) => accessibleName(e) === "Switch")!);
    expect(ran).toEqual(["switch"]);
  });

  test("each item shows a 16 px icon before its label, and an unavailable item shows its Muted reason on its line before the key column (D16, T089)", async () => {
    await render(<Menu ran={[]} />);
    await click(button("Actions"));
    for (const item of openItems()) {
      const icon = item.firstElementChild!;
      expect(icon.getAttribute("data-slot")).toBe("menu-icon");
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(icon.querySelector("svg")?.getAttribute("class")).toContain("size-4");
    }
    const item = openItems().find((e) => accessibleName(e) === "Delete…")!;
    const reason = document.getElementById(item.getAttribute("aria-describedby")!)!;
    expect(item.contains(reason)).toBe(true);
    expect(reason.className.split(/\s+/)).toContain("text-muted-text");
    expect(reason.getAttribute("aria-hidden")).toBe("true");
    const key = item.querySelector('[data-slot="dropdown-menu-shortcut"]')!;
    expect(reason.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The reason stays on the item line. It wraps only beyond the menu width cap.
    expect(reason.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-w-0", "whitespace-normal"]));
  });

  test("a 120-character branch name keeps the label and the reason inside the menu: the menu caps its width, and the texts wrap (D16, T089 review)", async () => {
    const name = `feature/${"x".repeat(112)}`;
    expect(name).toHaveLength(120);
    await render(
      <ActionMenu
        label={`Actions for ${name}`}
        open
        onOpenChange={() => {}}
        trigger={<Button>Actions</Button>}
        groups={[[{ label: `Rebase current branch (${name}) onto ${name}…`, reason: `${name} is the current branch. Select another branch to rebase onto.`, onSelect: () => {} }]]}
      />,
    );
    const content = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')!;
    expect(content.className.split(/\s+/)).toContain("max-w-[calc(100vw-32px)]");
    const item = openItems()[0]!;
    const reason = item.querySelector<HTMLElement>('[data-slot="menu-reason"]')!;
    const label = item.querySelector<HTMLElement>('[data-slot="menu-label"]')!;
    for (const part of [label, reason]) {
      const classes = part.className.split(/\s+/);
      expect(classes).toEqual(expect.arrayContaining(["min-w-0", "whitespace-normal", "[overflow-wrap:anywhere]"]));
      expect(classes).not.toContain("whitespace-nowrap");
    }
  });

  test("the focus outline marks only the focused item, 2 px inside it, and never the whole menu (D16, T089)", () => {
    const css = readFileSync(printOrigin("../../src/frontend/index.css", import.meta.dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.replace(/\s+/g, " ").trim(), body: m[2]!.replace(/\s+/g, " ").trim() }));
    const popup = rules.find((r) => r.selector.includes('[data-slot="dropdown-menu-content"]') && r.selector.includes('[data-slot="menubar-content"]') && r.selector.endsWith(":focus-visible"));
    expect(popup?.body).toBe("outline: none;");
    const items = rules.find((r) => r.selector.includes('[role="menuitem"]') && r.selector.endsWith(":focus-visible"));
    expect(items?.body).toBe("outline-offset: calc(-1 * var(--focus-width));");
  });

  test("in forced colors, a tooltip has a 1 px CanvasText edge like a dialog (D16, T118)", () => {
    const css = readFileSync(printOrigin("../../src/frontend/index.css", import.meta.dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    const rules = [...forced.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.replace(/\s+/g, " ").trim(), body: m[2]!.replace(/\s+/g, " ").trim() }));
    const edge = rules.find((r) => r.selector.split(",").map((s) => s.trim()).includes('[data-slot="tooltip-content"]'));
    expect(edge?.body).toBe("outline: 1px solid CanvasText;");
  });

  test("a row opens its menu beside the row, so the row stays visible (D16, T089)", async () => {
    function RowMenu() {
      const [row, setRow] = useState<HTMLElement | null>(null);
      return (
        <>
          <div ref={setRow}>login-form</div>
          {row === null ? null : <ActionMenu label="Actions for login-form" groups={[[{ label: "Switch", onSelect: () => {} }]]} open anchor={row} onOpenChange={() => {}} />}
        </>
      );
    }
    await render(<RowMenu />);
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')?.getAttribute("data-side")).toBe("inline-end");
  });

  test("selectable text keeps the built-in menu with Copy, unless the element opens its own action menu", async () => {
    await mountWorkbench(workbench, createWorld());
    const fire = (target: Element) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    // A stand-in for the commit details, a diff, or Git output inside the window.
    const region = document.querySelector("main")!.appendChild(document.createElement("div"));
    region.className = "select-text";
    const line = region.appendChild(document.createElement("span"));
    line.textContent = "Selectable line";
    const row = region.appendChild(document.createElement("div"));
    row.addEventListener("contextmenu", (event) => event.preventDefault());
    expect(fire(line)).toBe(false);
    expect(fire(region)).toBe(false);
    expect(fire(row)).toBe(true);
    // Outside a `.select-text` region the page still cancels the event.
    expect(fire(document.querySelector("main")!)).toBe(true);
    region.remove();
  });

  test("the page calls preventDefault on contextmenu outside editable fields", async () => {
    await mountWorkbench(workbench, createWorld());
    await showReferences();
    const fire = (target: Element) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire(header())).toBe(true);
    expect(fire(document.querySelector("footer")!)).toBe(true);
    expect(fire(document.querySelector('input[aria-label="Filter references"]')!)).toBe(false);
  });
});

describe("001 and 002 menu item names (FR-085, plan.md D15, O-18)", () => {
  function expectNamed(label: string, keys: string) {
    const item = openItems().find((e) => accessibleName(e) === label);
    expect(item).toBeDefined();
    expect(item!.getAttribute("aria-keyshortcuts")).toBe(keys);
    const key = item!.querySelector('[data-slot$="shortcut"]');
    expect(key).not.toBeNull();
    expect(key!.getAttribute("aria-hidden")).toBe("true");
  }

  test("the Repository menu items carry their label as name and their key in aria-keyshortcuts", async () => {
    await mountWorkbench(workbench, createWorld());
    await openMenubar("Repository");
    expectNamed("Open folder…", "Control+O");
    expectNamed("Recent repositories", "Control+R");
  });

  test("the View menu item Current branch only carries its label as name", async () => {
    await mountWorkbench(workbench, createWorld());
    await openMenubar("View");
    expectNamed("Current branch only", "Control+Shift+B");
  });

  test("the 002 branch menu item carries its label as name", async () => {
    await mountWorkbench(workbench, createWorld());
    await showReferences();
    const row = [...document.querySelectorAll<HTMLElement>('[data-section="references"] [role="treeitem"]')].find((e) => accessibleName(e).startsWith("main, "))!;
    expect(row).toBeDefined();
    await act(async () => void row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await settle();
    expectNamed("Show only this branch's history", "Control+Shift+B");
  });
});

describe("confirm popover (plan.md D15)", () => {
  function Confirm({ log }: { log: string[] }) {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => setOpen(true), []);
    return (
      <>
        <button ref={anchor} type="button">
          feature/login
        </button>
        <ConfirmPopover
          open={open}
          anchor={anchor.current}
          title="Switch to feature/login?"
          confirmLabel="Switch"
          onConfirm={() => log.push("confirm")}
          onCancel={() => {
            log.push("cancel");
            setOpen(false);
          }}
        />
      </>
    );
  }

  test("Cancel has the first focus, the title names the dialog, and Escape cancels", async () => {
    const log: string[] = [];
    await render(<Confirm log={log} />);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(text(document.getElementById(dialog.getAttribute("aria-labelledby")!)!)).toBe("Switch to feature/login?");
    expect(accessibleName(document.activeElement!)).toBe("Cancel");
    await click(button("Switch", dialog));
    expect(log).toEqual(["confirm"]);
    await press(document.activeElement!, "Escape");
    expect(log).toEqual(["confirm", "cancel"]);
  });
});

describe("docked panel (plan.md D15)", () => {
  function Dock({ log, reason = null }: { log: string[]; reason?: string | null }) {
    const [open, setOpen] = useState(false);
    const mounts = useRef(0);
    function Details() {
      useEffect(() => void (mounts.current += 1, log.push(`mount ${mounts.current}`)), []);
      return (
        <div data-testid="details">
          <button type="button" onClick={() => setOpen(true)}>
            Merge…
          </button>
        </div>
      );
    }
    const [details] = useState(() => <Details />);
    return (
      <DockRegion
        panel={
          open ? (
            <DockedPanel title="Merge feature/login into main" closeLabel="Close merge panel" primary={{ label: "Merge", reason, onRun: () => log.push("merge") }} onClose={() => setOpen(false)}>
              <input aria-label="Message" />
            </DockedPanel>
          ) : null
        }
      >
        {details}
      </DockRegion>
    );
  }

  test("Escape restores the earlier dock content and focus, and Ctrl+Enter runs the primary action", async () => {
    const log: string[] = [];
    await render(<Dock log={log} />);
    const opener = button("Merge…");
    await act(async () => opener.focus());
    await click(opener);
    const details = document.querySelector('[data-testid="details"]');
    expect(shown(details)).toBe(false);
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Message"]')!;
    await press(field, "Enter", { ctrlKey: true });
    expect(log).toEqual(["mount 1", "merge"]);
    await press(field, "Escape");
    expect(document.querySelector('input[aria-label="Message"]')).toBeNull();
    expect(shown(document.querySelector('[data-testid="details"]'))).toBe(true);
    // The earlier content stays mounted while the panel shows.
    expect(log).toEqual(["mount 1", "merge"]);
    expect(document.activeElement).toBe(opener);
  });

  test("Ctrl+Enter runs nothing while the primary action has a reason, and the reason shows inline", async () => {
    const log: string[] = [];
    await render(<Dock log={log} reason="Test reason: merge cannot run." />);
    await click(button("Merge…"));
    const primary = button("Merge (Ctrl+Enter)");
    expect(primary.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    expect(text(document.getElementById(primary.getAttribute("aria-describedby")!)!)).toBe("Test reason: merge cannot run.");
    await press(document.querySelector('input[aria-label="Message"]')!, "Enter", { ctrlKey: true });
    expect(log).toEqual(["mount 1"]);
  });

  test("Ctrl+Enter during an IME composition runs nothing: React gets the browser KeyboardEvent with isComposing", async () => {
    const log: string[] = [];
    await render(<Dock log={log} />);
    await click(button("Merge…"));
    await press(document.querySelector('input[aria-label="Message"]')!, "Enter", { ctrlKey: true, isComposing: true });
    expect(log).toEqual(["mount 1"]);
  });
});

describe("refresh after a 004 outcome (contract Δ8, 002 FR-005 change)", () => {
  const REFS_CHANGED = "References changed.";
  const outcome = (operation: string) => ({ requestId: fixtureId(0x5ff), operationId: fixtureId(0x311), state: "succeeded", repositoryGeneration: 1, result: { operation } });
  for (const operation of ["runWorkbench", "applyFiles"] as const) {
    test(`after a ${operation} outcome, the store reads the workspace, the refs, and the branches for the outcome and the new refs digest, reopens the view with the selected commit, and shows no refs-changed notice`, async () => {
      const world = createWorld();
      world.answers.readBranches = () => succeeded({ entries: [] });
      const OutcomeHistory = (props: Parameters<typeof workbench.HistoryViewMount>[0]) => (
        <>
          <workbench.HistoryViewMount {...props} />
          <button type="button" onClick={() => props.workbench.ended(operation, outcome(operation) as never)}>
            Test outcome
          </button>
        </>
      );
      const double = await mountWorkbench(workbench, world, OutcomeHistory);
      const selected = world.oids[1]!;
      await click(document.querySelector(`section[aria-label="History"] [role="option"][data-row-id="${selected}"]`)!);
      const before = { readWorkspace: double.count("readWorkspace"), readRefs: double.count("readRefs"), readBranches: double.count("readBranches"), openHistory: double.count("openHistory") };
      // The operation moved a branch, so the refs digest changes.
      world.branches = world.branches.map((b) => ({ ...b, objectId: oid(11) }));
      world.refsDigest = "f".repeat(64);
      await click(button("Test outcome"));
      await settle();
      expect(double.count("readWorkspace")).toBe(before.readWorkspace + 1);
      expect(double.count("readRefs")).toBe(before.readRefs + 1);
      // One read from the outcome, and one from the new refs digest of the reconcile read. The store keeps only the newest response.
      expect(double.count("readBranches")).toBe(before.readBranches + 2);
      expect(double.count("openHistory")).toBe(before.openHistory + 1);
      const loads = double.calls.filter((c) => c.operation === "loadHistory").map((c) => (c.args[1] as { need: unknown }).need);
      expect(loads.at(-1)).toEqual({ oid: selected });
      expect(document.querySelector(`[role="option"][data-row-id="${selected}"]`)!.getAttribute("aria-selected")).toBe("true");
      expect(text()).not.toContain(REFS_CHANGED);
    });
  }

  test("readBranches keeps only the newest response of the current repository generation", async () => {
    const pending: ((response: unknown) => void)[] = [];
    let target = { repositoryId: fixtureId(1), repositoryGeneration: 1 };
    const store = createWorkbench({
      bridge: contractChecked({ readBranches: () => new Promise((resolve) => pending.push(resolve as never)) as never }),
      target: () => target,
      mutationEnded: async () => {},
      refreshHistory: () => {},
    });
    const entry = (name: string) => ({ ref: `refs/heads/${name}`, kind: "local", name, invalidUtf8: false, oid: oid(1), upstream: null, tracking: null, heldBy: null, current: false, localName: null });
    store.readBranches();
    store.readBranches();
    pending[1]!(succeeded({ entries: [entry("new")] }));
    await settle();
    pending[0]!(succeeded({ entries: [entry("old")] }));
    await settle();
    expect(store.getState().branches?.entries?.map((e) => e.name)).toEqual(["new"]);
    store.readBranches();
    target = { repositoryId: fixtureId(1), repositoryGeneration: 2 };
    pending[2]!(succeeded({ entries: [entry("stale")] }));
    await settle();
    expect(store.getState().branches?.entries?.map((e) => e.name)).toEqual(["new"]);
    store.readBranches();
    pending[3]!({ requestId: fixtureId(0x5ff), state: "failed", code: "GIT_FAILED" });
    await settle();
    expect(store.getState().branches).toEqual({ repositoryId: fixtureId(1), repositoryGeneration: 2, entries: null, code: "GIT_FAILED" });
  });
});
