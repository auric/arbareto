// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 T007: folders first in the Changes and Staged trees, their flat layouts, and the References tree (spec FR-015 to FR-017, SC-004, plan.md D4).

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { ChangeEntry, RefEntry, RefsResult } from "../../src/contracts/envelope";
import { registerDom } from "../dom";
import { printOrigin } from "../origin";

printOrigin("../../src/frontend/changes/file-tree.ts", import.meta.dir);
printOrigin("../../src/frontend/refs/ReferencesSidebar.tsx", import.meta.dir);
printOrigin("../../src/contracts/tree-order.ts", import.meta.dir);
registerDom();

// The wrapper counts the key builds and keeps the real result, so other files that share this module see the same behavior.
const real = await import("../../src/contracts/tree-order");
const { treeKey, compareKeys, compareNames, comparePaths } = real;
let builds = 0;
mock.module("../../src/contracts/tree-order", () => ({ compareKeys, compareNames, comparePaths, treeKey: (path: Uint8Array, folder?: boolean) => (builds++, treeKey(path, folder)) }));

const { createRoot } = await import("react-dom/client");
const { changesRows, stagedRows } = await import("../../src/frontend/changes/file-tree");
const { ReferencesSidebar } = await import("../../src/frontend/refs/ReferencesSidebar");

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
async function show(node: ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, rerender: (next: ReactNode) => act(async () => root.render(next)) };
}

// ---- The reference sort of spec FR-015 and FR-016 ----

const bytes = (path: string | number[]) => (typeof path === "string" ? new TextEncoder().encode(path) : Uint8Array.from(path));
const b64 = (raw: Uint8Array) => btoa(String.fromCharCode(...raw));
const unsigned = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};
// Each component is [file side, A to Z folded bytes, raw bytes]. Tuples compare in that order, and a path that ends first is the file side.
function referenceOrder(a: Uint8Array, b: Uint8Array, aFolder = false, bFolder = false): number {
  const split = (p: Uint8Array, folder: boolean) => {
    const parts: number[][] = [[]];
    for (const byte of p) byte === 0x2f ? parts.push([]) : parts.at(-1)!.push(byte);
    return parts.map((raw, i) => ({ file: i === parts.length - 1 && !folder ? 1 : 0, folded: raw.map((c) => (c >= 0x41 && c <= 0x5a ? c + 32 : c)), raw }));
  };
  const x = split(a, aFolder);
  const y = split(b, bFolder);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const same = unsigned(x[i]!.raw, y[i]!.raw) === 0;
    if (same) continue;
    return x[i]!.file - y[i]!.file || unsigned(x[i]!.folded, y[i]!.folded) || unsigned(x[i]!.raw, y[i]!.raw);
  }
  return x.length === y.length ? Number(aFolder === bFolder ? 0 : aFolder ? -1 : 1) : x.length < y.length ? 1 : -1;
}

let ids = 0;
const entry = (category: ChangeEntry["category"], path: string | number[], extra: Partial<ChangeEntry> = {}): ChangeEntry => {
  const raw = bytes(path);
  return { entryId: `e${++ids}`, category, path: new TextDecoder().decode(raw), pathBytes: b64(raw), ...extra };
};
const rawOf = (e: ChangeEntry) => Uint8Array.from(atob(e.pathBytes), (c) => c.charCodeAt(0));
type Row = ReturnType<typeof changesRows>[number];
const label = (row: Row) => (row.kind === "file" ? row.entry.path : row.kind === "folder" ? `${row.name}/` : "Untracked");
// Opens every folder of a list: an untracked folder opens when the set holds its key, a tracked folder when the set lacks it.
function allOpen(build: (toggled: ReadonlySet<string>) => Row[]): Row[] {
  const toggled = new Set<string>();
  for (;;) {
    const rows = build(toggled);
    const closed = rows.filter((r) => r.kind === "folder" && !r.expanded);
    if (closed.length === 0) return rows;
    for (const r of closed) (r.kind === "folder" && r.untracked ? toggled.add(r.key) : toggled.delete(r.key));
  }
}
const NONE: ReadonlySet<string> = new Set();

// Mixed letter case, digits, punctuation, non-ASCII, and bytes that are not valid UTF-8.
const MIXED: (string | number[])[] = ["b.txt", "B/one.txt", "a/z.txt", "A/x.txt", "_u.txt", "10.txt", "9.txt", "é.txt", "Z.txt", "z/a b.txt", [0x66, 0xff, 0x2e, 0x74], [0x66, 0xfe, 0x2e, 0x74], "f/ü.txt", "a-b/c.txt", "a.b.txt", "~/x", "B/two.txt"];

