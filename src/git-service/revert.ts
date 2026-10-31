// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 plan.md D2, D5a, D6, and D10: the review and run frame of `revert-lines`, `revert-files`, and `revert-unstaged`.
// No Git command writes a target file. Git writes only its own temporary file through `checkout-index --temp`, and the shell replaces each target.
// A fresh read decides every outcome. Plan.md D3 and D4 (lines) and the index part of D5 come in T026, T030, and T039.

import type { ChangeEntry } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { filterReason } from "../contracts/file-action";
import { FILE_FACT_COMPONENT_UNITS, FILE_FACT_ENTRIES, MULTI_FILE_ACTION_FILES, MULTI_FILE_ATTRIBUTE_BYTES, WINDOWS_COMMAND_LINE_UNITS } from "../contracts/limits";
import { NATIVE } from "../contracts/native-path";
import { compareKeys, treeKey } from "../contracts/tree-order";
import { attributeArgs, cachedAttributeArgs, checkoutTempArgs, indexPathArgs, objectCheckArgs, OID_HEX } from "./commands";
import { hunkEligibility, IndexFormatError } from "./eligibility";
import { createCollector, RunnerRefusal, sizeDeadlineMs, stepUnits, type FileFact, type TempRemoveReply, type WalkStop, type WorkingReplaceReply, type WorkingReplaceRequest } from "./git-runner";
import { canonicalIndex, indexOf, isStop, lingeringText, missingObject, PROFILE_TEXTS, settled, stepOf, type Fact, type Failure, type Stop } from "./hunk-publish";
import { LOCKED_REMEDY } from "./index-lock";
import { contextOf, latin1, strictUtf8 } from "./read-steps";
import type { Workspace } from "./registration";
import { policyOf } from "./status";
import { parseAttributes, SUPPORT_REASONS, type SupportAttributes } from "./support";
import { registerWorkbenchAction, unavailable, type Common, type Observation, type PayloadOf, type Refused, type StepEnd, type WorkbenchContext, type WorkbenchRun } from "./workbench-review";
import { wslIndexDigest } from "./wsl-files";

type Action = "revert-lines" | "revert-files" | "revert-unstaged";
type Entry = { mode: string; oid: string };
type Working = Exclude<WorkingReplaceRequest["facts"], "absent">;
type FileFactOf = Extract<FileFact, { kind: "file" }>;

// Data-model §3: one file of the plan.
interface FilePlan {
  entryId: string;
  pathBytes: string;
  headEntry: Entry | "absent";
  indexEntry: Entry | "absent";
  newIndex: Entry | "remove" | "keep";
  working: Working | "absent";
  // For an absent target: the missing folder names below the deepest existing folder.
  folders: string[];
  // The index entry that `checkout-index --temp` writes, and its blob size from `cat-file --batch-check`.
  source: (Entry & { size: number }) | null;
}

// Data-model §2. `runWorkbench` compares the whole bound again (plan.md D2).
interface RevertBound {
  action: Action;
  snapshotId: string;
  policyFingerprint: string;
  indexLock: "absent";
  // The raw index digest of an action with an index part. No action of the frame has one yet.
  index: string | null;
  files: FilePlan[];
  attributes: { working: SupportAttributes; index: SupportAttributes }[];
}

type Snapshot = Extract<ReturnType<WorkbenchContext["reader"]["selection"]>, { ok: true }>["snapshot"];
// A file of the review with its worktree-relative names. Null names: the path breaks the contract §6 component rule.
type Candidate = { entry: ChangeEntry; path: Uint8Array; names: string[] | null };
type FileReason = { pathBytes: string; reason: string };

const SLASH = 0x2f;
// Contract Δ3 "Refusal value": the first 20 refused files in tree order.
const REFUSED_FILES = 20;
// Data-model §5: the first confirmation paths in tree order.
const CONFIRMATION_PATHS = 20;
const GITLINK = "160000";
const SYMLINK = "120000";
const ABSENT_MODE = "000000";
// Research.md R8: the write keeps hidden, system, and not-content-indexed, and archive and normal are no compared fact.
// FILE_ATTRIBUTE_READONLY, _HIDDEN, _SYSTEM, _ARCHIVE, _NORMAL, _NOT_CONTENT_INDEXED, and _ENCRYPTED (Microsoft Learn "File Attribute Constants").
const READ_ONLY = 0x1;
const ENCRYPTED = 0x4000;
const KEPT_ATTRIBUTES = READ_ONLY | 0x2 | 0x4 | 0x20 | 0x80 | 0x2000 | ENCRYPTED;
// Research.md R7: the six conversion values. `diff` changes no bytes.
const CONVERSION: readonly (keyof SupportAttributes)[] = ["text", "eol", "crlf", "ident", "filter", "working-tree-encoding"];
const SUPPORT: readonly string[] = SUPPORT_REASONS;
// git-cat-file(1) BATCH OUTPUT: `<oid> SP <type> SP <size> LF`. A 64-digit object ID, a type of at most 6 letters, and a 64-bit size give 93 bytes.
const CHECK_LINE_BYTES = 93;
// Plan.md D5a step 2: `.merge_file_XXXXXX` of `mkstemp` (Git `entry.c`). A record holds the name, TAB, the path, and NUL.
const TEMP_NAME_UNITS = FILE_FACT_COMPONENT_UNITS;
const STALE: Refused = { refused: "STALE_SELECTION" };
const NUL = Uint8Array.of(0);

