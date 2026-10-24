// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 contract Δ3 `readCommitChanges` and `readCommitFile`, Δ5 bounds, Δ8 retained listings, data-model §1 and §2, plan.md D2 and D3.

import type { ErrorCode } from "../contracts/errors";
import { CANONICAL_DIFF_BYTES, COMMIT_CHANGES_RESULT_BYTES, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS } from "../contracts/limits";
import { commitChangesArgs, commitNumstatArgs, commitPatchArgs, emptyTreeArgs, isObjectId, OID_HEX as OID, type ObjectFormat } from "./commands";
import { parsePatch, unquote } from "./diff-parser";
import { createCollector, type Collector, type GitExit, type GitRunner } from "./git-runner";
import { contextOf, encodedBytes, latin1, runRead, strictUtf8 } from "./read-steps";
import type { Workspace } from "./registration";
import type { ReadInstallation } from "./snapshot";
import { hasPromisor, OBJECT_MISSING_REMEDY } from "./status";
import type { Trust, TrustListing } from "./trust";

export type InspectionOutcome = { result: "succeeded" | "limited" | "failed"; code?: ErrorCode; value?: unknown } | { result: "canceled" } | { result: "deadline" };
export type InspectionTarget = { operationId: string; signal: AbortSignal; workspace: Workspace; installation: ReadInstallation };

export type FileKind = "file" | "link" | "submodule";
type RawStatus = "A" | "D" | "M" | "R" | "T";

// One diff-format(5) raw record. `start` and `end` give its bytes in the listing.
export interface RawEntry {
  status: RawStatus;
  score?: number;
  modes: [string, string];
  oids: [string, string];
  // For R, the new path. `oldPath` exists only for R.
  path: Uint8Array;
  oldPath?: Uint8Array;
  kind: FileKind;
  start: number;
  end: number;
}

const NUL = 0x00;
const LF = 0x0a;
const QUOTE = 0x22;
const SLASH = 0x2f;
const ABSENT_MODE = "000000";
const GITLINK = "160000";
const SYMLINK = "120000";
const STATUS_NAMES: Record<RawStatus, string> = { A: "added", D: "deleted", M: "modified", R: "renamed", T: "type-changed" };
const HEADERS: Record<ObjectFormat, RegExp> = Object.fromEntries((["sha1", "sha256"] as const).map((f) => [f, new RegExp(`^:([0-7]{6}) ([0-7]{6}) (${OID[f]}) (${OID[f]}) ([ADMT]|R(?:0[0-9]{2}|100))$`)])) as Record<ObjectFormat, RegExp>;
const ZERO = /^0+$/;
const DIFF_GIT = Buffer.from("diff --git ");

const kindOfMode = (mode: string): FileKind => (mode === GITLINK ? "submodule" : mode === SYMLINK ? "link" : "file");
// Data-model §1: a gitlink on either side makes a submodule entry, else a link on either side a link entry.
const kindOf = (modes: readonly string[]): FileKind => {
  const kinds = modes.map(kindOfMode);
  return kinds.includes("submodule") ? "submodule" : kinds.includes("link") ? "link" : "file";
};
export const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

// The outcome that ends an inspection read early.
export class Stop {
  constructor(readonly outcome: InspectionOutcome) {}
}
export const fail = (code: ErrorCode, value?: object) => new Stop({ result: "failed", code, ...(value === undefined ? {} : { value }) });

// The empty tree OID of the object format: `hash-object -t tree --stdin` with empty stdin writes no object.
export async function emptyTreeOf(run: (args: string[], out: Collector, input: Uint8Array) => Promise<GitExit>, objectFormat: ObjectFormat): Promise<string> {
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const exit = await run(emptyTreeArgs(), out, new Uint8Array());
  const raw = out.take();
  const oid = latin1(raw.subarray(0, -1));
  if (exit.exitCode !== 0 || raw[raw.length - 1] !== LF || !isObjectId(oid, objectFormat)) throw fail("GIT_FAILED");
  return oid;
}

// Both steps end before the first rejection propagates, so no sibling Git process outlives the read.
export async function both<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [x, y] = await Promise.allSettled([a, b]);
  if (x.status === "rejected") throw x.reason;
  if (y.status === "rejected") throw y.reason;
  return [x.value, y.value];
}

