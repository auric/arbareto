// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { JSON_NESTING_LEVELS } from "./limits";

export type StrictJsonResult = { ok: true; value: unknown } | { ok: false; code: "INVALID_REQUEST" };

class Invalid extends Error {}

// `ignoreBOM` keeps a leading U+FEFF inside a string value.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const LITERALS: Array<[string, unknown]> = [["true", true], ["false", false], ["null", null]];
const ESCAPES: Record<number, string> = { 0x22: '"', 0x5c: "\\", 0x2f: "/", 0x62: "\b", 0x66: "\f", 0x6e: "\n", 0x72: "\r", 0x74: "\t" };

// The keys of each decoded object whose number literal has a fraction or an exponent. `1.0` and `1` decode to the same value.
const fractionOrExponent = new WeakMap<object, Set<string>>();

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// True only when `holder` came from `decodeStrictJson` and the literal of `key` has a fraction or an exponent.
export function hasFractionOrExponent(holder: object, key: string): boolean {
  return fractionOrExponent.get(holder)?.has(key) ?? false;
}

// Every byte outside a string must be ASCII JSON syntax. Each string segment between escapes is decoded once with a fatal decoder, so the scan also validates all UTF-8.
export function decodeStrictJson(bytes: Uint8Array): StrictJsonResult {
  let at = 0;
  // Set by the last parsed number.
  let inexact = false;

  const fail = (): never => {
    throw new Invalid();
  };

  const decode = (from: number, to: number): string => {
    try {
      return utf8.decode(bytes.subarray(from, to));
    } catch {
      return fail();
    }
  };

  const skipSpace = () => {
    while (at < bytes.length) {
      const b = bytes[at];
      if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return;
      at++;
    }
  };

  const expectBytes = (text: string) => {
    for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) fail();
    at += text.length;
  };

  const hex4 = (): number => {
    if (at + 4 > bytes.length) fail();
    const text = decode(at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) fail();
    at += 4;
    return parseInt(text, 16);
  };

  const parseString = (): string => {
    at++;
    let out = "";
    let segment = at;
    for (;;) {
      if (at >= bytes.length) fail();
      const b = bytes[at];
      if (b === 0x22) {
        out += decode(segment, at);
        at++;
        return out;
      }
      if (b < 0x20) fail();
      if (b !== 0x5c) {
        at++;
        continue;
      }
      out += decode(segment, at);
      at++;
      const e = bytes[at];
      if (e === 0x75) {
        at++;
        out += String.fromCharCode(hex4());
      } else {
        const ch = ESCAPES[e];
        if (ch === undefined) fail();
        out += ch;
        at++;
      }
      segment = at;
    }
  };

  const parseNumber = (): number => {
    let end = at;
    while (end < bytes.length && isNumberByte(bytes[end])) end++;
    const text = decode(at, end);
    NUMBER.lastIndex = 0;
    const match = NUMBER.exec(text);
    if (!match || match[0].length !== text.length) return fail();
    at = end;
    inexact = match[1] !== undefined || match[2] !== undefined;
    const value = Number(text);
    if (!Number.isFinite(value) || (match[1] === undefined && match[2] === undefined && !Number.isSafeInteger(value))) fail();
    return value;
  };

  const parseValue = (depth: number): unknown => {
    skipSpace();
    if (at >= bytes.length) fail();
    const b = bytes[at];
    if (b === 0x7b || b === 0x5b) {
      if (depth >= JSON_NESTING_LEVELS) fail();
      return b === 0x7b ? parseObject(depth + 1) : parseArray(depth + 1);
    }
    if (b === 0x22) return parseString();
    for (const [literal, value] of LITERALS) {
      if (b === literal.charCodeAt(0)) {
        expectBytes(literal);
        return value;
      }
    }
    if (b === 0x2d || (b >= 0x30 && b <= 0x39)) return parseNumber();
    return fail();
  };

  const parseArray = (depth: number): unknown[] => {
    at++;
    const out: unknown[] = [];
    skipSpace();
    if (bytes[at] === 0x5d) {
      at++;
      return out;
    }
    for (;;) {
      out.push(parseValue(depth));
      skipSpace();
      const b = bytes[at++];
      if (b === 0x5d) return out;
      if (b !== 0x2c) fail();
    }
  };

  const parseObject = (depth: number): Record<string, unknown> => {
    at++;
    const out: Record<string, unknown> = {};
    skipSpace();
    if (bytes[at] === 0x7d) {
      at++;
      return out;
    }
    for (;;) {
      skipSpace();
      if (bytes[at] !== 0x22) fail();
      const key = parseString();
      if (Object.hasOwn(out, key)) fail();
      skipSpace();
      if (bytes[at++] !== 0x3a) fail();
      const value = parseValue(depth);
      if (typeof value === "number" && inexact) {
        const keys = fractionOrExponent.get(out) ?? new Set<string>();
        keys.add(key);
        fractionOrExponent.set(out, keys);
      }
      // defineProperty keeps `__proto__` an own data property.
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      skipSpace();
      const b = bytes[at++];
      if (b === 0x7d) return out;
      if (b !== 0x2c) fail();
    }
  };

  try {
    const value = parseValue(0);
    skipSpace();
    if (at !== bytes.length) fail();
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, code: "INVALID_REQUEST" };
    throw error;
  }
}

function isNumberByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2b || b === 0x2e || b === 0x65 || b === 0x45;
}
