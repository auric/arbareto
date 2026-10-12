// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { GRAPH_LANES } from "../../contracts/limits";
import type { ViewRow } from "../state/history-view";

/** The `readHistoryRows` cell (contract Δ3, data-model §4). The service lays out every row. */
export type ViewGraphCell = NonNullable<ViewRow["cell"]>;
type Point = { lane: number; at: "top" | "node" | "bottom" };

/** The texts of the cell marks (data-model §4). */
export const BOUNDARY_TEXT: Record<ViewGraphCell["marks"][number], string> = { shallow: "Shallow history boundary", root: "Root commit" };

// plan.md "History graph design": geometry in DIPs.
export const LANE_SPACING = { compact: 12, comfortable: 14 } as const;
export const SIDE_PADDING = 12;
const NODE_RADIUS = 3;
const RING_RADIUS = NODE_RADIUS + 3;
const PATH_WIDTH = 2;
const STUB = 6;
const BAR = 8;
const BAR_GAP = 2;

// The plan.md lane roles teal, sky, violet, and magenta, in color index order. The `stroke` and `fill` attributes stay, because the index.css forced-colors rules select them.
const STROKE = ["stroke-(--lane-teal)", "stroke-(--lane-sky)", "stroke-(--lane-violet)", "stroke-(--lane-magenta)"];
const FILL = ["fill-(--lane-teal)", "fill-(--lane-sky)", "fill-(--lane-violet)", "fill-(--lane-magenta)"];

/** The graph column width. The HEAD and branch badges never widen it. */
export function columnWidth(lanes: number, spacing: number): number {
  return Math.min(lanes, GRAPH_LANES) * spacing + 2 * SIDE_PADDING;
}

export type AncestryCellProps = {
  /** The most lanes of the view (contract Δ3 `lanes`). */
  lanes: number;
  /** `LANE_SPACING` of the density. */
  spacing: number;
  /** The shared row height, grown by the text size. */
  rowHeight: number;
  selected: boolean;
  /** The HEAD row: the dotted Working directory line runs from the top edge to the node. */
  leadIn?: boolean;
};

// plan.md "History graph design": the dotted lane-0 line of the Working directory and Index rows.
const DOT = "1 3";

function WorkingLine({ x, from, to }: { x: number; from: number; to: number }) {
  return <path className="working-line stroke-(--muted-text)" d={`M${x} ${from}V${to}`} fill="none" stroke="currentColor" strokeWidth={PATH_WIDTH} strokeDasharray={DOT} strokeLinecap="round" />;
}

export type WorkingLineCellProps = Pick<AncestryCellProps, "lanes" | "spacing" | "rowHeight"> & {
  /** `start` begins at the row center, below the Working directory text. `through` crosses the Index row. */
  part: "start" | "through";
  /** False on a page without rows: an unborn branch shows no line. */
  line: boolean;
};

/** The graph cell of the Working directory or Index row. It draws no node of its own. */
export function WorkingLineCell({ lanes, spacing, rowHeight, part, line }: WorkingLineCellProps) {
  const width = columnWidth(lanes, spacing);
  return (
    <svg className="graph-cell pointer-events-none shrink-0" width={width} height={rowHeight} viewBox={`0 0 ${width} ${rowHeight}`} aria-hidden="true" focusable="false">
      {line ? <WorkingLine x={SIDE_PADDING + 0.5 * spacing} from={part === "start" ? rowHeight / 2 : 0} to={rowHeight} /> : null}
    </svg>
  );
}

// Spec FR-034: a skip edge is dashed, so it differs from a direct edge without color.
const SKIP_DASH = "4 3";

/** One row's service cell. Lane colors repeat the four plan.md lane roles. */
export function ViewCell({ cell, lanes, spacing, rowHeight, selected, leadIn = false }: AncestryCellProps & { cell: ViewGraphCell }) {
  const x = (lane: number) => SIDE_PADDING + (lane + 0.5) * spacing;
  const middle = rowHeight / 2;
  const y = (p: Point) => (p.at === "top" ? 0 : p.at === "node" ? middle : rowHeight);
  const role = (color: number) => color % STROKE.length;
  const nx = x(cell.node);
  const width = columnWidth(lanes, spacing);
  return (
    <svg className="graph-cell pointer-events-none shrink-0" width={width} height={rowHeight} viewBox={`0 0 ${width} ${rowHeight}`} aria-hidden="true" focusable="false">
      {cell.segments.map((s, i) => {
        if (s.shape === "stub") {
          const top = middle + NODE_RADIUS;
          const end = top + STUB;
          const bars = [end - BAR_GAP - PATH_WIDTH, end].map((by) => `M${x(s.lane) - BAR / 2} ${by}H${x(s.lane) + BAR / 2}`).join("");
          return <path key={i} className={`boundary-stub ${STROKE[role(s.color)]}`} d={`M${x(s.lane)} ${top}V${end}${bars}`} fill="none" stroke="currentColor" strokeWidth={PATH_WIDTH} />;
        }
        const [x1, y1, x2, y2] = [x(s.from.lane), y(s.from), x(s.to.lane), y(s.to)];
        const ym = (y1 + y2) / 2;
        const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
        return (
          <path
            key={i}
            className={`${s.skip ? "skip-edge " : ""}${STROKE[role(s.color)]}`}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={PATH_WIDTH}
            strokeDasharray={s.skip ? SKIP_DASH : undefined}
            strokeLinecap={s.skip ? "butt" : "round"}
            strokeLinejoin="round"
          />
        );
      })}
      {leadIn ? <WorkingLine x={x(0)} from={0} to={middle - NODE_RADIUS} /> : null}
      {cell.merge ? (
        <circle className={`node-merge ${STROKE[role(cell.color)]} fill-(--canvas)`} cx={nx} cy={middle} r={NODE_RADIUS} fill="none" stroke="currentColor" strokeWidth={PATH_WIDTH} />
      ) : (
        <circle className={FILL[role(cell.color)]} cx={nx} cy={middle} r={NODE_RADIUS} fill="currentColor" stroke="none" />
      )}
      {selected ? <circle className="stroke-(--accent-role)" cx={nx} cy={middle} r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth={PATH_WIDTH} /> : null}
    </svg>
  );
}
