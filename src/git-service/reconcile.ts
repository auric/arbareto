// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T113: commit reconciliation after handoff, research R4, contract §4 "Commit validation and handoff", §8, and §9.
// It never retries, resets, amends, or undoes. A commit binds no working file, so `effects.workingFiles` is false (contract §8).

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, HISTORY_COMMIT_OBJECT_BYTES, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS, SUBMODULE_REVIEW_SUBMODULES, TRUST_INPUT_BYTES } from "../contracts/limits";
import type { OperationEvent } from "../contracts/outcome";
import type { SubmoduleFailedRead, SubmoduleRowResult } from "../contracts/submodules";
import type { CommitBinding } from "./approvals";
import { attribute, readWindow, type Attribution, type ReflogRecord, type Window } from "./attribution";
import {
  batchCommandArgs,
  commitTreeArgs,
  indexEntryArgs,
  isObjectId,
  isOneLevelRefName,
  submoduleConfigListArgs,
  submoduleGitDirArgs,
  submoduleHeadOidArgs,
  submoduleHeadTargetArgs,
  submoduleHeadTargetNoRecurseArgs,
  submoduleRefExistsArgs,
  submoduleRefFormatArgs,
  type ObjectFormat,
  type SubmoduleLocation,
} from "./commands";
import type { RetainedReview } from "./commit-review";
import { IndexFormatError, rawIndexEntries } from "./eligibility";
import { createCollector, type GitExit, type GitRunner } from "./git-runner";
import { HEADER_BYTES, parseCommitObjects } from "./history-parser";
import { canonicalIndex, diagnosticCause, enterReconciling, observedLocks, observeState, settled, stepOf, type Fact, type Failure, type IndexFacts, type ObserveContext, type PublishContext, type Stop } from "./hunk-publish";
import type { DiagnosticCause, EffectSummary } from "./log";
import type { OperationRegistry } from "./operations";
import { isMissing, latin1 } from "./read-steps";
import type { Head, IndexEntry, OperationState } from "./snapshot";
import { parseIndexListing } from "./status";
import { REFUSAL_TEXTS } from "./submodule-review";
import { keyParts, parseConfigListing, requestFacts, type ConfigEntry } from "./trust";
import type { WslIndexFacts } from "./wsl-files";

const NUL = 0x00;
const TAB = 0x09;
const EMPTY = new Uint8Array(0);
const NO_RECORDS: Fact<Window> = { value: { records: [] } };
const NO_ENTRIES = { link: null, entries: [] };
// Contract §8 "Observed locks": `commit` names at most 4 files.
const COMMIT_FOREIGN_CAP = 4;

type Remedy = { text: string; command?: string | null };

export interface CommitReconciliation {
  registry: OperationRegistry;
  runner: Pick<GitRunner, "resolved" | "lingeringCount">;
  retained: Pick<Map<string, unknown>, "delete">;
  operationId: string;
  markerId: string;
  ctx: PublishContext;
  review: RetainedReview;
  binding: Pick<CommitBinding, "head" | "reviewedIndex" | "operationState">;
  // The preflight tip (contract §8 "Attribution window").
  tip: ReflogRecord | null;
  // Null: the commit process gave no exit reply.
  exit: GitExit | null;
  outputTail: string;
  foreign: string[];
  // Contract §9: the remedy of a failed outcome. `gitFailed`: the outcome code is GIT_FAILED. Null: no remedy.
  remedy: (lingering: number | null, otherLocks: boolean, gitFailed: boolean) => Remedy | null;
}

interface TreeEntry {
  path: Uint8Array;
  mode: string;
  oid: string;
}

// git-ls-tree(1) OUTPUT: `<mode> SP <type> SP <object> TAB <file>`. With `-r` and without `-t`, only blob and commit entries print.
const TREE_FIELDS = /^([0-7]{6}) (blob|commit) ([0-9a-f]+)$/;

function parseTree(bytes: Uint8Array, objectFormat: ObjectFormat): TreeEntry[] | null {
  const entries: TreeEntry[] = [];
  for (let at = 0; at < bytes.length; ) {
    const end = bytes.indexOf(NUL, at);
    const tab = bytes.indexOf(TAB, at);
    if (end < 0 || tab < 0 || tab >= end - 1) return null;
    const fields = TREE_FIELDS.exec(latin1(bytes.subarray(at, tab)));
    if (fields === null || !isObjectId(fields[3]!, objectFormat)) return null;
    entries.push({ mode: fields[1]!, oid: fields[3]!, path: bytes.subarray(tab + 1, end) });
    at = end + 1;
  }
  return entries;
}

