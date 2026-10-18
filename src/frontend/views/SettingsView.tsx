// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ReactNode } from "react";

// Feature 004 plan.md D15 "Views" and F6 order. Spec FR-068. WP22 adds the scope bar and the page list.

/** The Settings view, a full view inside the main window. `children` is the page content. It holds Close, which returns to the earlier view. */
export function SettingsView({ children }: { children: ReactNode }) {
  return (
    <div data-view="settings" className="flex min-h-0 flex-1 flex-col">
      <div data-section="pageContent" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}
