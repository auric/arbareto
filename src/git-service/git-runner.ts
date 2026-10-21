// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";
import {
  BootstrapLimits,
  CeilingLimits,
  EnvironmentPolicy as EnvironmentPolicySchema,
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
  type FILE_FACT_ERRORS,
  type FileFact,
  type FileIdentity,
  type IdentityReply,
  type MarkerFailure,
  type MutationStarted,
  type RegisterRequest as RegisterRequestBase,
  type ResolveGitRequest,
  type TrustRecord,
  type TrustRecordV2,
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
import type { PUTTY_PROGRAMS, PUTTY_UNAVAILABLE_REASONS } from "../contracts/errors";
import { MATCHING_PROBE_WSL_FOLDER } from "../contracts/matching-probe";
import { NATIVE } from "../contracts/native-path";
import { ChannelPath, Identifier, isIdentifier, Text } from "../contracts/operations";
import wslProcess from "../contracts/wsl-process.json";
import { routeWslPath, wslUnitName } from "../contracts/wsl-route";
import { configGlobalPathArgs, configSystemPathArgs } from "./commands";
import type { FileAppendReply, FileAppendRequest } from "./ignore";
import type { Workspace } from "./registration";

export { isChannelPath } from "../contracts/operations";
export type { FileFact, FileIdentity, IdentityReply, MarkerFailure, MutationStarted, ProcessContext, ResolveGitRequest, TrustRecord, TrustRequest, WslDistrosCall, WslDistrosResult, WslIdentity };
export type { FileAppendReply, FileAppendRequest };

// Contract §6 "Channel frames" `register`: the Git form, the repository form, or the WSL form (§11).
export type RegisterRequest = RegisterRequestBase | RegisterWslCall;

// Contract §7 environment policies, `search` of feature 002 contract Δ7, `remote` and `integrate` of feature 003 contract Δ7, and `mergetool` of feature 004 contract Δ7.
// `mutation-trace2` exists only after a supporting T091 result.
export type EnvironmentPolicy = z.infer<typeof EnvironmentPolicySchema>;

// Feature 003 contract Δ6: these policies take the network limits, and each process counts its own diagnostic bytes.
const NETWORK_POLICIES: ReadonlySet<string> = new Set(["network", "remote", "integrate"]);

// Contract §5: `git` is the 30-second deadline of every other Git process. `network` is a §12 update process.
export type ProcessKind = "git" | "commit" | "network";

// Feature 004 contract Δ6: a `mergetool` run carries the ceiling only (`CeilingLimits`), so it gets no stall notice.
export type ProcessLimits =
  | { deadlineMs: number; stallMs?: number }
  | { inactivityMs: number; ceilingMs: number; stallMs: number }
  | { ceilingMs: number; stallMs?: undefined };

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
  // Feature 002 contract Δ6: the shell runs its fixed WSL script, and `arguments` are the script arguments.
  script?: "matchingProbe";
  limits: ProcessLimits;
  stdout: Collector;
  stderr: Collector;
  signal: AbortSignal;
  onActivity?: (state: "stalled" | "active") => void;
}

