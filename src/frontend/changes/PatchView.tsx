// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { getSingularPatch, setLanguageOverride, type DiffLineAnnotation, type Hunk, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { useMemo } from "react";
import { diffLanguage } from "../highlight/language";
import { DIFF_THEME } from "../highlight/set";

// Static CSS only. Repository content never enters `unsafeCSS`.
// plan.md "Selected hunk": a 3 DIP Accent left bar and no fill. The focus outline stays as Pierre draws it.
const CSS = "[data-selected-line]{background:none;box-shadow:inset 3px 0 0 var(--accent-role)}";

export type PatchViewProps = {
  /** The decoded canonical patch. */
  patch: string;
  /** The mapped Pierre hunk of the selected service hunk. */
  selected: Hunk | null;
};

/** The first and last unified row of a hunk. A change block lists its deletions before its additions. */
function hunkRange(h: Hunk): SelectedLineRange {
  const head = h.hunkContent[0];
  const tail = h.hunkContent.at(-1);
  const first = head?.type === "change" && head.deletions === 0 ? { start: h.additionStart, side: "additions" as const } : { start: h.deletionStart, side: "deletions" as const };
  const last = tail?.type === "change" && tail.additions === 0 ? { end: h.deletionStart + h.deletionCount - 1, endSide: "deletions" as const } : { end: h.additionStart + h.additionCount - 1, endSide: "additions" as const };
  return { ...first, ...last };
}

export default function PatchView({ patch, selected }: PatchViewProps) {
  // PatchDiff does the same getSingularPatch call. FileDiff takes the parsed file, so the language override can apply.
  const fileDiff = useMemo(() => {
    const file = getSingularPatch(patch);
    const lang = diffLanguage(file);
    return lang === undefined ? file : setLanguageOverride(file, lang);
  }, [patch]);
  const range = selected ? hunkRange(selected) : null;
  const annotations: DiffLineAnnotation[] = range ? [{ side: range.side!, lineNumber: range.start }] : [];
  return (
    <Virtualizer className="min-h-0 flex-1 overflow-auto">
      <FileDiff
        fileDiff={fileDiff}
        selectedLines={range}
        lineAnnotations={annotations}
        renderAnnotation={() => <span className="block border-l-3 border-accent-role px-2 font-semibold">Selected hunk</span>}
        options={{ diffStyle: "unified", disableFileHeader: true, preferredHighlighter: "shiki-js", theme: DIFF_THEME, unsafeCSS: CSS }}
      />
    </Virtualizer>
  );
}
