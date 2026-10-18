// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// Feature 004 plan.md D15 top bar and D16 components. The 004 boards mark the current part with `aria-current="page"`.

export type SegmentedOption<T extends string> = { value: T; label: string; tooltip: string };

/** A segmented control of text buttons. `value` null marks no part as current. */
export function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: readonly SegmentedOption<T>[]; value: T | null; onChange(value: T): void }) {
  return (
    <nav aria-label={label} data-slot="segmented" className="flex items-center rounded-sm border border-control-border">
      {options.map((option) => (
        <Tooltip key={option.value}>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                aria-current={option.value === value ? "page" : undefined}
                className="rounded-none px-3 aria-[current=page]:bg-selected-row aria-[current=page]:font-semibold"
                style={{ height: "var(--h-button)" }}
                onClick={() => option.value !== value && onChange(option.value)}
              />
            }
          >
            {option.label}
          </TooltipTrigger>
          <TooltipContent>{option.tooltip}</TooltipContent>
        </Tooltip>
      ))}
    </nav>
  );
}
