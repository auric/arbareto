// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T028: the builder self-check of `tests/git/file-actions-fixtures.ts` (plan.md P0.1).
// T030: the Git facts F10 to F16, F18, and F19 of research.md R16 (plan.md P0.2). Each fact compares with Git's own result on a copy and prints its OBSERVATION line.

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, fixtureDir, fixtureEnv, useFixtureRoot } from "./fixture-root";
import { fixtureGitPath, GIT } from "./git-binary";
import { sha256 } from "./git-oracle";
import { gitVersion } from "./history-diff-fixtures";
import { untrackedFixture, UNTRACKED_FILES } from "./workbench-fixtures";

printOrigin("./file-actions-fixtures.ts", import.meta.dir);
useFixtureRoot();

const F = await import("./file-actions-fixtures");

const WINDOWS = process.platform === "win32";
const TIMEOUT_MS = 300_000;
const LARGE_TIMEOUT_MS = 20 * 60_000;
const NUL = "\0";

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const version = GIT === null ? "none" : gitVersion(GIT);
const g = (dir: string, args: string[], options: { input?: Uint8Array | string; env?: Record<string, string | undefined>; allowExit?: number[] } = {}) => F.faGit(gitPath(), dir, args, options);
const text = (dir: string, args: string[], options: { input?: Uint8Array | string; env?: Record<string, string | undefined> } = {}) => g(dir, args, options).toString("utf8");
// One Git process in `cwd` with the owned environment. It returns the process, also for a nonzero exit.
const spawn = (cwd: string, args: string[], env: Record<string, string> = {}, input?: Uint8Array | string) =>
  Bun.spawnSync([fixtureGitPath(gitPath()), ...args], { cwd, env: fixtureEnv(env), stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
const code = (dir: string, args: string[]) => spawn(dir, args).exitCode;

// tasks.md "Harness and tick rules": each fact prints its line with the observed Git version.
function observe(fact: string, holds: boolean): void {
  console.log(`OBSERVATION T030: ${fact} ${holds ? "holds" : "DOES NOT HOLD"} (${version})`);
}

const gitCase = (name: string, body: () => unknown, timeoutMs = TIMEOUT_MS) => (GIT === null ? test.skip(`${name} (SKIP: Git executable absent)`, () => {}) : test(name, async () => void (await body()), timeoutMs));
// A case that needs a Windows host or a capability skips with its name (001 "Test harness rules").
const capabilityCase = (name: string, capability: string, present: boolean, body: () => unknown, timeoutMs = TIMEOUT_MS) => {
  if (GIT !== null && present) return void test(name, async () => void (await body()), timeoutMs);
  console.log(`SKIP T030 ${name}: missing capability ${GIT === null ? "git" : capability} (unverified)`);
  test.skip(name, () => {});
};

const records = (out: Buffer): string[] => {
  const parts = out.toString("utf8").split(NUL);
  if (parts.pop() !== "") throw new Error("a -z listing does not end with NUL");
  return parts;
};
const byBytes = (paths: Iterable<string>) => [...new Set(paths)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const listed = (dir: string, args: string[]) => byBytes(records(g(dir, args)));
const READ = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
const U_ARGS = [...READ, "ls-files", "-o", "-z", "--directory", "--no-empty-directory"];
const RI_ARGS = [...READ, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"];
const RT_ARGS = [...READ, "ls-files", "-c", "-i", "--exclude-standard", "-z"];
const IGNORED_ARGS = ["ls-files", "-o", "-i", "--exclude-standard", "-z"];
const indexDigest = (repo: string) => sha256(g(repo, ["ls-files", "-s", "-z"]));
// `git init` makes a bare repository when `GIT_DIR` does not end in `/.git` (setup.c `guess_repository_type`). F14 records the Windows form.
const gitDirOf = (dir: string) => join(dir, ".git").replaceAll("\\", "/");

let symlinks: boolean | null = null;
// tasks.md "Test harness rules": the `symlink` capability is present when `symlinkSync` succeeds at test time.
function canLink(): boolean {
  if (symlinks !== null) return symlinks;
  const { symlinkSync, mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "arbareto-link-"));
  try {
    symlinkSync("target", join(dir, "probe"));
    symlinks = true;
  } catch {
    symlinks = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return symlinks;
}

// T028: the declared sets against Git, and two builds with equal sets and index digests.
function checkFixture(f: FaFixture): void {
  expect({ name: f.name, tracked: listed(f.repo, ["ls-files", "-c", "-z"]) }).toEqual({ name: f.name, tracked: f.tracked });
  expect({ name: f.name, ignored: listed(f.repo, IGNORED_ARGS) }).toEqual({ name: f.name, ignored: f.ignored });
}
function sameBuilds(a: FaFixture, b: FaFixture): void {
  expect(listed(b.repo, ["ls-files", "-c", "-z"])).toEqual(listed(a.repo, ["ls-files", "-c", "-z"]));
  expect(listed(b.repo, IGNORED_ARGS)).toEqual(listed(a.repo, IGNORED_ARGS));
  expect(indexDigest(b.repo)).toBe(indexDigest(a.repo));
}
type FaFixture = import("./file-actions-fixtures").FaFixture;

describe("T028 builder self-check (plan.md P0.1)", () => {
  gitCase("files: tracked and ignored sets, the read-only file, the bound file, the nested repository, the changed submodule commit, and two equal builds", () => {
    const a = F.buildFiles(gitPath(), "t028-files-a");
    const b = F.buildFiles(gitPath(), "t028-files-b");
    checkFixture(a);
    checkFixture(b);
    sameBuilds(a, b);
    // git-status(1) porcelain v2: `S` and `C` of `<sub>` mark the submodule whose commit changed. The nested repository is an untracked `nested/`.
    const status = records(g(a.repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]));
    expect(status.some((r) => r.startsWith("1 .M SC.. ") && r.endsWith(" mod"))).toBe(true);
    expect(status).toContain("? nested/");
    expect(status).toContain("? a/b/c/x.txt");
    if (WINDOWS) expect(status.filter((r) => r === "? x." || r === "? x ").sort()).toEqual(["? x ", "? x."]);
    expect(readFileSync(join(a.repo, "big.bin")).length).toBe(F.BIG_BYTES);
  });

  gitCase("conflicts: the merge stop keeps MERGE_HEAD; merge --quit keeps the unmerged entries without a marker", () => {
    for (const variant of ["merging", "unmerged"] as const) {
      const a = F.buildConflicted(gitPath(), `t028-conflict-${variant}-a`, variant);
      const b = F.buildConflicted(gitPath(), `t028-conflict-${variant}-b`, variant);
      checkFixture(a);
      sameBuilds(a, b);
      expect({ variant, unmerged: text(a.repo, ["ls-files", "-u", "-z"]) !== "" }).toEqual({ variant, unmerged: true });
      expect({ variant, mergeHead: code(a.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) === 0 }).toEqual({ variant, mergeHead: variant === "merging" });
    }
  });

  gitCase("report fixture R: the report sets plus a tracked gitlink, a skip-worktree .gitignore absent on disk, and an empty ignored folder; two equal builds", () => {
    const a = F.buildReport(gitPath(), "t028-report-a");
    const b = F.buildReport(gitPath(), "t028-report-b");
    checkFixture(a);
    checkFixture(b);
    sameBuilds(a, b);
    expect(existsSync(join(a.repo, "swt", ".gitignore"))).toBe(false);
    expect(text(a.repo, ["ls-files", "-v", "-z", "--", "swt/.gitignore"])).toBe(`S swt/.gitignore${NUL}`);
    expect(existsSync(join(a.repo, "emptyign"))).toBe(true);
  });

  capabilityCase("report fixture R with the W1 links: a folder link, a linked sub2/.gitignore, and two equal builds", "symlink", canLink(), () => {
    const a = F.buildReport(gitPath(), "t028-report-links-a", true);
    const b = F.buildReport(gitPath(), "t028-report-links-b", true);
    checkFixture(a);
    sameBuilds(a, b);
  });

  gitCase("ignore forms: each root .gitignore form gives its declared ignored set; two equal builds", () => {
    const forms: import("./file-actions-fixtures").IgnoreForm[] = ["lf", "crlf", "bom", "none", "mixed", "lone-cr", "nul", "not-utf8", "big", "empty", "absent", "folder"];
    for (const form of forms) {
      const a = F.buildIgnoreForm(gitPath(), `t028-form-${form}-a`, form);
      const b = F.buildIgnoreForm(gitPath(), `t028-form-${form}-b`, form);
      checkFixture(a);
      sameBuilds(a, b);
    }
  });

  capabilityCase("ignore forms: a linked root .gitignore gives no rules", "symlink", canLink(), () => {
    const a = F.buildIgnoreForm(gitPath(), "t028-form-link-a", "link");
    checkFixture(a);
  });

  gitCase("case names: up/.GITIGNORE rules apply on Windows only; dot/.gıtignore gives no rules", () => {
    const a = F.buildCaseNames(gitPath(), "t028-case-a");
    const b = F.buildCaseNames(gitPath(), "t028-case-b");
    checkFixture(a);
    sameBuilds(a, b);
  });

  gitCase("submodules: solo and mid with leaf initialized, bare uninitialized, broken with a missing Git folder; two equal builds", () => {
    const a = F.buildSubmodules(gitPath(), "t028-sub-a");
    const b = F.buildSubmodules(gitPath(), "t028-sub-b");
    checkFixture(a);
    sameBuilds(a, b);
    for (const path of ["solo/.git", "mid/.git", "mid/leaf/.git", "broken/.git"]) expect({ path, exists: existsSync(join(a.sup, path)) }).toEqual({ path, exists: true });
    expect(existsSync(join(a.sup, "bare", ".git"))).toBe(false);
  });

  gitCase("preview bound: 99,999 tracked paths with 99,997 index-only entries, and the untracked folder big/; two equal builds", () => {
    const a = F.buildPathsBound(gitPath(), "t028-bound-a");
    const b = F.buildPathsBound(gitPath(), "t028-bound-b");
    checkFixture(a);
    sameBuilds(a, b);
    expect(listed(a.repo, U_ARGS)).toEqual(["big/"]);
  }, LARGE_TIMEOUT_MS);

  gitCase("linked worktree: one tracked file and a linked worktree", () => {
    const a = F.buildLinkedWorktree(gitPath(), "t028-linked-a");
    checkFixture(a);
    expect(existsSync(join(a.linked, ".git"))).toBe(true);
  });

  gitCase("the 100,000-path preview fixture of the 001 fixture cache: 100,000 untracked files and one tracked file", () => {
    const f = untrackedFixture(gitPath());
    // The 001 cache root is no owned fixture root, so these read-only reads spawn Git directly.
    const read = (args: string[]) => {
      const proc = spawn(f.repo, args);
      expect(proc.exitCode).toBe(0);
      return proc.stdout;
    };
    expect(read(["--no-optional-locks", "ls-files", "-c", "-z"]).toString()).toBe(`README.txt${NUL}`);
    expect(records(read(["--no-optional-locks", "ls-files", "-o", "-z"])).length).toBe(UNTRACKED_FILES);
  }, LARGE_TIMEOUT_MS);
});

// ---- T030 facts ----

const copyOf = (repo: string, name: string): string => {
  const to = join(fixtureDir(name), "repo");
  cpSync(repo, to, { recursive: true, verbatimSymlinks: true });
  return to;
};

// git-check-ignore(1) OUTPUT with `-z -v -n`: `<source> NUL <line> NUL <pattern> NUL <path> NUL`, one record per input.
function checkIgnore(dir: string, paths: readonly string[], extra: string[] = [], env: Record<string, string | undefined> = {}): { path: string; pattern: string; source: string }[] {
  const out = g(dir, ["--no-lazy-fetch", ...extra, "check-ignore", "--no-index", "-z", "--stdin", "-v", "-n"], { input: paths.map((p) => `${p}${NUL}`).join(""), env, allowExit: [0, 1] });
  const parts = records(out);
  const result: { path: string; pattern: string; source: string }[] = [];
  for (let i = 0; i < parts.length; i += 4) result.push({ source: parts[i]!, pattern: parts[i + 2]!, path: parts[i + 3]! });
  return result;
}
const ignoredBy = (r: { pattern: string }) => r.pattern !== "" && !r.pattern.startsWith("!");

describe("T030 F10: the --directory universe, the folder expansion, and RI with a nested repository (plan.md D9)", () => {
  gitCase("F10: each folder without tracked entries is one record, a nested repository is nested/, the expansion lists every untracked file, and a nested repository expands to nested/", () => {
    const r = F.buildReport(gitPath(), "t030-f10");
    const universe = listed(r.repo, U_ARGS);
    const expected = byBytes([
      "Upper.LOG",
      "build/out.o",
      "deep/",
      "ign/",
      "keep.log",
      "local",
      "nested/",
      "node_modules/",
      "secret.txt",
      "sub/deeper/",
      "sub/local",
      "sub/secret.txt",
      "sub/y.log",
      "swt/a.swt",
      "swt/b.txt",
      "untr/",
      "x.log",
    ]);
    const holds = JSON.stringify(universe) === JSON.stringify(expected);
    observe(`F10 ls-files -o --directory --no-empty-directory gives one record per folder without tracked entries, nested/ for a repository, and no emptyign/: ${JSON.stringify(universe)}`, holds);
    expect(universe).toEqual(expected);
    // The expansion equals the plain listing below each folder.
    const plain = listed(r.repo, [...READ, "ls-files", "-o", "-z"]);
    for (const folder of ["untr/", "deep/", "ign/", "node_modules/", "sub/deeper/"]) {
      const expansion = listed(r.repo, [...READ, "ls-files", "-o", "-z", "--", folder]);
      const below = plain.filter((p) => p.startsWith(folder));
      observe(`F10 the expansion of ${folder} lists every untracked file below it`, JSON.stringify(expansion) === JSON.stringify(below));
      expect(expansion).toEqual(below);
    }
    const nested = listed(r.repo, [...READ, "ls-files", "-o", "-z", "--", "nested/"]);
    observe(`F10 a nested repository expands to the one record nested/: ${JSON.stringify(nested)}`, JSON.stringify(nested) === JSON.stringify(["nested/"]));
    expect(nested).toEqual(["nested/"]);
  });

  gitCase("F10: with the text nested/, RI gives nested/; inside the excluded ign/, RI gives ign/ only; RI with a pathspec below an excluded folder exits 128", () => {
    const r = F.buildReport(gitPath(), "t030-f10-ri");
    const copy = copyOf(r.repo, "t030-f10-ri-copy");
    writeFileSync(join(copy, ".gitignore"), `${F.REPORT_ROOT_TEXT}nested/\n`);
    const inner = join(copy, "ign", "inner-repo");
    mkdirSync(inner);
    g(inner, ["init", "-q"]);
    writeFileSync(join(inner, "f.txt"), "");
    g(inner, ["add", "f.txt"]);
    g(inner, ["commit", "-q", "-m", "inner"]);
    const ri = listed(copy, RI_ARGS);
    const nestedHolds = ri.includes("nested/") && ri.includes("ign/") && !ri.some((p) => p.startsWith("ign/") && p !== "ign/");
    observe(`F10 RI gives nested/ for an excluded repository whose parent is not excluded, and ign/ alone covers ign/inner-repo: ${JSON.stringify(ri)}`, nestedHolds);
    expect(nestedHolds).toBe(true);
    const below = code(copy, [...RI_ARGS, "--", "ign/inner-repo/"]);
    observe(`F10 RI with the pathspec ign/inner-repo/ below the excluded ign/ exits ${below}`, below === 128);
    expect(below).toBe(128);
  });
});

describe("T030 F11 and F12: the shadow method against Git's listings (plan.md D9)", () => {
  // A test-own shadow by the report method: every ignore file that the listings name, the edited text, and an empty folder for each gitlink and nested repository.
  // The per-file universe `ls-files -o -z` keeps this check independent of the folder collapse, which F12 checks.
  function shadowVerdicts(repo: string, name: string, edited: string, candidate: string | null): { ignored: string[]; trackedMatched: string[] } {
    const shadow = join(fixtureDir(name), "shadow");
    mkdirSync(shadow, { recursive: true });
    const env = { GIT_DIR: gitDirOf(shadow) };
    g(shadow, ["--no-lazy-fetch", "init", "-q", "--template="], { env });
    const all = records(g(repo, [...READ, "ls-files", "-o", "-z"]));
    const stage = records(g(repo, [...READ, "ls-files", "-z", "--stage", "-v"]));
    const tracked = new Map<string, { mode: string; oid: string; tag: string }>();
    for (const rec of stage) {
      const m = /^(\S) ([0-7]{6}) ([0-9a-f]+) ([0-3])\t(.*)$/s.exec(rec)!;
      if (!tracked.has(m[5]!)) tracked.set(m[5]!, { tag: m[1]!, mode: m[2]!, oid: m[3]! });
    }
    const entries: string[] = [];
    const hash = (input: Uint8Array) => text(shadow, ["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin"], { env, input }).trim();
    const gitignores = byBytes([...all, ...tracked.keys()].filter((p) => p === ".gitignore" || p.endsWith("/.gitignore")));
    for (const path of gitignores) {
      if (path === edited && candidate !== null) continue;
      const real = join(repo, ...path.split("/"));
      const { lstatSync } = require("node:fs") as typeof import("node:fs");
      const st = lstatSync(real, { throwIfNoEntry: false });
      const t = tracked.get(path);
      if (st === undefined && t?.tag === "S") entries.push(`100644 ${hash(g(repo, ["cat-file", "blob", t.oid]))}\t${path}`);
      else if (st?.isFile()) entries.push(`100644 ${hash(readFileSync(real))}\t${path}`);
    }
    if (candidate !== null && edited !== ".git/info/exclude") entries.push(`100644 ${hash(Buffer.from(candidate))}\t${edited}`);
    const folderOid = hash(new Uint8Array());
    for (const [path, t] of tracked) if (t.mode === "160000") entries.push(`160000 ${t.oid}\t${path}`);
    for (const path of all) if (path.endsWith("/")) entries.push(`160000 ${folderOid}\t${path.slice(0, -1)}`);
    g(shadow, ["--no-lazy-fetch", "update-index", "-z", "--index-info"], { env: { ...env, GIT_INDEX_FILE: join(shadow, ".git", "index") }, input: entries.map((e) => `${e}${NUL}`).join("") });
    g(shadow, ["--no-lazy-fetch", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f"], { env: { ...env, GIT_INDEX_FILE: join(shadow, ".git", "index") } });
    const exclude = edited === ".git/info/exclude" && candidate !== null ? Buffer.from(candidate) : existsSync(join(repo, ".git", "info", "exclude")) ? readFileSync(join(repo, ".git", "info", "exclude")) : null;
    if (exclude !== null) {
      const oid = hash(exclude);
      const excludeEnv = { ...env, GIT_INDEX_FILE: join(shadow, ".git", "exclude.index") };
      g(shadow, ["--no-lazy-fetch", "update-index", "-z", "--index-info"], { env: excludeEnv, input: `100644 ${oid}\texclude${NUL}` });
      g(shadow, ["--no-lazy-fetch", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f", "--prefix=.git/info/"], { env: excludeEnv });
    }
    const ignoreCase = g(repo, ["config", "--type=bool", "core.ignorecase"], { allowExit: [0, 1] }).toString().trim() || "false";
    const flags = ["-c", `core.ignorecase=${ignoreCase}`];
    const untracked = checkIgnore(shadow, all.map((p) => (p.endsWith("/") ? p.slice(0, -1) : p)), flags, env);
    const matched = checkIgnore(shadow, [...tracked.keys()], flags, env);
    return { ignored: byBytes(untracked.filter(ignoredBy).map((r) => (all.includes(`${r.path}/`) ? `${r.path}/` : r.path))), trackedMatched: byBytes(matched.filter(ignoredBy).map((r) => r.path)) };
  }

  // Git's own answer after a real save on a copy: `ls-files -o -i --exclude-standard -z` and `ls-files -c -i --exclude-standard -z`.
  function realSave(repo: string, name: string, edited: string, candidate: string): { ignored: string[]; trackedMatched: string[] } {
    const copy = copyOf(repo, name);
    writeFileSync(join(copy, ...edited.split("/")), candidate);
    return { ignored: listed(copy, [...READ, ...IGNORED_ARGS]), trackedMatched: listed(copy, RT_ARGS) };
  }

  // The report cases. C2 and C6 edit `sub/.gitignore`, which the editor cannot open, so only this fact covers them.
  const CASES: [label: string, edited: string, candidate: string][] = [
    ["C0 unchanged root", ".gitignore", `${F.REPORT_ROOT_TEXT}emptyign/\nx\n`],
    ["C1 root: drop folders, add *.txt and !a.txt", ".gitignore", "*.log\n!keep.log\n**/tmp/**\n*.txt\n!a.txt\n"],
    ["C2 sub: anchored and negation", "sub/.gitignore", "*.log\n/local\n!secret.txt\nsecret.txt\n"],
    ["C3 info/exclude", ".git/info/exclude", "*.txt\n!untr/b.txt\nnode_modules/pkg/\n"],
    ["C4 case: *.LOG, DEEP/, nested/", ".gitignore", "*.LOG\nDEEP/\nnested/\n"],
    ["C5 ignored folder with a negation inside, ** forms", ".gitignore", "node_modules\n!node_modules/pkg/index.js\n**/sub/**/local\nuntr/**\n!untr/b.txt\n"],
    ["C6 sub: folder-only and leading **", "sub/.gitignore", "deeper/\n**/secret.txt\n"],
    ["C7 empty root", ".gitignore", ""],
    ["C8 CRLF, BOM, and trailing spaces", ".gitignore", "\u{feff}*.log\r\n!keep.log  \r\nign/\\ \r\n"],
    ["E1 gitlink against mod/", ".gitignore", "mod/\n"],
  ];

  gitCase("F11: the S shadow equals RI and RT, and each C shadow equals Git's listings after a real save, for C0 to C8 and E1 with a gitlink and a skip-worktree .gitignore", () => {
    const r = F.buildReport(gitPath(), "t030-f11");
    const saved = shadowVerdicts(r.repo, "t030-f11-s", ".gitignore", null);
    const real = { ignored: listed(r.repo, [...READ, ...IGNORED_ARGS]), trackedMatched: listed(r.repo, RT_ARGS) };
    observe(`F11 the S shadow equals Git's ignored and tracked-matched listings: ${JSON.stringify(saved)}`, JSON.stringify(saved) === JSON.stringify(real));
    expect(saved).toEqual(real);
    for (const [label, edited, candidate] of CASES) {
      const shadow = shadowVerdicts(r.repo, `t030-f11-${label.slice(0, 2)}`, edited, candidate);
      const truth = realSave(r.repo, `t030-f11-${label.slice(0, 2)}-copy`, edited, candidate);
      observe(`F11 ${label}: the C shadow equals the real save`, JSON.stringify(shadow) === JSON.stringify(truth));
      expect({ label, ...shadow }).toEqual({ label, ...truth });
    }
  });

  capabilityCase("F11 W1: a folder link against folder patterns and a linked sub2/.gitignore", "symlink", canLink(), () => {
    const r = F.buildReport(gitPath(), "t030-f11-w1", true);
    const candidate = `${F.REPORT_ROOT_TEXT}linkdir/\nrealdir/\n\\[br].txt\n`;
    const shadow = shadowVerdicts(r.repo, "t030-f11-w1-c", ".gitignore", candidate);
    const truth = realSave(r.repo, "t030-f11-w1-copy", ".gitignore", candidate);
    observe("F11 W1: the C shadow equals the real save", JSON.stringify(shadow) === JSON.stringify(truth));
    expect(shadow).toEqual(truth);
  });

  gitCase("F12: below a folder record that check-ignore ignores as a folder, every untracked file is ignored too", () => {
    const r = F.buildReport(gitPath(), "t030-f12");
    const folders = listed(r.repo, U_ARGS).filter((p) => p.endsWith("/"));
    const verdicts = checkIgnore(r.repo, folders.map((p) => p.slice(0, -1)));
    for (const [i, folder] of folders.entries()) {
      if (!ignoredBy(verdicts[i]!)) continue;
      const files = listed(r.repo, [...READ, "ls-files", "-o", "-z", "--", folder]).filter((p) => !p.endsWith("/"));
      const below = checkIgnore(r.repo, files);
      const holds = below.every(ignoredBy);
      observe(`F12 every file below the ignored folder ${folder} is ignored`, holds);
      expect({ folder, holds }).toEqual({ folder, holds: true });
    }
  });
});

describe("T030 F13 and F14: stdin paths and the shadow copy steps (plan.md D9)", () => {
  gitCase("F13: a ./ path is literal and echoed unchanged; on Windows a backslash also separates", () => {
    const r = F.buildReport(gitPath(), "t030-f13");
    const copy = copyOf(r.repo, "t030-f13-copy");
    writeFileSync(join(copy, ".gitignore"), ":x.log\nsub/y.log\n");
    const [plain, dotted] = checkIgnore(copy, [":x.log", "./:x.log"]);
    const holds = dotted!.path === "./:x.log" && dotted!.pattern === ":x.log";
    observe(`F13 ./:x.log matches the pattern :x.log and Git echoes ./:x.log; the bare :x.log gives pattern ${JSON.stringify(plain!.pattern)}`, holds);
    expect(holds).toBe(true);
    if (WINDOWS) {
      // The per-directory file sub/.gitignore applies to both forms, so the backslash separates.
      const [back, slash] = checkIgnore(copy, ["sub\\y.log", "sub/y.log"]);
      const same = back!.source === slash!.source && back!.pattern === slash!.pattern;
      observe(`F13 on Windows sub\\y.log gives the verdict of sub/y.log: ${JSON.stringify([back, slash])}`, same);
      expect(same).toBe(true);
    }
  });

  gitCase("F14: hash-object --stdin-paths reads C-quoted lines; checkout-index writes equal bytes and an empty folder for a gitlink; info/exclude goes in through a second index", () => {
    const root = fixtureDir("t030-f14");
    const real = join(root, "real dir é");
    mkdirSync(real, { recursive: true });
    const crlf = Buffer.from("*.log\r\n!keep.log\r\n");
    writeFileSync(join(real, ".gitignore"), crlf);
    const shadow = join(root, "shadow");
    mkdirSync(shadow);
    const env = { GIT_DIR: gitDirOf(shadow) };
    g(shadow, ["--no-lazy-fetch", "init", "-q", "--template="], { env });
    const bareOf = (dir: string, gitDir: string) => text(dir, ["config", "--get", "core.bare"], { env: { GIT_DIR: gitDir } }).trim();
    observe(`F14 init with GIT_DIR <dir>/.git gives core.bare ${bareOf(shadow, env.GIT_DIR)}`, bareOf(shadow, env.GIT_DIR) === "false");
    expect(bareOf(shadow, env.GIT_DIR)).toBe("false");
    if (WINDOWS) {
      // The native form, as the shell sets it (src-tauri/src/process_requests.rs:2196-2199).
      const native = join(root, "native");
      mkdirSync(native);
      g(native, ["--no-lazy-fetch", "init", "-q", "--template="], { env: { GIT_DIR: join(native, ".git") } });
      const bare = bareOf(native, join(native, ".git"));
      observe(`F14 on Windows init with a GIT_DIR that ends in a backslash and .git gives core.bare ${bare}, so checkout-index finds no work tree`, bare === "true");
      expect(bare).toBe("true");
    }
    observe("F14 init --template= creates no info/exclude", !existsSync(join(shadow, ".git", "info", "exclude")));
    expect(existsSync(join(shadow, ".git", "info", "exclude"))).toBe(false);
    const quoted = `"${[...Buffer.from(join(real, ".gitignore"))].map((b) => (b === 0x5c ? "\\\\" : b === 0x22 ? '\\"' : b < 0x20 || b >= 0x7f ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b))).join("")}"`;
    const fromPaths = text(shadow, ["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin-paths"], { env, input: `${quoted}\n` }).trim();
    const fromStdin = text(shadow, ["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin"], { env, input: crlf }).trim();
    observe("F14 a C-quoted --stdin-paths line gives the OID of the bytes", fromPaths === fromStdin);
    expect(fromPaths).toBe(fromStdin);
    const index = { ...env, GIT_INDEX_FILE: join(shadow, ".git", "index") };
    g(shadow, ["--no-lazy-fetch", "update-index", "-z", "--index-info"], { env: index, input: `100644 ${fromPaths}\t.gitignore${NUL}160000 ${fromPaths}\tmod${NUL}` });
    g(shadow, ["--no-lazy-fetch", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f"], { env: index });
    const same = Buffer.compare(readFileSync(join(shadow, ".gitignore")), crlf) === 0;
    const folder = existsSync(join(shadow, "mod"));
    observe(`F14 checkout-index writes equal bytes (${same}) and an empty folder for a gitlink (${folder})`, same && folder);
    expect({ same, folder }).toEqual({ same: true, folder: true });
    const verify = text(shadow, ["--no-lazy-fetch", "hash-object", "--no-filters", "--stdin-paths"], { env, input: ".gitignore\n" }).trim();
    expect(verify).toBe(fromPaths);
    const exclude = { ...env, GIT_INDEX_FILE: join(shadow, ".git", "exclude.index") };
    g(shadow, ["--no-lazy-fetch", "update-index", "-z", "--index-info"], { env: exclude, input: `100644 ${fromPaths}\texclude${NUL}` });
    g(shadow, ["--no-lazy-fetch", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f", "--prefix=.git/info/"], { env: exclude });
    const placed = existsSync(join(shadow, ".git", "info", "exclude")) && Buffer.compare(readFileSync(join(shadow, ".git", "info", "exclude")), crlf) === 0;
    observe("F14 checkout-index --prefix=.git/info/ of the entry exclude writes .git/info/exclude with equal bytes", placed);
    expect(placed).toBe(true);
  });
});

describe("T030 F15: long shadow paths on Windows (plan.md D9)", () => {
  // One shadow below `root` with a 357-unit file path. The shadow folder stays below MAX_PATH, so a process can start in it.
  function longShadow(root: string, global: string) {
    const shadow = join(root, "shadow");
    mkdirSync(shadow, { recursive: true });
    const nested = `${"n".repeat(120)}/${"m".repeat(120)}/.gitignore`;
    const env = { GIT_CONFIG_GLOBAL: global, GIT_DIR: gitDirOf(shadow), GIT_INDEX_FILE: join(shadow, ".git", "index") };
    const long = ["--no-lazy-fetch", "-c", "core.longpaths=true"];
    expect(spawn(shadow, ["--no-lazy-fetch", "init", "-q", "--template="], env).exitCode).toBe(0);
    const oid = spawn(shadow, ["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin"], env, "*.log\n").stdout.toString().trim();
    const info = spawn(shadow, ["--no-lazy-fetch", "update-index", "-z", "--index-info"], env, `100644 ${oid}\t${nested}${NUL}`);
    const checkoutArgs = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f"];
    const without = spawn(shadow, ["--no-lazy-fetch", ...checkoutArgs], env);
    const checkout = spawn(shadow, [...long, ...checkoutArgs], env);
    const verify = spawn(shadow, [...long, "hash-object", "--no-filters", "--stdin-paths"], env, `${nested}\n`);
    const ci = spawn(shadow, [...long, "check-ignore", "--no-index", "-z", "--stdin", "-v", "-n"], env, `${nested.slice(0, -".gitignore".length)}a.log${NUL}`);
    return {
      units: join(shadow, ...nested.split("/")).length,
      info: info.exitCode,
      without: without.exitCode,
      checkout: checkout.exitCode,
      stderr: checkout.stderr.toString().trim().slice(0, 40),
      same: verify.stdout.toString().trim() === oid,
      matched: ci.stdout.toString().split(NUL)[2] === "*.log",
    };
  }

  capabilityCase("F15: without core.longpaths in the global file, -c core.longpaths=true lets hash-object, checkout-index, and check-ignore handle a path of 260 or more units", "windows-path-rules", WINDOWS, () => {
    const r = longShadow(fixtureDir("t030-f15"), FIXTURE_GLOBAL_CONFIG);
    const holds = r.units >= 260 && r.info === 0 && r.without === 128 && r.checkout === 0 && r.same && r.matched;
    observe(`F15 at ${r.units} units without a global core.longpaths: ${JSON.stringify(r)}`, holds);
    expect(holds).toBe(true);
  });

  // Plan.md D9 assumed that the -c item also wins over a global `core.longpaths=false`. Git for Windows 2.56.0.windows.2 keeps the global value
  // for the path open, although `git config` names `true` as the effective value. The checkout then fails, and the preview gives `shadow-copy`.
  capabilityCase("F15: with core.longpaths=false in the global file, -c core.longpaths=true does not reach the checkout of a path of 260 or more units", "windows-path-rules", WINDOWS, () => {
    const root = fixtureDir("t030-f15-false");
    const global = join(root, "longpaths-false.gitconfig");
    writeFileSync(global, `${readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8")}[core]\n\tlongpaths = false\n`);
    const r = longShadow(root, global);
    const effective = spawn(root, ["-c", "core.longpaths=true", "config", "--get", "core.longpaths"], { GIT_CONFIG_GLOBAL: global }).stdout.toString().trim();
    observe(`F15 at ${r.units} units with a global core.longpaths=false: the checkout with -c core.longpaths=true exits ${r.checkout} (${JSON.stringify(r.stderr)}), and git config names ${effective}`, r.checkout === 0);
    expect({ checkout: r.checkout, effective }).toEqual({ checkout: 128, effective: "true" });
  });
});

describe("T030 F16: open submodule facts (plan.md D11)", () => {
  gitCase("F16: ls-files --stage gives one gitlink record; an uninitialized folder resolves to the parent; a .git file with a missing Git folder fails the discovery", () => {
    const s = F.buildSubmodules(gitPath(), "t030-f16");
    const stage = records(g(s.sup, [...READ, "ls-files", "-z", "--stage", "--", "solo"]));
    const one = stage.length === 1 && /^160000 [0-9a-f]{40} 0\tsolo$/.test(stage[0]!);
    observe(`F16 ls-files -z --stage -- solo gives one stage-0 gitlink record: ${JSON.stringify(stage)}`, one);
    expect(one).toBe(true);
    const top = (dir: string) => spawn(dir, ["--no-lazy-fetch", "rev-parse", "--show-toplevel"]);
    const bare = top(join(s.sup, "bare"));
    const parent = text(s.sup, ["rev-parse", "--show-toplevel"]).trim();
    const resolves = bare.exitCode === 0 && bare.stdout.toString().trim() === parent;
    observe("F16 the uninitialized folder bare resolves to the superproject top level", resolves);
    expect(resolves).toBe(true);
    const broken = top(join(s.sup, "broken"));
    observe(`F16 rev-parse in broken, whose .git file names a missing folder, exits ${broken.exitCode}`, broken.exitCode === 128);
    expect(broken.exitCode).toBe(128);
    const own = top(join(s.sup, "solo"));
    expect(own.stdout.toString().trim()).not.toBe(parent);
  });
});

describe("T030 F18 and F19: info/exclude in a linked worktree, the RI record forms, and the case names (plan.md D8, D9)", () => {
  gitCase("F18: rev-parse --path-format=absolute --git-path info/exclude in a linked worktree names the common info/exclude", () => {
    const f = F.buildLinkedWorktree(gitPath(), "t030-f18");
    const out = text(f.linked, [...READ, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
    const common = text(f.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    const holds = out === `${common}/info/exclude\n`;
    observe(`F18 the linked worktree gives ${JSON.stringify(out)}`, holds);
    expect(holds).toBe(true);
  });

  gitCase("F19: RI gives an excluded folder as one record, a folder of only ignored paths as d/ beside its records, the empty excluded folder, and the skip-worktree rules; RT gives the matched tracked files", () => {
    const r = F.buildReport(gitPath(), "t030-f19");
    const copy = copyOf(r.repo, "t030-f19-copy");
    // A folder that a nested .gitignore excludes.
    writeFileSync(join(copy, "sub", ".gitignore"), "!*.log\n/local\ndeeper/\n");
    const ri = listed(copy, RI_ARGS);
    const rt = listed(copy, RT_ARGS);
    observe(`F19 RI records ${JSON.stringify(ri)}; RT records ${JSON.stringify(rt)}`, true);
    const excluded = ["ign/", "node_modules/", "emptyign/", "sub/deeper/"].every((d) => ri.includes(d) && !ri.some((p) => p !== d && p.startsWith(d)));
    const onlyIgnored = ri.includes("deep/") && ri.includes("deep/tmp/z");
    const skipWorktree = ri.includes("swt/a.swt");
    observe("F19 an excluded folder is one record without records below it", excluded);
    observe("F19 a folder of only ignored paths gives deep/ beside deep/tmp/z", onlyIgnored);
    observe("F19 RI reads the skip-worktree swt/.gitignore from its index blob", skipWorktree);
    observe(`F19 RT holds build/keep.txt below the excluded /build/: ${rt.includes("build/keep.txt")}`, rt.includes("build/keep.txt"));
    expect({ excluded, onlyIgnored, skipWorktree, keep: rt.includes("build/keep.txt") }).toEqual({ excluded: true, onlyIgnored: true, skipWorktree: true, keep: true });
  });

  gitCase("F19: up/.GITIGNORE gives rules only on a case-insensitive Windows folder, and dot/.gıtignore gives no rules", () => {
    const f = F.buildCaseNames(gitPath(), "t030-f19-case");
    const ignored = listed(f.repo, IGNORED_ARGS);
    const [up, dot] = checkIgnore(f.repo, ["up/a.txt", "dot/a.txt"]);
    const holds = WINDOWS ? up!.source === "up/.gitignore" && up!.pattern === "*.txt" && dot!.pattern === "" : up!.pattern === "" && dot!.pattern === "";
    observe(`F19 name case: up/a.txt source ${JSON.stringify(up!.source)}, dot/a.txt pattern ${JSON.stringify(dot!.pattern)}, ignored ${JSON.stringify(ignored)}`, holds);
    expect(holds).toBe(true);
  });
});
