// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe } from "bun:test";
import { lstatSync } from "node:fs";
import { join } from "node:path";

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

export class FixtureGitError extends Error {}

// The Git for Windows launcher starts the core `git.exe` of `git --exec-path` as a child process. Fixture starts skip that process.
function findCoreGit(git: string | null): string | null {
  if (git === null || process.platform !== "win32") return git;
  const proc = Bun.spawnSync([git, "--exec-path"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const match = /^([^\r\n]+)\n$/.exec(proc.stdout.toString());
  if (proc.exitCode !== 0 || match === null) throw new FixtureGitError(`${git} --exec-path exited ${proc.exitCode} without exactly one folder line`);
  const core = join(match[1]!, "git.exe");
  let regular = false;
  try {
    regular = lstatSync(core).isFile();
  } catch {}
  if (!regular) throw new FixtureGitError(`no regular file ${core} (from ${git} --exec-path)`);
  console.log(`GIT_CORE ${core} (from ${git} --exec-path)`);
  return core;
}

// Fixture and helper starts use this Git. The service under test and the Git selection tests use `GIT`.
export const FIXTURE_GIT: string | null = findCoreGit(GIT);

// Maps the test Git to `FIXTURE_GIT`. Any other Git path stays unchanged.
export function fixtureGitPath(git: string): string {
  return git === GIT && FIXTURE_GIT !== null ? FIXTURE_GIT : git;
}

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
