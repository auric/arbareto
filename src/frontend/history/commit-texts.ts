// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { shortId } from "../status/OperationStatus";

// Feature 010 plan.md D11 "Menu", "Check out", "Create tag", "Reset", "Cherry-pick and Revert", and "Expiry". Counts of 1 take the singular form.

const n = (count: number) => count.toLocaleString("en-US");

export const MENU_NAME = (oid: string) => `Actions for commit ${shortId(oid)}`;
export const ITEM_CHECKOUT = "Check out this commit (detached HEAD)…";
export const ITEM_BRANCH = "Create branch here…";
export const ITEM_TAG = "Create tag here…";
export const ITEM_PICK = "Cherry-pick commit…";
export const ITEM_REVERT = "Revert commit…";
export const ITEM_RESET = (branch: string | null) => (branch === null ? "Reset current branch to here…" : `Reset current branch (${branch}) to here…`);
export const ITEM_COPY = "Copy commit ID";
export const AT_COMMIT = "HEAD is at this commit.";
export const COMMIT_ANNOUNCE = (oid: string) => `Commit ${shortId(oid)}.`;

export const CHECKOUT_TITLE = (oid: string) => `Check out commit ${shortId(oid)}?`;
export const CHECKOUT_BUTTON = "Check out";
export const CHECKOUT_DISCARD_BUTTON = "Discard and check out";

export const TAG = {
  title: (oid: string) => `Create tag at ${shortId(oid)}`,
  name: "Tag name",
  light: "Lightweight tag",
  lightHint: "A name for this commit. Git stores no message.",
  annotated: "Annotated tag",
  kind: "Tag kind",
  annotatedHint: "Git stores a tag object with your name, the date, and a message.",
  message: "Message",
  messageNeeded: "Type a message for an annotated tag.",
  signs: "Git signs this tag. Your Git configuration asks for it.",
  button: "Create tag",
  done: (name: string, oid: string) => `Created tag ${name} at ${shortId(oid)}. Arbareto does not push tags.`,
};
export const TAG_REASON: Record<string, (name: string) => string> = {
  "invalid-name": () => "Git does not accept this tag name.",
  "reserved-name": () => "Git reads HEAD and @ as names of the current commit. Use another tag name.",
  "name-exists": (name) => `The tag ${name} exists. Use another name.`,
  "tag-signing": () => "Your Git configuration signs every tag, and a signed tag needs a message. Select Annotated tag.",
  "message-size": () => "The message is too long. Use at most 8 KiB.",
  "invalid-config": () => "A tag setting in your Git configuration is not valid, so Git stops.",
};

export const RESET = {
  title: (branch: string, oid: string) => `Reset ${branch} to ${shortId(oid)}?`,
  legend: "Reset mode",
  soft: "Soft",
  softHint: "Git keeps the index and the working files. The differences show as staged changes.",
  mixed: "Mixed",
  mixedHint: "Git keeps the working files and resets the index. All changes show as unstaged changes.",
  hard: "Hard",
  hardHint: "Git resets the index and the working files. Git deletes all changes to tracked files.",
  leave: (count: number, branch: string) => (count === 1 ? `1 commit leaves ${branch}.` : `${n(count)} commits leave ${branch}.`),
  gain: (count: number, branch: string) => (count === 1 ? `${branch} gets 1 commit.` : `${branch} gets ${n(count)} commits.`),
  reflog: (count: number) =>
    count === 1 ? "1 of these commits is on no other branch or tag. Only Git's reflog keeps it for a limited time." : `${n(count)} of these commits are on no other branch or tag. Only Git's reflog keeps them for a limited time.`,
  force: (tracking: string) => `The reset removes commits that ${tracking} holds, so the next push needs Force push with lease.`,
  tracked: (count: number) => (count === 1 ? "You have 1 change to tracked files." : `You have ${n(count)} changes to tracked files.`),
  button: "Reset",
  hardButton: "Reset hard…",
  inTheWayLead: "These untracked paths are in the way of Hard reset:",
  inTheWayTail: (more: number) => (more === 0 ? "Move or delete them first." : more === 1 ? "1 more path does not show. Move or delete them first." : `${n(more)} more paths do not show. Move or delete them first.`),
  hardTitle: (branch: string, oid: string) => `Reset ${branch} hard to ${shortId(oid)}?`,
  hardBody: (count: number, oid: string) =>
    count === 0 ? `Git sets the index and the working files to ${shortId(oid)}.` : count === 1 ? "Git deletes 1 change to tracked files, also staged new files. Untracked files stay." : `Git deletes ${n(count)} changes to tracked files, also staged new files. Untracked files stay.`,
  hardIgnored: (count: number, oid: string) => (count === 1 ? `Git replaces 1 ignored file with the file of ${shortId(oid)}.` : `Git replaces ${n(count)} ignored files with the files of ${shortId(oid)}.`),
  hardCancel: "Cancel",
  hardConfirm: "Reset hard",
  done: (branch: string, oid: string) => `Reset ${branch} to ${shortId(oid)}.`,
};

/** The texts of Cherry-pick and Revert. `pick` is true for Cherry-pick. */
export const PICK = {
  title: (pick: boolean, oid: string, branch: string) => (pick ? `Cherry-pick ${shortId(oid)} to ${branch}?` : `Revert ${shortId(oid)} on ${branch}?`),
  body: (pick: boolean, branch: string) =>
    pick
      ? `Git applies the changes of this commit to ${branch} as a new commit. Git copies its message and its author. To change the message, use Amend last commit.`
      : `Git creates a new commit on ${branch} that undoes the changes of this commit. Git writes the commit message. To change it, use Amend last commit.`,
  legend: (pick: boolean) => (pick ? "This is a merge commit. Select the parent that Git compares it with." : "This is a merge commit. Select the parent to keep."),
  parent: (index: number, oid: string, subject: string | null) => `Parent ${index}: ${shortId(oid)}${subject === null ? "" : ` ${subject}`}`,
  button: (pick: boolean) => (pick ? "Cherry-pick" : "Revert"),
  alreadyOnBranch: (branch: string) => `${branch} already has this commit.`,
  dirtyTree: (pick: boolean) => (pick ? "Commit or stash your changes first. Git cherry-picks only onto a clean working tree." : "Commit or stash your changes first. Git reverts only on a clean working tree."),
  notMerge: "This commit is no merge commit.",
  done: (pick: boolean, oid: string, branch: string) => (pick ? `Cherry-picked ${shortId(oid)} to ${branch}.` : `Reverted ${shortId(oid)} on ${branch}.`),
  stoppedConflicts: (pick: boolean, count: number) => {
    const kind = pick ? "cherry-pick" : "revert";
    return count === 1 ? `The ${kind} stopped with 1 conflicted file. Resolve it, then select Continue in the Notices band.` : `The ${kind} stopped with ${n(count)} conflicted files. Resolve them, then select Continue in the Notices band.`;
  },
  stopped: (pick: boolean) => `The ${pick ? "cherry-pick" : "revert"} stopped. Read the Git output, then select Continue or Abort in the Notices band.`,
};

/** D11 "Expiry". `action` is the close-prompt name of D11 "Trust sentences and close-prompt names". */
export const EXPIRED = (action: string) => `The review expired. Arbareto changed nothing. Select ${action} again.`;
/** D11 `CLOSE_*`: the close-prompt name of each action. */
export const CLOSE_NAMES: Record<"reset" | "create-tag" | "cherry-pick" | "revert-commit", string> = {
  reset: RESET.button,
  "create-tag": TAG.button,
  "cherry-pick": PICK.button(true),
  "revert-commit": "Revert commit",
};
