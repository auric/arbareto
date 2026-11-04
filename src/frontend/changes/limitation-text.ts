// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry, Comparison } from "../../contracts/envelope";

export type LimitationReason = Exclude<NonNullable<Comparison["support"]>, "supported">;

// plan.md "Limitation text". The UI never shows the raw reason value.
export const LIMITATION_TEXT: Record<LimitationReason, string> = {
  binary: "Git reports binary content in this file.",
  encoding: "This file is not valid UTF-8 text, or Git converts its encoding.",
  size: "This file is larger than the Arbareto size limit.",
  rename: "This change is a rename.",
  mode: "This change alters the file mode.",
  type: "This change alters the file type, or the path is not a regular file.",
  symlink: "This entry is a symbolic link.",
  submodule: "This entry is a submodule or a nested repository.",
  LFS: "Git LFS manages this file.",
  filter: "A Git filter applies to this file.",
  state: "This file has conflicts.",
  "line-endings": "This file has mixed line endings, or only the index holds its line-ending attributes.",
  "index-flag": "This entry is intent-to-add, assume-unchanged, or skip-worktree.",
  path: "Arbareto cannot match this path to exactly one file.",
};

// Feature 005 plan.md D20 "Refusal texts". A row with a gitlink never shows `LIMITATION_TEXT.submodule`.
export const GITLINK_TEXT = "Arbareto stages and unstages only a moved submodule commit. Use Git in a terminal for this change.";
export const UNBORN_TEXT = "The submodule branch has no commit yet. Commit inside the submodule first.";
// Feature 005 plan.md D20 rule 4: `S` as the first `<sub>` character, or mode 160000 on a side.
export const isGitlink = (entry: Pick<ChangeEntry, "submodule" | "modes"> | undefined) => entry !== undefined && (entry.submodule?.startsWith("S") === true || entry.modes?.includes("160000") === true);
