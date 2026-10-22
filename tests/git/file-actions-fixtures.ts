// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 plan.md P0.1 (tasks.md T029): the Files, Ignore, and Submodule fixtures. Facts come from the construction, never from `src/git-service/`.
// Each builder declares the tracked set and the ignored set (`ls-files -c -z`, `ls-files -o -i --exclude-standard -z`) that the T028 self-check compares with Git.

import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_ROOT, fixtureDir, ownedGit } from "./fixture-root";
import { buildF27 } from "./fixtures";
import { buildWorkbench } from "./workbench-fixtures";

const WINDOWS = process.platform === "win32";

export interface FaFixture {
  name: string;
  git: string;
  root: string;
  repo: string;
  // The declared `ls-files -c -z` paths and `ls-files -o -i --exclude-standard -z` paths, sorted by their bytes.
  tracked: string[];
  ignored: string[];
  notes: Record<string, unknown>;
}

export const faGit = (git: string, dir: string, args: string[], options: { input?: Uint8Array | string; env?: Record<string, string | undefined>; allowExit?: number[] } = {}): Buffer =>
  ownedGit(git, FIXTURE_ROOT, dir, args, { ...options, input: options.input === undefined ? undefined : Buffer.from(options.input) });

const byBytes = (paths: Iterable<string>) => [...new Set(paths)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

// The line-ending keys and `core.filemode` of `tests/git/fixtures.ts` `lineEndings`.
const LINE_ENDINGS = [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"], ["core.filemode", "false"]] as const;

function init(git: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  faGit(git, dir, ["init", "-q", "-b", "main"]);
  for (const [key, value] of LINE_ENDINGS) faGit(git, dir, ["config", key, value]);
  return dir;
}

// Writes `content` below `dir`. A Windows name that ends in a period or a space needs the `\\?\` prefix (Microsoft Learn "Naming Files, Paths, and Namespaces").
export function write(dir: string, rel: string, content: string | Uint8Array): string {
  const path = join(dir, ...rel.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(WINDOWS && /[. ]$/.test(rel) ? `\\\\?\\${path}` : path, content);
  return path;
}

function commitAll(git: string, dir: string, paths: readonly string[], message: string): string {
  faGit(git, dir, ["--literal-pathspecs", "add", "-f", "--", ...paths]);
  faGit(git, dir, ["commit", "-q", "--no-verify", "-m", message]);
  return faGit(git, dir, ["rev-parse", "HEAD"]).toString().trim();
}

// ---- Files (Delete, Show in Explorer) ----

export const FILES_TRACKED = [".gitignore", "t/a.txt", "t/b.txt", "top.txt", "x"];
export const FILES_UNTRACKED = ["u1.txt", "u2.txt", "u3.txt", "logs/1.log", "logs/2.log", "logs/3.log", "logs/4.log", "a/b/c/x.txt", "ro.txt", "big.bin"];
// Delete digests a file only up to 1 MiB (contract Δ5), so `big.bin` binds its size and `lastWrite` only.
export const BIG_BYTES = 1_048_577;

// Untracked files, a changed tracked file, a folder with an ignored file, the nested empty folders `a/b/c`, a read-only file,
// a file above the digest bound, a nested repository, and a submodule whose commit changed (porcelain v2 `<sub>` `SC..`).
// On Windows `x.` and `x ` stand beside the tracked `x` (plan.md D7 N9). Tests add links and junctions, because they need a capability.
export function buildFiles(git: string, name: string): FaFixture {
  const root = fixtureDir(name);
  const repo = init(git, join(root, "repo"));
  write(repo, ".gitignore", "*.tmp\n");
  for (const path of ["t/a.txt", "t/b.txt", "top.txt", "x"]) write(repo, path, `${path}\n`);
  commitAll(git, repo, [".gitignore", "t/a.txt", "t/b.txt", "top.txt", "x"], "base");
  write(repo, "t/a.txt", "t/a.txt changed\n");
  for (const path of FILES_UNTRACKED.filter((p) => p !== "big.bin")) write(repo, path, `${path}\n`);
  write(repo, "big.bin", new Uint8Array(BIG_BYTES).fill(0x61));
  write(repo, "logs/skip.tmp", "ignored\n");
  chmodSync(join(repo, "ro.txt"), 0o444);
  if (WINDOWS) {
    write(repo, "x.", "dot\n");
    write(repo, "x ", "space\n");
  }
  const nested = init(git, join(repo, "nested"));
  write(nested, "n.txt", "n\n");
  commitAll(git, nested, ["n.txt"], "nested");
  // A gitlink without `.gitmodules`: the index records the first commit, and the submodule HEAD moves to the second.
  const mod = init(git, join(repo, "mod"));
  write(mod, "m.txt", "m1\n");
  const first = commitAll(git, mod, ["m.txt"], "m1");
  faGit(git, repo, ["update-index", "--add", "--cacheinfo", `160000,${first},mod`]);
  faGit(git, repo, ["commit", "-q", "--no-verify", "-m", "record mod"]);
  write(mod, "m.txt", "m2\n");
  const second = commitAll(git, mod, ["m.txt"], "m2");
  // Outside the worktree: the target of the links that tests add.
  write(root, "outside/keep.txt", "outside\n");
  return { name, git, root, repo, tracked: byBytes([...FILES_TRACKED, "mod"]), ignored: ["logs/skip.tmp"], notes: { first, second, outside: join(root, "outside") } };
}

// A conflicted merge stop (`merging`), or its unmerged index after `merge --quit` (no marker, spec FR-033).
export function buildConflicted(git: string, name: string, variant: "merging" | "unmerged"): FaFixture {
  const f = buildWorkbench(git, "conflict-merge", name);
  if (variant === "unmerged") faGit(git, f.repo, ["merge", "--quit"]);
  write(f.repo, "free.txt", "free\n");
  const tracked = faGit(git, f.repo, ["ls-files", "-c", "-z"]).toString("utf8").split("\0").filter((p) => p !== "");
  return { name, git, root: f.root, repo: f.repo, tracked: byBytes(tracked), ignored: [], notes: {} };
}

// ---- Ignore files: the report fixture R (ignore-preview report, cases C0 to C8 and W1) ----

export const REPORT_ROOT_TEXT = "*.log\n/build/\n!keep.log\nnode_modules/\n**/tmp/**\nign/\n!ign/inner.txt\n";

// The fixture R of the report `run.sh`, plus a tracked gitlink `mod` (E1), a skip-worktree `swt/.gitignore` that is absent on disk (E5),
// and an empty folder that the root text ignores. `links`: the W1 additions, which need the `symlink` capability.
export function buildReport(git: string, name: string, links = false): FaFixture {
  const root = fixtureDir(name);
  const repo = init(git, join(root, "repo"));
  const text = `${REPORT_ROOT_TEXT}emptyign/\n`;
  write(repo, ".gitignore", text);
  write(repo, "sub/.gitignore", "!*.log\n/local\n");
  write(repo, "swt/.gitignore", "*.swt\n");
  for (const [path, content] of [["a.txt", "a"], ["sub/tracked.log", "t"], ["build/keep.txt", "k"], ["b.txt", "b"], ["swt/keep.txt", "keep"]] as const) write(repo, path, content);
  commitAll(git, repo, [".gitignore", "sub/.gitignore", "swt/.gitignore", "a.txt", "sub/tracked.log", "build/keep.txt", "b.txt", "swt/keep.txt"], "init");
  for (const path of ["x.log", "keep.log", "sub/y.log", "sub/local", "local", "sub/deeper/local", "build/out.o", "node_modules/pkg/index.js", "untr/a.bak", "untr/b.txt", "deep/tmp/z", "deep/tmp/sub/w", "secret.txt", "sub/secret.txt", "Upper.LOG", "ign/inner.txt", "ign/other.txt", "swt/a.swt", "swt/b.txt"]) write(repo, path, "");
  write(repo, "node_modules/pkg/.gitignore", "*.js\n");
  write(repo, "untr/.gitignore", "*.bak\n");
  mkdirSync(join(repo, "emptyign"));
  const nested = init(git, join(repo, "nested"));
  write(nested, "f.txt", "");
  commitAll(git, nested, ["f.txt"], "n");
  write(repo, ".git/info/exclude", "secret.txt\n");
  const head = faGit(git, repo, ["rev-parse", "HEAD"]).toString().trim();
  faGit(git, repo, ["update-index", "--add", "--cacheinfo", `160000,${head},mod`]);
  mkdirSync(join(repo, "mod"));
  faGit(git, repo, ["update-index", "--skip-worktree", "--", "swt/.gitignore"]);
  rmSync(join(repo, "swt", ".gitignore"));
  // W1: a folder link against a folder pattern, a linked `sub2/.gitignore` that Git does not read, and names with gitignore(5) magic.
  if (links) {
    write(repo, "realdir/f", "");
    write(repo, "ruleset", "*\n");
    write(repo, "sub2/kept", "");
    symlinkSync("realdir", join(repo, "linkdir"), "dir");
    symlinkSync(join("..", "ruleset"), join(repo, "sub2", ".gitignore"), "file");
    write(repo, "[br].txt", "");
    write(repo, "sp ace.txt", "");
  }
  const tracked = [".gitignore", "a.txt", "b.txt", "build/keep.txt", "mod", "sub/.gitignore", "sub/tracked.log", "swt/.gitignore", "swt/keep.txt"];
  // gitignore(5): `!ign/inner.txt` cannot re-include a file below the excluded `ign/`. `secret.txt` of info/exclude has no slash, so it matches at every level.
  // `sub/.gitignore` re-includes `sub/y.log` and ignores only `sub/local`. `Upper.LOG` matches `*.log` only with `core.ignoreCase`.
  const ignored = [
    ...(caseInsensitiveGit(git, repo) ? ["Upper.LOG"] : []),
    "build/out.o",
    "deep/tmp/sub/w",
    "deep/tmp/z",
    "ign/inner.txt",
    "ign/other.txt",
    "node_modules/pkg/.gitignore",
    "node_modules/pkg/index.js",
    "secret.txt",
    "sub/local",
    "sub/secret.txt",
    "swt/a.swt",
    "untr/a.bak",
    "x.log",
  ];
  return { name, git, root, repo, tracked: byBytes(tracked), ignored: byBytes(ignored), notes: { text } };
}

// git-config(1) `core.ignoreCase`: `git init` sets it on a case-insensitive file system.
function caseInsensitiveGit(git: string, repo: string): boolean {
  return faGit(git, repo, ["config", "--type=bool", "core.ignorecase"], { allowExit: [0, 1] }).toString().trim() === "true";
}

// ---- Ignore files: the root `.gitignore` forms (spec FR-036, FR-037) ----

// Each text ignores `a.log` through its first line `*.log`. The texts with a second `/out/` line also ignore `out/x.txt`.
// A NUL and an invalid UTF-8 byte stand on their own comment or pattern line, so Git's rules stay plain (dir.c `add_patterns_from_buffer`).
export const IGNORE_FORMS = {
  lf: { bytes: Buffer.from("*.log\n/out/\n"), out: true },
  crlf: { bytes: Buffer.from("*.log\r\n/out/\r\n"), out: true },
  bom: { bytes: Buffer.from("\u{feff}*.log\n"), out: false },
  none: { bytes: Buffer.from("*.log"), out: false },
  mixed: { bytes: Buffer.from("*.log\r\n/out/\n"), out: true },
  // Git drops a CR only before an LF, so `/out/\r` stays one pattern that matches nothing.
  "lone-cr": { bytes: Buffer.from("*.log\n/out/\r#\n"), out: false },
  nul: { bytes: Buffer.from("*.log\n#\0\n"), out: false },
  "not-utf8": { bytes: Uint8Array.of(...Buffer.from("*.log\n#"), 0xff, 0x0a), out: false },
  big: { bytes: Buffer.concat([Buffer.from("*.log\n#"), Buffer.alloc(1_048_577 - 7, 0x23)]), out: false },
} as const;
export type IgnoreForm = keyof typeof IGNORE_FORMS | "empty" | "absent" | "folder" | "link";

// One repository whose root `.gitignore` has `form`. `out/x.txt` and `a.log` are untracked. The `link` form needs the `symlink` capability.
// An empty file, an absent file, a folder, and a link give no rules: Git opens an in-tree `.gitignore` without following a link (dir.c `PATTERN_NOFOLLOW`).
export function buildIgnoreForm(git: string, name: string, form: IgnoreForm): FaFixture {
  const root = fixtureDir(name);
  const repo = init(git, join(root, "repo"));
  write(repo, "keep.txt", "keep\n");
  commitAll(git, repo, ["keep.txt"], "base");
  write(repo, "out/x.txt", "x\n");
  write(repo, "a.log", "a\n");
  const known = form in IGNORE_FORMS ? IGNORE_FORMS[form as keyof typeof IGNORE_FORMS] : null;
  if (known !== null) write(repo, ".gitignore", known.bytes);
  if (form === "empty") write(repo, ".gitignore", "");
  if (form === "folder") mkdirSync(join(repo, ".gitignore", "inner"), { recursive: true });
  if (form === "link") {
    write(repo, "rules.txt", "*.log\n");
    symlinkSync("rules.txt", join(repo, ".gitignore"), "file");
  }
  const ignored = known === null ? [] : ["a.log", ...(known.out ? ["out/x.txt"] : [])];
  return { name, git, root, repo, tracked: ["keep.txt"], ignored: byBytes(ignored), notes: {} };
}

// ---- Ignore files: case-variant names (plan.md D9 `name-case`, F19) ----

// `up/` holds only `.GITIGNORE` and `dot/` holds only `.gıtignore` (U+0131), each with `*.txt`. Windows NTFS opens `.GITIGNORE` for `.gitignore`.
export function buildCaseNames(git: string, name: string): FaFixture {
  const root = fixtureDir(name);
  const repo = init(git, join(root, "repo"));
  write(repo, "keep.md", "keep\n");
  commitAll(git, repo, ["keep.md"], "base");
  write(repo, "up/.GITIGNORE", "*.txt\n");
  write(repo, "up/a.txt", "a\n");
  write(repo, "dot/.gıtignore", "*.txt\n");
  write(repo, "dot/a.txt", "a\n");
  return { name, git, root, repo, tracked: ["keep.md"], ignored: WINDOWS ? ["up/a.txt"] : [], notes: {} };
}

// ---- Preview inputs at the PREVIEW_PATHS bound (contract Δ5, plan.md D9 `paths`) ----

export const BOUND_INDEX_ONLY = 99_997;

// 100,000 preview inputs: 99,997 index-only entries `t/NNNNN.txt` and the tracked `.gitignore` (`big/`) and `t/.gitignore` give 99,999 T paths,
// and the U folder record `big/` gives one more. `big/` holds 3 untracked files. The folder `t` is the one folder above a `.gitignore` below the root.
export function buildPathsBound(git: string, name: string): FaFixture {
  const root = fixtureDir(name);
  const repo = init(git, join(root, "repo"));
  write(repo, ".gitignore", "big/\n");
  write(repo, "t/.gitignore", "x\n");
  commitAll(git, repo, [".gitignore", "t/.gitignore"], "base");
  const oid = faGit(git, repo, ["hash-object", "-w", "--stdin"], { input: "t\n" }).toString().trim();
  const lines = Array.from({ length: BOUND_INDEX_ONLY }, (_, i) => `100644 ${oid}\tt/${String(i).padStart(5, "0")}.txt\0`).join("");
  faGit(git, repo, ["update-index", "-z", "--index-info"], { input: lines });
  for (const file of ["a.txt", "b.txt", "c.txt"]) write(repo, `big/${file}`, `${file}\n`);
  const tracked = [".gitignore", "t/.gitignore", ...Array.from({ length: BOUND_INDEX_ONLY }, (_, i) => `t/${String(i).padStart(5, "0")}.txt`)];
  return { name, git, root, repo, tracked: byBytes(tracked), ignored: ["big/a.txt", "big/b.txt", "big/c.txt"], notes: {} };
}

// ---- Linked worktree (F18) ----

export function buildLinkedWorktree(git: string, name: string): FaFixture & { linked: string } {
  const root = fixtureDir(name);
  const repo = init(git, join(root, "repo"));
  write(repo, "w.txt", "w\n");
  commitAll(git, repo, ["w.txt"], "base");
  const linked = join(root, "linked");
  faGit(git, repo, ["worktree", "add", "-q", "-b", "linked", "--", linked]);
  return { name, git, root, repo, linked, tracked: ["w.txt"], ignored: [], notes: {} };
}

// ---- Submodules (spec FR-047 to FR-052, F16) ----

const FILE_ALLOW = ["-c", "protocol.file.allow=always"];

// The F27 superproject with `solo` initialized, `mid` initialized with its nested `leaf`, an uninitialized gitlink `bare`,
// and the gitlink `broken` whose `.git` file names a missing Git folder (F16).
export function buildSubmodules(git: string, name: string): FaFixture & { sup: string } {
  const built = buildF27(git, name, "base");
  const sup = join(built.root, "super");
  faGit(git, sup, [...FILE_ALLOW, "submodule", "update", "--init", "--", "solo"]);
  faGit(git, sup, [...FILE_ALLOW, "submodule", "update", "--init", "--recursive", "--", "mid"]);
  for (const dir of [join(sup, "solo"), join(sup, "mid"), join(sup, "mid", "leaf")]) for (const [key, value] of LINE_ENDINGS) faGit(git, dir, ["config", key, value]);
  const head = faGit(git, sup, ["rev-parse", "HEAD"]).toString().trim();
  for (const path of ["bare", "broken"]) faGit(git, sup, ["update-index", "--add", "--cacheinfo", `160000,${head},${path}`]);
  faGit(git, sup, ["commit", "-q", "--no-verify", "-m", "gitlinks"]);
  mkdirSync(join(sup, "bare"));
  write(sup, "broken/.git", "gitdir: ../.git/modules/arbareto-missing\n");
  const tracked = faGit(git, sup, ["ls-files", "-c", "-z"]).toString("utf8").split("\0").filter((p) => p !== "");
  return { name, git, root: built.root, repo: sup, sup, tracked: byBytes(tracked), ignored: [], notes: { globalConfig: join(built.root, String(built.facts.notes.globalConfig)) } };
}

// The `.git/config` bytes of a repository, for the "no configuration change" checks.
export const configBytes = (repo: string): string => readFileSync(join(repo, ".git", "config"), "latin1");
