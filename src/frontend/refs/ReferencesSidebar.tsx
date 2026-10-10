// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { CancelCircleIcon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
};

type Node = { id: string; level: 1 | 2; kind: Kind; entry?: RefEntry };

export function ReferencesSidebar({ refs, failure, unpaired, loaded, onSelectCommit, onRefresh, collapsible = false }: ReferencesSidebarProps) {
  const ids = { heading: useId(), node: useId(), notLoaded: useId() };
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<Kind>>(new Set());
  // The toggle state lasts for the window session and is not stored (plan.md "References sidebar").
  const [shown, setShown] = useState(!collapsible);
  const [activeId, setActiveId] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());

  const needle = query.toLowerCase();
  const matches = (entry: RefEntry) => entry.name.toLowerCase().includes(needle);
  const groups = GROUPS.map((g) => {
    const all = refs?.refs.filter((r) => r.kind === g.kind) ?? [];
    return { ...g, all, shown: all.filter(matches) };
  });
  const nodes: Node[] = [];
  groups.forEach((g, gi) => {
    nodes.push({ id: `${ids.node}-g${gi}`, level: 1, kind: g.kind });
    if (!collapsed.has(g.kind)) g.shown.forEach((entry, i) => nodes.push({ id: `${ids.node}-g${gi}-${i}`, level: 2, kind: g.kind, entry }));
  });
  const activeIndex = Math.max(0, nodes.findIndex((n) => n.id === activeId));
  const anyMatch = groups.some((g) => g.shown.length > 0);

  function focusNode(index: number) {
    const node = nodes[Math.min(nodes.length - 1, Math.max(0, index))];
    if (!node) return;
    setActiveId(node.id);
    elements.current.get(node.id)?.focus();
  }

  function setGroup(kind: Kind, open: boolean) {
    setCollapsed((c) => {
      const next = new Set(c);
      if (open) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function activate(node: Node) {
    const commit = node.entry?.commitId ?? null;
    if (commit !== null && loaded.has(commit)) onSelectCommit(commit);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>, index: number) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    const node = nodes[index]!;
    const open = node.level === 1 && !collapsed.has(node.kind);
    const parent = nodes.findLastIndex((n, i) => i <= index && n.level === 1);
    const moves: Record<string, () => void> = {
      ArrowDown: () => focusNode(index + 1),
      ArrowUp: () => focusNode(index - 1),
      Home: () => focusNode(0),
      End: () => focusNode(nodes.length - 1),
      ArrowRight: () => (node.level === 1 ? (open ? focusNode(index + 1) : setGroup(node.kind, true)) : undefined),
      ArrowLeft: () => (node.level === 2 ? focusNode(parent) : setGroup(node.kind, false)),
      Enter: () => activate(node),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    move();
  }

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
        {unpaired === 0 ? null : <p className="px-2 text-muted-text">{unpaired === 1 ? UNPAIRED : STILL_UNPAIRED}</p>}
        <div role="tree" aria-labelledby={ids.heading} className="flex flex-col px-1">
          {nodes.map((node, index) => {
            const tabIndex = index === activeIndex ? 0 : -1;
            const common = {
              id: node.id,
              ref: (element: HTMLElement | null) => void (element ? elements.current.set(node.id, element) : elements.current.delete(node.id)),
              role: "treeitem",
              "aria-level": node.level,
              tabIndex,
              onFocus: () => setActiveId(node.id),
              onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => onKeyDown(event, index),
              onContextMenu: (event: { preventDefault(): void }) => event.preventDefault(),
            };
            if (node.level === 1) {
              const group = groups.find((g) => g.kind === node.kind)!;
              return (
                <div key={node.id} {...common} aria-expanded={!collapsed.has(node.kind)} aria-label={`${group.label}, ${group.all.length}`} className="list-row flex items-center gap-2 px-1 font-semibold" onClick={() => setGroup(node.kind, collapsed.has(node.kind))}>
                  <span aria-hidden="true">{group.label}</span>
                  <span aria-hidden="true" className="num ml-auto text-muted-text">
                    {group.all.length}
                  </span>
                </div>
              );
            }
            const entry = node.entry!;
            const group = groups.find((g) => g.kind === node.kind)!;
            const current = entry.kind === "branch" && refs.current !== null && refs.current.name === entry.name;
            const upstream = upstreamText(entry);
            const onPage = entry.commitId !== null && loaded.has(entry.commitId);
            const name = entry.symref === null ? [entry.name, group.noun, ...(current ? ["Current"] : []), ...(upstream === null ? [] : [upstream])].join(", ") : `${entry.name}, ${group.noun}, → ${shortRef(entry.symref)}`;
            return (
              <div key={node.id} {...common} aria-label={name} aria-describedby={onPage ? undefined : ids.notLoaded} className="list-row flex min-w-0 items-center gap-2 pr-1 pl-4" onClick={() => activate(node)}>
                {entry.symref === null ? (
                  <>
                    <span aria-hidden="true" className="min-w-0 shrink truncate">
                      {entry.name}
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
                    {entry.name} → {shortRef(entry.symref)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {groups.map((g) => (g.all.length === 0 ? <p key={g.kind} className="px-2 text-muted-text">{g.empty}</p> : null))}
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
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">{body()}</div>
        </>
      ) : null}
    </section>
  );
}
