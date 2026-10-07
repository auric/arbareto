// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Deterministic builders of the plan.md fixture matrix (T066). Facts come from the construction, never from `src/git-service/`.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NATIVE } from "../../src/contracts/native-path";
import { FIXTURE_ROOT, fixtureDir, fixturePath, ownedGit, type OwnedGitOptions } from "./fixture-root";
import { indexEntries } from "./git-oracle";

export class CapabilitySkip extends Error {
  constructor(readonly capability: string) {
    super(`SKIP capability ${capability}`);
  }
}

export interface Repo {
  git: string;
  dir: string;
  // Global options before each command, such as `--no-lazy-fetch`.
  pre: string[];
}

export interface ExpectedEntry {
  path: string;
  stage?: number;
  mode?: string;
  oid?: string;
  assumeUnchanged?: boolean;
  skipWorktree?: boolean;
  intentToAdd?: boolean;
}

export interface RepoFacts {
  objectFormat: "sha1" | "sha256";
  head: { target: string | null; oid: string | null };
  refs: Record<string, string>;
  // Sorted paths. `staged` is HEAD (or the empty tree) to index, `unstaged` is index to worktree, both without rename detection.
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
  entries: ExpectedEntry[];
  markers: string[];
}

export interface Facts {
  // Keys are paths relative to the fixture folder.
  repos: Record<string, RepoFacts>;
  // Canary name to log path relative to the fixture folder. A canary appends one line per run.
  canaries: Record<string, string>;
  // `-c` arguments that keep oracle reads of this fixture from running its canaries.
  disarm: string[];
  notes: Record<string, unknown>;
}

export interface Built {
  id: string;
  variant: string;
  root: string;
  facts: Facts;
}

export function run(r: Repo, args: string[], options: OwnedGitOptions = {}): string {
  return ownedGit(r.git, FIXTURE_ROOT, r.dir, [...r.pre, ...args], options).toString();
}

const SHEBANG = Buffer.from("#!");

export function put(dir: string, rel: string, content: string | Uint8Array): string {
  const path = fixturePath(relative(FIXTURE_ROOT, join(dir, rel)));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  // Off Windows, Git starts a hook, filter, or canary script only when the file has the executable bit.
  // The `mode` option of `writeFileSync` does not change an existing file.
  if (SHEBANG.equals(typeof content === "string" ? Buffer.from(content.slice(0, 2)) : content.subarray(0, 2))) chmodSync(path, 0o755);
  return path;
}

const FIXED_EPOCH = Date.UTC(2026, 0, 1) / 1000;
const sorted = (paths: Iterable<string>) => [...new Set(paths)].sort();
const lines = (count: number, f: (n: number) => string) => Array.from({ length: count }, (_, i) => f(i + 1)).join("");
const rev = (r: Repo, what: string) => run(r, ["rev-parse", "--verify", "-q", what]).trim();

// Every builder sets the line-ending keys and `core.filemode` at local scope and never sets `core.longpaths`.
// With `core.filemode=false`, Git ignores the executable bit of a working file and adds a new file as 100644, as Git for Windows does.
function lineEndings(r: Repo): void {
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"], ["core.filemode", "false"]]) run(r, ["config", key, value!]);
}

function init(git: string, dir: string, extra: string[] = []): Repo {
  mkdirSync(dir, { recursive: true });
  const r: Repo = { git, dir, pre: [] };
  run(r, ["init", "-q", "-b", "main", ...extra]);
  lineEndings(r);
  return r;
}

function commit(r: Repo, message: string): string {
  run(r, ["commit", "-q", "--no-verify", "--allow-empty", "-m", message]);
  return rev(r, "HEAD");
}

function add(r: Repo, ...paths: string[]): void {
  run(r, ["--literal-pathspecs", "add", "--", ...paths]);
}

function blob(r: Repo, content: string | Uint8Array): string {
  return run(r, ["hash-object", "-w", "--stdin"], { input: Buffer.from(content) }).trim();
}

function indexInfo(r: Repo, records: [mode: string, oid: string, stage: number, path: string | Uint8Array][]): void {
  const input = Buffer.concat(records.flatMap(([m, o, s, p]) => [Buffer.from(`${m} ${o} ${s}\t`), Buffer.from(p), Buffer.from([0])]));
  run(r, ["update-index", "-z", "--index-info"], { input });
}

// Rebuilds the index from its logical entries, then refreshes it after fixed file times.
// On Windows two builds then give equal raw index bytes: Git for Windows stores zero `dev`, `ino`, `uid`, and `gid`. Elsewhere `ctime` and `ino` differ per build.
export function normalizeIndex(r: Repo): void {
  const [indexPath] = run(r, ["rev-parse", "--git-path", "index"]).trimEnd().split("\n");
  if (!existsSync(resolve(r.dir, indexPath!))) return;
  const logical = indexEntries(r.git, r.dir);
  const ita = new Set(logical.filter((e) => e.intentToAdd).map((e) => e.path));
  const raw = ownedGit(r.git, FIXTURE_ROOT, r.dir, [...r.pre, "ls-files", "-z", "--stage"]);
  const kept: Buffer[] = [];
  for (let at = 0; at < raw.length; ) {
    const nul = raw.indexOf(0, at);
    const record = raw.subarray(at, nul);
    at = nul + 1;
    const path = record.subarray(record.indexOf(0x09) + 1).toString("utf8");
    if (!ita.has(path)) kept.push(record, Buffer.from([0]));
  }
  run(r, ["read-tree", "--empty"]);
  if (kept.length > 0) run(r, ["update-index", "-z", "--index-info"], { input: Buffer.concat(kept) });
  if (ita.size > 0) run(r, ["--literal-pathspecs", "add", "--intent-to-add", "--", ...ita]);
  const assume = logical.filter((e) => e.assumeUnchanged).map((e) => e.path);
  const skip = logical.filter((e) => e.skipWorktree).map((e) => e.path);
  if (assume.length > 0) run(r, ["update-index", "--assume-unchanged", "--", ...assume]);
  if (skip.length > 0) run(r, ["update-index", "--skip-worktree", "--", ...skip]);
  for (const e of logical) {
    if (e.stage !== 0 || e.mode === "160000" || e.skipWorktree || e.intentToAdd) continue;
    const path = join(r.dir, e.path);
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    utimesSync(path, FIXED_EPOCH, FIXED_EPOCH);
    // Git for Windows stores the creation time as `ctime`, and only a Win32 call sets it.
    if (process.platform === "win32") (require("./win32") as typeof import("./win32")).setFileTimes(path, FIXED_EPOCH);
  }
  // Exit 1 means that some entry differs from its working file.
  run(r, ["update-index", "-q", "--refresh"], { allowExit: [0, 1] });
}

