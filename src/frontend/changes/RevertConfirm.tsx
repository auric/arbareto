// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Alert02Icon, AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef } from "react";
import { Button } from "../components/ui/button";
import { DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import type { RevertFilesPlan } from "../../contracts/envelope";
import { pathText } from "./file-actions";
import { MORE_FILES, NO_UNDO, revertConfirmTexts, revertFilesTexts, revertUnstagedTexts, type RevertLinesPlan, type RevertUnstagedPlan } from "./revert-text";

// Feature 008 spec FR-008, FR-009, FR-047, plan.md D12 "Modal" (boards Confirm-lines, Confirm-hunk, Confirm-files, Confirm-unstaged, Forced-colors). The layout follows DeleteConfirm.

export type RevertConfirmProps = {
  plan: RevertLinesPlan | RevertFilesPlan | RevertUnstagedPlan;
  /** Data-model §5: the covered files of an all-unstaged plan that Filter files hides. */
  hidden?: number;
  onConfirm(): void;
  onCancel(): void;
  /** The control that opened the review. It gets focus after the dialog closes. */
  finalFocus?: () => HTMLElement | null;
};

function textsOf(plan: RevertConfirmProps["plan"], hidden: number) {
  if ("submodules" in plan) return { ...revertUnstagedTexts(plan, hidden), paths: plan.paths };
  if ("count" in plan) {
    const t = revertFilesTexts(plan);
    return { ...t, notices: t.newFiles === null ? [] : [t.newFiles], paths: plan.paths };
  }
  return { ...revertConfirmTexts(plan), notices: [], more: 0, paths: null };
}

/** The alert dialog of a revert. Cancel has the first focus. The revert button is no default button and has no access key (FR-008). */
export function RevertConfirm({ plan, hidden = 0, onConfirm, onCancel, finalFocus }: RevertConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const texts = textsOf(plan, hidden);
  return (
    <AlertDialog.Root open onOpenChange={(next) => void (next || onCancel())}>
      <DialogContent showCloseButton={false} initialFocus={cancel} finalFocus={finalFocus ?? true} className="flex flex-col gap-0 p-0 sm:max-w-lg">
        <div className="flex items-start gap-2 px-4 pt-4 pb-2">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden="true" className="mt-0.5 size-(--icon-size) shrink-0 text-removed" />
          <DialogTitle className="text-sm/5 font-semibold [overflow-wrap:anywhere]">{texts.title}</DialogTitle>
        </div>
        <div className="flex flex-col gap-2 px-4 pb-3">
          <DialogDescription className="text-xs/relaxed text-foreground">{texts.body}</DialogDescription>
          {texts.paths === null ? null : (
            <ul className="max-h-[360px] overflow-y-auto rounded-sm border border-divider bg-canvas px-2 py-1.5 font-mono leading-[18px] select-text">
              {texts.paths.map((path) => (
                <li key={path} className="break-all">
                  {pathText(path)}
                </li>
              ))}
            </ul>
          )}
          {texts.more > 0 ? <p>{MORE_FILES(texts.more)}</p> : null}
          {texts.notices.map((notice) => (
            <p key={notice} className="flex items-start gap-2 rounded-sm bg-warning-fill p-2">
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden="true" className="mt-px size-(--icon-size) shrink-0 text-warning" />
              <span>{notice}</span>
            </p>
          ))}
          <p className="flex items-start gap-2 rounded-sm bg-removed-fill p-2">
            <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} aria-hidden="true" className="mt-px size-(--icon-size) shrink-0 text-removed" />
            <span>{NO_UNDO}</span>
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-divider px-3 py-2">
          <Button ref={cancel} variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button data-danger="true" className="bg-removed text-surface hover:bg-removed/80" onClick={onConfirm}>
            {texts.button}
          </Button>
        </div>
      </DialogContent>
    </AlertDialog.Root>
  );
}
