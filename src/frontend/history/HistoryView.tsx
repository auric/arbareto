// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CloudIcon, GitBranchIcon, Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ChangeEntry, HistoryPage, HistoryRow, RefEntry, RefsResult } from "../../contracts/envelope";
import { refsPair } from "../state/requests";
import { LimitedOutput, SCOPE_TEXT } from "../app/RepositoryStates";
import { WarningIcon } from "../app/NoticeBand";
import { metrics, type Density, type Profile } from "../layout/profiles";
import { shrinkInOrder, type Part } from "../lib/fit";
import { AncestryCell, LANE_SPACING, WorkingLineCell } from "./AncestryCell";
import { INVALID_UTF8_TEXT, LOCAL_DATE } from "./CommitDetails";
import { BOUNDARY_TEXT, layoutHistory, type Cell, type Layout } from "./lanes";

// plan.md "History graph design", "Long text", "Keyboard and focus" (Roles, History list), "Compact token system" (selection marker, badges), and "Required visible states".

export { SCOPE_TEXT };
export const LIMIT_TEXT: Record<NonNullable<Layout["limit"]>["reached"], string> = {
  lanes: "Graph layout limited: more than 24 lanes",
  segments: "Graph layout limited: more than 4,096 segments",
};
const NO_COMMITS = "No commits yet";
const LOADING = "Loading…";
const CLEAN = "Working tree clean";
/** The option IDs of the Working directory and Index rows. A commit OID is hex, so it never equals them. */
export const WORKING_ROW = "working-directory";
export const INDEX_ROW = "index";
export { LOCAL_DATE };

const shortId = (oid: string) => oid.slice(0, 12);
// Git ref names: a local branch is `refs/heads/<name>` (git-check-ref-format(1)).
export const branchName = (target: string) => (target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : target);
const encodingText = (encoding: string) => `Declared encoding: ${encoding}`;
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

export function checkoutText(head: Head): string {
  return head.state === "detached" ? "Detached HEAD" : branchName(head.target);
}

// plan.md "History graph design": chips follow the HEAD and branch badges in this kind order, each kind in the Git order of the result.
const CHIP_KINDS: { kind: RefEntry["kind"]; label: string; icon: typeof GitBranchIcon }[] = [
  { kind: "branch", label: "Branches", icon: GitBranchIcon },
  { kind: "remote", label: "remote-tracking", icon: CloudIcon },
  { kind: "tag", label: "tags", icon: Tag01Icon },
];

/** The chips of each commit: entries without `symref`, keyed by `commitId`, in chip order. The current branch shows as a badge instead. */
function chipsByCommit(refs: RefsResult, head: Head): Map<string, RefEntry[]> {
  const current = head.state === "branch" ? branchName(head.target) : null;
  const map = new Map<string, RefEntry[]>();
  for (const { kind } of CHIP_KINDS)
    for (const entry of refs.refs) {
      if (entry.kind !== kind || entry.symref !== null || entry.commitId === null || (kind === "branch" && entry.name === current)) continue;
      map.set(entry.commitId, [...(map.get(entry.commitId) ?? []), entry]);
    }
  return map;
}

/** The accessible text of the chips: "Branches: …, remote-tracking: …, tags: …". Empty kinds are left out. */
function chipsText(chips: readonly RefEntry[]): string[] {
  return CHIP_KINDS.flatMap(({ kind, label }) => {
    const names = chips.filter((c) => c.kind === kind).map((c) => c.name);
    return names.length === 0 ? [] : [`${label}: ${names.join(", ")}`];
  });
}

/** How many chips fit in `room`, half of the subject cell. Without room for all, the shown chips leave room for the "+<n>" chip. */
export function fitChips(widths: readonly number[], room: number, plus: number): number {
  if (widths.reduce((a, b) => a + b, 0) <= room) return widths.length;
  let used = plus;
  let count = 0;
  for (const width of widths) {
    if (used + width > room) break;
    used += width;
    count++;
  }
  return count;
}

