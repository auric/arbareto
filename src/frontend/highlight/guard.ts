// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// research.md R9: the bundle check that vite.config.ts runs on the page build and the worker build.
// It reads the Rolldown module ids of each chunk and the emitted text. File names of chunks are not a contract.

import { LANGUAGES, THEMES } from "./set";

const GRAMMAR = /[\\/]node_modules[\\/](?:@shikijs[\\/]langs[\\/]dist|shiki[\\/]dist[\\/]langs)[\\/]([^\\/]+)\.mjs$/;
const THEME = /[\\/]node_modules[\\/](?:@shikijs[\\/]themes[\\/]dist|shiki[\\/]dist[\\/]themes)[\\/]([^\\/]+)\.mjs$/;
// Modules that only the full Shiki bundle, the Oniguruma engine, or the unused theme collections load.
const REFUSED = [
  /[\\/]node_modules[\\/]@shikijs[\\/]engine-oniguruma[\\/]/,
  /[\\/]node_modules[\\/]shiki[\\/]dist[\\/](?:index|bundle-full|bundle-web|langs|themes|wasm|engine-oniguruma|langs-bundle-full-[^\\/]*)\.mjs$/,
  /[\\/]node_modules[\\/]shiki[\\/]dist[\\/]onig\.wasm$/,
  /[\\/]node_modules[\\/]@pierre[\\/]theme[\\/]/,
  /[\\/]node_modules[\\/]@pierre[\\/]theming[\\/]dist[\\/](?:themes|collections[\\/][^\\/]*)\.js$/,
];
// "AGFzbQ" is the base64 form of the WebAssembly magic bytes "\0asm". `loadWasm` is the Oniguruma loader export.
const WASM_MARKERS = ["AGFzbQ", "loadWasm"];

/**
 * The problems of one build. `moduleIds` lists every module in the output. `texts` holds each emitted chunk and asset as text.
 * `complete` is true for the page build: it must hold every shipped grammar and theme.
 */
export function bundleProblems(moduleIds: string[], texts: { file: string; text: string }[], complete: boolean): string[] {
  const problems: string[] = [];
  const grammars = new Set<string>();
  const themes = new Set<string>();
  for (const id of moduleIds) {
    const clean = id.replace(/^\0/, "").replace(/\?.*$/, "");
    const grammar = GRAMMAR.exec(clean)?.[1];
    const theme = THEME.exec(clean)?.[1];
    if (grammar !== undefined) {
      if (grammar in LANGUAGES) grammars.add(grammar);
      else problems.push(`grammar ${grammar} is not in the shipped set: ${clean}`);
    } else if (theme !== undefined) {
      if (theme in THEMES) themes.add(theme);
      else problems.push(`theme ${theme} is not in the shipped set: ${clean}`);
    } else if (REFUSED.some((pattern) => pattern.test(clean))) problems.push(`refused module: ${clean}`);
  }
  if (complete) {
    for (const name of Object.keys(LANGUAGES)) if (!grammars.has(name)) problems.push(`grammar ${name} is not in the build`);
    for (const name of Object.keys(THEMES)) if (!themes.has(name)) problems.push(`theme ${name} is not in the build`);
  }
  for (const { file, text } of texts) {
    if (file.endsWith(".wasm")) problems.push(`WebAssembly file: ${file}`);
    for (const marker of WASM_MARKERS) if (text.includes(marker)) problems.push(`${file} holds ${marker}`);
  }
  return problems;
}
