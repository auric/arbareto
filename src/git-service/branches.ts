// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `readBranches` and data-model §1. The branch listing and the feature 003 tracking listing are held steps behind the read gate,
// as `readRefs` is (001 §7 "Held history steps"). The worktree list runs only after the gate passes.

import { REF_RESULT_BYTES, type RefsRefusal } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { REF_LISTING_BYTES, REF_LISTING_RECORDS } from "../contracts/limits";
import { createCollector, firstEnd, type GitRunner } from "./git-runner";
import { sharedListing, type HistoryReaderOptions, type ReadHistoryTarget } from "./history";
import { isStop, type ObserveContext } from "./hunk-publish";
import { encodedBytes, runRead, type ReadStep } from "./read-steps";
import type { LimitName } from "./snapshot";
import { trackingArgs } from "./sync-commands";
import { parseTracking, type TrackingEntry } from "./sync-parsers";
import { branchListArgs } from "./workbench-commands";
import { localNameOf, parseBranches } from "./workbench-parsers";
import { readWorktrees } from "./workbench-review";

// Data-model §1. `invalidUtf8`: the ref bytes are no valid UTF-8, so `ref` is display text only.
export interface BranchEntry {
  ref: string;
  kind: "local" | "remote";
  name: string;
  invalidUtf8: boolean;
  oid: string;
  upstream: string | null;
  tracking: TrackingEntry | null;
  heldBy: string | null;
  current: boolean;
  localName: string | null;
  // Feature 005 contract Δ3: null when no tracking entry pairs with this read.
  upstreamPresent: boolean | null;
}

export type BranchesOutcome =
  | { result: "succeeded"; value: { entries: BranchEntry[] } }
  | { result: "limited"; code: "OUTPUT_LIMIT"; value: RefsRefusal }
  | { result: "failed"; code: ErrorCode; value: RefsRefusal }
  | { result: "canceled" }
  | { result: "deadline" };

const LF = 0x0a;
const HEADS = "refs/heads/";

const refusal = (code: ErrorCode, text?: string): BranchesOutcome => ({
  result: "failed",
  code,
  value: { completeness: { state: "failed", code }, ...(text === undefined ? {} : { remedy: { text } }) },
});

const limited = (reason: LimitName): BranchesOutcome => ({ result: "limited", code: "OUTPUT_LIMIT", value: { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason } } });

type Held = { out: ReturnType<typeof createCollector>; pending: Promise<ReadStep | null> };

// Contract §5: the first reached bound wins, also over a later Git failure.
function heldBytes(ran: ReadStep, out: Held["out"]): Uint8Array | BranchesOutcome {
  if ("refused" in ran) return refusal(ran.refused);
  if (ran.exit.deadline !== undefined) return { result: "deadline" };
  if (ran.exit.diagnosticLimit) return refusal("OUTPUT_LIMIT");
  const bytes = out.take();
  if (out.limited) return limited(bytes.filter((byte) => byte === LF).length >= REF_LISTING_RECORDS ? "REF_LISTING_RECORDS" : "REF_LISTING_BYTES");
  if (ran.exit.exitCode !== 0) return refusal("GIT_FAILED");
  return bytes;
}

