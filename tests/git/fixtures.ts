// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Deterministic builders of the plan.md fixture matrix (T066). Facts come from the construction, never from `src/git-service/`.

import { createCipheriv } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ATTRIBUTION_EVIDENCE_RECORDS, COMPARED_RAW_VERSION_BYTES, WHOLE_FILE_STAGE_INPUT_BYTES } from "../../src/contracts/limits";
import { NATIVE } from "../../src/contracts/native-path";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureDir, fixturePath, ownedGit, type OwnedGitOptions } from "./fixture-root";
import { indexEntries, sha256 } from "./git-oracle";

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
    fixFileTimes(path, FIXED_EPOCH);
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

export type F02Variant = "base" | "staged-hunks" | "racy";
export const F02_RACY_PATH = "racy.txt";

// Sets the last-write time, and on Windows also the creation time that Git for Windows stores as `ctime`.
function fixFileTimes(path: string, unixSeconds: number): void {
  utimesSync(path, unixSeconds, unixSeconds);
  if (process.platform === "win32") (require("./win32") as typeof import("./win32")).setFileTimes(path, unixSeconds);
}

// F02: multiple hunks, one path staged and unstaged, unrelated staged paths.
// "base": two unstaged hunks and one staged hunk in `multi.txt`. "staged-hunks": two staged hunks and one unstaged hunk.
// "racy": "base", and `racy.txt` changes with the same size in the second of the last index write (contract §4 "Candidate time").
export function buildF02(git: string, name: string, variant: F02Variant = "base"): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  const text = (changed: number[]) => lines(40, (n) => (changed.includes(n) ? `line ${n} changed\n` : `line ${n}\n`));
  const hunks = variant === "staged-hunks" ? { staged: [3, 36], unstaged: [20] } : { staged: [3], unstaged: [20, 36] };
  const racy = variant === "racy";
  put(r.dir, "multi.txt", text([]));
  put(r.dir, "other-a.txt", "a\n");
  put(r.dir, "keep.txt", "keep\n");
  if (racy) put(r.dir, F02_RACY_PATH, "racy before\n");
  add(r, "multi.txt", "other-a.txt", "keep.txt", ...(racy ? [F02_RACY_PATH] : []));
  const base = commit(r, "base");
  put(r.dir, "multi.txt", text(hunks.staged));
  put(r.dir, "other-a.txt", "a changed\n");
  put(r.dir, "other-b.txt", "b\n");
  add(r, "multi.txt", "other-a.txt", "other-b.txt");
  put(r.dir, "multi.txt", text([...hunks.staged, ...hunks.unstaged]));
  normalizeIndex(r);
  if (racy) {
    // racy-git.adoc: an entry whose mtime is not older than the index file is racily clean, so only a content check finds the change.
    // `normalizeIndex` gave each entry FIXED_EPOCH. The index file gets the same second, and the new bytes keep the size and the times.
    const [indexPath] = run(r, ["rev-parse", "--git-path", "index"]).trimEnd().split("\n");
    utimesSync(resolve(r.dir, indexPath!), FIXED_EPOCH, FIXED_EPOCH);
    fixFileTimes(put(r.dir, F02_RACY_PATH, "racy after!\n"), FIXED_EPOCH);
    facts.notes.racy = { path: F02_RACY_PATH, unixSeconds: FIXED_EPOCH };
  }
  facts.repos.repo = repoFacts(r, {
    refs: { "refs/heads/main": base },
    staged: ["multi.txt", "other-a.txt", "other-b.txt"],
    unstaged: sorted(["multi.txt", ...(racy ? [F02_RACY_PATH] : [])]),
  });
  // Changed line numbers per hunk. Each line lies more than six lines from the next, so each forms its own hunk.
  facts.notes.hunks = { "multi.txt": hunks };
  return { id: "F02", variant, root, facts };
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
  // Data-model §5 shows the invalid byte as `\xNN`.
  const invalidKey = "bad-\\xff.txt";
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
// "file-refusals" adds the Stage file refusals that the base lacks: a staged new symbolic-link entry and an untracked nested repository (contract §4 "File staging").
export function buildF05(git: string, name: string, variant: "base" | "file-refusals" = "base"): Built {
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
  const refusals = variant === "file-refusals";
  if (refusals) {
    indexInfo(r, [["120000", blob(r, "binary.dat"), 0, "new-link"]]);
    put(r.dir, "new-link", "binary.dat");
    // An unborn nested repository has no index, so its Git folder holds no stat data that differs between builds.
    put(init(git, join(r.dir, "nested")).dir, "inner.txt", "inner\n");
  }
  normalizeIndex(r);
  facts.repos.super = repoFacts(r, {
    refs: { "refs/heads/main": base },
    staged: sorted(["mode.sh", "rename-dst.txt", "rename-src.txt", "type-change.txt", ...(refusals ? ["new-link"] : [])]),
    unstaged: ["asset.psd", "binary.dat", "custom.cf", "invalid-utf8.txt", "link", "sub-moved", "text.u16", "type-change.txt"],
    // `ls-files -o` lists a nested repository as its folder name with a final `/`.
    untracked: refusals ? ["nested/"] : [],
    entries: [
      ...(refusals ? [{ path: "new-link", stage: 0, mode: "120000" }] : []),
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
  return { id: "F05", variant, root, facts };
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

// The F02, F05, and F06 entries that Stage file or Unstage file accepts (contract §4 "File staging"), in one repository with local `core.filemode=true`.
// A modified and an untracked binary file, a deleted file, and a mode change: the entry is 100755, and the working file has no execute bit.
// A staged rename, a staged copy under `status.renames=copies`, and an Unstaged rename record from an intent-to-add entry.
// `notes.renames` holds the expected porcelain v2 rename and copy records.
export function buildFileAccepted(git: string, name: string): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  run(r, ["config", "status.renames", "copies"]);
  const binary = (n: number) => Uint8Array.from({ length: 512 }, (_, i) => (i * 13 + n) % 256);
  const text = (word: string) => lines(10, (n) => `${word} line ${n}\n`);
  put(r.dir, "binary.dat", binary(0));
  put(r.dir, "deleted.txt", "deleted\n");
  put(r.dir, "mode.txt", "mode\n");
  put(r.dir, "rename-src.txt", text("rename"));
  put(r.dir, "copy-src.txt", text("copy"));
  put(r.dir, "ita-src.txt", text("ita"));
  add(r, "binary.dat", "deleted.txt", "mode.txt", "rename-src.txt", "copy-src.txt", "ita-src.txt");
  run(r, ["update-index", "--chmod=+x", "--", "mode.txt"]);
  const base = commit(r, "base");
  put(r.dir, "binary.dat", binary(1));
  put(r.dir, "untracked.dat", binary(2));
  rmSync(join(r.dir, "deleted.txt"));
  run(r, ["mv", "--", "rename-src.txt", "rename-dst.txt"]);
  // Git detects copies only from a changed source (diffcore-rename.c), so the source changes too.
  put(r.dir, "copy-dst.txt", text("copy"));
  put(r.dir, "copy-src.txt", `${text("copy")}copy changed\n`);
  add(r, "copy-dst.txt", "copy-src.txt");
  rmSync(join(r.dir, "ita-src.txt"));
  put(r.dir, "ita-dst.txt", text("ita"));
  run(r, ["add", "--intent-to-add", "--", "ita-dst.txt"]);
  run(r, ["config", "core.filemode", "true"]);
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, {
    refs: { "refs/heads/main": base },
    staged: ["copy-dst.txt", "copy-src.txt", "rename-dst.txt", "rename-src.txt"],
    unstaged: ["binary.dat", "deleted.txt", "ita-dst.txt", "ita-src.txt", "mode.txt"],
    untracked: ["untracked.dat"],
    entries: [
      { path: "mode.txt", stage: 0, mode: "100755" },
      { path: "ita-dst.txt", stage: 0, intentToAdd: true },
    ],
  });
  facts.notes.filemode = { repo: "true" };
  facts.notes.modeChange = { path: "mode.txt", index: "100755", working: "100644" };
  facts.notes.renames = [
    { xy: "R.", path: "rename-dst.txt", orig: "rename-src.txt" },
    { xy: "C.", path: "copy-dst.txt", orig: "copy-src.txt" },
    { xy: ".R", path: "ita-dst.txt", orig: "ita-src.txt" },
  ];
  return { id: "F06", variant: "file-accepted", root, facts };
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

export type F10Variant = "lock" | "merge" | "rebase" | "cherry-pick" | "sequencer" | "am" | "revert" | "split-index" | "split-config" | "split-global" | "flags" | "sparse";

// A global file of one fixture: the shared owned global file plus `extra`. A test points `GIT_CONFIG_GLOBAL` at it.
// `notes[key]` holds its path relative to the fixture folder.
function ownedGlobal(root: string, facts: Facts, key: string, extra: string): string {
  const path = put(root, `${key}.gitconfig`, readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8") + extra);
  facts.notes[key] = `${key}.gitconfig`;
  return path;
}

// F10: locks, conflicts, unfinished operations, split index, index flags, and a sparse checkout with a full index.
// "split-global" writes `core.splitIndex=true` into a fixture global file. `GIT_TEST_SPLIT_INDEX` belongs to the test.
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
    case "split-global":
      normalizeIndex(r);
      ownedGlobal(root, facts, "globalConfig", "[core]\n\tsplitIndex = true\n");
      facts.repos.repo = repoFacts(r, { refs });
      facts.notes.splitIndex = "global core.splitIndex=true, unsplit index";
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

export type F04Variant = "autocrlf-false" | "autocrlf-true" | "autocrlf-input" | "eol-crlf" | "safecrlf" | "attributes";
export type EolStyle = "lf" | "crlf" | "mixed";
const EOL_STYLES: EolStyle[] = ["lf", "crlf", "mixed"];

// Twelve lines. A mixed file ends odd lines with CRLF and even lines with LF. Lines 2 and 11 form two hunks.
function eolText(style: EolStyle, changed: boolean): string {
  return lines(12, (n) => `line ${n}${changed && (n === 2 || n === 11) ? " changed" : ""}${style === "crlf" || (style === "mixed" && n % 2 === 1) ? "\r\n" : "\n"}`);
}

// `ls-files --eol -z` (builtin/ls-files.c `write_eolinfo`): "i/%-5s w/%-5s attr/%-17s" and a tab before each path.
export function eolInfo(r: Repo): Record<string, { index: string; working: string; attr: string }> {
  const info: Record<string, { index: string; working: string; attr: string }> = {};
  for (const record of run(r, ["ls-files", "--eol", "-z"]).split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const head = record.slice(0, tab);
    const w = head.indexOf(" w/");
    const a = head.indexOf(" attr/");
    info[record.slice(tab + 1)] = { index: head.slice(2, w).trim(), working: head.slice(w + 3, a).trim(), attr: head.slice(a + 6).trim() };
  }
  return info;
}

// F04: LF, CRLF, and mixed files under each `core.autocrlf` value, `core.eol`, `core.safecrlf`, and the line-ending attributes.
// Git commits each file under the variant configuration. Each working file then changes lines 2 and 11 and keeps its line endings.
// "safecrlf" sets `core.safecrlf=true` after the commit, because an LF file under `core.autocrlf=true` fails that check.
export function buildF04(git: string, name: string, variant: F04Variant): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  const config: Record<F04Variant, string[][]> = {
    "autocrlf-false": [],
    "autocrlf-true": [["core.autocrlf", "true"]],
    "autocrlf-input": [["core.autocrlf", "input"]],
    "eol-crlf": [["core.eol", "crlf"]],
    safecrlf: [["core.autocrlf", "true"]],
    attributes: [],
  };
  for (const [key, value] of config[variant]) run(r, ["config", key!, value!]);
  // Folder to attribute line. `core.eol` acts only on files with a `text` attribute or `text=auto`.
  const folders: Record<string, string | null> =
    variant === "attributes" ? { "text/": "*.txt text", "auto/": "*.txt text=auto", "binary/": "*.txt -text", "eol/": "*.txt eol=crlf", "crlf/": "*.txt crlf" } : variant === "eol-crlf" ? { "": "*.txt text=auto" } : { "": null };
  const files: string[] = [];
  const attributeFiles: string[] = [];
  for (const [folder, attribute] of Object.entries(folders)) {
    if (attribute !== null) {
      put(r.dir, `${folder}.gitattributes`, `${attribute}\n`);
      attributeFiles.push(`${folder}.gitattributes`);
    }
    for (const style of EOL_STYLES) {
      put(r.dir, `${folder}${style}.txt`, eolText(style, false));
      files.push(`${folder}${style}.txt`);
    }
  }
  add(r, ...attributeFiles, ...files);
  const base = commit(r, "base");
  if (variant === "safecrlf") run(r, ["config", "core.safecrlf", "true"]);
  for (const path of files) put(r.dir, path, eolText(path.slice(path.lastIndexOf("/") + 1, -4) as EolStyle, true));
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, { refs: { "refs/heads/main": base }, unstaged: sorted(files) });
  facts.notes.eol = eolInfo(r);
  facts.notes.hunks = Object.fromEntries(files.map((p) => [p, { unstaged: [2, 11] }]));
  return { id: "F04", variant, root, facts };
}

export type F04StageVariant = "index-crlf" | "index-attribute" | "ident-crlf" | "mixed-over-lf" | "ident";
// research.md R3 probe 7: the result of each blob proof for the candidate blob. Every candidate equals `git add`.
export const F04_BLOB_PROOFS: Record<F04StageVariant, { a: boolean; b: boolean }> = {
  "index-crlf": { a: true, b: false },
  "index-attribute": { a: false, b: false },
  "ident-crlf": { a: false, b: false },
  "mixed-over-lf": { a: false, b: true },
  ident: { a: false, b: true },
};

// F04 Stage file cases (contract §4 "Blob proof"). Each repository has one modified `f.txt` whose conversion depends on the index or on `ident`.
// "index-crlf" and "ident-crlf" commit a CRLF blob under `core.autocrlf=false` and then set `core.autocrlf=true`.
// "index-attribute": `*.txt eol=crlf` in a `.gitattributes` that only the index holds. "mixed-over-lf": a mixed working file over an LF blob under `core.autocrlf=true`.
export function buildF04Stage(git: string, name: string, variant: F04StageVariant): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  const attribute = { "index-crlf": null, "index-attribute": "*.txt eol=crlf", "ident-crlf": "*.txt ident", "mixed-over-lf": null, ident: "*.txt ident" }[variant];
  const style: EolStyle = variant === "mixed-over-lf" || variant === "ident" ? "lf" : "crlf";
  const keyword = (s: string) => (attribute === "*.txt ident" ? s.replace("line 5", "$Id$") : s);
  if (attribute !== null) put(r.dir, ".gitattributes", `${attribute}\n`);
  put(r.dir, "f.txt", keyword(eolText(style, false)));
  add(r, "f.txt", ...(attribute !== null ? [".gitattributes"] : []));
  const base = commit(r, "base");
  if (variant !== "ident" && variant !== "index-attribute") run(r, ["config", "core.autocrlf", "true"]);
  if (variant === "index-attribute") rmSync(join(r.dir, ".gitattributes"));
  put(r.dir, "f.txt", keyword(eolText(variant === "mixed-over-lf" ? "mixed" : style, true)));
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, { refs: { "refs/heads/main": base }, unstaged: variant === "index-attribute" ? [".gitattributes", "f.txt"] : ["f.txt"] });
  facts.notes.eol = eolInfo(r);
  facts.notes.blobProofs = F04_BLOB_PROOFS[variant];
  return { id: "F04", variant: `stage-${variant}`, root, facts };
}

