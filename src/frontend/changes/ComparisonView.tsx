// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEntry, Comparison, ReadComparisonResult } from "../../contracts/envelope";
import type { ErrorCode } from "../../contracts/errors";
import { ErrorState, LimitedOutput, Loading, NoSelection, UnsupportedState } from "../app/RepositoryStates";
import type { BridgeResponse } from "../bridge";
import { Button } from "../components/ui/button";
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

type Part = { full: number; min: number };
type HeadingParts = { width: number; copyPath: number; folder: Part; file: Part; sides: Part; scope: Part };
type HeadingWidths = { folder: number; file: number; sides: number; scope: number };

/** plan.md "Long text": shrink the folder, then the file name, then the sides, then the scope. Copy path never shrinks. */
export function fitComparisonHeading({ width, copyPath, folder, file, sides, scope }: HeadingParts): HeadingWidths {
  let over = copyPath + folder.full + file.full + sides.full + scope.full - width;
  const fit = (p: Part) => {
    const cut = Math.max(0, Math.min(over, p.full - p.min));
    over -= cut;
    return p.full - cut;
  };
  return { folder: fit(folder), file: fit(file), sides: fit(sides), scope: fit(scope) };
}

const PARTS = ["folder", "file", "scope", "sides"] as const;

/** The sticky comparison heading. Its height is the pane heading height. */
export function ComparisonHeading({ path, scope, sides }: { path: string; scope: string; sides: string | null }) {
  const slash = path.lastIndexOf("/");
  const text = { folder: path.slice(0, slash + 1), file: path.slice(slash + 1), scope, sides: sides ?? "" };
  const heading = useRef<HTMLHeadingElement>(null);
  const [widths, setWidths] = useState<HeadingWidths | null>(null);

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
      <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(path).catch(() => {})}>
        Copy path
      </Button>
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

/** A supported, complete comparison: the mapped diff, or `DISPLAY_MAPPING_FAILED` with every hunk action disabled. */
function Diff({ comparison, selectedHunk, onRefresh }: { comparison: Comparison; selectedHunk: string | null; onRefresh(): void }) {
  const patch = useMemo(() => decode(comparison.patch), [comparison.patch]);
  const mapping = useMemo(() => (patch === null ? null : mapHunks(patch, comparison.hunks)), [patch, comparison.hunks]);
  if (patch === null || mapping === null || !mapping.ok) return <ErrorState code="DISPLAY_MAPPING_FAILED" result={undefined} onRefresh={onRefresh} />;
  const index = selectedHunk === null ? -1 : mapping.hunkIds.indexOf(selectedHunk);
  return (
    <Suspense fallback={<Loading hasContent={false} refreshing={false} />}>
      {/* The canonical patch is the key. A changed comparison remounts the view and resets its scroll. */}
      <PatchView key={comparison.patch} patch={patch} selected={index < 0 ? null : mapping.file.hunks[index]!} />
    </Suspense>
  );
}

function Body({ result, selectedHunk, onRefresh }: { result: ReadComparisonResult; selectedHunk: string | null; onRefresh(): void }) {
  // Contract §3: only `Comparison` has `patch`, and only `ComparisonObjectMissing` has `objectRemedy`.
  if ("patch" in result) {
    if (result.support === "supported" && result.completeness.state === "complete") return <Diff comparison={result} selectedHunk={selectedHunk} onRefresh={onRefresh} />;
    return (
      <>
        <LimitedOutput completeness={result.completeness} />
        <UnsupportedState support={result.support} fileAction={result.fileAction} remedy={result.remedy} />
      </>
    );
  }
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
  if (entry === null) return <NoSelection helpLine={helpLine} />;
  // Contract §3: `succeeded` and `limited` carry a `ReadComparisonResult`. Other states carry no value.
  const result = response?.state === "succeeded" || response?.state === "limited" ? (response.result as ReadComparisonResult) : null;
  const scope = result !== null && "scope" in result ? SIDES[result.scope] : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ComparisonHeading path={entry.path} scope={SCOPE[entry.category]} sides={scope} />
      {response === null ? (
        <Loading hasContent={false} refreshing={false} />
      ) : result === null ? (
        <ErrorState code={(response.code ?? response.state) as ErrorCode} result={response.result} onRefresh={onRefresh} />
      ) : (
        <Body result={result} selectedHunk={selectedHunk} onRefresh={onRefresh} />
      )}
    </div>
  );
}
