// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";

// tasks.md T051 (feature 005, WP7). Stories US2, US5, US6, US7, US8. Spec FR-013, FR-023, FR-056, FR-067, SC-010. Plan D15 "Keyboard map additions".

printOrigin("../../src/frontend/keyboard/shortcuts.ts", import.meta.dir);
const { KEYS, createShortcutHandler, filterTarget, scopedAction, HISTORY_FILES_SCOPE } = await import("../../src/frontend/keyboard/shortcuts");
type Scope = Parameters<typeof scopedAction>[1];

// A US-layout keydown. `keyCode` is the Windows virtual key that Blink matches for a letter (plan D15 keyboard map, 004 T126).
const VK: Record<string, number> = { Delete: 46, Enter: 13, Escape: 27, ArrowLeft: 37, s: 83, f: 70 };
const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean } = {}) => ({
  key: k,
  keyCode: VK[k] ?? 0,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...mods,
});
const SCOPES: Scope[] = ["localBranchRow", "remoteBranchRow", "historyRow", "diff", "fileList", "message", "panel", "settingsView", "changesList", "submoduleRow", "ignoreEditor"];
const actsIn = (event: ReturnType<typeof key>, action: string) => SCOPES.filter((scope) => scopedAction(event, scope) === action);

describe("D15 keys act only in their scope", () => {
  test("Delete and Shift+Delete act only in the Changes list (FR-023)", () => {
    expect(actsIn(key("Delete"), "deleteFiles")).toEqual(["changesList"]);
    expect(actsIn(key("Delete", { shiftKey: true }), "deletePermanently")).toEqual(["changesList"]);
    // The Staged list and every other region take no Delete of files.
    expect(scopedAction(key("Delete"), "fileList")).toBeNull();
    // The 004 branch Delete stays on a local branch row (004 plan D15).
    expect(scopedAction(key("Delete"), "localBranchRow")).toBe("delete");
    expect(scopedAction(key("Delete"), "changesList")).toBe("deleteFiles");
    expect(KEYS.deleteFiles.text).toBe("Del");
    expect(KEYS.deletePermanently.text).toBe("Shift+Del");
  });

  test("Enter opens a submodule only on a Submodules group row", () => {
    expect(actsIn(key("Enter"), "openSubmodule")).toEqual(["submoduleRow"]);
  });

  test("Ctrl+S saves in the ignore editor panel, and the 004 Settings save stays", () => {
    expect(actsIn(key("s", { ctrlKey: true }), "save")).toEqual(["settingsView", "ignoreEditor"]);
    expect(scopedAction(key("Escape"), "ignoreEditor")).toBe("closeEditor");
    expect(actsIn(key("Escape"), "closeEditor")).toEqual(["ignoreEditor"]);
  });

  test("an IME composition takes no key", () => {
    expect(scopedAction(key("Escape", { isComposing: true }), "ignoreEditor")).toBeNull();
    expect(scopedAction(key("Delete", { isComposing: true }), "changesList")).toBeNull();
  });

  test("no two actions share a key in one scope", () => {
    for (const scope of SCOPES) {
      const seen = new Map<string, string>();
      for (const [action, k] of Object.entries(KEYS)) {
        if (!k.scopes.includes(scope)) continue;
        expect(seen.get(k.aria)).toBeUndefined();
        seen.set(k.aria, action);
      }
    }
  });
});

describe("no 005 key collides with a 001 to 004 page key (plan D15 conflict check)", () => {
  const handler = createShortcutHandler();
  const page = (k: ReturnType<typeof key>) => {
    let prevented = false;
    const event = { ...k, type: "keydown", code: k.key, repeat: false, getModifierState: () => false, preventDefault: () => void (prevented = true), composedPath: () => [document] };
    return { action: handler(event as never, { messageField: null, comparisonPane: null, modalOpen: false, menuOpen: false, commitEnabled: false }), prevented };
  };
  const document = { tagName: "BODY" };
  for (const [name, event] of [
    ["Delete", key("Delete")],
    ["Shift+Delete", key("Delete", { shiftKey: true })],
    ["Enter", key("Enter")],
    ["Escape", key("Escape")],
    ["Ctrl+S", key("s", { ctrlKey: true })],
    ["Alt+Left", key("ArrowLeft", { altKey: true })],
  ] as const) {
    test(`${name} has no page action`, () => {
      const { action, prevented } = page(event);
      expect(action).toBeNull();
      expect(prevented).toBe(false);
    });
  }
  test("Ctrl+F stays the page filter key", () => {
    expect(page(key("f", { ctrlKey: true })).action).toEqual({ type: "focusFilter" });
  });
});

describe("Ctrl+F routing (plan D15: Changed files or the History diff)", () => {
  const inside = { closest: (selector: string) => (selector === HISTORY_FILES_SCOPE ? {} : null) };
  const outside = { closest: () => null };
  test("History: Filter files inside Changed files or the diff, else the 002 history filter", () => {
    expect(filterTarget("history", inside)).toBe("historyFiles");
    expect(filterTarget("history", outside)).toBe("history");
    expect(filterTarget("history", null)).toBe("history");
  });
  test("the Commit view and Settings keep their 004 targets", () => {
    expect(filterTarget("commit", inside)).toBe("files");
    expect(filterTarget("settings", outside)).toBe("settings");
  });
  test("the History files scope names both regions", () => {
    expect(HISTORY_FILES_SCOPE).toBe('[data-slot="changed-files"], [data-slot="history-diff"]');
  });
});
