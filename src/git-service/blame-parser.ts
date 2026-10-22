// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 plan.md D12 "Parse" and "Checks": git-blame(1) "THE PORCELAIN FORMAT" and "INCREMENTAL OUTPUT". Pure parser of untrusted Git output.
// builtin/blame.c: `emit_one_suspect_detail` prints the commit headers once per commit. `write_filename_info` prints `previous` and `filename`
// for each incremental group, and in porcelain output on the first appearance or for a commit with MORE_THAN_ONE_PATH.
// `emit_porcelain_per_line_details` prints `unblamable`, then `ignored`, for each line. Each porcelain line ends with its TAB content line.

import { unquote } from "./diff-parser";
import { OID_HEX as OID, type ObjectFormat } from "./commands";

const LF = 0x0a;
const TAB = 0x09;
const QUOTE = 0x22;

// One origin: a commit with one `previous` and `filename` pair (blame.h `blame_origin`). Text fields hold Git's raw bytes.
export interface BlameOrigin {
  oid: string;
  author: Uint8Array;
  authorMail: Uint8Array;
  authorTime: number;
  authorTz: string;
  summary: Uint8Array;
  boundary: boolean;
  previous: { oid: string; path: Uint8Array } | null;
  filename: Uint8Array;
}

// One blame entry (blame.h `blame_entry`). `origin` indexes `origins`.
export interface BlameEntry {
  origin: number;
  origStart: number;
  finalStart: number;
  count: number;
  ignored: boolean;
  unblamable: boolean;
}

export interface ParsedBlame {
  origins: BlameOrigin[];
  // In final line order. They cover lines 1 to N exactly once.
  groups: BlameEntry[];
}

type Info = Omit<BlameOrigin, "previous" | "filename">;
const INFO_KEYS = ["author", "author-mail", "author-time", "author-tz", "committer", "committer-mail", "committer-time", "committer-tz", "summary"] as const;
const NUMBER = "([1-9][0-9]{0,8})";
const TIME = /^(?:0|[1-9][0-9]{0,15})$/;
const TZ = /^[+-][0-9]{4}$/;

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
const startsWith = (b: Uint8Array, prefix: string) => b.length >= prefix.length && latin1(b.subarray(0, prefix.length)) === prefix;
const keyOf = (oid: string, previous: BlameOrigin["previous"], filename: Uint8Array) => `${oid}\0${previous === null ? "" : `${previous.oid}\0${latin1(previous.path)}`}\0${latin1(filename)}`;

// quote.c `write_name_quoted`: a path that needs quoting is C-quoted, and a raw path never starts with a quote.
function pathOf(b: Uint8Array): Uint8Array | null {
  if (b.length === 0) return null;
  if (b[0] !== QUOTE) return b;
  const q = unquote(b, 0);
  return q !== null && q.end === b.length && q.value.length > 0 ? q.value : null;
}

// blame.c `find_line_starts`: a last line without LF counts as a line.
export function countLines(content: Uint8Array): number {
  let n = 0;
  for (const b of content) if (b === LF) n++;
  return content.length > 0 && content[content.length - 1] !== LF ? n + 1 : n;
}

// A line-by-line parser. `blamed` is the sum of the counts of the parsed group headers (spec FR-063 progress).
export class BlameStream {
  private readonly header: RegExp;
  private readonly previousLine: RegExp;
  private pending: Uint8Array[] = [];
  private failed = false;
  private readonly infos = new Map<string, Info>();
  // The first origin of each commit. A porcelain group without `filename` belongs to it.
  private readonly firstOrigin = new Map<string, number>();
  private readonly originIndex = new Map<string, number>();
  readonly origins: BlameOrigin[] = [];
  private readonly entries: BlameEntry[] = [];
  blamed = 0;

  // Parse state of the current group. A porcelain TAB content line ends the marks of its line.
  private state: "header" | "info" | "tail" | "marks" = "header";
  private group: { oid: string; origStart: number; finalStart: number; count: number; line: number; marks: { ignored: boolean; unblamable: boolean } | null; lineMarks: { ignored: boolean; unblamable: boolean }; origin: number | null } | null = null;
  private info: Partial<Record<(typeof INFO_KEYS)[number], Uint8Array>> = {};
  private infoAt = 0;
  private previous: BlameOrigin["previous"] = null;

  constructor(
    private readonly mode: "incremental" | "porcelain",
    objectFormat: ObjectFormat,
  ) {
    this.header = new RegExp(`^(${OID[objectFormat]}) ${NUMBER} ${NUMBER}(?: ${NUMBER})?$`);
    this.previousLine = new RegExp(`^previous (${OID[objectFormat]}) `);
  }

  get malformed(): boolean {
    return this.failed;
  }

  push(chunk: Uint8Array): void {
    if (this.failed) return;
    let at = 0;
    for (;;) {
      const lf = chunk.indexOf(LF, at);
      if (lf < 0) break;
      const part = chunk.subarray(at, lf);
      const line = this.pending.length === 0 ? part : Buffer.concat([...this.pending, part]);
      this.pending = [];
      this.line(line);
      if (this.failed) return;
      at = lf + 1;
    }
    if (at < chunk.length) this.pending.push(new Uint8Array(chunk.subarray(at)));
  }

  private fail(): void {
    this.failed = true;
  }

  private line(b: Uint8Array): void {
    // A TAB content line holds file bytes. Only its first byte counts.
    const text = b[0] === TAB ? "" : latin1(b);
    switch (this.state) {
      case "header":
        return this.groupHeader(text);
      case "info":
        return this.infoLine(b);
      case "tail":
        return this.tailLine(b, text);
      case "marks":
        return this.markLine(b, text);
    }
  }

