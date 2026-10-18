// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Archive01Icon, Cancel01Icon, CloudIcon, GitBranchIcon, Search01Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { HISTORY_VIEW_COMMITS } from "../../contracts/limits";
import { CopyButton } from "../app/RepositoryStates";
import { WarningIcon } from "../app/NoticeBand";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/icon-button";
import { metrics, type Density, type Profile } from "../layout/profiles";
import type { TrackLabel } from "../state/tracking";
import { scopedAction } from "../keyboard/shortcuts";
import { SPECIAL_ROWS, type Head, type HistoryView, type Scope, type SearchState, type ViewRow } from "../state/history-view";
import { BOUNDARY_TEXT, columnWidth, LANE_SPACING, ViewCell, WorkingLineCell } from "./AncestryCell";
import { INVALID_UTF8_TEXT, LOCAL_DATE } from "./CommitDetails";
import { countText, HistoryFilter } from "./HistoryFilter";
import { branchName, INDEX_ROW, LIMIT_TEXT, specialParts, WORKING_ROW, type Counted } from "./HistoryView";

// Feature 002 plan.md D6 (list, scroll range, load trigger, branch scope, listbox, graph column, labels, working directory line), spec FR-005 to FR-016, FR-049, FR-050.

/** plan.md D6: Chromium's LayoutUnit maximum (unverified in WebView2, research.md R13). */
export const MAX_LAYOUT_PX = 33_554_431;

/** plan.md D6: the scroll height of `total` rows. */
export const scrollHeightOf = (total: number, rowHeight: number) => Math.min(total * rowHeight, MAX_LAYOUT_PX);

/** plan.md D6: `virtualTop = scrollTop · (total·rowHeight − clientHeight) / maxScrollTop`. It equals `scrollTop` when the range is not compressed. */
export function virtualTopOf(scrollTop: number, total: number, rowHeight: number, clientHeight: number, scrollHeight: number): number {
  const maxScrollTop = scrollHeight - clientHeight;
  if (maxScrollTop <= 0) return 0;
  if (scrollHeight === total * rowHeight) return scrollTop;
  return (scrollTop * (total * rowHeight - clientHeight)) / maxScrollTop;
}

/** plan.md D6: the inverse rule, `scrollTop = virtualTop · maxScrollTop / (total·rowHeight − clientHeight)`. */
export function scrollTopOf(virtualTop: number, total: number, rowHeight: number, clientHeight: number, scrollHeight: number): number {
  const maxScrollTop = scrollHeight - clientHeight;
  const range = total * rowHeight - clientHeight;
  if (maxScrollTop <= 0 || range <= 0) return 0;
  if (scrollHeight === total * rowHeight) return virtualTop;
  return (virtualTop * maxScrollTop) / range;
}

/** plan.md D6: a row above the viewport aligns to the top, a row below aligns to the bottom, and a visible row does not move. */
export function revealTop(item: number, virtualTop: number, rowHeight: number, clientHeight: number, total: number): number {
  const top = item * rowHeight;
  const next = top < virtualTop ? top : top + rowHeight > virtualTop + clientHeight ? top + rowHeight - clientHeight : virtualTop;
  return Math.max(0, Math.min(next, total * rowHeight - clientHeight));
}

