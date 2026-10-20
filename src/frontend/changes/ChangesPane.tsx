// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowRight01Icon, Folder01Icon, ListIcon, ListTreeIcon, MinusSignIcon, PlusSignIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from "react";
import type { ChangeEntry } from "../../contracts/envelope";
import { useCopy } from "../app/RepositoryStates";
import { ActionMenu, type ActionItem } from "../components/action-menu";
import { ConfirmPopover } from "../components/confirm-popover";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { RunningTooltip } from "../components/running-tooltip";
import { matches } from "../components/switcher-popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { KEYS } from "../keyboard/shortcuts";
import { Splitter } from "../layout/Splitter";
import { GIT_SEPARATORS, splitPath } from "../lib/path";
import { CUT_REASON, IGNORE_LABEL, LIMIT_TEXT, TARGET_TEXT, type FileActions, type IgnoreReview, type IgnoreTarget } from "./file-actions";
import { changesRows, derivedRequest, formatCount, overLimit, stagedRows, type FilesRequest, type Layout, type TreeRow } from "./file-tree";

// plan.md "Task flow and command placement", "Long text", "Keyboard and focus" (Roles, File list, Stage key row), and "Required visible states" (No selection, Empty/clean).
// Feature 004 plan.md D8, D15 ("Commit view layout", "Virtual tree", "Limited status", "Multi-select", "Row and hunk buttons", "Ignore items"), spec FR-029 to FR-040, FR-045, FR-086.

type Category = ChangeEntry["category"];
type ListName = "changes" | "staged";

export const HELP_LINE = "Arrow keys show a file. Space stages or unstages it.";
export const BUSY_REASON = "A file action is running. Wait for its result.";
// Feature 004 plan.md D15 "Commit view texts".
export const SHOW_FOLDER_REASON = "Show in Explorer takes one file. Select a file in the folder.";
export const cutHeading = (n: number) => `At least ${formatCount(n)} untracked files. Git lists more than Arbareto reads.`;
export const FILTER_FILES = "Filter files";
export const NO_FILE_MATCH = "No file matches the filter.";

/** Feature 003 FR-052: `resolve` is Mark resolved of a Conflicted entry. */
export type FileDirection = "stage" | "unstage" | "resolve";
export type FileAction = { direction: FileDirection; comparisonId: string; entryId: string };
/** The T202 `runFileAction` result. `text` of a refusal is the full status bar sentence. */
export type FileActionResult = { state: "succeeded" } | { state: "failed" } | { state: "refused"; text: string };
/** The selected entry and the ID of its shown comparison. `comparisonId` is null while its read is pending. */
export type PaneSelection = { entryId: string; comparisonId: string | null } | null;

/** The multi-file, ignore, and reveal actions of feature 004. Without them, the lists show no header or folder action. */
export type FilesProps = {
  actions: Pick<FileActions, "run" | "reviewIgnore" | "runIgnore" | "reveal">;
  /** The reason that blocks every multi-file and ignore action, or null. */
  reason: string | null;
  /** A mutation runs. The reason then goes only into the tooltip and the accessible description (plan.md D15). */
  running: boolean;
  /** Contract Δ4 "Status cut" `untracked`. */
  cut: boolean;
};

export type ChangesPaneProps = {
  /** The entries of the latest snapshot, in service order. */
  entries: readonly ChangeEntry[];
  selection: PaneSelection;
  /** Selects an entry and starts its comparison read. */
  onSelect(entryId: string): void;
  /** Clears the selection, so the diff shows its empty state (spec FR-101). */
  onClearSelection?(): void;
  /** The Filter files field. Ctrl+F focuses it in the Commit view (plan D15 keyboard map). */
  filterRef?: Ref<HTMLInputElement>;
  /** The T202 `runFileAction`. */
  onFileAction(action: FileAction): Promise<FileActionResult>;
  /** Feeds the T145 reason line. Null clears it. */
  onReason?(text: string | null): void;
  /** Feeds the second live element of the status bar. Null clears it. */
  onStatus?(text: string | null): void;
  fileActionRunning?: boolean;
  operationRunning?: boolean;
  modalOpen?: boolean;
  menuOpen?: boolean;
  /** A new object after each T202 toolbar button success. */
  toolbarSuccess?: { entryId: string } | null;
  /** True only when the snapshot is a complete observation with every page loaded. */
  complete?: boolean;
  /** The Changes help line. */
  helpLine?: string;
  /** True in a file band: Changes and Staged sit side by side (plan.md "Chosen layout, sizes, and DPI"). */
  sideBySide?: boolean;
  /** The T202 file controls. The stage bar between Changes and Staged holds them. */
  stageBar?: ReactNode;
  /** The fixed row height in DIPs (plan.md density table). */
  rowHeight?: number;
  /** Data-model §14: the layout and the Untracked state of the window session. Without them, the pane keeps its own. */
  layout?: Layout;
  onLayout?(layout: Layout): void;
  untrackedOpen?: boolean;
  onUntrackedOpen?(open: boolean): void;
  files?: FilesProps;
};

// The compact file row height (plan.md density table).
const ROW_HEIGHT = 26;
// shortcut: plain rows up to this count, as the 001 list did. TanStack Virtual takes larger lists (plan.md "Keyboard and focus").
const VIRTUAL_MIN = 200;
const listOf = (category: Category): ListName => (category === "staged" ? "staged" : "changes");
const directionOf = (category: Category): FileDirection => (category === "staged" ? "unstage" : category === "conflicted" ? "resolve" : "stage");
const ROW_LABEL: Record<FileDirection, string> = { stage: "Stage file", unstage: "Unstage file", resolve: "Mark resolved" };

