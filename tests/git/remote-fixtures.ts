// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Remote fixtures of feature 003 (plan.md P0.1, tasks.md T002). Facts come from the construction, never from `src/git-service/`.
// Every builder works through a `GitHost`, so the WSL fact test (T006) builds the same fixtures with the distro Git.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { FIXED_TIMESTAMPS, FIXTURE_GLOBAL_CONFIG, FIXTURE_HOME, FIXTURE_ROOT, fixtureEnv, ownedPath } from "./fixture-root";
import { fiCommit, type FiCommit } from "./fixtures";
import { sha256, workingFileDigests } from "./git-oracle";

export interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface RunOptions {
  input?: Uint8Array;
  // An `undefined` value removes the variable.
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

// One machine with one Git. Paths use `/`. Every path lies under `root`.
export interface GitHost {
  label: string;
  root: string;
  // The files that `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_GLOBAL` name for every Git process of the host.
  systemConfig: string;
  globalConfig: string;
  run(cwd: string, args: string[], options?: RunOptions): GitResult;
  write(path: string, content: string | Uint8Array): void;
  // Null when the file does not exist.
  read(path: string): Buffer | null;
  existing(paths: string[]): string[];
  copy(from: string, to: string): void;
  // The `workingFileDigests` form of `tests/git/git-oracle.ts`.
  digests(worktree: string): Record<string, string>;
}

// Each fixture process gets the owned global and system files, no terminal prompt, and no inherited transport, proxy, editor, or locale variable.
// A proxy variable could route a 127.0.0.1 request away from the test server. The comparison ignores case.
export const SCRUBBED = ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_PROTOCOL_FROM_USER", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_MERGE_AUTOEDIT", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "LANG", "LANGUAGE", "LC_ALL", "LC_MESSAGES"];
const SHEBANG = "#!";
const isScript = (content: string | Uint8Array) => Buffer.from(content).subarray(0, 2).toString("latin1") === SHEBANG;

const slash = (p: string) => p.replaceAll("\\", "/");
const ownedSystemConfig = () => `${slash(FIXTURE_HOME)}/system.gitconfig`;

// The environment of a native fixture process. A test that serves Git from this process spawns Git asynchronously with it.
export function nativeEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env = fixtureEnv({ ...FIXED_TIMESTAMPS, GIT_CONFIG_SYSTEM: ownedSystemConfig(), GIT_TERMINAL_PROMPT: "0" });
  const drop = new Set([...SCRUBBED, ...Object.keys(extra)].map((k) => k.toUpperCase()));
  for (const key of Object.keys(env)) if (drop.has(key.toUpperCase())) delete env[key];
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

// The host of the test process. `name` is a folder under the owned fixture root.
export function nativeHost(git: string, name = "remote"): GitHost {
  const root = `${slash(FIXTURE_ROOT)}/${name}`;
  mkdirSync(root, { recursive: true });
  const system = ownedSystemConfig();
  if (!existsSync(system)) writeFileSync(system, "");
  const owned = (path: string) => ownedPath(FIXTURE_ROOT, path);
  return {
    label: "native",
    root,
    systemConfig: system,
    globalConfig: slash(FIXTURE_GLOBAL_CONFIG),
    run(cwd, args, options = {}) {
      const env = nativeEnv(options.env);
      const proc = Bun.spawnSync([git, ...args], { cwd: owned(cwd), env, stdin: options.input ?? "ignore", stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs ?? 120_000 });
      return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout, stderr: proc.stderr };
    },
    write(path, content) {
      const target = owned(path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      // Off Windows, Git starts a hook only when the file has the executable bit.
      if (isScript(content)) chmodSync(target, 0o755);
    },
    read: (path) => (existsSync(owned(path)) ? readFileSync(owned(path)) : null),
    existing: (paths) => paths.filter((p) => existsSync(owned(p))),
    copy: (from, to) => cpSync(owned(from), owned(to), { recursive: true, verbatimSymlinks: true }),
    digests: (worktree) => workingFileDigests(owned(worktree)),
  };
}

// ---- Git calls ----

export function gitRun(h: GitHost, cwd: string, args: string[], options: RunOptions & { allowExit?: number[] } = {}): GitResult {
  const result = h.run(cwd, args, options);
  if (!(options.allowExit ?? [0]).includes(result.exitCode)) throw new Error(`${h.label}: git ${args.join(" ")} in ${cwd} exited ${result.exitCode}: ${result.stderr.toString()}`);
  return result;
}

export const gitOut = (h: GitHost, cwd: string, args: string[], options: RunOptions & { allowExit?: number[] } = {}): string => gitRun(h, cwd, args, options).stdout.toString("utf8");
export const revParse = (h: GitHost, repo: string, what: string): string => gitOut(h, repo, ["rev-parse", "--verify", "-q", what]).trim();

// The `--show-object-format` hex length decides the OID width of each parse.
export function hexLength(h: GitHost, repo: string): number {
  return gitOut(h, repo, ["rev-parse", "--show-object-format"]).trim() === "sha256" ? 64 : 40;
}

// `--git-path` resolves relative to the worktree top, or to the Git folder of a bare repository.
export function gitPaths(h: GitHost, repo: string, names: string[]): string[] {
  const listed = gitOut(h, repo, ["rev-parse", ...names.flatMap((n) => ["--git-path", n])]).trimEnd().split("\n");
  return listed.map((p) => (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : `${repo}/${p}`));
}

// Git in-progress state files (Git `wt-status.c` `wt_status_get_state`), the list of `tests/git/git-oracle.ts`.
export const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "rebase-apply/applying", "sequencer", "index.lock"];

