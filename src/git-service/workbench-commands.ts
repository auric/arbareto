// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract Δ3 and plan.md D2 to D11: the argument arrays of the workbench reads and steps.

import { REFLOG_SCAN_ENTRIES } from "../contracts/limits";
import { isObjectId, isOneLevelRefName, isRefName, type ObjectFormat } from "./commands";

// Contract §7 "Missing objects": every app Git command starts with this option.
const L = "--no-lazy-fetch";
// Plan.md D2: the global options of every read (001 `READ_OPTIONS`).
const read = (...args: string[]): string[] => [L, "--no-optional-locks", "--literal-pathspecs", ...args];
// FR-004: a pathspec of a step stays literal. Research.md R21 F1 ran the mergetool step with this option.
const literal = (...args: string[]): string[] => [L, "--literal-pathspecs", ...args];

// An argv item cannot hold NUL, and an empty path or key names nothing.
function item(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TypeError("argument refused");
  return value;
}

function text(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError("argument refused");
  return value;
}

function ref(name: string): string {
  if (!isRefName(name)) throw new TypeError("ref name refused");
  return name;
}

function under(prefix: "refs/heads/" | "refs/remotes/", name: string): string {
  if (!ref(name).startsWith(prefix)) throw new TypeError("ref name refused");
  return name;
}

const localOrRemote = (name: string): string => (ref(name).startsWith("refs/heads/") ? name : under("refs/remotes/", name));

const branchRef = (branch: string): string => ref(`refs/heads/${branch}`);

// Plan.md D4: a branch name that the rule passed. Git reads `@` as HEAD (research.md R21 F29).
function named(branch: string): string {
  branchRef(branch);
  if (branch === "@") throw new TypeError("branch name refused");
  return branch;
}

function oid(value: string, objectFormat: ObjectFormat): string {
  if (!isObjectId(value, objectFormat)) throw new TypeError("object ID refused");
  return value;
}

// A full object ID or a full ref name. Neither is a revision expression.
const rev = (value: string, objectFormat: ObjectFormat): string => (isObjectId(value, objectFormat) ? value : ref(value));

function paths(list: readonly string[]): string[] {
  if (!Array.isArray(list) || list.length === 0) throw new TypeError("path list refused");
  return list.map(item);
}

export type ConfigWriteScope = "local" | "global";

function scope(value: ConfigWriteScope): string {
  if (value !== "local" && value !== "global") throw new TypeError("scope refused");
  return `--${value}`;
}

// ---- Reads ----

export function branchListArgs(): string[] {
  return read("for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00%(symref)%00%(objecttype)%00%(*objectname)%00%(*objecttype)", "refs/heads", "refs/remotes");
}

export function worktreeListArgs(): string[] {
  return read("worktree", "list", "--porcelain", "-z");
}

// Plan.md D3: tracked changes only, so untracked files cost no listing.
export function trackedStatusArgs(): string[] {
  return read("status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=dirty");
}

// Plan.md D6: builtin/rebase.c calls `require_clean_work_tree` with `ignore_submodules` 1, so a submodule change does not stop a rebase.
export function rebaseStatusArgs(): string[] {
  return read("status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=all");
}

// Contract Δ3 `worktree-remove`: the status of that worktree.
export function worktreeStatusArgs(path: string): string[] {
  return read("-C", item(path), "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty");
}

// Plan.md O-20: the 001 trust listing commands, run in another worktree with `-C`.
export function worktreeConfigListArgs(path: string): string[] {
  return read("-C", item(path), "config", "list", "--show-scope", "--show-origin", "-z");
}

export function worktreeHooksPathArgs(path: string): string[] {
  return read("-C", item(path), "rev-parse", "--git-path", "hooks");
}

// git-worktree(1) `remove`: the index entries of another worktree, for its gitlinks.
export function worktreeIndexArgs(path: string): string[] {
  return read("-C", item(path), "ls-files", "-z", "--stage");
}

