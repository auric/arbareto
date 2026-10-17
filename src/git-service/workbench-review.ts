// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `reviewWorkbench` and `runWorkbench`, data-model §2, and plan.md D2.
// Each action module registers its reads and steps with `registerWorkbenchAction`. A token is one use, and `runWorkbench` consumes it only after validation.

import type { MutationStarted } from "../contracts/channel";
import type { Phase, Response, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode, WorkbenchUnavailableReason } from "../contracts/errors";
import { APPROVAL_LIFETIME_MS, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, WORKTREE_LISTING_BYTES, WORKTREE_RECORDS } from "../contracts/limits";
import type { OperationEvent } from "../contracts/outcome";
import { buildRemedyCommand, type RemedyValue } from "../contracts/remedy-command";
import { isObjectId } from "./commands";
import type { Exclusion } from "./exclusion";
import { createCollector, PROCESS_LIMITS, RunnerRefusal, type GitExit, type GitRunner } from "./git-runner";
import { captureHead, sharedListing, type HistoryReaderOptions, type ReadHistoryTarget } from "./history";
import { enterReconciling, isStop, notEntered, settled, stepOf, type Fact, type Failure, type ObserveContext, type Stop } from "./hunk-publish";
import type { OperationRegistry } from "./operations";
import { contextOf, latin1 } from "./read-steps";
import type { Workspace } from "./registration";
import type { Head, OperationState, ReadInstallation } from "./snapshot";
import type { WorkspaceReader } from "./status";
import { stepStderr } from "./submodule-update";
import { indexState, listRefs, type IndexState, type ReviewOutcome } from "./sync-review";
import type { ListingOutcome, Trust, TrustListing } from "./trust";
import { refCommitArgs, worktreeListArgs } from "./workbench-commands";
import { parseWorktrees, type WorktreeRecord } from "./workbench-parsers";
import { processEnd } from "./wsl-files";

export type WorkbenchPayload = Extract<ServiceRequest, { operation: "reviewWorkbench" }>["payload"];
export type WorkbenchAction = WorkbenchPayload["action"];
export type PayloadOf<A extends WorkbenchAction> = Extract<WorkbenchPayload, { action: A }>;
type RunRequest = Extract<ServiceRequest, { operation: "runWorkbench" }>;

// Contract Δ3 "Every review reads": the HEAD capture, the operation markers, and the trust listing.
export interface Common {
  head: Head;
  operationState: OperationState;
  listing: TrustListing;
}

// A refusal before any token. `result` holds the reason and its facts.
export type Refused = { refused: ErrorCode; result?: Record<string, unknown> };
export type Observation<B> = { bound: B; plan: Record<string, unknown> } | Refused | Failure | Stop;

export const unavailable = (reason: WorkbenchUnavailableReason, extra: Record<string, unknown> = {}): Refused => ({ refused: "WORKBENCH_UNAVAILABLE", result: { reason, ...extra } });

// One `integrate` step. `exit` is null when no process started or the runner refused it.
export interface StepEnd {
  exit: GitExit | null;
  canceled: boolean;
  refused: ErrorCode | null;
  outputTail: string;
}

// The step helpers of one `runWorkbench` operation. `q` reads with a signal that never aborts (contract §8).
export interface WorkbenchRun {
  ctx: ObserveContext;
  q: ObserveContext;
  common: Common;
  // The refs, HEAD, index, and markers right before the first step.
  before: Observed;
  // A step after a Cancel starts no process and ends `canceled`.
  step(args: string[], phase: Phase): Promise<StepEnd>;
  // Enters `reconciling` after the steps. Null: a WSL step gave no process-end fact, so the outcome stays unknown.
  reconcile(ends: readonly StepEnd[]): Promise<{ canceled: boolean } | null>;
  finish(event: OperationEvent, result: unknown): void;
  unknown(f: Failure | Stop, result: unknown): void;
  // Contract §4 "Quoting rule": the remedy command, or null for a WSL Git or no selected Git.
  remedy(template: string, values: Record<string, RemedyValue>): string | null;
}

export interface WorkbenchHandler<A extends WorkbenchAction, B> {
  // Contract Δ3 refusals from the payload alone. They come before any Git process.
  precheck?(payload: PayloadOf<A>, w: Workspace): Refused | null;
  observe(ctx: ObserveContext, payload: PayloadOf<A>, common: Common): Promise<Observation<B>>;
  // Contract Δ6: the `action` of the `started` frame.
  started(payload: PayloadOf<A>): NonNullable<MutationStarted["action"]>;
  run(r: WorkbenchRun, payload: PayloadOf<A>, bound: B): Promise<void>;
}

