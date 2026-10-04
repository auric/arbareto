// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A test double of the shell end of `src/git-service/git-runner.ts`. It runs real Git through `Bun.spawn` argument arrays.
// It does not reproduce the shell console flags or Jobs. T024 and T027 cover them.

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import policyFile from "../../src/contracts/git-environment.json";
import { NATIVE_CHUNK_BYTES, WINDOWS_COMMAND_LINE_UNITS } from "../../src/contracts/limits";
import { isIdentifier } from "../../src/contracts/operations";
import {
  checkCall,
  checkContext,
  checkIdentityPaths,
  checkRegister,
  checkRelease,
  checkResolveGit,
  checkStarted,
  checkTrust,
  commandLineUnits,
  createDiagnosticCounter,
  isChannelPath,
  RunnerRefusal,
  type GitCall,
  type GitExit,
  type GitRunner,
  type IdentityReply,
  type MarkerFailure,
  type MutationStarted,
  type ProcessContext,
  type RegisterReply,
  type TrustRecord,
} from "../../src/git-service/git-runner";
import { printOrigin } from "../origin";
import { closePipe, createInboundPipe, peekPipe, processCreationTime, readIdentity, readPipe, terminateRecorded, type InboundPipe } from "./win32";

printOrigin("../../src/contracts/git-environment.json", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);

// The shell polls a silent pipe every 10 ms (src-tauri/src/process_requests.rs `POLL`).
const POLL_MS = 10;
const DISPOSE_WAIT_MS = 10_000;

type Policy = { remove: string[]; removePrefixes: string[]; set: Record<string, string>; indexFileVariable: string | null };
const POLICIES: Record<string, Policy> = policyFile.policies;

export interface TrustStore {
  records: TrustRecord[];
  // The `persist` value of each `confirm`, in order.
  persists: boolean[];
}

// Pass one store to a second runner to simulate a new service session.
export const createTrustStore = (): TrustStore => ({ records: [], persists: [] });

export interface BunRunnerOptions {
  git: string;
  // An owned directory for the `gitProbe` launch directory, the process records, and the recovery folder.
  directory: string;
  // The service environment. Each policy of `src/contracts/git-environment.json` starts from it.
  environment: Record<string, string>;
  trustStore?: TrustStore;
}

// One `run` request, recorded before the checks. `refused` names the error of a request that started nothing.
export interface RecordedCall {
  at: number;
  operationId: string;
  contextKind: string;
  repositoryId?: string;
  arguments: readonly string[];
  environmentPolicy: string;
  input?: Uint8Array;
  refused?: string;
  exit?: GitExit;
  // Microseconds from `Subprocess.resourceUsage()`. A call without a process has none.
  cpuMicros?: number;
}

export type CallMatch = (call: { operationId: string; arguments: readonly string[] }) => boolean;

interface ProcessRecord {
  pid: number;
  created: bigint;
  operationId?: string;
  // The common directory of the mutation that started the process.
  tag?: string;
}

type Gate = { promise: Promise<void>; open: () => void } | null;

