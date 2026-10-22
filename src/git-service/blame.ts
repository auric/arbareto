// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 contract Δ3 `readBlame`, Δ5 bounds, data-model §10 and §11, plan.md D12 steps 1 to 6 and "Blame before this commit".
// No read gate: no command of this read loads the index (plan.md D2, research.md R13, F4).

import type { BlameUnavailableReason } from "../contracts/errors";
import {
  BLAME_FILE_BYTES,
  BLAME_FILE_LINES,
  BLAME_OUTPUT_BYTES,
  BLAME_PROGRESS_EVENTS_PER_SECOND,
  BLAME_RESULT_BYTES,
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  FILE_FACT_COMPONENT_UNITS,
  FILE_FACT_ENTRIES,
  GIT_PROCESS_DEADLINE_MS,
  HISTORY_PROCESS_DEADLINE_MS,
} from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import { BlameStream, countLines, type ParsedBlame } from "./blame-parser";
import { blameArgs, blameNumstatArgs, blameTreeArgs, blobArgs, blobDiffArgs, ignoreRevsArgs, isObjectId, type BlameFlags, type ObjectFormat } from "./commands";
import { b64, both, emptyTreeOf, fail, Stop, type InspectionOutcome, type InspectionTarget } from "./commit-changes";
import { parseNumstat } from "./diff-parser";
import { createTailCollector } from "./discovery";
import { createCollector, RunnerRefusal, type Collector, type GitExit, type GitRunner } from "./git-runner";
import { readShallow } from "./history";
import { topologyPaths } from "./history-view";
import { mapLine, parseHunks } from "./line-map";
import { contextOf, encodedBytes, latin1, strictUtf8 } from "./read-steps";
import { hasPromisor, OBJECT_MISSING_REMEDY } from "./status";
import type { Trust } from "./trust";

export type BlameOptions = BlameFlags & { ignoreList: boolean };
export type BlameReason = BlameUnavailableReason;

// The commit and path that one blame reads.
export interface BlameTarget {
  commit: string;
  path: Uint8Array;
}

// Data-model §10: the latest result of a workspace, for "Blame before this commit".
interface Retained {
  blameId: string;
  repositoryId: string;
  lines: number;
  parsed: ParsedBlame;
}

const NUL = 0x00;
const SLASH = 0x2f;
const PROGRESS_MS = 1000 / BLAME_PROGRESS_EVENTS_PER_SECOND;
// git-config(1) `get`: exit 1 when the key has no value.
const NO_VALUE = 1;
const unavailable = (reason: BlameReason, path?: string) => fail("BLAME_UNAVAILABLE", { reason, ...(path === undefined ? {} : { path }) });
// An argv item is text, so a path that is no valid UTF-8 gets the 001 reason `path`.
const textOf = (bytes: Uint8Array): string => {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw unavailable("path");
  }
};

// git-ls-tree(1) `--long`: `<mode> SP <type> SP <oid> SP <size> TAB <path> NUL`. builtin/ls-tree.c prints the size with `%7s`, and `-` for a tree or a gitlink.
function treeRecord(out: Uint8Array, path: Uint8Array, objectFormat: ObjectFormat): { type: "blob" | "tree" | "commit"; oid: string; size: number | null } | "none" | null {
  if (out.length === 0) return "none";
  const tab = out.indexOf(0x09);
  if (tab < 0 || out[out.length - 1] !== NUL || out.indexOf(NUL) !== out.length - 1) return null;
  const m = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+) ( *)(-|0|[1-9][0-9]*)$/.exec(latin1(out.subarray(0, tab)));
  if (m === null || !isObjectId(m[3]!, objectFormat) || m[4]!.length !== Math.max(0, 7 - m[5]!.length)) return null;
  if (Buffer.compare(out.subarray(tab + 1, -1), path) !== 0) return null;
  const type = m[2] as "blob" | "tree" | "commit";
  if ((type === "blob") === (m[5] === "-")) return null;
  return { type, oid: m[3]!, size: m[5] === "-" ? null : Number(m[5]) };
}

