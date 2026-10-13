// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T014: the filter-text refusals of contract Δ3 `searchHistory` (spec FR-022, FR-026, FR-027, FR-028, SC-009).

import { describe, expect, test } from "bun:test";
import { filterText as check } from "../../src/contracts/filter-text";
import { FILTER_TEXT_BYTES } from "../../src/contracts/limits";
import { printOrigin } from "../origin";

printOrigin("../../src/contracts/filter-text.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);

const filterText = (text: string) => check(text, FILTER_TEXT_BYTES);

describe("filter text", () => {
  test("each refused text gives its reason and the found character", () => {
    expect(filterText("a\uD800b")).toEqual({ kind: "refused", reason: "length", found: "\uD800" });
    expect(filterText("a\uDC00")).toEqual({ kind: "refused", reason: "length", found: "\uDC00" });
    expect(filterText("x".repeat(FILTER_TEXT_BYTES + 1))).toEqual({ kind: "refused", reason: "length", found: null });
    // 342 three-byte characters are 1,026 UTF-8 bytes in 342 UTF-16 units.
    expect(filterText("€".repeat(342))).toEqual({ kind: "refused", reason: "length", found: null });
    expect(filterText("fix\nbug")).toEqual({ kind: "refused", reason: "line-break", found: "\n" });
    expect(filterText("fix\rbug")).toEqual({ kind: "refused", reason: "line-break", found: "\r" });
    expect(filterText("fix\0bug")).toEqual({ kind: "refused", reason: "nul", found: "\0" });
    expect(filterText("a\\Eb")).toEqual({ kind: "refused", reason: "quote-end", found: "\\E" });
  });

  test("the first refused character in text order wins, and the byte bound comes last", () => {
    expect(filterText("a\nb\0c")).toEqual({ kind: "refused", reason: "line-break", found: "\n" });
    expect(filterText("a\0b\nc")).toEqual({ kind: "refused", reason: "nul", found: "\0" });
    expect(filterText("\\Ea\n")).toEqual({ kind: "refused", reason: "quote-end", found: "\\E" });
    expect(filterText(`${"x".repeat(FILTER_TEXT_BYTES)}\0`)).toEqual({ kind: "refused", reason: "nul", found: "\0" });
    expect(filterText(`\0${"x".repeat(FILTER_TEXT_BYTES)}`)).toEqual({ kind: "refused", reason: "nul", found: "\0" });
  });

  test("other text passes unchanged", () => {
    for (const text of ["a\\eb", "\\", "a\\", "-v --all", "\"quoted\" 'single'", ".*+?[](){}^$|\\Q", "  spaced  ", "Виправлення ß ẞ 😀"]) {
      expect(filterText(text)).toEqual({ kind: "search", text });
    }
  });

  test("exactly 1,024 UTF-8 bytes passes", () => {
    expect(FILTER_TEXT_BYTES).toBe(1024);
    const ascii = "x".repeat(FILTER_TEXT_BYTES);
    expect(filterText(ascii)).toEqual({ kind: "search", text: ascii });
    // 256 four-byte characters.
    const astral = "😀".repeat(256);
    expect(filterText(astral)).toEqual({ kind: "search", text: astral });
  });

  test("empty text means no filter", () => {
    expect(filterText("")).toEqual({ kind: "none" });
  });
});
