// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { BRANCH_NAME_BYTES, branchNameRefusal } from "../../src/contracts/branch-name";

printOrigin("../../src/contracts/branch-name.ts", import.meta.dir);

// FR-015, plan.md D4, contract Δ3, Δ5, Δ9, and research.md R21 F11, F29 (T010).

const INVALID = { code: "INVALID_REQUEST" } as const;

describe("branchNameRefusal", () => {
  test("names that pass to Git's own check", () => {
    for (const name of ["topic", "feature/x", "werkzeug-ä", "a", "-x", "a..b", "HEAD", "@{-1}", "x@"]) expect(branchNameRefusal(name)).toBeNull();
  });

  // Git accepts `@` as a branch name (F11), but reads it as HEAD in a revision argument (F29).
  test("the name @ gives reason reserved-name", () => {
    expect(branchNameRefusal("@")).toEqual({ code: "WORKBENCH_UNAVAILABLE", reason: "reserved-name" });
  });

  test("1 to 255 UTF-8 bytes", () => {
    expect(BRANCH_NAME_BYTES).toBe(255);
    expect(branchNameRefusal("")).toEqual(INVALID);
    expect(branchNameRefusal("a".repeat(255))).toBeNull();
    expect(branchNameRefusal("a".repeat(256))).toEqual(INVALID);
    // `ä` is two UTF-8 bytes.
    expect(branchNameRefusal("ä".repeat(127) + "a")).toBeNull();
    expect(branchNameRefusal("ä".repeat(128))).toEqual(INVALID);
  });

  test("a name that is not well-formed or holds NUL", () => {
    expect(branchNameRefusal("a\ud800")).toEqual(INVALID);
    expect(branchNameRefusal("\udc00a")).toEqual(INVALID);
    expect(branchNameRefusal("a\0b")).toEqual(INVALID);
    expect(branchNameRefusal(42 as unknown as string)).toEqual(INVALID);
  });
});
