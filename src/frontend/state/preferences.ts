// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { dockBounds, FILE_LANE, metrics, SIDEBAR, type Density, type Profile } from "../layout/profiles";

// Bounded view scalars only. A preference never grants a Git permission, and no mode is stored (FR-034).

export type Theme = "system" | "light" | "dark";
/** plan.md "Dark palettes". System uses it when Windows is dark; Light ignores it. */
export type DarkPalette = "graphite" | "ink" | "warm";
/** DIPs (plan.md "Store pane sizes in logical units"). Null keeps the layout default, which depends on the density and the window. */
export type Panes = { fileLane: number; sidebar: number; fileBand: number | null; tray: number | null; commitDock: number | null; detailsDock: number | null };
export type Preferences = { theme: Theme; darkPalette: DarkPalette; density: Density; panes: Panes };
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  darkPalette: "graphite",
  density: "compact",
  panes: { fileLane: FILE_LANE.default, sidebar: SIDEBAR.default, fileBand: null, tray: null, commitDock: null, detailsDock: null },
};

const KEY = "arbareto.preferences.v1";
const THEMES: readonly unknown[] = ["system", "light", "dark"];
const DARK_PALETTES: readonly unknown[] = ["graphite", "ink", "warm"];

// The stored bounds hold every density and every contract text scale from 1 to 2.25. Layout clamps a size to the current window.
// plan.md gives the height panes no DIP maximum, so only a finite value passes there.
const LOW = metrics("compact", 1);
const HIGH = metrics("comfortable", 2.25);
const WIDE_COMPACT = { width: Number.POSITIVE_INFINITY, available: 0, density: "compact", textScale: 1 } as const;
const PANE_BOUNDS: Record<keyof Panes, readonly [number, number]> = {
  fileLane: [FILE_LANE.min, FILE_LANE.max],
  sidebar: [SIDEBAR.min, SIDEBAR.max],
  fileBand: [LOW.workingChangesMin, Math.max(160, HIGH.workingChangesMin)],
  tray: [LOW.trayMin, Number.POSITIVE_INFINITY],
  commitDock: [dockBounds("commit", WIDE_COMPACT).min, Number.POSITIVE_INFINITY],
  detailsDock: [dockBounds("details", WIDE_COMPACT).min, Number.POSITIVE_INFINITY],
};

/** The `data-dark-palette` root value. index.css draws Graphite without it. */
export const darkPaletteAttribute = (palette: DarkPalette): "ink" | "warm" | null => (palette === "graphite" ? null : palette);

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

function sanitize(value: unknown): Preferences {
  const theme = field(value, "theme");
  const darkPalette = field(value, "darkPalette");
  const density = field(value, "density");
  const stored = field(value, "panes");
  const pane = <K extends keyof Panes>(key: K): Panes[K] => {
    const size = field(stored, key);
    const [min, max] = PANE_BOUNDS[key];
    return typeof size === "number" && Number.isFinite(size) && size >= min && size <= max ? size : DEFAULT_PREFERENCES.panes[key];
  };
  return {
    theme: THEMES.includes(theme) ? (theme as Theme) : DEFAULT_PREFERENCES.theme,
    darkPalette: DARK_PALETTES.includes(darkPalette) ? (darkPalette as DarkPalette) : DEFAULT_PREFERENCES.darkPalette,
    density: density === "comfortable" ? "comfortable" : "compact",
    panes: { fileLane: pane("fileLane"), sidebar: pane("sidebar"), fileBand: pane("fileBand"), tray: pane("tray"), commitDock: pane("commitDock"), detailsDock: pane("detailsDock") },
  };
}

/** Any invalid value reads as its default. A storage failure reads as the defaults. */
export function readPreferences(storage: PreferenceStorage): Preferences {
  try {
    const text = storage.getItem(KEY);
    return sanitize(text === null ? null : JSON.parse(text));
  } catch {
    return sanitize(null);
  }
}

/** Stores only the sanitized fields. A storage failure is ignored, so rendering never breaks. */
export function writePreferences(storage: PreferenceStorage, preferences: Preferences): void {
  try {
    storage.setItem(KEY, JSON.stringify(sanitize(preferences)));
  } catch {}
}

/** Stores the changed pane sizes. A constrained layout never overwrites the remembered sizes (plan.md "Store pane sizes in logical units"). */
export function storePanes(storage: PreferenceStorage | null, preferences: Preferences, profile: Profile, panes: Partial<Panes>): Preferences {
  if (profile === "constrained") return preferences;
  const next = { ...preferences, panes: { ...preferences.panes, ...panes } };
  if (storage !== null) writePreferences(storage, next);
  return next;
}
