// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 plan.md D16: the fixtures and the oracle of the remote branch delete tests (T009 to T012). The oracle shares no code with `src/git-service/`.
// Every remote is a local bare repository over a file path.

import { SUBMODULE_UPDATE_CEILING_MS, SUBMODULE_UPDATE_INACTIVITY_MS, STALL_NOTICE_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { fc, fiReset, gitOut, gitRun, importStream, refMap, revParse, type GitHost } from "./remote-fixtures";
import type { Service } from "./service-harness";
import { copyWithRemotes, hostFor, subcommandOf } from "./sync-harness";

for (const module of ["remote-delete", "ref-facts", "sync-commands", "sync-parsers"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);

export const LONG_COMMITS = 150;
export const NETWORK_LIMITS = { inactivityMs: SUBMODULE_UPDATE_INACTIVITY_MS, ceilingMs: SUBMODULE_UPDATE_CEILING_MS, stallMs: STALL_NOTICE_MS };
export const DELETE_ARGS = (remote: string, dst: string, expect: string) => ["--no-lazy-fetch", "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", `--force-with-lease=${dst}:${expect}`, "--", remote, `:${dst}`];
export const LS_REMOTE_ARGS = (remote: string, dst: string) => ["--no-lazy-fetch", "ls-remote", "--exit-code", "--", remote, dst];
export const SUCCEEDED = { state: "succeeded", code: undefined };
export const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
export const isPush = (call: { arguments: readonly string[] }) => subcommandOf(call.arguments) === "push";
export const isLsRemote = (call: { arguments: readonly string[] }) => subcommandOf(call.arguments) === "ls-remote";
export const isUpdateRef = (call: { arguments: readonly string[] }) => subcommandOf(call.arguments) === "update-ref";
export const payloadOf = (ref: string, local?: string) => ({ action: "delete-remote-branch", ref, ...(local === undefined ? {} : { local }) });
// The stale-lease remedy of plan.md D13 X27.
export const pruneText = (remote: string) => `This command fetches ${remote} and removes the remote-tracking branches whose remote branch is gone.`;
// The terminal remedy of a failed push step.
export const STEP_REMEDY = "This command runs the step in a terminal, where Git and SSH can ask for input. Then use the action again.";

export interface Base {
  h: GitHost;
  remote: string;
  repo: string;
}

// The bare `origin.git` holds `main` (the base commit), `feature` and `a/b` (one commit only on each), `keep` (at the base), and `long` (150 commits only on it).
// The clone `repo` has `origin/HEAD` as a symref to `origin/main`, and `main` checked out.
export function buildBase(name: string): Base {
  const h = hostFor(name);
  const remote = `${h.root}/origin.git`;
  gitRun(h, h.root, ["init", "-q", "--bare", "-b", "main", "--", remote]);
  importStream(h, remote, [
    fc({ mark: 1, message: "base\n", files: { "base.txt": "base\n" } }),
    fc({ mark: 2, ref: "refs/heads/feature", message: "feature\n", from: 1, files: { "feature.txt": "feature\n" } }),
    fc({ mark: 3, ref: "refs/heads/a/b", message: "slash\n", from: 1, files: { "slash.txt": "slash\n" } }),
    fiReset("refs/heads/keep", 1),
    ...Array.from({ length: LONG_COMMITS }, (_, i) => fc({ mark: 10 + i, ref: "refs/heads/long", message: `long ${i}\n`, from: i === 0 ? 1 : 9 + i, files: { "long.txt": `${i}\n` } })),
  ]);
  const repo = `${h.root}/repo`;
  gitRun(h, h.root, ["clone", "-q", "--", remote, repo]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"]] as const) gitRun(h, repo, ["config", key, value]);
  return { h, remote, repo };
}

export interface Copy {
  h: GitHost;
  repo: string;
  origin: string;
}

let copies = 0;
// A copy of the base clone with its own copy of `origin.git`.
export function copyOf(base: Base): Copy {
  const copy = copyWithRemotes(base.h, base.repo, { origin: base.remote }, `copy-${++copies}`);
  return { h: base.h, repo: copy.repo, origin: copy.remotes.origin! };
}

// A commit on top of `ref` in the bare remote, as another clone would push it.
export function moveRemote(c: Copy, branch: string, message = "remote moved\n"): string {
  const from = revParse(c.h, c.origin, `refs/heads/${branch}`);
  const marks = importStream(c.h, c.origin, [fc({ mark: 2, ref: `refs/heads/${branch}`, message, from: 1, files: { "moved.txt": message } })], { marksIn: new Map([[1, from]]) });
  return marks.get(2)!;
}

// A `file://` spelling of a path, so `remote.<name>.pushurl` names the same repository in other bytes (research.md R2 P16).
export const fileUrl = (path: string) => `file://${path.startsWith("/") ? "" : "/"}${path}`;

// The state that a delete may change: the refs of the clone and of the remote, HEAD, and the local configuration bytes.
export function stateOf(c: Copy) {
  const [path] = gitOut(c.h, c.repo, ["rev-parse", "--path-format=absolute", "--git-path", "config"]).trimEnd().split("\n");
  return {
    refs: refMap(c.h, c.repo) as Record<string, string | undefined>,
    remote: refMap(c.h, c.origin) as Record<string, string | undefined>,
    head: gitOut(c.h, c.repo, ["symbolic-ref", "-q", "HEAD"]).trim(),
    // Raw bytes: two invalid UTF-8 runs decode to the same U+FFFD text.
    config: c.h.read(path!)!,
  };
}

// Git's own lease delete (plan.md D16 oracle). Exit 1 is a refused delete.
export function gitDelete(c: Copy, dst: string, expect: string): number {
  return gitRun(c.h, c.repo, ["push", "--porcelain", `--force-with-lease=${dst}:${expect}`, "--", "origin", `:${dst}`], { allowExit: [0, 1] }).exitCode;
}

// The progress phases of one request, in order.
export const phasesOf = (service: Service, requestId: string): string[] =>
  (service.progress as { requestId?: string; phase?: string }[]).filter((p) => p.requestId === requestId && p.phase !== undefined).map((p) => p.phase!);

// The `progressAt` time of the first progress event of `phase` for one request.
export function phaseAt(service: Service, requestId: string, phase: string): number | undefined {
  const i = (service.progress as { requestId?: string; phase?: string }[]).findIndex((p) => p.requestId === requestId && p.phase === phase);
  return i < 0 ? undefined : service.progressAt[i];
}

// The hook appends its stdin and one `run` line per run, so a test can assert the run after the approval and an empty log before it.
// transport.c `run_pre_push_hook` skips a ref that the lease refused, so such a run logs `run` alone.
export function logHook(c: Copy, event: string, log: string, body = "exit 0"): void {
  c.h.write(`${c.repo}/.git/hooks/${event}`, `#!/bin/sh\ncat >> '${log}'\necho run >> '${log}'\n${body}\n`);
}
