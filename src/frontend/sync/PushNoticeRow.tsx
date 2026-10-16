// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon, Cancel01Icon, CloudDownloadIcon, GitCompareArrowsIcon, GitMergeIcon, Upload04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useId } from "react";
import { pushNoticeText, WarningIcon, type PushNotice } from "../app/NoticeBand";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";

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
  /** Each band control registers here, so focus moves to the band heading when it leaves (plan.md "Notice band"). */
  bindControl?: (element: HTMLButtonElement) => () => void;
};

export function PushNoticeRow({ notice, ...a }: { notice: PushNotice } & PushNoticeActions) {
  const reasonId = useId();
  const action = (label: string, icon: IconSvgElement, run: () => void, reason: string | null, danger = false) => (
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
  const actions =
    notice.kind === "stale"
      ? [action("Fetch", CloudDownloadIcon, a.onFetch, a.fetchReason)]
      : notice.kind === "pulled"
        ? [action("Push", Upload04Icon, a.onPush, a.reason)]
        : [
            action("Pull with rebase", GitCompareArrowsIcon, () => a.onPull("rebase"), a.reason),
            action("Pull with merge", GitMergeIcon, () => a.onPull("merge"), a.reason),
            action("Fetch", CloudDownloadIcon, a.onFetch, a.fetchReason),
            action("Force push with lease…", Alert02Icon, a.onForcePush, a.reason, true),
          ];
  const reason = notice.kind === "stale" ? a.fetchReason : a.reason;
  return (
    <div className="flex flex-wrap items-center gap-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
      <WarningIcon />
      <span>{pushNoticeText(notice)}</span>
      <div role="group" aria-label="Push rejected actions" className="flex flex-wrap items-center gap-1">
        {actions}
      </div>
      {reason === null ? null : (
        <span id={reasonId} className="text-muted-text">
          {reason}
        </span>
      )}
      <IconButton icon={Cancel01Icon} label="Dismiss notice" onClick={a.onDismiss} />
    </div>
  );
}