// git-rev-parse(1): the top level, the administration folder, and the common folder of another worktree, one line each. It loads no index.
export function worktreeLayoutArgs(path: string): string[] {
  return read("-C", item(path), "rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir");
}

// Contract Δ3 `switch`: the records at and below a branch ref, with the type and the peeled object (git-for-each-ref(1) `*` fields).
export function refPeelArgs(name: string): string[] {
  return read("for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)", localOrRemote(name));
}

// Plan.md D3: exit 0 without output means that no ref holds the commit.
export function containsArgs(commit: string, objectFormat: ObjectFormat): string[] {
  return read("for-each-ref", `--contains=${oid(commit, objectFormat)}`, "--count=1", "--format=%(refname)");
}

export function stashValueArgs(): string[] {
  return read("rev-parse", "--verify", "-q", "refs/stash");
}

// Plan.md D3 stash protocol and the drop step. `log.showSignature` would run the signing program (git-config(1)).
export function stashReflogArgs(): string[] {
  return read("log", "-g", "-z", "--no-show-signature", "--format=%H", "refs/stash", "--");
}

export function changedPathsArgs(head: string, target: string, objectFormat: ObjectFormat): string[] {
  return read("diff-tree", "-r", "-z", "--no-renames", "--name-status", oid(head, objectFormat), oid(target, objectFormat));
}

// The caller splits long lists under the contract §6 command-line limit.
export function stagesArgs(list: readonly string[]): string[] {
  return read("ls-files", "-z", "--stage", "--", ...paths(list));
}

// Research.md R21 F1: Git exits 128 for this read with `--literal-pathspecs`. The paths go on stdin.
export function checkIgnoreArgs(): string[] {
  return [L, "--no-optional-locks", "check-ignore", "-z", "--stdin", "--no-index"];
}

// builtin/check-ref-format.c: `--branch` takes the next item as the name.
export function branchNameCheckArgs(name: string): string[] {
  return read("check-ref-format", "--branch", item(name));
}

// Plan.md D4: ref names hold no glob character (git-check-ref-format(1)), so the `--exclude` pattern is literal.
export function unmergedCountArgs(tip: string, branch: string, objectFormat: ObjectFormat): string[] {
  branchRef(branch);
  return read("rev-list", "--count", oid(tip, objectFormat), "--not", `--exclude=${branch}`, "--branches", "--tags", "--remotes");
}

export function headReflogExistsArgs(): string[] {
  return read("reflog", "exists", "HEAD");
}

export function headReflogArgs(): string[] {
  return read("log", "-g", "-z", "--no-show-signature", "--format=%H", "-n", String(REFLOG_SCAN_ENTRIES), "HEAD", "--");
}

// git-rev-list(1) `--left-right --count`: "left TAB right", so the HEAD side is ahead.
export function mergeCountsArgs(source: string, objectFormat: ObjectFormat): string[] {
  return read("rev-list", "--left-right", "--count", `HEAD...${oid(source, objectFormat)}`);
}

// git-merge-base(1) `--is-ancestor`: exit 0 true, exit 1 false.
export function headIsAncestorArgs(target: string, objectFormat: ObjectFormat): string[] {
  return read("merge-base", "--is-ancestor", "HEAD", rev(target, objectFormat));
}

export function mergeMessageArgs(): string[] {
  return read("fmt-merge-msg");
}

// Plan.md D5: the stdin line of `fmt-merge-msg`, as builtin/merge.c `merge_name` writes it for `git merge <short name>`.
export function mergeMessageInput(sourceRef: string, tip: string, objectFormat: ObjectFormat): string {
  const local = localOrRemote(sourceRef).startsWith("refs/heads/");
  const name = sourceRef.slice(local ? "refs/heads/".length : "refs/remotes/".length);
  return `${oid(tip, objectFormat)}\t\t${local ? "branch" : "remote-tracking branch"} '${name}' of .\n`;
}

