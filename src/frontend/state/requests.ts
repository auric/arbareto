// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ChangeEntry, ReadEntriesResult, RefsResult, WorkspaceSnapshot } from "../../contracts/envelope";
import type { BridgeResponse, OnProgress } from "../bridge";
import { nextRequestSeq, sameHead } from "./history-view";

// Contract §2, §5 "Pending reads", §8, and §11 "Change polling". plan.md "Freshness and reconciliation". Feature 002 contract Δ3 and Δ8.

type Head = WorkspaceSnapshot["head"];
type Check = "full" | "changes";
type Target = { repositoryId: string; repositoryGeneration: number };

export type Registration = { repositoryId: string; generation: number; worktreeKey: string };

/** The bridge operations that this module calls. `createBridge` in `bridge.ts` provides them. */
export type RequestBridge = {
  restoreWorkspace(onProgress?: OnProgress): Promise<BridgeResponse>;
  readWorkspace(target: { repositoryId: string }, payload: { refresh: boolean; check: Check }, onProgress?: OnProgress): Promise<BridgeResponse>;
  readEntries(target: Target, payload: { snapshotId: string; cursor: string }): Promise<BridgeResponse>;
  readRefs(target: Target): Promise<BridgeResponse>;
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
/** The feature 002 history view. Its `openHistory` request goes through `track`, so it counts as a read of the workspace. */
export type HistoryParticipant = { open(): unknown; refresh(): unknown };

// The T331 `ReadComparisonResult` type is on another branch. These are the only fields that this module reads.
type ComparisonHunk = { hunkId: string; digest: string };
type ComparisonFields = { comparisonId: string; snapshotId: string; hunks: readonly ComparisonHunk[] };

export type Selection = { entryId: string; category: ChangeEntry["category"]; pathBytes: string };
export type ShownComparison = BridgeResponse & { entryId: string };
export type Capability = { comparisonId: string; snapshotId: string; repositoryGeneration: number };

export type RequestState = {
  repository: Registration | null;
  workspace: WorkspaceSnapshot | null;
  entries: readonly ChangeEntry[];
  /** The newest `readWorkspace`, `readEntries`, or `restoreWorkspace` response without a snapshot. */
  readFailure: BridgeResponse | null;
  /** The newest `readRefs` list. */
  refs: RefsResult | null;
  /** The newest `readRefs` refusal. A later list clears it. */
  refsFailure: BridgeResponse | null;
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
  /** Each repository open and user Refresh adds 1. The History-ready mark counts it. */
  historyEpoch: number;
  /** The `nextRequestSeq()` value when the request of `refs` was sent. */
  refsSeq: number;
  /** The HEAD of the newest `readWorkspace` result, and the `nextRequestSeq()` value when its request was sent. */
  headRead: { head: Head; seq: number } | null;
};

const POLL_MS = 1000;
// Contract §5 "Concurrent reads": 2 per workspace.
const WORKSPACE_READ_SLOTS = 2;
// Contract §8 and §9: the codes that end a hunk or file approval without a Git change by this request.
const APPROVAL_ENDED = new Set(["APPROVAL_EXPIRED", "UNKNOWN_TARGET", "STALE_SELECTION", "REPOSITORY_CHANGED"]);
const APPROVAL_OPERATIONS = new Set(["applyHunk", "applyFile"]);

const INITIAL: RequestState = {
  repository: null,
  workspace: null,
  entries: [],
  readFailure: null,
  refs: null,
  refsFailure: null,
  selection: null,
  comparison: null,
  selectedHunk: null,
  capability: null,
  blocked: false,
  refreshing: false,
  outcomes: [],
  historyEpoch: 0,
  refsSeq: 0,
  headRead: null,
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
// Contract §3: a `WorkspaceSnapshot` has `snapshotId`, and a `WorkspaceRefusal` has none.
const isSnapshot = (value: unknown): value is WorkspaceSnapshot => isObject(value) && typeof value.snapshotId === "string";
// Contract §3: a `RefList` has `refs`, and a `RefsRefusal` has none.
const isRefList = (value: unknown): value is RefsResult => isObject(value) && Array.isArray(value.refs);
const isEntriesPage = (value: unknown): value is ReadEntriesResult => isObject(value) && Array.isArray(value.entries);
export const isRegistration = (value: unknown): value is Registration => isObject(value) && typeof value.repositoryId === "string" && typeof value.generation === "number";
const comparisonFields = (value: unknown): ComparisonFields | null =>
  isObject(value) && typeof value.comparisonId === "string" && typeof value.snapshotId === "string" && Array.isArray(value.hunks) ? (value as ComparisonFields) : null;

/** The distro of a WSL workspace, else null (data-model §2 `location`). */
export function wslDistro(workspace: WorkspaceSnapshot | null): string | null {
  return workspace?.location.kind === "wsl" ? workspace.location.distro : null;
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
export function createRequests({ bridge, clock = browserClock, focus = browserFocus, history }: { bridge: RequestBridge; clock?: Clock; focus?: FocusSource; history?: HistoryParticipant }) {
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
  let historyInFlight = 0;
  let latestRefs: object | null = null;
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

  /** `onEnd` runs once when this read ends with any result, also after a newer open drops it. */
  function readWorkspace(refresh: boolean, check: Check, isPoll = false, onEnd?: () => void) {
    if (!repository) return void onEnd?.();
    if (!isPoll) userRead();
    const e = epoch;
    const token = {};
    const seq = nextRequestSeq();
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
      if (e !== epoch) return void onEnd?.();
      pendingReads--;
      if (refresh) userReads--;
      if (refresh && userReads === 0) set({ refreshing: false });
      if (own && poll === own) poll = null;
      // Data-model "WSL start and poll transitions": a poll that the renderer canceled ends without a shown result.
      if (!(own?.cancel && response.state === "canceled")) onWorkspace(response, refresh, token, own !== null, seq);
      if (own) armPoll();
      readEnded();
      onEnd?.();
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

  function onWorkspace(response: BridgeResponse, refresh: boolean, token: object, isPoll: boolean, seq: number) {
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
    if (state.headRead === null || seq > state.headRead.seq) set({ headRead: { head: result.head, seq } });
    // plan.md Refresh row: `readRefs` follows each full status result. A WSL poll result sends none.
    // A changed HEAD sends one, so the feature 002 "References changed" notice can show (contract Δ8).
    if (headChanged || (result.readKind === "full" && !(isPoll && result.location.kind === "wsl"))) requestRefs();
    const known = result.snapshotId === state.workspace?.snapshotId || result.snapshotId === paging?.snapshot.snapshotId;
    if (known) {
      update({ readFailure: null });
      return;
    }
    paging = null;
    if (result.cursor === null) {
      commit(result, result.entries, {});
      return;
    }
    // A change invalidates the approval before the replacement view arrives (contract §8).
    paging = { snapshot: result, entries: [...result.entries] };
    shown = null;
    update({ readFailure: null });
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

  /** An `openHistory` request of the history view. It takes a read slot (feature 002 contract Δ3), so the poll rules count it. */
  function track<T>(request: Promise<T>): Promise<T> {
    if (!repository) return request;
    userRead();
    const e = epoch;
    historyInFlight++;
    return request.finally(() => {
      if (e !== epoch) return;
      historyInFlight--;
      readEnded();
    });
  }

  function requestRefs() {
    if (!repository) return;
    const e = epoch;
    const token = {};
    latestRefs = token;
    const seq = nextRequestSeq();
    void bridge.readRefs({ repositoryId: repository.repositoryId, repositoryGeneration: generation }).then((response) => {
      // Contract §5 "Pending reads": a newer `readRefs` supersedes this one.
      if (e !== epoch || latestRefs !== token) return;
      onRefs(response, seq);
    });
  }

  function onRefs(response: BridgeResponse, seq: number) {
    const list = response.result;
    if (!isRefList(list)) {
      set({ refsFailure: response });
      return;
    }
    set({ refs: list, refsSeq: seq, refsFailure: null });
  }

  // The Windows interval poll. A WSL workspace polls through `armPoll` instead (contract §11 "Change polling").
  // Without a snapshot, the location is unknown, and contract §11 forbids `changes` for WSL.
  function tick() {
    if (!repository || !focused || pendingReads > 0 || paging !== null || wsl()) return;
    readWorkspace(false, fullDue || state.workspace === null ? "full" : "changes");
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

  /** Feature 002 contract Δ8: after a service restart no view resumes, so `openView` is false then. */
  function start(registration: Registration, openView: boolean) {
    repository = registration;
    generation = registration.generation;
    observedHead = null;
    watch();
    readWorkspace(false, "full");
    if (openView) history?.open();
  }

  function reset() {
    epoch++;
    repository = null;
    pendingReads = 0;
    userReads = 0;
    paging = null;
    shown = null;
    reconciling = null;
    latestRefs = null;
    historyInFlight = 0;
    comparisonsInFlight = 0;
    if (pollTimer !== null) clock.clearTimeout(pollTimer);
    pollTimer = null;
    pollDue = false;
    poll = null;
  }

  return {
    state: () => state,
    /** The repository and the newest generation of the open workspace (contract §2), or null. */
    target: () => (repository === null ? null : { repositoryId: repository.repositoryId, repositoryGeneration: generation }),
    track,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** A repository open. It shows no selected row (FR-034), and the history view opens beside the first full read. */
    open(registration: Registration) {
      reset();
      latestSelectionId = null;
      sessionBlocked = false;
      state = { ...INITIAL, outcomes: state.outcomes, historyEpoch: state.historyEpoch + 1 };
      set({ repository: registration });
      start(registration, true);
    },

    /** The user Refresh action: F5, the header Refresh button, or the State unknown Refresh. */
    refresh() {
      if (!repository) return;
      // plan.md Refresh row: F5 requests `readWorkspace` with `refresh: true` and a new history view together.
      readWorkspace(true, "full");
      history?.refresh();
      set({ historyEpoch: state.historyEpoch + 1 });
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

    /** Records the completion notice, then reads the workspace in full to reconcile (contract §3). Resolves when the reconcile read ends. */
    mutationEnded(operation: string, response: BridgeResponse): Promise<void> {
      set({ outcomes: [...state.outcomes, response] });
      if (APPROVAL_OPERATIONS.has(operation) && response.code !== undefined && APPROVAL_ENDED.has(response.code) && state.selection) requestComparison(state.selection.entryId);
      // Contract §9: an expired submodule token starts no Git process. The review dialog answers it with a new `reviewSubmodules`, which a read would race.
      if (operation === "updateSubmodules" && response.state === "rejected" && response.code === "APPROVAL_EXPIRED") return Promise.resolve(update({}));
      return new Promise((resolve) => {
        reconciling = readWorkspace(false, "full", false, resolve) ?? null;
        update({});
      });
    },

    /** The read after a trust approval is a full read (contract §3). */
    trustApproved(): Promise<void> {
      return new Promise((resolve) => void readWorkspace(false, "full", false, resolve));
    },

    /** Contract §8 "Service restart": run `restoreWorkspace` again and block mutations until a `refresh: true` read succeeds. */
    serviceSession() {
      const shownKey = repository?.worktreeKey ?? null;
      reset();
      sessionBlocked = true;
      const e = epoch;
      update({ repository: null, workspace: null, entries: [], comparison: null, selectedHunk: null, refreshing: false });
      void bridge.restoreWorkspace().then((response) => {
        if (e !== epoch) return;
        if (response.state !== "succeeded" || !isRegistration(response.result)) return update({ readFailure: response });
        set({ repository: response.result });
        // The stale view of the same worktree stays until Refresh. Another worktree gets its own view.
        start(response.result, response.result.worktreeKey !== shownKey);
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
