// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type FocusEvent as ReactFocusEvent } from "react";
import type { ChangeEntry } from "../../contracts/envelope";

// plan.md "Task flow and command placement", "Long text", "Keyboard and focus" (Roles, File/history list, Stage key row), and "Required visible states" (No selection, Empty/clean).

type Category = ChangeEntry["category"];

export const HELP_LINE = "Enter shows a file. Space stages or unstages it. The toolbar stages one hunk.";
export const BUSY_REASON = "A file action is running. Wait for its result.";

export type FileDirection = "stage" | "unstage";
export type FileAction = { direction: FileDirection; comparisonId: string; entryId: string };
/** The T202 `runFileAction` result. `text` of a refusal is the full status bar sentence. */
export type FileActionResult = { state: "succeeded" } | { state: "failed" } | { state: "refused"; text: string };
/** The selected entry and the ID of its shown comparison. `comparisonId` is null while its read is pending. */
export type PaneSelection = { entryId: string; comparisonId: string | null } | null;

export type ChangesPaneProps = {
  /** The entries of the latest snapshot, in service order. */
  entries: readonly ChangeEntry[];
  selection: PaneSelection;
  /** Selects an entry and starts its comparison read. */
  onSelect(entryId: string): void;
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
  /** The Unstaged help line. The default states the T202 and T145 controls. */
  helpLine?: string;
};

const WORKING: { category: Category; label: string }[] = [
  { category: "conflicted", label: "Conflicted" },
  { category: "unstaged", label: "Unstaged" },
  { category: "untracked", label: "Untracked" },
];
// ponytail: plain rows up to this count. TanStack Virtual takes larger lists (plan.md "Keyboard and focus": TanStack only handles large change lists).
const VIRTUAL_MIN = 200;
// The compact file row height (plan.md density table). `measureElement` replaces this estimate with the measured height.
const ROW_ESTIMATE = 26;

type ListHandle = { focusEntry(entryId: string): void; focusHeading(): void };

function byCategory(entries: readonly ChangeEntry[]): Record<Category, ChangeEntry[]> {
  const groups: Record<Category, ChangeEntry[]> = { conflicted: [], unstaged: [], untracked: [], staged: [] };
  for (const entry of entries) groups[entry.category].push(entry);
  return groups;
}

/** plan.md Stage key row order: the next surviving entry, then the previous one, else null for the category heading. */
function survivor(list: readonly ChangeEntry[], entryId: string, alive: ReadonlySet<string>): ChangeEntry | null {
  const index = list.findIndex((e) => e.entryId === entryId);
  if (index < 0) return null;
  const ok = (e: ChangeEntry) => e.entryId !== entryId && alive.has(e.entryId);
  for (let i = index + 1; i < list.length; i++) if (ok(list[i]!)) return list[i]!;
  for (let i = index - 1; i >= 0; i--) if (ok(list[i]!)) return list[i]!;
  return null;
}

