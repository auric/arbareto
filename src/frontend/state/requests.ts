// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry, HistoryPage, ReadEntriesResult, WorkspaceSnapshot } from "../../contracts/envelope";
import type { BridgeResponse, OnProgress } from "../bridge";
import type { Mode } from "../keyboard/shortcuts";

// Contract §2, §3 "HistoryPage result", §5 "Pending reads", §8, and §11 "Change polling". plan.md "Freshness and reconciliation".

type Head = WorkspaceSnapshot["head"];
type Check = "full" | "changes";
type Target = { repositoryId: string; repositoryGeneration: number };

export type Registration = { repositoryId: string; generation: number; worktreeKey: string };

/** The bridge operations that this module calls. `createBridge` in `bridge.ts` provides them. */
export type RequestBridge = {
  restoreWorkspace(): Promise<BridgeResponse>;
  readWorkspace(target: { repositoryId: string }, payload: { refresh: boolean; check: Check }, onProgress?: OnProgress): Promise<BridgeResponse>;
  readEntries(target: Target, payload: { snapshotId: string; cursor: string }): Promise<BridgeResponse>;
  readHistory(target: Target): Promise<BridgeResponse>;
  readComparison(target: Target & { selectionId: string }, payload: { snapshotId: string; entryId: string }): Promise<BridgeResponse>;
  cancel(payload: { operationId: string }): Promise<BridgeResponse>;
};
export type Clock = {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};
export type FocusSource = { hasFocus(): boolean; subscribe(listener: (focused: boolean) => void): () => void };

// The T331 `ReadComparisonResult` type is on another branch. These are the only fields that this module reads.
type ComparisonHunk = { hunkId: string; digest: string };
type ComparisonFields = { comparisonId: string; snapshotId: string; hunks: readonly ComparisonHunk[] };

export type Selection = { entryId: string; category: ChangeEntry["category"]; pathBytes: string };
export type ShownComparison = BridgeResponse & { entryId: string };
export type Capability = { comparisonId: string; snapshotId: string; repositoryGeneration: number };

export type RequestState = {
  repository: Registration | null;
  mode: Mode;
  workspace: WorkspaceSnapshot | null;
  entries: readonly ChangeEntry[];
  /** The newest `readWorkspace`, `readEntries`, or `restoreWorkspace` response without a snapshot. */
  readFailure: BridgeResponse | null;
  history: HistoryPage | null;
  historyFailure: BridgeResponse | null;
  selection: Selection | null;
  comparison: ShownComparison | null;
  selectedHunk: string | null;
  capability: Capability | null;
  /** True after a `service-session` event until a `refresh: true` read succeeds, and while the recovery state is not `ready`. */
  blocked: boolean;
  /** The Refreshing marker. Only a user Refresh sets it. */
  refreshing: boolean;
  /** Operation completion notices. A discarded display result never removes one. */
  outcomes: readonly BridgeResponse[];
  /** Each repository open, History refresh, and switch to History adds 1. */
  historyEpoch: number;
  /** Each switch to Changes adds 1. */
  changesEpoch: number;
};

const POLL_MS = 1000;
// Contract §5 "Concurrent reads": 2 per workspace.
const WORKSPACE_READ_SLOTS = 2;
// Contract §8 and §9: the codes that end a hunk or file approval without a Git change by this request.
const APPROVAL_ENDED = new Set(["APPROVAL_EXPIRED", "UNKNOWN_TARGET", "STALE_SELECTION", "REPOSITORY_CHANGED"]);
const APPROVAL_OPERATIONS = new Set(["applyHunk", "applyFile"]);

