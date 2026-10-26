// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T031: the ignore file codec of `src/git-service/ignore-text.ts` (feature 005 plan.md D8 and D10, spec FR-036, FR-037, FR-042).

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/ignore-text.ts", import.meta.dir);
const { decodeIgnore, encodeIgnore, saveForm } = await import("../../src/git-service/ignore-text");

const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p) : Buffer.from(p))));
const BOM = [0xef, 0xbb, 0xbf];

describe("decodeIgnore (plan.md D8)", () => {
  test("a leading EF BB BF sets bom and leaves the text without it; a later U+FEFF stays in the text", () => {
    expect(decodeIgnore(bytes(BOM, "*.log\n"))).toEqual({ ok: true, text: "*.log\n", lineEnding: "lf", bom: true });
    expect(decodeIgnore(bytes(BOM))).toEqual({ ok: true, text: "", lineEnding: "none", bom: true });
    expect(decodeIgnore(bytes("a\n", BOM, "b\n"))).toEqual({ ok: true, text: "a\n\u{feff}b\n", lineEnding: "lf", bom: false });
  });

  test("no CR gives lf, every LF after a CR and no other CR gives crlf, no line break gives none", () => {
    expect(decodeIgnore(bytes("*.log\n/out/\n"))).toEqual({ ok: true, text: "*.log\n/out/\n", lineEnding: "lf", bom: false });
    expect(decodeIgnore(bytes("*.log\r\n/out/\r\n"))).toEqual({ ok: true, text: "*.log\n/out/\n", lineEnding: "crlf", bom: false });
    expect(decodeIgnore(bytes("*.log"))).toEqual({ ok: true, text: "*.log", lineEnding: "none", bom: false });
    expect(decodeIgnore(bytes(""))).toEqual({ ok: true, text: "", lineEnding: "none", bom: false });
    expect(decodeIgnore(bytes("\r\n"))).toEqual({ ok: true, text: "\n", lineEnding: "crlf", bom: false });
    expect(decodeIgnore(bytes("a\r\nb"))).toEqual({ ok: true, text: "a\nb", lineEnding: "crlf", bom: false });
  });

  test("LF lines and CRLF lines give mixed with the count of each form; the text has LF only", () => {
    expect(decodeIgnore(bytes("a\nb\r\n"))).toEqual({ ok: true, text: "a\nb\n", lineEnding: "mixed", lineCounts: { lf: 1, crlf: 1 }, bom: false });
    expect(decodeIgnore(bytes(BOM, "a\r\nb\nc\r\nd"))).toEqual({ ok: true, text: "a\nb\nc\nd", lineEnding: "mixed", lineCounts: { lf: 1, crlf: 2 }, bom: true });
  });

  test("a CR that no LF follows gives ignore-lone-cr, inside a line and before a CRLF", () => {
    for (const text of ["a\rb", "a\r\r\n", "a\nb\rc\r\n"]) expect({ text, decoded: decodeIgnore(bytes(text)) }).toEqual({ text, decoded: { ok: false, reason: "ignore-lone-cr" } });
  });

  test("a CR as the last byte gives ignore-lone-cr: Git adds an LF there (dir.c:1198), but no Save form writes the CR again", () => {
    for (const text of ["a\r", "\r", "a\nb\r"]) expect({ text, decoded: decodeIgnore(bytes(text)) }).toEqual({ text, decoded: { ok: false, reason: "ignore-lone-cr" } });
  });

  test("the bytes must be strict UTF-8 without NUL; invalid UTF-8 comes before NUL, and NUL before the line endings", () => {
    expect(decodeIgnore(bytes("*.log\n", [0xff], "\n"))).toEqual({ ok: false, reason: "ignore-not-utf8" });
    expect(decodeIgnore(bytes([0xc0, 0xaf]))).toEqual({ ok: false, reason: "ignore-not-utf8" });
    expect(decodeIgnore(bytes([0xed, 0xa0, 0x80]))).toEqual({ ok: false, reason: "ignore-not-utf8" });
    expect(decodeIgnore(bytes("*.log\n#", [0x00], "\n"))).toEqual({ ok: false, reason: "ignore-nul" });
    expect(decodeIgnore(bytes([0x00, 0xff]))).toEqual({ ok: false, reason: "ignore-not-utf8" });
    expect(decodeIgnore(bytes("a\r\nb\n", [0x00]))).toEqual({ ok: false, reason: "ignore-nul" });
    // A BOM alone is no UTF-8 fault: the rest must be strict UTF-8.
    expect(decodeIgnore(bytes(BOM, [0xff]))).toEqual({ ok: false, reason: "ignore-not-utf8" });
  });
});

