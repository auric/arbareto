// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 010 contract Δ3 `reviewWorkbench` and `runWorkbench` for `reset`, `create-tag`, `cherry-pick`, and `revert-commit`, data-model §2 to §6, and plan.md D3 to D5.
// Git documents no exit status for these steps (research.md R3), so each outcome comes from a fresh `observe`.

import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, HISTORY_PARENTS_PER_COMMIT, WINDOWS_COMMAND_LINE_UNITS } from "../contracts/limits";
import { tagNameRefusal } from "../contracts/tag-name";
import { refExists } from "./branch-ops";
import { batchCommandArgs, isObjectId, isRefName } from "./commands";
import { createCollector, firstEnd, isDeadlineStop, stepUnits } from "./git-runner";
import { objectStream } from "./history-view";
import { stepOf, type Fact, type Failure, type ObserveContext, type Stop } from "./hunk-publish";
import { lastBool, trackedChanges, trackingRefOf } from "./merge-rebase";
import { latin1 } from "./read-steps";
import type { Head } from "./snapshot";
import { detachCommit, inTheWayCheck, trackedStatus } from "./switch";
import { changedRefs, changes } from "./sync";
import { observe, parentsOf } from "./sync-integrate";
import { indexMatches, indexState, readOut, refKey } from "./sync-review";
import type { ConfigEntry } from "./trust";
import { cherryPickArgs, commitIsAncestorArgs, forceNoteCountArgs, gainCountArgs, parentsArgs, reflogOnlyCountArgs, resetArgs, resetCandidatesArgs, revertCommitArgs, rewrittenCountArgs, tagArgs, tagNameCheckArgs } from "./workbench-commands";
import { conclude, killed, registerWorkbenchAction, revCount, unavailable, type Observation, type PayloadOf, type Refused, type WorkbenchRun } from "./workbench-review";

type Branch = Extract<Head, { state: "branch" }>;
const HEADS = "refs/heads/";
const TAGS = "refs/tags/";

// Data-model §6: Git allows both states, and the review refuses them (plan.md D4 read 1, D5 read 1).
const onBranch = (head: Head): Branch | Refused => (head.state === "unborn" ? unavailable("unborn") : head.state === "detached" ? unavailable("detached") : head);

async function conflicted(ctx: ObserveContext): Promise<Fact<null> | Refused> {
  const index = await indexState(ctx);
  if (!("value" in index)) return index;
  return index.value.unmerged > 0 ? { refused: "CONFLICTED", result: { unmerged: index.value.unmerged } } : { value: null };
}

// 001 contract §5 "Deadline outcomes": a deadline closes the Job of the parallel reads, so it decides first. Then the first other end in today's read order decides.
const fault = (ends: readonly (Fact<unknown> | Refused | null)[]): Refused | Failure | Stop | null => firstEnd(ends.map((f) => (f === null || "value" in f ? null : f)), isDeadlineStop);

const objectPrecheck = (oid: string, objectFormat: Parameters<typeof isObjectId>[1]): Refused | null => (isObjectId(oid, objectFormat) ? null : { refused: "INVALID_REQUEST" });

// ---- Reset current branch to here (plan.md D4) ----

type ResetPayload = PayloadOf<"reset">;
type ResetPlan = {
  target: string;
  mode: ResetPayload["mode"];
  branch: string;
  from: string;
  leave: number;
  gain: number;
  reflogOnly: number;
  forceNote: { trackingRef: string } | null;
  trackedChanges: number;
  ignoredReplaced: number;
};
// Data-model §2 `reset`: the plan fields and the tracked status digest.
interface ResetBound {
  plan: ResetPlan;
  tracked: string;
}

