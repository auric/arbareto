// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 plan.md P0.1 (tasks.md T017): the History, Blame, and Branches fixtures. Facts come from the construction, never from `src/git-service/`.
// Each builder declares the trees, the parent counts, and the changed-file counts that the T016 self-check compares with Git.

import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { acquireLock, builderDigest, PERF_CACHE_ROOT } from "../windows/perf-fixtures";
import { FIXED_TIMESTAMPS, FIXTURE_ROOT, fixtureDir, fixtureEnv, fixturePath, ownedGit, ownedPath, removeTree } from "./fixture-root";
import { fixtureGitPath } from "./git-binary";

export type ObjectFormat = "sha1" | "sha256";
export type FiEntry = { mode: "100644" | "100755" | "120000"; data: string | Uint8Array } | { mode: "160000"; oid: string } | "delete";

export interface FiStep {
  label: string;
  ref?: string;
  // No `from`: a root commit.
  from?: string;
  merge?: string[];
  message?: string;
  author?: string;
  files?: Record<string, FiEntry>;
  // The expected record count of `diff-tree -r -z --raw -M -l1000` against the first parent, or against the empty tree for a root commit.
  changes?: number;
}

export interface Built {
  name: string;
  git: string;
  // The cache root for a cached build, else the fixture root.
  root: string;
  repo: string;
  objectFormat: ObjectFormat;
  oids: Record<string, string>;
  // The declared tree of each labeled commit: path to mode.
  trees: Record<string, Record<string, string>>;
  parents: Record<string, number>;
  changes: Record<string, number>;
}

const EPOCH = 1_767_225_600;
const IDENT = "Arbareto Fixture <fixture@arbareto.invalid>";
export const GITLINK_1 = "1".repeat(40);
export const GITLINK_2 = "2".repeat(40);
export const EMPTY_TREE: Record<ObjectFormat, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

export const runGit = (git: string, root: string, cwd: string, args: string[], options: { input?: Uint8Array; env?: Record<string, string | undefined>; allowExit?: number[] } = {}) =>
  ownedGit(git, root, cwd, args, options);

