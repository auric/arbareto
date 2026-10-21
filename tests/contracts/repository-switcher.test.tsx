// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T350: the repository switcher of `src/frontend/app/RepositorySwitcher.tsx` (FR-055; plan.md "Header layout", "Long text", "Dialog sizes", "Keyboard and focus" Repository switcher row,
// "Task flow and command placement" Switch repository row, and "Required visible states" Recent entry not found; contract §3 "Recent repositories" and §9).

import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";
import { contractChecked } from "./bridge-contract";

printOrigin("../../src/frontend/app/RepositorySwitcher.tsx", import.meta.dir);
registerDom();
const { createRoot } = await import("react-dom/client");
const { RepositorySwitcher, BUSY_TEXT, NO_MATCH_TEXT } = await import("../../src/frontend/app/RepositorySwitcher");

const NATIVE = "D:\\work\\clients\\sample-app";
const OTHER = "C:\\src\\Tools";
const WSL = "\\\\wsl.localhost\\Ubuntu-26.04\\home\\me\\kernel";
const entry = (path: string, location: { kind: "native" } | { kind: "wsl"; distro: string } = { kind: "native" }, current = false) => ({
  entryId: crypto.randomUUID(),
  path,
  location,
  openedAt: "2026-10-10T08:00:00Z",
  current,
});
const ENTRIES = [entry(NATIVE, { kind: "native" }, true), entry(OTHER), entry(WSL, { kind: "wsl", distro: "Ubuntu-26.04" })];
const succeeded = (result: unknown) => ({ requestId: crypto.randomUUID(), state: "succeeded", result });
const failed = (code: string, result: unknown) => ({ requestId: crypto.randomUUID(), state: "failed", code, result });
const ABSENT = { reason: "absent", path: OTHER, text: `Arbareto cannot find this folder: ${OTHER}.`, remedy: { text: "Remove it from the list, or open the folder from its new place." } };

type Call = { name: string; payload: unknown; resolve(response: unknown): void };
function bridgeDouble() {
  const calls: Call[] = [];
  const call = (name: string) => (payload: unknown = {}) =>
    new Promise((resolve) => {
      calls.push({ name, payload, resolve: (response) => resolve(response) });
    });
  const bridge = { listRecentRepositories: call("listRecentRepositories"), openRecentRepository: call("openRecentRepository"), removeRecentRepository: call("removeRecentRepository") };
  return { bridge: contractChecked(bridge) as never, calls, last: (name: string) => calls.filter((c) => c.name === name).at(-1)! };
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

type Options = { worktreeRoot?: string | null; busy?: boolean; open?: boolean };
async function mount(options: Options = {}) {
  const double = bridgeDouble();
  const opened: unknown[] = [];
  const folders: number[] = [];
  const changes: boolean[] = [];
  function Harness() {
    const [open, setOpen] = useState(options.open ?? false);
    return (
      <>
        <RepositorySwitcher
          bridge={double.bridge}
          worktreeRoot={options.worktreeRoot === undefined ? NATIVE : options.worktreeRoot}
          busy={options.busy ?? false}
          open={open}
          onOpenChange={(next: boolean) => {
            changes.push(next);
            setOpen(next);
          }}
          onOpenFolder={() => void folders.push(1)}
          onOpened={(response: unknown) => void opened.push(response)}
        />
        <button type="button" data-double="after">
          After
        </button>
      </>
    );
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, ...double, opened, folders, changes };
}

const settle = () => act(async () => await new Promise((resolve) => setImmediate(resolve)));
const text = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const trigger = (host: HTMLElement) => host.querySelector<HTMLElement>('button[aria-haspopup]')!;
const filter = () => document.querySelector<HTMLInputElement>('[role="combobox"]');
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const option = (label: string) => {
  const found = options().filter((o) => (o.getAttribute("aria-label") ?? text(o)).includes(label));
  expect(found).toHaveLength(1);
  return found[0]!;
};
const active = () => document.getElementById(filter()!.getAttribute("aria-activedescendant") ?? "");
async function key(target: Element, name: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, code: name, bubbles: true, cancelable: true, ...init }));
  });
}
async function type(value: string, caret = value.length) {
  const input = filter()!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.setSelectionRange(caret, caret);
}
// Opens the popup and answers the list read.
async function openWith(entries = ENTRIES, options: Options = {}) {
  const view = await mount({ ...options, open: true });
  await settle();
  await act(async () => view.last("listRecentRepositories").resolve(succeeded({ entries })));
  await settle();
  return view;
}

