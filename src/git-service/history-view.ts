// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 002 plan.md P3, P5, D2, D3, and D5. Contract Δ3 `openHistory`, `loadHistory`, `readHistoryRows`, `searchHistory`, and `closeHistory`, Δ5 bounds, Δ8 freshness.
// Data-model §1 history view, §2 captured ref set, §5 history row, §6 message search. One view per service session.

import type { RefEntry, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode, HistoryChangedReason, HistoryOutputLimitReason } from "../contracts/errors";
import { filterText } from "../contracts/filter-text";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  FILTER_TEXT_BYTES,
  HISTORY_COMMIT_OBJECT_BYTES,
  HISTORY_LOAD_MARGIN,
  HISTORY_PAGE_BYTES,
  HISTORY_PROCESS_DEADLINE_MS,
  HISTORY_PROGRESS_EVENTS_PER_SECOND,
  HISTORY_TEXT_DEADLINE_MS,
  REF_LISTING_BYTES,
  REF_LISTING_RECORDS,
  SHALLOW_METADATA_BYTES,
} from "../contracts/limits";
import { MATCHING_PROBE_RUNS } from "../contracts/matching-probe";
import { NATIVE } from "../contracts/native-path";
import { buildRemedyCommand } from "../contracts/remedy-command";
import { batchCommandArgs, historyLoadArgs, historyRefsArgs, historySearchArgs, isObjectId, replaceRefsArgs, topologyPathArgs, type ObjectFormat } from "./commands";
import { createCollector, isChannelPath, RunnerRefusal, type Collector, type GitExit, type GitRunner } from "./git-runner";
import { captureHead, checkFailedRead, commitTextOf, DAMAGED_STORE_REMEDY, isStop, readShallow, sharedListing, type CommitText, type HistoryReaderOptions, type Shallow, type Stop } from "./history";
import { HistoryLayout } from "./history-layout";
import { HEADER_BYTES, readHeaders } from "./history-parser";
import { MATCHING_REMEDY, matchStream, probeMatching, SearchMerge, WSL_MATCHING_REMEDY, type ProbeRun } from "./history-search";
import { HistoryTopology, type TopologyFailure } from "./history-topology";
import type { OperationRegistry } from "./operations";
import { contextOf, encodedBytes, readBounded, runRead } from "./read-steps";
import { parseHistoryRefs } from "./refs-parser";
import type { Workspace } from "./registration";
import type { Head, ReadInstallation } from "./snapshot";
import { hasPromisor, OBJECT_MISSING_REMEDY } from "./status";
import type { Trust, TrustListing } from "./trust";

type Request<K extends ServiceRequest["operation"]> = Extract<ServiceRequest, { operation: K }>;
type ProcessTarget = { operationId: string; signal: AbortSignal; workspace: Workspace };
export type OpenTarget = ProcessTarget & { installation: ReadInstallation; generation: number };

// The outcome forms that `session.ts` turns into registry events.
export type ViewOutcome = { result: "succeeded" | "limited" | "failed"; code?: ErrorCode; value?: unknown } | { result: "canceled"; value?: unknown } | { result: "deadline"; value?: unknown };

type ViewReason = HistoryChangedReason | HistoryOutputLimitReason | "object-missing" | "REF_LISTING_RECORDS" | "REF_LISTING_BYTES";
type Remedy = { text: string; command: string | null };
type Stale = { code: ErrorCode; reason?: ViewReason; remedy?: Remedy };
type Label = { kind: RefEntry["kind"]; name: string; invalidUtf8: boolean };
// Data-model §2 `fingerprint`: the SHA-256 of each file or `absent`, and the SHA-256 of the `refs/replace/` records.
type Fingerprint = { shallow: string; grafts: string; replace: string };

export interface HistoryViewsOptions {
  runner: GitRunner;
  trust: Trust;
  listingTuple: HistoryReaderOptions["listingTuple"];
  markUnavailable(repositoryId: string): void;
  registry: OperationRegistry;
  // Contract Δ5 `HISTORY_VIEW_COMMITS`. Only tests set a lower value.
  viewCommits: number;
  // Contract Δ3 "Matching probe": the probe commits that each run must list. Only tests set other sets.
  probeRuns?: readonly ProbeRun[];
  reject(requestId: string, code: ErrorCode): void;
}

// Data-model §6: the one search of a view. Its `operationId` is the `searchId` (contract Δ2).
interface Search {
  operationId: string;
  merge: SearchMerge;
  running: boolean;
  // Settles when the operation ends.
  done: Promise<void>;
  // Merges the rows that the view serves into the match order.
  update(): void;
}

interface View {
  viewId: string;
  workspace: Workspace;
  installation: ReadInstallation;
  scope: "all" | "current";
  generation: number;
  head: Head;
  labels: Map<string, Label[]>;
  starts: string[];
  paths: { shallow: string; grafts: string };
  fingerprint: Fingerprint;
  shallow: Shallow;
  listing: TrustListing;
  topology: HistoryTopology;
  layout: HistoryLayout;
  // The rows that the view serves. They passed the fingerprint check of their load (contract Δ3 `loadHistory`).
  rows: number;
  complete: boolean;
  limit: HistoryOutputLimitReason | null;
  stale: Stale | null;
  load: string | null;
  text: string | null;
  search: Search | null;
  operations: Set<string>;
  waiters: Set<() => void>;
  released: boolean;
}

const LF = 0x0a;
const NUL = 0x00;
const ABSENT = "absent";
// Contract Δ3 `loadHistory`: the read-ahead below the last needed row.
const MARGIN = 2 * HISTORY_LOAD_MARGIN;
const PROGRESS_MS = 1000 / HISTORY_PROGRESS_EVENTS_PER_SECOND;
const HEX: Record<ObjectFormat, RegExp> = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };
// gitdoc git-cat-file "BATCH OUTPUT": `<oid> SP <type> SP <size>`, or `<oid> SP missing`.
const FOUND = /^([0-9a-f]+) commit (0|[1-9][0-9]*)$/;
const MISSING = /^([0-9a-f]+) missing$/;
const DEADLINE_TEXT = "Git did not finish this history read before its deadline. A commit-graph file makes the read faster. Run this command in a terminal to write one, then load the history again.";

