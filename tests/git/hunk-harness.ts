// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Shared steps of the batch 3 comparison, hunk, commit, and recovery tests (T093 to T100). The oracle shares no code with `src/git-service/`.
// The modules under test do not exist before T105 and T110 to T114, so no test imports them at load.

import { expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Handshake } from "../../src/contracts/channel";
import { printOrigin } from "../origin";
import type { CallMatch } from "./bun-runner";
import { FIXTURE_ROOT, fixtureDir, ownedGit, type OwnedGitOptions } from "./fixture-root";
import { put, type Built } from "./fixtures";
import { GIT } from "./git-binary";
import { indexEntries, operationMarkers, rawIndexDigest, workingFileDigests, type IndexEntry } from "./git-oracle";
import { openService, type ChangeEntry, type Envelope, type OpenOptions, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

export const TIMEOUT_MS = 120_000;

export const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

export const repoOf = (built: Built, name = "repo") => join(built.root, name);

export const git = (repo: string, args: string[], options: OwnedGitOptions = {}) => ownedGit(gitPath(), FIXTURE_ROOT, repo, args, options);
export const gitText = (repo: string, args: string[], options: OwnedGitOptions = {}) => git(repo, args, options).toString("utf8");
export const gitPathOf = (repo: string, name: string) => resolve(repo, gitText(repo, ["rev-parse", "--git-path", name]).trim());
export const gitDirOf = (repo: string) => gitText(repo, ["rev-parse", "--absolute-git-dir"]).trim();

// Prints the ORIGIN line of a module under test and loads it. Before its task, the module is missing, and this throws.
export async function underTest(module: "comparison" | "hunk-publish" | "commit-review" | "commit" | "reconcile" | "attribution" | "recovery"): Promise<unknown> {
  printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  return import(`../../src/git-service/${module}.ts`);
}

export async function withService(options: Omit<OpenOptions, "git">, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), ...options });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

export async function approve(service: Service, repositoryId: string): Promise<void> {
  const trust = await service.readTrust(repositoryId);
  expect(trust.state).toBe("succeeded");
  expect((await service.approveTrust(repositoryId)).state).toBe("succeeded");
}

// Every value under `key` at any depth. Data-model §5 names the fields, and the result nesting stays free (as in `trust.test.ts`).
export function valuesOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => valuesOf(item, key));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, item]) => (k === key ? [item, ...valuesOf(item, key)] : valuesOf(item, key)));
}

// The one value under `key`.
export function one<T>(value: unknown, key: string): T {
  const found = valuesOf(value, key);
  expect({ key, count: found.length }).toEqual({ key, count: 1 });
  return found[0] as T;
}

export const outcome = (response: { state: string; code?: string }) => ({ state: response.state, code: response.code });
export const SUCCEEDED = { state: "succeeded", code: undefined };

export async function readOk(service: Service, repositoryId: string): Promise<WorkspaceResult> {
  const read = await service.readWorkspace(repositoryId);
  expect(outcome(read)).toEqual(SUCCEEDED);
  return read.result!;
}

export function entryOf(read: WorkspaceResult, path: string, category: ChangeEntry["category"]): ChangeEntry {
  const entry = read.entries.find((e) => e.path === path && e.category === category);
  expect({ path, category, listed: entry !== undefined }).toEqual({ path, category, listed: true });
  return entry!;
}

export interface Comparison {
  read: WorkspaceResult;
  entry: ChangeEntry;
  response: ServiceResponse;
  comparisonId: string;
  hunkIds: string[];
}

// `readComparison` of one entry from a fresh read. The response stays unchecked.
export async function compare(service: Service, repositoryId: string, path: string, category: ChangeEntry["category"], read?: WorkspaceResult): Promise<Comparison> {
  const current = read ?? (await readOk(service, repositoryId));
  const entry = entryOf(current, path, category);
  const response = await service.request("readComparison", { snapshotId: current.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: current.generation, selectionId: crypto.randomUUID() });
  const ids = valuesOf(response.result, "comparisonId");
  return { read: current, entry, response, comparisonId: ids[0] as string, hunkIds: valuesOf(response.result, "hunkId") as string[] };
}

// The result of a comparison. A response without a result fails here with its state and code.
export function resultOf(c: Comparison): unknown {
  if (c.response.result === undefined) expect(outcome(c.response)).toEqual(SUCCEEDED);
  return c.response.result;
}

// A succeeded comparison with at least one hunk.
export async function selectHunks(service: Service, repositoryId: string, path: string, category: ChangeEntry["category"], read?: WorkspaceResult): Promise<Comparison> {
  const comparison = await compare(service, repositoryId, path, category, read);
  expect(outcome(comparison.response)).toEqual(SUCCEEDED);
  expect(comparison.hunkIds.length).toBeGreaterThan(0);
  return comparison;
}

