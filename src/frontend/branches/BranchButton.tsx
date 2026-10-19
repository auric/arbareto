// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, CloudIcon, GitBranchIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import { SwitcherPopover } from "../components/switcher-popover";
import { KEYS } from "../keyboard/shortcuts";
import { branchName } from "../history/HistoryView";
import { GIT_SEPARATORS, splitPath } from "../lib/path";
import type { BranchEntry } from "../state/workbench";
import type { TrackLabel } from "../state/tracking";
import type { useBranchActions } from "./BranchActions";
import { T } from "./texts";

// Feature 004 spec FR-007, FR-008, FR-013, plan.md D15 "Branch button" and "Switcher popover", the BranchSwitcher board.

export type BranchButtonProps = {
  /** The group heading height in DIPs (`metrics(...).subgroupHeading`). */
  headingHeight: number;
  head: WorkspaceSnapshot["head"];
  operationState: WorkspaceSnapshot["operationState"];
  /** The 003 count label of the current branch. */
  counts: TrackLabel;
  /** The 003 count labels by local branch name. */
  tracking: ReadonlyMap<string, TrackLabel>;
  actions: ReturnType<typeof useBranchActions>;
  /** The reason that blocks the switch, such as a merge in progress. The list then shows it instead of the branches. */
  blockedReason: string | null;
  rowHeight: number;
};

/** Spec FR-007: the branch, "Detached at <short ID>", or the operation in progress. An unborn branch keeps the 001 header text. */
function buttonText(head: WorkspaceSnapshot["head"], operationState: WorkspaceSnapshot["operationState"]): string {
  if (operationState === "merging") return T.merging;
  if (operationState === "rebasing") return T.rebasing;
  if (head.state === "detached") return T.detached(head.oid);
  return head.state === "unborn" ? `${branchName(head.target)}, no commits yet` : branchName(head.target);
}

export function BranchButton({ headingHeight, head, operationState, counts, tracking, actions, blockedReason, rowHeight }: BranchButtonProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const text = buttonText(head, operationState);
  const [folder, last] = splitPath(text, GIT_SEPARATORS);
  const failure = blockedReason !== null ? <p>{blockedReason}</p> : actions.failure !== null ? <p role="alert">{T.listFailed(actions.failure)}</p> : undefined;
  // Spec FR-008: "No upstream" shows in the list. A held branch offers Open instead of a switch (FR-013).
  const note = (e: BranchEntry) => (e.heldBy !== null && !e.current ? T.open(e.heldBy) : e.kind === "local" && e.upstream === null ? T.noUpstream : e.kind === "local" ? (tracking.get(e.name)?.text ?? null) : null);
  const label = (e: BranchEntry) => [e.name, ...(e.current ? [T.current] : []), e.kind === "local" ? T.localNoun : T.remoteNoun, ...(e.kind === "local" && e.upstream !== null ? [tracking.get(e.name)?.label] : []), note(e)].filter((part) => part != null).join(", ");
  const pick = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <SwitcherPopover<BranchEntry>
      open={open}
      onOpenChange={(next) => {
        if (next) actions.refresh();
        setOpen(next);
      }}
      trigger={
        <button
          ref={trigger}
          type="button"
          data-slot="branch-button"
          aria-label={counts === null ? text : `${text}, ${counts.label}`}
          className="flex h-(--h-button) min-w-0 max-w-fit items-center gap-1 rounded-sm border border-control-border px-2 hover:bg-hover-fill"
          style={{ order: 3, flex: "1 1 0px" }}
        />
      }
      tooltip={T.tooltip}
      filterLabel={T.filter}
      listLabel={T.list}
      rowHeight={rowHeight}
      headingHeight={headingHeight}
      items={actions.entries}
      failure={failure}
      itemKey={(e) => e.ref}
      itemText={(e) => e.name}
      itemLabel={label}
      itemGroup={(e) => (e.kind === "local" ? T.localGroup : T.remoteGroup)}
      renderItem={(e) => {
        const n = note(e);
        return (
          <>
            {/* Plan D16: the current branch shows a check mark. The option name states "current", so the mark stays hidden. */}
            <span data-slot="current-mark" aria-hidden="true" className="flex size-4 shrink-0 items-center text-accent-role">
              {e.current ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" /> : null}
            </span>
            <HugeiconsIcon icon={e.kind === "local" ? GitBranchIcon : CloudIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
            {/* Git Extensions shows the current branch in bold. */}
            <span className={e.current ? "min-w-0 truncate font-semibold" : "min-w-0 truncate"}>{e.name}</span>
            {n === null ? null : (
              <span title={n} className="num ml-auto min-w-0 shrink-[1000] truncate text-muted-text">
                {n}
              </span>
            )}
          </>
        );
      }}
      onPick={(e) => pick(() => actions.pick(e, trigger.current))}
      footer={{ label: T.newBranch, keys: { aria: KEYS.createBranch.aria, text: KEYS.createBranch.text }, onPick: () => pick(() => actions.create(head.state === "unborn" ? null : head.oid, trigger.current)) }}
      emptyText={T.empty}
      noMatchText={T.noMatch}
    >
      <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
      {/* plan.md "Header layout": the folder part shrinks first and the last `/` segment last. The title and the hidden text hold the full name. */}
      <span data-slot="branch-text" title={text} className="flex min-w-0 items-center whitespace-nowrap" style={{ flex: "1 1 0px" }}>
        <span className="sr-only">{text}</span>
        {folder === "" ? null : (
          <span data-branch-part="folder" aria-hidden="true" className="min-w-0 shrink-[1000] truncate">
            {folder}
          </span>
        )}
        <span data-branch-part="last" aria-hidden="true" className="min-w-0 truncate">
          {last}
        </span>
      </span>
      {counts === null ? null : (
        <span aria-hidden="true" className="num shrink-0">
          {counts.text}
        </span>
      )}
      <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
    </SwitcherPopover>
  );
}