const multiText = (changed: number[]) => lines(40, (n) => (changed.includes(n) ? `line ${n} changed\n` : `line ${n}\n`));

// The F09, F11 to F14, and F20 base: a staged `staged.txt`, two unstaged hunks in `multi.txt`, and branch `twin` at HEAD.
// The tests make the external changes, competing commits, and cancellations themselves.
function changedRepo(git: string, root: string, facts: Facts): Repo {
  const r = init(git, join(root, "repo"));
  put(r.dir, "multi.txt", multiText([]));
  put(r.dir, "staged.txt", "staged\n");
  add(r, "multi.txt", "staged.txt");
  const base = commit(r, "base");
  run(r, ["branch", "twin"]);
  put(r.dir, "staged.txt", "staged changed\n");
  add(r, "staged.txt");
  put(r.dir, "multi.txt", multiText([20, 36]));
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, { refs: { "refs/heads/main": base, "refs/heads/twin": base }, staged: ["staged.txt"], unstaged: ["multi.txt"] });
  facts.notes.hunks = { "multi.txt": { staged: [], unstaged: [20, 36] } };
  return r;
}

// F09 and F13: the changed base. F09 tests change files, the index, refs, attributes, and configuration before each checkpoint. F13 tests cancel.
export function buildChanged(git: string, name: string, id: "F09" | "F13"): Built {
  const root = start(name);
  const facts = newFacts();
  changedRepo(git, root, facts);
  return { id, variant: "base", root, facts };
}

export type F11Variant = "traditional" | "configured" | "disabled" | "post-index-change" | "fsmonitor" | "changing" | "rejecting";
export const F11_HOOK_TOKEN = "ARBARETO-HOOK-TOKEN";