describe("switcher button", () => {
  test("it shows the folder icon and the folder name only; its name and its tooltip hold the full path; the tooltip holds the key (004 plan.md D15)", async () => {
    const view = await mount();
    const button = trigger(view.host);
    expect(text(button)).toBe("sample-app");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe(`sample-app, ${NATIVE}`);
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+R");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true }));
      button.focus();
    });
    expect(text(document.querySelector('[data-slot="tooltip-content"]'))).toBe(`${NATIVE} Recent repositories (Ctrl+R)`);
  });

  test("a WSL worktree shows the name without the distro prefix", async () => {
    const view = await mount({ worktreeRoot: WSL });
    expect(trigger(view.host).getAttribute("aria-label")).toBe(`kernel, ${WSL}`);
  });

  test("a recent entry path keeps the root and the last folder name whole, and only its middle part ellipsizes", async () => {
    await openWith();
    const parts = [...option("sample-app").querySelectorAll<HTMLElement>("[data-path-part]")].map((p) => [p.dataset.pathPart, p.textContent, p.className.split(/\s+/).includes("truncate")]);
    expect(parts).toEqual([
      ["root", "D:\\", false],
      ["middle", "work\\clients\\", true],
      ["last", "sample-app", false],
    ]);
  });

  test("Alt+Down on the button opens the list", async () => {
    const view = await mount();
    await key(trigger(view.host), "ArrowDown", { altKey: true });
    expect(view.changes).toEqual([true]);
  });

  test("the list read starts only when the popup opens, and no other operation runs before an open", async () => {
    const view = await mount();
    expect(view.calls).toHaveLength(0);
    await act(async () => trigger(view.host).click());
    await settle();
    expect(view.calls.map((c) => c.name)).toEqual(["listRecentRepositories"]);
  });
});

describe("recent list", () => {
  test("focus moves to the filter; Open folder… (Ctrl+O) comes first; each entry shows the folder name, the path, and the WSL label", async () => {
    await openWith();
    expect(document.activeElement).toBe(filter());
    expect(text(options()[0])).toBe("Open folder… (Ctrl+O)");
    expect(options()).toHaveLength(4);
    const wsl = option("kernel");
    expect(wsl.getAttribute("aria-label")).toBe(`kernel, ${WSL}, WSL: Ubuntu-26.04`);
    expect(text(wsl)).toContain("WSL: Ubuntu-26.04");
    expect(option("Tools").getAttribute("aria-label")).toBe(`Tools, ${OTHER}`);
  });

  test("the current entry carries aria-current", async () => {
    await openWith();
    expect(option("sample-app").getAttribute("aria-current")).toBe("true");
    expect(option("Tools").hasAttribute("aria-current")).toBe(false);
  });

  // Contract §3 `listRecentRepositories`: the shell sets `current` from the worktree key. The path text is no identity.
  test("aria-current follows the shell `current` flag, not the path text", async () => {
    await openWith(ENTRIES, { worktreeRoot: OTHER });
    expect(option("sample-app").getAttribute("aria-current")).toBe("true");
    expect(option("Tools").hasAttribute("aria-current")).toBe(false);
  });

  test("the filter keeps an entry whose folder name or path contains the text, without regard to letter case", async () => {
    await openWith();
    await type("TOOLS");
    expect(options().map((o) => o.getAttribute("aria-label") ?? text(o))).toEqual(["Open folder… (Ctrl+O)", `Tools, ${OTHER}`]);
    await type("clients");
    expect(options()).toHaveLength(2);
    expect(option("sample-app")).toBeDefined();
    await type("nothing-here");
    expect(options()).toHaveLength(1);
    expect(text(listbox()!.parentElement)).toContain(NO_MATCH_TEXT);
  });

  test("Up and Down move the active entry through aria-activedescendant, and Enter opens it through openRecentRepository", async () => {
    const view = await openWith();
    expect(active()).toBe(options()[0]!);
    await key(filter()!, "ArrowDown");
    await key(filter()!, "ArrowDown");
    expect(active()).toBe(option("Tools"));
    await key(filter()!, "ArrowUp");
    expect(active()).toBe(option("sample-app"));
    await key(filter()!, "ArrowDown");
    await key(filter()!, "Enter");
    expect(view.last("openRecentRepository").payload).toEqual({ entryId: ENTRIES[1]!.entryId });
  });

  test("Enter on Open folder runs the folder dialog and closes the list", async () => {
    const view = await openWith();
    await key(filter()!, "Enter");
    expect(view.folders).toEqual([1]);
    expect(view.changes.at(-1)).toBe(false);
  });

  test("a succeeded open hands the result over and closes the list", async () => {
    const view = await openWith();
    await act(async () => option("Tools").click());
    const response = succeeded({ repositoryId: crypto.randomUUID(), generation: 1, worktreeKey: "a".repeat(64), worktreeRoot: OTHER });
    await act(async () => view.last("openRecentRepository").resolve(response));
    await settle();
    expect(view.opened).toEqual([response]);
    expect(view.changes.at(-1)).toBe(false);
  });

  test("Escape closes the list and returns focus to the switcher", async () => {
    const view = await openWith();
    await key(filter()!, "Escape");
    await settle();
    expect(view.changes.at(-1)).toBe(false);
    expect(filter()).toBeNull();
    expect(document.activeElement).toBe(trigger(view.host));
  });

  test("Tab closes the list", async () => {
    const view = await openWith();
    await key(filter()!, "Tab");
    await settle();
    expect(view.changes.at(-1)).toBe(false);
  });

  test("Delete at the end of the filter text removes the active entry and shows the new list", async () => {
    const view = await openWith();
    await type("tools");
    await key(filter()!, "ArrowDown");
    await key(filter()!, "Delete");
    expect(view.last("removeRecentRepository").payload).toEqual({ entryId: ENTRIES[1]!.entryId });
    await act(async () => view.last("removeRecentRepository").resolve(succeeded({ entries: [ENTRIES[0], ENTRIES[2]] })));
    await settle();
    await type("");
    expect(options()).toHaveLength(3);
  });

  test("Delete with the caret inside the filter text, or on Open folder, removes nothing", async () => {
    const view = await openWith();
    await type("tools", 2);
    await key(filter()!, "ArrowDown");
    await key(filter()!, "Delete");
    await type("", 0);
    await key(filter()!, "Delete");
    expect(view.calls.filter((c) => c.name === "removeRecentRepository")).toHaveLength(0);
  });

  test("an empty list reads the plan.md empty text", async () => {
    await openWith([]);
    expect(text(listbox()!.parentElement)).toContain("No recent repositories. Open a folder to start.");
    expect(options()).toHaveLength(1);
  });
});