// Contract §5 "Status or index listing" bounds this read. Every record ends with NUL.
export async function listingOf<T>(ctx: ObserveContext, args: string[], parse: (bytes: Uint8Array) => T | null): Promise<Fact<T>> {
  const out = createCollector({ maxBytes: STATUS_LISTING_BYTES, maxRecords: STATUS_LISTING_RECORDS, separator: NUL });
  const step = await stepOf(ctx, args, out);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const bytes = out.take();
  const parsed = bytes.length === 0 || bytes[bytes.length - 1] === NUL ? parse(bytes) : null;
  return parsed === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: parsed };
}

// The `parent` headers of one commit object. Contract §5 "History commit object" bounds the read.
export async function parentsOf(ctx: ObserveContext, oid: string): Promise<Fact<string[]>> {
  const out = createCollector({ maxBytes: HISTORY_COMMIT_OBJECT_BYTES + HEADER_BYTES + 2 });
  const step = await stepOf(ctx, batchCommandArgs(), out, new TextEncoder().encode(`contents ${oid}\0`));
  if (!("exit" in step)) return step;
  const parsed = parseCommitObjects(out.take(), [oid], ctx.workspace.objectFormat);
  const c = parsed.completeness;
  if (c.state !== "complete") return { code: c.code };
  return step.exit.exitCode === 0 ? { value: parsed.objects[0]!.parents } : { code: "GIT_FAILED" };
}

const sameEntries = <E extends { path: Uint8Array }>(a: readonly E[], b: readonly E[]) =>
  a.length === b.length && a.every((e, i) => Buffer.compare(e.path, b[i]!.path) === 0 && Bun.deepEquals({ ...e, path: null }, { ...b[i]!, path: null }, true));

// Git writes the index again during `commit` (research R4), so the logical entries decide. Stat data never counts.
// A WSL review keeps no raw index (contract §11 "Paths and file access"), so a changed WSL digest goes to the listing.
async function sameIndex(ctx: ObserveContext, review: RetainedReview, reviewedDigest: string | null, observed: IndexFacts | WslIndexFacts): Promise<Fact<boolean>> {
  if (observed.digest === reviewedDigest) return { value: true };
  const objectFormat = ctx.workspace.objectFormat;
  if (!("reply" in observed)) {
    let before, after;
    try {
      before = review.rawIndex === null ? NO_ENTRIES : rawIndexEntries(review.rawIndex, objectFormat);
      after = observed.raw === null ? NO_ENTRIES : rawIndexEntries(observed.raw, objectFormat);
    } catch (error) {
      if (error instanceof IndexFormatError) return { code: "MALFORMED_GIT_OUTPUT" };
      throw error;
    }
    if (before.link === null && after.link === null) return { value: sameEntries(before.entries, after.entries) };
  }
  // ponytail: a split index and a WSL index compare Git's `ls-files -v` listing, which shows no intent-to-add flag. Read the index when that flag must count.
  const listed = await listingOf(ctx, indexEntryArgs(), (bytes) => parseIndexListing(bytes, objectFormat));
  if (!("value" in listed)) return listed;
  return { value: sameEntries(review.entries.map(({ intentToAdd: _, ...e }) => e), listed.value) };
}

const byPath = (a: { path: Uint8Array }, b: { path: Uint8Array }) => Buffer.compare(a.path, b.path);

// Contract §4: the tree of the created commit against the reviewed stage-0 entries. An intent-to-add entry enters no tree.
function sameTree(tree: readonly TreeEntry[], entries: readonly IndexEntry[]): boolean {
  const reviewed = entries.filter((e) => e.stage === 0 && !e.intentToAdd).map(({ path, mode, oid }) => ({ path, mode, oid }));
  return sameEntries(reviewed.sort(byPath), [...tree].sort(byPath));
}

// A commit lands where HEAD pointed: the same branch, also from an unborn HEAD, or a detached HEAD.
const sameDestination = (h0: Head, h1: Head) => (h0.state === "detached" ? h1.state === "detached" : h1.state === "branch" && h1.target === h0.target);

