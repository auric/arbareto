// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract Δ4, data-model §6, plan.md D8, and research.md R11: the sub-hunk of selected lines of one retained hunk.
// It takes no patch text from the renderer. The 001 hunk steps apply and verify the result.

import type { LineActionReason } from "../contracts/file-action";
import type { PatchHunk } from "./diff-parser";

// Contract Δ4: `several-hunks` comes only from the renderer.
export type LineRefusal = Exclude<LineActionReason, "several-hunks">;

export type SubHunk = { ok: true; hunk: PatchHunk } | { ok: false; code: "INVALID_REQUEST" } | { ok: false; code: "UNSUPPORTED_COMPARISON"; reason: LineRefusal };

const LF = 0x0a;
const INVALID: SubHunk = { ok: false, code: "INVALID_REQUEST" };
const refuse = (reason: LineRefusal): SubHunk => ({ ok: false, code: "UNSUPPORTED_COMPARISON", reason });
const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

// The lines of `bytes`, each with its LF. `parsePatch` ends every hunk line with LF.
function lines(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const end = bytes.indexOf(LF, at) + 1 || bytes.length;
    out.push(bytes.subarray(at, end));
    at = end;
  }
  return out;
}

// xdiff `xdl_emit_hunk_hdr`: a count of 0 prints the line before the change, and a count of 1 prints no count.
const start = (printed: number, count: number, keptCount: number) => (count === 0 ? printed + 1 : printed) - (keptCount === 0 ? 1 : 0);
const range = (from: number, count: number) => (count === 1 ? `${from}` : `${from},${count}`);
const SPACE = Uint8Array.of(0x20);

// `header` is the file header of the parsed patch. `selected` holds 1-based ordinals of `+` and `-` lines in the hunk body.
// Stage applies the result forward on the index. Unstage applies it with `--reverse`.
export function subHunk(header: Uint8Array, hunk: PatchHunk, direction: "stage" | "unstage", selected: readonly number[]): SubHunk {
  const body = lines(hunk.bytes).slice(1);
  const kind = (ordinal: number) => body[ordinal - 1]?.[0];
  const isChange = (ordinal: number) => kind(ordinal) === 0x2b || kind(ordinal) === 0x2d;
  if (!Array.isArray(selected) || !selected.every((n, i) => Number.isSafeInteger(n) && n >= 1 && n <= body.length && isChange(n) && (i === 0 || n > selected[i - 1]!))) return INVALID;
  // apply.c `parse_single_patch`: a partial deletion needs a modify header. Unstage applies a staged addition in reverse, as a deletion.
  const modes = latin1(header).split("\n");
  if (modes.some((l) => /^deleted file mode /.test(l))) return refuse("deleted-file");
  if (direction === "unstage" && modes.some((l) => /^new file mode /.test(l))) return refuse("new-file");
  if (selected.length === 0) return refuse("context-only");
  const changes = body.filter((_, i) => isChange(i + 1)).length;
  if (selected.length === changes) return { ok: true, hunk };
  // Research.md R21 F25: `apply --cached` joins two lines here with exit 0, and `applyToContent` computes the same blob.
  if (body.some((l) => l[0] === 0x5c)) return refuse("eof-newline");

  // Stage turns an unselected `-` line into context and drops an unselected `+` line. Unstage does the reverse.
  const keep = direction === "stage" ? 0x2d : 0x2b;
  const picked = new Set(selected);
  const kept: Uint8Array[] = [];
  body.forEach((line, i) => {
    if (line[0] === 0x20 || picked.has(i + 1)) kept.push(line);
    else if (line[0] === keep) kept.push(Buffer.concat([SPACE, line.subarray(1)]));
  });
  const oldCount = kept.filter((l) => l[0] !== 0x2b).length;
  const newCount = kept.filter((l) => l[0] !== 0x2d).length;
  const oldStart = start(hunk.oldStart, hunk.oldCount, oldCount);
  const newStart = start(hunk.newStart, hunk.newCount, newCount);
  const bytes = Buffer.concat([new TextEncoder().encode(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@\n`), ...kept]);
  return { ok: true, hunk: { ordinal: hunk.ordinal, oldStart, oldCount, newStart, newCount, digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes } };
}
