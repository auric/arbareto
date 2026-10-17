// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `reviewWorkbench` and `runWorkbench` for `merge` and `rebase`, data-model §2 and §5, and plan.md D5 and D6.
// Cancel is never rollback. Each outcome comes from exit codes, the markers, and the refs, HEAD, and index reads around the step.

import type { Response, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode, WorkbenchUnavailableReason } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, MERGE_MESSAGE_BYTES, STATUS_LISTING_BYTES, SYNC_REFS_BYTES, SYNC_REFS_RECORDS, WINDOWS_COMMAND_LINE_UNITS, WORKTREE_LISTING_BYTES, WORKTREE_RECORDS } from "../contracts/limits";
import type { ApprovalKey, Approvals } from "./approvals";
import { isRefName } from "./commands";
import type { Entered, Exclusion, NotEntered } from "./exclusion";
import { commandLineUnits, createCollector, wslCommandLineUnits } from "./git-runner";
import { captureHead, sharedListing, type HistoryReaderOptions, type ReadHistoryTarget } from "./history";
import { isStop, notEntered, settled, stepOf, type Fact, type Failure, type ObserveContext, type Stop } from "./hunk-publish";
import type { OperationRegistry } from "./operations";
import type { Workspace } from "./registration";
import type { Head, OperationState, ReadInstallation } from "./snapshot";
import { pathForms } from "./submodule-review";
import { changes, createStepKit, endBroken, type StepKit, type SyncerOptions } from "./sync";
import { pushRecordArgs } from "./sync-commands";
import { count, mergePreview, observe, parentsOf, previewItem, stepRemedy, type Observed } from "./sync-integrate";
import { decidePushDestination, invalidRemoteValue, parseAheadBehind, parsePushRecord, parseRevListCount } from "./sync-parsers";
import { indexState, listRefs, readOut, refKey, refText, remoteList, type ReviewOutcome } from "./sync-review";
import { parseMaybeBool, type ConfigEntry, type ListingOutcome } from "./trust";
import { forceNoteCountArgs, headIsAncestorArgs, heldCountArgs, mergeArgs, mergeCountsArgs, movedCountArgs, rebaseOntoArgs, rebaseStatusArgs, rewrittenCountArgs, updateRefsArgs, worktreeListArgs } from "./workbench-commands";
import { parseTrackedStatus, parseWorktrees } from "./workbench-parsers";

type ReviewPayload = Extract<ServiceRequest, { operation: "reviewWorkbench" }>["payload"];
export type MergeRebasePayload = Extract<ReviewPayload, { action: "merge" | "rebase" }>;
type MergePayload = Extract<MergeRebasePayload, { action: "merge" }>;
type RebasePayload = Extract<MergeRebasePayload, { action: "rebase" }>;
type RunRequest = Extract<ServiceRequest, { operation: "runWorkbench" }>;
type Branch = Extract<Head, { state: "branch" }>;

export const isMergeRebase = (payload: ReviewPayload): payload is MergeRebasePayload => payload.action === "merge" || payload.action === "rebase";

// shortcut: the 003 class `sync` covers every hook of a merge or a rebase and `merge.<driver>.driver`. T034 replaces it with the class `workbench`.
const TRUST_CLASS = "sync";
// Contract Δ5 "Moved branches listed in the rebase panel". It is no output bound, so `limits.ts` does not list it.
const MOVED_BRANCHES_LISTED = 100;
const HEADS = "refs/heads/";
const STASH = "refs/stash";

// Data-model §5: the configuration entry that gives a value, or Git's default.
export type ConfigSource = { scope: ConfigEntry["scope"]; origin: string } | "default";

export interface MergePlan {
  source: { ref: string; oid: string };
  result: "merge" | "squash";
  noFastForward: boolean;
  noCommit: boolean;
  // Null: the preview holds more than MERGE_MESSAGE_BYTES bytes.
  preview: string | null;
  message: string | null;
  facts: { ahead: number; behind: number; fastForward: boolean; mergeFf: { value: "true" | "false" | "only"; source: ConfigSource } };
}

