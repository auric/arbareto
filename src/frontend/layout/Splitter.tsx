// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "cn";
import { splitterStep } from "./profiles";

type SplitterProps = {
  /** The accessible name, such as "Resize file lane". */
  label: string;
  /** The ARIA orientation of the rule: "vertical" separates left and right panes. */
  orientation: "vertical" | "horizontal";
  /** The size in DIPs of the pane that this splitter resizes. */
  value: number;
  min: number;
  max: number;
  /** The resized pane sits after the splitter, so moving the rule toward it shrinks it. */
  reverse?: boolean;
  onChange: (value: number) => void;
  /** The final value of a key step or of a pointer drag. A drag calls `onChange` on each move and this once, at its end. */
  onCommit?: (value: number) => void;
  className?: string;
};

const MIRROR: Record<string, string> = { ArrowUp: "ArrowDown", ArrowDown: "ArrowUp", ArrowLeft: "ArrowRight", ArrowRight: "ArrowLeft" };

/** An 8 DIP hit area with a thin visible rule (plan.md "Chosen layout, sizes, and DPI"). */
export function Splitter({ label, orientation, value, min, max, reverse = false, onChange, onCommit, className }: SplitterProps) {
  const drag = useRef<{ pointerId: number; start: number; value: number; last: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const vertical = orientation === "vertical";

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (!(event.key in MIRROR) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const key = reverse ? (MIRROR[event.key] ?? event.key) : event.key;
    const next = splitterStep(key, event.shiftKey, value, { min, max });
    if (next === value) return;
    onChange(next);
    onCommit?.(next);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, start: vertical ? event.clientX : event.clientY, value, last: null };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const delta = (vertical ? event.clientX : event.clientY) - current.start;
    const next = Math.min(Math.max(current.value + (reverse ? -delta : delta), min), max);
    if (next === value) return;
    current.last = next;
    onChange(next);
  };

  // Every path that ends the capture ends the drag: release, cancellation, and lost capture.
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (current.last !== null) onCommit?.(current.last);
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      data-dragging={dragging || undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      className={cn(
        "group relative flex shrink-0 touch-none select-none items-center justify-center",
        vertical ? "h-full w-2 cursor-col-resize" : "h-2 w-full cursor-row-resize",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("bg-divider group-hover:bg-control-border group-data-[dragging]:bg-control-border", vertical ? "h-full w-px" : "h-px w-full")}
      />
    </div>
  );
}