function repoFacts(r: Repo, facts: Partial<RepoFacts> & Pick<RepoFacts, "refs">): RepoFacts {
  const target = run(r, ["symbolic-ref", "-q", "HEAD"], { allowExit: [0, 1] }).trim() || null;
  return {
    objectFormat: run(r, ["rev-parse", "--show-object-format"]).trim() as "sha1" | "sha256",
    head: { target, oid: target === null ? rev(r, "HEAD") : facts.refs[target] ?? null },
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    entries: [],
    markers: [],
    ...facts,
  };
}

// A POSIX shell canary under the fixture folder. Git runs it through its shell, so the path uses `/`.
function canary(root: string, facts: Facts, name: string, tail = ""): string {
  const log = join(root, "canaries", `${name}.log`);
  const script = put(root, `canaries/${name}.sh`, `#!/bin/sh\necho "${name} $*" >> '${log.replaceAll("\\", "/")}'\n${tail}`);
  facts.canaries[name] = relative(root, log).replaceAll("\\", "/");
  return `'${script.replaceAll("\\", "/")}'`;
}

function newFacts(): Facts {
  return { repos: {}, canaries: {}, disarm: [], notes: {} };
}

function start(name: string): string {
  return fixtureDir(name);
}

const probes = new Map<string, boolean>();
// Probes one `git init` option once per run in an owned folder.
function requireInit(git: string, option: string, capability: string): void {
  if (!probes.has(option)) {
    const dir = fixtureDir(`probe-${capability}`);
    probes.set(option, ownedGit(git, FIXTURE_ROOT, dir, ["init", "-q", option, "repo"], { allowExit: [0, 128, 129] }).length >= 0 && existsSync(join(dir, "repo", ".git")));
  }
  if (!probes.get(option)) throw new CapabilitySkip(capability);
}
// Writes two names that differ only in letter case in an owned folder, once per run. One file means a case-insensitive file system.
function caseInsensitiveFs(): boolean {
  if (!probes.has("case-insensitive-fs")) {
    const dir = fixtureDir("probe-case-insensitive-fs");
    writeFileSync(join(dir, "case"), "lower\n");
    writeFileSync(join(dir, "CASE"), "upper\n");
    probes.set("case-insensitive-fs", readdirSync(dir).length === 1);
  }
  return probes.get("case-insensitive-fs")!;
}
const requireSha256 = (git: string) => requireInit(git, "--object-format=sha256", "sha256-object-format");
const requireReftable = (git: string) => requireInit(git, "--ref-format=reftable", "reftable");

// F01: empty and unborn repositories, first added text, empty files.
export function buildF01(git: string, name: string, variant: "empty" | "unborn-added"): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  if (variant === "empty") {
    facts.repos.repo = repoFacts(r, { refs: {} });
  } else {
    put(r.dir, "first.txt", "first line\n");
    put(r.dir, "empty.txt", "");
    add(r, "first.txt", "empty.txt");
    put(r.dir, "untracked-empty.txt", "");
    normalizeIndex(r);
    facts.repos.repo = repoFacts(r, {
      refs: {},
      staged: ["empty.txt", "first.txt"],
      untracked: ["untracked-empty.txt"],
      entries: [{ path: "empty.txt", stage: 0, mode: "100644", oid: blob(r, "") }, { path: "first.txt", stage: 0, mode: "100644" }],
    });
  }
  return { id: "F01", variant, root, facts };
}

// F02: multiple hunks, one path staged and unstaged, unrelated staged paths. T091 adds the racy variant.
export function buildF02(git: string, name: string): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  const text = (changed: number[]) => lines(40, (n) => (changed.includes(n) ? `line ${n} changed\n` : `line ${n}\n`));
  put(r.dir, "multi.txt", text([]));
  put(r.dir, "other-a.txt", "a\n");
  put(r.dir, "keep.txt", "keep\n");
  add(r, "multi.txt", "other-a.txt", "keep.txt");
  const base = commit(r, "base");
  put(r.dir, "multi.txt", text([3]));
  put(r.dir, "other-a.txt", "a changed\n");
  put(r.dir, "other-b.txt", "b\n");
  add(r, "multi.txt", "other-a.txt", "other-b.txt");
  put(r.dir, "multi.txt", text([3, 20, 36]));
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, {
    refs: { "refs/heads/main": base },
    staged: ["multi.txt", "other-a.txt", "other-b.txt"],
    unstaged: ["multi.txt"],
  });
  // Changed line numbers per hunk. Each line lies more than six lines from the next, so each forms its own hunk.
  facts.notes.hunks = { "multi.txt": { staged: [3], unstaged: [20, 36] } };
  return { id: "F02", variant: "base", root, facts };
}

