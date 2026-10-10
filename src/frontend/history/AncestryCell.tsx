// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { GRAPH_LANES } from "../../contracts/limits";
import type { Cell, Point } from "./lanes";

// plan.md "History graph design": geometry in DIPs.
export const LANE_SPACING = { compact: 12, comfortable: 14 } as const;
export const SIDE_PADDING = 12;
const NODE_RADIUS = 3;
const RING_RADIUS = NODE_RADIUS + 3;
const PATH_WIDTH = 2;
const STUB = 6;
const BAR = 8;
const BAR_GAP = 2;

// Index order of `LANE_ROLES`. The `stroke` and `fill` attributes stay, because the index.css forced-colors rules select them.
const STROKE = ["stroke-(--lane-teal)", "stroke-(--lane-sky)", "stroke-(--lane-violet)", "stroke-(--lane-magenta)"];
const FILL = ["fill-(--lane-teal)", "fill-(--lane-sky)", "fill-(--lane-violet)", "fill-(--lane-magenta)"];

/** The graph column width. The HEAD and branch badges never widen it. */
export function columnWidth(lanes: number, spacing: number): number {
  return Math.min(lanes, GRAPH_LANES) * spacing + 2 * SIDE_PADDING;
}

export type AncestryCellProps = {
  cell: Cell;
  /** `Layout.lanes` of the page. */
  lanes: number;
  /** `LANE_SPACING` of the density. */
  spacing: number;
  /** The shared row height, grown by the text size. */
  rowHeight: number;
  selected: boolean;
};

/** One row's ancestry cell. It holds no label, and it follows the hover state of its row. */
export function AncestryCell({ cell, lanes, spacing, rowHeight, selected }: AncestryCellProps) {
  const x = (lane: number) => SIDE_PADDING + (lane + 0.5) * spacing;
  const middle = rowHeight / 2;
  const y = (p: Point) => (p.at === "top" ? 0 : p.at === "node" ? middle : rowHeight);
  const nx = x(cell.node);
  const width = columnWidth(lanes, spacing);
  return (
    <svg
      className="graph-cell pointer-events-none shrink-0"
      width={width}
      height={rowHeight}
      viewBox={`0 0 ${width} ${rowHeight}`}
      aria-hidden="true"
      focusable="false"
    >
      {cell.segments.map((s, i) => {
        if (s.shape === "stub") {
          const top = middle + NODE_RADIUS;
          const end = top + STUB;
          const bars = [end - BAR_GAP - PATH_WIDTH, end].map((by) => `M${x(s.lane) - BAR / 2} ${by}H${x(s.lane) + BAR / 2}`).join("");
          return <path key={i} className={`boundary-stub ${STROKE[s.color]}`} d={`M${x(s.lane)} ${top}V${end}${bars}`} fill="none" stroke="currentColor" strokeWidth={PATH_WIDTH} />;
        }
        const [x1, y1, x2, y2] = [x(s.from.lane), y(s.from), x(s.to.lane), y(s.to)];
        const ym = (y1 + y2) / 2;
        const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
        return s.shape === "continuation" ? (
          <path key={i} className={`boundary-continuation ${STROKE[s.color]}`} d={d} fill="none" stroke="currentColor" strokeWidth={PATH_WIDTH} />
        ) : (
          <path key={i} className={STROKE[s.color]} d={d} fill="none" stroke="currentColor" strokeWidth={PATH_WIDTH} strokeLinecap="round" strokeLinejoin="round" />
        );
      })}
      {cell.merge ? (
        <circle className={`node-merge ${STROKE[cell.color]} fill-(--canvas)`} cx={nx} cy={middle} r={NODE_RADIUS} fill="none" stroke="currentColor" strokeWidth={PATH_WIDTH} />
      ) : (
        <circle className={FILL[cell.color]} cx={nx} cy={middle} r={NODE_RADIUS} fill="currentColor" stroke="none" />
      )}
      {selected ? <circle className="stroke-(--accent-role)" cx={nx} cy={middle} r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth={PATH_WIDTH} /> : null}
    </svg>
  );
}