// Plan.md D6: the walk of sequencer.c `sequencer_make_script`. `rebase.rebaseMerges` keeps the merge commits.
export function movedCountArgs(onto: string, rebaseMerges: boolean, objectFormat: ObjectFormat): string[] {
  return read("rev-list", "--count", "--right-only", "--cherry-pick", ...(rebaseMerges ? [] : ["--no-merges"]), `${oid(onto, objectFormat)}...HEAD`);
}

export function rewrittenCountArgs(onto: string, objectFormat: ObjectFormat): string[] {
  return read("rev-list", "--count", `${oid(onto, objectFormat)}..HEAD`);
}

export function heldCountArgs(onto: string, objectFormat: ObjectFormat): string[] {
  return read("rev-list", "--count", `${oid(onto, objectFormat)}..HEAD`, "--not", "--remotes");
}

export function forceNoteCountArgs(onto: string, tracking: string, objectFormat: ObjectFormat): string[] {
  return read("rev-list", "--count", `${oid(onto, objectFormat)}..HEAD`, "--not", ref(tracking));
}

// Plan.md D6: the commits that sequencer.c `sequencer_make_script` walks, with each mark and parent. `rebase.rebaseMerges` keeps the merge commits.
export function rebaseWalkArgs(onto: string, rebaseMerges: boolean, objectFormat: ObjectFormat): string[] {
  return read("rev-list", "--right-only", "--cherry-mark", ...(rebaseMerges ? [] : ["--no-merges"]), "--parents", `${oid(onto, objectFormat)}...HEAD`);
}

// Plan.md D4: the entries of the local configuration file alone. git-config(1) `--no-includes` leaves out the files that it includes.
export function localConfigArgs(): string[] {
  return configFileArgs("local");
}

// Plan.md D11: the scope file alone, so the view can tell its entries from the entries of included files.
export function configFileArgs(target: ConfigWriteScope): string[] {
  return read("config", "list", scope(target), "--no-includes", "--show-scope", "--show-origin", "-z");
}