const handlers = new Map<string, WorkbenchHandler<WorkbenchAction, unknown>>();

// The dispatcher of contract Δ3. An action without a handler gets SERVICE_UNAVAILABLE.
export function registerWorkbenchAction<A extends WorkbenchAction, B>(action: A, handler: WorkbenchHandler<A, B>): void {
  handlers.set(action, handler as unknown as WorkbenchHandler<WorkbenchAction, unknown>);
}

// Contract Δ3 "Common refusals": these actions also run while an operation is in progress. `worktree-remove` checks its own worktree.
const IN_PROGRESS_ALLOWED: ReadonlySet<string> = new Set(["choose-side", "mergetool", "ignore", "config-save", "worktree-prune", "worktree-remove"]);

// ---- Shared reads ----

// One read with bounded output. A nonzero exit gives GIT_FAILED.
export async function readOut(ctx: ObserveContext, args: string[], maxBytes = DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, input?: Uint8Array): Promise<Fact<Uint8Array>> {
  const out = createCollector({ maxBytes });
  const step = await stepOf(ctx, args, out, input);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT" };
  return step.exit.exitCode === 0 ? { value: out.take() } : { code: "GIT_FAILED" };
}

// `rev-parse --verify -q <ref>^{commit}`: one object ID and LF.
export async function refOid(ctx: ObserveContext, ref: string): Promise<Fact<string>> {
  const read = await readOut(ctx, refCommitArgs(ref));
  if (!("value" in read)) return read;
  const text = latin1(read.value);
  return text.endsWith("\n") && isObjectId(text.slice(0, -1), ctx.workspace.objectFormat) ? { value: text.slice(0, -1) } : { code: "MALFORMED_GIT_OUTPUT" };
}

// Contract Δ3 `readWorktrees` with its Δ5 bounds. `digest` binds the listing bytes.
export async function readWorktrees(ctx: ObserveContext): Promise<Fact<{ records: WorktreeRecord[]; digest: string }>> {
  const read = await readOut(ctx, worktreeListArgs(), WORKTREE_LISTING_BYTES);
  if (!("value" in read)) return read;
  const records = parseWorktrees(read.value, ctx.workspace.objectFormat);
  if (records === null) return { code: "MALFORMED_GIT_OUTPUT" };
  if (records.length > WORKTREE_RECORDS) return { code: "OUTPUT_LIMIT" };
  return { value: { records, digest: new Bun.CryptoHasher("sha256").update(read.value).digest("hex") } };
}

// The record of another worktree that holds `ref`. A worktree record holds one branch, so the current record holds only the HEAD branch.
export function heldElsewhere(records: readonly WorktreeRecord[], ref: string, head: Head): WorktreeRecord | null {
  if (head.state !== "detached" && head.target === ref) return null;
  return records.find((r) => r.branch === ref) ?? null;
}

// Contract Δ3 `runWorkbench` step 4: the refs listing, HEAD, the index, and the markers.
export interface Observed {
  refs: Map<string, string>;
  head: Head;
  index: IndexState;
  state: OperationState;
}

export async function observeRepository(q: ObserveContext): Promise<Fact<Observed>> {
  const [refs, head, index] = await Promise.all([listRefs(q), settled(q.signal, captureHead(q.runner, q)), indexState(q)]);
  if (!("value" in refs)) return refs;
  if (isStop(head) || "code" in head) return head;
  if ("failed" in head) return { code: head.failed };
  if (!("value" in index)) return index;
  const state = await settled(q.signal, q.reader.operationState(q, index.value.unmerged > 0));
  if (typeof state === "object") return "refused" in state ? { code: state.refused } : state;
  if (state === "canceled" || state === "deadline") return { stop: state };
  return { value: { refs: refs.value, head, index: index.value, state } };
}

// Data-model §7 rows after the steps. `done`: every step ran and exited 0. `failed`: the step that stopped the action.
export function conclude(r: WorkbenchRun, f: { done: boolean; intended: boolean; changed: boolean; canceled: boolean; failed: StepEnd | null }, result: Record<string, unknown>): void {
  const tail = !f.done && f.failed !== null ? { outputTail: f.failed.outputTail } : {};
  if (f.done) return r.finish(f.intended ? { type: "intended-effects-confirmed" } : { type: "differing-effects" }, result);
  if (f.changed) return r.finish({ type: "failed-with-effects" }, { ...result, ...tail });
  if (f.canceled) return r.finish({ type: "no-effects", observed: "canceled" }, result);
  const end = f.failed;
  // Undefined takes the recorded DEADLINE cause.
  const code: ErrorCode | undefined = end?.refused ?? (end?.exit?.deadline !== undefined ? undefined : end?.exit?.diagnosticLimit ? "OUTPUT_LIMIT" : "GIT_FAILED");
  r.finish({ type: "no-effects", observed: "failed", ...(code === undefined ? {} : { code }) }, { ...result, ...tail });
}

