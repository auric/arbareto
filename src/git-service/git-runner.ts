// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import {
  BOOTSTRAP_DEADLINE_CAP_MS,
  CHANNEL_PATH_UNITS,
  COMMIT_PROCESS_DEADLINE_MS,
  GIT_PROCESS_DEADLINE_MS,
  IDENTITY_PATHS,
  REGISTER_VERSION_BYTES,
  REGISTERED_DEADLINE_CAP_MS,
  STALL_NOTICE_MS,
  STREAMED_PROCESS_INPUT_BYTES,
  SUBMODULE_REVIEW_SUBMODULES,
  SUBMODULE_UPDATE_CEILING_MS,
  SUBMODULE_UPDATE_INACTIVITY_MS,
  UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION,
  WINDOWS_COMMAND_LINE_UNITS,
} from "../contracts/limits";
import { isFingerprint, isIdentifier, MUTATIONS, type OperationName } from "../contracts/operations";

// Contract §7 environment policies. `mutation-trace2` exists only after a supporting T091 result.
export type EnvironmentPolicy = "probe" | "read" | "mutation" | "network";

// Contract §6 "Channel frames" `run` fields: the context IDs of each context kind.
export type ProcessContext =
  | { contextKind: "gitProbe"; bootstrapId: string }
  | { contextKind: "repositoryDiscovery"; bootstrapId: string; gitInstallationId: string }
  | { contextKind: "registeredOperation"; gitInstallationId: string; repositoryId: string };

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

export interface FileIdentity {
  volumeSerial: string;
  fileId: string;
}

export type IdentityReply = FileIdentity | { code: "UNSUPPORTED_REPOSITORY" };

export interface MutationStarted {
  operationId: string;
  repositoryId: string;
  kind: OperationName;
  worktreeRoot: string;
  commonDirectory: string;
}

export type MarkerFailure = "disk-full" | "access-denied" | "other";

// `folder` is the `recovery` folder path.
export type StartedReply = { markerId: string } | { busy: true } | { failure: MarkerFailure; folder: string };

// Contract §6 "Startup handshake": the handshake record form.
export interface TrustRecord {
  commonDirectory: string;
  commonIdentity: FileIdentity;
  worktreeRoot: string;
  gitDirectory: string;
  worktreeIdentity: [FileIdentity, FileIdentity];
  configurationFingerprint: string;
  approvedAt: string;
  gitInstallationDigest: string;
}

// Contract §7 "Program file digests".
export type TrustBound = "file-count" | "file-bytes" | "total-bytes";

type Confirm = { type: "confirm"; worktreeRoot: string; gitDirectory: string; commonDirectory: string; gitInstallationDigest: string; fingerprint: string };

export type TrustRequest =
  | (Confirm & { persist: true })
  | (Confirm & { persist: false; bound: TrustBound })
  | { type: "revoke"; commonDirectory: string }
  | { type: "confirmRun"; worktreeRoot: string; submodulePaths: string[]; programCount: number; uncheckedCount: number };

// `confirm` replies `declined` or `approved` with `stored`. `confirmRun` replies `result` only. `revoke` replies `endedProcesses`.
export type TrustReply =
  | { result: "declined" }
  | { result: "approved"; stored?: false }
  | { result: "approved"; stored: true; record: TrustRecord }
  | { endedProcesses: number };

type RegisterIds = { operationId: string; bootstrapId: string; gitInstallationId: string };

export type RegisterRequest =
  | (RegisterIds & { version: string; confirm: boolean })
  | (RegisterIds & { repositoryId: string; worktreeRoot: string; gitDirectory: string; commonDirectory: string });

export type RegisterReply = { result: "approved" | "declined" } | { result: "another"; bootstrapId: string; executablePath: string };

// Contract §6 "Channel frames" `resolveGit`: `executablePath` is `git.exe` in the folder that `--exec-path` printed.
export type ResolveGitRequest = { operationId: string; bootstrapId: string; executablePath: string };

export interface GitRunner {
  run(call: GitCall): Promise<GitExit>;
  identities(operationId: string, context: ProcessContext, paths: readonly string[]): Promise<IdentityReply[]>;
  lingeringCount(operationId: string, commonDirectory: string): Promise<number>;
  register(request: RegisterRequest): Promise<RegisterReply>;
  // Replies with the `bootstrapId` of the new `gitProbe` context for `executablePath`.
  resolveGit(request: ResolveGitRequest): Promise<{ bootstrapId: string }>;
  release(target: { repositoryId: string } | { gitInstallationId: string }): void;
  closeJob(operationId: string): void;
  started(frame: MutationStarted): Promise<StartedReply>;
  ended(operationId: string, endProcesses: boolean): void;
  resolved(markerId: string): void;
  trust(request: TrustRequest): Promise<TrustReply>;
}

