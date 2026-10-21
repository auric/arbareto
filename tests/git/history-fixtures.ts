// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// History fixtures of feature 002 (plan.md P0.1). Git runs with `fixtureEnv`, so a caller must hold an owned root through `useFixtureRoot`.

import { test } from "bun:test";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { REF_LISTING_RECORDS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { acquireLock, builderDigest, hasCommitGraph, PERF_CACHE_ROOT, semanticDigest } from "../windows/perf-fixtures";
import { FIXED_TIMESTAMPS, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, ownedPath, removeTree, type OwnedGitOptions } from "./fixture-root";
import { fiCommit } from "./fixtures";
import { fixtureGitPath, GIT } from "./git-binary";
import { sha256, workingFileDigests } from "./git-oracle";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);

// Every third small-fixture commit and every 50th large-fixture commit has this word in its message.
export const MARKER_WORD = "marker";
// The long-body fixture has this word after the 16 KiB body bound (FR-019).
export const LONG_BODY_WORD = "afterbound";
// A comma list of the large fixtures that a run may build, such as `H200K,H1M`.
export const LARGE_FIXTURES_ENV = "ARBARETO_HISTORY_FIXTURES";

const SEED = 42;
const EPOCH = Date.UTC(2024, 0, 1) / 1000;
// The identity that `fiCommit` writes.
const IDENT = "Arbareto Fixture <fixture@arbareto.invalid>";
const MAIN = "refs/heads/main";

// mulberry32, as in `tests/windows/perf-fixtures.ts`. A change there would change the perf builder digest.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// SC-013: a SHA-256 over the bytes of every file in the worktree and in its `.git` folder.
export function repositoryDigest(repo: string): string {
  return sha256(Buffer.from(JSON.stringify({ worktree: workingFileDigests(repo), git: workingFileDigests(join(repo, ".git")) })));
}