function gate(): NonNullable<Gate> {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

// A barrier without a match holds every call, and a new one replaces it. Barriers with a match add up.
type Barriers = { every: Gate; matched: (NonNullable<Gate> & { match: CallMatch })[] };

function hold(barriers: Barriers, match?: CallMatch): () => void {
  const held = gate();
  if (match === undefined) {
    barriers.every = held;
    return () => {
      if (barriers.every === held) barriers.every = null;
      held.open();
    };
  }
  const barrier = { ...held, match };
  barriers.matched.push(barrier);
  return () => {
    barriers.matched = barriers.matched.filter((b) => b !== barrier);
    held.open();
  };
}

const holding = (barriers: Barriers, call: GitCall): Gate => barriers.every ?? barriers.matched.find((b) => b.match(call)) ?? null;
const text = (value: unknown) => (typeof value === "string" ? value : "");

const unknownTarget = () => new RunnerRefusal("UNKNOWN_TARGET");
const sameIdentity = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// The `confirm` fields of contract §6 "Trust frames" that the stored record sets by name or drops.
const CONFIRM_FIELDS = new Set(["type", "worktreeRoot", "gitDirectory", "commonDirectory", "fingerprint", "persist", "bound"]);

export function createBunRunner(options: BunRunnerOptions) {
  const launchDirectory = join(options.directory, "launch");
  // A fixture process writes `<pid>-<creation time>` here (`win32.ts` `recordProcess`).
  const recordsDirectory = join(options.directory, "processes");
  const recoveryFolder = join(options.directory, "recovery");
  for (const dir of [launchDirectory, recordsDirectory, recoveryFolder]) mkdirSync(dir, { recursive: true });

  const trustStore = options.trustStore ?? createTrustStore();
  const contexts = new Map<string, { kind: "gitProbe" | "repositoryDiscovery"; path: string; owner?: string }>();
  const gits = new Map<string, string>();
  const repositories = new Map<string, { worktreeRoot: string; gitDirectory: string; commonDirectory: string }>();
  const issued = new Set<string>();
  const inactive = new Set<string>();
  const running = new Map<string, Set<Subprocess>>();
  const records = new Map<string, ProcessRecord>();
  const tags = new Map<string, string>();
  const markers = new Map<string, MutationStarted>();
  const frames: Record<string, unknown>[] = [];
  const calls: RecordedCall[] = [];
  const identityCalls: { at: number; operationId: string; paths: string[]; replies: unknown[] }[] = [];
  // The functions that stop the running calls of each operation.
  const halts = new Map<string, Set<() => void>>();
  const drains = new Set<Promise<void>>();
  const diagnostics = createDiagnosticCounter();
  const inject = {
    // The Git selection confirmation result of a Git `register` with `confirm: true`.
    registerResult: { result: "approved" } as RegisterReply,
    markerFailure: undefined as MarkerFailure | undefined,
    confirmResult: "approved" as "approved" | "declined",
    // Identity replies by path. They take precedence over the `FileIdInfo` call.
    identities: new Map<string, IdentityReply>(),
    // File IDs by path, such as all zeros or all ones, that replace the `FileIdInfo` result.
    fileIds: new Map<string, Uint8Array>(),
    // Bytes replace the process of a call. No process starts, and the bytes go to stdout in 64 KiB chunks. The exit code is 0, or null after abort or closeJob.
    stdout: undefined as ((call: { arguments: readonly string[]; input?: Uint8Array }) => Uint8Array | undefined) | undefined,
  };
  const startBarriers: Barriers = { every: null, matched: [] };
  const stdoutBarriers: Barriers = { every: null, matched: [] };
  let spawned = 0;
  let disposed = false;

  const identityOf = (path: string): IdentityReply => inject.identities.get(path) ?? readIdentity(path, inject.fileIds.get(path));

  function scan(operationId?: string): void {
    for (const name of readdirSync(recordsDirectory)) {
      const match = /^(\d+)-(\d+)$/.exec(name);
      if (!match || records.has(name)) continue;
      records.set(name, { pid: Number(match[1]), created: BigInt(match[2]), operationId, tag: operationId && tags.get(operationId) });
    }
  }

  const live = (keep: (record: ProcessRecord) => boolean) => {
    scan();
    return [...records.values()].filter((r) => keep(r) && processCreationTime(r.pid) === r.created);
  };
  const end = (keep: (record: ProcessRecord) => boolean) => live(keep).filter((r) => terminateRecorded(r.pid, r.created)).length;

  // Contract §6 "Context rules": the first `operationId` of a `bootstrapId` owns it.
  function resolveTarget(operationId: string, context: ProcessContext): { program: string; cwd: string } {
    if (inactive.has(operationId)) throw unknownTarget();
    if (context.contextKind === "registeredOperation") {
      const program = gits.get(context.gitInstallationId);
      const repository = repositories.get(context.repositoryId);
      if (!program || !repository) throw unknownTarget();
      return { program, cwd: repository.worktreeRoot };
    }
    const bound = contexts.get(context.bootstrapId);
    if (!bound || bound.kind !== context.contextKind || (bound.owner ?? operationId) !== operationId) throw unknownTarget();
    bound.owner = operationId;
    if (context.contextKind === "gitProbe") return { program: bound.path, cwd: launchDirectory };
    const program = gits.get(context.gitInstallationId);
    if (!program) throw unknownTarget();
    return { program, cwd: bound.path };
  }

  // Mirrors `src-tauri/src/git_env.rs` `child_environment`. Windows variable names ignore case.
  function environment(call: GitCall): Record<string, string> {
    const policy = Object.hasOwn(POLICIES, call.environmentPolicy) ? POLICIES[call.environmentPolicy] : undefined;
    if (!policy || (call.transaction && !policy.indexFileVariable)) throw new RunnerRefusal("INVALID_REQUEST", "environment policy");
    const removed = new Set([...policy.remove, ...Object.keys(policy.set)].map((n) => n.toUpperCase()));
    const prefixes = policy.removePrefixes.map((p) => p.toUpperCase());
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.environment)) {
      const upper = name.toUpperCase();
      if (!removed.has(upper) && !prefixes.some((p) => upper.startsWith(p))) env[name] = value;
    }
    Object.assign(env, policy.set);
    if (call.transaction && policy.indexFileVariable) env[policy.indexFileVariable] = call.transaction.indexFile;
    return env;
  }

  // Contract §6 "Completion signal". Until `exit`, the drain forwards every byte. At `exit`, it forwards the bytes that the pipe holds, then discards the rest until end-of-file.
  // `held` returns a promise while a barrier holds the stream.
  function drain(pipe: InboundPipe, forward: (chunk: Uint8Array) => void, held: () => Promise<unknown> | null) {
    // `exit` sets the budget from a closure, so the type stays wide.
    let budget = null as number | null;
    let forwarded = () => {};
    const done = new Promise<void>((resolve) => (forwarded = resolve));
    const buffer = new Uint8Array(NATIVE_CHUNK_BYTES);
    const loop = (async () => {
      let forwarding = true;
      try {
        for (;;) {
          if (forwarding && budget === 0) {
            forwarding = false;
            forwarded();
          }
          const barrier = forwarding ? held() : null;
          if (barrier) {
            await barrier;
            continue;
          }
          const available = peekPipe(pipe);
          if (available === null) break;
          if (available === 0) {
            if (disposed) break;
            await Bun.sleep(POLL_MS);
            continue;
          }
          const limit = forwarding && budget !== null ? budget : buffer.length;
          const read = readPipe(pipe, buffer.subarray(0, Math.min(available, limit)));
          if (forwarding) {
            if (budget !== null) budget -= read;
            forward(buffer.slice(0, read));
          }
          // The shell reads each pipe on its own thread. A yield per chunk lets the exit, the deadline, and the other pipe run.
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        forwarded();
        closePipe(pipe);
      }
    })();
    drains.add(loop);
    void loop.finally(() => drains.delete(loop));
    return {
      exit: () => {
        budget ??= peekPipe(pipe) ?? 0;
      },
      done,
    };
  }

  async function start(call: GitCall, recorded: RecordedCall): Promise<GitExit> {
    checkCall(call);
    const target = resolveTarget(call.operationId, call.context);
    const env = environment(call);
    if (commandLineUnits(target.program, call.arguments) > WINDOWS_COMMAND_LINE_UNITS) throw new RunnerRefusal("INVALID_REQUEST", "command line");
    for (let held = holding(startBarriers, call); held; held = holding(startBarriers, call)) await held.promise;
    call.signal.throwIfAborted();
    // Abort, a kill, and closeJob stop the call. A stopped call leaves the stdout barrier.
    const stopped = gate();
    let halted = false;
    const halt = () => {
      halted = true;
      stopped.open();
    };
    const own = halts.get(call.operationId) ?? new Set<() => void>();
    halts.set(call.operationId, own.add(halt));
    call.signal.addEventListener("abort", halt, { once: true });
    const heldStdout = () => {
      const barrier = halted ? null : holding(stdoutBarriers, call);
      return barrier && Promise.race([barrier.promise, stopped.promise]);
    };
    try {
      const injected = inject.stdout?.({ arguments: call.arguments, input: call.input });
      if (injected === undefined) return await spawn(call, target, env, recorded, halt, heldStdout);
      // Contract §5 "Native stdout/stderr chunk": at most 64 KiB in one chunk.
      for (let at = 0; at < injected.length && !halted; at += NATIVE_CHUNK_BYTES) {
        for (let barrier = heldStdout(); barrier; barrier = heldStdout()) await barrier;
        if (halted) break;
        call.stdout.push(injected.subarray(at, at + NATIVE_CHUNK_BYTES));
        await new Promise((resolve) => setImmediate(resolve));
      }
      return { exitCode: halted ? null : 0, activeDescendants: 0 };
    } finally {
      call.signal.removeEventListener("abort", halt);
      own.delete(halt);
    }
  }

  async function spawn(
    call: GitCall,
    target: { program: string; cwd: string },
    env: Record<string, string>,
    recorded: RecordedCall,
    halt: () => void,
    heldStdout: () => Promise<unknown> | null,
  ): Promise<GitExit> {
    const pipes = [createInboundPipe(NATIVE_CHUNK_BYTES), createInboundPipe(NATIVE_CHUNK_BYTES)];
    let proc: Subprocess<"pipe", "ignore", "ignore">;
    try {
      proc = Bun.spawn([target.program, ...call.arguments], {
        cwd: target.cwd,
        env,
        stdin: "pipe",
        stdout: Bun.file(pipes[0].name),
        stderr: Bun.file(pipes[1].name),
      }) as unknown as Subprocess<"pipe", "ignore", "ignore">;
    } catch {
      pipes.forEach(closePipe);
      throw new RunnerRefusal("PROCESS_OWNERSHIP_FAILED");
    }
    spawned++;
    const own = running.get(call.operationId) ?? new Set();
    running.set(call.operationId, own.add(proc));
    // Contract §6 "Console and input": stdin closes after the bounded input, or at once.
    void (async () => {
      if (call.input?.length) proc.stdin.write(call.input);
      await proc.stdin.end();
    })().catch(() => {});

    let killed = false;
    let expired = false;
    // The double ends only the spawned process.
    const kill = () => {
      halt();
      if (killed) return;
      killed = true;
      proc.kill();
    };
    const deadlineMs = "deadlineMs" in call.limits ? call.limits.deadlineMs : call.limits.ceilingMs;
    const timer = setTimeout(() => {
      expired = true;
      kill();
    }, deadlineMs);
    call.signal.addEventListener("abort", kill, { once: true });
    const streams = [
      drain(
        pipes[0],
        (chunk) => {
          call.stdout.push(chunk);
          if (call.stdout.limited) kill();
        },
        heldStdout,
      ),
      drain(
        pipes[1],
        (chunk) => {
          call.stderr.push(chunk);
          if (diagnostics.add(call, chunk.length)) kill();
        },
        () => null,
      ),
    ];

    await proc.exited;
    clearTimeout(timer);
    call.signal.removeEventListener("abort", kill);
    own.delete(proc);
    const usage = proc.resourceUsage();
    if (usage) recorded.cpuMicros = usage.cpuTime.total;
    for (const stream of streams) stream.exit();
    await Promise.all(streams.map((s) => s.done));
    scan(call.operationId);
    return {
      exitCode: killed ? null : proc.exitCode,
      activeDescendants: live((r) => r.operationId === call.operationId).length,
      ...(expired ? { deadline: "deadline" as const } : {}),
      ...(diagnostics.reached(call) ? { diagnosticLimit: true as const } : {}),
    };
  }

  const runner: GitRunner = {
    async run(call: GitCall): Promise<GitExit> {
      const context: Record<string, unknown> = typeof call.context === "object" && call.context !== null ? call.context : {};
      const recorded: RecordedCall = {
        at: performance.now(),
        operationId: text(call.operationId),
        contextKind: text(context.contextKind),
        ...(typeof context.repositoryId === "string" ? { repositoryId: context.repositoryId } : {}),
        arguments: Array.isArray(call.arguments) ? [...call.arguments] : [],
        environmentPolicy: text(call.environmentPolicy),
        ...(call.input instanceof Uint8Array ? { input: call.input } : {}),
      };
      calls.push(recorded);
      try {
        recorded.exit = await start(call, recorded);
        return recorded.exit;
      } catch (error) {
        recorded.refused = error instanceof RunnerRefusal ? error.code : error instanceof Error ? error.name : "unknown";
        throw error;
      }
    },

    // A refused request keeps an empty `replies` list.
    async identities(operationId, context, paths) {
      const recorded = { at: performance.now(), operationId: text(operationId), paths: Array.isArray(paths) ? [...paths] : [], replies: [] as unknown[] };
      identityCalls.push(recorded);
      if (!isIdentifier(operationId) || !checkContext(context)) throw new RunnerRefusal("INVALID_REQUEST", "identity context");
      checkIdentityPaths(paths);
      resolveTarget(operationId, context);
      const replies = paths.map(identityOf);
      recorded.replies = replies;
      return replies;
    },

    async lingeringCount(operationId, commonDirectory) {
      if (!isIdentifier(operationId) || !isChannelPath(commonDirectory)) throw new RunnerRefusal("INVALID_REQUEST", "lingering count");
      if (inactive.has(operationId)) throw unknownTarget();
      return live((r) => r.tag === commonDirectory).length;
    },

    async register(request) {
      const confirm = checkRegister(request);
      const bound = contexts.get(request.bootstrapId);
      if (inactive.has(request.operationId) || !bound || (bound.owner ?? request.operationId) !== request.operationId) throw unknownTarget();
      if ("version" in request) {
        if (bound.kind !== "gitProbe") throw unknownTarget();
        if (issued.has(request.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "issued ID");
        contexts.delete(request.bootstrapId);
        const reply = confirm ? inject.registerResult : ({ result: "approved" } as const);
        if (reply.result === "approved") {
          issued.add(request.gitInstallationId);
          gits.set(request.gitInstallationId, bound.path);
        }
        return reply;
      }
      if (bound.kind !== "repositoryDiscovery" || !gits.has(request.gitInstallationId)) throw unknownTarget();
      if (issued.has(request.repositoryId)) throw new RunnerRefusal("INVALID_REQUEST", "issued ID");
      contexts.delete(request.bootstrapId);
      issued.add(request.repositoryId);
      const { worktreeRoot, gitDirectory, commonDirectory } = request;
      repositories.set(request.repositoryId, { worktreeRoot, gitDirectory, commonDirectory });
      return { result: "approved" };
    },

    // The double has no startup context. So it skips the native rule that limits a startup context move.
    async resolveGit(request) {
      checkResolveGit(request);
      const bound = contexts.get(request.bootstrapId);
      if (inactive.has(request.operationId) || bound?.kind !== "gitProbe" || (bound.owner ?? request.operationId) !== request.operationId) throw unknownTarget();
      if (!statSync(request.executablePath, { throwIfNoEntry: false })?.isFile()) throw new RunnerRefusal("INVALID_REQUEST", "resolved file");
      contexts.delete(request.bootstrapId);
      const bootstrapId = crypto.randomUUID();
      contexts.set(bootstrapId, { kind: "gitProbe", path: request.executablePath, owner: request.operationId });
      return { bootstrapId };
    },

    release(target) {
      checkRelease(target);
      if ("repositoryId" in target) repositories.delete(target.repositoryId);
      else gits.delete(target.gitInstallationId);
    },

    closeJob(operationId) {
      if (!isIdentifier(operationId)) throw new RunnerRefusal("INVALID_REQUEST", "closeJob");
      frames.push({ type: "closeJob", operationId });
      for (const proc of running.get(operationId) ?? []) proc.kill();
      for (const halt of halts.get(operationId) ?? []) halt();
      end((r) => r.operationId === operationId);
      inactive.add(operationId);
      diagnostics.clear(operationId);
    },

    async started(frame) {
      checkStarted(frame);
      frames.push({ type: "started", ...frame });
      if (inject.markerFailure) return { failure: inject.markerFailure, folder: recoveryFolder };
      const markerId = crypto.randomUUID();
      markers.set(markerId, { ...frame });
      tags.set(frame.operationId, frame.commonDirectory);
      return { markerId };
    },

    ended(operationId, endProcesses) {
      if (!isIdentifier(operationId) || typeof endProcesses !== "boolean") throw new RunnerRefusal("INVALID_REQUEST", "ended");
      frames.push({ type: "ended", operationId, endProcesses });
      if (endProcesses) end((r) => r.operationId === operationId);
      inactive.add(operationId);
      diagnostics.clear(operationId);
    },

    resolved(markerId) {
      if (!isIdentifier(markerId)) throw new RunnerRefusal("INVALID_REQUEST", "resolved");
      frames.push({ type: "resolved", markerId });
      markers.delete(markerId);
    },

    async trust(request) {
      checkTrust(request);
      if (request.type === "revoke") {
        const identity = identityOf(request.commonDirectory);
        trustStore.records = trustStore.records.filter((r) => r.commonDirectory !== request.commonDirectory && !sameIdentity(r.commonIdentity, identity));
        return { endedProcesses: end((r) => r.tag === request.commonDirectory) };
      }
      if (request.type === "confirmRun") throw new RunnerRefusal("INVALID_REQUEST", "confirmRun is not in this double yet");
      trustStore.persists.push(request.persist);
      if (inject.confirmResult === "declined") return { result: "declined" };
      const commonIdentity = identityOf(request.commonDirectory);
      const worktreeIdentity = [identityOf(request.worktreeRoot), identityOf(request.gitDirectory)];
      // Contract §7 "Trust approval store": a record of the same worktree matches by both identities or by both paths.
      trustStore.records = trustStore.records.filter(
        (r) =>
          !(sameIdentity(r.commonIdentity, commonIdentity) && sameIdentity(r.worktreeIdentity, worktreeIdentity)) &&
          !(r.commonDirectory === request.commonDirectory && r.worktreeRoot === request.worktreeRoot),
      );
      const readable = [commonIdentity, ...worktreeIdentity].every((i) => !("code" in i));
      if (!request.persist || !readable) return { result: "approved", stored: false };
      // The record copies the Git field of the request unchanged, so it follows the field name of `git-runner.ts`.
      const git = Object.fromEntries(Object.entries(request).filter(([key]) => !CONFIRM_FIELDS.has(key)));
      const record = {
        commonDirectory: request.commonDirectory,
        commonIdentity,
        worktreeRoot: request.worktreeRoot,
        gitDirectory: request.gitDirectory,
        worktreeIdentity,
        configurationFingerprint: request.fingerprint,
        approvedAt: new Date().toISOString(),
        ...git,
      } as TrustRecord;
      trustStore.records.push(record);
      return { result: "approved", stored: true, record };
    },
  };

  return {
    ...runner,
    inject,
    frames,
    markers,
    trustStore,
    recordsDirectory,
    // Every `run` and identity request in arrival order.
    calls,
    identityCalls,
    get spawned() {
      return spawned;
    },
    // Returns the bootstrap ID of a new native context.
    addContext(kind: "gitProbe" | "repositoryDiscovery", path: string): string {
      const bootstrapId = crypto.randomUUID();
      contexts.set(bootstrapId, { kind, path });
      return bootstrapId;
    },
    // The path of a live native context, or `undefined` after its end.
    contextPath(bootstrapId: string): string | undefined {
      return contexts.get(bootstrapId)?.path;
    },
    // Test barrier: no matching process starts until the returned function runs. Without `match`, it holds every call.
    holdStart(match?: CallMatch): () => void {
      return hold(startBarriers, match);
    },
    // Test barrier: stdout draining of each matching call stops until the returned function runs. A full pipe then blocks the child.
    // Without `match`, it holds every call. Abort, a kill, or closeJob releases the stopped call.
    pauseStdout(match?: CallMatch): () => void {
      return hold(stdoutBarriers, match);
    },
    // Ends every recorded live process by PID and every running process, then waits a bounded time for the drains.
    async dispose(): Promise<void> {
      end(() => true);
      for (const set of running.values()) for (const proc of set) proc.kill();
      for (const barriers of [startBarriers, stdoutBarriers]) {
        barriers.every?.open();
        barriers.every = null;
        for (const barrier of barriers.matched.splice(0)) barrier.open();
      }
      await Promise.race([Promise.all([...drains]), Bun.sleep(DISPOSE_WAIT_MS)]);
      disposed = true;
      await Promise.race([Promise.all([...drains]), Bun.sleep(DISPOSE_WAIT_MS)]);
    },
  };
}

export type BunRunner = ReturnType<typeof createBunRunner>;