export interface RebasePlan {
  onto: { ref: string; oid: string };
  moved: number;
  rewritten: number;
  held: number;
  forceNote: { trackingRef: string } | null;
  // Null without `rebase.updateRefs`.
  movedBranches: { refs: string[]; more: number } | null;
  autostash: { value: boolean; source: ConfigSource };
  // Research.md R21 F15: `rebase.autoSquash` affects only an interactive rebase.
  autosquash: false;
}

// Data-model §2: the values that `runWorkbench` reads again. `moved` holds the listing keys of every branch that `rebase.updateRefs` moves.
export interface MergeRebaseBinding {
  payload: MergeRebasePayload;
  head: Branch;
  operationState: OperationState;
  trust: { fingerprint: string; required: boolean };
  plan: MergePlan | RebasePlan;
  moved: string[] | null;
}

type Refusal = { refused: ErrorCode; reason?: WorkbenchUnavailableReason; unmerged?: number; plan?: MergePlan | RebasePlan };
export type Observation = { binding: MergeRebaseBinding } | Refusal | Stop | Failure;
type Bind = (plan: MergePlan | RebasePlan, moved?: string[] | null) => Observation;

const unavailable = (reason: WorkbenchUnavailableReason, plan?: MergePlan | RebasePlan): Refusal => ({ refused: "WORKBENCH_UNAVAILABLE", reason, ...(plan === undefined ? {} : { plan }) });
const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
const messageItem = (p: MergePayload, preview: string) => p.message ?? previewItem(preview);

// ---- Configuration (Git's own readers) ----

// builtin/merge.c `git_merge_config`: `merge.ff` takes a boolean or `only`. Git ignores any other value.
function mergeFfOf(entries: readonly ConfigEntry[]): MergePlan["facts"]["mergeFf"] {
  let found: MergePlan["facts"]["mergeFf"] = { value: "true", source: "default" };
  for (const e of entries) {
    if (e.key !== "merge.ff") continue;
    const bool = parseMaybeBool(e.value);
    const value = bool === 1 ? "true" : bool === 0 ? "false" : e.value === "only" ? "only" : null;
    if (value !== null) found = { value, source: { scope: e.scope, origin: e.origin } };
  }
  return found;
}

// builtin/rebase.c `rebase_config` reads the key with `git_config_bool`, which stops Git on a value that is no boolean. Null: such a value.
function rebaseBool(entries: readonly ConfigEntry[], key: string): { value: boolean; source: ConfigSource } | null {
  let found: { value: boolean; source: ConfigSource } = { value: false, source: "default" };
  for (const e of entries) {
    if (e.key !== key) continue;
    const bool = parseMaybeBool(e.value);
    if (bool < 0) return null;
    found = { value: bool === 1, source: { scope: e.scope, origin: e.origin } };
  }
  return found;
}

// builtin/rebase.c `rebase_config`: `rebase.rebaseMerges` is a boolean or a mode of `parse_rebase_merges_value`. Git stops on another value.
function rebaseMergesOf(entries: readonly ConfigEntry[]): boolean | null {
  let merges = false;
  for (const e of entries) {
    if (e.key !== "rebase.rebasemerges") continue;
    const bool = parseMaybeBool(e.value);
    if (bool >= 0) merges = bool === 1;
    else if (e.value === "rebase-cousins" || e.value === "no-rebase-cousins") merges = true;
    else return null;
  }
  return merges;
}

// ---- Review reads ----

async function revCount(ctx: ObserveContext, args: string[]): Promise<Fact<number>> {
  const out = await readOut(ctx, args, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in out) return { code: "MALFORMED_GIT_OUTPUT" };
  if (!("value" in out)) return out;
  const n = parseRevListCount(out.value);
  return n === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: n };
}

