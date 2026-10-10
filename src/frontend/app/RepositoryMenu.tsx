// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useState, type ComponentProps, type ReactNode } from "react";
import type { Environment } from "../../contracts/envelope";
import type { BridgeResponse } from "../bridge";
import { MenubarContent, MenubarGroup, MenubarItem, MenubarLabel, MenubarMenu, MenubarSeparator, MenubarTrigger } from "../components/ui/menubar";
import { codeText } from "./RepositoryStates";

// plan.md "Provisional prerequisite admission", "Compact token system" (repository menu), and contract §3 `revokeTrust`.

type Scope = Environment["platformScope"];

/** The selected Git path and version. Scope `other` adds the "Unqualified platform" label beside the version. */
export function GitVersionRow({ path, version, scope }: { path: string; version: string; scope: Scope | undefined }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="break-all">Git: {path}</span>
      <span className="flex flex-wrap items-center gap-2">
        <span>Version {version}</span>
        {scope === "other" ? <span className="badge border-control-border">Unqualified platform</span> : null}
      </span>
    </span>
  );
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
  environment: Environment | null;
  /** The worktree root and HEAD text of the open workspace. */
  path: string | null;
  head: string | null;
  /** The distro of a WSL workspace, and its approved Git, from the snapshot `location` (data-model §2). */
  distro?: string | null;
  wslGit?: { path: string; version: string } | null;
  /** The current trust ID of the workspace (contract §3 `readTrust`). Without it, Revoke trust is unavailable. */
  trustId: string | null;
  onOpenRepository(): void;
  onSelectGit(): void;
  onReviewTrust(): void;
  revokeTrust(trustId: string): Promise<BridgeResponse>;
  onOpenChange?(open: boolean): void;
  finalFocus?: ComponentProps<typeof MenubarContent>["finalFocus"];
};

/** The repository menu of the header menu bar. Render it inside `Menubar`. */
export function RepositoryMenu({ environment, path, head, distro = null, wslGit = null, trustId, onOpenRepository, onSelectGit, onReviewTrust, revokeTrust, onOpenChange, finalFocus }: RepositoryMenuProps) {
  const [revoked, setRevoked] = useState<ReactNode>(null);
  const [revoking, setRevoking] = useState(false);
  const gitPath = environment?.selectedPath;
  const version = environment?.detectedVersion;

  async function revoke() {
    if (trustId === null || revoking) return;
    setRevoking(true);
    setRevoked(revokeText(await revokeTrust(trustId)));
    setRevoking(false);
  }

  return (
    <MenubarMenu onOpenChange={onOpenChange}>
      <MenubarTrigger>Repository</MenubarTrigger>
      <MenubarContent finalFocus={finalFocus}>
        <MenubarGroup>
          <MenubarLabel className="break-all whitespace-normal">{path ?? "No repository"}</MenubarLabel>
          {head === null ? null : <MenubarLabel className="break-all whitespace-normal">HEAD: {head}</MenubarLabel>}
        </MenubarGroup>
        <MenubarSeparator />
        <MenubarItem onClick={onOpenRepository}>Open repository</MenubarItem>
        <MenubarSeparator />
        {distro === null ? null : (
          // plan.md "Required visible states", WSL location: the label above the distro Git path and version.
          <MenubarGroup>
            <MenubarLabel className="break-all whitespace-normal">WSL: {distro}</MenubarLabel>
            {wslGit === null ? null : (
              <MenubarLabel className="whitespace-normal">
                <GitVersionRow path={wslGit.path} version={wslGit.version} scope={environment?.platformScope} />
              </MenubarLabel>
            )}
          </MenubarGroup>
        )}
        <MenubarGroup>
          {environment && gitPath !== undefined && version !== undefined ? (
            <MenubarLabel className="whitespace-normal">
              <GitVersionRow path={gitPath} version={version} scope={environment.platformScope} />
            </MenubarLabel>
          ) : null}
          <MenubarItem onClick={onSelectGit}>Select Git</MenubarItem>
        </MenubarGroup>
        <MenubarSeparator />
        <MenubarGroup>
          <MenubarItem disabled={path === null} onClick={onReviewTrust}>
            Review repository trust
          </MenubarItem>
          <MenubarItem disabled={trustId === null || revoking} closeOnClick={false} onClick={() => void revoke()}>
            Revoke trust
          </MenubarItem>
          <MenubarLabel role="status" className="whitespace-normal">
            {revoked}
          </MenubarLabel>
        </MenubarGroup>
      </MenubarContent>
    </MenubarMenu>
  );
}
