// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Shared steps of the submodule tests T222, T223, and T253 (contract §12). The oracle shares no code with `src/git-service/`.
// `submodule-review.ts`, `submodule-update.ts`, and `submodule-remote.ts` come with T229, T230, and T254, so no test imports them at load.

import { expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { SubmodulePlanRow, SubmoduleProgram, SubmoduleRowResult } from "../../src/contracts/submodules";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureDir, ownedGit, serviceEnv } from "./fixture-root";
import { put, type Built, type Repo } from "./fixtures";
import { submoduleState, submoduleUpdateOracle, type SubmoduleUpdateResult } from "./git-oracle";
import { gitPath, psQuote, readOk, valuesOf, withService } from "./hunk-harness";
import type { Envelope, OpenOptions, Service, ServiceResponse, WorkspaceResult } from "./service-harness";

// Prints the ORIGIN line of a module under test and loads it. Before its task, a missing module makes this throw.
export async function underTestSubmodule(module: "submodule-review" | "submodule-update" | "submodule-remote" | "status"): Promise<Record<string, unknown>> {
  printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  return import(`../../src/git-service/${module}.ts`);
}

export const superOf = (b: Built) => join(b.root, "super");

// The owned global file of a fixture. `globalConfig` holds `protocol.file.allow=always`. F29 `globalNoFile` lacks it.
export const globalEnv = (b: Built, key: "globalConfig" | "globalNoFile" = "globalConfig") => ({ GIT_CONFIG_GLOBAL: join(b.root, b.facts.notes[key] as string) });

// One service with the owned global file of the fixture (tasks.md "Test harness rules": submodule tests enable local transport only there).
export function withFixture(b: Built, name: string, body: (service: Service) => Promise<void>, options: Partial<Omit<OpenOptions, "git" | "name">> = {}, key: "globalConfig" | "globalNoFile" = "globalConfig"): Promise<void> {
  return withService({ name, environment: serviceEnv(globalEnv(b, key)), ...options }, body);
}

// A test-side Git command with the owned global file of the fixture.
export const fixtureGit = (b: Built, cwd: string, args: string[], allowExit = [0]) => ownedGit(gitPath(), FIXTURE_ROOT, cwd, args, { env: globalEnv(b), allowExit }).toString("utf8");

// Every object at any depth that holds each key. Data-model §9 names the fields, and the result nesting stays free.
export function objectsWith<T>(value: unknown, keys: readonly string[]): T[] {
  if (Array.isArray(value)) return value.flatMap((item) => objectsWith<T>(item, keys));
  if (typeof value !== "object" || value === null) return [];
  const own = keys.every((key) => key in value) ? [value as T] : [];
  return [...own, ...Object.values(value).flatMap((item) => objectsWith<T>(item, keys))];
}

// Contract §9: `UNSUPPORTED_SUBMODULE` carries the submodule path and one reason. §12 "Refusals" gives the text and the remedy.
export interface SubmoduleRefusal {
  code: "UNSUPPORTED_SUBMODULE";
  reason: string;
  path: string;
  text: string;
  remedy?: { command: string | null; text?: string } | null;
}

export const refusalsOf = (value: unknown) => objectsWith<SubmoduleRefusal>(value, ["code", "reason"]).filter((r) => r.code === "UNSUPPORTED_SUBMODULE");

export interface SubmoduleReview {
  read: WorkspaceResult;
  response: ServiceResponse;
  // The one-use submodule review token, or undefined when the review issued none.
  token: string | undefined;
  rows: SubmodulePlanRow[];
  programs: SubmoduleProgram[];
  refusals: SubmoduleRefusal[];
}

