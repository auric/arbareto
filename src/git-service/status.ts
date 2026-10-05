// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §3 `readWorkspace` and `readEntries`, contract §5 "Status page", and contract §8 "Changing working file".

import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { FileIdentity } from "../contracts/channel";
import type { ChangeEntry, ReadEntriesResult, WorkspaceRefusal, WorkspaceSnapshot } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  GIT_PROCESS_DEADLINE_MS,
  IDENTITY_PATHS,
  MUTATION_RAW_INDEX_BYTES,
  STATUS_LISTING_BYTES,
  STATUS_LISTING_RECORDS,
  STATUS_PAGE_BYTES,
} from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import { headTargetArgs, indexEntryArgs, isObjectId, markerPathArgs, objectCheckArgs, OPERATION_MARKERS, pseudorefExistsArgs, recheckArgs, statusArgs, type OperationMarker } from "./commands";
import { hunkEligibility, IndexFormatError, type HunkEligibility } from "./eligibility";
import type { GitInstallation } from "./git-installation";
import { createCollector, isChannelPath, RunnerRefusal, type Collector, type GitExit, type GitRunner } from "./git-runner";
import { sameIdentity } from "./identity";
import type { Workspace } from "./registration";
import {
  createSnapshotStore,
  indexFingerprint,
  policyFingerprint,
  readWorkingVersion,
  type ChangeSnapshot,
  type Completeness,
  type Head,
  type IndexEntry,
  type LimitName,
  type Observation,
  type OperationState,
  type ReadWorkingVersionOptions,
  type WorkingVersion,
} from "./snapshot";
import { createStatusParser, type BranchHeaders, type StatusRecord } from "./status-parser";
import { parseMaybeBool, type ChangeFiles, type ConfigEntry, type ListingOutcome, type Trust } from "./trust";

// Contract §7 "Missing objects".
export const OBJECT_MISSING_REMEDY =
  "This partial clone lacks objects that Git needs here. Arbareto never downloads objects. Download them in a terminal, for example with git backfill, then use Refresh.";

export interface ReadWorkspaceTarget {
  operationId: string;
  signal: AbortSignal;
  installation: GitInstallation;
  workspace: Workspace;
  refresh: boolean;
  // The envelope `repositoryGeneration`. It names the generation of the trust listing (contract §7 "Shared listing").
  requestGeneration?: number;
  // The working paths that a token binds (data-model §4 `workingVersions`, contract §8 "Token invalidation").
  bound?: readonly Uint8Array[];
}

export type ReadOutcome =
  | { result: "succeeded"; value: WorkspaceSnapshot }
  | { result: "limited"; code: "OUTPUT_LIMIT" | "WORKTREE_CHANGING"; value: WorkspaceSnapshot }
  | { result: "limited"; code: "OBJECT_MISSING"; value: WorkspaceRefusal }
  | { result: "failed"; code: ErrorCode; value: WorkspaceRefusal }
  | { result: "canceled" }
  | { result: "deadline" };

export type EntriesOutcome = { ok: true; value: ReadEntriesResult } | { ok: false; code: "REPOSITORY_CHANGED" | "UNKNOWN_TARGET" };

type ProcessTarget = Pick<ReadWorkspaceTarget, "operationId" | "signal" | "workspace">;

export interface WorkspaceReaderOptions {
  runner: GitRunner;
  trust: Trust;
  // Test seam only. Production never sets it.
  workingVersion?: ReadWorkingVersionOptions;
}

// Contract §5 "Status page": each page holds whole entries. `starts[i]` is the first entry of page i, and `cursors[i]` names page i from 1 on.
interface StatusSnapshot extends ChangeSnapshot {
  entries: ChangeEntry[];
  starts: number[];
  cursors: string[];
  pages: Map<string, number>;
}

type RecoveryState = WorkspaceSnapshot["recoveryState"];

interface WorkspaceState {
  // Running `readWorkspace` calls with `refresh: true` (data-model §2 `refreshing`).
  refreshing: number;
  // The last read ended with REPOSITORY_UNAVAILABLE (data-model §2 `unavailable`).
  unavailable: boolean;
  // The contract §8 candidate files of the last trust listing of this workspace.
  changeFiles: ChangeFiles | null;
  markers: Promise<Record<OperationMarker, string> | null> | null;
  // The start number of the read whose observation the snapshot store holds.
  recorded: number;
}

type Step = { exit: GitExit } | { refused: ErrorCode };
type Flags = NonNullable<ChangeEntry["flags"]>;

const NUL = 0x00;
const TAB = 0x09;
const NEWLINE = 0x0a;
const UNSET: Flags = { intentToAdd: false, assumeUnchanged: false, skipWorktree: false };
const EMPTY = new Uint8Array(0);
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const keyOf = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const isMissing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

