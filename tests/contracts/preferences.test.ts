// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import * as preferencesModule from "../../src/frontend/state/preferences";
import { DEFAULT_PREFERENCES, readPreferences, storePanes, writePreferences, type Panes, type Preferences } from "../../src/frontend/state/preferences";

printOrigin("../../src/frontend/state/preferences.ts", import.meta.dir);

// plan.md "Compact token system" and "Chosen layout, sizes, and DPI": the wide file lane is 240 to 400 DIPs, 280 by default.
// plan.md "References sidebar": the sidebar is 180 to 420 DIPs, 240 by default. Null keeps the layout default of a height pane.
const PANES: Panes = { fileLane: 280, sidebar: 240, fileBand: null, tray: null, commitDock: null, detailsDock: null };
const DEFAULTS: Preferences = { theme: "system", darkPalette: "graphite", density: "compact", panes: PANES };
// The stored bounds over both densities and the contract text scales 1 to 2.25. Heights have no plan.md DIP maximum.
const STORED: Panes = { fileLane: 333, sidebar: 300, fileBand: 150, tray: 200, commitDock: 500, detailsDock: 240 };
const BELOW: Panes = { fileLane: 239, sidebar: 179, fileBand: 101, tray: 143, commitDock: 423, detailsDock: 57 };
const LOWEST: Panes = { fileLane: 240, sidebar: 180, fileBand: 102, tray: 144, commitDock: 424, detailsDock: 58 };
const ABOVE: Partial<Panes> = { fileLane: 401, sidebar: 421, fileBand: 219 };

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
  test("the documented defaults: System theme, Graphite dark palette, Compact density, 280 DIP file lane", () => {
    expect(DEFAULT_PREFERENCES).toEqual(DEFAULTS);
    expect(readPreferences(new MemoryStorage())).toEqual(DEFAULTS);
  });

  test("valid values round-trip through storage", () => {
    for (const theme of ["system", "light", "dark"] as const) {
      for (const density of ["compact", "comfortable"] as const) {
        for (const fileLane of [240, 333, 400]) {
          for (const darkPalette of ["graphite", "ink", "warm"] as const) {
            const value: Preferences = { theme, darkPalette, density, panes: { ...PANES, fileLane } };
            expect(readPreferences(stored(value))).toEqual(value);
          }
        }
      }
    }
  });

  test("an invalid theme reads as System and keeps the other values", () => {
    for (const theme of ["purple", "", "System", "DARK", 1, null, undefined, {}]) {
      expect(readPreferences(stored({ darkPalette: "graphite", theme: theme as never, density: "comfortable", panes: { ...PANES, fileLane: 300 } }))).toEqual({ darkPalette: "graphite", theme: "system", density: "comfortable", panes: { ...PANES, fileLane: 300 } });
    }
  });

  // plan.md "Dark palettes": an unknown or missing palette reads as Graphite.
  test("an unknown or missing dark palette reads as Graphite and keeps the other values", () => {
    for (const darkPalette of ["purple", "", "Ink", "WARM", "warm dark", 1, null, undefined, {}]) {
      expect(readPreferences(stored({ theme: "dark", darkPalette: darkPalette as never, density: "comfortable", panes: { ...PANES, fileLane: 300 } }))).toEqual({ theme: "dark", darkPalette: "graphite", density: "comfortable", panes: { ...PANES, fileLane: 300 } });
    }
    const storage = new MemoryStorage();
    storage.setItem("arbareto.preferences.v1", JSON.stringify({ theme: "dark", density: "compact", panes: PANES }));
    expect(readPreferences(storage).darkPalette).toBe("graphite");
  });

  test("an invalid density reads as Compact; Comfortable is the only other value", () => {
    for (const density of ["spacious", "cozy", "Comfortable", "", 0, null]) {
      expect(readPreferences(stored({ darkPalette: "graphite", theme: "dark", density: density as never, panes: { ...PANES, fileLane: 300 } }))).toEqual({ darkPalette: "graphite", theme: "dark", density: "compact", panes: { ...PANES, fileLane: 300 } });
    }
  });

  test("an out-of-range or non-numeric pane proportion reads as its default", () => {
    for (const fileLane of [239, 401, -1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1e9, "300", null]) {
      expect(readPreferences(stored({ darkPalette: "graphite", theme: "light", density: "comfortable", panes: { ...PANES, fileLane: fileLane as never } }))).toEqual({ darkPalette: "graphite", theme: "light", density: "comfortable", panes: PANES });
    }
  });

  test("each remembered pane size survives a reload", () => {
    expect(readPreferences(stored({ panes: STORED })).panes).toEqual(STORED);
    expect(readPreferences(stored({ panes: LOWEST })).panes).toEqual(LOWEST);
    for (const key of Object.keys(STORED) as (keyof Panes)[]) {
      const panes = { ...PANES, [key]: STORED[key] };
      expect(readPreferences(stored({ panes })).panes).toEqual(panes);
    }
  });

  test("a missing pane size or one outside its stored bounds reads as its default, and the other sizes stay", () => {
    for (const key of Object.keys(STORED) as (keyof Panes)[]) {
      const bad = [BELOW[key], ABOVE[key], Number.NaN, Number.POSITIVE_INFINITY, -1, "200", true, {}, null].filter((v) => v !== undefined);
      for (const value of [...bad, undefined]) {
        const storage = new MemoryStorage();
        const panes: Record<string, unknown> = { ...STORED, [key]: value };
        if (value === undefined) delete panes[key];
        storage.setItem("arbareto.preferences.v1", JSON.stringify({ ...DEFAULTS, panes }));
        expect(readPreferences(storage).panes).toEqual({ ...STORED, [key]: PANES[key] });
      }
    }
  });

  test("Reset pane sizes stores every default", () => {
    const storage = stored({ theme: "dark", panes: STORED });
    const next = storePanes(storage, readPreferences(storage), "wide", DEFAULT_PREFERENCES.panes);
    expect(next).toEqual({ ...DEFAULTS, theme: "dark" });
    expect(readPreferences(storage)).toEqual({ ...DEFAULTS, theme: "dark" });
  });

  test("a constrained layout writes no size; the wide and narrow layouts write the changed size", () => {
    const storage = stored({ panes: STORED });
    const before = [...storage.items.values()];
    const remembered = readPreferences(storage);
    expect(storePanes(storage, remembered, "constrained", { sidebar: 200, tray: 150 })).toBe(remembered);
    expect([...storage.items.values()]).toEqual(before);
    for (const profile of ["wide", "narrow"] as const) {
      expect(storePanes(storage, remembered, profile, { sidebar: 200 }).panes).toEqual({ ...STORED, sidebar: 200 });
      expect(readPreferences(storage).panes).toEqual({ ...STORED, sidebar: 200 });
    }
    expect(() => storePanes(null, remembered, "wide", { sidebar: 200 })).not.toThrow();
  });

  test("garbage in every stored value reads as the defaults", () => {
    for (const garbage of ["", "{", "null", "[]", "\u0000", "undefined", '{"theme":"dark"']) {
      const storage = stored({ darkPalette: "graphite", theme: "dark", density: "comfortable", panes: { ...PANES, fileLane: 300 } });
      expect(storage.items.size).toBeGreaterThan(0);
      for (const key of storage.items.keys()) storage.items.set(key, garbage);
      expect(readPreferences(storage)).toEqual(DEFAULTS);
    }
  });

  test("a throwing storage read gives the defaults, and a throwing write throws nothing", () => {
    expect(readPreferences(throwing)).toEqual(DEFAULTS);
    expect(() => writePreferences(throwing, { darkPalette: "graphite", theme: "dark", density: "comfortable", panes: { ...PANES, fileLane: 300 } })).not.toThrow();
  });

  test("the module exports no mode, trust, approval, or operation field", () => {
    for (const name of Object.keys(preferencesModule)) expect(name).not.toMatch(FORBIDDEN);
    expect(keysDeep(DEFAULT_PREFERENCES).filter((key) => FORBIDDEN.test(key))).toEqual([]);
    expect(keysDeep(readPreferences(stored({ darkPalette: "graphite", theme: "dark" }))).filter((key) => FORBIDDEN.test(key))).toEqual([]);
  });

  test("an extra stored mode or trust field never reaches the read result", () => {
    const storage = new MemoryStorage();
    writePreferences(storage, { ...DEFAULTS, mode: "changes", trust: true, approval: "granted", operation: "commit" } as Preferences);
    const read = readPreferences(storage);
    expect(read).toEqual(DEFAULTS);
    expect([...storage.items.values()].join("\n")).not.toMatch(FORBIDDEN);
  });
});