const fmt = new Intl.NumberFormat("en-US");
const commits = (n: number) => `${fmt.format(n)} ${n === 1 ? "commit" : "commits"}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const shortId = (oid: string) => oid.slice(0, 12);

export const CHIP_TEXT = "Current branch only";
export const MORE_TEXT = "More commits exist.";
const MORE_MATCHES = "More matches can follow.";
const NO_COMMITS = "No commits yet";
const FILTER_UNAVAILABLE = "The filter needs at least one commit.";
const NO_MATCH = "No commit message contains the text";
const SKIP_TEXT = "Skips commits that do not match";
const NO_EARLIER = "No earlier matching commit";
const TEXT_LIMIT = "Commit object larger than 256 KiB";
const RESTART = "The shown rows stay, but no more rows load. Refresh to start a new history list.";
const LOADING = "Loading…";

/** Contract Δ8: the typed reason of a stale view. */
function staleText({ code, reason }: { code: string; reason?: string }): string {
  if (code === "HISTORY_CHANGED")
    return reason === "topology" ? "History changed: the shallow, graft, or replace data of the repository changed." : "History changed: Git listed the commits in a different order.";
  if (code === "OBJECT_MISSING") return "A commit of this history is missing from the repository.";
  if (code === "MALFORMED_GIT_OUTPUT") return "Git gave history output that Arbareto cannot read.";
  if (code === "GIT_FAILED") return "Git failed while it read the history.";
  if (code === "REPOSITORY_UNAVAILABLE") return "Git cannot read the object store of this repository.";
  if (code === "UNKNOWN_TARGET" || code === "STATE_UNKNOWN" || code === "SERVICE_UNAVAILABLE") return "The Git service restarted, so this history list ended.";
  return `Arbareto cannot continue this history list: ${code}.`;
}

/** Contract Δ3 `OUTPUT_LIMIT` reasons. */
function limitText(reason: string): string {
  if (reason === "HISTORY_VIEW_COMMITS") return `History stops at ${fmt.format(HISTORY_VIEW_COMMITS)} commits. One history list holds at most ${fmt.format(HISTORY_VIEW_COMMITS)} commits.`;
  if (reason === "HISTORY_PARENTS_PER_COMMIT") return "History stops at a commit with more than 64 parents. Arbareto reads at most 64 parents of a commit.";
  if (reason === "REF_LISTING_RECORDS") return "History not shown. This repository has more than 10,000 references. Arbareto reads at most 10,000 references.";
  return `History stops at an output limit: ${reason}.`;
}

/** Contract Δ9 `UNSUPPORTED_FILTER_TEXT`: the reason names the found character. */
function refusedText(search: SearchState): string {
  if (search.code === "UNSUPPORTED_FILTER_TEXT") {
    // `filter-text.ts`: reason `length` with a found character is text that is not well-formed. Without one, it is the byte bound.
    const what =
      search.reason === "quote-end" ? 'a backslash followed by "E" (\\E)'
      : search.reason === "line-break" ? "a line break"
      : search.reason === "nul" ? "a NUL character"
      : search.reason === "length" && search.found != null ? `a character that is not valid text (U+${search.found.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")})`
      : null;
    if (what !== null) return `Cannot search this text. It holds ${what}. Remove it and press Enter again.`;
    if (search.reason === "length") return "Cannot search this text. It is longer than 1,024 bytes in UTF-8. Shorten it and press Enter again.";
    return `Cannot search this text: ${search.code}${search.reason === undefined ? "" : ` ${search.reason}`}.`;
  }
  if (search.code === "SEARCH_UNSUPPORTED") return `Search is not available here. ${search.remedy?.text ?? ""}`.trim();
  if (search.code === "OUTPUT_LIMIT") return `Search is not available, because this history list stopped at ${fmt.format(HISTORY_VIEW_COMMITS)} commits.`;
  if (search.code === "HISTORY_CHANGED") return "The search stopped: Git listed the commits in a different order. Press Enter to search again.";
  return `The search failed: ${search.code}. Press Enter to search again.`;
}

// plan.md "History graph design": label kinds in this order. Feature 002 adds the stash (contract Δ3).
const LABEL_KINDS: { kind: ViewRow["labels"][number]["kind"]; label: string; icon: typeof GitBranchIcon }[] = [
  { kind: "branch", label: "Branches", icon: GitBranchIcon },
  { kind: "remote", label: "remote-tracking", icon: CloudIcon },
  { kind: "tag", label: "tags", icon: Tag01Icon },
  { kind: "stash", label: "stash", icon: Archive01Icon },
];

/** 001 plan.md "History graph design": how many labels fit in `room`, half of the subject cell. Without room for all, the shown labels leave room for the "+<n>" chip. */
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

type Tracking = ReadonlyMap<string, TrackLabel>;
/** Feature 003 FR-019: a local branch label joins its count label by branch name. */
const countOf = (label: ViewRow["labels"][number], tracking: Tracking | undefined) => (label.kind === "branch" ? (tracking?.get(label.name) ?? null) : null);

type Label = ViewRow["labels"][number];
/** Feature 004 spec FR-014: the branch menu of a local or remote-tracking branch label. */
type LabelMenu = (label: Label, anchor: HTMLElement) => void;

