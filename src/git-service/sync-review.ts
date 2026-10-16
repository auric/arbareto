// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 003 contract Δ3 `reviewSync` reads 1 to 6 for `fetch`, `fetch-all`, `push`, and `force-push`, data-model §2 and §3, and plan.md D3 to D5.
// `sync` runs the same reads again with the bound payload (contract Δ3 `sync` step 2). No read contacts a remote.

import type { ServiceRequest } from "../contracts/envelope";
import type { ErrorCode, SyncUnavailableReason } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, SYNC_LEASE_COMMITS, SYNC_REFS_BYTES, SYNC_REFS_RECORDS, SYNC_REMOTES } from "../contracts/limits";
import { redactUrlUserInfo } from "../contracts/submodules";
import type { Approvals } from "./approvals";
import { batchCommandArgs, isObjectId, isRefName, type ObjectFormat } from "./commands";
import { createCollector } from "./git-runner";
import { captureHead, sharedListing, type HistoryReaderOptions, type ReadHistoryTarget } from "./history";
import { objectStream } from "./history-view";
import { isStop, settled, stepOf, type Fact, type Failure, type ObserveContext, type Stop } from "./hunk-publish";
import type { Head, OperationState } from "./snapshot";
import { leaseCommitsArgs, leaseCountArgs, pushRecordArgs, pushUrlArgs, remoteListArgs, syncRefsArgs } from "./sync-commands";
import { decidePushDestination, invalidRemoteValue, parsePushRecord, parsePushUrls, parseRevListCount, type PushDestination } from "./sync-parsers";
import { parseMaybeBool, type ConfigEntry, type ListingOutcome } from "./trust";

export type ReviewPayload = Extract<ServiceRequest, { operation: "reviewSync" }>["payload"];
export type SyncAction = ReviewPayload["action"];

// Data-model §3. `url` is the unredacted push URL. It never leaves the service, except in a `terminal` request.
export interface BoundDestination {
  remote: string;
  ref: string;
  trackingRef: string | null;
  url: string;
  setUpstream: boolean;
  source: PushDestination["source"] | "panel";
}

export interface Lease {
  trackingRef: string;
  expect: string;
  count: number;
  commits: { objectId: string; subject: string | null }[];
}

// Data-model §2: the values that `sync` reads again and compares.
export interface SyncBinding {
  payload: ReviewPayload;
  head: Head;
  operationState: OperationState;
  trust: { fingerprint: string; sync: boolean };
  remotes: string[];
  destination: BoundDestination | null;
  lease: Lease | null;
}

export interface NeedsDestination {
  remotes: string[];
  prefill: { remote: string; ref: string } | null;
  setUpstream: boolean;
}

// `entries`: the configuration of the read, for the upstream values of a push and the URLs of a remedy.
export type Observation =
  | { binding: SyncBinding; entries: readonly ConfigEntry[] }
  | { panel: NeedsDestination; operationState: OperationState }
  | { refused: ErrorCode; reason?: SyncUnavailableReason | "SYNC_REMOTES" }
  | Stop
  | Failure;

const HEADS = "refs/heads/";
const LF = 0x0a;
const exact = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const unavailable = (reason: SyncUnavailableReason): Observation => ({ refused: "SYNC_UNAVAILABLE", reason });

// Git's last-value rule. Undefined: no entry. Null: a key without `=`.
export function lastValue(entries: readonly ConfigEntry[], key: string): string | null | undefined {
  let value: string | null | undefined;
  for (const entry of entries) if (entry.key === key) value = entry.value;
  return value;
}

// O-4 and research R16 k: the last value over both names decides. Every value passed `invalidRemoteValue`.
const skipped = (entries: readonly ConfigEntry[], remote: string) => {
  const keys = [`remote.${remote}.skipfetchall`, `remote.${remote}.skipdefaultupdate`];
  let skip = false;
  for (const entry of entries) if (keys.includes(entry.key)) skip = parseMaybeBool(entry.value) === 1;
  return skip;
};

const mirrored = (entries: readonly ConfigEntry[], remote: string) => {
  const value = lastValue(entries, `remote.${remote}.mirror`);
  return value !== undefined && parseMaybeBool(value) === 1;
};

// `for-each-ref --format=%(refname)%00%(objectname)`: keys are byte strings (`latin1`), so equal keys mean equal bytes.
export function parseRefListing(bytes: Uint8Array, objectFormat: ObjectFormat): Map<string, string> | null {
  const text = Buffer.from(bytes).toString("latin1");
  const refs = new Map<string, string>();
  if (text === "") return refs;
  if (!text.endsWith("\n")) return null;
  for (const line of text.slice(0, -1).split("\n")) {
    const fields = line.split("\0");
    if (fields.length !== 2 || !fields[0]!.startsWith("refs/") || !isObjectId(fields[1]!, objectFormat) || refs.has(fields[0]!)) return null;
    refs.set(fields[0]!, fields[1]!);
  }
  return refs;
}

