// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `reviewWorkbench` and `runWorkbench`, data-model §2, and plan.md D2.
// Each action module registers its reads and steps with `registerWorkbenchAction`. A token is one use, and `runWorkbench` consumes it only after validation.

import type { MutationStarted, ProcessContext } from "../contracts/channel";
import type { Phase, Response, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode, WorkbenchUnavailableReason } from "../contracts/errors";
import { APPROVAL_LIFETIME_MS, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, WORKTREE_LISTING_BYTES, WORKTREE_RECORDS } from "../contracts/limits";
import type { OperationEvent } from "../contracts/outcome";
import { buildRemedyCommand, type RemedyValue } from "../contracts/remedy-command";
import type { StallRemedy } from "../contracts/submodules";
import type { Exclusion } from "./exclusion";
import { createCollector, PROCESS_LIMITS, RunnerRefusal, type GitExit, type GitRunner } from "./git-runner";
import { captureHead, sharedListing, type HistoryReaderOptions, type ReadHistoryTarget } from "./history";
import { enterReconciling, isStop, settled, type Fact, type Failure, type ObserveContext, type Stop } from "./hunk-publish";
import { reviewIgnore, runIgnore, type IgnorePlan } from "./ignore";
import type { OperationRegistry } from "./operations";
import { contextOf } from "./read-steps";
import type { Workspace } from "./registration";
import type { Head, OperationState, ReadInstallation } from "./snapshot";
import { trackStall } from "./stall";
import type { WorkspaceReader } from "./status";
import { stepStderr } from "./submodule-update";
import { runMarked, STEP_REMEDY_TEXT } from "./sync";
import { observe, type Observed } from "./sync-integrate";
import { parseRevListCount } from "./sync-parsers";
import { listRefs, readOut, refKey, type ReviewOutcome } from "./sync-review";
import type { ListingOutcome, Trust, TrustListing } from "./trust";
import { worktreeListArgs } from "./workbench-commands";
import { parseWorktrees, type WorktreeRecord } from "./workbench-parsers";
import { processEnd } from "./wsl-files";

export type WorkbenchPayload = Extract<ServiceRequest, { operation: "reviewWorkbench" }>["payload"];
export type WorkbenchAction = WorkbenchPayload["action"];
export type PayloadOf<A extends WorkbenchAction> = Extract<WorkbenchPayload, { action: A }>;
type RunRequest = Extract<ServiceRequest, { operation: "runWorkbench" }>;

// The context of a handler. Its reader also maps an entry of a shown snapshot and reads the workspace.
export type WorkbenchContext = ObserveContext & { reader: Pick<WorkspaceReader, "operationState" | "entry" | "readWorkspace"> };

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
  ctx: WorkbenchContext;
  q: WorkbenchContext;
  common: Common;
  // The refs, HEAD, index, and markers right before the first step.
  before: Observed;
  // A step after a Cancel starts no process and ends `canceled`. `context` replaces the registered repository, such as `globalConfig` (contract Δ6).
  step(args: string[], phase: Phase, options?: { context?: ProcessContext; counters?: Record<string, number> }): Promise<StepEnd>;
  // A progress event for a step without a Git process.
  progress(phase: Phase): void;
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
  observe(ctx: WorkbenchContext, payload: PayloadOf<A>, common: Common): Promise<Observation<B>>;
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

// Contract Δ7 "Mutation trust": `ignore` and `config-save` run no repository program, so they need no class. Every other action takes the class `workbench`.
// shortcut: `mergetool` takes `workbench` until T060 adds the class `mergetool` and its handler.
const CLASSLESS: ReadonlySet<string> = new Set(["ignore", "config-save"]);
const classOf = (action: string): "workbench" | null => (CLASSLESS.has(action) ? null : "workbench");

// ---- Shared reads ----

