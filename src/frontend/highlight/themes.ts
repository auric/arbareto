// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// vite.config.ts aliases `@pierre/theming/themes` to this module. Its exports equal the names Pierre imports (tests/contracts/highlight.test.ts).
// @pierre/theming 1.0.1 `themes.js` lists 10 Pierre and 65 Shiki themes. Pierre reads only `pierreThemes.getThemes()` and `shikiThemes.getTheme()`.

import { normalizeTheme, type ThemeRegistrationAny } from "shiki/core";
import { THEMES } from "./set";

type Descriptor = { name: string; colorScheme?: "light" | "dark"; collection?: string; displayName?: string; load: () => Promise<ThemeRegistrationAny> };
type Source = { name: string; load: () => Promise<unknown>; colorScheme?: "light" | "dark"; collection?: string; displayName?: string };

const unwrapDefault = (value: unknown) => (value !== null && typeof value === "object" && "default" in value ? value.default : value);

/** @pierre/theming 1.0.1 `createTheme`: the loader result is normalized by Shiki. */
export function createTheme({ name, load, colorScheme, collection, displayName }: Source): Descriptor {
  return { name, colorScheme, collection, displayName, load: async () => normalizeTheme(unwrapDefault(await load()) as ThemeRegistrationAny) };
}

const collection = (descriptors: Descriptor[]) => ({
  getTheme: (name: string) => descriptors.find((d) => d.name === name),
  getThemes: () => descriptors,
});

export const pierreThemes = collection([]);
export const shikiThemes = collection(Object.entries(THEMES).map(([name, { colorScheme, load }]) => createTheme({ name, colorScheme, collection: "shiki", load })));
