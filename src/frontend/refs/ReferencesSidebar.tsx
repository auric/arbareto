// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowRight01Icon, CancelCircleIcon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { RefEntry, RefsResult } from "../../contracts/envelope";
import type { BridgeResponse } from "../bridge";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";

// FR-057. plan.md "References sidebar", "Long text", "Keyboard and focus" (References sidebar row), "Task flow and command placement" (Browse references),
// "Required visible states" (References), and "Status and fallback texts" (Sidebar texts). Contract §3 "References result". The sidebar is read-only.

type Kind = RefEntry["kind"];
const GROUPS: { kind: Kind; label: string; empty: string; noun: string }[] = [
  { kind: "branch", label: "Branches", empty: "No branches", noun: "local branch" },
  { kind: "remote", label: "Remotes", empty: "No remote-tracking branches", noun: "remote-tracking branch" },
  { kind: "tag", label: "Tags", empty: "No tags", noun: "tag" },
];
const LOADING = "Loading references…";
const NO_MATCH = "No reference matches the filter.";
const NOT_LOADED = "Not in the loaded history page";
const UNPAIRED = "References changed. Arbareto is reading them again.";
const STILL_UNPAIRED = "The history and the references show different HEAD states. Select Refresh (F5).";
const REFUSAL: Record<string, string> = {
  REF_LISTING_RECORDS: "This repository has more than 10,000 references. This version does not list them.",
  REF_LISTING_BYTES: "The reference list is larger than this version can show.",
};

// Contract §3: `symref` and `upstream` are full reference names. Git's namespaces give the short name (git-check-ref-format(1)).
const PREFIXES = ["refs/heads/", "refs/remotes/", "refs/tags/"];
export const shortRef = (name: string) => {
  const prefix = PREFIXES.find((p) => name.startsWith(p));
  return prefix === undefined ? name : name.slice(prefix.length);
};

const upstreamText = (entry: RefEntry) => (entry.upstream === null ? null : `→ ${shortRef(entry.upstream)}${entry.upstreamPresent ? "" : ", not present"}`);

function refusalText(response: BridgeResponse): string {
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
  /** `RequestState.refsUnpaired`. */
  unpaired: number;
  /** The OIDs of the loaded history page. */
  loaded: ReadonlySet<string>;
  /** Selects the history row of a commit on the page and docks its details. Focus stays in the sidebar. */
  onSelectCommit(oid: string): void;
  onRefresh(): void;
  /** The constrained profile: the section starts collapsed to its heading row with the Show references toggle. */
  collapsible?: boolean;
  /** The open repository (its worktree key). The expansion lasts per repository for the window session. */
  repository: string;
};

// plan.md "Keyboard and focus", References sidebar row: the expansion lasts for the window session per repository and is not stored.
const sessionExpansion = new Map<string, ReadonlySet<string>>();

/** One tree node: a group, a folder of one `/` level, or an entry. Keys are unique within the tree. */
type Tree = { key: string; label: string; count: number; children: Tree[]; entry?: RefEntry };
type Row = { node: Tree; level: number; kind: Kind; parent: number };

const groupKey = (kind: Kind) => `group:${kind}`;
const folderKey = (kind: Kind, path: string) => `folder:${kind}:${path}`;

