// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 T030: `applyFiles`, contract Δ4 "File staging" and plan.md D8. Spec FR-034 to FR-040.
// Each file takes the 001 decision and the single-file blob proofs, which run in parallel (plan.md O-17). One candidate, one `update-index`, and one publication cover the set.
// Only `publish()` of the owned index lock writes the canonical index.

import type { ChangeEntry, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { decideFileAction, type FileActionDecision, type UnstagePath, type WorkingFacts } from "../contracts/file-action";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  FILE_FACT_ENTRIES,
  GIT_PROCESS_DEADLINE_MS,
  MULTI_FILE_ACTION_BYTES,
  MULTI_FILE_ACTION_FILES,
  MULTI_FILE_ATTRIBUTE_BYTES,
  MULTI_FILE_PROOF_CONCURRENCY,
  MULTI_FILE_STEP_MS_PER_FILE,
  REGISTERED_DEADLINE_CAP_MS,
  WINDOWS_COMMAND_LINE_UNITS,
} from "../contracts/limits";
import { attributeArgs, objectCheckArgs, statusArgs, updateIndexAddArgs, updateIndexInfoArgs } from "./commands";
import { localFacts, rawRecord, wholeFileRemedy, workingParts } from "./comparison";
import { createTailCollector } from "./discovery";
import { hunkEligibility } from "./eligibility";
import { blobProof, changedSet, indexInfoInput } from "./file-publish";
import { createCollector, firstEnd, isDeadlineStop, RunnerRefusal, stepUnits, type Collector } from "./git-runner";
import { ownedCandidate } from "./hunk-candidate";
import {
  besideIndex,
  candidateRefusal,
  canonicalIndex,
  checkpointRefusal,
  isStop,
  missingObject,
  observePolicy,
  observeState,
  profileRefusal,
  publish,
  refusalOf,
  settled,
  stepOf,
  wholeWorking,
  type Fact,
  type Failure,
  type HunkPublisherOptions,
  type PublicationSession,
  type PublicationStores,
  type PublishContext,
  type Refusal,
  type Stop,
} from "./hunk-publish";
import { contextOf, latin1, objectCheckInput, objectCheckOutcome } from "./read-steps";
import type { Workspace } from "./registration";
import type { ChangeSnapshot, ReadInstallation, WorkingVersion } from "./snapshot";
import type { StatusCut, WorkspaceReader } from "./status";
import { createStatusParser, type StatusRecord } from "./status-parser";
import { parseAttributes } from "./support";
import type { TrustListing } from "./trust";
import type { WslWhole } from "./wsl-files";

const NUL = Uint8Array.of(0);
const SLASH = Uint8Array.of(0x2f);
const EMPTY = new Uint8Array();
const STALE: Refusal = { code: "STALE_SELECTION" };
const CANCELED: Stop = { stop: "canceled" };
// Contract Δ9 `WORKBENCH_UNAVAILABLE` reason `limit` (spec FR-040).
const LIMIT = { code: "WORKBENCH_UNAVAILABLE", result: { reason: "limit" } } as const;
// git-cat-file(1) BATCH OUTPUT: `<oid> SP <type> SP <size> LF`. A 64-digit object ID, a type of at most 6 letters, and a 64-bit size give 93 bytes.
const CHECK_LINE_BYTES = 93;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type ApplyFilesRequest = Extract<ServiceRequest, { operation: "applyFiles" }>;
type Rejection = { code: ErrorCode; result?: unknown };
type Snapshot = ChangeSnapshot & { entries: ChangeEntry[]; cut: StatusCut };
type Accepted = Extract<FileActionDecision, { direction: "stage" | "unstage" }>;
type Whole = { size: number; sha256: string };

interface FileItem {
  entry: ChangeEntry;
  path: Uint8Array;
  action: Accepted;
  facts: WorkingFacts;
  attributes: Readonly<Record<string, string>>;
  // Contract Δ4 step 3: the whole working file of a `stage` entry. Null: an absent file, or `unstage`.
  working: Whole | null;
}

