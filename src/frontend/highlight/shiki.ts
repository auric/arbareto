// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// vite.config.ts aliases `shiki` to this module. Its exports equal the names Pierre imports from `shiki` (tests/contracts/highlight.test.ts).

import {
  createBundledHighlighter,
  createCssVariablesTheme,
  createSingletonShorthands,
  getTokenStyleObject,
  guessEmbeddedLanguages,
  stringifyTokenStyle,
  type DynamicImportLanguageRegistration,
  type DynamicImportThemeRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createOnigurumaEngine } from "./oniguruma";
import { LANGUAGES, THEMES } from "./set";

/** Each shipped language id and alias, mapped to its grammar loader. */
export const bundledLanguages: Record<string, DynamicImportLanguageRegistration> = Object.fromEntries(
  Object.entries(LANGUAGES).flatMap(([id, { aliases, load }]) => [id, ...aliases].map((name) => [name, load])),
);
const bundledThemes: Record<string, DynamicImportThemeRegistration> = Object.fromEntries(Object.entries(THEMES).map(([name, { load }]) => [name, load]));

export const createHighlighter = createBundledHighlighter({ langs: bundledLanguages, themes: bundledThemes, engine: () => createJavaScriptRegexEngine() });
export const { codeToHtml } = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
export { createCssVariablesTheme, createJavaScriptRegexEngine, createOnigurumaEngine, getTokenStyleObject, stringifyTokenStyle };
