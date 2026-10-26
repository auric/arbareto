// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { BridgeResponse } from "../bridge";
import { refusalText as branchRefusal, T as B } from "../branches/texts";
import { TEXTS } from "../integrate/texts";
import { isObject } from "../lib/utils";
import { trustGate } from "../trust/ask";

// Feature 004 plan.md D15 "Worktree texts", D10, spec FR-049 to FR-057, contract Δ3 and Δ9.

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export const W = {
  tooltip: "Open, add, or remove a worktree.",
  buttonLabel: (name: string, n: number) => `${name}, ${count(n, "worktree", "worktrees")}`,
  filter: "Filter worktrees",
  list: "Worktrees",
  empty: "No worktrees",
  noMatch: "No worktree matches the filter.",
  listFailed: (code: string) => `Arbareto cannot read the worktrees: ${code}.`,
  // Plan D15 "Malformed result": the item name of a succeeded read without entries.
  listName: "Worktree list",
  WORKTREE_RECORDS: "This repository has more than 1,000 worktrees. This version does not list them.",
  WORKTREE_LISTING_BYTES: "The worktree list is larger than this version can show.",
  add: "Add worktree…",
  prune: "Prune missing worktrees",
  nothingToPrune: "No worktree is missing",
  main: "Main worktree",
  current: "Current",
  locked: (reason: string | null) => (reason === null || reason === "" ? "Locked" : `Locked: ${reason}`),
  prunable: "Folder missing",
  bare: "Bare repository",
  detached: B.detached,
  headUnknown: "HEAD unknown",
  open: "Open",
  remove: "Remove worktree…",
  menu: (name: string) => `Actions for ${name}`,
  // Unavailable reasons (spec FR-054, plan D10).
  mainReason: "You cannot remove the main worktree.",
  currentReason: "You cannot remove the open worktree. Open another worktree first.",
  lockedReason: "The worktree is locked. Git removes a locked worktree only after git worktree unlock.",
  prunableReason: "The worktree folder is missing. Use Prune to remove its record.",
  isOpen: "This worktree is open.",
  // Contract Δ9 `UNKNOWN_TARGET`, also of `openWorktree`.
  unknownTarget: "Arbareto cannot match this worktree with a fresh worktree list.",
  bareReason: "This record is a bare repository. It has no worktree folder.",
  invalidUtf8: "The worktree path is not valid UTF-8, so Arbareto cannot use it.",
  // Remove confirmation (spec FR-054 to FR-056).
  removeTitle: (path: string) => `Remove worktree ${path}?`,
  folderNote: "The folder is deleted. The commits stay in the repository.",
  reading: "Arbareto reads the status of this worktree.",
  counts: (tracked: number, untracked: number) => `${count(tracked, "uncommitted change", "uncommitted changes")} and ${count(untracked, "untracked file", "untracked files")}.`,
  lostNote: "They are in no commit and no stash. Removing deletes them for good.",
  submodules: "This worktree has submodules. Git removes it only with its force option.",
  // Spec FR-055 fixes the first label. Without changes, the second label states what the force option removes.
  force: "Delete my uncommitted changes too",
  forceSubmodules: "Delete the worktree with its submodules too",
  forceHint: "Remove stays unavailable until you check this.",
  deleteBranch: "Also delete the branch",
  removeButton: "Remove worktree",
  removeForce: "Remove worktree and changes",
  // Without changes, a remove that needs force only for submodules names them.
  removeSubmodules: "Remove worktree and submodules",
  // Plan O-20: the target worktree gate refuses. Only an approval in that worktree opens it.
  targetTrust: (path: string) => `To trust the worktree ${path}, open it and trust it there.`,
  // Add worktree panel (spec FR-052, plan D15 "Docked panel").
  addTitle: "Add worktree",
  closeAdd: "Close add worktree panel",
  addButton: "Add worktree",
  newBranch: "New branch",
  branchName: "New branch name",
  start: (oid: string) => `Starts at commit ${oid.slice(0, 12)}.`,
  trackStart: (remoteBranch: string) => `Starts at ${remoteBranch}. The new branch tracks it.`,
  existing: "Existing branch",
  branch: "Branch",
  heldNote: "Branches checked out in another worktree are not listed. Git allows each branch in one worktree only.",
  noFreeBranch: "Every local branch is checked out in a worktree.",
  branchGone: (name: string) => `Branch ${name} no longer exists. Select another branch.`,
  folder: "Folder",
  folderHint: "Suggested from the branch name. The folder must not exist, or it must be empty.",
  // Browse (spec FR-052, plan D15, contract Δ3 `chooseWorktreeFolder`).
  browse: "Browse…",
  browseTip: "Select the parent folder in the folder picker.",
  switchTo: "Switch to it after creating",
  enterName: "Enter a branch name.",
  // Plan D15 "Refusals" `reserved-name` and `invalid-name`.
  reservedName: "Git reads @ as HEAD. Use another branch name.",
  invalidName: "Git does not accept this branch name.",
  enterFolder: "Enter a folder.",
  // Outcomes in the status bar.
  added: (path: string) => `Added the worktree ${path}.`,
  removed: (path: string) => `Removed the worktree ${path}.`,
  removedBranch: (path: string, branch: string) => `Removed the worktree ${path} and deleted ${branch}.`,
  pruned: (n: number) => `Removed the records of ${count(n, "missing worktree", "missing worktrees")}.`,
} as const;

