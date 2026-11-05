// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useId, useRef, type ComponentProps, type ReactNode, type RefObject } from "react";
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
  /** The focus target after the popover closes. A row under `aria-activedescendant` is no focus target, so its list takes the focus. */
  finalFocus?: ComponentProps<typeof PopoverPrimitive.Popup>["finalFocus"];
  /**
   * Feature 010 plan.md D3: the confirm button stays focusable but runs nothing. A non-null reason shows above the buttons and describes the button.
   * Omit it while the action can run.
   */
  unavailable?: { reason: string | null };
};

/** A modal Base UI popover next to its row. Cancel has the first focus. */
export function ConfirmPopover({ open, anchor, title, children, confirmLabel, cancelLabel = "Cancel", danger = false, onConfirm, onCancel, initialFocus, finalFocus, unavailable }: ConfirmPopoverProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const reason = unavailable?.reason ?? null;
  return (
    <PopoverPrimitive.Root open={open} modal onOpenChange={(next) => !next && onCancel()}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <PopoverPrimitive.Popup
            data-slot="popover-content"
            initialFocus={initialFocus ?? cancel}
            finalFocus={finalFocus}
            className="flex w-[min(480px,calc(100vw-32px))] flex-col gap-3 rounded-lg bg-popover p-3 text-xs text-popover-foreground ring-1 ring-control-border outline-hidden"
          >
            <PopoverPrimitive.Title className="font-semibold">{title}</PopoverPrimitive.Title>
            {children}
            {reason === null ? null : (
              <p id={reasonId} className="text-muted-text">
                {reason}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button ref={cancel} variant="outline" onClick={onCancel}>
                {cancelLabel}
              </Button>
              {onConfirm === undefined ? null : (
                <Button
                  className={danger ? "danger-button" : undefined}
                  disabled={unavailable !== undefined}
                  focusableWhenDisabled
                  aria-describedby={reason === null ? undefined : reasonId}
                  onClick={unavailable === undefined ? onConfirm : undefined}
                >
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
