// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import {
  NATIVE_MINIMUM,
  chooseProfile,
  clampPanes,
  dialogSize,
  dockBounds,
  headerRows,
  historyFit,
  layoutFloor,
  metrics,
  overflowScroll,
  paneBounds,
  rememberedPanes,
  sidebarBounds,
  splitterStep,
  statusAreaHeight,
  workAreaHeight,
  type Density,
} from "../../src/frontend/layout/profiles";

printOrigin("../../src/frontend/layout/profiles.ts", import.meta.dir);

// All values are DIPs from plan.md "Chosen layout, sizes, and DPI", "Compact token system", and "Dialog sizes".
const DENSITIES: readonly Density[] = ["compact", "comfortable"];
const TEXT_100 = 1;
const TEXT_225 = 2.25;
const both = <T>(compact: T, comfortable: T) => (density: Density) => (density === "compact" ? compact : comfortable);

describe("profile choice", () => {
  test("the native minimum is 720x480", () => {
    expect(NATIVE_MINIMUM).toEqual({ width: 720, height: 480 });
  });

  test("wide needs width 1120 and the wide floor; narrow needs width 960 to 1119 and the narrow floor", () => {
    expect(chooseProfile({ width: 1120, height: 710 }, TEXT_100, "compact")).toBe("wide");
    expect(chooseProfile({ width: 1120, height: 709 }, TEXT_100, "compact")).toBe("constrained");
    expect(chooseProfile({ width: 1120, height: 778 }, TEXT_100, "comfortable")).toBe("wide");
    expect(chooseProfile({ width: 1120, height: 777 }, TEXT_100, "comfortable")).toBe("constrained");
    expect(chooseProfile({ width: 1119, height: 800 }, TEXT_100, "compact")).toBe("narrow");
    expect(chooseProfile({ width: 960, height: 800 }, TEXT_100, "compact")).toBe("narrow");
    expect(chooseProfile({ width: 960, height: 799 }, TEXT_100, "compact")).toBe("constrained");
    expect(chooseProfile({ width: 960, height: 884 }, TEXT_100, "comfortable")).toBe("narrow");
    expect(chooseProfile({ width: 960, height: 883 }, TEXT_100, "comfortable")).toBe("constrained");
    expect(chooseProfile({ width: 959, height: 2000 }, TEXT_100, "compact")).toBe("constrained");
    expect(chooseProfile({ width: 720, height: 480 }, TEXT_100, "compact")).toBe("constrained");
  });

  test("the plan.md sizes: 1280x800, 960x640, 1120x640, and 1120x700", () => {
    for (const density of DENSITIES) {
      expect(chooseProfile({ width: 1280, height: 800 }, TEXT_100, density)).toBe("wide");
      expect(chooseProfile({ width: 1280, height: 800 }, TEXT_225, density)).toBe("constrained");
      expect(chooseProfile({ width: 960, height: 640 }, TEXT_100, density)).toBe("constrained");
      expect(chooseProfile({ width: 1120, height: 640 }, TEXT_100, density)).toBe("constrained");
      expect(chooseProfile({ width: 1120, height: 700 }, TEXT_100, density)).toBe("constrained");
    }
  });

  test("band rows, the status area, and the repository path never change the result", () => {
    const content = { bandRows: 2, statusArea: 400, path: `C:\\${"long folder name\\".repeat(20)}repo`, distro: "x".repeat(30) };
    for (const client of [
      { width: 1280, height: 800 },
      { width: 960, height: 800 },
      { width: 1120, height: 710 },
      { width: 720, height: 480 },
    ]) {
      for (const density of DENSITIES) {
        for (const scale of [TEXT_100, TEXT_225]) {
          expect(chooseProfile({ ...client, ...content } as never, scale, density)).toBe(chooseProfile(client, scale, density));
        }
      }
    }
  });
});