const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const sameEntry = (a: Entry | "absent", b: Entry | "absent") => (a === "absent" || b === "absent" ? a === b : a.mode === b.mode && a.oid === b.oid);
const byTree = <T extends { path: Uint8Array }>(items: T[]) => items.map((item) => ({ item, key: treeKey(item.path) })).sort((a, b) => compareKeys(a.key, b.key)).map(({ item }) => item);

// The worktree-relative names of `path`, or null when one name breaks the contract §6 component rule that the shell `below` rule also applies.
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

const nativePath = (w: Workspace, names: readonly string[]) => NATIVE.path.join(w.worktreeRoot, ...names);

// ---- Reads ----

// Contract §6 "File facts" in frames of 64 entries. A `stream` digest has no bound, so each fact holds its digest.
async function factsOf(ctx: WorkbenchContext, files: { root: "worktreeRoot" | "gitDirectory"; path: string[] }[], options: { digest: boolean; detail?: boolean; stream?: boolean }): Promise<Fact<FileFact[]>> {
  const facts: FileFact[] = [];
  for (let at = 0; at < files.length; at += FILE_FACT_ENTRIES) {
    const frame = files.slice(at, at + FILE_FACT_ENTRIES);
    let reply: FileFact[] | WalkStop;
    try {
      reply = await ctx.runner.fileFacts({ operationId: ctx.operationId, ...contextOf(ctx.workspace), digest: options.digest, files: frame, ...(options.detail ? { detail: true } : {}), ...(options.stream ? { stream: true } : {}) }, ctx.signal);
    } catch (error) {
      if (error instanceof RunnerRefusal) return { code: error.code };
      throw error;
    }
    if (!Array.isArray(reply)) return reply;
    facts.push(...reply);
  }
  return { value: facts };
}

// Contract Δ3: the paths after `--` in batches within the command-line bound of contract §6.
function pathBatches(ctx: WorkbenchContext, paths: readonly Uint8Array[], args: (texts: string[]) => string[]): string[][] | null {
  const batches: string[][] = [];
  const units = (texts: string[]) => stepUnits({ operationId: ctx.operationId, workspace: ctx.workspace, installation: ctx.installation }, "read", args(texts));
  for (const path of paths) {
    const text = strictUtf8.decode(path);
    const last = batches.at(-1);
    if (last !== undefined && units([...last, text]) <= WINDOWS_COMMAND_LINE_UNITS) last.push(text);
    else if (units([text]) <= WINDOWS_COMMAND_LINE_UNITS) batches.push([text]);
    else return null;
  }
  return batches;
}

// git-ls-files(1) `--stage -z`: `<mode> SP <object> SP <stage> TAB <file> NUL`. A literal pathspec also matches paths below a folder, so only exact paths count.
async function indexEntriesOf(ctx: WorkbenchContext, paths: readonly Uint8Array[]): Promise<Fact<Map<string, Entry>>> {
  const batches = pathBatches(ctx, paths, indexPathArgs);
  // A path above the command-line bound gives the reason `path` (as `applyFiles` does).
  if (batches === null) return { code: "WORKBENCH_UNAVAILABLE" };
  const wanted = new Set(paths.map(latin1));
  const header = new RegExp(`^([0-7]{6}) (${OID_HEX[ctx.workspace.objectFormat]}) ([0-3])$`);
  const entries = new Map<string, Entry>();
  for (const batch of batches) {
    const out = createCollector({ maxBytes: batch.reduce((n, p) => n + Buffer.byteLength(p) * 2 + 128, 0) });
    const step = await stepOf(ctx, indexPathArgs(batch), out);
    if (!("exit" in step)) return step;
    if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
    if (out.limited) return { code: "MALFORMED_GIT_OUTPUT" };
    const raw = out.take();
    for (let at = 0; at < raw.length; ) {
      const end = raw.indexOf(0, at);
      const tab = raw.indexOf(0x09, at);
      if (end < 0 || tab < 0 || tab > end) return { code: "MALFORMED_GIT_OUTPUT" };
      const m = header.exec(latin1(raw.subarray(at, tab)));
      if (m === null) return { code: "MALFORMED_GIT_OUTPUT" };
      const key = latin1(raw.subarray(tab + 1, end));
      at = end + 1;
      if (!wanted.has(key)) continue;
      // An entry above stage 0 makes the path conflicted, which the snapshot refuses first.
      if (m[3] !== "0" || entries.has(key)) return { code: "MALFORMED_GIT_OUTPUT" };
      entries.set(key, { mode: m[1]!, oid: m[2]! });
    }
  }
  return { value: entries };
}

// `check-attr` of both directions for every path (research.md R7), with the bound of `applyFiles`.
async function attributesOf(ctx: WorkbenchContext, paths: readonly Uint8Array[], args: string[]): Promise<Fact<SupportAttributes[]>> {
  const out = createCollector({ maxBytes: MULTI_FILE_ATTRIBUTE_BYTES });
  const step = await stepOf(ctx, args, out, Buffer.concat(paths.flatMap((p) => [p, NUL])));
  if (!("exit" in step)) return step;
  if (out.limited) return { code: "OUTPUT_LIMIT", reason: "MULTI_FILE_ATTRIBUTE_BYTES" };
  const parsed = step.exit.exitCode === 0 ? parseAttributes(out.take(), paths) : null;
  if (parsed === null) return { code: step.exit.exitCode === 0 ? "MALFORMED_GIT_OUTPUT" : "GIT_FAILED" };
  return { value: parsed };
}

