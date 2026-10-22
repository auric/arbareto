// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { z } from "zod";
import type { Blame, CommitChanges, CommitFile, Head as HeadSchema, HistoryViewRow, LoadHistoryResult, OpenHistoryResult, ReadHistoryRowsResult, SearchHistoryResult } from "../../contracts/envelope";
import type { BlameUnavailableReason } from "../../contracts/errors";
import { filterText } from "../../contracts/filter-text";
import { FILTER_TEXT_BYTES, HISTORY_LOAD_MARGIN, HISTORY_RENDERER_CACHE_BYTES, HISTORY_ROWS_PER_REQUEST } from "../../contracts/limits";
import type { BridgeResponse, createBridge } from "../bridge";

// Feature 002 plan.md D5 and D6, data-model §6 and §8, contract Δ3 and Δ8. The service holds the view. This store holds O(visible + cache) only.

export type HistoryBridge = Pick<ReturnType<typeof createBridge>, "openHistory" | "loadHistory" | "readHistoryRows" | "searchHistory" | "closeHistory" | "cancel">;
export type ViewRow = z.infer<typeof HistoryViewRow>;
export type Head = z.infer<typeof HeadSchema>;
type Opened = Extract<z.infer<typeof OpenHistoryResult>, { viewId: string }>;
type Rows = z.infer<typeof ReadHistoryRowsResult>;
type Found = Extract<Rows, { target: "found" }>;
type Refusal = { reason?: string; remedy?: Remedy };
export type Remedy = { text: string; command: string | null };
export type Scope = "all" | "current";
export type HistoryMode = "filter" | "highlight";

/** data-model §8: a page holds 128 rows. */
export const PAGE_ROWS = 128;

export type SearchState = {
  text: string;
  mode: HistoryMode;
  /** data-model §6. */
  state: "running" | "finished" | "stopped" | "refused" | "failed";
  /** The `operationId` of the search request, from its accepted event (contract Δ2). */
  searchId: string | null;
  /** The progress counter while the search runs. The final count after `finished` (spec FR-039). */
  matches: number;
  settled: number;
  shallow: boolean;
  /** Absent on `failed`: a `succeeded` response with a result of unknown form (feature 004 plan.md D15 "Malformed result"). */
  code?: string;
  reason?: string;
  /** `filter-text.ts` names the refused characters. */
  found?: string | null;
  remedy?: Remedy;
};

/** The selected list item: `WORKING_ROW`, `INDEX_ROW`, or a commit OID. `index` is the row index in the list of `mode`. */
export type Selection = { id: string; index: number | null; mode: "full" | "filter" };

export type HistoryState = {
  scope: Scope;
  view: Opened | null;
  /** The `nextRequestSeq()` value when the `openHistory` response arrived. Only reads sent later can be newer than the view (contract Δ8). */
  openedSeq: number;
  opening: boolean;
  /** `code` null: a `succeeded` response with a result of unknown form (feature 004 plan.md D15 "Malformed result"). */
  openFailure: { code: string | null; reason?: string; remedy?: Remedy } | null;
  /** The rows that the view holds (contract Δ3 `rowCount`). */
  viewRows: number;
  complete: boolean;
  /** The most lanes so far. It never shrinks during a view (spec FR-016). */
  lanes: number;
  load: { kind: "scroll" | "end" | "oid"; rows: number; operationId: string | null } | null;
  /** plan.md D6: after a Cancel or a `DEADLINE`, no scroll load starts until the more-rows row shows again. */
  halted: boolean;
  /** An `OUTPUT_LIMIT` end of a load. The rows stay, and no load starts. */
  limit: { reason: string } | null;
  /** The remedy of a `DEADLINE` load. */
  deadline: Remedy | null;
  /** A load failure that no other rule handles. It halts loads like a Cancel (plan.md D6). */
  loadFailure: { code: string; reason?: string } | null;
  stale: { code: string; reason?: string } | null;
  search: SearchState | null;
  /** Spec FR-038: the last match move found no earlier or later match. */
  matchEnd: "first" | "last" | null;
  /** A match move waits for the search to reach its target (spec FR-037). */
  waiting: boolean;
  selection: Selection | null;
  /** A row that the list must scroll into view. `seq` changes with each request. */
  reveal: { item: number; seq: number } | null;
  /** Changes with each cache change. */
  version: number;
};

type Page = { rows: ViewRow[]; bytes: number; settled: boolean };
/** A details read: the row of a `found` target, another contract Δ3 target, a canceled read, a failure code, or a view that ended. */
/** A failed `code` null: a `succeeded` response with a result of unknown form (feature 004 plan.md D15 "Malformed result"). */
export type Details = { state: "found"; row: ViewRow } | { state: "none" | "unknown" | "canceled" | "ended" } | { state: "failed"; code: string | null };

const INITIAL: Omit<HistoryState, "scope"> = {
  view: null,
  openedSeq: 0,
  opening: false,
  openFailure: null,
  viewRows: 0,
  complete: false,
  lanes: 1,
  load: null,
  halted: false,
  limit: null,
  deadline: null,
  loadFailure: null,
  stale: null,
  search: null,
  matchEnd: null,
  waiting: false,
  selection: null,
  reveal: null,
  version: 0,
};

/** The two rows above the commits (spec FR-013). */
export const SPECIAL_ROWS = 2;

