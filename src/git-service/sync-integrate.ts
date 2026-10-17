// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 003 contract Δ3 `sync` steps of `pull`, `integrate`, `abort`, `continue`, and `skip`, data-model §6 to §8, and plan.md D6 and D7.
// Cancel is never rollback. Each outcome comes from exit codes, porcelain fields, the markers, and the refs, HEAD, and index reads around each step.

import type { ErrorCode, SyncUnavailableReason } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, HISTORY_COMMIT_OBJECT_BYTES, SYNC_REFS_BYTES } from "../contracts/limits";
import type { OperationEvent } from "../contracts/outcome";
import { batchCommandArgs, type ObjectFormat } from "./commands";
import { createCollector, RunnerRefusal, type Collector, type PageantReply } from "./git-runner";
import { captureHead } from "./history";
import { HEADER_BYTES, parseCommitObjects } from "./history-parser";
import { isStop, settled, stepOf, type Fact, type Failure, type ObserveContext, type Stop } from "./hunk-publish";
import type { Head, OperationState } from "./snapshot";
import { abortArgs, aheadBehindArgs, continueArgs, fastForwardArgs, fetchArgs, mergeArgs, mergeMessageArgs, rebaseArgs, skipArgs } from "./sync-commands";
import { decidePull, FETCH_FLAGS, parseAheadBehind, type FetchFlag, type FetchList, type FetchUpdate, type ModeSource, type PullDecision } from "./sync-parsers";
import { gitPathExists, indexState, listRefs, refKey, type IndexState, type SyncBinding } from "./sync-review";
import type { Remedy, StepEnd } from "./sync";
import type { ConfigEntry } from "./trust";

type Refs = Map<string, string>;
export type StepPhase = "sync-fetch" | "sync-merge" | "sync-rebase" | "sync-push" | "sync-continue";

// The step helpers of one `sync` operation (`sync.ts` `execute`). `q` reads with a signal that never aborts (contract §8).
export interface SyncSteps {
  ctx: ObserveContext;
  q: ObserveContext;
  binding: SyncBinding;
  entries: readonly ConfigEntry[];
  refuse(ending: { code: ErrorCode; reason?: Failure["reason"]; result?: unknown } | Stop): void;
  finish(event: OperationEvent, result: unknown): void;
  unknown(f: Failure | Stop, result: unknown): void;
  // Enters `reconciling`. True: the operation passed `cancel-requested`.
  enter(deadline: boolean): boolean;
  pageant(remote: string, counters: Record<string, number>): Promise<PageantReply | null>;
  step(args: string[], phase: StepPhase, counters: Record<string, number>, remedy: Remedy, stdout: Collector, policy: "remote" | "integrate"): Promise<StepEnd>;
  remedyOf(template: string, values: Record<string, string>, userInfo: boolean): Remedy;
  processEnded(ends: readonly StepEnd[]): Promise<boolean>;
  keepTarget(kind: "remote", target: string): void;
  holdsUserInfo(entries: readonly ConfigEntry[], remote: string): boolean;
  fetchLines(bytes: Uint8Array, objectFormat: ObjectFormat): FetchList | null;
  changes(before: Refs, after: Refs): { ref: string; oldObjectId: string | null; newObjectId: string | null }[];
}

export const INTEGRATIONS: readonly string[] = ["pull", "integrate", "abort", "continue", "skip"];

const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/";
const ZERO_OID = /^0+$/;
const exact = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Data-model §7.
type Integration =
  | { state: "none" | "up-to-date" | "mode-required" | "done" }
  | { state: "stopped"; operation: "merging" | "rebasing"; unmerged: number }
  | { state: "refused"; outputTail: string };

interface Observed {
  refs: Refs;
  head: Head;
  index: IndexState;
  state: OperationState;
  // Contract §8: a killed Git can leave its `index.lock`, and then the working files can hold a partial checkout.
  lock: boolean;
}

const headFact = (h: Awaited<ReturnType<typeof captureHead>> | Stop | Failure): Fact<Head> => (isStop(h) ? h : "code" in h ? h : "failed" in h ? { code: h.failed } : { value: h });

