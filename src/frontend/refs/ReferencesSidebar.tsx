// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowRight01Icon, CancelCircleIcon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { RefEntry, RefsResult } from "../../contracts/envelope";
import { compareKeys, treeKey } from "../../contracts/tree-order";
import { unknownReadText } from "../app/RepositoryStates";
import { BranchCard, GoneMark, isCut, isGone, UPSTREAM_GONE_NAME, type CardFacts } from "../branches/BranchCard";
import type { BridgeResponse } from "../bridge";
import type { BranchEntry } from "../state/workbench";
import { ActionMenu } from "../components/action-menu";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { COUNTS_TOOLTIP, type TrackLabel } from "../state/tracking";
import { scopedAction, type ScopedAction } from "../keyboard/shortcuts";

// FR-057. plan.md "References sidebar", "Long text", "Keyboard and focus" (References sidebar row), "Task flow and command placement" (Browse references),
// "Required visible states" (References), and "Status and fallback texts" (Sidebar texts). Contract §3 "References result". The sidebar is read-only.
// Feature 002 spec FR-049 and FR-055, plan.md D6 "References sidebar" and "Branch scope".

type Kind = RefEntry["kind"];
// Contract Δ3: the sidebar does not show the stash.
const GROUPS: { kind: Exclude<Kind, "stash">; label: string; empty: string; noun: string }[] = [
  { kind: "branch", label: "Branches", empty: "No branches", noun: "local branch" },
  { kind: "remote", label: "Remotes", empty: "No remote-tracking branches", noun: "remote-tracking branch" },
  { kind: "tag", label: "Tags", empty: "No tags", noun: "tag" },
];
const LOADING = "Loading references…";
const NO_MATCH = "No reference matches the filter.";
// Feature 003 data-model §1 label text.
const NO_UPSTREAM = "No upstream";
// Contract Δ3 `readHistoryRows` targets other than `found`.
const NOT_SHOWN = { none: "Not in this history list", unknown: "Not in the loaded history rows" } as const;
const REFUSAL: Record<string, string> = {
  REF_LISTING_RECORDS: "This repository has more than 10,000 references. This version does not list them.",
  REF_LISTING_BYTES: "The reference list is larger than this version can show.",
};
export const SHOW_BRANCH_HISTORY = "Show only this branch's history";
// ponytail: plain rows up to this count, as ChangesPane does. TanStack Virtual takes larger trees.
const VIRTUAL_MIN = 200;
// The compact row height (plan.md density table). The parent passes the row height of the density.
const ROW_HEIGHT = 26;

// Contract §3: `symref` and `upstream` are full reference names. Git's namespaces give the short name (git-check-ref-format(1)).
const PREFIXES = ["refs/heads/", "refs/remotes/", "refs/tags/"];
export const shortRef = (name: string) => {
  const prefix = PREFIXES.find((p) => name.startsWith(p));
  return prefix === undefined ? name : name.slice(prefix.length);
};

// Feature 005 spec FR-064 and plan.md O-1: the visible "→ <upstream>" stays, and the gone mark replaces ", not present".
const upstreamText = (entry: RefEntry) => (entry.upstream === null ? null : `→ ${shortRef(entry.upstream)}`);
const NAME_SLOT = '[data-slot="ref-name"]';

function refusalText(response: BridgeResponse): string {
  if (response.state === "succeeded") return unknownReadText("The references");
  const completeness = (response.result as { completeness?: { code?: string; reason?: string } } | undefined)?.completeness;
  const reason = completeness?.reason;
  if (reason !== undefined && reason in REFUSAL) return REFUSAL[reason]!;
  return `Arbareto cannot read the references: ${response.code ?? completeness?.code ?? response.state}.`;
}

