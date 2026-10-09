// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// All values are DIPs. Sources: plan.md "Chosen layout, sizes, and DPI", "Compact token system", and "Dialog sizes".

export type Density = "compact" | "comfortable";
export type Profile = "wide" | "narrow" | "constrained";
export type Size = { width: number; height: number };

export const NATIVE_MINIMUM: Size = { width: 720, height: 480 };
export const FILE_LANE = { min: 240, max: 400, default: 280 } as const;
const WIDE_WIDTH = 1120;
const NARROW_WIDTH = 960;
const SPLITTER = 8;
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
  return {
    header: (c ? 40 : 44) + g,
    modeBar: bar,
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
    wideLaneMin: workingChangesMin + SPLITTER + stagedMin,
    statusAreaMin: bar + 2 * row,
    trayMin: (c ? 144 : 160) + g,
    trayDefault: c ? 168 : 192,
    wideComparisonMin: 240 + 2 * g,
    narrowComparisonMin: 220 + 2 * g,
    // The constrained comparison region grows through its heading and toolbar, as the narrow minimum does.
    constrainedRegionMin: 220 + 2 * g,
    historyListMin: 240,
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

const fixedRows = (m: Metrics, rows: number) => rows * m.header + m.modeBar + m.statusBar;

export function layoutFloor(profile: "wide" | "narrow", textScale: number, density: Density, rows: number): number {
  const m = metrics(density, textScale);
  const base = fixedRows(m, rows) + 2 * m.bandRow + m.statusAreaMin + m.trayMin;
  return profile === "wide"
    ? base + m.splitter + Math.max(m.wideComparisonMin, m.wideLaneMin)
    : base + 2 * m.splitter + m.workingChangesMin + m.narrowComparisonMin;
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

/** The work area height between the mode bar and the status bar. */
export function workAreaHeight(client: Size, textScale: number, density: Density): number {
  return client.height - fixedRows(metrics(density, textScale), headerRows(client.width, textScale));
}

export type PaneKind = "fileLane" | "tray" | "fileBand";
export type Bounds = { min: number; max: number; default: number };
type PaneInput = { width: number; available: number; density: Density; textScale: number };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** `available` is the work area height. */
export function paneBounds(kind: PaneKind, input: PaneInput): Bounds {
  if (kind === "fileLane") return { ...FILE_LANE };
  const m = metrics(input.density, input.textScale);
  if (kind === "tray") {
    const max = Math.max(m.trayMin, Math.min(0.35 * input.available, input.available - m.splitter - m.wideComparisonMin));
    return { min: m.trayMin, max, default: clamp(m.trayDefault, m.trayMin, max) };
  }
  const max = Math.max(160, m.workingChangesMin);
  return { min: m.workingChangesMin, max, default: clamp(128, m.workingChangesMin, max) };
}

export type ClampInput = { client: Size; textScale: number; density: Density; bandRows: number; statusArea: number; fileBand: number; tray: number };
export type ClampResult = { fileBand?: number; tray: number; comparison: number };

/**
 * Clamps the remembered sizes to the space that the profile leaves.
 * plan.md gives no shrink order. This shrinks the file band first, then the tray, in the order of plan.md "Default sizes do not always fit".
 */
export function clampPanes(input: ClampInput): ClampResult {
  const { client, textScale, density } = input;
  const m = metrics(density, textScale);
  const profile = chooseProfile(client, textScale, density);
  const bandMin = m.workingChangesMin;
  const bandMax = Math.max(160, bandMin);
  if (profile === "constrained") {
    // The work area scrolls, so only the bounds apply.
    return { fileBand: clamp(input.fileBand, bandMin, bandMax), tray: Math.max(input.tray, m.trayMin), comparison: m.constrainedRegionMin };
  }
  const workArea = workAreaHeight(client, textScale, density);
  const trayBounds = paneBounds("tray", { width: client.width, available: workArea, density, textScale });
  let tray = clamp(input.tray, trayBounds.min, trayBounds.max);
  const content = workArea - input.bandRows * m.bandRow - input.statusArea;
  if (profile === "wide") {
    const need = Math.max(m.wideComparisonMin, m.wideLaneMin);
    const room = content - m.splitter;
    tray = clamp(room - need, m.trayMin, tray);
    return { tray, comparison: Math.max(need, room - tray) };
  }
  const need = m.narrowComparisonMin;
  const room = content - 2 * m.splitter;
  let fileBand = clamp(input.fileBand, bandMin, bandMax);
  fileBand = clamp(room - need - tray, bandMin, fileBand);
  tray = clamp(room - need - fileBand, m.trayMin, tray);
  return { fileBand, tray, comparison: Math.max(need, room - fileBand - tray) };
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
    const sections =
      profile === "wide"
        ? m.splitter + Math.max(m.wideComparisonMin, m.wideLaneMin) + m.trayMin
        : 2 * m.splitter + m.workingChangesMin + m.narrowComparisonMin + m.trayMin;
    max = Math.min(max, workAreaHeight(client, textScale, density) - input.bandRows * m.bandRow - sections);
  }
  return clamp(input.content, m.statusAreaMin, Math.max(m.statusAreaMin, max));
}

export const DIALOG_DEFAULTS = {
  reviewCommit: { width: 640, height: 560 },
  trust: { width: 560, height: 440 },
  updateSubmodules: { width: 800, height: 600 },
  about: { width: 560, height: 480 },
} as const;

/** Each side is the smaller of the default and the client side minus 16 DIPs on each side. */
export function dialogSize(kind: keyof typeof DIALOG_DEFAULTS, client: Size): Size {
  const size = DIALOG_DEFAULTS[kind];
  return { width: Math.min(size.width, client.width - 2 * DIALOG_MARGIN), height: Math.min(size.height, client.height - 2 * DIALOG_MARGIN) };
}