// `reviewSubmodules` of a fresh or given read (contract §3). The response stays unchecked.
export async function reviewSubmodules(service: Service, repositoryId: string, read?: WorkspaceResult): Promise<SubmoduleReview> {
  const current = read ?? (await readOk(service, repositoryId));
  const response = await service.request("reviewSubmodules", { snapshotId: current.snapshotId }, { repositoryId, repositoryGeneration: current.generation });
  return {
    read: current,
    response,
    token: valuesOf(response.result, "submoduleReviewToken")[0] as string | undefined,
    rows: objectsWith<SubmodulePlanRow>(response.result, ["rowId", "action"]),
    programs: objectsWith<SubmoduleProgram>(response.result, ["key", "digest"]),
    refusals: refusalsOf(response.result),
  };
}

export async function reviewOk(service: Service, repositoryId: string, read?: WorkspaceResult): Promise<SubmoduleReview> {
  const r = await reviewSubmodules(service, repositoryId, read);
  expect({ state: r.response.state, code: r.response.code, refusals: r.refusals.map((x) => x.reason), token: typeof r.token }).toEqual({ state: "succeeded", code: undefined, refusals: [], token: "string" });
  return r;
}

export function rowOf(r: { rows: SubmodulePlanRow[] }, path: string): SubmodulePlanRow {
  const rows = r.rows.filter((row) => row.path === path);
  expect({ path, count: rows.length }).toEqual({ path, count: 1 });
  return rows[0]!;
}

// The row path to action map of a review.
export const actionsOf = (r: { rows: SubmodulePlanRow[] }) => Object.fromEntries(r.rows.map((row) => [row.path, row.action]));

const updatePayload = (r: SubmoduleReview) => ({ submoduleReviewToken: r.token, start: true });

// Sends `updateSubmodules` and returns the request ID.
export function sendUpdate(service: Service, repositoryId: string, r: SubmoduleReview, envelope: Envelope = {}): string {
  return service.send("updateSubmodules", updatePayload(r), { repositoryId, repositoryGeneration: r.read.generation, ...envelope });
}

export function updateSubmodules(service: Service, repositoryId: string, r: SubmoduleReview, envelope: Envelope = {}): Promise<ServiceResponse> {
  return service.response(sendUpdate(service, repositoryId, r, envelope));
}

// Data-model §9 "Row result".
export const resultsOf = (response: ServiceResponse) => objectsWith<SubmoduleRowResult>(response.result, ["rowId", "state", "fetched"]);

export function resultOf(response: ServiceResponse, path: string): SubmoduleRowResult {
  const rows = resultsOf(response).filter((row) => row.path === path);
  expect({ path, count: rows.length }).toEqual({ path, count: 1 });
  return rows[0]!;
}

// The canaries of a fixture that ran, by name. Read this before any test-side Git command, which can run a submodule monitor.
export const ranCanaries = (b: Built) => Object.entries(b.facts.canaries).filter(([, log]) => existsSync(join(b.root, log))).map(([name]) => name).sort();
export const canaryLines = (b: Built, name: string) => (existsSync(join(b.root, b.facts.canaries[name]!)) ? readFileSync(join(b.root, b.facts.canaries[name]!), "utf8").split("\n").filter((l) => l !== "") : []);

// The Git location of a recorded call: the `-C` value or the `--git-dir=` value. Null: the double's working directory, the registered worktree.
export function gitLocation(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") i++;
    else if (args[i] === "-C") return args[i + 1] ?? null;
    else if (args[i]!.startsWith("--git-dir=")) return args[i]!.slice("--git-dir=".length);
  }
  return null;
}

// True for a call whose location is not the superproject worktree. `path.relative` folds case on Windows only.
export const insideSubmodule = (superDir: string, args: readonly string[]) => {
  const at = gitLocation(args);
  return at !== null && relative(superDir, resolve(superDir, at)) !== "";
};

export const callsSince = (service: Service, from = 0) => service.runner.calls.slice(from);
export const submoduleCalls = (service: Service, superDir: string, from = 0) => callsSince(service, from).filter((c) => insideSubmodule(superDir, c.arguments));

