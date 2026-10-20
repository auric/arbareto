// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowRight01Icon, Delete02Icon, FolderOpenIcon, FolderRemoveIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ActionMenu } from "../components/action-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { KEYS } from "../keyboard/shortcuts";
import { entryLabel, folderOf, type WorktreeActions, type WorktreeEntry } from "./WorktreeActions";
import { WorktreeRow } from "./WorktreeButton";
import { W } from "./texts";

// Feature 004 spec FR-050 and FR-051, plan.md D15 "P2 regions", the Worktrees board: the sidebar Worktrees group.
// shortcut: plain rows, at most WORKTREE_RECORDS (1,000). Virtualize like the switcher if a profile shows a cost.

export function WorktreesGroup({ actions, rowHeight }: { actions: WorktreeActions; rowHeight: number }) {
  const ids = { heading: useId(), row: useId() };
  const [expanded, setExpanded] = useState(true);
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<{ entry: WorktreeEntry; anchor: Element } | null>(null);
  const entries = actions.entries ?? [];
  const at = Math.min(active, Math.max(0, entries.length - 1));
  const rowId = (index: number) => `${ids.row}-${index}`;
  const anchorOf = (index: number) => document.getElementById(rowId(index));

  function openMenu(index: number) {
    const anchor = anchorOf(index);
    const entry = entries[index];
    if (anchor !== null && entry !== undefined) setMenu({ entry, anchor });
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing || entries.length === 0) return;
    // Windows sends Shift+F10 and the Menu key to the focused element.
    if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      return openMenu(at);
    }
    if (event.shiftKey) return;
    const moves: Record<string, () => void> = {
      ArrowDown: () => setActive(Math.min(entries.length - 1, at + 1)),
      ArrowUp: () => setActive(Math.max(0, at - 1)),
      Home: () => setActive(0),
      End: () => setActive(entries.length - 1),
      Enter: () => actions.open(entries[at]!),
      Delete: () => actions.startRemove(entries[at]!),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    move();
  }

  const count = actions.entries?.length ?? null;
  const e = menu?.entry;
  return (
    <div data-slot="worktrees-group" className="flex flex-col px-1">
      <button
        id={ids.heading}
        type="button"
        aria-expanded={expanded}
        aria-label={count === null ? W.list : `${W.list}, ${count}`}
        className="list-row flex min-w-0 items-center gap-1 bg-surface pr-2 pl-1 font-semibold"
        style={{ height: rowHeight }}
        onClick={() => setExpanded((x) => !x)}
      >
        <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
        <span aria-hidden="true">{W.list}</span>
        {count === null ? null : (
          <span aria-hidden="true" className="num ml-auto shrink-0 font-normal text-muted-text">
            {count}
          </span>
        )}
      </button>
      {!expanded ? null : actions.failure !== null ? (
        <p role="alert" className="px-2">
          {actions.failure}
        </p>
      ) : actions.entries === null ? (
        <p className="px-2 text-muted-text">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="px-2 text-muted-text">{W.empty}</p>
      ) : (
        <div role="listbox" aria-labelledby={ids.heading} tabIndex={0} aria-activedescendant={rowId(at)} className="flex flex-col" onKeyDown={onKeyDown}>
          {entries.map((entry, index) => (
            // The row cuts its branch and path text, so the tooltip gives the full accessible name (arbareto-ux truncation rule).
            <Tooltip key={entry.path}>
              <TooltipTrigger
                id={rowId(index)}
                render={
                  <div
                    role="option"
                    aria-selected={index === at}
                    aria-label={entryLabel(entry)}
                    className={`list-row flex min-w-0 items-center gap-1 pr-2 pl-4 ${index === at ? "bg-hover-fill" : ""}`}
                    style={{ height: rowHeight }}
                    onClick={() => setActive(index)}
                    onDoubleClick={() => actions.open(entry)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setActive(index);
                      openMenu(index);
                    }}
                  />
                }
              >
                <WorktreeRow entry={entry} />
              </TooltipTrigger>
              <TooltipContent>{entryLabel(entry)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
      {e === undefined ? null : (
        <ActionMenu
          label={W.menu(folderOf(e.path))}
          open
          anchor={menu!.anchor}
          finalFocus={() => (menu!.anchor.closest<HTMLElement>('[role="listbox"]') ?? false) as HTMLElement | false}
          onOpenChange={(next) => void (next || setMenu(null))}
          groups={[
            [
              { label: W.open, icon: FolderOpenIcon, reason: actions.openReason(e), onSelect: () => actions.open(e) },
              { label: W.remove, icon: Delete02Icon, keys: { aria: KEYS.delete.aria, text: KEYS.delete.text }, reason: actions.removeReason(e), danger: true, onSelect: () => actions.startRemove(e) },
            ],
            [
              { label: W.add, icon: PlusSignIcon, onSelect: () => actions.startAdd(menu!.anchor) },
              { label: W.prune, icon: FolderRemoveIcon, reason: actions.pruneReason, onSelect: actions.prune },
            ],
          ]}
        />
      )}
    </div>
  );
}
