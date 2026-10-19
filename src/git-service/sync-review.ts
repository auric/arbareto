// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 003 contract Δ3 `reviewSync` reads 1 to 9, data-model §2 and §3, and plan.md D3 to D7.
// `sync` runs the same reads again with the bound payload (contract Δ3 `sync` step 2). No read contacts a remote.

import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { ServiceRequest } from "../contracts/envelope";
import type { ErrorCode, SyncUnavailableReason } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS, SYNC_LEASE_COMMITS, SYNC_REBASE_TODO_BYTES, SYNC_REFS_BYTES, SYNC_REFS_RECORDS, SYNC_REMOTES } from "../contracts/limits";
import { buildRemedyCommand } from "../contracts/remedy-command";
import { redactUrlUserInfo } from "../contracts/submodules";
import { wslIdentityPath } from "../contracts/wsl-route";
import type { Approvals } from "./approvals";
import { batchCommandArgs, isObjectId, isRefName, type ObjectFormat } from "./commands";
import { createCollector, isChannelPath } from "./git-runner";
import { captureHead, sharedListing, type HistoryReaderOptions, type ReadHistoryTarget } from "./history";
import { objectStream } from "./history-view";
import { isStop, settled, stepOf, type Fact, type Failure, type ObserveContext, type Stop } from "./hunk-publish";
import { isMissing } from "./read-steps";
import type { Head, OperationState } from "./snapshot";
import { gitPathArgs, indexStageArgs, leaseCommitsArgs, leaseCountArgs, pushRecordArgs, pushUrlArgs, rebaseHeadArgs, rebaseHeadExistsArgs, remoteListArgs, syncRefsArgs } from "./sync-commands";
import { autoSetupRemote, decidePull, decidePushDestination, holdsExec, invalidRemoteValue, parsePushRecord, parsePushUrls, parseRebaseHead, parseRevListCount, upstreamRebase, type PushDestination } from "./sync-parsers";
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
  // Contract Δ3 Set upstream: true when a selected Set upstream also writes `branch.<name>.rebase`.
  upstreamRebase: boolean;
  source: PushDestination["source"] | "panel";
}

export interface Lease {
  trackingRef: string;
  expect: string;
  count: number;
  commits: { objectId: string; subject: string | null }[];
}

// Contract Δ3 read 7. `fingerprint` is the SHA-256 of the `ls-files --stage -z` listing. `unmerged` counts the paths with a stage above 0.
export interface IndexState {
  fingerprint: string;
  unmerged: number;
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
  // `pull` and `integrate`. `objectId` is null before a pull fetches the ref.
  upstream?: { ref: string; objectId: string | null };
  // `continue`.
  index?: IndexState;
  // `skip`: the `REBASE_HEAD` commit.
  skippedCommit?: { objectId: string; subject: string | null };
  // `continue` and `skip` while rebasing: the SHA-256 of `rebase-merge/git-rebase-todo`, or null without that file.
  todo?: string | null;
  // `pull` and `integrate`: the last value of each `MODE_KEYS` key. A key without an entry is absent.
  modeConfig?: Record<string, string | null>;
}

export interface NeedsDestination {
  remotes: string[];
  prefill: { remote: string; ref: string } | null;
  setUpstream: boolean;
  // The panel names `branch.<name>.rebase` among the Set upstream keys when it is true (FR-016).
  upstreamRebase: boolean;
}

// `entries`: the configuration of the read, for the upstream values of a push and the URLs of a remedy.
export type Observation =
  | { binding: SyncBinding; entries: readonly ConfigEntry[] }
  | { panel: NeedsDestination; operationState: OperationState }
  | { refused: ErrorCode; reason?: SyncUnavailableReason | "SYNC_REMOTES"; unmerged?: number; remedy?: { text: string; command: string | null } }
  | Stop
  | Failure;

type Bound = Pick<SyncBinding, "remotes" | "destination" | "lease" | "upstream" | "index" | "skippedCommit" | "todo" | "modeConfig">;

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

// git-ls-files(1) `--stage`: `<mode> SP <object> SP <stage> TAB <path>`.
const STAGE_RECORD = /^[0-7]{6} [0-9a-f]+ ([0-3])\t([\s\S]+)$/;