// One Git process with its exit code and both streams. The working directory lies under `root`.
export function gitExit(git: string, root: string, cwd: string, args: string[], env: Record<string, string | undefined> = {}, input?: Uint8Array): { exitCode: number; stdout: Buffer; stderr: Buffer } {
  const proc = Bun.spawnSync([fixtureGitPath(git), ...args], {
    cwd: ownedPath(root, relative(root, cwd)),
    env: fixtureEnv({ ...FIXED_TIMESTAMPS, ...env }),
    stdin: input === undefined ? "ignore" : input,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr };
}

export function gitVersion(git: string): string {
  return Bun.spawnSync([fixtureGitPath(git), "version"], { env: fixtureEnv(), stdin: "ignore", stdout: "pipe" }).stdout.toString().trim();
}

const bytesOf = (data: string | Uint8Array) => (typeof data === "string" ? Buffer.from(data) : Buffer.from(data));
const dataCommand = (data: string | Uint8Array) => {
  const b = bytesOf(data);
  return Buffer.concat([Buffer.from(`data ${b.length}\n`), b, Buffer.from("\n")]);
};

// The `git fast-import` stream of `steps`, and the declared tree of each step.
function streamOf(steps: readonly FiStep[]): { stream: Buffer; trees: Record<string, Record<string, string>>; parents: Record<string, number>; changes: Record<string, number> } {
  const marks = new Map<string, number>();
  const trees: Record<string, Record<string, string>> = {};
  const parents: Record<string, number> = {};
  const changes: Record<string, number> = {};
  const parts: Buffer[] = [];
  const at = (label: string) => {
    const mark = marks.get(label);
    if (mark === undefined) throw new Error(`unknown commit label ${label}`);
    return mark;
  };
  for (const s of steps) {
    const mark = marks.size + 1;
    const ref = s.ref ?? "refs/heads/main";
    const time = EPOCH + mark * 60;
    // A root commit on a ref that this stream already wrote needs `reset`, or fast-import takes the ref tip as its parent.
    if (s.from === undefined) parts.push(Buffer.from(`reset ${ref}\n\n`));
    parts.push(Buffer.from(`commit ${ref}\nmark :${mark}\nauthor ${s.author ?? IDENT} ${time} +0000\ncommitter ${IDENT} ${time} +0000\n`), dataCommand(`${s.message ?? s.label}\n`));
    if (s.from !== undefined) parts.push(Buffer.from(`from :${at(s.from)}\n`));
    for (const m of s.merge ?? []) parts.push(Buffer.from(`merge :${at(m)}\n`));
    const tree = { ...(s.from === undefined ? {} : trees[s.from]!) };
    for (const [path, entry] of Object.entries(s.files ?? {})) {
      if (entry === "delete") {
        parts.push(Buffer.from(`D ${path}\n`));
        delete tree[path];
      } else if (entry.mode === "160000") {
        parts.push(Buffer.from(`M 160000 ${entry.oid} ${path}\n`));
        tree[path] = "160000";
      } else {
        parts.push(Buffer.from(`M ${entry.mode} inline ${path}\n`), dataCommand(entry.data));
        tree[path] = entry.mode;
      }
    }
    parts.push(Buffer.from("\n"));
    marks.set(s.label, mark);
    trees[s.label] = tree;
    parents[s.label] = (s.from === undefined ? 0 : 1) + (s.merge?.length ?? 0);
    if (s.changes !== undefined) changes[s.label] = s.changes;
  }
  return { stream: Buffer.concat(parts), trees, parents, changes };
}

// Imports `steps` into a new repository at `repo` and returns the object ID of each label. `checkout`: `reset --hard` to `head`.
function importRepo(git: string, root: string, repo: string, steps: readonly FiStep[], o: { objectFormat?: ObjectFormat; head?: string; checkout?: boolean; streamFile?: string } = {}): Omit<Built, "name"> {
  const objectFormat = o.objectFormat ?? "sha1";
  mkdirSync(ownedPath(root, relative(root, repo)), { recursive: true });
  const g = (args: string[], options?: { input?: Uint8Array }) => runGit(git, root, repo, args, options);
  g(["init", "-q", "-b", "main", `--object-format=${objectFormat}`]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"], ["core.filemode", "false"], ["core.symlinks", "false"]]) g(["config", key!, value!]);
  const { stream, trees, parents, changes } = streamOf(steps);
  const marksFile = join(repo, ".git", "arbareto-marks");
  g(["fast-import", "--quiet", `--export-marks=${marksFile}`], { input: stream });
  const byMark = new Map(readFileSync(marksFile, "utf8").trim().split("\n").map((l) => [Number(l.slice(1, l.indexOf(" "))), l.slice(l.indexOf(" ") + 1)] as const));
  rmSync(marksFile);
  const oids = Object.fromEntries(steps.map((s, i) => [s.label, byMark.get(i + 1)!]));
  if (o.head !== undefined) g(["symbolic-ref", "HEAD", o.head]);
  if (o.checkout !== false) g(["reset", "-q", "--hard"]);
  return { git, root, repo, objectFormat, oids, trees, parents, changes };
}

// ---- History fixtures ----

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join("");
export const REN_OLD = lines(25, (i) => `line number ${i}`);
// Two of 25 lines change, so Git scores the rename 92 (probe of 2026-10-22 on Git 2.56.0.windows.2).
export const REN_NEW = lines(25, (i) => (i <= 2 ? `line NUMBER ${i}` : `line number ${i}`));
export const BINARY_1 = Uint8Array.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x10, 0x00, 0x0a]);
export const BINARY_2 = Uint8Array.from([0x00, 0x01, 0x03, 0x00, 0xfe, 0x10, 0x00, 0x0a, 0x00]);

const f = (data: string | Uint8Array, mode: "100644" | "100755" | "120000" = "100644"): FiEntry => ({ mode, data });