export type Direction = "stage" | "unstage";

export function applyHunk(service: Service, repositoryId: string, c: Comparison, hunkId: string, direction: Direction, extra: object = {}): Promise<ServiceResponse> {
  return service.request("applyHunk", { comparisonId: c.comparisonId, hunkId, snapshotId: c.read.snapshotId, direction, ...extra }, { repositoryId, repositoryGeneration: c.read.generation });
}

export interface RepoState {
  entries: IndexEntry[];
  rawIndex: string | null;
  files: Record<string, string>;
  markers: string[];
}

export function repoState(repo: string, config: string[] = []): RepoState {
  return { entries: indexEntries(gitPath(), repo, config), rawIndex: rawIndexDigest(gitPath(), repo), files: workingFileDigests(repo), markers: operationMarkers(gitPath(), repo) };
}

// A disposable copy of a main-worktree repository under the fixture root.
export function copyRepo(repo: string, name: string): string {
  const copy = join(fixtureDir(name), "repo");
  cpSync(repo, copy, { recursive: true });
  return copy;
}

// Git's own interactive hunk selection in a copy (git-add(1) `--patch`, git-reset(1) `--patch`). `answers` holds one `y` or `n` per hunk.
export function scriptedPatch(repo: string, name: string, command: "add" | "reset", path: string, answers: string[], before: string[][] = []): string {
  const copy = copyRepo(repo, name);
  for (const args of before) git(copy, args);
  git(copy, ["-c", "core.pager=cat", "--literal-pathspecs", command, "-p", "--", path], { input: Buffer.from(answers.map((a) => `${a}\n`).join("")) });
  return copy;
}

export const withoutPath = (entries: IndexEntry[], ...paths: string[]) => entries.filter((e) => !paths.includes(e.path));

// The owned candidate files in the Git directory (contract §8: the fixed prefix `arbareto-candidate-`).
export const candidateFiles = (repo: string) => readdirSync(gitDirOf(repo)).filter((name) => name.startsWith("arbareto-candidate-")).sort();

// The `@@` hunks of a patch, each from its header to the next header.
export function hunksOf(patch: Uint8Array): string[] {
  const text = Buffer.from(patch).toString("latin1");
  const at = text.search(/^@@ /m);
  return at < 0 ? [] : text.slice(at).split(/(?=^@@ )/m);
}

// The base64 patch of a comparison, decoded. Contract §4: the patch arrives as base64.
export function patchOf(result: unknown): Uint8Array {
  const encoded = one<string>(result, "patch");
  const bytes = Buffer.from(encoded, "base64");
  expect(bytes.toString("base64")).toBe(encoded);
  return bytes;
}

// The tracked patch reads of `git add -p` (Git `add-patch.c`) with the research R3 header flags.
const PATCH_FLAGS = ["-p", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--no-relative"];
export function oraclePatch(repo: string, path: string, scope: "head-to-index" | "index-to-worktree", unborn = false): Uint8Array {
  const base = unborn ? [gitText(repo, ["hash-object", "-t", "tree", "--stdin"], { input: new Uint8Array() }).trim()] : ["HEAD"];
  const args = scope === "index-to-worktree" ? ["diff-files", ...PATCH_FLAGS] : ["diff-index", "--cached", ...PATCH_FLAGS, ...base];
  return git(repo, ["--no-optional-locks", "--literal-pathspecs", ...args, "--", path]);
}

// The new side of an all-addition patch, rebuilt from its `+` lines (research R3 "Untracked hunk content").
export function newSide(patch: Uint8Array): Buffer {
  const lines = hunksOf(patch).join("").split("\n");
  const out: Buffer[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("+")) continue;
    out.push(Buffer.from(line.slice(1), "latin1"));
    if (!(lines[i + 1] ?? "").startsWith("\\")) out.push(Buffer.from("\n"));
  }
  return Buffer.concat(out);
}

export const blobOf = (repo: string, path: string) => indexEntries(gitPath(), repo).find((e) => e.path === path && e.stage === 0)?.oid ?? null;
export const blobBytes = (repo: string, oid: string) => git(repo, ["cat-file", "blob", oid]);

// ---- Commit and recovery steps (T098 to T100). `commit-review.ts`, `commit.ts`, `reconcile.ts`, and `recovery.ts` come with T111 to T114. ----

export interface Review {
  read: WorkspaceResult;
  response: ServiceResponse;
  // The one-use review token, or undefined when the review issued none.
  token: string | undefined;
}

