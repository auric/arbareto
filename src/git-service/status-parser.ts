// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Streaming parser of `status --porcelain=v2 -z --branch` output (T078).
// Record rules: git-status(1) "Porcelain Format Version 2" in Git 2.55.0.

import type { ErrorCode } from "../contracts/errors";
import { STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS } from "../contracts/limits";
import { isObjectId, type ObjectFormat } from "./commands";

export type { ObjectFormat };

// The field-length caps of the fixed-field rule. `isObjectId` checks the object IDs.
const OID_LENGTHS: Record<ObjectFormat, number> = { sha1: 40, sha256: 64 };

function objectIdLength(objectFormat: ObjectFormat): number {
  if (!Object.hasOwn(OID_LENGTHS, objectFormat)) throw new TypeError("object format refused");
  return OID_LENGTHS[objectFormat];
}

export interface StatusPath {
  // The literal path bytes. They are the path identity.
  bytes: Uint8Array;
  display: string;
}

export interface BranchHeaders {
  // `null` for `(initial)` or an absent header.
  oid: string | null;
  // `null` for `(detached)` or an absent header.
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

interface ChangedFields {
  xy: string;
  submodule: string;
  path: StatusPath;
}

export interface OrdinaryRecord extends ChangedFields {
  kind: "ordinary";
  // HEAD, index, worktree.
  modes: [string, string, string];
  // HEAD, index.
  oids: [string, string];
}

export interface RenameRecord extends ChangedFields {
  kind: "rename";
  modes: [string, string, string];
  oids: [string, string];
  // `R<score>` or `C<score>`.
  score: string;
  originalPath: StatusPath;
}

export interface UnmergedRecord extends ChangedFields {
  kind: "unmerged";
  // Stages 1, 2, 3, then the worktree.
  modes: [string, string, string, string];
  // Stages 1, 2, 3.
  oids: [string, string, string];
}

export interface PathRecord {
  kind: "untracked" | "ignored";
  path: StatusPath;
}

export type StatusRecord = OrdinaryRecord | RenameRecord | UnmergedRecord | PathRecord;

// Contract §5 "Status or index listing": the export names of the bounds in `limits.ts`.
export type StatusBound = "STATUS_LISTING_BYTES" | "STATUS_LISTING_RECORDS";

// `limited` always carries `OUTPUT_LIMIT` and a `StatusBound` name, and `failed` always carries `MALFORMED_GIT_OUTPUT`.
// The fields use the wide types of the service completeness shape.
export type StatusParseResult =
  | { state: "complete"; branch: BranchHeaders; records: StatusRecord[] }
  | { state: "limited"; code: ErrorCode; reason: string; branch: BranchHeaders; records: StatusRecord[] }
  | { state: "failed"; code: ErrorCode };

export interface StatusParser {
  push(chunk: Uint8Array): void;
  end(): StatusParseResult;
  // True once a contract §5 status bound ends the parse. Later bytes change nothing.
  readonly limited: boolean;
}

// Unicode Table 3-7 "Well-Formed UTF-8 Byte Sequences": the length of the sequence at `at`, or 0.
function wellFormedLength(b: Uint8Array, at: number): number {
  const c = b[at]!;
  if (c < 0x80) return 1;
  if (c < 0xc2 || c > 0xf4) return 0;
  const cont = (k: number, lo = 0x80, hi = 0xbf) => at + k < b.length && b[at + k]! >= lo && b[at + k]! <= hi;
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0;
  if (c === 0xe0) return cont(1, 0xa0) && cont(2) ? 3 : 0;
  if ((c >= 0xe1 && c <= 0xec) || c === 0xee || c === 0xef) return cont(1) && cont(2) ? 3 : 0;
  if (c === 0xed) return cont(1, 0x80, 0x9f) && cont(2) ? 3 : 0;
  if (c === 0xf0) return cont(1, 0x90) && cont(2) && cont(3) ? 4 : 0;
  if (c >= 0xf1 && c <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (c === 0xf4) return cont(1, 0x80, 0x8f) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder("utf-8", { ignoreBOM: true });

const BACKSLASH = 0x5c;
const LETTER_X = 0x78;
const HEX_DIGITS = new TextEncoder().encode("0123456789abcdef");

// Data-model §5: each byte outside a well-formed UTF-8 sequence displays as `\xNN`.
export function displayPath(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes);
  } catch {
    // Keep the byte loop out of this catch block. Bun did not optimize it there: 1.7 s against 0.3 s for 32 MiB.
    return escapeInvalid(bytes);
  }
}

// Contract §5: build UTF-8 bytes and decode once. A string fragment per byte costs gigabytes for a 32 MiB path.
function escapeInvalid(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length * 4);
  let o = 0;
  let run = 0;
  let at = 0;
  while (at < bytes.length) {
    const n = wellFormedLength(bytes, at);
    if (n > 0) {
      at += n;
      continue;
    }
    if (run < at) {
      out.set(bytes.subarray(run, at), o);
      o += at - run;
    }
    const b = bytes[at]!;
    out[o++] = BACKSLASH;
    out[o++] = LETTER_X;
    out[o++] = HEX_DIGITS[b >> 4]!;
    out[o++] = HEX_DIGITS[b & 0xf]!;
    run = ++at;
  }
  out.set(bytes.subarray(run, at), o);
  o += at - run;
  return lenient.decode(out.subarray(0, o));
}