describe("Changes and Staged trees (spec FR-015, US3-1)", () => {
  test("US3-1: the untracked entries b.txt, A/x.txt, a.txt, and c/y.txt show as A/, c/, a.txt, b.txt", () => {
    const entries = ["b.txt", "A/x.txt", "a.txt", "c/y.txt"].map((p) => entry("untracked", p));
    const rows = changesRows(entries, "tree", NONE, true);
    expect(rows.filter((r) => r.depth === 1).map(label)).toEqual(["A/", "c/", "a.txt", "b.txt"]);
  });

  test("the tracked, untracked, and staged trees put the folders first at every level, and each group follows the reference sort", () => {
    for (const category of ["unstaged", "untracked", "staged"] as const) {
      const entries = MIXED.map((p) => entry(category, p));
      const build = (toggled: ReadonlySet<string>) => (category === "staged" ? stagedRows(entries, "tree", toggled) : changesRows(entries, "tree", toggled, true));
      const leaves = allOpen(build).filter((r) => r.kind === "file").map((r) => (r.kind === "file" ? rawOf(r.entry) : null)!);
      const reference = [...entries].map(rawOf).sort((a, b) => referenceOrder(a, b));
      expect([category, leaves.map((l) => [...l])]).toEqual([category, reference.map((l) => [...l])]);
    }
  });
});

describe("flat layouts (spec FR-016, US3-2)", () => {
  test("US3-2: the flat order of every list equals the order of the tree leaves", () => {
    for (const category of ["unstaged", "untracked", "staged"] as const) {
      const entries = MIXED.map((p) => entry(category, p));
      const flat = category === "staged" ? stagedRows(entries, "flat", NONE) : changesRows(entries, "flat", NONE, true);
      const tree = allOpen((toggled) => (category === "staged" ? stagedRows(entries, "tree", toggled) : changesRows(entries, "tree", toggled, true)));
      const ids = (rows: Row[]) => rows.filter((r) => r.kind === "file").map((r) => (r.kind === "file" ? r.entry.entryId : ""));
      expect([category, ids(flat)]).toEqual([category, ids(tree)]);
      expect([category, flat.filter((r) => r.kind === "file").map((r) => (r.kind === "file" ? r.pos : 0))]).toEqual([category, ids(flat).map((_, i) => i + 1)]);
    }
  });
});

describe("submodule and nested-repository rows (spec FR-015, US3-4)", () => {
  test("US3-4: a submodule row lib and a nested-repository row x/ sort among the folders, before a.txt, in the tree and the flat layout", () => {
    const tracked = [entry("unstaged", "a.txt", { xy: ".M" }), entry("unstaged", "lib", { xy: ".M", submodule: "SC.." }), entry("unstaged", "m/n.txt", { xy: ".M" })];
    const untracked = [entry("untracked", "a.txt"), entry("untracked", "x/")];
    for (const layout of ["tree", "flat"] as const) {
      const rows = changesRows([...tracked, ...untracked], layout, NONE, true);
      const top = rows.filter((r) => r.depth === 0 && r.kind !== "section").map(label);
      expect([layout, top]).toEqual([layout, layout === "tree" ? ["lib", "m/", "a.txt"] : ["lib", "m/n.txt", "a.txt"]]);
      const below = rows.slice(rows.findIndex((r) => r.kind === "section") + 1).filter((r) => r.depth === 1).map(label);
      expect([layout, below.at(-1)]).toEqual([layout, "a.txt"]);
      expect([layout, below.length]).toEqual([layout, 2]);
    }
  });
});

// ---- The lazy Changes tree (spec SC-009, quickstart Q32) ----

