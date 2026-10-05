// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The in-process service of the batch 2 tests: `createSession` with the `bun-runner.ts` shell double.
// Its imports must load off Windows without `dlopen` (tests/git/portable-imports.test.ts).

import { spyOn, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Handshake } from "../../src/contracts/channel";
import { PIPE_FRAME_BYTES, READ_DEADLINE_MS, RECONCILIATION_TARGET_MS } from "../../src/contracts/limits";
import { createSession, type SessionOptions } from "../../src/git-service/session";
import { printOrigin } from "../origin";
import { createBunRunner, createTrustStore, type BunRunner, type CallMatch, type TrustStore } from "./bun-runner";
import { FIXTURE_ROOT, fixtureDir, fixtureEnv, serviceEnv } from "./fixture-root";
import { GIT } from "./git-binary";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

export type Capability = "shell-double" | "windows-path-rules" | "powershell" | "ntfs-junction" | "git-for-windows" | "other-account-owner" | "no-enclosing-repository" | "read-denial";

const WINDOWS = process.platform === "win32";
const LINUX = process.platform === "linux";

// Runs the test Git with the owned environment and the fixed C locale of the `probe` policy.
function probe(args: string[], cwd?: string): { exitCode: number; stdout: string; stderr: string } | null {
  if (GIT === null) return null;
  const proc = Bun.spawnSync([GIT, ...args], { cwd, env: fixtureEnv({ LC_ALL: "C" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

// `src/git-service/admission.ts`: a Git for Windows version ends in `.windows.<n>`.
function gitForWindows(): boolean {
  if (!WINDOWS) return false;
  const version = probe(["version"]);
  return version?.exitCode === 0 && /^git version \d+\.\d+\.\d+\.windows\.\d+\r?$/m.test(version.stdout);
}

// Contract §6 "Registration bootstrap" `NOT_A_REPOSITORY`: exit status 128 and the stderr prefix. The query is the first discovery query (research.md R2).
// The owned root does not exist at load, so the check runs in its parent.
function noEnclosingRepository(): boolean {
  const result = probe(["rev-parse", "--is-bare-repository", "--is-inside-git-dir"], dirname(FIXTURE_ROOT));
  return result?.exitCode === 128 && result.stderr.startsWith("fatal: not a git repository (or any");
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
}

export interface OpenOptions extends ServiceSeams {
  git: string;
  // The owned runner directory under the fixture root.
  name: string;
  gitSelectedPath?: string;
  trustStore?: TrustStore;
  restarted?: boolean;
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

export interface HistoryResult {
  generation: number;
  scope: "current-checkout";
  head: Head;
  shallowFingerprint: string | null;
  rows: { oid: string; parents: string[]; subject: string; author: { name: string; email: string }; date: number; encoding: string | null }[];
  boundaries: { page: string[]; shallow: string[] };
  completeness: Completeness;
}

export interface TrustResult {
  generation: number;
  fingerprint: string;
  state: "untrusted" | "approved" | "changed" | "revoked";
  persistence: "stored" | "session";
  trustId?: string;
  approvalRequired: { reads: boolean; commit: boolean };
  bound?: "file-count" | "file-bytes" | "total-bytes" | "link";
  inputLimited?: boolean;
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
  readHistory(id: string, generation: number): Promise<ServiceResponse<HistoryResult>>;
  readTrust(id: string): Promise<ServiceResponse<TrustResult>>;
  approveTrust(id: string, fingerprint: string, generation: number): Promise<ServiceResponse<ApproveResult>>;
  revokeTrust(id: string, trustId: string): Promise<ServiceResponse<RevokeResult>>;
  cancel(operationId: string): Promise<ServiceResponse>;
  getOperation(operationId: string): Promise<ServiceResponse>;
  // Disposes this runner and opens a new session with the same trust store and `restarted: true`.
  restart(overrides?: Partial<OpenOptions>): Promise<Service>;
  dispose(): Promise<void>;
}

// Contract §5: a read ends by its 30-second deadline, and its outcome follows within the 5-second reconciliation target.
const RESPONSE_WAIT_MS = READ_DEADLINE_MS + RECONCILIATION_TARGET_MS;

// Contract §5 "Private/reply frame": a pipe frame body holds at most 16 MiB of encoded JSON.
export function checkFrame(frame: object): void {
  const bytes = Buffer.byteLength(JSON.stringify(frame));
  if (bytes > PIPE_FRAME_BYTES) throw new RangeError(`a service frame of ${bytes} bytes is above the ${PIPE_FRAME_BYTES}-byte frame bound`);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isResponse =(value: unknown): value is ServiceResponse => isObject(value) && typeof value.state === "string" && (value.requestId === null || typeof value.requestId === "string");

export async function openService(options: OpenOptions): Promise<Service> {
  const trustStore = options.trustStore ?? createTrustStore();
  const environment = options.environment ?? serviceEnv();
  const runner = createBunRunner({ git: options.git, directory: fixtureDir(options.name), environment, trustStore });
  const responses: ServiceResponse[] = [];
  const progress: unknown[] = [];
  const responseAt = new Map<string, number>();
  const firstResponse = new Map<string, ServiceResponse>();
  const acceptedBy = new Map<string, string>();
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
        if (typeof response.requestId === "string" && !firstResponse.has(response.requestId)) {
          firstResponse.set(response.requestId, response);
          responseAt.set(response.requestId, performance.now());
        }
      }
      if (frame.kind === "public" && isObject(frame.progress)) {
        const event = frame.progress;
        progress.push(event);
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
  };
  const sessionOptions: SessionOptions & ServiceSeams = {
    writer,
    runner: { ...runner, receive: () => false },
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
      markers: [],
      unloadedMarkers: 0,
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
    responseAt,
    log: () => session.log.entries(),
    send(operation, payload, envelope = {}) {
      const requestId = envelope.requestId ?? crypto.randomUUID();
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
    async response<R>(requestId: string, timeoutMs = RESPONSE_WAIT_MS) {
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
    readHistory: (id, generation) => service.request("readHistory", {}, { repositoryId: id, repositoryGeneration: generation }),
    readTrust: (id) => service.request("readTrust", {}, { repositoryId: id }),
    approveTrust: (id, fingerprint, generation) => service.request("approveTrust", { fingerprint, approve: true }, { repositoryId: id, repositoryGeneration: generation }),
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
      // Bun 1.4.2 on Windows: a watcher of a removed directory repeats events until it closes.
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