interface Admitted {
  // A file set binds no single entry. Reconciliation reads no working version, so the empty path names no file.
  approval: { binding: { head: Snapshot["head"]; index: NonNullable<Snapshot["indexFingerprint"]>; operationState: Snapshot["operationState"]; policyFingerprint: string; entry: { pathBytes: ""; category: "unstaged" } } };
  direction: "stage" | "unstage";
  items: FileItem[];
  snapshot: Snapshot;
}

export interface MultiPublisherOptions extends HunkPublisherOptions, PublicationStores {
  reader: Pick<WorkspaceReader, "operationState" | "selection">;
}

const pathOf = (e: Pick<ChangeEntry, "pathBytes">) => new Uint8Array(Buffer.from(e.pathBytes, "base64"));
const startsWith = (bytes: Uint8Array, prefix: Uint8Array) => bytes.length > prefix.length && Buffer.compare(bytes.subarray(0, prefix.length), prefix) === 0;
const refusalOrStop = (f: Failure | Stop): Refusal | Stop => (isStop(f) ? f : refusalOf(f));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

// The whole working file of a read, as `differs` reads it.
function wholeOf(read: Fact<WorkingVersion | WslWhole> | { changed: true }): Fact<Whole | "absent" | "other"> | { changed: true } {
  if ("changed" in read || !("value" in read)) return read;
  const v = read.value;
  return { value: typeof v === "string" || !("exists" in v) ? v : !v.exists ? "absent" : v.type === "file" ? { size: v.size, sha256: v.rawDigest } : "other" };
}

// Plan.md O-17: the deadline of a step for `files` paths. Contract §6 `limits` caps every registered deadline.
const stepDeadline = (files: number) => Math.min(GIT_PROCESS_DEADLINE_MS + files * MULTI_FILE_STEP_MS_PER_FILE, REGISTERED_DEADLINE_CAP_MS);

// Plan.md O-17: `work` for each index, with at most MULTI_FILE_PROOF_CONCURRENCY calls at once. The first non-null result aborts `stop`, and no later index starts.
// It returns after every started call ends, so no process of the set outlives it. A throw ends the run the same way and then propagates.
async function firstOf<T>(count: number, stop: AbortController, work: (i: number) => Promise<T | null>): Promise<T | null> {
  let next = 0;
  let first = null as T | null;
  let failure = null as { error: unknown } | null;
  const lane = async () => {
    while (first === null && failure === null && next < count) {
      const i = next++;
      try {
        const result = await work(i);
        if (result !== null) {
          // 001 contract §5 "Deadline outcomes": a later deadline replaces an earlier result, which can come from the Job close of that deadline.
          const earlier = first;
          first = firstEnd([first, result], isDeadlineStop);
          if (earlier === null) stop.abort();
        }
      } catch (error) {
        failure ??= { error };
        stop.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MULTI_FILE_PROOF_CONCURRENCY, count) }, lane));
  if (failure !== null) throw failure.error;
  return first;
}

// The context of one pooled run: its signal also ends when the run stops.
const pooledContext = (ctx: PublishContext, stop: AbortController): PublishContext => ({ ...ctx, signal: AbortSignal.any([ctx.signal, stop.signal]) });

// The context of one pooled call. `stepOf` checks the signal first, so a run stop after the deadline of the call gives `canceled`.
// `expired` keeps that deadline from the exit reply (001 contract §5 "Deadline outcomes").
function expiring(ctx: PublishContext): PublishContext & { expired: boolean } {
  const own = { ...ctx, expired: false };
  own.runner = { ...ctx.runner, run: (call) => ctx.runner.run(call).then((exit) => ((own.expired ||= exit.deadline !== undefined), exit)) };
  return own;
}

