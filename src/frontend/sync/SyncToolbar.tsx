// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, CloudDownloadIcon, Upload04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, type ReactNode } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import { MENU_CONTENT } from "../app/RepositoryMenu";
import { BLOCKED_TEXT } from "../changes/HunkControls";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { pullAction, PullSplitButton, type DefaultPullAction, type ReviewPayload } from "./PullSplitButton";

// Feature 003 spec FR-017, FR-028, FR-039, FR-055, plan.md D12. The 004 design standard sets the group order: Fetch, Pull, Push.

type Head = WorkspaceSnapshot["head"];
type OperationState = WorkspaceSnapshot["operationState"];

const DETACHED = "No branch checked out.";
const UNBORN = "The branch has no commits yet.";
const NO_UPSTREAM = "The branch has no upstream.";

export type SyncReasons = { fetchReason: string | null; pullReason: string | null; pushReason: string | null };

/**
 * The toolbar unavailable reasons. They come from `readWorkspace` (HEAD and the operation state) and `readTracking` (the upstream).
 * `blocked` is a workbench state that blocks every mutation. Fetch stays available during a merge or a rebase (spec, 001 FR-016).
 * `upstream` is null when no paired tracking entry exists; the review then decides.
 */
export function syncReasons(head: Head | null, operationState: OperationState | null, upstream: "none" | "set" | null, blocked: string | null): SyncReasons {
  const branch =
    head === null ? BLOCKED_TEXT.loading : head.state === "detached" ? DETACHED : head.state === "unborn" ? UNBORN : operationState !== "normal" ? BLOCKED_TEXT.conflicted : null;
  return { fetchReason: blocked, pullReason: blocked ?? branch ?? (upstream === "none" ? NO_UPSTREAM : null), pushReason: blocked ?? branch };
}

export type SyncToolbarProps = {
  reasons: SyncReasons;
  /** `readSyncSettings.defaultPullAction`, or null while it is unknown. */
  defaultAction: DefaultPullAction | null;
  settingsReason: string | null;
  /** The counts of the current branch (T063). */
  count?: ReactNode;
  onRun(payload: ReviewPayload): void;
  onSetDefault(action: DefaultPullAction): void;
};

export function SyncToolbar({ reasons, defaultAction, settingsReason, count, onRun, onSetDefault }: SyncToolbarProps) {
  const id = useId();
  const pullReasons: Record<DefaultPullAction, string | null> = { pull: reasons.pullReason, "pull-merge": reasons.pullReason, "pull-rebase": reasons.pullReason, "fetch": reasons.fetchReason, "fetch-all": reasons.fetchReason };
  const mainReason = settingsReason ?? (defaultAction === null ? null : pullReasons[defaultAction]);
  // One inline reason line per distinct text. Each unavailable control names its line.
  const lines = new Map<string, string[]>();
  for (const [control, reason] of [
    ["Fetch", reasons.fetchReason],
    ["Pull", mainReason],
    ["Push", reasons.pushReason],
  ] as const) {
    if (reason !== null) lines.set(reason, [...(lines.get(reason) ?? []), control]);
  }
  const lineId = (reason: string | null) => (reason === null ? undefined : `${id}-${[...lines.keys()].indexOf(reason)}`);
  return (
    <div role="group" aria-label="Remote sync" className="flex min-w-0 items-center gap-1">
      <div className="flex items-center">
        <IconButton
          icon={CloudDownloadIcon}
          label="Fetch"
          keys={{ aria: "Control+Shift+ArrowDown", text: "Ctrl+Shift+Down" }}
          disabled={reasons.fetchReason !== null}
          focusableWhenDisabled
          aria-describedby={lineId(reasons.fetchReason)}
          onClick={() => reasons.fetchReason === null && onRun({ action: "fetch" })}
        />
        {/* FR-039: a menu beside Fetch offers Fetch all remotes. */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={<DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label="Fetch options" style={{ height: "var(--h-row-button)", width: 16 }} className="px-0" />} />}
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
      </div>
      <PullSplitButton
        defaultAction={defaultAction}
        settingsReason={settingsReason}
        reasons={pullReasons}
        mainReasonId={lineId(mainReason)}
        onRun={(action) => onRun(pullAction(action).payload)}
        onSetDefault={onSetDefault}
      />
      <IconButton
        icon={Upload04Icon}
        label="Push"
        keys={{ aria: "Control+ArrowUp", text: "Ctrl+Up" }}
        disabled={reasons.pushReason !== null}
        focusableWhenDisabled
        aria-describedby={lineId(reasons.pushReason)}
        onClick={() => reasons.pushReason === null && onRun({ action: "push" })}
      />
      {count}
      {[...lines].map(([reason, controls], i) => (
        <span key={reason} id={`${id}-${i}`} className="min-w-0 truncate text-muted-text" title={`${controls.join(", ")}: ${reason}`}>
          {`${controls.join(", ")}: ${reason}`}
        </span>
      ))}
    </div>
  );
}

