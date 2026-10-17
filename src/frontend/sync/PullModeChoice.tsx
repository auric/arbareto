// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { GitCompareArrowsIcon, GitMergeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useId, useRef, type KeyboardEvent } from "react";
import { WarningIcon } from "../app/NoticeBand";
import { Button } from "../components/ui/button";

// Feature 003 spec FR-027 and FR-057, plan.md D6 and D12, data-model §7 `mode-required`.

export const PULL_MODE_QUESTION = "The branch and its upstream have diverged. Choose Rebase or Merge for this pull. Arbareto does not change the Git configuration.";

export type PullModeChoiceProps = {
  /** Sends `reviewSync {action: "integrate", mode}`. The Rebase choice is the confirmation (FR-057). */
  onChoose(mode: "rebase" | "merge"): void;
  /** Removes the question and sends nothing. */
  onCancel(): void;
  /** The unavailable reason of both choices, or null. */
  reason: string | null;
  bindControl?: (element: HTMLButtonElement) => () => void;
};

/** The notice band row of a pull that needs a mode. The first choice takes focus, and Escape cancels. */
export function PullModeChoice({ onChoose, onCancel, reason, bindControl }: PullModeChoiceProps) {
  const reasonId = useId();
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  const bindFirst = useCallback(
    (element: HTMLButtonElement) => {
      first.current = element;
      return bindControl?.(element);
    },
    [bindControl],
  );
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  const choice = (mode: "rebase" | "merge") => (
    <Button
      ref={mode === "rebase" ? bindFirst : bindControl}
      variant="outline"
      size="sm"
      disabled={reason !== null}
      focusableWhenDisabled
      aria-describedby={reason === null ? undefined : reasonId}
      onClick={() => reason === null && onChoose(mode)}
    >
      <HugeiconsIcon icon={mode === "rebase" ? GitCompareArrowsIcon : GitMergeIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
      {mode === "rebase" ? "Rebase" : "Merge"}
    </Button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
      <WarningIcon />
      <span>{PULL_MODE_QUESTION}</span>
      <div role="group" aria-label="Pull mode" className="flex flex-wrap items-center gap-1" onKeyDown={onKeyDown}>
        {choice("rebase")}
        {choice("merge")}
        <Button ref={bindControl} variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {reason === null ? null : (
        <span id={reasonId} className="text-muted-text">
          {reason}
        </span>
      )}
    </div>
  );
}
