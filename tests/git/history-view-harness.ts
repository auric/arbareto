// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Shared steps of the feature 002 view tests T022, T023, and T024 (plan.md P3). The oracles run the test Git and share no code with `src/git-service/history-view.ts`.

import { expect } from "bun:test";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { LoadHistoryResult, OpenHistoryResult, ReadHistoryRowsResult } from "../../src/contracts/envelope";
import { EMPTY_STATE, layoutStep, type Cell } from "../../src/git-service/history-layout";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixturePath, ownedGit, type OwnedGitOptions } from "./fixture-root";
import { GIT } from "./git-binary";
import { largeFixture, startPoints, type LargeSpec } from "./history-fixtures";
import type { BunRunner } from "./bun-runner";
import type { OpenedHistory, Service, ServiceResponse } from "./service-harness";

printOrigin("../../src/git-service/history-view.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

export const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

export const git = (repo: string, args: string[], options: OwnedGitOptions = {}) => ownedGit(gitPath(), FIXTURE_ROOT, repo, args, options);
export const gitText = (repo: string, args: string[], options: OwnedGitOptions = {}) => git(repo, args, options).toString("utf8");

export type Opened = OpenedHistory;
export interface Loaded {
  rows: number;
  complete: boolean;
  reason?: string;
  remedy?: { text: string; command: string | null };
}
export type RowsResult = { target: "found" | "unknown" | "none"; rows?: ViewRow[]; cut?: boolean; rowCount: number; lanes: number; complete: boolean; bytes: number };
export interface ViewRow {
  index: number;
  oid: string;
  parents: string[];
  cell: Cell | null;
  labels: { kind: string; name: string; invalidUtf8: boolean }[];
  checkout: boolean;
  subject?: string;
  author?: { name: string; email: string };
  date?: number;
  encoding?: string | null;
  invalidUtf8?: boolean;
  textLimit?: true;
  body?: string;
  bodyCut?: boolean;
  committer?: { name: string; email: string };
  committerDate?: number;
  children?: string[];
}
export type Need = { row: number } | { oid: string } | { end: true };
export type At = { row: number } | { oid: string } | { end: true } | { match: "next" | "previous"; from: number };

// A copy of the cached large fixture in the owned fixture root. The cache stays unchanged.
export function copyLarge(spec: LargeSpec, commitGraph: boolean, name: string): string {
  const dest = fixturePath(name);
  cpSync(largeFixture(gitPath(), spec, commitGraph).repo, dest, { recursive: true });
  return dest;
}

export interface OracleRow {
  oid: string;
  parents: string[];
}

// One uninterrupted `rev-list --parents --date-order --stdin` of `starts`, the contract Δ3 view order.
export function oracle(repo: string, starts: readonly string[] = startPoints(gitPath(), FIXTURE_ROOT, repo)): OracleRow[] {
  const out = gitText(repo, ["--no-optional-locks", "rev-list", "--parents", "--date-order", "--stdin"], { input: Buffer.from(starts.map((s) => `${s}\n`).join("")) });
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [oid, ...parents] = l.split(" ");
      return { oid: oid!, parents };
    });
}

// The T009 fold: `layoutStep` over every row from the empty state.
export function fold(rows: readonly OracleRow[], shallow: ReadonlySet<string> = new Set()): Cell[] {
  let state = EMPTY_STATE;
  return rows.map((row) => {
    const step = layoutStep(state, { oid: row.oid, parents: row.parents, shallow: shallow.has(row.oid) });
    state = step.state;
    return step.cell;
  });
}

// Each result must fit its contract schema.
export function fits(schema: z.ZodType, value: unknown): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`result breaks its schema: ${JSON.stringify(parsed.error.issues).slice(0, 2000)}`);
}

export async function openView(service: Service, repositoryId: string, generation: number, scope: "all" | "current" = "all"): Promise<ServiceResponse<Opened>> {
  const response = await service.request<Opened>("openHistory", { scope }, { repositoryId, repositoryGeneration: generation });
  if (response.result !== undefined) fits(OpenHistoryResult, response.result);
  return response;
}

export async function opened(service: Service, repositoryId: string, generation: number, scope: "all" | "current" = "all"): Promise<Opened> {
  const response = await openView(service, repositoryId, generation, scope);
  expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
  return response.result!;
}

export async function load(service: Service, repositoryId: string, viewId: string, need: Need): Promise<ServiceResponse<Loaded>> {
  const response = await service.request<Loaded>("loadHistory", { viewId, need }, { repositoryId });
  if (response.result !== undefined) fits(LoadHistoryResult, response.result);
  return response;
}

export async function rows(service: Service, repositoryId: string, viewId: string, at: At, count = 512, text: "none" | "rows" | "details" = "none", extra: object = {}): Promise<ServiceResponse<RowsResult>> {
  const response = await service.request<RowsResult>("readHistoryRows", { viewId, mode: "full", at, count, text, ...extra }, { repositoryId });
  if (response.result !== undefined) fits(ReadHistoryRowsResult, response.result);
  return response;
}

// Every row of the view, in pages of `page` rows.
export async function allRows(service: Service, repositoryId: string, viewId: string, total: number, page = 512): Promise<ViewRow[]> {
  const out: ViewRow[] = [];
  while (out.length < total) {
    const response = await rows(service, repositoryId, viewId, { row: out.length }, page);
    expect({ state: response.state, target: response.result?.target }).toEqual({ state: "succeeded", target: "found" });
    out.push(...response.result!.rows!);
  }
  return out;
}

// Scroll loads (plan.md D6): each asks for the loaded row count, until the view is complete or a load ends otherwise.
export async function loadSteps(service: Service, repositoryId: string, viewId: string, first = 0): Promise<ServiceResponse<Loaded>[]> {
  const steps: ServiceResponse<Loaded>[] = [];
  let need = first;
  for (;;) {
    const step = await load(service, repositoryId, viewId, { row: need });
    steps.push(step);
    if (step.state !== "succeeded" || step.result!.complete) return steps;
    need = step.result!.rows;
  }
}

export const isLoad = (call: { arguments: readonly string[] }) => call.arguments.includes("rev-list") && call.arguments.includes("--stdin");
export const isReplaceRead = (call: { arguments: readonly string[] }) => call.arguments.at(-1) === "refs/replace" && call.arguments.length === 5;
export const isTextRead = (call: { arguments: readonly string[] }) => call.arguments.includes("--batch-command");

// tasks.md "Test harness rules": no commit-graph file may appear (SC-013, FR-044).
export function commitGraphFiles(repo: string): string[] {
  const info = join(gitText(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(), "objects", "info");
  return ["commit-graph", "commit-graphs"].map((name) => join(info, name)).filter((path) => existsSync(path));
}

// Bounded poll of the shell double.
export async function waitFor(what: string, found: () => boolean, timeoutMs = 30_000): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (!found()) {
    if (performance.now() > until) throw new Error(`${what}: not seen within ${timeoutMs} ms`);
    await Bun.sleep(5);
  }
}

// The recorded processes of the double that still run.
export const liveProcesses = (runner: BunRunner) => runner.liveRecorded();