// The `openHistory` start points of scope `all` (contract Δ3): the commits of the FR-047 refs and HEAD, unique, in ascending hex.
export function startPoints(git: string, root: string, repo: string): string[] {
  const g = (args: string[], options?: OwnedGitOptions) => ownedGit(git, root, repo, ["--no-optional-locks", ...args], options).toString("utf8");
  const listed = g(["for-each-ref", "--format=%(objectname)%00%(refname)", "refs/heads", "refs/remotes", "refs/tags", "refs/stash"]).split("\n").filter((l) => l !== "");
  // A pattern matches up to a slash (git-for-each-ref(1)), so `refs/stash` also lists `refs/stash/<name>`.
  const oids = listed.map((l) => l.split("\0") as [string, string]).filter(([, name]) => !name.startsWith("refs/stash/")).map(([oid]) => oid);
  // `<rev>^{}` peels tags until a non-tag object (gitrevisions(7)).
  const peeled = g(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: Buffer.from(oids.map((oid) => `${oid}^{}\n`).join("")) }).split("\n").filter((l) => l !== "");
  const commits = peeled.map((l) => l.split(" ")).filter(([, type]) => type === "commit").map(([oid]) => oid!);
  // `rev-parse --verify -q` exits 1 for an unborn HEAD.
  const head = g(["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] }).trim();
  return [...new Set(head === "" ? commits : [...commits, head])].sort();
}

// technical/shallow.adoc: `$GIT_DIR/shallow` lists one commit per line. Git treats each as a root.
export function shallowCommits(git: string, root: string, repo: string): Set<string> {
  const path = ownedGit(git, root, repo, ["rev-parse", "--path-format=absolute", "--git-path", "shallow"]).toString().trim();
  return new Set(existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : []);
}

// ---- Small fixtures ----

export const SMALL_NAMES = [
  "equal-dates",
  "clock-skew",
  "criss-cross",
  "octopus-10",
  "octopus-65",
  "merges-only",
  "tips-50",
  "shallow",
  "tag-chains",
  "tag-tree-blob",
  "stash",
  "notes",
  "pull-ref",
  "unborn-beside",
  "empty",
  "detached",
  "remote-head",
  "long-body",
  "refs-10001",
] as const;
export type SmallName = (typeof SMALL_NAMES)[number];

export interface SmallFixture {
  name: SmallName;
  repo: string;
  commitGraph: boolean;
  // The fast-import mark of each commit, and the message of each commit OID.
  oids: Map<number, string>;
  messages: Map<string, Buffer>;
  // What Git must show: the sorted `rev-list --parents --all` lines, the sorted ref names, and HEAD.
  expect: { revList: string[]; refs: string[]; headTarget: string | null; headOid: string | null };
}

interface Commit {
  mark: number;
  ref: string;
  parents: number[];
  time: number;
  message: string;
  files?: Record<string, string>;
  // The mark of the commit that this notes commit annotates.
  note?: number;
}

interface Design {
  commits: Commit[];
  refFormat?: "reftable";
  // Refs that one `update-ref --stdin` transaction creates after the import: a ref and a mark.
  stdinRefs?: [string, number][];
  // Git commands after the import. A leading `:<mark>` in an argument becomes the OID of that mark.
  post?: string[][];
  refs: string[];
  // Marks that only a reflog reaches.
  hidden?: number[];
  // The default is `refs/heads/main` at its last commit.
  head?: { target: string | null; mark: number | null };
}

const text = (mark: number) => `c${mark}${mark % 3 === 0 ? ` ${MARKER_WORD}` : ""}\n`;
const at = (mark: number, ref: string, parents: number[], time = EPOCH + mark * 60, extra: Partial<Commit> = {}): Commit => ({ mark, ref, parents, time, message: text(mark), ...extra });
const chain = (count: number): Commit[] => Array.from({ length: count }, (_, i) => at(i + 1, MAIN, i === 0 ? [] : [i]));
const pad = (n: number, width: number) => String(n).padStart(width, "0");

// Four lines from one root, all commits at one time. Each line merges its neighbor every 10 rounds.
function equalDates(): Design {
  const refs = [MAIN, "refs/heads/line-1", "refs/heads/line-2", "refs/heads/line-3"];
  const commits = [at(1, MAIN, [], EPOCH)];
  const tips = [1, 1, 1, 1];
  for (let round = 0; round < 150; round++) {
    for (let j = 0; j < 4; j++) {
      const mark = commits.length + 1;
      commits.push(at(mark, refs[j]!, round % 10 === 9 ? [tips[j]!, tips[(j + 1) % 4]!] : [tips[j]!], EPOCH));
      tips[j] = mark;
    }
  }
  return { commits, refs };
}

// Two lines. Every 7th commit is 3 days older than its parents.
function clockSkew(): Design {
  const refs = [MAIN, "refs/heads/b"];
  const time = (mark: number) => EPOCH + mark * 60 - (mark % 7 === 0 ? 3 * 86_400 : 0);
  const commits = [at(1, MAIN, [], time(1))];
  const tips = [1, 1];
  for (let round = 0; round < 40; round++) {
    for (let j = 0; j < 2; j++) {
      const mark = commits.length + 1;
      commits.push(at(mark, refs[j]!, j === 0 && round % 8 === 7 ? [tips[0]!, tips[1]!] : [tips[j]!], time(mark)));
      tips[j] = mark;
    }
  }
  return { commits, refs };
}

function crissCross(): Design {
  const b = "refs/heads/b";
  return { commits: [at(1, MAIN, []), at(2, MAIN, [1]), at(3, b, [1]), at(4, MAIN, [2, 3]), at(5, b, [3, 2]), at(6, MAIN, [4]), at(7, b, [5]), at(8, MAIN, [6, 7]), at(9, b, [7, 6]), at(10, MAIN, [8])], refs: [MAIN, b] };
}

// `n` branches of `depth` commits meet in one merge with `n` parents.
function octopus(n: number, depth: number): Design {
  const branch = (j: number) => `refs/heads/o-${pad(j, 2)}`;
  const commits = [at(1, MAIN, [])];
  for (let level = 0; level < depth; level++) for (let j = 0; j < n; j++) commits.push(at(commits.length + 1, branch(j), [level === 0 ? 1 : commits.length + 1 - n]));
  const merge = commits.length + 1;
  commits.push(at(merge, MAIN, Array.from({ length: n }, (_, j) => merge - n + j)), at(merge + 1, MAIN, [merge]));
  return { commits, refs: [MAIN, ...Array.from({ length: n }, (_, j) => branch(j))] };
}

// Two roots, then 150 rounds in which each line merges the other. Every commit except the roots is a merge.
function mergesOnly(): Design {
  const b = "refs/heads/b";
  const commits = [at(1, MAIN, []), at(2, b, [])];
  for (let k = 1; k <= 150; k++) commits.push(at(2 * k + 1, MAIN, [2 * k - 1, 2 * k]), at(2 * k + 2, b, [2 * k, 2 * k - 1]));
  return { commits, refs: [MAIN, b] };
}

// 50 branches of 3 commits. Each level is newer than the level below it, so all 50 tips stream first.
function tips50(): Design {
  const ref = (j: number) => (j === 0 ? MAIN : `refs/heads/t-${pad(j, 2)}`);
  const commits = [at(1, MAIN, [], EPOCH)];
  for (let level = 1; level <= 3; level++) {
    for (let j = 0; j < 50; j++) {
      const mark = commits.length + 1;
      commits.push(at(mark, ref(j), [level === 1 ? 1 : mark - 50], EPOCH + level * 1000 + j));
    }
  }
  return { commits, refs: Array.from({ length: 50 }, (_, j) => ref(j)) };
}

function tagChains(): Design {
  return {
    commits: chain(4),
    post: [
      ["tag", "-a", "-m", "v1", "v1", ":2"],
      ["tag", "-a", "-m", "v1-outer", "v1-outer", "v1"],
      ["tag", "-a", "-m", "v1-outer-outer", "v1-outer-outer", "v1-outer"],
      ["tag", "lw", ":3"],
      ["tag", "-a", "-m", "v4", "v4", ":4"],
      ["tag", "also-4", ":4"],
    ],
    refs: [MAIN, "refs/tags/also-4", "refs/tags/lw", "refs/tags/v1", "refs/tags/v1-outer", "refs/tags/v1-outer-outer", "refs/tags/v4"],
  };
}

function tagTreeBlob(): Design {
  return {
    commits: [at(1, MAIN, [], undefined, { files: { "a.txt": "a\n" } }), at(2, MAIN, [1], undefined, { files: { "b.txt": "b\n" } })],
    post: [
      ["tag", "-a", "-m", "tree", "t-tree", ":2^{tree}"],
      ["tag", "-a", "-m", "blob", "t-blob", ":2:a.txt"],
      ["update-ref", "refs/tags/lw-tree", ":2^{tree}"],
      ["update-ref", "refs/tags/lw-blob", ":2:a.txt"],
    ],
    refs: [MAIN, "refs/tags/lw-blob", "refs/tags/lw-tree", "refs/tags/t-blob", "refs/tags/t-tree"],
  };
}

// Each stash entry is a working-tree commit with the parents HEAD and an index commit (git-stash(1) "DISCUSSION").
// fast-import writes the entries on temporary refs. `update-ref` then writes `refs/stash` with two reflog entries.
function stash(): Design {
  const temp = ["i1", "w1", "i2", "w2"].map((n) => `refs/arbareto/${n}`);
  const f = (content: string) => ({ "f.txt": content });
  return {
    commits: [
      at(1, MAIN, [], undefined, { files: f("1\n") }),
      at(2, MAIN, [1], undefined, { files: f("2\n") }),
      at(3, MAIN, [2], undefined, { files: f("3\n") }),
      at(4, temp[0]!, [3], undefined, { message: "index on main: c3\n", files: f("staged one\n") }),
      at(5, temp[1]!, [3, 4], undefined, { message: "On main: one\n", files: f("work one\n") }),
      at(6, temp[2]!, [3], undefined, { message: "index on main: c3\n", files: f("staged two\n") }),
      at(7, temp[3]!, [3, 6], undefined, { message: "On main: two\n", files: f("work two\n") }),
    ],
    post: [["update-ref", "--create-reflog", "-m", "On main: one", "refs/stash", ":5"], ["update-ref", "-m", "On main: two", "refs/stash", ":7"], ...temp.map((ref) => ["update-ref", "-d", ref])],
    refs: [MAIN, "refs/stash"],
    hidden: [4, 5],
  };
}

function notes(): Design {
  return { commits: [...chain(3), at(4, "refs/notes/commits", [], undefined, { message: "Notes added by the fixture\n", note: 2 })], refs: [MAIN, "refs/notes/commits"] };
}

function pullRef(): Design {
  return { commits: [...chain(3), at(4, "refs/pull/1/head", [2])], refs: [MAIN, "refs/pull/1/head"] };
}

function unbornBeside(): Design {
  return { commits: [...chain(3), at(4, "refs/heads/other", [2])], post: [["symbolic-ref", "HEAD", "refs/heads/unborn"]], refs: [MAIN, "refs/heads/other"], head: { target: "refs/heads/unborn", mark: null } };
}

function detached(): Design {
  return { commits: chain(3), post: [["update-ref", "--no-deref", "HEAD", ":2"]], refs: [MAIN], head: { target: null, mark: 2 } };
}

function remoteHead(): Design {
  return { commits: [...chain(3), at(4, "refs/remotes/origin/main", [3])], post: [["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]], refs: [MAIN, "refs/remotes/origin/HEAD", "refs/remotes/origin/main"] };
}

// The word follows 17 KiB of body text.
function longBody(): Design {
  const body = `${"x".repeat(1023)}\n`.repeat(17);
  return { commits: [at(1, MAIN, []), at(2, MAIN, [1], undefined, { message: `long body\n\n${body}${LONG_BODY_WORD}\n` }), at(3, MAIN, [2])], refs: [MAIN] };
}

const DESIGNS: Record<Exclude<SmallName, "shallow" | "refs-10001">, () => Design> = {
  "equal-dates": equalDates,
  "clock-skew": clockSkew,
  "criss-cross": crissCross,
  "octopus-10": () => octopus(10, 2),
  "octopus-65": () => octopus(65, 1),
  "merges-only": mergesOnly,
  "tips-50": tips50,
  "tag-chains": tagChains,
  "tag-tree-blob": tagTreeBlob,
  stash,
  notes,
  "pull-ref": pullRef,
  "unborn-beside": unbornBeside,
  empty: () => ({ commits: [], refs: [], head: { target: MAIN, mark: null } }),
  detached,
  "remote-head": remoteHead,
  "long-body": longBody,
};

function render(c: Commit): Buffer {
  const commit = fiCommit({ mark: c.mark, ref: c.ref, time: c.time, message: c.message, from: c.parents[0], merge: c.parents.slice(1), files: c.files });
  if (c.note === undefined) return commit;
  // fast-import "notemodify" comes before the blank line that ends the commit.
  const note = Buffer.from(`note on c${c.note}\n`);
  return Buffer.concat([commit.subarray(0, commit.length - 1), Buffer.from(`N inline :${c.note}\ndata ${note.length}\n`), note, Buffer.from("\n\n")]);
}

function buildDesign<N extends SmallName>(git: string, folder: string, dir: string, name: N, design: Design): SmallFixture & { name: N } {
  const repo = join(folder, dir);
  const g = (args: string[], options?: OwnedGitOptions) => ownedGit(git, FIXTURE_ROOT, repo, args, options);
  mkdirSync(ownedPath(FIXTURE_ROOT, relative(FIXTURE_ROOT, repo)), { recursive: true });
  g(["init", "-q", "-b", "main", ...(design.refFormat === undefined ? [] : [`--ref-format=${design.refFormat}`])]);
  const oids = new Map<number, string>();
  if (design.commits.length > 0) {
    const marks = join(folder, `${dir}.marks`);
    g(["fast-import", "--quiet", `--export-marks=${marks}`], { input: Buffer.concat(design.commits.map(render)) });
    for (const line of readFileSync(marks, "utf8").trim().split("\n")) {
      const [mark, oid] = line.split(" ");
      oids.set(Number(mark!.slice(1)), oid!);
    }
    rmSync(marks);
  }
  const oid = (mark: number) => {
    const found = oids.get(mark);
    if (found === undefined) throw new Error(`${name}: no commit for mark :${mark}`);
    return found;
  };
  if (design.stdinRefs !== undefined) g(["update-ref", "--stdin"], { input: Buffer.from(design.stdinRefs.map(([ref, mark]) => `create ${ref} ${oid(mark)}\n`).join("")) });
  for (const args of design.post ?? []) g(args.map((arg) => arg.replace(/^:(\d+)/, (_, mark: string) => oid(Number(mark)))));
  // `rev-parse --verify -q` exits 1 for an unborn HEAD.
  if (g(["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] }).length > 0) g(["reset", "-q", "--hard"]);

  const hidden = new Set(design.hidden ?? []);
  const head = design.head ?? { target: MAIN, mark: design.commits.findLast((c) => c.ref === MAIN)?.mark ?? null };
  return {
    name,
    repo,
    commitGraph: false,
    oids,
    messages: new Map(design.commits.map((c) => [oid(c.mark), Buffer.from(c.message)])),
    expect: {
      revList: design.commits.filter((c) => !hidden.has(c.mark)).map((c) => [c.mark, ...c.parents].map(oid).join(" ")).sort(),
      refs: [...design.refs].sort(),
      headTarget: head.target,
      headOid: head.mark === null ? null : oid(head.mark),
    },
  };
}

// A clone of `source` through the file transport. The clone adds `refs/remotes/origin/HEAD` and a remote-tracking ref for each branch.
function cloneOf(git: string, folder: string, source: SmallFixture, args: string[], revList: string[]): SmallFixture {
  ownedGit(git, FIXTURE_ROOT, folder, ["clone", "-q", ...args, pathToFileURL(source.repo).href, source.name]);
  const remote = source.expect.refs.filter((ref) => ref.startsWith("refs/heads/")).map((ref) => `refs/remotes/origin/${ref.slice("refs/heads/".length)}`);
  return { ...source, repo: join(folder, source.name), expect: { revList: revList.sort(), refs: [MAIN, "refs/remotes/origin/HEAD", ...remote].sort(), headTarget: MAIN, headOid: source.expect.headOid } };
}

// git-clone(1): `--depth` keeps the given number of commits. The source is one line of 6 commits, so commit 4 is the shallow boundary.
function buildShallow(git: string, folder: string): SmallFixture {
  const source = buildDesign(git, folder, "shallow-source", "shallow", { commits: chain(6), refs: [MAIN] });
  const o = (mark: number) => source.oids.get(mark)!;
  return cloneOf(git, folder, source, ["--depth=3"], [`${o(6)} ${o(5)}`, `${o(5)} ${o(4)}`, o(4)]);
}

// One ref above the REF_LISTING_RECORDS bound of contract Δ5. The clone adds 3 refs to the branches of the source.
// A files-backend ref write takes about 4 ms on the reference host. A reftable source takes all refs in one transaction, and the clone writes them into one packed-refs file.
function buildManyRefs(git: string, folder: string): SmallFixture {
  const branches = Array.from({ length: REF_LISTING_RECORDS - 2 }, (_, i): [string, number] => [`refs/heads/b-${pad(i + 1, 5)}`, 1]);
  const source = buildDesign(git, folder, "refs-10001-source", "refs-10001", { commits: chain(2), refFormat: "reftable", stdinRefs: branches, refs: [MAIN, ...branches.map(([ref]) => ref)] });
  return cloneOf(git, folder, source, ["--no-local"], source.expect.revList);
}

// Builds the named fixtures, without a commit-graph, in `<fixture root>/<folder>/<name>`.
export function buildSmallFixtures(git: string, folder: string, names: readonly SmallName[] = SMALL_NAMES): SmallFixture[] {
  const dir = fixtureDir(folder);
  return names.map((name) => (name === "shallow" ? buildShallow(git, dir) : name === "refs-10001" ? buildManyRefs(git, dir) : buildDesign(git, dir, name, name, DESIGNS[name]())));
}

// A copy of `fixture` with a commit-graph file. The builder is the only writer of commit-graph files (tasks.md "Test harness rules").
export function withCommitGraph(git: string, fixture: SmallFixture): SmallFixture {
  const repo = `${fixture.repo}-commit-graph`;
  cpSync(fixture.repo, ownedPath(FIXTURE_ROOT, relative(FIXTURE_ROOT, repo)), { recursive: true });
  ownedGit(git, FIXTURE_ROOT, repo, ["commit-graph", "write", "--reachable"]);
  return { ...fixture, repo, commitGraph: true };
}

// ---- Large fixtures ----

export interface LargeSpec {
  name: string;
  commits: number;
  // False: the cases run only when `ARBARETO_HISTORY_FIXTURES` names the fixture, also when the cache holds it.
  cachedByDefault: boolean;
}

export const H200K: LargeSpec = { name: "H200K", commits: 200_000, cachedByDefault: true };
export const H1M: LargeSpec = { name: "H1M", commits: 1_000_000, cachedByDefault: false };

export interface LargeFacts {
  commits: number;
  refs: number;
  tip: string;
  commitGraph: boolean;
  semanticDigest: string;
}

export interface LargeManifest {
  seed: number;
  builderDigest: string;
  spec: LargeSpec;
  facts: LargeFacts;
}

export interface CachedLargeFixture {
  folder: string;
  repo: string;
  manifest: LargeManifest;
  reused: boolean;
}

const LARGE_LINES = 8;
// The FR-023 and FR-024 cases by `k % 1000`. Case 808 is "Виправлення" in windows-1251.
const LARGE_TEXTS: Record<number, string> = { 101: "Виправлення помилки", 202: "ВИПРАВЛЕННЯ", 303: "Єдине і їжак ґанок", 404: "єДИНЕ І ЇЖАК ҐАНОК", 505: "Straße", 606: "STRAẞE", 707: "STRASSE" };
const LEGACY_CASE = 808;

// The WHATWG Encoding index of windows-1251, read through `TextDecoder` and inverted.
const decoder = new TextDecoder("windows-1251");
const CP1251 = new Map(Array.from({ length: 256 }, (_, b) => [decoder.decode(Uint8Array.of(b)), b] as const));
function windows1251(value: string): Uint8Array {
  return Uint8Array.from([...value], (ch) => {
    const b = CP1251.get(ch);
    if (b === undefined) throw new Error(`windows-1251 has no byte for ${JSON.stringify(ch)}`);
    return b;
  });
}

function largeMessage(k: number): { message: string | Uint8Array; encoding?: string } {
  const marker = k % 50 === 0 ? ` ${MARKER_WORD}` : "";
  if (k % 1000 === LEGACY_CASE) return { message: windows1251(`Виправлення ${k}${marker}\n`), encoding: "windows-1251" };
  return { message: `${LARGE_TEXTS[k % 1000] ?? "commit"} ${k}${marker}\n` };
}

// Eight lines that fork from each other and merge in 1 of 24 commits. Runs of 512 commits share one date. 1 of 256 commits is one day older than its first parent.
function writeLargeStream(path: string, spec: LargeSpec): void {
  const r = rng(SEED);
  const tips = new Uint32Array(LARGE_LINES);
  const times = new Uint32Array(spec.commits + 1);
  const started = [0];
  const fd = openSync(path, "w");
  let batch: Buffer[] = [];
  const flush = () => {
    writeSync(fd, Buffer.concat(batch));
    batch = [];
  };
  try {
    for (let k = 0; k < spec.commits; k++) {
      const mark = k + 1;
      const line = k === 0 ? 0 : Math.floor(r() * LARGE_LINES);
      let from: number | undefined;
      if (k > 0 && tips[line] === 0) {
        from = tips[started[Math.floor(r() * started.length)]!]!;
        started.push(line);
      } else if (k > 0) from = tips[line]!;
      const other = k > 0 && r() < 1 / 24 ? tips[Math.floor(r() * LARGE_LINES)]! : 0;
      let time = Math.floor(k / 512) % 8 === 5 ? EPOCH + Math.floor(k / 512) * 512 : EPOCH + k;
      if (from !== undefined && r() < 1 / 256) time = times[from]! - 86_400;
      times[mark] = time;
      tips[line] = mark;
      const files = k === 0 ? { "README.md": "Arbareto history fixture\n" } : undefined;
      batch.push(fiCommit({ mark, ref: `refs/heads/line-${line}`, time, ...largeMessage(k), from, merge: other !== 0 && other !== from ? [other] : [], files }));
      if (batch.length === 4096) flush();
    }
    for (let k = 20_000; k < spec.commits; k += 20_000) batch.push(Buffer.from(`reset refs/tags/v${k}\nfrom :${k + 1}\n\n`));
    for (let k = 50_000; k < spec.commits; k += 50_000) {
      const note = Buffer.from(`release ${k}\n`);
      batch.push(Buffer.from(`tag a${k}\nfrom :${k + 1}\ntagger ${IDENT} ${times[k + 1]} +0000\ndata ${note.length}\n`), note, Buffer.from("\n"));
    }
    batch.push(Buffer.from(`reset ${MAIN}\nfrom :${tips[0]}\n\n`));
    flush();
  } finally {
    closeSync(fd);
  }
}

// Builds `spec` into `repo` under `root`. The stream file goes to Git as stdin, so it never sits in memory whole.
export function buildLargeRepo(git: string, root: string, repo: string, spec: LargeSpec, streamPath: string, commitGraph: boolean): LargeFacts {
  const g = (args: string[]) => ownedGit(git, root, repo, args).toString();
  const cwd = ownedPath(root, relative(root, repo));
  mkdirSync(cwd, { recursive: true });
  g(["init", "-q", "-b", "main"]);
  writeLargeStream(streamPath, spec);
  const proc = Bun.spawnSync([fixtureGitPath(git), "fast-import", "--quiet"], { cwd, env: fixtureEnv(FIXED_TIMESTAMPS), stdin: Bun.file(streamPath), stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git fast-import exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  rmSync(streamPath);
  g(["reset", "-q", "--hard"]);
  if (commitGraph) g(["commit-graph", "write", "--reachable"]);
  if (hasCommitGraph(git, repo) !== commitGraph) throw new Error(`commit-graph presence is not ${commitGraph} in ${repo}`);
  return {
    commits: Number(g(["rev-list", "--count", "--all"]).trim()),
    refs: g(["for-each-ref", "--format=%(refname)"]).trim().split("\n").length,
    tip: g(["rev-parse", "HEAD"]).trim(),
    commitGraph,
    semanticDigest: semanticDigest(git, repo),
  };
}

const variantName = (spec: LargeSpec, commitGraph: boolean) => `${spec.name}-seed${SEED}-${commitGraph ? "commit-graph" : "no-commit-graph"}`;
const currentDigest = () => builderDigest(readFileSync(import.meta.path));

function readManifest(spec: LargeSpec, commitGraph: boolean): { folder: string; repo: string; manifest: LargeManifest } | null {
  const folder = join(PERF_CACHE_ROOT, variantName(spec, commitGraph));
  const path = join(folder, "manifest.json");
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as LargeManifest;
  const same = manifest.seed === SEED && manifest.builderDigest === currentDigest() && JSON.stringify(manifest.spec) === JSON.stringify(spec) && manifest.facts.commitGraph === commitGraph;
  return same ? { folder, repo: join(folder, "repo"), manifest } : null;
}

// The cached build, when its manifest and its semantic digest match.
function reusable(git: string, spec: LargeSpec, commitGraph: boolean): CachedLargeFixture | null {
  const found = readManifest(spec, commitGraph);
  if (found === null || !existsSync(found.repo) || semanticDigest(git, found.repo) !== found.manifest.facts.semanticDigest) return null;
  return { ...found, reused: true };
}

// Builds `spec` once per seed, builder digest, and variant under the cache root. The lock and the temporary folder follow `ensurePerfFixture`.
export function ensureLargeFixture(git: string, spec: LargeSpec, commitGraph: boolean): CachedLargeFixture {
  mkdirSync(PERF_CACHE_ROOT, { recursive: true });
  const name = variantName(spec, commitGraph);
  const folder = ownedPath(PERF_CACHE_ROOT, name);
  const lock = ownedPath(PERF_CACHE_ROOT, `${name}.lock`);
  const temp = ownedPath(PERF_CACHE_ROOT, `${name}.tmp`);
  acquireLock(lock);
  try {
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, start: new Date().toISOString() }));
    const cached = reusable(git, spec, commitGraph);
    if (cached !== null) return cached;
    if (existsSync(temp)) removeTree(temp);
    mkdirSync(temp);
    const facts = buildLargeRepo(git, PERF_CACHE_ROOT, join(temp, "repo"), spec, join(temp, `${spec.name}.fast-import`), commitGraph);
    const manifest: LargeManifest = { seed: SEED, builderDigest: currentDigest(), spec, facts };
    writeFileSync(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(folder)) removeTree(folder);
    renameSync(temp, folder);
    return { folder, repo: join(folder, "repo"), manifest, reused: false };
  } finally {
    removeTree(lock);
  }
}

const requested = (spec: LargeSpec) => (process.env[LARGE_FIXTURES_ENV] ?? "").split(",").map((n) => n.trim()).includes(spec.name);

// A requested fixture builds when the cache does not hold it. Otherwise only a matching cached build counts.
export function largeFixture(git: string, spec: LargeSpec, commitGraph: boolean): CachedLargeFixture {
  if (requested(spec)) return ensureLargeFixture(git, spec, commitGraph);
  const cached = reusable(git, spec, commitGraph);
  if (cached === null) throw new Error(`the cached ${variantName(spec, commitGraph)} fixture does not match its manifest; set ${LARGE_FIXTURES_ENV}=${spec.name} to rebuild it`);
  return cached;
}

// tasks.md "Test harness rules": a case without its fixture skips and names the missing capability. A skip never counts as a pass.
export function largeCase(task: string, name: string, spec: LargeSpec, body: () => unknown, timeoutMs: number): void {
  const ready = requested(spec) || (spec.cachedByDefault && readManifest(spec, false) !== null && readManifest(spec, true) !== null);
  if (GIT !== null && ready) return void test(name, async () => void (await body()), timeoutMs);
  const capability = `history-fixture-${spec.name.toLowerCase()}`;
  const why = spec.cachedByDefault ? "the cache does not hold it" : "it runs only on request";
  console.log(`SKIP ${task} ${name}: missing capability ${capability} (unverified)`);
  console.log(`OBSERVATION ${task}: "${name}" did not run: ${why}. ${LARGE_FIXTURES_ENV}=${spec.name} builds and runs it.`);
  test.skip(name, () => {}, timeoutMs);
}