// ---- Tokens (data-model §2) ----

interface Issued {
  repositoryId: string;
  generation: number;
  payload: WorkbenchPayload;
  head: Head;
  operationState: OperationState;
  trust: { fingerprint: string; required: boolean };
  bound: unknown;
  issuedAt: number;
  consumed: string | null;
}

type Accepted = { ok: true; entry: Issued } | { ok: false; code: "UNKNOWN_TARGET" | "APPROVAL_EXPIRED" } | { ok: false; consumed: string };

type Full = { common: Common; bound: unknown; plan: Record<string, unknown> };

export interface WorkbenchOptions extends Pick<HistoryReaderOptions, "listingTuple"> {
  runner: GitRunner;
  trust: Trust;
  reader: Pick<WorkspaceReader, "operationState">;
  registry: OperationRegistry;
  exclusion: Exclusion;
  respond: (response: Response) => unknown;
  // Test seam only. Production uses the monotonic `performance.now()` for the 60 s lifetime.
  now?: () => number;
}

export function createWorkbench(o: WorkbenchOptions) {
  const { registry } = o;
  const now = o.now ?? (() => performance.now());
  const tokens = new Map<string, Issued>();

  // Contract §9 acceptance order: a consumed token answers the repeat before any other check.
  function accept(token: string): Accepted {
    const e = tokens.get(token);
    if (e === undefined) return { ok: false, code: "UNKNOWN_TARGET" };
    if (e.consumed !== null) return { ok: false, consumed: e.consumed };
    if (now() - e.issuedAt > APPROVAL_LIFETIME_MS) return { ok: false, code: "APPROVAL_EXPIRED" };
    return { ok: true, entry: e };
  }

  // Contract Δ3 reads. `list` gives the trust listing: shared or own for a review, own for `runWorkbench`.
  async function observe(ctx: ObserveContext, payload: WorkbenchPayload, list: () => Promise<ListingOutcome>): Promise<Full | Refused | Failure | Stop> {
    const handler = handlers.get(payload.action)!;
    const listed = await settled(ctx.signal, list());
    if (!("ok" in listed)) return listed;
    if (!listed.ok) return "stop" in listed ? { stop: listed.stop } : { code: listed.code };
    // shortcut: the class `sync` covers every hook and filter of these steps until T034 adds the class `workbench` to trust.ts.
    const gate = ctx.trust.gate(ctx.workspace, listed.listing, ctx.installation, "sync");
    if (gate !== null) return { refused: gate };
    const head = await settled(ctx.signal, captureHead(ctx.runner, ctx));
    if (isStop(head) || "code" in head) return head;
    if ("failed" in head) return { code: head.failed };
    const state = await settled(ctx.signal, ctx.reader.operationState(ctx, false));
    if (typeof state === "object") return "refused" in state ? { code: state.refused } : state;
    if (state === "canceled" || state === "deadline") return { stop: state };
    // Feature 003 plan.md D7: `unknown` is an unreadable marker or `rebase-apply/applying`, so no operation kind is known.
    if (state === "unknown" && !IN_PROGRESS_ALLOWED.has(payload.action)) return unavailable("unknown-operation");
    if (state !== "normal" && !IN_PROGRESS_ALLOWED.has(payload.action)) return { refused: "OPERATION_IN_PROGRESS" };
    const common: Common = { head, operationState: state, listing: listed.listing };
    const observed = await handler.observe(ctx, payload, common);
    return "bound" in observed ? { common, bound: observed.bound, plan: observed.plan } : observed;
  }

  // Data-model §2: a trust difference gives TRUST_REQUIRED or TRUST_CHANGED, and any other difference STALE_REVIEW.
  function staleOf(e: Issued, again: Full | Refused | Failure | Stop, generation: number): { code: ErrorCode; result?: unknown } | Stop | null {
    if (isStop(again) || "code" in again) return again;
    if ("refused" in again) {
      if (again.refused === "TRUST_REQUIRED" || again.refused === "TRUST_CHANGED") return { code: again.refused };
      return again.refused === "CONFLICTED" ? { code: "CONFLICTED", result: again.result } : { code: "STALE_REVIEW" };
    }
    const required = again.common.listing.approvalRequired.sync;
    if ((e.trust.required || required) && again.common.listing.fingerprint !== e.trust.fingerprint) return { code: "TRUST_CHANGED" };
    const same = generation === e.generation && Bun.deepEquals({ head: e.head, state: e.operationState, bound: e.bound }, { head: again.common.head, state: again.common.operationState, bound: again.bound }, true);
    return same ? null : { code: "STALE_REVIEW" };
  }

  async function execute(w: Workspace, installation: ReadInstallation, operationId: string, signal: AbortSignal, token: string, e: Issued): Promise<void> {
    const handler = handlers.get(e.payload.action)!;
    let entered;
    try {
      entered = await o.exclusion.enter({ operationId, kind: "workbench", action: handler.started(e.payload), workspace: w });
    } catch {
      return void registry.apply(operationId, { type: "exclusion-unavailable", code: "GIT_FAILED" });
    }
    if (!entered.ok) return notEntered(registry, operationId, entered);
    const marker = entered;
    const ctx: ObserveContext = { runner: o.runner, trust: o.trust, reader: o.reader, operationId, signal, workspace: w, installation };
    // Contract §8: a cancel never stops a reconciliation read.
    const q: ObserveContext = { ...ctx, signal: new AbortController().signal };
    const resolved = () => o.runner.resolved(marker.markerId);
    let lastDescendants = 0;

    // A refusal before any step: no effect, so the outcome is known.
    const refuse = (ending: { code: ErrorCode; result?: unknown } | Stop) => {
      const canceled = enterReconciling(registry, operationId, isStop(ending) && ending.stop === "deadline", 0);
      if (canceled) registry.apply(operationId, { type: "no-effects", observed: "canceled" });
      else if (isStop(ending)) registry.apply(operationId, { type: "no-effects", observed: "failed", ...(ending.stop === "deadline" ? {} : { code: "GIT_FAILED" }) });
      else registry.apply(operationId, { type: "no-effects", observed: "failed", code: ending.code }, ending.result);
      resolved();
    };

    const runOf = (common: Common, before: Observed): WorkbenchRun => ({
      ctx,
      q,
      common,
      before,
      async step(args, phase) {
        if (signal.aborted) return { exit: null, canceled: true, refused: null, outputTail: "" };
        registry.progress(operationId, phase);
        const stdout = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
        const stderr = stepStderr(() => {});
        let exit: GitExit | null = null;
        let refused: ErrorCode | null = null;
        try {
          exit = await o.runner.run({ operationId, context: contextOf(w), arguments: args, environmentPolicy: "integrate", limits: PROCESS_LIMITS.network, stdout, stderr, signal });
          lastDescendants = exit.activeDescendants ?? 0;
        } catch (error) {
          if (!signal.aborted && !(error instanceof RunnerRefusal)) throw error;
          if (!signal.aborted) refused = (error as RunnerRefusal).code;
        }
        return { exit, canceled: signal.aborted && (exit === null || exit.exitCode === null), refused, outputTail: stderr.outputTail() };
      },
      async reconcile(ends) {
        const canceled = enterReconciling(registry, operationId, ends.some((end) => end.exit?.deadline !== undefined), lastDescendants);
        // Contract §11 and 001 §12: after a stopped WSL process, Linux Git can still write. No read decides before the process-end fact.
        const ended = w.wsl === undefined || ends.every((end) => end.exit !== null && end.exit.exitCode !== null) || (await processEnd(q)) === "fact";
        return ended ? { canceled } : null;
      },
      finish(event, result) {
        registry.apply(operationId, event, result);
        resolved();
      },
      unknown(f, result) {
        registry.apply(operationId, "code" in f ? { type: "reconciliation-read-failed", code: f.code } : { type: "reconciliation-read-deadline" }, result, "code" in f ? f.code : "DEADLINE");
      },
      remedy(template, values) {
        const git = installation.selectedPath;
        if (git === null || w.wsl !== undefined) return null;
        return buildRemedyCommand(template, { git: { kind: "gitPath", text: git, form: "windows" }, root: { kind: "worktreeRoot", text: w.worktreeRoot, form: "windows" }, ...values }).command;
      },
    });

    try {
      registry.apply(operationId, { type: "marker-recorded" });
      registry.progress(operationId, "preflight");
      // Contract Δ3 `runWorkbench` step 2: every bound value again, from an own trust listing.
      const again = await observe(ctx, e.payload, () => o.trust.listTrust({ operationId, signal, workspace: w }));
      const stale = staleOf(e, again, w.generation);
      if (stale !== null) return refuse(stale);
      const later = accept(token);
      if (!later.ok) return refuse({ code: "code" in later ? later.code : "UNKNOWN_TARGET" });
      e.consumed = operationId;
      const full = again as Full;
      const before = await observeRepository(ctx);
      if (!("value" in before)) return refuse(isStop(before) ? before : { code: before.code });
      await handler.run(runOf(full.common, before.value), e.payload, full.bound);
    } catch {
      // A broken step leaves the outcome unknown. The marker stays (contract §8).
      const state = registry.get(operationId)?.state;
      if (state === "running") registry.apply(operationId, { type: "execution-ended", lingeringDescendants: 0 });
      if (state === "cancel-requested") registry.apply(operationId, { type: "processes-stopped" });
      if (registry.get(operationId)?.state === "reconciling") registry.apply(operationId, { type: "reconciliation-read-failed", code: "GIT_FAILED" }, undefined, "GIT_FAILED");
    } finally {
      marker.end(false);
    }
  }

  return {
    handles: (action: string): boolean => handlers.has(action),

    // Contract §8 "Token invalidation": a refresh read and a workspace release end every unused token of the repository.
    invalidate(repositoryId: string): void {
      for (const [key, e] of tokens) if (e.consumed === null && e.repositoryId === repositoryId) tokens.delete(key);
    },

    // Contract Δ3 refusals from the payload alone. The caller answers them before it schedules any Git process.
    precheck: (payload: WorkbenchPayload, w: Workspace): Refused | null => handlers.get(payload.action)?.precheck?.(payload, w) ?? null,

    // Contract Δ3 `reviewWorkbench`. A refusal issues no token.
    async review(t: ReadHistoryTarget, payload: WorkbenchPayload): Promise<ReviewOutcome> {
      const ctx: ObserveContext = { runner: o.runner, trust: o.trust, reader: o.reader, operationId: t.operationId, signal: t.signal, workspace: t.workspace, installation: t.installation };
      const observed = await observe(ctx, payload, () => sharedListing({ trust: o.trust, listingTuple: o.listingTuple }, t));
      if (isStop(observed)) return { result: observed.stop };
      if ("code" in observed) return { result: "failed", code: observed.code };
      if ("refused" in observed) return { result: "failed", code: observed.refused, ...(observed.result === undefined ? {} : { value: observed.result }) };
      const at = now();
      for (const [key, old] of tokens) if (old.consumed === null && at - old.issuedAt > APPROVAL_LIFETIME_MS) tokens.delete(key);
      const workbenchToken = crypto.randomUUID();
      const { head, operationState, listing } = observed.common;
      tokens.set(workbenchToken, {
        repositoryId: t.workspace.repositoryId,
        generation: t.generation,
        payload,
        head,
        operationState,
        trust: { fingerprint: listing.fingerprint, required: listing.approvalRequired.sync },
        bound: observed.bound,
        issuedAt: at,
        consumed: null,
      });
      return { result: "succeeded", value: { action: payload.action, plan: observed.plan, workbenchToken } };
    },

    // Contract Δ3 `runWorkbench`. `installation` is the Git of the workspace.
    run(request: RunRequest, w: Workspace, installation: ReadInstallation): void {
      const token = request.payload.workbenchToken;
      // Contract §2: a consumed token answers a repeat with its operation, without an accepted event or a process.
      const peek = accept(token);
      if (!peek.ok && "consumed" in peek && tokens.get(token)!.repositoryId === request.repositoryId) {
        return void o.respond({ requestId: request.requestId, operationId: peek.consumed, state: "succeeded", result: registry.get(peek.consumed) });
      }
      const { operationId, signal } = registry.start("runWorkbench", request.requestId);
      const accepted = accept(token);
      if (!accepted.ok) return void registry.apply(operationId, { type: "invalid-approval", code: "code" in accepted ? accepted.code : "UNKNOWN_TARGET" });
      const e = accepted.entry;
      if (e.repositoryId !== request.repositoryId) return void registry.apply(operationId, { type: "invalid-approval", code: "UNKNOWN_TARGET" });
      // Contract Δ7 "Mutation trust": the reviewed listing decides before any process.
      const gate = o.trust.gate(w, { approvalRequired: { sync: e.trust.required }, fingerprint: e.trust.fingerprint, inputLimited: false }, installation, "sync");
      if (gate !== null) return void registry.apply(operationId, { type: "invalid-approval", code: gate });
      void execute(w, installation, operationId, signal, token, e);
    },
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;