/** Contract Δ8: the view keeps its rows and states its reason. */
const STALE_CODES = new Set(["HISTORY_CHANGED", "OBJECT_MISSING", "MALFORMED_GIT_OUTPUT", "GIT_FAILED", "REPOSITORY_UNAVAILABLE", "UNKNOWN_TARGET", "STATE_UNKNOWN", "SERVICE_UNAVAILABLE"]);
export const sameHead = (a: Head, b: Head) => a.state === b.state && (a as { target?: string }).target === (b as { target?: string }).target && (a as { oid?: string }).oid === (b as { oid?: string }).oid;

/** Contract Δ8: a newer `readRefs.refsDigest` or `readWorkspace.head` than the view shows the "References changed" notice. */
let requestSeq = 0;
/** Orders the read sends of `requests.ts` against the `openHistory` arrivals. WebView2 rounds `performance.now()`, so equal clock stamps cannot order them. */
export const nextRequestSeq = () => ++requestSeq;

export function refsChanged(view: Pick<Opened, "refsDigest" | "head"> | null, refsDigest: string | null, head: Head | null): boolean {
  if (view === null) return false;
  return (refsDigest !== null && refsDigest !== view.refsDigest) || (head !== null && !sameHead(head, view.head));
}

export type HistoryView = ReturnType<typeof createHistoryView>;