export function ChangesPane(props: ChangesPaneProps) {
  const { entries, selection, fileActionRunning = false, operationRunning = false, toolbarSuccess = null, complete = false, helpLine = HELP_LINE } = props;
  const live = useRef(props);
  live.current = props;
  const groups = byCategory(entries);
  const lists = useRef<Partial<Record<Category, ListHandle>>>({});
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<string | null>(null);
  const running = useRef(false);
  const reasonShown = useRef<string | null>(null);
  const statusShown = useRef(false);
  const focused = useRef<ChangeEntry | null>(null);
  const previous = useRef(entries);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);

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

  // Moves focus to the next entry, the previous entry, or the category heading. `select` also selects that entry.
  function moveFrom(entry: ChangeEntry, list: readonly ChangeEntry[], select: boolean) {
    const target = survivor(list, entry.entryId, new Set(live.current.entries.map((e) => e.entryId)));
    const handle = lists.current[entry.category];
    if (target === null) return handle?.focusHeading();
    if (select) live.current.onSelect(target.entryId);
    handle?.focusEntry(target.entryId);
  }

  async function run(entry: ChangeEntry, comparisonId: string) {
    const list = byCategory(live.current.entries)[entry.category];
    running.current = true;
    const result = await live.current.onFileAction({ direction: entry.category === "staged" ? "unstage" : "stage", comparisonId, entryId: entry.entryId });
    running.current = false;
    if (!mounted.current) return;
    if (reasonShown.current === BUSY_REASON) reason(null);
    if (result.state === "succeeded") moveFrom(entry, list, true);
    else if (result.state === "refused") {
      reason(result.text);
      if (!live.current.operationRunning) status(result.text);
    }
  }

  function onSpace(entry: ChangeEntry, event: ReactKeyboardEvent) {
    const p = live.current;
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.repeat || event.nativeEvent.isComposing || p.modalOpen || p.menuOpen) return;
    event.preventDefault();
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
    const entry = live.current.entries.find((e) => e.entryId === toolbarSuccess.entryId) ?? previous.current.find((e) => e.entryId === toolbarSuccess.entryId);
    if (!entry) return;
    const source = live.current.entries.some((e) => e.entryId === entry.entryId) ? live.current.entries : previous.current;
    moveFrom(entry, byCategory(source)[entry.category], true);
  }, [toolbarSuccess]);

  // A hunk action or an external change removed the focused entry: focus a survivor or the heading, without a selection change.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = entries;
    const lost = focused.current;
    if (before === entries || lost === null || entries.some((e) => e.entryId === lost.entryId)) return;
    focused.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    moveFrom(lost, byCategory(before)[lost.category], false);
  }, [entries]);

  const onFocus = (event: ReactFocusEvent) => {
    const option = (event.target as Element).closest?.('[role="option"]') as HTMLElement | null;
    const id = option?.dataset.entryId;
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

  const listProps = (category: Category, label: string) => ({
    category,
    label,
    entries: groups[category],
    selectedId: selection?.entryId ?? null,
    helpLine,
    register: (handle: ListHandle | null) => void (handle ? (lists.current[category] = handle) : delete lists.current[category]),
    onEnter: (entry: ChangeEntry) => {
      if (live.current.selection?.entryId !== entry.entryId) live.current.onSelect(entry.entryId);
    },
    onSpace,
  });
  const working = groups.conflicted.length + groups.unstaged.length + groups.untracked.length;

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col" onFocus={onFocus} onBlur={onBlur}>
      <section className="flex min-h-0 flex-1 flex-col">
        <h2 className="flex items-center px-2 font-semibold" style={{ minHeight: "var(--h-pane-heading)" }}>
          Working changes
        </h2>
        {complete && working === 0 ? <p className="px-2 text-muted-text">Working tree clean</p> : null}
        {WORKING.filter((w) => w.category !== "conflicted" || groups.conflicted.length > 0).map((w) => (
          <CategoryList key={w.category} {...listProps(w.category, w.label)} level={3} />
        ))}
      </section>
      <section className="flex min-h-0 flex-1 flex-col border-t border-divider">
        <CategoryList {...listProps("staged", "Staged")} level={2} />
      </section>
    </div>
  );
}

type CategoryListProps = {
  category: Category;
  label: string;
  level: 2 | 3;
  entries: readonly ChangeEntry[];
  selectedId: string | null;
  helpLine: string;
  register(handle: ListHandle | null): void;
  onEnter(entry: ChangeEntry): void;
  onSpace(entry: ChangeEntry, event: ReactKeyboardEvent): void;
};

