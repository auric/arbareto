// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeGit } from "./git-binary";
import {
  FIXTURE_GLOBAL_CONFIG,
  FIXTURE_ROOT,
  fixtureDir,
  fixtureEnv,
  fixtureGit,
  fixturePath,
  FixturePathRefusal,
  ownedGit,
  realGlobalConfigDigests,
  removeFixtureRoot,
  serviceEnv,
  useFixtureRoot,
} from "./fixture-root";

// `fixture-root.ts` prints the ORIGIN line of the `src/` module that it imports.

const canonical = (p: string) => p.replaceAll("\\", "/").toLowerCase();
const insideRoot = (p: string) => canonical(p).startsWith(canonical(FIXTURE_ROOT) + "/");

describeGit("fixture root", (git) => {
  const before = realGlobalConfigDigests(git);
  useFixtureRoot();

  test("global configuration resolves only inside the owned root", () => {
    for (const env of [fixtureEnv(), serviceEnv()]) {
      // `-z` prints each origin unquoted: `file:<path>` NUL `<key>` LF `<value>` NUL.
      const proc = Bun.spawnSync([git, "config", "--global", "--list", "--show-origin", "-z"], { cwd: FIXTURE_ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const fields = proc.stdout.toString().split("\0").slice(0, -1);
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.length % 2).toBe(0);
      for (let i = 0; i < fields.length; i += 2) {
        const origin = /^file:(.+)$/.exec(fields[i]!)?.[1];
        console.log(`GLOBAL_ORIGIN ${origin}`);
        expect(origin).toBeDefined();
        expect(insideRoot(origin!)).toBe(true);
        expect(canonical(origin!)).toBe(canonical(FIXTURE_GLOBAL_CONFIG));
      }
      const selected = Bun.spawnSync([git, "var", "GIT_CONFIG_GLOBAL"], { cwd: FIXTURE_ROOT, env, stdin: "ignore", stdout: "pipe" });
      expect(selected.exitCode).toBe(0);
      for (const p of selected.stdout.toString().trim().split(/\r?\n/)) expect(insideRoot(p)).toBe(true);
    }
  });

  test("fixturePath refuses outside, dot-dot, and root paths", () => {
    expect(() => fixturePath(tmpdir())).toThrow(FixturePathRefusal);
    expect(() => fixturePath("..")).toThrow(FixturePathRefusal);
    expect(() => fixturePath("..", "escape")).toThrow(FixturePathRefusal);
    expect(() => fixturePath("a", "..", "..", "escape")).toThrow(FixturePathRefusal);
    expect(() => fixturePath("..", `${FIXTURE_ROOT.split(/[\\/]/).pop()}-sibling`)).toThrow(FixturePathRefusal);
    expect(() => fixturePath(".")).toThrow(FixturePathRefusal);
    expect(insideRoot(fixturePath("a", "..", "b"))).toBe(true);
  });

  // The junction stays until root removal, so the removal must not follow it.
  const target = mkdtempSync(join(tmpdir(), "arbareto-junction-target-"));
  const canary = join(target, "canary.txt");
  writeFileSync(canary, "canary");
  afterAll(() => {
    removeFixtureRoot();
    const intact = existsSync(canary);
    console.log(`JUNCTION_TARGET_INTACT ${intact}`);
    rmSync(target, { recursive: true, force: true });
    expect(intact).toBe(true);
  });

  const probe = join(target, "junction-probe");
  let junctions = true;
  try {
    symlinkSync(target, probe, "junction");
    rmdirSync(probe);
  } catch (error) {
    junctions = false;
    console.log(`SKIP: junction-create (${(error as Error).message})`);
  }

  test.skipIf(!junctions)("fixturePath refuses a junction to an outside directory", () => {
    symlinkSync(target, fixturePath("junction"), "junction");
    expect(() => fixturePath("junction")).toThrow(FixturePathRefusal);
    expect(() => fixturePath("junction", "canary.txt")).toThrow(FixturePathRefusal);
    expect(() => fixturePath("junction", "new", "file")).toThrow(FixturePathRefusal);
  });

  test("fixture and service processes lack the removed variables", () => {
    // The repository-location canaries point at a throwaway repository inside the owned root.
    const canaryRepo = fixtureDir("canary-repo");
    fixtureGit(git, canaryRepo, ["init", "-q"]);
    const canaries: Record<string, string> = {
      GIT_DIR: join(canaryRepo, ".git"),
      git_index_file: join(canaryRepo, ".git", "index"),
      GIT_WORK_TREE: canaryRepo,
      GIT_COMMON_DIR: join(canaryRepo, ".git"),
      GIT_CEILING_DIRECTORIES: canaryRepo,
      GIT_TEST_CANARY: "canary",
      GIT_CONFIG_PARAMETERS: "'user.name'='canary'",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "canary",
      GIT_CONFIG: "C:/canary/config",
      GIT_AUTHOR_NAME: "canary",
      GIT_AUTHOR_EMAIL: "canary@invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "canary",
      GIT_COMMITTER_EMAIL: "canary@invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      git_author_name: "canary",
      EMAIL: "canary@invalid",
      Email: "canary@invalid",
      HOME: "C:/canary/home",
      UserProfile: "C:/canary/profile",
      GIT_CONFIG_GLOBAL: "C:/canary/gitconfig",
    };
    const base = { ...process.env, ...canaries };
    const script = "console.log(JSON.stringify(process.env))";
    for (const [name, env] of [["fixture", fixtureEnv({}, base)], ["service", serviceEnv({}, base)]] as const) {
      const proc = Bun.spawnSync([process.execPath, "-e", script], { cwd: FIXTURE_ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const seen = JSON.parse(proc.stdout.toString()) as Record<string, string>;
      const present = Object.keys(seen).filter((k) => /^(GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+|GIT_CONFIG|GIT_(AUTHOR|COMMITTER)_.*|EMAIL|GIT_DIR|GIT_INDEX_FILE|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_CEILING_DIRECTORIES|GIT_TEST_.*)$/i.test(k));
      console.log(`REMOVED_VARIABLES ${name} present=${JSON.stringify(present)}`);
      expect(present).toEqual([]);
      expect(Object.values(seen).some((v) => v.includes("canary"))).toBe(false);
      const upper = Object.fromEntries(Object.entries(seen).map(([k, v]) => [k.toUpperCase(), v]));
      for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"]) expect(insideRoot(upper[key]!)).toBe(true);
      expect(upper.GIT_CONFIG_NOSYSTEM as string | undefined).toBe(name === "fixture" ? "1" : undefined);
    }
  });

  // T388: trace2 `sid` ends in `-P<pid>` in hex (api-trace2 "sid"). A launcher start writes the PID of its child.
  test("ownedGit starts the core Git without a launcher process", () => {
    const dir = fixtureDir("t388-pid");
    const trace = join(dir, "trace2.json");
    const spawn = spyOn(Bun, "spawnSync");
    let pid: number;
    try {
      ownedGit(git, FIXTURE_ROOT, dir, ["version"], { env: { GIT_TRACE2_EVENT: trace } });
      expect(spawn).toHaveBeenCalledTimes(1);
      pid = (spawn.mock.results[0]!.value as { pid: number }).pid;
    } finally {
      spawn.mockRestore();
    }
    const sids = [...new Set(readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => (JSON.parse(line) as { sid: string }).sid))];
    console.log(`T388_SID ${sids.join(" ")} spawn_pid=${pid}`);
    expect(sids).toHaveLength(1);
    const hex = /^[^/]*-P([0-9a-f]+)$/.exec(sids[0]!)?.[1];
    expect(hex).toBeDefined();
    expect(Number.parseInt(hex!, 16)).toBe(pid);
  });

  // T388: Git for Windows adds its tool folders to PATH only when MSYSTEM is unset (compat/mingw.c `setup_windows_environment`).
  test("ownedGit runs a sh hook and a perl shell alias", () => {
    console.log(`T388_SH_ON_TEST_PATH ${Bun.which("sh")}`);
    const repo = fixtureDir("t388-hook");
    fixtureGit(git, repo, ["init", "-q"]);
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nsh -c 'echo ran > hook-ran.txt'\n");
    chmodSync(hook, 0o755);
    ownedGit(git, FIXTURE_ROOT, repo, ["commit", "-q", "--allow-empty", "-m", "t388"]);
    expect(readFileSync(join(repo, "hook-ran.txt"), "utf8").trim()).toBe("ran");
    ownedGit(git, FIXTURE_ROOT, repo, ["-c", "alias.t388=!perl -e 1", "t388"]);
  });

  test("fixture and service environments lack MSYSTEM in any case", () => {
    const base = { ...process.env, MSYSTEM: "UCRT64", msystem: "MINGW64" };
    for (const env of [fixtureEnv({}, base), serviceEnv({}, base)]) {
      expect(Object.keys(env).filter((k) => k.toUpperCase() === "MSYSTEM")).toEqual([]);
    }
  });

  test("real global configuration digest is unchanged", () => {
    const after = realGlobalConfigDigests(git);
    for (const line of after) console.log(`GLOBAL_CONFIG_SHA256 in-run ${line}`);
    expect(after).toEqual(before);
  });
});