const small = () => createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const failed = (code: ErrorCode, value: object = {}): ViewOutcome => ({ result: "failed", code, value });
// Contract Δ3: Git gets the start points on stdin, one per line.
const startInput = (starts: readonly string[]) => (starts.length === 0 ? {} : { input: new TextEncoder().encode(starts.map((oid) => `${oid}\n`).join("")) });

// One read-policy Git step. A runner refusal gives its code, and an abort gives `canceled`.
async function step(runner: GitRunner, t: ProcessTarget, args: string[], stdout: Collector): Promise<GitExit | Stop> {
  if (t.signal.aborted) return { stop: "canceled" };
  try {
    const ran = await runRead(runner, t, args, stdout);
    if (t.signal.aborted) return { stop: "canceled" };
    if ("refused" in ran) return { failed: ran.refused };
    if (ran.exit.deadline !== undefined) return { stop: "deadline" };
    // Contract §9: unexpected diagnostic output above 4 MiB ends a read `failed` with OUTPUT_LIMIT.
    if (ran.exit.diagnosticLimit) return { failed: "OUTPUT_LIMIT" };
    return ran.exit;
  } catch (error) {
    if (t.signal.aborted) return { stop: "canceled" };
    throw error;
  }
}

// Contract Δ3 capture step 2: the records of `historyRefsArgs` or `replaceRefsArgs`. A limited collector stops the process.
async function readRecords(runner: GitRunner, t: ProcessTarget, args: string[]): Promise<NonNullable<ReturnType<typeof parseHistoryRefs>> | Stop | { limit: "REF_LISTING_RECORDS" | "REF_LISTING_BYTES" }> {
  const out = createCollector({ maxBytes: REF_LISTING_BYTES, maxRecords: REF_LISTING_RECORDS, separator: LF });
  const exit = await step(runner, t, args, out);
  if (isStop(exit)) return exit;
  const bytes = out.take();
  // Contract §5: the first reached bound wins, also over a later Git failure. The kept bytes hold every record that the record bound let pass (`refs.ts`).
  if (out.limited) return { limit: bytes.filter((byte) => byte === LF).length >= REF_LISTING_RECORDS ? "REF_LISTING_RECORDS" : "REF_LISTING_BYTES" };
  if (exit.exitCode !== 0) return { failed: "GIT_FAILED" };
  return parseHistoryRefs(bytes, t.workspace.objectFormat) ?? { failed: "MALFORMED_GIT_OUTPUT" };
}

// Contract Δ3 capture step 3: two LF-ended paths, relative to the worktree root, where Git ran.
async function topologyPaths(runner: GitRunner, t: ProcessTarget): Promise<{ shallow: string; grafts: string } | Stop> {
  const out = small();
  const exit = await step(runner, t, topologyPathArgs(), out);
  if (isStop(exit)) return exit;
  if (exit.exitCode !== 0) return { failed: "GIT_FAILED" };
  let text = "";
  try {
    if (!out.limited) text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(out.take());
  } catch {
    return { failed: "MALFORMED_GIT_OUTPUT" };
  }
  const lines = text.split("\n");
  if (lines.length !== 3 || lines[2] !== "" || lines.slice(0, 2).some((l) => l === "")) return { failed: "MALFORMED_GIT_OUTPUT" };
  const [shallow, grafts] = lines.slice(0, 2).map((line) => NATIVE.path.resolve(t.workspace.worktreeRoot, line)) as [string, string];
  if (!isChannelPath(shallow) || !isChannelPath(grafts)) return { failed: "MALFORMED_GIT_OUTPUT" };
  return { shallow, grafts };
}

// The file part of the topology fingerprint. Both files use the 4 MiB bound (contract Δ3 capture step 3).
async function fileFingerprint(paths: { shallow: string; grafts: string }, objectFormat: ObjectFormat): Promise<{ shallow: Shallow; grafts: string } | Stop> {
  const [shallow, grafts] = await Promise.all([readShallow(paths.shallow, objectFormat), readBounded(paths.grafts, SHALLOW_METADATA_BYTES)]);
  if (isStop(shallow)) return shallow;
  // shortcut: the contract gives no view reason for a topology file above 4 MiB, so the refusal is OUTPUT_LIMIT without a reason. Add a reason when the contract names one.
  if (shallow.kind === "over" || grafts === "over") return { failed: "OUTPUT_LIMIT" };
  if (grafts === "unavailable") return { failed: "REPOSITORY_UNAVAILABLE" };
  return { shallow, grafts: grafts === "absent" ? ABSENT : sha256(grafts) };
}

const shallowDigest = (shallow: Shallow) => (shallow.kind === "file" ? shallow.fingerprint : ABSENT);

// A streamed `cat-file --batch-command -Z` answer with one `contents <oid>` command per OID (gitdoc git-cat-file "-Z").
// Content above HISTORY_COMMIT_OBJECT_BYTES is counted but not kept. A malformed answer stops the process through `limited`.
function objectStream(oids: readonly string[], objectFormat: ObjectFormat) {
  const answers: (CommitText | "large" | "missing")[] = [];
  let broken = false;
  let header: number[] = [];
  let size = -1;
  let filled = 0;
  let content: Uint8Array | null = null;
  let bytes = 0;
  const fail = () => {
    broken = true;
  };
  const onHeader = () => {
    const text = Buffer.from(header).toString("latin1");
    header = [];
    const oid = oids[answers.length];
    const missing = MISSING.exec(text);
    if (missing !== null) {
      if (missing[1] !== oid) return fail();
      answers.push("missing");
      return;
    }
    const found = FOUND.exec(text);
    if (found === null || found[1] !== oid) return fail();
    size = Number(found[2]);
    filled = 0;
    content = size <= HISTORY_COMMIT_OBJECT_BYTES ? new Uint8Array(size) : null;
  };
  const onContent = () => {
    if (content === null) answers.push("large");
    else {
      const headers = readHeaders(content, HEX[objectFormat]);
      const text = headers === null ? null : commitTextOf({ content, encoding: headers.encoding });
      if (text === null) return fail();
      answers.push(text);
    }
    size = -1;
    content = null;
  };
  return {
    push(chunk: Uint8Array): void {
      bytes += chunk.length;
      for (let at = 0; at < chunk.length && !broken; ) {
        if (answers.length === oids.length) return fail();
        if (size < 0) {
          const nul = chunk.indexOf(NUL, at);
          const end = nul === -1 ? chunk.length : nul;
          for (let i = at; i < end; i++) header.push(chunk[i]!);
          if (header.length > HEADER_BYTES) return fail();
          at = end;
          if (nul !== -1) {
            at++;
            onHeader();
          }
        } else if (filled < size) {
          const take = Math.min(size - filled, chunk.length - at);
          content?.set(chunk.subarray(at, at + take), filled);
          filled += take;
          at += take;
        } else {
          if (chunk[at] !== NUL) return fail();
          at++;
          onContent();
        }
      }
    },
    get bytes() {
      return bytes;
    },
    records: 0,
    get limited() {
      return broken;
    },
    // The answers in request order, or the failure. Every OID needs one answer, and no partial record may remain.
    result(): (CommitText | "large" | "missing")[] | "MALFORMED_GIT_OUTPUT" {
      if (broken || answers.length !== oids.length || size >= 0 || header.length > 0) return "MALFORMED_GIT_OUTPUT";
      return answers;
    },
  };
}

