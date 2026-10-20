// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { Panel } from "../keyboard/shortcuts";

// All values are DIPs. Sources: plan.md "Chosen layout, sizes, and DPI", "Compact token system", and "Dialog sizes".

export type Density = "compact" | "comfortable";
export type Profile = "wide" | "narrow" | "constrained";
export type Size = { width: number; height: number };

export const NATIVE_MINIMUM: Size = { width: 720, height: 480 };
export const FILE_LANE = { min: 240, max: 400, default: 280 } as const;
// plan.md "References sidebar". The width stays in DIPs at every text size.
export const SIDEBAR = { min: 180, max: 420, default: 240 } as const;
// The width beside the sidebar: the 240 lane minimum, the lane splitter, and the 520 diff minimum; narrow keeps the diff minimum.
const SIDEBAR_REST = { wide: 768, narrow: 520 } as const;
const WIDE_WIDTH = 1120;
const NARROW_WIDTH = 960;
const SPLITTER = 8;
const DIFF_MIN = 520;
const DIALOG_MARGIN = 16;

export type Metrics = ReturnType<typeof metrics>;

/** The density table, with each text-holding height grown by (textScale - 1) x the 18/20 DIP line height. */
export function metrics(density: Density, textScale: number) {
  const c = density === "compact";
  const g = (textScale - 1) * (c ? 18 : 20);
  const bar = (c ? 32 : 36) + g;
  const row = (c ? 26 : 34) + g;
  const subgroupHeading = (c ? 26 : 28) + g;
  const helpLine = (c ? 18 : 20) + g;
  const workingChangesMin = bar + subgroupHeading + helpLine + row;
  const stagedMin = bar + row;
  // One pane heading and one row: the smallest pane.
  const reducedPaneMin = bar + row;
  return {
    header: (c ? 40 : 44) + g,
    stageBar: bar,
    hunkToolbar: bar,
    statusBar: bar,
    paneHeading: bar,
    bandRow: bar,
    areaHeading: bar,
    row,
    button: (c ? 28 : 36) + g,
    rowButton: (c ? 24 : 28) + g,
    subgroupHeading,
    helpLine,
    workingChangesMin,
    stagedMin,
    wideLaneMin: workingChangesMin + bar + stagedMin,
    statusAreaMin: bar + 2 * row,
    trayMin: (c ? 144 : 160) + g,
    trayDefault: c ? 168 : 192,
    wideComparisonMin: 240 + 2 * g,
    narrowComparisonMin: 220 + 2 * g,
    // The constrained comparison region grows through its heading and toolbar, as the narrow minimum does.
    constrainedRegionMin: 220 + 2 * g,
    historyListMin: reducedPaneMin,
    commitDetailsMin: reducedPaneMin,
    // The rows region of the history list while the commit details are docked in the constrained profile.
    constrainedListMin: 220,
    reducedPaneMin,
    // The heading row with the Show references toggle.
    referencesCollapsed: bar,
    icon: 16,
    splitter: SPLITTER,
  };
}

/** plan.md has no header row count for this width and text size. T157 measures it. */
export class UnmeasuredLayoutError extends RangeError {
  readonly code = "HEADER_ROWS_UNMEASURED";
  constructor(readonly width: number, readonly textScale: number) {
    super(`No measured header row count for width ${width} at text scale ${textScale}.`);
  }
}

/** Only the plan.md header row estimates: one row from 960 DIPs at 100% text, two at 720 DIPs, and two at 225% text. */
export function headerRows(width: number, textScale: number): number {
  if (textScale === 1 && width >= NARROW_WIDTH) return 1;
  if (textScale === 1 && width === NATIVE_MINIMUM.width) return 2;
  if (textScale === 2.25 && width >= NATIVE_MINIMUM.width) return 2;
  throw new UnmeasuredLayoutError(width, textScale);
}

const fixedRows = (m: Metrics, rows: number) => rows * m.header + m.statusBar;

