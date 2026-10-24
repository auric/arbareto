// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const CHILD_TIMEOUT_MS = 60_000;

// Constitution "Architecture Constraints": shared test code stays portable. The child run fakes Linux, and its preload fails each `dlopen` call.
test(
  "the generic harness modules load off Windows without kernel32, and the Windows-only suites skip",
  () => {
    const child = Bun.spawnSync(
      [process.execPath, "test", "--preload", "./tests/git/off-windows-preload.ts", "./tests/git/git-installation.test.ts"],
      { cwd: join(import.meta.dir, "..", ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS },
    );
    const output = `${child.stdout.toString()}${child.stderr.toString()}`;
    console.log(output.replace(/^/gm, "child> "));
    expect(output).toContain("PORTABLE_IMPORTS loaded");
    expect(output).toMatch(/\b0 pass\b/);
    expect(output).toMatch(/\b0 fail\b/);
    expect(child.exitCode).toBe(0);
  },
  CHILD_TIMEOUT_MS + 10_000,
);

// The generic harness loads the host module only through `HOST_SCRIPT`. `scanImports` drops type-only imports.
const HARNESS = import.meta.dir;
const HARNESS_FILES = ["fixture-root.ts", "git-binary.ts", "git-oracle.ts", "bun-runner.ts", "fixtures.ts", "service-harness.ts"];
const HOST_MODULES = ["./win32", "./win32.ts", "./linux", "./linux.ts", "bun:ffi"];

test("the generic harness holds no static import of a host module or bun:ffi", () => {
  // The scan reads test harness files, not a `src/` module, so its root is no ORIGIN line.
  console.log(`SCAN_ROOT ${HARNESS}`);
  const hits: string[] = [];
  for (const file of HARNESS_FILES) {
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(readFileSync(join(HARNESS, file), "utf8"));
    for (const { kind, path } of imports) if (kind === "import-statement" && HOST_MODULES.includes(path)) hits.push(`tests/git/${file}: ${path}`);
  }
  console.log(hits.map((hit) => `SCAN_HIT ${hit}`).join("\n"));
  expect(hits).toEqual([]);
});

// Shared TypeScript takes native path rules only from `src/contracts/native-path.ts`, and the renderer takes the DOS drive rule from `drive-prefix.ts`.
// The transpiler drops comments and type-only imports.
const SRC = join(import.meta.dir, "..", "..", "src");
const PLATFORM_FILES = ["contracts/native-path.ts", "contracts/drive-prefix.ts", "contracts/remedy-command.ts", "contracts/wsl-route.ts"];
const BANNED: [string, RegExp][] = [
  ["win32", /win32/g],
  ["git.exe", /git\\?\.exe(?![A-Za-z0-9_])/gi],
  ["drive-letter class", /\[(?:A-Za-z|a-zA-Z|A-Z|a-z)\]:/g],
  ["process.platform", /process\.platform/g],
  ["fold-ascii import", /["'][^"'\n]*fold-ascii(?:\.ts)?["']/g],
];
// The renderer runs in WebView2, which has no `process`. Any other runtime import can load `native-path.ts`.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\n]+)["']/g;
// The renderer packages of 001 research.md R9 (T003, T123) and 006 research.md R2. A package cannot load a `src/` module.
const FRONTEND_PACKAGES =
  /^(?:@tauri-apps\/|(?:react|react-dom|@base-ui\/react|@pierre\/diffs|shiki|@shikijs\/transformers|@tanstack\/react-virtual|cn|class-variance-authority|@hugeicons\/react|@hugeicons\/core-free-icons|hunspell-wasm|dictionary-en)(?:\/|$))/;
const transpile = (file: string, source: string) =>
  new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(source);
// A contracts module without `process`, whose runtime imports are only leaf contracts, cannot load `native-path.ts` or fail in WebView2.
// A JSON file cannot import code or read `process`. `seen` stops an import cycle. Each module of the cycle still passes its own check.
const isLeafContract = (target: string, seen = new Set<string>()): boolean => {
  if (!/^contracts\/[^/]+$/.test(target)) return false;
  if (target.endsWith(".json")) return existsSync(join(SRC, target));
  const name = target.replace(/\.ts$/, "");
  if (seen.has(name)) return true;
  seen.add(name);
  const path = join(SRC, `${name}.ts`);
  if (!existsSync(path)) return false;
  const output = transpile(path, readFileSync(path, "utf8"));
  if (/\bprocess\b/.test(output)) return false;
  return [...output.matchAll(SPECIFIER)].every(([, specifier]) => specifier!.startsWith("./") && isLeafContract(posix.join("contracts", specifier!), seen));
};
// `tsconfig.json` `paths` and the Vite `alias` map `@/` to `src/frontend/`.
const leavesFrontend = (file: string, specifier: string) => {
  const target = specifier.startsWith("@/") ? posix.join("frontend", specifier.slice(2))
    : specifier.startsWith(".") ? posix.join(posix.dirname(file), specifier) : undefined;
  if (target === undefined) return !FRONTEND_PACKAGES.test(specifier);
  return !target.startsWith("frontend/") && !isLeafContract(target);
};
// Contract §7 "Program file digests" (T309): the trust listing reads hook and program files only through `fileFacts`.
const FS_FREE_FILES = ["git-service/trust.ts"];
const FS_MODULES = ["node:fs", "node:fs/promises", "fs", "fs/promises"];

// `file` is the path below `src/` with slashes.
function scanHits(file: string, source: string): string[] {
  const output = transpile(file, source);
  const hits: string[] = [];
  for (const [name, pattern] of PLATFORM_FILES.includes(file) ? [] : BANNED) {
    const count = output.match(pattern)?.length ?? 0;
    if (count > 0) hits.push(`src/${file}: ${name} x${count}`);
  }
  if (file.startsWith("frontend/")) {
    for (const [, specifier] of output.matchAll(SPECIFIER)) if (leavesFrontend(file, specifier)) hits.push(`src/${file}: runtime import ${specifier}`);
  }
  if (FS_FREE_FILES.includes(file)) {
    for (const [, specifier] of output.matchAll(SPECIFIER)) if (FS_MODULES.includes(specifier)) hits.push(`src/${file}: runtime import ${specifier}`);
  }
  return hits;
}

test("shared source outside the platform files holds no native path rule", () => {
  console.log(`ORIGIN ${SRC}`);
  const hits: string[] = [];
  let scanned = 0;
  for (const found of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })) {
    const file = found.replaceAll("\\", "/");
    hits.push(...scanHits(file, readFileSync(join(SRC, file), "utf8")));
    scanned += 1;
  }
  console.log(hits.map((hit) => `SCAN_HIT ${hit}`).join("\n"));
  expect(scanned).toBeGreaterThan(0);
  expect(hits).toEqual([]);
});

