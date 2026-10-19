// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 spec FR-062, plan.md D11 "Presets", O-10, research.md R14 and R21 F24.

/** The file names of the `mergetools` folder of Git 2.56.0.windows.2 (research.md R21 F24). A preset writes `merge.tool=<name>` or `diff.tool=<name>` only. */
export const TOOL_PRESETS = [
  "araxis",
  "bc",
  "codecompare",
  "deltawalker",
  "diffmerge",
  "diffuse",
  "ecmerge",
  "emerge",
  "examdiff",
  "guiffy",
  "gvimdiff",
  "kdiff3",
  "kompare",
  "meld",
  "nvimdiff",
  "opendiff",
  "p4merge",
  "smerge",
  "tkdiff",
  "tortoisemerge",
  "vimdiff",
  "vscode",
  "winmerge",
  "xxdiff",
] as const;

/** The keys that offer the tool presets. `core.editor` offers Custom only until O-10 closes. */
export const PRESET_KEYS: ReadonlySet<string> = new Set(["diff.tool", "merge.tool"]);