// The eager tree of feature 004 as the oracle: one full tree per call over the flat order of the module.
function eagerRows(entries: ChangeEntry[], toggled: ReadonlySet<string>, open: boolean, keep?: (e: ChangeEntry) => boolean): Row[] {
  type F = { name: string; children: Map<string, F | ChangeEntry>; count: number; shown: number };
  const isF = (n: F | ChangeEntry): n is F => "children" in n;
  const show = (binary: string) => new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  const tree = (list: ChangeEntry[], scope: string, depth: number, untracked: boolean, out: Row[], extra: number) => {
    const root: F = { name: "", children: new Map(), count: 0, shown: 0 };
    for (const e of list) {
      const parts = atob(e.pathBytes).split("/");
      const kept = keep === undefined || keep(e) ? 1 : 0;
      let node = root;
      node.count++;
      node.shown += kept;
      for (const part of parts.slice(0, -1)) {
        let next = node.children.get(`d${part}`) as F | undefined;
        if (next === undefined) node.children.set(`d${part}`, (next = { name: part, children: new Map(), count: 0, shown: 0 }));
        next.count++;
        next.shown += kept;
        node = next;
      }
      node.children.set(`f${e.entryId}`, e);
    }
    const walk = (folder: F, prefix: string, level: number, more: number): number => {
      const children = [...folder.children.values()].filter((c) => keep === undefined || (isF(c) ? c.shown > 0 : keep(c)));
      let pos = 0;
      for (const child of children) {
        pos++;
        if (!isF(child)) {
          out.push({ kind: "file", key: child.pathBytes, depth: level, entry: child, pos, size: children.length + more });
          continue;
        }
        let node = child;
        let name = node.name;
        for (let only = node.children.values().next().value!; node.children.size === 1 && isF(only); only = node.children.values().next().value!) {
          node = only;
          name += `/${node.name}`;
        }
        const path = prefix + name;
        const key = `${scope}:${btoa(path)}`;
        const expanded = untracked === toggled.has(key);
        out.push({ kind: "folder", key, depth: level, name: show(name), path: show(path), folder: btoa(path), count: node.count, expanded, untracked, pos, size: children.length + more });
        if (expanded) walk(node, `${path}/`, level + 1, 0);
      }
      return children.length;
    };
    return walk(root, "", depth, extra);
  };
  const ordered = changesRows(entries, "flat", NONE, true).flatMap((r) => (r.kind === "file" ? [r.entry] : []));
  const tracked = ordered.filter((e) => e.category !== "untracked");
  const untracked = ordered.filter((e) => e.category === "untracked");
  const out: Row[] = [];
  const top = tree(tracked, "t", 0, false, out, untracked.length === 0 ? 0 : 1);
  if (untracked.length === 0) return out;
  out.push({ kind: "section", key: "untracked", depth: 0, count: untracked.length, expanded: open, pos: top + 1, size: top + 1 });
  if (open) tree(untracked, "u", 1, true, out, 0);
  return out;
}

// Nested folders, one-child folder chains, names that sort by code units, a file and a folder with one prefix, non-ASCII names, a nested repository, and a submodule.
const VARIED: (string | number[])[] = [...MIXED, "docs/drafts/one.md", "docs/drafts/two.md", "deep/a/b/c/d.txt", "deep/a/b/e.txt", "a", "ab/x.txt", "ab.txt", "a b/x", "AB/y", "é/ü/ö.txt", "é/ü.txt", "日本/語/x.txt", "n/", "z/a/b"];
const varied = () => [
  ...VARIED.map((p) => entry("untracked", p)),
  ...["a.txt", "src/m.ts", "src/lib/n.ts", "src/lib/deep/o.ts", "A/b.txt", "é/x"].map((p) => entry("unstaged", p, { xy: ".M" })),
  entry("unstaged", "sub", { xy: ".M", submodule: "SC.." }),
  entry("conflicted", "src/c.ts", { xy: "UU" }),
];
const folderKeys = (rows: Row[]) => rows.flatMap((r) => (r.kind === "folder" ? [r.key] : []));

describe("lazy Changes tree (spec SC-009, quickstart Q32)", () => {
  test("the rows equal the eager tree rows for closed, collapsed, partly open, and fully open states, with and without a filter", () => {
    const entries = varied();
    const keeps = [undefined, (e: ChangeEntry) => !e.path.endsWith(".txt"), (e: ChangeEntry) => e.path.includes("a")];
    for (const keep of keeps) {
      for (const open of [false, true]) expect(changesRows(entries, "tree", NONE, open, keep)).toEqual(eagerRows(entries, NONE, open, keep));
      const all = new Set<string>();
      for (;;) {
        const closed = changesRows(entries, "tree", all, true, keep).filter((r) => r.kind === "folder" && !r.expanded);
        if (closed.length === 0) break;
        // Each step opens one folder, so the partly open states are also compared.
        const r = closed[0]!;
        if (r.kind === "folder") (r.untracked ? all.add(r.key) : all.delete(r.key));
        expect(changesRows(entries, "tree", all, true, keep)).toEqual(eagerRows(entries, all, true, keep));
      }
      const every = folderKeys(eagerRows(entries, all, true));
      expect(every.length).toBeGreaterThan(10);
      const half = new Set(every.filter((_, i) => i % 2 === 0));
      expect(changesRows(entries, "tree", half, true, keep)).toEqual(eagerRows(entries, half, true, keep));
    }
  });

  test("the open of the Untracked section decodes no path again and calls the filter only for the shown folder rows", () => {
    const entries = Array.from({ length: 2000 }, (_, i) => entry("untracked", `u/${String(i % 20).padStart(3, "0")}/f${i}.txt`));
    const decode = globalThis.atob;
    let decodes = 0;
    globalThis.atob = (data: string) => (decodes++, decode(data));
    try {
      changesRows(entries, "tree", NONE, false);
      expect(decodes).toBeLessThanOrEqual(entries.length);
      const before = decodes;
      let filtered = 0;
      const rows = changesRows(entries, "tree", NONE, true, () => (filtered++, true));
      expect(rows.map(label)).toEqual(["Untracked", "u/"]);
      expect(decodes).toBe(before);
      expect(filtered).toBe(1);
      const u = rows[1]!.key;
      expect(changesRows(entries, "tree", new Set([u]), true).filter((r) => r.depth === 2)).toHaveLength(20);
      expect(decodes).toBe(before);
    } finally {
      globalThis.atob = decode;
    }
  });
});

