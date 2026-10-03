// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A test double of the shell end of `src/git-service/git-runner.ts`. It runs real Git through `Bun.spawn` argument arrays.
// It does not reproduce the shell console flags or Jobs. T024 and T027 cover them.

import { mkdirSync, readdirSync } from "node:fs";
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

const unknownTarget = () => new RunnerRefusal("UNKNOWN_TARGET");
const sameIdentity = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
  };
  let startGate: Gate = null;
  let stdoutGate: Gate = null;
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
  function drain(pipe: InboundPipe, forward: (chunk: Uint8Array) => void, stdout: boolean) {
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
          if (forwarding && stdout && stdoutGate) {
            await stdoutGate.promise;
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

  const runner: GitRunner = {
    async run(call: GitCall): Promise<GitExit> {
      checkCall(call);
      const target = resolveTarget(call.operationId, call.context);
      const env = environment(call);
      if (commandLineUnits(target.program, call.arguments) > WINDOWS_COMMAND_LINE_UNITS) throw new RunnerRefusal("INVALID_REQUEST", "command line");
      while (startGate) await startGate.promise;
      call.signal.throwIfAborted();
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
          true,
        ),
        drain(
          pipes[1],
          (chunk) => {
            call.stderr.push(chunk);
            if (diagnostics.add(call, chunk.length)) kill();
          },
          false,
        ),
      ];

      await proc.exited;
      clearTimeout(timer);
      call.signal.removeEventListener("abort", kill);
      own.delete(proc);
      for (const stream of streams) stream.exit();
      await Promise.all(streams.map((s) => s.done));
      scan(call.operationId);
      return {
        exitCode: killed ? null : proc.exitCode,
        activeDescendants: live((r) => r.operationId === call.operationId).length,
        ...(expired ? { deadline: "deadline" as const } : {}),
        ...(diagnostics.reached(call) ? { diagnosticLimit: true as const } : {}),
      };
    },

    async identities(operationId, context, paths) {
      if (!isIdentifier(operationId) || !checkContext(context)) throw new RunnerRefusal("INVALID_REQUEST", "identity context");
      checkIdentityPaths(paths);
      resolveTarget(operationId, context);
      return paths.map(identityOf);
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

    release(target) {
      checkRelease(target);
      if ("repositoryId" in target) repositories.delete(target.repositoryId);
      else gits.delete(target.gitInstallationId);
    },

    closeJob(operationId) {
      if (!isIdentifier(operationId)) throw new RunnerRefusal("INVALID_REQUEST", "closeJob");
      frames.push({ type: "closeJob", operationId });
      for (const proc of running.get(operationId) ?? []) proc.kill();
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
      const record = {
        commonDirectory: request.commonDirectory,
        commonIdentity,
        worktreeRoot: request.worktreeRoot,
        gitDirectory: request.gitDirectory,
        worktreeIdentity,
        configurationFingerprint: request.fingerprint,
        approvedAt: new Date().toISOString(),
        gitInstallationDigest: request.gitInstallationDigest,
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
    get spawned() {
      return spawned;
    },
    // Returns the bootstrap ID of a new native context.
    addContext(kind: "gitProbe" | "repositoryDiscovery", path: string): string {
      const bootstrapId = crypto.randomUUID();
      contexts.set(bootstrapId, { kind, path });
      return bootstrapId;
    },
    // Test barrier: no process starts until the returned function runs.
    holdStart(): () => void {
      const held = gate();
      startGate = held;
      return () => {
        if (startGate === held) startGate = null;
        held.open();
      };
    },
    // Test barrier: stdout draining stops until the returned function runs. A full pipe then blocks the child.
    pauseStdout(): () => void {
      const held = gate();
      stdoutGate = held;
      return () => {
        if (stdoutGate === held) stdoutGate = null;
        held.open();
      };
    },
    // Ends every recorded live process by PID and every running process, then waits a bounded time for the drains.
    async dispose(): Promise<void> {
      end(() => true);
      for (const set of running.values()) for (const proc of set) proc.kill();
      startGate?.open();
      startGate = null;
      stdoutGate?.open();
      stdoutGate = null;
      await Promise.race([Promise.all([...drains]), Bun.sleep(DISPOSE_WAIT_MS)]);
      disposed = true;
      await Promise.race([Promise.all([...drains]), Bun.sleep(DISPOSE_WAIT_MS)]);
    },
  };
}

export type BunRunner = ReturnType<typeof createBunRunner>;
