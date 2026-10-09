// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §4 "File staging" and data-model §5 "File-action decision". The decision reads no file and starts no process.

import { isUtf8 } from "node:buffer";
import { WHOLE_FILE_STAGE_INPUT_BYTES } from "./limits";

export const FILE_ACTION_REASONS = ["type", "symlink", "submodule", "index-flag", "path", "rename", "filter", "LFS", "size", "blob-proof"] as const;
export type FileActionReason = (typeof FILE_ACTION_REASONS)[number];

export type FileActionCategory = "staged" | "unstaged" | "untracked" | "conflicted";

// `diskPath` is the on-disk name of the working path, as bytes relative to the worktree root.
// It uses Git's `/` separator form. The decision compares bytes and converts no separator.
export type WorkingFacts =
  | { type: "file"; size: number; diskPath: Uint8Array }
  | { type: "directory" | "symlink" | "other"; diskPath: Uint8Array }
  | { type: "absent" }
  | { type: "unreadable" };

export interface FileActionInput {
  category: FileActionCategory;
  // One `status --porcelain=v2 -z` record without its final NUL. A type 2 record keeps the NUL between the path and the original path.
  record: Uint8Array;
  headUnborn: boolean;
  indexFlags: { intentToAdd: boolean; assumeUnchanged: boolean; skipWorktree: boolean };
  // `check-attr` values by attribute name. An absent name is `unspecified`.
  attributes: Readonly<Record<string, string>>;
  working: WorkingFacts;
  // Hunk facts only. The decision needs no text support (contract §4), so it ignores them.
  content?: { binary?: boolean; validUtf8?: boolean; lineEndings?: "none" | "lf" | "crlf" | "mixed" };
}

export interface StagePath {
  path: Uint8Array;
  mode?: undefined;
  objectId?: undefined;
}

// The `update-index -z --index-info` line of one path. Mode 0 removes the path.
export interface UnstagePath {
  path: Uint8Array;
  mode: number;
  objectId: string;
}

export type FileActionDecision =
  | { direction: "stage"; changedPaths: StagePath[] }
  | { direction: "unstage"; changedPaths: UnstagePath[] }
  | { direction: null; code: "UNSUPPORTED_COMPARISON"; reason: FileActionReason }
  | { direction: null; code: "CONFLICTED" | "MALFORMED_GIT_OUTPUT" };

interface StatusRecord {
  kind: "1" | "2" | "?";
  x: string;
  y: string;
  sub: string;
  mH: string;
  mI: string;
  mW: string;
  hH: string;
  path: Uint8Array;
  origPath?: Uint8Array;
}

const SPACE = 0x20;
const NUL = 0x00;
const SLASH = 0x2f;
const GITLINK = "160000";
const SYMLINK = "120000";
const ABSENT_MODE = "000000";

const latin1 = new TextDecoder("latin1");
const MODE = /^[0-7]{6}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// git-status(1) "Porcelain Format Version 2": `N...` for an entry that is no submodule, else `S<c><m><u>`.
const SUBMODULE_STATE = /^(?:N\.\.\.|S[C.][M.][U.])$/;
const XY = /^[.MTADRCU]{2}$/;
const SCORE = /^[RC]\d{1,3}$/;

const refuse = (reason: FileActionReason): FileActionDecision => ({ direction: null, code: "UNSUPPORTED_COMPARISON", reason });
const MALFORMED: FileActionDecision = { direction: null, code: "MALFORMED_GIT_OUTPUT" };

// Splits off `count` space-separated fields. The rest is the path, which can hold spaces.
function fields(record: Uint8Array, count: number): { fields: string[]; rest: Uint8Array } | null {
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(SPACE, at);
    if (end < 0) return null;
    out.push(latin1.decode(record.subarray(at, end)));
    at = end + 1;
  }
  return { fields: out, rest: record.subarray(at) };
}

