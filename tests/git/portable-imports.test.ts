// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  ["git.exe", /git\\?\.exe/gi],
  ["[A-Za-z]:", /\[A-Za-z\]:/g],
  ["process.platform", /process\.platform/g],
  ["fold-ascii import", /["'][^"'\n]*fold-ascii(?:\.ts)?["']/g],
];
const FRONTEND_CONTRACTS = /(?:\bfrom|\bimport)\s*\(?\s*["'][^"'\n]*\bcontracts\//g;

test("shared source outside the platform files holds no native path rule", () => {
  console.log(`ORIGIN ${SRC}`);
  const hits: string[] = [];
  let scanned = 0;
  for (const found of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })) {
    const file = found.replaceAll("\\", "/");
    const output = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(readFileSync(join(SRC, file), "utf8"));
    scanned += 1;
    const rules: [string, RegExp][] = PLATFORM_FILES.includes(file) ? [] : [...BANNED];
    if (file.startsWith("frontend/")) rules.push(["contracts import", FRONTEND_CONTRACTS]);
    for (const [name, pattern] of rules) {
      const count = output.match(pattern)?.length ?? 0;
      if (count > 0) hits.push(`src/${file}: ${name} x${count}`);
    }
  }
  console.log(hits.map((hit) => `SCAN_HIT ${hit}`).join("\n"));
  expect(scanned).toBeGreaterThan(0);
  expect(hits).toEqual([]);
});
