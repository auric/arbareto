// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T109: research R3 steps 6 to 10, contract §4 "Candidate time", "Split index", and "Hunk eligibility and publication". The Windows path.
// The caller holds the owned index lock (T107). This module never writes the canonical index.

import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { COMPARED_RAW_VERSION_BYTES, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, GIT_PROCESS_DEADLINE_MS, MUTATION_RAW_INDEX_BYTES } from "../contracts/limits";
import { applyCachedArgs, applyCachedReverseArgs, batchCommandArgs, entryHashArgs, isObjectId, readTreeEmptyArgs } from "./commands";
import type { RetainedComparison } from "./comparison";
import { parsePatch, type PatchHunk } from "./diff-parser";
import { IndexFormatError, rawIndexEntries, type RawIndexEntry } from "./eligibility";
import { createCollector, RunnerRefusal, type Collector, type GitRunner, type RefusedCode } from "./git-runner";
import { contextOf, isMissing, latin1, readHandleBounded } from "./read-steps";
import type { Workspace } from "./registration";

// Contract §8: the fixed prefix of every candidate file.
const CANDIDATE_PREFIX = "arbareto-candidate-";
const NUL = 0x00;
const LF = 0x0a;
const CANDIDATE_STEP_NS = 100n;
const NS_PER_MS = 1_000_000n;

export type CandidateStep = "read-tree" | "apply" | "blob" | "hash";

export type CandidateFailure =
  // UNSUPPORTED_HUNK_PROFILE (contract §4 "Split index").
  | { reason: "split-index" }
  // The canonical index differs from the captured raw index.
  | { reason: "index-changed" }
  // The canonical index or the candidate is above MUTATION_RAW_INDEX_BYTES.
  | { reason: "bound" }
  // `cat-file` answered `<oid> missing` for the captured index blob (contract §7 "Missing objects").
  | { reason: "object-missing" }
  | { reason: "unavailable"; errno: string }
  // Contract §4 "Candidate time": the read-back time is later than the set time.
  | { reason: "candidate-time"; canonicalNs: bigint; candidateNs: bigint }
  // Research R3 steps 9 and 10: the candidate differs from the independent expected result.
  | { reason: "verification"; detail: "content" | "selected-entry" | "unrelated-entries" }
  | { reason: "git-failed"; step: CandidateStep; exitCode: number | null }
  | { reason: "malformed"; step: CandidateStep | "candidate" | "patch" }
  | { reason: "output-limit"; step: CandidateStep }
  | { reason: "deadline"; step: CandidateStep }
  | { reason: "canceled" }
  | { reason: "refused"; code: RefusedCode };

export interface Candidate {
  path: string;
  // The verified raw bytes. Publication writes exactly these bytes.
  bytes: Uint8Array;
  digest: string;
  // The last-write time of the verified candidate, read through the handle before its bytes (contract §4 "Published time").
  mtimeNs: bigint;
}

// `path`: the owned candidate file that the caller removes after its processes stop, or null when none exists.
export type CandidateOutcome = { ok: true; candidate: Candidate } | { ok: false; path: string | null; failure: CandidateFailure };

export interface CandidateTarget {
  runner: GitRunner;
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
  // Data-model §4 `rawIndexDigest` of the approved snapshot. Null: the index did not exist.
  rawIndexDigest: string | null;
  comparison: Pick<RetainedComparison, "entry" | "scope" | "patch">;
  hunk: PatchHunk;
  // Test seam only. Production never sets it. It runs between the time step and its read-back.
  afterCandidateTime?: (path: string) => void | Promise<void>;
}

class Stop {
  constructor(readonly failure: CandidateFailure) {}
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

// The time and the bytes come from one handle, so both belong to one file. The time comes first.
async function timeAndBytes(handle: FileHandle) {
  const { mtimeNs } = await handle.stat({ bigint: true });
  return { mtimeNs, bytes: await readHandleBounded(handle, MUTATION_RAW_INDEX_BYTES) };
}

// The lines of `bytes`, each with its LF. The last line can lack the LF.
function splitLines(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const lf = bytes.indexOf(LF, at);
    const end = lf < 0 ? bytes.length : lf + 1;
    out.push(bytes.subarray(at, end));
    at = end;
  }
  return out;
}

