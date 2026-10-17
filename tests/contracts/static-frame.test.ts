// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T380: the window is a static frame. The root never scrolls or bounces, and app chrome is not selectable.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { printOrigin } from "../origin";

const css = readFileSync(printOrigin("../../src/frontend/index.css", import.meta.dir), "utf8");
const patchView = readFileSync(printOrigin("../../src/frontend/changes/PatchView.tsx", import.meta.dir), "utf8");

/** The declarations of the first rule whose selector list is exactly `selectors`. */
function rule(...selectors: string[]): Record<string, string> {
  const head = new RegExp(`(?<!,\\s*)(?<![\\w-])${selectors.map((s) => s.replace(/[[\]*]/g, "\\$&")).join(",\\s*")}\\s*\\{([^{}]*)\\}`);
  const match = css.match(head);
  expect(match, selectors.join(", ")).not.toBeNull();
  const body = match![1]!.replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries(body.split(";").flatMap((d) => (d.includes(":") ? [d.split(":").map((p) => p.trim()) as [string, string]] : [])));
}

describe("static frame", () => {
  test("the root never scrolls, pans, or bounces, and fills the window", () => {
    expect(rule("html", "body")).toMatchObject({ height: "100%", overflow: "hidden", "overscroll-behavior": "none" });
  });

  test("a pane scroll never chains to an outer pane or to the root", () => {
    expect(rule("*")).toMatchObject({ "overscroll-behavior": "contain" });
  });

  test("app chrome is not selectable, inputs stay selectable, and images and links do not drag", () => {
    expect(rule("body")).toMatchObject({ "user-select": "none" });
    expect(rule("input", "textarea", "[contenteditable]")).toMatchObject({ "user-select": "text" });
    expect(rule("img", "a")).toMatchObject({ "-webkit-user-drag": "none" });
  });

  test("the diff text is selectable", () => {
    expect(patchView).toMatch(/<Virtualizer className="[^"]*\bselect-text\b/);
  });
});
