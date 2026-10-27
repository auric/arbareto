// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { latinKeyCode } from "./key-codes";

// tasks.md T008 (feature 008, WP2). Plan D12 "Keys".

printOrigin("../../src/frontend/keyboard/shortcuts.ts", import.meta.dir);
const { KEYS, scopedAction } = await import("../../src/frontend/keyboard/shortcuts");
type Scope = Parameters<typeof scopedAction>[1];
const K = KEYS as Record<string, { aria: string; text: string; scopes: readonly string[] } | undefined>;

// A US-layout keydown. `keyCode` is the Windows virtual key that Blink matches for a letter (004 T126).
const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) => ({
  key: k,
  keyCode: latinKeyCode(k),
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...mods,
});
const SCOPES = ["localBranchRow", "remoteBranchRow", "historyRow", "diff", "fileList", "message", "panel", "settingsView", "changesList", "submoduleRow", "ignoreEditor", "stagedList"] as Scope[];
const actsIn = (event: ReturnType<typeof key>, action: string) => SCOPES.filter((scope) => scopedAction(event, scope) === action);

describe("plan D12 revert keys", () => {
  test("R gives revertLines only in the diff", () => {
    expect(scopedAction(key("r"), "diff")).toBe("revertLines");
    expect(actsIn(key("r"), "revertLines")).toEqual(["diff"]);
  });

  test("R gives revertFiles in the Changes list and in the Staged list", () => {
    expect(scopedAction(key("r"), "changesList")).toBe("revertFiles");
    expect(scopedAction(key("r"), "stagedList" as Scope)).toBe("revertFiles");
    expect(actsIn(key("r"), "revertFiles")).toEqual(["changesList", "stagedList"]);
  });

  test("R matches the virtual key on every layout, and a modifier gives no revert", () => {
    expect(scopedAction(key("к", { keyCode: 82 }), "diff")).toBe("revertLines");
    expect(scopedAction(key("R", { shiftKey: true }), "changesList")).toBeNull();
    expect(scopedAction(key("r", { ctrlKey: true }), "diff")).toBeNull();
  });

  test("a composing event gives null", () => {
    for (const scope of ["diff", "changesList", "stagedList"] as Scope[]) expect(scopedAction(key("r", { isComposing: true }), scope)).toBeNull();
  });

  test("each revert entry has aria R and text R", () => {
    for (const action of ["revertLines", "revertFiles"]) expect({ action, aria: K[action]?.aria, text: K[action]?.text }).toEqual({ action, aria: "R", text: "R" });
  });

  test("no two actions share a key in one scope", () => {
    for (const scope of SCOPES) {
      const seen = new Map<string, string>();
      for (const [action, k] of Object.entries(KEYS)) {
        if (!(k.scopes as readonly string[]).includes(scope)) continue;
        expect({ scope, aria: k.aria, other: seen.get(k.aria) }).toEqual({ scope, aria: k.aria, other: undefined });
        seen.set(k.aria, action);
      }
    }
  });
});
