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

// A path is relative to the worktree root, where Git runs (research R3). An argv item cannot hold NUL, and an empty pathspec matches every path.
function pathItem(path: string): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw new TypeError("path refused");
  return path;
}

function treeItem(oid: string, objectFormat: ObjectFormat): string {
  if (!isObjectId(oid, objectFormat)) throw new TypeError("object ID refused");
  return oid;
}

// Contract §7: status and diff reads pass `--ignore-submodules=dirty`. Research R3: the prefix and relative options override the diff UI keys.
const PATCH_OPTIONS = ["-p", "--no-textconv", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=dirty"] as const;

// Contract §4: the unstage hunks. The tree is the captured HEAD OID or the empty tree of `emptyTreeArgs`.
export function stagedPatchArgs(tree: string, objectFormat: ObjectFormat, path: string): string[] {
  return read("diff-index", "--cached", ...PATCH_OPTIONS, treeItem(tree, objectFormat), "--", pathItem(path));
}

// T111: the complete staged scope of `reviewCommit`.
export function stagedNameStatusArgs(tree: string, objectFormat: ObjectFormat): string[] {
  return read("diff-index", "--cached", "-z", "--name-status", "--ignore-submodules=dirty", treeItem(tree, objectFormat));
}

// Contract §4: the stage hunks.
export function unstagedPatchArgs(path: string): string[] {
  return read("diff-files", ...PATCH_OPTIONS, "--", pathItem(path));
}

// Contract §4 and research R3 "Untracked hunk content": the T092 form. `--no-relative` has no effect with `--no-index`, so the form omits it.
// The clean filter still runs, so `check-attr` refuses a `filter` attribute first.
export function untrackedPatchArgs(path: string): string[] {
  return read("diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", pathItem(path));
}

// T103: the binary signal of each comparison scope. git-diff(1) `--numstat`: "For binary files, outputs two `-` instead of saying `0 0`."
const NUMSTAT_OPTIONS = ["--numstat", "-z", "--no-textconv", "--no-ext-diff", "--no-relative", "--ignore-submodules=dirty"] as const;

export function stagedNumstatArgs(tree: string, objectFormat: ObjectFormat, path: string): string[] {
  return read("diff-index", "--cached", ...NUMSTAT_OPTIONS, treeItem(tree, objectFormat), "--", pathItem(path));
}

export function unstagedNumstatArgs(path: string): string[] {
  return read("diff-files", ...NUMSTAT_OPTIONS, "--", pathItem(path));
}

// `--no-index` prints the record in its two-path form, with `/dev/null` as the preimage path.
export function untrackedNumstatArgs(path: string): string[] {
  return read("diff", "--no-index", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", pathItem(path));
}

// T103: the attributes of the support decision. Paths go only on stdin.
export function attributeArgs(): string[] {
  return read("check-attr", "-z", "--stdin", "filter", "diff", "text", "eol", "crlf", "working-tree-encoding");
}

// Contract §4: `mixed` on the index or working side refuses hunks. `i/none` does not mean a missing object.
export function lineEndingArgs(): string[] {
  return read("ls-files", "--eol", "-z");
}

// The empty tree OID of the object format, with empty stdin. Without `-w`, Git writes no object.
export function emptyTreeArgs(): string[] {
  return read("hash-object", "-t", "tree", "--stdin");
}

// T104 mutation steps. Only the `mutation` policy and a `transactionId` set `GIT_INDEX_FILE` (contract §7), so no array names an index.
// The candidate `ls-files` read uses `indexEntryArgs`. Research R3 steps 7 and 8: `apply` names no patch file, so it reads the retained patch from stdin.
export function applyCachedArgs(): string[] {
  return [NO_LAZY_FETCH, "apply", "--cached"];
}

export function applyCachedReverseArgs(): string[] {
  return [NO_LAZY_FETCH, "apply", "--cached", "--reverse"];
}

// Contract §4: an absent candidate gets its first index from Git, never a zero-byte file.
export function readTreeEmptyArgs(): string[] {
  return [NO_LAZY_FETCH, "read-tree", "--empty"];
}

// Research R3 step 9: the computed entry bytes come on stdin. Without `-w`, Git writes no object.
export function entryHashArgs(): string[] {
  return [NO_LAZY_FETCH, "hash-object", "--no-filters", "--stdin"];
}

// T112: the identity check before the commit (git-var(1)).
export function authorIdentArgs(): string[] {
  return [NO_LAZY_FETCH, "var", "GIT_AUTHOR_IDENT"];
}

export function committerIdentArgs(): string[] {
  return [NO_LAZY_FETCH, "var", "GIT_COMMITTER_IDENT"];
}

// Contract §4 "Commit validation and handoff": the bounded message comes on stdin.
export function commitArgs(): string[] {
  return [NO_LAZY_FETCH, "commit", "--quiet", "--file=-"];
}

// T199, contract §4 "File staging" step 5. `stage` writes the literal path bytes on stdin. `unstage` writes the HEAD mode and object ID of each path, and mode 0 removes a path.
export function updateIndexAddArgs(): string[] {
  return [NO_LAZY_FETCH, "update-index", "--add", "--remove", "-z", "--stdin"];
}

export function updateIndexInfoArgs(): string[] {
  return [NO_LAZY_FETCH, "update-index", "-z", "--index-info"];
}

// Contract §4 "Blob proof". Proof A writes the staged blob in working-tree form. Proof B reads the working-file stream on stdin. Without `-w`, Git writes no object.
export function blobFilterProofArgs(path: string, oid: string, objectFormat: ObjectFormat): string[] {
  return read("cat-file", "--filters", `--path=${pathItem(path)}`, treeItem(oid, objectFormat));
}

export function blobHashProofArgs(path: string): string[] {
  return read("hash-object", "--stdin", `--path=${pathItem(path)}`);
}

// T113: the reconciliation read of the actual commit tree. It takes one full commit OID, never a revision expression.
export function commitTreeArgs(oid: string, objectFormat: ObjectFormat): string[] {
  return read("ls-tree", "-r", "-z", treeItem(oid, objectFormat));
}

// T082 and the T283 record in research R2: the second call of the two-call discovery form. It holds the `rev-parse` options of profiles 2 to 7 in T082 order.
// Run it only after the first profile gives no refusal. `--path-format=absolute` stays in effect for the later path options, as in the separate profiles.
export function discoveryLayoutArgs(): string[] {
  return [NO_LAZY_FETCH, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir", "--git-path", "index", "--show-object-format", "--show-ref-format"];
}

// T227, contract §12 "Discovery notice": this read loads no index and runs no filter (§7).
export function gitmodulesListArgs(): string[] {
  return read("config", "--file", ".gitmodules", "--null", "--list");
}

// Contract §12 "Review reads": the fallback sources after the worktree `.gitmodules`. Git `submodule.h` names them `GITMODULES_INDEX` and `GITMODULES_HEAD`.
// Contract §7: `:.gitmodules` loads the index, so the index source is the stage-0 object ID.
export function gitmodulesIndexArgs(oid: string, objectFormat: ObjectFormat): string[] {
  return read("config", "--blob", treeItem(oid, objectFormat), "--null", "--list");
}

export function gitmodulesHeadArgs(): string[] {
  return read("config", "--blob", "HEAD:.gitmodules", "--null", "--list");
}

// Contract §12 "Review reads": the folder of the kept submodule Git directories. A linked worktree keeps its own folder. Git prints one absolute path.
export function modulesPathArgs(): string[] {
  return read("rev-parse", "--path-format=absolute", "--git-path", "modules");
}

function pathItems(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError("path list refused");
  return paths.map(pathItem);
}

// Contract §12 "Review reads": the top-level checked-out commits. The caller splits long lists under the §6 command-line limit.
export function gitlinkPatchArgs(paths: readonly string[]): string[] {
  return read("diff-files", "-p", "--ignore-submodules=dirty", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--", ...pathItems(paths));
}

// Contract §12 "Plan": the `submodule.active` values are pathspecs for Git's own matcher (git-config(1)). `--literal-pathspecs` turns that matcher off (git(1)), so this read omits it.
// A nested level runs it in the worktree of the parent submodule.
export function activeSetArgs(pathspecs: readonly string[], parentWorktree?: string): string[] {
  const at = parentWorktree === undefined ? [] : ["-C", pathItem(parentWorktree)];
  return [NO_LAZY_FETCH, "--no-optional-locks", ...at, "ls-files", "-z", "--stage", "--", ...pathItems(pathspecs)];
}

// Contract §12 "Review reads": an initialized submodule runs Git in its worktree. A kept Git directory, or a `reuse` row, names the Git directory as the work tree too.
export type SubmoduleLocation = { worktree: string } | { gitDir: string };

function submoduleRead(location: SubmoduleLocation, ...args: string[]): string[] {
  if (location === null || typeof location !== "object" || Object.keys(location).length !== 1) throw new TypeError("submodule location refused");
  const at = "worktree" in location ? ["-C", pathItem(location.worktree)] : [`--git-dir=${pathItem(location.gitDir)}`, `--work-tree=${location.gitDir}`];
  return [NO_LAZY_FETCH, "--no-optional-locks", ...at, ...args];
}

export function submoduleHeadOidArgs(location: SubmoduleLocation): string[] {
  return submoduleRead(location, "rev-parse", "--verify", "-q", "HEAD");
}

export function submoduleGitDirArgs(location: SubmoduleLocation): string[] {
  return submoduleRead(location, "rev-parse", "--absolute-git-dir");
}

export function submoduleHooksPathArgs(location: SubmoduleLocation): string[] {
  return submoduleRead(location, "rev-parse", "--git-path", "hooks");
}

export function submoduleHeadTargetArgs(location: SubmoduleLocation): string[] {
  return submoduleRead(location, "symbolic-ref", "-q", "HEAD");
}

// Contract §12 "Update protocol", read failures: only the exit status decides. git-show-ref(1) `--exists`: 0 present, 2 missing, 1 another lookup error.
export function submoduleRefExistsArgs(location: SubmoduleLocation, name: string): string[] {
  if (!isRefName(name)) throw new TypeError("ref name refused");
  return submoduleRead(location, "show-ref", "--exists", name);
}

export function submoduleConfigListArgs(location: SubmoduleLocation): string[] {
  return submoduleRead(location, "config", "list", "--show-scope", "--show-origin", "-z");
}

// Contract §12 "Refusals": every ref counts. Exit 0 without output means that no ref contains HEAD.
export function submoduleHeadRefArgs(location: SubmoduleLocation): string[] {
  return submoduleRead(location, "for-each-ref", "--contains=HEAD", "--count=1", "--format=%(refname)");
}

// Object IDs go only on stdin.
export function submoduleObjectCheckArgs(location: SubmoduleLocation): string[] {
  return submoduleRead(location, "cat-file", "--batch-check");
}

// Git `is_tip_reachable` (builtin/submodule--helper.c:2493-2514): exit 0 without output means that a ref or HEAD reaches the target.
export function submoduleReachArgs(location: SubmoduleLocation, target: string, objectFormat: ObjectFormat): string[] {
  return submoduleRead(location, "rev-list", "-n", "1", treeItem(target, objectFormat), "--not", "--all");
}

export function submoduleTreeArgs(location: SubmoduleLocation, commit: string, objectFormat: ObjectFormat): string[] {
  return submoduleRead(location, "ls-tree", "-r", "-z", "--full-tree", treeItem(commit, objectFormat));
}

export function submoduleGitmodulesBlobArgs(location: SubmoduleLocation, commit: string, objectFormat: ObjectFormat): string[] {
  return submoduleRead(location, "config", "--blob", `${treeItem(commit, objectFormat)}:.gitmodules`, "--null", "--list");
}

// Contract §12 "Update protocol" step 5: the fallback fetch reads the rewritten remote URLs. `--` keeps the remote name literal.
export function remoteUrlArgs(location: SubmoduleLocation, name: string): string[] {
  return submoduleRead(location, "remote", "get-url", "--all", "--", pathItem(name));
}

// Contract §12 "Update protocol" step 5: the update steps. `:(literal)` keeps the path literal (probe S8). No step passes `--recursive`.
const literalPathspec = (path: string): string => `:(literal)${pathItem(path)}`;

// `-c fetch.recurseSubmodules=no` stops the on-demand fetch recursion inside the clone step (probe S27).
export function submoduleCloneArgs(parentWorktree: string, path: string): string[] {
  return [NO_LAZY_FETCH, "-c", "fetch.recurseSubmodules=no", "-C", pathItem(parentWorktree), "submodule", "update", "--init", "--progress", "--", literalPathspec(path)];
}

// The connect step and the checkout step use the same command.
export function submoduleCheckoutArgs(parentWorktree: string, path: string): string[] {
  return [NO_LAZY_FETCH, "-C", pathItem(parentWorktree), "submodule", "update", "--init", "--no-fetch", "--progress", "--", literalPathspec(path)];
}

export function submoduleRegisterArgs(parentWorktree: string, path: string): string[] {
  return [NO_LAZY_FETCH, "-C", pathItem(parentWorktree), "submodule", "init", "--", literalPathspec(path)];
}

export function submoduleFetchArgs(worktree: string): string[] {
  return [NO_LAZY_FETCH, "-C", pathItem(worktree), "fetch", "--progress", "--no-recurse-submodules"];
}

export function submoduleFallbackFetchArgs(worktree: string, remote: string, target: string, objectFormat: ObjectFormat): string[] {
  return [NO_LAZY_FETCH, "-C", pathItem(worktree), "fetch", "--progress", "--no-recurse-submodules", "--", pathItem(remote), treeItem(target, objectFormat)];
}
