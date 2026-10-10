// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GRAPH_LANES, GRAPH_PATH_SEGMENTS, HISTORY_PARENTS_PER_PAGE, HISTORY_STREAM_ROWS } from "../../src/contracts/limits";
import { AncestryCell, columnWidth, LANE_SPACING, SIDE_PADDING } from "../../src/frontend/history/AncestryCell";
import { BOUNDARY_TEXT, layoutHistory, type Cell, type Layout } from "../../src/frontend/history/lanes";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { buildF19, type F19Variant } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest, openService, type HistoryResult } from "./service-harness";

printOrigin("../../src/frontend/history/lanes.ts", import.meta.dir);
printOrigin("../../src/frontend/history/AncestryCell.tsx", import.meta.dir);
printOrigin("../../src/git-service/history.ts", import.meta.dir);

const TASK = "T118";
const TIMEOUT_MS = 120_000;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

async function read(repo: string): Promise<HistoryResult> {
  const service = await openService({ git: gitPath(), name: `t118-service-${crypto.randomUUID()}`, watchHints: false });
  try {
    const { repositoryId, generation } = await service.register(repo);
    const response = await service.readHistory(repositoryId, generation);
    expect({ state: response.state, completeness: response.result?.completeness }).toEqual({ state: "succeeded", completeness: { state: "complete" } });
    return response.result!;
  } finally {
    await service.dispose();
  }
}

const pages = new Map<string, Promise<HistoryResult>>();
const f19 = (variant: F19Variant) => {
  if (!pages.has(variant)) pages.set(variant, read(join(buildF19(gitPath(), `t118-f19-${variant}`, variant).root, "repo")));
  return pages.get(variant)!;
};

const inPage = (page: HistoryResult) => new Set(page.rows.map((r) => r.oid));

// Follows the edge from row `at` to `parent` down the lanes. It returns the row index of the parent node, or "outside" at an open continuation.
function trace(layout: Layout, at: number, parent: string): number | "outside" {
  const cells = layout.cells;
  const start = paths(cells[at]!).find((s) => s.from.at === "node" && s.to.at === "bottom" && laneOid(cells[at]!, s.to.lane, parent));
  if (start === undefined) throw new Error(`row ${at}: no edge to ${parent}`);
  if (start.shape === "continuation") return "outside";
  const lane = start.to.lane;
  for (let row = at + 1; row < cells.length; row++) {
    const cell = cells[row]!;
    expect(cell.input[lane]?.oid).toBe(parent);
    if (cell.oid === parent) {
      expect(paths(cell)).toContainEqual({ shape: "line", from: { lane, at: "top" }, to: { lane: cell.node, at: "node" }, color: cell.input[lane]!.color });
      return row;
    }
    expect(paths(cell)).toContainEqual({ shape: "line", from: { lane, at: "top" }, to: { lane, at: "bottom" }, color: cell.input[lane]!.color });
    // The lane ends here. Only an open continuation of the same parent may end it.
    if (cell.output[lane]?.oid !== parent) {
      expect(paths(cell).some((s) => s.shape === "continuation" && s.to.lane === lane)).toBe(true);
      return "outside";
    }
  }
  throw new Error(`row ${at}: the edge to ${parent} leaves the page without a continuation`);
}

type Path = Exclude<Cell["segments"][number], { shape: "stub" }>;
const paths = (cell: Cell): Path[] => cell.segments.filter((s): s is Path => s.shape !== "stub");

// The lane at the bottom of the row holds `parent`, or an open continuation to `parent` ends there.
function laneOid(cell: Cell, lane: number, parent: string): boolean {
  if (cell.output[lane]?.oid === parent) return true;
  return cell.marks.some((m) => m.kind === "outside" && m.parent === parent) && paths(cell).some((s) => s.shape === "continuation" && s.to.lane === lane);
}

const COMPLETE: F19Variant[] = ["linear", "merge", "octopus", "skewed", "roots", "long", "encoding", "shallow", "sha256"];

