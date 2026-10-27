// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { Catalog } from "./src/contracts/dictionaries.ts";
import { bundleProblems } from "./src/frontend/highlight/guard.ts";

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
  // 006 plan.md D9: `dictionary-en` 4.0.0 exports only `index.js`, so the `?raw` imports of its files take the package folder.
  { find: /^dictionary-en\//, replacement: fileURLToPath(new URL("./node_modules/dictionary-en/", import.meta.url)) },
  // `hunspell-wasm` 0.3.0 has no browser entry. Its Node-only paths import these modules, so a call throws instead of reading an empty external.
  { find: /^(fs\/promises|module)$/, replacement: fileURLToPath(new URL("./src/frontend/spelling/node-stub.ts", import.meta.url)) },
];

/** Fails the build when a chunk holds a grammar or theme outside the shipped set, or Oniguruma WASM. */
function highlightGuard(complete: boolean): Plugin {
  return {
    name: "arbareto-highlight-guard",
    generateBundle(_options, bundle) {
      const ids: string[] = [];
      const texts: { file: string; text: string; bytes?: Uint8Array }[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk") {
          ids.push(...item.moduleIds);
          texts.push({ file: item.fileName, text: item.code });
        } else if (typeof item.source === "string") texts.push({ file: item.fileName, text: item.source });
        else texts.push({ file: item.fileName, text: new TextDecoder().decode(item.source), bytes: item.source });
      }
      const problems = bundleProblems(ids, texts, complete);
      if (problems.length > 0) this.error(`highlight set:\n${problems.join("\n")}`);
    },
  };
}

/** 006 plan.md D3: a catalog outside the `Catalog` rules stops the renderer build. */
export function catalogCheck(file = fileURLToPath(new URL("./src/contracts/dictionaries.json", import.meta.url))): Plugin {
  return { name: "arbareto-catalog", buildStart: () => void Catalog.parse(JSON.parse(readFileSync(file, "utf8"))) };
}

export default defineConfig({
  root,
  plugins: [catalogCheck(), react(), tailwindcss(), highlightGuard(true)],
  resolve: { alias },
  worker: { format: "es", plugins: () => [highlightGuard(false)] },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    // The app loads its chunks from local disk, so the cost is parse time at startup (SC-006), not download. The budget sits above the 2026-10-11 main chunk (575.5 kB, about 75% react-dom and @base-ui/react).
    chunkSizeWarningLimit: 650,
  },
});
