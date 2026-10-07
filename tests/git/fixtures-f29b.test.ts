// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture builders F29, second part (T066). `fixture-root.ts` prints the ORIGIN of its contract file.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { checkSubmodules, fixtureChecks, git1, TIMEOUT } from "./fixture-checks";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import * as F from "./fixtures";

describeGit("fixture builders: F29, second part", (git) => {
  useFixtureRoot();

  describe("cases", () => {
    const { check, filemodeTest } = fixtureChecks(git);

    for (const variant of (["base", "kept-folder", "kept-nested", "gitdir-extension", "gitdir-outside", "gitdir-nested", "relative-hooks", "nested-programs", "row-programs"] as const).slice(5)) {
      test(`F29 ${variant}`, () =>
        check(`F29 ${variant}`, (n) => F.buildF29(git, n, variant), (g, b) => {
          checkSubmodules(g, b);
          const sup = join(b.root, "super");
          const inDir = (dir: string, args: string[], allowExit = [0]) => git1(g, b.root, ["--git-dir", dir, "--work-tree", dir, ...args], allowExit).toString();
          // Each hook file must name a hook event of this Git: `hook list` exits 0 with one record, and an unknown name exits 1.
          for (const [label, rel] of Object.entries((b.facts.notes.programs as Record<string, string> | undefined) ?? {})) {
            const dir = join(b.root, rel);
            for (const event of F.F29_HOOK_EVENTS) expect(`${label} ${event} ${inDir(dir, ["hook", "list", "-z", event], [0, 1]).split("\0").filter((r) => r !== "").length}`).toBe(`${label} ${event} 1`);
            for (const key of ["core.fsmonitor", "filter.f29.clean", "filter.f29.smudge", "core.sshCommand", "credential.helper", "remote.origin.uploadpack"]) expect(git1(g, b.root, ["config", "--file", join(dir, "config"), "--get", key]).length).toBeGreaterThan(0);
            expect(readFileSync(join(dir, "info", "attributes"), "utf8")).toBe("* filter=f29\n");
          }
          const superConfig = (key: string) => git1(g, sup, ["config", "--local", "--get", key], [0, 1]).toString().trim();
          switch (variant) {
            case "base":
              expect(superConfig("submodule.ext.url").startsWith("ext::")).toBe(true);
              git1(g, b.root, ["config", "--file", join(b.root, b.facts.notes.globalNoFile as string), "--get", "protocol.file.allow"], [1]);
              break;
            case "kept-folder":
              git1(g, b.root, ["--git-dir", join(b.root, b.facts.notes.nonGitFolder as string), "rev-parse", "--absolute-git-dir"], [128]);
              expect(Object.keys(b.facts.notes.kept as Record<string, string>).sort()).toEqual(["grouped", "mid", "mid/leaf"]);
              break;
            case "gitdir-extension":
              expect([superConfig("core.repositoryformatversion"), superConfig("extensions.submodulePathConfig")]).toEqual(["1", "true"]);
              break;
            case "gitdir-outside":
              expect(superConfig("submodule.solo.gitdir")).not.toBe("");
              break;
            case "gitdir-nested":
              expect(git1(g, b.root, ["config", "--file", join(b.root, (b.facts.notes.programs as Record<string, string>).mid!, "config"), "--get", "submodule.leaf.gitdir"]).length).toBeGreaterThan(0);
              break;
            case "relative-hooks": {
              const { A, B } = b.facts.notes.commits as { A: string; B: string };
              const global = join(b.root, b.facts.notes.globalConfig as string);
              expect(git1(g, b.root, ["config", "--file", global, "--get", "core.hooksPath"]).toString().trim()).toBe(".githooks");
              git1(g, join(sup, "hk-checkout"), ["cat-file", "-e", B]);
              git1(g, join(sup, "hk-fetch"), ["--no-lazy-fetch", "cat-file", "-e", B], [1, 128]);
              expect(git1(g, join(sup, "hk-checkout"), ["ls-tree", "--format=%(objectmode) %(path)", A, ".githooks/"]).toString()).toBe("100755 .githooks/post-checkout\n100755 .githooks/reference-transaction\n");
              break;
            }
          }
        }), TIMEOUT);
    }

    filemodeTest();
  });
});