// F03: Unicode, spaced, option-like, and bracket names, missing final newlines, a long path, a case-only rename, case-colliding and invalid UTF-8 index paths.
export function buildF03(git: string, name: string): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  const names = { unicode: "space dir/雪 café.txt", dash: "-rf", option: "--output=x", bracket: "[abc].txt", glob: "a.txt", noNewline: "no-newline.txt", readme: "Readme.md" };
  put(r.dir, names.unicode, "snow\n");
  put(r.dir, names.dash, "dash\n");
  put(r.dir, names.option, "option\n");
  put(r.dir, names.bracket, "bracket\n");
  put(r.dir, names.glob, "glob target\n");
  put(r.dir, names.noNewline, "no final newline");
  put(r.dir, names.readme, "readme\n");
  add(r, ...Object.values(names));
  const x = blob(r, "collide\n");
  indexInfo(r, [["100644", x, 0, "collide/Name.txt"], ["100644", x, 0, "collide/name.txt"]]);
  put(r.dir, "collide/Name.txt", "collide\n");
  const base = commit(r, "base");
  put(r.dir, names.unicode, "snow changed\n");
  put(r.dir, names.bracket, "bracket changed\n");
  put(r.dir, names.noNewline, "no final newline, changed");
  put(r.dir, names.dash, "dash changed\n");
  add(r, names.dash);
  run(r, ["mv", "--", names.readme, "README.md"]);
  const invalid = Buffer.concat([Buffer.from("bad-"), Buffer.from([0xff]), Buffer.from(".txt")]);
  indexInfo(r, [["100644", blob(r, "invalid name\n"), 0, invalid]]);
  // A relative path of 275 UTF-16 units, so every absolute form is also above 260.
  const longPath = `long-path/${"a".repeat(200)}/${"b".repeat(60)}.txt`;
  let bunWrote = false;
  try {
    put(r.dir, longPath, "long\n");
    bunWrote = readFileSync(join(r.dir, longPath), "utf8") === "long\n";
  } catch {
    bunWrote = false;
  }
  normalizeIndex(r);
  const invalidKey = invalid.toString("utf8");
  // A case-sensitive file system holds only `collide/Name.txt`, so Git reports `collide/name.txt` as deleted.
  const caseInsensitive = caseInsensitiveFs();
  // Git without `core.longpaths` cannot open the long file where the native rules hold a path limit. Elsewhere Git lists it as untracked.
  const longUntracked = bunWrote && NATIVE.gitPathUnitLimit === null ? [longPath] : [];
  facts.repos.repo = repoFacts(r, {
    refs: { "refs/heads/main": base },
    untracked: longUntracked,
    staged: sorted([names.dash, names.readme, "README.md", invalidKey]),
    unstaged: sorted([names.unicode, names.bracket, names.noNewline, invalidKey, ...(caseInsensitive ? [] : ["collide/name.txt"])]),
    entries: [
      { path: "collide/Name.txt", stage: 0, oid: x },
      { path: "collide/name.txt", stage: 0, oid: x },
      { path: "README.md", stage: 0 },
      { path: names.option, stage: 0 },
      { path: names.bracket, stage: 0 },
    ],
  });
  // The long file is in a Git listing only where `longUntracked` holds it.
  facts.notes.longPath = { path: longPath, utf16Units: longPath.length, bunWrote };
  facts.notes.invalidUtf8IndexPath = invalid.toString("hex");
  const unverified = [...(bunWrote ? [] : ["long-paths"]), ...(caseInsensitive ? [] : ["case-insensitive-fs"])];
  if (unverified.length > 0) facts.notes.unverified = unverified;
  return { id: "F03", variant: "base", root, facts };
}

// The F05 and F07 submodule source. Two commits; `.gitattributes` names a filter that only the submodule configuration defines.
function submoduleSource(git: string, root: string): { first: string; second: string } {
  const s = init(git, join(root, "sub-src"));
  put(s.dir, ".gitattributes", "*.txt filter=subcanary\n");
  put(s.dir, "s.txt", "first\n");
  add(s, ".gitattributes", "s.txt");
  const first = commit(s, "sub first");
  put(s.dir, "s.txt", "second\n");
  add(s, "s.txt");
  return { first, second: commit(s, "sub second") };
}

// Local paths use the `file` transport. `-c` allows it for this command only and leaves every configuration file unchanged.
const FILE_ALLOW = ["-c", "protocol.file.allow=always"];

function addSubmodule(r: Repo, path: string): Repo {
  run(r, [...FILE_ALLOW, "submodule", "add", "-q", "--", "../sub-src", path]);
  const s: Repo = { git: r.git, dir: join(r.dir, path), pre: [] };
  lineEndings(s);
  return s;
}

