// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T020: feature 005 plan.md D12 "Parse" and "Checks", git-blame(1) "THE PORCELAIN FORMAT" and "INCREMENTAL OUTPUT".
// The byte fixtures copy Git 2.56.0.windows.2 output for a four-line file whose last line has no LF (probe of 2026-10-22).

import { describe, expect, test } from "bun:test";
import { BlameStream, countLines, parseBlame } from "../../src/git-service/blame-parser";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/blame-parser.ts", import.meta.dir);

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const E = "eac8923222ba791f15146eb5effaa1149910652b";
const P = "87f52ad62be7a507448da52137e9fb288b247011";
const T = "ee57331822133e1fbab86a333f25fc6d60b1a70e";
const info = (summary: string) => `author F\nauthor-mail <f@x.invalid>\nauthor-time 1767225600\nauthor-tz +0000\ncommitter F\ncommitter-mail <f@x.invalid>\ncommitter-time 1767225600\ncommitter-tz +0000\nsummary ${summary}\n`;

const INCREMENTAL =
  `${T} 3 3 1\n${info("three")}previous ${P} f\nfilename f\n` +
  `${P} 2 2 1\n${info("two")}previous ${E} f\nfilename f\n` +
  `${P} 4 4 1\nprevious ${E} f\nfilename f\n` +
  `${E} 1 1 1\n${info("one")}boundary\nfilename f\n`;

const PORCELAIN =
  `${E} 1 1 1\n${info("one")}boundary\nfilename f\n\ta\n` +
  `${E} 2 2 1\nignored\n\tB\n` +
  `${T} 3 3 1\n${info("three")}previous ${P} f\nfilename f\n\tC\n` +
  `${P} 4 4 1\n${info("two")}previous ${E} f\nfilename f\nunblamable\n\td\n`;

const commitOf = (parsed: NonNullable<ReturnType<typeof parseBlame>>, line: number) => {
  const g = parsed.groups.find((x) => x.finalStart <= line && line < x.finalStart + x.count)!;
  return parsed.origins[g.origin]!;
};

describe("incremental output", () => {
  test("groups sort into final line order; an origin keeps its commit headers, previous, and filename", () => {
    const parsed = parseBlame(bytes(INCREMENTAL), "incremental", "sha1", 4)!;
    expect(parsed.groups.map((g) => [g.finalStart, g.count, g.origStart, parsed.origins[g.origin]!.oid, g.ignored, g.unblamable])).toEqual([
      [1, 1, 1, E, false, false],
      [2, 1, 2, P, false, false],
      [3, 1, 3, T, false, false],
      [4, 1, 4, P, false, false],
    ]);
    const one = commitOf(parsed, 1);
    expect([decode(one.author), decode(one.authorMail), one.authorTime, one.authorTz, decode(one.summary), one.boundary, one.previous, decode(one.filename)]).toEqual(["F", "<f@x.invalid>", 1767225600, "+0000", "one", true, null, "f"]);
    expect(commitOf(parsed, 3).previous).toEqual({ oid: P, path: bytes("f") });
    // Lines 2 and 4 share one origin: the same commit, previous, and filename.
    expect(parsed.origins).toHaveLength(3);
  });

  test("the stream counts blamed lines per group and accepts any chunk split", () => {
    const stream = new BlameStream("incremental", "sha1");
    const counts: number[] = [];
    for (const b of bytes(INCREMENTAL)) {
      stream.push(Uint8Array.of(b));
      counts.push(stream.blamed);
    }
    expect([counts[0], counts.at(-1)]).toEqual([0, 4]);
    expect(stream.finish(4)!.groups).toHaveLength(4);
  });

  test("C-quoted previous and filename paths give their bytes", () => {
    const quoted = `${E} 1 1 1\n${info("one")}previous ${P} "\\303\\251 x.txt"\nfilename "\\303\\251.txt"\n`;
    const o = parseBlame(bytes(quoted), "incremental", "sha1", 1)!.origins[0]!;
    expect([decode(o.previous!.path), decode(o.filename)]).toEqual(["é x.txt", "é.txt"]);
  });

  test("an empty file gives no group", () => {
    expect(parseBlame(new Uint8Array(), "incremental", "sha1", 0)).toEqual({ origins: [], groups: [] });
  });
});

