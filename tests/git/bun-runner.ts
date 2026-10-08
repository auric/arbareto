// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A test double of the shell end of `src/git-service/git-runner.ts`. It runs real Git through `Bun.spawn` argument arrays.
// It does not reproduce the shell console flags or Jobs. T024 and T027 cover them.
// T206 adds the contract §11 WSL process requests. T212 takes their types from the zod frames of `src/contracts/channel.ts`.

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import policyFile from "../../src/contracts/git-environment.json";
import wslProcess from "../../src/contracts/wsl-process.json";
import { GIT_PROCESS_DEADLINE_MS, NATIVE_CHUNK_BYTES, WINDOWS_COMMAND_LINE_UNITS } from "../../src/contracts/limits";
import { isIdentifier } from "../../src/contracts/operations";
import type { IdentityReply as IdentityReplyFrame, RegisterWslCall, WslDistrosResult, WslSavedGit as WslSavedGitFrame } from "../../src/contracts/channel";
import {
  checkCall,
  checkContext,
  checkFileFacts,
  checkIdentityPaths,
  checkRegister,
  checkRelease,
  checkResolveGit,
  checkStarted,
  checkTrust,
  checkWslFiles,
  commandLineUnits,
  type Collector,
  createDiagnosticCounter,
  type FileFact,
  type FileFactsRequest,
  type IndexedFileFactsRequest,
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
  type WalkStop,
  type WslDistrosCall,
  type WslFileResult,
  type WslFilesCall,
  type WslIndexResult,
  type WslProbeRun,
} from "../../src/git-service/git-runner";
import { printOrigin } from "../origin";
import { isWindowsProgram } from "../../src/contracts/wsl-route";
import {
  FACTS_TEXT,
  factsInput,
  IDENTITY_TEXT,
  listDistros,
  OWN_SCOPE_OPERATIONS,
  parseFactRecords,
  parseIndexedFacts,
  registryKeys,
  WSL_EXE,
  WSL_FILES_TEXT,
  wslExec,
  wslFilesInput,
  wslFilesResults,
  type FactEntry,
  type FactRecord,
} from "../wsl/wsl-host";
import type { InboundPipe } from "./win32";

// The host module of the double. The generic harness loads it only through this path (tests/git/portable-imports.test.ts).
export const HOST_SCRIPT = join(import.meta.dir, process.platform === "win32" ? "win32.ts" : "linux.ts");
const { closePipe, createInboundPipe, peekPipe, processCreationTime, readFileFacts, readIdentity, readPipe, terminateRecorded } = require(HOST_SCRIPT) as typeof import("./win32");

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
  // Contract §11 "Git per distro": the approved `/usr/bin/sha256sum` target of the `wslFiles` digests.
  sha256sum: string;
}

// The native settings record of one approved WSL Git (contract §11 "Git per distro").
export type WslSavedGit = WslSavedGitFrame;

// The facts that the shell parsed from one successful probe of a `repositoryDiscovery` context, with the context identity (gaps.md W1).
type WslBound = WslInstallation & { version: string; gitIdentity: string; identity: WslIdentityReply };

// A WSL identity reply (contract §11 "Paths and file access"). It holds no device number.
export type WslIdentityReply = Exclude<IdentityReplyFrame, { volumeSerial: string }>;

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
const WSL_PROBED = ["git", "systemd-run", "systemctl", "setsid", "stat", "env", "perl", "sha256sum"];
const WSL_PROBE_FACTS = ["pathenv", "osid", "version", "gitfs", "gitfile", "scope", "selfs", "selino", "selstat"];
const WSL_FLOOR = [2n, 55n, 0n];
// gaps.md W3 and W4: the fixed programs of the identity and `fileFacts` probes.
const WSL_STAT = "/usr/bin/stat";
const WSL_PERL = "/usr/bin/perl";
const MAX_INODE = 0xffff_ffff_ffff_ffffn;
// The three Git-resolved roots of a registered repository, in the order of the Perl texts.
const ROOT_ORDER = ["worktreeRoot", "gitDirectory", "commonDirectory"] as const;
type Roots = Record<(typeof ROOT_ORDER)[number], string>;