export type ReferencesSidebarProps = {
  /** The newest `readRefs` list, or null before the first one. */
  refs: RefsResult | null;
  /** The newest `readRefs` refusal. */
  failure: BridgeResponse | null;
  /** Selects the history row of a commit and docks its details. It gives the contract Δ3 read target, or null without a result. Focus stays in the sidebar. */
  onSelectCommit(oid: string): Promise<"found" | "none" | "unknown" | null>;
  onRefresh(): void;
  /** The constrained profile: the section starts collapsed to its heading row with the Show references toggle. */
  collapsible?: boolean;
  /** The open repository (its worktree key). The expansion lasts per repository for the window session. */
  repository: string;
  /** The shared row height of the density. */
  rowHeight?: number;
  /** Feature 002 spec FR-049: the current-branch context menu item selects the current-branch history scope. Without it, no context menu opens. */
  onShowBranchHistory?: () => void;
  /** Feature 003 FR-019: the count label of each local branch by name (`state/tracking.ts`). */
  tracking?: ReadonlyMap<string, TrackLabel>;
  /**
   * Feature 004 spec FR-009 and FR-014: the branch actions of a local or remote-tracking branch row. `menu` opens the context menu,
   * `confirm` is a double-click, and a D15 key gives its action. Without it, only the current branch opens the 002 menu.
   */
  onBranchAction?: (entry: RefEntry, action: "menu" | "confirm" | ScopedAction, anchor: HTMLElement, byKey?: boolean) => void;
  /** Feature 004 plan.md D15 "P2 regions": the groups after the references, such as Worktrees. They scroll with the sidebar. */
  after?: ReactNode;
  /** The constrained profile: the outer section that scrolls the whole sidebar. The tree then has no scroll region of its own and stays virtual in it. */
  scrollElement?: () => HTMLElement | null;
  /** The expansion of a collapsible section, when the parent holds it. */
  expanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
  /** Feature 005 spec FR-066: the newest `readBranches` entries, for the worktree line of the branch card. Without them, the card leaves out that line. */
  branches?: readonly BranchEntry[] | null;
};

// plan.md "Keyboard and focus", References sidebar row: the expansion lasts for the window session per repository and is not stored.
const sessionExpansion = new Map<string, ReadonlySet<string>>();

/** One tree node: a group, a folder of one `/` level, or an entry. Keys are unique within the tree. */
type Tree = { key: string; label: string; count: number; children: Tree[]; entry?: RefEntry };
/** `pos` and `size` are the WAI-ARIA tree position among the shown siblings. */
type Row = { node: Tree; level: number; kind: Kind; parent: number; pos: number; size: number };

const groupKey = (kind: Kind) => `group:${kind}`;
const folderKey = (kind: Kind, path: string) => `folder:${kind}:${path}`;

const utf8 = new TextEncoder();
/**
 * Git's reference hierarchy (git-check-ref-format(1)): each `/` of a name starts one level. Feature 005 spec FR-015: the entries sort first, so each level shows its folders first.
 * `RefEntry` holds no raw name bytes, so a name that is not valid UTF-8 sorts by the bytes of its text. Equal texts keep Git's refname order.
 */
function buildGroup(kind: Kind, label: string, entries: readonly RefEntry[]): Tree {
  const root: Tree = { key: groupKey(kind), label, count: 0, children: [] };
  const folders = new Map<string, Tree>();
  const sorted = entries.map((entry) => ({ entry, key: treeKey(utf8.encode(entry.name)) })).sort((a, b) => compareKeys(a.key, b.key));
  for (const { entry } of sorted) {
    const segments = entry.name.split("/");
    let at = root;
    root.count++;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = folderKey(kind, segments.slice(0, i + 1).join("/"));
      let folder = folders.get(key);
      if (folder === undefined) {
        folder = { key, label: segments[i]!, count: 0, children: [] };
        folders.set(key, folder);
        at.children.push(folder);
      }
      folder.count++;
      at = folder;
    }
    at.children.push({ key: `entry:${kind}:${entry.name}`, label: segments.at(-1)!, count: 1, children: [], entry });
  }
  return root;
}