export interface CommitFacts {
  attribution: Exclude<Attribution, { unknown: unknown }>;
  reviewed: Head;
  observed: Head;
  // The tree of the identified commit equals the reviewed entries. Without an identified commit, it is not read.
  treeEqual: boolean;
  indexEqual: boolean;
  stateEqual: boolean;
  canceled: boolean;
  deadline: boolean;
}

// Contract §8 and §9: the outcome of an attribution that is not `unknown`.
export function classifyCommit(f: CommitFacts): { event: OperationEvent; effects?: EffectSummary; commitOid?: string } {
  const effectsWith = (head: boolean): EffectSummary => ({ head, index: !f.indexEqual, workingFiles: false, operationState: !f.stateEqual });
  const any = (e: EffectSummary) => Object.values(e).some(Boolean);
  if ("identified" in f.attribution) {
    const commitOid = f.attribution.identified;
    const effects = effectsWith(!sameDestination(f.reviewed, f.observed) || !f.treeEqual);
    return any(effects) ? { event: { type: "differing-effects" }, effects, commitOid } : { event: { type: "intended-effects-confirmed" }, commitOid };
  }
  const effects = effectsWith(!Bun.deepEquals(f.observed, f.reviewed, true));
  if (any(effects)) return { event: { type: "failed-with-effects" }, effects };
  if (f.canceled) return { event: { type: "no-effects", observed: "canceled" } };
  // Without a code, the outcome takes the recorded DEADLINE cause.
  return { event: { type: "no-effects", observed: "failed", ...(f.deadline ? {} : { code: "GIT_FAILED" }) } };
}

// `cause` is set only for a failed observation. `known`: the outcome is not `unknown`.
interface Decision {
  event: OperationEvent;
  result: Record<string, unknown>;
  cause?: DiagnosticCause;
  known: boolean;
}

// Contract §8: a failed observation gives `unknown`, and its code goes to the session log.
const unknownOf = (f: Failure | Stop): Decision =>
  "code" in f ? { event: { type: "reconciliation-read-failed", code: f.code }, result: {}, cause: f.code, known: false } : { event: { type: "reconciliation-read-deadline" }, result: {}, cause: "DEADLINE", known: false };

const undetermined = (reason: "ambiguous" | "evidence-limit"): Decision => ({ event: { type: "attribution-undetermined", reason }, result: { reason }, known: false });

interface Observed {
  head: Head;
  index: IndexFacts | WslIndexFacts;
  operationState: OperationState;
}

async function decide(q: ObserveContext, r: CommitReconciliation, observed: Observed, window: Window, canceled: boolean, deadline: boolean): Promise<Decision> {
  const { head: h1 } = observed;
  const h0 = r.binding.head;
  const objectFormat = q.workspace.objectFormat;
  // Contract §8 "Attribution window": only one record whose commit is the observed HEAD can identify a commit, so only it needs parents and a tree.
  const record = "records" in window && window.records.length === 1 ? window.records[0]! : null;
  const candidate = record !== null && h1.state !== "unborn" && record.oid === h1.oid ? h1.oid : null;
  const early = candidate === null ? attribute(window, h0, h1, null) : null;
  if (early !== null && "unknown" in early) return undetermined(early.unknown);
  const [index, parents, tree] = await Promise.all([
    sameIndex(q, r.review, r.binding.reviewedIndex.rawIndexDigest, observed.index),
    candidate === null ? null : parentsOf(q, candidate),
    candidate === null ? null : listingOf(q, commitTreeArgs(candidate, objectFormat), (bytes) => parseTree(bytes, objectFormat)),
  ]);
  if (parents !== null && !("value" in parents)) return unknownOf(parents);
  const attribution = early ?? attribute(window, h0, h1, parents!.value);
  if ("unknown" in attribution) return undetermined(attribution.unknown);
  if (!("value" in index)) return unknownOf(index);
  if (tree !== null && !("value" in tree)) return unknownOf(tree);
  const c = classifyCommit({
    attribution,
    reviewed: h0,
    observed: h1,
    treeEqual: tree !== null && sameTree(tree.value, r.review.entries),
    indexEqual: index.value,
    stateEqual: observed.operationState === r.binding.operationState,
    canceled,
    deadline,
  });
  return { event: c.event, result: { ...(c.commitOid === undefined ? {} : { commitOid: c.commitOid }), ...(c.effects === undefined ? {} : { effects: c.effects }) }, known: true };
}