type ListHandle = { focusEntry(entryId: string): void; focusHeading(): void };
type Marked = { list: ListName; ids: ReadonlySet<string>; anchor: string };

/** plan.md Stage key row order: the next surviving file row, then the previous one, else null for the list heading. */
function survivor(list: readonly ChangeEntry[], entryId: string, alive: ReadonlySet<string>): ChangeEntry | null {
  const index = list.findIndex((e) => e.entryId === entryId);
  if (index < 0) return null;
  const ok = (e: ChangeEntry) => e.entryId !== entryId && alive.has(e.entryId);
  for (let i = index + 1; i < list.length; i++) if (ok(list[i]!)) return list[i]!;
  for (let i = index - 1; i >= 0; i--) if (ok(list[i]!)) return list[i]!;
  return null;
}
const filesOf = (rows: readonly TreeRow[]) => rows.flatMap((r) => (r.kind === "file" ? [r.entry] : []));

export function ChangesPane(props: ChangesPaneProps) {
  const { entries, selection, fileActionRunning = false, operationRunning = false, toolbarSuccess = null, complete = false, helpLine = HELP_LINE, sideBySide = false, stageBar, rowHeight = ROW_HEIGHT, files } = props;
  const live = useRef(props);
  live.current = props;
  const [ownLayout, setOwnLayout] = useState<Layout>("tree");
  const [ownOpen, setOwnOpen] = useState(false);
  const layout = props.layout ?? ownLayout;
  const untrackedOpen = props.untrackedOpen ?? ownOpen;
  const setLayout = (next: Layout) => (props.onLayout ? props.onLayout(next) : setOwnLayout(next));
  const setUntrackedOpen = (next: boolean) => (props.onUntrackedOpen ? props.onUntrackedOpen(next) : setOwnOpen(next));
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [marked, setMarked] = useState<Marked | null>(null);
  const [menu, setMenu] = useState<{ row: TreeRow; list: ListName; anchor: HTMLElement; byKey: boolean } | null>(null);
  const [ignore, setIgnore] = useState<{ review: Extract<IgnoreReview, { ok: true }>; anchor: HTMLElement } | null>(null);
  const copy = useCopy();
  // Spec FR-101: Filter files filters only the shown rows. The derived actions and every count keep the status read.
  const [query, setQuery] = useState("");

  // The rows build from the entries of this snapshot. The Untracked rows build only while the section is open (plan.md D15).
  const rows = useMemo(() => {
    const keep = query === "" ? undefined : (e: ChangeEntry) => matches(e.path, query);
    return { changes: changesRows(entries, layout, toggled, untrackedOpen, keep), staged: stagedRows(entries, layout, toggled, keep) };
  }, [entries, layout, toggled, untrackedOpen, query]);
  const lists = useRef<Partial<Record<ListName, ListHandle>>>({});
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pending = useRef<string | null>(null);
  const running = useRef(false);
  const reasonShown = useRef<string | null>(null);
  const statusShown = useRef(false);
  const focused = useRef<ChangeEntry | null>(null);
  const previous = useRef({ entries, rows });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);

  // Data-model §14: a new snapshot keeps the marked entries whose IDs still exist.
  const alive = useMemo(() => new Map(entries.map((e) => [e.entryId, e])), [entries]);
  // One pass per snapshot for each derived set, so a key press does no work over 100,000 entries (spec SC-007).
  const derived = useMemo(
    () => ({ changes: derivedRequest(entries, "all-changes"), untracked: derivedRequest(entries, "all-untracked"), staged: derivedRequest(entries, "all-staged") }),
    [entries],
  );
  // Spec FR-101: a row that the filter hides leaves the selection.
  const shownMarks = marked === null ? null : { ...marked, ids: new Set([...marked.ids].filter((id) => alive.has(id) && (query === "" || matches(alive.get(id)!.path, query)))) };
  const onQuery = (next: string) => {
    setQuery(next);
    // Spec FR-101: a row that the filter hides leaves the selection. No other file gets selected.
    const selected = live.current.selection === null ? undefined : alive.get(live.current.selection.entryId);
    if (next !== "" && selected !== undefined && !matches(selected.path, next)) live.current.onClearSelection?.();
    if (next !== "") setMarked((m) => (m === null ? m : { ...m, ids: new Set([...m.ids].filter((id) => !alive.has(id) || matches(alive.get(id)!.path, next))) }));
  };

  const reason = (text: string | null) => {
    if (text === null && reasonShown.current === null) return;
    reasonShown.current = text;
    live.current.onReason?.(text);
  };
  const status = (text: string | null) => {
    if (text === null && !statusShown.current) return;
    statusShown.current = text !== null;
    live.current.onStatus?.(text);
  };

  // Moves focus to the next file row, the previous file row, or the list heading. `select` also selects that entry.
  function moveFrom(entry: ChangeEntry, list: readonly ChangeEntry[], select: boolean) {
    const target = survivor(list, entry.entryId, new Set(live.current.entries.map((e) => e.entryId)));
    const handle = lists.current[listOf(entry.category)];
    if (target === null) return handle?.focusHeading();
    if (select) live.current.onSelect(target.entryId);
    handle?.focusEntry(target.entryId);
  }

  async function run(entry: ChangeEntry, comparisonId: string) {
    const list = filesOf(rows[listOf(entry.category)]);
    running.current = true;
    let result: FileActionResult;
    try {
      result = await live.current.onFileAction({ direction: directionOf(entry.category), comparisonId, entryId: entry.entryId });
    } finally {
      running.current = false;
    }
    if (!mounted.current) return;
    if (reasonShown.current === BUSY_REASON) reason(null);
    if (result.state === "succeeded") moveFrom(entry, list, true);
    else if (result.state === "refused") {
      reason(result.text);
      if (!live.current.operationRunning) status(result.text);
    }
  }

  /** The 001 Stage key on one file: select first, then act on its comparison. A row button takes the same path. */
  function actOnEntry(entry: ChangeEntry) {
    const p = live.current;
    if (p.fileActionRunning || running.current) return reason(BUSY_REASON);
    if (p.selection?.entryId !== entry.entryId) {
      pending.current = entry.entryId;
      return p.onSelect(entry.entryId);
    }
    if (p.selection.comparisonId === null) pending.current = entry.entryId;
    else void run(entry, p.selection.comparisonId);
  }

  // A pending Space runs when its comparison arrives. Another selection cancels it.
  useEffect(() => {
    reason(null);
    status(null);
    const id = pending.current;
    if (id === null) return;
    if (selection?.entryId !== id) return void (pending.current = null);
    if (selection.comparisonId === null) return;
    pending.current = null;
    const entry = live.current.entries.find((e) => e.entryId === id);
    if (entry) void run(entry, selection.comparisonId);
  }, [selection?.entryId, selection?.comparisonId]);

  useEffect(() => {
    if (!fileActionRunning && !running.current && reasonShown.current === BUSY_REASON) reason(null);
  }, [fileActionRunning]);
  useEffect(() => {
    if (operationRunning) status(null);
  }, [operationRunning]);

  useEffect(() => {
    if (toolbarSuccess === null) return;
    const entry = live.current.entries.find((e) => e.entryId === toolbarSuccess.entryId) ?? previous.current.entries.find((e) => e.entryId === toolbarSuccess.entryId);
    if (!entry) return;
    const source = live.current.entries.some((e) => e.entryId === entry.entryId) ? rows : previous.current.rows;
    moveFrom(entry, filesOf(source[listOf(entry.category)]), true);
  }, [toolbarSuccess]);

  // A hunk action or an external change removed the focused entry: focus a survivor or the heading, without a selection change.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { entries, rows };
    const lost = focused.current;
    if (before.entries === entries || lost === null || entries.some((e) => e.entryId === lost.entryId)) return;
    focused.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    moveFrom(lost, filesOf(before.rows[listOf(lost.category)]), false);
  }, [entries]);

  const onFocus = (event: ReactFocusEvent) => {
    const item = (event.target as Element).closest?.('[role="treeitem"]') as HTMLElement | null;
    const id = item?.dataset.entryId;
    focused.current = id === undefined ? null : (live.current.entries.find((e) => e.entryId === id) ?? null);
    if (pending.current !== null && id !== pending.current) pending.current = null;
    reason(null);
    status(null);
  };
  const onBlur = (event: ReactFocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next !== null && !root.current?.contains(next)) {
      pending.current = null;
      reason(null);
      status(null);
    }
  };

  // Feature 004 plan.md D8 and spec FR-034 to FR-040: the multi-file actions. Each binds the shown read.
  const filesReason = (request: FilesRequest): string | null => {
    if (files === undefined) return null;
    if (files.running) return files.reason;
    if (files.cut && request.kind !== "selected" && request.direction === "stage") return CUT_REASON;
    if (files.reason !== null) return files.reason;
    if (request.entryIds.length === 0) return null;
    return overLimit(request) ? LIMIT_TEXT : null;
  };
  // A refused action sends nothing. A reason that the control did not show yet goes to the status bar.
  async function runFiles(request: FilesRequest, label: string) {
    if (files === undefined || request.entryIds.length === 0 || running.current || live.current.fileActionRunning) return;
    const why = filesReason(request);
    if (why !== null) return void (files.running || status(`${label} is unavailable: ${why}`));
    running.current = true;
    try {
      const response = await files.actions.run(request);
      if (mounted.current && response?.state === "succeeded") setMarked(null);
    } finally {
      running.current = false;
    }
  }
  const selectedRequest = (list: ListName, ids: readonly string[]): FilesRequest => ({ direction: list === "staged" ? "unstage" : "stage", kind: "selected", entryIds: ids as string[] });
  const selectedLabel = (list: ListName, n: number) => `${list === "staged" ? "Unstage" : "Stage"} selected (${formatCount(n)})`;
  const folderLabel = (list: ListName) => (list === "staged" ? "Unstage folder" : "Stage folder");
  // The folder row button shows the reasons that need no entry count. The count limit refuses at the action (runFiles).
  const folderReason = (list: ListName) => (files === undefined ? null : files.running ? files.reason : list === "changes" && files.cut ? CUT_REASON : files.reason);
  const folderRequest = (row: Extract<TreeRow, { kind: "folder" }>, list: ListName) => derivedRequest(entries, "folder", { folder: row.folder, direction: list === "staged" ? "unstage" : "stage" });

  function onSpace(row: TreeRow, list: ListName, event: ReactKeyboardEvent) {
    const p = live.current;
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.repeat || event.nativeEvent.isComposing || p.modalOpen || p.menuOpen) return;
    event.preventDefault();
    if (row.kind === "folder") return void runFiles(folderRequest(row, list), folderLabel(list));
    if (row.kind === "section") return void runFiles(derived.untracked, "Stage all untracked");
    // Plan.md D15 "Multi-select": Space acts on the selection when it holds more than one entry.
    const marks = shownMarks?.list === list ? shownMarks.ids : null;
    if (marks !== null && marks.size > 1 && marks.has(row.entry.entryId)) return void runFiles(selectedRequest(list, [...marks]), selectedLabel(list, marks.size));
    actOnEntry(row.entry);
  }

  async function startIgnore(row: TreeRow, target: IgnoreTarget, anchor: HTMLElement) {
    if (files === undefined || row.kind === "section") return;
    const entry = row.kind === "file" ? row.entry : entries.find((e) => e.category === "untracked" && atob(e.pathBytes).startsWith(`${atob(row.folder)}/`));
    if (entry === undefined) return;
    const review = await files.actions.reviewIgnore(entry.entryId, target, row.kind === "folder" ? row.folder : undefined);
    if (!mounted.current) return;
    if (review.ok) setIgnore({ review, anchor });
    else status(review.text);
  }

  function menuGroups(row: TreeRow, list: ListName, anchor: HTMLElement): ActionItem[][] {
    if (row.kind === "section") return [[{ label: "Stage all untracked", keys: KEYS.stageEntry, reason: filesReason(derived.untracked), onSelect: () => void runFiles(derived.untracked, "Stage all untracked") }]];
    const first: ActionItem[] = [];
    if (row.kind === "file") {
      const direction = directionOf(row.entry.category);
      first.push({ label: ROW_LABEL[direction], keys: KEYS.stageEntry, onSelect: () => actOnEntry(row.entry) });
    } else if (files !== undefined) {
      const request = folderRequest(row, list);
      first.push({ label: folderLabel(list), keys: KEYS.stageEntry, reason: filesReason(request), onSelect: () => void runFiles(request, folderLabel(list)) });
    }
    const untracked = row.kind === "file" ? row.entry.category === "untracked" : row.untracked;
    const groups = [first];
    if (untracked && files !== undefined) {
      groups.push((["gitignore", "exclude"] as const).map((target) => ({ label: IGNORE_LABEL[target], reason: files.reason, onSelect: () => void startIgnore(row, target, anchor) })));
    }
    const path = row.kind === "file" ? row.entry.path : row.path;
    const last: ActionItem[] = [{ label: "Copy path", onSelect: () => copy(path) }];
    if (files !== undefined) last.push({ label: "Show in Explorer", reason: row.kind === "folder" ? SHOW_FOLDER_REASON : null, onSelect: () => row.kind === "file" && files.actions.reveal(row.entry.entryId) });
    groups.push(last);
    return groups.filter((g) => g.length > 0);
  }

  const listProps = (list: ListName) => ({
    list,
    rows: rows[list],
    rowHeight,
    selectedId: selection?.entryId ?? null,
    marks: shownMarks?.list === list ? shownMarks.ids : null,
    files,
    filesReason,
    folderReason: folderReason(list),
    register: (handle: ListHandle | null) => void (handle ? (lists.current[list] = handle) : delete lists.current[list]),
    onSelect: (entry: ChangeEntry) => {
      setMarked(null);
      if (live.current.selection?.entryId !== entry.entryId) live.current.onSelect(entry.entryId);
    },
    onMark: (entry: ChangeEntry, mode: "toggle" | "range", visible: readonly ChangeEntry[]) => {
      const current = shownMarks?.list === list ? shownMarks : null;
      const base = current?.ids ?? new Set(live.current.selection !== null && visible.some((e) => e.entryId === live.current.selection!.entryId) ? [live.current.selection.entryId] : []);
      const anchor = current?.anchor ?? live.current.selection?.entryId ?? entry.entryId;
      let ids: Set<string>;
      if (mode === "toggle") {
        ids = new Set(base);
        if (ids.has(entry.entryId)) ids.delete(entry.entryId);
        else ids.add(entry.entryId);
      } else {
        const a = visible.findIndex((e) => e.entryId === anchor);
        const b = visible.findIndex((e) => e.entryId === entry.entryId);
        ids = new Set(a < 0 ? [entry.entryId] : visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((e) => e.entryId));
      }
      setMarked({ list, ids, anchor: mode === "toggle" ? entry.entryId : anchor });
      if (live.current.selection?.entryId !== entry.entryId && ids.has(entry.entryId)) live.current.onSelect(entry.entryId);
    },
    onSpace,
    onToggle: (row: TreeRow, open?: boolean) => {
      if (row.kind === "file") return;
      const next = open ?? !row.expanded;
      if (next === row.expanded) return;
      if (row.kind === "section") return setUntrackedOpen(next);
      setToggled((t) => {
        const copy = new Set(t);
        if (copy.has(row.key)) copy.delete(row.key);
        else copy.add(row.key);
        return copy;
      });
    },
    onMenu: (row: TreeRow, anchor: HTMLElement, byKey = false) => setMenu({ row, list, anchor, byKey }),
    onRowAction: (row: TreeRow) => {
      if (row.kind === "file") actOnEntry(row.entry);
      else if (row.kind === "folder") void runFiles(folderRequest(row, list), folderLabel(list));
      else void runFiles(derived.untracked, "Stage all untracked");
    },
  });

  const changes = rows.changes;
  const working = derived.changes.entryIds.length;
  const stagedCount = derived.staged.entryIds.length;
  const changesMarks = shownMarks?.list === "changes" ? shownMarks.ids : null;
  const untrackedReason = derived.untracked.entryIds.length === 0 ? null : filesReason(derived.untracked);
  const untrackedReasonId = useId();
  const helpId = useId();
  const stagedMarks = shownMarks?.list === "staged" ? shownMarks.ids : null;
  const untrackedCount = changes.find((r) => r.kind === "section")?.count ?? 0;

  // Splitter between Changes and Staged: the Staged size in DIPs, measured from the pane, for the window session.
  const [stagedSize, setStagedSize] = useState<number | null>(null);
  const [box, setBox] = useState(0);
  useLayoutEffect(() => {
    const element = body.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setBox(sideBySide ? element.clientWidth : element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sideBySide]);
  const minPane = rowHeight * 3;
  const staged = stagedSize ?? Math.round(box / 2);

  // The no-match line shows only when no hidden row can match: a collapsed Untracked section creates no rows (spec FR-030).
  const collapsed = rows.changes.some((r) => r.kind === "section" && !r.expanded);
  const noMatch = query !== "" && entries.length > 0 && !collapsed && rows.staged.length === 0 && rows.changes.every((r) => r.kind === "section");

  return (
    <div ref={root} data-slot="changes-workspace" className="flex h-full min-h-0 flex-1 flex-col" onFocus={onFocus} onBlur={onBlur}>
      {/* Plan D15 "Filter files": one field above the Changes and Staged trees. */}
      <div className="relative flex shrink-0 items-center px-2 pt-2">
        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" className="pointer-events-none absolute left-4 size-(--icon-size) text-muted-text" />
        <Tooltip>
          <TooltipTrigger
            render={
              <input
                ref={props.filterRef}
                type="text"
                aria-label={FILTER_FILES}
                aria-keyshortcuts="Control+F"
                placeholder={FILTER_FILES}
                spellCheck={false}
                autoComplete="off"
                className="h-(--h-button) w-full rounded-sm border border-control-border bg-surface pr-2 pl-8"
                value={query}
                onChange={(event) => onQuery(event.target.value)}
              />
            }
          />
          <TooltipContent>{`${FILTER_FILES} (Ctrl+F)`}</TooltipContent>
        </Tooltip>
      </div>
      {/* A live region announces only a change of its content, so the region stays while the text comes and goes. */}
      <p role="status" className={`shrink-0 px-2 text-muted-text ${noMatch ? "pt-1" : ""}`}>
        {noMatch ? NO_FILE_MATCH : null}
      </p>
      <div ref={body} data-slot="changes-pane" className={`flex min-h-0 flex-1 ${sideBySide ? "flex-row" : "flex-col"}`}>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <ListHeading level={2} label="Changes" count={working} rowHeight={rowHeight}>
            {files === undefined ? null : (
              <>
                {changesMarks !== null && changesMarks.size > 1 ? (
                  <FilesButton label={selectedLabel("changes", changesMarks.size)} keys={KEYS.stageEntry} request={selectedRequest("changes", [...changesMarks])} reasonOf={filesReason} running={files.running} onRun={runFiles} />
                ) : null}
                <FilesButton label="Stage all changes" request={derived.changes} reasonOf={filesReason} running={files.running} onRun={runFiles} />
              </>
            )}
            <span role="group" aria-label="Layout" className="flex items-center">
              <IconButton icon={ListTreeIcon} label="Tree layout" aria-pressed={layout === "tree"} onClick={() => setLayout("tree")} />
              <IconButton icon={ListIcon} label="Flat layout" aria-pressed={layout === "flat"} onClick={() => setLayout("flat")} />
            </span>
          </ListHeading>
          {complete && working === 0 ? <p className="px-2 text-muted-text">Working tree clean</p> : null}
          {/* Plan D15 "Commit view texts": the sidebar shows no help line. The text stays the description of the Changes tree. */}
          <p id={helpId} hidden>
            {helpLine}
          </p>
          {untrackedReason === null ? null : (
            <p id={untrackedReasonId} data-slot="files-reason" hidden={files?.running} className="shrink-0 px-2 text-muted-text">
              {`Stage all untracked is unavailable: ${untrackedReason}`}
            </p>
          )}
          <TreeList {...listProps("changes")} label="Changes" describedBy={helpId} layout={layout} cut={files?.cut === true} untrackedCount={untrackedCount} section={{ reason: untrackedReason, reasonId: untrackedReasonId }} />
        </section>
        {stageBar === undefined || stageBar === null ? null : (
          // plan.md "Section minima": one row-button row. In a file band, the bar stands between the two lists.
          <div className={`flex shrink-0 gap-2 border-divider px-2 ${sideBySide ? "flex-col justify-center border-l" : "items-center border-t"}`} style={{ minHeight: "var(--h-stage-bar)" }}>
            {stageBar}
          </div>
        )}
        {box > minPane * 2 ? (
          <Splitter
            label="Resize Changes and Staged"
            orientation={sideBySide ? "vertical" : "horizontal"}
            value={staged}
            min={minPane}
            max={box - minPane}
            reverse
            onChange={setStagedSize}
          />
        ) : null}
        <section
          data-section="staged"
          className={`flex min-h-0 min-w-0 flex-col overflow-y-auto border-divider ${sideBySide ? "border-l" : "border-t"} ${box > minPane * 2 ? "shrink-0" : "flex-1"}`}
          style={box > minPane * 2 ? { flexBasis: staged } : undefined}
        >
          <ListHeading level={2} label="Staged" count={stagedCount} rowHeight={rowHeight}>
            {files === undefined ? null : (
              <>
                {stagedMarks !== null && stagedMarks.size > 1 ? (
                  <FilesButton label={selectedLabel("staged", stagedMarks.size)} keys={KEYS.stageEntry} request={selectedRequest("staged", [...stagedMarks])} reasonOf={filesReason} running={files.running} onRun={runFiles} />
                ) : null}
                <FilesButton label="Unstage all" request={derived.staged} reasonOf={filesReason} running={files.running} onRun={runFiles} />
              </>
            )}
          </ListHeading>
          <TreeList {...listProps("staged")} label="Staged" layout={layout} cut={false} untrackedCount={0} section={null} />
        </section>
      </div>
      {menu === null ? null : (
        <ActionMenu label={menu.row.kind === "file" ? menu.row.entry.path : menu.row.kind === "folder" ? menu.row.path : "Untracked"} groups={menuGroups(menu.row, menu.list, menu.anchor)} open anchor={menu.anchor} byKey={menu.byKey} onOpenChange={(open) => !open && setMenu(null)} finalFocus={() => menu.anchor} />
      )}
      {ignore === null ? null : (
        <ConfirmPopover
          open
          anchor={ignore.anchor}
          title={`${IGNORE_LABEL[ignore.review.target]}?`}
          confirmLabel="Add line"
          onCancel={() => setIgnore(null)}
          onConfirm={() => {
            const review = ignore.review;
            setIgnore(null);
            void files?.actions.runIgnore(review);
          }}
        >
          <p>{`Arbareto adds this line to ${TARGET_TEXT[ignore.review.target]}:`}</p>
          <code data-slot="ignore-line" className="block break-all select-text">
            {ignore.review.line}
          </code>
        </ConfirmPopover>
      )}
    </div>
  );
}