// Contract Δ3 `readCommitChanges` "Parse": diff-format(5) raw `-z` records. Any other status or form refuses the whole listing (null).
// `truncated`: the output stopped at a bound, so an unfinished last record is dropped. A finished record that breaks the grammar still refuses.
export function parseRawListing(raw: Uint8Array, objectFormat: ObjectFormat, truncated: boolean): RawEntry[] | null {
  const header = HEADERS[objectFormat];
  const entries: RawEntry[] = [];
  let at = 0;
  while (at < raw.length) {
    const start = at;
    const end = raw.indexOf(NUL, at);
    if (end < 0) return truncated ? entries : null;
    const m = header.exec(latin1(raw.subarray(at, end)));
    if (m === null) return null;
    const [modeA, modeB, oidA, oidB, code] = [m[1]!, m[2]!, m[3]!, m[4]!, m[5]!];
    const status = code[0] as RawStatus;
    const paths: Uint8Array[] = [];
    at = end + 1;
    for (let i = 0; i < (status === "R" ? 2 : 1); i++) {
      const stop = raw.indexOf(NUL, at);
      if (stop < 0) return truncated ? entries : null;
      if (stop === at) return null;
      paths.push(raw.subarray(at, stop));
      at = stop + 1;
    }
    // Data-model §1: the absent side of an added or deleted entry holds mode 000000 and the zero OID. Every other status has both sides.
    const absentA = modeA === ABSENT_MODE && ZERO.test(oidA);
    const absentB = modeB === ABSENT_MODE && ZERO.test(oidB);
    const sides = status === "A" ? absentA && modeB !== ABSENT_MODE && !ZERO.test(oidB) : status === "D" ? absentB && modeA !== ABSENT_MODE && !ZERO.test(oidA) : modeA !== ABSENT_MODE && modeB !== ABSENT_MODE;
    if (!sides) return null;
    entries.push({
      status,
      ...(status === "R" ? { score: Number(code.slice(1)), oldPath: paths[0]! } : {}),
      modes: [modeA, modeB],
      oids: [oidA, oidB],
      path: paths.at(-1)!,
      kind: kindOf([modeA, modeB]),
      start,
      end: at,
    });
  }
  return entries;
}

// The sections of a `diff-tree -p` output. Each section starts at a line that begins with `diff --git `. Hunk lines carry a prefix byte,
// so no body line begins that way. Null for output before the first section.
export function splitPatch(raw: Uint8Array): Uint8Array[] | null {
  if (raw.length === 0) return [];
  const starts: number[] = [];
  for (let at = 0; at < raw.length; ) {
    if (Buffer.compare(raw.subarray(at, at + DIFF_GIT.length), DIFF_GIT) === 0) starts.push(at);
    else if (at === 0) return null;
    const lf = raw.indexOf(LF, at);
    at = lf < 0 ? raw.length : lf + 1;
  }
  return starts.map((s, i) => raw.subarray(s, starts[i + 1] ?? raw.length));
}

// The old and new names of one section. A rename prints both in its `rename from` and `rename to` lines (diff.c `fill_metainfo`).
// Any other section names one path twice: `a/<p> b/<p>`, raw or C-quoted (diff.c `builtin_diff`).
function sectionNames(section: Uint8Array): [Uint8Array, Uint8Array] | null {
  const lines: Uint8Array[] = [];
  for (let at = 0; at < section.length && lines.length < 8; ) {
    const lf = section.indexOf(LF, at);
    const end = lf < 0 ? section.length : lf;
    lines.push(section.subarray(at, end));
    at = end + 1;
  }
  const field = (prefix: string) => {
    const line = lines.find((l) => latin1(l.subarray(0, prefix.length)) === prefix);
    if (line === undefined) return undefined;
    const rest = line.subarray(prefix.length);
    if (rest[0] !== QUOTE) return rest;
    const q = unquote(rest, 0);
    return q !== null && q.end === rest.length ? q.value : null;
  };
  const from = field("rename from ");
  const to = field("rename to ");
  if (from !== undefined || to !== undefined) return from && to ? [from, to] : null;
  const rest = lines[0]!.subarray(DIFF_GIT.length);
  if (rest[0] === QUOTE) {
    const a = unquote(rest, 0);
    if (a === null || rest[a.end] !== 0x20) return null;
    const b = unquote(rest, a.end + 1);
    if (b === null || b.end !== rest.length) return null;
    return Buffer.compare(a.value.subarray(2), b.value.subarray(2)) === 0 && latin1(a.value.subarray(0, 2)) === "a/" && latin1(b.value.subarray(0, 2)) === "b/" ? [a.value.subarray(2), b.value.subarray(2)] : null;
  }
  // `a/<p> b/<p>` with raw names: the path length follows from the line length.
  if ((rest.length - 5) % 2 !== 0 || rest.length < 7) return null;
  const n = (rest.length - 5) / 2;
  const a = rest.subarray(2, 2 + n);
  const b = rest.subarray(5 + n);
  return latin1(rest.subarray(0, 2)) === "a/" && latin1(rest.subarray(2 + n, 5 + n)) === " b/" && Buffer.compare(a, b) === 0 ? [a, b] : null;
}

