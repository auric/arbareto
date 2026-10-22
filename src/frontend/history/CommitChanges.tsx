// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowRight01Icon, ArrowUp01Icon, Copy01Icon, Folder01Icon, InformationCircleIcon, ListIcon, ListTreeIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { lazy, memo, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { CommitChanges as Changes, CommitFile } from "../../contracts/envelope";
import { compareKeys, treeKey } from "../../contracts/tree-order";
import { LimitedOutput, unknownReadText, useCopy } from "../app/RepositoryStates";
import { WarningIcon } from "../app/NoticeBand";
import { IconButton } from "../components/icon-button";
import { matches } from "../components/switcher-popover";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { KEYS, scopedAction } from "../keyboard/shortcuts";
import { FILE_LANE, type Profile } from "../layout/profiles";
import { Splitter } from "../layout/Splitter";
import type { BlameRequest, HistoryView, Inspection } from "../state/history-view";
import { textOf } from "../state/history-view";
import { READS_TRUST_TEXT } from "../trust/TrustChip";

// Feature 005 plan.md D3 (layout, selection, parent picker, texts, diff header) and D15 "History view" and "Changed files keys".
// Spec FR-005 to FR-014, FR-017, FR-068.

const PatchView = lazy(() => import("../changes/PatchView"));
// The Pierre worker pool. It mounts with the first History diff and stays while this region stays.
const PatchPool = lazy(() => import("../changes/PatchPool"));

type Entry = Changes["files"][number];
export type ChangeRow =
  | { kind: "file"; key: string; depth: number; entry: Entry; name: string; folder: string; pos: number; size: number }
  | { kind: "folder"; key: string; depth: number; name: string; path: string; count: number; expanded: boolean; pos: number; size: number };

export const FILTER_FILES = "Filter files";
export const NO_FILE_MATCH = "No file matches the filter.";
const ROOT_TEXT = "Compared with an empty tree. This is a root commit.";
const SHALLOW_TEXT = "Arbareto cannot show the changes. The parent of this commit is not in this shallow clone.";
const READING_FILES = "Arbareto reads the changed files.";
const READING_DIFF = "Arbareto reads the diff.";
const BINARY_TEXT = "Binary file. Arbareto does not show its changes.";
const STATUS_WORD: Record<Entry["status"], string> = { added: "added", deleted: "deleted", modified: "modified", renamed: "renamed", "type-changed": "type changed" };
const STATUS_LETTER: Record<Entry["status"], string> = { added: "A", deleted: "D", modified: "M", renamed: "R", "type-changed": "T" };
// 004 plan.md D16: M in Warning text, A in Added text, D in Removed text, R and T in Text. The letter is text, so color is never the only cue.
const LETTER_COLOR: Record<Entry["status"], string> = { added: "text-added", deleted: "text-removed", modified: "text-warning", renamed: "text-text", "type-changed": "text-text" };
const KIND_WORD = { file: "file", link: "symbolic link", submodule: "submodule" } as const;
const count = new Intl.NumberFormat("en-US");
// 001 plan.md "History graph design": a short ID is the first 12 hex digits.
const shortId = (oid: string) => oid.slice(0, 12);
const limitText = (n: number) => `This commit changes more files than Arbareto shows. Arbareto shows the first ${count.format(n)}.`;
const emptyText = (parent: number | null) => (parent === null ? "This commit changes no file." : `This commit changes no file compared with parent ${parent + 1}.`);
const failureText = (what: string, code: string | null) => (code === null ? unknownReadText(what) : `Arbareto cannot read ${what.toLowerCase()}: ${code}.`);
const ROW_HEIGHT = 26;
const VIRTUAL_MIN = 200;
const SLASH = "/";

// ---- Rows ----

