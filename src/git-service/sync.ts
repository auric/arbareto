// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 003 contract Δ3 `sync` steps 1 to 7 for `fetch`, `fetch-all`, `push`, and `force-push`, data-model §4, §5, §8, and §11, and plan.md D2 to D5.
// Cancel is never rollback. Each outcome comes from exit codes, porcelain fields, and the listings before and after the network steps.

import type { Response, ServiceRequest } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, SYNC_REFS_BYTES } from "../contracts/limits";
import { isWindows } from "../contracts/native-path";
import type { OperationEvent } from "../contracts/outcome";
import { buildRemedyCommand } from "../contracts/remedy-command";
import { redactUrlUserInfo, type StallRemedy } from "../contracts/submodules";
import type { ApprovalKey, Approvals, SyncReview } from "./approvals";
import type { Entered, Exclusion, MutationEntry, NotEntered } from "./exclusion";
import { createCollector, PROCESS_LIMITS, RunnerRefusal, type GitExit, type GitRunner, type PageantReply, type SyncRunner } from "./git-runner";
import { captureHead } from "./history";
import { enterReconciling, isStop, notEntered, settled, type Failure, type ObserveContext, type Stop } from "./hunk-publish";
import type { OperationRegistry } from "./operations";
import { contextOf } from "./read-steps";
import type { Workspace } from "./registration";
import type { ReadInstallation } from "./snapshot";
import { trackStall } from "./stall";
import type { WorkspaceReader } from "./status";
import { stepStderr } from "./submodule-update";
import { fetchArgs, pushArgs, upstreamArgs } from "./sync-commands";
import { runIntegration, type StepPhase } from "./sync-integrate";
import { createFetchParser, FETCH_FLAGS, parsePushPorcelain, type FetchFlag, type FetchList, type FetchUpdate, type PushStatus } from "./sync-parsers";
import { lastValue, listRefs, observeSync, refKey, refText, type Observation, type SyncBinding } from "./sync-review";
import type { ConfigEntry, Trust } from "./trust";
import { processEnd } from "./wsl-files";

// Contract Δ3 "Remedies".
export const STEP_REMEDY_TEXT = "This command runs the step in a terminal, where Git and SSH can ask for input. Then use the action again.";
// Contract Δ8.
export const CANCELED_PUSH_TEXT = "The remote can hold this push. Fetch to see the remote state.";
// Contract Δ3 Set upstream.
export const UPSTREAM_REMEDY_TEXT = "The push succeeded, but Arbareto could not set the upstream. This command sets it.";

const HEADS = "refs/heads/";
const ZERO_OID = /^0+$/;
const SUCCESS: readonly PushStatus[] = ["pushed", "forced", "created", "up-to-date"];

type SyncRequest = Extract<ServiceRequest, { operation: "sync" }>;
type Refs = Map<string, string>;
export type Remedy = { text: string; command: string | null };

// Data-model §11: the target of Connect in a terminal for the last failed `sync` of a workspace.
export interface ConnectTarget {
  operationId: string;
  kind: "remote" | "url";
  repositoryId: string;
  gitInstallationId: string;
  target: string;
}

export interface SyncerOptions {
  runner: GitRunner & SyncRunner;
  trust: Trust;
  reader: Pick<WorkspaceReader, "operationState">;
  approvals: Approvals;
  registry: OperationRegistry;
  exclusion: Exclusion;
  respond: (response: Response) => unknown;
}

// One network step. `exit` is null when the step started no process or the runner refused it after the start request.
export interface StepEnd {
  exit: GitExit | null;
  canceled: boolean;
  refused: ErrorCode | null;
  outputTail: string;
}

// Data-model §4: one remote of a fetch result.
export interface FetchRemote {
  name: string;
  state: "succeeded" | "failed" | "canceled" | "deadline" | "not-started";
  updates: FetchUpdate[];
  counts: Record<FetchFlag, number>;
  outputTail: string;
}

const noCounts = () => Object.fromEntries(FETCH_FLAGS.map((flag) => [flag, 0])) as Record<FetchFlag, number>;
export const notStarted = (name: string): FetchRemote => ({ name, state: "not-started", updates: [], counts: noCounts(), outputTail: "" });

// The facts of one remote fetch step of fetch, fetch-all, and pull. `end` is null when no fetch process started.
// `stop`: contract Δ3 `sync` step 6, so no later step starts.
export interface FetchStep {
  end: StepEnd | null;
  all: FetchUpdate[];
  malformed: boolean;
  limit: "deadline" | "output" | null;
  refused: ErrorCode | null;
  putty: Extract<PageantReply, { result: "failed" }> | null;
  stop: boolean;
}