// `reviewCommit` of a fresh or given read. The response stays unchecked.
export async function review(service: Service, repositoryId: string, read?: WorkspaceResult): Promise<Review> {
  const current = read ?? (await readOk(service, repositoryId));
  const response = await service.request("reviewCommit", { snapshotId: current.snapshotId }, { repositoryId, repositoryGeneration: current.generation });
  return { read: current, response, token: valuesOf(response.result, "reviewToken")[0] as string | undefined };
}

export async function reviewOk(service: Service, repositoryId: string, read?: WorkspaceResult): Promise<Review> {
  const r = await review(service, repositoryId, read);
  expect(outcome(r.response)).toEqual(SUCCEEDED);
  expect(typeof r.token).toBe("string");
  return r;
}

export const commitPayload = (r: Review, message: string) => ({ reviewToken: r.token, message, confirmFullScope: true });

export function commit(service: Service, repositoryId: string, r: Review, message: string, envelope: Envelope = {}): Promise<ServiceResponse> {
  return service.request("commit", commitPayload(r, message), { repositoryId, repositoryGeneration: r.read.generation, ...envelope });
}

// Contract §4 "Commit validation and handoff": the one ordinary commit invocation, with the message on stdin.
export const COMMIT_ARGUMENTS = ["--no-lazy-fetch", "commit", "--quiet", "--file=-"];
export const isCommitCall = (call: { arguments: readonly string[] }) => call.arguments.includes("commit") && call.arguments.includes("--file=-");
export const commitCalls = (service: Service, from = 0) => service.runner.calls.slice(from).filter(isCommitCall);
// Accepts only the first Git process that starts after the commit process: the first reconciliation read.
export function afterCommitCall(): CallMatch {
  let seen = false;
  let done = false;
  return (call) => {
    if (isCommitCall(call)) seen = true;
    else if (seen && !done) return (done = true);
    return false;
  };
}

// The first non-option argument of a Git command line. `-c` and `-C` take a value.
export function subcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "-C") i++;
    else if (!args[i]!.startsWith("-")) return args[i];
  }
  return undefined;
}

export interface CommitFacts {
  tree: string;
  parents: string[];
  // Name and email. The time differs per run.
  author: string;
  committer: string;
  body: string;
}

// gitformat-commit: header lines, one empty line, then the message bytes.
export function commitFacts(repo: string, rev = "HEAD"): CommitFacts {
  const raw = git(repo, ["cat-file", "commit", rev]).toString("utf8");
  const split = raw.indexOf("\n\n");
  const headers = raw.slice(0, split).split("\n");
  const field = (name: string) => headers.filter((h) => h.startsWith(`${name} `)).map((h) => h.slice(name.length + 1));
  const ident = (value: string) => value.replace(/ \d+ [+-]\d{4}$/, "");
  return { tree: field("tree")[0]!, parents: field("parent"), author: ident(field("author")[0]!), committer: ident(field("committer")[0]!), body: raw.slice(split + 2) };
}

// Git's own commit of `message` in a copy, without hooks (git-commit(1) `--no-verify`).
export function oracleCommit(repo: string, name: string, message: string): CommitFacts {
  const copy = copyRepo(repo, name);
  git(copy, ["commit", "--quiet", "--no-verify", "--file=-"], { input: Buffer.from(message) });
  return commitFacts(copy);
}

export const headOid = (repo: string) => gitText(repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] }).trim() || null;

// The stage 0 entries of the index as `ls-tree -r` lists a tree.
export const indexTree = (repo: string) => indexEntries(gitPath(), repo).map(({ mode, oid, path }) => ({ mode, oid, path }));
export function treeOf(repo: string, rev: string): { mode: string; oid: string; path: string }[] {
  return gitText(repo, ["ls-tree", "-r", "-z", "--full-tree", rev])
    .split("\0")
    .filter((r) => r !== "")
    .map((r) => {
      const [meta, path] = r.split("\t");
      const [mode, , oid] = meta!.split(" ");
      return { mode: mode!, oid: oid!, path: path! };
    });
}

// The single-quoted shell form of a path for a hook script.
export const shQuote = (path: string) => `'${path.replaceAll("\\", "/")}'`;

// A hook script in the hook folder that Git resolves for `repo`.
export const putHook = (repo: string, event: string, body: string) => put(gitPathOf(repo, "hooks"), event, `#!/bin/sh\n${body}`);

// 2,400 polls of 50 ms: the 120-second commit process deadline.
const BARRIER_POLLS = 2400;
const BARRIER_WAIT_MS = 60_000;

