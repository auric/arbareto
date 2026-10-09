// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T200: `applyFile`, contract §4 "File staging" steps 1 to 9 and "Blob proof", §2, §5, §8, and §9. The Windows path.
// Only `publish()` of the owned index lock writes the canonical index. A WSL comparison gets no file approval (T214 adds the WSL path).

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceRequest } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import type { FileActionDecision, UnstagePath } from "../contracts/file-action";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import type { ApprovalKey, FileApproval, FileBinding } from "./approvals";
import { blobFilterProofArgs, blobHashProofArgs, isObjectId, objectCheckArgs, updateIndexAddArgs, updateIndexInfoArgs } from "./commands";
import { wholeFileRemedy, type RetainedComparison, type WholeFileRemedy } from "./comparison";
import { createTailCollector } from "./discovery";
import type { ObjectFormat, RawIndexEntry } from "./eligibility";
import type { Entered, NotEntered } from "./exclusion";
import { createCollector, type Collector } from "./git-runner";
import { ownedCandidate } from "./hunk-candidate";
import {
  besideIndex,
  candidateRefusal,
  checkpointRefusal,
  comparisonBinding,
  isStop,
  lockRefusal,
  missingObject,
  notEntered,
  observePolicy,
  observeState,
  publishRefusal,
  reconcilePublication,
  recording,
  refusalOf,
  removeOwned,
  settled,
  stepOf,
  workingOf,
  type Ending,
  type Fact,
  type HunkPublisherOptions,
  type ObserveContext,
  type PublicationRun,
  type Refusal,
  type RetainedPublication,
  type Stop,
} from "./hunk-publish";
import { createIndexLock } from "./index-lock";
import { latin1, objectCheckInput, objectCheckOutcome } from "./read-steps";
import type { Workspace } from "./registration";
import type { ChangeSnapshot, ReadInstallation, WorkingVersion } from "./snapshot";

// Contract §4 "Blob proof": the `remedy.text` of reason `blob-proof`.
export const BLOB_PROOF_TEXT = "Arbareto cannot prove the staged content of this file. The file can have changed during staging, or Git's conversion can depend on the index. Use the command in a terminal.";

const STALE: Refusal = { code: "STALE_SELECTION" };
const CANCELED: Stop = { stop: "canceled" };
const WHOLE = "WHOLE_FILE_STAGE_INPUT_BYTES";
const NUL = Uint8Array.of(0);
// The flags of an entry that `update-index` writes.
const CLEAN = { stage: 0, assumeUnchanged: false, skipWorktree: false, intentToAdd: false };
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type FileAction = Extract<FileActionDecision, { direction: "stage" | "unstage" }>;
type WholeFile = NonNullable<FileBinding["working"]>;

// The direction that the comparison scope allows (contract §9).
const directionOf = (c: Pick<RetainedComparison, "scope">) => (c.scope === "head-to-index" ? "unstage" : "stage");

// Data-model §6 "File approval". Null for a refused entry or an incomplete snapshot. The caller issues it only for a succeeded comparison.
export function fileApproval(c: RetainedComparison, s: ChangeSnapshot, w: Workspace): FileApproval | null {
  const direction = c.fileAction.direction;
  const binding = comparisonBinding(c, s, w);
  if (direction === null || binding === null) return null;
  const { repositoryId, snapshotId, generation, comparisonId } = c;
  // Contract §4 "Binding": `unstage` reads no working file, so it binds no working values.
  return { kind: "file", repositoryId, snapshotId, generation, comparisonId, entryId: c.entry.entryId, direction, binding: { ...binding, working: direction === "stage" ? c.working : null } };
}

// git-update-index(1) `--index-info` with `-z`: `<mode> SP <object ID> TAB <path>` and NUL for each path. Mode 0 removes the path.
export function indexInfoInput(rows: readonly UnstagePath[]): Uint8Array {
  return Buffer.concat(rows.flatMap((r) => [Buffer.from(`${r.mode.toString(8)} ${r.objectId}\t`), r.path, NUL]));
}

