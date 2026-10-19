// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T230: `updateSubmodules`, contract §12 "Update protocol", "Trust", "Progress", "Deadlines and Cancel", and "Reconciliation and outcome".
// T233: a WSL workspace runs the same protocol through contract §11 (§12 "WSL repositories"). The admission reads memory only.

import { lstat, readdir } from "node:fs/promises";
import type { Response, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, SUBMODULE_PROGRESS_EVENTS_PER_SECOND } from "../contracts/limits";
import {
  buildRefusalRemedy,
  buildSubmoduleRemedy,
  parseSubmoduleProgress,
  type SubmoduleFailedRead,
  type SubmodulePlanRow,
  type SubmoduleProgressPhase,
  type SubmoduleRemedyRequest,
  type SubmoduleStaleReviewReason,
} from "../contracts/submodules";
import type { Acceptance, ApprovalKey, Approvals, SubmoduleReview } from "./approvals";
import {
  indexEntryArgs,
  remoteUrlArgs,
  submoduleCheckoutArgs,
  submoduleCloneArgs,
  submoduleFallbackFetchArgs,
  submoduleFetchArgs,
  submoduleHeadRefArgs,
  submoduleReachArgs,
  submoduleRegisterArgs,
  type SubmoduleLocation,
} from "./commands";
import { OTHER_LOCKS_TEXT } from "./commit";
import { createTailCollector } from "./discovery";
import type { Entered, Exclusion, NotEntered } from "./exclusion";
import { createCollector, PROCESS_LIMITS, RunnerRefusal, type Collector, type GitExit, type GitRunner } from "./git-runner";
import { captureHead } from "./history";
import { enterReconciling, isStop, lingeringText, notEntered, settled, stepOf, type ObserveContext, type Stop } from "./hunk-publish";
import type { OperationRegistry } from "./operations";
import { contextOf, isMissing } from "./read-steps";
import { listingOf, reconcileUpdate, rowKeys, type RetainedUpdate, type RetainedUpdateRow, type RowKeys, type UpdatePhase, type UpdateRowRead } from "./reconcile";
import type { Workspace } from "./registration";
import type { Head, ReadInstallation } from "./snapshot";
import { trackStall } from "./stall";
import { parseIndexListing, type WorkspaceReader } from "./status";
import { displayPath } from "./status-parser";
import { defaultRemote, fallbackRemote, SubmoduleUrlError } from "./submodule-remote";
import {
  componentsOf,
  OUTER_SCOPES,
  pathForms,
  programDirOwner,
  programOwner,
  REFUSAL_TEXTS,
  type Observed,
  type ObservedRow,
  type ProgramEntry,
  type RetainedSubmoduleReview,
  type SubmoduleFact,
  type SubmoduleRefusal,
  type SubmoduleReviewer,
} from "./submodule-review";
import { keyParts, requestFacts, type ConfigEntry, type Trust } from "./trust";

// Contract §12 "Refusals during the run" and "Update protocol" step 5 "Clone check".
const RUN_TEXTS = {
  programs: (path: string) => `Submodule ${path} needs programs that the run confirmation did not cover. Use Update submodules again to review them.`,
  changedAfterReview: (path: string) => `Another program changed submodule ${path} after the review. Use Update submodules again to review it.`,
  foundFolder: (path: string, oid: string) =>
    `Submodule ${path} is at commit ${oid.slice(0, 12)}, which no branch, tag, or other ref holds. Another program set up this submodule after the review. Save that commit in a terminal, then use Update submodules again.`,
};

// Contract §5 "Submodule progress events".
const PROGRESS_GAP_MS = 1000 / SUBMODULE_PROGRESS_EVENTS_PER_SECOND;
const SLASH = 0x2f;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Contract §12 "Update protocol" step 5 and "Trust": `folder-check` comes before each folder check of a `reuse` row, `clone-check` before each clone check,
// and `nested-active-set` before the program re-check of a nested active-set read. `path` is the display path of the row, or of the parent row.
export interface SubmoduleCheckpoint {
  point: "folder-check" | "clone-check" | "nested-active-set";
  operationId: string;
  path: string;
}

// Data-model §9 "Update result": the operation remedy of a failed outcome (contract §9 "Lingering count" and "Other locks", decision G7).
export interface SubmoduleUpdateRemedy {
  text: string;
}

type UpdateRequest = Extract<ServiceRequest, { operation: "updateSubmodules" }>;
export type UpdateAdmission = { approval: SubmoduleReview; review: RetainedSubmoduleReview };
type Refused = { code: ErrorCode; path?: string };
type Observer = ReturnType<SubmoduleReviewer["observe"]>;
type Preflight = { observer: Observer; read: Observed; head: Head };
type RowRemedy = NonNullable<NonNullable<UpdatePhase["refusal"]>["remedy"]>;

// Contract §2, §9, and §12 "Refusals": the acceptance checks after the accepted event, in this order. Memory only, so no Git process starts.
export function admitUpdate(
  request: Pick<UpdateRequest, "repositoryId" | "repositoryGeneration" | "payload">,
  w: Pick<Workspace, "generation">,
  accepted: Acceptance,
  retained: (token: string) => RetainedSubmoduleReview | undefined,
): UpdateAdmission | { code: ErrorCode; result?: { refusals: SubmoduleRefusal[] } | { reason: SubmoduleStaleReviewReason } } {
  if (request.repositoryGeneration !== w.generation) return { code: "REPOSITORY_CHANGED" };
  if (!accepted.ok) return { code: "code" in accepted ? accepted.code : "UNKNOWN_TARGET" };
  const approval = accepted.approval;
  if (approval.kind !== "submodule" || approval.repositoryId !== request.repositoryId || approval.generation !== w.generation) return { code: "UNKNOWN_TARGET" };
  const review = retained(approval.reviewToken);
  if (review === undefined || review.repositoryId !== request.repositoryId) return { code: "UNKNOWN_TARGET" };
  // The update refuses while a review refusal holds. The token stays unconsumed.
  if (review.value.refusals.length > 0) return { code: "UNSUPPORTED_SUBMODULE", result: { refusals: review.value.refusals } };
  // Feature 004 contract Δ12: one "Update anyway" covers every host line of the review. The token stays unconsumed for it.
  if (review.value.hosts.length > 0 && request.payload.confirmHosts !== true) return { code: "STALE_REVIEW", result: { reason: "hosts" } };
  return { approval, review };
}

