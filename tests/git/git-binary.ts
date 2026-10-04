// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe } from "bun:test";

function findGit(): string | null {
  const path = process.env.ARBARETO_TEST_GIT || Bun.which("git");
  if (!path) {
    console.log("SKIP: Git executable absent");
    return null;
  }
  const probe = Bun.spawnSync([path, "version", "--build-options"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) throw new Error(`Git probe failed: ${path} exited ${probe.exitCode}`);
  console.log(`GIT ${path}`);
  for (const line of probe.stdout.toString().trimEnd().split(/\r?\n/)) console.log(`GIT ${line}`);
  return path;
}

export const GIT: string | null = findGit();

// Runs `body` with the Git path. Skips the block when no Git exists, and off Windows when `windowsCapability` names a Windows feature that it needs.
export function describeGit(name: string, body: (git: string) => void, windowsCapability?: string): void {
  if (GIT === null) {
    describe.skip(`${name} (SKIP: Git executable absent)`, () => {});
    return;
  }
  const git = GIT;
  if (windowsCapability === undefined) return describe(name, () => body(git));
  describe.skipIf(process.platform !== "win32")(`${name} (needs ${windowsCapability})`, () => body(git));
}