/** One history view of one repository. `target` gives the repository of each request. */
export function createHistoryView(bridge: HistoryBridge, target: () => { repositoryId: string; repositoryGeneration: number }, cacheLimit = HISTORY_RENDERER_CACHE_BYTES) {
  let state: HistoryState = { ...INITIAL, scope: "all" };
  const listeners = new Set<() => void>();
  // LRU order: Map insertion order, oldest first.
  const pages = new Map<number, Page>();
  let cacheBytes = 0;
  let cacheKey = "";
  let visible = { first: 0, last: -1 };
  // True after the list reported its first window.
  let shown = false;
  let moreShown = false;
  // The row n of the last `demand`.
  let needed = 0;
  // A newer view or a newer search makes older responses void.
  let epoch = 0;
  let searchSeq = 0;
  let revealSeq = 0;
  let reading = false;
  let loading: Promise<unknown> | null = null;
  let cancelWanted = false;

  const set = (next: Partial<HistoryState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const repository = () => ({ repositoryId: target().repositoryId });
  /** Contract Δ3: a `searchId` is valid only while its search runs and after it finished. A cancel, a failure, or a `limited` end ends it. */
  const liveSearch = () => {
    const search = state.search;
    return search !== null && search.searchId !== null && (search.state === "running" || search.state === "finished") ? search : null;
  };
  const filterMode = () => liveSearch()?.mode === "filter";
  const searching = () => state.search?.state === "running";
  /** The commit rows of the shown list. Filter mode lists the matches (contract gap: filter rows count by match). */
  const listRows = () => (filterMode() ? state.search!.matches : state.viewRows);
  /** Contract Δ3: the read target of the shown list. */
  const listComplete = () => (filterMode() ? state.search!.state === "finished" : state.complete || state.limit !== null);

  function rowsState(result: { rowCount: number; complete: boolean; lanes: number }): Partial<HistoryState> {
    return { viewRows: Math.max(state.viewRows, result.rowCount), complete: state.complete || result.complete, lanes: Math.max(state.lanes, result.lanes) };
  }

  /** Contract Δ3: `UNKNOWN_TARGET` of a read with `searchId` can name the ended search, not the view. Only a read without `searchId` makes the view stale then. */
  function readFailed(response: BridgeResponse, withSearch: boolean) {
    if (!(withSearch && response.code === "UNKNOWN_TARGET")) stale(response);
  }

  function stale(response: BridgeResponse): boolean {
    const code = response.code ?? (response.state === "unknown" ? "STATE_UNKNOWN" : undefined);
    if (code === undefined || !STALE_CODES.has(code)) return false;
    set({ stale: { code, reason: (response.result as Refusal | undefined)?.reason }, load: null });
    return true;
  }

  function select(id: string, index: number | null, mode: Selection["mode"] = filterMode() ? "filter" : "full", reveal = true) {
    const item = id === "working-directory" ? 0 : id === "index" ? 1 : index === null ? null : SPECIAL_ROWS + index;
    set({ selection: { id, index, mode }, matchEnd: null, ...(reveal && item !== null ? { reveal: { item, seq: ++revealSeq } } : {}) });
  }

  // ---- Row reads ----

  async function readAt(at: { row: number } | { oid: string } | { match: "next" | "previous"; from: number } | { end: true }, mode: "full" | "filter" = filterMode() ? "filter" : "full", text: "none" | "rows" | "details" = "rows") {
    const view = state.view;
    if (view === null) return null;
    const live = liveSearch();
    // `at: {match}` needs the search. Highlight rows carry `match`.
    const withSearch = live !== null && (mode === "filter" || live.mode === "highlight" || "match" in at);
    const response = await bridge.readHistoryRows(repository(), { viewId: view.viewId, mode, ...(withSearch ? { searchId: live.searchId! } : {}), at, count: 1, text });
    if (view !== state.view) return null;
    if (response.state !== "succeeded") {
      readFailed(response, withSearch);
      return null;
    }
    const result = response.result as Rows;
    if ("target" in result) set(rowsState(result));
    return "target" in result ? result : null;
  }

  function evict() {
    for (const [page, entry] of pages) {
      if (cacheBytes <= cacheLimit) return;
      if (page * PAGE_ROWS <= visible.last && (page + 1) * PAGE_ROWS > visible.first) continue;
      pages.delete(page);
      cacheBytes -= entry.bytes;
    }
  }

  function store(found: Found) {
    // The result `bytes` covers all its rows. Each page takes its share.
    const share = found.rows.length === 0 ? 0 : found.bytes / found.rows.length;
    const byPage = new Map<number, ViewRow[]>();
    for (const row of found.rows) {
      const page = Math.floor(row.index / PAGE_ROWS);
      byPage.set(page, [...(byPage.get(page) ?? []), row]);
    }
    for (const [page, rows] of byPage) {
      // A page keeps only the rows from its first row on, without a gap.
      const start = page * PAGE_ROWS;
      const contiguous: ViewRow[] = [];
      for (const row of rows) if (row.index === start + contiguous.length) contiguous.push(row);
      if (contiguous.length === 0) continue;
      const old = pages.get(page);
      if (old !== undefined) cacheBytes -= old.bytes;
      pages.delete(page);
      const settled = contiguous.every((r) => r.cell !== null && r.match !== null);
      pages.set(page, { rows: contiguous, bytes: share * contiguous.length, settled });
      cacheBytes += share * contiguous.length;
    }
    evict();
  }

  /** The cache holds the rows of one list: the view, the mode, and the search of highlight rows. */
  const keyNow = () => {
    const live = liveSearch();
    return `${state.view?.viewId}:${live?.mode === "filter" ? "filter" : "full"}:${live?.mode === "highlight" ? live.searchId : ""}`;
  };

  /** One row read in flight per view. The newest window wins: a read starts for it when the previous one ends. */
  function pump() {
    const view = state.view;
    if (reading || view === null || state.stale !== null) return;
    const live = liveSearch();
    const mode = live?.mode === "filter" ? "filter" : "full";
    const searchId = live === null ? null : live.searchId;
    const key = keyNow();
    if (key !== cacheKey) {
      pages.clear();
      cacheBytes = 0;
      cacheKey = key;
    }
    const total = listRows();
    const last = Math.min(visible.last, total - 1);
    if (last < visible.first) return;
    const missing: number[] = [];
    for (let page = Math.floor(visible.first / PAGE_ROWS); page <= Math.floor(last / PAGE_ROWS); page++) {
      const entry = pages.get(page);
      const expected = Math.min(PAGE_ROWS, total - page * PAGE_ROWS);
      if (entry === undefined || entry.rows.length < expected) missing.push(page);
      else {
        // The visible pages are the newest in LRU order.
        pages.delete(page);
        pages.set(page, entry);
      }
    }
    if (missing.length === 0) return;
    const first = missing[0]!;
    const count = Math.min(HISTORY_ROWS_PER_REQUEST, (missing.at(-1)! - first + 1) * PAGE_ROWS, total - first * PAGE_ROWS);
    reading = true;
    void textRead(() => bridge.readHistoryRows(repository(), { viewId: view.viewId, mode, ...(searchId !== null ? { searchId } : {}), at: { row: first * PAGE_ROWS }, count, text: "rows" })).then(
      (response) => {
        reading = false;
        if (view !== state.view) return pump();
        const result = response.result as Rows | undefined;
        if (response.state === "succeeded" && result !== undefined && "target" in result) {
          if (result.target === "found" && key === cacheKey) store(result);
          set({ ...rowsState(result), version: state.version + 1 });
          // A read that fills its first page makes progress. Another read follows only then, so a short result cannot loop.
          if (keyNow() !== key || pages.get(first)?.rows.length === Math.min(PAGE_ROWS, listRows() - first * PAGE_ROWS)) pump();
          return;
        }
        // A newer text read of the view cancels this one (contract Δ3).
        if (response.state === "canceled") return pump();
        readFailed(response, searchId !== null);
        if (keyNow() !== key) pump();
      },
    );
  }

  // Contract Δ3: a newer text read cancels an unfinished one of the same view. Page reads and details reads take turns, so they never cancel each other.
  let textQueue: Promise<unknown> = Promise.resolve();
  function textRead(run: () => Promise<BridgeResponse>): Promise<BridgeResponse> {
    const next = textQueue.then(run);
    textQueue = next.catch(() => {});
    return next;
  }

  /** plan.md D7 History-ready frame: every visible commit row has its text and its cell. A known empty list is ready. */
  function windowReady(): boolean {
    if (state.view === null || !shown) return false;
    const last = Math.min(visible.last, listRows() - 1);
    if (last < visible.first) return listComplete();
    for (let i = visible.first; i <= last; i++) {
      const r = row(i);
      if (r === undefined || r.cell === null || (r.subject === undefined && r.textLimit !== true)) return false;
    }
    return true;
  }

  /** The cached row of list index `i`, or undefined while it is not loaded. */
  function row(i: number): ViewRow | undefined {
    return pages.get(Math.floor(i / PAGE_ROWS))?.rows[i % PAGE_ROWS];
  }

  // ---- Loads ----

  function runLoad(need: { row: number } | { oid: string } | { end: true }, kind: "scroll" | "end" | "oid"): Promise<BridgeResponse | null> {
    const view = state.view!;
    cancelWanted = false;
    set({ load: { kind, rows: state.viewRows, operationId: null }, deadline: null, loadFailure: null });
    const done = bridge
      .loadHistory(repository(), { viewId: view.viewId, need }, (event) => {
        if (view !== state.view || state.load === null) return;
        // Contract Δ3: the `history-load` progress `rows` counts the rows that the view serves.
        const rows = event.counters.rows;
        set({ load: { ...state.load, operationId: event.operationId, rows: rows ?? state.load.rows }, ...(rows === undefined ? {} : { viewRows: Math.max(state.viewRows, rows) }) });
        if (cancelWanted) cancelLoad();
        else pump();
      })
      .then((response) => {
        if (view !== state.view) return null;
        loading = null;
        const result = response.result as (z.infer<typeof LoadHistoryResult> & Refusal) | undefined;
        const viewRows = Math.max(state.viewRows, typeof result?.rows === "number" ? result.rows : 0);
        if (response.state === "succeeded") set({ load: null, viewRows, complete: result?.complete === true });
        else if (response.state === "canceled") set({ load: null, viewRows, halted: true });
        else if (response.code === "DEADLINE") set({ load: null, viewRows, halted: true, deadline: result?.remedy ?? null });
        else if (response.code === "OUTPUT_LIMIT") set({ load: null, viewRows, limit: { reason: result?.reason ?? "" } });
        else if (!stale(response)) set({ load: null, viewRows, halted: true, loadFailure: { code: response.code ?? response.state, reason: result?.reason } });
        pump();
        return response;
      });
    loading = done;
    return done;
  }

  /** Cancels the running load. Its rows and the selection stay (spec FR-009). */
  function cancelLoad() {
    const operationId = state.load?.operationId;
    if (operationId === undefined) return;
    if (operationId === null) cancelWanted = true;
    else void bridge.cancel({ operationId });
  }

  /** plan.md D6: End and a search first cancel a running load and wait for its terminal response. */
  async function settleLoad() {
    if (loading === null) return;
    const running = loading;
    cancelLoad();
    await running;
  }

  /** `first` and `last` are the commit rows of the window. `more` is true while the more-rows row shows. `need` is the plan.md D6 row n. */
  function demand(first: number, last: number, more: boolean, need: number) {
    if (more && !moreShown && state.halted) set({ halted: false });
    moreShown = more;
    needed = need;
    visible = { first, last };
    shown = true;
    pump();
    if (state.view === null || filterMode() || state.complete || state.load !== null || searching() || state.stale !== null || state.limit !== null || state.halted) return;
    // plan.md D6: a load starts when fewer than M loaded rows lie below row n.
    if (state.viewRows - 1 - need < HISTORY_LOAD_MARGIN) void runLoad({ row: Math.max(0, need) }, "scroll");
  }

  /** Clears a halt and a load failure, then demands the last window again (plan.md D6). */
  function retry() {
    set({ halted: false, loadFailure: null });
    demand(visible.first, visible.last, moreShown, needed);
  }

  /** Spec FR-009: End loads to the last commit, then selects it. */
  async function end() {
    if (state.view === null) return;
    if (filterMode()) {
      if (state.search!.matches > 0) {
        const found = await readAt({ end: true }, "filter");
        if (found?.target === "found") select(found.rows[0]!.oid, found.rows[0]!.index);
      }
      return;
    }
    if (!state.complete && state.stale === null && state.limit === null && !searching()) {
      if (state.load !== null && state.load.kind !== "scroll") return;
      await settleLoad();
      const response = await runLoad({ end: true }, "end");
      if (response?.state !== "succeeded") return;
    }
    const found = await readAt({ end: true }, "full");
    if (found?.target === "found") select(found.rows[0]!.oid, found.rows[0]!.index, "full");
  }

  // ---- Views ----

  /** Spec FR-008: the checkout commit when the view holds it, else the first commit row. */
  async function selectFallback() {
    const head = state.view?.head;
    const checkout = head === undefined || head.state === "unborn" ? null : await readAt({ oid: head.oid }, "full", "none");
    if (checkout?.target === "found") return select(checkout.rows[0]!.oid, checkout.rows[0]!.index, "full");
    const first = await readAt({ row: 0 }, "full", "none");
    if (first?.target === "found") select(first.rows[0]!.oid, 0, "full");
  }

  /** Opens a new view. Refresh and a scope switch keep the selected commit (spec FR-008, FR-049) and the filter text and mode. */
  async function open(scope: Scope, keep = true) {
    const oid = keep && state.selection !== null && state.selection.index !== null ? state.selection.id : null;
    const search = keep ? state.search : null;
    if (searching() && state.search!.searchId !== null) void bridge.cancel({ operationId: state.search!.searchId });
    const mine = ++epoch;
    searchSeq++;
    pages.clear();
    cacheBytes = 0;
    loading = null;
    // Spec FR-034: a repository open shows no selected row.
    set({ ...INITIAL, scope, opening: true, selection: keep ? state.selection : null, version: state.version + 1 });
    let response = await bridge.openHistory(target(), { scope });
    // Feature 001 contract §9 rule, kept by plan.md P7: REPOSITORY_CHANGED sends one new request with the current generation.
    if (mine === epoch && response.code === "REPOSITORY_CHANGED") response = await bridge.openHistory(target(), { scope });
    if (mine !== epoch) return;
    const result = response.result as (Opened & Refusal) | undefined;
    if (response.state !== "succeeded" || result?.viewId === undefined) {
      set({ opening: false, openFailure: { code: response.state === "succeeded" ? null : (response.code ?? response.state), reason: result?.reason, remedy: result?.remedy } });
      return;
    }
    // Contract Δ3: an empty repository gives a view with `startCount` 0. It has no commit to load.
    const again = search !== null && (search.state === "running" || search.state === "finished");
    // A running search blocks scroll loads from the first render of the new view: the filter sends only `searchHistory` (plan.md D6).
    set({ view: result, openedSeq: nextRequestSeq(), opening: false, complete: result.startCount === 0, ...(again ? { search: { ...search, state: "running", searchId: null, matches: 0, settled: 0 } } : {}) });
    if (again) return void runSearch(search.text, search.mode, oid);
    if (oid === null) return pump();
    const loaded = await runLoad({ oid }, "oid");
    if (mine !== epoch || loaded === null) return;
    if (loaded.state === "succeeded") {
      const found = await readAt({ oid }, "full", "none");
      if (found?.target === "found") return select(oid, found.rows[0]!.index, "full");
    }
    await selectFallback();
  }

  // ---- Search ----

  async function runSearch(text: string, mode: HistoryMode, keepOid: string | null) {
    const view = state.view;
    if (view === null) return;
    await settleLoad();
    if (view !== state.view) return;
    const mine = ++searchSeq;
    set({ search: { text, mode, state: "running", searchId: null, matches: 0, settled: 0, shallow: false }, matchEnd: null, version: state.version + 1 });
    const response = await bridge.searchHistory(repository(), { viewId: view.viewId, text }, (event) => {
      if (mine !== searchSeq || state.search === null) return;
      set({ search: { ...state.search, searchId: event.operationId, matches: event.counters.matches ?? state.search.matches, settled: event.counters.settled ?? state.search.settled } });
      // Rows that were not settled can be settled now.
      for (const [page, entry] of pages) if (!entry.settled) (pages.delete(page), (cacheBytes -= entry.bytes));
      pump();
    });
    if (mine !== searchSeq || state.search === null) return;
    const result = response.result as (z.infer<typeof SearchHistoryResult> & Refusal) | undefined;
    const search = state.search;
    if (response.state === "succeeded" && result !== undefined && "matches" in result) {
      for (const [page, entry] of pages) if (!entry.settled) (pages.delete(page), (cacheBytes -= entry.bytes));
      // Contract Δ3: a finished search loaded the view to its end. The next row read gives the row count.
      set({ search: { ...search, state: "finished", matches: result.matches, shallow: result.shallow }, complete: true, version: state.version + 1 });
      pump();
      await keepSelection(keepOid ?? (state.selection?.index !== null ? (state.selection?.id ?? null) : null));
      return;
    }
    if (response.state === "canceled") return endSearch({ ...search, state: "stopped" });
    if (stale(response)) return endSearch({ ...search, state: "stopped" });
    const refused = response.code === "UNSUPPORTED_FILTER_TEXT" || response.code === "SEARCH_UNSUPPORTED" || response.code === "OUTPUT_LIMIT";
    await endSearch({ ...search, state: refused ? "refused" : "failed", code: response.state === "succeeded" ? undefined : (response.code ?? response.state), reason: result?.reason, remedy: result?.remedy });
  }

  /** Contract Δ3: an ended search ends its `searchId`. The full list returns with the selected commit. */
  async function endSearch(next: SearchState) {
    const wasFilter = filterMode();
    set({ search: next, waiting: false, version: state.version + 1 });
    pump();
    if (wasFilter) await toFull();
  }

  /** Maps a selection of the filter list to its row in the full list. */
  async function toFull() {
    const selection = state.selection;
    if (selection === null || selection.index === null || selection.mode === "full") return;
    const found = await readAt({ oid: selection.id }, "full", "none");
    if (found?.target === "found" && state.selection?.id === selection.id) select(selection.id, found.rows[0]!.index, "full");
  }

  /** Spec FR-042: keep the selected commit. In filter mode, a commit that does not match moves to the next match, else to the last match. */
  async function keepSelection(oid: string | null) {
    if (oid === null || state.search === null) return;
    if (state.search.mode === "highlight") {
      const found = await readAt({ oid }, "full", "none");
      if (found?.target === "found") select(oid, found.rows[0]!.index, "full");
      return;
    }
    const match = await readAt({ oid }, "filter", "none");
    if (match?.target === "found") return select(oid, match.rows[0]!.index, "filter");
    const full = await readAt({ oid }, "full", "none");
    const from = full?.target === "found" ? full.rows[0]!.index + 1 : 0;
    const next = await readAt({ match: "next", from }, "full", "none");
    const targetOid = next?.target === "found" ? next.rows[0]!.oid : null;
    const found = targetOid === null ? await readAt({ end: true }, "filter", "none") : await readAt({ oid: targetOid }, "filter", "none");
    if (found?.target === "found") select(found.rows[0]!.oid, found.rows[0]!.index, "filter");
  }

  /** Spec FR-029: only Enter starts a search. The renderer runs the `filter-text.ts` checks first. */
  async function search(text: string, mode: HistoryMode) {
    const checked = filterText(text, FILTER_TEXT_BYTES);
    if (checked.kind === "none") return clearSearch();
    if (state.search?.text === text && state.search.state !== "stopped" && state.search.state !== "failed") return setMode(mode);
    stopSearch();
    if (checked.kind === "refused") {
      set({ search: { text, mode, state: "refused", searchId: null, matches: 0, settled: 0, shallow: false, code: "UNSUPPORTED_FILTER_TEXT", reason: checked.reason, found: checked.found }, version: state.version + 1 });
      return;
    }
    if (state.view === null || state.stale !== null) return;
    const oid = state.selection !== null && state.selection.index !== null ? state.selection.id : null;
    await runSearch(checked.text, mode, oid);
  }

  /** Spec FR-030: the running search stops, and no count shows as final. */
  function stopSearch() {
    searchSeq++;
    if (searching() && state.search!.searchId !== null) void bridge.cancel({ operationId: state.search!.searchId });
  }

  /** A changed text, a cleared text, and Escape: the full history returns with the selection kept. */
  async function clearSearch() {
    const had = state.search;
    stopSearch();
    if (had === null) return;
    set({ search: null, matchEnd: null, waiting: false, version: state.version + 1 });
    pump();
    await toFull();
  }

  /** Spec FR-041: a mode switch with unchanged text sends no new search. */
  async function setMode(mode: HistoryMode) {
    const search = state.search;
    if (search === null || search.mode === mode) return;
    const oid = state.selection !== null && state.selection.index !== null ? state.selection.id : null;
    set({ search: { ...search, mode }, matchEnd: null, version: state.version + 1 });
    pump();
    if (search.state === "finished") await keepSelection(oid);
  }

  /** Spec FR-037, FR-038: Next match and Previous match. A target that is not loaded waits for the search with progress and Cancel. */
  async function match(direction: "next" | "previous") {
    const search = liveSearch();
    if (search === null) return;
    const selection = state.selection;
    const end = direction === "next" ? "last" : "first";
    if (search.mode === "filter" && (selection === null || selection.index === null || selection.mode === "filter")) {
      const index = selection?.index ?? null;
      const to = direction === "next" ? (index ?? -1) + 1 : (index ?? 0) - 1;
      if (to < 0) return set({ matchEnd: "first" });
      if (to >= search.matches && search.state === "finished") return set({ matchEnd: "last" });
      set({ waiting: searching() });
      const found = await readAt({ row: to }, "filter", "none");
      set({ waiting: false });
      if (found?.target === "found") select(found.rows[0]!.oid, to, "filter");
      else if (found?.target === "none") set({ matchEnd: end });
      return;
    }
    // Contract Δ3: `from` is a view row. A selection from the filter list maps to its view row by OID first.
    let index = selection?.index ?? null;
    if (selection !== null && index !== null && selection.mode === "filter") {
      const full = await readAt({ oid: selection.id }, "full", "none");
      if (full?.target !== "found") return;
      index = full.rows[0]!.index;
    }
    const from = direction === "next" ? (index === null ? 0 : index + 1) : index === null ? -1 : index - 1;
    if (from < 0) return set({ matchEnd: "first" });
    set({ waiting: searching() });
    const found = await readAt({ match: direction, from }, "full", "none");
    if (found?.target !== "found" || search.mode === "highlight") {
      set({ waiting: false });
      if (found?.target === "found") select(found.rows[0]!.oid, found.rows[0]!.index, "full");
      else if (found?.target === "none") set({ matchEnd: end });
      return;
    }
    // A filter list with a selection from the full list: the match position comes from its OID.
    const oid = found.rows[0]!.oid;
    const position = await readAt({ oid }, "filter", "none");
    set({ waiting: false });
    if (position?.target === "found") select(oid, position.rows[0]!.index, "filter");
  }

  /** Cancels the running search. The loaded rows stay (contract Δ3). */
  function cancelSearch() {
    if (searching() && state.search!.searchId !== null) void bridge.cancel({ operationId: state.search!.searchId });
  }

  /** Selects a commit of the shown list by OID, as a details link or a reference does. It gives the contract Δ3 target, or null without a result. */
  async function selectOid(oid: string): Promise<"found" | "none" | "unknown" | null> {
    const found = await readAt({ oid }, filterMode() ? "filter" : "full", "none");
    if (found?.target === "found") select(oid, found.rows[0]!.index);
    return found?.target ?? null;
  }

  /** Spec FR-017: the body loads only when the details pane shows the commit. It gives the response state, and the row of a `found` target. */
  async function readDetails(oid: string): Promise<Details> {
    const view = state.view;
    if (view === null) return { state: "ended" };
    const response = await textRead(() => bridge.readHistoryRows(repository(), { viewId: view.viewId, mode: "full", at: { oid }, count: 1, text: "details" }));
    if (view !== state.view) return { state: "ended" };
    const result = response.result as Rows | undefined;
    if (response.state === "succeeded" && result !== undefined && "target" in result) {
      set(rowsState(result));
      return result.target === "found" ? { state: "found", row: result.rows[0]! } : { state: result.target };
    }
    if (response.state === "canceled") return { state: "canceled" };
    stale(response);
    return { state: "failed", code: response.state === "succeeded" ? null : (response.code ?? response.state) };
  }

  /** Contract Δ8: after a service restart no view resumes. */
  function markStale(code = "UNKNOWN_TARGET") {
    if (state.view !== null) set({ stale: { code }, load: null });
  }

  function close() {
    const view = state.view;
    stopSearch();
    epoch++;
    if (view !== null) void bridge.closeHistory(repository(), { viewId: view.viewId });
    pages.clear();
    cacheBytes = 0;
    set({ ...INITIAL, scope: state.scope });
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    open,
    refresh: () => open(state.scope),
    setScope: (scope: Scope) => (scope === state.scope ? Promise.resolve() : open(scope)),
    demand,
    retry,
    end,
    cancelLoad,
    row,
    windowReady,
    listRows,
    listComplete,
    filterMode,
    select,
    search,
    clearSearch,
    setMode,
    match,
    cancelSearch,
    selectOid,
    readDetails,
    markStale,
    close,
    /** The renderer cache in bytes, for the T038 bound check. */
    cacheBytes: () => cacheBytes,
    cachedPages: () => [...pages.keys()],
  };
}

// ---- Feature 005 plan.md D3, D12, and D15 "State": the commit changes, the selected file, the parent index, and the blame ----

export type InspectionBridge = Pick<ReturnType<typeof createBridge>, "readCommitChanges" | "readCommitFile" | "readBlame" | "cancel">;
type ProgressHandler = NonNullable<Parameters<InspectionBridge["readBlame"]>[2]>;
type ProgressEvent = Parameters<ProgressHandler>[0];
export type BlameOptions = { ignoreWhitespace: boolean; detectMoves: boolean; detectCopies: boolean; ignoreList: boolean };
export type BlameSource = { changesId: string; fileId: number } | { snapshotId: string; entryId: string } | { blameId: string; line: number };
/** A blame to run: the source, and the path and commit that the heading names until the result arrives. */
export type BlameRequest = { source: BlameSource; path: string; oid: string };
/** `code` null: a `succeeded` response with a result of unknown form (feature 004 plan.md D15 "Malformed result"). */
type Failure = { code: string | null; remedy?: { text: string } };
type ChangesKey = { viewId: string; oid: string; parent: number };
export type ChangesRead = ChangesKey & ({ state: "loading" } | { state: "loaded"; result: CommitChanges } | ({ state: "failed"; trust: boolean } & Failure));
export type FileRead = { changesId: string; fileId: number } & ({ state: "loading" } | { state: "loaded"; result: CommitFile } | ({ state: "failed" } & Failure));
export type BlameRun =
  | { state: "running"; operationId: string | null; blamed?: number; total?: number }
  | { state: "done"; result: Blame }
  | { state: "refused"; reason: BlameUnavailableReason; path?: string }
  | ({ state: "failed"; outputTail?: string } & Failure)
  | { state: "stopped" };
/** `ignoreList` is the effective list state of the last result, null before the first one (spec FR-059). `line` is the selected line. */
export type BlameState = { request: BlameRequest; options: BlameOptions; line: number; ignoreList: Blame["ignoreList"] | null; run: BlameRun };
export type InspectionState = { changes: ChangesRead | null; file: FileRead | null; blame: BlameState | null };
export type Inspection = ReturnType<typeof createInspection>;

/** Spec FR-057 and FR-059: the toggles start off, and the ignore list starts on. */
export const BLAME_START: BlameOptions = { ignoreWhitespace: false, detectMoves: false, detectCopies: false, ignoreList: true };
const TRUST_CODES = new Set(["TRUST_REQUIRED", "TRUST_CHANGED"]);
const utf8 = new TextDecoder("utf-8");
/** The display text of base64 bytes. Bytes that are not valid UTF-8 show as replacement characters. */
export const textOf = (base64: string) => utf8.decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

/** The group of the final line `line` (1-based). The groups cover the lines 1 to N in order (contract `Blame`). */
export function groupAt(blame: Pick<Blame, "groups">, line: number): Blame["groups"][number] | undefined {
  const groups = blame.groups;
  let low = 0;
  let high = groups.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const g = groups[mid]!;
    if (line < g.finalStart) high = mid - 1;
    else if (line >= g.finalStart + g.count) low = mid + 1;
    else return g;
  }
  return undefined;
}

