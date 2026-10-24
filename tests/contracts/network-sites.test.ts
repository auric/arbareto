// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T020: the network call sites (006 spec FR-007, SC-001; contract Δ10). `src/frontend` holds no `fetch(` call. `src/git-service` holds one, in `dictionaries.ts`.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";

const ROOT = join(import.meta.dir, "..", "..");
printOrigin("../../src/git-service/dictionaries.ts", import.meta.dir);

// A call of `fetch`: a `fetch` identifier that is called, or `fetch` read from a global object. The transpiler drops comments, as in portable-imports.test.ts.
// A local binding named `fetch` counts too, so a new one fails the test.
const CALL = /(?<![\w$.])fetch\s*\(|\b(?:globalThis|window|self)\s*\.\s*fetch\b/g;
const count = (file: string, source: string) => (new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(source).match(CALL) ?? []).length;

function sites(dir: string): Record<string, number> {
  const cwd = join(ROOT, "src", dir);
  const found: Record<string, number> = {};
  let scanned = 0;
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd })) {
    if (file.endsWith(".d.ts")) continue;
    scanned += 1;
    const n = count(file, readFileSync(join(cwd, file), "utf8"));
    if (n > 0) found[file.replaceAll("\\", "/")] = n;
  }
  expect(scanned).toBeGreaterThan(0);
  return found;
}

test.each([
  ["export const a = (u: string) => fetch(u);", 1],
  ["export const b = (u: string) => globalThis.fetch(u);", 1],
  ["export const c = (f: { fetch(u: string): void }) => f.fetch(\"x\");", 0],
  ["// git-fetch(1)\n/** fetch(x) */\nexport const d = 1;", 0],
  ["const fetch = (x: number) => x;\nexport const e = fetch(1);", 1],
] as const)("T020: the rule counts %j as %d", (source, n) => {
  expect(count("x.ts", source)).toBe(n);
});

test("T020: src/frontend holds no fetch call", () => {
  expect(sites("frontend")).toEqual({});
});

test("T020: src/git-service holds exactly one fetch call, in dictionaries.ts", () => {
  expect(sites("git-service")).toEqual({ "dictionaries.ts": 1 });
});
