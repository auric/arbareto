// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `switch`, plan.md D3, data-model §3, and spec FR-009 to FR-013.
// Discard never passes `--force`. Each stash step names S by its object ID, and fresh reads decide every outcome.

import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, HISTORY_COMMIT_OBJECT_BYTES, REFLOG_SCAN_ENTRIES, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS, SYNC_REFS_BYTES, SYNC_REFS_RECORDS, WINDOWS_COMMAND_LINE_UNITS } from "../contracts/limits";
import { nameRefusal, newName, refExists } from "./branch-ops";
import { batchCommandArgs, isObjectId, isOneLevelRefName, isRefName } from "./commands";
import { createCollector, firstEnd, isDeadlineStop, stepUnits } from "./git-runner";
import { stepOf, type Fact, type ObserveContext } from "./hunk-publish";
import { latin1 } from "./read-steps";
import type { Head } from "./snapshot";
import { discardCandidates, ignoreRead, inTheWay, sortFacts, untrackedOf } from "./switch-check";
import { changedRefs, changes } from "./sync";
import { observe } from "./sync-integrate";
import { indexState, readOut, refKey } from "./sync-review";
import { isComponent, requestFacts } from "./trust";
import { changedPathsArgs, commitObjectArgs, containsArgs, detachArgs, refPeelArgs, stagesArgs, stashApplyArgs, stashDropArgs, stashPushArgs, stashReflogArgs, stashValueArgs, switchArgs, trackArgs, trackedStatusArgs } from "./workbench-commands";
import { oidList, parseTrackedStatus, trackingRemotes } from "./workbench-parsers";
import { conclude, heldElsewhere, killed, readWorktrees, registerWorkbenchAction, unavailable, type Refused, type StepEnd } from "./workbench-review";

export const STASH_REMEDY_TEXT = "The stash keeps the changes. This command applies them again.";

const HEADS = "refs/heads/";
const STASH = "refs/stash";
const MALFORMED = { code: "MALFORMED_GIT_OUTPUT" } as const;
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Data-model §2 `switch`: the target object ID, the tracked status digest, `refs/stash`, and the detached commit that no ref holds.
interface SwitchBound {
  target: string;
  tracked: { digest: string; count: number };
  stash: string | null;
  unreachable: string | null;
}

// Data-model §3 `stash.state` is `kept-<reason>` with the contract Δ9 STASH_KEPT reason, or `dropped`.
type Kept = "conflicts" | "failed-apply" | "failed-checkout" | "not-found";

// `parseTrackedStatus` skips the `# ` header lines, such as `# stash <n>` of `status.showStash` (git-status(1)).
async function trackedStatus(ctx: ObserveContext): Promise<Fact<{ digest: string; count: number; unmerged: number }>> {
  const out = createCollector({ maxBytes: STATUS_LISTING_BYTES, maxRecords: STATUS_LISTING_RECORDS, separator: 0 });
  const step = await stepOf(ctx, trackedStatusArgs(), out);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const bytes = out.take();
  const parsed = parseTrackedStatus(bytes, ctx.workspace.objectFormat);
  if (parsed === null) return MALFORMED;
  return { value: { digest: sha256(bytes), count: parsed.records, unmerged: parsed.unmerged } };
}

const oneOid = (ctx: ObserveContext, bytes: Uint8Array): Fact<string> => {
  const text = latin1(bytes);
  return text.endsWith("\n") && isObjectId(text.slice(0, -1), ctx.workspace.objectFormat) ? { value: text.slice(0, -1) } : MALFORMED;
};

// Contract Δ3: `show-ref --exists refs/stash`, then `rev-parse --verify -q refs/stash`.
async function stashValue(ctx: ObserveContext): Promise<Fact<string | null>> {
  const exists = await refExists(ctx, STASH);
  if (!("value" in exists)) return exists;
  if (!exists.value) return { value: null };
  // One object ID and LF cannot pass the bound, so more bytes break the grammar.
  const read = await readOut(ctx, stashValueArgs(), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in read) return MALFORMED;
  return "value" in read ? oneOid(ctx, read.value) : read;
}

