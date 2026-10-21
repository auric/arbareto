// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `reviewWorkbench` and `runWorkbench` for `merge` and `rebase`, data-model §2 and §5, and plan.md D5 and D6.
// The dispatcher of `workbench-review.ts` holds the token, the common reads, and the run lifecycle. Each outcome comes from fresh reads after the step.

import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, MERGE_MESSAGE_BYTES, STATUS_LISTING_BYTES, SYNC_REFS_BYTES, SYNC_REFS_RECORDS, WINDOWS_COMMAND_LINE_UNITS } from "../contracts/limits";
import { batchCommandArgs, isObjectId, isRefName, type ObjectFormat } from "./commands";
import { createCollector, stepUnits } from "./git-runner";
import { stepOf, type Fact, type ObserveContext } from "./hunk-publish";
import { latin1 } from "./read-steps";
import type { Head } from "./snapshot";
import { changedRefs } from "./sync";
import { pushRecordArgs } from "./sync-commands";
import { count, mergePreview, observe, parentsOf, previewItem, type Observed } from "./sync-integrate";
import { decidePushDestination, invalidRemoteValue, parseAheadBehind, parsePushRecord } from "./sync-parsers";
import { indexState, listRefs, readOut, refKey, refText, remoteList } from "./sync-review";
import { parseMaybeBool, type ConfigEntry } from "./trust";
import { forceNoteCountArgs, headIsAncestorArgs, heldCountArgs, mergeArgs, mergeCountsArgs, movedCountArgs, rebaseOntoArgs, rebaseStatusArgs, rebaseWalkArgs, rewrittenCountArgs } from "./workbench-commands";
import { parseRebaseWalk, parseTrackedStatus, type WalkCommit } from "./workbench-parsers";
import { conclude, readWorktrees, refTarget, registerWorkbenchAction, revCount, unavailable, unresolvedRefusal, type Common, type Observation, type PayloadOf, type Refused, type WorkbenchRun } from "./workbench-review";

export type MergeRebasePayload = PayloadOf<"merge" | "rebase">;
type MergePayload = PayloadOf<"merge">;
type RebasePayload = PayloadOf<"rebase">;
type Branch = Extract<Head, { state: "branch" }>;

// Contract Δ5 "Moved branches listed in the rebase panel". It is no output bound, so `limits.ts` does not list it.
const MOVED_BRANCHES_LISTED = 100;
const HEADS = "refs/heads/";
const STASH = "refs/stash";

// Data-model §5: the configuration entry that gives a value, or Git's default.
export type ConfigSource = { scope: ConfigEntry["scope"]; origin: string } | "default";

export type MergePlan = {
  source: { ref: string; oid: string };
  result: "merge" | "squash";
  noFastForward: boolean;
  noCommit: boolean;
  // Null: the preview holds more than MERGE_MESSAGE_BYTES bytes.
  preview: string | null;
  message: string | null;
  facts: { ahead: number; behind: number; fastForward: boolean; mergeFf: { value: "true" | "false" | "only"; source: ConfigSource } };
};

export type RebasePlan = {
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
};

// Data-model §2 `merge`, `rebase`: the counts, the options, and the message in `plan`. `moved` holds the listing keys of every branch that `rebase.updateRefs` moves.
export type MergeRebaseBound = { plan: MergePlan | RebasePlan; moved: string[] | null };
type Bind = (plan: MergePlan | RebasePlan, moved?: string[] | null) => Observation<MergeRebaseBound>;

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

// builtin/rebase.c `cmd_rebase`: `--autosquash` implies the merge backend. Otherwise the effective `rebase.backend` decides.
// `rebase_config` reads the key with `git_config_string`, which stops Git on a key without a value. Git also stops on a value other than `merge` and `apply`.
function backendOf(entries: readonly ConfigEntry[], autosquash: boolean): "merge" | "apply" | null {
  let value = "merge";
  for (const e of entries) {
    if (e.key !== "rebase.backend") continue;
    if (e.value === null) return null;
    value = e.value;
  }
  if (autosquash) return "merge";
  return value === "merge" || value === "apply" ? value : null;
}

// ---- Review reads ----

// Plan.md D6 and research.md R21 F14: Git refuses a rebase with a tracked change unless `--autostash`.
async function trackedChanges(ctx: ObserveContext): Promise<Fact<boolean>> {
  const out = await readOut(ctx, rebaseStatusArgs(), STATUS_LISTING_BYTES);
  if ("limited" in out) return { code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_BYTES" };
  if (!("value" in out)) return out;
  const parsed = parseTrackedStatus(out.value, ctx.workspace.objectFormat);
  return parsed === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: parsed.records > 0 };
}