function historySteps(gitlink: (n: 1 | 2) => string): FiStep[] {
  return [
    {
      label: "root",
      changes: 10,
      files: { "a.txt": f("alpha\n"), "del.txt": f("delete me\n"), "ren.txt": f(REN_OLD), "mode.sh": f("echo mode\n"), "bin.dat": f(BINARY_1), typ: f("type\n"), a: f("file a\n"), lib: { mode: "160000", oid: gitlink(1) }, "sp ace.txt": f("space\n"), "é.txt": f("accent\n") },
    },
    { label: "normal", from: "root", changes: 6, files: { "a.txt": f("alpha\nbeta\n"), "added.txt": f("added\n"), "del.txt": "delete", "sp ace.txt": f("space 2\n"), "é.txt": f("accent 2\n"), lnk: f("a.txt", "120000") } },
    { label: "rename", from: "normal", changes: 1, files: { "ren.txt": "delete", "renamed.txt": f(REN_NEW) } },
    { label: "mode", from: "rename", changes: 1, files: { "mode.sh": f("echo mode\n", "100755") } },
    { label: "binary", from: "mode", changes: 1, files: { "bin.dat": f(BINARY_2) } },
    { label: "submodule", from: "binary", changes: 1, files: { lib: { mode: "160000", oid: gitlink(2) } } },
    { label: "typechange", from: "submodule", changes: 1, files: { typ: f("target", "120000") } },
    { label: "filedir", from: "typechange", changes: 3, files: { a: "delete", "a/x": f("x\n"), "a/y": f("y\n") } },
    { label: "side1", ref: "refs/heads/side1", from: "filedir", changes: 1, files: { "side1.txt": f("side 1\n") } },
    { label: "side2", ref: "refs/heads/side2", from: "filedir", changes: 1, files: { "side2.txt": f("side 2\n") } },
    { label: "side3", ref: "refs/heads/side3", from: "filedir", changes: 1, files: { "side3.txt": f("side 3\n") } },
    { label: "merge2", from: "filedir", merge: ["side1"], changes: 1, files: { "side1.txt": f("side 1\n") } },
    { label: "merge3", from: "merge2", merge: ["side2", "side3"], changes: 2, files: { "side2.txt": f("side 2\n"), "side3.txt": f("side 3\n") } },
  ];
}

export const HISTORY_LABELS = ["root", "normal", "rename", "mode", "binary", "submodule", "typechange", "filedir", "side1", "side2", "side3", "merge2", "merge3"] as const;

export function buildHistory(git: string, name: string, objectFormat: ObjectFormat = "sha1"): Built {
  const repo = fixtureDir(`${name}/repo`);
  const link = (n: 1 | 2) => (objectFormat === "sha1" ? (n === 1 ? GITLINK_1 : GITLINK_2) : String(n).repeat(64));
  return { name, ...importRepo(git, FIXTURE_ROOT, repo, historySteps(link), { objectFormat }) };
}

// A clone with `--depth 1`: the tip commit is in the shallow file and has no parents in this clone.
export function buildShallowHistory(git: string, source: Built, name: string, depth = 1): string {
  const dest = fixturePath(`${name}/repo`);
  mkdirSync(fixturePath(name), { recursive: true });
  runGit(git, FIXTURE_ROOT, fixturePath(name), ["clone", "-q", "--no-local", `--depth=${depth}`, "--single-branch", "--branch", "main", `file://${source.repo.replaceAll("\\", "/")}`, "repo"]);
  return dest;
}

// A partial clone without any blob (`--filter=blob:none --no-checkout`). `tree:0` also leaves out the trees.
export function buildPartialClone(git: string, source: Built, name: string, filter: "blob:none" | "tree:0" = "blob:none"): string {
  runGit(git, FIXTURE_ROOT, source.repo, ["config", "uploadpack.allowFilter", "true"]);
  mkdirSync(fixturePath(name), { recursive: true });
  runGit(git, FIXTURE_ROOT, fixturePath(name), ["clone", "-q", "--no-local", `--filter=${filter}`, "--no-checkout", `file://${source.repo.replaceAll("\\", "/")}`, "repo"]);
  return fixturePath(`${name}/repo`);
}