describe("porcelain output", () => {
  test("the marks come per line; a repeated commit without filename keeps its first origin; TAB lines are skipped", () => {
    const parsed = parseBlame(bytes(PORCELAIN), "porcelain", "sha1", 4)!;
    expect(parsed.groups.map((g) => [g.finalStart, g.count, parsed.origins[g.origin]!.oid, g.ignored, g.unblamable])).toEqual([
      [1, 1, E, false, false],
      [2, 1, E, true, false],
      [3, 1, T, false, false],
      [4, 1, P, false, true],
    ]);
    expect(parsed.groups[0]!.origin).toBe(parsed.groups[1]!.origin);
  });

  test("a group of several lines repeats the header without the count", () => {
    const text = `${E} 1 1 3\n${info("one")}filename f\nignored\n\ta\n${E} 2 2\nignored\n\tb\n${E} 3 3\nignored\n\tc\n`;
    const parsed = parseBlame(bytes(text), "porcelain", "sha1", 3)!;
    expect(parsed.groups.map((g) => [g.finalStart, g.count, g.ignored])).toEqual([[1, 3, true]]);
  });
});

describe("refusals give null (MALFORMED_GIT_OUTPUT)", () => {
  const cases: [string, string, "incremental" | "porcelain", number][] = [
    ["an unknown header line", INCREMENTAL.replace("summary one\n", "summary one\nencoding x\n"), "incremental", 4],
    ["a group outside lines 1 to N", INCREMENTAL, "incremental", 3],
    ["a gap", INCREMENTAL.replace(`${P} 4 4 1\nprevious ${E} f\nfilename f\n`, ""), "incremental", 4],
    ["an overlap", INCREMENTAL.replace(`${P} 4 4 1`, `${P} 3 3 1`), "incremental", 4],
    ["an incremental group without filename", INCREMENTAL.replace(`previous ${E} f\nfilename f\n${E}`, `previous ${E} f\n${E}`), "incremental", 4],
    ["an incremental group without a count", INCREMENTAL.replace(`${P} 4 4 1`, `${P} 4 4`), "incremental", 4],
    ["a commit header block repeated for a seen commit", INCREMENTAL.replace(`${P} 4 4 1\n`, `${P} 4 4 1\n${info("two")}`), "incremental", 4],
    ["a first appearance without commit headers", INCREMENTAL.replace(`${T} 3 3 1\n${info("three")}`, `${T} 3 3 1\n`), "incremental", 4],
    ["a missing summary", INCREMENTAL.replace("summary three\n", ""), "incremental", 4],
    ["an author-time that is no integer", INCREMENTAL.replace(`${T} 3 3 1\nauthor F\nauthor-mail <f@x.invalid>\nauthor-time 1767225600`, `${T} 3 3 1\nauthor F\nauthor-mail <f@x.invalid>\nauthor-time 17.5`), "incremental", 4],
    ["an author-tz of another form", INCREMENTAL.replace("author-tz +0000\ncommitter F\ncommitter-mail <f@x.invalid>\ncommitter-time 1767225600\ncommitter-tz +0000\nsummary three", "author-tz UTC\ncommitter F\ncommitter-mail <f@x.invalid>\ncommitter-time 1767225600\ncommitter-tz +0000\nsummary three"), "incremental", 4],
    ["a previous OID of the other object format", INCREMENTAL.replace(`previous ${P} f`, `previous ${"a".repeat(64)} f`), "incremental", 4],
    ["an OID of the other object format", INCREMENTAL, "incremental" as const, -1],
    ["the ignored mark in incremental output", INCREMENTAL.replace(`filename f\n${E}`, `filename f\nignored\n${E}`), "incremental", 4],
    ["a porcelain line without its TAB content", PORCELAIN.replace("\tB\n", ""), "porcelain", 4],
    ["continuation lines with other marks than the first line", `${E} 1 1 2\n${info("one")}filename f\n\ta\n${E} 2 2\nignored\n\tb\n`, "porcelain", 2],
    ["a continuation header with another line number", `${E} 1 1 2\n${info("one")}filename f\n\ta\n${E} 3 3\n\tb\n`, "porcelain", 2],
    ["a bad C quote", INCREMENTAL.replace(`previous ${P} f\nfilename f\n${P} 2`, `previous ${P} f\nfilename "\\q"\n${P} 2`), "incremental", 4],
    ["a last line without LF", INCREMENTAL.slice(0, -1), "incremental", 4],
  ];
  for (const [name, text, mode, lines] of cases) {
    test(name, () => expect(lines === -1 ? parseBlame(bytes(text), mode, "sha256", 4) : parseBlame(bytes(text), mode, "sha1", lines)).toBeNull());
  }
});

describe("the line count of blame.c `find_line_starts`", () => {
  test("a last line without LF counts as a line", () => {
    expect(["", "a", "a\n", "a\nb", "\n", "a\n\n"].map((t) => countLines(bytes(t)))).toEqual([0, 1, 1, 2, 1, 2]);
  });
});