// Contract §6: the command line that the shell builds for the step, `git.exe` or `wsl.exe`.
function commandUnits(ctx: ObserveContext, args: readonly string[]): number {
  const forms = pathForms(ctx.workspace, ctx.installation);
  return forms.launch === undefined ? commandLineUnits(ctx.installation.selectedPath ?? "", args) : wslCommandLineUnits(forms.launch, ctx.operationId, "integrate", "", forms.gitRoot, args);
}

// Plan.md D6 and research.md R21 F14: Git refuses a rebase with a tracked change unless `--autostash`.
async function trackedChanges(ctx: ObserveContext): Promise<Fact<boolean>> {
  const out = await readOut(ctx, rebaseStatusArgs(), STATUS_LISTING_BYTES);
  if ("limited" in out) return { code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_BYTES" };
  if (!("value" in out)) return out;
  const parsed = parseTrackedStatus(out.value, ctx.workspace.objectFormat);
  return parsed === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: parsed.records > 0 };
}

// FR-024 and plan.md D6: the tracking ref of the 003 push destination (003 D4). The note shows when it holds a rewritten commit.
async function forceNoteOf(ctx: ObserveContext, head: Branch, onto: string, rewritten: number, entries: readonly ConfigEntry[]): Promise<Fact<RebasePlan["forceNote"]> | Refusal> {
  // Feature 003 research R16 m: Git stops every `%(push)` read on such a value, so no destination exists to check.
  if (invalidRemoteValue(entries)) return unavailable("invalid-config");
  const branch = head.target.slice(HEADS.length);
  const remotes = await remoteList(ctx);
  if (!("value" in remotes)) return "refused" in remotes ? { code: remotes.refused, ...(remotes.reason === undefined ? {} : { reason: remotes.reason }) } : remotes;
  const recordOut = await readOut(ctx, pushRecordArgs(branch), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in recordOut) return { code: "OUTPUT_LIMIT" };
  if (!("value" in recordOut)) return recordOut;
  const record = parsePushRecord(recordOut.value, branch, ctx.workspace.objectFormat);
  if (record === null) return { code: "MALFORMED_GIT_OUTPUT" };
  // HEAD names this branch, so a missing record means that it changed during the review.
  if (record === "absent") return { code: "GIT_FAILED" };
  const decision = decidePushDestination(record, remotes.value, entries);
  const tracking = decision.kind === "destination" ? decision.destination.trackingRef : null;
  if (tracking === null) return { value: null };
  const refs = await listRefs(ctx, tracking);
  if (!("value" in refs)) return refs;
  if (!refs.value.has(refKey(tracking))) return { value: null };
  const kept = await revCount(ctx, forceNoteCountArgs(onto, tracking, ctx.workspace.objectFormat));
  if (!("value" in kept)) return kept;
  return { value: kept.value < rewritten ? { trackingRef: tracking } : null };
}

// Research.md R21 F16: Git does not move a branch that another worktree checks out. The current branch moves with the rebase itself.
// The result holds listing keys (`refKey`), so the compare uses the raw bytes of each `branch` attribute.
async function updatedRefs(ctx: ObserveContext, head: Branch, onto: string): Promise<Fact<string[]>> {
  const objectFormat = ctx.workspace.objectFormat;
  const out = createCollector({ maxBytes: SYNC_REFS_BYTES, maxRecords: SYNC_REFS_RECORDS, separator: 0x0a });
  const step = await stepOf(ctx, updateRefsArgs(onto, objectFormat), out);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT", reason: out.records > SYNC_REFS_RECORDS ? "SYNC_REFS_RECORDS" : "SYNC_REFS_BYTES" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const raw = Buffer.from(out.take()).toString("latin1");
  const listed = raw === "" ? [] : raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : null;
  if (listed === null || !listed.every((ref) => ref.length > HEADS.length && ref.startsWith(HEADS))) return { code: "MALFORMED_GIT_OUTPUT" };
  const worktrees = await readOut(ctx, worktreeListArgs(), WORKTREE_LISTING_BYTES);
  if ("limited" in worktrees) return { code: "OUTPUT_LIMIT", reason: "WORKTREE_LISTING_BYTES" };
  if (!("value" in worktrees)) return worktrees;
  const records = parseWorktrees(worktrees.value, objectFormat);
  if (records === null) return { code: "MALFORMED_GIT_OUTPUT" };
  if (records.length > WORKTREE_RECORDS) return { code: "OUTPUT_LIMIT", reason: "WORKTREE_RECORDS" };
  // `parseWorktrees` accepted the grammar, so each field that starts with `branch ` is a `branch` attribute line.
  const current = refKey(head.target);
  const held = new Set(Buffer.from(worktrees.value).toString("latin1").split("\0").flatMap((line) => (line.startsWith("branch ") && line.slice(7) !== current ? [line.slice(7)] : [])));
  return { value: listed.filter((key) => !held.has(key)) };
}