const SPACE = 0x20;
const NUL = 0x00;

// git-status(1): `<XY>` takes the short-format letters, with `.` for unchanged. `<sub>` is `N...` or `S<c><m><u>`. Modes are octal.
// Short format: `U` occurs only in the seven unmerged pairs. A `2` record holds `R` or `C` in X or Y.
const CHANGED_XY = /^[.MTADRC]{2}$/;
const RENAMED_XY = /[RC]/;
const UNMERGED_XY: ReadonlySet<string> = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const SUBMODULE = /^(?:N\.\.\.|S[C.][M.][U.])$/;
const MODE = /^[0-7]{6}$/;
const SCORE = /^[RC]([0-9]{1,3})$/;
const AHEAD_BEHIND = /^\+([0-9]+) -([0-9]+)$/;

type Kind = "1" | "2" | "u" | "?" | "!";

// The space-separated fields before the path, and their maximum lengths with the separators.
function fixedRule(kind: Kind, oidLength: number): { fields: number; maxBytes: number } {
  const changed = 1 + 1 + 2 + 1 + 4 + 1;
  switch (kind) {
    case "1":
      return { fields: 8, maxBytes: changed + 3 * 7 + 2 * (oidLength + 1) };
    case "2":
      return { fields: 9, maxBytes: changed + 3 * 7 + 2 * (oidLength + 1) + 5 };
    case "u":
      return { fields: 10, maxBytes: changed + 4 * 7 + 3 * (oidLength + 1) };
    default:
      return { fields: 1, maxBytes: 2 };
  }
}

const KINDS: ReadonlySet<number> = new Set([0x31, 0x32, 0x75, 0x3f, 0x21]);

class Malformed extends Error {}

type Phase = "start" | "header" | "fixed" | "path" | "original";

