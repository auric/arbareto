// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 T040: the ignore editor read and Save (plan.md D8 and D10, contract Δ3 `readIgnoreFile` and `ignore-save`, Δ6 `fileReplace`, data-model §6 and §8).
// No Git command writes these files (research.md R12). The shell writes the bytes, and the service never writes a repository file.

import { isUtf8 } from "node:buffer";
import type { FILE_FACT_ERRORS, FileFact } from "../contracts/channel";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, IGNORE_TARGET_BYTES } from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import { wslIdentityPath } from "../contracts/wsl-route";
import { createCollector, RunnerRefusal, type FileReplaceReply, type FileReplaceRequest, type GitRunner, type WalkStop } from "./git-runner";
import { decodeIgnore, encodeIgnore, saveForm } from "./ignore-text";
import { contextOf, readBounded, runRead } from "./read-steps";
import type { Workspace } from "./registration";
import { excludePathArgs } from "./workbench-commands";

export type IgnoreTarget = "gitignore" | "exclude";

export interface IgnoreContext {
  runner: Pick<GitRunner, "run" | "fileFacts">;
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
}

type FileState = { size: number; sha256: string };

export type IgnoreRefusal = { code: ErrorCode; reason?: string };

const LF = 0x0a;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const unavailable = (reason: string): IgnoreRefusal => ({ code: "WORKBENCH_UNAVAILABLE", reason });
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const isStop = (value: unknown): value is WalkStop => typeof value === "object" && value !== null && "stop" in value;

// The `fileFacts` entry and the Git-form path of the target.
export async function targetOf(t: IgnoreContext, target: IgnoreTarget): Promise<{ root: "worktreeRoot" | "commonDirectory"; names: string[]; file: string } | IgnoreRefusal | WalkStop> {
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
  // Contract §11: a WSL Git prints a Linux path, and the workspace holds the UNC identity form of each Git-resolved path.
  const named = w.wsl === undefined ? file === `${w.commonDirectory}/info/exclude` : wslIdentityPath(w.wsl.distro, file) === NATIVE.path.join(w.commonDirectory, "info", "exclude");
  if (!named) return unavailable("path");
  return { root: "commonDirectory", names: ["info", "exclude"], file };
}

// The target facts without following a link (contract §6 "File facts"), with the SHA-256 of a file up to the 1 MiB bound.
// Feature 005 contract Δ6: `content` asks a WSL shell for the bytes of the one file too.
async function factOf(t: IgnoreContext, root: "worktreeRoot" | "commonDirectory", names: string[], content = false): Promise<{ fact: FileFact } | IgnoreRefusal | WalkStop> {
  try {
    const reply = await t.runner.fileFacts({ operationId: t.operationId, ...contextOf(t.workspace), digest: true, files: [{ root, path: names }], ...(content ? { content: true } : {}) }, t.signal);
    return isStop(reply) ? reply : reply.length === 1 ? { fact: reply[0]! } : { code: "MALFORMED_GIT_OUTPUT" };
  } catch (error) {
    if (error instanceof RunnerRefusal) return { code: error.code };
    throw error;
  }
}

// ---- Feature 005: the ignore editor (plan.md D8 and D10) ----

// Data-model §6: the loaded file, with its bytes and the path of the `fileReplace` request.
export interface LoadedIgnore {
  target: IgnoreTarget;
  file: string;
  // Contract Δ6 `fileReplace` `path`: the target below the registered root. A WSL root is its UNC form.
  path: string;
  state: "absent" | "file";
  bytes: Uint8Array;
  expected: "absent" | FileState;
}

export type IgnoreFileValue = { target: IgnoreTarget; file: string; state: "absent" | "file"; text: string; lineEnding: "lf" | "crlf" | "none" | "mixed"; lineCounts?: { lf: number; crlf: number }; bom: boolean; expected: "absent" | FileState };

const ROOTS = { gitignore: "worktreeRoot", exclude: "commonDirectory" } as const;