// Contract Δ3 read 7. The listing reads only the index, so it takes the status listing bounds.
export async function indexState(ctx: ObserveContext): Promise<Fact<IndexState>> {
  const out = createCollector({ maxBytes: STATUS_LISTING_BYTES, maxRecords: STATUS_LISTING_RECORDS, separator: 0x00 });
  const step = await stepOf(ctx, indexStageArgs(), out);
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT", reason: out.records > STATUS_LISTING_RECORDS ? "STATUS_LISTING_RECORDS" : "STATUS_LISTING_BYTES" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const bytes = out.take();
  const text = Buffer.from(bytes).toString("latin1");
  if (text !== "" && !text.endsWith("\0")) return { code: "MALFORMED_GIT_OUTPUT" };
  const unmerged = new Set<string>();
  for (const record of text === "" ? [] : text.slice(0, -1).split("\0")) {
    const m = STAGE_RECORD.exec(record);
    if (m === null) return { code: "MALFORMED_GIT_OUTPUT" };
    if (m[1] !== "0") unmerged.add(m[2]!);
  }
  return { value: { fingerprint: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), unmerged: unmerged.size } };
}

// The OS fact of one Git-resolved path, as the 001 markers read it (status.ts `markerFacts`). Contract §11: a WSL path takes its UNC form.
async function gitPathOf(ctx: ObserveContext, name: string): Promise<Fact<string>> {
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const step = await stepOf(ctx, gitPathArgs(name), out);
  if (!("exit" in step)) return step;
  if (out.limited || step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  let text: string;
  try {
    text = exact.decode(out.take());
  } catch {
    return { code: "MALFORMED_GIT_OUTPUT" };
  }
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return { code: "MALFORMED_GIT_OUTPUT" };
  const wsl = ctx.workspace.wsl;
  const path = wsl === undefined ? text.slice(0, -1) : wslIdentityPath(wsl.distro, text.slice(0, -1));
  return path === null || !isChannelPath(path) ? { code: "MALFORMED_GIT_OUTPUT" } : { value: path };
}

export async function gitPathExists(ctx: ObserveContext, name: string): Promise<Fact<boolean>> {
  const path = await gitPathOf(ctx, name);
  if (!("value" in path)) return path;
  try {
    await stat(path.value);
    return { value: true };
  } catch (error) {
    return isMissing(error) ? { value: false } : { code: "GIT_FAILED" };
  }
}

// Plan.md D7: the todo of a merge-backend rebase. Null: no todo file, as for the apply backend. `exec`: an `exec` line remains.
// `unreadable`: the file cannot be read within the bound.
async function rebaseTodo(ctx: ObserveContext): Promise<Fact<{ digest: string | null; exec: boolean } | { unreadable: true }>> {
  const path = await gitPathOf(ctx, "rebase-merge/git-rebase-todo");
  if (!("value" in path)) return path;
  let handle;
  try {
    handle = await open(path.value, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return { value: isMissing(error) ? { digest: null, exec: false } : { unreadable: true } };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > SYNC_REBASE_TODO_BYTES) return { value: { unreadable: true } };
    const buffer = Buffer.alloc(SYNC_REBASE_TODO_BYTES + 1);
    let size = 0;
    for (let n = -1; n !== 0 && size < buffer.length; size += n) n = (await handle.read(buffer, size, buffer.length - size, null)).bytesRead;
    if (size > SYNC_REBASE_TODO_BYTES) return { value: { unreadable: true } };
    const bytes = buffer.subarray(0, size);
    return { value: { digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), exec: holdsExec(bytes) } };
  } catch {
    return { value: { unreadable: true } };
  } finally {
    await handle.close();
  }
}

