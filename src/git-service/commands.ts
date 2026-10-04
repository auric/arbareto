// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { HISTORY_STREAM_ROWS } from "../contracts/limits";

// Contract §7 "Missing objects": every app Git command starts with this option. Only the `gitProbe` arrays of `git-installation.ts` omit it.
const NO_LAZY_FETCH = "--no-lazy-fetch";
// Contract §7 "Missing objects" and T067: the global options of every read.
const READ_OPTIONS = [NO_LAZY_FETCH, "--no-optional-locks", "--literal-pathspecs"] as const;

const read = (...args: string[]): string[] => [...READ_OPTIONS, ...args];

// Data-model §2 `objectFormat`: the values of `rev-parse --show-object-format`.
export type ObjectFormat = "sha1" | "sha256";

const OID_PATTERNS: Record<ObjectFormat, RegExp> = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
};

export function isObjectId(value: string, objectFormat: ObjectFormat): boolean {
  const pattern = Object.hasOwn(OID_PATTERNS, objectFormat) ? OID_PATTERNS[objectFormat] : undefined;
  return pattern !== undefined && pattern.test(value);
}

// Research R2: the 28 traditional hook names of githooks(5) in Git 2.55.0.
const HOOK_EVENTS: ReadonlySet<string> = new Set([
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change",
]);

// Contract §6 `repositoryDiscovery` and T082: separate profiles in T082 order. No T283 record allows the combined `rev-parse` form yet.
// No profile loads the index: `--shared-index-path` and `ls-files` can run `core.fsmonitor` before trust approval (research R2).
// Research R2 "Repository identity": request absolute paths where Git supports `--path-format`.
const DISCOVERY_PROFILES: readonly (readonly string[])[] = [
  [NO_LAZY_FETCH, "rev-parse", "--is-bare-repository", "--is-inside-git-dir"],
  [NO_LAZY_FETCH, "rev-parse", "--show-toplevel"],
  [NO_LAZY_FETCH, "rev-parse", "--absolute-git-dir"],
  [NO_LAZY_FETCH, "rev-parse", "--path-format=absolute", "--git-common-dir"],
  [NO_LAZY_FETCH, "rev-parse", "--path-format=absolute", "--git-path", "index"],
  [NO_LAZY_FETCH, "rev-parse", "--show-object-format"],
  [NO_LAZY_FETCH, "rev-parse", "--show-ref-format"],
  [NO_LAZY_FETCH, "symbolic-ref", "-q", "HEAD"],
  [NO_LAZY_FETCH, "show-ref", "--head", "--verify", "HEAD"],
];

export function discoveryProfiles(): string[][] {
  return DISCOVERY_PROFILES.map((profile) => [...profile]);
}

export function configListArgs(): string[] {
  return read("config", "list", "--show-scope", "--show-origin", "-z");
}

export function hooksPathArgs(): string[] {
  return read("rev-parse", "--git-path", "hooks");
}

export function shallowPathArgs(): string[] {
  return read("rev-parse", "--git-path", "shallow");
}

export function hookListArgs(event: string): string[] {
  if (!HOOK_EVENTS.has(event)) throw new TypeError("hook event refused");
  return read("hook", "list", "-z", "--show-scope", event);
}

// Research R2 "Machine-readable reads". `--ignore-submodules=dirty` starts no status child in a submodule (research R5).
export function statusArgs(): string[] {
  return read("status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--find-renames", "--ignore-submodules=dirty");
}

export function indexListArgs(): string[] {
  return read("ls-files", "-z", "--stage");
}

// git-ls-files(1) `-v`: the `-t` tags, lowercase for assume-unchanged entries, `S` for skip-worktree entries.
export function indexFlagArgs(): string[] {
  return read("ls-files", "-z", "-v");
}

// Contract §3: the history read takes one captured full OID, never a revision expression.
export function revListArgs(oid: string, objectFormat: ObjectFormat): string[] {
  const pattern = Object.hasOwn(OID_PATTERNS, objectFormat) ? OID_PATTERNS[objectFormat] : undefined;
  if (pattern === undefined || !pattern.test(oid)) throw new TypeError("object ID refused");
  return read("rev-list", "--parents", `--max-count=${HISTORY_STREAM_ROWS}`, "--date-order", oid);
}

// Research R2: uppercase `-Z` frames input and output with NUL.
export function batchCommandArgs(): string[] {
  return read("cat-file", "--batch-command", "-Z");
}

// Contract §7 "Missing objects": object IDs go only on stdin. Git prints `<oid> missing` for an absent object.
export function objectCheckArgs(): string[] {
  return read("cat-file", "--batch-check");
}
