// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T144 (feature 004 plan D20 "Packaged fixtures"): the real repositories of the Submodules group tree and its branch marks. Spec SC-018, SC-019, quickstart Q30.
// Every remote is a local path. Each Git command gets the fixture identity through `-c`, and `ownedGit` points the global file to the fixture root.
// The caller holds FIXTURE_ROOT through `useFixtureRoot`.

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubmoduleBranch, SubmodulePlanRow } from "../../src/contracts/submodules";
import { FIXED_IDENTITY, FIXTURE_ROOT, ownedGit } from "../git/fixture-root";
import { gitExit } from "../git/history-diff-fixtures";
import type { IpcLog } from "./cdp";

// Git transport rules (git-config(1) `protocol.allow`): Git 2.38.1 and later refuse the file transport for a submodule clone without this value.
const CONFIG = ["-c", `user.name=${FIXED_IDENTITY.name}`, "-c", `user.email=${FIXED_IDENTITY.email}`, "-c", "core.autocrlf=false", "-c", "protocol.file.allow=always"];

const gitIn = (exe: string) => (cwd: string, args: string[], input?: Uint8Array) => ownedGit(exe, FIXTURE_ROOT, cwd, [...CONFIG, ...args], { input }).toString("utf8").trim();
const slashed = (path: string) => path.replaceAll("\\", "/");
// git-config(1) "Syntax": a quoted value escapes `\` and `"`.
const quoted = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const gitmodules = (entries: readonly [path: string, url: string][]) => entries.map(([path, url]) => `[submodule ${quoted(path)}]\n\tpath = ${quoted(path)}\n\turl = ${quoted(url)}\n`).join("");
const gitlinks = (oid: string, paths: readonly string[]) => Buffer.from(paths.map((p) => `160000 ${oid}\t${p}\n`).join(""));

export interface Lib {
  // The bare remote of every leaf submodule.
  url: string;
  // `main` and the tag `v1`.
  main: string;
  // The tip of `release/2.x`.
  release: string;
}