// The git-status(1) porcelain v2 fields of a record, as one comparable key.
const recordKey = (r: StatusRecord): string =>
  JSON.stringify(!("xy" in r) ? [r.kind, b64(r.path.bytes)] : [r.kind, r.xy, r.submodule, r.modes, r.oids, ...(r.kind === "rename" ? [r.score, b64(r.originalPath.bytes)] : []), b64(r.path.bytes)]);
const entryKey = (e: ChangeEntry): string =>
  JSON.stringify(
    e.category === "untracked"
      ? ["untracked", e.pathBytes]
      : [e.category === "conflicted" ? "unmerged" : e.score === undefined ? "ordinary" : "rename", e.xy, e.submodule, e.modes, e.oids, ...(e.score === undefined ? [] : [e.score, e.sourcePathBytes]), e.pathBytes],
  );

export function createMultiPublisher(o: MultiPublisherOptions) {
  const { registry } = o;
  // Contract Δ2: the repeat key of `applyFiles` is its approval key. It maps to the operation that consumed it.
  const consumed = new Map<string, string>();

  // Data-model §6 and contract Δ4: the shown entries of the selection. Memory only, so no Git process starts.
  function select(request: ApplyFilesRequest, w: Workspace): { snapshot: Snapshot; entries: ChangeEntry[] } | Rejection {
    const { snapshotId, entryIds, direction, kind, folder } = request.payload;
    const found = o.reader.selection(w.repositoryId, w.generation, snapshotId);
    if (!found.ok) return { code: found.code };
    const s = found.snapshot;
    // Contract §5: a mutation needs a complete index snapshot.
    if (s.indexFingerprint === null || s.policyFingerprint === null) {
      const c = s.completeness;
      return c.state === "limited" ? { code: c.code, ...(c.code === "OUTPUT_LIMIT" ? { result: { reason: c.reason } } : {}) } : { code: "MALFORMED_GIT_OUTPUT" };
    }
    // Data-model §6: every entry comes from one list. Stage takes the Changes list, and unstage takes the Staged list.
    const inList = (e: ChangeEntry) => (direction === "unstage") === (e.category === "staged");
    const byId = new Map(s.entries.map((e) => [e.entryId, e]));
    const picked = entryIds.map((id) => byId.get(id));
    if (picked.some((e) => e === undefined)) return { code: "UNKNOWN_TARGET" };
    if (!picked.every((e) => inList(e!))) return { code: "INVALID_REQUEST" };
    let entries = picked as ChangeEntry[];
    if (kind !== "selected") {
      // Contract Δ4 "Status cut": a cut read lacks untracked entries, so a set that the Changes list derives would stage a part (spec FR-040).
      if (s.cut === "untracked" && direction === "stage") return LIMIT;
      const prefix = folder === undefined ? null : Buffer.concat([Buffer.from(folder, "base64"), SLASH]);
      // Plan.md D8: the entries of the list in the shown read. A folder takes the paths below `<folder>/`.
      const derived = s.entries.filter((e) => inList(e) && (kind === "all-untracked" ? e.category === "untracked" : prefix === null || startsWith(pathOf(e), prefix)));
      if (derived.length > MULTI_FILE_ACTION_FILES) return LIMIT;
      const ids = new Set(entryIds);
      if (derived.length !== ids.size || !derived.every((e) => ids.has(e.entryId))) return { code: "INVALID_REQUEST" };
      entries = derived;
    }
    // Data-model §7: an unfinished operation refuses at acceptance. `unknown` decides at the checkpoints.
    if (s.operationState === "conflicted") return { code: "CONFLICTED" };
    if (s.operationState !== "normal" && s.operationState !== "unknown") return { code: "OPERATION_IN_PROGRESS" };
    return { snapshot: s, entries };
  }

  // One `check-attr` for every path (contract Δ5 `MULTI_FILE_ATTRIBUTE_BYTES`).
  async function attributesOf(ctx: PublishContext, paths: readonly Uint8Array[]): Promise<Fact<Readonly<Record<string, string>>[]>> {
    const out = createCollector({ maxBytes: MULTI_FILE_ATTRIBUTE_BYTES });
    const step = await stepOf(ctx, attributeArgs(), out, Buffer.concat(paths.flatMap((p) => [p, NUL])));
    if (!("exit" in step)) return step;
    if (out.limited) return { code: "OUTPUT_LIMIT", reason: "MULTI_FILE_ATTRIBUTE_BYTES" };
    const parsed = step.exit.exitCode === 0 ? parseAttributes(out.take(), paths) : null;
    if (parsed === null) return { code: step.exit.exitCode === 0 ? "MALFORMED_GIT_OUTPUT" : "GIT_FAILED" };
    return { value: parsed };
  }

  // Data-model §5 path rule and contract §4 "File staging": the working facts of each entry, as `readComparison` reads them.
  async function factsOf(ctx: PublishContext, s: Snapshot, entries: readonly ChangeEntry[], listing: Pick<TrustListing, "entries">): Promise<WorkingFacts[] | Refusal | Stop> {
    const w = ctx.workspace;
    const parts = entries.map((e) => workingParts(w, pathOf(e), listing.entries));
    const facts: WorkingFacts[] = parts.map((p) => (p.parts === null ? { type: "absent" } : { type: "unreadable" }));
    const read = entries.map((_, i) => i).filter((i) => parts[i]!.parts !== null && !parts[i]!.unreadable);
    if (w.wsl === undefined) {
      // `localFacts` checks only the other stage-0 paths with the same component count and lengths, so this map keeps only those.
      const shape = (text: string) => text.split("/").map((p) => p.length).join(",");
      const byShape = new Map<string, Uint8Array[]>();
      for (const x of s.indexEntries) {
        if (x.stage !== 0) continue;
        let text: string;
        try {
          text = utf8.decode(x.path);
        } catch {
          continue;
        }
        byShape.set(shape(text), [...(byShape.get(shape(text)) ?? []), x.path]);
      }
      for (const i of read) {
        const e = entries[i]!;
        const path = pathOf(e);
        const others = e.category === "untracked" ? [] : (byShape.get(shape(parts[i]!.parts!.join("/"))) ?? []).filter((x) => Buffer.compare(x, path) !== 0);
        facts[i] = await localFacts(w.worktreeRoot, parts[i]!.parts!, others);
      }
      return facts;
    }
    // Contract §11 "Paths and file access": `wslFiles` mode `digest` holds 1 to 64 entries. `changed` reads once more, as `readComparison` does.
    let pending = read;
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      const again: number[] = [];
      for (let at = 0; at < pending.length; at += FILE_FACT_ENTRIES) {
        const chunk = pending.slice(at, at + FILE_FACT_ENTRIES);
        let results;
        try {
          results = await ctx.runner.wslFiles({ operationId: ctx.operationId, ...contextOf(w), mode: "digest", bound: "COMPARED_RAW_VERSION_BYTES", files: chunk.map((i) => ({ root: "worktreeRoot", path: parts[i]!.parts! })) }, ctx.signal);
        } catch (error) {
          if (error instanceof RunnerRefusal) return { code: error.code };
          throw error;
        }
        if (!Array.isArray(results)) return { stop: results.stop };
        if (results.length !== chunk.length) return { code: "MALFORMED_GIT_OUTPUT" };
        for (const [k, r] of results.entries()) {
          const i = chunk[k]!;
          const diskPath = pathOf(entries[i]!);
          if (r.kind === "file" && r.changed) again.push(i);
          else if (r.kind === "file") facts[i] = { type: "file", size: r.size, diskPath };
          else if (r.kind === "directory" || r.kind === "other") facts[i] = { type: r.kind, diskPath };
          // diff-lib.c `check_removed`: a link before the last component counts as removed.
          else if (r.kind === "link") facts[i] = r.component === parts[i]!.parts!.length ? { type: "symlink", diskPath } : { type: "absent" };
          else if (r.kind === "absent") facts[i] = { type: "absent" };
          else facts[i] = { type: "unreadable" };
        }
      }
      pending = again;
    }
    return pending.length > 0 ? { code: "REPOSITORY_CHANGED" } : facts;
  }

  // Contract Δ4: the 001 file-action decision of each entry must accept the direction. Spec FR-038: one refusal names the entry and refuses the set.
  async function decide(ctx: PublishContext, request: ApplyFilesRequest, s: Snapshot, entries: readonly ChangeEntry[]): Promise<FileItem[] | Refusal | Stop> {
    const w = ctx.workspace;
    const { direction } = request.payload;
    const policy = await observePolicy(ctx, null);
    if (!("listing" in policy)) return refusalOrStop(policy);
    if (policy.gate !== null) return { code: policy.gate };
    if (policy.policyFingerprint !== s.policyFingerprint) return { code: "TRUST_CHANGED" };
    // `check-attr` reads the index, so a command-valued `core.fsmonitor` would run. The profile decides first, as `observePolicy` does.
    const eligibility = hunkEligibility({ link: null }, w.objectFormat, policy.listing, w.wsl !== undefined);
    if (!eligibility.eligible) return profileRefusal(eligibility.reason);
    const paths = entries.map(pathOf);
    const attributes = await attributesOf(ctx, paths);
    if (!("value" in attributes)) return refusalOrStop(attributes);
    const facts = await factsOf(ctx, s, entries, policy.listing);
    if (!Array.isArray(facts)) return facts;
    const headUnborn = s.head.state === "unborn";
    const items: FileItem[] = [];
    let bytes = 0;
    for (const [i, entry] of entries.entries()) {
      // Contract §4 "Comparison limits": without index flags no decision is exact. A snapshot with a fingerprint keeps every flag.
      if (entry.category !== "conflicted" && entry.flags === undefined) return { code: "MALFORMED_GIT_OUTPUT" };
      const indexFlags = entry.flags ?? { intentToAdd: false, assumeUnchanged: false, skipWorktree: false };
      const decision = decideFileAction({ category: entry.category, record: rawRecord(entry, paths[i]!), headUnborn, indexFlags, attributes: attributes.value[i]!, working: facts[i]! });
      if (decision.direction === null) return { code: decision.code, ...(decision.code === "UNSUPPORTED_COMPARISON" ? { reason: decision.reason } : {}), entryId: entry.entryId };
      if (decision.direction !== direction) return { code: "INVALID_REQUEST", entryId: entry.entryId };
      const f = facts[i]!;
      if (direction === "stage" && f.type === "file") bytes += f.size;
      items.push({ entry, path: paths[i]!, action: decision, facts: f, attributes: attributes.value[i]!, working: null });
    }
    // Contract Δ5 `MULTI_FILE_ACTION_BYTES`: the working bytes of the set.
    if (bytes > MULTI_FILE_ACTION_BYTES) return { code: LIMIT.code, reason: LIMIT.result.reason };
    return items;
  }

  // Contract Δ4 step 7: the status records of exactly the paths of the set. A rename keeps its source path in the same process.
  async function sameEntries(ctx: PublishContext, installation: ReadInstallation, a: Admitted): Promise<boolean | Refusal | Stop> {
    const w = ctx.workspace;
    const groups = a.items.map((item) => [item.path, ...(item.entry.sourcePathBytes === undefined ? [] : [pathOf({ pathBytes: item.entry.sourcePathBytes })])]);
    const wanted = new Set(groups.flat().map(latin1));
    const args = (batch: string[]) => [...statusArgs(), "--", ...batch];
    // Contract §6: each process stays inside the command-line bound.
    const units = (list: string[]) => stepUnits({ operationId: ctx.operationId, workspace: w, installation }, "read", args(list));
    const batches: string[][] = [];
    for (const group of groups) {
      const texts = group.map((p) => utf8.decode(p));
      const last = batches.at(-1);
      if (last !== undefined && units([...last, ...texts]) <= WINDOWS_COMMAND_LINE_UNITS) last.push(...texts);
      else if (units(texts) <= WINDOWS_COMMAND_LINE_UNITS) batches.push(texts);
      else return { code: "WORKBENCH_UNAVAILABLE", reason: "path", entryId: a.items[groups.indexOf(group)]!.entry.entryId };
    }
    const fresh = new Set<string>();
    for (const batch of batches) {
      const parser = createStatusParser(w.objectFormat);
      let size = 0;
      const out: Collector = {
        push(chunk) {
          size += chunk.length;
          parser.push(chunk);
        },
        get bytes() {
          return size;
        },
        records: 0,
        get limited() {
          return parser.limited;
        },
      };
      const step = await stepOf(ctx, args(batch), out, undefined, stepDeadline(batch.length));
      if (!("exit" in step)) return refusalOrStop(step);
      const parsed = parser.end();
      if (parsed.state === "limited") return { code: "OUTPUT_LIMIT", reason: parsed.reason };
      if (step.exit.exitCode !== 0) return refusalOf({ code: "GIT_FAILED" });
      if (parsed.state === "failed") return { code: "MALFORMED_GIT_OUTPUT" };
      // A literal pathspec also matches paths below a folder of that name, so only the exact paths count.
      for (const r of parsed.records) if (wanted.has(latin1(r.path.bytes)) || (r.kind === "rename" && wanted.has(latin1(r.originalPath.bytes)))) fresh.add(recordKey(r));
    }
    const shown = new Set(
      a.snapshot.entries.filter((e) => wanted.has(latin1(pathOf(e))) || (e.sourcePathBytes !== undefined && wanted.has(latin1(pathOf({ pathBytes: e.sourcePathBytes }))))).map(entryKey),
    );
    return fresh.size === shown.size && [...fresh].every((k) => shown.has(k));
  }

  // Contract Δ4 steps 3 to 7 under the lock.
  async function prepare(a: Admitted, { ctx, rec, run }: PublicationSession, installation: ReadInstallation): Promise<Refusal | Stop | null> {
    const { workspace: w, signal, operationId } = ctx;
    const binding = a.approval.binding;
    const stage = a.direction === "stage";
    const paths = a.items.map((item) => item.path);
    let bound = false;

    // Contract §4 steps 3 and 7 with the §9 checkpoint order. Step 3 binds each working file, and step 7 compares it.
    const checkpoint = async (step7: boolean): Promise<Refusal | Stop | null> => {
      const policy = await observePolicy(ctx, null);
      if ("listing" in policy) run.listing = policy.listing;
      const state = await observeState(ctx, EMPTY, false, canonicalIndex(ctx, binding.index));
      const refused = checkpointRefusal({ ...binding, working: null, attributes: {} }, policy, state, w.objectFormat, w.wsl !== undefined);
      if (refused !== null) return refused;
      const attributes = await attributesOf(ctx, paths);
      if (!("value" in attributes)) return refusalOrStop(attributes);
      if (!attributes.value.every((value, i) => Bun.deepEquals(value, a.items[i]!.attributes, true))) return STALE;
      if (step7) {
        const same = await sameEntries(ctx, installation, a);
        if (same !== true) return same === false ? STALE : same;
      }
      if (!stage) return null;
      const stop = new AbortController();
      const pooled = pooledContext(ctx, stop);
      const digested = await firstOf(a.items.length, stop, async (i): Promise<Refusal | Stop | null> => {
        const item = a.items[i]!;
        const read = wholeOf(await settled(pooled.signal, wholeWorking(pooled, item.path)));
        if ("changed" in read) return STALE;
        if (!("value" in read)) return refusalOrStop(read);
        const v = read.value;
        if (!bound) {
          // The step 3 file must have the type and size of the decision facts.
          const absent = item.facts.type === "absent";
          if (absent ? v !== "absent" : v === "absent" || v === "other" || item.facts.type !== "file" || v.size !== item.facts.size) return STALE;
          item.working = absent ? null : (v as Whole);
        } else if (item.working === null ? v !== "absent" : v === "absent" || v === "other" || v.size !== item.working.size || v.sha256 !== item.working.sha256) return STALE;
        return null;
      });
      if (digested !== null) return digested;
      bound = true;
      return null;
    };

    registry.progress(operationId, "preflight");
    const first = await checkpoint(false);
    if (first !== null) return first;
    registry.progress(operationId, "candidate-verification");
    const owned = ownedCandidate({ runner: rec, operationId, signal, workspace: w, rawIndexDigest: binding.index.rawIndexDigest });
    const tail = createTailCollector("plain");
    let staged: (string | null)[] = [];
    let refusedItem: number | undefined;
    const prepared = await owned.settle(async () => {
      const canonical = (await owned.copy()) ?? owned.parse((await owned.readCandidate()).bytes);
      // Contract Δ4 step 5: every path on one stdin, or the HEAD entry of every changed path.
      const input = stage ? Buffer.concat(paths.flatMap((p) => [p, NUL])) : indexInfoInput(a.items.flatMap((item) => item.action.changedPaths as UnstagePath[]));
      await owned.step("update-index", stage ? updateIndexAddArgs() : updateIndexInfoArgs(), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }), input, true, tail, stepDeadline(a.items.length));
      await o.hunkCheckpoint?.({ step: 5, operationId });
      if (signal.aborted) return owned.fail({ reason: "canceled" });
      const read = await owned.readCandidate();
      const expected = a.items.map((item) => ({ action: item.action, mode: item.entry.category === "untracked" ? null : item.entry.modes![2]!, deletion: stage && item.working === null, objectFormat: w.objectFormat }));
      const checked = changedSet(expected, owned.parse(read.bytes), canonical);
      if ("detail" in checked) {
        refusedItem = checked.index;
        return owned.fail({ reason: "verification", detail: checked.detail });
      }
      staged = checked.staged;
      const oids = [...new Set(staged.filter((oid): oid is string => oid !== null))];
      if (oids.length > 0) {
        const out = createCollector({ maxBytes: oids.length * CHECK_LINE_BYTES });
        await owned.step("check", objectCheckArgs(), out, objectCheckInput(oids), false);
        // `step` throws for every exit other than 0.
        if (objectCheckOutcome({ exit: { exitCode: 0, activeDescendants: 0 } }, out, oids) !== "present") return owned.fail({ reason: "verification", detail: "selected-entry" });
      }
      return read;
    });
    run.executionLast = rec.execution ?? 0;
    if (!prepared.ok) {
      run.candidatePath = prepared.path === null ? null : besideIndex(w, prepared.path);
      const refused = candidateRefusal(prepared.failure);
      const named = (r: Refusal | Stop): Refusal | Stop => (isStop(r) || refusedItem === undefined ? r : { ...r, entryId: a.items[refusedItem]!.entry.entryId });
      if (!("check" in refused)) return named(refused);
      // Contract §7 "Missing objects": no single index object names the set, so a failed step without a promisor remote gives the step failure.
      const checked = await missingObject(ctx, run.listing, undefined, refused.check);
      const f = prepared.failure;
      if (f.reason === "git-failed" && f.step === "update-index" && !isStop(checked) && checked.code === "GIT_FAILED") return { ...checked, outputTail: tail.outputTail() };
      return checked;
    }
    run.candidate = prepared.candidate;
    run.candidatePath = besideIndex(w, prepared.candidate.path);
    if (stage) {
      const headUnborn = binding.head.state === "unborn";
      // Each proof reads only its own verified bytes and its staged object, so the proofs run in parallel (plan.md O-17).
      const proved = a.items.flatMap((item, i) => {
        const oid = staged[i];
        return typeof oid === "string" && item.working !== null ? [{ item, oid, working: item.working }] : [];
      });
      const stop = new AbortController();
      const pooled = pooledContext(ctx, stop);
      let done = 0;
      const proof = await firstOf(proved.length, stop, async (k): Promise<Refusal | Stop | null> => {
        const { item, oid, working } = proved[k]!;
        const own = expiring(pooled);
        const held = await blobProof(own, item.path, oid, working, wholeFileRemedy({ entry: item.entry, workspace: w, installation, headUnborn }, item.path));
        if (held === null) {
          registry.progress(operationId, "stage-files", { fileIndex: ++done, fileCount: proved.length });
          return null;
        }
        if (isStop(held)) return own.expired ? { stop: "deadline" } : held;
        return { ...held, entryId: item.entry.entryId };
      });
      run.executionLast = rec.execution ?? 0;
      if (proof !== null) return proof;
    }
    // Contract Δ4 step 7.
    const second = await checkpoint(true);
    if (second !== null) return second;
    await o.hunkCheckpoint?.({ step: 11, operationId });
    return signal.aborted ? CANCELED : null;
  }

  // Contract §4 "Blob proof": after publication, a new digest of each working file decides the working-file effect. `unstage` reads no working file.
  async function working(a: Admitted, ctx: PublishContext): Promise<Fact<boolean>> {
    if (a.direction === "unstage") return { value: false };
    for (const item of a.items) {
      const read = wholeOf(await wholeWorking(ctx, item.path));
      if ("changed" in read) return { value: true };
      if (!("value" in read)) return read;
      const v = read.value;
      if (item.working === null ? v !== "absent" : v === "absent" || v === "other" || v.size !== item.working.size || v.sha256 !== item.working.sha256) return { value: true };
    }
    return { value: false };
  }

  function applyFiles(request: ApplyFilesRequest, w: Workspace, installation: ReadInstallation): void {
    const { snapshotId, entryIds, direction } = request.payload;
    // Contract Δ3: the approval key `{kind: "files", snapshotId, entryIds digest, direction}`.
    const key = `files/${snapshotId}/${new Bun.CryptoHasher("sha256").update(entryIds.join("\n")).digest("hex")}/${direction}`;
    // Contract §2: a consumed key answers a repeat with its operation, without an accepted event or a process.
    const earlier = consumed.get(key);
    if (earlier !== undefined && o.owners.get(earlier) === request.repositoryId) {
      return void o.respond({ requestId: request.requestId, operationId: earlier, state: "succeeded", result: registry.get(earlier) });
    }
    const { operationId, signal } = registry.start("applyFiles", request.requestId);
    const selected = select(request, w);
    if ("code" in selected) return void registry.apply(operationId, { type: "invalid-approval", code: selected.code }, selected.result);
    const ctx: PublishContext = { runner: o.runner, trust: o.trust, reader: o.reader, operationId, signal, workspace: w, installation };
    void (async () => {
      let items: FileItem[] | Refusal | Stop;
      try {
        items = await decide(ctx, request, selected.snapshot, selected.entries);
      } catch {
        items = { code: "GIT_FAILED" };
      }
      if (!Array.isArray(items)) {
        if (isStop(items)) return void registry.apply(operationId, { type: "invalid-approval", code: items.stop === "deadline" ? "DEADLINE" : "CANCELED" });
        const { code, cause: _cause, ...result } = items;
        return void registry.apply(operationId, { type: "invalid-approval", code }, Object.keys(result).length > 0 ? result : undefined);
      }
      const s = selected.snapshot;
      const admitted: Admitted = {
        approval: { binding: { head: s.head, index: s.indexFingerprint!, operationState: s.operationState, policyFingerprint: s.policyFingerprint!, entry: { pathBytes: "", category: "unstaged" } } },
        direction,
        items,
        snapshot: s,
      };
      const claim = {
        consume: (id: string) => {
          if (consumed.has(key)) return false;
          consumed.set(key, id);
          return true;
        },
        refusal: (): ErrorCode => "UNKNOWN_TARGET",
      };
      await publish(o, request, w, installation, operationId, signal, claim, admitted, { prepare: (x, session) => prepare(x, session, installation), working: (x, q) => working(x, q) });
    })();
  }

  return { applyFiles };
}