export interface ExpectedChange {
  action: FileAction;
  // `stage`: the working mode that status reported. Null for an untracked entry.
  mode: string | null;
  // `stage`: the approval binds an absent working file.
  deletion: boolean;
  objectFormat: ObjectFormat;
}

// Contract §4 step 6: only the changed paths differ. Gives the staged object ID, or null when no blob was staged.
// `update-index --index-info` skips an invalid path with exit 0 (research R3), so only these entry compares decide.
export function changedEntries(t: ExpectedChange, candidate: readonly RawIndexEntry[], canonical: readonly RawIndexEntry[]): { staged: string | null } | { detail: "selected-entry" | "unrelated-entries" } {
  const paths = t.action.changedPaths.map((p: { path: Uint8Array }) => p.path);
  const changed = (e: RawIndexEntry) => paths.some((p) => Buffer.compare(p, e.path) === 0);
  if (!Bun.deepEquals(candidate.filter((e) => !changed(e)), canonical.filter((e) => !changed(e)), true)) return { detail: "unrelated-entries" };
  const at = (path: Uint8Array) => candidate.filter((e) => Buffer.compare(e.path, path) === 0).map(({ path: _path, ...rest }) => rest);
  const selected = { detail: "selected-entry" as const };
  if (t.action.direction === "unstage") {
    const each = t.action.changedPaths.every((r) => Bun.deepEquals(at(r.path), r.mode === 0 ? [] : [{ mode: r.mode.toString(8).padStart(6, "0"), oid: r.objectId, ...CLEAN }], true));
    return each ? { staged: null } : selected;
  }
  const found = at(t.action.changedPaths[0]!.path);
  if (t.deletion) return found.length === 0 ? { staged: null } : selected;
  // Contract §4 step 6: an untracked entry gets a regular-file mode.
  const modes = t.mode === null ? ["100644", "100755"] : [t.mode];
  const [e] = found;
  if (found.length !== 1 || !modes.includes(e!.mode) || !isObjectId(e!.oid, t.objectFormat) || !Bun.deepEquals({ ...e, mode: "", oid: "" }, { mode: "", oid: "", ...CLEAN }, true)) return selected;
  return { staged: e!.oid };
}

// Proof A output: the SHA-256 of the first `size` bytes. Above `size`, `limited` makes the runner cancel the process (contract §6 "Byte caps").
export function digestSink(size: number): Collector & { digest(): string } {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  return {
    push(chunk: Uint8Array): void {
      if (bytes < size) hasher.update(chunk.subarray(0, size - bytes));
      bytes += chunk.length;
    },
    get bytes() {
      return bytes;
    },
    records: 0,
    get limited() {
      return bytes > size;
    },
    digest: () => hasher.digest("hex"),
  };
}

// True: the whole working file differs from the binding. A null binding means an absent file (a tracked deletion).
function differs(bound: FileBinding["working"], read: Fact<WorkingVersion> | { changed: true }): Fact<boolean> {
  if ("changed" in read) return { value: true };
  if (!("value" in read)) return read;
  const v = read.value;
  const same = bound === null ? !v.exists : v.exists && v.type === "file" && v.size === bound.size && v.rawDigest === bound.sha256;
  return { value: !same };
}

const refusalOrStop = (f: Exclude<Fact<unknown>, { value: unknown }>): Refusal | Stop => (isStop(f) ? f : refusalOf(f));

// The verified bytes of the working file: exactly `bound.size` bytes with `bound.sha256`. Null for any other file state.
// ponytail: proof B holds the whole file, up to WHOLE_FILE_STAGE_INPUT_BYTES, in one buffer. Upgrade path: a streamed `GitCall.input` source.
async function verifiedBytes(file: string, bound: WholeFile): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.allocUnsafe(bound.size + 1);
    const hasher = new Bun.CryptoHasher("sha256");
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(size, size + bytesRead));
      size += bytesRead;
    }
    return size === bound.size && hasher.digest("hex") === bound.sha256 ? buffer.subarray(0, size) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