describe("height budget", () => {
  test("header rows: one from 960 DIPs at 100% text, two at 225% text, two at 720 DIPs", () => {
    for (const width of [960, 1120, 1280]) expect(headerRows(width, TEXT_100)).toBe(1);
    for (const width of [720, 960, 1120, 1280]) expect(headerRows(width, TEXT_225)).toBe(2);
    expect(headerRows(720, TEXT_100)).toBe(2);
  });

  test("the floors at 100% text with one header row", () => {
    expect(layoutFloor("wide", TEXT_100, "compact", 1)).toBe(710);
    expect(layoutFloor("wide", TEXT_100, "comfortable", 1)).toBe(778);
    expect(layoutFloor("narrow", TEXT_100, "compact", 1)).toBe(800);
    expect(layoutFloor("narrow", TEXT_100, "comfortable", 1)).toBe(884);
  });

  test("the floors at 225% text with two header rows", () => {
    expect(layoutFloor("wide", TEXT_225, "compact", 2)).toBeCloseTo(1129.5, 6);
    expect(layoutFloor("wide", TEXT_225, "comfortable", 2)).toBeCloseTo(1281, 6);
    expect(layoutFloor("narrow", TEXT_225, "compact", 2)).toBeCloseTo(1245, 6);
    expect(layoutFloor("narrow", TEXT_225, "comfortable", 2)).toBeCloseTo(1378, 6);
  });

  test("each extra header row adds one grown header row to a floor", () => {
    expect(layoutFloor("wide", TEXT_225, "compact", 1)).toBeCloseTo(1067, 6);
    expect(layoutFloor("wide", TEXT_225, "comfortable", 1)).toBeCloseTo(1212, 6);
    for (const profile of ["wide", "narrow"] as const) {
      for (const density of DENSITIES) {
        for (const scale of [TEXT_100, 1.5, TEXT_225]) {
          const header = metrics(density, scale).header;
          expect(layoutFloor(profile, scale, density, 2) - layoutFloor(profile, scale, density, 1)).toBeCloseTo(header, 6);
          expect(layoutFloor(profile, scale, density, 3) - layoutFloor(profile, scale, density, 2)).toBeCloseTo(header, 6);
        }
      }
    }
  });

  test("every row of the plan.md client size table gives its profile and viewport", () => {
    const rows: [number, number, number, Density, string, number][] = [
      [1280, 800, TEXT_100, "compact", "wide", 728],
      [1280, 800, TEXT_100, "comfortable", "wide", 720],
      [1280, 800, TEXT_225, "compact", "constrained", 620.5],
      [1280, 800, TEXT_225, "comfortable", "constrained", 601],
      [1120, 700, TEXT_100, "compact", "constrained", 628],
      [1120, 700, TEXT_100, "comfortable", "constrained", 620],
      [960, 640, TEXT_100, "compact", "constrained", 568],
      [960, 640, TEXT_100, "comfortable", "constrained", 560],
      [960, 640, TEXT_225, "compact", "constrained", 460.5],
      [960, 640, TEXT_225, "comfortable", "constrained", 441],
      [720, 480, TEXT_100, "compact", "constrained", 368],
      [720, 480, TEXT_100, "comfortable", "constrained", 356],
      [720, 480, TEXT_225, "compact", "constrained", 300.5],
      [720, 480, TEXT_225, "comfortable", "constrained", 281],
    ];
    for (const [width, height, scale, density, profile, viewport] of rows) {
      expect(chooseProfile({ width, height }, scale, density)).toBe(profile as never);
      expect(workAreaHeight({ width, height }, scale, density)).toBeCloseTo(viewport, 6);
    }
  });
});

