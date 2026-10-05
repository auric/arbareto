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

// Research R2 and the T280 record in research R5: the 28 known hook events of githooks(5), in hook-list.h order. The probes and `trust.ts` share this list.
export const HOOK_EVENTS: readonly string[] = Object.freeze([
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change",
]);

// Contract §6 `repositoryDiscovery` and T082: separate profiles in T082 order. The T283 record in research R2 refuses the full combined `rev-parse` form; `discoveryLayoutArgs` holds its two-call form.
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

// Contract §6 "Registration bootstrap": the first discovery query, as a registered read with the read options.
export function recheckArgs(): string[] {
  return read("rev-parse", "--is-bare-repository", "--is-inside-git-dir");
}

export function shallowPathArgs(): string[] {
  return read("rev-parse", "--git-path", "shallow");
}

// Contract §7 "Configuration file paths": git-var(1) in the `gitProbe` context, once per admitted installation.
export function configSystemPathArgs(): string[] {
  return [NO_LAZY_FETCH, "var", "GIT_CONFIG_SYSTEM"];
}

export function configGlobalPathArgs(): string[] {
  return [NO_LAZY_FETCH, "var", "GIT_CONFIG_GLOBAL"];
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

// git-ls-files(1) OUTPUT: `--stage` with `-v` prints `<tag> <mode> <object> <stage> TAB <file>` for each entry.
export function indexEntryArgs(): string[] {
  return read("ls-files", "-z", "--stage", "-v");
}

// git-symbolic-ref(1) `-q`: a detached HEAD gives a nonzero status and no message.
export function headTargetArgs(): string[] {
  return read("symbolic-ref", "-q", "HEAD");
}

// Contract §7 "Held history steps": the `readHistory` HEAD capture with `headTargetArgs`. git-rev-parse(1) `--verify -q`: on success, Git prints the full object ID.
export function headOidArgs(): string[] {
  return read("rev-parse", "--verify", "-q", "HEAD");
}

// The unborn check of the `readHistory` HEAD capture. git-show-ref(1) `--exists`: status 0 when the reference exists, 2 when it is missing, and 1 for another lookup error.
export function headRefExistsArgs(name: string): string[] {
  if (!isRefName(name)) throw new TypeError("ref name refused");
  return read("show-ref", "--exists", name);
}

// Git `wt-status.c` `wt_status_get_state`: the files and folders that mark an unfinished operation.
// `rebase-apply/applying` marks `git am`. Git keeps `MERGE_HEAD` as a file in every ref format (refs.c `is_special_ref`).
export const OPERATION_MARKERS = ["MERGE_HEAD", "rebase-apply", "rebase-apply/applying", "rebase-merge", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"] as const;
export type OperationMarker = (typeof OPERATION_MARKERS)[number];

// Research R2 "Repository identity": Git resolves each marker path. Git prints one absolute path for each name, in order.
export function markerPathArgs(): string[] {
  return read("rev-parse", "--path-format=absolute", ...OPERATION_MARKERS.flatMap((name) => ["--git-path", name]));
}

// Contract §8 "Change check" (T088 decision E7): Git resolves the file of a `files` ref, also for a per-worktree ref. Git prints one absolute path.
export function refPathArgs(name: string): string[] {
  if (!isRefName(name)) throw new TypeError("ref name refused");
  return read("rev-parse", "--path-format=absolute", "--git-path", name);
}

// The `reftable` format keeps these pseudorefs in the ref store, not as files.
// git-show-ref(1) `--exists`: status 0 when the reference exists, 2 when it is missing, and 1 for another lookup error.
export function pseudorefExistsArgs(name: "CHERRY_PICK_HEAD" | "REVERT_HEAD"): string[] {
  if (name !== "CHERRY_PICK_HEAD" && name !== "REVERT_HEAD") throw new TypeError("pseudoref refused");
  return read("show-ref", "--exists", name);
}

// Contract §6 `repositoryDiscovery`: the git-check-ref-format(1) rules without options, under `refs/`. The shell `is_ref_name` applies the same rules.
const REF_NAME_REFUSED_CHARACTERS = /[\x00-\x20\x7f~^:?*[\\]/;

export function isRefName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.isWellFormed() &&
    name.startsWith("refs/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !REF_NAME_REFUSED_CHARACTERS.test(name) &&
    name.split("/").every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"))
  );
}

// Contract §6 `repositoryDiscovery`: the shell admits exactly this form with one ref name.
// git-show-ref(1) `--exists`: status 0 when the reference exists, 2 when it is missing, and 1 for another lookup error.
export function refExistsArgs(name: string): string[] {
  if (!isRefName(name)) throw new TypeError("ref name refused");
  return [NO_LAZY_FETCH, "show-ref", "--exists", name];
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

// T082 and the T283 record in research R2: the second call of the two-call discovery form. It holds the `rev-parse` options of profiles 2 to 7 in T082 order.
// Run it only after the first profile gives no refusal. `--path-format=absolute` stays in effect for the later path options, as in the separate profiles.
export function discoveryLayoutArgs(): string[] {
  return [NO_LAZY_FETCH, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir", "--git-path", "index", "--show-object-format", "--show-ref-format"];
}
