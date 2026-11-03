// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry } from "../../contracts/envelope";
import { MULTI_FILE_ACTION_FILES } from "../../contracts/limits";
import { compareKeys, treeKey } from "../../contracts/tree-order";

// Feature 004 plan.md D8 "Stage folder", D15 "Virtual tree", data-model §6 "File selection", spec FR-030, FR-031, FR-036.
// The tree splits the path bytes at `/` (0x2F). UTF-8 never holds 0x2F inside a multi-byte sequence, so each folder prefix is exact.

export type Layout = "tree" | "flat";
/** `pos` and `size` are the 1-based position and the set size of the row among its siblings (WAI-ARIA `aria-posinset`, `aria-setsize`). */
type Place = { pos: number; size: number };
/** `key` is the path bytes: each full status read gives each file a new entry ID, and the row must stay mounted. */
export type FileRow = { kind: "file"; key: string; depth: number; entry: ChangeEntry } & Place;
/** `folder` holds the folder path bytes in base64, as `applyFiles` and the ignore review take them. */
export type FolderRow = { kind: "folder"; key: string; depth: number; name: string; path: string; folder: string; count: number; expanded: boolean; untracked: boolean } & Place;
export type SectionRow = { kind: "section"; key: "untracked"; depth: 0; count: number; expanded: boolean } & Place;
export type TreeRow = FileRow | FolderRow | SectionRow;
export type FilesKind = "selected" | "folder" | "all-untracked" | "all-changes" | "all-staged";
export type FilesRequest = { direction: "stage" | "unstage"; kind: FilesKind; entryIds: string[]; folder?: string };

const SLASH = "/";
const utf8 = new TextDecoder("utf-8");
// `atob` gives one character per byte, so a byte prefix is a string prefix.
const bytesOf = (entry: ChangeEntry) => atob(entry.pathBytes);
const display = (binary: string) => utf8.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));

/**
 * `entries` holds every entry below the folder in tree order, and `bytes[i]` the decoded path of `entries[i]`.
 * `offset` is the byte length of the folder path with its `/`. `children` builds on first use.
 */
type Folder = { name: string; entries: ChangeEntry[]; bytes: string[]; offset: number; children?: Map<string, Folder | ChangeEntry> };
const isFolder = (node: Folder | ChangeEntry): node is Folder => "offset" in node;
const folderOf = (name: string, offset: number): Folder => ({ name, entries: [], bytes: [], offset });
// Spec SC-009, quickstart Q32: one level per call, so a collapsed folder costs no work below its children.
function childrenOf(folder: Folder): Map<string, Folder | ChangeEntry> {
  if (folder.children !== undefined) return folder.children;
  const children = new Map<string, Folder | ChangeEntry>();
  const { entries, bytes, offset } = folder;
  // `run` is the child folder of the previous entry. Its prefix ends with `/`, so a match is the same child folder.
  let run: { prefix: string; node: Folder } | undefined;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const path = bytes[i]!;
    if (run === undefined || !path.startsWith(run.prefix, offset)) {
      const end = path.indexOf(SLASH, offset);
      if (end < 0) {
        children.set(`f${entry.entryId}`, entry);
        continue;
      }
      const name = path.slice(offset, end);
      let node = children.get(`d${name}`) as Folder | undefined;
      if (node === undefined) children.set(`d${name}`, (node = folderOf(name, end + 1)));
      run = { prefix: name + SLASH, node };
    }
    run.node.entries.push(entry);
    run.node.bytes.push(path);
  }
  return (folder.children = children);
}

