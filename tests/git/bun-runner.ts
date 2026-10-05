// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A test double of the shell end of `src/git-service/git-runner.ts`. It runs real Git through `Bun.spawn` argument arrays.
// It does not reproduce the shell console flags or Jobs. T024 and T027 cover them.
// T206 adds the contract §11 WSL process requests. Their frame shapes are a proposal for T212 and the contract owner (see `WslDistrosReply`).

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import policyFile from "../../src/contracts/git-environment.json";
import wslProcess from "../../src/contracts/wsl-process.json";
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
  type Collector,
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
import { isWindowsProgram } from "../../src/contracts/wsl-route";
import { listDistros, parseProbe, registryKeys, WSL_EXE, wslExec, type RegistryKey } from "../wsl/wsl-host";
import type { InboundPipe } from "./win32";

// The host module of the double. The generic harness loads it only through this path (tests/git/portable-imports.test.ts).
export const HOST_SCRIPT = join(import.meta.dir, process.platform === "win32" ? "win32.ts" : "linux.ts");
const { closePipe, createInboundPipe, peekPipe, processCreationTime, readIdentity, readPipe, terminateRecorded } = require(HOST_SCRIPT) as typeof import("./win32");

printOrigin("../../src/contracts/git-environment.json", import.meta.dir);
printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);
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
  // Fixture isolation for WSL processes only: the Linux path of the owned global configuration.
  // The double forwards it and `GIT_CONFIG_NOSYSTEM=1` through `WSLENV`. The product shell forwards nothing (T205).
  wslGlobalConfig?: string;
}

// ---- Contract §11 process requests. The shell side is `src-tauri/src/wsl.rs`. ----

const WSL_TEXTS = { wrapper: wslProcess.wrapper.join("\n"), anchor: wslProcess.anchor.join("\n"), probe: wslProcess.probe.join("\n") };
// Contract §5: a WSL distro start probe has at most 60 seconds.
const WSL_START_CAP_MS = 60_000;
const WSL_PREFIX = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\/]+)(?:[\\/](.*))?$/i;

export type WslMode = "probe" | "read" | "mutation" | "network";

// The approved Linux Git of one distro (data-model §1). The shell takes it from its own parse of the probe output.
export interface WslInstallation {
  distro: string;
  guid: string;
  git: string;
  systemdRun: string;
  systemctl: string;
  setsid: string;
}

// The native settings record of one approved WSL Git (contract §11 "Git per distro").
export interface WslSavedGit {
  guid: string;
  distro: string;
  git: string;
  version: string;
  gitIdentity: string;
}

// Proposed `wslDistros` reply: the two list calls, the registration keys of the listed names (contract §11 "Distro checks"),
// and the saved Git of each listed GUID. A later probe with another Git identity gives `GIT_CHANGED`.
// `path` is the native context path. The service holds only the bootstrap ID, so it routes this path (contract §11 "Route").
export type WslDistrosReply = { path: string; listed: string[]; running: string[]; keys: RegistryKey[]; saved: WslSavedGit[] } | { code: "WSL_UNAVAILABLE"; reason: "wsl-missing" };

// Proposed `register` Git form for a WSL Git. The shell takes the distro, the Git path, the helper paths, the version, and the Git identity
// from the probe facts that it bound to this `repositoryDiscovery` context at `wslProbe`. The service never names a Linux program.
export interface WslRegisterRequest {
  operationId: string;
  bootstrapId: string;
  gitInstallationId: string;
  confirm: true;
}

// The facts that the shell parsed from one successful probe of a `repositoryDiscovery` context.
type WslBound = WslInstallation & { version: string; gitIdentity: string };

// Proposed WSL identity reply (contract §11 "Paths and file access"). It holds no device number.
export type WslIdentityReply =
  | { distroGuid: string; fileSystemId: string; inode: string; fileSystemType: string }
  | { code: "UNSUPPORTED_REPOSITORY"; reason?: "no-fs-uuid" | "mixed-location" };

// Proposed `wslProbe` request: the fixed Git probe text in the distro of a `repositoryDiscovery` context, without the wrapper.
export interface WslProbeCall {
  operationId: string;
  bootstrapId: string;
  distro: string;
  limits: { deadlineMs: number };
  stdout: GitCall["stdout"];
  stderr: GitCall["stderr"];
  signal: AbortSignal;
}

// A seam result that replaces the real probe. No process starts for it.
export interface WslProbeSeam {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  deadline?: true;
}

