// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §3 `readWorkspace` and `readEntries`, contract §5 "Status page", and contract §8 "Change check" and "Changing working file".

import { stat } from "node:fs/promises";
import { FileIdentity, type FileFact } from "../contracts/channel";
import type { ChangeEntry, ReadEntriesResult, WorkspaceRefusal, WorkspaceSnapshot } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  HISTORY_COMMIT_OBJECT_BYTES,
  IDENTITY_PATHS,
  MUTATION_RAW_INDEX_BYTES,
  STATUS_LISTING_BYTES,
  STATUS_LISTING_RECORDS,
  STATUS_PAGE_BYTES,
  SUBMODULE_GITMODULES_BYTES,
  SUBMODULE_REVIEW_SUBMODULES,
} from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import { wslIdentityPath } from "../contracts/wsl-route";
import {
  batchCommandArgs,
  headOidArgs,
  headTargetArgs,
  indexEntryArgs,
  isObjectId,
  isRefName,
  markerPathArgs,
  objectCheckArgs,
  OPERATION_MARKERS,
  pseudorefExistsArgs,
  recheckArgs,
  refPathArgs,
  statusArgs,
  type OperationMarker,
} from "./commands";
import { hunkEligibility, IndexFormatError, type HunkEligibility } from "./eligibility";
import { createCollector, isChannelPath, RunnerRefusal, type Collector, type GitExit, type GitRunner, type WalkStop } from "./git-runner";
import { HEADER_BYTES, parseCommitObjects } from "./history-parser";
import { sameIdentity } from "./identity";
import { contextOf, encodedBytes, isMissing, latin1, objectCheckInput, objectCheckOutcome, readBounded, runRead } from "./read-steps";
import type { Workspace } from "./registration";
import {
  createSnapshotStore,
  indexFingerprint,
  policyFingerprint,
  readWorkingVersion,
  retainedIndexFingerprint,
  type ChangeSnapshot,
  type Completeness,
  type Head,
  type IndexEntry,
  type LimitName,
  type Observation,
  type OperationState,
  type ReadInstallation,
  type RawIndexPart,
  type ReadWorkingVersionOptions,
  type WorkingVersion,
} from "./snapshot";
import { createStatusParser, displayPath, type BranchHeaders, type StatusRecord } from "./status-parser";
import { gitmodulesSource } from "./submodule-review";
import { isComponent, parseMaybeBool, readProgramFiles, requestFacts, type ChangeFiles, type ConfigEntry, type ListingOutcome, type ProgramFile, type FactEntry, type Trust, type TrustListing } from "./trust";
import { statFiles, statWorkingFile, type TupleFile } from "./watch";

// Contract §7 "Missing objects".
export const OBJECT_MISSING_REMEDY =
  "This partial clone lacks objects that Git needs here. Arbareto never downloads objects. Download them in a terminal, for example with git backfill, then use Refresh.";

export interface ReadWorkspaceTarget {
  operationId: string;
  signal: AbortSignal;
  installation: ReadInstallation;
  workspace: Workspace;
  refresh: boolean;
  // Contract §3: `changes` compares the contract §8 stat tuple first. Absent means `full`.
  check?: "full" | "changes";
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
  // Test seam only. Production never sets it.
  readRawIndex?: typeof readRawIndex;
  // Contract §8 (T114): true while recovery blocks the workspace.
  unknown?(w: Workspace): boolean;
  // Data-model §2: true while a mutation of the same common identity is in registry state `reconciling`.
  reconciling?(w: Workspace): boolean;
}

// Contract §5 "Status page": each page holds whole entries. `starts[i]` is the first entry of page i, and `cursors[i]` names page i from 1 on.
interface StatusSnapshot extends ChangeSnapshot {
  entries: ChangeEntry[];
  starts: number[];
  cursors: string[];
  pages: Map<string, number>;
  // The digest of the entries without their `entryId`. A changed listing is an accepted state change, so it advances the generation.
  entriesDigest: string;
}

type RecoveryState = WorkspaceSnapshot["recoveryState"];

// Contract §8 "Change check": the last complete read. `hints` is the hint count at its start.
interface LastRead {
  files: TupleFile[];
  programs: ProgramFile[];
  facts: string;
  // The facts of the bound working files by their latin1 key, each from before the read of its version.
  working: Map<string, string>;
  hints: number;
  listing: TrustListing;
  policy: string;
  value: WorkspaceSnapshot;
}

interface WorkspaceState {
  // The watcher hints so far. A hint marks the workspace dirty (contract §8 "Token invalidation").
  hints: number;
  // A watcher lost a directory, so a missing hint proves nothing.
  unwatched: boolean;
  // HEAD of the last recorded read, or null before it. It names the branch ref file of the stat tuple.
  head: Head | null;
  // The Git-resolved file of each `files` ref that HEAD named, by the ref name.
  refFiles: Map<string, string>;
  // The last recorded read when it was complete and kept a tuple. Null otherwise, so the next `check: "changes"` read runs in full.
  kept: LastRead | null;
  // Running `readWorkspace` calls with `refresh: true` (data-model §2 `refreshing`).
  refreshing: number;
  // The last read ended with REPOSITORY_UNAVAILABLE (data-model §2 `unavailable`).
  unavailable: boolean;
  // The contract §8 candidate files of the last trust listing of this workspace.
  changeFiles: ChangeFiles | null;
  markers: Promise<Record<OperationMarker, string> | null> | null;
  // The start number of the read whose observation the snapshot store holds.
  recorded: number;
  // Contract §11 "Change polling": the raw-index part of the last index that a WSL read parsed.
  parsed: RawIndexPart | null;
  // The working paths that `bind` folded into the retained observation, by their latin1 key. A generation advance clears them.
  bound: Map<string, Uint8Array>;
}

