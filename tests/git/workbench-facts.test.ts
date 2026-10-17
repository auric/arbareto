// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T001: the self-check of the plan.md P0.1 builders in `workbench-fixtures.ts`. The expected values come from tasks.md T002, never from a Git read.
// T003: the Git facts F1 to F24 and F29 to F31 of research.md R21. A fact prints `OBSERVATION T003:` lines. A `match=false` line is a finding for research.md "Results", not a failure.

import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { printOrigin } from "../origin";
import { factTests, obs, READ, same, STEP, type Observation } from "./fact-runner";
import { useFixtureRoot } from "./fixture-root";
import { put } from "./fixtures";
import { describeGit } from "./git-binary";
import { indexEntries, operationMarkers, rawIndexDigest, sha256, workingFileDigests } from "./git-oracle";
import {
  buildWorkbench,
  canary,
  FIXTURE_MERGE_RESULT,
  repoOf,
  UNTRACKED_FILES,
  untrackedFixture,
  wb,
  type GitOptions,
  type GitResult,
  type WbFixture,
  type WbFixtureName,
  type WbRepo,
} from "./workbench-fixtures";

printOrigin("./workbench-fixtures.ts", import.meta.dir);
useFixtureRoot();

const BUILD_MS = 120_000;
// The first run builds 100,000 files into the fixture cache.
const UNTRACKED_MS = 600_000;

const text = (r: WbRepo, args: string[], allowExit: number[] = [0]) => wb(r, args, { allowExit }).stdout.toString("utf8");
const nulRecords = (s: string) => s.split("\0").filter((x) => x !== "");

// ---- Readers. Each parses a machine-readable Git output. ----

function refMap(r: WbRepo): Record<string, string> {
  const out = text(r, ["for-each-ref", "--format=%(refname)%00%(objectname)"]);
  return Object.fromEntries(out.split("\n").filter((l) => l !== "").map((l) => l.split("\0") as [string, string]));
}

interface WorktreeRecord {
  path: string;
  head?: string;
  branch?: string;
  detached?: true;
  bare?: true;
  locked?: string;
  // The reason is display text, so only its presence counts.
  prunable?: true;
}

// `worktree list --porcelain -z`: one attribute per NUL-ended line, and one more NUL ends the record (git-worktree(1) "Porcelain Format").
function worktreeRecords(raw: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const line of raw.split("\0")) {
    if (line === "") {
      if (current !== null) records.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(" ");
    const [key, value] = space === -1 ? [line, null] : [line.slice(0, space), line.slice(space + 1)];
    if (key === "worktree") current = { path: value! };
    else if (current === null) throw new Error(`worktree attribute before a worktree line: ${JSON.stringify(line)}`);
    else if (key === "HEAD") current.head = value!;
    else if (key === "branch") current.branch = value!;
    else if (key === "detached" && value === null) current.detached = true;
    else if (key === "bare" && value === null) current.bare = true;
    else if (key === "locked") current.locked = value ?? "";
    else if (key === "prunable" && value !== null && value !== "") current.prunable = true;
    else throw new Error(`unknown worktree attribute: ${JSON.stringify(line)}`);
  }
  if (current !== null) throw new Error("worktree record without its final NUL");
  return records;
}

// Paths relative to the fixture folder, with `/`, so two builds compare.
function worktrees(f: WbFixture): WorktreeRecord[] {
  const raw = text(repoOf(f), ["worktree", "list", "--porcelain", "-z"]);
  return worktreeRecords(raw).map((w) => ({ ...w, path: relative(f.root, w.path).replaceAll("\\", "/") }));
}

// `status --porcelain=v2 -z` (git-status(1)): after the kind, "1" has 7 fields before the path, "2" 8 and an original path, "u" 9, "?" and "!" none.
function statusRecords(raw: string): string[] {
  const fields = raw.split("\0");
  const records: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]!;
    if (record === "") continue;
    const kind = record[0]!;
    const before = { "1": 7, "2": 8, u: 9, "?": 0, "!": 0 }[kind];
    if (before === undefined) throw new Error(`unknown status record: ${JSON.stringify(record)}`);
    const parts = record.split(" ");
    const path = parts.slice(before + 1).join(" ");
    records.push(before === 0 ? `${kind} ${path}` : `${kind} ${parts[1]} ${path}`);
    if (kind === "2") i++;
  }
  return records.sort();
}

function stages(r: WbRepo, path: string): string[] {
  return indexEntries(r.git, r.dir).filter((e) => e.path === path).map((e) => `${e.mode} ${e.stage}`);
}

// The fixture root text of one build, so the digests of two builds compare.
function normalizedDigest(f: WbFixture, path: string): string {
  if (!existsSync(path)) return "absent";
  const forms = [f.root, f.root.replaceAll("\\", "/")];
  let content = readFileSync(path, "latin1");
  for (const form of forms) content = content.split(form).join("<root>");
  return sha256(Buffer.from(content, "latin1"));
}

// Refs, the worktree list, the index and working bytes of each worktree, and the configuration digests.
function snapshot(f: WbFixture) {
  const r = repoOf(f);
  const list = worktrees(f);
  const trees: Record<string, unknown> = {};
  for (const w of list) {
    const dir = `${f.root}/${w.path}`;
    if (!existsSync(dir)) continue;
    trees[w.path] = { index: indexEntries(f.git, dir), files: workingFileDigests(dir) };
  }
  const configs = Object.fromEntries(Object.entries(f.configs).map(([label, path]) => [label, normalizedDigest(f, path)]));
  return { refs: refMap(r), worktrees: list, trees, configs, markers: operationMarkers(f.git, f.repo) };
}

// ---- T001: the builder self-check ----

interface ExpectedWorktree {
  path: string;
  // A commit label of the construction.
  head: string;
  branch?: string;
  detached?: true;
  locked?: string;
  prunable?: true;
}

interface Check {
  refs: string[];
  // Git arguments and their stdout without the last LF. An `@label` argument names a commit of the construction.
  outputs?: [string[], string][];
  exits?: [string[], number][];
  worktrees: ExpectedWorktree[];
  // `status --porcelain=v2 -z --untracked-files=all --ignored` records of the main worktree, as `statusRecords` gives them.
  status?: string[];
  stages?: Record<string, string[]>;
  markers?: string[];
  // `config list --show-scope --show-origin -z`: the scopes that hold each key.
  scopes?: Record<string, string[]>;
  // Key to the origin file of its last entry, relative to the fixture folder.
  origins?: Record<string, string>;
}

const main = (head = "main"): ExpectedWorktree => ({ path: "repo", head, branch: "refs/heads/main" });
const SWITCH_REFS = ["refs/heads/main", "refs/heads/target", "refs/remotes/one/topic", "refs/remotes/two/x/topic", "refs/remotes/zero/topic"];
const SWITCH_OUTPUTS: [string[], string][] = [[["rev-list", "--count", "main..target"], "1"]];
const switchCheck = (status: string[]): Check => ({ refs: SWITCH_REFS, outputs: SWITCH_OUTPUTS, worktrees: [main("base")], status });
const MERGE_REFS = ["refs/heads/main", "refs/heads/other", "refs/heads/topic", "refs/remotes/origin/topic"];
const CONFLICT_STATUS = ["u AA aa.txt", "u AU au.txt", "u DD dd.txt", "u DU du.txt", "u UA ua.txt", "u UD ud.txt", "u UU link", "u UU uu.txt"];
const CONFLICT_STAGES = { link: ["120000 1", "120000 2", "120000 3"], "uu.txt": ["100644 1", "100644 2", "100644 3"], "dd.txt": ["100644 1"] };
// spec FR-060, as `config list` prints the names: section and key in lower case.
const FR060_KEYS = [
  "user.name", "user.email", "core.editor", "commit.template", "credential.helper", "diff.tool", "difftool.fixture.path", "difftool.fixture.cmd",
  "merge.tool", "mergetool.fixture.path", "mergetool.fixture.cmd", "core.autocrlf", "i18n.filesencoding", "pull.rebase", "fetch.prune", "merge.autostash",
  "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "pull.ff", "push.default", "push.autosetupremote",
];