export function excludePathArgs(): string[] {
  return read("rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
}

export function commitObjectArgs(head: string, objectFormat: ObjectFormat): string[] {
  return read("cat-file", "commit", oid(head, objectFormat));
}

export function upstreamOfArgs(headRef: string): string[] {
  return read("for-each-ref", "--format=%(upstream)", under("refs/heads/", headRef));
}

// ---- Steps ----

// Contract Δ3: this argv has no end-of-options marker, so a name that starts with `-` would be an option.
export function switchArgs(branch: string): string[] {
  if (!isOneLevelRefName(branch)) throw new TypeError("branch name refused");
  return [L, "checkout", "--no-guess", "--no-recurse-submodules", named(branch), "--"];
}

export function trackArgs(name: string, remoteRef: string): string[] {
  return [L, "checkout", "--no-guess", "--no-recurse-submodules", "-b", named(name), "--track=direct", under("refs/remotes/", remoteRef), "--"];
}

export function detachArgs(commit: string, objectFormat: ObjectFormat): string[] {
  return [L, "checkout", "--no-recurse-submodules", "--detach", oid(commit, objectFormat), "--"];
}

// `target` names the switch target for the stash message.
export function stashPushArgs(target: string): string[] {
  return [L, "stash", "push", "--quiet", "-m", `Arbareto: switch to ${item(target)}`];
}

// git-stash(1): `apply` takes a commit that looks like a stash, so the object ID binds the exact stash.
export function stashApplyArgs(stash: string, objectFormat: ObjectFormat): string[] {
  return [L, "stash", "apply", "--index", oid(stash, objectFormat)];
}

export function stashDropArgs(position: number): string[] {
  if (!Number.isSafeInteger(position) || position < 0) throw new TypeError("stash position refused");
  return [L, "stash", "drop", "--quiet", `stash@{${position}}`];
}

export function createSwitchArgs(name: string, start: string, objectFormat: ObjectFormat): string[] {
  return [L, "checkout", "--no-recurse-submodules", "-b", named(name), oid(start, objectFormat), "--"];
}

export function createArgs(name: string, start: string, objectFormat: ObjectFormat): string[] {
  return [L, "branch", "--end-of-options", named(name), oid(start, objectFormat)];
}

// Research.md R21 F29: `branch -m` reads the old name `@` as a branch name.
export function renameArgs(old: string, name: string): string[] {
  branchRef(old);
  return [L, "branch", "-m", "--end-of-options", old, named(name)];
}

// git-update-ref(1): Git refuses the delete when the ref no longer holds `tip`.
export function deleteRefArgs(branch: string, tip: string, objectFormat: ObjectFormat): string[] {
  return [L, "update-ref", "--no-deref", "-d", branchRef(branch), oid(tip, objectFormat)];
}

export function removeBranchSectionArgs(branch: string): string[] {
  branchRef(branch);
  return [L, "config", "--local", "--remove-section", `branch.${branch}`];
}

export type MergeChoice = { result: "merge"; noFastForward: boolean; noCommit: boolean; message: string } | { result: "squash" };

// Plan.md D5 and research.md R21 F12, F30: a merge commit always passes `--no-log -m`. Git ignores `-m` with `--squash`.
export function mergeArgs(sourceRef: string, choice: MergeChoice): string[] {
  const end = ["--end-of-options", localOrRemote(sourceRef)];
  if (choice?.result === "squash") return [L, "merge", "--no-autostash", "--no-edit", "--squash", ...end];
  if (choice?.result !== "merge") throw new TypeError("merge result refused");
  const flags = [...(choice.noFastForward ? ["--no-ff"] : []), ...(choice.noCommit ? ["--no-commit"] : [])];
  return [L, "merge", "--no-autostash", "--no-edit", ...flags, "--no-log", "-m", item(choice.message), ...end];
}

// Plan.md D6: the explicit forms, so Git does what the check boxes show (research.md R21 F15).
export function rebaseOntoArgs(ontoRef: string, autostash: boolean, autosquash: boolean): string[] {
  return [L, "rebase", autostash ? "--autostash" : "--no-autostash", autosquash ? "--autosquash" : "--no-autosquash", "--end-of-options", localOrRemote(ontoRef)];
}

export function chooseSideArgs(side: "ours" | "theirs", path: string): string[] {
  if (side !== "ours" && side !== "theirs") throw new TypeError("side refused");
  return literal("checkout", "--no-recurse-submodules", `--${side}`, "--", item(path));
}

// Plan.md D7: the global option reaches the mergetool script as `GIT_LITERAL_PATHSPECS` (git(1)).
export function mergetoolArgs(tool: string, path: string): string[] {
  return literal("mergetool", `--tool=${item(tool)}`, "--no-prompt", "--", item(path));
}

export function worktreeAddNewArgs(name: string, path: string, start: string, objectFormat: ObjectFormat): string[] {
  return [L, "worktree", "add", "-b", named(name), "--", item(path), oid(start, objectFormat)];
}

// Research.md R21 F17: `worktree add` checks out a branch only for its short name.
export function worktreeAddExistingArgs(path: string, branch: string): string[] {
  return [L, "worktree", "add", "--", item(path), named(branch)];
}

export function worktreeRemoveArgs(path: string, force: boolean): string[] {
  return [L, "worktree", "remove", ...(force ? ["--force"] : []), "--", item(path)];
}

export function worktreePruneArgs(): string[] {
  return [L, "worktree", "prune"];
}

// Research.md R21 F22: a value that starts with `-` stays a value after `--`.
export function configSetArgs(target: ConfigWriteScope, key: string, value: string): string[] {
  return [L, "config", "set", scope(target), "--", item(key), text(value)];
}

export function configUnsetArgs(target: ConfigWriteScope, key: string): string[] {
  return [L, "config", "unset", scope(target), "--", item(key)];
}

// Contract Δ3 `commit` with `amend`: the message comes on stdin.
export function amendArgs(): string[] {
  return [L, "commit", "--quiet", "--amend", "--file=-"];
}