// The Linux path of a UNC WSL path. After the prefix, `\` and `/` both separate segments, as in `src/contracts/wsl-route.ts`.
function wslParts(path: string): { distro: string; linux: string } | null {
  const m = WSL_PREFIX.exec(path);
  if (!m) return null;
  return { distro: m[1]!, linux: `/${(m[2] ?? "").split(/[\\/]/).filter((s) => s !== "").join("/")}` };
}

// Mirrors `RETAINED_BYTES` of `src-tauri/src/wsl.rs`: the shell parses at most 64 KiB of probe output.
const WSL_PROBE_RETAINED_BYTES = 64 * 1024;
const WSL_HELPERS = ["git", "systemd-run", "systemctl", "setsid"] as const;

// The shell parse of the contract §11 probe output. Output that fails a §11 rule binds nothing.
function bindProbe(distro: string, text: string): WslBound | null {
  const facts = parseProbe(text);
  const paths = WSL_HELPERS.map((name) => {
    const path = facts.paths[name];
    return path?.startsWith("/") && !isWindowsProgram(path, facts.magic[name] === "MZ") ? path : undefined;
  });
  const [git, systemdRun, systemctl, setsid] = paths;
  const fileSystem = /^ef53:([0-9a-f]+)$/.exec(facts.gitfs ?? "")?.[1];
  const version = /^git version (\S+)$/.exec(facts.version ?? "")?.[1];
  const guid = registryKeys().find((k) => k.name === distro && k.version === 2)?.guid;
  if (!git || !systemdRun || !systemctl || !setsid || facts.scope !== "0" || !version || !guid) return null;
  if (!fileSystem || /^0+$/.test(fileSystem) || !/^\d+:\d+:\d+$/.test(facts.gitfile ?? "")) return null;
  return { distro, guid, git, systemdRun, systemctl, setsid, version, gitIdentity: `${fileSystem}:${facts.gitfile}` };
}

// Mirrors `src-tauri/src/wsl.rs` `classify`.
function classifyIdentity(guid: string, inode: string, fileSystem: string): WslIdentityReply {
  const ino = /^(\d+)\n$/.exec(inode)?.[1];
  const fs = /^([0-9a-f]+):([0-9a-f]+)\n$/.exec(fileSystem);
  if (!ino || !fs) return { code: "UNSUPPORTED_REPOSITORY" };
  if (fs[1] === "1021997") return { code: "UNSUPPORTED_REPOSITORY", reason: "mixed-location" };
  if (fs[1] !== "ef53" || /^0+$/.test(fs[2]!)) return { code: "UNSUPPORTED_REPOSITORY", reason: "no-fs-uuid" };
  return { distroGuid: guid, fileSystemId: fs[2]!, inode: ino, fileSystemType: fs[1]! };
}

