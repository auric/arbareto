// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// plan.md P1 and D3, data-model.md §3, contract Δ3 `loadHistory`: the topology table of one history view.
// Input: the stdout frames of `rev-list --parents --date-order --stdin`, one `<oid>[ <parent>]*` line per row, each ended by LF.
// Typed arrays only. A JS `Map` of OID strings costs several times the bytes per commit.

import { HISTORY_PARENTS_PER_COMMIT } from "../contracts/limits";
import type { ObjectFormat } from "./commands";

export type TopologyFailure =
  | { code: "MALFORMED_GIT_OUTPUT" }
  | { code: "OUTPUT_LIMIT"; reason: "HISTORY_PARENTS_PER_COMMIT" }
  | { code: "HISTORY_CHANGED"; reason: "order" };

const MALFORMED: TopologyFailure = { code: "MALFORMED_GIT_OUTPUT" };
const PARENTS_LIMIT: TopologyFailure = { code: "OUTPUT_LIMIT", reason: "HISTORY_PARENTS_PER_COMMIT" };
const ORDER: TopologyFailure = { code: "HISTORY_CHANGED", reason: "order" };

const LF = 0x0a;
const SPACE = 0x20;
const HEX_DIGITS = "0123456789abcdef";
// Git writes object IDs in lowercase hex. Any other byte is malformed output.
const HEX_VALUE = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) HEX_VALUE[HEX_DIGITS.charCodeAt(i)] = i;
// Contract Δ3: a line holds at most 1 + HISTORY_PARENTS_PER_COMMIT OIDs.
const LINE_OIDS = 1 + HISTORY_PARENTS_PER_COMMIT;
const PENDING = -1;

function grow<T extends Uint8Array | Int32Array>(array: T, length: number): T {
  if (length <= array.length) return array;
  const next = new (array.constructor as new (length: number) => T)(Math.max(length, array.length * 2));
  next.set(array);
  return next;
}

export class HistoryTopology {
  private readonly rawLength: number;
  private readonly hexLength: number;
  // A valid line without its LF is shorter than this.
  private readonly lineCap: number;
  // OID bytes by ID. An ID exists for each row and for each parent that is not a row yet.
  private oids: Uint8Array;
  private ids = 0;
  // Open addressing. A slot holds ID + 1, or 0 when free.
  private slots = new Int32Array(1024);
  // The key is random per table, so a repository cannot choose colliding OIDs in advance.
  private readonly key = crypto.getRandomValues(new Int32Array(8)).map((k) => k | 1);
  // `PENDING` for an ID that is not a row yet.
  private idToRow = new Int32Array(1024);
  private rowToId = new Int32Array(1024);
  // CSR: the parent IDs of row r are parentIds[parentStart[r] .. parentStart[r + 1]], in Git order.
  private parentStart = new Int32Array(1025);
  private parentIds = new Int32Array(1024);
  rows = 0;
  // Parents that are not a row yet.
  pending = 0;
  // The held row count at the start of the step, and the rows that the step streamed.
  private held = 0;
  private streamed = 0;
  // At most one partial line across frames.
  private readonly partial: Uint8Array;
  private partialLength = 0;
  private readonly scratch: Uint8Array;
  // True when the last `intern` found an existing ID.
  private isOld = false;
  private failure: TopologyFailure | null = null;

  constructor(objectFormat: ObjectFormat) {
    this.rawLength = objectFormat === "sha1" ? 20 : 32;
    this.hexLength = this.rawLength * 2;
    this.lineCap = LINE_OIDS * (this.hexLength + 1);
    this.oids = new Uint8Array(1024 * this.rawLength);
    this.partial = new Uint8Array(this.lineCap);
    this.scratch = new Uint8Array(LINE_OIDS * this.rawLength);
  }

  /** Starts a load step. The step streams from row 0 again. Its first `rows` lines must equal the held rows (plan.md D2). */
  beginStep(): void {
    this.held = this.rows;
    this.streamed = 0;
    this.partialLength = 0;
  }

  /** Parses one stdout frame. A failure is final for the view. */
  push(frame: Uint8Array): TopologyFailure | null {
    let at = 0;
    while (this.failure === null && at < frame.length) {
      const lf = frame.indexOf(LF, at);
      const end = lf === -1 ? frame.length : lf;
      if (this.partialLength + end - at >= this.lineCap) {
        this.partial.set(frame.subarray(at, at + this.lineCap - this.partialLength), this.partialLength);
        // The first LINE_OIDS fields are well formed, so the line holds more OIDs than the bound.
        this.failure = this.decode(this.partial, 0, LINE_OIDS) && this.partial[this.lineCap - 1] === SPACE ? PARENTS_LIMIT : MALFORMED;
        break;
      }
      if (lf === -1) {
        this.partial.set(frame.subarray(at), this.partialLength);
        this.partialLength += end - at;
        break;
      }
      if (this.partialLength === 0) this.failure = this.line(frame, at, lf);
      else {
        this.partial.set(frame.subarray(at, lf), this.partialLength);
        const length = this.partialLength + lf - at;
        this.partialLength = 0;
        this.failure = this.line(this.partial, 0, length);
      }
      at = lf + 1;
    }
    return this.failure;
  }

  /** The checks at a Git exit 0. A stop row, a cancel, or a `DEADLINE` runs no check, and the pending parents stay. */
  end(): TopologyFailure | null {
    if (this.failure !== null) return this.failure;
    if (this.partialLength > 0) this.failure = MALFORMED;
    else if (this.streamed < this.held) this.failure = ORDER;
    else if (this.pending > 0) this.failure = MALFORMED;
    return this.failure;
  }

