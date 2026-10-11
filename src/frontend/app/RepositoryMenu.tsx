// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useState, type ComponentProps, type ReactNode, type Ref } from "react";
import type { BridgeResponse } from "../bridge";
import { MenubarContent, MenubarGroup, MenubarItem, MenubarLabel, MenubarMenu, MenubarSeparator, MenubarShortcut, MenubarTrigger } from "../components/ui/menubar";
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
  onReviewTrust(): void;
  revokeTrust(trustId: string): Promise<BridgeResponse>;
  /** Update submodules: opens the submodule review (contract §12). The item stays disabled without it. */
  onUpdateSubmodules?(): void;
  onOpenChange?(open: boolean): void;
  triggerRef?: Ref<HTMLButtonElement>;
  finalFocus?: ComponentProps<typeof MenubarContent>["finalFocus"];
};

/** The repository menu of the header menu bar. Render it inside `Menubar`. */
export function RepositoryMenu({ repositoryOpen, trustId, onOpenRepository, onOpenRecent, onSelectGit, onReviewTrust, revokeTrust, onUpdateSubmodules, onOpenChange, triggerRef, finalFocus }: RepositoryMenuProps) {
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
        </MenubarGroup>
        <MenubarSeparator />
        <MenubarGroup>
          <MenubarItem onClick={onSelectGit}>Select Git</MenubarItem>
        </MenubarGroup>
        <MenubarSeparator />
        <MenubarGroup>
          <MenubarItem disabled={!repositoryOpen} onClick={onReviewTrust}>
            Review repository trust
          </MenubarItem>
          <MenubarItem disabled={trustId === null || revoking} closeOnClick={false} onClick={() => void revoke()}>
            Revoke trust
          </MenubarItem>
          <MenubarLabel role="status" className="whitespace-normal">
            {revoked}
          </MenubarLabel>
        </MenubarGroup>
        <MenubarSeparator />
        <MenubarGroup>
          <MenubarItem disabled={onUpdateSubmodules === undefined} onClick={onUpdateSubmodules}>
            Update submodules
          </MenubarItem>
        </MenubarGroup>
      </MenubarContent>
    </MenubarMenu>
  );
}