// git-status(1) "Porcelain Format Version 2". `u` and `!` records give `null`; the caller handles `u` first.
function parseRecord(record: Uint8Array): StatusRecord | null {
  const kind = latin1.decode(record.subarray(0, 2));
  if (kind === "? ") {
    const path = record.subarray(2);
    return path.length === 0 ? null : { kind: "?", x: "?", y: "?", sub: "N...", mH: "", mI: "", mW: "", hH: "", path };
  }
  if (kind !== "1 " && kind !== "2 ") return null;
  const split = fields(record, kind === "1 " ? 8 : 9);
  if (!split) return null;
  const [, xy, sub, mH, mI, mW, hH, hI, score] = split.fields as [string, string, string, string, string, string, string, string, string?];
  if (!XY.test(xy) || !SUBMODULE_STATE.test(sub) || ![mH, mI, mW].every((m) => MODE.test(m))) return null;
  if (!OBJECT_ID.test(hH) || !OBJECT_ID.test(hI) || hH.length !== hI.length) return null;
  let path = split.rest;
  let origPath: Uint8Array | undefined;
  if (kind === "2 ") {
    if (!SCORE.test(score ?? "")) return null;
    const nul = path.indexOf(NUL);
    if (nul < 0) return null;
    origPath = path.subarray(nul + 1);
    path = path.subarray(0, nul);
    if (origPath.length === 0 || origPath.includes(NUL)) return null;
  }
  if (path.length === 0 || path.includes(NUL)) return null;
  return { kind: kind[0] as "1" | "2", x: xy[0]!, y: xy[1]!, sub, mH, mI, mW, hH, path, origPath };
}

// git convert.c `git_path_check_convert`: `set`, `unset`, and `unspecified` select no filter driver.
export function filterReason(attributes: Readonly<Record<string, string>>): "filter" | "LFS" | null {
  const value = attributes.filter;
  if (value === undefined || value === "unspecified" || value === "set" || value === "unset") return null;
  // Git LFS installs its driver as `filter=lfs`.
  return value === "lfs" ? "LFS" : "filter";
}

function unstagePaths(record: StatusRecord, headUnborn: boolean): UnstagePath[] | null {
  const zero = "0".repeat(record.hH.length);
  // An unborn HEAD has no entries.
  const headEntry = (path: Uint8Array): UnstagePath =>
    headUnborn || record.mH === ABSENT_MODE ? { path, mode: 0, objectId: zero } : { path, mode: Number.parseInt(record.mH, 8), objectId: record.hH };
  const leave = (path: Uint8Array): UnstagePath => ({ path, mode: 0, objectId: zero });
  if (record.kind === "1") return "MAD".includes(record.x) ? [headEntry(record.path)] : null;
  // A type 2 record holds the HEAD mode and object ID of its original path.
  if (record.x === "R" && record.origPath) return [headEntry(record.origPath), leave(record.path)];
  if (record.x === "C") return [leave(record.path)];
  return null;
}

export function decideFileAction(input: FileActionInput): FileActionDecision {
  // Operation state keeps its own code.
  if (input.category === "conflicted" || latin1.decode(input.record.subarray(0, 2)) === "u ") return { direction: null, code: "CONFLICTED" };
  const record = parseRecord(input.record);
  if (!record) return MALFORMED;
  const staged = input.category === "staged";
  if (input.category === "untracked" ? record.kind !== "?" : record.kind === "?") return MALFORMED;
  if ((staged && record.x === ".") || (input.category === "unstaged" && record.y === ".")) return MALFORMED;

  if (!isUtf8(record.path) || (record.origPath && !isUtf8(record.origPath))) return refuse("path");
  const flags = input.indexFlags;
  if (flags.intentToAdd || flags.assumeUnchanged || flags.skipWorktree) return refuse("index-flag");
  // With `--untracked-files=all`, Git lists a directory record only for a nested repository.
  const nested = record.kind === "?" && record.path[record.path.length - 1] === SLASH;
  if (nested || record.sub[0] === "S" || [record.mH, record.mI, record.mW].includes(GITLINK)) return refuse("submodule");
  // Data-model §5 path rule: an unreadable entry, or an on-disk name that differs from the index path bytes.
  const working = input.working;
  if (working.type === "unreadable") return refuse("path");
  if (working.type !== "absent" && Buffer.compare(working.diskPath, record.path) !== 0) return refuse("path");

  if (staged) {
    if (record.x === "T") return refuse("type");
    if (record.mH === SYMLINK || record.mI === SYMLINK) return refuse("symlink");
    // `unstage` runs no filter and reads no working file, so content, filters, and size never refuse it.
    const changedPaths = unstagePaths(record, input.headUnborn);
    return changedPaths ? { direction: "unstage", changedPaths } : MALFORMED;
  }

  if (record.y === "T") return refuse("type");
  if (working.type === "symlink" || record.mI === SYMLINK || record.mW === SYMLINK) return refuse("symlink");
  if (record.y === "R" || record.y === "C") return refuse("rename");
  // An absent working file removes a tracked entry. An untracked entry needs a regular file.
  if (working.type !== "file" && !(working.type === "absent" && record.kind !== "?")) return refuse("type");
  const filter = filterReason(input.attributes);
  if (filter) return refuse(filter);
  if (working.type === "file" && working.size > WHOLE_FILE_STAGE_INPUT_BYTES) return refuse("size");
  return { direction: "stage", changedPaths: [{ path: record.path }] };
}