describe("density metrics and section minima", () => {
  test("fixed rows: header 40/44; stage bar, hunk toolbar, status bar, and pane headings 32/36; no mode bar", () => {
    for (const density of DENSITIES) {
      const m = metrics(density, TEXT_100);
      expect("modeBar" in m).toBe(false);
      expect(m.header).toBe(both(40, 44)(density));
      for (const height of [m.stageBar, m.hunkToolbar, m.statusBar, m.paneHeading, m.bandRow, m.areaHeading]) expect(height).toBe(both(32, 36)(density));
      expect(m.row).toBe(both(26, 34)(density));
      expect(m.button).toBe(both(28, 36)(density));
      expect(m.rowButton).toBe(both(24, 28)(density));
    }
  });

  test("each row that holds a control is at least 8 DIPs taller than its control", () => {
    for (const density of DENSITIES) {
      for (const scale of [TEXT_100, TEXT_225]) {
        const m = metrics(density, scale);
        expect(m.header - m.button).toBeGreaterThanOrEqual(8);
        for (const height of [m.stageBar, m.hunkToolbar, m.statusBar, m.paneHeading, m.bandRow, m.areaHeading]) expect(height - m.rowButton).toBeGreaterThanOrEqual(8);
      }
    }
  });

  test("section minima at 100% text", () => {
    for (const density of DENSITIES) {
      const m = metrics(density, TEXT_100);
      expect(m.subgroupHeading).toBe(both(26, 28)(density));
      expect(m.helpLine).toBe(both(18, 20)(density));
      expect(m.workingChangesMin).toBe(both(102, 118)(density));
      expect(m.stagedMin).toBe(both(58, 70)(density));
      expect(m.wideLaneMin).toBe(both(192, 224)(density));
      expect(m.statusAreaMin).toBe(both(84, 104)(density));
      expect(m.trayMin).toBe(both(144, 160)(density));
      expect(m.trayDefault).toBe(both(168, 192)(density));
      expect(m.wideComparisonMin).toBe(240);
      expect(m.narrowComparisonMin).toBe(220);
      expect(m.constrainedRegionMin).toBe(220);
      expect(m.historyListMin).toBe(both(58, 70)(density));
      expect(m.commitDetailsMin).toBe(both(58, 70)(density));
      expect(m.constrainedListMin).toBe(220);
      expect(m.reducedPaneMin).toBe(both(58, 70)(density));
      expect(m.splitter).toBe(8);
    }
  });

  test("the icon keeps 16 DIPs at every text size and density", () => {
    for (const density of DENSITIES) for (const scale of [TEXT_100, 1.5, TEXT_225]) expect(metrics(density, scale).icon).toBe(16);
  });

  test("text size grows each text-holding height by (factor - 1) x its 18/20 DIP line height", () => {
    const compact = metrics("compact", TEXT_225);
    expect(compact.header).toBeCloseTo(62.5, 6);
    expect(compact.stageBar).toBeCloseTo(54.5, 6);
    expect(compact.historyListMin).toBeCloseTo(103, 6);
    expect(compact.workingChangesMin).toBeCloseTo(192, 6);
    expect(compact.stagedMin).toBeCloseTo(103, 6);
    expect(compact.wideLaneMin).toBeCloseTo(349.5, 6);
    expect(compact.statusAreaMin).toBeCloseTo(151.5, 6);
    expect(compact.trayMin).toBeCloseTo(166.5, 6);
    expect(compact.wideComparisonMin).toBeCloseTo(285, 6);
    expect(compact.narrowComparisonMin).toBeCloseTo(265, 6);
    const comfortable = metrics("comfortable", TEXT_225);
    expect(comfortable.header).toBeCloseTo(69, 6);
    expect(comfortable.stageBar).toBeCloseTo(61, 6);
    expect(comfortable.historyListMin).toBeCloseTo(120, 6);
    expect(comfortable.workingChangesMin).toBeCloseTo(218, 6);
    expect(comfortable.stagedMin).toBeCloseTo(120, 6);
    expect(comfortable.wideLaneMin).toBeCloseTo(399, 6);
    expect(comfortable.statusAreaMin).toBeCloseTo(179, 6);
    expect(comfortable.trayMin).toBeCloseTo(185, 6);
    expect(comfortable.narrowComparisonMin).toBeCloseTo(270, 6);
  });
});

describe("pane bounds", () => {
  test("the wide file lane is 240 to 400 DIPs, 280 by default, with at least 520 DIPs for the diff", () => {
    for (const width of [1120, 1280, 1920]) {
      const lane = paneBounds("fileLane", { width, available: 696, density: "compact", textScale: TEXT_100 });
      expect(lane).toEqual({ min: 240, max: 400, default: 280 });
      expect(width - lane.max).toBeGreaterThanOrEqual(520);
    }
  });

  test("the tray: default 168/192, minimum 144/160, maximum 35% of the available height with 240 DIPs for the comparison", () => {
    for (const density of DENSITIES) {
      const tray = paneBounds("tray", { width: 1280, available: 696, density, textScale: TEXT_100 });
      expect(tray.default).toBe(both(168, 192)(density));
      expect(tray.min).toBe(both(144, 160)(density));
      expect(tray.max).toBeCloseTo(0.35 * 696, 6);
      expect(696 - tray.max).toBeGreaterThanOrEqual(240);
    }
  });

  test("the narrow file band: default 128, minimum the Working changes minimum, maximum the larger of 160 and that minimum", () => {
    for (const density of DENSITIES) {
      const band = paneBounds("fileBand", { width: 960, available: 700, density, textScale: TEXT_100 });
      expect(band).toEqual({ min: both(102, 118)(density), max: 160, default: 128 });
    }
    const grown = paneBounds("fileBand", { width: 960, available: 1000, density: "compact", textScale: TEXT_225 });
    expect(grown.min).toBeCloseTo(192, 6);
    expect(grown.max).toBeCloseTo(192, 6);
  });
});

