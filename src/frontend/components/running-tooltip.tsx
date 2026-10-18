// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// Feature 003 plan.md D12 and feature 004 plan.md D15 running rule.

/** The reason while an operation runs. It goes only into the tooltip and the accessible description. */
export const RUNNING_REASON = "A Git operation is running. Its progress and Cancel are in the status bar.";

/** Gives `children`, an unavailable control, the tooltip `reason`. The caller hides its own reason element. A null reason adds no tooltip. */
export function RunningTooltip({ reason, children }: { reason: string | null; children: ReactElement }) {
  if (reason === null) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
