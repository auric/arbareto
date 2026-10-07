// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import {
  BootstrapLimits,
  NetworkLimits,
  ProcessContext,
  ProcessRequest,
  RegisteredLimits,
  RegisterGitCall,
  RegisterRepositoryCall,
  RegisterWslCall,
  ReleaseCall,
  ResolveGitCall,
  StartedCall,
  TrustCall,
  WslDistrosCall,
  WslProbeCall,
  type FileFact,
  type FileIdentity,
  type IdentityReply,
  type MarkerFailure,
  type MutationStarted,
  type RegisterRequest as RegisterRequestBase,
  type ResolveGitRequest,
  type TrustBound,
  type TrustRecord,
  type TrustRequest,
  type WslDistrosResult,
  type WslFileResult,
  type WslFilesCall,
  type WslIndexResult,
  type WslIdentity,
} from "../contracts/channel";
import {
  COMMIT_PROCESS_DEADLINE_MS,
  GIT_PROCESS_DEADLINE_MS,
  IDENTITY_PATHS,
  STALL_NOTICE_MS,
  STREAMED_PROCESS_INPUT_BYTES,
  SUBMODULE_UPDATE_CEILING_MS,
  SUBMODULE_UPDATE_INACTIVITY_MS,
  UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION,
  WINDOWS_COMMAND_LINE_UNITS,
} from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import { ChannelPath, Identifier, isIdentifier, Text } from "../contracts/operations";
import { configGlobalPathArgs, configSystemPathArgs } from "./commands";

export { isChannelPath } from "../contracts/operations";
export type { FileFact, FileIdentity, IdentityReply, MarkerFailure, MutationStarted, ProcessContext, ResolveGitRequest, TrustBound, TrustRecord, TrustRequest, WslDistrosCall, WslDistrosResult, WslIdentity };

// Contract §6 "Channel frames" `register`: the Git form, the repository form, or the WSL form (§11).
export type RegisterRequest = RegisterRequestBase | RegisterWslCall;

// Contract §7 environment policies. `mutation-trace2` exists only after a supporting T091 result.
export type EnvironmentPolicy = "probe" | "read" | "mutation" | "network";

// Contract §5: `git` is the 30-second deadline of every other Git process. `network` is a §12 update process.
export type ProcessKind = "git" | "commit" | "network";

export type ProcessLimits =
  | { deadlineMs: number; stallMs?: number }
  | { inactivityMs: number; ceilingMs: number; stallMs: number };

export const PROCESS_LIMITS: Record<ProcessKind, ProcessLimits> = {
  git: { deadlineMs: GIT_PROCESS_DEADLINE_MS },
  commit: { deadlineMs: COMMIT_PROCESS_DEADLINE_MS, stallMs: STALL_NOTICE_MS },
  network: { inactivityMs: SUBMODULE_UPDATE_INACTIVITY_MS, ceilingMs: SUBMODULE_UPDATE_CEILING_MS, stallMs: STALL_NOTICE_MS },
};

export interface Collector {
  push(chunk: Uint8Array): void;
  // Every pushed byte and record, also after `limited`.
  readonly bytes: number;
  readonly records: number;
  readonly limited: boolean;
}

export interface GitCall {
  operationId: string;
  context: ProcessContext;
  arguments: readonly string[];
  // Contract §5: at most 64 KiB travels inline. Larger input streams, up to 512 MiB.
  input?: Uint8Array;
  environmentPolicy: EnvironmentPolicy;
  // Contract §6: only the `mutation` policy. `indexFile` is a candidate index in the registered Git directory.
  transaction?: { transactionId: string; indexFile: string };
  limits: ProcessLimits;
  stdout: Collector;
  stderr: Collector;
  signal: AbortSignal;
  onActivity?: (state: "stalled" | "active") => void;
}

// Contract §6: the exit reply follows the forwarded bytes. `deadline` names the expired limit.
export interface GitExit {
  exitCode: number | null;
  activeDescendants: number;
  deadline?: "deadline" | "inactivity" | "ceiling";
  // Contract §5 "Total unexpected diagnostic output": the counted stderr reached 4 MiB, and the service sent `cancel`.
  diagnosticLimit?: true;
}

// The parsed `started` reply without `type` and `callId`. `folder` is the `recovery` folder path.
export type StartedReply = { markerId: string } | { busy: true } | { failure: MarkerFailure; folder: string };

// `confirm` replies `declined` or `approved` with `stored`. `confirmRun` replies `result` only. `revoke` replies `endedProcesses`.
export type TrustReply =
  | { result: "declined" }
  | { result: "approved"; stored?: false }
  | { result: "approved"; stored: true; record: TrustRecord }
  | { endedProcesses: number };