/** plan.md: Branches open, Remotes and Tags closed, and the folders on the path to the current branch open. */
function defaultExpansion(current: RefsResult["current"]): Set<string> {
  const open = new Set([groupKey("branch")]);
  const segments = current?.name.split("/") ?? [];
  for (let i = 1; i < segments.length; i++) open.add(folderKey("branch", segments.slice(0, i).join("/")));
  return open;
}

/** The node keys that hold a matching entry. They open while the filter has text. */
function matchingPaths(tree: Tree, matches: (entry: RefEntry) => boolean, open: Set<string>): boolean {
  if (tree.entry !== undefined) return matches(tree.entry);
  let any = false;
  for (const child of tree.children) if (matchingPaths(child, matches, open)) any = true;
  if (any) open.add(tree.key);
  return any;
}

export function ReferencesSidebar({ refs, failure, onSelectCommit, onRefresh, collapsible = false, repository, rowHeight = ROW_HEIGHT, onShowBranchHistory, tracking, onBranchAction, after, scrollElement, expanded, onExpandedChange, branches }: ReferencesSidebarProps) {
  const ids = { heading: useId(), node: useId(), none: useId(), unknown: useId(), empty: useId(), card: useId() };
  // Feature 005 plan.md D13: one branch card at a time, by row key.
  const [card, setCard] = useState<{ key: string; instant: boolean } | null>(null);
  // Exact names only: a ref that is not valid UTF-8 pairs with nothing.
  const held = useMemo(() => (branches == null ? null : new Map(branches.filter((b) => b.kind === "local" && !b.invalidUtf8).map((b) => [b.ref, b]))), [branches]);
  const emptyId = (kind: Kind) => `${ids.empty}-${kind}`;
  const [query, setQuery] = useState("");
  // Null until the user changes the expansion: the default then follows the current branch of the newest result.
  const [stored, setStored] = useState<{ repository: string; open: ReadonlySet<string> | null }>(() => ({ repository, open: sessionExpansion.get(repository) ?? null }));
  if (stored.repository !== repository) setStored({ repository, open: sessionExpansion.get(repository) ?? null });
  // Toggles while the filter has text change only this set. Clearing the filter drops it.
  const [filtered, setFiltered] = useState<{ query: string; open: ReadonlySet<string> } | null>(null);
  // The toggle state lasts for the window session and is not stored (plan.md "References sidebar").
  const [ownShown, setOwnShown] = useState(!collapsible);
  const shown = expanded ?? ownShown;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // The row whose context menu is open, and whether Shift+F10 or the Menu key opened it.
  const [menu, setMenu] = useState<{ key: string; byKey: boolean } | null>(null);
  // The commits whose last selection gave no row, with the read target.
  const [missing, setMissing] = useState<ReadonlyMap<string, "none" | "unknown">>(new Map());
  const elements = useRef(new Map<string, HTMLElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  // The tree offset inside the scroll element (TanStack Virtual `scrollMargin`).
  const [margin, setMargin] = useState(0);
  const toFocus = useRef<string | null>(null);

  const needle = query.toLowerCase();
  const matches = (entry: RefEntry) => entry.name.toLowerCase().includes(needle);
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, tree: buildGroup(g.kind, g.label, refs?.refs.filter((r) => r.kind === g.kind) ?? []) })), [refs]);
  const filterOpen = useMemo(() => {
    if (needle === "") return null;
    const open = new Set<string>();
    for (const g of groups) matchingPaths(g.tree, matches, open);
    return open;
  }, [needle, groups]);
  const open: ReadonlySet<string> = filterOpen !== null ? (filtered !== null && filtered.query === needle ? filtered.open : filterOpen) : (stored.open ?? defaultExpansion(refs?.current ?? null));

  function toggle(key: string, next: boolean) {
    const set = new Set(open);
    if (next) set.add(key);
    else set.delete(key);
    if (filterOpen !== null) return setFiltered({ query: needle, open: set });
    sessionExpansion.set(repository, set);
    setStored({ repository, open: set });
  }

  // The shown rows in tree order. While the filter has text, only nodes that hold a match show.
  const rows: Row[] = [];
  const shownNode = (node: Tree) => filterOpen === null || (node.entry !== undefined ? matches(node.entry) : filterOpen.has(node.key));
  const visit = (node: Tree, level: number, kind: Kind, parent: number, pos: number, size: number) => {
    const index = rows.length;
    rows.push({ node, level, kind, parent, pos, size });
    if (node.entry !== undefined || !open.has(node.key)) return;
    const children = node.children.filter(shownNode);
    children.forEach((child, i) => visit(child, level + 1, kind, index, i + 1, children.length));
  };
  const tops = groups.filter((g) => filterOpen === null || filterOpen.has(g.tree.key));
  tops.forEach((g, i) => visit(g.tree, 1, g.kind, -1, i + 1, tops.length));
  const activeIndex = Math.max(0, rows.findIndex((r) => r.node.key === activeKey));
  const anyMatch = filterOpen !== null && filterOpen.size > 0;
  const virtual = rows.length > VIRTUAL_MIN;
  // 001 plan.md "References": an empty group shows its text below its heading.
  const emptyText = (row: Row) => (row.level === 1 && row.node.count === 0 ? GROUPS.find((g) => g.kind === row.kind)!.empty : null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: virtual,
    getScrollElement: () => scrollElement?.() ?? scroller.current,
    scrollMargin: margin,
    estimateSize: (i) => (emptyText(rows[i]!) === null ? rowHeight : 2 * rowHeight),
    getItemKey: (i) => rows[i]!.node.key,
    overscan: 8,
    // React 19 refuses a flushSync from a layout effect, where keyboard navigation scrolls.
    useFlushSync: false,
    // The focused row stays mounted (plan.md "Keyboard and focus").
    rangeExtractor: (range) => {
      const shownRange = defaultRangeExtractor(range);
      return shownRange.includes(activeIndex) ? shownRange : [...shownRange, activeIndex].sort((a, b) => a - b);
    },
  });

  useLayoutEffect(() => {
    const element = scrollElement?.() ?? scroller.current;
    if (!virtual || element === null || tree.current === null) return;
    const next = tree.current.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    if (next !== margin) setMargin(next);
  });

  // plan.md D6: keyboard navigation scrolls the target row into the window before it moves focus.
  useLayoutEffect(() => {
    const key = toFocus.current;
    const element = key === null ? undefined : elements.current.get(key);
    if (!element) return;
    toFocus.current = null;
    element.focus();
  });

  function focusRow(index: number) {
    const to = Math.min(rows.length - 1, Math.max(0, index));
    const row = rows[to];
    if (!row) return;
    setActiveKey(row.node.key);
    const element = elements.current.get(row.node.key);
    if (element) return element.focus();
    toFocus.current = row.node.key;
    if (virtual) virtualizer.scrollToIndex(to);
  }

  function activate(row: Row) {
    const entry = row.node.entry;
    if (entry === undefined) return toggle(row.node.key, !open.has(row.node.key));
    const commitId = entry.commitId;
    if (commitId === null) return;
    void onSelectCommit(commitId).then((target) =>
      setMissing((old) => {
        const next = new Map(old);
        if (target === "none" || target === "unknown") next.set(commitId, target);
        else next.delete(commitId);
        return next;
      }),
    );
  }

  const isCurrent = (row: Row) => row.kind === "branch" && row.node.entry !== undefined && refs?.current?.name === row.node.entry.name;
  // Feature 004: a branch row without a symbolic target has the branch actions.
  const actionable = (row: Row) => onBranchAction !== undefined && (row.kind === "branch" || row.kind === "remote") && row.node.entry !== undefined && row.node.entry.symref === null;
  const branchAction = (row: Row, action: "menu" | "confirm" | ScopedAction, byKey = false) => {
    const element = elements.current.get(row.node.key);
    if (element !== undefined) onBranchAction!(row.node.entry!, action, element, byKey);
  };
  // Spec FR-049: the item shows only on the current branch, so no other row opens a menu.
  const openMenu = (row: Row, byKey = false) => {
    if (actionable(row)) branchAction(row, "menu", byKey);
    else if (onShowBranchHistory !== undefined && isCurrent(row)) setMenu({ key: row.node.key, byKey });
  };

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>, index: number) {
    const row = rows[index]!;
    // Feature 005 plan.md D15 keyboard map: Escape closes an open branch card, and the focus stays on the row.
    if (event.key === "Escape" && card?.key === row.node.key) {
      event.preventDefault();
      return setCard(null);
    }
    // Feature 004 plan.md D15 keyboard map: the branch keys act only on the focused branch row.
    const scoped = actionable(row) ? scopedAction(event.nativeEvent, row.kind === "branch" ? "localBranchRow" : "remoteBranchRow") : null;
    if (scoped !== null) {
      event.preventDefault();
      return branchAction(row, scoped);
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    // Windows sends Shift+F10 and the Menu key to the focused element.
    if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
      event.preventDefault();
      return openMenu(row, true);
    }
    if (event.shiftKey) return;
    const branch = row.node.entry === undefined;
    const isOpen = branch && open.has(row.node.key);
    const moves: Record<string, () => void> = {
      ArrowDown: () => focusRow(index + 1),
      ArrowUp: () => focusRow(index - 1),
      Home: () => focusRow(0),
      End: () => focusRow(rows.length - 1),
      ArrowRight: () => (!branch ? undefined : isOpen ? focusRow(index + 1) : toggle(row.node.key, true)),
      ArrowLeft: () => (isOpen ? toggle(row.node.key, false) : row.parent >= 0 ? focusRow(row.parent) : undefined),
      Enter: () => activate(row),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    move();
  }

  const rowView = (row: Row, index: number, style?: CSSProperties) => {
    const { node, level, kind } = row;
    const common = {
      ref: (element: HTMLElement | null) => void (element ? elements.current.set(node.key, element) : elements.current.delete(node.key)),
      role: "treeitem",
      "aria-level": level,
      "aria-posinset": row.pos,
      "aria-setsize": row.size,
      tabIndex: index === activeIndex ? 0 : -1,
      onFocus: () => setActiveKey(node.key),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => onKeyDown(event, index),
      onContextMenu: (event: { preventDefault(): void }) => {
        event.preventDefault();
        openMenu(row);
      },
      onClick: () => activate(row),
      onDoubleClick: actionable(row) ? () => branchAction(row, "confirm") : undefined,
      style: { paddingLeft: 4 + (level - 1) * 12, ...style },
    };
    const entry = node.entry;
    if (entry === undefined) {
      const expanded = open.has(node.key);
      const group = level === 1;
      // A virtual row has an absolute position, so a group heading row cannot stick.
      const sticky = group && !virtual ? "sticky top-0 z-[1]" : "";
      return (
        <div
          key={node.key}
          {...common}
          aria-expanded={expanded}
          aria-label={group ? `${node.label}, ${node.count}` : `${node.label}, folder, ${node.count}`}
          aria-describedby={group && node.count === 0 ? emptyId(kind) : undefined}
          className={`list-row flex min-w-0 items-center gap-1 pr-2 ${sticky} ${group ? "bg-surface font-semibold" : ""}`}
        >
          <HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
          <span aria-hidden="true" className="min-w-0 truncate">
            {node.label}
          </span>
          <span aria-hidden="true" className="num ml-auto shrink-0 text-muted-text">
            {node.count}
          </span>
        </div>
      );
    }
    const noun = GROUPS.find((g) => g.kind === kind)!.noun;
    const current = isCurrent(row);
    const upstream = upstreamText(entry);
    const notShown = entry.commitId === null ? undefined : missing.get(entry.commitId);
    // Feature 005 spec FR-064: the gone mark replaces the 003 "Upstream gone" label of the row.
    const gone = kind === "branch" && isGone(entry.upstream, entry.upstreamPresent);
    const track = kind === "branch" && !gone ? (tracking?.get(entry.name) ?? null) : null;
    // Feature 004 spec FR-008 and the 003 FR-020 change: "No upstream" is part of the name of a local branch row, never visible text.
    const noUpstream = kind === "branch" && entry.upstream === null;
    const name =
      entry.symref === null
        ? [entry.name, noun, ...(current ? ["Current"] : []), ...(upstream === null ? [] : [upstream]), ...(gone ? [UPSTREAM_GONE_NAME] : []), ...(noUpstream ? [NO_UPSTREAM] : track === null ? [] : [track.label])].join(", ")
        : `${entry.name}, ${noun}, → ${shortRef(entry.symref)}`;
    // Feature 005 spec FR-065: the branch and remote rows without a symbolic target have the card.
    const carded = (kind === "branch" || kind === "remote") && entry.symref === null;
    const cardOpen = carded && card?.key === node.key;
    const describedBy = [notShown === undefined ? null : ids[notShown], cardOpen ? ids.card : null].filter((id) => id !== null).join(" ") || undefined;
    const view = (
      <div
        key={node.key}
        {...common}
        {...(carded
          ? {
              // Spec FR-065: a keyboard focus opens the card of a cut name at once.
              onFocus: (event: ReactFocusEvent<HTMLElement>) => {
                setActiveKey(node.key);
                if (event.currentTarget.matches(":focus-visible") && isCut([event.currentTarget.querySelector(NAME_SLOT)])) setCard({ key: node.key, instant: true });
              },
              onBlur: () => setCard((open) => (open?.key === node.key ? null : open)),
            }
          : {})}
        aria-label={name}
        aria-describedby={describedBy}
        aria-haspopup={actionable(row) || (current && onShowBranchHistory !== undefined) ? "menu" : undefined}
        aria-current={current ? "true" : undefined}
        className="list-row flex min-w-0 items-center gap-2 pr-2"
      >
        {entry.symref === null ? (
          <>
            {/* Git Extensions shows the current branch in bold. The weight survives forced colors. */}
            <span data-slot="ref-name" aria-hidden="true" className={current ? "min-w-0 shrink truncate font-semibold" : "min-w-0 shrink truncate"}>
              {node.label}
            </span>
            {gone ? <GoneMark upstream={shortRef(entry.upstream!)} /> : null}
            {upstream === null ? null : (
              <span aria-hidden="true" className="min-w-0 shrink-[1000] truncate text-muted-text">
                {upstream}
              </span>
            )}
            {track === null || noUpstream ? null : (
              <span aria-hidden="true" title={`${track.label}. ${COUNTS_TOOLTIP}`} className="num ml-auto shrink-0 whitespace-nowrap">
                {track.text}
              </span>
            )}
          </>
        ) : (
          <span aria-hidden="true" className="min-w-0 truncate">
            {node.label} → {shortRef(entry.symref)}
          </span>
        )}
      </div>
    );
    if (!carded) return view;
    const holder = held?.get(`refs/heads/${entry.name}`);
    const facts: CardFacts =
      kind === "remote"
        ? { kind: "name", name: entry.name }
        : {
            kind: "local",
            name: entry.name,
            upstream: entry.upstream === null ? null : shortRef(entry.upstream),
            upstreamPresent: entry.upstreamPresent,
            track: tracking?.get(entry.name) ?? null,
            // Spec FR-066: only another worktree. The open worktree holds the current branch.
            heldBy: held === null || entry.invalidUtf8 ? undefined : current ? null : (holder?.heldBy ?? null),
          };
    return (
      <BranchCard
        key={node.key}
        facts={facts}
        id={ids.card}
        open={cardOpen}
        instant={cardOpen && card?.instant === true}
        onOpenChange={(next) => setCard(next ? { key: node.key, instant: false } : (open) => (open?.key === node.key ? null : open))}
        names={() => [elements.current.get(node.key)?.querySelector(NAME_SLOT)]}
        trigger={view}
      />
    );
  };

  const treeRows = () => {
    if (virtual)
      return (
        <div role="presentation" className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            const place = { position: "absolute", top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start - margin}px)` } as const;
            const empty = emptyText(row);
            if (empty === null) return rowView(row, item.index, place);
            // A virtual item has one fixed height, so the empty text takes one row and ends with "…" when it does not fit.
            return (
              <div key={row.node.key} role="none" style={place}>
                {rowView(row, item.index, { height: rowHeight })}
                <p id={emptyId(row.kind)} aria-hidden="true" title={empty} className="truncate pr-2 pl-4 text-muted-text" style={{ height: rowHeight, lineHeight: `${rowHeight}px` }}>
                  {empty}
                </p>
              </div>
            );
          })}
        </div>
      );
    // Each group wraps its rows, so its heading row sticks only while the group scrolls.
    const byGroup = GROUPS.map((g) => rows.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === g.kind));
    return byGroup.map((list, i) =>
      list.length === 0 ? null : (
        <div key={GROUPS[i]!.kind} role="none" className="flex flex-col">
          {list.map(({ row, index }) => rowView(row, index))}
          {/* 001 plan.md "References": the empty text belongs to its group. The heading row names it as its description. */}
          {list[0]!.row.node.count === 0 ? (
            <p id={emptyId(GROUPS[i]!.kind)} aria-hidden="true" className="pr-2 pl-4 text-muted-text">
              {GROUPS[i]!.empty}
            </p>
          ) : null}
        </div>
      ),
    );
  };

  const body = () => {
    if (failure !== null && refs === null)
      return (
        <div role="alert" className="flex flex-col items-start gap-2 p-2">
          <p className="flex items-start gap-2">
            <HugeiconsIcon icon={CancelCircleIcon} strokeWidth={2} aria-hidden="true" className="mt-0.5 size-(--icon-size) shrink-0 text-removed" />
            <span>{refusalText(failure)}</span>
          </p>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            Refresh (F5)
          </Button>
        </div>
      );
    if (refs === null) return <p className="p-2 text-muted-text">{LOADING}</p>;
    return (
      <>
        <div ref={tree} role="tree" aria-labelledby={ids.heading} className="flex flex-col px-1">
          {treeRows()}
        </div>
        {needle !== "" && !anyMatch ? <p className="px-2 text-muted-text">{NO_MATCH}</p> : null}
        <span id={ids.none} hidden>
          {NOT_SHOWN.none}
        </span>
        <span id={ids.unknown} hidden>
          {NOT_SHOWN.unknown}
        </span>
      </>
    );
  };

  const anchor = menu === null ? undefined : elements.current.get(menu.key);
  return (
    <section aria-labelledby={ids.heading} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h2 id={ids.heading} className="mr-auto font-semibold">
          References
        </h2>
        {collapsible ? <IconButton icon={SidebarLeftIcon} label="Show references" aria-expanded={shown} onClick={() => (onExpandedChange ?? setOwnShown)(!shown)} /> : null}
      </div>
      {shown ? (
        <>
          <input
            type="search"
            aria-label="Filter references"
            className="mx-2 mb-1 h-(--h-button) shrink-0 rounded-sm border border-control-border bg-surface px-2"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFiltered(null);
            }}
          />
          <div ref={scroller} data-references-scroll={scrollElement === undefined ? "" : undefined} className={scrollElement === undefined ? "min-h-0 flex-1 overflow-y-auto" : "min-h-0 flex-1"}>
            {body()}
            {after}
          </div>
        </>
      ) : null}
      {onShowBranchHistory === undefined ? null : (
        // Plan.md D15 "Branch menu": the accessible name is "Actions for <branch>".
        <ActionMenu
          label={`Actions for ${refs?.current?.name ?? ""}`}
          groups={[[{ label: SHOW_BRANCH_HISTORY, keys: { aria: "Control+Shift+B", text: "Ctrl+Shift+B" }, onSelect: () => (setMenu(null), onShowBranchHistory()) }]]}
          open={anchor !== undefined}
          onOpenChange={(next) => void (next || setMenu(null))}
          anchor={anchor}
          byKey={menu?.byKey}
          finalFocus={{ current: anchor ?? null }}
        />
      )}
    </section>
  );
}
