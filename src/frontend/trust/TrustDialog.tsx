// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useId, useRef, useState, type RefObject } from "react";
import type { z } from "zod";
import type { ReadTrustResult } from "../../contracts/envelope";
import type { createBridge } from "../bridge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { dialogSize, type Size } from "../layout/profiles";

// plan.md "Required visible states" (Trust required/changed), "Dialog sizes", and "Keyboard and focus" (Trust dialog row). Contract §3 `readTrust` and `approveTrust`, and §7.

// Type-only imports keep zod out of the renderer bundle.
export type TrustReport = Exclude<z.infer<typeof ReadTrustResult>, { remedy: unknown }>;
type TrustApproved = { trustId: string; persistence: "stored" | "session"; saveFailed: boolean };
type Bridge = Pick<ReturnType<typeof createBridge>, "approveTrust">;

// The native trust confirmation text (src-tauri/src/dialogs.rs `trust_confirmation`).
const CODE_EXECUTION = "Approval lets Git run the programs that this repository's configuration names.";
// Contract §7 "Program file digests": the bound names of the native confirmation (src-tauri/src/dialogs.rs `bound_text`).
const BOUND_TEXT: Record<NonNullable<TrustReport["bound"]>, string> = {
  "file-count": "64 files",
  "file-bytes": "1 MiB per file",
  "total-bytes": "8 MiB total",
  link: "a link that Arbareto cannot follow",
  name: "a file name that Arbareto cannot check",
};
const SESSION_ONLY = "Arbareto cannot check these program files for later edits. This approval lasts until Arbareto closes or its Git service restarts.";
// Contract §7 "Trust approval store".
const PERSISTS = "Arbareto keeps this approval across launches until you revoke trust, or until the named programs or the Git selection change.";
export const SAVE_FAILED_TEXT = "Arbareto could not save this approval. This approval lasts until Arbareto closes or its Git service restarts.";

/** The notice after an `approveTrust` result with `saveFailed: true`. The mount places it, because the dialog closes on approval. */
export function SaveFailedNotice() {
  return <p role="status">{SAVE_FAILED_TEXT}</p>;
}

/** Contract §7 "Mutation trust": commit review shows the dialog first only when commit needs an approval that the workspace lacks. */
export function trustBeforeReview(report: TrustReport): boolean {
  return report.approvalRequired.commit && report.state !== "approved";
}

// Git `config list --show-scope --show-origin` line form.
const entryLine = (e: TrustReport["entries"][number]) => `${e.scope}\t${e.origin}\t${e.key}${e.value === undefined ? "" : `=${e.value}`}`;
const hookLine = (h: TrustReport["hooks"][number]) => ("path" in h ? `${h.event}\t${h.path}` : `${h.scope}\thook.${h.name}.event=${h.event}`);

export type TrustDialogProps = {
  open: boolean;
  report: TrustReport;
  repositoryId: string;
  bridge: Bridge;
  /** The main window client size in DIPs. */
  client: Size;
  /** The opener, or the nearest surviving logical control. */
  finalFocus: RefObject<HTMLElement | null> | (() => HTMLElement | null);
  onCancel(): void;
  onApproved(result: TrustApproved): void;
  /** A result other than `succeeded` or `canceled`. */
  onFailed?(response: Awaited<ReturnType<Bridge["approveTrust"]>>): void;
};

export function TrustDialog({ open, report, repositoryId, bridge, client, finalFocus, onCancel, onApproved, onFailed }: TrustDialogProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const approveButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const size = dialogSize("trust", client);

  async function approve() {
    if (busy) return;
    setBusy(true);
    const response = await bridge.approveTrust({ repositoryId, repositoryGeneration: report.generation }, { fingerprint: report.fingerprint, approve: true });
    setBusy(false);
    // A declined native confirmation stores nothing and keeps the dialog.
    if (response.state === "canceled") approveButton.current?.focus();
    else if (response.state === "succeeded" && typeof (response.result as TrustApproved | undefined)?.trustId === "string") onApproved(response.result as TrustApproved);
    else onFailed?.(response);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        showCloseButton={false}
        initialFocus={heading}
        finalFocus={finalFocus}
        className="flex max-w-none flex-col gap-0 p-0 sm:max-w-none"
        style={{ width: size.width, height: size.height }}
      >
        <DialogTitle ref={heading} id={headingId} tabIndex={-1} className="px-4 py-3">
          {report.state === "changed" ? "Trust changed" : "Trust required"}
        </DialogTitle>
        <div role="region" aria-labelledby={headingId} tabIndex={0} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-2">
          <p>{CODE_EXECUTION}</p>
          {report.bound === undefined ? (
            <p>{PERSISTS}</p>
          ) : (
            <p>
              Reached bound: {BOUND_TEXT[report.bound]}. {SESSION_ONLY}
            </p>
          )}
          <ul className="font-mono">
            {report.entries.map((e, i) => (
              <li key={`e${i}`} className="break-all whitespace-pre-wrap">
                {entryLine(e)}
              </li>
            ))}
            {report.hooks.map((h, i) => (
              <li key={`h${i}`} className="break-all whitespace-pre-wrap">
                {hookLine(h)}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 justify-end gap-2 px-4 py-3">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" ref={approveButton} onClick={() => void approve()}>
            Approve
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
