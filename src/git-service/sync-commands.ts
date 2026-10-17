// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract Δ3 and plan.md D3 to D7: the argument arrays of fetch, push, pull, the conflict actions, and clone.

import { SYNC_LEASE_COMMITS } from "../contracts/limits";
import { isObjectId, isRefName, type ObjectFormat } from "./commands";

// Contract §7 "Missing objects": every app Git command starts with this option.
const L = "--no-lazy-fetch";
const read = (...args: string[]): string[] => [L, "--no-optional-locks", ...args];

// An argv item cannot hold NUL. A remote name comes from `git remote`, so membership is the caller's check.
function item(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TypeError("argument refused");
  return value;
}

function ref(name: string): string {
  if (!isRefName(name)) throw new TypeError("ref name refused");
  return name;
}

const branchRef = (branch: string): string => ref(`refs/heads/${branch}`);

function oid(value: string, objectFormat: ObjectFormat): string {
  if (!isObjectId(value, objectFormat)) throw new TypeError("object ID refused");
  return value;
}

export type IntegrationKind = "merging" | "rebasing";

function kind(value: IntegrationKind): "merge" | "rebase" {
  if (value === "merging") return "merge";
  if (value === "rebasing") return "rebase";
  throw new TypeError("operation kind refused");
}

// Plan.md D8: one process for all branches.
export function trackingArgs(): string[] {
  return read("for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)", "refs/heads", "refs/remotes");
}

// Plan.md D4: the pattern matches by prefix, so the caller keeps only the record of `refs/heads/<branch>`.
export function pushRecordArgs(branch: string): string[] {
  return read(
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push)%00%(push:remotename)%00%(push:remoteref)",
    branchRef(branch),
  );
}

export function remoteListArgs(): string[] {
  return read("remote");
}

export function pushUrlArgs(remote: string): string[] {
  return read("remote", "get-url", "--push", "--all", "--", item(remote));
}

// Plan.md D5: the commits that a force push with lease removes from the remote branch.
export function leaseCountArgs(tracking: string, head: string, objectFormat: ObjectFormat): string[] {
  return read("rev-list", "--count", oid(tracking, objectFormat), `^${oid(head, objectFormat)}`);
}

export function leaseCommitsArgs(tracking: string, head: string, objectFormat: ObjectFormat): string[] {
  return read("rev-list", `--max-count=${SYNC_LEASE_COMMITS}`, oid(tracking, objectFormat), `^${oid(head, objectFormat)}`);
}

// Contract Δ3 `sync` protocol step 4: all refs, before and after the network step.
export function syncRefsArgs(): string[] {
  return read("for-each-ref", "--format=%(refname)%00%(objectname)");
}

// git-rev-list(1) `--left-right --count`: "left TAB right", so the HEAD side is ahead.
export function aheadBehindArgs(head: string, upstream: string, objectFormat: ObjectFormat): string[] {
  return read("rev-list", "--left-right", "--count", `${oid(head, objectFormat)}...${oid(upstream, objectFormat)}`);
}

// FR-011: no prune or tag option.
export function fetchArgs(remote: string): string[] {
  return [L, "fetch", "--porcelain", "--progress", "--no-recurse-submodules", "--", item(remote)];
}

// Plan.md D4 and D5. `lease` is the expected OID of `dst`. Without a lease, the push never forces.
export function pushArgs(remote: string, branch: string, dst: string, options: { setUpstream: boolean; lease: string | null }, objectFormat: ObjectFormat): string[] {
  const args = [L, "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags"];
  if (options.setUpstream) args.push("--set-upstream");
  if (options.lease !== null) args.push(`--force-with-lease=${ref(dst)}:${oid(options.lease, objectFormat)}`);
  return [...args, "--", item(remote), `${branchRef(branch)}:${ref(dst)}`];
}

export function fastForwardArgs(upstreamRef: string): string[] {
  return [L, "merge", "--ff-only", "--no-autostash", ref(upstreamRef)];
}

// Plan.md D6: the `pull.ff` option that Git's pull passes, or none.
// O-3 and feature 004 plan.md D5: `--no-log -m` passes the `fmt-merge-msg` preview, because `merge.log` appends a shortlog to an explicit message. Null: Git's own default message.
export function mergeArgs(upstreamRef: string, ff: "--ff" | "--no-ff" | null, message: string | null): string[] {
  if (ff !== null && ff !== "--ff" && ff !== "--no-ff") throw new TypeError("ff option refused");
  return [L, "merge", "--no-edit", "--no-autostash", ...(ff === null ? [] : [ff]), ...(message === null ? [] : ["--no-log", "-m", item(message)]), ref(upstreamRef)];
}

// Feature 004 plan.md D5: stdin holds the `merge_name` line of builtin/merge.c for the merged ref.
export function mergeMessageArgs(): string[] {
  return read("fmt-merge-msg");
}

// Contract Δ3 read 7.
export function indexStageArgs(): string[] {
  return read("ls-files", "--stage", "-z");
}

// One Git-resolved path in the Git folder, such as `index.lock`.
export function gitPathArgs(name: string): string[] {
  return read("rev-parse", "--path-format=absolute", "--git-path", item(name));
}

// Contract Δ4 step 5: Git applies the attribute conversion of the path and writes the blob, as `git add` does.
export function hashWriteArgs(path: string): string[] {
  return [L, "hash-object", "-w", "--", item(path)];
}

export function rebaseArgs(upstreamRef: string, rebaseMerges: boolean): string[] {
  return [L, "rebase", "--no-autostash", "--fork-point", ...(rebaseMerges ? ["--rebase-merges"] : []), ref(upstreamRef)];
}

export function abortArgs(state: IntegrationKind): string[] {
  return [L, kind(state), "--abort"];
}

// Plan.md D7: a merge continues with `commit`, which takes `MERGE_MSG` under `GIT_EDITOR=:`.
export function continueArgs(state: IntegrationKind): string[] {
  return kind(state) === "merge" ? [L, "commit", "--quiet"] : [L, "rebase", "--continue"];
}

// Contract Δ3 read 8: status 2 of `--exists` means no REBASE_HEAD (git-show-ref(1)).
export function rebaseHeadExistsArgs(): string[] {
  return read("show-ref", "--exists", "REBASE_HEAD");
}

export function rebaseHeadArgs(): string[] {
  return read("show-ref", "--verify", "REBASE_HEAD");
}

export function skipArgs(): string[] {
  return [L, "rebase", "--skip"];
}

// Contract Δ6: the shell admits this fixed array with the bound destination as the last item.
export function cloneArgs(url: string, destination: string): string[] {
  return [L, "clone", "--progress", "--no-recurse-submodules", "--", item(url), item(destination)];
}