function Chip({ entry }: { entry: RefEntry }) {
  const icon = CHIP_KINDS.find((k) => k.kind === entry.kind)!.icon;
  return (
    <span data-kind={entry.kind} className="chip flex shrink-0 items-center gap-1">
      <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
      <span data-chip-name className="max-w-[160px] truncate">
        {entry.name}
      </span>
    </span>
  );
}

/** The chips of one row. A hidden copy measures each chip, so the shown chips take at most half of the subject cell. */
function RowChips({ chips }: { chips: readonly RefEntry[] }) {
  const measure = useRef<HTMLSpanElement>(null);
  const [count, setCount] = useState(chips.length);
  useLayoutEffect(() => {
    const copy = measure.current;
    // The label region sits in the subject cell. Its badges take their part of the half first.
    const labels = copy?.parentElement;
    const cell = labels?.parentElement;
    if (!copy || !labels || !cell || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const parts = [...copy.children].map((c) => c.getBoundingClientRect().width);
      const plus = parts.pop() ?? 0;
      const badges = [...labels.querySelectorAll(":scope > .badge")].reduce((sum, b) => sum + b.getBoundingClientRect().width, 0);
      setCount(fitChips(parts, Math.max(0, cell.clientWidth / 2 - badges), plus));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [chips]);
  const hidden = chips.length - count;
  return (
    <>
      {chips.slice(0, count).map((entry) => (
        <Chip key={`${entry.kind}:${entry.name}`} entry={entry} />
      ))}
      {hidden > 0 ? <span className="chip shrink-0">+{hidden}</span> : null}
      <span ref={measure} aria-hidden="true" className="invisible absolute flex gap-1">
        {chips.map((entry) => (
          <span key={`${entry.kind}:${entry.name}`} className="flex items-center gap-1">
            <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-(--icon-size)" />
            <span className="max-w-[160px] truncate">{entry.name}</span>
          </span>
        ))}
        <span>+{chips.length}</span>
      </span>
    </>
  );
}

/** The full row text: HEAD labels, subject, short ID, author, date, parent count, ordered parents, boundary labels, the declared encoding, and the invalid UTF-8 text. */
export function rowName(row: HistoryRow, cell: Cell, head: Head, dateFormat: Intl.DateTimeFormat = LOCAL_DATE, chips: readonly RefEntry[] = []): string {
  const parts: string[] = [];
  if (head.state !== "unborn" && row.oid === head.oid) parts.push(head.state === "branch" ? `HEAD, branch ${branchName(head.target)}` : "HEAD, detached");
  parts.push(...chipsText(chips));
  parts.push(row.subject, shortId(row.oid), row.author.name, dateFormat.format(row.date * 1000));
  if (row.parents.length > 0) parts.push(plural(row.parents.length, "parent", "parents"));
  for (const parent of row.parents) {
    parts.push(shortId(parent));
    if (cell.marks.some((m) => m.parent === parent)) parts.push(BOUNDARY_TEXT.outside);
  }
  for (const mark of cell.marks) if (mark.parent === null) parts.push(mark.text);
  if (row.encoding !== null) parts.push(encodingText(row.encoding));
  if (row.invalidUtf8) parts.push(INVALID_UTF8_TEXT);
  return parts.join(", ");
}

export type HistoryViewProps = {
  /** The shown `readHistory` page, or null before the first one. */
  page: HistoryPage | null;
  /** The entries of the latest complete `readWorkspace`, or null before one. */
  entries: readonly Counted[] | null;
  /** `WORKING_ROW`, `INDEX_ROW`, or a commit OID. Controlled by the workspace state. Null on open. */
  selected: string | null;
  /** Docks the panel of the row. It starts no Git read, never checks out, and never moves a reference. */
  onSelect(id: string): void;
  density: Density;
  profile: Profile;
  /** The Windows text size factor. */
  textScale?: number;
  /** The list region minimum of `historyFit` (plan.md "Constrained sizes"). The default is one row. */
  listMin?: number;
  /** The author time format. Tests pin its time zone and locale. */
  dateFormat?: Intl.DateTimeFormat;
  /** The newest `readRefs` list. Chips show only when it pairs with `page` (contract §3 "Pairing with the history page"). */
  refs?: RefsResult | null;
};

/** plan.md "History graph design": the visible parts of the Working directory and Index rows. Null parts show Loading. */
function specialParts(entries: readonly Counted[] | null): { working: string[]; conflicted: string | null; index: string[] } {
  if (entries === null) return { working: ["Working directory", LOADING], conflicted: null, index: ["Index", LOADING] };
  let conflicted = 0;
  let working = 0;
  let staged = 0;
  for (const { category } of entries) {
    if (category === "conflicted") conflicted++;
    else if (category === "staged") staged++;
    else working++;
  }
  const clean = working === 0 && conflicted === 0;
  return {
    working: ["Working directory", clean ? CLEAN : plural(working, "working change", "working changes")],
    conflicted: conflicted > 0 ? `${conflicted} conflicted` : null,
    index: ["Index", `${staged} staged`],
  };
}

/** The history list: the Working directory and Index options, then the commit rows. One listbox with one Tab stop. */
export function HistoryView({ page, entries, selected, onSelect, density, profile, textScale = 1, listMin: fitted, dateFormat = LOCAL_DATE, refs = null }: HistoryViewProps) {
  const ids = { scope: useId(), limit: useId() };
  const rows = page?.rows ?? [];
  const layout = useMemo(() => (page === null ? null : layoutHistory(page)), [page]);
  // Option IDs in list order. A commit OID never equals the two row IDs.
  const order = useMemo(() => [WORKING_ROW, INDEX_ROW, ...rows.map((r) => r.oid)], [rows]);
  const listbox = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const [activeId, setActiveId] = useState<string | null>(null);
  const at = (id: string | null) => (id === null ? -1 : order.indexOf(id));
  // The Tab stop: the last focused row, else the selected row, else the first row.
  const activeIndex = at(activeId) >= 0 ? at(activeId) : at(selected) >= 0 ? at(selected) : 0;
  const m = metrics(density, textScale);
  const rowHeight = m.row;
  const spacing = LANE_SPACING[density];
  const columns = profile === "wide";
  const limit = layout?.limit ? LIMIT_TEXT[layout.limit.reached] : undefined;
  const lanes = layout?.lanes ?? 1;
  const line = rows.length > 0;
  const special = specialParts(entries);
  const chips = useMemo(() => (page !== null && refs !== null && refsPair(page.head, refs.current) ? chipsByCommit(refs, page.head) : null), [page, refs]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const option = (event.target as HTMLElement).closest('[role="option"]') as HTMLElement | null;
    const from = at(option?.dataset.rowId ?? null);
    if (from < 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      return onSelect(order[from]!);
    }
    const step = option!.offsetHeight > 0 ? Math.max(1, Math.floor(listbox.current!.clientHeight / option!.offsetHeight)) : 1;
    const to =
      event.key === "ArrowDown" ? from + 1
      : event.key === "ArrowUp" ? from - 1
      : event.key === "Home" ? 0
      : event.key === "End" ? order.length - 1
      : event.key === "PageDown" ? from + step
      : event.key === "PageUp" ? from - step
      : null;
    if (to === null) return;
    event.preventDefault();
    // plan.md "Keyboard and focus", History list row: selection follows each navigation key.
    const id = order[Math.min(order.length - 1, Math.max(0, to))]!;
    setActiveId(id);
    elements.current.get(id)?.focus();
    if (id !== selected) onSelect(id);
  }

  const head = page?.head ?? null;
  const optionProps = (id: string, i: number, label: string) => ({
    ref: (element: HTMLElement | null) => void (element ? elements.current.set(id, element) : elements.current.delete(id)),
    role: "option",
    "data-row-id": id,
    "aria-selected": id === selected,
    "aria-label": label,
    tabIndex: i === activeIndex ? 0 : -1,
    className: "list-row flex items-center gap-2 pr-2",
    style: { height: rowHeight },
    onFocus: () => setActiveId(id),
    onClick: () => onSelect(id),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScopeLine id={ids.scope} checkout={head === null ? "" : checkoutText(head)} entries={entries} limit={limit} limitId={ids.limit} />
      {page === null ? null : <LimitedOutput completeness={page.completeness} />}
      <div
        ref={listbox}
        role="listbox"
        aria-labelledby={ids.scope}
        aria-describedby={limit === undefined ? undefined : ids.limit}
        className="overflow-y-auto px-1"
        style={{ flex: "1 1 0", minHeight: fitted ?? m.row }}
        onKeyDown={onKeyDown}
      >
        <div {...optionProps(WORKING_ROW, 0, [...special.working, ...(special.conflicted === null ? [] : [special.conflicted])].join(", "))}>
          <WorkingLineCell lanes={lanes} spacing={spacing} rowHeight={rowHeight} part="start" line={line} />
          <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
            <span className="shrink-0">{special.working[0]}</span>
            <span className="truncate text-muted-text">{special.working[1]}</span>
            {special.conflicted === null ? null : (
              <span className="flex shrink-0 items-center gap-1">
                <WarningIcon />
                {special.conflicted}
              </span>
            )}
          </span>
        </div>
        <div {...optionProps(INDEX_ROW, 1, special.index.join(", "))}>
          <WorkingLineCell lanes={lanes} spacing={spacing} rowHeight={rowHeight} part="through" line={line} />
          <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
            <span className="shrink-0">{special.index[0]}</span>
            <span className="truncate text-muted-text">{special.index[1]}</span>
          </span>
        </div>
        {head?.state === "unborn" ? (
          <p className="p-2 text-muted-text">{NO_COMMITS}</p>
        ) : layout !== null && head !== null ? (
          rows.map((row, i) => (
            <div key={row.oid} data-oid={row.oid} {...optionProps(row.oid, i + 2, rowName(row, layout.cells[i]!, head, dateFormat, chips?.get(row.oid)))}>
              <AncestryCell cell={layout.cells[i]!} lanes={layout.lanes} spacing={spacing} rowHeight={rowHeight} selected={row.oid === selected} leadIn={i === 0} />
              {/* An 8 DIP gap separates the label region from the subject. */}
              <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
                {row.oid === head.oid || chips?.has(row.oid) ? (
                  // plan.md "History graph design": the badges and chips take at most half of the subject cell and never draw past it.
                  <span data-slot="row-labels" className="relative flex min-w-0 max-w-[50%] shrink-0 items-center gap-1 overflow-hidden">
                    {row.oid === head.oid ? (
                      <>
                        <span className="badge shrink-0">HEAD</span>
                        {head.state === "branch" ? (
                          <span className="badge block max-w-[160px] min-w-0 shrink truncate" style={{ lineHeight: "calc(var(--h-badge) - 2px)" }}>
                            {branchName(head.target)}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                    {chips?.has(row.oid) ? <RowChips chips={chips.get(row.oid)!} /> : null}
                  </span>
                ) : null}
                <span className="min-w-0 truncate">{row.subject}</span>
              </span>
              {row.encoding === null ? null : (
                <span aria-hidden="true" className="shrink-0 text-muted-text">
                  {row.encoding}
                </span>
              )}
              {row.invalidUtf8 ? (
                <span aria-hidden="true" className="shrink-0 text-muted-text">
                  Invalid UTF-8
                </span>
              ) : null}
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
        ) : null}
      </div>
    </div>
  );
}