// git-cat-file(1) `--batch-check`: one line per stdin object ID, in input order. `<oid> missing` names an absent object.
async function blobSizes(ctx: WorkbenchContext, oids: readonly string[]): Promise<Fact<Map<string, number | "missing">>> {
  const unique = [...new Set(oids)];
  const sizes = new Map<string, number | "missing">();
  if (unique.length === 0) return { value: sizes };
  const out = createCollector({ maxBytes: unique.length * CHECK_LINE_BYTES });
  const step = await stepOf(ctx, objectCheckArgs(), out, Buffer.from(unique.map((oid) => `${oid}\n`).join("")));
  if (!("exit" in step)) return step;
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const text = latin1(out.take());
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : null;
  if (out.limited || lines === null || lines.length !== unique.length) return { code: "MALFORMED_GIT_OUTPUT" };
  for (const [i, line] of lines.entries()) {
    const fields = line.split(" ");
    if (fields[0] !== unique[i]) return { code: "MALFORMED_GIT_OUTPUT" };
    if (fields.length === 2 && fields[1] === "missing") sizes.set(unique[i]!, "missing");
    else if (fields.length === 3 && fields[1] === "blob" && /^(?:0|[1-9][0-9]{0,15})$/.test(fields[2]!)) sizes.set(unique[i]!, Number(fields[2]));
    else return { code: "MALFORMED_GIT_OUTPUT" };
  }
  return { value: sizes };
}

// The raw digest of the canonical index (plan.md D5a steps 1 and 3). Null: no index file.
async function rawDigest(ctx: WorkbenchContext): Promise<Fact<string | null>> {
  if (ctx.workspace.wsl === undefined) {
    const read = await settled(ctx.signal, indexOf(ctx.workspace));
    return "value" in read ? { value: read.value.digest } : read;
  }
  const read = await settled(ctx.signal, wslIndexDigest(ctx));
  if (!("value" in read)) return read;
  const part = read.value.index;
  return part.kind === "digest" ? { value: part.sha256 } : part.kind === "absent" ? { value: null } : { code: "GIT_FAILED" };
}

// Plan.md D2 "Index lock": the fact of `index.lock` in the Git directory. A present lock refuses every revert with the 001 lock guidance.
async function lockRefusal(ctx: WorkbenchContext): Promise<Refused | Failure | Stop | null> {
  const fact = await factsOf(ctx, [{ root: "gitDirectory", path: ["index.lock"] }], { digest: false });
  if (!("value" in fact)) return fact;
  const f = fact.value[0]!;
  if (f.kind === "absent") return null;
  if (f.kind === "error") return { code: "GIT_FAILED" };
  const w = ctx.workspace;
  const count = await ctx.runner.lingeringCount(ctx.operationId, w.commonDirectory).catch(() => null);
  return { refused: "LOCKED", result: { path: `${w.indexPath}.lock`, remedy: { text: `${LOCKED_REMEDY}${lingeringText(typeof count === "number" ? count : null, ctx.trust.currentTrustId(w) !== undefined)}` } } };
}

// ---- Review ----

// The 001 support reasons of a whole file from its status record (data-model §7). `source` is the mode that the write restores.
function supportReason(c: Candidate, sourceMode: string): string | null {
  const e = c.entry;
  if (c.names === null) return "path";
  if (e.flags!.intentToAdd || e.flags!.assumeUnchanged || e.flags!.skipWorktree) return "index-flag";
  const modes = e.modes ?? [];
  if (e.submodule?.startsWith("S") === true || modes.includes(GITLINK)) return "submodule";
  if (e.xy?.includes("T") === true) return "type";
  if (modes.includes(SYMLINK)) return "symlink";
  if (e.score !== undefined || e.xy?.includes("R") === true || e.xy?.includes("C") === true) return "rename";
  // A mode change stays after a content write, because the write keeps the mode bits of the old file (spec FR-043).
  const workingMode = modes[2];
  if (workingMode !== undefined && workingMode !== ABSENT_MODE && workingMode !== sourceMode) return "mode";
  return null;
}

// Plan.md D8, D9: the reasons of the target facts. A link at any component is no regular file.
function factReason(fact: FileFact): string | null {
  if (fact.kind === "absent") return null;
  if (fact.kind !== "file") return fact.kind === "error" ? "unreadable" : "not-regular";
  if (fact.links !== 1) return "hard-link";
  if (fact.attributes !== undefined) {
    if ((fact.attributes & READ_ONLY) !== 0) return "read-only";
    if ((fact.attributes & ENCRYPTED) !== 0) return "encrypted";
    if ((fact.attributes & ~KEPT_ATTRIBUTES) !== 0) return "file-attributes";
  }
  return fact.xattr === true ? "xattr" : null;
}

const workingOf = (f: FileFactOf): Working | null => {
  if (f.digest === undefined || f.links === undefined) return null;
  if (f.attributes !== undefined) return { size: f.size, sha256: f.digest, attributes: f.attributes, links: f.links, owner: f.owner!, group: f.group!, dacl: f.dacl!, creationTime: f.creationTime! };
  // Contract Δ6 (decision of 2026-10-31): the WSL `mode` is the full `st_mode`. The shell compares the full value and copies `mode & 07777`.
  if (f.mode !== undefined && f.xattr === false) return { size: f.size, sha256: f.digest, mode: f.mode, uid: f.uid!, gid: f.gid!, links: f.links, xattr: false };
  return null;
};

