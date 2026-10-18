// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry } from "../../contracts/envelope";
import { MULTI_FILE_ACTION_FILES } from "../../contracts/limits";

// Feature 004 plan.md D8 "Stage folder", D15 "Virtual tree", data-model §6 "File selection", spec FR-030, FR-031, FR-036.
// The tree splits the path bytes at `/` (0x2F). UTF-8 never holds 0x2F inside a multi-byte sequence, so each folder prefix is exact.

export type Layout = "tree" | "flat";
export type FileRow = { kind: "file"; key: string; depth: number; entry: ChangeEntry };
/** `folder` holds the folder path bytes in base64, as `applyFiles` and the ignore review take them. */
export type FolderRow = { kind: "folder"; key: string; depth: number; name: string; path: string; folder: string; count: number; expanded: boolean; untracked: boolean };
export type SectionRow = { kind: "section"; key: "untracked"; depth: 0; count: number; expanded: boolean };
export type TreeRow = FileRow | FolderRow | SectionRow;
export type FilesKind = "selected" | "folder" | "all-untracked" | "all-changes" | "all-staged";
export type FilesRequest = { direction: "stage" | "unstage"; kind: FilesKind; entryIds: string[]; folder?: string };

const SLASH = "/";
const utf8 = new TextDecoder("utf-8");
// `atob` gives one character per byte, so a byte prefix is a string prefix.
const bytesOf = (entry: ChangeEntry) => atob(entry.pathBytes);
const display = (binary: string) => utf8.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));

type Folder = { name: string; children: Map<string, Folder | ChangeEntry>; count: number };
const isFolder = (node: Folder | ChangeEntry): node is Folder => "children" in node;

/** One tree of `entries` in service order. A folder with one folder child joins it, as "docs/drafts". */
function treeRows(entries: readonly ChangeEntry[], scope: string, depth: number, toggled: ReadonlySet<string>, untracked: boolean, out: TreeRow[]) {
  const root: Folder = { name: "", children: new Map(), count: 0 };
  for (const entry of entries) {
    const parts = bytesOf(entry).split(SLASH);
    let node = root;
    node.count++;
    for (const part of parts.slice(0, -1)) {
      let next = node.children.get(`d${part}`) as Folder | undefined;
      if (next === undefined) node.children.set(`d${part}`, (next = { name: part, children: new Map(), count: 0 }));
      next.count++;
      node = next;
    }
    node.children.set(`f${entry.entryId}`, entry);
  }
  // Untracked folders start collapsed, so 100,000 files below them make no rows (spec FR-030, FR-086).
  const walk = (folder: Folder, prefix: string, level: number) => {
    for (const child of folder.children.values()) {
      if (!isFolder(child)) {
        out.push({ kind: "file", key: child.entryId, depth: level, entry: child });
        continue;
      }
      let node = child;
      let name = node.name;
      while (node.children.size === 1) {
        const only = node.children.values().next().value!;
        if (!isFolder(only)) break;
        node = only;
        name += SLASH + node.name;
      }
      const path = prefix + name;
      const folder = btoa(path);
      const key = `${scope}:${folder}`;
      const expanded = untracked === toggled.has(key);
      out.push({ kind: "folder", key, depth: level, name: display(name), path: display(path), folder, count: node.count, expanded, untracked });
      if (expanded) walk(node, path + SLASH, level + 1);
    }
  };
  walk(root, "", depth);
}

function listRows(entries: readonly ChangeEntry[], layout: Layout, scope: string, depth: number, toggled: ReadonlySet<string>, untracked: boolean, out: TreeRow[]) {
  if (layout === "tree") return treeRows(entries, scope, depth, toggled, untracked, out);
  for (const entry of entries) out.push({ kind: "file", key: entry.entryId, depth, entry });
}

/**
 * The rows of the Changes list: the tracked changes first, then the Untracked section row with its count.
 * The untracked rows build only while the section is open (plan.md D15 "Virtual tree").
 */
export function changesRows(entries: readonly ChangeEntry[], layout: Layout, toggled: ReadonlySet<string>, untrackedOpen: boolean): TreeRow[] {
  const tracked: ChangeEntry[] = [];
  let untracked = 0;
  for (const e of entries) {
    if (e.category === "conflicted" || e.category === "unstaged") tracked.push(e);
    else if (e.category === "untracked") untracked++;
  }
  const out: TreeRow[] = [];
  listRows(tracked, layout, "t", 0, toggled, false, out);
  if (untracked === 0) return out;
  out.push({ kind: "section", key: "untracked", depth: 0, count: untracked, expanded: untrackedOpen });
  if (untrackedOpen) listRows(entries.filter((e) => e.category === "untracked"), layout, "u", 1, toggled, true, out);
  return out;
}

/** The rows of the Staged list. */
export function stagedRows(entries: readonly ChangeEntry[], layout: Layout, toggled: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [];
  listRows(entries.filter((e) => e.category === "staged"), layout, "s", 0, toggled, false, out);
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