/** Spec FR-015 to FR-017: the listing in tree order. A submodule sorts as a folder. One key per entry, built once per listing. */
export function treeOrder(files: readonly Entry[]): Entry[] {
  return files
    .map((entry) => ({ entry, key: treeKey(Uint8Array.from(atob(entry.pathBytes), (c) => c.charCodeAt(0)), entry.kind === "submodule") }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .map((k) => k.entry);
}

type Folder = { name: string; children: Map<string, Folder | Entry>; count: number; shown: number };
const isFolder = (node: Folder | Entry): node is Folder => "children" in node;
const display = (binary: string) => textOf(btoa(binary));

/** The shown rows of `sorted` (tree order). A folder with one folder child joins it, as "docs/drafts". `keep` hides the rejected files and the folders without a kept file. */
export function commitRows(sorted: readonly Entry[], layout: "tree" | "flat", collapsed: ReadonlySet<string>, keep?: (entry: Entry, path: string) => boolean): ChangeRow[] {
  const out: ChangeRow[] = [];
  const kept = (entry: Entry) => keep === undefined || keep(entry, textOf(entry.pathBytes));
  // `folder` is the folder part of a flat row. A tree row shows it through its parents.
  const fileRow = (entry: Entry, depth: number, pos: number, size: number): ChangeRow => {
    const binary = atob(entry.pathBytes);
    const cut = binary.lastIndexOf(SLASH);
    return { kind: "file", key: entry.pathBytes, depth, entry, name: display(binary.slice(cut + 1)), folder: layout === "tree" || cut < 0 ? "" : display(binary.slice(0, cut + 1)), pos, size };
  };
  if (layout === "flat") {
    const shown = sorted.filter(kept);
    shown.forEach((entry, i) => out.push(fileRow(entry, 0, i + 1, shown.length)));
    return out;
  }
  const root: Folder = { name: "", children: new Map(), count: 0, shown: 0 };
  for (const entry of sorted) {
    const parts = atob(entry.pathBytes).split(SLASH);
    const k = kept(entry) ? 1 : 0;
    let node = root;
    node.count++;
    node.shown += k;
    for (const part of parts.slice(0, -1)) {
      let next = node.children.get(`d${part}`) as Folder | undefined;
      if (next === undefined) node.children.set(`d${part}`, (next = { name: part, children: new Map(), count: 0, shown: 0 }));
      next.count++;
      next.shown += k;
      node = next;
    }
    node.children.set(`f${entry.fileId}`, entry);
  }
  const walk = (folder: Folder, prefix: string, depth: number) => {
    const children = [...folder.children.values()].filter((child) => (isFolder(child) ? child.shown > 0 : kept(child)));
    children.forEach((child, i) => {
      if (!isFolder(child)) return void out.push(fileRow(child, depth, i + 1, children.length));
      let node = child;
      let name = node.name;
      while (node.children.size === 1) {
        const only = node.children.values().next().value!;
        if (!isFolder(only)) break;
        node = only;
        name += SLASH + node.name;
      }
      const path = prefix + name;
      const key = `d:${btoa(path)}`;
      const expanded = !collapsed.has(key);
      out.push({ kind: "folder", key, depth, name: display(name), path: display(path), count: node.count, expanded, pos: i + 1, size: children.length });
      if (expanded) walk(node, path + SLASH, depth + 1);
    });
  };
  walk(root, "", 0);
  return out;
}

/** Plan.md D3 "File row name". */
export function rowName(row: Extract<ChangeRow, { kind: "file" }>): string {
  const e = row.entry;
  const kind = e.kind === "submodule" ? ", submodule" : "";
  const renamed = e.oldPathBytes === undefined ? "" : `, renamed from ${textOf(e.oldPathBytes)}`;
  return `${row.name}${kind}, ${STATUS_WORD[e.status]}${renamed}`;
}

// ---- The region ----

export type CommitChangesProps = {
  inspection: Inspection;
  view: HistoryView;
  /** The selected commit. */
  oid: string;
  profile: Profile;
  /** Trust… of a read that needs trust. It resolves true after an approval. */
  onTrust(): Promise<boolean>;
  /** Blame of the shown file (spec FR-053). */
  onBlame(request: BlameRequest): void;
  /** Ctrl+F focuses it while the focus is in Changed files or in the diff (plan.md D15 keyboard map). */
  filterRef?: RefObject<HTMLInputElement | null>;
};

/** The Changed files and diff regions of the selected commit (spec FR-005). Wide and narrow: side by side with a splitter. Constrained: the list above the diff. */
export function CommitChanges({ inspection, view, oid, profile, onTrust, onBlame, filterRef }: CommitChangesProps) {
  const viewId = useSyncExternalStore(view.subscribe, () => view.getState().view?.viewId ?? null, () => view.getState().view?.viewId ?? null);
  const state = useSyncExternalStore(inspection.subscribe, inspection.getState, inspection.getState);
  const [parent, setParent] = useState({ oid, index: 0 });
  const index = parent.oid === oid ? parent.index : 0;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (viewId !== null) void inspection.readChanges(viewId, oid, index, attempt > 0);
  }, [inspection, viewId, oid, index, attempt]);
  const read = state.changes !== null && state.changes.viewId === viewId && state.changes.oid === oid && state.changes.parent === index ? state.changes : null;
  const result = read?.state === "loaded" ? read.result : null;
  const sorted = useMemo(() => (result === null ? [] : treeOrder(result.files)), [result]);
  const [width, setWidth] = useState(288);
  const [layout, setLayout] = useState<"tree" | "flat">("tree");
  const [collapsed, setCollapsed] = useState<{ id: string | null; keys: ReadonlySet<string> }>({ id: null, keys: new Set() });
  const [query, setQuery] = useState("");
  const keys = collapsed.id === result?.changesId ? collapsed.keys : EMPTY;
  const keep = query === "" ? undefined : (_: Entry, path: string) => matches(path, query);
  const rows = useMemo(() => commitRows(sorted, layout, keys, keep), [sorted, layout, keys, query]);
  const file = state.file !== null && result !== null && state.file.changesId === result.changesId ? state.file : null;

  // Spec FR-007: the first file in tree order shows its diff.
  useEffect(() => {
    if (result !== null && file === null) void inspection.selectFile(sorted[0]?.fileId ?? null);
  }, [result]);

  const toggle = (key: string, open?: boolean) =>
    setCollapsed(({ id, keys: current }) => {
      const next = new Set(id === result?.changesId ? current : EMPTY);
      if (open ?? next.has(key)) next.delete(key);
      else next.add(key);
      return { id: result?.changesId ?? null, keys: next };
    });
  const onQuery = (next: string) => {
    setQuery(next);
    // 004 FR-101: a row that the filter hides leaves the selection. No other file gets selected.
    const shown = sorted.find((e) => e.fileId === file?.fileId);
    if (next !== "" && shown !== undefined && !matches(textOf(shown.pathBytes), next)) void inspection.selectFile(null);
  };

  const parents = result?.parents ?? [];
  const heading = result?.base.kind === "shallow" ? "Changed files" : `Changed files${result === null ? "" : ` (${count.format(result.files.length)})`}`;
  const headingId = useId();
  const noMatch = query !== "" && sorted.length > 0 && rows.length === 0;
  const selected = file === null ? null : (sorted.find((e) => e.fileId === file.fileId) ?? null);

  const list = (
    <section
      aria-labelledby={headingId}
      data-slot="changed-files"
      data-dock-stop=""
      className={`flex min-h-0 flex-col ${profile === "constrained" ? "max-h-[50%] shrink-0 border-b border-divider" : "shrink-0"}`}
      style={profile === "constrained" ? undefined : { width }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h3 id={headingId} className="min-w-0 flex-1 truncate font-semibold">
          {heading}
        </h3>
        <IconButton icon={ListTreeIcon} label="Tree layout" aria-pressed={layout === "tree"} onClick={() => setLayout("tree")} />
        <IconButton icon={ListIcon} label="Flat layout" aria-pressed={layout === "flat"} onClick={() => setLayout("flat")} />
      </div>
      {parents.length >= 2 ? (
        // Spec FR-008: each parent in Git order, from the history read. Parent 1 starts selected.
        <div role="radiogroup" aria-label="Compare with" className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-divider" style={{ padding: "6px 8px" }}>
          <span aria-hidden="true" className="text-muted-text">
            Compare with
          </span>
          {parents.map((p, i) => (
            <label key={p} className="flex items-center gap-1" style={{ minHeight: 24 }}>
              <input type="radio" name={`${headingId}-parent`} checked={i === index} onChange={() => setParent({ oid, index: i })} />
              <span>
                Parent {i + 1} <span className="font-mono">{shortId(p)}</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}
      <div className="relative flex shrink-0 items-center p-2">
        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" className="pointer-events-none absolute left-4 size-(--icon-size) text-muted-text" />
        <Tooltip>
          <TooltipTrigger
            render={
              <input
                ref={filterRef}
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
      <p role="status" className="shrink-0 px-2 text-muted-text">
        {noMatch ? NO_FILE_MATCH : null}
      </p>
      <ListNotes read={read} result={result} onTrust={async () => (await onTrust()) && setAttempt((n) => n + 1)} />
      {result === null || result.files.length === 0 ? null : (
        <FileTree label={heading} rows={rows} selectedId={file?.fileId ?? null} onSelect={(entry) => void inspection.selectFile(entry.fileId)} onToggle={toggle} />
      )}
    </section>
  );
  const diff = (
    <CommitDiff
      entry={selected}
      file={file}
      onBlame={() => {
        if (selected === null || result === null) return;
        // Plan.md D12 "Sources": a deleted row blames its old path at the chosen parent.
        const at = selected.status === "deleted" && result.base.kind === "parent" ? result.base.oid : result.oid;
        onBlame({ source: { changesId: result.changesId, fileId: selected.fileId }, path: textOf(selected.pathBytes), oid: at });
      }}
    />
  );
  if (profile === "constrained")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {list}
        {diff}
      </div>
    );
  return (
    <>
      {list}
      <Splitter label="Resize changed files" orientation="vertical" value={width} min={FILE_LANE.min} max={FILE_LANE.max} onChange={setWidth} />
      {diff}
    </>
  );
}
const EMPTY: ReadonlySet<string> = new Set();

function Note({ warning = false, children }: { warning?: boolean; children: ReactNode }) {
  return (
    <p className={`flex shrink-0 items-start gap-2 p-2 ${warning ? "bg-warning-fill" : ""}`}>
      {warning ? <WarningIcon /> : <HugeiconsIcon icon={InformationCircleIcon} size="1em" strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-text" />}
      <span>{children}</span>
    </p>
  );
}

/** Plan.md D3 texts above the tree: loading, failure, trust, root, shallow, limit, and the empty list. */
function ListNotes({ read, result, onTrust }: { read: ReturnType<Inspection["getState"]>["changes"]; result: Changes | null; onTrust(): void }) {
  if (read === null || read.state === "loading") return <p className="shrink-0 px-2 text-muted-text">{READING_FILES}</p>;
  if (read.state === "failed") {
    if (read.trust)
      return (
        <div className="flex shrink-0 flex-col items-start gap-2 p-2">
          <p>{READS_TRUST_TEXT}</p>
          <Button variant="outline" size="sm" onClick={onTrust}>
            Trust…
          </Button>
        </div>
      );
    return <p className="shrink-0 p-2">{read.remedy?.text ?? failureText("The changed files", read.code)}</p>;
  }
  const r = result!;
  if (r.base.kind === "shallow") return <Note warning>{SHALLOW_TEXT}</Note>;
  return (
    <>
      {r.base.kind === "empty-tree" ? <Note>{ROOT_TEXT}</Note> : null}
      {r.completeness.state === "limited" ? <Note warning>{limitText(r.completeness.shown)}</Note> : null}
      {r.files.length === 0 ? <p className="shrink-0 px-2 text-muted-text">{emptyText(r.base.kind === "parent" ? r.base.index : null)}</p> : null}
    </>
  );
}

// ---- The tree ----

type FileTreeProps = { label: string; rows: readonly ChangeRow[]; selectedId: number | null; onSelect(entry: Entry): void; onToggle(key: string, open?: boolean): void };

/** One WAI-ARIA tree with one Tab stop and roving focus. TanStack Virtual renders only the rows near the view (spec FR-068). */
function FileTree({ label, rows, selectedId, onSelect, onToggle }: FileTreeProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const toFocus = useRef<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const keyIndex = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const indexOf = (key: string | null) => (key === null ? -1 : (keyIndex.get(key) ?? -1));
  const selectedIndex = useMemo(() => rows.findIndex((r) => r.kind === "file" && r.entry.fileId === selectedId), [rows, selectedId]);
  // The Tab stop: the last focused row, else the selected file, else the first row.
  const activeIndex = indexOf(activeKey) >= 0 ? indexOf(activeKey) : selectedIndex >= 0 ? selectedIndex : rows.length > 0 ? 0 : -1;
  const virtual = rows.length > VIRTUAL_MIN;
  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: virtual,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => rows[i]!.key,
    overscan: 8,
    // The focused row stays mounted.
    rangeExtractor: (range) => {
      const shown = defaultRangeExtractor(range);
      return activeIndex < 0 || shown.includes(activeIndex) ? shown : [...shown, activeIndex].sort((a, b) => a - b);
    },
  });
  function focusKey(key: string) {
    const i = indexOf(key);
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

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const at = indexOf(item?.dataset.key ?? null);
    if (at < 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const row = rows[at]!;
    if (event.key === "Enter") {
      event.preventDefault();
      return row.kind === "folder" ? onToggle(row.key) : onSelect(row.entry);
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      if (row.kind === "file" && event.key === "ArrowRight") return;
      event.preventDefault();
      if (event.key === "ArrowRight") return row.kind === "folder" && !row.expanded ? onToggle(row.key, true) : focusKey(rows[at + 1]?.key ?? row.key);
      if (row.kind === "folder" && row.expanded) return onToggle(row.key, false);
      // ArrowLeft on a child moves to its parent row.
      for (let i = at - 1; i >= 0; i--) if (rows[i]!.depth < row.depth) return focusKey(rows[i]!.key);
      return;
    }
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / ROW_HEIGHT));
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
    // Spec FR-007: the diff shows at once, without motion.
    if (target.kind === "file") onSelect(target.entry);
  }

  const latest = useRef({ onSelect, onToggle });
  latest.current = { onSelect, onToggle };
  const [events] = useState<RowEvents>(() => ({
    ref: (key, element) => void (element ? elements.current.set(key, element) : elements.current.delete(key)),
    focus: (row) => setActiveKey(row.key),
    click: (row) => {
      setActiveKey(row.key);
      if (row.kind === "folder") latest.current.onToggle(row.key);
      else latest.current.onSelect(row.entry);
    },
  }));
  const items = virtual ? virtualizer.getVirtualItems() : rows.map((_, index) => ({ index, start: index * ROW_HEIGHT }));
  return (
    <div ref={scroller} role="tree" aria-label={label} className="relative min-h-(--h-row) flex-1 overflow-y-auto px-1" onKeyDown={onKeyDown}>
      <div role="presentation" className="relative" style={{ height: virtual ? virtualizer.getTotalSize() : rows.length * ROW_HEIGHT }}>
        {items.map((item) => {
          const row = rows[item.index]!;
          return <Row key={row.key} row={row} selected={row.kind === "file" && row.entry.fileId === selectedId} tabStop={item.index === activeIndex} top={item.start} events={events} />;
        })}
      </div>
    </div>
  );
}

type RowEvents = { ref(key: string, element: HTMLElement | null): void; focus(row: ChangeRow): void; click(row: ChangeRow): void };

const Row = memo(function Row({ row, selected, tabStop, top, events }: { row: ChangeRow; selected: boolean; tabStop: boolean; top: number; events: RowEvents }) {
  // Plan.md D15: 26 px rows, 8 px plus 16 px per level.
  const style: CSSProperties = { position: "absolute", top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${top}px)`, paddingLeft: 8 + 16 * row.depth };
  const common = {
    ref: (element: HTMLElement | null) => events.ref(row.key, element),
    role: "treeitem",
    "data-key": row.key,
    tabIndex: tabStop ? 0 : -1,
    "aria-level": row.depth + 1,
    "aria-posinset": row.pos,
    "aria-setsize": row.size,
    className: "list-row flex items-center gap-1 pr-1",
    style,
    onFocus: () => events.focus(row),
    onClick: () => events.click(row),
  } as const;
  if (row.kind === "folder")
    return (
      <div {...common} aria-expanded={row.expanded} aria-label={`${row.path}, ${count.format(row.count)}`}>
        <HugeiconsIcon icon={row.expanded ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
        <span aria-hidden="true" className="min-w-0 truncate">
          {row.name}
        </span>
        <span aria-hidden="true" className="num ml-auto text-muted-text">
          {count.format(row.count)}
        </span>
      </div>
    );
  const status = row.entry.status;
  return (
    <div {...common} aria-selected={selected} aria-label={rowName(row)}>
      <span aria-hidden="true" className="flex min-w-0 flex-1 whitespace-nowrap">
        {row.folder === "" ? null : <span className="min-w-0 shrink-[1000] truncate text-muted-text">{row.folder}</span>}
        <span className="min-w-0 truncate">{row.name}</span>
      </span>
      <span aria-hidden="true" data-slot="status-letter" className={`w-4 shrink-0 text-center ${LETTER_COLOR[status]}`}>
        {STATUS_LETTER[status]}
      </span>
    </div>
  );
});

// ---- The diff ----

const fatal = new TextDecoder("utf-8", { fatal: true });
function decodePatch(base64: string): string | null {
  try {
    return fatal.decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
// git-diff(1) "Generating patch text with -p": each hunk of the canonical patch starts with a header line that begins with "@@ ".
const hunkCount = (patch: string) => patch.split("\n").filter((line) => line.startsWith("@@ ")).length;
type FileRead = ReturnType<Inspection["getState"]>["file"];
type PierreHunk = NonNullable<Parameters<typeof import("../changes/PatchView").default>[0]["anchor"]>;

/** Plan.md D3 "Diff facts", one fact row each. */
function Facts({ result }: { result: CommitFile }) {
  const { rename, mode, submodule, typeChange } = result.facts;
  const facts: ReactNode[] = [];
  if (rename) facts.push(`Renamed from ${textOf(rename.oldPath)} (${rename.score}% similar).`);
  if (mode)
    facts.push(
      <>
        Mode <code>{mode.old}</code> → <code>{mode.new}</code>.
      </>,
    );
  if (submodule) {
    if (submodule.old === null && submodule.new !== null) facts.push(`Submodule commit added: ${shortId(submodule.new)}.`);
    else if (submodule.new === null && submodule.old !== null) facts.push(`Submodule commit removed: ${shortId(submodule.old)}.`);
    else if (submodule.old !== null && submodule.new !== null) facts.push(`Submodule commit ${shortId(submodule.old)} → ${shortId(submodule.new)}.`);
  }
  if (result.binary) facts.push(BINARY_TEXT);
  if (typeChange) facts.push(`Type changed from ${KIND_WORD[typeChange.old]} to ${KIND_WORD[typeChange.new]}.`);
  return (
    <>
      {facts.map((fact, i) => (
        <Note key={i}>{fact}</Note>
      ))}
    </>
  );
}

/** The diff of the selected file: the 32 px header, the fact rows, and `PatchView` without hunk actions and line selection (spec FR-014). */
function CommitDiff({ entry, file, onBlame }: { entry: Entry | null; file: FileRead; onBlame(): void }) {
  const copy = useCopy();
  const result = file?.state === "loaded" ? file.result : null;
  const patch = useMemo(() => (result?.patch == null ? null : decodePatch(result.patch)), [result]);
  const [pool, setPool] = useState(false);
  if (!pool && patch !== null) setPool(true);
  // Pierre hunks give the anchor of Previous hunk and Next hunk. The module loads with PatchView.
  const [hunks, setHunks] = useState<{ patch: string; list: readonly PierreHunk[] } | null>(null);
  const [step, setStep] = useState<{ patch: string | null; index: number | null }>({ patch, index: null });
  const at = step.patch === patch ? step.index : null;
  useEffect(() => {
    if (patch === null) return;
    let current = true;
    void import("@pierre/diffs").then(
      ({ getSingularPatch }) => current && setHunks({ patch, list: getSingularPatch(patch).hunks }),
      () => {},
    );
    return () => void (current = false);
  }, [patch]);
  const total = patch === null ? 0 : hunkCount(patch);
  const move = (direction: 1 | -1) => total > 0 && setStep({ patch, index: Math.min(total - 1, Math.max(0, (at ?? (direction === 1 ? -1 : total)) + direction)) });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = scopedAction(event.nativeEvent, "diff");
    if (action !== "previousHunk" && action !== "nextHunk") return;
    event.preventDefault();
    move(action === "nextHunk" ? 1 : -1);
  };
  const path = entry === null ? null : textOf(entry.pathBytes);
  const anchor = at === null || hunks?.patch !== patch ? null : (hunks.list[at] ?? null);
  const body =
    file === null || entry === null ? null
    : file.state === "loading" ? <p className="p-2 text-muted-text">{READING_DIFF}</p>
    : file.state === "failed" ? <p className="p-2">{file.remedy?.text ?? failureText("The diff", file.code)}</p>
    : (
      <>
        <Facts result={file.result} />
        {file.result.completeness.state === "limited" && file.result.completeness.code === "OUTPUT_LIMIT" ? <LimitedOutput completeness={file.result.completeness} /> : null}
        {file.result.remedy ? <p className="p-2">{file.result.remedy.text}</p> : null}
        {file.result.patch === null ? null : patch === null ? (
          <p className="p-2">{failureText("The diff", "DISPLAY_MAPPING_FAILED")}</p>
        ) : (
          <div tabIndex={0} role="group" aria-label="Diff" data-slot="diff-body" className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={<p className="p-2 text-muted-text">{READING_DIFF}</p>}>
              <PatchView patch={patch} selected={null} anchor={anchor} />
            </Suspense>
          </div>
        )}
      </>
    );
  return (
    <section aria-label="Diff of the selected file" data-slot="history-diff" data-dock-stop="" className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {path === null ? null : (
        <div data-slot="diff-header" className="flex shrink-0 items-center gap-2 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
          <span className="min-w-0 truncate font-mono font-semibold" title={path}>
            {path}
          </span>
          {total > 0 ? <span className="num shrink-0 text-muted-text">{`${total} ${total === 1 ? "hunk" : "hunks"}`}</span> : null}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <IconButton icon={Copy01Icon} label="Copy path" onClick={() => copy(path)} />
            {total > 0 ? (
              <>
                <IconButton icon={ArrowUp01Icon} label="Previous hunk" keys={KEYS.previousHunk} onClick={() => move(-1)} />
                <IconButton icon={ArrowDown01Icon} label="Next hunk" keys={KEYS.nextHunk} onClick={() => move(1)} />
              </>
            ) : null}
            <Button variant="outline" size="sm" style={{ height: 24 }} onClick={onBlame}>
              Blame
            </Button>
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {pool ? (
          <Suspense fallback={null}>
            <PatchPool>{body}</PatchPool>
          </Suspense>
        ) : (
          body
        )}
      </div>
    </section>
  );
}