  private groupHeader(text: string): void {
    const m = this.header.exec(text);
    if (m === null) return this.fail();
    const [oid, orig, final, count] = [m[1]!, Number(m[2]), Number(m[3]), m[4] === undefined ? null : Number(m[4])];
    const g = this.group;
    // A porcelain continuation line repeats the header of its entry without the count.
    if (this.mode === "porcelain" && g !== null && g.line < g.count) {
      if (count !== null || oid !== g.oid || orig !== g.origStart + g.line || final !== g.finalStart + g.line) return this.fail();
      g.lineMarks = { ignored: false, unblamable: false };
      this.state = "marks";
      return;
    }
    if (count === null) return this.fail();
    this.group = { oid, origStart: orig, finalStart: final, count, line: 0, marks: null, lineMarks: { ignored: false, unblamable: false }, origin: null };
    this.blamed += count;
    this.previous = null;
    if (this.infos.has(oid)) {
      this.state = "tail";
      return;
    }
    this.info = {};
    this.infoAt = 0;
    this.state = "info";
  }

  private infoLine(b: Uint8Array): void {
    const key = INFO_KEYS[this.infoAt]!;
    if (!startsWith(b, `${key} `)) return this.fail();
    this.info[key] = new Uint8Array(b.subarray(key.length + 1));
    if (++this.infoAt < INFO_KEYS.length) return;
    const time = latin1(this.info["author-time"]!);
    const tz = latin1(this.info["author-tz"]!);
    if (!TIME.test(time) || !TZ.test(tz) || !Number.isSafeInteger(Number(time))) return this.fail();
    this.infos.set(this.group!.oid, { oid: this.group!.oid, author: this.info.author!, authorMail: this.info["author-mail"]!, authorTime: Number(time), authorTz: tz, summary: this.info.summary!, boundary: false });
    this.state = "tail";
  }

  // After the commit headers: `boundary` once, `previous`, then `filename`. A porcelain repeat can go straight to the marks or the content.
  private tailLine(b: Uint8Array, text: string): void {
    const g = this.group!;
    const info = this.infos.get(g.oid)!;
    if (text === "boundary" && this.previous === null && g.origin === null && !this.firstOrigin.has(g.oid) && !info.boundary) {
      info.boundary = true;
      return;
    }
    const prev = this.previousLine.exec(text);
    if (prev !== null && this.previous === null) {
      const path = pathOf(b.subarray(prev[0].length));
      if (path === null) return this.fail();
      this.previous = { oid: prev[1]!, path: new Uint8Array(path) };
      return;
    }
    if (startsWith(b, "filename ")) {
      const filename = pathOf(b.subarray("filename ".length));
      if (filename === null) return this.fail();
      g.origin = this.originOf(info, this.previous, new Uint8Array(filename));
      if (this.mode === "incremental") return this.groupDone();
      this.state = "marks";
      return;
    }
    // Porcelain only: a commit with one path prints `previous` and `filename` on its first appearance only.
    const first = this.firstOrigin.get(g.oid);
    if (this.mode === "incremental" || this.previous !== null || first === undefined) return this.fail();
    g.origin = first;
    this.state = "marks";
    this.markLine(b, text);
  }

  private markLine(b: Uint8Array, text: string): void {
    const marks = this.group!.lineMarks;
    if (text === "unblamable" && !marks.unblamable && !marks.ignored) {
      marks.unblamable = true;
      return;
    }
    if (text === "ignored" && !marks.ignored) {
      marks.ignored = true;
      return;
    }
    if (b[0] !== TAB) return this.fail();
    this.lineDone();
  }

  private lineDone(): void {
    const g = this.group!;
    // Git takes the marks from the entry, so every line of one entry carries the same marks.
    if (g.marks === null) g.marks = g.lineMarks;
    else if (g.marks.ignored !== g.lineMarks.ignored || g.marks.unblamable !== g.lineMarks.unblamable) return this.fail();
    if (++g.line === g.count) return this.groupDone();
    this.state = "header";
  }

  private groupDone(): void {
    const g = this.group!;
    this.entries.push({ origin: g.origin!, origStart: g.origStart, finalStart: g.finalStart, count: g.count, ignored: g.marks?.ignored ?? false, unblamable: g.marks?.unblamable ?? false });
    if (this.mode === "incremental") this.group = null;
    else g.line = g.count;
    this.state = "header";
  }

  private originOf(info: Info, previous: BlameOrigin["previous"], filename: Uint8Array): number {
    const key = keyOf(info.oid, previous, filename);
    const found = this.originIndex.get(key);
    if (found !== undefined) return found;
    this.origins.push({ ...info, previous, filename });
    const index = this.origins.length - 1;
    this.originIndex.set(key, index);
    if (!this.firstOrigin.has(info.oid)) this.firstOrigin.set(info.oid, index);
    return index;
  }

  // Plan.md D12 "Checks": the groups cover lines 1 to N exactly once. Null for any other output.
  finish(lines: number): ParsedBlame | null {
    if (this.failed || this.pending.length > 0 || this.state !== "header") return null;
    const groups = this.entries.toSorted((a, b) => a.finalStart - b.finalStart);
    let next = 1;
    for (const g of groups) {
      if (g.finalStart !== next) return null;
      next += g.count;
    }
    if (next !== lines + 1) return null;
    return { origins: this.origins, groups };
  }
}

export function parseBlame(out: Uint8Array, mode: "incremental" | "porcelain", objectFormat: ObjectFormat, lines: number): ParsedBlame | null {
  const stream = new BlameStream(mode, objectFormat);
  stream.push(out);
  return stream.finish(lines);
}
