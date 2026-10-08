// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T102: a strict parser of one canonical single-file patch from the T101 patch reads. Pure parser of untrusted Git output.
// Contract §5 "Canonical diff" and data-model §5 "Hunk". Any form outside this grammar gives MALFORMED_GIT_OUTPUT.

import { CANONICAL_DIFF_BYTES, CANONICAL_DIFF_LINES } from "../contracts/limits";
import type { Completeness } from "./snapshot";

const LF = 0x0a;
const SPACE = 0x20;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

const MALFORMED = { ok: false as const, completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } as Completeness };
const limited = (reason: "CANONICAL_DIFF_LINES" | "CANONICAL_DIFF_BYTES") => ({ ok: false as const, completeness: { state: "limited", code: "OUTPUT_LIMIT", reason } as Completeness });

export interface PatchHunk {
  ordinal: number;
  // The printed ranges. A count of 0 prints the line before the change as its start (xdiff `xdl_emit_hunk_hdr`).
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  // SHA-256 hex of `bytes`.
  digest: string;
  // The service-owned application data: the hunk header line through its last body or marker line, each with its LF. A view into the input.
  bytes: Uint8Array;
}

export interface ParsedPatch {
  // The file header from `diff --git` up to the first hunk. A view into the input. Empty for an empty diff.
  header: Uint8Array;
  hunks: PatchHunk[];
  // Contract §5: every line counts once, file and hunk headers included.
  lines: number;
}

export type PatchResult = { ok: true; patch: ParsedPatch } | { ok: false; completeness: Completeness };

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

const PREFIX_A = Uint8Array.of(0x61, 0x2f);
const PREFIX_B = Uint8Array.of(0x62, 0x2f);
const DEV_NULL = new TextEncoder().encode("/dev/null");
const MODE = "([0-7]{6})";
const ABBREV = "([0-9a-f]{4,64})";
const NEW_FILE = new RegExp(`^new file mode ${MODE}$`);
const DELETED_FILE = new RegExp(`^deleted file mode ${MODE}$`);
const OLD_MODE = new RegExp(`^old mode ${MODE}$`);
const NEW_MODE = new RegExp(`^new mode ${MODE}$`);
const INDEX = new RegExp(`^index ${ABBREV}\\.\\.${ABBREV}(?: ${MODE})?$`);
const NUMBER = "(0|[1-9][0-9]{0,8})";
// A function heading follows a space. It is file content, so it can hold any byte but LF.
const HUNK = new RegExp(`^@@ -${NUMBER}(?:,${NUMBER})? \\+${NUMBER}(?:,${NUMBER})? @@(?: [^]+)?$`);
const ZEROS = /^0+$/;

// quote.c `unquote_c_style`: letter escapes, `\\`, `\"`, and three octal digits with a first digit of 0 to 3.
const ESCAPES: Record<number, number> = { 0x61: 0x07, 0x62: 0x08, 0x66: 0x0c, 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x76: 0x0b, 0x5c: 0x5c, 0x22: 0x22 };
function unquote(b: Uint8Array, at: number): { value: Uint8Array; end: number } | null {
  if (b[at] !== QUOTE) return null;
  const out: number[] = [];
  for (let i = at + 1; i < b.length; i++) {
    const c = b[i]!;
    if (c === QUOTE) return { value: Uint8Array.from(out), end: i + 1 };
    if (c !== BACKSLASH) {
      out.push(c);
      continue;
    }
    const e = b[++i];
    if (e === undefined) return null;
    if (Object.hasOwn(ESCAPES, e)) {
      out.push(ESCAPES[e]!);
      continue;
    }
    const d = [e, b[i + 1], b[i + 2]];
    if (e < 0x30 || e > 0x33 || d.some((x) => x === undefined || x < 0x30 || x > 0x37)) return null;
    out.push(((e - 0x30) << 6) | ((d[1]! - 0x30) << 3) | (d[2]! - 0x30));
    i += 2;
  }
  return null;
}