export type RegisterReply = { result: "approved" | "declined" } | { result: "another"; bootstrapId: string; executablePath: string };

// Contract §6 "File facts": the `FileFacts` frame without `type` and `callId`. `index` goes through `indexedFileFacts`.
export type FileFactsRequest = Omit<Extract<z.infer<typeof ProcessRequest>, { type: "fileFacts" }>, "type" | "callId" | "index">;
// Contract §6 "Index digest in a read": a WSL `fileFacts` request with `index`.
export type IndexedFileFactsRequest = FileFactsRequest & { index: { sharedIndex?: string } };
export type { WslFileResult, WslFilesCall, WslIndexResult };

// Contract §6 "Walks": an `identity` or `fileFacts` call without its value.
// `deadline`: the walk passed its §5 deadline. `canceled`: the signal aborted the call, and the service sent `cancel`.
export type WalkStop = { stop: "canceled" | "deadline" };
// Contract §6 "Walks" (T314): a `lingeringCount`, `register`, `resolveGit`, `started`, or `revoke` call past its deadline.
// The service sends no `cancel` for these calls, so only the deadline stops them.
export type WalkDeadline = { stop: "deadline" };

export interface GitRunner {
  run(call: GitCall): Promise<GitExit>;
  identities(operationId: string, context: ProcessContext, paths: readonly string[], signal: AbortSignal): Promise<IdentityReply[] | WalkStop>;
  // Replies with one fact per entry, in request order.
  fileFacts(request: FileFactsRequest, signal: AbortSignal): Promise<FileFact[] | WalkStop>;
  lingeringCount(operationId: string, commonDirectory: string): Promise<number | WalkDeadline>;
  register(request: RegisterRequest): Promise<RegisterReply | WalkDeadline>;
  // Replies with the `bootstrapId` of the new `gitProbe` context for `executablePath`.
  resolveGit(request: ResolveGitRequest): Promise<{ bootstrapId: string } | WalkDeadline>;
  release(target: { repositoryId: string } | { gitInstallationId: string }): void;
  closeJob(operationId: string): void;
  started(frame: MutationStarted): Promise<StartedReply | WalkDeadline>;
  ended(operationId: string, endProcesses: boolean): void;
  resolved(markerId: string): void;
  // Only `revoke` can end with the deadline.
  trust(request: TrustRequest): Promise<TrustReply | WalkDeadline>;
}

// Contract §6 "Channel frames" `wslProbe`: the frame fields and the output collectors of the streamed probe.
export interface WslProbeRun extends WslProbeCall {
  stdout: Collector;
  stderr: Collector;
  signal: AbortSignal;
}

// Contract §11: the WSL frames. Only a Windows service sends them.
export interface WslRunner {
  // The context path, and for a WSL prefix also the distro facts.
  wslDistros(call: WslDistrosCall): Promise<WslDistrosResult>;
  // Streams and exits as `run`.
  wslProbe(call: WslProbeRun): Promise<GitExit>;
  // Contract §6 "WSL file work": one result per `digest` entry, or one result for another mode.
  wslFiles(request: WslFilesCall, signal: AbortSignal): Promise<WslFileResult[] | WalkStop>;
  // Contract §6 "Index digest in a read": the facts and the `indexDigest` result of one `fileFacts` request.
  indexedFileFacts(request: IndexedFileFactsRequest, signal: AbortSignal): Promise<{ facts: FileFact[]; index: WslIndexResult } | WalkStop>;
}

export { REFUSED_CODES } from "../contracts/channel";
export type RefusedCode = "INVALID_REQUEST" | "UNKNOWN_TARGET" | "GIT_CHANGED" | "PROCESS_OWNERSHIP_FAILED";

