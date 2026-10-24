// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The in-process service of the batch 2 tests: `createSession` with the `bun-runner.ts` shell double.
// Its imports must load off Windows without `dlopen` (tests/git/portable-imports.test.ts).

import { expect, spyOn, test } from "bun:test";
import { chmodSync, closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Handshake, MutationStarted, TrustAction, TrustDetails } from "../../src/contracts/channel";
import {
  DictionaryRunResult,
  ListDictionariesResult,
  ReadBlameResult,
  ReadBranchesResult,
  ReadCommitChangesResult,
  ReadCommitFileResult,
  ReadDictionaryResult,
  ReadGitSettingsResult,
  ReadWorktreesResult,
  RemoveDictionaryResult,
  ReviewCommitResult,
  ReviewWorkbenchResult,
  RunWorkbenchResult,
} from "../../src/contracts/envelope";
import { PIPE_FRAME_BYTES, READ_DEADLINE_MS, RECONCILIATION_TARGET_MS } from "../../src/contracts/limits";
import { isObject } from "../../src/contracts/strict-json";
import type { HunkCheckpoint } from "../../src/git-service/hunk-publish";
import * as registrationModule from "../../src/git-service/registration";
import { createSession, type SessionOptions } from "../../src/git-service/session";
import { FrameBoundError, type Frame } from "../../src/git-service/transport";
import { printOrigin } from "../origin";
import { createBunRunner, createTrustStore, type BunRunner, type CallMatch, type TrustStore } from "./bun-runner";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_HOME, FIXTURE_ROOT, fixtureDir, fixtureEnv, serviceEnv } from "./fixture-root";
import { fixtureGitPath, GIT } from "./git-binary";
import { gitOpenssl } from "./http-401";
import { sshTools } from "../support/ssh-server";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

export type Capability = "shell-double" | "windows-path-rules" | "powershell" | "ntfs-junction" | "git-for-windows" | "other-account-owner" | "no-enclosing-repository" | "read-denial" | "symlink" | "fifo" | "pwsh" | "windows-powershell" | "disposable-volume" | "restart-keeps-lingering" | "openssh" | "openssl" | "ssh-server" | "ssh-key" | "local-ssh-server";

const WINDOWS = process.platform === "win32";
const LINUX = process.platform === "linux";

