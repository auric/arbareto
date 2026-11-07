// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

// Feature 004 spec FR-116, plan D20 "Keys in the tree". The texts follow the D20 table order.
const HINTS_HEADING = "Keys in the tree";
const HINT_MOVE_KEYS = "Up, Down";
const HINT_MOVE = "Go to the previous or the next row.";
const HINT_OPEN_KEYS = "Right";
const HINT_OPEN = "Open a closed row. On an open row, go to the first child.";
const HINT_CLOSE_KEYS = "Left";
const HINT_CLOSE = "Close an open row. On another row, go to the parent.";
const HINT_ENDS_KEYS = "Home, End";
const HINT_ENDS = "Go to the first or the last row.";
const HINT_ENTER_KEYS = "Enter";
const HINT_ENTER = "Open the submodule. On a folder row, open or close the folder.";
const HINT_MENU_KEYS = "Shift+F10, Menu key";
const HINT_MENU = "Open the row menu: Open submodule, Update, Copy path. A failed row adds Retry, and Show output when it has output. Folder rows have no menu.";
const HINTS_NO_ROOM = "Make the sidebar wider or the window taller to show the keys.";

const HINTS: readonly (readonly [string, string])[] = [
  [HINT_MOVE_KEYS, HINT_MOVE],
  [HINT_OPEN_KEYS, HINT_OPEN],
  [HINT_CLOSE_KEYS, HINT_CLOSE],
  [HINT_ENDS_KEYS, HINT_ENDS],
  [HINT_ENTER_KEYS, HINT_ENTER],
  [HINT_MENU_KEYS, HINT_MENU],
];

// D20 "Height": P_closed is the 1 px line, the 8 px top padding, and the 12 px bottom padding plus the button.
const CLOSED_EXTRA = 21;

export type KeyHintsForm = "open" | "closed" | "noRoom" | "hidden";

/** D20 "Fit rule": a height h fits when 0.4 × (H − h) keeps the reduced pane minimum. */
export function keyHintsForm(sidebarHeight: number, openHeight: number, closedHeight: number, reducedPaneMin: number, storedOpen: boolean): KeyHintsForm {
  const fits = (height: number) => 0.4 * (sidebarHeight - height) >= reducedPaneMin;
  if (!fits(closedHeight)) return "hidden";
  if (!fits(openHeight)) return "noRoom";
  return storedOpen ? "open" : "closed";
}

type Size = { slot: HTMLElement; sidebar: number; open: number; button: number };

export type TreeKeyHintsProps = {
  /** The last block of the sidebar column. Null: the panel uses the hidden form in place. */
  slot: HTMLElement | null;
  /** The stored open state. */
  open: boolean;
  onOpen?(open: boolean): void;
  /** `metrics(density, textScale).reducedPaneMin`. */
  min: number;
  buttonId: string;
  listId: string;
  /** The button lost its box while it had focus. */
  onBoxLost(): void;
};

export function TreeKeyHints({ slot, open, onOpen, min, buttonId, listId, onBoxLost }: TreeKeyHintsProps) {
  const reasonId = `${buttonId}-reason`;
  const content = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  // D20 "No toggle": the content block keeps its full layout in each form, so these heights never depend on the form.
  useLayoutEffect(() => {
    const column = slot?.parentElement;
    const block = content.current;
    const heading = button.current;
    if (slot == null || column == null || block === null || heading === null || typeof ResizeObserver === "undefined") return;
    const seen = new Map<Element, number>();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize[0];
        if (box !== undefined) seen.set(entry.target, box.blockSize);
      }
      const [sidebar, openHeight, buttonHeight] = [seen.get(column), seen.get(block), seen.get(heading)];
      if (sidebar !== undefined && openHeight !== undefined && buttonHeight !== undefined) setSize({ slot, sidebar, open: openHeight, button: buttonHeight });
    });
    for (const element of [column, block, heading]) observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [slot]);

  const measured = size !== null && size.slot === slot ? size : null;
  const closedHeight = measured === null ? 0 : CLOSED_EXTRA + measured.button;
  const form: KeyHintsForm = measured === null ? "hidden" : keyHintsForm(measured.sidebar, measured.open, closedHeight, min, open);
  const shownOpen = form === "open";
  const noRoom = form === "noRoom";

  // D20 "Keyboard": the DOM still holds the old form here, so this reads where the focus is before the button loses its box.
  const lost = useRef(false);
  if ((slot === null || form === "hidden") && button.current !== null && button.current === document.activeElement) lost.current = true;
  useLayoutEffect(() => {
    if (!lost.current) return;
    lost.current = false;
    onBoxLost();
  });

  const panel = (
    <div
      data-slot="key-hints"
      style={form === "hidden" ? { height: 0, overflow: "hidden", visibility: "hidden" } : { height: shownOpen ? measured!.open : closedHeight, overflow: "hidden" }}
    >
      <div ref={content} data-slot="key-hints-content" className="@container border-t border-divider bg-canvas px-3 pt-2 pb-3 text-text">
        <Tooltip disabled={!noRoom}>
          <TooltipTrigger
            render={
              <button
                ref={button}
                id={buttonId}
                type="button"
                aria-expanded={shownOpen}
                aria-controls={listId}
                aria-disabled={noRoom ? true : undefined}
                aria-describedby={noRoom ? reasonId : undefined}
                className="inline-flex items-center gap-1 text-start font-semibold"
                style={{ minHeight: "var(--h-row-button)" }}
                onClick={() => {
                  if (form === "open" || form === "closed") onOpen?.(!shownOpen);
                }}
              />
            }
          >
            <HugeiconsIcon icon={shownOpen ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
            {HINTS_HEADING}
          </TooltipTrigger>
          <TooltipContent>{HINTS_NO_ROOM}</TooltipContent>
        </Tooltip>
        {noRoom ? (
          <span id={reasonId} className="sr-only">
            {HINTS_NO_ROOM}
          </span>
        ) : null}
        {/* The space text nodes separate the texts in the accessible description. A grid ignores them in its layout. */}
        <dl id={listId} className="mt-1 grid gap-y-1 @min-[24em]:grid-cols-[max-content_minmax(0,1fr)] @min-[24em]:gap-x-3" style={shownOpen ? undefined : { visibility: "hidden" }}>
          {HINTS.map(([keys, hint], i) => (
            <Fragment key={keys}>
              {i === 0 ? null : " "}
              <dt>
                {keys.split(", ").map((key, k) => (
                  <Fragment key={key}>
                    {k === 0 ? null : ", "}
                    <kbd className="whitespace-nowrap">{key}</kbd>
                  </Fragment>
                ))}
              </dt>{" "}
              <dd className="pl-3 text-muted-text @min-[24em]:pl-0">{hint}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </div>
  );
  return slot === null ? panel : createPortal(panel, slot);
}
