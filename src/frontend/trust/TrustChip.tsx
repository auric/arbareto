// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ShieldCheckIcon, ShieldOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ReactNode } from "react";
import type { z } from "zod";
import type { ReadTrustResult } from "../../contracts/envelope";
import type { BridgeResponse } from "../bridge";
import { failureText } from "../app/RepositoryStates";
import { ActionMenu } from "../components/action-menu";
import { RUNNING_REASON } from "../components/running-tooltip";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

// Feature 004 plan.md D12 "Trust redesign (option d)", D15 "Trust texts", spec FR-069 to FR-075. Contract §3 `readTrust`, `approveTrust`, and `revokeTrust`.

// Type-only imports keep zod out of the renderer bundle.
export type TrustReport = Exclude<z.infer<typeof ReadTrustResult>, { remedy: unknown } | { reason: unknown }>;

export const SAVE_FAILED_TEXT = "Arbareto could not save this approval. This approval lasts until Arbareto closes or its Git service restarts.";
export const COMMIT_TRUST_TEXT = "Commit needs trust. Select Not trusted in the status bar to trust this repository.";
export const READS_TRUST_TEXT = "Arbareto reads no changes until you trust this repository.";
const TRUSTED = { label: "Trusted", tooltip: "Git runs this repository's own programs." };
const NOT_TRUSTED = { label: "Not trusted", tooltip: "Git does not run this repository's own programs." };
const STOPPED = "Arbareto no longer trusts this repository.";

/** The notice after an `approveTrust` result with `saveFailed: true`. */
export function SaveFailedNotice() {
  return <p role="status">{SAVE_FAILED_TEXT}</p>;
}

// Contract §3 `readTrust`: only a `TrustReport` has `programs` (feature 004 data-model §10).
export const isTrustReport = (value: unknown): value is TrustReport => typeof value === "object" && value !== null && typeof (value as { programs?: unknown }).programs === "object";

/** The code of a failed `readTrust`. Contract §5 "Trust report rows": an `OUTPUT_LIMIT` refusal adds its bound name. */
export function trustFailureCode(response: { state: string; code?: string; result?: unknown }): string {
  const reason = (response.result as { reason?: unknown } | null | undefined)?.reason;
  return `${response.code ?? response.state}${typeof reason === "string" ? ` ${reason}` : ""}`;
}

/** Contract §7 "Mutation trust": Commit asks first only when commit needs an approval that the workspace lacks. */
export function trustBeforeReview(report: TrustReport): boolean {
  return report.approvalRequired.commit && report.state !== "approved";
}

/** Contract §7: an input-limited listing never passes a gate, so Git runs no repository program then. */
const isTrusted = (report: TrustReport) => report.state === "approved" && report.inputLimited !== true;

/** Spec FR-073: the chip shows when the listing names a repository-controlled program, or when a class needs approval. */
export function showsChip(report: TrustReport): boolean {
  const named = Object.values(report.programs).some((kind) => kind.names.length > 0 || kind.more > 0);
  return named || Object.values(report.approvalRequired).some(Boolean);
}

/** Spec FR-074: the Stop trusting result. Contract §5 "Deadline outcomes": after a `revoke` deadline, the revocation stays and the count is unknown. */
export function stoppedText(response: BridgeResponse): ReactNode {
  const ended = (response.result as { endedProcesses?: unknown } | undefined)?.endedProcesses;
  if (response.state === "succeeded" && typeof ended === "number") {
    if (ended === 0) return STOPPED;
    return `${STOPPED} It stopped ${ended === 1 ? "1 program that was" : `${ended} programs that were`} still running.`;
  }
  if (response.state === "failed" && response.code === "DEADLINE") return `${STOPPED} Arbareto does not know how many programs it stopped, because Stop trusting reached its deadline.`;
  return failureText("Stop trusting", response);
}

/** Spec FR-072: the changes area while reads need trust. It never prompts by itself. */
export function ReadsTrustNotice({ onTrust }: { onTrust(): void }) {
  return (
    <div className="flex flex-col items-start gap-2 p-2">
      <p>{READS_TRUST_TEXT}</p>
      <Button variant="outline" size="sm" onClick={onTrust}>
        Trust…
      </Button>
    </div>
  );
}

export type TrustChipProps = {
  report: TrustReport;
  /** A mutation runs. Stop trusting never cancels running work (001 plan), so it is unavailable then. */
  running: boolean;
  onTrust(): void;
  onStop(trustId: string): void;
};

/** The status bar chip of D12. The menu holds the two trust actions. */
export function TrustChip({ report, running, onTrust, onStop }: TrustChipProps) {
  const [open, setOpen] = useState(false);
  const trusted = isTrusted(report);
  const face = trusted ? TRUSTED : NOT_TRUSTED;
  const trustId = report.trustId;
  const items = [
    { label: "Trust this repository…", icon: ShieldCheckIcon, reason: trusted ? "Trusted now" : null, onSelect: onTrust },
    {
      label: "Stop trusting this repository",
      icon: ShieldOffIcon,
      reason: trustId === undefined ? "Not trusted now" : running ? RUNNING_REASON : null,
      running: trustId !== undefined && running,
      onSelect: () => trustId !== undefined && onStop(trustId),
    },
  ];
  return (
    <Tooltip>
      <ActionMenu
        label="Repository trust"
        groups={[items]}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                data-slot="trust-chip"
                aria-label={`${face.label}. ${face.tooltip}`}
                className={`rounded-[4px] border ${trusted ? "border-control-border text-muted-text" : "border-warning text-warning"}`}
              />
            }
          >
            <HugeiconsIcon icon={trusted ? ShieldCheckIcon : ShieldOffIcon} strokeWidth={2} aria-hidden="true" className="size-4" />
            {face.label}
          </TooltipTrigger>
        }
      />
      <TooltipContent>{face.tooltip}</TooltipContent>
    </Tooltip>
  );
}
