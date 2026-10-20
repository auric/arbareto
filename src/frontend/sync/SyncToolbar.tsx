// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, CancelCircleIcon, CloudDownloadIcon, Upload04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, type ReactNode } from "react";
import type { SYNC_ACTIONS } from "../../contracts/channel";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import { MENU_CONTENT } from "../app/RepositoryMenu";
import { BLOCKED_TEXT, operationBlock } from "../changes/HunkControls";
import { IconButton } from "../components/icon-button";
import { RUNNING_REASON } from "../components/running-tooltip";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { SYNC_NAMES } from "../status/OperationStatus";
import { PULL_ACTIONS, pullAction, PullSplitButton, type DefaultPullAction, type ReviewPayload } from "./PullSplitButton";

// Feature 003 spec FR-017, FR-028, FR-039, FR-055, plan.md D12. The 004 design standard sets the group order: Fetch, Pull, Push.

type Head = WorkspaceSnapshot["head"];
type OperationState = WorkspaceSnapshot["operationState"];

const DETACHED = "No branch checked out.";
const UNBORN = "The branch has no commits yet.";
const NO_UPSTREAM = "The branch has no upstream.";

export { RUNNING_REASON };

type SyncAction = (typeof SYNC_ACTIONS)[number];
type Slot = "fetch" | "pull" | "push";
// Plan D12: the control that shows a running sync. Abort, Continue, and Skip have none.
const SLOTS: Partial<Record<SyncAction, Slot>> = { "fetch": "fetch", "fetch-all": "fetch", pull: "pull", integrate: "pull", push: "push", "force-push": "push" };
const VERBS: Record<Slot, string> = { "fetch": "Fetching…", pull: "Pulling…", push: "Pushing…" };

/** A running mutation: the action of a running sync, or null for every other mutation. */
export type SyncRunning = { action: SyncAction | null; cancelRequested: boolean };

// Plan D12: the response removes Cancel. If Cancel has focus then, focus moves to the action control of its slot.
const keepFocus = (element: HTMLButtonElement | null) => () => {
  if (element !== null && document.activeElement === element) element.closest("[data-sync-slot]")?.querySelector<HTMLElement>("button")?.focus();
};

export type SyncReasons = { fetchReason: string | null; pullReason: string | null; pushReason: string | null; commitPushReason: string | null };

/**
 * The toolbar unavailable reasons. They come from `readWorkspace` (HEAD and the operation state) and `readTracking` (the upstream).
 * `blocked` is a workbench state that blocks every mutation. Fetch stays available during a merge or a rebase (spec, 001 FR-016).
 * `upstream` is null when no paired tracking entry exists; the review then decides.
 * FR-038: Commit and push on an unborn branch stays available. The push review after the commit decides.
 */
export function syncReasons(head: Head | null, operationState: OperationState | null, upstream: "none" | "set" | null, blocked: string | null): SyncReasons {
  const block = operationState === null ? null : operationBlock(operationState);
  const operation = block === null ? null : BLOCKED_TEXT[block];
  const form = head === null ? BLOCKED_TEXT.loading : head.state === "detached" ? DETACHED : head.state === "unborn" ? UNBORN : null;
  // Contract Δ3 `reviewSync`: pull checks the operation state before the HEAD form, because a rebase detaches HEAD. Push checks the HEAD form first.
  const pull = head === null ? form : (operation ?? form);
  const push = form ?? operation;
  const commitPush = head?.state === "unborn" ? operation : push;
  return { fetchReason: blocked, pullReason: blocked ?? pull ?? (upstream === "none" ? NO_UPSTREAM : null), pushReason: blocked ?? push, commitPushReason: blocked ?? commitPush };
}

/** The unavailable reason of one pull menu action. Fetch and Fetch all remotes take the Fetch reason. */
export const actionReason = (reasons: SyncReasons, action: DefaultPullAction) => (action === "fetch" || action === "fetch-all" ? reasons.fetchReason : reasons.pullReason);

export type SyncToolbarProps = {
  reasons: SyncReasons;
  /** `readSyncSettings.defaultPullAction`, or null while it is unknown. */
  defaultAction: DefaultPullAction | null;
  settingsReason: string | null;
  /** The counts of the current branch (T063). */
  count?: ReactNode;
  /** Set while `operation !== null && response === null`. Every sync reason is then the running reason. */
  running?: SyncRunning | null;
  onRun(payload: ReviewPayload): void;
  onSetDefault(action: DefaultPullAction): void;
  /** The status bar Cancel request of the running operation. */
  onCancel?(): void;
};

