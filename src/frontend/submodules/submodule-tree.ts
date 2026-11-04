// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { SUBMODULE_TREE_FOLDERS } from "../../contracts/limits";
import type { SubmoduleBranch, SubmodulePlanRow } from "../../contracts/submodules";
import { compareStringKeys, treeStringKey } from "../../contracts/tree-order";

// Feature 004 spec FR-107 to FR-111, plan D20 "Tree builder", data-model §12 "Tree node". It never depends on the service row order.

/** A row result with `found` and no plan row: it shows its full path at the end of the root level. */
export type FoundRow = { rowId: string; path: string };
export type TreeInput = {
  rows: readonly SubmodulePlanRow[];
  found: readonly FoundRow[];
  marks: ReadonlyMap<string, SubmoduleBranch>;
  /** The keys of the closed folder and parent rows. */
  closed: ReadonlySet<string>;
};
/** `parent` is the index of the parent row, or -1. `pos` and `size` are the WAI-ARIA positions among the shown siblings. `open` is null for a row without children. */
type Shown = { key: string; level: number; label: string; path: string; parent: number; pos: number; size: number; open: boolean | null };
export type TreeRow = (Shown & { kind: "folder"; count: number; open: boolean }) | (Shown & { kind: "submodule"; rowId: string; row: SubmodulePlanRow | null; mark: SubmoduleBranch | null });
export type SubmoduleTree = { state: "malformed" } | { state: "tree"; rows: TreeRow[]; bounded: boolean };

type Node =
  | { kind: "folder"; key: string; label: string; path: string; count: number; children: Node[] }
  | { kind: "submodule"; key: string; label: string; path: string; rowId: string; row: SubmodulePlanRow | null; children: Node[] };

const MALFORMED: SubmoduleTree = { state: "malformed" };
const SLASH = "/";
const slashes = (text: string) => text.split(SLASH).length - 1;

export function buildSubmoduleTree({ rows, found, marks, closed }: TreeInput): SubmoduleTree {
  const byId = new Map(rows.map((row) => [row.rowId, row]));
  if (byId.size !== rows.length) return MALFORMED;
  // One UTF-16 code unit per path byte, as `atob` gives (plan D20).
  const bytes = new Map<string, string>();
  const below = new Map<string | null, SubmodulePlanRow[]>();
  for (const row of rows) {
    if (typeof row.path !== "string" || typeof row.pathBytes !== "string" || !Number.isInteger(row.depth)) return MALFORMED;
    let raw: string;
    try {
      raw = atob(row.pathBytes);
    } catch {
      return MALFORMED;
    }
    if (raw === "" || slashes(raw) !== slashes(row.path)) return MALFORMED;
    bytes.set(row.rowId, raw);
    const list = below.get(row.parentRowId) ?? [];
    list.push(row);
    below.set(row.parentRowId, list);
  }
  // Data-model §12 "Checks". The depth rises by one per parent step, so no parent chain has a cycle.
  for (const row of rows) {
    if (row.parentRowId === null) {
      if (row.depth !== 0) return MALFORMED;
      continue;
    }
    const parent = byId.get(row.parentRowId);
    if (parent === undefined || row.depth !== parent.depth + 1) return MALFORMED;
    const base = bytes.get(parent.rowId)!;
    const own = bytes.get(row.rowId)!;
    if (own.length <= base.length + 1 || !own.startsWith(base + SLASH)) return MALFORMED;
  }

  let folders = 0;
  // The rows directly below `parent` (null: the root), with `total` the count of submodule rows in the returned nodes and below them.
  function level(parent: SubmodulePlanRow | null, flat: boolean): { nodes: Node[]; total: number } {
    const base = parent === null ? "" : bytes.get(parent.rowId)! + SLASH;
    const shownBase = parent === null ? 0 : parent.path.split(SLASH).length;
    const sorted = (below.get(parent?.rowId ?? null) ?? [])
      .map((row) => ({ row, local: bytes.get(row.rowId)!.slice(base.length) }))
      .map((entry) => ({ ...entry, order: treeStringKey(entry.local) }))
      .sort((a, b) => compareStringKeys(a.order, b.order));
    const nodes: Node[] = [];
    const made = new Map<string, Extract<Node, { kind: "folder" }>>();
    let total = 0;
    for (const { row, local } of sorted) {
      const parts = local.split(SLASH);
      const shown = row.path.split(SLASH);
      let at = nodes;
      const chain: Extract<Node, { kind: "folder" }>[] = [];
      if (!flat)
        for (let i = 0; i < parts.length - 1; i++) {
          const key = `f:${base}${parts.slice(0, i + 1).join(SLASH)}`;
          let folder = made.get(key);
          if (folder === undefined) {
            folder = { kind: "folder", key, label: shown[shownBase + i]!, path: shown.slice(0, shownBase + i + 1).join(SLASH), count: 0, children: [] };
            made.set(key, folder);
            at.push(folder);
            folders++;
          }
          chain.push(folder);
          at = folder.children;
        }
      const inner = level(row, flat);
      const size = 1 + inner.total;
      for (const folder of chain) folder.count += size;
      total += size;
      const label = flat ? shown.slice(shownBase).join(SLASH) : shown.at(-1)!;
      at.push({ kind: "submodule", key: `s:${row.pathBytes}`, label, path: row.path, rowId: row.rowId, row, children: inner.nodes });
    }
    return { nodes, total };
  }

  let root = level(null, false).nodes;
  const bounded = folders > SUBMODULE_TREE_FOLDERS;
  if (bounded) root = level(null, true).nodes;
  // A found row has no path bytes, so its key uses the row ID.
  for (const row of found) root.push({ kind: "submodule", key: `found:${row.rowId}`, label: row.path, path: row.path, rowId: row.rowId, row: null, children: [] });

  const out: TreeRow[] = [];
  const visit = (nodes: readonly Node[], depth: number, parent: number) =>
    nodes.forEach((node, i) => {
      const index = out.length;
      const open = node.children.length === 0 ? null : !closed.has(node.key);
      const shown = { key: node.key, level: depth, label: node.label, path: node.path, parent, pos: i + 1, size: nodes.length };
      out.push(node.kind === "folder" ? { ...shown, kind: "folder", count: node.count, open: open ?? true } : { ...shown, kind: "submodule", open, rowId: node.rowId, row: node.row, mark: marks.get(node.rowId) ?? null });
      if (open === true) visit(node.children, depth + 1, index);
    });
  visit(root, 1, -1);
  return { state: "tree", rows: out, bounded };
}