describe("refusals", () => {
  test("while a mutation runs, the entries and Open folder are disabled with the plan.md reason, and Enter starts nothing", async () => {
    const view = await openWith(ENTRIES, { busy: true });
    const reason = [...document.querySelectorAll("[id]")].find((e) => text(e) === BUSY_TEXT);
    expect(reason).toBeDefined();
    for (const o of options()) {
      expect(o.getAttribute("aria-disabled")).toBe("true");
      expect(o.getAttribute("aria-describedby")).toBe(reason!.id);
    }
    await key(filter()!, "Enter");
    await key(filter()!, "ArrowDown");
    await key(filter()!, "Enter");
    expect(view.folders).toEqual([]);
    expect(view.calls.map((c) => c.name)).toEqual(["listRecentRepositories"]);
  });

  test("an absent result shows its text and remedy with Remove from list, which removes that entry; the workspace stays", async () => {
    const view = await openWith();
    await act(async () => option("Tools").click());
    await act(async () => view.last("openRecentRepository").resolve(failed("REPOSITORY_UNAVAILABLE", ABSENT)));
    await settle();
    const popup = text(listbox()!.parentElement);
    expect(popup).toContain(ABSENT.text);
    expect(popup).toContain(ABSENT.remedy.text);
    expect(view.opened).toEqual([]);
    expect(view.changes).not.toContain(false);
    const remove = [...document.querySelectorAll("button")].filter((b) => text(b) === "Remove from list");
    expect(remove).toHaveLength(1);
    await act(async () => remove[0]!.click());
    expect(view.last("removeRecentRepository").payload).toEqual({ entryId: ENTRIES[1]!.entryId });
  });

  test("a BUSY result shows the refusal with its code, and the workspace stays", async () => {
    const view = await openWith();
    await act(async () => option("Tools").click());
    await act(async () => view.last("openRecentRepository").resolve({ requestId: crypto.randomUUID(), state: "rejected", code: "BUSY" }));
    await settle();
    expect(text(listbox()!.parentElement)).toContain("The repository did not open: BUSY");
    expect(view.opened).toEqual([]);
    expect([...document.querySelectorAll("button")].filter((b) => text(b) === "Remove from list")).toHaveLength(0);
  });
});
