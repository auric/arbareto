// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { printOrigin } from "../origin";
import { compareNames, comparePaths } from "../../src/contracts/tree-order";

const SOURCE = printOrigin("../../src/contracts/tree-order.ts", import.meta.dir);

// Feature 005 plan.md D4, data-model §3, spec FR-015, FR-016, and SC-004 (T001).

const bytes = (text: string) => new TextEncoder().encode(text);
const sign = (n: number) => Math.sign(n);

// An independent reference: the mapped bytes, then the raw bytes, each as fixed-width hex text compared by UTF-16 code units.
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const mapped = (b: Uint8Array) => Uint8Array.from(b, (x) => (x >= 0x41 && x <= 0x5a ? x + 0x20 : x));
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const referenceNames = (a: Uint8Array, b: Uint8Array) => textOrder(hex(mapped(a)), hex(mapped(b))) || textOrder(hex(a), hex(b));

// A fixed generator, so each run sees the same names.
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}
// Mixed case, digits, the punctuation between `Z` and `a`, multi-byte UTF-8, and bytes that are no valid UTF-8.
const ALPHABET = [...bytes("aAbBzZ09._-[]^`~ "), 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0x80, 0xff, 0x7f];
function names(count: number, seed: number): Uint8Array[] {
  const next = generator(seed);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const length = 1 + (next() % 5);
    out.push(Uint8Array.from({ length }, () => ALPHABET[next() % ALPHABET.length]!));
  }
  return out;
}
const unique = (list: Uint8Array[]) => [...new Map(list.map((b) => [hex(b), b])).values()];

describe("compareNames", () => {
  test("it maps 0x41 to 0x5A to that byte plus 0x20, so `_` (0x5F) sorts before `A`", () => {
    expect(sign(compareNames(bytes("_"), bytes("A")))).toBe(-1);
    expect(sign(compareNames(bytes("a"), bytes("B")))).toBe(-1);
    expect(sign(compareNames(bytes("Zeta"), bytes("alpha")))).toBe(1);
    expect(sign(compareNames(bytes("readme"), bytes("README.md")))).toBe(-1);
  });

  test("equal mapped bytes compare the raw bytes, so `A` sorts before `a`", () => {
    expect(sign(compareNames(bytes("A"), bytes("a")))).toBe(-1);
    expect(sign(compareNames(bytes("aB"), bytes("Ab")))).toBe(1);
    expect(compareNames(bytes("same"), bytes("same"))).toBe(0);
  });

  test("bytes compare as unsigned values, also bytes that are no valid UTF-8", () => {
    expect(sign(compareNames(Uint8Array.of(0x7f), Uint8Array.of(0x80)))).toBe(-1);
    expect(sign(compareNames(Uint8Array.of(0xff), Uint8Array.of(0xc3, 0xa9)))).toBe(1);
    expect(sign(compareNames(bytes("a"), bytes("ab")))).toBe(-1);
  });

  test("it agrees with the reference sort over generated names", () => {
    const list = unique(names(2000, 7));
    const sorted = list.toSorted(compareNames).map(hex);
    const reference = list.toSorted(referenceNames).map(hex);
    expect(sorted).toEqual(reference);
  });

  test("the order is total: two different names never compare equal, and swapped inputs swap the sign", () => {
    const list = unique([...names(400, 11), bytes("A"), bytes("a"), bytes("Readme"), bytes("README"), bytes("readme")]);
    const ties: string[] = [];
    for (const a of list) {
      for (const b of list) {
        const ab = sign(compareNames(a, b));
        if (a !== b && ab === 0) ties.push(`${hex(a)} ${hex(b)}`);
        if (ab !== -sign(compareNames(b, a))) ties.push(`asymmetric ${hex(a)} ${hex(b)}`);
      }
    }
    expect(ties).toEqual([]);
  });
});

