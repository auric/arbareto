// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ChangeEntry, HistoryPage, HistoryRow } from "../../contracts/envelope";
import { LimitedOutput, SCOPE_TEXT } from "../app/RepositoryStates";
import { WarningIcon } from "../app/NoticeBand";
import { Button } from "../components/ui/button";
import { metrics, type Density, type Profile } from "../layout/profiles";
import { shrinkInOrder, type Part } from "../lib/fit";
import { AncestryCell, LANE_SPACING } from "./AncestryCell";
import { BOUNDARY_TEXT, layoutHistory, UNRESOLVED_TEXT, type Cell, type Layout } from "./lanes";

// plan.md "History graph design", "Long text", "Keyboard and focus" (Roles, File/history list), "Compact token system" (selection marker, badges), and "Required visible states".

export { SCOPE_TEXT };
export const LIMIT_TEXT: Record<NonNullable<Layout["limit"]>["reached"], string> = {
  lanes: "Graph layout limited: more than 24 lanes",
  segments: "Graph layout limited: more than 4,096 segments",
};
const NO_SELECTION = "Select a commit to see its details";
const NO_FILES = "Changed files are not shown in this version.";
const NO_COMMITS = "No commits yet";
// plan.md "Chosen layout, sizes, and DPI": the constrained History list region minimum.
const CONSTRAINED_LIST_MIN = 220;

const shortId = (oid: string) => oid.slice(0, 12);
// Git ref names: a local branch is `refs/heads/<name>` (git-check-ref-format(1)).
export const branchName = (target: string) => (target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : target);
// `date` is the author time in seconds (contract §3).
const isoText = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
/** The author time in the local time zone and the system locale, to the minute. */
export const LOCAL_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const encodingText = (encoding: string) => `Declared encoding: ${encoding}`;
const ENCODING_NOTE = "Arbareto shows the subject and the author as UTF-8 without conversion. Bytes that are not valid UTF-8 show as replacement characters.";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Counted = { category: ChangeEntry["category"] };

/** plan.md "History graph design": the change counts of the latest complete read. */
function countText(entries: readonly Counted[]): { conflicted: string | null; rest: string } {
  let conflicted = 0;
  let working = 0;
  let staged = 0;
  for (const { category } of entries) {
    if (category === "conflicted") conflicted++;
    else if (category === "staged") staged++;
    else working++;
  }
  return { conflicted: conflicted > 0 ? `${conflicted} conflicted, ` : null, rest: `${plural(working, "working change", "working changes")}, ${staged} staged` };
}

type ScopeParts = { width: number; fixed: number; checkout: Part; commits: Part; limit?: Part };
type ScopeWidths = { checkout: number; commits: number; limit: number };

/** plan.md "Long text": shrink the checkout name, then "Up to 100 commits", then the limit text. The fixed parts never shrink. */
export function fitScopeLine({ width, fixed, checkout, commits, limit = { full: 0, min: 0 } }: ScopeParts): ScopeWidths {
  const [c, n, l] = shrinkInOrder(width, fixed, [checkout, commits, limit]) as [number, number, number];
  return { checkout: c, commits: n, limit: l };
}

export type ScopeLineProps = {
  /** The captured checkout name. */
  checkout: string;
  /** The entries of the latest complete read, or null before one. */
  entries: readonly Counted[] | null;
  /** A `LIMIT_TEXT` value. */
  limit?: string;
  /** The ID of the limit text, for the list's accessible description. */
  limitId?: string;
  id?: string;
};

