// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T103: the hunk support decision of contract §4 and data-model §5 "Support decision". It reads no file and starts no process.

import { isUtf8 } from "node:buffer";
import { filterReason, type WorkingFacts } from "../contracts/file-action";
import { COMPARED_NORMALIZED_VERSION_BYTES, COMPARED_RAW_VERSION_BYTES } from "../contracts/limits";
import type { NumstatResult, PatchResult } from "./diff-parser";
import type { StatusRecord } from "./status-parser";

export const SUPPORT_REASONS = ["binary", "encoding", "size", "rename", "mode", "type", "symlink", "submodule", "LFS", "filter", "state", "line-endings", "index-flag", "path"] as const;
export type SupportReason = (typeof SUPPORT_REASONS)[number];

export type SupportDecision = { supported: true } | { supported: false; code: "UNSUPPORTED_COMPARISON"; reason: SupportReason } | { supported: false; code: "MALFORMED_GIT_OUTPUT" };

// The attributes of `attributeArgs`, in request order.
export const SUPPORT_ATTRIBUTES = ["filter", "diff", "text", "eol", "crlf", "working-tree-encoding"] as const;
export type SupportAttributes = Record<(typeof SUPPORT_ATTRIBUTES)[number], string>;

// builtin/ls-files.c `write_eolinfo`. An empty value means no regular file on that side, or an unreadable one.
export interface EolInfo {
  index: string;
  working: string;
  attr: string;
}
// Keyed by the path bytes as a latin1 string. A conflicted path has one record per stage.
export type EolListing = ReadonlyMap<string, readonly EolInfo[]>;

export interface SupportInput {
  scope: "head-to-index" | "index-to-worktree" | "empty-to-untracked";
  record: StatusRecord;
  indexFlags: { intentToAdd: boolean; assumeUnchanged: boolean; skipWorktree: boolean };
  attributes: Readonly<Record<string, string>>;
  working: WorkingFacts;
  eol: EolListing;
  // The byte counts of the compared sides that the caller knows.
  sizes: { raw: readonly number[]; normalized: readonly number[] };
  patch: PatchResult;
  // The `parseNumstat` result of the scope's numstat read.
  numstat: NumstatResult;
}

const NUL = 0x00;
const LF = 0x0a;
const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const GITLINK = "160000";
const SYMLINK = "120000";
const ABSENT_MODE = "000000";

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
const refuse = (reason: SupportReason): SupportDecision => ({ supported: false, code: "UNSUPPORTED_COMPARISON", reason });
const MALFORMED: SupportDecision = { supported: false, code: "MALFORMED_GIT_OUTPUT" };

// git-check-attr(1) `-z`: `<path> NUL <attribute> NUL <info> NUL` for each attribute, in request order, for each stdin path.
export function parseAttributes(stdout: Uint8Array, paths: readonly Uint8Array[]): SupportAttributes[] | null {
  const fields: Uint8Array[] = [];
  for (let at = 0; at < stdout.length; ) {
    const end = stdout.indexOf(NUL, at);
    if (end < 0) return null;
    fields.push(stdout.subarray(at, end));
    at = end + 1;
  }
  if (fields.length !== paths.length * SUPPORT_ATTRIBUTES.length * 3) return null;
  const out: SupportAttributes[] = [];
  let f = 0;
  for (const path of paths) {
    const values = {} as SupportAttributes;
    for (const name of SUPPORT_ATTRIBUTES) {
      if (Buffer.compare(fields[f]!, path) !== 0 || latin1(fields[f + 1]!) !== name) return null;
      values[name] = latin1(fields[f + 2]!);
      f += 3;
    }
    out.push(values);
  }
  return out;
}

// convert.c `gather_convert_stats_ascii` and `get_convert_attr_ascii` give these values. `write_eolinfo` pads them to 5, 5, and 17 bytes.
const EOL_STATS = ["", "-text", "none", "lf", "crlf", "mixed"];
const EOL_ATTRS = ["", "-text", "text", "text eol=lf", "text eol=crlf", "text=auto", "text=auto eol=crlf", "text=auto eol=lf"];

// `ls-files --eol -z`: one `i/<stats> w/<stats> attr/<attr>` TAB `<path>` NUL record for each index entry.
export function parseEolListing(stdout: Uint8Array): EolListing | null {
  const listing = new Map<string, EolInfo[]>();
  for (let at = 0; at < stdout.length; ) {
    const end = stdout.indexOf(NUL, at);
    if (end < 0) return null;
    const record = latin1(stdout.subarray(at, end));
    at = end + 1;
    const index = EOL_STATS.find((v) => record.startsWith(`i/${v.padEnd(5)} w/`));
    if (index === undefined) return null;
    let rest = record.slice(`i/${index.padEnd(5)} w/`.length);
    const working = EOL_STATS.find((v) => rest.startsWith(`${v.padEnd(5)} attr/`));
    if (working === undefined) return null;
    rest = rest.slice(`${working.padEnd(5)} attr/`.length);
    const attr = EOL_ATTRS.find((v) => rest.startsWith(`${v.padEnd(17)}\t`));
    if (attr === undefined) return null;
    const path = rest.slice(attr.padEnd(17).length + 1);
    if (path.length === 0) return null;
    const records = listing.get(path) ?? [];
    records.push({ index, working, attr });
    listing.set(path, records);
  }
  return listing;
}

