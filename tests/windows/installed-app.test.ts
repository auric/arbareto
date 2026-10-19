// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { FIXED_IDENTITY, fixtureDir, removeTree, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { terminateRecorded } from "../git/win32";
import {
  appEnv,
  descendants,
  findInstalledApp,
  InstalledAppRefusal,
  printSystemConfig,
  processRecords,
  startInstalledApp,
  spawnOwned,
  survivingRecords,
  waitExit,
  type InstalledApp,
  type ProcessRecord,
} from "./installed-app";

printOrigin("./installed-app.ts", import.meta.dir);

const TEST_TIMEOUT_MS = 30_000;
const READY_MS = 10_000;
const REPO = join(import.meta.dir, "..", "..");

const refusal = (body: () => unknown) => {
  try {
    body();
  } catch (error) {
    if (error instanceof InstalledAppRefusal) return error.code;
    throw error;
  }
  return null;
};

const record = (pid: number, parent: number, name: string, created: string | null): ProcessRecord => ({ pid, parent, name, commandLine: null, created });

describe.skipIf(process.platform !== "win32")("T151 installed-app helper", () => {
  useFixtureRoot();

  test("discovery reads the quoted InstallLocation and MainBinaryName, and prints the ORIGIN digest", () => {
    const local = fixtureDir("local");
    const dir = join(local, "Arbareto");
    mkdirSync(dir);
    writeFileSync(join(dir, "arbareto.exe"), "fake");
    const found = findInstalledApp(() => ({ installLocation: `"${dir}"`, mainBinaryName: "arbareto.exe" }), local);
    expect(found).toEqual({ app: { exe: join(dir, "arbareto.exe"), mainBinaryName: "arbareto.exe", sha256: new Bun.CryptoHasher("sha256").update("fake").digest("hex") } });
  });

  test("discovery skips with a reason when no entry or no file exists", () => {
    const local = fixtureDir("local-absent");
    expect(findInstalledApp(() => null, local)).toEqual({ skip: expect.stringContaining("no uninstall entry") });
    expect(findInstalledApp(() => ({ installLocation: `"${join(local, "gone")}"`, mainBinaryName: "arbareto.exe" }), local)).toEqual({ skip: expect.stringContaining("missing file") });
  });

  test("discovery refuses an unquoted path, a path in the file name, and a file outside LOCALAPPDATA", () => {
    const local = fixtureDir("local-refuse");
    const outside = fixtureDir("elsewhere");
    writeFileSync(join(outside, "arbareto.exe"), "fake");
    expect(refusal(() => findInstalledApp(() => ({ installLocation: outside, mainBinaryName: "arbareto.exe" }), local))).toBe("ENTRY_INVALID");
    expect(refusal(() => findInstalledApp(() => ({ installLocation: `"${local}"`, mainBinaryName: "..\\elsewhere\\arbareto.exe" }), local))).toBe("ENTRY_INVALID");
    expect(refusal(() => findInstalledApp(() => ({ installLocation: `"${outside}"`, mainBinaryName: "arbareto.exe" }), local))).toBe("OUTSIDE_LOCALAPPDATA");
  });

  test("the real discovery gives an app or a skip reason", () => {
    const found = findInstalledApp();
    console.log("skip" in found ? `SKIP installed app: ${found.skip}` : `INSTALLED ${found.app.exe}`);
    expect("skip" in found || existsSync(found.app.exe)).toBe(true);
  });

  test("the environment points Git configuration into the root, keeps USERPROFILE, and removes the T043 variables", () => {
    const root = fixtureDir("env");
    const base = { USERPROFILE: "C:\\Users\\real", HOME: "C:\\Users\\real", Path: "C:\\bin", GIT_CONFIG_PARAMETERS: "'a.b'='c'", git_author_name: "x", GIT_DIR: "d", GIT_TEST_X: "1", GIT_CONFIG_NOSYSTEM: "1", EMAIL: "e" };
    const result = appEnv(root, false, base);
    const home = join(root, "home");
    const profile = join(root, "profile");
    expect(result.env).toEqual({ USERPROFILE: "C:\\Users\\real", Path: "C:\\bin", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), ARBARETO_PROFILE_ROOT: profile });
    expect(statSync(profile).isDirectory()).toBe(true);
    expect(result.removed.sort()).toEqual(["EMAIL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_TEST_X", "git_author_name"]);
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toContain(`email = ${FIXED_IDENTITY.email}`);
    appEnv(root, true, base);
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe("[user]\n\tuseConfigOnly = true\n");
    if (GIT === null) return;
    printSystemConfig(GIT, result.env);
    const proc = Bun.spawnSync([GIT, "config", "--global", "--list", "--show-origin", "-z"], { env: result.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(proc.stdout.toString().split("\0").filter((_, i) => i % 2 === 0 && _ !== "")).toEqual([`file:${join(home, ".gitconfig")}`]);
  });

  test("the environment refuses a relative or absent root", () => {
    expect(refusal(() => appEnv("relative", false, {}))).toBe("BAD_ROOT");
    expect(refusal(() => appEnv(join(fixtureDir("x"), "absent"), false, {}))).toBe("BAD_ROOT");
  });

  const app: InstalledApp = { exe: "C:\\fake\\arbareto.exe", mainBinaryName: "arbareto.exe", sha256: "0" };

  test("a start refuses while another instance runs, from process records", () => {
    const env = appEnv(fixtureDir("instance"), false, {});
    expect(refusal(() => startInstalledApp(app, env, [record(7, 1, "Arbareto.EXE", "1")]))).toBe("ANOTHER_INSTANCE");
    expect(readdirSync(env.set.ARBARETO_PROFILE_ROOT)).toEqual([]);
  });

  test(
    "a start runs the exe in the profile folder with the owned environment",
    async () => {
      const root = fixtureDir("start");
      const stand = join(root, "stand-in.exe");
      writeFileSync(join(root, "stand-in.ts"), 'require("node:fs").writeFileSync("started.json", JSON.stringify({ cwd: process.cwd(), env: process.env }));\n');
      const build = Bun.spawnSync([process.execPath, "build", "--compile", join(root, "stand-in.ts"), "--outfile", stand], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(build.exitCode).toBe(0);
      const env = appEnv(root, true, { ...process.env, GIT_AUTHOR_NAME: "x" });
      const owned = startInstalledApp({ ...app, exe: stand, mainBinaryName: "stand-in.exe" }, env, []);
      try {
        expect(await waitExit(owned)).toBe(0);
      } finally {
        owned.stop();
      }
      const seen = JSON.parse(readFileSync(join(root, "profile", "started.json"), "utf8"));
      expect(seen.cwd).toBe(join(root, "profile"));
      expect(seen.env.ARBARETO_PROFILE_ROOT).toBe(join(root, "profile"));
      expect(seen.env.GIT_CONFIG_GLOBAL).toBe(join(root, "home", ".gitconfig"));
      expect(seen.env.GIT_AUTHOR_NAME).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test("descendants follow parent links and drop a child older than its parent", () => {
    const records = [record(10, 1, "arbareto.exe", "100"), record(11, 10, "arbareto-git.exe", "110"), record(12, 11, "git.exe", "120"), record(13, 10, "reused.exe", "50"), record(14, 99, "other.exe", "130")];
    expect(descendants(10, records).map((r) => r.pid)).toEqual([11, 12]);
  });

  test("the real process records hold this process and its parent link", () => {
    const own = processRecords().find((r) => r.pid === process.pid);
    expect(own?.parent).toBe(process.ppid);
  });

  test(
    "an owned process records itself, survives while it runs, and ends with its tree",
    async () => {
      const root = fixtureDir("tree");
      const records = join(root, "records");
      mkdirSync(records);
      const ready = join(root, "ready");
      const owned = spawnOwned([process.execPath, join(import.meta.dir, "..", "git", "win32.ts"), records, "60000", ready], root, process.env as Record<string, string>);
      try {
        for (const until = performance.now() + READY_MS; !existsSync(ready) && performance.now() < until; ) await Bun.sleep(10);
        expect(survivingRecords(records)).toHaveLength(1);
        expect(await waitExit(owned, 100)).toBeNull();
      } finally {
        owned.stop();
      }
      expect(await waitExit(owned)).not.toBeNull();
      expect(survivingRecords(records)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a test timeout runs the hooks early, and the owned Job still ends before the fixture root removal",
    () => {
      const root = fixtureDir("early-hook");
      const records = join(root, "records");
      mkdirSync(records);
      const ready = join(root, "ready");
      const child = Bun.spawnSync([process.execPath, "test", "./tests/windows/early-hook-fixture.ts"], {
        cwd: REPO,
        env: { ...process.env, ARBARETO_EARLY_HOOK: `${records}|${ready}` },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: TEST_TIMEOUT_MS - 5_000,
      });
      const output = `${child.stdout.toString()}${child.stderr.toString()}`;
      console.log(output.replace(/^/gm, "child> "));
      // `createFixtureRoot` prints the line.
      const childRoot = /^FIXTURE_ROOT (.+)$/m.exec(output)?.[1]?.trim();
      try {
        // The child test fails by its timeout.
        expect(child.exitCode).toBe(1);
        expect(childRoot).toBeDefined();
        expect(existsSync(childRoot!)).toBe(false);
        expect(readdirSync(records)).toHaveLength(1);
        expect(survivingRecords(records)).toEqual([]);
      } finally {
        for (const name of survivingRecords(records)) {
          const [pid, created] = name.split("-");
          terminateRecorded(Number(pid), BigInt(created!));
        }
        if (childRoot !== undefined && existsSync(childRoot)) removeTree(childRoot);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