// 1,000 added files in one commit.
export function buildWide(git: string, name: string, count = 1000): Built {
  const files: Record<string, FiEntry> = {};
  for (let i = 0; i < count; i++) files[`w/f${String(i).padStart(4, "0")}.txt`] = f(`wide ${i}\n`);
  const repo = fixtureDir(`${name}/repo`);
  return { name, ...importRepo(git, FIXTURE_ROOT, repo, [{ label: "base", changes: 1, files: { "README.md": f("wide\n") } }, { label: "wide", from: "base", changes: count, files }], { checkout: false }) };
}

// 1,001 inexact renames: above `-l1000`, Git skips inexact rename detection (diffcore-rename.c `too_many_rename_candidates`).
export const RENAME_PAIRS = 1001;
export function buildRenames(git: string, name: string): Built {
  const before: Record<string, FiEntry> = {};
  const after: Record<string, FiEntry> = {};
  const body = (i: number, last: string) => lines(9, (n) => `pair ${i} line ${n} shared text`) + `${last}\n`;
  for (let i = 0; i < RENAME_PAIRS; i++) {
    const id = String(i).padStart(4, "0");
    before[`r/old-${id}.txt`] = f(body(i, "end"));
    after[`r/old-${id}.txt`] = "delete";
    after[`r/new-${id}.txt`] = f(body(i, "changed end"));
  }
  const repo = fixtureDir(`${name}/repo`);
  return { name, ...importRepo(git, FIXTURE_ROOT, repo, [{ label: "before", changes: RENAME_PAIRS, files: before }, { label: "after", from: "before", changes: 2 * RENAME_PAIRS, files: after }], { checkout: false }) };
}

// The 001 diff bounds: `lines` adds a file of 20,001 lines, and `bytes` adds a file of one line above 4 MiB.
export function buildPatchBounds(git: string, name: string): Built {
  const repo = fixtureDir(`${name}/repo`);
  return {
    name,
    ...importRepo(git, FIXTURE_ROOT, repo, [
      { label: "base", changes: 1, files: { "README.md": f("bounds\n") } },
      { label: "lines", from: "base", changes: 1, files: { "many.txt": f("x\n".repeat(20_001)) } },
      { label: "bytes", from: "lines", changes: 1, files: { "wide.txt": f(`${"y".repeat(4 * 1024 * 1024)}\n`) } },
      { label: "hugelines", from: "bytes", changes: 1, files: { "huge-lines.txt": f("x\n".repeat(100_001)) } },
    ], { checkout: false }),
  };
}

// ---- Cached fixtures (the 001 fixture cache root) ----

export const WIDE_FILES = 100_001;
const currentDigest = () => builderDigest(readFileSync(import.meta.path));

interface Manifest {
  builderDigest: string;
  built: Omit<Built, "repo" | "root" | "git">;
}

// Builds once per builder digest under the cache root. The lock and the temporary folder follow `ensureLargeFixture`.
function cached(git: string, name: string, build: (repo: string) => Omit<Built, "repo" | "root" | "git">): Built {
  mkdirSync(PERF_CACHE_ROOT, { recursive: true });
  const folder = ownedPath(PERF_CACHE_ROOT, `f005-${name}`);
  const lock = ownedPath(PERF_CACHE_ROOT, `f005-${name}.lock`);
  const temp = ownedPath(PERF_CACHE_ROOT, `f005-${name}.tmp`);
  const manifestPath = join(folder, "manifest.json");
  acquireLock(lock);
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      if (manifest.builderDigest === currentDigest() && existsSync(join(folder, "repo"))) return { ...manifest.built, git, root: PERF_CACHE_ROOT, repo: join(folder, "repo") };
    }
    if (existsSync(temp)) removeTree(temp);
    mkdirSync(temp);
    const built = build(join(temp, "repo"));
    writeFileSync(join(temp, "manifest.json"), `${JSON.stringify({ builderDigest: currentDigest(), built } satisfies Manifest, null, 2)}\n`);
    if (existsSync(folder)) removeTree(folder);
    renameSync(temp, folder);
    return { ...built, git, root: PERF_CACHE_ROOT, repo: join(folder, "repo") };
  } finally {
    removeTree(lock);
  }
}