registerWorkbenchAction<"reset", ResetBound>("reset", {
  precheck: (p, w) => objectPrecheck(p.target, w.objectFormat),
  async observe(ctx, p, { head, listing }) {
    const of = ctx.workspace.objectFormat;
    const branch = onBranch(head);
    if ("refused" in branch) return branch;
    const [index, target, tracking, status] = await Promise.all([conflicted(ctx), detachCommit(ctx, p.target), trackingRefOf(ctx, branch, listing.entries), trackedStatus(ctx)]);
    if (!("value" in index) || !("value" in target) || isDeadlineStop(tracking) || isDeadlineStop(status)) return fault([index, target, tracking, status])!;
    const t = target.value;
    const [leave, gain, reflogOnly, kept] = await Promise.all([
      revCount(ctx, rewrittenCountArgs(t, of)),
      revCount(ctx, gainCountArgs(t, of)),
      revCount(ctx, reflogOnlyCountArgs(t, branch.target.slice(HEADS.length), of)),
      "value" in tracking && tracking.value !== null ? revCount(ctx, forceNoteCountArgs(t, tracking.value, of)) : null,
    ]);
    if (!("value" in leave) || !("value" in gain) || !("value" in reflogOnly) || !("value" in tracking) || (kept !== null && !("value" in kept)) || !("value" in status)) return fault([leave, gain, reflogOnly, tracking, kept, status])!;
    const forceNote = kept !== null && kept.value < leave.value ? { trackingRef: tracking.value! } : null;
    // Research.md R2 P4 and P15: Git overwrites an untracked file in the way, and the index listing also names a path that `git rm --cached` removed.
    let ignoredReplaced = 0;
    if (p.mode === "hard") {
      const way = await inTheWayCheck(ctx, resetCandidatesArgs(t, of), true);
      if (!("value" in way)) return way;
      ignoredReplaced = way.value.ignored;
    }
    const plan: ResetPlan = { target: t, mode: p.mode, branch: branch.target, from: branch.oid, leave: leave.value, gain: gain.value, reflogOnly: reflogOnly.value, forceNote, trackedChanges: status.value.count, ignoredReplaced };
    return { bound: { plan, tracked: status.value.digest }, plan };
  },
  started: () => "reset",
  async run(r, p, { plan, tracked }) {
    const head = r.common.head as Branch;
    const end = await r.step(resetArgs(plan.target, p.mode, r.ctx.workspace.objectFormat), "reset");
    const settled = await r.reconcile([end]);
    if (settled === null) return r.unknown({ code: "GIT_FAILED" }, { action: "reset" });
    const [observed, status] = await Promise.all([observe(r.q, killed([end])), trackedStatus(r.q)]);
    // 001 contract §5 "Deadline outcomes": a read at its deadline closes the Job of the other read.
    if (!("value" in observed) || !("value" in status)) return r.unknown(firstEnd([observed, status].map((f) => ("value" in f ? null : f)), isDeadlineStop)!, { action: "reset" });
    const o = observed.value;
    const result = { action: "reset", mode: p.mode, head: o.head, refs: changedRefs(r.before.refs, o.refs), trackedChanges: status.value.count };
    const expected = new Map(r.before.refs).set(refKey(head.target), plan.target);
    const exited = end.exit?.exitCode === 0;
    let intended = exited && !o.lock && o.state === "normal" && Bun.deepEquals(o.head, { state: "branch", target: head.target, oid: plan.target }, true) && changes(expected, o.refs).length === 0;
    // Data-model §4: Soft keeps the index. Mixed and Hard write the target tree into the index, and Hard also into the tracked files.
    if (intended && p.mode === "soft") intended = o.index.fingerprint === r.before.index.fingerprint;
    else if (intended) {
      const same = await indexMatches(r.q, plan.target);
      if (!("value" in same)) return r.unknown(same, result);
      intended = same.value;
      if (intended && p.mode === "hard") {
        const dirty = await trackedChanges(r.q);
        if (!("value" in dirty)) return r.unknown(dirty, result);
        intended = !dirty.value;
      }
    }
    const changed = o.lock || result.refs.length > 0 || !Bun.deepEquals(o.head, head, true) || o.index.fingerprint !== r.before.index.fingerprint || o.state !== r.before.state || status.value.digest !== tracked;
    // Data-model §4: only the intended facts give success. FR-006: a step that did not exit 0 gives its output tail.
    conclude(r, { done: intended, intended: true, changed, canceled: settled.canceled, failed: exited ? null : end }, result);
  },
});

// ---- Create tag here (plan.md D3) ----

type Signs = { light: boolean; annotated: boolean };
// Data-model §2 `create-tag`: no `refs/tags/<name>` and the signing fact of the selected kind. `target` is the commit of the payload object.
interface TagBound {
  absent: true;
  signs: boolean;
  target: string;
}