export function markers(h: GitHost, repo: string): string[] {
  const paths = gitPaths(h, repo, OPERATION_MARKERS);
  const present = new Set(h.existing(paths));
  return OPERATION_MARKERS.filter((_, i) => present.has(paths[i]!));
}

export interface StageEntry {
  mode: string;
  oid: string;
  stage: number;
  path: string;
}

// `ls-files -z --stage`: "<mode> <oid> <stage>\t<path>\0".
export function stageEntries(h: GitHost, repo: string, paths: string[] = []): StageEntry[] {
  const out = gitRun(h, repo, ["--literal-pathspecs", "ls-files", "-z", "--stage", ...(paths.length > 0 ? ["--", ...paths] : [])]).stdout.toString("utf8");
  return out.split("\0").filter((r) => r !== "").map((record) => {
    const m = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (m === null) throw new Error(`ls-files record refused: ${JSON.stringify(record)}`);
    return { mode: m[1]!, oid: m[2]!, stage: Number(m[3]), path: m[4]! };
  });
}

// `rev-list --left-right --count <a>...<b>` prints "left TAB right".
export function leftRight(h: GitHost, repo: string, a: string, b: string): [number, number] {
  const out = gitOut(h, repo, ["rev-list", "--left-right", "--count", `${a}...${b}`]).trim();
  const m = /^(\d+)\t(\d+)$/.exec(out);
  if (m === null) throw new Error(`rev-list count refused: ${JSON.stringify(out)}`);
  return [Number(m[1]), Number(m[2])];
}

// `for-each-ref --format=%(refname)%00%(objectname)` as a map.
export function refMap(h: GitHost, repo: string, patterns: string[] = []): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const line of gitOut(h, repo, ["for-each-ref", "--format=%(refname)%00%(objectname)", ...patterns]).split("\n")) {
    if (line === "") continue;
    const [name, oid] = line.split("\0");
    refs[name!] = oid!;
  }
  return refs;
}

// ---- Configuration digests (SC-006) ----

export interface ConfigFile {
  path: string;
  // Null when the file does not exist.
  sha256: string | null;
  bytes: Buffer | null;
}

export interface ConfigDigests {
  system: ConfigFile;
  global: ConfigFile;
  local: ConfigFile;
}

// The system and global files are the owned files of the host. `GIT_CONFIG_NOSYSTEM=1` keeps Git from reading the system file. The local file is `--git-path config`.
export function configDigests(h: GitHost, repo: string): ConfigDigests {
  const one = (path: string): ConfigFile => {
    const bytes = h.read(path);
    return { path, bytes, sha256: bytes === null ? null : sha256(bytes) };
  };
  return { system: one(h.systemConfig), global: one(h.globalConfig), local: one(gitPaths(h, repo, ["config"])[0]!) };
}

export const configDigestLine = (d: ConfigDigests): string => [d.system, d.global, d.local].map((f) => `${f.path}=${f.sha256 ?? "missing"}`).join(" ");

// ---- Builders ----

const EPOCH = Date.UTC(2026, 0, 1) / 1000;
let marksCounter = 0;

export type Marks = Map<number, string>;

// A commit with file modes. `null` deletes the path. A 160000 entry takes a commit OID as its content.
export interface ModeCommit extends Omit<FiCommit, "files" | "time"> {
  entries?: Record<string, [mode: string, content: string] | null>;
}

// `fiCommit` ends a commit with an optional LF. File commands must come before it, so the LF moves behind them.
export function fiModes(c: ModeCommit): Buffer {
  const head = fiCommit({ ...c, time: EPOCH + c.mark });
  const parts: Buffer[] = [head.subarray(0, head.length - 1)];
  for (const [path, entry] of Object.entries(c.entries ?? {})) {
    if (entry === null) parts.push(Buffer.from(`D ${path}\n`));
    else if (entry[0] === "160000") parts.push(Buffer.from(`M 160000 ${entry[1]} ${path}\n`));
    else {
      const data = Buffer.from(entry[1]);
      parts.push(Buffer.from(`M ${entry[0]} inline ${path}\ndata ${data.length}\n`), data, Buffer.from("\n"));
    }
  }
  parts.push(Buffer.from("\n"));
  return Buffer.concat(parts);
}

// A text commit through `fiCommit` with a fixed time per mark.
export const fc = (c: Omit<FiCommit, "time">): Buffer => fiCommit({ ...c, time: EPOCH + c.mark });
// A `fast-import` reset: the ref takes the commit of the mark.
export const fiReset = (ref: string, mark: number): Buffer => Buffer.from(`reset ${ref}\nfrom :${mark}\n\n`);

// Runs `fast-import` and returns each mark's object ID. `marksIn` holds marks of objects that the repository already has.
export function importStream(h: GitHost, repo: string, stream: Buffer[], options: { marksIn?: Marks; force?: boolean } = {}): Marks {
  const id = ++marksCounter;
  const out = `${h.root}/marks-${id}-out`;
  const args = ["fast-import", "--quiet", `--export-marks=${out}`];
  if (options.marksIn !== undefined) {
    const inFile = `${h.root}/marks-${id}-in`;
    h.write(inFile, [...options.marksIn].map(([m, oid]) => `:${m} ${oid}\n`).join(""));
    args.push(`--import-marks=${inFile}`);
  }
  if (options.force) args.push("--force");
  gitRun(h, repo, args, { input: Buffer.concat(stream), timeoutMs: 300_000 });
  const marks: Marks = new Map(options.marksIn);
  for (const line of (h.read(out) ?? Buffer.alloc(0)).toString("utf8").split("\n")) {
    const m = /^:(\d+) ([0-9a-f]+)$/.exec(line);
    if (m) marks.set(Number(m[1]), m[2]!);
  }
  return marks;
}

