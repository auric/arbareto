// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// Feature 004 plan.md D15 "Switcher popover": the pattern of the 001 `RepositorySwitcher`, spec FR-008 and FR-086.

// A list above this size renders only the rows near the visible area, as the 001 changes list does.
const VIRTUAL_MIN = 200;
// 001 RecentList loading text.
const LOADING_TEXT = "Loading…";

export type SwitcherPopoverProps<T> = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The trigger button. It carries the accessible name. */
  trigger: ReactElement;
  /** The visible content of the trigger. */
  children: ReactNode;
  tooltip: string;
  filterLabel: string;
  listLabel: string;
  /** The row height in DIPs (`metrics(...).row`). */
  rowHeight: number;
  /** Null while the list loads. */
  items: readonly T[] | null;
  /** The visible state of a failed read. It replaces the list. */
  failure?: ReactNode;
  itemKey(item: T): string;
  /** The text that the filter matches. */
  itemText(item: T): string;
  /** The accessible name of an option. The default is `itemText`. */
  itemLabel?(item: T): string;
  renderItem(item: T): ReactNode;
  onPick(item: T): void;
  /** The last option, such as "New branch… (Ctrl+B)". The filter never hides it. */
  footer?: { label: string; onPick(): void };
  emptyText: string;
  noMatchText: string;
};

/** The 001 switcher rule: a literal substring match without regard to letter case. */
export const matches = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase());

export function SwitcherPopover<T>({ open, onOpenChange, trigger, children, tooltip, ...list }: SwitcherPopoverProps<T>) {
  return (
    <Popover open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={trigger} />}>{children}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      {/* 001 plan.md "Dialog sizes": at most 480 DIPs wide and 60% of the client height. */}
      <PopoverContent align="start" className="max-h-[min(60vh,calc(100vh-32px))] w-[min(480px,calc(100vw-32px))]">
        {open ? <SwitcherList {...list} /> : null}
      </PopoverContent>
    </Popover>
  );
}

function SwitcherList<T>({ rowHeight, filterLabel, listLabel, items, failure, itemKey, itemText, itemLabel = itemText, renderItem, onPick, footer, emptyText, noMatchText }: Omit<SwitcherPopoverProps<T>, "open" | "onOpenChange" | "trigger" | "children" | "tooltip">) {
  const ids = { list: useId(), option: useId() };
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const shown = (items ?? []).filter((item) => matches(itemText(item), query));
  const count = shown.length + (footer === undefined ? 0 : 1);
  const active = Math.min(activeIndex, Math.max(0, count - 1));
  const optionId = (index: number) => `${ids.option}-${index}`;
  const virtual = count > VIRTUAL_MIN;
  const virtualizer = useVirtualizer({
    count,
    enabled: virtual,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    useFlushSync: false,
    // The active option stays mounted, so `aria-activedescendant` names an element.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      return indexes.includes(active) ? indexes : [...indexes, active].sort((a, b) => a - b);
    },
  });

  function pick(index: number) {
    if (index < shown.length) onPick(shown[index]!);
    else footer?.onPick();
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.max(0, Math.min(count - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
      setActiveIndex(next);
      if (virtual) virtualizer.scrollToIndex(next);
    } else if (event.key === "Enter" && count > 0) {
      event.preventDefault();
      pick(active);
    }
  }

  const option = (index: number, style?: CSSProperties) => {
    const item = index < shown.length ? shown[index]! : null;
    return (
      <div
        key={item === null ? "footer" : itemKey(item)}
        id={optionId(index)}
        role="option"
        aria-selected={index === active}
        aria-label={item === null ? undefined : itemLabel(item)}
        className={`list-row flex min-w-0 items-center gap-2 px-2 ${index === active ? "bg-hover-fill" : ""}`}
        style={style}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setActiveIndex(index);
          pick(index);
        }}
      >
        {item === null ? footer!.label : renderItem(item)}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* Base UI focuses the first tabbable element of the popup, so the filter field has the first focus. */}
      <input
        role="combobox"
        aria-label={filterLabel}
        aria-expanded="true"
        aria-controls={ids.list}
        aria-autocomplete="list"
        aria-activedescendant={count === 0 ? undefined : optionId(active)}
        className="h-(--h-button) shrink-0 rounded-sm border border-control-border bg-surface px-2"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      {failure ?? (
        <>
          <div ref={scroller} id={ids.list} role="listbox" aria-label={listLabel} className="min-h-0 overflow-y-auto">
            {virtual ? (
              <div role="presentation" className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((v) => option(v.index, { position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }))}
              </div>
            ) : (
              Array.from({ length: count }, (_, index) => option(index))
            )}
          </div>
          {items === null ? <p className="text-muted-text">{LOADING_TEXT}</p> : items.length === 0 ? <p className="text-muted-text">{emptyText}</p> : shown.length === 0 ? <p className="text-muted-text">{noMatchText}</p> : null}
        </>
      )}
    </div>
  );
}
