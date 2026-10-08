// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T110: `applyHunk`, research R3 steps 1 to 5 and 11 to 14, contract §2, §4 "Hunk eligibility and publication", §5, §8, and §9. The Windows path.
// Only `publish()` of the owned index lock writes the canonical index. A WSL comparison gets no hunk approval (T214 adds the WSL path).

import { unlink } from "node:fs/promises";
import { basename } from "node:path";
import type { Response, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import type { ApprovalKey, Approvals, ComparisonBinding, HunkApproval } from "./approvals";
import { attributeArgs, objectCheckArgs } from "./commands";
import type { ComparisonReader, RetainedComparison } from "./comparison";
import { hunkEligibility, IndexFormatError, rawIndexEntries, type HunkRefusalReason, type ObjectFormat } from "./eligibility";
import type { Entered, Exclusion, NotEntered } from "./exclusion";
import { createCollector, type Collector, type GitExit, type GitRunner } from "./git-runner";
import { captureHead } from "./history";
import { prepareCandidate, type Candidate, type CandidateFailure } from "./hunk-candidate";
import { createIndexLock, type IndexLock, type LockResult, type PublishResult } from "./index-lock";
import { STEP_CAUSES, type DiagnosticCause } from "./log";
import type { OperationRegistry } from "./operations";
import { contextOf, isMissing, objectCheckInput, objectCheckOutcome, runRead } from "./read-steps";
import type { Workspace } from "./registration";
import { readWorkingVersion, type ChangeSnapshot, type Head, type LimitName, type OperationState, type ReadInstallation, type WorkingVersion } from "./snapshot";
import { hasPromisor, OBJECT_MISSING_REMEDY, policyOf, readRawIndex, type WorkspaceReader } from "./status";
import { parseAttributes } from "./support";
import type { Trust, TrustListing } from "./trust";

// Contract §4 "Split index".
export const SPLIT_INDEX_TEXT = "Git's split index is on for this repository. Arbareto stages hunks and files only with a full index. Stage this change in a terminal.";
// Contract §9: the remedy text of each `UNSUPPORTED_HUNK_PROFILE` reason.
export const PROFILE_TEXTS: Record<HunkRefusalReason, string> = {
  "sparse-index": "This repository uses a sparse index. Arbareto stages hunks and files only with a full index. Stage this change in a terminal.",
  "split-index": SPLIT_INDEX_TEXT,
  "index-change-hook": "This repository registers a post-index-change hook. Arbareto does not stage hunks and files while such a registration exists, also a disabled one. Stage this change in a terminal.",
  "executable-monitor": "The core.fsmonitor setting starts a program for this repository. Arbareto does not stage hunks and files while that setting starts a program. Stage this change in a terminal.",
  "unqualified-monitor": "This repository uses the built-in fsmonitor daemon of Git. Arbareto has not qualified that daemon for staging hunks and files. Stage this change in a terminal.",
};
// Contract §4 "Windows lock ownership".
export const FILE_ID_TEXT = "This volume gives the index lock no unique file ID. Stage this change in a terminal.";
// Contract §9: the remedy of a failed file step.
export const STEP_FAILED_TEXT = "Arbareto could not finish this staging step. Nothing was staged. Use Refresh, then try again or stage in a terminal.";
// Contract §9 "Lingering count".
const REVOKE_TEXT = "Revoke trust also ends them.";
export const lingeringSentence = (count: number) => `Arbareto still runs ${count === 1 ? "1 process" : `${count} processes`} that Git or a hook started in this repository. Closing Arbareto ends them.`;

// The in-process checkpoint observer: after the research R3 step 5 revalidation, after the step 11 recheck, and after the step 13 publication. Production passes none.
export interface HunkCheckpoint {
  step: 5 | 11 | 13;
  operationId: string;
}

export type Stop = { stop: "canceled" | "deadline" };
export type Failure = { code: ErrorCode; reason?: LimitName };
export type Fact<T> = { value: T } | Failure | Stop;

const CANCELED: Stop = { stop: "canceled" };
const DEADLINE: Stop = { stop: "deadline" };
// Contract §9: unexpected diagnostic output above the §5 bound. Each observation step gives OUTPUT_LIMIT only for this bound.
const DIAGNOSTIC_LIMIT: Failure = { code: "OUTPUT_LIMIT", reason: "UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION" };
const failureOf = (code: ErrorCode): Failure => (code === "OUTPUT_LIMIT" ? DIAGNOSTIC_LIMIT : { code });

// A refusal after acceptance. `reason`, `remedy`, `path`, and `foreign` go into the response result. `cause` goes only into the session log (contract §9).
export interface Refusal {
  code: ErrorCode;
  reason?: string;
  remedy?: { text: string };
  path?: string;
  cause?: DiagnosticCause;
  foreign?: string[];
}

const STALE: Refusal = { code: "STALE_SELECTION" };
const stepFailed = (cause?: DiagnosticCause): Refusal => ({ code: "GIT_FAILED", ...(cause === undefined ? {} : { cause }), remedy: { text: STEP_FAILED_TEXT } });
// Contract §9 "Total unexpected diagnostic output": the diagnostic names OUTPUT_LIMIT as the cause. A failed observation gets the step remedy.
const refusalOf = (f: Failure): Refusal => (f.reason === DIAGNOSTIC_LIMIT.reason ? { ...f, cause: "OUTPUT_LIMIT" } : f.code === "GIT_FAILED" ? stepFailed() : f);
const profileRefusal = (reason: HunkRefusalReason): Refusal => ({ code: "UNSUPPORTED_HUNK_PROFILE", reason, remedy: { text: PROFILE_TEXTS[reason] } });

const isStop = (f: unknown): f is Stop => typeof f === "object" && f !== null && "stop" in f;
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const sameVersion = (a: WorkingVersion, b: WorkingVersion) => Buffer.compare(a.path, b.path) === 0 && Bun.deepEquals({ ...a, path: null }, { ...b, path: null }, true);

// Contract §9 "Lingering count": the sentences need a nonzero count, and "Revoke trust also ends them." needs a current trust ID.
export function lockRefusal(locked: Exclude<LockResult, { ok: true }>, lingering: number | null, trustId: boolean): Refusal {
  if ("code" in locked) {
    const extra = lingering !== null && lingering > 0 ? ` ${lingeringSentence(lingering)}${trustId ? ` ${REVOKE_TEXT}` : ""}` : "";
    return { code: "LOCKED", path: locked.path, remedy: { text: `${locked.remedy.text}${extra}` } };
  }
  if (locked.reason === "file-id") return { code: "UNSUPPORTED_HUNK_PROFILE", reason: "file-id", remedy: { text: FILE_ID_TEXT }, ...(locked.removed ? {} : { foreign: [locked.path] }) };
  return stepFailed("lock-create");
}

// Research R3 steps 6 to 10. `check`: contract §7 "Missing objects" decides with the promisor remote and the object check.
export function candidateRefusal(f: CandidateFailure): Refusal | Stop | { check: "object-missing" | "git-failed" } {
  switch (f.reason) {
    case "canceled":
      return CANCELED;
    case "deadline":
      return DEADLINE;
    case "refused":
      return { code: f.code };
    case "split-index":
      return profileRefusal("split-index");
    case "index-changed":
      return STALE;
    case "bound":
      return { code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" };
    case "object-missing":
    case "git-failed":
      return { check: f.reason };
    case "unavailable":
      return stepFailed("candidate-copy");
    case "candidate-time":
      return stepFailed("candidate-time");
    case "verification":
      return stepFailed("verification");
    case "malformed":
      return { code: "MALFORMED_GIT_OUTPUT" };
    case "output-limit":
      return refusalOf(DIAGNOSTIC_LIMIT);
  }
}

// Research R3 step 13. Every result but `published` leaves the canonical index unchanged.
export function publishRefusal(r: Exclude<PublishResult, { published: true }>, lockPath: string): Refusal {
  switch (r.reason) {
    case "notOwned":
      return { ...STALE, path: lockPath };
    case "time":
    case "publish-time":
      return stepFailed("publish-time");
    case "write-failed":
      return stepFailed("write");
    case "replace-failed":
      return stepFailed("replace");
  }
}

// Contract §8 and §9: the code of a failed reconciliation observation, else the failed-step cause, else the recorded deadline cause.
export function diagnosticCause(observation: ErrorCode | null, refusal: Pick<Refusal, "cause"> | null, recorded: string | undefined): DiagnosticCause | undefined {
  if (observation !== null) return observation;
  if (refusal?.cause !== undefined) return refusal.cause;
  return recorded === "DEADLINE" || recorded === "OUTPUT_LIMIT" ? recorded : undefined;
}

// ---- Observations ----

export interface ObserveContext {
  runner: GitRunner;
  trust: Trust;
  reader: Pick<WorkspaceReader, "operationState">;
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
  installation: ReadInstallation;
}

export interface PolicyFacts {
  listing: Pick<TrustListing, "entries" | "hooks">;
  gate: "TRUST_REQUIRED" | "TRUST_CHANGED" | null;
  policyFingerprint: string;
  // Null when the gate refused. `check-attr` runs only after the gate (contract §7).
  attributes: Fact<Readonly<Record<string, string>>> | null;
}
export type PolicyObservation = PolicyFacts | Failure | Stop;

export interface IndexFacts {
  // Null: the index file is absent.
  raw: Uint8Array | null;
  digest: string | null;
  // The raw index holds an entry above stage 0.
  unmerged: boolean;
}

export interface StateObservation {
  head: Fact<Head>;
  index: Fact<IndexFacts>;
  operationState: Fact<OperationState>;
  // Null when the binding holds no working version. `changed`: the read found the file above the bound, or replaced twice (`readWorkingVersion`).
  working: Fact<WorkingVersion> | { changed: true } | null;
}

// An abort makes a pending `run` throw. Any other throw is no Git answer.
const settled = <T>(signal: AbortSignal, work: Promise<T>): Promise<T | Stop | Failure> => work.catch(() => (signal.aborted ? CANCELED : { code: "GIT_FAILED" }));

async function stepOf(ctx: ObserveContext, args: string[], out: Collector, input?: Uint8Array): Promise<{ exit: GitExit } | Failure | Stop> {
  const s = await settled(ctx.signal, runRead(ctx.runner, ctx, args, out, input));
  if (ctx.signal.aborted) return CANCELED;
  if (!("exit" in s)) return "refused" in s ? failureOf(s.refused) : s;
  if (s.exit.deadline !== undefined) return DEADLINE;
  if (s.exit.diagnosticLimit) return DIAGNOSTIC_LIMIT;
  return { exit: s.exit };
}

async function attributesOf(ctx: ObserveContext, path: Uint8Array): Promise<Fact<Readonly<Record<string, string>>>> {
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const step = await stepOf(ctx, attributeArgs(), out, Buffer.concat([path, Uint8Array.of(0)]));
  if (!("exit" in step)) return step;
  const parsed = step.exit.exitCode === 0 && !out.limited ? parseAttributes(out.take(), [path]) : null;
  if (parsed === null) return { code: step.exit.exitCode === 0 ? "MALFORMED_GIT_OUTPUT" : "GIT_FAILED" };
  return { value: parsed[0]! };
}

// Contract §4 and §7: the configuration listing, the trust gate, the policy fingerprint, and the attributes of `path`.
export async function observePolicy(ctx: ObserveContext, path: Uint8Array): Promise<PolicyObservation> {
  const { trust, workspace: w, installation } = ctx;
  const listed = await settled(ctx.signal, trust.listTrust({ operationId: ctx.operationId, signal: ctx.signal, workspace: w }));
  if (!("ok" in listed)) return listed;
  if (!listed.ok) return "stop" in listed ? { stop: listed.stop } : failureOf(listed.code);
  const listing = listed.listing;
  const gate = trust.gate(w, listing, installation, "reads");
  return { listing, gate, policyFingerprint: policyOf(trust, w, listing, installation), attributes: gate === null ? await attributesOf(ctx, path) : null };
}

async function indexOf(w: Workspace): Promise<Fact<IndexFacts>> {
  const raw = await readRawIndex(w.indexPath);
  if (raw === "unavailable") return { code: "GIT_FAILED" };
  if (raw === "over") return { code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" };
  if (raw === null) return { value: { raw: null, digest: null, unmerged: false } };
  try {
    return { value: { raw, digest: sha256(raw), unmerged: rawIndexEntries(raw, w.objectFormat).entries.some((e) => e.stage > 0) } };
  } catch (error) {
    if (error instanceof IndexFormatError) return { code: "MALFORMED_GIT_OUTPUT" };
    throw error;
  }
}

async function workingOf(w: Workspace, path: Uint8Array): Promise<Fact<WorkingVersion> | { changed: true }> {
  const read = await readWorkingVersion(w.worktreeRoot, path, "COMPARED_RAW_VERSION_BYTES", null);
  if (read.ok) return { value: read.value };
  const c = read.completeness;
  if (c.state === "limited" || (c.state === "failed" && c.code === "REPOSITORY_CHANGED")) return { changed: true };
  return { code: c.state === "failed" ? c.code : "GIT_FAILED" };
}

// Research R3 steps 5, 11, and 14: HEAD, the raw canonical index, the operation state, and the bound working version.
export async function observeState(ctx: ObserveContext, path: Uint8Array, bindsWorking: boolean): Promise<StateObservation> {
  const t = { operationId: ctx.operationId, signal: ctx.signal, workspace: ctx.workspace };
  const [captured, index, working] = await Promise.all([
    settled(ctx.signal, captureHead(ctx.runner, t)),
    settled(ctx.signal, indexOf(ctx.workspace)),
    bindsWorking ? settled(ctx.signal, workingOf(ctx.workspace, path)) : null,
  ]);
  const head: Fact<Head> = isStop(captured) || "code" in captured ? captured : "failed" in captured ? failureOf(captured.failed) : { value: captured };
  const operationState = "value" in index ? stateFact(await settled(ctx.signal, ctx.reader.operationState(t, index.value.unmerged))) : index;
  return { head, index, operationState, working };
}

function stateFact(state: Awaited<ReturnType<WorkspaceReader["operationState"]>> | Stop | Failure): Fact<OperationState> {
  if (state === "canceled" || state === "deadline") return { stop: state };
  if (typeof state === "string") return { value: state };
  return "refused" in state ? failureOf(state.refused) : state;
}

export type CheckpointBinding = Pick<ComparisonBinding, "head" | "index" | "working" | "attributes" | "policyFingerprint" | "operationState">;

// Contract §4 and §9. The first match wins. A stop wins over every refusal, and a deadline over a cancel.
export function checkpointRefusal(binding: CheckpointBinding, policy: PolicyObservation, state: StateObservation, objectFormat: ObjectFormat): Refusal | Stop | null {
  const attributes = "listing" in policy ? policy.attributes : null;
  const stops = [policy, attributes, state.head, state.index, state.operationState, state.working].filter(isStop);
  if (stops.length > 0) return stops.some((s) => s.stop === "deadline") ? DEADLINE : CANCELED;
  if (!("listing" in policy)) return refusalOf(policy as Failure);
  if (policy.gate !== null) return { code: policy.gate };
  if (policy.policyFingerprint !== binding.policyFingerprint) return { code: "TRUST_CHANGED" };
  if (!("value" in state.index)) return refusalOf(state.index as Failure);
  let eligibility;
  try {
    eligibility = hunkEligibility(state.index.value.raw, objectFormat, policy.listing);
  } catch (error) {
    if (error instanceof IndexFormatError) return { code: "MALFORMED_GIT_OUTPUT" };
    throw error;
  }
  if (!eligibility.eligible) return profileRefusal(eligibility.reason);
  // A `conflicted` state also changes the index, so the operation state decides before the index compare.
  if (!("value" in state.operationState)) return refusalOf(state.operationState as Failure);
  const observed = state.operationState.value;
  if (observed === "conflicted") return { code: "CONFLICTED" };
  if (observed !== "normal" && observed !== "unknown") return { code: "OPERATION_IN_PROGRESS" };
  if (observed === "unknown" || observed !== binding.operationState) return STALE;
  if (!("value" in state.head)) return refusalOf(state.head as Failure);
  if (!Bun.deepEquals(state.head.value, binding.head, true)) return STALE;
  if (state.index.value.digest !== binding.index.rawIndexDigest) return STALE;
  // `observePolicy` reads the attributes whenever the gate passes.
  const read = attributes!;
  if (!("value" in read)) return refusalOf(read as Failure);
  if (!Bun.deepEquals(read.value, binding.attributes, true)) return STALE;
  if (binding.working !== null) {
    const w = state.working;
    if (w === null || "changed" in w) return STALE;
    if (!("value" in w)) return refusalOf(w as Failure);
    if (!sameVersion(w.value, binding.working)) return STALE;
  }
  return null;
}

// ---- Bindings ----

// Contract §4: the values that a comparison binds. Null for an incomplete snapshot (contract §5: a mutation needs a complete index and policy).
export function comparisonBinding(c: RetainedComparison, s: ChangeSnapshot, w: Workspace): ComparisonBinding | null {
  if (s.indexFingerprint === null || s.policyFingerprint === null) return null;
  const path = Buffer.from(c.entry.pathBytes, "base64");
  const indexed = s.indexEntries.find((e) => Buffer.compare(e.path, path) === 0);
  const { pathBytes, category, modes, oids } = c.entry;
  return {
    gitInstallationId: w.gitInstallationId,
    worktreeIdentity: w.worktreeIdentity,
    commonIdentity: w.commonIdentity,
    head: s.head,
    index: s.indexFingerprint,
    entry: { pathBytes, category, ...(modes === undefined ? {} : { modes }), ...(oids === undefined ? {} : { oids }), stage: indexed?.stage ?? null },
    working: c.workingVersion,
    attributes: c.attributes,
    policyFingerprint: s.policyFingerprint,
    operationState: s.operationState,
  };
}

// The direction that the comparison scope allows (contract §9).
const directionOf = (c: Pick<RetainedComparison, "scope">) => (c.scope === "head-to-index" ? "unstage" : "stage");

// One approval for each hunk of the comparison. The caller issues them only after the working version binds (status `bind`).
export function hunkApprovals(c: RetainedComparison, s: ChangeSnapshot, w: Workspace): HunkApproval[] {
  const binding = comparisonBinding(c, s, w);
  if (binding === null) return [];
  const patchDigest = sha256(c.patch);
  return c.hunks.map((h) => ({
    kind: "hunk",
    repositoryId: c.repositoryId,
    snapshotId: c.snapshotId,
    generation: c.generation,
    comparisonId: c.comparisonId,
    hunkId: h.hunkId,
    direction: directionOf(c),
    binding: { ...binding, patchDigest, hunkDigest: h.digest },
  }));
}

// ---- Execution ----

// Keeps the `activeDescendants` count of the last exit reply (contract §6 "Lingering Jobs"). Null: no exit reply since the start or the last `reset`.
export function recording(runner: GitRunner): GitRunner & { readonly last: number | null; reset(): void } {
  let last: number | null = null;
  return {
    ...runner,
    async run(call) {
      const exit = await runner.run(call);
      last = exit.activeDescendants;
      return exit;
    },
    get last() {
      return last;
    },
    reset() {
      last = null;
    },
  };
}

// Research R3 step 14 and data-model §7: every outcome after `running` passes `reconciling`. True: the operation passed `cancel-requested`.
// A deadline closed the Job with every descendant (contract §5 "Deadline outcomes").
export function enterReconciling(registry: OperationRegistry, operationId: string, deadline: boolean, lingeringDescendants: number): boolean {
  const canceled = registry.get(operationId)!.state === "cancel-requested";
  if (!canceled) registry.apply(operationId, deadline ? { type: "mutation-deadline" } : { type: "execution-ended", lingeringDescendants });
  else registry.apply(operationId, deadline ? { type: "cancel-deadline", lingeringDescendants: 0 } : { type: "processes-stopped", lingeringDescendants });
  registry.progress(operationId, "reconciliation");
  return canceled;
}

// Contract §8 and G18: owned candidate files go only after every process of the operation ended. Otherwise they stay and become foreign.
export async function removeOwned(paths: readonly string[], processesEnded: boolean): Promise<string[]> {
  if (!processesEnded) return [...paths];
  const foreign: string[] = [];
  for (const path of paths) {
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissing(error)) foreign.push(path);
    }
  }
  return foreign;
}

// Contract §8 "Observed locks": the Git-resolved form of the lock path. An owned file in the folder of the index gets the same folder text.
export const besideIndex = (w: Pick<Workspace, "indexPath">, path: string) => `${w.indexPath.slice(0, w.indexPath.length - basename(w.indexPath).length)}${basename(path)}`;

// Contract §7 "Missing objects": with a promisor remote, a missing index blob gives OBJECT_MISSING without publication. `oid`: the index object ID of the entry.
export async function missingObject(ctx: ObserveContext, listing: PolicyFacts["listing"] | null, oid: string | undefined, check: "object-missing" | "git-failed"): Promise<Refusal | Stop> {
  const { workspace: w, signal } = ctx;
  const promisor = listing === null ? false : await settled(signal, hasPromisor(listing.entries, w, (paths) => ctx.runner.identities(ctx.operationId, contextOf(w), paths, signal)));
  if (promisor === "canceled" || promisor === "deadline") return { stop: promisor };
  if (isStop(promisor)) return promisor;
  if (promisor !== true) return stepFailed();
  const missing: Refusal = { code: "OBJECT_MISSING", remedy: { text: OBJECT_MISSING_REMEDY } };
  if (check === "object-missing") return missing;
  if (oid === undefined || /^0+$/.test(oid)) return stepFailed();
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const step = await settled(signal, runRead(ctx.runner, ctx, objectCheckArgs(), out, objectCheckInput([oid])));
  if (signal.aborted) return CANCELED;
  if (isStop(step)) return step;
  const answer = "code" in step ? "failed" : objectCheckOutcome(step, out, [oid]);
  if (answer === "deadline") return DEADLINE;
  return answer === "missing" ? missing : stepFailed();
}

// Contract §5 "Retained comparison data" and §8: the raw digests that reconciliation compares with the canonical index.
export interface RetainedPublication {
  repositoryId: string;
  before: string | null;
  candidate: string;
}

export interface HunkPublisherOptions {
  runner: GitRunner;
  trust: Trust;
  reader: Pick<WorkspaceReader, "operationState">;
  comparisons: Pick<ComparisonReader, "get">;
  approvals: Approvals;
  registry: OperationRegistry;
  exclusion: Exclusion;
  respond: (response: Response) => unknown;
  hunkCheckpoint?: (checkpoint: HunkCheckpoint) => Promise<void> | void;
}

type ApplyHunkRequest = Extract<ServiceRequest, { operation: "applyHunk" }>;
type Admitted = { approval: HunkApproval; comparison: RetainedComparison; hunk: RetainedComparison["hunks"][number] };
type Ending = Refusal | Stop | { published: true };

export function createHunkPublisher(o: HunkPublisherOptions) {
  const retained = new Map<string, RetainedPublication>();
  // Contract §2: the workspace of each operation that consumed a hunk approval.
  const owners = new Map<string, string>();
  const { registry } = o;

  // Contract §2, §9: the acceptance checks after the accepted event. Memory only, so no Git process starts.
  function admit(request: ApplyHunkRequest, w: Workspace, key: ApprovalKey): Admitted | { code: ErrorCode; result?: unknown } {
    const { comparisonId, hunkId, snapshotId, direction } = request.payload;
    if (request.repositoryGeneration !== w.generation) return { code: "REPOSITORY_CHANGED" };
    // An equal-observation read replaces the snapshot ID but keeps the tokens (contract §8), so the comparison names the snapshot.
    const c = o.comparisons.get(comparisonId);
    if (c === undefined || c.repositoryId !== request.repositoryId || c.snapshotId !== snapshotId) return { code: "UNKNOWN_TARGET" };
    if (c.support?.supported === false && c.support.code === "UNSUPPORTED_COMPARISON") return { code: "UNSUPPORTED_COMPARISON", result: { reason: c.support.reason } };
    const hunk = c.hunks.find((h) => h.hunkId === hunkId);
    if (hunk === undefined) return { code: "UNKNOWN_TARGET" };
    if (direction !== directionOf(c)) return { code: "INVALID_REQUEST" };
    const accepted = o.approvals.accept(key);
    if (!accepted.ok) return { code: "code" in accepted ? accepted.code : "UNKNOWN_TARGET" };
    const approval = accepted.approval;
    if (approval.kind !== "hunk" || approval.generation !== w.generation) return { code: "UNKNOWN_TARGET" };
    // Data-model §7: an unfinished operation refuses at acceptance. `unknown` decides at the checkpoints.
    const state = approval.binding.operationState;
    if (state === "conflicted") return { code: "CONFLICTED" };
    if (state !== "normal" && state !== "unknown") return { code: "OPERATION_IN_PROGRESS" };
    return { approval, comparison: c, hunk };
  }

  // Data-model §7 rows for a `started` reply without a marker ID.
  function notEntered(operationId: string, n: NotEntered): void {
    if (n.code === "BUSY") {
      if (n.remedy === undefined) return void registry.apply(operationId, { type: "exclusion-unavailable", code: "BUSY" });
      return void registry.apply(operationId, { type: "marker-refused", code: "BUSY" }, { remedy: n.remedy });
    }
    if (n.code === "RECOVERY_MARKER_FAILED") return void registry.apply(operationId, { type: "marker-refused", code: n.code }, { failure: n.failure, path: n.folder, remedy: n.remedy });
    if (n.code === "DEADLINE") return void registry.apply(operationId, { type: "started-deadline" }, undefined, "DEADLINE");
    registry.apply(operationId, { type: "exclusion-unavailable", code: n.code });
  }

  async function publish(request: ApplyHunkRequest, w: Workspace, installation: ReadInstallation, operationId: string, signal: AbortSignal, admitted: Admitted, key: ApprovalKey): Promise<void> {
    const { approval, comparison: c, hunk } = admitted;
    const binding = approval.binding;
    const path = new Uint8Array(Buffer.from(binding.entry.pathBytes, "base64"));
    const bindsWorking = binding.working !== null;
    let entered: Entered | NotEntered;
    try {
      entered = await o.exclusion.enter({ operationId, kind: "applyHunk", workspace: w });
    } catch {
      return void registry.apply(operationId, { type: "exclusion-unavailable", code: "GIT_FAILED" });
    }
    if (!entered.ok) return notEntered(operationId, entered);
    const marker = entered;
    const rec = recording(o.runner);
    const ctx: ObserveContext = { runner: rec, trust: o.trust, reader: o.reader, operationId, signal, workspace: w, installation };
    const run = {
      lock: null as IndexLock | null,
      candidate: null as Candidate | null,
      // The Git-resolved form (`besideIndex`).
      candidatePath: null as string | null,
      // `publish()` started and did not return.
      publishing: false,
      // `publish()` returned `published`.
      published: false,
      // Data-model §7 `lingeringDescendants`: the count of the last execution process before reconciliation.
      executionLast: 0,
      listing: null as PolicyFacts["listing"] | null,
    };
    const foreign: string[] = [];
    // Owned files. `release` removes the lock only while the path names the owned file (contract §4). Each path is handled once.
    const releaseOwned = async (processesEnded: boolean) => {
      const { lock, candidatePath } = run;
      run.lock = null;
      run.candidatePath = null;
      if (lock !== null && (await lock.release().catch(() => "remove-failed" as const)) === "remove-failed") foreign.push(lock.path);
      if (candidatePath !== null) foreign.push(...(await removeOwned([candidatePath, `${candidatePath}.lock`], processesEnded)));
    };
    const extra = () => (foreign.length > 0 ? { foreign } : undefined);
    try {
      registry.apply(operationId, { type: "marker-recorded" });
      owners.set(operationId, request.repositoryId);

      const checkpoint = async (step: 5 | 11): Promise<Refusal | Stop | null> => {
        const policy = await observePolicy(ctx, path);
        if ("listing" in policy) run.listing = policy.listing;
        const refused = checkpointRefusal(binding, policy, await observeState(ctx, path, bindsWorking), w.objectFormat);
        if (refused !== null) return refused;
        await o.hunkCheckpoint?.({ step, operationId });
        return signal.aborted ? CANCELED : null;
      };

      const steps = async (): Promise<Ending> => {
        if (!o.approvals.consume(key, operationId)) {
          const now = o.approvals.accept(key);
          return { code: !now.ok && "code" in now ? now.code : "UNKNOWN_TARGET" };
        }
        // Research R3 step 4.
        if (signal.aborted) return CANCELED;
        const locked = await createIndexLock(w.indexPath);
        if (!locked.ok) {
          let count: number | null = null;
          if ("code" in locked) {
            const answer = await o.runner.lingeringCount(operationId, w.commonDirectory).catch(() => null);
            count = typeof answer === "number" ? answer : null;
          }
          return lockRefusal(locked, count, o.trust.currentTrustId(w) !== undefined);
        }
        run.lock = locked.lock;
        // Research R3 step 5 under the lock.
        registry.progress(operationId, "preflight");
        const first = await checkpoint(5);
        if (first !== null) return first;
        // Research R3 steps 6 to 10.
        registry.progress(operationId, "candidate-verification");
        const prepared = await prepareCandidate({ runner: rec, operationId, signal, workspace: w, rawIndexDigest: binding.index.rawIndexDigest, comparison: c, hunk });
        run.executionLast = rec.last ?? 0;
        if (!prepared.ok) {
          run.candidatePath = prepared.path === null ? null : besideIndex(w, prepared.path);
          const refused = candidateRefusal(prepared.failure);
          return "check" in refused ? await missingObject(ctx, run.listing, c.entry.oids?.[1], refused.check) : refused;
        }
        const candidate = prepared.candidate;
        run.candidate = candidate;
        run.candidatePath = besideIndex(w, candidate.path);
        // Research R3 steps 11 and 12.
        const second = await checkpoint(11);
        if (second !== null) return second;
        // Research R3 step 13. Contract §5: the digests stay until reconciliation succeeds.
        retained.set(operationId, { repositoryId: w.repositoryId, before: binding.index.rawIndexDigest, candidate: candidate.digest });
        registry.progress(operationId, "publication");
        run.publishing = true;
        const result = await run.lock.publish(candidate.bytes, candidate.mtimeNs);
        run.publishing = false;
        if (!result.published) return publishRefusal(result, run.lock.path);
        run.published = true;
        await o.hunkCheckpoint?.({ step: 13, operationId });
        return { published: true };
      };

      let ending: Ending;
      try {
        ending = await steps();
      } catch {
        ending = signal.aborted ? CANCELED : stepFailed();
      }

      const canceled = enterReconciling(registry, operationId, isStop(ending) && ending.stop === "deadline", run.executionLast);
      // Contract §8: a cancel never stops a reconciliation read, so these reads get a signal that never aborts.
      // Only an exit reply of these reads is a fresh process-end fact for the owned candidate.
      rec.reset();
      const observed = await observeState({ ...ctx, signal: new AbortController().signal }, path, bindsWorking);

      const refusal = "code" in ending ? ending : null;
      foreign.push(...(refusal?.foreign ?? []));
      await releaseOwned(rec.last === 0);

      const failedRead = [observed.head, observed.index, observed.operationState, observed.working].find((f) => f !== null && !("value" in f) && !("changed" in f)) as Failure | Stop | undefined;
      if (failedRead !== undefined) {
        // Contract §8: a failed observation gives `unknown`. The marker and the retained digests stay.
        const code = "code" in failedRead ? failedRead.code : "DEADLINE";
        const event = "code" in failedRead ? { type: "reconciliation-read-failed" as const, code } : { type: "reconciliation-read-deadline" as const };
        registry.apply(operationId, event, extra(), diagnosticCause(code, refusal, undefined));
        return;
      }
      const head = (observed.head as { value: Head }).value;
      const digest = (observed.index as { value: IndexFacts }).value.digest;
      const operationState = (observed.operationState as { value: OperationState }).value;
      const working = observed.working;
      const effectsWith = (index: boolean) => ({
        head: !Bun.deepEquals(head, binding.head, true),
        index,
        workingFiles: binding.working !== null && (working === null || "changed" in working || !sameVersion((working as { value: WorkingVersion }).value, binding.working)),
        operationState: operationState !== binding.operationState,
      });
      // Contract §9: the canonical index digest decides publication. A returned publication with another digest is published with an index effect.
      const viaDigest = run.candidate !== null && digest === run.candidate.digest;
      const changed = digest !== binding.index.rawIndexDigest;
      const cause = diagnosticCause(null, refusal, registry.get(operationId)!.cause);
      if (viaDigest || run.published) {
        const effects = effectsWith(!viaDigest);
        if (Object.values(effects).some(Boolean)) registry.apply(operationId, { type: "differing-effects" }, { effects, ...extra() }, cause);
        else registry.apply(operationId, { type: "intended-effects-confirmed" }, extra(), cause);
      } else if (run.publishing && changed) {
        // `publish()` threw, and the index matches neither retained digest. Contract §9 "publish without a typed result" gives `unknown`.
        registry.apply(operationId, { type: "reconciliation-read-failed", code: "GIT_FAILED" }, extra(), "GIT_FAILED");
        return;
      } else if (changed && (STEP_CAUSES as readonly unknown[]).includes(refusal?.cause)) {
        // Contract §8: an execution failure with observed changes is failed-with-effects. A checkpoint code never is.
        registry.apply(operationId, { type: "failed-with-effects" }, { effects: effectsWith(true), ...extra() }, cause);
      } else if (canceled) {
        registry.apply(operationId, { type: "no-effects", observed: "canceled" }, extra(), cause);
      } else {
        const { code, cause: _cause, foreign: _foreign, ...fields }: Partial<Refusal> = refusal ?? {};
        const result = { ...fields, ...extra() };
        const reason = code === "OUTPUT_LIMIT" ? fields.reason : undefined;
        registry.apply(operationId, { type: "no-effects", observed: "failed", ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }, Object.keys(result).length > 0 ? result : undefined, cause);
      }
      // Contract §6: `resolved` follows a known outcome.
      o.runner.resolved(marker.markerId);
      retained.delete(operationId);
    } catch {
      // A broken step leaves the outcome unknown. The marker stays (contract §8). Without a fresh process-end fact, the candidate stays foreign.
      await releaseOwned(false);
      const state = registry.get(operationId)?.state;
      if (state === "running") registry.apply(operationId, { type: "execution-ended", lingeringDescendants: 0 });
      if (state === "cancel-requested") registry.apply(operationId, { type: "processes-stopped" });
      if (registry.get(operationId)?.state === "reconciling") registry.apply(operationId, { type: "reconciliation-read-failed", code: "GIT_FAILED" }, extra(), "GIT_FAILED");
    } finally {
      // The registry sent `ended` with the terminal response, so this only frees the exclusion slot.
      marker.end(false);
    }
  }

  function applyHunk(request: ApplyHunkRequest, w: Workspace, installation: ReadInstallation): void {
    const { comparisonId, hunkId, direction } = request.payload;
    const key: ApprovalKey = { kind: "hunk", comparisonId, hunkId, direction };
    // Contract §2: an approval that an accepted operation consumed answers a repeat with that operation, without an accepted event or a process.
    const peek = o.approvals.accept(key);
    if (!peek.ok && "consumed" in peek && owners.get(peek.consumed) === request.repositoryId) {
      return void o.respond({ requestId: request.requestId, operationId: peek.consumed, state: "succeeded", result: registry.get(peek.consumed) });
    }
    const { operationId, signal } = registry.start("applyHunk", request.requestId);
    const admitted = admit(request, w, key);
    if ("code" in admitted) return void registry.apply(operationId, { type: "invalid-approval", code: admitted.code }, admitted.result);
    void publish(request, w, installation, operationId, signal, admitted, key);
  }

  return { applyHunk, retained, owners };
}

export type HunkPublisher = ReturnType<typeof createHunkPublisher>;
