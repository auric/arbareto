// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon, AlertCircleIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useId, useRef, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { pathText, type DeletePlan } from "./file-actions";
import { formatCount } from "./file-tree";

// Feature 005 spec FR-026 to FR-029, plan.md D15 "Delete confirmation" (DeleteConfirm board).

export type DeleteConfirmProps = {
  plan: DeletePlan;
  onConfirm(): void;
  onCancel(): void;
  /** The control that gets focus after the dialog closes. */
  finalFocus?: () => HTMLElement | null;
};

function Notice({ icon, fill, tone, children }: { icon: IconSvgElement; fill: string; tone: string; children: ReactNode }) {
  return (
    <p className={`flex items-start gap-2 rounded-sm p-2 ${fill}`}>
      <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className={`mt-px size-(--icon-size) shrink-0 ${tone}`} />
      <span>{children}</span>
    </p>
  );
}

/** The modal confirmation of Delete and Delete permanently. Cancel has the initial focus (FR-026). */
export function DeleteConfirm({ plan, onConfirm, onCancel, finalFocus }: DeleteConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const n = plan.files.count;
  const files = n === 1 ? "1 file" : `${formatCount(n)} files`;
  const permanent = plan.mode === "permanent";
  const more = n - plan.files.paths.length;
  const notices = useId();
  const noticed = plan.tracked > 0 || plan.wsl || permanent;
  return (
    <Dialog open onOpenChange={(next) => void (next || onCancel())}>
      <DialogContent showCloseButton={false} initialFocus={cancel} finalFocus={finalFocus ?? true} aria-describedby={noticed ? notices : undefined} className="flex flex-col gap-0 p-0 sm:max-w-lg">
        <div className="flex items-start gap-2 px-4 pt-4 pb-2">
          <HugeiconsIcon icon={permanent ? Alert02Icon : Delete02Icon} strokeWidth={2} aria-hidden="true" className={`mt-0.5 size-(--icon-size) shrink-0 ${permanent ? "text-removed" : ""}`} />
          <DialogTitle className="text-sm/5 font-semibold">{permanent ? `Delete ${files} permanently?` : `Move ${files} to the Recycle Bin?`}</DialogTitle>
        </div>
        <div className="flex min-h-0 flex-col gap-2 px-4 pb-3">
          {plan.folder === null ? null : (
            <p>
              {`Arbareto deletes the ${formatCount(n)} listed files in `}
              <code>{pathText(plan.folder)}</code>
              {". Ignored and tracked files that the list does not show stay."}
            </p>
          )}
          <ul className="max-h-[360px] overflow-y-auto rounded-sm border border-divider bg-canvas px-2 py-1.5 font-mono leading-[18px] select-text">
            {plan.files.paths.map((path) => (
              <li key={path} className="break-all">
                {pathText(path)}
              </li>
            ))}
          </ul>
          {more > 0 ? <p>{more === 1 ? "and 1 more file." : `and ${formatCount(more)} more files.`}</p> : null}
          {noticed ? (
            <div id={notices} className="flex flex-col gap-2">
              {plan.tracked > 0 ? (
                <Notice icon={Alert02Icon} fill="bg-warning-fill" tone="text-warning">{`Git tracks ${formatCount(plan.tracked)} of these files. The index does not change. Git then shows them as deleted.`}</Notice>
              ) : null}
              {plan.wsl ? (
                <Notice icon={Alert02Icon} fill="bg-warning-fill" tone="text-warning">
                  Files in a WSL distro have no Recycle Bin.
                </Notice>
              ) : null}
              {permanent ? (
                <Notice icon={AlertCircleIcon} fill="bg-removed-fill" tone="text-removed">
                  You cannot undo this.
                </Notice>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-divider px-3 py-2">
          <Button ref={cancel} variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button className="bg-removed text-surface hover:bg-removed/80" onClick={onConfirm}>
            {permanent ? "Delete permanently" : "Move to Recycle Bin"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Plan D15 "Delete review refusal in place" (decision U3): the refusal takes the dialog area. Close has the initial focus. */
export function DeleteRefusal({ text, onClose, finalFocus }: { text: string; onClose(): void; finalFocus?: () => HTMLElement | null }) {
  const close = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(next) => void (next || onClose())}>
      <DialogContent showCloseButton={false} initialFocus={close} finalFocus={finalFocus ?? true} className="flex flex-col gap-0 p-0 sm:max-w-lg">
        <div className="flex items-start gap-2 px-4 pt-4 pb-3">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden="true" className="mt-0.5 size-(--icon-size) shrink-0 text-warning" />
          <DialogTitle className="text-sm/5 font-semibold">{text}</DialogTitle>
        </div>
        <div className="flex justify-end gap-2 border-t border-divider px-3 py-2">
          <Button ref={close} variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
