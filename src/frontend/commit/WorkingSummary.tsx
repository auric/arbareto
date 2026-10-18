// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Button } from "../components/ui/button";

// Feature 004 plan.md D15 "Working directory and Index rows" and O-11: a selection docks a summary. Enter or a double-click on the row opens the Commit view.

export const OPEN_COMMIT_VIEW = "Open Commit view (Enter)";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The docked summary of the Working directory and Index rows, with the 004 fixed phrases "<n> working changes" and "<n> staged". */
export function WorkingSummary({ working, staged, onOpen }: { working: number; staged: number; onOpen(): void }) {
  return (
    <section aria-label="Working directory summary" className="flex flex-col items-start gap-2 p-2">
      <p>{`${plural(working, "working change", "working changes")}, ${staged} staged`}</p>
      <Button variant="outline" size="sm" onClick={onOpen}>
        {OPEN_COMMIT_VIEW}
      </Button>
    </section>
  );
}
