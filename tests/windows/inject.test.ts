// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Only the last case runs the command-line entry, and only with ARBARETO_LIVE_INPUT=1 in the measurement account. Injected input reaches the focused window.

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { encodeInputs, INPUT_BYTES, InjectError, keystroke, qpc, qpcFrequency } from "./inject";
import { srcImportHits } from "./src-imports";

const INJECT = printOrigin("./inject.ts", import.meta.dir);

const code = (body: () => unknown) => {
  try {
    body();
  } catch (error) {
    if (error instanceof InjectError) return error.code;
    throw error;
  }
  return null;
};

describe("T165 inject.ts without injection", () => {
  test("no file under src/ imports bun:ffi or inject.ts", () => {
    expect(srcImportHits([INJECT])).toEqual([]);
  });

  test("a key press gives a down and an up event", () => {
    expect(keystroke("Shift")).toEqual([
      { vk: 0x10, scan: 0, flags: 0 },
      { vk: 0x10, scan: 0, flags: 0x2 },
    ]);
  });

  test("modifiers wrap the key in press order and release in reverse order", () => {
    expect(keystroke("Ctrl+Enter")).toEqual([
      { vk: 0x11, scan: 0, flags: 0 },
      { vk: 0x0d, scan: 0, flags: 0 },
      { vk: 0x0d, scan: 0, flags: 0x2 },
      { vk: 0x11, scan: 0, flags: 0x2 },
    ]);
  });

  test("navigation-cluster keys carry the extended-key flag", () => {
    for (const [name, vk] of [["Home", 0x24], ["Up", 0x26], ["Down", 0x28], ["Delete", 0x2e]] as const) {
      expect(keystroke(name)).toEqual([
        { vk, scan: 0, flags: 0x1 },
        { vk, scan: 0, flags: 0x3 },
      ]);
    }
    expect(keystroke("F6")[0]).toEqual({ vk: 0x75, scan: 0, flags: 0 });
  });

  test("text sends each UTF-16 code unit as a Unicode packet", () => {
    expect(keystroke("text:é")).toEqual([
      { vk: 0, scan: 0xe9, flags: 0x4 },
      { vk: 0, scan: 0xe9, flags: 0x6 },
    ]);
    // U+1F600 is the surrogate pair D83D DE00.
    expect(keystroke("text:\u{1f600}").map((e) => e.scan)).toEqual([0xd83d, 0xd83d, 0xde00, 0xde00]);
  });

  test("bad keystrokes refuse", () => {
    for (const bad of ["", "Bogus", "Ctrl+", "+Enter", "Enter+Ctrl", "text:", "Ctrl+text:a"]) expect(code(() => keystroke(bad))).toBe("BAD_ARGUMENT");
  });

  test("the x64 INPUT layout: 40 bytes, type at 0, KEYBDINPUT at 8", () => {
    expect(INPUT_BYTES).toBe(40);
    const bytes = encodeInputs([
      { vk: 0x24, scan: 0, flags: 0x1 },
      { vk: 0, scan: 0xe9, flags: 0x6 },
    ]);
    expect(bytes.length).toBe(80);
    expect(bytes.readUInt32LE(0)).toBe(1);
    expect(bytes.readUInt16LE(8)).toBe(0x24);
    expect(bytes.readUInt16LE(10)).toBe(0);
    expect(bytes.readUInt32LE(12)).toBe(0x1);
    expect(bytes.readUInt32LE(16)).toBe(0);
    expect(bytes.readBigUInt64LE(24)).toBe(0n);
    expect(bytes.readUInt32LE(40)).toBe(1);
    expect(bytes.readUInt16LE(48)).toBe(0);
    expect(bytes.readUInt16LE(50)).toBe(0xe9);
    expect(bytes.readUInt32LE(52)).toBe(0x6);
  });

  test.skipIf(process.platform !== "win32")("the QPC export reads a positive, nondecreasing counter", () => {
    const first = qpc();
    const second = qpc();
    console.log(`QPC ${first} ${second} frequency=${qpcFrequency()}`);
    expect(first).toBeGreaterThan(0n);
    expect(second).toBeGreaterThanOrEqual(first);
    expect(qpcFrequency()).toBeGreaterThan(0n);
  });

  const live = process.platform === "win32" && process.env.ARBARETO_LIVE_INPUT === "1";
  if (!live) console.log("SKIP SendInput: live input needs the measurement account: set ARBARETO_LIVE_INPUT=1");

  test.skipIf(!live)("SendInput inserts one Shift down and up pair", () => {
    const proc = Bun.spawnSync([process.execPath, INJECT, "Shift"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString();
    console.log(out.trimEnd());
    expect(proc.exitCode).toBe(0);
    expect(out).toMatch(/^INJECT "Shift" qpc=[1-9]\d* inserted=2\/2$/m);
  });
});
