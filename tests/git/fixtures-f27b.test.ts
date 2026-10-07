// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture builders F27, second part (T066). `fixture-root.ts` prints the ORIGIN of its contract file.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkSubmodules, fixtureChecks, git1, paths, TIMEOUT } from "./fixture-checks";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import * as F from "./fixtures";

describeGit("fixture builders: F27, second part", (git) => {
  useFixtureRoot();

  describe("cases", () => {
    const { check, filemodeTest } = fixtureChecks(git);

    for (const variant of (["base", "behind-present", "behind-fetch", "deinit-kept", "update-none", "literal-paths", "kept-remote", "spaces", "token-url", "unreachable-target", "headless-kept"] as const).slice(6)) {
      test(`F27 ${variant}`, () =>
        check(`F27 ${variant}`, (n) => F.buildF27(git, n, variant), (g, b) => {
          checkSubmodules(g, b);
          if (variant === "unreachable-target") {
            const u = b.facts.notes.unreachable as { path: string; target: string };
            // research.md R14 S23: `rev-list -n 1 <target> --not --all` prints a target that is present without a ref.
            expect(git1(g, join(b.root, "super", u.path), ["rev-list", "-n", "1", u.target, "--not", "--all"]).toString().trim()).toBe(u.target);
          }
        }), TIMEOUT);
    }

    filemodeTest();
  });
});
