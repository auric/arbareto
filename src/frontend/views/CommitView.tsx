// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ReactNode } from "react";

// Feature 004 plan.md D15 "Views" and spec FR-029, FR-033: a full view without the references sidebar.

/** The Commit view. `children` is the commit workspace: the Changes and Staged lists, the diff, and the message editor. */
export function CommitView({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Commit view" data-view="commit" className="flex min-h-0 flex-1 flex-col">
      {children}
    </section>
  );
}