// F11: hooks and an index monitor on the changed base. Every program is a canary under the fixture folder.
// `notes.hooks` holds the configured `hook list -z --show-scope` records and the hook-folder files of each event.
export function buildF11(git: string, name: string, variant: F11Variant): Built {
  const root = start(name);
  const facts = newFacts();
  const r = changedRepo(git, root, facts);
  const hooks: Record<string, { configured: string[]; hookFolder: boolean }> = {};
  const hookFile = (event: string, tail = "") => {
    put(r.dir, `.git/hooks/${event}`, `#!/bin/sh\n${canary(root, facts, event)} "$@" || exit 1\n${tail}`);
    hooks[event] = { configured: [], hookFolder: true };
  };
  // Programs come last, because each later index write would run `post-index-change` and each index read the monitor.
  switch (variant) {
    case "traditional":
      for (const event of ["pre-commit", "commit-msg", "post-commit"]) hookFile(event);
      break;
    case "configured":
    case "disabled":
      run(r, ["config", "hook.arbareto-pre.command", canary(root, facts, "configured-pre-commit")]);
      run(r, ["config", "hook.arbareto-pre.event", "pre-commit"]);
      if (variant === "disabled") run(r, ["config", "hook.arbareto-pre.enabled", "false"]);
      hooks["pre-commit"] = { configured: [variant === "disabled" ? "local\tdisabled\tarbareto-pre" : "local\tarbareto-pre"], hookFolder: false };
      break;
    case "post-index-change":
      hookFile("post-index-change");
      break;
    case "fsmonitor":
      run(r, ["config", "core.fsmonitor", canary(root, facts, "fsmonitor", "exit 1\n")]);
      facts.disarm = ["-c", "core.fsmonitor=false"];
      break;
    case "changing":
      // The hook stages one more path, so the commit tree differs from the reviewed index.
      hookFile("pre-commit", "echo hooked >> hooked.txt\ngit add -- hooked.txt\n");
      facts.notes.hookAdds = "hooked.txt";
      break;
    case "rejecting":
      hookFile("pre-commit", `echo "rejected https://u:${F11_HOOK_TOKEN}@host.example/" >&2\nexit 1\n`);
      facts.notes.secrets = [F11_HOOK_TOKEN];
      break;
  }
  facts.notes.hooks = hooks;
  return { id: "F11", variant, root, facts };
}

export type F12Variant = "gc-auto" | "ssh-signing";

// The SHA-1 object ID of a blob (gitformat-loose: "blob <size>\0" and the content).
function blobSha1(content: string): string {
  return new Bun.CryptoHasher("sha1").update(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(content)}\0`), Buffer.from(content)])).digest("hex");
}

// F12: a commit that triggers automatic maintenance, and SSH signing without `user.signingKey`.
// "gc-auto": local `gc.auto=1`. Git estimates the loose count from `objects/17` and runs gc above (gc.auto + 255) / 256 objects there (builtin/gc.c `too_many_loose_objects`).
// "ssh-signing": `gpg.format=ssh`, `commit.gpgsign=true`, and a local `gpg.ssh.defaultKeyCommand` canary.
export function buildF12(git: string, name: string, variant: F12Variant): Built {
  const root = start(name);
  const facts = newFacts();
  const r = changedRepo(git, root, facts);
  if (variant === "gc-auto") {
    const loose: string[] = [];
    for (let n = 0; loose.length < 2; n++) if (blobSha1(`gc-auto ${n}\n`).startsWith("17")) loose.push(`gc-auto ${n}\n`);
    for (const content of loose) if (blob(r, content) !== blobSha1(content)) throw new Error("hash-object disagrees with the loose object ID");
    const [folder] = run(r, ["rev-parse", "--git-path", "objects/17"]).trimEnd().split("\n");
    facts.notes.gcAuto = { threshold: 1, looseIn17: readdirSync(resolve(r.dir, folder!)).length };
    run(r, ["config", "gc.auto", "1"]);
  } else {
    run(r, ["config", "gpg.format", "ssh"]);
    run(r, ["config", "commit.gpgsign", "true"]);
    run(r, ["config", "gpg.ssh.defaultKeyCommand", canary(root, facts, "ssh-default-key")]);
  }
  return { id: "F12", variant, root, facts };
}

export type F14Variant = "slow" | "descendant" | "orphan" | "monitor" | "lingering" | "lock";
// Script mode of the host module: `bun <host> <records> <hold ms> <ready>` writes `<pid>-<creation time>` into <records>, then <ready>, then sleeps.
// Only the path is built here. The generic harness never imports a host module (tests/git/portable-imports.test.ts).
const HOST_SCRIPT = join(import.meta.dir, process.platform === "win32" ? "win32.ts" : "linux.ts");
const READY_POLLS = 200;
const shPath = (path: string) => `'${path.replaceAll("\\", "/")}'`;

// A recorded child of a hook script. `notes.records` names the records folder, and `canaries.ready` the ready file, so a fixture check sees an early start.
// `child` is the shell command. `awaitReady` waits at most READY_POLLS * 50 ms for the ready file.
function recordedChild(root: string, facts: Facts, tag: string): { child: (holdMs: number) => string; awaitReady: string } {
  const records = join(root, "processes");
  const ready = join(root, "ready", tag);
  for (const dir of [records, dirname(ready)]) mkdirSync(dir, { recursive: true });
  facts.notes.records = "processes";
  facts.canaries.ready = relative(root, ready).replaceAll("\\", "/");
  return {
    child: (holdMs) => `${shPath(process.execPath)} ${shPath(HOST_SCRIPT)} ${shPath(records)} ${holdMs} ${shPath(ready)}`,
    awaitReady: `i=0\nwhile [ ! -e ${shPath(ready)} ] && [ $i -lt ${READY_POLLS} ]; do sleep 0.05; i=$((i + 1)); done\n`,
  };
}

// Writes a hook script into the hook folder of `gitDir`.
const hookScript = (gitDir: string, event: string, body: string) => put(gitDir, `hooks/${event}`, `#!/bin/sh\n${body}`);

// F14: slow and descendant-spawning hooks, an orphaned grandchild, a monitor without a daemon, and lingering `post-commit` children.
export function buildF14(git: string, name: string, variant: F14Variant): Built {
  const root = start(name);
  const facts = newFacts();
  const r = changedRepo(git, root, facts);
  const { child, awaitReady } = recordedChild(root, facts, variant);
  const hook = (event: string, body: string) => hookScript(join(r.dir, ".git"), event, body);
  switch (variant) {
    case "slow":
      hook("pre-commit", "exec sleep 600\n");
      break;
    case "descendant":
      hook("pre-commit", `${child(600_000)} &\nwait\n`);
      break;
    case "orphan":
      // The subshell exits at once, so the child becomes an orphaned grandchild. It holds no pipe of the hook.
      hook("pre-commit", `(${child(60_000)} </dev/null >/dev/null 2>&1 &)\n${awaitReady}exit 0\n`);
      break;
    case "monitor":
      // Last, because each later index read would ask for the built-in monitor daemon.
      run(r, ["config", "core.fsmonitor", "true"]);
      facts.disarm = ["-c", "core.fsmonitor=false"];
      break;
    case "lingering":
      hook("post-commit", `${child(60_000)} &\n${awaitReady}exit 0\n`);
      break;
    case "lock": {
      const [lock] = run(r, ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"]).trimEnd().split("\n");
      hook("post-commit", `(: > ${shPath(lock!)}; exec ${child(60_000)}) &\n${awaitReady}exit 0\n`);
      facts.notes.lock = relative(root, lock!).replaceAll("\\", "/");
      break;
    }
  }
  return { id: "F14", variant, root, facts };
}

export type F16ComparisonVariant = "side-at-limit" | "side-over-limit" | "lines-at-limit" | "lines-over-limit" | "patch-bytes";

// F16 comparison part: one unstaged `big.txt` per variant. Each side has the compared-version bound or one byte more.
// The `diff-files -p` output, headers included, has the canonical-diff line bound or one line more (contract §5).
// "patch-bytes" has fewer lines and more than 4 MiB of patch bytes.
export function buildF16Comparison(git: string, name: string, variant: F16ComparisonVariant): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  let head: string;
  let work: string;
  if (variant === "side-at-limit" || variant === "side-over-limit") {
    // 16,384 lines of 64 bytes. The working side changes one character of line 100.
    const extra = variant === "side-over-limit" ? "x" : "";
    head = lines(COMPARED_RAW_VERSION_BYTES / 64, (n) => `${String(n).padStart(6, "0")} ${"a".repeat(56)}\n`) + extra;
    work = head.slice(0, 99 * 64) + "b" + head.slice(99 * 64 + 1);
    facts.notes.sideBytes = COMPARED_RAW_VERSION_BYTES + extra.length;
  } else if (variant === "patch-bytes") {
    // 1,100 changed lines of 2,000 bytes on each side.
    head = lines(1100, (n) => `o${String(n).padStart(5, "0")} ${"p".repeat(1992)}\n`);
    work = lines(1100, (n) => `w${String(n).padStart(5, "0")} ${"p".repeat(1992)}\n`);
  } else {
    // Five header lines (`diff --git`, `index`, `---`, `+++`, `@@`), 9,998 removed lines, and 9,997 or 9,998 added lines.
    const added = variant === "lines-at-limit" ? 9997 : 9998;
    head = lines(9998, (n) => `old ${n}\n`);
    work = lines(added, (n) => `new ${n}\n`);
    facts.notes.diffLines = 5 + 9998 + added;
  }
  put(r.dir, "big.txt", head);
  add(r, "big.txt");
  const base = commit(r, "base");
  put(r.dir, "big.txt", work);
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, { refs: { "refs/heads/main": base }, unstaged: ["big.txt"] });
  return { id: "F16", variant: `comparison-${variant}`, root, facts };
}