// Research R3 step 9: the result of the hunk on `base`, from its captured line intervals. Null when the hunk does not fit `base`.
// gitformat-diff: ` ` keeps a line, `-` removes it, `+` adds it, and `\` marks the line before it as one without a final LF.
export function applyToContent(base: Uint8Array, hunk: PatchHunk, reverse: boolean): Uint8Array | null {
  const body = splitLines(hunk.bytes).slice(1);
  const before: Uint8Array[] = [];
  const after: Uint8Array[] = [];
  let last: string | null = null;
  for (const line of body) {
    const kind = String.fromCharCode(line[0]!);
    if (kind === "\\") {
      // The marker follows a line that ends without LF. The patch line holds a LF that the content does not hold.
      if (last === null) return null;
      const strip = (list: Uint8Array[]) => list.splice(-1, 1, list.at(-1)!.subarray(0, -1));
      if (last !== "+") strip(before);
      if (last !== "-") strip(after);
      last = null;
      continue;
    }
    if (kind !== " " && kind !== "-" && kind !== "+") return null;
    const text = line.subarray(1);
    if (kind !== "+") before.push(text);
    if (kind !== "-") after.push(text);
    last = kind;
  }
  const [from, to] = reverse ? [after, before] : [before, after];
  const [start, count] = reverse ? [hunk.newStart, hunk.newCount] : [hunk.oldStart, hunk.oldCount];
  if (from.length !== count) return null;
  // xdiff `xdl_emit_hunk_hdr`: a count of 0 prints the line before the change as its start.
  const at = count === 0 ? start : start - 1;
  const lines = splitLines(base);
  if (at + count > lines.length || !from.every((l, i) => sameBytes(l, lines[at + i]!))) return null;
  return Buffer.concat([...lines.slice(0, at), ...to, ...lines.slice(at + count)]);
}

// The six-digit mode of a `new file mode` or `deleted file mode` header line, or null.
function headerMode(header: Uint8Array, kind: "new" | "deleted"): string | null {
  for (const line of latin1(header).split("\n")) {
    const m = /^(new|deleted) file mode ([0-7]{6})$/.exec(line);
    if (m?.[1] === kind) return m[2]!;
  }
  return null;
}

