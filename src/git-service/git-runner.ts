// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import {
  COMMIT_PROCESS_DEADLINE_MS,
  GIT_PROCESS_DEADLINE_MS,
  STALL_NOTICE_MS,
  SUBMODULE_UPDATE_CEILING_MS,
  SUBMODULE_UPDATE_INACTIVITY_MS,
} from "../contracts/limits";
import type { OperationName } from "../contracts/operations";

// Contract §7 environment policies. `mutation-trace2` exists only after a supporting T091 result.
export type EnvironmentPolicy = "probe" | "read" | "mutation" | "network";

// Contract §6 "Process fields": the bootstrap or registered context of one process.
export type ProcessContext =
  | { contextKind: "gitProbe" | "repositoryDiscovery"; bootstrapId: string }
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
  readonly bytes: number;
  readonly records: number;
  readonly limited: boolean;
}

export interface GitCall {
  operationId: string;
  context: ProcessContext;
  arguments: readonly string[];
  input?: Uint8Array;
  environmentPolicy: EnvironmentPolicy;
  transactionId?: string;
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
}

export type IdentityReply = { volumeSerial: string; fileId: string } | { code: string };

export interface MutationStarted {
  operationId: string;
  repositoryId: string;
  kind: OperationName;
  worktreeRoot: string;
  commonDirectory: string;
}

export type StartedReply = { markerId: string } | { busy: true } | { failure: "disk-full" | "access-denied" | "other" };

export type TrustRequest =
  | { type: "confirm"; worktreeRoot: string; gitDirectory: string; commonDirectory: string; gitInstallationDigest: string; fingerprint: string; persist: boolean }
  | { type: "revoke"; commonDirectory: string }
  | { type: "confirmRun"; worktreeRoot: string; submodulePaths: string[]; programCount: number; uncheckedCount: number };

export type TrustReply = { result: "approved" | "declined" } | { endedProcesses: number };

export interface GitRunner {
  run(call: GitCall): Promise<GitExit>;
  identities(operationId: string, context: ProcessContext, paths: readonly string[]): Promise<IdentityReply[]>;
  lingeringCount(operationId: string, commonDirectory: string): Promise<number>;
  started(frame: MutationStarted): Promise<StartedReply>;
  ended(operationId: string, endProcesses: boolean): void;
  resolved(markerId: string): void;
  trust(request: TrustRequest): Promise<TrustReply>;
}

export class RunnerRefusal extends Error {}

// Contract §6 "Process fields" and §7 "Missing objects". A refused call starts no process.
export function checkCall(call: GitCall): void {
  const args = call.arguments;
  if (!args.every((a) => typeof a === "string" && !a.includes("\0"))) throw new RunnerRefusal("argument refused");
  // §6 `gitProbe`: the version probe is the only array without `--no-lazy-fetch`.
  const versionProbe = call.context.contextKind === "gitProbe" && args.length === 2 && args[0] === "version" && args[1] === "--build-options";
  if (!versionProbe && args[0] !== "--no-lazy-fetch") throw new RunnerRefusal("first argument must be --no-lazy-fetch");
  if (call.context.contextKind === "gitProbe" && !versionProbe) throw new RunnerRefusal("gitProbe permits only the version probe");
  if (!limitsFit(call.limits)) throw new RunnerRefusal("limits refused");
}

// Contract §6 "Process fields": an identity request.
const IDENTITY_PATHS = 8;
const IDENTITY_PATH_UNITS = 32_767;

export function checkIdentityPaths(paths: readonly string[]): void {
  if (paths.length === 0 || paths.length > IDENTITY_PATHS) throw new RunnerRefusal("identity path count refused");
  if (!paths.every((p) => typeof p === "string" && p.length > 0 && p.length <= IDENTITY_PATH_UNITS && !p.includes("\0"))) {
    throw new RunnerRefusal("identity path refused");
  }
}

function limitsFit(limits: ProcessLimits): boolean {
  const fits = (value: unknown, cap: number) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= cap;
  if (limits.stallMs !== undefined && limits.stallMs !== STALL_NOTICE_MS) return false;
  if ("deadlineMs" in limits) return fits(limits.deadlineMs, COMMIT_PROCESS_DEADLINE_MS);
  return fits(limits.inactivityMs, SUBMODULE_UPDATE_INACTIVITY_MS) && fits(limits.ceilingMs, SUBMODULE_UPDATE_CEILING_MS);
}

// A record ends at `separator`. A byte after `maxBytes` bytes or after `maxRecords` records sets `limited`, and the collector drops it.
export function createCollector(options: { maxBytes: number; maxRecords?: number; separator?: number }) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let records = 0;
  let limited = false;
  return {
    push(chunk: Uint8Array): void {
      if (limited) return;
      let end = Math.min(chunk.length, options.maxBytes - bytes);
      if (options.separator !== undefined) {
        for (let i = 0; i < end; i++) {
          if (options.maxRecords !== undefined && records >= options.maxRecords) {
            end = i;
            break;
          }
          if (chunk[i] === options.separator) records++;
        }
      }
      if (end < chunk.length) limited = true;
      if (end > 0) {
        chunks.push(chunk.slice(0, end));
        bytes += end;
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
      const out = new Uint8Array(bytes);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },
  };
}