// The `refs/stash` reflog, newest first. `-z` ends each `%H` entry with NUL. `complete` is false above REFLOG_SCAN_ENTRIES.
async function stashEntries(ctx: ObserveContext): Promise<Fact<{ oids: string[]; complete: boolean }>> {
  const out = createCollector({ maxBytes: REFLOG_SCAN_ENTRIES * 65, maxRecords: REFLOG_SCAN_ENTRIES, separator: 0 });
  const step = await stepOf(ctx, stashReflogArgs(), out);
  if (!("exit" in step)) return step;
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const oids = oidList(out.take(), ctx.workspace.objectFormat);
  return oids === null ? MALFORMED : { value: { oids, complete: !out.limited } };
}

// git-cat-file(1) `commit` prints the raw object. The header line after `tree` names the first parent.
async function firstParent(ctx: ObserveContext, commit: string): Promise<Fact<string | null>> {
  const read = await readOut(ctx, commitObjectArgs(commit, ctx.workspace.objectFormat), HISTORY_COMMIT_OBJECT_BYTES);
  if ("limited" in read) return { code: "OUTPUT_LIMIT", reason: "HISTORY_COMMIT_OBJECT_BYTES" };
  if (!("value" in read)) return read;
  const header = latin1(read.value).split("\n", 2);
  if (!header[0]!.startsWith("tree ")) return MALFORMED;
  const parent = header[1]?.startsWith("parent ") ? header[1].slice("parent ".length) : null;
  return parent === null || isObjectId(parent, ctx.workspace.objectFormat) ? { value: parent } : MALFORMED;
}

// Plan.md D3 stash protocol after an exit 0 push. Null: nothing was stashed. `changed`: any other observation, so the switch stops before the checkout.
async function stashOf(ctx: ObserveContext, before: string | null, head: string): Promise<Fact<string | null | "changed">> {
  const now = await stashValue(ctx);
  if (!("value" in now)) return now;
  if (now.value === before) return { value: null };
  if (now.value === null) return { value: "changed" };
  const entries = await stashEntries(ctx);
  if (!("value" in entries)) return entries;
  const [first, second] = entries.value.oids;
  if (first !== now.value || (before === null ? entries.value.oids.length !== 1 || !entries.value.complete : second !== before)) return { value: "changed" };
  const parent = await firstParent(ctx, now.value);
  if (!("value" in parent)) return parent;
  return { value: parent.value === head ? now.value : "changed" };
}

// git-cat-file(1) `objecttype` values.
const OBJECT_TYPES: readonly string[] = ["commit", "tree", "blob", "tag"];

// Contract Δ3 `switch`: the commit of a branch ref from its exact record. An annotated tag gives its peeled commit (git-for-each-ref(1) `*` fields).
// A missing ref or another object type gives UNKNOWN_TARGET.
export async function refCommit(ctx: ObserveContext, ref: string): Promise<Fact<string> | Refused> {
  const of = ctx.workspace.objectFormat;
  const out = createCollector({ maxBytes: SYNC_REFS_BYTES, maxRecords: SYNC_REFS_RECORDS, separator: 0x0a });
  const step = await stepOf(ctx, refPeelArgs(ref), out);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT", reason: out.records > SYNC_REFS_RECORDS ? "SYNC_REFS_RECORDS" : "SYNC_REFS_BYTES" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const text = latin1(out.take());
  if (text !== "" && !text.endsWith("\n")) return MALFORMED;
  let commit: string | null | undefined;
  for (const line of text === "" ? [] : text.slice(0, -1).split("\n")) {
    const [name = "", object = "", type = "", peeled = "", peeledType = "", ...rest] = line.split("\0");
    // A peeled object is never a tag, because Git peels nested tags fully.
    const peel = type === "tag" ? isObjectId(peeled, of) && OBJECT_TYPES.includes(peeledType) && peeledType !== "tag" : peeled === "" && peeledType === "";
    if (rest.length > 0 || !name.startsWith("refs/") || !isObjectId(object, of) || !OBJECT_TYPES.includes(type) || !peel) return MALFORMED;
    if (name !== refKey(ref)) continue;
    if (commit !== undefined) return MALFORMED;
    commit = type === "commit" ? object : type === "tag" && peeledType === "commit" ? peeled : null;
  }
  return commit === undefined || commit === null ? { refused: "UNKNOWN_TARGET" } : { value: commit };
}

