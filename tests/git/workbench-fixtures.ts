// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The feature 004 fixtures of plan.md P0.1 (tasks.md T002). Facts come from the construction, never from `src/git-service/`.
// A fact test uses a second build as its copy. The T001 self-check proves that two builds give equal refs, trees, and configuration digests.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, builderDigest, PERF_CACHE_ROOT, perfReuseState, type PerfReuseState } from "../windows/perf-fixtures";
import { FIXED_TIMESTAMPS, FIXTURE_GLOBAL_CONFIG, FIXTURE_HOME, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedPath, removeTree } from "./fixture-root";
import { fiCommit, put } from "./fixtures";
import { sha256 } from "./git-oracle";

// An `undefined` value removes the variable.
export type Env = Record<string, string | undefined>;

export interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface GitOptions {
  input?: string | Uint8Array;
  env?: Env;
  allowExit?: readonly number[] | "any";
  timeoutMs?: number;
}

const GIT_TIMEOUT_MS = 120_000;
// Variables of the test process that can start an editor, a prompt, or another transport. The comparison ignores case.
const SCRUBBED = ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_MERGE_AUTOEDIT", "GIT_PAGER", "GIT_SSH", "GIT_SSH_COMMAND", "EDITOR", "VISUAL"];

// `fixtureEnv` with the fixed dates, no terminal prompt, and the editor `:` of the plan.md D2 `integrate` policy.
function wbEnv(extra: Env = {}): Record<string, string> {
  const env = fixtureEnv({ ...FIXED_TIMESTAMPS, GIT_TERMINAL_PROMPT: "0" });
  const drop = new Set([...SCRUBBED, ...Object.keys(extra)].map((k) => k.toUpperCase()));
  for (const key of Object.keys(env)) if (drop.has(key.toUpperCase())) delete env[key];
  env.GIT_EDITOR = ":";
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

// One Git process with a working directory under `root`. Bun ends the process after `timeoutMs`; the exit code is then -1.
function gitRun(git: string, cwd: string, args: readonly string[], o: GitOptions & { root?: string } = {}): GitResult {
  const proc = Bun.spawnSync([git, ...args], {
    cwd: ownedPath(o.root ?? FIXTURE_ROOT, cwd),
    env: wbEnv(o.env),
    stdin: o.input === undefined ? "ignore" : Buffer.from(o.input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: o.timeoutMs ?? GIT_TIMEOUT_MS,
  });
  const result = { exitCode: proc.exitCode ?? -1, stdout: proc.stdout, stderr: proc.stderr };
  const allow = o.allowExit ?? [0];
  if (allow !== "any" && !allow.includes(result.exitCode)) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${result.exitCode}: ${proc.stderr.toString()}`);
  return result;
}

export interface WbRepo {
  git: string;
  dir: string;
  env: Env;
  root?: string;
}

export const wb = (r: WbRepo, args: readonly string[], o: GitOptions = {}): GitResult => gitRun(r.git, r.dir, args, { ...o, root: r.root, env: { ...r.env, ...o.env } });
const out = (r: WbRepo, args: readonly string[]) => wb(r, args).stdout.toString("utf8");

export interface WbFixture {
  name: string;
  git: string;
  root: string;
  // The main worktree.
  repo: string;
  // Every Git process of this fixture adds these variables.
  env: Env;
  // Commit labels of the construction.
  oids: Record<string, string>;
  // Every ref that the construction wrote, with its value.
  refs: Record<string, string>;
  // Configuration files by label, and their SHA-256 at the end of the build.
  configs: Record<string, string>;
  digests: Record<string, string>;
}

export const repoOf = (f: WbFixture, dir = f.repo): WbRepo => ({ git: f.git, dir, env: f.env, root: f.root.startsWith(PERF_CACHE_ROOT) ? PERF_CACHE_ROOT : undefined });

const slash = (p: string) => p.replaceAll("\\", "/");
const full = (ref: string) => (ref.startsWith("refs/") ? ref : `refs/heads/${ref}`);
const FIXED_EPOCH = Date.UTC(2026, 0, 1) / 1000;
const lines = (from: number, to: number, f: (n: number) => string) => Array.from({ length: to - from + 1 }, (_, i) => f(from + i)).join("");

// ---- Construction steps ----

// The line-ending keys and `core.filemode` of `tests/git/fixtures.ts` `lineEndings`.
const LINE_ENDINGS: [string, string][] = [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"], ["core.filemode", "false"]];

function init(git: string, dir: string, env: Env = {}, keys = LINE_ENDINGS, root?: string): WbRepo {
  mkdirSync(dir, { recursive: true });
  const r: WbRepo = { git, dir, env, root };
  wb(r, ["init", "-q", "-b", "main"]);
  for (const [key, value] of keys) wb(r, ["config", key, value]);
  return r;
}

interface Commit {
  label: string;
  ref: string;
  from?: string;
  merge?: string[];
  message?: string;
  files?: Record<string, string>;
  deletes?: string[];
  // Path to link target. Git stores mode 120000.
  links?: Record<string, string>;
}
type Step = Commit | { reset: string; at: string };

const inline = (content: string) => {
  const b = Buffer.from(content);
  return Buffer.concat([Buffer.from(`data ${b.length}\n`), b, Buffer.from("\n")]);
};

interface History {
  oids: Record<string, string>;
  refs: Record<string, string>;
}

// Imports the steps with `git fast-import`, then checks out `head`. Each commit gets its own fixed time.
function history(r: WbRepo, steps: Step[], head: string): History {
  const marks = new Map<string, number>();
  const at = (label: string) => {
    const mark = marks.get(label);
    if (mark === undefined) throw new Error(`unknown commit label ${label}`);
    return mark;
  };
  const parts: Buffer[] = [];
  for (const s of steps) {
    if ("reset" in s) {
      parts.push(Buffer.from(`reset ${full(s.reset)}\nfrom :${at(s.at)}\n\n`));
      continue;
    }
    const mark = marks.size + 1;
    const base = fiCommit({ mark, ref: full(s.ref), time: FIXED_EPOCH + mark * 60, message: `${s.message ?? s.label}\n`, from: s.from === undefined ? undefined : at(s.from), merge: s.merge?.map(at), files: s.files });
    const extra = [...(s.deletes ?? []).map((p) => Buffer.from(`D ${p}\n`)), ...Object.entries(s.links ?? {}).flatMap(([p, target]) => [Buffer.from(`M 120000 inline ${p}\n`), inline(target)])];
    // `fiCommit` ends each command with one optional LF, so the extra file commands go before it.
    parts.push(extra.length === 0 ? base : Buffer.concat([base.subarray(0, -1), ...extra, Buffer.from("\n")]));
    marks.set(s.label, mark);
  }
  const marksFile = join(r.dir, ".git", "arbareto-marks");
  wb(r, ["fast-import", "--quiet", `--export-marks=${marksFile}`], { input: Buffer.concat(parts) });
  const byMark = new Map(readFileSync(marksFile, "utf8").trim().split("\n").map((l) => [Number(l.slice(1, l.indexOf(" "))), l.slice(l.indexOf(" ") + 1)] as const));
  rmSync(marksFile);
  const oids = Object.fromEntries([...marks].map(([label, mark]) => [label, byMark.get(mark)!]));
  const refs: Record<string, string> = {};
  for (const s of steps) refs["reset" in s ? full(s.reset) : full(s.ref)] = "reset" in s ? oids[s.at]! : oids[s.label]!;
  wb(r, ["symbolic-ref", "HEAD", full(head)]);
  wb(r, ["reset", "-q", "--hard"]);
  return { oids, refs };
}

const writeFile = (r: WbRepo, rel: string, content: string) => put(r.dir, rel, content);
const appendConfig = (r: WbRepo, text: string) => appendFileSync(join(r.dir, ".git", "config"), text);
const remote = (name: string, ...fetch: string[]) => `[remote "${name}"]\n\turl = https://host.invalid/${name}.git\n${fetch.map((f) => `\tfetch = ${f}\n`).join("")}`;

// A POSIX shell canary under the fixture folder. Git runs it through its shell, so the path uses `/`. Each run appends one line to `log`.
export function canary(root: string, name: string, tail = ""): { command: string; log: string } {
  const log = join(root, "canaries", `${name}.log`);
  const script = put(root, `canaries/${name}.sh`, `#!/bin/sh\necho "${name} $*" >> '${slash(log)}'\n${tail}`);
  return { command: `'${slash(script)}'`, log };
}

// quickstart.md "Prerequisites": the fixture merge tool. Git's mergetool script evaluates the `cmd` value in its shell.
export const FIXTURE_MERGE_RESULT = "fixture merge result\n";
export const FIXTURE_MERGE_TOOL = join(FIXTURE_HOME, "fixture-merge-tool.sh");

function installMergeTool(git: string): void {
  if (existsSync(FIXTURE_MERGE_TOOL)) return;
  put(FIXTURE_HOME, "fixture-merge-tool.sh", `#!/bin/sh\nprintf '${FIXTURE_MERGE_RESULT.replace("\n", "\\n")}' > "$1"\n`);
  gitRun(git, FIXTURE_HOME, ["config", "--global", "mergetool.fixture.cmd", `'${slash(FIXTURE_MERGE_TOOL)}' "$MERGED"`]);
}

function start(git: string, name: string): { root: string; r: WbRepo } {
  installMergeTool(git);
  const root = fixtureDir(name);
  return { root, r: init(git, join(root, "repo")) };
}

function finish(name: string, root: string, r: WbRepo, h: History, configs: Record<string, string> = {}): WbFixture {
  const files = { local: join(r.dir, ".git", "config"), global: FIXTURE_GLOBAL_CONFIG, ...configs };
  const digests = Object.fromEntries(Object.entries(files).map(([label, path]) => [label, existsSync(path) ? sha256(readFileSync(path)) : "absent"]));
  return { name, git: r.git, root, repo: r.dir, env: r.env, oids: h.oids, refs: h.refs, configs: files, digests };
}

// ---- Branch fixtures ----

function buildBranches(git: string, name: string): WbFixture {
  const { root, r } = start(git, name);
  const h = history(r, [
    { label: "base", ref: "main", files: { "a.txt": "a\n" } },
    { label: "second", ref: "main", from: "base", files: { "b.txt": "b\n" } },
    { label: "tagged", ref: "unmerged", from: "second", files: { "u.txt": "u1\n" } },
    { label: "main", ref: "main", from: "second", files: { "c.txt": "c\n" } },
    { label: "unmerged-1", ref: "unmerged", from: "tagged", files: { "u.txt": "u2\n" } },
    { label: "unmerged", ref: "unmerged", from: "unmerged-1", files: { "u.txt": "u3\n" } },
    { label: "held", ref: "held", from: "base", files: { "h.txt": "h\n" } },
    { label: "slash", ref: "feature/a/b", from: "main", files: { "s.txt": "s\n" } },
    { label: "wt-held", ref: "wt-held", from: "main", files: { "w.txt": "w\n" } },
    { reset: "merged", at: "second" },
    { reset: "refs/tags/v1", at: "tagged" },
    { reset: "refs/remotes/origin/held", at: "held" },
  ], "main");
  // fast-import writes no reflog. Two moves give `refs/heads/unmerged` a reflog that `branch -D` removes (research.md R5).
  wb(r, ["update-ref", "-m", "fixture: back", "refs/heads/unmerged", h.oids["unmerged-1"]!, h.oids.unmerged!]);
  wb(r, ["update-ref", "-m", "fixture: tip", "refs/heads/unmerged", h.oids.unmerged!, h.oids["unmerged-1"]!]);
  h.oids.unreachable = out(r, ["commit-tree", "-p", h.oids.main!, "-m", "unreachable", `${h.oids.main}^{tree}`]).trim();
  appendConfig(r, `${remote("origin", "+refs/heads/*:refs/remotes/origin/*")}[branch "unmerged"]\n\tremote = origin\n\tmerge = refs/heads/unmerged\n`);
  const other = join(root, "wt-other");
  const detached = join(root, "wt-detached");
  wb(r, ["worktree", "add", "-q", "--", other, "wt-held"]);
  wb(r, ["worktree", "add", "-q", "--detach", "--", detached, h.oids.unreachable]);
  return finish(name, root, r, h);
}

// ---- Switch fixtures ----

type SwitchVariant = "clean" | "dirty" | "conflict" | "untracked" | "ignored" | "folder";

function buildSwitch(git: string, name: string, variant: SwitchVariant): WbFixture {
  const { root, r } = start(git, name);
  const h = history(r, [
    { label: "base", ref: "main", files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n", "e.txt": "e\n", ".gitignore": "*.log\n" } },
    { label: "target", ref: "target", from: "base", files: { "a.txt": "a target\n", "new.txt": "new target\n", "build.log": "log target\n", dirfile: "dirfile target\n", "sub/x.txt": "x target\n" } },
    { reset: "refs/remotes/one/topic", at: "target" },
    { reset: "refs/remotes/zero/topic", at: "target" },
    { reset: "refs/remotes/two/x/topic", at: "target" },
  ], "main");
  // One, zero, and two fetch refspecs map each remote-tracking ref back to a `refs/heads/` source (research.md R2).
  appendConfig(r, remote("one", "+refs/heads/*:refs/remotes/one/*") + remote("zero", "+refs/heads/main:refs/remotes/zero/main") + remote("two", "+refs/heads/*:refs/remotes/two/*", "+refs/heads/x/*:refs/remotes/two/x/*"));
  if (variant === "dirty") {
    writeFile(r, "b.txt", "b changed\n");
    writeFile(r, "c.txt", "c staged\n");
    writeFile(r, "e.txt", "e staged\n");
    wb(r, ["add", "--", "c.txt", "e.txt"]);
    writeFile(r, "e.txt", "e staged and changed\n");
    rmSync(join(r.dir, "d.txt"));
    writeFile(r, "notes.txt", "notes\n");
  }
  if (variant === "conflict") writeFile(r, "a.txt", "a local\n");
  if (variant === "untracked") writeFile(r, "new.txt", "new local\n");
  if (variant === "ignored") writeFile(r, "build.log", "log local\n");
  if (variant === "folder") writeFile(r, "dirfile/inner.txt", "inner\n");
  return finish(name, root, r, h);
}

// ---- Merge and rebase fixtures ----

type MergeVariant = "ff" | "diverged" | "ff-only" | "driver";

function buildMerge(git: string, name: string, variant: MergeVariant): WbFixture {
  const { root, r } = start(git, name);
  if (variant === "ff") {
    const h = history(r, [
      { label: "base", ref: "main", files: { "m.txt": "m\n" } },
      { label: "topic-1", ref: "topic", from: "base", files: { "t.txt": "t1\n" } },
      { label: "topic", ref: "topic", from: "topic-1", files: { "t.txt": "t2\n" } },
    ], "main");
    return finish(name, root, r, h);
  }
  const driver = variant === "driver";
  const h = history(r, [
    { label: "base", ref: "main", files: { "m.txt": "m\n", ...(driver ? { ".gitattributes": "driver.txt merge=canary\n", "driver.txt": "base\n" } : {}) } },
    { label: "main", ref: "main", from: "base", files: { "m.txt": "m main\n", ...(driver ? { "driver.txt": "main\n" } : {}) } },
    { label: "topic-1", ref: "topic", from: "base", files: { "t.txt": "t1\n" } },
    { label: "topic", ref: "topic", from: "topic-1", files: { "t.txt": "t2\n", ...(driver ? { "driver.txt": "topic\n" } : {}) } },
    { label: "other", ref: "other", from: "base", files: { "o.txt": "o\n" } },
    { reset: "refs/remotes/origin/topic", at: "topic" },
  ], "main");
  appendConfig(r, remote("origin", "+refs/heads/*:refs/remotes/origin/*"));
  if (variant === "ff-only") appendConfig(r, "[merge]\n\tff = only\n");
  if (driver) {
    // gitattributes(5) "Defining a custom merge driver". The canary keeps %A, so the merge takes the current side.
    wb(r, ["config", "merge.canary.name", "fixture canary driver"]);
    wb(r, ["config", "merge.canary.driver", `${canary(root, "merge-driver").command} %O %A %B`]);
  }
  return finish(name, root, r, h);
}

type RebaseVariant = "mix" | "fixup" | "update-refs";

function buildRebase(git: string, name: string, variant: RebaseVariant): WbFixture {
  const { root, r } = start(git, name);
  if (variant === "mix") {
    // Patch-same, empty, and merge commits, and a push tracking ref that holds commits that the rebase rewrites (plan.md D6).
    const h = history(r, [
      { label: "base", ref: "up", files: { "f.txt": "f\n" } },
      { label: "up-1", ref: "up", from: "base", files: { "u.txt": "u\n" } },
      { label: "up", ref: "up", from: "up-1", files: { "p.txt": "patch\n" } },
      { label: "t1", ref: "topic", from: "base", files: { "t1.txt": "t1\n" } },
      { label: "same", ref: "topic", from: "t1", files: { "p.txt": "patch\n" } },
      { label: "empty", ref: "topic", from: "same" },
      { label: "side", ref: "side", from: "t1", files: { "s.txt": "s\n" } },
      { label: "merge", ref: "topic", from: "empty", merge: ["side"], files: { "s.txt": "s\n" } },
      { label: "topic", ref: "topic", from: "merge", files: { "t2.txt": "t2\n" } },
      { reset: "refs/remotes/origin/topic", at: "empty" },
    ], "topic");
    appendConfig(r, `${remote("origin", "+refs/heads/*:refs/remotes/origin/*")}[branch "topic"]\n\tremote = origin\n\tmerge = refs/heads/topic\n`);
    return finish(name, root, r, h);
  }
  if (variant === "fixup") {
    const h = history(r, [
      { label: "base", ref: "up", files: { "x.txt": "x0\n" } },
      { label: "up", ref: "up", from: "base", files: { "u.txt": "u\n" } },
      { label: "feature", ref: "topic", from: "base", files: { "x.txt": "x1\n" } },
      { label: "other", ref: "topic", from: "feature", files: { "y.txt": "y\n" } },
      { label: "fixup", ref: "topic", from: "other", message: "fixup! feature", files: { "x.txt": "x2\n" } },
    ], "topic");
    return finish(name, root, r, h);
  }
  const h = history(r, [
    { label: "base", ref: "up", files: { "f.txt": "f\n" } },
    { label: "up", ref: "up", from: "base", files: { "u.txt": "u\n" } },
    { label: "c1", ref: "topic", from: "base", files: { "c1.txt": "c1\n" } },
    { label: "c2", ref: "topic", from: "c1", files: { "c2.txt": "c2\n" } },
    { label: "topic", ref: "topic", from: "c2", files: { "c3.txt": "c3\n" } },
    { reset: "part", at: "c1" },
    { reset: "wt-part", at: "c2" },
    { reset: "outside", at: "base" },
  ], "topic");
  appendConfig(r, "[rebase]\n\tupdateRefs = true\n");
  const held = join(root, "wt-part");
  wb(r, ["worktree", "add", "-q", "--", held, "wt-part"]);
  return finish(name, root, r, h);
}

// ---- Conflict fixtures ----

const RENAMED = "rename line 1\nrename line 2\nrename line 3\n";

// One real merge or rebase stop gives every porcelain v2 unmerged kind. The rename of `dd.txt` to two names gives DD, AU, and UA (merge-ort rename/rename).
function buildConflict(git: string, name: string, variant: "merge" | "rebase"): WbFixture {
  const { root, r } = start(git, name);
  const h = history(r, [
    { label: "base", ref: "main", files: { "uu.txt": "uu base\n", "ud.txt": "ud base\n", "du.txt": "du base\n", "dd.txt": RENAMED }, links: { link: "target-base" } },
    { label: "ours", ref: "main", from: "base", files: { "uu.txt": "uu ours\n", "aa.txt": "aa ours\n", "ud.txt": "ud ours\n", "au.txt": RENAMED }, deletes: ["du.txt", "dd.txt"], links: { link: "target-ours" } },
    { label: "theirs", ref: "topic", from: "base", files: { "uu.txt": "uu theirs\n", "aa.txt": "aa theirs\n", "du.txt": "du theirs\n", "ua.txt": RENAMED }, deletes: ["ud.txt", "dd.txt"], links: { link: "target-theirs" } },
  ], variant === "merge" ? "main" : "topic");
  // A stop with conflicts exits 1. The self-check reads the stages and the markers.
  if (variant === "merge") wb(r, ["merge", "--no-edit", "topic"], { allowExit: [1] });
  else wb(r, ["rebase", "main"], { allowExit: [1] });
  return finish(name, root, r, h);
}

// ---- Staging fixtures ----

const TEN = lines(1, 10, (n) => `line ${n}\n`);

function buildStaging(git: string, name: string, variant: "tree" | "hunks"): WbFixture {
  const { root, r } = start(git, name);
  if (variant === "tree") {
    const h = history(r, [{ label: "base", ref: "main", files: { "src/a.txt": "a\n", "src/lib/b.txt": "b\n", "src/lib/deep/c.txt": "c\n", "docs/d.txt": "d\n", "top.txt": "top\n" } }], "main");
    for (const [path, content] of Object.entries({ "src/a.txt": "a changed\n", "src/lib/deep/c.txt": "c changed\n", "docs/d.txt": "d changed\n", "src/lib/new.txt": "new\n", "src/new-dir/n1.txt": "n1\n", "src/new-dir/n2.txt": "n2\n", "top-new.txt": "top new\n" })) writeFile(r, path, content);
    return finish(name, root, r, h);
  }
  const h = history(r, [{ label: "base", ref: "main", files: { "added.txt": TEN, "removed.txt": TEN, "mixed.txt": TEN, "deleted.txt": "deleted\n", "eof.txt": "one\ntwo\nthree" } }], "main");
  // One hunk each: added lines only, removed lines only, mixed lines, and a change of a last line without LF.
  writeFile(r, "added.txt", `${lines(1, 5, (n) => `line ${n}\n`)}added 1\nadded 2\n${lines(6, 10, (n) => `line ${n}\n`)}`);
  writeFile(r, "removed.txt", `${lines(1, 4, (n) => `line ${n}\n`)}${lines(7, 10, (n) => `line ${n}\n`)}`);
  writeFile(r, "mixed.txt", `${lines(1, 4, (n) => `line ${n}\n`)}mixed 5a\nmixed 5b\n${lines(7, 10, (n) => `line ${n}\n`)}`);
  writeFile(r, "eof.txt", "one\ntwo\nthree changed");
  rmSync(join(r.dir, "deleted.txt"));
  return finish(name, root, r, h);
}

export const UNTRACKED_FILES = 100_000;
const UNTRACKED_FOLDERS = 100;

// The 100,000 untracked files of plan.md P0.1, built once into the 001 fixture cache root with its lock (`tests/windows/perf-fixtures.ts`).
// Callers read it in place with `--no-optional-locks`. A mutation needs its own copy.
export function untrackedFixture(git: string): WbFixture {
  mkdirSync(PERF_CACHE_ROOT, { recursive: true });
  const build = Bun.spawnSync([git, "version", "--build-options"], { cwd: PERF_CACHE_ROOT, env: wbEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`git version --build-options exited ${build.exitCode}`);
  const key = sha256(Buffer.from(JSON.stringify({ builder: builderDigest(readFileSync(import.meta.path)), git: build.stdout.toString() })));
  const id = "wb-untracked-100k";
  const folder = ownedPath(PERF_CACHE_ROOT, id);
  const lock = ownedPath(PERF_CACHE_ROOT, `${id}.lock`);
  const temp = ownedPath(PERF_CACHE_ROOT, `${id}.tmp`);
  const manifestPath = join(folder, "manifest.json");
  const repo = join(folder, "repo");
  // As `ensurePerfFixture`: reuse needs the key and the recorded reuse state. A changed cache file gives a new build.
  const current = () => {
    if (!existsSync(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { key: string; reuse?: PerfReuseState };
    if (manifest.key !== key || manifest.reuse === undefined || !existsSync(repo)) return false;
    try {
      return JSON.stringify(perfReuseState(git, repo)) === JSON.stringify(manifest.reuse);
    } catch {
      return false;
    }
  };
  acquireLock(lock);
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    // A changed builder or Git build replaces the cached build.
    if (!current()) {
      if (existsSync(temp)) removeTree(temp);
      const r = init(git, join(temp, "repo"), {}, LINE_ENDINGS, PERF_CACHE_ROOT);
      const h = history(r, [{ label: "base", ref: "main", files: { "README.txt": "100,000 untracked files\n" } }], "main");
      const per = UNTRACKED_FILES / UNTRACKED_FOLDERS;
      for (let d = 0; d < UNTRACKED_FOLDERS; d++) {
        const dir = join(r.dir, "u", String(d).padStart(3, "0"));
        mkdirSync(dir, { recursive: true });
        for (let i = 0; i < per; i++) writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.txt`), "x\n");
      }
      const config = join(r.dir, ".git", "config");
      writeFileSync(join(temp, "manifest.json"), JSON.stringify({ key, oids: h.oids, refs: h.refs, local: sha256(readFileSync(config)), reuse: perfReuseState(git, r.dir) }));
      if (existsSync(folder)) removeTree(folder);
      renameSync(temp, folder);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { oids: Record<string, string>; refs: Record<string, string>; local: string };
    return { name: "untracked-100k", git, root: folder, repo, env: {}, oids: manifest.oids, refs: manifest.refs, configs: { local: join(repo, ".git", "config") }, digests: { local: manifest.local } };
  } finally {
    removeTree(lock);
  }
}

// ---- Worktree fixtures ----

function buildWorktrees(git: string, name: string): WbFixture {
  const { root, r } = start(git, name);
  const branches = ["locked-r", "locked-n", "prunable-b", "dirty-b", "spaces-b"];
  const h = history(r, [{ label: "base", ref: "main", files: { "w.txt": "w\n" } }, ...branches.map((b) => ({ reset: b, at: "base" }))], "main");
  const [lockedReason, locked, prunable, dirty, spaces] = ["wt-locked-reason", "wt-locked", "wt-prunable", "wt-dirty", "wt with spaces"].map((p) => join(root, p)) as [string, string, string, string, string];
  for (const [path, branch] of [[lockedReason, "locked-r"], [locked, "locked-n"], [prunable, "prunable-b"], [dirty, "dirty-b"], [spaces, "spaces-b"]] as const) wb(r, ["worktree", "add", "-q", "--", path, branch]);
  // research.md R13: with `-z`, Git prints the reason unquoted, also with a line feed.
  wb(r, ["worktree", "lock", "--reason", "fixture reason\nwith newline", "--", lockedReason]);
  wb(r, ["worktree", "lock", "--", locked]);
  removeTree(prunable);
  put(dirty, "w.txt", "w dirty\n");
  put(dirty, "untracked.txt", "untracked\n");
  return finish(name, root, r, h);
}

// ---- Configuration fixtures ----

// One value of each spec FR-060 key per scope. `credential.helper` holds two local values. The local `core.editor` comes from an include.
function scopeText(scope: "system" | "global" | "local" | "xdg"): string {
  const on = scope === "global" ? "false" : "true";
  const pick = <T>(values: Record<"system" | "global" | "local" | "xdg", T>) => values[scope];
  const helper = scope === "local" ? "\thelper = local-helper-1\n\thelper = local-helper-2\n" : `\thelper = ${scope}-helper\n`;
  return [
    `[user]\n\tname = ${scope} name\n\temail = ${scope}@arbareto.invalid\n`,
    `[core]\n${scope === "local" ? "" : `\teditor = ${scope}-editor\n`}\tautocrlf = ${pick({ system: "true", global: "input", local: "false", xdg: "false" })}\n`,
    `[commit]\n\ttemplate = ${scope}-template.txt\n`,
    `[credential]\n${helper}`,
    `[diff]\n\ttool = ${scope}-diff\n`,
    `[difftool "fixture"]\n\tpath = ${scope}-difftool-path\n\tcmd = ${scope}-difftool $LOCAL $REMOTE\n`,
    `[merge]\n\ttool = ${scope}-merge\n\tautostash = ${on}\n`,
    `[mergetool "fixture"]\n\tpath = ${scope}-mergetool-path\n\tcmd = ${scope}-mergetool $MERGED\n`,
    `[i18n]\n\tfilesEncoding = utf-8\n`,
    `[pull]\n\trebase = ${pick({ system: "true", global: "merges", local: "false", xdg: "false" })}\n\tff = ${pick({ system: "true", global: "only", local: "false", xdg: "false" })}\n`,
    `[fetch]\n\tprune = ${on}\n`,
    `[rebase]\n\tautostash = ${on}\n\tautosquash = ${on}\n\tupdateRefs = ${on}\n`,
    `[rerere]\n\tenabled = ${on}\n\tautoUpdate = ${on}\n`,
    `[push]\n\tdefault = ${pick({ system: "simple", global: "current", local: "upstream", xdg: "simple" })}\n\tautoSetupRemote = ${on}\n`,
  ].join("");
}

// Each scope in its own owned file. `scopes` tests the system scope, so it sets `GIT_CONFIG_NOSYSTEM=0` with an owned `GIT_CONFIG_SYSTEM`.
function buildConfig(git: string, name: string, variant: "scopes" | "xdg"): WbFixture {
  installMergeTool(git);
  const root = fixtureDir(name);
  const home = join(root, "home");
  const xdg = join(home, ".config");
  const system = join(root, "system.gitconfig");
  const global = join(home, ".gitconfig");
  const xdgFile = join(xdg, "git", "config");
  const env: Env =
    variant === "scopes"
      ? { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: system, GIT_CONFIG_NOSYSTEM: "0" }
      : { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_GLOBAL: undefined };
  if (variant === "scopes") {
    put(root, "system.gitconfig", scopeText("system"));
    put(home, ".gitconfig", scopeText("global"));
  } else put(xdg, "git/config", "[user]\n\tname = xdg name\n\temail = xdg@arbareto.invalid\n");
  // The local file of `scopes` holds `core.autocrlf` itself, so `init` leaves it out.
  const r = init(git, join(root, "repo"), env, variant === "scopes" ? LINE_ENDINGS.filter(([k]) => k !== "core.autocrlf") : LINE_ENDINGS);
  const h = history(r, [{ label: "base", ref: "main", files: { "c.txt": "c\n" } }], "main");
  if (variant === "scopes") {
    appendConfig(r, `${scopeText("local")}[include]\n\tpath = included.gitconfig\n`);
    put(r.dir, ".git/included.gitconfig", "[core]\n\teditor = included-editor\n");
  }
  const files: Record<string, string> = variant === "scopes" ? { global, system, included: join(r.dir, ".git", "included.gitconfig") } : { global, xdg: xdgFile };
  return finish(name, root, r, h, files);
}

// ---- Amend fixtures ----

function buildAmend(git: string, name: string, variant: "on-upstream" | "ahead" | "no-upstream"): WbFixture {
  const { root, r } = start(git, name);
  const h = history(r, [
    { label: "base", ref: "main", files: { "m.txt": "1\n" } },
    { label: "second", ref: "main", from: "base", files: { "m.txt": "2\n" } },
    ...(variant === "ahead" ? [{ label: "third", ref: "main", from: "second", files: { "m.txt": "3\n" } }] : []),
    ...(variant === "no-upstream" ? [] : [{ reset: "refs/remotes/origin/main", at: "second" }]),
  ], "main");
  if (variant !== "no-upstream") appendConfig(r, `${remote("origin", "+refs/heads/*:refs/remotes/origin/*")}[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`);
  return finish(name, root, r, h);
}

// ---- The register ----

const WORKBENCH_FIXTURES = {
  branches: buildBranches,
  "switch-clean": (git: string, name: string) => buildSwitch(git, name, "clean"),
  "switch-dirty": (git: string, name: string) => buildSwitch(git, name, "dirty"),
  "switch-conflict": (git: string, name: string) => buildSwitch(git, name, "conflict"),
  "switch-untracked": (git: string, name: string) => buildSwitch(git, name, "untracked"),
  "switch-ignored": (git: string, name: string) => buildSwitch(git, name, "ignored"),
  "switch-folder": (git: string, name: string) => buildSwitch(git, name, "folder"),
  "merge-ff": (git: string, name: string) => buildMerge(git, name, "ff"),
  "merge-diverged": (git: string, name: string) => buildMerge(git, name, "diverged"),
  "merge-ff-only": (git: string, name: string) => buildMerge(git, name, "ff-only"),
  "merge-driver": (git: string, name: string) => buildMerge(git, name, "driver"),
  "rebase-mix": (git: string, name: string) => buildRebase(git, name, "mix"),
  "rebase-fixup": (git: string, name: string) => buildRebase(git, name, "fixup"),
  "rebase-update-refs": (git: string, name: string) => buildRebase(git, name, "update-refs"),
  "conflict-merge": (git: string, name: string) => buildConflict(git, name, "merge"),
  "conflict-rebase": (git: string, name: string) => buildConflict(git, name, "rebase"),
  "staging-tree": (git: string, name: string) => buildStaging(git, name, "tree"),
  "staging-hunks": (git: string, name: string) => buildStaging(git, name, "hunks"),
  worktrees: buildWorktrees,
  "config-scopes": (git: string, name: string) => buildConfig(git, name, "scopes"),
  "config-xdg": (git: string, name: string) => buildConfig(git, name, "xdg"),
  "amend-on-upstream": (git: string, name: string) => buildAmend(git, name, "on-upstream"),
  "amend-ahead": (git: string, name: string) => buildAmend(git, name, "ahead"),
  "amend-no-upstream": (git: string, name: string) => buildAmend(git, name, "no-upstream"),
} satisfies Record<string, (git: string, name: string) => WbFixture>;

export type WbFixtureName = keyof typeof WORKBENCH_FIXTURES;

export const buildWorkbench = (git: string, fixture: WbFixtureName, folder: string): WbFixture => WORKBENCH_FIXTURES[fixture](git, folder);