export async function prepareCandidate(t: CandidateTarget): Promise<CandidateOutcome> {
  const w = t.workspace;
  const path = join(dirname(w.indexPath), `${CANDIDATE_PREFIX}${crypto.randomUUID()}`);
  const transaction = { transactionId: crypto.randomUUID(), indexFile: path };
  let created = false;

  // One `mutation` Git step with the §5 Git process deadline.
  async function step(name: CandidateStep, args: string[], stdout: Collector, input: Uint8Array, candidate: boolean): Promise<void> {
    if (t.signal.aborted) throw new Stop({ reason: "canceled" });
    const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    let exit;
    try {
      exit = await t.runner.run({
        operationId: t.operationId,
        context: contextOf(w),
        arguments: args,
        input,
        environmentPolicy: "mutation",
        ...(candidate ? { transaction } : {}),
        limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS },
        stdout,
        stderr,
        signal: t.signal,
      });
    } catch (error) {
      if (error instanceof RunnerRefusal) throw new Stop({ reason: "refused", code: error.code });
      throw error;
    }
    if (t.signal.aborted) throw new Stop({ reason: "canceled" });
    if (exit.deadline !== undefined) throw new Stop({ reason: "deadline", step: name });
    if (exit.diagnosticLimit) throw new Stop({ reason: "output-limit", step: name });
    if (exit.exitCode !== 0) throw new Stop({ reason: "git-failed", step: name, exitCode: exit.exitCode });
  }

  // `cat-file --batch-command -Z` with `contents <oid>`: `<oid> blob <size>` NUL, the content, NUL.
  async function blob(oid: string): Promise<Uint8Array> {
    const out = createCollector({ maxBytes: COMPARED_RAW_VERSION_BYTES + 256 });
    await step("blob", batchCommandArgs(), out, new TextEncoder().encode(`contents ${oid}\0`), false);
    const raw = out.take();
    const head = raw.indexOf(NUL);
    // git-cat-file(1) BATCH OUTPUT: `<object> SP missing`, here ended by NUL.
    if (!out.limited && head === raw.length - 1 && latin1(raw.subarray(0, head)) === `${oid} missing`) throw new Stop({ reason: "object-missing" });
    const m = head < 0 ? null : /^([0-9a-f]+) blob (0|[1-9][0-9]*)$/.exec(latin1(raw.subarray(0, head)));
    const size = Number(m?.[2]);
    if (out.limited || m?.[1] !== oid || raw.length !== head + size + 2 || raw[raw.length - 1] !== NUL) throw new Stop({ reason: "malformed", step: "blob" });
    return raw.subarray(head + 1, head + 1 + size);
  }

  // Research R3 step 6. Returns the canonical entries, or null for an absent index.
  async function copy(): Promise<RawIndexEntry[] | null> {
    let canonical: FileHandle;
    try {
      canonical = await open(w.indexPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if (!isMissing(error)) throw new Stop({ reason: "unavailable", errno: (error as NodeJS.ErrnoException).code ?? "unknown" });
      if (t.rawIndexDigest !== null) throw new Stop({ reason: "index-changed" });
      if (t.signal.aborted) throw new Stop({ reason: "canceled" });
      // Contract §4: an absent index gets its first candidate from Git, never a zero-byte file.
      // The step reply comes after its process ends, so the file state is then final.
      try {
        await step("read-tree", readTreeEmptyArgs(), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }), new Uint8Array(), true);
      } finally {
        created = await lstat(path).then(() => true, (error) => !isMissing(error));
      }
      return null;
    }
    let read: { bytes: Uint8Array | "over"; mtimeNs: bigint };
    try {
      read = await timeAndBytes(canonical);
    } finally {
      await canonical.close();
    }
    const { bytes, mtimeNs: canonicalNs } = read;
    if (bytes === "over") throw new Stop({ reason: "bound" });
    if (t.rawIndexDigest === null || sha256(bytes) !== t.rawIndexDigest) throw new Stop({ reason: "index-changed" });
    if (t.signal.aborted) throw new Stop({ reason: "canceled" });
    const entries = parse(bytes);
    const candidate = await open(path, "wx");
    created = true;
    try {
      await candidate.write(bytes, 0, bytes.length, 0);
      // Contract §4 "Candidate time": 100 ns before the canonical time. Node.js takes the time as a Date or a double.
      // A double cannot hold 100 ns steps of a current time, so the whole millisecond at or before that time is set.
      const target = canonicalNs - CANDIDATE_STEP_NS;
      const time = new Date(Number(target / NS_PER_MS));
      await candidate.utimes(time, time);
      await t.afterCandidateTime?.(path);
      const candidateNs = (await candidate.stat({ bigint: true })).mtimeNs;
      if (candidateNs > target) throw new Stop({ reason: "candidate-time", canonicalNs, candidateNs });
    } finally {
      await candidate.close();
    }
    return entries;
  }

  function parse(bytes: Uint8Array): RawIndexEntry[] {
    let parsed;
    try {
      parsed = rawIndexEntries(bytes, w.objectFormat);
    } catch (error) {
      if (error instanceof IndexFormatError) throw new Stop({ reason: "malformed", step: "candidate" });
      throw error;
    }
    // Contract §4 "Split index": step 6 checks the raw candidate.
    if (parsed.link !== null) throw new Stop({ reason: "split-index" });
    return parsed.entries;
  }

  async function readCandidate(): Promise<{ bytes: Uint8Array; mtimeNs: bigint }> {
    const handle = await open(path, constants.O_RDONLY);
    let read;
    try {
      read = await timeAndBytes(handle);
    } finally {
      await handle.close();
    }
    if (read.bytes === "over") throw new Stop({ reason: "bound" });
    return { bytes: read.bytes, mtimeNs: read.mtimeNs };
  }

  try {
    if (t.signal.aborted) throw new Stop({ reason: "canceled" });
    const { entry, scope } = t.comparison;
    const selected = new Uint8Array(Buffer.from(entry.pathBytes, "base64"));
    const patch = parsePatch(t.comparison.patch, selected);
    if (!patch.ok) throw new Stop({ reason: "malformed", step: "patch" });
    const header = patch.patch.header;

    const copied = await copy();
    const canonicalEntries = copied ?? parse((await readCandidate()).bytes);

    // Research R3 steps 7 and 8: one service-selected hunk, reversed for unstaging.
    const reverse = scope === "head-to-index";
    const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    await step("apply", reverse ? applyCachedReverseArgs() : applyCachedArgs(), out, Buffer.concat([header, t.hunk.bytes]), true);

    // Research R3 step 9: the expected entry from the captured index blob and the hunk line intervals.
    const added = headerMode(header, "new");
    const deleted = headerMode(header, "deleted");
    const indexSide = { mode: entry.modes?.[1] ?? null, oid: entry.oids?.[1] ?? null };
    let base: Uint8Array = new Uint8Array();
    let expected: { mode: string } | null;
    if (scope === "empty-to-untracked") {
      if (added === null) throw new Stop({ reason: "malformed", step: "patch" });
      expected = { mode: added };
    } else if (reverse && deleted !== null) {
      // A staged deletion: the index holds no entry, and unstaging restores the HEAD side.
      expected = { mode: deleted };
    } else {
      if (indexSide.oid === null || indexSide.mode === null || !isObjectId(indexSide.oid, w.objectFormat)) throw new Stop({ reason: "malformed", step: "patch" });
      base = await blob(indexSide.oid);
      // Staging a working deletion, or unstaging an addition, removes the entry.
      expected = (reverse ? added : deleted) !== null ? null : { mode: indexSide.mode };
    }
    const content = applyToContent(base, t.hunk, reverse);
    if (content === null || (expected === null && content.length > 0)) throw new Stop({ reason: "verification", detail: "content" });
    let oid: string | null = null;
    if (expected !== null) {
      const hashOut = createCollector({ maxBytes: 128 });
      await step("hash", entryHashArgs(), hashOut, content, false);
      const raw = hashOut.take();
      oid = latin1(raw.subarray(0, -1));
      if (hashOut.limited || raw[raw.length - 1] !== LF || !isObjectId(oid, w.objectFormat)) throw new Stop({ reason: "malformed", step: "hash" });
    }

    // Research R3 step 10: exact entry checks of the candidate bytes.
    const { bytes, mtimeNs } = await readCandidate();
    const entries = parse(bytes);
    const isSelected = (e: RawIndexEntry) => sameBytes(e.path, selected);
    const want = expected === null ? [] : [{ path: selected, mode: expected.mode, oid: oid!, stage: 0, assumeUnchanged: false, skipWorktree: false, intentToAdd: false }];
    if (!Bun.deepEquals(entries.filter(isSelected), want, true)) throw new Stop({ reason: "verification", detail: "selected-entry" });
    if (!Bun.deepEquals(entries.filter((e) => !isSelected(e)), canonicalEntries.filter((e) => !isSelected(e)), true)) throw new Stop({ reason: "verification", detail: "unrelated-entries" });
    return { ok: true, candidate: { path, bytes, digest: sha256(bytes), mtimeNs } };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, path: created ? path : null, failure: error.failure };
    // The caller removes an owned candidate, so a path never gets lost.
    if (created) return { ok: false, path, failure: { reason: "unavailable", errno: (error as NodeJS.ErrnoException).code ?? "unknown" } };
    throw error;
  }
}