export interface BlameReaderOptions {
  runner: GitRunner;
  trust: Trust;
}

export function createBlameReader({ runner, trust }: BlameReaderOptions) {
  // Contract Δ5 "Retained blame results": one per workspace.
  const retained = new Map<string, Retained>();

  // One read-policy step with the 30-second deadline, or the 120-second blame deadline. A refusal, a deadline, a cancel, or a diagnostic bound ends the read.
  async function step(t: InspectionTarget, args: string[], stdout: Collector, o: { input?: Uint8Array; deadlineMs?: number; stderr?: Collector } = {}): Promise<GitExit> {
    let exit: GitExit;
    try {
      exit = await runner.run({
        operationId: t.operationId,
        context: contextOf(t.workspace),
        arguments: args,
        ...(o.input === undefined ? {} : { input: o.input }),
        environmentPolicy: "read",
        limits: { deadlineMs: o.deadlineMs ?? GIT_PROCESS_DEADLINE_MS },
        stdout,
        stderr: o.stderr ?? createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
        signal: t.signal,
      });
    } catch (error) {
      if (error instanceof RunnerRefusal) throw fail(error.code);
      throw error;
    }
    if (t.signal.aborted) throw new Stop({ result: "canceled" });
    if (exit.deadline !== undefined) throw new Stop({ result: "deadline" });
    if (exit.diagnosticLimit) throw fail("OUTPUT_LIMIT");
    return exit;
  }

  // Contract §7 "Missing objects": a failed step in a promisor repository gives OBJECT_MISSING with the 001 remedy. The read never fetches.
  async function failed(t: InspectionTarget, value?: object): Promise<never> {
    const listed = await trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: t.workspace });
    if (!listed.ok) throw new Stop("stop" in listed ? { result: listed.stop } : { result: "failed", code: listed.code });
    const promisor = await hasPromisor(listed.listing.entries, t.workspace, (paths) => runner.identities(t.operationId, contextOf(t.workspace), paths, t.signal));
    if (t.signal.aborted) throw new Stop({ result: "canceled" });
    if (promisor === "canceled" || promisor === "deadline") throw new Stop({ result: promisor });
    if (promisor === true) throw fail("OBJECT_MISSING", { remedy: { text: OBJECT_MISSING_REMEDY } });
    throw fail("GIT_FAILED", value);
  }

  // Plan.md D12 step 1: the blob of `path` at `commit`, or a refusal reason.
  async function blobOf(t: InspectionTarget, commit: string, path: string, pathBytes: Uint8Array): Promise<{ oid: string; size: number } | "none" | "tree" | "commit"> {
    const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const exit = await step(t, blameTreeArgs(commit, t.workspace.objectFormat, path), out);
    if (out.limited) throw fail("MALFORMED_GIT_OUTPUT");
    if (exit.exitCode !== 0) return failed(t);
    const record = treeRecord(out.take(), pathBytes, t.workspace.objectFormat);
    if (record === null) throw fail("MALFORMED_GIT_OUTPUT");
    if (record === "none") return "none";
    if (record.type !== "blob") return record.type;
    return { oid: record.oid, size: record.size! };
  }

  // Plan.md D12 step 4: the configured values that Git reads, and the file check of each value below the worktree root (spec FR-060).
  // True when the effective list holds a value.
  async function hasIgnoreList(t: InspectionTarget): Promise<boolean> {
    const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const exit = await step(t, ignoreRevsArgs(), out);
    if (out.limited) throw fail("OUTPUT_LIMIT");
    if (exit.exitCode === NO_VALUE && out.bytes === 0) return false;
    if (exit.exitCode !== 0) throw fail("GIT_FAILED");
    const raw = out.take();
    if (raw.length === 0 || raw[raw.length - 1] !== NUL) throw fail("MALFORMED_GIT_OUTPUT");
    // `-z` ends each value with NUL. An empty value gives an empty record, and it resets nothing in Git (plan.md O-9).
    const values: Uint8Array[] = [];
    for (let at = 0; at < raw.length; ) {
      const end = raw.indexOf(NUL, at);
      values.push(raw.subarray(at, end));
      at = end + 1;
    }
    const effective = values.filter((v) => v.length > 0);
    const checked: { value: string; parts: string[] }[] = [];
    for (const v of effective) {
      let value: string;
      try {
        value = strictUtf8.decode(v);
      } catch {
        continue;
      }
      // A relative value resolves from the worktree root, where Git runs. Only a path below the root gets the shell walk (contract §6 `fileFacts`).
      const rel = NATIVE.path.relative(t.workspace.worktreeRoot, NATIVE.path.resolve(t.workspace.worktreeRoot, value));
      if (rel === "" || NATIVE.path.isAbsolute(rel)) continue;
      const parts = rel.split(NATIVE.path.sep);
      if (parts[0] === ".." || !parts.every((p) => p.length <= FILE_FACT_COMPONENT_UNITS && p.isWellFormed() && NATIVE.isComponent(p))) continue;
      checked.push({ value, parts });
    }
    for (let at = 0; at < checked.length; at += FILE_FACT_ENTRIES) {
      const batch = checked.slice(at, at + FILE_FACT_ENTRIES);
      let facts;
      try {
        facts = await runner.fileFacts({ operationId: t.operationId, ...contextOf(t.workspace), digest: false, files: batch.map((c) => ({ root: "worktreeRoot" as const, path: c.parts })) }, t.signal);
      } catch (error) {
        if (error instanceof RunnerRefusal) throw fail(error.code);
        throw error;
      }
      if (!Array.isArray(facts)) throw new Stop({ result: facts.stop });
      // Git opens every listed file before the command-line value clears the list, so a missing file fails in both toggle states (F7).
      const absent = batch.find((_, i) => facts[i]!.kind === "absent");
      if (absent !== undefined) throw unavailable("ignore-revs-file-missing", absent.value);
    }
    return effective.length > 0;
  }

  async function shallowSet(t: InspectionTarget): Promise<ReadonlySet<string>> {
    const paths = await topologyPaths(runner, t);
    if ("stop" in paths) throw new Stop({ result: paths.stop });
    if ("failed" in paths) throw fail(paths.failed);
    const shallow = await readShallow(paths.shallow, t.workspace.objectFormat);
    if ("stop" in shallow) throw new Stop({ result: shallow.stop });
    if ("failed" in shallow) throw fail(shallow.failed);
    // shortcut: the contract names no reason for a shallow file above SHALLOW_METADATA_BYTES, so the read ends OUTPUT_LIMIT. Add a reason when the contract names one.
    if (shallow.kind === "over") throw fail("OUTPUT_LIMIT");
    return shallow.kind === "file" ? shallow.commits : new Set();
  }

  // Plan.md D12 steps 1 to 6 for one target. `progress` sends the phase `blame` (contract Δ2).
  async function blame(t: InspectionTarget, target: BlameTarget, options: BlameOptions, progress: (counters: Record<string, number>) => void): Promise<{ value: Record<string, unknown>; record: Retained }> {
    const w = t.workspace;
    const fmt = w.objectFormat;
    const path = textOf(target.path);
    // A folder record ends with `/` (git-status(1)). A folder has no blame.
    if (target.path[target.path.length - 1] === SLASH) throw unavailable("no-history");
    const blob = await blobOf(t, target.commit, path, target.path);
    if (blob === "none" || blob === "tree") throw unavailable("no-history");
    if (blob === "commit") throw unavailable("submodule");
    if (blob.size > BLAME_FILE_BYTES) throw unavailable("size");

    const emptyTree = await emptyTreeOf((args, out, input) => step(t, args, out, { input }), fmt);
    const numstat = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const numstatExit = await step(t, blameNumstatArgs(emptyTree, target.commit, fmt, path), numstat);
    if (numstat.limited) throw fail("MALFORMED_GIT_OUTPUT");
    if (numstatExit.exitCode !== 0) return failed(t);
    const binary = parseNumstat(numstat.take(), target.path, null);
    if (!binary.ok) throw fail("MALFORMED_GIT_OUTPUT");
    if (binary.binary) throw unavailable("binary");

    const content = createCollector({ maxBytes: BLAME_FILE_BYTES });
    const contentExit = await step(t, blobArgs(blob.oid, fmt), content);
    if (content.limited) throw fail("MALFORMED_GIT_OUTPUT");
    if (contentExit.exitCode !== 0) return failed(t);
    const bytes = content.take();
    if (bytes.length !== blob.size) throw fail("MALFORMED_GIT_OUTPUT");
    const lines = countLines(bytes);
    if (lines > BLAME_FILE_LINES) throw unavailable("lines");

    const listed = await hasIgnoreList(t);
    const shallow = await shallowSet(t);
    const form = !listed ? "incremental" : options.ignoreList ? "porcelain" : "cleared";
    const stream = new BlameStream(form === "porcelain" ? "porcelain" : "incremental", fmt);
    let last = 0;
    const send = (force: boolean) => {
      const now = performance.now();
      if (!force && now - last < PROGRESS_MS) return;
      last = now;
      // Contract Δ2: a porcelain blame carries no counter, because Git prints it only after the whole blame.
      progress(form === "porcelain" ? {} : { blamed: Math.min(stream.blamed, lines), total: lines });
    };
    let bytesSeen = 0;
    let limited = false;
    const out: Collector = {
      push(chunk) {
        bytesSeen += chunk.length;
        if (limited || bytesSeen > BLAME_OUTPUT_BYTES) {
          limited = true;
          return;
        }
        stream.push(chunk);
        if (form !== "porcelain") send(false);
      },
      get bytes() {
        return bytesSeen;
      },
      records: 0,
      get limited() {
        return limited || stream.malformed;
      },
    };
    const tail = createTailCollector("plain");
    send(true);
    const exit = await step(t, blameArgs(target.commit, fmt, path, options, form), out, { deadlineMs: HISTORY_PROCESS_DEADLINE_MS, stderr: tail });
    if (limited) throw fail("OUTPUT_LIMIT");
    if (stream.malformed) throw fail("MALFORMED_GIT_OUTPUT");
    if (exit.exitCode !== 0) return failed(t, { outputTail: tail.outputTail() });
    const parsed = stream.finish(lines);
    if (parsed === null) throw fail("MALFORMED_GIT_OUTPUT");
    const record: Retained = { blameId: crypto.randomUUID(), repositoryId: w.repositoryId, lines, parsed };
    const value: Record<string, unknown> = {
      blameId: record.blameId,
      commit: target.commit,
      pathBytes: b64(target.path),
      content: b64(bytes),
      lines,
      ignoreList: form === "incremental" ? "none" : form === "porcelain" ? "on" : "off",
      groups: parsed.groups.map((g) => ({ commit: g.origin, origStart: g.origStart, finalStart: g.finalStart, count: g.count, ignored: g.ignored, unblamable: g.unblamable })),
      commits: parsed.origins.map((o) => ({
        oid: o.oid,
        author: b64(o.author),
        authorMail: b64(o.authorMail),
        authorTime: o.authorTime,
        authorTz: o.authorTz,
        summary: b64(o.summary),
        previous: o.previous === null ? null : { oid: o.previous.oid, pathBytes: b64(o.previous.path) },
        filenameBytes: b64(o.filename),
        // Plan.md D12 "Shallow": the shallow file decides, not the `boundary` header, because `blame.showRoot` changes it.
        shallow: shallow.has(o.oid),
      })),
    };
    if (encodedBytes(value) > BLAME_RESULT_BYTES) throw fail("OUTPUT_LIMIT");
    return { value, record };
  }

  const settle = (repositoryId: string, done: { value: Record<string, unknown>; record: Retained }): InspectionOutcome => {
    retained.set(repositoryId, done.record);
    return { result: "succeeded", value: done.value };
  };

  return {
    async readBlame(t: InspectionTarget, target: BlameTarget, options: BlameOptions, progress: (counters: Record<string, number>) => void): Promise<InspectionOutcome> {
      try {
        const done = await blame(t, target, options, progress);
        if (t.signal.aborted) return { result: "canceled" };
        return settle(t.workspace.repositoryId, done);
      } catch (error) {
        if (error instanceof Stop) return error.outcome;
        throw error;
      }
    },

    // Contract Δ3 `{blameId, line}` acceptance: the group of `line` in the retained result. No Git process runs.
    before(repositoryId: string, blameId: string, line: number): { origin: ParsedBlame["origins"][number]; orig: number } | { refused: "UNKNOWN_TARGET" | "INVALID_REQUEST" } | { reason: "no-previous" } {
      const r = retained.get(repositoryId);
      if (r === undefined || r.blameId !== blameId) return { refused: "UNKNOWN_TARGET" };
      if (line > r.lines) return { refused: "INVALID_REQUEST" };
      const g = r.parsed.groups.find((x) => x.finalStart <= line && line < x.finalStart + x.count)!;
      const origin = r.parsed.origins[g.origin]!;
      if (origin.previous === null) return { reason: "no-previous" };
      return { origin, orig: g.origStart + (line - g.finalStart) };
    },

    // Contract Δ3: steps 1 to 6 for (P, Q) first, so the refusals of the previous version come first. Then the zero-context hunks
    // between the previous version and the version of the line's commit give the mapped line (data-model §11).
    async readBefore(t: InspectionTarget, from: { origin: ParsedBlame["origins"][number]; orig: number }, options: BlameOptions, progress: (counters: Record<string, number>) => void): Promise<InspectionOutcome> {
      try {
        const previous = from.origin.previous!;
        const fmt = t.workspace.objectFormat;
        const done = await blame(t, { commit: previous.oid, path: previous.path }, options, progress);
        const [oldBlob, newBlob] = await both(blobOf(t, previous.oid, textOf(previous.path), previous.path), blobOf(t, from.origin.oid, textOf(from.origin.filename), from.origin.filename));
        // Git named both versions in its blame output, so each must be a blob.
        if (typeof oldBlob !== "object" || typeof newBlob !== "object") throw fail("MALFORMED_GIT_OUTPUT");
        const out = createCollector({ maxBytes: BLAME_OUTPUT_BYTES });
        const exit = await step(t, blobDiffArgs(oldBlob.oid, newBlob.oid, fmt), out);
        if (out.limited) throw fail("OUTPUT_LIMIT");
        // git-diff(1) `--exit-code`: without it, `git diff` exits 0 with and without a difference.
        if (exit.exitCode !== 0) return await failed(t);
        const hunks = parseHunks(out.take());
        if (hunks === null) throw fail("MALFORMED_GIT_OUTPUT");
        if (t.signal.aborted) return { result: "canceled" };
        const focusLine = mapLine(from.orig, hunks, done.record.lines);
        if (focusLine !== null) done.value.focusLine = focusLine;
        return settle(t.workspace.repositoryId, done);
      } catch (error) {
        if (error instanceof Stop) return error.outcome;
        throw error;
      }
    },

    release(repositoryId: string): void {
      retained.delete(repositoryId);
    },
  };
}

export type BlameReader = ReturnType<typeof createBlameReader>;