function initBare(h: GitHost, path: string): string {
  gitRun(h, h.root, ["init", "-q", "--bare", "-b", "main", "--", path]);
  return path;
}

// Line endings stay fixed. `core.filemode` and `core.symlinks` keep Git's default of the host.
function lineEndings(h: GitHost, repo: string): void {
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
}

function initRepo(h: GitHost, path: string): string {
  gitRun(h, h.root, ["init", "-q", "-b", "main", "--", path]);
  lineEndings(h, path);
  return path;
}

function cloneRepo(h: GitHost, from: string, to: string, extra: string[] = []): string {
  gitRun(h, h.root, ["clone", "-q", ...extra, "--", from, to], { timeoutMs: 300_000 });
  lineEndings(h, to);
  return to;
}

function updateRefs(h: GitHost, repo: string, refs: Record<string, string>): void {
  gitRun(h, repo, ["update-ref", "--stdin"], { input: Buffer.from(Object.entries(refs).map(([r, oid]) => `update ${r} ${oid}\n`).join("")) });
}

export interface Upstream {
  remote: string;
  merge: string;
}

// One write for many branches. The section syntax is git-config(1) "Syntax".
function appendUpstreams(h: GitHost, repo: string, upstreams: Record<string, Upstream>): void {
  const [path] = gitPaths(h, repo, ["config"]);
  const text = Object.entries(upstreams).map(([b, u]) => `[branch "${b}"]\n\tremote = ${u.remote}\n\tmerge = ${u.merge}\n`).join("");
  h.write(path!, Buffer.concat([h.read(path!) ?? Buffer.alloc(0), Buffer.from(text)]));
}

export function setConfig(h: GitHost, repo: string, config: readonly (readonly [string, string])[]): void {
  for (const [key, value] of config) gitRun(h, repo, ["config", "--add", key, value]);
}

const oidsOf = (marks: Marks, names: Record<string, number>) => Object.fromEntries(Object.entries(names).map(([n, m]) => [n, marks.get(m)!]));

// ---- Counts: ahead, behind, diverged, equal, no upstream, gone, slashes, unrelated ----

export const UNRELATED_COMMITS = 20_000;
export const SLASH_REMOTE = "team/up";

// Expected `rev-list --left-right --count <branch>...<upstream>` values. A control mutation of the remote side of `diverged` must turn T001 red.
export const COUNT_BRANCHES: Record<string, { upstream: string; ahead: number; behind: number }> = {
  equal: { upstream: "refs/remotes/origin/equal", ahead: 0, behind: 0 },
  ahead: { upstream: "refs/remotes/origin/ahead", ahead: 2, behind: 0 },
  behind: { upstream: "refs/remotes/origin/behind", ahead: 0, behind: 3 },
  diverged: { upstream: "refs/remotes/origin/diverged", ahead: 2, behind: 3 },
  "feature/x": { upstream: `refs/remotes/${SLASH_REMOTE}/feature/x`, ahead: 0, behind: 1 },
  unrelated: { upstream: "refs/remotes/origin/unrelated", ahead: 1, behind: UNRELATED_COMMITS },
};
// Branches without a counted upstream: none configured, a configured upstream whose ref is missing, and a remote that is not configured.
export const COUNT_UNTRACKED = { "no-upstream": null, gone: { remote: "origin", merge: "refs/heads/gone" }, "ghost-remote": { remote: "nowhere", merge: "refs/heads/main" } } as const;

export interface CountsFixture {
  remote: string;
  clone: string;
  // `refs/heads/<name>` of the remote.
  remoteOids: Record<string, string>;
  // `refs/heads/<name>` of the clone.
  localOids: Record<string, string>;
}

export function buildCounts(h: GitHost): CountsFixture {
  const remote = initBare(h, `${h.root}/counts.git`);
  const unrelated: Buffer[] = [fc({ mark: 100, ref: "refs/heads/unrelated", message: "u1\n", files: { "u.txt": "unrelated\n" } })];
  for (let i = 1; i < UNRELATED_COMMITS; i++) unrelated.push(fc({ mark: 100 + i, ref: "refs/heads/unrelated", message: `u${i + 1}\n` }));
  const marks = importStream(h, remote, [
    fc({ mark: 1, message: "base\n", files: { "base.txt": "base\n" } }),
    fiReset("refs/heads/equal", 1),
    fiReset("refs/heads/ahead", 1),
    ...[2, 3, 4].map((m) => fc({ mark: m, ref: "refs/heads/behind", message: `behind ${m}\n`, from: m === 2 ? 1 : m - 1, files: { "behind.txt": `${m}\n` } })),
    ...[5, 6, 7].map((m) => fc({ mark: m, ref: "refs/heads/diverged", message: `remote ${m}\n`, from: m === 5 ? 1 : m - 1, files: { "remote.txt": `${m}\n` } })),
    fc({ mark: 8, ref: "refs/heads/feature/x", message: "feature\n", from: 1, files: { "feature.txt": "x\n" } }),
    ...unrelated,
  ]);
  const clone = cloneRepo(h, remote, `${h.root}/counts`);
  const local = importStream(h, clone, [
    fc({ mark: 9, ref: "refs/heads/ahead", message: "local 9\n", from: 1, files: { "local.txt": "9\n" } }),
    fc({ mark: 10, ref: "refs/heads/ahead", message: "local 10\n", from: 9, files: { "local.txt": "10\n" } }),
    fc({ mark: 11, ref: "refs/heads/diverged", message: "local 11\n", from: 1, files: { "local.txt": "11\n" } }),
    fc({ mark: 12, ref: "refs/heads/diverged", message: "local 12\n", from: 11, files: { "local.txt": "12\n" } }),
    fc({ mark: 13, ref: "refs/heads/unrelated", message: "local root\n", files: { "local.txt": "root\n" } }),
  ], { marksIn: marks });
  const base = marks.get(1)!;
  updateRefs(h, clone, { "refs/heads/equal": base, "refs/heads/behind": base, "refs/heads/feature/x": base, "refs/heads/no-upstream": base, "refs/heads/gone": base, "refs/heads/ghost-remote": base });
  gitRun(h, clone, ["remote", "add", "--", SLASH_REMOTE, remote]);
  gitRun(h, clone, ["fetch", "-q", "--", SLASH_REMOTE]);
  const upstreams: Record<string, Upstream> = {};
  for (const [b, c] of Object.entries(COUNT_BRANCHES)) {
    const remoteName = c.upstream.startsWith(`refs/remotes/${SLASH_REMOTE}/`) ? SLASH_REMOTE : "origin";
    upstreams[b] = { remote: remoteName, merge: `refs/heads/${b}` };
  }
  upstreams.gone = COUNT_UNTRACKED.gone;
  upstreams["ghost-remote"] = COUNT_UNTRACKED["ghost-remote"];
  appendUpstreams(h, clone, upstreams);
  return {
    remote,
    clone,
    remoteOids: oidsOf(marks, { main: 1, equal: 1, ahead: 1, behind: 4, diverged: 7, "feature/x": 8, unrelated: 100 + UNRELATED_COMMITS - 1 }),
    localOids: { ...oidsOf(local, { main: 1, ahead: 10, diverged: 12, unrelated: 13 }), equal: base, behind: base, "feature/x": base, "no-upstream": base, gone: base, "ghost-remote": base },
  };
}

