// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 data-model §6 and research.md R5: the new bytes of a line revert, and the blob ID of its proof.
// Pure functions on bytes. The `hash-object --path` proof in `revert.ts` decides every result of the ending rule.

import type { ObjectFormat } from "./commands";
import type { PatchHunk } from "./diff-parser";

const LF = 0x0a;
const CR = 0x0d;
const BACKSLASH = 0x5c;
const CRLF = Uint8Array.of(CR, LF);
const LF_ONLY = Uint8Array.of(LF);

// The lines of `bytes`, each with its own ending: LF, CRLF, or none for the last line.
function lines(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const end = bytes.indexOf(LF, at) + 1 || bytes.length;
    out.push(bytes.subarray(at, end));
    at = end;
  }
  return out;
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
const endsCrlf = (line: Uint8Array) => line.length >= 2 && line[line.length - 2] === CR && line[line.length - 1] === LF;
// Research.md R5: Git's check-in conversion maps each working line to one line, and it only drops a CR before LF (Git `convert.c` `crlf_to_git`).
const matches = (working: Uint8Array, comparison: Uint8Array) => same(working, comparison) || (endsCrlf(working) && same(Buffer.concat([working.subarray(0, -2), LF_ONLY]), comparison));

// Data-model §6 step 3. `ended` is false for a comparison line before Git's "\ No newline at end of file" marker.
function restored(text: Uint8Array, ended: boolean, eol: string): Uint8Array {
  if (!ended || (eol !== "crlf" && eol !== "lf")) return text;
  const body = text.subarray(0, text.length - (endsCrlf(text) ? 2 : 1));
  return Buffer.concat([body, eol === "crlf" ? CRLF : LF_ONLY]);
}

// Data-model §6: `hunk` is the partial patch of the `unstage` rule, so it stands against the working side, and the revert applies it reversed.
// `eol` is the `ls-files --eol` `w/` value of the path. "stale": the working bytes no longer hold the context or the added lines of `hunk`.
export function reverseLines(working: Uint8Array, hunk: PatchHunk, eol: string): Uint8Array | "stale" {
  // `parsePatch` ends every hunk line with LF. A `\` line marks the line before it as one without a final LF (gitformat-diff).
  const body: { kind: number; text: Uint8Array; ended: boolean }[] = [];
  for (const line of lines(hunk.bytes).slice(1)) {
    const last = body.at(-1);
    if (line[0] === BACKSLASH && last !== undefined) {
      last.text = last.text.subarray(0, -1);
      last.ended = false;
    } else body.push({ kind: line[0]!, text: line.subarray(1), ended: true });
  }
  const own = lines(working);
  // xdiff `xdl_emit_hunk_hdr`: a count of 0 prints the line before the change as its start.
  const at = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
  if (at > own.length) return "stale";
  const out = own.slice(0, at);
  let next = at;
  for (const line of body) {
    if (line.kind === 0x2d) {
      out.push(restored(line.text, line.ended, eol));
      continue;
    }
    const raw = own[next++];
    if (raw === undefined || !matches(raw, line.text)) return "stale";
    // An added line goes. A context line keeps its raw bytes.
    if (line.kind === 0x20) out.push(raw);
  }
  out.push(...own.slice(next));
  return Buffer.concat(out);
}

// gitformat-object: a blob ID is the object format hash of `blob SP <size> NUL <content>`.
export function blobId(content: Uint8Array, format: ObjectFormat): string {
  return new Bun.CryptoHasher(format).update(`blob ${content.length}\0`).update(content).digest("hex");
}
