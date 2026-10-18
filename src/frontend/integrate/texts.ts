// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 plan.md D15 "Merge and Rebase panel texts" and "Merge and Rebase panel reasons", D5, D6, data-model §5.

/** Data-model §5 `ConfigSource`: the configuration entry that gives a value, or Git's default. */
export type ConfigSource = "default" | { scope: string; origin: string };

const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;
const where = (source: { scope: string; origin: string }) => `${source.scope} (${source.origin})`;

export const TEXTS = {
  mergeTitle: (source: string, current: string) => `Merge ${source} into ${current}`,
  rebaseTitle: (current: string, onto: string) => `Rebase ${current} onto ${onto}`,
  closeMerge: "Close merge panel",
  closeRebase: "Close rebase panel",
  pending: "Arbareto reads the Git facts.",
  mergeRuns: "The merge runs.",
  rebaseRuns: "The rebase runs.",
  // D5 facts.
  behind: (source: string, current: string, n: number) => `${source} has ${commits(n)} that ${current} lacks.`,
  fastForward: "Fast-forward is possible.",
  noFastForward: (current: string, source: string, n: number) => `Fast-forward is not possible: ${current} has ${commits(n)} that ${source} lacks.`,
  mergeFf: (value: string, source: ConfigSource) => (source === "default" ? `merge.ff is not set, so Git uses its default (${value}).` : `merge.ff is ${value} in ${where(source)}.`),
  // D5 options.
  result: "Result",
  mergeCommit: "Merge commit",
  squash: "Squash",
  squashNote: "Stage all changes as one. No merge commit. You commit later.",
  noFf: "No fast-forward",
  noFfNote: "Always create a merge commit, also when Git could fast-forward.",
  noCommit: "Don't commit",
  noCommitNote: "Stop before the commit, so you can check the result.",
  noFfSquash: "Git refuses No fast-forward with Squash.",
  noCommitSquash: "Squash never commits.",
  noFfLocked: "Git fast-forwards without a merge commit, so Don't commit needs No fast-forward.",
  message: "Merge commit message",
  messageBytes: (n: number) => `${n.toLocaleString("en-US")} of 8,192 UTF-8 bytes`,
  messageEmpty: "Enter a merge commit message.",
  // D6 facts.
  moved: (current: string, onto: string, n: number) => `Moves the ${commits(n)} of ${current} that ${onto} lacks on top of ${onto}.`,
  held: (rewritten: number, held: number) => `The rebase rewrites ${commits(rewritten)}. A remote-tracking branch holds ${held} of them.`,
  forceNote: (tracking: string) => `The rebase rewrites commits that ${tracking} holds, so the next push needs Force push with lease.`,
  movedBranches: "These branches may move with the rebase:",
  moreBranches: (n: number) => `${n} more ${n === 1 ? "branch" : "branches"} may move.`,
  // D6 options.
  autostash: "Autostash",
  autostashNote: "Stash the changes first. Reapply them after the rebase.",
  autostashSource: (source: ConfigSource) => (source === "default" ? "rebase.autoStash is not set, so Autostash starts off." : `From rebase.autoStash in ${where(source)}.`),
  autosquash: "Autosquash",
  autosquashNote: "Fold fixup! and squash! commits into their targets.",
  interactive: "Interactive",
  interactiveReason: "Not in this version",
  // Contract Δ9 reasons and reused codes.
  ffOnly: (source: ConfigSource) => `merge.ff is only${source === "default" ? "" : ` in ${where(source)}`}, and Git cannot fast-forward here. Select No fast-forward to create a merge commit.`,
  messageSize: "The merge message is above 8 KiB (8,192 UTF-8 bytes), the limit of the Git command line.",
  squashNoFf: (source: ConfigSource) => `merge.ff is false${source === "default" ? "" : ` in ${where(source)}`}, so Git refuses Squash.`,
  mergeOptions: (current: string) => `branch.${current}.mergeoptions sets merge options that Arbareto cannot check. Remove the setting to merge here, or merge in a terminal.`,
  invalidConfig: "A Git setting has a value that Git cannot read, so Git stops the rebase. Correct the setting first.",
  unknownOperation: "Arbareto cannot tell which operation is in progress. Finish it in a terminal.",
  applyBackend: "rebase.backend is apply, so Git ignores rebase.updateRefs. Select Autosquash to use the merge backend, or rebase in a terminal.",
  dirtyTree: "Commit or stash your changes, or select Autostash.",
  trust: "This action runs programs of this repository. Trust the repository first with the trust chip in the status bar.",
  unavailable: (action: "Merge" | "Rebase") => `${action} is unavailable: `,
  failed: (action: "Merge" | "Rebase") => `${action} did not complete: `,
};