// Plan.md D8: the fact of the target, and for a file its bytes. A link, a folder, a special file, and an unreadable file refuse with their reason.
// `expected`: Save compares the state first, so a changed file gives STALE_REVIEW `ignore-changed` before any other reason (contract Δ3).
async function load(t: IgnoreContext, target: IgnoreTarget, expected?: "absent" | FileState): Promise<LoadedIgnore | IgnoreRefusal | WalkStop | "changed"> {
  const w = t.workspace;
  const where = await targetOf(t, target);
  if (!("file" in where)) return where;
  const names = where.names;
  const facts = await factOf(t, where.root, names, w.wsl !== undefined);
  if (!("fact" in facts)) return facts;
  const fact = facts.fact;
  const path = w.wsl === undefined ? where.file : NATIVE.path.join(w[ROOTS[target]], ...names);
  if (expected !== undefined) {
    const same = expected === "absent" ? fact.kind === "absent" : fact.kind === "file" && fact.size === expected.size && fact.digest === expected.sha256;
    if (!same) return "changed";
  }
  if (fact.kind === "absent") return { target, file: where.file, path, state: "absent", bytes: new Uint8Array(), expected: "absent" };
  if (fact.kind === "link") return unavailable("ignore-link");
  if (fact.kind === "directory") return unavailable("ignore-folder");
  if (fact.kind === "other") return unavailable("ignore-not-regular");
  if (fact.kind === "error") return unavailable("unreadable");
  if (fact.bound !== undefined || fact.digest === undefined) return unavailable("ignore-size");
  // A Windows read can follow a link. Its bytes count only with the size and SHA-256 of the no-follow read. WSL bytes come with the fact (contract Δ11).
  const read = w.wsl === undefined ? await readBounded(where.file, fact.size) : fact.bytes === undefined ? "unavailable" : new Uint8Array(Buffer.from(fact.bytes, "base64"));
  if (!(read instanceof Uint8Array) || read.length !== fact.size || sha256(read) !== fact.digest) return { code: "REPOSITORY_CHANGED" };
  return { target, file: where.file, path, state: "file", bytes: read, expected: { size: fact.size, sha256: fact.digest } };
}

// Contract Δ3 `readIgnoreFile` and data-model §6. No Git process loads the index, so no read gate applies (plan.md D2).
export async function readIgnoreFile(t: IgnoreContext, target: IgnoreTarget): Promise<{ value: IgnoreFileValue } | IgnoreRefusal | WalkStop> {
  const loaded = await load(t, target);
  if (loaded === "changed") throw new Error("a read without an expected state");
  if (!("bytes" in loaded)) return loaded;
  const decoded = decodeIgnore(loaded.bytes);
  if (!decoded.ok) return unavailable(decoded.reason);
  const { file, state, expected } = loaded;
  const counts = decoded.lineEnding === "mixed" ? { lineCounts: decoded.lineCounts } : {};
  return { value: { target, file, state, text: decoded.text, lineEnding: decoded.lineEnding, ...counts, bom: decoded.bom, expected } };
}

// Data-model §8 bound and the contract Δ3 plan. `bytes` is the base64 of the new file bytes.
export interface IgnoreSaveBound {
  target: IgnoreTarget;
  file: string;
  path: string;
  expected: "absent" | FileState;
  after: FileState;
  bytes: string;
}

export type IgnoreSaveReview = { bound: IgnoreSaveBound; plan: { target: IgnoreTarget; file: string; size: number; sha256: string } } | IgnoreRefusal | WalkStop;

// Contract Δ3 `ignore-save` reads. `text` is the UTF-8 bytes of the LF text of the editor. The BOM comes from the file (plan.md D10).
export async function reviewIgnoreSave(t: IgnoreContext, p: { target: IgnoreTarget; text: Uint8Array; expected: "absent" | FileState; lineEnding?: "lf" | "crlf" }): Promise<IgnoreSaveReview> {
  const loaded = await load(t, p.target, p.expected);
  if (loaded === "changed") return { code: "STALE_REVIEW", reason: "ignore-changed" };
  if (!("bytes" in loaded)) return loaded;
  const decoded = decodeIgnore(loaded.bytes);
  if (!decoded.ok) return unavailable(decoded.reason);
  // An absent file decodes as `none`, which saves with LF.
  const form = saveForm(decoded, p.lineEnding);
  if (form === null) return { code: "INVALID_REQUEST" };
  if (p.text.includes(0)) return unavailable("ignore-nul");
  const bytes = encodeIgnore(p.text, form);
  if (bytes.length > IGNORE_TARGET_BYTES) return unavailable("ignore-size");
  const after = { size: bytes.length, sha256: sha256(bytes) };
  const bound = { target: p.target, file: loaded.file, path: loaded.path, expected: loaded.expected, after, bytes: Buffer.from(bytes).toString("base64") };
  return { bound, plan: { target: p.target, file: loaded.file, ...after } };
}

export interface FileReplacer {
  fileReplace(request: FileReplaceRequest, signal: AbortSignal): Promise<FileReplaceReply | WalkStop>;
}

