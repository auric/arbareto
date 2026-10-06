// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { ProcessRequest, type FileFact } from "../../src/contracts/channel";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  INLINE_PROCESS_INPUT_BYTES,
  NATIVE_CHUNK_BYTES,
  UNACKNOWLEDGED_INPUT_CHUNKS,
  UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION,
  WINDOWS_COMMAND_LINE_UNITS,
} from "../../src/contracts/limits";
import { isWindows } from "../../src/contracts/native-path";
import { createCollector, createDiagnosticCounter, PROCESS_LIMITS, type GitCall, type IdentityReply, type ProcessContext, type TrustRecord, type TrustRequest } from "../../src/git-service/git-runner";
import { createNativeRunner } from "../../src/git-service/native-runner";

printOrigin("../../src/contracts/channel.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/contracts/native-path.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);
printOrigin("../../src/git-service/native-runner.ts", import.meta.dir);

type Body = Record<string, unknown>;
type Sent = Record<string, unknown> & { kind: string };

const MIB = 1024 * 1024;
const id = () => crypto.randomUUID();
// A signal that no test aborts.
const SIGNAL = new AbortController().signal;
const REPO = isWindows ? "C:\\repo" : "/repo";
const GIT_DIR = isWindows ? "C:\\repo\\.git" : "/repo/.git";
const GIT_PATH = isWindows ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const IDENTITY = { volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" };
const RECORD: TrustRecord = {
  commonDirectory: GIT_DIR,
  commonIdentity: IDENTITY,
  worktreeRoot: REPO,
  gitDirectory: GIT_DIR,
  worktreeIdentity: [IDENTITY, IDENTITY],
  configurationFingerprint: "a".repeat(64),
  approvedAt: "2026-10-02T08:00:00Z",
  gitSelectedPath: GIT_PATH,
};

// The shell end of the private channel. It sends contract §6 replies and never invents Git output beyond the bytes a test sets.
function createChannelDouble() {
  const sent: Sent[] = [];
  const runner = createNativeRunner({ write: (frame) => void sent.push(structuredClone(frame) as Sent), flush: async () => {} });
  const bodies = (type?: string) => sent.map((f) => f[f.kind] as Body).filter((b) => type === undefined || b.type === type);
  return {
    runner,
    sent,
    bodies,
    last: (type: string) => bodies(type).at(-1) as Body,
    reply: (kind: string, body: Body) => runner.receive({ kind: kind as "process", [kind]: body }),
  };
}

const registered = (): ProcessContext => ({ contextKind: "registeredOperation", gitInstallationId: id(), repositoryId: id() });

function call(fields: Partial<GitCall> = {}): GitCall {
  return {
    operationId: id(),
    context: registered(),
    arguments: ["--no-lazy-fetch", "status", "--porcelain=v2"],
    environmentPolicy: "read",
    limits: PROCESS_LIMITS.git,
    stdout: createCollector({ maxBytes: 4 * MIB }),
    stderr: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
    signal: new AbortController().signal,
    ...fields,
  };
}

const chunk = (bytes: number, fill = 0x61) => new Uint8Array(bytes).fill(fill).toBase64();
const exit = (callId: unknown, fields: Body = {}) => ({ type: "exit", callId, exitCode: 0, activeDescendants: 0, ...fields });
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await Bun.sleep(0);
  return done;
};

describe("native runner run requests", () => {
  test("an argument array without --no-lazy-fetch is refused and sends nothing", async () => {
    const channel = createChannelDouble();
    const discovery: ProcessContext = { contextKind: "repositoryDiscovery", bootstrapId: id(), gitInstallationId: id() };
    const probe: ProcessContext = { contextKind: "gitProbe", bootstrapId: id() };
    const refused = [
      call({ arguments: ["status"] }),
      call({ arguments: ["rev-parse", "--no-lazy-fetch"] }),
      call({ context: discovery, environmentPolicy: "probe", arguments: ["rev-parse", "--show-toplevel"] }),
      call({ context: probe, environmentPolicy: "probe", arguments: ["version"] }),
      call({ context: probe, environmentPolicy: "probe", arguments: ["--no-lazy-fetch", "version", "--build-options"] }),
      call({ context: probe, environmentPolicy: "probe", arguments: ["version", "--build-options", "-v"] }),
      call({ context: registered(), environmentPolicy: "read", arguments: ["version", "--build-options"] }),
    ];
    for (const c of refused) await expect(channel.runner.run(c)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(channel.sent).toEqual([]);
    void channel.runner.run(call({ context: probe, environmentPolicy: "probe", arguments: ["version", "--build-options"] }));
    expect(channel.last("run").arguments).toEqual(["version", "--build-options"]);
  });

  test("the call resolves at the exit reply, never at the end of output", async () => {
    const channel = createChannelDouble();
    const c = call();
    const result = channel.runner.run(c);
    const { callId } = channel.last("run");
    expect(channel.reply("process", { type: "output", callId, stream: "stdout", data: chunk(10) })).toBe(true);
    expect(channel.reply("process", { type: "output", callId, stream: "stderr", data: chunk(3) })).toBe(true);
    expect(await settled(result)).toBe(false);
    expect(channel.reply("process", exit(callId, { exitCode: 4_294_967_295, activeDescendants: 2 }))).toBe(true);
    expect(await result).toEqual({ exitCode: 4_294_967_295, activeDescendants: 2 });
    expect(c.stdout.bytes).toBe(10);
    expect(channel.reply("process", { type: "output", callId, stream: "stdout", data: chunk(1) })).toBe(true);
    expect(c.stdout.bytes).toBe(10);
  });

  test("the run frame carries the context IDs, the policy, and the limits", async () => {
    const channel = createChannelDouble();
    const operationId = id();
    const discovery = { contextKind: "repositoryDiscovery", bootstrapId: id(), gitInstallationId: id() } as const;
    void channel.runner.run(call({ operationId, context: discovery, environmentPolicy: "probe", arguments: ["--no-lazy-fetch", "rev-parse"] }));
    const run = channel.last("run");
    expect(Object.keys(run).sort()).toEqual(
      ["type", "callId", "operationId", "contextKind", "bootstrapId", "gitInstallationId", "arguments", "environmentPolicy", "limits"].sort(),
    );
    expect(run).toMatchObject({ ...discovery, operationId, environmentPolicy: "probe", limits: { deadlineMs: 30_000 } });
    expect(channel.sent[0].kind).toBe("process");
  });

  test("deadline caps follow the context, and stallMs exists only for a registered operation", async () => {
    const channel = createChannelDouble();
    const probe: ProcessContext = { contextKind: "gitProbe", bootstrapId: id() };
    const version = ["version", "--build-options"];
    const refused = [
      call({ context: probe, environmentPolicy: "probe", arguments: version, limits: { deadlineMs: 30_001 } }),
      call({ context: probe, environmentPolicy: "probe", arguments: version, limits: { deadlineMs: 120_000 } }),
      call({ context: probe, environmentPolicy: "probe", arguments: version, limits: { deadlineMs: 1000, stallMs: 15_000 } }),
      call({ limits: { deadlineMs: 120_001 } }),
      call({ limits: { deadlineMs: 0 } }),
      call({ limits: { deadlineMs: 1000, stallMs: 14_999 } }),
      call({ limits: { inactivityMs: 1000, ceilingMs: 1000, stallMs: 15_000 } }),
      call({ environmentPolicy: "network", limits: { deadlineMs: 1000 } }),
      call({ environmentPolicy: "network", limits: { inactivityMs: 300_001, ceilingMs: 1000, stallMs: 15_000 } }),
      call({ environmentPolicy: "probe" }),
      call({ context: probe, environmentPolicy: "read", arguments: version }),
    ];
    for (const c of refused) await expect(channel.runner.run(c)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(channel.sent).toEqual([]);
    void channel.runner.run(call({ limits: { deadlineMs: 120_000, stallMs: 15_000 } }));
    void channel.runner.run(call({ context: probe, environmentPolicy: "probe", arguments: version, limits: { deadlineMs: 30_000 } }));
    // `git-environment.json` has no `network` policy until T228, so the call sends no `run` frame.
    void channel.runner.run(call({ environmentPolicy: "network", limits: PROCESS_LIMITS.network })).catch(() => {});
    expect(channel.bodies("run").length).toBe(2);
  });

  test("strings with a NUL or a lone surrogate and over-long command lines are refused", async () => {
    const channel = createChannelDouble();
    const refused = [
      call({ arguments: ["--no-lazy-fetch", "log", "a\0b"] }),
      call({ arguments: ["--no-lazy-fetch", "log", "a\ud800"] }),
      call({ arguments: ["--no-lazy-fetch", "log", "\udc00b"] }),
      call({ arguments: ["--no-lazy-fetch", "x".repeat(WINDOWS_COMMAND_LINE_UNITS)] }),
    ];
    for (const c of refused) await expect(channel.runner.run(c)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(channel.runner.identities(id(), registered(), ["C:\\repo\\\ud800"], SIGNAL)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(channel.runner.lingeringCount(id(), "relative\\path")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(channel.sent).toEqual([]);
    void channel.runner.run(call({ arguments: ["--no-lazy-fetch", "log", "\ud83d\ude00"] }));
    expect(channel.bodies("run").length).toBe(1);
  });

  test("a refused reply gives its code to the caller", async () => {
    for (const code of ["INVALID_REQUEST", "UNKNOWN_TARGET", "GIT_CHANGED", "PROCESS_OWNERSHIP_FAILED"]) {
      const channel = createChannelDouble();
      const result = channel.runner.run(call());
      const { callId } = channel.last("run");
      expect(channel.reply("process", { type: "refused", callId, code })).toBe(true);
      await expect(result).rejects.toMatchObject({ code });
      expect(channel.bodies("cancel")).toEqual([]);
    }
    const channel = createChannelDouble();
    const result = channel.runner.identities(id(), registered(), [REPO], SIGNAL);
    expect(channel.reply("process", { type: "refused", callId: channel.last("identity").callId, code: "UNKNOWN_TARGET" })).toBe(true);
    await expect(result).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
  });

  test("a malformed output reply sends cancel, ignores later output, and fails at the exit", async () => {
    for (const bad of [
      { stream: "stdin", data: chunk(1) },
      { stream: "stdout", data: "not base64!" },
      { stream: "stdout", data: "QUI" },
      { stream: "stdout", data: "QQ" },
      { stream: "stdout", data: "Q U J D" },
      { stream: "stdout", data: "QUJ\nD" },
      { stream: "stdout", data: "QUJD\r\n" },
      { stream: "stdout", data: "QUJD\t" },
      { stream: "stdout", data: chunk(NATIVE_CHUNK_BYTES + 1) },
      { stream: "stdout", data: "" },
      { stream: "stdout", data: chunk(1), extra: 1 },
    ]) {
      const channel = createChannelDouble();
      const c = call();
      const result = channel.runner.run(c);
      const { callId } = channel.last("run");
      expect(channel.reply("process", { type: "output", callId, ...bad })).toBe(false);
      expect(channel.bodies("cancel")).toEqual([{ type: "cancel", callId }]);
      channel.reply("process", { type: "output", callId, stream: "stdout", data: chunk(5) });
      expect(c.stdout.bytes).toBe(0);
      expect(await settled(result)).toBe(false);
      channel.reply("process", exit(callId, { exitCode: null }));
      await expect(result).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
      expect(channel.bodies("cancel").length).toBe(1);
    }
  });

  test("a malformed activity reply sends cancel, and a call without stallMs gets no activity", async () => {
    const channel = createChannelDouble();
    const states: string[] = [];
    const stalled = channel.runner.run(call({ limits: PROCESS_LIMITS.commit, onActivity: (s) => void states.push(s) }));
    const first = channel.last("run").callId;
    expect(channel.reply("process", { type: "activity", callId: first, state: "stalled" })).toBe(true);
    expect(channel.reply("process", { type: "activity", callId: first, state: "active" })).toBe(true);
    expect(states).toEqual(["stalled", "active"]);
    expect(channel.reply("process", { type: "activity", callId: first, state: "idle" })).toBe(false);
    channel.reply("process", exit(first, { exitCode: null }));
    await expect(stalled).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });

    const plain = channel.runner.run(call());
    const second = channel.last("run").callId;
    expect(channel.reply("process", { type: "activity", callId: second, state: "stalled" })).toBe(false);
    expect(channel.last("cancel")).toEqual({ type: "cancel", callId: second });
    channel.reply("process", exit(second));
    await expect(plain).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
  });

  test("a malformed exit fails the call at once", async () => {
    for (const fields of [{ exitCode: -1 }, { exitCode: 4_294_967_296 }, { exitCode: 1.5 }, { activeDescendants: -1 }, { deadline: "late" }, { extra: true }]) {
      const channel = createChannelDouble();
      const result = channel.runner.run(call());
      const { callId } = channel.last("run");
      expect(channel.reply("process", exit(callId, fields))).toBe(false);
      await expect(result).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
      expect(channel.reply("process", exit(callId))).toBe(true);
    }
    const channel = createChannelDouble();
    const result = channel.runner.run(call());
    channel.reply("process", exit(channel.last("run").callId, { exitCode: null, deadline: "deadline" }));
    expect(await result).toEqual({ exitCode: null, activeDescendants: 0, deadline: "deadline" });
  });

  test("a collector retains 64 KiB per stream and counts every forwarded byte", async () => {
    const channel = createChannelDouble();
    const c = call();
    const result = channel.runner.run(c);
    const { callId } = channel.last("run");
    for (let i = 0; i < 3; i++) channel.reply("process", { type: "output", callId, stream: "stderr", data: chunk(NATIVE_CHUNK_BYTES, 0x30 + i) });
    channel.reply("process", exit(callId, { exitCode: 1 }));
    await result;
    expect(c.stderr.bytes).toBe(3 * NATIVE_CHUNK_BYTES);
    expect(c.stderr.limited).toBe(true);
    const kept = (c.stderr as ReturnType<typeof createCollector>).take();
    expect(kept.length).toBe(DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
    expect(kept.every((b) => b === 0x30)).toBe(true);
    expect(channel.bodies("cancel")).toEqual([]);
  });

  test("a stdout stream above its result bound gets cancel", async () => {
    const channel = createChannelDouble();
    const c = call({ stdout: createCollector({ maxBytes: 10 }) });
    const result = channel.runner.run(c);
    const { callId } = channel.last("run");
    channel.reply("process", { type: "output", callId, stream: "stdout", data: chunk(10) });
    expect(channel.bodies("cancel")).toEqual([]);
    channel.reply("process", { type: "output", callId, stream: "stdout", data: chunk(1) });
    expect(channel.bodies("cancel")).toEqual([{ type: "cancel", callId }]);
    channel.reply("process", exit(callId, { exitCode: null }));
    expect(await result).toEqual({ exitCode: null, activeDescendants: 0 });
    expect(c.stdout.limited).toBe(true);
  });
});

describe("native runner stderr bound", () => {
  const stderr = (channel: ReturnType<typeof createChannelDouble>, callId: unknown, bytes: number) => {
    for (let left = bytes; left > 0; left -= NATIVE_CHUNK_BYTES) {
      channel.reply("process", { type: "output", callId, stream: "stderr", data: chunk(Math.min(left, NATIVE_CHUNK_BYTES)) });
    }
  };

  test("4 MiB of stderr in one operation sends cancel", async () => {
    const channel = createChannelDouble();
    const result = channel.runner.run(call());
    const { callId } = channel.last("run");
    stderr(channel, callId, UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION - 1);
    expect(channel.bodies("cancel")).toEqual([]);
    stderr(channel, callId, 1);
    expect(channel.bodies("cancel")).toEqual([{ type: "cancel", callId }]);
    stderr(channel, callId, NATIVE_CHUNK_BYTES);
    expect(channel.bodies("cancel").length).toBe(1);
    channel.reply("process", exit(callId, { exitCode: null }));
    expect(await result).toEqual({ exitCode: null, activeDescendants: 0, diagnosticLimit: true });
  });

  test("two processes of one operation share the 4 MiB", async () => {
    const channel = createChannelDouble();
    const operationId = id();
    const first = channel.runner.run(call({ operationId }));
    const firstId = channel.last("run").callId;
    stderr(channel, firstId, 3 * MIB);
    channel.reply("process", exit(firstId, { exitCode: 1 }));
    expect(await first).toEqual({ exitCode: 1, activeDescendants: 0 });
    const second = channel.runner.run(call({ operationId }));
    const secondId = channel.last("run").callId;
    stderr(channel, secondId, MIB - 1);
    expect(channel.bodies("cancel")).toEqual([]);
    stderr(channel, secondId, 1);
    expect(channel.bodies("cancel")).toEqual([{ type: "cancel", callId: secondId }]);
    channel.reply("process", exit(secondId, { exitCode: null }));
    expect(await second).toMatchObject({ diagnosticLimit: true });

    const other = channel.runner.run(call());
    const otherId = channel.last("run").callId;
    stderr(channel, otherId, 3 * MIB);
    expect(channel.bodies("cancel").length).toBe(1);
    channel.reply("process", exit(otherId));
    await other;
  });

  test("closeJob ends the count of an operation", async () => {
    const channel = createChannelDouble();
    const operationId = id();
    const first = channel.runner.run(call({ operationId }));
    const firstId = channel.last("run").callId;
    stderr(channel, firstId, 3 * MIB);
    channel.reply("process", exit(firstId));
    await first;
    channel.runner.closeJob(operationId);
    expect(channel.last("closeJob")).toEqual({ type: "closeJob", operationId });
    const again = channel.runner.run(call({ operationId }));
    const againId = channel.last("run").callId;
    stderr(channel, againId, 3 * MIB);
    expect(channel.bodies("cancel")).toEqual([]);
    channel.reply("process", exit(againId));
    await again;
  });

  // The runner refuses a `network` call until T228, so the counter rule is checked directly.
  test("the diagnostic counter gives a network call its own 4 MiB", () => {
    const counter = createDiagnosticCounter();
    const operationId = id();
    const read = { operationId, environmentPolicy: "read", stderr: { bytes: 0 } } as unknown as GitCall;
    const networkStderr = { bytes: 0 };
    const network = { operationId, environmentPolicy: "network", stderr: networkStderr } as unknown as GitCall;
    expect(counter.add(read, 3 * MIB)).toBe(false);
    networkStderr.bytes = UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION - 1;
    expect(counter.add(network, UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION - 1)).toBe(false);
    expect(counter.add(read, 1)).toBe(false);
    networkStderr.bytes = UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION;
    expect(counter.add(network, 1)).toBe(true);
    expect(counter.add(read, MIB - 1)).toBe(true);
  });
});

describe("native runner input", () => {
  test("input up to 64 KiB travels inline", async () => {
    const channel = createChannelDouble();
    const input = new Uint8Array(INLINE_PROCESS_INPUT_BYTES).fill(7);
    void channel.runner.run(call({ input }));
    const run = channel.last("run");
    expect(Uint8Array.fromBase64(run.input as string)).toEqual(input);
    expect(Object.hasOwn(run, "inputBytes")).toBe(false);
    expect(channel.bodies("input")).toEqual([]);
  });

  test("larger input streams with at most 8 unacknowledged chunks", async () => {
    const channel = createChannelDouble();
    const input = new Uint8Array(20 * NATIVE_CHUNK_BYTES + 5);
    for (let i = 0; i < input.length; i++) input[i] = i % 251;
    const result = channel.runner.run(call({ input }));
    const run = channel.last("run");
    const callId = run.callId;
    expect(run.inputBytes).toBe(input.length);
    expect(Object.hasOwn(run, "input")).toBe(false);
    expect(channel.bodies()[0].type).toBe("run");
    expect(channel.bodies("input").length).toBe(UNACKNOWLEDGED_INPUT_CHUNKS);
    expect(channel.reply("process", { type: "inputWritten", callId })).toBe(true);
    expect(channel.bodies("input").length).toBe(UNACKNOWLEDGED_INPUT_CHUNKS + 1);
    for (let i = 0; i < 20; i++) expect(channel.reply("process", { type: "inputWritten", callId })).toBe(true);
    const chunks = channel.bodies("input");
    expect(chunks.length).toBe(21);
    expect(chunks.every((b) => b.callId === callId && Object.keys(b).length === 3)).toBe(true);
    const joined = new Uint8Array(chunks.reduce((n, b) => n + Uint8Array.fromBase64(b.data as string).length, 0));
    let at = 0;
    for (const b of chunks) {
      const bytes = Uint8Array.fromBase64(b.data as string);
      expect(bytes.length).toBeLessThanOrEqual(NATIVE_CHUNK_BYTES);
      joined.set(bytes, at);
      at += bytes.length;
    }
    expect(joined).toEqual(input);
    expect(channel.bodies("cancel")).toEqual([]);
    channel.reply("process", exit(callId));
    expect(await result).toEqual({ exitCode: 0, activeDescendants: 0 });
  });

  test("an inputWritten reply without an unacknowledged chunk is malformed", async () => {
    const channel = createChannelDouble();
    const result = channel.runner.run(call({ input: new Uint8Array(3) }));
    const { callId } = channel.last("run");
    expect(channel.reply("process", { type: "inputWritten", callId })).toBe(false);
    expect(channel.last("cancel")).toEqual({ type: "cancel", callId });
    channel.reply("process", exit(callId));
    await expect(result).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
  });

  test("the exit stops streamed input", async () => {
    const channel = createChannelDouble();
    const result = channel.runner.run(call({ input: new Uint8Array(20 * NATIVE_CHUNK_BYTES) }));
    const { callId } = channel.last("run");
    channel.reply("process", exit(callId, { exitCode: 128 }));
    expect(await result).toEqual({ exitCode: 128, activeDescendants: 0 });
    channel.reply("process", { type: "inputWritten", callId });
    expect(channel.bodies("input").length).toBe(UNACKNOWLEDGED_INPUT_CHUNKS);
  });

  test("a transaction carries its candidate index file only with the mutation policy", async () => {
    const channel = createChannelDouble();
    const transaction = { transactionId: id(), indexFile: isWindows ? "C:\\repo\\.git\\arbareto-candidate-1" : "/repo/.git/arbareto-candidate-1" };
    await expect(channel.runner.run(call({ transaction }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const badName = { ...transaction, indexFile: isWindows ? "C:\\repo\\.git\\index" : "/repo/.git/index" };
    await expect(channel.runner.run(call({ environmentPolicy: "mutation", transaction: badName }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    void channel.runner.run(call({ environmentPolicy: "mutation", transaction }));
    expect(channel.last("run")).toMatchObject({ environmentPolicy: "mutation", ...transaction });
  });

  test("cancel through the abort signal sends one cancel frame", async () => {
    const channel = createChannelDouble();
    const controller = new AbortController();
    const result = channel.runner.run(call({ signal: controller.signal }));
    const { callId } = channel.last("run");
    controller.abort();
    controller.abort();
    expect(channel.bodies("cancel")).toEqual([{ type: "cancel", callId }]);
    channel.reply("process", exit(callId, { exitCode: null }));
    expect(await result).toEqual({ exitCode: null, activeDescendants: 0 });
  });
});

describe("native runner identity, lingering count, and registration", () => {
  test("discovery identity requests carry gitInstallationId, and error entries hold only UNSUPPORTED_REPOSITORY with an optional absent reason", async () => {
    const channel = createChannelDouble();
    const context = { contextKind: "repositoryDiscovery", bootstrapId: id(), gitInstallationId: id() } as const;
    const operationId = id();
    const result = channel.runner.identities(operationId, context, [REPO, GIT_DIR, REPO], SIGNAL);
    const request = channel.last("identity");
    expect(request).toEqual({ type: "identity", callId: request.callId, operationId, ...context, paths: [REPO, GIT_DIR, REPO] });
    const identities: IdentityReply[] = [IDENTITY, { code: "UNSUPPORTED_REPOSITORY" }, { code: "UNSUPPORTED_REPOSITORY", reason: "absent" }];
    channel.reply("process", { type: "identity", callId: request.callId, identities });
    expect(await result).toEqual(identities);

    for (const entry of [
      { code: "INVALID_REQUEST" },
      { code: "UNSUPPORTED_REPOSITORY", extra: 1 },
      { code: "UNSUPPORTED_REPOSITORY", reason: "access-denied" },
      { ...IDENTITY, fileId: "0".repeat(31) },
    ]) {
      const bad = channel.runner.identities(operationId, context, [REPO], SIGNAL);
      expect(channel.reply("process", { type: "identity", callId: channel.last("identity").callId, identities: [entry] })).toBe(false);
      await expect(bad).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    }
    await expect(channel.runner.identities(operationId, context, Array(9).fill(REPO), SIGNAL)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(channel.runner.identities(operationId, context, [], SIGNAL)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("lingeringCount replies with a count", async () => {
    const channel = createChannelDouble();
    const operationId = id();
    const result = channel.runner.lingeringCount(operationId, GIT_DIR);
    const request = channel.last("lingeringCount");
    expect(request).toEqual({ type: "lingeringCount", callId: request.callId, operationId, commonDirectory: GIT_DIR });
    channel.reply("process", { type: "lingeringCount", callId: request.callId, count: 3 });
    expect(await result).toBe(3);
  });

  test("register binds an issued ID and parses each reply form", async () => {
    const channel = createChannelDouble();
    const git = { operationId: id(), bootstrapId: id(), gitInstallationId: id(), version: "2.55.0.windows.1", digest: "c".repeat(64), confirm: true };
    const another = id();
    const asked = channel.runner.register(git);
    expect(channel.last("register")).toEqual({ type: "register", callId: channel.last("register").callId, ...git });
    const otherGit = isWindows ? "D:\\Git\\cmd\\git.exe" : "/opt/git/bin/git";
    channel.reply("process", { type: "register", callId: channel.last("register").callId, result: "another", bootstrapId: another, executablePath: otherGit });
    expect(await asked).toEqual({ result: "another", bootstrapId: another, executablePath: otherGit });
    const declined = channel.runner.register(git);
    channel.reply("process", { type: "register", callId: channel.last("register").callId, result: "declined" });
    expect(await declined).toEqual({ result: "declined" });

    const repository = {
      operationId: id(),
      bootstrapId: id(),
      gitInstallationId: id(),
      repositoryId: id(),
      worktreeRoot: REPO,
      gitDirectory: GIT_DIR,
      commonDirectory: GIT_DIR,
    };
    const approved = channel.runner.register(repository);
    channel.reply("process", { type: "register", callId: channel.last("register").callId, result: "approved" });
    expect(await approved).toEqual({ result: "approved" });
    // Only a Git registration with `confirm: true` can reply another result.
    const wrong = channel.runner.register(repository);
    expect(channel.reply("process", { type: "register", callId: channel.last("register").callId, result: "declined" })).toBe(false);
    await expect(wrong).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });

    const { digest: _, ...withoutDigest } = git;
    for (const bad of [{ ...git, version: "2.55\u00e9" }, { ...git, version: "v".repeat(65) }, { ...git, digest: "C".repeat(64) }, withoutDigest, { ...git, repositoryId: id() }, { ...repository, worktreeRoot: "repo" }]) {
      await expect(channel.runner.register(bad as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  const refusesAnother = async (paths: (string | undefined)[]) => {
    const channel = createChannelDouble();
    const git = { operationId: id(), bootstrapId: id(), gitInstallationId: id(), version: "2.55.0.windows.1", digest: "c".repeat(64), confirm: true };
    for (const path of paths) {
      const asked = channel.runner.register(git);
      const reply = { type: "register", callId: channel.last("register").callId, result: "another", bootstrapId: id(), ...(path === undefined ? {} : { executablePath: path }) };
      expect(channel.reply("process", reply)).toBe(false);
      await expect(asked).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    }
  };

  test("a register reply another needs a fully qualified executablePath", () =>
    refusesAnother([undefined, "git.exe", "\\Git\\git.exe", "C:\\Git\u0000\\git.exe", "\\\\.\\pipe\\git"]));

  test.skipIf(!isWindows)("windows-path-rules: a register reply another refuses a device executablePath with slashes", () => refusesAnother(["//?/C:/Git/git.exe"]));

  test("resolveGit sends the resolved git.exe and returns the new gitProbe bootstrapId", async () => {
    const channel = createChannelDouble();
    const request = { operationId: id(), bootstrapId: id(), executablePath: isWindows ? "C:\\Git\\mingw64\\libexec\\git-core\\git.exe" : "/usr/libexec/git-core/git" };
    const moved = id();
    const asked = channel.runner.resolveGit(request);
    const { callId } = channel.last("resolveGit");
    expect(channel.last("resolveGit")).toEqual({ type: "resolveGit", callId, ...request });
    expect(channel.reply("process", { type: "resolveGit", callId, bootstrapId: moved })).toBe(true);
    expect(await asked).toEqual({ bootstrapId: moved });

    const refused = channel.runner.resolveGit(request);
    expect(channel.reply("process", { type: "refused", callId: channel.last("resolveGit").callId, code: "INVALID_REQUEST" })).toBe(true);
    await expect(refused).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const malformed = channel.runner.resolveGit(request);
    expect(channel.reply("process", { type: "resolveGit", callId: channel.last("resolveGit").callId, bootstrapId: "short" })).toBe(false);
    await expect(malformed).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });

    const sent = channel.sent.length;
    for (const bad of [
      { ...request, executablePath: "git.exe" },
      { ...request, executablePath: "C:\\Git\\cmd\\git.cmd" },
      { ...request, executablePath: "\\\\?\\C:\\Git\\git.exe" },
      { ...request, bootstrapId: "short" },
      { ...request, extra: 1 },
    ]) {
      await expect(channel.runner.resolveGit(bad as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(channel.sent.length).toBe(sent);
  });

  test("a gitProbe run permits only --exec-path and version --build-options", async () => {
    const channel = createChannelDouble();
    const probe: ProcessContext = { contextKind: "gitProbe", bootstrapId: id() };
    for (const args of [["--exec-path", "version"], ["--exec-path=C:\\x"], ["--no-lazy-fetch", "--exec-path"]]) {
      await expect(channel.runner.run(call({ context: probe, environmentPolicy: "probe", arguments: args }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(channel.sent).toEqual([]);
    void channel.runner.run(call({ context: probe, environmentPolicy: "probe", arguments: ["--exec-path"] }));
    expect(channel.last("run").arguments).toEqual(["--exec-path"]);
  });

  test("release and closeJob carry no callId and get no reply", () => {
    const channel = createChannelDouble();
    const repositoryId = id();
    const gitInstallationId = id();
    const operationId = id();
    channel.runner.release({ repositoryId });
    channel.runner.release({ gitInstallationId });
    channel.runner.closeJob(operationId);
    expect(channel.sent).toEqual([
      { kind: "process", process: { type: "release", repositoryId } },
      { kind: "process", process: { type: "release", gitInstallationId } },
      { kind: "process", process: { type: "closeJob", operationId } },
    ]);
    expect(() => channel.runner.release({ repositoryId, gitInstallationId } as never)).toThrow();
    expect(() => channel.runner.closeJob("not-an-id")).toThrow();
  });

  test("a reply with an unknown callId is dropped", () => {
    const channel = createChannelDouble();
    expect(channel.reply("process", exit(id()))).toBe(true);
    expect(channel.reply("process", { type: "exit" })).toBe(false);
  });
});

// Contract §6 "File facts" and "Errors": the `fileFacts` frame and the checks of its reply.
describe("native runner file facts", () => {
  const request = (digest: boolean) => ({
    operationId: id(),
    contextKind: "registeredOperation" as const,
    gitInstallationId: id(),
    repositoryId: id(),
    digest,
    files: [
      { root: "gitDirectory" as const, path: ["hooks", "pre-commit"] },
      { root: "worktreeRoot" as const, path: ["tools"] },
    ],
  });
  const ABSENT = { kind: "absent" };

  test("fileFacts sends the FileFacts frame and returns one fact per entry", async () => {
    const channel = createChannelDouble();
    const sent = request(false);
    const result = channel.runner.fileFacts(sent, SIGNAL);
    const frame = channel.last("fileFacts");
    expect(Object.keys(channel.sent.at(-1)!)).toEqual(["kind", "process"]);
    expect(frame).toEqual({ type: "fileFacts", callId: frame.callId, ...sent });
    expect(ProcessRequest.safeParse(frame).success).toBe(true);
    const facts: FileFact[] = [
      { kind: "link", component: 2, tag: "symlink", target: "../../scripts/h.sh", relative: true },
      { kind: "directory", executable: true },
    ];
    expect(channel.reply("process", { type: "fileFacts", callId: frame.callId, facts })).toBe(true);
    expect(await result).toEqual(facts);

    const digested = channel.runner.fileFacts(request(true), SIGNAL);
    const files: FileFact[] = [
      { kind: "file", size: 3, lastWrite: "12", digest: "a".repeat(64) },
      { kind: "file", size: 2_000_000, lastWrite: "12", bound: "file-bytes" },
    ];
    expect(channel.reply("process", { type: "fileFacts", callId: channel.last("fileFacts").callId, facts: files })).toBe(true);
    expect(await digested).toEqual(files);
  });

  // Each reply breaks the shape or a rule between the request and its facts.
  test.each([
    ["a count that differs from the entry count", false, [ABSENT]],
    ["a link component past the entry path", false, [{ kind: "link", component: 3, tag: "other" }, ABSENT]],
    ["a link component 0", false, [{ kind: "link", component: 0, tag: "other" }, ABSENT]],
    ["an error component past the entry path", false, [{ kind: "error", component: 3, code: "io-error" }, ABSENT]],
    ["a digest without digest: true", false, [{ kind: "file", size: 3, lastWrite: "1", digest: "a".repeat(64) }, ABSENT]],
    ["a bound without digest: true", false, [{ kind: "file", size: 3, lastWrite: "1", bound: "file-bytes" }, ABSENT]],
    ["a file without digest and bound after digest: true", true, [{ kind: "file", size: 3, lastWrite: "1" }, ABSENT]],
    ["an unknown fact kind", false, [{ kind: "nope" }, ABSENT]],
  ] as const)("a reply with %s fails the call with PROCESS_OWNERSHIP_FAILED", async (_label, digest, facts) => {
    const channel = createChannelDouble();
    const result = channel.runner.fileFacts(request(digest), SIGNAL);
    expect(channel.reply("process", { type: "fileFacts", callId: channel.last("fileFacts").callId, facts })).toBe(false);
    await expect(result).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
  });

  test("a refused reply gives its code, and an invalid request sends nothing", async () => {
    const channel = createChannelDouble();
    const refused = channel.runner.fileFacts(request(false), SIGNAL);
    expect(channel.reply("process", { type: "refused", callId: channel.last("fileFacts").callId, code: "UNKNOWN_TARGET" })).toBe(true);
    await expect(refused).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
    const before = channel.sent.length;
    for (const files of [[], [{ root: "worktreeRoot" as const, path: [".."] }], [{ root: "worktreeRoot" as const, path: [] }]]) {
      await expect(channel.runner.fileFacts({ ...request(false), files }, SIGNAL)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(channel.sent.length).toBe(before);
  });
});

// Contract §6 "Walks": an `identity` or `fileFacts` request ends with its value, the `deadline` reply, or an abort.
describe("native runner walks", () => {
  const facts = () => ({
    operationId: id(),
    contextKind: "registeredOperation" as const,
    gitInstallationId: id(),
    repositoryId: id(),
    digest: false,
    files: [{ root: "gitDirectory" as const, path: ["hooks"] }],
  });
  // Starts one walk of each kind and returns its request type with the pending result.
  const walks = (channel: ReturnType<typeof createChannelDouble>, signal: AbortSignal) => [
    ["fileFacts", channel.runner.fileFacts(facts(), signal)] as const,
    ["identity", channel.runner.identities(id(), registered(), [REPO], signal)] as const,
  ];

  test("a deadline reply gives the deadline stop", async () => {
    const channel = createChannelDouble();
    for (const [type, result] of walks(channel, new AbortController().signal)) {
      expect(channel.reply("process", { type, callId: channel.last(type).callId, deadline: "deadline" })).toBe(true);
      expect(await result).toEqual({ stop: "deadline" });
    }
  });

  test("an abort sends one cancel with the walk callId and ends the call at once, and a later reply is dropped", async () => {
    const channel = createChannelDouble();
    const controller = new AbortController();
    const started = walks(channel, controller.signal);
    const callIds = started.map(([type]) => channel.last(type).callId);
    controller.abort();
    controller.abort();
    for (const [, result] of started) expect(await result).toEqual({ stop: "canceled" });
    expect(channel.bodies("cancel")).toEqual(callIds.map((callId) => ({ type: "cancel", callId })));
    expect(channel.reply("process", { type: "fileFacts", callId: callIds[0], facts: [{ kind: "absent" }] })).toBe(true);
    expect(channel.reply("process", { type: "identity", callId: callIds[1], identities: [IDENTITY] })).toBe(true);
  });

  test("an aborted signal sends no frame", async () => {
    const channel = createChannelDouble();
    const controller = new AbortController();
    controller.abort();
    for (const [, result] of walks(channel, controller.signal)) expect(await result).toEqual({ stop: "canceled" });
    expect(channel.sent).toEqual([]);
  });

  test.each([
    ["facts and deadline", { facts: [{ kind: "absent" }], deadline: "deadline" }],
    ["the deadline inactivity", { deadline: "inactivity" }],
  ])("a fileFacts reply with %s fails the call with PROCESS_OWNERSHIP_FAILED", async (_label, fields) => {
    const channel = createChannelDouble();
    const result = channel.runner.fileFacts(facts(), new AbortController().signal);
    expect(channel.reply("process", { type: "fileFacts", callId: channel.last("fileFacts").callId, ...fields })).toBe(false);
    await expect(result).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
  });

  test("an identity reply with identities and deadline fails the call with PROCESS_OWNERSHIP_FAILED", async () => {
    const channel = createChannelDouble();
    const result = channel.runner.identities(id(), registered(), [REPO], new AbortController().signal);
    expect(channel.reply("process", { type: "identity", callId: channel.last("identity").callId, identities: [IDENTITY], deadline: "deadline" })).toBe(false);
    await expect(result).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
  });
});

// Contract §6 "Walks" (T314): the other walks end with their value or the `deadline` reply. The service has no abort for them.
describe("native runner frame walks", () => {
  const started = { operationId: id(), repositoryId: id(), kind: "commit", worktreeRoot: REPO, commonDirectory: GIT_DIR } as const;
  const git = { operationId: id(), bootstrapId: id(), gitInstallationId: id(), version: "2.55.0.windows.1", digest: "c".repeat(64), confirm: true };
  const resolve = { operationId: id(), bootstrapId: id(), executablePath: isWindows ? "C:\\Git\\mingw64\\libexec\\git-core\\git.exe" : "/usr/libexec/git-core/git" };
  // Starts one walk of each frame and returns its frame kind, its request type, and the pending result.
  const asks = (channel: ReturnType<typeof createChannelDouble>) =>
    [
      ["process", "lingeringCount", channel.runner.lingeringCount(id(), GIT_DIR)],
      ["process", "register", channel.runner.register(git)],
      ["process", "resolveGit", channel.runner.resolveGit(resolve)],
      ["mutation", "started", channel.runner.started(started)],
      ["trust", "revoke", channel.runner.trust({ type: "revoke", commonDirectory: GIT_DIR })],
    ] as const;
  const values: Record<string, Body> = {
    lingeringCount: { count: 0 },
    register: { result: "approved" },
    resolveGit: { bootstrapId: id() },
    started: { busy: true },
    revoke: { endedProcesses: 0 },
  };

  test("a deadline reply gives the deadline stop", async () => {
    const channel = createChannelDouble();
    for (const [kind, type, result] of asks(channel)) {
      expect(channel.reply(kind, { type, callId: channel.last(type).callId, deadline: "deadline" })).toBe(true);
      expect(await result).toEqual({ stop: "deadline" });
    }
  });

  test.each([
    ["a value and deadline", (type: string) => ({ ...values[type], deadline: "deadline" })],
    ["the deadline inactivity", () => ({ deadline: "inactivity" })],
  ])("a reply with %s fails the call with PROCESS_OWNERSHIP_FAILED", async (_label, fields) => {
    const channel = createChannelDouble();
    for (const [kind, type, result] of asks(channel)) {
      expect(channel.reply(kind, { type, callId: channel.last(type).callId, ...fields(type) })).toBe(false);
      await expect(result).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    }
  });

  test("a confirm or confirmRun reply with deadline fails the call, because neither is a walk", async () => {
    const channel = createChannelDouble();
    const requests: TrustRequest[] = [
      { type: "confirm", worktreeRoot: REPO, gitDirectory: GIT_DIR, commonDirectory: GIT_DIR, gitSelectedPath: GIT_PATH, fingerprint: "a".repeat(64), persist: true },
      { type: "confirmRun", worktreeRoot: REPO, submodulePaths: [isWindows ? "C:\\repo\\sub" : "/repo/sub"], programCount: 1, uncheckedCount: 0 },
    ];
    for (const request of requests) {
      const result = channel.runner.trust(request);
      expect(channel.reply("trust", { type: request.type, callId: channel.last(request.type).callId, deadline: "deadline" })).toBe(false);
      await expect(result).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    }
  });
});

describe("native runner mutation and trust frames", () => {
  const started = { operationId: id(), repositoryId: id(), kind: "commit", worktreeRoot: REPO, commonDirectory: GIT_DIR } as const;

  test("started parses the marker, busy, and failure replies", async () => {
    const channel = createChannelDouble();
    const markerId = id();
    const marker = channel.runner.started(started);
    const request = channel.last("started");
    expect(request).toEqual({ type: "started", callId: request.callId, ...started });
    expect(channel.sent.at(-1)?.kind).toBe("mutation");
    channel.reply("mutation", { type: "started", callId: request.callId, markerId });
    expect(await marker).toEqual({ markerId });
    const busy = channel.runner.started(started);
    channel.reply("mutation", { type: "started", callId: channel.last("started").callId, busy: true });
    expect(await busy).toEqual({ busy: true });
    const failed = channel.runner.started(started);
    const folder = isWindows ? "C:\\data\\recovery" : "/data/recovery";
    channel.reply("mutation", { type: "started", callId: channel.last("started").callId, failure: "disk-full", folder });
    expect(await failed).toEqual({ failure: "disk-full", folder });
    const noFolder = channel.runner.started(started);
    expect(channel.reply("mutation", { type: "started", callId: channel.last("started").callId, failure: "other" })).toBe(false);
    await expect(noFolder).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    const wrongKind = channel.runner.started(started);
    expect(channel.reply("process", { type: "started", callId: channel.last("started").callId, markerId })).toBe(false);
    await expect(wrongKind).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    await expect(channel.runner.started({ ...started, kind: "readWorkspace" as never })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("ended and resolved carry no callId", () => {
    const channel = createChannelDouble();
    const markerId = id();
    channel.runner.ended(started.operationId, true);
    channel.runner.resolved(markerId);
    expect(channel.sent).toEqual([
      { kind: "mutation", mutation: { type: "ended", operationId: started.operationId, endProcesses: true } },
      { kind: "mutation", mutation: { type: "resolved", markerId } },
    ]);
  });

  const confirm = {
    type: "confirm",
    worktreeRoot: REPO,
    gitDirectory: GIT_DIR,
    commonDirectory: GIT_DIR,
    gitSelectedPath: GIT_PATH,
    fingerprint: "a".repeat(64),
    persist: true,
  } as const;

  test("confirm carries bound only with persist false, and approved carries stored and record", async () => {
    const channel = createChannelDouble();
    const stored = channel.runner.trust(confirm);
    const request = channel.last("confirm");
    expect(request).toEqual({ ...confirm, callId: request.callId });
    expect(channel.sent.at(-1)?.kind).toBe("trust");
    channel.reply("trust", { type: "confirm", callId: request.callId, result: "approved", stored: true, record: RECORD });
    expect(await stored).toEqual({ result: "approved", stored: true, record: RECORD });

    const failedWrite = channel.runner.trust(confirm);
    channel.reply("trust", { type: "confirm", callId: channel.last("confirm").callId, result: "approved", stored: false });
    expect(await failedWrite).toEqual({ result: "approved", stored: false });

    const session = channel.runner.trust({ ...confirm, persist: false, bound: "file-count" });
    expect(channel.last("confirm")).toMatchObject({ persist: false, bound: "file-count" });
    channel.reply("trust", { type: "confirm", callId: channel.last("confirm").callId, result: "approved", stored: false });
    expect(await session).toEqual({ result: "approved", stored: false });

    const declined = channel.runner.trust(confirm);
    channel.reply("trust", { type: "confirm", callId: channel.last("confirm").callId, result: "declined" });
    expect(await declined).toEqual({ result: "declined" });

    for (const reply of [
      { result: "approved" },
      { result: "approved", stored: true },
      { result: "approved", stored: false, record: RECORD },
      { result: "approved", stored: true, record: { ...RECORD, approvedAt: "yesterday" } },
      { result: "declined", stored: false },
    ]) {
      const bad = channel.runner.trust(confirm);
      expect(channel.reply("trust", { type: "confirm", callId: channel.last("confirm").callId, ...reply })).toBe(false);
      await expect(bad).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    }
    const sessionOnly = channel.runner.trust({ ...confirm, persist: false, bound: "total-bytes" });
    expect(channel.reply("trust", { type: "confirm", callId: channel.last("confirm").callId, result: "approved", stored: true, record: RECORD })).toBe(false);
    await expect(sessionOnly).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });

    for (const bad of [{ ...confirm, persist: false }, { ...confirm, bound: "file-count" }, { ...confirm, persist: false, bound: "files" }, { ...confirm, fingerprint: "A".repeat(64) }]) {
      await expect(channel.runner.trust(bad as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  test("revoke and confirmRun parse their replies", async () => {
    const channel = createChannelDouble();
    const revoked = channel.runner.trust({ type: "revoke", commonDirectory: GIT_DIR });
    channel.reply("trust", { type: "revoke", callId: channel.last("revoke").callId, endedProcesses: 2 });
    expect(await revoked).toEqual({ endedProcesses: 2 });
    const run: TrustRequest & { type: "confirmRun" } = { type: "confirmRun", worktreeRoot: REPO, submodulePaths: [isWindows ? "C:\\repo\\sub" : "/repo/sub"], programCount: 2, uncheckedCount: 1 };
    const approved = channel.runner.trust(run);
    channel.reply("trust", { type: "confirmRun", callId: channel.last("confirmRun").callId, result: "approved" });
    expect(await approved).toEqual({ result: "approved" });
    for (const bad of [{ ...run, uncheckedCount: 3 }, { ...run, programCount: 0, uncheckedCount: 0 }, { ...run, submodulePaths: [] }]) {
      await expect(channel.runner.trust(bad)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });
});

describe("native runner WSL frames (T212, contract §6 and §11)", () => {
  const WSL_PATH = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\repo";
  const GUID = "{c6d24ae9-40f2-40bf-b35d-bf0b6ca4ea00}";

  test("wslDistros sends only the context IDs and returns each reply form without type and callId", async () => {
    const channel = createChannelDouble();
    const ids = { operationId: id(), bootstrapId: id() };
    // A WSL path is a native path only on Windows (contract §11 "Route").
    const wsl = [
      { path: WSL_PATH, code: "WSL_UNAVAILABLE", reason: "wsl-missing" },
      { path: WSL_PATH, wslExecutable: "C:\\Windows\\System32\\wsl.exe", listed: ["Ubuntu-24.04"], running: [], keys: [{ guid: GUID, name: "Ubuntu-24.04", version: 2 }], saved: [] },
    ];
    const forms = [{ path: REPO }, ...(isWindows ? wsl : [])];
    for (const form of forms) {
      const pending = channel.runner.wslDistros(ids);
      const body = channel.last("wslDistros");
      expect(Object.keys(body).sort()).toEqual(["bootstrapId", "callId", "operationId", "type"]);
      channel.reply("process", { type: "wslDistros", callId: body.callId, ...form });
      expect(await pending).toEqual(form as never);
    }
    // A reply that breaks its shape fails the call (contract §6 "Errors").
    const pending = channel.runner.wslDistros(ids);
    expect(channel.reply("process", { type: "wslDistros", callId: channel.last("wslDistros").callId, path: REPO, listed: [] })).toBe(false);
    await expect(pending).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    await expect(channel.runner.wslDistros({ ...ids, path: REPO } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("wslProbe streams output and exits as run, and Cancel sends cancel with its callId", async () => {
    const channel = createChannelDouble();
    const stdout = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const probe = { operationId: id(), bootstrapId: id(), distro: "Ubuntu-24.04", limits: { deadlineMs: 60_000 } };
    const pending = channel.runner.wslProbe({ ...probe, stdout, stderr: createCollector({ maxBytes: 64 }), signal: new AbortController().signal });
    const body = channel.last("wslProbe");
    expect(body).toEqual({ type: "wslProbe", callId: body.callId, ...probe });
    channel.reply("process", { type: "output", callId: body.callId, stream: "stdout", data: new TextEncoder().encode("osid ubuntu\n").toBase64() });
    channel.reply("process", exit(body.callId));
    expect(await pending).toEqual({ exitCode: 0, activeDescendants: 0 });
    expect(new TextDecoder().decode(stdout.take())).toBe("osid ubuntu\n");

    const controller = new AbortController();
    const canceled = channel.runner.wslProbe({ ...probe, stdout, stderr: createCollector({ maxBytes: 64 }), signal: controller.signal });
    const second = channel.last("wslProbe");
    controller.abort();
    expect(channel.last("cancel")).toEqual({ type: "cancel", callId: second.callId });
    channel.reply("process", exit(second.callId, { exitCode: null }));
    expect(await canceled).toEqual({ exitCode: null, activeDescendants: 0 });

    for (const limits of [{ deadlineMs: 60_001 }, { deadlineMs: 0 }]) {
      await expect(channel.runner.wslProbe({ ...probe, limits, stdout, stderr: stdout, signal: new AbortController().signal })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  test("a WSL register gets approved or declined, and never another Git", async () => {
    const channel = createChannelDouble();
    const request = { operationId: id(), bootstrapId: id(), gitInstallationId: id(), confirm: true as const };
    for (const result of ["approved", "declined"] as const) {
      const pending = channel.runner.register(request);
      channel.reply("process", { type: "register", callId: channel.last("register").callId, result });
      expect(await pending).toEqual({ result });
    }
    const pending = channel.runner.register(request);
    channel.reply("process", { type: "register", callId: channel.last("register").callId, result: "another", bootstrapId: id(), executablePath: GIT_PATH });
    await expect(pending).rejects.toMatchObject({ code: "PROCESS_OWNERSHIP_FAILED" });
    await expect(channel.runner.register({ ...request, confirm: false } as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