// Research R4 step 7 and contract §8: the reconciliation of a commit after handoff. One registry event ends it.
export async function reconcileCommit(r: CommitReconciliation): Promise<void> {
  const { registry, operationId, binding, exit, foreign } = r;
  const deadline = exit?.deadline !== undefined;
  const canceled = enterReconciling(registry, operationId, deadline, exit?.activeDescendants ?? 0);
  // Contract §8: a cancel never stops a reconciliation read, so these reads get a signal that never aborts.
  const q: PublishContext = { ...r.ctx, signal: new AbortController().signal };
  // Git exits 128 for the window read of an unborn HEAD. With an unborn reviewed HEAD, the window read waits for the observed HEAD.
  const [state, early] = await Promise.all([observeState(q, EMPTY, false, canonicalIndex(q, binding.reviewedIndex)), binding.head.state === "unborn" ? null : readWindow(q, r.tip)]);
  const head = "value" in state.head ? state.head.value : null;
  const window = head === null || head.state === "unborn" ? NO_RECORDS : (early ?? (await readWindow(q, r.tip)));
  const failed = [state.head, state.index, state.operationState, window].find((f) => !("value" in f)) as Failure | Stop | undefined;
  let decision =
    failed !== undefined
      ? unknownOf(failed)
      : await decide(q, r, { head: head!, index: (state.index as { value: IndexFacts | WslIndexFacts }).value, operationState: (state.operationState as { value: OperationState }).value }, (window as { value: Window }).value, canceled, deadline);

  const event = decision.event;
  if (event.type !== "intended-effects-confirmed") {
    // Contract §9 "Lingering count": a commit failure sends the count request.
    const failing = event.type === "failed-with-effects" || (event.type === "no-effects" && event.observed === "failed");
    const [locks, count] = await Promise.all([
      observedLocks(q, head ?? binding.head),
      failing ? r.runner.lingeringCount(operationId, q.workspace.commonDirectory).then((n) => (typeof n === "number" ? n : null), () => null) : null,
    ]);
    if (Array.isArray(locks)) {
      for (const path of locks) if (foreign.length < COMMIT_FOREIGN_CAP && !foreign.includes(path)) foreign.push(path);
    } else if (decision.known) decision = unknownOf(locks);
    const remedy = decision.known && failing ? r.remedy(count, foreign.length > 0, event.type === "no-effects" && event.code === "GIT_FAILED") : null;
    if (remedy !== null) decision.result.remedy = remedy;
  }

  // Contract §9 "Commit failure output": `failed`, `failed-with-effects`, and `unknown` carry the tail.
  const type = decision.event.type;
  const tail = !(type === "intended-effects-confirmed" || type === "differing-effects" || (decision.event.type === "no-effects" && decision.event.observed === "canceled"));
  const view = registry.get(operationId)!;
  const cause = decision.cause ?? diagnosticCause(null, exit?.diagnosticLimit ? { cause: "OUTPUT_LIMIT" } : null, view.cause);
  const result = { ...decision.result, ...(tail ? { outputTail: r.outputTail } : {}), lingeringDescendants: view.lingeringDescendants ?? 0, ...(foreign.length > 0 ? { foreign } : {}) };
  registry.apply(operationId, decision.event, result, cause);
  if (!decision.known) return;
  // Contract §6: `resolved` follows a known outcome. An `unknown` outcome keeps the marker and the retained data (contract §5).
  r.runner.resolved(r.markerId);
  r.retained.delete(operationId);
}

// ---- T230: `updateSubmodules`, contract §12 "Reconciliation and outcome" and data-model §9 "Row result" ----

// The `submodule.<name>.*` keys of the parent configuration of one row, with their values in Git's order.
export type RowKeys = Record<string, readonly string[]>;
type RowRemedy = { command: string | null; text?: string };

export interface UpdatePhase {
  // A fetch step of the row started.
  fetched: boolean;
  // A clone step, a connect step, or the checkout step of a `reuse` row started.
  connected: boolean;
  refusal?: { reason: NonNullable<SubmoduleRowResult["reason"]>; text: string; remedy?: RowRemedy };
  failedRead?: SubmoduleFailedRead;
  // The last step of the row exited non-zero. A connect step exit that step 5 expects is not recorded.
  failedStep?: { firstFetch: boolean; outputTail: string; remedy: RowRemedy };
}

