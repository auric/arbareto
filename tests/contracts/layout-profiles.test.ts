// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import {
  NATIVE_MINIMUM,
  chooseProfile,
  clampPanes,
  dialogSize,
  headerRows,
  historyFit,
  layoutFloor,
  metrics,
  overflowScroll,
  paneBounds,
  rememberedPanes,
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
    expect(chooseProfile({ width: 1120, height: 644 }, TEXT_100, "compact")).toBe("wide");
    expect(chooseProfile({ width: 1120, height: 643 }, TEXT_100, "compact")).toBe("constrained");
    expect(chooseProfile({ width: 1120, height: 700 }, TEXT_100, "comfortable")).toBe("wide");
    expect(chooseProfile({ width: 1120, height: 699 }, TEXT_100, "comfortable")).toBe("constrained");
    expect(chooseProfile({ width: 1119, height: 800 }, TEXT_100, "compact")).toBe("narrow");
    expect(chooseProfile({ width: 960, height: 734 }, TEXT_100, "compact")).toBe("narrow");
    expect(chooseProfile({ width: 960, height: 733 }, TEXT_100, "compact")).toBe("constrained");
    expect(chooseProfile({ width: 960, height: 806 }, TEXT_100, "comfortable")).toBe("narrow");
    expect(chooseProfile({ width: 960, height: 805 }, TEXT_100, "comfortable")).toBe("constrained");
    expect(chooseProfile({ width: 959, height: 2000 }, TEXT_100, "compact")).toBe("constrained");
    expect(chooseProfile({ width: 720, height: 480 }, TEXT_100, "compact")).toBe("constrained");
  });

  test("the plan.md sizes: 1280x800, 960x640, 1120x640, and 1120x700", () => {
    for (const density of DENSITIES) {
      expect(chooseProfile({ width: 1280, height: 800 }, TEXT_100, density)).toBe("wide");
      expect(chooseProfile({ width: 1280, height: 800 }, TEXT_225, density)).toBe("constrained");
      expect(chooseProfile({ width: 960, height: 640 }, TEXT_100, density)).toBe("constrained");
      expect(chooseProfile({ width: 1120, height: 640 }, TEXT_100, density)).toBe("constrained");
      expect(chooseProfile({ width: 1120, height: 700 }, TEXT_100, density)).toBe("wide");
    }
  });

  test("band rows, the status area, and the repository path never change the result", () => {
    const content = { bandRows: 2, statusArea: 400, path: `C:\\${"long folder name\\".repeat(20)}repo`, distro: "x".repeat(30) };
    for (const client of [
      { width: 1280, height: 800 },
      { width: 960, height: 734 },
      { width: 1120, height: 644 },
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
    expect(layoutFloor("wide", TEXT_100, "compact", 1)).toBe(644);
    expect(layoutFloor("wide", TEXT_100, "comfortable", 1)).toBe(700);
    expect(layoutFloor("narrow", TEXT_100, "compact", 1)).toBe(734);
    expect(layoutFloor("narrow", TEXT_100, "comfortable", 1)).toBe(806);
  });

  test("the floors at 225% text with two header rows", () => {
    expect(layoutFloor("wide", TEXT_225, "compact", 2)).toBeCloseTo(972, 6);
    expect(layoutFloor("wide", TEXT_225, "comfortable", 2)).toBeCloseTo(1100, 6);
    expect(layoutFloor("narrow", TEXT_225, "compact", 2)).toBeCloseTo(1134, 6);
    expect(layoutFloor("narrow", TEXT_225, "comfortable", 2)).toBeCloseTo(1250, 6);
  });

  test("each extra header row adds one grown header row to a floor", () => {
    expect(layoutFloor("wide", TEXT_225, "compact", 1)).toBeCloseTo(909.5, 6);
    expect(layoutFloor("wide", TEXT_225, "comfortable", 1)).toBeCloseTo(1031, 6);
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
      [1280, 800, TEXT_100, "compact", "wide", 696],
      [1280, 800, TEXT_100, "comfortable", "wide", 684],
      [1280, 800, TEXT_225, "compact", "constrained", 566],
      [1280, 800, TEXT_225, "comfortable", "constrained", 540],
      [960, 640, TEXT_100, "compact", "constrained", 536],
      [960, 640, TEXT_100, "comfortable", "constrained", 524],
      [960, 640, TEXT_225, "compact", "constrained", 406],
      [960, 640, TEXT_225, "comfortable", "constrained", 380],
      [720, 480, TEXT_100, "compact", "constrained", 336],
      [720, 480, TEXT_100, "comfortable", "constrained", 320],
      [720, 480, TEXT_225, "compact", "constrained", 246],
      [720, 480, TEXT_225, "comfortable", "constrained", 220],
    ];
    for (const [width, height, scale, density, profile, viewport] of rows) {
      expect(chooseProfile({ width, height }, scale, density)).toBe(profile as never);
      expect(workAreaHeight({ width, height }, scale, density)).toBeCloseTo(viewport, 6);
    }
  });
});