type Step = { exit: GitExit } | { refused: ErrorCode };
type Notice = WorkspaceSnapshot["submoduleNotice"];
type Flags = NonNullable<ChangeEntry["flags"]>;

const NUL = 0x00;
const TAB = 0x09;
const NEWLINE = 0x0a;
const UNSET: Flags = { intentToAdd: false, assumeUnchanged: false, skipWorktree: false };
const EMPTY = new Uint8Array(0);
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const HEAD_GITMODULES = "HEAD:.gitmodules";
// A `--null` configuration record: the key, then LF and the value when it has one.
const keyOf = (record: Uint8Array) => latin1(record.indexOf(NEWLINE) < 0 ? record : record.subarray(0, record.indexOf(NEWLINE)));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

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
export function parseIndexListing(bytes: Uint8Array, objectFormat: Workspace["objectFormat"]): Omit<IndexEntry, "intentToAdd">[] | null {
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

// Sends one identity request (contract §6 "Process fields") and returns its replies in path order, or the walk stop.
export type IdentityRequest = (paths: string[]) => Promise<unknown[] | WalkStop>;

// Git `promisor-remote.c` `promisor_remote_config` (git-for-windows v2.56.0.windows.1): a true `remote.<name>.promisor` or any `remote.<name>.partialclonefilter` names a promisor remote.
// `parse_config_key` gives the empty name to a key without a subsection. `promisor_remote_new` refuses a name that starts with `/`.
// `setup.c` `read_repository_format` reads `extensions.partialclone` only from `<common directory>/config`, and only when that file sets `core.repositoryformatversion`.
// The shell identity of the origin file decides that file, never the path text. Git prints the section and the variable in lowercase.
// `unknown`: an identity that the shell cannot give, so the check cannot complete. A walk stop ends the check with its stop.
export async function hasPromisor(entries: readonly ConfigEntry[], w: Workspace, identify: IdentityRequest): Promise<boolean | "unknown" | WalkStop["stop"]> {
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
    for (let at = 0; at < paths.length; at += IDENTITY_PATHS) {
      const answer = await identify(paths.slice(at, at + IDENTITY_PATHS));
      if (!Array.isArray(answer)) return answer.stop;
      replies.push(...answer);
    }
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

// Git `wt-status.c` `wt_status_get_state` order. Data-model §2 lists no value for `git am`, so `rebase-apply/applying` gives `unknown`.
export function stateOf(present: Record<OperationMarker, boolean | null>, unmerged: boolean): OperationState {
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

// Contract §5 "Raw index eligible for mutation". Null: the index file is absent.
export async function readRawIndex(path: string): Promise<Uint8Array | null | "over" | "unavailable"> {
  const read = await readBounded(path, MUTATION_RAW_INDEX_BYTES);
  return read === "absent" ? null : read;
}

// The `files` ref whose file the stat tuple holds for `head`, or null.
const branchRef = (w: Workspace, head: Head) => (w.refFormat === "files" && head.state !== "detached" ? head.target : null);

// Contract §8 "Change check": the index, the `files` ref files of `head` or the two `reftable/tables.list` files, and the configuration files of a listing.
// Null: Git has not resolved the branch ref file of `head` yet.
function tupleFiles(w: Workspace, st: WorkspaceState, head: Head, paths: readonly string[]): TupleFile[] | null {
  const file = (path: string, content = false): TupleFile => ({ path, content });
  const candidates = paths.map((path) => file(path));
  if (w.refFormat === "reftable") return [file(w.indexPath), ...[...new Set([w.gitDirectory, w.commonDirectory])].map((dir) => file(NATIVE.path.join(dir, "reftable", "tables.list"), true)), ...candidates];
  const files = [file(w.indexPath), file(NATIVE.path.join(w.gitDirectory, "HEAD")), file(NATIVE.path.join(w.commonDirectory, "packed-refs"))];
  const ref = branchRef(w, head);
  if (ref === null) return [...files, ...candidates];
  const refFile = st.refFiles.get(ref);
  return refFile === undefined ? null : [...files, file(refFile), ...candidates];
}

// Contract §8 "Change check": the stat facts by path, and the facts of the program-file entries by entry.
interface TupleFacts {
  stats: ReadonlyMap<string, string>;
  programs: ReadonlyMap<string, FileFact>;
}

const entryKey = (entry: ProgramFile) => JSON.stringify([entry.root, ...entry.path]);

// The program-file entries come through phase-1 `fileFacts` requests of `operationId`, never through a file call (contract §7 "Program file digests").
// Null: a fact is unknown, so no compare can prove that nothing changed. A walk stop ends the caller with its stop.
async function tupleFacts(
  runner: GitRunner,
  operationId: string,
  w: Workspace,
  files: readonly TupleFile[],
  programs: readonly ProgramFile[],
  signal: AbortSignal,
): Promise<TupleFacts | WalkStop | null> {
  const stats = await statFiles(files);
  if (stats === null) return null;
  const facts = await readProgramFiles(runner, operationId, w, programs, signal);
  if (facts === null || !Array.isArray(facts)) return facts;
  return { stats, programs: new Map(programs.map((entry, i) => [entryKey(entry), facts[i]!])) };
}

// Contract §8 "Change check": the working files of the `workingVersions` bindings, by their latin1 key. Null: a fact is unknown.
// The path joins the bytes as `readWorkingVersion` does.
async function workingFacts(w: Workspace, paths: readonly Uint8Array[]): Promise<Map<string, string> | null> {
  const root = Buffer.from(w.worktreeRoot, "utf8");
  const facts = await Promise.all(paths.map((path) => statWorkingFile(Buffer.concat([root, Buffer.from("/"), path]))));
  return facts.includes(null) ? null : new Map(paths.map((path, i) => [latin1(path), facts[i]!]));
}

const tupleText = (files: readonly TupleFile[], programs: readonly ProgramFile[], facts: TupleFacts) =>
  JSON.stringify([files.map((f) => [f.path, facts.stats.get(f.path)]), programs.map((entry) => [entryKey(entry), facts.programs.get(entryKey(entry))])]);

// Contract §7 "Shared listing" and §8 "Change check": the tuple of the last listing of the workspace.
// Null: a candidate needs a fact that the service does not hold, so no compare can prove that nothing changed.
async function listingTuple(runner: GitRunner, w: Workspace, st: WorkspaceState, operationId: string, signal: AbortSignal): Promise<string | WalkStop | null> {
  if (st.changeFiles === null || !st.changeFiles.complete) return null;
  const { configPaths, programFiles } = st.changeFiles;
  const files = tupleFiles(w, st, st.head ?? w.head, configPaths);
  if (files === null) return null;
  const facts = await tupleFacts(runner, operationId, w, files, programFiles, signal);
  return facts === null || "stop" in facts ? facts : tupleText(files, programFiles, facts);
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

// Data-model §4 `policyFingerprint`.
export function policyOf(trust: Trust, w: Workspace, listing: TrustListing, installation: ReadInstallation): string {
  const view = trust.view(w, listing, installation);
  const input = { attributes: EMPTY, trust: { state: view.state, trustId: view.trustId ?? null }, configurationFingerprint: listing.fingerprint };
  return policyFingerprint({ ...input, git: installation });
}

export function createWorkspaceReader({ runner, trust, workingVersion = {}, readRawIndex: readIndex = readRawIndex, unknown, reconciling }: WorkspaceReaderOptions) {
  const snapshots = createSnapshotStore<StatusSnapshot>();
  const states = new Map<string, WorkspaceState>();
  const stateOfWorkspace = (repositoryId: string): WorkspaceState => {
    let found = states.get(repositoryId);
    if (found === undefined) {
      found = { hints: 0, unwatched: false, head: null, refFiles: new Map(), kept: null, refreshing: 0, unavailable: false, changeFiles: null, markers: null, recorded: 0, parsed: null, bound: new Map() };
      states.set(repositoryId, found);
    }
    return found;
  };
  // Counts the read attempts in start order.
  let started = 0;

  const run = (t: ProcessTarget, args: string[], stdout: Collector, input?: Uint8Array): Promise<Step> => runRead(runner, t, args, stdout, input);

  // The `count` paths that a `rev-parse --git-path` call prints, one per line. Null: the call or its output failed.
  // Contract §11 "Paths and file access": Linux Git prints Linux paths, and the service takes their UNC form. A name without one gives null.
  async function gitPaths(t: ProcessTarget, args: string[], count: number): Promise<string[] | null> {
    const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const step = await run(t, args, out);
    if ("refused" in step || step.exit.exitCode !== 0 || out.limited) return null;
    const raw = out.take();
    if (raw.length === 0 || raw[raw.length - 1] !== NEWLINE) return null;
    let lines: string[];
    try {
      lines = utf8.decode(raw.subarray(0, -1)).split("\n");
    } catch {
      return null;
    }
    const wsl = t.workspace.wsl;
    const paths = wsl === undefined ? lines : lines.map((line) => wslIdentityPath(wsl.distro, line));
    return paths.length === count && paths.every((path): path is string => path !== null && isChannelPath(path)) ? paths : null;
  }

  // Git resolves the marker paths once for each workspace. A failed resolution is not kept.
  function markerPaths(t: ProcessTarget, st: WorkspaceState): Promise<Record<OperationMarker, string> | null> {
    st.markers ??= (async (): Promise<Record<OperationMarker, string> | null> => {
      const lines = await gitPaths(t, markerPathArgs(), OPERATION_MARKERS.length);
      return lines === null ? null : (Object.fromEntries(OPERATION_MARKERS.map((name, i) => [name, lines[i]!])) as Record<OperationMarker, string>);
    })().catch(() => null);
    const pending = st.markers;
    void pending.then((paths) => {
      if (paths === null && st.markers === pending) st.markers = null;
    });
    return pending;
  }

  // OS file facts of the Git-resolved marker paths. Null: the fact is unknown.
  async function markerFacts(t: ProcessTarget, st: WorkspaceState): Promise<{ present: Record<OperationMarker, boolean | null>; steps: Step[] }> {
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
    const step = await run(t, objectCheckArgs(), out, objectCheckInput(oids));
    if (t.signal.aborted) return "canceled";
    return objectCheckOutcome(step, out, oids);
  }

  // Git can fail before it prints `# branch.oid`. git-rev-parse(1) `--verify -q`: on success, Git prints the full object ID. Other results give null.
  async function headCommit(t: ReadWorkspaceTarget): Promise<string | null | "canceled" | "deadline"> {
    const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const step = await run(t, headOidArgs(), out);
    if (t.signal.aborted) return "canceled";
    if ("refused" in step) return null;
    if (step.exit.deadline !== undefined) return "deadline";
    if (out.limited || step.exit.exitCode !== 0) return null;
    const bytes = out.take();
    if (bytes.length < 2 || bytes[bytes.length - 1] !== NEWLINE || bytes.indexOf(NEWLINE) !== bytes.length - 1) return null;
    const oid = latin1(bytes.subarray(0, -1));
    return isObjectId(oid, t.workspace.objectFormat) ? oid : null;
  }

  // Contract §7 "Missing objects": the tree ID of the HEAD commit, within the §5 "History commit object" bound. A commit object that cannot be read gives null.
  async function headTree(t: ReadWorkspaceTarget, oid: string): Promise<string | null | "canceled" | "deadline"> {
    const out = createCollector({ maxBytes: HISTORY_COMMIT_OBJECT_BYTES + HEADER_BYTES + 2 });
    const step = await run(t, batchCommandArgs(), out, new TextEncoder().encode(`contents ${oid}\0`));
    if (t.signal.aborted) return "canceled";
    if ("refused" in step) return null;
    if (step.exit.deadline !== undefined) return "deadline";
    if (out.limited || step.exit.exitCode !== 0) return null;
    return parseCommitObjects(out.take(), [oid], t.workspace.objectFormat).objects[0]?.tree ?? null;
  }

  // Contract §12 "Review reads": whether the HEAD source exists. git-cat-file(1) `--batch-check` prints `<object> missing` for a name that resolves to no object,
  // and `<oid> <type> <size>` otherwise. A `<rev>:<path>` name loads no index (§7).
  async function headHasGitmodules(t: ReadWorkspaceTarget): Promise<boolean | "skipped" | { refused: ErrorCode } | "canceled" | "deadline"> {
    const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const step = await run(t, objectCheckArgs(), out, new TextEncoder().encode(`${HEAD_GITMODULES}\n`));
    if (t.signal.aborted) return "canceled";
    if ("refused" in step) return step;
    if (step.exit.deadline !== undefined) return "deadline";
    if (step.exit.diagnosticLimit) return { refused: "OUTPUT_LIMIT" };
    if (step.exit.exitCode !== 0) return "skipped";
    const line = out.limited ? null : (/^([^\n]*)\n$/.exec(latin1(out.take()))?.[1] ?? null);
    if (line === `${HEAD_GITMODULES} missing`) return false;
    const found = line === null ? null : /^(\S+) (?:blob|tree|commit|tag) [0-9]+$/.exec(line);
    return found !== null && isObjectId(found[1]!, t.workspace.objectFormat) ? true : { refused: "MALFORMED_GIT_OUTPUT" };
  }

  // Contract §12 "Discovery notice": superproject data only. No Git process starts inside a submodule.
  async function submoduleNotice(
    t: ReadWorkspaceTarget,
    entries: readonly Omit<IndexEntry, "intentToAdd">[],
    status: readonly StatusRecord[],
    config: readonly ConfigEntry[],
  ): Promise<{ notice: Notice } | { refused: ErrorCode } | "canceled" | "deadline"> {
    const gitlinks = entries.filter((e) => e.stage === 0 && e.mode === "160000");
    // git-status(1) porcelain v2: `<sub>` is `S<c><m><u>`, where `<c>` is `C` when the submodule commit changed. `Y` of `XY` is `D` for a worktree deletion.
    const unchecked = new Set(status.filter((r) => "xy" in r && ((r.submodule[0] === "S" && r.submodule[1] === "C") || r.xy[1] === "D")).map((r) => latin1(r.path.bytes)));
    // Contract §6 "File facts": one component that breaks the rule refuses the whole request. Such a gitlink counts with no check.
    const componentsOf = (path: Uint8Array): string[] | null => {
      let text: string;
      try {
        text = utf8.decode(path);
      } catch {
        return null;
      }
      const parts = text.split("/");
      return parts.every(isComponent) ? parts : null;
    };
    const checked = gitlinks.flatMap((e) => {
      const parts = unchecked.has(latin1(e.path)) ? null : componentsOf(e.path);
      return parts === null ? [] : [{ e, path: [...parts, ".git"] }];
    });

    // Git applies the last `submodule.<name>.active` entry of the listing. Only a false value excludes a gitlink.
    const active = new Map<string, string | null>();
    for (const c of config) {
      const key = keyOf(c.keyValueBytes);
      if (key.startsWith("submodule.") && key.endsWith(".active") && key.length > "submodule..active".length) active.set(key, c.value);
    }
    const filters = gitlinks.length > 0 && [...active.values()].some((value) => parseMaybeBool(value) === 0);

    // Contract §11 "Paths and file access": no check reads through `\\wsl.localhost`. The walk never follows a link.
    const files: FactEntry[] = checked.map(({ path }) => ({ root: "worktreeRoot", path }));
    if (filters) files.push({ root: "worktreeRoot", path: [".gitmodules"] });
    const facts = files.length === 0 ? [] : await requestFacts(runner, t.operationId, t.workspace, false, files, t.signal);
    if (t.signal.aborted) return "canceled";
    if (!Array.isArray(facts)) return "stop" in facts ? facts.stop : { refused: facts.code };
    if (facts.some((fact) => fact.kind === "error")) return { refused: "REPOSITORY_UNAVAILABLE" };
    // A link before the last component means that no entry exists at the path.
    const exists = (fact: FileFact, length: number) => fact.kind !== "absent" && (fact.kind !== "link" || fact.component === length);
    const found = new Set(checked.filter(({ path }, i) => exists(facts[i]!, path.length)).map(({ e }) => e));
    const counted = gitlinks.filter((e) => !found.has(e));
    const notice = (kept: typeof counted, filter: Notice["filter"]) => ({ count: kept.length, paths: kept.slice(0, SUBMODULE_REVIEW_SUBMODULES).map((e) => displayPath(e.path)), filter });
    if (counted.length === 0 || !filters) return { notice: notice(counted, "applied") };

    const source = await gitmodulesSource(exists(facts.at(-1)!, 1), entries, t.workspace.objectFormat, () => headHasGitmodules(t));
    if (source === "skipped") return { notice: notice(counted, "skipped") };
    if (source === null) return { notice: notice(counted, "applied") };
    if (!Array.isArray(source)) return source;
    const out = createCollector({ maxBytes: SUBMODULE_GITMODULES_BYTES });
    const step = await run(t, source, out);
    if (t.signal.aborted) return "canceled";
    if ("refused" in step) return step;
    if (step.exit.deadline !== undefined) return "deadline";
    if (step.exit.diagnosticLimit) return { refused: "OUTPUT_LIMIT" };
    // Git documents no exit status of `config --list` that identifies an invalid file. So a nonzero exit excludes nothing.
    if (out.limited || step.exit.exitCode !== 0) return { notice: notice(counted, "skipped") };
    const bytes = out.take();
    if (bytes.length > 0 && bytes[bytes.length - 1] !== NUL) return { refused: "MALFORMED_GIT_OUTPUT" };
    // Git `submodule-config.c` `gitmodules_cb` sets `overwrite`: a later `path` value of a name replaces its earlier path.
    // `parse_config` ignores a value that looks like a command-line option.
    const pathOf = new Map<string, string>();
    const nameOf = new Map<string, string>();
    for (const record of records(bytes)) {
      const key = keyOf(record);
      if (key === "") return { refused: "MALFORMED_GIT_OUTPUT" };
      const newline = record.indexOf(NEWLINE);
      if (!key.startsWith("submodule.") || !key.endsWith(".path") || key.length <= "submodule..path".length || newline < 0) continue;
      const value = latin1(record.subarray(newline + 1));
      if (value.startsWith("-")) continue;
      const name = key.slice("submodule.".length, -".path".length);
      const old = pathOf.get(name);
      if (old !== undefined) nameOf.delete(old);
      pathOf.set(name, value);
      nameOf.set(value, name);
    }
    return {
      notice: notice(
        counted.filter((e) => {
          const key = `submodule.${nameOf.get(latin1(e.path))}.active`;
          return !nameOf.has(latin1(e.path)) || !active.has(key) || parseMaybeBool(active.get(key)!) !== 0;
        }),
        "applied",
      ),
    };
  }

  // Data-model §2: `unknown` takes precedence over every other value.
  function recoveryOf(st: WorkspaceState, w: Workspace): RecoveryState {
    if (unknown?.(w)) return "unknown";
    if (reconciling?.(w)) return "reconciling";
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
      if ("value" in outcome) outcome.value.recoveryState = recoveryOf(st, w);
      return { kind: "done", outcome };
    };
    const refusal = (code: ErrorCode, text?: string): Attempt =>
      end({ result: "failed", code, value: { completeness: { state: "failed", code }, recoveryState: "ready", ...(text === undefined ? {} : { remedy: { text } }) } });
    const stop = (outcome: Exclude<ListingOutcome, { ok: true }>): Attempt =>
      "stop" in outcome ? end({ result: outcome.stop }) : refusal(outcome.code, outcome.text);

    // Contract §7 "Shared listing": the tuple comes before the listing starts. `readWorkspace` always runs its own listing.
    const hints = st.hints;
    const assumed = st.head ?? w.head;
    // Contract §11 "Change polling" and "Trust and environment": a WSL read uses no stat tuple and never shares a listing, so it computes no tuple.
    const tupled = w.wsl === undefined;
    // T088 decision E7: Git resolves the branch ref file once for each new HEAD target. So the change check starts no Git process.
    const ref = tupled ? branchRef(w, assumed) : null;
    if (ref !== null && !st.refFiles.has(ref) && isRefName(ref)) {
      const lines = await gitPaths(t, refPathArgs(ref), 1);
      if (lines !== null) st.refFiles.set(ref, lines[0]!);
    }
    const known = st.changeFiles?.complete ? st.changeFiles : null;
    const prior = tupled ? tupleFiles(w, st, assumed, known?.configPaths ?? []) : null;
    const priorPrograms = known?.programFiles ?? [];
    const before = prior === null ? null : await tupleFacts(runner, t.operationId, w, prior, priorPrograms, t.signal);
    const working = tupled ? await workingFacts(w, [...st.bound.values()]) : null;
    // A release cancels the read (contract §6 "Registration reuse and release"). A canceled read records nothing.
    if (t.signal.aborted) return end({ result: "canceled" });
    if (before !== null && "stop" in before) return end({ result: before.stop });
    // Contract §11 "Change polling": a WSL listing takes the index digest, with the shared index of the last parse.
    const lastParse = w.wsl === undefined ? null : st.parsed;
    const sharedDigest = lastParse?.sharedIndex?.digest ?? null;
    const ask = sharedDigest === null ? {} : { sharedIndex: lastParse!.sharedIndex!.hash };
    const listing = trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: w, ...(w.wsl === undefined ? {} : { index: ask }) });
    if (prior !== null && before !== null && known !== null) trust.shared.record(w.repositoryId, { tuple: tupleText(prior, priorPrograms, before), listing, generation: () => ownerGeneration });
    else trust.shared.release(w.repositoryId);
    const listed = await listing;
    if (!listed.ok) return stop(listed);
    const lst = listed.listing;
    st.changeFiles = lst.changeFiles;
    // Contract §8 "Change check" and T088 decision E3: the tuple holds only facts from before the listing.
    // A candidate that this listing names first leaves no tuple, so the next poll runs in full.
    const { configPaths, programFiles } = lst.changeFiles;
    const files = before !== null && lst.changeFiles.complete ? tupleFiles(w, st, assumed, configPaths) : null;
    const tuple =
      before !== null && working !== null && files !== null && files.every((f) => before.stats.has(f.path)) && programFiles.every((entry) => before.programs.has(entryKey(entry)))
        ? { files, programs: programFiles, facts: tupleText(files, programFiles, before), working }
        : null;
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
      const promisor = await hasPromisor(lst.entries, w, (paths) => runner.identities(t.operationId, contextOf(w), paths, t.signal));
      if (t.signal.aborted) return end({ result: "canceled" });
      if (promisor === "canceled" || promisor === "deadline") return end({ result: promisor });
      if (promisor !== true) return refusal("GIT_FAILED");
      // Contract §7 "Missing objects": the HEAD commit, the HEAD tree, and the index entries. A gitlink names a commit of another repository.
      const oids = new Set<string>();
      const commit = parsed.state !== "failed" && parsed.branch.oid !== null ? parsed.branch.oid : await headCommit(t);
      if (commit === "canceled" || commit === "deadline") return end({ result: commit });
      if (commit !== null) {
        oids.add(commit);
        const tree = await headTree(t, commit);
        if (tree === "canceled" || tree === "deadline") return end({ result: tree });
        if (tree !== null) oids.add(tree);
      }
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

    // Contract §11 "Change polling": SHA-256 equality of the index, and of the shared index the request named, proves the same bytes.
    const digests = lst.index;
    const reuse =
      lastParse !== null &&
      digests?.kind === "index" &&
      digests.index.kind === "digest" &&
      digests.index.sha256 === lastParse.rawIndexDigest &&
      (sharedDigest === null ? digests.sharedIndex === undefined : digests.sharedIndex?.kind === "digest" && digests.sharedIndex.sha256 === sharedDigest);
    const raw = reuse ? null : await readIndex(w.indexPath);
    if (raw === "unavailable") return refusal("REPOSITORY_UNAVAILABLE");
    const rawIndex = raw === "over" ? null : raw;
    let eligibility: HunkEligibility | null = null;
    if (raw !== "over") {
      try {
        eligibility = hunkEligibility(reuse ? { link: lastParse.sharedIndex?.hash ?? null } : rawIndex, w.objectFormat, lst, w.wsl !== undefined);
      } catch (error) {
        if (error instanceof IndexFormatError) return refusal("MALFORMED_GIT_OUTPUT");
        throw error;
      }
    }

    const ita = new Set(parsed.records.filter(intentToAdd).map((r) => latin1(r.path.bytes)));
    const indexEntries: IndexEntry[] = listedEntries.map((e) => ({ ...e, intentToAdd: e.stage === 0 && ita.has(latin1(e.path)) }));
    let fingerprintLimit: LimitName | null = null;
    let fingerprint = null;
    if (raw === "over") fingerprintLimit = "MUTATION_RAW_INDEX_BYTES";
    else if (indexReason === null) {
      const checked = reuse
        ? retainedIndexFingerprint(lastParse, w.objectFormat, indexEntries)
        : await indexFingerprint({ rawIndex, objectFormat: w.objectFormat, gitDirectory: w.gitDirectory, entries: indexEntries });
      if (checked.ok) {
        fingerprint = checked.value;
        if (w.wsl !== undefined && !reuse) st.parsed = { rawIndexDigest: checked.value.rawIndexDigest, sharedIndex: checked.value.sharedIndex };
      } else if (checked.completeness.state === "failed") return refusal(checked.completeness.code);
      else if (checked.completeness.state === "limited" && checked.completeness.code === "OUTPUT_LIMIT") fingerprintLimit = checked.completeness.reason;
    }

    // Contract §8 "Changing working file": T081 reports a second swap of one path as REPOSITORY_CHANGED.
    const versions: WorkingVersion[] = [];
    let changed = false;
    let workingLimit: LimitName | null = null;
    for (const path of t.bound ?? [...st.bound.values()].sort(Buffer.compare)) {
      const read = await readWorkingVersion(w.worktreeRoot, path, "COMPARED_RAW_VERSION_BYTES", null, workingVersion);
      if (read.ok) versions.push(read.value);
      else if (read.completeness.state === "failed" && read.completeness.code === "REPOSITORY_CHANGED") changed = true;
      // Contract §6: a sentinel file ID makes the file unreadable. The observation then holds no version of it, so a token that binds it becomes invalid.
      else if (read.completeness.state === "failed" && read.completeness.code === "UNSUPPORTED_HUNK_PROFILE") continue;
      else if (read.completeness.state === "failed") return refusal(read.completeness.code);
      else if (read.completeness.state === "limited" && read.completeness.code === "OUTPUT_LIMIT") workingLimit ??= read.completeness.reason;
    }
    if (changed && !last) return { kind: "changed" };

    // Index flags: complete only when the index listing is complete. A path without an index entry has no flags set.
    const byPath = new Map(indexEntries.filter((e) => e.stage === 0).map((e) => [latin1(e.path), e]));
    const flagsOf = (bytes: Uint8Array): Flags | undefined => {
      const e = byPath.get(latin1(bytes));
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

    const submodules = await submoduleNotice(t, listedEntries, parsed.records, lst.entries);
    if (submodules === "canceled" || submodules === "deadline") return end({ result: submodules });
    if ("refused" in submodules) return refusal(submodules.refused);

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

    const policy = policyOf(trust, w, lst, t.installation);
    const operationState = stateOf(markers.present, parsed.records.some((r) => r.kind === "unmerged"));
    finish();
    st.unavailable = false;
    const summary = {
      generation: MAX_GENERATION,
      snapshotId: crypto.randomUUID(),
      identity: { worktreeRoot: w.worktreeRoot, gitDirectory: w.gitDirectory, commonDirectory: w.commonDirectory, indexPath: w.indexPath, objectFormat: w.objectFormat, refFormat: w.refFormat },
      head,
      operationState,
      recoveryState: recoveryOf(st, w),
      completeness,
      hunkEligibility: eligibility,
      submoduleNotice: submodules.notice,
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
    const recorded = st.recorded < sequence;
    if (recorded) {
      const hasher = new Bun.CryptoHasher("sha256");
      for (const { entryId: _, ...entry } of entries) hasher.update(`${JSON.stringify(entry)}\n`);
      const entriesDigest = hasher.digest("hex");
      const retained = snapshots.retained(w.repositoryId);
      const advance = last || (retained !== null && (retained.entriesDigest !== entriesDigest || snapshots.retainedEqual(observation) === null));
      // Contract §8: an advance invalidates every token of the old generation, so its bound paths leave the observation.
      const dropped = advance && t.bound === undefined;
      if (dropped) st.bound.clear();
      snapshot = snapshots.record(dropped ? { ...observation, workingVersions: [] } : observation, { entries, starts, cursors, pages: new Map(cursors.slice(1).map((cursor, i) => [cursor, i + 1])), entriesDigest }, advance);
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
    if (recorded) {
      // Contract §8 "Change check": only a complete read keeps a tuple. A HEAD with another branch ref file than the tuple keeps none.
      const sameRef = branchRef(w, assumed) === branchRef(w, head);
      st.kept = value.completeness.state === "complete" && tuple !== null && sameRef ? { ...tuple, hints, listing: lst, policy, value } : null;
      st.head = head;
    }
    if (value.completeness.state === "complete") return { kind: "done", outcome: { result: "succeeded", value } };
    return { kind: "done", outcome: { result: "limited", code: value.completeness.code as "OUTPUT_LIMIT" | "WORKTREE_CHANGING", value } };
  }

  return {
    // Contract §3 `readWorkspace`. A dirty state, `refresh: true`, and `check: "full"` each run a full read.
    async readWorkspace(t: ReadWorkspaceTarget): Promise<ReadOutcome> {
      snapshots.register(t.workspace.repositoryId);
      const st = stateOfWorkspace(t.workspace.repositoryId);
      // Contract §8 "Change check": without a hint and with an equal tuple, the last snapshot returns and no Git process starts.
      // A trust approval or revocation changes the policy without a file change, so the policy must also be equal.
      const kept = st.kept;
      // Contract §11 "Change polling": a WSL workspace has no watcher and uses no stat tuple, so each of its reads runs in full.
      if (t.check === "changes" && !t.refresh && kept !== null && kept.hints === st.hints && !st.unwatched && !st.unavailable && t.workspace.wsl === undefined) {
        const facts = await tupleFacts(runner, t.operationId, t.workspace, kept.files, kept.programs, t.signal);
        const bound = [...st.bound.keys()];
        const working = await workingFacts(t.workspace, [...st.bound.values()]);
        if (t.signal.aborted) return { result: "canceled" };
        // Contract §5 "Deadline outcomes": a walk deadline ends the read as a Git step deadline does, never with a full read.
        if (facts !== null && "stop" in facts) return { result: facts.stop };
        const sameWorking = working !== null && st.bound.size === bound.length && bound.every((key) => kept.working.get(key) === working.get(key));
        const same = facts !== null && sameWorking && tupleText(kept.files, kept.programs, facts) === kept.facts && st.kept === kept && kept.hints === st.hints && !st.unavailable && !st.unwatched;
        if (same && policyOf(trust, t.workspace, kept.listing, t.installation) === kept.policy) return { result: "succeeded", value: { ...kept.value, recoveryState: recoveryOf(st, t.workspace) } };
      }
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

    // Contract §3 `readComparison`: the generation, then the snapshot, then the entry. No Git process starts.
    entry(repositoryId: string, generation: number, snapshotId: string, entryId: string): { ok: true; snapshot: ChangeSnapshot; entry: ChangeEntry } | { ok: false; code: "REPOSITORY_CHANGED" | "UNKNOWN_TARGET" } {
      snapshots.register(repositoryId);
      const found = snapshots.lookup(repositoryId, generation, snapshotId);
      if (!found.ok) return found;
      const entry = found.snapshot.entries.find((e) => e.entryId === entryId);
      return entry === undefined ? { ok: false, code: "UNKNOWN_TARGET" } : { ok: true, snapshot: found.snapshot, entry };
    },

    // Contract §3 `reviewCommit`: the generation, then the snapshot. No Git process starts.
    snapshot(repositoryId: string, generation: number, snapshotId: string): { ok: true; snapshot: ChangeSnapshot } | { ok: false; code: "REPOSITORY_CHANGED" | "UNKNOWN_TARGET" } {
      snapshots.register(repositoryId);
      return snapshots.lookup(repositoryId, generation, snapshotId);
    },

    // Data-model §4 `workingVersions`: later reads of this generation compare the bound path too. False: no snapshot of `generation` exists.
    // `fact` is the contract §8 tuple fact of the path from before the read of `version`. Null: the fact is unknown.
    bind(repositoryId: string, generation: number, version: WorkingVersion, fact: string | null = null): boolean {
      if (!snapshots.bind(repositoryId, generation, version)) return false;
      const st = stateOfWorkspace(repositoryId);
      const key = latin1(version.path);
      st.bound.set(key, version.path);
      // A kept fact other than `fact` shows a change near the comparison. The next poll then runs in full.
      if (st.kept !== null) {
        const kept = st.kept.working.get(key);
        if (fact === null || (kept !== undefined && kept !== fact)) st.kept = null;
        else st.kept.working.set(key, fact);
      }
      return true;
    },

    // Contract §8 "Change check": the tuple fact of one working file. A comparison takes it before it reads the file. Null: the fact is unknown.
    workingFact: async (w: Workspace, path: Uint8Array): Promise<string | null> => (await workingFacts(w, [path]))?.get(latin1(path)) ?? null,

    // Data-model §2 `operationState` from the marker facts. `unmerged`: the index holds an entry above stage 0.
    async operationState(t: ProcessTarget, unmerged: boolean): Promise<OperationState | { refused: ErrorCode } | "canceled" | "deadline"> {
      const { present, steps } = await markerFacts(t, stateOfWorkspace(t.workspace.repositoryId));
      if (t.signal.aborted) return "canceled";
      for (const step of steps) if ("refused" in step) return { refused: step.refused };
      const exits = steps.map((step) => (step as { exit: GitExit }).exit);
      if (exits.some((exit) => exit.deadline !== undefined)) return "deadline";
      if (exits.some((exit) => exit.diagnosticLimit)) return { refused: "OUTPUT_LIMIT" };
      return stateOf(present, unmerged);
    },

    // Data-model §7: the re-read after a canceled or failed read. Contract §6 "Registration bootstrap": every nonzero exit of the first discovery call gives REPOSITORY_UNAVAILABLE.
    // Null: the call exited 0, or it ended without an exit status of Git.
    async recheck(t: ProcessTarget): Promise<Extract<ReadOutcome, { result: "failed" }> | null> {
      const step = await run(t, recheckArgs(), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
      if (t.signal.aborted || "refused" in step || step.exit.deadline !== undefined || step.exit.diagnosticLimit || step.exit.exitCode === null || step.exit.exitCode === 0) return null;
      const st = stateOfWorkspace(t.workspace.repositoryId);
      st.unavailable = true;
      return { result: "failed", code: "REPOSITORY_UNAVAILABLE", value: { completeness: { state: "failed", code: "REPOSITORY_UNAVAILABLE" }, recoveryState: recoveryOf(st, t.workspace) } };
    },

    // Data-model §2 `recoveryState` now, for a result that recovery changed.
    recoveryState: (w: Workspace): RecoveryState => recoveryOf(stateOfWorkspace(w.repositoryId), w),

    // Contract §7 "Shared listing": `readHistory` reads this tuple again before it reuses a listing.
    listingTuple: (w: Workspace, operationId: string, signal: AbortSignal): Promise<string | WalkStop | null> => listingTuple(runner, w, stateOfWorkspace(w.repositoryId), operationId, signal),

    // A watcher hint marks the workspace dirty (contract §8 "Token invalidation"). `lost`: later changes can give no hint.
    hint(repositoryId: string, lost: boolean): void {
      const st = stateOfWorkspace(repositoryId);
      st.hints++;
      st.unwatched ||= lost;
    },

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