// F05: rename, binary, invalid UTF-8, mode and type change, symbolic link, submodule, LFS, custom filter, and encoding conversion.
export function buildF05(git: string, name: string): Built {
  const root = start(name);
  const facts = newFacts();
  const subs = submoduleSource(git, root);
  const r = init(git, join(root, "super"));
  // Git for Windows sets `core.symlinks` from a probe. A fixed value keeps the `link` entry a plain file in both builds.
  run(r, ["config", "core.symlinks", "false"]);
  const binary = (n: number) => Uint8Array.from({ length: 256 }, (_, i) => (i * 7 + n) % 256);
  const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
  const pointer = (n: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${String(n).repeat(64).slice(0, 64)}\nsize 1024\n`;
  put(r.dir, ".gitattributes", "*.cf filter=custom\n*.u16 text working-tree-encoding=UTF-16LE-BOM eol=lf\n*.psd filter=lfs diff=lfs merge=lfs -text\n");
  put(r.dir, "rename-src.txt", lines(10, (n) => `rename ${n}\n`));
  put(r.dir, "binary.dat", binary(0));
  put(r.dir, "invalid-utf8.txt", Buffer.from([0x6f, 0x6b, 0x20, 0xff, 0xfe, 0x0a]));
  put(r.dir, "mode.sh", "#!/bin/sh\necho mode\n");
  put(r.dir, "type-change.txt", "file\n");
  put(r.dir, "custom.cf", "custom\n");
  put(r.dir, "text.u16", utf16("utf16 text\n"));
  put(r.dir, "asset.psd", pointer(1));
  add(r, ".gitattributes", "rename-src.txt", "binary.dat", "invalid-utf8.txt", "mode.sh", "type-change.txt", "custom.cf", "text.u16", "asset.psd");
  indexInfo(r, [["120000", blob(r, "binary.dat"), 0, "link"]]);
  put(r.dir, "link", "binary.dat");
  const same = addSubmodule(r, "sub-same");
  const moved = addSubmodule(r, "sub-moved");
  run(moved, ["checkout", "-q", "--detach", subs.first]);
  add(r, "sub-moved");
  const base = commit(r, "base");
  run(moved, ["checkout", "-q", "--detach", subs.second]);
  run(r, ["mv", "--", "rename-src.txt", "rename-dst.txt"]);
  run(r, ["update-index", "--chmod=+x", "--", "mode.sh"]);
  indexInfo(r, [["120000", blob(r, "binary.dat"), 0, "type-change.txt"]]);
  put(r.dir, "binary.dat", binary(1));
  put(r.dir, "invalid-utf8.txt", Buffer.from([0x6f, 0x6b, 0x20, 0xfe, 0xff, 0x0a]));
  put(r.dir, "link", "mode.sh");
  put(r.dir, "custom.cf", "custom changed\n");
  put(r.dir, "text.u16", utf16("utf16 text changed\n"));
  put(r.dir, "asset.psd", pointer(2));
  normalizeIndex(r);
  facts.repos.super = repoFacts(r, {
    refs: { "refs/heads/main": base },
    staged: ["mode.sh", "rename-dst.txt", "rename-src.txt", "type-change.txt"],
    unstaged: ["asset.psd", "binary.dat", "custom.cf", "invalid-utf8.txt", "link", "sub-moved", "text.u16", "type-change.txt"],
    entries: [
      { path: "link", stage: 0, mode: "120000" },
      { path: "type-change.txt", stage: 0, mode: "120000" },
      { path: "mode.sh", stage: 0, mode: "100755" },
      { path: "sub-same", stage: 0, mode: "160000", oid: subs.second },
      { path: "sub-moved", stage: 0, mode: "160000", oid: subs.first },
    ],
  });
  facts.notes.submodules = { "sub-same": { recorded: subs.second, checkedOut: subs.second }, "sub-moved": { recorded: subs.first, checkedOut: subs.second } };
  // Canaries come last, because every later index read would run the monitor.
  for (const s of [same, moved]) {
    const key = relative(root, s.dir).replaceAll("\\", "/");
    run(s, ["config", "core.fsmonitor", canary(root, facts, `${key.replaceAll("/", "-")}-fsmonitor`, "exit 1\n")]);
    run(s, ["config", "filter.subcanary.clean", canary(root, facts, `${key.replaceAll("/", "-")}-clean`, "exec cat\n")]);
  }
  run(r, ["config", "filter.custom.clean", canary(root, facts, "custom-clean", "exec cat\n")]);
  facts.disarm = ["-c", "filter.custom.clean="];
  return { id: "F05", variant: "base", root, facts };
}

// F06: added and deleted text, and a staged deletion followed by an untracked replacement.
export function buildF06(git: string, name: string): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  put(r.dir, "deleted.txt", "deleted\n");
  put(r.dir, "replaced.txt", "old\n");
  put(r.dir, "keep.txt", "keep\n");
  add(r, "deleted.txt", "replaced.txt", "keep.txt");
  const base = commit(r, "base");
  put(r.dir, "added.txt", "added\n");
  add(r, "added.txt");
  rmSync(join(r.dir, "deleted.txt"));
  run(r, ["rm", "-q", "--", "replaced.txt"]);
  put(r.dir, "replaced.txt", "new\n");
  put(r.dir, "untracked.txt", "untracked\n");
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, {
    refs: { "refs/heads/main": base },
    staged: ["added.txt", "replaced.txt"],
    unstaged: ["deleted.txt"],
    untracked: ["replaced.txt", "untracked.txt"],
  });
  return { id: "F06", variant: "base", root, facts };
}

// F07: two linked worktrees with distinct indexes, junction aliases, a submodule checkout, a separate Git folder, a bare repository, and a `.git` file with a missing target.
export function buildF07(git: string, name: string): Built {
  const root = start(name);
  const facts = newFacts();
  const main = init(git, join(root, "main"));
  put(main.dir, "shared.txt", "shared\n");
  add(main, "shared.txt");
  const base = commit(main, "base");
  run(main, ["worktree", "add", "-q", "-b", "wt-a", "../wt-a"]);
  run(main, ["worktree", "add", "-q", "-b", "wt-b", "../wt-b"]);
  const a: Repo = { git, dir: join(root, "wt-a"), pre: [] };
  const b: Repo = { git, dir: join(root, "wt-b"), pre: [] };
  put(a.dir, "a-only.txt", "a\n");
  add(a, "a-only.txt");
  put(b.dir, "shared.txt", "shared in b\n");
  add(b, "shared.txt");
  for (const r of [main, a, b]) normalizeIndex(r);
  const refs = { "refs/heads/main": base, "refs/heads/wt-a": base, "refs/heads/wt-b": base };
  facts.repos.main = repoFacts(main, { refs });
  facts.repos["wt-a"] = repoFacts(a, { refs, staged: ["a-only.txt"] });
  facts.repos["wt-b"] = repoFacts(b, { refs, staged: ["shared.txt"] });

  const aliases: Record<string, string> = { "alias-main": "main", "alias-wt-a": "wt-a" };
  try {
    for (const [alias, target] of Object.entries(aliases)) symlinkSync(join(root, target), join(root, alias), "junction");
    facts.notes.junctions = aliases;
  } catch {
    facts.notes.unverified = ["junction"];
  }

  const subs = submoduleSource(git, root);
  const sup = init(git, join(root, "super"));
  const sub = addSubmodule(sup, "sub");
  const supBase = commit(sup, "super base");
  normalizeIndex(sup);
  normalizeIndex(sub);
  facts.repos.super = repoFacts(sup, { refs: { "refs/heads/main": supBase }, entries: [{ path: "sub", stage: 0, mode: "160000", oid: subs.second }] });
  facts.repos["super/sub"] = repoFacts(sub, {
    refs: { "refs/heads/main": subs.second, "refs/remotes/origin/HEAD": subs.second, "refs/remotes/origin/main": subs.second },
  });

  const separate = init(git, join(root, "separate"), ["--separate-git-dir", join(root, "separate.git")]);
  put(separate.dir, "file.txt", "separate\n");
  add(separate, "file.txt");
  const sepBase = commit(separate, "separate base");
  normalizeIndex(separate);
  facts.repos.separate = repoFacts(separate, { refs: { "refs/heads/main": sepBase } });

  run({ git, dir: root, pre: [] }, ["init", "-q", "--bare", "-b", "main", "bare.git"]);
  put(root, "broken/.git", "gitdir: ../missing.git\n");
  put(root, "broken/file.txt", "broken\n");
  facts.notes.unopenable = { bare: "bare.git", missingGitdir: "broken", administrationFolder: "main/.git" };
  return { id: "F07", variant: "base", root, facts };
}

// F08: SHA-1 and SHA-256 object formats, detached HEAD, and two branches at one object ID.
export function buildF08(git: string, name: string, variant: "sha1" | "sha256" | "detached"): Built {
  if (variant === "sha256") requireSha256(git);
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"), variant === "sha256" ? ["--object-format=sha256"] : []);
  put(r.dir, "file.txt", "one\n");
  add(r, "file.txt");
  const first = commit(r, "first");
  put(r.dir, "file.txt", "two\n");
  add(r, "file.txt");
  const second = commit(r, "second");
  run(r, ["branch", "twin"]);
  if (variant === "detached") run(r, ["checkout", "-q", "--detach", first]);
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, { refs: { "refs/heads/main": second, "refs/heads/twin": second } });
  facts.notes.commits = { first, second };
  return { id: "F08", variant, root, facts };
}

export type F10Variant = "lock" | "merge" | "rebase" | "cherry-pick" | "sequencer" | "am" | "revert" | "split-index" | "split-config" | "flags" | "sparse";

// F10: locks, conflicts, unfinished operations, split index, index flags, and a sparse checkout with a full index.
// The global-scope `core.splitIndex` case and `GIT_TEST_SPLIT_INDEX` belong to the test, because the owned global file serves every fixture in a run.
export function buildF10(git: string, name: string, variant: F10Variant): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  put(r.dir, "conflict.txt", "base\n");
  put(r.dir, "keep.txt", "keep\n");
  add(r, "conflict.txt", "keep.txt");
  const base = commit(r, "base");
  const refs: Record<string, string> = { "refs/heads/main": base };
  const conflictFacts = (marker: string, extra: Partial<RepoFacts> = {}) =>
    repoFacts(r, {
      refs,
      conflicted: ["conflict.txt"],
      staged: ["conflict.txt"],
      unstaged: ["conflict.txt"],
      entries: [1, 2, 3].map((stage) => ({ path: "conflict.txt", stage })),
      markers: [marker],
      ...extra,
    });
  const side = (branch: string, from: string, text: string) => {
    run(r, ["checkout", "-q", "-b", branch, from]);
    put(r.dir, "conflict.txt", text);
    add(r, "conflict.txt");
    refs[`refs/heads/${branch}`] = commit(r, branch);
    run(r, ["checkout", "-q", "main"]);
  };
  const onMain = (text: string, message: string) => {
    put(r.dir, "conflict.txt", text);
    add(r, "conflict.txt");
    return (refs["refs/heads/main"] = commit(r, message));
  };
  switch (variant) {
    case "lock":
      normalizeIndex(r);
      put(join(r.dir, ".git"), "index.lock", "");
      put(join(r.dir, ".git"), "refs/heads/main.lock", "");
      facts.repos.repo = repoFacts(r, { refs, markers: ["index.lock"] });
      facts.notes.locks = [".git/index.lock", ".git/refs/heads/main.lock"];
      break;
    case "merge":
      side("side", base, "side\n");
      onMain("main\n", "main");
      run(r, ["merge", "--no-edit", "side"], { allowExit: [1] });
      normalizeIndex(r);
      facts.repos.repo = conflictFacts("MERGE_HEAD");
      break;
    case "cherry-pick":
      side("side", base, "side\n");
      onMain("main\n", "main");
      run(r, ["cherry-pick", "side"], { allowExit: [1] });
      normalizeIndex(r);
      facts.repos.repo = conflictFacts("CHERRY_PICK_HEAD");
      break;
    case "sequencer": {
      // The first pick conflicts. A plain `git commit` then removes CHERRY_PICK_HEAD, and `sequencer/` stays for the second pick.
      side("side", base, "side\n");
      run(r, ["checkout", "-q", "side"]);
      put(r.dir, "second.txt", "second\n");
      add(r, "second.txt");
      refs["refs/heads/side"] = commit(r, "second");
      run(r, ["checkout", "-q", "main"]);
      onMain("main\n", "main");
      run(r, ["cherry-pick", "side~1", "side"], { allowExit: [1] });
      put(r.dir, "conflict.txt", "resolved\n");
      add(r, "conflict.txt");
      run(r, ["commit", "-q", "--no-verify", "--no-edit"]);
      refs["refs/heads/main"] = rev(r, "HEAD");
      normalizeIndex(r);
      facts.repos.repo = repoFacts(r, { refs, markers: ["sequencer"] });
      break;
    }
    case "am": {
      // The patch changes the `base` line that main replaced, so `git am` stops and keeps `rebase-apply/applying`.
      side("side", base, "side\n");
      onMain("main\n", "main");
      const patch = run(r, ["format-patch", "-1", "--stdout", "side"]);
      run(r, ["am", "-q"], { input: Buffer.from(patch), allowExit: [128] });
      normalizeIndex(r);
      facts.repos.repo = repoFacts(r, { refs, markers: ["rebase-apply", "rebase-apply/applying"] });
      break;
    }
    case "revert": {
      const middle = onMain("middle\n", "middle");
      onMain("last\n", "last");
      run(r, ["revert", "--no-edit", middle], { allowExit: [1] });
      normalizeIndex(r);
      facts.repos.repo = conflictFacts("REVERT_HEAD");
      break;
    }
    case "rebase": {
      side("topic", base, "topic\n");
      const tip = onMain("main\n", "main");
      run(r, ["checkout", "-q", "topic"]);
      run(r, ["rebase", "main"], { allowExit: [1] });
      normalizeIndex(r);
      facts.repos.repo = { ...conflictFacts("rebase-merge"), head: { target: null, oid: tip } };
      break;
    }
    case "split-index":
      normalizeIndex(r);
      run(r, ["update-index", "--split-index"]);
      facts.repos.repo = repoFacts(r, { refs });
      facts.notes.splitIndex = "link extension";
      break;
    case "split-config":
      normalizeIndex(r);
      run(r, ["config", "core.splitIndex", "true"]);
      facts.repos.repo = repoFacts(r, { refs });
      facts.notes.splitIndex = "local core.splitIndex=true, unsplit index";
      break;
    case "flags":
      put(r.dir, "ita.txt", "intent\n");
      run(r, ["add", "--intent-to-add", "--", "ita.txt"]);
      run(r, ["update-index", "--assume-unchanged", "--", "keep.txt"]);
      run(r, ["update-index", "--skip-worktree", "--", "conflict.txt"]);
      normalizeIndex(r);
      facts.repos.repo = repoFacts(r, {
        refs,
        unstaged: ["ita.txt"],
        entries: [
          { path: "ita.txt", stage: 0, intentToAdd: true, assumeUnchanged: false, skipWorktree: false },
          { path: "keep.txt", stage: 0, intentToAdd: false, assumeUnchanged: true, skipWorktree: false },
          { path: "conflict.txt", stage: 0, intentToAdd: false, assumeUnchanged: false, skipWorktree: true },
        ],
      });
      break;
    case "sparse":
      put(r.dir, "in/inside.txt", "inside\n");
      put(r.dir, "out/outside.txt", "outside\n");
      add(r, "in/inside.txt", "out/outside.txt");
      refs["refs/heads/main"] = commit(r, "folders");
      run(r, ["sparse-checkout", "set", "--no-cone", "/in/", "/*.txt"]);
      normalizeIndex(r);
      facts.repos.repo = repoFacts(r, {
        refs,
        entries: [
          { path: "in/inside.txt", stage: 0, skipWorktree: false },
          { path: "out/outside.txt", stage: 0, skipWorktree: true },
        ],
      });
      facts.notes.sparse = { patterns: ["/in/", "/*.txt"], indexSparse: false };
      break;
  }
  return { id: "F10", variant, root, facts };
}

// The PowerShell quote characters (about_Quoting_Rules). `"` is not valid in a Windows name, so it has no folder.
export const POWERSHELL_QUOTES = ["'", "‘", "’", "‚", "‛", "“", "”", "„"] as const;
export const F15_MARKER = "arbareto-f15-marker";

// F15: a plain folder, a repository for removal and access cases, and hostile-name repositories for the dubious-ownership message.
// Another owner and a full disposable volume need host capabilities that a fixture cannot create.
export function buildF15(git: string, name: string): Built {
  const root = start(name);
  const facts = newFacts();
  put(root, "plain/file.txt", "plain\n");
  const simple = (rel: string) => {
    const r = init(git, join(root, rel));
    put(r.dir, "file.txt", "file\n");
    add(r, "file.txt");
    const oid = commit(r, "base");
    normalizeIndex(r);
    facts.repos[rel] = repoFacts(r, { refs: { "refs/heads/main": oid } });
  };
  simple("repo");
  // The hostile names test the PowerShell remedy of the Windows slice (contract §4 "Quoting rule").
  const hostile = process.platform === "win32" ? POWERSHELL_QUOTES.map((q) => `x${q}$(ni ${F15_MARKER})${q}`) : [];
  for (const folder of hostile) simple(`hostile/${folder}`);
  facts.notes.plain = "plain";
  facts.notes.hostile = hostile;
  facts.notes.marker = F15_MARKER;
  facts.notes.unverified = ["other-account-owner", "disposable-volume"];
  return { id: "F15", variant: "base", root, facts };
}

export const F16_STATUS_RECORDS = 100_000;

// F16 status part: exactly 100,000 status records and one more. Each record is a committed path without a working file.
export function buildF16Status(git: string, name: string, variant: "at-limit" | "over-limit"): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  const count = F16_STATUS_RECORDS + (variant === "over-limit" ? 1 : 0);
  const x = blob(r, "x\n");
  const paths = Array.from({ length: count }, (_, i) => `missing/${String(i).padStart(6, "0")}.txt`);
  indexInfo(r, paths.map((p) => ["100644", x, 0, p] as const) as [string, string, number, string][]);
  const base = commit(r, "many paths");
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, { refs: { "refs/heads/main": base }, unstaged: paths });
  facts.notes.records = count;
  return { id: "F16", variant: `status-${variant}`, root, facts };
}

