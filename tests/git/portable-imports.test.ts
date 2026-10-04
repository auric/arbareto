// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

const CHILD_TIMEOUT_MS = 60_000;

// Constitution "Architecture Constraints": shared test code stays portable. The child run fakes Linux, and its preload fails each `dlopen` call.
test(
  "the generic harness modules load off Windows without kernel32, and the Windows-only suites skip",
  () => {
    const child = Bun.spawnSync(
      [process.execPath, "test", "--preload", "./tests/git/off-windows-preload.ts", "./tests/git/bun-runner.test.ts", "./tests/git/git-installation.test.ts"],
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

// Shared TypeScript takes native path rules only from `src/contracts/native-path.ts`. The transpiler drops comments and type-only imports.
const SRC = join(import.meta.dir, "..", "..", "src");
const PLATFORM_FILES = ["contracts/native-path.ts", "contracts/remedy-command.ts", "contracts/wsl-route.ts"];
const BANNED: [string, RegExp][] = [
  ["win32", /win32/g],
  ["git.exe", /git\\?\.exe(?![A-Za-z0-9_])/gi],
  ["drive-letter class", /\[(?:A-Za-z|a-zA-Z|A-Z|a-z)\]:/g],
  ["process.platform", /process\.platform/g],
  ["fold-ascii import", /["'][^"'\n]*fold-ascii(?:\.ts)?["']/g],
];
// The renderer runs in WebView2, which has no `process`. Any other runtime import can load `native-path.ts`.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\n]+)["']/g;
const FRONTEND_PACKAGES = /^(?:@tauri-apps\/|react(?:-dom)?(?:\/|$))/;
const leavesFrontend = (file: string, specifier: string) =>
  specifier.startsWith(".") ? !posix.join(posix.dirname(file), specifier).startsWith("frontend/") : !FRONTEND_PACKAGES.test(specifier);

// `file` is the path below `src/` with slashes.
function scanHits(file: string, source: string): string[] {
  const output = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(source);
  const hits: string[] = [];
  for (const [name, pattern] of PLATFORM_FILES.includes(file) ? [] : BANNED) {
    const count = output.match(pattern)?.length ?? 0;
    if (count > 0) hits.push(`src/${file}: ${name} x${count}`);
  }
  if (file.startsWith("frontend/")) {
    for (const [, specifier] of output.matchAll(SPECIFIER)) if (leavesFrontend(file, specifier)) hits.push(`src/${file}: runtime import ${specifier}`);
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
  ["git-service/x.ts", "export const drive = /^[a-zA-Z]:[\\\\/]/;"],
  ["git-service/x.ts", "export const drive = /^[A-Z]:/i;"],
  ["git-service/x.ts", "export const drive = /^[a-z]:/i;"],
  ["git-service/x.ts", "export const drive = /^[A-Za-z]:/;"],
  ["git-service/x.ts", 'export const path = "C:\\\\Git\\\\cmd\\\\GIT.EXE";'],
  ["git-service/x.ts", 'export const name = "git.exe";'],
  ["git-service/x.ts", "export const leaf = /[\\\\/]git\\.exe$/i;"],
  ["git-service/x.ts", "export const path = (dir: string) => `${dir}/git.exe`;"],
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
test("the scan permits type-only imports, the Tauri API, React, and frontend modules in the frontend", () => {
  const source = [
    'import type { Environment } from "../../contracts/envelope";',
    'import { invoke } from "@tauri-apps/api/core";',
    'import { useState } from "react";',
    'import { createRoot } from "react-dom/client";',
    'import { request } from "../bridge";',
    "export const used: [unknown, unknown, unknown, unknown] = [invoke, useState, createRoot, request];",
    "export type Shown = Environment;",
  ].join("\n");
  expect(scanHits("frontend/boot/BootView.tsx", source)).toEqual([]);
});