// The listing key of a ref name that Git printed in UTF-8.
export const refKey = (name: string): string => Buffer.from(name, "utf8").toString("latin1");
// The display text of a listing key. Invalid UTF-8 shows replacement characters.
export const refText = (key: string): string => Buffer.from(key, "latin1").toString("utf8");

// Contract Δ3 `sync` step 4 and Δ5: at most 100,000 records and 32 MiB. `pattern` narrows the listing to one ref and the refs below it.
export async function listRefs(ctx: ObserveContext, pattern?: string): Promise<Fact<Map<string, string>>> {
  if (pattern !== undefined && !isRefName(pattern)) return { code: "MALFORMED_GIT_OUTPUT" };
  const out = createCollector({ maxBytes: SYNC_REFS_BYTES, maxRecords: SYNC_REFS_RECORDS, separator: LF });
  const step = await stepOf(ctx, pattern === undefined ? syncRefsArgs() : [...syncRefsArgs(), pattern], out);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT", reason: out.records > SYNC_REFS_RECORDS ? "SYNC_REFS_RECORDS" : "SYNC_REFS_BYTES" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const refs = parseRefListing(out.take(), ctx.workspace.objectFormat);
  return refs === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: refs };
}

// One read with bounded output. A nonzero exit gives GIT_FAILED.
async function readOut(ctx: ObserveContext, args: string[], maxBytes: number, input?: Uint8Array): Promise<Fact<Uint8Array> | { limited: true }> {
  const out = createCollector({ maxBytes });
  const step = await stepOf(ctx, args, out, input);
  if (!("exit" in step)) return step;
  if (out.limited) return { limited: true };
  return step.exit.exitCode === 0 ? { value: out.take() } : { code: "GIT_FAILED" };
}

// Contract Δ3 read 3 and Δ5 `SYNC_REMOTES`.
async function remoteList(ctx: ObserveContext): Promise<Fact<string[]> | { refused: ErrorCode; reason?: "SYNC_REMOTES" }> {
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, separator: LF });
  const step = await stepOf(ctx, remoteListArgs(), out);
  if (!("exit" in step)) return step;
  if (out.records > SYNC_REMOTES) return { refused: "OUTPUT_LIMIT", reason: "SYNC_REMOTES" };
  if (out.limited) return { refused: "OUTPUT_LIMIT" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const bytes = out.take();
  if (bytes.length === 0) return { value: [] };
  let text: string;
  try {
    text = exact.decode(bytes);
  } catch {
    return { code: "MALFORMED_GIT_OUTPUT" };
  }
  const names = text.endsWith("\n") ? text.slice(0, -1).split("\n") : null;
  return names === null || names.includes("") ? { code: "MALFORMED_GIT_OUTPUT" } : { value: names };
}