// Mirrors `src-tauri/src/wsl.rs` `bind_probe`: strict UTF-8 lines, each line kind at most once, and every §11 rule. Output that fails a rule binds nothing.
function bindProbe(distro: string, bytes: Uint8Array): WslBound | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text.endsWith("\n")) return null;
  const facts = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const [kind = "", ...rest] = line.split(" ");
    let key: string | undefined;
    let value = rest.join(" ");
    if (kind === "path" || kind === "magic") {
      key = WSL_PROBED.includes(rest[0] ?? "") && rest.length > 1 ? `${kind} ${rest[0]}` : undefined;
      value = rest.slice(1).join(" ");
    } else if (kind === "absent") key = WSL_PROBED.includes(value) ? `absent ${value}` : undefined;
    else if (WSL_PROBE_FACTS.includes(kind) && rest.length > 0) key = kind;
    if (key === undefined || facts.has(key)) return null;
    facts.set(key, value);
  }
  // The probe prints `absent` only for a program without `path` and `magic` lines.
  if (WSL_PROBED.some((name) => facts.has(`absent ${name}`) && (facts.has(`path ${name}`) || facts.has(`magic ${name}`)))) return null;
  const program = (name: string) => {
    const path = facts.get(`path ${name}`);
    return path?.startsWith("/") && facts.get(`magic ${name}`) === "-" && !isWindowsProgram(path, false) ? path : undefined;
  };
  const [git, systemdRun, systemctl, setsid, stat, env, perl, sha256sum] = WSL_PROBED.map(program);
  // Contract §11 "Git per distro": the floor, and no `.windows.` version.
  const version = /^git version ((\d+)\.(\d+)\.(\d+)\S*)$/.exec(facts.get("version") ?? "");
  const parts = version?.slice(2, 5).map(BigInt) ?? [];
  const differs = WSL_FLOOR.findIndex((min, i) => parts[i] !== min);
  const floor = version !== null && !version[1]!.includes(".windows.") && (differs < 0 || parts[differs]! > WSL_FLOOR[differs]!);
  const fileSystem = /^ef53:([0-9a-f]+)$/.exec(facts.get("gitfs") ?? "")?.[1];
  const gitfile = facts.get("gitfile") ?? "";
  const guid = registryKeys().find((k) => k.name === distro && k.version === 2)?.guid;
  if (!git || !systemdRun || !systemctl || !setsid || !stat || !env || !perl || !sha256sum || facts.get("scope") !== "0" || !floor || !guid) return null;
  if (!fileSystem || /^0+$/.test(fileSystem) || !/^\d+:\d+:\d+$/.test(gitfile)) return null;
  // gaps.md W1: the context identity binds with the Git facts, or nothing binds.
  const identity = facts.get("selstat") === "ok" ? classifyIdentity(guid, facts.get("selino") ?? "", facts.get("selfs") ?? "") : null;
  if (identity === null || "code" in identity) return null;
  return { distro, guid, git, systemdRun, systemctl, setsid, sha256sum, version: version[1]!, gitIdentity: `${fileSystem}:${gitfile}`, identity };
}

// Mirrors `src-tauri/src/wsl.rs` `classify`: only type `ef53` with a nonzero ID, in the canonical form of gaps.md W2.
function classifyIdentity(guid: string, inode: string, fileSystem: string): WslIdentityReply {
  const fs = /^([0-9a-f]+):([0-9a-f]+)$/.exec(fileSystem);
  if (!fs) return { code: "UNSUPPORTED_REPOSITORY" };
  if (fs[1] === "1021997") return { code: "UNSUPPORTED_REPOSITORY", reason: "mixed-location" };
  if (fs[1] !== "ef53" || /^0+$/.test(fs[2]!)) return { code: "UNSUPPORTED_REPOSITORY", reason: "no-fs-uuid" };
  if (!/^[1-9a-f][0-9a-f]{0,15}$/.test(fs[2]!) || !/^[1-9][0-9]{0,19}$/.test(inode) || BigInt(inode) > MAX_INODE) return { code: "UNSUPPORTED_REPOSITORY" };
  return { distroGuid: guid, fileSystemId: fs[2]!, inode };
}

