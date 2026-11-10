// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureDir, useFixtureRoot } from "../git/fixture-root";
import { describeGit } from "../git/git-binary";
import { gitExit } from "../git/history-diff-fixtures";
import { submoduleWorld } from "./submodule-perf-fixture";

// This file imports no `src/` module, so it prints no ORIGIN line for `src/`.
printOrigin("./submodule-perf-fixture.ts", import.meta.dir);

useFixtureRoot();

describeGit("T108 submodule fixture reuse", (git) => {
  test("an entry without the parent index is rebuilt, and a clean entry is reused", () => {
    // Never PERF_CACHE_ROOT: this test damages its entry.
    const root = fixtureDir("submodule-cache");
    const status = (repo: string) => gitExit(git, FIXTURE_ROOT, repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--ignore-submodules=none", "--untracked-files=all"]);
    const first = submoduleWorld(git, 3, root);
    const marker = join(root, "f005-submodules-3", "marker");
    writeFileSync(marker, "");
    rmSync(join(first.repo, ".git", "index"));
    expect(status(first.repo).stdout.length).toBeGreaterThan(0);
    const second = submoduleWorld(git, 3, root);
    expect(existsSync(marker)).toBe(false);
    const after = status(second.repo);
    expect([after.exitCode, after.stdout.length]).toEqual([0, 0]);
    writeFileSync(marker, "");
    submoduleWorld(git, 3, root);
    expect(existsSync(marker)).toBe(true);
  });
});