// One `--numstat -z` record: the counts, then `<path> NUL`, or `NUL <old> NUL <new> NUL` for a rename (git-diff(1) "Other diff formats").
interface NumstatRecord {
  binary: boolean;
  names: [Uint8Array, Uint8Array];
}
const COUNTS = /^(?:(-)\t-|(?:0|[1-9][0-9]*)\t(?:0|[1-9][0-9]*))\t/;
function numstatRecords(raw: Uint8Array): NumstatRecord[] | null {
  const records: NumstatRecord[] = [];
  for (let at = 0; at < raw.length; ) {
    const counts = COUNTS.exec(latin1(raw.subarray(at, at + 48)));
    if (counts === null) return null;
    at += counts[0].length;
    const take = () => {
      const stop = raw.indexOf(NUL, at);
      if (stop <= at) return null;
      const name = raw.subarray(at, stop);
      at = stop + 1;
      return name;
    };
    let names: [Uint8Array, Uint8Array] | null;
    if (raw[at] === NUL) {
      at++;
      const old = take();
      const neu = old === null ? null : take();
      names = old !== null && neu !== null ? [old, neu] : null;
    } else {
      const one = take();
      names = one === null ? null : [one, one];
    }
    if (names === null) return null;
    records.push({ binary: counts[1] === "-", names });
  }
  return records;
}

// Plan.md D3 step 5: a pathspec also matches every path below `<path>/` (gitglossary(7) "pathspec").
const below = (name: Uint8Array, prefixes: readonly Uint8Array[]) => prefixes.some((p) => name.length > p.length + 1 && name[p.length] === SLASH && Buffer.compare(name.subarray(0, p.length), p) === 0);

// The sections of the entry itself, after the drop of the sections below its paths. Null for a section with another path.
function ownOf<T>(items: readonly T[], names: (item: T) => [Uint8Array, Uint8Array] | null, entry: RawEntry): T[] | null {
  const want: [Uint8Array, Uint8Array] = [entry.oldPath ?? entry.path, entry.path];
  const prefixes = entry.oldPath === undefined ? [entry.path] : [entry.path, entry.oldPath];
  const own: T[] = [];
  for (const item of items) {
    const n = names(item);
    if (n === null) return null;
    if (Buffer.compare(n[0], want[0]) === 0 && Buffer.compare(n[1], want[1]) === 0) own.push(item);
    else if (!(below(n[0], prefixes) && below(n[1], prefixes))) return null;
  }
  return own;
}

// The `new file mode` or `deleted file mode` line that follows the `diff --git` line (diff.c `builtin_diff`).
function sectionForm(section: Uint8Array): "new" | "deleted" | "other" {
  const second = section.subarray(section.indexOf(LF) + 1);
  const text = latin1(second.subarray(0, 18));
  return text.startsWith("new file mode ") ? "new" : text.startsWith("deleted file mode ") ? "deleted" : "other";
}

// Contract Δ3 `readCommitFile` "Section filter": the kept sections equal the listing entry. A type change prints a deletion, then a creation (F3).
function formsMatch(sections: readonly Uint8Array[], entry: RawEntry): boolean {
  const forms = sections.map(sectionForm);
  if (entry.status === "T") return forms.length === 2 && forms[0] === "deleted" && forms[1] === "new";
  return forms.length === 1 && forms[0] === (entry.status === "A" ? "new" : entry.status === "D" ? "deleted" : "other");
}

export interface Listing {
  changesId: string;
  repositoryId: string;
  viewId: string;
  oid: string;
  // The parent or the empty tree. Null for the base `shallow`.
  base: string | null;
  objectFormat: ObjectFormat;
  // The raw records that the result shows, and the start offset of each record with the end of the last one.
  raw: Uint8Array;
  offsets: Uint32Array;
}

export interface CommitTarget {
  viewId: string;
  oid: string;
  // The row parents in Git order, from the view topology.
  parents: readonly string[];
  // The view shallow set holds the commit.
  shallow: boolean;
}

