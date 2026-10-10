// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §3 `readRefs` and "References result", §5 "Reference listing" and "Reference result", and §7 "Shared listing" and "Held history steps".

import type { RefsRefusal, RefsResult } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { REF_LISTING_BYTES, REF_LISTING_RECORDS, REF_RESULT_BYTES } from "../contracts/limits";
import { refsArgs } from "./commands";
import { createCollector, type GitRunner } from "./git-runner";
import { sharedListing, type HistoryReaderOptions, type ReadHistoryTarget } from "./history";
import { encodedBytes, runRead, type ReadStep } from "./read-steps";
import { parseRefs } from "./refs-parser";

export type RefsOutcome =
  | { result: "succeeded"; value: RefsResult }
  | { result: "limited"; code: "OUTPUT_LIMIT"; value: RefsRefusal }
  | { result: "failed"; code: ErrorCode; value: RefsRefusal }
  | { result: "canceled" }
  | { result: "deadline" };

const LF = 0x0a;

const refusal = (code: ErrorCode, text?: string): RefsOutcome => ({
  result: "failed",
  code,
  value: { completeness: { state: "failed", code }, ...(text === undefined ? {} : { remedy: { text } }) },
});

// Contract §9: a `readRefs` OUTPUT_LIMIT result keeps no records.
const limited = (reason: "REF_LISTING_RECORDS" | "REF_LISTING_BYTES"): RefsOutcome => ({
  result: "limited",
  code: "OUTPUT_LIMIT",
  value: { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason } },
});

export function createRefsReader({ runner, trust, listingTuple }: Pick<HistoryReaderOptions, "trust" | "listingTuple"> & { runner: GitRunner }) {
  return {
    // The held `for-each-ref` step starts beside the trust listing. Its output reaches a response only after the read gate passes.
    async readRefs(t: ReadHistoryTarget): Promise<RefsOutcome> {
      const step = new AbortController();
      const stopStep = () => step.abort();
      t.signal.addEventListener("abort", stopStep, { once: true });
      if (t.signal.aborted) step.abort();
      try {
        // A record ends with LF, so the collector counts records at LF. A limited collector stops the process.
        const out = createCollector({ maxBytes: REF_LISTING_BYTES, maxRecords: REF_LISTING_RECORDS, separator: LF });
        const pending: Promise<ReadStep | null> = runRead(runner, { operationId: t.operationId, signal: step.signal, workspace: t.workspace }, refsArgs(), out).catch((error: unknown) => {
          if (step.signal.aborted) return null;
          throw error;
        });
        pending.catch(() => {});
        const listed = await sharedListing({ trust, listingTuple }, t);
        const gate = listed.ok ? trust.gate(t.workspace, listed.listing, t.installation, "reads") : null;
        if (!listed.ok || gate !== null) {
          // Contract §7 "Held history steps": a refused gate ends the held step and discards its output.
          step.abort();
          await pending.catch(() => null);
          if (t.signal.aborted) return { result: "canceled" };
          if (listed.ok) return refusal(gate!);
          return "stop" in listed ? { result: listed.stop } : refusal(listed.code, listed.text);
        }
        const ran = await pending;
        if (t.signal.aborted || ran === null) return { result: "canceled" };
        if ("refused" in ran) return refusal(ran.refused);
        if (ran.exit.deadline !== undefined) return { result: "deadline" };
        // Contract §9: unexpected diagnostic output above 4 MiB ends a read `failed` with OUTPUT_LIMIT.
        if (ran.exit.diagnosticLimit) return refusal("OUTPUT_LIMIT");
        const bytes = out.take();
        // Contract §5: the first reached bound wins, also over a later Git failure. The kept bytes hold every record that the record bound let pass.
        if (out.limited) return limited(bytes.filter((byte) => byte === LF).length >= REF_LISTING_RECORDS ? "REF_LISTING_RECORDS" : "REF_LISTING_BYTES");
        if (ran.exit.exitCode !== 0) return refusal("GIT_FAILED");
        const list = parseRefs(bytes, t.workspace.objectFormat);
        if (list === null) return refusal("MALFORMED_GIT_OUTPUT");
        const value: RefsResult = { generation: t.generation, ...list, completeness: { state: "complete" } };
        if (encodedBytes(value) > REF_RESULT_BYTES) return limited("REF_LISTING_BYTES");
        return { result: "succeeded", value };
      } finally {
        t.signal.removeEventListener("abort", stopStep);
      }
    },
  };
}

export type RefsReader = ReturnType<typeof createRefsReader>;
