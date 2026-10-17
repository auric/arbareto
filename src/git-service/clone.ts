// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 003 contract Δ3 `clone` steps 1 to 6, data-model §11, FR-046 to FR-051, and plan.md D10.
// The service gets the destination path only from `wslDistros`, and it reads the destination only through `destinationFacts`.

import type { RegistrationResult, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import { isWindows } from "../contracts/native-path";
import { buildRemedyCommand } from "../contracts/remedy-command";
import { redactUrlUserInfo } from "../contracts/submodules";
import { createCollector, PROCESS_LIMITS, RunnerRefusal, type GitExit, type GitRunner, type PageantReply, type SyncRunner, type WslRunner } from "./git-runner";
import type { OperationRegistry } from "./operations";
import type { RegistrationOutcome } from "./registration";
import { trackStall } from "./stall";
import { stepStderr } from "./submodule-update";
import { STEP_REMEDY_TEXT } from "./sync";
import { cloneArgs } from "./sync-commands";

type CloneRequest = Extract<ServiceRequest, { operation: "clone" }>;

export interface RouteTarget {
  operationId: string;
  bootstrapId: string;
  signal: AbortSignal;
}

// Step 1: the reply path, and for a WSL path the approved WSL Git and the §11 Linux path.
export type Routed = { ok: true; path: string; wsl?: { git: { gitInstallationId: string }; linuxPath: string } } | { ok: false; code: ErrorCode; result?: RegistrationResult };

export interface ClonerOptions {
  runner: GitRunner & WslRunner & SyncRunner;
  registry: OperationRegistry;
  route(target: RouteTarget): Promise<Routed>;
  // The selected Windows Git, or the code of its absence.
  windowsGit(): { gitInstallationId: string; selectedPath: string | null } | ErrorCode;
  // Step 5: the 001 `chooseRepository` registration flow from `wslDistros` on.
  register(target: RouteTarget & { destination: string }): Promise<RegistrationOutcome>;
}

// Data-model §11: the connect target of the last failed clone of this session. The URL never leaves the service, except in `terminal`.
export interface CloneTarget {
  operationId: string;
  kind: "url";
  repositoryId: null;
  gitInstallationId: string;
  target: string;
}

type End = { code: ErrorCode | null; result?: unknown };

const REMEDY = "& {git} clone -- {url} {destination}";

export function createCloner(o: ClonerOptions) {
  const { registry, runner } = o;
  let kept: CloneTarget | undefined;

  async function execute(request: CloneRequest, operationId: string, signal: AbortSignal): Promise<End> {
    const { url, bootstrapId, cloneId } = request.payload;
    const routed = await o.route({ operationId, bootstrapId, signal });
    if (!routed.ok) return { code: routed.code, result: routed.result };
    const destination = routed.path;
    const git = routed.wsl === undefined ? o.windowsGit() : { gitInstallationId: routed.wsl.git.gitInstallationId, selectedPath: null };
    if (typeof git === "string") return { code: git };

    // Step 2, before any Git process. An `error` reply is no destination type: 001 §12 refuses a failed folder read with REPOSITORY_UNAVAILABLE.
    const facts = await runner.destinationFacts({ operationId, cloneId });
    if (facts.result === "error") return { code: "REPOSITORY_UNAVAILABLE", result: { path: destination, remedy: { text: `Arbareto cannot read ${destination}: ${facts.code}.` } } };
    if (facts.result !== "absent" && facts.result !== "empty") return { code: "DESTINATION_NOT_EMPTY", result: { reason: facts.result, path: destination } };

    // Contract §7 "URL user information": such a remedy is text only. A WSL Git has no Windows command form.
    const command =
      redactUrlUserInfo(url) !== url || git.selectedPath === null
        ? null
        : buildRemedyCommand(REMEDY, { git: { kind: "gitPath", text: git.selectedPath, form: "windows" }, url: { kind: "url", text: url }, destination: { kind: "path", text: destination, form: "windows" } }).command;
    const remedy = { text: STEP_REMEDY_TEXT, command };
    // Step 6: the destination from OS facts. The service deletes, moves, and opens no file (FR-050).
    const ended = async (code: ErrorCode, outputTail: string): Promise<End> => {
      const after = await runner.destinationFacts({ operationId, cloneId }).catch((error: unknown) => {
        if (error instanceof RunnerRefusal) return null;
        throw error;
      });
      // Contract gap: an `error` reply gives no `exists` and no `empty` value.
      if (after === null || after.result === "error") return { code };
      return { code, result: { exists: after.result !== "absent", empty: after.result === "empty", outputTail, remedy } };
    };

    // Step 3. A WSL Git gets no `pageant`.
    let pageant: PageantReply | null = null;
    if (isWindows && routed.wsl === undefined) {
      registry.progress(operationId, "pageant");
      try {
        pageant = await runner.pageant({ operationId, cloneId });
      } catch (error) {
        if (error instanceof RunnerRefusal) return ended(error.code, "");
        throw error;
      }
      if (pageant.result === "failed") return { code: "PUTTY_UNAVAILABLE", result: { reason: pageant.reason, program: pageant.program, path: pageant.path } };
    }
    if (signal.aborted) return ended("CANCELED", "");

    // Step 4: the 001 §12 network limits and the stall notice.
    let percent: number | undefined;
    const report = () => {
      const state = registry.get(operationId)?.state;
      if (state === "running" || state === "cancel-requested") registry.progress(operationId, "clone", percent === undefined ? {} : { percent });
    };
    report();
    const stderr = stepStderr((next) => {
      if (next === percent) return;
      percent = next;
      report();
    });
    const stall = trackStall(registry, operationId, report, () => (command === null ? { text: remedy.text } : { command, text: remedy.text }));
    let exit: GitExit | null = null;
    let refused: ErrorCode | null = null;
    try {
      exit = await runner.run({
        operationId,
        context: { contextKind: "clone", cloneId, gitInstallationId: git.gitInstallationId },
        arguments: cloneArgs(url, routed.wsl?.linuxPath ?? destination),
        environmentPolicy: "remote",
        limits: PROCESS_LIMITS.network,
        stdout: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
        stderr,
        signal,
        onActivity: stall.onActivity,
      });
    } catch (error) {
      if (!signal.aborted && !(error instanceof RunnerRefusal)) throw error;
      if (!signal.aborted) refused = (error as RunnerRefusal).code;
    } finally {
      stall.end();
    }
    const outputTail = stderr.outputTail();
    // Step 5: only exit status 0 means a clone (git-clone(1)).
    if (exit?.exitCode === 0 && exit.deadline === undefined) {
      const registered = await o.register({ operationId, bootstrapId, signal, destination });
      return registered.ok ? { code: null, result: registered.result } : ended(registered.code, outputTail);
    }
    const canceled = signal.aborted;
    if (!canceled && pageant !== null && pageant.result !== "git") kept = { operationId, kind: "url", repositoryId: null, gitInstallationId: git.gitInstallationId, target: url };
    const code: ErrorCode = canceled ? "CANCELED" : (refused ?? (exit?.deadline !== undefined ? "DEADLINE" : exit?.diagnosticLimit ? "OUTPUT_LIMIT" : "GIT_FAILED"));
    // Contract gap: after a WSL clone without an exit status, Linux Git can still write. The 001 §12 process-end fact needs a registered workspace.
    if (routed.wsl !== undefined && (exit === null || exit.exitCode === null)) return { code };
    return ended(code, outputTail);
  }

  return {
    // Contract Δ3 `clone`: the shell bound the contexts and forwarded their IDs. The service payload holds no path.
    clone(request: CloneRequest): void {
      const { operationId, signal } = registry.start("clone", request.requestId);
      registry.apply(operationId, { type: "valid-read" });
      const finish = ({ code, result }: End) => {
        if (registry.get(operationId)?.state === "cancel-requested") return void registry.apply(operationId, { type: "processes-stopped" }, result);
        if (code === "CANCELED") {
          registry.apply(operationId, { type: "cancel" });
          return void registry.apply(operationId, { type: "processes-stopped" }, result);
        }
        registry.apply(operationId, code === null ? { type: "read-complete", result: "succeeded" } : { type: "read-complete", result: "failed", code }, result);
      };
      execute(request, operationId, signal).then(finish, (error: unknown) => finish({ code: error instanceof RunnerRefusal ? error.code : "GIT_FAILED" }));
    },
    connectTarget: (): CloneTarget | undefined => kept,
  };
}

export type Cloner = ReturnType<typeof createCloner>;