type Lists = { conflicted: Folder; tracked: Folder; untracked: Folder; staged: Folder };
// Feature 005 plan.md D4 "Cost": one key per entry and one sort per status read, so the cache holds each read's entries array.
// Each read decodes each path once. The lists keep the decoded paths and the built folder levels (spec SC-009).
const ordered = new WeakMap<readonly ChangeEntry[], Lists>();
/** Feature 005 spec FR-015, FR-016, data-model §3: a submodule (`<sub>` starts with `S`) and a nested repository (a path that ends with `/`) sort as folders. */
function inTreeOrder(entries: readonly ChangeEntry[]): Lists {
  let lists = ordered.get(entries);
  if (lists !== undefined) return lists;
  const keyed = entries.map((entry) => {
    const bytes = bytesOf(entry);
    const raw = Uint8Array.from(bytes, (c) => c.charCodeAt(0));
    const nested = raw.at(-1) === 0x2f;
    return { entry, bytes, key: treeKey(nested ? raw.subarray(0, -1) : raw, nested || entry.submodule?.startsWith("S") === true) };
  });
  lists = { conflicted: folderOf("", 0), tracked: folderOf("", 0), untracked: folderOf("", 0), staged: folderOf("", 0) };
  for (const { entry, bytes } of keyed.sort((a, b) => compareKeys(a.key, b.key))) {
    const list = entry.category === "staged" ? lists.staged : entry.category === "untracked" ? lists.untracked : entry.category === "conflicted" ? lists.conflicted : lists.tracked;
    list.entries.push(entry);
    list.bytes.push(bytes);
  }
  ordered.set(entries, lists);
  return lists;
}

/** Spec FR-101: the rows that Filter files shows. Without it, every entry shows. */
export type Keep = (entry: ChangeEntry) => boolean;

/**
 * One tree of `entries` in their given order. A folder with one folder child joins it, as "docs/drafts". `extra` siblings follow the top level. It returns the top-level count.
 * Folder counts stay the counts of the status read. `keep` hides the files that it rejects, and the folders without a kept file.
 */
function treeRows(root: Folder, scope: string, depth: number, toggled: ReadonlySet<string>, untracked: boolean, out: TreeRow[], extra: number, keep?: Keep): number {
  const shownChildren = (folder: Folder) => {
    const all = [...childrenOf(folder).values()];
    return keep === undefined ? all : all.filter((child) => (isFolder(child) ? child.entries.some(keep) : keep(child)));
  };
  // Untracked folders start collapsed, so 100,000 files below them make no rows (spec FR-030, FR-086).
  const walk = (folder: Folder, prefix: string, level: number, more: number) => {
    const children = shownChildren(folder);
    const size = children.length + more;
    let pos = 0;
    for (const child of children) {
      pos++;
      if (!isFolder(child)) {
        out.push({ kind: "file", key: child.pathBytes, depth: level, entry: child, pos, size });
        continue;
      }
      let node = child;
      let name = node.name;
      for (let only = childrenOf(node); only.size === 1; only = childrenOf(node)) {
        const next = only.values().next().value!;
        if (!isFolder(next)) break;
        node = next;
        name += SLASH + node.name;
      }
      const path = prefix + name;
      const folder = btoa(path);
      const key = `${scope}:${folder}`;
      const expanded = untracked === toggled.has(key);
      out.push({ kind: "folder", key, depth: level, name: display(name), path: display(path), folder, count: node.entries.length, expanded, untracked, pos, size });
      if (expanded) walk(node, path + SLASH, level + 1, 0);
    }
    return children.length;
  };
  return walk(root, "", depth, extra);
}

function listRows(list: Folder, layout: Layout, scope: string, depth: number, toggled: ReadonlySet<string>, untracked: boolean, out: TreeRow[], extra = 0, keep?: Keep): number {
  if (layout === "tree") return treeRows(list, scope, depth, toggled, untracked, out, extra, keep);
  const shown = keep === undefined ? list.entries : list.entries.filter(keep);
  shown.forEach((entry, i) => out.push({ kind: "file", key: entry.pathBytes, depth, entry, pos: i + 1, size: shown.length + extra }));
  return shown.length;
}

/**
 * The rows of the Changes list: the tracked changes first, then the Untracked section row with its count. Conflicted entries go to `conflictedRows`.
 * The untracked rows build only while the section is open (plan.md D15 "Virtual tree"). `keep` filters only these shown rows (spec FR-101).
 */