// A tree of the paths: folders first, then files, each group by `compareNames`. The leaves in walk order.
type Node = { children: Map<string, { name: Uint8Array; node: Node }>; leaves: { name: Uint8Array; path: string; folder: boolean }[] };
function treeLeaves(paths: { path: string; folder: boolean }[]): string[] {
  const root: Node = { children: new Map(), leaves: [] };
  for (const entry of paths) {
    const parts = entry.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const key = hex(bytes(part));
      if (!node.children.has(key)) node.children.set(key, { name: bytes(part), node: { children: new Map(), leaves: [] } });
      node = node.children.get(key)!.node;
    }
    node.leaves.push({ name: bytes(parts.at(-1)!), path: entry.path, folder: entry.folder });
  }
  const walk = (node: Node): string[] => {
    type Item = { name: Uint8Array; folder: boolean; out: () => string[] };
    const items: Item[] = [
      ...[...node.children.values()].map((c) => ({ name: c.name, folder: true, out: () => walk(c.node) })),
      ...node.leaves.map((l) => ({ name: l.name, folder: l.folder, out: () => [l.path] })),
    ];
    items.sort((a, b) => (a.folder === b.folder ? compareNames(a.name, b.name) : a.folder ? -1 : 1));
    return items.flatMap((i) => i.out());
  };
  return walk(root);
}
const flat = (paths: { path: string; folder: boolean }[]) =>
  paths.toSorted((a, b) => comparePaths(bytes(a.path), bytes(b.path), a.folder, b.folder)).map((p) => p.path);

describe("comparePaths", () => {
  test("spec US3-1: the folders A/ and c/ come before a.txt and b.txt", () => {
    const paths = ["b.txt", "c/y.txt", "a.txt", "A/x.txt"].map((path) => ({ path, folder: false }));
    expect(flat(paths)).toEqual(["A/x.txt", "c/y.txt", "a.txt", "b.txt"]);
  });

  test("where one path ends and the other continues, the ended path is the file side", () => {
    expect(sign(comparePaths(bytes("a"), bytes("a/b")))).toBe(1);
    expect(sign(comparePaths(bytes("a/b"), bytes("a")))).toBe(-1);
    expect(sign(comparePaths(bytes("x/a"), bytes("x/a/b")))).toBe(1);
  });

  test("a folder row, such as a submodule or a nested repository, sorts as a folder", () => {
    expect(sign(comparePaths(bytes("lib"), bytes("a.txt"), true, false))).toBe(-1);
    expect(sign(comparePaths(bytes("lib"), bytes("a.txt"), false, false))).toBe(1);
    expect(sign(comparePaths(bytes("src/vendor"), bytes("src/a/b.txt"), true, false))).toBe(1);
  });

  test("the flat order equals the order of the tree leaves", () => {
    const next = generator(23);
    const parts = ["a", "A", "b", "B.txt", "_", "z", "é", "file.txt", "Dir"];
    const seen = new Set<string>();
    const paths: { path: string; folder: boolean }[] = [];
    for (let i = 0; i < 600; i++) {
      const depth = 1 + (next() % 4);
      const path = Array.from({ length: depth }, () => parts[next() % parts.length]!).join("/");
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push({ path, folder: next() % 7 === 0 });
    }
    // A leaf that is also a folder name of another path cannot exist in one tree.
    const prefixes = new Set(paths.flatMap((p) => p.path.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"))));
    const leaves = paths.filter((p) => !prefixes.has(p.path));
    expect(leaves.length).toBeGreaterThan(100);
    expect(flat(leaves)).toEqual(treeLeaves(leaves));
  });

  test("the order is total over paths", () => {
    const list = ["a", "A", "a/b", "A/b", "a/B", "b", "a.txt", "a/b/c"].map(bytes);
    for (const a of list) for (const b of list) if (a !== b) expect(comparePaths(a, b)).not.toBe(0);
    expect(comparePaths(bytes("a/b"), bytes("a/b"))).toBe(0);
  });
});

describe("module rules", () => {
  const source = readFileSync(SOURCE, "utf8");
  test("it has no runtime import", () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
  test("it calls no localeCompare, Intl.Collator, or toLowerCase", () => {
    expect(source).not.toContain("localeCompare");
    expect(source).not.toContain("Intl.Collator");
    expect(source).not.toContain("toLowerCase");
  });
});