const CHECKS: Record<WbFixtureName, Check> = {
  branches: {
    refs: ["refs/heads/feature/a/b", "refs/heads/held", "refs/heads/main", "refs/heads/merged", "refs/heads/unmerged", "refs/heads/wt-held", "refs/remotes/origin/held", "refs/tags/v1"],
    outputs: [
      [["rev-list", "--count", "refs/heads/unmerged", "--not", "--exclude=unmerged", "--branches", "--tags", "--remotes"], "2"],
      [["rev-list", "--count", "refs/heads/merged", "--not", "--exclude=merged", "--branches", "--tags", "--remotes"], "0"],
      [["rev-list", "--count", "refs/heads/held", "--not", "--exclude=held", "--branches", "--tags", "--remotes"], "0"],
      [["rev-list", "--count", "refs/heads/feature/a/b", "--not", "--exclude=feature/a/b", "--branches", "--tags", "--remotes"], "1"],
      [["rev-list", "--count", "@unreachable", "--not", "--branches", "--tags", "--remotes"], "1"],
      [["rev-list", "--count", "refs/heads/main"], "3"],
      [["config", "--local", "--get-regexp", "^branch\\."], "branch.unmerged.remote origin\nbranch.unmerged.merge refs/heads/unmerged"],
    ],
    exits: [[["reflog", "exists", "refs/heads/unmerged"], 0]],
    worktrees: [main(), { path: "wt-other", head: "wt-held", branch: "refs/heads/wt-held" }, { path: "wt-detached", head: "unreachable", detached: true }],
    status: [],
  },
  "switch-clean": switchCheck([]),
  "switch-dirty": switchCheck(["1 .D d.txt", "1 .M b.txt", "1 M. c.txt", "1 MM e.txt", "? notes.txt"]),
  "switch-conflict": switchCheck(["1 .M a.txt"]),
  "switch-untracked": switchCheck(["? new.txt"]),
  "switch-ignored": switchCheck(["! build.log"]),
  "switch-folder": switchCheck(["? dirfile/inner.txt"]),
  "merge-ff": {
    refs: ["refs/heads/main", "refs/heads/topic"],
    outputs: [[["rev-list", "--left-right", "--count", "main...topic"], "0\t2"]],
    exits: [[["merge-base", "--is-ancestor", "main", "topic"], 0]],
    worktrees: [main("base")],
    status: [],
  },
  "merge-diverged": {
    refs: MERGE_REFS,
    outputs: [[["rev-list", "--left-right", "--count", "main...topic"], "1\t2"]],
    exits: [[["merge-base", "--is-ancestor", "main", "topic"], 1]],
    worktrees: [main()],
    status: [],
  },
  "merge-ff-only": {
    refs: MERGE_REFS,
    outputs: [[["rev-list", "--left-right", "--count", "main...topic"], "1\t2"], [["config", "--local", "--get", "merge.ff"], "only"]],
    worktrees: [main()],
    status: [],
  },
  "merge-driver": {
    refs: MERGE_REFS,
    outputs: [[["rev-list", "--left-right", "--count", "main...topic"], "1\t2"], [["check-attr", "merge", "--", "driver.txt"], "driver.txt: merge: canary"]],
    exits: [[["config", "--local", "--get", "merge.canary.driver"], 0]],
    worktrees: [main()],
    status: [],
  },
  "rebase-mix": {
    refs: ["refs/heads/side", "refs/heads/topic", "refs/heads/up", "refs/remotes/origin/topic"],
    outputs: [
      [["rev-list", "--count", "--right-only", "--cherry-pick", "--no-merges", "up...topic"], "4"],
      [["rev-list", "--count", "up..topic"], "6"],
      [["rev-list", "--count", "--merges", "up..topic"], "1"],
      [["rev-list", "--count", "up..topic", "--not", "refs/remotes/origin/topic"], "3"],
    ],
    worktrees: [{ path: "repo", head: "topic", branch: "refs/heads/topic" }],
    status: [],
  },
  "rebase-fixup": {
    refs: ["refs/heads/topic", "refs/heads/up"],
    outputs: [[["rev-list", "--count", "up..topic"], "3"], [["log", "-1", "--format=%s", "topic"], "fixup! feature"]],
    worktrees: [{ path: "repo", head: "fixup", branch: "refs/heads/topic" }],
    status: [],
  },
  "rebase-update-refs": {
    refs: ["refs/heads/outside", "refs/heads/part", "refs/heads/topic", "refs/heads/up", "refs/heads/wt-part"],
    outputs: [[["rev-list", "--count", "up..topic"], "3"], [["config", "--local", "--get", "rebase.updateRefs"], "true"]],
    worktrees: [{ path: "repo", head: "topic", branch: "refs/heads/topic" }, { path: "wt-part", head: "c2", branch: "refs/heads/wt-part" }],
    status: [],
  },
  "conflict-merge": {
    refs: ["refs/heads/main", "refs/heads/topic"],
    worktrees: [main("ours")],
    status: CONFLICT_STATUS,
    stages: CONFLICT_STAGES,
    markers: ["MERGE_HEAD"],
  },
  "conflict-rebase": {
    refs: ["refs/heads/main", "refs/heads/topic"],
    outputs: [[["rev-parse", "REBASE_HEAD"], "@theirs"]],
    worktrees: [{ path: "repo", head: "ours", detached: true }],
    status: CONFLICT_STATUS,
    stages: CONFLICT_STAGES,
    markers: ["rebase-merge"],
  },
  "staging-tree": {
    refs: ["refs/heads/main"],
    worktrees: [main("base")],
    status: ["1 .M docs/d.txt", "1 .M src/a.txt", "1 .M src/lib/deep/c.txt", "? src/lib/new.txt", "? src/new-dir/n1.txt", "? src/new-dir/n2.txt", "? top-new.txt"],
  },
  "staging-hunks": {
    refs: ["refs/heads/main"],
    outputs: [[["diff", "--numstat"], "2\t0\tadded.txt\n0\t1\tdeleted.txt\n1\t1\teof.txt\n2\t2\tmixed.txt\n0\t2\tremoved.txt"]],
    worktrees: [main("base")],
    status: ["1 .D deleted.txt", "1 .M added.txt", "1 .M eof.txt", "1 .M mixed.txt", "1 .M removed.txt"],
  },
  worktrees: {
    refs: ["refs/heads/dirty-b", "refs/heads/locked-n", "refs/heads/locked-r", "refs/heads/main", "refs/heads/prunable-b", "refs/heads/spaces-b"],
    worktrees: [
      main("base"),
      { path: "wt with spaces", head: "base", branch: "refs/heads/spaces-b" },
      { path: "wt-dirty", head: "base", branch: "refs/heads/dirty-b" },
      { path: "wt-locked", head: "base", branch: "refs/heads/locked-n", locked: "" },
      { path: "wt-locked-reason", head: "base", branch: "refs/heads/locked-r", locked: "fixture reason\nwith newline" },
      { path: "wt-prunable", head: "base", branch: "refs/heads/prunable-b", prunable: true },
    ],
    status: [],
  },
  "config-scopes": {
    refs: ["refs/heads/main"],
    worktrees: [main("base")],
    scopes: Object.fromEntries(FR060_KEYS.map((k) => [k, ["global", "local", "system"]])),
    origins: { "core.editor": "repo/.git/included.gitconfig", "user.email": "repo/.git/config", "user.name": "repo/.git/config" },
    outputs: [[["config", "get", "--local", "--all", "credential.helper"], "local-helper-1\nlocal-helper-2"]],
  },
  "config-xdg": {
    refs: ["refs/heads/main"],
    worktrees: [main("base")],
    scopes: { "user.name": ["global"], "user.email": ["global"] },
    origins: { "user.name": "home/.config/git/config" },
  },
  "amend-on-upstream": {
    refs: ["refs/heads/main", "refs/remotes/origin/main"],
    outputs: [[["for-each-ref", "--format=%(upstream)", "refs/heads/main"], "refs/remotes/origin/main"]],
    exits: [[["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"], 0]],
    worktrees: [main("second")],
    status: [],
  },
  "amend-ahead": {
    refs: ["refs/heads/main", "refs/remotes/origin/main"],
    outputs: [[["for-each-ref", "--format=%(upstream)", "refs/heads/main"], "refs/remotes/origin/main"]],
    exits: [[["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"], 1]],
    worktrees: [main("third")],
    status: [],
  },
  "amend-no-upstream": {
    refs: ["refs/heads/main"],
    outputs: [[["for-each-ref", "--format=%(upstream)", "refs/heads/main"], ""]],
    worktrees: [main("second")],
    status: [],
  },
};

const resolve = (f: WbFixture, args: string[]) =>
  args.map((a) => {
    if (!a.startsWith("@")) return a;
    const oid = f.oids[a.slice(1)];
    if (oid === undefined) throw new Error(`unknown commit label ${a}`);
    return oid;
  });

function configEntries(f: WbFixture): { scope: string; origin: string; key: string }[] {
  const raw = wb(repoOf(f), ["config", "list", "--show-scope", "--show-origin", "-z"]).stdout.toString("utf8");
  const fields = raw.split("\0");
  const entries: { scope: string; origin: string; key: string }[] = [];
  // scope NUL origin NUL key, then LF and the value when it has one, then NUL.
  for (let i = 0; i + 2 < fields.length; i += 3) entries.push({ scope: fields[i]!, origin: fields[i + 1]!, key: fields[i + 2]!.split("\n")[0]! });
  return entries;
}