/** The 001 latest-wins rule of one read kind: a new read supersedes the older one, cancels it, and its response shows nothing. */
function latestRead(cancel: InspectionBridge["cancel"]) {
  type Read = { operationId: string | null; dropped: boolean; stop: boolean };
  let current: Read | null = null;
  const end = (read: Read) => {
    if (read.operationId !== null) void cancel({ operationId: read.operationId });
  };
  const drop = () => {
    if (current === null) return;
    current.dropped = true;
    end(current);
    current = null;
  };
  return {
    drop,
    /** Cancels the running read. Its `canceled` response still arrives. */
    stop() {
      if (current === null) return;
      current.stop = true;
      end(current);
    },
    async run(send: (onProgress: ProgressHandler) => Promise<BridgeResponse>, onEvent?: (event: ProgressEvent) => void): Promise<BridgeResponse | null> {
      drop();
      const mine: Read = { operationId: null, dropped: false, stop: false };
      current = mine;
      // Contract §2: the accepted event carries the `operationId` that `cancel` names. A read dropped or stopped before it ends here.
      const response = await send((event) => {
        if (mine.operationId === null) {
          mine.operationId = event.operationId;
          if (mine.dropped || mine.stop) return end(mine);
        }
        if (!mine.dropped) onEvent?.(event);
      });
      if (mine.dropped) return null;
      current = null;
      return response;
    },
  };
}