const IDENT = "Arbareto Fixture <fixture@arbareto.invalid>";

export interface FiCommit {
  mark: number;
  ref?: string;
  time: number;
  message: string | Uint8Array;
  from?: number;
  merge?: number[];
  files?: Record<string, string | Uint8Array>;
  author?: string | Uint8Array;
  encoding?: string;
}

const data = (bytes: string | Uint8Array) => {
  const b = Buffer.from(bytes);
  return Buffer.concat([Buffer.from(`data ${b.length}\n`), b, Buffer.from("\n")]);
};

// One `git fast-import` commit command. Blobs are inline, and a commit without `from` is a root.
export function fiCommit(c: FiCommit): Buffer {
  const parts: Buffer[] = [
    Buffer.from(`commit ${c.ref ?? "refs/heads/main"}\nmark :${c.mark}\n`),
    Buffer.concat([Buffer.from("author "), Buffer.from(c.author ?? IDENT), Buffer.from(` ${c.time} +0000\n`)]),
    Buffer.from(`committer ${IDENT} ${c.time} +0000\n`),
  ];
  if (c.encoding) parts.push(Buffer.from(`encoding ${c.encoding}\n`));
  parts.push(data(c.message));
  if (c.from !== undefined) parts.push(Buffer.from(`from :${c.from}\n`));
  for (const m of c.merge ?? []) parts.push(Buffer.from(`merge :${m}\n`));
  for (const [path, content] of Object.entries(c.files ?? {})) parts.push(Buffer.from(`M 100644 inline ${path}\n`), data(content));
  parts.push(Buffer.from("\n"));
  return Buffer.concat(parts);
}