describe("references sidebar width", () => {
  test("the width is 180 to 420 DIPs and 240 by default", () => {
    expect(sidebarBounds("wide", 1280)).toEqual({ min: 180, max: 420, default: 240 });
    expect(sidebarBounds("narrow", 960)).toEqual({ min: 180, max: 420, default: 240 });
  });

  test("the wide rest keeps 768 DIPs beside the sidebar splitter, so at 1120 DIPs the sidebar stops at 344", () => {
    expect(sidebarBounds("wide", 1120).max).toBe(344);
    expect(sidebarBounds("wide", 1150).max).toBe(374);
    for (const width of [1120, 1150, 1280, 1920]) expect(width - sidebarBounds("wide", width).max - 8).toBeGreaterThanOrEqual(768);
  });

  test("the narrow rest keeps the 520 DIP diff minimum", () => {
    for (const width of [960, 1000, 1119]) expect(width - sidebarBounds("narrow", width).max - 8).toBeGreaterThanOrEqual(520);
  });
});

describe("dock region", () => {
  const input = (density: Density, available: number, width = 1280) => ({ width, available, density, textScale: TEXT_100 });

  test("the commit panel defaults to the area minus the history heading, three history rows, and the splitter", () => {
    expect(dockBounds("commit", input("compact", 728)).default).toBe(728 - 32 - 3 * 26 - 8);
    expect(dockBounds("commit", input("comfortable", 720)).default).toBe(720 - 36 - 3 * 34 - 8);
  });

  test("the commit details default to 40% of the area", () => {
    expect(dockBounds("details", input("compact", 728)).default).toBeCloseTo(0.4 * 728, 6);
    expect(dockBounds("details", input("comfortable", 720)).default).toBeCloseTo(0.4 * 720, 6);
  });

  test("each panel keeps its minimum, and the history list keeps its minimum above the splitter", () => {
    for (const density of DENSITIES) {
      const m = metrics(density, TEXT_100);
      const available = both(728, 720)(density);
      const commit = dockBounds("commit", input(density, available));
      expect(commit.min).toBe(m.paneHeading + Math.max(m.wideComparisonMin, m.wideLaneMin) + m.splitter + m.trayMin);
      expect(commit.max).toBe(available - m.splitter - m.historyListMin);
      const narrow = dockBounds("commit", input(density, available, 960));
      expect(narrow.min).toBe(m.paneHeading + m.workingChangesMin + m.splitter + m.narrowComparisonMin + m.splitter + m.trayMin);
      const details = dockBounds("details", input(density, available));
      expect(details.min).toBe(m.commitDetailsMin);
      expect(details.max).toBe(available - m.splitter - m.historyListMin);
    }
  });
});