// ---- 200 branches that track 200 remote branches ----

export const MANY_BRANCHES = 200;
export const MANY_FILES = 50;
export const manyName = (i: number): string => `b${String(i).padStart(3, "0")}`;
// Even branches are equal to their upstream. Odd branches are one commit behind.
export const manyCounts = (i: number): [number, number] => (i % 2 === 0 ? [0, 0] : [0, 1]);

export interface ManyFixture {
  remote: string;
  clone: string;
  base: string;
  tip: string;
}

export function buildMany(h: GitHost): ManyFixture {
  const remote = initBare(h, `${h.root}/many.git`);
  const files = Object.fromEntries(Array.from({ length: MANY_FILES }, (_, i) => [`src/f${String(i).padStart(2, "0")}.txt`, `file ${i}\n`]));
  const marks = importStream(h, remote, [
    fc({ mark: 1, message: "base\n", files }),
    fc({ mark: 2, message: "tip\n", from: 1, files: { "src/f00.txt": "changed\n" } }),
    ...Array.from({ length: MANY_BRANCHES }, (_, i) => fiReset(`refs/heads/${manyName(i)}`, 2)),
  ]);
  const clone = cloneRepo(h, remote, `${h.root}/many`);
  const base = marks.get(1)!;
  const tip = marks.get(2)!;
  updateRefs(h, clone, Object.fromEntries(Array.from({ length: MANY_BRANCHES }, (_, i) => [`refs/heads/${manyName(i)}`, i % 2 === 0 ? tip : base])));
  appendUpstreams(h, clone, Object.fromEntries(Array.from({ length: MANY_BRANCHES }, (_, i) => [manyName(i), { remote: "origin", merge: `refs/heads/${manyName(i)}` }])));
  return { remote, clone, base, tip };
}

// ---- Merge and rebase conflicts ----

// The stage numbers of each unmerged kind (git-status(1) "Short Format").
export const KIND_STAGES = { UU: [1, 2, 3], AA: [2, 3], AU: [2], UA: [3], DU: [1, 3], UD: [1, 2], DD: [1] } as const;
export type UnmergedKind = keyof typeof KIND_STAGES;

export const MARKER_TEXT = "<<<<<<< ours\nresolved text that looks like a conflict\n=======\n>>>>>>> theirs\n";
export const FILTER_ATTRIBUTES = "filtered.txt filter=arbtest\n";

// Path to kind. In a rebase, stage 2 is the upstream side, so `du.txt` and `ud.txt` swap kinds.
export const MERGE_KINDS: Record<string, UnmergedKind> = { "uu.txt": "UU", "aa.txt": "AA", "du.txt": "DU", "ud.txt": "UD", link: "UU", "exec.sh": "UU", "filtered.txt": "UU", "au.txt": "AU", "ua.txt": "UA", "dd.txt": "DD" };
export const REBASE_KINDS: Record<string, UnmergedKind> = { ...MERGE_KINDS, "du.txt": "UD", "ud.txt": "DU" };
// Kinds without a merge strategy case of their own get their stages through `update-index --index-info`.
const SYNTHETIC: Record<string, { stage: number; content: string; working: boolean }> = {
  "au.txt": { stage: 2, content: "added by us\n", working: true },
  "ua.txt": { stage: 3, content: "added by them\n", working: true },
  "dd.txt": { stage: 1, content: "base\n", working: false },
};

export interface ConflictFixture {
  repo: string;
  kinds: Record<string, UnmergedKind>;
  // The resolved stage-0 path with conflict-marker-like text.
  resolvedPath: string;
}

