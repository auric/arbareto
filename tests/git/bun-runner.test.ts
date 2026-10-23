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

const { closePipe, createInboundPipe, ownTree, processCreationTime } = require(HOST_SCRIPT) as typeof import("./win32");

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

  // The record of each call holds the time from its run request to its exit. The child prints `performance.now()`, its own run time from its process start,
  // and its process lives inside that interval. The test measures the time around the call, which holds the interval. So no timing bound decides.
  test("each recorded call keeps its wall time from the request to the exit", async () => {
    const child = (body: string) => call({ arguments: ["--no-lazy-fetch", "-c", `alias.t=!"${slash(process.execPath)}" -e '${body}'`, "t"] });
    for (const c of [child("setTimeout(() => console.log(performance.now()), 200)"), child("console.log(performance.now())")]) {
      const start = performance.now();
      expect(await runner.run(c)).toEqual({ exitCode: 0, activeDescendants: 0 });
      const elapsed = performance.now() - start;
      const own = Number(text(c.stdout).trim());
      const recorded = runner.calls.find((r) => r.operationId === c.operationId)?.durationMs ?? Number.NaN;
      expect({ own: own > 0, ownWithin: own <= recorded, recordedWithin: recorded <= elapsed }).toEqual({ own: true, ownWithin: true, recordedWithin: true });
    }
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
    "injected activity limits: a silent network process ends at inactivity, an active one at the ceiling, and a tracked call gets stalled and active at each state change",
    async () => {
      // A `!` alias that writes `x` to stderr at each time in `at`, then exits at `end` milliseconds.
      const script = (at: number[], end: number) => `alias.act=!"${slash(process.execPath)}" -e '${at.map((t) => `setTimeout(() => process.stderr.write("x"), ${t});`).join(" ")} setTimeout(() => {}, ${end})'`;
      const act = (fields: Partial<GitCall>, at: number[], end: number) => call({ arguments: ["--no-lazy-fetch", "-c", script(at, end), "act"], ...fields });
      try {
        runner.inject.limits = { inactivityMs: 300 };
        expect(await runner.run(act({ environmentPolicy: "network", limits: PROCESS_LIMITS.network }, [], 5_000))).toMatchObject({ exitCode: null, deadline: "inactivity" });
        runner.inject.limits = { ceilingMs: 1_000 };
        const busy = Array.from({ length: 50 }, (_, i) => i * 100);
        expect(await runner.run(act({ environmentPolicy: "network", limits: PROCESS_LIMITS.network }, busy, 5_000))).toMatchObject({ exitCode: null, deadline: "ceiling" });
        runner.inject.limits = { stallMs: 300 };
        const states: string[] = [];
        const tracked = act({ environmentPolicy: "mutation", limits: PROCESS_LIMITS.commit, onActivity: (state) => void states.push(state) }, [1_000], 2_000);
        expect(await runner.run(tracked)).toEqual({ exitCode: 0, activeDescendants: 0 });
        expect(states).toEqual(["stalled", "active", "stalled"]);
      } finally {
        runner.inject.limits = {};
      }
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

  // Contract §6 `cancel`: the shell closes the Job of the operation that owns the call. The native runner sends it for a limited stdout.
  // Mirrors `cancel_closes_only_the_job_of_that_operation_at_once_while_a_grandchild_sleeps` and `a_run_after_a_run_cancel_starts_in_a_new_job_of_the_same_operation` in src-tauri/src/process_requests.rs.
  test(
    "T391: a limited stdout ends every running call of its operation with exitCode null, a call of another operation runs on, and the operation stays active",
    async () => {
      // The limited call is a spawned Git, then injected stdout bytes. Injected bytes give `activeDescendants` 0.
      for (const [form, limitedExit] of [
        ["spawned", { exitCode: null, activeDescendants: null }],
        ["injected", { exitCode: null, activeDescendants: 0 }],
      ] as const) {
        const go = fixturePath(`go-t391-${form}`);
        // A `!` alias that marks `ready`, then waits at most 20 s for `go` and exits 0 only when `go` exists.
        const waiting = (ready: string, operationId: string) =>
          call({ operationId, arguments: ["--no-lazy-fetch", "-c", `alias.w=!: > "${slash(ready)}"; i=0; while [ $i -lt 400 ] && [ ! -e "${slash(go)}" ]; do sleep 0.05; i=$((i+1)); done; [ -e "${slash(go)}" ]`, "w"] });
        const operationId = id();
        const readies = [fixturePath(`ready-t391-${form}-sibling`), fixturePath(`ready-t391-${form}-other`)];
        const sibling = runner.run(waiting(readies[0]!, operationId));
        const other = runner.run(waiting(readies[1]!, id()));
        for (let i = 0; i < 400 && !readies.every((r) => existsSync(r)); i++) await Bun.sleep(25);
        expect({ form, ready: readies.map((r) => existsSync(r)) }).toEqual({ form, ready: [true, true] });
        const limited = call({ operationId, arguments: ["--no-lazy-fetch", "cat-file", "blob", blob], stdout: createCollector({ maxBytes: 1024 }) });
        if (form === "injected") runner.inject.stdout = (c) => (c.arguments.includes(blob) ? new Uint8Array(BLOB_BYTES) : undefined);
        try {
          expect({ form, exit: await runner.run(limited) }).toEqual({ form, exit: limitedExit });
        } finally {
          runner.inject.stdout = undefined;
        }
        writeFileSync(go, "");
        expect({ [`${form} sibling`]: await sibling, [`${form} other`]: await other }).toEqual({ [`${form} sibling`]: { exitCode: null, activeDescendants: null }, [`${form} other`]: { exitCode: 0, activeDescendants: 0 } });
        expect({ form, next: await runner.run(call({ operationId })) }).toEqual({ form, next: { exitCode: 0, activeDescendants: 0 } });
      }
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
    const frame = { operationId, repositoryId: id(), kind: "applyFile", direction: "stage", worktreeRoot: repo, commonDirectory } as const;
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

  test("the trust store keys records by identity, survives a new session, and follows a failed store and revoke", async () => {
    const store = createTrustStore();
    const first = createBunRunner({ git, directory: fixtureDir("trust-1"), environment: serviceEnv(), trustStore: store });
    const linked = fixtureDir("linked");
    const none = { names: [], more: 0 };
    // Feature 004 contract Δ6: the version 2 frame.
    const confirm = (worktreeRoot: string) => ({
      type: "confirm" as const,
      worktreeRoot,
      adminDirectory: commonDirectory,
      commonDirectory,
      gitSelectedPath: git,
      policyVersion: 2 as const,
      action: "commit" as const,
      details: { hooks: none, filters: none, monitors: none, mergeDrivers: none, mergeTools: none, signing: none, other: none },
    });
    const stored = await first.trust(confirm(repo));
    expect(stored).toMatchObject({ result: "approved", stored: true, record: { policyVersion: 2, worktreeRoot: repo, adminDirectory: commonDirectory, commonDirectory } });
    await first.trust(confirm(linked));
    expect(store.records.length).toBe(2);
    await first.dispose();

    const second = createBunRunner({ git, directory: fixtureDir("trust-2"), environment: serviceEnv(), trustStore: store });
    expect(store.records.map((r) => r.worktreeRoot)).toEqual([repo, linked]);
    second.inject.confirmResult = "declined";
    expect(await second.trust(confirm(repo))).toEqual({ result: "declined" });
    expect(store.records.length).toBe(2);
    second.inject.confirmResult = "approved";
    // Contract §7 "Trust approval store": a failed store leaves the records unchanged.
    second.inject.trustStoreFails = true;
    expect(await second.trust(confirm(repo))).toEqual({ result: "approved", stored: false });
    expect(store.records.map((r) => r.worktreeRoot)).toEqual([repo, linked]);
    second.inject.trustStoreFails = false;
    await second.trust(confirm(repo));
    expect(store.records.map((r) => r.worktreeRoot)).toEqual([linked, repo]);
    expect(await second.trust({ type: "revoke", commonDirectory })).toEqual({ endedProcesses: 0 });
    expect(store.records).toEqual([]);
    expect(second.frames.filter((f) => f.type === "confirm").length).toBe(3);
    await second.dispose();
  });

  test("ownTree does not throw for a fast Git command that exits during the assignment", async () => {
    // The synchronous stall lets the child exit while the assignment runs. The pass condition does not use the timing.
    const failures: string[] = [];
    for (let stallMs = 20; stallMs <= 32; stallMs++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const pipes = [createInboundPipe(65536), createInboundPipe(65536)];
        const proc = Bun.spawn([git, "--exec-path"], { stdin: "pipe", stdout: Bun.file(pipes[0]!.name), stderr: Bun.file(pipes[1]!.name) });
        void proc.stdin.end();
        for (const until = performance.now() + stallMs; performance.now() < until; );
        try {
          ownTree(proc.pid).close();
        } catch (error) {
          failures.push(`${stallMs} ms: ${(error as Error).message}`);
        }
        await proc.exited;
        pipes.forEach(closePipe);
      }
    }
    expect(failures).toEqual([]);
  }, TEST_TIMEOUT_MS * 4);

  test("dispose ends each recorded live process", async () => {
    const records = readdirSync(runner.recordsDirectory).map((n) => n.split("-").map(BigInt));
    // A call that the start barrier holds gets UNKNOWN_TARGET when dispose opens the barrier, and starts no process.
    runner.holdStart();
    const held = runner.run(call()).catch((error: unknown) => error);
    const before = runner.spawned;
    await runner.dispose();
    expect(await held).toMatchObject({ code: "UNKNOWN_TARGET" });
    expect(runner.spawned).toBe(before);
    for (const [pid, created] of records) expect(processCreationTime(Number(pid)) === created).toBe(false);
  });
});
