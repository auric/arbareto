// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, CloudDownloadIcon, Download04Icon, GitCompareArrowsIcon, GitMergeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useId } from "react";
import type { DEFAULT_PULL_ACTIONS } from "../../contracts/envelope";
import { MENU_CONTENT } from "../app/RepositoryMenu";
import type { createBridge } from "../bridge";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

// Feature 003 spec FR-039, FR-055 to FR-057, plan.md D12, data-model §10.

export type DefaultPullAction = (typeof DEFAULT_PULL_ACTIONS)[number];
export type ReviewPayload = Parameters<ReturnType<typeof createBridge>["reviewSync"]>[1];

/** The five actions in FR-055 menu order: the menu label, the main-part name, the icon, and the `reviewSync` payload. */
export const PULL_ACTIONS: { action: DefaultPullAction; item: string; name: string; icon: IconSvgElement; payload: ReviewPayload }[] = [
  { action: "pull", item: "Pull (use Git's configuration)", name: "Pull", icon: Download04Icon, payload: { action: "pull" } },
  { action: "pull-merge", item: "Pull with merge", name: "Pull with merge", icon: GitMergeIcon, payload: { action: "pull", mode: "merge" } },
  { action: "pull-rebase", item: "Pull with rebase", name: "Pull with rebase", icon: GitCompareArrowsIcon, payload: { action: "pull", mode: "rebase" } },
  { action: "fetch", item: "Fetch", name: "Fetch", icon: CloudDownloadIcon, payload: { action: "fetch" } },
  { action: "fetch-all", item: "Fetch all remotes", name: "Fetch all remotes", icon: CloudDownloadIcon, payload: { action: "fetch-all" } },
];
export const pullAction = (action: DefaultPullAction) => PULL_ACTIONS.find((a) => a.action === action)!;

const ICON = "size-(--icon-size)";
const BUTTON_SIZE = { height: "var(--h-row-button)" };

export type PullSplitButtonProps = {
  /** `readSyncSettings.defaultPullAction`, or null while it is unknown. */
  defaultAction: DefaultPullAction | null;
  /** Why the default is unknown, or null. */
  settingsReason: string | null;
  /** The unavailable reason of each action, or null. */
  reasons: Record<DefaultPullAction, string | null>;
  /** The ID of the element that shows the reason of the main part. */
  mainReasonId?: string;
  /** A second tooltip line of the main part: a reason without a visible line. */
  mainNote?: string;
  onRun(action: DefaultPullAction): void;
  /** Sends `setDefaultPullAction`. It starts no Git operation (FR-056). */
  onSetDefault(action: DefaultPullAction): void;
};

/** The toolbar Pull split button. The page shortcut handler runs the main part on Ctrl+Down. */
export function PullSplitButton({ defaultAction, settingsReason, reasons, mainReasonId, mainNote, onRun, onSetDefault }: PullSplitButtonProps) {
  const reasonIds = useId();
  const main = defaultAction === null ? null : pullAction(defaultAction);
  const mainReason = settingsReason ?? (defaultAction === null ? null : reasons[defaultAction]);
  const name = main?.name ?? "Pull";
  return (
    <div role="group" aria-label="Pull" className="flex items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              data-slot="pull-main"
              variant="ghost"
              size="sm"
              aria-label={name}
              aria-keyshortcuts="Control+ArrowDown"
              aria-describedby={mainReason === null ? undefined : mainReasonId}
              disabled={mainReason !== null}
              focusableWhenDisabled
              style={BUTTON_SIZE}
              className="rounded-r-none px-1.5"
              onClick={() => (main === null || mainReason !== null ? undefined : onRun(main.action))}
            />
          }
        >
          <HugeiconsIcon icon={main?.icon ?? Download04Icon} strokeWidth={2} aria-hidden="true" className={ICON} />
        </TooltipTrigger>
        <TooltipContent>
          {`${name} (Ctrl+Down)`}
          {mainNote === undefined ? null : <span className="block">{mainNote}</span>}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={<DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label="Pull options" style={{ ...BUTTON_SIZE, width: 24 }} className="rounded-l-none px-0" />} />}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden="true" className="size-3" />
          </TooltipTrigger>
          <TooltipContent>Pull options</TooltipContent>
        </Tooltip>
        <DropdownMenuContent className={MENU_CONTENT}>
          {PULL_ACTIONS.map((a, i) => {
            const reason = reasons[a.action];
            const keys = [...(a.action === defaultAction ? ["Ctrl+Down"] : []), ...(a.action === "fetch" ? ["Ctrl+Shift+Down"] : [])];
            return (
              <div key={a.action} role="none">
                <DropdownMenuItem
                  disabled={reason !== null}
                  aria-describedby={reason === null ? undefined : `${reasonIds}-${i}`}
                  onClick={reason === null ? () => onRun(a.action) : undefined}
                >
                  <HugeiconsIcon icon={a.icon} strokeWidth={2} aria-hidden="true" className={ICON} />
                  <span>{a.item}</span>
                  {keys.length === 0 ? null : <DropdownMenuShortcut className="pl-4 text-xs tracking-normal text-muted-text">{keys.join(", ")}</DropdownMenuShortcut>}
                </DropdownMenuItem>
                {reason === null ? null : (
                  <p id={`${reasonIds}-${i}`} aria-hidden className="px-2 pb-1 pl-8 text-xs whitespace-normal text-muted-text">
                    {reason}
                  </p>
                )}
              </div>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Set default action</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className={MENU_CONTENT}>
              <DropdownMenuRadioGroup value={defaultAction ?? ""} onValueChange={(value) => onSetDefault(value as DefaultPullAction)}>
                {PULL_ACTIONS.map((a) => (
                  <DropdownMenuRadioItem key={a.action} value={a.action}>
                    {a.item}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {/* Mockup "Pull menu": the choice lives in the application settings (FR-056). */}
              <p className="max-w-60 px-2 py-1 text-xs whitespace-normal text-muted-text">The toolbar button runs this action. Arbareto stores it in its own settings, not in Git.</p>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
