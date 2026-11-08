// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T229: contract §12 "Review reads", "Plan", "Refusals", and "Trust", and data-model §6 "Submodule review" and §9.
// T230: the update repeats these reads through `observe` (contract §12 "Update protocol" steps 2, 3, and 6).
// Inside a submodule, the review starts only the `submodule*Args` reads of `commands.ts`.

import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, posix, resolve } from "node:path";
import type { FileFact } from "../contracts/channel";
import type { ErrorCode } from "../contracts/errors";
import {
  APPROVAL_LIFETIME_MS,
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  STATUS_LISTING_BYTES,
  SUBMODULE_GITMODULES_BYTES,
  SUBMODULE_REVIEW_NESTING_LEVELS,
  SUBMODULE_REVIEW_SUBMODULES,
  SUBMODULE_TREE_FOLDERS,
  SUBMODULE_WORK_PARALLEL,
  TRUST_INPUT_BYTES,
  WINDOWS_COMMAND_LINE_UNITS,
} from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import {
  buildRefusalRemedy,
  buildSubmoduleRemedy,
  redactUrlUserInfo,
  sameSubmoduleHost,
  submoduleUrlHost,
  type SubmoduleAction,
  type SubmoduleBranch,
  type SubmoduleHost,
  type SubmoduleHostLine,
  type SubmodulePlanRow,
  type SubmoduleProgram,
  type SubmoduleRefusalReason,
  type SubmoduleWslTarget,
} from "../contracts/submodules";
import { routeWslPath, wslIdentityPath } from "../contracts/wsl-route";
import type { Approvals, SubmoduleBinding } from "./approvals";
import {
  activeSetArgs,
  gitlinkPatchArgs,
  gitmodulesHeadArgs,
  gitmodulesIndexArgs,
  gitmodulesListArgs,
  isObjectId,
  isOneLevelRefName,
  modulesPathArgs,
  objectCheckArgs,
  submoduleConfigListArgs,
  submoduleGitDirArgs,
  submoduleGitmodulesBlobArgs,
  submoduleGitPathsArgs,
  submoduleHeadOidArgs,
  submoduleHeadRefArgs,
  submoduleHeadTargetArgs,
  submoduleHeadTargetNoRecurseArgs,
  submoduleObjectCheckArgs,
  submoduleReachArgs,
  submoduleRefExistsArgs,
  submoduleRefFormatArgs,
  submoduleTrackingArgs,
  submoduleTreeArgs,
  type ObjectFormat,
  type SubmoduleLocation,
} from "./commands";
import { unquote } from "./diff-parser";
import { createCollector, exitKind, stepUnits, type GitRunner, type WalkStop } from "./git-runner";
import { sharedListing, type HistoryReaderOptions } from "./history";
import { isMissing, runRead } from "./read-steps";
import type { Workspace } from "./registration";
import type { ChangeSnapshot, Completeness, Head, IndexEntry, ReadInstallation } from "./snapshot";
import { displayPath } from "./status-parser";
import { defaultRemote, resolveGitmodulesUrl, SubmoduleUrlError, type GitPlatform } from "./submodule-remote";
import { parseTracking } from "./sync-parsers";
import {
  isComponent,
  keyParts,
  listSubmoduleTrust,
  parseConfigListing,
  parseMaybeBool,
  relativePathEntries,
  requestFacts,
  valueShown,
  type ConfigEntry,
  type FactEntry,
  type FileState,
  type ListingOutcome,
  type ServiceEnvironment,
  type Trust,
  type TrustListing,
} from "./trust";

const GITMODULES = Buffer.from(".gitmodules");

export interface GitmodulesIndexEntry {
  path: Uint8Array;
  stage: number;
  oid: string;
}

// The `.gitmodules` source in Git's order (Git `submodule-config.c` `config_from_gitmodules`): the worktree file, the stage-0 index blob, then the HEAD blob.
// Null: no source exists. `headHas` runs only when the first two sources are absent, and a value other than a boolean passes through.
export async function gitmodulesSource<S>(
  worktreeEntry: boolean,
  index: readonly GitmodulesIndexEntry[],
  objectFormat: ObjectFormat,
  headHas: () => Promise<boolean | S>,
): Promise<string[] | null | S> {
  if (worktreeEntry) return gitmodulesListArgs();
  const staged = index.find((e) => e.stage === 0 && GITMODULES.equals(e.path));
  if (staged !== undefined) return gitmodulesIndexArgs(staged.oid, objectFormat);
  const head = await headHas();
  if (head === true) return gitmodulesHeadArgs();
  return head === false ? null : head;
}

// `cat-file --batch-check` of `HEAD:.gitmodules`: `<name> missing` for an absent object, `<oid> <type> <size>` otherwise.
// A `<rev>:<path>` name loads no index. Null: the output is not that form.
export function headGitmodulesOf(out: Uint8Array, objectFormat: ObjectFormat): boolean | null {
  const line = /^([^\n]*)\n$/.exec(latin1(out))?.[1] ?? null;
  if (line === "HEAD:.gitmodules missing") return false;
  const found = line === null ? null : /^(\S+) (?:blob|tree|commit|tag) [0-9]+$/.exec(line);
  return found !== null && isObjectId(found[1]!, objectFormat) ? true : null;
}

// Contract §11 "Paths and file access": the path forms of one workspace. A Windows workspace uses its native paths everywhere.
// A WSL workspace gives Git and the remedy commands Linux paths. Its folder metadata goes through the UNC form.
export interface PathForms {
  // The worktree root as `rev-parse --show-toplevel` prints it.
  gitRoot: string;
  // The worktree root in the form of Git arguments and remedy commands.
  root: string;
  join(base: string, ...parts: string[]): string;
  resolve(base: string, path: string): string;
  // The UNC form of a Linux path. Null: the path has no UNC form (contract §11 "Route").
  native(path: string): string | null;
  platform: GitPlatform;
  // The Git path of the remedy commands.
  gitPath: string | null;
  wsl: SubmoduleWslTarget | undefined;
}

export function pathForms(w: Pick<Workspace, "worktreeRoot" | "wsl">, installation: Pick<ReadInstallation, "selectedPath">): PathForms {
  if (w.wsl === undefined) {
    return { gitRoot: w.worktreeRoot, root: resolve(w.worktreeRoot), join, resolve, native: (path) => path, platform: "windows", gitPath: installation.selectedPath, wsl: undefined };
  }
  const { distro, guid, wslExecutable, path } = w.wsl;
  const route = routeWslPath(w.worktreeRoot, { listed: [distro], registry: [{ name: distro, guid, version: 2 }] });
  if (route.kind !== "wsl") throw new TypeError("a WSL workspace needs a Linux worktree root");
  return {
    gitRoot: route.linuxPath,
    root: route.linuxPath,
    join: (base, ...parts) => posix.join(base, ...parts),
    resolve: (base, linux) => posix.resolve(base, linux),
    native: (linux) => wslIdentityPath(distro, linux),
    platform: "posix",
    gitPath: path,
    wsl: { wslExecutable, distro },
  };
}

// Contract §12 "Review reads": the `diff-files` path batches. Each batch fits the §6 command-line bound under `units`.
export function gitlinkBatches(texts: readonly string[], units: (args: string[]) => number): string[][] {
  const batches: string[][] = [];
  for (const text of texts) {
    const last = batches.at(-1);
    if (last !== undefined && units(gitlinkPatchArgs([...last, text])) <= WINDOWS_COMMAND_LINE_UNITS) last.push(text);
    else batches.push([text]);
  }
  return batches;
}

// ---- Texts (contract §12 "Refusals" and "Plan") ----

const short = (oid: string) => oid.slice(0, 12);
export const REFUSAL_TEXTS = {
  unsavedCommits: (path: string, oid: string) => `Submodule ${path} is at commit ${short(oid)}, which the update can leave without a branch, tag, or other ref. Save it with the command, then use Refresh.`,
  updateMode: (path: string, mode: string) => `Submodule ${path} uses the update mode ${mode}. Arbareto updates only submodules that Git checks out. Use the command in a terminal.`,
  cloneInterrupted: (path: string) => `Git stopped while it cloned submodule ${path}. Move the folder ${path} out of the repository after all Git tools stop. Then use Update submodules again.`,
  folderNotEmpty: (path: string) => `Submodule ${path} has no Git link, but its folder is not empty. Git would overwrite those files. Move the folder out of the repository, then use Refresh.`,
  noUrl: (path: string) => `The .gitmodules file has no entry for submodule ${path}. Git cannot update it.`,
  path: (path: string) => `Arbareto cannot pass the path of submodule ${path} to Git literally.`,
  uncPath: (path: string) => `Arbareto cannot read the folder of submodule ${path} through Windows, because a name in it holds a character that Windows names cannot hold. Update it in a terminal.`,
  activeValue: (path: string, name: string) => `Submodule ${path} has a submodule.${name}.active value that is not true or false. Fix it in a terminal, then use Refresh.`,
  remoteName: (path: string, name: string) => `Submodule ${path} has a remote named ${name}, which Git can read as an option. Rename that remote in a terminal, then use Refresh.`,
  gitdirConfig: "This repository sets custom locations for submodule Git folders. Arbareto reads only the default location. Update the submodules in a terminal.",
  // Feature 004 contract Δ12 "Submodule bound": the 001 §12 text names SUBMODULE_REVIEW_SUBMODULES.
  limit: "This repository has more than 1,024 submodules or more than 8 nesting levels. Update them in a terminal.",
  // Feature 004 contract Δ12.
  parentNotInitialized: (parent: string, path: string) => `Submodule ${parent} is not initialized. Update ${parent} first, then update submodule ${path}.`,
  inactive: (path: string) => `Submodule ${path} is not active, and Arbareto does not activate submodules. Activate it with the command, then update it again.`,
};
const NOTES = {
  relative: "Git resolves this URL against the remote of the parent repository.",
  remotesDiffer: "Git fetches from the submodule remotes, not from this URL.",
  noRemote: "This submodule has no remote. Git cannot fetch a missing commit.",
  registers: "Git registers the URL in the repository settings.",
  activates: "Git marks this submodule active.",
  detaches: (branch: string) => `Git detaches HEAD from branch ${branch}.`,
  moves: (from: string, to: string) => `Git moves HEAD from ${short(from)} to ${short(to)}.`,
  fetches: "Git fetches in this submodule before the checkout.",
  nestedActive: (parent: string) => `Git applies the active submodules of ${parent}.`,
};

// ---- Result ----

// Contract §9 `UNSUPPORTED_SUBMODULE`: the submodule path and one reason, with the contract §12 text and remedy.
export interface SubmoduleRefusal {
  code: "UNSUPPORTED_SUBMODULE";
  reason: SubmoduleRefusalReason;
  path: string;
  text: string;
  remedy: { command: string | null; text?: string } | null;
}

export interface SubmoduleReviewValue {
  generation: number;
  rows: SubmodulePlanRow[];
  programs: SubmoduleProgram[];
  refusals: SubmoduleRefusal[];
  // Feature 004 contract Δ12: `updateSubmodules` needs `confirmHosts` when this list is not empty.
  hosts: SubmoduleHostLine[];
  // Feature 004 contract Δ12 "Branch marks", in row order. A scoped review gives none. The token does not bind them.
  branches: SubmoduleBranch[];
  submoduleReviewToken: string;
}

export type SubmoduleReviewOutcome =
  | { result: "succeeded"; value: SubmoduleReviewValue }
  | { result: "limited"; code: Exclude<Completeness, { state: "complete" }>["code"]; value: { completeness: Completeness } }
  | { result: "failed"; code: ErrorCode; value?: { path: string } }
  | { result: "canceled" }
  | { result: "deadline" };

export interface ObserveTarget {
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
  installation: ReadInstallation;
}