// Contract Δ3 `switch` `detach`: `info <oid>^{commit}` names the commit, also through an annotated tag (git-cat-file(1), gitrevisions(7)).
// Git prints `<object> missing` for a missing object and for an object that peels to no commit, so both give UNKNOWN_TARGET.
async function detachCommit(ctx: ObserveContext, oid: string): Promise<Fact<string> | Refused> {
  const input = `${oid}^{commit}`;
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const step = await stepOf(ctx, batchCommandArgs(), out, new TextEncoder().encode(`info ${input}\0`));
  if (!("exit" in step)) return step;
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const text = latin1(out.take());
  if (!out.limited && text === `${input} missing\0`) return { refused: "UNKNOWN_TARGET" };
  const m = /^([0-9a-f]+) commit (?:0|[1-9][0-9]*)\0$/.exec(text);
  return !out.limited && m !== null && isObjectId(m[1]!, ctx.workspace.objectFormat) ? { value: m[1]! } : MALFORMED;
}

// Contract §6 command-line bound: each `ls-files` batch fits WINDOWS_COMMAND_LINE_UNITS under the measure of its route.
function batches(paths: readonly string[], ctx: ObserveContext): string[][] {
  const out: string[][] = [];
  for (const path of paths) {
    const last = out.at(-1);
    if (last !== undefined && stepUnits(ctx, "read", stagesArgs([...last, path])) <= WINDOWS_COMMAND_LINE_UNITS) last.push(path);
    else out.push([path]);
  }
  return out;
}