const contextOf = (w: Workspace) => ({ contextKind: "registeredOperation" as const, gitInstallationId: w.gitInstallationId, repositoryId: w.repositoryId });

// Splits NUL-terminated records. Bytes after the last NUL belong to no record.
function records(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; ; ) {
    const nul = bytes.indexOf(NUL, at);
    if (nul < 0) return out;
    out.push(bytes.subarray(at, nul));
    at = nul + 1;
  }
}

// git-ls-files(1) `-v` tags: `H` cached, `S` skip-worktree at stage 0, `M` unmerged. A lowercase tag marks assume-unchanged.
const STAGE0_TAGS: ReadonlySet<string> = new Set(["H", "h", "S", "s"]);
const UNMERGED_TAGS: ReadonlySet<string> = new Set(["M", "m"]);
const INDEX_FIELDS = /^([0-7]{6}) ([0-9a-f]+) ([0-3])$/;

// `ls-files -z --stage -v` records. Null for a record that breaks the git-ls-files(1) OUTPUT form.
function parseIndexListing(bytes: Uint8Array, objectFormat: Workspace["objectFormat"]): Omit<IndexEntry, "intentToAdd">[] | null {
  const entries: Omit<IndexEntry, "intentToAdd">[] = [];
  for (const record of records(bytes)) {
    const tab = record.indexOf(TAB);
    if (record.length < 2 || record[1] !== 0x20 || tab < 0 || tab === record.length - 1) return null;
    const tag = String.fromCharCode(record[0]!);
    const fields = INDEX_FIELDS.exec(Buffer.from(record.subarray(2, tab)).toString("latin1"));
    if (fields === null || !isObjectId(fields[2]!, objectFormat)) return null;
    const stage = Number(fields[3]) as IndexEntry["stage"];
    if (!(stage === 0 ? STAGE0_TAGS : UNMERGED_TAGS).has(tag)) return null;
    entries.push({ path: record.slice(tab + 1), stage, mode: fields[1]!, oid: fields[2]!, assumeUnchanged: tag === tag.toLowerCase(), skipWorktree: tag === "S" || tag === "s" });
  }
  return entries;
}

// Research R2 "T081 record": porcelain v2 shows an intent-to-add entry as the ordinary record `.A` with `mH` and `mI` `000000`.
const intentToAdd = (r: StatusRecord) => r.kind === "ordinary" && r.xy === ".A" && r.modes[0] === "000000" && r.modes[1] === "000000";

// Sends one identity request (contract §6 "Process fields") and returns its replies in path order.
export type IdentityRequest = (paths: string[]) => Promise<unknown[]>;

// Git `promisor-remote.c` `promisor_remote_config` (git-for-windows v2.56.0.windows.1): a true `remote.<name>.promisor` or any `remote.<name>.partialclonefilter` names a promisor remote.
// `parse_config_key` gives the empty name to a key without a subsection. `promisor_remote_new` refuses a name that starts with `/`.
// `setup.c` `read_repository_format` reads `extensions.partialclone` only from `<common directory>/config`, and only when that file sets `core.repositoryformatversion`.
// The shell identity of the origin file decides that file, never the path text. Git prints the section and the variable in lowercase.
// `unknown`: an identity that the shell cannot give, so the check cannot complete.
export async function hasPromisor(entries: readonly ConfigEntry[], w: Workspace, identify: IdentityRequest): Promise<boolean | "unknown"> {
  const remote = entries.some((e) => {
    if (!e.key.startsWith("remote.")) return false;
    const dot = e.key.lastIndexOf(".");
    const name = dot === "remote".length ? "" : e.key.slice("remote.".length, dot);
    if (name.startsWith("/")) return false;
    const variable = e.key.slice(dot + 1);
    return variable === "partialclonefilter" || (variable === "promisor" && parseMaybeBool(e.value) === 1);
  });
  if (remote) return true;
  const fileOf = (e: ConfigEntry) => (e.origin.startsWith("file:") ? NATIVE.path.resolve(w.worktreeRoot, e.origin.slice("file:".length)) : null);
  const format = entries.filter((e) => (e.key === "core.repositoryformatversion" || e.key === "extensions.partialclone") && fileOf(e) !== null);
  const candidates = format.filter((e) => e.key === "extensions.partialclone" && e.value !== null && !e.value.startsWith("/"));
  if (candidates.length === 0) return false;
  const formatFile = NATIVE.path.join(w.commonDirectory, "config");
  const paths = [...new Set([formatFile, ...format.map((e) => fileOf(e)!)])];
  const replies: unknown[] = [];
  try {
    for (let at = 0; at < paths.length; at += IDENTITY_PATHS) replies.push(...(await identify(paths.slice(at, at + IDENTITY_PATHS))));
  } catch (error) {
    if (error instanceof RunnerRefusal) return "unknown";
    throw error;
  }
  if (replies.length !== paths.length) return "unknown";
  const identities = new Map<string, FileIdentity>();
  for (const [i, path] of paths.entries()) {
    const identity = FileIdentity.safeParse(replies[i]);
    if (!identity.success) return "unknown";
    identities.set(path, identity.data);
  }
  const inFormatFile = (e: ConfigEntry) => sameIdentity(identities.get(fileOf(e)!)!, identities.get(formatFile)!);
  return format.some((e) => e.key === "core.repositoryformatversion" && inFormatFile(e)) && candidates.some(inFormatFile);
}