export interface RowObservation {
  head: string | null;
  // A `.git` entry exists in the submodule folder.
  gitEntry: boolean;
  // `show-ref --exists` exited 0. False: it exited 2.
  refs: boolean;
  keys: RowKeys;
}

export interface UpdateRowFacts {
  rowId: string;
  path: string;
  // The review did not list the row.
  found: boolean;
  // The planned state of the row action, a noted registration included.
  planned: "cloned" | "moved" | "unchanged";
  oldCommit: string | null;
  target: string | null;
  // The preflight keys, or the keys of the step 6 level read.
  baseline: RowKeys;
  phase: UpdatePhase;
  observed: { value: RowObservation } | { code: ErrorCode } | { stop: "deadline" };
}

export interface UpdateFacts {
  rows: UpdateRowFacts[];
  // A Cancel or a process deadline stopped the run. Null: neither.
  stop: "canceled" | "deadline" | null;
}

export function rowKeys(entries: readonly ConfigEntry[], name: string): RowKeys {
  const keys: Record<string, string[]> = {};
  for (const e of entries) {
    const p = keyParts(e.key);
    // The value bytes keep a key without `=` apart from an empty value.
    if (p !== null && p.section === "submodule" && p.subsection === name) (keys[e.key] ??= []).push(Buffer.from(e.keyValueBytes).toString("base64"));
  }
  return keys;
}

function rowOf(r: UpdateRowFacts, o: RowObservation): { result: SubmoduleRowResult; effect: boolean; failing: boolean; reached: boolean } {
  const p = r.phase;
  const step = p.failedStep;
  const base = { rowId: r.rowId, path: r.path, oldCommit: r.oldCommit, newCommit: o.head, fetched: p.fetched, connected: p.connected, found: r.found, registered: !Bun.deepEquals(r.baseline, o.keys) };
  let result: SubmoduleRowResult;
  let failing = false;
  if (p.refusal !== undefined) {
    const { reason, text, remedy } = p.refusal;
    result = { ...base, state: "refused", reason, text, ...(remedy === undefined ? {} : { remedy }) };
    // A failed first fetch of a refused row counts as a failed process.
    failing = step !== undefined || p.failedRead !== undefined;
  } else if (p.failedRead !== undefined) {
    result = { ...base, state: "failed", failedRead: p.failedRead };
    failing = true;
  } else if (step !== undefined && !(step.firstFetch && r.target !== null && o.head === r.target)) {
    result = { ...base, state: "failed", outputTail: step.outputTail, remedy: step.remedy };
    failing = true;
  } else if (o.gitEntry && !o.refs) {
    result = { ...base, state: "clone-interrupted", folderPath: r.path, text: REFUSAL_TEXTS.cloneInterrupted(r.path) };
  } else {
    const h = o.head;
    const atTarget = h !== null && h === r.target;
    result = { ...base, state: atTarget && r.oldCommit === null ? "cloned" : atTarget && h !== r.oldCommit ? "moved" : h === r.oldCommit ? "unchanged" : "changed-elsewhere" };
  }
  const s = result.state;
  const effect = o.head !== r.oldCommit || s === "clone-interrupted" || base.fetched || base.connected || base.registered;
  const reached = r.found ? s === "cloned" || s === "moved" || s === "unchanged" : s === r.planned;
  return { result, effect, failing, reached };
}

// Contract §12 "Reconciliation and outcome": the row states, then the outcome. First match wins in both lists.
export function classifyUpdate(facts: UpdateFacts): { event: OperationEvent; rows: SubmoduleRowResult[] } {
  const rows: ReturnType<typeof rowOf>[] = [];
  for (const r of facts.rows) {
    const o = r.observed;
    if ("code" in o) return { event: { type: "reconciliation-read-failed", code: o.code }, rows: [] };
    if ("stop" in o) return { event: { type: "reconciliation-read-deadline" }, rows: [] };
    rows.push(rowOf(r, o.value));
  }
  const results = rows.map((x) => x.result);
  const effect = rows.some((x) => x.effect);
  const failing = rows.some((x) => x.failing);
  const { stop } = facts;
  if (stop === "canceled" && !effect) return { event: { type: "no-effects", observed: "canceled" }, rows: results };
  if ((failing || stop !== null) && effect) return { event: { type: "failed-with-effects" }, rows: results };
  // Without a code, the outcome takes the recorded DEADLINE cause.
  if (failing || stop === "deadline") return { event: { type: "no-effects", observed: "failed", ...(stop === "deadline" ? {} : { code: "GIT_FAILED" }) }, rows: results };
  return { event: { type: rows.every((x) => x.reached) ? "intended-effects-confirmed" : "differing-effects" }, rows: results };
}

