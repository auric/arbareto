// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A test double of the shell end of `src/git-service/git-runner.ts`. It runs real Git through `Bun.spawn` argument arrays.
// It does not reproduce the shell console flags or Jobs. T024 and T027 cover them.
// T206 adds the contract §11 WSL process requests. T212 takes their types from the zod frames of `src/contracts/channel.ts`.

import { appendFileSync, linkSync, lstatSync, mkdirSync, opendirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Subprocess } from "bun";
import policyFile from "../../src/contracts/git-environment.json";
import wslProcess from "../../src/contracts/wsl-process.json";
import { GIT_PROCESS_DEADLINE_MS, NATIVE_CHUNK_BYTES, WINDOWS_COMMAND_LINE_UNITS } from "../../src/contracts/limits";
import { NATIVE } from "../../src/contracts/native-path";
import { isIdentifier } from "../../src/contracts/operations";
import type { IdentityReply as IdentityReplyFrame, RegisterWslCall, WslDistrosResult, WslSavedGit as WslSavedGitFrame } from "../../src/contracts/channel";
import {
  checkCall,
  checkContext,
  checkFileFacts,
  checkIdentityPaths,
  checkPageant,
  checkRegister,
  checkRelease,
  checkResolveGit,
  checkStarted,
  checkSyncRequest,
  checkTrust,
  checkWslFiles,
  commandLineUnits,
  type Collector,
  createDiagnosticCounter,
  type DeleteEntryReply,
  type DeleteFolderReply,
  type DestinationFactsReply,
  type FileAppendReply,
  type FileDeleteExpected,
  type FileDeleteReply,
  type FileReplaceReply,
  type FileReplaceRequest,
  type ShadowReply,
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
  type PageantReply,
  type ProcessContext,
  type RefusedCode,
  type RegisterReply,
  type SyncRunner,
  type TerminalReply,
  type TrustRecord,
  type TrustRequest,
  type WalkStop,
  type WslDistrosCall,
  type WslFileResult,
  type WslFilesCall,
  type WslIndexResult,
  type WorktreeAddFactsReply,
  type WslProbeRun,
  shadowArrayFits,
} from "../../src/git-service/git-runner";
import type { FILE_FACT_ERRORS } from "../../src/contracts/channel";
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

// Feature 005 contract Δ6: the codes of a file that exists but cannot be opened or read.
type FileFactError = (typeof FILE_FACT_ERRORS)[number];

// The host module of the double. The generic harness loads it only through this path (tests/git/portable-imports.test.ts).
export const HOST_SCRIPT = join(import.meta.dir, process.platform === "win32" ? "win32.ts" : "linux.ts");
const { closePipe, createInboundPipe, ownTree, peekPipe, processCreationTime, readFileFacts, readIdentity, readPipe, terminateRecorded } = require(HOST_SCRIPT) as typeof import("./win32");

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

// The handshake records. A test can put a version 1 record here (feature 004 plan.md O-5).
export interface TrustStore {
  records: TrustRecord[];
}

// Pass one store to a second runner to simulate a new service session.
export const createTrustStore = (): TrustStore => ({ records: [] });

export interface BunRunnerOptions {
  git: string;
  // An owned directory for the `gitProbe` launch directory, the process records, and the recovery folder.
  directory: string;
  // The service environment. Each policy of `src/contracts/git-environment.json` starts from it.
  environment: Record<string, string>;
  trustStore?: TrustStore;
  // Fixture isolation for WSL processes only: the Linux path `<home>/.gitconfig` of the owned global configuration.
  // The double forwards it, `GIT_CONFIG_NOSYSTEM=1`, and `XDG_CONFIG_HOME=<home>/.config` through `WSLENV`. The product shell forwards nothing (T205).
  // `wsl.exe` sets `HOME` from the distro user and ignores a `HOME` in `WSLENV`, so `XDG_CONFIG_HOME` replaces the default `core.excludesFile` and `core.attributesFile` (git-config(1)).
  wslGlobalConfig?: string;
  // Test only: the Linux `LOCPATH` of WSL processes, forwarded through `WSLENV` as `wslGlobalConfig` is. The product shell forwards nothing.
  wslLocalePath?: string;
}

// ---- Contract §11 process requests. The shell side is `src-tauri/src/wsl.rs`. ----

const WSL_TEXTS = { wrapper: wslProcess.wrapper.join("\n"), anchor: wslProcess.anchor.join("\n"), probe: wslProcess.probe.join("\n"), matchingProbe: wslProcess.matchingProbe.join("\n") };
// Contract §5: a WSL distro start probe has at most 60 seconds.
const WSL_START_CAP_MS = 60_000;
const WSL_PREFIX = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\/]+)(?:[\\/](.*))?$/i;

export type WslMode = "probe" | "read" | "mutation" | "network" | "search" | "remote" | "integrate" | "mergetool";

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
  // The probe fact `noexpand 0`. The wrapper then gets `noexp` 1 (contract §11 "Process launch").
  noexpand: boolean;
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
const WSL_PROBE_FACTS = ["pathenv", "osid", "version", "gitfs", "gitfile", "scope", "selfs", "selino", "selstat", "noexpand", "verbatim"];
const WSL_FLOOR = [2n, 55n, 0n];
// Contract §11 "Process launch": the wrapper writes this byte to stdout inside a started scope, before the program starts.
const STARTED = 0x53;
// Mirrors `src-tauri/src/wsl.rs` `started`: the stdout of a wrapped process after its start byte. Null: the scope did not start.
const started = (bytes: Uint8Array): Uint8Array | null => (bytes[0] === STARTED ? bytes.subarray(1) : null);
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
  // T378: `noexpand` is a decimal `$?` from 0 to 255, and only `verbatim 0` binds.
  const status = facts.get("noexpand") ?? "";
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(status) || Number(status) > 255 || facts.get("verbatim") !== "0") return null;
  if (!git || !systemdRun || !systemctl || !setsid || !stat || !env || !perl || !sha256sum || facts.get("scope") !== "0" || !floor || !guid) return null;
  if (!fileSystem || /^0+$/.test(fileSystem) || !/^\d+:\d+:\d+$/.test(gitfile)) return null;
  // gaps.md W1: the context identity binds with the Git facts, or nothing binds.
  const identity = facts.get("selstat") === "ok" ? classifyIdentity(guid, facts.get("selino") ?? "", facts.get("selfs") ?? "") : null;
  if (identity === null || "code" in identity) return null;
  return { distro, guid, git, systemdRun, systemctl, setsid, sha256sum, noexpand: status === "0", version: version[1]!, gitIdentity: `${fileSystem}:${gitfile}`, identity };
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
function mapFacts(records: FactRecord[] | null, entries: readonly FactEntry[], digest: boolean, content = false): FileFact[] {
  return (records && checkFacts(records, entries, digest, content)) ?? entries.map(() => ({ kind: "error", component: 0, code: "other-error" }));
}

// Null: a record breaks a check. `content`: feature 005 contract Δ6, a digested file also carries its bytes.
function checkFacts(records: FactRecord[], entries: readonly FactEntry[], digest: boolean, content = false): FileFact[] | null {
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
        facts.push({ ...base, digest: new Bun.CryptoHasher("sha256").update(record.content).digest("hex"), ...(content ? { bytes: Buffer.from(record.content).toString("base64") } : {}) });
      }
    }
  }
  return facts;
}

interface WslAnchor {
  proc: Subprocess<"pipe", "pipe", "ignore">;
  // The answer to one stdin line: the process count and the CPU-time sum of the operation scopes. A null part is unknown.
  ask(): Promise<[number | null, number | null] | null>;
  // The newest answer with a known count (contract §11 "Process ownership").
  last: [number, number | null] | null;
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
  // Feature 002 contract Δ6: the `run` field `script`.
  script?: string;
  // The request `limits`, as the service sent them (contract §6 "Process fields").
  limits?: Record<string, unknown>;
  input?: Uint8Array;
  refused?: string;
  exit?: GitExit;
  // Microseconds from `Subprocess.resourceUsage()`. A call without a process has none.
  cpuMicros?: number;
  // Milliseconds from `at` to the resolved exit. A refused call has none.
  durationMs?: number;
  // The stderr chunks of the process, as the double forwarded them.
  stderr?: Uint8Array[];
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
const invalidRequest = (detail: string): never => {
  throw new RunnerRefusal("INVALID_REQUEST", detail);
};
const sameIdentity = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// `src-tauri/src/file_facts.rs` `below`: the names of `path` below `root`. Each name passes the native component rule. Null: no such names.
function below(root: string, path: string): string[] | null {
  const rel = relative(root, path);
  if (rel === "" || isAbsolute(rel)) return null;
  const names = rel.split(sep);
  return names.every((name) => name !== ".." && NATIVE.isComponent(name)) ? names : null;
}

// Mirrors `CLONE_ARGUMENTS` of `src-tauri/src/process_requests.rs`: the fixed items before the URL and the destination.
const CLONE_ARGUMENTS = ["--no-lazy-fetch", "clone", "--progress", "--no-recurse-submodules", "--"];

// Mirrors `destination` and `destination_error` of `src-tauri/src/process_requests.rs`. A link or a junction gives `other`.
function destinationOf(path: string): DestinationFactsReply {
  const failed = (error: unknown): DestinationFactsReply => {
    const code = (error as NodeJS.ErrnoException).code;
    return { result: "error", code: code === "EACCES" || code === "EPERM" ? "access-denied" : code === "EBUSY" ? "sharing-violation" : code === "EIO" ? "io-error" : "other-error" };
  };
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { result: "absent" } : failed(error);
  }
  if (stat.isSymbolicLink()) return { result: "other" };
  if (stat.isFile()) return { result: "file" };
  if (!stat.isDirectory()) return { result: "other" };
  try {
    const dir = opendirSync(path);
    try {
      return dir.readSync() === null ? { result: "empty" } : { result: "not-empty" };
    } finally {
      dir.closeSync();
    }
  } catch (error) {
    return failed(error);
  }
}

