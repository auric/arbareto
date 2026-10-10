// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { bundleProblems } from "./src/frontend/highlight/guard";

const root = fileURLToPath(new URL("./src/frontend", import.meta.url));
const highlight = (file: string) => fileURLToPath(new URL(`./src/frontend/highlight/${file}`, import.meta.url));

// research.md R9: Pierre 1.5.1 has no hook for the bundled Shiki set, so these exact module ids point at the shipped set only.
// tests/contracts/highlight.test.ts fails when Pierre imports a name that these modules do not export.
const alias = [
  { find: "@", replacement: root },
  { find: /^shiki$/, replacement: highlight("shiki.ts") },
  { find: /^shiki\/engine\/oniguruma$/, replacement: highlight("oniguruma.ts") },
  { find: /^shiki\/wasm$/, replacement: highlight("wasm.ts") },
  { find: /^@pierre\/theming\/themes$/, replacement: highlight("themes.ts") },
];

/** Fails the build when a chunk holds a grammar or theme outside the shipped set, or Oniguruma WASM. */
function highlightGuard(complete: boolean): Plugin {
  return {
    name: "arbareto-highlight-guard",
    generateBundle(_options, bundle) {
      const ids: string[] = [];
      const texts: { file: string; text: string }[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk") {
          ids.push(...item.moduleIds);
          texts.push({ file: item.fileName, text: item.code });
        } else texts.push({ file: item.fileName, text: typeof item.source === "string" ? item.source : new TextDecoder().decode(item.source) });
      }
      const problems = bundleProblems(ids, texts, complete);
      if (problems.length > 0) this.error(`highlight set:\n${problems.join("\n")}`);
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), highlightGuard(true)],
  resolve: { alias },
  worker: { format: "es", plugins: () => [highlightGuard(false)] },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
