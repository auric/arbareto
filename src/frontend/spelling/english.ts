// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 006 plan.md D9: the bundled `dictionary-en` files. `?raw` puts the text into the worker chunk, so no request leaves the app.
// The `dictionary-en/` alias in vite.config.ts points at the package folder, because the package exports only `index.js`.
export async function englishFiles(): Promise<{ aff: string; dic: string }> {
  const [aff, dic] = await Promise.all([import("dictionary-en/index.aff?raw"), import("dictionary-en/index.dic?raw")]);
  return { aff: aff.default, dic: dic.default };
}

/** 006 plan.md D12: Show licence of English reads the bundled `license` text. */
export const englishLicence = async (): Promise<string> => (await import("dictionary-en/license?raw")).default;
