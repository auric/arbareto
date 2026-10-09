// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T111: contract §3 `reviewCommit`, §4 "Commit validation and handoff", data-model §6 "Commit review", and research.md R4.
// Read-only inspection: no `write-tree`, no trial commit, and no index write.

import type { ErrorCode } from "../contracts/errors";
import { APPROVAL_LIFETIME_MS, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS } from "../contracts/limits";
import type { Approvals } from "./approvals";
import { emptyTreeArgs, isObjectId, stagedNameStatusArgs } from "./commands";
import { createCollector, RunnerRefusal, type GitRunner, type WslIndexResult, type WslRunner } from "./git-runner";
import { contextOf, runRead } from "./read-steps";
import type { Workspace } from "./registration";
import type { ChangeSnapshot, Completeness, Head, IndexEntry, ReadInstallation } from "./snapshot";
import { readRawIndex } from "./status";
import { displayPath } from "./status-parser";
import type { Trust, TrustState } from "./trust";

// Plan.md "Commit review": the disclosure beside Commit staged changes.
export const REVIEW_LIMITATION = "Git will run approved hooks. They or other Git tools can change the result during execution.";

// git-diff(1) "--diff-filter": without `-M`, `-C`, or `-B`, plumbing `diff-index` prints no R, C, or B record. X marks a Git bug.
const STATUS_LETTERS = ["A", "D", "M", "T", "U"] as const;
type StatusLetter = (typeof STATUS_LETTERS)[number];

const NUL = 0x00;
const NEWLINE = 0x0a;

export interface ScopeEntry {
  status: StatusLetter;
  path: string;
  pathBytes: string;
}

export interface ReviewValue {
  generation: number;
  head: Head;
  scope: ScopeEntry[];
  // Plan.md "Trust required/changed": the review shows the trust state only when `approvalRequired` is true.
  disclosure: { approvalRequired: boolean; trust: TrustState };
  limitations: string[];
  // Contract §3: an empty staged scope gets no token.
  reviewToken?: string;
}

export type ReviewOutcome =
  | { result: "succeeded"; value: ReviewValue }
  | { result: "limited"; code: "OUTPUT_LIMIT" | "OBJECT_MISSING" | "WORKTREE_CHANGING"; value: { completeness: Completeness } }
  | { result: "failed"; code: ErrorCode }
  | { result: "canceled" }
  | { result: "deadline" };

export interface ReviewTarget {
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
  installation: ReadInstallation;
  snapshot: ChangeSnapshot;
}

// The reviewed index that T112 and T113 compare. A Windows review keeps the raw bytes. A WSL review keeps the `indexDigest` result instead (contract §6 "WSL file work").
export interface RetainedReview {
  repositoryId: string;
  issuedAt: number;
  rawIndex: Uint8Array | null;
  wslIndex: WslIndexResult | null;
  entries: readonly IndexEntry[];
}

// `diff-index -z --name-status`: `<letter> NUL <path> NUL` for each record. Null: the output breaks that form.
export function parseScope(raw: Uint8Array): { status: StatusLetter; path: Uint8Array }[] | null {
  if (raw.length === 0) return [];
  if (raw[raw.length - 1] !== NUL) return null;
  const fields: Uint8Array[] = [];
  for (let start = 0; start < raw.length; ) {
    const end = raw.indexOf(NUL, start);
    fields.push(raw.subarray(start, end));
    start = end + 1;
  }
  if (fields.length % 2 !== 0) return null;
  const records = [];
  for (let i = 0; i < fields.length; i += 2) {
    const letter = Buffer.from(fields[i]!).toString("latin1") as StatusLetter;
    const path = fields[i + 1]!;
    if (!STATUS_LETTERS.includes(letter) || path.length === 0) return null;
    records.push({ status: letter, path });
  }
  return records;
}

export interface CommitReviewerOptions {
  runner: GitRunner & WslRunner;
  trust: Trust;
  approvals: Approvals;
  now?: () => number;
}