// Contract §6 "Process replies": the `refused` codes. The service refuses its own invalid request with INVALID_REQUEST.
export const REFUSED_CODES = ["INVALID_REQUEST", "UNKNOWN_TARGET", "GIT_CHANGED", "PROCESS_OWNERSHIP_FAILED"] as const;
export type RefusedCode = (typeof REFUSED_CODES)[number];

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

type Check = (value: unknown) => boolean;

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isCount: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const oneOf =
  (...allowed: unknown[]): Check =>
  (v) =>
    allowed.includes(v);

// `optional` names the fields that the object can omit. No other field may exist.
export function exact(value: unknown, fields: Record<string, Check>, optional: readonly string[] = []): boolean {
  if (!isObject(value) || Object.keys(value).some((k) => !Object.hasOwn(fields, k))) return false;
  return Object.entries(fields).every(([k, check]) => (Object.hasOwn(value, k) ? check(value[k]) : optional.includes(k)));
}

// Contract §6 "Process fields": no string holds NUL or a lone surrogate.
const isText = (v: unknown): v is string => typeof v === "string" && !v.includes("\0") && v.isWellFormed();

// Contract §6 "Channel frames": absolute, 1 to 32,767 UTF-16 units. Microsoft Learn "File path formats on Windows systems": a fully qualified path starts with a drive letter and a separator, or with two separators.
// The same page names `\\.\` and `\\?\` device paths. A device such as a pipe can block a read without end.
export function isChannelPath(v: unknown): v is string {
  return isText(v) && v.length <= CHANNEL_PATH_UNITS && /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![.?][\\/]))/.test(v);
}

// Contract §6 "Channel frames" `indexFile`.
const CANDIDATE_PREFIX = "arbareto-candidate-";
const isCandidateIndex = (v: unknown) => isChannelPath(v) && (v.split(/[\\/]/).at(-1) ?? "").startsWith(CANDIDATE_PREFIX);

export function checkContext(context: ProcessContext): boolean {
  switch (context?.contextKind) {
    case "gitProbe":
      return exact(context, { contextKind: oneOf("gitProbe"), bootstrapId: isIdentifier });
    case "repositoryDiscovery":
      return exact(context, { contextKind: oneOf("repositoryDiscovery"), bootstrapId: isIdentifier, gitInstallationId: isIdentifier });
    case "registeredOperation":
      return exact(context, { contextKind: oneOf("registeredOperation"), gitInstallationId: isIdentifier, repositoryId: isIdentifier });
    default:
      return false;
  }
}

// The UTF-16 units of the command line that the shell builds (src-tauri/src/spawn.rs `command_line`), with the terminating null.
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
export function checkCall(call: GitCall): void {
  const { context, arguments: args, environmentPolicy: policy, transaction, input } = call;
  if (!isIdentifier(call.operationId) || !checkContext(context)) refuse("context");
  if (!Array.isArray(args) || !args.every(isText)) refuse("argument");
  // The service has no executable path, so the empty program gives the smallest possible command line.
  if (commandLineUnits("", args) > WINDOWS_COMMAND_LINE_UNITS) refuse("command line");
  const bootstrap = context.contextKind !== "registeredOperation";
  if (context.contextKind === "gitProbe") {
    const probe = args.length === 1 ? args[0] === "--exec-path" : args.length === 2 && args[0] === "version" && args[1] === "--build-options";
    if (!probe) refuse("gitProbe permits only the exec-path and version probes");
  } else if (args[0] !== "--no-lazy-fetch") {
    refuse("first argument must be --no-lazy-fetch");
  }
  // `git-environment.json` has no `network` policy, so the shell refuses it until T228.
  if (bootstrap ? policy !== "probe" : !["read", "mutation"].includes(policy)) refuse("environment policy");
  if (input !== undefined && (!(input instanceof Uint8Array) || input.length > STREAMED_PROCESS_INPUT_BYTES)) refuse("input");
  if (transaction !== undefined) {
    const fits = policy === "mutation" && exact(transaction, { transactionId: isIdentifier, indexFile: isCandidateIndex });
    if (!fits) refuse("transaction");
  }
  if (!limitsFit(call.limits, policy, bootstrap)) refuse("limits");
}

