// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { FolderAddIcon } from "@hugeicons/core-free-icons";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { branchNameRefusal } from "../../contracts/branch-name";
import { unknownFormText } from "../app/RepositoryStates";
import type { BridgeResponse } from "../bridge";
import { DockedPanel } from "../components/docked-panel";
import { RUNNING_REASON } from "../components/running-tooltip";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { T as B } from "../branches/texts";
import { TEXTS } from "../integrate/texts";
import { splitPath, WINDOWS_SEPARATORS } from "../lib/path";
import { isObject } from "../lib/utils";
import { shortRef } from "../refs/ReferencesSidebar";
import type { Workbench } from "../state/workbench";
import { browseRefusal, W } from "./texts";

// Feature 004 spec FR-052 and FR-053, plan.md D10 and D15 "Docked panel", the Worktrees board.

/** The `worktree-add` payload parts, and "Switch to it after creating". */
export type AddRequest = { branch: { new: string; start: string } | { existing: string } | { track: { ref: string; name: string } }; path: string; switchTo: boolean };
/** The branch menu selection (spec FR-052): an existing local branch, or a new branch that tracks a remote-tracking branch. */
export type AddSelection = { existing: string } | { track: { ref: string; name: string } };

export type AddWorktreePanelProps = {
  workbench: Workbench;
  worktreeRoot: string | null;
  /** The commit that a new branch starts at, or null on an unborn branch. */
  start: string | null;
  blockedReason: string | null;
  running: boolean;
  opener: Element | null;
  /** The branch menu selection. Without it, the panel starts with New branch at `start`. */
  initial?: AddSelection;
  /** Reviews and runs the add. It gives the refusal text, or null. */
  onSubmit(request: AddRequest): Promise<string | null>;
  /** The `chooseWorktreeFolder` response (contract Δ3). */
  onBrowse(): Promise<BridgeResponse>;
  onClose(): void;
};

/**
 * Spec FR-052: the suggestion is a convenience, not a decision. It is the open worktree folder name and the last `/` part of the branch name,
 * beside the open worktree.
 */
export function suggestFolder(root: string | null, branch: string): string {
  if (root === null || branch === "") return "";
  const [parent, name] = splitPath(root.replace(/[\\/]+$/, ""), WINDOWS_SEPARATORS);
  const last = branch.slice(branch.lastIndexOf("/") + 1);
  return last === "" ? "" : `${parent}${name}-${last}`;
}

