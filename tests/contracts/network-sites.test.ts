// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T020: the network call sites (006 spec FR-007, SC-001; contract Δ10). `src/frontend` holds no `fetch(` call. `src/git-service` holds one, in `dictionaries.ts`.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { printOrigin } from "../origin";

const ROOT = join(import.meta.dir, "..", "..");
printOrigin("../../src/git-service/dictionaries.ts", import.meta.dir);

// A call of the global `fetch`: a free `fetch` identifier that is called, or `fetch` read from a global object.
// Bun renames every local binding with `minify.identifiers` and keeps each free name, so a local function named `fetch` (sync.ts) does not count.
const CALL = /(?<![\w$.])fetch\s*\(|\b(?:globalThis|window|self)\s*\.\s*fetch\b/g;

async function sites(dir: string): Promise<Record<string, number>> {
  const cwd = join(ROOT, "src", dir);
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd })].filter((f) => !f.endsWith(".d.ts")).map((f) => join(cwd, f));
  expect(files.length).toBeGreaterThan(0);
  const built = await Bun.build({ entrypoints: files, root: cwd, minify: { identifiers: true, whitespace: false, syntax: false }, packages: "external", external: ["*"], target: "browser", throw: false });
  if (!built.success) throw new AggregateError(built.logs, `Bun.build of src/${dir} failed`);
  expect(built.outputs.length).toBe(files.length);
  const found: Record<string, number> = {};
  for (const output of built.outputs) {
    const count = ((await output.text()).match(CALL) ?? []).length;
    if (count > 0) found[relative(cwd, join(cwd, output.path)).replaceAll("\\", "/").replace(/\.js$/, ".ts")] = count;
  }
  return found;
}

test("T020: the rule counts global fetch calls and no local function named fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arbareto-network-sites-"));
  try {
    const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
    write("local.ts", "const fetch = (x: number) => x;\nexport const a = fetch(1);\nexport const o = { fetch: fetch(2) };\n");
    write("global.ts", "export const a = (u: string) => fetch(u);\nexport const b = (u: string) => globalThis.fetch(u);\nexport const c = (f: { fetch(u: string): void }) => f.fetch(\"x\");\n");
    const built = await Bun.build({ entrypoints: [join(dir, "local.ts"), join(dir, "global.ts")], root: dir, minify: { identifiers: true, whitespace: false, syntax: false }, packages: "external", external: ["*"], target: "browser" });
    const counts = Object.fromEntries(await Promise.all(built.outputs.map(async (o) => [o.path.replace(/^\.\//, ""), ((await o.text()).match(CALL) ?? []).length] as const)));
    expect(counts).toEqual({ "local.js": 0, "global.js": 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T020: src/frontend holds no fetch call", async () => {
  expect(await sites("frontend")).toEqual({});
});

test("T020: src/git-service holds exactly one fetch call, in dictionaries.ts", async () => {
  expect(await sites("git-service")).toEqual({ "dictionaries.ts": 1 });
});