// The facts that the reconciliation read of one row needs.
export interface UpdateRowRead {
  // The path components of the row below the superproject worktree. Null: Git cannot take the path literally, so no read names it.
  components: string[] | null;
  name: string;
  // The kept Git directory of a `reuse` row. While the row has no `.git` entry, HEAD comes from it.
  kept: string | null;
  // The read of the parent row. Null: the superproject owns the row keys.
  parent: UpdateRowRead | null;
}

export interface RetainedUpdateRow extends Omit<UpdateRowFacts, "observed"> {
  read: UpdateRowRead;
}

// Data-model §9: each plan row and each row that the run added.
export interface RetainedUpdate {
  rows: RetainedUpdateRow[];
}

class ReadHalt {
  constructor(readonly fact: Failure | Stop) {}
}

const NEWLINE = 0x0a;
const UTF8_TEXT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The text of a one-line output that ends with LF.
function lineOf(bytes: Uint8Array): string | null {
  if (bytes.length < 2 || bytes.indexOf(NEWLINE) !== bytes.length - 1) return null;
  try {
    return UTF8_TEXT.decode(bytes.subarray(0, -1));
  } catch {
    return null;
  }
}

// Contract §12 "Reconciliation and outcome": the review reads of each row, in row order. `gitDirs` holds the Git directory of each row that has one.
// A `-C` folder without a `.git` entry makes Git search the folders above it, so only a found entry or a kept directory gets a Git read.
export async function observeUpdateRows(ctx: ObserveContext, reads: readonly UpdateRowRead[]): Promise<Fact<{ observations: RowObservation[]; gitDirs: string[] }>> {
  const w = ctx.workspace;
  const listed = await settled(ctx.signal, ctx.trust.listTrust({ operationId: ctx.operationId, signal: ctx.signal, workspace: w }));
  if (!("ok" in listed)) return listed;
  if (!listed.ok) return "stop" in listed ? { stop: listed.stop } : { code: listed.code };
  // Contract §3: trust gating follows the read rule of §7, before any Git process inside a submodule.
  const gate = ctx.trust.gate(w, listed.listing, ctx.installation, "reads");
  if (gate !== null) return { code: gate };
  const all = [...new Set(reads.flatMap((r) => (r.parent === null ? [r] : [r, r.parent])))].filter((r): r is UpdateRowRead & { components: string[] } => r.components !== null);
  const facts = await requestFacts(ctx.runner, ctx.operationId, w, false, all.map((r) => ({ root: "worktreeRoot" as const, path: [...r.components, ".git"] })), ctx.signal);
  if (!Array.isArray(facts)) return "stop" in facts ? facts : { code: facts.code };
  if (facts.some((f) => f.kind === "error")) return { code: "REPOSITORY_UNAVAILABLE" };
  // A link before the last component means that no entry exists at the path.
  const entries = new Map<UpdateRowRead, string[]>(
    all.flatMap((r, i) => {
      const f = facts[i]!;
      return f.kind !== "absent" && (f.kind !== "link" || f.component === r.components.length + 1) ? [[r, r.components]] : [];
    }),
  );
  const locationOf = (r: UpdateRowRead): SubmoduleLocation | null => {
    const components = entries.get(r);
    return components !== undefined ? { worktree: join(w.worktreeRoot, ...components) } : r.kept === null ? null : { gitDir: r.kept };
  };

  const git = async (args: string[], maxBytes = DIAGNOSTIC_RETAINED_BYTES_PER_STREAM) => {
    const out = createCollector({ maxBytes });
    const step = await stepOf(ctx, args, out);
    if (!("exit" in step)) throw new ReadHalt(step);
    if (out.limited) throw new ReadHalt({ code: "OUTPUT_LIMIT" });
    return { code: step.exit.exitCode, out: out.take() };
  };
  const line = async (args: string[]) => {
    const r = await git(args);
    if (r.code !== 0) throw new ReadHalt({ code: "GIT_FAILED" });
    const text = lineOf(r.out);
    if (text === null) throw new ReadHalt({ code: "MALFORMED_GIT_OUTPUT" });
    return text;
  };
  const configs = new Map<UpdateRowRead | null, readonly ConfigEntry[]>([[null, listed.listing.entries]]);
  const configOf = async (r: UpdateRowRead | null): Promise<readonly ConfigEntry[]> => {
    const known = configs.get(r);
    if (known !== undefined) return known;
    const at = locationOf(r!);
    let entries: ConfigEntry[] = [];
    if (at !== null) {
      const listed = await git(submoduleConfigListArgs(at), TRUST_INPUT_BYTES);
      if (listed.code !== 0) throw new ReadHalt({ code: "GIT_FAILED" });
      const parsed = parseConfigListing(listed.out, false);
      if (parsed === null) throw new ReadHalt({ code: "MALFORMED_GIT_OUTPUT" });
      entries = parsed;
    }
    configs.set(r, entries);
    return entries;
  };

  try {
    const observations: RowObservation[] = [];
    const gitDirs: string[] = [];
    for (const r of reads) {
      const at = locationOf(r);
      let head: string | null = null;
      let refs = false;
      if (at !== null) {
        const oid = await git(submoduleHeadOidArgs(at));
        if (oid.code === 0) {
          head = lineOf(oid.out);
          if (head === null || !isObjectId(head, w.objectFormat)) return { code: "MALFORMED_GIT_OUTPUT" };
          refs = true;
        } else {
          // HEAD names no commit only when git-show-ref(1) `--exists` exits 2, or when the target fails the ref-name rules.
          const symbolic = await git(submoduleHeadTargetArgs(at));
          if (symbolic.code === 0) {
            const ref = lineOf(symbolic.out);
            if (ref === null || !isOneLevelRefName(ref)) return { code: "MALFORMED_GIT_OUTPUT" };
            const exists = await git(submoduleRefExistsArgs(at, ref));
            if (exists.code !== 2) return { code: "GIT_FAILED" };
          } else {
            if (symbolic.code !== 128) return { code: "GIT_FAILED" };
            const format = await git(submoduleRefFormatArgs(at, await line(submoduleHeadTargetNoRecurseArgs(at))));
            if (format.code !== 1) return { code: "GIT_FAILED" };
          }
        }
        gitDirs.push(await line(submoduleGitDirArgs(at)));
      }
      observations.push({ head, gitEntry: entries.has(r), refs, keys: rowKeys(await configOf(r.parent), r.name) });
    }
    return { value: { observations, gitDirs } };
  } catch (error) {
    if (error instanceof ReadHalt) return error.fact;
    throw error;
  }
}

