// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A fake of the five feature 002 bridge calls and `cancel` (contract Δ3). It holds no structure of the history size: rows come from their index.
// It follows the contract Δ3 stop rule S = max(n + 1 + 2·M, 2·L₀) for `{row: n}`.

import type { BridgeResponse, OnProgress } from "../../src/frontend/bridge";
import { filterText } from "../../src/contracts/filter-text";
import { FILTER_TEXT_BYTES, HISTORY_LOAD_MARGIN } from "../../src/contracts/limits";
import type { Head, HistoryBridge, ViewRow } from "../../src/frontend/state/history-view";

export const oid = (i: number) => i.toString(16).padStart(40, "0");
export const indexOf = (o: string) => parseInt(o, 16);

type Call = { operation: string; payload: Record<string, unknown> };
type Held = { resolve(response: BridgeResponse): void; operationId: string; result: () => BridgeResponse };

export type FakeOptions = {
  /** The commits of the history. */
  total: number;
  /** Rows that the view holds after open. */
  loaded?: number;
  scope?: "all" | "current";
  head?: Head;
  startCount?: number;
  refsDigest?: string;
  shallow?: boolean;
  /** The match rule of the search. */
  matches?: (i: number) => boolean;
  /** Hold load and search responses until `release` or a cancel. */
  hold?: { load?: boolean; search?: boolean };
  /** The cell of a row. */
  cell?: (i: number) => ViewRow["cell"];
  /** The terminal response of the next load, instead of a success. */
  loadResponse?: (payload: Record<string, unknown>) => BridgeResponse | null;
  searchResponse?: (text: string) => BridgeResponse | null;
  /** Fields that replace the `text: "rows"` fields of row i. */
  text?: (i: number) => Partial<ViewRow>;
  /** Fields that replace the `text: "details"` fields of row i. */
  details?: (i: number) => Partial<ViewRow>;
  /** The `lanes` value of each row read. */
  lanes?: () => number;
};