// The 100,001-file commit. No checkout: the index stays empty, and every read names the commits.
export function wideLarge(git: string): Built {
  return cached(git, "wide-100001", (repo) => {
    const files: Record<string, FiEntry> = {};
    for (let i = 0; i < WIDE_FILES; i++) files[`w/${String(i).padStart(6, "0")}.txt`] = f(`${i}\n`);
    const { git: _g, root: _r, repo: _p, ...rest } = importRepo(git, PERF_CACHE_ROOT, repo, [{ label: "base", changes: 1, files: { "README.md": f("wide\n") } }, { label: "wide", from: "base", changes: WIDE_FILES, files }], { checkout: false });
    return { name: "wide-100001", ...rest };
  });
}

export const BIG_LINES = 10_000;
export const BIG_COMMITS = 5_000;
// Line i of version v: commit k (1-based, k >= 2) rewrites lines 2k-3 and 2k-2, so every line ends in its own commit.
const bigLine = (i: number, v: number) => `${i.toString(36)}.${v}\n`;

// A 10,000-line file with 5,000 commits. The stream goes to Git from a file, so it never sits in memory whole.
export function blameLarge(git: string): Built {
  return cached(git, "blame-10000x5000", (repo) => {
    const root = PERF_CACHE_ROOT;
    mkdirSync(ownedPath(root, relative(root, repo)), { recursive: true });
    runGit(git, root, repo, ["init", "-q", "-b", "main"]);
    for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"]]) runGit(git, root, repo, ["config", key!, value!]);
    const streamPath = join(repo, "..", "big.fast-import");
    const fd = openSync(streamPath, "w");
    const version = new Uint32Array(BIG_LINES);
    try {
      for (let k = 1; k <= BIG_COMMITS; k++) {
        if (k >= 2) for (const i of [2 * k - 4, 2 * k - 3]) if (i >= 0 && i < BIG_LINES) version[i] = k;
        let content = "";
        for (let i = 0; i < BIG_LINES; i++) content += bigLine(i, version[i]!);
        const time = EPOCH + k * 60;
        const head = `commit refs/heads/main\nmark :${k}\nauthor ${IDENT} ${time} +0000\ncommitter ${IDENT} ${time} +0000\n`;
        writeSync(fd, Buffer.concat([Buffer.from(head), dataCommand(`big ${k}\n`), Buffer.from(k === 1 ? "" : `from :${k - 1}\n`), Buffer.from("M 100644 inline big.txt\n"), dataCommand(content), Buffer.from("\n")]));
      }
    } finally {
      closeSync(fd);
    }
    const proc = Bun.spawnSync([fixtureGitPath(git), "fast-import", "--quiet"], { cwd: repo, env: fixtureEnv(FIXED_TIMESTAMPS), stdin: Bun.file(streamPath), stdout: "pipe", stderr: "pipe" });
    rmSync(streamPath);
    if (proc.exitCode !== 0) throw new Error(`git fast-import exited ${proc.exitCode}: ${proc.stderr.toString()}`);
    runGit(git, root, repo, ["reset", "-q", "--hard"]);
    const tip = runGit(git, root, repo, ["rev-parse", "HEAD"]).toString().trim();
    return { name: "blame-10000x5000", objectFormat: "sha1", oids: { tip }, trees: { tip: { "big.txt": "100644" } }, parents: { tip: 1 }, changes: { tip: 1 } };
  });
}

// A copy of a built repository under the fixture root. The source stays unchanged.
export function copyRepo(source: string, name: string): string {
  const dest = fixturePath(name);
  cpSync(source, dest, { recursive: true });
  return dest;
}

// ---- Blame fixture ----

const storyLine = (n: number) => `story line ${n} with several more words for the move score`;
export const STORY = lines(10, storyLine);
const otherLine = (n: number) => `other source line ${n} that holds enough alphanumeric characters for copy detection`;
const OTHER = lines(8, otherLine);
const story2 = lines(10, (n) => (n === 3 || n === 4 ? `${storyLine(n)} changed in b2` : storyLine(n)));
const tale3 = lines(10, (n) => (n === 3 || n === 4 ? `${storyLine(n)} changed in b2` : n === 7 ? `${storyLine(n)} changed in b3` : storyLine(n)));
const rotate = (text: string, by: number) => {
  const l = text.split("\n").slice(0, -1);
  return `${[...l.slice(by), ...l.slice(0, by)].join("\n")}\n`;
};
const tale4 = rotate(tale3, 3);
const tale5 = tale4 + lines(3, otherLine);
const tale6 = tale5
  .split("\n")
  .map((line, i) => (i === 4 || i === 5 ? `    ${line}` : line))
  .join("\n");
