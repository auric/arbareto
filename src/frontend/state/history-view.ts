// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { z } from "zod";
import type { HistoryPage, HistoryViewRow, LoadHistoryResult, OpenHistoryResult, ReadHistoryRowsResult, SearchHistoryResult } from "../../contracts/envelope";
import { filterText } from "../../contracts/filter-text";
import { HISTORY_LOAD_MARGIN, HISTORY_RENDERER_CACHE_BYTES, HISTORY_ROWS_PER_REQUEST } from "../../contracts/limits";
import type { BridgeResponse, createBridge } from "../bridge";

// Feature 002 plan.md D5 and D6, data-model §6 and §8, contract Δ3 and Δ8. The service holds the view. This store holds O(visible + cache) only.

export type HistoryBridge = Pick<ReturnType<typeof createBridge>, "openHistory" | "loadHistory" | "readHistoryRows" | "searchHistory" | "closeHistory" | "cancel">;
export type ViewRow = z.infer<typeof HistoryViewRow>;
export type Head = HistoryPage["head"];
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
  opening: boolean;
  openFailure: { code: string; reason?: string; remedy?: Remedy } | null;
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

const INITIAL: Omit<HistoryState, "scope"> = {
  view: null,
  opening: false,
  openFailure: null,
  viewRows: 0,
  complete: false,
  lanes: 1,
  load: null,
  halted: false,
  limit: null,
  deadline: null,
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
const sameHead = (a: Head, b: Head) => a.state === b.state && (a as { target?: string }).target === (b as { target?: string }).target && (a as { oid?: string }).oid === (b as { oid?: string }).oid;

/** Contract Δ8: a newer `readRefs.refsDigest` or `readWorkspace.head` than the view shows the "References changed" notice. */
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
  let moreShown = false;
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
  const filterMode = () => state.search?.mode === "filter" && state.search.searchId !== null;
  const searching = () => state.search?.state === "running";
  /** The commit rows of the shown list. Filter mode lists the matches (contract gap: filter rows count by match). */
  const listRows = () => (filterMode() ? state.search!.matches : state.viewRows);
  /** Contract Δ3: the read target of the shown list. */
  const listComplete = () => (filterMode() ? state.search!.state === "finished" : state.complete || state.limit !== null);

  function rowsState(result: { rowCount: number; complete: boolean; lanes: number }): Partial<HistoryState> {
    return { viewRows: Math.max(state.viewRows, result.rowCount), complete: state.complete || result.complete, lanes: Math.max(state.lanes, result.lanes) };
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
    const searchId = state.search?.searchId ?? undefined;
    // `at: {match}` needs the search. Highlight rows carry `match`.
    const withSearch = searchId !== undefined && (mode === "filter" || state.search?.mode === "highlight" || "match" in at);
    const response = await bridge.readHistoryRows(repository(), { viewId: view.viewId, mode, ...(withSearch ? { searchId } : {}), at, count: 1, text });
    if (view !== state.view) return null;
    if (response.state !== "succeeded") {
      stale(response);
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
  const keyNow = () => `${state.view?.viewId}:${filterMode() ? "filter" : "full"}:${state.search?.mode === "highlight" ? state.search.searchId : ""}`;

  /** One row read in flight per view. The newest window wins: a read starts for it when the previous one ends. */
  function pump() {
    const view = state.view;
    if (reading || view === null || state.stale !== null) return;
    const searchId = state.search?.searchId ?? null;
    const mode = filterMode() ? "filter" : "full";
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
    void bridge
      .readHistoryRows(repository(), { viewId: view.viewId, mode, ...(searchId !== null && (mode === "filter" || state.search?.mode === "highlight") ? { searchId } : {}), at: { row: first * PAGE_ROWS }, count, text: "rows" })
      .then((response) => {
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
        stale(response);
      });
  }

  /** The cached row of list index `i`, or undefined while it is not loaded. */
  function row(i: number): ViewRow | undefined {
    return pages.get(Math.floor(i / PAGE_ROWS))?.rows[i % PAGE_ROWS];
  }

  // ---- Loads ----

  function runLoad(need: { row: number } | { oid: string } | { end: true }, kind: "scroll" | "end" | "oid"): Promise<BridgeResponse | null> {
    const view = state.view!;
    cancelWanted = false;
    set({ load: { kind, rows: state.viewRows, operationId: null }, deadline: null });
    const done = bridge
      .loadHistory(repository(), { viewId: view.viewId, need }, (event) => {
        if (view !== state.view || state.load === null) return;
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
        else if (!stale(response)) set({ load: null, viewRows });
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
    visible = { first, last };
    pump();
    if (state.view === null || filterMode() || state.complete || state.load !== null || searching() || state.stale !== null || state.limit !== null || state.halted) return;
    // plan.md D6: a load starts when fewer than M loaded rows lie below row n.
    if (state.viewRows - 1 - need < HISTORY_LOAD_MARGIN) void runLoad({ row: Math.max(0, need) }, "scroll");
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
    set({ ...INITIAL, scope, opening: true, selection: state.selection, version: state.version + 1 });
    const response = await bridge.openHistory(target(), { scope });
    if (mine !== epoch) return;
    const result = response.result as (Opened & Refusal) | undefined;
    if (response.state !== "succeeded" || result?.viewId === undefined) {
      set({ opening: false, openFailure: { code: response.code ?? response.state, reason: result?.reason, remedy: result?.remedy } });
      return;
    }
    // Contract Δ3: an empty repository gives a view with `startCount` 0. It has no commit to load.
    const again = search !== null && (search.state === "running" || search.state === "finished");
    // A running search blocks scroll loads from the first render of the new view: the filter sends only `searchHistory` (plan.md D6).
    set({ view: result, opening: false, complete: result.startCount === 0, ...(again ? { search: { ...search, state: "running", searchId: null, matches: 0, settled: 0 } } : {}) });
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
    if (response.state === "canceled") return set({ search: { ...search, state: "stopped" } });
    if (stale(response)) return set({ search: { ...search, state: "stopped" } });
    const refused = response.code === "UNSUPPORTED_FILTER_TEXT" || response.code === "SEARCH_UNSUPPORTED" || response.code === "OUTPUT_LIMIT";
    set({ search: { ...search, state: refused ? "refused" : "failed", code: response.code ?? response.state, reason: result?.reason, remedy: result?.remedy } });
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
    const checked = filterText(text);
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
    const oid = state.selection !== null && state.selection.index !== null ? state.selection.id : null;
    set({ search: null, matchEnd: null, waiting: false, version: state.version + 1 });
    pump();
    if (oid !== null && had.mode === "filter") {
      const found = await readAt({ oid }, "full", "none");
      if (found?.target === "found") select(oid, found.rows[0]!.index, "full");
    }
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
    const search = state.search;
    if (search === null || search.searchId === null) return;
    const selection = state.selection;
    const index = selection?.index ?? null;
    if (search.mode === "filter") {
      const to = direction === "next" ? (index ?? -1) + 1 : (index ?? 0) - 1;
      if (to < 0) return set({ matchEnd: "first" });
      if (to >= search.matches && search.state === "finished") return set({ matchEnd: "last" });
      const found = await readAt({ row: to }, "filter", "none");
      if (found?.target === "found") select(found.rows[0]!.oid, to, "filter");
      return;
    }
    const from = direction === "next" ? (index === null ? 0 : index + 1) : index === null ? -1 : index - 1;
    if (from < 0) return set({ matchEnd: "first" });
    set({ waiting: searching() });
    const found = await readAt({ match: direction, from }, "full", "none");
    set({ waiting: false });
    if (found?.target === "found") select(found.rows[0]!.oid, found.rows[0]!.index, "full");
    else if (found?.target === "none") set({ matchEnd: direction === "next" ? "last" : "first" });
  }

  /** Cancels the running search. The loaded rows stay (contract Δ3). */
  function cancelSearch() {
    if (searching() && state.search!.searchId !== null) void bridge.cancel({ operationId: state.search!.searchId });
  }

  /** Selects a commit of the shown list by OID, as a details link does. */
  async function selectOid(oid: string) {
    const found = await readAt({ oid }, filterMode() ? "filter" : "full", "none");
    if (found?.target === "found") select(oid, found.rows[0]!.index);
  }

  /** Spec FR-017: the body loads only when the details pane shows the commit. */
  function readDetails(oid: string) {
    return readAt({ oid }, "full", "details");
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
    end,
    cancelLoad,
    row,
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
