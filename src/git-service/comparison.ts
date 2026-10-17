// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T105: contract §3 `readComparison`, contract §4 "Snapshot and hunk rules" and "File staging", contract §5 bounds, and data-model §5.

import { lstat, opendir } from "node:fs/promises";
import type { ChangeEntry } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import { decideFileAction, decideResolve, type FileActionDecision, type ResolveDecision, type WorkingFacts } from "../contracts/file-action";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  CANONICAL_DIFF_BYTES,
  FILE_FACT_COMPONENT_UNITS,
  RETAINED_COMPARISON_BYTES,
  RETAINED_COMPARISONS,
  STATUS_LISTING_BYTES,
  STATUS_LISTING_RECORDS,
  WHOLE_FILE_STAGE_INPUT_BYTES,
} from "../contracts/limits";
import { NATIVE, PATH_RULES } from "../contracts/native-path";
import { buildRemedyCommand, type RemedyCommand, type RemedyValue } from "../contracts/remedy-command";
import { buildWslRemedy, routeWslPath } from "../contracts/wsl-route";
import {
  attributeArgs,
  emptyTreeArgs,
  isObjectId,
  lineEndingArgs,
  objectCheckArgs,
  stagedNumstatArgs,
  stagedPatchArgs,
  unstagedNumstatArgs,
  unstagedPatchArgs,
  untrackedNumstatArgs,
  untrackedPatchArgs,
} from "./commands";
import { parseNumstat, parsePatch, type NumstatResult, type PatchHunk, type PatchResult } from "./diff-parser";
import { holdsSharedRepository } from "./eligibility";
import { createCollector, RunnerRefusal, type Collector, type GitExit, type GitRunner, type WslRunner } from "./git-runner";
import { noFileId } from "./index-lock";
import { contextOf, isMissing, objectCheckInput, runRead, type ReadStep } from "./read-steps";
import type { Workspace } from "./registration";
import { readWorkingVersion, type ChangeSnapshot, type Checked, type Completeness, type LimitName, type ReadInstallation, type WorkingVersion } from "./snapshot";
import { hasPromisor, OBJECT_MISSING_REMEDY } from "./status";
import type { StatusRecord } from "./status-parser";
import { decideSupport, parseAttributes, parseEolListing, type SupportDecision } from "./support";
import { parseMaybeBool, type Trust } from "./trust";

export type ComparisonScope = "head-to-index" | "index-to-worktree" | "empty-to-untracked";

// Contract §4 "Limitation remedies".
export const REMEDY_TEXT = "This command stages or unstages the whole file with your Git settings. Run it in a terminal.";
const REMEDY_REASONS: ReadonlySet<string> = new Set(["size", "rename", "type", "symlink", "LFS", "filter", "blob-proof"]);

// Data-model §5 "Comparison". The service keeps the hunk bytes and the file binding. The renderer gets only the result value.
export interface RetainedComparison {
  comparisonId: string;
  repositoryId: string;
  snapshotId: string;
  generation: number;
  entry: ChangeEntry;
  scope: ComparisonScope;
  patch: Uint8Array;
  hunks: (PatchHunk & { hunkId: string })[];
  support: SupportDecision | null;
  // Feature 003 contract Δ4: a conflicted entry gets the `resolve` decision.
  fileAction: FileActionDecision | ResolveDecision;
  // Contract §4 "Binding": the whole working file of a `stage` or `resolve` decision.
  working: { size: number; sha256: string } | null;
  // The `check-attr` values of the path that the support decision used.
  attributes: Readonly<Record<string, string>>;
  // The compared working version, read before and after the diff. Null for `head-to-index`, a WSL workspace, or a failed read.
  // A `head-to-index` comparison binds no working version and gets hunk approvals. Another null gets none outside WSL.
  workingVersion: WorkingVersion | null;
  // Contract §4 "WSL index publication": a WSL listing of this comparison holds `core.sharedRepository`. Acceptance refuses then.
  sharedRepository: boolean;
  // The contract §4 remedy of a refused file action, which `applyFile` returns with the refusal.
  remedy: WholeFileRemedy | null;
}

