// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import type { DiffLineAnnotation, Hunk, SelectedLineRange } from "@pierre/diffs";
import { PatchDiff, Virtualizer, WorkerPoolContextProvider } from "@pierre/diffs/react";

// research.md R9: two local workers and the Shiki JavaScript engine, so no WebAssembly compiles.
const POOL = { workerFactory: () => new Worker(WorkerUrl, { type: "module" }), poolSize: 2 };
const HIGHLIGHTER = { preferredHighlighter: "shiki-js" } as const;
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
  const range = selected ? hunkRange(selected) : null;
  const annotations: DiffLineAnnotation[] = range ? [{ side: range.side!, lineNumber: range.start }] : [];
  return (
    <WorkerPoolContextProvider poolOptions={POOL} highlighterOptions={HIGHLIGHTER}>
      <Virtualizer className="min-h-0 flex-1 overflow-auto">
        <PatchDiff
          patch={patch}
          selectedLines={range}
          lineAnnotations={annotations}
          renderAnnotation={() => <span className="block border-l-3 border-accent-role px-2 font-semibold">Selected hunk</span>}
          options={{ diffStyle: "unified", disableFileHeader: true, preferredHighlighter: "shiki-js", unsafeCSS: CSS }}
        />
      </Virtualizer>
    </WorkerPoolContextProvider>
  );
}