const INITIAL: RequestState = {
  repository: null,
  mode: "history",
  workspace: null,
  entries: [],
  readFailure: null,
  history: null,
  historyFailure: null,
  selection: null,
  comparison: null,
  selectedHunk: null,
  capability: null,
  blocked: false,
  refreshing: false,
  outcomes: [],
  historyEpoch: 0,
  changesEpoch: 0,
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
// Contract §3: a `WorkspaceSnapshot` has `snapshotId`, and a `WorkspaceRefusal` has none.
const isSnapshot = (value: unknown): value is WorkspaceSnapshot => isObject(value) && typeof value.snapshotId === "string";
// Contract §3: a `HistoryPage` has `rows`, and a `HistoryRefusal` has none.
const isHistoryPage = (value: unknown): value is HistoryPage => isObject(value) && Array.isArray(value.rows);
const isEntriesPage = (value: unknown): value is ReadEntriesResult => isObject(value) && Array.isArray(value.entries);
export const isRegistration = (value: unknown): value is Registration => isObject(value) && typeof value.repositoryId === "string" && typeof value.generation === "number";
const comparisonFields = (value: unknown): ComparisonFields | null =>
  isObject(value) && typeof value.comparisonId === "string" && typeof value.snapshotId === "string" && Array.isArray(value.hunks) ? (value as ComparisonFields) : null;
const sameHead = (a: Head, b: Head) => a.state === b.state && (a as { target?: string }).target === (b as { target?: string }).target && (a as { oid?: string }).oid === (b as { oid?: string }).oid;

// Contract §11 "Route": a WSL identity is one normalized UNC path, `\\wsl.localhost\<listed distro>\…` (`wslIdentityPath`).
// "Paths and file access": a Windows repository under a WSL prefix gets `mixed-location`, so a Windows identity never starts with it.
const WSL_IDENTITY_PREFIX = "\\\\wsl.localhost\\";

/** The distro of a WSL workspace, else null. */
export function wslDistro(workspace: WorkspaceSnapshot | null): string | null {
  const root = workspace?.identity.worktreeRoot;
  if (root === undefined || !root.startsWith(WSL_IDENTITY_PREFIX)) return null;
  return root.slice(WSL_IDENTITY_PREFIX.length).split("\\")[0] || null;
}

const browserClock: Clock = {
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (id) => globalThis.clearInterval(id as number),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as number),
};
const browserFocus: FocusSource = {
  hasFocus: () => document.hasFocus(),
  subscribe(listener) {
    const focus = () => listener(true);
    const blur = () => listener(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  },
};

/** One request store for the open workspace. Responses bind to `repositoryGeneration` and `selectionId`. */
export function createRequests({ bridge, clock = browserClock, focus = browserFocus }: { bridge: RequestBridge; clock?: Clock; focus?: FocusSource }) {
  let state = INITIAL;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<RequestState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  // A new open, service session, or dispose drops every response of the earlier epoch.
  let epoch = 0;
  let repository: Registration | null = null;
  let generation = 0;
  let observedHead: Head | null = null;
  let sessionBlocked = false;
  let pendingReads = 0;
  let userReads = 0;
  let fullDue = false;
  let paging: { snapshot: WorkspaceSnapshot; entries: ChangeEntry[] } | null = null;
  let latestSelectionId: string | null = null;
  // The request facts of the shown comparison.
  let shown: { selectionId: string; generation: number; snapshotId: string } | null = null;
  let reconciling: object | null = null;
  let latestHistory: object | null = null;
  let historyInFlight = 0;
  let comparisonsInFlight = 0;
  // Contract §11 "Change polling": the WSL poll timer, a poll that fell due during another read, and the running poll.
  let pollTimer: unknown = null;
  let pollDue = false;
  let poll: { operationId: string | null; cancel: boolean } | null = null;
  let focused = false;
  let interval: unknown = null;
  let unsubscribe: (() => void) | null = null;

  const wsl = () => wslDistro(state.workspace) !== null;
  const reads = () => pendingReads + historyInFlight + comparisonsInFlight;
  const blocked = (workspace = state.workspace) => sessionBlocked || (workspace !== null && workspace.recoveryState !== "ready");

  function capability(next: RequestState): Capability | null {
    const result = comparisonFields(next.comparison?.result);
    const workspace = next.workspace;
    // A pending comparison read or a pending reconciling read never keeps a capability (contract §8).
    if (!result || !workspace || !shown || shown.selectionId !== latestSelectionId || next.comparison?.state !== "succeeded" || reconciling !== null || blocked(workspace)) return null;
    if (shown.snapshotId !== workspace.snapshotId || shown.generation !== workspace.generation || result.snapshotId !== workspace.snapshotId) return null;
    return { comparisonId: result.comparisonId, snapshotId: workspace.snapshotId, repositoryGeneration: workspace.generation };
  }
  const update = (patch: Partial<RequestState>) => {
    const next = { ...state, ...patch };
    set({ ...patch, blocked: blocked(next.workspace), capability: capability(next) });
  };

  function readWorkspace(refresh: boolean, check: Check, isPoll = false) {
    if (!repository) return;
    if (!isPoll) userRead();
    const e = epoch;
    const token = {};
    const own: typeof poll = isPoll ? (poll = { operationId: null, cancel: false }) : null;
    pendingReads++;
    if (refresh) userReads++;
    if (refresh) set({ refreshing: true });
    if (check === "full") fullDue = false;
    // The accepted event carries the `operationId` that `cancel` names (contract §2).
    const onProgress: OnProgress | undefined = own
      ? (event) => {
          if (e !== epoch || own.operationId !== null) return;
          own.operationId = event.operationId;
          if (own.cancel) void bridge.cancel({ operationId: own.operationId });
        }
      : undefined;
    void bridge.readWorkspace({ repositoryId: repository.repositoryId }, { refresh, check }, onProgress).then((response) => {
      if (e !== epoch) return;
      pendingReads--;
      if (refresh) userReads--;
      if (refresh && userReads === 0) set({ refreshing: false });
      if (own && poll === own) poll = null;
      // Data-model "WSL start and poll transitions": a poll that the renderer canceled ends without a shown result.
      if (!(own?.cancel && response.state === "canceled")) onWorkspace(response, refresh, token);
      if (own) armPoll();
      readEnded();
    });
    return token;
  }

  // Contract §11 "Change polling": a user read that finds both workspace read slots busy cancels a running poll.
  function userRead() {
    if (!poll || poll.cancel || reads() < WORKSPACE_READ_SLOTS) return;
    poll.cancel = true;
    if (poll.operationId !== null) void bridge.cancel({ operationId: poll.operationId });
  }

  // A poll starts 1 second after the previous poll ends. Another read end arms the timer only when none runs.
  function armPoll() {
    if (pollTimer !== null || !repository || !focused || !wsl()) return;
    pollTimer = clock.setTimeout(() => {
      pollTimer = null;
      if (!repository || !focused || !wsl()) return;
      if (reads() > 0 || paging !== null) pollDue = true;
      else readWorkspace(false, "full", true);
    }, POLL_MS);
  }

  // A poll never starts beside another read of the workspace. A poll that fell due starts when the last read ends.
  function readEnded() {
    if (reads() > 0 || paging !== null || !repository) return;
    if (pollDue && focused && wsl()) {
      pollDue = false;
      readWorkspace(false, "full", true);
    } else if (poll === null) armPoll();
  }

  function onWorkspace(response: BridgeResponse, refresh: boolean, token: object) {
    const result = response.result;
    if (reconciling === token) reconciling = null;
    if (!isSnapshot(result)) {
      update({ readFailure: response });
      return;
    }
    if (result.generation < generation) {
      update({});
      return;
    }
    generation = result.generation;
    // Contract §8 "Service restart": only a succeeded `refresh: true` read releases the block.
    if (refresh && response.state === "succeeded" && result.recoveryState === "ready") sessionBlocked = false;
    const headChanged = observedHead !== null && !sameHead(observedHead, result.head);
    observedHead = result.head;
    // Contract §3 "HistoryPage result": a page stays only while its captured HEAD equals the newest observed HEAD.
    const history = state.history && !sameHead(state.history.head, result.head) ? null : state.history;
    if (headChanged && historyInFlight === 0) requestHistory(false);
    const known = result.snapshotId === state.workspace?.snapshotId || result.snapshotId === paging?.snapshot.snapshotId;
    if (known) {
      update({ history, readFailure: null });
      return;
    }
    paging = null;
    if (result.cursor === null) {
      commit(result, result.entries, { history });
      return;
    }
    // A change invalidates the approval before the replacement view arrives (contract §8).
    paging = { snapshot: result, entries: [...result.entries] };
    shown = null;
    update({ history, readFailure: null });
    fetchPage(paging, result.cursor);
  }

  function fetchPage(page: NonNullable<typeof paging>, cursor: string) {
    if (!repository) return;
    const e = epoch;
    const target = { repositoryId: repository.repositoryId, repositoryGeneration: page.snapshot.generation };
    void bridge.readEntries(target, { snapshotId: page.snapshot.snapshotId, cursor }).then((response) => {
      if (e !== epoch || paging !== page) return;
      if (response.state === "succeeded" && isEntriesPage(response.result)) {
        page.entries.push(...response.result.entries);
        if (response.result.cursor !== null) return fetchPage(page, response.result.cursor);
        paging = null;
        commit(page.snapshot, page.entries, {});
      } else {
        paging = null;
        if (response.code === "UNKNOWN_TARGET" || response.code === "REPOSITORY_CHANGED") readWorkspace(false, "full");
        else update({ readFailure: response });
      }
      readEnded();
    });
  }

  function commit(workspace: WorkspaceSnapshot, entries: readonly ChangeEntry[], patch: Partial<RequestState>) {
    const previous = state.selection;
    const found = previous ? entries.find((e) => e.category === previous.category && e.pathBytes === previous.pathBytes) : undefined;
    const selection = previous && found ? { ...previous, entryId: found.entryId } : null;
    // plan.md "Required visible states", Loading: the earlier comparison of the same category and `pathBytes` stays shown until the new one arrives.
    const comparison = selection && state.comparison?.entryId === previous!.entryId ? { ...state.comparison, entryId: selection.entryId } : null;
    shown = null;
    if (!selection) latestSelectionId = null;
    update({ ...patch, workspace, entries, selection, comparison, readFailure: null, ...(selection ? {} : { selectedHunk: null }) });
    if (selection) requestComparison(selection.entryId);
  }

  function requestComparison(entryId: string) {
    const workspace = state.workspace;
    if (!repository || !workspace) return;
    const e = epoch;
    const selectionId = crypto.randomUUID();
    latestSelectionId = selectionId;
    const request = { selectionId, generation: workspace.generation, snapshotId: workspace.snapshotId };
    update({});
    userRead();
    comparisonsInFlight++;
    const target = { repositoryId: repository.repositoryId, repositoryGeneration: request.generation, selectionId };
    void bridge.readComparison(target, { snapshotId: request.snapshotId, entryId }).then((response) => {
      if (e !== epoch) return;
      comparisonsInFlight--;
      onComparison(response, request, entryId);
      readEnded();
    });
  }

  function onComparison(response: BridgeResponse, request: NonNullable<typeof shown>, entryId: string) {
    // Contract §5: a newer `readComparison` supersedes this one. A superseded response, `canceled` included, shows nothing.
    if (request.selectionId !== latestSelectionId) return;
    shown = request;
    const previous = comparisonFields(state.comparison?.result);
    const next = comparisonFields(response.result);
    // Contract §8: the hunk selection returns only with a hunk of the same canonical digest.
    const digest = previous?.hunks.find((h) => h.hunkId === state.selectedHunk)?.digest;
    const selectedHunk = digest === undefined ? null : (next?.hunks.find((h) => h.digest === digest)?.hunkId ?? null);
    update({ comparison: { ...response, entryId }, selectedHunk });
  }

  function requestHistory(retried: boolean) {
    if (!repository) return;
    userRead();
    const e = epoch;
    const token = {};
    latestHistory = token;
    historyInFlight++;
    void bridge.readHistory({ repositoryId: repository.repositoryId, repositoryGeneration: generation }).then((response) => {
      if (e !== epoch) return;
      historyInFlight--;
      onHistory(response, token, retried);
      readEnded();
    });
  }

  function onHistory(response: BridgeResponse, token: object, retried: boolean) {
    const latest = latestHistory === token;
    if (response.code === "REPOSITORY_CHANGED" && !retried) {
      if (latest) requestHistory(true);
      return;
    }
    const page = response.result;
    if (!isHistoryPage(page)) {
      if (latest) set({ historyFailure: response });
      return;
    }
    if (observedHead === null || sameHead(page.head, observedHead)) set({ history: page, historyFailure: null });
    else if (latest && historyInFlight === 0) requestHistory(false);
  }

  // The Windows interval poll. A WSL workspace polls through `armPoll` instead (contract §11 "Change polling").
  function tick() {
    if (!repository || !focused || pendingReads > 0 || paging !== null || wsl()) return;
    readWorkspace(false, fullDue ? "full" : "changes");
  }

  function onFocus(next: boolean) {
    const returned = next && !focused;
    focused = next;
    if (!next) pollDue = false;
    if (!returned || !repository) return;
    fullDue = true;
    if (wsl()) readWorkspace(false, "full");
    else tick();
  }

  function watch() {
    if (interval === null) interval = clock.setInterval(tick, POLL_MS);
    if (unsubscribe === null) unsubscribe = focus.subscribe(onFocus);
    focused = focus.hasFocus();
  }

  function start(registration: Registration) {
    repository = registration;
    generation = registration.generation;
    observedHead = null;
    watch();
    readWorkspace(false, "full");
    requestHistory(false);
  }

  function reset() {
    epoch++;
    repository = null;
    pendingReads = 0;
    userReads = 0;
    paging = null;
    shown = null;
    reconciling = null;
    latestHistory = null;
    historyInFlight = 0;
    comparisonsInFlight = 0;
    if (pollTimer !== null) clock.clearTimeout(pollTimer);
    pollTimer = null;
    pollDue = false;
    poll = null;
  }

  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** A repository open. It always shows History (FR-034), and `readHistory` goes out beside the first full read. */
    open(registration: Registration) {
      reset();
      latestSelectionId = null;
      sessionBlocked = false;
      state = { ...INITIAL, outcomes: state.outcomes, historyEpoch: state.historyEpoch + 1, changesEpoch: state.changesEpoch };
      set({ repository: registration });
      start(registration);
    },

    /** The user Refresh action: F5, the header Refresh button, or the State unknown Refresh. */
    refresh() {
      if (!repository) return;
      readWorkspace(true, "full");
      if (state.mode === "history") {
        requestHistory(false);
        set({ historyEpoch: state.historyEpoch + 1 });
      }
    },

    setMode(mode: Mode) {
      if (mode === state.mode) return;
      set(mode === "history" ? { mode, historyEpoch: state.historyEpoch + 1 } : { mode, changesEpoch: state.changesEpoch + 1 });
    },

    selectEntry(entryId: string) {
      const entry = state.entries.find((e) => e.entryId === entryId);
      if (!entry) return;
      const same = state.selection?.entryId === entryId;
      update({ selection: { entryId, category: entry.category, pathBytes: entry.pathBytes }, selectedHunk: same ? state.selectedHunk : null });
      requestComparison(entryId);
    },

    selectHunk(hunkId: string | null) {
      const hunks = comparisonFields(state.comparison?.result)?.hunks ?? [];
      if (hunkId === null || hunks.some((h) => h.hunkId === hunkId)) set({ selectedHunk: hunkId });
    },

    /** Records the completion notice, then reads the workspace in full to reconcile (contract §3). */
    mutationEnded(operation: string, response: BridgeResponse) {
      set({ outcomes: [...state.outcomes, response] });
      if (APPROVAL_OPERATIONS.has(operation) && response.code !== undefined && APPROVAL_ENDED.has(response.code) && state.selection) requestComparison(state.selection.entryId);
      reconciling = readWorkspace(false, "full") ?? null;
      update({});
    },

    /** The read after a trust approval is a full read (contract §3). */
    trustApproved() {
      readWorkspace(false, "full");
    },

    /** Contract §8 "Service restart": run `restoreWorkspace` again and block mutations until a `refresh: true` read succeeds. */
    serviceSession() {
      reset();
      sessionBlocked = true;
      const e = epoch;
      update({ repository: null, workspace: null, entries: [], history: null, comparison: null, selectedHunk: null, refreshing: false });
      void bridge.restoreWorkspace().then((response) => {
        if (e !== epoch) return;
        if (response.state !== "succeeded" || !isRegistration(response.result)) return update({ readFailure: response });
        set({ repository: response.result });
        start(response.result);
      });
    },

    dispose() {
      reset();
      if (interval !== null) clock.clearInterval(interval);
      interval = null;
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
    },
  };
}

export type Requests = ReturnType<typeof createRequests>;