function selfCheck(f: WbFixture, check: Check): void {
  const r = repoOf(f);
  const refs = refMap(r);
  expect(Object.keys(refs).sort()).toEqual([...check.refs].sort());
  // The construction recorded each ref value.
  expect(refs).toEqual(f.refs);
  for (const [args, stdout] of check.outputs ?? []) expect([args, text(r, resolve(f, args)).replace(/\n$/, "")]).toEqual([args, resolve(f, [stdout])[0]!]);
  for (const [args, exit] of check.exits ?? []) expect([args, wb(r, resolve(f, args), { allowExit: "any" }).exitCode]).toEqual([args, exit]);
  const expected = check.worktrees.map(({ head, ...w }) => ({ ...w, head: resolve(f, [`@${head}`])[0]! }));
  const byPath = (a: WorktreeRecord, b: WorktreeRecord) => (a.path === "repo" ? -1 : b.path === "repo" ? 1 : a.path < b.path ? -1 : 1);
  expect(worktrees(f).sort(byPath)).toEqual(expected.sort(byPath));
  if (check.status) expect(statusRecords(text(r, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored"]))).toEqual([...check.status].sort());
  for (const [path, want] of Object.entries(check.stages ?? {})) expect([path, stages(r, path)]).toEqual([path, want]);
  if (check.markers) expect(operationMarkers(f.git, f.repo)).toEqual(check.markers);
  if (check.scopes) {
    const entries = configEntries(f);
    for (const [key, scopes] of Object.entries(check.scopes)) expect([key, [...new Set(entries.filter((e) => e.key === key).map((e) => e.scope))].sort()]).toEqual([key, scopes]);
    for (const [key, origin] of Object.entries(check.origins ?? {})) {
      const last = entries.filter((e) => e.key === key).at(-1);
      // Git prints the local file relative to the worktree top.
      expect([key, last && relative(f.root, resolvePath(f.repo, last.origin.replace(/^file:/, ""))).replaceAll("\\", "/")]).toEqual([key, origin]);
    }
  }
  // The digest at the end of the build: no read of the self-check changed a configuration file.
  for (const [label, path] of Object.entries(f.configs)) expect([label, existsSync(path) ? sha256(readFileSync(path)) : "absent"]).toEqual([label, f.digests[label]!]);
}

describeGit("workbench fixture self-check (T001)", (git) => {
  for (const [name, check] of Object.entries(CHECKS) as [WbFixtureName, Check][]) {
    test(name, () => {
      const a = buildWorkbench(git, name, `${name}-a`);
      selfCheck(a, check);
      const b = buildWorkbench(git, name, `${name}-b`);
      expect(snapshot(b)).toEqual(snapshot(a));
    }, BUILD_MS);
  }

  // The cached build replaces the second build: the cache key covers the builder source and the Git build.
  test("untracked-100k", () => {
    const f = untrackedFixture(git);
    const r = repoOf(f);
    expect(refMap(r)).toEqual(f.refs);
    expect(Object.keys(f.refs)).toEqual(["refs/heads/main"]);
    expect(text(r, ["--no-optional-locks", "rev-list", "--count", "main"]).trim()).toBe("1");
    expect(nulRecords(text(r, ["--no-optional-locks", "ls-files", "-z", "--others", "--exclude-standard"])).length).toBe(UNTRACKED_FILES);
    expect(worktreeRecords(text(r, ["worktree", "list", "--porcelain", "-z"])).length).toBe(1);
    for (const [label, path] of Object.entries(f.configs)) expect([label, sha256(readFileSync(path))]).toEqual([label, f.digests[label]!]);
  }, UNTRACKED_MS);
});

// ---- T003: the Git facts F1 to F24 and F29 to F31 ----

const TASK = "T003";
const FACT_MS = 300_000;
// research.md R21 F21: an empty standard input must end the merge tool question at once.
const MERGETOOL_MS = 60_000;
// `check-ignore` refuses the literal pathspec magic (F1 `discard.check-ignore.with-literal-pathspecs`), so the oracle reads of this file omit it.
const READ_IGNORE = ["--no-lazy-fetch", "--no-optional-locks"];
const PUSH = [...STEP, "stash", "push", "--quiet", "-m", "Arbareto: switch to target"];
const CHECKOUT_TARGET = [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "target", "--"];
const REBASE_UP = [...STEP, "rebase", "--no-autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"];

// A timeout gives -1, which is no Git exit.
const exitObs = (fact: string, expected: number | "nonzero", exit: number) => obs(fact, expected, exit, expected === "nonzero" ? exit > 0 : exit === expected);

const run = (r: WbRepo, args: string[], o: GitOptions = {}): GitResult => wb(r, args, { allowExit: "any", ...o });
const stdout = (res: GitResult) => res.stdout.toString("utf8");
const at = (r: WbRepo, dir: string): WbRepo => ({ ...r, dir });

let copies = 0;
// A second build is the copy (T001 proves that two builds are equal).
const copy = (git: string, name: WbFixtureName) => buildWorkbench(git, name, `${name}-copy-${++copies}`);
const builds = new Map<WbFixtureName, WbFixture>();
// One build per fixture for reads only.
function shared(git: string, name: WbFixtureName): WbFixture {
  if (!builds.has(name)) builds.set(name, buildWorkbench(git, name, `${name}-shared`));
  return builds.get(name)!;
}

function headOf(r: WbRepo): string {
  const sym = run(r, ["symbolic-ref", "-q", "HEAD"]);
  return sym.exitCode === 0 ? stdout(sym).trim() : stdout(wb(r, ["rev-parse", "HEAD"])).trim();
}

// HEAD, refs, the index, working bytes, operation markers, and the local configuration bytes of a main worktree.
function state(r: WbRepo): Record<string, unknown> {
  return { head: headOf(r), refs: refMap(r), index: indexEntries(r.git, r.dir), files: workingFileDigests(r.dir), markers: operationMarkers(r.git, r.dir), config: sha256(readFileSync(join(r.dir, ".git", "config"))) };
}
const changed = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).filter((k) => !same(a[k], b[k]));

function stashValue(r: WbRepo): string | null {
  const res = run(r, [...READ, "rev-parse", "--verify", "-q", "refs/stash"]);
  return res.exitCode === 0 ? stdout(res).trim() : null;
}
// The contract Δ3 drop step read. `show-ref --exists` exits 2 for a missing ref (git-show-ref(1)).
function stashReflog(r: WbRepo): string[] {
  if (run(r, [...READ, "show-ref", "--exists", "refs/stash"]).exitCode !== 0) return [];
  return nulRecords(stdout(wb(r, [...READ, "log", "-g", "-z", "--no-show-signature", "--format=%H", "refs/stash", "--"])));
}

// The commit message: the bytes after the first empty line of `cat-file commit`.
const message = (r: WbRepo, rev: string) => {
  const raw = stdout(wb(r, ["cat-file", "commit", rev]));
  return raw.slice(raw.indexOf("\n\n") + 2);
};
const subjects = (r: WbRepo, range: string[]) => stdout(wb(r, ["log", "--reverse", "--format=%s", ...range])).split("\n").filter((l) => l !== "");
const count = (r: WbRepo, args: string[]) => Number(stdout(wb(r, [...READ, "rev-list", "--count", ...args])).trim());

// The raw attribute lines of each `worktree list --porcelain -z` record.
function recordLines(raw: string): string[][] {
  return raw.split("\0\0").filter((r) => r !== "").map((r) => r.split("\0"));
}

// The plan.md D3 in-the-way check (research.md R4), built from its text. Git's own checkout is the oracle.
// `bytes: false` counts a file only when the index holds no stage-0 entry at its path.
function inTheWay(r: WbRepo, head: string, target: string, bytes = true): string[] {
  const fields = stdout(wb(r, [...READ, "diff-tree", "-r", "-z", "--no-renames", "--name-status", head, target])).split("\0");
  const writes = new Set<string>();
  const candidates = new Set<string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [status, path] = [fields[i]!, fields[i + 1]!];
    candidates.add(path);
    if (status === "D") continue;
    writes.add(path);
    const parts = path.split("/");
    for (let k = 1; k < parts.length; k++) candidates.add(parts.slice(0, k).join("/"));
  }
  const index = new Map(indexEntries(r.git, r.dir).filter((e) => e.stage === 0).map((e) => [e.path, e.oid]));
  const counted = [...candidates].filter((c) => {
    const path = join(r.dir, c);
    if (!existsSync(path) && !isLink(path)) return false;
    if (lstatSync(path).isDirectory()) return writes.has(c);
    const oid = index.get(c);
    return oid === undefined || (bytes && stdout(wb(r, ["hash-object", "--no-filters", "--", c])).trim() !== oid);
  });
  if (counted.length === 0) return [];
  // `check-ignore` exits 1 when no path is ignored (git-check-ignore(1)).
  const ignored = new Set(nulRecords(stdout(wb(r, [...READ_IGNORE, "check-ignore", "-z", "--stdin", "--no-index"], { input: counted.map((c) => `${c}\0`).join(""), allowExit: [0, 1] }))));
  return counted.filter((c) => !ignored.has(c)).sort();
}
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// A hook canary in the common Git folder. Git starts a hook only when its file exists.
function hookCanary(f: WbFixture, event: string): string {
  const log = join(f.root, "canaries", `${event}.log`);
  mkdirSync(dirname(log), { recursive: true });
  put(f.repo, `.git/hooks/${event}`, `#!/bin/sh\necho "${event} $*" >> '${log.replaceAll("\\", "/")}'\n`);
  return log;
}
const logLines = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : []);

