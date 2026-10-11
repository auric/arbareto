// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// plan.md "Motion": the animated parts, and the reduced-motion rule that nothing moves or fades.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { printOrigin } from "../origin";
import { buttonVariants } from "../../src/frontend/components/ui/button";

const CSS_PATH = printOrigin("../../src/frontend/index.css", import.meta.dir);
const TABS_PATH = printOrigin("../../src/frontend/components/ui/tabs.tsx", import.meta.dir);
printOrigin("../../src/frontend/components/ui/button.tsx", import.meta.dir);
const css = readFileSync(CSS_PATH, "utf8");

const VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
// The focus ring (outline, box-shadow, border color) must not transition, so it shows at once.
const TRANSITION = "transition-[background-color,color,translate]";

/** The slot selectors in the reduced-motion block. */
function reducedSlots(): string[] {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(start).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n}", start));
  return [...block.matchAll(/\[data-slot="([^"]+)"\]/g)].map((m) => m[1]!);
}

describe("motion", () => {
  test("each button variant transitions only its fill, its text color, and its press offset", () => {
    for (const variant of VARIANTS) {
      const classes = buttonVariants({ variant }).split(/\s+/);
      expect(classes).not.toContain("transition-all");
      expect(classes).toContain(TRANSITION);
      expect(classes).toContain("duration-100");
      expect(classes).toContain("ease-(--ease-out)");
    }
  });

  test("the tab trigger transitions only its fill and its text color", () => {
    const source = readFileSync(TABS_PATH, "utf8");
    expect(source).not.toContain("transition-all");
    expect(source).toContain(`${TRANSITION} duration-100 ease-(--ease-out)`);
  });

  test("every slot that index.css or a shadcn button or tab animates is in the reduced-motion list", () => {
    const slots = reducedSlots();
    const outside = css.slice(0, css.indexOf("@media (prefers-reduced-motion: reduce)"));
    const animated = [...outside.matchAll(/\[data-slot="([^"]+)"\]\s*\{[^{}]*(?:transition|animation):(?!\s*none)/g)].map((m) => m[1]!);
    expect(animated).toContain("status-area");
    for (const slot of [...animated, "button", "tabs-trigger"]) expect(slots).toContain(slot);
  });
});
