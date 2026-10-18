// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T111: contract §3 `reviewCommit`, §4 "Commit validation and handoff", data-model §6 "Commit review", and research.md R4.
// Read-only inspection: no `write-tree`, no trial commit, and no index write.

import type { ErrorCode } from "../contracts/errors";
import { APPROVAL_LIFETIME_MS, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, HISTORY_COMMIT_OBJECT_BYTES, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS } from "../contracts/limits";
import type { Approvals } from "./approvals";
import { emptyTreeArgs, isObjectId, isRefName, stagedNameStatusArgs } from "./commands";
import { createCollector, RunnerRefusal, type GitExit, type GitRunner, type WslIndexResult, type WslRunner } from "./git-runner";
import { contextOf, latin1, runRead, type ReadTarget } from "./read-steps";
import type { Workspace } from "./registration";
import type { ChangeSnapshot, Completeness, Head, IndexEntry, ReadInstallation } from "./snapshot";
import { readRawIndex } from "./status";
import { displayPath } from "./status-parser";
import { rewriteHooks, type Trust, type TrustState } from "./trust";
import { commitObjectArgs, headIsAncestorArgs, upstreamOfArgs } from "./workbench-commands";

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

// Feature 004 contract Δ3 `reviewCommit` with `amend`. `upstream` is the full ref, or null.
export interface AmendValue {
  headOid: string;
  message: string;
  upstream: string | null;
  rewritesUpstream: boolean;
}

export interface ReviewValue {
  generation: number;
  head: Head;
  scope: ScopeEntry[];
  // Plan.md "Trust required/changed": the review shows the trust state only when `approvalRequired` is true.
  disclosure: { approvalRequired: boolean; trust: TrustState };
  limitations: string[];
  // Contract §3: an empty staged scope gets no token. Feature 004 contract Δ3: an amend review gets one also then.
  reviewToken?: string;
  amend?: AmendValue;
}

export type ReviewOutcome =
  | { result: "succeeded"; value: ReviewValue }
  | { result: "limited"; code: "OUTPUT_LIMIT" | "OBJECT_MISSING" | "WORKTREE_CHANGING"; value: { completeness: Completeness } }
  | { result: "failed"; code: ErrorCode; value?: { reason: "unborn" } }
  | { result: "canceled" }
  | { result: "deadline" };

type Failed = Exclude<ReviewOutcome, { result: "succeeded" | "limited" }>;

// One read with bounded stdout. A refusal, a stop, and the diagnostic bound end it.
async function readStep(runner: GitRunner, t: ReadTarget, args: string[], maxBytes: number): Promise<{ exit: GitExit; bytes: Uint8Array; limited: boolean } | Failed> {
  const out = createCollector({ maxBytes });
  const step = await runRead(runner, t, args, out);
  if (t.signal.aborted) return { result: "canceled" };
  if ("refused" in step) return { result: "failed", code: step.refused };
  if (step.exit.deadline !== undefined) return { result: "deadline" };
  if (step.exit.diagnosticLimit) return { result: "failed", code: "OUTPUT_LIMIT" };
  return { exit: step.exit, bytes: out.take(), limited: out.limited };
}

// Git utf8.c `is_encoding_utf8`: `utf-8` and `utf8` with `strcasecmp`, which folds only ASCII letters. Without the `u` flag, `i` folds no other letter to ASCII.
export const isUtf8Name = (name: string): boolean => /^utf-?8$/i.test(name);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Plan.md D8: `cat-file commit <HEAD>`. gitformat-commit: the header lines end at the first empty line, and a continuation line starts with a space.
// The message is the bytes after that line. Git uses the first `encoding` header (commit.c `find_commit_header`).
async function headCommit(runner: GitRunner, t: ReadTarget, oid: string): Promise<{ parents: string[]; message: string } | Failed> {
  const read = await readStep(runner, t, commitObjectArgs(oid, t.workspace.objectFormat), HISTORY_COMMIT_OBJECT_BYTES);
  if ("result" in read) return read;
  if (read.limited) return { result: "failed", code: "OUTPUT_LIMIT" };
  if (read.exit.exitCode !== 0) return { result: "failed", code: "GIT_FAILED" };
  const raw = Buffer.from(read.bytes);
  const end = raw.indexOf("\n\n");
  const headers = end < 0 ? [] : latin1(raw.subarray(0, end)).split("\n");
  const parents = headers.filter((h) => h.startsWith("parent ")).map((h) => h.slice("parent ".length));
  if (!headers[0]?.startsWith("tree ") || !parents.every((p) => isObjectId(p, t.workspace.objectFormat))) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
  const encoding = headers.find((h) => h.startsWith("encoding "));
  // Contract Δ3 gives COMMIT_ENCODING_UNSUPPORTED for another encoding. Bytes that are no valid UTF-8 have no exact text either (contract gap).
  if (encoding !== undefined && !isUtf8Name(encoding.slice("encoding ".length))) return { result: "failed", code: "COMMIT_ENCODING_UNSUPPORTED" };
  try {
    return { parents, message: strictUtf8.decode(raw.subarray(end + 2)) };
  } catch {
    return { result: "failed", code: "COMMIT_ENCODING_UNSUPPORTED" };
  }
}