// Data-model §2 and §3, plan.md D5 and D6: the whole-file plans of `entries`, with the D2 refusal order per file.
async function wholeFiles(ctx: WorkbenchContext, common: Common, entries: readonly ChangeEntry[], source: "index" | "head"): Promise<{ files: FilePlan[]; attributes: RevertBound["attributes"] } | Refused | Failure | Stop> {
  // Contract §4 "Comparison limits": a snapshot with a fingerprint keeps the index flags of every tracked entry.
  if (entries.some((e) => e.flags === undefined || e.modes === undefined || e.oids === undefined)) return { code: "MALFORMED_GIT_OUTPUT" };
  const candidates = byTree(entries.map((entry) => ({ entry, path: bytesOf(entry.pathBytes), names: namesOf(bytesOf(entry.pathBytes)) })));
  const readable = candidates.filter((c) => c.names !== null);
  const paths = readable.map((c) => c.path);
  const facts = await factsOf(ctx, readable.map((c) => ({ root: "worktreeRoot", path: c.names! })), { digest: true, detail: true, stream: true });
  if (!("value" in facts)) return facts;
  // The parent folders of each absent target, for `folders` and for a name in the way.
  const absent = readable.map((c, i) => (facts.value[i]!.kind === "absent" ? c : null));
  const prefixes = absent.flatMap((c) => (c === null ? [] : c.names!.slice(0, -1).map((_, depth) => c.names!.slice(0, depth + 1))));
  const prefixFacts = prefixes.length === 0 ? { value: [] as FileFact[] } : await factsOf(ctx, prefixes.map((path) => ({ root: "worktreeRoot", path })), { digest: false });
  if (!("value" in prefixFacts)) return prefixFacts;
  const workingAttributes = paths.length === 0 ? { value: [] } : await attributesOf(ctx, paths, attributeArgs());
  if (!("value" in workingAttributes)) return workingAttributes;
  const indexAttributes = paths.length === 0 ? { value: [] } : await attributesOf(ctx, paths, cachedAttributeArgs());
  if (!("value" in indexAttributes)) return indexAttributes;
  const indexed = paths.length === 0 ? { value: new Map<string, Entry>() } : await indexEntriesOf(ctx, paths);
  if (!("value" in indexed)) return "code" in indexed && indexed.code === "WORKBENCH_UNAVAILABLE" ? unavailable("path") : indexed;

  const reasons: FileReason[] = [];
  const files: FilePlan[] = [];
  const attributes: RevertBound["attributes"] = [];
  let prefixAt = 0;
  let readAt = 0;
  for (const c of candidates) {
    const e = c.entry;
    const headEntry: Entry | "absent" = e.modes![0] === ABSENT_MODE ? "absent" : { mode: e.modes![0]!, oid: e.oids![0]! };
    const snapshotIndex: Entry | "absent" = e.modes![1] === ABSENT_MODE ? "absent" : { mode: e.modes![1]!, oid: e.oids![1]! };
    const src = source === "head" ? headEntry : snapshotIndex;
    const support = supportReason(c, src === "absent" ? ABSENT_MODE : src.mode);
    if (c.names === null) {
      reasons.push({ pathBytes: e.pathBytes, reason: support! });
      continue;
    }
    const i = readAt++;
    const fact = facts.value[i]!;
    const parents = fact.kind === "absent" ? prefixFacts.value.slice(prefixAt, (prefixAt += c.names.length - 1)) : [];
    const cached = indexAttributes.value[i]!;
    const work = workingAttributes.value[i]!;
    const filter = filterReason(work);
    // Contract Δ3: the fresh index entry of the path must equal the shown read, or the shown read is stale.
    const fresh = indexed.value.get(latin1(c.path)) ?? "absent";
    if (!sameEntry(fresh, snapshotIndex)) return STALE;
    let reason = support ?? filter;
    if (reason === null) {
      reason = factReason(fact);
      // An absent target needs each missing folder. A link on the way, or another file at a folder name, blocks it (plan.md D8 `folders`).
      if (reason === null && fact.kind === "absent") {
        const blocked = parents.find((p) => p.kind !== "directory" && p.kind !== "absent");
        if (blocked !== undefined) reason = blocked.kind === "link" ? "not-regular" : blocked.kind === "error" ? "unreadable" : "in-the-way";
      }
    }
    if (reason === null && CONVERSION.some((name) => work[name] !== cached[name])) reason = "attributes";
    if (reason === "unreadable") return unavailable("unreadable");
    if (reason !== null) {
      reasons.push({ pathBytes: e.pathBytes, reason });
      continue;
    }
    const bound = fact.kind === "file" ? workingOf(fact) : "absent";
    if (bound === null) return { code: "MALFORMED_GIT_OUTPUT" };
    const missing = fact.kind === "absent" ? parents.findIndex((p) => p.kind === "absent") : -1;
    files.push({
      entryId: e.entryId,
      pathBytes: e.pathBytes,
      headEntry,
      indexEntry: snapshotIndex,
      newIndex: "keep",
      working: bound,
      folders: missing < 0 ? [] : c.names.slice(missing, -1),
      source: src === "absent" ? null : { ...src, size: 0 },
    });
    attributes.push({ working: work, index: cached });
  }
  if (reasons.length > 0) {
    const first = reasons[0]!;
    const code: ErrorCode = SUPPORT.includes(first.reason) ? "UNSUPPORTED_COMPARISON" : "WORKBENCH_UNAVAILABLE";
    return { refused: code, result: { reason: first.reason, files: reasons.slice(0, REFUSED_FILES).map((r) => ({ path: r.pathBytes, reason: r.reason })), more: Math.max(0, reasons.length - REFUSED_FILES) } };
  }
  // Contract Δ3: the blob size of each source entry, for the batches and the deadlines of plan.md D5a.
  const sizes = await blobSizes(ctx, files.flatMap((f) => (f.source === null ? [] : [f.source.oid])));
  if (!("value" in sizes)) return sizes;
  for (const f of files) {
    if (f.source === null) continue;
    const size = sizes.value.get(f.source.oid);
    if (size === "missing") {
      // Spec FR-005: a missing object refuses before any change, with the 001 remedy when a promisor remote can lend it.
      const missing = await missingObject(ctx, common.listing, undefined, "object-missing");
      return isStop(missing) ? missing : { refused: missing.code, ...(missing.remedy === undefined ? {} : { result: { remedy: missing.remedy } }) };
    }
    f.source.size = size!;
  }
  return { files, attributes };
}