/** The commit panel minimum: its heading, the content row or the file band and the comparison, the splitters, and the tray minimum. */
function commitPanelMin(m: Metrics, wide: boolean): number {
  return m.paneHeading + m.splitter + m.trayMin + (wide ? Math.max(m.wideComparisonMin, m.wideLaneMin) : m.workingChangesMin + m.splitter + m.narrowComparisonMin);
}

/** plan.md "Height budget": the fixed rows, the band and area reserves, the history list minimum, the dock splitter, and the commit panel minimum. */
export function layoutFloor(profile: "wide" | "narrow", textScale: number, density: Density, rows: number): number {
  const m = metrics(density, textScale);
  return fixedRows(m, rows) + 2 * m.bandRow + m.statusAreaMin + m.historyListMin + m.splitter + commitPanelMin(m, profile === "wide");
}

/** Only the client size, the text scale, and the density choose the profile. Content never does. */
export function chooseProfile(client: Size, textScale: number, density: Density): Profile {
  if (client.width < NARROW_WIDTH) return "constrained";
  const profile = client.width >= WIDE_WIDTH ? "wide" : "narrow";
  let rows: number;
  try {
    rows = headerRows(client.width, textScale);
  } catch (error) {
    // plan.md "Height budget": a measurement can require the constrained profile above the nominal floor.
    if (error instanceof UnmeasuredLayoutError) return "constrained";
    throw error;
  }
  return client.height >= layoutFloor(profile, textScale, density, rows) ? profile : "constrained";
}

/** The work area height between the header rows and the status bar. */
export function workAreaHeight(client: Size, textScale: number, density: Density): number {
  return client.height - fixedRows(metrics(density, textScale), headerRows(client.width, textScale));
}

export type PaneKind = "fileLane" | "tray" | "fileBand";
export type Bounds = { min: number; max: number; default: number };
type PaneInput = { width: number; available: number; density: Density; textScale: number };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** `available` is the work area height. */
export function paneBounds(kind: PaneKind, input: PaneInput): Bounds {
  if (kind === "fileLane") {
    // plan.md "Chosen layout, sizes, and DPI": the diff keeps 520 DIPs beside the lane and its splitter. `width` is the panel width.
    const max = Math.max(FILE_LANE.min, Math.min(FILE_LANE.max, input.width - DIFF_MIN - SPLITTER));
    return { min: FILE_LANE.min, max, default: clamp(FILE_LANE.default, FILE_LANE.min, max) };
  }
  const m = metrics(input.density, input.textScale);
  if (kind === "tray") {
    const max = Math.max(m.trayMin, Math.min(0.35 * input.available, input.available - m.splitter - m.wideComparisonMin));
    return { min: m.trayMin, max, default: clamp(m.trayDefault, m.trayMin, max) };
  }
  const max = Math.max(160, m.workingChangesMin);
  return { min: m.workingChangesMin, max, default: clamp(128, m.workingChangesMin, max) };
}

/**
 * Feature 004 plan.md D16 "Geometry": the Commit view has no references sidebar, so its width is the client width.
 * Outside the constrained profile, the lists sit left of the diff when that width holds the lane minimum, the splitter, and the diff minimum.
 */
export function commitViewProfile(profile: Profile, width: number): Profile {
  return profile === "narrow" && width >= FILE_LANE.min + SPLITTER + DIFF_MIN ? "wide" : profile;
}

/** plan.md "References sidebar": the sidebar width in the wide and narrow profiles. */
export function sidebarBounds(profile: "wide" | "narrow", width: number): Bounds {
  const max = Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, width - SIDEBAR_REST[profile] - SPLITTER));
  return { min: SIDEBAR.min, max, default: clamp(SIDEBAR.default, SIDEBAR.min, max) };
}

/**
 * plan.md "Dock region". `available` is the height of the history list, the dock splitter, and the dock.
 * The commit panel default keeps the history heading and three rows in view. The commit details default to 40%.
 */
