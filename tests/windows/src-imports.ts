// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Lists each import under src/ of `bun:ffi` or of one of `targets` (absolute paths of test-only scripts).
export function srcImportHits(targets: string[]): string[] {
  const src = resolve(import.meta.dir, "..", "..", "src");
  const stems = new Set(targets.map((t) => t.replace(/\.ts$/, "")));
  const hits: string[] = [];
  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const loader = entry.name.endsWith(".tsx") ? "tsx" : entry.name.endsWith(".ts") ? "ts" : "js";
    for (const { path } of new Bun.Transpiler({ loader }).scanImports(readFileSync(file, "utf8"))) {
      if (path === "bun:ffi" || (path.startsWith(".") && stems.has(resolve(dirname(file), path).replace(/\.ts$/, "")))) hits.push(`${file}: ${path}`);
    }
  }
  console.log(`SCAN_ROOT ${src}`);
  return hits;
}
