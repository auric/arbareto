// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 T032: Add to .gitignore and Add to info/exclude (spec FR-045, FR-046, plan.md D9, contract Δ3 `ignore`, Δ6 `fileAppend`, data-model §7).
// No Git command writes these files (research.md R12). The shell appends the bytes, and the service never writes a repository file.

import { isUtf8 } from "node:buffer";
import type { z } from "zod";
import type { FILE_FACT_ERRORS, FileFact, ProcessRequest } from "../contracts/channel";
import type { ChangeEntry } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { ignoreLine } from "../contracts/ignore-line";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import { createCollector, RunnerRefusal, type GitRunner, type WalkStop } from "./git-runner";
import { contextOf, readBounded, runRead } from "./read-steps";
import type { Workspace } from "./registration";
import { excludePathArgs } from "./workbench-commands";

export type IgnoreTarget = "gitignore" | "exclude";

// Contract Δ6 `fileAppend`: the frame without `type` and `callId`, and its reply without them.
export type FileAppendRequest = Omit<Extract<z.infer<typeof ProcessRequest>, { type: "fileAppend" }>, "type" | "callId">;
export type FileAppendReply = { result: "appended" | "stale" } | { result: "refused"; reason: "not-regular" } | { result: "error"; code: (typeof FILE_FACT_ERRORS)[number] };
export interface FileAppender {
  fileAppend(request: FileAppendRequest, signal: AbortSignal): Promise<FileAppendReply | WalkStop>;
}

export interface IgnoreContext {
  runner: Pick<GitRunner, "run" | "fileFacts">;
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
}

type FileState = { size: number; sha256: string };

// Data-model §7. `file` is the absolute target path of the `fileAppend` request. `after` is the target state that the append gives.
export interface IgnorePlan {
  target: IgnoreTarget;
  path: Uint8Array;
  folder: boolean;
  line: string;
  prefixNewline: boolean;
  expected: "absent" | FileState;
  file: string;
  bytes: Uint8Array;
  after: FileState;
}

export type IgnoreRefusal = { code: ErrorCode; reason?: string };
export type IgnoreReview = { plan: IgnorePlan } | IgnoreRefusal | WalkStop;

// The terminal event of a run (data-model §7). `observed` names the target state after the append.
export type IgnoreOutcome<S> = (
  | { type: "intended-effects-confirmed" }
  | { type: "differing-effects" }
  | { type: "no-effects"; observed: "canceled" | "failed"; code?: ErrorCode; reason?: string }
  | { type: "reconciliation-read-failed"; code: ErrorCode }
) & { status: S };

const LF = 0x0a;
const SLASH = 0x2f;
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const unavailable = (reason: string): IgnoreRefusal => ({ code: "WORKBENCH_UNAVAILABLE", reason });
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const isStop = (value: unknown): value is WalkStop => typeof value === "object" && value !== null && "stop" in value;

// git dir.c `trim_trailing_spaces`: a run of spaces at the end goes, unless a backslash quotes its first space.
function trimTrailingSpaces(text: string): string {
  let lastSpace = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " ") {
      if (lastSpace < 0) lastSpace = i;
      continue;
    }
    if (text[i] === "\\") i++;
    lastSpace = -1;
  }
  return lastSpace < 0 ? text : text.slice(0, lastSpace);
}

// git dir.c `add_patterns_from_buffer`: Git skips a UTF-8 BOM, splits at LF, drops a CR before the LF, and trims trailing spaces.
// `add_patterns` adds a final LF, so the last line counts too.
function patternLines(bytes: Uint8Array): string[] {
  const start = bytes.length >= 3 && Buffer.compare(bytes.subarray(0, 3), BOM) === 0 ? 3 : 0;
  const text = utf8.decode(bytes.subarray(start));
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").map((line) => trimTrailingSpaces(line.endsWith("\r") ? line.slice(0, -1) : line));
}

