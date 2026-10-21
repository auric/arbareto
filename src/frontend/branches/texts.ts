// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { unknownFormText } from "../app/RepositoryStates";
import type { BridgeResponse } from "../bridge";
import { TEXTS } from "../integrate/texts";
import { isObject } from "../lib/utils";
import { shortRef } from "../refs/ReferencesSidebar";
import { shortId } from "../status/OperationStatus";

// Feature 004 plan.md D15 "Branch texts", D16 fixed phrases, data-model §4, spec FR-007 to FR-020.

const changes = (n: number) => (n === 1 ? "1 change" : `${n.toLocaleString("en-US")} changes`);

export const T = {
  tooltip: "Switch to another branch.",
  detached: (oid: string) => `Detached at ${shortId(oid)}`,
  merging: "Merging",
  rebasing: "Rebasing",
  filter: "Find a branch",
  list: "Branches",
  empty: "No branches",
  noMatch: "No branch matches the filter.",
  listFailed: (code: string) => `Arbareto cannot read the branches: ${code}.`,
  // The list adds the key column " (Ctrl+B)" (plan D15 "Branch list", D16 "Geometry").
  newBranch: "New branch…",
  noUpstream: "No upstream",
  current: "current",
  localNoun: "local branch",
  remoteNoun: "remote-tracking branch",
  open: (worktree: string) => `Open ${worktree}`,
  switchTitle: (branch: string) => `Switch to ${branch}?`,
  tracked: (n: number) => `You have ${changes(n)} to tracked files. Select what happens to them.`,
  keep: "Keep changes",
  keepNote: (branch: string) => `Bring them to ${branch}. If one conflicts, Git stops and changes nothing.`,
  stash: "Stash and reapply",
  stashNote: "Stash them, switch, then reapply them. On a conflict, the stash stays.",
  discard: "Discard changes",
  discardNote: "Delete changes to tracked files. Untracked files stay. You cannot undo this.",
  defaultTag: "Default",
  settingsNote: "Change the default in Settings.",
  switch: "Switch",
  discardSwitch: "Discard and switch",
  unreachable: (oid: string) => `Commit ${shortId(oid)} is on no branch. After the switch, only the reflog keeps it.`,
  createLocal: "Create local branch",
  branchName: "Branch name",
  tracks: (branch: string) => `Tracks ${branch}.`,
  detach: "Check out the commit only",
  detachNote: "No branch. New commits belong to no branch (detached HEAD).",
  createSwitch: "Create and switch",
  switchExisting: (branch: string) => `Switch to ${branch}`,
  localGroup: "Local branches",
  remoteGroup: "Remote branches",
  menu: (branch: string) => `Actions for ${branch}`,
  merge: (current: string | null) => (current === null ? "Merge into current branch…" : `Merge into current branch (${current})…`),
  rebase: (current: string | null, branch: string) => (current === null ? `Rebase current branch onto ${branch}…` : `Rebase current branch (${current}) onto ${branch}…`),
  createHere: "Create branch here…",
  rename: "Rename…",
  delete: "Delete…",
  push: "Push",
  copy: "Copy branch name",
  sameBranch: (branch: string) => `${branch} is the current branch.`,
  mergeCurrent: TEXTS.sameMerge,
  rebaseCurrent: TEXTS.sameRebase,
  detachedReason: TEXTS.detached,
  noCommit: TEXTS.unborn,
  unborn: "The current branch has no commit yet. Git can stash only after the first commit.",
  noPanel: "Arbareto cannot start this action here yet.",
  pushOther: "Push sends the current branch only.",
  deleteCurrent: "You cannot delete the current branch. Switch to another branch first.",
  otherWorktree: (worktree: string) => `The worktree ${worktree} holds this branch. Open that worktree, or remove it first.`,
  createTitle: (oid: string) => `Create branch at ${shortId(oid)}`,
  switchNew: "Switch to the new branch",
  create: "Create",
  renameTitle: (branch: string) => `Rename ${branch}`,
  newName: "New name",
  renameButton: "Rename",
  deleteTitle: (branch: string) => `Delete ${branch}?`,
  deleteButton: "Delete",
  // Data-model §4 and plan D4.
  onlyHere: (branch: string, n: number) => `${branch} has ${n.toLocaleString("en-US")} ${n === 1 ? "commit" : "commits"} that no other branch has. Deleting the branch loses them.`,
  noneLost: (branch: string) => `Deleting ${branch} loses no commit.`,
  reflogKeeps: (oid: string) => `Git's HEAD reflog keeps commit ${shortId(oid)} for a limited time.`,
  noReflog: (oid: string) => `No reflog keeps commit ${shortId(oid)} after the delete.`,
} as const;