// Contract Δ3 `merge` reads and plan.md D5.
async function reviewMerge(ctx: ObserveContext, p: MergePayload, head: Branch, source: MergePlan["source"], entries: readonly ConfigEntry[], bind: Bind): Promise<Observation> {
  const objectFormat = ctx.workspace.objectFormat;
  // builtin/merge.c `git_merge_config` parses `branch.<current>.mergeoptions` as merge options, which the review cannot bind (plan.md D5).
  const mergeOptions = `branch.${head.target.slice(HEADS.length)}.mergeoptions`;
  if (entries.some((e) => e.key === mergeOptions)) return unavailable("merge-options");
  const counted = await readOut(ctx, mergeCountsArgs(source.oid, objectFormat), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in counted) return { code: "MALFORMED_GIT_OUTPUT" };
  if (!("value" in counted)) return counted;
  const counts = parseAheadBehind(counted.value);
  if (counts === null) return { code: "MALFORMED_GIT_OUTPUT" };
  // git-merge-base(1) `--is-ancestor`: exit 0 true, exit 1 false. Contract Δ3: another exit gives GIT_FAILED.
  const ancestor = await stepOf(ctx, headIsAncestorArgs(source.oid, objectFormat), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
  if (!("exit" in ancestor)) return ancestor;
  if (ancestor.exit.exitCode !== 0 && ancestor.exit.exitCode !== 1) return { code: "GIT_FAILED" };
  const preview = await mergePreview(ctx, source.ref, source.oid, MERGE_MESSAGE_BYTES);
  if (!("value" in preview) && !("limited" in preview)) return preview;
  const facts = { ...counts, fastForward: ancestor.exit.exitCode === 0, mergeFf: mergeFfOf(entries) };
  const plan: MergePlan = { source, result: p.result, noFastForward: p.noFastForward, noCommit: p.noCommit, preview: "value" in preview ? preview.value : null, message: p.message, facts };
  // Git's `--no-ff` replaces `merge.ff=only`. A source without new commits ends "Already up to date" (builtin/merge.c).
  if (facts.mergeFf.value === "only" && !p.noFastForward && counts.behind > 0 && !facts.fastForward) return unavailable("ff-only", plan);
  // builtin/merge.c `cmd_merge`: `merge.ff=false` sets the `--no-ff` mode, and Git refuses it with `--squash` (exit 128).
  if (p.result === "squash" && facts.mergeFf.value === "false") return unavailable("squash-no-ff", plan);
  // git-merge(1): Git fast-forwards also with `--no-commit`, so Don't commit needs No fast-forward.
  if (p.noCommit && !p.noFastForward && counts.behind > 0 && facts.fastForward && facts.mergeFf.value !== "false") return { refused: "INVALID_REQUEST" };
  if (p.result === "merge") {
    const text = p.message ?? plan.preview;
    if (text === null || utf8Bytes(text) > MERGE_MESSAGE_BYTES) return unavailable("message-size", plan);
    if (commandUnits(ctx, mergeArgs(source.ref, { result: "merge", noFastForward: p.noFastForward, noCommit: p.noCommit, message: messageItem(p, text) })) > WINDOWS_COMMAND_LINE_UNITS) return unavailable("message-size", plan);
  }
  return bind(plan);
}

// Contract Δ3 `rebase` reads and plan.md D6.
async function reviewRebase(ctx: ObserveContext, p: RebasePayload, head: Branch, onto: RebasePlan["onto"], entries: readonly ConfigEntry[], bind: Bind): Promise<Observation> {
  const objectFormat = ctx.workspace.objectFormat;
  const autostash = rebaseBool(entries, "rebase.autostash");
  const updateRefs = rebaseBool(entries, "rebase.updaterefs");
  const rebaseMerges = rebaseMergesOf(entries);
  if (autostash === null || updateRefs === null || rebaseMerges === null) return unavailable("invalid-config");
  const moved = await revCount(ctx, movedCountArgs(onto.oid, rebaseMerges, objectFormat));
  if (!("value" in moved)) return moved;
  const rewritten = await revCount(ctx, rewrittenCountArgs(onto.oid, objectFormat));
  if (!("value" in rewritten)) return rewritten;
  const notRemote = await revCount(ctx, heldCountArgs(onto.oid, objectFormat));
  if (!("value" in notRemote)) return notRemote;
  const forceNote = await forceNoteOf(ctx, head, onto.oid, rewritten.value, entries);
  if (!("value" in forceNote)) return forceNote;
  const refs = updateRefs.value ? await updatedRefs(ctx, head, onto.oid) : { value: null };
  if (!("value" in refs)) return refs;
  const movedBranches = refs.value === null ? null : { refs: refs.value.slice(0, MOVED_BRANCHES_LISTED).map(refText), more: Math.max(0, refs.value.length - MOVED_BRANCHES_LISTED) };
  const plan: RebasePlan = { onto, moved: moved.value, rewritten: rewritten.value, held: rewritten.value - notRemote.value, forceNote: forceNote.value, movedBranches, autostash, autosquash: false };
  if (!p.autostash) {
    const dirty = await trackedChanges(ctx);
    if (!("value" in dirty)) return dirty;
    if (dirty.value) return unavailable("dirty-tree", plan);
  }
  return bind(plan, refs.value);
}

// Contract Δ3 `reviewWorkbench` for `merge` and `rebase`. `list` gives the trust listing: shared or own for a review, own for `runWorkbench`.
export async function observeMergeRebase(ctx: ObserveContext, payload: MergeRebasePayload, list: () => Promise<ListingOutcome>): Promise<Observation> {
  const { trust, workspace: w, installation, signal } = ctx;
  if (!isRefName(payload.ref)) return { refused: "INVALID_REQUEST" };
  const listed = await settled(signal, list());
  if (!("ok" in listed)) return listed;
  if (!listed.ok) return "stop" in listed ? { stop: listed.stop } : { code: listed.code };
  const { listing } = listed;
  const gate = trust.gate(w, listing, installation, TRUST_CLASS);
  if (gate !== null) return { refused: gate };

  const head = await settled(signal, captureHead(ctx.runner, ctx));
  if (isStop(head) || "code" in head) return head;
  if ("failed" in head) return { code: head.failed };
  const index = await indexState(ctx);
  if (!("value" in index)) return index;
  const state = await settled(signal, ctx.reader.operationState(ctx, index.value.unmerged > 0));
  if (typeof state === "object") return "refused" in state ? { code: state.refused } : state;
  if (state === "canceled" || state === "deadline") return { stop: state };
  // FR-028. The markers decide first, because a stopped rebase also detaches HEAD.
  if (state === "conflicted") return { refused: "CONFLICTED", unmerged: index.value.unmerged };
  // Feature 003 plan.md D7: `unknown` is an unreadable marker or `rebase-apply/applying`, so no operation kind is known.
  if (state === "unknown") return unavailable("unknown-operation");
  if (state !== "normal") return { refused: "OPERATION_IN_PROGRESS" };
  if (head.state === "unborn") return unavailable("unborn");
  if (head.state === "detached") return unavailable("detached");
  if (payload.ref === head.target) return unavailable("same-branch");
  const refs = await listRefs(ctx, payload.ref);
  if (!("value" in refs)) return refs;
  const oid = refs.value.get(refKey(payload.ref));
  if (oid === undefined) return { refused: "UNKNOWN_TARGET" };

  const bind: Bind = (plan, moved = null) => ({ binding: { payload, head, operationState: state, trust: { fingerprint: listing.fingerprint, required: listing.approvalRequired[TRUST_CLASS] }, plan, moved } });
  const source = { ref: payload.ref, oid };
  return payload.action === "merge" ? reviewMerge(ctx, payload, head, source, listing.entries, bind) : reviewRebase(ctx, payload, head, source, listing.entries, bind);
}

// ---- Run (contract Δ3 `runWorkbench` steps 3 and 4) ----

function stepArgs(b: MergeRebaseBinding): string[] {
  const p = b.payload;
  if (p.action === "rebase") return rebaseOntoArgs(p.ref, p.autostash, p.autosquash);
  if (p.result === "squash") return mergeArgs(p.ref, { result: "squash" });
  return mergeArgs(p.ref, { result: "merge", noFastForward: p.noFastForward, noCommit: p.noCommit, message: messageItem(p, (b.plan as MergePlan).preview!) });
}

// Data-model §5: the effect of the reviewed options. True: Git gave that effect, and no other ref changed.
async function intended(q: ObserveContext, b: MergeRebaseBinding, o: Observed, before: Map<string, string>): Promise<Fact<boolean>> {
  const { payload: p, head } = b;
  if (o.head.state !== "branch" || o.head.target !== head.target || o.index.unmerged > 0 || o.lock) return { value: false };
  const moved = [...new Set([...before.keys(), ...o.refs.keys()])].filter((key) => before.get(key) !== o.refs.get(key));
  const only = (allowed: readonly string[]) => moved.every((key) => allowed.includes(key));
  if (p.action === "rebase") {
    if (o.state !== "normal" || !only([refKey(head.target), ...(b.moved ?? [])])) return { value: false };
    const counted = await count(q, o.head.oid, (b.plan as RebasePlan).onto.oid);
    return "value" in counted ? { value: counted.value.behind === 0 } : counted;
  }
  const plan = b.plan as MergePlan;
  const unchanged = moved.length === 0 && o.head.oid === head.oid;
  if (plan.facts.behind === 0 || p.result === "squash") return { value: o.state === "normal" && unchanged };
  const fastForward = plan.facts.fastForward && !p.noFastForward && plan.facts.mergeFf.value !== "false";
  if (p.noCommit && !fastForward) return { value: o.state === "merging" && unchanged };
  if (o.state !== "normal" || !only([refKey(head.target)])) return { value: false };
  if (fastForward) return { value: o.head.oid === plan.source.oid };
  const parents = await parentsOf(q, o.head.oid);
  return "value" in parents ? { value: Bun.deepEquals(parents.value, [head.oid, plan.source.oid]) } : parents;
}

export async function runMergeRebase(s: StepKit, b: MergeRebaseBinding): Promise<void> {
  const { ctx, q } = s;
  const action = b.payload.action;
  const [listed, index] = await Promise.all([listRefs(ctx), indexState(ctx)]);
  if (!("value" in listed)) return s.refuse(listed);
  if (!("value" in index)) return s.refuse(index);
  if (ctx.signal.aborted) return s.refuse({ stop: "canceled" });
  const args = stepArgs(b);
  const end = await s.step(args, action, {}, stepRemedy(s, args, b.payload.ref), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }), "integrate");

  const canceled = s.enter(end.exit?.deadline !== undefined);
  if (!(await s.processEnded([end]))) return s.unknown({ code: "GIT_FAILED" }, { action });
  const read = await observe(q, end.exit === null || end.exit.exitCode === null);
  if (!("value" in read)) return s.unknown(read, { action });
  const o = read.value;
  const before = listed.value;
  const exit0 = end.exit?.exitCode === 0;
  const stash = o.refs.get(STASH) !== undefined && o.refs.get(STASH) !== before.get(STASH) ? { oid: o.refs.get(STASH)! } : null;
  // Contract Δ3 "Results": the observed effects, and the output tail of a failed step.
  const result = { action, head: o.head, refs: changes(before, o.refs), operationState: o.state, unmerged: o.index.unmerged, stash, ...(exit0 ? {} : { outputTail: end.outputTail }) };
  const changed = result.refs.length > 0 || !Bun.deepEquals(o.head, b.head, true) || o.state !== b.operationState || o.index.fingerprint !== index.value.fingerprint || o.lock;
  // Git ended the step: no rebase stop remains. A merge with Don't commit keeps MERGE_HEAD, and a failed autostash reapply keeps unmerged entries.
  if (exit0 && (o.state === "normal" || o.state === "conflicted" || (action === "merge" && o.state === "merging"))) {
    const check = await intended(q, b, o, before);
    if (!("value" in check)) return s.unknown(check, result);
    return s.finish(check.value ? { type: "intended-effects-confirmed" } : { type: "differing-effects" }, result);
  }
  if (changed) return s.finish({ type: "failed-with-effects" }, result);
  if (canceled) return s.finish({ type: "no-effects", observed: "canceled" }, result);
  const code: ErrorCode | undefined = end.refused ?? (end.exit?.deadline !== undefined ? undefined : end.exit?.diagnosticLimit ? "OUTPUT_LIMIT" : "GIT_FAILED");
  return s.finish({ type: "no-effects", observed: "failed", ...(code === undefined ? {} : { code }) }, result);
}