function conflictHistory(h: GitHost, repo: string): void {
  importStream(h, repo, [
    fiModes({ mark: 1, message: "base\n", entries: { ".gitattributes": ["100644", FILTER_ATTRIBUTES], "uu.txt": ["100644", "base\n"], "du.txt": ["100644", "base\n"], "ud.txt": ["100644", "base\n"], link: ["120000", "target-base"], "exec.sh": ["100644", "base\n"], "filtered.txt": ["100644", "base\n"], "resolved.txt": ["100644", "base\n"] } }),
    fiModes({ mark: 2, message: "ours\n", from: 1, entries: { "uu.txt": ["100644", "ours\n"], "aa.txt": ["100644", "ours\n"], "du.txt": null, "ud.txt": ["100644", "ours\n"], link: ["120000", "target-ours"], "exec.sh": ["100755", "ours\n"], "filtered.txt": ["100644", "ours\n"], "resolved.txt": ["100644", "ours\n"] } }),
    fiModes({ mark: 3, ref: "refs/heads/theirs", message: "theirs\n", from: 1, entries: { "uu.txt": ["100644", "theirs\n"], "aa.txt": ["100644", "theirs\n"], "du.txt": ["100644", "theirs\n"], "ud.txt": null, link: ["120000", "target-theirs"], "exec.sh": ["100644", "theirs\n"], "filtered.txt": ["100644", "theirs\n"], "resolved.txt": ["100644", "theirs\n"] } }),
  ]);
  gitRun(h, repo, ["config", "filter.arbtest.clean", "cat"]);
  gitRun(h, repo, ["config", "filter.arbtest.smudge", "cat"]);
  gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
}

function finishConflict(h: GitHost, repo: string): void {
  h.write(`${repo}/resolved.txt`, MARKER_TEXT);
  gitRun(h, repo, ["--literal-pathspecs", "add", "--", "resolved.txt"]);
  const records: Buffer[] = [];
  for (const [path, s] of Object.entries(SYNTHETIC)) {
    const oid = gitOut(h, repo, ["hash-object", "-w", "--stdin"], { input: Buffer.from(s.content) }).trim();
    records.push(Buffer.from(`100644 ${oid} ${s.stage}\t${path}\0`));
    if (s.working) h.write(`${repo}/${path}`, s.content);
  }
  gitRun(h, repo, ["update-index", "-z", "--index-info"], { input: Buffer.concat(records) });
}

// `main` holds "ours"; `merge theirs` stops with MERGE_HEAD.
export function buildMergeConflict(h: GitHost, name = "merge-conflict"): ConflictFixture {
  const repo = initRepo(h, `${h.root}/${name}`);
  conflictHistory(h, repo);
  gitRun(h, repo, ["merge", "--no-edit", "theirs"], { allowExit: [1] });
  finishConflict(h, repo);
  return { repo, kinds: MERGE_KINDS, resolvedPath: "resolved.txt" };
}

// `main` holds "ours"; `rebase theirs` stops on its only step with rebase-merge.
export function buildRebaseConflict(h: GitHost, name = "rebase-conflict"): ConflictFixture {
  const repo = initRepo(h, `${h.root}/${name}`);
  conflictHistory(h, repo);
  gitRun(h, repo, ["rebase", "theirs"], { allowExit: [1] });
  finishConflict(h, repo);
  return { repo, kinds: REBASE_KINDS, resolvedPath: "resolved.txt" };
}

// ---- Rebase skip (fact l) ----

export interface RebaseSkipFixture {
  // The next step applies cleanly.
  clean: string;
  // The next step stops on `c.txt`.
  stops: string;
  // The `up` tip, which the rebase starts from.
  upstream: string;
}

export function buildRebaseSkip(h: GitHost): RebaseSkipFixture {
  const build = (name: string, secondConflicts: boolean): [string, string] => {
    const repo = initRepo(h, `${h.root}/${name}`);
    const marks = importStream(h, repo, [
      fc({ mark: 1, message: "base\n", files: { "a.txt": "base\n", "c.txt": "base\n" } }),
      fc({ mark: 2, ref: "refs/heads/up", message: "up\n", from: 1, files: { "a.txt": "up\n", "c.txt": "up\n" } }),
      fc({ mark: 3, message: "step a\n", from: 1, files: { "a.txt": "topic\n" } }),
      fc({ mark: 4, message: "step b\n", from: 3, files: secondConflicts ? { "c.txt": "topic\n" } : { "b.txt": "topic\n" } }),
    ]);
    gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
    gitRun(h, repo, ["rebase", "up"], { allowExit: [1] });
    return [repo, marks.get(2)!];
  };
  const [clean, upstream] = build("rebase-skip-clean", false);
  const [stops] = build("rebase-skip-stops", true);
  return { clean, stops, upstream };
}

// ---- Remote hooks ----

export const ESC_MESSAGE = "\u001b[31mremote message\u001b[0m";

export interface HookFixture {
  // `pre-receive` exits 1.
  refuse: string;
  // `pre-receive` prints ESC sequences on stderr and exits 0.
  esc: string;
}

export function buildHooks(h: GitHost): HookFixture {
  const refuse = initBare(h, `${h.root}/refuse.git`);
  h.write(`${refuse}/hooks/pre-receive`, "#!/bin/sh\nexit 1\n");
  const esc = initBare(h, `${h.root}/esc.git`);
  h.write(`${esc}/hooks/pre-receive`, "#!/bin/sh\nprintf '\\033[31mremote message\\033[0m\\n' >&2\nexit 0\n");
  return { refuse, esc };
}

// ---- Push destination matrix (plan.md D4) ----

export interface PushVariant {
  name: string;
  branch: "topic" | "renamed" | "noup";
  config: readonly (readonly [string, string])[];
}

export const PUSH_DEFAULTS = ["simple", "unset", "current", "matching", "upstream", "tracking", "nothing", "bogus"] as const;
const PUSH_BRANCHES = ["topic", "renamed", "noup"] as const;