// The command after the location options: the argument list from the first argument that is no global option.
export function commandOf(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "-c" || a === "-C") i += 2;
    else if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=") || a === "--no-lazy-fetch" || a === "--no-optional-locks" || a === "--literal-pathspecs") i += 1;
    else break;
  }
  return args.slice(i);
}

// Contract §12 "Review reads": the only commands inside a submodule. `<oid>` is a full object ID. `<branch>` is a ref under `refs/heads/`.
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Feature 003 contract Δ3 `readTracking`: the for-each-ref format.
export const TRACKING_FORMAT = "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)";
// Feature 004 contract Δ12 "Branch marks": the mark read of a submodule.
export const isTrackCall = (args: readonly string[]) => {
  const c = commandOf(args);
  return c.length === 3 && c[0] === "for-each-ref" && c[1] === TRACKING_FORMAT;
};
const REVIEW_READS: string[][] = [
  ["rev-parse", "--verify", "-q", "HEAD"],
  ["rev-parse", "--absolute-git-dir"],
  ["rev-parse", "--git-path", "hooks"],
  ["symbolic-ref", "-q", "HEAD"],
  ["config", "list", "--show-scope", "--show-origin", "-z"],
  ["for-each-ref", "--contains=HEAD", "--count=1", "--format=%(refname)"],
  ["cat-file", "--batch-check"],
  ["rev-list", "-n", "1", "<oid>", "--not", "--all"],
  ["ls-tree", "-r", "-z", "--full-tree", "<oid>"],
  ["config", "--blob", "<oid>:.gitmodules", "--null", "--list"],
  // Feature 004 contract Δ12 "Branch marks": the 003 tracking format for the HEAD branch.
  ["for-each-ref", TRACKING_FORMAT, "<branch>"],
];
const matches = (command: readonly string[], form: readonly string[]) =>
  command.length === form.length &&
  form.every((f, i) =>
    f === "<oid>" ? OID.test(command[i]!) : f === "<oid>:.gitmodules" ? command[i]!.endsWith(":.gitmodules") && OID.test(command[i]!.slice(0, -":.gitmodules".length)) : f === "<branch>" ? command[i]!.startsWith("refs/heads/") : f === command[i],
  );
export const isReviewRead = (args: readonly string[]) => args[0] === "--no-lazy-fetch" && args[1] === "--no-optional-locks" && REVIEW_READS.some((form) => matches(commandOf(args), form));

// Contract §12 "Update protocol" step 5: the update steps. Each starts with `--no-lazy-fetch`.
export const isUpdateStep = (args: readonly string[]) => {
  const c = commandOf(args);
  return (c[0] === "submodule" && (c[1] === "update" || c[1] === "init")) || c[0] === "fetch";
};
export const updateSteps = (service: Service, from = 0) => callsSince(service, from).filter((c) => isUpdateStep(c.arguments));

// The oracle state of the fixture superproject after the service run, and Git's own update in a copy before it.
// `config` holds `-c` arguments, such as `core.fsmonitor=false` for the F29 monitor canaries.
export const stateOf = (b: Built, dir = superOf(b), config: string[] = []) => submoduleState(gitPath(), dir, globalEnv(b), config);
export const oracleOf = (b: Built, name: string, dir = superOf(b)): SubmoduleUpdateResult => submoduleUpdateOracle(gitPath(), dir, join(b.root, name), globalEnv(b));

export type SubmoduleState = ReturnType<typeof stateOf>;
// `submodule.<name>.<variable>`: the variable holds no dot (git-config(1) "Syntax").
const keyName = (key: string) => key.slice("submodule.".length, key.lastIndexOf("."));