// Contract Δ3 `sync` step 7: the refs listing, HEAD, the index, the markers, and the unmerged count.
async function observe(q: ObserveContext, killed: boolean): Promise<Fact<Observed>> {
  const [refs, head, index] = await Promise.all([listRefs(q), settled(q.signal, captureHead(q.runner, q)).then(headFact), indexState(q)]);
  if (!("value" in refs)) return refs;
  if (!("value" in head)) return head;
  if (!("value" in index)) return index;
  const state = await settled(q.signal, q.reader.operationState(q, index.value.unmerged > 0));
  if (typeof state === "object") return "refused" in state ? { code: state.refused } : state;
  if (state === "canceled" || state === "deadline") return { stop: "deadline" };
  const lock = killed ? await gitPathExists(q, "index.lock") : { value: false };
  if (!("value" in lock)) return lock;
  return { value: { refs: refs.value, head: head.value, index: index.value, state, lock: lock.value } };
}

// The parents of one commit from `cat-file --batch-command -Z`.
async function parentsOf(q: ObserveContext, oid: string): Promise<Fact<string[]>> {
  const out = createCollector({ maxBytes: HISTORY_COMMIT_OBJECT_BYTES + HEADER_BYTES + 2 });
  const step = await stepOf(q, batchCommandArgs(), out, new TextEncoder().encode(`contents ${oid}\0`));
  if (!("exit" in step)) return step;
  if (out.limited || step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const parsed = parseCommitObjects(out.take(), [oid], q.workspace.objectFormat).objects[0];
  return parsed === undefined ? { code: "MALFORMED_GIT_OUTPUT" } : { value: parsed.parents };
}

// Plan.md D6 step 3 and D8: `rev-list --left-right --count <a>...<b>` with the 30 s read deadline.
async function count(ctx: ObserveContext, a: string, b: string): Promise<Fact<{ ahead: number; behind: number }>> {
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const step = await stepOf(ctx, aheadBehindArgs(a, b, ctx.workspace.objectFormat), out);
  if (!("exit" in step)) return step;
  if (out.limited || step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const counts = parseAheadBehind(out.take());
  return counts === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: counts };
}

// Plan.md D6 step 6. True: the observed HEAD is the result that the decision expects.
async function integrated(q: ObserveContext, d: Extract<PullDecision, { kind: "fast-forward" | "merge" | "rebase" }>, head: Head, branch: string, u: string): Promise<Fact<boolean>> {
  if (head.state !== "branch" || head.target !== `${HEADS}${branch}`) return { value: false };
  if (d.kind === "fast-forward") return { value: head.oid === u };
  if (d.kind === "rebase") {
    const counted = await count(q, head.oid, u);
    return "value" in counted ? { value: counted.value.behind === 0 } : counted;
  }
  if (head.oid === u && d.ff !== "--no-ff") return { value: true };
  const parents = await parentsOf(q, head.oid);
  return "value" in parents ? { value: parents.value.length > 1 && parents.value.includes(u) } : parents;
}

const noCounts = () => Object.fromEntries(FETCH_FLAGS.map((flag) => [flag, 0])) as Record<FetchFlag, number>;

// O-3 and feature 004 plan.md D5: the `fmt-merge-msg` preview of the line that `git merge <short name>` builds for a remote-tracking ref (builtin/merge.c `merge_name`).
// Null: the upstream is no remote-tracking ref, so D5 does not apply and Git writes its own default message.
async function mergeMessage(ctx: ObserveContext, ref: string, oid: string): Promise<Fact<string | null>> {
  if (!ref.startsWith(REMOTES)) return { value: null };
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const step = await stepOf(ctx, mergeMessageArgs(), out, new TextEncoder().encode(`${oid}\t\tremote-tracking branch '${ref.slice(REMOTES.length)}' of .\n`));
  if (!("exit" in step)) return step;
  if (out.limited || step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  try {
    const text = exact.decode(out.take());
    return text === "" || text.includes("\0") ? { code: "MALFORMED_GIT_OUTPUT" } : { value: text };
  } catch {
    return { code: "MALFORMED_GIT_OUTPUT" };
  }
}

// The integrate step of a decision (plan.md D6 step 5).
function integrateStep(d: Extract<PullDecision, { kind: "fast-forward" | "merge" | "rebase" }>, ref: string, message: string | null): { args: string[]; phase: StepPhase } {
  if (d.kind === "fast-forward") return { args: fastForwardArgs(ref), phase: "sync-merge" };
  if (d.kind === "merge") return { args: mergeArgs(ref, d.ff, message), phase: "sync-merge" };
  return { args: rebaseArgs(ref, d.rebaseMerges), phase: "sync-rebase" };
}

// The contract Δ3 remedy of a step. The options are constants, so only the ref and the merge message are remedy values.
// The quoting rule refuses the LF of a merge message, so that remedy is text only (contract §4 "Quoting rule").
function stepRemedy(s: SyncSteps, args: readonly string[], ref?: string): Remedy {
  const at = args.indexOf("-m");
  const words = (ref === undefined ? args.slice(1) : args.slice(1, -1)).map((word, i) => (at > 0 && i === at) ? "{message}" : word);
  const values = { ...(ref === undefined ? {} : { ref }), ...(at > 0 ? { message: args[at + 1]! } : {}) };
  return s.remedyOf(`& {git} --no-lazy-fetch -C {root} ${words.join(" ")}${ref === undefined ? "" : " {ref}"}`, values, false);
}

// Data-model §7: the state after an integrate process. Null: Git was stopped, and no merge or rebase is in progress.
function integrationOf(end: StepEnd, o: Observed): Integration | null {
  if (o.state === "merging" || o.state === "rebasing") return { state: "stopped", operation: o.state, unmerged: o.index.unmerged };
  const exitCode = end.exit?.exitCode ?? null;
  if (exitCode === 0) return { state: "done" };
  return exitCode === null ? null : { state: "refused", outputTail: end.outputTail };
}

// Contract Δ3 `sync` for `pull` and `integrate`, plan.md D6.
async function runPull(s: SyncSteps): Promise<void> {
  const { ctx, q, binding: b } = s;
  const w = ctx.workspace;
  const signal = ctx.signal;
  const payload = b.payload as Extract<SyncBinding["payload"], { action: "pull" | "integrate" }>;
  const action = payload.action;
  const mode = payload.mode ?? null;
  const head = b.head as Extract<Head, { state: "branch" }>;
  const branch = head.target.slice(HEADS.length);
  const upstream = b.upstream!;
  const remote = b.remotes[0]!;

  const listed = await listRefs(ctx);
  if (!("value" in listed)) return s.refuse(listed);
  const before = listed.value;
  const ends: StepEnd[] = [];
  let fetch: { remotes: { name: string; state: string; updates: FetchUpdate[]; counts: Record<FetchFlag, number>; outputTail: string }[]; observed: ReturnType<SyncSteps["changes"]> } | undefined;
  let all: FetchUpdate[] = [];
  let fetchFailure: { code?: ErrorCode; remedy?: Remedy } | null = null;

  // ---- The D3 fetch of a pull ----
  if (action === "pull") {
    const reply = await s.pageant(remote, {}).catch((error: unknown) => {
      if (error instanceof RunnerRefusal) return { result: "refused" as const, code: error.code };
      throw error;
    });
    if (reply !== null && reply.result === "refused") return s.refuse({ code: reply.code });
    if (reply !== null && reply.result === "failed") return s.refuse({ code: "PUTTY_UNAVAILABLE", result: { reason: reply.reason, program: reply.program, path: reply.path } });
    if (signal.aborted) return s.refuse({ stop: "canceled" });
    const remedy = s.remedyOf("& {git} --no-lazy-fetch -C {root} fetch -- {remote}", { remote }, s.holdsUserInfo(s.entries, remote));
    const out = createCollector({ maxBytes: SYNC_REFS_BYTES });
    const end = await s.step(fetchArgs(remote), "sync-fetch", {}, remedy, out, "remote");
    ends.push(end);
    const lines = end.exit === null || out.limited ? null : s.fetchLines(out.take(), w.objectFormat);
    const state = end.canceled ? "canceled" : end.exit?.deadline !== undefined ? "deadline" : end.exit?.exitCode === 0 && lines !== null ? "succeeded" : "failed";
    fetch = { remotes: [{ name: remote, state, updates: lines?.updates ?? [], counts: lines?.counts ?? noCounts(), outputTail: end.outputTail }], observed: [] };
    all = lines?.all ?? [];
    if (state !== "succeeded") {
      const code: ErrorCode | undefined =
        end.refused ?? (end.exit?.deadline !== undefined ? undefined : out.limited || end.exit?.diagnosticLimit ? "OUTPUT_LIMIT" : end.exit?.exitCode === 0 ? "MALFORMED_GIT_OUTPUT" : "GIT_FAILED");
      fetchFailure = { ...(code === undefined ? {} : { code }), ...(state === "failed" ? { remedy } : {}) };
      if (state === "failed" && end.exit?.exitCode !== 0) s.keepTarget("remote", remote);
    }
  }

  // ---- Plan.md D6 steps 2 to 5 ----
  let fetched = before;
  let counts: { ahead: number; behind: number } | undefined;
  let decision: PullDecision | null = null;
  // Why no integrate step started: a refusal reason, a read failure code, or a cancel.
  let stop: { reason?: SyncUnavailableReason; code?: ErrorCode; canceled?: true } | null = null;
  let integrateEnd: StepEnd | null = null;
  let indexBefore: IndexState | null = null;
  let remedy: Remedy | undefined;
  const fail = (f: Failure | Stop) => {
    stop = !isStop(f) ? { code: f.code } : f.stop === "canceled" ? { canceled: true } : { code: "DEADLINE" };
  };
  if (fetchFailure === null) {
    const afterFetch = action === "pull" ? await listRefs(ctx) : { value: before };
    const current = action === "pull" ? headFact(await settled(signal, captureHead(ctx.runner, ctx))) : { value: b.head };
    if (!("value" in afterFetch)) fail(afterFetch);
    else if (!("value" in current)) fail(current);
    else {
      fetched = afterFetch.value;
      const u = fetched.get(refKey(upstream.ref));
      // Another process moved HEAD during the fetch, so the bound counts are stale.
      if (!Bun.deepEquals(current.value, b.head, true)) stop = { code: "STALE_REVIEW" };
      else if (u === undefined) stop = { reason: "upstream-gone" };
      else {
        const counted = await count(ctx, head.oid, u);
        if (!("value" in counted)) fail(counted);
        else {
          counts = counted.value;
          decision = decidePull({ ...counts, branch, mode, config: s.entries });
          if (decision.kind === "refused") stop = { reason: decision.reason };
          else if (decision.kind !== "up-to-date" && decision.kind !== "mode-required") {
            const [index, message] = await Promise.all([indexState(ctx), decision.kind === "merge" ? mergeMessage(ctx, upstream.ref, u) : { value: null }]);
            if (!("value" in index)) fail(index);
            else if (!("value" in message)) fail(message);
            else if (signal.aborted) stop = { canceled: true };
            else {
              indexBefore = index.value;
              const { args, phase } = integrateStep(decision, upstream.ref, message.value);
              remedy = stepRemedy(s, args, upstream.ref);
              integrateEnd = await s.step(args, phase, {}, remedy, createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }), "integrate");
              ends.push(integrateEnd);
            }
          }
        }
      }
    }
  }

  // ---- Plan.md D6 step 6 and data-model §8 ----
  const deadline = ends.some((e) => e.exit?.deadline !== undefined);
  const canceled = s.enter(deadline);
  const modeSource: ModeSource | null | undefined = decision === null || decision.kind === "refused" ? undefined : "source" in decision ? decision.source : null;
  const resultOf = (integration: Integration | null, extra: { reason?: SyncUnavailableReason; remedy?: Remedy } = {}) => ({
    action,
    ...(fetch === undefined ? {} : { fetch }),
    ...(counts === undefined ? {} : { counts }),
    ...(integration === null ? {} : { integration }),
    ...(modeSource === undefined ? {} : { modeSource }),
    ...extra,
  });
  if (!(await s.processEnded(ends))) return s.unknown({ code: "GIT_FAILED" }, resultOf(null));
  const killed = integrateEnd !== null && (integrateEnd.exit === null || integrateEnd.exit.exitCode === null);
  const read = await observe(q, killed);
  if (!("value" in read)) return s.unknown(read, resultOf(null));
  const o = read.value;

  // Data-model §4 `observed`: the listing after the fetch against the listing before with every porcelain line applied.
  if (fetch !== undefined) {
    const expected = new Map(before);
    for (const u of all) {
      if (u.flag === "=" || u.flag === "!") continue;
      if (ZERO_OID.test(u.newObjectId)) expected.delete(refKey(u.ref));
      else expected.set(refKey(u.ref), u.newObjectId);
    }
    fetch.observed = s.changes(expected, fetchFailure === null ? fetched : o.refs);
  }
  const fetchChanged = s.changes(before, fetchFailure === null ? fetched : o.refs).length > 0;
  // Changes after the fetch: refs, HEAD, the operation state, the index, and a left lock.
  const later = s.changes(fetchFailure === null ? fetched : o.refs, o.refs);
  const moved = later.length > 0 || !Bun.deepEquals(o.head, b.head, true) || o.state !== b.operationState || o.lock || (indexBefore !== null && o.index.fingerprint !== indexBefore.fingerprint);
  const changed = fetchChanged || moved;

  if (fetchFailure !== null) {
    if (changed) return s.finish({ type: "failed-with-effects" }, resultOf({ state: "none" }, fetchFailure.remedy === undefined ? {} : { remedy: fetchFailure.remedy }));
    if (canceled) return s.finish({ type: "no-effects", observed: "canceled" }, resultOf({ state: "none" }));
    return s.finish({ type: "no-effects", observed: "failed", ...(fetchFailure.code === undefined ? {} : { code: fetchFailure.code }) }, resultOf({ state: "none" }, fetchFailure.remedy === undefined ? {} : { remedy: fetchFailure.remedy }));
  }

  if (integrateEnd === null) {
    const halted = stop as { reason?: SyncUnavailableReason; code?: ErrorCode; canceled?: true } | null;
    if (halted === null && decision !== null && (decision.kind === "up-to-date" || decision.kind === "mode-required")) {
      return s.finish(moved || (fetch?.observed.length ?? 0) > 0 ? { type: "differing-effects" } : { type: "intended-effects-confirmed" }, resultOf({ state: decision.kind }));
    }
    const reason = halted?.reason;
    // Contract Δ9 `SYNC_UNAVAILABLE`: no process starts after the fetch. SyncResult holds no field for the reason (contract gap), so it goes beside the fields.
    const result = resultOf({ state: "none" }, reason === undefined ? {} : { reason });
    if (changed) return s.finish({ type: "failed-with-effects" }, result);
    if (halted?.canceled || (canceled && halted === null)) return s.finish({ type: "no-effects", observed: "canceled" }, result);
    const code: ErrorCode = reason !== undefined ? "SYNC_UNAVAILABLE" : (halted?.code ?? "GIT_FAILED");
    return s.finish({ type: "no-effects", observed: "failed", code }, result);
  }

  const integration = integrationOf(integrateEnd, o);
  const exitCode = integrateEnd.exit?.exitCode ?? null;
  const failedRemedy = integration?.state === "refused" || integrateEnd.exit?.deadline !== undefined ? { remedy: remedy! } : {};
  if (integration?.state === "done" && o.state === "normal") {
    const d = decision as Extract<PullDecision, { kind: "fast-forward" | "merge" | "rebase" }>;
    const check = await integrated(q, d, o.head, branch, fetched.get(refKey(upstream.ref))!);
    if (!("value" in check)) return s.unknown(check, resultOf(integration));
    // The integration moves only the current branch.
    const expected = new Map(fetched);
    if (o.head.state === "branch") expected.set(refKey(o.head.target), o.head.oid);
    const unexpected = !check.value || s.changes(expected, o.refs).length > 0 || (fetch?.observed.length ?? 0) > 0;
    return s.finish(unexpected ? { type: "differing-effects" } : { type: "intended-effects-confirmed" }, resultOf(integration));
  }
  if (integration?.state === "stopped" || changed) return s.finish({ type: "failed-with-effects" }, resultOf(integration, failedRemedy));
  if (canceled) return s.finish({ type: "no-effects", observed: "canceled" }, resultOf(integration));
  const code: ErrorCode | undefined = integrateEnd.refused ?? (integrateEnd.exit?.deadline !== undefined ? undefined : exitCode !== null && exitCode !== 0 ? "GIT_FAILED" : integrateEnd.exit?.diagnosticLimit ? "OUTPUT_LIMIT" : "GIT_FAILED");
  return s.finish({ type: "no-effects", observed: "failed", ...(code === undefined ? {} : { code }) }, resultOf(integration, failedRemedy));
}

