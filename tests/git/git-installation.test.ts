// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, copyFileSync, existsSync, ftruncateSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { GIT_EXECUTABLE_DIGEST_BYTES } from "../../src/contracts/limits";
import { probeGit, revalidateGit } from "../../src/git-service/git-installation";
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
// Like Git before 2.45.0, it rejects `--no-lazy-fetch` with "unknown option" (contract §7 "Missing objects").
const STUB_SOURCE = `
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const dir = dirname(process.execPath);
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args.includes("--no-lazy-fetch")) {
  process.stderr.write("unknown option: --no-lazy-fetch\\nusage: git [-v | --version] [-h | --help] <command> [<args>]\\n");
  process.exit(129);
}
if (args.length === 2 && args[0] === "version" && args[1] === "--build-options") {
  const version = readFileSync(join(dir, "version.txt"), "utf8").trim();
  process.stdout.write("git version " + version + "\\ncpu: x86_64\\nsizeof-long: 4\\nsizeof-size_t: 8\\n");
  process.exit(0);
}
process.exit(1);
`;

type StubCall = { args: string[]; cwd: string };

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

describe("Git installation probe (T053)", () => {
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
      expect(runs).toHaveLength(1);
      expect(runs[0].context).toEqual({ contextKind: "gitProbe", bootstrapId });
      expect([...runs[0].arguments]).toEqual(["version", "--build-options"]);
      expect(runs[0].environmentPolicy).toBe("probe");
      expect(stubCalls(exe)).toEqual([{ args: ["version", "--build-options"], cwd: launchDirectory }]);
      // The service never selects another executable.
      expect(registers).toEqual([]);
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
      expect(stubCalls(exe)).toEqual([{ args: ["version", "--build-options"], cwd: launchDirectory }]);
      // Contract §6 `register`: the issued ID binds to the probed context.
      expect(registers).toHaveLength(1);
      expect(registers[0]).toMatchObject({ bootstrapId, gitInstallationId: installation.gitInstallationId, version: MINIMUM });
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
          { contextKind: "gitProbe", bootstrapId },
          { contextKind: "gitProbe", bootstrapId: next },
        ]);
        expect(stubCalls(first)).toEqual([{ args: ["version", "--build-options"], cwd: launchDirectory }]);
        expect(stubCalls(second)).toEqual([{ args: ["version", "--build-options"], cwd: launchDirectory }]);
        expect(registers.map((request) => request.bootstrapId)).toEqual([bootstrapId, next]);
        expect(registers[0].gitInstallationId).not.toBe(registers[1].gitInstallationId);
        expect(registers[1].gitInstallationId).toBe(installation.gitInstallationId);
      } finally {
        runner.inject.registerResult = { result: "approved" };
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a chooseGit success with a new gitInstallationId releases the previous one once, and a failed or canceled one releases nothing",
    async () => {
      const frames: { response?: Record<string, unknown> }[] = [];
      const session = createSession({
        writer: { write: (frame) => void frames.push(frame as never), flush: async () => {} },
        runner: { ...counted, receive: () => false } as SessionOptions["runner"],
        fail: () => {},
      });
      const handshake = {
        version: 1,
        restarted: false,
        platformScope: "other",
        osBuild: 26200,
        webView2Version: "140.0.0.0",
        buildIdentity: { version: "0.1.0", commit: "0".repeat(40), signing: "unsigned" },
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
