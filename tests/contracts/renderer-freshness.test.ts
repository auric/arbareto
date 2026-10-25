// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { BridgeResponse } from "../../src/frontend/bridge";
import type { ChangeEntry, WorkspaceSnapshot } from "../../src/contracts/envelope";
import { printOrigin } from "../origin";
import { createHistoryView } from "../../src/frontend/state/history-view";
import { createRequests } from "../../src/frontend/state/requests";
import { contractChecked } from "./bridge-contract";

printOrigin("../../src/frontend/state/requests.ts", import.meta.dir);

// Contract §2, §5 "Pending reads", and §8. plan.md "Freshness and reconciliation". Feature 002 contract Δ3 and Δ8.

type Call = { operation: string; target: Record<string, unknown>; payload: Record<string, unknown>; resolve(response: BridgeResponse): void };

// Each call stays pending until the test resolves it.
function bridgeDouble() {
  const calls: Call[] = [];
  const record = (operation: string, target: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) =>
    new Promise<BridgeResponse>((resolve) => calls.push({ operation, target, payload, resolve }));
  const bridge = {
    restoreWorkspace: () => record("restoreWorkspace"),
    readWorkspace: (target: Record<string, unknown>, payload: Record<string, unknown>) => record("readWorkspace", target, payload),
    readEntries: (target: Record<string, unknown>, payload: Record<string, unknown>) => record("readEntries", target, payload),
    readComparison: (target: Record<string, unknown>, payload: Record<string, unknown>) => record("readComparison", target, payload),
    readRefs: (target: Record<string, unknown>) => record("readRefs", target),
    cancel: (payload: Record<string, unknown>) => record("cancel", {}, payload),
  };
  // The history view participant. Its `openHistory` request goes through `track`, as the workbench sends it (feature 002 contract Δ3).
  let store: { track<T>(request: Promise<T>): Promise<T>; target(): { repositoryId: string; repositoryGeneration: number } | null } | null = null;
  // `openedSeq` stands for `HistoryState.openedSeq` of the view.
  const opened = { seq: 0 };
  const history = {
    open: () => store!.track(record("openHistory", store!.target() ?? {}, { scope: "all" })),
    refresh: () => store!.track(record("openHistory", store!.target() ?? {}, { scope: "all" })),
    openedSeq: () => opened.seq,
  };
  const bind = <T extends NonNullable<typeof store>>(requests: T) => ((store = requests), requests);
  const of = (operation: string) => calls.filter((call) => call.operation === operation);
  const last = (operation: string) => {
    const found = of(operation).at(-1);
    if (!found) throw new Error(`no ${operation} call`);
    return found;
  };
  return { bridge: contractChecked(bridge), calls, of, last, history, bind, opened };
}

function clockDouble() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; every: number | null; run: () => void }>();
  const clock = {
    now: () => now,
    setTimeout: (run: () => void, ms = 0) => (timers.set(next, { at: now + ms, every: null, run }), next++),
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    setInterval: (run: () => void, ms = 0) => (timers.set(next, { at: now + ms, every: ms, run }), next++),
    clearInterval: (id: unknown) => void timers.delete(id as number),
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((x, y) => x[1].at - y[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every === null) timers.delete(id);
      else timer.at += Math.max(timer.every, 1);
      timer.run();
      await flush();
    }
    now = end;
    await flush();
  }
  return { clock, advance };
}