export function createHistoryViews({ runner, trust, listingTuple, markUnavailable, registry, viewCommits, probeRuns = MATCHING_PROBE_RUNS, reject }: HistoryViewsOptions) {
  let current: View | null = null;
  // Contract Δ3: the probe runs before the first search of each `gitInstallationId` in a service session. A failed probe gives no answer to keep.
  const probes = new Map<string, "pass" | "mismatch">();

  const notify = (view: View) => {
    for (const waiter of [...view.waiters]) waiter();
  };
  // Resolves at the next change of the view or at the abort.
  const change = (view: View, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        view.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      view.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });

  // Contract Δ3: a new `openHistory` and `closeHistory` release the view. Its running operations end `canceled`.
  function release(view: View | null): void {
    if (view === null || view.released) return;
    view.released = true;
    if (current === view) current = null;
    for (const operationId of [...view.operations]) registry.cancel(operationId);
    notify(view);
  }

  const find = (repositoryId: string, viewId: string): View | null => (current !== null && current.viewId === viewId && current.workspace.repositoryId === repositoryId ? current : null);

  const stale = (view: View, value: Stale): Stale => {
    view.stale ??= value;
    notify(view);
    return view.stale;
  };

  // Contract §7 "Missing objects": a missing object without a promisor remote means a damaged store.
  async function missing(view: View, t: ProcessTarget): Promise<Stale | "canceled" | "deadline"> {
    const w = view.workspace;
    const promisor = await hasPromisor(view.listing.entries, w, (paths) => runner.identities(t.operationId, contextOf(w), paths, t.signal));
    if (t.signal.aborted || promisor === "canceled") return "canceled";
    if (promisor === "deadline") return "deadline";
    if (promisor === "unknown") return { code: "GIT_FAILED" };
    if (!promisor) {
      markUnavailable(w.repositoryId);
      return { code: "REPOSITORY_UNAVAILABLE", remedy: { text: DAMAGED_STORE_REMEDY, command: null } };
    }
    return { code: "OBJECT_MISSING", reason: "object-missing", remedy: { text: OBJECT_MISSING_REMEDY, command: null } };
  }

  // Contract Δ3 `loadHistory` `DEADLINE`: the 001 commit-graph remedy with the selected Git path. A WSL view has no Windows command form.
  function deadlineRemedy(view: View): Remedy {
    const git = view.installation.selectedPath;
    if (view.workspace.wsl !== undefined || git === null) return { text: DEADLINE_TEXT, command: null };
    const built = buildRemedyCommand("& {git} --no-lazy-fetch -C {root} commit-graph write --reachable", {
      git: { kind: "gitPath", text: git, form: "windows" },
      root: { kind: "worktreeRoot", text: view.workspace.worktreeRoot, form: "windows" },
    });
    return { text: DEADLINE_TEXT, command: built.command };
  }

  const refusalOf = (s: Stale) => ({ ...(s.reason === undefined ? {} : { reason: s.reason }), ...(s.remedy === undefined ? {} : { remedy: s.remedy }) });

  // The capture steps of contract Δ3 `openHistory`. They run beside the trust listing.
  async function capture(t: ProcessTarget) {
    const [head, records, paths] = await Promise.all([captureHead(runner, t), readRecords(runner, t, historyRefsArgs()), topologyPaths(runner, t)]);
    if (t.signal.aborted) return { stop: "canceled" } as Stop;
    if (isStop(head)) return head;
    if (isStop(records) || "limit" in records) return records;
    if (isStop(paths)) return paths;
    const files = await fileFingerprint(paths, t.workspace.objectFormat);
    if (isStop(files)) return files;
    return { head, records, paths, files };
  }

  // Commits the parsed rows of a load whose fingerprint check passed, and steps the layout.
  function commit(view: View): void {
    if (view.released || view.rows === view.topology.rows) return;
    view.rows = view.topology.rows;
    view.layout.extend(view.rows);
    if (view.search?.running) view.search.update();
    notify(view);
  }

  // Contract Δ3: a nonzero Git exit runs the 001 `checkFailedRead` steps. `value` adds the fields of the operation result.
  async function failedRead(view: View, t: ProcessTarget, value: (extra?: object) => object): Promise<ViewOutcome> {
    const check = await checkFailedRead(runner, t, { anchors: view.starts, shallow: view.shallow, named: view.topology.knownOids(), objects: [], failedStep: "rev-list" });
    if (isStop(check)) {
      if ("failed" in check) return failed(check.failed, value(refusalOf(stale(view, { code: check.failed }))));
      return check.stop === "deadline" ? { result: "deadline", value: value({ remedy: deadlineRemedy(view) }) } : { result: "canceled", value: value() };
    }
    const found = await missing(view, t);
    if (found === "canceled") return { result: "canceled", value: value() };
    if (found === "deadline") return { result: "deadline", value: value({ remedy: deadlineRemedy(view) }) };
    const s = stale(view, found);
    return failed(s.code, value(refusalOf(s)));
  }

  // Contract Δ3 `loadHistory` and plan.md D2. `quiet`: the load of a search, whose progress the search sends.
  async function runLoad(view: View, need: Request<"loadHistory">["payload"]["need"], t: ProcessTarget, quiet = false): Promise<ViewOutcome> {
    const value = (extra: object = {}) => ({ rows: view.rows, complete: view.complete, ...extra });
    if (view.stale !== null) return failed(view.stale.code, value(refusalOf(view.stale)));
    if (view.limit !== null) return { result: "limited", code: "OUTPUT_LIMIT", value: value({ reason: view.limit }) };
    if (view.complete) return { result: "succeeded", value: value() };

    const { topology, workspace } = view;
    const held = topology.rows;
    const target = "oid" in need ? topology.rowOf(need.oid) : -1;
    let stop = "row" in need ? Math.max(need.row + 1 + MARGIN, 2 * held) : "end" in need || target < 0 ? Infinity : Math.max(target + 1 + MARGIN, 2 * held);
    let watch = "oid" in need && target < 0 ? need.oid : null;
    // A piece of this size holds at most MARGIN + 1 lines, so the stop row of a watched OID lies after the piece that streams it.
    const piece = (MARGIN + 1) * (workspace.objectFormat === "sha1" ? 41 : 65);

    // Contract Δ3 and Δ8: the topology files are read again before the Git start. A change starts no view process.
    const files = await fileFingerprint(view.paths, workspace.objectFormat);
    if (t.signal.aborted || view.released) return { result: "canceled", value: value() };
    if (isStop(files)) {
      if ("failed" in files) return failed(files.failed, value(refusalOf(stale(view, { code: files.failed }))));
      return { result: "canceled", value: value() };
    }
    const topologyChanged = () => failed("HISTORY_CHANGED", value(refusalOf(stale(view, { code: "HISTORY_CHANGED", reason: "topology" }))));
    if (shallowDigest(files.shallow) !== view.fingerprint.shallow || files.grafts !== view.fingerprint.grafts) return topologyChanged();

    // The replace records are read beside the Git start, in the Job of this load. A process `cancel` closes that Job, so the load waits for this check first.
    const fingerprint = (async (): Promise<"same" | "changed" | Stop> => {
      const records = await readRecords(runner, t, replaceRefsArgs());
      if (isStop(records)) return records;
      if ("limit" in records) return { failed: "OUTPUT_LIMIT" };
      return records.replaceDigest === view.fingerprint.replace ? "same" : "changed";
    })().catch((): Stop => ({ failed: "GIT_FAILED" }));
    let verified = false;
    void fingerprint.then((r) => {
      verified = r === "same";
      if (verified) commit(view);
    });

    const call = new AbortController();
    const abortCall = () => call.abort();
    t.signal.addEventListener("abort", abortCall, { once: true });
    const endAfterCheck = () => void fingerprint.finally(abortCall);
    let failure: TopologyFailure | null = null;
    // `stop`: the stop row. `bound`: the view bound with no byte after it yet. `over`: a byte after the view bound.
    let ended: "stop" | "bound" | "over" | null = null;
    let lastProgress = 0;
    let streamedBytes = 0;
    topology.beginStep();
    const stdout: Collector = {
      push(chunk: Uint8Array): void {
        streamedBytes += chunk.length;
        if (failure !== null || ended === "stop" || ended === "over") return;
        if (ended === "bound") {
          if (chunk.length === 0) return;
          ended = "over";
          return endAfterCheck();
        }
        const size = watch === null ? chunk.length : piece;
        for (let at = 0; at < chunk.length; at += size) {
          const limit = Math.min(stop, viewCommits);
          failure = topology.push(chunk.subarray(at, at + size), limit);
          if (failure !== null) return endAfterCheck();
          if (watch !== null) {
            const row = topology.rowOf(watch);
            if (row >= 0) {
              stop = Math.max(row + 1 + MARGIN, 2 * held);
              watch = null;
            }
          }
          if (topology.rows >= Math.min(stop, viewCommits)) {
            ended = stop <= viewCommits ? "stop" : topology.rest || at + size < chunk.length ? "over" : "bound";
            if (ended !== "bound") endAfterCheck();
            break;
          }
        }
        if (verified) commit(view);
        const now = performance.now();
        if (!quiet && now - lastProgress >= PROGRESS_MS && registry.get(t.operationId)?.state === "running") {
          lastProgress = now;
          registry.progress(t.operationId, "history-load", { rows: topology.rows });
        }
      },
      get bytes() {
        return streamedBytes;
      },
      records: 0,
      limited: false,
    };

    let exit: GitExit | null = null;
    let refused: ErrorCode | null = null;
    try {
      exit = await runner.run({
        operationId: t.operationId,
        context: contextOf(workspace),
        arguments: historyLoadArgs(),
        ...startInput(view.starts),
        environmentPolicy: "read",
        limits: { deadlineMs: HISTORY_PROCESS_DEADLINE_MS },
        stdout,
        stderr: small(),
        signal: call.signal,
      });
    } catch (error) {
      if (error instanceof RunnerRefusal) refused = error.code;
      else if (!call.signal.aborted) throw error;
    } finally {
      t.signal.removeEventListener("abort", abortCall);
    }
    const checked = await fingerprint;
    if (checked === "same") commit(view);

    if (t.signal.aborted || view.released) return { result: "canceled", value: value() };
    if (refused !== null) return failed(refused, value());
    if (checked === "changed") return topologyChanged();
    if (isStop(checked)) {
      if ("failed" in checked) return failed(checked.failed, value(refusalOf(stale(view, { code: checked.failed }))));
      if (checked.stop === "deadline") return { result: "deadline", value: value({ remedy: deadlineRemedy(view) }) };
      return { result: "canceled", value: value() };
    }
    // `push` sets the failure inside the collector, so the type needs the widened form.
    const parseFailure = failure as TopologyFailure | null;
    if (parseFailure !== null) {
      if (parseFailure.code === "OUTPUT_LIMIT") {
        view.limit = parseFailure.reason;
        notify(view);
        return { result: "limited", code: "OUTPUT_LIMIT", value: value({ reason: parseFailure.reason }) };
      }
      const s = stale(view, parseFailure.code === "HISTORY_CHANGED" ? { code: parseFailure.code, reason: parseFailure.reason } : { code: parseFailure.code });
      return failed(s.code, value(refusalOf(s)));
    }
    // Contract Δ3: at the stop row the service ignores the exit code.
    if (ended === "stop") return { result: "succeeded", value: value() };
    if (ended === "over") {
      view.limit = "HISTORY_VIEW_COMMITS";
      notify(view);
      return { result: "limited", code: "OUTPUT_LIMIT", value: value({ reason: "HISTORY_VIEW_COMMITS" }) };
    }
    if (exit === null) return { result: "canceled", value: value() };
    if (exit.deadline !== undefined) return { result: "deadline", value: value({ remedy: deadlineRemedy(view) }) };
    if (exit.diagnosticLimit) return failed("OUTPUT_LIMIT", value(refusalOf(stale(view, { code: "OUTPUT_LIMIT" }))));
    if (exit.exitCode === 0) {
      const end = topology.end();
      if (end !== null) {
        const s = stale(view, end.code === "HISTORY_CHANGED" ? { code: end.code, reason: end.reason } : { code: end.code });
        return failed(s.code, value(refusalOf(s)));
      }
      view.complete = true;
      notify(view);
      return { result: "succeeded", value: value() };
    }
    // Contract Δ3: a nonzero exit before the stop row runs the 001 `checkFailedRead` steps.
    return failedRead(view, t, value);
  }

  // Contract Δ3 `searchHistory` and Δ8: the topology fingerprint check of `loadHistory`, before any search process.
  async function fingerprintCheck(view: View, t: ProcessTarget): Promise<ViewOutcome | null> {
    const files = await fileFingerprint(view.paths, view.workspace.objectFormat);
    if (t.signal.aborted || view.released) return { result: "canceled" };
    if (isStop(files)) return "failed" in files ? failed(files.failed, refusalOf(stale(view, { code: files.failed }))) : { result: "canceled" };
    const changed = () => failed("HISTORY_CHANGED", refusalOf(stale(view, { code: "HISTORY_CHANGED", reason: "topology" })));
    if (shallowDigest(files.shallow) !== view.fingerprint.shallow || files.grafts !== view.fingerprint.grafts) return changed();
    const records = await readRecords(runner, t, replaceRefsArgs());
    if (t.signal.aborted || view.released) return { result: "canceled" };
    if ("limit" in records) return failed("OUTPUT_LIMIT", refusalOf(stale(view, { code: "OUTPUT_LIMIT" })));
    if (isStop(records)) {
      if ("failed" in records) return failed(records.failed, refusalOf(stale(view, { code: records.failed })));
      return records.stop === "deadline" ? { result: "deadline" } : { result: "canceled" };
    }
    return records.replaceDigest === view.fingerprint.replace ? null : changed();
  }

  // Contract Δ3 "Matching probe" and spec FR-025: a search runs only after the probe of its Git installation passed.
  async function matching(view: View, t: ProcessTarget): Promise<ViewOutcome | null> {
    const unsupported = (text: string) => failed("SEARCH_UNSUPPORTED", { reason: "matching", remedy: { text, command: null } });
    if (view.workspace.wsl !== undefined) return unsupported(WSL_MATCHING_REMEDY);
    const key = view.installation.gitInstallationId;
    const result = probes.get(key) ?? (await probeMatching(runner, t, probeRuns));
    if (isStop(result)) return "failed" in result ? failed(result.failed) : result.stop === "deadline" ? { result: "deadline" } : { result: "canceled" };
    if (result !== "failed") probes.set(key, result);
    return result === "pass" ? null : unsupported(MATCHING_REMEDY);
  }

  // Contract Δ3 `searchHistory`. A search on an incomplete view loads it to the end inside the search operation (plan.md D4, D5).
  async function runSearch(view: View, s: Search, text: string, previous: Search | null, t: ProcessTarget): Promise<ViewOutcome> {
    // One load runs per view, so an older search ends first.
    if (previous !== null) await previous.done;
    if (t.signal.aborted || view.released) return { result: "canceled" };
    if (view.stale !== null) return failed(view.stale.code, refusalOf(view.stale));
    if (view.limit !== null) return { result: "limited", code: "OUTPUT_LIMIT", value: { reason: view.limit } };
    const refused = (await fingerprintCheck(view, t)) ?? (await matching(view, t));
    if (refused !== null) return refused;
    if (t.signal.aborted || view.released) return { result: "canceled" };

    const call = new AbortController();
    const abortCall = () => call.abort();
    t.signal.addEventListener("abort", abortCall, { once: true });
    // The side whose failure ended the other side decides the outcome.
    let stopper: "search" | "load" | null = null;
    const stop = (side: "search" | "load") => {
      stopper ??= side;
      call.abort();
    };
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      timer = null;
      last = performance.now();
      if (registry.get(t.operationId)?.state === "running") registry.progress(t.operationId, "history-search", { matches: s.merge.count, settled: s.merge.settled });
    };
    // Contract Δ5: at most HISTORY_PROGRESS_EVENTS_PER_SECOND events. A held event follows at the end of the interval.
    const progress = () => {
      if (timer !== null) return;
      const wait = last + PROGRESS_MS - performance.now();
      if (wait <= 0) send();
      else timer = setTimeout(send, wait);
    };
    s.update = () => {
      s.merge.advance(view.rows);
      if (s.merge.broken) stop("search");
      progress();
      notify(view);
    };
    const lines = matchStream(view.workspace.objectFormat, (oid) => s.merge.add(oid, view.rows));
    const stdout: Collector = {
      push(chunk: Uint8Array): void {
        lines.push(chunk);
        if (lines.limited) stop("search");
        s.update();
      },
      get bytes() {
        return lines.bytes;
      },
      records: 0,
      get limited() {
        return lines.limited || s.merge.broken;
      },
    };
    const searching = (async (): Promise<GitExit | ErrorCode | null> => {
      try {
        return await runner.run({
          operationId: t.operationId,
          context: contextOf(view.workspace),
          arguments: historySearchArgs(text),
          ...startInput(view.starts),
          environmentPolicy: "search",
          limits: { deadlineMs: HISTORY_PROCESS_DEADLINE_MS },
          stdout,
          stderr: small(),
          signal: call.signal,
        });
      } catch (error) {
        if (error instanceof RunnerRefusal) return error.code;
        if (call.signal.aborted) return null;
        throw error;
      }
    })().then((exit) => {
      if (exit === null || typeof exit === "string" || exit.exitCode !== 0 || exit.deadline !== undefined || exit.diagnosticLimit || lines.malformed) stop("search");
      else {
        s.merge.endStream(view.rows);
        s.update();
      }
      return exit;
    });
    const loading = view.complete
      ? Promise.resolve(null)
      : (async () => {
          view.load = t.operationId;
          try {
            const outcome = await runLoad(view, { end: true }, { ...t, signal: call.signal }, true);
            if (outcome.result !== "succeeded") stop("load");
            return outcome;
          } finally {
            if (view.load === t.operationId) view.load = null;
          }
        })();
    let exit: GitExit | ErrorCode | null;
    let loaded: ViewOutcome | null;
    try {
      [exit, loaded] = await Promise.all([searching, loading]);
    } finally {
      t.signal.removeEventListener("abort", abortCall);
      if (timer !== null) clearTimeout(timer);
    }

    if (t.signal.aborted || view.released) return { result: "canceled" };
    if (stopper === "load" && loaded !== null) {
      // The search result holds only the refusal fields of the load result.
      const v = ("value" in loaded ? loaded.value : undefined) as { reason?: ViewReason; remedy?: Remedy } | undefined;
      return { ...loaded, value: { ...(v?.reason === undefined ? {} : { reason: v.reason }), ...(v?.remedy === undefined ? {} : { remedy: v.remedy }) } };
    }
    if (s.merge.broken) return failed("HISTORY_CHANGED", { reason: "order" });
    if (lines.malformed) return failed("MALFORMED_GIT_OUTPUT", refusalOf(stale(view, { code: "MALFORMED_GIT_OUTPUT" })));
    if (exit === null) return { result: "canceled" };
    if (typeof exit === "string") return failed(exit);
    if (exit.deadline !== undefined) return { result: "deadline", value: { remedy: deadlineRemedy(view) } };
    if (exit.diagnosticLimit) return failed("OUTPUT_LIMIT", refusalOf(stale(view, { code: "OUTPUT_LIMIT" })));
    if (exit.exitCode !== 0) return failedRead(view, t, (extra = {}) => extra);
    // Contract Δ3 "Merge into the view": when the load completes, the queue must be empty.
    if (s.merge.waiting > 0) return failed("HISTORY_CHANGED", { reason: "order" });
    return { result: "succeeded", value: { matches: s.merge.count, shallow: view.shallow.kind === "file" } };
  }

  // Contract Δ3 `readHistoryRows` with `searchId`. Filter mode counts matches, and `from` of `at: {match}` is an inclusive view row.
  function resolveSearch(view: View, m: SearchMerge, at: Request<"readHistoryRows">["payload"]["at"], count: number, filter: boolean): number | "none" | "unknown" {
    if ("match" in at) {
      const q = m.matchTarget(at.match, at.from);
      return typeof q === "number" && !filter ? m.rowOf(q) : q;
    }
    if (!filter) return resolve(view, at, count);
    if ("row" in at) return at.row < m.count ? at.row : m.final ? "none" : "unknown";
    if ("oid" in at) {
      const row = view.topology.rowOf(at.oid);
      if (row >= 0 && row < m.known) {
        const q = m.seqOf(row);
        return q >= 0 ? q : "none";
      }
      return m.final ? "none" : "unknown";
    }
    return m.final ? (m.count === 0 ? "none" : Math.max(0, m.count - count)) : "unknown";
  }

  // Contract Δ3 `readHistoryRows` target resolution. A number is the first row.
  function resolve(view: View, at: Request<"readHistoryRows">["payload"]["at"], count: number): number | "none" | "unknown" {
    if ("row" in at) return at.row < view.rows ? at.row : view.complete ? "none" : "unknown";
    if ("oid" in at) {
      const row = view.topology.rowOf(at.oid);
      return row >= 0 && row < view.rows ? row : view.complete ? "none" : "unknown";
    }
    if ("end" in at) return view.complete ? (view.rows === 0 ? "none" : Math.max(0, view.rows - count)) : "unknown";
    return "unknown";
  }

  // The text of `oids` from one `cat-file --batch-command -Z` (contract Δ3, deadline HISTORY_TEXT_DEADLINE_MS).
  async function readText(view: View, t: ProcessTarget, oids: readonly string[]): Promise<(CommitText | "large")[] | ViewOutcome> {
    const stream = objectStream(oids, view.workspace.objectFormat);
    let exit: GitExit;
    try {
      exit = await runner.run({
        operationId: t.operationId,
        context: contextOf(view.workspace),
        arguments: batchCommandArgs(),
        input: new TextEncoder().encode(oids.map((oid) => `contents ${oid}\0`).join("")),
        environmentPolicy: "read",
        limits: { deadlineMs: HISTORY_TEXT_DEADLINE_MS },
        stdout: stream,
        stderr: small(),
        signal: t.signal,
      });
    } catch (error) {
      if (t.signal.aborted) return { result: "canceled" };
      if (error instanceof RunnerRefusal) return failed(error.code);
      throw error;
    }
    if (t.signal.aborted) return { result: "canceled" };
    if (exit.deadline !== undefined) return { result: "deadline" };
    if (exit.diagnosticLimit) return failed("OUTPUT_LIMIT", refusalOf(stale(view, { code: "OUTPUT_LIMIT" })));
    const answers = stream.result();
    if (answers !== "MALFORMED_GIT_OUTPUT" && answers.includes("missing")) {
      const found = await missing(view, t);
      if (found === "canceled") return { result: "canceled" };
      if (found === "deadline") return { result: "deadline" };
      return failed(found.code, refusalOf(stale(view, found)));
    }
    if (answers === "MALFORMED_GIT_OUTPUT" || exit.exitCode !== 0) {
      const code: ErrorCode = exit.exitCode !== 0 && !stream.limited ? "GIT_FAILED" : "MALFORMED_GIT_OUTPUT";
      return failed(code, refusalOf(stale(view, { code })));
    }
    return answers as (CommitText | "large")[];
  }

  // `s` is the search of `searchId`. In filter mode, `index` and the list count matches (contract Δ3).
  async function serveRows(view: View, p: Request<"readHistoryRows">["payload"], t: ProcessTarget, s: Search | null): Promise<ViewOutcome> {
    const filter = p.mode === "filter" ? s : null;
    const state = () => ({ rowCount: view.rows, lanes: filter === null ? view.layout.lanes : filter.merge.layout.lanes, complete: view.complete });
    let start: number;
    for (;;) {
      if (t.signal.aborted || view.released) return { result: "canceled" };
      // The search ended without success, so its matches are gone (contract Δ3).
      if (s !== null && view.search !== s) return { result: "canceled" };
      const target = s === null ? resolve(view, p.at, p.count) : resolveSearch(view, s.merge, p.at, p.count, filter !== null);
      if (typeof target === "number") {
        start = target;
        break;
      }
      // Contract Δ3: while the target is unknown and a load or search of the view runs, the request waits.
      if (target === "none" || (view.load === null && view.search?.running !== true)) return { result: "succeeded", value: withBytes({ target, ...state() }) };
      await change(view, t.signal);
    }
    const end = Math.min(start + p.count, filter === null ? view.rows : filter.merge.count);
    const rowAt = (i: number) => (filter === null ? start + i : filter.merge.rowOf(start + i));
    const { topology, layout } = view;
    const oids = Array.from({ length: end - start }, (_, i) => topology.oid(rowAt(i)));
    const cells = filter === null ? layout.cellsOf({ start, end }) : filter.merge.cells(start, end);
    const text = p.text === "none" ? null : await readText(view, t, oids);
    if (text !== null && !Array.isArray(text)) return text;
    const head = view.head.state === "unborn" ? null : view.head.oid;
    const rows = oids.map((oid, i) => {
      const index = rowAt(i);
      const row: Record<string, unknown> = { index: start + i, oid, parents: topology.parents(index), cell: cells[i], labels: view.labels.get(oid) ?? [], checkout: oid === head };
      if (s !== null) row.match = filter !== null || s.merge.stateOf(index);
      const found = text?.[i];
      if (found === "large") row.textLimit = true;
      else if (found !== undefined) {
        const { subject, author, date, encoding, invalidUtf8, body, bodyCut, committer, committerDate } = found;
        Object.assign(row, { subject, author, date, encoding, invalidUtf8 });
        // shortcut: `children` has no Δ5 bound. HISTORY_PAGE_BYTES cuts a details row above the result bound. Add a bound when the contract names one.
        if (p.text === "details") Object.assign(row, { body, bodyCut, committer, committerDate, children: topology.childRows(index).map((r) => topology.oid(r)) });
      }
      return row;
    });
    // Contract Δ3: the result stays within HISTORY_PAGE_BYTES. Each row adds its bytes and one comma.
    const base = encodedBytes(withBytes({ target: "found", rows: [], cut: false, ...state() }));
    let size = base;
    let kept = 0;
    for (const row of rows) {
      const next = size + encodedBytes(row) + (kept > 0 ? 1 : 0);
      if (next > HISTORY_PAGE_BYTES) break;
      size = next;
      kept++;
    }
    return { result: "succeeded", value: withBytes({ target: "found", rows: rows.slice(0, kept), cut: kept < rows.length, ...state() }) };
  }

  // `bytes` is the encoded size of the result that holds it.
  function withBytes<T extends object>(result: T): T & { bytes: number } {
    const plain = encodedBytes({ ...result, bytes: 0 }) - 1;
    let bytes = plain + 1;
    for (let i = 0; i < 3; i++) bytes = plain + String(bytes).length;
    return { ...result, bytes };
  }

  // Ends the operation of `request` with `outcome`, as the read rows of data-model §7 do.
  function finish(view: View | null, operationId: string, outcome: ViewOutcome): void {
    view?.operations.delete(operationId);
    if (view?.load === operationId) view.load = null;
    if (view?.text === operationId) view.text = null;
    if (view !== null) notify(view);
    const value = "value" in outcome ? outcome.value : undefined;
    if (registry.get(operationId)?.state === "cancel-requested") return void registry.apply(operationId, { type: "processes-stopped" }, value);
    if (outcome.result === "canceled") {
      registry.apply(operationId, { type: "cancel" });
      return void registry.apply(operationId, { type: "processes-stopped" }, value);
    }
    if (outcome.result === "deadline") return void registry.apply(operationId, { type: "read-deadline" }, value);
    registry.apply(operationId, { type: "read-complete", result: outcome.result, ...(outcome.code === undefined ? {} : { code: outcome.code }) }, value);
  }

  return {
    // Contract Δ3 `openHistory`, inside its read slot. No captured data leaves before the read gate passes.
    async open(t: OpenTarget, scope: "all" | "current"): Promise<ViewOutcome> {
      release(current);
      const steps = new AbortController();
      const stopSteps = () => steps.abort();
      t.signal.addEventListener("abort", stopSteps, { once: true });
      if (t.signal.aborted) steps.abort();
      try {
        const pending = capture({ operationId: t.operationId, signal: steps.signal, workspace: t.workspace });
        pending.catch(() => {});
        const listed = await sharedListing({ trust, listingTuple }, t);
        const gate = listed.ok ? trust.gate(t.workspace, listed.listing, t.installation, "reads") : null;
        if (!listed.ok || gate !== null) {
          steps.abort();
          await pending.catch(() => null);
          if (t.signal.aborted) return { result: "canceled" };
          if (listed.ok) return failed(gate!);
          if ("stop" in listed) return { result: listed.stop };
          return failed(listed.code, listed.text === undefined ? {} : { remedy: { text: listed.text, command: null } });
        }
        const captured = await pending;
        if (t.signal.aborted) return { result: "canceled" };
        if ("limit" in captured) return { result: "limited", code: "OUTPUT_LIMIT", value: { reason: captured.limit } };
        if (isStop(captured)) return "stop" in captured ? { result: captured.stop } : failed(captured.failed);
        const { head, records, paths, files } = captured;
        const labels = new Map<string, Label[]>();
        const commits = new Set<string>();
        for (const ref of records.refs) {
          if (ref.commitId === null) continue;
          commits.add(ref.commitId);
          // Spec FR-050: a symbolic ref gives no label.
          if (ref.symref !== null) continue;
          const list = labels.get(ref.commitId) ?? [];
          list.push({ kind: ref.kind, name: ref.name, invalidUtf8: ref.invalidUtf8 });
          labels.set(ref.commitId, list);
        }
        const tip = head.state === "unborn" ? [] : [head.oid];
        // Contract Δ3 "Start points": ascending lowercase hex.
        const starts = [...new Set(scope === "all" ? [...commits, ...tip] : tip)].sort();
        const topology = new HistoryTopology(t.workspace.objectFormat);
        const view: View = {
          viewId: crypto.randomUUID(),
          workspace: t.workspace,
          installation: t.installation,
          scope,
          generation: t.generation,
          head,
          labels,
          starts,
          paths,
          fingerprint: { shallow: shallowDigest(files.shallow), grafts: files.grafts, replace: records.replaceDigest },
          shallow: files.shallow,
          listing: listed.listing,
          topology,
          layout: new HistoryLayout((i) => {
            const oid = topology.oid(i);
            return { oid, parents: topology.parents(i), shallow: files.shallow.kind === "file" && files.shallow.commits.has(oid) };
          }),
          rows: 0,
          complete: false,
          limit: null,
          stale: null,
          load: null,
          text: null,
          search: null,
          operations: new Set(),
          waiters: new Set(),
          released: false,
        };
        release(current);
        current = view;
        return {
          result: "succeeded",
          value: { viewId: view.viewId, scope, generation: t.generation, head, startCount: starts.length, refsDigest: records.refsDigest, shallow: files.shallow.kind === "file" },
        };
      } finally {
        t.signal.removeEventListener("abort", stopSteps);
      }
    },

    // Contract Δ3 `loadHistory`. It takes no read slot. One load runs per view.
    load(request: Request<"loadHistory">): void {
      const { viewId, need } = request.payload;
      const view = find(request.repositoryId, viewId);
      if (view === null) return reject(request.requestId, "UNKNOWN_TARGET");
      if ("oid" in need && !isObjectId(need.oid, view.workspace.objectFormat)) return reject(request.requestId, "INVALID_REQUEST");
      // Contract Δ3: a load while a load or a search of the view runs gives BUSY.
      if (view.load !== null || view.search?.running === true) return reject(request.requestId, "BUSY");
      const { operationId, signal } = registry.start("loadHistory", request.requestId);
      registry.apply(operationId, { type: "valid-read" });
      view.load = operationId;
      view.operations.add(operationId);
      runLoad(view, need, { operationId, signal, workspace: view.workspace }).then(
        (outcome) => finish(view, operationId, outcome),
        () => finish(view, operationId, failed("GIT_FAILED", { rows: view.rows, complete: view.complete })),
      );
    },

    // Contract Δ3 `readHistoryRows`. A newer text read cancels an unfinished one of the same view (001 §5 "Pending reads").
    rows(request: Request<"readHistoryRows">): void {
      const p = request.payload;
      const view = find(request.repositoryId, p.viewId);
      if (view === null) return reject(request.requestId, "UNKNOWN_TARGET");
      // Contract Δ3: an ended or unknown `searchId` gives UNKNOWN_TARGET.
      const search = p.searchId === undefined ? null : view.search;
      if (p.searchId !== undefined && search?.operationId !== p.searchId) return reject(request.requestId, "UNKNOWN_TARGET");
      // Contract Δ3: `at: {match}` needs the matches of one search, so it requires `searchId`.
      if ("match" in p.at && search === null) return reject(request.requestId, "INVALID_REQUEST");
      if ("oid" in p.at && !isObjectId(p.at.oid, view.workspace.objectFormat)) return reject(request.requestId, "INVALID_REQUEST");
      const { operationId, signal } = registry.start("readHistoryRows", request.requestId);
      registry.apply(operationId, { type: "valid-read" });
      view.operations.add(operationId);
      if (p.text !== "none") {
        if (view.text !== null) registry.cancel(view.text);
        view.text = operationId;
      }
      serveRows(view, p, { operationId, signal, workspace: view.workspace }, search).then(
        (outcome) => finish(view, operationId, outcome),
        () => finish(view, operationId, failed("GIT_FAILED")),
      );
    },

    // Contract Δ3 `searchHistory`. It takes no read slot. A new search of the view cancels the old one (spec FR-030).
    search(request: Request<"searchHistory">): void {
      const view = find(request.repositoryId, request.payload.viewId);
      if (view === null) return reject(request.requestId, "UNKNOWN_TARGET");
      const previous = view.search?.running === true ? view.search : null;
      // Contract Δ3: a search while a load of the view runs gives BUSY. The load of an older search ends with that search.
      if (view.load !== null && view.load !== previous?.operationId) return reject(request.requestId, "BUSY");
      const { operationId, signal } = registry.start("searchHistory", request.requestId);
      // Spec SC-009: the text checks run before any Git process. The refusal carries the reason only (contract Δ9).
      const checked = filterText(request.payload.text, FILTER_TEXT_BYTES);
      if (checked.kind !== "search") return void registry.apply(operationId, { type: "invalid-approval", code: "UNSUPPORTED_FILTER_TEXT" }, checked.kind === "refused" ? { reason: checked.reason } : {});
      registry.apply(operationId, { type: "valid-read" });
      if (previous !== null) registry.cancel(previous.operationId);
      let settle = () => {};
      const shallow = view.shallow;
      const s: Search = {
        operationId,
        merge: new SearchMerge(view.topology, (oid) => shallow.kind === "file" && shallow.commits.has(oid), viewCommits),
        running: true,
        done: new Promise((resolve) => (settle = resolve)),
        update: () => {},
      };
      view.search = s;
      view.operations.add(operationId);
      const end = (outcome: ViewOutcome) => {
        s.running = false;
        if (outcome.result !== "succeeded" && view.search === s) view.search = null;
        settle();
        finish(view, operationId, outcome);
      };
      runSearch(view, s, checked.text, previous, { operationId, signal, workspace: view.workspace }).then(end, () => end(failed("GIT_FAILED")));
    },

    // Contract Δ3 `closeHistory`: it ends the operations of the view and frees its memory.
    close(request: Request<"closeHistory">): void {
      const view = find(request.repositoryId, request.payload.viewId);
      if (view === null) return reject(request.requestId, "UNKNOWN_TARGET");
      release(view);
      const { operationId } = registry.start("closeHistory", request.requestId);
      registry.apply(operationId, { type: "valid-read" });
      finish(null, operationId, { result: "succeeded" });
    },

    // A workspace release ends its view.
    releaseRepository(repositoryId: string): void {
      if (current?.workspace.repositoryId === repositoryId) release(current);
    },
  };
}

export type HistoryViews = ReturnType<typeof createHistoryViews>;