export interface CommitChangesOptions {
  runner: GitRunner;
  trust: Trust;
}

export function createCommitChanges({ runner, trust }: CommitChangesOptions) {
  // Contract Δ5 "Retained commit listings": one per view.
  const byView = new Map<string, Listing>();
  const byId = new Map<string, Listing>();
  const drop = (viewId: string) => {
    const kept = byView.get(viewId);
    if (kept === undefined) return;
    byView.delete(viewId);
    byId.delete(kept.changesId);
  };

  async function step(t: InspectionTarget, args: string[], out: Collector, input?: Uint8Array): Promise<GitExit> {
    const s = await runRead(runner, t, args, out, input);
    if (t.signal.aborted) throw new Stop({ result: "canceled" });
    if ("refused" in s) throw fail(s.refused);
    if (s.exit.deadline !== undefined) throw new Stop({ result: "deadline" });
    if (s.exit.diagnosticLimit) throw fail("OUTPUT_LIMIT");
    return s.exit;
  }

  // Plan.md D2: the 001 `reads` gate before the first Git process of the read, as `comparison.ts` `compare` does.
  async function gate(t: InspectionTarget): Promise<TrustListing> {
    const listed = await trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: t.workspace });
    if (!listed.ok) throw new Stop("stop" in listed ? { result: listed.stop } : { result: "failed", code: listed.code });
    const refused = trust.gate(t.workspace, listed.listing, t.installation, "reads");
    if (refused !== null) throw fail(refused);
    return listed.listing;
  }

  // Contract §7 "Missing objects": a non-zero exit in a promisor repository means OBJECT_MISSING. The read never fetches.
  async function missing(t: InspectionTarget, listing: TrustListing): Promise<boolean> {
    const promisor = await hasPromisor(listing.entries, t.workspace, (paths) => runner.identities(t.operationId, contextOf(t.workspace), paths, t.signal));
    if (t.signal.aborted) throw new Stop({ result: "canceled" });
    if (promisor === "canceled" || promisor === "deadline") throw new Stop({ result: promisor });
    return promisor === true;
  }

  // Data-model §1 entry of one raw record.
  const entryValue = (e: RawEntry, fileId: number) => ({
    fileId,
    status: STATUS_NAMES[e.status],
    ...(e.score === undefined ? {} : { score: e.score }),
    pathBytes: b64(e.path),
    ...(e.oldPath === undefined ? {} : { oldPathBytes: b64(e.oldPath) }),
    kind: e.kind,
  });

  async function readCommitChanges(t: InspectionTarget, target: CommitTarget, parent: number): Promise<InspectionOutcome> {
    const w = t.workspace;
    drop(target.viewId);
    try {
      const listing: Omit<Listing, "base" | "raw" | "offsets"> = { changesId: crypto.randomUUID(), repositoryId: w.repositoryId, viewId: target.viewId, oid: target.oid, objectFormat: w.objectFormat };
      const parents = [...target.parents];
      const value = (base: object, files: unknown[], completeness: object) => ({ changesId: listing.changesId, viewId: target.viewId, oid: target.oid, parents, base, files, completeness });
      // Plan.md D3 step 3: a root that the view shallow set holds runs no command.
      if (parents.length === 0 && target.shallow) {
        const kept: Listing = { ...listing, base: null, raw: new Uint8Array(), offsets: Uint32Array.of(0) };
        byView.set(target.viewId, kept);
        byId.set(kept.changesId, kept);
        return { result: "succeeded", value: value({ kind: "shallow" }, [], { state: "complete" }) };
      }
      const trustListing = await gate(t);
      const base = parents.length === 0 ? { kind: "empty-tree" as const, oid: await emptyTreeOf((args, out, input) => step(t, args, out, input), w.objectFormat) } : { kind: "parent" as const, index: parent, oid: parents[parent]! };
      const out = createCollector({ maxBytes: STATUS_LISTING_BYTES });
      const exit = await step(t, commitChangesArgs(base.oid, target.oid, w.objectFormat), out);
      // Contract §5: a reached bound stops the process, so its exit status proves nothing.
      if (!out.limited && exit.exitCode !== 0) {
        if (await missing(t, trustListing)) return { result: "failed", code: "OBJECT_MISSING", value: { remedy: { text: OBJECT_MISSING_REMEDY } } };
        return { result: "failed", code: "GIT_FAILED" };
      }
      const raw = out.take();
      const parsed = parseRawListing(raw, w.objectFormat, out.limited);
      if (parsed === null) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
      let reason: "STATUS_LISTING_RECORDS" | "STATUS_LISTING_BYTES" | "COMMIT_CHANGES_RESULT_BYTES" | null = out.limited ? "STATUS_LISTING_BYTES" : null;
      let entries = parsed;
      if (entries.length > STATUS_LISTING_RECORDS) {
        entries = entries.slice(0, STATUS_LISTING_RECORDS);
        reason ??= "STATUS_LISTING_RECORDS";
      }
      // Contract Δ5: the encoded result holds at most COMMIT_CHANGES_RESULT_BYTES. Whole records in Git order, so the first cut wins.
      const files = entries.map(entryValue);
      // The encoded size of the result without its entries. Only the reason and the digit count of `shown` change it.
      const fixed = new Map<string, number>();
      const sizeOf = (n: number, r: string | null) => {
        const key = `${r}:${String(n).length}`;
        if (!fixed.has(key)) fixed.set(key, encodedBytes(value(base, [], r === null ? { state: "complete" } : { state: "limited", code: "OUTPUT_LIMIT", reason: r, shown: n })));
        return fixed.get(key)!;
      };
      let total = sizeOf(files.length, reason);
      for (const f of files) total += encodedBytes(f) + 1;
      if (files.length > 0) total -= 1;
      if (total > COMMIT_CHANGES_RESULT_BYTES) {
        let n = 0;
        let sum = 0;
        for (const f of files) {
          const next = sum + encodedBytes(f) + (n === 0 ? 0 : 1);
          if (sizeOf(n + 1, "COMMIT_CHANGES_RESULT_BYTES") + next > COMMIT_CHANGES_RESULT_BYTES) break;
          sum = next;
          n++;
        }
        files.length = n;
        entries = entries.slice(0, n);
        reason = "COMMIT_CHANGES_RESULT_BYTES";
      }
      const offsets = Uint32Array.from([...entries.map((e) => e.start), entries.at(-1)?.end ?? 0]);
      const kept: Listing = { ...listing, base: base.oid, raw: raw.subarray(0, entries.at(-1)?.end ?? 0), offsets };
      if (t.signal.aborted) return { result: "canceled" };
      byView.set(target.viewId, kept);
      byId.set(kept.changesId, kept);
      const completeness = reason === null ? { state: "complete" } : { state: "limited", code: "OUTPUT_LIMIT", reason, shown: files.length };
      const result = value(base, files, completeness);
      return reason === null ? { result: "succeeded", value: result } : { result: "limited", code: "OUTPUT_LIMIT", value: result };
    } catch (error) {
      if (error instanceof Stop) return error.outcome;
      throw error;
    }
  }

  // The retained entry `fileId` of `changesId`. Contract Δ3: an unknown listing gives UNKNOWN_TARGET, and a `fileId` outside it INVALID_REQUEST.
  function entryOf(changesId: string, fileId: number): { listing: Listing; entry: RawEntry } | { refused: "UNKNOWN_TARGET" | "INVALID_REQUEST" } {
    const listing = byId.get(changesId);
    if (listing === undefined) return { refused: "UNKNOWN_TARGET" };
    if (!Number.isSafeInteger(fileId) || fileId < 0 || fileId >= listing.offsets.length - 1) return { refused: "INVALID_REQUEST" };
    const record = listing.raw.subarray(listing.offsets[fileId]!, listing.offsets[fileId + 1]!);
    const entry = parseRawListing(record, listing.objectFormat, false)![0]!;
    return { listing, entry };
  }

  // Data-model §2 `facts`, from the listing alone.
  function factsOf(e: RawEntry) {
    const [oldMode, newMode] = e.modes;
    return {
      ...(e.status === "R" ? { rename: { oldPath: b64(e.oldPath!), score: e.score! } } : {}),
      ...(e.status !== "T" && e.status !== "A" && e.status !== "D" && oldMode !== newMode ? { mode: { old: oldMode, new: newMode } } : {}),
      ...(e.kind === "submodule" ? { submodule: { old: oldMode === GITLINK ? e.oids[0] : null, new: newMode === GITLINK ? e.oids[1] : null } } : {}),
      ...(e.status === "T" ? { typeChange: { old: kindOfMode(oldMode), new: kindOfMode(newMode) } } : {}),
    };
  }

  async function readCommitFile(t: InspectionTarget, changesId: string, fileId: number): Promise<InspectionOutcome> {
    const found = entryOf(changesId, fileId);
    if ("refused" in found) return { result: "failed", code: found.refused };
    const { listing, entry } = found;
    const facts = factsOf(entry);
    const value = (binary: boolean, patch: string | null, completeness: object, remedy?: object) => ({ changesId, fileId, facts, binary, patch, completeness, ...(remedy === undefined ? {} : { remedy }) });
    try {
      // Plan.md D3 step 1: the gate runs again, because the trust state can change between reads.
      const trustListing = await gate(t);
      // Step 2: a submodule entry runs no Git read. Its facts come from the listing.
      if (entry.kind === "submodule") return { result: "succeeded", value: value(false, null, { state: "complete" }) };
      // Contract Δ3: an argv item is text, so a path that is no valid UTF-8 gets the 001 reason `path`.
      const names = (entry.oldPath === undefined ? [entry.path] : [entry.path, entry.oldPath]).map((p) => {
        try {
          return strictUtf8.decode(p);
        } catch {
          return null;
        }
      });
      if (names.some((n) => n === null)) return { result: "failed", code: "UNSUPPORTED_COMPARISON", value: { reason: "path" } };
      const paths = names as string[];
      const patchOut = createCollector({ maxBytes: CANONICAL_DIFF_BYTES + 1 });
      const numstatOut = createCollector({ maxBytes: STATUS_LISTING_BYTES });
      const [patchExit, numstatExit] = await both(
        step(t, commitPatchArgs(listing.base!, listing.oid, listing.objectFormat, paths), patchOut),
        step(t, commitNumstatArgs(listing.base!, listing.oid, listing.objectFormat, paths), numstatOut),
      );
      if ((!patchOut.limited && patchExit.exitCode !== 0) || (!numstatOut.limited && numstatExit.exitCode !== 0)) {
        if (await missing(t, trustListing)) return { result: "limited", code: "OBJECT_MISSING", value: value(false, null, { state: "limited", code: "OBJECT_MISSING" }, { text: OBJECT_MISSING_REMEDY }) };
        return { result: "failed", code: "GIT_FAILED" };
      }
      if (numstatOut.limited) return { result: "failed", code: "OUTPUT_LIMIT" };
      const records = numstatRecords(numstatOut.take());
      const ownRecords = records === null ? null : ownOf(records, (r) => r.names, entry);
      if (ownRecords === null || ownRecords.length !== 1) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
      const binary = ownRecords[0]!.binary;
      // Contract §5: a cut output cannot show its sections. The 001 limited result names the reached bound.
      if (patchOut.limited) return { result: "limited", code: "OUTPUT_LIMIT", value: value(binary, null, { state: "limited", code: "OUTPUT_LIMIT", reason: "CANONICAL_DIFF_BYTES" }) };
      const sections = splitPatch(patchOut.take());
      const own = sections === null ? null : ownOf(sections, sectionNames, entry);
      if (own === null || !formsMatch(own, entry)) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
      // Plan.md D3 step 4: a type change sends its fact line only. A binary file sends no patch (FR-010).
      if (entry.status === "T" || binary) return { result: "succeeded", value: value(binary, null, { state: "complete" }) };
      const section = own[0]!;
      const parsed = parsePatch(section, entry.path, entry.oldPath ?? null);
      if (!parsed.ok) {
        const c = parsed.completeness;
        if (c.state === "limited" && c.code === "OUTPUT_LIMIT") return { result: "limited", code: "OUTPUT_LIMIT", value: value(false, null, { state: "limited", code: "OUTPUT_LIMIT", reason: c.reason }) };
        return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
      }
      // Data-model §2: a pure rename or mode change without a hunk sends no patch.
      return { result: "succeeded", value: value(false, parsed.patch.hunks.length === 0 ? null : b64(section), { state: "complete" }) };
    } catch (error) {
      if (error instanceof Stop) return error.outcome;
      throw error;
    }
  }

  return {
    readCommitChanges,
    readCommitFile,
    // The retained entry, for the acceptance checks of `readCommitFile` and `readBlame`.
    entry: entryOf,
    // Contract Δ8: a new call or a view release drops the listing of that view.
    dropView: drop,
    release(repositoryId: string): void {
      for (const [viewId, l] of byView) if (l.repositoryId === repositoryId) drop(viewId);
    },
  };
}

export type CommitChanges = ReturnType<typeof createCommitChanges>;