// Contract §6: the exit reply follows the forwarded bytes. `deadline` names the expired limit.
export interface GitExit {
  exitCode: number | null;
  // Null: the shell has no count. Null is never a process-end fact.
  activeDescendants: number | null;
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
  | { result: "approved"; stored: true; record: TrustRecordV2 }
  | { endedProcesses: number };

export type RegisterReply = { result: "approved" | "declined" } | { result: "another"; bootstrapId: string; executablePath: string };

// Feature 004 contract Δ6 `reveal {repositoryId, path}`: the frame without `type` and `callId`.
export type RevealRequest = Omit<Extract<z.infer<typeof ProcessRequest>, { type: "reveal" }>, "type" | "callId">;

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
  // Feature 004 contract Δ6 `fileAppend`: a walk without a deadline form, so the shell gives `error` past its deadline. A `refused` frame throws RunnerRefusal.
  fileAppend(request: FileAppendRequest, signal: AbortSignal): Promise<FileAppendReply | WalkStop>;
  // Feature 004 contract Δ3 `revealPath`: a walk. The shell refuses each failure with UNKNOWN_TARGET, so a `refused` frame throws RunnerRefusal.
  reveal(request: RevealRequest, signal: AbortSignal): Promise<"shown" | WalkStop>;
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

type FileFactError = (typeof FILE_FACT_ERRORS)[number];

// Feature 003 contract Δ6 `pageant {repositoryId, remote}` or `{cloneId}`: the frame fields without `type` and `callId`.
export type PageantRequest = { operationId: string; repositoryId: string; remote: string } | { operationId: string; cloneId: string };
type PuttyFailed = { result: "failed"; reason: (typeof PUTTY_UNAVAILABLE_REASONS)[number]; program: (typeof PUTTY_PROGRAMS)[number]; path: string };
// The reply without `type` and `callId`. `git`: `sshClient` is `git`, and the shell started no process.
export type PageantReply = { result: "git" | "none" | "ready" } | PuttyFailed;
// Feature 003 contract Δ6 `destinationFacts {cloneId}`. A link or a junction gives `other`.
export type DestinationFactsReply = { result: "absent" | "empty" | "not-empty" | "file" | "other" } | { result: "error"; code: FileFactError };
// Feature 004 contract Δ6: the `worktreeAdd` form names the binding by `bootstrapId`, and its reply adds the bound path in Git's form for the route.
export type WorktreeAddFactsReply = DestinationFactsReply & { path: string };
export type DestinationFactsRequest = { operationId: string; cloneId: string } | { operationId: string; bootstrapId: string };
// Feature 003 contract Δ6 `terminal`. `repositoryId` names the worktree of a `sync` target. A `clone` target has none.
export interface TerminalRequest {
  operationId: string;
  gitInstallationId: string;
  repositoryId?: string;
  target: string;
}
export type TerminalReply = { result: "started" } | PuttyFailed;

// Feature 003 contract Δ6: the private requests of `sync`, `clone`, and `connectInTerminal`. Only a Windows service sends `pageant` and `terminal`.
export interface SyncRunner {
  pageant(request: PageantRequest): Promise<PageantReply>;
  // Only the reply to the `worktreeAdd` form carries `path`.
  destinationFacts(request: DestinationFactsRequest): Promise<DestinationFactsReply | WorktreeAddFactsReply>;
  terminal(request: TerminalRequest): Promise<TerminalReply>;
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

// Feature 003 contract Δ3 `clone` step 4: the items before the URL and the destination.
const CLONE_PREFIX = ["--no-lazy-fetch", "clone", "--progress", "--no-recurse-submodules", "--"];

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

// Contract §11 "Process launch": the `wsl.exe` program and the approved paths of a WSL Git.
export interface WslLaunch {
  wslExecutable: string;
  distro: string;
  git: string;
  systemdRun: string;
  systemctl: string;
  setsid: string;
  // The probe fact `noexpand 0`. The 7th wrapper argument `noexp` is `1` then, and empty otherwise.
  noexpand: boolean;
}

// The shell keeps `<n>` as a `u32` (src-tauri/src/process_requests.rs `next_unit`), so this is its widest form.
const WIDEST_UNIT = 4_294_967_295;
const WRAPPER = wslProcess.wrapper.join("\n");

// Contract §6 "Process fields": the units of the `wsl.exe` command line that the shell builds (src-tauri/src/wsl.rs `git_command` and `wrapped`).
// `args` start with `--no-lazy-fetch`. The shell puts `-C <directory>` right after it.
export function wslCommandLineUnits(launch: WslLaunch, operationId: string, mode: string, index: string, directory: string, args: readonly string[]): number {
  const head = ["--distribution", launch.distro, "--cd", "/", "--exec", "/bin/sh", "-c", WRAPPER, "sh", wslUnitName(operationId, WIDEST_UNIT), mode, index];
  return commandLineUnits(launch.wslExecutable, [...head, launch.systemdRun, launch.systemctl, launch.setsid, launch.noexpand ? "1" : "", launch.git, "--no-lazy-fetch", "-C", directory, ...args.slice(1)]);
}

// Contract §6 "Process fields": the units of the command line that the shell starts for one call under `policy`.
// The shell starts a Windows Git as `executablePath`, the Git file in the `--exec-path` folder, and a WSL Git through `wsl.exe`.
export function stepUnits(ctx: { operationId: string; workspace: Pick<Workspace, "worktreeRoot" | "wsl">; installation: { executablePath: string } }, policy: EnvironmentPolicy, args: readonly string[]): number {
  const w = ctx.workspace.wsl;
  if (w === undefined) return commandLineUnits(ctx.installation.executablePath, args);
  const route = routeWslPath(ctx.workspace.worktreeRoot, { listed: [w.distro], registry: [{ name: w.distro, guid: w.guid, version: 2 }] });
  if (route.kind !== "wsl") throw new TypeError("a WSL workspace needs a Linux worktree root");
  const launch = { wslExecutable: w.wslExecutable, distro: w.distro, git: w.path, systemdRun: w.systemdRun, systemctl: w.systemctl, setsid: w.setsid, noexpand: w.noexpand };
  return wslCommandLineUnits(launch, ctx.operationId, policy, "", route.linuxPath, args);
}

// The policies of each context kind, as src-tauri/src/process_requests.rs `policy_fits` admits them (feature 004 contract Δ6).
const CONTEXT_POLICIES: Record<ProcessContext["contextKind"], readonly EnvironmentPolicy[]> = {
  gitProbe: ["probe"],
  repositoryDiscovery: ["probe"],
  registeredOperation: ["read", "mutation", "network", "search", "remote", "integrate", "mergetool"],
  clone: ["remote"],
  globalConfig: ["read", "integrate"],
  worktreeAdd: ["integrate"],
};

// Feature 004 contract Δ6: the three `globalConfig` arrays, each with the policy of its contract Δ3 step (src-tauri `global_config_fits`).
function globalConfigFits(args: readonly string[], policy: EnvironmentPolicy): boolean {
  const list = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "config", "list", "--show-scope", "--show-origin", "-z"];
  if (args.length === list.length && list.every((arg, i) => args[i] === arg)) return policy === "read";
  const write = (args.length === 7 && args[2] === "set") || (args.length === 6 && args[2] === "unset");
  return write && args[0] === "--no-lazy-fetch" && args[1] === "config" && args[3] === "--global" && args[4] === "--" && policy === "integrate";
}

// Git 2.55 `git.c` `handle_options`: the global options that take the next item as their value (src-tauri `VALUE_OPTIONS`).
const VALUE_OPTIONS: ReadonlySet<string> = new Set(["--git-dir", "--namespace", "--work-tree", "-c", "--config-env", "--shallow-file", "-C", "--attr-source"]);

// Feature 004 contract Δ6: `worktree add` and `clone` write a folder that only their bound contexts name (src-tauri `runs_bound_command`).
// `handle_options` stops at the first item without `-` and at the help and version options.
function runsBoundCommand(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-") && !["--help", "-h", "--version", "-v"].includes(args[i]!)) i += VALUE_OPTIONS.has(args[i]!) ? 2 : 1;
  return args[i] === "clone" || (args[i] === "worktree" && args[i + 1] === "add");
}

// Feature 004 contract Δ3 and Δ6: `worktree add [-b <new>] -- <path> <commit>`. The shell also checks the path against its binding (src-tauri `worktree_add_fits`).
const worktreeAddForm = (args: readonly string[]): boolean =>
  args[0] === "--no-lazy-fetch" && args[1] === "worktree" && args[2] === "add" && (args.length === 6 ? args[3] === "--" : args.length === 8 && args[3] === "-b" && args[5] === "--");

// Contract §6 "Process fields" and §7 "Missing objects". A refused call starts no process.
// The schemas check each field. The rules between fields stay here.
export function checkCall(call: GitCall): void {
  const { context, arguments: args, environmentPolicy: policy, transaction, input } = call;
  if (!isIdentifier(call.operationId) || !checkContext(context)) refuse("context");
  if (!Array.isArray(args) || !args.every((arg) => fits(Text, arg))) refuse("argument");
  // The service has no executable path, so the empty program gives the smallest possible command line.
  if (commandLineUnits("", args) > WINDOWS_COMMAND_LINE_UNITS) refuse("command line");
  // Feature 003 contract Δ6: a `clone` context runs only the fixed clone array under `remote`.
  const kind = context.contextKind;
  const clone = kind === "clone";
  const bootstrap = kind === "gitProbe" || kind === "repositoryDiscovery";
  if (clone && (policy !== "remote" || args.length !== 7 || !CLONE_PREFIX.every((arg, i) => args[i] === arg))) refuse("clone");
  if (call.script !== undefined) {
    checkProbeScript(call);
  } else if (context.contextKind === "gitProbe") {
    const probe = args.length === 1 ? args[0] === "--exec-path" : args.length === 2 && args[0] === "version" && args[1] === "--build-options";
    // Contract §6 `gitProbe`: the shell also admits the two exact `git var` arrays of §7 "Configuration file paths".
    const paths = [configSystemPathArgs(), configGlobalPathArgs()].some((known) => known.length === args.length && known.every((arg, i) => arg === args[i]));
    if (!probe && !paths) refuse("gitProbe permits only the exec-path, version, and configuration path probes");
  } else if (args[0] !== "--no-lazy-fetch") {
    refuse("first argument must be --no-lazy-fetch");
  }
  if (!CONTEXT_POLICIES[kind].includes(policy)) refuse("environment policy");
  if (kind === "globalConfig" && !globalConfigFits(args, policy)) refuse("globalConfig");
  if (kind === "worktreeAdd" && !worktreeAddForm(args)) refuse("worktreeAdd");
  if (kind === "registeredOperation" && call.script === undefined && runsBoundCommand(args)) refuse("bound command");
  if (input !== undefined && (!(input instanceof Uint8Array) || input.length > STREAMED_PROCESS_INPUT_BYTES)) refuse("input");
  // Feature 004 contract Δ6: the shell gives a `mergetool` child a closed stdin pipe.
  if (policy === "mergetool" && input !== undefined) refuse("input");
  if (transaction !== undefined && !(policy === "mutation" && fits(Transaction, transaction))) refuse("transaction");
  // Contract §6 "Channel frames" `limits`. The WSL distro start cap waits for §11.
  const limits = NETWORK_POLICIES.has(policy) ? NetworkLimits : policy === "mergetool" ? CeilingLimits : bootstrap ? BootstrapLimits : RegisteredLimits;
  if (!fits(limits, call.limits)) refuse("limits");
}

// Feature 002 contract Δ6: the checks of src-tauri/src/wsl.rs `matching_probe_command` and the `run` route of the shell.
// The script evaluates `$((2 * count))`, and a bash `/bin/sh` runs a command in an array subscript there, so the run length holds only digits.
function checkProbeScript(call: GitCall): void {
  const [folder = "", tip = "", length = "", ...runs] = call.arguments;
  const count = /^[1-9][0-9]*$/.test(length) ? Number(length) : 0;
  const owned = folder.startsWith(MATCHING_PROBE_WSL_FOLDER) && isIdentifier(folder.slice(MATCHING_PROBE_WSL_FOLDER.length));
  const valid =
    call.script === "matchingProbe" &&
    call.context.contextKind === "registeredOperation" &&
    call.environmentPolicy === "search" &&
    owned &&
    /^[0-9a-f]{40}$/.test(tip) &&
    count >= 1 &&
    runs.length === 2 * count &&
    runs[0] === "--no-lazy-fetch" &&
    runs[count] === "--no-lazy-fetch";
  if (!valid) refuse("matchingProbe");
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
  remove: ["removed", "notOwned", "error"],
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

// Feature 003 and feature 004 contract Δ6. The `type` literal selects the frame schema. A request that holds `type` or `callId` breaks the field set.
export function checkSyncRequest(type: "pageant" | "destinationFacts" | "terminal" | "fileAppend" | "reveal", request: object): void {
  const valid = typeof request === "object" && request !== null && !("type" in request) && !("callId" in request);
  if (!valid || !fits(ProcessRequest, { type, callId: crypto.randomUUID(), ...request })) refuse(type);
}
export const checkPageant = (request: PageantRequest): void => checkSyncRequest("pageant", request);

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
        chunks.push(new Uint8Array(chunk.subarray(0, end)));
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

// Contract §6 "Byte caps": one count of forwarded stderr bytes per operation. A call of a network policy counts only its own bytes (feature 003 contract Δ5).
export function createDiagnosticCounter() {
  const totals = new Map<string, number>();
  type Counted = Pick<GitCall, "operationId" | "environmentPolicy" | "stderr">;
  const reached = (call: Counted) =>
    (NETWORK_POLICIES.has(call.environmentPolicy) ? call.stderr.bytes : (totals.get(call.operationId) ?? 0)) >= UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION;
  return {
    // Counts one forwarded stderr chunk after the collector took it. Returns true when the service must send `cancel`.
    add(call: Counted, bytes: number): boolean {
      if (!NETWORK_POLICIES.has(call.environmentPolicy)) totals.set(call.operationId, (totals.get(call.operationId) ?? 0) + bytes);
      return reached(call);
    },
    reached,
    clear(operationId: string): void {
      totals.delete(operationId);
    },
  };
}
