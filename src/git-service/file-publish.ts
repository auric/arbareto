// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T200: `applyFile`, contract §4 "File staging" steps 1 to 9 and "Blob proof", §2, §5, §8, and §9.
// Only `publish()` of the owned index lock writes the canonical index.
// T214: a WSL repository takes the working digests and both blob proofs inside the distro (contract §6 "WSL file work").
// Feature 003 T048: the direction `resolve` (Mark resolved, contract Δ4).

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceRequest } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import type { FileActionDecision, ResolveDecision, UnstagePath } from "../contracts/file-action";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import type { ApprovalKey, FileApproval, FileBinding } from "./approvals";
import { blobFilterProofArgs, blobHashProofArgs, isObjectId, objectCheckArgs, updateIndexAddArgs, updateIndexInfoArgs } from "./commands";
import { wholeFileRemedy, type RetainedComparison, type WholeFileRemedy } from "./comparison";
import { createTailCollector } from "./discovery";
import type { ObjectFormat, RawIndexEntry } from "./eligibility";
import { createCollector, type Collector } from "./git-runner";
import { ownedCandidate } from "./hunk-candidate";
import {
  besideIndex,
  candidateRefusal,
  canonicalIndex,
  checkpointRefusal,
  comparisonBinding,
  differs,
  isStop,
  missingObject,
  observePolicy,
  observeState,
  refusalOf,
  settled,
  SHARED_REPOSITORY,
  startPublication,
  stepOf,
  wholeWorking,
  type Fact,
  type HunkPublisherOptions,
  type PublicationSession,
  type PublicationStores,
  type PublishContext,
  type Refusal,
  type Stop,
} from "./hunk-publish";
import { latin1, objectCheckInput, objectCheckOutcome } from "./read-steps";
import type { Workspace } from "./registration";
import type { ChangeSnapshot, ReadInstallation } from "./snapshot";
import { hashWriteArgs } from "./sync-commands";
import { wslProofA, wslProofB } from "./wsl-files";

// Contract §4 "Blob proof": the `remedy.text` of reason `blob-proof`.
export const BLOB_PROOF_TEXT = "Arbareto cannot prove the staged content of this file. The file can have changed during staging, or Git's conversion can depend on the index. Use the command in a terminal.";

const STALE: Refusal = { code: "STALE_SELECTION" };
const CANCELED: Stop = { stop: "canceled" };
const NUL = Uint8Array.of(0);
// The flags of an entry that `update-index` writes.
const CLEAN = { stage: 0, assumeUnchanged: false, skipWorktree: false, intentToAdd: false };
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type FileAction = Extract<FileActionDecision, { direction: "stage" | "unstage" }> | Extract<ResolveDecision, { direction: "resolve" }>;
type WholeFile = NonNullable<FileBinding["working"]>;

