// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// plan.md D4 and data-model.md §7: the filter-mode reduced graph, built in stream order of one `rev-list --parents --date-order` stream.
// A commit is a numeric identifier, as the topology table gives it. Every child streams before its parent (`--date-order`).

const EMPTY = new Uint32Array(0);
// Bit 31 of the edge target marks an edge that skips commits.
const SKIP = 0x8000_0000;
const HAS_PARENTS = 1;
const HAS_EDGE = 2;

export interface ReducedEdge {
  // Match sequence numbers: `from` is the later match, `to` its nearest matching ancestor (spec FR-033).
  from: number;
  to: number;
  // `to` is a Git parent of `from` (spec FR-034).
  direct: boolean;
}

export class ReducedGraph {
  // `P` of plan.md D4. Each array is sorted, shared, and never changed.
  private readonly pending = new Map<number, Uint32Array>();
  // The matches whose Git parent is the key. They give the direct edges.
  private readonly childOf = new Map<number, number[]>();
  private edgeData = new Uint32Array(64);
  private edgeCount = 0;
  private flags = new Uint8Array(64);
  private matchCount = 0;

  /** The processed matches. Match sequence numbers run from 0 in stream order. */
  get matches(): number {
    return this.matchCount;
  }

  get edges(): number {
    return this.edgeCount;
  }

  /** Processes the next row of the stream. Call it only when the match state of the row is known (plan.md D5). */
  step(commit: number, parents: ArrayLike<number>, match: boolean): void {
    const s = this.pending.get(commit) ?? EMPTY;
    this.pending.delete(commit);
    let t = s;
    if (match) {
      const q = this.matchCount++;
      if (q >= SKIP) throw new RangeError(`match ${q} does not fit an edge`);
      if (q === this.flags.length) this.flags = grow(this.flags, new Uint8Array(2 * q));
      if (parents.length > 0) this.flags[q] = HAS_PARENTS;
      const direct = this.childOf.get(commit);
      for (const m of s) this.addEdge(m, direct?.includes(m) ? q : q | SKIP);
      t = Uint32Array.of(q);
    }
    this.childOf.delete(commit);
    if (t.length === 0) return;
    for (let k = 0; k < parents.length; k++) {
      const p = parents[k]!;
      const held = this.pending.get(p);
      this.pending.set(p, held === undefined ? t : union(held, t));
      if (match) {
        const children = this.childOf.get(p);
        if (children === undefined) this.childOf.set(p, [t[0]!]);
        else children.push(t[0]!);
      }
    }
  }

  /** The settled prefix: no later edge starts at a match below this sequence number (plan.md D4). */
  settled(): number {
    let low = this.matchCount;
    for (const a of this.pending.values()) if (a[0]! < low) low = a[0]!;
    return low;
  }

  edgeAt(i: number): ReducedEdge {
    if (!Number.isInteger(i) || i < 0 || i >= this.edgeCount) throw new RangeError(`edge ${i} is outside the ${this.edgeCount} edges`);
    const to = this.edgeData[2 * i + 1]!;
    return { from: this.edgeData[2 * i]!, to: (to & ~SKIP) >>> 0, direct: (to & SKIP) === 0 };
  }

  /** True when settled match `q` shows "No earlier matching commit": it has parents and no reduced edge. A root and a shallow boundary have no parents. */
  noEarlier(q: number): boolean {
    if (!Number.isInteger(q) || q < 0 || q >= this.settled()) throw new RangeError(`match ${q} is not settled`);
    return this.flags[q] === HAS_PARENTS;
  }

  private addEdge(from: number, to: number): void {
    if (2 * this.edgeCount === this.edgeData.length) this.edgeData = grow(this.edgeData, new Uint32Array(2 * this.edgeData.length));
    this.edgeData[2 * this.edgeCount] = from;
    this.edgeData[2 * this.edgeCount + 1] = to;
    this.edgeCount++;
    this.flags[from] = this.flags[from]! | HAS_EDGE;
  }
}

// ponytail: k branches that join one base cost O(k²) union work. A mergeable heap per frontier commit is the upgrade path (plan.md D4).
function union(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    out[n++] = x <= y ? x : y;
    if (x <= y) i++;
    if (y <= x) j++;
  }
  while (i < a.length) out[n++] = a[i++]!;
  while (j < b.length) out[n++] = b[j++]!;
  // An input that holds the whole union stays shared.
  if (n === a.length) return a;
  if (n === b.length) return b;
  return out.slice(0, n);
}

function grow<T extends Uint8Array | Uint32Array>(a: T, next: T): T {
  next.set(a);
  return next;
}