// `<root>/lib.git` has `main` (2 commits), the tag `v1` at `main`, `release/2.x` (3 commits after `main`), and `lint` at `main`.
function lib(exe: string, root: string): Lib {
  const g = gitIn(exe);
  const src = join(root, "lib-src");
  const bare = join(root, "lib.git");
  mkdirSync(src, { recursive: true });
  g(root, ["init", "-q", "--bare", "-b", "main", bare]);
  g(src, ["init", "-q", "-b", "main"]);
  const commit = (text: string) => {
    writeFileSync(join(src, "f.txt"), `${text}\n`);
    g(src, ["add", "--", "f.txt"]);
    g(src, ["commit", "-q", "--no-verify", "-m", text]);
  };
  commit("lib 1");
  commit("lib 2");
  const main = g(src, ["rev-parse", "HEAD"]);
  g(src, ["tag", "v1"]);
  g(src, ["branch", "lint"]);
  g(src, ["switch", "-q", "-c", "release/2.x"]);
  for (const n of [1, 2, 3]) commit(`release ${n}`);
  g(src, ["push", "-q", slashed(bare), "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]);
  return { url: slashed(bare), main, release: g(src, ["rev-parse", "HEAD"]) };
}

// One commit on `main` of a new repository at `repo`. `prepare` writes the index entries of that commit.
function commitRepo(exe: string, repo: string, prepare: () => void): void {
  const g = gitIn(exe);
  mkdirSync(repo, { recursive: true });
  g(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "p.txt"), "p\n");
  g(repo, ["add", "--", "p.txt"]);
  prepare();
  g(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
}

/** A repository without submodules. The cases switch to it and back. */
export function otherRepo(exe: string, dir: string): string {
  const repo = join(dir, "other");
  commitRepo(exe, repo, () => {});
  return repo;
}

// ---- (a) and (b): the SC-018 twins ----

/** The path of row `i` of `n`: `m/<g>/<i>` in 16 folders. */
export const twinPath = (i: number) => `m/${String(i % 16).padStart(2, "0")}/${String(i).padStart(3, "0")}`;

export interface Twins {
  // Every submodule on `main` with `origin/main` as its upstream.
  branch: string;
  // The same rows with every HEAD detached at the same commit.
  detached: string;
  paths: string[];
}

/** T144 (a) and (b): `n` initialized submodules with URLs in `.gitmodules`. `submodule update --init` clones each one from `lib.git`. */
export function twinWorlds(exe: string, dir: string, n: number): Twins {
  const g = gitIn(exe);
  const l = lib(exe, dir);
  const paths = Array.from({ length: n }, (_, i) => twinPath(i));
  const branch = join(dir, "branch");
  commitRepo(exe, branch, () => {
    writeFileSync(join(branch, ".gitmodules"), gitmodules(paths.map((p) => [p, l.url])));
    g(branch, ["add", "--", ".gitmodules"]);
    g(branch, ["update-index", "--index-info"], gitlinks(l.main, paths));
  });
  g(branch, ["submodule", "update", "--init", "--jobs", "8", "-q"]);
  // The update leaves each HEAD detached at the gitlink. The clone made `main` with `origin/main` as its upstream, at the same commit.
  const detached = join(dir, "detached");
  // The gitfile and `core.worktree` of each submodule hold relative paths, so the copy stays valid.
  cpSync(branch, detached, { recursive: true });
  for (const p of paths) g(join(branch, ...p.split("/")), ["switch", "-q", "main"]);
  return { branch, detached, paths };
}

export interface Moved {
  repo: string;
  paths: string[];
  // The commit of each HEAD: `main` of `lib.git`.
  head: string;
  // The commit of each gitlink: the `release/2.x` tip, which each clone holds.
  target: string;
}

/** T154: the detached twin of `twinWorlds` with every gitlink at the `release/2.x` tip. Each HEAD stays detached at `main`. */
export function movedTwins(exe: string, dir: string, n: number): Moved {
  const g = gitIn(exe);
  const l = lib(exe, dir);
  const paths = Array.from({ length: n }, (_, i) => twinPath(i));
  const repo = join(dir, "moved");
  commitRepo(exe, repo, () => {
    writeFileSync(join(repo, ".gitmodules"), gitmodules(paths.map((p) => [p, l.url])));
    g(repo, ["add", "--", ".gitmodules"]);
    g(repo, ["update-index", "--index-info"], gitlinks(l.main, paths));
  });
  g(repo, ["submodule", "update", "--init", "--jobs", "8", "-q"]);
  g(repo, ["update-index", "--index-info"], gitlinks(l.release, paths));
  g(repo, ["commit", "-q", "--no-verify", "-m", "move"]);
  return { repo, paths, head: l.main, target: l.release };
}

// ---- (c): the 1,024-folder bound ----

/** T144 (c): 256 gitlinks without a clone. Each path has 4 own folders, so 256 rows give 1,024 folders. `top` adds 1 shared folder. */
export function folderWorld(exe: string, dir: string, folders: 1_024 | 1_025): { repo: string; paths: string[] } {
  const prefix = folders === 1_025 ? "top/" : "";
  return gitlinkWorld(exe, dir, Array.from({ length: 256 }, (_, i) => `${prefix}t${String(i).padStart(3, "0")}/a/b/c/s`));
}

/** T161: 1,024 gitlinks without a clone at `f<i>/s`, i from 0000 to 1023. So 1,024 rows give 1,024 folders. */
export function wideWorld(exe: string, dir: string): { repo: string; paths: string[] } {
  return gitlinkWorld(exe, dir, Array.from({ length: 1_024 }, (_, i) => `f${String(i).padStart(4, "0")}/s`));
}

// One commit with a gitlink at `main` of `lib.git` for each path, without a clone.
function gitlinkWorld(exe: string, dir: string, paths: string[]): { repo: string; paths: string[] } {
  const g = gitIn(exe);
  const l = lib(exe, dir);
  const repo = join(dir, "repo");
  commitRepo(exe, repo, () => {
    writeFileSync(join(repo, ".gitmodules"), gitmodules(paths.map((p) => [p, l.url])));
    g(repo, ["add", "--", ".gitmodules"]);
    g(repo, ["update-index", "--index-info"], gitlinks(l.main, paths));
  });
  return { repo, paths };
}

/** The folder rows of top-level submodule paths: each distinct path prefix (spec FR-107). */
export function folderCount(paths: readonly string[]): number {
  const folders = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return folders.size;
}

// ---- Q30: the board set of the boards Main, Collapsed, Dark, and BranchMarks ----

// The 10 rows of tests/contracts/workbench-submodules.test.tsx `BOARD`. `zlib` and `minizip` are nested in `app-shared`.
export const ICONS = "vendor/icon-pack-sample-extended-glyph-set";
export const BOARD_TOP = ["libs/net/http", "libs/core", "libs/ui", "vendor/tools/fmt", "vendor/tools/lint", ICONS, "app-shared", "docs-theme"];
export const BOARD_NESTED = ["third_party/zlib", "third_party/contrib/minizip"];
/** [kind, label, level, folder count] in the shown order, as tests/contracts/workbench-submodules.test.tsx `BOARD_TREE`. */
export const BOARD_TREE: [string, string, number, number | null][] = [
  ["folder", "libs", 1, 3],
  ["folder", "net", 2, 1],
  ["submodule", "http", 3, null],
  ["submodule", "core", 2, null],
  ["submodule", "ui", 2, null],
  ["folder", "vendor", 1, 3],
  ["folder", "tools", 2, 2],
  ["submodule", "fmt", 3, null],
  ["submodule", "lint", 3, null],
  ["submodule", "icon-pack-sample-extended-glyph-set", 2, null],
  ["submodule", "app-shared", 1, null],
  ["folder", "third_party", 2, 2],
  ["folder", "contrib", 3, 1],
  ["submodule", "minizip", 4, null],
  ["submodule", "zlib", 3, null],
  ["submodule", "docs-theme", 1, null],
];

export interface Board {
  repo: string;
  // The checked-out submodules as display paths below `repo`: every row except ICONS.
  checkedOut: string[];
}

/**
 * The board set with real marks: http equal, core detached, ui ahead 1, fmt behind 3, lint gone, ICONS not cloned,
 * app-shared ahead 2 behind 1, zlib equal, minizip with HEAD on `refs/tags/v1`, docs-theme without an upstream.
 */
export function boardWorld(exe: string, dir: string): Board {
  const g = gitIn(exe);
  const l = lib(exe, dir);
  // `app.git`: `main` has the nested gitlinks in its first commit and one more commit.
  const appBare = slashed(join(dir, "app.git"));
  const appSrc = join(dir, "app-src");
  g(dir, ["init", "-q", "--bare", "-b", "main", appBare]);
  commitRepo(exe, appSrc, () => {
    writeFileSync(join(appSrc, ".gitmodules"), gitmodules(BOARD_NESTED.map((p) => [p, l.url])));
    g(appSrc, ["add", "--", ".gitmodules"]);
    g(appSrc, ["update-index", "--index-info"], gitlinks(l.main, BOARD_NESTED));
  });
  const appBase = g(appSrc, ["rev-parse", "HEAD"]);
  writeFileSync(join(appSrc, "p.txt"), "p 2\n");
  g(appSrc, ["commit", "-q", "--no-verify", "-am", "app 2"]);
  g(appSrc, ["push", "-q", appBare, "main"]);

  const repo = join(dir, "repo");
  const top = BOARD_TOP.map((p): [string, string] => [p, p === "app-shared" ? appBare : l.url]);
  commitRepo(exe, repo, () => {
    writeFileSync(join(repo, ".gitmodules"), gitmodules(top));
    g(repo, ["add", "--", ".gitmodules"]);
    g(repo, ["update-index", "--index-info"], Buffer.concat([gitlinks(l.main, BOARD_TOP.filter((p) => p !== "app-shared")), gitlinks(appBase, ["app-shared"])]));
  });
  const cloned = BOARD_TOP.filter((p) => p !== ICONS);
  g(repo, ["submodule", "update", "--init", "--recursive", "-q", "--", ...cloned]);
  const at = (path: string) => join(repo, ...path.split("/"));
  const commitIn = (path: string, text: string) => {
    writeFileSync(join(at(path), "local.txt"), `${text}\n`);
    g(at(path), ["add", "--", "local.txt"]);
    g(at(path), ["commit", "-q", "--no-verify", "-m", text]);
  };
  g(at("libs/net/http"), ["switch", "-q", "main"]);
  g(at("libs/ui"), ["switch", "-q", "main"]);
  commitIn("libs/ui", "ui 1");
  g(at("vendor/tools/fmt"), ["switch", "-q", "--track", "-c", "release/2.x", "origin/release/2.x"]);
  g(at("vendor/tools/fmt"), ["reset", "-q", "--hard", "origin/release/2.x~3"]);
  g(at("vendor/tools/lint"), ["switch", "-q", "--track", "-c", "lint", "origin/lint"]);
  // The upstream config stays, and its remote-tracking ref goes: git-for-each-ref(1) `%(upstream:track)` gives `[gone]`.
  g(at("vendor/tools/lint"), ["update-ref", "-d", "refs/remotes/origin/lint"]);
  // `main` of app.git is one commit after the gitlink, so the reset to the gitlink gives behind 1. Two commits give ahead 2.
  g(at("app-shared"), ["switch", "-q", "main"]);
  g(at("app-shared"), ["reset", "-q", "--hard", appBase]);
  commitIn("app-shared", "app local 1");
  commitIn("app-shared", "app local 2");
  g(at("app-shared/third_party/zlib"), ["switch", "-q", "main"]);
  // builtin/symbolic-ref.c refuses only a HEAD target outside `refs/`. `v1` is the checked-out commit.
  g(at("app-shared/third_party/contrib/minizip"), ["symbolic-ref", "HEAD", "refs/tags/v1"]);
  g(at("docs-theme"), ["switch", "-q", "-c", "draft"]);
  return { repo, checkedOut: [...cloned, ...BOARD_NESTED.map((p) => `app-shared/${p}`)] };
}

// ---- Oracle ----

/**
 * The accessible-name parts of the branch mark of the submodule at `dir` (plan D15 "Tree rows"), from Git output only.
 * Spec SC-018: the `git status --porcelain=v2 --branch` headers; for a HEAD outside `refs/heads/`, the research R31 fact (no upstream).
 */
export function markParts(exe: string, dir: string): string[] {
  // git-symbolic-ref(1) `-q`: exit 1 for a detached HEAD.
  const ref = gitExit(exe, FIXTURE_ROOT, dir, ["symbolic-ref", "-q", "HEAD"]);
  if (ref.exitCode === 1) return ["no branch"];
  if (ref.exitCode !== 0) throw new Error(`git symbolic-ref -q HEAD exited ${ref.exitCode} in ${dir}`);
  const full = ref.stdout.toString("utf8").trim();
  if (!full.startsWith("refs/heads/")) return [full, "No upstream"];
  const status = gitExit(exe, FIXTURE_ROOT, dir, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=no", "--ignore-submodules=all"]);
  if (status.exitCode !== 0) throw new Error(`git status exited ${status.exitCode} in ${dir}`);
  // git-status(1) "Branch Headers": `# <name> <value>` lines.
  const headers = new Map(
    status.stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.startsWith("# branch."))
      .map((line) => [line.slice(2, line.indexOf(" ", 2)), line.slice(line.indexOf(" ", 2) + 1)]),
  );
  const name = full.slice("refs/heads/".length);
  if (headers.get("branch.head") !== name) throw new Error(`the status header names ${headers.get("branch.head")}, symbolic-ref names ${full}, in ${dir}`);
  if (!headers.has("branch.upstream")) return [name, "No upstream"];
  // git-status(1): `branch.ab` is absent when the upstream is set but gone.
  const ab = /^\+([0-9]+) -([0-9]+)$/.exec(headers.get("branch.ab") ?? "");
  if (ab === null) return [name, "upstream gone"];
  return [name, `${ab[1]} ahead, ${ab[2]} behind`];
}

// ---- Page checks of the twin sets ----

// src/frontend/submodules/SubmodulesGroup.tsx `VIRTUAL_MIN` (plan D20 "Group"): above this count of shown rows, only the rows near the view are mounted.
export const VIRTUAL_MIN = 200;

/**
 * A page expression: true when the rows of `paths` show with the branch mark `text` (spec FR-109). The marks come with the rows (FR-110).
 * The one top folder row counts all rows of `paths`. Each mounted submodule row is a row of `paths` with the mark `text`.
 * Up to `VIRTUAL_MIN` shown rows, all rows are mounted, so the mounted submodule rows must also number `paths.length`.
 */
export function marksShown(paths: readonly string[], text: string): string {
  const top = paths[0]!.split("/")[0]!;
  if (!paths.every((p) => p.startsWith(`${top}/`))) throw new Error(`a path is outside the top folder ${top}`);
  const all = paths.length + folderCount(paths) <= VIRTUAL_MIN;
  // SubmodulesGroup.tsx `num`: the folder count text is the en-US form.
  const count = paths.length.toLocaleString("en-US");
  return `(() => {
    const items = [...(document.querySelector('[data-slot=submodules-group]')?.querySelectorAll('[role=tree] [role=treeitem]') ?? [])];
    const top = items.find((e) => e.dataset.path === undefined && e.getAttribute('aria-description') === ${JSON.stringify(top)} && e.getAttribute('aria-level') === '1' && e.getAttribute('aria-setsize') === '1');
    if (top?.querySelector('[data-slot=folder-count]')?.textContent !== ${JSON.stringify(count)}) return false;
    const paths = new Set(${JSON.stringify(paths)});
    const rows = items.filter((e) => e.dataset.path !== undefined);
    return rows.length > 0 && ${all ? `rows.length === ${paths.length} &&` : ""} rows.every((e) => paths.has(e.dataset.path) && e.querySelector('[data-slot=branch-mark]')?.textContent === ${JSON.stringify(text)});
  })()`;
}

type ReviewReply = { state: string; result?: { rows: Pick<SubmodulePlanRow, "rowId" | "path">[]; branches: SubmoduleBranch[] } };
export type ReplyMarks = { rows: string[]; count: number; marks: Record<string, object> };

/** The branch marks of the last sent `review_submodules` call, by row path (contract Δ12 "Branch marks"). No call may be pending. */
export async function replyMarks(ipc: IpcLog): Promise<ReplyMarks> {
  if (ipc.pending("review_submodules").length > 0) throw new Error("a review_submodules call is pending");
  const call = ipc.calls().findLast((c) => c.command === "review_submodules");
  if (call === undefined || call.end === null) throw new Error("no review_submodules reply arrived");
  const reply = await ipc.body<ReviewReply>(call);
  if (reply.state !== "succeeded" || reply.result === undefined) throw new Error(`the last review_submodules reply is ${reply.state}`);
  const pathOf = new Map(reply.result.rows.map((r) => [r.rowId, r.path]));
  return {
    rows: reply.result.rows.map((r) => r.path).toSorted(),
    count: reply.result.branches.length,
    marks: Object.fromEntries(reply.result.branches.map(({ rowId, ...mark }) => [pathOf.get(rowId) ?? `no row ${rowId}`, mark])),
  };
}

/** The `replyMarks` value when each row of `paths` has the mark `mark`, without its `rowId`. */
export const sameMarks = (paths: readonly string[], mark: object): ReplyMarks => ({ rows: paths.toSorted(), count: paths.length, marks: Object.fromEntries(paths.map((p) => [p, mark])) });
