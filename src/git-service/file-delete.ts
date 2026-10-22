// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 contract Δ3 `reviewWorkbench` `delete` and `runWorkbench`, Δ6 `fileDelete`, data-model §4 and §5, plan.md D6 (spec FR-020 to FR-033).
// No Git command deletes a working file here. The shell checks each entry again under its handle and deletes it. Fresh facts and a status read decide the result.

import type { ChangeEntry } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { FILE_FACT_COMPONENT_UNITS, FILE_FACT_ENTRIES, GIT_PROCESS_DEADLINE_MS, MULTI_FILE_ACTION_FILES, MULTI_FILE_STEP_MS_PER_FILE, REGISTERED_DEADLINE_CAP_MS } from "../contracts/limits";
import { isWindows, NATIVE } from "../contracts/native-path";
import { compareKeys, treeKey } from "../contracts/tree-order";
import { RunnerRefusal, type DeleteEntryReply, type DeleteFolderReply, type FileDeleteExpected, type FileDeleteReply, type FileFact, type WalkStop } from "./git-runner";
import { contextOf, strictUtf8 } from "./read-steps";
import type { Workspace } from "./registration";
import { registerWorkbenchAction, unavailable, type Observation, type PayloadOf, type StepEnd, type WorkbenchContext, type WorkbenchRun } from "./workbench-review";

type Payload = PayloadOf<"delete">;

// Data-model §4: one entry of the plan, with its review fact.
interface BoundEntry {
  entryId: string;
  pathBytes: string;
  category: ChangeEntry["category"];
  expected: FileDeleteExpected;
}

// Data-model §4 `bound`, compared again by `runWorkbench`.
interface DeleteBound {
  snapshotId: string;
  mode: Payload["mode"];
  folder: string | null;
  conflicted: number;
  entries: BoundEntry[];
  // The candidate folders of a folder Delete, as worktree-relative names, deepest first.
  folders: string[][];
}

type Facts = { value: FileFact[] } | { code: ErrorCode } | WalkStop;
type FileOutcome = { entryId: string; outcome: "recycled" | "deleted" | "kept" | "changed" | "absent" | "not-regular" | "error" | "stopped"; code?: string; recycledPath?: string };
type FolderOutcome = { pathBytes: string; outcome: "removed" | "kept" | "absent" | "not-regular" | "error"; code?: string };

const SLASH = 0x2f;
// Contract Δ5 "Delete confirmation paths".
const CONFIRMATION_PATHS = 20;
// Plan.md D6 `long-path`: `MAX_PATH` of the Shell parse (Microsoft Learn "Maximum Path Length Limitation"; src-tauri/src/file_delete.rs `MAX_PATH`).
const MAX_PATH = 260;
const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));
const isStop = (value: object): value is WalkStop => "stop" in value;
const under = (names: readonly string[], top: readonly string[]) => names.length >= top.length && top.every((name, i) => names[i] === name);

// The worktree-relative names of `path`, or null when one name breaks the contract §6 component rule of `fileFacts`, which the shell `below` rule also applies.
// The shell cannot act on such a name, such as a Windows name that ends in a period or a space (plan.md D7 N9).
function namesOf(path: Uint8Array): string[] | null {
  let text: string;
  try {
    text = strictUtf8.decode(path);
  } catch {
    return null;
  }
  const names = text.split("/");
  return names.every((name) => name.length > 0 && name.length <= FILE_FACT_COMPONENT_UNITS && name.isWellFormed() && NATIVE.isComponent(name)) ? names : null;
}

// The native path of `names` below the worktree root. A WSL root is its UNC form (contract §11).
const nativePath = (w: Workspace, names: readonly string[]) => NATIVE.path.join(w.worktreeRoot, ...names);

// Contract §6 "File facts" in frames of 64 entries. A file that the frame total left without a digest (`total-bytes`) goes again in a later frame.
async function factsOf(ctx: WorkbenchContext, paths: readonly string[][], digest: boolean): Promise<Facts> {
  const facts: FileFact[] = [];
  let pending = paths.map((_, i) => i);
  while (pending.length > 0) {
    const frame = pending.slice(0, FILE_FACT_ENTRIES);
    let reply: FileFact[] | WalkStop;
    try {
      reply = await ctx.runner.fileFacts({ operationId: ctx.operationId, ...contextOf(ctx.workspace), digest, files: frame.map((i) => ({ root: "worktreeRoot", path: paths[i]! })) }, ctx.signal);
    } catch (error) {
      if (error instanceof RunnerRefusal) return { code: error.code };
      throw error;
    }
    if (isStop(reply)) return reply;
    const again: number[] = [];
    // The first entry of a frame always gets its digest within the frame total, so the loop ends.
    frame.forEach((i, at) => (reply[at]!.kind === "file" && (reply[at] as { bound?: string }).bound === "total-bytes" && at > 0 ? again.push(i) : (facts[i] = reply[at]!)));
    pending = [...again, ...pending.slice(frame.length)];
  }
  return { value: facts };
}