describe("density metrics and section minima", () => {
  test("fixed rows: header 40/44, mode bar, hunk toolbar, status bar, and pane headings 32/36", () => {
    for (const density of DENSITIES) {
      const m = metrics(density, TEXT_100);
      expect(m.header).toBe(both(40, 44)(density));
      for (const height of [m.modeBar, m.hunkToolbar, m.statusBar, m.paneHeading, m.bandRow, m.areaHeading]) expect(height).toBe(both(32, 36)(density));
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
        for (const height of [m.modeBar, m.hunkToolbar, m.statusBar, m.paneHeading, m.bandRow, m.areaHeading]) expect(height - m.rowButton).toBeGreaterThanOrEqual(8);
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
      expect(m.wideLaneMin).toBe(both(168, 196)(density));
      expect(m.statusAreaMin).toBe(both(84, 104)(density));
      expect(m.trayMin).toBe(both(144, 160)(density));
      expect(m.trayDefault).toBe(both(168, 192)(density));
      expect(m.wideComparisonMin).toBe(240);
      expect(m.narrowComparisonMin).toBe(220);
      expect(m.constrainedRegionMin).toBe(220);
      expect(m.historyListMin).toBe(240);
      expect(m.constrainedListMin).toBe(220);
      expect(m.reducedPaneMin).toBe(both(58, 70)(density));
      expect(m.splitter).toBe(8);
    }
  });

  test("text size grows each text-holding height by (factor - 1) x its 18/20 DIP line height", () => {
    const compact = metrics("compact", TEXT_225);
    expect(compact.header).toBeCloseTo(62.5, 6);
    expect(compact.modeBar).toBeCloseTo(54.5, 6);
    expect(compact.workingChangesMin).toBeCloseTo(192, 6);
    expect(compact.stagedMin).toBeCloseTo(103, 6);
    expect(compact.wideLaneMin).toBeCloseTo(303, 6);
    expect(compact.statusAreaMin).toBeCloseTo(151.5, 6);
    expect(compact.trayMin).toBeCloseTo(166.5, 6);
    expect(compact.wideComparisonMin).toBeCloseTo(285, 6);
    expect(compact.narrowComparisonMin).toBeCloseTo(265, 6);
    const comfortable = metrics("comfortable", TEXT_225);
    expect(comfortable.header).toBeCloseTo(69, 6);
    expect(comfortable.modeBar).toBeCloseTo(61, 6);
    expect(comfortable.workingChangesMin).toBeCloseTo(218, 6);
    expect(comfortable.stagedMin).toBeCloseTo(120, 6);
    expect(comfortable.wideLaneMin).toBeCloseTo(346, 6);
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

describe("clamping", () => {
  test("at 960x806 comfortable with both reserves in use, the band and tray clamp leaves 220 DIPs for the comparison", () => {
    const result = clampPanes({ client: { width: 960, height: 806 }, textScale: TEXT_100, density: "comfortable", bandRows: 2, statusArea: 104, fileBand: 128, tray: 192 });
    expect(result).toEqual({ fileBand: 118, tray: 160, comparison: 220 });
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
          const fixed = rows * m.header + m.modeBar + m.statusBar + 2 * m.bandRow + m.statusAreaMin;
          if (profile === "wide") {
            expect(result.comparison).toBeGreaterThanOrEqual(Math.max(m.wideComparisonMin, m.wideLaneMin) - 1e-6);
            expect(fixed + m.splitter + result.tray + result.comparison).toBeCloseTo(height, 6);
          } else {
            expect(result.fileBand).toBeGreaterThanOrEqual(m.workingChangesMin - 1e-6);
            expect(result.comparison).toBeGreaterThanOrEqual(m.narrowComparisonMin - 1e-6);
            expect(fixed + 2 * m.splitter + (result.fileBand ?? 0) + result.tray + result.comparison).toBeCloseTo(height, 6);
          }
        }
      }
    }
  });
});

// plan.md "Constrained sizes": the panes keep their minima, then shrink toward the reduced pane minimum. The work area scrolls only when the reduced minima do not fit.
describe("constrained sizes", () => {
  const input = (width: number, height: number, textScale: number, density: Density, bandRows = 0) => ({ client: { width, height }, textScale, density, bandRows, statusArea: 0 });

  test("Changes: the file band and the tray keep their minima, and the comparison takes the rest; remembered sizes do not apply", () => {
    for (const [width, height, scale, density, bandRows, expected] of [
      [960, 640, TEXT_100, "compact", 0, { fileBand: 102, tray: 144, comparison: 290, scrolls: false }],
      [960, 640, TEXT_100, "comfortable", 0, { fileBand: 118, tray: 160, comparison: 246, scrolls: false }],
      [960, 640, TEXT_100, "compact", 2, { fileBand: 102, tray: 144, comparison: 226, scrolls: false }],
      // The file band shrinks first, then the tray, then the comparison.
      [1280, 800, TEXT_225, "compact", 0, { fileBand: 134.5, tray: 166.5, comparison: 265, scrolls: false }],
      [720, 480, TEXT_100, "compact", 0, { fileBand: 58, tray: 58, comparison: 220, scrolls: false }],
      [720, 480, TEXT_100, "comfortable", 0, { fileBand: 70, tray: 70, comparison: 180, scrolls: false }],
      [720, 480, TEXT_100, "compact", 2, { fileBand: 58, tray: 58, comparison: 156, scrolls: false }],
      // Three reduced minima exceed the 246 and 220 DIP work areas.
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

  test("History: the inspector keeps the reduced pane minimum, and the list keeps 220 DIPs, then shrinks to one row", () => {
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

  test("the wide and narrow profiles never scroll the work area, and the History list keeps 240 DIPs", () => {
    for (const density of DENSITIES) {
      expect(clampPanes({ ...input(1280, 800, TEXT_100, density, 2), statusArea: metrics(density, TEXT_100).statusAreaMin, fileBand: 128, tray: 192 }).scrolls).toBeFalsy();
      expect(historyFit(input(1280, 800, TEXT_100, density, 2))).toEqual({ listMin: 240, scrolls: false });
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
  test("at 1280x800 wide without a band, the maximum is 280 compact and 276 comfortable", () => {
    expect(statusAreaHeight({ content: huge, client: { width: 1280, height: 800 }, textScale: TEXT_100, density: "compact", bandRows: 0 })).toBeCloseTo(280, 6);
    expect(statusAreaHeight({ content: huge, client: { width: 1280, height: 800 }, textScale: TEXT_100, density: "comfortable", bandRows: 0 })).toBeCloseTo(276, 6);
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