// The exact listing lookup of one ref, as `merge` and `rebase` read their source. A missing ref gives UNKNOWN_TARGET (contract Δ3).
export async function refTarget(ctx: ObserveContext, ref: string): Promise<Fact<string> | Refused> {
  const refs = await listRefs(ctx, ref);
  if (!("value" in refs)) return refs;
  const oid = refs.value.get(refKey(ref));
  return oid === undefined ? { refused: "UNKNOWN_TARGET" } : { value: oid };
}

// One `rev-list --count` read. Its output is one count and LF, so more bytes break the grammar.
export async function revCount(ctx: ObserveContext, args: string[]): Promise<Fact<number>> {
  const out = await readOut(ctx, args, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in out) return { code: "MALFORMED_GIT_OUTPUT" };
  if (!("value" in out)) return out;
  const n = parseRevListCount(out.value);
  return n === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: n };
}

// Contract Δ3 `readWorktrees` with its Δ5 bounds. `digest` binds the listing bytes.
export async function readWorktrees(ctx: ObserveContext): Promise<Fact<{ records: WorktreeRecord[]; digest: string }>> {
  const read = await readOut(ctx, worktreeListArgs(), WORKTREE_LISTING_BYTES);
  if ("limited" in read) return { code: "OUTPUT_LIMIT", reason: "WORKTREE_LISTING_BYTES" };
  if (!("value" in read)) return read;
  const records = parseWorktrees(read.value, ctx.workspace.objectFormat);
  if (records === null) return { code: "MALFORMED_GIT_OUTPUT" };
  if (records.length > WORKTREE_RECORDS) return { code: "OUTPUT_LIMIT", reason: "WORKTREE_RECORDS" };
  return { value: { records, digest: new Bun.CryptoHasher("sha256").update(read.value).digest("hex") } };
}

// The record of another worktree that holds `ref`. A worktree record holds one branch, so the current record holds only the HEAD branch.
export function heldElsewhere(records: readonly WorktreeRecord[], ref: string, head: Head): WorktreeRecord | null {
  if (head.state !== "detached" && head.target === ref) return null;
  return records.find((r) => r.branch === ref) ?? null;
}

// Contract §8: a step whose process was ended can leave `index.lock`, so the reconciliation read checks it.
export const killed = (ends: readonly StepEnd[]): boolean => ends.some((end) => end.exit === null || end.exit.exitCode === null);

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

// ---- Ignore lines (contract Δ3 `ignore`, Δ6 `fileAppend`, plan.md D9) ----

// The token binds the whole plan. Its other fields follow from `expected`, `line`, the target, and the path that Git names (data-model §2).
registerWorkbenchAction<"ignore", IgnorePlan>("ignore", {
  async observe(ctx, p) {
    const w = ctx.workspace;
    const found = ctx.reader.entry(w.repositoryId, w.generation, p.snapshotId, p.entryId);
    if (!found.ok) return { refused: found.code };
    const review = await reviewIgnore(ctx, found.entry, p.target, p.folder === undefined ? null : new Uint8Array(Buffer.from(p.folder, "base64")));
    if (isStop(review)) return review;
    if ("code" in review) return review.reason !== undefined ? { refused: review.code, result: { reason: review.reason } } : review.code === "INVALID_REQUEST" ? { refused: review.code } : { code: review.code };
    const plan = review.plan;
    return { bound: plan, plan: { target: plan.target, path: Buffer.from(plan.path).toString("base64"), folder: plan.folder, line: plan.line, prefixNewline: plan.prefixNewline, expected: plan.expected } };
  },
  started: (p) => (p.target === "gitignore" ? "ignore-gitignore" : "ignore-exclude"),
  async run(r, _p, plan) {
    const { ctx, q } = r;
    r.progress("ignore");
    // Spec FR-046: the status read follows the append.
    const outcome = await runIgnore({ runner: ctx.runner, operationId: ctx.operationId, signal: ctx.signal, workspace: ctx.workspace, appender: ctx.runner }, plan, () =>
      q.reader.readWorkspace({ operationId: q.operationId, signal: q.signal, installation: q.installation, workspace: q.workspace, refresh: false }),
    );
    const settledRun = await r.reconcile([]);
    const result = { action: "ignore", ...(outcome.type === "no-effects" && outcome.reason !== undefined ? { reason: outcome.reason } : {}) };
    if (settledRun === null) return r.unknown({ code: "GIT_FAILED" }, result);
    if (outcome.type === "reconciliation-read-failed") return r.unknown({ code: outcome.code }, result);
    if (outcome.type === "no-effects") return r.finish({ type: "no-effects", observed: outcome.observed, ...(outcome.code === undefined ? {} : { code: outcome.code }) }, result);
    r.finish({ type: outcome.type }, result);
  },
});

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
  // The accepted run that validates the token. Until it consumes the token or ends, a second run gets its repeat answer (contract §2).
  running: string | null;
}

