// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { FILE_LANE, type Density } from "../layout/profiles";

// Bounded view scalars only. A preference never grants a Git permission, and no mode is stored (FR-034).

export type Theme = "system" | "light" | "dark";
export type Preferences = { theme: Theme; density: Density; panes: { fileLane: number } };
export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", density: "compact", panes: { fileLane: FILE_LANE.default } };

const KEY = "arbareto.preferences.v1";
const THEMES: readonly unknown[] = ["system", "light", "dark"];

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

function sanitize(value: unknown): Preferences {
  const theme = field(value, "theme");
  const density = field(value, "density");
  const fileLane = field(field(value, "panes"), "fileLane");
  return {
    theme: THEMES.includes(theme) ? (theme as Theme) : DEFAULT_PREFERENCES.theme,
    density: density === "comfortable" ? "comfortable" : "compact",
    panes: {
      fileLane: typeof fileLane === "number" && fileLane >= FILE_LANE.min && fileLane <= FILE_LANE.max ? fileLane : FILE_LANE.default,
    },
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