describe("encodeIgnore (plan.md D10)", () => {
  test("the BOM when bom, CRLF for crlf, and LF for lf and none", () => {
    expect(encodeIgnore("*.log\n/out/\n", { lineEnding: "crlf", bom: false })).toEqual(new Uint8Array(bytes("*.log\r\n/out/\r\n")));
    expect(encodeIgnore("*.log\n", { lineEnding: "lf", bom: true })).toEqual(new Uint8Array(bytes(BOM, "*.log\n")));
    expect(encodeIgnore("*.log\n/x\n", { lineEnding: "none", bom: false })).toEqual(new Uint8Array(bytes("*.log\n/x\n")));
    expect(encodeIgnore("", { lineEnding: "crlf", bom: true })).toEqual(new Uint8Array(bytes(BOM)));
    expect(encodeIgnore("é\n", { lineEnding: "lf", bom: false })).toEqual(new Uint8Array(bytes("é\n")));
  });

  test("a chosen form applies to all lines of a mixed file", () => {
    const decoded = decodeIgnore(bytes(BOM, "a\nb\r\nc"));
    if (!decoded.ok) throw new Error("refused");
    const lf = saveForm(decoded, "lf");
    const crlf = saveForm(decoded, "crlf");
    if (lf === null || crlf === null) throw new Error("no form");
    expect([...encodeIgnore(decoded.text, lf)]).toEqual([...bytes(BOM, "a\nb\nc")]);
    expect([...encodeIgnore(decoded.text, crlf)]).toEqual([...bytes(BOM, "a\r\nb\r\nc")]);
  });

  test("a mixed file needs a choice; a file of one form keeps it without a choice and converts with one (plan.md D10)", () => {
    const of = (text: string) => {
      const decoded = decodeIgnore(bytes(text));
      if (!decoded.ok) throw new Error("refused");
      return decoded;
    };
    expect(saveForm(of("a\nb\r\n"), undefined)).toBeNull();
    expect(saveForm(of("a\r\n"), undefined)).toEqual({ lineEnding: "crlf", bom: false });
    expect(saveForm(of("a\n"), undefined)).toEqual({ lineEnding: "lf", bom: false });
    expect(saveForm(of("a"), undefined)).toEqual({ lineEnding: "none", bom: false });
    expect(saveForm(of("a\r\n"), "lf")).toEqual({ lineEnding: "lf", bom: false });
    expect(saveForm(of("a\n"), "crlf")).toEqual({ lineEnding: "crlf", bom: false });
    expect(saveForm(of("a"), "crlf")).toEqual({ lineEnding: "crlf", bom: false });
  });

  test("each round trip of a loaded file gives the loaded bytes", () => {
    const loaded = [bytes("*.log\n/out/\n"), bytes("*.log\r\n/out/\r\n"), bytes(BOM, "*.log\r\n"), bytes(BOM, "*.log\n"), bytes("*.log"), bytes(""), bytes(BOM), bytes("ä\r\nü"), bytes("a\n\n\n")];
    for (const file of loaded) {
      const decoded = decodeIgnore(file);
      if (!decoded.ok) throw new Error(`refused ${JSON.stringify(file.toString())}`);
      const form = saveForm(decoded, undefined);
      if (form === null) throw new Error("no form");
      expect({ file: [...file], again: [...encodeIgnore(decoded.text, form)] }).toEqual({ file: [...file], again: [...file] });
    }
  });
});