// Plan.md D6 "Review reads": the fact that the run binds. A folder, a special file, an absent path, or a link on the way shows that the status read no longer holds.
function expectedOf(fact: FileFact, components: number): FileDeleteExpected | "stale" | "unreadable" {
  if (fact.kind === "error") return "unreadable";
  if (fact.kind === "file") return { kind: "file", size: fact.size, lastWrite: fact.lastWrite, ...(fact.digest === undefined ? {} : { digest: fact.digest }) };
  if (fact.kind === "link" && fact.component === components) return { kind: "link", tag: fact.tag, ...(fact.target === undefined ? {} : { target: fact.target }) };
  return "stale";
}

// Plan.md D6 step 4: the selected folder and each folder between it and a deleted file, but no folder above the selected folder. Deepest first.
function candidates(folder: string[], files: readonly string[][]): string[][] {
  const seen = new Map<string, string[]>();
  for (const names of files) for (let depth = folder.length; depth < names.length; depth++) seen.set(names.slice(0, depth).join("/"), names.slice(0, depth));
  const keyed = [...seen.values()].map((names) => ({ names, key: treeKey(Buffer.from(names.join("/")), true) }));
  return keyed.sort((a, b) => b.names.length - a.names.length || compareKeys(a.key, b.key)).map(({ names }) => names);
}

// Contract Δ6: a request holds at most 64 folders, and each folder of a request lies below the shallowest folder of that request.
// A subtree with more candidates goes first through its children, so the global order stays deepest first.
function folderRequests(all: readonly string[][], top: string[]): string[][][] {
  const subtree = all.filter((f) => under(f, top));
  if (subtree.length <= FILE_FACT_ENTRIES) return [subtree];
  const children = all.filter((f) => f.length === top.length + 1 && under(f, top));
  return [...children.flatMap((child) => folderRequests(all, child)), [top]];
}

// Plan.md D6 "Deadline per fileDelete".
const deadlineOf = (items: number) => Math.min(GIT_PROCESS_DEADLINE_MS + MULTI_FILE_STEP_MS_PER_FILE * items, REGISTERED_DEADLINE_CAP_MS);