// Contract Δ3 `runWorkbench` step 2 and data-model §2: a trust difference gives TRUST_REQUIRED or TRUST_CHANGED, any other difference STALE_REVIEW.
function staleOf(b: MergeRebaseBinding, again: Observation): { code: ErrorCode; reason?: Failure["reason"]; result?: unknown } | Stop | null {
  if (isStop(again) || "code" in again) return again;
  if ("refused" in again) {
    if (again.refused === "TRUST_REQUIRED" || again.refused === "TRUST_CHANGED") return { code: again.refused };
    return again.refused === "CONFLICTED" ? { code: "CONFLICTED", result: { unmerged: again.unmerged } } : { code: "STALE_REVIEW" };
  }
  if ((b.trust.required || again.binding.trust.required) && again.binding.trust.fingerprint !== b.trust.fingerprint) return { code: "TRUST_CHANGED" };
  const { trust: _bound, ...bound } = b;
  const { trust: _now, ...now } = again.binding;
  return Bun.deepEquals(bound, now, true) ? null : { code: "STALE_REVIEW" };
}

export interface MergeRebaseOptions extends Pick<HistoryReaderOptions, "listingTuple">, Pick<SyncerOptions, "runner" | "trust" | "reader"> {
  approvals: Approvals;
  registry: OperationRegistry;
  exclusion: Exclusion;
  respond: (response: Response) => unknown;
}

