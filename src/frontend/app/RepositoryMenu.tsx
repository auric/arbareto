// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useId, type ComponentProps, type Ref } from "react";
import { MenubarContent, MenubarGroup, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut, MenubarTrigger } from "../components/ui/menubar";

// plan.md "Compact token system" (Icons, repository menu). The menu holds actions only. Feature 004 plan.md D12 moves the trust actions to the status bar chip.

/** plan.md "Compact token system", Icons: each header menu is at least 220 DIPs wide, so a label and its key stay on one line. */
export const MENU_CONTENT = "min-w-[220px]";

/** The key of a menu item in a right-aligned Muted text column. It never wraps. The item gives the key in `aria-keyshortcuts`, so the column is hidden from assistive technology (feature 004 spec FR-085). */
export function MenuKey({ children }: { children: string }) {
  return <MenubarShortcut aria-hidden="true" className="ml-auto pl-4 text-xs tracking-normal whitespace-nowrap text-muted-text">{children}</MenubarShortcut>;
}

export type RepositoryMenuProps = {
  /** Open folder… (Ctrl+O): runs `chooseRepository`. */
  onOpenRepository(): void;
  /** Recent repositories (Ctrl+R): opens the switcher. The item stays disabled without it. */
  onOpenRecent?(): void;
  onSelectGit(): void;
  /** Feature 003 FR-046: opens the clone panel. The item stays disabled without it. */
  onClone?(): void;
  /** Feature 003 plan.md D12: opens the settings panel. The item stays disabled without it. */
  onOpenSettings?(): void;
  /** Update submodules: opens the submodule review (contract §12). The item stays disabled without it. */
  onUpdateSubmodules?(): void;
  /** The reason of a workbench state that blocks mutations, or null. The item then stays focusable and does nothing (plan.md "Unavailable control"). */
  updateSubmodulesReason?: string | null;
  onOpenChange?(open: boolean): void;
  triggerRef?: Ref<HTMLButtonElement>;
  finalFocus?: ComponentProps<typeof MenubarContent>["finalFocus"];
};

/** The repository menu of the header menu bar. Render it inside `Menubar`. */
export function RepositoryMenu({ onOpenRepository, onOpenRecent, onSelectGit, onClone, onOpenSettings, onUpdateSubmodules, updateSubmodulesReason = null, onOpenChange, triggerRef, finalFocus }: RepositoryMenuProps) {
  const updateReasonId = useId();
  return (
    <MenubarMenu onOpenChange={onOpenChange}>
      <MenubarTrigger ref={triggerRef}>Repository</MenubarTrigger>
      <MenubarContent finalFocus={finalFocus} className={MENU_CONTENT}>
        <MenubarGroup>
          <MenubarItem aria-keyshortcuts="Control+O" onClick={onOpenRepository}>
            Open folder…<MenuKey>Ctrl+O</MenuKey>
          </MenubarItem>
          <MenubarItem aria-keyshortcuts="Control+R" disabled={onOpenRecent === undefined} onClick={onOpenRecent}>
            Recent repositories<MenuKey>Ctrl+R</MenuKey>
          </MenubarItem>
          <MenubarItem disabled={onClone === undefined} onClick={onClone}>
            Clone…
          </MenubarItem>
        </MenubarGroup>
        <MenubarSeparator />
        <MenubarGroup>
          <MenubarItem onClick={onSelectGit}>Select Git</MenubarItem>
          <MenubarItem disabled={onOpenSettings === undefined} onClick={onOpenSettings}>
            Settings…
          </MenubarItem>
        </MenubarGroup>
        <MenubarSeparator />
        <MenubarGroup>
          <MenubarItem
            disabled={onUpdateSubmodules === undefined || updateSubmodulesReason !== null}
            aria-describedby={updateSubmodulesReason === null ? undefined : updateReasonId}
            onClick={updateSubmodulesReason === null ? onUpdateSubmodules : undefined}
          >
            Update submodules
          </MenubarItem>
          {updateSubmodulesReason === null ? null : (
            <div id={updateReasonId} aria-hidden className="px-2 py-1.5 text-xs whitespace-normal text-muted-text">
              {updateSubmodulesReason}
            </div>
          )}
        </MenubarGroup>
      </MenubarContent>
    </MenubarMenu>
  );
}