// `topic` tracks `origin/topic`. `renamed` tracks `origin/other-name`. `noup` has no upstream.
export const PUSH_VARIANTS: PushVariant[] = [
  ...PUSH_DEFAULTS.flatMap((value) => PUSH_BRANCHES.map((branch): PushVariant => ({ name: `push.default=${value}/${branch}`, branch, config: value === "unset" ? [] : [["push.default", value]] }))),
  { name: "remote.origin.push/renamed", branch: "renamed", config: [["remote.origin.push", "refs/heads/renamed:refs/heads/mapped"]] },
  { name: "branch.pushRemote/topic", branch: "topic", config: [["branch.topic.pushRemote", "second"]] },
  { name: "remote.pushDefault/topic", branch: "topic", config: [["remote.pushDefault", "second"]] },
  { name: "two-push-urls/topic", branch: "topic", config: [["remote.origin.pushurl", "{origin}"], ["remote.origin.pushurl", "{second}"]] },
  { name: "mirror/topic", branch: "topic", config: [["remote.mirror.url", "{second}"], ["remote.mirror.mirror", "true"], ["branch.topic.pushRemote", "mirror"]] },
  { name: "unconfigured-push-remote/topic", branch: "topic", config: [["branch.topic.pushRemote", "nowhere"]] },
];

export interface PushFixture {
  origin: string;
  second: string;
  clone: string;
}

export function buildPush(h: GitHost): PushFixture {
  const origin = initBare(h, `${h.root}/push-origin.git`);
  const marks = importStream(h, origin, [fc({ mark: 1, message: "base\n", files: { "base.txt": "base\n" } }), fiReset("refs/heads/topic", 1), fiReset("refs/heads/other-name", 1)]);
  const second = initBare(h, `${h.root}/push-second.git`);
  const clone = cloneRepo(h, origin, `${h.root}/push`);
  gitRun(h, clone, ["remote", "add", "second", second]);
  importStream(h, clone, PUSH_BRANCHES.map((b, i) => fc({ mark: 10 + i, ref: `refs/heads/${b}`, message: `${b}\n`, from: 1, files: { [`${b}.txt`]: `${b}\n` } })), { marksIn: marks });
  appendUpstreams(h, clone, { topic: { remote: "origin", merge: "refs/heads/topic" }, renamed: { remote: "origin", merge: "refs/heads/other-name" } });
  return { origin, second, clone };
}

// A copy of the push clone with the variant's configuration and its branch checked out.
export function pushVariant(h: GitHost, f: PushFixture, v: PushVariant, to: string): string {
  h.copy(f.clone, to);
  // An invalid `push.default` makes most commands die, so the checkout runs first.
  gitRun(h, to, ["checkout", "-q", v.branch]);
  const fill = (value: string) => value.replace("{origin}", f.origin).replace("{second}", f.second);
  setConfig(h, to, v.config.map(([k, value]) => [k, fill(value)] as const));
  return to;
}

// ---- Partial clone, gitlink move, submodule, empty remote ----

export function buildPartialClone(h: GitHost): { origin: string; clone: string } {
  const origin = initBare(h, `${h.root}/partial-origin.git`);
  importStream(h, origin, [fc({ mark: 1, message: "base\n", files: { "a.txt": "a\n", "b.txt": "b\n" } })]);
  gitRun(h, origin, ["config", "uploadpack.allowFilter", "true"]);
  // A local path clone ignores `--filter`; `--no-local` uses the transport.
  const clone = cloneRepo(h, origin, `${h.root}/partial`, ["--no-local", "--filter=blob:none"]);
  return { origin, clone };
}

export interface SubmoduleFixture {
  sub: string;
  superRemote: string;
  // The superproject clone. It is one commit behind; the remote commit moves the gitlink from `s1` to `s2`.
  clone: string;
  s1: string;
  s2: string;
  c1: string;
  c2: string;
}

export function buildSubmodule(h: GitHost): SubmoduleFixture {
  const sub = initBare(h, `${h.root}/sub.git`);
  const s = importStream(h, sub, [fc({ mark: 1, message: "s1\n", files: { "s.txt": "1\n" } }), fc({ mark: 2, message: "s2\n", from: 1, files: { "s.txt": "2\n" } })]);
  const superRemote = initBare(h, `${h.root}/super.git`);
  const gitmodules = `[submodule "sub"]\n\tpath = sub\n\turl = ${sub}\n`;
  const c = importStream(h, superRemote, [
    fiModes({ mark: 1, message: "c1\n", entries: { ".gitmodules": ["100644", gitmodules], sub: ["160000", s.get(1)!] } }),
    fiModes({ mark: 2, message: "c2\n", from: 1, entries: { sub: ["160000", s.get(2)!] } }),
  ]);
  const clone = cloneRepo(h, superRemote, `${h.root}/super`);
  gitRun(h, clone, ["reset", "-q", "--hard", c.get(1)!]);
  // A plain clone and `submodule init` need no `protocol.file.allow`, which the tests never set (plan.md D14).
  cloneRepo(h, sub, `${clone}/sub`);
  gitRun(h, `${clone}/sub`, ["checkout", "-q", "--detach", s.get(1)!]);
  gitRun(h, clone, ["submodule", "init"]);
  return { sub, superRemote, clone, s1: s.get(1)!, s2: s.get(2)!, c1: c.get(1)!, c2: c.get(2)! };
}

export const buildEmptyRemote = (h: GitHost): string => initBare(h, `${h.root}/empty.git`);

// ---- Credentials ----

export const HTTP_USER = "arbareto-user";
export const HTTP_PASSWORD = "arbareto-secret-3e7f";

