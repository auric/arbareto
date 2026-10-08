// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../../src/contracts/limits";
import { createCollector, PROCESS_LIMITS, type GitCall, type ProcessContext } from "../../src/git-service/git-runner";
import { createBunRunner, createTrustStore, HOST_SCRIPT, type BunRunner } from "./bun-runner";
import { fixtureDir, fixtureGit, fixturePath, serviceEnv, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);

useFixtureRoot();

const { processCreationTime } = require(HOST_SCRIPT) as typeof import("./win32");

const MIB = 1024 * 1024;
const TEST_TIMEOUT_MS = 30_000;
const LINGER_MS = 6000;
const BLOB_BYTES = 300_000;
const id = () => crypto.randomUUID();
const slash = (path: string) => path.replaceAll("\\", "/");
const text = (collector: { take(): Uint8Array }) => new TextDecoder().decode(collector.take());

describeGit("bun runner", (git) => {
  let repo: string;
  let runner: BunRunner;
  let context: ProcessContext;
  let repositoryId: string;
  let commonDirectory: string;
  let blob: string;
  const hostileGitDir = () => fixturePath("hostile.git");
  const hostileIndex = () => fixturePath("hostile-index");

  // A `!` alias runs through the shell of Git. It starts a recorded process that holds the pipes for `LINGER_MS`.
  const lingerAlias = (ready: string, background: boolean) => {
    const linger = `"${slash(process.execPath)}" "${slash(HOST_SCRIPT)}" "${slash(runner.recordsDirectory)}" ${LINGER_MS} "${slash(ready)}"`;
    if (!background) return `alias.hold=!${linger}`;
    const wait = `i=0; while [ $i -lt 200 ] && [ ! -e "${slash(ready)}" ]; do sleep 0.05; i=$((i+1)); done`;
    return `alias.hold=!${linger} & ${wait}; echo early >&2`;
  };

  function call(fields: Partial<GitCall> = {}): GitCall & { stdout: ReturnType<typeof createCollector>; stderr: ReturnType<typeof createCollector> } {
    return {
      operationId: id(),
      context,
      arguments: ["--no-lazy-fetch", "rev-parse", "--absolute-git-dir"],
      environmentPolicy: "read",
      limits: PROCESS_LIMITS.git,
      stdout: createCollector({ maxBytes: 4 * MIB }),
      stderr: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
      signal: new AbortController().signal,
      ...fields,
    } as never;
  }

  beforeAll(async () => {
    repo = fixtureDir("repo");
    fixtureGit(git, repo, ["init", "-q"]);
    writeFileSync(join(repo, "big.bin"), new Uint8Array(BLOB_BYTES).fill(0x62));
    fixtureGit(git, repo, ["add", "big.bin"]);
    fixtureGit(git, repo, ["commit", "-q", "-m", "fixture"]);
    blob = fixtureGit(git, repo, ["rev-parse", "HEAD:big.bin"]).trim();
    commonDirectory = join(repo, ".git");
    runner = createBunRunner({
      git,
      directory: fixtureDir("runner"),
      environment: serviceEnv({ GIT_DIR: hostileGitDir(), GIT_INDEX_FILE: hostileIndex(), GIT_TEST_ARBARETO: "1", GIT_TERMINAL_PROMPT: "1" }),
    });
    const gitInstallationId = id();
    const probe = runner.addContext("gitProbe", git);
    expect(await runner.register({ operationId: id(), bootstrapId: probe, gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false })).toEqual({ result: "approved" });
    const discovery = runner.addContext("repositoryDiscovery", repo);
    repositoryId = id();
    const registration = { operationId: id(), bootstrapId: discovery, gitInstallationId, repositoryId, worktreeRoot: repo, gitDirectory: commonDirectory, commonDirectory };
    expect(await runner.register(registration)).toEqual({ result: "approved" });
    context = { contextKind: "registeredOperation", gitInstallationId, repositoryId };
  });

  afterAll(async () => {
    await runner.dispose();
  });

  test("a read resolves with its exit code and every stdout byte", async () => {
    const c = call();
    expect(await runner.run(c)).toEqual({ exitCode: 0, activeDescendants: 0 });
    expect(slash(text(c.stdout).trim()).toLowerCase()).toBe(slash(commonDirectory).toLowerCase());
    const failed = call({ arguments: ["--no-lazy-fetch", "rev-parse", "--verify", "--quiet", "refs/heads/absent"] });
    expect(await runner.run(failed)).toEqual({ exitCode: 1, activeDescendants: 0 });
  });

  test("each recorded call keeps its wall time from the request to the exit", async () => {
    const nap = `alias.nap=!"${slash(process.execPath)}" -e 'setTimeout(() => {}, 200)'`;
    const slow = call({ arguments: ["--no-lazy-fetch", "-c", nap, "nap"] });
    expect(await runner.run(slow)).toEqual({ exitCode: 0, activeDescendants: 0 });
    const fast = call();
    expect(await runner.run(fast)).toEqual({ exitCode: 0, activeDescendants: 0 });
    const durationMs = (c: GitCall) => runner.calls.find((r) => r.operationId === c.operationId)?.durationMs ?? Number.NaN;
    expect(durationMs(slow)).toBeGreaterThanOrEqual(150);
    expect(durationMs(fast)).toBeLessThan(150);
  });

  test("gitProbe runs only the version probe, and an array without --no-lazy-fetch is refused", async () => {
    const before = runner.spawned;
    for (const args of [["status"], ["rev-parse", "--no-lazy-fetch"]]) {
      await expect(runner.run(call({ arguments: args }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    const probe = (bootstrapId: string, args: string[]) =>
      call({ context: { contextKind: "gitProbe", bootstrapId }, environmentPolicy: "probe", arguments: args });
    await expect(runner.run(probe(runner.addContext("gitProbe", git), ["--no-lazy-fetch", "version"]))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(runner.spawned).toBe(before);
    const version = probe(runner.addContext("gitProbe", git), ["version", "--build-options"]);
    expect(await runner.run(version)).toMatchObject({ exitCode: 0 });
    expect(text(version.stdout)).toStartWith("git version ");
    await expect(runner.run(probe(id(), ["version", "--build-options"]))).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
  });

  test("each policy builds the child environment from src/contracts/git-environment.json", async () => {
    const env = call({ arguments: ["--no-lazy-fetch", "-c", "alias.e=!env", "e"] });
    expect(await runner.run(env)).toMatchObject({ exitCode: 0 });
    const lines = text(env.stdout).split("\n");
    expect(lines).toContain("GIT_TERMINAL_PROMPT=0");
    expect(lines).toContain("GIT_NO_LAZY_FETCH=1");
    expect(lines.filter((l) => /^(GIT_DIR|GIT_INDEX_FILE|GIT_TEST_ARBARETO)=/.test(l))).toEqual([]);

    const indexPath = (fields: Partial<GitCall>) => call({ arguments: ["--no-lazy-fetch", "rev-parse", "--git-path", "index"], ...fields });
    const read = indexPath({});
    await runner.run(read);
    expect(text(read.stdout).trim()).toBe(".git/index");
    const indexFile = join(commonDirectory, "arbareto-candidate-test");
    const mutation = indexPath({ environmentPolicy: "mutation", transaction: { transactionId: id(), indexFile } });
    await runner.run(mutation);
    expect(slash(text(mutation.stdout).trim())).toBe(slash(indexFile));
    const network = indexPath({ environmentPolicy: "network", limits: PROCESS_LIMITS.network });
    await runner.run(network);
    expect(text(network.stdout).trim()).toBe(".git/index");
  });

  test("the call forwards every byte written before the exit and keeps 64 KiB of stderr", async () => {
    for (const bytes of [1, 4096, 70_000, 200_000]) {
      const c = call({ arguments: ["--no-lazy-fetch", "-c", `alias.z=!head -c ${bytes} /dev/zero >&2`, "z"] });
      expect(await runner.run(c)).toEqual({ exitCode: 0, activeDescendants: 0 });
      expect(c.stderr.bytes).toBe(bytes);
      expect(c.stderr.take().length).toBe(Math.min(bytes, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM));
    }
    const cat = call({ arguments: ["--no-lazy-fetch", "cat-file", "blob", blob] });
    await runner.run(cat);
    expect(cat.stdout.bytes).toBe(BLOB_BYTES);
  });

  // pipe(7): F_SETPIPE_SZ returns the new capacity. The child fails unless its stderr pipe holds all its bytes before the exit.
  test.skipIf(process.platform !== "linux")("the call forwards every byte of a pipe that the child enlarged (needs Linux F_SETPIPE_SZ)", async () => {
    const script = fixturePath("enlarge-pipe.ts");
    writeFileSync(
      script,
      [
        `import { dlopen, FFIType } from "bun:ffi";`,
        `import { writeSync } from "node:fs";`,
        `const { i32 } = FFIType;`,
        `const { fcntl } = dlopen("libc.so.6", { fcntl: { args: [i32, i32, i32], returns: i32 } }).symbols;`,
        // include/uapi/linux/fcntl.h: F_SETPIPE_SZ is F_LINUX_SPECIFIC_BASE (1024) + 7.
        `if (fcntl(2, 1031, 262144) < 262144) process.exit(1);`,
        `const bytes = new Uint8Array(200000);`,
        `for (let done = 0; done < bytes.length; ) done += writeSync(2, bytes, done);`,
      ].join("\n"),
    );
    const c = call({ arguments: ["--no-lazy-fetch", "-c", `alias.z=!"${slash(process.execPath)}" "${slash(script)}"`, "z"] });
    expect(await runner.run(c)).toEqual({ exitCode: 0, activeDescendants: 0 });
    expect(c.stderr.bytes).toBe(200_000);
  });

  test(
    "a deadline ends the process, and the call resolves with exitCode null",
    async () => {
      const started = performance.now();
      const ready = fixturePath("ready-deadline");
      const c = call({ arguments: ["--no-lazy-fetch", "-c", lingerAlias(ready, false), "hold"], limits: { deadlineMs: 1500 } });
      const exit = await runner.run(c);
      expect(exit).toMatchObject({ exitCode: null, deadline: "deadline" });
      expect(performance.now() - started).toBeLessThan(LINGER_MS - 1000);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a descendant holds the pipes after Git exits, and the call still resolves at the exit",
    async () => {
      const operationId = id();
      expect(await runner.started({ operationId, repositoryId, kind: "commit", worktreeRoot: repo, commonDirectory })).toMatchObject({ markerId: expect.any(String) });
      const ready = fixturePath("ready-linger");
      const started = performance.now();
      const c = call({ operationId, environmentPolicy: "mutation", arguments: ["--no-lazy-fetch", "-c", lingerAlias(ready, true), "hold"] });
      const exit = await runner.run(c);
      expect(performance.now() - started).toBeLessThan(LINGER_MS - 1000);
      expect(exit).toEqual({ exitCode: 0, activeDescendants: 1 });
      expect(text(c.stderr)).toBe("early\n");
      expect(await runner.lingeringCount(id(), commonDirectory)).toBe(1);
      expect(await runner.trust({ type: "revoke", commonDirectory })).toEqual({ endedProcesses: 1 });
      expect(await runner.lingeringCount(id(), commonDirectory)).toBe(0);
      expect(text(c.stderr)).toBe("early\n");
      runner.ended(operationId, false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "cancel through the abort signal ends the process",
    async () => {
      const controller = new AbortController();
      const ready = fixturePath("ready-cancel");
      const c = call({ arguments: ["--no-lazy-fetch", "-c", lingerAlias(ready, false), "hold"], signal: controller.signal });
      const result = runner.run(c);
      for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(25);
      controller.abort();
      expect(await result).toMatchObject({ exitCode: null });
    },
    TEST_TIMEOUT_MS,
  );

  // The double ends only the spawned Git, so the `head` grandchild can still write after the cancel.
  test("4 MiB of forwarded stderr ends the process", async () => {
    const c = call({ arguments: ["--no-lazy-fetch", "-c", `alias.z=!head -c ${5 * MIB} /dev/zero >&2`, "z"] });
    expect(await runner.run(c)).toMatchObject({ exitCode: null, diagnosticLimit: true });
    expect(c.stderr.bytes).toBeGreaterThanOrEqual(4 * MIB);
  });

  test("stdin closes after the bounded input, or at once without input", async () => {
    const withInput = call({ arguments: ["--no-lazy-fetch", "cat-file", "--batch-check"], input: new TextEncoder().encode(`${blob}\n`) });
    expect(await runner.run(withInput)).toEqual({ exitCode: 0, activeDescendants: 0 });
    expect(text(withInput.stdout)).toBe(`${blob} blob ${BLOB_BYTES}\n`);
    const without = call({ arguments: ["--no-lazy-fetch", "cat-file", "--batch-check"] });
    expect(await runner.run(without)).toEqual({ exitCode: 0, activeDescendants: 0 });
    expect(without.stdout.bytes).toBe(0);
  });

  test(
    "ended with endProcesses ends the recorded processes of that operation",
    async () => {
      const operationId = id();
      await runner.started({ operationId, repositoryId, kind: "commit", worktreeRoot: repo, commonDirectory });
      const ready = fixturePath("ready-ended");
      const exit = await runner.run(call({ operationId, environmentPolicy: "mutation", arguments: ["--no-lazy-fetch", "-c", lingerAlias(ready, true), "hold"] }));
      expect(exit).toEqual({ exitCode: 0, activeDescendants: 1 });
      runner.ended(operationId, true);
      expect(await runner.lingeringCount(id(), commonDirectory)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test("the start barrier holds the process, and the stdout barrier holds the pipe", async () => {
    const release = runner.holdStart();
    const before = runner.spawned;
    const held = runner.run(call());
    await Bun.sleep(200);
    expect(runner.spawned).toBe(before);
    release();
    expect(await held).toMatchObject({ exitCode: 0 });
    expect(runner.spawned).toBe(before + 1);

    const resume = runner.pauseStdout();
    const cat = call({ arguments: ["--no-lazy-fetch", "cat-file", "blob", blob] });
    let done = false;
    const result = runner.run(cat).then((exit) => ((done = true), exit));
    await Bun.sleep(1000);
    expect(done).toBe(false);
    expect(cat.stdout.bytes).toBe(0);
    resume();
    expect(await result).toEqual({ exitCode: 0, activeDescendants: 0 });
    expect(cat.stdout.bytes).toBe(BLOB_BYTES);
  });

  test("the marker store keeps the started paths and the frame order, and a test can inject a failed write", async () => {
    const operationId = id();
    const frame = { operationId, repositoryId: id(), kind: "applyFile", worktreeRoot: repo, commonDirectory } as const;
    const { markerId } = (await runner.started(frame)) as { markerId: string };
    expect(runner.markers.get(markerId)).toEqual(frame);
    runner.ended(operationId, false);
    runner.resolved(markerId);
    expect(runner.markers.has(markerId)).toBe(false);
    expect(runner.frames.slice(-3).map((f) => f.type)).toEqual(["started", "ended", "resolved"]);
    runner.inject.markerFailure = "access-denied";
    const failed = await runner.started({ ...frame, operationId: id() });
    runner.inject.markerFailure = undefined;
    expect(failed).toMatchObject({ failure: "access-denied", folder: expect.any(String) });
    await expect(runner.run(call({ operationId }))).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
  });

  test("identity requests read FileIdInfo, and an all-zero or all-ones file ID is refused", async () => {
    const operationId = id();
    const signal = new AbortController().signal;
    const replies = await runner.identities(operationId, context, [repo, commonDirectory, repo], signal);
    if (!Array.isArray(replies)) throw new Error(`walk stop: ${replies.stop}`);
    const [a, b, again] = replies;
    expect(JSON.stringify(again)).toBe(JSON.stringify(a));
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
    expect(Object.keys(a)).toEqual(["volumeSerial", "fileId"]);
    expect((a as { volumeSerial: string }).volumeSerial).toMatch(/^[0-9a-f]{16}$/);
    expect((a as { fileId: string }).fileId).toMatch(/^[0-9a-f]{32}$/);
    runner.inject.fileIds.set(repo, new Uint8Array(16));
    runner.inject.fileIds.set(commonDirectory, new Uint8Array(16).fill(0xff));
    expect(await runner.identities(operationId, context, [repo, commonDirectory], signal)).toEqual([{ code: "UNSUPPORTED_REPOSITORY" }, { code: "UNSUPPORTED_REPOSITORY" }]);
    runner.inject.fileIds.clear();
    // Contract §6 "Process fields": only a not-found open adds `reason` `absent`.
    expect(await runner.identities(operationId, context, [join(repo, "absent"), join(repo, "absent", "child")], signal)).toEqual([
      { code: "UNSUPPORTED_REPOSITORY", reason: "absent" },
      { code: "UNSUPPORTED_REPOSITORY", reason: "absent" },
    ]);
  });

  test("the trust store keys records by identity, survives a new session, and follows persist and revoke", async () => {
    const store = createTrustStore();
    const first = createBunRunner({ git, directory: fixtureDir("trust-1"), environment: serviceEnv(), trustStore: store });
    const linked = fixtureDir("linked");
    const confirm = (worktreeRoot: string, persist: boolean) => ({
      type: "confirm" as const,
      worktreeRoot,
      gitDirectory: commonDirectory,
      commonDirectory,
      gitSelectedPath: git,
      fingerprint: "a".repeat(64),
      ...(persist ? { persist: true as const } : { persist: false as const, bound: "file-count" as const }),
    });
    const stored = await first.trust(confirm(repo, true));
    expect(stored).toMatchObject({ result: "approved", stored: true, record: { worktreeRoot: repo, commonDirectory } });
    await first.trust(confirm(linked, true));
    expect(store.records.length).toBe(2);
    await first.dispose();

    const second = createBunRunner({ git, directory: fixtureDir("trust-2"), environment: serviceEnv(), trustStore: store });
    expect(store.records.map((r) => r.worktreeRoot)).toEqual([repo, linked]);
    second.inject.confirmResult = "declined";
    expect(await second.trust(confirm(repo, true))).toEqual({ result: "declined" });
    expect(store.records.length).toBe(2);
    second.inject.confirmResult = "approved";
    expect(await second.trust(confirm(repo, false))).toEqual({ result: "approved", stored: false });
    expect(store.records.map((r) => r.worktreeRoot)).toEqual([linked]);
    await second.trust(confirm(repo, true));
    expect(await second.trust({ type: "revoke", commonDirectory })).toEqual({ endedProcesses: 0 });
    expect(store.records).toEqual([]);
    expect(store.persists).toEqual([true, true, true, false, true]);
    await second.dispose();
  });

  test("dispose ends each recorded live process", async () => {
    const records = readdirSync(runner.recordsDirectory).map((n) => n.split("-").map(BigInt));
    await runner.dispose();
    for (const [pid, created] of records) expect(processCreationTime(Number(pid)) === created).toBe(false);
  });
});
