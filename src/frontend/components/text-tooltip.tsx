// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// 001 plan.md "Icons": Arbareto shows no native `title` hover text. The caller keeps the same text in the accessible name or description.

/** Gives `children`, a DOM element, the house tooltip `text`. An array shows one line per item. */
export function TextTooltip({ text, children }: { text: string | readonly string[]; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent className={typeof text === "string" ? undefined : "flex-col items-start"}>{typeof text === "string" ? text : text.map((line, i) => <span key={i}>{line}</span>)}</TooltipContent>
    </Tooltip>
  );
}