function ListHeading({ level, label, count, rowHeight, children }: { level: 2 | 3; label: string; count: number; rowHeight: number; children?: ReactNode }) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
      <Heading tabIndex={-1} data-list-heading={label} className="flex items-center gap-2 font-semibold" style={{ minHeight: rowHeight }}>
        <span>{label}</span>
        <span className="num text-muted-text">{formatCount(count)}</span>
      </Heading>
      <span className="ml-auto flex flex-wrap items-center gap-1">{children}</span>
    </div>
  );
}

type FilesButtonProps = { label: string; keys?: { aria: string; text: string }; request: FilesRequest; reasonOf(request: FilesRequest): string | null; running: boolean; onRun(request: FilesRequest, label: string): void };

/** A list header action. Plan.md D15: a reason because an operation runs goes only into the tooltip and the accessible description. */
function FilesButton({ label, keys, request, reasonOf, running, onRun }: FilesButtonProps) {
  const reasonId = useId();
  // An empty set has nothing to act on, so the action does not show.
  if (request.entryIds.length === 0) return null;
  const reason = reasonOf(request);
  return (
    <>
      <RunningTooltip reason={running ? reason : null}>
        <Button
          variant="outline"
          size="sm"
          aria-keyshortcuts={keys?.aria}
          disabled={reason !== null}
          focusableWhenDisabled
          aria-describedby={reason === null ? undefined : reasonId}
          onClick={() => reason === null && onRun(request, label)}
        >
          {label}
        </Button>
      </RunningTooltip>
      {reason === null ? null : (
        <span id={reasonId} data-slot="files-reason" hidden={running} className="basis-full text-muted-text">
          {`${label} is unavailable: ${reason}`}
        </span>
      )}
    </>
  );
}