// The failure facts of the fetch remotes, aggregated over their steps.
export interface FetchFacts {
  malformed: ReadonlySet<string>;
  limit: "deadline" | "output" | null;
  putty: Extract<PageantReply, { result: "failed" }> | null;
  refused: ErrorCode | null;
}

// Data-model §8 for the fetch remotes. `failedRemote` keeps the fetch remedy and the connect target.
// `code` is the code of a failure without effects. Undefined takes the recorded DEADLINE cause.
export function fetchVerdict(remotes: readonly FetchRemote[], f: FetchFacts, aborted: boolean): { failedRemote: FetchRemote | undefined; stopped: boolean; failed: boolean; code: ErrorCode | undefined } {
  // Contract Δ3: a broken porcelain line makes the list MALFORMED_GIT_OUTPUT, not a failed remote.
  const failedRemote = remotes.find((r) => (r.state === "failed" && !f.malformed.has(r.name)) || r.state === "deadline");
  const stopped = remotes.some((r) => r.state === "canceled") || (aborted && remotes.some((r) => r.state === "not-started"));
  const failed = f.putty !== null || f.refused !== null || failedRemote !== undefined || f.malformed.size > 0 || f.limit !== null || stopped;
  const code: ErrorCode | undefined =
    f.putty !== null ? "PUTTY_UNAVAILABLE" : (f.refused ?? (f.limit === "deadline" ? undefined : f.limit === "output" ? "OUTPUT_LIMIT" : failedRemote === undefined ? "MALFORMED_GIT_OUTPUT" : "GIT_FAILED"));
  return { failedRemote, stopped, failed, code };
}

// The contract parser over the whole stdout. Null: a broken line.
function fetchLines(bytes: Uint8Array, objectFormat: Workspace["objectFormat"]): FetchList | null {
  const parser = createFetchParser(objectFormat);
  parser.push(bytes);
  return parser.end();
}

// The refs whose values differ between two listings, in byte order of their names.
export function changes(before: Refs, after: Refs): { ref: string; oldObjectId: string | null; newObjectId: string | null }[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort((a, b) => Buffer.compare(Buffer.from(a, "latin1"), Buffer.from(b, "latin1")));
  return keys.map((k) => ({ ref: refText(k), oldObjectId: before.get(k) ?? null, newObjectId: after.get(k) ?? null }));
}

// Data-model §4 `observed`: the listing after against the listing before with every porcelain line applied.
export function fetchObserved(before: Refs, all: readonly FetchUpdate[], after: Refs): ReturnType<typeof changes> {
  const expected = new Map(before);
  for (const u of all) {
    if (u.flag === "=" || u.flag === "!") continue;
    if (ZERO_OID.test(u.newObjectId)) expected.delete(refKey(u.ref));
    else expected.set(refKey(u.ref), u.newObjectId);
  }
  return changes(expected, after);
}

// remote.c `query_refspecs` and refspec.c `match_name_with_pattern`: the first fetch refspec of `remote` whose source matches `dst` names the tracking ref.
// A matching negative refspec names none (remote.c `omit_name_by_refspec`). Git's push updates this ref (transport.c `transport_update_tracking_ref`).
export function trackingOf(entries: readonly ConfigEntry[], remote: string, dst: string): string | null {
  const specs = entries.filter((e) => e.key === `remote.${remote}.fetch` && e.value !== null).map((e) => e.value!);
  const match = (src: string, dstPattern: string | null): string | null => {
    const star = src.indexOf("*");
    if (star < 0) return src === dst ? dstPattern : null;
    const prefix = src.slice(0, star);
    const suffix = src.slice(star + 1);
    if (dst.length < prefix.length + suffix.length || !dst.startsWith(prefix) || !dst.endsWith(suffix)) return null;
    return dstPattern === null ? "" : dstPattern.replace("*", dst.slice(prefix.length, dst.length - suffix.length));
  };
  if (specs.some((s) => s.startsWith("^") && match(s.slice(1), null) !== null)) return null;
  for (const spec of specs) {
    if (spec.startsWith("^")) continue;
    const body = spec.startsWith("+") ? spec.slice(1) : spec;
    const colon = body.indexOf(":");
    if (colon < 0 || colon === body.length - 1) continue;
    const found = match(body.slice(0, colon), body.slice(colon + 1));
    if (found !== null) return found;
  }
  return null;
}

