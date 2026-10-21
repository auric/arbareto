// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { createShortcutHandler, filterTarget, KEYS, scopedAction, type KeyScope, type ScopedAction, type ShortcutContext } from "../../src/frontend/keyboard/shortcuts";

// tasks.md T038 (feature 004, WP11). Stories US1 to US4. Spec FR-014, FR-043, FR-087, SC-014. Plan D15 keyboard map.

printOrigin("../../src/frontend/keyboard/shortcuts.ts", import.meta.dir);

// The plan.md D15 map: key, action, and the scopes where the key acts.
const D15: [ScopedAction, string, string, KeyScope[]][] = [
  ["switch", "Control+.", "Ctrl+.", ["localBranchRow", "remoteBranchRow"]],
  ["merge", "Control+M", "Ctrl+M", ["localBranchRow", "remoteBranchRow"]],
  ["rebase", "Control+Shift+E", "Ctrl+Shift+E", ["localBranchRow", "remoteBranchRow"]],
  ["createBranch", "Control+B", "Ctrl+B", ["localBranchRow", "remoteBranchRow", "historyRow"]],
  ["rename", "F2", "F2", ["localBranchRow"]],
  ["delete", "Delete", "Del", ["localBranchRow"]],
  ["stageLines", "S", "S", ["diff"]],
  ["unstageLines", "U", "U", ["diff"]],
  ["stageEntry", "Space", "Space", ["fileList"]],
  ["previousHunk", "Alt+ArrowUp", "Alt+Up", ["diff"]],
  ["nextHunk", "Alt+ArrowDown", "Alt+Down", ["diff"]],
  ["primary", "Control+Enter", "Ctrl+Enter", ["message", "panel"]],
  ["save", "Control+S", "Ctrl+S", ["settingsView"]],
];
const SCOPES: KeyScope[] = ["localBranchRow", "remoteBranchRow", "historyRow", "diff", "fileList", "message", "panel", "settingsView"];

type Init = { key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean };
/** A keydown with the modifiers and the key of an `aria-keyshortcuts` value. */
function keyOf(aria: string): Init {
  const parts = aria.split("+");
  const key = parts.pop()!;
  return { key: key === "Space" ? " " : key.length === 1 ? key.toLowerCase() : key, ctrlKey: parts.includes("Control"), shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt"), metaKey: parts.includes("Meta") };
}
const event = (init: Init) => ({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...init });

describe("plan.md D15 keyboard map", () => {
  test("the map holds the D15 keys and texts", () => {
    for (const [action, aria, text] of D15) expect(KEYS[action]).toEqual({ aria, text, scopes: D15.find((row) => row[0] === action)![3] });
    expect(Object.keys(KEYS).sort()).toEqual(D15.map((row) => row[0]).sort());
  });

  test("each key acts only in its scope", () => {
    for (const [action, aria, , scopes] of D15) {
      for (const scope of SCOPES) expect([action, scope, scopedAction(event(keyOf(aria)), scope)]).toEqual([action, scope, scopes.includes(scope) ? action : null]);
    }
  });

  test("S and U act only while the diff has focus, also with Caps Lock, and never with a modifier (FR-087)", () => {
    for (const key of ["s", "S"]) expect(scopedAction(event({ key }), "diff")).toBe("stageLines");
    for (const key of ["u", "U"]) expect(scopedAction(event({ key }), "diff")).toBe("unstageLines");
    for (const scope of SCOPES.filter((s) => s !== "diff")) for (const key of ["s", "u"]) expect(scopedAction(event({ key }), scope)).toBeNull();
    for (const modifier of ["ctrlKey", "altKey", "metaKey"] as const) expect(scopedAction(event({ key: "s", [modifier]: true }), "diff")).toBeNull();
    expect(scopedAction(event({ key: "s", isComposing: true }), "diff")).toBeNull();
  });

  test("Space acts only in a file list (FR-087)", () => {
    for (const scope of SCOPES) expect(scopedAction(event({ key: " " }), scope)).toBe(scope === "fileList" ? "stageEntry" : null);
  });
});

// Plain stand-ins for DOM nodes. The page handler reads only these fields and the composed path.
const body = { tagName: "BODY" };
const row = { tagName: "DIV" };
const input = { tagName: "INPUT", type: "text" };
const textarea = { tagName: "TEXTAREA" };
const context: ShortcutContext = { messageField: null, comparisonPane: null, modalOpen: false, menuOpen: false, commitEnabled: false };
function pageAction(init: Init, path: object[]) {
  const handle = createShortcutHandler();
  const e = { type: "keydown", code: "", repeat: false, getModifierState: () => false, preventDefault: () => {}, composedPath: () => path, ...event(init) };
  return handle(e as never, context);
}

describe("window keys and collisions (FR-014, SC-014)", () => {
  test("Fetch, Pull, and Push act in the window but not in an editable field", () => {
    for (const [aria, control] of [
      ["Control+Shift+ArrowDown", "fetch"],
      ["Control+ArrowDown", "pull"],
      ["Control+ArrowUp", "push"],
    ] as const) {
      expect(pageAction(keyOf(aria), [body])).toEqual({ type: "sync", control });
      expect(pageAction(keyOf(aria), [row, body])).toEqual({ type: "sync", control });
      for (const field of [input, textarea]) expect(pageAction(keyOf(aria), [field, body])).toBeNull();
    }
  });

  test("no 004 key collides with a 001, 002, or 003 page key", () => {
    // These rows are 001 keys with the same action: the hunk step and Ctrl+Enter. Space is the 001 Stage key of the file list.
    const SAME_AS_001: ScopedAction[] = ["previousHunk", "nextHunk", "primary", "stageEntry"];
    for (const [action, aria] of D15) {
      if (SAME_AS_001.includes(action)) continue;
      expect([aria, pageAction(keyOf(aria), [row, body])]).toEqual([aria, null]);
    }
  });

  test("no two actions share a key in one scope", () => {
    for (const scope of SCOPES) {
      const keys = D15.filter((r) => r[3].includes(scope)).map((r) => r[1]);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("Ctrl+F per view (FR-101, plan D15 keyboard map, T092)", () => {
  test("Ctrl+F focuses the filter of the active view: the history filter in History, Filter files in Commit, and Find a setting in Settings", () => {
    expect(filterTarget("history")).toBe("history");
    expect(filterTarget("commit")).toBe("files");
    expect(filterTarget("settings")).toBe("settings");
  });

  test("Ctrl+F acts in the window and in an editable field, so it leaves the message field for the filter", () => {
    for (const path of [[body], [row, body], [input, body], [textarea, body]]) expect(pageAction({ key: "f", ctrlKey: true }, path)).toEqual({ type: "focusFilter" });
    expect(pageAction({ key: "F", ctrlKey: true }, [body])).toEqual({ type: "focusFilter" });
    for (const modifier of ["shiftKey", "altKey", "metaKey"] as const) expect(pageAction({ key: "f", ctrlKey: true, [modifier]: true }, [body])).toBeNull();
  });
});