// builtin/tag.c `git_tag_config` reads both keys with `git_config_bool`, which stops Git on a value that is no boolean. Null: such a value.
// Research.md R2 P8: `tag.gpgSign` signs both kinds, and `tag.forceSignAnnotated` signs a `-m` tag without `-a`.
function signsOf(entries: readonly ConfigEntry[]): Signs | null {
  const sign = lastBool(entries, "tag.gpgsign");
  const force = lastBool(entries, "tag.forcesignannotated");
  return sign === null || force === null ? null : { light: sign.value, annotated: sign.value || force.value };
}

registerWorkbenchAction<"create-tag", TagBound>("create-tag", {
  precheck(p, w) {
    const refused = objectPrecheck(p.target, w.objectFormat);
    if (refused !== null || p.name === null) return refused;
    const name = tagNameRefusal(p.name);
    return name === null ? null : name.code === "INVALID_REQUEST" ? { refused: "INVALID_REQUEST" } : unavailable(name.reason);
  },
  async observe(ctx, p, { listing }) {
    const of = ctx.workspace.objectFormat;
    // Plan.md D3: the open review (`name: null`) skips the name reads and the command-line bound, and it gives no token.
    if (p.name !== null) {
      const ref = `${TAGS}${p.name}`;
      const check = await stepOf(ctx, tagNameCheckArgs(p.name), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
      if (!("exit" in check)) return check;
      // git-check-ref-format(1): another exit than 0 refuses the name. A null exit is a Job close. The argv builders also need the `commands.ts` ref rule.
      if (check.exit.exitCode === null) return { code: "GIT_FAILED" };
      if (check.exit.exitCode !== 0 || !isRefName(ref)) return unavailable("invalid-name");
      const exists = await refExists(ctx, ref);
      if (!("value" in exists)) return exists;
      if (exists.value) return unavailable("name-exists", { ref });
    }
    const target = await detachCommit(ctx, p.target);
    if (!("value" in target)) return target;
    const signs = signsOf(listing.entries);
    if (signs === null) return unavailable("invalid-config");
    const annotated = p.message !== null;
    if (p.name !== null && !annotated && signs.light) return unavailable("tag-signing");
    if (p.name !== null && stepUnits(ctx, "integrate", tagArgs(p.name, target.value, p.message, of)) > WINDOWS_COMMAND_LINE_UNITS) return unavailable("message-size");
    const plan = { name: p.name, target: target.value, annotated, signs };
    return { bound: { absent: true, signs: annotated ? signs.annotated : signs.light, target: target.value }, plan, ...(p.name === null ? { token: false as const } : {}) };
  },
  started: () => "create-tag",
  async run(r, p, b) {
    // The dispatcher issues a token only for a review with a name.
    const name = p.name!;
    const key = refKey(`${TAGS}${name}`);
    const end = await r.step(tagArgs(name, b.target, p.message, r.ctx.workspace.objectFormat), "tag");
    const settled = await r.reconcile([end]);
    if (settled === null) return r.unknown({ code: "GIT_FAILED" }, { action: "create-tag" });
    const observed = await observe(r.q, killed([end]));
    if (!("value" in observed)) return r.unknown(observed, { action: "create-tag" });
    const o = observed.value;
    const value = o.refs.get(key) ?? null;
    const result = { action: "create-tag", head: o.head, refs: changedRefs(r.before.refs, o.refs), tag: value === null ? null : { name, oid: value, annotated: value !== b.target } };
    const expected = new Map(r.before.refs);
    if (value !== null) expected.set(key, value);
    const exited = end.exit?.exitCode === 0;
    let intended = exited && value !== null && !r.before.refs.has(key) && changes(expected, o.refs).length === 0 && Bun.deepEquals(o.head, r.common.head, true) && o.state === r.before.state && !o.lock;
    // Data-model §4: a lightweight value is the target. An annotated value is a tag object that peels to the target.
    if (intended && p.message === null) intended = value === b.target;
    else if (intended && value !== b.target) {
      const peeled = await detachCommit(r.q, value!);
      if (!("value" in peeled) && !("refused" in peeled)) return r.unknown(peeled, result);
      intended = "value" in peeled && peeled.value === b.target;
    } else intended = false;
    const changed = o.lock || result.refs.length > 0 || !Bun.deepEquals(o.head, r.common.head, true) || o.state !== r.before.state || o.index.fingerprint !== r.before.index.fingerprint;
    conclude(r, { done: intended, intended: true, changed, canceled: settled.canceled, failed: exited ? null : end }, result);
  },
});

// ---- Cherry-pick commit and Revert commit (plan.md D5) ----

type PickPayload = PayloadOf<"cherry-pick" | "revert-commit">;
type PickPlan = {
  commit: string;
  parents: { oid: string; subject: string | null }[];
  mainline: number | null;
  branch: string;
};
// Data-model §2: the plan and the clean tracked tree.
interface PickBound {
  plan: PickPlan;
  clean: true;
}

// git-rev-list(1) `--parents`: one line with the commit and its parents. The bound holds the line of HISTORY_PARENTS_PER_COMMIT parents, so more bytes mean more parents.
async function parentsRead(ctx: ObserveContext, commit: string): Promise<Fact<string[]> | Refused> {
  const of = ctx.workspace.objectFormat;
  const out = await readOut(ctx, parentsArgs(commit, of), (HISTORY_PARENTS_PER_COMMIT + 1) * (commit.length + 1));
  if ("limited" in out) return unavailable("limit");
  if (!("value" in out)) return out;
  const text = latin1(out.value);
  const ids = text.endsWith("\n") ? text.slice(0, -1).split(" ") : null;
  if (ids === null || ids[0] !== commit || !ids.every((id) => isObjectId(id, of))) return { code: "MALFORMED_GIT_OUTPUT" };
  return { value: ids.slice(1) };
}

// The subject of each parent from `cat-file --batch-command -Z`. Null: the object is above HISTORY_COMMIT_OBJECT_BYTES.
async function subjectsOf(ctx: ObserveContext, oids: readonly string[]): Promise<Fact<(string | null)[]>> {
  if (oids.length === 0) return { value: [] };
  const stream = objectStream(oids, ctx.workspace.objectFormat);
  const step = await stepOf(ctx, batchCommandArgs(), stream, new TextEncoder().encode(oids.map((oid) => `contents ${oid}\0`).join("")));
  if (!("exit" in step)) return step;
  const answers = stream.result();
  if (answers === "MALFORMED_GIT_OUTPUT") return { code: step.exit.exitCode !== 0 && !stream.limited ? "GIT_FAILED" : "MALFORMED_GIT_OUTPUT" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const subjects: (string | null)[] = [];
  for (const answer of answers) {
    if (answer === "missing") return { code: "OBJECT_MISSING" };
    subjects.push(answer === "large" ? null : answer.subject);
  }
  return { value: subjects };
}

// git-merge-base(1) `--is-ancestor`: exit 0 true, exit 1 false. Another exit gives GIT_FAILED.
async function onBranchRead(ctx: ObserveContext, commit: string): Promise<Fact<boolean>> {
  const step = await stepOf(ctx, commitIsAncestorArgs(commit, ctx.workspace.objectFormat), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
  if (!("exit" in step)) return step;
  return step.exit.exitCode === 0 ? { value: true } : step.exit.exitCode === 1 ? { value: false } : { code: "GIT_FAILED" };
}

async function observePick(ctx: ObserveContext, p: PickPayload, head: Head): Promise<Observation<PickBound>> {
  const branch = onBranch(head);
  if ("refused" in branch) return branch;
  // A Cherry-pick reads the tracked status only after `already-on-branch`, because that refusal needs no status.
  const [index, target, early] = await Promise.all([conflicted(ctx), detachCommit(ctx, p.commit), p.action === "revert-commit" ? trackedChanges(ctx) : null]);
  if (!("value" in index) || !("value" in target) || isDeadlineStop(early)) return fault([index, target, early])!;
  const commit = target.value;
  const [parents, ancestor] = await Promise.all([parentsRead(ctx, commit), p.action === "cherry-pick" ? onBranchRead(ctx, commit) : { value: false }]);
  if (!("value" in parents) || isDeadlineStop(ancestor)) return fault([parents, ancestor])!;
  const ids = parents.value;
  // Only `mainline-needed` and the plan show the subjects. A refusal of a commit with fewer than 2 parents reads none.
  const named = ids.length >= 2 ? await subjectsOf(ctx, ids) : null;
  if (named !== null && !("value" in named)) return named;
  const listed = (subjects: (string | null)[]) => ids.map((oid, i) => ({ oid, subject: subjects[i]! }));
  // Research.md R2 P7: Git refuses a merge without `-m` and a mainline for a commit with one parent.
  if (named !== null && p.mainline === null) return unavailable("mainline-needed", { parents: listed(named.value) });
  if (named === null && p.mainline !== null) return unavailable("not-merge");
  if (p.mainline !== null && p.mainline > ids.length) return { refused: "INVALID_REQUEST" };
  if (!("value" in ancestor)) return ancestor;
  if (ancestor.value) return unavailable("already-on-branch");
  // Git-cherry-pick(1) and git-revert(1): "This requires your working tree to be clean". Research.md R4 takes this rule over the P10 behavior.
  const dirty = early ?? (await trackedChanges(ctx));
  if (!("value" in dirty)) return dirty;
  if (dirty.value) return unavailable("dirty-tree");
  const subjects = named ?? (await subjectsOf(ctx, ids));
  if (!("value" in subjects)) return subjects;
  const plan: PickPlan = { commit, parents: listed(subjects.value), mainline: p.mainline, branch: branch.target };
  return { bound: { plan, clean: true }, plan };
}

async function runPick(r: WorkbenchRun, p: PickPayload, { plan }: PickBound): Promise<void> {
  const action = p.action;
  const head = r.common.head as Branch;
  const of = r.ctx.workspace.objectFormat;
  const end = await r.step(action === "cherry-pick" ? cherryPickArgs(plan.commit, plan.mainline, of) : revertCommitArgs(plan.commit, plan.mainline, of), action);
  const settled = await r.reconcile([end]);
  if (settled === null) return r.unknown({ code: "GIT_FAILED" }, { action });
  const [observed, dirty] = await Promise.all([observe(r.q, killed([end])), trackedChanges(r.q)]);
  // 001 contract §5 "Deadline outcomes": a read at its deadline closes the Job of the other read.
  if (!("value" in observed) || !("value" in dirty)) return r.unknown(firstEnd([observed, dirty].map((f) => ("value" in f ? null : f)), isDeadlineStop)!, { action });
  const o = observed.value;
  const result = { action, head: o.head, refs: changedRefs(r.before.refs, o.refs), operationState: o.state, unmerged: o.index.unmerged };
  const stopped = o.state === "cherry-picking" || o.state === "reverting";
  const exited = end.exit?.exitCode === 0;
  const changed = o.lock || result.refs.length > 0 || !Bun.deepEquals(o.head, head, true) || o.index.fingerprint !== r.before.index.fingerprint || o.state !== r.before.state || dirty.value;
  // Data-model §4 row 1: one new commit on the same branch with the old HEAD as its only parent, and no other change.
  let intended = false;
  if (exited && o.state === "normal" && !o.lock && !dirty.value && o.head.state === "branch" && o.head.target === head.target && o.head.oid !== head.oid) {
    const expected = new Map(r.before.refs).set(refKey(head.target), o.head.oid);
    if (changes(expected, o.refs).length === 0) {
      const parents = await parentsOf(r.q, o.head.oid);
      if (!("value" in parents)) return r.unknown(parents, result);
      intended = Bun.deepEquals(parents.value, [head.oid]);
    }
  }
  // Data-model §4: a stop with unmerged entries states them. FR-006: any other step that did not exit 0 gives its output tail.
  const tail = !exited && !(stopped && o.index.unmerged > 0);
  conclude(r, { done: intended, intended: true, changed, canceled: settled.canceled, failed: tail ? end : null }, result);
}

for (const action of ["cherry-pick", "revert-commit"] as const) {
  registerWorkbenchAction<typeof action, PickBound>(action, {
    precheck: (p, w) => objectPrecheck(p.commit, w.objectFormat),
    observe: (ctx, p, { head }) => observePick(ctx, p, head),
    started: (p) => p.action,
    run: runPick,
  });
}