// Contract §7 "URL user information": a remedy for such a URL is text only (contract Δ3 "Remedies").
const holdsUserInfo = (entries: readonly ConfigEntry[], remote: string, extra: readonly string[] = []) =>
  [...entries.filter((e) => (e.key === `remote.${remote}.url` || e.key === `remote.${remote}.pushurl`) && e.value !== null).map((e) => e.value!), ...extra].some((url) => redactUrlUserInfo(url) !== url);

// A refusal before any step of a marked mutation: no effect, so the outcome is known.
export type Ending = { code: ErrorCode; reason?: Failure["reason"]; result?: unknown } | Stop;

export interface Marked<C extends ObserveContext> {
  ctx: C;
  // Contract §8: a cancel never stops a reconciliation read, so `q` reads with a signal that never aborts.
  q: C;
  refuse(ending: Ending): void;
  // Sends `resolved` for a known outcome. An unknown outcome keeps the marker (contract §8).
  resolved(): void;
}

// Contract §6 "Recovery markers" and §8: the lifecycle of one marked mutation of `sync` and feature 004 `runWorkbench`.
// A throw from `body` leaves the outcome unknown, and the marker stays.
export async function runMarked<C extends ObserveContext>(o: { registry: OperationRegistry; exclusion: Exclusion; runner: Pick<GitRunner, "resolved"> }, entry: MutationEntry, ctx: C, body: (m: Marked<C>) => Promise<void>): Promise<void> {
  const { registry } = o;
  const { operationId } = entry;
  let entered: Entered | NotEntered;
  try {
    entered = await o.exclusion.enter(entry);
  } catch {
    return void registry.apply(operationId, { type: "exclusion-unavailable", code: "GIT_FAILED" });
  }
  if (!entered.ok) return notEntered(registry, operationId, entered);
  const marker = entered;
  const resolved = () => o.runner.resolved(marker.markerId);
  const refuse = (ending: Ending) => {
    const canceled = enterReconciling(registry, operationId, isStop(ending) && ending.stop === "deadline", 0);
    if (canceled) registry.apply(operationId, { type: "no-effects", observed: "canceled" });
    else if (isStop(ending)) registry.apply(operationId, { type: "no-effects", observed: "failed", ...(ending.stop === "deadline" ? {} : { code: "GIT_FAILED" }) });
    else registry.apply(operationId, { type: "no-effects", observed: "failed", code: ending.code, ...(ending.code === "OUTPUT_LIMIT" && ending.reason !== undefined ? { reason: ending.reason } : {}) }, ending.result);
    resolved();
  };
  try {
    registry.apply(operationId, { type: "marker-recorded" });
    registry.progress(operationId, "preflight");
    await body({ ctx, q: { ...ctx, signal: new AbortController().signal }, refuse, resolved });
  } catch {
    const state = registry.get(operationId)?.state;
    if (state === "running") registry.apply(operationId, { type: "execution-ended", lingeringDescendants: 0 });
    if (state === "cancel-requested") registry.apply(operationId, { type: "processes-stopped" });
    if (registry.get(operationId)?.state === "reconciling") registry.apply(operationId, { type: "reconciliation-read-failed", code: "GIT_FAILED" }, undefined, "GIT_FAILED");
  } finally {
    marker.end(false);
  }
}