// Contract §8 "Observed locks": `updateSubmodules` names at most 5 + 2 × 256 files.
const SUBMODULE_FOREIGN_CAP = 5 + 2 * SUBMODULE_REVIEW_SUBMODULES;

// Contract §8 "Observed locks" with the submodule locks: the superproject `config.lock`, then `index.lock` and `HEAD.lock` of each plan Git directory.
export async function submoduleLocks(ctx: ObserveContext, head: Head | null, gitDirs: readonly string[]): Promise<string[] | Failure | Stop> {
  const locks = await observedLocks(ctx, head);
  if (!Array.isArray(locks)) return locks;
  const paths = [`${ctx.workspace.commonDirectory}/config.lock`, ...[...new Set(gitDirs)].flatMap((dir) => [`${dir}/index.lock`, `${dir}/HEAD.lock`])];
  const found = await Promise.all(paths.map((path) => lstat(path).then(() => true, (error: unknown) => (isMissing(error) ? false : null))));
  if (found.includes(null)) return { code: "GIT_FAILED" };
  return [...locks, ...paths.filter((_, i) => found[i])].slice(0, SUBMODULE_FOREIGN_CAP);
}

export interface UpdateReconciliation {
  registry: OperationRegistry;
  runner: Pick<GitRunner, "resolved" | "lingeringCount">;
  retained: Pick<Map<string, unknown>, "delete">;
  operationId: string;
  markerId: string;
  ctx: ObserveContext;
  update: RetainedUpdate;
  // The superproject HEAD of the preflight, for the branch ref lock.
  head: Head;
  // A Cancel stopped work.
  canceled: boolean;
  // The contract §5 deadline reason that stopped the run: `deadline` for a read, `inactivity` or `ceiling` for a step. Null: none.
  deadline: string | null;
  // The active descendants of the last step exit.
  lingeringDescendants: number;
  // Contract §9: a step passed the §5 diagnostic bound, so the session log names OUTPUT_LIMIT as the cause.
  diagnosticLimit?: boolean;
  foreign: string[];
  // Contract §9: the operation remedy of a failed outcome. Null: no remedy.
  remedy: (lingering: number | null, otherLocks: boolean) => { text: string } | null;
}