export function createBranchesReader({ runner, trust, reader, listingTuple }: Pick<HistoryReaderOptions, "trust" | "listingTuple"> & { runner: GitRunner; reader: ObserveContext["reader"] }) {
  return {
    async readBranches(t: ReadHistoryTarget): Promise<BranchesOutcome> {
      const step = new AbortController();
      const stopStep = () => step.abort();
      t.signal.addEventListener("abort", stopStep, { once: true });
      if (t.signal.aborted) step.abort();
      // A record ends with LF, so each collector counts records at LF. A limited collector stops its process.
      const held = (args: string[]): Held => {
        const out = createCollector({ maxBytes: REF_LISTING_BYTES, maxRecords: REF_LISTING_RECORDS, separator: LF });
        const pending: Promise<ReadStep | null> = runRead(runner, { operationId: t.operationId, signal: step.signal, workspace: t.workspace }, args, out).catch((error: unknown) => {
          if (step.signal.aborted) return null;
          throw error;
        });
        pending.catch(() => {});
        return { out, pending };
      };
      try {
        const steps = [held(branchListArgs()), held(trackingArgs())];
        const listed = await sharedListing({ trust, listingTuple }, t);
        const gate = listed.ok ? trust.gate(t.workspace, listed.listing, t.installation, "reads") : null;
        if (!listed.ok || gate !== null) {
          // Contract §7 "Held history steps": a refused gate ends the held steps and discards their output.
          step.abort();
          const held = await Promise.all(steps.map((s) => s.pending.catch(() => null)));
          if (t.signal.aborted) return { result: "canceled" };
          if (listed.ok) return refusal(gate!);
          if ("stop" in listed) return { result: listed.stop };
          // 001 contract §5 "Deadline outcomes": a held step at its deadline closes the Job of the listing processes.
          return held.some((r) => r !== null && "exit" in r && r.exit.deadline !== undefined) ? { result: "deadline" } : refusal(listed.code, listed.text);
        }
        const ran = await Promise.all(steps.map((s) => s.pending));
        if (t.signal.aborted || ran.some((r) => r === null)) return { result: "canceled" };
        const [branchBytes, trackingBytes] = ran.map((r, i) => heldBytes(r!, steps[i]!.out));
        // A held step at its deadline also closes the Job of the other held step.
        if (!(branchBytes instanceof Uint8Array) || !(trackingBytes instanceof Uint8Array)) return firstEnd([branchBytes, trackingBytes].map((b) => (b instanceof Uint8Array ? null : b)), (b) => b.result === "deadline")!;
        const objectFormat = t.workspace.objectFormat;
        const records = parseBranches(branchBytes, objectFormat);
        const trackingEntries = parseTracking(trackingBytes, objectFormat);
        if (records === null || trackingEntries === null) return refusal("MALFORMED_GIT_OUTPUT");
        const ctx: ObserveContext = { runner, trust, reader, operationId: t.operationId, signal: t.signal, workspace: t.workspace, installation: t.installation };
        const worktrees = await readWorktrees(ctx);
        if (!("value" in worktrees)) {
          if (isStop(worktrees)) return { result: worktrees.stop };
          return worktrees.code === "OUTPUT_LIMIT" && worktrees.reason !== undefined ? limited(worktrees.reason) : refusal(worktrees.code);
        }

        // Exact matches only: a ref with bytes that are no valid UTF-8 has lossy text, so it pairs with nothing.
        const exact = records.filter((r) => !r.invalidUtf8);
        // The feature 003 tracking listing names each ref value, so the pairing compares ref values, not peeled commits.
        const values = new Map(exact.map((r) => [r.ref, r.object]));
        const tracked = new Map(trackingEntries.filter((e) => !e.invalidUtf8).map((e) => [`${HEADS}${e.name}`, e]));
        // Data-model §1 `heldBy`: the first worktree record with `branch <ref>`. The main worktree is the first record (git-worktree(1)).
        const holders = new Map<string, string>();
        for (const w of worktrees.value.records) if (w.branch !== null && !holders.has(w.branch)) holders.set(w.branch, w.path);
        const entries: BranchEntry[] = records.map((r) => {
          // Feature 003 data-model §1 pairing: the tracking entry counts only when its object IDs equal this read.
          const entry = r.invalidUtf8 ? undefined : tracked.get(r.ref);
          const upstreamValue = r.upstream === null ? null : (values.get(r.upstream) ?? null);
          const tracking = entry !== undefined && entry.objectId === r.object && entry.upstream === r.upstream && entry.upstreamObjectId === upstreamValue ? entry : null;
          // Plan.md D3: zero or several mapping refspecs give no local name.
          const localName = r.kind === "remote" && !r.invalidUtf8 ? localNameOf(r.ref, listed.listing.entries, objectFormat) : null;
          return {
            ref: r.ref,
            kind: r.kind,
            name: r.name,
            invalidUtf8: r.invalidUtf8,
            oid: r.oid,
            upstream: r.upstream,
            tracking,
            heldBy: holders.get(r.ref) ?? null,
            current: r.current,
            localName,
            // ref-filter.c prints `gone` when the upstream does not resolve. The branch listing alone cannot tell it: it holds only refs/heads and refs/remotes.
            upstreamPresent: r.upstream === null ? false : tracking === null ? null : tracking.track.state !== "gone",
          };
        });
        const value = { entries };
        if (encodedBytes(value) > REF_RESULT_BYTES) return limited("REF_LISTING_BYTES");
        return { result: "succeeded", value };
      } finally {
        t.signal.removeEventListener("abort", stopStep);
      }
    },
  };
}

export type BranchesReader = ReturnType<typeof createBranchesReader>;