export function createCommitReviewer({ runner, trust, approvals, now = () => performance.now() }: CommitReviewerOptions) {
  // Keyed by review token. T112 takes the data at acceptance, so an expired review drops its data.
  const retained = new Map<string, RetainedReview>();
  const prune = () => {
    for (const [token, r] of retained) if (now() - r.issuedAt > APPROVAL_LIFETIME_MS) retained.delete(token);
  };

  // The Git-computed empty tree of an unborn HEAD. Without `-w`, Git writes no object.
  async function emptyTree(t: ReviewTarget): Promise<string | ReviewOutcome> {
    const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const step = await runRead(runner, t, emptyTreeArgs(), out, new Uint8Array());
    if (t.signal.aborted) return { result: "canceled" };
    if ("refused" in step) return { result: "failed", code: step.refused };
    if (step.exit.deadline !== undefined) return { result: "deadline" };
    const raw = out.take();
    const oid = Buffer.from(raw.subarray(0, -1)).toString("latin1");
    if (step.exit.exitCode !== 0 || out.limited || raw[raw.length - 1] !== NEWLINE || !isObjectId(oid, t.workspace.objectFormat)) return { result: "failed", code: "GIT_FAILED" };
    return oid;
  }

  // The current index equals the index of the snapshot. Read no index bytes through UNC: a WSL review asks `wslFiles` for the digests.
  async function currentIndex(t: ReviewTarget): Promise<Pick<RetainedReview, "rawIndex" | "wslIndex"> | ReviewOutcome> {
    const bound = t.snapshot.indexFingerprint!;
    const changed: ReviewOutcome = { result: "failed", code: "REPOSITORY_CHANGED" };
    const limited: ReviewOutcome = { result: "limited", code: "OUTPUT_LIMIT", value: { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "MUTATION_RAW_INDEX_BYTES" } } };
    if (t.workspace.wsl === undefined) {
      const raw = await readRawIndex(t.workspace.indexPath);
      if (raw === "unavailable") return { result: "failed", code: "REPOSITORY_UNAVAILABLE" };
      if (raw === "over") return limited;
      const digest = raw === null ? null : new Bun.CryptoHasher("sha256").update(raw).digest("hex");
      return digest === bound.rawIndexDigest ? { rawIndex: raw, wslIndex: null } : changed;
    }
    const sharedDigest = bound.sharedIndex?.digest ?? null;
    let results;
    try {
      results = await runner.wslFiles(
        { operationId: t.operationId, ...contextOf(t.workspace), mode: "indexDigest", bound: "MUTATION_RAW_INDEX_BYTES", ...(sharedDigest === null ? {} : { sharedIndex: bound.sharedIndex!.hash }) },
        t.signal,
      );
    } catch (error) {
      if (error instanceof RunnerRefusal) return { result: "failed", code: error.code };
      throw error;
    }
    if (!Array.isArray(results)) return { result: results.stop };
    const r = results[0]!;
    if (r.kind !== "index") return { result: "failed", code: "REPOSITORY_UNAVAILABLE" };
    const parts = [r.index, ...(r.sharedIndex === undefined ? [] : [r.sharedIndex])];
    if (parts.some((p) => p.kind === "error")) return { result: "failed", code: "REPOSITORY_UNAVAILABLE" };
    if (parts.some((p) => p.kind === "bound")) return limited;
    const sha = (p: (typeof parts)[number] | undefined) => (p?.kind === "digest" ? p.sha256 : null);
    const same = sha(r.index) === bound.rawIndexDigest && sha(r.sharedIndex) === sharedDigest;
    return same ? { rawIndex: null, wslIndex: r } : changed;
  }

  async function reviewCommit(t: ReviewTarget): Promise<ReviewOutcome> {
    const { snapshot: s, workspace: w } = t;
    // Contract §5: a mutation needs a complete index snapshot.
    if (s.indexFingerprint === null || s.policyFingerprint === null) {
      const c = s.completeness;
      return c.state === "limited" ? { result: "limited", code: c.code, value: { completeness: c } } : { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
    }

    // Contract §7: `diff-index` loads the index, so the read gate decides first.
    const listed = await trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: w });
    if (!listed.ok) return "stop" in listed ? { result: listed.stop } : { result: "failed", code: listed.code };
    const listing = listed.listing;
    const gate = trust.gate(w, listing, t.installation, "reads");
    if (gate !== null) return { result: "failed", code: gate };

    const tree = s.head.state === "unborn" ? await emptyTree(t) : s.head.oid;
    if (typeof tree !== "string") return tree;

    // Contract §5 "Status or index listing": two NUL-terminated fields for each record.
    const out = createCollector({ maxBytes: STATUS_LISTING_BYTES, maxRecords: 2 * STATUS_LISTING_RECORDS, separator: NUL });
    const step = await runRead(runner, t, stagedNameStatusArgs(tree, w.objectFormat), out);
    if (t.signal.aborted) return { result: "canceled" };
    if ("refused" in step) return { result: "failed", code: step.refused };
    if (step.exit.deadline !== undefined) return { result: "deadline" };
    if (step.exit.diagnosticLimit) return { result: "failed", code: "OUTPUT_LIMIT" };
    const raw = out.take();
    if (out.limited) {
      const reason = raw.reduce((n, b) => n + (b === NUL ? 1 : 0), 0) >= 2 * STATUS_LISTING_RECORDS ? "STATUS_LISTING_RECORDS" : "STATUS_LISTING_BYTES";
      return { result: "limited", code: "OUTPUT_LIMIT", value: { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason } } };
    }
    if (step.exit.exitCode !== 0) return { result: "failed", code: "GIT_FAILED" };
    const records = parseScope(raw);
    if (records === null) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };

    const index = await currentIndex(t);
    if ("result" in index) return index;
    if (t.signal.aborted) return { result: "canceled" };

    const view = trust.view(w, listing, t.installation);
    const value: ReviewValue = {
      generation: s.generation,
      head: s.head,
      scope: records.map((r) => ({ status: r.status, path: displayPath(r.path), pathBytes: Buffer.from(r.path).toString("base64") })),
      disclosure: { approvalRequired: listing.approvalRequired.commit, trust: view.state },
      limitations: [REVIEW_LIMITATION],
    };
    if (records.length === 0) return { result: "succeeded", value };

    const reviewToken = crypto.randomUUID();
    approvals.issue({
      kind: "commit",
      reviewToken,
      repositoryId: w.repositoryId,
      snapshotId: s.snapshotId,
      generation: s.generation,
      binding: {
        stagedScope: new Bun.CryptoHasher("sha256").update(tree).update(raw).digest("hex"),
        reviewedIndex: s.indexFingerprint,
        head: s.head,
        disclosure: listing.fingerprint,
        trust: { state: view.state, trustId: view.trustId ?? null },
        operationState: s.operationState,
        approvalRequired: listing.approvalRequired.commit,
      },
    });
    prune();
    retained.set(reviewToken, { repositoryId: w.repositoryId, issuedAt: now(), ...index, entries: s.indexEntries });
    return { result: "succeeded", value: { ...value, reviewToken } };
  }

  return {
    reviewCommit,
    retained: (reviewToken: string): RetainedReview | undefined => retained.get(reviewToken),
    // Contract §6 "Registration reuse and release".
    release(repositoryId: string): void {
      for (const [token, r] of retained) if (r.repositoryId === repositoryId) retained.delete(token);
    },
  };
}

export type CommitReviewer = ReturnType<typeof createCommitReviewer>;