export function createFake(options: FakeOptions) {
  const calls: Call[] = [];
  const held: Held[] = [];
  let loaded = options.loaded ?? 0;
  let views = 0;
  let operations = 0;
  let viewId = "";
  let searchDone = false;
  // Contract Δ3: the `searchId` of the running or finished search. A cancel, a failure, a `limited` end, a newer search, `closeHistory`, and a view release end it.
  let liveSearch: string | null = null;
  // Contract Δ3: a match read waits while the search of the view runs.
  let searching = false;
  const waiters: (() => void)[] = [];
  const wake = () => {
    searching = false;
    for (const waiter of waiters.splice(0)) waiter();
  };
  let total = options.total;
  const head: Head = options.head ?? { state: "branch", target: "refs/heads/main", oid: oid(0) };
  const isMatch = options.matches ?? (() => false);
  const complete = () => loaded >= total;

  const cellOf = (i: number): ViewRow["cell"] =>
    options.cell?.(i) ?? {
      node: 0,
      color: 0,
      merge: false,
      limited: false,
      segments: [
        ...(i === 0 ? [] : [{ shape: "line" as const, from: { lane: 0, at: "top" as const }, to: { lane: 0, at: "node" as const }, color: 0 }]),
        ...(i === total - 1 ? [] : [{ shape: "line" as const, from: { lane: 0, at: "node" as const }, to: { lane: 0, at: "bottom" as const }, color: 0 }]),
      ],
      marks: i === total - 1 ? ["root"] : [],
    };

  // Filter mode lists the matches. `k` is the position among them.
  function matchIndex(k: number): number | null {
    let seen = -1;
    for (let i = 0; i < loaded; i++) if (isMatch(i) && ++seen === k) return i;
    return null;
  }
  function matchPosition(i: number): number {
    let k = -1;
    for (let j = 0; j <= i; j++) if (isMatch(j)) k++;
    return k;
  }
  const matchCount = () => {
    let n = 0;
    for (let i = 0; i < loaded; i++) if (isMatch(i)) n++;
    return n;
  };

  function rowOf(i: number, index: number, text: string, search: boolean): ViewRow {
    const row: ViewRow = {
      index,
      oid: oid(i),
      parents: i === total - 1 ? [] : [oid(i + 1)],
      cell: cellOf(i),
      labels: i === 0 ? [{ kind: "branch", name: "main", invalidUtf8: false }] : [],
      checkout: head.state !== "unborn" && oid(i) === head.oid,
      ...(search ? { match: searchDone || i < loaded ? isMatch(i) : null } : {}),
    };
    if (text === "none") return row;
    Object.assign(row, { subject: `Commit ${i}`, author: { name: "Ada", email: "ada@example.invalid" }, date: 1577836800 + i, encoding: null, invalidUtf8: false, ...options.text?.(i) });
    if (text === "details")
      Object.assign(row, { body: options.matches ? "" : `Body of ${i}`, bodyCut: false, committer: { name: "Grace", email: "grace@example.invalid" }, committerDate: 1577840400 + i, children: i === 0 ? [] : [oid(i - 1)], ...options.details?.(i) });
    return row;
  }

  const rowsState = () => ({ rowCount: loaded, lanes: options.lanes?.() ?? 1, complete: complete(), bytes: 0 });
  // Row reads in flight, and the most at one time.
  let reads = 0;
  let maxReads = 0;
  let cancelText: (() => void) | null = null;
  let canceledTexts = 0;
  const ok = (result: unknown): BridgeResponse => ({ requestId: "r", state: "succeeded", result });
  const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 0));

  function stop(need: Record<string, unknown>): number {
    if ("end" in need) return total;
    if ("oid" in need) return Math.min(total, Math.max(indexOf(need.oid as string) + 1 + 2 * HISTORY_LOAD_MARGIN, 2 * loaded));
    return Math.min(total, Math.max((need.row as number) + 1 + 2 * HISTORY_LOAD_MARGIN, 2 * loaded));
  }

  const unknownTarget = (): Promise<BridgeResponse> => later({ requestId: "r", state: "rejected", code: "UNKNOWN_TARGET" });
  // Contract Δ3: a read with an ended or unknown `searchId` gives UNKNOWN_TARGET.
  const ended = (payload: Parameters<HistoryBridge["readHistoryRows"]>[1]) => payload.viewId !== viewId || (payload.searchId !== undefined && payload.searchId !== liveSearch);

  async function readRows(payload: Parameters<HistoryBridge["readHistoryRows"]>[1]): Promise<BridgeResponse> {
    if (ended(payload)) return unknownTarget();
    const at = payload.at as Record<string, unknown>;
    if ("match" in at) {
      for (;;) {
        if (ended(payload)) return unknownTarget();
        const step = at.match === "next" ? 1 : -1;
        for (let i = at.from as number; i >= 0 && i < loaded; i += step) if (isMatch(i)) return later(ok({ target: "found", rows: [rowOf(i, i, payload.text, true)], cut: false, ...rowsState(), bytes: 1024 }));
        if (!searching) return later(ok({ target: searchDone ? "none" : "unknown", ...rowsState() }));
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    }
    return readOther(payload);
  }

  function readOther(payload: Parameters<HistoryBridge["readHistoryRows"]>[1]): Promise<BridgeResponse> {
    const at = payload.at as Record<string, unknown>;
    const filter = payload.mode === "filter";
    const search = payload.searchId !== undefined;
    const rows: ViewRow[] = [];
    if ("row" in at) {
      for (let k = at.row as number; k < (at.row as number) + payload.count; k++) {
        const i = filter ? matchIndex(k) : k < loaded ? k : null;
        if (i === null) break;
        rows.push(rowOf(i, k, payload.text, search));
      }
    } else if ("oid" in at) {
      const i = indexOf(at.oid as string);
      if (i < loaded && (!filter || isMatch(i))) rows.push(rowOf(i, filter ? matchPosition(i) : i, payload.text, search));
      else if (i >= loaded && !complete()) return later(ok({ target: "unknown", ...rowsState() }));
    } else if ("end" in at) {
      if (filter) {
        const n = matchCount();
        if (n > 0) rows.push(rowOf(matchIndex(n - 1)!, n - 1, payload.text, search));
      } else if (loaded > 0) rows.push(rowOf(loaded - 1, loaded - 1, payload.text, search));
    }
    if (rows.length === 0) return later(ok({ target: "none", ...rowsState() }));
    return later(ok({ target: "found", rows, cut: false, ...rowsState(), bytes: rows.length * 1024 }));
  }

  const bridge: HistoryBridge = {
    openHistory: (_target, payload) => {
      calls.push({ operation: "openHistory", payload });
      viewId = `view-${++views}`;
      loaded = options.loaded ?? 0;
      searchDone = false;
      liveSearch = null;
      return later(ok({ viewId, scope: payload.scope, generation: 1, head, startCount: options.startCount ?? (total === 0 ? 0 : 1), refsDigest: options.refsDigest ?? "a".repeat(64), shallow: options.shallow ?? false }));
    },
    loadHistory: (_target, payload, onProgress?: OnProgress) => {
      calls.push({ operation: "loadHistory", payload });
      const operationId = `load-${++operations}`;
      onProgress?.({ requestId: "r", operationId, state: "accepted", counters: { rows: loaded } });
      const custom = options.loadResponse?.(payload.need as Record<string, unknown>);
      if (custom) return later(custom);
      const finish = (): BridgeResponse => {
        loaded = stop(payload.need as Record<string, unknown>);
        return ok({ rows: loaded, complete: complete() });
      };
      if (options.hold?.load) return new Promise((resolve) => held.push({ resolve, operationId, result: finish }));
      return later(finish());
    },
    readHistoryRows: async (_target, payload) => {
      calls.push({ operation: "readHistoryRows", payload });
      maxReads = Math.max(maxReads, ++reads);
      try {
        if (payload.text === "none") return await readRows(payload);
        // Contract Δ3: a newer text read cancels an unfinished one of the same view.
        cancelText?.();
        let cancel = () => {};
        const canceled = new Promise<BridgeResponse>((resolve) => (cancel = () => (canceledTexts++, resolve({ requestId: "r", state: "canceled" }))));
        cancelText = cancel;
        try {
          return await Promise.race([readRows(payload), canceled]);
        } finally {
          if (cancelText === cancel) cancelText = null;
        }
      } finally {
        reads--;
      }
    },
    searchHistory: (_target, payload, onProgress?: OnProgress) => {

      calls.push({ operation: "searchHistory", payload });
      const operationId = `search-${++operations}`;
      liveSearch = null;
      // Contract Δ3 and Δ9: the service refuses the text before any Git process, so the request ends `rejected`.
      const checked = filterText(payload.text, FILTER_TEXT_BYTES);
      if (checked.kind !== "search") return later({ requestId: "r", operationId, state: "rejected", code: "UNSUPPORTED_FILTER_TEXT", result: checked.kind === "refused" ? { reason: checked.reason } : {} });
      liveSearch = operationId;
      onProgress?.({ requestId: "r", operationId, state: "accepted", counters: { matches: 0, settled: 0 } });
      const custom = options.searchResponse?.(payload.text);
      if (custom) {
        if (custom.state !== "succeeded") liveSearch = null;
        return later(custom);
      }
      const finish = (): BridgeResponse => {
        loaded = total;
        searchDone = true;
        setTimeout(wake, 0);
        return { ...ok({ matches: matchCount(), shallow: options.shallow ?? false }), operationId };
      };
      searchDone = false;
      if (options.hold?.search) {
        searching = true;
        return new Promise((resolve) => held.push({ resolve, operationId, result: finish }));
      }
      return later(finish());
    },
    closeHistory: (_target, payload) => {
      calls.push({ operation: "closeHistory", payload });
      liveSearch = null;
      return later(ok({}));
    },
    cancel: (payload) => {
      calls.push({ operation: "cancel", payload });
      const at = held.findIndex((h) => h.operationId === payload.operationId);
      if (at >= 0) held.splice(at, 1)[0]!.resolve({ requestId: "r", state: "canceled", result: { rows: loaded, complete: complete() } });
      if (payload.operationId === liveSearch) liveSearch = null;
      setTimeout(wake, 0);
      return later(ok({}));
    },
  };

  return {
    bridge,
    calls,
    of: (operation: string) => calls.filter((c) => c.operation === operation).map((c) => c.payload),
    /** Ends the oldest held response with its success. */
    release() {
      const next = held.shift();
      next?.resolve(next.result());
    },
    held: () => held.length,
    maxReads: () => maxReads,
    /** The text reads that a newer text read canceled. */
    canceledTexts: () => canceledTexts,
    loaded: () => loaded,
    setLoaded(n: number) {
      loaded = n;
    },
    /** The commits that the refs of the next view reach. */
    setTotal(n: number) {
      total = n;
    },
  };
}

