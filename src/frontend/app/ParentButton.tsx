// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { FolderUpIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import type { Parent } from "../state/workbench";

// Feature 005 spec FR-051, plan.md D11 "Open parent repository" and D15 "Parent button" (SubmoduleOpen board).

/** The 28 px header button before the repository button: the folder-up icon and the parent folder name. */
export function ParentButton({ parent, onOpen }: { parent: Parent; onOpen(): void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button data-slot="parent-button" variant="outline" size="sm" className="h-7 shrink-0 gap-1 px-2" aria-label={`Open parent repository ${parent.name}, ${parent.path}`} onClick={onOpen}>
            <HugeiconsIcon icon={FolderUpIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
            <span>{parent.name}</span>
          </Button>
        }
      />
      <TooltipContent>
        Open parent repository
        <span className="block font-mono">{parent.path}</span>
      </TooltipContent>
    </Tooltip>
  );
}