// Contract §12 "Reconciliation and outcome": the state that the action gives when the row reaches its target.
export function plannedOf(row: Pick<SubmodulePlanRow, "action" | "head" | "target">): RetainedUpdateRow["planned"] {
  const writes = row.action === "clone" || row.action === "reuse" || row.action === "checkout" || row.action === "fetch-checkout";
  if (!writes || row.target === null) return "unchanged";
  return row.head === null ? "cloned" : row.head === row.target ? "unchanged" : "moved";
}

const keptRead = (p: ObservedRow) => (p.row.action === "reuse" ? p.kept : null);

function factsOf(p: ObservedRow, baseline: RowKeys, parent: UpdateRowRead | null): RetainedUpdateRow {
  return {
    rowId: p.row.rowId,
    path: p.row.path,
    found: p.found,
    planned: plannedOf(p.row),
    oldCommit: p.row.head,
    target: p.row.target,
    baseline,
    phase: { fetched: false, connected: false },
    read: { components: p.components, name: p.row.name, kept: keptRead(p), parent },
  };
}

// Git `remote.c`: each `remote.<name>.<variable>` key creates its remote, except a name that starts with `/`.
function remoteNames(entries: readonly ConfigEntry[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const p = keyParts(entry.key);
    if (p !== null && p.section === "remote" && p.subsection !== null && !p.subsection.startsWith("/")) names.add(p.subsection);
  }
  return [...names];
}

// Contract §12 "Progress" and "Output tail": one collector feeds the tail and the counter. A segment ends at CR or LF, also across chunks.
export function stepStderr(onPercent: (percent: number) => void): Collector & { outputTail(): string } {
  const tail = createTailCollector("progress");
  const text = new TextDecoder("utf-8", { ignoreBOM: true });
  let open = "";
  return {
    push(chunk: Uint8Array): void {
      tail.push(chunk);
      const segments = (open + text.decode(chunk, { stream: true })).split(/[\r\n]/);
      open = segments.pop() ?? "";
      for (const segment of segments) {
        const percent = parseSubmoduleProgress(segment);
        if (percent !== null) onPercent(percent);
      }
    },
    get bytes() {
      return tail.bytes;
    },
    records: 0,
    get limited() {
      return tail.limited;
    },
    outputTail: tail.outputTail,
  };
}

// Contract §12 "Progress": at most 4 events per second. The last report of a gap goes out at its end.
function createProgress(registry: OperationRegistry, operationId: string) {
  let sentAt = Number.NEGATIVE_INFINITY;
  let next: [SubmoduleProgressPhase, Record<string, number>, string] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = () => {
    timer = null;
    const state = registry.get(operationId)?.state;
    if (next === null || (state !== "running" && state !== "cancel-requested")) return;
    const [phase, counters, path] = next;
    next = null;
    sentAt = performance.now();
    registry.progress(operationId, phase, counters, undefined, path);
  };
  return {
    report(phase: SubmoduleProgressPhase, counters: Record<string, number>, path: string): void {
      next = [phase, counters, path];
      if (timer !== null) return;
      const wait = sentAt + PROGRESS_GAP_MS - performance.now();
      if (wait <= 0) send();
      else timer = setTimeout(send, wait);
    },
    stop(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      next = null;
    },
  };
}

// Ends the run: a Cancel, a deadline with its contract §9 reason, the §5 diagnostic bound, or a shell refusal of a step start.
class Halted {
  constructor(readonly cause: "canceled" | "limit" | "refused" | { deadline: string }) {}
}

// Ends one row with a refusal or a failed read (contract §12 "Refusals during the run" and "Update protocol" read failures).
class RowEnd {
  constructor(readonly end: Pick<UpdatePhase, "refusal" | "failedRead">) {}
}

const halted = (stop: "canceled" | "deadline") => new Halted(stop === "deadline" ? { deadline: "deadline" } : "canceled");
const refusal = (reason: NonNullable<UpdatePhase["refusal"]>["reason"], text: string, remedy?: RowRemedy | null) =>
  new RowEnd({ refusal: { reason, text, ...(remedy ? { remedy } : {}) } });
const fromReview = (r: SubmoduleRefusal): NonNullable<UpdatePhase["refusal"]> => ({ reason: r.reason, text: r.text, ...(r.remedy ? { remedy: r.remedy } : {}) });

// One visited row: its newest observation, its parent row, and its retained facts. `index` is the `<i>` of contract §12 "Progress".
interface RunRow {
  p: ObservedRow;
  parent: RunRow | null;
  facts: RetainedUpdateRow;
  index: number;
}

interface RunContext {
  ctx: ObserveContext;
  observer: Observer;
  read: Observed;
  update: RetainedUpdate;
  facts: Map<string, RetainedUpdateRow>;
  // The Git path of the remedy commands.
  gitPath: string;
  gitVersion: string;
}

// `refused`: a refusal of a step start ended the run.
type RunEnd = { deadline: string | null; diagnosticLimit: boolean; refused: boolean; lingeringDescendants: number };