interface WslAnchor {
  proc: Subprocess<"pipe", "pipe", "ignore">;
  // The answer to one stdin line: the process count and the I/O sum of the operation scopes.
  ask(): Promise<[number, number] | null>;
  last: [number, number] | null;
  close(): void;
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

export function createBunRunner(options: BunRunnerOptions) {
  const launchDirectory = join(options.directory, "launch");
  // A fixture process writes `<pid>-<creation time>` here (`recordProcess` of `HOST_SCRIPT`).
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
    // WSL seams (T207, T209): a probe result, a running list, `stat` probe outputs by UNC path, and the WSL Git confirmation result.
    wslProbe: null as WslProbeSeam | null,
    wslRunning: null as string[] | null,
    wslStat: new Map<string, { inode: string; fileSystem: string }>(),
    wslConfirm: "approved" as "approved" | "declined",
    // A test-injected deadline. A shorter value than the request limit ends the process as the shell deadline does.
    deadlineMs: null as number | null,
    // Runs after each WSL process exits, before its exit reply.
    afterWslExit: null as ((call: GitCall) => Promise<void>) | null,
    // Bytes replace the process of a call. No process starts, and the bytes go to stdout in 64 KiB chunks. The exit code is 0, or null after abort, closeJob, or a limited stdout collector.
    stdout: undefined as ((call: { arguments: readonly string[]; input?: Uint8Array }) => Uint8Array | undefined) | undefined,
  };
  // Each WSL identity reply with its UNC path, in order.
  const wslIdentityLog: { path: string; reply: WslIdentityReply }[] = [];
  const wslGits = new Map<string, WslInstallation>();
  // The probe facts that the shell bound to each `repositoryDiscovery` bootstrap ID.
  const wslBound = new Map<string, WslBound>();
  // The unit counter of each operation that started a wrapped process, with its installation.
  const wslUnits = new Map<string, { inst: WslInstallation; n: number }>();
  const wslAnchors = new Map<string, WslAnchor>();
  // The native confirmations that a WSL `register` showed, in order.
  const wslConfirmations: { distro: string; path: string; version: string }[] = [];
  // Native settings: the approved Git of each distro GUID (contract §11 "Git per distro").
  const wslSaved = new Map<string, Omit<WslSavedGit, "guid">>();
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
  // A WSL Git target carries its installation. Its `cwd` is the UNC directory that becomes the Linux `-C` directory.
  function resolveTarget(operationId: string, context: ProcessContext): { program: string; cwd: string; wsl?: WslInstallation } {
    if (inactive.has(operationId)) throw unknownTarget();
    if (context.contextKind === "registeredOperation") {
      const program = gits.get(context.gitInstallationId);
      const repository = repositories.get(context.repositoryId);
      if (!program || !repository) throw unknownTarget();
      return { program, cwd: repository.worktreeRoot, wsl: wslGits.get(context.gitInstallationId) };
    }
    const bound = contexts.get(context.bootstrapId);
    if (!bound || bound.kind !== context.contextKind || (bound.owner ?? operationId) !== operationId) throw unknownTarget();
    bound.owner = operationId;
    if (context.contextKind === "gitProbe") return { program: bound.path, cwd: launchDirectory };
    const program = gits.get(context.gitInstallationId);
    if (!program) throw unknownTarget();
    return { program, cwd: bound.path, wsl: wslGits.get(context.gitInstallationId) };
  }