export function AddWorktreePanel({ workbench, worktreeRoot, start, blockedReason, running, opener, initial, onSubmit, onBrowse, onClose }: AddWorktreePanelProps) {
  const ids = { mode: useId(), folder: useId(), hint: useId(), start: useId() };
  const branches = useSyncExternalStore(workbench.subscribe, () => workbench.getState().branches, () => workbench.getState().branches);
  // A remote-tracking start is fixed. The new branch then tracks it (contract Δ3 `track`).
  const track = initial !== undefined && "track" in initial ? initial.track.ref : null;
  const [mode, setMode] = useState<"new" | "existing">(initial !== undefined && "existing" in initial ? "existing" : "new");
  const [name, setName] = useState(initial !== undefined && "track" in initial ? initial.track.name : "");
  const [existing, setExisting] = useState<string | null>(initial !== undefined && "existing" in initial ? initial.existing : null);
  // Null until the first folder edit. Then the folder stays.
  const [edited, setEdited] = useState<string | null>(null);
  // A parent from Browse before a suggested name. The folder follows the name in it until the first edit.
  const [picked, setPicked] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState(false);
  const [pending, setPending] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderField = useRef<HTMLInputElement>(null);

  // Spec FR-052: a branch that a worktree holds is left out. `current` is the branch of the open worktree, `heldBy` that of another worktree.
  const entries = branches?.entries ?? [];
  const free = entries.filter((e) => e.kind === "local" && !e.current && e.heldBy === null);
  // A fresh read can show the selected branch as current or held. Then no branch is selected until the user picks one.
  const chosen = existing === null ? (free[0] ?? null) : (free.find((e) => e.ref === existing) ?? null);
  const unfree = () => {
    const entry = entries.find((e) => e.ref === existing);
    if (entry?.current === true) return B.addCurrent;
    if (entry !== undefined && entry.heldBy !== null) return B.otherWorktree(entry.heldBy);
    // Null entries: no read result yet, or a failed read.
    return branches?.entries == null ? W.noFreeBranch : W.branchGone(shortRef(existing!));
  };
  const branchText = mode === "new" ? name : (chosen?.name ?? "");
  const suggested = suggestFolder(worktreeRoot, branchText);
  // Contract §6: a Windows path and a WSL UNC path both take `\`.
  const inParent = (parent: string) => `${parent.replace(/[\\/]+$/, "")}\\${splitPath(suggested, WINDOWS_SEPARATORS)[1]}`;
  const folder = edited ?? (picked === null || suggested === "" ? suggested : inParent(picked));

  const nameReason = (() => {
    if (mode === "existing") return chosen === null ? (existing === null ? W.noFreeBranch : unfree()) : chosen.name === "@" ? W.reservedName : null;
    if (track === null && start === null) return TEXTS.unborn;
    if (name === "") return W.enterName;
    const refusal = branchNameRefusal(name);
    return refusal === null ? null : refusal.code === "INVALID_REQUEST" ? W.invalidName : W.reservedName;
  })();
  const reason = running ? RUNNING_REASON : (blockedReason ?? (pending ? TEXTS.pending : (nameReason ?? (folder === "" ? W.enterFolder : null))));

  async function submit() {
    const branch = mode === "existing" ? { existing: chosen!.ref } : track !== null ? { track: { ref: track, name } } : { new: name, start: start! };
    setPending(true);
    setError(null);
    try {
      setError(await onSubmit({ branch, path: folder, switchTo }));
    } finally {
      setPending(false);
    }
  }

  /** A chosen parent gets the suggested name, and the folder then stays as after an edit. Without a suggested name, the folder follows the name. Cancel changes nothing. */
  async function browse() {
    setBrowsing(true);
    setError(null);
    try {
      const response = await onBrowse();
      const parent = response.state === "succeeded" && isObject(response.result) && typeof response.result.path === "string" ? response.result.path : null;
      if (parent !== null) {
        if (suggested === "") setPicked(parent);
        else setEdited(inParent(parent));
      } else if (response.state === "succeeded") setError(unknownFormText("Browse"));
      else if (response.state !== "canceled") setError(browseRefusal(response.code ?? response.state));
    } finally {
      setBrowsing(false);
      folderField.current?.focus();
    }
  }

  return (
    <DockedPanel title={W.addTitle} icon={FolderAddIcon} closeLabel={W.closeAdd} primary={{ label: W.addButton, reason, quiet: running, onRun: () => void submit() }} opener={opener} onClose={onClose}>
      <fieldset className="grid grid-cols-[minmax(140px,max-content)_minmax(0,420px)] items-start gap-x-4 gap-y-2" aria-describedby={ids.mode}>
        <legend className="mb-2 font-semibold">{W.branch}</legend>
        <label className="flex h-(--h-button) items-center gap-2">
          <input type="radio" name="worktree-branch" checked={mode === "new"} onChange={() => setMode("new")} />
          {W.newBranch}
        </label>
        <div className="flex min-w-0 flex-col gap-1">
          <input
            aria-label={W.branchName}
            aria-describedby={track === null && start === null ? undefined : ids.start}
            spellCheck={false}
            autoComplete="off"
            disabled={mode !== "new"}
            className="h-(--h-button) rounded-sm border border-control-border bg-surface px-2"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
          {track !== null ? (
            <span id={ids.start} className="text-muted-text">
              {W.trackStart(shortRef(track))}
            </span>
          ) : start === null ? null : (
            <span id={ids.start} className="text-muted-text">
              {W.start(start)}
            </span>
          )}
        </div>
        <label className="flex h-(--h-button) items-center gap-2">
          <input type="radio" name="worktree-branch" checked={mode === "existing"} onChange={() => setMode("existing")} />
          {W.existing}
        </label>
        <div className="flex min-w-0 flex-col gap-1">
          <select
            aria-label={W.branch}
            disabled={mode !== "existing"}
            className="h-(--h-button) rounded-sm border border-control-border bg-surface px-2"
            value={chosen?.ref ?? ""}
            onChange={(event) => {
              setExisting(event.target.value);
              setError(null);
            }}
          >
            {chosen === null ? <option value="" disabled /> : null}
            {free.map((e) => (
              <option key={e.ref} value={e.ref}>
                {e.name}
              </option>
            ))}
          </select>
          <span id={ids.mode} className="text-muted-text">
            {W.heldNote}
          </span>
        </div>
      </fieldset>
      <div className="grid grid-cols-[minmax(140px,max-content)_minmax(0,420px)] items-start gap-x-4">
        <label htmlFor={ids.folder} className="flex h-(--h-button) items-center">
          {W.folder}
        </label>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex gap-2">
            <input
              ref={folderField}
              id={ids.folder}
              aria-describedby={ids.hint}
              spellCheck={false}
              autoComplete="off"
              className="h-(--h-button) min-w-0 flex-1 rounded-sm border border-control-border bg-surface px-2"
              value={folder}
              onChange={(event) => {
                setEdited(event.target.value);
                setError(null);
              }}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button type="button" variant="outline" className="h-(--h-button)" disabled={browsing} focusableWhenDisabled onClick={() => void browse()}>
                    {W.browse}
                  </Button>
                }
              />
              <TooltipContent>{W.browseTip}</TooltipContent>
            </Tooltip>
          </div>
          <span id={ids.hint} className="text-muted-text">
            {W.folderHint}
          </span>
        </div>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={switchTo} onChange={(event) => setSwitchTo(event.target.checked)} />
        {W.switchTo}
      </label>
      {error === null ? null : <p role="alert">{error}</p>}
    </DockedPanel>
  );
}
