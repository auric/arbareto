// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T110: `applyHunk`, research R3 steps 1 to 5 and 11 to 14, contract §2, §4 "Hunk eligibility and publication", §5, §8, and §9.
// Only `publish()` of the owned index lock writes the canonical index.
// T214: a WSL repository locks, publishes, and removes owned files inside the distro (contract §4 "WSL index publication").

import { lstat, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { RECOVERY_FOREIGN_CAP, type Response, type ServiceRequest } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import { wslIdentityPath } from "../contracts/wsl-route";
import type { ApprovalKey, Approvals, ComparisonBinding, HunkApproval } from "./approvals";
import { attributeArgs, isRefName, objectCheckArgs, refPathArgs } from "./commands";
import type { ComparisonReader, RetainedComparison } from "./comparison";
import { hunkEligibility, IndexFormatError, rawIndexEntries, type HunkRefusalReason, type ObjectFormat } from "./eligibility";
import type { Entered, Exclusion, NotEntered } from "./exclusion";
import { createCollector, isChannelPath, type Collector, type GitExit, type GitRunner, type WslRunner } from "./git-runner";
import { captureHead } from "./history";
import { prepareCandidate, type Candidate, type CandidateFailure } from "./hunk-candidate";
import { createIndexLock, type LockResult, type PublishResult } from "./index-lock";
import { STEP_CAUSES, type DiagnosticCause } from "./log";
import type { OperationRegistry } from "./operations";
import { contextOf, isMissing, objectCheckInput, objectCheckOutcome, runRead } from "./read-steps";
import type { Workspace } from "./registration";
import { readWorkingVersion, type ChangeSnapshot, type Head, type LimitName, type OperationState, type RawIndexPart, type ReadInstallation, type WorkingBound, type WorkingVersion } from "./snapshot";
import { hasPromisor, OBJECT_MISSING_REMEDY, policyOf, readRawIndex, type WorkspaceReader } from "./status";
import { parseAttributes } from "./support";
import type { Trust, TrustListing } from "./trust";
import {
  processEnd,
  removeCandidate,
  wslIndexDigest,
  wslIndexOf,
  wslLock,
  wslWhole,
  type WslContext,
  type WslIndexFacts,
  type WslLockResult,
  type WslPublishResult,
  type WslRemoved,
  type WslWhole,
} from "./wsl-files";

// Contract §4 "Split index".
export const SPLIT_INDEX_TEXT = "Git's split index is on for this repository. Arbareto stages hunks and files only with a full index. Stage this change in a terminal.";
// Contract §9: the remedy text of each `UNSUPPORTED_HUNK_PROFILE` reason.
export const PROFILE_TEXTS: Record<HunkRefusalReason, string> = {
  "sparse-index": "This repository uses a sparse index. Arbareto stages hunks and files only with a full index. Stage this change in a terminal.",
  "split-index": SPLIT_INDEX_TEXT,
  "index-change-hook": "This repository registers a post-index-change hook. Arbareto does not stage hunks and files while such a registration exists, also a disabled one. Stage this change in a terminal.",
  "executable-monitor": "The core.fsmonitor setting starts a program for this repository. Arbareto does not stage hunks and files while that setting starts a program. Stage this change in a terminal.",
  "unqualified-monitor": "This repository uses the built-in fsmonitor daemon of Git. Arbareto has not qualified that daemon for staging hunks and files. Stage this change in a terminal.",
  // Contract §4 "WSL index publication".
  "shared-repository": "This repository sets core.sharedRepository. Arbareto stages hunks and files in a WSL repository only without it. Stage this change in a terminal.",
};
// Contract §4 "Windows lock ownership".
export const FILE_ID_TEXT = "This volume gives the index lock no unique file ID. Stage this change in a terminal.";
// Contract §9: the working-file `file-id` text.
export const WORKING_FILE_ID_TEXT = "This volume gives this file no unique file ID. Stage this change in a terminal.";
// Contract §9: the remedy of a failed file step.
export const STEP_FAILED_TEXT = "Arbareto could not finish this staging step. Nothing was staged. Use Refresh, then try again or stage in a terminal.";
// Contract §9 "Lingering count".
export const REVOKE_TEXT = "Revoke trust also ends them.";
export const lingeringSentence = (count: number) => `Arbareto still runs ${count === 1 ? "1 process" : `${count} processes`} that Git or a hook started in this repository. Closing Arbareto ends them.`;

// The in-process checkpoint observer: after the research R3 step 5 revalidation, after the step 11 recheck, and after the step 13 publication. Production passes none.
export interface HunkCheckpoint {
  step: 5 | 11 | 13;
  operationId: string;
}

export type Stop = { stop: "canceled" | "deadline" };
// `file-id`: a working-file read found a sentinel file ID (contract §6).
export type Failure = { code: ErrorCode; reason?: LimitName } | { code: "UNSUPPORTED_HUNK_PROFILE"; reason: "file-id" };
export type Fact<T> = { value: T } | Failure | Stop;

const CANCELED: Stop = { stop: "canceled" };
const DEADLINE: Stop = { stop: "deadline" };
// Contract §9: unexpected diagnostic output above the §5 bound. Each observation step gives OUTPUT_LIMIT only for this bound.
const DIAGNOSTIC_LIMIT: Failure = { code: "OUTPUT_LIMIT", reason: "UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION" };
export const failureOf = (code: ErrorCode): Failure => (code === "OUTPUT_LIMIT" ? DIAGNOSTIC_LIMIT : { code });

// A refusal after acceptance. `reason`, `remedy`, `path`, and `foreign` go into the response result. `cause` goes only into the session log (contract §9).
export interface Refusal {
  code: ErrorCode;
  reason?: string;
  remedy?: { text: string; command?: string | null };
  path?: string;
  // Contract §9 "Commit failure output".
  outputTail?: string;
  cause?: DiagnosticCause;
  foreign?: string[];
}

const STALE: Refusal = { code: "STALE_SELECTION" };
const stepFailed = (cause?: DiagnosticCause): Refusal => ({ code: "GIT_FAILED", ...(cause === undefined ? {} : { cause }), remedy: { text: STEP_FAILED_TEXT } });
// Contract §9 "Total unexpected diagnostic output": the diagnostic names OUTPUT_LIMIT as the cause. A failed observation gets the step remedy.
export const refusalOf = (f: Failure): Refusal =>
  f.reason === DIAGNOSTIC_LIMIT.reason ? { ...f, cause: "OUTPUT_LIMIT" } : f.reason === "file-id" ? { ...f, remedy: { text: WORKING_FILE_ID_TEXT } } : f.code === "GIT_FAILED" ? stepFailed() : f;
const profileRefusal = (reason: HunkRefusalReason): Refusal => ({ code: "UNSUPPORTED_HUNK_PROFILE", reason, remedy: { text: PROFILE_TEXTS[reason] } });
// Contract §4 "WSL index publication": acceptance refuses from the listing of the comparison, so no Git process starts.
export const SHARED_REPOSITORY = { code: "UNSUPPORTED_HUNK_PROFILE", result: { reason: "shared-repository", remedy: { text: PROFILE_TEXTS["shared-repository"] } } } as const;

export const isStop = (f: unknown): f is Stop => typeof f === "object" && f !== null && "stop" in f;
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const sameVersion = (a: WorkingVersion, b: WorkingVersion) => Buffer.compare(a.path, b.path) === 0 && Bun.deepEquals({ ...a, path: null }, { ...b, path: null }, true);

// Contract §9 "Lingering count": the sentences need a nonzero count, and "Revoke trust also ends them." needs a current trust ID.
// A WSL `lock` walk that stopped or failed leaves the lock to reconciliation (contract §4 "Stopped or failed `lock`").
export function lockRefusal(locked: Exclude<LockResult | WslLockResult, { ok: true }>, lingering: number | null, trustId: boolean): Refusal | Stop {
  if (!("ok" in locked)) return "stop" in locked ? { stop: locked.stop } : refusalOf(locked);
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

// Research R3 step 13. Every result but `published` leaves the canonical index unchanged. A WSL `replace-failed` can still have renamed.
export function publishRefusal(r: Exclude<PublishResult | WslPublishResult, { published: true }>, lockPath: string): Refusal {
  switch (r.reason) {
    case "notOwned":
      return { ...STALE, path: lockPath };
    case "mismatch":
      return STALE;
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

// The context of a publication. Its runner also sends the `wslFiles` walks of a WSL repository.
export type PublishContext = ObserveContext & { runner: GitRunner & WslRunner };

export interface PolicyFacts {
  listing: Pick<TrustListing, "entries" | "hooks">;
  gate: "TRUST_REQUIRED" | "TRUST_CHANGED" | null;
  policyFingerprint: string;
  // Null when the gate refused, the listing alone refuses the profile, or no path was given. `check-attr` runs only after the gate (contract §7).
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
  index: Fact<IndexFacts | WslIndexFacts>;
  operationState: Fact<OperationState>;
  // Null when the binding holds no working version. `changed`: the read found the file above the bound, or replaced twice (`readWorkingVersion`).
  working: Fact<WorkingVersion> | { changed: true } | null;
}

// An abort makes a pending `run` throw. Any other throw is no Git answer.
export const settled = <T>(signal: AbortSignal, work: Promise<T>): Promise<T | Stop | Failure> => work.catch(() => (signal.aborted ? CANCELED : { code: "GIT_FAILED" }));

export async function stepOf(ctx: ObserveContext, args: string[], out: Collector, input?: Uint8Array): Promise<{ exit: GitExit } | Failure | Stop> {
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

// Contract §4 and §7: the configuration listing, the trust gate, the policy fingerprint, and the attributes of `path`. A null `path` runs no `check-attr`.
export async function observePolicy(ctx: ObserveContext, path: Uint8Array | null, kind: "reads" | "commit" = "reads"): Promise<PolicyObservation> {
  const { trust, workspace: w, installation } = ctx;
  const listed = await settled(ctx.signal, trust.listTrust({ operationId: ctx.operationId, signal: ctx.signal, workspace: w }));
  if (!("ok" in listed)) return listed;
  if (!listed.ok) return "stop" in listed ? { stop: listed.stop } : failureOf(listed.code);
  const listing = listed.listing;
  const gate = trust.gate(w, listing, installation, kind);
  // `check-attr` reads the index, so a command-valued `core.fsmonitor` would run. `checkpointRefusal` gives the profile refusal before it reads the attributes.
  const attributes = path !== null && gate === null && hunkEligibility({ link: null }, w.objectFormat, listing, w.wsl !== undefined).eligible ? await attributesOf(ctx, path) : null;
  return { listing, gate, policyFingerprint: policyOf(trust, w, listing, installation), attributes };
}

export async function indexOf(w: Workspace): Promise<Fact<IndexFacts>> {
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

export async function workingOf(w: Workspace, path: Uint8Array, bound: WorkingBound = "COMPARED_RAW_VERSION_BYTES"): Promise<Fact<WorkingVersion> | { changed: true }> {
  const read = await readWorkingVersion(w.worktreeRoot, path, bound, null);
  if (read.ok) return { value: read.value };
  const c = read.completeness;
  if (c.state === "limited" || (c.state === "failed" && c.code === "REPOSITORY_CHANGED")) return { changed: true };
  if (c.state === "failed" && c.code === "UNSUPPORTED_HUNK_PROFILE") return { code: c.code, reason: "file-id" };
  return { code: c.state === "failed" ? c.code : "GIT_FAILED" };
}

const UTF8_PATH = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Contract §4 "Binding": the whole working file. A WSL repository takes its digest inside the distro, so no working-file byte crosses.
export async function wholeWorking(ctx: PublishContext, path: Uint8Array): Promise<Fact<WorkingVersion | WslWhole> | { changed: true }> {
  const w = ctx.workspace;
  return w.wsl === undefined ? workingOf(w, path, "WHOLE_FILE_STAGE_INPUT_BYTES") : wslWhole(ctx, UTF8_PATH.decode(path).split("/"));
}

// True: the whole working file differs from the binding. A null binding means an absent file (a tracked deletion).
export function differs(bound: { size: number; sha256: string } | null, read: Fact<WorkingVersion | WslWhole> | { changed: true }): Fact<boolean> {
  if ("changed" in read) return { value: true };
  if (!("value" in read)) return read;
  const v = read.value;
  const whole: WslWhole = typeof v === "string" || !("exists" in v) ? v : !v.exists ? "absent" : v.type === "file" ? { size: v.size, sha256: v.rawDigest } : "other";
  const same = whole === "absent" ? bound === null : whole !== "other" && bound !== null && whole.size === bound.size && whole.sha256 === bound.sha256;
  return { value: !same };
}

// Contract §4 "WSL index publication": a WSL repository compares the `indexDigest` result with the bound digest.
export const canonicalIndex = (ctx: PublishContext, bound: RawIndexPart): Promise<Fact<IndexFacts | WslIndexFacts>> =>
  ctx.workspace.wsl === undefined ? indexOf(ctx.workspace) : wslIndexOf(ctx, bound);

// Research R3 steps 5, 11, and 14: HEAD, the canonical index, the operation state, and the bound working version.
export async function observeState(ctx: ObserveContext, path: Uint8Array, bindsWorking: boolean, index: Promise<Fact<IndexFacts | WslIndexFacts>> = indexOf(ctx.workspace)): Promise<StateObservation> {
  const t = { operationId: ctx.operationId, signal: ctx.signal, workspace: ctx.workspace };
  const [captured, indexed, working] = await Promise.all([
    settled(ctx.signal, captureHead(ctx.runner, t)),
    settled(ctx.signal, index),
    bindsWorking ? settled(ctx.signal, workingOf(ctx.workspace, path)) : null,
  ]);
  const head: Fact<Head> = isStop(captured) || "code" in captured ? captured : "failed" in captured ? failureOf(captured.failed) : { value: captured };
  const operationState = "value" in indexed ? stateFact(await settled(ctx.signal, ctx.reader.operationState(t, indexed.value.unmerged))) : indexed;
  return { head, index: indexed, operationState, working };
}

function stateFact(state: Awaited<ReturnType<WorkspaceReader["operationState"]>> | Stop | Failure): Fact<OperationState> {
  if (state === "canceled" || state === "deadline") return { stop: state };
  if (typeof state === "string") return { value: state };
  return "refused" in state ? failureOf(state.refused) : state;
}

export type CheckpointBinding = Pick<ComparisonBinding, "head" | "index" | "working" | "attributes" | "policyFingerprint" | "operationState">;

// Contract §4 and §9. The first match wins. A stop wins over every refusal, and a deadline over a cancel.
export function checkpointRefusal(binding: CheckpointBinding, policy: PolicyObservation, state: StateObservation, objectFormat: ObjectFormat, wsl = false): Refusal | Stop | null {
  const attributes = "listing" in policy ? policy.attributes : null;
  const stops = [policy, attributes, state.head, state.index, state.operationState, state.working].filter(isStop);
  if (stops.length > 0) return stops.some((s) => s.stop === "deadline") ? DEADLINE : CANCELED;
  if (!("listing" in policy)) return refusalOf(policy as Failure);
  if (policy.gate !== null) return { code: policy.gate };
  if (policy.policyFingerprint !== binding.policyFingerprint) return { code: "TRUST_CHANGED" };
  if (!("value" in state.index)) return refusalOf(state.index as Failure);
  let eligibility;
  try {
    eligibility = hunkEligibility(state.index.value.raw, objectFormat, policy.listing, wsl);
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
export const directionOf = (c: Pick<RetainedComparison, "scope">) => (c.scope === "head-to-index" ? "unstage" : "stage");

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
export type Recording<R extends GitRunner> = R & { readonly last: number | null; reset(): void };
export function recording<R extends GitRunner>(runner: R): Recording<R> {
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

// Contract §11 "Paths and file access": a metadata-only `lstat` through UNC. Any failure but a missing file names the path.
const present = (path: string) => lstat(path).then(
  () => true,
  (error: unknown) => !isMissing(error),
);
const settledRemove = (r: WslRemoved | Failure | Stop) => r === "removed" || r === "notOwned";

// Contract §4 "WSL index publication": removals run inside the distro, only after the process-end fact. A candidate goes only by its verified digest.
// A file that stays goes into `foreign` when `lstat` finds it. Without `removable`, both files go into `foreign`. True: ownership stays unknown.
async function releaseWsl(ctx: WslContext, lock: HeldLock | null, candidatePath: string | null, verified: string | null, removable: boolean, foreign: string[]): Promise<boolean> {
  let unknown = !removable;
  if (lock !== null && !settledRemove(removable ? await lock.release() : "remove-failed")) {
    unknown = true;
    foreign.push(lock.path);
  }
  if (candidatePath !== null) {
    const r = removable && verified !== null ? await removeCandidate(ctx, basename(candidatePath), verified) : "notOwned";
    if (!settledRemove(r)) unknown = true;
    if (!removable || !settledRemove(r) || (r === "notOwned" && (await present(candidatePath)))) foreign.push(candidatePath);
    if (await present(`${candidatePath}.lock`)) foreign.push(`${candidatePath}.lock`);
  }
  return unknown;
}

// Contract §8 "Observed locks": the Git-resolved form of the lock path. An owned file in the folder of the index gets the same folder text.
export const besideIndex = (w: Pick<Workspace, "indexPath">, path: string) => `${w.indexPath.slice(0, w.indexPath.length - basename(w.indexPath).length)}${basename(path)}`;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

// Contract §8 "Observed locks": the existing files of the lock set, in the Git-resolved form. `head` names the current branch; a detached HEAD has no branch ref lock.
// Contract §11 "Paths and file access": a WSL path is the UNC form of the Git-resolved path, with `\` separators.
export async function observedLocks(ctx: ObserveContext, head: Head | null): Promise<string[] | Failure | Stop> {
  const w = ctx.workspace;
  const sep = w.wsl === undefined ? "/" : "\\";
  const paths = [`${w.indexPath}.lock`, `${w.gitDirectory}${sep}HEAD.lock`];
  if (w.refFormat === "reftable") paths.push(...[...new Set([w.gitDirectory, w.commonDirectory])].map((dir) => `${dir}${sep}reftable${sep}tables.list.lock`));
  else {
    paths.push(`${w.commonDirectory}${sep}packed-refs.lock`);
    if (head !== null && head.state !== "detached") {
      if (!isRefName(head.target)) return { code: "GIT_FAILED" };
      const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
      const step = await stepOf(ctx, refPathArgs(head.target), out);
      if (!("exit" in step)) return step;
      if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
      const raw = out.take();
      const malformed: Failure = { code: "MALFORMED_GIT_OUTPUT" };
      if (out.limited || raw.length === 0 || raw[raw.length - 1] !== 0x0a) return malformed;
      let line: string;
      try {
        line = UTF8.decode(raw.subarray(0, -1));
      } catch {
        return malformed;
      }
      // Linux Git prints a Linux path. A name without a UNC form is malformed here.
      const ref = w.wsl === undefined ? line : wslIdentityPath(w.wsl.distro, line);
      if (ref === null || line.includes("\n") || !isChannelPath(ref)) return malformed;
      paths.push(`${ref}.lock`);
    }
  }
  const found = await Promise.all(
    paths.map((path) =>
      lstat(path).then(
        () => true,
        (error: unknown) => (isMissing(error) ? false : null),
      ),
    ),
  );
  if (found.includes(null)) return { code: "GIT_FAILED" };
  return paths.filter((_, i) => found[i]);
}

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
// `candidate`: null until `publish()` gets the verified candidate. Without it, only `before` can match.
export interface RetainedPublication {
  repositoryId: string;
  before: string | null;
  candidate: string | null;
  // WSL: the token of the `lock` request (contract §4 "Lock token"). Recovery removes nothing with it (contract §8).
  token?: string;
}

export type Ending = Refusal | Stop | { published: true };

// The owned lock that reconciliation removes. A WSL lock without a `lock` reply removes by its token alone.
export interface HeldLock {
  path: string;
  release(): Promise<WslRemoved | Failure | Stop>;
}

// The owned files and the progress of one publication.
export interface PublicationRun {
  lock: HeldLock | null;
  // The verified candidate. Its digest is the one that a WSL `remove` names (contract §4 "WSL index publication").
  candidate: Candidate | null;
  // The Git-resolved form (`besideIndex`).
  candidatePath: string | null;
  // `publish()` started and did not return.
  publishing: boolean;
  // `publish()` was called. It is never reset.
  publishStarted: boolean;
  // `publish()` returned `published`.
  published: boolean;
  // Data-model §7 `lingeringDescendants`: the count of the last execution process before reconciliation.
  executionLast: number;
  listing: PolicyFacts["listing"] | null;
}

// Data-model §7 rows for a `started` reply without a marker ID.
export function notEntered(registry: OperationRegistry, operationId: string, n: NotEntered): void {
  if (n.code === "BUSY") {
    if (n.remedy === undefined) return void registry.apply(operationId, { type: "exclusion-unavailable", code: "BUSY" });
    return void registry.apply(operationId, { type: "marker-refused", code: "BUSY" }, { remedy: n.remedy });
  }
  if (n.code === "RECOVERY_MARKER_FAILED") return void registry.apply(operationId, { type: "marker-refused", code: n.code }, { failure: n.failure, path: n.folder, remedy: n.remedy });
  if (n.code === "DEADLINE") return void registry.apply(operationId, { type: "started-deadline" }, undefined, "DEADLINE");
  registry.apply(operationId, { type: "exclusion-unavailable", code: n.code });
}

export interface PublicationReconciliation {
  registry: OperationRegistry;
  runner: Pick<GitRunner, "resolved">;
  retained: Map<string, RetainedPublication>;
  operationId: string;
  markerId: string;
  rec: ReturnType<typeof recording>;
  // Its `runner` is `rec`.
  ctx: PublishContext;
  path: Uint8Array;
  binding: Pick<CheckpointBinding, "head" | "index" | "operationState">;
  run: PublicationRun;
  ending: Ending;
  unexpected: boolean;
  foreign: string[];
  // True: a WSL `remove` left the ownership unknown.
  releaseOwned: (processesEnded: boolean) => Promise<boolean>;
  // True: the working file differs from the binding.
  working: (ctx: PublishContext) => Promise<Fact<boolean>>;
}

// The terminal event of one reconciliation. `known`: the outcome is not `unknown`, so `resolved` follows. `result` holds no `foreign`.
interface Decision {
  event: Parameters<OperationRegistry["apply"]>[1];
  result?: Record<string, unknown>;
  cause: DiagnosticCause | undefined;
  known: boolean;
}

// Contract §8: a failed observation gives `unknown`. The marker and the retained digests stay.
function unknownOf(failed: Failure | Stop, refusal: Refusal | null): Decision {
  const code = "code" in failed ? failed.code : "DEADLINE";
  const event = "code" in failed ? { type: "reconciliation-read-failed" as const, code } : { type: "reconciliation-read-deadline" as const };
  return { event, cause: diagnosticCause(code, refusal, undefined), known: false };
}

// Contract §4 "WSL index publication": after publication, a digest equal to a retained digest reads no index bytes.
// Neither retained index holds an entry above stage 0: acceptance refused a conflicted index, and step 6 verified the candidate.
async function wslIndexAfter(ctx: WslContext, bound: RawIndexPart, candidate: string | null): Promise<Fact<IndexFacts | WslIndexFacts>> {
  const read = await wslIndexDigest(ctx);
  if (!("value" in read)) return read;
  const part = read.value.index;
  const digest = part.kind === "digest" ? part.sha256 : null;
  if (part.kind === "error" || part.kind === "bound" || (digest !== bound.rawIndexDigest && digest !== candidate)) return wslIndexOf(ctx, bound);
  return { value: { raw: { link: digest === bound.rawIndexDigest ? (bound.sharedIndex?.hash ?? null) : null }, digest, unmerged: false, reply: read.value } };
}

// Contract §4 "Process end": no fact, or a `remove` that leaves ownership unknown, gives `unknown`.
const OWNERSHIP_UNKNOWN: Failure = { code: "GIT_FAILED" };

// Research R3 step 14 and contract §8: the reconciliation of an `applyHunk` or `applyFile` publication.
export async function reconcilePublication(r: PublicationReconciliation): Promise<void> {
  const { registry, operationId, run, ending, binding, foreign } = r;
  const wsl = r.ctx.workspace.wsl !== undefined;
  const deadline = isStop(ending) && ending.stop === "deadline";
  const canceled = enterReconciling(registry, operationId, deadline, run.executionLast);
  // Contract §8: a cancel never stops a reconciliation read, so these reads get a signal that never aborts.
  // Outside WSL, only an exit reply of these reads is a fresh process-end fact for the owned candidate.
  r.rec.reset();
  const quiet = { ...r.ctx, signal: new AbortController().signal };
  const refusal = "code" in ending ? ending : null;
  foreign.push(...(refusal?.foreign ?? []));
  const observe = (index?: Promise<Fact<IndexFacts | WslIndexFacts>>) => Promise.all([observeState(quiet, r.path, false, index), settled(quiet.signal, r.working(quiet))] as const);

  let observed: StateObservation | null = null;
  let working: Fact<boolean> | null = null;
  let lost = false;
  if (!wsl) {
    [observed, working] = await observe();
    await r.releaseOwned(r.rec.last === 0);
  } else {
    // Contract §4 "Process end": a stopped walk can still change files, so nothing decides and nothing is removed before this fact.
    let decides = (await processEnd(quiet)) === "fact";
    if (decides) {
      [observed, working] = await observe(wslIndexAfter(quiet, binding.index, run.candidate?.digest ?? null));
      const index = observed.index;
      // A published candidate replaced the index with the lock, so no owned lock remains.
      if ("value" in index && run.publishStarted && index.value.digest === run.candidate?.digest) run.lock = null;
      // Contract §4 "Outcome after a stopped walk": an `index` part `absent`, `bound`, or `error` decides nothing, so the owned files stay foreign.
      decides = "value" in index && !(index.value.digest === null && run.publishStarted && !run.published);
    }
    lost = await r.releaseOwned(decides);
  }

  const failedRead = observed === null || working === null ? OWNERSHIP_UNKNOWN : ([observed.head, observed.index, observed.operationState, working].find((f) => !("value" in f)) as Failure | Stop | undefined);
  let decision =
    failedRead !== undefined ? unknownOf(failedRead, refusal) : lost ? unknownOf(OWNERSHIP_UNKNOWN, refusal) : classifyPublication(r, observed!, (working as { value: boolean }).value, refusal, canceled, deadline);
  if (decision.event.type !== "intended-effects-confirmed") {
    const locks = await observedLocks(quiet, observed !== null && "value" in observed.head ? observed.head.value : binding.head);
    if (Array.isArray(locks)) {
      for (const path of locks) if (foreign.length < RECOVERY_FOREIGN_CAP && !foreign.includes(path)) foreign.push(path);
    } else if (decision.known) decision = unknownOf(locks, refusal);
  }
  const result = { ...decision.result, ...(foreign.length > 0 ? { foreign } : {}) };
  registry.apply(operationId, decision.event, Object.keys(result).length > 0 ? result : undefined, decision.cause);
  if (!decision.known) return;
  // Contract §6: `resolved` follows a known outcome.
  r.runner.resolved(r.markerId);
  r.retained.delete(operationId);
}

// Contract §8 and §9: the outcome of a reconciliation whose reads all succeeded.
function classifyPublication(r: PublicationReconciliation, observed: StateObservation, workingFiles: boolean, refusal: Refusal | null, canceled: boolean, deadline: boolean): Decision {
  const { registry, operationId, run, binding } = r;
  const head = (observed.head as { value: Head }).value;
  const digest = (observed.index as { value: IndexFacts | WslIndexFacts }).value.digest;
  const operationState = (observed.operationState as { value: OperationState }).value;
  const effectsWith = (index: boolean) => ({
    head: !Bun.deepEquals(head, binding.head, true),
    index,
    workingFiles,
    operationState: operationState !== binding.operationState,
  });
  // Contract §9: the canonical index digest decides publication. A returned publication with another digest is published with an index effect.
  // Contract §4: a refusal before `publish()` prevents publication. An equal digest before that call comes from an external writer.
  const viaDigest = run.publishStarted && run.candidate !== null && digest === run.candidate.digest;
  const changed = digest !== binding.index.rawIndexDigest;
  const cause = diagnosticCause(null, refusal, registry.get(operationId)!.cause);
  if (viaDigest || run.published) {
    const effects = effectsWith(!viaDigest);
    if (Object.values(effects).some(Boolean)) return { event: { type: "differing-effects" }, result: { effects }, cause, known: true };
    return { event: { type: "intended-effects-confirmed" }, cause, known: true };
  }
  // `publish()` threw, and the index matches neither retained digest. Contract §9 "publish without a typed result" gives `unknown`.
  if (run.publishing && changed) return { event: { type: "reconciliation-read-failed", code: "GIT_FAILED" }, cause: "GIT_FAILED", known: false };
  // Contract §8: an execution failure with observed changes is failed-with-effects. A checkpoint code never is. Contract §9: a deadline keeps its reason.
  if (changed && (deadline || r.unexpected || (STEP_CAUSES as readonly unknown[]).includes(refusal?.cause))) {
    return { event: { type: "failed-with-effects" }, result: { effects: effectsWith(true) }, cause, known: true };
  }
  if (canceled) return { event: { type: "no-effects", observed: "canceled" }, cause, known: true };
  const { code, cause: _cause, foreign: _foreign, ...fields }: Partial<Refusal> = refusal ?? {};
  const reason = code === "OUTPUT_LIMIT" ? fields.reason : undefined;
  return { event: { type: "no-effects", observed: "failed", ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }, result: fields, cause, known: true };
}

export interface HunkPublisherOptions {
  runner: GitRunner & WslRunner;
  trust: Trust;
  reader: Pick<WorkspaceReader, "operationState">;
  comparisons: Pick<ComparisonReader, "get">;
  approvals: Approvals;
  registry: OperationRegistry;
  exclusion: Exclusion;
  respond: (response: Response) => unknown;
  hunkCheckpoint?: (checkpoint: HunkCheckpoint) => Promise<void> | void;
}

// Contract §5 and §8: one store for `applyHunk` and `applyFile`, so that recovery (T114) reads one store.
export interface PublicationStores {
  retained: Map<string, RetainedPublication>;
  // Contract §2: the workspace of each operation that consumed an approval.
  owners: Map<string, string>;
}

export interface PublicationSession {
  ctx: PublishContext;
  rec: Recording<PublishContext["runner"]>;
  run: PublicationRun;
  path: Uint8Array;
}

type Admission = { approval: { binding: PublicationReconciliation["binding"] & { entry: { pathBytes: string } } } };

// The parts of one publisher. `A` holds the admitted approval.
export interface PublicationSteps<A extends Admission> {
  // Contract §2, §9: the acceptance checks after the accepted event. Memory only, so no Git process starts.
  admit(): A | { code: ErrorCode; result?: unknown };
  // The steps between the owned lock and `publish()`. Null: `run.candidate` goes to `publish()`.
  prepare(a: A, s: PublicationSession): Promise<Refusal | Stop | null>;
  // True: the working file differs from the binding.
  working(a: A, ctx: PublishContext, path: Uint8Array): Promise<Fact<boolean>>;
}

type PublicationRequest = Extract<ServiceRequest, { operation: "applyHunk" | "applyFile" }>;

// The `applyHunk` and `applyFile` skeleton: the repeat answer, acceptance, the exclusion, the owned lock, `publish()`, and reconciliation.
export function startPublication<A extends Admission>(o: HunkPublisherOptions & PublicationStores, request: PublicationRequest, w: Workspace, installation: ReadInstallation, key: ApprovalKey, p: PublicationSteps<A>): void {
  const { registry } = o;
  // Contract §2: an approval that an accepted operation consumed answers a repeat with that operation, without an accepted event or a process.
  const peek = o.approvals.accept(key);
  if (!peek.ok && "consumed" in peek && o.owners.get(peek.consumed) === request.repositoryId) {
    return void o.respond({ requestId: request.requestId, operationId: peek.consumed, state: "succeeded", result: registry.get(peek.consumed) });
  }
  const { operationId, signal } = registry.start(request.operation, request.requestId);
  const admitted = p.admit();
  if ("code" in admitted) return void registry.apply(operationId, { type: "invalid-approval", code: admitted.code }, admitted.result);
  void publish(o, request, w, installation, operationId, signal, key, admitted, p);
}

async function publish<A extends Admission>(o: HunkPublisherOptions & PublicationStores, request: PublicationRequest, w: Workspace, installation: ReadInstallation, operationId: string, signal: AbortSignal, key: ApprovalKey, a: A, p: PublicationSteps<A>): Promise<void> {
  const { registry, retained } = o;
  const binding = a.approval.binding;
  const path = new Uint8Array(Buffer.from(binding.entry.pathBytes, "base64"));
  let entered: Entered | NotEntered;
  try {
    entered = await o.exclusion.enter({ operationId, kind: request.operation, direction: request.payload.direction, workspace: w });
  } catch {
    return void registry.apply(operationId, { type: "exclusion-unavailable", code: "GIT_FAILED" });
  }
  if (!entered.ok) return notEntered(registry, operationId, entered);
  const marker = entered;
  const rec = recording(o.runner);
  const ctx: PublishContext = { runner: rec, trust: o.trust, reader: o.reader, operationId, signal, workspace: w, installation };
  const run: PublicationRun = { lock: null, candidate: null, candidatePath: null, publishing: false, publishStarted: false, published: false, executionLast: 0, listing: null };
  const foreign: string[] = [];
  // Owned files. `release` removes the lock only while the path names the owned file (contract §4). Each path is handled once.
  const releaseOwned = async (processesEnded: boolean): Promise<boolean> => {
    const { lock, candidatePath } = run;
    run.lock = null;
    run.candidatePath = null;
    if (w.wsl !== undefined) return releaseWsl(ctx, lock, candidatePath, run.candidate?.digest ?? null, processesEnded, foreign);
    if (lock !== null && (await lock.release().catch(() => "remove-failed" as const)) === "remove-failed") foreign.push(lock.path);
    if (candidatePath !== null) foreign.push(...(await removeOwned([candidatePath, `${candidatePath}.lock`], processesEnded)));
    return false;
  };
  const extra = () => (foreign.length > 0 ? { foreign } : undefined);
  try {
    registry.apply(operationId, { type: "marker-recorded" });
    o.owners.set(operationId, request.repositoryId);
    // Contract §5: the digests stay until reconciliation succeeds, so recovery can compare them.
    const kept: RetainedPublication = { repositoryId: w.repositoryId, before: binding.index.rawIndexDigest, candidate: null };
    retained.set(operationId, kept);

    const steps = async (): Promise<Ending> => {
      if (!o.approvals.consume(key, operationId)) {
        const now = o.approvals.accept(key);
        return { code: !now.ok && "code" in now ? now.code : "UNKNOWN_TARGET" };
      }
      // Research R3 step 4 and contract §4 "File staging" step 2.
      if (signal.aborted) return CANCELED;
      const refuse = async (locked: Exclude<LockResult | WslLockResult, { ok: true }>) => {
        const answer = "ok" in locked && "code" in locked ? await o.runner.lingeringCount(operationId, w.commonDirectory).catch(() => null) : null;
        return lockRefusal(locked, typeof answer === "number" ? answer : null, o.trust.currentTrustId(w) !== undefined);
      };
      let publishVia: (c: Candidate) => Promise<PublishResult | WslPublishResult | Failure | Stop>;
      if (w.wsl !== undefined) {
        // Contract §4 "Process end": this run starts the anchor of the operation before `lock`.
        if ((await processEnd(ctx)) === "noFact") return stepFailed();
        if (signal.aborted) return CANCELED;
        const locked = await wslLock(ctx);
        if ("unknown" in locked) {
          run.lock = { path: locked.unknown.path, release: locked.unknown.removeByToken };
          kept.token = locked.unknown.token;
        }
        if (!("ok" in locked) || !locked.ok) return refuse(locked);
        const lock = locked.lock;
        run.lock = lock;
        kept.token = lock.token;
        publishVia = (c) => lock.publish(basename(c.path), c.digest, signal);
      } else {
        const locked = await createIndexLock(w.indexPath);
        if (!locked.ok) return refuse(locked);
        const lock = locked.lock;
        run.lock = lock;
        publishVia = (c) => lock.publish(c.bytes, c.mtimeNs);
      }
      const lockPath = run.lock.path;
      const refused = await p.prepare(a, { ctx, rec, run, path });
      if (refused !== null) return refused;
      const candidate = run.candidate!;
      // Research R3 step 13 and contract §4 step 8.
      kept.candidate = candidate.digest;
      registry.progress(operationId, "publication");
      run.publishing = true;
      run.publishStarted = true;
      const result = await publishVia(candidate);
      // A WSL refusal is no typed result, so `publishing` stays set (contract §9 "publish without a typed result").
      if (!isStop(result) && !("published" in result)) return refusalOf(result);
      run.publishing = false;
      if (isStop(result)) return result;
      if (!result.published) {
        // Contract §4 "WSL index publication": after `notOwned`, no owned lock remains at the path.
        if (result.reason === "notOwned") run.lock = null;
        return publishRefusal(result, lockPath);
      }
      run.published = true;
      run.lock = null;
      await o.hunkCheckpoint?.({ step: 13, operationId });
      return { published: true };
    };

    let ending: Ending;
    let unexpected = false;
    try {
      ending = await steps();
    } catch {
      unexpected = !signal.aborted;
      ending = signal.aborted ? CANCELED : stepFailed();
    }

    // Research R3 step 14 and contract §4 step 9.
    await reconcilePublication({
      registry,
      runner: o.runner,
      retained,
      operationId,
      markerId: marker.markerId,
      rec,
      ctx,
      path,
      binding,
      run,
      ending,
      unexpected,
      foreign,
      releaseOwned,
      working: (q) => p.working(a, q, path),
    });
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

type ApplyHunkRequest = Extract<ServiceRequest, { operation: "applyHunk" }>;
type Admitted = { approval: HunkApproval; comparison: RetainedComparison; hunk: RetainedComparison["hunks"][number] };

export function createHunkPublisher(o: HunkPublisherOptions) {
  const stores: PublicationStores = { retained: new Map(), owners: new Map() };
  const shared = { ...o, ...stores };
  const { registry } = o;

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
    if (c.sharedRepository) return SHARED_REPOSITORY;
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

  // Research R3 steps 5 to 12 under the lock.
  async function prepare({ approval: { binding }, comparison: c, hunk }: Admitted, { ctx, rec, run, path }: PublicationSession): Promise<Refusal | Stop | null> {
    const { workspace: w, signal, operationId } = ctx;
    const wsl = w.wsl !== undefined;
    const checkpoint = async (step: 5 | 11): Promise<Refusal | Stop | null> => {
      const policy = await observePolicy(ctx, path);
      if ("listing" in policy) run.listing = policy.listing;
      const refused = checkpointRefusal(binding, policy, await observeState(ctx, path, binding.working !== null, canonicalIndex(ctx, binding.index)), w.objectFormat, wsl);
      if (refused !== null) return refused;
      // A WSL read folds no working version, so the whole-file digest of the comparison decides last (contract §4 "Binding", §9).
      if (wsl && c.scope !== "head-to-index") {
        const read = differs(c.working, await settled(signal, wholeWorking(ctx, path)));
        if (!("value" in read)) return isStop(read) ? read : refusalOf(read);
        if (read.value) return STALE;
      }
      await o.hunkCheckpoint?.({ step, operationId });
      return signal.aborted ? CANCELED : null;
    };
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
    run.candidate = prepared.candidate;
    run.candidatePath = besideIndex(w, prepared.candidate.path);
    // Research R3 steps 11 and 12.
    return checkpoint(11);
  }

  // Contract §8: the bound working version, else no working-file effect. A WSL comparison binds the whole-file digest.
  async function working({ approval: { binding }, comparison: c }: Admitted, ctx: PublishContext, path: Uint8Array): Promise<Fact<boolean>> {
    if (ctx.workspace.wsl !== undefined) return c.scope === "head-to-index" ? { value: false } : differs(c.working, await wholeWorking(ctx, path));
    if (binding.working === null) return { value: false };
    const read = await workingOf(ctx.workspace, path);
    if ("changed" in read) return { value: true };
    return "value" in read ? { value: !sameVersion(read.value, binding.working) } : read;
  }

  function applyHunk(request: ApplyHunkRequest, w: Workspace, installation: ReadInstallation): void {
    const { comparisonId, hunkId, direction } = request.payload;
    const key: ApprovalKey = { kind: "hunk", comparisonId, hunkId, direction };
    startPublication(shared, request, w, installation, key, { admit: () => admit(request, w, key), prepare, working });
  }

  return { applyHunk, ...stores };
}

export type HunkPublisher = ReturnType<typeof createHunkPublisher>;
