// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T361: plan.md "Dark palettes". The values are the 2026-10-11 approved palettes; the pair list is the approved mockup list.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { printOrigin } from "../origin";
import { contrastRatio } from "../windows/contrast";
import { darkPaletteAttribute } from "../../src/frontend/state/preferences";
import { THEMES } from "../../src/frontend/highlight/set";

const CSS_PATH = printOrigin("../../src/frontend/index.css", import.meta.dir);
printOrigin("../../src/frontend/state/preferences.ts", import.meta.dir);
printOrigin("../../src/frontend/highlight/set.ts", import.meta.dir);

// The plan.md role and its `index.css` custom property.
const ROLES = {
  canvas: "--canvas",
  surface: "--surface",
  text: "--text",
  muted: "--muted-text",
  divider: "--divider",
  border: "--control-border",
  accent: "--accent-role",
  hover: "--hover-fill",
  sel: "--selected-row",
  addT: "--added",
  addF: "--added-fill",
  remT: "--removed",
  remF: "--removed-fill",
  warnT: "--warning",
  warnF: "--warning-fill",
  l0: "--lane-teal",
  l1: "--lane-sky",
  l2: "--lane-violet",
  l3: "--lane-magenta",
} as const;
type Role = keyof typeof ROLES;

const PALETTES: Record<"graphite" | "ink" | "warm", Record<Role, string>> = {
  graphite: { canvas: "#191B1F", surface: "#26292F", text: "#DADDE3", muted: "#9EA4AF", divider: "#353A42", border: "#6E7682", accent: "#7AA7F0", hover: "#31353C", sel: "#2B3A50", addT: "#7FD19B", addF: "#1C3326", remT: "#F09999", remF: "#3D2328", warnT: "#E2C06E", warnF: "#3A321C", l0: "#34AFA4", l1: "#88CEEF", l2: "#9F86E6", l3: "#F0A3D2" },
  ink: { canvas: "#171C24", surface: "#232B37", text: "#D5DCE6", muted: "#A6B0BF", divider: "#343F4F", border: "#6A7A95", accent: "#6FA8FF", hover: "#2E3744", sel: "#29405F", addT: "#7BD49A", addF: "#1A3328", remT: "#F3979B", remF: "#3E2229", warnT: "#E5BF63", warnF: "#3A3020", l0: "#35AEA1", l1: "#80CCEE", l2: "#9E89EE", l3: "#EDA0CF" },
  warm: { canvas: "#1B1A18", surface: "#292724", text: "#DCD8D0", muted: "#ABA69C", divider: "#3B3833", border: "#7A746C", accent: "#8AAEE8", hover: "#34312D", sel: "#2E3745", addT: "#8CCB94", addF: "#213020", remT: "#EE9C92", remF: "#3E2622", warnT: "#E0BF73", warnF: "#3A3222", l0: "#45AA9B", l1: "#95C7DF", l2: "#A58ED6", l3: "#E4A3C4" },
};