export interface SubmoduleReviewTarget extends ObserveTarget {
  snapshot: ChangeSnapshot;
  // The request generation. It selects the shared trust listing (001 contract §7 "Shared listing").
  generation: number;
  // Feature 004 contract Δ12: the review covers this row and its nested rows.
  scope?: { path: string };
}

// The superproject facts of an observation: a snapshot for the review, or `captureHead` and `ls-files -z --stage` for the update.
export interface SuperprojectInput {
  head: Head;
  indexEntries: readonly Pick<IndexEntry, "path" | "stage" | "mode" | "oid">[];
}

// The review that T230 revalidates. `review` and `programs` are the inputs of the binding digests. `fingerprint` is the superproject listing fingerprint.
export interface RetainedSubmoduleReview {
  repositoryId: string;
  issuedAt: number;
  value: SubmoduleReviewValue;
  fingerprint: string;
  review: unknown;
  programs: unknown;
  // The UTF-8 bytes of the scope path, or null for every row. The update observes with the same scope.
  scope: Uint8Array | null;
}

// `path`: the folder of a failed folder read (contract §12 "Update protocol", read failures).
type Failure = { code: ErrorCode; path?: string };
export type SubmoduleFact<T> = { value: T } | Failure | WalkStop;

class Halt {
  constructor(readonly fact: Failure | WalkStop) {}
}

const NUL = 0x00;
const NEWLINE = 0x0a;
const TAB = 0x09;
// Feature 004 contract Δ12 "Submodule bound": one row can hold TRUST_INPUT_BYTES, so this total bounds the service memory of a review.
const REVIEW_CONFIG_BYTES = 64 * 1024 * 1024;
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const sha256 = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
const failed = (code: ErrorCode, path?: string) => new Halt({ code, ...(path === undefined ? {} : { path }) });
const emptyModules = (): Gitmodules => ({ byName: new Map(), nameOf: new Map() });

// NUL-terminated records. Bytes after the last NUL belong to no record.
function records(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; ; ) {
    const nul = bytes.indexOf(NUL, at);
    if (nul < 0) return out;
    out.push(bytes.subarray(at, nul));
    at = nul + 1;
  }
}

// The text of a one-line output that ends with LF.
function oneLine(bytes: Uint8Array): string | null {
  if (bytes.length < 2 || bytes[bytes.length - 1] !== NEWLINE || bytes.indexOf(NEWLINE) !== bytes.length - 1) return null;
  try {
    return utf8.decode(bytes.subarray(0, -1));
  } catch {
    return null;
  }
}

// Contract §6 "File facts" and data-model §5: a path that Git can take literally has valid UTF-8 components.
export function componentsOf(path: Uint8Array): string[] | null {
  let text: string;
  try {
    text = utf8.decode(path);
  } catch {
    return null;
  }
  const parts = text.split("/");
  return parts.every(isComponent) ? parts : null;
}

// Git `submodule-config.c` `check_submodule_name`: Git ignores a `.gitmodules` name that is empty or holds a `..` component.
function suspiciousName(name: string): boolean {
  return name === "" || name.split(/[\\/]/).includes("..");
}

// Git `submodule-config.c` `parse_config`: Git ignores a `path` or `url` value that looks like a command-line option.
interface Module {
  path?: string;
  url?: string;
  update?: string;
}
export interface Gitmodules {
  byName: Map<string, Module>;
  // The path bytes (latin1) to the name. A later `path` value of a name replaces its earlier path (`gitmodules_cb` sets `overwrite`).
  nameOf: Map<string, string>;
}

export function parseGitmodules(bytes: Uint8Array): Gitmodules | null {
  if (bytes.length > 0 && bytes[bytes.length - 1] !== NUL) return null;
  const byName = new Map<string, Module>();
  const pathOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const record of records(bytes)) {
    const lf = record.indexOf(NEWLINE);
    const key = latin1(lf < 0 ? record : record.subarray(0, lf));
    if (key === "") return null;
    const p = keyParts(key);
    if (p === null || p.section !== "submodule" || p.subsection === null || lf < 0) continue;
    const name = p.subsection;
    if (suspiciousName(name)) continue;
    const value = latin1(record.subarray(lf + 1));
    const module = byName.get(name) ?? {};
    if (p.variable === "path") {
      if (value.startsWith("-")) continue;
      const old = pathOf.get(name);
      if (old !== undefined) nameOf.delete(old);
      pathOf.set(name, value);
      nameOf.set(value, name);
      module.path = value;
    } else if (p.variable === "url") {
      if (value.startsWith("-")) continue;
      module.url = value;
    } else if (p.variable === "update") module.update = value;
    byName.set(name, module);
  }
  return { byName, nameOf };
}

// The last value of a key in a configuration listing, or undefined.
function lastValue(entries: readonly ConfigEntry[], match: (key: string) => boolean): ConfigEntry | undefined {
  let found: ConfigEntry | undefined;
  for (const entry of entries) if (match(entry.key)) found = entry;
  return found;
}
const submoduleKey = (name: string, variable: string) => (key: string) => {
  const p = keyParts(key);
  return p !== null && p.section === "submodule" && p.subsection === name && p.variable === variable;
};

// Contract §12 "Refusals" `gitdir-config`.
function setsGitdir(entries: readonly ConfigEntry[]): boolean {
  return entries.some((entry) => {
    const p = keyParts(entry.key);
    if (p === null) return false;
    if (p.section === "extensions" && p.subsection === null && p.variable === "submodulepathconfig") return parseMaybeBool(entry.value) === 1;
    return p.section === "submodule" && p.subsection !== null && p.variable === "gitdir";
  });
}

// Git `submodule.c` `parse_submodule_update_type`: the named modes. Every other value is a `!command` or an invalid value.
const UPDATE_MODES = new Set(["none", "checkout", "rebase", "merge"]);

// Contract §12 "Trust": the Git-written keys. None names a program.
const GIT_WRITTEN_CORE = new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "symlinks", "ignorecase", "precomposeunicode", "worktree"]);
function gitWritten(entry: ConfigEntry): boolean {
  const p = keyParts(entry.key);
  if (p === null) return false;
  if (p.section === "core" && p.subsection === null) return GIT_WRITTEN_CORE.has(p.variable);
  if (p.section === "extensions" && p.subsection === null) return p.variable === "objectformat" || p.variable === "refstorage";
  if (p.subsection === null) return false;
  if (p.section === "remote") return p.variable === "url" || p.variable === "fetch";
  if (p.section === "branch") return p.variable === "remote" || p.variable === "merge";
  if (p.section === "submodule") return p.variable === "url" || p.variable === "active" || (p.variable === "update" && !(entry.value ?? "").startsWith("!"));
  return false;
}

type Tree = NonNullable<ReturnType<typeof parseTree>>;

// `ls-tree -r -z`: `<mode> SP <type> SP <oid> TAB <path>` records.
// `limit`: the tree records more gitlinks than SUBMODULE_REVIEW_SUBMODULES. Its rows and its parent row pass the bound, so the parse keeps no gitlink.
function parseTree(bytes: Uint8Array, objectFormat: ObjectFormat): { gitlinks: { path: Uint8Array; oid: string }[]; gitmodules: boolean } | "limit" | null {
  if (bytes.length > 0 && bytes[bytes.length - 1] !== NUL) return null;
  const gitlinks: { path: Uint8Array; oid: string }[] = [];
  let gitmodules = false;
  for (const record of records(bytes)) {
    const tab = record.indexOf(TAB);
    if (tab < 0) return null;
    const m = /^([0-7]{6}) (blob|tree|commit) (\S+)$/.exec(latin1(record.subarray(0, tab)));
    const path = record.slice(tab + 1);
    if (m === null || !isObjectId(m[3]!, objectFormat) || path.length === 0) return null;
    if (m[1] === "160000" && m[2] === "commit") {
      if (gitlinks.length === SUBMODULE_REVIEW_SUBMODULES) return "limit";
      gitlinks.push({ path, oid: m[3]! });
    } else if (GITMODULES.equals(path) && m[2] === "blob") gitmodules = true;
  }
  return { gitlinks, gitmodules };
}

// The Git directory, the hooks folder, and the `config list` entries of one submodule Git directory.
type RepoConfig = Pick<Repo, "gitDir" | "hooks" | "entries">;
// The reads of one row before `commitRepo` applies them. `bytes`: the size of its `config list` output.
// `reached`: the result of the reach read of `plan`. Null: the row needs no reach read.
type Fetched = { repo: Repo; mark: SubmoduleBranch | null; bytes: number; reached: boolean | null };

// One submodule Git directory that the review reads.
export interface Repo {
  location: SubmoduleLocation;
  head: string | null;
  headRef: string | null;
  gitDir: string;
  hooks: string | null;
  entries: ConfigEntry[];
  // Null when HEAD has no commit.
  refHeld: boolean | null;
}

// One level of rows: the superproject, or an initialized or reused submodule.
interface Level {
  worktree: string;
  // `worktree` as `rev-parse --show-toplevel` prints it.
  gitWorktree: string;
  components: string[];
  prefix: Uint8Array;
  // The folder that holds the kept Git directories of this level.
  modules: string;
  config: readonly ConfigEntry[];
  // The `symbolic-ref -q HEAD` target of the parent when Git reads this level. Git's default remote follows the checked-out branch (contract §12 "Plan").
  headRef: string | null;
  depth: number;
  parentRowId: string | null;
  parentPath: string | null;
  // The active pathspec matches of the parent. Null: `submodule.active` is unset. Undefined: a nested review level computes no active set.
  active?: ReadonlySet<string> | null;
  // Feature 004 contract Δ12: the parent of this level holds the scope row below it, so the level reads only the rows on the way to that row.
  above: boolean;
}

// One plan row with its read facts. `worktree` and `parentWorktree` are `PathForms.root` paths for reads and remedies.
// `gitWorktree` and `parentGitWorktree` are the same folders in Git's `rev-parse --show-toplevel` form for step commands.
export interface ObservedRow {
  row: SubmodulePlanRow;
  // The row has no retained row ID (data-model §9 "Row result").
  found: boolean;
  worktree: string;
  gitWorktree: string;
  pathBytes: Uint8Array;
  // The path below its parent worktree, for the remedy commands.
  localPath: Uint8Array;
  parentWorktree: string;
  parentGitWorktree: string;
  // The path components below the superproject worktree. Null: Git cannot take the path literally.
  components: string[] | null;
  // `<parent Git directory>/modules/<name>` of a row without a `.git` entry.
  kept: string | null;
  repo: Repo | null;
  writes: boolean;
  unknownNested: boolean;
  // No ref or HEAD of the submodule reaches the target, so the row fetches before its checkout.
  fetches: boolean;
  // A `skip` row that gets the register step (contract §12 "Update protocol" step 5).
  register: boolean;
  // The `.gitmodules` URL after Git's `resolve_relative_url`, for the fallback remote. `url` null: `.gitmodules` names no URL. Null: Git dies on it.
  fallbackUrl: { url: string | null } | null;
  // Feature 004 contract Δ12: the scope row lies below this row. The scoped update reads its nested level and changes nothing in it.
  above: boolean;
}

// The program owner key of a row. A row ID is random, so the key holds the path bytes.
export const programOwner = (row: Pick<SubmodulePlanRow, "pathBytes">) => JSON.stringify(["row", row.pathBytes]);
// The program owner key of a kept Git directory without a row.
export const programDirOwner = (gitDir: string) => JSON.stringify(["dir", gitDir]);

// Contract §12 "Trust": Git applies these scopes in every submodule.
export const OUTER_SCOPES: ReadonlySet<string> = new Set(["system", "global", "command"]);