export function changesRows(entries: readonly ChangeEntry[], layout: Layout, toggled: ReadonlySet<string>, untrackedOpen: boolean, keep?: Keep): TreeRow[] {
  const { tracked, untracked } = inTreeOrder(entries);
  const out: TreeRow[] = [];
  // The Untracked section row is the last sibling of the tracked top level.
  const top = listRows(tracked, layout, "t", 0, toggled, false, out, untracked.entries.length === 0 ? 0 : 1, keep);
  if (untracked.entries.length === 0) return out;
  out.push({ kind: "section", key: "untracked", depth: 0, count: untracked.entries.length, expanded: untrackedOpen, pos: top + 1, size: top + 1 });
  if (untrackedOpen) listRows(untracked, layout, "u", 1, toggled, true, out, 0, keep);
  return out;
}

/** Feature 004 spec FR-104: the rows of the Conflicted section, flat with full paths in tree order. Filter files never hides them. */
export function conflictedRows(entries: readonly ChangeEntry[]): TreeRow[] {
  const out: TreeRow[] = [];
  listRows(inTreeOrder(entries).conflicted, "flat", "c", 0, new Set(), false, out);
  return out;
}

/** The rows of the Staged list. */
export function stagedRows(entries: readonly ChangeEntry[], layout: Layout, toggled: ReadonlySet<string>, keep?: Keep): TreeRow[] {
  const out: TreeRow[] = [];
  listRows(inTreeOrder(entries).staged, layout, "s", 0, toggled, false, out, 0, keep);
  return out;
}

/** Plan.md D8: the entries of the list whose path starts with the folder path and `/`. Stage takes the Changes list, and unstage the Staged list. */
export function folderEntries(entries: readonly ChangeEntry[], folder: string, direction: "stage" | "unstage"): ChangeEntry[] {
  const prefix = atob(folder) + SLASH;
  return entries.filter((e) => (direction === "unstage") === (e.category === "staged") && bytesOf(e).startsWith(prefix));
}

/** The `applyFiles` request of a derived kind (plan.md D8): every entry of that set in the shown read. */
export function derivedRequest(entries: readonly ChangeEntry[], kind: Exclude<FilesKind, "selected">, folder?: { folder: string; direction: "stage" | "unstage" }): FilesRequest {
  if (kind === "folder") return { direction: folder!.direction, kind, entryIds: folderEntries(entries, folder!.folder, folder!.direction).map((e) => e.entryId), folder: folder!.folder };
  const picked = entries.filter((e) => (kind === "all-staged" ? e.category === "staged" : kind === "all-untracked" ? e.category === "untracked" : e.category !== "staged"));
  return { direction: kind === "all-staged" ? "unstage" : "stage", kind, entryIds: picked.map((e) => e.entryId) };
}

/** Spec FR-040: the action stays unavailable above `MULTI_FILE_ACTION_FILES`. */
export const overLimit = (request: FilesRequest) => request.entryIds.length > MULTI_FILE_ACTION_FILES;

const count = new Intl.NumberFormat("en-US");
/** Spec FR-048: "3 staged files. 1,258 changes, 1,248 of them untracked." A cut read states its counts as lower bounds (plan.md D15). */
export function countsText(entries: readonly ChangeEntry[], cut: boolean): string {
  let staged = 0;
  let changes = 0;
  let untracked = 0;
  for (const e of entries) {
    if (e.category === "staged") staged++;
    else {
      changes++;
      if (e.category === "untracked") untracked++;
    }
  }
  const least = cut ? "at least " : "";
  const files = `${count.format(staged)} staged ${staged === 1 ? "file" : "files"}.`;
  const total = `${cut ? "At least " : ""}${count.format(changes)} ${changes === 1 ? "change" : "changes"}`;
  return `${files} ${total}, ${least}${count.format(untracked)} of them untracked.`;
}
export const formatCount = (n: number) => count.format(n);