const css = readFileSync(CSS_PATH, "utf8");
/** The custom properties of the first rule whose selector is exactly `selector`: name to [light, dark]. */
function block(selector: string): Map<string, [string, string]> {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("\n}", start));
  const values = new Map<string, [string, string]>();
  for (const m of body.matchAll(/(--[a-z-]+):\s*light-dark\((#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\);/g)) values.set(m[1]!, [m[2]!.toUpperCase(), m[3]!.toUpperCase()]);
  return values;
}
const root = block(":root");
const SELECTORS = { graphite: ":root", ink: ':root[data-dark-palette="ink"]', warm: ':root[data-dark-palette="warm"]' } as const;

describe("token sets", () => {
  for (const [name, palette] of Object.entries(PALETTES) as [keyof typeof PALETTES, Record<Role, string>][]) {
    test(`${name}: one complete set of the 19 roles with the approved dark values and the unchanged light values`, () => {
      const set = block(SELECTORS[name]);
      for (const [role, property] of Object.entries(ROLES) as [Role, string][]) {
        const value = set.get(property);
        expect(value === undefined ? `${property} missing` : value[1]).toBe(palette[role]);
        // Light ignores the palette: every override keeps the root light value.
        expect(value?.[0]).toBe(root.get(property)![0]);
      }
      if (name !== "graphite") expect(set.size).toBe(19);
    });
  }

  test("the palette blocks hold only custom properties, so a switch shows at once without motion", () => {
    for (const selector of [SELECTORS.ink, SELECTORS.warm]) {
      const start = css.indexOf(`${selector} {`);
      const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
      for (const line of body.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("/*"))) expect(line.startsWith("--")).toBe(true);
    }
  });

  test("the root attribute is absent for Graphite and names Ink or Warm dark", () => {
    expect(darkPaletteAttribute("graphite")).toBeNull();
    expect(darkPaletteAttribute("ink")).toBe("ink");
    expect(darkPaletteAttribute("warm")).toBe("warm");
  });
});

const hex = (value: string) => Number.parseInt(value.slice(1), 16);
const ratio = (a: string, b: string) => contrastRatio(hex(a), hex(b));

describe("contrast of the approved pair list (W3C formula)", () => {
  // [foreground, background, needed ratio]. 0 marks a decorative pair.
  const PAIRS: [Role, Role, number][] = [
    ["text", "canvas", 4.5],
    ["text", "surface", 4.5],
    ["muted", "surface", 4.5],
    ["accent", "surface", 4.5],
    ["surface", "accent", 4.5],
    ["divider", "surface", 0],
    ["border", "surface", 3],
    ["text", "sel", 4.5],
    ["muted", "sel", 4.5],
    ["addT", "addF", 4.5],
    ["remT", "remF", 4.5],
    ["l0", "surface", 3],
    ["l1", "surface", 3],
    ["l2", "surface", 3],
    ["l3", "surface", 3],
    ["warnT", "warnF", 4.5],
    ["text", "warnF", 4.5],
  ];
  for (const [name, selector] of Object.entries(SELECTORS)) {
    test(`${name} passes every pair with its shipped values`, () => {
      const set = block(selector);
      const value = (role: Role) => set.get(ROLES[role])![1];
      for (const [fg, bg, need] of PAIRS) expect({ pair: `${fg}/${bg}`, pass: ratio(value(fg), value(bg)) >= need }).toEqual({ pair: `${fg}/${bg}`, pass: true });
    });
  }
});

describe("syntax colors of the shipped dark theme", () => {
  type Rule = { scope?: string | string[]; settings: { foreground?: string; background?: string } };
  test("every github-dark foreground without its own background reaches 4.5:1 on each palette Surface, Added fill, and Removed fill", async () => {
    const theme = (await THEMES["github-dark"]!.load()).default as { name: string; colors: Record<string, string>; tokenColors: Rule[] };
    expect(theme.name).toBe("github-dark");
    const colors = new Set([theme.colors["editor.foreground"]!, ...theme.tokenColors.filter((r) => r.settings.background === undefined).flatMap((r) => (r.settings.foreground ? [r.settings.foreground] : []))]);
    const below: string[] = [];
    for (const [name, palette] of Object.entries(PALETTES))
      for (const bg of ["surface", "addF", "remF"] as const)
        for (const color of colors) {
          const fg = color.slice(0, 7).toUpperCase();
          if (ratio(fg, palette[bg]) < 4.5) below.push(`${fg} on ${name} ${bg}: ${ratio(fg, palette[bg]).toFixed(2)}`);
        }
    expect(below).toEqual([]);
  });

  test("every github-dark rule with its own background reaches 4.5:1 on that background", async () => {
    const theme = (await THEMES["github-dark"]!.load()).default as { tokenColors: Rule[] };
    const own = theme.tokenColors.filter((r) => r.settings.background !== undefined && r.settings.foreground !== undefined);
    expect(own.length).toBeGreaterThan(0);
    const below = own.map((r) => ({ scope: r.scope, ratio: ratio(r.settings.foreground!.slice(0, 7), r.settings.background!.slice(0, 7)) })).filter((r) => r.ratio < 4.5);
    expect(below).toEqual([]);
  });
});

// plan.md "History graph design": lanes stay at least 30° in OKLCH hue from Accent, Added, Removed/error, and Warning.
// Björn Ottosson, "A perceptual color space for image processing" (2020): sRGB to OKLab.
function oklabHue(color: string): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(Number.parseInt(color.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}
const hueGap = (x: string, y: string) => {
  const d = Math.abs(oklabHue(x) - oklabHue(y)) % 360;
  return Math.min(d, 360 - d);
};

describe("lane hue rule", () => {
  const lanes: Role[] = ["l0", "l1", "l2", "l3"];
  const semantic: Role[] = ["accent", "addT", "remT", "warnT"];
  const themes: [string, (role: Role) => string][] = [
    ...Object.entries(SELECTORS).map(([name, selector]) => [name, (role: Role) => block(selector).get(ROLES[role])![1]] as [string, (role: Role) => string]),
    ["light", (role: Role) => root.get(ROLES[role])![0]],
  ];
  for (const [name, value] of themes) {
    test(`${name}: every lane stays at least 30° from Accent, Added, Removed/error, and Warning`, () => {
      const close = lanes.flatMap((l) => semantic.filter((s) => hueGap(value(l), value(s)) < 30).map((s) => `${l}/${s} ${hueGap(value(l), value(s)).toFixed(1)}`));
      expect(close).toEqual([]);
    });
  }
});
