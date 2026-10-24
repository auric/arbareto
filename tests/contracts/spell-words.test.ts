// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T011: the feature 006 word rules (data-model §11 to §13, §15; plan.md D17; spec FR-003 to FR-006, SC-004).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { printOrigin } from "../origin";
import { SPELLING_SUGGESTIONS } from "../../src/contracts/limits";
import { acceptedSet, changedLines, createRounds, mergeMarks, mergeSuggestions, shiftRanges, sizeText, words } from "../../src/contracts/spell-words";

const SOURCE = printOrigin("../../src/contracts/spell-words.ts", import.meta.dir);

const raws = (text: string) => words(text).map((w) => w.raw);
const mark = (start: number, end: number, raw: string) => ({ start, end, raw, word: raw.normalize("NFC") });

describe("data-model §11 words and skip rules", () => {
  // The table of data-model §11, and one vector for each skip code point alone.
  test.each([
    ["Fix the sync job so it does not recieve stale data", ["Fix", "the", "sync", "job", "so", "it", "does", "not", "recieve", "stale", "data"]],
    ["Rename `fixtureName` in src/app.ts for v1.2.3.", ["Rename", "in", "for"]],
    ["Ask user@host about snake_case and https://example.com/a.", ["Ask", "about", "and"]],
    ["don't follow-up", ["don't", "follow", "up"]],
    ["e.g. U.S. end.", ["end"]],
    ["a `b` c `d", ["a", "c", "d"]],
    ["x1 ٣abc word", ["word"]],
    ["привіт recieve", ["привіт", "recieve"]],
    ["תיקון סדר התויות", ["תיקון", "סדר", "התויות"]],
    ["see std::vector now", ["see", "now"]],
    ["see user@host now", ["see", "now"]],
    ["see snake_case now", ["see", "now"]],
    ["see and/or now", ["see", "now"]],
    ["see back\\slash now", ["see", "now"]],
    ["see v2 now", ["see", "now"]],
    ["see a.b now", ["see", "now"]],
    [".hidden trailing. now", ["hidden", "trailing", "now"]],
  ])("%j gives %j", (text, expected) => {
    expect(raws(text)).toEqual(expected);
  });

  test("lines split at U+000A, so a backtick pair never crosses a line", () => {
    expect(raws("a `b\nc` d")).toEqual(["a", "b", "c", "d"]);
    expect(raws("`x` y\n`z` w")).toEqual(["y", "w"]);
  });

  test("tokens are runs without White_Space, so U+00A0 and U+3000 split tokens", () => {
    expect(raws("snake_case word")).toEqual(["word"]);
    expect(raws("snake_case　word")).toEqual(["word"]);
  });

  test("the lookup form is NFC, and the range keeps the offsets of the text", () => {
    const text = "x café y";
    const found = words(text);
    expect(found.map((w) => w.word)).toEqual(["x", "café", "y"]);
    const cafe = found[1];
    expect(cafe).toEqual({ start: 2, end: 7, raw: "café", word: "café" });
    expect(text.slice(cafe.start, cafe.end)).toBe(cafe.raw);
  });

  test("offsets count UTF-16 units of the whole text across lines", () => {
    const text = "\u{1F600} ab\ncd";
    expect(words(text).map(({ start, end }) => [start, end])).toEqual([
      [3, 5],
      [6, 8],
    ]);
  });

  test("a base offset moves every range, so a worker can check one line", () => {
    expect(words("cd ef", 6).map(({ start, end }) => [start, end])).toEqual([
      [6, 8],
      [9, 11],
    ]);
  });
});

describe("data-model §12 case rule", () => {
  test("L = {kubectl} accepts kubectl, Kubectl, and KUBECTL, and refuses KubeCtl", () => {
    const accepted = acceptedSet(["kubectl"]);
    for (const word of ["kubectl", "Kubectl", "KUBECTL"]) expect(accepted.has(word)).toBe(true);
    expect(accepted.has("KubeCtl")).toBe(false);
  });

  test("L = {iPhone} accepts iPhone, IPhone, and IPHONE", () => {
    const accepted = acceptedSet(["iPhone"]);
    for (const word of ["iPhone", "IPhone", "IPHONE"]) expect(accepted.has(word)).toBe(true);
    expect(accepted.has("iphone")).toBe(false);
  });

  test("cap takes the first code point, so a supplementary letter capitalizes whole", () => {
    // U+10428 DESERET SMALL LETTER LONG I; its upper case is U+10400.
    expect(acceptedSet(["\u{10428}x"]).has("\u{10400}x")).toBe(true);
  });
});