export const TARGET = () => ({ repositoryId: "repository-1", repositoryGeneration: 1 });

/**
 * happy-dom has no layout. This stubs the viewport of the history list and the references scroller: `clientHeight` and `offsetHeight` give `height`,
 * `scrollHeight` gives the height of the sized child, and `scrollTop` clamps as a browser does. `scrollTo` sends a scroll event. It returns the restore step.
 */
export function stubLayout(height = 800): () => void {
  const proto = HTMLElement.prototype;
  const keys = ["clientHeight", "offsetHeight", "scrollHeight", "scrollTop", "scrollTo"] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
  const tops = new WeakMap<Element, number>();
  const sized = (element: Element) => element.hasAttribute("data-history-list") || element.hasAttribute("data-references-scroll");
  const content = (element: Element) => parseFloat(element.querySelector<HTMLElement>('[role="presentation"]')?.style.height ?? "") || 0;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: function (this: Element) { return sized(this) ? height : 0; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: function (this: Element) { return sized(this) ? height : 0; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: function (this: Element) { return sized(this) ? content(this) : 0; } });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get: function (this: Element) {
      return tops.get(this) ?? 0;
    },
    set: function (this: Element, value: number) {
      tops.set(this, Math.max(0, Math.min(value, (sized(this) ? content(this) : 0) - (sized(this) ? height : 0))));
    },
  });
  Object.defineProperty(proto, "scrollTo", {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement, options: ScrollToOptions | number, y?: number) {
      this.scrollTop = typeof options === "object" ? (options.top ?? this.scrollTop) : (y ?? 0);
      this.dispatchEvent(new Event("scroll"));
    },
  });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete (proto as unknown as Record<string, unknown>)[key];
      else Object.defineProperty(proto, key, descriptor);
    }
  };
}
