// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChangeEntry, Comparison, ReadComparisonResult } from "../../contracts/envelope";
import type { ErrorCode } from "../../contracts/errors";
import { ErrorState, LimitedOutput, Loading, NoSelection, UnsupportedState, useCopy } from "../app/RepositoryStates";
import type { BridgeResponse } from "../bridge";
import { IconButton } from "../components/icon-button";
import { shrinkInOrder, type Part } from "../lib/fit";
import { GIT_SEPARATORS, splitPath } from "../lib/path";
import { mapHunks } from "./hunk-mapping";

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
      const part = (name: string): Part => {
        const full = span(name)?.scrollWidth ?? 0;
        return { full, min: Math.min(full, ellipsis) };
      };
      const gap = Number.parseFloat(getComputedStyle(h).columnGap) || 0;
      setWidths(fitComparisonHeading({ width: h.clientWidth - (sides ? 2 : 1) * gap, copyPath: 0, folder: part("folder"), file: part("file"), sides: part("sides"), scope: part("scope") }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(h);
    return () => observer.disconnect();
  }, [path, scope, sides]);

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-divider bg-surface px-2" style={{ height: "var(--h-pane-heading)" }}>
      <h2 ref={heading} aria-label={[path, scope, sides].filter(Boolean).join(", ")} className="relative flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden whitespace-nowrap">
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
};

const decoder = new TextDecoder("utf-8", { fatal: true });
function decode(base64: string): string | null {
  try {
    return decoder.decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

// plan.md "Selection, scroll, and stored context".
export const RESET_NOTICE = "The file changed outside Arbareto. The view shows the new version.";

type DiffProps = { comparison: Comparison; selectedHunk: string | null; onRefresh(): void; reset: boolean };

/** A supported, complete comparison: the mapped diff, or `DISPLAY_MAPPING_FAILED` with every hunk action disabled. */
function Diff({ comparison, selectedHunk, onRefresh, reset }: DiffProps) {
  const patch = useMemo(() => decode(comparison.patch), [comparison.patch]);
  const mapping = useMemo(() => (patch === null ? null : mapHunks(patch, comparison.hunks)), [patch, comparison.hunks]);
  if (patch === null || mapping === null || !mapping.ok) return <ErrorState code="DISPLAY_MAPPING_FAILED" result={undefined} onRefresh={onRefresh} />;
  const index = selectedHunk === null ? -1 : mapping.hunkIds.indexOf(selectedHunk);
  return (
    <>
      {reset ? (
        <p role="status" className="px-2">
          {RESET_NOTICE}
        </p>
      ) : null}
      <Suspense fallback={<Loading hasContent={false} refreshing={false} />}>
        {/* The canonical patch is the key. A changed comparison remounts the view and resets its scroll. */}
        <PatchView key={comparison.patch} patch={patch} selected={index < 0 ? null : mapping.file.hunks[index]!} />
      </Suspense>
    </>
  );
}

// Contract §3: `succeeded` and `limited` carry a `ReadComparisonResult`. Other states carry no value.
export const resultOf = (response: BridgeResponse | null): ReadComparisonResult | null =>
  response?.state === "succeeded" || response?.state === "limited" ? (response.result as ReadComparisonResult) : null;
// Contract §3: only `Comparison` has `patch`. Only a supported, complete one shows as a diff.
export const showsDiff = (result: ReadComparisonResult | null): boolean =>
  result !== null && "patch" in result && result.support === "supported" && result.completeness.state === "complete";

function Body({ result, selectedHunk, onRefresh, reset }: { result: ReadComparisonResult; selectedHunk: string | null; onRefresh(): void; reset: boolean }) {
  if ("patch" in result) {
    if (showsDiff(result)) return <Diff comparison={result} selectedHunk={selectedHunk} onRefresh={onRefresh} reset={reset} />;
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
export function ComparisonView({ entry, response, selectedHunk, onRefresh, helpLine }: ComparisonViewProps) {
  const result = resultOf(response);
  // The category and the path bytes name the shown file. A new snapshot gives new entry IDs.
  // T145 must exclude the patch after the application's own hunk action. Until then, each other patch of the same file is an external change.
  const file = entry === null ? null : `${entry.category}:${entry.pathBytes}`;
  const patch = showsDiff(result) ? (result as Comparison).patch : null;
  const [shown, setShown] = useState({ file, patch, reset: false });
  if (shown.file !== file) setShown({ file, patch, reset: false });
  else if (patch !== null && patch !== shown.patch) setShown({ file, patch, reset: shown.patch !== null });
  if (entry === null) return <NoSelection helpLine={helpLine} />;
  const scope = result !== null && "scope" in result ? SIDES[result.scope] : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ComparisonHeading path={entry.path} scope={SCOPE[entry.category]} sides={scope} />
      {response === null ? (
        <Loading hasContent={false} refreshing={false} />
      ) : result === null ? (
        <ErrorState code={(response.code ?? response.state) as ErrorCode} result={response.result} onRefresh={onRefresh} />
      ) : (
        <Body result={result} selectedHunk={selectedHunk} onRefresh={onRefresh} reset={shown.reset} />
      )}
    </div>
  );
}
