// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

export type Part = { full: number; min: number };

/** plan.md "Long text": cuts the overflow from the parts in order, each down to its minimum. Returns the widths in the same order. */
export function shrinkInOrder(width: number, fixed: number, parts: readonly Part[]): number[] {
  let over = fixed + parts.reduce((sum, p) => sum + p.full, 0) - width;
  return parts.map((p) => {
    const cut = Math.max(0, Math.min(over, p.full - p.min));
    over -= cut;
    return p.full - cut;
  });
}
