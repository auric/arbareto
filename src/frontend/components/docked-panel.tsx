// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useId, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { KEYS, scopedAction } from "../keyboard/shortcuts";
import { IconButton } from "./icon-button";
import { Button } from "./ui/button";

// Feature 004 plan.md D15 "Docked panel": a panel takes the dock region below the history list in place of the commit details.

/** The dock region. A panel hides the earlier content and keeps it mounted, so Close shows it again unchanged. */
export function DockRegion({ panel, children }: { panel: ReactNode; children: ReactNode }) {
  return (
    <>
      {panel}
      <div hidden={panel !== null && panel !== undefined} className="contents">
        {children}
      </div>
    </>
  );
}

export type DockedPanelProps = {
  title: string;
  /** The accessible name of the close button, such as "Close merge panel". */
  closeLabel: string;
  /** The primary action. A reason makes it unavailable and shows inline. */
  primary: { label: string; reason: string | null; onRun(): void };
  /** Removes the panel. Focus then returns to the control that had it before the panel opened. */
  onClose(): void;
  children: ReactNode;
};

export function DockedPanel({ title, closeLabel, primary, onClose, children }: DockedPanelProps) {
  const ids = { heading: useId(), reason: useId() };
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  const close = () => {
    flushSync(onClose);
    if (opener?.isConnected) opener.focus();
  };
  const run = () => primary.reason === null && primary.onRun();
  return (
    <section
      aria-labelledby={ids.heading}
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
          event.preventDefault();
          close();
        } else if (scopedAction(event, "panel") === "primary") {
          event.preventDefault();
          run();
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h2 id={ids.heading} className="flex-1 font-semibold">
          {title}
        </h2>
        <IconButton icon={Cancel01Icon} label={closeLabel} keys={{ aria: "Escape", text: "Esc" }} onClick={close} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">{children}</div>
      <div className="flex shrink-0 items-center gap-2 border-t border-divider p-2">
        <Button disabled={primary.reason !== null} focusableWhenDisabled aria-keyshortcuts={KEYS.primary.aria} aria-describedby={primary.reason === null ? undefined : ids.reason} onClick={run}>
          {`${primary.label} (${KEYS.primary.text})`}
        </Button>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        {primary.reason === null ? null : (
          <span id={ids.reason} className="text-muted-text">
            {primary.reason}
          </span>
        )}
      </div>
    </section>
  );
}