// Contract §4 "Blob proof": proof A, then proof B only after proof A fails. Without a proof, a new digest decides. Null: a proof held.
async function blobProof(ctx: ObserveContext, path: Uint8Array, oid: string, bound: WholeFile, remedy: WholeFileRemedy | null): Promise<Refusal | Stop | null> {
  const text = utf8.decode(path);
  const w = ctx.workspace;
  const sink = digestSink(bound.size);
  const a = await stepOf(ctx, blobFilterProofArgs(text, oid, w.objectFormat), sink);
  if (!("exit" in a)) return refusalOrStop(a);
  if (a.exit.exitCode === 0 && !sink.limited && sink.bytes === bound.size && sink.digest() === bound.sha256) return null;
  const bytes = await verifiedBytes(join(w.worktreeRoot, ...text.split("/")), bound);
  if (bytes !== null) {
    const out = createCollector({ maxBytes: 128 });
    const b = await stepOf(ctx, blobHashProofArgs(text), out, bytes);
    if (!("exit" in b)) return refusalOrStop(b);
    if (b.exit.exitCode === 0 && !out.limited && latin1(out.take()) === `${oid}\n`) return null;
  }
  const again = differs(bound, await settled(ctx.signal, workingOf(w, path, WHOLE)));
  if (!("value" in again)) return refusalOrStop(again);
  if (again.value) return STALE;
  // Contract §4 "Limitation remedies": a refused value keeps its own text and offers no command.
  return { code: "UNSUPPORTED_COMPARISON", reason: "blob-proof", ...(remedy === null ? {} : { remedy: remedy.command === null ? remedy : { text: BLOB_PROOF_TEXT, command: remedy.command } }) };
}

export interface FilePublisherOptions extends HunkPublisherOptions {
  // Contract §5 and §8: the store of the hunk publisher, so that recovery (T114) reads one store.
  retained: Map<string, RetainedPublication>;
  // Contract §2: the workspace of each operation that consumed an approval. The store of the hunk publisher.
  owners: Map<string, string>;
}

type ApplyFileRequest = Extract<ServiceRequest, { operation: "applyFile" }>;
type Admitted = { approval: FileApproval; comparison: RetainedComparison; action: FileAction };