export function createSyncer(o: SyncerOptions) {
  const { registry, approvals } = o;
  // Contract §2: the workspace of each operation that consumed a review token.
  const owners = new Map<string, string>();
  const connectTargets = new Map<string, ConnectTarget>();

  async function execute(w: Workspace, installation: ReadInstallation, operationId: string, signal: AbortSignal, key: ApprovalKey, approval: SyncReview): Promise<void> {
    const b = approval.binding;
    const context: ObserveContext = { runner: o.runner, trust: o.trust, reader: o.reader, operationId, signal, workspace: w, installation };
    await runMarked(o, { operationId, kind: "sync", action: b.payload.action, workspace: w }, context, (m) => steps(m, w, installation, operationId, signal, key, b));
  }

  async function steps({ ctx, q, refuse, resolved }: Marked<ObserveContext>, w: Workspace, installation: ReadInstallation, operationId: string, signal: AbortSignal, key: ApprovalKey, b: SyncBinding): Promise<void> {
    let lastDescendants = 0;
    // The `pageant` replies of this operation. A reply other than `git` keeps a connect target for a failure (data-model §11).
    const replies: PageantReply["result"][] = [];
    // The end of a run that started network processes. Data-model §11: `connectTarget` comes from the kept target itself.
    const finish = (event: OperationEvent, result: unknown, known = true, cause?: ErrorCode) => {
      const kept = connectTargets.get(w.repositoryId)?.operationId === operationId;
      registry.apply(operationId, event, kept ? { ...(result as object), connectTarget: true } : result, cause);
      if (known) resolved();
    };
    const unknown = (f: Failure | Stop, result: unknown) =>
      finish("code" in f ? { type: "reconciliation-read-failed", code: f.code } : { type: "reconciliation-read-deadline" }, result, false, "code" in f ? f.code : "DEADLINE");

    // Contract Δ3 `sync` step 3. Null: a WSL Git or a non-Windows service sends no `pageant`.
    const pageant = async (remote: string, counters: Record<string, number>): Promise<PageantReply | null> => {
      if (!isWindows || w.wsl !== undefined) return null;
      registry.progress(operationId, "pageant", counters);
      const reply = await o.runner.pageant({ operationId, repositoryId: w.repositoryId, remote });
      replies.push(reply.result);
      return reply;
    };
    const keepTarget = (kind: ConnectTarget["kind"], target: string) => {
      if (replies.length > 0 && replies.some((r) => r !== "git")) connectTargets.set(w.repositoryId, { operationId, kind, repositoryId: w.repositoryId, gitInstallationId: installation.gitInstallationId, target });
    };
    const remedyOf = (template: string, values: Record<string, string>, userInfo: boolean): Remedy => {
      const git = installation.selectedPath;
      if (userInfo || git === null || w.wsl !== undefined) return { text: STEP_REMEDY_TEXT, command: null };
      const built = buildRemedyCommand(template, {
        git: { kind: "gitPath", text: git, form: "windows" },
        root: { kind: "worktreeRoot", text: w.worktreeRoot, form: "windows" },
        ...Object.fromEntries(Object.entries(values).map(([name, text]) => [name, { kind: name === "remote" ? ("remoteName" as const) : ("branchName" as const), text }])),
      });
      return { text: STEP_REMEDY_TEXT, command: built.command };
    };
    // Contract Δ3 "Remedies": one `config --local` command per `upstreamArgs` write, with its key and value.
    const upstreamRemedy = (writes: readonly string[][]): Remedy => {
      const template = writes.map((_, i) => `& {git} --no-lazy-fetch -C {root} config --local -- {key${i}} {value${i}}`).join("; ");
      const values = Object.fromEntries(writes.flatMap((args, i) => [[`key${i}`, args.at(-2)!], [`value${i}`, args.at(-1)!]]));
      return { ...remedyOf(template, values, false), text: UPSTREAM_REMEDY_TEXT };
    };
    const stallOf = (remedy: Remedy): StallRemedy => (remedy.command === null ? { text: remedy.text } : { command: remedy.command, text: remedy.text });

    // One `remote` or `integrate` policy process with the 001 §12 network limits (contract Δ5, plan.md D2).
    const networkStep = async (args: string[], phase: StepPhase, counters: Record<string, number>, remedy: Remedy, stdout: ReturnType<typeof createCollector>, policy: "remote" | "integrate" = "remote"): Promise<StepEnd> => {
      let percent: number | undefined;
      const report = () => {
        const state = registry.get(operationId)?.state;
        if (state === "running" || state === "cancel-requested") registry.progress(operationId, phase, { ...counters, ...(percent === undefined ? {} : { percent }) });
      };
      report();
      const stderr = stepStderr((next) => {
        if (next === percent) return;
        percent = next;
        report();
      });
      const stall = trackStall(registry, operationId, report, () => stallOf(remedy));
      let exit: GitExit | null = null;
      let refused: ErrorCode | null = null;
      try {
        exit = await o.runner.run({ operationId, context: contextOf(w), arguments: args, environmentPolicy: policy, limits: PROCESS_LIMITS.network, stdout, stderr, signal, onActivity: stall.onActivity });
        lastDescendants = exit.activeDescendants ?? 0;
      } catch (error) {
        if (!signal.aborted && !(error instanceof RunnerRefusal)) throw error;
        if (!signal.aborted) refused = (error as RunnerRefusal).code;
      } finally {
        stall.end();
      }
      return { exit, canceled: signal.aborted && (exit === null || exit.exitCode === null), refused, outputTail: stderr.outputTail() };
    };

    // Contract Δ3 Set upstream: the `upstreamArgs` writes in order. Only exit 0 of each write means set. A Cancel starts no later write.
    // `ends` holds a null exit for a start that the runner refused.
    const writeUpstream = async (writes: readonly string[][]): Promise<{ set: boolean; ends: { exit: GitExit | null }[] }> => {
      const ends: { exit: GitExit | null }[] = [];
      for (const args of writes) {
        if (signal.aborted) return { set: false, ends };
        let exit: GitExit | null = null;
        try {
          const stdout = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
          const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
          exit = await o.runner.run({ operationId, context: contextOf(w), arguments: args, environmentPolicy: "remote", limits: PROCESS_LIMITS.network, stdout, stderr, signal });
          lastDescendants = exit.activeDescendants ?? 0;
        } catch (error) {
          if (!signal.aborted && !(error instanceof RunnerRefusal)) throw error;
        }
        ends.push({ exit });
        if (exit?.exitCode !== 0) return { set: false, ends };
      }
      return { set: true, ends };
    };

    // Contract §11 and 001 §12: after a stopped WSL process, Linux Git can still write. No listing decides before the process-end fact.
    const processEnded = async (ends: readonly { exit: GitExit | null }[]) => w.wsl === undefined || ends.every((e) => e.exit !== null && e.exit.exitCode !== null) || (await processEnd(q)) === "fact";

    // Contract Δ3 "Remedies": the fetch remedy of one remote.
    const fetchRemedy = (entries: readonly ConfigEntry[], remote: string): Remedy => remedyOf("& {git} --no-lazy-fetch -C {root} fetch -- {remote}", { remote }, holdsUserInfo(entries, remote));

    // Contract Δ3 `sync` steps 3 and 5 for one remote of fetch, fetch-all, and pull: `pageant`, the fetch process, its porcelain lines, and the remote state.
    const fetchStep = async (remote: FetchRemote, counters: Record<string, number>, entries: readonly ConfigEntry[]): Promise<FetchStep> => {
      const none: FetchStep = { end: null, all: [], malformed: false, limit: null, refused: null, putty: null, stop: true };
      const reply = await pageant(remote.name, counters).catch((error: unknown) => {
        if (error instanceof RunnerRefusal) return { result: "refused" as const, code: error.code };
        throw error;
      });
      if (reply !== null && reply.result === "refused") return { ...none, refused: reply.code };
      if (reply !== null && reply.result === "failed") return { ...none, putty: reply };
      if (signal.aborted) return none;
      const out = createCollector({ maxBytes: SYNC_REFS_BYTES });
      const end = await networkStep(fetchArgs(remote.name), "sync-fetch", counters, fetchRemedy(entries, remote.name), out);
      remote.outputTail = end.outputTail;
      const lines = end.exit === null || out.limited ? null : fetchLines(out.take(), w.objectFormat);
      if (lines !== null) {
        remote.updates = lines.updates;
        remote.counts = lines.counts;
      }
      if (end.canceled) remote.state = "canceled";
      else if (end.exit?.deadline !== undefined) remote.state = "deadline";
      else remote.state = end.exit?.exitCode === 0 && lines !== null ? "succeeded" : "failed";
      const limit = end.exit?.deadline !== undefined ? "deadline" : end.exit?.diagnosticLimit || out.limited ? "output" : null;
      const malformed = lines === null && end.exit?.exitCode === 0 && !out.limited;
      return { end, all: lines?.all ?? [], malformed, limit, refused: end.refused, putty: null, stop: end.canceled || limit !== null || end.refused !== null };
    };

    // ---- fetch and fetch-all (data-model §4 and §8) ----
    const runFetch = async (entries: readonly ConfigEntry[]) => {
      const before = await listRefs(ctx);
      if (!("value" in before)) return refuse(before);
      const remotes = b.remotes.map(notStarted);
      const all: FetchUpdate[] = [];
      const ends: StepEnd[] = [];
      // Contract Δ3: a broken porcelain line makes the list of that remote MALFORMED_GIT_OUTPUT. The listings still decide the effects.
      const malformed = new Set<string>();
      let limit: "deadline" | "output" | null = null;
      let putty: Extract<PageantReply, { result: "failed" }> | null = null;
      let refusedCode: ErrorCode | null = null;
      for (const [i, remote] of remotes.entries()) {
        if (signal.aborted) break;
        const step = await fetchStep(remote, { remoteIndex: i + 1, remoteCount: remotes.length }, entries);
        if (step.end !== null) ends.push(step.end);
        all.push(...step.all);
        if (step.malformed) malformed.add(remote.name);
        refusedCode ??= step.refused;
        putty ??= step.putty;
        limit ??= step.limit;
        if (step.stop) break;
      }
      if (ends.length === 0 && remotes.length > 0) {
        if (putty !== null) return refuse({ code: "PUTTY_UNAVAILABLE", result: { reason: putty.reason, program: putty.program, path: putty.path } });
        if (refusedCode !== null) return refuse({ code: refusedCode });
        return refuse({ stop: "canceled" });
      }
      enterReconciling(registry, operationId, ends.at(-1)?.exit?.deadline !== undefined, lastDescendants);
      const fetch = (observed: ReturnType<typeof changes>) => ({ remotes: remotes.map((r) => ({ ...r })), observed });
      const unread = { action: b.payload.action, fetch: fetch([]) };
      if (!(await processEnded(ends))) return unknown({ code: "GIT_FAILED" }, unread);
      const [after, head, state] = await Promise.all([listRefs(q), settled(q.signal, captureHead(q.runner, q)), settled(q.signal, q.reader.operationState(q, false))]);
      if (!("value" in after)) return unknown(after, unread);
      if (isStop(head) || "code" in head) return unknown(head, unread);
      if ("failed" in head) return unknown({ code: head.failed }, unread);
      if (typeof state === "object") return unknown("refused" in state ? { code: state.refused } : state, unread);
      if (state === "canceled" || state === "deadline") return unknown({ stop: "deadline" }, unread);

      const observed = fetchObserved(before.value, all, after.value);
      const moved = !Bun.deepEquals(head, b.head, true) || state !== b.operationState;
      const changed = changes(before.value, after.value).length > 0 || moved;
      const { failedRemote, stopped, failed, code } = fetchVerdict(remotes, { malformed, limit, putty, refused: refusedCode }, signal.aborted);
      const remedy = failedRemote === undefined || stopped ? undefined : fetchRemedy(entries, failedRemote.name);
      // Contract Δ9: `PUTTY_UNAVAILABLE` names the program and its path, also after a fetched remote.
      const puttyFacts = putty === null ? {} : { reason: putty.reason, program: putty.program, path: putty.path };
      const result = { action: b.payload.action, fetch: fetch(observed), ...(remedy === undefined ? {} : { remedy }), ...puttyFacts };
      if (failed) {
        if (failedRemote !== undefined) keepTarget("remote", failedRemote.name);
        if (changed) return finish({ type: "failed-with-effects" }, result);
        if (stopped) return finish({ type: "no-effects", observed: "canceled" }, result);
        return finish({ type: "no-effects", observed: "failed", ...(code === undefined ? {} : { code }) }, result);
      }
      return finish(observed.length > 0 || moved ? { type: "differing-effects" } : { type: "intended-effects-confirmed" }, result);
    };

    // ---- push and force-push (data-model §5 and §8) ----
    const runPush = async (entries: readonly ConfigEntry[]) => {
      const d = b.destination!;
      const head = b.head as Extract<SyncBinding["head"], { state: "branch" }>;
      const branch = head.target.slice(HEADS.length);
      const before = await listRefs(ctx);
      if (!("value" in before)) return refuse(before);
      const reply = await pageant(d.remote, {}).catch((error: unknown) => {
        if (error instanceof RunnerRefusal) return { result: "refused" as const, code: error.code };
        throw error;
      });
      if (reply !== null && reply.result === "refused") return refuse({ code: reply.code });
      if (reply !== null && reply.result === "failed") return refuse({ code: "PUTTY_UNAVAILABLE", result: { reason: reply.reason, program: reply.program, path: reply.path } });
      if (signal.aborted) return refuse({ stop: "canceled" });
      const refspec = `${HEADS}${branch}:${d.ref}`;
      const lease = b.lease?.expect ?? null;
      const userInfo = holdsUserInfo(entries, d.remote, [d.url]);
      const remedy =
        lease === null
          ? remedyOf("& {git} --no-lazy-fetch -C {root} push -- {remote} {refspec}", { remote: d.remote, refspec }, userInfo)
          : remedyOf("& {git} --no-lazy-fetch -C {root} push --force-with-lease={lease} -- {remote} {refspec}", { lease: `${d.ref}:${lease}`, remote: d.remote, refspec }, userInfo);
      const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
      const end = await networkStep(pushArgs(d.remote, branch, d.ref, lease, w.objectFormat), "sync-push", {}, remedy, out);
      const deadline = end.exit?.deadline !== undefined;
      const exited = end.exit !== null && end.exit.exitCode !== null && !out.limited && !end.exit.diagnosticLimit && !deadline;
      const line = exited ? parsePushPorcelain(out.take(), refspec, end.exit!.exitCode!) : null;
      const status: PushStatus = line?.status ?? "none";
      const succeeded = exited && SUCCESS.includes(status);
      // Contract Δ3 Set upstream: only after a successful push, with the bound keys. A failed write leaves the push succeeded.
      const writes = upstreamArgs(branch, d.remote, d.ref, d.upstreamRebase);
      const upstream = succeeded && d.setUpstream ? await writeUpstream(writes) : { set: true, ends: [] };
      const upstreamNotSet = !upstream.set;
      enterReconciling(registry, operationId, deadline, lastDescendants);
      const tracking = d.trackingRef ?? trackingOf(entries, d.remote, d.ref);
      const pushResult = (after: Refs | null, upstreamWritten: boolean) => ({
        status,
        oldObjectId: tracking === null ? null : (before.value.get(refKey(tracking)) ?? null),
        newObjectId: tracking === null || after === null ? null : (after.get(refKey(tracking)) ?? null),
        reasonText: line?.reasonText ?? null,
        lease: lease !== null,
        upstreamWritten,
        upstreamNotSet,
        outputTail: end.outputTail,
      });
      if (!(await processEnded([end, ...upstream.ends]))) return unknown({ code: "GIT_FAILED" }, { action: b.payload.action, push: pushResult(null, false) });
      const [after, observedHead, state, listed] = await Promise.all([
        listRefs(q),
        settled(q.signal, captureHead(q.runner, q)),
        settled(q.signal, q.reader.operationState(q, false)),
        settled(q.signal, o.trust.listTrust({ operationId, signal: q.signal, workspace: w })),
      ]);
      const failed = { action: b.payload.action, push: pushResult(null, false) };
      if (!("value" in after)) return unknown(after, failed);
      if (isStop(observedHead) || "code" in observedHead) return unknown(observedHead, failed);
      if ("failed" in observedHead) return unknown({ code: observedHead.failed }, failed);
      if (typeof state === "object") return unknown("refused" in state ? { code: state.refused } : state, failed);
      if (state === "canceled" || state === "deadline") return unknown({ stop: "deadline" }, failed);
      if (!("ok" in listed)) return unknown(listed, failed);
      if (!listed.ok) return unknown("stop" in listed ? { stop: listed.stop } : { code: listed.code }, failed);

      // Data-model §5 `upstreamWritten`: the values of `branch.<name>.remote`, `.merge`, or `.rebase` changed.
      const upstreamKeys = [`branch.${branch}.remote`, `branch.${branch}.merge`, `branch.${branch}.rebase`];
      const upstreamOf = (list: readonly ConfigEntry[]) => upstreamKeys.map((k) => list.filter((e) => e.key === k).map((e) => e.value));
      const upstreamWritten = !Bun.deepEquals(upstreamOf(entries), upstreamOf(listed.listing.entries), true);
      // FR-018: Git's push sets the tracking ref of the destination to the pushed commit.
      const expected = new Map(before.value);
      if (succeeded && tracking !== null) expected.set(refKey(tracking), head.oid);
      const stateChanged = !Bun.deepEquals(observedHead, b.head, true) || state !== b.operationState;
      const changed = changes(before.value, after.value).length > 0 || stateChanged || upstreamWritten;
      const result = { action: b.payload.action, push: pushResult(after.value, upstreamWritten) };
      if (succeeded) {
        const unexpected = changes(expected, after.value).length > 0 || stateChanged || (upstreamWritten && !d.setUpstream);
        const done = upstreamNotSet ? { ...result, remedy: upstreamRemedy(writes) } : result;
        return finish(unexpected ? { type: "differing-effects" } : { type: "intended-effects-confirmed" }, done);
      }
      if (end.canceled) {
        if (changed) return finish({ type: "failed-with-effects" }, result);
        return finish({ type: "no-effects", observed: "canceled" }, { ...result, remedy: { text: CANCELED_PUSH_TEXT, command: null } });
      }
      keepTarget("url", d.url);
      if (changed) return finish({ type: "failed-with-effects" }, { ...result, remedy });
      if (status === "rejected" || status === "remote-rejected" || status === "remote-failure") {
        // Contract Δ3 and Δ9: a `[rejected]` status of a push with a lease means that the remote changed.
        const reason = status !== "rejected" ? status : lease === null ? "rejected" : "stale-lease";
        return finish({ type: "no-effects", observed: "failed", code: "PUSH_REJECTED" }, { ...result, reason });
      }
      const code: ErrorCode | undefined = deadline ? undefined : end.refused ?? (out.limited || end.exit?.diagnosticLimit ? "OUTPUT_LIMIT" : exited && line === null ? "MALFORMED_GIT_OUTPUT" : "GIT_FAILED");
      return finish({ type: "no-effects", observed: "failed", ...(code === undefined ? {} : { code }) }, { ...result, remedy });
    };

    owners.set(operationId, w.repositoryId);
    // Contract Δ3 `sync` step 2: every bound value again, from an own trust listing.
    const again = await observeSync(ctx, b.payload, () => o.trust.listTrust({ operationId, signal, workspace: w }));
    const stale = staleOf(b, again);
    if (stale !== null) return refuse(stale);
    // Research R4 step 4: the token is consumed only after validation.
    if (!approvals.consume(key, operationId)) {
      const now = approvals.accept(key);
      return refuse({ code: !now.ok && "code" in now ? now.code : "UNKNOWN_TARGET" });
    }
    const entries = (again as Extract<Observation, { binding: unknown }>).entries;
    if (b.payload.action === "fetch" || b.payload.action === "fetch-all") await runFetch(entries);
    else if (b.payload.action === "push" || b.payload.action === "force-push") await runPush(entries);
    else {
      const enter = (deadline: boolean) => enterReconciling(registry, operationId, deadline, lastDescendants);
      await runIntegration({ ctx, q, binding: b, entries, refuse, finish, unknown, enter, step: networkStep, remedyOf, processEnded, keepTarget, fetchStep, fetchRemedy, notStarted, fetchVerdict, fetchObserved, changes });
    }
  }

  // Contract Δ3 `sync`. `installation` is the Git of the workspace.
  function sync(request: SyncRequest, w: Workspace, installation: ReadInstallation): void {
    const key: ApprovalKey = { kind: "sync", reviewToken: request.payload.syncReviewToken };
    // Contract §2: a consumed token answers a repeat with its operation, without an accepted event or a process.
    const peek = approvals.accept(key);
    if (!peek.ok && "consumed" in peek && owners.get(peek.consumed) === request.repositoryId) {
      return void o.respond({ requestId: request.requestId, operationId: peek.consumed, state: "succeeded", result: registry.get(peek.consumed) });
    }
    const { operationId, signal } = registry.start("sync", request.requestId);
    const accepted = approvals.accept(key);
    if (!accepted.ok) return void registry.apply(operationId, { type: "invalid-approval", code: "code" in accepted ? accepted.code : "UNKNOWN_TARGET" });
    const approval = accepted.approval;
    if (approval.kind !== "sync" || approval.repositoryId !== request.repositoryId) return void registry.apply(operationId, { type: "invalid-approval", code: "UNKNOWN_TARGET" });
    // Contract Δ7 "Mutation trust": the reviewed listing decides before any process.
    const t = approval.binding.trust;
    const gate = o.trust.gate(w, { approvalRequired: { sync: t.sync }, fingerprint: t.fingerprint, inputLimited: false }, installation, "sync");
    if (gate !== null) return void registry.apply(operationId, { type: "invalid-approval", code: gate });
    void execute(w, installation, operationId, signal, key, approval);
  }

  return {
    sync,
    owners,
    // Data-model §11: T055 reads it for `connectInTerminal`.
    connectTarget: (repositoryId: string): ConnectTarget | undefined => connectTargets.get(repositoryId),
    release(repositoryId: string): void {
      connectTargets.delete(repositoryId);
    },
  };
}

