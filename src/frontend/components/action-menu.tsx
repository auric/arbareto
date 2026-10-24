// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Fragment, useCallback, useId, type ComponentProps, type ReactElement } from "react";
import { isEditable } from "../keyboard/shortcuts";
import { RunningTooltip } from "./running-tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "./ui/dropdown-menu";

// Feature 004 plan.md D15 "Action menu", D16 danger rules, spec FR-014 and FR-085.

export type ActionItem = {
  label: string;
  /** The 16 px icon before the label (D16 "Geometry"). Without it, the slot stays empty, so the labels align. */
  icon?: IconSvgElement;
  /** `aria` is the `aria-keyshortcuts` value, `text` the visible key column. */
  keys?: { aria: string; text: string };
  /** The unavailable reason. The item then stays focusable and runs nothing. */
  reason?: string | null;
  /** Plan D15 running rule: the reason goes only into the tooltip and the accessible description. */
  running?: boolean;
  /** A destructive item uses the Removed text (D16). */
  danger?: boolean;
  onSelect(): void;
};

export type ActionGroup = readonly ActionItem[] | { label: string; items: readonly ActionItem[] };

export type ActionMenuProps = {
  /** The accessible name of the menu. */
  label: string;
  /** Item groups. A separator divides two groups. */
  /** Each group follows a separator. A labelled group starts with its label (feature 005 plan.md D15 "Delete from disk"). */
  groups: readonly ActionGroup[];
  open: boolean;
  onOpenChange(open: boolean): void;
  /** A button opens the menu. */
  trigger?: ReactElement;
  /** A row opens the menu by right-click, Shift+F10, or the Menu key, and the menu sits at that row. */
  anchor?: Element | null;
  /** Shift+F10 or the Menu key opened the menu. The focus then goes to the first item, also an unavailable one (spec FR-014). A right-click keeps the Base UI popup focus. */
  byKey?: boolean;
  finalFocus?: ComponentProps<typeof DropdownMenuContent>["finalFocus"];
  /** A fixed menu width in DIPs. An unavailable reason then wraps below its label (feature 005 plan.md D15 "Commit view row menu"). */
  width?: number;
};

/** The menu of D15. The accessible name of an item is its label only: the key goes to `aria-keyshortcuts`, and the key column is hidden from assistive technology. */
export function ActionMenu({ label, groups, open, onOpenChange, trigger, anchor, byKey = false, finalFocus, width }: ActionMenuProps) {
  // Base UI 1.8.0 records no open method without a trigger, so it focuses the popup. The focused item becomes the highlighted item.
  const focusFirst = useCallback((popup: HTMLDivElement | null) => void (byKey && popup?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()), [byKey]);
  return (
    <DropdownMenu open={open} onOpenChange={(next) => onOpenChange(next)}>
      {trigger === undefined ? null : <DropdownMenuTrigger render={trigger} />}
      {/* D16 "Geometry": a row menu opens beside its row, so the row stays visible. */}
      <DropdownMenuContent aria-label={label} anchor={anchor ?? undefined} side={anchor ? "inline-end" : "bottom"} sideOffset={2} ref={focusFirst} finalFocus={finalFocus} className="w-auto max-w-[calc(100vw-32px)] min-w-[220px]" style={width === undefined ? undefined : { width }}>
        {groups.map((group, index) => (
          <Fragment key={index}>
            {index === 0 ? null : <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              {"label" in group ? <DropdownMenuLabel className="flex h-6 items-center font-semibold text-muted-text">{group.label}</DropdownMenuLabel> : null}
              {("items" in group ? group.items : group).map((item) => (
                <Item key={item.label} item={item} below={width !== undefined} />
              ))}
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** D16 "Geometry": icon, label, the Muted reason of an unavailable item, then the key column, on one line. The texts wrap only beyond the menu width cap. */
function Item({ item, below }: { item: ActionItem; below: boolean }) {
  const reasonId = useId();
  const reason = item.reason ?? null;
  const quiet = reason !== null && item.running === true;
  const element = (
    <DropdownMenuItem
      disabled={reason !== null}
      aria-keyshortcuts={item.keys?.aria}
      aria-describedby={reason === null ? undefined : reasonId}
      data-danger={item.danger ? "true" : undefined}
      className={item.danger ? "danger-text" : undefined}
      onClick={reason === null ? item.onSelect : undefined}
    >
      <span data-slot="menu-icon" aria-hidden="true" className="flex size-4 shrink-0 items-center">
        {item.icon === undefined ? null : <HugeiconsIcon icon={item.icon} strokeWidth={2} className="size-4" />}
      </span>
      {below ? (
        <span data-slot="menu-text" className="flex min-w-0 flex-1 flex-col">
          <span data-slot="menu-label" className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
            {item.label}
          </span>
          {reason === null ? null : (
            <span id={reasonId} data-slot="menu-reason" aria-hidden="true" hidden={quiet} className="min-w-0 text-xs whitespace-normal text-muted-text [overflow-wrap:anywhere]">
              {reason}
            </span>
          )}
        </span>
      ) : (
        <>
          <span data-slot="menu-label" className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
            {item.label}
          </span>
          {reason === null ? null : (
            <span id={reasonId} data-slot="menu-reason" aria-hidden="true" hidden={quiet} className="ml-auto min-w-0 pl-4 text-xs whitespace-normal text-muted-text [overflow-wrap:anywhere]">
              {reason}
            </span>
          )}
        </>
      )}
      {item.keys === undefined ? null : (
        <DropdownMenuShortcut aria-hidden="true" className={`${reason === null || below ? "ml-auto " : ""}pl-4 text-xs tracking-normal whitespace-nowrap text-muted-text`}>
          {item.keys.text}
        </DropdownMenuShortcut>
      )}
    </DropdownMenuItem>
  );
  return <RunningTooltip reason={quiet ? reason : null}>{element}</RunningTooltip>;
}

/**
 * D15: the page cancels `contextmenu`, so WebView2 raises no `ContextMenuRequested`.
 * Editable fields and elements inside a `.select-text` region keep the built-in menu with Copy.
 * An element with its own action menu cancels the event in its own handler first, so it never shows the built-in menu.
 */
export function suppressPageMenu(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null;
  if (target === null || (!isEditable(target as HTMLElement) && target.closest(".select-text") === null)) event.preventDefault();
}
