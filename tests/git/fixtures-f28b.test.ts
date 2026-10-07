// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture builders F28, second part (T066). `fixture-root.ts` prints the ORIGIN of its contract file.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSubmodules, fixtureChecks, git1, TIMEOUT } from "./fixture-checks";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { sha256 } from "./git-oracle";
import * as F from "./fixtures";

describeGit("fixture builders: F28, second part", (git) => {
  useFixtureRoot();

  describe("cases", () => {
    const { check, filemodeTest } = fixtureChecks(git);

    const f28 = ["detached-unsaved", "update-merge", "update-rebase", "update-command", "gitmodules-command", "no-url", "interrupted", "blocked", "inactive", "active-pathspec", "deinit-unsaved", "folder", "moved-folder", "path", "prune", "keep", "remote-name", "unregistered-block"] as const;
    for (const variant of f28.slice(9)) {
      test(`F28 ${variant}`, () =>
        check(`F28 ${variant}`, (n) => F.buildF28(git, n, variant), (g, b) => {
          checkSubmodules(g, b);
          const sup = join(b.root, "super");
          const kept = (path: string) => join(b.root, (b.facts.notes.kept as Record<string, string>)[path]!);
          const inKept = (path: string, args: string[], allowExit = [0]) => git1(g, b.root, ["--git-dir", kept(path), "--work-tree", kept(path), ...args], allowExit).toString();
          const config = (key: string) => git1(g, sup, ["config", "--local", "--get", key], [0, 1]).toString().trim();
          switch (variant) {
            case "detached-unsaved":
              expect(git1(g, join(sup, "solo"), ["for-each-ref", "--contains=HEAD"]).toString()).toBe("");
              break;
            case "deinit-unsaved": {
              const unsaved = b.facts.notes.unsaved as { path: string; commit: string };
              expect([existsSync(join(sup, "solo", ".git")), inKept("solo", ["for-each-ref", `--contains=${unsaved.commit}`]), inKept("solo", ["cat-file", "-t", unsaved.commit]).trim()]).toEqual([false, "", "commit"]);
              break;
            }
            case "update-merge":
            case "update-rebase":
              expect(config("submodule.solo.update")).toBe(variant.slice("update-".length));
              break;
            case "update-command":
              expect(config("submodule.solo.update").startsWith("!")).toBe(true);
              break;
            case "gitmodules-command":
              expect(git1(g, sup, ["config", "--file", ".gitmodules", "submodule.solo.update"]).toString().trim()).toBe("!../../canaries/gitmodules-update.sh");
              break;
            case "no-url":
              expect(git1(g, sup, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\.orphan\\."], [1]).toString()).toBe("");
              break;
            case "interrupted":
            case "moved-folder": {
              const i = b.facts.notes.interrupted as { path: string; gitDir: string };
              expect(readFileSync(join(sup, i.path, ".git"), "utf8")).toBe("gitdir: ../.git/modules/solo\n");
              expect([readdirSync(join(b.root, i.gitDir, "refs")), readdirSync(join(b.root, i.gitDir, "objects", "pack"))]).toEqual([[], ["tmp_pack_arbareto"]]);
              expect([config("submodule.solo.url") !== "", config("submodule.solo.active")]).toEqual([true, "true"]);
              break;
            }
            case "blocked":
            case "unregistered-block":
              expect(readFileSync(join(sup, "solo", "solo.txt"), "utf8")).toBe("solo 1 edited\n");
              expect(config("submodule.solo.url") === "").toBe(variant === "unregistered-block");
              break;
            case "inactive":
              expect([config("submodule.solo.active"), config("submodule.active")]).toEqual(["false", ""]);
              break;
            case "active-pathspec":
              expect(config("submodule.active")).toBe("mid");
              break;
            case "folder": {
              const folder = b.facts.notes.folder as { path: string; files: Record<string, string> };
              expect(existsSync(join(sup, folder.path, ".git"))).toBe(false);
              for (const [file, digest] of Object.entries(folder.files)) expect(sha256(readFileSync(join(sup, folder.path, file)))).toBe(digest);
              break;
            }
            case "path":
              expect(git1(g, sup, ["ls-files", "-z", "--stage"]).includes(Buffer.from(b.facts.notes.invalidPath as string, "hex"))).toBe(true);
              break;
            case "prune":
            case "keep": {
              const p = b.facts.notes.prune as { path: string; head: string; ref: string; prune: boolean };
              const s = join(sup, p.path);
              expect(git1(g, s, ["for-each-ref", "--contains=HEAD", "--format=%(refname)"]).toString().trim()).toBe(p.ref);
              expect(git1(g, s, ["config", "--local", "--get", "fetch.prune"], [0, 1]).toString().trim()).toBe(p.prune ? "true" : "");
              break;
            }
            case "remote-name":
              expect(inKept("solo", ["config", "--local", "--name-only", "--get-regexp", "^remote\\.--upload-pack="]).trim().endsWith(".url")).toBe(true);
              break;
          }
        }), TIMEOUT);
    }

    filemodeTest();
  });
});