async function observeDelete(ctx: WorkbenchContext, p: Payload): Promise<Observation<DeleteBound>> {
  const w = ctx.workspace;
  const found = ctx.reader.selection(w.repositoryId, w.generation, p.snapshotId);
  if (!found.ok) return { refused: found.code };
  const snapshot = found.snapshot;
  const byId = new Map(snapshot.entries.map((e) => [e.entryId, e]));
  const picked = p.entryIds.map((id) => byId.get(id));
  // Contract Δ3: an entry of another snapshot and a `staged` entry give INVALID_REQUEST.
  if (picked.some((e) => e === undefined || e.category === "staged")) return { refused: "INVALID_REQUEST" };
  const entries = picked as ChangeEntry[];
  const pathOf = (e: ChangeEntry) => bytesOf(e.pathBytes);
  let folder: string[] | null = null;
  if (p.folder !== undefined) {
    const prefix = Buffer.concat([bytesOf(p.folder), Uint8Array.of(SLASH)]);
    // Data-model §4: a folder Delete holds exactly the Changes entries below the folder, also the rows that Filter files hides (004 FR-101).
    // A cut read lacks untracked entries, so no listed set can equal the folder set (004 contract Δ4 "Status cut").
    const derived = snapshot.entries.filter((e) => e.category !== "staged" && Buffer.compare(pathOf(e).subarray(0, prefix.length), prefix) === 0);
    if (snapshot.cut === "untracked" || derived.length > MULTI_FILE_ACTION_FILES) return unavailable("limit");
    const ids = new Set(p.entryIds);
    if (derived.length !== ids.size || !derived.every((e) => ids.has(e.entryId))) return { refused: "STALE_SELECTION" };
    folder = namesOf(bytesOf(p.folder));
    if (folder === null) return unavailable("path");
  }
  // Plan.md D6 refusals, in the order of their list.
  if (entries.some((e) => e.category === "conflicted")) return unavailable("conflicted");
  if (entries.some((e) => e.submodule?.startsWith("S") === true)) return unavailable("submodule");
  // git-status(1) `--untracked-files=all` prints a folder record only for a nested repository.
  if (entries.some((e) => e.category === "untracked" && pathOf(e).at(-1) === SLASH)) return unavailable("nested-repository");
  // Spec FR-033: Delete counts as a mutation for 001 FR-016, so the unmerged paths of the shown read refuse it with their count.
  const conflicted = new Set(snapshot.entries.filter((e) => e.category === "conflicted").map((e) => e.pathBytes)).size;
  if (conflicted > 0) return { refused: "CONFLICTED", result: { unmerged: conflicted } };
  if (entries.length > MULTI_FILE_ACTION_FILES) return unavailable("limit");
  if (p.mode === "recycle" && w.wsl !== undefined) return unavailable("no-recycle-bin");
  // An unstaged deletion (Y = D) has no working file, so it leaves the plan.
  const files = entries.filter((e) => e.category === "untracked" || e.xy?.[1] !== "D");
  if (files.length === 0) return unavailable("nothing-to-delete");
  const names = files.map((e) => namesOf(pathOf(e)));
  if (names.some((n) => n === null)) return unavailable("path");
  const paths = names as string[][];
  if (p.mode === "recycle" && isWindows && paths.some((n) => nativePath(w, n).length >= MAX_PATH)) return unavailable("long-path");
  const facts = await factsOf(ctx, paths, true);
  if ("stop" in facts) return facts;
  if ("code" in facts) return { code: facts.code };
  const expected = facts.value.map((fact, i) => expectedOf(fact, paths[i]!.length));
  if (expected.includes("unreadable")) return unavailable("unreadable");
  if (expected.includes("stale")) return { refused: "STALE_SELECTION" };
  // Data-model §3: one tree key per row, built once.
  const order = files.map((e, i) => ({ e, i, key: treeKey(pathOf(e)) })).sort((a, b) => compareKeys(a.key, b.key));
  const bound: DeleteBound = {
    snapshotId: p.snapshotId,
    mode: p.mode,
    folder: p.folder ?? null,
    conflicted,
    entries: order.map(({ e, i }) => ({ entryId: e.entryId, pathBytes: e.pathBytes, category: e.category, expected: expected[i] as FileDeleteExpected })),
    folders: folder === null ? [] : candidates(folder, order.map(({ i }) => paths[i]!)),
  };
  const plan = {
    mode: p.mode,
    entryIds: bound.entries.map((e) => e.entryId),
    files: { count: bound.entries.length, paths: bound.entries.slice(0, CONFIRMATION_PATHS).map((e) => e.pathBytes) },
    tracked: bound.entries.filter((e) => e.category === "unstaged").length,
    folder: bound.folder,
    wsl: w.wsl !== undefined,
  };
  return { bound, plan };
}

// Plan.md D6 "Outcome per file": the reply, then the fresh fact. `stopped`, `interrupted`, and no reply give `stopped` for a present file.
function fileOutcome(entryId: string, reply: DeleteEntryReply | null, present: boolean): FileOutcome {
  const at = (outcome: FileOutcome["outcome"], extra: Partial<FileOutcome> = {}): FileOutcome => ({ entryId, outcome, ...extra });
  if (!present) return reply?.result === "recycled" ? at("recycled", { recycledPath: reply.recycledPath }) : reply?.result === "deleted" ? at("deleted") : at("absent");
  if (reply === null || reply.result === "stopped") return at("stopped");
  if (reply.result === "kept" || reply.result === "not-regular") return at(reply.result);
  if (reply.result === "error") return at("error", { code: reply.code });
  return at("changed");
}

// Data-model §5 per candidate folder, from the reply and the fresh fact.
function folderOutcome(names: readonly string[], reply: DeleteFolderReply | null, present: boolean): FolderOutcome {
  const pathBytes = Buffer.from(names.join("/")).toString("base64");
  if (!present) return { pathBytes, outcome: reply?.result === "removed" ? "removed" : "absent" };
  if (reply?.result === "error") return { pathBytes, outcome: "error", code: reply.code };
  return { pathBytes, outcome: reply?.result === "not-regular" ? "not-regular" : "kept" };
}