describe("clamping", () => {
  test("at 960x884 comfortable with both reserves in use, the list gives 68, the file band 10, and the tray 32", () => {
    const result = clampPanes({ client: { width: 960, height: 884 }, textScale: TEXT_100, density: "comfortable", bandRows: 2, statusArea: 104, fileBand: 128, tray: 192 });
    expect(result).toEqual({ list: 70, dock: 550, fileBand: 118, tray: 160, comparison: 220 });
  });

  test("in the wide profile, the history list shrinks first, then the tray", () => {
    const result = clampPanes({ client: { width: 1120, height: 710 }, textScale: TEXT_100, density: "compact", bandRows: 2, statusArea: 84, fileBand: 128, tray: 168 });
    expect(result).toEqual({ list: 58, dock: 424, tray: 144, comparison: 240 });
  });

  test("a remembered dock height that leaves room keeps its value", () => {
    const result = clampPanes({ client: { width: 1280, height: 800 }, textScale: TEXT_100, density: "compact", bandRows: 0, statusArea: 0, fileBand: 128, tray: 168, dock: 500 });
    expect(result).toEqual({ list: 220, dock: 500, tray: 168, comparison: 292 });
  });

  test("at each wide and narrow floor in both densities, all minima and both reserves fit", () => {
    for (const [profile, width] of [
      ["wide", 1120],
      ["narrow", 960],
    ] as const) {
      for (const density of DENSITIES) {
        for (const scale of [TEXT_100, TEXT_225]) {
          const m = metrics(density, scale);
          const rows = headerRows(width, scale);
          const height = layoutFloor(profile, scale, density, rows);
          expect(chooseProfile({ width, height }, scale, density)).toBe(profile);
          const result = clampPanes({ client: { width, height }, textScale: scale, density, bandRows: 2, statusArea: m.statusAreaMin, fileBand: 128, tray: m.trayDefault });
          expect(result.tray).toBeGreaterThanOrEqual(m.trayMin - 1e-6);
          const fixed = rows * m.header + m.statusBar + 2 * m.bandRow + m.statusAreaMin;
          const list = result.list ?? 0;
          expect(list).toBeGreaterThanOrEqual(m.historyListMin - 1e-6);
          expect(fixed + list + m.splitter + (result.dock ?? 0)).toBeCloseTo(height, 6);
          if (profile === "wide") {
            expect(result.comparison).toBeGreaterThanOrEqual(Math.max(m.wideComparisonMin, m.wideLaneMin) - 1e-6);
            expect(fixed + list + m.splitter + m.paneHeading + result.comparison + m.splitter + result.tray).toBeCloseTo(height, 6);
          } else {
            expect(result.fileBand).toBeGreaterThanOrEqual(m.workingChangesMin - 1e-6);
            expect(result.comparison).toBeGreaterThanOrEqual(m.narrowComparisonMin - 1e-6);
            expect(fixed + list + m.splitter + m.paneHeading + (result.fileBand ?? 0) + 2 * m.splitter + result.comparison + result.tray).toBeCloseTo(height, 6);
          }
        }
      }
    }
  });
});

// plan.md "Constrained sizes": the collapsed references heading row, the history list at the reduced pane minimum, and the commit panel heading take their height first.
// The other panes keep their minima, then shrink toward the reduced pane minimum. The work area scrolls only when the reduced minima do not fit.
describe("constrained sizes", () => {
  const input = (width: number, height: number, textScale: number, density: Density, bandRows = 0) => ({ client: { width, height }, textScale, density, bandRows, statusArea: 0 });

  test("the collapsed references section is one heading row of 32/36 DIPs, grown by the text-size rule", () => {
    expect(metrics("compact", TEXT_100).referencesCollapsed).toBe(32);
    expect(metrics("comfortable", TEXT_100).referencesCollapsed).toBe(36);
    expect(metrics("compact", TEXT_225).referencesCollapsed).toBeCloseTo(54.5, 6);
  });

  test("commit panel: the file band and the tray keep their minima, and the comparison takes the rest; remembered sizes do not apply", () => {
    for (const [width, height, scale, density, bandRows, expected] of [
      // plan.md example: 568 DIPs hold 32 + 58 + 32 + 82 + 220 + 144.
      [960, 640, TEXT_100, "compact", 0, { fileBand: 82, tray: 144, comparison: 220, scrolls: false }],
      [960, 640, TEXT_100, "comfortable", 0, { fileBand: 70, tray: 128, comparison: 220, scrolls: false }],
      [960, 640, TEXT_100, "compact", 2, { fileBand: 58, tray: 104, comparison: 220, scrolls: false }],
      // The file band shrinks first, then the tray, then the comparison.
      [1280, 800, TEXT_225, "compact", 0, { fileBand: 103, tray: 103, comparison: 202.5, scrolls: false }],
      // plan.md example: 368 DIPs hold 32 + 58 + 32 + 58 + 130 + 58.
      [720, 480, TEXT_100, "compact", 0, { fileBand: 58, tray: 58, comparison: 130, scrolls: false }],
      [720, 480, TEXT_100, "comfortable", 0, { fileBand: 70, tray: 70, comparison: 74, scrolls: false }],
      [720, 480, TEXT_100, "compact", 2, { fileBand: 58, tray: 58, comparison: 66, scrolls: false }],
      // plan.md: the reduced minima need 521 and 602 DIPs, more than the 300.5 and 281 DIP work areas.
      [720, 480, TEXT_225, "compact", 0, { fileBand: 103, tray: 103, comparison: 103, scrolls: true }],
      [720, 480, TEXT_225, "comfortable", 0, { fileBand: 120, tray: 120, comparison: 120, scrolls: true }],
    ] as const) {
      expect(chooseProfile({ width, height }, scale, density)).toBe("constrained");
      for (const remembered of [{ fileBand: 128, tray: 192 }, { fileBand: 160, tray: 400 }]) {
        const result = clampPanes({ ...input(width, height, scale, density, bandRows), ...remembered });
        expect(result.fileBand).toBeCloseTo(expected.fileBand, 6);
        expect(result.tray).toBeCloseTo(expected.tray, 6);
        expect(result.comparison).toBeCloseTo(expected.comparison, 6);
        expect(result.scrolls).toBe(expected.scrolls);
      }
    }
  });

  test("commit details: the details keep the reduced pane minimum, and the list keeps 220 DIPs, then shrinks to one row", () => {
    for (const [width, height, scale, density, bandRows, expected] of [
      [720, 480, TEXT_100, "compact", 0, { listMin: 220, scrolls: false }],
      [720, 480, TEXT_100, "compact", 2, { listMin: 182, scrolls: false }],
      [720, 480, TEXT_225, "compact", 0, { listMin: 88.5, scrolls: false }],
      [720, 480, TEXT_225, "comfortable", 0, { listMin: 59, scrolls: true }],
    ] as const) {
      const result = historyFit(input(width, height, scale, density, bandRows));
      expect(result.listMin).toBeCloseTo(expected.listMin, 6);
      expect(result.scrolls).toBe(expected.scrolls);
    }
  });

  test("the wide and narrow profiles never scroll the work area, and the history list keeps one row below its heading", () => {
    for (const density of DENSITIES) {
      expect(clampPanes({ ...input(1280, 800, TEXT_100, density, 2), statusArea: metrics(density, TEXT_100).statusAreaMin, fileBand: 128, tray: 192 }).scrolls).toBeFalsy();
      expect(historyFit(input(1280, 800, TEXT_100, density, 2))).toEqual({ listMin: metrics(density, TEXT_100).row, scrolls: false });
    }
  });
});

