// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §3 "HistoryPage result" and §5 history bounds. Pure parsers of untrusted Git output.

import { HISTORY_BODY_BYTES } from "../contracts/envelope";
import { HISTORY_COMMIT_OBJECT_BYTES, HISTORY_PARENTS_PER_COMMIT, HISTORY_PARENTS_PER_PAGE, HISTORY_STREAM_BYTES, HISTORY_STREAM_ROWS } from "../contracts/limits";
import type { ObjectFormat } from "./commands";
import type { Completeness, LimitName } from "./snapshot";

const OID_HEX: Record<ObjectFormat, RegExp> = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
};

const LF = 0x0a;
const NUL = 0x00;

const COMPLETE: Completeness = { state: "complete" };
// Research R2: an incomplete or malformed record is never success. Contract §9 permits `limited` only for a §5 bound or a missing object.
const MALFORMED: Completeness = { state: "failed", code: "MALFORMED_GIT_OUTPUT" };
const OBJECT_MISSING: Completeness = { state: "limited", code: "OBJECT_MISSING" };
const limited = (reason: LimitName): Completeness => ({ state: "limited", code: "OUTPUT_LIMIT", reason });

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");

// Git `ctype.c` `sane_ctype`: `isspace` holds TAB, LF, CR, and SPACE only.
export const isSpace = (byte: number) => byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;

// Git `pretty.c` `get_one_line`: a line includes its LF. The last line can have none.
const lineEnd = (text: Uint8Array, at: number) => {
  const lf = text.indexOf(LF, at);
  return lf === -1 ? text.length : lf + 1;
};
// Git `pretty.c` `is_blank_line`: only white space.
const isBlank = (text: Uint8Array, at: number, end: number) => text.subarray(at, end).every(isSpace);
// Git `pretty.c` `skip_blank_lines`.
function skipBlankLines(text: Uint8Array, at: number): number {
  while (at < text.length) {
    const end = lineEnd(text, at);
    if (!isBlank(text, at, end)) break;
    at = end;
  }
  return at;
}

// Git `pretty.c` `parse_commit_message` (`%b`): skip blank lines, then the subject paragraph with its ending blank line (`format_subject`), then blank lines.
export function messageBody(message: Uint8Array): Uint8Array {
  let at = skipBlankLines(message, 0);
  while (at < message.length) {
    const end = lineEnd(message, at);
    const blank = isBlank(message, at, end);
    at = end;
    if (blank) break;
  }
  return message.subarray(skipBlankLines(message, at));
}

// Contract §5 "History message body": WHATWG `encodeInto` writes only whole characters, so `read` ends at a character boundary.
const bodyBuffer = new Uint8Array(HISTORY_BODY_BYTES);
export function boundedBody(text: string): { body: string; bodyCut: boolean } {
  const { read } = new TextEncoder().encodeInto(text, bodyBuffer);
  return read === text.length ? { body: text, bodyCut: false } : { body: text.slice(0, read), bodyCut: true };
}

export interface TraversalRow {
  oid: string;
  // Effective parents in Git order. A shallow commit has none.
  parents: string[];
}

export interface Traversal {
  rows: TraversalRow[];
  completeness: Completeness;
}

// Input: the stdout of `revListArgs` (`rev-list --parents`): one `<oid>[ <parent>]*` line per row, each ended by LF.
// Contract §5: a bound keeps the rows before the first row that passes it. The first reached bound wins.
export function parseTraversal(stdout: Uint8Array, objectFormat: ObjectFormat): Traversal {
  const hex = OID_HEX[objectFormat];
  const rows: TraversalRow[] = [];
  const rowIndex = new Set<string>();
  let references = 0;
  let at = 0;
  while (at < stdout.length) {
    if (rows.length >= HISTORY_STREAM_ROWS) return { rows, completeness: limited("HISTORY_STREAM_ROWS") };
    const eol = stdout.indexOf(LF, at);
    // Contract §5 "History traversal stream": no byte after the bound is read.
    if ((eol === -1 ? stdout.length : eol + 1) > HISTORY_STREAM_BYTES) return { rows, completeness: limited("HISTORY_STREAM_BYTES") };
    if (eol === -1) return { rows, completeness: MALFORMED };
    const fields = latin1(stdout.subarray(at, eol)).split(" ");
    if (fields.length - 1 > HISTORY_PARENTS_PER_COMMIT) return { rows, completeness: limited("HISTORY_PARENTS_PER_COMMIT") };
    // Contract §3: OID lengths follow the repository object format.
    if (!fields.every((field) => hex.test(field))) return { rows, completeness: MALFORMED };
    const [oid, ...parents] = fields as [string, ...string[]];
    if (references + parents.length > HISTORY_PARENTS_PER_PAGE) return { rows, completeness: limited("HISTORY_PARENTS_PER_PAGE") };
    // Contract §3 "Reject duplicate rows … and invalid in-page parent ordering". Data-model §4 "Row order": child before parent.
    // So a parent must not be this row or an earlier row.
    if (rowIndex.has(oid) || parents.some((parent) => parent === oid || rowIndex.has(parent))) return { rows, completeness: MALFORMED };
    references += parents.length;
    rowIndex.add(oid);
    rows.push({ oid, parents });
    at = eol + 1;
  }
  return { rows, completeness: COMPLETE };
}

