// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The read steps that `readWorkspace` and `readHistory` share: the bounded file read, the Git run, and the object check (contract §7 "Missing objects").

import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, GIT_PROCESS_DEADLINE_MS } from "../contracts/limits";
import { createCollector, RunnerRefusal, type Collector, type GitExit, type GitRunner } from "./git-runner";
import type { Workspace } from "./registration";

export type ReadTarget = { operationId: string; signal: AbortSignal; workspace: Workspace };
export type ReadStep = { exit: GitExit; stderrBytes: number } | { refused: ErrorCode };

const NEWLINE = 0x0a;

export const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export const isMissing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
export const latin1 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
export const contextOf = (w: Workspace) => ({ contextKind: "registeredOperation" as const, gitInstallationId: w.gitInstallationId, repositoryId: w.repositoryId });

// Reads an open file from its current position. At most `maxBytes` plus one byte.
export async function readHandleBounded(handle: FileHandle, maxBytes: number): Promise<Uint8Array | "over"> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = new Uint8Array(Math.min(1024 * 1024, maxBytes + 1 - size));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length);
    if (bytesRead === 0) return Buffer.concat(chunks);
    size += bytesRead;
    if (size > maxBytes) return "over";
    chunks.push(chunk.subarray(0, bytesRead));
  }
}

// At most `maxBytes` plus one byte. O_NONBLOCK keeps a FIFO from blocking the open.
export async function readBounded(path: string, maxBytes: number): Promise<Uint8Array | "absent" | "over" | "unavailable"> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return isMissing(error) ? "absent" : "unavailable";
  }
  try {
    if (!(await handle.stat()).isFile()) return "unavailable";
    return await readHandleBounded(handle, maxBytes);
  } catch {
    return "unavailable";
  } finally {
    await handle.close();
  }
}

// One read-policy Git process. A runner refusal gives its code.
export async function runRead(runner: GitRunner, t: ReadTarget, args: string[], stdout: Collector, input?: Uint8Array): Promise<ReadStep> {
  const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  try {
    const exit = await runner.run({
      operationId: t.operationId,
      context: contextOf(t.workspace),
      arguments: args,
      ...(input === undefined ? {} : { input }),
      environmentPolicy: "read",
      limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS },
      stdout,
      stderr,
      signal: t.signal,
    });
    return { exit, stderrBytes: stderr.bytes };
  } catch (error) {
    if (error instanceof RunnerRefusal) return { refused: error.code };
    throw error;
  }
}

// The `cat-file --batch-check` input: one object ID per line.
export const objectCheckInput = (oids: readonly string[]) => new TextEncoder().encode(`${oids.join("\n")}\n`);

// The `cat-file --batch-check` answer for `oids`, one line each in input order. Git prints `<object> missing` for an absent object.
function objectCheckAnswer(raw: Uint8Array, oids: readonly string[]): "missing" | "present" | "failed" {
  if (raw.length === 0 || raw[raw.length - 1] !== NEWLINE) return "failed";
  const lines = Buffer.from(raw.subarray(0, -1)).toString("latin1").split("\n");
  if (lines.length !== oids.length) return "failed";
  let missing = false;
  for (const [i, line] of lines.entries()) {
    const rest = line.startsWith(`${oids[i]} `) ? line.slice(oids[i]!.length + 1) : null;
    if (rest === "missing") missing = true;
    else if (rest === null || !/^(?:blob|tree|commit|tag) [0-9]+$/.test(rest)) return "failed";
  }
  return missing ? "missing" : "present";
}

// The object check result of a step that did not end canceled. The caller decides cancellation, because its run wrapper reports an abort.
export function objectCheckOutcome(step: { exit: GitExit } | { refused: ErrorCode }, out: ReturnType<typeof createCollector>, oids: readonly string[]): "missing" | "present" | "failed" | "deadline" {
  if ("refused" in step) return "failed";
  if (step.exit.deadline !== undefined) return "deadline";
  if (out.limited || step.exit.exitCode !== 0) return "failed";
  return objectCheckAnswer(out.take(), oids);
}