// Contract §7 "Missing objects": the `cat-file --batch-check` answer for `oids`, one line each in input order. Git prints `<object> missing` for an absent object.
export function objectCheckAnswer(raw: Uint8Array, oids: readonly string[]): "missing" | "present" | "failed" {
  if (raw.length === 0 || raw[raw.length - 1] !== NEWLINE) return "failed";
  const lines = Buffer.from(raw.subarray(0, -1)).toString("latin1").split("\n");
  if (lines.length !== oids.length) return "failed";
  let missing = false;
  for (const [i, line] of lines.entries()) {
    const rest = line.startsWith(`${oids[i]} `) ? line.slice(oids[i]!.length + 1) : null;
    if (rest === "missing") missing = true;
    else if (rest === null || !/^(?:blob|tree|commit|tag) [0-9]+$/.test(rest)) return "failed";
  }
  return missing ? "missing" : "present";
}

// Git `wt-status.c` `wt_status_get_state` order. Data-model §2 lists no value for `git am`, so `rebase-apply/applying` gives `unknown`.
function stateOf(present: Record<OperationMarker, boolean | null>, unmerged: boolean): OperationState {
  if (Object.values(present).includes(null)) return "unknown";
  if (present.MERGE_HEAD) return "merging";
  if (present["rebase-apply"]) return present["rebase-apply/applying"] ? "unknown" : "rebasing";
  if (present["rebase-merge"]) return "rebasing";
  if (present.CHERRY_PICK_HEAD) return "cherry-picking";
  if (present.REVERT_HEAD) return "reverting";
  if (present.sequencer) return "sequencer-active";
  return unmerged ? "conflicted" : "normal";
}

// git-status(1) porcelain v2 `# branch.head` prints the branch name without `refs/heads/`, or `(detached)`.
// The status parser gives null for `(detached)`, which a branch can also be named. `symbolic-ref` decides.
function headOf(branch: BranchHeaders, symbolic: { exitCode: number | null; stdout: Uint8Array }): Head | "inconsistent" | "malformed" | "failed" {
  const shown = branch.head ?? "(detached)";
  if (symbolic.exitCode === 1) {
    if (symbolic.stdout.length > 0) return "malformed";
    return shown === "(detached)" && branch.oid !== null ? { state: "detached", oid: branch.oid } : "inconsistent";
  }
  if (symbolic.exitCode !== 0) return "failed";
  const out = symbolic.stdout;
  if (out.length < 2 || out[out.length - 1] !== NEWLINE || out.indexOf(NEWLINE) !== out.length - 1) return "malformed";
  let target: string;
  try {
    target = utf8.decode(out.subarray(0, -1));
  } catch {
    return "malformed";
  }
  if (!target.startsWith("refs/")) return "malformed";
  if (target.startsWith("refs/heads/") && shown !== target.slice("refs/heads/".length)) return "inconsistent";
  return branch.oid === null ? { state: "unborn", target } : { state: "branch", target, oid: branch.oid };
}

// Contract §5 "Raw index eligible for mutation": at most the bound plus one byte. O_NONBLOCK keeps a FIFO from blocking the open.
async function readRawIndex(path: string): Promise<Uint8Array | null | "over" | "unavailable"> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return isMissing(error) ? null : "unavailable";
  }
  try {
    if (!(await handle.stat()).isFile()) return "unavailable";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = new Uint8Array(Math.min(1024 * 1024, MUTATION_RAW_INDEX_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > MUTATION_RAW_INDEX_BYTES) return "over";
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } catch {
    return "unavailable";
  } finally {
    await handle.close();
  }
}

// Contract §7 "Shared listing" and §8 "Change check": size, last-write time, and presence of the index and of each file that the last listing names.
// Null: a candidate needs a fact that the service does not hold, so no compare can prove that nothing changed.
async function listingTuple(w: Workspace, files: ChangeFiles | null): Promise<string | null> {
  if (files === null || !files.complete) return null;
  const facts = await Promise.all(
    [w.indexPath, ...files.paths].map(async (path) => {
      try {
        const s = await stat(path, { bigint: true });
        return [path, s.size.toString(), s.mtimeNs.toString()];
      } catch (error) {
        return isMissing(error) ? [path, null, null] : undefined;
      }
    }),
  );
  return facts.includes(undefined) ? null : JSON.stringify(facts);
}