describe("splitter keys", () => {
  const bounds = { min: 240, max: 400 };
  test("arrow keys move 8 DIPs, Shift+Arrow moves 32, and Home/End reach the bounds", () => {
    expect(splitterStep("ArrowRight", false, 280, bounds)).toBe(288);
    expect(splitterStep("ArrowDown", false, 280, bounds)).toBe(288);
    expect(splitterStep("ArrowLeft", false, 280, bounds)).toBe(272);
    expect(splitterStep("ArrowUp", false, 280, bounds)).toBe(272);
    expect(splitterStep("ArrowRight", true, 280, bounds)).toBe(312);
    expect(splitterStep("ArrowLeft", true, 280, bounds)).toBe(248);
    expect(splitterStep("Home", false, 280, bounds)).toBe(240);
    expect(splitterStep("End", false, 280, bounds)).toBe(400);
  });

  test("steps stop at the bounds, and other keys keep the value", () => {
    expect(splitterStep("ArrowLeft", true, 250, bounds)).toBe(240);
    expect(splitterStep("ArrowRight", true, 390, bounds)).toBe(400);
    expect(splitterStep("Enter", false, 280, bounds)).toBe(280);
    expect(splitterStep("a", false, 280, bounds)).toBe(280);
  });
});

describe("remembered proportions", () => {
  test("a constrained layout never overwrites the remembered wide proportions", () => {
    const remembered = { fileLane: 320, tray: 200 };
    expect(rememberedPanes("constrained", remembered, { fileLane: 240, tray: 144 })).toEqual(remembered);
    expect(rememberedPanes("wide", remembered, { fileLane: 360, tray: 220 })).toEqual({ fileLane: 360, tray: 220 });
  });
});

