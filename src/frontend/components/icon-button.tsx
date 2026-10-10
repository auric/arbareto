// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentProps } from "react";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export type IconButtonProps = Omit<ComponentProps<typeof Button>, "children" | "aria-label" | "aria-keyshortcuts"> & {
  icon: IconSvgElement;
  /** The accessible name. The tooltip repeats it. */
  label: string;
  /** The key: `aria` is the `aria-keyshortcuts` value, `text` is the tooltip text, as in "Alt+ArrowUp" and "Alt+Up". */
  keys?: { aria: string; text: string };
};

/** plan.md "Icons": an icon-only row button. The tooltip names the action and the key, and opens on hover and on keyboard focus. */
export function IconButton({ icon, label, keys, style, ...props }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-keyshortcuts={keys?.aria}
            style={{ width: "var(--h-row-button)", height: "var(--h-row-button)", ...style }}
            {...props}
          />
        }
      >
        {/* The icon keeps 16 DIPs at every text size. */}
        <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
      </TooltipTrigger>
      <TooltipContent>{keys === undefined ? label : `${label} (${keys.text})`}</TooltipContent>
    </Tooltip>
  );
}