// Contract §5 "Status page": the pages of `entries` within the bound. `kept` is below the entry count when one entry cannot fit a page.
function paginate(entries: readonly ChangeEntry[], firstOverhead: number): { starts: number[]; kept: number } {
  const laterOverhead = encodedBytes({ entries: [], cursor: crypto.randomUUID() });
  const starts = [0];
  let used = firstOverhead;
  let count = 0;
  for (let i = 0; i < entries.length; i++) {
    const size = encodedBytes(entries[i]);
    if (used + size + (count > 0 ? 1 : 0) <= STATUS_PAGE_BYTES) {
      used += size + (count > 0 ? 1 : 0);
      count++;
      continue;
    }
    // Contract §3: each page holds at least one entry.
    if (count === 0 || laterOverhead + size > STATUS_PAGE_BYTES) return { starts, kept: i };
    starts.push(i);
    used = laterOverhead + size;
    count = 1;
  }
  return { starts, kept: entries.length };
}

export function createWorkspaceReader({ runner, trust, workingVersion = {} }: WorkspaceReaderOptions) {
  const snapshots = createSnapshotStore<StatusSnapshot>();
  const states = new Map<string, WorkspaceState>();
  const stateOfWorkspace = (repositoryId: string): WorkspaceState => {
    let found = states.get(repositoryId);
    if (found === undefined) states.set(repositoryId, (found = { refreshing: 0, unavailable: false, changeFiles: null, markers: null, recorded: 0 }));
    return found;
  };
  // Counts the read attempts in start order.
  let started = 0;

  async function run(t: ProcessTarget, args: string[], stdout: Collector, input?: Uint8Array): Promise<Step> {
    try {
      const exit = await runner.run({
        operationId: t.operationId,
        context: contextOf(t.workspace),
        arguments: args,
        ...(input === undefined ? {} : { input }),
        environmentPolicy: "read",
        limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS },
        stdout,
        stderr: createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }),
        signal: t.signal,
      });
      return { exit };
    } catch (error) {
      if (error instanceof RunnerRefusal) return { refused: error.code };
      throw error;
    }
  }

  // Git resolves the marker paths once for each workspace. A failed resolution is not kept.
  function markerPaths(t: ReadWorkspaceTarget, st: WorkspaceState): Promise<Record<OperationMarker, string> | null> {
    st.markers ??= (async (): Promise<Record<OperationMarker, string> | null> => {
      const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
      const step = await run(t, markerPathArgs(), out);
      if ("refused" in step || step.exit.exitCode !== 0 || out.limited) return null;
      const raw = out.take();
      if (raw.length === 0 || raw[raw.length - 1] !== NEWLINE) return null;
      let lines: string[];
      try {
        lines = utf8.decode(raw.subarray(0, -1)).split("\n");
      } catch {
        return null;
      }
      if (lines.length !== OPERATION_MARKERS.length || !lines.every((line) => isChannelPath(line))) return null;
      return Object.fromEntries(OPERATION_MARKERS.map((name, i) => [name, lines[i]!])) as Record<OperationMarker, string>;
    })().catch(() => null);
    const pending = st.markers;
    void pending.then((paths) => {
      if (paths === null && st.markers === pending) st.markers = null;
    });
    return pending;
  }

  // OS file facts of the Git-resolved marker paths. Null: the fact is unknown.
  async function markerFacts(t: ReadWorkspaceTarget, st: WorkspaceState): Promise<{ present: Record<OperationMarker, boolean | null>; steps: Step[] }> {
    const paths = await markerPaths(t, st);
    const present = Object.fromEntries(OPERATION_MARKERS.map((name) => [name, null])) as Record<OperationMarker, boolean | null>;
    const steps: Step[] = [];
    if (paths === null) return { present, steps };
    const exists = async (path: string) => {
      try {
        await stat(path);
        return true;
      } catch (error) {
        return isMissing(error) ? false : null;
      }
    };
    // Git keeps CHERRY_PICK_HEAD and REVERT_HEAD in the ref store. Only the `files` format stores them as files.
    const inRefStore: OperationMarker[] = t.workspace.refFormat === "reftable" ? ["CHERRY_PICK_HEAD", "REVERT_HEAD"] : [];
    await Promise.all(
      OPERATION_MARKERS.map(async (name) => {
        if (!inRefStore.includes(name)) return void (present[name] = await exists(paths[name]));
        const step = await run(t, pseudorefExistsArgs(name as "CHERRY_PICK_HEAD" | "REVERT_HEAD"), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
        steps.push(step);
        present[name] = "refused" in step ? null : step.exit.exitCode === 0 ? true : step.exit.exitCode === 2 ? false : null;
      }),
    );
    return { present, steps };
  }

  // Contract §7 "Missing objects": `cat-file --batch-check` on the object IDs that the read needed. Git prints `<object> missing` for an absent object.
  async function objectCheck(t: ReadWorkspaceTarget, oids: readonly string[]): Promise<"missing" | "present" | "failed" | "canceled" | "deadline"> {
    if (oids.length === 0) return "failed";
    const out = createCollector({ maxBytes: STATUS_LISTING_BYTES });
    const step = await run(t, objectCheckArgs(), out, new TextEncoder().encode(`${oids.join("\n")}\n`));
    if (t.signal.aborted) return "canceled";
    if ("refused" in step) return "failed";
    if (step.exit.deadline !== undefined) return "deadline";
    if (out.limited || step.exit.exitCode !== 0) return "failed";
    return objectCheckAnswer(out.take(), oids);
  }

  function recoveryOf(st: WorkspaceState): RecoveryState {
    if (st.unavailable) return "unavailable";
    return st.refreshing > 0 ? "refreshing" : "ready";
  }

  type Attempt = { kind: "done"; outcome: ReadOutcome } | { kind: "changed" };

  // One full read (contract §8 "Changing working file"). `last` marks the second attempt.
  async function attempt(t: ReadWorkspaceTarget, last: boolean, finish: () => void): Promise<Attempt> {
    const w = t.workspace;
    const st = stateOfWorkspace(w.repositoryId);
    const sequence = ++started;
    const startGeneration = snapshots.generation(w.repositoryId);
    // Contract §7 "Shared listing": the generation of this listing. Null until the service knows it.
    let ownerGeneration: number | null = t.requestGeneration ?? null;
    const end = (outcome: ReadOutcome): Attempt => {
      finish();
      if (outcome.result === "failed") st.unavailable = outcome.code === "REPOSITORY_UNAVAILABLE";
      else if (outcome.result !== "canceled" && outcome.result !== "deadline") st.unavailable = false;
      if ("value" in outcome) outcome.value.recoveryState = recoveryOf(st);
      return { kind: "done", outcome };
    };
    const refusal = (code: ErrorCode, text?: string): Attempt =>
      end({ result: "failed", code, value: { completeness: { state: "failed", code }, recoveryState: "ready", ...(text === undefined ? {} : { remedy: { text } }) } });
    const stop = (outcome: Exclude<ListingOutcome, { ok: true }>): Attempt =>
      "stop" in outcome ? end({ result: outcome.stop }) : refusal(outcome.code, outcome.text);

    // Contract §7 "Shared listing": the tuple comes before the listing starts. `readWorkspace` always runs its own listing.
    const tuple = await listingTuple(w, st.changeFiles);
    // A release cancels the read (contract §6 "Registration reuse and release"). A canceled read records nothing.
    if (t.signal.aborted) return end({ result: "canceled" });
    const listing = trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: w });
    if (tuple === null) trust.shared.release(w.repositoryId);
    else trust.shared.record(w.repositoryId, { tuple, listing, generation: () => ownerGeneration });
    const listed = await listing;
    if (!listed.ok) return stop(listed);
    const lst = listed.listing;
    st.changeFiles = lst.changeFiles;
    // Contract §7: the read gate decides before any status, diff, or history read.
    const gate = trust.gate(w, lst, t.installation, "reads");
    if (gate !== null) return refusal(gate);

    const parser = createStatusParser(w.objectFormat);
    let statusBytes = 0;
    // A `limited` collector stops its process (contract §6 "Byte caps"). So a reached status bound stops `git status`.
    const statusOut: Collector = {
      push(chunk) {
        statusBytes += chunk.length;
        parser.push(chunk);
      },
      get bytes() {
        return statusBytes;
      },
      records: 0,
      get limited() {
        return parser.limited;
      },
    };
    const indexOut = createCollector({ maxBytes: STATUS_LISTING_BYTES, maxRecords: STATUS_LISTING_RECORDS, separator: NUL });
    const headOut = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const [status, index, symbolic, markers] = await Promise.all([
      run(t, statusArgs(), statusOut),
      run(t, indexEntryArgs(), indexOut),
      run(t, headTargetArgs(), headOut),
      markerFacts(t, st),
    ]);
    const steps = [status, index, symbolic, ...markers.steps];
    if (t.signal.aborted) return end({ result: "canceled" });
    for (const step of steps) if ("refused" in step) return refusal(step.refused);
    const exits = steps.map((step) => (step as { exit: GitExit }).exit);
    if (exits.some((exit) => exit.deadline !== undefined)) return end({ result: "deadline" });
    if (exits.some((exit) => exit.diagnosticLimit)) return refusal("OUTPUT_LIMIT");
    const [statusExit, indexExit, symbolicExit] = exits as [GitExit, GitExit, GitExit];

    const parsed = parser.end();
    const kept = indexOut.take();
    const indexReason: LimitName | null = indexOut.limited ? (records(kept).length >= STATUS_LISTING_RECORDS ? "STATUS_LISTING_RECORDS" : "STATUS_LISTING_BYTES") : null;
    const listedEntries = parseIndexListing(kept, w.objectFormat);
    // Contract §5: the first reached bound wins, also over a later Git failure.
    const statusFailed = statusExit.exitCode !== 0 && parsed.state !== "limited";
    const indexFailed = indexExit.exitCode !== 0 && !indexOut.limited;
    if (statusFailed || indexFailed) {
      // A promisor check that cannot complete gives GIT_FAILED, as an object check that cannot complete does.
      const promisor = await hasPromisor(lst.entries, w, (paths) => runner.identities(t.operationId, contextOf(w), paths));
      if (t.signal.aborted) return end({ result: "canceled" });
      if (promisor !== true) return refusal("GIT_FAILED");
      // Contract §7 "Missing objects": the HEAD commit and the index entries. A gitlink names a commit of another repository.
      const oids = new Set<string>();
      if (parsed.state !== "failed" && parsed.branch.oid !== null) oids.add(parsed.branch.oid);
      for (const e of listedEntries ?? []) if (e.mode !== "160000") oids.add(e.oid);
      const checked = await objectCheck(t, [...oids]);
      if (checked === "canceled" || checked === "deadline") return end({ result: checked });
      if (checked !== "missing") return refusal("GIT_FAILED");
      return end({
        result: "limited",
        code: "OBJECT_MISSING",
        value: { completeness: { state: "limited", code: "OBJECT_MISSING" }, recoveryState: "ready", remedy: { text: OBJECT_MISSING_REMEDY } },
      });
    }
    if (parsed.state === "failed" || listedEntries === null) return refusal("MALFORMED_GIT_OUTPUT");
    const head = headOf(parsed.branch, { exitCode: symbolicExit.exitCode, stdout: headOut.limited ? EMPTY : headOut.take() });
    if (head === "malformed") return refusal("MALFORMED_GIT_OUTPUT");
    // Contract §9: an uncertain cause gives GIT_FAILED. An inconsistent pair shows that HEAD moved between the two processes.
    if (head === "failed" || head === "inconsistent") return refusal("GIT_FAILED");

    const raw = await readRawIndex(w.indexPath);
    if (raw === "unavailable") return refusal("REPOSITORY_UNAVAILABLE");
    const rawIndex = raw === "over" ? null : raw;
    let eligibility: HunkEligibility | null = null;
    if (raw !== "over") {
      try {
        eligibility = hunkEligibility(rawIndex, w.objectFormat, lst);
      } catch (error) {
        if (error instanceof IndexFormatError) return refusal("MALFORMED_GIT_OUTPUT");
        throw error;
      }
    }

    const ita = new Set(parsed.records.filter(intentToAdd).map((r) => keyOf(r.path.bytes)));
    const indexEntries: IndexEntry[] = listedEntries.map((e) => ({ ...e, intentToAdd: e.stage === 0 && ita.has(keyOf(e.path)) }));
    let fingerprintLimit: LimitName | null = null;
    let fingerprint = null;
    if (raw === "over") fingerprintLimit = "MUTATION_RAW_INDEX_BYTES";
    else if (indexReason === null) {
      const checked = await indexFingerprint({ rawIndex, objectFormat: w.objectFormat, gitDirectory: w.gitDirectory, entries: indexEntries });
      if (checked.ok) fingerprint = checked.value;
      else if (checked.completeness.state === "failed") return refusal(checked.completeness.code);
      else if (checked.completeness.state === "limited" && checked.completeness.code === "OUTPUT_LIMIT") fingerprintLimit = checked.completeness.reason;
    }

    // Contract §8 "Changing working file": T081 reports a second swap of one path as REPOSITORY_CHANGED.
    const versions: WorkingVersion[] = [];
    let changed = false;
    let workingLimit: LimitName | null = null;
    for (const path of t.bound ?? []) {
      const read = await readWorkingVersion(w.worktreeRoot, path, "COMPARED_RAW_VERSION_BYTES", null, workingVersion);
      if (read.ok) versions.push(read.value);
      else if (read.completeness.state === "failed" && read.completeness.code === "REPOSITORY_CHANGED") changed = true;
      else if (read.completeness.state === "failed") return refusal(read.completeness.code);
      else if (read.completeness.state === "limited" && read.completeness.code === "OUTPUT_LIMIT") workingLimit ??= read.completeness.reason;
    }
    if (changed && !last) return { kind: "changed" };

    // Index flags: complete only when the index listing is complete. A path without an index entry has no flags set.
    const byPath = new Map(indexEntries.filter((e) => e.stage === 0).map((e) => [keyOf(e.path), e]));
    const flagsOf = (bytes: Uint8Array): Flags | undefined => {
      const e = byPath.get(keyOf(bytes));
      if (e !== undefined) return { intentToAdd: e.intentToAdd, assumeUnchanged: e.assumeUnchanged, skipWorktree: e.skipWorktree };
      return indexReason === null ? UNSET : undefined;
    };
    const entries: ChangeEntry[] = [];
    for (const r of parsed.records) {
      const path = { path: r.path.display, pathBytes: b64(r.path.bytes) };
      // A path record holds no index fields. `statusArgs` asks for no ignored files.
      if (!("xy" in r)) {
        if (r.kind === "untracked") entries.push({ entryId: crypto.randomUUID(), category: "untracked", ...path, flags: UNSET });
        continue;
      }
      const fields = { xy: r.xy, submodule: r.submodule, modes: [...r.modes], oids: [...r.oids] };
      if (r.kind === "unmerged") {
        entries.push({ entryId: crypto.randomUUID(), category: "conflicted", ...path, ...fields });
        continue;
      }
      const source = r.kind === "rename" ? { score: r.score, sourcePath: r.originalPath.display, sourcePathBytes: b64(r.originalPath.bytes) } : {};
      const flags = flagsOf(r.path.bytes);
      for (const [letter, category] of [
        [r.xy[0], "staged"],
        [r.xy[1], "unstaged"],
      ] as const) {
        if (letter !== ".") entries.push({ entryId: crypto.randomUUID(), category, ...path, ...fields, ...source, ...(flags === undefined ? {} : { flags }) });
      }
    }

    const statusReason = parsed.state === "limited" ? (parsed.reason as LimitName) : null;
    const firstLimit = statusReason ?? indexReason ?? fingerprintLimit;
    let completeness: Completeness =
      firstLimit !== null
        ? { state: "limited", code: "OUTPUT_LIMIT", reason: firstLimit }
        : changed
          ? { state: "limited", code: "WORKTREE_CHANGING" }
          : workingLimit !== null
            ? { state: "limited", code: "OUTPUT_LIMIT", reason: workingLimit }
            : { state: "complete" };

    const view = trust.view(w, lst, t.installation);
    const policy = policyFingerprint({ attributes: EMPTY, trust: { state: view.state, trustId: view.trustId ?? null }, configurationFingerprint: lst.fingerprint, git: t.installation });
    const operationState = stateOf(markers.present, parsed.records.some((r) => r.kind === "unmerged"));
    finish();
    st.unavailable = false;
    const summary = {
      generation: MAX_GENERATION,
      snapshotId: crypto.randomUUID(),
      identity: { worktreeRoot: w.worktreeRoot, gitDirectory: w.gitDirectory, commonDirectory: w.commonDirectory, indexPath: w.indexPath, objectFormat: w.objectFormat, refFormat: w.refFormat },
      head,
      operationState,
      recoveryState: recoveryOf(st),
      completeness,
      hunkEligibility: eligibility,
      entryCount: entries.length,
      entries: [] as ChangeEntry[],
      cursor: crypto.randomUUID() as string | null,
    };
    const pageLimit: Completeness = { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_PAGE_BYTES" };
    // The first page carries the final completeness. Only a complete result can become `pageLimit`.
    const { starts, kept: keptEntries } = paginate(entries, encodedBytes({ ...summary, completeness: completeness.state === "complete" ? pageLimit : completeness }));
    if (keptEntries < entries.length) {
      entries.length = keptEntries;
      if (completeness.state === "complete") completeness = pageLimit;
    }
    const cursors = starts.map((_, i) => (i === 0 ? "" : crypto.randomUUID()));
    const observation: Observation = {
      repositoryId: w.repositoryId,
      head,
      indexFingerprint: fingerprint,
      indexEntries: indexReason === null ? indexEntries : [],
      workingVersions: versions,
      policyFingerprint: policy,
      operationState,
      completeness,
      entryCount: entries.length,
      observedAt: new Date().toISOString(),
    };
    // Contract §2 and §8: a read that ends after a newer read records nothing and keeps its start generation, so the caller can discard it.
    // When the newer read recorded an equal observation, the late read returns the first page of that retained snapshot.
    let snapshot: Pick<StatusSnapshot, "generation" | "snapshotId" | "completeness" | "entries" | "starts" | "cursors"> = {
      generation: startGeneration,
      snapshotId: crypto.randomUUID(),
      completeness,
      entries,
      starts,
      cursors,
    };
    if (t.signal.aborted) return end({ result: "canceled" });
    if (st.recorded < sequence) {
      snapshot = snapshots.record(observation, { entries, starts, cursors, pages: new Map(cursors.slice(1).map((cursor, i) => [cursor, i + 1])) }, last);
      st.recorded = sequence;
      w.generation = snapshot.generation;
      ownerGeneration ??= snapshot.generation;
    } else {
      snapshot = snapshots.retainedEqual(observation) ?? snapshot;
    }
    const value: WorkspaceSnapshot = {
      ...summary,
      generation: snapshot.generation,
      snapshotId: snapshot.snapshotId,
      completeness: snapshot.completeness,
      entryCount: snapshot.entries.length,
      entries: snapshot.entries.slice(0, snapshot.starts[1] ?? snapshot.entries.length),
      cursor: snapshot.cursors[1] ?? null,
    };
    if (value.completeness.state === "complete") return { kind: "done", outcome: { result: "succeeded", value } };
    return { kind: "done", outcome: { result: "limited", code: value.completeness.code as "OUTPUT_LIMIT" | "WORKTREE_CHANGING", value } };
  }

  return {
    // Contract §3 `readWorkspace`. A `check: "changes"` read runs in full until T088 adds the change check.
    async readWorkspace(t: ReadWorkspaceTarget): Promise<ReadOutcome> {
      snapshots.register(t.workspace.repositoryId);
      const st = stateOfWorkspace(t.workspace.repositoryId);
      if (t.refresh) st.refreshing++;
      let running = t.refresh;
      const finish = () => {
        if (running) st.refreshing--;
        running = false;
      };
      try {
        const first = await attempt(t, false, finish);
        if (first.kind === "done") return first.outcome;
        // Contract §8: the partial result is discarded, and one more full read runs.
        const second = await attempt(t, true, finish);
        if (second.kind === "done") return second.outcome;
        throw new Error("the last attempt returned no outcome");
      } finally {
        finish();
      }
    },

    // Contract §3 `readEntries`: the generation, then the snapshot, then the cursor. No Git process starts.
    readEntries(repositoryId: string, generation: number, snapshotId: string, cursor: string): EntriesOutcome {
      snapshots.register(repositoryId);
      const found = snapshots.lookup(repositoryId, generation, snapshotId);
      if (!found.ok) return found;
      const page = found.snapshot.pages.get(cursor);
      if (page === undefined) return { ok: false, code: "UNKNOWN_TARGET" };
      const { entries, starts, cursors } = found.snapshot;
      return { ok: true, value: { entries: entries.slice(starts[page], starts[page + 1] ?? entries.length), cursor: cursors[page + 1] ?? null } };
    },

    // Data-model §7: the re-read after a canceled or failed read. Contract §6 "Registration bootstrap": every nonzero exit of the first discovery call gives REPOSITORY_UNAVAILABLE.
    // Null: the call exited 0, or it ended without an exit status of Git.
    async recheck(t: ProcessTarget): Promise<Extract<ReadOutcome, { result: "failed" }> | null> {
      const step = await run(t, recheckArgs(), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
      if (t.signal.aborted || "refused" in step || step.exit.deadline !== undefined || step.exit.diagnosticLimit || step.exit.exitCode === null || step.exit.exitCode === 0) return null;
      const st = stateOfWorkspace(t.workspace.repositoryId);
      st.unavailable = true;
      return { result: "failed", code: "REPOSITORY_UNAVAILABLE", value: { completeness: { state: "failed", code: "REPOSITORY_UNAVAILABLE" }, recoveryState: recoveryOf(st) } };
    },

    // Contract §7 "Shared listing": `readHistory` reads this tuple again before it reuses a listing.
    listingTuple: (w: Workspace): Promise<string | null> => listingTuple(w, stateOfWorkspace(w.repositoryId).changeFiles),

    // Data-model §2 `unavailable`: a `readHistory` that ends REPOSITORY_UNAVAILABLE for a missing object (contract §7 "Missing objects").
    markUnavailable(repositoryId: string): void {
      stateOfWorkspace(repositoryId).unavailable = true;
    },

    // Data-model §4 "Status snapshot retention": a workspace release releases its snapshot.
    release(repositoryId: string): void {
      snapshots.release(repositoryId);
      states.delete(repositoryId);
    },
  };
}

export type WorkspaceReader = ReturnType<typeof createWorkspaceReader>;