  // Contract §11 "Process launch". Only the fixture isolation of `wslGlobalConfig` reaches Linux.
  function wslEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.environment)) {
      if (!["WSL_UTF8", "WSLENV", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].includes(name.toUpperCase())) env[name] = value;
    }
    env.WSL_UTF8 = "1";
    env.WSLENV = "";
    if (options.wslGlobalConfig) Object.assign(env, { WSLENV: "GIT_CONFIG_GLOBAL:GIT_CONFIG_NOSYSTEM", GIT_CONFIG_GLOBAL: options.wslGlobalConfig, GIT_CONFIG_NOSYSTEM: "1" });
    return env;
  }

  const wslHead = (distro: string) => ["--distribution", distro, "--cd", "/", "--exec", "/bin/sh", "-c"];

  function wslWrapped(inst: WslInstallation, operationId: string, mode: WslMode, index: string, program: string, args: readonly string[]): string[] {
    const n = (wslUnits.get(operationId)?.n ?? 0) + 1;
    wslUnits.set(operationId, { inst, n });
    const unit = `arbareto-${operationId}-${n}.scope`;
    return [...wslHead(inst.distro), WSL_TEXTS.wrapper, "sh", unit, mode, index, inst.systemdRun, inst.systemctl, inst.setsid, program, ...args];
  }

  // Starts the anchor of a WSL mutation before its first Git process, in the operation's process set.
  function wslAnchor(operationId: string, inst: WslInstallation): WslAnchor {
    const existing = wslAnchors.get(operationId);
    if (existing) return existing;
    const proc = Bun.spawn([WSL_EXE, ...wslHead(inst.distro), WSL_TEXTS.anchor, "sh", inst.systemctl, operationId], {
      cwd: launchDirectory,
      env: wslEnvironment(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const own = running.get(operationId) ?? new Set();
    running.set(operationId, own.add(proc as unknown as Subprocess));
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const waiting: ((line: [number, number] | null) => void)[] = [];
    const anchor: WslAnchor = {
      proc,
      last: null,
      ask: () => {
        const answer = new Promise<[number, number] | null>((resolve) => waiting.push(resolve));
        proc.stdin.write("\n");
        void proc.stdin.flush();
        return answer;
      },
      close: () => void proc.stdin.end(),
    };
    void (async () => {
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value);
        for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
          const m = /^(\d+) (\d+)$/.exec(buffered.slice(0, nl));
          buffered = buffered.slice(nl + 1);
          if (!m) continue;
          anchor.last = [Number(m[1]), Number(m[2])];
          waiting.shift()?.(anchor.last);
        }
      }
      for (const resolve of waiting.splice(0)) resolve(null);
    })();
    wslAnchors.set(operationId, anchor);
    return anchor;
  }

  // Contract §11 "Paths and file access": the two `stat` probes through the wrapper in `probe` mode.
  async function wslIdentity(operationId: string, inst: WslInstallation, path: string): Promise<WslIdentityReply> {
    const parts = wslParts(path);
    let reply: WslIdentityReply = { code: "UNSUPPORTED_REPOSITORY" };
    const injected = inject.wslStat.get(path);
    if (injected) reply = classifyIdentity(inst.guid, injected.inode, injected.fileSystem);
    else if (parts && parts.distro.toLowerCase() === inst.distro.toLowerCase()) {
      const stat = (args: string[]) => {
        const result = wslExec(wslWrapped(inst, operationId, "probe", "", "/usr/bin/stat", [...args, parts.linux]), { env: wslEnvironment() });
        return result.exitCode === 0 ? result.stdout : "";
      };
      reply = classifyIdentity(inst.guid, stat(["--dereference", "--format=%i"]), stat(["--dereference", "--file-system", "--format=%t:%i"]));
    }
    wslIdentityLog.push({ path, reply });
    return reply;
  }

  // Test end: ends every scope of an operation that this double started.
  function endWslScopes(operationId: string): void {
    const inst = wslUnits.get(operationId)?.inst;
    if (!inst) return;
    wslExec(["--distribution", inst.distro, "--cd", "/", "--exec", inst.systemctl, "--user", "kill", "--signal=SIGKILL", "--", `arbareto-${operationId}-*.scope`]);
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

  // Starts one process after the start barriers and drains it as the shell does.
  async function execute(call: GitCall, argv: string[], cwd: string, env: Record<string, string>, recorded?: RecordedCall): Promise<GitExit> {
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
      if (injected === undefined) return await spawn(call, argv, cwd, env, recorded, halt, heldStdout);
      // Contract §5 "Native stdout/stderr chunk": at most 64 KiB in one chunk.
      for (let at = 0; at < injected.length && !halted; at += NATIVE_CHUNK_BYTES) {
        for (let barrier = heldStdout(); barrier; barrier = heldStdout()) await barrier;
        if (halted) break;
        call.stdout.push(injected.subarray(at, at + NATIVE_CHUNK_BYTES));
        if (call.stdout.limited) halt();
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
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    recorded: RecordedCall | undefined,
    halt: () => void,
    heldStdout: () => Promise<unknown> | null,
  ): Promise<GitExit> {
    const pipes = [createInboundPipe(NATIVE_CHUNK_BYTES), createInboundPipe(NATIVE_CHUNK_BYTES)];
    let proc: Subprocess<"pipe", "ignore", "ignore">;
    try {
      proc = Bun.spawn(argv, {
        cwd,
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
    const limit = "deadlineMs" in call.limits ? call.limits.deadlineMs : call.limits.ceilingMs;
    const deadlineMs = Math.min(limit, inject.deadlineMs ?? limit);
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
    if (usage && recorded) recorded.cpuMicros = usage.cpuTime.total;
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

  // The last anchor count of each WSL mutation with this tag (contract §11 "Process ownership").
  const wslLingering = (tag: string) => [...wslAnchors].filter(([op]) => tags.get(op) === tag).reduce((sum, [, a]) => sum + (a.proc.exitCode === null ? (a.last?.[0] ?? 0) : 0), 0);

  function endAnchor(operationId: string): void {
    wslAnchors.get(operationId)?.proc.kill();
    wslAnchors.delete(operationId);
  }

  async function registerWsl(request: WslRegisterRequest): Promise<RegisterReply> {
    const fields = Object.keys(request).sort().join(",");
    const ids = [request.operationId, request.bootstrapId, request.gitInstallationId].every(isIdentifier);
    if (fields !== "bootstrapId,confirm,gitInstallationId,operationId" || !ids || request.confirm !== true) throw new RunnerRefusal("INVALID_REQUEST", "WSL register");
    const bound = contexts.get(request.bootstrapId);
    if (inactive.has(request.operationId) || bound?.kind !== "repositoryDiscovery" || (bound.owner ?? request.operationId) !== request.operationId) throw unknownTarget();
    const facts = wslBound.get(request.bootstrapId);
    if (!facts || issued.has(request.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "WSL register");
    bound.owner = request.operationId;
    const { version, gitIdentity, ...inst } = facts;
    // The native confirmation shows the distro, the Git path, and the version. Cancel is its default (contract §11).
    wslConfirmations.push({ distro: inst.distro, path: inst.git, version });
    if (inject.wslConfirm === "declined") return { result: "declined" };
    issued.add(request.gitInstallationId);
    gits.set(request.gitInstallationId, inst.git);
    wslGits.set(request.gitInstallationId, inst);
    wslSaved.set(inst.guid, { distro: inst.distro, git: inst.git, version, gitIdentity });
    return { result: "approved" };
  }

  async function start(call: GitCall, recorded: RecordedCall): Promise<GitExit> {
    checkCall(call);
    const target = resolveTarget(call.operationId, call.context);
    if (!target.wsl) {
      const env = environment(call);
      if (commandLineUnits(target.program, call.arguments) > WINDOWS_COMMAND_LINE_UNITS) throw new RunnerRefusal("INVALID_REQUEST", "command line");
      return execute(call, [target.program, ...call.arguments], target.cwd, env, recorded);
    }
    // Contract §11 "Process launch": `--no-lazy-fetch` stays first, and `-C` takes the Linux directory.
    const inst = target.wsl;
    const dir = wslParts(target.cwd);
    const index = call.transaction ? wslParts(call.transaction.indexFile)?.linux : "";
    if (!dir || index === undefined) throw new RunnerRefusal("INVALID_REQUEST", "WSL path");
    const args = wslWrapped(inst, call.operationId, call.environmentPolicy, index, inst.git, ["--no-lazy-fetch", "-C", dir.linux, ...call.arguments.slice(1)]);
    if (commandLineUnits(WSL_EXE, args) > WINDOWS_COMMAND_LINE_UNITS) throw new RunnerRefusal("INVALID_REQUEST", "command line");
    const anchor = call.environmentPolicy === "mutation" ? wslAnchor(call.operationId, inst) : null;
    const exit = await execute(call, [WSL_EXE, ...args], launchDirectory, wslEnvironment(), recorded);
    await inject.afterWslExit?.(call);
    // The anchor count after the exit of an execution process becomes `activeDescendants`.
    return anchor ? { ...exit, activeDescendants: (await anchor.ask())?.[0] ?? 0 } : exit;
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
      const target = resolveTarget(operationId, context);
      if (!target.wsl) {
        const replies = paths.map(identityOf);
        recorded.replies = replies;
        return replies;
      }
      const replies: WslIdentityReply[] = [];
      for (const path of paths) replies.push(await wslIdentity(operationId, target.wsl, path));
      recorded.replies = replies;
      return replies as unknown as IdentityReply[];
    },

    async lingeringCount(operationId, commonDirectory) {
      if (!isIdentifier(operationId) || !isChannelPath(commonDirectory)) throw new RunnerRefusal("INVALID_REQUEST", "lingering count");
      if (inactive.has(operationId)) throw unknownTarget();
      return live((r) => r.tag === commonDirectory).length + wslLingering(commonDirectory);
    },

    async register(request) {
      if (!("version" in request) && !("repositoryId" in request)) return registerWsl(request as unknown as WslRegisterRequest);
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
      wslBound.delete(request.bootstrapId);
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
      else {
        gits.delete(target.gitInstallationId);
        wslGits.delete(target.gitInstallationId);
      }
    },

    closeJob(operationId) {
      if (!isIdentifier(operationId)) throw new RunnerRefusal("INVALID_REQUEST", "closeJob");
      frames.push({ type: "closeJob", operationId });
      // A killed `wsl.exe` gives its command `SIGHUP`, and the wrapper and anchor traps end the scopes (contract §11).
      for (const proc of running.get(operationId) ?? []) proc.kill();
      for (const halt of halts.get(operationId) ?? []) halt();
      wslAnchors.delete(operationId);
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
      // `ended` closes the anchor stdin. The anchor then prints its count each second and exits at 0.
      if (endProcesses) endAnchor(operationId);
      else wslAnchors.get(operationId)?.close();
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
        const wslCount = wslLingering(request.commonDirectory);
        for (const [op] of [...wslAnchors].filter(([op]) => tags.get(op) === request.commonDirectory)) endAnchor(op);
        return { endedProcesses: end((r) => r.tag === request.commonDirectory) + wslCount };
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
        gitSelectedPath: request.gitSelectedPath,
      } as TrustRecord;
      trustStore.records.push(record);
      return { result: "approved", stored: true, record };
    },
  };

  // Proposed `wslDistros` request: a `repositoryDiscovery` context whose path is a WSL path.
  async function wslDistros(operationId: string, bootstrapId: string): Promise<WslDistrosReply> {
    const bound = contexts.get(bootstrapId);
    if (inactive.has(operationId) || bound?.kind !== "repositoryDiscovery" || (bound.owner ?? operationId) !== operationId || !wslParts(bound.path)) throw unknownTarget();
    bound.owner = operationId;
    const listed = listDistros(false);
    const running = inject.wslRunning ?? listDistros(true);
    if (listed === null || running === null) return { code: "WSL_UNAVAILABLE", reason: "wsl-missing" };
    const keys = registryKeys().filter((k) => listed.includes(k.name));
    const saved = keys.flatMap((k) => {
      const git = wslSaved.get(k.guid);
      return git ? [{ guid: k.guid, ...git }] : [];
    });
    return { path: bound.path, listed, running, keys, saved };
  }

  // Proposed `wslProbe` request (contract §11 "Git per distro"). It runs without the wrapper and without `--no-lazy-fetch`.
  async function wslProbe(call: WslProbeCall): Promise<GitExit> {
    const bound = contexts.get(call.bootstrapId);
    if (inactive.has(call.operationId) || bound?.kind !== "repositoryDiscovery" || (bound.owner ?? call.operationId) !== call.operationId) throw unknownTarget();
    const parts = wslParts(bound.path);
    const deadline = call.limits?.deadlineMs;
    if (!parts || parts.distro.toLowerCase() !== call.distro.toLowerCase() || !Number.isSafeInteger(deadline) || deadline < 1 || deadline > WSL_START_CAP_MS) {
      throw new RunnerRefusal("INVALID_REQUEST", "wslProbe");
    }
    bound.owner = call.operationId;
    wslBound.delete(call.bootstrapId);
    // The shell keeps its own copy of the forwarded stdout and parses it at the exit.
    const seen: Uint8Array[] = [];
    let seenBytes = 0;
    const stdout: Collector = {
      push(chunk) {
        const kept = chunk.slice(0, WSL_PROBE_RETAINED_BYTES - seenBytes);
        seen.push(kept);
        seenBytes += kept.length;
        call.stdout.push(chunk);
      },
      get bytes() {
        return call.stdout.bytes;
      },
      get records() {
        return call.stdout.records;
      },
      get limited() {
        return call.stdout.limited;
      },
    };
    const asCall = { ...call, stdout, context: { contextKind: "repositoryDiscovery", bootstrapId: call.bootstrapId }, arguments: [], environmentPolicy: "probe" } as unknown as GitCall;
    const seam = inject.wslProbe;
    let exit: GitExit;
    if (!seam) exit = await execute(asCall, [WSL_EXE, ...wslHead(call.distro), WSL_TEXTS.probe, "sh"], launchDirectory, wslEnvironment());
    else {
      for (let held = holding(startBarriers, asCall); held; held = holding(startBarriers, asCall)) await held.promise;
      call.signal.throwIfAborted();
      if (seam.stdout) stdout.push(new TextEncoder().encode(seam.stdout));
      if (seam.stderr) call.stderr.push(new TextEncoder().encode(seam.stderr));
      exit = seam.deadline ? { exitCode: null, activeDescendants: 0, deadline: "deadline" } : { exitCode: seam.exitCode ?? 0, activeDescendants: 0 };
    }
    const facts = exit.exitCode === 0 && !exit.deadline ? bindProbe(call.distro, new TextDecoder().decode(Buffer.concat(seen))) : null;
    if (facts) wslBound.set(call.bootstrapId, facts);
    return exit;
  }

  return {
    ...runner,
    wslDistros,
    wslProbe,
    inject,
    frames,
    markers,
    trustStore,
    recordsDirectory,
    // Every `run` and identity request in arrival order.
    calls,
    identityCalls,
    // The WSL Git confirmations in order, the approved Git of each distro GUID, and the WSL identity replies.
    wslConfirmations,
    wslSaved,
    wslIdentityLog,
    // A simulated service failure: the shell closes every operation Job outside the lingering set (contract §6).
    failService(): void {
      for (const operationId of running.keys()) if (!tags.has(operationId) || !inactive.has(operationId)) runner.closeJob(operationId);
    },
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
      wslAnchors.clear();
      for (const operationId of wslUnits.keys()) endWslScopes(operationId);
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