// The expected state of a run: `oracle`, where each `[path, name]` row takes its HEAD, Git folder, and `submodule.<name>.*` keys from `keep`.
// A value that `keep` lacks removes the entry. A row without a name keeps the keys. `heads` sets single HEADs last.
export function oracleExcept(oracle: SubmoduleState, except: { keep?: SubmoduleState; rows?: readonly (readonly [path: string, name?: string])[]; heads?: Record<string, string> } = {}): SubmoduleState {
  const out: SubmoduleState = { heads: { ...oracle.heads }, gitDirs: { ...oracle.gitDirs }, keys: { ...oracle.keys } };
  for (const [path, name] of except.rows ?? []) {
    for (const part of ["heads", "gitDirs"] as const) {
      if (except.keep !== undefined && path in except.keep[part]) out[part][path] = except.keep[part][path]!;
      else delete out[part][path];
    }
    if (name === undefined) continue;
    for (const key of Object.keys(out.keys)) if (keyName(key) === name) delete out.keys[key];
    for (const [key, values] of Object.entries(except.keep?.keys ?? {})) if (keyName(key) === name) out.keys[key] = values;
  }
  Object.assign(out.heads, except.heads);
  return out;
}

// A copy of the superproject folder inside the fixture folder. Each submodule `.git` file and `core.worktree` is relative, so the copy stands alone.
export function copySuper(b: Built, name: string): string {
  const dir = join(b.root, name);
  cpSync(superOf(b), dir, { recursive: true });
  return dir;
}

// The Git folder of a submodule by name, resolved by Git (`rev-parse --git-path modules/<name>`).
export const moduleDirOf = (b: Built, superDir: string, name: string) => resolve(superDir, fixtureGit(b, superDir, ["rev-parse", "--git-path", `modules/${name}`]).trimEnd());

// A `.git` folder whose HEAD names no ref. Git accepts no such folder (setup.c `is_git_directory`), so Git discovery from `dir` searches the parent folders.
export function invalidGitFolder(dir: string): void {
  put(dir, ".git/HEAD", "invalid\n");
  for (const name of ["objects", "refs"]) mkdirSync(join(dir, ".git", name), { recursive: true });
}

// Contract §4 "Quoting rule": the remedy value forms of `psQuote`.
export const q = psQuote;
// Contract §12 "Refusals" `unsaved-commits`: the short ID has 12 hex digits.
export const short = (oid: string) => oid.slice(0, 12);

// Contract §12 "Remedies": the update command of the `update-mode`, `gitdir-config`, and `limit` refusals.
export const UPDATE_TEXT =
  "This command runs Git's own recursive update without Arbareto's checks. Git can leave submodule commits without a ref. It can overwrite files in reused submodule folders and run a configured update command. Resolve every other refusal first.";
export const updateCommand = (parent: string, path?: string) => `& ${q(gitPath())} --no-lazy-fetch -C ${q(parent)} submodule update --init --recursive${path === undefined ? "" : ` -- ${q(`:(literal)${path}`)}`}`;

// Contract §12 "Refusals" texts.
export const TEXTS = {
  unsavedCommits: (path: string, oid: string) => `Submodule ${path} is at commit ${short(oid)}, which the update can leave without a branch, tag, or other ref. Save it with the command, then use Refresh.`,
  updateMode: (path: string, mode: string) => `Submodule ${path} uses the update mode ${mode}. Arbareto updates only submodules that Git checks out. Use the command in a terminal.`,
  cloneInterrupted: (path: string) => `Git stopped while it cloned submodule ${path}. Move the folder ${path} out of the repository after all Git tools stop. Then use Update submodules again.`,
  folderNotEmpty: (path: string) => `Submodule ${path} has no Git link, but its folder is not empty. Git would overwrite those files. Move the folder out of the repository, then use Refresh.`,
  noUrl: (path: string) => `The .gitmodules file has no entry for submodule ${path}. Git cannot update it.`,
  path: (path: string) => `Arbareto cannot pass the path of submodule ${path} to Git literally.`,
  remoteName: (path: string, name: string) => `Submodule ${path} has a remote named ${name}, which Git can read as an option. Rename that remote in a terminal, then use Refresh.`,
  gitdirConfig: "This repository sets custom locations for submodule Git folders. Arbareto reads only the default location. Update the submodules in a terminal.",
  limit: "This repository has more than 256 submodules or more than 8 nesting levels. Update them in a terminal.",
  programs: (path: string) => `Submodule ${path} needs programs that the run confirmation did not cover. Use Update submodules again to review them.`,
  changedAfterReview: (path: string) => `Another program changed submodule ${path} after the review. Use Update submodules again to review it.`,
  foundFolder: (path: string, oid: string) =>
    `Submodule ${path} is at commit ${short(oid)}, which no branch, tag, or other ref holds. Another program set up this submodule after the review. Save that commit in a terminal, then use Update submodules again.`,
};

