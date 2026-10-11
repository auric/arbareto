// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { FolderSyncIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Ref } from "react";
import { WarningIcon } from "../app/NoticeBand";
import { Button } from "../components/ui/button";

// plan.md "Notice band" and "Required visible states", Submodule notice. The count is the `readWorkspace` `submoduleNotice.count` (contract §12 "Discovery notice").

export type SubmoduleNoticeProps = {
  count: number;
  /** Opens the submodule review. */
  onUpdate(): void;
  buttonRef?: Ref<HTMLButtonElement>;
};

/** The submodule row of the notice band. */
export function SubmoduleNotice({ count, onUpdate, buttonRef }: SubmoduleNoticeProps) {
  return (
    <div data-slot="submodule-notice" className="flex flex-wrap items-center gap-x-2 py-1" style={{ minHeight: "var(--h-band-row)" }}>
      <span data-icon="warning" className="inline-flex">
        <WarningIcon />
      </span>
      <span>{`Some submodules are not initialized or not at their recorded commit. Count: ${count}.`}</span>
      <Button ref={buttonRef} type="button" variant="outline" size="sm" onClick={onUpdate}>
        <HugeiconsIcon icon={FolderSyncIcon} strokeWidth={2} aria-hidden="true" />
        Update submodules
      </Button>
    </div>
  );
}