// One program list entry. `owner`, `identity`, and the program digest form the confirmed-entry match of contract §12 "Trust".
export interface ProgramEntry {
  program: SubmoduleProgram;
  owner: string;
  identity: unknown[];
}

// The rows, refusals, kept Git directories without a row, and program entries of one `top` or `level` read.
export interface Observed {
  rows: ObservedRow[];
  refusals: SubmoduleRefusal[];
  rowless: Repo[];
  programs: ProgramEntry[];
  // The configuration of the parent of these rows: the superproject listing for `top`, the parent submodule for `level`.
  config: readonly ConfigEntry[];
  // `level` only: the program re-check before the active-set read refused, so the read did not start.
  activeRefused: boolean;
  // The first refusal of each row, by row ID.
  byRow: ReadonlyMap<string, SubmoduleRefusal>;
  // The refusals that no row holds: a kept Git directory without a row, a parent setting, or the bound.
  unattached: SubmoduleRefusal[];
  // `top` only: the contract Δ12 host lines.
  hosts: SubmoduleHostLine[];
}

export interface SubmoduleReviewerOptions extends Pick<HistoryReaderOptions, "listingTuple"> {
  runner: GitRunner;
  trust: Trust;
  approvals: Approvals;
  environment: ServiceEnvironment;
  now?: () => number;
}