export class RunnerRefusal extends Error {
  constructor(
    readonly code: RefusedCode,
    detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

const refuse = (detail: string): never => {
  throw new RunnerRefusal("INVALID_REQUEST", detail);
};

const fits = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

// Contract §6 "Channel frames" `indexFile`: a candidate index name.
const CANDIDATE_PREFIX = "arbareto-candidate-";
const Transaction = z.strictObject({
  transactionId: Identifier,
  indexFile: ChannelPath.refine((path) => (path.split(NATIVE.separator).at(-1) ?? "").startsWith(CANDIDATE_PREFIX)),
});
const IdentityPaths = z.array(ChannelPath).min(1).max(IDENTITY_PATHS);

export const checkContext = (context: ProcessContext): boolean => fits(ProcessContext, context);

// The UTF-16 units of the command line that the shell builds (src-tauri/src/spawn.rs `command_line`), with the terminating null.
// Every platform keeps this Windows bound. It is stricter than the Linux and macOS `execve` bounds, such as 128 KiB for each Linux argument.
export function commandLineUnits(program: string, args: readonly string[]): number {
  let units = program.length + 3;
  for (const arg of args) {
    const quote = arg === "" || arg.includes(" ") || arg.includes("\t");
    units += 1 + arg.length + (quote ? 2 : 0);
    // A run of backslashes before a quote doubles, and the quote gets one more backslash.
    for (const m of arg.matchAll(/(\\*)"/g)) units += m[1].length + 1;
    if (quote) units += /\\*$/.exec(arg)![0].length;
  }
  return units;
}

// Contract §6 "Process fields" and §7 "Missing objects". A refused call starts no process.
// The schemas check each field. The rules between fields stay here.
export function checkCall(call: GitCall): void {
  const { context, arguments: args, environmentPolicy: policy, transaction, input } = call;
  if (!isIdentifier(call.operationId) || !checkContext(context)) refuse("context");
  if (!Array.isArray(args) || !args.every((arg) => fits(Text, arg))) refuse("argument");
  // The service has no executable path, so the empty program gives the smallest possible command line.
  if (commandLineUnits("", args) > WINDOWS_COMMAND_LINE_UNITS) refuse("command line");
  const bootstrap = context.contextKind !== "registeredOperation";
  if (context.contextKind === "gitProbe") {
    const probe = args.length === 1 ? args[0] === "--exec-path" : args.length === 2 && args[0] === "version" && args[1] === "--build-options";
    // Contract §6 `gitProbe`: the shell also admits the two exact `git var` arrays of §7 "Configuration file paths".
    const paths = [configSystemPathArgs(), configGlobalPathArgs()].some((known) => known.length === args.length && known.every((arg, i) => arg === args[i]));
    if (!probe && !paths) refuse("gitProbe permits only the exec-path, version, and configuration path probes");
  } else if (args[0] !== "--no-lazy-fetch") {
    refuse("first argument must be --no-lazy-fetch");
  }
  // `git-environment.json` has no `network` policy, so the shell refuses it until T228.
  if (bootstrap ? policy !== "probe" : !["read", "mutation"].includes(policy)) refuse("environment policy");
  if (input !== undefined && (!(input instanceof Uint8Array) || input.length > STREAMED_PROCESS_INPUT_BYTES)) refuse("input");
  if (transaction !== undefined && !(policy === "mutation" && fits(Transaction, transaction))) refuse("transaction");
  // Contract §6 "Channel frames" `limits`. The WSL distro start cap waits for §11.
  if (!fits(policy === "network" ? NetworkLimits : bootstrap ? BootstrapLimits : RegisteredLimits, call.limits)) refuse("limits");
}

export function checkIdentityPaths(paths: readonly string[]): void {
  if (!fits(IdentityPaths, paths)) refuse("identity paths");
}

// The `type` literal selects the `FileFacts` frame schema. A request that holds `type` or `callId` breaks the field set.
export function checkFileFacts(request: FileFactsRequest | IndexedFileFactsRequest, indexed = false): void {
  const valid = typeof request === "object" && request !== null && !("type" in request) && !("callId" in request) && "index" in request === indexed;
  if (!valid || !fits(ProcessRequest, { type: "fileFacts", callId: crypto.randomUUID(), ...request })) refuse("fileFacts");
}

export function checkWslFiles(request: WslFilesCall): void {
  const valid = typeof request === "object" && request !== null && !("type" in request) && !("callId" in request);
  if (!valid || !fits(ProcessRequest, { type: "wslFiles", callId: crypto.randomUUID(), ...request })) refuse("wslFiles");
}

// The result kinds of each `wslFiles` mode (contract §6 "WSL file work").
const ENTRY_KINDS = ["file", "directory", "link", "absent", "other", "error"];
const MODE_KINDS: Record<WslFilesCall["mode"], readonly string[]> = {
  digest: ENTRY_KINDS,
  indexDigest: ["index", "error"],
  hashObject: [...ENTRY_KINDS, "object"],
  catFile: ["blob", "error"],
  lock: ["lock", "locked", "error"],
  candidate: ["candidate", "absent", "bound", "error"],
  publish: ["published", "mismatch", "notOwned", "error"],
};

// The rules between a request and its results that the reply schema cannot state.
export function wslResultsFit(request: WslFilesCall, results: readonly WslFileResult[]): boolean {
  const entries = "files" in request ? request.files : [];
  if (results.length !== (request.mode === "digest" ? entries.length : 1)) return false;
  return results.every((result, i) => {
    if (!MODE_KINDS[request.mode].includes(result.kind)) return false;
    const components = entries[i]?.path.length ?? 0;
    if (result.kind === "error") return result.component <= components;
    if (result.kind === "link") return result.component >= 1 && result.component <= components && (result.targetBytes !== undefined) === (result.component === components);
    if (result.kind === "file") return result.bound === undefined ? request.mode === "digest" : result.bound === request.bound;
    if (result.kind === "index") return indexFits(result, request.mode === "indexDigest" ? request.sharedIndex : undefined);
    return true;
  });
}

// A shared part comes exactly when the request names a shared index.
export function indexFits(result: WslIndexResult, sharedIndex: string | undefined): boolean {
  return result.kind === "error" ? result.component === 0 : (result.sharedIndex !== undefined) === (sharedIndex !== undefined);
}

// The replies that each register form permits. Only a Git registration with `confirm: true` can reply `another`.
export function checkRegister(request: RegisterRequest): "approved" | "confirm" | "wsl" {
  const git = RegisterGitCall.safeParse(request);
  if (git.success) return git.data.confirm ? "confirm" : "approved";
  if (fits(RegisterRepositoryCall, request)) return "approved";
  return fits(RegisterWslCall, request) ? "wsl" : refuse("register");
}

export function checkWslDistros(call: WslDistrosCall): void {
  if (!fits(WslDistrosCall, call)) refuse("wslDistros");
}

// The schema checks the frame fields. The collectors and the signal stay local.
export function checkWslProbe(call: WslProbeRun): void {
  const { stdout: _stdout, stderr: _stderr, signal: _signal, ...frame } = call;
  if (!fits(WslProbeCall, frame)) refuse("wslProbe");
}

export function checkResolveGit(request: ResolveGitRequest): void {
  if (!fits(ResolveGitCall, request)) refuse("resolveGit");
}

export function checkRelease(target: { repositoryId: string } | { gitInstallationId: string }): void {
  if (!fits(ReleaseCall, target)) refuse("release");
}

export function checkStarted(frame: MutationStarted): void {
  if (!fits(StartedCall, frame)) refuse("started");
}

export function checkTrust(request: TrustRequest): void {
  if (!fits(TrustCall, request)) refuse("trust");
}

// Retains at most `maxBytes` bytes and `maxRecords` records that end at `separator`. A byte that it cannot retain sets `limited`.
export function createCollector(options: { maxBytes: number; maxRecords?: number; separator?: number }) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let records = 0;
  let kept = 0;
  let keptRecords = 0;
  let limited = false;
  return {
    push(chunk: Uint8Array): void {
      bytes += chunk.length;
      let end = limited ? 0 : Math.min(chunk.length, options.maxBytes - kept);
      if (options.separator !== undefined) {
        for (let i = 0; i < chunk.length; i++) {
          if (i < end && options.maxRecords !== undefined && keptRecords >= options.maxRecords) end = i;
          if (chunk[i] !== options.separator) continue;
          records++;
          if (i < end) keptRecords++;
        }
      }
      if (end < chunk.length) limited = true;
      if (end > 0) {
        chunks.push(chunk.slice(0, end));
        kept += end;
      }
    },
    get bytes() {
      return bytes;
    },
    get records() {
      return records;
    },
    get limited() {
      return limited;
    },
    take(): Uint8Array {
      const out = new Uint8Array(kept);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },
  };
}

// Contract §6 "Byte caps": one count of forwarded stderr bytes per operation. A `network` call counts only its own bytes.
export function createDiagnosticCounter() {
  const totals = new Map<string, number>();
  type Counted = Pick<GitCall, "operationId" | "environmentPolicy" | "stderr">;
  const reached = (call: Counted) =>
    (call.environmentPolicy === "network" ? call.stderr.bytes : (totals.get(call.operationId) ?? 0)) >= UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION;
  return {
    // Counts one forwarded stderr chunk after the collector took it. Returns true when the service must send `cancel`.
    add(call: Counted, bytes: number): boolean {
      if (call.environmentPolicy !== "network") totals.set(call.operationId, (totals.get(call.operationId) ?? 0) + bytes);
      return reached(call);
    },
    reached,
    clear(operationId: string): void {
      totals.delete(operationId);
    },
  };
}