// Contract §6 "Channel frames" `limits`. The WSL distro start cap waits for §11.
function limitsFit(limits: ProcessLimits, policy: EnvironmentPolicy, bootstrap: boolean): boolean {
  const fits = (cap: number) => (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= cap;
  const stall = oneOf(STALL_NOTICE_MS);
  if (policy === "network") {
    return exact(limits, { inactivityMs: fits(SUBMODULE_UPDATE_INACTIVITY_MS), ceilingMs: fits(SUBMODULE_UPDATE_CEILING_MS), stallMs: stall });
  }
  if (bootstrap) return exact(limits, { deadlineMs: fits(BOOTSTRAP_DEADLINE_CAP_MS) });
  return exact(limits, { deadlineMs: fits(REGISTERED_DEADLINE_CAP_MS), stallMs: stall }, ["stallMs"]);
}

export function checkIdentityPaths(paths: readonly string[]): void {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > IDENTITY_PATHS || !paths.every(isChannelPath)) refuse("identity paths");
}

// Contract §6 "Context rules": printable ASCII, as `webView2Version`.
const isVersion: Check = (v) => typeof v === "string" && v.length <= REGISTER_VERSION_BYTES && /^[\x20-\x7e]*$/.test(v);
const isBoolean: Check = (v) => typeof v === "boolean";

// Returns true for a Git registration with `confirm: true`. Only that request can reply `declined` or `another`.
export function checkRegister(request: RegisterRequest): boolean {
  const ids = { operationId: isIdentifier, bootstrapId: isIdentifier, gitInstallationId: isIdentifier };
  if (exact(request, { ...ids, version: isVersion, confirm: isBoolean })) return (request as { confirm: boolean }).confirm;
  const repository = { ...ids, repositoryId: isIdentifier, worktreeRoot: isChannelPath, gitDirectory: isChannelPath, commonDirectory: isChannelPath };
  return exact(request, repository) ? false : refuse("register");
}

export function checkResolveGit(request: ResolveGitRequest): void {
  const isGitFile = (v: unknown) => isChannelPath(v) && /[\\/]git\.exe$/i.test(v);
  if (!exact(request, { operationId: isIdentifier, bootstrapId: isIdentifier, executablePath: isGitFile })) refuse("resolveGit");
}

export function checkRelease(target: { repositoryId: string } | { gitInstallationId: string }): void {
  if (!exact(target, { repositoryId: isIdentifier }) && !exact(target, { gitInstallationId: isIdentifier })) refuse("release");
}

export function checkStarted(frame: MutationStarted): void {
  const fields = { operationId: isIdentifier, repositoryId: isIdentifier, kind: oneOf(...MUTATIONS), worktreeRoot: isChannelPath, commonDirectory: isChannelPath };
  if (!exact(frame, fields)) refuse("started");
}

export function checkTrust(request: TrustRequest): void {
  const confirm = {
    type: oneOf("confirm"),
    worktreeRoot: isChannelPath,
    gitDirectory: isChannelPath,
    commonDirectory: isChannelPath,
    gitInstallationDigest: isFingerprint,
    fingerprint: isFingerprint,
  };
  const run = request as { programCount?: unknown; uncheckedCount?: unknown };
  const fits =
    exact(request, { ...confirm, persist: oneOf(true) }) ||
    exact(request, { ...confirm, persist: oneOf(false), bound: oneOf("file-count", "file-bytes", "total-bytes") }) ||
    exact(request, { type: oneOf("revoke"), commonDirectory: isChannelPath }) ||
    (exact(request, {
      type: oneOf("confirmRun"),
      worktreeRoot: isChannelPath,
      submodulePaths: (v) => Array.isArray(v) && v.length >= 1 && v.length <= SUBMODULE_REVIEW_SUBMODULES && v.every(isChannelPath),
      programCount: (v) => isCount(v) && (v as number) >= 1,
      uncheckedCount: isCount,
    }) &&
      (run.uncheckedCount as number) <= (run.programCount as number));
  if (!fits) refuse("trust");
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
  const reached = (call: GitCall) =>
    (call.environmentPolicy === "network" ? call.stderr.bytes : (totals.get(call.operationId) ?? 0)) >= UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION;
  return {
    // Counts one forwarded stderr chunk after the collector took it. Returns true when the service must send `cancel`.
    add(call: GitCall, bytes: number): boolean {
      if (call.environmentPolicy !== "network") totals.set(call.operationId, (totals.get(call.operationId) ?? 0) + bytes);
      return reached(call);
    },
    reached,
    clear(operationId: string): void {
      totals.delete(operationId);
    },
  };
}