const failureOf = (response: BridgeResponse): Failure => {
  const remedy = (response.result as { remedy?: { text?: unknown } } | undefined)?.remedy;
  return { code: response.state === "succeeded" ? null : (response.code ?? response.state), ...(response.code === "OBJECT_MISSING" && typeof remedy?.text === "string" ? { remedy: { text: remedy.text } } : {}) };
};

/** The History inspection of one repository: the changes of the selected commit, its shown file, and the blame view. */
export function createInspection(bridge: InspectionBridge, target: () => { repositoryId: string; repositoryGeneration: number }) {
  let state: InspectionState = { changes: null, file: null, blame: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<InspectionState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const setBlame = (next: Partial<BlameState>) => {
    if (state.blame !== null) set({ blame: { ...state.blame, ...next } });
  };
  const changesRead = latestRead((payload) => bridge.cancel(payload));
  const fileRead = latestRead((payload) => bridge.cancel(payload));
  const blameRead = latestRead((payload) => bridge.cancel(payload));

  /** Plan.md D3 "Selection": a commit row and a parent index give one listing. The same key reads again only after a failure or with `again`. */
  async function readChanges(viewId: string, oid: string, parent: number, again = false) {
    const c = state.changes;
    if (!again && c !== null && c.viewId === viewId && c.oid === oid && c.parent === parent && c.state !== "failed") return;
    fileRead.drop();
    const key = { viewId, oid, parent };
    set({ changes: { ...key, state: "loading" }, file: null });
    const send = () => changesRead.run((onProgress) => bridge.readCommitChanges(target(), key, onProgress));
    let response = await send();
    // Feature 001 contract §9 rule: REPOSITORY_CHANGED sends one new request with the current generation.
    if (response?.code === "REPOSITORY_CHANGED") response = await send();
    if (response === null) return;
    const result = response.result as CommitChanges | undefined;
    if (response.state === "succeeded" && Array.isArray(result?.files) && Array.isArray(result.parents) && result.base !== undefined) set({ changes: { ...key, state: "loaded", result } });
    else set({ changes: { ...key, state: "failed", trust: TRUST_CODES.has(response.code ?? ""), ...failureOf(response) } });
  }

  /** Spec FR-007: a file of the listing shows its diff. Null clears the selection (004 FR-101). */
  async function selectFile(fileId: number | null) {
    const c = state.changes;
    if (fileId === null || c?.state !== "loaded") {
      fileRead.drop();
      return set({ file: null });
    }
    const changesId = c.result.changesId;
    const f = state.file;
    if (f !== null && f.changesId === changesId && f.fileId === fileId && f.state !== "failed") return;
    set({ file: { changesId, fileId, state: "loading" } });
    const response = await fileRead.run((onProgress) => bridge.readCommitFile(target(), { changesId, fileId }, onProgress));
    if (response === null) return;
    const result = response.result as CommitFile | undefined;
    if ((response.state === "succeeded" || response.state === "limited") && typeof result?.fileId === "number" && result.facts !== undefined) set({ file: { changesId, fileId, state: "loaded", result } });
    else set({ file: { changesId, fileId, state: "failed", ...failureOf(response) } });
  }

  async function runBlame(keepLine: boolean) {
    const blame = state.blame;
    if (blame === null) return;
    const { source } = blame.request;
    setBlame({ run: { state: "running", operationId: null } });
    const response = await blameRead.run(
      (onProgress) => bridge.readBlame(target(), { source, options: blame.options }, onProgress),
      (event) => {
        if (state.blame?.run.state !== "running") return;
        // Spec FR-063: `blamed` and `total` without an ignore list, no counters with one.
        setBlame({ run: { state: "running", operationId: event.operationId, blamed: event.counters.blamed, total: event.counters.total } });
      },
    );
    if (response === null || state.blame === null) return;
    const result = response.result as (Blame & { reason?: BlameUnavailableReason; path?: string; outputTail?: string }) | undefined;
    if (response.state === "succeeded" && Array.isArray(result?.groups) && Array.isArray(result.commits) && typeof result.lines === "number") {
      const line = result.focusLine ?? (keepLine ? Math.min(Math.max(1, state.blame.line), Math.max(1, result.lines)) : 1);
      return setBlame({ run: { state: "done", result }, line, ignoreList: result.ignoreList });
    }
    if (response.state === "canceled") return setBlame({ run: { state: "stopped" } });
    if (response.code === "BLAME_UNAVAILABLE" && typeof result?.reason === "string") return setBlame({ run: { state: "refused", reason: result.reason, ...(typeof result.path === "string" ? { path: result.path } : {}) } });
    setBlame({ run: { state: "failed", ...failureOf(response), ...(typeof result?.outputTail === "string" ? { outputTail: result.outputTail } : {}) } });
  }

  /** The `previous` of the selected line's commit (git-blame(1) porcelain), or null. */
  function previousOf(): { blameId: string; line: number; oid: string; path: string } | null {
    const blame = state.blame;
    if (blame?.run.state !== "done") return null;
    const result = blame.run.result;
    const group = groupAt(result, blame.line);
    const previous = group === undefined ? null : (result.commits[group.commit]?.previous ?? null);
    return previous === null ? null : { blameId: result.blameId, line: blame.line, oid: previous.oid, path: textOf(previous.pathBytes) };
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    readChanges,
    selectFile,
    previousOf,
    /** Plan.md D15 "Blame view": the blame view opens with the options of spec FR-057 and FR-059. */
    openBlame(request: BlameRequest) {
      set({ blame: { request, options: BLAME_START, line: 1, ignoreList: null, run: { state: "running", operationId: null } } });
      void runBlame(false);
    },
    /** The commit of the selected line, or null without a result. */
    lineCommit(): string | null {
      const blame = state.blame;
      if (blame?.run.state !== "done") return null;
      const group = groupAt(blame.run.result, blame.line);
      return group === undefined ? null : (blame.run.result.commits[group.commit]?.oid ?? null);
    },
    selectLine: (line: number) => setBlame({ line }),
    /** Spec FR-057 and FR-059: a changed option runs the blame of the same source again. */
    setBlameOptions(next: Partial<BlameOptions>) {
      const blame = state.blame;
      if (blame === null) return;
      setBlame({ options: { ...blame.options, ...next } });
      void runBlame(true);
    },
    /** Spec FR-056: "Blame before this commit" of the selected line. A line without `previous` does nothing. */
    blameBefore() {
      const previous = previousOf();
      if (previous === null) return;
      setBlame({ request: { source: { blameId: previous.blameId, line: previous.line }, path: previous.path, oid: previous.oid }, line: 1 });
      void runBlame(false);
    },
    cancelBlame: () => blameRead.stop(),
    closeBlame() {
      blameRead.drop();
      set({ blame: null });
    },
    /** A repository change or a service restart: every retained ID is void. */
    reset() {
      changesRead.drop();
      fileRead.drop();
      blameRead.drop();
      set({ changes: null, file: null, blame: null });
    },
  };
}
