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

// Runs `body` with the Git path. Skips the block when no Git exists, or when `missing` names a missing capability (`missingCapability` of `service-harness.ts`).
export function describeGit(name: string, body: (git: string) => void, missing?: string | null): void {
  if (GIT === null) {
    describe.skip(`${name} (SKIP: Git executable absent)`, () => {});
    return;
  }
  const git = GIT;
  if (missing === undefined || missing === null) return describe(name, () => body(git));
  console.log(`SKIP ${name}: missing capability ${missing} (unverified)`);
  describe.skip(`${name} (SKIP: missing capability ${missing})`, () => body(git));
}
