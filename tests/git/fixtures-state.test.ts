// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture builders F10 to F12 and F14 (T066). `fixture-root.ts` prints the ORIGIN of its contract file.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canaryRuns, fixtureChecks, git1, TIMEOUT } from "./fixture-checks";
import { FIXTURE_ROOT, fixtureEnv, ownedGit, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { hookListArgs } from "./git-oracle";
import * as F from "./fixtures";

describeGit("fixture builders: F10 to F12 and F14", (git) => {
  useFixtureRoot();

  describe("cases", () => {
    const { check, builtRepos, filemodeTest } = fixtureChecks(git);

    for (const variant of ["lock", "merge", "rebase", "cherry-pick", "sequencer", "am", "revert", "split-index", "split-config", "split-global", "flags", "sparse"] as const) {
      test(`F10 ${variant}`, () =>
        check(`F10 ${variant}`, (n) => F.buildF10(git, n, variant), (g, b) => {
          const gitDir = join(b.root, "repo", ".git");
          const shared = readdirSync(gitDir).filter((f) => f.startsWith("sharedindex."));
          expect(shared.length).toBe(variant === "split-index" ? 1 : 0);
          if (variant === "split-config") expect(git1(g, join(b.root, "repo"), ["config", "--local", "core.splitIndex"]).toString().trim()).toBe("true");
          if (variant === "split-global") {
            const global = join(b.root, b.facts.notes.globalConfig as string);
            expect(git1(g, join(b.root, "repo"), ["config", "--file", global, "--type=bool", "core.splitIndex"]).toString().trim()).toBe("true");
            expect(ownedGit(g, FIXTURE_ROOT, join(b.root, "repo"), ["config", "--show-scope", "--type=bool", "core.splitIndex"], { env: { GIT_CONFIG_GLOBAL: global } }).toString().trim()).toBe("global\ttrue");
          }
          if (variant === "lock") for (const lock of b.facts.notes.locks as string[]) expect(existsSync(join(b.root, "repo", lock))).toBe(true);
        }), TIMEOUT);
    }

    for (const variant of ["traditional", "configured", "disabled", "post-index-change", "fsmonitor", "changing", "rejecting"] as const) {
      test(`F11 ${variant}`, () =>
        check(`F11 ${variant}`, (n) => F.buildF11(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          const hooks = b.facts.notes.hooks as Record<string, { configured: string[]; hookFolder: boolean }>;
          // A configured record is "<scope>\t[disabled\t]<name>". A hook-folder record has no scope and no tab.
          for (const [event, expected] of Object.entries(hooks)) {
            const records = git1(g, repo, hookListArgs(event), [0, 1]).toString("utf8").split("\0").filter((r) => r !== "");
            expect({ event, configured: records.filter((r) => r.includes("\t")), hookFolder: records.filter((r) => !r.includes("\t")).length }).toEqual({ event, configured: expected.configured, hookFolder: expected.hookFolder ? 1 : 0 });
          }
          if (variant === "fsmonitor") {
            // The monitor canary must be live: `status` without the disarm loads the index and asks the monitor.
            git1(g, repo, ["status", "--porcelain=v2"]);
            expect(canaryRuns(b)).toEqual({ fsmonitor: true });
            return;
          }
          // Each canary must be live, and a disabled registration must stay silent.
          for (const event of Object.keys(hooks)) git1(g, repo, ["hook", "run", event], [0, 1]);
          const runs = canaryRuns(b);
          expect(runs).toEqual(Object.fromEntries(Object.keys(runs).map((k) => [k, variant !== "disabled"])));
        }), TIMEOUT);
    }

    for (const variant of ["gc-auto", "ssh-signing"] as const) {
      test(`F12 ${variant}`, () =>
        check(`F12 ${variant}`, (n) => F.buildF12(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          if (variant === "gc-auto") {
            const gc = b.facts.notes.gcAuto as { threshold: number; looseIn17: number };
            const folder = join(repo, git1(g, repo, ["rev-parse", "--git-path", "objects/17"]).toString().trim());
            expect([git1(g, repo, ["config", "--local", "--type=int", "gc.auto"]).toString().trim(), readdirSync(folder).length]).toEqual([String(gc.threshold), gc.looseIn17]);
            expect(gc.looseIn17).toBeGreaterThan(Math.floor((gc.threshold + 255) / 256));
            return;
          }
          // The key canary must be live: the signing commit asks it for a key, gets none, and fails without a commit.
          const head = git1(g, repo, ["rev-parse", "HEAD"]).toString();
          git1(g, repo, ["commit", "-q", "--no-verify", "-m", "signed"], [128]);
          expect([git1(g, repo, ["rev-parse", "HEAD"]).toString(), canaryRuns(b)["ssh-default-key"]]).toEqual([head, true]);
        }), TIMEOUT);
    }

    for (const variant of ["slow", "descendant", "orphan", "monitor", "lingering", "lock"] as const) {
      test(`F14 ${variant}`, () =>
        check(`F14 ${variant}`, (n) => F.buildF14(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          const event = { slow: "pre-commit", descendant: "pre-commit", orphan: "pre-commit", monitor: null, lingering: "post-commit", lock: "post-commit" }[variant];
          if (event !== null) expect(git1(g, repo, hookListArgs(event)).toString("utf8").split("\0").filter((r) => r !== "").length).toBe(1);
          expect(readdirSync(join(b.root, b.facts.notes.records as string))).toEqual([]);
          if (variant === "lock") expect(existsSync(join(b.root, b.facts.notes.lock as string))).toBe(false);
          if (variant !== "monitor") return;
          expect(git1(g, repo, ["config", "--local", "--type=bool", "core.fsmonitor"]).toString().trim()).toBe("true");
          // Git builtin/fsmonitor--daemon.c `do_as_client__status`: exit 0 when a daemon watches the worktree, 1 otherwise. No fixture read may start one.
          if (process.platform === "win32") git1(g, repo, ["fsmonitor--daemon", "status"], [1]);
        }), TIMEOUT);
    }

    // The hook script must run: its child creates the Git-resolved lock and records itself. The test ends the child by its record.
    test("F14 lock child creates the index lock and records itself", () => {
      const b = F.buildF14(git, "f14-lock-live", "lock");
      const repo = join(b.root, "repo");
      builtRepos.push(repo);
      // The child inherits the hook output, so the run gets no pipe that the child would hold open.
      const run = Bun.spawnSync([git, "hook", "run", "post-commit"], { cwd: repo, env: fixtureEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      expect(run.exitCode).toBe(0);
      const host = require(join(import.meta.dir, process.platform === "win32" ? "win32.ts" : "linux.ts")) as typeof import("./win32");
      const records = readdirSync(join(b.root, b.facts.notes.records as string)).map((name) => name.split("-").map(BigInt) as [bigint, bigint]);
      try {
        expect(records.length).toBe(1);
        expect(host.processCreationTime(Number(records[0]![0]))).toBe(records[0]![1]);
        expect(existsSync(join(b.root, b.facts.notes.lock as string))).toBe(true);
      } finally {
        for (const [pid, created] of records) host.terminateRecorded(Number(pid), created);
      }
    }, TIMEOUT);

    filemodeTest();
  });
});
