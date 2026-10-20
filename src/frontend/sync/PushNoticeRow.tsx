// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon, Cancel01Icon, CloudDownloadIcon, GitCompareArrowsIcon, GitMergeIcon, Upload04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useId } from "react";
import { pushNoticeText, WarningIcon, type PushNotice } from "../app/NoticeBand";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { quietReason } from "./SyncToolbar";

// Feature 003 spec FR-023 to FR-026 and plan.md D5. Destructive actions show an icon and text and never fold into a More menu (plan.md D12).

export type PushNoticeActions = {
  onPull(mode: "rebase" | "merge"): void;
  onFetch(): void;
  onForcePush(): void;
  onPush(): void;
  onDismiss(): void;
  /** The unavailable reason of the pull and push actions, or null. Fetch takes `fetchReason`. */
  reason: string | null;
  fetchReason: string | null;
  /** True while `operation !== null && response === null`. The running reason then replaces both reasons without a visible line (plan.md D12). */
  running?: boolean;
  /** True while the reconcile read after a mutation outcome runs. Its reason follows the running reason rule. */
  reconciling?: boolean;
  /** Each band control registers here, so focus moves to the band heading when it leaves (plan.md "Notice band"). */
  bindControl?: (element: HTMLButtonElement) => () => void;
};

export function PushNoticeRow({ notice, running = false, reconciling = false, ...a }: { notice: PushNotice } & PushNoticeActions) {
  const reasonId = useId();
  const quiet = quietReason(running, reconciling);
  const pullReason = quiet ?? a.reason;
  const fetchReason = quiet ?? a.fetchReason;
  const action = (label: string, icon: IconSvgElement, run: () => void, reason: string | null, danger = false) => {
    const control = (
      <Button
        key={label}
        ref={a.bindControl}
        variant="outline"
        size="sm"
        disabled={reason !== null}
        focusableWhenDisabled
        aria-describedby={reason === null ? undefined : reasonId}
        className={danger ? "text-removed" : undefined}
        onClick={() => reason === null && run()}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
        {label}
      </Button>
    );
    // A stable trigger keeps the focus of a control when the quiet reason ends.
    return (
      <Tooltip key={label} disabled={quiet === null}>
        <TooltipTrigger render={control} />
        <TooltipContent>{quiet}</TooltipContent>
      </Tooltip>
    );
  };
  const actions =
    notice.kind === "stale"
      ? [action("Fetch", CloudDownloadIcon, a.onFetch, fetchReason)]
      : notice.kind === "pulled"
        ? [action("Push", Upload04Icon, a.onPush, pullReason)]
        : [
            action("Pull with rebase", GitCompareArrowsIcon, () => a.onPull("rebase"), pullReason),
            action("Pull with merge", GitMergeIcon, () => a.onPull("merge"), pullReason),
            action("Fetch", CloudDownloadIcon, a.onFetch, fetchReason),
            action("Force push with lease…", Alert02Icon, a.onForcePush, pullReason, true),
          ];
  const reason = notice.kind === "stale" ? fetchReason : pullReason;
  return (
    <div className="flex flex-wrap items-center gap-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
      <WarningIcon />
      <span>{pushNoticeText(notice)}</span>
      <div role="group" aria-label="Push rejected actions" className="flex flex-wrap items-center gap-1">
        {actions}
      </div>
      {reason === null ? null : (
        <span id={reasonId} className={quiet !== null ? "sr-only" : "text-muted-text"}>
          {reason}
        </span>
      )}
      <IconButton icon={Cancel01Icon} label="Dismiss notice" onClick={a.onDismiss} />
    </div>
  );
}
