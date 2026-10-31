// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { printOrigin } from "../origin";
import { FileFact as FileFactSchema, ProcessReply } from "../../src/contracts/channel";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, REGISTERED_DEADLINE_CAP_MS, TRUST_DIGEST_FILE_BYTES } from "../../src/contracts/limits";
import { createCollector, PROCESS_LIMITS, type FileFact, type GitCall, type ProcessContext, type WorkingReplaceRequest } from "../../src/git-service/git-runner";
import { createBunRunner, createTrustStore, gitForm, HOST_SCRIPT, type BunRunner } from "./bun-runner";
import { fixtureDir, fixtureGit, fixturePath, serviceEnv, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);
printOrigin("./bun-runner.ts", import.meta.dir);

useFixtureRoot();

const { closePipe, createInboundPipe, ownTree, processCreationTime } = require(HOST_SCRIPT) as typeof import("./win32");

const MIB = 1024 * 1024;
const TEST_TIMEOUT_MS = 30_000;
const LINGER_MS = 6000;
const BLOB_BYTES = 300_000;
const id = () => crypto.randomUUID();
const slash = (path: string) => path.replaceAll("\\", "/");
const text = (collector: { take(): Uint8Array }) => new TextDecoder().decode(collector.take());

// 006 T055: the double folds and refuses as `linux_path` of `src-tauri/src/wsl.rs`. No process starts.
test("gitForm folds . and .. and refuses a segment with a character in U+F000 to U+F0FF, as wsl::linux_path", () => {
  const wsl = { distro: "Ubuntu-26.04" };
  expect(gitForm("\\\\wsl.localhost\\ubuntu-26.04\\home\\.\\u\\x\\..\\repo\\", wsl)).toBe("/home/u/repo");
  expect(gitForm("\\\\wsl$\\Ubuntu-26.04\\..\\..\\etc", wsl)).toBe("/etc");
  expect(gitForm("\\\\wsl.localhost\\Ubuntu-26.04", wsl)).toBe("/");
  expect(gitForm("\\\\wsl.localhost\\Ubuntu-26.04\\home\\a\uf03ab\\..\\c", wsl)).toBeNull();
  expect(gitForm("\\\\wsl.localhost\\Ubuntu-26.04\\home\\\uf0ff", wsl)).toBeNull();
  expect(gitForm("\\\\wsl.localhost\\Ubuntu-26.04\\home\\\uefff\uf100", wsl)).toBe("/home/\uefff\uf100");
  expect(gitForm("\\\\wsl.localhost\\Other\\home", wsl)).toBeNull();
  expect(gitForm("C:\\work\\..\\repo", undefined)).toBe("C:\\work\\..\\repo");
  expect(gitForm("\\\\wsl.localhost\\Ubuntu-26.04\\home", undefined)).toBeNull();
});

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

  // Contract §6 `stop`: the native runner sends it for a limited stdout. The shell ends only the process of that call, and the operation Job stays open.
  // Mirrors `stop_ends_only_the_process_of_its_call_and_the_job_stays_open` in src-tauri/src/process_requests.rs.
  test(
    "T392: a limited stdout ends only its own call with exitCode null, a sibling and a call of another operation exit 0, and the operation stays active",
    async () => {
      // The limited call is a spawned Git, then injected stdout bytes.
      for (const form of ["spawned", "injected"] as const) {
        const go = fixturePath(`go-t392-${form}`);
        // A `!` alias that marks `ready`, then waits at most 20 s for `go` and exits 0 only when `go` exists.
        const waiting = (ready: string, operationId: string) =>
          call({ operationId, arguments: ["--no-lazy-fetch", "-c", `alias.w=!: > "${slash(ready)}"; i=0; while [ $i -lt 400 ] && [ ! -e "${slash(go)}" ]; do sleep 0.05; i=$((i+1)); done; [ -e "${slash(go)}" ]`, "w"] });
        const operationId = id();
        const readies = [fixturePath(`ready-t392-${form}-sibling`), fixturePath(`ready-t392-${form}-other`)];
        const sibling = runner.run(waiting(readies[0]!, operationId));
        const other = runner.run(waiting(readies[1]!, id()));
        for (let i = 0; i < 400 && !readies.every((r) => existsSync(r)); i++) await Bun.sleep(25);
        expect({ form, ready: readies.map((r) => existsSync(r)) }).toEqual({ form, ready: [true, true] });
        const limited = call({ operationId, arguments: ["--no-lazy-fetch", "cat-file", "blob", blob], stdout: createCollector({ maxBytes: 1024 }) });
        if (form === "injected") runner.inject.stdout = (c) => (c.arguments.includes(blob) ? new Uint8Array(BLOB_BYTES) : undefined);
        try {
          expect({ form, exit: await runner.run(limited) }).toEqual({ form, exit: { exitCode: null, activeDescendants: 0 } });
        } finally {
          runner.inject.stdout = undefined;
        }
        writeFileSync(go, "");
        expect({ [`${form} sibling`]: await sibling, [`${form} other`]: await other }).toEqual({ [`${form} sibling`]: { exitCode: 0, activeDescendants: 0 }, [`${form} other`]: { exitCode: 0, activeDescendants: 0 } });
        expect({ form, next: await runner.run(call({ operationId })) }).toEqual({ form, next: { exitCode: 0, activeDescendants: 0 } });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Contract §6 "Byte caps" (T394): only a `read` or `search` run gets `stop` at a stdout bound. A run of another policy drops the later bytes and runs to its own exit.
  test(
    "T394: a limited stdout of a mutation or integrate call ends no process, and the call exits 0 with every byte counted, as a spawned Git and as injected stdout bytes",
    async () => {
      for (const form of ["spawned", "injected"] as const) {
        for (const [policy, limits] of [["mutation", PROCESS_LIMITS.git], ["integrate", PROCESS_LIMITS.network]] as const) {
          const c = call({ environmentPolicy: policy, limits, arguments: ["--no-lazy-fetch", "cat-file", "blob", blob], stdout: createCollector({ maxBytes: 1024 }) });
          if (form === "injected") runner.inject.stdout = (x) => (x.arguments.includes(blob) ? new Uint8Array(BLOB_BYTES) : undefined);
          try {
            const exit = await runner.run(c);
            expect({ form, policy, exit, limited: c.stdout.limited, bytes: c.stdout.bytes }).toEqual({ form, policy, exit: { exitCode: 0, activeDescendants: 0 }, limited: true, bytes: BLOB_BYTES });
          } finally {
            runner.inject.stdout = undefined;
          }
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Contract §6 `stop`: a descendant of a stopped process stays in the operation Job until the Job closes. Its record lies outside the records folder of the double.
  test.skipIf(process.platform !== "win32")(
    "T394: closeJob ends a descendant that a stopped call left (needs a Windows Job: the Linux tree walk of linux.ts loses an orphan of an ended root)",
    async () => {
      const operationId = id();
      const own = fixtureDir("t394-own-records");
      const ready = fixturePath("ready-t394-stopped");
      const hold = `"${slash(process.execPath)}" "${slash(HOST_SCRIPT)}" "${slash(own)}" 60000 "${slash(ready)}"`;
      const wait = `i=0; while [ $i -lt 400 ] && [ ! -e "${slash(ready)}" ]; do sleep 0.05; i=$((i+1)); done`;
      const c = call({ operationId, arguments: ["--no-lazy-fetch", "-c", `alias.s=!${hold} & ${wait}; echo 0123456789abcdef; wait`, "s"], stdout: createCollector({ maxBytes: 8 }) });
      expect(await runner.run(c)).toMatchObject({ exitCode: null });
      const [pid, created] = readdirSync(own)[0]!.split("-") as [string, string];
      const alive = () => processCreationTime(Number(pid)) === BigInt(created);
      expect(alive()).toBe(true);
      runner.closeJob(operationId);
      for (let i = 0; i < 400 && alive(); i++) await Bun.sleep(25);
      expect(alive()).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  // Contract §6 `cancel`: the native runner sends it at an abort and at the 4 MiB stderr bound. The shell then closes the Job of the operation that owns the call.
  // Mirrors `cancel_closes_only_the_job_of_that_operation_at_once_while_a_grandchild_sleeps` and `a_run_after_a_run_cancel_starts_in_a_new_job_of_the_same_operation` in src-tauri/src/process_requests.rs.
  test(
    "T393: an abort or the 4 MiB stderr bound of one call ends every running call of its operation with exitCode null, a call of another operation exits 0, and the operation stays active",
    async () => {
      for (const form of ["abort", "stderr"] as const) {
        const go = fixturePath(`go-t393-${form}`);
        // A `!` alias that marks `ready`, then waits at most 20 s for `go` and exits 0 only when `go` exists.
        const waiting = (ready: string, operationId: string, fields: Partial<GitCall> = {}) =>
          call({ operationId, arguments: ["--no-lazy-fetch", "-c", `alias.w=!: > "${slash(ready)}"; i=0; while [ $i -lt 400 ] && [ ! -e "${slash(go)}" ]; do sleep 0.05; i=$((i+1)); done; [ -e "${slash(go)}" ]`, "w"], ...fields });
        const operationId = id();
        const readies = [fixturePath(`ready-t393-${form}-sibling`), fixturePath(`ready-t393-${form}-other`), fixturePath(`ready-t393-${form}-canceled`)];
        const ready = async (paths: string[]) => {
          for (let i = 0; i < 400 && !paths.every((r) => existsSync(r)); i++) await Bun.sleep(25);
          expect({ form, ready: paths.map((r) => existsSync(r)) }).toEqual({ form, ready: paths.map(() => true) });
        };
        const sibling = runner.run(waiting(readies[0]!, operationId));
        const other = runner.run(waiting(readies[1]!, id()));
        await ready(readies.slice(0, 2));
        let result: Promise<{ exitCode: number | null }>;
        if (form === "abort") {
          const controller = new AbortController();
          result = runner.run(waiting(readies[2]!, operationId, { signal: controller.signal }));
          await ready(readies.slice(2));
          controller.abort();
        } else {
          result = runner.run(call({ operationId, arguments: ["--no-lazy-fetch", "-c", `alias.z=!head -c ${5 * MIB} /dev/zero >&2`, "z"] }));
        }
        expect({ form, exit: (await result).exitCode }).toEqual({ form, exit: null });
        writeFileSync(go, "");
        // Contract §5 "Total unexpected diagnostic output": the 4 MiB count belongs to the operation, so each later exit of that operation carries `diagnosticLimit`.
        const limit = form === "stderr" ? { diagnosticLimit: true as const } : {};
        expect({ [`${form} sibling`]: await sibling, [`${form} other`]: await other }).toEqual({ [`${form} sibling`]: { exitCode: null, activeDescendants: null, ...limit }, [`${form} other`]: { exitCode: 0, activeDescendants: 0 } });
        expect({ form, next: await runner.run(call({ operationId })) }).toEqual({ form, next: { exitCode: 0, activeDescendants: 0, ...limit } });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // `watch` and the activity sink of src-tauri/src/process_requests.rs close the operation Job at a deadline and at an inactivity end.
  test(
    "T394: a deadline or an inactivity end of one call ends every running call of its operation with exitCode null, a call of another operation exits 0, and the operation stays active",
    async () => {
      for (const form of ["deadline", "inactivity"] as const) {
        const go = fixturePath(`go-t394-${form}`);
        // A `!` alias that marks `ready`, then waits at most 20 s for `go` and exits 0 only when `go` exists.
        const waiting = (ready: string, operationId: string, fields: Partial<GitCall> = {}) =>
          call({ operationId, arguments: ["--no-lazy-fetch", "-c", `alias.w=!: > "${slash(ready)}"; i=0; while [ $i -lt 400 ] && [ ! -e "${slash(go)}" ]; do sleep 0.05; i=$((i+1)); done; [ -e "${slash(go)}" ]`, "w"], ...fields });
        const operationId = id();
        const readies = [fixturePath(`ready-t394-${form}-sibling`), fixturePath(`ready-t394-${form}-other`), fixturePath(`ready-t394-${form}-expired`)];
        const sibling = runner.run(waiting(readies[0]!, operationId));
        const other = runner.run(waiting(readies[1]!, id()));
        for (let i = 0; i < 400 && !readies.slice(0, 2).every((r) => existsSync(r)); i++) await Bun.sleep(25);
        expect({ form, ready: readies.slice(0, 2).map((r) => existsSync(r)) }).toEqual({ form, ready: [true, true] });
        try {
          if (form === "inactivity") runner.inject.limits = { inactivityMs: 300 };
          const fields: Partial<GitCall> = form === "deadline" ? { limits: { deadlineMs: 1500 } } : { environmentPolicy: "network", limits: PROCESS_LIMITS.network };
          expect({ form, exit: await runner.run(waiting(readies[2]!, operationId, fields)) }).toMatchObject({ form, exit: { exitCode: null, deadline: form } });
        } finally {
          runner.inject.limits = {};
        }
        writeFileSync(go, "");
        expect({ [`${form} sibling`]: await sibling, [`${form} other`]: await other }).toEqual({ [`${form} sibling`]: { exitCode: null, activeDescendants: null }, [`${form} other`]: { exitCode: 0, activeDescendants: 0 } });
        expect({ form, next: await runner.run(call({ operationId })) }).toEqual({ form, next: { exitCode: 0, activeDescendants: 0 } });
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Mirrors `close_job_of` in src-tauri/src/process_requests.rs: a Job close ends every process in the operation Job, also a descendant of a call that exited by itself.
  test(
    "T395: a deadline or an abort of one call ends a recorded descendant that an earlier call of the same operation left",
    async () => {
      for (const form of ["deadline", "abort"] as const) {
        const operationId = id();
        const ready = fixturePath(`ready-t395-${form}`);
        const hold = `"${slash(process.execPath)}" "${slash(HOST_SCRIPT)}" "${slash(runner.recordsDirectory)}" 60000 "${slash(ready)}"`;
        const wait = `i=0; while [ $i -lt 400 ] && [ ! -e "${slash(ready)}" ]; do sleep 0.05; i=$((i+1)); done`;
        const before = new Set(readdirSync(runner.recordsDirectory));
        const left = call({ operationId, environmentPolicy: "mutation", arguments: ["--no-lazy-fetch", "-c", `alias.h=!${hold} & ${wait}`, "h"] });
        expect({ form, exit: await runner.run(left) }).toEqual({ form, exit: { exitCode: 0, activeDescendants: 1 } });
        const [pid, created] = readdirSync(runner.recordsDirectory).find((name) => !before.has(name))!.split("-") as [string, string];
        const alive = () => processCreationTime(Number(pid)) === BigInt(created);
        expect({ form, alive: alive() }).toEqual({ form, alive: true });
        const started = fixturePath(`started-t395-${form}`);
        const sleeper = (fields: Partial<GitCall>) => call({ operationId, arguments: ["--no-lazy-fetch", "-c", `alias.s=!: > "${slash(started)}"; sleep 20`, "s"], ...fields });
        if (form === "deadline") {
          expect({ form, exit: await runner.run(sleeper({ limits: { deadlineMs: 1500 } })) }).toMatchObject({ form, exit: { exitCode: null, deadline: "deadline" } });
        } else {
          const controller = new AbortController();
          const result = runner.run(sleeper({ signal: controller.signal }));
          for (let i = 0; i < 400 && !existsSync(started); i++) await Bun.sleep(25);
          controller.abort();
          expect({ form, exit: (await result).exitCode }).toEqual({ form, exit: null });
        }
        for (let i = 0; i < 400 && alive(); i++) await Bun.sleep(25);
        expect({ form, alive: alive() }).toEqual({ form, alive: false });
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

// Feature 008 T019: the double of contract Δ6 `fileReplace` `working`, `tempRemove`, and `fileFacts` `detail` and `stream` on the host file system
// (plan.md D8). Each reply must fit the `ProcessReply` frame. The double records each request and stops or ends a write at a named step.
describeGit("bun runner revert requests (T019)", (git) => {
  const WINDOWS = process.platform === "win32";
  let repo: string;
  let runner: BunRunner;
  let repositoryId: string;
  let gitInstallationId: string;
  let commonDirectory: string;
  const signal = () => new AbortController().signal;
  const sha = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const temps = (dir: string) => readdirSync(dir).filter((name) => /^\.arbareto-.+\.tmp$/.test(name));

  beforeAll(async () => {
    repo = fixtureDir("revert-repo");
    fixtureGit(git, repo, ["init", "-q"]);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    fixtureGit(git, repo, ["add", "seed.txt"]);
    fixtureGit(git, repo, ["commit", "-q", "-m", "fixture"]);
    commonDirectory = join(repo, ".git");
    runner = createBunRunner({ git, directory: fixtureDir("revert-runner"), environment: serviceEnv() });
    gitInstallationId = id();
    expect(await runner.register({ operationId: id(), bootstrapId: runner.addContext("gitProbe", git), gitInstallationId, version: "2.55.0", digest: "c".repeat(64), confirm: false })).toEqual({ result: "approved" });
    repositoryId = id();
    const registration = { operationId: id(), bootstrapId: runner.addContext("repositoryDiscovery", repo), gitInstallationId, repositoryId, worktreeRoot: repo, gitDirectory: commonDirectory, commonDirectory };
    expect(await runner.register(registration)).toEqual({ result: "approved" });
  });

  afterAll(async () => {
    await runner.dispose();
  });

  // An operation with a `started` marker of kind `workbench` and `action`.
  async function marked(action: "revert-lines" | "revert-files" | "revert-unstaged" | "delete-files" = "revert-files"): Promise<string> {
    const operationId = id();
    expect(await runner.started({ operationId, repositoryId, kind: "workbench", action, worktreeRoot: repo, commonDirectory })).toMatchObject({ markerId: expect.any(String) });
    return operationId;
  }

  const factsOf = async (operationId: string, names: string[], extra: { stream?: boolean; detail?: boolean } = { detail: true }) =>
    (await runner.fileFacts({ operationId, contextKind: "registeredOperation", gitInstallationId, repositoryId, digest: true, files: [{ root: "worktreeRoot", path: names }], ...extra }, signal())) as FileFact[];

  // Data-model §3 `working`: the bound facts of a `detail` and `stream` fact.
  async function bound(operationId: string, names: string[]): Promise<Exclude<WorkingReplaceRequest["facts"], "absent">> {
    const [f] = await factsOf(operationId, names, { detail: true, stream: true });
    if (f?.kind !== "file" || f.digest === undefined) throw new Error(`no file fact: ${JSON.stringify(f)}`);
    return WINDOWS
      ? { size: f.size, sha256: f.digest, attributes: f.attributes!, links: f.links!, owner: f.owner!, group: f.group!, dacl: f.dacl!, creationTime: f.creationTime! }
      : { size: f.size, sha256: f.digest, mode: f.mode!, uid: f.uid!, gid: f.gid!, links: f.links!, xattr: false };
  }

  type Fields = Partial<Omit<WorkingReplaceRequest, "operationId" | "repositoryId" | "target" | "path">>;
  async function replace(operationId: string, names: string[], fields: Fields) {
    const reply = await runner.fileReplaceWorking({ operationId, repositoryId, target: "working", path: join(repo, ...names), expected: "absent", facts: "absent", ...fields } as WorkingReplaceRequest, signal());
    // Every reply fits the contract Δ6 frame.
    if (!("stop" in reply)) expect(ProcessReply.safeParse({ type: "fileReplace", callId: id(), ...reply }).success).toBe(true);
    return reply;
  }
  const present = (bytes: string) => ({ size: Buffer.byteLength(bytes), sha256: sha(bytes) });
  const base64 = (bytes: string) => Buffer.from(bytes).toString("base64");

  test("fileFacts detail gives the data-model §3 fields, and stream digests a file above the 1 MiB bound", async () => {
    const operationId = await marked();
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) & 0xff);
    writeFileSync(join(repo, "big.bin"), big);
    const [streamed] = await factsOf(operationId, ["big.bin"], { detail: true, stream: true });
    expect(FileFactSchema.safeParse(streamed).success).toBe(true);
    expect(streamed).toMatchObject({ kind: "file", size: big.length, digest: sha(big), links: 1 });
    if (WINDOWS) expect(streamed).toMatchObject({ attributes: expect.any(Number), owner: expect.stringMatching(/^\S+$/), group: expect.stringMatching(/^\S+$/), dacl: expect.stringMatching(/^D:/), creationTime: expect.stringMatching(/^\d+$/) });
    else expect(streamed).toMatchObject({ mode: expect.any(Number), uid: expect.any(Number), gid: expect.any(Number), xattr: false });
    // Without `stream`, the 001 per-file bound still applies, and without `detail` no detail field comes.
    const [plain] = await factsOf(operationId, ["big.bin"], {});
    expect(big.length).toBeGreaterThan(TRUST_DIGEST_FILE_BYTES);
    expect(plain).toMatchObject({ kind: "file", bound: "file-bytes" });
    expect(Object.keys(plain!).filter((key) => ["links", "attributes", "owner", "group", "dacl", "creationTime", "mode", "uid", "gid", "xattr"].includes(key))).toEqual([]);
    linkSync(join(repo, "big.bin"), join(repo, "big-link.bin"));
    const [linked] = await factsOf(operationId, ["big.bin"]);
    expect(linked).toMatchObject({ kind: "file", links: 2 });
    rmSync(join(repo, "big-link.bin"));
    rmSync(join(repo, "big.bin"));
  });

  test("a working replace needs a revert marker, a path below the worktree root, and no .git first name; each refusal changes nothing", async () => {
    writeFileSync(join(repo, "a.txt"), "old\n");
    const fields: Fields = { expected: present("old\n"), bytes: base64("new\n") };
    fields.facts = await bound(await marked(), ["a.txt"]);
    await expect(replace(id(), ["a.txt"], fields)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(replace(await marked("delete-files"), ["a.txt"], fields)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const operationId = await marked("revert-unstaged");
    await expect(replace(operationId, [".GIT", "config"], fields)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(replace(operationId, ["..", "outside.txt"], fields)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // Contract Δ6: exactly one of `bytes` and `source`, and `folders` only with `expected: absent`.
    await expect(replace(operationId, ["a.txt"], { ...fields, source: { name: ".merge_file_x", size: 4, sha256: sha("new\n") } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(replace(operationId, ["a.txt"], { ...fields, folders: ["x"] })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("old\n");
    expect(temps(repo)).toEqual([]);
  });

  test("bytes: the exact expected and facts check passes, one rename replaces the file, the request is recorded, and no temporary file stays", async () => {
    const operationId = await marked("revert-lines");
    writeFileSync(join(repo, "a.txt"), "old\n");
    const facts = await bound(operationId, ["a.txt"]);
    const from = runner.frames.length;
    expect(await replace(operationId, ["a.txt"], { expected: present("old\n"), facts, bytes: base64("new\n") })).toEqual({ result: "replaced" });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("new\n");
    expect(temps(repo)).toEqual([]);
    expect(runner.frames.slice(from).map((f) => [f.type, f.target, f.path])).toEqual([["fileReplace", "working", join(repo, "a.txt")]]);
  });

  test("a changed size, digest, or bound fact gives stale, and the old bytes stay", async () => {
    const operationId = await marked();
    writeFileSync(join(repo, "a.txt"), "old\n");
    const facts = await bound(operationId, ["a.txt"]);
    const changed = WINDOWS ? { ...facts, creationTime: "1" } : { ...facts, mode: (facts as { mode: number }).mode ^ 0o1 };
    // The frame rule ties `expected` to the size and SHA-256 of `facts` (contract Δ6), so a review of other bytes binds both.
    expect(await replace(operationId, ["a.txt"], { expected: present("other\n"), facts: { ...facts, ...present("other\n") }, bytes: base64("new\n") })).toEqual({ result: "stale" });
    expect(await replace(operationId, ["a.txt"], { expected: present("old\n"), facts: changed as WorkingReplaceRequest["facts"], bytes: base64("new\n") })).toEqual({ result: "stale" });
    expect(await replace(operationId, ["a.txt"], { expected: "absent", facts: "absent", bytes: base64("new\n") })).toEqual({ result: "stale" });
    expect(await replace(operationId, ["gone.txt"], { expected: present("old\n"), facts, bytes: base64("new\n") })).toEqual({ result: "stale" });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("old\n");
    expect(temps(repo)).toEqual([]);
  });

  test("a second hard link, the read-only attribute, and a link at the target refuse with their reasons and change nothing", async () => {
    const operationId = await marked();
    writeFileSync(join(repo, "h.txt"), "old\n");
    const facts = await bound(operationId, ["h.txt"]);
    linkSync(join(repo, "h.txt"), join(repo, "h2.txt"));
    expect(await replace(operationId, ["h.txt"], { expected: present("old\n"), facts: { ...facts, links: 2 }, bytes: base64("new\n") })).toEqual({ result: "refused", reason: "hard-link" });
    rmSync(join(repo, "h2.txt"));
    if (WINDOWS) {
      // Node sets FILE_ATTRIBUTE_READONLY on Windows when the write bits go.
      chmodSync(join(repo, "h.txt"), 0o444);
      const readOnly = await bound(operationId, ["h.txt"]);
      expect(await replace(operationId, ["h.txt"], { expected: present("old\n"), facts: readOnly, bytes: base64("new\n") })).toEqual({ result: "refused", reason: "read-only" });
      chmodSync(join(repo, "h.txt"), 0o666);
    }
    let linked = true;
    try {
      symlinkSync(join(repo, "h.txt"), join(repo, "l.txt"));
    } catch {
      linked = false;
    }
    if (linked) expect(await replace(operationId, ["l.txt"], { expected: present("old\n"), facts, bytes: base64("new\n") })).toEqual({ result: "refused", reason: "not-regular" });
    expect(readFileSync(join(repo, "h.txt"), "utf8")).toBe("old\n");
    expect(temps(repo)).toEqual([]);
  });

  test("an absent target with folders creates each missing folder and names them; a later name or folder gives stale", async () => {
    const operationId = await marked();
    expect(await replace(operationId, ["new", "deep", "a.txt"], { folders: ["new", "deep"], bytes: base64("made\n") })).toEqual({ result: "replaced", folders: ["new", "deep"] });
    expect(readFileSync(join(repo, "new", "deep", "a.txt"), "utf8")).toBe("made\n");
    // The folders exist now, and so does the name.
    expect(await replace(operationId, ["new", "deep", "b.txt"], { folders: ["new", "deep"], bytes: base64("x\n") })).toEqual({ result: "stale" });
    expect(await replace(operationId, ["new", "deep", "a.txt"], { bytes: base64("again\n") })).toEqual({ result: "stale" });
    expect(readFileSync(join(repo, "new", "deep", "a.txt"), "utf8")).toBe("made\n");
    expect(existsSync(join(repo, "new", "deep", "b.txt"))).toBe(false);
    rmSync(join(repo, "new"), { recursive: true });
  });

  test("source: Git's temporary file copies beside the target with a streamed digest and goes after the rename; a digest that differs gives stale and the source goes", async () => {
    const operationId = await marked();
    writeFileSync(join(repo, "a.txt"), "old\n");
    const facts = await bound(operationId, ["a.txt"]);
    const restored = "restored line\r\n";
    writeFileSync(join(repo, ".merge_file_t19a"), restored);
    expect(await replace(operationId, ["a.txt"], { expected: present("old\n"), facts, source: { name: ".merge_file_t19a", ...present(restored) } })).toEqual({ result: "replaced" });
    expect({ target: readFileSync(join(repo, "a.txt"), "utf8"), source: existsSync(join(repo, ".merge_file_t19a")) }).toEqual({ target: restored, source: false });
    const again = await bound(operationId, ["a.txt"]);
    writeFileSync(join(repo, ".merge_file_t19b"), "other\n");
    expect(await replace(operationId, ["a.txt"], { expected: present(restored), facts: again, source: { name: ".merge_file_t19b", size: 6, sha256: sha("expected\n") } })).toEqual({ result: "stale" });
    expect({ target: readFileSync(join(repo, "a.txt"), "utf8"), source: existsSync(join(repo, ".merge_file_t19b")) }).toEqual({ target: restored, source: false });
    // A missing source fails before the open.
    expect(await replace(operationId, ["a.txt"], { expected: present(restored), facts: again, source: { name: ".merge_file_t19c", size: 1, sha256: sha("x") } })).toEqual({ result: "stale" });
    expect(temps(repo)).toEqual([]);
  });

  test("the write seam: a stop at the check changes nothing; an end after the write leaves no temporary file; an end after the clear leaves its name; an end after the rename keeps the new bytes", async () => {
    const operationId = await marked();
    const at = async (step: string, how: "stop" | "crash") => {
      writeFileSync(join(repo, "s.txt"), "old\n");
      const facts = await bound(operationId, ["s.txt"]);
      runner.inject.replaceStep = (seen) => (seen === step ? how : undefined);
      try {
        return await replace(operationId, ["s.txt"], { expected: present("old\n"), facts, bytes: base64("new\n") }).catch((error: unknown) => ({ thrown: (error as Error).message.length > 0 }));
      } finally {
        runner.inject.replaceStep = null;
      }
    };
    expect(await at("checked", "stop")).toEqual({ result: "stopped" });
    expect({ bytes: readFileSync(join(repo, "s.txt"), "utf8"), temps: temps(repo) }).toEqual({ bytes: "old\n", temps: [] });
    // A stop after the write starts is no stop: the started write runs to its end.
    expect(await at("written", "stop")).toEqual({ result: "replaced" });
    expect(await at("written", "crash")).toEqual({ thrown: true });
    expect({ bytes: readFileSync(join(repo, "s.txt"), "utf8"), temps: temps(repo) }).toEqual({ bytes: "old\n", temps: [] });
    expect(await at("cleared", "crash")).toEqual({ thrown: true });
    expect({ bytes: readFileSync(join(repo, "s.txt"), "utf8"), temps: temps(repo).length }).toEqual({ bytes: "old\n", temps: 1 });
    for (const name of temps(repo)) rmSync(join(repo, name));
    expect(await at("renamed", "crash")).toEqual({ thrown: true });
    expect({ bytes: readFileSync(join(repo, "s.txt"), "utf8"), temps: temps(repo) }).toEqual({ bytes: "new\n", temps: [] });
  });

  // Contract Δ3 "checkout-index deadline": the size rule replaces REGISTERED_DEADLINE_CAP_MS only for `checkout-index --temp`.
  test("only the checkout-index --temp array takes a deadline above the registered cap", async () => {
    const call = (args: string[]) => ({
      operationId: id(),
      context: { contextKind: "registeredOperation" as const, gitInstallationId, repositoryId },
      arguments: args,
      input: new TextEncoder().encode("absent.txt\0"),
      environmentPolicy: "read" as const,
      limits: { deadlineMs: REGISTERED_DEADLINE_CAP_MS + 1 },
      stdout: createCollector({ maxBytes: 64 * 1024 }),
      stderr: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
      signal: signal(),
    });
    // The path is not in the index, so Git writes no temporary file and exits with a failure status.
    expect(await runner.run(call(["--no-lazy-fetch", "checkout-index", "--temp", "--stdin", "-z"]))).toMatchObject({ exitCode: expect.any(Number) });
    await expect(runner.run(call(["--no-lazy-fetch", "checkout-index", "--stdin", "-z"]))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(readdirSync(repo).filter((name) => name.startsWith(".merge_file_"))).toEqual([]);
  });

  test("tempRemove removes a matching file in the worktree root, keeps one with other facts, gives absent, and needs a revert marker", async () => {
    const operationId = await marked("revert-unstaged");
    const remove = async (who: string, name: string, bytes: string) => {
      const reply = await runner.tempRemove({ operationId: who, repositoryId, name, expected: present(bytes) }, signal());
      if (!("stop" in reply)) expect(ProcessReply.safeParse({ type: "tempRemove", callId: id(), ...reply }).success).toBe(true);
      return reply;
    };
    writeFileSync(join(repo, ".merge_file_r1"), "temp\n");
    await expect(remove(id(), ".merge_file_r1", "temp\n")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(remove(operationId, "sub/.merge_file_r1", "temp\n")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await remove(operationId, ".merge_file_r1", "other\n")).toEqual({ result: "stale" });
    expect(existsSync(join(repo, ".merge_file_r1"))).toBe(true);
    expect(await remove(operationId, ".merge_file_r1", "temp\n")).toEqual({ result: "removed" });
    expect(existsSync(join(repo, ".merge_file_r1"))).toBe(false);
    expect(await remove(operationId, ".merge_file_r1", "temp\n")).toEqual({ result: "absent" });
    expect(runner.frames.filter((f) => f.type === "tempRemove").length).toBe(4);
  });
});