export function SyncToolbar({ reasons: given, defaultAction, settingsReason, count, running = null, onRun, onSetDefault, onCancel }: SyncToolbarProps) {
  const id = useId();
  const reasons: SyncReasons = running === null ? given : { fetchReason: RUNNING_REASON, pullReason: RUNNING_REASON, pushReason: RUNNING_REASON, commitPushReason: RUNNING_REASON };
  const runningId = `${id}-running`;
  const slot = running?.action == null ? undefined : SLOTS[running.action];
  const progress = (at: Slot) =>
    running === null || running.action === null || slot !== at ? null : (
      <>
        <span data-slot="sync-running" className="shrink-0 px-1 whitespace-nowrap">
          {running.cancelRequested ? "Cancel requested" : VERBS[at]}
        </span>
        <IconButton ref={keepFocus} icon={CancelCircleIcon} label={`Cancel ${SYNC_NAMES[running.action]}`} onClick={onCancel} />
      </>
    );
  const pullReasons = Object.fromEntries(PULL_ACTIONS.map((a) => [a.action, actionReason(reasons, a.action)])) as Record<DefaultPullAction, string | null>;
  const mainReason = settingsReason ?? (defaultAction === null ? null : pullReasons[defaultAction]);
  // The settings reason of the Pull main part is no running reason, so it keeps its line.
  const quiet = { Fetch: running !== null, Pull: running !== null && settingsReason === null, Push: running !== null };
  // One inline reason line per distinct text. Each unavailable control names its line.
  const lines = new Map<string, string[]>();
  for (const [control, reason] of [
    ["Fetch", reasons.fetchReason],
    ["Pull", mainReason],
    ["Push", reasons.pushReason],
  ] as const) {
    if (reason !== null && !quiet[control]) lines.set(reason, [...(lines.get(reason) ?? []), control]);
  }
  const lineId = (reason: string | null) => (reason === null ? undefined : `${id}-${[...lines.keys()].indexOf(reason)}`);
  const describedBy = (control: keyof typeof quiet, reason: string | null) => (quiet[control] ? runningId : lineId(reason));
  const note = (control: keyof typeof quiet) => (quiet[control] ? RUNNING_REASON : undefined);
  return (
    <div role="group" aria-label="Remote sync" className="flex grow items-center gap-1">
      {running === null ? null : (
        <span id={runningId} className="sr-only">
          {RUNNING_REASON}
        </span>
      )}
      <div data-sync-slot="fetch" className="flex items-center">
        <IconButton
          icon={CloudDownloadIcon}
          label="Fetch"
          keys={{ aria: "Control+Shift+ArrowDown", text: "Ctrl+Shift+Down" }}
          note={note("Fetch")}
          disabled={reasons.fetchReason !== null}
          focusableWhenDisabled
          aria-describedby={describedBy("Fetch", reasons.fetchReason)}
          onClick={() => reasons.fetchReason === null && onRun({ action: "fetch" })}
        />
        {/* FR-039: a menu beside Fetch offers Fetch all remotes. */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={<DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label="Fetch options" style={{ height: "var(--h-row-button)", width: 24 }} className="px-0" />} />}
            >
              <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden="true" className="size-3" />
            </TooltipTrigger>
            <TooltipContent>Fetch options</TooltipContent>
          </Tooltip>
          <DropdownMenuContent className={MENU_CONTENT}>
            <DropdownMenuItem disabled={reasons.fetchReason !== null} onClick={reasons.fetchReason === null ? () => onRun({ action: "fetch-all" }) : undefined}>
              <HugeiconsIcon icon={CloudDownloadIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
              <span>Fetch all remotes</span>
            </DropdownMenuItem>
            {reasons.fetchReason === null ? null : <p className="px-2 pb-1 text-xs whitespace-normal text-muted-text">{reasons.fetchReason}</p>}
          </DropdownMenuContent>
        </DropdownMenu>
        {progress("fetch")}
      </div>
      <div data-sync-slot="pull" className="flex items-center">
        <PullSplitButton
          defaultAction={defaultAction}
          settingsReason={settingsReason}
          reasons={pullReasons}
          mainReasonId={describedBy("Pull", mainReason)}
          mainNote={note("Pull")}
          onRun={(action) => onRun(pullAction(action).payload)}
          onSetDefault={onSetDefault}
        />
        {progress("pull")}
      </div>
      <div data-sync-slot="push" className="flex items-center">
        <IconButton
          icon={Upload04Icon}
          label="Push"
          keys={{ aria: "Control+ArrowUp", text: "Ctrl+Up" }}
          note={note("Push")}
          disabled={reasons.pushReason !== null}
          focusableWhenDisabled
          aria-describedby={describedBy("Push", reasons.pushReason)}
          onClick={() => reasons.pushReason === null && onRun({ action: "push" })}
        />
        {progress("push")}
      </div>
      {count}
      {[...lines].map(([reason, controls], i) => (
        // Plan.md D15 "Top bar row": the line keeps its control names and an ellipsis. The reason takes only the width that the other controls leave.
        <span key={reason} id={`${id}-${i}`} className="flex text-muted-text" style={{ flexGrow: 1 }} title={`${controls.join(", ")}: ${reason}`}>
          <span className="shrink-0 whitespace-pre">{`${controls.join(", ")}: `}</span>
          {/* `contain: inline-size` gives the reason no content width. */}
          <span className="min-w-[1em] truncate" style={{ contain: "inline-size", flexGrow: 1 }}>
            {reason}
          </span>
        </span>
      ))}
    </div>
  );
}