// The `diff --git` names. Git prints both as `quote_two(prefix, path)`, so both are raw or both are C-quoted.
// Returns the two printed labels, which the `---` and `+++` lines repeat.
function gitNames(rest: Uint8Array, path: Uint8Array): [Uint8Array, Uint8Array] | null {
  const a = concat(PREFIX_A, path);
  const b = concat(PREFIX_B, path);
  if (sameBytes(rest, concat(concat(a, Uint8Array.of(SPACE)), b))) return [a, b];
  const first = unquote(rest, 0);
  if (!first || rest[first.end] !== SPACE) return null;
  const second = unquote(rest, first.end + 1);
  if (!second || second.end !== rest.length || !sameBytes(first.value, a) || !sameBytes(second.value, b)) return null;
  return [rest.subarray(0, first.end), rest.subarray(first.end + 1)];
}

// diff.c `DIFF_SYMBOL_FILEPAIR_MINUS` and `_PLUS`: the label, and a TAB when the label holds a space.
function fileLine(marker: string, label: Uint8Array): Uint8Array {
  const line = concat(new TextEncoder().encode(`${marker} `), label);
  return label.includes(SPACE) ? concat(line, Uint8Array.of(0x09)) : line;
}

// Contract §5: line N starts after the (N-1)th LF. The empty segment after a final LF is no line. The first reached bound wins.
function checkBounds(b: Uint8Array): { lines: number; limit?: "CANONICAL_DIFF_LINES" | "CANONICAL_DIFF_BYTES" } {
  let lines = 0;
  for (let at = 0; at < b.length; ) {
    if (++lines > CANONICAL_DIFF_LINES) return { lines, limit: at < CANONICAL_DIFF_BYTES ? "CANONICAL_DIFF_LINES" : "CANONICAL_DIFF_BYTES" };
    const lf = b.indexOf(LF, at);
    at = lf < 0 ? b.length : lf + 1;
  }
  return b.length > CANONICAL_DIFF_BYTES ? { lines, limit: "CANONICAL_DIFF_BYTES" } : { lines };
}