// shortcut: the review and run entry points of `merge` and `rebase` stand in for the T027 dispatcher of `workbench-review.ts`; move them there with T027.
export function createMergeRebase(o: MergeRebaseOptions) {
  const { registry, approvals } = o;
  // Contract §2: the workspace of each operation that consumed a workbench token.
  const owners = new Map<string, string>();

  async function execute(w: Workspace, installation: ReadInstallation, operationId: string, signal: AbortSignal, key: ApprovalKey, b: MergeRebaseBinding): Promise<void> {
    let entered: Entered | NotEntered;
    try {
      entered = await o.exclusion.enter({ operationId, kind: "workbench", action: b.payload.action, workspace: w });
    } catch {
      return void registry.apply(operationId, { type: "exclusion-unavailable", code: "GIT_FAILED" });
    }
    if (!entered.ok) return notEntered(registry, operationId, entered);
    const marker = entered;
    const kit = createStepKit(o, w, installation, operationId, signal, () => o.runner.resolved(marker.markerId));
    try {
      registry.apply(operationId, { type: "marker-recorded" });
      owners.set(operationId, w.repositoryId);
      registry.progress(operationId, "preflight");
      // Contract Δ3 `runWorkbench` step 2: every bound value again, from an own trust listing.
      const stale = staleOf(b, await observeMergeRebase(kit.ctx, b.payload, () => o.trust.listTrust({ operationId, signal, workspace: w })));
      if (stale !== null) return kit.refuse(stale);
      // The token is consumed only after validation.
      if (!approvals.consume(key, operationId)) {
        const now = approvals.accept(key);
        return kit.refuse({ code: !now.ok && "code" in now ? now.code : "UNKNOWN_TARGET" });
      }
      await runMergeRebase(kit, b);
    } catch {
      endBroken(registry, operationId);
    } finally {
      marker.end(false);
    }
  }

  return {
    // Contract Δ3 `reviewWorkbench`. A refusal issues no token.
    async review(t: ReadHistoryTarget, payload: MergeRebasePayload): Promise<ReviewOutcome> {
      const ctx: ObserveContext = { runner: o.runner, trust: o.trust, reader: o.reader, operationId: t.operationId, signal: t.signal, workspace: t.workspace, installation: t.installation };
      const observed = await observeMergeRebase(ctx, payload, () => sharedListing({ trust: o.trust, listingTuple: o.listingTuple }, t));
      if (isStop(observed)) return { result: observed.stop };
      if ("code" in observed) return { result: "failed", code: observed.code };
      if ("refused" in observed) {
        const { refused, ...value } = observed;
        return { result: "failed", code: refused, ...(Object.keys(value).length === 0 ? {} : { value }) };
      }
      const workbenchToken = crypto.randomUUID();
      approvals.issue({ kind: "workbench", reviewToken: workbenchToken, repositoryId: t.workspace.repositoryId, generation: t.generation, binding: observed.binding });
      return { result: "succeeded", value: { action: payload.action, plan: observed.binding.plan, workbenchToken } };
    },

    // Contract Δ3 `runWorkbench`. `installation` is the Git of the workspace.
    run(request: RunRequest, w: Workspace, installation: ReadInstallation): void {
      const key: ApprovalKey = { kind: "workbench", reviewToken: request.payload.workbenchToken };
      // Contract §2: a consumed token answers a repeat with its operation, without an accepted event or a process.
      const peek = approvals.accept(key);
      if (!peek.ok && "consumed" in peek && owners.get(peek.consumed) === request.repositoryId) {
        return void o.respond({ requestId: request.requestId, operationId: peek.consumed, state: "succeeded", result: registry.get(peek.consumed) });
      }
      const { operationId, signal } = registry.start("runWorkbench", request.requestId);
      const accepted = approvals.accept(key);
      if (!accepted.ok) return void registry.apply(operationId, { type: "invalid-approval", code: "code" in accepted ? accepted.code : "UNKNOWN_TARGET" });
      const approval = accepted.approval;
      if (approval.kind !== "workbench" || approval.repositoryId !== request.repositoryId || approval.generation !== w.generation) return void registry.apply(operationId, { type: "invalid-approval", code: "UNKNOWN_TARGET" });
      // Contract Δ7 "Mutation trust": the reviewed listing decides before any process.
      const t = approval.binding.trust;
      const gate = o.trust.gate(w, { approvalRequired: { [TRUST_CLASS]: t.required }, fingerprint: t.fingerprint, inputLimited: false }, installation, TRUST_CLASS);
      if (gate !== null) return void registry.apply(operationId, { type: "invalid-approval", code: gate });
      void execute(w, installation, operationId, signal, key, approval.binding);
    },
  };
}

export type MergeRebase = ReturnType<typeof createMergeRebase>;