function focusDouble(initial: boolean) {
  let focused = initial;
  const listeners = new Set<(focused: boolean) => void>();
  return {
    focus: {
      hasFocus: () => focused,
      subscribe: (listener: (focused: boolean) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    },
    set(value: boolean) {
      focused = value;
      for (const listener of listeners) listener(value);
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const REPOSITORY = crypto.randomUUID();
const WORKTREE_KEY = "e".repeat(64);
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const entry = (category: ChangeEntry["category"], path: string): ChangeEntry => ({
  entryId: crypto.randomUUID(),
  category,
  path,
  pathBytes: Buffer.from(path).toString("base64"),
});

function snapshot(generation: number, entries: ChangeEntry[], fields: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    generation,
    snapshotId: crypto.randomUUID(),
    readKind: "full",
    identity: { worktreeRoot: "C:\\repo", gitDirectory: "C:\\repo\\.git", commonDirectory: "C:\\repo\\.git", indexPath: "C:\\repo\\.git\\index", objectFormat: "sha1", refFormat: "files" },
    head: { state: "branch", target: "refs/heads/main", oid: HEAD_A },
    operationState: "normal",
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
    location: { kind: "native" },
    submoduleNotice: { count: 0, paths: [], filter: "applied" },
    entryCount: entries.length,
    entries,
    cursor: null,
    ...fields,
  };
}

// The T331 comparison value: the shipped `src/git-service/comparison.ts` value plus `digest` on each hunk (data-model §5 Hunk).
function comparison(snapshotId: string, entryId: string, digests: string[]) {
  return {
    comparisonId: crypto.randomUUID(),
    snapshotId,
    entryId,
    scope: "index-to-worktree",
    completeness: { state: "complete" },
    patch: Buffer.from("diff --git a/x b/x\n").toString("base64"),
    hunks: digests.map((digest, i) => ({ hunkId: crypto.randomUUID(), ordinal: i + 1, oldStart: 10 * i + 1, oldCount: 1, newStart: 10 * i + 1, newCount: 2, digest })),
    support: "supported",
    fileAction: "stage",
    remedy: null,
  };
}

// Contract §3 `readWorkspace`: a `retained` reply of `shown` holds its summary and `entryCount`, and no entries page.
const retainedOf = (shown: WorkspaceSnapshot, fields: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({ ...shown, readKind: "retained", entries: [], cursor: null, ...fields });

const workspaceResponse = (call: Call, result: WorkspaceSnapshot) =>
  call.resolve({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: result.generation, result });
const echo = (call: Call, fields: Partial<BridgeResponse>) =>
  call.resolve({
    requestId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    state: "succeeded",
    repositoryGeneration: call.target.repositoryGeneration as number,
    ...(call.target.selectionId === undefined ? {} : { selectionId: call.target.selectionId as string }),
    ...fields,
  });

// An open workspace whose first full read and first history read are answered.
async function opened(entries: ChangeEntry[] = [entry("unstaged", "a.txt"), entry("unstaged", "b.txt")], focused = true) {
  const double = bridgeDouble();
  const time = clockDouble();
  const focus = focusDouble(focused);
  const requests = double.bind(createRequests({ bridge: double.bridge, history: double.history, clock: time.clock, focus: focus.focus }));
  requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
  await flush();
  const first = snapshot(1, entries);
  workspaceResponse(double.last("readWorkspace"), first);
  echo(double.last("openHistory"), { result: {} });
  await flush();
  return { ...double, ...time, focus, requests, first };
}

async function shown(entries?: ChangeEntry[]) {
  const o = await opened(entries);
  const target = o.first.entries[0]!;
  o.requests.selectEntry(target.entryId);
  await flush();
  const value = comparison(o.first.snapshotId, target.entryId, ["1".repeat(64), "2".repeat(64)]);
  echo(o.last("readComparison"), { result: value });
  await flush();
  return { ...o, target, value };
}

describe("obsolete responses", () => {
  test("the first read is a full read without refresh, and openHistory goes out beside it", async () => {
    const double = bridgeDouble();
    const time = clockDouble();
    const requests = double.bind(createRequests({ bridge: double.bridge, history: double.history, clock: time.clock, focus: focusDouble(true).focus }));
    requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
    await flush();
    expect(double.of("readWorkspace").map((c) => c.payload)).toEqual([{ refresh: false, check: "full" }]);
    expect(double.of("openHistory").map((c) => [c.target, c.payload])).toEqual([[{ repositoryId: REPOSITORY, repositoryGeneration: 1 }, { scope: "all" }]]);
    requests.dispose();
  });

  test("a response with an older selectionId never replaces the current comparison", async () => {
    const o = await opened();
    const [a, b] = o.first.entries as [ChangeEntry, ChangeEntry];
    o.requests.selectEntry(a.entryId);
    await flush();
    const older = o.last("readComparison");
    o.requests.selectEntry(b.entryId);
    await flush();
    const newer = o.last("readComparison");
    expect(newer.target.selectionId).not.toBe(older.target.selectionId);
    const value = comparison(o.first.snapshotId, b.entryId, ["1".repeat(64)]);
    echo(newer, { result: value });
    await flush();
    echo(older, { result: comparison(o.first.snapshotId, a.entryId, ["2".repeat(64)]) });
    await flush();
    expect(o.requests.state().comparison?.result).toEqual(value);
    o.requests.dispose();
  });

  test("a workspace response with an older repositoryGeneration never replaces the current view", async () => {
    const o = await opened();
    await o.advance(1000);
    const poll = o.last("readWorkspace");
    expect(poll.payload).toEqual({ refresh: false, check: "changes" });
    o.requests.refresh();
    await flush();
    const user = o.last("readWorkspace");
    expect(user.payload).toEqual({ refresh: true, check: "full" });
    const current = snapshot(3, [entry("staged", "c.txt")]);
    workspaceResponse(user, current);
    await flush();
    workspaceResponse(poll, snapshot(2, [entry("unstaged", "d.txt")]));
    await flush();
    expect(o.requests.state().workspace?.snapshotId).toBe(current.snapshotId);
    expect(o.requests.state().entries).toEqual(current.entries);
    o.requests.dispose();
  });

  test("an operation completion notice still appears when its display result is discarded", async () => {
    const o = await opened();
    await o.advance(1000);
    workspaceResponse(o.last("readWorkspace"), snapshot(2, o.first.entries));
    await flush();
    const outcome: BridgeResponse = { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result: {} };
    o.requests.mutationEnded("applyFile", outcome);
    await flush();
    expect(o.requests.state().outcomes).toContainEqual(outcome);
    expect(o.requests.state().workspace?.generation).toBe(2);
    o.requests.dispose();
  });

  test("B4-1: a rejected updateSubmodules with APPROVAL_EXPIRED records its outcome and starts no read; REPOSITORY_CHANGED starts one full read", async () => {
    const o = await opened();
    const reads = () => o.of("readWorkspace").length;
    const before = reads();
    const expired: BridgeResponse = { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "rejected", code: "APPROVAL_EXPIRED", repositoryGeneration: 1 };
    o.requests.mutationEnded("updateSubmodules", expired);
    await flush();
    expect(o.requests.state().outcomes).toContainEqual(expired);
    expect(reads()).toBe(before);
    const changed: BridgeResponse = { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "rejected", code: "REPOSITORY_CHANGED", repositoryGeneration: 1 };
    o.requests.mutationEnded("updateSubmodules", changed);
    await flush();
    expect(o.requests.state().outcomes).toContainEqual(changed);
    expect(o.of("readWorkspace").slice(before).map((c) => c.payload)).toEqual([{ refresh: false, check: "full" }]);
    o.requests.dispose();
  });
});

describe("approvals", () => {
  test("a shown comparison of the current generation gives a mutation capability", async () => {
    const o = await shown();
    expect(o.requests.state().capability).toEqual({ comparisonId: o.value.comparisonId, snapshotId: o.first.snapshotId, repositoryGeneration: 1 });
    o.requests.dispose();
  });

  test("a change notice invalidates the approval before the replacement view arrives", async () => {
    const o = await shown();
    await o.advance(1000);
    const comparisons = o.of("readComparison").length;
    workspaceResponse(o.last("readWorkspace"), snapshot(2, o.first.entries));
    await flush();
    expect(o.requests.state().capability).toBeNull();
    // Any replacement comparison read is still pending here.
    for (const call of o.of("readComparison").slice(comparisons)) expect(call.target.repositoryGeneration).toBe(2);
    o.requests.dispose();
  });

  test("a pending read never keeps a mutation capability", async () => {
    const o = await shown();
    o.requests.selectEntry(o.first.entries[1]!.entryId);
    await flush();
    expect(o.requests.state().capability).toBeNull();
    o.requests.selectEntry(o.target.entryId);
    await flush();
    expect(o.requests.state().capability).toBeNull();
    o.requests.dispose();
  });

  for (const [name, digests, kept] of [
    ["keeps the hunk selection when the new comparison has a hunk with the same digest", ["1".repeat(64), "2".repeat(64)], 1],
    ["clears the hunk selection when no hunk of the new comparison has that digest", ["1".repeat(64), "9".repeat(64)], null],
  ] as const) {
    test(`an expired hunk approval reads the comparison again once and ${name}`, async () => {
      const o = await shown();
      o.requests.selectHunk(o.value.hunks[1]!.hunkId);
      expect(o.requests.state().selectedHunk).toBe(o.value.hunks[1]!.hunkId);
      const before = o.of("readComparison").length;
      o.requests.mutationEnded("applyHunk", { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "rejected", code: "APPROVAL_EXPIRED", repositoryGeneration: 1 });
      await flush();
      const again = o.of("readComparison").slice(before);
      expect(again).toHaveLength(1);
      expect(again[0]!.payload.entryId).toBe(o.target.entryId);
      const value = comparison(o.first.snapshotId, o.target.entryId, [...digests]);
      echo(again[0]!, { result: value });
      await flush();
      expect(o.requests.state().selectedHunk).toBe(kept === null ? null : value.hunks[kept]!.hunkId);
      o.requests.dispose();
    });
  }
});

describe("service session", () => {
  test("a service-session event sends one restoreWorkspace and blocks mutations until a refresh: true read succeeds", async () => {
    const o = await shown();
    o.requests.serviceSession();
    await flush();
    expect(o.of("restoreWorkspace")).toHaveLength(1);
    expect(o.requests.state().blocked).toBe(true);
    expect(o.requests.state().capability).toBeNull();
    const repositoryId = crypto.randomUUID();
    o.last("restoreWorkspace").resolve({ requestId: crypto.randomUUID(), state: "succeeded", result: { repositoryId, generation: 4, worktreeKey: WORKTREE_KEY } });
    await flush();
    for (const call of o.of("readWorkspace").filter((c) => c.target.repositoryId === repositoryId)) {
      expect(call.payload.refresh).toBe(false);
      workspaceResponse(call, snapshot(4, o.first.entries));
    }
    await flush();
    await o.advance(1000);
    for (const call of o.of("readWorkspace").filter((c) => c.target.repositoryId === repositoryId && c.payload.check === "changes")) workspaceResponse(call, snapshot(4, o.first.entries));
    await flush();
    expect(o.requests.state().blocked).toBe(true);
    o.requests.refresh();
    await flush();
    const refresh = o.last("readWorkspace");
    expect(refresh.target.repositoryId).toBe(repositoryId);
    expect(refresh.payload).toEqual({ refresh: true, check: "full" });
    workspaceResponse(refresh, snapshot(5, o.first.entries));
    await flush();
    expect(o.requests.state().blocked).toBe(false);
    expect(o.of("restoreWorkspace")).toHaveLength(1);
    o.requests.dispose();
  });
});

// Feature 002 contract Δ8: a HEAD move never replaces the view, so the 001 page-to-HEAD binding is gone. The 001 REPOSITORY_CHANGED rule holds for openHistory.
describe("history view opens", () => {
  function opener(responses: string[]) {
    const targets: unknown[] = [];
    let generation = 1;
    const ok = (result: unknown) => Promise.resolve({ requestId: "r", state: "succeeded", result } as BridgeResponse);
    const view = createHistoryView(
      contractChecked({
        openHistory: (target) => {
          targets.push(target);
          const code = responses.shift();
          if (code !== undefined) return Promise.resolve({ requestId: "r", state: "rejected", code, repositoryGeneration: 1 } as BridgeResponse);
          return ok({ viewId: "view-1", scope: "all", generation, head: { state: "branch", target: "refs/heads/main", oid: HEAD_A }, startCount: 1, refsDigest: "0".repeat(64), shallow: false });
        },
        loadHistory: () => ok({ rows: 0, complete: false }),
        readHistoryRows: () => ok({ target: "unknown", rowCount: 0, lanes: 1, complete: false, bytes: 0 }),
        searchHistory: () => ok({ matches: 0, shallow: false }),
        closeHistory: () => ok({}),
        cancel: () => ok({}),
      }),
      () => ({ repositoryId: REPOSITORY, repositoryGeneration: generation }),
    );
    return { view, targets, setGeneration: (n: number) => void (generation = n) };
  }

  test("REPOSITORY_CHANGED for openHistory sends one new request with the current generation", async () => {
    const o = opener(["REPOSITORY_CHANGED"]);
    const opened = o.view.open("all", false);
    o.setGeneration(2);
    await opened;
    expect(o.targets).toEqual([
      { repositoryId: REPOSITORY, repositoryGeneration: 1 },
      { repositoryId: REPOSITORY, repositoryGeneration: 2 },
    ]);
    expect(o.view.getState().view?.viewId).toBe("view-1");
  });

  test("REPOSITORY_CHANGED for the retried openHistory sets openFailure", async () => {
    const o = opener(["REPOSITORY_CHANGED", "REPOSITORY_CHANGED"]);
    await o.view.open("all", false);
    expect(o.targets).toHaveLength(2);
    expect(o.view.getState().openFailure?.code).toBe("REPOSITORY_CHANGED");
  });

  test("a HEAD move keeps the view: no new openHistory goes out, and readRefs follows", async () => {
    const o = await opened();
    const opens = o.of("openHistory").length;
    const refs = o.of("readRefs").length;
    await o.advance(1000);
    workspaceResponse(o.last("readWorkspace"), retainedOf(o.first, { head: { state: "branch", target: "refs/heads/main", oid: HEAD_B } }));
    await flush();
    expect(o.of("openHistory")).toHaveLength(opens);
    expect(o.of("readRefs")).toHaveLength(refs + 1);
    o.requests.dispose();
  });
});

describe("in-place updates", () => {
  test("a new snapshot with the selected category and pathBytes keeps the shown comparison under the new entryId until the new comparison arrives", async () => {
    const o = await shown();
    await o.advance(1000);
    const moved = o.first.entries.map((e) => ({ ...e, entryId: crypto.randomUUID() }));
    workspaceResponse(o.last("readWorkspace"), snapshot(2, moved));
    await flush();
    expect(o.requests.state().selection?.entryId).toBe(moved[0]!.entryId);
    expect(o.requests.state().comparison?.entryId).toBe(moved[0]!.entryId);
    expect(o.requests.state().comparison?.result).toEqual(o.value);
    expect(o.requests.state().capability).toBeNull();
    o.requests.dispose();
  });

  test("a pending selection of another entry never takes the earlier comparison after a new snapshot", async () => {
    const o = await shown();
    o.requests.selectEntry(o.first.entries[1]!.entryId);
    await flush();
    await o.advance(1000);
    const moved = o.first.entries.map((e) => ({ ...e, entryId: crypto.randomUUID() }));
    workspaceResponse(o.last("readWorkspace"), snapshot(2, moved));
    await flush();
    expect(o.requests.state().selection?.entryId).toBe(moved[1]!.entryId);
    expect(o.requests.state().comparison?.entryId).not.toBe(moved[1]!.entryId);
    o.requests.dispose();
  });
});

describe("focus return on a Windows workspace", () => {
  test("a poll sends check: changes, focus return sends one full read at once without the Refreshing marker, and no poll runs beside it", async () => {
    const o = await opened();
    await o.advance(1000);
    const poll = o.last("readWorkspace");
    expect(poll.payload).toEqual({ refresh: false, check: "changes" });
    o.focus.set(false);
    workspaceResponse(poll, snapshot(1, o.first.entries, { snapshotId: o.first.snapshotId }));
    await flush();
    const unfocused = o.of("readWorkspace").length;
    await o.advance(5000);
    expect(o.of("readWorkspace")).toHaveLength(unfocused);
    o.focus.set(true);
    await flush();
    const reads = o.of("readWorkspace").slice(unfocused);
    expect(reads.map((c) => c.payload)).toEqual([{ refresh: false, check: "full" }]);
    expect(o.requests.state().refreshing).toBe(false);
    await o.advance(2500);
    expect(o.of("readWorkspace")).toHaveLength(unfocused + 1);
    o.requests.dispose();
  });
});

describe("status paging", () => {
  test("a non-null cursor fetches readEntries pages bound to the first page until the cursor is null", async () => {
    const double = bridgeDouble();
    const requests = double.bind(createRequests({ bridge: double.bridge, history: double.history, clock: clockDouble().clock, focus: focusDouble(true).focus }));
    requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
    await flush();
    const [e1, e2, e3] = [entry("unstaged", "1"), entry("unstaged", "2"), entry("staged", "3")];
    const first = snapshot(1, [e1], { entryCount: 3, cursor: crypto.randomUUID() });
    workspaceResponse(double.last("readWorkspace"), first);
    await flush();
    const p2 = double.last("readEntries");
    expect(p2.target).toEqual({ repositoryId: REPOSITORY, repositoryGeneration: 1 });
    expect(p2.payload).toEqual({ snapshotId: first.snapshotId, cursor: first.cursor });
    const cursor = crypto.randomUUID();
    echo(p2, { result: { entries: [e2], cursor } });
    await flush();
    const p3 = double.last("readEntries");
    expect(p3.payload).toEqual({ snapshotId: first.snapshotId, cursor });
    echo(p3, { result: { entries: [e3], cursor: null } });
    await flush();
    expect(double.of("readEntries")).toHaveLength(2);
    expect(requests.state().entries).toEqual([e1, e2, e3]);
    requests.dispose();
  });

  test("a page of an older snapshot never joins the view", async () => {
    const double = bridgeDouble();
    const requests = double.bind(createRequests({ bridge: double.bridge, history: double.history, clock: clockDouble().clock, focus: focusDouble(true).focus }));
    requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
    await flush();
    const old = snapshot(1, [entry("unstaged", "1")], { entryCount: 2, cursor: crypto.randomUUID() });
    workspaceResponse(double.last("readWorkspace"), old);
    await flush();
    const pending = double.last("readEntries");
    requests.refresh();
    await flush();
    const fresh = snapshot(2, [entry("staged", "9")]);
    workspaceResponse(double.last("readWorkspace"), fresh);
    await flush();
    echo(pending, { result: { entries: [entry("unstaged", "2")], cursor: null } });
    await flush();
    expect(requests.state().workspace?.snapshotId).toBe(fresh.snapshotId);
    expect(requests.state().entries).toEqual(fresh.entries);
    requests.dispose();
  });

  for (const code of ["UNKNOWN_TARGET", "REPOSITORY_CHANGED"] as const) {
    test(`${code} during paging drops the partial pages and runs readWorkspace again`, async () => {
      const double = bridgeDouble();
      const requests = double.bind(createRequests({ bridge: double.bridge, history: double.history, clock: clockDouble().clock, focus: focusDouble(true).focus }));
      requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
      await flush();
      const e1 = entry("unstaged", "1");
      workspaceResponse(double.last("readWorkspace"), snapshot(1, [e1], { entryCount: 2, cursor: crypto.randomUUID() }));
      await flush();
      const reads = double.of("readWorkspace").length;
      double.last("readEntries").resolve({ requestId: crypto.randomUUID(), state: "rejected", code, repositoryGeneration: 1 });
      await flush();
      expect(requests.state().entries).not.toContainEqual(e1);
      expect(double.of("readWorkspace")).toHaveLength(reads + 1);
      requests.dispose();
    });
  }
});

describe("superseded comparison reads", () => {
  test("an older canceled readComparison is dropped without a notice", async () => {
    const o = await opened();
    const [a, b] = o.first.entries as [ChangeEntry, ChangeEntry];
    o.requests.selectEntry(a.entryId);
    await flush();
    const older = o.last("readComparison");
    o.requests.selectEntry(b.entryId);
    await flush();
    const newer = o.last("readComparison");
    echo(older, { state: "canceled", code: "CANCELED" });
    await flush();
    expect(o.requests.state().comparison).toBeNull();
    expect(o.requests.state().outcomes).toEqual([]);
    const value = comparison(o.first.snapshotId, b.entryId, ["1".repeat(64)]);
    echo(newer, { result: value });
    await flush();
    expect(o.requests.state().comparison?.result).toEqual(value);
    expect(o.requests.state().outcomes).toEqual([]);
    o.requests.dispose();
  });

  test("a canceled response to the newest readComparison shows its outcome", async () => {
    const o = await opened();
    o.requests.selectEntry(o.first.entries[0]!.entryId);
    await flush();
    echo(o.last("readComparison"), { state: "canceled", code: "CANCELED" });
    await flush();
    expect(o.requests.state().comparison?.state).toBe("canceled");
    o.requests.dispose();
  });
});

// T358: contract §3 "References result"; plan.md Refresh row. Feature 002 contract Δ3 retires the pairing with the history page.
describe("reference reads", () => {
  const refs = (generation: number, current: { name: string; objectId: string } | null) => ({ generation, refs: [], current, refsDigest: "0".repeat(64), completeness: { state: "complete" as const } });

  test("readRefs follows a full readWorkspace result with its generation, and the result shows", async () => {
    const o = await opened();
    expect(o.of("readRefs").map((c) => c.target)).toEqual([{ repositoryId: REPOSITORY, repositoryGeneration: 1 }]);
    const value = refs(1, { name: "main", objectId: HEAD_A });
    echo(o.last("readRefs"), { result: value });
    await flush();
    expect(o.requests.state().refs).toEqual(value);
    o.requests.dispose();
  });

  test("a retained readWorkspace result and a selection send no readRefs", async () => {
    const o = await opened();
    const before = o.of("readRefs").length;
    await o.advance(1000);
    workspaceResponse(o.last("readWorkspace"), retainedOf(o.first));
    await flush();
    o.requests.selectEntry(o.first.entries[0]!.entryId);
    await flush();
    expect(o.of("readRefs")).toHaveLength(before);
    o.requests.dispose();
  });

  test("a WSL poll result sends no readRefs, and a user full read on WSL does", async () => {
    const double = bridgeDouble();
    const time = clockDouble();
    const requests = double.bind(createRequests({ bridge: double.bridge, history: double.history, clock: time.clock, focus: focusDouble(true).focus }));
    requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
    await flush();
    const wsl = { location: { kind: "wsl", distro: "Ubuntu-26.04", git: { path: "/usr/bin/git", version: "2.55.0" } } } as unknown as Partial<WorkspaceSnapshot>;
    workspaceResponse(double.last("readWorkspace"), snapshot(1, [], wsl));
    await flush();
    expect(double.of("readRefs")).toHaveLength(1);
    await time.advance(1000);
    const poll = double.last("readWorkspace");
    workspaceResponse(poll, snapshot(1, [], wsl));
    await flush();
    expect(double.of("readRefs")).toHaveLength(1);
    requests.dispose();
  });

  test("a newer readRefs supersedes an older one", async () => {
    const o = await opened();
    const older = o.last("readRefs");
    o.requests.refresh();
    await flush();
    workspaceResponse(o.last("readWorkspace"), snapshot(1, o.first.entries));
    await flush();
    const newer = o.last("readRefs");
    expect(newer).not.toBe(older);
    const fresh = refs(1, { name: "main", objectId: HEAD_A });
    echo(newer, { result: fresh });
    await flush();
    echo(older, { result: { ...refs(1, { name: "main", objectId: HEAD_A }), refs: [{ kind: "tag", name: "stale" }] } as never });
    await flush();
    expect(o.requests.state().refs).toEqual(fresh);
    o.requests.dispose();
  });

  test("a refusal sets refsFailure, and a later list clears it", async () => {
    const o = await opened();
    const refused = { completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "REF_LISTING_RECORDS" } };
    echo(o.last("readRefs"), { state: "limited", code: "OUTPUT_LIMIT", result: refused });
    await flush();
    expect(o.requests.state().refsFailure?.result).toEqual(refused);
    expect(o.requests.state().refs).toBeNull();
    o.requests.dispose();
  });
});

// T385: a poll that changes no field notifies no listener, so the workbench renders nothing.
describe("no-change polls", () => {
  const retained = (o: { first: WorkspaceSnapshot }, fields: Partial<WorkspaceSnapshot> = {}) => retainedOf(o.first, fields);
  async function polls(o: Awaited<ReturnType<typeof shown>>, count: number, fields: Partial<WorkspaceSnapshot> = {}) {
    let notified = 0;
    const unsubscribe = o.requests.subscribe(() => void notified++);
    const before = o.of("readWorkspace").length;
    for (let i = 0; i < count; i++) {
      await o.advance(1000);
      workspaceResponse(o.last("readWorkspace"), retained(o, fields));
      await flush();
    }
    unsubscribe();
    expect(o.of("readWorkspace")).toHaveLength(before + count);
    return notified;
  }

  test("10 retained polls with the same snapshotId and HEAD notify no listener and keep the state object and the capability", async () => {
    const o = await shown();
    const state = o.requests.state();
    expect(state.capability).not.toBeNull();
    expect(await polls(o, 10)).toBe(0);
    expect(o.requests.state()).toBe(state);
    o.requests.dispose();
  });

  test("a retained poll with a moved HEAD notifies once and records the HEAD", async () => {
    const o = await shown();
    const capability = o.requests.state().capability;
    const head = { state: "branch", target: "refs/heads/main", oid: HEAD_B } as const;
    expect(await polls(o, 1, { head })).toBe(1);
    expect(o.requests.state().headRead?.head).toEqual(head);
    expect(o.requests.state().capability).toBe(capability);
    o.requests.dispose();
  });

  test("a retained poll with the same HEAD records its seq while the recorded seq is not above openedSeq", async () => {
    const o = await shown();
    const seq = o.requests.state().headRead!.seq;
    o.opened.seq = seq;
    expect(await polls(o, 1)).toBe(1);
    expect(o.requests.state().headRead!.seq).toBeGreaterThan(seq);
    expect(await polls(o, 3)).toBe(0);
    o.requests.dispose();
  });
});

// T403, 001 contract §3 `readWorkspace`: a `retained` reply holds no entries page, so the renderer keeps the entries of its committed snapshot.
describe("retained reply without a page (T403)", () => {
  test("T403: a retained reply of the known snapshot keeps the entries and the selection and reads no page", async () => {
    const o = await shown();
    const entries = o.requests.state().entries;
    await o.advance(1000);
    workspaceResponse(o.last("readWorkspace"), retainedOf(o.first));
    await flush();
    expect(o.requests.state().entries).toBe(entries);
    expect(o.requests.state().selection?.entryId).toBe(o.target.entryId);
    expect(o.of("readEntries")).toHaveLength(0);
    o.requests.dispose();
  });

  test("T403: a retained reply of an unknown snapshot keeps the entries and the selection and sends one full read", async () => {
    const o = await shown();
    const entries = o.requests.state().entries;
    await o.advance(1000);
    const reads = o.of("readWorkspace").length;
    workspaceResponse(o.last("readWorkspace"), retainedOf(o.first, { snapshotId: crypto.randomUUID() }));
    await flush();
    expect(o.requests.state().entries).toBe(entries);
    expect(o.requests.state().selection?.entryId).toBe(o.target.entryId);
    expect(o.of("readWorkspace").slice(reads).map((c) => c.payload)).toEqual([{ refresh: false, check: "full" }]);
    o.requests.dispose();
  });
});

// T354: one view without modes. The History-ready mark (`arbareto:history-painted`) counts `historyEpoch`.
describe("refresh in the one view", () => {
  test("a user Refresh sends readWorkspace with refresh true and openHistory together, and adds 1 to historyEpoch", async () => {
    const o = await opened();
    const epoch = o.requests.state().historyEpoch;
    const histories = o.of("openHistory").length;
    o.requests.refresh();
    await flush();
    expect(o.last("readWorkspace").payload).toEqual({ refresh: true, check: "full" });
    expect(o.of("openHistory")).toHaveLength(histories + 1);
    expect(o.requests.state().historyEpoch).toBe(epoch + 1);
    expect("mode" in o.requests.state()).toBe(false);
    o.requests.dispose();
  });
});

// 001 contract §8 "Equal full read": the reply carries the kept `snapshotId`. The renderer applies its summary and reads the shown comparison again.
describe("equal full read (T400)", () => {
  test("T400: a full read with the known snapshotId reads the shown comparison again and keeps the entries and the selection", async () => {
    const o = await shown();
    const entries = o.requests.state().entries;
    const comparisons = o.of("readComparison").length;
    o.requests.refresh();
    await flush();
    workspaceResponse(o.last("readWorkspace"), { ...o.first, recoveryState: "ready" });
    await flush();
    expect(o.of("readComparison")).toHaveLength(comparisons + 1);
    expect(o.last("readComparison").payload).toEqual({ snapshotId: o.first.snapshotId, entryId: o.target.entryId });
    expect(o.of("readEntries")).toHaveLength(0);
    expect(o.requests.state().entries).toBe(entries);
    expect(o.requests.state().selection?.entryId).toBe(o.target.entryId);
    expect(o.requests.state().comparison?.result).toEqual(o.value);
    o.requests.dispose();
  });

  test("T400: a known-snapshot reply with recoveryState ready after a committed reconciling snapshot clears blocked", async () => {
    const o = await opened();
    o.requests.refresh();
    await flush();
    const reconciling = snapshot(1, o.first.entries, { recoveryState: "reconciling" });
    workspaceResponse(o.last("readWorkspace"), reconciling);
    await flush();
    expect(o.requests.state().blocked).toBe(true);
    const entries = o.requests.state().entries;
    o.requests.refresh();
    await flush();
    workspaceResponse(o.last("readWorkspace"), { ...reconciling, recoveryState: "ready" });
    await flush();
    expect(o.requests.state().workspace?.recoveryState).toBe("ready");
    expect(o.requests.state().blocked).toBe(false);
    expect(o.requests.state().entries).toBe(entries);
    o.requests.dispose();
  });
});
