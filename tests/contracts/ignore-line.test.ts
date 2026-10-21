// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { IGNORE_LINE_BYTES, ignoreLine } from "../../src/contracts/ignore-line";

printOrigin("../../src/contracts/ignore-line.ts", import.meta.dir);

// FR-046, plan.md D9, gitignore(5), and contract Δ5 "Ignore line" (T010).

const enc = (text: string) => new TextEncoder().encode(text);
const line = (path: string, folder = false) => ignoreLine(enc(path), folder);
const ok = (text: string) => ({ ok: true, line: text }) as const;

describe("ignoreLine", () => {
  test("a leading / anchors the path at the worktree root", () => {
    expect(line("build.log")).toEqual(ok("/build.log"));
    expect(line("src/gen/out.txt")).toEqual(ok("/src/gen/out.txt"));
  });

  test("a folder ends with /", () => {
    expect(line("node_modules", true)).toEqual(ok("/node_modules/"));
    expect(line("a/b", true)).toEqual(ok("/a/b/"));
  });

  test("a backslash goes before each *, ?, [, and backslash", () => {
    expect(line("a*b?c[d]e\\f")).toEqual(ok("/a\\*b\\?c\\[d]e\\\\f"));
    expect(line("**/x")).toEqual(ok("/\\*\\*/x"));
  });

  test("a backslash goes before each trailing space", () => {
    expect(line("name  ")).toEqual(ok("/name\\ \\ "));
    expect(line("a b ")).toEqual(ok("/a b\\ "));
    expect(line("dir ", true)).toEqual(ok("/dir\\ /"));
    expect(line("a\\ ")).toEqual(ok("/a\\\\\\ "));
  });

  test("# and ! need no escape after the leading /", () => {
    expect(line("#notes")).toEqual(ok("/#notes"));
    expect(line("!keep")).toEqual(ok("/!keep"));
    expect(line("a/!b#c")).toEqual(ok("/a/!b#c"));
  });

  test("other characters stay as they are", () => {
    expect(line("werkzeug-ä/ü.txt")).toEqual(ok("/werkzeug-ä/ü.txt"));
    expect(line("﻿lead.txt")).toEqual(ok("/﻿lead.txt"));
    expect(line(" lead.txt")).toEqual(ok("/ lead.txt"));
  });

  test("a control character gives reason path", () => {
    for (const path of ["a\nb", "a\rb", "a\tb", "a\0b", "a\x7fb", "a\x85b", "tail\r"]) expect(line(path)).toEqual({ ok: false, reason: "path" });
  });

  test("invalid UTF-8 or an empty path gives reason path", () => {
    expect(ignoreLine(new Uint8Array([0x61, 0xff]), false)).toEqual({ ok: false, reason: "path" });
    expect(ignoreLine(new Uint8Array([0xed, 0xa0, 0x80]), false)).toEqual({ ok: false, reason: "path" });
    expect(ignoreLine(new Uint8Array(), false)).toEqual({ ok: false, reason: "path" });
  });

  test("a line above 4,096 UTF-8 bytes refuses", () => {
    expect(IGNORE_LINE_BYTES).toBe(4096);
    expect(line("a".repeat(4095))).toEqual(ok(`/${"a".repeat(4095)}`));
    expect(line("a".repeat(4096))).toEqual({ ok: false, reason: "limit" });
    expect(line("a".repeat(4094), true)).toEqual(ok(`/${"a".repeat(4094)}/`));
    expect(line("a".repeat(4095), true)).toEqual({ ok: false, reason: "limit" });
    // Escapes count: 2,048 stars give 4,096 escaped bytes plus the leading /.
    expect(line("*".repeat(2048))).toEqual({ ok: false, reason: "limit" });
    // `ä` is two UTF-8 bytes.
    expect(line("ä".repeat(2047) + "a")).toEqual(ok(`/${"ä".repeat(2047)}a`));
    expect(line("ä".repeat(2048))).toEqual({ ok: false, reason: "limit" });
  });
});