// Runs the test Git with the owned environment and the fixed C locale of the `probe` policy.
function probe(args: string[], cwd?: string): { exitCode: number; stdout: string; stderr: string } | null {
  if (GIT === null) return null;
  const proc = Bun.spawnSync([fixtureGitPath(GIT), ...args], { cwd, env: fixtureEnv({ LC_ALL: "C" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// `src/git-service/admission.ts`: a Git for Windows version ends in `.windows.<n>`.
function gitForWindows(): boolean {
  if (!WINDOWS) return false;
  const version = probe(["version"]);
  return version?.exitCode === 0 && /^git version \d+\.\d+\.\d+\.windows\.\d+\r?$/m.test(version.stdout);
}

// Contract §6 "Registration bootstrap": the first discovery query (research.md R2) gives the merged `REPOSITORY_UNAVAILABLE` here.
// Exit 0 of `rev-parse --is-inside-work-tree` means that Git found an enclosing repository. `safe.directory=*` keeps an ownership refusal from hiding one.
// The owned root does not exist at load, so the check runs in its parent.
function noEnclosingRepository(): boolean {
  const result = probe(["-c", "safe.directory=*", "rev-parse", "--is-inside-work-tree"], dirname(FIXTURE_ROOT));
  return result !== null && result.exitCode !== 0;
}

// A case that denies the service a file read. A process with CAP_DAC_OVERRIDE, such as root, opens a file without read permission.
// The probe file keeps the execute bit only, and the open must fail with EACCES. On Windows, `icacls /deny` gives the denial.
function readDenial(): boolean {
  if (WINDOWS) return Bun.which("icacls") !== null;
  const dir = mkdtempSync(join(tmpdir(), "arbareto-read-denial-"));
  try {
    const file = join(dir, "probe");
    writeFileSync(file, "");
    chmodSync(file, 0o100);
    try {
      closeSync(openSync(file, "r"));
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EACCES";
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// tasks.md "Test harness rules": present when `symlinkSync` succeeds. Windows refuses `CreateSymbolicLinkW` without the privilege or Developer Mode.
function symlinkCreation(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "arbareto-symlink-"));
  try {
    symlinkSync("target", join(dir, "probe"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Present when `mkfifo` exits 0 and `lstat` reports a FIFO at the path. Windows has no FIFO in a folder.
// An MSYS `mkfifo` on Windows exits 0 and leaves no entry at the native path.
function fifoCreation(): boolean {
  if (WINDOWS || Bun.which("mkfifo") === null) return false;
  const dir = mkdtempSync(join(tmpdir(), "arbareto-fifo-"));
  try {
    const fifo = join(dir, "probe");
    const made = Bun.spawnSync(["mkfifo", fifo], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return made.exitCode === 0 && lstatSync(fifo, { throwIfNoEntry: false })?.isFIFO() === true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `gitOpenssl` throws when `git --exec-path` fails. A capability probe never throws.
function opensslPresent(): boolean {
  try {
    return GIT !== null && gitOpenssl(GIT) !== null;
  } catch {
    return false;
  }
}

const PRESENT: Record<Capability, boolean> = {
  // `bun-runner.ts` has host calls only for Windows (`win32.ts`) and Linux (`linux.ts`).
  "shell-double": WINDOWS || LINUX,
  "windows-path-rules": WINDOWS,
  powershell: Bun.which("powershell") !== null || Bun.which("pwsh") !== null,
  // A junction needs Windows. A volume without junction support fails the fixture step.
  "ntfs-junction": WINDOWS,
  "git-for-windows": gitForWindows(),
  // A fixture cannot create a repository that another account owns (`buildF15` notes).
  "other-account-owner": false,
  "no-enclosing-repository": noEnclosingRepository(),
  "read-denial": readDenial(),
  symlink: symlinkCreation(),
  fifo: fifoCreation(),
  // T093 runs each remedy in PowerShell 7 and in Windows PowerShell 5.1. Only Windows ships 5.1 as `powershell`.
  pwsh: Bun.which("pwsh") !== null,
  "windows-powershell": WINDOWS && Bun.which("powershell") !== null,
  // T096 F15: no probe creates and mounts a VHD without elevation (`buildF15` notes).
  "disposable-volume": false,
  // T100: `restart` disposes the double runner, and its `dispose` ends every recorded process. The shell keeps lingering Jobs across a service restart (contract §6).
  "restart-keeps-lingering": false,
  // T220 F30 "stall": Windows OpenSSH `ssh-keygen`, as `buildF30` finds it.
  openssh: WINDOWS && existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh-keygen.exe")),
  // T220 `tests/git/http-401.ts` `https` mode: the `openssl` of the Git under test.
  openssl: opensslPresent(),
  // T224 SSH cases: a test SSH server and a passphrase key for it, named by the environment.
  "ssh-server": Boolean(process.env.ARBARETO_TEST_SSH_URL),
  "ssh-key": Boolean(process.env.ARBARETO_TEST_SSH_KEY),
  // T010: `tests/support/ssh-server.ts` finds `ssh` and `ssh-keygen` (`sshTools`).
  "local-ssh-server": GIT !== null && sshTools(GIT) !== null,
};

export function missingCapability(...needs: Capability[]): Capability | null {
  return needs.find((need) => !PRESENT[need]) ?? null;
}

// tasks.md "Test harness rules": a skipped case names the missing capability, and research.md records it as unverified.
export function caseTest(task: string, name: string, needs: readonly Capability[], fn: () => unknown, timeoutMs?: number): void {
  const body = async () => {
    await fn();
  };
  const missing = missingCapability(...needs);
  if (GIT !== null && missing === null) return void test(name, body, timeoutMs);
  console.log(GIT === null ? `SKIP ${task} ${name}: Git executable absent` : `SKIP ${task} ${name}: missing capability ${missing} (unverified)`);
  test.skip(name, body, timeoutMs);
}

const digestOf = (file: string) => (existsSync(file) ? new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex") : "absent");

// SC-009: the SHA-256 of each configuration file that the owned environment gives a Git of `dir`, or "absent".
// The files are the common `config`, the worktree `config.worktree`, the owned global file, and the owned system file of `remote-fixtures.ts`.
export function configDigests(dir: string): Record<string, string> {
  if (GIT === null) throw new Error("Git executable absent");
  const proc = Bun.spawnSync([fixtureGitPath(GIT), "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], { cwd: dir, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const lines = proc.stdout.toString("utf8").split("\n");
  if (proc.exitCode !== 0 || lines.length !== 3 || lines[2] !== "") throw new Error(`git rev-parse in ${dir} exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  const files = [join(lines[0]!, "config"), join(lines[1]!, "config.worktree"), FIXTURE_GLOBAL_CONFIG, join(FIXTURE_HOME, "system.gitconfig")];
  return Object.fromEntries(files.map((file) => [file, digestOf(file)]));
}

// SC-009: every configuration file of each repository that `body` registers keeps its bytes from the first registration to the end of `body`.
export async function keepConfigs(service: Service, body: (service: Service) => Promise<void>): Promise<void> {
  const before: Record<string, string> = {};
  const register = service.register;
  service.register = (path) => {
    for (const [file, digest] of Object.entries(configDigests(path))) before[file] ??= digest;
    return register(path);
  };
  try {
    await body(service);
  } finally {
    service.register = register;
  }
  const after = Object.fromEntries(Object.keys(before).map((file) => [file, digestOf(file)]));
  expect(after).toEqual(before);
}

// Matches only the first call that `match` accepts. The double passes the same call object at each check of that call.
export function once(match: CallMatch): CallMatch {
  let first: object | null = null;
  return (call) => {
    if (first !== null) return call === first;
    if (!match(call)) return false;
    first = call;
    return true;
  };
}

// The `node:fs/promises` file calls of the in-process service while `body` runs, in call order. `onCall` runs before each call.
export type FsCall = { name: "lstat" | "stat" | "access" | "open" | "readdir"; path: string };
export async function withFsCalls<T>(body: () => Promise<T>, onCall: (call: FsCall) => void = () => {}): Promise<{ value: T; calls: FsCall[] }> {
  const calls: FsCall[] = [];
  const spies = (["lstat", "stat", "access", "open", "readdir"] as const).map((name) => {
    const original = fsp[name] as (...args: unknown[]) => unknown;
    return spyOn(fsp, name).mockImplementation(((path: unknown, ...rest: unknown[]) => {
      const call = { name, path: String(path) };
      calls.push(call);
      onCall(call);
      return original(path, ...rest);
    }) as never);
  });
  try {
    return { value: await body(), calls };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

// The seam: the registrations of the service report an unfinished mutation in every workspace, so no registration releases a replaced worktree (contract §6 "Registration reuse and release").
export async function withKeptWorkspaces<T>(body: () => Promise<T>): Promise<T> {
  const real = registrationModule.createRegistrations;
  const spy = spyOn(registrationModule, "createRegistrations").mockImplementation((options) => real({ ...options, unfinishedMutation: () => true }));
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

// Windows variable names ignore case, so the result holds one PATH key with the first spelling of `env`.
export function withPath(env: Record<string, string>, path: string): Record<string, string> {
  const name = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() !== "PATH") out[key] = value;
  out[name] = path;
  return out;
}

export interface ServiceSeams {
  readDeadlineMs?: number;
  // `false` suppresses watcher hints.
  watchHints?: boolean;
  // The owned service environment, with the child PATH.
  environment?: Record<string, string>;
  // The in-process checkpoint observer of `src/git-service/hunk-publish.ts` (T110). The service awaits it after research R3 steps 5, 11, and 13 of a hunk publication.
  hunkCheckpoint?: (checkpoint: HunkCheckpoint) => Promise<void> | void;
  // The clock of the contract §5 approval lifetime (T110 decision G5). The service uses `performance.now()` without it.
  approvalClock?: () => number;
  // The in-process checkpoint observer of `src/git-service/submodule-update.ts` (T230). The service awaits it before each named contract §12 step.
  submoduleCheckpoint?: (checkpoint: SubmoduleCheckpoint) => Promise<void> | void;
  // Feature 002 contract Δ5 `HISTORY_VIEW_COMMITS`, lowered for a test (T022).
  historyViewCommits?: number;
  // The expected matches of each matching probe run, changed for a probe mismatch (T033).
  historyProbeRuns?: SessionOptions["historyProbeRuns"];
  // Feature 006 plan.md D5 (T019): the owned dictionary folder. Without it, the dictionary operations get SERVICE_UNAVAILABLE.
  dictionaryFolder?: string;
  // A synthetic catalog. The service does not parse it, so a case can name an `http:` URL.
  catalog?: SessionOptions["catalog"];
  // The injected `fetch`. No test uses the network.
  fetch?: SessionOptions["fetch"];
  // The fake clock of the dictionary deadlines.
  dictionaryTimer?: SessionOptions["dictionaryTimer"];
}

// Contract §12 "Update protocol" step 5 and "Trust": `folder-check` comes before the folder check of a `reuse` row, `clone-check` before the clone check of a row,
// and `nested-active-set` before the program re-check of a nested active-set read. `path` is the display path of the row, or of the parent row for `nested-active-set`.
export interface SubmoduleCheckpoint {
  point: "folder-check" | "clone-check" | "nested-active-set";
  operationId: string;
  path: string;
}

export type { HunkCheckpoint };

export interface OpenOptions extends ServiceSeams {
  git: string;
  // The owned runner directory under the fixture root.
  name: string;
  gitSelectedPath?: string;
  trustStore?: TrustStore;
  restarted?: boolean;
  // Test seam: the writer refuses each frame that this accepts, as `encodeFrame` refuses a frame above the bound.
  refuseFrame?: (frame: Frame) => boolean;
  // The recovery markers and the unloaded marker count of the startup handshake (contract §6 "Startup handshake").
  markers?: Handshake["markers"];
  unloadedMarkers?: number;
  // Runs when the service sends a `started` mutation frame, before the double writes the marker and replies.
  onStarted?: (frame: MutationStarted) => void;
  // The `BunRunnerOptions` fixture isolation of WSL processes: the Linux path of the owned global configuration.
  wslGlobalConfig?: string;
}

export interface ServiceResponse<R = unknown> {
  requestId: string | null;
  operationId?: string;
  state: string;
  code?: string;
  repositoryGeneration?: number;
  selectionId?: string;
  result?: R;
}

export interface Envelope {
  repositoryId?: string;
  repositoryGeneration?: number;
  selectionId?: string;
  sessionId?: string;
  requestId?: string;
}

export type Head = { state: "branch"; target: string; oid: string } | { state: "detached"; oid: string } | { state: "unborn"; target: string };

// `reason` is the export name in `src/contracts/limits.ts`, such as `STATUS_LISTING_RECORDS`.
export interface Completeness {
  state: "complete" | "limited" | "failed";
  code?: string;
  reason?: string;
}

export interface Refusal {
  path?: string;
  limit?: number;
  recoveryState?: string;
  remedy?: { text?: string; command?: string | null };
}

export interface RegistrationResult {
  repositoryId: string;
  generation: number;
  worktreeKey: string;
  worktreeRoot: string;
}

export interface ChangeEntry {
  entryId: string;
  category: "staged" | "unstaged" | "untracked" | "conflicted";
  path: string;
  // Base64 of the literal path bytes.
  pathBytes: string;
  xy?: string;
  mode?: string;
  flags: { intentToAdd: boolean; assumeUnchanged: boolean; skipWorktree: boolean };
}

export interface WorkspaceResult {
  generation: number;
  snapshotId: string;
  identity: { worktreeRoot: string; gitDirectory: string; commonDirectory: string; indexPath: string; objectFormat: "sha1" | "sha256"; refFormat: "files" | "reftable" };
  head: Head;
  operationState: string;
  recoveryState: string;
  completeness: Completeness;
  hunkEligibility: { eligible: true } | { eligible: false; reason: "sparse-index" | "split-index" | "index-change-hook" | "executable-monitor" | "unqualified-monitor" };
  location: { kind: "native" } | { kind: "wsl"; distro: string; git: { path: string; version: string } };
  // Contract §3: all pages of the snapshot. `entries` holds the first page.
  entryCount: number;
  entries: ChangeEntry[];
  // The `readEntries` cursor of the next page, or null after the last page.
  cursor: string | null;
}

// Contract §3 `readEntries`: one later page of the retained snapshot.
export interface EntriesResult {
  entries: ChangeEntry[];
  cursor: string | null;
}

// Feature 002 contract Δ3 `openHistory` result.
export interface OpenedHistory {
  viewId: string;
  scope: "all" | "current";
  generation: number;
  head: Head;
  startCount: number;
  refsDigest: string;
  shallow: boolean;
}

export interface TrustResult {
  generation: number;
  state: "untrusted" | "approved" | "changed" | "revoked";
  persistence: "stored" | "session";
  trustId?: string;
  approvalRequired: { reads: boolean; commit: boolean; sync: boolean; workbench: boolean; mergetool: boolean };
  inputLimited?: boolean;
  programs: TrustDetails;
  entries: { key: string; scope: string; origin?: string; value?: string }[];
  hooks: { event: string; scope?: string; path?: string; disabled?: boolean }[];
}

export interface ApproveResult {
  trustId: string;
  persistence: "stored" | "session";
  saveFailed: boolean;
}

export interface RevokeResult {
  endedProcesses: number;
}

type Registration = ServiceResponse<RegistrationResult | Refusal>;

export interface Service {
  runner: BunRunner;
  trustStore: TrustStore;
  sessionId: string;
  responses: ServiceResponse[];
  progress: unknown[];
  // `performance.now()` at each progress event, in the order of `progress`.
  progressAt: number[];
  // The frames that `refuseFrame` refused.
  refused: Frame[];
  // `performance.now()` at the first response of each `requestId`.
  responseAt: Map<string, number>;
  log(): readonly unknown[];
  send(operation: string, payload: object, envelope?: Envelope): string;
  // The first response of `requestId`.
  response<R>(requestId: string, timeoutMs?: number): Promise<ServiceResponse<R>>;
  request<R>(operation: string, payload: object, envelope?: Envelope): Promise<ServiceResponse<R>>;
  operationId(requestId: string): Promise<string>;
  chooseRepository(path: string): Promise<Registration>;
  restoreWorkspace(path: string): Promise<Registration>;
  register(path: string): Promise<RegistrationResult>;
  readWorkspace(id: string, payload?: { refresh: boolean; check: "full" | "changes" }, generation?: number): Promise<ServiceResponse<WorkspaceResult>>;
  readEntries(id: string, generation: number, snapshotId: string, cursor: string): Promise<ServiceResponse<EntriesResult>>;
  // The feature 001 cases read the current checkout, so `scope` defaults to "current".
  openHistory(id: string, generation: number, scope?: "all" | "current"): Promise<ServiceResponse<OpenedHistory>>;
  readTrust(id: string): Promise<ServiceResponse<TrustResult>>;
  // Feature 004 contract Δ7: the action names the dialog sentence only.
  approveTrust(id: string, action?: TrustAction): Promise<ServiceResponse<ApproveResult>>;
  revokeTrust(id: string, trustId: string): Promise<ServiceResponse<RevokeResult>>;
  cancel(operationId: string): Promise<ServiceResponse>;
  getOperation(operationId: string): Promise<ServiceResponse>;
  // Disposes this runner and opens a new session with the same trust store and `restarted: true`.
  restart(overrides?: Partial<OpenOptions>): Promise<Service>;
  dispose(): Promise<void>;
}

// Contract §5: a read ends by its 30-second deadline, and its outcome follows within the 5-second reconciliation target.
export const RESPONSE_WAIT_MS = READ_DEADLINE_MS + RECONCILIATION_TARGET_MS;
// Contract §5 "Ordinary read deadline": `reviewSubmodules`, the `updateSubmodules` preflight, and its level reads have no total read deadline. This wait is a test budget below the 120-second case timeout.
export const NO_TOTAL_DEADLINE_WAIT_MS = 90_000;
const NO_TOTAL_DEADLINE = new Set(["reviewSubmodules", "updateSubmodules"]);

// Contract §5 "Private/reply frame": a pipe frame body holds at most 16 MiB of encoded JSON.
export function checkFrame(frame: object): void {
  const bytes = Buffer.byteLength(JSON.stringify(frame));
  if (bytes > PIPE_FRAME_BYTES) throw new FrameBoundError(`a service frame of ${bytes} bytes is above the ${PIPE_FRAME_BYTES}-byte frame bound`);
}

const isResponse =(value: unknown): value is ServiceResponse => isObject(value) && typeof value.state === "string" && (value.requestId === null || typeof value.requestId === "string");

// Feature 004 contract Δ10 (T034, T060), Δ3 `reviewCommit`, and the feature 005 reads: every result of these operations must fit its schema.
const RESULT_SCHEMAS: Readonly<Record<string, { safeParse(value: unknown): { success: boolean } }>> = {
  readBranches: ReadBranchesResult,
  readWorktrees: ReadWorktreesResult,
  readGitSettings: ReadGitSettingsResult,
  reviewWorkbench: ReviewWorkbenchResult,
  reviewCommit: ReviewCommitResult,
  runWorkbench: RunWorkbenchResult,
  readCommitChanges: ReadCommitChangesResult,
  readCommitFile: ReadCommitFileResult,
  readBlame: ReadBlameResult,
  // Feature 006 contract Δ3 (T019).
  listDictionaries: ListDictionariesResult,
  readDictionary: ReadDictionaryResult,
  downloadDictionary: DictionaryRunResult,
  importDictionary: DictionaryRunResult,
  removeDictionary: RemoveDictionaryResult,
};

export async function openService(options: OpenOptions): Promise<Service> {
  const trustStore = options.trustStore ?? createTrustStore();
  const environment = options.environment ?? serviceEnv();
  const runner = createBunRunner({ git: options.git, directory: fixtureDir(options.name), environment, trustStore, ...(options.wslGlobalConfig === undefined ? {} : { wslGlobalConfig: options.wslGlobalConfig }) });
  const responses: ServiceResponse[] = [];
  const progress: unknown[] = [];
  const progressAt: number[] = [];
  const refused: Frame[] = [];
  const responseAt = new Map<string, number>();
  const firstResponse = new Map<string, ServiceResponse>();
  const acceptedBy = new Map<string, string>();
  // The operation of each sent `requestId`.
  const sentOperations = new Map<string, string>();
  const listeners = new Set<() => void>();
  let handshakeReply: unknown = null;
  let failed = false;
  let closed = false;
  // The first frame above the frame bound. It fails every wait and `dispose`.
  let frameError: Error | null = null;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  // Bounded wait for a value that a later frame provides.
  function waitFor<T>(find: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = find();
        if (value !== undefined) {
          done();
          resolve(value);
        } else if (frameError !== null) {
          done();
          reject(frameError);
        } else if (closed) {
          done();
          reject(new Error(`${what}: the service is disposed`));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`${what}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });
  }

  const writer: SessionOptions["writer"] = {
    write(frame) {
      if (options.refuseFrame?.(frame)) {
        refused.push(frame);
        throw new FrameBoundError("refused by the refuseFrame seam");
      }
      try {
        checkFrame(frame);
      } catch (error) {
        frameError ??= error as Error;
        notify();
        throw error;
      }
      if (frame.kind === "handshake") handshakeReply = frame.handshake;
      const response = frame.kind === "public" ? frame.response : undefined;
      if (isResponse(response)) {
        responses.push(response);
        // A result that breaks its schema fails every wait and `dispose`, as a frame above the bound does.
        const operation = typeof response.requestId === "string" ? sentOperations.get(response.requestId) : undefined;
        const schema = operation === undefined ? undefined : RESULT_SCHEMAS[operation];
        if (schema !== undefined && response.result !== undefined && !schema.safeParse(response.result).success) frameError ??= new Error(`${operation} result breaks its schema: ${JSON.stringify(response.result)}`);
        if (typeof response.requestId === "string" && !firstResponse.has(response.requestId)) {
          firstResponse.set(response.requestId, response);
          responseAt.set(response.requestId, performance.now());
        }
      }
      if (frame.kind === "public" && isObject(frame.progress)) {
        const event = frame.progress;
        progress.push(event);
        progressAt.push(performance.now());
        if (event.state === "accepted" && typeof event.requestId === "string" && typeof event.operationId === "string") acceptedBy.set(event.requestId, event.operationId);
      }
      notify();
    },
    async flush(): Promise<void> {},
  };

  const seams: ServiceSeams = {
    environment,
    ...(options.readDeadlineMs === undefined ? {} : { readDeadlineMs: options.readDeadlineMs }),
    ...(options.watchHints === undefined ? {} : { watchHints: options.watchHints }),
    ...(options.hunkCheckpoint === undefined ? {} : { hunkCheckpoint: options.hunkCheckpoint }),
    ...(options.approvalClock === undefined ? {} : { approvalClock: options.approvalClock }),
    ...(options.submoduleCheckpoint === undefined ? {} : { submoduleCheckpoint: options.submoduleCheckpoint }),
    ...(options.historyViewCommits === undefined ? {} : { historyViewCommits: options.historyViewCommits }),
    ...(options.historyProbeRuns === undefined ? {} : { historyProbeRuns: options.historyProbeRuns }),
    ...(options.dictionaryFolder === undefined ? {} : { dictionaryFolder: options.dictionaryFolder }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.dictionaryTimer === undefined ? {} : { dictionaryTimer: options.dictionaryTimer }),
  };
  const sessionOptions: SessionOptions & ServiceSeams = {
    writer,
    runner: {
      ...runner,
      receive: () => false,
      started: (frame: MutationStarted) => {
        options.onStarted?.(frame);
        return runner.started(frame);
      },
    },
    fail: () => {
      failed = true;
    },
    ...seams,
  };
  const session = createSession(sessionOptions);
  const sendFrame = (frame: object) => session.receive({ type: "frame", body: new TextEncoder().encode(JSON.stringify(frame)) });

  // Contract §6 "Startup handshake". Only `restarted` and `trustRecords` vary. The other values are fixed test facts.
  sendFrame({
    kind: "handshake",
    handshake: {
      version: 1,
      restarted: options.restarted ?? false,
      platformScope: "other",
      osBuild: 26200,
      webView2Version: "140.0.0.0",
      buildIdentity: { version: "0.1.0", commit: "0".repeat(40), signing: "unsigned" },
      markers: options.markers ?? [],
      unloadedMarkers: options.unloadedMarkers ?? 0,
      damagedMarkers: [],
      trustRecords: trustStore.records,
    } satisfies Handshake,
  });
  const sessionId = session.sessionId;
  if (sessionId === null) {
    await runner.dispose();
    throw new Error(`handshake failed (fail called: ${failed}): ${JSON.stringify(handshakeReply)}`);
  }

  const service: Service = {
    runner,
    trustStore,
    sessionId,
    responses,
    progress,
    progressAt,
    refused,
    responseAt,
    log: () => session.log.entries(),
    send(operation, payload, envelope = {}) {
      const requestId = envelope.requestId ?? crypto.randomUUID();
      sentOperations.set(requestId, operation);
      sendFrame({
        kind: "public",
        request: {
          version: 1,
          sessionId: envelope.sessionId ?? sessionId,
          requestId,
          operation,
          ...(envelope.repositoryId === undefined ? {} : { repositoryId: envelope.repositoryId }),
          ...(envelope.repositoryGeneration === undefined ? {} : { repositoryGeneration: envelope.repositoryGeneration }),
          ...(envelope.selectionId === undefined ? {} : { selectionId: envelope.selectionId }),
          payload,
        },
      });
      return requestId;
    },
    async response<R>(requestId: string, timeoutMs = NO_TOTAL_DEADLINE.has(sentOperations.get(requestId) ?? "") ? NO_TOTAL_DEADLINE_WAIT_MS : RESPONSE_WAIT_MS) {
      return (await waitFor(() => firstResponse.get(requestId), timeoutMs, `response of ${requestId}`)) as ServiceResponse<R>;
    },
    request<R>(operation: string, payload: object, envelope?: Envelope) {
      return service.response<R>(service.send(operation, payload, envelope));
    },
    async operationId(requestId) {
      const found = await waitFor(
        () => {
          const operationId = acceptedBy.get(requestId) ?? firstResponse.get(requestId)?.operationId;
          if (operationId !== undefined) return { operationId };
          const response = firstResponse.get(requestId);
          return response && { response };
        },
        RESPONSE_WAIT_MS,
        `operationId of ${requestId}`,
      );
      if ("response" in found) throw new Error(`no operationId: ${JSON.stringify(found.response)}`);
      return found.operationId;
    },
    // Contract §3: the service payload holds only the native-issued `bootstrapId`.
    chooseRepository: (path) => service.request("chooseRepository", { bootstrapId: runner.addContext("repositoryDiscovery", path) }),
    restoreWorkspace: (path) => service.request("restoreWorkspace", { bootstrapId: runner.addContext("repositoryDiscovery", path) }),
    async register(path) {
      const response = await service.chooseRepository(path);
      if (response.state !== "succeeded") throw new Error(`registration failed: ${JSON.stringify(response)}`);
      return response.result as RegistrationResult;
    },
    // Contract §3 `readWorkspace`: the first read sends `refresh: false` with `check: "full"`.
    readWorkspace: (id, payload = { refresh: false, check: "full" }, generation) =>
      service.request("readWorkspace", payload, { repositoryId: id, ...(generation === undefined ? {} : { repositoryGeneration: generation }) }),
    readEntries: (id, generation, snapshotId, cursor) => service.request("readEntries", { snapshotId, cursor }, { repositoryId: id, repositoryGeneration: generation }),
    openHistory: (id, generation, scope = "current") => service.request("openHistory", { scope }, { repositoryId: id, repositoryGeneration: generation }),
    readTrust: (id) => service.request("readTrust", {}, { repositoryId: id }),
    approveTrust: (id, action = "commit") => service.request("approveTrust", { action }, { repositoryId: id }),
    revokeTrust: (id, trustId) => service.request("revokeTrust", { trustId }, { repositoryId: id }),
    cancel: (operationId) => service.request("cancel", { operationId }),
    getOperation: (operationId) => service.request("getOperation", { operationId }),
    async restart(overrides = {}) {
      await service.dispose();
      return openService({ ...options, name: `${options.name}-restart`, ...overrides, trustStore, restarted: true });
    },
    async dispose() {
      closed = true;
      notify();
      // Bun 1.4.4 on Windows: a watcher of a removed directory repeats events until it closes.
      session.close();
      await runner.dispose();
      if (frameError !== null) throw frameError;
    },
  };

  // Contract §3 `chooseGit`: the service payload holds the native-issued `bootstrapId` and the probed `executablePath`.
  const selected = options.gitSelectedPath ?? options.git;
  const chosen = await service.request("chooseGit", { bootstrapId: runner.addContext("gitProbe", selected), executablePath: selected }).catch(async (error: unknown) => {
    await runner.dispose();
    throw error;
  });
  if (chosen.state !== "succeeded") {
    await runner.dispose();
    throw new Error(`chooseGit failed: ${JSON.stringify(chosen)}`);
  }
  return service;
}