// Data-model §6 "File approval". Null for a refused entry or an incomplete snapshot. The caller issues it only for a succeeded comparison.
export function fileApproval(c: RetainedComparison, s: ChangeSnapshot, w: Workspace): FileApproval | null {
  const direction = c.fileAction.direction;
  const binding = comparisonBinding(c, s, w);
  if (direction === null || binding === null) return null;
  const { repositoryId, snapshotId, generation, comparisonId } = c;
  // Contract §4 "Binding": `unstage` reads no working file, so it binds no working values.
  return { kind: "file", repositoryId, snapshotId, generation, comparisonId, entryId: c.entry.entryId, direction, binding: { ...binding, working: direction === "unstage" ? null : c.working } };
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
    const st = await handle.stat();
    if (!st.isFile() || st.size !== bound.size) return null;
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
async function blobProof(ctx: PublishContext, path: Uint8Array, oid: string, bound: WholeFile, remedy: WholeFileRemedy | null): Promise<Refusal | Stop | null> {
  const text = utf8.decode(path);
  const w = ctx.workspace;
  if (w.wsl !== undefined) {
    // Contract §6 "WSL file work": both proofs run inside the distro, so no working-file or blob byte crosses.
    for (const proof of [wslProofA, wslProofB]) {
      const held = await proof(ctx, text.split("/"), oid, bound);
      if (!("value" in held)) return refusalOrStop(held);
      if (held.value) return null;
    }
  } else {
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
  }
  const again = differs(bound, await settled(ctx.signal, wholeWorking(ctx, path)));
  if (!("value" in again)) return refusalOrStop(again);
  if (again.value) return STALE;
  // Contract §4 "Limitation remedies": a refused value keeps its own text and offers no command.
  return { code: "UNSUPPORTED_COMPARISON", reason: "blob-proof", ...(remedy === null ? {} : { remedy: remedy.command === null ? remedy : { text: BLOB_PROOF_TEXT, command: remedy.command } }) };
}

// Contract §5 and §8: the stores of the hunk publisher, so that recovery (T114) reads one store.
export type FilePublisherOptions = HunkPublisherOptions & PublicationStores;

type ApplyFileRequest = Extract<ServiceRequest, { operation: "applyFile" }>;
type Admitted = { approval: FileApproval; comparison: RetainedComparison; action: FileAction };

export function createFilePublisher(o: FilePublisherOptions) {
  const { registry } = o;

  // Contract §2, §9: the `applyHunk` acceptance order after the accepted event. Memory only, so no Git process starts.
  function admit(request: ApplyFileRequest, w: Workspace, key: ApprovalKey): Admitted | { code: ErrorCode; result?: unknown } {
    const { comparisonId, snapshotId, direction } = request.payload;
    if (request.repositoryGeneration !== w.generation) return { code: "REPOSITORY_CHANGED" };
    const c = o.comparisons.get(comparisonId);
    if (c === undefined || c.repositoryId !== request.repositoryId || c.snapshotId !== snapshotId) return { code: "UNKNOWN_TARGET" };
    // A refused entry has no approval, so the refusal decides before `accept`. It carries the contract §4 "Limitation remedies" remedy of the entry.
    const action = c.fileAction;
    if (action.direction === null) return action.code === "UNSUPPORTED_COMPARISON" ? { code: action.code, result: { reason: action.reason, ...(c.remedy === null ? {} : { remedy: c.remedy }) } } : { code: action.code };
    if (direction !== action.direction) return { code: "INVALID_REQUEST" };
    if (c.sharedRepository) return SHARED_REPOSITORY;
    const accepted = o.approvals.accept(key);
    if (!accepted.ok) return { code: "code" in accepted ? accepted.code : "UNKNOWN_TARGET" };
    const approval = accepted.approval;
    if (approval.kind !== "file" || approval.generation !== w.generation) return { code: "UNKNOWN_TARGET" };
    // Data-model §7: an unfinished operation refuses at acceptance. `unknown` decides at the checkpoints.
    // Contract Δ4: `resolve` checks the bound state for equality at the checkpoints instead.
    const state = approval.binding.operationState;
    if (action.direction !== "resolve" && state === "conflicted") return { code: "CONFLICTED" };
    if (action.direction !== "resolve" && state !== "normal" && state !== "unknown") return { code: "OPERATION_IN_PROGRESS" };
    return { approval, comparison: c, action };
  }

  // Contract §4 steps 3 to 7 under the lock.
  async function prepare({ approval: { binding }, comparison: c, action }: Admitted, { ctx, rec, run, path }: PublicationSession): Promise<Refusal | Stop | null> {
    const { workspace: w, signal, operationId, installation } = ctx;
    const stage = action.direction === "stage";
    const resolve = action.direction === "resolve";
    // Contract §4 "Limitation remedies": the `add` remedy of the entry.
    const addRemedy = () => wholeFileRemedy({ entry: c.entry, workspace: w, installation, headUnborn: binding.head.state === "unborn" }, path);
    // FR-053: Mark resolved also binds the working version of the comparison: existence, type, mode, size, and raw digest. A WSL read folds no working version.
    const version = resolve ? c.workingVersion : null;

    // Contract §4 steps 3 and 7 with the §9 checkpoint order. For `stage` and `resolve`, the whole working file decides last.
    const checkpoint = async (): Promise<Refusal | Stop | null> => {
      const policy = await observePolicy(ctx, path);
      if ("listing" in policy) run.listing = policy.listing;
      const refused = checkpointRefusal({ ...binding, working: version }, policy, await observeState(ctx, path, version !== null, canonicalIndex(ctx, binding.index, resolve)), w.objectFormat, w.wsl !== undefined, resolve);
      if (refused !== null || action.direction === "unstage") return refused;
      const read = differs(binding.working, await settled(signal, wholeWorking(ctx, path)));
      if (!("value" in read)) return refusalOrStop(read);
      return read.value ? STALE : null;
    };

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
      let input: Uint8Array;
      let hashed: string | null = null;
      if (action.direction === "resolve") {
        // Contract Δ4 step 5: the blob of the working file, then `<mW> SP <oid> TAB <path>`. `update-index --add` would lose the link and exec modes on Windows (research R16 i).
        const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
        await owned.step("hash", hashWriteArgs(utf8.decode(path)), out, new Uint8Array(), false, tail);
        const line = latin1(out.take());
        const oid = line.slice(0, -1);
        if (out.limited || !line.endsWith("\n") || !isObjectId(oid, w.objectFormat)) return owned.fail({ reason: "malformed", step: "hash" });
        hashed = oid;
        input = indexInfoInput(action.changedPaths.map((p) => ({ path: p.path, mode: p.mode, objectId: oid })));
      } else input = stage ? Buffer.concat([path, NUL]) : indexInfoInput(action.changedPaths);
      await owned.step("update-index", stage ? updateIndexAddArgs() : updateIndexInfoArgs(), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }), input, true, tail);
      // T197 races write the working file at this observer point, after the Git step and before the proofs.
      await o.hunkCheckpoint?.({ step: 5, operationId });
      if (signal.aborted) return owned.fail({ reason: "canceled" });
      const read = await owned.readCandidate();
      // Contract Δ4 step 6: one stage-0 entry in mode `mW` and no stage 1 to 3 for the path.
      const mode = action.direction === "resolve" ? action.changedPaths[0]!.mode.toString(8).padStart(6, "0") : c.entry.category === "untracked" ? null : c.entry.modes![2]!;
      const entries = owned.parse(read.bytes);
      const checked = changedEntries({ action, mode, deletion: stage && binding.working === null, objectFormat: w.objectFormat }, entries, canonical);
      if ("detail" in checked) return owned.fail({ reason: "verification", detail: checked.detail });
      if (resolve && checked.staged !== hashed) return owned.fail({ reason: "verification", detail: "selected-entry" });
      // wt-status.c `wt_status_get_state`: without a marker, the state is `conflicted` only while a stage above 0 remains.
      if (resolve && binding.operationState === "conflicted" && !entries.some((e) => e.stage > 0)) run.expectedState = "normal";
      staged = checked.staged;
      if (staged !== null) {
        const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
        await owned.step("check", objectCheckArgs(), out, objectCheckInput([staged]), false);
        // `step` throws for every exit other than 0.
        if (objectCheckOutcome({ exit: { exitCode: 0, activeDescendants: 0 } }, out, [staged]) !== "present") return owned.fail({ reason: "verification", detail: "selected-entry" });
      }
      return read;
    });
    run.executionLast = rec.execution ?? 0;
    if (!prepared.ok) {
      run.candidatePath = prepared.path === null ? null : besideIndex(w, prepared.path);
      const refused = candidateRefusal(prepared.failure);
      if (!("check" in refused)) return refused;
      // Contract §7 "Missing objects": the index object of `stage`, or the HEAD object IDs that `unstage` names. `resolve` stages a new blob.
      const oid = action.direction === "unstage" ? action.changedPaths.find((r) => r.mode !== 0)?.objectId : stage ? c.entry.oids?.[1] : undefined;
      const checked = await missingObject(ctx, run.listing, oid, refused.check);
      const f = prepared.failure;
      // Contract §9: a failed `stage` or `resolve` Git step carries the `add` remedy and the output tail of its process.
      if (action.direction !== "unstage" && f.reason === "git-failed" && (f.step === "update-index" || f.step === "hash") && !isStop(checked) && checked.code === "GIT_FAILED") {
        return { code: "GIT_FAILED", remedy: addRemedy() ?? checked.remedy!, outputTail: tail.outputTail() };
      }
      return checked;
    }
    const candidate = prepared.candidate;
    run.candidate = candidate;
    run.candidatePath = besideIndex(w, candidate.path);
    if (staged !== null && binding.working !== null) {
      const proof = await blobProof(ctx, path, staged, binding.working, addRemedy());
      run.executionLast = rec.execution ?? 0;
      if (proof !== null) return proof;
    }
    // Contract §4 step 7.
    const second = await checkpoint();
    if (second !== null) return second;
    await o.hunkCheckpoint?.({ step: 11, operationId });
    return signal.aborted ? CANCELED : null;
  }

  // Contract §4 "Blob proof": after publication, a new digest of the working file decides the working-file effect. `unstage` reads no working file.
  async function working({ approval: { binding }, action }: Admitted, ctx: PublishContext, path: Uint8Array): Promise<Fact<boolean>> {
    return action.direction === "unstage" ? { value: false } : differs(binding.working, await wholeWorking(ctx, path));
  }

  function applyFile(request: ApplyFileRequest, w: Workspace, installation: ReadInstallation): void {
    const { comparisonId, direction } = request.payload;
    const key: ApprovalKey = { kind: "file", comparisonId, direction };
    startPublication(o, request, w, installation, key, { admit: () => admit(request, w, key), prepare, working });
  }

  return { applyFile };
}
