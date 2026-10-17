// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Shared steps of the feature 003 service tests (tasks.md T032 to T037 and T044 to T047). The oracle shares no code with `src/git-service/`.
// `withSync` prints the ORIGIN line of each module under test once per process, or names an absent module.

import { expect } from "bun:test";
import { resolve } from "node:path";
import { printOrigin } from "../origin";
import { FIXED_IDENTITY } from "./fixture-root";
import { GIT } from "./git-binary";
import { gitOut, gitRun, markers, nativeEnv, nativeHost, refMap, stageEntries, type GitHost } from "./remote-fixtures";
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

const MODULES = ["sync", "sync-review", "sync-integrate", "tracking", "trust", "git-runner", "comparison", "file-publish", "hunk-publish"];
let printed = false;

// The service gets the environment of the fixture processes: the owned global and system files, and no inherited transport variable.
export async function withSync(name: string, body: (service: Service) => Promise<void>, options: Partial<Omit<OpenOptions, "git" | "name">> = {}): Promise<void> {
  for (const module of printed ? [] : MODULES) {
    try {
      printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
    } catch {
      console.log(`ORIGIN absent src/git-service/${module}.ts`);
    }
  }
  printed = true;
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
  destination?: { remote: string; ref: string; trackingRef: string | null; url: string; setUpstream: boolean; upstreamRebase: boolean; source: string };
  lease?: { trackingRef: string; expect: string; count: number; commits: { objectId: string; subject: string | null }[] };
  operationState?: "merging" | "rebasing";
  mode?: "merge" | "rebase" | null;
  skippedCommit?: { objectId: string; subject: string | null };
  needsDestination?: { remotes: string[]; prefill: { remote: string; ref: string } | null; setUpstream: boolean; upstreamRebase: boolean };
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
  counts?: { ahead: number; behind: number };
  integration?: { state: string; operation?: string; unmerged?: number; outputTail?: string };
  modeSource?: string | null;
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

// Git's own commands of the integrate steps run with the `integrate` policy editor (plan.md D2).
export const INTEGRATE_ENV = { GIT_EDITOR: ":" };
export const ANY_EXIT = Array.from({ length: 256 }, (_, i) => i).concat([-1]);
export const pullFlags = (mode?: "merge" | "rebase"): string[] => (mode === "rebase" ? ["--rebase"] : mode === "merge" ? ["--no-rebase"] : []);

// The SC-001 and SC-012 state: HEAD, commit trees with parent trees, the index, the working-file digests, the markers, and the remote-tracking refs.
// Commit object IDs differ by message, so trees and parents decide for new commits (plan.md D14).
export function repoShape(h: GitHost, repo: string) {
  const born = gitRun(h, repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] }).exitCode === 0;
  const log = born ? gitOut(h, repo, ["log", "--topo-order", "--format=%H%x00%T%x00%P", "HEAD"]).split("\n").filter((l) => l !== "").map((l) => l.split("\0")) : [];
  const trees = new Map(log.map(([oid, tree]) => [oid!, tree!]));
  return {
    head: gitRun(h, repo, ["symbolic-ref", "-q", "HEAD"], { allowExit: [0, 1] }).stdout.toString("utf8").trim(),
    shape: log.map(([, tree, parents]) => `${tree}<${(parents ?? "").split(" ").filter((p) => p !== "").map((p) => trees.get(p) ?? p).join(",")}`),
    index: stageEntries(h, repo),
    files: h.digests(repo),
    markers: markers(h, repo),
    remotes: refMap(h, repo, ["refs/remotes"]),
  };
}

// A copied repository keeps the stat data of the source files, so unpack-trees sees each entry as changed. A refresh restores it (git-update-index(1) `--refresh`).
export const refreshIndex = (h: GitHost, repo: string): string => {
  gitRun(h, repo, ["update-index", "-q", "--refresh"], { allowExit: ANY_EXIT });
  return repo;
};

// The paths with a stage above 0 (git-ls-files(1) `--unmerged`).
export const unmergedPaths = (h: GitHost, repo: string): string[] => [...new Set(stageEntries(h, repo).filter((e) => e.stage > 0).map((e) => e.path))];

// The parent count of a commit.
export const parentCount = (h: GitHost, repo: string, rev = "HEAD"): number => gitOut(h, repo, ["rev-list", "--parents", "--max-count=1", rev]).trim().split(" ").length - 1;

// The Git subcommands of one operation, in order.
export const subcommandsOf = (service: Service, operationId: string): (string | undefined)[] => callsOf(service, operationId).map((c) => subcommandOf(c.arguments));

export async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > end) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await Bun.sleep(20);
  }
}

// Every string in a value at any depth.
export function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
  return [];
}
