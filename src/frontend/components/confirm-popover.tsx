// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useRef, type ReactNode, type RefObject } from "react";
import { Button } from "./ui/button";

// Feature 004 plan.md D15 "Confirm popover" and D16 danger rules.

export type ConfirmPopoverProps = {
  open: boolean;
  /** The row that the confirmation sits next to. */
  anchor: Element | null;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  /** The label of the Cancel button. The default is "Cancel". */
  cancelLabel?: string;
  /** A destructive confirmation uses the filled danger button (D16). */
  danger?: boolean;
  /** Without it, the popover shows Cancel only, such as for a refusal. */
  onConfirm?(): void;
  /** The first focus. The default is Cancel. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Cancel, Escape, and an outside press. */
  onCancel(): void;
};

/** A modal Base UI popover next to its row. Cancel has the first focus. */
export function ConfirmPopover({ open, anchor, title, children, confirmLabel, cancelLabel = "Cancel", danger = false, onConfirm, onCancel, initialFocus }: ConfirmPopoverProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <PopoverPrimitive.Root open={open} modal onOpenChange={(next) => !next && onCancel()}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <PopoverPrimitive.Popup
            data-slot="popover-content"
            initialFocus={initialFocus ?? cancel}
            className="flex w-[min(480px,calc(100vw-32px))] flex-col gap-3 rounded-lg bg-popover p-3 text-xs text-popover-foreground ring-1 ring-control-border outline-hidden"
          >
            <PopoverPrimitive.Title className="font-semibold">{title}</PopoverPrimitive.Title>
            {children}
            <div className="flex items-center justify-end gap-2">
              <Button ref={cancel} variant="outline" onClick={onCancel}>
                {cancelLabel}
              </Button>
              {onConfirm === undefined ? null : (
                <Button className={danger ? "danger-button" : undefined} onClick={onConfirm}>
                  {confirmLabel}
                </Button>
              )}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