// Contract Δ3 `sync` for `abort`, `continue`, and `skip`, plan.md D7. The kind comes from the bound 001 markers.
async function runConflictAction(s: SyncSteps): Promise<void> {
  const { ctx, q, binding: b } = s;
  const action = b.payload.action as "abort" | "continue" | "skip";
  const kind = b.operationState as "merging" | "rebasing";
  const [listed, index] = await Promise.all([listRefs(ctx), indexState(ctx)]);
  if (!("value" in listed)) return s.refuse(listed);
  if (!("value" in index)) return s.refuse(index);
  if (ctx.signal.aborted) return s.refuse({ stop: "canceled" });
  const args = action === "abort" ? abortArgs(kind) : action === "continue" ? continueArgs(kind) : skipArgs();
  const phase: StepPhase = action === "continue" ? "sync-continue" : kind === "merging" ? "sync-merge" : "sync-rebase";
  const remedy = stepRemedy(s, args);
  const end = await s.step(args, phase, {}, remedy, createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }), "integrate");

  const canceled = s.enter(end.exit?.deadline !== undefined);
  if (!(await s.processEnded([end]))) return s.unknown({ code: "GIT_FAILED" }, { action });
  const killed = end.exit === null || end.exit.exitCode === null;
  const read = await observe(q, killed);
  if (!("value" in read)) return s.unknown(read, { action });
  const o = read.value;
  const integration = integrationOf(end, o);
  const result = { action, ...(integration === null ? {} : { integration }) };
  const changed = s.changes(listed.value, o.refs).length > 0 || !Bun.deepEquals(o.head, b.head, true) || o.state !== b.operationState || o.index.fingerprint !== index.value.fingerprint || o.lock;
  // Data-model §8: Git exited 0 and no merge or rebase remains. Only the branch of the final HEAD may move.
  if (integration?.state === "done") {
    const expected = new Map(listed.value);
    if (o.head.state === "branch" && o.refs.has(refKey(o.head.target))) expected.set(refKey(o.head.target), o.refs.get(refKey(o.head.target))!);
    return s.finish(s.changes(expected, o.refs).length > 0 ? { type: "differing-effects" } : { type: "intended-effects-confirmed" }, result);
  }
  if (changed) return s.finish({ type: "failed-with-effects" }, result);
  if (canceled) return s.finish({ type: "no-effects", observed: "canceled" }, result);
  const code: ErrorCode | undefined = end.refused ?? (end.exit?.deadline !== undefined ? undefined : end.exit?.diagnosticLimit ? "OUTPUT_LIMIT" : "GIT_FAILED");
  return s.finish({ type: "no-effects", observed: "failed", ...(code === undefined ? {} : { code }) }, result);
}

export function runIntegration(s: SyncSteps): Promise<void> {
  const action = s.binding.payload.action;
  return action === "pull" || action === "integrate" ? runPull(s) : runConflictAction(s);
}
