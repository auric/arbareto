// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture builders F30 (T066). `fixture-root.ts` prints the ORIGIN of its contract file.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkSubmodules, fixtureChecks, git1, TIMEOUT } from "./fixture-checks";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import * as F from "./fixtures";

describeGit("fixture builders: F30", (git) => {
  useFixtureRoot();

  describe("cases", () => {
    const { check, filemodeTest } = fixtureChecks(git);

    for (const variant of ["clone", "silent-hook", "child-hook", "silent-fetch", "stall"] as const) {
      test(`F30 ${variant}`, () =>
        check(`F30 ${variant}`, (n) => F.buildF30(git, n, variant), (g, b) => {
          checkSubmodules(g, b);
          const sup = join(b.root, "super");
          const subs = b.facts.notes.submodules as Record<string, { recorded: string }>;
          if (variant === "clone" || variant === "silent-fetch") {
            expect(Number(git1(g, join(b.root, "big.git"), ["cat-file", "-s", `${subs.big!.recorded}:big.bin`]).toString())).toBe(F.F30_BIG_BYTES);
            if (variant === "silent-fetch") git1(g, join(sup, "big"), ["--no-lazy-fetch", "cat-file", "-e", subs.big!.recorded], [1, 128]);
          }
          if (variant === "silent-hook" || variant === "child-hook") expect(git1(g, join(sup, "solo"), ["hook", "list", "-z", "post-checkout"]).toString().split("\0").filter((r) => r !== "").length).toBe(1);
          if (variant === "child-hook") expect(readdirSync(join(b.root, b.facts.notes.records as string))).toEqual([]);
          if (variant === "stall") {
            const s = join(sup, "solo");
            expect(git1(g, s, ["config", "--local", "--get", "remote.origin.url"]).toString().trim()).toBe(F.F30_SSH_URL);
            expect(git1(g, s, ["config", "--local", "--get", "core.sshCommand"]).toString().trim().endsWith(" #")).toBe(true);
            for (const file of [b.facts.notes.key as string, `${b.facts.notes.key}.pub`]) expect(existsSync(join(b.root, file))).toBe(true);
            git1(g, s, ["--no-lazy-fetch", "cat-file", "-e", subs.solo!.recorded], [1, 128]);
          }
        }), TIMEOUT);
    }

    filemodeTest();
  });
});