export function parsePatch(raw: Uint8Array, path: Uint8Array): PatchResult {
  const bounds = checkBounds(raw);
  if (bounds.limit) return limited(bounds.limit);
  if (raw.length === 0) return { ok: true, patch: { header: raw, hunks: [], lines: 0 } };
  if (raw[raw.length - 1] !== LF || path.length === 0) return MALFORMED;

  // Line start offsets. Each line ends with LF, which `line()` excludes.
  const starts: number[] = [];
  for (let at = 0; at < raw.length; at = raw.indexOf(LF, at) + 1) starts.push(at);
  starts.push(raw.length);
  const line = (n: number) => raw.subarray(starts[n]!, starts[n + 1]! - 1);
  const text = (n: number) => latin1(line(n));
  const count = starts.length - 1;
  let n = 0;

  // diff.c `builtin_diff`: `diff --git`, the mode lines, then the `index` line of `fill_metainfo`.
  const gitLine = line(n++);
  const head = new TextEncoder().encode("diff --git ");
  if (!sameBytes(gitLine.subarray(0, head.length), head)) return MALFORMED;
  const names = gitNames(gitLine.subarray(head.length), path);
  if (!names) return MALFORMED;
  let kind: "plain" | "new" | "deleted" | "mode" = "plain";
  let m: RegExpExecArray | null;
  if (n < count && NEW_FILE.test(text(n))) {
    kind = "new";
    n++;
  } else if (n < count && DELETED_FILE.test(text(n))) {
    kind = "deleted";
    n++;
  } else if (n + 1 < count && (m = OLD_MODE.exec(text(n)))) {
    const next = NEW_MODE.exec(text(n + 1));
    if (!next || next[1] === m[1]) return MALFORMED;
    kind = "mode";
    n += 2;
  }
  // The `index` line carries the mode only when both modes are equal (diff.c `fill_metainfo`).
  if (n < count && (m = INDEX.exec(text(n)))) {
    if ((m[3] !== undefined) !== (kind === "plain")) return MALFORMED;
    if ((kind === "new" && !ZEROS.test(m[1]!)) || (kind === "deleted" && !ZEROS.test(m[2]!))) return MALFORMED;
    n++;
  } else if (kind !== "mode") {
    return MALFORMED;
  }
  if (n === count) return kind === "plain" ? MALFORMED : { ok: true, patch: { header: raw, hunks: [], lines: bounds.lines } };

  if (n + 1 >= count) return MALFORMED;
  const oldLabel = kind === "new" ? DEV_NULL : names[0];
  const newLabel = kind === "deleted" ? DEV_NULL : names[1];
  if (!sameBytes(line(n), fileLine("---", oldLabel)) || !sameBytes(line(n + 1), fileLine("+++", newLabel))) return MALFORMED;
  n += 2;
  const header = raw.subarray(0, starts[n]);

  const hunks: PatchHunk[] = [];
  let delta = 0;
  let oldEnd = 1;
  let ended = false;
  while (n < count) {
    // apply.c `adjust_incomplete`: a marker ends its side, so no later line or hunk may follow on that side.
    if (ended) return MALFORMED;
    const h = HUNK.exec(text(n));
    if (!h) return MALFORMED;
    // xdiff `xdl_emit_hunk_hdr` omits a count of 1 and prints every other count.
    if (h[2] === "1" || h[4] === "1") return MALFORMED;
    const [oldStart, oldCount, newStart, newCount] = [h[1], h[2] ?? "1", h[3], h[4] ?? "1"].map(Number) as [number, number, number, number];
    const oldFirst = oldCount === 0 ? oldStart + 1 : oldStart;
    const newFirst = newCount === 0 ? newStart + 1 : newStart;
    if (oldFirst < oldEnd || newFirst - oldFirst !== delta) return MALFORMED;
    if ((kind === "new" && (oldStart !== 0 || oldCount !== 0)) || (kind === "deleted" && (newStart !== 0 || newCount !== 0))) return MALFORMED;
    const first = n++;
    let oldLeft = oldCount;
    let newLeft = newCount;
    let oldEnded = false;
    let newEnded = false;
    while (oldLeft > 0 || newLeft > 0) {
      if (n === count) return MALFORMED;
      const c = raw[starts[n]!];
      const old = c === SPACE || c === 0x2d;
      const neu = c === SPACE || c === 0x2b;
      if ((!old && !neu) || (old && (oldLeft === 0 || oldEnded)) || (neu && (newLeft === 0 || newEnded))) return MALFORMED;
      if (old) oldLeft--;
      if (neu) newLeft--;
      n++;
      // apply.c `adjust_incomplete`: the marker text is translated, so only `\ ` and a length of at least 12 with its LF are fixed.
      if (n < count && raw[starts[n]!] === BACKSLASH && raw[starts[n]! + 1] === SPACE && starts[n + 1]! - starts[n]! >= 12) {
        oldEnded ||= old;
        newEnded ||= neu;
        n++;
      }
    }
    ended = oldEnded || newEnded;
    const bytes = raw.subarray(starts[first]!, starts[n]!);
    hunks.push({ ordinal: hunks.length, oldStart, oldCount, newStart, newCount, digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes });
    delta += newCount - oldCount;
    oldEnd = oldFirst + oldCount;
  }
  if ((kind === "new" || kind === "deleted") && hunks.length !== 1) return MALFORMED;
  return { ok: true, patch: { header, hunks, lines: bounds.lines } };
}

export type NumstatResult = { ok: true; binary: boolean } | { ok: false; completeness: Completeness };

const COUNTS = /^(?:-\t-|(?:0|[1-9][0-9]*)\t(?:0|[1-9][0-9]*))\t/;

// git-diff(1) "Other diff formats", `--numstat` with `-z`: added, TAB, deleted, TAB, then `<path> NUL`.
// A two-path record holds `NUL <preimage> NUL <postimage> NUL` in place of the path. `from` names the expected preimage, or null for one path.
// `-z` writes paths unquoted (diff.c `show_numstat`). An empty output has no change, so it has no binary side.
export function parseNumstat(stdout: Uint8Array, path: Uint8Array, from: Uint8Array | null): NumstatResult {
  if (stdout.length === 0) return { ok: true, binary: false };
  const counts = COUNTS.exec(latin1(stdout.subarray(0, 24)));
  if (!counts) return MALFORMED;
  const names = from === null ? path : concat(concat(concat(Uint8Array.of(0), from), Uint8Array.of(0)), path);
  if (!sameBytes(stdout.subarray(counts[0].length), concat(names, Uint8Array.of(0)))) return MALFORMED;
  return { ok: true, binary: counts[0][0] === "-" };
}
