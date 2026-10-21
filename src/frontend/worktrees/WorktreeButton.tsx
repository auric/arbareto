// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, FolderGitIcon, FolderRemoveIcon, GitBranchIcon, PlusSignIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import { SwitcherPopover } from "../components/switcher-popover";
import { branchText, entryLabel, folderOf, marks, type WorktreeActions, type WorktreeEntry } from "./WorktreeActions";
import { W } from "./texts";

// Feature 004 spec FR-049, plan.md D15 "Worktree button" and "Switcher popover", the Worktrees board.

export type WorktreeButtonProps = {
  actions: WorktreeActions;
  /** The open worktree root. Its folder name shows until the list loads. */
  worktreeRoot: string | null;
  rowHeight: number;
  /** The two-line record height in DIPs: the row plus one help line (plan.md D15 "Rows"). */
  itemHeight: number;
  /** The group heading height in DIPs (`metrics(...).subgroupHeading`). */
  headingHeight: number;
};

export function WorktreeButton({ actions, worktreeRoot, rowHeight, itemHeight, headingHeight }: WorktreeButtonProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const entries = actions.entries;
  const name = actions.current !== null ? folderOf(actions.current.path) : worktreeRoot === null ? "" : folderOf(worktreeRoot);
  const pick = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <SwitcherPopover<WorktreeEntry>
      open={open}
      onOpenChange={(next) => {
        if (next) actions.refresh();
        setOpen(next);
      }}
      trigger={
        <button
          ref={trigger}
          type="button"
          data-slot="worktree-button"
          aria-label={entries === null ? name : W.buttonLabel(name, entries.length)}
          className="flex h-(--h-button) min-w-0 max-w-fit shrink items-center gap-1 rounded-sm border border-control-border px-2 hover:bg-hover-fill"
          style={{ order: 3 }}
        />
      }
      tooltip={W.tooltip}
      filterLabel={W.filter}
      listLabel={W.list}
      rowHeight={rowHeight}
      itemHeight={itemHeight}
      headingHeight={headingHeight}
      items={entries}
      failure={actions.failure === null ? undefined : <p role="alert">{actions.failure}</p>}
      itemKey={(e) => e.path}
      itemText={(e) => `${e.path} ${branchText(e) ?? ""}`}
      itemLabel={entryLabel}
      renderItem={(e) => <WorktreeRow entry={e} />}
      onPick={(e) => (e.current ? setOpen(false) : actions.openReason(e) !== null ? actions.open(e) : pick(() => actions.open(e)))}
      onItemDelete={(e) => (actions.removeReason(e) !== null ? actions.startRemove(e) : pick(() => actions.startRemove(e)))}
      footer={[
        { label: W.add, icon: PlusSignIcon, onPick: () => pick(() => actions.startAdd(trigger.current)) },
        { label: W.prune, icon: FolderRemoveIcon, note: actions.pruneReason === W.nothingToPrune ? W.nothingToPrune : undefined, onPick: () => pick(actions.prune) },
      ]}
      emptyText={W.empty}
      noMatchText={W.noMatch}
    >
      <HugeiconsIcon icon={FolderGitIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
      <span data-slot="worktree-text" aria-hidden="true" title={name} className="min-w-0 truncate whitespace-nowrap">
        {name}
      </span>
      {entries === null ? null : (
        <span aria-hidden="true" className="num shrink-0 text-muted-text">
          {entries.length.toLocaleString("en-US")}
        </span>
      )}
      <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
    </SwitcherPopover>
  );
}

/** One record on two lines: the folder name and the branch, then the path. The current mark and the state marks frame them. The option name and the tooltip hold the full text. */
export function WorktreeRow({ entry: e }: { entry: WorktreeEntry }) {
  const branch = branchText(e);
  return (
    <>
      <CurrentMark entry={e} />
      {/* Plan D15 "Rows": the lines take their first-line width before the marks. The marks shrink first. */}
      <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span data-slot="worktree-lines" title={entryLabel(e)} className="flex max-w-full shrink-0 grow flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className={e.current ? "min-w-0 truncate font-semibold" : "min-w-0 truncate"}>{folderOf(e.path)}</span>
            {branch === null ? null : (
              <span className="flex min-w-0 items-center gap-1 text-muted-text">
                {e.branch === null ? null : <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />}
                <span className="num min-w-0 truncate">{branch}</span>
              </span>
            )}
          </span>
          {/* A zero width with a full minimum: the path fills the lines but adds no width to them. */}
          <span className="w-0 min-w-full truncate text-muted-text">{e.path}</span>
        </span>
        <Marks entry={e} />
      </span>
    </>
  );
}

export function CurrentMark({ entry: e }: { entry: WorktreeEntry }) {
  return (
    <span aria-hidden="true" className="flex size-4 shrink-0 items-center text-accent-role">
      {e.current ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" /> : null}
    </span>
  );
}

/** The state marks. A long mark shrinks before the row overflows. */
export function Marks({ entry: e }: { entry: WorktreeEntry }) {
  return (
    <span className="ml-auto flex min-w-0 gap-1">
      {marks(e).map((mark) => (
        <span key={mark} className="chip min-w-0 truncate">
          {mark}
        </span>
      ))}
    </span>
  );
}