// Research R3 "Untracked hunk content": check-in reads the index `.gitattributes` only without a working file (attr.c `read_attr`).
// `diff --no-index` loads no index, so such an entry in the folder of the path or an ancestor refuses the untracked read.
function indexOnlyAttributes(path: Uint8Array, eol: EolListing): boolean {
  for (let end = path.lastIndexOf(SLASH); ; end = path.lastIndexOf(SLASH, end - 1)) {
    const folder = end < 0 ? "" : latin1(path.subarray(0, end + 1));
    if (eol.get(`${folder}.gitattributes`)?.some((r) => r.working === "")) return true;
    if (end <= 0) return false;
  }
}

// Body lines only. A function heading is a cut file line, and a marker line is translated Git text.
function validContent(hunk: Uint8Array): boolean {
  let at = hunk.indexOf(LF) + 1;
  while (at < hunk.length) {
    const end = hunk.indexOf(LF, at) + 1;
    if (hunk[at] !== BACKSLASH && !isUtf8(hunk.subarray(at, end))) return false;
    at = end;
  }
  return true;
}

export function decideSupport(input: SupportInput): SupportDecision {
  const record = input.record;
  if (record.kind === "unmerged") return refuse("state");
  const tracked = record.kind === "ordinary" || record.kind === "rename" ? record : null;
  const untracked = input.scope === "empty-to-untracked";
  if (untracked ? record.kind !== "untracked" : !tracked) return MALFORMED;
  const staged = input.scope === "head-to-index";
  const path = record.path.bytes;

  if (!isUtf8(path) || (record.kind === "rename" && !isUtf8(record.originalPath.bytes))) return refuse("path");
  const flags = input.indexFlags;
  if (flags.intentToAdd || flags.assumeUnchanged || flags.skipWorktree) return refuse("index-flag");
  // With `--untracked-files=all`, Git lists a directory record only for a nested repository.
  if (tracked ? tracked.submodule[0] === "S" || tracked.modes.includes(GITLINK) : path[path.length - 1] === SLASH) return refuse("submodule");
  // Data-model §5 path rule, as in `decideFileAction`.
  const working = input.working;
  if (working.type === "unreadable") return refuse("path");
  if (working.type !== "absent" && Buffer.compare(working.diskPath, path) !== 0) return refuse("path");

  // HEAD and index modes for `head-to-index`, index and worktree modes for `index-to-worktree`.
  const side = !tracked ? null : staged ? { letter: tracked.xy[0], modes: [tracked.modes[0], tracked.modes[1]] } : { letter: tracked.xy[1], modes: [tracked.modes[1], tracked.modes[2]] };
  if (side?.letter === "T") return refuse("type");
  if (!staged && working.type !== "file" && !(working.type === "absent" && !untracked)) return working.type === "symlink" ? refuse("symlink") : refuse("type");
  if (side?.modes.includes(SYMLINK)) return refuse("symlink");
  if (side && (side.letter === "R" || side.letter === "C")) return refuse("rename");
  if (side && !side.modes.includes(ABSENT_MODE) && side.modes[0] !== side.modes[1]) return refuse("mode");

  const filter = filterReason(input.attributes);
  if (filter) return refuse(filter);
  // convert.c `git_path_check_encoding`: only an unspecified attribute converts nothing for certain. Git dies for `set` and `unset`.
  const encoding = input.attributes["working-tree-encoding"];
  if (encoding !== undefined && encoding !== "unspecified") return refuse("encoding");
  // Contract §5: the size bounds apply before any content decode.
  if (input.sizes.raw.some((n) => n > COMPARED_RAW_VERSION_BYTES) || input.sizes.normalized.some((n) => n > COMPARED_NORMALIZED_VERSION_BYTES)) return refuse("size");

  // A tracked entry that the index holds has its `ls-files --eol` record. A staged deletion has none.
  const eol = !tracked || (staged && tracked.xy[0] === "D") ? [] : input.eol.get(latin1(path));
  if (eol === undefined) return MALFORMED;
  // The numstat read of the scope decides binary, also for an unset `diff` attribute. `ls-files --eol` `-text` is no binary signal.
  if (!input.numstat.ok) return MALFORMED;
  if (input.numstat.binary) return refuse("binary");
  // Contract §4: `mixed` on the index or working side. `i/none` is no line-ending value.
  if (eol.some((r) => r.index === "mixed" || r.working === "mixed")) return refuse("line-endings");
  if (untracked && indexOnlyAttributes(path, input.eol)) return refuse("line-endings");

  const patch = input.patch;
  if (!patch.ok) return patch.completeness.state === "limited" && patch.completeness.code === "OUTPUT_LIMIT" ? refuse("size") : MALFORMED;
  if (!patch.patch.hunks.every((h) => validContent(h.bytes))) return refuse("encoding");
  return { supported: true };
}