// The `fileFacts` entry and the Git-form path of the target.
async function targetOf(t: IgnoreContext, target: IgnoreTarget): Promise<{ root: "worktreeRoot" | "commonDirectory"; names: string[]; file: string } | IgnoreRefusal | WalkStop> {
  const w = t.workspace;
  if (target === "gitignore") return { root: "worktreeRoot", names: [".gitignore"], file: `${w.worktreeRoot}/.gitignore` };
  // Contract Δ3: Git names the `info/exclude` file. The shell writes only `info/exclude` of the common directory (contract Δ6).
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const step = await runRead(t.runner as GitRunner, t, excludePathArgs(), out);
  if (t.signal.aborted) return { stop: "canceled" };
  if ("refused" in step) return { code: step.refused };
  if (step.exit.deadline !== undefined) return { stop: "deadline" };
  if (step.exit.diagnosticLimit) return { code: "OUTPUT_LIMIT" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const raw = out.take();
  if (out.limited || raw.length < 2 || raw[raw.length - 1] !== LF || raw.subarray(0, -1).includes(LF) || !isUtf8(raw)) return { code: "MALFORMED_GIT_OUTPUT" };
  const file = utf8.decode(raw.subarray(0, -1));
  if (file !== `${w.commonDirectory}/info/exclude`) return unavailable("path");
  return { root: "commonDirectory", names: ["info", "exclude"], file };
}

// The target facts without following a link (contract §6 "File facts"), with the SHA-256 of a file up to the 1 MiB bound.
async function factOf(t: IgnoreContext, root: "worktreeRoot" | "commonDirectory", names: string[]): Promise<{ fact: FileFact } | IgnoreRefusal | WalkStop> {
  try {
    const reply = await t.runner.fileFacts({ operationId: t.operationId, ...contextOf(t.workspace), digest: true, files: [{ root, path: names }] }, t.signal);
    return isStop(reply) ? reply : reply.length === 1 ? { fact: reply[0]! } : { code: "MALFORMED_GIT_OUTPUT" };
  } catch (error) {
    if (error instanceof RunnerRefusal) return { code: error.code };
    throw error;
  }
}

// Contract Δ3 `ignore` reads. `folder`: the path bytes of an Untracked folder row above the entry (data-model §7).
export async function reviewIgnore(t: IgnoreContext, entry: ChangeEntry, target: IgnoreTarget, folder: Uint8Array | null = null): Promise<IgnoreReview> {
  const w = t.workspace;
  if (entry.category !== "untracked") return { code: "INVALID_REQUEST" };
  const entryPath = new Uint8Array(Buffer.from(entry.pathBytes, "base64"));
  let path: Uint8Array = entryPath;
  let isFolder = false;
  if (folder !== null) {
    const below = folder.length > 0 && entryPath.length > folder.length + 1 && entryPath[folder.length] === SLASH && Buffer.compare(entryPath.subarray(0, folder.length), folder) === 0;
    if (!below) return { code: "INVALID_REQUEST" };
    path = folder;
    isFolder = true;
  } else if (entryPath[entryPath.length - 1] === SLASH) {
    // git-status(1) `--untracked-files=all` lists a folder record only for a nested repository.
    path = entryPath.subarray(0, -1);
    isFolder = true;
  }
  const line = ignoreLine(path, isFolder);
  if (!line.ok) return unavailable(line.reason);
  // Contract §11 "Paths and file access": no working-file byte crosses from a WSL repository, so the line checks have no input there.
  if (w.wsl !== undefined) return unavailable("unreadable");
  const where = await targetOf(t, target);
  if (!("file" in where)) return where;
  const facts = await factOf(t, where.root, where.names);
  if (!("fact" in facts)) return facts;
  const fact = facts.fact;
  let content: Uint8Array = new Uint8Array();
  let expected: IgnorePlan["expected"] = "absent";
  if (fact.kind === "file") {
    if (fact.bound !== undefined || fact.digest === undefined) return unavailable("ignore-size");
    // This read can follow a link. Its bytes count only with the size and SHA-256 of the no-follow read.
    const read = await readBounded(where.file, fact.size);
    if (!(read instanceof Uint8Array) || read.length !== fact.size || sha256(read) !== fact.digest) return { code: "REPOSITORY_CHANGED" };
    content = read;
    expected = { size: fact.size, sha256: fact.digest };
  } else if (fact.kind === "error") return unavailable("unreadable");
  else if (fact.kind !== "absent") return unavailable("ignore-not-regular");
  if (!isUtf8(content) || content.includes(0)) return unavailable("ignore-not-text");
  if (patternLines(content).includes(line.line)) return unavailable("ignore-exists");
  const prefixNewline = content.length > 0 && content[content.length - 1] !== LF;
  const bytes = new TextEncoder().encode(`${prefixNewline ? "\n" : ""}${line.line}\n`);
  const whole = Buffer.concat([content, bytes]);
  return { plan: { target, path, folder: isFolder, line: line.line, prefixNewline, expected, file: where.file, bytes, after: { size: whole.length, sha256: sha256(whole) } } };
}

// Contract Δ3 `runWorkbench` step `ignore`: the `fileAppend` request, then a fresh read of the target, then the status read (spec FR-046).
// The caller holds the `started` marker of action `ignore-gitignore` or `ignore-exclude` (contract Δ6).
export async function runIgnore<S>(t: IgnoreContext & { appender: FileAppender }, plan: IgnorePlan, readStatus: () => Promise<S>): Promise<IgnoreOutcome<S>> {
  const w = t.workspace;
  let reply: FileAppendReply | WalkStop | { refused: ErrorCode };
  try {
    reply = await t.appender.fileAppend({ operationId: t.operationId, repositoryId: w.repositoryId, target: plan.target, path: plan.file, expected: plan.expected, bytes: Buffer.from(plan.bytes).toString("base64") }, t.signal);
  } catch (error) {
    if (!(error instanceof RunnerRefusal)) throw error;
    reply = { refused: error.code };
  }
  // Contract §8: a cancel never stops a reconciliation read.
  const quiet = { ...t, signal: new AbortController().signal };
  const where = plan.target === "gitignore" ? { root: "worktreeRoot" as const, names: [".gitignore"] } : { root: "commonDirectory" as const, names: ["info", "exclude"] };
  const facts = await factOf(quiet, where.root, where.names);
  const status = await readStatus();
  // Contract Δ6: only the walk finish writes, after the check. So a stop, `stale`, and `refused` leave the target unchanged.
  if ("stop" in reply) return { type: "no-effects", observed: reply.stop === "canceled" ? "canceled" : "failed", ...(reply.stop === "deadline" ? { code: "DEADLINE" as const } : {}), status };
  if ("refused" in reply) return { type: "no-effects", observed: "failed", code: reply.refused, status };
  if (reply.result === "stale") return { type: "no-effects", observed: "failed", code: "STALE_REVIEW", status };
  if (reply.result === "refused") return { type: "no-effects", observed: "failed", code: "WORKBENCH_UNAVAILABLE", reason: "ignore-not-regular", status };
  // `appended` and `error` can follow a write, so the fresh read decides.
  if (!("fact" in facts)) return { type: "reconciliation-read-failed", code: "code" in facts ? facts.code : "DEADLINE", status };
  const fact = facts.fact;
  if (fact.kind === "error") return { type: "reconciliation-read-failed", code: "GIT_FAILED", status };
  const same = (state: "absent" | FileState) => (state === "absent" ? fact.kind === "absent" : fact.kind === "file" && fact.size === state.size && fact.digest === state.sha256);
  if (same(plan.after)) return { type: reply.result === "appended" ? "intended-effects-confirmed" : "differing-effects", status };
  if (reply.result === "error" && same(plan.expected)) return { type: "no-effects", observed: "failed", code: "GIT_FAILED", status };
  return { type: "differing-effects", status };
}
