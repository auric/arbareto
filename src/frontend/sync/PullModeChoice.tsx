// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { GitCompareArrowsIcon, GitMergeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useId, useRef, type KeyboardEvent } from "react";
import { WarningIcon } from "../app/NoticeBand";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { quietReason } from "./SyncToolbar";

// Feature 003 spec FR-027 and FR-057, plan.md D6 and D12, data-model §7 `mode-required`.

export const PULL_MODE_QUESTION = "The branch and its upstream have diverged. Choose Rebase or Merge for this pull. Arbareto does not change the Git configuration.";

export type PullModeChoiceProps = {
  /** Sends `reviewSync {action: "integrate", mode}`. The Rebase choice is the confirmation (FR-057). */
  onChoose(mode: "rebase" | "merge"): void;
  /** Removes the question and sends nothing. */
  onCancel(): void;
  /** The unavailable reason of both choices, or null. */
  reason: string | null;
  /** True while `operation !== null && response === null`. The running reason then replaces `reason` without a visible line (plan.md D12). */
  running?: boolean;
  /** True while the reconcile read after a mutation outcome runs. Its reason follows the running reason rule. */
  reconciling?: boolean;
  bindControl?: (element: HTMLButtonElement) => () => void;
};

/** The notice band row of a pull that needs a mode. The first choice takes focus, and Escape cancels. */
export function PullModeChoice({ onChoose, onCancel, reason: given, running = false, reconciling = false, bindControl }: PullModeChoiceProps) {
  const quiet = quietReason(running, reconciling);
  const reason = quiet ?? given;
  const reasonId = useId();
  const first = useRef<HTMLButtonElement | null>(null);
  // plan.md D12: the question takes focus only when no editable field holds it.
  useEffect(() => {
    const active = document.activeElement;
    const editable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable);
    if (!editable) first.current?.focus();
  }, []);
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
  const choice = (mode: "rebase" | "merge") => {
    const control = (
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
    // The row mounts while the reconcile read runs, and the first choice takes focus then. A stable trigger keeps that focus when the read ends.
    return (
      <Tooltip disabled={quiet === null}>
        <TooltipTrigger render={control} />
        <TooltipContent>{quiet}</TooltipContent>
      </Tooltip>
    );
  };
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
        <span id={reasonId} className={quiet !== null ? "sr-only" : "text-muted-text"}>
          {reason}
        </span>
      )}
    </div>
  );
}