type Payload = PayloadOf<Action>;

// Plan.md D2 "Review": the common reads of the frame, then the action reads. The order of the refusals follows the D2 list.
async function observeRevert(ctx: WorkbenchContext, p: Payload, common: Common): Promise<Observation<RevertBound>> {
  const w = ctx.workspace;
  const found = ctx.reader.selection(w.repositoryId, w.generation, p.snapshotId);
  if (!found.ok) return { refused: found.code };
  const s = found.snapshot;
  // Contract §5: a mutation needs a complete index snapshot.
  if (s.indexFingerprint === null || s.policyFingerprint === null) {
    const c = s.completeness;
    return c.state === "limited" ? { refused: c.code, ...(c.code === "OUTPUT_LIMIT" ? { result: { reason: c.reason } } : {}) } : { code: "MALFORMED_GIT_OUTPUT" };
  }
  // Spec FR-002: the unmerged paths of the shown read refuse every revert with their count, as Delete does.
  const unmerged = new Set(s.entries.filter((e) => e.category === "conflicted").map((e) => e.pathBytes)).size;
  if (unmerged > 0) return { refused: "CONFLICTED", result: { unmerged } };
  const locked = await lockRefusal(ctx);
  if (locked !== null) return locked;
  // Plan.md D2 and D7: the hunk eligibility. Only a staged part writes the index, so `index-change-hook` and `shared-repository` apply only to it.
  const index = await settled(ctx.signal, canonicalIndex(ctx, s.indexFingerprint));
  if (!("value" in index)) return index;
  const indexPart = false;
  let eligibility;
  try {
    eligibility = hunkEligibility(index.value.raw, w.objectFormat, indexPart ? common.listing : { entries: common.listing.entries, hooks: { ...common.listing.hooks, configured: [], folder: [] } }, w.wsl !== undefined && indexPart);
  } catch (error) {
    if (error instanceof IndexFormatError) return { code: "MALFORMED_GIT_OUTPUT" };
    throw error;
  }
  if (!eligibility.eligible) return { refused: "UNSUPPORTED_HUNK_PROFILE", result: { reason: eligibility.reason, remedy: { text: PROFILE_TEXTS[eligibility.reason] } } };
  // Data-model §2 `policyFingerprint`: the configuration of the shown read.
  const policyFingerprint = policyOf(ctx.trust, w, common.listing, ctx.installation);
  if (policyFingerprint !== s.policyFingerprint) return STALE;

  let entries: ChangeEntry[];
  let submodules = 0;
  const reasons: FileReason[] = [];
  if (p.action === "revert-lines") {
    // Plan.md D3 and D4: the line plan comes in T026 and T039.
    return { code: "SERVICE_UNAVAILABLE" };
  } else if (p.action === "revert-unstaged") {
    // Plan.md D6: every tracked entry with a working change, also the rows that Filter files hides. A submodule entry stays and counts.
    const covered = s.entries.filter((e) => e.category === "unstaged");
    const isSubmodule = (e: ChangeEntry) => e.submodule?.startsWith("S") === true || (e.modes ?? []).includes(GITLINK);
    submodules = covered.filter(isSubmodule).length;
    entries = covered.filter((e) => !isSubmodule(e));
    if (entries.length === 0) return unavailable("nothing-to-revert");
  } else {
    const byId = new Map(s.entries.map((e) => [e.entryId, e]));
    const picked = p.entryIds.map((id) => byId.get(id));
    // Contract Δ3: an entry of another snapshot or a duplicate ID gives INVALID_REQUEST.
    if (picked.some((e) => e === undefined) || new Set(p.entryIds).size !== p.entryIds.length) return { refused: "INVALID_REQUEST" };
    entries = [];
    for (const e of picked as ChangeEntry[]) {
      if (e.category === "untracked") reasons.push({ pathBytes: e.pathBytes, reason: "untracked" });
      // Plan.md D5 index part: an entry whose index differs from HEAD needs `publishIndex` (T030).
      else if (e.category === "staged" || e.xy?.[0] !== ".") return { code: "SERVICE_UNAVAILABLE" };
      else entries.push(e);
    }
  }
  if (entries.length + reasons.length > MULTI_FILE_ACTION_FILES) return unavailable("limit");
  const planned = await wholeFiles(ctx, common, entries, p.action === "revert-files" ? "head" : "index");
  if (!("files" in planned)) {
    if (reasons.length === 0 || !("refused" in planned) || planned.result?.files === undefined) return reasons.length === 0 ? planned : fileRefusal(reasons, []);
    return fileRefusal(reasons, planned.result.files as { path: string; reason: string }[]);
  }
  if (reasons.length > 0) return fileRefusal(reasons, []);
  const bound: RevertBound = { action: p.action, snapshotId: p.snapshotId, policyFingerprint, indexLock: "absent", index: null, files: planned.files, attributes: planned.attributes };
  const paths = planned.files.slice(0, CONFIRMATION_PATHS).map((f) => f.pathBytes);
  const count = planned.files.length;
  const plan = p.action === "revert-unstaged" ? { count, paths, submodules } : { count, paths, newFiles: 0, staged: 0, unstaged: count };
  return { bound, plan };
}

