// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T165: test-only input injection. Only the command-line entry calls SendInput, so an import injects nothing.
// Usage: bun tests/windows/inject.ts <keystroke>...
// A keystroke is a key name such as `F6`, a chord such as `Ctrl+Enter`, or `text:<characters>`.
// UIPI drops input to a window of a process with a higher integrity level, so run it under the account of the app.

import { dlopen, FFIType, ptr } from "bun:ffi";

export class InjectError extends Error {
  constructor(
    readonly code: "NOT_WINDOWS" | "BAD_ARGUMENT",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

const { ptr: P, u32, i32 } = FFIType;
const open = () => ({
  kernel32: dlopen("kernel32.dll", {
    QueryPerformanceCounter: { args: [P], returns: i32 },
    QueryPerformanceFrequency: { args: [P], returns: i32 },
  }).symbols,
  user32: dlopen("user32.dll", { SendInput: { args: [u32, P, i32], returns: u32 } }).symbols,
});
let dlls: ReturnType<typeof open> | undefined;

// The DLLs exist only on Windows, so the import of this file must not open them.
function lib(): ReturnType<typeof open> {
  if (process.platform !== "win32") throw new InjectError("NOT_WINDOWS", "input injection needs Windows");
  return (dlls ??= open());
}

export function qpc(): bigint {
  const value = new BigInt64Array(1);
  lib().kernel32.QueryPerformanceCounter(ptr(value));
  return value[0]!;
}

export function qpcFrequency(): bigint {
  const value = new BigInt64Array(1);
  lib().kernel32.QueryPerformanceFrequency(ptr(value));
  return value[0]!;
}

// winuser.h, x64: INPUT has `type` at 0 and the union at 8. The union holds MOUSEINPUT, its largest member (32 bytes).
// KEYBDINPUT in the union: wVk 0, wScan 2, dwFlags 4, time 8, dwExtraInfo 16.
export const INPUT_BYTES = 40;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_UNICODE = 0x4;

// Virtual-key codes of winuser.h. Microsoft Learn "Keyboard Input Overview" lists HOME, END, and the arrow keys of the navigation cluster as extended keys.
const KEYS: Record<string, { vk: number; extended: boolean }> = {
  Shift: { vk: 0x10, extended: false },
  Ctrl: { vk: 0x11, extended: false },
  Enter: { vk: 0x0d, extended: false },
  Space: { vk: 0x20, extended: false },
  Tab: { vk: 0x09, extended: false },
  Escape: { vk: 0x1b, extended: false },
  Home: { vk: 0x24, extended: true },
  End: { vk: 0x23, extended: true },
  Left: { vk: 0x25, extended: true },
  Up: { vk: 0x26, extended: true },
  Right: { vk: 0x27, extended: true },
  Down: { vk: 0x28, extended: true },
  F5: { vk: 0x74, extended: false },
  F6: { vk: 0x75, extended: false },
};
const MODIFIERS = new Set(["Shift", "Ctrl"]);

export interface KeyEvent {
  vk: number;
  scan: number;
  flags: number;
}

function press(name: string): KeyEvent {
  const key = KEYS[name];
  if (key === undefined) throw new InjectError("BAD_ARGUMENT", `unknown key ${JSON.stringify(name)}`);
  return { vk: key.vk, scan: 0, flags: key.extended ? KEYEVENTF_EXTENDEDKEY : 0 };
}

const up = (event: KeyEvent): KeyEvent => ({ ...event, flags: event.flags | KEYEVENTF_KEYUP });

// The events of one keystroke, in send order.
export function keystroke(text: string): KeyEvent[] {
  if (text.startsWith("text:")) {
    const chars = text.slice(5);
    if (chars === "") throw new InjectError("BAD_ARGUMENT", "text is empty");
    const events: KeyEvent[] = [];
    for (let i = 0; i < chars.length; i++) {
      const unit = { vk: 0, scan: chars.charCodeAt(i), flags: KEYEVENTF_UNICODE };
      events.push(unit, up(unit));
    }
    return events;
  }
  const names = text.split("+");
  const key = names.pop()!;
  if (names.some((n) => !MODIFIERS.has(n))) throw new InjectError("BAD_ARGUMENT", `bad modifier in ${JSON.stringify(text)}`);
  const downs = [...names.map(press), press(key)];
  return [...downs, ...downs.toReversed().map(up)];
}

export function encodeInputs(events: KeyEvent[]): Buffer {
  const bytes = Buffer.alloc(events.length * INPUT_BYTES);
  events.forEach((event, i) => {
    const at = i * INPUT_BYTES;
    bytes.writeUInt32LE(INPUT_KEYBOARD, at);
    bytes.writeUInt16LE(event.vk, at + 8);
    bytes.writeUInt16LE(event.scan, at + 10);
    bytes.writeUInt32LE(event.flags, at + 12);
  });
  return bytes;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: bun tests/windows/inject.ts <keystroke>...");
    process.exit(2);
  }
  const strokes = args.map((arg) => ({ arg, events: keystroke(arg) }));
  console.log(`QPC_FREQUENCY ${qpcFrequency()}`);
  for (const { arg, events } of strokes) {
    const bytes = encodeInputs(events);
    const at = qpc();
    // SendInput returns the number of events that it inserted. UIPI blocks give a lower count (Microsoft Learn "SendInput").
    const inserted = lib().user32.SendInput(events.length, ptr(bytes), INPUT_BYTES);
    console.log(`INJECT ${JSON.stringify(arg)} qpc=${at} inserted=${inserted}/${events.length}`);
    if (inserted !== events.length) process.exit(1);
  }
}
