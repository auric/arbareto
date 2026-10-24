// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T079: the CDP key events of `cdp.ts`, without a package. The fields are those of CDP `Input.dispatchKeyEvent`.
// The virtual-key codes are the winuser.h values: VK_SHIFT 0x10, VK_F5 0x74, VK_F10 0x79. The CDP modifier bit of Shift is 8.

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { keyEvents, MOD } from "./cdp";

printOrigin("./cdp.ts", import.meta.dir);

describe("T079 cdp.ts key events", () => {
  test("F5 gives one rawKeyDown and one keyUp with virtual key 116", () => {
    expect(keyEvents("F5")).toEqual([
      { type: "rawKeyDown", key: "F5", code: "F5", windowsVirtualKeyCode: 116, modifiers: 0 },
      { type: "keyUp", key: "F5", code: "F5", windowsVirtualKeyCode: 116, modifiers: 0 },
    ]);
  });

  test("Shift+F10 holds Shift (modifier bit 8, virtual key 16) around F10 (virtual key 121), and the Shift up clears the bits", () => {
    expect(MOD.Shift).toBe(8);
    expect(keyEvents("F10", MOD.Shift)).toEqual([
      { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 },
      { type: "rawKeyDown", key: "F10", code: "F10", windowsVirtualKeyCode: 121, modifiers: 8 },
      { type: "keyUp", key: "F10", code: "F10", windowsVirtualKeyCode: 121, modifiers: 8 },
      { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 },
    ]);
  });

  test("Ctrl+A carries its editing command on the key down only", () => {
    expect(keyEvents("a", MOD.Ctrl, { commands: ["selectAll"] }).map((e) => [e.type, e.key, e.commands])).toEqual([
      ["rawKeyDown", "Control", undefined],
      ["rawKeyDown", "a", ["selectAll"]],
      ["keyUp", "a", undefined],
      ["keyUp", "Control", undefined],
    ]);
  });

  test("a typed key with text and no modifier goes as keyDown with its text; with a modifier it stays rawKeyDown", () => {
    expect(keyEvents("Enter", 0, { typed: true })[0]).toEqual({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" });
    expect(keyEvents("Enter")[0]).toEqual({ type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 });
    expect(keyEvents("Enter", MOD.Ctrl, { typed: true })[1]).toEqual({ type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2 });
  });

  test("a key outside the table throws", () => {
    expect(() => keyEvents("F11")).toThrow('no CDP key "F11"');
  });
});
