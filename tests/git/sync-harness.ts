// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Shared steps of the feature 003 batch 2 service tests (tasks.md T032 to T037). The oracle shares no code with `src/git-service/`.
// The modules under test do not exist before T039 and T040. `withSync` prints their ORIGIN lines, or names an absent module.

import { expect } from "bun:test";
import { resolve } from "node:path";
import { printOrigin } from "../origin";
import { FIXED_IDENTITY } from "./fixture-root";
import { GIT } from "./git-binary";
import { gitRun, nativeEnv, nativeHost, type GitHost } from "./remote-fixtures";
import { openService, type OpenOptions, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";

export const TIMEOUT_MS = 300_000;

export const gitExe = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

// The native form of a fixture path, so the shell double reads its identity.
export const native = (path: string): string => resolve(path);

let hosts = 0;
// One owned fixture folder per case.
export const hostFor = (name: string): GitHost => nativeHost(gitExe(), `${name}-${++hosts}`);

// The service gets the environment of the fixture processes: the owned global and system files, and no inherited transport variable.
export async function withSync(name: string, body: (service: Service) => Promise<void>, options: Partial<Omit<OpenOptions, "git" | "name">> = {}): Promise<void> {
  for (const module of ["sync", "sync-review", "tracking", "trust", "git-runner"]) {
    try {
      printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
    } catch {
      console.log(`ORIGIN absent src/git-service/${module}.ts`);
    }
  }
  const service = await openService({ git: gitExe(), name, environment: nativeEnv(), ...options });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

export async function register(service: Service, path: string): Promise<RegistrationResult> {
  return service.register(native(path));
}

export interface SyncPlan {
  remotes: string[];
  upstream?: { ref: string; objectId: string };
  destination?: { remote: string; ref: string; trackingRef: string | null; url: string; setUpstream: boolean; source: string };
  lease?: { trackingRef: string; expect: string; count: number; commits: { objectId: string; subject: string | null }[] };
  operationState?: "merging" | "rebasing";
  needsDestination?: { remotes: string[]; prefill: { remote: string; ref: string } | null; setUpstream: boolean };
}

export interface Reviewed {
  action: string;
  plan: SyncPlan;
  syncReviewToken?: string;
}

export interface FetchRemote {
  name: string;
  state: string;
  updates: { flag: string; oldObjectId: string; newObjectId: string; ref: string }[];
  counts: Record<string, number>;
  outputTail: string;
}

export interface SyncResult {
  action: string;
  fetch?: { remotes: FetchRemote[]; observed: { ref: string; oldObjectId: string | null; newObjectId: string | null }[] };
  push?: { status: string; oldObjectId: string | null; newObjectId: string | null; reasonText: string | null; lease: boolean; upstreamWritten: boolean; upstreamNotSet: boolean; outputTail: string };
  remedy?: { text: string; command: string | null };
  // Contract Δ9: the PUSH_REJECTED reason, or the PUTTY_UNAVAILABLE reason with `program` and `path`.
  reason?: string;
  program?: string;
  path?: string;
}

export function reviewSync(service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<Reviewed & { reason?: string; unmerged?: number }>> {
  return service.request("reviewSync", payload, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
}

// A succeeded review with a token.
export async function reviewed(service: Service, r: RegistrationResult, payload: object): Promise<Reviewed & { syncReviewToken: string }> {
  const response = await reviewSync(service, r, payload);
  expect({ state: response.state, code: response.code, result: response.state === "succeeded" ? "result" : response.result }).toEqual({ state: "succeeded", code: undefined, result: "result" });
  expect(typeof response.result!.syncReviewToken).toBe("string");
  return response.result as Reviewed & { syncReviewToken: string };
}

export const sendSync = (service: Service, r: RegistrationResult, token: string): string => service.send("sync", { syncReviewToken: token, start: true }, { repositoryId: r.repositoryId });

export function sync(service: Service, r: RegistrationResult, token: string): Promise<ServiceResponse<SyncResult>> {
  return service.response<SyncResult>(sendSync(service, r, token));
}

// Review and run one action.
export async function run(service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<SyncResult>> {
  return sync(service, r, (await reviewed(service, r, payload)).syncReviewToken);
}

// The outcome and the result of a refused review or sync, for a compare with the refusal shape.
export const refusalOf = (r: ServiceResponse<unknown>): { state: string; code?: string; result: unknown } => ({ state: r.state, code: r.code, result: r.result });

export const callsFrom =(service: Service, from = 0) => service.runner.calls.slice(from);
// The Git processes that can contact a remote.
export const remoteCalls = (service: Service, from = 0) => callsFrom(service, from).filter((c) => c.environmentPolicy === "remote" || c.environmentPolicy === "network");
export const callsOf = (service: Service, operationId: string) => service.runner.calls.filter((c) => c.operationId === operationId);
// The Git subcommand after the global options.
export const subcommandOf = (args: readonly string[]): string | undefined => args.find((a, i) => i > 0 && !a.startsWith("--"));

// The local configuration entries in file order, as `git config list --local` prints them.
export const localConfig = (h: GitHost, repo: string): string[] => gitRun(h, repo, ["config", "list", "--local"]).stdout.toString("utf8").split("\n").filter((l) => l !== "");

// A copy of a repository with its own copy of each named bare remote. The copy's remotes point at the copied remotes.
export function copyWithRemotes(h: GitHost, repo: string, remotes: Record<string, string>, tag: string): { repo: string; remotes: Record<string, string> } {
  const copy = `${h.root}/${tag}`;
  h.copy(repo, copy);
  const copied: Record<string, string> = {};
  for (const [name, path] of Object.entries(remotes)) {
    copied[name] = `${h.root}/${tag}-${name.replaceAll("/", "-")}.git`;
    h.copy(path, copied[name]);
    gitRun(h, copy, ["remote", "set-url", "--", name, copied[name]]);
  }
  return { repo: copy, remotes: copied };
}

// An owned global configuration with the fixture identity and a credential helper script outside every repository.
// The script holds the password, so no configuration value names it. A shell snippet names no program file, so it would count as repository-controlled.
export function helperGlobal(h: GitHost, user: string, password: string): string {
  const script = `${h.root}/credential-helper.sh`;
  h.write(script, `#!/bin/sh\ntest "$1" = get && printf 'username=%s\\npassword=%s\\n' '${user}' '${password}'\nexit 0\n`);
  const global = `${h.root}/helper.gitconfig`;
  h.write(global, `[user]\n\tname = ${FIXED_IDENTITY.name}\n\temail = ${FIXED_IDENTITY.email}\n[credential]\n\thelper = ${script}\n`);
  return native(global);
}

// Every string in a value at any depth.
export function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
  return [];
}