export interface ComparisonTarget {
  operationId: string;
  signal: AbortSignal;
  installation: ReadInstallation;
  workspace: Workspace;
  snapshot: ChangeSnapshot;
  entry: ChangeEntry;
}

export type ComparisonOutcome =
  | { result: "succeeded" | "limited" | "failed"; code?: ErrorCode; value?: unknown }
  | { result: "canceled" }
  | { result: "deadline" };

const NUL = 0x00;
const NEWLINE = 0x0a;
const ZERO_OID = /^0+$/;
const GITLINK = "160000";
const DEV_NULL = new TextEncoder().encode("/dev/null");
const NO_PATCH: PatchResult = { ok: true, patch: { header: new Uint8Array(), hunks: [], lines: 0 } };
const NO_NUMSTAT: NumstatResult = { ok: true, binary: false };
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const decode = (bytes: Uint8Array): string | null => {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

class Stop {
  constructor(readonly outcome: ComparisonOutcome) {}
}
const fail = (code: ErrorCode) => new Stop({ result: "failed", code });
// Contract §6: a working-file read with a sentinel file ID ends `failed` with UNSUPPORTED_HUNK_PROFILE. That code has no other cause here.
const noIdentity = (c: Completeness) => c.state === "failed" && c.code === "UNSUPPORTED_HUNK_PROFILE";

// The status record of the entry (git-status(1) "Porcelain Format Version 2"), for `decideSupport`.
function statusRecord(e: ChangeEntry, path: Uint8Array): StatusRecord {
  const p = { bytes: path, display: e.path };
  if (e.category === "untracked") return { kind: "untracked", path: p };
  const fields = { xy: e.xy!, submodule: e.submodule!, path: p };
  if (e.category === "conflicted") return { kind: "unmerged", ...fields, modes: e.modes as [string, string, string, string], oids: e.oids as [string, string, string] };
  const modes = e.modes as [string, string, string];
  const oids = e.oids as [string, string];
  if (e.score === undefined) return { kind: "ordinary", ...fields, modes, oids };
  return { kind: "rename", ...fields, modes, oids, score: e.score, originalPath: { bytes: Buffer.from(e.sourcePathBytes!, "base64"), display: e.sourcePath! } };
}

// The same record as raw `status --porcelain=v2 -z` bytes without the final NUL, for `decideFileAction` and `decideResolve`.
function rawRecord(e: ChangeEntry, path: Uint8Array): Uint8Array {
  if (e.category === "untracked") return Buffer.concat([Buffer.from("? "), path]);
  if (e.category === "conflicted") return Buffer.concat([Buffer.from(`u ${[e.xy, e.submodule, ...e.modes!, ...e.oids!].join(" ")} `), path]);
  const head = [e.score === undefined ? "1" : "2", e.xy, e.submodule, ...e.modes!, ...e.oids!, ...(e.score === undefined ? [] : [e.score])].join(" ");
  const tail = e.score === undefined ? [] : [Uint8Array.of(NUL), Buffer.from(e.sourcePathBytes!, "base64")];
  return Buffer.concat([Buffer.from(`${head} `), path, ...tail]);
}

// The file identity that `lstat` reports. A bigint keeps the full 64-bit value.
const sameFile = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino;

// The on-disk name of `name` in `dir`: the exact name, or the entry with the identity of `target`. Null: no entry matches, or a sentinel ID proves nothing.
// Exported for tests only.
export async function diskName(dir: string, name: string, target: { dev: bigint; ino: bigint }): Promise<string | null> {
  // NTFS `$UpCase` maps each UTF-16 unit to one unit, so a name that the volume matches has the same unit count.
  const candidates: string[] = [];
  for await (const d of await opendir(dir)) {
    if (d.name === name) return name;
    if (d.name.length === name.length) candidates.push(d.name);
  }
  for (const candidate of candidates) {
    const st = await lstat(NATIVE.path.join(dir, candidate), { bigint: true });
    if (noFileId(st.ino, target.ino)) return null;
    if (sameFile(st, target)) return candidate;
  }
  return null;
}

// Data-model §5 path rule on a Windows or POSIX worktree. The service reads the working tree directly.
// `others`: the other stage-0 index paths. One that names the same file refuses the entry with reason `path`.
async function localFacts(root: string, parts: string[], others: readonly Uint8Array[]): Promise<WorkingFacts> {
  const disk: string[] = [];
  let dir = root;
  let st;
  try {
    for (const [i, part] of parts.entries()) {
      const at = NATIVE.path.join(dir, part);
      st = await lstat(at, { bigint: true });
      const name = await diskName(dir, part, st);
      if (name === null) return { type: "unreadable" };
      disk.push(name);
      // diff-lib.c `check_removed`: a path behind a symbolic link or a non-directory counts as removed.
      if (i < parts.length - 1 && !st.isDirectory()) return { type: "absent" };
      dir = at;
    }
    for (const other of others) {
      const text = decode(other);
      const split = text?.split("/");
      if (split === undefined || split.length !== parts.length || split.some((p, i) => p.length !== parts[i]!.length)) continue;
      try {
        const other = await lstat(NATIVE.path.join(root, ...split), { bigint: true });
        if (noFileId(other.ino, st!.ino) || sameFile(other, st!)) return { type: "unreadable" };
      } catch (error) {
        if (!isMissing(error)) return { type: "unreadable" };
      }
    }
  } catch (error) {
    return isMissing(error) ? { type: "absent" } : { type: "unreadable" };
  }
  const diskPath = new TextEncoder().encode(disk.join("/"));
  if (st!.isFile()) return { type: "file", size: Number(st!.size), diskPath };
  return { type: st!.isSymbolicLink() ? "symlink" : st!.isDirectory() ? "directory" : "other", diskPath };
}

// `cat-file --batch-check` lines: `<oid> blob <size>` or `<oid> missing`, one per input line.
function blobSizes(raw: Uint8Array, oids: readonly string[]): number[] | "missing" | null {
  if (raw.length === 0 || raw[raw.length - 1] !== NEWLINE) return null;
  const lines = Buffer.from(raw.subarray(0, -1)).toString("latin1").split("\n");
  if (lines.length !== oids.length) return null;
  const sizes: number[] = [];
  let missing = false;
  for (const [i, line] of lines.entries()) {
    if (line === `${oids[i]} missing`) missing = true;
    const m = /^([0-9a-f]+) blob (0|[1-9][0-9]*)$/.exec(line);
    if (m?.[1] === oids[i]) sizes.push(Number(m![2]));
    else if (line !== `${oids[i]} missing`) return null;
  }
  return missing ? "missing" : sizes;
}

export interface ComparisonReaderOptions {
  runner: GitRunner & WslRunner;
  trust: Trust;
  // Gets the ID of each retained comparison that eviction or a release drops.
  onDrop?: (comparisonId: string) => void;
}

// The contract §4 whole-file remedy of an entry. Null for a WSL root without a route, or without a selected Git path.
export type WholeFileRemedy = { text: string; command: string | null };
export function wholeFileRemedy(t: Pick<ComparisonTarget, "entry" | "workspace" | "installation"> & { headUnborn: boolean }, path: Uint8Array): WholeFileRemedy | null {
  const e = t.entry;
  const w = t.workspace;
  const kind = e.category !== "staged" ? "add" : t.headUnborn ? "rm-cached" : "restore-staged";
  const source = kind === "add" && e.sourcePathBytes !== undefined ? Buffer.from(e.sourcePathBytes, "base64") : null;
  let values: RemedyValue[];
  let built: RemedyCommand;
  if (w.wsl !== undefined) {
    // Contract §11 "Paths and file access": the route gives the Linux form of the UNC worktree root.
    const route = routeWslPath(w.worktreeRoot, { listed: [w.wsl.distro], registry: [{ name: w.wsl.distro, guid: w.wsl.guid, version: 2 }] });
    if (route.kind !== "wsl") return null;
    const { wslExecutable, distro } = w.wsl;
    values = [
      { kind: "wslExecutable", text: wslExecutable, form: "windows" },
      { kind: "distroName", text: distro },
      { kind: "gitPath", text: w.wsl.path, form: "linux" },
      { kind: "worktreeRoot", text: route.linuxPath, form: "linux" },
      ...(source === null ? [] : [{ kind: "path" as const, text: source, form: "linux" as const }]),
      { kind: "path", text: path, form: "linux" },
    ];
    built = buildWslRemedy(kind, { wslExecutable, distro, gitPath: w.wsl.path, worktreeRoot: route.linuxPath, path, ...(source === null ? {} : { sourcePath: source }) });
  } else {
    if (t.installation.selectedPath === null) return null;
    const tail = kind === "add" ? `add -- ${source === null ? "" : "{source} "}{path}` : kind === "rm-cached" ? "rm --cached -- {path}" : "restore --staged -- {path}";
    const named: Record<string, RemedyValue> = {
      git: { kind: "gitPath", text: t.installation.selectedPath, form: "windows" },
      root: { kind: "worktreeRoot", text: w.worktreeRoot, form: "windows" },
      ...(source === null ? {} : { source: { kind: "path", text: source } }),
      path: { kind: "path", text: path },
    };
    values = Object.values(named);
    built = buildRemedyCommand(`& {git} --literal-pathspecs -C {root} ${tail}`, named);
  }
  if (built.command !== null) return { text: REMEDY_TEXT, command: built.command };
  // Contract §4 "Quoting rule" and §11 "Remedy commands": the state shows the refused value as plain text without a command.
  const text = (v: RemedyValue) => (typeof v.text === "string" ? v.text : (decode(v.text) ?? ""));
  const refusedValue = (v: RemedyValue) => buildRemedyCommand("{v}", { v }).command === null || (w.wsl !== undefined && v.kind !== "wslExecutable" && text(v).includes("\\"));
  const shown = values.find((v) => v.kind === built.refused && refusedValue(v)) ?? values.find(refusedValue);
  return { text: `PowerShell cannot pass this value safely, so Arbareto offers no command: ${shown === undefined ? "" : text(shown)}`, command: null };
}

export function createComparisonReader({ runner, trust, onDrop }: ComparisonReaderOptions) {
  // Contract §5 "Retained comparison data": insertion order is age order. An evicted comparison gives UNKNOWN_TARGET to every later request that names it.
  const retained = new Map<string, RetainedComparison>();
  let retainedBytes = 0;
  const drop = (id: string) => {
    const c = retained.get(id);
    if (c === undefined) return;
    retainedBytes -= c.patch.length;
    retained.delete(id);
    onDrop?.(id);
  };
  const retain = (c: RetainedComparison) => {
    retained.set(c.comparisonId, c);
    retainedBytes += c.patch.length;
    for (const id of retained.keys()) {
      if (retained.size <= RETAINED_COMPARISONS && retainedBytes <= RETAINED_COMPARISON_BYTES) break;
      drop(id);
    }
  };

  // One read step. A refusal, a deadline, a cancel, or a diagnostic bound ends the read here.
  async function step(t: ComparisonTarget, args: string[], out: Collector, input?: Uint8Array): Promise<GitExit> {
    const s: ReadStep = await runRead(runner, t, args, out, input);
    if (t.signal.aborted) throw new Stop({ result: "canceled" });
    if ("refused" in s) throw fail(s.refused);
    if (s.exit.deadline !== undefined) throw new Stop({ result: "deadline" });
    if (s.exit.diagnosticLimit) throw fail("OUTPUT_LIMIT");
    return s.exit;
  }

  // Contract §11 "Paths and file access": one `wslFiles` request in mode `digest` per comparison. No working-file byte crosses.
  async function wslFacts(t: ComparisonTarget, parts: string[], path: Uint8Array): Promise<{ facts: WorkingFacts; sha256: string | null }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let results;
      try {
        results = await runner.wslFiles(
          { operationId: t.operationId, ...contextOf(t.workspace), mode: "digest", bound: "WHOLE_FILE_STAGE_INPUT_BYTES", files: [{ root: "worktreeRoot", path: parts }] },
          t.signal,
        );
      } catch (error) {
        if (error instanceof RunnerRefusal) throw fail(error.code);
        throw error;
      }
      if (!Array.isArray(results)) throw new Stop({ result: results.stop });
      const r = results[0]!;
      // Contract §6 "WSL file work": `changed` asks for one more read, as for an atomic save.
      if (r.kind === "file" && r.changed) continue;
      if (r.kind === "file") return { facts: { type: "file", size: r.size, diskPath: path }, sha256: r.sha256 ?? null };
      if (r.kind === "directory" || r.kind === "other") return { facts: { type: r.kind, diskPath: path }, sha256: null };
      // diff-lib.c `check_removed`: a link before the last component counts as removed.
      if (r.kind === "link") return { facts: r.component === parts.length ? { type: "symlink", diskPath: path } : { type: "absent" }, sha256: null };
      if (r.kind === "absent") return { facts: { type: "absent" }, sha256: null };
      return { facts: { type: "unreadable" }, sha256: null };
    }
    throw fail("REPOSITORY_CHANGED");
  }

  // The contract §4 remedy of a refused file action, or null.
  function remedyOf(t: ComparisonTarget, path: Uint8Array, decision: FileActionDecision | ResolveDecision): WholeFileRemedy | null {
    if (decision.direction !== null || decision.code !== "UNSUPPORTED_COMPARISON" || !REMEDY_REASONS.has(decision.reason)) return null;
    return wholeFileRemedy({ entry: t.entry, workspace: t.workspace, installation: t.installation, headUnborn: t.snapshot.head.state === "unborn" }, path);
  }

  async function compare(t: ComparisonTarget): Promise<ComparisonOutcome> {
    const w = t.workspace;
    const e = t.entry;
    const path = new Uint8Array(Buffer.from(e.pathBytes, "base64"));
    const scope: ComparisonScope = e.category === "staged" ? "head-to-index" : e.category === "untracked" ? "empty-to-untracked" : "index-to-worktree";
    const flags = e.flags;

    // Contract §7: the read gate decides before any comparison limit check and any diff read.
    const listed = await trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: w });
    if (!listed.ok) return "stop" in listed ? { result: listed.stop } : { result: "failed", code: listed.code };
    const lst = listed.listing;
    const gate = trust.gate(w, lst, t.installation, "reads");
    if (gate !== null) return { result: "failed", code: gate };

    // Without index flags the snapshot listing was cut, so no decision is exact.
    if (e.category !== "conflicted" && flags === undefined) {
      const c = t.snapshot.completeness;
      return c.state === "limited" ? { result: "limited", code: c.code, value: { completeness: c } } : { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
    }
    const indexFlags = flags ?? { intentToAdd: false, assumeUnchanged: false, skipWorktree: false };

    const text = decode(path);
    const source = e.sourcePathBytes === undefined ? null : decode(Buffer.from(e.sourcePathBytes, "base64"));
    const nested = path[path.length - 1] === 0x2f;
    const parts = text === null || nested ? null : text.split("/");
    // Contract §11: a WSL name that the §6 component rule refuses gets reason `path`.
    const wslRefused = w.wsl !== undefined && parts !== null && !parts.every((p) => p.length <= FILE_FACT_COMPONENT_UNITS && p.isWellFormed() && PATH_RULES.windows.isComponent(p));
    // `handle_long_path` (compat/mingw.c): without `core.longpaths`, Git cannot open such a path.
    const longPathsEntry = lst.entries.findLast((x) => x.key === "core.longpaths");
    const longPaths = longPathsEntry !== undefined && parseMaybeBool(longPathsEntry.value) === 1;
    const limit = w.wsl === undefined ? NATIVE.gitPathUnitLimit : null;
    const tooLong = limit !== null && !longPaths && parts !== null && NATIVE.path.join(w.worktreeRoot, ...parts).length >= limit;
    // Feature 003 contract Δ4: a conflicted entry reads the working facts and the attributes for `decideResolve`, and no diff.
    const conflicted = e.category === "conflicted";
    const readable = text !== null && (e.sourcePathBytes === undefined || source !== null);

    const headUnborn = t.snapshot.head.state === "unborn";
    // The blobs of the compared sides. A gitlink names a commit of another repository.
    const sides = scope === "head-to-index" ? [0, 1] : scope === "index-to-worktree" ? [1] : [];
    const blobs = sides.map((i) => ({ oid: e.oids![i]!, mode: e.modes![i]! })).filter((b) => !ZERO_OID.test(b.oid) && b.mode !== GITLINK);
    const oids = [...new Set(blobs.map((b) => b.oid))];

    let working = { type: "absent" } as WorkingFacts;
    let wslDigest = null as string | null;
    let attributes: Record<string, string> = {};
    let eolOut = null as Uint8Array | null;
    let eolLimit = null as LimitName | null;
    let sizes = [] as number[] | "missing" | null;
    let tree = null as string | null;
    let failedStep = false as boolean;
    let firstVersion = null as Checked<WorkingVersion> | null;
    try {
      if (readable) {
        const facts = async () => {
          if (parts === null) return;
          if (wslRefused || tooLong) working = { type: "unreadable" };
          else if (w.wsl !== undefined) ({ facts: working, sha256: wslDigest } = await wslFacts(t, parts, path));
          else {
            const others = scope === "empty-to-untracked" ? [] : t.snapshot.indexEntries.filter((x) => x.stage === 0 && !Buffer.from(x.path).equals(path)).map((x) => x.path);
            working = await localFacts(w.worktreeRoot, parts, others);
            if (scope !== "head-to-index") firstVersion = await readWorkingVersion(w.worktreeRoot, path, "COMPARED_RAW_VERSION_BYTES", null);
            if (firstVersion !== null && !firstVersion.ok && noIdentity(firstVersion.completeness)) throw fail("UNSUPPORTED_HUNK_PROFILE");
          }
        };
        const attrs = async () => {
          const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
          const exit = await step(t, attributeArgs(), out, Buffer.concat([path, Uint8Array.of(NUL)]));
          const parsed = exit.exitCode === 0 && !out.limited ? parseAttributes(out.take(), [path]) : null;
          if (parsed === null) throw fail(exit.exitCode === 0 ? "MALFORMED_GIT_OUTPUT" : "GIT_FAILED");
          attributes = parsed[0]!;
        };
        // `lineEndingArgs` has no pathspec, so it lists the whole index once per comparison.
        const eol = async () => {
          const out = createCollector({ maxBytes: STATUS_LISTING_BYTES, maxRecords: STATUS_LISTING_RECORDS, separator: NUL });
          const exit = await step(t, lineEndingArgs(), out);
          // `out.records` also counts the separators after the cut.
          if (out.limited) eolLimit = out.take().reduce((n, b) => n + (b === NUL ? 1 : 0), 0) >= STATUS_LISTING_RECORDS ? "STATUS_LISTING_RECORDS" : "STATUS_LISTING_BYTES";
          else if (exit.exitCode !== 0) failedStep = true;
          else eolOut = out.take();
        };
        const blobsRead = async () => {
          if (oids.length === 0) return;
          const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
          const exit = await step(t, objectCheckArgs(), out, objectCheckInput(oids));
          sizes = exit.exitCode === 0 && !out.limited ? blobSizes(out.take(), oids) : null;
        };
        const emptyTree = async () => {
          if (scope !== "head-to-index") return;
          if (!headUnborn) return void (tree = (t.snapshot.head as { oid: string }).oid);
          const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
          const exit = await step(t, emptyTreeArgs(), out, new Uint8Array());
          const raw = out.take();
          const oid = Buffer.from(raw.subarray(0, -1)).toString("latin1");
          if (exit.exitCode !== 0 || raw[raw.length - 1] !== NEWLINE || !isObjectId(oid, w.objectFormat)) throw fail("GIT_FAILED");
          tree = oid;
        };
        await Promise.all(conflicted ? [facts(), attrs()] : [facts(), attrs(), eol(), blobsRead(), emptyTree()]);
      }
      const decide = () => (conflicted ? decideResolve({ record: rawRecord(e, path), attributes, working }) : decideFileAction({ category: e.category, record: rawRecord(e, path), headUnborn, indexFlags, attributes, working }));

      const support = (numstat: NumstatResult, patch: PatchResult, eolListing: ReturnType<typeof parseEolListing>) =>
        decideSupport({
          scope,
          record: statusRecord(e, path),
          indexFlags,
          attributes,
          working,
          eol: eolListing ?? new Map(),
          sizes: {
            raw: [...(Array.isArray(sizes) ? sizes : []), ...(scope !== "head-to-index" && working.type === "file" ? [working.size] : [])],
            normalized: Array.isArray(sizes) ? sizes : [],
          },
          patch,
          numstat,
        });
      // Every refusal before the numstat step needs no diff. A `filter` attribute must refuse before any diff runs a clean filter (contract §4).
      const early = support({ ok: false, completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } }, NO_PATCH, null);
      const skip = !readable || conflicted || (early.supported === false && early.code === "UNSUPPORTED_COMPARISON");

      let rawPatch: Uint8Array = new Uint8Array();
      let patch: PatchResult = NO_PATCH;
      let numstat: NumstatResult = NO_NUMSTAT;
      if (!skip) {
        const accepted = scope === "empty-to-untracked" ? [0, 1] : [0];
        const p = text!;
        const [patchArgs, numstatArgs] =
          scope === "head-to-index"
            ? [stagedPatchArgs(tree!, w.objectFormat, p), stagedNumstatArgs(tree!, w.objectFormat, p)]
            : scope === "index-to-worktree"
              ? [unstagedPatchArgs(p), unstagedNumstatArgs(p)]
              : [untrackedPatchArgs(p), untrackedNumstatArgs(p)];
        const patchOut = createCollector({ maxBytes: CANONICAL_DIFF_BYTES + 1 });
        const numstatOut = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
        const [patchExit, numstatExit] = await Promise.all([step(t, patchArgs, patchOut), step(t, numstatArgs, numstatOut)]);
        // A reached bound stops the process, so its exit status proves nothing (contract §5).
        if (!patchOut.limited && !accepted.includes(patchExit.exitCode ?? -1)) failedStep = true;
        if (numstatOut.limited || !accepted.includes(numstatExit.exitCode ?? -1)) failedStep = true;
        rawPatch = patchOut.take();
        patch = parsePatch(rawPatch, path);
        numstat = parseNumstat(numstatOut.take(), path, scope === "empty-to-untracked" ? DEV_NULL : null);
      }

      // Contract §7 "Missing objects": a failed step runs the object check in a repository with a promisor remote.
      if (failedStep || sizes === null || sizes === "missing") {
        const promisor = await hasPromisor(lst.entries, w, (paths) => runner.identities(t.operationId, contextOf(w), paths, t.signal));
        if (t.signal.aborted) return { result: "canceled" };
        if (promisor === "canceled" || promisor === "deadline") return { result: promisor };
        if (promisor !== true || sizes !== "missing") return { result: "failed", code: "GIT_FAILED" };
        const fileAction = decide();
        if (fileAction.direction === null && fileAction.code === "MALFORMED_GIT_OUTPUT") return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
        const completeness: Completeness = { state: "limited", code: "OBJECT_MISSING" };
        return { result: "limited", code: "OBJECT_MISSING", value: { completeness, scope, support: null, fileAction: actionValue(fileAction), remedy: remedyOf(t, path, fileAction), objectRemedy: { text: OBJECT_MISSING_REMEDY } } };
      }

      const eolListing = eolOut === null ? null : parseEolListing(eolOut);
      if (readable && eolOut !== null && eolListing === null) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
      const decision = skip ? early : eolLimit !== null ? null : support(numstat, patch, eolListing);
      if (decision !== null && decision.supported === false && decision.code === "MALFORMED_GIT_OUTPUT") return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
      const fileAction = decide();
      if (fileAction.direction === null && fileAction.code === "MALFORMED_GIT_OUTPUT") return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };

      // Contract §4 "Binding": a `stage` or `resolve` decision binds the size and SHA-256 of the whole working file.
      let binding: RetainedComparison["working"] = null;
      if ((fileAction.direction === "stage" || fileAction.direction === "resolve") && working.type === "file") {
        if (w.wsl !== undefined) {
          if (wslDigest === null) throw fail("REPOSITORY_CHANGED");
          binding = { size: working.size, sha256: wslDigest };
        } else {
          const read = await readWorkingVersion(w.worktreeRoot, path, "WHOLE_FILE_STAGE_INPUT_BYTES", null);
          if (t.signal.aborted) return { result: "canceled" };
          if (!read.ok) throw fail(read.completeness.state === "failed" ? read.completeness.code : "REPOSITORY_CHANGED");
          const v = read.value;
          if (!v.exists || v.type !== "file" || v.size !== working.size || v.size > WHOLE_FILE_STAGE_INPUT_BYTES) throw fail("REPOSITORY_CHANGED");
          binding = { size: v.size, sha256: v.rawDigest };
        }
      }

      // Contract §8 "Changing working file": the working version before the diff must equal the version after it.
      let workingVersion: WorkingVersion | null = null;
      if (firstVersion?.ok) {
        const second = await readWorkingVersion(w.worktreeRoot, path, "COMPARED_RAW_VERSION_BYTES", null);
        if (t.signal.aborted) return { result: "canceled" };
        if (!second.ok && noIdentity(second.completeness)) throw fail("UNSUPPORTED_HUNK_PROFILE");
        if (second.ok) {
          if (!Bun.deepEquals(firstVersion.value, second.value)) throw fail("REPOSITORY_CHANGED");
          workingVersion = second.value;
        }
      }

      const supported = decision?.supported === true && patch.ok;
      const hunks = supported && patch.ok ? patch.patch.hunks.map((h) => ({ ...h, hunkId: crypto.randomUUID() })) : [];
      const kept = patch.ok ? rawPatch : new Uint8Array();
      const completeness: Completeness = !patch.ok && patch.completeness.state === "limited" ? patch.completeness : eolLimit !== null ? { state: "limited", code: "OUTPUT_LIMIT", reason: eolLimit } : { state: "complete" };
      const remedy = remedyOf(t, path, fileAction);
      const comparison: RetainedComparison = {
        comparisonId: crypto.randomUUID(),
        repositoryId: w.repositoryId,
        snapshotId: t.snapshot.snapshotId,
        generation: t.snapshot.generation,
        entry: e,
        scope,
        patch: kept,
        hunks,
        support: decision,
        fileAction,
        working: binding,
        attributes,
        workingVersion,
        sharedRepository: w.wsl !== undefined && holdsSharedRepository(lst.entries),
        remedy,
      };
      if (t.signal.aborted) return { result: "canceled" };
      retain(comparison);
      const value = {
        comparisonId: comparison.comparisonId,
        snapshotId: comparison.snapshotId,
        entryId: e.entryId,
        scope,
        completeness,
        // Contract §5: the canonical patch travels as base64 of its raw bytes.
        patch: b64(kept),
        hunks: hunks.map(({ hunkId, ordinal, oldStart, oldCount, newStart, newCount, digest }) => ({ hunkId, ordinal, oldStart, oldCount, newStart, newCount, digest })),
        support: decision === null ? null : decision.supported ? "supported" : (decision as { reason: string }).reason,
        fileAction: actionValue(fileAction),
        remedy,
      };
      if (completeness.state === "limited") return { result: "limited", code: completeness.code, value };
      return { result: "succeeded", value };
    } catch (error) {
      if (error instanceof Stop) return error.outcome;
      throw error;
    }
  }

  return {
    readComparison: compare,
    // T110 and T200 take the retained data by `comparisonId`. An evicted comparison is gone.
    get: (comparisonId: string): RetainedComparison | undefined => retained.get(comparisonId),
    // Data-model §4: a workspace release releases its comparisons.
    release(repositoryId: string): void {
      for (const [id, c] of retained) if (c.repositoryId === repositoryId) drop(id);
    },
  };
}

// Data-model §5 "File-action decision": the direction, or the refusal reason. Operation state keeps its own reason `state`.
function actionValue(d: FileActionDecision | ResolveDecision): string {
  if (d.direction !== null) return d.direction;
  return d.code === "UNSUPPORTED_COMPARISON" ? d.reason : "state";
}

export type ComparisonReader = ReturnType<typeof createComparisonReader>;
