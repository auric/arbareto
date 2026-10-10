// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T112 and T113: `commit`, research R4 steps 1 to 7, contract §2, §4 "Commit validation and handoff", §5, §6, §8, and §9.
// No step writes the index. The commit process is Git's own `commit`. T214: a WSL repository locks and removes the lock inside the distro (contract §4 "WSL index publication").

import type { Response, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import { buildRemedyCommand, type RemedyCommand } from "../contracts/remedy-command";
import { buildWslRemedy, routeWslPath } from "../contracts/wsl-route";
import type { Acceptance, ApprovalKey, Approvals, CommitBinding, CommitReview } from "./approvals";
import { readTip, type ReflogRecord } from "./attribution";
import { authorIdentArgs, commitArgs, committerIdentArgs } from "./commands";
import type { CommitReviewer, RetainedReview } from "./commit-review";
import { createTailCollector } from "./discovery";
import type { Entered, Exclusion, NotEntered } from "./exclusion";
import { createCollector, PROCESS_LIMITS, RunnerRefusal, type GitExit, type GitRunner, type WslIndexResult, type WslRunner } from "./git-runner";
import {
  besideIndex,
  canonicalIndex,
  diagnosticCause,
  enterReconciling,
  failureOf,
  isStop,
  lingeringSentence,
  notEntered,
  observePolicy,
  observeState,
  recording,
  REVOKE_TEXT,
  settled,
  type Fact,
  type Failure,
  type HeldLock,
  type IndexFacts,
  type ObserveContext,
  type PolicyObservation,
  type PublishContext,
  type Refusal,
  type StateObservation,
  type Stop,
} from "./hunk-publish";
import { createIndexLock, type LockResult } from "./index-lock";
import type { OperationRegistry } from "./operations";
import { contextOf } from "./read-steps";
import { reconcileCommit } from "./reconcile";
import type { Workspace } from "./registration";
import { policyFingerprint, type ReadInstallation } from "./snapshot";
import type { WorkspaceReader } from "./status";
import { keyParts, type ConfigEntry, type Trust } from "./trust";
import type { WslGit } from "./wsl";
import { processEnd, wslLock, type UnknownLock, type WslIndexFacts, type WslLockResult } from "./wsl-files";

// Contract §9: the remedy text of HOOK_FAILED and of a commit GIT_FAILED after handoff.
export const HOOK_REMEDY_TEXT = "This command runs the pre-commit hook in a terminal and does not commit. Other hooks show their output only here. Arbareto keeps your message.";
// Contract §9 "Other locks".
export const OTHER_LOCKS_TEXT = "Git could not take a lock. Another Git process, or a process that Git or a hook started, can hold it. Use Refresh after that process ends.";
// Contract §4 "Quoting rule": the text of a refused value.
const REFUSED_TEXT = "PowerShell cannot pass this value safely, so Arbareto offers no command: ";

const CANCELED: Stop = { stop: "canceled" };
const DEADLINE: Stop = { stop: "deadline" };
const STALE: Refusal = { code: "STALE_REVIEW" };
const EMPTY = new Uint8Array(0);

// Contract §9 "Lingering count": the sentences need a nonzero count, and "Revoke trust also ends them." needs a current trust ID.
const lingering = (count: number | null, trustId: boolean) => (count !== null && count > 0 ? ` ${lingeringSentence(count)}${trustId ? ` ${REVOKE_TEXT}` : ""}` : "");

// Contract §9: a GIT_FAILED before handoff carries no remedy. The diagnostic bound names OUTPUT_LIMIT as the cause.
const refusalOf = (f: Failure): Refusal => (f.reason === "UNEXPECTED_DIAGNOSTIC_BYTES_PER_OPERATION" ? { ...f, cause: "OUTPUT_LIMIT" } : f);

// Contract §9 and research R4: the remedy of HOOK_FAILED and of a GIT_FAILED after handoff (T113).
// The command runs the traditional and configured pre-commit hooks and creates no commit. A refused value gives its text without a command.
// `otherLocks`: the outcome names a foreign lock, so the "Other locks" text follows.
export function commitRemedy(gitPath: string, worktreeRoot: string, count: number | null, trustId: boolean, otherLocks = false): { text: string; command: string | null } {
  const built = buildRemedyCommand("& {git} --no-lazy-fetch -C {root} hook run --ignore-missing pre-commit", {
    git: { kind: "gitPath", text: gitPath, form: "windows" },
    root: { kind: "worktreeRoot", text: worktreeRoot, form: "windows" },
  });
  return hookRemedy(built, { gitPath, worktreeRoot }, count, trustId, otherLocks);
}

// Contract §11 "Remedy commands": the WSL form of the hook remedy. Null: the worktree root has no Linux form.
export function wslCommitRemedy(w: Pick<Workspace, "worktreeRoot"> & { wsl: WslGit }, count: number | null, trustId: boolean, otherLocks = false): { text: string; command: string | null } | null {
  const { wslExecutable, distro, path: gitPath, guid } = w.wsl;
  const route = routeWslPath(w.worktreeRoot, { listed: [distro], registry: [{ name: distro, guid, version: 2 }] });
  if (route.kind !== "wsl") return null;
  const built = buildWslRemedy("hook", { wslExecutable, distro, gitPath, worktreeRoot: route.linuxPath });
  return hookRemedy(built, { wslExecutable, distroName: distro, gitPath, worktreeRoot: route.linuxPath }, count, trustId, otherLocks);
}

// `values`: the text of each value kind, for the refused-value text.
function hookRemedy(built: RemedyCommand, values: Record<string, string>, count: number | null, trustId: boolean, otherLocks: boolean): { text: string; command: string | null } {
  const extra = `${otherLocks ? ` ${OTHER_LOCKS_TEXT}` : ""}${lingering(count, trustId)}`;
  if (built.command !== null) return { text: `${HOOK_REMEDY_TEXT}${extra}`, command: built.command };
  return { text: `${REFUSED_TEXT}${values[built.refused] ?? ""}${extra}`, command: null };
}

// Contract §4: Git takes the last `i18n.commitEncoding` value. Git `is_encoding_utf8` (utf8.c) treats an unset value, `utf-8`, and `utf8` in any ASCII case as UTF-8.
// Without the `u` flag, the `i` flag folds no non-ASCII character to an ASCII one (ECMA-262 Canonicalize).
export function utf8Commits(entries: readonly ConfigEntry[]): boolean {
  const last = entries
    .filter((e) => {
      const p = keyParts(e.key);
      return p?.section === "i18n" && p.subsection === null && p.variable === "commitencoding";
    })
    .at(-1);
  if (last === undefined) return true;
  // A key without a value fails Git's configuration read. Inexact bytes are not the text that Git compares.
  return last.value !== null && last.exact && /^utf-?8$/i.test(last.value);
}

type CommitRequest = Extract<ServiceRequest, { operation: "commit" }>;
export type CommitAdmission = { approval: CommitReview; review: RetainedReview };

// Contract §2, §7 "Mutation trust", and §9: the acceptance checks after the accepted event. Memory only, so no Git process starts.
export function admitCommit(
  request: Pick<CommitRequest, "repositoryId" | "repositoryGeneration">,
  w: Pick<Workspace, "generation">,
  accepted: Acceptance,
  retained: (reviewToken: string) => RetainedReview | undefined,
  gate: (binding: CommitBinding) => "TRUST_REQUIRED" | "TRUST_CHANGED" | null,
): CommitAdmission | { code: ErrorCode } {
  if (request.repositoryGeneration !== w.generation) return { code: "REPOSITORY_CHANGED" };
  if (!accepted.ok) return { code: "code" in accepted ? accepted.code : "UNKNOWN_TARGET" };
  const approval = accepted.approval;
  if (approval.kind !== "commit" || approval.repositoryId !== request.repositoryId || approval.generation !== w.generation) return { code: "UNKNOWN_TARGET" };
  // T111 drops kept review data older than 60 seconds at its next issue, so the admission keeps this reference.
  const review = retained(approval.reviewToken);
  if (review === undefined || review.repositoryId !== request.repositoryId) return { code: "UNKNOWN_TARGET" };
  // Contract §9: an unfinished operation refuses at acceptance, before the trust gate. `unknown` decides at the preflight.
  const state = approval.binding.operationState;
  if (state === "conflicted") return { code: "CONFLICTED" };
  if (state !== "normal" && state !== "unknown") return { code: "OPERATION_IN_PROGRESS" };
  const refused = gate(approval.binding);
  return refused === null ? { approval, review } : { code: refused };
}

type WslIndexPart = Extract<WslIndexResult, { kind: "index" }>["index"];
const digestOf = (p: WslIndexPart | undefined) => (p?.kind === "digest" ? p.sha256 : null);
// Contract §4 "WSL index publication": the WSL preflight compares both parts of the `indexDigest` reply with the review.
const wslIndexChanged = (v: IndexFacts | WslIndexFacts, reviewed: WslIndexResult | null) =>
  "reply" in v && (reviewed?.kind !== "index" || digestOf(v.reply.index) !== digestOf(reviewed.index) || digestOf(v.reply.sharedIndex) !== digestOf(reviewed.sharedIndex));

// Contract §9 commit preflight order before the identity check. The first match wins. A stop wins over every refusal, and a deadline over a cancel.
// `reviewedPolicy`: the policy fingerprint of the reviewed listing and trust. A difference covers every configuration entry.
// `tip`: the attribution tip read (contract §8 "Attribution window"). `reviewedWsl`: the `indexDigest` result of a WSL review.
export function preflightRefusal(
  b: Pick<CommitBinding, "reviewedIndex" | "head" | "operationState">,
  reviewedPolicy: string,
  policy: PolicyObservation,
  state: StateObservation,
  tip: Fact<ReflogRecord | null>,
  reviewedWsl: WslIndexResult | null = null,
): Refusal | Stop | null {
  const stops = [policy, state.head, state.index, state.operationState, tip].filter(isStop);
  if (stops.length > 0) return stops.some((s) => s.stop === "deadline") ? DEADLINE : CANCELED;
  if (!("listing" in policy)) return refusalOf(policy as Failure);
  if (policy.gate !== null) return { code: policy.gate };
  if (policy.policyFingerprint !== reviewedPolicy) return { code: "TRUST_CHANGED" };
  // The index read gives MALFORMED_GIT_OUTPUT for an index format error.
  if (!("value" in state.index)) return refusalOf(state.index as Failure);
  if (!("value" in state.operationState)) return refusalOf(state.operationState as Failure);
  if (!("value" in state.head)) return refusalOf(state.head as Failure);
  const observed = state.operationState.value;
  const index = state.index.value;
  if (index.digest !== b.reviewedIndex.rawIndexDigest || wslIndexChanged(index, reviewedWsl) || !Bun.deepEquals(state.head.value, b.head, true) || observed === "unknown" || observed !== b.operationState) return STALE;
  // Contract §9: every tip failure gives GIT_FAILED, except an OUTPUT_LIMIT bound.
  if (!("value" in tip)) return (tip as Failure).code === "OUTPUT_LIMIT" ? refusalOf(tip as Failure) : { code: "GIT_FAILED" };
  return utf8Commits(policy.listing.entries) ? null : { code: "COMMIT_ENCODING_UNSUPPORTED" };
}

// Contract §9: `git var` checks identity last. Git documents no exit status for a missing identity, so a nonzero exit gives GIT_FAILED with the tail of its stderr.
async function identityRefusal(ctx: ObserveContext): Promise<Refusal | Stop | null> {
  for (const args of [authorIdentArgs(), committerIdentArgs()]) {
    const tail = createTailCollector("plain");
    const run = ctx.runner.run({
      operationId: ctx.operationId,
      context: contextOf(ctx.workspace),
      arguments: args,
      environmentPolicy: "read",
      limits: PROCESS_LIMITS.git,
      stdout: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
      stderr: tail,
      signal: ctx.signal,
    });
    const step = await settled(
      ctx.signal,
      run.then(
        (exit) => ({ exit }),
        (error: unknown) => {
          if (error instanceof RunnerRefusal) return failureOf(error.code);
          throw error;
        },
      ),
    );
    if (ctx.signal.aborted) return CANCELED;
    if (!("exit" in step)) return isStop(step) ? step : refusalOf(step);
    if (step.exit.deadline !== undefined) return DEADLINE;
    if (step.exit.diagnosticLimit) return refusalOf(failureOf("OUTPUT_LIMIT"));
    if (step.exit.exitCode !== 0) return { code: "GIT_FAILED", outputTail: tail.outputTail() };
  }
  return null;
}

// Contract §5 and §8: the reviewed data of an accepted commit. It stays until reconciliation succeeds.
export interface RetainedCommit {
  repositoryId: string;
  review: RetainedReview;
  binding: CommitBinding;
  // The preflight attribution tip. Null before the preflight passes, and when Git printed no record.
  tip: ReflogRecord | null;
}

export interface CommitterOptions {
  runner: GitRunner & WslRunner;
  trust: Trust;
  reader: Pick<WorkspaceReader, "operationState">;
  reviews: Pick<CommitReviewer, "retained">;
  approvals: Approvals;
  registry: OperationRegistry;
  exclusion: Exclusion;
  respond: (response: Response) => unknown;
}

export function createCommitter(o: CommitterOptions) {
  const { registry, approvals } = o;
  const retained = new Map<string, RetainedCommit>();
  // Contract §2: the workspace of each operation that consumed a review token.
  const owners = new Map<string, string>();

  async function execute(request: CommitRequest, w: Workspace, installation: ReadInstallation, operationId: string, signal: AbortSignal, key: ApprovalKey, a: CommitAdmission): Promise<void> {
    let entered: Entered | NotEntered;
    try {
      entered = await o.exclusion.enter({ operationId, kind: "commit", workspace: w });
    } catch {
      return void registry.apply(operationId, { type: "exclusion-unavailable", code: "GIT_FAILED" });
    }
    if (!entered.ok) return notEntered(registry, operationId, entered);
    const marker = entered;
    const binding = a.approval.binding;
    const kept: RetainedCommit = { repositoryId: w.repositoryId, review: a.review, binding, tip: null };
    const rec = recording(o.runner);
    const ctx: PublishContext = { runner: rec, trust: o.trust, reader: o.reader, operationId, signal, workspace: w, installation };
    let held: HeldLock | null = null;
    // A WSL lock without a `lock` reply. Its ownership is unknown (contract §4 "Stopped or failed `lock`").
    let unknownLock = null as UnknownLock | null;
    const foreign: string[] = [];
    const extra = () => (foreign.length > 0 ? { foreign } : undefined);
    // `release` removes the lock only while the path names the owned file (contract §4). A lock that stays is foreign. Null: no lock was held.
    const release = async () => {
      const lock = held;
      held = null;
      if (lock === null) return null;
      const result = await lock.release().catch(() => "remove-failed" as const);
      if (result === "removed" || result === "notOwned") return result;
      foreign.push(besideIndex(w, lock.path));
      return "remove-failed";
    };
    // Contract §4 "Lock token": the token-only form goes only after the process-end fact. False: the ownership stays unknown, and the lock is foreign.
    const removeUnknown = async () => {
      const lock = unknownLock;
      unknownLock = null;
      if (lock === null) return true;
      const removed = (await processEnd(ctx)) === "fact" ? await lock.removeByToken() : "remove-failed";
      if (removed === "removed" || removed === "notOwned") return true;
      foreign.push(besideIndex(w, lock.path));
      return false;
    };

    // Research R4 steps 2 to 6. Null: the handoff started.
    const steps = async (): Promise<Refusal | Stop | null> => {
      if (signal.aborted) return CANCELED;
      let locked: Extract<LockResult | WslLockResult, { ok: boolean }>;
      if (w.wsl !== undefined) {
        // Contract §4 "Process end": this run starts the anchor of the operation before `lock`. A GIT_FAILED before handoff carries no remedy (contract §9).
        if ((await processEnd(ctx)) === "noFact") return { code: "GIT_FAILED" };
        if (signal.aborted) return CANCELED;
        const result = await wslLock(ctx);
        if ("unknown" in result) unknownLock = result.unknown;
        if (!("ok" in result)) return "stop" in result ? { stop: result.stop } : refusalOf(result);
        locked = result;
      } else locked = await createIndexLock(w.indexPath);
      if (locked.ok) held = locked.lock;
      else {
        if ("code" in locked) {
          const answer = await o.runner.lingeringCount(operationId, w.commonDirectory).catch(() => null);
          const text = `${locked.remedy.text}${lingering(typeof answer === "number" ? answer : null, o.trust.currentTrustId(w) !== undefined)}`;
          return { code: "LOCKED", path: locked.path, remedy: { text } };
        }
        if (locked.reason === "create-failed") return { code: "GIT_FAILED", cause: "lock-create" };
        // Contract §4 "Windows lock ownership": a commit publishes nothing through `index.lock`, so a lock removed by its token lets it continue.
        if (!locked.removed) return { code: "GIT_FAILED", foreign: [besideIndex(w, locked.path)] };
      }

      registry.progress(operationId, "preflight");
      // Contract §4 "WSL index publication": a WSL preflight reads the index bytes only after a changed digest.
      const [policy, state, tip] = await Promise.all([observePolicy(ctx, null, "commit"), observeState(ctx, EMPTY, false, canonicalIndex(ctx, binding.reviewedIndex)), readTip(ctx, binding.head)]);
      const reviewed = policyFingerprint({ attributes: EMPTY, trust: binding.trust, configurationFingerprint: binding.disclosure, git: installation });
      const refused = preflightRefusal(binding, reviewed, policy, state, tip, a.review.wslIndex) ?? (await identityRefusal(ctx));
      if (refused !== null) return refused;
      kept.tip = (tip as { value: ReflogRecord | null }).value;
      if (signal.aborted) return CANCELED;
      // Research R4 step 4: the token is consumed only after validation.
      if (!approvals.consume(key, operationId)) {
        const now = approvals.accept(key);
        return { code: !now.ok && "code" in now ? now.code : "UNKNOWN_TARGET" };
      }
      // Contract §4: the handoff starts at the lock release.
      const released = await release();
      if (released !== null && released !== "removed") return { code: "GIT_FAILED" };
      registry.progress(operationId, "commit-handoff");
      return signal.aborted ? CANCELED : null;
    };

    // Contract §9: a refusal before handoff ends no-effects with its code. A stop ends canceled, or failed with DEADLINE. No Observed-locks check runs.
    const refuse = async (ending: Refusal | Stop) => {
      const canceled = enterReconciling(registry, operationId, isStop(ending) && ending.stop === "deadline", 0);
      const known = await removeUnknown();
      await release();
      const refusal = "code" in ending ? ending : null;
      foreign.push(...(refusal?.foreign ?? []));
      // Contract §4 "Stopped or failed `lock`": unknown ownership needs explicit recovery, so the outcome is unknown and the marker stays.
      if (!known) return void registry.apply(operationId, { type: "reconciliation-read-failed", code: "GIT_FAILED" }, extra(), "GIT_FAILED");
      const cause = diagnosticCause(null, refusal, registry.get(operationId)!.cause);
      if (canceled) registry.apply(operationId, { type: "no-effects", observed: "canceled" }, extra(), cause);
      else {
        const { code, cause: _cause, foreign: _foreign, ...fields }: Partial<Refusal> = refusal ?? {};
        const result = { ...fields, ...extra() };
        const reason = code === "OUTPUT_LIMIT" ? fields.reason : undefined;
        registry.apply(operationId, { type: "no-effects", observed: "failed", ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }, Object.keys(result).length > 0 ? result : undefined, cause);
      }
      // Contract §6: `resolved` follows a known outcome.
      o.runner.resolved(marker.markerId);
      retained.delete(operationId);
    };

    try {
      registry.apply(operationId, { type: "marker-recorded" });
      owners.set(operationId, request.repositoryId);
      retained.set(operationId, kept);
      let ending: Refusal | Stop | null;
      try {
        ending = await steps();
      } catch {
        ending = signal.aborted ? CANCELED : { code: "GIT_FAILED" };
      }
      if (ending !== null) return await refuse(ending);

      // Contract §9 "Commit failure output": only stderr bytes before the exit reply enter the tail.
      const tail = createTailCollector("plain");
      let exit: GitExit | null = null;
      try {
        exit = await rec.run({
          operationId,
          context: contextOf(w),
          arguments: commitArgs(),
          input: new TextEncoder().encode(request.payload.message),
          environmentPolicy: "mutation",
          limits: PROCESS_LIMITS.commit,
          stdout: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
          stderr: tail,
          signal,
        });
      } catch {
        // A refusal after the start request leaves open whether Git ran.
      }
      const trustId = () => o.trust.currentTrustId(w) !== undefined;
      // Contract §9: only a GIT_FAILED carries the hook command. "Other locks" follows an observed lock.
      const remedy = (count: number | null, otherLocks: boolean, gitFailed: boolean) => {
        if (gitFailed && w.wsl !== undefined) return wslCommitRemedy({ worktreeRoot: w.worktreeRoot, wsl: w.wsl }, count, trustId(), otherLocks);
        if (gitFailed) return installation.selectedPath === null ? null : commitRemedy(installation.selectedPath, w.worktreeRoot, count, trustId(), otherLocks);
        return otherLocks ? { text: `${OTHER_LOCKS_TEXT}${lingering(count, trustId())}` } : null;
      };
      await reconcileCommit({ registry, runner: o.runner, retained, operationId, markerId: marker.markerId, ctx, review: a.review, binding, tip: kept.tip, exit, outputTail: tail.outputTail(), foreign, remedy });
    } catch {
      // A broken step leaves the outcome unknown. The marker stays (contract §8).
      await release();
      if (unknownLock !== null) foreign.push(besideIndex(w, unknownLock.path));
      const state = registry.get(operationId)?.state;
      if (state === "running") registry.apply(operationId, { type: "execution-ended", lingeringDescendants: 0 });
      if (state === "cancel-requested") registry.apply(operationId, { type: "processes-stopped" });
      if (registry.get(operationId)?.state === "reconciling") registry.apply(operationId, { type: "reconciliation-read-failed", code: "GIT_FAILED" }, extra(), "GIT_FAILED");
    } finally {
      // The registry sent `ended` with the terminal response, so this only frees the exclusion slot.
      marker.end(false);
    }
  }

  function commit(request: CommitRequest, w: Workspace, installation: ReadInstallation): void {
    const key: ApprovalKey = { kind: "commit", reviewToken: request.payload.reviewToken };
    // Contract §2: a review token that an accepted operation consumed answers a repeat with that operation, without an accepted event or a process.
    const peek = approvals.accept(key);
    if (!peek.ok && "consumed" in peek && owners.get(peek.consumed) === request.repositoryId) {
      return void o.respond({ requestId: request.requestId, operationId: peek.consumed, state: "succeeded", result: registry.get(peek.consumed) });
    }
    const { operationId, signal } = registry.start("commit", request.requestId);
    // Contract §7 "Mutation trust": the reviewed listing decides before any process starts. A bound review never has an input-limited listing.
    const gate = (b: CommitBinding) => o.trust.gate(w, { approvalRequired: { reads: false, commit: b.approvalRequired }, fingerprint: b.disclosure, inputLimited: false }, installation, "commit");
    const admitted = admitCommit(request, w, approvals.accept(key), o.reviews.retained, gate);
    if ("code" in admitted) return void registry.apply(operationId, { type: "invalid-approval", code: admitted.code });
    void execute(request, w, installation, operationId, signal, key, admitted);
  }

  return { commit, retained, owners };
}

export type Committer = ReturnType<typeof createCommitter>;