async function runDelete(r: WorkbenchRun, _p: Payload, bound: DeleteBound): Promise<void> {
  const { ctx, q } = r;
  const w = ctx.workspace;
  const names = bound.entries.map((e) => namesOf(bytesOf(e.pathBytes))!);
  const replies: (DeleteEntryReply | null)[] = bound.entries.map(() => null);
  const folderReplies = new Map<string, DeleteFolderReply>();
  // A WSL `interrupted` reply: the process changed files inside its walk, so the process-end fact comes before the fresh facts (contract §11).
  const ends: StepEnd[] = [];
  let refused: ErrorCode | null = null;
  let deadline = false;
  // One request with the contract Δ3 deadline. The shell replies once, also after `cancel`. Null: no reply, or a request that the shell refused.
  const send = async (entries: number[], folders: string[][]): Promise<Extract<FileDeleteReply, { entries: unknown }> | null> => {
    const timeout = AbortSignal.timeout(deadlineOf(entries.length + folders.length));
    const signal = AbortSignal.any([ctx.signal, timeout]);
    let reply: FileDeleteReply | WalkStop;
    try {
      reply = await ctx.runner.fileDelete(
        { operationId: ctx.operationId, repositoryId: w.repositoryId, mode: bound.mode, entries: entries.map((i) => ({ path: nativePath(w, names[i]!), expected: bound.entries[i]!.expected })), folders: folders.map((f) => nativePath(w, f)) },
        signal,
      );
    } catch (error) {
      if (!(error instanceof RunnerRefusal)) throw error;
      refused = error.code;
      return null;
    }
    if ("entries" in reply) return reply;
    if ("result" in reply && reply.result === "interrupted") ends.push({ exit: null, canceled: ctx.signal.aborted, refused: null, outputTail: "" });
    // Contract Δ3: only the service deadline of this request gives DEADLINE. A shell `stopped` names no cause.
    deadline ||= timeout.aborted;
    return null;
  };
  r.progress("delete-files", { fileIndex: 0, fileCount: bound.entries.length });
  let ended = false;
  for (let start = 0; start < bound.entries.length && !ended && !ctx.signal.aborted; start += FILE_FACT_ENTRIES) {
    const batch = bound.entries.slice(start, start + FILE_FACT_ENTRIES).map((_, i) => start + i);
    const reply = await send(batch, []);
    if (reply === null) ended = true;
    else batch.forEach((i, at) => (replies[i] = reply.entries[at]!));
    r.progress("delete-files", { fileIndex: start + batch.length, fileCount: bound.entries.length });
  }
  if (!ended && bound.folders.length > 0) {
    for (const request of folderRequests(bound.folders, bound.folders.at(-1)!)) {
      if (ctx.signal.aborted) break;
      const reply = await send([], request);
      if (reply === null) break;
      request.forEach((folder, i) => folderReplies.set(folder.join("/"), reply.folders[i]!));
    }
  }
  const settled = await r.reconcile(ends);
  const result = { action: "delete" };
  if (settled === null) return r.unknown({ code: "GIT_FAILED" }, result);
  // Plan.md D6 step 5: fresh facts of every path and folder, then the status read.
  const fresh = await factsOf(q, [...names, ...bound.folders], false);
  const status = await q.reader.readWorkspace({ operationId: q.operationId, signal: q.signal, installation: q.installation, workspace: q.workspace, refresh: false });
  if (!("value" in fresh)) return r.unknown("code" in fresh ? { code: fresh.code } : fresh, result);
  if (status.result === "deadline") return r.unknown({ stop: "deadline" }, result);
  // A fresh `error` fact cannot tell present from absent, so the outcome stays unknown (contract §8).
  if (fresh.value.some((fact) => fact.kind === "error")) return r.unknown({ code: "GIT_FAILED" }, result);
  const present = fresh.value.map((fact) => fact.kind !== "absent");
  const files = bound.entries.map((e, i) => fileOutcome(e.entryId, replies[i]!, present[i]!));
  const folders = bound.folders.map((f, i) => folderOutcome(f, folderReplies.get(f.join("/")) ?? null, present[names.length + i]!));
  const value = { action: "delete", entries: files, folders };
  const removed = files.filter((f) => f.outcome === "recycled" || f.outcome === "deleted").length;
  // Plan.md D6 table, last row: a request without an entry reply, or with `stopped`, can have removed the file before it stopped.
  const gone = bound.entries.filter((_, i) => !present[i] && (replies[i] === null || replies[i]!.result === "stopped")).length;
  // Plan.md D6 "Response state": the delete phase does not stop at a Cancel, so the effects come first. Cancel never reports an undo.
  if (removed === files.length) return r.finish({ type: "intended-effects-confirmed" }, value);
  if (removed + gone > 0) return r.finish({ type: "failed-with-effects" }, value);
  if (settled.canceled) return r.finish({ type: "no-effects", observed: "canceled" }, value);
  // No file removed: the code of the first file in tree order.
  const code: ErrorCode = refused ?? (files[0]!.outcome === "changed" ? "STALE_REVIEW" : files[0]!.outcome === "stopped" && deadline ? "DEADLINE" : "GIT_FAILED");
  r.finish({ type: "no-effects", observed: "failed", code }, value);
}

registerWorkbenchAction<"delete", DeleteBound>("delete", {
  observe: (ctx, p) => observeDelete(ctx, p),
  started: () => "delete-files",
  // Plan.md D6: the run starts no Git process that reads the index before its reconcile read.
  observeBefore: false,
  run: runDelete,
});
