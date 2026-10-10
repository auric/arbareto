// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { ComparisonHunk } from "../../contracts/envelope";

// Contract §4: Pierre parses the canonical service patch for display only.
// research.md R9: strict `parsePatchFiles` accepts text without a patch, so this module checks the file and hunk counts itself.

export type HunkMapping = { ok: true; file: FileDiffMetadata; hunkIds: string[] } | { ok: false; code: "DISPLAY_MAPPING_FAILED" };

const FAILED = { ok: false, code: "DISPLAY_MAPPING_FAILED" } as const;

/** Maps each Pierre hunk to the service hunk with the same ordinal and the same header ranges. Any disagreement fails. */
export function mapHunks(patch: string, hunks: readonly ComparisonHunk[]): HunkMapping {
  let files: FileDiffMetadata[];
  try {
    files = parsePatchFiles(patch, undefined, true).flatMap((p) => p.files);
  } catch {
    return FAILED;
  }
  if (files.length !== 1) return FAILED;
  const file = files[0]!;
  if (file.hunks.length !== hunks.length) return FAILED;
  for (let i = 0; i < hunks.length; i++) {
    const shown = file.hunks[i]!;
    const service = hunks[i]!;
    if (service.ordinal !== i || shown.deletionStart !== service.oldStart || shown.deletionCount !== service.oldCount || shown.additionStart !== service.newStart || shown.additionCount !== service.newCount) return FAILED;
  }
  return { ok: true, file, hunkIds: hunks.map((h) => h.hunkId) };
}