// FR-024 and plan.md D6: the tracking ref of the 003 push destination (003 D4). The note shows when it holds a rewritten commit.
async function forceNoteOf(ctx: ObserveContext, head: Branch, onto: string, rewritten: number, entries: readonly ConfigEntry[]): Promise<Fact<RebasePlan["forceNote"]> | Refused> {
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

// The empty tree of each object format (Git hash.c `empty_tree_oid`).
const EMPTY_TREE: Record<ObjectFormat, string> = { sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321" };

// sequencer.c `is_original_commit_empty`: the tree equals the tree of the first parent, or the empty tree for a root commit.
async function emptyOf(ctx: ObserveContext, commits: readonly WalkCommit[]): Promise<Fact<Set<string>>> {
  const of = ctx.workspace.objectFormat;
  const asked = commits.flatMap((c) => (c.parent === null ? [c.oid] : [c.oid, c.parent]));
  const out = createCollector({ maxBytes: asked.length * 96 });
  const step = await stepOf(ctx, batchCommandArgs(), out, new TextEncoder().encode(asked.map((oid) => `info ${oid}^{tree}\0`).join("")));
  if (!("exit" in step)) return step;
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  // git-cat-file(1) "BATCH OUTPUT": `<oid> SP <type> SP <size>` for each `info` command, and `-Z` ends each with NUL.
  const replies = latin1(out.take()).split("\0");
  const trees = replies.slice(0, -1).map((reply) => /^([0-9a-f]+) tree (?:0|[1-9][0-9]*)$/.exec(reply)?.[1] ?? "");
  if (out.limited || replies.at(-1) !== "" || trees.length !== asked.length || !trees.every((tree) => isObjectId(tree, of))) return { code: "MALFORMED_GIT_OUTPUT" };
  const tree = new Map(asked.map((oid, i) => [oid, trees[i]!]));
  return { value: new Set(commits.filter((c) => tree.get(c.oid) === (c.parent === null ? EMPTY_TREE[of] : tree.get(c.parent))).map((c) => c.oid)) };
}

// The current branch when `headMoves`, and each branch of an `update-ref` line. The result holds listing keys in listing order.
// sequencer.c `todo_list_add_update_ref_commands`: an `update-ref` line for each local branch whose value is a commit of the todo list.
// `add_decorations_to_list` skips the HEAD branch and each branch that branch.c `branch_checked_out` names. The todo list holds the commits of
// `sequencer_make_script`: the `rebaseWalkArgs` walk, without a patch-same commit unless it is empty, because builtin/rebase.c sets `keep_empty`.
// Contract gap: `branch_checked_out` also names the branches that a worktree rebases or bisects, and this read sees only the `branch` attributes.
async function updatedRefs(ctx: ObserveContext, head: Branch, onto: string, rebaseMerges: boolean, headMoves: boolean): Promise<Fact<string[]> | Refused> {
  const of = ctx.workspace.objectFormat;
  const refs = await listRefs(ctx, "refs/heads");
  if (!("value" in refs)) return refs;
  const worktrees = await readWorktrees(ctx);
  if (!("value" in worktrees)) return worktrees;
  // Data-model §8: a `headUnresolved` record can hold any candidate, so the moved-branch list is unknown.
  const unknown = unresolvedRefusal(worktrees.value.records);
  if (unknown !== null) return unknown;
  const current = refKey(head.target);
  const held = new Set(worktrees.value.records.flatMap((r) => (r.branchKey === null || r.branchKey === current ? [] : [r.branchKey])));
  const candidates = [...refs.value].filter(([key]) => !held.has(key));
  if (candidates.every(([key]) => key === current)) return { value: headMoves ? candidates.map(([key]) => key) : [] };
  const out = createCollector({ maxBytes: SYNC_REFS_BYTES, maxRecords: SYNC_REFS_RECORDS, separator: 0x0a });
  const step = await stepOf(ctx, rebaseWalkArgs(onto, rebaseMerges, of), out);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT", reason: out.records > SYNC_REFS_RECORDS ? "SYNC_REFS_RECORDS" : "SYNC_REFS_BYTES" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const walk = parseRebaseWalk(out.take(), of);
  if (walk === null) return { code: "MALFORMED_GIT_OUTPUT" };
  const values = new Set(candidates.map(([, oid]) => oid));
  const shown = walk.filter((c) => values.has(c.oid));
  const same = shown.filter((c) => c.same);
  const empty = same.length === 0 ? { value: new Set<string>() } : await emptyOf(ctx, same);
  if (!("value" in empty)) return empty;
  const picked = new Set(shown.filter((c) => !c.same || empty.value.has(c.oid)).map((c) => c.oid));
  return { value: candidates.filter(([key, oid]) => (key === current ? headMoves : picked.has(oid))).map(([key]) => key) };
}

// Contract Δ3 `merge` reads and plan.md D5.
async function reviewMerge(ctx: ObserveContext, p: MergePayload, head: Branch, source: MergePlan["source"], entries: readonly ConfigEntry[], bind: Bind): Promise<Observation<MergeRebaseBound>> {
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
  if (facts.mergeFf.value === "only" && !p.noFastForward && counts.behind > 0 && !facts.fastForward) return unavailable("ff-only", { plan });
  // builtin/merge.c `cmd_merge`: `merge.ff=false` sets the `--no-ff` mode, and Git refuses it with `--squash` (exit 128).
  if (p.result === "squash" && facts.mergeFf.value === "false") return unavailable("squash-no-ff", { plan });
  // git-merge(1): Git fast-forwards also with `--no-commit`, so Don't commit needs No fast-forward.
  if (p.noCommit && !p.noFastForward && counts.behind > 0 && facts.fastForward && facts.mergeFf.value !== "false") return { refused: "INVALID_REQUEST" };
  if (p.result === "merge") {
    const text = p.message ?? plan.preview;
    if (text === null || utf8Bytes(text) > MERGE_MESSAGE_BYTES) return unavailable("message-size", { plan });
    if (stepUnits(ctx, "integrate", mergeArgs(source.ref, { result: "merge", noFastForward: p.noFastForward, noCommit: p.noCommit, message: messageItem(p, text) })) > WINDOWS_COMMAND_LINE_UNITS) return unavailable("message-size", { plan });
  }
  return bind(plan);
}

// Contract Δ3 `rebase` reads and plan.md D6.
async function reviewRebase(ctx: ObserveContext, p: RebasePayload, head: Branch, onto: RebasePlan["onto"], entries: readonly ConfigEntry[], bind: Bind): Promise<Observation<MergeRebaseBound>> {
  const objectFormat = ctx.workspace.objectFormat;
  const autostash = rebaseBool(entries, "rebase.autostash");
  const updateRefs = rebaseBool(entries, "rebase.updaterefs");
  const rebaseMerges = rebaseMergesOf(entries);
  const backend = backendOf(entries, p.autosquash);
  if (autostash === null || updateRefs === null || rebaseMerges === null || backend === null) return unavailable("invalid-config");
  // The apply backend ignores `rebase.updateRefs` and takes its commits from `format-patch`, so the plan would not state Git's rebase.
  if (backend === "apply") return unavailable("apply-backend");
  const moved = await revCount(ctx, movedCountArgs(onto.oid, rebaseMerges, objectFormat));
  if (!("value" in moved)) return moved;
  const rewritten = await revCount(ctx, rewrittenCountArgs(onto.oid, objectFormat));
  if (!("value" in rewritten)) return rewritten;
  const notRemote = await revCount(ctx, heldCountArgs(onto.oid, objectFormat));
  if (!("value" in notRemote)) return notRemote;
  const forceNote = await forceNoteOf(ctx, head, onto.oid, rewritten.value, entries);
  if (!("value" in forceNote)) return forceNote;
  // The panel lists the current branch when it holds a commit that `onto` does not hold.
  const refs = updateRefs.value ? await updatedRefs(ctx, head, onto.oid, rebaseMerges, rewritten.value > 0) : { value: null };
  if (!("value" in refs)) return refs;
  const movedBranches = refs.value === null ? null : { refs: refs.value.slice(0, MOVED_BRANCHES_LISTED).map(refText), more: Math.max(0, refs.value.length - MOVED_BRANCHES_LISTED) };
  const plan: RebasePlan = { onto, moved: moved.value, rewritten: rewritten.value, held: rewritten.value - notRemote.value, forceNote: forceNote.value, movedBranches, autostash, autosquash: false };
  if (!p.autostash) {
    const dirty = await trackedChanges(ctx);
    if (!("value" in dirty)) return dirty;
    if (dirty.value) return unavailable("dirty-tree", { plan });
  }
  return bind(plan, refs.value);
}


// Contract Δ3 `reviewWorkbench` reads for `merge` and `rebase`. The dispatcher already read the trust gate, HEAD, and the markers.
export async function observeMergeRebase(ctx: ObserveContext, payload: MergeRebasePayload, { head, listing }: Common): Promise<Observation<MergeRebaseBound>> {
  // FR-028. The dispatcher reads the markers without the index, so the unmerged count comes from here.
  const index = await indexState(ctx);
  if (!("value" in index)) return index;
  if (index.value.unmerged > 0) return { refused: "CONFLICTED", result: { unmerged: index.value.unmerged } };
  if (head.state === "unborn") return unavailable("unborn");
  if (head.state === "detached") return unavailable("detached");
  if (payload.ref === head.target) return unavailable("same-branch");
  const oid = await refTarget(ctx, payload.ref);
  if (!("value" in oid)) return oid;

  const bind: Bind = (plan, moved = null) => ({ bound: { plan, moved }, plan });
  const source = { ref: payload.ref, oid: oid.value };
  return payload.action === "merge" ? reviewMerge(ctx, payload, head, source, listing.entries, bind) : reviewRebase(ctx, payload, head, source, listing.entries, bind);
}

// ---- Run (contract Δ3 `runWorkbench` steps 3 and 4) ----

function stepArgs(p: MergeRebasePayload, b: MergeRebaseBound): string[] {
  if (p.action === "rebase") return rebaseOntoArgs(p.ref, p.autostash, p.autosquash);
  if (p.result === "squash") return mergeArgs(p.ref, { result: "squash" });
  return mergeArgs(p.ref, { result: "merge", noFastForward: p.noFastForward, noCommit: p.noCommit, message: messageItem(p, (b.plan as MergePlan).preview!) });
}

// Data-model §5: the effect of the reviewed options. True: Git gave that effect, and no other ref changed.
async function intended(q: ObserveContext, p: MergeRebasePayload, b: MergeRebaseBound, head: Branch, o: Observed, before: Map<string, string>): Promise<Fact<boolean>> {
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

export async function runMergeRebase(r: WorkbenchRun, p: MergeRebasePayload, b: MergeRebaseBound): Promise<void> {
  const action = p.action;
  const head = r.common.head as Branch;
  const end = await r.step(stepArgs(p, b), action);
  const settled = await r.reconcile([end]);
  if (settled === null) return r.unknown({ code: "GIT_FAILED" }, { action });
  // Contract §8: a killed Git can leave its `index.lock`, so that read decides too.
  const read = await observe(r.q, end.exit === null || end.exit.exitCode === null);
  if (!("value" in read)) return r.unknown(read, { action });
  const o = read.value;
  const before = r.before.refs;
  const stash = o.refs.get(STASH) !== undefined && o.refs.get(STASH) !== before.get(STASH) ? { oid: o.refs.get(STASH)! } : null;
  // Contract Δ3 "Results": the observed effects. `conclude` adds the output tail of a failed step.
  const result = { action, head: o.head, refs: changedRefs(before, o.refs), operationState: o.state, unmerged: o.index.unmerged, stash };
  const changed = result.refs.length > 0 || !Bun.deepEquals(o.head, head, true) || o.state !== r.before.state || o.index.fingerprint !== r.before.index.fingerprint || o.lock;
  // Git ended the step: no rebase stop remains. A merge with Don't commit keeps MERGE_HEAD, and a failed autostash reapply keeps unmerged entries.
  const done = end.exit?.exitCode === 0 && (o.state === "normal" || o.state === "conflicted" || (action === "merge" && o.state === "merging"));
  const check = done ? await intended(r.q, p, b, head, o, before) : { value: false };
  if (!("value" in check)) return r.unknown(check, result);
  conclude(r, { done, intended: check.value, changed, canceled: settled.canceled, failed: done ? null : end }, result);
}

// A ref outside the Git ref name rules gives INVALID_REQUEST before any Git process.
const precheck = (p: MergeRebasePayload): Refused | null => (isRefName(p.ref) ? null : { refused: "INVALID_REQUEST" });

for (const action of ["merge", "rebase"] as const) {
  registerWorkbenchAction<typeof action, MergeRebaseBound>(action, { precheck, observe: observeMergeRebase, started: (p) => p.action, run: runMergeRebase });
}