export interface Barrier {
  // Hook script lines that mark the barrier as reached, then wait for `release`.
  body: string;
  reached(): Promise<void>;
  release(): void;
}

export function barrier(root: string, tag: string): Barrier {
  const dir = join(root, "barriers");
  mkdirSync(dir, { recursive: true });
  const reached = join(dir, `${tag}.reached`);
  const go = join(dir, `${tag}.go`);
  return {
    body: `: > ${shQuote(reached)}\ni=0\nwhile [ ! -e ${shQuote(go)} ] && [ $i -lt ${BARRIER_POLLS} ]; do sleep 0.05; i=$((i + 1)); done\n`,
    reached: () => until(() => existsSync(reached), `barrier ${tag}`, BARRIER_WAIT_MS),
    release: () => writeFileSync(go, ""),
  };
}

export async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > end) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await Bun.sleep(20);
  }
}

// Gives the next Git process that `match` accepts after `arm` a deadline of `deadlineMs` (`inject.deadlineMs`). Every other process keeps its request deadline.
export function shortDeadline(service: Service, match: CallMatch = () => true, deadlineMs = 1): { arm(): void } {
  let armed = false;
  service.runner.holdStart((call) => {
    const hit = armed && match(call);
    if (hit) armed = false;
    service.runner.inject.deadlineMs = hit ? deadlineMs : null;
    return false;
  });
  return { arm: () => void (armed = true) };
}

// The mutation frames of one operation in arrival order: `started`, `ended`, and the `resolved` frame of its marker.
export function mutationFrames(service: Service, operationId: string): string[] {
  const markerIds = service.runner.frames.filter((f) => f.type === "started" && f.operationId === operationId).map((f) => f.markerId);
  return service.runner.frames.filter((f) => f.operationId === operationId || (f.type === "resolved" && markerIds.includes(f.markerId))).map((f) => f.type as string);
}

export const progressStates = (service: Service, requestId: string) => (service.progress as { requestId?: string; state?: string }[]).filter((p) => p.requestId === requestId).map((p) => p.state);

export type Marker = Handshake["markers"][number];

// The identity reply of `path` from the identity log of the double (contract §6 "Process fields").
export function identityOf(service: Service, path: string): Marker["commonIdentity"] {
  for (const call of service.runner.identityCalls) {
    const reply = call.replies[call.paths.indexOf(path)] as Marker["commonIdentity"] | { code: string } | undefined;
    if (reply !== undefined && !("code" in reply)) return reply;
  }
  throw new Error(`no identity reply for ${path}`);
}

// A handshake marker for the repository of `read` (contract §6 "Recovery markers").
export function markerOf(service: Service, read: WorkspaceResult, kind: Marker["kind"] = "commit", markerId: string = crypto.randomUUID()): Marker {
  const { worktreeRoot, commonDirectory } = read.identity;
  return { markerId, kind, startedAt: new Date().toISOString(), worktreeRoot, commonDirectory, commonIdentity: identityOf(service, commonDirectory) };
}

// The markers that the double still holds, in handshake form. The shell rescans its recovery folder for each handshake (contract §6).
export const leftoverMarkers = (service: Service): Marker[] =>
  [...service.runner.markers].map(([markerId, f]) => ({ markerId, kind: f.kind, startedAt: new Date().toISOString(), worktreeRoot: f.worktreeRoot, commonDirectory: f.commonDirectory, commonIdentity: identityOf(service, f.commonDirectory) }));

// Contract §4 "Quoting rule": PowerShell ends a single-quoted string at these five characters, and each is doubled.
export const psQuote = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
// Contract §9: the `HOOK_FAILED` and commit `GIT_FAILED` remedy.
export const HOOK_REMEDY_TEXT = "This command runs the pre-commit hook in a terminal and does not commit. Other hooks show their output only here. Arbareto keeps your message.";
export const hookRemedy = (root: string) => `& ${psQuote(gitPath())} --no-lazy-fetch -C ${psQuote(root)} hook run --ignore-missing pre-commit`;
// Contract §9 "Lingering count" and "Other locks".
export const lingeringSentence = (count: number) => `Arbareto still runs ${count === 1 ? "1 process" : `${count} processes`} from earlier operations in this repository. Closing Arbareto ends them.`;
export const REVOKE_SENTENCE = "Revoke trust also ends them.";
export const OTHER_LOCKS_TEXT = "Git could not take a lock. Another Git process, or a process that Git or a hook started, can hold it. Use Refresh after that process ends.";
export const LOCKED_REMEDY = "Another Git process or a crash left this lock. Remove it only after all Git tools stop, including other Arbareto windows.";
