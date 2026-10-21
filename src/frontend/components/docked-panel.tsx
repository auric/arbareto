// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { KEYS, scopedAction } from "../keyboard/shortcuts";
import { IconButton } from "./icon-button";
import { RunningTooltip } from "./running-tooltip";
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
  /** The Accent glyph before the title, such as the merge or rebase glyph (D16 "Geometry"). */
  icon?: IconSvgElement;
  /** The accessible name of the close button, such as "Close merge panel". */
  closeLabel: string;
  /** The primary action. A reason makes it unavailable and shows inline. A `quiet` reason (plan D15 running rule) shows only in the tooltip and the accessible description. */
  primary: { label: string; reason: string | null; quiet?: boolean; onRun(): void };
  /** The control that opened the panel, such as the branch row of a menu. Without it, the panel takes the element that has focus when it mounts. */
  opener?: Element | null;
  /** Removes the panel. Focus then returns to the opener. */
  onClose(): void;
  children: ReactNode;
};

export function DockedPanel({ title, icon, closeLabel, primary, opener: given, onClose, children }: DockedPanelProps) {
  const ids = { heading: useId(), reason: useId() };
  const [opener] = useState(() => given ?? (typeof document === "undefined" ? null : document.activeElement));
  const section = useRef<HTMLElement>(null);
  const restore = () => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };
  // A panel that unmounts with the focus inside it, or after its focused control left, returns the focus to the opener.
  useLayoutEffect(() => {
    const node = section.current;
    return () => {
      const active = document.activeElement;
      if (active === null || active === document.body || node?.contains(active)) restore();
    };
  }, []);
  const close = () => {
    flushSync(onClose);
    restore();
  };
  const run = () => primary.reason === null && primary.onRun();
  const quiet = primary.quiet === true && primary.reason !== null;
  return (
    <section
      ref={section}
      aria-labelledby={ids.heading}
      className="flex max-h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
          event.preventDefault();
          close();
        } else if (scopedAction(event.nativeEvent, "panel") === "primary") {
          event.preventDefault();
          run();
        }
      }}
    >
      {/* D16 "Geometry": the head is the Accent glyph, the title, and Close. The foot puts Cancel, then the primary button, at the right. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        {icon === undefined ? null : (
          <span data-slot="panel-icon" aria-hidden="true" className="flex shrink-0 items-center text-accent-role">
            <HugeiconsIcon icon={icon} strokeWidth={2} className="size-(--icon-size)" />
          </span>
        )}
        <h2 id={ids.heading} className="flex-1 font-semibold">
          {title}
        </h2>
        <IconButton icon={Cancel01Icon} label={closeLabel} keys={{ aria: "Escape", text: "Esc" }} onClick={close} />
      </div>
      {/* The panel takes its content height. Only this part scrolls, so the head and the foot stay visible. */}
      <div data-slot="panel-body" className="flex min-h-0 flex-col gap-2 overflow-auto p-3">
        {children}
      </div>
      <div data-slot="panel-foot" className="flex shrink-0 items-center justify-end gap-2 border-t border-divider px-3 py-2">
        {primary.reason === null ? null : (
          <span id={ids.reason} className={quiet ? "sr-only" : "mr-auto text-muted-text"}>
            {primary.reason}
          </span>
        )}
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <RunningTooltip reason={quiet ? primary.reason : null}>
          <Button disabled={primary.reason !== null} focusableWhenDisabled aria-keyshortcuts={KEYS.primary.aria} aria-describedby={primary.reason === null ? undefined : ids.reason} onClick={run}>
            {`${primary.label} (${KEYS.primary.text})`}
          </Button>
        </RunningTooltip>
      </div>
    </section>
  );
}
