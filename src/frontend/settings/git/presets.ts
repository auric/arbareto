// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 spec FR-062, plan.md D11 "Presets", D15 "Presets", O-10, research.md R14 and R21 F24.

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

export type Preset = { readonly label: string; readonly value: string };

/** Plan.md D11 and D15. Git runs `core.editor` through its shell, so a path with blanks needs double quotes, and each command needs the wait flag of its editor. */
export const EDITOR_PRESETS: readonly Preset[] = [
  { label: "VS Code", value: "code --wait" },
  { label: "Notepad++", value: '"C:/Program Files/Notepad++/notepad++.exe" -multiInst -notabbar -nosession -noPlugin' },
  { label: "Sublime Text", value: '"C:/Program Files/Sublime Text/subl.exe" -w' },
  { label: "Notepad", value: "notepad" },
];

const TOOLS: readonly Preset[] = TOOL_PRESETS.map((name) => ({ label: name, value: name }));

/** The keys that offer presets, with their presets. */
export const PRESETS: ReadonlyMap<string, readonly Preset[]> = new Map([
  ["diff.tool", TOOLS],
  ["merge.tool", TOOLS],
  ["core.editor", EDITOR_PRESETS],
]);