export interface SubmoduleUpdaterOptions {
  runner: GitRunner;
  trust: Trust;
  reader: Pick<WorkspaceReader, "operationState">;
  reviews: Pick<SubmoduleReviewer, "observe" | "retained">;
  approvals: Approvals;
  registry: OperationRegistry;
  exclusion: Exclusion;
  respond: (response: Response) => unknown;
  // Test seam only. Production never sets it.
  submoduleCheckpoint?: (checkpoint: SubmoduleCheckpoint) => Promise<void> | void;
}

export function createSubmoduleUpdater(o: SubmoduleUpdaterOptions) {
  const { registry, approvals } = o;
  // Contract §5 and §8: the plan rows and the rows that the run adds, until a known outcome.
  const retained = new Map<string, RetainedUpdate>();
  // Contract §2: the workspace of each operation that consumed a review token.
  const owners = new Map<string, string>();

  // Contract §12 "Update protocol" step 2: the review reads again with the retained row IDs.
  // A changed listing or trust view decides first, then the read gate and the read failures, then the digests.
  async function preflight(ctx: ObserveContext, rowIds: ReadonlyMap<string, string>, a: UpdateAdmission): Promise<Preflight | Refused | Stop> {
    try {
      return await observeAgain(ctx, rowIds, a);
    } catch (error) {
      // A review read with an aborted signal throws before its start request.
      if (ctx.signal.aborted) return { stop: "canceled" };
      throw error;
    }
  }

  async function observeAgain(ctx: ObserveContext, rowIds: ReadonlyMap<string, string>, a: UpdateAdmission): Promise<Preflight | Refused | Stop> {
    const { workspace: w, signal } = ctx;
    const t = { operationId: ctx.operationId, signal, workspace: w, installation: ctx.installation };
    const captured = await settled(signal, captureHead(o.runner, t));
    if (isStop(captured)) return captured;
    if ("code" in captured) return { code: captured.code };
    if ("failed" in captured) return { code: captured.failed };
    const index = await listingOf(ctx, indexEntryArgs(), (bytes) => parseIndexListing(bytes, w.objectFormat));
    if (!("value" in index)) return isStop(index) ? index : { code: index.code };
    const observer = o.reviews.observe(t, rowIds, a.review.scope);
    const read = await observer.top({ head: captured, indexEntries: index.value });
    if ("stop" in read) return read;
    const bound = observer.binding();
    if (bound !== null && (bound.fingerprint !== a.review.fingerprint || !Bun.deepEquals(bound.binding.trust, a.approval.binding.trust, true))) return { code: "TRUST_CHANGED" };
    if (!("value" in read)) return read;
    if (bound === null || bound.binding.review !== a.approval.binding.review || bound.binding.programs !== a.approval.binding.programs) return { code: "STALE_REVIEW" };
    return { observer, read: read.value, head: captured };
  }

  // Contract §12 "Trust": the run confirmation names the worktree of each program row and each kept Git directory without a row.
  // Contract §6: a trust frame names native paths, so a WSL path goes in its UNC form.
  async function confirmRun(w: Workspace, installation: ReadInstallation, read: Observed): Promise<"approved" | "declined" | Refused> {
    const forms = pathForms(w, installation);
    const worktreeOf = new Map(read.rows.map((p) => [p.row.rowId, p.worktree]));
    const paths = new Set<string>();
    for (const e of read.programs) {
      const path = forms.native("rowId" in e.program ? worktreeOf.get(e.program.rowId)! : e.program.gitDirectory);
      // The review and the preflight refuse such a row or Git directory with reason `path` (contract §11 "Paths and file access").
      if (path === null) return { code: "UNSUPPORTED_SUBMODULE" };
      paths.add(path);
    }
    let reply;
    try {
      reply = await o.runner.trust({
        type: "confirmRun",
        worktreeRoot: w.worktreeRoot,
        submodulePaths: [...paths],
        programCount: read.programs.length,
        uncheckedCount: read.programs.filter((e) => e.program.digest === "unchecked").length,
      });
    } catch (error) {
      if (error instanceof RunnerRefusal) return { code: error.code };
      throw error;
    }
    return "result" in reply ? reply.result : { code: "INVALID_REQUEST" };
  }

  // Data-model §9: the retained plan holds each plan row with its preflight baseline (contract §12 "Reconciliation and outcome").
  function planOf(read: Observed): { update: RetainedUpdate; facts: Map<string, RetainedUpdateRow> } {
    const byId = new Map(read.rows.map((p) => [p.row.rowId, p]));
    const facts = new Map<string, RetainedUpdateRow>();
    for (const p of read.rows) {
      const parent = p.row.parentRowId === null ? null : byId.get(p.row.parentRowId)!;
      // A nested plan row comes only from a parent that the review read, so the parent has its configuration.
      const config = parent === null ? read.config : parent.repo!.entries;
      facts.set(p.row.rowId, factsOf(p, rowKeys(config, p.row.name), parent === null ? null : facts.get(parent.row.rowId)!.read));
    }
    return { update: { rows: [...facts.values()] }, facts };
  }

  // Contract §12 "Update protocol" steps 4 to 7: the depth-first visit of the rows.
  async function run(c: RunContext): Promise<RunEnd> {
    const { ctx, observer, read, update, facts, gitPath, gitVersion } = c;
    const { operationId, signal, workspace: w } = ctx;
    const forms = pathForms(w, ctx.installation);
    const wsl = forms.wsl;
    const confirmed = new Set(read.programs.map((e) => JSON.stringify([e.owner, e.identity, e.program.digest])));
    const fold = forms.key;
    const confirmedDirs = new Map(read.rowless.map((repo) => [fold(repo.gitDir), programDirOwner(repo.gitDir)]));
    const progress = createProgress(registry, operationId);
    let lastDescendants = 0;
    let visited = 0;
    // Contract §12 "Progress": `<n>` is the visited rows plus the rows that the update still plans to visit, by base64 path bytes.
    const planned = new Map<string, { bytes: Uint8Array; parent: string | null }>();
    const visitable = (p: ObservedRow) => p.row.refusal === null && (p.row.action !== "skip" || p.register);
    const pathOf = new Map(read.rows.map((p) => [p.row.rowId, p.row.pathBytes]));
    // Contract Δ12: a row above the scope row runs no step, so `<n>` and `<i>` leave it out.
    const counted = (p: ObservedRow) => visitable(p) && !p.above;
    for (const p of read.rows) if (counted(p)) planned.set(p.row.pathBytes, { bytes: p.pathBytes, parent: p.row.parentRowId === null ? null : (pathOf.get(p.row.parentRowId) ?? null) });
    const below = (bytes: Uint8Array, parent: Uint8Array) => bytes.length > parent.length && bytes[parent.length] === SLASH && Buffer.compare(bytes.subarray(0, parent.length), parent) === 0;
    const dropBelow = (bytes: Uint8Array) => {
      for (const [key, e] of planned) if (below(e.bytes, bytes)) planned.delete(key);
    };
    const counters = (r: RunRow, percent?: number) => ({ rowIndex: r.index, rowCount: visited + planned.size, ...(percent === undefined ? {} : { percent }) });

    const checkpoint = async (point: SubmoduleCheckpoint["point"], path: string) => {
      await o.submoduleCheckpoint?.({ point, operationId, path });
    };
    const need = <T>(fact: SubmoduleFact<T>, failedRead: SubmoduleFailedRead): T => {
      if ("value" in fact) return fact.value;
      if ("stop" in fact) throw halted(fact.stop);
      throw new RowEnd({ failedRead });
    };
    const partsOf = (p: ObservedRow) => {
      if (p.components === null) throw new TypeError("a visited row needs a literal path");
      return p.components;
    };
    const keptOf = (p: ObservedRow) => {
      if (p.kept === null) throw new TypeError("a row without a .git entry needs its kept folder path");
      return p.kept;
    };

    // One review read in a submodule. A read that gives no exit ends the row with `failedRead`.
    const gitRead = async (args: string[], failedRead: SubmoduleFailedRead) => {
      const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
      const step = await stepOf(ctx, args, out);
      if (!("exit" in step)) {
        if (isStop(step)) throw halted(step.stop);
        throw new RowEnd({ failedRead });
      }
      return { code: step.exit.exitCode, out };
    };
    // `for-each-ref --contains=HEAD`: exit 0 without output means no ref. A nonzero exit is a failure.
    const refHeld = async (location: SubmoduleLocation, failedRead: SubmoduleFailedRead) => {
      const r = await gitRead(submoduleHeadRefArgs(location), failedRead);
      if (r.code !== 0) throw new RowEnd({ failedRead });
      return r.out.bytes > 0;
    };
    // Git `is_tip_reachable`: exit 0 without output means that a ref or HEAD reaches the target. Anything else means none does.
    const reaches = async (location: SubmoduleLocation, target: string) => {
      const r = await gitRead(submoduleReachArgs(location, target, w.objectFormat), "check");
      return r.code === 0 && r.out.bytes === 0;
    };
    // `remote get-url --all -- <name>`: one URL per line.
    const remoteUrls = async (location: SubmoduleLocation, name: string): Promise<string[]> => {
      const r = await gitRead(remoteUrlArgs(location, name), "remote-get-url");
      const bytes = r.out.take();
      if (r.code !== 0 || r.out.limited || (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a)) throw new RowEnd({ failedRead: "remote-get-url" });
      let text: string;
      try {
        text = UTF8.decode(bytes);
      } catch {
        throw new RowEnd({ failedRead: "remote-get-url" });
      }
      return text === "" ? [] : text.slice(0, -1).split("\n");
    };
    // The `.git` entry of a row through `fileFacts`. A link before the last component means that no entry exists at the path.
    const gitEntry = async (p: ObservedRow, failedRead: SubmoduleFailedRead) => {
      const path = [...partsOf(p), ".git"];
      const reply = await requestFacts(o.runner, operationId, w, false, [{ root: "worktreeRoot", path }], signal);
      if (!Array.isArray(reply)) {
        if ("stop" in reply) throw halted(reply.stop);
        throw new RowEnd({ failedRead });
      }
      const fact = reply[0]!;
      if (fact.kind === "error") throw new RowEnd({ failedRead });
      return fact.kind !== "absent" && (fact.kind !== "link" || fact.component === path.length);
    };
    // The UNC form of a folder for metadata only. Contract §11 "Paths and file access": a folder without an exact one ends the row `refused` with `path`.
    const nativeOf = (folder: string, row: string) => {
      const at = forms.native(folder);
      if (at === null) throw refusal("path", REFUSAL_TEXTS.uncPath(row));
      return at;
    };
    // Git `clone_submodule` tests `<parent Git directory>/modules/<name>` with `file_exists`. A read error is no absent path.
    const exists = async (path: string, failedRead: SubmoduleFailedRead, row: string) => {
      const at = nativeOf(path, row);
      try {
        await lstat(at);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw new RowEnd({ failedRead });
      }
    };

    // Contract §12 "Trust", nested levels: the same row or Git directory, key or hook file, origin, and digest as a confirmed entry.
    const covered = (e: ProgramEntry, holder: RunRow | null): boolean => {
      const has = (owner: string, identity: unknown[]) => confirmed.has(JSON.stringify([owner, identity, e.program.digest]));
      if (has(e.owner, e.identity)) return true;
      if (holder === null) return false;
      // A kept Git directory without a row can become a row of a level read. It keeps its confirmed entries.
      const dir = holder.p.repo === null ? undefined : confirmedDirs.get(fold(holder.p.repo.gitDir));
      if (dir !== undefined && has(dir, e.identity)) return true;
      const [copy, ...value] = e.identity;
      // A confirmed `unchecked` copy for unknown nested submodules covers the same value for each row below its row.
      if (e.program.digest === "unchecked" && (copy === "" || copy === "nested")) {
        for (let a = holder.parent; a !== null; a = a.parent) if (has(programOwner(a.p.row), ["nested", ...value])) return true;
      }
      // Decision G5: a found row matches a system, global, or command entry of its nearest listed ancestor.
      if (!holder.p.found || !OUTER_SCOPES.has(e.program.scope)) return false;
      let a = holder.parent;
      while (a !== null && a.p.found) a = a.parent;
      return a !== null && has(programOwner(a.p.row), e.identity);
    };
    // Contract §12 "Trust", program re-check right before a process: each Git directory that the process can use. Null: a row before its clone.
    // Git keeps the given `--git-dir` text in each origin, so a re-check reads through the location of the observation that listed the entries.
    const gate = async (r: RunRow, holders: [RunRow, SubmoduleLocation | null][]) => {
      for (const [holder, location] of holders) {
        const entries = need(await observer.programsOf(holder.p, location), "check");
        if (!entries.every((e) => covered(e, holder))) throw refusal("programs", RUN_TEXTS.programs(r.p.row.path));
      }
    };
    const programsAt = (p: ObservedRow): SubmoduleLocation => p.repo?.location ?? { worktree: p.worktree };
    const parentOf = (r: RunRow): [RunRow, SubmoduleLocation][] => (r.parent === null ? [] : [[r.parent, programsAt(r.parent.p)]]);
    const withParent = (r: RunRow): [RunRow, SubmoduleLocation | null][] => [[r, r.p.repo?.location ?? null], ...parentOf(r)];

    // One update process: the `network` policy, the contract §5 limits, and the operation signal. `fail` records the row failure of a nonzero exit.
    const step = async (r: RunRow, args: string[], phase: SubmoduleProgressPhase, remedy: SubmoduleRemedyRequest, firstFetch = false) => {
      let last = counters(r);
      const report = (now: typeof last) => progress.report(phase, (last = now), r.p.row.path);
      report(last);
      const stderr = stepStderr((percent) => report(counters(r, percent)));
      const stall = trackStall(registry, operationId, () => report(last), () => {
        const built = buildSubmoduleRemedy(remedy);
        return built.command === null ? { text: built.text } : { command: built.command, text: built.text };
      });
      // The runner end gives the exit code. A refusal after the start request gives none.
      let exitCode: number | null = null;
      const fail = () => void (r.facts.phase.failedStep = { firstFetch, outputTail: stderr.outputTail(), exitCode, remedy: buildSubmoduleRemedy(remedy) });
      let exit: GitExit;
      try {
        exit = await o.runner.run({
          operationId,
          context: contextOf(w),
          arguments: args,
          environmentPolicy: "network",
          limits: PROCESS_LIMITS.network,
          stdout: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
          stderr,
          signal,
          onActivity: stall.onActivity,
        });
      } catch (error) {
        // A `run` with an aborted signal throws before its start request.
        if (signal.aborted) throw new Halted("canceled");
        if (!(error instanceof RunnerRefusal)) throw error;
        // A refusal after the start request leaves open whether Git ran.
        fail();
        throw new Halted("refused");
      } finally {
        stall.end();
      }
      // Contract §6 "Lingering Jobs": the count never changes the outcome, so an exit without a count shows no lingering sentence.
      lastDescendants = exit.activeDescendants ?? 0;
      exitCode = exit.exitCode;
      if (exit.deadline !== undefined) throw new Halted({ deadline: exit.deadline });
      if (signal.aborted) throw new Halted("canceled");
      if (exit.diagnosticLimit) {
        fail();
        throw new Halted("limit");
      }
      return { ok: exit.exitCode === 0, fail };
    };

    // Contract §12 step 5 "Folder check": entry types and names only, and no process. `gitOnly`: after a connect step, only the `.git` entry may exist.
    const folderCheck = async (r: RunRow, gitOnly: boolean) => {
      await checkpoint("folder-check", r.p.row.path);
      const folder = nativeOf(r.p.worktree, r.p.row.path);
      let stat;
      try {
        stat = await lstat(folder);
      } catch (error) {
        if (isMissing(error)) return;
        throw new RowEnd({ failedRead: "folder" });
      }
      if (stat.isDirectory()) {
        let names: string[];
        try {
          names = await readdir(folder);
        } catch {
          throw new RowEnd({ failedRead: "folder" });
        }
        if (names.every((name) => gitOnly && name === ".git")) return;
      }
      throw refusal("folder-not-empty", REFUSAL_TEXTS.folderNotEmpty(r.p.row.path));
    };

    // Contract §12 step 5 "Clone check": no `.git` entry, and the kept Git directory as the review saw it. A found Git directory gets the check reads.
    const cloneCheck = async (r: RunRow) => {
      const p = r.p;
      await checkpoint("clone-check", p.row.path);
      const kept = keptOf(p);
      const entry = await gitEntry(p, "clone-check");
      const keptFound = !entry && (await exists(kept, "clone-check", p.row.path));
      if (!entry && p.row.action === "clone" && !keptFound) return;
      const found: SubmoduleLocation | null = entry ? { worktree: p.worktree } : keptFound ? { gitDir: kept } : null;
      const head = found === null ? null : need(await observer.head(found), "clone-check").head;
      if (!entry && p.row.action === "reuse" && keptFound && head === null) return;
      // No review read the found Git directory, so the refusal gives no save command.
      if (found !== null && head !== null && !(await refHeld(found, "clone-check"))) throw refusal("unsaved-commits", RUN_TEXTS.foundFolder(p.row.path, head));
      throw refusal("changed-after-review", RUN_TEXTS.changedAfterReview(p.row.path));
    };

    // Contract §12 step 5 "Check": HEAD keeps its review or level-read value, and a ref holds it. False: HEAD changed, so the row ends without a checkout.
    const check = async (r: RunRow, location: SubmoduleLocation) => {
      const head = need(await observer.head(location), "check").head;
      if (head === null || head !== r.p.row.head) return false;
      if (await refHeld(location, "check")) return true;
      const where = "worktree" in location ? { submoduleWorktree: r.p.worktree } : { gitDirectory: location.gitDir };
      throw refusal("unsaved-commits", REFUSAL_TEXTS.unsavedCommits(r.p.row.path, head), buildRefusalRemedy({ reason: "unsaved-commits", source: "run", gitPath, commit: head, wsl, ...where }));
    };

    // Contract §12 step 5 first and fallback fetch. False: the fallback fetch failed, so the row ends without a checkout.
    const fetchTarget = async (r: RunRow, location: { worktree: string }, target: string) => {
      const p = r.p;
      const plain: SubmoduleRemedyRequest = { step: "fetch", gitPath, submoduleWorktree: p.worktree, wsl };
      await gate(r, withParent(r));
      r.facts.phase.fetched = true;
      const first = await step(r, submoduleFetchArgs(p.gitWorktree), "fetch", plain, true);
      if (!first.ok) first.fail();
      if (await reaches(location, target)) return true;
      const { entries } = need(await observer.config(location), "remote-get-url");
      const { headRef } = need(await observer.head(location), "remote-get-url");
      const urls = new Map<string, string[]>();
      for (const name of remoteNames(entries)) urls.set(name, await remoteUrls(location, name));
      let remote: string;
      try {
        if (p.fallbackUrl === null) throw new SubmoduleUrlError("unresolved .gitmodules URL");
        const context = { listing: entries, headRef };
        remote = p.fallbackUrl.url === null ? defaultRemote(context) : fallbackRemote(p.fallbackUrl.url, context, urls, gitVersion);
      } catch (error) {
        if (!(error instanceof SubmoduleUrlError)) throw error;
        throw new RowEnd({ failedRead: "url" });
      }
      const fallback: SubmoduleRemedyRequest = { step: "fallback-fetch", gitPath, submoduleWorktree: p.worktree, remote, target, wsl };
      await gate(r, withParent(r));
      const second = await step(r, submoduleFallbackFetchArgs(p.gitWorktree, remote, target, w.objectFormat), "fetch", fallback);
      if (!second.ok) second.fail();
      return second.ok;
    };

    // Contract §12 step 5: the steps of one row kind. True: the row reached its last step, so its nested level follows.
    const steps = async (r: RunRow): Promise<boolean> => {
      const { p } = r;
      const row = p.row;
      const local = UTF8.decode(p.localPath);
      const at = p.parentGitWorktree;
      const nested = r.parent !== null;
      const update = async (args: string[], kind: "clone" | "connect" | "checkout" | "register") =>
        step(r, args, "update", { step: kind, gitPath, parentWorktree: p.parentWorktree, path: p.localPath, nested, wsl });
      if (row.action === "skip") {
        await gate(r, parentOf(r));
        const x = await update(submoduleRegisterArgs(at, local, nested), "register");
        if (!x.ok) x.fail();
        return false;
      }
      if (row.action === "none") return true;
      const reuse = row.action === "reuse";
      if (reuse) await folderCheck(r, false);
      if (row.action === "clone" || (reuse && row.head === null)) {
        await cloneCheck(r);
        await gate(r, withParent(r));
        r.facts.phase.connected = true;
        const x = await update(submoduleCloneArgs(at, local, nested), "clone");
        if (!x.ok) x.fail();
        return x.ok;
      }
      const target = row.target;
      if (target === null) throw new TypeError("a visited row needs its target");
      const fetches = row.action === "fetch-checkout" || (reuse && p.fetches);
      const worktree = { worktree: p.worktree };
      if (reuse) {
        const kept = { gitDir: keptOf(p) };
        if (!(await check(r, kept))) return false;
        await gate(r, withParent(r));
        r.facts.phase.connected = true;
        const x = await update(submoduleCheckoutArgs(at, local, nested), fetches ? "connect" : "checkout");
        if (x.ok || !fetches) {
          if (!x.ok) x.fail();
          return x.ok;
        }
        // The connect step result that step 5 expects: a `.git` entry, the kept HEAD, and a target that stays unreachable.
        const head = (await gitEntry(p, "check")) ? need(await observer.head(worktree), "check").head : null;
        if (head === null || head !== row.head || (await reaches(worktree, target))) {
          x.fail();
          return false;
        }
      }
      if (fetches) {
        if (!(await fetchTarget(r, worktree, target))) return false;
        if (reuse) await folderCheck(r, true);
      }
      if (!(await check(r, worktree))) return false;
      await gate(r, withParent(r));
      const x = await update(submoduleCheckoutArgs(at, local, nested), "checkout");
      if (!x.ok) x.fail();
      return x.ok;
    };

    const visit = async (r: RunRow): Promise<void> => {
      if (!visitable(r.p)) return;
      if (counted(r.p)) {
        planned.delete(r.p.row.pathBytes);
        r.index = ++visited;
      }
      let reached = false;
      try {
        reached = await steps(r);
      } catch (error) {
        if (!(error instanceof RowEnd)) throw error;
        Object.assign(r.facts.phase, error.end);
      }
      if (!reached) return dropBelow(r.p.pathBytes);
      await nested(r);
    };

    // A plan row keeps its preflight baseline, and the level read gives its old commit, target, and kept Git directory. A found row takes the level baseline.
    const childFacts = (p: ObservedRow, parent: RunRow, config: readonly ConfigEntry[]): RetainedUpdateRow => {
      const known = facts.get(p.row.rowId);
      if (known !== undefined) {
        Object.assign(known, { oldCommit: p.row.head, target: p.row.target, planned: plannedOf(p.row) });
        known.read.kept = keptRead(p);
        return known;
      }
      const added = factsOf(p, rowKeys(config, p.row.name), parent.facts.read);
      facts.set(p.row.rowId, added);
      update.rows.push(added);
      return added;
    };

    // Contract §12 read failures: a failed level read ends each listed nested row `failed` with `level`. The parent row keeps its state.
    const levelFailed = (r: RunRow, links: { path: Uint8Array; oid: string }[]) => {
      const listed = new Map<string, RetainedUpdateRow>();
      for (const p of read.rows) if (p.row.parentRowId === r.p.row.rowId) listed.set(p.row.pathBytes, facts.get(p.row.rowId)!);
      for (const link of links) {
        const bytes = Buffer.concat([r.p.pathBytes, Buffer.from("/"), link.path]);
        const key = bytes.toString("base64");
        if (listed.has(key)) continue;
        const added: RetainedUpdateRow = {
          rowId: crypto.randomUUID(),
          path: displayPath(bytes),
          found: true,
          planned: "unchanged",
          oldCommit: null,
          target: link.oid,
          baseline: {},
          phase: { fetched: false, connected: false },
          read: { components: componentsOf(bytes), name: "", kept: null, parent: r.facts.read },
        };
        update.rows.push(added);
        listed.set(key, added);
      }
      for (const row of listed.values()) row.phase.failedRead = "level";
      dropBelow(r.p.pathBytes);
    };

    // Contract §12 step 6: the nested level after the last step of a row, with its refusals, its active set, and the nested-level program rule.
    const nested = async (r: RunRow): Promise<void> => {
      const { read: level, links } = await observer.level(r.p, async () => {
        await checkpoint("nested-active-set", r.p.row.path);
        const entries = await observer.programsOf(r.p, programsAt(r.p));
        return "value" in entries ? { value: entries.value.every((e) => covered(e, r)) } : entries;
      });
      if ("stop" in level) throw halted(level.stop);
      if (!("value" in level)) return levelFailed(r, links);
      const lv = level.value;
      const children: RunRow[] = lv.rows.map((p) => ({ p, parent: r, facts: childFacts(p, r, lv.config), index: 0 }));
      const byId = new Map(children.map((child) => [child.p.row.rowId, child]));
      const holderOf = (e: ProgramEntry) => ("rowId" in e.program ? (byId.get(e.program.rowId) ?? null) : null);
      // Contract §12 "Trust": a refusal of a kept Git directory without a row, or a program that no confirmation covered, refuses every row of the level.
      const first: SubmoduleRefusal | undefined = lv.unattached[0];
      const all = lv.activeRefused || (first === undefined && !lv.programs.every((e) => covered(e, holderOf(e)))) ? "programs" : first;
      const keys = new Set(children.map((child) => child.p.row.pathBytes));
      for (const [key, e] of planned) {
        if (e.parent !== r.p.row.pathBytes || keys.has(key)) continue;
        planned.delete(key);
        dropBelow(e.bytes);
      }
      for (const child of children) {
        const own = child.p.row.refusal === null ? undefined : lv.byRow.get(child.p.row.rowId);
        const end = all === "programs" ? { reason: "programs" as const, text: RUN_TEXTS.programs(child.p.row.path) } : all !== undefined ? fromReview(all) : own !== undefined ? fromReview(own) : null;
        if (end !== null) {
          child.facts.phase.refusal = end;
          planned.delete(child.p.row.pathBytes);
          dropBelow(child.p.pathBytes);
        } else if (counted(child.p)) planned.set(child.p.row.pathBytes, { bytes: child.p.pathBytes, parent: r.p.row.pathBytes });
      }
      for (const child of children) if (child.facts.phase.refusal === undefined) await visit(child);
    };

    try {
      for (const p of read.rows) if (p.row.depth === 0) await visit({ p, parent: null, facts: facts.get(p.row.rowId)!, index: 0 });
      return { deadline: null, diagnosticLimit: false, refused: false, lingeringDescendants: lastDescendants };
    } catch (error) {
      // A review read with an aborted signal throws before its start request, so a Cancel can end the run that way too.
      if (!(error instanceof Halted) && !signal.aborted) throw error;
      const cause = error instanceof Halted ? error.cause : "canceled";
      return { deadline: typeof cause === "object" ? cause.deadline : null, diagnosticLimit: cause === "limit", refused: cause === "refused", lingeringDescendants: lastDescendants };
    } finally {
      progress.stop();
    }
  }

  async function execute(w: Workspace, installation: ReadInstallation, gitPath: string, gitVersion: string, operationId: string, signal: AbortSignal, key: ApprovalKey, a: UpdateAdmission): Promise<void> {
    let entered: Entered | NotEntered;
    try {
      entered = await o.exclusion.enter({ operationId, kind: "updateSubmodules", workspace: w });
    } catch {
      return void registry.apply(operationId, { type: "exclusion-unavailable", code: "GIT_FAILED" });
    }
    if (!entered.ok) return notEntered(registry, operationId, entered);
    const marker = entered;
    const ctx: ObserveContext = { runner: o.runner, trust: o.trust, reader: o.reader, operationId, signal, workspace: w, installation };
    // Contract §6: `resolved` follows a known outcome.
    const resolved = () => o.runner.resolved(marker.markerId);
    // Contract §12 "Update protocol" steps 2 and 3, decision G11: a refusal starts no update process and no reconciliation read.
    const refuse = (ending: Refused | Stop) => {
      const canceled = enterReconciling(registry, operationId, isStop(ending) && ending.stop === "deadline", 0);
      if (canceled) registry.apply(operationId, { type: "no-effects", observed: "canceled" });
      // Without a code, the outcome takes the recorded DEADLINE cause.
      else if (isStop(ending)) registry.apply(operationId, { type: "no-effects", observed: "failed", ...(ending.stop === "deadline" ? {} : { code: "GIT_FAILED" }) });
      else registry.apply(operationId, { type: "no-effects", observed: "failed", code: ending.code }, ending.path === undefined ? undefined : { path: ending.path });
      resolved();
    };

    try {
      registry.apply(operationId, { type: "marker-recorded" });
      owners.set(operationId, w.repositoryId);
      registry.progress(operationId, "preflight");
      const rowIds = new Map(a.review.value.rows.map((row) => [row.pathBytes, row.rowId]));
      let pre = await preflight(ctx, rowIds, a);
      if (!("observer" in pre)) return refuse(pre);
      if (!approvals.consume(key, operationId)) {
        const now = approvals.accept(key);
        return refuse({ code: !now.ok && "code" in now ? now.code : "UNKNOWN_TARGET" });
      }
      if (pre.read.programs.length > 0) {
        registry.progress(operationId, "submodule-confirmation");
        const reply = await confirmRun(w, installation, pre.read);
        if (signal.aborted) return refuse({ stop: "canceled" });
        if (typeof reply !== "string") return refuse(reply);
        if (reply === "declined") {
          registry.apply(operationId, { type: "program-confirmation-declined" });
          return resolved();
        }
        // Contract §12 "Update protocol" step 3: the same reads and checks after the dialog, which has no time limit.
        registry.progress(operationId, "preflight");
        const again = await preflight(ctx, rowIds, a);
        if (!("observer" in again)) {
          if (signal.aborted || isStop(again) || (again.code !== "STALE_REVIEW" && again.code !== "TRUST_CHANGED")) return refuse(again);
          registry.apply(operationId, { type: "recheck-changed", code: again.code });
          return resolved();
        }
        pre = again;
      }

      const { update, facts } = planOf(pre.read);
      retained.set(operationId, update);
      const end = await run({ ctx, observer: pre.observer, read: pre.read, update, facts, gitPath, gitVersion });
      const remedy = (count: number | null, otherLocks: boolean): SubmoduleUpdateRemedy | null => {
        const text = `${otherLocks ? OTHER_LOCKS_TEXT : ""}${lingeringText(count, o.trust.currentTrustId(w) !== undefined)}`.trimStart();
        return text === "" ? null : { text };
      };
      await reconcileUpdate({
        registry,
        runner: o.runner,
        retained,
        operationId,
        markerId: marker.markerId,
        ctx,
        update,
        head: pre.head,
        canceled: signal.aborted,
        deadline: end.deadline,
        lingeringDescendants: end.lingeringDescendants,
        diagnosticLimit: end.diagnosticLimit,
        refused: end.refused,
        foreign: [],
        remedy,
      });
    } catch {
      // A broken step leaves the outcome unknown. The marker and the retained rows stay (contract §8).
      const state = registry.get(operationId)?.state;
      if (state === "running") registry.apply(operationId, { type: "execution-ended", lingeringDescendants: 0 });
      if (state === "cancel-requested") registry.apply(operationId, { type: "processes-stopped" });
      if (registry.get(operationId)?.state === "reconciling") registry.apply(operationId, { type: "reconciliation-read-failed", code: "GIT_FAILED" }, undefined, "GIT_FAILED");
    } finally {
      // The registry sent `ended` with the terminal response, so this only frees the exclusion slot.
      marker.end(false);
    }
  }

  // Contract §3 `updateSubmodules`. `gitVersion` is the probed version of the Git that runs the update (contract §12 fallback fetch).
  function updateSubmodules(request: UpdateRequest, w: Workspace, installation: ReadInstallation, gitVersion: string | null): void {
    const key: ApprovalKey = { kind: "submodule", reviewToken: request.payload.submoduleReviewToken };
    // Contract §2: a review token that an accepted operation consumed answers a repeat with that operation, without an accepted event or a process.
    const peek = approvals.accept(key);
    if (!peek.ok && "consumed" in peek && owners.get(peek.consumed) === request.repositoryId) {
      return void o.respond({ requestId: request.requestId, operationId: peek.consumed, state: "succeeded", result: registry.get(peek.consumed) });
    }
    const { operationId, signal } = registry.start("updateSubmodules", request.requestId);
    const admitted = admitUpdate(request, w, approvals.accept(key), o.reviews.retained);
    if ("code" in admitted) return void registry.apply(operationId, { type: "invalid-approval", code: admitted.code }, admitted.result);
    // A Windows workspace with a selected Git has both, and so does a WSL workspace.
    const gitPath = pathForms(w, installation).gitPath;
    if (gitPath === null || gitVersion === null) return void registry.apply(operationId, { type: "invalid-approval", code: "SERVICE_UNAVAILABLE" });
    void execute(w, installation, gitPath, gitVersion, operationId, signal, key, admitted);
  }

  return { updateSubmodules, retained, owners };
}

export type SubmoduleUpdater = ReturnType<typeof createSubmoduleUpdater>;
