// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { ChangeEntry, Comparison, ReadComparisonResult } from "../../contracts/envelope";
import type { ErrorCode } from "../../contracts/errors";
import { ErrorState, LimitedOutput, Loading, NoSelection, UnsupportedState, useCopy } from "../app/RepositoryStates";
import type { BridgeResponse } from "../bridge";
import { IconButton } from "../components/icon-button";
import { shrinkInOrder, type Part } from "../lib/fit";
import { GIT_SEPARATORS, splitPath } from "../lib/path";
import { isEditable, scopedAction } from "../keyboard/shortcuts";
import { mapHunks, patchRows, stepRange, type HunkMapping, type LineRange, type Patch } from "./hunk-mapping";

// plan.md "Long text" (comparison heading), "Required visible states", and "Selection, scroll, and stored context".

// `PatchView` loads Pierre and its worker. Only a shown diff loads it.
const PatchView = lazy(() => import("./PatchView"));

const SCOPE: Record<ChangeEntry["category"], string> = { staged: "Staged", unstaged: "Unstaged", untracked: "Untracked", conflicted: "Conflicted" };
// plan.md "Use explicit comparison labels".
const SIDES: Record<Comparison["scope"], string> = {
  "head-to-index": "Current commit to index",
  "index-to-worktree": "Index to working file",
  "empty-to-untracked": "Empty version to working file",
};

type HeadingParts = { width: number; copyPath: number; folder: Part; file: Part; sides: Part; scope: Part };
type HeadingWidths = { folder: number; file: number; sides: number; scope: number };

/** plan.md "Long text": shrink the folder, then the file name, then the sides, then the scope. Copy path never shrinks. */
export function fitComparisonHeading({ width, copyPath, folder, file, sides, scope }: HeadingParts): HeadingWidths {
  const [f, n, s, c] = shrinkInOrder(width, copyPath, [folder, file, sides, scope]) as [number, number, number, number];
  return { folder: f, file: n, sides: s, scope: c };
}

const PARTS = ["folder", "file", "scope", "sides"] as const;