export function createFilePublisher(o: FilePublisherOptions) {
  const { registry, retained, owners } = o;

  // Contract §2, §9: the `applyHunk` acceptance order after the accepted event. Memory only, so no Git process starts.
  function admit(request: ApplyFileRequest, w: Workspace, key: ApprovalKey): Admitted | { code: ErrorCode; result?: unknown } {
    const { comparisonId, snapshotId, direction } = request.payload;
    if (request.repositoryGeneration !== w.generation) return { code: "REPOSITORY_CHANGED" };
    const c = o.comparisons.get(comparisonId);
    if (c === undefined || c.repositoryId !== request.repositoryId || c.snapshotId !== snapshotId) return { code: "UNKNOWN_TARGET" };
    // A refused entry has no approval, so the refusal decides before `accept`.
    const action = c.fileAction;
    if (action.direction === null) return action.code === "UNSUPPORTED_COMPARISON" ? { code: action.code, result: { reason: action.reason } } : { code: action.code };
    if (direction !== directionOf(c)) return { code: "INVALID_REQUEST" };
    const accepted = o.approvals.accept(key);
    if (!accepted.ok) return { code: "code" in accepted ? accepted.code : "UNKNOWN_TARGET" };
    const approval = accepted.approval;
    if (approval.kind !== "file" || approval.generation !== w.generation) return { code: "UNKNOWN_TARGET" };
    // Data-model §7: an unfinished operation refuses at acceptance. `unknown` decides at the checkpoints.
    const state = approval.binding.operationState;
    if (state === "conflicted") return { code: "CONFLICTED" };
    if (state !== "normal" && state !== "unknown") return { code: "OPERATION_IN_PROGRESS" };
    return { approval, comparison: c, action };
  }

  async function publish(request: ApplyFileRequest, w: Workspace, installation: ReadInstallation, operationId: string, signal: AbortSignal, admitted: Admitted, key: ApprovalKey): Promise<void> {
    const { approval, comparison: c, action } = admitted;
    const binding = approval.binding;
    const stage = action.direction === "stage";
    const path = new Uint8Array(Buffer.from(binding.entry.pathBytes, "base64"));
    let entered: Entered | NotEntered;
    try {
      entered = await o.exclusion.enter({ operationId, kind: "applyFile", workspace: w });
    } catch {
      return void registry.apply(operationId, { type: "exclusion-unavailable", code: "GIT_FAILED" });
    }
    if (!entered.ok) return notEntered(registry, operationId, entered);
    const marker = entered;
    const rec = recording(o.runner);
    const ctx: ObserveContext = { runner: rec, trust: o.trust, reader: o.reader, operationId, signal, workspace: w, installation };
    const run: PublicationRun = { lock: null, candidate: null, candidatePath: null, publishing: false, published: false, executionLast: 0, listing: null };
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
    // Contract §4 "Limitation remedies": the `add` remedy of the entry.
    const addRemedy = () => wholeFileRemedy({ entry: c.entry, workspace: w, installation, headUnborn: binding.head.state === "unborn" }, path);
    try {
      registry.apply(operationId, { type: "marker-recorded" });
      owners.set(operationId, request.repositoryId);

      // Contract §4 steps 3 and 7 with the §9 checkpoint order. For `stage`, the whole working file decides last.
      const checkpoint = async (): Promise<Refusal | Stop | null> => {
        const policy = await observePolicy(ctx, path);
        if ("listing" in policy) run.listing = policy.listing;
        const refused = checkpointRefusal({ ...binding, working: null }, policy, await observeState(ctx, path, false), w.objectFormat);
        if (refused !== null || !stage) return refused;
        const read = differs(binding.working, await settled(signal, workingOf(w, path, WHOLE)));
        if (!("value" in read)) return refusalOrStop(read);
        return read.value ? STALE : null;
      };

      const steps = async (): Promise<Ending> => {
        if (!o.approvals.consume(key, operationId)) {
          const now = o.approvals.accept(key);
          return { code: !now.ok && "code" in now ? now.code : "UNKNOWN_TARGET" };
        }
        // Contract §4 step 2.
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
        // Contract §4 step 3 under the lock. No observer runs here.
        registry.progress(operationId, "preflight");
        const first = await checkpoint();
        if (first !== null) return first;
        // Contract §4 steps 4 to 6.
        registry.progress(operationId, "candidate-verification");
        const owned = ownedCandidate({ runner: rec, operationId, signal, workspace: w, rawIndexDigest: binding.index.rawIndexDigest });
        const tail = createTailCollector("plain");
        let staged = null as string | null;
        const prepared = await owned.settle(async () => {
          const canonical = (await owned.copy()) ?? owned.parse((await owned.readCandidate()).bytes);
          const input = action.direction === "stage" ? Buffer.concat([path, NUL]) : indexInfoInput(action.changedPaths);
          await owned.step("update-index", stage ? updateIndexAddArgs() : updateIndexInfoArgs(), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }), input, true, tail);
          // T197 races write the working file at this observer point, after the Git step and before the proofs.
          await o.hunkCheckpoint?.({ step: 5, operationId });
          if (signal.aborted) return owned.fail({ reason: "canceled" });
          const read = await owned.readCandidate();
          const expected = { action, mode: c.entry.category === "untracked" ? null : c.entry.modes![2]!, deletion: stage && binding.working === null, objectFormat: w.objectFormat };
          const checked = changedEntries(expected, owned.parse(read.bytes), canonical);
          if ("detail" in checked) return owned.fail({ reason: "verification", detail: checked.detail });
          staged = checked.staged;
          if (staged !== null) {
            const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
            await owned.step("check", objectCheckArgs(), out, objectCheckInput([staged]), false);
            // `step` throws for every exit other than 0.
            if (objectCheckOutcome({ exit: { exitCode: 0, activeDescendants: 0 } }, out, [staged]) !== "present") return owned.fail({ reason: "verification", detail: "selected-entry" });
          }
          return read;
        });
        run.executionLast = rec.last ?? 0;
        if (!prepared.ok) {
          run.candidatePath = prepared.path === null ? null : besideIndex(w, prepared.path);
          const refused = candidateRefusal(prepared.failure);
          if (!("check" in refused)) return refused;
          // Contract §7 "Missing objects": the index object of `stage`, or the HEAD object IDs that `unstage` names.
          const oid = action.direction === "unstage" ? action.changedPaths.find((r) => r.mode !== 0)?.objectId : c.entry.oids?.[1];
          const checked = await missingObject(ctx, run.listing, oid, refused.check);
          const f = prepared.failure;
          // Contract §9: a failed `stage` Git step carries the `add` remedy and the output tail of its `update-index` process.
          if (stage && f.reason === "git-failed" && f.step === "update-index" && !isStop(checked) && checked.code === "GIT_FAILED") {
            return { code: "GIT_FAILED", remedy: addRemedy() ?? checked.remedy!, outputTail: tail.outputTail() };
          }
          return checked;
        }
        const candidate = prepared.candidate;
        run.candidate = candidate;
        run.candidatePath = besideIndex(w, candidate.path);
        if (staged !== null && binding.working !== null) {
          const proof = await blobProof(ctx, path, staged, binding.working, addRemedy());
          run.executionLast = rec.last ?? 0;
          if (proof !== null) return proof;
        }
        // Contract §4 step 7.
        const second = await checkpoint();
        if (second !== null) return second;
        await o.hunkCheckpoint?.({ step: 11, operationId });
        if (signal.aborted) return CANCELED;
        // Contract §4 step 8. Contract §5: the digests stay until reconciliation succeeds.
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
      let unexpected = false;
      try {
        ending = await steps();
      } catch {
        unexpected = !signal.aborted;
        ending = signal.aborted ? CANCELED : refusalOf({ code: "GIT_FAILED" });
      }

      // Contract §4 step 9.
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
        // Contract §4 "Blob proof": after publication, a new digest of the working file decides the working-file effect. `unstage` reads no working file.
        working: async (q) => (stage ? differs(binding.working, await workingOf(q.workspace, path, WHOLE)) : { value: false }),
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

  function applyFile(request: ApplyFileRequest, w: Workspace, installation: ReadInstallation): void {
    const { comparisonId, direction } = request.payload;
    const key: ApprovalKey = { kind: "file", comparisonId, direction };
    // Contract §2: an approval that an accepted operation consumed answers a repeat with that operation, without an accepted event or a process.
    const peek = o.approvals.accept(key);
    if (!peek.ok && "consumed" in peek && owners.get(peek.consumed) === request.repositoryId) {
      return void o.respond({ requestId: request.requestId, operationId: peek.consumed, state: "succeeded", result: registry.get(peek.consumed) });
    }
    const { operationId, signal } = registry.start("applyFile", request.requestId);
    const admitted = admit(request, w, key);
    if ("code" in admitted) return void registry.apply(operationId, { type: "invalid-approval", code: admitted.code }, admitted.result);
    void publish(request, w, installation, operationId, signal, admitted, key);
  }

  return { applyFile };
}
