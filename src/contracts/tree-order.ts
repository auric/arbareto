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
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

// `aFolder` and `bFolder` mark a folder row: a folder, a submodule, or a nested repository.
// At the first differing component the folder side comes first. A path that ends where the other continues is the file side.
export function comparePaths(a: Uint8Array, b: Uint8Array, aFolder = false, bFolder = false): number {
  const left = components(a);
  const right = components(b);
  for (let i = 0; ; i++) {
    const leftEnded = i === left.length;
    const rightEnded = i === right.length;
    if (leftEnded || rightEnded) return leftEnded && rightEnded ? (aFolder === bFolder ? 0 : aFolder ? -1 : 1) : leftEnded ? 1 : -1;
    if (sameBytes(left[i]!, right[i]!)) continue;
    const leftFolder = i < left.length - 1 || aFolder;
    const rightFolder = i < right.length - 1 || bFolder;
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
    return compareNames(left[i]!, right[i]!);
  }
}
