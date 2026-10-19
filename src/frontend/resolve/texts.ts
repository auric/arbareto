// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 plan.md D15 "Resolve view texts", spec FR-089 to FR-096, and data-model §11.

/** Data-model §11: the porcelain v2 `u` record codes and their texts. */
export const KIND_TEXTS: Readonly<Record<string, string>> = { UU: "Both modified", AA: "Both added", AU: "Added by us", UA: "Added by them", DU: "Deleted by us", UD: "Deleted by them", DD: "Both deleted" };

export type Side = "ours" | "theirs";
const verb = (side: Side) => (side === "ours" ? "Choose ours" : "Choose theirs");

export const TEXTS = {
  region: (path: string) => `Resolve ${path}`,
  kind: "Conflict",
  ours: "Ours",
  theirs: "Theirs",
  pending: "Arbareto reads the Git facts.",
  unknownName: "Not known",
  choose: (side: Side, name: string | null) => (name === null ? verb(side) : `${verb(side)} (${name})`),
  verb,
  openTool: "Open in merge tool",
  toolNote: (tool: string) => `${tool}, from merge.tool`,
  markResolved: "Mark resolved",
  settings: "Open Editor and tools",
  cancel: "Cancel",
  // Spec FR-091.
  confirmTitle: (side: Side, name: string | null) => `${TEXTS.choose(side, name)}?`,
  confirm: (path: string, name: string) => `Replace ${path} with the ${name} version. Your edits to this file are lost.`,
  // Spec FR-095.
  toolRuns: (tool: string) => `Open in ${tool}`,
  // Contract Δ9 reasons of `choose-side`.
  sideReasons: {
    "side-missing": "The index has no version of this side.",
    "side-not-regular": "This side is not a regular file in the index.",
  } as Readonly<Record<string, string>>,
  // Contract Δ9 reasons of `mergetool`. Spec FR-093 gives the `no-merge-tool` text.
  toolReasons: {
    "no-merge-tool": "Set a merge tool in Git settings",
    "merge-tool-name": "The merge.tool value is a path. Git accepts only a tool name here.",
    unreadable: "Arbareto cannot read the exact merge.tool value.",
    "stages-missing": "The merge tool needs both sides. The index has only one side.",
    "side-not-regular": "A side is not a regular file in the index.",
  } as Readonly<Record<string, string>>,
  // Contract Δ9 reasons of both actions.
  reasons: {
    limit: "The path is too long for the Git command line.",
    path: "The path is not valid UTF-8, so Arbareto cannot give it to Git.",
  } as Readonly<Record<string, string>>,
  // Spec FR-092: a change before the start asks for a refresh.
  stale: "The file or its index stages changed. Select Refresh (F5) and try again.",
  trust: "This action runs programs of this repository. Trust the repository first with the trust chip in the status bar.",
  unavailable: (label: string) => `${label} is unavailable: `,
  // Plan.md "Required visible states", No file-action decision.
  comparisonPending: "Its comparison is still loading.",
  // Status bar names of a run (contract Δ6 close prompt names).
  runTexts: (side: Side): [string, string, string] => (side === "ours" ? ["Choose ours", "Choosing ours", "Choose ours details"] : ["Choose theirs", "Choosing theirs", "Choose theirs details"]),
  toolRunTexts: (tool: string): [string, string, string] => ["Merge tool", `Open in ${tool}`, "Merge tool details"],
  // Spec FR-091 and FR-096 results.
  chosen: (path: string, name: string) => `Git wrote the ${name} version to ${path}. The file stays conflicted until you select Mark resolved.`,
  staged: (path: string) => `Git staged ${path}.`,
  stays: (path: string) => `${path} stays conflicted. Select Mark resolved when the file is ready.`,
  failed: (name: string) => `${name} did not complete: `,
};