export function dockBounds(panel: Panel, input: PaneInput): Bounds {
  const m = metrics(input.density, input.textScale);
  const min = panel === "commit" ? commitPanelMin(m, input.width >= WIDE_WIDTH) : m.commitDetailsMin;
  const max = input.available - m.splitter - m.historyListMin;
  const preferred = panel === "commit" ? input.available - m.paneHeading - 3 * m.row - m.splitter : 0.4 * input.available;
  return { min, max, default: clamp(preferred, min, max) };
}

export type FitInput = { client: Size; textScale: number; density: Density; bandRows: number; statusArea: number };
/** `dock` is the remembered commit panel height. Without it, the commit panel default applies. */
export type ClampInput = FitInput & { fileBand: number; tray: number; dock?: number };
/** `list` and `dock` exist in the wide and narrow profiles. `scrolls` is true only when the constrained work area cannot hold the reduced pane minima. */
export type ClampResult = { list?: number; dock?: number; fileBand?: number; tray: number; comparison: number; scrolls?: boolean };

/** The constrained pane height: the work area less the band rows and the status area. A size without a plan.md header row count takes two rows. */
function constrainedContent(input: FitInput, m: Metrics): number {
  let rows = 2;
  try {
    rows = headerRows(input.client.width, input.textScale);
  } catch (error) {
    if (!(error instanceof UnmeasuredLayoutError)) throw error;
  }
  return input.client.height - fixedRows(m, rows) - input.bandRows * m.bandRow - input.statusArea;
}

/**
 * Clamps the remembered commit panel sizes to the space that the profile leaves (plan.md "Default sizes do not always fit").
 * The history list shrinks first. Then the file band and the tray shrink in the narrow profile, and the tray in the wide profile.
 */
export function clampPanes(input: ClampInput): ClampResult {
  const { client, textScale, density } = input;
  const m = metrics(density, textScale);
  const profile = chooseProfile(client, textScale, density);
  const bandMin = m.workingChangesMin;
  const bandMax = Math.max(160, bandMin);
  if (profile === "constrained") {
    // plan.md "Constrained sizes": no splitter, so remembered sizes do not apply.
    // The references heading row, the history list, and the commit panel heading come first. The file band shrinks first, then the tray, then the comparison.
    const rest = constrainedContent(input, m) - m.referencesCollapsed - m.historyListMin - m.paneHeading;
    const fileBand = clamp(rest - m.constrainedRegionMin - m.trayMin, m.reducedPaneMin, bandMin);
    const tray = clamp(rest - m.constrainedRegionMin - fileBand, m.reducedPaneMin, m.trayMin);
    const comparison = Math.max(m.reducedPaneMin, rest - fileBand - tray);
    return { fileBand, tray, comparison, scrolls: fileBand + tray + comparison > rest };
  }
  const wide = profile === "wide";
  const workArea = workAreaHeight(client, textScale, density);
  const trayBounds = paneBounds("tray", { width: client.width, available: workArea, density, textScale });
  let tray = clamp(input.tray, trayBounds.min, trayBounds.max);
  let fileBand = clamp(input.fileBand, bandMin, bandMax);
  const content = workArea - input.bandRows * m.bandRow - input.statusArea;
  const bounds = dockBounds("commit", { width: client.width, available: content, density, textScale });
  // The dock grows into the history list until the comparison keeps its minimum beside the remembered file band and tray.
  const need = m.paneHeading + m.splitter + tray + (wide ? Math.max(m.wideComparisonMin, m.wideLaneMin) : fileBand + m.splitter + m.narrowComparisonMin);
  const dock = clamp(Math.max(input.dock ?? bounds.default, need), bounds.min, bounds.max);
  const list = content - m.splitter - dock;
  if (wide) {
    const row = Math.max(m.wideComparisonMin, m.wideLaneMin);
    const room = dock - m.paneHeading - m.splitter;
    tray = clamp(room - row, m.trayMin, tray);
    return { list, dock, tray, comparison: room - tray };
  }
  const room = dock - m.paneHeading - 2 * m.splitter;
  fileBand = clamp(room - m.narrowComparisonMin - tray, bandMin, fileBand);
  tray = clamp(room - m.narrowComparisonMin - fileBand, m.trayMin, tray);
  return { list, dock, fileBand, tray, comparison: room - fileBand - tray };
}

