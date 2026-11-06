// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { BRANCH_NAME_BYTES } from "../../src/contracts/branch-name";
import * as tagName from "../../src/contracts/tag-name";

printOrigin("../../src/contracts/tag-name.ts", import.meta.dir);

// Feature 010 T003: plan.md D3 read 1, data-model §3 `TagName`, contract Δ5 and Δ9, and research.md R2 P9.

// The module namespace gives `undefined` for a missing export, so each case fails on its own before T004.
const refusal = (name: unknown) => (tagName as unknown as Record<string, ((name: unknown) => unknown) | undefined>).tagNameRefusal?.(name);
const INVALID = { code: "INVALID_REQUEST" } as const;
const reason = (reason: string) => ({ code: "WORKBENCH_UNAVAILABLE", reason });

describe("tagNameRefusal", () => {
  // P9: `check-ref-format refs/tags/<n>` exits 0 for `v1.0` and `a/b`, and `git tag` takes them.
  test("the valid names of research.md R2 P9 pass to Git's own check", () => {
    for (const name of ["v1.0", "a/b"]) expect(refusal(name)).toBeNull();
  });

  // P9: `check-ref-format` exits 1 for these names, so Git's check refuses them with `invalid-name`, not this rule.
  test("names that only Git's check refuses pass to it", () => {
    for (const name of ["a..b", "x.lock", "a b", "werkzeug-ä", "head", "HEADS", "@x", "x-"]) expect(refusal(name)).toBeNull();
  });

  // P9: `check-ref-format` exits 0 for `-x`, but `git tag -x` refuses it.
  test("a leading - gives reason invalid-name", () => {
    for (const name of ["-x", "-", "--end-of-options"]) expect(refusal(name)).toEqual(reason("invalid-name"));
  });

  // P9: `git tag HEAD` refuses the name. A revision reads `@` as HEAD.
  test("HEAD and @ give reason reserved-name", () => {
    expect(refusal("HEAD")).toEqual(reason("reserved-name"));
    expect(refusal("@")).toEqual(reason("reserved-name"));
  });

  test("an empty name gives INVALID_REQUEST", () => {
    expect(refusal("")).toEqual(INVALID);
  });

  // Data-model §3: no control character, Unicode category Cc.
  test("a control character gives INVALID_REQUEST", () => {
    for (const name of ["a\u0001b", "a\tb", "a\nb", "v1\r", "\u001f", "a\u007f", "a\u0085", "a\u009f"]) expect(refusal(name)).toEqual(INVALID);
    expect(refusal("a b")).toBeNull();
  });

  test("NUL, a lone surrogate, or a value that is no string gives INVALID_REQUEST", () => {
    for (const name of ["a\0b", "a\ud800", "\udc00a", 42, null]) expect(refusal(name)).toEqual(INVALID);
  });

  // Contract Δ5: BRANCH_NAME_BYTES bounds the tag name, as it bounds a branch name.
  test("1 to 255 UTF-8 bytes", () => {
    expect(BRANCH_NAME_BYTES).toBe(255);
    expect(refusal("a".repeat(255))).toBeNull();
    expect(refusal("a".repeat(256))).toEqual(INVALID);
    // `ä` is two UTF-8 bytes.
    expect(refusal("ä".repeat(127) + "a")).toBeNull();
    expect(refusal("ä".repeat(128))).toEqual(INVALID);
  });
});