export interface CommitObject {
  oid: string;
  size: number;
  content: Uint8Array;
  // The `tree` header value.
  tree: string;
  // The raw `parent` headers. They include parents that a shallow boundary hides from the traversal.
  parents: string[];
  // The `encoding` header value, or null without the header.
  encoding: string | null;
}

export interface CommitObjects {
  objects: CommitObject[];
  completeness: Completeness;
}

// gitdoc git-cat-file "BATCH OUTPUT": `<oid> SP <type> SP <size>`, or `<oid> SP missing`. The size is decimal.
const FOUND = /^([^ ]+) ([^ ]+) (0|[1-9][0-9]*)$/;
const MISSING = /^([^ ]+) missing$/;
// The longest valid header is `<64-hex oid> commit <size>`. A 64-bit size has at most 20 decimal digits.
export const HEADER_BYTES = 64 + " commit ".length + 20;

// Upstream commit.c `parse_commit_buffer`: the header starts with one `tree` line, then the `parent` lines follow directly.
// Upstream commit.c `get_header`: a header line ends at LF, and the header block ends at the first empty line.
export function readHeaders(content: Uint8Array, hex: RegExp): { tree: string; parents: string[]; encoding: string | null } | null {
  const blank = Buffer.from(content.buffer, content.byteOffset, content.byteLength).indexOf("\n\n");
  const lines = latin1(content.subarray(0, blank === -1 ? content.length : blank)).split("\n");
  const tree = lines[0]!;
  if (!tree.startsWith("tree ") || !hex.test(tree.slice("tree ".length))) return null;
  const parents: string[] = [];
  let i = 1;
  for (; i < lines.length && lines[i]!.startsWith("parent "); i++) {
    const parent = lines[i]!.slice("parent ".length);
    if (!hex.test(parent)) return null;
    parents.push(parent);
  }
  const encoding = lines.slice(i).find((line) => line.startsWith("encoding "));
  return { tree: tree.slice("tree ".length), parents, encoding: encoding === undefined ? null : new TextDecoder().decode(Buffer.from(encoding.slice("encoding ".length), "latin1")) };
}

// Input: the stdout of `batchCommandArgs` (`cat-file --batch-command -Z`) for one `contents <oid>` command per `requested` OID.
// With `-Z`, NUL ends each header and each content (gitdoc git-cat-file "-Z"). Answers come in request order.
export function parseCommitObjects(stdout: Uint8Array, requested: readonly string[], objectFormat: ObjectFormat): CommitObjects {
  const hex = OID_HEX[objectFormat];
  const objects: CommitObject[] = [];
  let references = 0;
  let at = 0;
  for (const oid of requested) {
    const capped = stdout.subarray(at, at + HEADER_BYTES + 1).indexOf(NUL);
    if (capped === -1) return { objects, completeness: MALFORMED };
    const end = at + capped;
    const header = latin1(stdout.subarray(at, end));
    const missing = MISSING.exec(header);
    if (missing !== null) {
      if (missing[1] !== oid || !hex.test(oid)) return { objects, completeness: MALFORMED };
      // Contract §7 "Missing objects": the read keeps its bounded data and ends `limited`.
      return { objects, completeness: OBJECT_MISSING };
    }
    const found = FOUND.exec(header);
    if (found === null || found[1] !== oid || !hex.test(oid) || found[2] !== "commit") return { objects, completeness: MALFORMED };
    const size = Number(found[3]);
    // Research R2: bound commit objects before reading their content.
    if (size > HISTORY_COMMIT_OBJECT_BYTES) return { objects, completeness: limited("HISTORY_COMMIT_OBJECT_BYTES") };
    const start = end + 1;
    if (start + size >= stdout.length || stdout[start + size] !== NUL) return { objects, completeness: MALFORMED };
    const content = new Uint8Array(stdout.subarray(start, start + size));
    const headers = readHeaders(content, hex);
    if (headers === null) return { objects, completeness: MALFORMED };
    if (headers.parents.length > HISTORY_PARENTS_PER_COMMIT) return { objects, completeness: limited("HISTORY_PARENTS_PER_COMMIT") };
    if (references + headers.parents.length > HISTORY_PARENTS_PER_PAGE) return { objects, completeness: limited("HISTORY_PARENTS_PER_PAGE") };
    references += headers.parents.length;
    objects.push({ oid, size, content, tree: headers.tree, parents: headers.parents, encoding: headers.encoding });
    at = start + size + 1;
  }
  if (at !== stdout.length) return { objects, completeness: MALFORMED };
  return { objects, completeness: COMPLETE };
}