export function createBunRunner(options: BunRunnerOptions) {
  if (options.wslGlobalConfig !== undefined && !options.wslGlobalConfig.endsWith("/.gitconfig")) throw new Error(`wslGlobalConfig is not <home>/.gitconfig: ${options.wslGlobalConfig}`);
  const launchDirectory = join(options.directory, "launch");
  // Each `wsl.exe` starts here, as the shell starts it in its own launch folder (src-tauri/src/process_requests.rs).
  // Its `wslhost.exe` inherits the folder and lives until WSL closes the interop channel, with no bound. So no test deletes this folder.
  const wslDirectory = tmpdir();
  // A fixture process writes `<pid>-<creation time>` here (`recordProcess` of `HOST_SCRIPT`).
  const recordsDirectory = join(options.directory, "processes");
  const recoveryFolder = join(options.directory, "recovery");
  for (const dir of [launchDirectory, recordsDirectory, recoveryFolder]) mkdirSync(dir, { recursive: true });

  const trustStore = options.trustStore ?? createTrustStore();
  // Feature 003 contract Δ6: a `clone` context and its `repositoryDiscovery` peer. The peer binds its identity only after the clone exits with status 0.
  // Feature 004 contract Δ6: a `worktreeAdd` context binds a path and the repository of its review. It holds no identity and no owner.
  type Context = { kind: "gitProbe" | "repositoryDiscovery" | "clone" | "worktreeAdd"; path: string; owner?: string; identity?: IdentityReply; peer?: string; url?: string; key?: string; pending?: true; repositoryId?: string };
  const contexts = new Map<string, Context>();
  const gits = new Map<string, string>();
  const repositories = new Map<string, { worktreeRoot: string; gitDirectory: string; commonDirectory: string; gitInstallationId: string }>();
  const issued = new Set<string>();
  const inactive = new Set<string>();
  const running = new Map<string, Set<Subprocess>>();
  // The Job emulation of each spawned process outside WSL. `dispose` also ends the trees of ended roots.
  const trees = new Map<Subprocess, ReturnType<typeof ownTree>>();
  const records = new Map<string, ProcessRecord>();
  const tags = new Map<string, string>();
  const markers = new Map<string, MutationStarted>();
  const frames: Record<string, unknown>[] = [];
  // Each run `cancel` frame, in order. They stay out of `frames`, which holds the other shell frames.
  const cancels: { operationId: string; callsBefore: number }[] = [];
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
    // A failed record write: the shell replies `approved` with `stored: false` (contract §7 "Trust approval store").
    trustStoreFails: false,
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
    // Each walk waits for this promise before it reads (contract §6 "Walks"). `kind` names the request type, such as `fileFacts` or `fileDelete`.
    holdWalk: null as ((kind: string) => Promise<void>) | null,
    // Bytes replace the process of a call. No process starts, and the bytes go to stdout in 64 KiB chunks. The exit code is 0, or null after abort, closeJob, or a limited stdout collector.
    stdout: undefined as ((call: { arguments: readonly string[]; input?: Uint8Array }) => Uint8Array | undefined) | undefined,
    // An exit code replaces the process of a call. No process starts, and no byte goes out (T223 read failures).
    exit: undefined as ((call: { arguments: readonly string[] }) => number | undefined) | undefined,
    // A code refuses a call as the shell refuses it. No process starts (T377).
    refuse: undefined as ((call: { operationId: string; arguments: readonly string[] }) => RefusedCode | undefined) | undefined,
    // A path replaces the approved `systemd-run` of one WSL call, such as `/usr/bin/false` for a scope that does not start (T377).
    wslRun: undefined as ((call: { operationId: string; arguments: readonly string[] }) => string | undefined) | undefined,
    // The `confirmRun` reply (contract §12 "Trust"). A function can hold the reply on a test barrier.
    confirmRun: "approved" as "approved" | "declined" | ((request: TrustRequest) => Promise<"approved" | "declined">),
    // A matching call reports `stalled` through `onActivity` before it starts (contract §6 "Activity and stall notice").
    stall: null as CallMatch | null,
    // Shorter activity limits than the request (contract §6 "Activity and stall notice", §12 "Deadlines and Cancel").
    // Only a forwarded output byte, or a changed anchor CPU-time sum of a WSL call, is activity.
    limits: {} as { inactivityMs?: number; ceilingMs?: number; stallMs?: number },
    // The shell setting `sshClient` (feature 003 data-model §10). The double holds no key file, so `plink` replies `none` or `failed`.
    sshClient: "git" as "git" | { plink: string },
    // Runs before each `destinationFacts` reply. A throw replaces the reply, as a broken channel does.
    destinationFacts: null as ((request: { operationId: string; cloneId: string }) => void) | null,
    // Replaces the OS facts of a `worktreeAdd` binding, such as an `error` result that the double cannot produce by itself.
    worktreeAddFacts: null as ((path: string) => DestinationFactsReply) | null,
    // A repository `register` waits for this promise before its reply.
    holdRegister: null as ((request: { repositoryId: string }) => Promise<void>) | null,
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
  // The `run` calls that have no exit reply yet, and the activity input of each spawned one.
  const inflight = new Set<GitCall>();
  const samples = new Map<GitCall, (sum: number | null) => void>();
  let spawned = 0;
  let disposed = false;
  // Set when `dispose` starts. A call that a start barrier held then starts no process.
  let closing = false;

  const identityOfWindows = (path: string): IdentityReply => inject.identities.get(path) ?? readIdentity(path, inject.fileIds.get(path));

  // ---- Feature 005 contract Δ6 file requests ----

  // The owned folder that stands in for the Windows Recycle Bin. Each recycled item gets its own name there.
  const recycleBin = join(options.directory, "recycle-bin");
  // `src-tauri/src/shadow.rs` `PREVIEW`: the shadow folders below the launch folder, by `shadowId`.
  const previewFolder = join(launchDirectory, "preview");
  const shadows = new Map<string, { operationId: string; folder: string }>();
  // `std::fs::remove_dir_all` never follows a link. `rmSync` with `recursive` removes a link itself, too.
  const removeShadow = (folder: string) => rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  const errorCode = (error: unknown): FileFactError => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EBUSY" ? "sharing-violation" : code === "EACCES" || code === "EPERM" ? "access-denied" : code === "EIO" ? "io-error" : "other-error";
  };

  // `file_delete.rs` `check_entry`: the target fact against the review fact. A link on the way, a folder, and a special file are not regular.
  function deleteCheck(roots: Roots, names: string[], expected: FileDeleteExpected): DeleteEntryReply | null {
    const digest = expected.kind === "file" && expected.digest !== undefined;
    const fact = readFileFacts(roots, digest, [{ root: "worktreeRoot", path: names }]).facts[0]!;
    if (fact.kind === "absent") return { result: "absent" };
    if (fact.kind === "error") return { result: "error", code: fact.code };
    if (fact.kind === "link") {
      if (fact.component < names.length) return { result: "not-regular" };
      return expected.kind === "link" && fact.tag === expected.tag && fact.target === expected.target ? null : { result: "stale" };
    }
    if (fact.kind !== "file") return { result: "not-regular" };
    if (expected.kind !== "file" || fact.size !== expected.size || fact.lastWrite !== expected.lastWrite) return { result: "stale" };
    return expected.digest === undefined || fact.digest === expected.digest ? null : { result: "stale" };
  }

  // Recycle moves the item into the owned bin. A failed move keeps the item with the HRESULT of its Win32 error.
  // Permanent: `FileDispositionInfoEx` without `FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE` keeps a read-only file.
  // libuv clears the read-only attribute itself before an unlink, so the double checks the attribute first.
  function deleteEntry(path: string, mode: "recycle" | "permanent"): DeleteEntryReply {
    try {
      const st = lstatSync(path);
      if (mode === "recycle") {
        mkdirSync(recycleBin, { recursive: true });
        const recycledPath = join(recycleBin, `${crypto.randomUUID()}-${basename(path)}`);
        renameSync(path, recycledPath);
        return { result: "recycled", recycledPath };
      }
      if (process.platform === "win32" && !st.isSymbolicLink() && (st.mode & 0o200) === 0) return { result: "error", code: "access-denied" };
      try {
        unlinkSync(path);
      } catch (error) {
        if (!st.isSymbolicLink()) throw error;
        rmdirSync(path);
      }
      return { result: "deleted" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { result: "absent" };
      const code = errorCode(error);
      // HRESULT_FROM_WIN32 of ERROR_SHARING_VIOLATION (32) and ERROR_ACCESS_DENIED (5), else E_FAIL.
      return mode === "recycle" ? { result: "kept", hresult: code === "sharing-violation" ? 0x8007_0020 : code === "access-denied" ? 0x8007_0005 : 0x8000_4005 } : { result: "error", code };
    }
  }

  // `file_delete.rs` folder phase: a folder through its held handle, deepest first. A folder that is not empty stays.
  function removeFolder(roots: Roots, names: string[], path: string): DeleteFolderReply {
    const fact = readFileFacts(roots, false, [{ root: "worktreeRoot", path: names }]).facts[0]!;
    if (fact.kind === "absent") return { result: "absent" };
    if (fact.kind === "error") return { result: "error", code: fact.code };
    if (fact.kind !== "directory") return { result: "not-regular" };
    try {
      rmdirSync(path);
      return { result: "removed" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOTEMPTY" || code === "EEXIST" ? { result: "kept" } : { result: "error", code: errorCode(error) };
    }
  }

  // `file_replace.rs`: a temporary file in the target folder, then one rename over the target. An absent target takes a link, so an existing name gives `stale`.
  function replaceFile(root: string, names: string[], expected: FileReplaceRequest["expected"], bytes: Uint8Array): FileReplaceReply {
    let at = root;
    for (const [i, name] of names.entries()) {
      at = join(at, name);
      const last = i === names.length - 1;
      const st = lstatSync(at, { throwIfNoEntry: false });
      if (st === undefined) {
        if (!last) return { result: "error", code: "other-error" };
        if (expected !== "absent") return { result: "stale" };
        const temp = join(dirname(at), `.arbareto-${crypto.randomUUID().replaceAll("-", "")}.tmp`);
        writeFileSync(temp, bytes, { flag: "wx" });
        try {
          linkSync(temp, at);
          return { result: "replaced" };
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EEXIST" ? { result: "stale" } : { result: "error", code: errorCode(error) };
        } finally {
          unlinkSync(temp);
        }
      }
      if (st.isSymbolicLink() || (!last && !st.isDirectory()) || (last && (!st.isFile() || st.nlink !== 1))) return { result: "refused", reason: "not-regular" };
    }
    const old = readFileSync(at);
    if (expected === "absent" || old.length !== expected.size || new Bun.CryptoHasher("sha256").update(old).digest("hex") !== expected.sha256) return { result: "stale" };
    const temp = join(dirname(at), `.arbareto-${crypto.randomUUID().replaceAll("-", "")}.tmp`);
    writeFileSync(temp, bytes, { flag: "wx" });
    renameSync(temp, at);
    return { result: "replaced" };
  }

  // Contract §6 "Walks": the walk deadline and an abort end the hold without a value. The read stays synchronous, as in the shell, so no stop interrupts it.
  async function walk<T>(signal: AbortSignal, read: () => T | Promise<T>, kind = "walk"): Promise<T | WalkStop> {
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
      const stop = await Promise.race([(inject.holdWalk?.(kind) ?? Promise.resolve()).then(() => null), stopped]);
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
  // Mirrors `own` of `src-tauri/src/process_requests.rs`: a clone context and its peer have one owner.
  function own(id: string, operationId: string): void {
    const peer = contexts.get(id)?.peer;
    const ids = peer === undefined ? [id] : [id, peer];
    if (ids.some((i) => (contexts.get(i)?.owner ?? operationId) !== operationId)) throw unknownTarget();
    for (const i of ids) {
      const context = contexts.get(i);
      if (context) context.owner = operationId;
    }
  }

  // A WSL Git target carries its installation. Its `cwd` is the UNC directory that becomes the Linux `-C` directory.
  // `args`: a `clone` context admits only its fixed array (feature 003 contract Δ6), and only a `run` names it.
  function resolveTarget(operationId: string, context: ProcessContext, args?: readonly string[]): { program: string; cwd: string; wsl?: WslInstallation } {
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
    if (context.contextKind === "clone") {
      const bound = contexts.get(context.cloneId);
      const program = gits.get(context.gitInstallationId);
      if (bound?.kind !== "clone" || program === undefined) throw unknownTarget();
      own(context.cloneId, operationId);
      // The double has no WSL clone route. T075 covers it in the distro.
      if (wslGits.has(context.gitInstallationId) || wslParts(bound.path) !== null) throw new RunnerRefusal("INVALID_REQUEST", "WSL clone");
      const fixed = [...CLONE_ARGUMENTS, bound.url!, bound.path];
      if (args === undefined || args.length !== fixed.length || args.some((arg, i) => arg !== fixed[i])) throw new RunnerRefusal("INVALID_REQUEST", "clone arguments");
      return { program, cwd: launchDirectory };
    }
    // Feature 004 contract Δ6, as `src-tauri/src/process_requests.rs` resolves it: the admitted Git in the launch folder. It has no WSL form.
    if (context.contextKind === "globalConfig") {
      const program = gits.get(context.gitInstallationId);
      if (program === undefined) throw unknownTarget();
      if (wslGits.has(context.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "WSL globalConfig");
      return { program, cwd: launchDirectory };
    }
    // Feature 004 contract Δ6, as src-tauri/src/process_requests.rs `target` and `worktree_add_fits` check it: only a `run` of the two
    // `worktree add` forms with the bound path, in the registered repository of the review. The double has no WSL `worktreeAdd` route.
    if (context.contextKind === "worktreeAdd") {
      const bound = contexts.get(context.bootstrapId);
      const program = gits.get(context.gitInstallationId);
      const repository = repositories.get(context.repositoryId);
      if (bound?.kind !== "worktreeAdd" || bound.repositoryId !== context.repositoryId || program === undefined || repository === undefined || args === undefined) throw unknownTarget();
      if (wslGits.has(context.gitInstallationId) || wslParts(bound.path) !== null) throw new RunnerRefusal("INVALID_REQUEST", "WSL worktreeAdd");
      const fits = (args.length === 6 && args[3] === "--" && args[4] === bound.path) || (args.length === 8 && args[3] === "-b" && args[5] === "--" && args[6] === bound.path);
      if (!fits) throw new RunnerRefusal("INVALID_REQUEST", "worktree add arguments");
      return { program, cwd: repository.worktreeRoot };
    }
    // Feature 005 contract Δ6, as src-tauri/src/process_requests.rs `ignore_preview_target` and `shadow::fits` check it: the shadow of this operation,
    // a Windows Git, and the fixed shadow arrays. The cwd is `<shadow>/s` or `<shadow>/c`. The shell has no WSL shadow run yet, so the double has none.
    if (context.contextKind === "ignorePreview") {
      const shadow = shadows.get(context.shadowId);
      if (shadow === undefined || shadow.operationId !== operationId) throw unknownTarget();
      const program = gits.get(context.gitInstallationId);
      if (program === undefined) throw unknownTarget();
      if (wslGits.has(context.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "WSL ignorePreview");
      if (args === undefined || !shadowArrayFits(args, process.platform === "win32")) throw new RunnerRefusal("INVALID_REQUEST", "ignorePreview arguments");
      return { program, cwd: join(shadow.folder, context.shadowRepository) };
    }
    const bound = contexts.get(context.bootstrapId);
    // Feature 003 contract Δ6: before its clone exits with status 0, a clone destination has no identity.
    if (!bound || bound.kind !== context.contextKind || bound.pending) throw unknownTarget();
    own(context.bootstrapId, operationId);
    if (context.contextKind === "gitProbe") return { program: bound.path, cwd: launchDirectory };
    const program = gits.get(context.gitInstallationId);
    if (!program) throw unknownTarget();
    // gaps.md W1: a WSL context runs only the WSL Git of its bound distro, and a Windows context only a Windows Git.
    const wsl = wslGits.get(context.gitInstallationId);
    const parts = wslParts(bound.path);
    if ((parts === null) !== (wsl === undefined) || (wsl && wslBound.get(context.bootstrapId)?.guid !== wsl.guid)) throw new RunnerRefusal("INVALID_REQUEST", "WSL context");
    return { program, cwd: bound.path, wsl };
  }

  // Contract §11 "Process launch". Only the fixture isolation of `wslGlobalConfig` and `wslLocalePath` reaches Linux.
  function wslEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.environment)) {
      if (!["WSL_UTF8", "WSLENV", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME", "LOCPATH"].includes(name.toUpperCase())) env[name] = value;
    }
    const forwarded: Record<string, string> = {
      ...(options.wslGlobalConfig ? { GIT_CONFIG_GLOBAL: options.wslGlobalConfig, GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: `${options.wslGlobalConfig.slice(0, -"/.gitconfig".length)}/.config` } : {}),
      ...(options.wslLocalePath ? { LOCPATH: options.wslLocalePath } : {}),
    };
    return { ...env, ...forwarded, WSL_UTF8: "1", WSLENV: Object.keys(forwarded).join(":") };
  }

  const wslHead = (distro: string) => ["--distribution", distro, "--cd", "/", "--exec", "/bin/sh", "-c"];

  function wslWrapped(inst: WslInstallation, operationId: string, mode: WslMode, index: string, program: string, args: readonly string[]): string[] {
    const n = (wslUnits.get(operationId)?.n ?? 0) + 1;
    wslUnits.set(operationId, { inst, n });
    OWN_SCOPE_OPERATIONS.add(operationId);
    const unit = `arbareto-${operationId}-${n}.scope`;
    return [...wslHead(inst.distro), WSL_TEXTS.wrapper, "sh", unit, mode, index, inst.systemdRun, inst.systemctl, inst.setsid, inst.noexpand ? "1" : "", program, ...args];
  }

  // Starts the anchor of a WSL mutation or submodule update before its first Git process, in the operation's process set.
  function wslAnchor(operationId: string, inst: WslInstallation): WslAnchor {
    const existing = wslAnchors.get(operationId);
    if (existing) return existing;
    const proc = Bun.spawn([WSL_EXE, ...wslHead(inst.distro), WSL_TEXTS.anchor, "sh", inst.systemctl, operationId], {
      cwd: wslDirectory,
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
    const waiting: ((line: [number | null, number | null] | null) => void)[] = [];
    // After the anchor stdout ends, no answer can come.
    let ended = false;
    const anchor: WslAnchor = {
      proc,
      last: null,
      ask: () => {
        if (ended) return Promise.resolve(null);
        const answer = new Promise<[number | null, number | null] | null>((resolve) => waiting.push(resolve));
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
          const line = buffered.slice(0, nl);
          const m = /^(\d+) (\d+|-)$/.exec(line);
          buffered = buffered.slice(nl + 1);
          if (line === "- -") {
            waiting.shift()?.([null, null]);
            continue;
          }
          if (!m) continue;
          anchor.last = [Number(m[1]), m[2] === "-" ? null : Number(m[2])];
          waiting.shift()?.(anchor.last);
        }
      }
      ended = true;
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
      // A missing start byte fails every probed path, as in the shell.
      const out = result.exitCode === 0 ? started(result.bytes) : null;
      const text = out === null ? "" : new TextDecoder().decode(out);
      lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : [];
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
  function wslFileFacts(operationId: string, inst: WslInstallation, roots: Roots, digest: boolean, files: FileFactsRequest["files"], index?: { sharedIndex?: string }, content = false): { facts: FileFact[]; index?: WslIndexResult } {
    const entries: FactEntry[] = files.map(({ root, path }) => ({ root: ROOT_ORDER.indexOf(root) as 0 | 1 | 2, path: [...path] }));
    const failed = { kind: "error", component: 0, code: "other-error" } as const;
    const linux = linuxRoots(inst, roots);
    if (linux === null) return { facts: mapFacts(null, entries, digest), ...(index ? { index: failed } : {}) };
    const extra = index ? [inst.sha256sum, ...(index.sharedIndex === undefined ? [] : [index.sharedIndex])] : [];
    const args = ["-e", FACTS_TEXT, "--", digest ? "1" : "0", ...linux, ...extra];
    const result = wslExec(wslWrapped(inst, operationId, "probe", "", WSL_PERL, args), { env: wslEnvironment(), input: factsInput(entries) });
    const out = result.exitCode === 0 ? started(result.bytes) : null;
    if (!index) return { facts: mapFacts(out === null ? null : parseFactRecords(out), entries, digest, content) };
    const parsed = out === null ? null : parseIndexedFacts(out, entries.length, index.sharedIndex !== undefined);
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
    const out = started(result.bytes);
    return wslFilesResults(out === null ? null : result.exitCode, out ?? result.bytes, request);
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

  // Starts one process after the start barriers and drains it as the shell does. `wrapped`: a WSL process of the §11 wrapper.
  async function execute(call: GitCall, argv: string[], cwd: string, env: Record<string, string>, recorded?: RecordedCall, wrapped = false): Promise<GitExit> {
    for (let held = holding(startBarriers, call); held; held = holding(startBarriers, call)) await held.promise;
    if (closing) throw unknownTarget();
    call.signal.throwIfAborted();
    // Contract §6 "Channel frames": the service sends the run `cancel` at the abort. `callsBefore` orders it against the recorded calls.
    const cancel = () => cancels.push({ operationId: call.operationId, callsBefore: calls.length });
    call.signal.addEventListener("abort", cancel, { once: true });
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
      const refused = inject.refuse?.(call);
      if (refused !== undefined) throw new RunnerRefusal(refused, "injected");
      const exitCode = inject.exit?.({ arguments: call.arguments });
      if (exitCode !== undefined) return { exitCode, activeDescendants: 0 };
      const injected = inject.stdout?.({ arguments: call.arguments, input: call.input });
      if (injected === undefined) return await spawn(call, argv, cwd, env, recorded, halt, heldStdout, wrapped);
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
      call.signal.removeEventListener("abort", cancel);
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
    wrapped: boolean,
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
    // A WSL call keeps its own end path: a killed `wsl.exe` ends its scopes (contract §11). It gets no Job.
    let tree: ReturnType<typeof ownTree> | undefined;
    try {
      if (argv[0] !== WSL_EXE) tree = ownTree(proc.pid);
    } catch (error) {
      proc.kill();
      pipes.forEach(closePipe);
      throw error;
    }
    if (tree) trees.set(proc, tree);
    spawned++;
    const own = running.get(call.operationId) ?? new Set();
    running.set(call.operationId, own.add(proc));
    // Contract §6 "Console and input": stdin closes after the bounded input, or at once.
    void (async () => {
      if (call.input?.length) proc.stdin.write(call.input);
      await proc.stdin.end();
    })().catch(() => {});

    let killed = false;
    let expired: GitExit["deadline"];
    // Contract §6 and §11: the shell closes the Job at a run `cancel`, a deadline, and a limit, with every descendant.
    const kill = () => {
      halt();
      if (killed) return;
      killed = true;
      tree?.end();
      proc.kill();
    };
    const expire = (reason: NonNullable<GitExit["deadline"]>) => {
      expired ??= reason;
      kill();
    };
    const shorter = (limit: number, injected: number | null | undefined) => Math.min(limit, injected ?? limit);
    // Contract §6 "Process fields": a `network` request has an inactivity limit and a ceiling, every other request a deadline.
    const limits = call.limits;
    const network = "inactivityMs" in limits ? limits : null;
    // Feature 004 contract Δ6: a `mergetool` run carries the ceiling alone.
    const timer =
      "ceilingMs" in limits
        ? setTimeout(() => expire("ceiling"), shorter(limits.ceilingMs, inject.limits.ceilingMs))
        : setTimeout(() => expire("deadline"), shorter(limits.deadlineMs, inject.deadlineMs));
    // The exit can reach the loop before a due timer callback. A test-injected deadline then still ends the call.
    const injectedEnd = "ceilingMs" in limits || inject.deadlineMs == null ? null : performance.now() + shorter(limits.deadlineMs, inject.deadlineMs);
    // Contract §6 "Activity and stall notice": only a call with `stallMs` gets activity events, and only at a state change.
    const stallMs = call.limits.stallMs === undefined ? undefined : shorter(call.limits.stallMs, inject.limits.stallMs);
    let inactivity: ReturnType<typeof setTimeout> | undefined;
    let stall: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    let exited = false;
    // Contract §6 "Unknown sample": idle time counts only between known samples. undefined: no sample yet. null: the last sample was unknown.
    let sum: number | null | undefined;
    // Restarts idle time at 0. A stalled call stays stalled.
    const rebase = () => {
      clearTimeout(inactivity);
      clearTimeout(stall);
      if (sum === null) return;
      if (network) inactivity = setTimeout(() => expire("inactivity"), shorter(network.inactivityMs, inject.limits.inactivityMs));
      if (stallMs === undefined || stalled) return;
      stall = setTimeout(() => {
        stalled = true;
        call.onActivity?.("stalled");
      }, stallMs);
    };
    const touch = () => {
      if (exited) return;
      if (stalled) {
        stalled = false;
        call.onActivity?.("active");
      }
      rebase();
    };
    // An unknown sum stops idle time, and the next known sum is the new base.
    const sample = (next: number | null) => {
      if (exited) return;
      const last = sum;
      sum = next;
      if (next === null || last === null) rebase();
      else if (last !== undefined && last !== next) touch();
    };
    touch();
    samples.set(call, sample);
    call.signal.addEventListener("abort", kill, { once: true });
    // Mirrors `src-tauri/src/process_requests.rs` `read_stream`: the first stdout chunk of a wrapped run loses its start byte.
    let first: boolean | undefined;
    const streams = [
      drain(
        pipes[0],
        (chunk) => {
          let data = chunk;
          if (wrapped && first === undefined) {
            const rest = started(chunk);
            first = rest !== null;
            data = rest ?? chunk;
          }
          if (data.length === 0) return;
          touch();
          call.stdout.push(data);
          if (call.stdout.limited) kill();
        },
        heldStdout,
      ),
      drain(
        pipes[1],
        (chunk) => {
          touch();
          call.stderr.push(chunk);
          recorded?.stderr?.push(chunk);
          if (diagnostics.add(call, chunk.length)) kill();
        },
        () => null,
      ),
    ];

    await proc.exited;
    if (injectedEnd !== null && performance.now() >= injectedEnd) expire("deadline");
    exited = true;
    samples.delete(call);
    for (const t of [timer, inactivity, stall]) clearTimeout(t);
    call.signal.removeEventListener("abort", kill);
    own.delete(proc);
    const usage = proc.resourceUsage();
    // Bun 1.4.3 on Windows gives a bigint here, although its type says number.
    if (usage && recorded) recorded.cpuMicros = Number(usage.cpuTime.total);
    for (const stream of streams) stream.exit();
    await Promise.all(streams.map((s) => s.done));
    scan(call.operationId);
    // Mirrors `src-tauri/src/process_requests.rs` `watch`: a wrapped process that ended by itself without the start byte did not start in its scope.
    const exitCode = killed ? null : proc.exitCode;
    if (wrapped && first !== true && exitCode !== null && expired === undefined) throw new RunnerRefusal("PROCESS_OWNERSHIP_FAILED", "no start byte");
    return {
      exitCode,
      // Contract §6: a closed Job gives no count.
      activeDescendants: killed ? null : live((r) => r.operationId === call.operationId).length,
      ...(expired ? { deadline: expired } : {}),
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
    const target = resolveTarget(call.operationId, call.context, call.arguments);
    if (!target.wsl) {
      if (call.script) throw new RunnerRefusal("INVALID_REQUEST", "script needs a WSL Git");
      const env = environment(call);
      // Feature 005 contract Δ6: `GIT_INDEX_FILE` names `<cwd>/.git/index` or `<cwd>/.git/exclude.index`, and `GIT_DIR` names `<cwd>/.git`.
      if (call.context.contextKind === "ignorePreview") {
        for (const key of Object.keys(env)) if (["GIT_INDEX_FILE", "GIT_DIR"].includes(key.toUpperCase())) delete env[key];
        env.GIT_INDEX_FILE = join(target.cwd, ".git", call.context.shadowIndex === "exclude" ? "exclude.index" : "index");
        // `git init` takes a `GIT_DIR` that does not end in `/.git` as a bare repository (setup.c `guess_repository_type`), and Git for Windows
        // does not read `\.git` as that end (T030 F14). `checkout-index` then needs a work tree, so the value uses `/` separators.
        // The shell sets the native form (process_requests.rs:2196-2199). WP5 reports that gap.
        env.GIT_DIR = join(target.cwd, ".git").replaceAll("\\", "/");
      }
      if (commandLineUnits(target.program, call.arguments) > WINDOWS_COMMAND_LINE_UNITS) throw new RunnerRefusal("INVALID_REQUEST", "command line");
      if (call.context.contextKind === "repositoryDiscovery") revalidate(call.context.bootstrapId);
      // Feature 004 contract Δ6: the admitted `worktree add` run consumes its binding.
      if (call.context.contextKind === "worktreeAdd") contexts.delete(call.context.bootstrapId);
      return execute(call, [target.program, ...call.arguments], target.cwd, env, recorded);
    }
    // Contract §11 "Process launch": `--no-lazy-fetch` stays first, and `-C` takes the Linux directory.
    // Feature 002 contract Δ6: a script run gets `/bin/sh`, the script text, and the approved Git from the shell. `checkCall` checked its arguments.
    const run = inject.wslRun?.(call);
    const inst = run === undefined ? target.wsl : { ...target.wsl, systemdRun: run };
    const dir = wslParts(target.cwd);
    const index = call.transaction ? wslParts(call.transaction.indexFile)?.linux : "";
    if (!dir || index === undefined) throw new RunnerRefusal("INVALID_REQUEST", "WSL path");
    const args = call.script
      ? wslWrapped(inst, call.operationId, "search", "", "/bin/sh", ["-c", WSL_TEXTS.matchingProbe, "sh", inst.git, ...call.arguments])
      : wslWrapped(inst, call.operationId, call.environmentPolicy, index, inst.git, ["--no-lazy-fetch", "-C", dir.linux, ...call.arguments.slice(1)]);
    if (commandLineUnits(WSL_EXE, args) > WINDOWS_COMMAND_LINE_UNITS) throw new RunnerRefusal("INVALID_REQUEST", "command line");
    const anchor = call.environmentPolicy === "mutation" || call.environmentPolicy === "network" ? wslAnchor(call.operationId, inst) : null;
    // Contract §6 "Activity and stall notice": one anchor line each second while a tracked process runs. Any change of the CPU-time sum is activity.
    // A missing answer is an unknown sample.
    const poll =
      anchor && call.limits.stallMs !== undefined
        ? setInterval(() => {
            void anchor.ask().then((answer) => samples.get(call)?.(answer?.[1] ?? null));
          }, 1_000)
        : undefined;
    const exit = await execute(call, [WSL_EXE, ...args], wslDirectory, wslEnvironment(), recorded, true).finally(() => clearInterval(poll));
    await inject.afterWslExit?.(call);
    // The anchor count after the exit of an execution process becomes `activeDescendants`.
    // Without an answer, or with an unknown count, the exit carries no count (contract §6).
    return anchor ? { ...exit, activeDescendants: (await anchor.ask())?.[0] ?? null } : exit;
  }

  const runner: GitRunner & SyncRunner = {
    async run(call: GitCall): Promise<GitExit> {
      const context: Record<string, unknown> = typeof call.context === "object" && call.context !== null ? call.context : {};
      const recorded: RecordedCall = {
        at: performance.now(),
        operationId: text(call.operationId),
        contextKind: text(context.contextKind),
        ...(typeof context.repositoryId === "string" ? { repositoryId: context.repositoryId } : {}),
        arguments: Array.isArray(call.arguments) ? [...call.arguments] : [],
        environmentPolicy: text(call.environmentPolicy),
        ...(call.script === undefined ? {} : { script: text(call.script) }),
        ...(typeof call.limits === "object" && call.limits !== null ? { limits: { ...call.limits } } : {}),
        ...(call.input instanceof Uint8Array ? { input: call.input } : {}),
        stderr: [],
      };
      calls.push(recorded);
      if (inject.stall?.(recorded)) call.onActivity?.("stalled");
      inflight.add(call);
      try {
        recorded.exit = await start(call, recorded);
        recorded.durationMs = performance.now() - recorded.at;
        // Mirrors `watch` of `src-tauri/src/process_requests.rs`: the destination identity binds only after exit status 0. A failed read binds nothing.
        const peer = call.context.contextKind === "clone" ? contexts.get(call.context.cloneId)?.peer : undefined;
        const discovery = peer === undefined ? undefined : contexts.get(peer);
        if (discovery?.pending && recorded.exit.exitCode === 0 && recorded.exit.deadline === undefined) {
          const identity = readIdentity(discovery.path);
          if (!("code" in identity)) {
            discovery.identity = identity;
            delete discovery.pending;
          }
        }
        return recorded.exit;
      } catch (error) {
        recorded.refused = error instanceof RunnerRefusal ? error.code : error instanceof Error ? error.name : "unknown";
        throw error;
      } finally {
        inflight.delete(call);
      }
    },

    // A refused or stopped request keeps an empty `replies` list.
    async identities(operationId, context, paths, signal) {
      const recorded = { at: performance.now(), operationId: text(operationId), paths: Array.isArray(paths) ? [...paths] : [], replies: [] as unknown[] };
      identityCalls.push(recorded);
      if (!isIdentifier(operationId) || !checkContext(context)) throw new RunnerRefusal("INVALID_REQUEST", "identity context");
      checkIdentityPaths(paths);
      const target = resolveTarget(operationId, context);
      return walk(
        signal,
        () => {
          if (!target.wsl) {
            const replies = paths.map(identityOfWindows);
            recorded.replies = replies;
            return replies;
          }
          const replies = wslIdentities(operationId, target.wsl, paths);
          recorded.replies = replies;
          return replies;
        },
        "identity",
      );
    },

    // src-tauri/src/process_requests.rs `file_facts`: the fields, the target, then the WSL roots. The walk is synchronous, as in the shell.
    // Feature 005 contract Δ6: `content` passes only for a WSL repository, and the `file` fact then adds the bytes that the probe digested.
    async fileFacts(request, signal) {
      checkFileFacts(request);
      const { operationId, contextKind, gitInstallationId, repositoryId } = request;
      resolveTarget(operationId, { contextKind, gitInstallationId, repositoryId });
      const { gitInstallationId: _git, ...roots } = repositories.get(repositoryId)!;
      const files = request.files.map(({ root, path }) => ({ root, path: [...path] }));
      // gaps.md W3: a WSL repository gets the Perl probe of its installation. The double records no read bytes for it.
      const wsl = wslGits.get(gitInstallationId);
      if (request.content === true && !wsl) throw new RunnerRefusal("INVALID_REQUEST", "content outside WSL");
      return walk(
        signal,
        () => {
          if (wsl) {
            const { facts } = wslFileFacts(operationId, wsl, roots, request.digest, request.files, undefined, request.content === true);
            fileFactCalls.push({ operationId, repositoryId, digest: request.digest, files, facts, bytesRead: facts.map(() => 0) });
            return facts;
          }
          const { facts, bytesRead, statuses } = readFileFacts(roots, request.digest, request.files);
          fileFactCalls.push({ operationId, repositoryId, digest: request.digest, files, facts, bytesRead, statuses });
          return facts;
        },
        "fileFacts",
      );
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
      await inject.holdRegister?.(request);
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
      if ("repositoryId" in target) {
        repositories.delete(target.repositoryId);
        // Feature 004 contract Δ6: the release of a repository ends its `worktreeAdd` contexts.
        for (const [id, context] of contexts) if (context.kind === "worktreeAdd" && context.repositoryId === target.repositoryId) contexts.delete(id);
      } else {
        gits.delete(target.gitInstallationId);
        wslGits.delete(target.gitInstallationId);
      }
    },

    closeJob(operationId) {
      if (!isIdentifier(operationId)) throw new RunnerRefusal("INVALID_REQUEST", "closeJob");
      frames.push({ type: "closeJob", operationId });
      // A killed `wsl.exe` gives its command `SIGHUP`, and the wrapper and anchor traps end the scopes (contract §11).
      for (const proc of running.get(operationId) ?? []) {
        trees.get(proc)?.end();
        proc.kill();
      }
      for (const halt of halts.get(operationId) ?? []) halt();
      wslAnchors.delete(operationId);
      end((r) => r.operationId === operationId);
      inactive.add(operationId);
      diagnostics.clear(operationId);
      // Mirrors `close_job` of `src-tauri/src/process_requests.rs`: the end of a clone operation destroys its contexts.
      for (const [id, context] of contexts) if (context.peer !== undefined && context.owner === operationId) contexts.delete(id);
      // Feature 005 contract Δ6: the end of a preview operation removes its shadow folder.
      for (const [id, shadow] of shadows) {
        if (shadow.operationId !== operationId) continue;
        shadows.delete(id);
        removeShadow(shadow.folder);
      }
    },

    async started(frame) {
      checkStarted(frame);
      if (inject.markerFailure) {
        frames.push({ type: "started", ...frame });
        return { failure: inject.markerFailure, folder: recoveryFolder };
      }
      const markerId = crypto.randomUUID();
      frames.push({ type: "started", ...frame, markerId });
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

    // Feature 003 contract Δ6 `pageant`, as T027 states the shell side: `git` starts no process, a missing `plink.exe` gives `failed` with `missing`,
    // and no key file gives `none`. A WSL target is refused. The double starts no Pageant, so the picked key file of a clone gives `ready`.
    async pageant(request): Promise<PageantReply> {
      checkPageant(request);
      frames.push({ type: "pageant", ...request });
      if (inactive.has(request.operationId)) throw unknownTarget();
      let key: string | undefined;
      if ("cloneId" in request) {
        const bound = contexts.get(request.cloneId);
        if (bound?.kind !== "clone") throw unknownTarget();
        own(request.cloneId, request.operationId);
        if (wslParts(bound.path) !== null) throw new RunnerRefusal("INVALID_REQUEST", "WSL pageant");
        key = bound.key;
      } else {
        const repository = repositories.get(request.repositoryId);
        if (repository === undefined) throw unknownTarget();
        if (wslGits.has(repository.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "WSL pageant");
      }
      const client = inject.sshClient;
      if (client === "git") return { result: "git" };
      if (!statSync(client.plink, { throwIfNoEntry: false })?.isFile()) return { result: "failed", reason: "missing", program: "plink", path: client.plink };
      return { result: key === undefined ? "none" : "ready" };
    },

    // Feature 003 contract Δ6 `destinationFacts`: the OS facts of the bound destination. The request carries no path.
    async destinationFacts(request): Promise<DestinationFactsReply | WorktreeAddFactsReply> {
      checkSyncRequest("destinationFacts", request);
      frames.push({ type: "destinationFacts", ...request });
      // Feature 004 contract Δ6: the review and the run of one `worktree-add` read the binding, so no operation owns it.
      // The reply adds the bound path in Git's form, which is the Windows path for a Windows Git.
      if (!("cloneId" in request)) {
        const bound = contexts.get(request.bootstrapId);
        if (inactive.has(request.operationId) || bound?.kind !== "worktreeAdd" || !repositories.has(bound.repositoryId!)) throw unknownTarget();
        if (wslParts(bound.path) !== null) throw new RunnerRefusal("INVALID_REQUEST", "WSL destination");
        return { ...(inject.worktreeAddFacts?.(bound.path) ?? destinationOf(bound.path)), path: bound.path };
      }
      inject.destinationFacts?.(request);
      const bound = contexts.get(request.cloneId);
      if (inactive.has(request.operationId) || bound?.kind !== "clone") throw unknownTarget();
      own(request.cloneId, request.operationId);
      // The double has no WSL `destination` mode. T075 covers it in the distro.
      if (wslParts(bound.path) !== null) throw new RunnerRefusal("INVALID_REQUEST", "WSL destination");
      return destinationOf(bound.path);
    },

    // Feature 004 contract Δ6 `fileAppend` on Windows, as `src-tauri/src/file_append.rs` checks it: a `started` marker of the target's action,
    // the exact target, no link on the way, a regular file with one link, the expected state, and one append. The double has no WSL `append` mode.
    async fileAppend(request, signal): Promise<FileAppendReply | WalkStop> {
      checkSyncRequest("fileAppend", request);
      frames.push({ type: "fileAppend", ...request });
      if (inactive.has(request.operationId)) throw unknownTarget();
      const action = request.target === "gitignore" ? "ignore-gitignore" : "ignore-exclude";
      if (![...markers.values()].some((m) => m.operationId === request.operationId && m.kind === "workbench" && m.action === action)) throw new RunnerRefusal("INVALID_REQUEST", "fileAppend action");
      const repository = repositories.get(request.repositoryId);
      if (repository === undefined) throw unknownTarget();
      if (wslGits.has(repository.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "WSL fileAppend");
      const root = request.target === "gitignore" ? repository.worktreeRoot : repository.commonDirectory;
      const names = request.target === "gitignore" ? [".gitignore"] : ["info", "exclude"];
      if (resolve(request.path) !== resolve(join(root, ...names))) throw new RunnerRefusal("INVALID_REQUEST", "fileAppend path");
      const bytes = Buffer.from(request.bytes, "base64");
      // src-tauri `file_append_deadline` and `file_append_stopped`: a walk past its deadline gives `error` `other-error`, and a stop before the read gives `stopped`.
      const replied = (reply: FileAppendReply | WalkStop): FileAppendReply => ("stop" in reply ? (reply.stop === "deadline" ? { result: "error", code: "other-error" } : { result: "stopped" }) : reply);
      return replied(await walk(signal, (): FileAppendReply => {
        let at = root;
        for (const [i, name] of names.entries()) {
          at = join(at, name);
          const st = lstatSync(at, { throwIfNoEntry: false });
          if (st === undefined) {
            if (i < names.length - 1) return { result: "error", code: "other-error" };
            if (request.expected !== "absent") return { result: "stale" };
            writeFileSync(at, bytes, { flag: "wx" });
            return { result: "appended" };
          }
          if (st.isSymbolicLink() || (i < names.length - 1 && !st.isDirectory())) return { result: "refused", reason: "not-regular" };
          if (i === names.length - 1 && (!st.isFile() || st.nlink !== 1)) return { result: "refused", reason: "not-regular" };
        }
        const old = readFileSync(at);
        if (request.expected === "absent" || old.length !== request.expected.size || new Bun.CryptoHasher("sha256").update(old).digest("hex") !== request.expected.sha256) return { result: "stale" };
        appendFileSync(at, bytes);
        return { result: "appended" };
      }, "fileAppend"));
    },

    // Feature 004 contract Δ3 `revealPath`, as `src-tauri/src/process_requests.rs` `reveal` checks it: the path lies below the worktree root by text,
    // the walk meets no link on the way, and the entry is a file, a folder, or a final link. Each failure gives UNKNOWN_TARGET. The double shows nothing.
    // Feature 005 contract Δ6: the shell takes the fact of its `file_facts` walk, and an absent component replies `absent`.
    async reveal(request, signal): Promise<"shown" | "absent" | WalkStop> {
      checkSyncRequest("reveal", request);
      frames.push({ type: "reveal", ...request });
      if (inactive.has(request.operationId)) throw unknownTarget();
      const repository = repositories.get(request.repositoryId);
      if (repository === undefined) throw unknownTarget();
      if (wslGits.has(repository.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "WSL reveal");
      const names = below(repository.worktreeRoot, request.path);
      if (names === null) throw unknownTarget();
      const { gitInstallationId: _git, ...roots } = repository;
      const reply = await walk(signal, () => readFileFacts(roots, false, [{ root: "worktreeRoot", path: names }]).facts[0]!, "reveal");
      // src-tauri `reveal_deadline`: the deadline gives UNKNOWN_TARGET too.
      if ("stop" in reply) {
        if (reply.stop === "deadline") throw unknownTarget();
        return reply;
      }
      if (reply.kind === "file" || reply.kind === "directory" || (reply.kind === "link" && reply.component === names.length)) return "shown";
      if (reply.kind === "absent") return "absent";
      throw unknownTarget();
    },

    // Feature 005 contract Δ6 `fileDelete` on Windows, as `src-tauri/src/process_requests.rs` `file_delete` and `file_delete.rs` check it:
    // a `started` marker of action `delete-files`, each path below the worktree root, the folder rule, the `recycle` rules, then the checks and the delete.
    // The double moves a Recycle Bin item into its owned `recycle-bin` folder, so no test touches the Windows Recycle Bin. It has no WSL `delete` mode.
    async fileDelete(request, signal): Promise<FileDeleteReply | WalkStop> {
      checkSyncRequest("fileDelete", request);
      frames.push({ type: "fileDelete", ...structuredClone(request) });
      if (inactive.has(request.operationId)) throw unknownTarget();
      if (![...markers.values()].some((m) => m.operationId === request.operationId && m.kind === "workbench" && m.action === "delete-files")) throw new RunnerRefusal("INVALID_REQUEST", "fileDelete action");
      const repository = repositories.get(request.repositoryId);
      if (repository === undefined) throw unknownTarget();
      if (wslGits.has(repository.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "WSL fileDelete");
      const namesOf = (path: string) => below(repository.worktreeRoot, path) ?? invalidRequest("fileDelete path");
      const entries = request.entries.map((e) => ({ names: namesOf(e.path), path: e.path, expected: e.expected }));
      const folders = request.folders.map((path) => ({ names: namesOf(path), path }));
      const shallowest = folders.reduce<(typeof folders)[number] | null>((top, f) => (top === null || f.names.length < top.names.length ? f : top), null);
      if (shallowest !== null && !folders.every((f) => shallowest.names.every((name, i) => f.names[i] === name))) throw new RunnerRefusal("INVALID_REQUEST", "fileDelete folders");
      // `file_delete::MAX_PATH`: a `recycle` path of 260 or more UTF-16 units.
      if (request.mode === "recycle" && entries.some((e) => e.path.length >= 260)) throw new RunnerRefusal("INVALID_REQUEST", "fileDelete long path");
      const { gitInstallationId: _git, ...roots } = repository;
      const reply = await walk(
        signal,
        (): FileDeleteReply => {
          // The checks come first. The delete runs only for the entries that passed (plan.md D7).
          const checked = entries.map((e) => deleteCheck(roots, e.names, e.expected));
          const results: DeleteEntryReply[] = entries.map((e, i) => checked[i] ?? deleteEntry(e.path, request.mode));
          return { entries: results, folders: folders.map((f) => removeFolder(roots, f.names, f.path)) };
        },
        "fileDelete",
      );
      // src-tauri `file_delete_stopped`: a stop or a deadline before the delete phase changes nothing.
      return "stop" in reply ? { result: "stopped" } : reply;
    },

    // Feature 005 contract Δ6 `fileReplace` on Windows, as `src-tauri/src/file_replace.rs` checks it: a `started` marker of the target's action,
    // the exact target, no link on the way, a regular file with one link or an absent file, the expected state, then one atomic replace. It has no WSL `replace` mode.
    async fileReplace(request, signal): Promise<FileReplaceReply | WalkStop> {
      checkSyncRequest("fileReplace", request);
      frames.push({ type: "fileReplace", ...request });
      if (inactive.has(request.operationId)) throw unknownTarget();
      const action = request.target === "gitignore" ? "ignore-save-gitignore" : "ignore-save-exclude";
      if (![...markers.values()].some((m) => m.operationId === request.operationId && m.kind === "workbench" && m.action === action)) throw new RunnerRefusal("INVALID_REQUEST", "fileReplace action");
      const repository = repositories.get(request.repositoryId);
      if (repository === undefined) throw unknownTarget();
      if (wslGits.has(repository.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "WSL fileReplace");
      const root = request.target === "gitignore" ? repository.worktreeRoot : repository.commonDirectory;
      const names = request.target === "gitignore" ? [".gitignore"] : ["info", "exclude"];
      if (resolve(request.path) !== resolve(join(root, ...names))) throw new RunnerRefusal("INVALID_REQUEST", "fileReplace path");
      const bytes = Buffer.from(request.bytes, "base64");
      const reply = await walk(signal, () => replaceFile(root, names, request.expected, bytes), "fileReplace");
      // `file_replace_stopped`: a stop or a deadline before the write writes nothing.
      return "stop" in reply ? { result: "stopped" } : reply;
    },

    // Feature 005 contract Δ6 `shadow`, as `src-tauri/src/shadow.rs` `create`: a new `<pid>-<creation time>-<16 hex>` folder with `s` and `c` below `<launch>/preview`.
    // The leftovers of gone processes and the own folders without a live context go after the reply. The double has no WSL `scratch` mode.
    async shadow(request): Promise<ShadowReply> {
      checkSyncRequest("shadow", request);
      frames.push({ type: "shadow", ...request });
      if (inactive.has(request.operationId)) throw unknownTarget();
      const repository = repositories.get(request.repositoryId);
      if (repository === undefined) throw unknownTarget();
      if (wslGits.has(repository.gitInstallationId)) throw new RunnerRefusal("INVALID_REQUEST", "WSL shadow");
      mkdirSync(previewFolder, { recursive: true });
      const me = `${process.pid}-${processCreationTime(process.pid)}`;
      const live = new Set([...shadows.values()].map((s) => s.folder));
      const leftovers = readdirSync(previewFolder)
        .map((name) => ({ name, owner: /^(\d+)-(\d+)-[0-9a-f]{16}$/.exec(name) }))
        .filter(({ name, owner }) => owner !== null && (`${owner[1]}-${owner[2]}` === me ? !live.has(join(previewFolder, name)) : processCreationTime(Number(owner[1])) !== BigInt(owner[2]!)))
        .map(({ name }) => join(previewFolder, name));
      const folder = join(previewFolder, `${me}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
      try {
        mkdirSync(folder);
        mkdirSync(join(folder, "s"));
        mkdirSync(join(folder, "c"));
      } catch {
        return { result: "error", code: "other-error" };
      }
      const shadowId = crypto.randomUUID();
      shadows.set(shadowId, { operationId: request.operationId, folder });
      setImmediate(() => leftovers.forEach(removeShadow));
      return { shadowId };
    },

    // Feature 003 contract Δ6 `terminal`: a registered Windows Git and, for a `sync` target, a repository of that Git. The double opens no console.
    async terminal(request): Promise<TerminalReply> {
      checkSyncRequest("terminal", request);
      frames.push({ type: "terminal", ...request });
      if (inactive.has(request.operationId) || !gits.has(request.gitInstallationId) || wslGits.has(request.gitInstallationId)) throw unknownTarget();
      if (request.repositoryId !== undefined && repositories.get(request.repositoryId)?.gitInstallationId !== request.gitInstallationId) throw unknownTarget();
      const client = inject.sshClient;
      if (client === "git") throw new RunnerRefusal("INVALID_REQUEST", "terminal needs plink");
      if (!statSync(client.plink, { throwIfNoEntry: false })?.isFile()) return { result: "failed", reason: "missing", program: "plink", path: client.plink };
      return { result: "started" };
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
      if (request.type === "confirmRun") {
        // `callsBefore` orders the frame against the recorded Git calls.
        frames.push({ ...request, callsBefore: calls.length });
        const result = typeof inject.confirmRun === "function" ? await inject.confirmRun(request) : inject.confirmRun;
        return result === "approved" ? { result: "approved" } : { result: "declined" };
      }
      // `callsBefore` orders the frame against the recorded Git calls.
      frames.push({ ...request, callsBefore: calls.length });
      if (inject.confirmResult === "declined") return { result: "declined" };
      const commonIdentity = identityOf(request.commonDirectory);
      const worktreeIdentity = [identityOf(request.worktreeRoot), identityOf(request.adminDirectory)];
      const readable = [commonIdentity, ...worktreeIdentity].every((i) => !("code" in i));
      // Contract §7 "Trust approval store": a failed store leaves the records unchanged.
      if (!readable || inject.trustStoreFails) return { result: "approved", stored: false };
      // A record of the same worktree matches by both identities or by both paths. A version 1 record goes too (feature 004 plan.md O-5).
      trustStore.records = trustStore.records.filter(
        (r) =>
          !(sameIdentity(r.commonIdentity, commonIdentity) && sameIdentity(r.worktreeIdentity, worktreeIdentity)) &&
          !(r.commonDirectory === request.commonDirectory && r.worktreeRoot === request.worktreeRoot),
      );
      // Feature 004 data-model §10.
      const record = {
        policyVersion: 2,
        commonDirectory: request.commonDirectory,
        commonIdentity,
        worktreeRoot: request.worktreeRoot,
        adminDirectory: request.adminDirectory,
        worktreeIdentity,
        gitSelectedPath: request.gitSelectedPath,
        approvedAt: new Date().toISOString(),
      } as Extract<TrustRecord, { policyVersion: 2 }>;
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
    return walk(
      signal,
      () => {
        const { facts, index } = wslFileFacts(operationId, wsl, roots, request.digest, request.files, request.index);
        return { facts, index: index! };
      },
      "fileFacts",
    );
  }

  // src-tauri/src/process_requests.rs `wsl_files`: the fields, the target, then the WSL refusal.
  async function wslFiles(request: WslFilesCall, signal: AbortSignal): Promise<WslFileResult[] | WalkStop> {
    checkWslFiles(request);
    const { operationId, contextKind, gitInstallationId, repositoryId } = request;
    resolveTarget(operationId, { contextKind, gitInstallationId, repositoryId });
    const wsl = wslGits.get(gitInstallationId);
    if (!wsl) throw new RunnerRefusal("INVALID_REQUEST", "wslFiles outside WSL");
    const { gitInstallationId: _git, ...roots } = repositories.get(repositoryId)!;
    return walk(signal, () => wslFilesWalk(operationId, wsl, roots, request), "wslFiles");
  }

  async function wslDistros({ operationId, bootstrapId }: WslDistrosCall): Promise<WslDistrosResult> {
    const bound = contexts.get(bootstrapId);
    if (!isIdentifier(operationId) || !isIdentifier(bootstrapId)) throw new RunnerRefusal("INVALID_REQUEST", "wslDistros");
    if (inactive.has(operationId) || bound?.kind !== "repositoryDiscovery") throw unknownTarget();
    own(bootstrapId, operationId);
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
      if (!seam) exit = await execute(asCall, [WSL_EXE, ...wslHead(call.distro), WSL_TEXTS.probe, "sh", parts.linux], wslDirectory, wslEnvironment());
      else {
        for (let held = holding(startBarriers, asCall); held; held = holding(startBarriers, asCall)) await held.promise;
        if (closing) throw unknownTarget();
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
    cancels,
    // Feature 005: the owned stand-in of the Recycle Bin, and the folder of the shadow folders.
    recycleBin,
    previewFolder,
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
    // The count of recorded fixture processes that still run.
    liveRecorded(): number {
      return live(() => true).length;
    },
    // Returns the bootstrap ID of a new native context.
    addContext(kind: "gitProbe" | "repositoryDiscovery", path: string): string {
      const bootstrapId = crypto.randomUUID();
      // gaps.md W1: a WSL path binds no identity and starts no process at creation.
      contexts.set(bootstrapId, { kind, path, ...(kind === "repositoryDiscovery" && !WSL_PREFIX.test(path) ? { identity: readIdentity(path) } : {}) });
      return bootstrapId;
    },
    // Feature 003 contract Δ3 `clone` native step: one `clone` and one `repositoryDiscovery` context for the checked path. Neither holds an identity.
    // `key` is the picked `.ppk` path. The shell keeps it only in the context (FR-049).
    addClone(path: string, url: string, key?: string): { cloneId: string; bootstrapId: string } {
      const [cloneId, bootstrapId] = [crypto.randomUUID(), crypto.randomUUID()];
      contexts.set(bootstrapId, { kind: "repositoryDiscovery", path, peer: cloneId, pending: true });
      contexts.set(cloneId, { kind: "clone", path, peer: bootstrapId, url, ...(key === undefined ? {} : { key }) });
      return { cloneId, bootstrapId };
    },
    // Feature 004 contract Δ6: the native step of a `worktree-add` review. It replaces each earlier binding of the repository (src-tauri/src/bootstrap.rs `create_worktree_add`).
    addWorktreeAdd(path: string, repositoryId: string): string {
      for (const [id, context] of contexts) if (context.kind === "worktreeAdd" && context.repositoryId === repositoryId) contexts.delete(id);
      const bootstrapId = crypto.randomUUID();
      contexts.set(bootstrapId, { kind: "worktreeAdd", path, repositoryId });
      return bootstrapId;
    },
    // The path of a live native context, or `undefined` after its end.
    contextPath(bootstrapId: string): string | undefined {
      return contexts.get(bootstrapId)?.path;
    },
    // Sends one activity event to each `run` call without an exit reply that `match` accepts, as the shell does (T255). Only a call with `stallMs` gets it.
    // Returns the count of calls that got the event.
    activity(match: CallMatch, state: "stalled" | "active"): number {
      const reached = [...inflight].filter((call) => call.limits.stallMs !== undefined && match(call));
      for (const call of reached) call.onActivity?.(state);
      return reached.length;
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
    // Ends every recorded live process by PID and every running process, then waits a bounded time for their exits and the drains.
    async dispose(): Promise<void> {
      closing = true;
      // Contract Δ6: a service exit removes every shadow folder.
      for (const shadow of shadows.values()) removeShadow(shadow.folder);
      shadows.clear();
      end(() => true);
      for (const operationId of wslUnits.keys()) endWslScopes(operationId);
      const anchors = [...wslAnchors.values()];
      for (const anchor of anchors) anchor.close();
      await Promise.race([Promise.all(anchors.map((anchor) => anchor.proc.exited)), Bun.sleep(DISPOSE_WAIT_MS)]);
      // A child that outlives its ended root, such as a hook `sleep`, keeps its folder open. Windows then refuses the fixture removal.
      for (const tree of trees.values()) tree.end();
      const procs = [...running.values()].flatMap((set) => [...set]);
      for (const proc of procs) proc.kill();
      await Promise.race([Promise.all(procs.map((proc) => proc.exited)), Bun.sleep(DISPOSE_WAIT_MS)]);
      wslAnchors.clear();
      for (const barriers of [startBarriers, stdoutBarriers]) {
        barriers.every?.open();
        barriers.every = null;
        for (const barrier of barriers.matched.splice(0)) barrier.open();
      }
      await Promise.race([Promise.all([...drains]), Bun.sleep(DISPOSE_WAIT_MS)]);
      disposed = true;
      await Promise.race([Promise.all([...drains]), Bun.sleep(DISPOSE_WAIT_MS)]);
      for (const tree of trees.values()) tree.close();
      trees.clear();
    },
  };
}

export type BunRunner = ReturnType<typeof createBunRunner>;