// ---- The References tree ----

const A = "a".repeat(40);
const ref = (kind: RefEntry["kind"], name: string, fields: Partial<RefEntry> = {}): RefEntry => ({ kind, name, invalidUtf8: false, objectId: A, objectType: "commit", peeledId: null, peeledType: null, symref: null, upstream: null, upstreamPresent: false, commitId: A, ...fields });
// Git's refname order (bytes): "Feature" (0x46) < "a-top" (0x61) < "feature" (0x66).
const REFS: RefsResult = {
  generation: 1,
  refs: [ref("branch", "Feature/a"), ref("branch", "a-top"), ref("branch", "feature/b"), ref("branch", "main"), ref("remote", "origin/main"), ref("tag", "v1")],
  current: { name: "main", objectId: A },
  refsDigest: "0".repeat(64),
  completeness: { state: "complete" },
};
let repositories = 0;
const sidebar = (refs: RefsResult) => <ReferencesSidebar refs={refs} failure={null} onSelectCommit={async () => "found" as const} onRefresh={() => {}} repository={`t007-${++repositories}`} />;
const treeItems = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((i) => [i.getAttribute("aria-level"), i.getAttribute("aria-label")!.split(",")[0]]);

describe("References tree (spec FR-015, FR-017, US3-3)", () => {
  test("US3-3: feature/b, Feature/a, and main show the folders first, and the group order stays", async () => {
    const { host } = await show(sidebar(REFS));
    const items = treeItems(host);
    expect(items.filter(([level]) => level === "1").map(([, name]) => name)).toEqual(["Branches", "Remotes", "Tags"]);
    expect(items.filter(([level]) => level === "2").map(([, name]) => name)).toEqual(["Feature", "feature", "a-top", "main"]);
  });

  test("names that are not valid UTF-8 sort by their raw bytes from nameBytes, after the A to Z fold", async () => {
    // Raw "B\xFF" folds to "b\xFF", so "b~" (0x7E) comes first. Raw "\xC0x" (0xC0) comes before "ñ" (0xC3 0xB1); its text U+FFFD (0xEF) would not.
    const refs = {
      ...REFS,
      refs: [
        ref("branch", "B�", { invalidUtf8: true, nameBytes: b64(Uint8Array.from([0x42, 0xff])) }),
        ref("branch", "b~"),
        ref("branch", "�x", { invalidUtf8: true, nameBytes: b64(Uint8Array.from([0xc0, 0x78])) }),
        ref("branch", "ñ"),
      ],
    };
    const { host } = await show(sidebar(refs));
    expect(treeItems(host).filter(([level]) => level === "2").map(([, name]) => name)).toEqual(["b~", "B�", "�x", "ñ"]);
  });
});

// ---- Plan.md D4 "Cost" ----

describe("key builds (plan.md D4)", () => {
  test("the Changes and Staged lists build one key per entry for one snapshot, over two renders and both layouts", () => {
    const entries = [...MIXED.map((p) => entry("unstaged", p)), ...MIXED.map((p) => entry("staged", p)), ...MIXED.map((p) => entry("untracked", p))];
    builds = 0;
    for (let render = 0; render < 2; render++) {
      for (const layout of ["tree", "flat"] as const) {
        changesRows(entries, layout, NONE, true);
        stagedRows(entries, layout, NONE);
      }
    }
    expect(builds).toBe(entries.length);
  });

  test("the References tree builds one key per entry for one snapshot, over two renders", async () => {
    builds = 0;
    const props = { refs: REFS, failure: null, onSelectCommit: async () => "found" as const, onRefresh: () => {}, repository: "t007-renders" };
    const { host, rerender } = await show(<ReferencesSidebar {...props} />);
    await rerender(<ReferencesSidebar {...props} rowHeight={30} />);
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    expect(builds).toBe(REFS.refs.length);
  });
});