// Contract §4 "Quoting rule": the terminal command of a refused Continue or Skip. A WSL Git or no selected Git gives text only.
export const REBASE_EXEC_TEXT = "This rebase holds exec lines, and Git runs them as shell commands. Arbareto does not run them. Read the todo list, then continue in a terminal.";
export const REBASE_TODO_UNREADABLE_TEXT = "Arbareto cannot read the rebase todo list. Continue in a terminal.";
function terminalRemedy(ctx: ObserveContext, action: "continue" | "skip", text: string): { text: string; command: string | null } {
  const git = ctx.installation.selectedPath;
  if (git === null || ctx.workspace.wsl !== undefined) return { text, command: null };
  const built = buildRemedyCommand(`& {git} --no-lazy-fetch -C {root} rebase --${action}`, {
    git: { kind: "gitPath", text: git, form: "windows" },
    root: { kind: "worktreeRoot", text: ctx.workspace.worktreeRoot, form: "windows" },
  });
  return { text, command: built.command };
}

// Contract Δ3 read 8: REBASE_HEAD names the commit at which the rebase stopped (gitrevisions(7)). The subject comes from the read 6 reader.
async function rebaseHead(ctx: ObserveContext): Promise<Fact<{ objectId: string; subject: string | null }> | { refused: ErrorCode; reason: SyncUnavailableReason }> {
  const objectFormat = ctx.workspace.objectFormat;
  const exists = await stepOf(ctx, rebaseHeadExistsArgs(), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
  if (!("exit" in exists)) return exists;
  // git-show-ref(1) `--exists`: status 2 for a missing reference.
  if (exists.exit.exitCode === 2) return { refused: "SYNC_UNAVAILABLE", reason: "no-skip-commit" };
  if (exists.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const verified = await readOut(ctx, rebaseHeadArgs(), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in verified) return { code: "MALFORMED_GIT_OUTPUT" };
  if (!("value" in verified)) return verified;
  const oid = parseRebaseHead(verified.value, objectFormat);
  if (oid === null) return { code: "MALFORMED_GIT_OUTPUT" };
  const stream = objectStream([oid], objectFormat);
  const step = await stepOf(ctx, batchCommandArgs(), stream, new TextEncoder().encode(`contents ${oid}\0`));
  if (!("exit" in step)) return step;
  const answers = stream.result();
  if (answers === "MALFORMED_GIT_OUTPUT") return { code: step.exit.exitCode !== 0 && !stream.limited ? "GIT_FAILED" : "MALFORMED_GIT_OUTPUT" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const answer = answers[0]!;
  if (answer === "missing") return { code: "OBJECT_MISSING" };
  return { value: { objectId: oid, subject: answer === "large" ? null : answer.subject } };
}

// Plan.md D7. The kind comes from the 001 markers. `unknown` (`rebase-apply/applying`, or a marker without a fact) gets no action.
// Every rebase stop offers Continue and Skip: builtin/rebase.c `init_basic_state` writes `rebase-merge/interactive` for every merge-backend rebase, so that file decides nothing.
async function observeConflictAction(ctx: ObserveContext, action: "abort" | "continue" | "skip", state: OperationState, bound: (b: Bound) => Observation): Promise<Observation> {
  const none = { remotes: [], destination: null, lease: null };
  if (state === "unknown") return unavailable("unknown-operation");
  if (state !== "merging" && state !== "rebasing") return unavailable("no-operation");
  if (action === "skip" && state === "merging") return unavailable("not-rebasing");
  // Repository content is untrusted, so a remaining `exec` line refuses Continue and Skip. Abort runs no todo line.
  let todo: { todo: string | null } | Record<string, never> = {};
  if (state === "rebasing" && action !== "abort") {
    const read = await rebaseTodo(ctx);
    if (!("value" in read)) return read;
    if ("unreadable" in read.value) return { refused: "SYNC_UNAVAILABLE", reason: "rebase-exec", remedy: terminalRemedy(ctx, action, REBASE_TODO_UNREADABLE_TEXT) };
    if (read.value.exec) return { refused: "SYNC_UNAVAILABLE", reason: "rebase-exec", remedy: terminalRemedy(ctx, action, REBASE_EXEC_TEXT) };
    todo = { todo: read.value.digest };
  }
  if (action === "continue") {
    const index = await indexState(ctx);
    if (!("value" in index)) return index;
    if (index.value.unmerged > 0) return { refused: "CONFLICTED", unmerged: index.value.unmerged };
    return bound({ ...none, ...todo, index: index.value });
  }
  if (action === "skip") {
    const skipped = await rebaseHead(ctx);
    if (!("value" in skipped)) return skipped;
    return bound({ ...none, ...todo, skippedCommit: skipped.value });
  }
  return bound(none);
}

// Data-model §2 `modeConfig`: `decidePull` reads `pull.ff`, `branch.<name>.rebase`, and `pull.rebase`. Git's merge reads `merge.ff`.
const MODE_KEYS = (branch: string) => ["pull.ff", "pull.rebase", `branch.${branch}.rebase`, "merge.ff"];

// Plan.md D6 step 1 and data-model §6. 001 FR-016 delta: a merge or a rebase in progress refuses pull and integrate first.
async function observePull(ctx: ObserveContext, payload: Extract<ReviewPayload, { action: "pull" | "integrate" }>, f: { head: Head; state: OperationState; remotes: string[]; entries: readonly ConfigEntry[]; branch: string | null }, bound: (b: Bound) => Observation): Promise<Observation> {
  const { head, state, entries } = f;
  if (state !== "normal") return state === "unknown" ? unavailable("unknown-operation") : { refused: "OPERATION_IN_PROGRESS" };
  if (head.state === "unborn") return unavailable("unborn");
  if (head.state === "detached" || f.branch === null) return unavailable("detached");
  const branch = f.branch;
  const remote = lastValue(entries, `branch.${branch}.remote`);
  const merges = entries.filter((e) => e.key === `branch.${branch}.merge`).length;
  // remote.c `set_merge`: Git sets no upstream without both values.
  if (remote === undefined || merges === 0) return unavailable("no-upstream");
  if (remote === null) return unavailable("invalid-config");
  if (merges > 1) return unavailable("several-merge-refs");
  if (remote === ".") return unavailable("local-upstream");
  if (!f.remotes.includes(remote)) return unavailable("remote-missing");
  // builtin/pull.c `config_get_ff` and `config_get_rebase` stop Git's pull before its fetch. Behind 0 decides no mode, so only these refusals remain.
  const config = decidePull({ ahead: 0, behind: 0, branch, mode: payload.mode ?? null, config: entries });
  if (config.kind === "refused") return unavailable(config.reason);
  const recordOut = await readOut(ctx, pushRecordArgs(branch), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in recordOut) return { code: "OUTPUT_LIMIT" };
  if (!("value" in recordOut)) return recordOut;
  const record = parsePushRecord(recordOut.value, branch, ctx.workspace.objectFormat);
  if (record === null) return { code: "MALFORMED_GIT_OUTPUT" };
  if (record === "absent") return { code: "GIT_FAILED" };
  // No fetch refspec maps `branch.<name>.merge` to a remote-tracking ref.
  if (record.upstream === "") return unavailable("no-upstream");
  const refs = await listRefs(ctx, record.upstream);
  if (!("value" in refs)) return refs;
  const objectId = refs.value.get(refKey(record.upstream)) ?? null;
  // A pull fetches the ref first. `integrate` has no fetch.
  if (objectId === null && payload.action === "integrate") return unavailable("upstream-gone");
  const modeConfig = Object.fromEntries(MODE_KEYS(branch).flatMap((key) => {
    const value = lastValue(entries, key);
    return value === undefined ? [] : [[key, value]];
  }));
  return bound({ remotes: [remote], destination: null, lease: null, upstream: { ref: record.upstream, objectId }, modeConfig });
}

// Contract Δ3 `reviewSync` reads 1 to 8. `list` gives the trust listing: shared or own for a review, own for `sync`.
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
  const bound = (b: Bound): Observation => ({
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
  if (payload.action === "abort" || payload.action === "continue" || payload.action === "skip") return observeConflictAction(ctx, payload.action, state, bound);
  if (payload.action === "pull" || payload.action === "integrate") return observePull(ctx, payload, { head, state, remotes: remotes.value, entries, branch }, bound);

  if (head.state === "unborn") return unavailable("unborn");
  if (head.state === "detached" || branch === null) return unavailable("detached");
  if (state !== "normal") return state === "unknown" ? unavailable("unknown-operation") : { refused: "OPERATION_IN_PROGRESS" };
  const recordOut = await readOut(ctx, pushRecordArgs(branch), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in recordOut) return { code: "OUTPUT_LIMIT" };
  if (!("value" in recordOut)) return recordOut;
  const record = parsePushRecord(recordOut.value, branch, w.objectFormat);
  if (record === null) return { code: "MALFORMED_GIT_OUTPUT" };
  // HEAD names this branch, so a missing record means that it changed during the review.
  if (record === "absent") return { code: "GIT_FAILED" };
  // Contract Δ3 Set upstream. Git refuses such an entry in every command, so it cannot reach a push.
  const rebase = upstreamRebase(entries);
  if (rebase === null) return unavailable("invalid-config");
  // `git push` reads `push.autoSetupRemote` also for an explicit refspec.
  if (autoSetupRemote(entries) === null) return unavailable("invalid-config");

  let destination: Omit<BoundDestination, "url">;
  const choice = payload.action === "push" ? payload.destination : undefined;
  if (choice !== undefined) {
    const ref = `${HEADS}${choice.branch}`;
    if (!remotes.value.includes(choice.remote) || !isRefName(ref)) return { refused: "INVALID_REQUEST" };
    if (mirrored(entries, choice.remote)) return unavailable("mirror");
    destination = { remote: choice.remote, ref, trackingRef: null, setUpstream: choice.setUpstream, upstreamRebase: choice.setUpstream && rebase, source: "panel" };
  } else {
    const decision = decidePushDestination(record, remotes.value, entries);
    if (decision.kind === "refused") return unavailable(decision.reason);
    if (decision.kind === "panel") {
      if (payload.action === "force-push") return unavailable("no-lease");
      if (remotes.value.length === 0) return unavailable("no-remotes");
      const prefill = decision.prefill === null ? null : { remote: decision.prefill.remote, ref: decision.prefill.ref };
      return { panel: { remotes: remotes.value, prefill, setUpstream: record.upstream === "", upstreamRebase: rebase }, operationState: state };
    }
    destination = { ...decision.destination, setUpstream: false, upstreamRebase: false };
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
export function planOf(b: SyncBinding) {
  const d = b.destination;
  const p = b.payload;
  return {
    remotes: b.remotes,
    ...(b.upstream?.objectId == null ? {} : { upstream: { ref: b.upstream.ref, objectId: b.upstream.objectId } }),
    ...(d === null ? {} : { destination: { remote: d.remote, ref: d.ref, trackingRef: d.trackingRef, url: redactUrlUserInfo(d.url), setUpstream: d.setUpstream, upstreamRebase: d.upstreamRebase, source: d.source } }),
    ...(b.lease === null ? {} : { lease: b.lease }),
    ...(p.action === "pull" || p.action === "integrate" ? { mode: p.mode ?? null } : {}),
    ...operationStateOf(b.operationState),
    ...(b.skippedCommit === undefined ? {} : { skippedCommit: b.skippedCommit }),
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
      if ("refused" in observed) {
        const value = {
          ...(observed.reason === undefined ? {} : { reason: observed.reason }),
          ...(observed.unmerged === undefined ? {} : { unmerged: observed.unmerged }),
          ...(observed.remedy === undefined ? {} : { remedy: observed.remedy }),
        };
        return { result: "failed", code: observed.refused, ...(Object.keys(value).length === 0 ? {} : { value }) };
      }
      if ("panel" in observed) return { result: "succeeded", value: { action: payload.action, plan: { remotes: observed.panel.remotes, ...operationStateOf(observed.operationState), needsDestination: observed.panel } } };
      const syncReviewToken = crypto.randomUUID();
      o.approvals.issue({ kind: "sync", reviewToken: syncReviewToken, repositoryId: t.workspace.repositoryId, generation: t.generation, binding: observed.binding });
      return { result: "succeeded", value: { action: payload.action, plan: planOf(observed.binding), syncReviewToken } };
    },
  };
}

export type SyncReviewer = ReturnType<typeof createSyncReviewer>;