// gaps.md W4: one line per path of the identity probe. `id <inode> <type>:<ID>`, or the Perl `stat` result `absent` or `fail`.
function identityLine(guid: string, line: string | undefined): WslIdentityReply {
  if (line === "absent") return { code: "UNSUPPORTED_REPOSITORY", reason: "absent" };
  const id = /^id (\S+) (\S+)$/.exec(line ?? "");
  return id ? classifyIdentity(guid, id[1]!, id[2]!) : { code: "UNSUPPORTED_REPOSITORY" };
}

// Mirrors the `src-tauri/src/wsl.rs` record checks of gaps.md W3. A failed check gives every entry `error` 0 `other-error`.
const FILE_BOUND = 1_048_576n;
const TOTAL_BOUND = 8_388_608n;
const LINK_BYTES = 4_095;
function mapFacts(records: FactRecord[] | null, entries: readonly FactEntry[], digest: boolean): FileFact[] {
  return (records && checkFacts(records, entries, digest)) ?? entries.map(() => ({ kind: "error", component: 0, code: "other-error" }));
}

// Null: a record breaks a check.
function checkFacts(records: FactRecord[], entries: readonly FactEntry[], digest: boolean): FileFact[] | null {
  if (records.length !== entries.length) return null;
  let total = 0n;
  const facts: FileFact[] = [];
  for (const [i, record] of records.entries()) {
    const length = entries[i]!.path.length;
    if (record.kind === "absent" || record.kind === "other") facts.push({ kind: record.kind });
    else if (record.kind === "directory") facts.push({ kind: "directory", executable: record.executable });
    else if (record.kind === "error") {
      if (record.component > length || !["access-denied", "io-error", "other-error"].includes(record.code)) return null;
      facts.push({ kind: "error", component: record.component, code: record.code as "access-denied" });
    } else if (record.kind === "link") {
      if (record.component < 1 || record.component > length || record.target.length < 1 || record.target.length > LINK_BYTES) return null;
      let target: string | null = null;
      try {
        target = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(record.target);
      } catch {}
      facts.push(target === null ? { kind: "link", component: record.component, tag: "other" } : { kind: "link", component: record.component, tag: "symlink", target, relative: !target.startsWith("/") });
    } else {
      const lastWrite = record.mtime * 1_000_000_000n;
      if (record.size > BigInt(Number.MAX_SAFE_INTEGER) || BigInt.asIntN(64, lastWrite) !== lastWrite) return null;
      const base = { kind: "file" as const, size: Number(record.size), lastWrite: String(lastWrite), ownerExecute: record.ownerExecute, executable: record.executable };
      if (record.content === "none") {
        if (digest) return null;
        facts.push(base);
      } else if (!digest) return null;
      else if (typeof record.content === "string") facts.push({ ...base, bound: record.content });
      else {
        total += BigInt(record.content.length);
        if (BigInt(record.content.length) > FILE_BOUND || total > TOTAL_BOUND) return null;
        facts.push({ ...base, digest: new Bun.CryptoHasher("sha256").update(record.content).digest("hex") });
      }
    }
  }
  return facts;
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
  // Milliseconds from `at` to the resolved exit. A refused call has none.
  durationMs?: number;
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
  const contexts = new Map<string, { kind: "gitProbe" | "repositoryDiscovery"; path: string; owner?: string; identity?: IdentityReply }>();
  const gits = new Map<string, string>();
  const repositories = new Map<string, { worktreeRoot: string; gitDirectory: string; commonDirectory: string; gitInstallationId: string }>();
  const issued = new Set<string>();
  const inactive = new Set<string>();
  const running = new Map<string, Set<Subprocess>>();
  const records = new Map<string, ProcessRecord>();
  const tags = new Map<string, string>();
  const markers = new Map<string, MutationStarted>();
  const frames: Record<string, unknown>[] = [];
  const calls: RecordedCall[] = [];
  const identityCalls: { at: number; operationId: string; paths: string[]; replies: unknown[] }[] = [];
  // Each answered `fileFacts` request, with its entries and the file data bytes that the walk read for each entry. A refused request is not recorded.
  const fileFactCalls: {
    operationId: string;
    repositoryId: string;
    digest: boolean;
    files: { root: FileFactsRequest["files"][number]["root"]; path: string[] }[];
    facts: FileFact[];
    bytesRead: number[];
    // The raw NTSTATUS of each `error` fact on Windows (`win32.ts`). Absent on Linux and for WSL.
    statuses?: (number | null)[];
  }[] = [];
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
    // WSL seams (T207, T209): a probe result, a running list, identity probe results by UNC path, and the WSL Git confirmation result.
    // A `wslStat` entry is the `stat %i` and `stat -f %t:%i` texts of the identity probe, or the Perl `stat` result `absent` (gaps.md W4).
    wslProbe: null as WslProbeSeam | null,
    wslRunning: null as string[] | null,
    wslStat: new Map<string, { inode: string; fileSystem: string } | "absent">(),
    wslConfirm: "approved" as "approved" | "declined",
    // A test-injected deadline. A shorter value than the request limit ends the process as the shell deadline does.
    deadlineMs: null as number | null,
    // Runs after each WSL process exits, before its exit reply.
    afterWslExit: null as ((call: GitCall) => Promise<void>) | null,
    // Each `identity` and `fileFacts` walk waits for this promise before it reads (contract §6 "Walks").
    holdWalk: null as (() => Promise<void>) | null,
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

  const identityOfWindows = (path: string): IdentityReply => inject.identities.get(path) ?? readIdentity(path, inject.fileIds.get(path));

  // Contract §6 "Walks": the walk deadline and an abort end the hold without a value. The read stays synchronous, as in the shell, so no stop interrupts it.
  async function walk<T>(signal: AbortSignal, read: () => T | Promise<T>): Promise<T | WalkStop> {
    if (signal.aborted) return { stop: "canceled" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    const stopped = new Promise<WalkStop>((resolve) => {
      // Contract §5 "Walk deadline": it equals the other Git process deadline.
      timer = setTimeout(() => resolve({ stop: "deadline" }), inject.deadlineMs ?? GIT_PROCESS_DEADLINE_MS);
      abort = () => resolve({ stop: "canceled" });
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const stop = await Promise.race([(inject.holdWalk?.() ?? Promise.resolve()).then(() => null), stopped]);
      return stop ?? (await read());
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

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

  // src-tauri/src/bootstrap.rs `revalidate`: the selected path must read as the identity of context creation.
  // Otherwise the shell destroys the `repositoryDiscovery` context and refuses with `UNKNOWN_TARGET`.
  function revalidate(bootstrapId: string): void {
    const now = readIdentity(contexts.get(bootstrapId)!.path);
    if (!("code" in now) && sameIdentity(now, contexts.get(bootstrapId)!.identity)) return;
    contexts.delete(bootstrapId);
    throw unknownTarget();
  }

  // Contract §6 "Context rules": the first `operationId` of a `bootstrapId` owns it.
  // A WSL Git target carries its installation. Its `cwd` is the UNC directory that becomes the Linux `-C` directory.
  function resolveTarget(operationId: string, context: ProcessContext): { program: string; cwd: string; wsl?: WslInstallation } {
    if (inactive.has(operationId)) throw unknownTarget();
    if (context.contextKind === "registeredOperation") {
      const program = gits.get(context.gitInstallationId);
      const repository = repositories.get(context.repositoryId);
      if (!program || !repository) throw unknownTarget();
      const wsl = wslGits.get(context.gitInstallationId);
      // Contract §11: a WSL repository never runs Git for Windows.
      if (!wsl && wslParts(repository.worktreeRoot) !== null) throw new RunnerRefusal("INVALID_REQUEST", "Windows Git in a WSL repository");
      return { program, cwd: repository.worktreeRoot, wsl };
    }
    const bound = contexts.get(context.bootstrapId);
    if (!bound || bound.kind !== context.contextKind || (bound.owner ?? operationId) !== operationId) throw unknownTarget();
    bound.owner = operationId;
    if (context.contextKind === "gitProbe") return { program: bound.path, cwd: launchDirectory };
    const program = gits.get(context.gitInstallationId);
    if (!program) throw unknownTarget();
    // gaps.md W1: a WSL context runs only the WSL Git of its bound distro, and a Windows context only a Windows Git.
    const wsl = wslGits.get(context.gitInstallationId);
    const parts = wslParts(bound.path);
    if ((parts === null) !== (wsl === undefined) || (wsl && wslBound.get(context.bootstrapId)?.guid !== wsl.guid)) throw new RunnerRefusal("INVALID_REQUEST", "WSL context");
    return { program, cwd: bound.path, wsl };
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
    OWN_SCOPE_OPERATIONS.add(operationId);
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

  // gaps.md W4: one identity probe per request through the wrapper in `probe` mode, with one output line per path.
  // An injected path takes its seam result. A path outside the distro of the installation gets the refusal alone.
  function wslIdentities(operationId: string, inst: WslInstallation, paths: readonly string[]): WslIdentityReply[] {
    const linux = paths.map((path) => {
      const parts = wslParts(path);
      return !inject.wslStat.has(path) && parts && parts.distro.toLowerCase() === inst.distro.toLowerCase() ? parts.linux : null;
    });
    const probed = linux.filter((p): p is string => p !== null);
    let lines: string[] = [];
    if (probed.length > 0) {
      const result = wslExec(wslWrapped(inst, operationId, "probe", "", "/bin/sh", ["-c", IDENTITY_TEXT, "sh", WSL_STAT, WSL_PERL, ...probed]), { env: wslEnvironment() });
      lines = result.exitCode === 0 && result.stdout.endsWith("\n") ? result.stdout.slice(0, -1).split("\n") : [];
      if (lines.length !== probed.length) lines = [];
    }
    let next = 0;
    return paths.map((path, i) => {
      const injected = inject.wslStat.get(path);
      let reply: WslIdentityReply;
      if (injected === "absent") reply = { code: "UNSUPPORTED_REPOSITORY", reason: "absent" };
      else if (injected) reply = classifyIdentity(inst.guid, injected.inode.trimEnd(), injected.fileSystem.trimEnd());
      else reply = linux[i] === null ? { code: "UNSUPPORTED_REPOSITORY" } : identityLine(inst.guid, lines[next++]);
      wslIdentityLog.push({ path, reply });
      return reply;
    });
  }

  // The Linux forms of the three roots, or null for a root outside the distro of the installation.
  function linuxRoots(inst: WslInstallation, roots: Roots): string[] | null {
    const linux = ROOT_ORDER.map((name) => wslParts(roots[name]));
    return linux.some((parts) => !parts || parts.distro.toLowerCase() !== inst.distro.toLowerCase()) ? null : linux.map((parts) => parts!.linux);
  }

  // gaps.md W3: the fixed Perl probe through the wrapper in `probe` mode. The three roots go as Linux paths.
  // With `index`, the probe also gets the sha256sum path and the shared hash, and gives the index result (contract §6 "Index digest in a read").
  function wslFileFacts(operationId: string, inst: WslInstallation, roots: Roots, digest: boolean, files: FileFactsRequest["files"], index?: { sharedIndex?: string }): { facts: FileFact[]; index?: WslIndexResult } {
    const entries: FactEntry[] = files.map(({ root, path }) => ({ root: ROOT_ORDER.indexOf(root) as 0 | 1 | 2, path: [...path] }));
    const failed = { kind: "error", component: 0, code: "other-error" } as const;
    const linux = linuxRoots(inst, roots);
    if (linux === null) return { facts: mapFacts(null, entries, digest), ...(index ? { index: failed } : {}) };
    const extra = index ? [inst.sha256sum, ...(index.sharedIndex === undefined ? [] : [index.sharedIndex])] : [];
    const args = ["-e", FACTS_TEXT, "--", digest ? "1" : "0", ...linux, ...extra];
    const result = wslExec(wslWrapped(inst, operationId, "probe", "", WSL_PERL, args), { env: wslEnvironment(), input: factsInput(entries) });
    if (!index) return { facts: mapFacts(result.exitCode === 0 ? parseFactRecords(result.bytes) : null, entries, digest) };
    const parsed = result.exitCode === 0 ? parseIndexedFacts(result.bytes, entries.length, index.sharedIndex !== undefined) : null;
    // A failed fact check fails the index too, as in the shell.
    const facts = parsed === null ? null : checkFacts(parsed.records, entries, digest);
    return facts === null ? { facts: mapFacts(null, entries, digest), index: failed } : { facts, index: parsed!.index };
  }

  // Contract §6 "WSL file work": the fixed Perl text through the wrapper in `probe` mode, with the same records as the shell.
  function wslFilesWalk(operationId: string, inst: WslInstallation, roots: Roots, request: WslFilesCall): WslFileResult[] {
    const linux = linuxRoots(inst, roots);
    if (linux === null) return wslFilesResults(null, new Uint8Array(), request);
    const args = ["-e", WSL_FILES_TEXT, "--", request.mode, ...linux, inst.git, inst.sha256sum];
    const result = wslExec(wslWrapped(inst, operationId, "probe", "", WSL_PERL, args), { env: wslEnvironment(), input: wslFilesInput(request) });
    return wslFilesResults(result.exitCode, result.bytes, request);
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
    // Bun 1.4.2 on Windows gives a bigint here, although its type says number.
    if (usage && recorded) recorded.cpuMicros = Number(usage.cpuTime.total);
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

  async function registerWsl(request: RegisterWslCall): Promise<RegisterReply> {
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
      if (call.context.contextKind === "repositoryDiscovery") revalidate(call.context.bootstrapId);
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
        recorded.durationMs = performance.now() - recorded.at;
        return recorded.exit;
      } catch (error) {
        recorded.refused = error instanceof RunnerRefusal ? error.code : error instanceof Error ? error.name : "unknown";
        throw error;
      }
    },

    // A refused or stopped request keeps an empty `replies` list.
    async identities(operationId, context, paths, signal) {
      const recorded = { at: performance.now(), operationId: text(operationId), paths: Array.isArray(paths) ? [...paths] : [], replies: [] as unknown[] };
      identityCalls.push(recorded);
      if (!isIdentifier(operationId) || !checkContext(context)) throw new RunnerRefusal("INVALID_REQUEST", "identity context");
      checkIdentityPaths(paths);
      const target = resolveTarget(operationId, context);
      return walk(signal, () => {
        if (!target.wsl) {
          const replies = paths.map(identityOfWindows);
          recorded.replies = replies;
          return replies;
        }
        const replies = wslIdentities(operationId, target.wsl, paths);
        recorded.replies = replies;
        return replies;
      });
    },

    // src-tauri/src/process_requests.rs `file_facts`: the fields, the target, then the WSL roots. The walk is synchronous, as in the shell.
    async fileFacts(request, signal) {
      checkFileFacts(request);
      const { operationId, contextKind, gitInstallationId, repositoryId } = request;
      resolveTarget(operationId, { contextKind, gitInstallationId, repositoryId });
      const { gitInstallationId: _git, ...roots } = repositories.get(repositoryId)!;
      const files = request.files.map(({ root, path }) => ({ root, path: [...path] }));
      // gaps.md W3: a WSL repository gets the Perl probe of its installation. The double records no read bytes for it.
      const wsl = wslGits.get(gitInstallationId);
      return walk(signal, () => {
        if (wsl) {
          const { facts } = wslFileFacts(operationId, wsl, roots, request.digest, request.files);
          fileFactCalls.push({ operationId, repositoryId, digest: request.digest, files, facts, bytesRead: facts.map(() => 0) });
          return facts;
        }
        const { facts, bytesRead, statuses } = readFileFacts(roots, request.digest, request.files);
        fileFactCalls.push({ operationId, repositoryId, digest: request.digest, files, facts, bytesRead, statuses });
        return facts;
      });
    },

    async lingeringCount(operationId, commonDirectory) {
      if (!isIdentifier(operationId) || !isChannelPath(commonDirectory)) throw new RunnerRefusal("INVALID_REQUEST", "lingering count");
      if (inactive.has(operationId)) throw unknownTarget();
      return live((r) => r.tag === commonDirectory).length + wslLingering(commonDirectory);
    },

    async register(request) {
      if (!("version" in request) && !("repositoryId" in request)) return registerWsl(request);
      const confirm = checkRegister(request) === "confirm";
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
      const { worktreeRoot, gitDirectory, commonDirectory, gitInstallationId } = request;
      const parts = wslParts(bound.path);
      if (parts) {
        // gaps.md W1: the three paths lie in the bound distro, the Git is the WSL Git of the bound GUID, and the context identity reads again.
        const facts = wslBound.get(request.bootstrapId);
        const wsl = wslGits.get(gitInstallationId);
        const prefix = `\\\\wsl.localhost\\${facts?.distro}\\`;
        if (!facts || !wsl || wsl.guid !== facts.guid || ![worktreeRoot, gitDirectory, commonDirectory].every((p) => p.startsWith(prefix))) throw new RunnerRefusal("INVALID_REQUEST", "WSL register");
        const [now] = wslIdentities(request.operationId, wsl, [bound.path]);
        if (!sameIdentity(now, facts.identity)) {
          contexts.delete(request.bootstrapId);
          wslBound.delete(request.bootstrapId);
          throw unknownTarget();
        }
      }
      contexts.delete(request.bootstrapId);
      wslBound.delete(request.bootstrapId);
      issued.add(request.repositoryId);
      repositories.set(request.repositoryId, { worktreeRoot, gitDirectory, commonDirectory, gitInstallationId });
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
      frames.push({ type: "release", ...target });
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
      // gaps.md W2: a WSL path reads through the identity probe of the registered repository whose stored paths hold it. Otherwise it is unreadable.
      const identityOf = (path: string): IdentityReply => {
        if (!WSL_PREFIX.test(path)) return identityOfWindows(path);
        const repository = [...repositories.values()].find((r) => [r.worktreeRoot, r.gitDirectory, r.commonDirectory].includes(path));
        const wsl = repository && wslGits.get(repository.gitInstallationId);
        return wsl ? wslIdentities(crypto.randomUUID(), wsl, [path])[0]! : { code: "UNSUPPORTED_REPOSITORY" };
      };
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

  // Contract §6 `wslDistros`: any live `repositoryDiscovery` context of the operation. Only a path with a WSL prefix runs the list calls.
  // src-tauri/src/process_requests.rs `file_facts` with `index`: only a WSL repository takes it.
  async function indexedFileFacts(request: IndexedFileFactsRequest, signal: AbortSignal): Promise<{ facts: FileFact[]; index: WslIndexResult } | WalkStop> {
    checkFileFacts(request, true);
    const { operationId, contextKind, gitInstallationId, repositoryId } = request;
    resolveTarget(operationId, { contextKind, gitInstallationId, repositoryId });
    const wsl = wslGits.get(gitInstallationId);
    if (!wsl) throw new RunnerRefusal("INVALID_REQUEST", "index outside WSL");
    const { gitInstallationId: _git, ...roots } = repositories.get(repositoryId)!;
    return walk(signal, () => {
      const { facts, index } = wslFileFacts(operationId, wsl, roots, request.digest, request.files, request.index);
      return { facts, index: index! };
    });
  }

  // src-tauri/src/process_requests.rs `wsl_files`: the fields, the target, then the WSL refusal.
  async function wslFiles(request: WslFilesCall, signal: AbortSignal): Promise<WslFileResult[] | WalkStop> {
    checkWslFiles(request);
    const { operationId, contextKind, gitInstallationId, repositoryId } = request;
    resolveTarget(operationId, { contextKind, gitInstallationId, repositoryId });
    const wsl = wslGits.get(gitInstallationId);
    if (!wsl) throw new RunnerRefusal("INVALID_REQUEST", "wslFiles outside WSL");
    const { gitInstallationId: _git, ...roots } = repositories.get(repositoryId)!;
    return walk(signal, () => wslFilesWalk(operationId, wsl, roots, request));
  }

  async function wslDistros({ operationId, bootstrapId }: WslDistrosCall): Promise<WslDistrosResult> {
    const bound = contexts.get(bootstrapId);
    if (!isIdentifier(operationId) || !isIdentifier(bootstrapId)) throw new RunnerRefusal("INVALID_REQUEST", "wslDistros");
    if (inactive.has(operationId) || bound?.kind !== "repositoryDiscovery" || (bound.owner ?? operationId) !== operationId) throw unknownTarget();
    bound.owner = operationId;
    const path = bound.path;
    if (!WSL_PREFIX.test(path)) return { path };
    const listed = listDistros(false);
    const running = inject.wslRunning ?? listDistros(true);
    if (listed === null || running === null) return { path, code: "WSL_UNAVAILABLE", reason: "wsl-missing" };
    const keys = registryKeys().filter((k) => listed.includes(k.name));
    const saved = keys.flatMap((k) => {
      const git = wslSaved.get(k.guid);
      return git ? [{ guid: k.guid, ...git }] : [];
    });
    return { path, wslExecutable: WSL_EXE, listed, running, keys, saved };
  }

  const wslProbing = new Set<string>();
  // Contract §6 `wslProbe` (contract §11 "Git per distro"). It runs without the wrapper and without `--no-lazy-fetch`.
  async function wslProbe(call: WslProbeRun): Promise<GitExit> {
    const bound = contexts.get(call.bootstrapId);
    if (inactive.has(call.operationId) || bound?.kind !== "repositoryDiscovery" || (bound.owner ?? call.operationId) !== call.operationId) throw unknownTarget();
    const parts = wslParts(bound.path);
    const deadline = call.limits?.deadlineMs;
    if (!parts || parts.distro.toLowerCase() !== call.distro.toLowerCase() || !Number.isSafeInteger(deadline) || deadline < 1 || deadline > WSL_START_CAP_MS) {
      throw new RunnerRefusal("INVALID_REQUEST", "wslProbe");
    }
    // gaps.md W1: a context binds once, because a rebind would defeat the revalidation at `register`.
    // The shell reserves the bind when the probe arrives, so a second probe in flight cannot bind again.
    if (wslBound.has(call.bootstrapId) || wslProbing.has(call.bootstrapId)) throw new RunnerRefusal("INVALID_REQUEST", "bound WSL context");
    bound.owner = call.operationId;
    wslProbing.add(call.bootstrapId);
    try {
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
      // The probe takes the Linux path of the context (gaps.md W1).
      if (!seam) exit = await execute(asCall, [WSL_EXE, ...wslHead(call.distro), WSL_TEXTS.probe, "sh", parts.linux], launchDirectory, wslEnvironment());
      else {
        for (let held = holding(startBarriers, asCall); held; held = holding(startBarriers, asCall)) await held.promise;
        call.signal.throwIfAborted();
        if (seam.stdout) stdout.push(new TextEncoder().encode(seam.stdout));
        if (seam.stderr) call.stderr.push(new TextEncoder().encode(seam.stderr));
        exit = seam.deadline ? { exitCode: null, activeDescendants: 0, deadline: "deadline" } : { exitCode: seam.exitCode ?? 0, activeDescendants: 0 };
      }
      const facts = exit.exitCode === 0 && !exit.deadline ? bindProbe(call.distro, Buffer.concat(seen)) : null;
      if (facts) wslBound.set(call.bootstrapId, facts);
      return exit;
    } finally {
      wslProbing.delete(call.bootstrapId);
    }
  }

  return {
    ...runner,
    wslDistros,
    wslProbe,
    wslFiles,
    indexedFileFacts,
    inject,
    frames,
    markers,
    trustStore,
    recordsDirectory,
    // Every `run` and identity request in arrival order.
    calls,
    identityCalls,
    fileFactCalls,
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
      // gaps.md W1: a WSL path binds no identity and starts no process at creation.
      contexts.set(bootstrapId, { kind, path, ...(kind === "repositoryDiscovery" && !WSL_PREFIX.test(path) ? { identity: readIdentity(path) } : {}) });
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