// `branchHeaders`: the arguments pass `--branch`, so a complete output holds both headers.
// `onRecord`: each complete record goes to it, in output order, and the parser keeps no record.
export function createStatusParser(objectFormat: ObjectFormat, branchHeaders = true, onRecord?: (record: StatusRecord) => void): StatusParser {
  const oidLength = objectIdLength(objectFormat);
  const branch: BranchHeaders = { oid: null, head: null, upstream: null, ahead: null, behind: null };
  const records: StatusRecord[] = [];
  let bytes = 0;
  let count = 0;
  let sawOid = false;
  let sawHead = false;
  let final: StatusParseResult | null = null;

  // The unfinished segment of the current record. Only these bytes stay between `push` calls.
  let parts: Uint8Array[] = [];
  let partBytes = 0;
  let phase: Phase = "start";
  let kind: Kind = "1";
  let fields = 0;
  let maxFixed = 0;
  let spaces = 0;
  let fixed: string[] = [];
  let pending: RenameRecord | null = null;

  const keep = (segment: Uint8Array) => {
    if (segment.length === 0) return;
    // A caller can reuse its chunk buffer, so a kept segment is a copy.
    parts.push(new Uint8Array(segment));
    partBytes += segment.length;
  };
  const take = (tail: Uint8Array): Uint8Array => {
    let out: Uint8Array;
    if (parts.length === 0) out = new Uint8Array(tail);
    else {
      out = new Uint8Array(partBytes + tail.length);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      out.set(tail, at);
    }
    parts = [];
    partBytes = 0;
    return out;
  };
  const latin1 = (b: Uint8Array) => {
    let s = "";
    for (const c of b) s += String.fromCharCode(c);
    return s;
  };
  const isOid = (value: string) => isObjectId(value, objectFormat);
  const limited = (reason: StatusBound) => {
    final = { state: "limited", code: "OUTPUT_LIMIT", reason, branch: { ...branch }, records };
  };

  function header(item: Uint8Array): void {
    // git-status(1): headers come before the entries, and parsers ignore unknown headers.
    if (count > 0 || item.length < 2 || item[1] !== SPACE) throw new Malformed();
    const text = displayPath(item.subarray(2));
    const space = text.indexOf(" ");
    const key = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? "" : text.slice(space + 1);
    if (key === "") throw new Malformed();
    if (!key.startsWith("branch.")) return;
    if (key !== "branch.oid" && key !== "branch.head" && key !== "branch.upstream" && key !== "branch.ab") return;
    if (value === "") throw new Malformed();
    if (key === "branch.oid") {
      if (value !== "(initial)" && !isOid(value)) throw new Malformed();
      branch.oid = value === "(initial)" ? null : value;
      sawOid = true;
    } else if (key === "branch.head") {
      branch.head = value === "(detached)" ? null : value;
      sawHead = true;
    } else if (key === "branch.upstream") {
      branch.upstream = value;
    } else {
      const match = AHEAD_BEHIND.exec(value);
      const ahead = Number(match?.[1]);
      const behind = Number(match?.[2]);
      if (match === null || !Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) throw new Malformed();
      branch.ahead = ahead;
      branch.behind = behind;
    }
  }

  // Checks the fixed fields before any path byte arrives.
  function checkFixed(tokens: string[]): void {
    if (tokens[0] !== kind) throw new Malformed();
    if (kind === "?" || kind === "!") return;
    const [, xy, sub] = tokens;
    const modeCount = kind === "u" ? 4 : 3;
    const modes = tokens.slice(3, 3 + modeCount);
    const oids = tokens.slice(3 + modeCount, 3 + modeCount + (kind === "u" ? 3 : 2));
    const xyValid = kind === "u" ? UNMERGED_XY.has(xy!) : CHANGED_XY.test(xy!) && (kind === "1" || RENAMED_XY.test(xy!));
    if (!xyValid || !SUBMODULE.test(sub!) || !modes.every((m) => MODE.test(m)) || !oids.every(isOid)) throw new Malformed();
    if (kind === "2") {
      const score = SCORE.exec(tokens[8]!);
      if (score === null || Number(score[1]) > 100) throw new Malformed();
    }
  }

  function add(record: StatusRecord): void {
    count++;
    if (onRecord === undefined) records.push(record);
    else onRecord(record);
  }

  function finishPath(path: Uint8Array): void {
    if (path.length === 0) throw new Malformed();
    const p: StatusPath = { bytes: path, display: displayPath(path) };
    const t = fixed;
    phase = "start";
    switch (kind) {
      case "?":
        return add({ kind: "untracked", path: p });
      case "!":
        return add({ kind: "ignored", path: p });
      case "1":
        return add({ kind: "ordinary", xy: t[1]!, submodule: t[2]!, modes: [t[3]!, t[4]!, t[5]!], oids: [t[6]!, t[7]!], path: p });
      case "u":
        return add({ kind: "unmerged", xy: t[1]!, submodule: t[2]!, modes: [t[3]!, t[4]!, t[5]!, t[6]!], oids: [t[7]!, t[8]!, t[9]!], path: p });
      case "2":
        pending = { kind: "rename", xy: t[1]!, submodule: t[2]!, modes: [t[3]!, t[4]!, t[5]!], oids: [t[6]!, t[7]!], score: t[8]!, path: p, originalPath: p };
        phase = "original";
        return;
    }
  }

  function consume(data: Uint8Array): void {
    let at = 0;
    while (at < data.length) {
      switch (phase) {
        case "start": {
          // The record bound applies when one more record starts.
          if (count >= STATUS_LISTING_RECORDS) return limited("STATUS_LISTING_RECORDS");
          const first = data[at]!;
          if (first === 0x23) phase = "header";
          else if (KINDS.has(first)) {
            kind = String.fromCharCode(first) as Kind;
            ({ fields, maxBytes: maxFixed } = fixedRule(kind, oidLength));
            spaces = 0;
            phase = "fixed";
          } else throw new Malformed();
          break;
        }
        case "header": {
          const nul = data.indexOf(NUL, at);
          if (nul < 0) {
            keep(data.subarray(at));
            return;
          }
          header(take(data.subarray(at, nul)));
          phase = "start";
          at = nul + 1;
          break;
        }
        case "fixed": {
          let end = at;
          while (end < data.length && spaces < fields) {
            const c = data[end]!;
            if (c === NUL) throw new Malformed();
            if (c === SPACE) spaces++;
            end++;
            if (partBytes + (end - at) > maxFixed) throw new Malformed();
          }
          if (spaces < fields) {
            keep(data.subarray(at, end));
            return;
          }
          const segment = take(data.subarray(at, end - 1));
          fixed = latin1(segment).split(" ");
          checkFixed(fixed);
          phase = "path";
          at = end;
          break;
        }
        case "path":
        case "original": {
          const nul = data.indexOf(NUL, at);
          if (nul < 0) {
            keep(data.subarray(at));
            return;
          }
          const path = take(data.subarray(at, nul));
          at = nul + 1;
          if (phase === "path") {
            finishPath(path);
            break;
          }
          if (path.length === 0) throw new Malformed();
          add({ ...pending!, originalPath: { bytes: path, display: displayPath(path) } });
          pending = null;
          phase = "start";
          break;
        }
      }
    }
  }

  return {
    push(chunk: Uint8Array): void {
      if (final !== null) return;
      // The byte bound applies before any byte is kept.
      const room = STATUS_LISTING_BYTES - bytes;
      const over = chunk.length > room;
      const data = over ? chunk.subarray(0, room) : chunk;
      bytes += data.length;
      try {
        consume(data);
      } catch (error) {
        if (!(error instanceof Malformed)) throw error;
        final = { state: "failed", code: "MALFORMED_GIT_OUTPUT" };
      }
      if (final === null && over) limited("STATUS_LISTING_BYTES");
      if (final !== null) {
        parts = [];
        partBytes = 0;
        pending = null;
      }
    },
    get limited(): boolean {
      return final?.state === "limited";
    },
    end(): StatusParseResult {
      if (final !== null) return final;
      // An unfinished record means truncated output.
      // `statusArgs` passes `--branch`, so Git always prints both headers.
      if (phase !== "start" || (branchHeaders && (!sawOid || !sawHead))) return (final = { state: "failed", code: "MALFORMED_GIT_OUTPUT" });
      return (final = { state: "complete", branch: { ...branch }, records });
    },
  };
}