export function createSubmoduleReviewer({ runner, trust, approvals, environment, listingTuple, now = () => performance.now() }: SubmoduleReviewerOptions) {
  const retained = new Map<string, RetainedSubmoduleReview>();
  const prune = () => {
    for (const [token, r] of retained) if (now() - r.issuedAt > APPROVAL_LIFETIME_MS) retained.delete(token);
  };

  // Contract §3 `reviewSubmodules`: one observation, then the token.
  async function reviewSubmodules(t: SubmoduleReviewTarget): Promise<SubmoduleReviewOutcome> {
    const { snapshot: s, workspace: w } = t;
    if (s.indexFingerprint === null || s.policyFingerprint === null) {
      const c = s.completeness;
      return c.state === "limited" ? { result: "limited", code: c.code, value: { completeness: c } } : { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
    }
    const scope = t.scope === undefined ? null : new TextEncoder().encode(t.scope.path);
    // Feature 004 contract Δ12: the review takes the trust listing own or shared. The update preflight always runs its own listing.
    // Only the list review reads the branch marks ("Branch marks"). A scoped review reads one row at a time ("Parallel reads").
    const o = observe(t, undefined, scope, () => sharedListing({ trust, listingTuple }, t), scope === null, scope === null ? SUBMODULE_WORK_PARALLEL : 1);
    const read = await o.top({ head: s.head, indexEntries: s.indexEntries });
    if ("stop" in read) return { result: read.stop };
    if (!("value" in read)) return { result: "failed", code: read.code, ...(read.path === undefined ? {} : { value: { path: read.path } }) };
    // Contract Δ12: the scope names one row. A refusal on the way to it explains a missing row.
    if (scope !== null && read.value.refusals.length === 0 && !read.value.rows.some((p) => Buffer.from(p.pathBytes).equals(scope))) return { result: "failed", code: "UNKNOWN_TARGET" };
    const { binding, fingerprint, review, programs } = o.binding()!;
    const submoduleReviewToken = crypto.randomUUID();
    approvals.issue({ kind: "submodule", reviewToken: submoduleReviewToken, repositoryId: w.repositoryId, snapshotId: s.snapshotId, generation: s.generation, binding });
    prune();
    const value = {
      generation: s.generation,
      rows: read.value.rows.map((p) => p.row),
      programs: read.value.programs.map((e) => e.program),
      refusals: read.value.refusals,
      hosts: read.value.hosts,
      branches: read.value.rows.flatMap((p) => o.marks.get(p.row.rowId) ?? []),
      submoduleReviewToken,
    };
    retained.set(submoduleReviewToken, { repositoryId: w.repositoryId, issuedAt: now(), value, fingerprint, review, programs, scope });
    return { result: "succeeded", value };
  }

  // One run of the review reads. `rowIds` maps base64 path bytes to retained row IDs. A row without one gets a new ID and `found`.
  // `scope`: the UTF-8 path bytes of the contract Δ12 scope row, or null for every row.
  // `list`: the source of the superproject trust listing.
  // `readMarks`: the reads add the feature 004 contract Δ12 branch marks of the checked-out rows.
  // `lanes`: the most row reads that run at once (contract Δ12 "Parallel reads"). With one lane, each row reads in its turn.
  function observe(
    t: ObserveTarget,
    rowIds?: ReadonlyMap<string, string>,
    scope: Uint8Array | null = null,
    list: () => Promise<ListingOutcome> = () => trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: t.workspace }),
    readMarks = false,
    lanes = 1,
  ) {
    const { workspace: w, installation } = t;
    const objectFormat = w.objectFormat;
    const forms = pathForms(w, installation);

    // The values that the token binds besides the plan, in read order.
    const observed: unknown[] = [];
    const programInputs: unknown[] = [];
    // The branch marks by row ID. They stay out of `observed`, `programInputs`, and the binding.
    const marks = new Map<string, SubmoduleBranch>();
    let cachedListing: TrustListing | null = null;
    // Feature 004 contract Δ12 "Submodule bound": the `config list` bytes that `top` binds, across all rows, in row order (FR-112). Null outside `top`.
    let boundConfig: number | null = null;

    // Contract §3: trust gating follows the read rule of §7, before any Git process inside a submodule.
    const superTrust = async (): Promise<TrustListing> => {
      if (cachedListing === null) {
        const r = await list();
        if (!r.ok) throw "stop" in r ? walkStop(r.stop) : new Halt({ code: r.code });
        cachedListing = r.listing;
      }
      const gate = trust.gate(w, cachedListing, installation, "reads");
      if (gate !== null) throw failed(gate);
      return cachedListing;
    };

    // Contract Δ12 "Parallel reads": at most `lanes` read-ahead works run, in start order. Pass B and the nested loop of `readRows` apply them in row order.
    const running = new Set<Promise<unknown>>();
    const waiting: (() => void)[] = [];
    let stopping = false;
    const ahead = <T>(work: () => Promise<T>): (() => Promise<T>) => {
      if (lanes <= 1) return work;
      const result = new Promise<T>((resolve, reject) => {
        const begin = () => {
          const run = work();
          running.add(run);
          void run.then(resolve, reject).finally(() => {
            running.delete(run);
            waiting.shift()?.();
          });
        };
        if (running.size < lanes) begin();
        else waiting.push(begin);
      });
      // After a failure the review awaits no later work.
      result.catch(() => {});
      return () => result;
    };
    // No work starts after this, and every running work ends before the reply.
    const settle = async () => {
      waiting.length = 0;
      stopping = true;
      try {
        await Promise.allSettled([...running]);
      } finally {
        stopping = false;
      }
    };

    // Contract Δ12 "Job close": a recorded deadline stops the attempt. After it, no read starts and no read runs again.
    let deadline = false;
    let deadlineSeen = () => {};
    const recorded = new Promise<void>((resolve) => (deadlineSeen = resolve));
    const reading = new Set<Promise<unknown>>();
    const record = () => {
      deadline = true;
      deadlineSeen();
    };
    // 001 contract §5 "Deadline outcomes": a walk deadline has the outcome of a Git process deadline in the same step, so it records a deadline too.
    const walkStop = (stop: WalkStop["stop"]) => {
      if (stop === "deadline") record();
      return new Halt({ stop });
    };
    // No read starts after a recorded deadline, after the first failure, or after Cancel.
    const guard = () => {
      if (deadline) throw new Halt({ stop: "deadline" });
      if (stopping || t.signal.aborted) throw new Halt({ stop: "canceled" });
    };
    // A read that a Job close ended gets exit code null without `deadline` (contract §6 `exit`). It waits for the deadline exit, which can come later.
    const runOnce = async (args: string[], maxBytes: number, input?: Uint8Array) => {
      guard();
      const out = createCollector({ maxBytes });
      // The read records its deadline before it settles, so a read that waits for `reading` sees the deadline.
      const read = runRead(runner, t, args, out, input).then((step) => {
        if (!("refused" in step) && exitKind(step.exit, "read", out) === "deadline") record();
        return step;
      });
      reading.add(read);
      const step = await read.finally(() => reading.delete(read));
      if (t.signal.aborted) throw new Halt({ stop: "canceled" });
      if (!deadline && !("refused" in step) && exitKind(step.exit, "read", out) === "jobClosed") await Promise.race([recorded, Promise.allSettled([...reading])]);
      if (t.signal.aborted) throw new Halt({ stop: "canceled" });
      if (deadline) throw new Halt({ stop: "deadline" });
      return { step, out };
    };

    const git = async (args: string[], options: { max?: number; input?: Uint8Array } = {}) => {
      const { step, out } = await runOnce(args, options.max ?? DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, options.input);
      if ("refused" in step) throw failed(step.refused);
      if (step.exit.diagnosticLimit) throw failed("OUTPUT_LIMIT");
      return { code: step.exit.exitCode, out: out.take(), limited: out.limited };
    };

    const fileFacts = async (files: FactEntry[], digest: boolean) => {
      if (files.length === 0) return [];
      guard();
      const reply = await requestFacts(runner, t.operationId, w, digest, files, t.signal);
      if (t.signal.aborted) throw new Halt({ stop: "canceled" });
      if (!Array.isArray(reply)) throw "stop" in reply ? walkStop(reply.stop) : new Halt({ code: reply.code });
      if (reply.some((fact) => fact.kind === "error")) throw failed("REPOSITORY_UNAVAILABLE");
      return reply;
    };
    // A link before the last component means that no entry exists at the path. The walk never follows a link.
    const entryExists = (fact: FileFact, path: readonly string[]) => fact.kind !== "absent" && (fact.kind !== "link" || fact.component === path.length);
    const facts = async (files: FactEntry[]) => (await fileFacts(files, false)).map((fact, i) => entryExists(fact, files[i]!.path));

    // Contract §12 "Update protocol", read failures: a failed review read ends the review with GIT_FAILED.
    const readGitmodules = async (args: string[]): Promise<Gitmodules | "limit"> => {
      const r = await git(args, { max: SUBMODULE_GITMODULES_BYTES });
      if (r.limited) return "limit";
      if (r.code !== 0) throw failed("GIT_FAILED");
      const parsed = parseGitmodules(r.out);
      if (parsed === null) throw failed("MALFORMED_GIT_OUTPUT");
      observed.push({ gitmodules: sha256(Buffer.from(r.out).toString("base64")) });
      return parsed;
    };

    // `bytes`: the size of the `config list` output.
    const readConfig = async (location: SubmoduleLocation): Promise<RepoConfig & { bytes: number }> => {
      // Contract Δ12 "Review reads": the first line is the Git directory, the second line the hooks path.
      const paths = await git(submoduleGitPathsArgs(location));
      const lf = paths.out.indexOf(NEWLINE);
      const gitDir = paths.code === 0 && lf >= 0 ? oneLine(paths.out.subarray(0, lf + 1)) : null;
      const hooksText = gitDir === null ? null : oneLine(paths.out.subarray(lf + 1));
      if (gitDir === null || hooksText === null) throw failed("GIT_FAILED");
      // Git prints the hooks path relative to the folder where it ran: the `-C` folder, or the worktree root for a kept Git directory.
      const hooks = forms.resolve("worktree" in location ? location.worktree : forms.gitRoot, hooksText);
      const config = await git(submoduleConfigListArgs(location), { max: TRUST_INPUT_BYTES });
      if (config.limited) throw failed("OUTPUT_LIMIT");
      if (config.code !== 0) throw failed("GIT_FAILED");
      const entries = parseConfigListing(config.out, false);
      if (entries === null) throw failed("MALFORMED_GIT_OUTPUT");
      return { gitDir, hooks, entries, bytes: config.out.length };
    };

    // `rev-parse --verify -q HEAD`. After a nonzero exit, HEAD names no commit only when `show-ref --exists` exits 2, or when the HEAD target fails the ref-name rules.
    const readHead = async (location: SubmoduleLocation): Promise<Pick<Repo, "head" | "headRef">> => {
      const headRead = await git(submoduleHeadOidArgs(location));
      const symbolic = await git(submoduleHeadTargetArgs(location));
      let headRef: string | null = null;
      if (symbolic.code === 0) {
        headRef = oneLine(symbolic.out);
        if (headRef === null || !isOneLevelRefName(headRef)) throw failed("MALFORMED_GIT_OUTPUT");
      } else if (symbolic.code !== 1 && (symbolic.code !== 128 || headRead.code === 0)) throw failed("GIT_FAILED");
      if (headRead.code === 0) {
        const head = oneLine(headRead.out);
        if (head === null || !isObjectId(head, objectFormat)) throw failed("GIT_FAILED");
        return { head, headRef };
      }
      if (symbolic.code === 128) {
        const target = await git(submoduleHeadTargetNoRecurseArgs(location));
        const name = target.code === 0 ? oneLine(target.out) : null;
        if (name === null) throw failed(target.code === 0 ? "MALFORMED_GIT_OUTPUT" : "GIT_FAILED");
        const format = await git(submoduleRefFormatArgs(location, name));
        if (format.code !== 1) throw failed("GIT_FAILED");
        return { head: null, headRef: null };
      }
      if (headRef === null) throw failed("GIT_FAILED");
      const exists = await git(submoduleRefExistsArgs(location, headRef));
      if (exists.code !== 2) throw failed("GIT_FAILED");
      return { head: null, headRef };
    };

    // Feature 004 contract Δ12 "Branch marks". A failed read gives `unread`. Only an abort, a deadline ("Job close"), and the operation stderr bound end the review.
    // `held`: git-for-each-ref(1) gives the HEAD ref at the HEAD commit, so that ref contains HEAD.
    const markOf = async (location: { worktree: string }, rowId: string, headRef: string | null, head: string): Promise<{ mark: SubmoduleBranch; held: boolean }> => {
      const done = (mark: SubmoduleBranch, held = false) => ({ mark, held });
      if (headRef === null) return done({ rowId, state: "detached" });
      // Research.md R31: Git gives a HEAD outside `refs/heads/` no upstream.
      if (!headRef.startsWith("refs/heads/")) return done({ rowId, state: "branch", ref: headRef, upstream: null, track: { state: "none" } });
      const unread = (code: ErrorCode): SubmoduleBranch => ({ rowId, state: "unread", ref: headRef, code });
      const { step, out } = await runOnce(submoduleTrackingArgs(location, headRef), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
      if ("refused" in step) return done(unread(step.refused));
      if (step.exit.diagnosticLimit) return done(unread("OUTPUT_LIMIT"));
      if (out.limited) return done(unread("OUTPUT_LIMIT"));
      if (step.exit.exitCode !== 0) return done(unread("GIT_FAILED"));
      const entries = parseTracking(out.take(), objectFormat);
      if (entries === null) return done(unread("MALFORMED_GIT_OUTPUT"));
      // `%(HEAD)` marks the record of the current HEAD. Without it, HEAD moved after the `symbolic-ref` read.
      const entry = entries.find((e) => e.current && !e.invalidUtf8 && `refs/heads/${e.name}` === headRef);
      if (entry === undefined) return done(unread("STATE_UNKNOWN"));
      return done({ rowId, state: "branch", ref: headRef, upstream: entry.upstream, track: entry.track }, entry.objectId === head);
    };

    // `markRow`: the row ID of a checked-out row whose branch mark this read adds (contract Δ12 "Branch marks").
    // `reach`: the target of the reach read of `plan` (contract Δ12 "Update reads"). The read runs when HEAD is another commit.
    // `fetchRepo` only reads, so it can run ahead of its row. `commitRepo` applies its result in row order.
    const fetchRepo = async (location: SubmoduleLocation, markRow: string | null = null, reach: string | null = null): Promise<Fetched> => {
      const { head, headRef } = await readHead(location);
      const { gitDir, hooks, entries, bytes } = await readConfig(location);
      let refHeld: boolean | null = null;
      let mark: SubmoduleBranch | null = null;
      if (head !== null) {
        const marking = readMarks && markRow !== null && "worktree" in location;
        const marked = marking ? await markOf(location, markRow, headRef, head) : null;
        mark = marked?.mark ?? null;
        if (marked?.held === true) refHeld = true;
        else {
          // The stderr bound counts per operation, so after a bound on the mark read this read fails the review.
          const held = await git(submoduleHeadRefArgs(location));
          if (held.code !== 0) throw failed("GIT_FAILED");
          refHeld = held.out.length > 0;
        }
      }
      const reached = reach !== null && head !== null && head !== reach ? await reaches(location, reach) : null;
      return { repo: { location, head, headRef, gitDir, hooks, entries, refHeld }, mark, bytes, reached };
    };
    const commitRepo = ({ repo, mark, bytes }: Fetched): Repo => {
      if (boundConfig !== null && (boundConfig += bytes) > REVIEW_CONFIG_BYTES) throw failed("OUTPUT_LIMIT");
      if (mark !== null) marks.set(mark.rowId, mark);
      observed.push({ repo: { ...repo, entries: repo.entries.map((e) => Buffer.from(e.keyValueBytes).toString("base64")) } });
      return repo;
    };
    const readRepo = async (location: SubmoduleLocation, markRow: string | null = null): Promise<Repo> => commitRepo(await fetchRepo(location, markRow));

    // Git `is_tip_reachable`: exit 0 without output means that a ref or HEAD reaches the target. Anything else means none does.
    // `plan` pushes the observed value, so the read can run ahead of its row.
    const reaches = async (location: SubmoduleLocation, target: string) => {
      const r = await git(submoduleReachArgs(location, target, objectFormat));
      return r.code === 0 && r.out.length === 0;
    };

    // `cat-file --batch-check`: `<oid> missing` for an absent object, `<oid> <type> <size>` otherwise.
    const present = async (location: SubmoduleLocation, oid: string) => {
      const r = await git(submoduleObjectCheckArgs(location), { input: new TextEncoder().encode(`${oid}\n`) });
      if (r.code !== 0) throw failed("GIT_FAILED");
      const line = oneLine(r.out);
      if (line === `${oid} missing`) return false;
      if (line !== null && new RegExp(`^${oid} commit [0-9]+$`).test(line)) return true;
      // Another object type at the recorded ID cannot be checked out.
      if (line !== null && new RegExp(`^${oid} (?:blob|tree|tag) [0-9]+$`).test(line)) return false;
      throw failed("MALFORMED_GIT_OUTPUT");
    };

    // The UNC form of a folder for metadata only. A folder without one fails its read.
    const nativeOf = (folder: string): string => {
      const at = forms.native(folder);
      if (at === null) throw failed("REPOSITORY_UNAVAILABLE", folder);
      return at;
    };
    // Contract §12 "Review reads": the folder check reads entry types and names only.
    const folderEmpty = async (folder: string): Promise<boolean> => {
      const at = nativeOf(folder);
      let stat;
      try {
        stat = await lstat(at);
      } catch (error) {
        if (isMissing(error)) return true;
        throw failed("REPOSITORY_UNAVAILABLE", at);
      }
      if (!stat.isDirectory()) return false;
      try {
        return (await readdir(at)).length === 0;
      } catch {
        throw failed("REPOSITORY_UNAVAILABLE", at);
      }
    };
    // Git `clone_submodule` tests `<parent Git directory>/modules/<name>` with `file_exists`.
    const keptExists = async (path: string): Promise<boolean> => {
      const at = nativeOf(path);
      try {
        await lstat(at);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw failed("REPOSITORY_UNAVAILABLE", at);
      }
    };

    const gitPath = forms.gitPath;
    const wsl = forms.wsl;
    // The worktree root in the form of the remedy commands, and in the native form of a refusal path.
    const root = forms.root;
    const rootPath = resolve(w.worktreeRoot);
    // A folder below the worktree root in Git's form. `gitRoot` is the `rev-parse --show-toplevel` text, which ends with `/` only at a file system root.
    const gitForm = (components: readonly string[]) => (forms.gitRoot.endsWith("/") ? forms.gitRoot : `${forms.gitRoot}/`) + components.join("/");
    // `rows` and `refusals` hold every `top` and `level` read of this observation.
    const rows: ObservedRow[] = [];
    const refusals: { refusal: SubmoduleRefusal; late: boolean; rowId: string | null }[] = [];
    const ordered = (from: number) => {
      const list = refusals.slice(from);
      return [...list.filter((r) => !r.late), ...list.filter((r) => r.late)].map((r) => r.refusal);
    };
    const attachment = (from: number): Pick<Observed, "byRow" | "unattached"> => {
      const byRow = new Map<string, SubmoduleRefusal>();
      const unattached: SubmoduleRefusal[] = [];
      for (const r of refusals.slice(from)) {
        if (r.rowId === null) unattached.push(r.refusal);
        else if (!byRow.has(r.rowId)) byRow.set(r.rowId, r.refusal);
      }
      return { byRow, unattached };
    };
    let limited = false;
    // Pass A of `readRows` keeps the refusals of a row here. Pass B adds them in row order.
    let deferred: typeof refusals | null = null;
    const refuse = (reason: SubmoduleRefusalReason, path: string, text: string, remedy: SubmoduleRefusal["remedy"], row?: SubmodulePlanRow) => {
      (deferred ?? refusals).push({ refusal: { code: "UNSUPPORTED_SUBMODULE", reason, path, text, remedy }, late: reason === "update-mode" || reason === "gitdir-config" || reason === "limit", rowId: row?.rowId ?? null });
      if (row !== undefined && row.refusal === null) row.refusal = reason;
    };
    const refuseLimit = () => {
      if (limited) return;
      limited = true;
      const remedy = gitPath === null ? null : buildRefusalRemedy({ reason: "limit", gitPath, parentWorktree: root, wsl });
      refuse("limit", rootPath, REFUSAL_TEXTS.limit, remedy);
    };
    const refuseGitdir = (path: string, parentWorktree: string, localPath?: Uint8Array, nested = false) => {
      const remedy = gitPath === null ? null : buildRefusalRemedy({ reason: "gitdir-config", gitPath, parentWorktree, nested, wsl, ...(localPath === undefined ? {} : { path: localPath }) });
      refuse("gitdir-config", path, REFUSAL_TEXTS.gitdirConfig, remedy);
    };
    const refuseUnsaved = (path: string, repo: Repo, target: string | null, row?: SubmodulePlanRow) => {
      if (repo.head === null || repo.refHeld !== false || repo.head === target) return;
      const location = "worktree" in repo.location ? { submoduleWorktree: repo.location.worktree } : { gitDirectory: repo.location.gitDir };
      const remedy = gitPath === null ? null : buildRefusalRemedy({ reason: "unsaved-commits", source: "review", gitPath, commit: repo.head, wsl, ...location });
      refuse("unsaved-commits", path, REFUSAL_TEXTS.unsavedCommits(path, repo.head), remedy, row);
    };
    // Each row and each counted folder of the kept-directory walk count toward the §5 bound once (contract Δ12 "Submodule count"). A level read sees plan rows again.
    const counted = new Set<string>();
    const count = (key: string) => {
      if (!counted.has(key)) {
        counted.add(key);
        if (counted.size > SUBMODULE_REVIEW_SUBMODULES) refuseLimit();
      }
      return !limited;
    };

    // Contract §12 "Review reads": the top-level checked-out commits from `diff-files -p`, with C-quote unquoting of `+++ b/<path>`.
    const headsOf = async (paths: Uint8Array[]): Promise<Map<string, string>> => {
      const heads = new Map<string, string>();
      const wanted = new Set(paths.map(latin1));
      const texts = paths.map((p) => utf8.decode(p));
      const units = (args: string[]) => stepUnits({ operationId: t.operationId, workspace: w, installation }, "read", args);
      for (const batch of gitlinkBatches(texts, units)) {
        const r = await git(gitlinkPatchArgs(batch), { max: STATUS_LISTING_BYTES });
        if (r.limited) throw failed("OUTPUT_LIMIT");
        if (r.code !== 0) throw failed("GIT_FAILED");
        let current: string | null = null;
        let at = 0;
        while (at < r.out.length) {
          const lf = r.out.indexOf(NEWLINE, at);
          const line = r.out.subarray(at, lf < 0 ? r.out.length : lf);
          at = lf < 0 ? r.out.length : lf + 1;
          const text = latin1(line);
          if (text.startsWith("+++ ")) {
            const rest = line.subarray(4);
            const name = rest[0] === 0x22 ? unquote(rest, 0) : { value: rest, end: rest.length };
            if (name === null || name.end !== rest.length || latin1(name.value.subarray(0, 2)) !== "b/") throw failed("MALFORMED_GIT_OUTPUT");
            current = latin1(name.value.subarray(2));
            if (!wanted.has(current)) throw failed("MALFORMED_GIT_OUTPUT");
          } else if (text.startsWith("+Subproject commit ") && current !== null) {
            const oid = text.slice("+Subproject commit ".length);
            if (!isObjectId(oid, objectFormat)) throw failed("MALFORMED_GIT_OUTPUT");
            heads.set(current, oid);
          }
        }
      }
      return heads;
    };

    // ---- Rows ----

    const writing: ReadonlySet<SubmoduleAction> = new Set(["clone", "reuse", "checkout", "fetch-checkout"]);
    const pathOf = (lv: Level, path: Uint8Array): Uint8Array => (lv.depth === 0 ? path : Buffer.concat([lv.prefix, Buffer.from("/"), path]));
    // True for the scope row and for each row that holds it below. Path bytes compare exactly.
    const onWay = (bytes: Uint8Array) => {
      const s = scope!;
      if (bytes.length >= s.length) return Buffer.from(bytes).equals(s);
      return s[bytes.length] === 0x2f && Buffer.from(s.subarray(0, bytes.length)).equals(bytes);
    };

    // `recurse`: the review reads every nested level. The update reads one level at a time (contract §12 "Update protocol" step 6).
    async function readRows(lv: Level, all: { path: Uint8Array; oid: string | null }[], modules: Gitmodules, recurse: boolean): Promise<void> {
      // Contract Δ12: a level above the scope row reads only the row on the way to it.
      const links = lv.above ? all.filter((link) => onWay(pathOf(lv, link.path))) : all;
      recordUrls(lv, links, modules);
      if (lv.depth >= SUBMODULE_REVIEW_NESTING_LEVELS) {
        if (links.length > 0) refuseLimit();
        return;
      }
      const parentSetsActive = lv.active === undefined && lv.config.some((e) => e.key === "submodule.active");
      const entries = links.map((link) => {
        const local = componentsOf(link.path);
        return { link, local, components: local === null ? null : [...lv.components, ...local] };
      });
      const dotGit = await facts(entries.filter((e) => e.components !== null).map((e) => ({ root: "worktreeRoot" as const, path: [...e.components!, ".git"] })));
      let next = 0;
      const initialized = entries.map((e) => (e.components === null ? false : dotGit[next++]!));
      const topHeads = lv.depth === 0 ? await headsOf(entries.filter((e, i) => initialized[i] && e.components !== null).map((e) => e.link.path)) : null;
      // Contract Δ12 "Submodule bound": a read keeps its result until this level applies it, so at most `lanes` reads of one window run ahead of the apply.
      // The level takes the reads of a window in the order of their start, so each read that it takes has started.
      const windowed = () => {
        const later: (() => void)[] = [];
        let open = 0;
        return <T>(work: () => Promise<T>): (() => Promise<T>) => {
          let read: (() => Promise<T>) | null = null;
          const start = () => {
            open++;
            read = ahead(work);
          };
          if (open < lanes) start();
          else later.push(start);
          return () => {
            open--;
            later.shift()?.();
            return read!();
          };
        };
      };
      // Pass B applies the row reads. The depth-first loop below applies the nested reads, whose `ls-tree` output can reach STATUS_LISTING_BYTES each.
      const rowRead = windowed();
      const nestedAhead = windowed();
      const nested: { pending: ObservedRow; repo: Repo; read: (() => ReturnType<typeof nestedRead>) | null }[] = [];
      // The nested reads of a row start when the row has its action (contract Δ12 "Parallel reads").
      const nest = (pending: ObservedRow, repo: Repo) => {
        nested.push({ pending, repo, read: pending.row.action === "skip" ? null : nestedAhead(() => nestedRead(pending, repo, recurse)) });
      };

      // Pass A, in row order: the checks of each row that await nothing. A checked-out row starts its reads here.
      // The other reads of a row wait in its tail, and its refusals wait in its step.
      const steps: { key: string; refusals: typeof refusals; tail: (() => Promise<void>) | null }[] = [];
      const fresh = new Set<string>();
      try {
        for (const [i, { link, components }] of entries.entries()) {
          const pathBytes = pathOf(lv, link.path);
          const key = Buffer.from(pathBytes).toString("base64");
          const step: (typeof steps)[number] = { key: `row ${key}`, refusals: [], tail: null };
          steps.push(step);
          // The §5 bound of pass B, without `count`: no read starts for a nested row past the bound.
          if (!counted.has(step.key)) fresh.add(step.key);
          if (lv.depth > 0 && (limited || counted.size + fresh.size > SUBMODULE_REVIEW_SUBMODULES)) break;
          deferred = step.refusals;
          const display = displayPath(pathBytes);
          // Contract Δ12: the update reads the nested level of a row above the scope row, so that row needs its `.git` entry.
          const above = lv.above && !Buffer.from(pathBytes).equals(scope!);
          if (above && components !== null && !initialized[i]) {
            const path = displayPath(scope!);
            refuse("parent-not-initialized", path, REFUSAL_TEXTS.parentNotInitialized(display, path), null);
            continue;
          }
          const name = modules.nameOf.get(latin1(link.path)) ?? null;
          const module = name === null ? undefined : modules.byName.get(name);
          const nameText = name === null ? null : (() => {
            try {
              return utf8.decode(Buffer.from(name, "latin1"));
            } catch {
              return null;
            }
          })();
          const configUrl = nameText === null ? undefined : lastValue(lv.config, submoduleKey(nameText, "url"));
          const gitmodulesUrl = module?.url === undefined ? null : utf8.decode(Buffer.from(module.url, "latin1"));
          const url = configUrl?.value ?? gitmodulesUrl;
          let fallbackUrl: ObservedRow["fallbackUrl"] = { url: null };
          if (gitmodulesUrl !== null) {
            try {
              fallbackUrl = { url: resolveGitmodulesUrl(gitmodulesUrl, { listing: lv.config, headRef: lv.headRef }, lv.gitWorktree, forms.platform) };
            } catch (error) {
              if (!(error instanceof SubmoduleUrlError)) throw error;
              fallbackUrl = null;
            }
          }
          const retainedId = rowIds?.get(key);
          const row: SubmodulePlanRow = {
            rowId: retainedId ?? crypto.randomUUID(),
            pathBytes: key,
            path: display,
            name: nameText ?? "",
            depth: lv.depth,
            parentRowId: lv.parentRowId,
            url: url === null ? null : redactUrlUserInfo(url),
            head: null,
            target: link.oid,
            remotes: [],
            action: "clone",
            notes: [],
            refusal: null,
          };
          const worktree = components === null ? lv.worktree : forms.join(root, ...components);
          const gitWorktree = components === null ? lv.gitWorktree : gitForm(components);
          const pending: ObservedRow = {
            row,
            found: rowIds !== undefined && retainedId === undefined,
            worktree,
            gitWorktree,
            pathBytes,
            localPath: link.path,
            parentWorktree: lv.worktree,
            parentGitWorktree: lv.gitWorktree,
            components,
            kept: null,
            repo: null,
            writes: false,
            unknownNested: false,
            fetches: false,
            register: false,
            fallbackUrl,
            above,
          };
          rows.push(pending);
          if (components === null || nameText === null && name !== null) {
            refuse("path", display, REFUSAL_TEXTS.path(display), null, row);
            continue;
          }
          // Contract §11 "Paths and file access": the folder reads need an exact UNC form of the worktree and of the kept Git directory.
          if (forms.native(worktree) === null || (nameText !== null && forms.native(forms.join(lv.modules, ...nameText.split("/"))) === null)) {
            refuse("path", display, REFUSAL_TEXTS.uncPath(display), null, row);
            continue;
          }
          // Contract Δ12: the refusals and steps of this row do not apply. A HEAD without a commit gives no nested level.
          if (above) {
            step.tail = async () => {
              const repo = await readRepo({ worktree });
              pending.repo = repo;
              if (repo.head === null) {
                refuse("clone-interrupted", display, REFUSAL_TEXTS.cloneInterrupted(display), null, row);
                return;
              }
              row.head = topHeads?.get(latin1(link.path)) ?? (lv.depth === 0 ? link.oid : repo.head);
              row.action = "none";
              nest(pending, repo);
            };
            continue;
          }
          if (nameText === null || url === null) {
            refuse("no-url", display, REFUSAL_TEXTS.noUrl(display), null, row);
            continue;
          }
          if (lv.parentPath !== null && parentSetsActive) row.notes.push(NOTES.nestedActive(lv.parentPath));

          const updateRemedy = () => (gitPath === null ? null : buildRefusalRemedy({ reason: "update-mode", gitPath, parentWorktree: lv.worktree, path: link.path, nested: lv.depth > 0, wsl }));
          let modeRefused = false;
          const refuseMode = (value: string) => {
            modeRefused = true;
            refuse("update-mode", display, REFUSAL_TEXTS.updateMode(display, value), updateRemedy(), row);
          };
          // Git `submodule-config.c` `parse_config` dies on a `.gitmodules` `!command` or unknown update value, whatever the effective value or the active set.
          if (module?.update !== undefined && !UPDATE_MODES.has(module.update)) refuseMode(module.update);

          // Contract §12 "Plan", active set (Git `is_submodule_active`). A value that is no boolean makes Git exit 128.
          const explicit = lastValue(lv.config, submoduleKey(nameText, "active"));
          const explicitValue = explicit === undefined ? undefined : parseMaybeBool(explicit.value);
          if (explicitValue === -1) {
            refuse("active-value", display, REFUSAL_TEXTS.activeValue(display, nameText), null, row);
            continue;
          }
          let isActive = true;
          if (lv.active !== undefined && lv.active !== null) isActive = explicitValue !== undefined ? explicitValue === 1 : lv.active.has(latin1(link.path));
          if (lv.active === null && explicitValue === 0) row.notes.push(NOTES.activates);
          if (!isActive) {
            row.action = "skip";
            step.tail = async () => {
              // Reconciliation compares the HEAD of a skipped checked-out row with this commit.
              if (initialized[i]) row.head = topHeads === null ? (await readHead({ worktree })).head : (topHeads.get(latin1(link.path)) ?? link.oid);
              // Contract Δ12: Git's `--init` with this path would activate the row and write its settings, so the scoped update refuses it.
              if (scope !== null && Buffer.from(pathBytes).equals(scope)) {
                const remedy = gitPath === null ? null : buildSubmoduleRemedy({ step: "register", gitPath, parentWorktree: lv.worktree, path: link.path, nested: lv.depth > 0, wsl });
                refuse("inactive", display, REFUSAL_TEXTS.inactive(display), remedy, row);
              }
            };
            continue;
          }

          const modeEntry = lastValue(lv.config, submoduleKey(nameText, "update"));
          const mode = modeEntry?.value ?? module?.update ?? "checkout";
          // An effective `!command` or invalid value refuses every row kind, a clone included (probe of 2026-10-09: exit 128).
          if (!modeRefused && !UPDATE_MODES.has(mode)) refuseMode(mode);
          const registered = configUrl !== undefined;
          if (!registered) {
            if (lv.parentPath === null || !parentSetsActive) row.notes.push(NOTES.registers);
            if (/^\.\.?[\\/]/.test(url)) row.notes.push(NOTES.relative);
          }

          if (!initialized[i]) {
            const kept = forms.join(lv.modules, ...nameText.split("/"));
            pending.kept = kept;
            if (mode === "none") {
              row.action = "skip";
              pending.register = !registered;
              continue;
            }
            step.tail = async () => {
              if (!(await keptExists(kept))) {
                row.action = "clone";
                pending.writes = true;
                pending.unknownNested = true;
                observed.push({ clone: display });
                return;
              }
              row.action = "reuse";
              pending.writes = true;
              const empty = await folderEmpty(worktree);
              observed.push({ folder: display, empty });
              if (!empty) refuse("folder-not-empty", display, REFUSAL_TEXTS.folderNotEmpty(display), null, row);
              if (!modeRefused && mode !== "checkout") refuseMode(mode);
              const repo = await readRepo({ gitDir: kept });
              pending.repo = repo;
              row.head = repo.head;
              if (repo.head === null) {
                pending.unknownNested = true;
                return;
              }
              refuseUnsaved(display, repo, link.oid, row);
              await plan(pending, repo, link.oid);
              nest(pending, repo);
            };
            continue;
          }

          // Contract Δ12 "Update reads": the reach read of `plan` starts with the other reads of the row. The condition is the entry condition of `plan` in the tail.
          const reach = mode === "none" || (lv.depth === 0 && (topHeads?.get(latin1(link.path)) ?? link.oid) === link.oid) ? null : link.oid;
          const fetched = rowRead(() => fetchRepo({ worktree }, row.rowId, reach));
          step.tail = async () => {
            const read = await fetched();
            const repo = commitRepo(read);
            pending.repo = repo;
            if (repo.head === null) {
              refuse("clone-interrupted", display, REFUSAL_TEXTS.cloneInterrupted(display), null, row);
              return;
            }
            row.head = topHeads?.get(latin1(link.path)) ?? (lv.depth === 0 ? link.oid : repo.head);
            refuseUnsaved(display, repo, link.oid, row);
            if (mode === "none") {
              row.action = "skip";
            } else {
              if (!modeRefused && mode !== "checkout") refuseMode(mode);
              if (row.head === link.oid) row.action = "none";
              else await plan(pending, repo, link.oid, read.reached);
              pending.writes = writing.has(row.action);
            }
            nest(pending, repo);
          };
        }
      } finally {
        deferred = null;
      }

      // Pass B, in row order: the §5 bound, the refusals of the row, then its tail.
      for (const step of steps) {
        // The index bounds the top-level rows, so each of them gets its refusals. Nested levels stop at the bound.
        if (!count(step.key) && lv.depth > 0) return;
        refusals.push(...step.refusals);
        await step.tail?.();
      }

      // Depth first, as Git's own update visits the rows (probe S19).
      for (const { pending, repo, read } of nested) {
        if (setsGitdir(repo.entries)) refuseGitdir(pending.row.path, pending.parentWorktree, pending.localPath, pending.row.depth > 0);
        if (read === null) continue;
        const { local, listed } = await read();
        if (!local && !pending.above) pending.unknownNested = true;
        if (listed === null) continue;
        const tree = await treeOf(repo.location, listed.commit, undefined, listed.tree);
        if (tree === null || tree.gitlinks.length === 0) continue;
        // Git's checkout update mode detaches HEAD (git-submodule(1) `update`), so only a `none` row keeps its branch.
        await readRows(
          childLevel(pending, { ...repo, headRef: pending.row.action === "none" ? repo.headRef : null }, undefined),
          tree.gitlinks.map((g) => ({ path: g.path, oid: local || pending.above ? g.oid : null })),
          tree.modules,
          true,
        );
      }
    }

    const childLevel = (parent: ObservedRow, repo: RepoConfig & Pick<Repo, "headRef">, active: ReadonlySet<string> | null | undefined): Level => ({
      worktree: parent.worktree,
      gitWorktree: parent.gitWorktree,
      components: componentsOf(parent.pathBytes)!,
      prefix: parent.pathBytes,
      modules: forms.join(repo.gitDir, "modules"),
      config: repo.entries,
      headRef: repo.headRef,
      depth: parent.row.depth + 1,
      parentRowId: parent.row.rowId,
      parentPath: parent.row.path,
      ...(active === undefined ? {} : { active }),
      above: parent.above,
    });

    // The `ls-tree` of a submodule commit. It pushes no observed value, so it can run ahead of its row.
    const listTree = async (location: SubmoduleLocation, commit: string): Promise<Tree> => {
      const tree = await git(submoduleTreeArgs(location, commit, objectFormat), { max: STATUS_LISTING_BYTES });
      if (tree.limited) throw failed("OUTPUT_LIMIT");
      if (tree.code !== 0) throw failed("GIT_FAILED");
      const parsed = parseTree(tree.out, objectFormat);
      if (parsed === null) throw failed("MALFORMED_GIT_OUTPUT");
      return parsed;
    };
    // The nested reads of one row: the target check, then the tree of the commit that holds its nested rows.
    const nestedRead = async (pending: ObservedRow, repo: Repo, recurse: boolean) => {
      const target = pending.row.target;
      // Contract Δ12: the scoped update keeps the HEAD of a row above the scope row, so its nested rows come from that HEAD.
      const local = !pending.above && target !== null && (await present(repo.location, target));
      const commit = local ? target : repo.head;
      return { local, listed: !recurse || commit === null ? null : { commit, tree: await listTree(repo.location, commit) } };
    };

    // The gitlinks and the `.gitmodules` of a submodule commit. Null: the `.gitmodules` listing passed its bound.
    // `onLinks` gets the gitlinks before the `.gitmodules` read. `listed`: the `listTree` result of a read ahead.
    const treeOf = async (
      location: SubmoduleLocation,
      commit: string,
      onLinks?: (gitlinks: { path: Uint8Array; oid: string }[]) => void,
      listed?: Tree,
    ): Promise<{ gitlinks: { path: Uint8Array; oid: string }[]; modules: Gitmodules } | null> => {
      const parsed = listed ?? (await listTree(location, commit));
      // The level applies the refusal in row order, as the count would.
      if (parsed === "limit") {
        observed.push({ tree: commit, limit: true });
        refuseLimit();
        return null;
      }
      onLinks?.(parsed.gitlinks);
      observed.push({ tree: commit, gitlinks: parsed.gitlinks.map((g) => [Buffer.from(g.path).toString("base64"), g.oid]) });
      if (parsed.gitlinks.length === 0 || !parsed.gitmodules) return { gitlinks: parsed.gitlinks, modules: emptyModules() };
      const read = await readGitmodules(submoduleGitmodulesBlobArgs(location, commit, objectFormat));
      if (read === "limit") {
        refuseLimit();
        return null;
      }
      return { gitlinks: parsed.gitlinks, modules: read };
    };

    // Contract §12 "Plan": the action of a row with a HEAD commit, its notes, and the remotes of a fetching row.
    // `known`: the reach read of the read-ahead. Null: `plan` runs the reach read.
    async function plan(pending: ObservedRow, repo: Repo, target: string | null, known: boolean | null = null): Promise<void> {
      const { row } = pending;
      if (repo.head === null) return;
      if (target !== null && repo.head === target) {
        if (row.action !== "reuse") row.action = "none";
        return;
      }
      const reached = target !== null && (known ?? (await reaches(repo.location, target)));
      if (target !== null) observed.push({ reach: target, reached });
      if (row.action !== "reuse") row.action = reached ? "checkout" : "fetch-checkout";
      if (repo.headRef?.startsWith("refs/heads/")) row.notes.push(NOTES.detaches(repo.headRef.slice("refs/heads/".length)));
      if (target !== null) row.notes.push(NOTES.moves(repo.head, target));
      if (reached) return;
      pending.fetches = true;
      row.notes.push(NOTES.fetches);
      let defaultName: string | null;
      try {
        defaultName = defaultRemote({ listing: repo.entries, headRef: repo.headRef });
      } catch (error) {
        // Git dies on such a configuration, so it chooses no default remote.
        if (!(error instanceof SubmoduleUrlError)) throw error;
        defaultName = null;
      }
      const remotes: { name: string; url: string }[] = [];
      for (const entry of repo.entries) {
        const p = keyParts(entry.key);
        if (p === null || p.section !== "remote" || p.subsection === null || p.variable !== "url" || entry.value === null) continue;
        remotes.push({ name: p.subsection, url: entry.value });
      }
      let marked = false;
      row.remotes = remotes.map((r) => {
        const isDefault = !marked && r.name === defaultName;
        marked ||= isDefault;
        return { name: r.name, url: redactUrlUserInfo(r.url), default: isDefault };
      });
      if (remotes.length === 0) row.notes.push(NOTES.noRemote);
      else {
        const parentUrl = rawUrl(pending);
        if (parentUrl === null || !remotes.some((r) => r.url === parentUrl)) row.notes.push(NOTES.remotesDiffer);
      }
      for (const name of new Set(remotes.map((r) => r.name))) if (name.startsWith("-")) refuse("remote-name", row.path, REFUSAL_TEXTS.remoteName(row.path, name), null, row);
    }

    // The unredacted parent URL of a row. A relative `.gitmodules` URL resolves as Git's `resolve_relative_url` does. Null: Git cannot resolve it.
    function rawUrl(pending: ObservedRow): string | null {
      return urlsByPath.get(`${pending.parentWorktree}\0${latin1(pending.localPath)}`) ?? null;
    }

    // Records the raw URL of each gitlink of a level before `plan` reads it.
    const recordUrls = (lv: Level, links: { path: Uint8Array }[], modules: Gitmodules) => {
      for (const link of links) {
        const name = modules.nameOf.get(latin1(link.path));
        if (name === undefined) continue;
        let nameText: string;
        try {
          nameText = utf8.decode(Buffer.from(name, "latin1"));
        } catch {
          continue;
        }
        const configured = lastValue(lv.config, submoduleKey(nameText, "url"))?.value;
        const written = modules.byName.get(name)?.url;
        const key = `${lv.worktree}\0${latin1(link.path)}`;
        if (configured !== undefined && configured !== null) urlsByPath.set(key, configured);
        else if (written !== undefined) {
          try {
            const text = utf8.decode(Buffer.from(written, "latin1"));
            urlsByPath.set(key, resolveGitmodulesUrl(text, { listing: lv.config, headRef: lv.headRef }, lv.gitWorktree, forms.platform));
          } catch (error) {
            if (!(error instanceof SubmoduleUrlError) && !(error instanceof TypeError)) throw error;
          }
        }
      }
    };
    const urlsByPath = new Map<string, string>();

    // ---- Kept Git directories (contract §12 "Review reads") ----
    // Contract Δ12 "Submodule count": the Git form of a walk folder. Windows forbids `\` in a name, so each native path has one Git form.
    // Every compare of Git forms is ordinal, with no case fold.
    const gitFormOf = (folder: string) => (forms.wsl === undefined ? folder.replaceAll(NATIVE.path.sep, "/") : folder);
    // The Git directories that the row reads of `list` printed.
    const knownOf = (list: readonly ObservedRow[]) => new Set(list.flatMap((p) => (p.repo === null ? [] : [p.repo.gitDir])));
    // The name folders of this observation. A level read meets the folders of the preflight again.
    const nameFolders = new Set<string>();
    // `descend`: the walk also enters the `modules` folder of each kept Git directory.
    // `known`: the row Git directories of the same observation. Git accepted each of them, so such a folder counts as its row and gets no read (contract Δ12 "Kept-directory walk").
    // A name folder is on the way to a row Git directory. It counts only when Git accepts it. At most SUBMODULE_TREE_FOLDERS of them get a read.
    const keptBelow = async (folders: readonly string[], descend: boolean, known: ReadonlySet<string>): Promise<string[]> => {
      const keptDirs: string[] = [];
      const visited = new Set<string>();
      const prefixes = new Set<string>();
      for (const dir of known) for (let at = dir.indexOf("/"); at >= 0; at = dir.indexOf("/", at + 1)) prefixes.add(dir.slice(0, at));
      // Contract §11 "Paths and file access": a walk folder without an exact UNC form is a `path` refusal, and the walk skips it.
      const uncOf = (folder: string): string | null => {
        const at = forms.native(folder);
        if (at === null) refuse("path", folder, REFUSAL_TEXTS.uncPath(folder), null);
        return at;
      };
      const walk = async (folder: string): Promise<void> => {
        const at = uncOf(folder);
        if (at === null) return;
        let names;
        try {
          names = await readdir(at, { withFileTypes: true });
        } catch (error) {
          if (isMissing(error)) return;
          throw failed("REPOSITORY_UNAVAILABLE", at);
        }
        for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
          if (!entry.isDirectory()) continue;
          const child = forms.join(folder, entry.name);
          const key = gitFormOf(child);
          if (visited.has(key)) continue;
          visited.add(key);
          // A UNC name with a character of U+F000 to U+F0FF stands for another Linux name (contract §11 "Route").
          if (uncOf(child) === null) continue;
          let accepted = true;
          if (!known.has(key)) {
            const name = prefixes.has(key);
            if (name) {
              nameFolders.add(key);
              if (nameFolders.size > SUBMODULE_TREE_FOLDERS) {
                refuseLimit();
                return;
              }
            } else if (!count(`dir ${key}`)) return;
            accepted = (await git(submoduleGitDirArgs({ gitDir: child }))).code === 0;
            if (name && accepted && !count(`dir ${key}`)) return;
          }
          observed.push({ walk: child, accepted });
          if (accepted) {
            keptDirs.push(child);
            if (descend) await walk(forms.join(child, "modules"));
          } else await walk(child);
          if (limited) return;
        }
      };
      for (const folder of folders) {
        if (limited) break;
        await walk(folder);
      }
      return keptDirs;
    };
    // The kept Git directories that no row holds. Each gets its refusals once.
    const rowlessOf = async (keptDirs: readonly string[], known: Set<string>): Promise<Repo[]> => {
      const rowless: Repo[] = [];
      for (const dir of keptDirs) {
        if (known.has(gitFormOf(dir))) continue;
        const repo = await readRepo({ gitDir: dir });
        if (known.has(repo.gitDir)) continue;
        known.add(repo.gitDir);
        rowless.push(repo);
        // Contract §11 "Paths and file access": a refusal path names a Git-resolved directory in its native form.
        const path = nativeOf(dir);
        refuseUnsaved(path, repo, null);
        if (setsGitdir(repo.entries)) refuseGitdir(path, root);
      }
      return rowless;
    };

    // ---- Programs (contract §12 "Trust") ----
    const relativeEntries = relativePathEntries(environment.PATH ?? environment.Path);
    const stateValue = (state: FileState | null): SubmoduleProgram["digest"] => (state === null ? "unchecked" : state.kind === "digest" ? state.digest : state.kind);
    const shown = (entry: ConfigEntry, text: string) => {
      const p = keyParts(entry.key);
      return p !== null && valueShown(p) ? redactUrlUserInfo(text) : "";
    };
    // The relative values of a listing: a relative `core.hooksPath`, a relative program path, and a bare name with a relative `PATH` entry.
    const relativeValues = (listing: TrustListing, scopes: ReadonlySet<string> | null): { entry: ConfigEntry; key: string; program: string }[] => {
      const out: { entry: ConfigEntry; key: string; program: string }[] = [];
      const hooksPath = lastValue(listing.entries, (key) => key === "core.hookspath");
      if (hooksPath?.value && !isAbsolute(hooksPath.value) && !hooksPath.value.startsWith("~") && (scopes === null || scopes.has(hooksPath.scope))) out.push({ entry: hooksPath, key: "core.hooksPath", program: hooksPath.value });
      for (const i of listing.integrations) {
        if (scopes !== null && !scopes.has(i.entry.scope)) continue;
        if ((i.program.kind === "path" && !isAbsolute(i.program.text)) || (i.program.kind === "bare" && relativeEntries.length > 0)) {
          out.push({ entry: i.entry, key: i.key, program: i.program.kind === "path" ? i.program.text : i.program.name });
        }
      }
      return out;
    };

    // The entries of one Git directory, or of a `clone` row before its clone. `owner` keys the entries in the binding.
    // A row ID is random, so `owner` holds the row path bytes or the Git directory instead.
    const listPrograms = async (
      superListing: TrustListing,
      holder: { rowId: string } | { gitDirectory: string },
      owner: string,
      repo: Pick<Repo, "entries" | "hooks"> & { gitDir: string | null },
      root: string | null,
      writes: boolean,
      unknownNested: boolean,
    ): Promise<{ owner: string; fingerprint: string; entries: ProgramEntry[] }> => {
      const listed = await listSubmoduleTrust(runner, { operationId: t.operationId, signal: t.signal, workspace: w }, environment, repo.entries, repo.hooks, { root: root ?? forms.gitRoot, gitDirectory: repo.gitDir });
      if (!listed.ok) throw "stop" in listed ? walkStop(listed.stop) : new Halt({ code: listed.code });
      const listing = listed.listing;
      const superRelative = relativeValues(superListing, OUTER_SCOPES);
      const entries: ProgramEntry[] = [];
      const seen = new Set<string>();
      const add = (program: Omit<SubmoduleProgram, "rowId" | "gitDirectory">, identity: unknown[]) => {
        const key = JSON.stringify(identity);
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ program: { ...holder, ...program } as SubmoduleProgram, owner, identity });
      };
      const unchecked = (values: ReturnType<typeof relativeValues>, base: string | null, copy = "") => {
        for (const v of values) {
          const program = base === null ? v.program : forms.resolve(base, v.program);
          add({ key: v.key, scope: v.entry.scope, origin: redactUrlUserInfo(v.entry.origin), program: shown(v.entry, program), digest: "unchecked" }, [
            copy,
            v.key,
            Buffer.from(v.entry.originBytes).toString("base64"),
            Buffer.from(v.entry.keyValueBytes).toString("base64"),
          ]);
        }
      };
      // A kept Git directory without a row has no known worktree, so its relative values stay unchecked.
      const relative = writes || root === null ? relativeValues(listing, null) : [];
      const relativeEntrySet = new Set(relative.map((v) => v.entry));
      unchecked(relative, root);
      if (writes || root === null) unchecked(superRelative, root);
      if (unknownNested) {
        unchecked(relative, root, "nested");
        unchecked(superRelative, root, "nested");
      }
      for (const [i, integration] of listing.integrations.entries()) {
        if (!integration.repositoryControlled || relativeEntrySet.has(integration.entry)) continue;
        const program = integration.program.kind === "path" ? forms.resolve(root ?? forms.gitRoot, integration.program.text) : integration.program.kind === "bare" ? integration.program.name : "";
        const entry = integration.entry;
        add({ key: integration.key, scope: entry.scope, origin: redactUrlUserInfo(entry.origin), program: shown(entry, program), digest: stateValue(listing.files.integrations[i] ?? null) }, [
          "integration",
          Buffer.from(entry.originBytes).toString("base64"),
          Buffer.from(entry.keyValueBytes).toString("base64"),
        ]);
      }
      const hooksRelative = relative.some((v) => v.key === "core.hooksPath");
      if (!hooksRelative && listing.hooksOutside && listing.hooksDirectory !== null) {
        add({ key: "core.hooksPath", scope: "hooks", origin: listing.hooksDirectory, program: listing.hooksDirectory, digest: "unchecked" }, ["hooks-outside", listing.hooksDirectory]);
      }
      if (!hooksRelative) {
        for (const [j, hook] of listing.hooks.folder.entries()) {
          add({ key: hook.event, scope: "hooks", origin: hook.path, program: hook.path, digest: stateValue(listing.files.folder[j] ?? null) }, ["hook", hook.path]);
        }
      }
      const integrations = new Set(listing.integrations.map((i) => i.entry));
      for (const entry of listing.entries) {
        if ((entry.scope !== "local" && entry.scope !== "worktree") || gitWritten(entry) || integrations.has(entry)) continue;
        if (entry.key === "core.hookspath") continue;
        // Contract §7 names no program for this entry, so it has no program file.
        add({ key: entry.key, scope: entry.scope, origin: redactUrlUserInfo(entry.origin), program: "", digest: "absent" }, [
          "entry",
          Buffer.from(entry.originBytes).toString("base64"),
          Buffer.from(entry.keyValueBytes).toString("base64"),
        ]);
      }
      return { owner, fingerprint: listing.fingerprint, entries };
    };
    // A null `repo`: contract §12 "Trust", a `clone` row before its clone sees only the system, global, and command entries.
    const rowPrograms = (superListing: TrustListing, p: ObservedRow, repo: RepoConfig | null) => {
      const owner = programOwner(p.row);
      if (repo !== null) return listPrograms(superListing, { rowId: p.row.rowId }, owner, repo, p.worktree, p.writes, p.unknownNested);
      const outer = superListing.entries.filter((e) => OUTER_SCOPES.has(e.scope));
      return listPrograms(superListing, { rowId: p.row.rowId }, owner, { entries: outer, hooks: null, gitDir: null }, p.worktree, true, true);
    };
    // `bind`: the entries enter the binding inputs. The listings read ahead and apply in row order (contract Δ12 "Parallel reads").
    const programsOfAll = async (superListing: TrustListing, list: readonly ObservedRow[], rowless: readonly Repo[], bind: boolean): Promise<ProgramEntry[]> => {
      const reads = [
        ...list.filter((p) => p.repo !== null || p.row.action === "clone").map((p) => ahead(() => rowPrograms(superListing, p, p.repo))),
        ...rowless.map((repo) => ahead(() => listPrograms(superListing, { gitDirectory: repo.gitDir }, programDirOwner(repo.gitDir), repo, null, false, false))),
      ];
      const lists = [];
      for (const read of reads) lists.push(await read());
      if (bind) for (const l of lists) programInputs.push([l.owner, l.fingerprint], ...l.entries.map((e) => [e.owner, e.identity, e.program.digest]));
      return lists.flatMap((l) => l.entries);
    };

    // Only the outer `attempt` settles. `programsOf` in `beforeActive` runs inside `level`, and it must not drop or await the read-ahead of `level`.
    let attempts = 0;
    const attempt = async <T>(read: () => Promise<T>): Promise<SubmoduleFact<T>> => {
      attempts++;
      let fact: SubmoduleFact<T>;
      try {
        fact = { value: await read() };
      } catch (error) {
        if (!(error instanceof Halt)) throw error;
        fact = error.fact;
      } finally {
        if (--attempts === 0) await settle();
      }
      // 001 contract §5 "Deadline outcomes": a recorded deadline decides first, as `firstEnd` does. A read that no level awaits, as at the §5 bound, can record it too.
      return deadline ? { stop: "deadline" } : fact;
    };

    // Feature 004 contract Δ12 "Row order": a stable pre-order walk over `parentRowId`. Siblings keep the read order.
    const treeOrder = (list: readonly ObservedRow[]): ObservedRow[] => {
      const children = new Map<string | null, ObservedRow[]>();
      for (const p of list) {
        const siblings = children.get(p.row.parentRowId);
        if (siblings === undefined) children.set(p.row.parentRowId, [p]);
        else siblings.push(p);
      }
      const out: ObservedRow[] = [];
      const add = (parentRowId: string | null) => {
        for (const p of children.get(parentRowId) ?? []) {
          out.push(p);
          add(p.row.rowId);
        }
      };
      add(null);
      // Each nested row comes from the level read of a row in `list`, so the walk reaches every row.
      if (out.length !== list.length) throw failed("STATE_UNKNOWN");
      return out;
    };

    // Contract §12 "Review reads" from the superproject: the rows at every depth, the kept Git directories, and the programs.
    function top(input: SuperprojectInput): Promise<SubmoduleFact<Observed>> {
      boundConfig = 0;
      return attempt(async () => {
        const superListing = await superTrust();
        programInputs.push(superListing.fingerprint);
        if (setsGitdir(superListing.entries)) refuseGitdir(rootPath, root);
        const gitlinks = input.indexEntries.filter((e) => e.stage === 0 && e.mode === "160000");
        const head = input.head;
        observed.push({ head: [head.state, "target" in head ? head.target : null, "oid" in head ? head.oid : null], gitlinks: gitlinks.map((e) => [Buffer.from(e.path).toString("base64"), e.oid]) });
        let superModules = emptyModules();
        if (gitlinks.length > 0) {
          const path = [".gitmodules"];
          const [file] = (await fileFacts([{ root: "worktreeRoot", path }], true)) as [FileFact];
          // Contract §12 "Update protocol" step 2: the token binds the SHA-256 of the worktree file. A file above the §5 bound has no digest.
          observed.push({ gitmodulesFile: file.kind === "file" ? [file.digest ?? null, file.bound ?? null] : file });
          if (file.kind === "file" && file.bound !== undefined) refuseLimit();
          const source = await gitmodulesSource(entryExists(file, path), input.indexEntries, objectFormat, async () => {
            const r = await git(objectCheckArgs(), { input: new TextEncoder().encode("HEAD:.gitmodules\n") });
            if (r.code !== 0) throw failed("GIT_FAILED");
            const has = r.limited ? null : headGitmodulesOf(r.out, objectFormat);
            if (has === null) throw failed("MALFORMED_GIT_OUTPUT");
            return has;
          });
          observed.push({ gitmodulesSource: source });
          if (Array.isArray(source)) {
            const read = await readGitmodules(source);
            if (read === "limit") refuseLimit();
            else superModules = read;
          }
        }

        const pathspecs = pathspecsOf(superListing.entries);
        let active: Set<string> | null = null;
        if (pathspecs !== null) {
          active = pathspecs.length > 0 && gitlinks.length > 0 ? await activeSet(pathspecs) : new Set();
          observed.push({ active: [...active] });
        }

        const modulesRead = await git(modulesPathArgs());
        const modules = modulesRead.code === 0 ? oneLine(modulesRead.out) : null;
        if (modules === null) throw failed("GIT_FAILED");
        const topLevel: Level = {
          worktree: root,
          gitWorktree: forms.gitRoot,
          components: [],
          prefix: new Uint8Array(),
          modules,
          config: superListing.entries,
          headRef: head.state === "detached" ? null : head.target,
          depth: 0,
          parentRowId: null,
          parentPath: null,
          active,
          above: scope !== null,
        };
        await readRows(topLevel, gitlinks.map((e) => ({ path: e.path, oid: e.oid })), superModules, true);
        // Contract Δ12: a scoped walk covers only the `modules` folders of the rows in the scope.
        const below = rows.flatMap((p) => (p.repo === null || p.above ? [] : [forms.join(p.repo.gitDir, "modules")]));
        const known = knownOf(rows);
        const kept = await keptBelow(scope === null ? [modules, ...below] : below, true, known);
        const rowless = await rowlessOf(kept, known);
        const programs = await programsOfAll(superListing, rows, rowless, true);
        hosts = hostsOf(rows);
        return { rows: treeOrder(rows), refusals: ordered(0), rowless, programs, config: superListing.entries, activeRefused: false, ...attachment(0), hosts };
      }).finally(() => (boundConfig = null));
    }

    // Contract Δ12 and plan.md D13: a row that fetches inside its submodule names the host of each remote URL that differs from the host of its effective URL.
    // A `reuse` row without a HEAD commit fetches in its kept Git directory after its clone step (contract §12 "Plan").
    const hostsOf = (list: readonly ObservedRow[]): SubmoduleHostLine[] => {
      const lines: SubmoduleHostLine[] = [];
      for (const p of list) {
        if (p.repo === null || !(p.fetches || (p.row.action === "reuse" && p.row.head === null))) continue;
        const effective = rawUrl(p);
        const settings: SubmoduleHost = effective === null ? { kind: "unknown" } : submoduleUrlHost(effective, forms.platform);
        const named: SubmoduleHost[] = [];
        for (const entry of p.repo.entries) {
          const k = keyParts(entry.key);
          if (k === null || k.section !== "remote" || k.subsection === null || k.variable !== "url" || entry.value === null) continue;
          const fetch = submoduleUrlHost(entry.value, forms.platform);
          if (sameSubmoduleHost(fetch, settings) || named.some((h) => Bun.deepEquals(h, fetch) || sameSubmoduleHost(h, fetch))) continue;
          named.push(fetch);
          lines.push({ path: p.row.path, fetch, settings });
        }
      }
      return lines;
    };
    let hosts: SubmoduleHostLine[] = [];

    // Contract §12 "Plan", active set: the `submodule.active` pathspecs. Null: the key is unset.
    const pathspecsOf = (entries: readonly ConfigEntry[]): string[] | null =>
      entries.some((e) => e.key === "submodule.active") ? entries.filter((e) => e.key === "submodule.active" && e.value !== null && e.value !== "").map((e) => e.value!) : null;

    // Git's own matcher decides through `ls-files`. `at` is the worktree of a parent submodule in Git's form.
    const activeSet = async (pathspecs: string[], at?: string): Promise<Set<string>> => {
      const active = new Set<string>();
      const r = await git(activeSetArgs(pathspecs, at), { max: STATUS_LISTING_BYTES });
      if (r.limited) throw failed("OUTPUT_LIMIT");
      if (r.code !== 0) throw failed("GIT_FAILED");
      for (const record of records(r.out)) {
        const tab = record.indexOf(TAB);
        if (tab < 0 || !/^[0-7]{6} \S+ [0-3]$/.test(latin1(record.subarray(0, tab)))) throw failed("MALFORMED_GIT_OUTPUT");
        if (latin1(record.subarray(0, 7)) === "160000 ") active.add(latin1(record.subarray(tab + 1)));
      }
      return active;
    };

    // Contract §12 "Update protocol" step 6: one nested level of `parent` from its HEAD tree, with its active set and its programs.
    // `beforeActive` runs before the active-set read (contract §12 "Trust", program re-check). False: the read does not start.
    // The kept-directory walk stays in the `modules` folder of `parent`. `links` holds the gitlinks of a read that failed after `ls-tree`.
    async function level(
      parent: ObservedRow,
      beforeActive: () => Promise<SubmoduleFact<boolean>>,
    ): Promise<{ read: SubmoduleFact<Observed>; links: { path: Uint8Array; oid: string }[] }> {
      let links: { path: Uint8Array; oid: string }[] = [];
      const read = await attempt(async (): Promise<Observed> => {
        const superListing = await superTrust();
        const location = { worktree: parent.worktree };
        // Contract Δ12 "Update reads": the two reads run at once. A recorded deadline decides first, then the first failure in the serial order.
        const configRead = ahead(() => readConfig(location));
        const headRead = ahead(() => readHead(location));
        const config = await configRead();
        const { head, headRef } = await headRead();
        const firstRow = rows.length;
        const firstRefusal = refusals.length;
        if (setsGitdir(config.entries)) refuseGitdir(parent.row.path, parent.parentWorktree, parent.localPath, parent.row.depth > 0);
        const tree = head === null ? null : await treeOf(location, head, (found) => (links = found));
        const pathspecs = pathspecsOf(config.entries);
        let active: Set<string> | null = null;
        let activeRefused = false;
        if (pathspecs !== null) {
          active = new Set();
          if (pathspecs.length > 0 && tree !== null && tree.gitlinks.length > 0) {
            const allowed = await beforeActive();
            if (!("value" in allowed)) throw new Halt(allowed);
            if (allowed.value) active = await activeSet(pathspecs, parent.gitWorktree);
            else activeRefused = true;
          }
        }
        if (tree !== null) await readRows(childLevel(parent, { ...config, headRef }, active), tree.gitlinks, tree.modules, false);
        const list = rows.slice(firstRow);
        // Contract Δ12: the level of a row above the scope row holds no row of the scope, so its walk covers nothing.
        const known = knownOf(list);
        const rowless = await rowlessOf(await keptBelow(parent.above ? [] : [forms.join(config.gitDir, "modules")], false, known), known);
        const programs = await programsOfAll(superListing, list, rowless, false);
        return { rows: list, refusals: ordered(firstRefusal), rowless, programs, config: config.entries, activeRefused, ...attachment(firstRefusal), hosts: [] };
      });
      return { read, links };
    }

    // Contract §12 "Trust", program re-check: the entries of one row from new `config list` and hooks reads. A null `location`: a row before its clone.
    function programsOf(row: ObservedRow, location: SubmoduleLocation | null): Promise<SubmoduleFact<ProgramEntry[]>> {
      return attempt(async () => {
        const superListing = await superTrust();
        return (await rowPrograms(superListing, row, location === null ? null : await readConfig(location))).entries;
      });
    }

    // The token binding of the reads so far. Null before the trust listing.
    function binding() {
      if (cachedListing === null) return null;
      const view = trust.view(w, cachedListing, installation);
      // Row IDs are random. `pathBytes` and `depth` identify each row and its parent.
      const review = {
        observed,
        rows: rows.map((p) => ({ ...p.row, rowId: undefined, parentRowId: undefined })),
        refusals: ordered(0),
        urls: [...urlsByPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        hosts,
      };
      const bound: SubmoduleBinding = { review: sha256(review), programs: sha256(programInputs), trust: { state: view.state, trustId: view.trustId ?? null } };
      return { binding: bound, fingerprint: cachedListing.fingerprint, review, programs: programInputs };
    }

    // The HEAD and the configuration of one submodule Git directory, for the checks and the fallback remote of contract §12 "Update protocol" step 5.
    const head = (location: SubmoduleLocation) => attempt(() => readHead(location));
    const config = (location: SubmoduleLocation) => attempt(() => readConfig(location));

    return { top, level, programsOf, binding, head, config, marks: marks as ReadonlyMap<string, SubmoduleBranch> };
  }

  return {
    reviewSubmodules,
    observe,
    retained: (token: string): RetainedSubmoduleReview | undefined => retained.get(token),
    // Contract §6 "Registration reuse and release".
    release(repositoryId: string): void {
      for (const [token, r] of retained) if (r.repositoryId === repositoryId) retained.delete(token);
    },
  };
}

export type SubmoduleReviewer = ReturnType<typeof createSubmoduleReviewer>;
