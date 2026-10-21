// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ReactNode } from "react";

// Feature 004 plan.md D15 "Views": History shows the references sidebar, the history list, and the dock.

/** The History view. It stays mounted while another view shows, so the list keeps its scroll and selection. */
export function HistoryView({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div data-view="history" hidden={!active} className="flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  );
}
