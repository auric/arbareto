// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, type ReactNode } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";

// plan.md "Notice band" and "Long text" (singular counts).

type OperationState = WorkspaceSnapshot["operationState"];

// plan.md "Notice band" item 1 names only these four unfinished operations. `sequencer-active` and `unknown` have no plan.md sentence.
const OPERATION: Partial<Record<OperationState, string>> = {
  merging: "A merge",
  rebasing: "A rebase",
  "cherry-picking": "A cherry-pick",
  reverting: "A revert",
};
const SECOND = "Arbareto blocks changes until you finish it outside Arbareto and select Refresh (F5).";

const files = (n: number) => (n === 1 ? "1 conflicted file" : `${n} conflicted files`);

/** The first sentence of the blocking row, or null when plan.md gives none for the state. */
export function blockingText(operationState: OperationState, conflicted: number): string | null {
  const operation = OPERATION[operationState];
  if (operation !== undefined) return conflicted > 0 ? `${operation} is in progress, with ${files(conflicted)}.` : `${operation} is in progress.`;
  if (conflicted > 0) return conflicted === 1 ? "1 file has conflicts." : `${conflicted} files have conflicts.`;
  return null;
}

export function WarningIcon() {
  return <HugeiconsIcon icon={Alert02Icon} size="1em" strokeWidth={2} aria-hidden="true" className="shrink-0 text-warning" />;
}

export type NoticeBandProps = {
  operationState: OperationState;
  /** The Conflicted entry count of the latest complete read. */
  conflicted: number;
  /** The T235 submodule row. */
  submoduleRow?: ReactNode;
};

/** The notice band: the blocking row, then the submodule row. It renders nothing without a row, so F6 skips it. */
export function NoticeBand({ operationState, conflicted, submoduleRow }: NoticeBandProps) {
  const headingId = useId();
  const first = blockingText(operationState, conflicted);
  if (first === null && !submoduleRow) return null;
  return (
    <section aria-labelledby={headingId} className="flex items-start gap-3 border-b border-divider bg-warning-fill px-2">
      <h2 id={headingId} tabIndex={-1} className="shrink-0 font-semibold" style={{ lineHeight: "var(--h-band-row)" }}>
        Notices
      </h2>
      <div className="flex min-w-0 flex-1 flex-col">
        {first === null ? null : (
          <p className="flex items-center gap-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
            <WarningIcon />
            <span>
              {first} {SECOND}
            </span>
          </p>
        )}
        {submoduleRow}
      </div>
    </section>
  );
}
