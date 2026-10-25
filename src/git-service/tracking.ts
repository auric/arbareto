// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 003 contract Δ3 `readTracking`, data-model §1, and plan.md D8: one `for-each-ref` process, held behind the read gate as `readRefs` is.

import type { RefsRefusal } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { REF_LISTING_BYTES, REF_LISTING_RECORDS } from "../contracts/limits";
import { createCollector, type GitRunner } from "./git-runner";
import { sharedListing, type HistoryReaderOptions, type ReadHistoryTarget } from "./history";
import { runRead, type ReadStep } from "./read-steps";
import { trackingArgs } from "./sync-commands";
import { parseTracking, type TrackingEntry } from "./sync-parsers";

export type TrackingOutcome =
  | { result: "succeeded"; value: { entries: TrackingEntry[] } }
  | { result: "limited"; code: "OUTPUT_LIMIT"; value: RefsRefusal }
  | { result: "failed"; code: ErrorCode; value: RefsRefusal }
  | { result: "canceled" }
  | { result: "deadline" };

const LF = 0x0a;

const refusal = (code: ErrorCode, text?: string): TrackingOutcome => ({
  result: "failed",
  code,
  value: { completeness: { state: "failed", code }, ...(text === undefined ? {} : { remedy: { text } }) },
});

const limited = (reason: "REF_LISTING_RECORDS" | "REF_LISTING_BYTES"): TrackingOutcome => ({
  result: "limited",
  code: "OUTPUT_LIMIT",
  value: { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason } },
});

export function createTrackingReader({ runner, trust, listingTuple }: Pick<HistoryReaderOptions, "trust" | "listingTuple"> & { runner: GitRunner }) {
  return {
    // Contract §7 "Held history steps": the step starts beside the trust listing, and its output reaches a response only after the read gate passes.
    async readTracking(t: ReadHistoryTarget): Promise<TrackingOutcome> {
      const step = new AbortController();
      const stopStep = () => step.abort();
      t.signal.addEventListener("abort", stopStep, { once: true });
      if (t.signal.aborted) step.abort();
      try {
        const out = createCollector({ maxBytes: REF_LISTING_BYTES, maxRecords: REF_LISTING_RECORDS, separator: LF });
        const pending: Promise<ReadStep | null> = runRead(runner, { operationId: t.operationId, signal: step.signal, workspace: t.workspace }, trackingArgs(), out).catch((error: unknown) => {
          if (step.signal.aborted) return null;
          throw error;
        });
        pending.catch(() => {});
        const listed = await sharedListing({ trust, listingTuple }, t);
        const gate = listed.ok ? trust.gate(t.workspace, listed.listing, t.installation, "reads") : null;
        if (!listed.ok || gate !== null) {
          step.abort();
          const held = await pending.catch(() => null);
          if (t.signal.aborted) return { result: "canceled" };
          if (listed.ok) return refusal(gate!);
          if ("stop" in listed) return { result: listed.stop };
          // 001 contract §5 "Deadline outcomes": a held step at its deadline closes the Job of the listing processes.
          return held !== null && "exit" in held && held.exit.deadline !== undefined ? { result: "deadline" } : refusal(listed.code, listed.text);
        }
        const ran = await pending;
        if (t.signal.aborted || ran === null) return { result: "canceled" };
        if ("refused" in ran) return refusal(ran.refused);
        if (ran.exit.deadline !== undefined) return { result: "deadline" };
        if (ran.exit.diagnosticLimit) return refusal("OUTPUT_LIMIT");
        const bytes = out.take();
        // Contract §5: the first reached bound wins, also over a later Git failure.
        if (out.limited) return limited(bytes.filter((byte) => byte === LF).length >= REF_LISTING_RECORDS ? "REF_LISTING_RECORDS" : "REF_LISTING_BYTES");
        if (ran.exit.exitCode !== 0) return refusal("GIT_FAILED");
        const entries = parseTracking(bytes, t.workspace.objectFormat);
        return entries === null ? refusal("MALFORMED_GIT_OUTPUT") : { result: "succeeded", value: { entries } };
      } finally {
        t.signal.removeEventListener("abort", stopStep);
      }
    },
  };
}

export type TrackingReader = ReturnType<typeof createTrackingReader>;