const INCOMPRESSIBLE_CHUNK = 8 * 1024 * 1024;

// Writes `bytes` of the AES-128-CTR keystream of a fixed key, so each build writes equal incompressible bytes.
function writeIncompressible(path: string, bytes: number): void {
  const cipher = createCipheriv("aes-128-ctr", Buffer.alloc(16, 0x41), Buffer.alloc(16, 0));
  const zeros = Buffer.alloc(INCOMPRESSIBLE_CHUNK);
  const fd = openSync(fixturePath(relative(FIXTURE_ROOT, path)), "w");
  try {
    for (let left = bytes; left > 0; left -= INCOMPRESSIBLE_CHUNK) writeSync(fd, cipher.update(zeros.subarray(0, Math.min(left, INCOMPRESSIBLE_CHUNK))));
  } finally {
    closeSync(fd);
  }
}

// F16 stage-input part: two untracked incompressible files of the whole-file stage bound and one byte more (contract §5).
export function buildF16StageInput(git: string, name: string): Built {
  const root = start(name);
  const facts = newFacts();
  const r = init(git, join(root, "repo"));
  put(r.dir, "keep.txt", "keep\n");
  add(r, "keep.txt");
  const base = commit(r, "base");
  const sizes = { "at-limit.bin": WHOLE_FILE_STAGE_INPUT_BYTES, "over-limit.bin": WHOLE_FILE_STAGE_INPUT_BYTES + 1 };
  for (const [path, bytes] of Object.entries(sizes)) writeIncompressible(join(r.dir, path), bytes);
  normalizeIndex(r);
  facts.repos.repo = repoFacts(r, { refs: { "refs/heads/main": base }, untracked: Object.keys(sizes) });
  facts.notes.sizes = sizes;
  return { id: "F16", variant: "stage-input", root, facts };
}

export type F20Variant = "base" | "reflog-records" | "reflog-bytes";