  oid(row: number): string {
    return this.hex(this.rowToId[row]!);
  }

  parents(row: number): string[] {
    return Array.from(this.parentIds.subarray(this.parentStart[row]!, this.parentStart[row + 1]!), (id) => this.hex(id));
  }

  /** The row of `oid`, or -1 when the view holds no such row. */
  rowOf(oid: string): number {
    const bytes = new TextEncoder().encode(oid);
    if (bytes.length !== this.hexLength || !this.decode(bytes, 0, 1)) return -1;
    const id = this.find(0);
    return id < 0 ? -1 : this.idToRow[id]!;
  }

  // Decodes `count` hex fields at `start` into `scratch`. Fields are separated by one space.
  private decode(bytes: Uint8Array, start: number, count: number): boolean {
    for (let field = 0; field < count; field++) {
      let at = start + field * (this.hexLength + 1);
      if (field > 0 && bytes[at - 1] !== SPACE) return false;
      for (let i = field * this.rawLength; i < (field + 1) * this.rawLength; i++, at += 2) {
        const high = HEX_VALUE[bytes[at]!]!;
        const low = HEX_VALUE[bytes[at + 1]!]!;
        if (high < 0 || low < 0) return false;
        this.scratch[i] = (high << 4) | low;
      }
    }
    return true;
  }

  private line(bytes: Uint8Array, start: number, end: number): TopologyFailure | null {
    const length = end - start + 1;
    const width = this.hexLength + 1;
    if (length % width !== 0 || !this.decode(bytes, start, length / width)) return MALFORMED;
    const parents = length / width - 1;
    if (this.streamed < this.held) return this.same(this.streamed++, parents) ? null : ORDER;
    this.streamed++;
    const id = this.intern(0);
    const wasPending = this.isOld;
    if (this.idToRow[id]! !== PENDING) return MALFORMED;
    // A parent that already showed as a row, this row included (data-model.md §3). The checks run before the row enters, so a failed line adds no row.
    for (let p = 1; p <= parents; p++) {
      const parent = this.find(p * this.rawLength);
      if (parent === id || (parent >= 0 && this.idToRow[parent]! !== PENDING)) return MALFORMED;
    }
    if (wasPending) this.pending--;
    const row = this.rows++;
    this.rowToId = grow(this.rowToId, this.rows);
    this.rowToId[row] = id;
    this.idToRow[id] = row;
    const first = this.parentStart[row]!;
    this.parentIds = grow(this.parentIds, first + parents);
    for (let p = 1; p <= parents; p++) {
      this.parentIds[first + p - 1] = this.intern(p * this.rawLength);
      if (!this.isOld) this.pending++;
    }
    this.parentStart = grow(this.parentStart, this.rows + 1);
    this.parentStart[this.rows] = first + parents;
    return null;
  }

  // Row `row` against the line in `scratch`, in OID and parents.
  private same(row: number, parents: number): boolean {
    const first = this.parentStart[row]!;
    if (this.parentStart[row + 1]! - first !== parents || !this.equals(this.rowToId[row]!, 0)) return false;
    for (let p = 1; p <= parents; p++) if (!this.equals(this.parentIds[first + p - 1]!, p * this.rawLength)) return false;
    return true;
  }

  private equals(id: number, at: number): boolean {
    const base = id * this.rawLength;
    for (let i = 0; i < this.rawLength; i++) if (this.oids[base + i] !== this.scratch[at + i]) return false;
    return true;
  }

  // Multiply-shift over the 32-bit words of the OID.
  private slotOf(bytes: Uint8Array, at: number): number {
    let hash = 0;
    for (let w = 0; w < this.rawLength / 4; w++) {
      const i = at + w * 4;
      hash = (hash + Math.imul(bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24), this.key[w]!)) | 0;
    }
    // The slot count is a power of 2, so the top bits give the slot.
    return hash >>> (Math.clz32(this.slots.length) + 1);
  }

  // The ID of the OID at `scratch[at]`, or -1.
  private find(at: number): number {
    const mask = this.slots.length - 1;
    for (let slot = this.slotOf(this.scratch, at); this.slots[slot]! !== 0; slot = (slot + 1) & mask) {
      if (this.equals(this.slots[slot]! - 1, at)) return this.slots[slot]! - 1;
    }
    return -1;
  }

  private intern(at: number): number {
    const found = this.find(at);
    this.isOld = found >= 0;
    if (found >= 0) return found;
    const id = this.ids++;
    this.oids = grow(this.oids, this.ids * this.rawLength);
    this.oids.set(this.scratch.subarray(at, at + this.rawLength), id * this.rawLength);
    this.idToRow = grow(this.idToRow, this.ids);
    this.idToRow[id] = PENDING;
    // Load factor at most 1/2.
    if (this.ids * 2 > this.slots.length) this.rehash(this.slots.length * 2);
    else this.place(id);
    return id;
  }

  private place(id: number): void {
    const mask = this.slots.length - 1;
    let slot = this.slotOf(this.oids, id * this.rawLength);
    while (this.slots[slot]! !== 0) slot = (slot + 1) & mask;
    this.slots[slot] = id + 1;
  }

  private rehash(size: number): void {
    this.slots = new Int32Array(size);
    for (let id = 0; id < this.ids; id++) this.place(id);
  }

  private hex(id: number): string {
    let text = "";
    for (let i = id * this.rawLength; i < (id + 1) * this.rawLength; i++) text += HEX_DIGITS[this.oids[i]! >> 4]! + HEX_DIGITS[this.oids[i]! & 15]!;
    return text;
  }
}