// Contract Δ3 `sync` step 2 and data-model §2: a trust difference gives TRUST_REQUIRED or TRUST_CHANGED, any other difference STALE_REVIEW.
// A fingerprint difference is a trust difference only when `approvalRequired.sync` holds on either side, as for 001 reads.
// Plan.md D7: an unmerged entry gives CONFLICTED with the count at `sync` too.
function staleOf(b: SyncBinding, again: Observation): { code: ErrorCode; reason?: Failure["reason"]; result?: unknown } | Stop | null {
  if (isStop(again)) return again;
  if ("code" in again) return again;
  if ("refused" in again && again.refused === "CONFLICTED") return { code: "CONFLICTED", result: { unmerged: again.unmerged } };
  if ("refused" in again) return again.refused === "TRUST_REQUIRED" || again.refused === "TRUST_CHANGED" ? { code: again.refused } : { code: "STALE_REVIEW" };
  if ("panel" in again) return { code: "STALE_REVIEW" };
  if ((b.trust.sync || again.binding.trust.sync) && again.binding.trust.fingerprint !== b.trust.fingerprint) return { code: "TRUST_CHANGED" };
  const { trust: _bound, ...bound } = b;
  const { trust: _now, ...now } = again.binding;
  return Bun.deepEquals(bound, now, true) ? null : { code: "STALE_REVIEW" };
}

export type Syncer = ReturnType<typeof createSyncer>;
