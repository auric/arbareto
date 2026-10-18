// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon, ArrowRight02Icon, NextIcon, UndoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useId, useRef, useState, type ReactElement } from "react";
import { blockingText, FINISH_OUTSIDE, WarningIcon } from "../app/NoticeBand";
import { CommandRemedy } from "../app/RepositoryStates";
import type { BridgeResponse } from "../bridge";
import { BLOCKED_TEXT } from "../changes/HunkControls";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { isObject } from "../lib/utils";
import { shortId, SYNC_NAMES } from "../status/OperationStatus";
import { RUNNING_REASON } from "./SyncToolbar";

// Feature 003 spec FR-030, FR-042 to FR-045, plan.md D7 and D12, contract Δ3 `reviewSync` abort, continue, and skip.
// Destructive actions show an icon and text and never fold into a More menu (plan.md D12).

export type ConflictAction = "abort" | "continue" | "skip";
type Kind = "merging" | "rebasing";
type Remedy = { text?: string; command?: string | null };
/** Contract Δ3 `SyncRefused`: the `SYNC_UNAVAILABLE` reason and the `rebase-exec` remedy. */
type Refusal = { reason: string; remedy?: Remedy };

export const SKIP_TOOLTIP = "Skip leaves the current commit out of the rebased branch.";
export const NO_SKIP_TEXT = "Skip is unavailable: Git names no commit at this rebase stop.";
/** FR-043: the unavailable reason of Continue while the index has unmerged entries. */
export const continueBlocked = (n: number) => (n === 1 ? "Continue is unavailable while 1 file is unmerged. Mark it resolved first." : `Continue is unavailable while ${n} files are unmerged. Mark them resolved first.`);

export type ConflictRowProps = {
  operationState: Kind;
  /** The Conflicted entry count of the latest complete `readWorkspace`. */
  conflicted: number;
  /** The unavailable reason of every action, or null. */
  reason: string | null;
  /** True while `operation !== null && response === null`. The running reason then replaces `reason` without a visible line (plan.md D12). */
  running?: boolean;
  /** True while entry pages of the status read are missing, so the unmerged count is not known yet. */
  loading?: boolean;
  /** Runs the review of the action. Resolves with the refused review response, or null. */
  onAction(action: ConflictAction): Promise<BridgeResponse | null>;
  bindControl?: (element: HTMLButtonElement) => () => void;
};

function refusalOf(response: BridgeResponse | null): Refusal | null {
  if (response === null || response.code !== "SYNC_UNAVAILABLE" || !isObject(response.result) || typeof response.result.reason !== "string") return null;
  const remedy = response.result.remedy;
  return { reason: response.result.reason, remedy: isObject(remedy) ? (remedy as Remedy) : undefined };
}

/**
 * The conflict row of a merge or a rebase in progress. A refused review hides the refused actions for this stop.
 * The caller keys the row by the operation state and HEAD, so a new stop shows every action again.
 */
