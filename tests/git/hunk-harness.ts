// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Shared steps of the batch 3 comparison and hunk tests (T093 to T097). The oracle shares no code with `src/git-service/`.
// `comparison.ts` and `hunk-publish.ts` do not exist before T105 and T110, so no test imports them at load.

import { expect, test } from "bun:test";
import { cpSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureDir, ownedGit, type OwnedGitOptions } from "./fixture-root";
import type { Built } from "./fixtures";
import { GIT } from "./git-binary";
import { indexEntries, operationMarkers, rawIndexDigest, workingFileDigests, type IndexEntry } from "./git-oracle";
import { missingCapability, openService, type Capability, type ChangeEntry, type OpenOptions, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

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
export async function underTest(module: "comparison" | "hunk-publish"): Promise<unknown> {
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
  expect((await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation)).state).toBe("succeeded");
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

// A todo case of a module that does not exist yet. A missing capability skips it and names the capability (tasks.md "Test harness rules").
export function todoCase(task: string, name: string, needs: readonly Capability[], fn: () => Promise<void>, timeoutMs = TIMEOUT_MS): void {
  const missing = missingCapability(...needs);
  if (GIT !== null && missing === null) return void test.todo(name, fn, timeoutMs);
  console.log(GIT === null ? `SKIP ${task} ${name}: Git executable absent` : `SKIP ${task} ${name}: missing capability ${missing} (unverified)`);
  test.skip(name, fn, timeoutMs);
}
