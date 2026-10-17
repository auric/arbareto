// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useId, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import type { BridgeResponse } from "../bridge";
import { MenubarContent, MenubarGroup, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut, MenubarTrigger } from "../components/ui/menubar";
import { codeText } from "./RepositoryStates";

// plan.md "Compact token system" (Icons, repository menu) and contract §3 `revokeTrust`. The menu holds actions only.

/** plan.md "Compact token system", Icons: each header menu is at least 220 DIPs wide, so a label and its key stay on one line. */
export const MENU_CONTENT = "min-w-[220px]";

/** The key of a menu item in a right-aligned Muted text column. It never wraps. */
export function MenuKey({ children }: { children: string }) {
  return <MenubarShortcut className="ml-auto pl-4 text-xs tracking-normal whitespace-nowrap text-muted-text">{children}</MenubarShortcut>;
}

// plan.md "Long text": a count of 1 takes the singular noun.
const processes = (n: number) => (n === 1 ? "1 process" : `${n} processes`);

function revokeText(response: BridgeResponse): ReactNode {
  const ended = (response.result as { endedProcesses?: unknown } | undefined)?.endedProcesses;
  if (response.state === "succeeded" && typeof ended === "number") return `Trust revoked. The revoke ended ${processes(ended)}.`;
  // Contract §5 "Deadline outcomes": after a `revoke` deadline, the service revocation stays, and the process count is unknown.
  if (response.state === "failed" && response.code === "DEADLINE") return "Trust revoked. The process count is unknown, because the revoke reached its deadline.";
  return codeText("Revoke trust did not complete: ", response.code ?? response.state);
}

export type RepositoryMenuProps = {
  /** True while a repository is open. Review repository trust needs one. */
  repositoryOpen: boolean;
  /** The current trust ID of the workspace (contract §3 `readTrust`). Without it, Revoke trust is unavailable. */
  trustId: string | null;
  /** Open folder… (Ctrl+O): runs `chooseRepository`. */
  onOpenRepository(): void;
  /** Recent repositories (Ctrl+R): opens the switcher. The item stays disabled without it. */
  onOpenRecent?(): void;
  onSelectGit(): void;
  /** Feature 003 FR-046: opens the clone panel. The item stays disabled without it. */
  onClone?(): void;
  /** Feature 003 plan.md D12: opens the settings panel. The item stays disabled without it. */
  onOpenSettings?(): void;
  onReviewTrust(): void;
  revokeTrust(trustId: string): Promise<BridgeResponse>;
  /** Update submodules: opens the submodule review (contract §12). The item stays disabled without it. */
  onUpdateSubmodules?(): void;
  /** The reason of a workbench state that blocks mutations, or null. The item then stays focusable and does nothing (plan.md "Unavailable control"). */
  updateSubmodulesReason?: string | null;
  onOpenChange?(open: boolean): void;
  triggerRef?: Ref<HTMLButtonElement>;
  finalFocus?: ComponentProps<typeof MenubarContent>["finalFocus"];
};

/** The repository menu of the header menu bar. Render it inside `Menubar`. */
export function RepositoryMenu({ repositoryOpen, trustId, onOpenRepository, onOpenRecent, onSelectGit, onClone, onOpenSettings, onReviewTrust, revokeTrust, onUpdateSubmodules, updateSubmodulesReason = null, onOpenChange, triggerRef, finalFocus }: RepositoryMenuProps) {
  const updateReasonId = useId();
  const [revoked, setRevoked] = useState<ReactNode>(null);
  const [revoking, setRevoking] = useState(false);

  async function revoke() {
    if (trustId === null || revoking) return;
    setRevoking(true);
    setRevoked(revokeText(await revokeTrust(trustId)));
    setRevoking(false);
  }

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
          <MenubarItem disabled={!repositoryOpen} onClick={onReviewTrust}>
            Review repository trust
          </MenubarItem>
          <MenubarItem disabled={trustId === null || revoking} closeOnClick={false} onClick={() => void revoke()}>
            Revoke trust
          </MenubarItem>
          <div role="status" className="px-2 py-1.5 text-xs whitespace-normal text-muted-foreground">
            {revoked}
          </div>
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
