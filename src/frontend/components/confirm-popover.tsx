// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRef, type ReactNode } from "react";
import { Button } from "./ui/button";

// Feature 004 plan.md D15 "Confirm popover" and D16 danger rules.

export type ConfirmPopoverProps = {
  open: boolean;
  /** The row that the confirmation sits next to. */
  anchor: Element | null;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  /** A destructive confirmation uses the filled danger button (D16). */
  danger?: boolean;
  onConfirm(): void;
  /** Cancel, Escape, and an outside press. */
  onCancel(): void;
};

/** A modal Base UI popover next to its row. Cancel has the first focus. */
export function ConfirmPopover({ open, anchor, title, children, confirmLabel, danger = false, onConfirm, onCancel }: ConfirmPopoverProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <PopoverPrimitive.Root open={open} modal onOpenChange={(next) => !next && onCancel()}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <PopoverPrimitive.Popup
            data-slot="popover-content"
            initialFocus={cancel}
            className="flex w-[min(480px,calc(100vw-32px))] flex-col gap-3 rounded-lg bg-popover p-3 text-xs text-popover-foreground ring-1 ring-control-border outline-hidden"
          >
            <PopoverPrimitive.Title className="font-semibold">{title}</PopoverPrimitive.Title>
            {children}
            <div className="flex items-center justify-end gap-2">
              <Button ref={cancel} variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button className={danger ? "danger-button" : undefined} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
