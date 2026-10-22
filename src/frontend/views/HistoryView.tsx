// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { BlameView } from "../blame/BlameView";
import type { Inspection } from "../state/history-view";

// Feature 004 plan.md D15 "Views": History shows the references sidebar, the history list, and the dock.

/** The History view. It stays mounted while another view shows, so the list keeps its scroll and selection. */
export function HistoryView({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div data-view="history" hidden={!active} className="flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  );
}

export type HistoryListSlotProps = {
  inspection: Inspection;
  /** Enter or a click on a blame line selects that commit in History (feature 005 spec FR-056). */
  onSelectCommit(oid: string): unknown;
  /** Runs after Back or Escape closed the blame view. */
  onBack?(): void;
  now?: () => number;
  /** The History list. */
  children: ReactNode;
};

/** Feature 005 plan.md D15 "Blame view": the blame view takes the place of the History list. The list stays mounted and keeps its scroll and selection. */
export function HistoryListSlot({ inspection, onSelectCommit, onBack, now, children }: HistoryListSlotProps) {
  const open = useSyncExternalStore(inspection.subscribe, () => inspection.getState().blame !== null, () => inspection.getState().blame !== null);
  const list = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);
  // Spec FR-054: Back and Escape return to the History list, so the focus goes to its Tab stop.
  useEffect(() => {
    if (wasOpen.current && !open) list.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <>
      <div ref={list} hidden={open} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
      {open ? (
        <BlameView
          inspection={inspection}
          now={now}
          onSelectCommit={(oid) => void onSelectCommit(oid)}
          onBack={() => {
            inspection.closeBlame();
            onBack?.();
          }}
        />
      ) : null}
    </>
  );
}