// A `credential.helper` value. Git runs a value that starts with `!` as a shell snippet (gitcredentials(7) "Custom Helpers").
export const credentialHelper = (user: string, password: string): string => `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' '${user}' '${password}'; }; f`;

// `http://user:password@host/...` for the fixture URL with a credential.
export function urlWithCredential(url: string, user = HTTP_USER, password = HTTP_PASSWORD): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

// A bare remote that the HTTP helper serves, and a clone whose `origin` URL holds the credential.
export function buildCredentialRemote(h: GitHost, project: string): string {
  const remote = initBare(h, `${project}/cred.git`);
  importStream(h, remote, [fc({ mark: 1, message: "base\n", files: { "a.txt": "a\n" } })]);
  return remote;
}

// ---- Autostash and pull matrix ----

export interface AutostashFixture {
  origin: string;
  clone: string;
}

// Diverged by one commit on each side, with a modified working file.
export function buildAutostash(h: GitHost): AutostashFixture {
  const origin = initBare(h, `${h.root}/stash-origin.git`);
  const marks = importStream(h, origin, [fc({ mark: 1, message: "base\n", files: { "base.txt": "base\n" } })]);
  const clone = cloneRepo(h, origin, `${h.root}/stash`);
  importStream(h, origin, [fc({ mark: 2, message: "remote\n", from: 1, files: { "remote.txt": "r\n" } })], { marksIn: marks });
  importStream(h, clone, [fc({ mark: 3, message: "local\n", from: 1, files: { "local.txt": "l\n" } })], { marksIn: marks });
  gitRun(h, clone, ["reset", "-q", "--hard", "main"]);
  gitRun(h, clone, ["fetch", "-q", "origin"]);
  h.write(`${clone}/base.txt`, "dirty\n");
  setConfig(h, clone, [["rebase.autoStash", "true"], ["merge.autoStash", "true"]]);
  return { origin, clone };
}

export type PullDecision = "up-to-date" | "fast-forward" | "merge" | "merge-ff" | "merge-no-ff" | "rebase" | "rebase-merges" | "refuse:ff-only" | "refuse:mode-required" | "refuse:interactive-rebase";

export interface PullRow {
  name: string;
  branch: "p-equal" | "p-behind" | "p-diverged" | "rewrite";
  config: readonly (readonly [string, string])[];
  payload?: "merge" | "rebase";
  // The data-model §6 result.
  expect: PullDecision;
}

// data-model §6 rows. The `rewrite` row has an upstream that dropped the commit under the local branch, so only a fork-point rebase drops it too.
export const PULL_ROWS: PullRow[] = [
  { name: "equal", branch: "p-equal", config: [], expect: "up-to-date" },
  { name: "behind ff=false rebase=true", branch: "p-behind", config: [["pull.ff", "false"], ["pull.rebase", "true"]], expect: "fast-forward" },
  { name: "behind ff=false", branch: "p-behind", config: [["pull.ff", "false"]], expect: "merge-no-ff" },
  { name: "behind payload-merge ff=false", branch: "p-behind", config: [["pull.ff", "false"]], payload: "merge", expect: "merge-no-ff" },
  { name: "behind", branch: "p-behind", config: [], expect: "merge" },
  { name: "behind ff=only", branch: "p-behind", config: [["pull.ff", "only"]], expect: "fast-forward" },
  { name: "behind merge.ff=false", branch: "p-behind", config: [["merge.ff", "false"]], expect: "merge" },
  { name: "behind payload-merge merge.ff=false", branch: "p-behind", config: [["merge.ff", "false"]], payload: "merge", expect: "merge" },
  { name: "behind rebase=true merge.ff=false", branch: "p-behind", config: [["merge.ff", "false"], ["pull.rebase", "true"]], expect: "fast-forward" },
  { name: "behind ff=true merge.ff=false", branch: "p-behind", config: [["merge.ff", "false"], ["pull.ff", "true"]], expect: "fast-forward" },
  { name: "diverged ff=only rebase=true", branch: "p-diverged", config: [["pull.ff", "only"], ["pull.rebase", "true"]], expect: "refuse:ff-only" },
  { name: "diverged ff=only", branch: "p-diverged", config: [["pull.ff", "only"]], expect: "refuse:ff-only" },
  { name: "diverged ff=only payload-rebase", branch: "p-diverged", config: [["pull.ff", "only"]], payload: "rebase", expect: "rebase" },
  { name: "diverged ff=only payload-merge", branch: "p-diverged", config: [["pull.ff", "only"]], payload: "merge", expect: "merge-ff" },
  { name: "diverged unset", branch: "p-diverged", config: [], expect: "refuse:mode-required" },
  { name: "diverged rebase=true", branch: "p-diverged", config: [["pull.rebase", "true"]], expect: "rebase" },
  { name: "diverged rebase=merges", branch: "p-diverged", config: [["pull.rebase", "merges"]], expect: "rebase-merges" },
  { name: "diverged branch.rebase=true over pull.rebase=false", branch: "p-diverged", config: [["pull.rebase", "false"], ["branch.p-diverged.rebase", "true"]], expect: "rebase" },
  { name: "diverged rebase=interactive", branch: "p-diverged", config: [["pull.rebase", "interactive"]], expect: "refuse:interactive-rebase" },
  { name: "diverged ff=true", branch: "p-diverged", config: [["pull.ff", "true"]], expect: "merge-ff" },
  { name: "diverged ff=false", branch: "p-diverged", config: [["pull.ff", "false"]], expect: "merge-no-ff" },
  { name: "diverged rebase=false", branch: "p-diverged", config: [["pull.rebase", "false"]], expect: "merge" },
  { name: "diverged payload-merge", branch: "p-diverged", config: [], payload: "merge", expect: "merge" },
  { name: "diverged payload-rebase", branch: "p-diverged", config: [], payload: "rebase", expect: "rebase" },
  { name: "fork-point payload-rebase", branch: "rewrite", config: [], payload: "rebase", expect: "rebase" },
];

