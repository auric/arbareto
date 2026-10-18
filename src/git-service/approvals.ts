// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T108: data-model §6 "Mutation approvals", contract §2 repeat rule, §4 binding list, §5 "Approval lifetime", §8 "Token invalidation", and §9.
// One store per service session, so a service restart invalidates every approval.

import type { ChangeEntry } from "../contracts/envelope";
import { APPROVAL_LIFETIME_MS } from "../contracts/limits";
import type { PhysicalIdentity } from "./identity";
import type { Head, IndexFingerprint, OperationState, TrustApproval, WorkingVersion } from "./snapshot";
import type { SyncBinding } from "./sync-review";

export type Direction = "stage" | "unstage";
// Feature 003 contract Δ3 `applyFile`: only a file action takes `resolve`.
export type FileDirection = Direction | "resolve";

// Contract §4: the values that a comparison binds, in the order of its list.
export interface ComparisonBinding {
  gitInstallationId: string;
  worktreeIdentity: [PhysicalIdentity, PhysicalIdentity];
  commonIdentity: PhysicalIdentity;
  head: Head;
  // The complete index state with its shared-index dependency.
  index: IndexFingerprint;
  // The selected entry. `stage` is null for an entry that the index does not hold.
  entry: Pick<ChangeEntry, "pathBytes" | "category" | "modes" | "oids"> & { stage: 0 | 1 | 2 | 3 | null };
  // Raw working bytes, existence, type, and normalized content. Null when the comparison reads no working file.
  working: WorkingVersion | null;
  // The `check-attr` values of the selected path.
  attributes: Readonly<Record<string, string>>;
  // Data-model §4: effective configuration, trust approval, and Git installation identity.
  policyFingerprint: string;
  operationState: OperationState;
}

// Contract §4 list, last item: the canonical service diff and the selected hunk identity.
export interface HunkBinding extends ComparisonBinding {
  patchDigest: string;
  hunkDigest: string;
}

// Contract §4 "Binding": the list without the canonical diff and the hunk. `working` holds the whole-file values only for `stage`.
export interface FileBinding extends Omit<ComparisonBinding, "working"> {
  working: { size: number; sha256: string } | null;
}

// Data-model §6 "Commit review".
export interface CommitBinding {
  stagedScope: string;
  reviewedIndex: IndexFingerprint;
  head: Head;
  disclosure: string;
  trust: TrustApproval;
  operationState: OperationState;
  // Contract §7: the commit gate of the reviewed listing.
  approvalRequired: boolean;
  // Feature 004 contract Δ3: an amend review binds the parents of the HEAD commit and `rewritesUpstream`.
  amend?: { parents: string[]; rewritesUpstream: boolean | "unknown" };
}

// Data-model §6 "Submodule review": `review` digests the review reads, the plan, and the refusals. `programs` digests the submodule program list.
export interface SubmoduleBinding {
  review: string;
  programs: string;
  trust: TrustApproval;
}

interface Issued {
  repositoryId: string;
  snapshotId: string;
  generation: number;
}
export type HunkApproval = Issued & { kind: "hunk"; comparisonId: string; hunkId: string; direction: Direction; binding: HunkBinding };
export type FileApproval = Issued & { kind: "file"; comparisonId: string; entryId: string; direction: FileDirection; binding: FileBinding };
export type CommitReview = Issued & { kind: "commit"; reviewToken: string; binding: CommitBinding };
export type SubmoduleReview = Issued & { kind: "submodule"; reviewToken: string; binding: SubmoduleBinding };
// Feature 003 data-model §2 "Sync review". A sync binds no snapshot.
export type SyncReview = Omit<Issued, "snapshotId"> & { kind: "sync"; reviewToken: string; binding: SyncBinding };
export type Approval = HunkApproval | FileApproval | CommitReview | SubmoduleReview | SyncReview;

// Contract §2: the repeat key of each approval.
export type ApprovalKey =
  | Pick<HunkApproval, "kind" | "comparisonId" | "hunkId" | "direction">
  | Pick<FileApproval, "kind" | "comparisonId" | "direction">
  | Pick<CommitReview, "kind" | "reviewToken">
  | Pick<SubmoduleReview, "kind" | "reviewToken">
  | Pick<SyncReview, "kind" | "reviewToken">;

// A state change advances the generation, so the caller refuses it with REPOSITORY_CHANGED before acceptance (contract §9).
export type Acceptance =
  | { ok: true; approval: Approval }
  | { ok: false; code: "UNKNOWN_TARGET" | "APPROVAL_EXPIRED" }
  // Contract §2: the operation that consumed the approval.
  | { ok: false; consumed: string };

const keyOf = (k: ApprovalKey) =>
  k.kind === "hunk" ? `hunk/${k.comparisonId}/${k.hunkId}/${k.direction}` : k.kind === "file" ? `file/${k.comparisonId}/${k.direction}` : `${k.kind}/${k.reviewToken}`;

type Entry = { approval: Approval; issuedAt: number; consumed: string | null };

export function createApprovals(now: () => number = () => performance.now()) {
  const entries = new Map<string, Entry>();

  // Contract §9 acceptance order: a consumed approval answers the repeat before any other check.
  function accept(key: ApprovalKey): Acceptance {
    const e = entries.get(keyOf(key));
    if (e === undefined) return { ok: false, code: "UNKNOWN_TARGET" };
    if (e.consumed !== null) return { ok: false, consumed: e.consumed };
    if (now() - e.issuedAt > APPROVAL_LIFETIME_MS) return { ok: false, code: "APPROVAL_EXPIRED" };
    return { ok: true, approval: e.approval };
  }

  return {
    // A consumed approval stays bound to its operation for the session (contract §2), so a new one with its key is refused.
    issue(approval: Approval): { ok: true } | { ok: false; consumed: string } {
      const key = keyOf(approval);
      const consumed = entries.get(key)?.consumed ?? null;
      if (consumed !== null) return { ok: false, consumed };
      entries.set(key, { approval, issuedAt: now(), consumed: null });
      return { ok: true };
    },

    accept,

    // One use. False when the approval is not acceptable now.
    consume(key: ApprovalKey, operationId: string): boolean {
      if (!accept(key).ok) return false;
      entries.get(keyOf(key))!.consumed = operationId;
      return true;
    },

    // Contract §8 "Token invalidation": a later request gets UNKNOWN_TARGET. A consumed approval stays bound to its operation for the session.
    invalidate(match: (approval: Approval) => boolean): void {
      for (const [key, e] of entries) if (e.consumed === null && match(e.approval)) entries.delete(key);
    },

    // Contract §5: comparison eviction forgets its approvals. An expired approval stays until then, so it answers APPROVAL_EXPIRED.
    forget(comparisonId: string): void {
      for (const [key, e] of entries) if (e.consumed === null && "comparisonId" in e.approval && e.approval.comparisonId === comparisonId) entries.delete(key);
    },

    // The binding fields whose values differ. Raw bytes compare byte by byte.
    staleFields<B extends HunkBinding | FileBinding | CommitBinding | SubmoduleBinding>(bound: B, current: B): string[] {
      return Object.keys(bound).filter((k) => !Bun.deepEquals(bound[k as keyof B], current[k as keyof B], true));
    },
  };
}

export type Approvals = ReturnType<typeof createApprovals>;