// Contract §12 "Reconciliation and outcome": one registry event ends the update.
export async function reconcileUpdate(r: UpdateReconciliation): Promise<void> {
  const { registry, operationId, foreign, deadline } = r;
  if (registry.get(operationId)!.state === "cancel-requested") registry.apply(operationId, deadline !== null ? { type: "cancel-deadline", lingeringDescendants: 0 } : { type: "processes-stopped", lingeringDescendants: r.lingeringDescendants });
  else if (deadline === "deadline") registry.apply(operationId, { type: "mutation-deadline" });
  else if (deadline !== null) registry.apply(operationId, { type: "update-process-deadline", reason: deadline });
  else registry.apply(operationId, { type: "execution-ended", lingeringDescendants: r.lingeringDescendants });
  registry.progress(operationId, "reconciliation");
  // Contract §8: a cancel never stops a reconciliation read, so these reads get a signal that never aborts.
  const q: ObserveContext = { ...r.ctx, signal: new AbortController().signal };
  const read = await observeUpdateRows(q, r.update.rows.map((row) => row.read));
  const stop = deadline !== null ? "deadline" : r.canceled ? "canceled" : null;
  const classified =
    "value" in read
      ? classifyUpdate({ rows: r.update.rows.map(({ read: _, ...row }, i) => ({ ...row, observed: { value: read.value.observations[i]! } })), stop })
      : { event: "code" in read ? ({ type: "reconciliation-read-failed", code: read.code } as const) : ({ type: "reconciliation-read-deadline" } as const), rows: [] };
  let event: OperationEvent = classified.event;
  let result: Record<string, unknown> = "value" in read ? { rows: classified.rows } : {};
  const known = () => event.type !== "reconciliation-read-failed" && event.type !== "reconciliation-read-deadline";

  if (event.type !== "intended-effects-confirmed") {
    // Contract §9 "Lingering count": a failed outcome sends the count request.
    const failing = event.type === "failed-with-effects" || (event.type === "no-effects" && event.observed === "failed");
    const [locks, count] = await Promise.all([
      submoduleLocks(q, r.head, "value" in read ? read.value.gitDirs : []),
      failing ? r.runner.lingeringCount(operationId, q.workspace.commonDirectory).then((n) => (typeof n === "number" ? n : null), () => null) : null,
    ]);
    if (Array.isArray(locks)) {
      for (const path of locks) if (foreign.length < SUBMODULE_FOREIGN_CAP && !foreign.includes(path)) foreign.push(path);
    } else if (known()) {
      event = "code" in locks ? { type: "reconciliation-read-failed", code: locks.code } : { type: "reconciliation-read-deadline" };
      result = {};
    }
    const remedy = known() && failing ? r.remedy(count, foreign.length > 0) : null;
    if (remedy !== null) result.remedy = remedy;
  }

  const view = registry.get(operationId)!;
  const cause =
    event.type === "reconciliation-read-failed" ? event.code : event.type === "reconciliation-read-deadline" ? "DEADLINE" : diagnosticCause(null, r.diagnosticLimit ? { cause: "OUTPUT_LIMIT" } : null, view.cause);
  // Contract §9: the outcome of an update deadline carries its reason.
  const reason = deadline === null ? {} : { reason: deadline };
  registry.apply(operationId, event, { ...result, ...reason, lingeringDescendants: view.lingeringDescendants ?? 0, ...(foreign.length > 0 ? { foreign } : {}) }, cause);
  if (!known()) return;
  // Contract §6: `resolved` follows a known outcome. An `unknown` outcome keeps the marker and the retained data (contract §5).
  r.runner.resolved(r.markerId);
  r.retained.delete(operationId);
}