// Imports `stream`, checks out main, and returns each mark's object ID.
function importHistory(r: Repo, stream: Buffer): Map<number, string> {
  const marks = join(r.dir, ".git", "arbareto-marks");
  run(r, ["fast-import", "--quiet", `--export-marks=${marks}`], { input: stream });
  const map = new Map<number, string>();
  for (const line of readFileSync(marks, "utf8").trim().split("\n")) {
    const [mark, oid] = line.split(" ");
    map.set(Number(mark!.slice(1)), oid!);
  }
  rmSync(marks);
  run(r, ["reset", "-q", "--hard"]);
  normalizeIndex(r);
  return map;
}

export type F16HistoryVariant = "parents-64" | "parents-65" | "parent-refs" | "object-at-limit" | "object-over-limit" | "traversal";
// The T086 "History page" variant. It stays outside `F16HistoryVariant`, because `tests/git/history-parser.test.ts` maps each member of that type to a parser bound.
export type F16PageVariant = "page-bytes";
export const F16_OBJECT_LIMIT = 256 * 1024;

// The size of a commit object with this message and one parent. The header lines are fixed by `fiCommit`.
function commitObjectBytes(message: number, oidHex: number): number {
  const tree = `tree ${"0".repeat(oidHex)}\n`.length;
  const parent = `parent ${"0".repeat(oidHex)}\n`.length;
  const ident = (word: string) => `${word} ${IDENT} ${FIXED_EPOCH} +0000\n`.length;
  return tree + parent + ident("author") + ident("committer") + 1 + message;
}

// F16 history part: the 64-parent bound, 1,024 parent references per page, the 256 KiB object bound, 100 rows of 2 KiB subjects, and the 8 MiB history page.
export function buildF16History(git: string, name: string, variant: F16HistoryVariant | F16PageVariant): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  const commits: FiCommit[] = [{ mark: 1, time: FIXED_EPOCH, message: "root\n", files: { "h.txt": "root\n" } }];
  let mark = 1;
  const next = (c: Omit<FiCommit, "mark" | "time">) => {
    mark += 1;
    commits.push({ mark, time: FIXED_EPOCH + mark, ...c });
    return mark;
  };
  const octopus = (parents: number, from: number) => {
    const sides = Array.from({ length: parents - 1 }, (_, i) => next({ message: `side ${i}\n`, from: 1, files: { [`side/${mark}.txt`]: `${i}\n` } }));
    return next({ message: `octopus of ${parents}\n`, from, merge: sides });
  };
  const roles: Record<string, number> = { root: 1 };
  if (variant === "parents-64" || variant === "parents-65") roles.tip = octopus(variant === "parents-64" ? 64 : 65, 1);
  if (variant === "parent-refs") {
    // 20 merges of the same 59 side commits fill 80 rows with 1,259 parent references, and no commit exceeds 64 parents.
    const sides = Array.from({ length: 59 }, (_, i) => next({ message: `side ${i}
`, from: 1, files: { [`side/${i}.txt`]: `${i}
` } }));
    let tip = 1;
    for (let i = 0; i < 20; i++) tip = next({ message: `merge ${i}
`, from: tip, merge: sides });
    roles.tip = tip;
  }
  if (variant === "object-at-limit" || variant === "object-over-limit") {
    const target = F16_OBJECT_LIMIT + (variant === "object-over-limit" ? 1 : 0);
    const size = target - commitObjectBytes(0, 40);
    roles.tip = next({ message: `${"m".repeat(size - 1)}\n`, from: 1 });
    facts.notes.objectBytes = target;
  }
  if (variant === "traversal") {
    // 100 commits with 2 KiB subjects stay far below 256 KiB per object. The traversal stream holds only object IDs, so it stays below 128 KiB.
    let tip = 1;
    for (let i = 0; i < 99; i++) tip = next({ message: `${String(i).padStart(3, "0")} ${"t".repeat(2044)}\n`, from: tip });
    roles.tip = tip;
  }
  if (variant === "page-bytes") {
    // 10 commits. Each message is one paragraph of 200 KiB of 0x01 bytes, so each object stays below 256 KiB.
    const message = Buffer.concat([Buffer.alloc(200 * 1024, 0x01), Buffer.from("\n")]);
    commits[0]!.message = message;
    let tip = 1;
    for (let i = 0; i < 9; i++) tip = next({ message, from: tip });
    roles.tip = tip;
  }
  const oids = importHistory(r, Buffer.concat(commits.map(fiCommit)));
  facts.repos.repo = repoFacts(r, { refs: { "refs/heads/main": oids.get(roles.tip!)! } });
  facts.notes.commits = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, oids.get(v)]));
  return { id: "F16", variant: `history-${variant}`, root, facts };
}

