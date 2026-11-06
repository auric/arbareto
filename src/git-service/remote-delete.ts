// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 plan.md D4 reads 2 to 10 and data-model §2: the review of `delete-remote-branch`. No read contacts a remote.
// This module registers nothing at load time (plan.md D15).

import type { SyncUnavailableReason } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import { isRefName } from "./commands";
import { createCollector } from "./git-runner";
import { stepOf } from "./hunk-publish";
import { deleteFacts, heldElsewhere, readWorktrees, refTarget, unavailable as localUnavailable, type Refused } from "./ref-facts";
import type { Head, OperationState } from "./snapshot";
import { fetchUrlArgs, onlyTipsCountArgs, onlyTipsListArgs, pushRecordArgs, pushUrlArgs, remoteHeadArgs } from "./sync-commands";
import { parsePushRecord, parsePushUrls, parseSymref, trackingOf } from "./sync-parsers";
import { commitsOf, mirrored, readOut, refKey, type Bound, type Observation, type ReviewPayload, type SyncContext } from "./sync-review";
import type { TrustListing } from "./trust";
import { localNameOf, trackingRemotes } from "./workbench-parsers";

const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/";
const unavailable = (reason: SyncUnavailableReason): Observation => ({ refused: "SYNC_UNAVAILABLE", reason });

export type DeletePayload = Extract<ReviewPayload, { action: "delete-remote-branch" }>;

// Plan.md D4 read 0: the rule of the payload, before any Git process.
export const deletePayloadValid = (p: DeletePayload): boolean =>
  p.ref.startsWith(REMOTES) && isRefName(p.ref) && (p.local === undefined || (p.local.startsWith(HEADS) && isRefName(p.local)));

// Data-model §6: a local branch refusal keeps its reason and the worktree of `other-worktree` and `head-unresolved`.
function fromRefused(r: Refused): Observation {
  const reason = r.result?.reason;
  const worktree = r.result?.worktree;
  return { refused: r.refused, ...(typeof reason === "string" ? { reason: reason as Extract<Observation, { refused: unknown }>["reason"] } : {}), ...(typeof worktree === "string" ? { worktree } : {}) };
}

export async function observeRemoteDelete(ctx: SyncContext, payload: DeletePayload, f: { head: Head; state: OperationState; remotes: readonly string[]; entries: TrustListing["entries"] }, bound: (b: Bound) => Observation): Promise<Observation> {
  const { head, state, entries } = f;
  const of = ctx.workspace.objectFormat;
  const ref = payload.ref;
  if (state !== "normal") return state === "unknown" ? unavailable("unknown-operation") : { refused: "OPERATION_IN_PROGRESS" };

  // Read 3. transport.c `update_one_tracking_ref` removes the tracking ref of the forward mapping, so that mapping must give back `ref`.
  const mapped = trackingRemotes(ref, entries, of);
  // remote.c `handle_config` stops Git on a refspec that it refuses.
  if (mapped === null) return unavailable("invalid-config");
  const name = localNameOf(ref, entries, of);
  const dst = `${HEADS}${name}`;
  if (name === null || mapped.length !== 1 || !isRefName(dst) || trackingOf(entries, mapped[0]!, dst) !== ref) return unavailable("no-remote-branch");
  const remote = mapped[0]!;

  // Read 4.
  if (!f.remotes.includes(remote)) return unavailable("remote-missing");
  if (mirrored(entries, remote)) return unavailable("mirror");

  // Read 5.
  const tracked = await refTarget(ctx, ref);
  if (!("value" in tracked)) return "refused" in tracked ? fromRefused(tracked) : tracked;
  const expect = tracked.value;

  // Read 6. Contract Δ3 `SyncRefused`: both refusals name the remote for the texts X13 and X14.
  const unknownDefault: Observation = { refused: "SYNC_UNAVAILABLE", reason: "default-unknown", remote };
  // git-check-ref-format(1): no ref has a name that fails the rule, so no symref can name the default branch.
  if (!isRefName(`${REMOTES}${remote}/HEAD`)) return unknownDefault;
  const symref = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const step = await stepOf(ctx, remoteHeadArgs(remote), symref);
  if (!("exit" in step)) return step;
  // builtin/symbolic-ref.c `check_symref`: `-q` exits 1 for an absent or a non-symbolic ref (research.md R2 P13).
  if (step.exit.exitCode === 1) return unknownDefault;
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const target = symref.limited ? null : parseSymref(symref.take());
  if (target === null) return { code: "MALFORMED_GIT_OUTPUT" };
  if (target === refKey(ref)) return { refused: "SYNC_UNAVAILABLE", reason: "default-branch", remote };

  // Read 7.
  let local: Bound["local"];
  if (payload.local !== undefined) {
    const localRef = payload.local;
    if (head.state !== "detached" && head.target === localRef) return fromRefused(localUnavailable("current-branch"));
    const worktrees = await readWorktrees(ctx);
    if (!("value" in worktrees)) return worktrees;
    const held = heldElsewhere(worktrees.value.records, localRef, head);
    if (held !== null) return fromRefused(held);
    const branch = localRef.slice(HEADS.length);
    const recordOut = await readOut(ctx, pushRecordArgs(branch), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
    if ("limited" in recordOut) return { code: "OUTPUT_LIMIT" };
    if (!("value" in recordOut)) return recordOut;
    const record = parsePushRecord(recordOut.value, branch, of);
    if (record === null) return { code: "MALFORMED_GIT_OUTPUT" };
    if (record === "absent") return { refused: "UNKNOWN_TARGET" };
    if (record.upstream !== ref) return unavailable("not-upstream");
    const facts = await deleteFacts(ctx, localRef, { entries });
    if (!("value" in facts)) return "refused" in facts ? fromRefused(facts) : facts;
    local = { ref: localRef, ...facts.value, worktrees: worktrees.value.digest };
  }

  // Read 8: O-11, exactly one push URL.
  const pushOut = await readOut(ctx, pushUrlArgs(remote), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in pushOut) return { code: "OUTPUT_LIMIT" };
  if (!("value" in pushOut)) return pushOut;
  const urls = parsePushUrls(pushOut.value);
  if (urls === null) return { code: "MALFORMED_GIT_OUTPUT" };
  if ("reason" in urls) return unavailable(urls.reason);

  // Read 9: plan.md D8 checks the fetch URL only when it names the push URL byte for byte (research.md R2 P16).
  const fetchOut = await readOut(ctx, fetchUrlArgs(remote), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in fetchOut) return { code: "OUTPUT_LIMIT" };
  if (!("value" in fetchOut)) return fetchOut;
  const sameUrl = Buffer.from(fetchOut.value).equals(Buffer.from(pushOut.value));

  // Read 10: one count over both tips, because two counts miss the commits that only the two refs hold (research.md R2 P14).
  const tips = local === undefined ? [expect] : [expect, local.oid];
  const branch = local === undefined ? null : local.ref.slice(HEADS.length);
  const tracking = ref.slice(REMOTES.length);
  const commits = await commitsOf(ctx, onlyTipsCountArgs(tips, branch, tracking, of), onlyTipsListArgs(tips, branch, tracking, of));
  if (!("value" in commits)) return commits;

  return bound({
    remotes: [remote],
    destination: { remote, ref: dst, trackingRef: ref, url: urls.url, setUpstream: false, upstreamRebase: false, source: "tracking-ref" },
    lease: { trackingRef: ref, expect, ...commits.value },
    ...(local === undefined ? {} : { local }),
    sameUrl,
  });
}