/** The History scope line. It stays on one line, and its accessible name holds the full text. */
export function ScopeLine({ checkout, entries, limit, limitId, id }: ScopeLineProps) {
  const counts = entries === null ? null : countText(entries);
  const full = [checkout, SCOPE_TEXT, counts === null ? "Loading…" : `${counts.conflicted ?? ""}${counts.rest}`, limit].filter(Boolean).join(", ");
  const line = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<ScopeWidths | null>(null);

  useLayoutEffect(() => {
    const element = line.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const part = (name: string) => element.querySelector<HTMLElement>(`[data-part="${name}"]`);
      const ellipsis = part("ellipsis")!.getBoundingClientRect().width;
      const shown = (name: string) => part(name)?.getBoundingClientRect().width ?? 0;
      const text = (name: string): Part => {
        const content = part(`${name}-text`)?.scrollWidth ?? 0;
        return { full: content, min: Math.min(content, ellipsis) };
      };
      const head = part("checkout-head")!;
      const tail = part("checkout-tail")!.getBoundingClientRect().width;
      const checkoutPart = { full: head.scrollWidth + tail, min: Math.min(head.scrollWidth, part("checkout-first")!.getBoundingClientRect().width + ellipsis) + tail };
      const fixed = element.scrollWidth - shown("checkout") - shown("commits") - shown("limit");
      setWidths(fitScopeLine({ width: element.clientWidth, fixed, checkout: checkoutPart, commits: text("commits"), limit: text("limit") }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [full]);

  // One character stays on each side of the checkout ellipsis: the head keeps its first character, and the tail keeps the last one.
  const head = checkout.slice(0, -1);
  const tail = checkout.slice(-1);
  return (
    <div id={id} ref={line} role="group" aria-label={full} className="relative flex items-center gap-2 overflow-hidden whitespace-nowrap px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
      <span data-part="checkout" aria-hidden="true" className="flex min-w-0 shrink-0" style={{ maxWidth: widths?.checkout }}>
        <span data-part="checkout-head" className="truncate">
          {head}
        </span>
        <span data-part="checkout-tail">{tail}</span>
      </span>
      <span data-part="commits" aria-hidden="true" className="shrink-0 truncate text-muted-text" style={{ maxWidth: widths?.commits }}>
        <span data-part="commits-text">{SCOPE_TEXT}</span>
      </span>
      {counts === null ? (
        <span aria-hidden="true" className="shrink-0 text-muted-text">
          Loading…
        </span>
      ) : (
        <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
          {counts.conflicted === null ? null : (
            <>
              <WarningIcon />
              <span>{counts.conflicted}</span>
            </>
          )}
          <span>{counts.rest}</span>
        </span>
      )}
      {limit === undefined ? null : (
        <span className="flex min-w-0 shrink-0 items-center gap-1">
          <WarningIcon />
          <span data-part="limit" id={limitId} aria-hidden="true" className="truncate" style={{ maxWidth: widths?.limit }}>
            <span data-part="limit-text">{limit}</span>
          </span>
        </span>
      )}
      <span data-part="checkout-first" aria-hidden="true" className="invisible absolute">
        {checkout.slice(0, 1)}
      </span>
      <span data-part="ellipsis" aria-hidden="true" className="invisible absolute">
        …
      </span>
    </div>
  );
}

type Head = HistoryPage["head"];

function checkoutText(head: Head): string {
  return head.state === "detached" ? "Detached HEAD" : branchName(head.target);
}

/** The full row text: HEAD labels, subject, short ID, author, date, parent count, ordered parents, boundary labels, and the declared encoding. */
export function rowName(row: HistoryRow, cell: Cell, head: Head, dateFormat: Intl.DateTimeFormat = LOCAL_DATE): string {
  const parts: string[] = [];
  if (head.state !== "unborn" && row.oid === head.oid) parts.push(head.state === "branch" ? `HEAD, branch ${branchName(head.target)}` : "HEAD, detached");
  parts.push(row.subject, shortId(row.oid), row.author.name, dateFormat.format(row.date * 1000));
  if (row.parents.length > 0) parts.push(plural(row.parents.length, "parent", "parents"));
  for (const parent of row.parents) {
    parts.push(shortId(parent));
    if (cell.marks.some((m) => m.parent === parent)) parts.push(BOUNDARY_TEXT.outside);
  }
  for (const mark of cell.marks) if (mark.parent === null) parts.push(mark.text);
  if (cell.unresolved) parts.push(UNRESOLVED_TEXT);
  if (row.encoding !== null) parts.push(encodingText(row.encoding));
  return parts.join(", ");
}

export type HistoryViewProps = {
  /** The shown `readHistory` page, or null before the first one. */
  page: HistoryPage | null;
  /** The entries of the latest complete `readWorkspace`, or null before one. */
  entries: readonly Counted[] | null;
  /** Controlled by the workspace state. Null on open. */
  selectedOid: string | null;
  /** Selects a commit of the loaded page. It never checks out or moves a reference. */
  onSelect(oid: string): void;
  density: Density;
  profile: Profile;
  /** The Windows text size factor. */
  textScale?: number;
  /** The author time format. Tests pin its time zone and locale. */
  dateFormat?: Intl.DateTimeFormat;
};

/** The History list and the "Selected commit" inspector, stacked. */
export function HistoryView({ page, entries, selectedOid, onSelect, density, profile, textScale = 1, dateFormat = LOCAL_DATE }: HistoryViewProps) {
  const ids = { scope: useId(), limit: useId(), inspector: useId() };
  const rows = page?.rows ?? [];
  const layout = useMemo(() => (page === null ? null : layoutHistory(page)), [page]);
  const index = useMemo(() => new Map(rows.map((row, i) => [row.oid, i])), [rows]);
  const listbox = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const [activeOid, setActiveOid] = useState<string | null>(null);
  const at = (oid: string | null) => (oid === null ? -1 : (index.get(oid) ?? -1));
  // The Tab stop: the last focused row, else the selected row, else the first row.
  const activeIndex = at(activeOid) >= 0 ? at(activeOid) : at(selectedOid) >= 0 ? at(selectedOid) : rows.length > 0 ? 0 : -1;
  const selected = at(selectedOid) >= 0 ? rows[at(selectedOid)]! : null;
  const rowHeight = metrics(density, textScale).row;
  const spacing = LANE_SPACING[density];
  const columns = profile === "wide";
  const limit = layout?.limit ? LIMIT_TEXT[layout.limit.reached] : undefined;

  function focusRow(oid: string) {
    setActiveOid(oid);
    elements.current.get(oid)?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const option = (event.target as HTMLElement).closest('[role="option"]') as HTMLElement | null;
    const from = at(option?.dataset.oid ?? null);
    if (from < 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      return onSelect(rows[from]!.oid);
    }
    const step = option!.offsetHeight > 0 ? Math.max(1, Math.floor(listbox.current!.clientHeight / option!.offsetHeight)) : 1;
    const to =
      event.key === "ArrowDown" ? from + 1
      : event.key === "ArrowUp" ? from - 1
      : event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
      : event.key === "PageDown" ? from + step
      : event.key === "PageUp" ? from - step
      : null;
    if (to === null) return;
    event.preventDefault();
    focusRow(rows[Math.min(rows.length - 1, Math.max(0, to))]!.oid);
  }

  function onParent(oid: string) {
    onSelect(oid);
    setActiveOid(oid);
    elements.current.get(oid)?.scrollIntoView({ block: "nearest" });
  }

  const listMin = profile === "constrained" ? CONSTRAINED_LIST_MIN : metrics(density, textScale).historyListMin;
  const head = page?.head ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScopeLine id={ids.scope} checkout={head === null ? "" : checkoutText(head)} entries={entries} limit={limit} limitId={ids.limit} />
      {page === null ? null : <LimitedOutput completeness={page.completeness} />}
      {head?.state === "unborn" ? (
        <p className="p-2 text-muted-text">{NO_COMMITS}</p>
      ) : (
        <div
          ref={listbox}
          role="listbox"
          aria-labelledby={ids.scope}
          aria-describedby={limit === undefined ? undefined : ids.limit}
          className="overflow-y-auto px-1"
          style={profile === "constrained" ? { height: listMin } : { flex: "1 1 0", minHeight: listMin }}
          onKeyDown={onKeyDown}
        >
          {layout !== null && head !== null
            ? rows.map((row, i) => (
                <div
                  key={row.oid}
                  ref={(element) => void (element ? elements.current.set(row.oid, element) : elements.current.delete(row.oid))}
                  role="option"
                  data-oid={row.oid}
                  aria-selected={row.oid === selectedOid}
                  aria-label={rowName(row, layout.cells[i]!, head, dateFormat)}
                  tabIndex={i === activeIndex ? 0 : -1}
                  className="list-row flex items-center gap-2 pr-2"
                  style={{ height: rowHeight }}
                  onFocus={() => setActiveOid(row.oid)}
                  onClick={() => onSelect(row.oid)}
                >
                  <AncestryCell cell={layout.cells[i]!} lanes={layout.lanes} spacing={spacing} rowHeight={rowHeight} selected={row.oid === selectedOid} />
                  <span aria-hidden="true" className="flex min-w-0 flex-1 items-center whitespace-nowrap">
                    {row.oid === head.oid ? (
                      <span className="mr-2 flex shrink-0 gap-1">
                        <span className="badge">HEAD</span>
                        {head.state === "branch" ? <span className="badge">{branchName(head.target)}</span> : null}
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate">{row.subject}</span>
                  </span>
                  {row.encoding === null ? null : (
                    <span aria-hidden="true" className="shrink-0 text-muted-text">
                      {row.encoding}
                    </span>
                  )}
                  <span aria-hidden="true" className="shrink-0 font-mono text-muted-text">
                    {shortId(row.oid)}
                  </span>
                  {columns ? (
                    <>
                      <span aria-hidden="true" className="max-w-48 shrink truncate text-muted-text">
                        {row.author.name}
                      </span>
                      <span aria-hidden="true" className="num shrink-0 text-muted-text">
                        {dateFormat.format(row.date * 1000)}
                      </span>
                    </>
                  ) : null}
                </div>
              ))
            : null}
        </div>
      )}
      <section aria-labelledby={ids.inspector} className="shrink-0 overflow-auto border-t border-divider p-2">
        <h2 id={ids.inspector} className="font-semibold">
          Selected commit
        </h2>
        {selected === null || layout === null ? (
          <p className="text-muted-text">{NO_SELECTION}</p>
        ) : (
          <Inspector row={selected} cell={layout.cells[at(selected.oid)]!} loaded={index} onParent={onParent} dateFormat={dateFormat} />
        )}
      </section>
    </div>
  );
}

type InspectorProps = { row: HistoryRow; cell: Cell; loaded: ReadonlyMap<string, number>; onParent(oid: string): void; dateFormat: Intl.DateTimeFormat };

function Inspector({ row, cell, loaded, onParent, dateFormat }: InspectorProps) {
  return (
    <div className="flex flex-col gap-1">
      <p className="break-words">{row.subject}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2">
        <dt className="text-muted-text">ID</dt>
        <dd className="font-mono break-all">{row.oid}</dd>
        <dt className="text-muted-text">Author</dt>
        <dd className="break-words">
          {row.author.name} &lt;{row.author.email}&gt;
        </dd>
        <dt className="text-muted-text">Date</dt>
        <dd className="flex flex-wrap gap-x-2">
          <time dateTime={isoText(row.date)}>{dateFormat.format(row.date * 1000)}</time>
          <span className="num">{isoText(row.date)}</span>
        </dd>
        <dt className="text-muted-text">Parents</dt>
        <dd>
          <ol className="flex flex-col items-start gap-1">
            {row.parents.map((parent) => (
              <li key={parent} className="flex flex-wrap items-center gap-2">
                {loaded.has(parent) ? (
                  <Button variant="outline" size="sm" className="font-mono" onClick={() => onParent(parent)}>
                    {parent}
                  </Button>
                ) : (
                  <>
                    <code className="break-all">{parent}</code>
                    <span>{BOUNDARY_TEXT.outside}</span>
                  </>
                )}
              </li>
            ))}
            {cell.marks
              .filter((m) => m.parent === null)
              .map((m) => (
                <li key={m.kind}>{m.text}</li>
              ))}
            {cell.unresolved ? <li>{UNRESOLVED_TEXT}</li> : null}
          </ol>
        </dd>
      </dl>
      {row.encoding === null ? null : <p>{`${encodingText(row.encoding)}. ${ENCODING_NOTE}`}</p>}
      <p className="text-muted-text">{NO_FILES}</p>
    </div>
  );
}