// Plan D15: the status bar name, running text, and area heading of each run. The names are the contract Δ14 close prompt names.
export const RUN_TEXTS: Record<"worktree-add" | "worktree-remove" | "worktree-prune", [string, string, string]> = {
  "worktree-add": ["Add worktree", "Adding worktree", "Add worktree details"],
  "worktree-remove": ["Remove worktree", "Removing worktree", "Remove worktree details"],
  "worktree-prune": ["Prune worktrees", "Pruning worktrees", "Prune worktrees details"],
};

/** The D15 text of a `chooseWorktreeFolder` response without a folder. Cancel has no text. */
export function browseRefusal(code: string): string {
  // Contract Δ3: the only cause of UNSUPPORTED_REPOSITORY here is a folder of the other route (001 reason `mixed-location`).
  if (code === "UNSUPPORTED_REPOSITORY") return "The worktree and its Git directories must all lie inside one WSL distro, or all on Windows.";
  if (code === "PICKER_FAILED") return "The folder picker failed. Select Browse… again.";
  return `Arbareto cannot use the folder picker: ${code}.`;
}

const DESTINATION: Record<string, string> = {
  "not-empty": "The folder is not empty. Select a new or empty folder.",
  file: "The folder path names a file. Select a new or empty folder.",
  other: "The folder path names an item that is not a folder. Select a new or empty folder.",
};

/**
 * The D15 text of a refused worktree review. `worktree` is the record path of a remove. `branch` is the short branch name of the request.
 * A trust refusal names its gate (plan O-20). A remove refusal without a known gate names both gates.
 */
export function worktreeRefusal(response: BridgeResponse, action: "worktree-add" | "worktree-remove" | "worktree-prune", worktree: string, branch: string): string {
  const r = isObject(response.result) ? response.result : {};
  const code = response.code ?? response.state;
  const reason = typeof r.reason === "string" ? r.reason : null;
  if (code === "TRUST_REQUIRED" || code === "TRUST_CHANGED") {
    const gate = trustGate(response);
    if (gate === "target") return W.targetTrust(worktree);
    return gate === null && action === "worktree-remove" ? `${TEXTS.trust} ${W.targetTrust(worktree)}` : TEXTS.trust;
  }
  if (code === "REPOSITORY_UNAVAILABLE" && typeof r.path === "string") return `Arbareto cannot read the folder ${r.path}.`;
  if (code === "DESTINATION_NOT_EMPTY" && reason !== null && reason in DESTINATION) return DESTINATION[reason]!;
  if (code === "UNKNOWN_TARGET") return W.unknownTarget;
  if (code === "WORKBENCH_UNAVAILABLE") {
    if (reason === "main-worktree") return W.mainReason;
    if (reason === "current-worktree") return W.currentReason;
    if (reason === "locked") return W.lockedReason;
    if (reason === "prunable") return W.prunableReason;
    if (reason === "nothing-to-prune") return W.nothingToPrune;
    if (reason === "limit") return "The worktree path makes the Git command line too long.";
    if (reason === "current-branch" && action === "worktree-add") return B.addCurrent;
    if (reason === "no-tracking-refspec" && action === "worktree-add") return "No refspec of a remote maps this branch, so Git cannot set up tracking.";
    if (reason === "several-tracking-remotes" && action === "worktree-add" && Array.isArray(r.remotes)) return `The refspecs of ${r.remotes.join(", ")} map this branch, so Git cannot set up tracking.`;
  }
  return branchRefusal(response, branch);
}
