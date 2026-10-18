// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ReactNode } from "react";

// Feature 004 plan.md D15 "Views" and F6 order: the scope bar, the page list, then the page content. Spec FR-068.

export type SettingsViewProps = {
  /** The scope bar under the top bar. */
  scopeBar?: ReactNode;
  /** The page list. */
  pages?: ReactNode;
  /** The page content. It holds Close, which returns to the earlier view. */
  children: ReactNode;
};

/** The Settings view, a full view inside the main window. */
export function SettingsView({ scopeBar, pages, children }: SettingsViewProps) {
  return (
    <div data-view="settings" className="flex min-h-0 flex-1 flex-col">
      {scopeBar === undefined ? null : (
        <div data-section="scopeBar" className="shrink-0 border-b border-divider">
          {scopeBar}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {pages === undefined ? null : (
          <div data-section="pageList" className="min-h-0 shrink-0 overflow-y-auto border-r border-divider">
            {pages}
          </div>
        )}
        <div data-section="pageContent" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
