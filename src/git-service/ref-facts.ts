// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 plan.md D15 "Side-effect-free fact module": the ref, worktree, and local branch reads of the workbench and the remote branch delete.
// This module registers nothing at load time, so `sync-review.ts` can import it without the load order of `branch-ops.ts`.

import type { ErrorCode, WorkbenchUnavailableReason } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, REFLOG_SCAN_ENTRIES, TRUST_INPUT_BYTES, WORKTREE_LISTING_BYTES, WORKTREE_RECORDS } from "../contracts/limits";
import { createCollector } from "./git-runner";
import { isStop, stepOf, type Fact, type ObserveContext } from "./hunk-publish";
import type { Head } from "./snapshot";
import { parseRevListCount } from "./sync-parsers";
import { listRefs, readOut, readWave, refKey } from "./sync-review";
import { parseConfigListing, type ConfigEntry, type TrustListing } from "./trust";
import { headReflogArgs, headReflogExistsArgs, localConfigArgs, unmergedCountArgs, worktreeListArgs } from "./workbench-commands";
import { oidList, parseWorktrees, type WorktreeRecord } from "./workbench-parsers";

const HEADS = "refs/heads/";
const short = (ref: string) => ref.slice(HEADS.length);

// A refusal before any token. `result` holds the reason and its facts.
export type Refused = { refused: ErrorCode; result?: Record<string, unknown> };

export const unavailable = (reason: WorkbenchUnavailableReason, extra: Record<string, unknown> = {}): Refused => ({ refused: "WORKBENCH_UNAVAILABLE", result: { reason, ...extra } });

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

// Data-model §8: Git names no branch for a `headUnresolved` record, so that record can hold any branch.
export function unresolvedRefusal(records: readonly WorktreeRecord[]): Refused | null {
  const unknown = records.find((r) => r.headUnresolved);
  return unknown === undefined ? null : unavailable("head-unresolved", { worktree: unknown.path });
}

// The refusal for a `ref` that another worktree holds, or null. A worktree record holds one branch, so the current record holds only the HEAD branch.
export function heldElsewhere(records: readonly WorktreeRecord[], ref: string, head: Head): Refused | null {
  if (head.state !== "detached" && head.target === ref) return null;
  const held = records.find((r) => r.branchKey === refKey(ref));
  return held !== undefined ? unavailable("other-worktree", { worktree: held.path }) : unresolvedRefusal(records);
}

// Data-model §4 `reflogKeeps`: the entries of the HEAD reflog. builtin/reflog.c `cmd_reflog_exists`: exit 0 when the reflog exists, 1 when it does not.
async function headReflog(ctx: ObserveContext): Promise<Fact<string[]>> {
  const exists = await stepOf(ctx, headReflogExistsArgs(), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
  if (!("exit" in exists)) return exists;
  if (exists.exit.exitCode === 1) return { value: [] };
  if (exists.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  // `-n` caps the entries at REFLOG_SCAN_ENTRIES, so more bytes break the grammar.
  const read = await readOut(ctx, headReflogArgs(), REFLOG_SCAN_ENTRIES * 65);
  if ("limited" in read) return { code: "MALFORMED_GIT_OUTPUT" };
  if (!("value" in read)) return read;
  const oids = oidList(read.value, ctx.workspace.objectFormat);
  return oids === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: oids };
}

// The count of local file keys that `keep` takes. The listing of the review counts the included files too (git-config(1) `--no-includes`).
async function localSectionKeys(ctx: ObserveContext, keep: (e: ConfigEntry) => boolean): Promise<Fact<number>> {
  const read = await readOut(ctx, localConfigArgs(), TRUST_INPUT_BYTES);
  if ("limited" in read) return { code: "OUTPUT_LIMIT" };
  if (!("value" in read)) return read;
  const entries = parseConfigListing(read.value, false);
  return entries === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: entries.filter(keep).length };
}

// Data-model §4 facts of one local branch. `section`: the local file holds a `branch.<name>` key.
export interface DeleteFacts {
  oid: string;
  onlyHere: number;
  reflogKeeps: boolean;
  section: boolean;
}

// Plan.md D4 delete reads after the worktree check. Feature 004 plan.md D10 "Also delete the branch" reads them too. `known`: the tip from a `refTarget` read of the caller.
// The reads run together in one `readWave`. Then the checks keep the read order, so the first failing check decides.
export async function deleteFacts(ctx: ObserveContext, ref: string, listing: Pick<TrustListing, "entries">, known?: string): Promise<Fact<DeleteFacts> | Refused> {
  // builtin/branch.c `delete_branch_config` removes the `branch.<name>` section. A key prints as section, subsection, and a variable without a dot.
  const inSection = (e: ConfigEntry) => e.scope === "local" && e.key.slice(0, e.key.lastIndexOf(".")) === `branch.${short(ref)}`;
  const listed = listing.entries.filter(inSection).length;
  const tipRead: Promise<Fact<string> | Refused> = known === undefined ? refTarget(ctx, ref) : Promise.resolve({ value: known });
  const reads = await readWave([
    tipRead,
    tipRead.then<Fact<number> | Refused>((t) => ("value" in t ? revCount(ctx, unmergedCountArgs(t.value, short(ref), ctx.workspace.objectFormat)) : t)),
    headReflog(ctx),
    listed === 0 ? { value: 0 } : localSectionKeys(ctx, inSection),
  ]);
  if (isStop(reads)) return reads;
  const [tip, count, reflog, own] = reads;
  if (!("value" in tip)) return tip;
  if (!("value" in count)) return count;
  if (!("value" in reflog)) return reflog;
  if (!("value" in own)) return own;
  // `config --local --remove-section` changes the local file alone. A key of an included file would stay, and Git exits 128 when the local file holds no key.
  if (own.value < listed) return unavailable("config-in-include");
  return { value: { oid: tip.value, onlyHere: count.value, reflogKeeps: reflog.value.includes(tip.value), section: own.value > 0 } };
}
