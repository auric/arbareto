// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T111: the `diff-index --cached -z --name-status` record form (git-diff(1) "Raw output format" and "--diff-filter").

import { expect, test } from "bun:test";
import { parseScope } from "../../src/git-service/commit-review";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/commit-review.ts", import.meta.dir);

const bytes = (text: string) => new TextEncoder().encode(text);
const parsed = (text: string) => parseScope(bytes(text))?.map((r) => [r.status, Buffer.from(r.path).toString("utf8")]) ?? null;

test("each record is a letter and a path, each NUL-terminated", () => {
  expect(parsed("")).toEqual([]);
  expect(parsed("A\0new.txt\0D\0a b.txt\0M\0é.txt\0T\0link\0U\0m.txt\0")).toEqual([["A", "new.txt"], ["D", "a b.txt"], ["M", "é.txt"], ["T", "link"], ["U", "m.txt"]]);
});

test("a broken record form, a rename or copy record, and an unknown letter refuse", () => {
  for (const text of ["M\0a.txt", "M\0", "M\0\0", "R100\0a\0b\0", "C075\0a\0b\0", "X\0a\0", "B\0a\0", "MM\0a\0"]) expect(parsed(text)).toBeNull();
});
