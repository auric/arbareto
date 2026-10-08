// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T229: contract §12 "Review reads", "Plan", "Refusals", and "Trust", and data-model §6 "Submodule review" and §9.
// Inside a submodule, the review starts only the `submodule*Args` reads of `commands.ts`.

import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ErrorCode } from "../contracts/errors";
import {
  APPROVAL_LIFETIME_MS,
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  STATUS_LISTING_BYTES,
  SUBMODULE_GITMODULES_BYTES,
  SUBMODULE_REVIEW_NESTING_LEVELS,
  SUBMODULE_REVIEW_SUBMODULES,
  TRUST_INPUT_BYTES,
  WINDOWS_COMMAND_LINE_UNITS,
} from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import { buildRefusalRemedy, redactUrlUserInfo, type SubmoduleAction, type SubmodulePlanRow, type SubmoduleProgram, type SubmoduleRefusalReason } from "../contracts/submodules";
import type { Approvals } from "./approvals";
import {
  activeSetArgs,
  gitlinkPatchArgs,
  gitmodulesHeadArgs,
  gitmodulesIndexArgs,
  gitmodulesListArgs,
  isObjectId,
  objectCheckArgs,
  submoduleConfigListArgs,
  submoduleGitDirArgs,
  submoduleGitmodulesBlobArgs,
  submoduleHeadOidArgs,
  submoduleHeadRefArgs,
  submoduleHeadTargetArgs,
  submoduleHooksPathArgs,
  submoduleObjectCheckArgs,
  submoduleReachArgs,
  submoduleRefExistsArgs,
  submoduleTreeArgs,
  type ObjectFormat,
  type SubmoduleLocation,
} from "./commands";
import { unquote } from "./diff-parser";
import { commandLineUnits, createCollector, type GitRunner } from "./git-runner";
import { isMissing, runRead } from "./read-steps";
import type { Workspace } from "./registration";
import type { ChangeSnapshot, Completeness, ReadInstallation } from "./snapshot";
import { displayPath } from "./status-parser";
import { defaultRemote, resolveGitmodulesUrl, SubmoduleUrlError } from "./submodule-remote";
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
  type FileState,
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

// ---- Texts (contract §12 "Refusals" and "Plan") ----

const short = (oid: string) => oid.slice(0, 12);
const REFUSAL_TEXTS = {
  unsavedCommits: (path: string, oid: string) => `Submodule ${path} is at commit ${short(oid)}, which the update can leave without a branch, tag, or other ref. Save it with the command, then use Refresh.`,
  updateMode: (path: string, mode: string) => `Submodule ${path} uses the update mode ${mode}. Arbareto updates only submodules that Git checks out. Use the command in a terminal.`,
  cloneInterrupted: (path: string) => `Git stopped while it cloned submodule ${path}. Move the folder ${path} out of the repository after all Git tools stop. Then use Update submodules again.`,
  folderNotEmpty: (path: string) => `Submodule ${path} has no Git link, but its folder is not empty. Git would overwrite those files. Move the folder out of the repository, then use Refresh.`,
  noUrl: (path: string) => `The .gitmodules file has no entry for submodule ${path}. Git cannot update it.`,
  path: (path: string) => `Arbareto cannot pass the path of submodule ${path} to Git literally.`,
  activeValue: (path: string, name: string) => `Submodule ${path} has a submodule.${name}.active value that is not true or false. Fix it in a terminal, then use Refresh.`,
  remoteName: (path: string, name: string) => `Submodule ${path} has a remote named ${name}, which Git can read as an option. Rename that remote in a terminal, then use Refresh.`,
  gitdirConfig: "This repository sets custom locations for submodule Git folders. Arbareto reads only the default location. Update the submodules in a terminal.",
  limit: "This repository has more than 256 submodules or more than 8 nesting levels. Update them in a terminal.",
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
  submoduleReviewToken: string;
}

export type SubmoduleReviewOutcome =
  | { result: "succeeded"; value: SubmoduleReviewValue }
  | { result: "limited"; code: Exclude<Completeness, { state: "complete" }>["code"]; value: { completeness: Completeness } }
  | { result: "failed"; code: ErrorCode; value?: { path: string } }
  | { result: "canceled" }
  | { result: "deadline" };

export interface SubmoduleReviewTarget {
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
  installation: ReadInstallation;
  snapshot: ChangeSnapshot;
}