/** Git's reference hierarchy (git-check-ref-format(1)): each `/` of a name starts one level. Folders keep the order of their first entry. */
function buildGroup(kind: Kind, label: string, entries: readonly RefEntry[]): Tree {
  const root: Tree = { key: groupKey(kind), label, count: 0, children: [] };
  for (const entry of entries) {
    const segments = entry.name.split("/");
    let at = root;
    root.count++;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = folderKey(kind, segments.slice(0, i + 1).join("/"));
      let folder = at.children.find((c) => c.key === key);
      if (folder === undefined) {
        folder = { key, label: segments[i]!, count: 0, children: [] };
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

export function ReferencesSidebar({ refs, failure, unpaired, loaded, onSelectCommit, onRefresh, collapsible = false, repository }: ReferencesSidebarProps) {
  const ids = { heading: useId(), node: useId(), notLoaded: useId() };
  const [query, setQuery] = useState("");
  // Null until the user changes the expansion: the default then follows the current branch of the newest result.
  const [stored, setStored] = useState<{ repository: string; open: ReadonlySet<string> | null }>(() => ({ repository, open: sessionExpansion.get(repository) ?? null }));
  if (stored.repository !== repository) setStored({ repository, open: sessionExpansion.get(repository) ?? null });
  // Toggles while the filter has text change only this set. Clearing the filter drops it.
  const [filtered, setFiltered] = useState<{ query: string; open: ReadonlySet<string> } | null>(null);
  // The toggle state lasts for the window session and is not stored (plan.md "References sidebar").
  const [shown, setShown] = useState(!collapsible);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());

  const needle = query.toLowerCase();
  const matches = (entry: RefEntry) => entry.name.toLowerCase().includes(needle);
  const groups = GROUPS.map((g) => ({ ...g, tree: buildGroup(g.kind, g.label, refs?.refs.filter((r) => r.kind === g.kind) ?? []) }));
  const filterOpen = useMemo(() => {
    if (needle === "") return null;
    const open = new Set<string>();
    for (const g of groups) matchingPaths(g.tree, matches, open);
    return open;
  }, [needle, refs]);
  const open: ReadonlySet<string> = filterOpen !== null ? (filtered !== null && filtered.query === needle ? filtered.open : filterOpen) : (stored.open ?? defaultExpansion(refs?.current ?? null));

  function toggle(key: string, next: boolean) {
    const set = new Set(open);
    if (next) set.add(key);
    else set.delete(key);
    if (filterOpen !== null) return setFiltered({ query: needle, open: set });
    sessionExpansion.set(repository, set);
    setStored({ repository, open: set });
  }

  // The visible rows in tree order. While the filter has text, only nodes that hold a match show.
  const rows: Row[] = [];
  const visit = (node: Tree, level: number, kind: Kind, parent: number) => {
    if (filterOpen !== null && level > 1 && !(node.entry !== undefined ? matches(node.entry) : filterOpen.has(node.key))) return;
    const index = rows.length;
    rows.push({ node, level, kind, parent });
    if (node.entry === undefined && open.has(node.key)) for (const child of node.children) visit(child, level + 1, kind, index);
  };
  for (const g of groups) if (filterOpen === null || filterOpen.has(g.tree.key)) visit(g.tree, 1, g.kind, -1);
  const activeIndex = Math.max(0, rows.findIndex((r) => r.node.key === activeKey));
  const anyMatch = filterOpen !== null && filterOpen.size > 0;

  function focusRow(index: number) {
    const row = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!row) return;
    setActiveKey(row.node.key);
    elements.current.get(row.node.key)?.focus();
  }

  function activate(row: Row) {
    const entry = row.node.entry;
    if (entry === undefined) return toggle(row.node.key, !open.has(row.node.key));
    if (entry.commitId !== null && loaded.has(entry.commitId)) onSelectCommit(entry.commitId);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>, index: number) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    const row = rows[index]!;
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

  const rowView = (row: Row, index: number) => {
    const { node, level, kind } = row;
    const common = {
      ref: (element: HTMLElement | null) => void (element ? elements.current.set(node.key, element) : elements.current.delete(node.key)),
      role: "treeitem",
      "aria-level": level,
      tabIndex: index === activeIndex ? 0 : -1,
      onFocus: () => setActiveKey(node.key),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => onKeyDown(event, index),
      onContextMenu: (event: { preventDefault(): void }) => event.preventDefault(),
      onClick: () => activate(row),
      style: { paddingLeft: 4 + (level - 1) * 12 },
    };
    const entry = node.entry;
    if (entry === undefined) {
      const expanded = open.has(node.key);
      const group = level === 1;
      return (
        <div
          key={node.key}
          {...common}
          aria-expanded={expanded}
          aria-label={group ? `${node.label}, ${node.count}` : `${node.label}, folder, ${node.count}`}
          className={`list-row flex min-w-0 items-center gap-1 pr-2 ${group ? "sticky top-0 z-[1] bg-surface font-semibold" : ""}`}
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
    const current = kind === "branch" && refs?.current !== null && refs?.current?.name === entry.name;
    const upstream = upstreamText(entry);
    const onPage = entry.commitId !== null && loaded.has(entry.commitId);
    const name = entry.symref === null ? [entry.name, noun, ...(current ? ["Current"] : []), ...(upstream === null ? [] : [upstream])].join(", ") : `${entry.name}, ${noun}, → ${shortRef(entry.symref)}`;
    return (
      <div key={node.key} {...common} aria-label={name} aria-describedby={onPage ? undefined : ids.notLoaded} className="list-row flex min-w-0 items-center gap-2 pr-2">
        {entry.symref === null ? (
          <>
            <span aria-hidden="true" className="min-w-0 shrink truncate">
              {node.label}
            </span>
            {current ? (
              <span aria-hidden="true" className="shrink-0 font-semibold">
                Current
              </span>
            ) : null}
            {upstream === null ? null : (
              <span aria-hidden="true" className="min-w-0 shrink-[1000] truncate text-muted-text">
                {upstream}
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
    // Each group wraps its rows, so its heading row sticks only while the group scrolls.
    const byGroup = GROUPS.map((g) => rows.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === g.kind));
    return (
      <>
        {unpaired === 0 ? null : <p className="px-2 text-muted-text">{unpaired === 1 ? UNPAIRED : STILL_UNPAIRED}</p>}
        <div role="tree" aria-labelledby={ids.heading} className="flex flex-col px-1">
          {byGroup.map((list, i) =>
            list.length === 0 ? null : (
              <div key={GROUPS[i]!.kind} role="none" className="flex flex-col">
                {list.map(({ row, index }) => rowView(row, index))}
              </div>
            ),
          )}
        </div>
        {groups.map((g) => (g.tree.count === 0 ? <p key={g.kind} className="px-2 text-muted-text">{g.empty}</p> : null))}
        {needle !== "" && !anyMatch ? <p className="px-2 text-muted-text">{NO_MATCH}</p> : null}
        <span id={ids.notLoaded} hidden>
          {NOT_LOADED}
        </span>
      </>
    );
  };

  return (
    <section aria-labelledby={ids.heading} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <h2 id={ids.heading} className="mr-auto font-semibold">
          References
        </h2>
        {collapsible ? <IconButton icon={SidebarLeftIcon} label="Show references" aria-expanded={shown} onClick={() => setShown((s) => !s)} /> : null}
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
          <div className="min-h-0 flex-1 overflow-y-auto">{body()}</div>
        </>
      ) : null}
    </section>
  );
}