const REASONS: Record<string, (r: Record<string, unknown>, branch: string) => string> = {
  "no-tracking-refspec": () => "No refspec of a remote maps this branch, so Git cannot set up tracking. Check out the commit only.",
  "several-tracking-remotes": (r) => `The refspecs of ${(r.remotes as string[]).join(", ")} map this branch, so Git cannot set up tracking. Check out the commit only.`,
  "same-branch": (_, branch) => T.sameBranch(branch),
  unborn: () => T.unborn,
  "reserved-name": () => "Git reads @ as HEAD. Use another branch name.",
  "invalid-name": () => "Git does not accept this branch name.",
  "name-exists": (r) => `The branch ${shortRef(String(r.ref))} exists. Use another name.`,
  "config-in-include": (_, branch) => `An included configuration file sets branch.${branch}. Git cannot remove that setting here, so delete the branch in a terminal.`,
  "current-branch": () => T.deleteCurrent,
  "other-worktree": (r) => T.otherWorktree(String(r.worktree)),
  "head-unresolved": (r) => `Git cannot read the HEAD of the worktree ${String(r.worktree)}, so Arbareto cannot tell which branch it holds. Fix or remove that worktree first.`,
  detached: () => T.detachedReason,
  unreadable: () => "Arbareto cannot read a path that the switch writes, so Discard is unavailable.",
  path: () => "A path that the switch writes starts with a colon, so Discard is unavailable.",
};

/** The D15 text of a refused `reviewWorkbench` or `runWorkbench` response. `branch` is the short name of the branch in the request. */
export function refusalText(response: BridgeResponse, branch: string): string {
  const r = isObject(response.result) ? response.result : {};
  const code = response.code ?? response.state;
  if (code === "UNTRACKED_IN_WAY" && Array.isArray(r.paths)) {
    const more = typeof r.more === "number" && r.more > 0 ? `, and ${r.more.toLocaleString("en-US")} more` : "";
    return `Discard would overwrite these untracked files: ${r.paths.join(", ")}${more}.`;
  }
  if (code === "CONFLICTED" && typeof r.unmerged === "number") return TEXTS.conflicted(r.unmerged);
  const reason = typeof r.reason === "string" ? r.reason : null;
  if (code === "WORKBENCH_UNAVAILABLE" && reason !== null && reason in REASONS) return REASONS[reason]!(r, branch);
  if (response.state === "succeeded") return unknownFormText("The action");
  return `The action did not start: ${code}${reason === null ? "" : ` ${reason}`}.`;
}

export const OUTCOME = {
  switched: (branch: string) => `Switched to ${branch}.`,
  created: (branch: string) => `Created ${branch}.`,
  renamed: (branch: string) => `Renamed the branch to ${branch}.`,
  deleted: (branch: string) => `Deleted ${branch}.`,
  failed: (action: string, code: string) => `${action} did not complete: ${code}.`,
};

/** Data-model §3 `stash.state` texts. */
export const STASH: Record<string, (oid: string) => string> = {
  "kept-conflicts": (oid) => `The stash ${shortId(oid)} stays, because its changes conflict. Resolve the files in the Conflicted list.`,
  "kept-failed-apply": (oid) => `Git did not reapply the stash ${shortId(oid)}. The stash stays.`,
  "kept-failed-checkout": (oid) => `Git did not switch. The stash ${shortId(oid)} stays.`,
  "kept-not-found": (oid) => `Arbareto did not find the stash ${shortId(oid)} in the stash list, so it stays.`,
  "kept-stash-changed": () => "The stash list changed during the switch, so Arbareto did not switch.",
};