// Plan.md D5: the commits that the force push removes from the remote branch, with their subjects from `cat-file --batch-command -Z`.
async function leaseOf(ctx: ObserveContext, trackingRef: string, head: string): Promise<Fact<Lease> | { refused: ErrorCode; reason?: SyncUnavailableReason }> {
  const objectFormat = ctx.workspace.objectFormat;
  const refs = await listRefs(ctx, trackingRef);
  if (!("value" in refs)) return refs;
  const expect = refs.value.get(refKey(trackingRef));
  if (expect === undefined) return { refused: "SYNC_UNAVAILABLE", reason: "no-lease" };
  const counted = await readOut(ctx, leaseCountArgs(expect, head, objectFormat), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in counted) return { code: "MALFORMED_GIT_OUTPUT" };
  if (!("value" in counted)) return counted;
  const count = parseRevListCount(counted.value);
  const listed = await readOut(ctx, leaseCommitsArgs(expect, head, objectFormat), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in listed) return { code: "MALFORMED_GIT_OUTPUT" };
  if (!("value" in listed)) return listed;
  const text = Buffer.from(listed.value).toString("latin1");
  const oids = text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : null;
  // Both reads take object IDs, so the list is the start of the counted set.
  if (count === null || oids === null || !oids.every((oid) => isObjectId(oid, objectFormat)) || oids.length !== Math.min(count, SYNC_LEASE_COMMITS)) return { code: "MALFORMED_GIT_OUTPUT" };
  if (oids.length === 0) return { value: { trackingRef, expect, count, commits: [] } };
  const stream = objectStream(oids, objectFormat);
  const step = await stepOf(ctx, batchCommandArgs(), stream, new TextEncoder().encode(oids.map((oid) => `contents ${oid}\0`).join("")));
  if (!("exit" in step)) return step;
  const answers = stream.result();
  if (answers === "MALFORMED_GIT_OUTPUT") return { code: step.exit.exitCode !== 0 && !stream.limited ? "GIT_FAILED" : "MALFORMED_GIT_OUTPUT" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const commits: Lease["commits"] = [];
  for (const [i, answer] of answers.entries()) {
    if (answer === "missing") return { code: "OBJECT_MISSING" };
    // Contract Δ3 read 6: a commit object above HISTORY_COMMIT_OBJECT_BYTES gives `subject` null.
    commits.push({ objectId: oids[i]!, subject: answer === "large" ? null : answer.subject });
  }
  return { value: { trackingRef, expect, count, commits } };
}

// Contract Δ3 `reviewSync` reads 1 to 6. `list` gives the trust listing: shared or own for a review, own for `sync`.
export async function observeSync(ctx: ObserveContext, payload: ReviewPayload, list: () => Promise<ListingOutcome>): Promise<Observation> {
  const { trust, workspace: w, installation, signal } = ctx;
  const listed = await settled(signal, list());
  if (!("ok" in listed)) return listed;
  if (!listed.ok) return "stop" in listed ? { stop: listed.stop } : { code: listed.code };
  const { listing } = listed;
  const gate = trust.gate(w, listing, installation, "sync");
  if (gate !== null) return { refused: gate };
  const entries = listing.entries;
  // Research R16 m: Git stops `git remote` and every `%(upstream)` or `%(push)` read on such a value, so this check comes before read 3.
  if (invalidRemoteValue(entries)) return unavailable("invalid-config");

  const head = await settled(signal, captureHead(ctx.runner, ctx));
  if (isStop(head) || "code" in head) return head;
  if ("failed" in head) return { code: head.failed };
  const state = await settled(signal, ctx.reader.operationState(ctx, false));
  if (typeof state === "object") return "refused" in state ? { code: state.refused } : state;
  if (state === "canceled" || state === "deadline") return { stop: state };

  const remotes = await remoteList(ctx);
  if (!("value" in remotes)) return remotes;
  const bound = (b: Pick<SyncBinding, "remotes" | "destination" | "lease">): Observation => ({
    binding: { payload, head, operationState: state, trust: { fingerprint: listing.fingerprint, sync: listing.approvalRequired.sync }, ...b },
    entries,
  });
  const branch = head.state !== "detached" && head.target.startsWith(HEADS) ? head.target.slice(HEADS.length) : null;

  if (payload.action === "fetch") {
    if (payload.remote !== undefined) return remotes.value.includes(payload.remote) ? bound({ remotes: [payload.remote], destination: null, lease: null }) : { refused: "INVALID_REQUEST" };
    // Plan.md D3: `branch.<branch>.remote`, else `origin`, as git-fetch(1) selects without arguments.
    const configured = branch === null ? undefined : lastValue(entries, `branch.${branch}.remote`);
    if (configured === null) return unavailable("invalid-config");
    const remote = configured ?? "origin";
    if (remote === ".") return unavailable("local-upstream");
    if (!remotes.value.includes(remote)) return unavailable("remote-missing");
    return bound({ remotes: [remote], destination: null, lease: null });
  }
  if (payload.action === "fetch-all") {
    if (remotes.value.length === 0) return unavailable("no-remotes");
    return bound({ remotes: remotes.value.filter((remote) => !skipped(entries, remote)), destination: null, lease: null });
  }
  if (payload.action !== "push" && payload.action !== "force-push") throw new TypeError("review action not implemented");

  if (head.state === "unborn") return unavailable("unborn");
  if (head.state === "detached" || branch === null) return unavailable("detached");
  if (state !== "normal") return state === "unknown" ? { code: "GIT_FAILED" } : { refused: "OPERATION_IN_PROGRESS" };
  const recordOut = await readOut(ctx, pushRecordArgs(branch), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in recordOut) return { code: "OUTPUT_LIMIT" };
  if (!("value" in recordOut)) return recordOut;
  const record = parsePushRecord(recordOut.value, branch, w.objectFormat);
  if (record === null) return { code: "MALFORMED_GIT_OUTPUT" };
  // HEAD names this branch, so a missing record means that it changed during the review.
  if (record === "absent") return { code: "GIT_FAILED" };

  let destination: Omit<BoundDestination, "url">;
  const choice = payload.action === "push" ? payload.destination : undefined;
  if (choice !== undefined) {
    const ref = `${HEADS}${choice.branch}`;
    if (!remotes.value.includes(choice.remote) || !isRefName(ref)) return { refused: "INVALID_REQUEST" };
    if (mirrored(entries, choice.remote)) return unavailable("mirror");
    destination = { remote: choice.remote, ref, trackingRef: null, setUpstream: choice.setUpstream, source: "panel" };
  } else {
    const decision = decidePushDestination(record, remotes.value, entries);
    if (decision.kind === "refused") return unavailable(decision.reason);
    if (decision.kind === "panel") {
      if (payload.action === "force-push") return unavailable("no-lease");
      if (remotes.value.length === 0) return unavailable("no-remotes");
      const prefill = decision.prefill === null ? null : { remote: decision.prefill.remote, ref: decision.prefill.ref };
      return { panel: { remotes: remotes.value, prefill, setUpstream: record.upstream === "" }, operationState: state };
    }
    destination = { ...decision.destination, setUpstream: false };
  }

  // O-11: exactly one push URL.
  const urlOut = await readOut(ctx, pushUrlArgs(destination.remote), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in urlOut) return { code: "OUTPUT_LIMIT" };
  if (!("value" in urlOut)) return urlOut;
  const urls = parsePushUrls(urlOut.value);
  if (urls === null) return { code: "MALFORMED_GIT_OUTPUT" };
  if ("reason" in urls) return unavailable(urls.reason);

  let lease: Lease | null = null;
  if (payload.action === "force-push") {
    // Plan.md D5: a destination without a tracking ref, such as a triangular one, has no lease.
    if (destination.trackingRef === null) return unavailable("no-lease");
    const read = await leaseOf(ctx, destination.trackingRef, head.oid);
    if (!("value" in read)) return read;
    lease = read.value;
  }
  return bound({ remotes: [destination.remote], destination: { ...destination, url: urls.url }, lease });
}

// Contract Δ3 `reviewSync` result: the data-model §2 fields for display. The URL shows without user information.
export function planOf(b: Pick<SyncBinding, "remotes" | "destination" | "lease" | "operationState">) {
  const d = b.destination;
  return {
    remotes: b.remotes,
    ...(d === null ? {} : { destination: { remote: d.remote, ref: d.ref, trackingRef: d.trackingRef, url: redactUrlUserInfo(d.url), setUpstream: d.setUpstream, source: d.source } }),
    ...(b.lease === null ? {} : { lease: b.lease }),
    ...operationStateOf(b.operationState),
  };
}

const operationStateOf = (state: OperationState) => (state === "merging" || state === "rebasing" ? { operationState: state } : {});

// The read outcome forms of `session.ts`.
export type ReviewOutcome =
  | { result: "succeeded"; value: unknown }
  | { result: "failed"; code: ErrorCode; value?: unknown }
  | { result: "canceled" }
  | { result: "deadline" };

export interface SyncReviewerOptions extends Pick<HistoryReaderOptions, "listingTuple"> {
  runner: ObserveContext["runner"];
  trust: ObserveContext["trust"];
  reader: ObserveContext["reader"];
  approvals: Approvals;
}

export function createSyncReviewer(o: SyncReviewerOptions) {
  return {
    // Contract Δ3 `reviewSync`. A refusal issues no token.
    async reviewSync(t: ReadHistoryTarget, payload: ReviewPayload): Promise<ReviewOutcome> {
      const ctx: ObserveContext = { runner: o.runner, trust: o.trust, reader: o.reader, operationId: t.operationId, signal: t.signal, workspace: t.workspace, installation: t.installation };
      const observed = await observeSync(ctx, payload, () => sharedListing({ trust: o.trust, listingTuple: o.listingTuple }, t));
      if (isStop(observed)) return { result: observed.stop };
      if ("code" in observed) return { result: "failed", code: observed.code };
      if ("refused" in observed) return { result: "failed", code: observed.refused, ...(observed.reason === undefined ? {} : { value: { reason: observed.reason } }) };
      if ("panel" in observed) return { result: "succeeded", value: { action: payload.action, plan: { remotes: observed.panel.remotes, ...operationStateOf(observed.operationState), needsDestination: observed.panel } } };
      const syncReviewToken = crypto.randomUUID();
      o.approvals.issue({ kind: "sync", reviewToken: syncReviewToken, repositoryId: t.workspace.repositoryId, generation: t.generation, binding: observed.binding });
      return { result: "succeeded", value: { action: payload.action, plan: planOf(observed.binding), syncReviewToken } };
    },
  };
}

export type SyncReviewer = ReturnType<typeof createSyncReviewer>;
