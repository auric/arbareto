// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { GitMergeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { formatCount } from "../changes/file-tree";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { RESOLVE_CONFLICTS, RESOLVE_TOOLTIP } from "../sync/ConflictActions";

// Feature 004 plan.md D15 "Working directory and Index rows" and O-11: a selection docks a summary. Enter or a double-click on the row opens the Commit view.
// Plan D15 "Conflict guidance" (spec FR-103): with unmerged entries, the summary names the conflicted count and offers Resolve conflicts first.

export const OPEN_COMMIT_VIEW = "Open Commit view (Enter)";
const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;

type WorkingSummaryProps = { working: number; staged: number; conflicted: number; onOpen(): void; onResolve(): void };

/** The docked summary of the Working directory and Index rows, with the 004 fixed phrases "<n> working changes" and "<n> staged". */
export function WorkingSummary({ working, staged, conflicted, onOpen, onResolve }: WorkingSummaryProps) {
  return (
    <section aria-label="Working directory summary" className="flex flex-col items-start gap-2 p-2">
      <p>
        {`${plural(working, "working change", "working changes")}, ${formatCount(staged)} staged`}
        {conflicted === 0 ? null : (
          <>
            {", "}
            <span className="text-warning">{`${formatCount(conflicted)} conflicted`}</span>
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {conflicted === 0 ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="outline" size="sm" onClick={onResolve}>
                  <HugeiconsIcon icon={GitMergeIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
                  {RESOLVE_CONFLICTS}
                </Button>
              }
            />
            <TooltipContent>{RESOLVE_TOOLTIP}</TooltipContent>
          </Tooltip>
        )}
        <Button variant="outline" size="sm" onClick={onOpen}>
          {OPEN_COMMIT_VIEW}
        </Button>
      </div>
    </section>
  );
}
