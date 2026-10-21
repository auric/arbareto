// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T113: commit attribution from the HEAD log, contract §5 "Commit attribution evidence" and §8 "Commit attribution read" and "Attribution window".
// The message, the identity, and the Git exit status never decide attribution.

import { ATTRIBUTION_EVIDENCE_BYTES, ATTRIBUTION_EVIDENCE_RECORDS } from "../contracts/limits";
import { isObjectId, reflogArgs, type ObjectFormat } from "./commands";
import { createCollector, type Collector } from "./git-runner";
import { stepOf, type Fact, type ObserveContext } from "./hunk-publish";
import { latin1 } from "./read-steps";
import type { Head } from "./snapshot";

const NUL = 0;
// Contract §8: commit OID, selector, committer name, committer email, and message.
const FIELDS = 5;
// Contract §8: with `--date=raw`, the selector is `HEAD@{<epoch> <zone>}`.
const SELECTOR = /^HEAD@\{[0-9]+ [+-][0-9]+\}$/;

// One printed record. `raw` holds the five fields with their NULs, so records equal in all five fields have equal bytes.
export interface ReflogRecord {
  oid: string;
  raw: Uint8Array;
}

export type Window = { records: ReflogRecord[] } | { evidenceLimit: true };
export type Attribution = { identified: string } | { none: true } | { unknown: "ambiguous" | "evidence-limit" };

const EVIDENCE_LIMIT: Window = { evidenceLimit: true };
const AMBIGUOUS: Attribution = { unknown: "ambiguous" };

function parseRecord(raw: Uint8Array, objectFormat: ObjectFormat): ReflogRecord | null {
  const oidEnd = raw.indexOf(NUL);
  const selectorEnd = raw.indexOf(NUL, oidEnd + 1);
  const oid = latin1(raw.subarray(0, oidEnd));
  return isObjectId(oid, objectFormat) && SELECTOR.test(latin1(raw.subarray(oidEnd + 1, selectorEnd))) ? { oid, raw } : null;
}

// The records before the first record equal to `tip`. Without a tip or an equal record, all records of a read that ended inside the caps.
// The tip counts toward the record cap. `capped`: the collector dropped bytes at a cap. Null: the output breaks the contract §8 form.
export function windowOf(bytes: Uint8Array, tip: ReflogRecord | null, capped: boolean, objectFormat: ObjectFormat): Window | null {
  const records: ReflogRecord[] = [];
  let start = 0;
  let fields = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== NUL || ++fields % FIELDS !== 0) continue;
    const raw = bytes.subarray(start, i + 1);
    start = i + 1;
    if (fields / FIELDS > ATTRIBUTION_EVIDENCE_RECORDS || start > ATTRIBUTION_EVIDENCE_BYTES) return EVIDENCE_LIMIT;
    const record = parseRecord(raw, objectFormat);
    if (record === null) return null;
    if (tip !== null && Buffer.compare(raw, tip.raw) === 0) return { records };
    records.push(record);
  }
  if (capped) return EVIDENCE_LIMIT;
  return start === bytes.length ? { records } : null;
}

// The window read keeps at most one record above the record cap. It reports `limited` after the tip record, so the runner cancels the read.
function windowCollector(tip: ReflogRecord | null): Collector & { readonly capped: boolean; take(): Uint8Array } {
  const kept = createCollector({ maxBytes: ATTRIBUTION_EVIDENCE_BYTES, maxRecords: FIELDS * (ATTRIBUTION_EVIDENCE_RECORDS + 1), separator: NUL });
  let found = false;
  let fields = 0;
  // The bytes of the current record that equal the tip so far, or -1 after a difference.
  let matched = 0;
  return {
    push(chunk: Uint8Array): void {
      if (found || kept.limited) return;
      if (tip !== null) {
        for (let i = 0; i < chunk.length; i++) {
          if (matched >= 0) matched = matched < tip.raw.length && tip.raw[matched] === chunk[i] ? matched + 1 : -1;
          if (chunk[i] !== NUL || ++fields % FIELDS !== 0) continue;
          if (matched === tip.raw.length) {
            found = true;
            return kept.push(chunk.subarray(0, i + 1));
          }
          matched = 0;
        }
      }
      kept.push(chunk);
    },
    get bytes() {
      return kept.bytes;
    },
    get records() {
      return kept.records;
    },
    get limited() {
      return found || kept.limited;
    },
    get capped() {
      return kept.limited;
    },
    take: () => kept.take(),
  };
}

// Contract §9 commit preflight: the newest HEAD log record. Git exits 128 for this read of an unborn HEAD, so an unborn reviewed HEAD gets no read.
// Null: no tip. With `core.logAllRefUpdates=false` and no HEAD log, Git exits 0 and prints nothing.
export async function readTip(ctx: ObserveContext, head: Head): Promise<Fact<ReflogRecord | null>> {
  if (head.state === "unborn") return { value: null };
  const out = createCollector({ maxBytes: ATTRIBUTION_EVIDENCE_BYTES });
  const step = await stepOf(ctx, reflogArgs(1), out);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT", reason: "ATTRIBUTION_EVIDENCE_BYTES" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const bytes = out.take();
  if (bytes.length === 0) return { value: null };
  const window = windowOf(bytes, null, false, ctx.workspace.objectFormat);
  return window !== null && "records" in window && window.records.length === 1 ? { value: window.records[0]! } : { code: "MALFORMED_GIT_OUTPUT" };
}

// Contract §8 "Attribution window": the HEAD log records after `tip`. The caller reads no window while the observed HEAD is unborn.
export async function readWindow(ctx: ObserveContext, tip: ReflogRecord | null): Promise<Fact<Window>> {
  const out = windowCollector(tip);
  const step = await stepOf(ctx, reflogArgs(), out);
  if (!("exit" in step)) return step;
  // The runner cancels a limited read, so its exit status tells nothing then.
  if (!out.limited && step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const window = windowOf(out.take(), tip, out.capped, ctx.workspace.objectFormat);
  return window === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: window };
}

const oidOf = (head: Head) => (head.state === "unborn" ? null : head.oid);

// Contract §8 "Attribution window": only a window of exactly one record identifies a commit. Its commit must be the observed HEAD `h1`.
// `parents` are the parents of that commit and must equal the reviewed HEAD `h0`. Null `parents`: no parents were read.
// `amended`: feature 004 contract Δ3. `commit --amend` gives the new commit the parents of `h0`, so they take its place.
export function attribute(window: Window, h0: Head, h1: Head, parents: readonly string[] | null, amended: readonly string[] | null = null): Attribution {
  if ("evidenceLimit" in window) return { unknown: "evidence-limit" };
  const [record, ...more] = window.records;
  if (record === undefined) return oidOf(h1) === oidOf(h0) ? { none: true } : AMBIGUOUS;
  const reviewed = oidOf(h0);
  const expected = amended ?? (reviewed === null ? [] : [reviewed]);
  if (more.length > 0 || record.oid !== oidOf(h1) || parents === null || !Bun.deepEquals(parents, expected, true)) return AMBIGUOUS;
  return { identified: record.oid };
}
