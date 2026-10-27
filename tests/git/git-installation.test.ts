// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, copyFileSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { GIT_EXECUTABLE_DIGEST_BYTES } from "../../src/contracts/limits";
import { probeGit, revalidateGit, revalidateSavedGit } from "../../src/git-service/git-installation";
import type { GitCall, GitRunner, RegisterRequest } from "../../src/git-service/git-runner";
import { createSession, type SessionOptions } from "../../src/git-service/session";
import { createBunRunner, type BunRunner } from "./bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "./fixture-root";
import { readIdentity } from "./win32";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/git-installation.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

const MINIMUM = "2.55.0.windows.3";
const COMPILE_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;

// The stub Git is compiled at test time under the owned root, so no executable enters the repository.
// It reads its version from `version.txt` beside itself and appends each call to `calls.jsonl` there.
// Like Git before 2.45.0, a version below 2.45 rejects `--no-lazy-fetch` with "unknown option" (contract §7 "Missing objects").
// Another version accepts the global options that the product passes to an admitted Git.
// `--exec-path` prints the text of `exec-path.txt` beside it, or else its own folder. Like Git for Windows, it prints forward slashes.
// `var GIT_CONFIG_SYSTEM` and `var GIT_CONFIG_GLOBAL` print one path each. `var-exit.txt` beside it holds another exit status for the first one.
const STUB_SOURCE = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const dir = dirname(process.execPath);
const all = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args: all, cwd: process.cwd() }) + "\\n");
const version = readFileSync(join(dir, "version.txt"), "utf8").trim();
const [major, minor] = version.split(".").map(Number);
const GLOBAL_OPTIONS = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
let at = 0;
while (at < all.length && GLOBAL_OPTIONS.includes(all[at])) at++;
const args = all.slice(at);
if (all.includes("--no-lazy-fetch") && (major < 2 || (major === 2 && minor < 45))) {
  process.stderr.write("unknown option: --no-lazy-fetch\\nusage: git [-v | --version] [-h | --help] <command> [<args>]\\n");
  process.exit(129);
}
if (args.length === 2 && args[0] === "var" && (args[1] === "GIT_CONFIG_SYSTEM" || args[1] === "GIT_CONFIG_GLOBAL")) {
  const status = join(dir, "var-exit.txt");
  if (args[1] === "GIT_CONFIG_SYSTEM" && existsSync(status)) process.exit(Number(readFileSync(status, "utf8")));
  process.stdout.write(join(dir, args[1] === "GIT_CONFIG_SYSTEM" ? "etc" : "home", "gitconfig").replaceAll("\\\\", "/") + "\\n");
  process.exit(0);
}
if (args.length === 1 && args[0] === "--exec-path") {
  const execPath = join(dir, "exec-path.txt");
  process.stdout.write((existsSync(execPath) ? readFileSync(execPath, "utf8") : dir).replaceAll("\\\\", "/") + "\\n");
  process.exit(0);
}
if (args.length === 2 && args[0] === "version" && args[1] === "--build-options") {
  process.stdout.write("git version " + version + "\\ncpu: x86_64\\nsizeof-long: 4\\nsizeof-size_t: 8\\n");
  process.exit(0);
}
process.exit(1);
`;

type StubCall = { args: string[]; cwd: string };

// Contract §7 "Configuration file paths": after the admission checks, the probe runs these two arrays.
const VAR_ARGS = [
  ["--no-lazy-fetch", "var", "GIT_CONFIG_SYSTEM"],
  ["--no-lazy-fetch", "var", "GIT_CONFIG_GLOBAL"],
];

const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
const stubCalls = (exe: string): StubCall[] => {
  const log = join(exe, "..", "calls.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as StubCall);
};

// Windows can hold the image of a just-exited executable for a short time (EBUSY), so the write retries within a bound.
const UNLOCK_TIMEOUT_MS = 10_000;
async function changeBytes(path: string): Promise<void> {
  const deadline = Date.now() + UNLOCK_TIMEOUT_MS;
  for (;;) {
    try {
      appendFileSync(path, new Uint8Array([0]));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || Date.now() > deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

useFixtureRoot();

describe.skipIf(process.platform !== "win32")("Git installation probe (T053) (needs the Git for Windows layout, named pipes, and FILE_ID_INFO)", () => {
  let compiled = "";
  let runner: BunRunner;
  let launchDirectory = "";
  const runs: GitCall[] = [];
  const registers: RegisterRequest[] = [];
  const releases: unknown[] = [];
  let counted: GitRunner;

  // Each stub copy gets its own folder, version file, and call log.
  function stub(name: string, version: string): string {
    const dir = fixtureDir(name);
    const exe = join(dir, "git.exe");
    copyFileSync(compiled, exe);
    writeFileSync(join(dir, "version.txt"), version);
    return exe;
  }

  beforeAll(() => {
    const build = fixtureDir("stub-build");
    const source = join(build, "stub.ts");
    writeFileSync(source, STUB_SOURCE);
    compiled = join(build, "stub.exe");
    const proc = Bun.spawnSync([process.execPath, "build", source, "--compile", "--outfile", compiled], {
      cwd: build,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: COMPILE_TIMEOUT_MS,
    });
    if (proc.exitCode !== 0) throw new Error(`stub compile exited ${proc.exitCode}: ${proc.stderr.toString()}`);
    const runnerDir = fixtureDir("runner");
    launchDirectory = join(runnerDir, "launch");
    runner = createBunRunner({ git: compiled, directory: runnerDir, environment: serviceEnv() });
    counted = {
      ...runner,
      run(call) {
        runs.push(call);
        return runner.run(call);
      },
      register(request) {
        registers.push(request);
        return runner.register(request);
      },
      release(target) {
        releases.push(target);
        runner.release(target);
      },
    };
  }, COMPILE_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    await runner?.dispose();
  });

  test(
    "a Git that rejects --no-lazy-fetch and reports 2.43.0 gives GIT_UNSUPPORTED with the found version",
    async () => {
      const exe = stub("old", "2.43.0");
      const bootstrapId = runner.addContext("gitProbe", exe);
      runs.length = 0;
      registers.length = 0;
      const result = await probeGit(counted, { bootstrapId, executablePath: exe });
      expect(result).toMatchObject({ ok: false, gitCode: "GIT_UNSUPPORTED", detectedVersion: "2.43.0", minimumVersion: MINIMUM });
      // Contract §6 `gitProbe`: fixed arguments without `--no-lazy-fetch`, the `probe` policy, from the owned launch directory.
      // The exec-path probe names the folder of this file, so the version probe runs in the same context.
      expect(runs).toHaveLength(2);
      for (const run of runs) {
        expect(run.context).toEqual({ contextKind: "gitProbe", bootstrapId });
        expect(run.environmentPolicy).toBe("probe");
      }
      expect(runs.map((run) => [...run.arguments])).toEqual([["--exec-path"], ["version", "--build-options"]]);
      expect(stubCalls(exe)).toEqual([
        { args: ["--exec-path"], cwd: launchDirectory },
        { args: ["version", "--build-options"], cwd: launchDirectory },
      ]);
      // The service never selects another executable.
      expect(registers).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  // Contract §5 "Deadline outcomes": a walk deadline of a probe gives DEADLINE, as a bootstrap probe deadline does.
  test(
    "an identity walk that ends deadline gives DEADLINE, and one that ends canceled gives the canceled result, and no probe runs",
    async () => {
      const exe = stub("walk-stop", MINIMUM);
      for (const [stop, expected] of [
        ["deadline", { ok: false, gitCode: "DEADLINE", minimumVersion: MINIMUM }],
        ["canceled", { ok: false, canceled: true }],
      ] as const) {
        runs.length = 0;
        const stopped: GitRunner = { ...counted, identities: async () => ({ stop }) };
        expect(await probeGit(stopped, { bootstrapId: runner.addContext("gitProbe", exe), executablePath: exe })).toEqual(expected);
        expect(runs).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an admitted Git records executablePath, executableIdentity, and version",
    async () => {
      const exe = stub("admitted", MINIMUM);
      const bootstrapId = runner.addContext("gitProbe", exe);
      runs.length = 0;
      registers.length = 0;
      const result = await probeGit(counted, { bootstrapId, executablePath: exe });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const installation = result.installation;
      expect(installation.gitInstallationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(installation.executablePath).toBe(exe);
      expect(installation.version).toBe(MINIMUM);
      expect(installation.admission).toBe("admitted");
      expect(installation.executableIdentity.file).toEqual(readIdentity(exe));
      expect(installation.executableIdentity.versionOutput).toContain(`git version ${MINIMUM}`);
      expect(installation.executableIdentity.digest).toBe(sha256(exe));
      expect(stubCalls(exe)).toEqual([
        { args: ["--exec-path"], cwd: launchDirectory },
        { args: ["version", "--build-options"], cwd: launchDirectory },
        ...VAR_ARGS.map((args) => ({ args, cwd: launchDirectory })),
      ]);
      // Contract §7 "Configuration file paths": the lines as `git var` printed them.
      expect(installation.configFiles).toEqual(["etc", "home"].map((folder) => join(exe, "..", folder, "gitconfig").replaceAll("\\", "/")));
      // Contract §6 `register`: the issued ID binds to the probed context.
      expect(registers).toHaveLength(1);
      expect(registers[0]).toMatchObject({ bootstrapId, gitInstallationId: installation.gitInstallationId, version: MINIMUM });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a first git var call with exit status 2 refuses the Git with GIT_UNSUPPORTED, the second git var call never runs, and nothing registers",
    async () => {
      const exe = stub("var-failed", MINIMUM);
      writeFileSync(join(exe, "..", "var-exit.txt"), "2");
      const bootstrapId = runner.addContext("gitProbe", exe);
      registers.length = 0;
      const result = await probeGit(counted, { bootstrapId, executablePath: exe });
      expect(result).toMatchObject({ ok: false, gitCode: "GIT_UNSUPPORTED", detectedVersion: MINIMUM, minimumVersion: MINIMUM });
      expect(stubCalls(exe)).toEqual([
        { args: ["--exec-path"], cwd: launchDirectory },
        { args: ["version", "--build-options"], cwd: launchDirectory },
        { args: VAR_ARGS[0], cwd: launchDirectory },
      ]);
      expect(registers).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "revalidation of a file whose bytes changed returns GIT_CHANGED and runs nothing",
    async () => {
      const exe = stub("changed", MINIMUM);
      const bootstrapId = runner.addContext("gitProbe", exe);
      const first = await probeGit(counted, { bootstrapId, executablePath: exe });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const unchanged = await revalidateGit(counted, first.installation);
      expect(unchanged).toMatchObject({ ok: true, installation: { gitInstallationId: first.installation.gitInstallationId } });

      await changeBytes(exe);
      const spawnedBefore = runner.spawned;
      runs.length = 0;
      registers.length = 0;
      const callsBefore = stubCalls(exe).length;
      const changed = await revalidateGit(counted, first.installation);
      expect(changed).toMatchObject({ ok: false, gitCode: "GIT_CHANGED" });
      expect("installation" in changed).toBe(false);
      expect(runs).toEqual([]);
      expect(runner.spawned).toBe(spawnedBefore);
      expect(stubCalls(exe)).toHaveLength(callsBefore);
      // The service never selects another executable.
      expect(registers).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a Git file one byte above the digest bound gives GIT_UNSUPPORTED and runs nothing",
    async () => {
      const exe = join(fixtureDir("oversize"), "git.exe");
      // NTFS extends the file without writing its bytes, so the fixture costs no disk writes.
      const fd = openSync(exe, "w");
      ftruncateSync(fd, GIT_EXECUTABLE_DIGEST_BYTES + 1);
      closeSync(fd);
      try {
        const bootstrapId = runner.addContext("gitProbe", exe);
        const spawnedBefore = runner.spawned;
        runs.length = 0;
        registers.length = 0;
        const result = await probeGit(counted, { bootstrapId, executablePath: exe });
        expect(result).toMatchObject({ ok: false, gitCode: "GIT_UNSUPPORTED", minimumVersion: MINIMUM });
        expect(runs).toEqual([]);
        expect(registers).toEqual([]);
        expect(runner.spawned).toBe(spawnedBefore);
      } finally {
        rmSync(exe);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a register reply another probes, digests, admits, and registers the new candidate",
    async () => {
      const first = stub("another-first", MINIMUM);
      const second = stub("another-second", MINIMUM);
      const bootstrapId = runner.addContext("gitProbe", first);
      const next = runner.addContext("gitProbe", second);
      runs.length = 0;
      registers.length = 0;
      runner.inject.registerResult = { result: "another", bootstrapId: next, executablePath: second };
      const once: GitRunner = {
        ...counted,
        async register(request) {
          const reply = await counted.register(request);
          runner.inject.registerResult = { result: "approved" };
          return reply;
        },
      };
      try {
        const result = await probeGit(once, { bootstrapId, executablePath: first });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const installation = result.installation;
        expect(installation.executablePath).toBe(second);
        expect(installation.executableIdentity.file).toEqual(readIdentity(second));
        expect(installation.executableIdentity.digest).toBe(sha256(second));
        expect(runs.map((call) => call.context)).toEqual([
          ...Array.from({ length: 4 }, () => ({ contextKind: "gitProbe" as const, bootstrapId })),
          ...Array.from({ length: 4 }, () => ({ contextKind: "gitProbe" as const, bootstrapId: next })),
        ]);
        const probes = [
          { args: ["--exec-path"], cwd: launchDirectory },
          { args: ["version", "--build-options"], cwd: launchDirectory },
          ...VAR_ARGS.map((args) => ({ args, cwd: launchDirectory })),
        ];
        expect(stubCalls(first)).toEqual(probes);
        expect(stubCalls(second)).toEqual(probes);
        expect(registers.map((request) => request.bootstrapId)).toEqual([bootstrapId, next]);
        expect(registers[0].gitInstallationId).not.toBe(registers[1].gitInstallationId);
        expect(registers[1].gitInstallationId).toBe(installation.gitInstallationId);
      } finally {
        runner.inject.registerResult = { result: "approved" };
      }
    },
    TEST_TIMEOUT_MS,
  );

  // A Git for Windows layout: the wrapper `cmd\git.exe` names `mingw64\libexec\git-core` in its exec-path output.
  function wrapperLayout(name: string, realName = "git.exe"): { wrapper: string; real: string } {
    const root = fixtureDir(name);
    const cmd = join(root, "cmd");
    const core = join(root, "mingw64", "libexec", "git-core");
    mkdirSync(cmd, { recursive: true });
    mkdirSync(core, { recursive: true });
    const wrapper = join(cmd, "git.exe");
    copyFileSync(compiled, wrapper);
    writeFileSync(join(cmd, "version.txt"), MINIMUM);
    writeFileSync(join(cmd, "exec-path.txt"), core);
    const real = join(core, realName);
    copyFileSync(compiled, real);
    writeFileSync(join(core, "version.txt"), MINIMUM);
    return { wrapper, real: join(core, "git.exe") };
  }

  test(
    "a wrapper candidate resolves to <exec-path>\\git.exe, and only that file is digested, probed, and registered",
    async () => {
      const { wrapper, real } = wrapperLayout("wrapper");
      const bootstrapId = runner.addContext("gitProbe", wrapper);
      runs.length = 0;
      registers.length = 0;
      const result = await probeGit(counted, { bootstrapId, executablePath: wrapper });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const installation = result.installation;
      expect(installation.executablePath).toBe(real);
      expect(installation.executableIdentity.file).toEqual(readIdentity(real));
      expect(installation.executableIdentity.digest).toBe(sha256(real));
      // The wrapper runs only the exec-path probe. Every later process runs the resolved file.
      expect(stubCalls(wrapper)).toEqual([{ args: ["--exec-path"], cwd: launchDirectory }]);
      expect(stubCalls(real)).toEqual([
        { args: ["--exec-path"], cwd: launchDirectory },
        { args: ["version", "--build-options"], cwd: launchDirectory },
        ...VAR_ARGS.map((args) => ({ args, cwd: launchDirectory })),
      ]);
      expect(registers).toHaveLength(1);
      expect(registers[0].bootstrapId).not.toBe(bootstrapId);
      expect(runs.at(-1)?.context).toEqual({ contextKind: "gitProbe", bootstrapId: registers[0].bootstrapId });
      // The candidate context is gone. Its wrapper can no longer run.
      expect(runner.contextPath(bootstrapId)).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a missing or non-regular <exec-path>\\git.exe gives GIT_UNSUPPORTED and never falls back to the wrapper",
    async () => {
      const missing = wrapperLayout("resolved-missing", "other.exe");
      const folder = wrapperLayout("resolved-folder", "other.exe");
      mkdirSync(folder.real);
      for (const { wrapper, real } of [missing, folder]) {
        const bootstrapId = runner.addContext("gitProbe", wrapper);
        runs.length = 0;
        registers.length = 0;
        const result = await probeGit(counted, { bootstrapId, executablePath: wrapper });
        expect(result).toMatchObject({ ok: false, gitCode: "GIT_UNSUPPORTED", minimumVersion: MINIMUM });
        expect("detectedVersion" in result).toBe(false);
        expect(runs.map((run) => [...run.arguments])).toEqual([["--exec-path"]]);
        expect(stubCalls(wrapper)).toEqual([{ args: ["--exec-path"], cwd: launchDirectory }]);
        expect(stubCalls(join(real, "..", "other.exe"))).toEqual([]);
        expect(registers).toEqual([]);
        // The candidate context stays bound to the wrapper. It is never moved.
        expect(runner.contextPath(bootstrapId)).toBe(wrapper);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Contract §6 "Walks" (T314): `register` and `resolveGit` are walks, and a deadline reply gives DEADLINE.
  test(
    "a register or resolveGit deadline reply gives DEADLINE",
    async () => {
      const exe = stub("register-deadline", MINIMUM);
      const registerDeadline: GitRunner = { ...counted, register: async () => ({ stop: "deadline" }) };
      expect(await probeGit(registerDeadline, { bootstrapId: runner.addContext("gitProbe", exe), executablePath: exe })).toEqual({ ok: false, gitCode: "DEADLINE", minimumVersion: MINIMUM });
      const { wrapper } = wrapperLayout("resolve-deadline");
      const resolveDeadline: GitRunner = { ...counted, resolveGit: async () => ({ stop: "deadline" }) };
      expect(await probeGit(resolveDeadline, { bootstrapId: runner.addContext("gitProbe", wrapper), executablePath: wrapper })).toEqual({ ok: false, gitCode: "DEADLINE", minimumVersion: MINIMUM });
    },
    TEST_TIMEOUT_MS,
  );

  // Contract §6 "Startup contexts": the saved Git fields that the handshake carries.
  const savedOf = (selectedPath: string, executablePath: string, version = MINIMUM) => ({ selectedPath, executablePath, version, digest: sha256(executablePath) });
  const NEW_VERSION = "2.56.0.windows.1";

  // Git for Windows 2.56 moved from `mingw64` to `ucrt64`. The wrapper then names the new folder.
  function upgrade(wrapper: string, version: string): string {
    const root = join(wrapper, "..", "..");
    const core = join(root, "ucrt64", "libexec", "git-core");
    mkdirSync(core, { recursive: true });
    const real = join(core, "git.exe");
    copyFileSync(compiled, real);
    writeFileSync(join(core, "version.txt"), version);
    writeFileSync(join(root, "cmd", "exec-path.txt"), core);
    rmSync(join(root, "mingw64"), { recursive: true });
    return real;
  }

  test(
    "a startup upgrade from a mingw64 to a ucrt64 layout behind the same wrapper is admitted with previousVersion, and the next start has none",
    async () => {
      const { wrapper, real } = wrapperLayout("upgrade");
      const saved = savedOf(wrapper, real);
      const upgraded = upgrade(wrapper, NEW_VERSION);
      runs.length = 0;
      registers.length = 0;
      const result = await revalidateSavedGit(counted, { bootstrapId: runner.addContext("gitProbe", wrapper), ...saved }, crypto.randomUUID());
      expect(result).toMatchObject({
        ok: true,
        installation: { selectedPath: wrapper, executablePath: upgraded, version: NEW_VERSION, previousVersion: MINIMUM, executableIdentity: { digest: sha256(upgraded) } },
      });
      expect(stubCalls(wrapper)).toEqual([{ args: ["--exec-path"], cwd: launchDirectory }]);
      expect(stubCalls(upgraded)).toEqual([
        { args: ["--exec-path"], cwd: launchDirectory },
        { args: ["version", "--build-options"], cwd: launchDirectory },
        ...VAR_ARGS.map((args) => ({ args, cwd: launchDirectory })),
      ]);
      // The shell saves these register fields without a confirmation.
      expect(registers).toHaveLength(1);
      expect(registers[0]).toMatchObject({ version: NEW_VERSION, digest: sha256(upgraded), confirm: false });

      // The shell saved the new fields, so the next start reports no update.
      const next = await revalidateSavedGit(counted, { bootstrapId: runner.addContext("gitProbe", wrapper), ...savedOf(wrapper, upgraded, NEW_VERSION) }, crypto.randomUUID());
      expect(next).toMatchObject({ ok: true, installation: { executablePath: upgraded, version: NEW_VERSION } });
      expect(next.ok && "previousVersion" in next.installation).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a startup Git rewritten in place with the same version is admitted without previousVersion",
    async () => {
      const { wrapper, real } = wrapperLayout("rewritten");
      const saved = savedOf(wrapper, real);
      await changeBytes(real);
      const result = await revalidateSavedGit(counted, { bootstrapId: runner.addContext("gitProbe", wrapper), ...saved }, crypto.randomUUID());
      expect(result).toMatchObject({ ok: true, installation: { executablePath: real, version: MINIMUM, executableIdentity: { digest: sha256(real) } } });
      expect(result.ok && "previousVersion" in result.installation).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a saved wrapper as executablePath resolves at startup and is admitted",
    async () => {
      const { wrapper, real } = wrapperLayout("saved-wrapper");
      const result = await revalidateSavedGit(counted, { bootstrapId: runner.addContext("gitProbe", wrapper), ...savedOf(wrapper, wrapper) }, crypto.randomUUID());
      expect(result).toMatchObject({ ok: true, installation: { selectedPath: wrapper, executablePath: real } });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a missing selected file gives GIT_UNAVAILABLE with reason selected-missing and the path, and runs nothing",
    async () => {
      const { wrapper, real } = wrapperLayout("selected-missing");
      const saved = savedOf(wrapper, real);
      rmSync(wrapper);
      const spawnedBefore = runner.spawned;
      runs.length = 0;
      registers.length = 0;
      // Without a readable selected file, the shell binds no context and sends no `bootstrapId`.
      const result = await revalidateSavedGit(counted, saved, crypto.randomUUID());
      expect(result).toEqual({ ok: false, gitCode: "GIT_UNAVAILABLE", reason: "selected-missing", path: wrapper, minimumVersion: MINIMUM });
      expect(runs).toEqual([]);
      expect(registers).toEqual([]);
      expect(runner.spawned).toBe(spawnedBefore);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an exec-path probe without a folder gives GIT_UNAVAILABLE with reason resolution-failed and registers nothing",
    async () => {
      const { wrapper, real } = wrapperLayout("resolution-failed");
      writeFileSync(join(wrapper, "..", "exec-path.txt"), "");
      registers.length = 0;
      const result = await revalidateSavedGit(counted, { bootstrapId: runner.addContext("gitProbe", wrapper), ...savedOf(wrapper, real) }, crypto.randomUUID());
      expect(result).toEqual({ ok: false, gitCode: "GIT_UNAVAILABLE", reason: "resolution-failed", minimumVersion: MINIMUM });
      expect(stubCalls(real)).toEqual([]);
      expect(registers).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a missing or non-regular resolved git.exe gives GIT_UNAVAILABLE with reason resolved-missing and the path",
    async () => {
      const missing = wrapperLayout("startup-resolved-missing", "other.exe");
      const folder = wrapperLayout("startup-resolved-folder", "other.exe");
      mkdirSync(folder.real);
      for (const { wrapper, real } of [missing, folder]) {
        registers.length = 0;
        const result = await revalidateSavedGit(counted, { bootstrapId: runner.addContext("gitProbe", wrapper), ...savedOf(wrapper, wrapper) }, crypto.randomUUID());
        expect(result).toEqual({ ok: false, gitCode: "GIT_UNAVAILABLE", reason: "resolved-missing", path: real, minimumVersion: MINIMUM });
        expect(registers).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a resolved file outside the installation root of the selected file gives GIT_UNAVAILABLE with reason outside-installation and runs nothing from it",
    async () => {
      const saved = wrapperLayout("outside-saved");
      const moved = wrapperLayout("outside-moved");
      writeFileSync(join(moved.wrapper, "..", "exec-path.txt"), join(saved.real, ".."));
      const bootstrapId = runner.addContext("gitProbe", moved.wrapper);
      runs.length = 0;
      registers.length = 0;
      const result = await revalidateSavedGit(counted, { bootstrapId, ...savedOf(moved.wrapper, moved.real) }, crypto.randomUUID());
      expect(result).toEqual({ ok: false, gitCode: "GIT_UNAVAILABLE", reason: "outside-installation", minimumVersion: MINIMUM });
      expect(runs.map((run) => [...run.arguments])).toEqual([["--exec-path"]]);
      expect(stubCalls(saved.real)).toEqual([]);
      expect(registers).toEqual([]);
      // The startup context never moves outside the installation root.
      expect(runner.contextPath(bootstrapId)).toBe(moved.wrapper);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a startup upgrade to a version below the minimum gives GIT_UNSUPPORTED with the found version",
    async () => {
      const { wrapper, real } = wrapperLayout("upgrade-old");
      const saved = savedOf(wrapper, real);
      upgrade(wrapper, "2.43.0.windows.1");
      registers.length = 0;
      const result = await revalidateSavedGit(counted, { bootstrapId: runner.addContext("gitProbe", wrapper), ...saved }, crypto.randomUUID());
      expect(result).toMatchObject({ ok: false, gitCode: "GIT_UNSUPPORTED", detectedVersion: "2.43.0.windows.1", minimumVersion: MINIMUM });
      expect(registers).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an admitted wrapper candidate keeps the wrapper as selectedPath, and a direct candidate is its own selectedPath",
    async () => {
      const { wrapper, real } = wrapperLayout("selected-wrapper");
      const viaWrapper = await probeGit(counted, { bootstrapId: runner.addContext("gitProbe", wrapper), executablePath: wrapper });
      expect(viaWrapper).toMatchObject({ ok: true, installation: { selectedPath: wrapper, executablePath: real } });
      const direct = stub("selected-direct", MINIMUM);
      const viaFile = await probeGit(counted, { bootstrapId: runner.addContext("gitProbe", direct), executablePath: direct });
      expect(viaFile).toMatchObject({ ok: true, installation: { selectedPath: direct, executablePath: direct } });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a chooseGit success with a new gitInstallationId releases the previous one once, and a chooseGit that ends before the shell binds a new ID releases nothing",
    async () => {
      const frames: { response?: Record<string, unknown> }[] = [];
      const session = createSession({
        writer: { write: (frame) => void frames.push(frame as never), flush: async () => {} },
        runner: { ...counted, receive: () => false } as unknown as SessionOptions["runner"],
        fail: () => {},
      });
      const handshake = {
        version: 1,
        restarted: false,
        platformScope: "other",
        osBuild: 26200,
        webView2Version: "140.0.0.0",
        buildIdentity: { version: "0.1.0", commit: "0".repeat(40), channel: "local" },
        markers: [],
        unloadedMarkers: 0,
        damagedMarkers: [],
        trustRecords: [],
      };
      const send = (frame: object) => session.receive({ type: "frame", body: new TextEncoder().encode(JSON.stringify(frame)) });
      send({ kind: "handshake", handshake });
      const sessionId = session.sessionId as string;
      const choose = async (exe: string) => {
        const requestId = crypto.randomUUID();
        const payload = { bootstrapId: runner.addContext("gitProbe", exe), executablePath: exe };
        send({ kind: "public", request: { version: 1, sessionId, requestId, operation: "chooseGit", payload } });
        const deadline = Date.now() + TEST_TIMEOUT_MS / 2;
        for (;;) {
          const response = frames.find((f) => f.response?.requestId === requestId)?.response;
          if (response) return response;
          if (Date.now() > deadline) throw new Error("no chooseGit response");
          await Bun.sleep(10);
        }
      };
      releases.length = 0;

      const a = await choose(stub("release-a", MINIMUM));
      expect(a).toMatchObject({ state: "succeeded" });
      expect(releases).toEqual([]);

      const b = await choose(stub("release-b", MINIMUM));
      expect(b).toMatchObject({ state: "succeeded" });
      const previous = (a.result as { gitInstallationId: string }).gitInstallationId;
      expect((b.result as { gitInstallationId: string }).gitInstallationId).not.toBe(previous);
      expect(releases).toEqual([{ gitInstallationId: previous }]);

      expect(await choose(stub("release-old", "2.43.0"))).toMatchObject({ state: "failed", code: "GIT_UNSUPPORTED" });
      runner.inject.registerResult = { result: "declined" };
      try {
        expect(await choose(stub("release-declined", MINIMUM))).toMatchObject({ state: "canceled" });
      } finally {
        runner.inject.registerResult = { result: "approved" };
      }
      expect(releases).toEqual([{ gitInstallationId: previous }]);
    },
    TEST_TIMEOUT_MS,
  );
});