function LabelChip({ label, tracking, onMenu }: { label: Label; tracking?: Tracking; onMenu?: LabelMenu }) {
  const count = countOf(label, tracking);
  const menu =
    onMenu !== undefined && (label.kind === "branch" || label.kind === "remote")
      ? (event: { preventDefault(): void; stopPropagation(): void; currentTarget: HTMLElement }) => {
          event.preventDefault();
          event.stopPropagation();
          onMenu(label, event.currentTarget);
        }
      : undefined;
  return (
    <span data-kind={label.kind} className="chip flex shrink-0 items-center gap-1" onContextMenu={menu}>
      <HugeiconsIcon icon={LABEL_KINDS.find((k) => k.kind === label.kind)!.icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
      <span data-chip-name className="max-w-[160px] truncate">
        {label.name}
      </span>
      {count === null ? null : <span className="num shrink-0">{count.text}</span>}
    </span>
  );
}

/** The labels of one row. A hidden copy measures each label, so the shown labels take at most half of the subject cell. */
function RowLabels({ labels, tracking, onMenu }: { labels: ViewRow["labels"]; tracking?: Tracking; onMenu?: LabelMenu }) {
  const measure = useRef<HTMLSpanElement>(null);
  const [count, setCount] = useState(labels.length);
  useLayoutEffect(() => {
    const copy = measure.current;
    // The label region sits in the subject cell. The HEAD badge takes its part of the half first.
    const region = copy?.parentElement;
    const cell = region?.parentElement;
    if (!copy || !region || !cell || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const parts = [...copy.children].map((c) => c.getBoundingClientRect().width);
      const plus = parts.pop() ?? 0;
      const badges = [...region.querySelectorAll(":scope > .badge")].reduce((sum, b) => sum + b.getBoundingClientRect().width, 0);
      setCount(fitChips(parts, Math.max(0, cell.clientWidth / 2 - badges), plus));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [labels, tracking]);
  const hidden = labels.length - count;
  return (
    <>
      {labels.slice(0, count).map((l) => (
        <LabelChip key={`${l.kind}:${l.name}`} label={l} tracking={tracking} onMenu={onMenu} />
      ))}
      {hidden > 0 ? <span className="chip shrink-0">+{hidden}</span> : null}
      <span ref={measure} aria-hidden="true" className="invisible absolute flex gap-1">
        {labels.map((l) => {
          const count = countOf(l, tracking);
          return (
            <span key={`${l.kind}:${l.name}`} className="flex items-center gap-1">
              <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-(--icon-size)" />
              <span className="max-w-[160px] truncate">{l.name}</span>
              {count === null ? null : <span>{count.text}</span>}
            </span>
          );
        })}
        <span>+{labels.length}</span>
      </span>
    </>
  );
}

/** The checkout text of the row that `checkout` marks (spec FR-050). */
function checkoutText(head: Head): string {
  return head.state === "branch" ? `HEAD, branch ${branchName(head.target)}` : head.state === "detached" ? "HEAD, detached" : "HEAD";
}

/**
 * A filter-mode match without a node-to-bottom edge has no matching ancestor (plan.md D4): `layoutStep` draws one line per parent lane.
 * Roots and shallow boundaries say so themselves. A limited row draws no edge (data-model §4), so its cell cannot tell (contract gap).
 */
const noEarlier = (cell: NonNullable<ViewRow["cell"]>) => !cell.limited && cell.marks.length === 0 && !cell.segments.some((s) => s.shape === "line" && s.from.at === "node");
const skips = (cell: NonNullable<ViewRow["cell"]>) => cell.segments.some((s) => s.shape === "line" && s.skip === true);

/** The full row text. Parents stay readable without color or pointer (spec FR-016). */
export function viewRowName(row: ViewRow, head: Head, filter: boolean, dateFormat: Intl.DateTimeFormat = LOCAL_DATE, tracking?: Tracking): string {
  const parts: string[] = [];
  if (row.checkout) parts.push(checkoutText(head));
  for (const { kind, label } of LABEL_KINDS) {
    const names = row.labels.filter((l) => l.kind === kind).map((l) => [l.name, countOf(l, tracking)?.label].filter(Boolean).join(" "));
    if (names.length > 0) parts.push(`${label}: ${names.join(", ")}`);
  }
  if (row.match === true) parts.push("Match");
  if (row.textLimit) parts.push(TEXT_LIMIT, shortId(row.oid));
  else if (row.subject !== undefined) parts.push(row.subject, shortId(row.oid), row.author!.name, dateFormat.format(row.date! * 1000));
  else parts.push(shortId(row.oid));
  if (row.parents.length > 0) parts.push(plural(row.parents.length, "parent", "parents"), ...row.parents.map(shortId));
  const cell = row.cell;
  if (cell !== null) {
    for (const mark of cell.marks) parts.push(BOUNDARY_TEXT[mark]);
    if (cell.limited) parts.push(LIMIT_TEXT.lanes);
    if (filter && skips(cell)) parts.push(SKIP_TEXT);
    if (filter && noEarlier(cell)) parts.push(NO_EARLIER);
  }
  if (row.encoding != null) parts.push(`Declared encoding: ${row.encoding}`);
  if (row.invalidUtf8) parts.push(INVALID_UTF8_TEXT);
  return parts.join(", ");
}

export type HistoryListProps = {
  view: HistoryView;
  /** The entries of the latest complete `readWorkspace`, or null before one. */
  entries: readonly Counted[] | null;
  density: Density;
  profile: Profile;
  textScale?: number;
  dateFormat?: Intl.DateTimeFormat;
  /** Docks the panel of the selected row. It never checks out and never moves a reference. */
  onSelect(id: string): void;
  /** The chip removal selects all branches (spec FR-049). */
  onScope(scope: Scope): void;
  filterRef?: Ref<HTMLInputElement>;
  /** Feature 003 FR-019: the count label of each local branch by name. */
  tracking?: Tracking;
  /** Feature 004 spec FR-014: a right-click on a branch label opens its branch menu. */
  onLabelMenu?: LabelMenu;
  /** Feature 004 plan.md D15: Ctrl+B on the selected commit row opens Create branch here. */
  onCreateBranch?: (oid: string, anchor: HTMLElement) => void;
};

/** The feature 002 history list: a fixed-height window over the service view (plan.md D6). One listbox, one Tab stop, focus on the list. */
export function HistoryList({ view, entries, density, profile, textScale = 1, dateFormat = LOCAL_DATE, onSelect, onScope, filterRef, tracking, onLabelMenu, onCreateBranch }: HistoryListProps) {
  const state = useSyncExternalStore(view.subscribe, view.getState);
  const ids = { heading: useId(), count: useId(), notes: useId(), list: useId() };
  const list = useRef<HTMLDivElement>(null);
  // A notes control that leaves with focus moves focus to the list, as the notice band does (plan.md "Notice band").
  const focusLost = useRef(false);
  const [bindLeaving] = useState(() => (element: HTMLElement | null) => () => {
    if (element !== null && document.activeElement === element) focusLost.current = true;
  });
  useLayoutEffect(() => {
    if (!focusLost.current) return;
    focusLost.current = false;
    list.current?.focus();
  });
  const rowHeight = metrics(density, textScale).row;
  const spacing = LANE_SPACING[density];
  const filter = view.filterMode();
  const rows = view.listRows();
  const more = state.view !== null && !view.listComplete() && state.stale === null;
  const total = SPECIAL_ROWS + rows + (more ? 1 : 0);
  const lastItem = SPECIAL_ROWS + rows - 1;

  // `top` is the virtual offset. `scrollTop` and `height` mirror the list element.
  const [box, setBox] = useState({ scrollTop: 0, top: 0, height: 0 });
  const written = useRef<number | null>(null);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);

  const scrollTo = (top: number) => {
    const element = list.current;
    if (element === null) return;
    const wanted = scrollTopOf(top, total, rowHeight, element.clientHeight, element.scrollHeight);
    element.scrollTop = wanted;
    // The element clamps the value. A clamped value gets its own virtual offset.
    const scrollTop = element.scrollTop;
    written.current = scrollTop;
    const kept = Math.abs(scrollTop - wanted) < 1 ? top : virtualTopOf(scrollTop, total, rowHeight, element.clientHeight, element.scrollHeight);
    setBox({ scrollTop, top: kept, height: element.clientHeight });
  };

  // The list element gives the viewport height. happy-dom has no layout, so tests stub it.
  useLayoutEffect(() => {
    const element = list.current;
    if (element === null) return;
    const measure = () => setBox((b) => (b.height === element.clientHeight ? b : { ...b, height: element.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // plan.md D6 "Count growth": the window keeps `virtualTop` and sets `scrollTop` by the inverse rule. No visible row moves.
  const shownTotal = useRef(total);
  useLayoutEffect(() => {
    if (shownTotal.current === total) return;
    shownTotal.current = total;
    const element = list.current;
    if (element === null) return;
    scrollTo(Math.max(0, Math.min(box.top, total * rowHeight - element.clientHeight)));
  }, [total]);

  // A row change from the store (End, a match move, Refresh) scrolls the row into view.
  const revealed = useRef<number | null>(null);
  useLayoutEffect(() => {
    const reveal = state.reveal;
    if (reveal === null || reveal.seq === revealed.current) return;
    revealed.current = reveal.seq;
    setActive(reveal.item);
    scrollTo(revealTop(reveal.item, box.top, rowHeight, list.current?.clientHeight ?? 0, total));
  }, [state.reveal, total]);

  // The parent docks the panel of each new selection.
  const selectedId = state.selection?.id ?? null;
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === null || selectedId === notified.current) return;
    notified.current = selectedId;
    onSelect(selectedId);
  }, [selectedId]);

  const height = box.height;
  const first = Math.max(0, Math.floor(box.top / rowHeight));
  // One row more than the viewport fits, so the element count does not depend on the scroll offset.
  const last = Math.min(total - 1, first + Math.ceil(Math.max(height, rowHeight) / rowHeight));
  // The last item with a visible part.
  const fits = Math.floor((box.top + Math.max(height, rowHeight) - 1) / rowHeight);
  const visibleLast = Math.min(total - 1, fits);
  const moreShown = more && visibleLast === total - 1;
  // plan.md D6 load trigger: the first load asks for the last row that the viewport fits. Later loads ask for the last commit row in the window,
  // or for the loaded row count while the more-rows row shows.
  const need = state.viewRows === 0 ? fits - SPECIAL_ROWS : moreShown ? state.viewRows : visibleLast - SPECIAL_ROWS;
  useEffect(() => {
    // No layout yet: the first window is not known.
    if (height === 0) return;
    // The store clamps the window to the list length, so a load end reads the new rows without another render.
    view.demand(Math.max(0, first - SPECIAL_ROWS), last - SPECIAL_ROWS, moreShown, need);
  }, [view, height, first, last, need, moreShown, rows, state.view, state.load, state.search?.state, state.search?.searchId, state.search?.mode]);

  // A keyboard move to a row that is not loaded yet selects it when its page arrives.
  useEffect(() => {
    if (active < SPECIAL_ROWS || state.selection?.index === active - SPECIAL_ROWS) return;
    const row = view.row(active - SPECIAL_ROWS);
    if (row !== undefined && focused) view.select(row.oid, row.index, undefined, false);
  }, [state.version, active]);

  function go(item: number) {
    const to = Math.max(0, Math.min(lastItem, item));
    setActive(to);
    scrollTo(revealTop(to, box.top, rowHeight, list.current?.clientHeight ?? 0, total));
    // plan.md "Keyboard and focus", History list row: selection follows each navigation key.
    if (to === 0) view.select(WORKING_ROW, null, undefined, false);
    else if (to === 1) view.select(INDEX_ROW, null, undefined, false);
    else {
      const row = view.row(to - SPECIAL_ROWS);
      if (row !== undefined) view.select(row.oid, row.index, undefined, false);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const selection = state.selection;
    const selectedOid = selection?.mode === listMode && selection.index !== null ? selection.id : undefined;
    if (onCreateBranch !== undefined && selectedOid !== undefined && scopedAction(event, "historyRow") === "createBranch") {
      event.preventDefault();
      return onCreateBranch(selectedOid, event.currentTarget);
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const page = Math.max(1, Math.floor(height / rowHeight));
    const moves: Record<string, () => void> = {
      ArrowDown: () => go(active + 1),
      ArrowUp: () => go(active - 1),
      Home: () => go(0),
      PageDown: () => go(active + page),
      PageUp: () => go(active - page),
      End: () => void view.end(),
      Enter: () => go(active),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    move();
  }

  function onScroll() {
    const element = list.current;
    if (element === null) return;
    const scrollTop = element.scrollTop;
    // The write of `scrollTo` keeps its virtual offset. Browsers can round the written value.
    if (written.current !== null && Math.abs(scrollTop - written.current) < 1) {
      written.current = null;
      return;
    }
    written.current = null;
    setBox({ scrollTop, top: virtualTopOf(scrollTop, total, rowHeight, element.clientHeight, element.scrollHeight), height: element.clientHeight });
  }

  const head = state.view?.head ?? null;
  const empty = state.view !== null && state.view.startCount === 0;
  const row0 = view.row(0);
  // plan.md D6: the dotted lead-in shows only when HEAD is row 0.
  const line = !filter && row0?.checkout === true;
  const special = specialParts(entries);
  const lanes = state.lanes;
  const optionId = (item: number) => `${ids.list}-${item}`;
  const setSize = more ? -1 : total;
  const search = state.search;
  const listMode = filter ? "filter" : "full";
  const isSelected = (item: number) =>
    item < SPECIAL_ROWS ? selectedId === (item === 0 ? WORKING_ROW : INDEX_ROW) : state.selection?.index === item - SPECIAL_ROWS && state.selection.mode === listMode;

  const heading = () => {
    if (state.view === null) return state.openFailure === null ? LOADING : "";
    if (empty) return NO_COMMITS;
    if (filter) return commits(state.viewRows) + (state.complete ? "" : " loaded");
    if (!state.complete) return `${fmt.format(state.viewRows)} commits loaded.${state.limit === null ? ` ${MORE_TEXT}` : ""}`;
    return `${commits(state.viewRows)}${state.view.shallow ? ". This repository is a shallow clone, so history ends early." : ""}`;
  };

  const option = (item: number, label: string, className: string, children: ReactNode, extra: Record<string, unknown> = {}) => (
    <div
      key={item}
      id={optionId(item)}
      role="option"
      aria-selected={extra["aria-disabled"] === true ? undefined : isSelected(item)}
      aria-posinset={item + 1}
      aria-setsize={setSize}
      aria-label={label}
      data-item={item}
      data-active={item === active && focused ? "" : undefined}
      className={`list-row absolute right-0 left-0 flex items-center gap-2 pr-2 ${className}`}
      style={{ top: box.scrollTop + item * rowHeight - box.top, height: rowHeight }}
      onClick={() => {
        if (extra["aria-disabled"] === true) return;
        go(item);
        list.current?.focus();
      }}
      {...extra}
    >
      {children}
    </div>
  );

  const commitRow = (item: number) => {
    const index = item - SPECIAL_ROWS;
    const row = view.row(index);
    if (row === undefined)
      return option(
        item,
        LOADING,
        "text-muted-text",
        <>
          <svg className="graph-cell shrink-0" width={columnWidth(lanes, spacing)} height={rowHeight} aria-hidden="true" />
          <span aria-hidden="true">{LOADING}</span>
        </>,
      );
    const selected = isSelected(item);
    const cell = row.cell;
    return option(
      item,
      viewRowName(row, head!, filter, dateFormat, tracking),
      "",
      <>
        {cell === null ? (
          <svg className="graph-cell shrink-0" width={columnWidth(lanes, spacing)} height={rowHeight} aria-hidden="true" />
        ) : (
          <ViewCell cell={cell} lanes={lanes} spacing={spacing} rowHeight={rowHeight} selected={selected} leadIn={index === 0 && line} />
        )}
        <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
          {row.checkout || row.labels.length > 0 ? (
            <span data-slot="row-labels" title={row.labels.map((l) => l.name).join(", ")} className="relative flex min-w-0 max-w-[50%] shrink-0 items-center gap-1 overflow-hidden">
              {row.checkout ? <span className="badge shrink-0">{head?.state === "detached" ? "HEAD, detached" : "HEAD"}</span> : null}
              <RowLabels labels={row.labels} tracking={tracking} onMenu={onLabelMenu} />
            </span>
          ) : null}
          {row.match === true ? <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" data-slot="match-mark" className="size-(--icon-size) shrink-0 text-accent-role" /> : null}
          <span className="min-w-0 truncate">{row.textLimit ? TEXT_LIMIT : (row.subject ?? "")}</span>
          {cell?.limited ? (
            <span className="flex shrink-0 items-center gap-1 text-muted-text">
              <WarningIcon />
              {LIMIT_TEXT.lanes}
            </span>
          ) : null}
          {filter && cell !== null && noEarlier(cell) ? <span className="shrink-0 text-muted-text">{NO_EARLIER}</span> : null}
          {cell?.marks.map((m) => (
            <span key={m} className="shrink-0 text-muted-text">
              {BOUNDARY_TEXT[m]}
            </span>
          ))}
        </span>
        {row.encoding == null ? null : (
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
        {profile === "wide" && row.author !== undefined ? (
          <>
            <span aria-hidden="true" className="max-w-48 shrink truncate text-muted-text">
              {row.author.name}
            </span>
            <span aria-hidden="true" className="num shrink-0 text-muted-text">
              {dateFormat.format(row.date! * 1000)}
            </span>
          </>
        ) : null}
      </>,
      { "data-row-id": row.oid },
    );
  };

  const items: ReactNode[] = [];
  for (let item = first; item <= last; item++) {
    if (item === 0)
      items.push(
        option(
          0,
          [...special.working, ...(special.conflicted === null ? [] : [special.conflicted])].join(", "),
          "",
          <>
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
          </>,
          { "data-row-id": WORKING_ROW },
        ),
      );
    else if (item === 1)
      items.push(
        option(
          1,
          special.index.join(", "),
          "",
          <>
            <WorkingLineCell lanes={lanes} spacing={spacing} rowHeight={rowHeight} part="through" line={line} />
            <span aria-hidden="true" className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
              <span className="shrink-0">{special.index[0]}</span>
              <span className="truncate text-muted-text">{special.index[1]}</span>
            </span>
          </>,
          { "data-row-id": INDEX_ROW },
        ),
      );
    else if (more && item === total - 1) {
      const text = filter ? MORE_MATCHES : state.load?.kind === "scroll" ? `${MORE_TEXT} Loading more commits…` : MORE_TEXT;
      items.push(option(item, text, "text-muted-text", <span className="pl-2">{text}</span>, { "aria-disabled": true, "data-more": "" }));
    } else items.push(commitRow(item));
  }

  const progress =
    state.load !== null ? { text: state.load.kind === "end" ? "Loading all commits…" : state.load.kind === "oid" ? "Loading commits up to the selected commit…" : "Loading more commits…", count: `${fmt.format(state.load.rows)} loaded`, cancel: view.cancelLoad }
    : search?.state === "running" ? { text: "Searching commit messages…", count: `${countText(search)!.replace(", more can follow", "")}, ${fmt.format(search.settled)} with final graph lines`, cancel: view.cancelSearch }
    : null;

  const notes: ReactNode[] = [];
  if (state.openFailure !== null)
    notes.push(
      <p key="open" className="flex items-center gap-2">
        <WarningIcon />
        <span>{state.openFailure.code === "OUTPUT_LIMIT" && state.openFailure.reason !== undefined ? limitText(state.openFailure.reason) : `Arbareto cannot open the history: ${state.openFailure.code}.`}</span>
        <Button variant="outline" size="sm" onClick={() => void view.refresh()}>
          Refresh
        </Button>
      </p>,
    );
  if (state.stale !== null)
    notes.push(
      <p key="stale" className="flex items-center gap-2">
        <WarningIcon />
        <span>
          {staleText(state.stale)} {RESTART}
        </span>
        <Button ref={bindLeaving} variant="outline" size="sm" onClick={() => void view.refresh()}>
          Refresh
        </Button>
      </p>,
    );
  if (state.loadFailure !== null)
    notes.push(
      <p key="load-failure" className="flex items-center gap-2">
        <WarningIcon />
        <span>{`Loading more commits stopped: ${state.loadFailure.code}${state.loadFailure.reason === undefined ? "" : ` ${state.loadFailure.reason}`}. Scroll to the end of the loaded rows to try again.`}</span>
        <Button ref={bindLeaving} variant="outline" size="sm" onClick={view.retry}>
          Retry
        </Button>
      </p>,
    );
  if (state.limit !== null)
    notes.push(
      <p key="limit" className="flex items-center gap-2">
        <WarningIcon />
        <span>{limitText(state.limit.reason)}</span>
      </p>,
    );
  if (state.deadline !== null)
    notes.push(
      <div key="deadline" className="flex flex-wrap items-center gap-2">
        <WarningIcon />
        <span>Loading more commits stopped after 120 seconds. Scroll to the end of the loaded rows to try again. {state.deadline.text}</span>
        {state.deadline.command === null ? null : (
          <>
            <code className="break-all">{state.deadline.command}</code>
            <CopyButton text={state.deadline.command}>Copy command</CopyButton>
          </>
        )}
      </div>,
    );
  if (search !== null) {
    if (search.state === "refused" || search.state === "failed")
      notes.push(
        <div key="refused" className="flex flex-wrap items-center gap-2">
          <WarningIcon />
          <span>{refusedText(search)}</span>
          {search.remedy?.command == null ? null : (
            <>
              <code className="break-all">{search.remedy.command}</code>
              <CopyButton text={search.remedy.command}>Copy command</CopyButton>
            </>
          )}
        </div>,
      );
    if (search.mode === "filter" && (search.state === "running" || search.state === "finished"))
      notes.push(
        <p key="filter" className="flex flex-wrap items-center gap-x-2">
          <span>{`Only commits whose message contains "${search.text}" show.`}</span>
          <span className="text-muted-text">A dashed line skips commits that do not match.</span>
          <span className="text-muted-text">Press Esc to show all commits.</span>
        </p>,
      );
    if (search.state === "finished" && search.matches === 0) notes.push(<p key="none">{NO_MATCH}</p>);
    if (search.state === "finished" && search.shallow) notes.push(<p key="shallow">The search covered only the commits that this shallow clone holds.</p>);
  }
  const matchEnd = state.matchEnd === null ? null : state.matchEnd === "first" ? "No earlier match. This is the first match." : "No later match. This is the last match.";
  if (matchEnd !== null) notes.push(<p key="end">{matchEnd}</p>);
  const waiting = state.waiting ? "Waiting for the search to reach the match…" : null;
  if (waiting !== null) notes.push(<p key="waiting">{waiting}</p>);
  // The live region holds short texts that change only with a state. Counts and buttons stay outside it.
  const announce = [
    state.stale === null ? null : staleText(state.stale),
    state.loadFailure === null ? null : `Loading more commits stopped: ${state.loadFailure.code}.`,
    progress?.text ?? null,
    search !== null && (search.state === "refused" || search.state === "failed") ? refusedText(search) : null,
    search?.state === "finished" && search.matches === 0 ? NO_MATCH : null,
    waiting,
    matchEnd,
  ]
    .filter((t) => t !== null)
    .join(" ");

  const count = countText(search);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h2 id={ids.heading} className="sr-only">
          History
        </h2>
        {state.scope === "current" ? (
          <span data-slot="scope-chip" className="flex shrink-0 items-center gap-1 rounded-sm border border-control-border pl-1.5 whitespace-nowrap">
            <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
            {CHIP_TEXT}
            <IconButton ref={bindLeaving} icon={Cancel01Icon} label="Show all branches" keys={{ aria: "Control+Shift+B", text: "Ctrl+Shift+B" }} onClick={() => onScope("all")} />
          </span>
        ) : null}
        <span id={ids.count} className="min-w-0 truncate text-muted-text">
          {heading()}
        </span>
        <span className="flex-1" />
        {count === null ? null : (
          <span role="status" className="num shrink-0 whitespace-nowrap">
            {count}
          </span>
        )}
        <HistoryFilter
          search={search}
          unavailable={empty ? FILTER_UNAVAILABLE : null}
          describedBy={ids.notes}
          inputRef={filterRef}
          onSearch={(text, mode) => void view.search(text, mode)}
          onClear={() => void view.clearSearch()}
          onMode={(mode) => void view.setMode(mode)}
          onMatch={(direction) => void view.match(direction)}
        />
      </div>
      <p role="status" className="sr-only">
        {announce}
      </p>
      <div id={ids.notes} className="flex shrink-0 flex-col gap-1 px-2 empty:hidden">
        {empty ? <p>{FILTER_UNAVAILABLE}</p> : null}
        {notes}
        {progress === null ? null : (
          <p className="flex items-center gap-2">
            <span>{progress.text}</span>
            <span className="num text-muted-text">{progress.count}</span>
            <Button ref={bindLeaving} variant="outline" size="sm" onClick={progress.cancel}>
              Cancel
            </Button>
          </p>
        )}
      </div>
      <div
        ref={list}
        data-history-list=""
        role="listbox"
        tabIndex={0}
        aria-labelledby={`${ids.heading} ${ids.count}`}
        aria-activedescendant={active >= first && active <= last ? optionId(active) : undefined}
        className="relative overflow-y-auto px-1"
        style={{ flex: "1 1 0", minHeight: rowHeight }}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <div role="presentation" className="relative" style={{ height: scrollHeightOf(total, rowHeight) }}>
          {items}
        </div>
      </div>
    </div>
  );
}