/** The sticky comparison heading. Its height is the pane heading height. `controls` are the T145 hunk controls after Copy path. */
export function ComparisonHeading({ path, scope, sides, controls }: { path: string; scope: string; sides: string | null; controls?: ReactNode }) {
  const [folder, file] = splitPath(path, GIT_SEPARATORS);
  const text = { folder, file, scope, sides: sides ?? "" };
  const heading = useRef<HTMLHeadingElement>(null);
  const [widths, setWidths] = useState<HeadingWidths | null>(null);
  const copy = useCopy();

  useLayoutEffect(() => {
    const h = heading.current;
    if (!h) return;
    const measure = () => {
      const span = (name: string) => h.querySelector<HTMLElement>(`[data-part="${name}"]`);
      const ellipsis = span("ellipsis")!.getBoundingClientRect().width;
      // T397: `scrollWidth` and `clientWidth` round to whole pixels, so a part that fits got an ellipsis. A range rectangle keeps the fractional text width.
      const range = document.createRange();
      const part = (name: string): Part => {
        const element = span(name);
        if (!element) return { full: 0, min: 0 };
        range.selectNodeContents(element);
        const full = range.getBoundingClientRect().width;
        return { full, min: Math.min(full, ellipsis) };
      };
      const gap = Number.parseFloat(getComputedStyle(h).columnGap) || 0;
      setWidths(fitComparisonHeading({ width: h.getBoundingClientRect().width - (sides ? 2 : 1) * gap, copyPath: 0, folder: part("folder"), file: part("file"), sides: part("sides"), scope: part("scope") }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(h);
    return () => observer.disconnect();
  }, [path, scope, sides]);

  return (
    // plan.md "Hunk toolbar layout": flex wrap keeps the controls beside 120 DIPs of path text, else moves them to a row below, then splits that row.
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-2 border-b border-divider bg-surface px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
      <h2
        ref={heading}
        aria-label={[path, scope, sides].filter(Boolean).join(", ")}
        className="relative flex min-w-0 flex-1 basis-[120px] items-baseline gap-2 overflow-hidden whitespace-nowrap"
        style={{ height: "var(--h-pane-heading)", lineHeight: "var(--h-pane-heading)" }}
      >
        <span className="flex min-w-0 font-semibold">
          {PARTS.slice(0, 2).map((name) => (
            <span key={name} data-part={name} className="truncate" style={{ maxWidth: widths?.[name] }}>
              {text[name]}
            </span>
          ))}
        </span>
        {PARTS.slice(2, sides ? 4 : 3).map((name) => (
          <span key={name} data-part={name} className="truncate text-muted-text" style={{ maxWidth: widths?.[name] }}>
            {text[name]}
          </span>
        ))}
        <span data-part="ellipsis" aria-hidden="true" className="invisible absolute">
          …
        </span>
      </h2>
      {/* plan.md "Long text": the tooltip reads "Copy path" and holds no path. */}
      <IconButton icon={Copy01Icon} label="Copy path" onClick={() => copy(path)} />
      {controls}
    </div>
  );
}

export type ComparisonViewProps = {
  /** The selected entry, or null. */
  entry: ChangeEntry | null;
  /** The `readComparison` response of the selected entry. Null while the read is pending. */
  response: BridgeResponse | null;
  /** The selected service hunk ID, or null. */
  selectedHunk: string | null;
  onRefresh(): void;
  /** The No selection help line. */
  helpLine?: string;
  /** The T145 hunk controls of a `Comparison` result. `displayFailed` is true when the display mapping disagrees (contract §4). */
  controls?(comparison: Comparison, displayFailed: boolean, lines: LineState): ReactNode;
  /** Spec FR-037: the button of the hunk with this index. */
  hunkAction?(comparison: Comparison, displayFailed: boolean, index: number): ReactNode;
  /** The last own successful hunk action of this file: the acted hunk ordinal and the patch that it replaced. */
  anchor?: { ordinal: number; patch: string } | null;
  /** Content below the heading, such as a failed file action output (T202). */
  notice?: ReactNode;
};

const decoder = new TextDecoder("utf-8", { fatal: true });
function decode(base64: string): string | null {
  try {
    return decoder.decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Feature 004 plan.md D15 "Line selection": the line selection of the shown diff, its rows, and the S and U action that the hunk controls register. */
export type LineState = {
  range: LineRange | null;
  patch: Patch | null;
  clear(): void;
  action: RefObject<((direction: "stage" | "unstage") => void) | null>;
};

// plan.md "Selection, scroll, and stored context".
export const RESET_NOTICE = "The file changed outside Arbareto. The view shows the new version.";

type Mapped = { patch: string; mapping: HunkMapping } | null;
type View = { key: string | null; anchored: number | null };
type DiffProps = {
  mapped: Mapped;
  view: View;
  selectedHunk: string | null;
  onRefresh(): void;
  reset: boolean;
  lines: LineRange | null;
  onLines(range: LineRange | null): void;
  hunkAction?(index: number): ReactNode;
  /** S, U, Shift+Up, and Shift+Down of the diff body. */
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
};

/** A supported, complete comparison: the mapped diff, or `DISPLAY_MAPPING_FAILED` with every hunk action disabled. */
function Diff({ mapped, view, selectedHunk, onRefresh, reset, lines, onLines, hunkAction, onKeyDown }: DiffProps) {
  if (mapped === null || !mapped.mapping.ok) return <ErrorState code="DISPLAY_MAPPING_FAILED" result={undefined} onRefresh={onRefresh} />;
  const { patch, mapping } = mapped;
  const index = selectedHunk === null ? -1 : mapping.hunkIds.indexOf(selectedHunk);
  return (
    <>
      {reset ? (
        <p role="status" className="px-2">
          {RESET_NOTICE}
        </p>
      ) : null}
      {/* The diff body is one Tab stop. S, U, Shift+Up, and Shift+Down act while focus is in the diff (spec FR-043, FR-087). */}
      <div tabIndex={0} role="group" aria-label="Diff" data-slot="diff-body" className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
        <Suspense fallback={<Loading hasContent={false} refreshing={false} />}>
          {/* An external change remounts the view and resets its scroll. An own hunk action keeps the view and anchors it. */}
          <PatchView
            key={view.key ?? undefined}
            patch={patch}
            selected={index < 0 ? null : mapping.file.hunks[index]!}
            anchor={view.anchored === null ? null : (mapping.file.hunks[view.anchored] ?? null)}
            lines={lines}
            onLines={onLines}
            hunkAction={hunkAction}
          />
        </Suspense>
      </div>
    </>
  );
}

// Contract §3: `succeeded` and `limited` carry a `ReadComparisonResult`. Other states carry no value.
export const resultOf = (response: BridgeResponse | null): ReadComparisonResult | null =>
  response?.state === "succeeded" || response?.state === "limited" ? (response.result as ReadComparisonResult) : null;
// Contract §3: only `Comparison` has `patch`. Only a supported, complete one shows as a diff.
export const showsDiff = (result: ReadComparisonResult | null): boolean =>
  result !== null && "patch" in result && result.support === "supported" && result.completeness.state === "complete";

function Body({ result, ...diff }: { result: ReadComparisonResult } & DiffProps) {
  if ("patch" in result) {
    if (showsDiff(result)) return <Diff {...diff} />;
    return (
      <>
        <LimitedOutput completeness={result.completeness} />
        <UnsupportedState support={result.support} fileAction={result.fileAction} remedy={result.remedy} />
      </>
    );
  }
  // Contract §3: only `ComparisonObjectMissing` has `objectRemedy`.
  if ("objectRemedy" in result)
    return (
      <>
        <LimitedOutput completeness={result.completeness} />
        <p className="px-2">{result.objectRemedy.text}</p>
        <UnsupportedState support={result.support} fileAction={result.fileAction} remedy={result.remedy} />
      </>
    );
  return <LimitedOutput completeness={result.completeness} />;
}

/** The comparison pane of the selected entry. */
export function ComparisonView({ entry, response, selectedHunk, onRefresh, helpLine, controls, hunkAction, anchor = null, notice }: ComparisonViewProps) {
  const result = resultOf(response);
  // The category and the path bytes name the shown file. A new snapshot gives new entry IDs.
  // Another patch of the same file is an external change, except the one that replaces the patch of an own hunk action.
  const file = entry === null ? null : `${entry.category}:${entry.pathBytes}`;
  const patch = showsDiff(result) ? (result as Comparison).patch : null;
  const [shown, setShown] = useState({ file, patch, reset: false, key: patch });
  if (shown.file !== file) setShown({ file, patch, reset: false, key: patch });
  else if (patch !== null && patch !== shown.patch) {
    const own = shown.patch !== null && shown.patch === anchor?.patch;
    setShown({ file, patch, reset: shown.patch !== null && !own, key: own ? shown.key : patch });
  }
  const hunks = patch === null ? null : (result as Comparison).hunks;
  // plan.md "Task flow and command placement": the surviving hunk with the same ordinal, or the last hunk when fewer remain.
  const anchored = anchor !== null && hunks !== null && patch !== anchor.patch && hunks.length > 0 ? Math.min(anchor.ordinal, hunks.length - 1) : null;
  const mapped = useMemo<Mapped>(() => {
    const text = patch === null ? null : decode(patch);
    return text === null ? null : { patch: text, mapping: mapHunks(text, hunks!) };
  }, [patch, hunks]);
  const rows = useMemo(() => (mapped === null || !mapped.mapping.ok ? null : patchRows(mapped.patch)), [mapped]);
  // Data-model §14: the line selection belongs to the shown diff. Another patch clears it.
  const [lines, setLines] = useState<{ patch: string | null; range: LineRange | null }>({ patch, range: null });
  const range = lines.patch === patch ? lines.range : null;
  const onLines = (next: LineRange | null) => setLines({ patch, range: next });
  const action = useRef<((direction: "stage" | "unstage") => void) | null>(null);
  const lineState: LineState = { range, patch: rows, clear: () => onLines(null), action };
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (rows === null || isEditable(event.target as HTMLElement)) return;
    const key = scopedAction(event.nativeEvent, "diff");
    if (key === "stageLines" || key === "unstageLines") {
      if (range === null) return;
      event.preventDefault();
      return action.current?.(key === "stageLines" ? "stage" : "unstage");
    }
    if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const from = selectedHunk === null || mapped === null || !mapped.mapping.ok ? 0 : Math.max(0, mapped.mapping.hunkIds.indexOf(selectedHunk));
    onLines(stepRange(rows, range, event.key === "ArrowDown" ? "next" : "previous", from));
  }
  if (entry === null) return <NoSelection helpLine={helpLine} />;
  const scope = result !== null && "scope" in result ? SIDES[result.scope] : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ComparisonHeading
        path={entry.path}
        scope={SCOPE[entry.category]}
        sides={scope}
        controls={result !== null && "comparisonId" in result ? controls?.(result, patch !== null && (mapped === null || !mapped.mapping.ok), lineState) : undefined}
      />
      {notice}
      {response === null ? (
        <Loading hasContent={false} refreshing={false} />
      ) : result === null ? (
        <ErrorState code={(response.code ?? response.state) as ErrorCode} result={response.result} onRefresh={onRefresh} />
      ) : (
        <Body
          result={result}
          mapped={mapped}
          view={{ key: shown.key, anchored }}
          selectedHunk={selectedHunk}
          onRefresh={onRefresh}
          reset={shown.reset}
          lines={range}
          onLines={onLines}
          onKeyDown={onKeyDown}
          hunkAction={hunkAction === undefined || !("comparisonId" in result) ? undefined : (index) => hunkAction(result as Comparison, false, index)}
        />
      )}
    </div>
  );
}
