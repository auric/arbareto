// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
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