export type IgnoreSaveOutcome = {
  event: { type: "intended-effects-confirmed" } | { type: "differing-effects" } | { type: "failed-with-effects" } | { type: "no-effects"; observed: "canceled" | "failed"; code?: ErrorCode } | { type: "reconciliation-read-failed"; code: ErrorCode };
  result: { action: "ignore-save"; outcome?: "replaced" | "stale" | "not-regular" | "stopped" | "interrupted" | "error"; code?: (typeof FILE_FACT_ERRORS)[number] };
};

// Contract Δ3 `runWorkbench` `ignore-save`: one `fileReplace`, then the fresh digest of the target decides (plan.md D10).
// `settle` waits for the WSL process-end fact after an `interrupted` reply and tells a Cancel. Null: the outcome stays unknown.
export async function runIgnoreSave(
  t: IgnoreContext & { replacer: FileReplacer },
  bound: IgnoreSaveBound,
  settle: (interrupted: boolean) => Promise<{ canceled: boolean } | null>,
  readStatus: () => Promise<unknown>,
): Promise<IgnoreSaveOutcome> {
  const w = t.workspace;
  const result = { action: "ignore-save" as const };
  let reply: FileReplaceReply | WalkStop | { refused: ErrorCode };
  try {
    reply = await t.replacer.fileReplace({ operationId: t.operationId, repositoryId: w.repositoryId, target: bound.target, path: bound.path, expected: bound.expected, bytes: bound.bytes }, t.signal);
  } catch (error) {
    if (!(error instanceof RunnerRefusal)) throw error;
    reply = { refused: error.code };
  }
  const settled = await settle("result" in reply && reply.result === "interrupted");
  if (settled === null) return { event: { type: "reconciliation-read-failed", code: "GIT_FAILED" }, result };
  // Contract §8: a cancel never stops a reconciliation read.
  const quiet = { ...t, signal: new AbortController().signal };
  const where = bound.target === "gitignore" ? { root: "worktreeRoot" as const, names: [".gitignore"] } : { root: "commonDirectory" as const, names: ["info", "exclude"] };
  const facts = await factOf(quiet, where.root, where.names);
  await readStatus();
  // Contract Δ6: the shell refuses a frame before its walk, and `stale` and `refused` come from the check before the write. So they leave the target unchanged.
  if ("refused" in reply) return { event: { type: "no-effects", observed: "failed", code: reply.refused }, result };
  if (!("stop" in reply) && reply.result === "stale") return { event: { type: "no-effects", observed: "failed", code: "STALE_REVIEW" }, result: { ...result, outcome: "stale" } };
  if (!("stop" in reply) && reply.result === "refused") return { event: { type: "no-effects", observed: "failed", code: "WORKBENCH_UNAVAILABLE" }, result: { ...result, outcome: "not-regular" } };
  if (!("fact" in facts)) return { event: { type: "reconciliation-read-failed", code: "code" in facts ? facts.code : "DEADLINE" }, result };
  const fact = facts.fact;
  if (fact.kind === "error") return { event: { type: "reconciliation-read-failed", code: "GIT_FAILED" }, result };
  const same = (state: "absent" | FileState) => (state === "absent" ? fact.kind === "absent" : fact.kind === "file" && fact.size === state.size && fact.digest === state.sha256);
  if ("stop" in reply || reply.result === "stopped" || reply.result === "interrupted") {
    const outcome = "stop" in reply || reply.result === "stopped" ? "stopped" : "interrupted";
    if (!same(bound.expected)) return { event: { type: "failed-with-effects" }, result: { ...result, outcome } };
    if (settled.canceled) return { event: { type: "no-effects", observed: "canceled" }, result: { ...result, outcome } };
    // Contract Δ3: a shell `stopped` or `interrupted` reply names no cause, so only a runner deadline stop gives DEADLINE.
    return { event: { type: "no-effects", observed: "failed", code: "stop" in reply && reply.stop === "deadline" ? "DEADLINE" : "GIT_FAILED" }, result: { ...result, outcome } };
  }
  if (reply.result === "replaced") return { event: same(bound.after) ? { type: "intended-effects-confirmed" } : { type: "differing-effects" }, result: { ...result, outcome: "replaced" } };
  const error = { ...result, outcome: "error" as const, ...("code" in reply ? { code: reply.code } : {}) };
  return { event: same(bound.expected) ? { type: "no-effects", observed: "failed", code: "GIT_FAILED" } : { type: "failed-with-effects" }, result: error };
}