// Contract Δ3 "Refusal value": the reasons of the payload and of the reads together, in tree order.
function fileRefusal(own: FileReason[], read: { path: string; reason: string }[]): Refused {
  const all = byTree([...own.map((r) => ({ path: bytesOf(r.pathBytes), reason: r.reason })), ...read.map((r) => ({ path: bytesOf(r.path), reason: r.reason }))]);
  const first = all[0]!;
  return {
    refused: SUPPORT.includes(first.reason) ? "UNSUPPORTED_COMPARISON" : "WORKBENCH_UNAVAILABLE",
    result: { reason: first.reason, files: all.slice(0, REFUSED_FILES).map((r) => ({ path: b64(r.path), reason: r.reason })), more: Math.max(0, all.length - REFUSED_FILES) },
  };
}

// ---- Run ----

type Reply = WorkingReplaceReply | null;
type Temp = { name: string; size: number; sha256: string };
type FileOutcome = { entryId: string; outcome: "reverted" | "unstaged-only" | "not-changed" | "changed-outside" | "not-started"; code?: "stale" | "refused" | "error"; reason?: string };

// Plan.md D5a step 2: the complete records `<temp> TAB <path> NUL` whose name is one path component in the worktree root and whose path is a batch path.
// `exact` is false for any other byte: a record outside that grammar, a path outside the batch, a path twice, or a record without its NUL.
function tempRecords(raw: Uint8Array, batch: readonly Uint8Array[]): { temps: Map<string, string>; names: string[]; exact: boolean } {
  const wanted = new Set(batch.map(latin1));
  const temps = new Map<string, string>();
  const names: string[] = [];
  let exact = true;
  for (let at = 0; at < raw.length; ) {
    const end = raw.indexOf(0, at);
    if (end < 0) return { temps, names, exact: false };
    const record = raw.subarray(at, end);
    at = end + 1;
    const tab = record.indexOf(0x09);
    let name = "";
    try {
      name = tab < 0 ? "" : strictUtf8.decode(record.subarray(0, tab));
    } catch {
      name = "";
    }
    const path = latin1(record.subarray(tab + 1));
    // The name of `mkstemp` is one path component in the worktree root (Git `entry.c`).
    if (tab < 0 || name.length === 0 || name.length > TEMP_NAME_UNITS || !NATIVE.isComponent(name) || !wanted.has(path)) {
      exact = false;
      continue;
    }
    names.push(name);
    if (temps.has(path)) exact = false;
    temps.set(path, name);
  }
  return { temps, names, exact };
}