type Accepted = { ok: true; entry: Issued } | { ok: false; code: "UNKNOWN_TARGET" | "APPROVAL_EXPIRED" } | { ok: false; consumed: string };

type Full = { common: Common; bound: unknown; plan: Record<string, unknown> };

export interface WorkbenchOptions extends Pick<HistoryReaderOptions, "listingTuple"> {
  runner: GitRunner;
  trust: Trust;
  reader: WorkbenchContext["reader"];
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

  // Contract §9 acceptance order: a consumed token answers the repeat before any other check. So does a token in use by another run.
  function accept(token: string, self: string | null = null): Accepted {
    const e = tokens.get(token);
    if (e === undefined) return { ok: false, code: "UNKNOWN_TARGET" };
    const holder = e.consumed ?? e.running;
    if (holder !== null && holder !== self) return { ok: false, consumed: holder };
    if (now() - e.issuedAt > APPROVAL_LIFETIME_MS) return { ok: false, code: "APPROVAL_EXPIRED" };
    return { ok: true, entry: e };
  }

  // The class flag of an action in a listing. An action without a class needs no approval.
  const required = (action: string, listing: Pick<TrustListing, "approvalRequired">): boolean => {
    const cls = classOf(action);
    return cls !== null && listing.approvalRequired[cls];
  };

  // Contract Δ3 reads. `list` gives the trust listing: shared or own for a review, own for `runWorkbench`.
  async function observeAll(ctx: WorkbenchContext, payload: WorkbenchPayload, list: () => Promise<ListingOutcome>): Promise<Full | Refused | Failure | Stop> {
    const handler = handlers.get(payload.action)!;
    const listed = await settled(ctx.signal, list());
    if (!("ok" in listed)) return listed;
    if (!listed.ok) return "stop" in listed ? { stop: listed.stop } : { code: listed.code };
    const cls = classOf(payload.action);
    const gate = cls === null ? null : ctx.trust.gate(ctx.workspace, listed.listing, ctx.installation, cls);
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
    if ((e.trust.required || required(e.payload.action, again.common.listing)) && again.common.listing.fingerprint !== e.trust.fingerprint) return { code: "TRUST_CHANGED" };
    const same = generation === e.generation && Bun.deepEquals({ head: e.head, state: e.operationState, bound: e.bound }, { head: again.common.head, state: again.common.operationState, bound: again.bound }, true);
    return same ? null : { code: "STALE_REVIEW" };
  }