/**
 * The rows region minimum of the history list while the commit details are docked.
 * plan.md "Constrained sizes": the details keep the reduced pane minimum, and the list keeps 220 DIPs, then shrinks to one row.
 */
export function historyFit(input: FitInput): { listMin: number; scrolls: boolean } {
  const m = metrics(input.density, input.textScale);
  if (chooseProfile(input.client, input.textScale, input.density) !== "constrained") return { listMin: m.row, scrolls: false };
  const content = constrainedContent(input, m);
  const fixed = m.referencesCollapsed + m.paneHeading + m.commitDetailsMin;
  const listMin = clamp(content - fixed, m.row, m.constrainedListMin);
  return { listMin, scrolls: fixed + listMin > content };
}

/** Arrow keys move 8 DIPs, Shift+Arrow 32, and Home/End reach the bounds. Other keys keep the value. */
export function splitterStep(key: string, shift: boolean, value: number, bounds: { min: number; max: number }): number {
  const step = shift ? 32 : 8;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return clamp(value + step, bounds.min, bounds.max);
    case "ArrowLeft":
    case "ArrowUp":
      return clamp(value - step, bounds.min, bounds.max);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return value;
  }
}

/** A constrained layout never overwrites the remembered wide proportions. */
export function rememberedPanes<T extends object>(profile: Profile, remembered: T, current: Partial<T>): T {
  return profile === "constrained" ? remembered : { ...remembered, ...current };
}

type Box = { top: number; height: number };

/** Scrolls the target into view. The focused control stays visible and wins when both cannot show. */
export function overflowScroll(input: { scrollTop: number; viewportHeight: number; target: Box; focused: Box | null }): number {
  const { scrollTop, viewportHeight, target, focused } = input;
  const reach = (box: Box) => (box.top < scrollTop ? box.top : box.top + box.height > scrollTop + viewportHeight ? box.top + box.height - viewportHeight : scrollTop);
  const wanted = reach(target);
  if (!focused) return Math.max(0, wanted);
  return Math.max(0, clamp(wanted, focused.top + focused.height - viewportHeight, focused.top));
}

/** The content height between the 84/104 DIP minimum and the plan.md "Status area" maximum. */
export function statusAreaHeight(input: { content: number; client: Size; textScale: number; density: Density; bandRows: number }): number {
  const { client, textScale, density } = input;
  const m = metrics(density, textScale);
  const profile = chooseProfile(client, textScale, density);
  let max = 0.35 * client.height;
  if (profile !== "constrained") {
    const sections = m.historyListMin + m.splitter + commitPanelMin(m, profile === "wide");
    max = Math.min(max, workAreaHeight(client, textScale, density) - input.bandRows * m.bandRow - sections);
  }
  return clamp(input.content, m.statusAreaMin, Math.max(m.statusAreaMin, max));
}

export const DIALOG_DEFAULTS = {
  trust: { width: 560, height: 440 },
  about: { width: 560, height: 480 },
} as const;

/** Each side is the smaller of the default and the client side minus 16 DIPs on each side. */
export function dialogSize(kind: keyof typeof DIALOG_DEFAULTS, client: Size): Size {
  const size = DIALOG_DEFAULTS[kind];
  return { width: Math.min(size.width, client.width - 2 * DIALOG_MARGIN), height: Math.min(size.height, client.height - 2 * DIALOG_MARGIN) };
}