// The review that T230 revalidates. `review` and `programs` are the inputs of the binding digests.
export interface RetainedSubmoduleReview {
  repositoryId: string;
  issuedAt: number;
  value: SubmoduleReviewValue;
  review: unknown;
  programs: unknown;
}

class Stop {
  constructor(readonly outcome: SubmoduleReviewOutcome) {}
}

const NUL = 0x00;
const NEWLINE = 0x0a;
const TAB = 0x09;
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const sha256 = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
const failed = (code: ErrorCode, path?: string) => new Stop({ result: "failed", code, ...(path === undefined ? {} : { value: { path } }) });

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
function componentsOf(path: Uint8Array): string[] | null {
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
interface Gitmodules {
  byName: Map<string, Module>;
  // The path bytes (latin1) to the name. A later `path` value of a name replaces its earlier path (`gitmodules_cb` sets `overwrite`).
  nameOf: Map<string, string>;
}

function parseGitmodules(bytes: Uint8Array): Gitmodules | null {
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

// Git `submodule.c` `parse_submodule_update_type`: the modes that Git checks out, skips, or refuses here.
const CHECKED_OUT = new Set(["checkout"]);
const isCommandMode = (mode: string) => mode.startsWith("!");

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

// `ls-tree -r -z`: `<mode> SP <type> SP <oid> TAB <path>` records.
function parseTree(bytes: Uint8Array, objectFormat: ObjectFormat): { gitlinks: { path: Uint8Array; oid: string }[]; gitmodules: boolean } | null {
  if (bytes.length > 0 && bytes[bytes.length - 1] !== NUL) return null;
  const gitlinks: { path: Uint8Array; oid: string }[] = [];
  let gitmodules = false;
  for (const record of records(bytes)) {
    const tab = record.indexOf(TAB);
    if (tab < 0) return null;
    const m = /^([0-7]{6}) (blob|tree|commit) (\S+)$/.exec(latin1(record.subarray(0, tab)));
    const path = record.slice(tab + 1);
    if (m === null || !isObjectId(m[3]!, objectFormat) || path.length === 0) return null;
    if (m[1] === "160000" && m[2] === "commit") gitlinks.push({ path, oid: m[3]! });
    else if (GITMODULES.equals(path) && m[2] === "blob") gitmodules = true;
  }
  return { gitlinks, gitmodules };
}

// One submodule Git directory that the review reads.
interface Repo {
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
  components: string[];
  prefix: Uint8Array;
  gitDir: string;
  config: readonly ConfigEntry[];
  depth: number;
  parentRowId: string | null;
  parentPath: string | null;
  // The active pathspec matches of the superproject. Null: `submodule.active` is unset. Undefined: a nested level computes no active set.
  active?: Set<string> | null;
}

interface Pending {
  row: SubmodulePlanRow;
  worktree: string;
  pathBytes: Uint8Array;
  // The path below its parent worktree, for the remedy commands.
  localPath: Uint8Array;
  parentWorktree: string;
  repo: Repo | null;
  writes: boolean;
  unknownNested: boolean;
}

export interface SubmoduleReviewerOptions {
  runner: GitRunner;
  trust: Trust;
  approvals: Approvals;
  environment: ServiceEnvironment;
  now?: () => number;
}

export function createSubmoduleReviewer({ runner, trust, approvals, environment, now = () => performance.now() }: SubmoduleReviewerOptions) {
  const retained = new Map<string, RetainedSubmoduleReview>();
  const prune = () => {
    for (const [token, r] of retained) if (now() - r.issuedAt > APPROVAL_LIFETIME_MS) retained.delete(token);
  };

  async function reviewSubmodules(t: SubmoduleReviewTarget): Promise<SubmoduleReviewOutcome> {
    try {
      return await review(t);
    } catch (error) {
      if (error instanceof Stop) return error.outcome;
      throw error;
    }
  }

  async function review(t: SubmoduleReviewTarget): Promise<SubmoduleReviewOutcome> {
    const { snapshot: s, workspace: w, installation } = t;
    const objectFormat = w.objectFormat;
    if (s.indexFingerprint === null || s.policyFingerprint === null) {
      const c = s.completeness;
      return c.state === "limited" ? { result: "limited", code: c.code, value: { completeness: c } } : { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
    }

    // Contract §3: trust gating follows the read rule of §7, before any Git process inside a submodule.
    const listed = await trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: w });
    if (!listed.ok) return "stop" in listed ? { result: listed.stop } : { result: "failed", code: listed.code };
    const superListing = listed.listing;
    const gate = trust.gate(w, superListing, installation, "reads");
    if (gate !== null) return { result: "failed", code: gate };

    // The values that the token binds besides the plan, in read order.
    const observed: unknown[] = [];

    const git = async (args: string[], options: { max?: number; input?: Uint8Array } = {}) => {
      const out = createCollector({ maxBytes: options.max ?? DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
      const step = await runRead(runner, t, args, out, options.input);
      if (t.signal.aborted) throw new Stop({ result: "canceled" });
      if ("refused" in step) throw failed(step.refused);
      if (step.exit.deadline !== undefined) throw new Stop({ result: "deadline" });
      if (step.exit.diagnosticLimit) throw failed("OUTPUT_LIMIT");
      return { code: step.exit.exitCode, out: out.take(), limited: out.limited };
    };

    const facts = async (files: { root: "worktreeRoot"; path: string[] }[]) => {
      if (files.length === 0) return [];
      const reply = await requestFacts(runner, t.operationId, w, false, files, t.signal);
      if (t.signal.aborted) throw new Stop({ result: "canceled" });
      if (!Array.isArray(reply)) throw "stop" in reply ? new Stop({ result: reply.stop }) : failed(reply.code);
      if (reply.some((fact) => fact.kind === "error")) throw failed("REPOSITORY_UNAVAILABLE");
      // A link before the last component means that no entry exists at the path. The walk never follows a link.
      return reply.map((fact, i) => fact.kind !== "absent" && (fact.kind !== "link" || fact.component === files[i]!.path.length));
    };

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

    // `rev-parse --verify -q HEAD`. A nonzero exit leads to `symbolic-ref -q HEAD` and `show-ref --exists`; only exit 2 means no commit.
    const readRepo = async (location: SubmoduleLocation): Promise<Repo> => {
      const headRead = await git(submoduleHeadOidArgs(location));
      const symbolic = await git(submoduleHeadTargetArgs(location));
      let headRef: string | null = null;
      if (symbolic.code === 0) {
        headRef = oneLine(symbolic.out);
        if (headRef === null) throw failed("MALFORMED_GIT_OUTPUT");
      } else if (symbolic.code !== 1) throw failed("GIT_FAILED");
      let head: string | null;
      if (headRead.code === 0) {
        head = oneLine(headRead.out);
        if (head === null || !isObjectId(head, objectFormat)) throw failed("GIT_FAILED");
      } else {
        if (headRef === null) throw failed("GIT_FAILED");
        const exists = await git(submoduleRefExistsArgs(location, headRef));
        if (exists.code !== 2) throw failed("GIT_FAILED");
        head = null;
      }
      const gitDirRead = await git(submoduleGitDirArgs(location));
      const gitDir = gitDirRead.code === 0 ? oneLine(gitDirRead.out) : null;
      if (gitDir === null) throw failed("GIT_FAILED");
      const hooksRead = await git(submoduleHooksPathArgs(location));
      const hooksText = hooksRead.code === 0 ? oneLine(hooksRead.out) : null;
      if (hooksText === null) throw failed("GIT_FAILED");
      // Git prints the hooks path relative to the folder where it ran: the `-C` folder, or the worktree root with `--git-dir`.
      const hooks = resolve("worktree" in location ? location.worktree : w.worktreeRoot, hooksText);
      const config = await git(submoduleConfigListArgs(location), { max: TRUST_INPUT_BYTES });
      if (config.limited) throw failed("OUTPUT_LIMIT");
      if (config.code !== 0) throw failed("GIT_FAILED");
      const entries = parseConfigListing(config.out, false);
      if (entries === null) throw failed("MALFORMED_GIT_OUTPUT");
      let refHeld: boolean | null = null;
      if (head !== null) {
        const refs = await git(submoduleHeadRefArgs(location));
        if (refs.code !== 0) throw failed("GIT_FAILED");
        refHeld = refs.out.length > 0;
      }
      const repo = { location, head, headRef, gitDir, hooks, entries, refHeld };
      observed.push({ repo: { ...repo, entries: entries.map((e) => Buffer.from(e.keyValueBytes).toString("base64")) } });
      return repo;
    };

    // Git `is_tip_reachable`: exit 0 without output means that a ref or HEAD reaches the target. Anything else means none does.
    const reaches = async (location: SubmoduleLocation, target: string) => {
      const r = await git(submoduleReachArgs(location, target, objectFormat));
      const reached = r.code === 0 && r.out.length === 0;
      observed.push({ reach: target, reached });
      return reached;
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

    // Contract §12 "Review reads": the folder check reads entry types and names only.
    const folderEmpty = async (folder: string): Promise<boolean> => {
      let stat;
      try {
        stat = await lstat(folder);
      } catch (error) {
        if (isMissing(error)) return true;
        throw failed("REPOSITORY_UNAVAILABLE", folder);
      }
      if (!stat.isDirectory()) return false;
      try {
        return (await readdir(folder)).length === 0;
      } catch {
        throw failed("REPOSITORY_UNAVAILABLE", folder);
      }
    };
    // Git `clone_submodule` tests `<parent Git directory>/modules/<name>` with `file_exists`.
    const keptExists = async (path: string): Promise<boolean> => {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw failed("REPOSITORY_UNAVAILABLE", path);
      }
    };

    const gitPath = installation.selectedPath;
    // The worktree root in the native form of the remedy commands.
    const root = resolve(w.worktreeRoot);
    const rows: Pending[] = [];
    const refusals: { refusal: SubmoduleRefusal; late: boolean }[] = [];
    let limited = false;
    const refuse = (reason: SubmoduleRefusalReason, path: string, text: string, remedy: SubmoduleRefusal["remedy"], row?: SubmodulePlanRow) => {
      refusals.push({ refusal: { code: "UNSUPPORTED_SUBMODULE", reason, path, text, remedy }, late: reason === "update-mode" || reason === "gitdir-config" || reason === "limit" });
      if (row !== undefined && row.refusal === null) row.refusal = reason;
    };
    const refuseLimit = () => {
      if (limited) return;
      limited = true;
      const remedy = gitPath === null ? null : buildRefusalRemedy({ reason: "limit", gitPath, parentWorktree: root });
      refuse("limit", root, REFUSAL_TEXTS.limit, remedy);
    };
    const refuseGitdir = (path: string, parentWorktree: string, localPath?: Uint8Array) => {
      const remedy = gitPath === null ? null : buildRefusalRemedy({ reason: "gitdir-config", gitPath, parentWorktree, ...(localPath === undefined ? {} : { path: localPath }) });
      refuse("gitdir-config", path, REFUSAL_TEXTS.gitdirConfig, remedy);
    };
    const refuseUnsaved = (path: string, repo: Repo, target: string | null, row?: SubmodulePlanRow) => {
      if (repo.head === null || repo.refHeld !== false || repo.head === target) return;
      const location = "worktree" in repo.location ? { submoduleWorktree: repo.location.worktree } : { gitDirectory: repo.location.gitDir };
      const remedy = gitPath === null ? null : buildRefusalRemedy({ reason: "unsaved-commits", source: "review", gitPath, commit: repo.head, ...location });
      refuse("unsaved-commits", path, REFUSAL_TEXTS.unsavedCommits(path, repo.head), remedy, row);
    };
    // Every folder of the kept-directory walk and every row count toward the §5 bound.
    let counted = 0;
    const count = () => {
      counted++;
      if (counted > SUBMODULE_REVIEW_SUBMODULES) refuseLimit();
      return !limited;
    };

    // ---- Superproject reads ----
    if (setsGitdir(superListing.entries)) refuseGitdir(root, root);
    const gitlinks = s.indexEntries.filter((e) => e.stage === 0 && e.mode === "160000");
    observed.push({ head: s.head, gitlinks: gitlinks.map((e) => [Buffer.from(e.path).toString("base64"), e.oid]) });
    let superModules: Gitmodules = { byName: new Map(), nameOf: new Map() };
    if (gitlinks.length > 0) {
      const [worktreeEntry] = await facts([{ root: "worktreeRoot", path: [".gitmodules"] }]);
      const source = await gitmodulesSource(worktreeEntry!, s.indexEntries, objectFormat, async () => {
        const r = await git(objectCheckArgs(), { input: new TextEncoder().encode("HEAD:.gitmodules\n") });
        if (r.code !== 0) throw failed("GIT_FAILED");
        const line = oneLine(r.out);
        if (line === "HEAD:.gitmodules missing") return false;
        const found = line === null ? null : /^(\S+) (?:blob|tree|commit|tag) [0-9]+$/.exec(line);
        if (found === null || !isObjectId(found[1]!, objectFormat)) throw failed("MALFORMED_GIT_OUTPUT");
        return true;
      });
      observed.push({ gitmodulesSource: source });
      if (Array.isArray(source)) {
        const read = await readGitmodules(source);
        if (read === "limit") refuseLimit();
        else superModules = read;
      }
    }

    // Contract §12 "Plan", active set: with `submodule.active` set, Git's own matcher decides through `ls-files`.
    const pathspecs = superListing.entries.filter((e) => e.key === "submodule.active" && e.value !== null && e.value !== "").map((e) => e.value!);
    let active: Set<string> | null = null;
    if (superListing.entries.some((e) => e.key === "submodule.active")) {
      active = new Set();
      if (pathspecs.length > 0 && gitlinks.length > 0) {
        const r = await git(activeSetArgs(pathspecs), { max: STATUS_LISTING_BYTES });
        if (r.limited) throw failed("OUTPUT_LIMIT");
        if (r.code !== 0) throw failed("GIT_FAILED");
        for (const record of records(r.out)) {
          const tab = record.indexOf(TAB);
          if (tab < 0 || !/^[0-7]{6} \S+ [0-3]$/.test(latin1(record.subarray(0, tab)))) throw failed("MALFORMED_GIT_OUTPUT");
          if (latin1(record.subarray(0, 7)) === "160000 ") active.add(latin1(record.subarray(tab + 1)));
        }
      }
      observed.push({ active: [...active] });
    }

    // Contract §12 "Review reads": the top-level checked-out commits from `diff-files -p`, with C-quote unquoting of `+++ b/<path>`.
    const headsOf = async (paths: Uint8Array[]): Promise<Map<string, string>> => {
      const heads = new Map<string, string>();
      const wanted = new Set(paths.map(latin1));
      const texts = paths.map((p) => utf8.decode(p));
      const batches: string[][] = [];
      for (const text of texts) {
        const last = batches.at(-1);
        if (last !== undefined && commandLineUnits(installation.selectedPath ?? "", gitlinkPatchArgs([...last, text])) <= WINDOWS_COMMAND_LINE_UNITS) last.push(text);
        else batches.push([text]);
      }
      for (const batch of batches) {
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

    async function level(lv: Level, links: { path: Uint8Array; oid: string | null }[], modules: Gitmodules): Promise<void> {
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
      const nested: [Pending, Repo][] = [];

      for (const [i, { link, components }] of entries.entries()) {
        // The index bounds the top-level rows, so each of them gets its refusals. Nested levels stop at the bound.
        if (!count() && lv.depth > 0) return;
        const pathBytes = lv.depth === 0 ? link.path : Buffer.concat([lv.prefix, Buffer.from("/"), link.path]);
        const display = displayPath(pathBytes);
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
        const row: SubmodulePlanRow = {
          rowId: crypto.randomUUID(),
          pathBytes: Buffer.from(pathBytes).toString("base64"),
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
        const worktree = components === null ? lv.worktree : join(w.worktreeRoot, ...components);
        const pending: Pending = { row, worktree, pathBytes, localPath: link.path, parentWorktree: lv.worktree, repo: null, writes: false, unknownNested: false };
        rows.push(pending);
        if (components === null || nameText === null && name !== null) {
          refuse("path", display, REFUSAL_TEXTS.path(display), null, row);
          continue;
        }
        if (nameText === null || url === null) {
          refuse("no-url", display, REFUSAL_TEXTS.noUrl(display), null, row);
          continue;
        }
        if (lv.parentPath !== null && parentSetsActive) row.notes.push(NOTES.nestedActive(lv.parentPath));

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
          continue;
        }

        const modeEntry = lastValue(lv.config, submoduleKey(nameText, "update"));
        const mode = modeEntry?.value ?? module?.update ?? "checkout";
        const updateRemedy = () => (gitPath === null ? null : buildRefusalRemedy({ reason: "update-mode", gitPath, parentWorktree: lv.worktree, path: link.path }));
        // A `.gitmodules` value `!command` makes Git refuse the update for every row (probe S5).
        const gitmodulesCommand = module?.update !== undefined && isCommandMode(module.update);
        const registered = configUrl !== undefined;
        if (!registered) {
          if (lv.parentPath === null || !parentSetsActive) row.notes.push(NOTES.registers);
          if (/^\.\.?[\\/]/.test(url)) row.notes.push(NOTES.relative);
        }

        if (!initialized[i]) {
          const kept = join(lv.gitDir, "modules", ...nameText.split("/"));
          if (mode === "none") {
            row.action = "skip";
            continue;
          }
          if (gitmodulesCommand || isCommandMode(mode)) refuse("update-mode", display, REFUSAL_TEXTS.updateMode(display, mode), updateRemedy(), row);
          if (!(await keptExists(kept))) {
            row.action = "clone";
            pending.writes = true;
            pending.unknownNested = true;
            observed.push({ clone: display });
            continue;
          }
          row.action = "reuse";
          pending.writes = true;
          const empty = await folderEmpty(worktree);
          observed.push({ folder: display, empty });
          if (!empty) refuse("folder-not-empty", display, REFUSAL_TEXTS.folderNotEmpty(display), null, row);
          if (!isCommandMode(mode) && !CHECKED_OUT.has(mode) && !gitmodulesCommand) refuse("update-mode", display, REFUSAL_TEXTS.updateMode(display, mode), updateRemedy(), row);
          const repo = await readRepo({ gitDir: kept });
          pending.repo = repo;
          row.head = repo.head;
          if (repo.head === null) {
            pending.unknownNested = true;
            continue;
          }
          refuseUnsaved(display, repo, link.oid, row);
          await plan(pending, repo, link.oid);
          nested.push([pending, repo]);
          continue;
        }

        const repo = await readRepo({ worktree });
        pending.repo = repo;
        if (repo.head === null) {
          refuse("clone-interrupted", display, REFUSAL_TEXTS.cloneInterrupted(display), null, row);
          continue;
        }
        row.head = topHeads?.get(latin1(link.path)) ?? (lv.depth === 0 ? link.oid : repo.head);
        refuseUnsaved(display, repo, link.oid, row);
        if (mode === "none") {
          row.action = "skip";
        } else {
          if (gitmodulesCommand || !CHECKED_OUT.has(mode)) refuse("update-mode", display, REFUSAL_TEXTS.updateMode(display, mode), updateRemedy(), row);
          if (row.head === link.oid) row.action = "none";
          else await plan(pending, repo, link.oid);
          pending.writes = writing.has(row.action);
        }
        nested.push([pending, repo]);
      }

      // Depth first, as Git's own update visits the rows (probe S19).
      for (const [pending, repo] of nested) {
        if (setsGitdir(repo.entries)) refuseGitdir(pending.row.path, pending.parentWorktree, pending.localPath);
        if (pending.row.action === "skip") continue;
        const target = pending.row.target;
        const local = target !== null && (await present(repo.location, target));
        const commit = local ? target : repo.head;
        if (!local) pending.unknownNested = true;
        if (commit === null) continue;
        const tree = await git(submoduleTreeArgs(repo.location, commit, objectFormat), { max: STATUS_LISTING_BYTES });
        if (tree.limited) throw failed("OUTPUT_LIMIT");
        if (tree.code !== 0) throw failed("GIT_FAILED");
        const parsed = parseTree(tree.out, objectFormat);
        if (parsed === null) throw failed("MALFORMED_GIT_OUTPUT");
        observed.push({ tree: commit, gitlinks: parsed.gitlinks.map((g) => [Buffer.from(g.path).toString("base64"), g.oid]) });
        if (parsed.gitlinks.length === 0) continue;
        let childModules: Gitmodules = { byName: new Map(), nameOf: new Map() };
        if (parsed.gitmodules) {
          const read = await readGitmodules(submoduleGitmodulesBlobArgs(repo.location, commit, objectFormat));
          if (read === "limit") {
            refuseLimit();
            continue;
          }
          childModules = read;
        }
        const parts = componentsOf(pending.pathBytes)!;
        await level(
          { worktree: pending.worktree, components: parts, prefix: pending.pathBytes, gitDir: repo.gitDir, config: repo.entries, depth: lv.depth + 1, parentRowId: pending.row.rowId, parentPath: pending.row.path },
          parsed.gitlinks.map((g) => ({ path: g.path, oid: local ? g.oid : null })),
          childModules,
        );
      }
    }

    // Contract §12 "Plan": the action of a row with a HEAD commit, its notes, and the remotes of a fetching row.
    async function plan(pending: Pending, repo: Repo, target: string | null): Promise<void> {
      const { row } = pending;
      if (repo.head === null) return;
      if (target !== null && repo.head === target) {
        if (row.action !== "reuse") row.action = "none";
        return;
      }
      const reached = target !== null && (await reaches(repo.location, target));
      if (row.action !== "reuse") row.action = reached ? "checkout" : "fetch-checkout";
      if (repo.headRef?.startsWith("refs/heads/")) row.notes.push(NOTES.detaches(repo.headRef.slice("refs/heads/".length)));
      if (target !== null) row.notes.push(NOTES.moves(repo.head, target));
      if (reached) return;
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
    function rawUrl(pending: Pending): string | null {
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
            urlsByPath.set(key, resolveGitmodulesUrl(text, { listing: lv.config, headRef: null }, lv.worktree, "windows"));
          } catch (error) {
            if (!(error instanceof SubmoduleUrlError) && !(error instanceof TypeError)) throw error;
          }
        }
      }
    };
    const urlsByPath = new Map<string, string>();

    const top: Level = { worktree: root, components: [], prefix: new Uint8Array(), gitDir: w.commonDirectory, config: superListing.entries, depth: 0, parentRowId: null, parentPath: null, active };
    await level(top, gitlinks.map((e) => ({ path: e.path, oid: e.oid })), superModules);

    // ---- Kept Git directories (contract §12 "Review reads") ----
    const fold = (path: string) => NATIVE.fold(resolve(path));
    const known = new Set<string>();
    for (const p of rows) if (p.repo !== null) known.add(fold(p.repo.gitDir));
    const keptDirs: string[] = [];
    const visited = new Set<string>();
    const walk = async (folder: string): Promise<void> => {
      let names;
      try {
        names = await readdir(folder, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return;
        throw failed("REPOSITORY_UNAVAILABLE", folder);
      }
      for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (!entry.isDirectory()) continue;
        const child = join(folder, entry.name);
        if (visited.has(fold(child))) continue;
        visited.add(fold(child));
        if (!count()) return;
        const r = await git(submoduleGitDirArgs({ gitDir: child }));
        observed.push({ walk: child, accepted: r.code === 0 });
        if (r.code === 0) {
          keptDirs.push(child);
          await walk(join(child, "modules"));
        } else await walk(child);
        if (limited) return;
      }
    };
    await walk(join(w.commonDirectory, "modules"));
    for (const p of rows) if (p.repo !== null && !limited) await walk(join(p.repo.gitDir, "modules"));
    const rowless: Repo[] = [];
    for (const dir of keptDirs) {
      if (known.has(fold(dir))) continue;
      const repo = await readRepo({ gitDir: dir });
      if (known.has(fold(repo.gitDir))) continue;
      known.add(fold(repo.gitDir));
      rowless.push(repo);
      refuseUnsaved(dir, repo, null);
      if (setsGitdir(repo.entries)) refuseGitdir(dir, root);
    }

    // ---- Programs (contract §12 "Trust") ----
    const programs: SubmoduleProgram[] = [];
    const programInputs: unknown[] = [superListing.fingerprint];
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
    const superRelative = relativeValues(superListing, new Set(["system", "global", "command"]));
    const ownerKey = (owner: { rowId: string } | { gitDirectory: string }) => ("rowId" in owner ? owner.rowId : owner.gitDirectory);
    const add = (owner: { rowId: string } | { gitDirectory: string }, seen: Set<string>, program: Omit<SubmoduleProgram, "rowId" | "gitDirectory">, identity: unknown) => {
      const key = sha256([ownerKey(owner), identity]);
      if (seen.has(key)) return;
      seen.add(key);
      programs.push({ ...owner, ...program } as SubmoduleProgram);
      programInputs.push([ownerKey(owner), identity, program.digest]);
    };
    const unchecked = (owner: { rowId: string } | { gitDirectory: string }, seen: Set<string>, values: ReturnType<typeof relativeValues>, base: string | null, copy = "") => {
      for (const v of values) {
        const program = base === null ? v.program : resolve(base, v.program);
        add(owner, seen, { key: v.key, scope: v.entry.scope, origin: redactUrlUserInfo(v.entry.origin), program: shown(v.entry, program), digest: "unchecked" }, [
          copy,
          v.key,
          Buffer.from(v.entry.originBytes).toString("base64"),
          Buffer.from(v.entry.keyValueBytes).toString("base64"),
        ]);
      }
    };

    const listRepo = async (owner: { rowId: string } | { gitDirectory: string }, repo: Repo, root: string | null, writes: boolean, unknownNested: boolean) => {
      const listed = await listSubmoduleTrust(runner, { operationId: t.operationId, signal: t.signal, workspace: w }, environment, repo.entries, repo.hooks, root ?? w.worktreeRoot);
      if (!listed.ok) throw "stop" in listed ? new Stop({ result: listed.stop }) : failed(listed.code);
      const listing = listed.listing;
      programInputs.push([ownerKey(owner), listing.fingerprint]);
      const seen = new Set<string>();
      // A kept Git directory without a row has no known worktree, so its relative values stay unchecked.
      const relative = writes || root === null ? relativeValues(listing, null) : [];
      const relativeEntrySet = new Set(relative.map((v) => v.entry));
      unchecked(owner, seen, relative, root);
      if (writes || root === null) unchecked(owner, seen, superRelative, root);
      if (unknownNested) {
        unchecked(owner, seen, relative, root, "nested");
        unchecked(owner, seen, superRelative, root, "nested");
      }
      for (const [i, integration] of listing.integrations.entries()) {
        if (!integration.repositoryControlled || relativeEntrySet.has(integration.entry)) continue;
        const program = integration.program.kind === "path" ? resolve(root ?? w.worktreeRoot, integration.program.text) : integration.program.kind === "bare" ? integration.program.name : "";
        const entry = integration.entry;
        add(owner, seen, { key: integration.key, scope: entry.scope, origin: redactUrlUserInfo(entry.origin), program: shown(entry, program), digest: stateValue(listing.files.integrations[i] ?? null) }, [
          "integration",
          Buffer.from(entry.originBytes).toString("base64"),
          Buffer.from(entry.keyValueBytes).toString("base64"),
        ]);
      }
      const hooksRelative = relative.some((v) => v.key === "core.hooksPath");
      if (!hooksRelative) {
        for (const [j, hook] of listing.hooks.folder.entries()) {
          add(owner, seen, { key: hook.event, scope: "hooks", origin: hook.path, program: hook.path, digest: stateValue(listing.files.folder[j] ?? null) }, ["hook", hook.path]);
        }
      }
      const integrations = new Set(listing.integrations.map((i) => i.entry));
      for (const entry of listing.entries) {
        if ((entry.scope !== "local" && entry.scope !== "worktree") || gitWritten(entry) || integrations.has(entry)) continue;
        if (entry.key === "core.hookspath") continue;
        // Contract §7 names no program for this entry, so it has no program file.
        add(owner, seen, { key: entry.key, scope: entry.scope, origin: redactUrlUserInfo(entry.origin), program: "", digest: "absent" }, [
          "entry",
          Buffer.from(entry.originBytes).toString("base64"),
          Buffer.from(entry.keyValueBytes).toString("base64"),
        ]);
      }
    };

    for (const p of rows) {
      const action = p.row.action;
      if (p.repo !== null) await listRepo({ rowId: p.row.rowId }, p.repo, p.worktree, p.writes, p.unknownNested);
      else if (action === "clone") {
        const seen = new Set<string>();
        unchecked({ rowId: p.row.rowId }, seen, superRelative, p.worktree);
        unchecked({ rowId: p.row.rowId }, seen, superRelative, p.worktree, "nested");
      }
    }
    for (const repo of rowless) await listRepo({ gitDirectory: repo.gitDir }, repo, null, false, false);

    // ---- Token ----
    const ordered = [...refusals.filter((r) => !r.late), ...refusals.filter((r) => r.late)].map((r) => r.refusal);
    const value = {
      generation: s.generation,
      rows: rows.map((p) => p.row),
      programs,
      refusals: ordered,
    };
    const reviewInput = { observed, rows: value.rows.map((r) => ({ ...r, rowId: undefined })), refusals: ordered, urls: [...urlsByPath] };
    const view = trust.view(w, superListing, installation);
    const submoduleReviewToken = crypto.randomUUID();
    approvals.issue({
      kind: "submodule",
      reviewToken: submoduleReviewToken,
      repositoryId: w.repositoryId,
      snapshotId: s.snapshotId,
      generation: s.generation,
      binding: { review: sha256(reviewInput), programs: sha256(programInputs), trust: { state: view.state, trustId: view.trustId ?? null } },
    });
    prune();
    const full = { ...value, submoduleReviewToken };
    retained.set(submoduleReviewToken, { repositoryId: w.repositoryId, issuedAt: now(), value: full, review: reviewInput, programs: programInputs });
    return { result: "succeeded", value: full };
  }

  return {
    reviewSubmodules,
    retained: (token: string): RetainedSubmoduleReview | undefined => retained.get(token),
    // Contract §6 "Registration reuse and release".
    release(repositoryId: string): void {
      for (const [token, r] of retained) if (r.repositoryId === repositoryId) retained.delete(token);
    },
  };
}

export type SubmoduleReviewer = ReturnType<typeof createSubmoduleReviewer>;