describe("lanes from F19 pages (plan.md \"History graph design\")", () => {
  for (const variant of COMPLETE) {
    caseTest(
      TASK,
      `F19 ${variant}: rows keep service order, and every ordered parent edge reaches its parent or an open continuation`,
      ["shell-double"],
      async () => {
        const page = await f19(variant);
        const layout = layoutHistory(page);
        expect(layout.limit).toBeNull();
        expect(layout.cells.map((c) => c.oid)).toEqual(page.rows.map((r) => r.oid));
        const index = new Map(page.rows.map((r, i) => [r.oid, i]));
        const loaded = inPage(page);
        page.rows.forEach((row, at) => {
          expect(layout.cells[at]!.merge).toBe(row.parents.length > 1);
          for (const parent of row.parents) expect(trace(layout, at, parent)).toBe(loaded.has(parent) ? index.get(parent)! : "outside");
        });
      },
      TIMEOUT_MS,
    );

    caseTest(
      TASK,
      `F19 ${variant}: the first parent keeps the node lane, lanes reuse free places, and pending lanes never move`,
      ["shell-double"],
      async () => {
        const page = await f19(variant);
        const layout = layoutHistory(page);
        layout.cells.forEach((cell, at) => {
          const row = page.rows[at]!;
          const first = row.parents[0];
          const pendingFirst = first !== undefined && cell.input.some((l) => l?.oid === first);
          if (first !== undefined && !pendingFirst) {
            const kept = cell.output[cell.node];
            if (kept === null || kept === undefined) expect(paths(cell)).toContainEqual({ shape: "continuation", from: { lane: cell.node, at: "node" }, to: { lane: cell.node, at: "bottom" }, color: cell.color });
            else expect(kept).toEqual({ oid: first, color: cell.color });
          }
          cell.input.forEach((lane, i) => {
            if (lane === null || lane.oid === row.oid) return;
            expect(cell.segments).toContainEqual({ shape: "line", from: { lane: i, at: "top" }, to: { lane: i, at: "bottom" }, color: lane.color });
            if (cell.output[i] !== null && cell.output[i] !== undefined) expect(cell.output[i]).toEqual(lane);
          });
          const ended = (i: number) => paths(cell).some((s) => s.shape === "continuation" && s.to.lane === i);
          cell.output.forEach((lane, j) => {
            if (lane === null || j === cell.node || cell.input[j]?.oid === lane.oid) return;
            for (let i = 0; i < j; i++) expect(cell.output[i] !== null || ended(i)).toBe(true);
          });
        });
      },
      TIMEOUT_MS,
    );

    caseTest(
      TASK,
      `F19 ${variant}: each new lane differs in color from its left and right neighbors and its originating lane, and the same page gives the same layout`,
      ["shell-double"],
      async () => {
        const page = await f19(variant);
        const layout = layoutHistory(page);
        layout.cells.forEach((cell) => {
          const tip = !cell.input.some((l) => l?.oid === cell.oid);
          cell.output.forEach((lane, j) => {
            if (lane === null) return;
            const isNew = j === cell.node ? tip && lane.color === cell.color : cell.input[j]?.oid !== lane.oid;
            if (!isNew) return;
            if (j > 0 && cell.output[j - 1]) expect(lane.color).not.toBe(cell.output[j - 1]!.color);
            if (cell.output[j + 1]) expect(lane.color).not.toBe(cell.output[j + 1]!.color);
            if (j !== cell.node) expect(lane.color).not.toBe(cell.color);
          });
        });
        expect(JSON.stringify(layoutHistory(structuredClone(page)))).toBe(JSON.stringify(layout));
      },
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "the three ends: an outside parent gets one dashed continuation, a shallow boundary gets a stub with bars, and a root gets no segment",
    ["shell-double"],
    async () => {
      const ends = new Map<string, Set<string>>();
      for (const variant of ["long", "shallow", "roots"] as const) {
        const page = await f19(variant);
        if (variant !== "long") expect(page.rows.some((r) => r.shallow)).toBe(variant === "shallow");
        const layout = layoutHistory(page);
        const continuations = layout.cells.flatMap((c) => c.segments.filter((s) => s.shape === "continuation"));
        expect(continuations).toHaveLength(page.boundaries.page.length);
        for (const outside of page.boundaries.page) {
          const children = layout.cells.filter((c) => c.marks.some((m) => m.kind === "outside" && m.parent === outside));
          expect(children.length).toBeGreaterThan(0);
          for (const child of children) expect(child.marks).toContainEqual({ kind: "outside", text: "Outside loaded page", parent: outside });
        }
        layout.cells.forEach((cell, at) => {
          const row = page.rows[at]!;
          const shapes = new Set(cell.segments.filter((s) => s.shape === "stub" || (s.from.at === "node" && s.to.at === "bottom")).map((s) => s.shape));
          if (row.parents.length > 0) return;
          const kind = row.shallow ? "shallow" : "root";
          expect(cell.marks).toEqual([{ kind, text: BOUNDARY_TEXT[kind], parent: null }]);
          expect([...shapes]).toEqual(kind === "shallow" ? ["stub"] : []);
          ends.set(kind, shapes);
        });
        if (variant === "long") ends.set("outside", new Set(continuations.map((s) => s.shape)));
      }
      expect(BOUNDARY_TEXT).toEqual({ outside: "Outside loaded page", shallow: "Shallow history boundary", root: "Root commit" });
      expect([...ends.keys()].sort()).toEqual(["outside", "root", "shallow"]);
      expect(ends.get("outside")).toEqual(new Set(["continuation"]));
      expect(ends.get("shallow")).toEqual(new Set(["stub"]));
      expect(ends.get("root")).toEqual(new Set());
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `F19 wide: more than ${GRAPH_LANES} lanes gives GRAPH_LAYOUT_LIMITED with node-only cells, all rows, and all parent text`,
    ["shell-double"],
    async () => {
      const page = await f19("wide");
      const layout = layoutHistory(page);
      expect(layout.limit).toEqual({ code: "GRAPH_LAYOUT_LIMITED", reached: "lanes" });
      checkNodeOnly(page, layout);
      expect(page.completeness.state).toBe("complete");
    },
    TIMEOUT_MS,
  );

  // Each row draws one segment per input lane and one per parent. A shallow stub replaces the parent segments of its row.
  // So a page within the contract §5 bounds draws at most 100 x 24 + 1,024 + 100 segments, which is below 4,096. No real page reaches the segment limit.
  test(`no page within ${GRAPH_LANES} lanes and the contract §5 history bounds reaches ${GRAPH_PATH_SEGMENTS} segments`, () => {
    expect(HISTORY_STREAM_ROWS * GRAPH_LANES + HISTORY_PARENTS_PER_PAGE + HISTORY_STREAM_ROWS).toBeLessThan(GRAPH_PATH_SEGMENTS);
  });

  test(`synthetic rows beyond the contract §5 bounds: more than ${GRAPH_PATH_SEGMENTS} segments within ${GRAPH_LANES} lanes gives reason segments`, () => {
    // Not a service result: 222 rows exceed HISTORY_STREAM_ROWS. The tip opens 21 lanes that stay open over a 200-commit chain.
    const oid = (n: number) => n.toString(16).padStart(40, "0");
    const side = Array.from({ length: 20 }, (_, i) => 1000 + i);
    const rows = [{ oid: oid(1), parents: [oid(2), ...side.map(oid)], shallow: false }];
    for (let n = 2; n <= 201; n++) rows.push({ oid: oid(n), parents: n === 201 ? [] : [oid(n + 1)], shallow: false });
    for (const n of side) rows.push({ oid: oid(n), parents: [], shallow: false });
    const page = { rows, boundaries: { page: [], shallow: [] } } as unknown as HistoryResult;
    const layout = layoutHistory(page);
    expect(layout.limit).toEqual({ code: "GRAPH_LAYOUT_LIMITED", reached: "segments" });
    checkNodeOnly(page, layout);
  });
});

// data-model.md "History page": "Layout overflow retains rows and parent text; it does not change Git eligibility or data completeness."
function checkNodeOnly(page: HistoryResult, layout: Layout) {
  expect(layout.lanes).toBe(1);
  expect(layout.cells.map((c) => c.oid)).toEqual(page.rows.map((r) => r.oid));
  const loaded = inPage(page);
  layout.cells.forEach((cell, at) => {
    const row = page.rows[at]!;
    expect({ node: cell.node, segments: cell.segments, input: cell.input, output: cell.output }).toEqual({ node: 0, segments: [], input: [], output: [] });
    expect(cell.merge).toBe(row.parents.length > 1);
    expect(cell.marks.filter((m) => m.kind === "outside").map((m) => m.parent)).toEqual(row.parents.filter((p) => !loaded.has(p)));
  });
}

// Ottosson's OKLab matrices (https://bottosson.github.io/posts/oklab/) and WCAG 2.2 relative luminance.
const linear = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = linear(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const hue = (hex: string) => {
  const [, a, b] = oklab(hex);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
};
const hueGap = (x: string, y: string) => {
  const d = Math.abs(hue(x) - hue(y));
  return Math.min(d, 360 - d);
};
const distance = (x: string, y: string) => Math.hypot(...oklab(x).map((v, i) => v - oklab(y)[i]!));
const luminance = (hex: string) => {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (x: string, y: string) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("lane palette (T124 index.css against the plan.md lane table)", () => {
  const css = readFileSync(join(import.meta.dir, "../../src/frontend/index.css"), "utf8");
  // `light-dark(<light>, <dark>)`.
  const role = (name: string) => {
    const match = new RegExp(`--${name}:\\s*light-dark\\((#[0-9A-Fa-f]{6}),\\s*(#[0-9A-Fa-f]{6})\\)`).exec(css);
    if (match === null) throw new Error(`index.css has no light-dark value for --${name}`);
    return { light: match[1]!.toUpperCase(), dark: match[2]!.toUpperCase() };
  };
  const LANES = ["teal", "sky", "violet", "magenta"] as const;
  const PLAN = {
    teal: { dark: "#4BB9B2", light: "#06726E" },
    sky: { dark: "#80D2F0", light: "#00516B" },
    violet: { dark: "#B59AE7", light: "#724AAB" },
    magenta: { dark: "#F7A6DF", light: "#993582" },
  };

  test("the lane values equal the plan.md lane table", () => {
    expect(Object.fromEntries(LANES.map((l) => [l, role(`lane-${l}`)]))).toEqual(PLAN);
  });

  for (const theme of ["dark", "light"] as const) {
    const lanes = LANES.map((l) => role(`lane-${l}`)[theme]);
    test(`${theme}: every lane pair has an OKLab distance of at least 0.10`, () => {
      for (let i = 0; i < lanes.length; i++) for (let j = i + 1; j < lanes.length; j++) expect(distance(lanes[i]!, lanes[j]!)).toBeGreaterThanOrEqual(0.1);
    });
    test(`${theme}: every lane hue lies at least 30 degrees in OKLCH from Accent, Added, Removed/error, and Warning`, () => {
      for (const semantic of ["accent-role", "added", "removed", "warning"]) for (const lane of lanes) expect(hueGap(lane, role(semantic)[theme])).toBeGreaterThanOrEqual(30);
    });
    test(`${theme}: every lane color reaches 3:1 against Canvas, Surface, and Selected row`, () => {
      for (const background of ["canvas", "surface", "selected-row"]) for (const lane of lanes) expect(contrast(lane, role(background)[theme])).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("ancestry cell (T135)", () => {
  const svg = (layout: Layout, at: number, selected = false, spacing: number = LANE_SPACING.compact, rowHeight = 26) =>
    renderToStaticMarkup(createElement(AncestryCell, { cell: layout.cells[at]!, lanes: layout.lanes, spacing, rowHeight, selected }));
  const attr = (html: string, name: string) => new RegExp(`<svg[^>]*\\s${name}="([^"]*)"`).exec(html)?.[1];
  const oid = (n: number) => n.toString(16).padStart(40, "0");
  const row = (n: number, parents: number[]) => ({ oid: oid(n), parents: parents.map(oid), shallow: false });
  // Contract values only: one merge whose second parent lies outside the page, then a root.
  const layout = layoutHistory({ rows: [row(1, [2, 9]), row(2, [])] });

  test("the column width is the lane count times the spacing plus the side padding, capped at 24 lanes", () => {
    expect(SIDE_PADDING).toBe(12);
    expect(LANE_SPACING).toEqual({ compact: 12, comfortable: 14 });
    expect(columnWidth(2, 12)).toBe(2 * 12 + 2 * 12);
    expect(columnWidth(30, 14)).toBe(GRAPH_LANES * 14 + 2 * 12);
    expect(attr(svg(layout, 0, false, 14, 34), "width")).toBe(String(columnWidth(layout.lanes, 14)));
    expect(attr(svg(layout, 0, false, 14, 34), "height")).toBe("34");
  });

  test("the cell is decorative: hidden from assistive technology, without a tab stop, label, or own hover", () => {
    const html = svg(layout, 0, true);
    expect(attr(html, "aria-hidden")).toBe("true");
    expect(attr(html, "focusable")).toBe("false");
    expect(html).not.toMatch(/tabindex|<text|onmouse|hover:/i);
    expect(attr(html, "class")).toContain("graph-cell");
    expect(attr(html, "class")).toContain("pointer-events-none");
  });

  test("a merge node is hollow, the outside parent draws the dashed continuation, and a selected node gets the Accent ring", () => {
    const html = svg(layout, 0, true);
    expect(html).toMatch(/<circle[^>]*class="[^"]*node-merge[^"]*"[^>]*r="3"/);
    expect(html).toMatch(/<path[^>]*class="[^"]*boundary-continuation/);
    expect(html).toMatch(/<circle[^>]*class="[^"]*accent-role[^"]*"[^>]*r="6"/);
    expect(svg(layout, 0, false)).not.toMatch(/accent-role/);
  });

  test("a root draws its node only, and a node-only cell of a limited page draws no path", () => {
    expect(svg(layout, 1)).not.toMatch(/boundary-/);
    const limited: Layout = { ...layout, lanes: 1, cells: layout.cells.map((c) => ({ ...c, node: 0, input: [], output: [], segments: [] })) };
    expect(svg(limited, 0)).not.toMatch(/<path/);
    expect(attr(svg(limited, 0), "width")).toBe(String(columnWidth(1, 12)));
  });
});