// Control fixtures: each source must give a hit.
test.each([
  ["frontend/bridge.ts", 'import { checkContext } from "../git-service/git-runner";\ncheckContext;'],
  ["frontend/boot/BootView.tsx", 'import { z } from "zod";\nz;'],
  ["frontend/main.tsx", 'void import("../git-service/main");'],
  ["frontend/main.tsx", 'import { x } from "@/../git-service/main";\nx;'],
  ["frontend/history/AncestryCell.tsx", 'import { ChannelPath } from "../../contracts/operations";\nChannelPath;'],
  ["frontend/history/AncestryCell.tsx", 'import { NATIVE } from "../../contracts/native-path";\nNATIVE;'],
  ["frontend/spelling/store.ts", 'import x from "../../contracts/absent.json";\nx;'],
  ["frontend/spelling/store.ts", 'import x from "../../contracts/schemas/progress.schema.json";\nx;'],
  ["frontend/lib/path.ts", "export const drive = /^[A-Za-z]:/;"],
  ["git-service/x.ts", "export const drive = /^[a-zA-Z]:[\\\\/]/;"],
  ["git-service/x.ts", "export const drive = /^[A-Z]:/i;"],
  ["git-service/x.ts", "export const drive = /^[a-z]:/i;"],
  ["git-service/x.ts", "export const drive = /^[A-Za-z]:/;"],
  ["git-service/x.ts", 'export const path = "C:\\\\Git\\\\cmd\\\\GIT.EXE";'],
  ["git-service/x.ts", 'export const name = "git.exe";'],
  ["git-service/x.ts", "export const leaf = /[\\\\/]git\\.exe$/i;"],
  ["git-service/x.ts", "export const path = (dir: string) => `${dir}/git.exe`;"],
  ["git-service/trust.ts", 'import { constants } from "node:fs";\nconstants;'],
  ["git-service/trust.ts", 'import { lstat } from "node:fs/promises";\nlstat;'],
])("the scan finds the rule break in %s: %s", (file, source) => {
  expect(scanHits(file, source)).not.toEqual([]);
});

// Control fixtures: property names that start with `exe` give no hit.
test.each([
  ["git-service/x.ts", "export const path = (git: { executablePath: string }) => git.executablePath;"],
  ["git-service/x.ts", "export const id = (git: { executableIdentity: string }) => git.executableIdentity;"],
])("the scan permits %s: %s", (file, source) => {
  expect(scanHits(file, source)).toEqual([]);
});

// Control fixture: type-only imports and the permitted runtime imports give no hit.
test("the scan permits type-only imports, the renderer packages, frontend modules, and leaf contracts in the frontend", () => {
  const source = [
    'import type { Environment } from "../../contracts/envelope";',
    'import { invoke } from "@tauri-apps/api/core";',
    'import { useState } from "react";',
    'import { createRoot } from "react-dom/client";',
    'import { request } from "../bridge";',
    'import { Button } from "@/components/ui/button";',
    'import { GRAPH_LANES } from "../../contracts/limits";',
    'import { suggestCloneName } from "../../contracts/clone-name";',
    'import { createHunspellFromStrings } from "hunspell-wasm";',
    'import aff from "dictionary-en/index.aff?raw";',
    'const catalog = import("../../contracts/dictionaries.json");',
    "export const used = [invoke, useState, createRoot, request, Button, GRAPH_LANES, suggestCloneName, createHunspellFromStrings, aff, catalog];",
    "export type Shown = Environment;",
  ].join("\n");
  expect(scanHits("frontend/boot/BootView.tsx", source)).toEqual([]);
});