// Plan.md D3 and research.md R4: the untracked-in-the-way check of Discard. Paths stay byte strings (`latin1`) until an argv or a `fileFacts` entry needs text.
async function inTheWayCheck(ctx: ObserveContext, head: string, target: string): Promise<Fact<null> | Refused> {
  const w = ctx.workspace;
  const diff = await readOut(ctx, changedPathsArgs(head, target, w.objectFormat), STATUS_LISTING_BYTES);
  if ("limited" in diff) return { code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_BYTES" };
  if (!("value" in diff)) return diff;
  const c = discardCandidates(diff.value);
  if (c === "malformed") return MALFORMED;
  if (c === "limit") return unavailable("limit");
  if (c.paths.length === 0) return { value: null };
  // Contract §6 "File facts": a candidate that the channel cannot carry as worktree components refuses with reason `path`.
  const texts = new Map<string, string>();
  for (const path of c.paths) {
    let text: string;
    try {
      text = strict.decode(Buffer.from(path, "latin1"));
    } catch {
      return unavailable("path");
    }
    if (!text.split("/").every(isComponent)) return unavailable("path");
    texts.set(path, text);
  }
  const facts = await requestFacts(ctx.runner, ctx.operationId, w, false, c.paths.map((path) => ({ root: "worktreeRoot", path: texts.get(path)!.split("/") })), ctx.signal);
  if (!Array.isArray(facts)) return "stop" in facts ? facts : { code: facts.code };
  const sorted = sortFacts(c, facts);
  if (sorted === "unknown") return unavailable("unreadable");
  const counted = new Set(sorted.folders);
  for (const batch of batches(sorted.entries, ctx)) {
    const listed = await readOut(ctx, stagesArgs(batch.map((path) => texts.get(path)!)), STATUS_LISTING_BYTES);
    if ("limited" in listed) return { code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_BYTES" };
    if (!("value" in listed)) return listed;
    const left = untrackedOf(batch, listed.value, w.objectFormat);
    if (left === "malformed") return MALFORMED;
    for (const path of left) counted.add(path);
  }
  const ordered = c.paths.filter((path) => counted.has(path));
  if (ordered.length === 0) return { value: null };
  const read = ignoreRead(ordered);
  if (read === "path") return unavailable("path");
  const out = createCollector({ maxBytes: STATUS_LISTING_BYTES });
  const step = await stepOf(ctx, read.args, out, read.input);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT" };
  const verdict = inTheWay(ordered, { exitCode: step.exit.exitCode, stdout: out.take() });
  if (verdict === "malformed") return MALFORMED;
  if (verdict === "failed") return { code: "GIT_FAILED" };
  return verdict === null ? { value: null } : { refused: "UNTRACKED_IN_WAY", result: { reason: "untracked-in-way", ...verdict } };
}

registerWorkbenchAction("switch", {
  precheck(p, w) {
    const t = p.target;
    if ("ref" in t) {
      const name = t.ref.slice(HEADS.length);
      // Research.md R21 F29: Git reads `checkout @ --` as HEAD. Contract Δ3: the switch argv has no end-of-options marker.
      if (name === "@") return unavailable("reserved-name");
      if (name.startsWith("-")) return unavailable("invalid-name");
      return isOneLevelRefName(name) && isRefName(t.ref) ? null : { refused: "INVALID_REQUEST" };
    }
    if ("track" in t) return nameRefusal(t.track.name) ?? (isRefName(t.track.ref) ? null : { refused: "INVALID_REQUEST" });
    return isObjectId(t.detach, w.objectFormat) ? null : { refused: "INVALID_REQUEST" };
  },

  async observe(ctx, p, { head, listing }) {
    const t = p.target;
    if ("ref" in t && head.state !== "detached" && head.target === t.ref) return unavailable("same-branch");
    // `git stash` needs a commit at HEAD, and the in-the-way check reads the tree of HEAD.
    if (head.state === "unborn" && p.choice !== "keep") return unavailable("unborn");
    const status = await trackedStatus(ctx);
    if (!("value" in status)) return status;
    if (status.value.unmerged > 0) return { refused: "CONFLICTED", result: { unmerged: status.value.unmerged } };
    if ("ref" in t) {
      const worktrees = await readWorktrees(ctx);
      if (!("value" in worktrees)) return worktrees;
      const held = heldElsewhere(worktrees.value.records, t.ref, head);
      if (held !== null) return held;
    }
    if ("track" in t) {
      // branch.c `create_branch`: Git writes the start tree before it refuses the tracking setup, so the review refuses first.
      const remotes = trackingRemotes(t.track.ref, listing.entries, ctx.workspace.objectFormat);
      if (remotes === null || remotes.length === 0) return unavailable("no-tracking-refspec");
      if (remotes.length > 1) return unavailable("several-tracking-remotes", { remotes });
      const fresh = await newName(ctx, t.track.name);
      if (!("value" in fresh)) return fresh;
    }
    const target = "detach" in t ? await detachCommit(ctx, t.detach) : await refCommit(ctx, "ref" in t ? t.ref : t.track.ref);
    if (!("value" in target)) return target;
    // Plan.md D3: no output means that no ref holds the detached commit.
    let unreachable: string | null = null;
    if (head.state === "detached") {
      const holders = await readOut(ctx, containsArgs(head.oid, ctx.workspace.objectFormat), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
      if ("limited" in holders) return { code: "OUTPUT_LIMIT", reason: "DIAGNOSTIC_RETAINED_BYTES_PER_STREAM" };
      if (!("value" in holders)) return holders;
      if (holders.value.length === 0) unreachable = head.oid;
    }
    const stash = await stashValue(ctx);
    if (!("value" in stash)) return stash;
    if (p.choice === "discard" && head.state !== "unborn") {
      const way = await inTheWayCheck(ctx, head.oid, target.value);
      if (!("value" in way)) return way;
    }
    const bound: SwitchBound = { target: target.value, tracked: { digest: status.value.digest, count: status.value.count }, stash: stash.value, unreachable };
    const shown = "ref" in t ? { local: t.ref } : "track" in t ? { track: t.track } : { detach: t.detach };
    return { bound, plan: { target: shown, trackedChanges: status.value.count, unreachable, heldBy: null, choice: p.choice, inTheWay: null } };
  },

  started: () => "switch",

  async run(r, p, b: SwitchBound) {
    const { ctx, q } = r;
    const of = ctx.workspace.objectFormat;
    const t = p.target;
    const name = "ref" in t ? t.ref.slice(HEADS.length) : "track" in t ? t.track.name : null;
    const head = r.common.head;
    const ends: StepEnd[] = [];
    const step = async (args: string[], phase: "switch-stash" | "switch-checkout" | "switch-reapply" | "switch-drop") => {
      const end = await r.step(args, phase);
      ends.push(end);
      return end;
    };
    let stashed: string | null = null;
    let kept: Kept | null = null;
    let failed: StepEnd | null = null;
    let done = false;

    // Keep runs the plain checkout. Plan.md D3: an exit 0 push that leaves `refs/stash` equal to P runs it too.
    let proceed = p.choice === "keep";
    if (!proceed) {
      const pushed = await step(stashPushArgs(name ?? b.target), "switch-stash");
      if (pushed.exit?.exitCode !== 0) failed = pushed;
      else if (head.state !== "unborn") {
        const seen = await stashOf(ctx, b.stash, head.oid);
        if ("value" in seen && seen.value !== "changed") {
          stashed = seen.value;
          proceed = true;
        }
      }
    }
    if (proceed) {
      const checkout = await step("ref" in t ? switchArgs(name!) : "track" in t ? trackArgs(t.track.name, t.track.ref) : detachArgs(b.target, of), "switch-checkout");
      const ok = checkout.exit?.exitCode === 0;
      if (!ok) failed = checkout;
      if (stashed === null) done = ok;
      else {
        // Stash and reapply: a failed checkout reapplies nothing. Discard: a refused checkout reapplies S at once on the unchanged HEAD.
        const reapply = ok ? p.choice === "stash" : p.choice === "discard" && checkout.exit !== null && checkout.exit.exitCode !== null;
        let applied = ok && p.choice === "discard";
        if (reapply) {
          const apply = await step(stashApplyArgs(stashed, of), "switch-reapply");
          // Spec FR-012: a fresh index read decides, not Git's message.
          const index = await indexState(q);
          if ("value" in index && index.value.unmerged > 0) kept = "conflicts";
          else if (apply.exit?.exitCode !== 0 || !("value" in index)) kept = "failed-apply";
          else applied = true;
          if (kept !== null && ok) failed = apply;
        } else if (!ok) kept = "failed-checkout";
        if (applied) {
          // Plan.md D3 drop step: the one reflog entry n whose object ID is S.
          const entries = await stashEntries(ctx);
          const at = "value" in entries && entries.value.complete ? entries.value.oids.flatMap((oid, n) => (oid === stashed ? [n] : [])) : [];
          const drop = at.length === 1 ? await step(stashDropArgs(at[0]!), "switch-drop") : null;
          if (drop?.exit?.exitCode !== 0) kept = "not-found";
          done = ok && kept === null;
        }
      }
    }

    const settled = await r.reconcile(ends);
    if (settled === null) return r.unknown({ code: "GIT_FAILED" }, { action: "switch" });
    const [observed, status] = await Promise.all([observe(q, killed(ends)), trackedStatus(q)]);
    // 001 contract §5 "Deadline outcomes": a read at its deadline closes the Job of the other read.
    if (!("value" in observed) || !("value" in status)) return r.unknown(firstEnd([observed, status].map((f) => ("value" in f ? null : f)), isDeadlineStop)!, { action: "switch" });
    const o = observed.value;
    const now = o.refs.get(refKey(STASH)) ?? null;
    let stash: { oid: string | null; state: string } | null = null;
    if (stashed !== null) {
      // A missing `refs/stash` holds no entry, and Git's `log -g` refuses it.
      const entries = now === null ? { value: { oids: [], complete: true } } : await stashEntries(q);
      if (!("value" in entries)) return r.unknown(entries, { action: "switch" });
      const present = entries.value.oids.includes(stashed) || !entries.value.complete;
      stash = { oid: stashed, state: present ? `kept-${kept ?? "not-found"}` : "dropped" };
    } else if (p.choice !== "keep" && now !== b.stash) stash = { oid: now, state: "kept-stash-changed" };
    // Data-model §3 `remedy`: the stash holds changes that are not in the working files.
    const remedy = stash?.state === "kept-failed-apply" || stash?.state === "kept-failed-checkout" ? r.remedy("& {git} --no-lazy-fetch -C {root} stash apply {oid}", { oid: { kind: "commitId", text: stashed! } }) : undefined;
    const result = { action: "switch", head: o.head, refs: changedRefs(r.before.refs, o.refs), stash, conflicted: o.index.unmerged, ...(remedy === undefined ? {} : { remedy: { text: STASH_REMEDY_TEXT, command: remedy } }) };
    const intendedHead: Head = "detach" in t ? { state: "detached", oid: b.target } : { state: "branch", target: `${HEADS}${name}`, oid: b.target };
    const expected = new Map(r.before.refs);
    if ("track" in t) expected.set(refKey(`${HEADS}${name}`), b.target);
    conclude(
      r,
      {
        done,
        intended: !o.lock && Bun.deepEquals(o.head, intendedHead, true) && o.state === "normal" && o.index.unmerged === 0 && changes(expected, o.refs).length === 0 && (stash === null || stash.state === "dropped"),
        changed: o.lock || result.refs.length > 0 || !Bun.deepEquals(o.head, head, true) || o.index.fingerprint !== r.before.index.fingerprint || o.state !== r.before.state || status.value.digest !== b.tracked.digest,
        canceled: settled.canceled,
        failed,
      },
      result,
    );
  },
});