export type F17Variant = "trust" | "partial-reset-soft" | "partial-read-tree" | "partial-tree-none";

// F17: hostile repository content and repository-scope programs with execution canaries. The partial-clone variants make a new clone on each call.
export function buildF17(git: string, name: string, variant: F17Variant): Built {
  const root = start(name);
  const facts = newFacts();
  if (variant === "trust") {
    const r = init(git, join(root, "repo"));
    put(r.dir, "README.md", `# <img src=x onerror="alert(1)"> <script>alert('x')</script>\n$(ni canary) \`whoami\` %PATH%\n`);
    put(r.dir, ".env", "SECRET=arbareto-env-canary\n");
    put(r.dir, "bunfig.toml", 'preload = ["./evil.ts"]\n');
    put(r.dir, "evil.ts", "throw new Error('arbareto bunfig canary');\n");
    // The clean filter runs with the worktree top as its working folder, so its log path is relative.
    put(r.dir, "tools/clean.sh", "#!/bin/sh\necho clean >> .git/arbareto-clean-canary.log\nexec cat\n");
    put(r.dir, ".gitattributes", "*.dat filter=canary\n*.prc filter=proc\n*.tcv diff=tcv\n");
    put(r.dir, "data.dat", "data\n");
    put(r.dir, "data.prc", "process\n");
    add(r, "README.md", ".env", "bunfig.toml", "evil.ts", "tools/clean.sh", ".gitattributes", "data.dat", "data.prc");
    run(r, ["update-index", "--chmod=+x", "--", "tools/clean.sh"]);
    const base = commit(r, "base <b>markup</b>");
    put(r.dir, "untracked.tcv", "textconv input\n");
    put(r.dir, "untracked.dat", "filtered untracked\n");
    normalizeIndex(r);
    facts.repos.repo = repoFacts(r, {
      refs: { "refs/heads/main": base },
      untracked: ["untracked.dat", "untracked.tcv"],
      entries: [{ path: "tools/clean.sh", stage: 0, mode: "100755" }],
    });
    facts.canaries.clean = "repo/.git/arbareto-clean-canary.log";
    run(r, ["config", "filter.canary.clean", "./tools/clean.sh"]);
    run(r, ["config", "filter.proc.process", canary(root, facts, "process", "exit 1\n")]);
    run(r, ["config", "core.fsmonitor", canary(root, facts, "fsmonitor", "exit 1\n")]);
    run(r, ["config", "diff.external", canary(root, facts, "diff-external")]);
    run(r, ["config", "diff.tcv.textconv", canary(root, facts, "textconv", 'cat "$1"\n')]);
    run(r, ["config", "http.extraheader", "Authorization: Bearer ARBARETO-EXTRAHEADER-CANARY"]);
    run(r, ["config", "remote.origin.url", "https://u:ARBARETO-URL-CANARY@host.example/repo.git"]);
    const hook = put(r.dir, ".git/hooks/pre-commit", `#!/bin/sh\nexec ${canary(root, facts, "pre-commit")}\n`);
    chmodSync(hook, 0o755);
    facts.disarm = ["-c", "filter.canary.clean=", "-c", "filter.proc.process=", "-c", "core.fsmonitor=false"];
    facts.notes.secrets = ["ARBARETO-EXTRAHEADER-CANARY", "ARBARETO-URL-CANARY", "arbareto-env-canary"];
    return { id: "F17", variant, root, facts };
  }

  const src = init(git, join(root, "source"));
  run(src, ["config", "uploadpack.allowFilter", "true"]);
  const tips: string[] = [];
  for (let i = 1; i <= 4; i++) {
    put(src.dir, "data.txt", `data version ${i}\n`);
    put(src.dir, "other.txt", `other version ${i}\n`);
    add(src, "data.txt", "other.txt");
    tips.push(commit(src, `version ${i}`));
  }
  const url = pathToFileURL(src.dir).href;
  // partial-tree-none: the HEAD commit is present, and its root tree is missing. The clone has no index.
  const treeNone = variant === "partial-tree-none";
  run({ git, dir: root, pre: [] }, ["clone", "-q", ...(treeNone ? ["--filter=tree:0", "--no-checkout"] : ["--filter=blob:none"]), url, "clone"]);
  const c: Repo = { git, dir: join(root, "clone"), pre: ["--no-lazy-fetch"] };
  lineEndings(c);
  run(c, ["config", "remote.origin.uploadpack", canary(root, facts, "uploadpack", 'exec git-upload-pack "$@"\n')]);
  const old = tips[0]!;
  const tip = tips[3]!;
  if (treeNone) {
    facts.repos.clone = repoFacts(c, { refs: { "refs/heads/main": tip, "refs/remotes/origin/HEAD": tip, "refs/remotes/origin/main": tip } });
    facts.notes.missingTree = run(src, ["rev-parse", `${tip}^{tree}`]).trim();
    facts.notes.commits = { old, tip };
    return { id: "F17", variant, root, facts };
  }
  if (variant === "partial-reset-soft") run(c, ["reset", "-q", "--soft", "HEAD~3"]);
  else run(c, ["read-tree", "HEAD~3"]);
  normalizeIndex(c);
  const missing = run(src, ["ls-tree", "-r", "--object-only", old]).trim().split("\n");
  facts.repos.clone = repoFacts(c, {
    refs: { "refs/heads/main": variant === "partial-reset-soft" ? old : tip, "refs/remotes/origin/HEAD": tip, "refs/remotes/origin/main": tip },
    staged: ["data.txt", "other.txt"],
    unstaged: variant === "partial-read-tree" ? ["data.txt", "other.txt"] : [],
  });
  facts.notes.missingBlobs = missing;
  facts.notes.commits = { old, tip };
  return { id: "F17", variant, root, facts };
}