type TreeListProps = {
  list: ListName;
  label: string;
  /** The ID of the help line that describes the list. */
  describedBy?: string;
  rows: readonly TreeRow[];
  layout: Layout;
  rowHeight: number;
  selectedId: string | null;
  marks: ReadonlySet<string> | null;
  files?: FilesProps;
  cut: boolean;
  untrackedCount: number;
  /** The Stage all untracked reason and the ID of its line. */
  section: { reason: string | null; reasonId: string } | null;
  filesReason(request: FilesRequest): string | null;
  folderReason: string | null;
  register(handle: ListHandle | null): void;
  onSelect(entry: ChangeEntry): void;
  onMark(entry: ChangeEntry, mode: "toggle" | "range", visible: readonly ChangeEntry[]): void;
  onSpace(row: TreeRow, list: ListName, event: ReactKeyboardEvent): void;
  onToggle(row: TreeRow, open?: boolean): void;
  onMenu(row: TreeRow, anchor: HTMLElement, byKey?: boolean): void;
  onRowAction(row: TreeRow): void;
};

/** One list: a WAI-ARIA tree with one Tab stop, roving focus, and multi-select. TanStack Virtual renders only the rows near the view (spec FR-086). */
function TreeList({ list, label, describedBy, rows, layout, rowHeight, selectedId, marks, files, cut, untrackedCount, section, folderReason, register, onSelect, onMark, onSpace, onToggle, onMenu, onRowAction }: TreeListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const toFocus = useRef<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const index = (key: string | null) => (key === null ? -1 : rows.findIndex((r) => r.key === key));
  // The Tab stop: the last focused row, else the selected file of this list, else the first row.
  const activeIndex = index(activeKey) >= 0 ? index(activeKey) : index(selectedId) >= 0 ? index(selectedId) : rows.length > 0 ? 0 : -1;
  const visibleFiles = useMemo(() => filesOf(rows), [rows]);

  const virtual = rows.length > VIRTUAL_MIN;
  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: virtual,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    getItemKey: (i) => rows[i]!.key,
    overscan: 8,
    // The focused row stays mounted (plan.md "Keyboard and focus").
    rangeExtractor: (range) => {
      const shown = defaultRangeExtractor(range);
      return activeIndex < 0 || shown.includes(activeIndex) ? shown : [...shown, activeIndex].sort((a, b) => a - b);
    },
  });

  function focusKey(key: string) {
    const i = index(key);
    if (i < 0) return;
    setActiveKey(key);
    const element = elements.current.get(key);
    if (element) return element.focus();
    toFocus.current = key;
    if (virtual) virtualizer.scrollToIndex(i);
  }
  useLayoutEffect(() => {
    const key = toFocus.current;
    const element = key === null ? undefined : elements.current.get(key);
    if (!element) return;
    toFocus.current = null;
    element.focus();
  });
  const heading = () => scroller.current?.parentElement?.querySelector<HTMLElement>("[data-list-heading]") ?? null;
  const handle = useRef<ListHandle>({ focusEntry: focusKey, focusHeading: () => heading()?.focus() });
  handle.current.focusEntry = focusKey;
  useEffect(() => {
    register(handle.current);
    return () => register(null);
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const item = (event.target as HTMLElement).closest('[role="treeitem"]') as HTMLElement | null;
    const at = index(item?.dataset.key ?? null);
    if (at < 0) return;
    const row = rows[at]!;
    // Space and Enter act only on the row itself, never on a button inside it.
    if (event.key === " " || event.key === "Enter") {
      if (event.target !== item) return;
      if (event.key === " ") return onSpace(row, list, event);
      event.preventDefault();
      if (row.kind === "file") onSelect(row.entry);
      else onToggle(row);
      return;
    }
    if ((event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.altKey) || (event.key === "ContextMenu" && !event.shiftKey)) {
      event.preventDefault();
      return onMenu(row, item!, true);
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.shiftKey && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!event.shiftKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      if (row.kind === "file" && event.key === "ArrowRight") return;
      event.preventDefault();
      if (event.key === "ArrowRight") return row.kind !== "file" && !row.expanded ? onToggle(row, true) : focusKey(rows[at + 1]?.key ?? row.key);
      if (row.kind !== "file" && row.expanded) return onToggle(row, false);
      // ArrowLeft on a child moves to its parent row.
      for (let i = at - 1; i >= 0; i--) if (rows[i]!.depth < row.depth) return focusKey(rows[i]!.key);
      return;
    }
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / rowHeight));
    const to =
      event.key === "ArrowDown" ? at + 1
      : event.key === "ArrowUp" ? at - 1
      : event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
      : event.key === "PageDown" ? at + page
      : event.key === "PageUp" ? at - page
      : null;
    if (to === null) return;
    event.preventDefault();
    const target = rows[Math.min(rows.length - 1, Math.max(0, to))]!;
    focusKey(target.key);
    if (target.kind !== "file") return;
    // Plan.md D15 "Multi-select": Shift+Up and Shift+Down extend the selection. A plain key moves it (plan.md "Keyboard and focus", File list row).
    if (event.shiftKey) onMark(target.entry, "range", visibleFiles);
    else onSelect(target.entry);
  }

  function onClick(row: TreeRow, event: ReactMouseEvent) {
    setActiveKey(row.key);
    if (row.kind !== "file") return onToggle(row);
    if (event.ctrlKey || event.metaKey) return onMark(row.entry, "toggle", visibleFiles);
    if (event.shiftKey) return onMark(row.entry, "range", visibleFiles);
    onSelect(row.entry);
  }

  // The rows get stable handlers that read the newest render, so an unchanged row skips its render (`memo`).
  const latest = useRef({ onClick, onMenu, onRowAction });
  latest.current = { onClick, onMenu, onRowAction };
  const [events] = useState<RowEvents>(() => ({
    ref: (key, element) => void (element ? elements.current.set(key, element) : elements.current.delete(key)),
    focus: (row) => setActiveKey(row.key),
    click: (row, event) => latest.current.onClick(row, event),
    menu: (row, event) => {
      event.preventDefault();
      setActiveKey(row.key);
      latest.current.onMenu(row, event.currentTarget);
    },
    action: (row) => latest.current.onRowAction(row),
  }));
  const items = virtual ? virtualizer.getVirtualItems() : rows.map((_, index) => ({ index, start: index * rowHeight }));
  return (
    <div
      ref={scroller}
      data-file-tree={list}
      role="tree"
      aria-label={label}
      aria-describedby={describedBy}
      aria-multiselectable="true"
      className="relative min-h-(--h-row) flex-1 overflow-y-auto px-1"
      onKeyDown={onKeyDown}
    >
      {rows.length === 0 ? null : (
        <div role="presentation" className="relative" style={{ height: virtual ? virtualizer.getTotalSize() : rows.length * rowHeight }}>
          {items.map((item) => {
            const row = rows[item.index]!;
            return (
              <Row
                key={row.key}
                row={row}
                list={list}
                layout={layout}
                sectionReason={section?.reason ?? null}
                sectionReasonId={section?.reasonId}
                folderReason={folderReason}
                selected={row.kind === "file" && (marks !== null && marks.size > 0 ? marks.has(row.entry.entryId) : row.entry.entryId === selectedId)}
                tabStop={item.index === activeIndex}
                cut={cut}
                untrackedCount={untrackedCount}
                hasFiles={files !== undefined}
                top={item.start}
                height={rowHeight}
                events={events}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The row handlers of one list. The object stays the same for the life of the list. */
type RowEvents = {
  ref(key: string, element: HTMLElement | null): void;
  focus(row: TreeRow): void;
  click(row: TreeRow, event: ReactMouseEvent<HTMLElement>): void;
  menu(row: TreeRow, event: ReactMouseEvent<HTMLElement>): void;
  action(row: TreeRow): void;
};

type RowProps = {
  row: TreeRow;
  list: ListName;
  layout: Layout;
  /** The Stage all untracked reason and the ID of its line. */
  sectionReason: string | null;
  sectionReasonId?: string;
  folderReason: string | null;
  selected: boolean;
  tabStop: boolean;
  cut: boolean;
  untrackedCount: number;
  hasFiles: boolean;
  top: number;
  height: number;
  events: RowEvents;
};

// The status letter of the list from the porcelain v2 `XY` field (git-status(1)).
function letter(entry: ChangeEntry): string {
  if (entry.category === "untracked") return "?";
  if (entry.category === "conflicted") return "U";
  const xy = entry.xy ?? "..";
  return (entry.category === "staged" ? xy[0] : xy[1]) ?? "";
}

// Plan D16 "Geometry": M in Warning text, A and ? in Added text, D in Removed text, other letters in Text. The letter is text, so color is never the only cue.
const LETTER_COLOR: Record<string, string> = { M: "text-warning", A: "text-added", "?": "text-added", D: "text-removed" };

/** One row. The row button shows on pointer hover and on focus (spec FR-032). The path keeps the file name whole (plan.md "Long text"). */
const Row = memo(function Row({ row, list, layout, sectionReason, sectionReasonId, folderReason, selected, tabStop, cut, untrackedCount, hasFiles, top, height, events }: RowProps) {
  const style: CSSProperties = { position: "absolute", top: 0, left: 0, right: 0, height, transform: `translateY(${top}px)`, paddingLeft: 8 + 16 * row.depth };
  const onRowAction = () => events.action(row);
  const common = {
    ref: (element: HTMLElement | null) => events.ref(row.key, element),
    role: "treeitem",
    "data-key": row.key,
    tabIndex: tabStop ? 0 : -1,
    "aria-level": row.depth + 1,
    "aria-posinset": row.pos,
    "aria-setsize": row.size,
    className: "group list-row flex items-center gap-1 pr-1",
    style,
    onFocus: () => events.focus(row),
    onClick: (event: ReactMouseEvent<HTMLElement>) => events.click(row, event),
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => events.menu(row, event),
  } as const;
  const chevron = (expanded: boolean) => <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />;
  const rowButton = (label: string, icon: typeof PlusSignIcon, reason: string | null) => (
    <IconButton
      icon={icon}
      label={label}
      keys={KEYS.stageEntry}
      note={reason ?? undefined}
      tabIndex={-1}
      disabled={reason !== null}
      className="invisible group-hover:visible group-focus:visible group-focus-within:visible"
      onClick={(event) => {
        event.stopPropagation();
        onRowAction();
      }}
    />
  );

  if (row.kind === "section") {
    return (
      <div {...common} aria-expanded={row.expanded} aria-label={cut ? cutHeading(untrackedCount) : `Untracked, ${formatCount(row.count)}`} data-section-row="untracked">
        {chevron(row.expanded)}
        <span className="min-w-0 truncate font-semibold">{cut ? cutHeading(untrackedCount) : "Untracked"}</span>
        {cut ? null : <span className="num ml-auto text-muted-text">{formatCount(row.count)}</span>}
        {hasFiles ? (
          <Button
            variant="outline"
            size="sm"
            tabIndex={-1}
            disabled={sectionReason !== null}
            focusableWhenDisabled
            aria-describedby={sectionReason === null ? undefined : sectionReasonId}
            className={cut ? "ml-auto" : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onRowAction();
            }}
          >
            Stage all untracked
          </Button>
        ) : null}
      </div>
    );
  }
  if (row.kind === "folder") {
    const label = `${list === "staged" ? "Unstage" : "Stage"} folder ${row.name}`;
    return (
      <div {...common} aria-expanded={row.expanded} aria-label={`${row.path}, ${formatCount(row.count)}`}>
        {chevron(row.expanded)}
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
        <span aria-hidden="true" className="min-w-0 truncate">
          {row.name}
        </span>
        <span aria-hidden="true" className="num ml-auto text-muted-text">
          {formatCount(row.count)}
        </span>
        {hasFiles ? rowButton(label, list === "staged" ? MinusSignIcon : PlusSignIcon, folderReason) : null}
      </div>
    );
  }
  const entry = row.entry;
  const [folder, name] = splitPath(entry.path, GIT_SEPARATORS);
  const direction = directionOf(entry.category);
  const mark = letter(entry);
  return (
    <div {...common} data-entry-id={entry.entryId} aria-selected={selected} aria-label={entry.path}>
      <span aria-hidden="true" className="flex min-w-0 flex-1 whitespace-nowrap">
        {layout === "tree" ? null : <span className="min-w-0 shrink-[1000] truncate">{folder}</span>}
        <span className="min-w-0 truncate">{name}</span>
      </span>
      <span aria-hidden="true" data-slot="status-letter" className={`w-4 shrink-0 text-center ${LETTER_COLOR[mark] ?? "text-text"}`}>
        {mark}
      </span>
      {rowButton(`${ROW_LABEL[direction]} ${name}`, direction === "unstage" ? MinusSignIcon : PlusSignIcon, null)}
    </div>
  );
});
