// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef } from "react";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { branchName } from "../history/HistoryView";
import { shortRef } from "../refs/ReferencesSidebar";
import { shortId } from "../status/OperationStatus";

// Feature 003 spec FR-024 and FR-025, plan.md D5, data-model §2 `binding.lease` and §3, and the approved "Push rejected" mockup.

export type ForcePlan = {
  destination: { remote: string; ref: string };
  lease: { trackingRef: string; count: number; commits: { objectId: string; subject: string | null }[] };
};

export type ForcePushConfirmProps = {
  plan: ForcePlan;
  /** The local branch name. */
  branch: string;
  onConfirm(): void;
  onCancel(): void;
  /** The control that gets focus after the dialog closes. */
  finalFocus?: () => HTMLElement | null;
};

const commits = (n: number) => (n === 1 ? "1 commit" : `${n} commits`);

/** The modal confirmation of Force push with lease. Cancel has the initial focus (FR-024). */
export function ForcePushConfirm({ plan, branch, onConfirm, onCancel, finalFocus }: ForcePushConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const { destination, lease } = plan;
  const tracking = shortRef(lease.trackingRef);
  const more = lease.count - lease.commits.length;
  return (
    <Dialog open onOpenChange={(next) => void (next || onCancel())}>
      <DialogContent showCloseButton={false} initialFocus={cancel} finalFocus={finalFocus ?? true} className="flex flex-col gap-2 sm:max-w-lg">
        <DialogTitle>{`Force push with lease to ${tracking}?`}</DialogTitle>
        <p>
          The push replaces <code>{destination.ref}</code> {`on ${destination.remote} with your branch ${branchName(branch)}. It removes ${commits(lease.count)} from the remote branch:`}
        </p>
        <ul className="max-h-60 overflow-y-auto">
          {lease.commits.map((c) => (
            <li key={c.objectId} className="flex gap-2">
              <code className="shrink-0">{shortId(c.objectId)}</code>
              {c.subject === null ? null : <span className="min-w-0 truncate">{c.subject}</span>}
            </li>
          ))}
        </ul>
        {more > 0 ? <p>{more === 1 ? "and 1 more commit" : `and ${more} more commits`}</p> : null}
        <p className="flex items-center gap-2">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0 text-warning" />
          {`Other people can lose work. The push stops if ${tracking} changed since the last fetch.`}
        </p>
        <div className="flex justify-end gap-2">
          <Button className="bg-removed text-surface hover:bg-removed/80" onClick={onConfirm}>
            Force push with lease
          </Button>
          <Button ref={cancel} variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
