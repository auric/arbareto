// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 plan.md D4 and data-model §3: the folders-first tree order over path bytes (spec FR-015, FR-016).
// The service and the renderer import this module. It has no runtime import and does not use `process`.

const SLASH = 0x2f;
const fold = (byte: number) => (byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);

// The mapped bytes as unsigned values, then the raw bytes. So two different names never compare equal.
export function compareNames(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const d = fold(a[i]!) - fold(b[i]!);
    if (d !== 0) return d;
  }
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < length; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

const components = (path: Uint8Array): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= path.length; i++) {
    if (i === path.length || path[i] === SLASH) {
      parts.push(path.subarray(start, i));
      start = i + 1;
    }
  }
  return parts;
};
// Data-model §3: one key per row, built once per read. `folder` marks a folder row: a folder, a submodule, or a nested repository.
export type TreeKey = { readonly parts: readonly Uint8Array[]; readonly folder: boolean };
export const treeKey = (path: Uint8Array, folder = false): TreeKey => ({ parts: components(path), folder });

// At the first differing component the folder side comes first. A path that ends where the other continues is the file side.
export const compareKeys = (a: TreeKey, b: TreeKey): number => order(a, b, compareNames);

// The same rules over byte strings: one UTF-16 code unit per byte, 0 to 255, as `atob` gives. The renderer sorts these without a byte array.
export function compareNameStrings(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const d = fold(a.charCodeAt(i)) - fold(b.charCodeAt(i));
    if (d !== 0) return d;
  }
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
export type TreeStringKey = { readonly parts: readonly string[]; readonly folder: boolean };
// Each code unit is one byte, so `split` cuts at the same 0x2F bytes as `components`.
export const treeStringKey = (path: string, folder = false): TreeStringKey => ({ parts: path.split("/"), folder });
export const compareStringKeys = (a: TreeStringKey, b: TreeStringKey): number => order(a, b, compareNameStrings);

type Parts<T> = { readonly parts: readonly T[]; readonly folder: boolean };
function order<T>(a: Parts<T>, b: Parts<T>, compare: (x: T, y: T) => number): number {
  const left = a.parts;
  const right = b.parts;
  for (let i = 0; ; i++) {
    const leftEnded = i === left.length;
    const rightEnded = i === right.length;
    if (leftEnded || rightEnded) return leftEnded && rightEnded ? (a.folder === b.folder ? 0 : a.folder ? -1 : 1) : leftEnded ? 1 : -1;
    // `compare` gives 0 only for equal bytes.
    const names = compare(left[i]!, right[i]!);
    if (names === 0) continue;
    const leftFolder = i < left.length - 1 || a.folder;
    const rightFolder = i < right.length - 1 || b.folder;
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
    return names;
  }
}

// Builds both keys on each call. A sort builds the keys first and uses `compareKeys`.
export const comparePaths = (a: Uint8Array, b: Uint8Array, aFolder = false, bFolder = false): number => compareKeys(treeKey(a, aFolder), treeKey(b, bFolder));
