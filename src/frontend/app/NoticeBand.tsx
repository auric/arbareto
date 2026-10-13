// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, type ReactNode } from "react";
import type { RecoveryStatement, WorkspaceSnapshot } from "../../contracts/envelope";
import type { SubmoduleRowResult } from "../../contracts/submodules";

// plan.md "Notice band" and "Long text" (singular counts).

type OperationState = WorkspaceSnapshot["operationState"];

// plan.md "Notice band" item 1, without the final period.
const OPERATION: Partial<Record<OperationState, string>> = {
  merging: "A merge is in progress",
  rebasing: "A rebase is in progress",
  "cherry-picking": "A cherry-pick is in progress",
  reverting: "A revert is in progress",
  "sequencer-active": "A cherry-pick or revert sequence is in progress",
  unknown: "Arbareto cannot identify the Git operation in progress",
};
const SECOND = "Arbareto blocks changes until you finish it outside Arbareto and select Refresh (F5).";

const files = (n: number) => (n === 1 ? "1 conflicted file" : `${n} conflicted files`);

/** The first sentence of the blocking row, or null when plan.md gives none for the state. */
export function blockingText(operationState: OperationState, conflicted: number): string | null {
  const operation = OPERATION[operationState];
  if (operation !== undefined) return conflicted > 0 ? `${operation}, with ${files(conflicted)}.` : `${operation}.`;
  if (conflicted > 0) return conflicted === 1 ? "1 file has conflicts." : `${conflicted} files have conflicts.`;
  return null;
}

// plan.md "Required visible states", Recovery statement.
const ATTRIBUTION_REASON = {
  ambiguous: "the branch history does not identify one commit",
  "evidence-limit": "the branch history holds more records than Arbareto checks",
} as const;
const INDEX_MATCH = {
  published: "The interrupted hunk or file action reached the index.",
  "not-published": "The interrupted hunk or file action did not reach the index.",
  neither: "The index matches neither the state before nor the state after the interrupted hunk or file action.",
} as const;
// plan.md "History graph design": a short ID is the first 12 hex digits.
const short = (oid: string | null) => oid?.slice(0, 12);
// plan.md "Required visible states", Updating submodules row states.
const SUBMODULE_STATE: Record<SubmoduleRowResult["state"], (row: SubmoduleRowResult) => string> = {
  cloned: () => "Cloned",
  moved: (row) => `Moved from ${short(row.oldCommit)} to ${short(row.newCommit)}`,
  unchanged: () => "No change",
  failed: () => "Failed",
  "clone-interrupted": () => "Clone interrupted",
  "changed-elsewhere": (row) => (row.newCommit === null ? "Changed elsewhere" : `Changed elsewhere to ${short(row.newCommit)}`),
  refused: () => "Refused",
};
const FOREIGN = "Another Git process or a crash can have left these files. Remove them only after all Git tools stop, including other Arbareto windows.";

/** The sentences of the recovery row before `foreign`, in field order. */
function recoverySentences({ outcome, attribution, indexMatch, submoduleResults }: RecoveryStatement): string[] {
  const out: string[] = [];
  if (outcome === "none") out.push("The earlier session ended, and Arbareto found nothing to reconcile.");
  if (attribution?.result === "identified") out.push(`The interrupted commit exists as ${short(attribution.commitOid)}.`);
  else if (attribution?.result === "none") out.push("The interrupted operation made no commit.");
  else if (attribution?.reason === "no-retained-request") out.push("Arbareto cannot tell what the interrupted operation changed, because this Git service session has no record of its request.");
  else if (attribution !== undefined) out.push(`Arbareto cannot tell if the interrupted operation made a commit, because ${ATTRIBUTION_REASON[attribution.reason]}.`);
  if (indexMatch !== undefined) out.push(INDEX_MATCH[indexMatch]);
  if (submoduleResults !== undefined) out.push("The interrupted submodule update left these rows:");
  return out;
}

function RecoveryRow({ recovery }: { recovery: RecoveryStatement }) {
  const foreign = recovery.foreign ?? [];
  const more = recovery.foreignTotal === undefined ? null : recovery.foreignTotal - foreign.length;
  return (
    <div className="flex items-start gap-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
      <span className="flex items-center" style={{ minHeight: "1lh" }}>
        <WarningIcon />
      </span>
      <div className="min-w-0">
        <p>{recoverySentences(recovery).join(" ")}</p>
        {recovery.submoduleResults?.map((row) => (
          <p key={row.rowId}>{`${row.path}: ${SUBMODULE_STATE[row.state](row)}`}</p>
        ))}
        {recovery.foreign === undefined ? null : <p>{FOREIGN}</p>}
        {foreign.map((path) => (
          <code key={path} className="block break-all">
            {path}
          </code>
        ))}
        {more === null ? null : <p>{more === 1 ? "and 1 more file" : `and ${more} more files`}</p>}
      </div>
    </div>
  );
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
  /** The `recovery` statement of the latest `refresh: true` read. */
  recovery?: RecoveryStatement;
  /**
   * Feature 002 contract Δ8: the refs or HEAD changed after the history view opened. The value is the Refresh control, which opens a new view.
   * The caller renders it, because this module must load without Base UI (tests/contracts/notice-band.test.tsx).
   */
  refsChanged?: ReactNode;
};

// Feature 002 spec FR-005, from the approved mockup canvas of plan.md D6.
const REFS_CHANGED = "References changed. History still shows the references from when it opened.";

/** The notice band: the blocking row, the submodule row, then the recovery row. It renders nothing without a row, so F6 skips it. */
export function NoticeBand({ operationState, conflicted, submoduleRow, recovery, refsChanged }: NoticeBandProps) {
  const headingId = useId();
  const first = blockingText(operationState, conflicted);
  const recoveryRow = recovery !== undefined && (recoverySentences(recovery).length > 0 || recovery.foreign !== undefined);
  if (first === null && !submoduleRow && !recoveryRow && !refsChanged) return null;
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
        {recovery !== undefined && recoveryRow ? <RecoveryRow recovery={recovery} /> : null}
        {!refsChanged ? null : (
          <p className="flex items-center gap-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
            <WarningIcon />
            <span>{REFS_CHANGED}</span>
            {refsChanged}
          </p>
        )}
      </div>
    </section>
  );
}