// F1: every argv of contract Δ3 is accepted. Each argv runs where its documented success exit applies.
function f1(git: string): Observation[] {
  const out: Observation[] = [];
  const step = (label: string, r: WbRepo, args: string[], exits: number[], o: GitOptions = {}) => {
    const res = run(r, args, o);
    out.push(obs(`F1.${label}`, exits, res.exitCode, exits.includes(res.exitCode)));
    return res;
  };
  const b = shared(git, "branches");
  const br = repoOf(b);
  step("readBranches.for-each-ref", br, [...READ, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00%(symref)", "refs/heads", "refs/remotes"], [0]);
  step("readWorktrees", br, [...READ, "worktree", "list", "--porcelain", "-z"], [0]);
  step("readGitSettings", br, [...READ, "config", "list", "--show-scope", "--show-origin", "-z"], [0]);
  step("switch.status", br, [...READ, "status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=dirty"], [0]);
  step("switch.rev-parse-commit", br, [...READ, "rev-parse", "--verify", "-q", "refs/heads/merged^{commit}"], [0]);
  step("switch.contains", br, [...READ, "for-each-ref", `--contains=${b.oids.unreachable}`, "--count=1", "--format=%(refname)"], [0]);
  step("switch.stash-exists", br, [...READ, "show-ref", "--exists", "refs/stash"], [2]);
  step("switch.stash-value", br, [...READ, "rev-parse", "--verify", "-q", "refs/stash"], [1]);
  step("track.name-exists", br, [...READ, "show-ref", "--exists", "refs/heads/main"], [0]);
  step("create-branch.check-ref-format", br, [...READ, "check-ref-format", "--branch", "topic"], [0]);
  step("delete-branch.count", br, [...READ, "rev-list", "--count", b.oids.unmerged!, "--not", "--exclude=unmerged", "--branches", "--tags", "--remotes"], [0]);
  step("delete-branch.reflog-exists", br, [...READ, "reflog", "exists", "HEAD"], [0]);
  step("delete-branch.reflog", br, [...READ, "log", "-g", "-z", "--no-show-signature", "--format=%H", "-n", "10000", "HEAD", "--"], [0]);
  step("amend.cat-file", br, [...READ, "cat-file", "commit", b.oids.main!], [0]);
  step("amend.upstream", br, [...READ, "for-each-ref", "--format=%(upstream)", "refs/heads/unmerged"], [0]);
  step("worktree-remove.status", br, [...READ, "-C", join(b.root, "wt-other"), "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty"], [0]);

  const u = shared(git, "switch-untracked");
  const ur = repoOf(u);
  step("discard.diff-tree", ur, [...READ, "diff-tree", "-r", "-z", "--no-renames", "--name-status", u.oids.base!, u.oids.target!], [0]);
  step("discard.ls-files", ur, [...READ, "ls-files", "-z", "--stage", "--", "a.txt", "new.txt"], [0]);
  step("discard.check-ignore", ur, [...READ_IGNORE, "check-ignore", "-z", "--stdin", "--no-index"], [0], { input: "new.txt\0build.log\0" });
  // Contract Δ3: Git exits 128 for this read with `--literal-pathspecs`.
  step("discard.check-ignore.with-literal-pathspecs", ur, [...READ, "check-ignore", "-z", "--stdin", "--no-index"], [128], { input: "new.txt\0build.log\0" });

  const m = shared(git, "merge-diverged");
  const mr = repoOf(m);
  step("merge.left-right", mr, [...READ, "rev-list", "--left-right", "--count", `HEAD...${m.oids.topic}`], [0]);
  step("merge.is-ancestor", mr, [...READ, "merge-base", "--is-ancestor", "HEAD", m.oids.topic!], [1]);
  step("merge.fmt-merge-msg", mr, [...READ, "fmt-merge-msg"], [0], { input: `${m.oids.topic}\t\tbranch 'topic' of .\n` });

  const x = shared(git, "rebase-mix");
  const xr = repoOf(x);
  const up = x.oids.up!;
  step("rebase.moved", xr, [...READ, "rev-list", "--count", "--right-only", "--cherry-pick", "--no-merges", `${up}...HEAD`], [0]);
  // plan.md D6: with `rebase.rebaseMerges` true, `--no-merges` goes.
  step("rebase.moved.rebase-merges", xr, [...READ, "rev-list", "--count", "--right-only", "--cherry-pick", `${up}...HEAD`], [0]);
  step("rebase.rewritten", xr, [...READ, "rev-list", "--count", `${up}..HEAD`], [0]);
  step("rebase.held", xr, [...READ, "rev-list", "--count", `${up}..HEAD`, "--not", "--remotes"], [0]);
  step("rebase.force-note", xr, [...READ, "rev-list", "--count", `${up}..HEAD`, "--not", "refs/remotes/origin/topic"], [0]);
  step("rebase.update-refs", xr, [...READ, "for-each-ref", "--merged=HEAD", `--no-merged=${up}`, "--format=%(refname)", "refs/heads"], [0]);

  step("choose-side.ls-files", repoOf(shared(git, "conflict-merge")), [...READ, "ls-files", "-z", "--stage", "--", "uu.txt"], [0]);
  step("ignore.exclude-path", repoOf(shared(git, "worktrees")), [...READ, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], [0]);
  step("amend.is-ancestor", repoOf(shared(git, "amend-on-upstream")), [...READ, "merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"], [0]);

  // Steps, each on its own copy.
  const s = copy(git, "switch-clean");
  const sr = repoOf(s);
  step("switch.keep", sr, CHECKOUT_TARGET, [0]);
  step("switch.detach", sr, [...STEP, "checkout", "--no-recurse-submodules", "--detach", s.oids.base!, "--"], [0]);
  step("switch.track", sr, [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/one/topic", "--"], [0]);
  step("create-branch.checkout", sr, [...STEP, "checkout", "--no-recurse-submodules", "-b", "fresh", s.oids.base!, "--"], [0]);

  const d = repoOf(copy(git, "switch-dirty"));
  step("stash.push", d, PUSH, [0]);
  step("stash.drop-read", d, [...READ, "log", "-g", "-z", "--no-show-signature", "--format=%H", "refs/stash", "--"], [0]);
  step("stash.apply-index", d, [...STEP, "stash", "apply", "--index", stashValue(d) ?? "refs/stash"], [0]);
  step("stash.drop", d, [...STEP, "stash", "drop", "--quiet", "stash@{0}"], [0]);

  const c = copy(git, "branches");
  const cr = repoOf(c);
  step("create-branch.branch", cr, [...STEP, "branch", "--end-of-options", "new-b", c.oids.main!], [0]);
  step("rename-branch", cr, [...STEP, "branch", "-m", "--end-of-options", "new-b", "new-c"], [0]);
  step("delete-branch.update-ref", cr, [...STEP, "update-ref", "--no-deref", "-d", "refs/heads/unmerged", c.oids.unmerged!], [0]);
  step("delete-branch.remove-section", cr, [...STEP, "config", "--local", "--remove-section", "branch.unmerged"], [0]);
  step("worktree-add.new", cr, [...STEP, "worktree", "add", "-b", "wt-new", "--", join(c.root, "wt-new"), c.oids.main!], [0]);
  step("worktree-add.existing", cr, [...STEP, "worktree", "add", "--", join(c.root, "wt-merged"), "merged"], [0]);
  step("worktree-remove", cr, [...STEP, "worktree", "remove", "--", join(c.root, "wt-new")], [0]);
  put(join(c.root, "wt-merged"), "untracked.txt", "untracked\n");
  step("worktree-remove.force", cr, [...STEP, "worktree", "remove", "--force", "--", join(c.root, "wt-merged")], [0]);
  step("worktree-prune", cr, [...STEP, "worktree", "prune"], [0]);
  step("config-save.set", cr, [...STEP, "config", "set", "--local", "--", "user.name", "Fixture Name"], [0]);
  step("config-save.unset", cr, [...STEP, "config", "unset", "--local", "--", "user.name"], [0]);

  for (const [label, fixture, flags] of [
    ["merge", "merge-diverged", ["--no-log", "-m", "Edited message"]],
    ["merge.no-ff", "merge-ff", ["--no-ff", "--no-log", "-m", "Edited message"]],
    ["merge.no-commit", "merge-diverged", ["--no-commit", "--no-log", "-m", "Edited message"]],
    ["merge.no-ff-no-commit", "merge-ff", ["--no-ff", "--no-commit", "--no-log", "-m", "Edited message"]],
    ["merge.squash", "merge-diverged", ["--squash"]],
  ] as [string, WbFixtureName, string[]][]) {
    step(label, repoOf(copy(git, fixture)), [...STEP, "merge", "--no-autostash", "--no-edit", ...flags, "--end-of-options", "refs/heads/topic"], [0]);
  }
  step("rebase.no-options", repoOf(copy(git, "rebase-mix")), REBASE_UP, [0]);
  step("rebase.options", repoOf(copy(git, "rebase-mix")), [...STEP, "rebase", "--autostash", "--autosquash", "--end-of-options", "refs/heads/up"], [0]);

  const k = repoOf(copy(git, "conflict-merge"));
  step("choose-side.ours", k, [...STEP, "--literal-pathspecs", "checkout", "--no-recurse-submodules", "--ours", "--", "uu.txt"], [0]);
  step("choose-side.theirs", k, [...STEP, "--literal-pathspecs", "checkout", "--no-recurse-submodules", "--theirs", "--", "aa.txt"], [0]);
  step("mergetool", k, [...STEP, "--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", "uu.txt"], [0], { input: "", timeoutMs: MERGETOOL_MS });

  step("amend.commit", repoOf(copy(git, "amend-on-upstream")), [...STEP, "commit", "--quiet", "--amend", "--file=-"], [0], { input: "Amended message\n" });
  return out;
}

// F2: `checkout -b` with a refused switch creates no branch.
function f2(git: string): Observation[] {
  const out: Observation[] = [];
  const cases: [string, (f: WbFixture) => string[]][] = [
    ["track", () => [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/one/topic", "--"]],
    ["start", (f) => [...STEP, "checkout", "--no-recurse-submodules", "-b", "topic", f.oids.target!, "--"]],
  ];
  for (const [label, args] of cases) {
    const f = copy(git, "switch-conflict");
    const r = repoOf(f);
    const before = state(r);
    out.push(exitObs(`F2.${label}.exit`, "nonzero", run(r, args(f)).exitCode));
    out.push(obs(`F2.${label}.branch-exists-exit`, 2, run(r, [...READ, "show-ref", "--exists", "refs/heads/topic"]).exitCode));
    out.push(obs(`F2.${label}.changed`, [], changed(before, state(r))));
  }
  return out;
}

// F3: Keep changes with a conflicting change leaves HEAD, the index, and every working byte unchanged.
function f3(git: string): Observation[] {
  const r = repoOf(copy(git, "switch-conflict"));
  const before = state(r);
  return [exitObs("F3.exit", "nonzero", run(r, CHECKOUT_TARGET).exitCode), obs("F3.changed", [], changed(before, state(r)))];
}

// F4: the stash protocol observations of plan.md D3.
function f4(git: string): Observation[] {
  const protocol = (r: WbRepo, head: string) => {
    const p = stashValue(r);
    const exit = run(r, PUSH).exitCode;
    const s = stashValue(r);
    const created = s !== p;
    const label = (oid: string) => (created && oid === s ? "S" : oid === p ? "P" : "other");
    return { exit, created, reflog: stashReflog(r).slice(0, 2).map(label), parentIsHead: created ? stdout(wb(r, ["rev-parse", `${s}^1`])).trim() === head : null };
  };
  const earlier = (r: WbRepo, n: number, apply: boolean) => {
    for (let i = 1; i <= n; i++) {
      wb(r, [...STEP, "stash", "push", "--quiet", "-m", `earlier ${i}`]);
      if (apply) wb(r, [...STEP, "stash", "apply", "--quiet", "--index", "stash@{0}"]);
    }
  };
  const out: Observation[] = [];
  for (const [label, fixture, n, apply, expected] of [
    ["none-earlier", "switch-dirty", 0, true, { exit: 0, created: true, reflog: ["S"], parentIsHead: true }],
    ["one-earlier", "switch-dirty", 1, true, { exit: 0, created: true, reflog: ["S", "P"], parentIsHead: true }],
    ["two-earlier", "switch-dirty", 2, true, { exit: 0, created: true, reflog: ["S", "P"], parentIsHead: true }],
    ["nothing", "switch-clean", 0, false, { exit: 0, created: false, reflog: [], parentIsHead: null }],
    ["nothing-one-earlier", "switch-dirty", 1, false, { exit: 0, created: false, reflog: ["P"], parentIsHead: null }],
  ] as [string, WbFixtureName, number, boolean, unknown][]) {
    const f = copy(git, fixture);
    const r = repoOf(f);
    earlier(r, n, apply);
    out.push(obs(`F4.${label}`, expected, protocol(r, f.oids.base!)));
  }
  return out;
}

// F5: a refused `stash apply --index` changes no file.
function f5(git: string): Observation[] {
  const f = copy(git, "switch-clean");
  const r = repoOf(f);
  // The staged change and the target change the same line, so the index part of the stash cannot apply.
  put(f.repo, "a.txt", "a staged\n");
  wb(r, ["add", "--", "a.txt"]);
  wb(r, PUSH);
  const s = stashValue(r)!;
  const checkout = run(r, CHECKOUT_TARGET).exitCode;
  const before = state(r);
  const apply = run(r, [...STEP, "stash", "apply", "--index", s]).exitCode;
  return [exitObs("F5.checkout", 0, checkout), exitObs("F5.apply-index.exit", "nonzero", apply), obs("F5.apply-index.changed", [], changed(before, state(r)))];
}

// F6: Discard through a stash equals `checkout --force` for tracked files, and keeps untracked files.
function f6(git: string): Observation[] {
  const a = repoOf(copy(git, "switch-dirty"));
  const push = run(a, PUSH).exitCode;
  const s = stashValue(a)!;
  const checkout = run(a, CHECKOUT_TARGET).exitCode;
  const n = stashReflog(a).indexOf(s);
  const drop = run(a, [...STEP, "stash", "drop", "--quiet", `stash@{${n}}`]).exitCode;
  const b = repoOf(copy(git, "switch-dirty"));
  const force = run(b, [...STEP, "checkout", "--no-recurse-submodules", "--force", "target", "--"]).exitCode;
  const sa = state(a);
  return [
    obs("F6.exits", { push: 0, checkout: 0, drop: 0, force: 0 }, { push, checkout, drop, force }),
    obs("F6.differs-from-force", [], changed(sa, state(b))),
    obs("F6.untracked-kept", sha256(Buffer.from("notes\n")), (sa.files as Record<string, string>)["notes.txt"] ?? "absent"),
  ];
}

// F7: the plan.md D3 in-the-way check names a path for each case that Git's own checkout refuses.
function f7(git: string): Observation[] {
  const out: Observation[] = [];
  for (const [label, fixture, setup, stashFirst] of [
    ["untracked-file", "switch-untracked", null, false],
    ["ignored-file", "switch-ignored", null, false],
    ["folder-for-file", "switch-folder", null, false],
    ["file-for-folder", "switch-clean", (f: WbFixture) => put(f.repo, "sub", "sub file\n"), false],
    ["tracked-conflict", "switch-conflict", null, true],
    ["tracked-dirty", "switch-dirty", null, true],
  ] as [string, WbFixtureName, ((f: WbFixture) => void) | null, boolean][]) {
    const f = copy(git, fixture);
    const r = repoOf(f);
    setup?.(f);
    const found = inTheWay(r, f.oids.base!, f.oids.target!);
    const untrackedOnly = inTheWay(r, f.oids.base!, f.oids.target!, false);
    // Discard stashes the tracked changes first (plan.md D3).
    if (stashFirst) wb(r, PUSH);
    const gitRefused = run(r, CHECKOUT_TARGET).exitCode !== 0;
    out.push(obs(`F7.${label}`, { refusedImpliesFound: true }, { gitRefused, found }, !gitRefused || found.length > 0));
    out.push(obs(`F7.${label}.index-entry-rule`, { foundEqualsRefused: true }, { gitRefused, found: untrackedOnly }, gitRefused === untrackedOnly.length > 0));
  }
  return out;
}

// F8: the contract track checkout writes the same `branch.<new>` keys as Git's own `checkout --track`.
function f8(git: string): Observation[] {
  const a = repoOf(copy(git, "switch-clean"));
  const contract = run(a, [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/one/topic", "--"]).exitCode;
  const b = repoOf(copy(git, "switch-clean"));
  const own = run(b, ["checkout", "--track", "one/topic"]).exitCode;
  const keys = (r: WbRepo) => stdout(run(r, ["config", "--local", "-z", "--get-regexp", "^branch\\.topic\\."]));
  const sa = state(a);
  const sb = state(b);
  return [obs("F8.exits", { contract: 0, own: 0 }, { contract, own }), obs("F8.branch-keys", keys(b), keys(a)), obs("F8.differs-from-own", [], changed(sa, sb))];
}

// F9: `update-ref -d` plus `--remove-section` equals `branch -D`; a moved branch makes `update-ref -d` change nothing.
function f9(git: string): Observation[] {
  const view = (f: WbFixture) => {
    const r = repoOf(f);
    return {
      refs: refMap(r),
      branchReflogExists: run(r, ["reflog", "exists", "refs/heads/unmerged"]).exitCode,
      headReflog: nulRecords(stdout(wb(r, [...READ, "log", "-g", "-z", "--format=%H", "HEAD", "--"]))),
      config: normalizedDigest(f, join(f.repo, ".git", "config")),
    };
  };
  const a = copy(git, "branches");
  const deleted = run(repoOf(a), [...STEP, "update-ref", "--no-deref", "-d", "refs/heads/unmerged", a.oids.unmerged!]).exitCode;
  const section = run(repoOf(a), [...STEP, "config", "--local", "--remove-section", "branch.unmerged"]).exitCode;
  const b = copy(git, "branches");
  const own = run(repoOf(b), ["branch", "-D", "unmerged"]).exitCode;
  const c = copy(git, "branches");
  const before = view(c);
  const moved = run(repoOf(c), [...STEP, "update-ref", "--no-deref", "-d", "refs/heads/unmerged", c.oids.main!]).exitCode;
  const va = view(a);
  const vb = view(b);
  const vc = view(c);
  return [
    obs("F9.exits", { updateRef: 0, removeSection: 0, branchD: 0 }, { updateRef: deleted, removeSection: section, branchD: own }),
    obs("F9.refs", vb.refs, va.refs),
    obs("F9.branch-reflog-exists-exit", vb.branchReflogExists, va.branchReflogExists),
    obs("F9.head-reflog", vb.headReflog, va.headReflog),
    obs("F9.config-bytes", vb.config, va.config),
    exitObs("F9.moved.exit", "nonzero", moved),
    obs("F9.moved.changed", [], changed(before, vc)),
  ];
}

// F10: the unmerged count equals the commits that `branch -D` makes unreachable from every branch, tag, and remote-tracking ref.
function f10(git: string): Observation[] {
  const s = shared(git, "branches");
  const out: Observation[] = [];
  for (const name of ["unmerged", "merged", "held", "feature/a/b"]) {
    const counted = count(repoOf(s), [s.refs[`refs/heads/${name}`]!, "--not", `--exclude=${name}`, "--branches", "--tags", "--remotes"]);
    const r = repoOf(copy(git, "branches"));
    const reachable = () => new Set(stdout(wb(r, ["rev-list", "--branches", "--tags", "--remotes"])).split("\n").filter((l) => l !== ""));
    const before = reachable();
    wb(r, ["branch", "-D", name]);
    const after = reachable();
    out.push(obs(`F10.${name}`, [...before].filter((c) => !after.has(c)).length, counted));
  }
  return out;
}

// F11: `check-ref-format --branch` exit and output (git-check-ref-format(1)). Git's own `branch` create of each name is the comparison.
function f11(git: string): Observation[] {
  const f = copy(git, "branches");
  const r = repoOf(f);
  wb(r, ["checkout", "-q", "merged", "--"]);
  wb(r, ["checkout", "-q", "main", "--"]);
  const check = (name: string) => {
    const res = run(r, [...READ, "check-ref-format", "--branch", name]);
    return { exit: res.exitCode, stdout: stdout(res) };
  };
  const out: Observation[] = [];
  const exact = (kind: string, name: string, stdout: string) => ({ kind, name, expected: { exit: 0, stdout } as unknown, match: (c: { exit: number; stdout: string }) => same(c, { exit: 0, stdout }) });
  const cases = [
    ...["topic", "feature/x", "a.b"].map((name) => exact("valid", name, `${name}\n`)),
    ...["a..b", "-dash", "HEAD", "with space", "x.lock", "@", "a~b", "a/", "/a"].map((name) => ({ kind: "invalid", name, expected: { exit: "nonzero" } as unknown, match: (c: { exit: number }) => c.exit > 0 })),
    exact("previous", "@{-1}", "merged\n"),
  ];
  for (const { kind, name, expected, match } of cases) {
    const c = check(name);
    out.push(obs(`F11.${kind}.${name}`, expected, c, match(c)));
    // plan.md D4 accepts a name only with exit 0 and stdout equal to the name.
    const accepted = c.exit === 0 && c.stdout === `${name}\n`;
    const created = run(r, [...STEP, "branch", "--end-of-options", name, f.oids.main!]).exitCode === 0;
    out.push(obs(`F11.${kind}.${name}.d4-rule-vs-branch`, { d4Accepts: created }, { d4Accepts: accepted }));
  }
  return out;
}

// F12: the `fmt-merge-msg` preview equals Git's own merge message (plan.md D5, O-6).
function f12(git: string): Observation[] {
  const out: Observation[] = [];
  const cases: [string, string | null, boolean, string, string, string][] = [
    ["main", null, false, "branch 'topic'", "topic", "refs/heads/topic"],
    ["main.merge-log", null, true, "branch 'topic'", "topic", "refs/heads/topic"],
    ["other", "other", false, "branch 'topic'", "topic", "refs/heads/topic"],
    ["other.merge-log", "other", true, "branch 'topic'", "topic", "refs/heads/topic"],
    ["main.remote-tracking", null, false, "remote-tracking branch 'origin/topic'", "origin/topic", "refs/remotes/origin/topic"],
  ];
  for (const [label, branch, log, source, short, ref] of cases) {
    const setup = () => {
      const f = copy(git, "merge-diverged");
      const r = repoOf(f);
      if (branch !== null) wb(r, ["checkout", "-q", branch, "--"]);
      if (log) wb(r, ["config", "merge.log", "true"]);
      return { f, r };
    };
    const { f, r } = setup();
    const preview = stdout(wb(r, [...READ, "fmt-merge-msg"], { input: `${f.oids.topic}\t\t${source} of .\n` }));
    wb(r, ["merge", "--no-edit", short]);
    const own = message(r, "HEAD");
    const c = setup();
    wb(c.r, [...STEP, "merge", "--no-autostash", "--no-edit", "--end-of-options", ref]);
    // The contract argv with the preview as an edited message (research.md R7: `--no-log -m`).
    const m = setup();
    wb(m.r, [...STEP, "merge", "--no-autostash", "--no-edit", "--no-log", "-m", preview, "--end-of-options", ref]);
    out.push(obs(`F12.${label}.git-merge`, own, preview));
    out.push(obs(`F12.${label}.contract-argv`, message(c.r, "HEAD"), preview));
    out.push(obs(`F12.${label}.preview-as-message`, own, message(m.r, "HEAD")));
  }
  return out;
}

// F13: the moved count equals the commits that Git's own rebase creates (sequencer.c `sequencer_make_script`).
function f13(git: string): Observation[] {
  const s = shared(git, "rebase-mix");
  const sr = repoOf(s);
  const up = s.oids.up!;
  const walk = [`${up}...HEAD`, "--right-only", "--cherry-pick", "--no-merges"];
  const counted = count(sr, walk);
  const rewritten = count(sr, [`${up}..HEAD`]);
  const notTracked = count(sr, [`${up}..HEAD`, "--not", "refs/remotes/origin/topic"]);
  const r = repoOf(copy(git, "rebase-mix"));
  const exit = run(r, REBASE_UP).exitCode;
  const created = subjects(r, [`${up}..HEAD`]);
  return [
    exitObs("F13.exit", 0, exit),
    obs("F13.count", created.length, counted),
    obs("F13.subjects", created, subjects(sr, walk)),
    // plan.md D6: the force note shows when `notTracked` is below `rewritten`.
    obs("F13.force-note", "record", { notTracked, rewritten }, true),
  ];
}

// F14: a rebase with tracked changes and `--no-autostash` exits non-zero and changes nothing.
function f14(git: string): Observation[] {
  const f = copy(git, "rebase-mix");
  const r = repoOf(f);
  put(f.repo, "f.txt", "f changed\n");
  const before = state(r);
  return [exitObs("F14.exit", "nonzero", run(r, REBASE_UP).exitCode), obs("F14.changed", [], changed(before, state(r)))];
}

// F15: whether `rebase.autoSquash=true` squashes in a non-interactive rebase, and the explicit forms that plan.md D6 passes.
function f15(git: string): Observation[] {
  const squashed = ["feature", "other"];
  const kept = ["feature", "other", "fixup! feature"];
  const out: Observation[] = [];
  for (const [label, config, flags, expected] of [
    ["config-only", ["-c", "rebase.autoSquash=true"], [], null],
    ["autosquash", [], ["--autosquash"], squashed],
    ["no-autosquash", [], ["--no-autosquash"], kept],
    ["config-and-no-autosquash", ["-c", "rebase.autoSquash=true"], ["--no-autosquash"], kept],
  ] as [string, string[], string[], string[] | null][]) {
    const f = copy(git, "rebase-fixup");
    const r = repoOf(f);
    const exit = run(r, [...STEP, ...config, "rebase", "--no-autostash", ...flags, "--end-of-options", "refs/heads/up"]).exitCode;
    const observed = { exit, subjects: subjects(r, [`${f.oids.up}..HEAD`]) };
    // research.md R8 states no expectation for the configuration alone, so the observation records it.
    out.push(expected === null ? obs(`F15.${label}`, "record", observed, exit === 0) : obs(`F15.${label}`, { exit: 0, subjects: expected }, observed));
  }
  return out;
}

// F16: the moved-branch list of plan.md D6 equals the refs that `--update-refs` moves.
function f16(git: string): Observation[] {
  const s = shared(git, "rebase-update-refs");
  const listed = stdout(wb(repoOf(s), [...READ, "for-each-ref", "--merged=HEAD", `--no-merged=${s.oids.up}`, "--format=%(refname)", "refs/heads"])).split("\n").filter((l) => l !== "").sort();
  const r = repoOf(copy(git, "rebase-update-refs"));
  const before = refMap(r);
  const exit = run(r, REBASE_UP).exitCode;
  const after = refMap(r);
  const moved = Object.keys(before).filter((k) => k.startsWith("refs/heads/") && before[k] !== after[k]).sort();
  // The same list without the `branch` attributes of the other worktree records.
  const held = new Set(worktrees(s).filter((w) => w.path !== "repo" && w.branch !== undefined).map((w) => w.branch!));
  return [exitObs("F16.exit", 0, exit), obs("F16.moved", moved, listed), obs("F16.moved-without-other-worktrees", moved, listed.filter((ref) => !held.has(ref)))];
}

// F17: `worktree add -- <path> <branch>` checks out the branch, also when a tag of the same name exists.
function f17(git: string): Observation[] {
  const out: Observation[] = [];
  for (const tagged of [false, true]) {
    const f = copy(git, "branches");
    const r = repoOf(f);
    if (tagged) wb(r, ["tag", "merged", f.oids.main!]);
    const path = join(f.root, "wt-f17");
    const exit = run(r, [...STEP, "worktree", "add", "--", path, "merged"]).exitCode;
    const w = at(r, path);
    const sym = run(w, ["symbolic-ref", "-q", "HEAD"]);
    const observed = { exit, head: sym.exitCode === 0 ? stdout(sym).trim() : "detached", atBranch: stdout(wb(w, ["rev-parse", "HEAD"])).trim() === f.oids.second };
    out.push(obs(`F17.${tagged ? "tag-of-same-name" : "plain"}`, { exit: 0, head: "refs/heads/merged", atBranch: true }, observed));
  }
  return out;
}

// F18: `worktree remove` without `--force` runs the clean filter and the monitor of that worktree (canary).
function f18(git: string): Observation[] {
  const f = copy(git, "worktrees");
  const r = repoOf(f);
  const target = join(f.root, "wt with spaces");
  const filter = canary(f.root, "f18-clean", "cat\n");
  const monitor = canary(f.root, "f18-fsmonitor", "exit 1\n");
  put(f.repo, ".git/info/attributes", "* filter=f18\n");
  wb(r, ["config", "filter.f18.clean", filter.command]);
  wb(r, ["config", "core.fsmonitor", monitor.command]);
  // A new file time makes the status read compare the content through the clean filter.
  const later = new Date(Date.UTC(2026, 0, 2));
  utimesSync(join(target, "w.txt"), later, later);
  const exit = run(r, [...STEP, "worktree", "remove", "--", target]).exitCode;
  return [obs("F18.remove", { exit: 0, filterRan: true, monitorRan: true, removed: true }, { exit, filterRan: existsSync(filter.log), monitorRan: existsSync(monitor.log), removed: !existsSync(target) })];
}

// F19: `checkout --ours -- <path>` writes the index and runs `post-index-change` (canary). During a rebase, ours is the upstream.
function f19(git: string): Observation[] {
  const out: Observation[] = [];
  for (const fixture of ["conflict-merge", "conflict-rebase"] as WbFixtureName[]) {
    const f = copy(git, fixture);
    const r = repoOf(f);
    const indexLog = hookCanary(f, "post-index-change");
    const checkoutLog = hookCanary(f, "post-checkout");
    const before = rawIndexDigest(git, f.repo);
    const exit = run(r, [...STEP, "checkout", "--no-recurse-submodules", "--ours", "--", "uu.txt"]).exitCode;
    const observed = {
      exit,
      indexWritten: rawIndexDigest(git, f.repo) !== before,
      postIndexChange: logLines(indexLog).length > 0,
      postCheckoutFlag: logLines(checkoutLog).map((l) => l.split(" ").at(-1)),
      stages: stages(r, "uu.txt"),
      working: readFileSync(join(f.repo, "uu.txt"), "utf8"),
    };
    out.push(obs(`F19.${fixture}`, { exit: 0, indexWritten: true, postIndexChange: true, postCheckoutFlag: ["0"], stages: ["100644 1", "100644 2", "100644 3"], working: "uu ours\n" }, observed));
  }
  return out;
}

// F20: the `worktree list --porcelain -z` grammar (git-worktree(1) "Porcelain Format", research.md R13).
function f20(git: string): Observation[] {
  const f = shared(git, "worktrees");
  const raw = stdout(wb(repoOf(f), [...READ, "worktree", "list", "--porcelain", "-z"]));
  const records = recordLines(raw);
  const byPath = (rel: string) => records.find((lines) => lines[0] === `worktree ${join(f.root, rel).replaceAll("\\", "/")}`) ?? null;
  const attrs = (rel: string) => byPath(rel)?.slice(1).map((l) => l.split(" ")[0]) ?? null;
  const locked = byPath("wt-locked-reason")?.find((l) => l.startsWith("locked")) ?? null;
  const prunable = byPath("wt-prunable")?.find((l) => l.startsWith("prunable")) ?? null;
  return [
    obs("F20.record-end", true, raw.endsWith("\0\0")),
    obs("F20.main-first", `worktree ${f.repo.replaceAll("\\", "/")}`, records[0]?.[0] ?? null),
    obs("F20.spaces", ["HEAD", "branch"], attrs("wt with spaces")),
    obs("F20.locked-reason", "locked fixture reason\nwith newline", locked),
    obs("F20.locked-no-reason", ["HEAD", "branch", "locked"], byPath("wt-locked")?.slice(1).map((l) => (l.startsWith("locked") ? l : l.split(" ")[0])) ?? null),
    obs("F20.prunable", "prunable <reason>", prunable === null ? null : prunable.length > "prunable ".length && prunable.startsWith("prunable ") ? "prunable <reason>" : prunable),
  ];
}

// F21: `mergetool --no-prompt` with an untrusted exit code and empty standard input (plan.md D7, the `mergetool` policy).
function f21(git: string): Observation[] {
  const mergetool = (r: WbRepo, config: string[], tool: string) => run(r, [...STEP, "--literal-pathspecs", ...config, "mergetool", `--tool=${tool}`, "--no-prompt", "--", "uu.txt"], { input: "", timeoutMs: MERGETOOL_MS }).exitCode;
  const a = copy(git, "conflict-merge");
  const ra = repoOf(a);
  const fixtureExit = mergetool(ra, [], "fixture");
  const b = copy(git, "conflict-merge");
  const rb = repoOf(b);
  const working = readFileSync(join(b.repo, "uu.txt"));
  // `true` leaves $MERGED unchanged, so Git's script asks on its standard input (git-mergetool--lib `check_unchanged`).
  const keepExit = mergetool(rb, ["-c", "mergetool.keep.cmd=true"], "keep");
  return [
    obs("F21.fixture-tool", { exit: 0, stages: ["100644 0"], working: FIXTURE_MERGE_RESULT, backup: true }, { exit: fixtureExit, stages: stages(ra, "uu.txt"), working: readFileSync(join(a.repo, "uu.txt"), "utf8"), backup: existsSync(join(a.repo, "uu.txt.orig")) }),
    obs(
      "F21.unchanged-tool",
      { exit: "nonzero", stages: ["100644 1", "100644 2", "100644 3"], workingUnchanged: true },
      { exit: keepExit, stages: stages(rb, "uu.txt"), workingUnchanged: readFileSync(join(b.repo, "uu.txt")).equals(working) },
      keepExit > 0 && same(stages(rb, "uu.txt"), ["100644 1", "100644 2", "100644 3"]) && readFileSync(join(b.repo, "uu.txt")).equals(working),
    ),
  ];
}

// F22: `config set --local -- <key> -value` writes the value `-value`.
function f22(git: string): Observation[] {
  const f = copy(git, "config-scopes");
  const r = repoOf(f);
  const others = () => ["system", "global", "included"].map((label) => sha256(readFileSync(f.configs[label]!)));
  const before = others();
  const set = run(r, [...STEP, "config", "set", "--local", "--", "user.name", "-value"]).exitCode;
  const value = stdout(run(r, ["config", "get", "--local", "user.name"]));
  const unset = run(r, [...STEP, "config", "unset", "--local", "--", "user.name"]).exitCode;
  const after = run(r, ["config", "get", "--local", "user.name"]).exitCode;
  return [obs("F22.set", { exit: 0, value: "-value\n", otherFilesUnchanged: true }, { exit: set, value, otherFilesUnchanged: same(before, others()) }), obs("F22.unset", { exit: 0, getExitAfter: 1 }, { exit: unset, getExitAfter: after })];
}

// F23: the `info/exclude` path in a linked worktree is the file of the common Git folder (gitrepository-layout(5)).
function f23(git: string): Observation[] {
  const f = copy(git, "worktrees");
  const linked = at(repoOf(f), join(f.root, "wt with spaces"));
  const path = stdout(wb(linked, [...READ, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).trim();
  put(f.repo, ".git/info/exclude", "f23-excluded.txt\n");
  put(linked.dir, "f23-excluded.txt", "excluded\n");
  const ignored = run(linked, [...READ_IGNORE, "check-ignore", "-q", "--", "f23-excluded.txt"]).exitCode;
  return [obs("F23.path", "repo/.git/info/exclude", relative(f.root, path).replaceAll("\\", "/")), obs("F23.check-ignore-exit", 0, ignored)];
}

// F24: the merge tool names of the Git installation. The plan takes the names only from the `mergetools` folder (research.md R14).
function f24(git: string): Observation[] {
  const r = repoOf(shared(git, "branches"));
  const exec = stdout(wb(r, ["--exec-path"])).trim();
  const folder = join(exec, "mergetools");
  const names = existsSync(folder) ? readdirSync(folder).sort() : null;
  const help = run(r, ["mergetool", "--tool-help"]).exitCode;
  return [obs("F24.mergetools-folder", "record", names, names !== null && names.length > 0), exitObs("F24.tool-help-exit", 0, help)];
}

// F29: a branch named `@`. In a revision argument, `@` means HEAD (gitrevisions(7)). The contract argv of switch and worktree add passes the short name.
function f29(git: string): Observation[] {
  const f = copy(git, "branches");
  const r = repoOf(f);
  wb(r, ["update-ref", "refs/heads/@", f.oids.second!]);
  const before = state(r);
  const exit = run(r, [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "@", "--"]).exitCode;
  const checkout = { exit, head: headOf(r), changed: changed(before, state(r)) };
  const path = join(f.root, "wt-f29");
  const addExit = run(r, [...STEP, "worktree", "add", "--", path, "@"]).exitCode;
  const w = at(r, path);
  const add = { exit: addExit, head: headOf(w), atBranch: stdout(wb(w, ["rev-parse", "HEAD"])).trim() === f.oids.second };
  // Rename reads the old name as a branch name, not as a revision.
  const g = copy(git, "branches");
  const rr = repoOf(g);
  wb(rr, ["update-ref", "refs/heads/@", g.oids.second!]);
  const renameExit = run(rr, [...STEP, "branch", "-m", "--end-of-options", "@", "from-at"]).exitCode;
  const refs = refMap(rr);
  const rename = { exit: renameExit, at: refs["refs/heads/@"] ?? null, renamed: refs["refs/heads/from-at"] === g.oids.second, main: refs["refs/heads/main"] === g.oids.main };
  return [
    obs("F29.checkout-at", { exit: 0, head: "refs/heads/main", changed: [] }, checkout),
    obs("F29.worktree-add-at", { exit: 0, head: "refs/heads/@", atBranch: true }, add),
    obs("F29.rename-from-at", { exit: 0, at: null, renamed: true, main: true }, rename),
  ];
}

// F30: `--no-log -m` together with `--squash`. Git writes `SQUASH_MSG` and commits nothing (git-merge(1) `--squash`).
function f30(git: string): Observation[] {
  const given = "F30 explicit message";
  const squash = (withMessage: boolean) => {
    const f = copy(git, "merge-diverged");
    const r = repoOf(f);
    const head = stdout(wb(r, ["rev-parse", "HEAD"])).trim();
    const exit = run(r, [...STEP, "merge", "--no-autostash", "--no-edit", "--squash", ...(withMessage ? ["--no-log", "-m", given] : []), "--end-of-options", "refs/heads/topic"]).exitCode;
    const file = stdout(wb(r, ["rev-parse", "--path-format=absolute", "--git-path", "SQUASH_MSG"])).trim();
    const squashMsg = existsSync(file) ? readFileSync(file, "utf8") : null;
    return { r, exit, squashMsg, headMoved: stdout(wb(r, ["rev-parse", "HEAD"])).trim() !== head };
  };
  const m = squash(true);
  const plain = squash(false);
  // The 001 commit argv (`commit --quiet --file=-`) after the squash.
  wb(m.r, [...STEP, "commit", "--quiet", "--file=-"], { input: "F30 commit box text\n" });
  return [
    exitObs("F30.squash-m-exit", 0, m.exit),
    obs("F30.squash-msg-holds-m", "record", m.squashMsg?.includes(given) ?? null, m.squashMsg !== null),
    obs("F30.squash-msg-equals-without-m", plain.squashMsg, m.squashMsg),
    obs("F30.head-moved", false, m.headMoved),
    obs("F30.later-commit-message", "F30 commit box text\n", message(m.r, "HEAD")),
  ];
}

// F31: `hash-object --stdin-paths` against the index after `git add`. Git reads LF-ended lines and C-unquotes a line that starts with `"` (builtin/hash-object.c `hash_stdin_paths`).
function f31(git: string): Observation[] {
  const f = copy(git, "branches");
  const r = repoOf(f);
  const files: Record<string, string> = { ".gitattributes": "*.crlf eol=crlf\n", "x.crlf": "a\r\nb\r\n", "plain.txt": "plain\n", "with space.txt": "sp\n", " lead.txt": "lead\n" };
  for (const [rel, content] of Object.entries(files)) put(f.repo, rel, content);
  wb(r, [...STEP, "--literal-pathspecs", "add", "--", ...Object.keys(files)]);
  const paths = ["x.crlf", "plain.txt", "with space.txt", " lead.txt"];
  const ids: Record<string, string> = {};
  for (const rec of nulRecords(stdout(wb(r, [...READ, "ls-files", "-z", "--stage", "--", ...paths])))) ids[rec.slice(rec.indexOf("\t") + 1)] = rec.split(" ")[1]!;
  const indexIds = paths.map((p) => ids[p] ?? null);
  const before = rawIndexDigest(git, f.repo);
  const hash = (input: string) => {
    const res = run(r, [...READ, "hash-object", "--stdin-paths"], { input });
    return { exit: res.exitCode, ids: stdout(res).split("\n").filter((l) => l !== "") };
  };
  // Every byte as a C octal escape, so no byte of the name ends or changes the line.
  const quote = (p: string) => `"${[...Buffer.from(p, "utf8")].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("")}"`;
  return [
    obs("F31.raw-lines", { exit: 0, ids: indexIds }, hash(paths.map((p) => `${p}\n`).join(""))),
    obs("F31.quoted-lines", { exit: 0, ids: indexIds }, hash(paths.map((p) => `${quote(p)}\n`).join(""))),
    obs("F31.cr-before-lf-stripped", { exit: 0, ids: [indexIds[1]] }, hash("plain.txt\r\n")),
    exitObs("F31.bad-quote", "nonzero", hash('"plain.txt\n').exit),
    obs("F31.index-unchanged", before, rawIndexDigest(git, f.repo)),
  ];
}

const FACTS: [string, string, (git: string) => Observation[]][] = [
  ["F1", "every contract argv is accepted", f1],
  ["F2", "a refused checkout -b creates no branch", f2],
  ["F3", "Keep changes with a conflicting change changes nothing", f3],
  ["F4", "the stash protocol observations", f4],
  ["F5", "a refused stash apply --index changes no file", f5],
  ["F6", "Discard through a stash equals checkout --force", f6],
  ["F7", "the in-the-way check finds each Git refusal", f7],
  ["F8", "the track checkout writes Git's branch keys", f8],
  ["F9", "update-ref -d and remove-section equal branch -D", f9],
  ["F10", "the unmerged count equals the lost commits", f10],
  ["F11", "check-ref-format --branch exit and output", f11],
  ["F12", "the fmt-merge-msg preview equals Git's merge message", f12],
  ["F13", "the moved count equals the created commits", f13],
  ["F14", "rebase --no-autostash with tracked changes changes nothing", f14],
  ["F15", "rebase.autoSquash in a non-interactive rebase", f15],
  ["F16", "the moved-branch list equals the update-refs moves", f16],
  ["F17", "worktree add checks out the branch", f17],
  ["F18", "worktree remove runs the filters and the monitor", f18],
  ["F19", "checkout --ours writes the index and runs post-index-change", f19],
  ["F20", "the worktree list -z grammar", f20],
  ["F21", "mergetool --no-prompt with empty standard input", f21],
  ["F22", "config set -- with a value that starts with a dash", f22],
  ["F23", "the info/exclude path in a linked worktree", f23],
  ["F24", "the merge tool names", f24],
  ["F29", "switch and worktree add with a branch named @", f29],
  ["F30", "merge --squash with --no-log -m", f30],
  ["F31", "hash-object --stdin-paths equals the index after git add", f31],
];

describeGit("Git facts F1 to F24, F29 to F31 (T003)", (git) => factTests(TASK, git, FACTS, FACT_MS));