const tale7 = tale6
  .split("\n")
  .map((line, i) => (i === 8 ? `${line} changed in b7` : line))
  .join("\n");

export const BLAME_LABELS = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"] as const;

export function buildBlame(git: string, name: string): Built {
  const steps: FiStep[] = [
    { label: "b1", changes: 6, files: { "story.txt": f(STORY), "other.txt": f(OTHER), "bin.dat": f(BINARY_1), lib: { mode: "160000", oid: GITLINK_1 }, "empty.txt": f(""), "nolf.txt": f("x\ny") } },
    { label: "b2", from: "b1", changes: 1, files: { "story.txt": f(story2) } },
    { label: "b3", from: "b2", changes: 1, files: { "story.txt": "delete", "tale.txt": f(tale3) } },
    { label: "b4", from: "b3", changes: 1, files: { "tale.txt": f(tale4) } },
    { label: "b5", from: "b4", changes: 2, files: { "tale.txt": f(tale5), "other.txt": f(`${OTHER}other line added in b5\n`) } },
    { label: "b6", from: "b5", changes: 1, files: { "tale.txt": f(tale6) } },
    { label: "b7", from: "b6", changes: 1, files: { "tale.txt": f(tale7) } },
    { label: "b8", from: "b7", changes: 1, files: { "nolf.txt": f("x\ny\nz") } },
  ];
  const repo = fixtureDir(`${name}/repo`);
  return { name, ...importRepo(git, FIXTURE_ROOT, repo, steps) };
}

// ---- Branches fixture ----

export interface BranchesBuilt {
  repo: string;
  origin: string;
  oids: Record<string, string>;
}

// `gone`: its upstream ref went in `fetch --prune`. `noremote`: its remote went in `remote remove`. `plain`: no upstream. `present`: a present upstream.
// `feature/b` and `Feature/a` exist only as packed refs, because loose refs that differ in case share one folder on a case-insensitive volume.
export function buildBranches(git: string, name: string): BranchesBuilt {
  const origin = fixtureDir(`${name}/origin`);
  const o = importRepo(git, FIXTURE_ROOT, origin, [
    { label: "o1", files: { "README.md": f("origin\n") } },
    { label: "o2", ref: "refs/heads/gone", from: "o1", files: { "gone.txt": f("gone\n") } },
    { label: "o3", ref: "refs/heads/present", from: "o1", files: { "present.txt": f("present\n") } },
    { label: "o4", ref: "refs/heads/elsewhere", from: "o1", files: { "elsewhere.txt": f("elsewhere\n") } },
  ]);
  const base = fixturePath(name);
  const url = `file://${origin.replaceAll("\\", "/")}`;
  runGit(git, FIXTURE_ROOT, base, ["clone", "-q", "--no-local", url, "repo"]);
  const repo = fixturePath(`${name}/repo`);
  const g = (args: string[]) => runGit(git, FIXTURE_ROOT, repo, args).toString();
  g(["remote", "add", "other", url]);
  g(["fetch", "-q", "other"]);
  g(["branch", "-q", "--track", "gone", "origin/gone"]);
  g(["branch", "-q", "--track", "present", "origin/present"]);
  g(["branch", "-q", "--track", "noremote", "other/elsewhere"]);
  g(["branch", "-q", "--no-track", "plain", "origin/main"]);
  g(["branch", "-q", "--no-track", "feature/b", "origin/main"]);
  g(["pack-refs", "--all"]);
  g(["update-ref", "refs/heads/Feature/a", o.oids.o1!]);
  g(["pack-refs", "--all"]);
  runGit(git, FIXTURE_ROOT, origin, ["branch", "-q", "-D", "gone"]);
  g(["fetch", "-q", "--prune", "origin"]);
  g(["remote", "remove", "other"]);
  return { repo, origin, oids: o.oids };
}