describe("overflow", () => {
  const viewportHeight = 300;
  const visible = (box: { top: number; height: number }, scrollTop: number) => box.top >= scrollTop && box.top + box.height <= scrollTop + viewportHeight;

  test("a new band row or notice scrolls into view while the focused control stays visible", () => {
    const target = { top: 400, height: 40 };
    const focused = { top: 250, height: 30 };
    const scrollTop = overflowScroll({ scrollTop: 0, viewportHeight, target, focused });
    expect(visible(target, scrollTop)).toBe(true);
    expect(visible(focused, scrollTop)).toBe(true);
  });

  test("when both cannot show, the focused control stays visible", () => {
    const target = { top: 600, height: 40 };
    const focused = { top: 50, height: 30 };
    const scrollTop = overflowScroll({ scrollTop: 0, viewportHeight, target, focused });
    expect(visible(focused, scrollTop)).toBe(true);
  });

  test("without a focused control in the work area, the target scrolls into view", () => {
    const target = { top: 600, height: 40 };
    expect(visible(target, overflowScroll({ scrollTop: 0, viewportHeight, target, focused: null }))).toBe(true);
  });

  test("a target already in view keeps the scroll position", () => {
    expect(overflowScroll({ scrollTop: 100, viewportHeight, target: { top: 150, height: 40 }, focused: { top: 120, height: 30 } })).toBe(100);
  });
});

describe("status area height", () => {
  const huge = 10_000;
  test("at 1280x800 wide without a band, the maximum is 238 compact and 198 comfortable", () => {
    expect(statusAreaHeight({ content: huge, client: { width: 1280, height: 800 }, textScale: TEXT_100, density: "compact", bandRows: 0 })).toBeCloseTo(238, 6);
    expect(statusAreaHeight({ content: huge, client: { width: 1280, height: 800 }, textScale: TEXT_100, density: "comfortable", bandRows: 0 })).toBeCloseTo(198, 6);
  });

  test("the content height clamps up to the 84/104 DIP minimum", () => {
    expect(statusAreaHeight({ content: 10, client: { width: 1280, height: 800 }, textScale: TEXT_100, density: "compact", bandRows: 0 })).toBe(84);
    expect(statusAreaHeight({ content: 10, client: { width: 1280, height: 800 }, textScale: TEXT_100, density: "comfortable", bandRows: 0 })).toBe(104);
    expect(statusAreaHeight({ content: 150, client: { width: 1280, height: 800 }, textScale: TEXT_100, density: "compact", bandRows: 0 })).toBe(150);
  });

  test("at 720x480 and 100% text, the maximum is 168 DIPs", () => {
    for (const density of DENSITIES) {
      expect(statusAreaHeight({ content: huge, client: { width: 720, height: 480 }, textScale: TEXT_100, density, bandRows: 0 })).toBeCloseTo(168, 6);
    }
  });

  test("at 720x480 and 225% text, the minimum is 151.5/179, and the comfortable maximum becomes its minimum", () => {
    const client = { width: 720, height: 480 };
    expect(statusAreaHeight({ content: 0, client, textScale: TEXT_225, density: "compact", bandRows: 0 })).toBeCloseTo(151.5, 6);
    expect(statusAreaHeight({ content: huge, client, textScale: TEXT_225, density: "compact", bandRows: 0 })).toBeCloseTo(168, 6);
    expect(statusAreaHeight({ content: 0, client, textScale: TEXT_225, density: "comfortable", bandRows: 0 })).toBeCloseTo(179, 6);
    expect(statusAreaHeight({ content: huge, client, textScale: TEXT_225, density: "comfortable", bandRows: 0 })).toBeCloseTo(179, 6);
  });
});

describe("dialog sizes", () => {
  const DEFAULTS = {
    reviewCommit: { width: 640, height: 560 },
    trust: { width: 560, height: 440 },
    updateSubmodules: { width: 800, height: 600 },
    about: { width: 560, height: 480 },
  } as const;

  test("each dialog takes its default size when the client has room", () => {
    for (const [kind, size] of Object.entries(DEFAULTS)) expect(dialogSize(kind as keyof typeof DEFAULTS, { width: 1280, height: 800 })).toEqual(size);
  });

  test("each side is the smaller of the default and the client side minus 32 DIPs", () => {
    const client = { width: 720, height: 480 };
    expect(dialogSize("reviewCommit", client)).toEqual({ width: 640, height: 448 });
    expect(dialogSize("trust", client)).toEqual({ width: 560, height: 440 });
    expect(dialogSize("updateSubmodules", client)).toEqual({ width: 688, height: 448 });
    expect(dialogSize("about", client)).toEqual({ width: 560, height: 448 });
    for (const kind of Object.keys(DEFAULTS)) {
      const size = dialogSize(kind as keyof typeof DEFAULTS, client);
      expect(size.width).toBeLessThanOrEqual(688);
      expect(size.height).toBeLessThanOrEqual(448);
    }
  });
});