// F18: refs, packed refs, an index, and working files for missed watcher hints. The reftable variant adds one linked worktree.
export function buildF18(git: string, name: string, variant: "files" | "reftable"): Built {
  if (variant === "reftable") requireReftable(git);
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"), variant === "reftable" ? ["--ref-format=reftable"] : []);
  put(r.dir, "watched.txt", "watched\n");
  put(r.dir, "other.txt", "other\n");
  add(r, "watched.txt", "other.txt");
  const base = commit(r, "base");
  run(r, ["branch", "packed"]);
  if (variant === "files") run(r, ["pack-refs", "--all"]);
  run(r, ["branch", "loose"]);
  const refs: Record<string, string> = { "refs/heads/main": base, "refs/heads/packed": base, "refs/heads/loose": base };
  if (variant === "reftable") {
    run(r, ["worktree", "add", "-q", "-b", "wt", "../wt"]);
    refs["refs/heads/wt"] = base;
    const wt: Repo = { git, dir: join(root, "wt"), pre: [] };
    normalizeIndex(wt);
    facts.repos.wt = repoFacts(wt, { refs });
  }
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, { refs });
  return { id: "F18", variant, root, facts };
}

export type F19Variant = "linear" | "merge" | "octopus" | "skewed" | "roots" | "long" | "wide" | "encoding" | "shallow" | "sha256";

// F19: history shapes. Each variant is one repository whose main branch holds the shape.
export function buildF19(git: string, name: string, variant: F19Variant): Built {
  if (variant === "sha256") requireSha256(git);
  const root = start(name);
  const facts = newFacts();
  const t = (n: number) => FIXED_EPOCH + n;
  // Role name, parent roles (first parent first), and commit fields.
  const shape: [string, string[], Partial<FiCommit>?][] = [];
  const linear = (count: number, prefix = "c") => {
    for (let i = 1; i <= count; i++) shape.push([`${prefix}${i}`, i === 1 ? [] : [`${prefix}${i - 1}`]]);
  };
  switch (variant) {
    case "linear":
    case "sha256":
      linear(5);
      break;
    case "long":
    case "shallow":
      linear(150);
      break;
    case "merge":
      shape.push(["base", []], ["side", ["base"]], ["main", ["base"]], ["merge", ["main", "side"]]);
      break;
    case "octopus":
      shape.push(["base", []], ["a", ["base"]], ["b", ["base"]], ["c", ["base"]], ["octopus", ["c", "a", "b"]]);
      break;
    case "skewed":
      shape.push(["c1", [], { time: t(1000) }], ["c2", ["c1"], { time: t(10) }], ["c3", ["c2"], { time: t(2000) }], ["c4", ["c3"], { time: t(5) }]);
      break;
    case "roots":
      shape.push(["rootA", []], ["a2", ["rootA"]], ["rootB", []], ["b2", ["rootB"]], ["join", ["a2", "b2"]]);
      break;
    case "wide": {
      // 30 branches open at once exceed the 24-lane bound of the history graph.
      shape.push(["base", []]);
      for (let i = 1; i <= 30; i++) shape.push([`b${i}`, ["base"]]);
      let tip = "base";
      for (let i = 1; i <= 30; i++) {
        shape.push([`m${i}`, [tip, `b${i}`]]);
        tip = `m${i}`;
      }
      break;
    }
    case "encoding": {
      linear(2);
      // ISO-8859-1 bytes are invalid UTF-8.
      const latin1 = (s: string) => Buffer.from(s, "latin1");
      shape.push(["legacy", ["c2"], { encoding: "ISO-8859-1", message: latin1("Café résumé\n"), author: latin1("José <jose@arbareto.invalid>") }]);
      break;
    }
  }
  const marks = new Map(shape.map(([role], i) => [role, i + 1]));
  const commits: FiCommit[] = shape.map(([role, parents, extra], i) => ({
    mark: i + 1,
    time: t(i + 1),
    message: `${role}\n`,
    files: { [`${role}.txt`]: `${role}\n` },
    ...(parents.length > 0 ? { from: marks.get(parents[0]!)!, merge: parents.slice(1).map((p) => marks.get(p)!) } : {}),
    ...extra,
  }));
  // A root after the first commit needs a `reset` so that fast-import starts it without a parent.
  const tipRole = shape[shape.length - 1]![0];
  const srcDir = join(root, variant === "shallow" ? "source" : "repo");
  const r = init(git, srcDir, variant === "sha256" ? ["--object-format=sha256"] : []);
  const stream = commits.map((c, i) => (i > 0 && c.from === undefined ? Buffer.concat([Buffer.from(`reset ${c.ref ?? "refs/heads/main"}\n\n`), fiCommit(c)]) : fiCommit(c)));
  const byMark = importHistory(r, Buffer.concat(stream));
  const oids = Object.fromEntries(shape.map(([role]) => [role, byMark.get(marks.get(role)!)!]));
  const tip = oids[tipRole]!;
  facts.notes.parents = Object.fromEntries(shape.map(([role, parents]) => [oids[role], parents.map((p) => oids[p])]));
  facts.notes.tip = tip;
  if (variant === "shallow") {
    const depth = 3;
    run({ git, dir: root, pre: [] }, ["clone", "-q", `--depth=${depth}`, pathToFileURL(r.dir).href, "repo"]);
    const c: Repo = { git, dir: join(root, "repo"), pre: [] };
    lineEndings(c);
    normalizeIndex(c);
    facts.repos.repo = repoFacts(c, { refs: { "refs/heads/main": tip, "refs/remotes/origin/HEAD": tip, "refs/remotes/origin/main": tip } });
    facts.notes.shallow = [oids[`c${150 - depth + 1}`]];
    facts.notes.depth = depth;
  } else {
    facts.repos.repo = repoFacts(r, { refs: { "refs/heads/main": tip } });
  }
  return { id: "F19", variant, root, facts };
}