// F20: the changed base for late writes and competing commits, and reflog evidence above one contract §5 attribution bound each.
// "reflog-records": more than 10,000 records below 4 MiB. "reflog-bytes": 64 records above 4 MiB.
// Git `refs/files-backend.c` writes each reflog record as "<old> <new> <committer> <time> <zone>\t<message>\n".
export function buildF20(git: string, name: string, variant: F20Variant): Built {
  const root = start(name);
  const facts = newFacts();
  const r = changedRepo(git, root, facts);
  if (variant !== "base") {
    const base = rev(r, "HEAD");
    const [log] = run(r, ["rev-parse", "--git-path", "logs/refs/heads/main"]).trimEnd().split("\n");
    const count = variant === "reflog-records" ? ATTRIBUTION_EVIDENCE_RECORDS : 64;
    const message = variant === "reflog-records" ? "reset: moving to HEAD" : `reset: ${"r".repeat(70_000)}`;
    const record = (i: number) => `${base} ${base} ${IDENT} ${FIXED_EPOCH + i} +0000\t${message}\n`;
    writeFileSync(resolve(r.dir, log!), readFileSync(resolve(r.dir, log!), "utf8") + lines(count, record));
    facts.notes.reflog = { ref: "refs/heads/main", records: count + 1, bytes: lstatSync(resolve(r.dir, log!)).size };
  }
  return { id: "F20", variant, root, facts };
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

// F27 to F30: submodules (contract §12). Each fixture has local bare remotes under its folder and a superproject clone at `super`.
// The fixture global file `notes.globalConfig` adds `protocol.file.allow=always`: submodule commands set `GIT_PROTOCOL_FROM_USER=0`, which blocks `file` URLs without it.
// Construction commands pass the same key with `-c` and use the shared owned global file.
// `notes.submodules` maps each submodule path (nested ones as `<parent>/<path>`) to its name, `.gitmodules` URL, recorded commit, and HEAD (null when not populated).
// `notes.oracle` holds the exit code and the HEADs of Git's own `submodule update --init --recursive` in a copy, when the fixture check runs it.

const PROTOCOL_FILE_ALLOW = '[protocol "file"]\n\tallow = always\n';

interface Remote {
  src: Repo;
  url: string;
  tips: Record<string, string>;
}

interface SubNote {
  name: string;
  url: string;
  recorded: string;
  head: string | null;
}

interface SubSpec {
  name: string;
  path: string;
  url: string;
  oid: string;
  extra?: string[];
}

// A bare remote `<root>/<name>.git` and its work repository `<root>/src/<name>`.
function bareRemote(git: string, root: string, name: string): Remote {
  run({ git, dir: root, pre: [] }, ["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const src = init(git, join(root, "src", name));
  src.pre = ["--literal-pathspecs"];
  // Git compares remote URLs as text (research.md R14 S12), so every URL uses `/`.
  const url = join(root, `${name}.git`).replaceAll("\\", "/");
  run(src, ["remote", "add", "origin", url]);
  return { src, url, tips: {} };
}

// Commits `files` and `gitlinks` in the work repository and pushes the commit to `branch` of the bare remote.
function publish(rem: Remote, message: string, files: Record<string, string | Uint8Array> = {}, gitlinks: Record<string, string> = {}, branch = "main"): string {
  for (const [path, content] of Object.entries(files)) put(rem.src.dir, path, content);
  if (Object.keys(files).length > 0) add(rem.src, ...Object.keys(files));
  if (Object.keys(gitlinks).length > 0) indexInfo(rem.src, Object.entries(gitlinks).map(([p, o]) => ["160000", o, 0, p]));
  const oid = commit(rem.src, message);
  run(rem.src, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  rem.tips[branch] = oid;
  return oid;
}

const gitmodules = (specs: Omit<SubSpec, "oid">[]) =>
  specs.map((s) => `[submodule "${s.name}"]\n\tpath = ${s.path}\n\turl = ${s.url}\n${(s.extra ?? []).map((line) => `\t${line}\n`).join("")}`).join("");

interface SubWorld {
  git: string;
  root: string;
  facts: Facts;
  leaf: Remote;
  mid: Remote;
  solo: Remote;
  // Recorded top-level submodules of the superproject, by path.
  specs: SubSpec[];
  sup: Repo;
  superRemote: Remote;
}

// The standard remotes: `leaf`, `mid` with `leaf` nested at `leaf`, and `solo`. `soloCommits` is 1 or 2.
// The superproject records `specs`, or `solo` at its last commit and `mid`.
function subWorld(git: string, root: string, facts: Facts, soloCommits = 2, specs?: (w: Omit<SubWorld, "specs" | "sup" | "superRemote">) => SubSpec[]): SubWorld {
  ownedGlobal(root, facts, "globalConfig", PROTOCOL_FILE_ALLOW);
  const leaf = bareRemote(git, root, "leaf");
  publish(leaf, "leaf 1", { "leaf.txt": "leaf 1\n" });
  const solo = bareRemote(git, root, "solo");
  for (let i = 1; i <= soloCommits; i++) publish(solo, `solo ${i}`, { "solo.txt": `solo ${i}\n` });
  const mid = bareRemote(git, root, "mid");
  publish(mid, "mid 1", { "mid.txt": "mid 1\n", ".gitmodules": gitmodules([{ name: "leaf", path: "leaf", url: "../leaf.git" }]) }, { leaf: leaf.tips.main! });
  const base = { git, root, facts, leaf, mid, solo };
  const recorded = specs?.(base) ?? [
    { name: "mid", path: "mid", url: "../mid.git", oid: mid.tips.main! },
    { name: "solo", path: "solo", url: "../solo.git", oid: solo.tips.main! },
  ];
  const superRemote = bareRemote(git, root, "super");
  publish(superRemote, "super", { "super.txt": "super\n", ".gitmodules": gitmodules(recorded) }, Object.fromEntries(recorded.map((s) => [s.path, s.oid])));
  run({ git, dir: root, pre: [] }, ["clone", "-q", superRemote.url, "super"]);
  const sup: Repo = { git, dir: join(root, "super"), pre: ["--literal-pathspecs"] };
  lineEndings(sup);
  return { ...base, specs: recorded, sup, superRemote };
}

// Populates one top-level submodule, and with `recursive` its nested ones.
function initSubmodule(w: SubWorld, path: string, recursive = false): Repo {
  run(w.sup, [...FILE_ALLOW, "submodule", "update", "--init", ...(recursive ? ["--recursive"] : []), "--", path]);
  const s: Repo = { git: w.git, dir: join(w.sup.dir, path), pre: ["--literal-pathspecs"] };
  lineEndings(s);
  if (recursive && existsSync(join(s.dir, "leaf", ".git"))) lineEndings({ git: w.git, dir: join(s.dir, "leaf"), pre: [] });
  return s;
}

// Moves the gitlink of `path` in a new superproject commit. The clone then is one commit ahead of `origin/main`.
function recordSubmodule(w: SubWorld, path: string, oid: string): void {
  indexInfo(w.sup, [["160000", oid, 0, path]]);
  commit(w.sup, `record ${path}`);
  w.specs = w.specs.map((s) => (s.path === path ? { ...s, oid } : s));
}

// The Git folder of a submodule by name, resolved by Git.
function moduleDir(w: SubWorld, name: string): string {
  return resolve(w.sup.dir, run(w.sup, ["rev-parse", "--git-path", `modules/${name}`]).trimEnd());
}

// The leaf commit that a `mid` commit records.
function midLeaf(w: SubWorld, midOid: string): string {
  return run(w.mid.src, ["rev-parse", `${midOid}:leaf`]).trim();
}

// Records the superproject facts and `notes.submodules`. `heads` gives the HEAD of each populated submodule path.
function finishSubWorld(w: SubWorld, heads: Record<string, string>, extra: Partial<RepoFacts> = {}, nestedRecorded = true): void {
  normalizeIndex(w.sup);
  const notes: Record<string, SubNote> = {};
  for (const s of w.specs) {
    notes[s.path] = { name: s.name, url: s.url, recorded: s.oid, head: heads[s.path] ?? null };
    if (s.url === "../mid.git" && nestedRecorded) {
      const nestedAt = heads[s.path] ?? s.oid;
      notes[`${s.path}/leaf`] = { name: "leaf", url: "../leaf.git", recorded: midLeaf(w, nestedAt), head: heads[`${s.path}/leaf`] ?? null };
    }
  }
  w.facts.notes.submodules = notes;
  const behind = Object.entries(heads).filter(([p, h]) => w.specs.some((s) => s.path === p && s.oid !== h)).map(([p]) => p);
  w.facts.repos.super = repoFacts(w.sup, {
    refs: { "refs/heads/main": rev(w.sup, "HEAD"), "refs/remotes/origin/HEAD": w.superRemote.tips.main!, "refs/remotes/origin/main": w.superRemote.tips.main! },
    unstaged: sorted(behind),
    entries: w.specs.map((s) => ({ path: s.path, stage: 0, mode: "160000", oid: s.oid })),
    ...extra,
  });
}

// Git's own update moves each populated or registered submodule to its recorded commit, nested ones included.
function expectedUpdateHeads(w: SubWorld, skip: string[] = []): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const s of w.specs) {
    if (skip.includes(s.path)) continue;
    heads[s.path] = s.oid;
    if (s.url === "../mid.git") heads[`${s.path}/leaf`] = midLeaf(w, s.oid);
  }
  return heads;
}

export type F27Variant = "base" | "behind-present" | "behind-fetch" | "deinit-kept" | "update-none" | "literal-paths" | "kept-remote" | "spaces" | "token-url" | "unreachable-target" | "headless-kept";
export const F27_TOKEN_URL = "https://u:TOKEN@host.example/";

// F27: a superproject clone with the uninitialized top-level submodules `mid` and `solo`. `mid` holds `leaf`, two levels deep.
// Each variant changes one row: a behind submodule with its commit present or missing, a kept Git folder, `update = none`, `sub[1]` beside `sub1`,
// a kept folder whose `origin` names a missing folder beside a second remote `good`, a path with a space and `é`, a review-only token URL,
// a recorded commit that no ref reaches, and a kept `mid` folder without a HEAD commit whose nested kept folder holds a hook canary.
export function buildF27(git: string, name: string, variant: F27Variant): Built {
  const root = start(name);
  const facts = newFacts();
  const solo = (s: Omit<SubWorld, "specs" | "sup" | "superRemote">, extra: Partial<SubSpec> = {}): SubSpec => ({ name: "solo", path: "solo", url: "../solo.git", oid: s.solo.tips.main!, ...extra });
  const mid = (s: Omit<SubWorld, "specs" | "sup" | "superRemote">): SubSpec => ({ name: "mid", path: "mid", url: "../mid.git", oid: s.mid.tips.main! });
  const specs: Partial<Record<F27Variant, (s: Omit<SubWorld, "specs" | "sup" | "superRemote">) => SubSpec[]>> = {
    "update-none": (s) => [mid(s), solo(s, { extra: ["update = none"] })],
    "literal-paths": (s) => [solo(s, { name: "sub[1]", path: "sub[1]", oid: run(s.solo.src, ["rev-parse", "main~1"]).trim() }), solo(s, { name: "sub1", path: "sub1" })],
    spaces: (s) => [mid(s), solo(s, { name: "space é", path: "sub dir/é sub" })],
    "token-url": (s) => [mid(s), solo(s), solo(s, { name: "review", path: "review", url: F27_TOKEN_URL })],
  };
  const late = variant === "behind-fetch" || variant === "kept-remote";
  const w = subWorld(git, root, facts, late ? 1 : 2, specs[variant]);
  const heads: Record<string, string> = {};
  let oracle: { exit: number; heads: Record<string, string> } | null = { exit: 0, heads: {} };
  switch (variant) {
    case "base":
    case "update-none":
    case "literal-paths":
    case "spaces":
      break;
    case "token-url":
      // The token URL is for the review only. Git's own update would try the network.
      oracle = null;
      break;
    case "behind-present": {
      const s = initSubmodule(w, "solo");
      const old = run(w.solo.src, ["rev-parse", "main~1"]).trim();
      run(s, ["checkout", "-q", "--detach", old]);
      heads.solo = old;
      break;
    }
    case "behind-fetch": {
      initSubmodule(w, "solo");
      heads.solo = w.solo.tips.main!;
      recordSubmodule(w, "solo", publish(w.solo, "solo 2", { "solo.txt": "solo 2\n" }));
      break;
    }
    case "deinit-kept":
      initSubmodule(w, "solo");
      run(w.sup, ["submodule", "deinit", "-q", "-f", "--", "solo"]);
      facts.notes.kept = { solo: relative(root, moduleDir(w, "solo")).replaceAll("\\", "/") };
      break;
    case "kept-remote": {
      // research.md R14 S12: the first fetch uses `origin` and fails. The fetch by commit ID uses the remote whose URL equals the registered URL.
      initSubmodule(w, "solo");
      run(w.sup, ["submodule", "deinit", "-q", "-f", "--", "solo"]);
      const kept = moduleDir(w, "solo");
      recordSubmodule(w, "solo", publish(w.solo, "solo 2", { "solo.txt": "solo 2\n" }));
      run({ git, dir: root, pre: [] }, ["--git-dir", kept, "remote", "set-url", "origin", join(root, "missing.git").replaceAll("\\", "/")]);
      run({ git, dir: root, pre: [] }, ["--git-dir", kept, "remote", "add", "good", w.solo.url]);
      facts.notes.kept = { solo: relative(root, kept).replaceAll("\\", "/") };
      facts.notes.keptRemotes = { origin: "missing.git", good: "solo.git" };
      break;
    }
    case "unreachable-target": {
      // `side` holds the recorded commit. The populated submodule drops its remote-tracking ref and keeps HEAD at another commit.
      const first = run(w.solo.src, ["rev-parse", "main~1"]).trim();
      run(w.solo.src, ["checkout", "-q", "-b", "side", first]);
      const target = publish(w.solo, "solo side", { "side.txt": "side\n" }, {}, "side");
      run(w.solo.src, ["checkout", "-q", "main"]);
      recordSubmodule(w, "solo", target);
      const s = initSubmodule(w, "solo");
      run(s, ["checkout", "-q", "--detach", first]);
      run(s, ["update-ref", "-d", "refs/remotes/origin/side"]);
      heads.solo = first;
      facts.notes.unreachable = { path: "solo", target };
      break;
    }
    case "headless-kept": {
      // research.md R14 S27 case D: the kept `mid` HEAD names a missing branch, and upstream `mid` records a new `leaf` commit.
      initSubmodule(w, "mid", true);
      run(w.sup, ["submodule", "deinit", "-q", "-f", "--", "mid"]);
      const kept = moduleDir(w, "mid");
      run({ git, dir: root, pre: [] }, ["--git-dir", kept, "symbolic-ref", "HEAD", "refs/heads/arbareto-missing"]);
      const leaf2 = publish(w.leaf, "leaf 2", { "leaf.txt": "leaf 2\n" });
      recordSubmodule(w, "mid", publish(w.mid, "mid 2", { "mid.txt": "mid 2\n" }, { leaf: leaf2 }));
      const nested = resolve(kept, run({ git, dir: root, pre: [] }, ["--git-dir", kept, "rev-parse", "--git-path", "modules/leaf"]).trimEnd());
      for (const event of ["reference-transaction", "post-checkout"]) hookScript(nested, event, `exec ${canary(root, facts, "nested-kept")} "$@"\n`);
      facts.notes.kept = { mid: relative(root, kept).replaceAll("\\", "/"), "mid/leaf": relative(root, nested).replaceAll("\\", "/") };
      break;
    }
  }
  finishSubWorld(w, heads);
  if (oracle !== null) oracle.heads = expectedUpdateHeads(w, variant === "update-none" ? ["solo"] : []);
  facts.notes.oracle = oracle;
  return { id: "F27", variant, root, facts };
}

// A commit on the detached HEAD of a populated submodule. No ref holds it.
function unsavedCommit(s: Repo): string {
  put(s.dir, "local.txt", "local commit\n");
  add(s, "local.txt");
  return commit(s, "local");
}

// A deinitialized submodule keeps its Git folder. `notes.kept` names it.
function deinitKept(w: SubWorld, path: string, name = path): string {
  run(w.sup, ["submodule", "deinit", "-q", "-f", "--", path]);
  const kept = moduleDir(w, name);
  w.facts.notes.kept = { ...(w.facts.notes.kept as Record<string, string> | undefined), [path]: relative(w.root, kept).replaceAll("\\", "/") };
  return kept;
}

export type F28Variant =
  | "detached-unsaved"
  | "update-merge"
  | "update-rebase"
  | "update-command"
  | "gitmodules-command"
  | "no-url"
  | "interrupted"
  | "blocked"
  | "inactive"
  | "active-pathspec"
  | "deinit-unsaved"
  | "folder"
  | "moved-folder"
  | "path"
  | "prune"
  | "keep"
  | "remote-name"
  | "unregistered-block";

// F28: the submodule safety cases of plan.md. Each variant is one superproject clone with the F27 remotes.
// "interrupted" and "moved-folder" write the research.md R14 S9 layout of a killed clone. The test moves the "moved-folder" folder out itself.
// "path" writes its gitlink with invalid UTF-8 path bytes in the clone, so no checkout touches that path. `notes.invalidPath` holds the hex bytes.
export function buildF28(git: string, name: string, variant: F28Variant): Built {
  const root = start(name);
  const facts = newFacts();
  const late = ["prune", "keep", "remote-name"].includes(variant);
  // A tracked `.gitmodules` holds no absolute path, so both builds have equal bytes. The command runs in the submodule folder.
  if (variant === "gitmodules-command") canary(root, facts, "gitmodules-update");
  const specs = (s: Omit<SubWorld, "specs" | "sup" | "superRemote">): SubSpec[] => [
    { name: "mid", path: "mid", url: "../mid.git", oid: s.mid.tips.main! },
    { name: "solo", path: "solo", url: "../solo.git", oid: s.solo.tips.main!, extra: ["update = !../../canaries/gitmodules-update.sh"] },
  ];
  const w = subWorld(git, root, facts, late ? 1 : 2, variant === "gitmodules-command" ? specs : undefined);
  const heads: Record<string, string> = {};
  const outside = { git, dir: root, pre: [] };
  const behindSolo = () => {
    const s = initSubmodule(w, "solo");
    const old = run(w.solo.src, ["rev-parse", "main~1"]).trim();
    run(s, ["checkout", "-q", "--detach", old]);
    heads.solo = old;
    return s;
  };
  let oracle: { exit: number } | null = null;
  let unstagedExtra: string[] = [];
  switch (variant) {
    case "detached-unsaved": {
      const s = initSubmodule(w, "solo");
      heads.solo = unsavedCommit(s);
      facts.notes.unsaved = { path: "solo", commit: heads.solo };
      break;
    }
    case "update-merge":
    case "update-rebase":
      behindSolo();
      run(w.sup, ["config", "submodule.solo.update", variant.slice("update-".length)]);
      break;
    case "update-command":
      behindSolo();
      run(w.sup, ["config", "submodule.solo.update", `!${canary(root, facts, "update-command")}`]);
      break;
    case "gitmodules-command":
      break;
    case "no-url":
      recordSubmodule(w, "orphan", w.solo.tips.main!);
      // An empty folder, as a clone leaves for each gitlink. Without it, `diff-files` reports the gitlink as deleted.
      mkdirSync(join(w.sup.dir, "orphan"));
      w.specs = [...w.specs, { name: "orphan", path: "orphan", url: "", oid: w.solo.tips.main! }];
      facts.notes.noUrl = "orphan";
      break;
    case "interrupted":
    case "moved-folder": {
      // research.md R14 S9: `config`, `HEAD`, empty `refs`, one `tmp_pack_*` file, the `.git` file, and the registered URL and `active`.
      const gitDir = moduleDir(w, "solo");
      put(gitDir, "config", `[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n\tlogallrefupdates = true\n\tworktree = ../../../solo\n[remote "origin"]\n\turl = ${w.solo.url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
      put(gitDir, "HEAD", "ref: refs/heads/main\n");
      mkdirSync(join(gitDir, "refs"), { recursive: true });
      put(gitDir, "objects/pack/tmp_pack_arbareto", Buffer.from("PACK\0\0\0\x02\0\0\0\x01"));
      put(w.sup.dir, "solo/.git", "gitdir: ../.git/modules/solo\n");
      run(w.sup, ["config", "submodule.solo.url", w.solo.url]);
      run(w.sup, ["config", "submodule.solo.active", "true"]);
      facts.notes.interrupted = { path: "solo", gitDir: relative(root, gitDir).replaceAll("\\", "/") };
      oracle = { exit: 128 };
      break;
    }
    case "blocked": {
      const s = behindSolo();
      put(s.dir, "solo.txt", "solo 1 edited\n");
      initSubmodule(w, "mid", true);
      heads.mid = w.mid.tips.main!;
      heads["mid/leaf"] = w.leaf.tips.main!;
      recordSubmodule(w, "mid", publish(w.mid, "mid 2", { "mid.txt": "mid 2\n" }));
      facts.notes.blocked = { path: "solo", edited: "solo.txt", moves: "mid" };
      break;
    }
    case "inactive":
      run(w.sup, ["config", "submodule.solo.active", "false"]);
      break;
    case "active-pathspec":
      run(w.sup, ["config", "submodule.active", "mid"]);
      break;
    case "deinit-unsaved": {
      const s = initSubmodule(w, "solo");
      facts.notes.unsaved = { path: "solo", commit: unsavedCommit(s) };
      deinitKept(w, "solo");
      break;
    }
    case "folder": {
      const s = initSubmodule(w, "solo");
      put(s.dir, "solo.txt", "solo modified\n");
      put(s.dir, "untracked.txt", "untracked\n");
      rmSync(join(s.dir, ".git"));
      facts.notes.folder = { path: "solo", files: { "solo.txt": sha256(Buffer.from("solo modified\n")), "untracked.txt": sha256(Buffer.from("untracked\n")) } };
      break;
    }
    case "path": {
      const invalid = Buffer.concat([Buffer.from("bad-"), Buffer.from([0xff]), Buffer.from("-sub")]);
      put(w.sup.dir, ".gitmodules", Buffer.concat([Buffer.from(readFileSync(join(w.sup.dir, ".gitmodules"))), Buffer.from('[submodule "badpath"]\n\tpath = '), invalid, Buffer.from("\n\turl = ../solo.git\n")]));
      add(w.sup, ".gitmodules");
      indexInfo(w.sup, [["160000", w.solo.tips.main!, 0, invalid]]);
      commit(w.sup, "invalid path");
      facts.notes.invalidPath = invalid.toString("hex");
      // No folder exists for this path, so `diff-files` reports the gitlink as deleted. Data-model §5 shows the invalid byte as `\xNN`.
      unstagedExtra = ["bad-\\xff-sub"];
      break;
    }
    case "prune":
    case "keep": {
      // research.md R14 S15: only `refs/remotes/origin/feat` holds the submodule HEAD. The remote then deletes `feat`, and the target needs a fetch.
      run(w.solo.src, ["checkout", "-q", "-b", "feat"]);
      const feat = publish(w.solo, "feat", { "feat.txt": "feat\n" }, {}, "feat");
      run(w.solo.src, ["checkout", "-q", "main"]);
      const s = initSubmodule(w, "solo");
      run(s, ["checkout", "-q", "--detach", feat]);
      run(w.solo.src, ["push", "-q", "origin", "--delete", "feat"]);
      delete w.solo.tips.feat;
      recordSubmodule(w, "solo", publish(w.solo, "solo 2", { "solo.txt": "solo 2\n" }));
      if (variant === "prune") run(s, ["config", "fetch.prune", "true"]);
      heads.solo = feat;
      facts.notes.prune = { path: "solo", head: feat, ref: "refs/remotes/origin/feat", prune: variant === "prune" };
      break;
    }
    case "remote-name": {
      // research.md R14 S31. `git remote add` rejects this name, so `git config` writes the section.
      initSubmodule(w, "solo");
      const kept = deinitKept(w, "solo");
      recordSubmodule(w, "solo", publish(w.solo, "solo 2", { "solo.txt": "solo 2\n" }));
      const program = canary(root, facts, "remote-name").slice(1, -1);
      run(outside, ["--git-dir", kept, "config", `remote.--upload-pack=${program}.url`, w.solo.url]);
      facts.notes.remoteName = "--upload-pack=<canary remote-name>";
      break;
    }
    case "unregistered-block": {
      const s = behindSolo();
      put(s.dir, "solo.txt", "solo 1 edited\n");
      run(w.sup, ["config", "--unset", "submodule.solo.url"]);
      facts.notes.blocked = { path: "solo", edited: "solo.txt" };
      break;
    }
  }
  finishSubWorld(w, heads);
  if (unstagedExtra.length > 0) facts.repos.super!.unstaged = sorted([...facts.repos.super!.unstaged, ...unstagedExtra]);
  facts.notes.oracle = oracle;
  return { id: "F28", variant, root, facts };
}

// githooks(5) of Git 2.56: every hook event. The F29 check runs `hook list` for each name, and an unknown name exits 1.
export const F29_HOOK_EVENTS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
] as const;
export const F29_HOOK_TOKEN_URL = "https://u:TOKEN@host.example/";

// The F29 canaries of one Git folder: every hook event, `core.fsmonitor`, clean and smudge filters with an attribute, `core.sshCommand`, `credential.helper`, and `remote.origin.uploadpack`.
// `notes.programs[label]` names the folder. `config --file` writes the keys, so a kept folder without a worktree needs no repository setup.
function programCanaries(w: SubWorld, gitDir: string, label: string, hookTail: Partial<Record<string, string>> = {}): void {
  const { root, facts } = w;
  const hook = canary(root, facts, `${label}-hook`);
  for (const event of F29_HOOK_EVENTS) hookScript(gitDir, event, `${hook} ${event} "$@" || exit 1\n${hookTail[event] ?? ""}`);
  const keys: [string, string][] = [
    ["core.fsmonitor", canary(root, facts, `${label}-fsmonitor`, "exit 1\n")],
    ["filter.f29.clean", canary(root, facts, `${label}-clean`, "exec cat\n")],
    ["filter.f29.smudge", canary(root, facts, `${label}-smudge`, "exec cat\n")],
    ["core.sshCommand", canary(root, facts, `${label}-ssh`, "exit 1\n")],
    // A helper value that starts with `!` runs through the shell (gitcredentials(7)).
    ["credential.helper", `!${canary(root, facts, `${label}-credential`, "exit 1\n")}`],
    ["remote.origin.uploadpack", canary(root, facts, `${label}-uploadpack`, 'exec git-upload-pack "$@"\n')],
  ];
  for (const [key, value] of keys) run({ git: w.git, dir: root, pre: [] }, ["config", "--file", join(gitDir, "config"), key, value]);
  put(gitDir, "info/attributes", "* filter=f29\n");
  facts.notes.programs = { ...(facts.notes.programs as Record<string, string> | undefined), [label]: relative(root, gitDir).replaceAll("\\", "/") };
}

// The absolute Git folder of a populated submodule, resolved by Git.
const absoluteGitDir = (s: Repo) => run(s, ["rev-parse", "--absolute-git-dir"]).trim();

export type F29Variant = "base" | "kept-folder" | "kept-nested" | "gitdir-extension" | "gitdir-outside" | "gitdir-nested" | "relative-hooks" | "nested-programs" | "row-programs";

// F29: program canaries in submodule Git folders. In "base", `mid` and its nested `leaf` are populated and behind, each with the `programCanaries` set.
// "base" adds a `post-checkout` hook that prints a token URL, an `ext` row whose registered URL is `ext::<canary>`, and `notes.globalNoFile`, a global file without `protocol.file.allow`.
// "kept-folder" deinitializes `mid` with both canary sets, and adds a non-Git folder and the kept folder of a submodule named `group/solo` under `modules`.
// "kept-nested" deinitializes only `leaf` inside the populated `mid`. The three "gitdir-*" variants are "base" plus one `gitdir` setting each.
// "relative-hooks", "nested-programs", and "row-programs" follow plan.md F29. Canaries come last, after every index read and write of the construction.
export function buildF29(git: string, name: string, variant: F29Variant): Built {
  if (variant === "relative-hooks") return buildF29RelativeHooks(git, name);
  const root = start(name);
  const facts = newFacts();
  const kept = variant === "kept-folder";
  const w = subWorld(git, root, facts, 2, (s) => [
    { name: "mid", path: "mid", url: "../mid.git", oid: s.mid.tips.main! },
    { name: "solo", path: "solo", url: "../solo.git", oid: s.solo.tips.main! },
    ...(variant === "base" ? [{ name: "ext", path: "ext", url: "../ext.git", oid: s.solo.tips.main! }] : []),
    ...(kept ? [{ name: "group/solo", path: "grouped", url: "../solo.git", oid: s.solo.tips.main! }] : []),
  ]);
  const heads: Record<string, string> = {};
  const mid = initSubmodule(w, "mid", true);
  const leaf: Repo = { git, dir: join(mid.dir, "leaf"), pre: [] };
  const midDir = absoluteGitDir(mid);
  const leafDir = absoluteGitDir(leaf);
  heads.mid = w.mid.tips.main!;
  heads["mid/leaf"] = w.leaf.tips.main!;
  const leaf2 = publish(w.leaf, "leaf 2", { "leaf.txt": "leaf 2\n" });
  recordSubmodule(w, "mid", publish(w.mid, "mid 2", { "mid.txt": "mid 2\n" }, { leaf: leaf2 }));
  let solo: Repo | null = null;
  if (variant === "row-programs") {
    solo = initSubmodule(w, "solo");
    run(solo, ["checkout", "-q", "--detach", "main~1"]);
    heads.solo = run(solo, ["rev-parse", "HEAD"]).trim();
  }
  if (kept) {
    initSubmodule(w, "grouped");
    deinitKept(w, "grouped", "group/solo");
    deinitKept(w, "mid");
    delete heads.mid;
    delete heads["mid/leaf"];
    w.facts.notes.kept = { ...(w.facts.notes.kept as Record<string, string>), "mid/leaf": relative(root, leafDir).replaceAll("\\", "/") };
    put(join(w.sup.dir, ".git", "modules"), "not-git/readme.txt", "not a Git folder\n");
    facts.notes.nonGitFolder = "super/.git/modules/not-git";
  }
  if (variant === "kept-nested") {
    run(mid, [...FILE_ALLOW, "submodule", "deinit", "-q", "-f", "--", "leaf"]);
    delete heads["mid/leaf"];
    w.facts.notes.kept = { "mid/leaf": relative(root, leafDir).replaceAll("\\", "/") };
  }
  finishSubWorld(w, heads);
  // Programs come last: the construction reads and writes no index after this point.
  const tokenTail = { "post-checkout": `echo "${F29_HOOK_TOKEN_URL}" >&2\n` };
  switch (variant) {
    case "nested-programs":
      programCanaries(w, midDir, "mid", { "post-checkout": `git -C leaf config core.fsmonitor ${canary(root, facts, "added-fsmonitor", "exit 1\n")}\n` });
      programCanaries(w, leafDir, "mid-leaf");
      break;
    case "row-programs": {
      const soloDir = absoluteGitDir(solo!);
      programCanaries(w, soloDir, "solo");
      programCanaries(w, midDir, "mid", { "post-checkout": `echo 'echo row-changed' >> ${shPath(join(soloDir, "hooks", "post-checkout"))}\n` });
      facts.notes.rows = ["mid", "solo"];
      break;
    }
    default:
      programCanaries(w, midDir, "mid", variant === "base" ? tokenTail : {});
      programCanaries(w, leafDir, "mid-leaf");
  }
  const sup = { git, dir: root, pre: [] };
  const superConfig = join(w.sup.dir, ".git", "config");
  switch (variant) {
    case "base":
      run(sup, ["config", "--file", superConfig, "submodule.ext.url", `ext::${canary(root, facts, "ext-url").slice(1, -1)}`]);
      run(sup, ["config", "--file", superConfig, "submodule.ext.active", "true"]);
      ownedGlobal(root, facts, "globalNoFile", "");
      facts.notes.secrets = ["TOKEN"];
      break;
    case "gitdir-extension":
      run(sup, ["config", "--file", superConfig, "core.repositoryformatversion", "1"]);
      run(sup, ["config", "--file", superConfig, "extensions.submodulePathConfig", "true"]);
      break;
    case "gitdir-outside":
      run(sup, ["config", "--file", superConfig, "submodule.solo.gitdir", join(root, "outside-modules", "solo").replaceAll("\\", "/")]);
      break;
    case "gitdir-nested":
      run(sup, ["config", "--file", join(midDir, "config"), "submodule.leaf.gitdir", join(root, "outside-modules", "leaf").replaceAll("\\", "/")]);
      facts.notes.gitdirConfig = "mid";
      break;
  }
  facts.notes.hookEvents = [...F29_HOOK_EVENTS];
  facts.notes.oracle = null;
  return { id: "F29", variant, root, facts };
}

// The F29 relative-hooks variant (research.md R14 S14): a global file with `core.hooksPath=.githooks`, and a `hooked` remote whose tracked hooks differ between commits A and B.
// Four rows record B: `hk-clone` is not populated, `hk-reuse` is a kept folder, `hk-checkout` holds A with B present, and `hk-fetch` holds A without B.
// Each tracked hook writes into `arbareto-relhooks.log` of its own Git folder, so the tracked bytes hold no absolute path.
function buildF29RelativeHooks(git: string, name: string): Built {
  const root = start(name);
  const facts = newFacts();
  const hooked = bareRemote(git, root, "hooked");
  const tagged = (tag: string) => {
    for (const event of ["post-checkout", "reference-transaction"]) put(hooked.src.dir, `.githooks/${event}`, `#!/bin/sh\necho "${event} ${tag} $*" >> "$(git rev-parse --git-dir)/arbareto-relhooks.log"\n`);
    add(hooked.src, ".githooks/post-checkout", ".githooks/reference-transaction");
    // `core.filemode=false` adds new files as 100644. POSIX Git runs a hook only with the execute bit.
    run(hooked.src, ["update-index", "--chmod=+x", "--", ".githooks/post-checkout", ".githooks/reference-transaction"]);
    put(hooked.src.dir, "hooked.txt", `${tag}\n`);
    add(hooked.src, "hooked.txt");
    const oid = commit(hooked.src, tag);
    run(hooked.src, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    hooked.tips.main = oid;
    return oid;
  };
  const a = tagged("A");
  const rows = ["hk-checkout", "hk-clone", "hk-fetch", "hk-reuse"];
  const w = subWorld(git, root, facts, 2, () => rows.map((p) => ({ name: p, path: p, url: "../hooked.git", oid: a })));
  ownedGlobal(root, facts, "globalConfig", `${PROTOCOL_FILE_ALLOW}[core]\n\thooksPath = .githooks\n`);
  const heads: Record<string, string> = {};
  initSubmodule(w, "hk-fetch");
  heads["hk-fetch"] = a;
  const b = tagged("B");
  initSubmodule(w, "hk-checkout");
  heads["hk-checkout"] = a;
  initSubmodule(w, "hk-reuse");
  deinitKept(w, "hk-reuse");
  for (const p of rows) indexInfo(w.sup, [["160000", b, 0, p]]);
  commit(w.sup, "record B");
  w.specs = w.specs.map((s) => ({ ...s, oid: b }));
  finishSubWorld(w, heads);
  for (const p of rows) facts.canaries[`relhooks-${p}`] = `super/.git/modules/${p}/arbareto-relhooks.log`;
  facts.notes.commits = { A: a, B: b };
  facts.notes.rows = { "hk-clone": "clone", "hk-reuse": "reuse", "hk-checkout": "checkout", "hk-fetch": "fetch-checkout" };
  facts.notes.oracle = null;
  return { id: "F29", variant: "relative-hooks", root, facts };
}

export type F30Variant = "clone" | "silent-hook" | "child-hook" | "silent-fetch" | "stall";
export const F30_BIG_BYTES = 300_000_000;
export const F30_SSH_URL = "ssh://localhost/x.git";

// F30: long submodule steps. "clone": an uninitialized `big` whose recorded commit adds a 300 MB incompressible file.
// "silent-fetch": `big` is populated at its first commit, and the recorded commit adds the file. "silent-hook": `solo` needs a checkout, and its `post-checkout` hook sleeps 330 seconds without output.
// "child-hook": the same `post-checkout` hook starts a recorded background child and exits. "stall" (research.md R14 S24): `solo` needs a fetch from `ssh://localhost/x.git`,
// and its `core.sshCommand` runs Windows OpenSSH `ssh-keygen -y` on a passphrase key. The trailing `#` comments out the arguments that Git appends.
export function buildF30(git: string, name: string, variant: F30Variant): Built {
  const sshKeygen = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh-keygen.exe") : null;
  if (variant === "stall" && (sshKeygen === null || !existsSync(sshKeygen))) throw new CapabilitySkip("openssh");
  const root = start(name);
  const facts = newFacts();
  const usesBig = variant === "clone" || variant === "silent-fetch";
  const big = usesBig ? bareRemote(git, root, "big") : null;
  if (big !== null) {
    run(big.src, ["config", "core.compression", "0"]);
    publish(big, "big 1", { "big.txt": "small\n" });
  }
  const w = subWorld(git, root, facts, variant === "stall" ? 1 : 2, (s) => [
    { name: "mid", path: "mid", url: "../mid.git", oid: s.mid.tips.main! },
    { name: "solo", path: "solo", url: "../solo.git", oid: s.solo.tips.main! },
    ...(big !== null ? [{ name: "big", path: "big", url: "../big.git", oid: big.tips.main! }] : []),
  ]);
  const heads: Record<string, string> = {};
  const addBig = () => {
    writeIncompressible(join(big!.src.dir, "big.bin"), F30_BIG_BYTES);
    add(big!.src, "big.bin");
    const oid = commit(big!.src, "big 2");
    run(big!.src, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    big!.tips.main = oid;
    recordSubmodule(w, "big", oid);
    facts.notes.bigBytes = F30_BIG_BYTES;
  };
  let soloDir: string | null = null;
  switch (variant) {
    case "clone":
      addBig();
      break;
    case "silent-fetch":
      initSubmodule(w, "big");
      heads.big = big!.tips.main!;
      addBig();
      break;
    case "silent-hook":
    case "child-hook": {
      const s = initSubmodule(w, "solo");
      run(s, ["checkout", "-q", "--detach", "main~1"]);
      heads.solo = run(s, ["rev-parse", "HEAD"]).trim();
      soloDir = absoluteGitDir(s);
      break;
    }
    case "stall": {
      const s = initSubmodule(w, "solo");
      heads.solo = w.solo.tips.main!;
      recordSubmodule(w, "solo", publish(w.solo, "solo 2", { "solo.txt": "solo 2\n" }));
      soloDir = absoluteGitDir(s);
      break;
    }
  }
  finishSubWorld(w, heads);
  if (variant === "silent-hook") hookScript(soloDir!, "post-checkout", "exec sleep 330\n");
  if (variant === "child-hook") {
    const { child, awaitReady } = recordedChild(root, facts, "post-checkout");
    hookScript(soloDir!, "post-checkout", `${child(60_000)} &\n${awaitReady}exit 0\n`);
  }
  if (variant === "stall") {
    // Keys are random per build, so they stay outside every repository. Only the relative path is a fact.
    const key = join(root, "keys", "stall");
    mkdirSync(dirname(key), { recursive: true });
    const keygen = Bun.spawnSync([sshKeygen!, "-q", "-t", "ed25519", "-N", "arbareto-passphrase", "-C", "arbareto-fixture", "-f", key], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (keygen.exitCode !== 0) throw new Error(`ssh-keygen exited ${keygen.exitCode}: ${keygen.stderr.toString()}`);
    const config = join(soloDir!, "config");
    run({ git, dir: root, pre: [] }, ["config", "--file", config, "remote.origin.url", F30_SSH_URL]);
    run({ git, dir: root, pre: [] }, ["config", "--file", config, "core.sshCommand", `${shPath(sshKeygen!)} -y -f ${shPath(key)} #`]);
    facts.notes.key = "keys/stall";
  }
  facts.notes.oracle = null;
  return { id: "F30", variant, root, facts };
}
