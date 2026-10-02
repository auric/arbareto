// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { decodeStrictJson } from "../../src/contracts/strict-json";

printOrigin("../../src/contracts/strict-json.ts", import.meta.dir);

const utf8 = (text: string) => new TextEncoder().encode(text);
const bytes = (...values: number[]) => new Uint8Array(values);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function expectInvalid(input: Uint8Array) {
  expect(decodeStrictJson(input)).toEqual({ ok: false, code: "INVALID_REQUEST" });
}

function expectSameAsJsonParse(text: string) {
  const result = decodeStrictJson(utf8(text));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toStrictEqual(JSON.parse(text));
}

const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
const nestedObjects = (depth: number) => '{"a":'.repeat(depth - 1) + "{}" + "}".repeat(depth - 1);

describe("duplicate keys", () => {
  test.each([
    ['{"a":1,"a":2}'],
    ['{"a":1,"b":2,"a":1}'],
    ['{"x":{"a":1,"a":2}}'],
    ['[{"a":1,"a":1}]'],
    ['{"x":[1,[{"y":{"k":null,"k":null}}]]}'],
    ['{"a":1,"\\u0061":2}'],
    ['{"\\ud83d\\ude00":1,"\u{1F600}":2}'],
  ])("%s gives INVALID_REQUEST", (text) => expectInvalid(utf8(text)));
});

describe("nesting", () => {
  test("16 nested arrays decode", () => expectSameAsJsonParse(nested(16)));
  test("16 nested objects decode", () => expectSameAsJsonParse(nestedObjects(16)));
  test("17 nested arrays give INVALID_REQUEST", () => expectInvalid(utf8(nested(17))));
  test("17 nested objects give INVALID_REQUEST", () => expectInvalid(utf8(nestedObjects(17))));
  test("17 mixed levels give INVALID_REQUEST", () =>
    expectInvalid(utf8('{"a":' + nested(16) + "}")));
  test("deep input far above the bound gives INVALID_REQUEST", () =>
    expectInvalid(utf8(nested(100_000))));
});

describe("invalid UTF-8", () => {
  const wrap = (inner: Uint8Array) => concat(utf8('{"a":"'), inner, utf8('"}'));
  test.each([
    ["lone continuation byte", bytes(0x80)],
    ["0xFF byte", bytes(0xff)],
    ["overlong NUL", bytes(0xc0, 0x80)],
    ["overlong slash", bytes(0xe0, 0x80, 0xaf)],
    ["encoded surrogate", bytes(0xed, 0xa0, 0x80)],
    ["code point above U+10FFFF", bytes(0xf4, 0x90, 0x80, 0x80)],
    ["truncated sequence", bytes(0xe2, 0x82)],
  ])("%s in a string gives INVALID_REQUEST", (_name, inner) => expectInvalid(wrap(inner)));
  test("invalid byte in a key gives INVALID_REQUEST", () =>
    expectInvalid(concat(utf8('{"'), bytes(0xff), utf8('":1}'))));
  test("truncated sequence at end of input gives INVALID_REQUEST", () =>
    expectInvalid(concat(utf8("1"), bytes(0xe2))));
});

describe("trailing data", () => {
  test.each([["{} x"], ["{}{}"], ["[1]]"], ["1 2"], ['"a""b"'], ["{}\u0000"]])(
    "%j gives INVALID_REQUEST",
    (text) => expectInvalid(utf8(text)),
  );
  test("trailing JSON white space decodes", () => expectSameAsJsonParse('{"a":1} \t\r\n'));
});

describe("integers outside the safe range", () => {
  test.each([["9007199254740992"], ["-9007199254740992"], ['{"n":[18446744073709551616]}']])(
    "%s gives INVALID_REQUEST",
    (text) => expectInvalid(utf8(text)),
  );
  test.each([["9007199254740991"], ["-9007199254740991"], ["0"], ["-0"]])("%s decodes", (text) =>
    expectSameAsJsonParse(text),
  );
});

describe("malformed JSON", () => {
  test.each([[""], ["{"], ['{"a":}'], ["[1,]"], ["{'a':1}"], ["NaN"], ['"\\x"'], ['"a\u0001"']])(
    "%j gives INVALID_REQUEST",
    (text) => expectInvalid(utf8(text)),
  );
});

describe("valid input decodes to the JSON.parse value", () => {
  test.each([
    ["null"],
    ["true"],
    ['"text"'],
    ["-12.5e3"],
    ["[]"],
    ["{}"],
    ['{"a":[1,{"b":null,"c":[true,false]}],"d":"\\u00e9\\n\\"","e":-0.5}'],
    ['[{"a":1},{"a":2},[[["x"]]]]'],
    ['{"emoji":"\\ud83d\\ude00","raw":"\u{1F600}é"}'],
    ['  {"spaced" : [ 1 , 2 ] }  '],
  ])("%s", (text) => expectSameAsJsonParse(text));

  test("__proto__ stays an own data property", () => {
    const result = decodeStrictJson(utf8('{"__proto__":{"x":1}}'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as Record<string, unknown>;
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
