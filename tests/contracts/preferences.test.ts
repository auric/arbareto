// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import * as preferencesModule from "../../src/frontend/state/preferences";
import { DEFAULT_PREFERENCES, readPreferences, writePreferences, type Preferences } from "../../src/frontend/state/preferences";

printOrigin("../../src/frontend/state/preferences.ts", import.meta.dir);

// plan.md "Compact token system" and "Chosen layout, sizes, and DPI": the wide file lane is 240 to 400 DIPs, 280 by default.
const DEFAULTS: Preferences = { theme: "system", density: "compact", panes: { fileLane: 280 } };

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const throwing = {
  getItem(): string | null {
    throw new Error("storage read");
  },
  setItem(): void {
    throw new Error("storage write");
  },
  removeItem(): void {
    throw new Error("storage remove");
  },
};

const stored = (fields: Partial<Preferences>): MemoryStorage => {
  const storage = new MemoryStorage();
  writePreferences(storage, { ...DEFAULTS, ...fields } as Preferences);
  return storage;
};

const FORBIDDEN = /mode|trust|approv|operation/i;
const keysDeep = (value: unknown): string[] =>
  value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]) : [];

describe("preferences", () => {
  test("the documented defaults: System theme, Compact density, 280 DIP file lane", () => {
    expect(DEFAULT_PREFERENCES).toEqual(DEFAULTS);
    expect(readPreferences(new MemoryStorage())).toEqual(DEFAULTS);
  });

  test("valid values round-trip through storage", () => {
    for (const theme of ["system", "light", "dark"] as const) {
      for (const density of ["compact", "comfortable"] as const) {
        for (const fileLane of [240, 333, 400]) {
          const value: Preferences = { theme, density, panes: { fileLane } };
          expect(readPreferences(stored(value))).toEqual(value);
        }
      }
    }
  });

  test("an invalid theme reads as System and keeps the other values", () => {
    for (const theme of ["purple", "", "System", "DARK", 1, null, undefined, {}]) {
      expect(readPreferences(stored({ theme: theme as never, density: "comfortable", panes: { fileLane: 300 } }))).toEqual({ theme: "system", density: "comfortable", panes: { fileLane: 300 } });
    }
  });

  test("an invalid density reads as Compact; Comfortable is the only other value", () => {
    for (const density of ["spacious", "cozy", "Comfortable", "", 0, null]) {
      expect(readPreferences(stored({ theme: "dark", density: density as never, panes: { fileLane: 300 } }))).toEqual({ theme: "dark", density: "compact", panes: { fileLane: 300 } });
    }
  });

  test("an out-of-range or non-numeric pane proportion reads as its default", () => {
    for (const fileLane of [239, 401, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1e9, "300", null]) {
      expect(readPreferences(stored({ theme: "light", density: "comfortable", panes: { fileLane: fileLane as never } }))).toEqual({ theme: "light", density: "comfortable", panes: { fileLane: 280 } });
    }
  });

  test("garbage in every stored value reads as the defaults", () => {
    for (const garbage of ["", "{", "null", "[]", "\u0000", "undefined", '{"theme":"dark"']) {
      const storage = stored({ theme: "dark", density: "comfortable", panes: { fileLane: 300 } });
      expect(storage.items.size).toBeGreaterThan(0);
      for (const key of storage.items.keys()) storage.items.set(key, garbage);
      expect(readPreferences(storage)).toEqual(DEFAULTS);
    }
  });

  test("a throwing storage read gives the defaults, and a throwing write throws nothing", () => {
    expect(readPreferences(throwing)).toEqual(DEFAULTS);
    expect(() => writePreferences(throwing, { theme: "dark", density: "comfortable", panes: { fileLane: 300 } })).not.toThrow();
  });

  test("the module exports no mode, trust, approval, or operation field", () => {
    for (const name of Object.keys(preferencesModule)) expect(name).not.toMatch(FORBIDDEN);
    expect(keysDeep(DEFAULT_PREFERENCES).filter((key) => FORBIDDEN.test(key))).toEqual([]);
    expect(keysDeep(readPreferences(stored({ theme: "dark" }))).filter((key) => FORBIDDEN.test(key))).toEqual([]);
  });

  test("an extra stored mode or trust field never reaches the read result", () => {
    const storage = new MemoryStorage();
    writePreferences(storage, { ...DEFAULTS, mode: "changes", trust: true, approval: "granted", operation: "commit" } as Preferences);
    const read = readPreferences(storage);
    expect(read).toEqual(DEFAULTS);
    expect([...storage.items.values()].join("\n")).not.toMatch(FORBIDDEN);
  });
});
