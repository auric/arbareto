// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { getSingularPatch, setLanguageOverride, type DiffLineAnnotation, type Hunk, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { useMemo, useRef, type ReactNode } from "react";
import { diffLanguage } from "../highlight/language";
import { DIFF_THEME } from "../highlight/set";
import { PATCH_CSS } from "./patch-css";
import PatchPool from "./PatchPool";
import { useDiffThemeType } from "./theme-type";

export type PatchViewProps = {
  /** The decoded canonical patch. */
  patch: string;
  /** The mapped Pierre hunk of the selected service hunk. */
  selected: Hunk | null;
  /** The mapped Pierre hunk that an own hunk action anchors the viewport to. Anchoring selects nothing and shows no notice. */
  anchor?: Hunk | null;
  /** Feature 004 plan.md D15 "Line selection": the controlled line selection. It replaces the hunk mark while it holds lines. */
  lines?: SelectedLineRange | null;
  /** A pointer selection over the line numbers ends. */
  onLines?(range: SelectedLineRange | null): void;
  /** Spec FR-037: the Stage hunk or Unstage hunk button of the hunk with this index. */
  hunkAction?(index: number): ReactNode;
};

/** The first and last unified row of a hunk. A change block lists its deletions before its additions. */
function hunkRange(h: Hunk): SelectedLineRange {
  const head = h.hunkContent[0];
  const tail = h.hunkContent.at(-1);
  const first = head?.type === "change" && head.deletions === 0 ? { start: h.additionStart, side: "additions" as const } : { start: h.deletionStart, side: "deletions" as const };
  const last = tail?.type === "change" && tail.additions === 0 ? { end: h.deletionStart + h.deletionCount - 1, endSide: "deletions" as const } : { end: h.additionStart + h.additionCount - 1, endSide: "additions" as const };
  return { ...first, ...last };
}

type Mark = "selected" | "anchor" | { hunk: number; selected: boolean };

export default function PatchView({ patch, selected, anchor = null, lines = null, onLines, hunkAction }: PatchViewProps) {
  // PatchDiff does the same getSingularPatch call. FileDiff takes the parsed file, so the language override can apply.
  const fileDiff = useMemo(() => {
    const file = getSingularPatch(patch);
    const lang = diffLanguage(file);
    return lang === undefined ? file : setLanguageOverride(file, lang);
  }, [patch]);
  const themeType = useDiffThemeType();
  const range = selected ? hunkRange(selected) : null;
  // Each hunk start carries its hunk button. The selected hunk adds its label there.
  const annotations: DiffLineAnnotation<Mark>[] =
    hunkAction === undefined
      ? range
        ? [{ side: range.side!, lineNumber: range.start, metadata: "selected" }]
        : []
      : fileDiff.hunks.map((h, i) => {
          const start = hunkRange(h);
          return { side: start.side!, lineNumber: start.start, metadata: { hunk: i, selected: selected !== null && h.deletionStart === selected.deletionStart && h.additionStart === selected.additionStart } };
        });
  const anchorRange = anchor ? hunkRange(anchor) : null;
  if (anchorRange) annotations.push({ side: anchorRange.side!, lineNumber: anchorRange.start, metadata: "anchor" });
  // Each anchor scrolls once, when Pierre first renders its row.
  const anchored = useRef<string | null>(null);
  const anchorKey = anchorRange ? `${anchorRange.side}:${anchorRange.start}:${patch}` : null;
  const scrollOnce = (element: HTMLElement | null) => {
    if (element === null || anchorKey === null || anchored.current === anchorKey) return;
    anchored.current = anchorKey;
    element.scrollIntoView({ block: "nearest" });
  };
  // Pierre reads its pool from the nearest provider. The workbench keeps one more provider mounted, so the pool outlives this view.
  return (
    <PatchPool>
      <Virtualizer className="min-h-0 flex-1 overflow-auto select-text">
        <FileDiff
          fileDiff={fileDiff}
          selectedLines={lines ?? range}
          lineAnnotations={annotations}
          renderAnnotation={(annotation) => {
            const mark = annotation.metadata;
            if (mark === "anchor") return <span ref={scrollOnce} aria-hidden="true" className="block h-0" />;
            if (mark === "selected") return <span className="block border-l-3 border-accent-role px-2 font-semibold">Selected hunk</span>;
            return (
              <span className={`flex items-center justify-end gap-2 px-2 ${mark.selected ? "border-l-3 border-accent-role" : ""}`}>
                {mark.selected ? <span className="mr-auto font-semibold">Selected hunk</span> : null}
                {hunkAction?.(mark.hunk)}
              </span>
            );
          }}
          options={{
            diffStyle: "unified",
            disableFileHeader: true,
            preferredHighlighter: "shiki-js",
            theme: DIFF_THEME,
            themeType,
            unsafeCSS: PATCH_CSS,
            // Spec FR-043: drag over the line numbers. The view owns the selection, so a new patch clears it.
            enableLineSelection: onLines !== undefined,
            controlledSelection: true,
            onLineSelectionEnd: (next) => onLines?.(next),
          }}
        />
      </Virtualizer>
    </PatchPool>
  );
}