async function runRevert(r: WorkbenchRun, _p: Payload, bound: RevertBound): Promise<void> {
  const { ctx, q } = r;
  const w = ctx.workspace;
  const plans = bound.files;
  const names = plans.map((f) => namesOf(bytesOf(f.pathBytes))!);
  const paths = plans.map((f) => bytesOf(f.pathBytes));
  const replies: Reply[] = plans.map(() => null);
  const newSha: (string | null)[] = plans.map(() => null);
  const created = new Set<string>();
  const ends: StepEnd[] = [];
  let failure: ErrorCode | null = null;
  let stopped = false;
  // A request without a shell reply, so its effect is not known.
  let lost = false;
  // A `tempRemove` without a known result (contract Δ6 `interrupted`).
  let tempUnknown = false;
  const deadlines = new Set<number>();
  let done = 0;
  const result = { action: bound.action };
  const count = plans.length;
  r.progress("revert-files", { fileIndex: 0, fileCount: count });

  // Plan.md D5a step 6: each Git temporary file that no write consumed. The cleanup reads with the signal that never aborts.
  // Contract Δ6 `tempRemove`: `interrupted` and a lost reply leave an unknown effect, so the run waits for the process-end fact and never ends `succeeded`.
  const removeTemps = async (temps: Temp[]) => {
    for (const t of temps) {
      let reply: TempRemoveReply | WalkStop;
      try {
        reply = await ctx.runner.tempRemove({ operationId: ctx.operationId, repositoryId: w.repositoryId, name: t.name, expected: { size: t.size, sha256: t.sha256 } }, q.signal);
      } catch (error) {
        if (!(error instanceof RunnerRefusal)) throw error;
        continue;
      }
      if ("stop" in reply || reply.result === "interrupted") {
        tempUnknown = true;
        ends.push({ exit: null, canceled: false, refused: null, outputTail: "" });
      }
    }
  };
  // A broken `checkout-index` record names no facts, so each named file first gets its facts.
  const removeNamed = async (names: string[]) => {
    if (names.length === 0) return;
    const facts = await factsOf(q, names.map((name) => ({ root: "worktreeRoot", path: [name] })), { digest: true, stream: true });
    if (!("value" in facts)) return;
    await removeTemps(facts.value.flatMap((f, i) => (f.kind === "file" && f.digest !== undefined ? [{ name: names[i]!, size: f.size, sha256: f.digest }] : [])));
  };
  // Plan.md D5a steps 1 and 3: the index entries of the batch and the raw index digest.
  const indexState = async (batch: number[]) => {
    const entries = await indexEntriesOf(ctx, batch.map((i) => paths[i]!));
    if (!("value" in entries)) return entries;
    const digest = await rawDigest(ctx);
    if (!("value" in digest)) return digest;
    return { value: { entries: batch.map((i) => entries.value.get(latin1(paths[i]!)) ?? ("absent" as const)), digest: digest.value } };
  };
  const stale = (batch: number[]) => {
    for (const i of batch) replies[i] = { result: "stale" };
  };

  for (let start = 0; start < count && failure === null && !stopped && !ctx.signal.aborted; start += FILE_FACT_ENTRIES) {
    const batch = plans.slice(start, start + FILE_FACT_ENTRIES).map((_, k) => start + k);
    const first = await indexState(batch);
    if (!("value" in first)) {
      failure = "code" in first ? first.code : first.stop === "deadline" ? "DEADLINE" : null;
      stopped = true;
      break;
    }
    if (!batch.every((i, k) => plans[i]!.source !== null && sameEntry(first.value.entries[k]!, plans[i]!.source!))) {
      stale(batch);
      break;
    }
    // Plan.md D5a step 2. Contract Δ3: the size rule sets the deadline, also above REGISTERED_DEADLINE_CAP_MS.
    const sizes = batch.reduce((n, i) => n + plans[i]!.source!.size, 0);
    const out = createCollector({ maxBytes: batch.reduce((n, i) => n + paths[i]!.length + TEMP_NAME_UNITS * 3 + 2, 0) });
    const step = await stepOf(ctx, checkoutTempArgs(), out, Buffer.concat(batch.flatMap((i) => [paths[i]!, NUL])), sizeDeadlineMs(sizes));
    const raw = out.take();
    const records = tempRecords(raw, batch.map((i) => paths[i]!));
    const temps = !("exit" in step) || step.exit.exitCode !== 0 || out.limited || !records.exact ? null : records.temps;
    if (temps === null || temps.size !== batch.length) {
      // Data-model §8a: only the names of complete exact records can go. Every other name stays, and the failure code names the gap.
      await removeNamed(records.names);
      if (!("exit" in step)) failure = isStop(step) ? (step.stop === "deadline" ? "DEADLINE" : null) : step.code;
      else failure = step.exit.exitCode !== 0 ? "GIT_FAILED" : "MALFORMED_GIT_OUTPUT";
      stopped = true;
      break;
    }
    const named = batch.map((i) => temps.get(latin1(paths[i]!))!);
    const again = await indexState(batch);
    // Plan.md D5a step 4: the size and SHA-256 of each Git temporary file.
    const tempFacts = await factsOf(ctx, named.map((name) => ({ root: "worktreeRoot", path: [name] })), { digest: true, stream: true });
    const facts = "value" in tempFacts ? tempFacts.value : null;
    const files: (Temp | null)[] = named.map((name, k) => {
      const f = facts?.[k];
      return f?.kind === "file" && f.digest !== undefined ? { name, size: f.size, sha256: f.digest } : null;
    });
    if (!("value" in again) || again.value.digest !== first.value.digest || !again.value.entries.every((e, k) => sameEntry(e, first.value.entries[k]!)) || files.some((f) => f === null)) {
      await removeTemps(files.filter((f): f is Temp => f !== null));
      if (!("value" in again)) failure = "code" in again ? again.code : again.stop === "deadline" ? "DEADLINE" : null;
      else if (files.some((f) => f === null)) failure = "GIT_FAILED";
      else stale(batch);
      stopped = true;
      break;
    }
    const unused: Temp[] = [];
    for (const [k, i] of batch.entries()) {
      const temp = files[k]!;
      if (ctx.signal.aborted || failure !== null || stopped) {
        unused.push(temp);
        continue;
      }
      const plan = plans[i]!;
      // Folders that an earlier write of this run created are no longer missing.
      const depth = names[i]!.length - 1 - plan.folders.length;
      const folders = plan.folders.filter((_, f) => !created.has(names[i]!.slice(0, depth + f + 1).join("/")));
      const request: WorkingReplaceRequest = {
        operationId: ctx.operationId,
        repositoryId: w.repositoryId,
        target: "working",
        path: nativePath(w, names[i]!),
        expected: plan.working === "absent" ? "absent" : { size: plan.working.size, sha256: plan.working.sha256 },
        facts: plan.working,
        source: temp,
        ...(folders.length > 0 ? { folders } : {}),
        // Contract Δ6 `gitMode`: exactly an absent target carries the mode of the source index entry.
        // The support reasons refuse `symlink` and `submodule`, so a regular index mode is left; the frame check refuses any other value.
        ...(plan.working === "absent" ? { gitMode: plan.source!.mode as "100644" | "100755" } : {}),
      };
      // The digest of the sent bytes decides `reverted`, also when the reply is lost or broken after a landed rename.
      newSha[i] = temp.sha256;
      let reply: WorkingReplaceReply | WalkStop;
      try {
        reply = await ctx.runner.fileReplaceWorking(request, ctx.signal);
      } catch (error) {
        if (!(error instanceof RunnerRefusal)) throw error;
        failure = error.code;
        unused.push(temp);
        continue;
      }
      // Contract §6 "Walks": no shell reply within the wait after `cancel`. The request can still write and still use its source, so the outcome stays unknown.
      if ("stop" in reply) {
        lost = true;
        stopped = true;
        continue;
      }
      const answer = reply;
      replies[i] = answer;
      // Only the shell's own `stopped` reply means a stop. Without a Cancel of this run, it was the shell deadline.
      if (answer.result === "stopped" && !ctx.signal.aborted) deadlines.add(i);
      // Contract Δ6: `replaced`, `stale`, `refused`, and `error` name the request folders that the shell created, from the first one on.
      const skipped = plan.folders.length - folders.length;
      const made = "folders" in answer ? (answer.folders?.length ?? 0) : 0;
      for (let f = 0; f < made; f++) created.add(names[i]!.slice(0, depth + skipped + f + 1).join("/"));
      // `source: "kept"`: the rename landed, and Git's temporary file stays, so it goes through `tempRemove` too.
      if (answer.result !== "replaced" || answer.source === "kept") unused.push(temp);
      if (answer.result === "interrupted") ends.push({ exit: null, canceled: ctx.signal.aborted, refused: null, outputTail: "" });
      if (answer.result === "stopped" || answer.result === "interrupted") stopped = true;
      r.progress("revert-files", { fileIndex: ++done, fileCount: count });
    }
    await removeTemps(unused);
  }

  const settled_ = await r.reconcile(ends);
  // Plan.md D10 "unknown": a lost reply leaves the outcome unknown, and the recovery marker stays (001 FR-023).
  if (settled_ === null || lost) return r.unknown({ code: "GIT_FAILED" }, result);
  // Plan.md D10: the fresh index entries, the fresh digests, and the status read.
  const freshIndex = await indexEntriesOf(q, paths);
  const freshFacts = await factsOf(q, names.map((path) => ({ root: "worktreeRoot", path })), { digest: true, stream: true });
  const status = await q.reader.readWorkspace({ operationId: q.operationId, signal: q.signal, installation: q.installation, workspace: q.workspace, refresh: false });
  if (!("value" in freshIndex)) return r.unknown("code" in freshIndex ? { code: freshIndex.code } : freshIndex, result);
  if (!("value" in freshFacts)) return r.unknown("code" in freshFacts ? { code: freshFacts.code } : freshFacts, result);
  if (status.result === "deadline") return r.unknown({ stop: "deadline" }, result);
  // A fresh `error` fact cannot tell the old bytes from the new bytes, so the outcome stays unknown (contract §8).
  if (freshFacts.value.some((f) => f.kind === "error")) return r.unknown({ code: "GIT_FAILED" }, result);

  const outcomes: FileOutcome[] = plans.map((plan, i) => {
    const index = freshIndex.value.get(latin1(paths[i]!)) ?? "absent";
    const f = freshFacts.value[i]!;
    const digest = f.kind === "absent" ? "absent" : f.kind === "file" ? f.digest! : null;
    const planned = plan.newIndex === "keep" ? plan.indexEntry : plan.newIndex === "remove" ? "absent" : plan.newIndex;
    const old = plan.working === "absent" ? "absent" : plan.working.sha256;
    const reply = replies[i]!;
    const at = (outcome: FileOutcome["outcome"], extra: Partial<FileOutcome> = {}): FileOutcome => ({ entryId: plan.entryId, outcome, ...extra });
    if (sameEntry(index, planned) && newSha[i] !== null && digest === newSha[i]) return at("reverted");
    if (sameEntry(index, planned) && !sameEntry(planned, plan.indexEntry) && digest === old) return at("unstaged-only");
    if (sameEntry(index, plan.indexEntry) && digest === old) {
      if (reply === null) return at("not-started");
      if (reply.result === "stale") return at("not-changed", { code: "stale" });
      if (reply.result === "refused") return at("not-changed", { code: "refused", reason: reply.reason });
      if (reply.result === "error") return at("not-changed", { code: "error", reason: reply.code });
      return at("not-changed");
    }
    return at("changed-outside");
  });
  const value = { action: bound.action, files: outcomes, foldersCreated: [...created].map((path) => Buffer.from(path).toString("base64")), index: "none" };
  // Plan.md D10: created folders and an unknown `tempRemove` are effects too, so such a run never ends `succeeded` or `no-effects`.
  const effects = outcomes.filter((o) => o.outcome === "reverted" || o.outcome === "unstaged-only" || o.outcome === "changed-outside").length + created.size + (tempUnknown ? 1 : 0);
  if (tempUnknown) return r.finish({ type: "failed-with-effects" }, value);
  // Plan.md D10 "Response state": the fresh read decides. A Cancel never turns an effect into `canceled`, and it never reports an undo.
  if (outcomes.every((o) => o.outcome === "reverted")) return r.finish({ type: "intended-effects-confirmed" }, value);
  if (effects > 0) return r.finish({ type: "failed-with-effects" }, value);
  if (settled_.canceled) return r.finish({ type: "no-effects", observed: "canceled" }, value);
  // No file changed: the code of the first file in tree order.
  const firstCode = outcomes[0]!.code;
  const code: ErrorCode = failure ?? (firstCode === "stale" ? "STALE_REVIEW" : firstCode === "refused" ? "WORKBENCH_UNAVAILABLE" : deadlines.has(0) ? "DEADLINE" : "GIT_FAILED");
  r.finish({ type: "no-effects", observed: "failed", code }, value);
}

for (const action of ["revert-lines", "revert-files", "revert-unstaged"] as const) {
  registerWorkbenchAction<Action, RevertBound>(action, {
    observe: (ctx, p, common) => observeRevert(ctx, p, common),
    started: () => action,
    // The run reads the index itself in its D5a steps and its reconcile (plan.md D2).
    observeBefore: false,
    run: runRevert,
  });
}