// Contract §12 "Plan" notes.
export const NOTES = {
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

// Contract §12 "Remedies": the step commands and texts.
export const STEP_TEXT = {
  fetch: "This command fetches this submodule in a terminal, where Git and SSH can ask for input. Then use Update submodules again.",
  checkout: "This command checks out this submodule in a terminal, where Git can ask for input. Then use Update submodules again.",
  clone: "This command clones this submodule in a terminal, where Git and SSH can ask for input. Then use Update submodules again.",
};
export const cloneRemedy = (parent: string, path: string) => `& ${q(gitPath())} --no-lazy-fetch -C ${q(parent)} submodule update --init -- ${q(`:(literal)${path}`)}`;
export const checkoutRemedy = (parent: string, path: string) => `& ${q(gitPath())} --no-lazy-fetch -C ${q(parent)} submodule update --init --no-fetch -- ${q(`:(literal)${path}`)}`;
export const fetchRemedy = (worktree: string, tail = "") =>
  `& { $p = $env:GIT_PROTOCOL_FROM_USER; $env:GIT_PROTOCOL_FROM_USER = '0'; try { & ${q(gitPath())} --no-lazy-fetch -C ${q(worktree)} --git-dir=.git fetch --no-recurse-submodules${tail} } finally { $env:GIT_PROTOCOL_FROM_USER = $p } }`;

// Contract §12 "Remedies": the unsaved-commits save command of a worktree or a kept Git directory.
export function saveCommand(location: { worktree: string } | { gitDir: string }, oid: string): string {
  const where = "worktree" in location ? `-C ${q(location.worktree)} --git-dir=.git` : `--git-dir=${q(location.gitDir)} --work-tree=${q(location.gitDir)}`;
  return `& ${q(gitPath())} --no-lazy-fetch ${where} branch ${q(`arbareto-saved-${short(oid)}`)} ${q(oid)}`;
}

// ---- A small superproject for the URL forms and the quoting cases (T253, T223). F27 to F30 hold neither. ----

export interface MiniWorld {
  root: string;
  sup: Repo;
  // The bare remote `solo.git` with its URL in `/` form and its two commits.
  solo: { url: string; first: string; second: string };
  env: { GIT_CONFIG_GLOBAL: string };
}

export interface MiniSub {
  name: string;
  path: string;
  url: string;
  // The recorded commit: `second` by default.
  at?: "first" | "second";
}

// `<root>/super` is a clone of `<root>/super.git`. It records one gitlink for each entry of `subs`, and its `.gitmodules` holds each URL as written.
// `extraGlobal` adds lines to the owned global file, which already holds `protocol.file.allow=always`.
export function miniWorld(name: string, subs: readonly MiniSub[], extraGlobal: (root: string) => string = () => ""): MiniWorld {
  const root = fixtureDir(name);
  const global = put(root, "global.gitconfig", `${readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8")}[protocol "file"]\n\tallow = always\n${extraGlobal(root.replaceAll("\\", "/"))}`);
  const env = { GIT_CONFIG_GLOBAL: global };
  const g = (cwd: string, args: string[], input?: Uint8Array) => ownedGit(gitPath(), FIXTURE_ROOT, cwd, args, { env, input }).toString("utf8");
  const url = (bare: string) => join(root, bare).replaceAll("\\", "/");
  for (const bare of ["solo.git", "super.git"]) g(root, ["init", "-q", "--bare", "-b", "main", bare]);
  const src = join(root, "src");
  mkdirSync(src);
  g(src, ["init", "-q", "-b", "main"]);
  g(src, ["config", "core.autocrlf", "false"]);
  const commits: string[] = [];
  for (const n of [1, 2]) {
    put(src, "solo.txt", `solo ${n}\n`);
    g(src, ["add", "--", "solo.txt"]);
    g(src, ["commit", "-q", "-m", `solo ${n}`]);
    commits.push(g(src, ["rev-parse", "HEAD"]).trim());
  }
  g(src, ["push", "-q", url("solo.git"), "HEAD:refs/heads/main"]);
  const [first, second] = commits as [string, string];
  const work = join(root, "super-src");
  mkdirSync(work);
  g(work, ["init", "-q", "-b", "main"]);
  g(work, ["config", "core.autocrlf", "false"]);
  // git-config(1) "Syntax": a quoted value escapes `\` and `"`.
  const value = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  put(work, ".gitmodules", subs.map((s) => `[submodule ${value(s.name)}]\n\tpath = ${value(s.path)}\n\turl = ${value(s.url)}\n`).join(""));
  g(work, ["add", "--", ".gitmodules"]);
  const records = subs.map((s) => Buffer.concat([Buffer.from(`160000 ${s.at === "first" ? first : second} 0\t`), Buffer.from(s.path), Buffer.from([0])]));
  g(work, ["update-index", "-z", "--index-info"], Buffer.concat(records));
  g(work, ["commit", "-q", "-m", "super"]);
  g(work, ["push", "-q", url("super.git"), "HEAD:refs/heads/main"]);
  g(root, ["clone", "-q", url("super.git"), "super"]);
  const sup: Repo = { git: gitPath(), dir: join(root, "super"), pre: [] };
  g(sup.dir, ["config", "core.autocrlf", "false"]);
  return { root, sup, solo: { url: url("solo.git"), first, second }, env };
}

// A Git command in a mini world, with its owned global file.
export const miniGit = (w: MiniWorld, cwd: string, args: string[], allowExit = [0]) => ownedGit(gitPath(), FIXTURE_ROOT, cwd, args, { env: w.env, allowExit }).toString("utf8");

// ---- A superproject with nested submodules (004 T136, T139). ----

// The nested submodules of each submodule path. A path without nested submodules uses the leaf remote.
export type SubTree = { readonly [path: string]: SubTree };

export interface TreeWorld {
  root: string;
  sup: string;
  env: { GIT_CONFIG_GLOBAL: string };
  // The two commits of `<root>/leaf.git`. Each leaf submodule records `second`.
  leaf: { first: string; second: string };
}

// `<root>/super` is a clone of `<root>/super.git`. Git's own `submodule update --init --recursive` initializes every submodule of `tree`.
// Each submodule with nested submodules has its own remote. Each URL is relative, so Git resolves it against the remote of the parent.
export function treeWorld(name: string, tree: SubTree): TreeWorld {
  const root = fixtureDir(name);
  const global = put(root, "global.gitconfig", `${readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8")}[protocol "file"]\n\tallow = always\n`);
  const env = { GIT_CONFIG_GLOBAL: global };
  const g = (cwd: string, args: string[], input?: Uint8Array) => ownedGit(gitPath(), FIXTURE_ROOT, cwd, args, { env, input }).toString("utf8");
  const url = (bare: string) => join(root, bare).replaceAll("\\", "/");
  // Commits each text in order, with the gitlinks `[path, url, oid]` in the last commit, and pushes `main` to `<root>/<bare>`.
  const publish = (bare: string, texts: string[], links: [string, string, string][] = []): string[] => {
    g(root, ["init", "-q", "--bare", "-b", "main", bare]);
    const work = join(root, "src", bare);
    mkdirSync(work, { recursive: true });
    g(work, ["init", "-q", "-b", "main"]);
    const commits = texts.map((text, i) => {
      put(work, "file.txt", text);
      g(work, ["add", "--", "file.txt"]);
      if (i === texts.length - 1 && links.length > 0) {
        put(work, ".gitmodules", links.map(([path, link]) => `[submodule "${path}"]\n\tpath = ${path}\n\turl = ${link}\n`).join(""));
        g(work, ["add", "--", ".gitmodules"]);
        g(work, ["update-index", "-z", "--index-info"], Buffer.from(links.map(([path, , oid]) => `160000 ${oid} 0\t${path}\0`).join("")));
      }
      g(work, ["commit", "-q", "-m", text]);
      return g(work, ["rev-parse", "HEAD"]).trim();
    });
    g(work, ["push", "-q", url(bare), "HEAD:refs/heads/main"]);
    return commits;
  };
  const [first, second] = publish("leaf.git", ["leaf 1\n", "leaf 2\n"]) as [string, string];
  let remotes = 0;
  const linksOf = (sub: SubTree): [string, string, string][] =>
    Object.entries(sub).map(([path, nested]) => {
      if (Object.keys(nested).length === 0) return [path, "../leaf.git", second];
      const bare = `n${++remotes}.git`;
      return [path, `../${bare}`, publish(bare, [`${bare}\n`], linksOf(nested))[0]!];
    });
  publish("super.git", ["super\n"], linksOf(tree));
  g(root, ["clone", "-q", url("super.git"), "super"]);
  const sup = join(root, "super");
  g(sup, ["submodule", "update", "--init", "--recursive", "-q"]);
  return { root, sup, env, leaf: { first, second } };
}

// git-status(1) "Branch Headers" of `status --porcelain=v2 --branch`, as the feature 004 branch mark that they state, without its row ID.
// The upstream keeps Git's short form.
export function statusBranchMark(out: string): object {
  const headers = new Map(out.split("\n").filter((l) => l.startsWith("# branch.")).map((l) => [l.slice(2, l.indexOf(" ", 2)), l.slice(l.indexOf(" ", 2) + 1)]));
  if (headers.get("branch.head") === "(detached)") return { state: "detached" };
  const upstream = headers.get("branch.upstream") ?? null;
  const ab = /^\+([0-9]+) -([0-9]+)$/.exec(headers.get("branch.ab") ?? "");
  const track = upstream === null ? { state: "none" } : ab === null ? { state: "gone" } : { state: "counts", ahead: Number(ab[1]), behind: Number(ab[2]) };
  return { state: "branch", ref: `refs/heads/${headers.get("branch.head")}`, upstream, track };
}

// The status header names the upstream in Git's short form. The fixtures hold no ambiguous ref name, so the short form drops the namespace (git-rev-parse(1) `--abbrev-ref`).
export const shortUpstream = <T extends { upstream?: string | null }>(m: T): T => (typeof m.upstream === "string" ? { ...m, upstream: m.upstream.replace(/^refs\/(?:heads|remotes)\//, "") } : m);

// A Git command in a tree world, with its owned global file.
export const treeGit = (w: TreeWorld, cwd: string, args: string[], allowExit = [0]) => ownedGit(gitPath(), FIXTURE_ROOT, cwd, args, { env: w.env, allowExit }).toString("utf8");

// `git config list -z` of a repository: "<key>\n<value>\0" records, as a key to values map in file order.
export function configMap(output: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const entry of output.split("\0")) {
    if (entry === "") continue;
    const nl = entry.indexOf("\n");
    const [key, value] = nl < 0 ? [entry, ""] : [entry.slice(0, nl), entry.slice(nl + 1)];
    (map[key] ??= []).push(value);
  }
  return map;
}
