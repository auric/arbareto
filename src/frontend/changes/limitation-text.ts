// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { Comparison } from "../../contracts/envelope";

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