  async function execute(w: Workspace, installation: ReadInstallation, operationId: string, signal: AbortSignal, token: string, e: Issued): Promise<void> {
    const handler = handlers.get(e.payload.action)!;
    const context: WorkbenchContext = { runner: o.runner, trust: o.trust, reader: o.reader, operationId, signal, workspace: w, installation };
    await runMarked(o, { operationId, kind: "workbench", action: handler.started(e.payload), workspace: w }, context, async ({ ctx, q, refuse, resolved }) => {
      let lastDescendants = 0;
      const remedy = (template: string, values: Record<string, RemedyValue>): string | null => {
        const git = installation.selectedPath;
        if (git === null || w.wsl !== undefined) return null;
        return buildRemedyCommand(template, { git: { kind: "gitPath", text: git, form: "windows" }, root: { kind: "worktreeRoot", text: w.worktreeRoot, form: "windows" }, ...values }).command;
      };
      // Feature 003 contract Δ3 "Remedies": the stall notice keeps the step command. Each item after `--no-lazy-fetch` is one quoted value.
      const stallRemedy = (args: readonly string[]): StallRemedy => {
        const words = args.slice(1);
        const command = remedy(`& {git} --no-lazy-fetch -C {root} ${words.map((_, i) => `{a${i}}`).join(" ")}`, Object.fromEntries(words.map((text, i) => [`a${i}`, { kind: "argument", text }])));
        return command === null ? { text: STEP_REMEDY_TEXT } : { command, text: STEP_REMEDY_TEXT };
      };

      const runOf = (common: Common, before: Observed): WorkbenchRun => ({
        ctx,
        q,
        common,
        before,
        // Plan.md D2: each step runs under the policy `integrate` with the 003 limits and the 15 s stall notice.
        async step(args, phase, options = {}) {
          if (signal.aborted) return { exit: null, canceled: true, refused: null, outputTail: "" };
          const report = () => {
            const state = registry.get(operationId)?.state;
            if (state === "running" || state === "cancel-requested") registry.progress(operationId, phase, options.counters);
          };
          report();
          const stdout = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
          const stderr = stepStderr(() => {});
          const stall = trackStall(registry, operationId, report, () => stallRemedy(args));
          let exit: GitExit | null = null;
          let refused: ErrorCode | null = null;
          try {
            exit = await o.runner.run({ operationId, context: options.context ?? contextOf(w), arguments: args, environmentPolicy: "integrate", limits: PROCESS_LIMITS.network, stdout, stderr, signal, onActivity: stall.onActivity });
            lastDescendants = exit.activeDescendants ?? 0;
          } catch (error) {
            if (!signal.aborted && !(error instanceof RunnerRefusal)) throw error;
            if (!signal.aborted) refused = (error as RunnerRefusal).code;
          } finally {
            stall.end();
          }
          return { exit, canceled: signal.aborted && (exit === null || exit.exitCode === null), refused, outputTail: stderr.outputTail() };
        },
        progress(phase) {
          registry.progress(operationId, phase);
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
        remedy,
      });

      // Contract Δ3 `runWorkbench` step 2: every bound value again, from an own trust listing.
      const again = await observeAll(ctx, e.payload, () => o.trust.listTrust({ operationId, signal, workspace: w }));
      const stale = staleOf(e, again, w.generation);
      if (stale !== null) return refuse(stale);
      const later = accept(token, operationId);
      if (!later.ok) return refuse({ code: "code" in later ? later.code : "UNKNOWN_TARGET" });
      e.consumed = operationId;
      const full = again as Full;
      const before = await observe(ctx, false);
      if (!("value" in before)) return refuse(before);
      await handler.run(runOf(full.common, before.value), e.payload, full.bound);
    });
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
      const ctx: WorkbenchContext = { runner: o.runner, trust: o.trust, reader: o.reader, operationId: t.operationId, signal: t.signal, workspace: t.workspace, installation: t.installation };
      const observed = await observeAll(ctx, payload, () => sharedListing({ trust: o.trust, listingTuple: o.listingTuple }, t));
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
        trust: { fingerprint: listing.fingerprint, required: required(payload.action, listing) },
        bound: observed.bound,
        issuedAt: at,
        consumed: null,
        running: null,
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
      const cls = classOf(e.payload.action);
      const gate = cls === null ? null : o.trust.gate(w, { approvalRequired: { [cls]: e.trust.required }, fingerprint: e.trust.fingerprint, inputLimited: false }, installation, cls);
      if (gate !== null) return void registry.apply(operationId, { type: "invalid-approval", code: gate });
      // Contract §2: the token is in use before the first await. A run that ends before the consumption leaves it to a later run (data-model §2).
      e.running = operationId;
      void execute(w, installation, operationId, signal, token, e).finally(() => {
        if (e.consumed === null) e.running = null;
      });
    },
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;
