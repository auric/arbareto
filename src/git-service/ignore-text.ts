// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 plan.md D8 and D10, data-model §6: the codec of `.gitignore` and `info/exclude` (spec FR-036, FR-037, FR-042).
// A `textarea` value normalizes CR and CRLF to LF (HTML "textarea" API value), so Save writes one line-ending form for all lines.
// Git v2.56.0 dir.c:1250-1251 drops one CR before each LF, so LF and CRLF lines give the same patterns.

export type LineEnding = "lf" | "crlf" | "none";
export type IgnoreForm = { lineEnding: LineEnding; bom: boolean };
export type Decoded =
  | ({ ok: true; text: string } & IgnoreForm)
  | { ok: true; text: string; lineEnding: "mixed"; lineCounts: { lf: number; crlf: number }; bom: boolean };
export type DecodedIgnore = Decoded | { ok: false; reason: "ignore-not-utf8" | "ignore-nul" | "ignore-lone-cr" };

const CR = 0x0d;
const LF = 0x0a;
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
// `ignoreBOM` keeps a U+FEFF after the first bytes in the text. The leading BOM is cut before the decode.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const hasBom = (bytes: Uint8Array) => bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2];

// The checks run in the plan.md D8 order: strict UTF-8, then NUL, then the line endings.
export function decodeIgnore(bytes: Uint8Array): DecodedIgnore {
  const bom = hasBom(bytes);
  const body = bom ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    return { ok: false, reason: "ignore-not-utf8" };
  }
  if (body.includes(0)) return { ok: false, reason: "ignore-nul" };
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === LF) lf++;
    else if (body[i] === CR) {
      // A last CR is dropped by Git too (dir.c:1198 adds an LF), but no Save form writes it again.
      if (body[i + 1] !== LF) return { ok: false, reason: "ignore-lone-cr" };
      crlf++;
      i++;
    }
  }
  const lfText = crlf > 0 ? text.replaceAll("\r\n", "\n") : text;
  if (lf > 0 && crlf > 0) return { ok: true, text: lfText, lineEnding: "mixed", lineCounts: { lf, crlf }, bom };
  const lineEnding: LineEnding = crlf > 0 ? "crlf" : lf > 0 ? "lf" : "none";
  return { ok: true, text: lfText, lineEnding, bom };
}

// Plan.md D10: the request form for all lines, else the file form. A mixed file without a request form has none.
export function saveForm(decoded: Decoded, chosen: "lf" | "crlf" | undefined): IgnoreForm | null {
  if (chosen !== undefined) return { lineEnding: chosen, bom: decoded.bom };
  return decoded.lineEnding === "mixed" ? null : { lineEnding: decoded.lineEnding, bom: decoded.bom };
}

// Plan.md D10: the BOM when `bom`, then the text with each LF as CRLF for `crlf`. `lf` and `none` keep LF.
// `text` is the LF form of the editor. A CR in it stays unchanged.
export function encodeIgnore(text: string | Uint8Array, form: IgnoreForm): Uint8Array {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const breaks = form.lineEnding === "crlf" ? bytes.reduce((n, b) => n + (b === LF ? 1 : 0), 0) : 0;
  const out = new Uint8Array((form.bom ? 3 : 0) + bytes.length + breaks);
  let at = 0;
  if (form.bom) {
    out.set(BOM);
    at = 3;
  }
  if (breaks === 0) {
    out.set(bytes, at);
    return out;
  }
  for (const b of bytes) {
    if (b === LF) out[at++] = CR;
    out[at++] = b;
  }
  return out;
}