/** One category: its heading with the count, and one WAI-ARIA listbox with one Tab stop and roving focus. */
function CategoryList({ category, label, level, entries, selectedId, helpLine, register, onEnter, onSpace }: CategoryListProps) {
  const ids = { label: useId(), count: useId(), help: useId() };
  const heading = useRef<HTMLHeadingElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const toFocus = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const index = (id: string | null) => (id === null ? -1 : entries.findIndex((e) => e.entryId === id));
  // The Tab stop: the last focused entry, else the selected entry of this list, else the first entry.
  const activeIndex = index(activeId) >= 0 ? index(activeId) : index(selectedId) >= 0 ? index(selectedId) : entries.length > 0 ? 0 : -1;
  const virtual = entries.length > VIRTUAL_MIN;

  const virtualizer = useVirtualizer({
    count: entries.length,
    enabled: virtual,
    getScrollElement: () => listbox.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (i) => entries[i]!.entryId,
    overscan: 8,
    // The focused row stays mounted (plan.md "Keyboard and focus").
    rangeExtractor: (range) => {
      const shown = defaultRangeExtractor(range);
      return activeIndex < 0 || shown.includes(activeIndex) ? shown : [...shown, activeIndex].sort((a, b) => a - b);
    },
  });

  function focusEntry(entryId: string) {
    const i = index(entryId);
    if (i < 0) return;
    setActiveId(entryId);
    const row = rows.current.get(entryId);
    if (row) return row.focus();
    toFocus.current = entryId;
    if (virtual) virtualizer.scrollToIndex(i);
  }
  useLayoutEffect(() => {
    const id = toFocus.current;
    const row = id === null ? undefined : rows.current.get(id);
    if (!row) return;
    toFocus.current = null;
    row.focus();
  });
  const handle = useRef<ListHandle>({ focusEntry, focusHeading: () => heading.current?.focus() });
  handle.current.focusEntry = focusEntry;
  useEffect(() => {
    register(handle.current);
    return () => register(null);
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const option = (event.target as HTMLElement).closest('[role="option"]') as HTMLElement | null;
    const at = index(option?.dataset.entryId ?? null);
    if (at < 0) return;
    // Space and Enter act only on the option itself, never on an editable child.
    if (event.key === " " || event.key === "Enter") {
      if (event.target !== option) return;
      if (event.key === "Enter") {
        event.preventDefault();
        onEnter(entries[at]!);
      } else onSpace(entries[at]!, event);
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const rowHeight = option!.offsetHeight;
    const page = rowHeight > 0 ? Math.max(1, Math.floor(listbox.current!.clientHeight / rowHeight)) : 1;
    const to =
      event.key === "ArrowDown" ? at + 1
      : event.key === "ArrowUp" ? at - 1
      : event.key === "Home" ? 0
      : event.key === "End" ? entries.length - 1
      : event.key === "PageDown" ? at + page
      : event.key === "PageUp" ? at - page
      : null;
    if (to === null) return;
    event.preventDefault();
    focusEntry(entries[Math.min(entries.length - 1, Math.max(0, to))]!.entryId);
  }

  const Heading = level === 2 ? "h2" : "h3";
  const option = (entry: ChangeEntry, i: number, style?: CSSProperties) => (
    <FileOption
      key={entry.entryId}
      entry={entry}
      selected={entry.entryId === selectedId}
      tabStop={i === activeIndex}
      position={virtual ? { index: i, size: entries.length } : undefined}
      style={style}
      rowRef={(element) => {
        if (element) {
          rows.current.set(entry.entryId, element);
          if (virtual) virtualizer.measureElement(element);
        } else rows.current.delete(entry.entryId);
      }}
      onFocus={() => setActiveId(entry.entryId)}
    />
  );

  return (
    <>
      <Heading
        ref={heading}
        tabIndex={-1}
        className="flex shrink-0 items-center gap-2 px-2 font-semibold"
        style={{ minHeight: level === 2 ? "var(--h-pane-heading)" : "var(--h-subgroup)" }}
      >
        <span id={ids.label}>{label}</span>
        <span id={ids.count} className="num ml-auto">
          {entries.length}
        </span>
      </Heading>
      {category === "unstaged" ? (
        <p id={ids.help} className="shrink-0 truncate px-2 text-muted-text" style={{ height: "var(--h-help-line)", lineHeight: "var(--h-help-line)" }}>
          {helpLine}
        </p>
      ) : null}
      {entries.length === 0 ? null : (
        <div
          ref={listbox}
          role="listbox"
          aria-labelledby={`${ids.label} ${ids.count}`}
          aria-describedby={category === "unstaged" ? ids.help : undefined}
          className="min-h-(--h-row) shrink overflow-y-auto px-1"
          onKeyDown={onKeyDown}
        >
          {virtual ? (
            <div role="presentation" className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => option(entries[item.index]!, item.index, { position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }))}
            </div>
          ) : (
            entries.map((entry, i) => option(entry, i))
          )}
        </div>
      )}
    </>
  );
}

type FileOptionProps = {
  entry: ChangeEntry;
  selected: boolean;
  tabStop: boolean;
  position?: { index: number; size: number };
  style?: CSSProperties;
  rowRef(element: HTMLElement | null): void;
  onFocus(): void;
};

// A display path from contract §3. The last separator splits the folder part from the file name.
function splitPath(path: string): [string, string] {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return [path.slice(0, cut), path.slice(cut)];
}

/** One file row. The path keeps the file name whole and ellipsizes the folder part first (plan.md "Long text"). */
function FileOption({ entry, selected, tabStop, position, style, rowRef, onFocus }: FileOptionProps) {
  const [folder, name] = splitPath(entry.path);
  return (
    <div
      ref={rowRef}
      role="option"
      data-entry-id={entry.entryId}
      data-index={position?.index}
      aria-selected={selected}
      aria-label={entry.path}
      aria-setsize={position?.size}
      aria-posinset={position === undefined ? undefined : position.index + 1}
      tabIndex={tabStop ? 0 : -1}
      className="list-row flex items-center px-2"
      style={style}
      onFocus={onFocus}
    >
      <span aria-hidden="true" className="flex min-w-0 whitespace-nowrap">
        <span className="min-w-0 shrink-[1000] truncate">{folder}</span>
        <span className="min-w-0 truncate">{name}</span>
      </span>
    </div>
  );
}