// Plan.md D8: the upstream U of the HEAD branch, then `merge-base --is-ancestor HEAD <U>`. git-merge-base(1): exit 0 true, exit 1 false.
// Another exit gives GIT_FAILED. A detached HEAD has no branch, so it has no upstream.
export async function readRewrite(runner: GitRunner, t: ReadTarget, head: Exclude<Head, { state: "unborn" }>): Promise<{ upstream: string | null; rewritesUpstream: boolean } | Failed> {
  if (head.state === "detached") return { upstream: null, rewritesUpstream: false };
  const read = await readStep(runner, t, upstreamOfArgs(head.target), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("result" in read) return read;
  if (read.limited) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
  if (read.exit.exitCode !== 0) return { result: "failed", code: "GIT_FAILED" };
  // git-for-each-ref(1): one line for the one matching ref. An empty line names no upstream.
  const text = latin1(read.bytes);
  const upstream = text.endsWith("\n") && !text.slice(0, -1).includes("\n") ? text.slice(0, -1) : null;
  if (upstream === null || (upstream !== "" && !(upstream.startsWith("refs/") && isRefName(upstream)))) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
  if (upstream === "") return { upstream: null, rewritesUpstream: false };
  const ancestor = await readStep(runner, t, headIsAncestorArgs(upstream, t.workspace.objectFormat), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("result" in ancestor) return ancestor;
  const code = ancestor.exit.exitCode;
  return code === 0 || code === 1 ? { upstream, rewritesUpstream: code === 0 } : { result: "failed", code: "GIT_FAILED" };
}

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

  // `amend`: feature 004 contract Δ3 `reviewCommit` with `amend: true` and plan.md D8 "Amend last commit".
  async function reviewCommit(t: ReviewTarget, amend = false): Promise<ReviewOutcome> {
    const { snapshot: s, workspace: w } = t;
    // Contract §5: a mutation needs a complete index snapshot.
    if (s.indexFingerprint === null || s.policyFingerprint === null) {
      const c = s.completeness;
      return c.state === "limited" ? { result: "limited", code: c.code, value: { completeness: c } } : { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
    }
    // Contract Δ3: the shown snapshot decides before any Git process. The states that the 001 commit acceptance refuses with OPERATION_IN_PROGRESS refuse here too.
    if (amend && s.head.state === "unborn") return { result: "failed", code: "WORKBENCH_UNAVAILABLE", value: { reason: "unborn" } };
    if (amend && s.operationState !== "normal" && s.operationState !== "conflicted" && s.operationState !== "unknown") return { result: "failed", code: "OPERATION_IN_PROGRESS" };

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

    // Plan.md D8: the HEAD message, its parents, and the upstream facts. An amend also runs `post-rewrite` (githooks(5)).
    let facts: { parents: string[]; value: AmendValue } | null = null;
    if (amend && s.head.state !== "unborn") {
      const commit = await headCommit(runner, t, s.head.oid);
      if ("result" in commit) return commit;
      const rewrite = await readRewrite(runner, t, s.head);
      if ("result" in rewrite) return rewrite;
      facts = { parents: commit.parents, value: { headOid: s.head.oid, message: commit.message, ...rewrite } };
    }
    const approvalRequired = listing.approvalRequired.commit || (facts !== null && rewriteHooks(listing));

    const view = trust.view(w, listing, t.installation);
    const value: ReviewValue = {
      generation: s.generation,
      head: s.head,
      scope: records.map((r) => ({ status: r.status, path: displayPath(r.path), pathBytes: Buffer.from(r.path).toString("base64") })),
      disclosure: { approvalRequired, trust: view.state },
      limitations: [REVIEW_LIMITATION],
      ...(facts === null ? {} : { amend: facts.value }),
    };
    // Contract Δ3: a message-only amend is valid, so an amend review gets a token for an empty staged scope.
    if (records.length === 0 && facts === null) return { result: "succeeded", value };

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
        approvalRequired,
        ...(facts === null ? {} : { amend: { parents: facts.parents, rewritesUpstream: facts.value.rewritesUpstream } }),
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