export function ConflictRow({ operationState, conflicted, reason: given, running = false, loading = false, onAction, bindControl }: ConflictRowProps) {
  const reason = running ? RUNNING_REASON : given;
  const reasonId = useId();
  const continueId = useId();
  const [refusals, setRefusals] = useState<Partial<Record<ConflictAction, Refusal>>>({});
  const all = Object.values(refusals);
  const unknown = all.some((r) => r.reason === "unknown-operation");
  const exec = refusals.continue?.reason === "rebase-exec" ? refusals.continue : refusals.skip?.reason === "rebase-exec" ? refusals.skip : undefined;
  const hidden = (action: ConflictAction) => unknown || refusals[action] !== undefined || (exec !== undefined && action !== "abort") || (action === "skip" && operationState !== "rebasing");

  async function activate(action: ConflictAction) {
    const refusal = refusalOf(await onAction(action));
    if (refusal !== null) setRefusals((r) => ({ ...r, [action]: refusal }));
  }

  const continueReason = reason ?? (loading ? BLOCKED_TEXT.loading : conflicted > 0 ? continueBlocked(conflicted) : null);
  const action = (name: ConflictAction, label: string, icon: IconSvgElement, own: string | null, describedBy: string, danger = false) => (
    <Button
      key={name}
      ref={bindControl}
      variant="outline"
      size="sm"
      disabled={own !== null}
      focusableWhenDisabled
      aria-describedby={own === null ? undefined : describedBy}
      className={danger ? "text-removed" : undefined}
      onClick={() => void (own === null && activate(name))}
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
      {label}
    </Button>
  );
  const runningLine = running ? <span className="block">{RUNNING_REASON}</span> : null;
  const tip = (key: ConflictAction, control: ReactElement, text: string | null) =>
    text === null && runningLine === null ? (
      control
    ) : (
      <Tooltip key={key}>
        <TooltipTrigger render={control} />
        <TooltipContent>
          {text}
          {runningLine}
        </TooltipContent>
      </Tooltip>
    );
  const skip = tip("skip", action("skip", "Skip…", NextIcon, reason, reasonId), SKIP_TOOLTIP);
  // Refusals other than `rebase-exec` and `unknown-operation` name their action and reason.
  const lines = (Object.entries(refusals) as [ConflictAction, Refusal][]).filter(([, r]) => r.reason !== "rebase-exec" && r.reason !== "unknown-operation");
  return (
    <div data-slot="conflict-row" className="flex flex-wrap items-center gap-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
      <WarningIcon />
      <span>{unknown ? `${blockingText("unknown", conflicted)} ${FINISH_OUTSIDE}` : blockingText(operationState, conflicted)}</span>
      {unknown ? null : (
        <div role="group" aria-label="Conflict actions" className="flex flex-wrap items-center gap-1">
          {hidden("abort") ? null : tip("abort", action("abort", operationState === "merging" ? "Abort merge…" : "Abort rebase…", UndoIcon, reason, reasonId, true), null)}
          {hidden("continue") ? null : tip("continue", action("continue", "Continue", ArrowRight02Icon, continueReason, reason === null ? continueId : reasonId), null)}
          {hidden("skip") ? null : skip}
        </div>
      )}
      {reason === null ? null : (
        <span id={reasonId} className={running ? "sr-only" : "text-muted-text"}>
          {reason}
        </span>
      )}
      {reason !== null || continueReason === null || hidden("continue") ? null : (
        <span id={continueId} className="text-muted-text">
          {continueReason}
        </span>
      )}
      {lines.map(([name, r]) =>
        name === "skip" && r.reason === "no-skip-commit" ? (
          <span key={name}>{NO_SKIP_TEXT}</span>
        ) : (
          <span key={name}>
            {`${SYNC_NAMES[name]} is unavailable: `}
            <code>{r.reason}</code>
          </span>
        ),
      )}
      {exec === undefined || unknown ? null : (
        <div className="flex basis-full flex-col items-start gap-1">
          {exec.remedy === undefined ? (
            <span>
              {"Continue and Skip are unavailable: "}
              <code>rebase-exec</code>
            </span>
          ) : (
            <CommandRemedy remedy={exec.remedy} />
          )}
        </div>
      )}
    </div>
  );
}

/** Contract Δ3 `SyncPlan`: the fields of the abort and skip confirmations. */
export type ConflictPlan = { operationState?: Kind; skippedCommit?: { objectId: string; subject: string | null } };

export type ConflictConfirmProps = {
  action: "abort" | "skip";
  plan: ConflictPlan & { operationState: Kind };
  onConfirm(): void;
  onCancel(): void;
  finalFocus?: () => HTMLElement | null;
};

/** The modal confirmation of Abort (FR-042) and Skip (FR-044). Cancel has the initial focus. */
export function ConflictConfirm({ action, plan, onConfirm, onCancel, finalFocus }: ConflictConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const kind = plan.operationState === "merging" ? "merge" : "rebase";
  const commit = plan.skippedCommit;
  return (
    <Dialog open onOpenChange={(next) => void (next || onCancel())}>
      <DialogContent showCloseButton={false} initialFocus={cancel} finalFocus={finalFocus ?? true} className="flex flex-col gap-2 sm:max-w-lg">
        {action === "abort" ? (
          <>
            <DialogTitle>{`Abort the ${kind}?`}</DialogTitle>
            <p>{`Git returns the branch, the index, and the working files to their state before the ${kind}.`}</p>
            {kind === "merge" ? <p>Git can fail to restore uncommitted changes from before the merge.</p> : null}
          </>
        ) : (
          <>
            <DialogTitle>Skip this commit?</DialogTitle>
            <p>{`Skip leaves commit ${shortId(commit!.objectId)} out of the rebased branch.`}</p>
            <ul>
              <li className="flex gap-2">
                <code className="shrink-0">{shortId(commit!.objectId)}</code>
                {commit!.subject === null ? null : <span className="min-w-0 break-words">{commit!.subject}</span>}
              </li>
            </ul>
            <p className="flex items-center gap-2">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0 text-warning" />
              Git discards the index and working-file changes of this step.
            </p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button className="bg-removed text-surface hover:bg-removed/80" onClick={onConfirm}>
            {action === "abort" ? `Abort ${kind}` : "Skip commit"}
          </Button>
          <Button ref={cancel} variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