describe("data-model §13 changed lines and shift", () => {
  test("a typed character changes its own line only", () => {
    expect(changedLines("ab\ncd\nef", "ab\ncXd\nef")).toEqual({ first: 1, lastA: 1, lastB: 1 });
  });

  test("a deleted line changes the lines that meet the deleted range", () => {
    expect(changedLines("ab\ncd\nef", "ab\nef")).toEqual({ first: 1, lastA: 2, lastB: 1 });
  });

  test("a pasted block changes every line that it adds", () => {
    expect(changedLines("ab\ncd", "ab\nX\nY\ncd")).toEqual({ first: 1, lastA: 1, lastB: 3 });
  });

  test("an insertion at a line end changes that line only", () => {
    expect(changedLines("ab\ncd", "ab!\ncd")).toEqual({ first: 0, lastA: 0, lastB: 0 });
  });

  test("marks before the changed lines stay, marks after them move by |B| − |A|, and marks in them go", () => {
    const a = "aa bb\ncc dd\nee ff";
    const b = "aa bb\ncc Xdd\nY\nee ff";
    const marks = [mark(0, 2, "aa"), mark(3, 5, "bb"), mark(6, 8, "cc"), mark(9, 11, "dd"), mark(12, 14, "ee"), mark(15, 17, "ff")];
    const shifted = shiftRanges(marks, a, b);
    const delta = b.length - a.length;
    expect(shifted).toEqual([mark(0, 2, "aa"), mark(3, 5, "bb"), mark(12 + delta, 14 + delta, "ee"), mark(15 + delta, 17 + delta, "ff")]);
    for (const m of shifted) expect(b.slice(m.start, m.end)).toBe(m.raw);
  });

  test("an insertion at a line end keeps the marks of the next line at their new offsets", () => {
    const a = "ab\ncd";
    const b = "ab!\ncd";
    expect(shiftRanges([mark(0, 2, "ab"), mark(3, 5, "cd")], a, b)).toEqual([mark(4, 6, "cd")]);
  });

  test("an equal text keeps every mark", () => {
    expect(shiftRanges([mark(0, 2, "ab")], "ab", "ab")).toEqual([mark(0, 2, "ab")]);
  });
});

describe("data-model §13 rounds and the mark merge", () => {
  test("a round merges only when every worker of the round replied", () => {
    const rounds = createRounds();
    const { round } = rounds.start(["en", "uk"], [0, 1]);
    expect(rounds.reply(round, "en")).toBe(false);
    expect(rounds.reply(round, "en")).toBe(false);
    expect(rounds.reply(round, "de")).toBe(false);
    expect(rounds.reply(round, "uk")).toBe(true);
    expect(rounds.reply(round, "uk")).toBe(false);
  });

  test("a newer round drops an older one, and carries the union of the dropped and the new changed lines", () => {
    const rounds = createRounds();
    const first = rounds.start(["en"], [0, 2]);
    // The edit from A to B replaces line 1 with lines 1 to 3, so the dropped line 2 moves to line 4.
    const second = rounds.start(["en"], [1, 2, 3], { first: 1, lastA: 1, lastB: 3 });
    expect(second.round).toBeGreaterThan(first.round);
    expect(second.lines).toEqual([0, 1, 2, 3, 4]);
    expect(rounds.reply(first.round, "en")).toBe(false);
    expect(rounds.reply(second.round, "en")).toBe(true);
  });

  test("after a merge, a new round carries only its own lines", () => {
    const rounds = createRounds();
    const first = rounds.start(["en"], [5]);
    expect(rounds.reply(first.round, "en")).toBe(true);
    expect(rounds.start(["en"], [1], { first: 1, lastA: 1, lastB: 1 }).lines).toEqual([1]);
  });

  test("a range is a mark only when every loaded language refused it and no list accepts its word", () => {
    const en = [mark(0, 7, "recieve"), mark(8, 14, "привіт"), mark(15, 22, "kubectl")];
    const uk = [mark(0, 7, "recieve"), mark(15, 22, "kubectl")];
    const accepted = acceptedSet(["kubectl"]);
    expect(mergeMarks([en, uk], (word) => accepted.has(word))).toEqual([mark(0, 7, "recieve")]);
    expect(mergeMarks([], () => false)).toEqual([]);
  });
});

describe("data-model §15 suggestion merge", () => {
  test("the lists join in selection order, NFC repeats drop, and the result holds at most 5", () => {
    expect(mergeSuggestions([["receive", "relieve"], ["receive", "recite"], ["a", "b", "c", "d"]])).toEqual(["receive", "relieve", "recite", "a", "b"]);
    expect(mergeSuggestions([["café"], ["café", "cafe"]])).toEqual(["café", "cafe"]);
    expect(mergeSuggestions([])).toEqual([]);
  });

  // The module repeats the contract Δ5 value, because it has no runtime import.
  test("the cut equals SPELLING_SUGGESTIONS of limits.ts", () => {
    expect(mergeSuggestions([Array.from({ length: SPELLING_SUGGESTIONS + 1 }, (_, i) => `w${i}`)])).toHaveLength(SPELLING_SUGGESTIONS);
  });
});

describe("plan.md D17 size text", () => {
  test.each([
    [570_579, "0.57 MB"],
    [0, "0.00 MB"],
    [4_999, "0.00 MB"],
    [5_000, "0.01 MB"],
    [12_582_912, "12.58 MB"],
    [1_000_000, "1.00 MB"],
    [1_994_999, "1.99 MB"],
    [1_995_000, "2.00 MB"],
  ])("%d bytes give %s", (bytes, text) => {
    expect(sizeText(bytes)).toBe(text);
  });
});

test("the module has no runtime import", () => {
  const source = readFileSync(SOURCE, "utf8");
  expect(source).not.toMatch(/^\s*import\s+(?!type\b)/m);
  expect(source).not.toMatch(/^\s*export\s+(?!type\b)[^;]*\bfrom\s/m);
  expect(source).not.toMatch(/\brequire\(|\bimport\(/);
});