export interface PullFixture {
  origin: string;
  clone: string;
  // The commit that the remote dropped from `rewrite`.
  dropped: string;
}

export function buildPull(h: GitHost): PullFixture {
  const origin = initBare(h, `${h.root}/pull-origin.git`);
  const marks = importStream(h, origin, [
    fc({ mark: 1, message: "base\n", files: { "base.txt": "base\n" } }),
    fiReset("refs/heads/p-equal", 1),
    fc({ mark: 2, ref: "refs/heads/p-behind", message: "remote behind\n", from: 1, files: { "remote.txt": "behind\n" } }),
    fc({ mark: 3, ref: "refs/heads/p-diverged", message: "remote diverged\n", from: 1, files: { "remote.txt": "diverged\n" } }),
    fc({ mark: 4, ref: "refs/heads/rewrite", message: "dropped\n", from: 1, files: { "x.txt": "x\n" } }),
  ]);
  const clone = cloneRepo(h, origin, `${h.root}/pull`);
  importStream(h, clone, [
    fc({ mark: 5, ref: "refs/heads/p-diverged", message: "local diverged\n", from: 1, files: { "local.txt": "l\n" } }),
    fc({ mark: 6, ref: "refs/heads/rewrite", message: "local on dropped\n", from: 4, files: { "local.txt": "r\n" } }),
  ], { marksIn: marks });
  updateRefs(h, clone, { "refs/heads/p-equal": marks.get(1)!, "refs/heads/p-behind": marks.get(1)! });
  appendUpstreams(h, clone, Object.fromEntries(["p-equal", "p-behind", "p-diverged", "rewrite"].map((b) => [b, { remote: "origin", merge: `refs/heads/${b}` }])));
  // The clone's reflog of `origin/rewrite` keeps the dropped commit, which `merge-base --fork-point` reads.
  importStream(h, origin, [fc({ mark: 7, ref: "refs/heads/rewrite", message: "rewritten\n", from: 1, files: { "y.txt": "y\n" } })], { marksIn: marks, force: true });
  return { origin, clone, dropped: marks.get(4)! };
}

// A copy of the pull clone with the row's configuration and branch.
export function pullRowCopy(h: GitHost, f: PullFixture, row: PullRow, to: string): string {
  h.copy(f.clone, to);
  setConfig(h, to, row.config);
  gitRun(h, to, ["checkout", "-q", row.branch]);
  return to;
}

// ---- Fetch flags (fact a) and fetch all (fact k) ----

export interface FetchFlagsFixture {
  origin: string;
  // Cloned before the remote changes, so a fetch shows each flag.
  clone: string;
}

export function buildFetchFlags(h: GitHost): FetchFlagsFixture {
  const origin = initBare(h, `${h.root}/flags-origin.git`);
  const marks = importStream(h, origin, [
    fc({ mark: 1, message: "base\n", files: { "base.txt": "base\n" } }),
    fiReset("refs/heads/ff", 1),
    fiReset("refs/heads/gone-soon", 1),
    fc({ mark: 2, ref: "refs/heads/forced", message: "forced old\n", from: 1, files: { "f.txt": "old\n" } }),
    fc({ mark: 3, ref: "refs/heads/rewound", message: "rewound old\n", from: 1, files: { "r.txt": "old\n" } }),
    fiReset("refs/tags/t1", 1),
  ]);
  const clone = cloneRepo(h, origin, `${h.root}/flags`);
  importStream(h, origin, [
    fc({ mark: 4, ref: "refs/heads/ff", message: "ff\n", from: 1, files: { "ff.txt": "new\n" } }),
    fc({ mark: 5, ref: "refs/heads/forced", message: "forced new\n", from: 1, files: { "f.txt": "new\n" } }),
    fc({ mark: 6, ref: "refs/heads/rewound", message: "rewound new\n", from: 1, files: { "r.txt": "new\n" } }),
    fc({ mark: 7, ref: "refs/heads/new", message: "new\n", from: 1, files: { "n.txt": "new\n" } }),
    fiReset("refs/tags/t1", 4),
  ], { marksIn: marks, force: true });
  gitRun(h, origin, ["update-ref", "-d", "refs/heads/gone-soon"]);
  return { origin, clone };
}

// Remote name to its configuration, in `git remote` order. `remote.<name>.skipDefaultUpdate` is the older name (git-config(1)).
export const FETCH_ALL_REMOTES: Record<string, readonly (readonly [string, string])[]> = {
  r1: [],
  r2: [["skipFetchAll", "true"]],
  r3: [["skipDefaultUpdate", "true"]],
  r4: [["skipFetchAll", "false"], ["skipDefaultUpdate", "true"]],
  r5: [["skipDefaultUpdate", "true"], ["skipFetchAll", "false"]],
};

export function buildFetchAll(h: GitHost): string {
  const repo = initRepo(h, `${h.root}/fetch-all`);
  for (const [name, config] of Object.entries(FETCH_ALL_REMOTES)) {
    const bare = initBare(h, `${h.root}/fetch-all-${name}.git`);
    importStream(h, bare, [fc({ mark: 1, message: `${name}\n`, files: { [`${name}.txt`]: `${name}\n` } })]);
    gitRun(h, repo, ["remote", "add", name, bare]);
    setConfig(h, repo, config.map(([k, v]) => [`remote.${name}.${k}`, v] as const));
  }
  return repo;
}
