// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T113: commit reconciliation after handoff, research R4, contract §4 "Commit validation and handoff", §8, and §9.
// It never retries, resets, amends, or undoes. A commit binds no working file, so `effects.workingFiles` is false (contract §8).

import { HISTORY_COMMIT_OBJECT_BYTES, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS } from "../contracts/limits";
import type { OperationEvent } from "../contracts/outcome";
import type { CommitBinding } from "./approvals";
import { attribute, readWindow, type Attribution, type ReflogRecord, type Window } from "./attribution";
import { batchCommandArgs, commitTreeArgs, indexEntryArgs, isObjectId, type ObjectFormat } from "./commands";
import type { RetainedReview } from "./commit-review";
import { IndexFormatError, rawIndexEntries } from "./eligibility";
import { createCollector, type GitExit, type GitRunner } from "./git-runner";
import { HEADER_BYTES, parseCommitObjects } from "./history-parser";
import { canonicalIndex, diagnosticCause, enterReconciling, observedLocks, observeState, stepOf, type Fact, type Failure, type IndexFacts, type ObserveContext, type PublishContext, type Stop } from "./hunk-publish";
import type { DiagnosticCause, EffectSummary } from "./log";
import type { OperationRegistry } from "./operations";
import { latin1 } from "./read-steps";
import type { Head, IndexEntry, OperationState } from "./snapshot";
import { parseIndexListing } from "./status";
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
async function listingOf<T>(ctx: ObserveContext, args: string[], parse: (bytes: Uint8Array) => T | null): Promise<Fact<T>> {
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
