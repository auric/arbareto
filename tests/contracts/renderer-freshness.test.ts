// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { BridgeResponse } from "../../src/frontend/bridge";
import type { ChangeEntry, HistoryPage, WorkspaceSnapshot } from "../../src/contracts/envelope";
import { printOrigin } from "../origin";
import { createRequests } from "../../src/frontend/state/requests";

printOrigin("../../src/frontend/state/requests.ts", import.meta.dir);

// Contract §2, §3 "HistoryPage result", §5 "Pending reads", and §8. plan.md "Freshness and reconciliation".

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
    readHistory: (target: Record<string, unknown>) => record("readHistory", target),
    readComparison: (target: Record<string, unknown>, payload: Record<string, unknown>) => record("readComparison", target, payload),
  };
  const of = (operation: string) => calls.filter((call) => call.operation === operation);
  const last = (operation: string) => {
    const found = of(operation).at(-1);
    if (!found) throw new Error(`no ${operation} call`);
    return found;
  };
  return { bridge, calls, of, last };
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
    identity: { worktreeRoot: "C:\\repo", gitDirectory: "C:\\repo\\.git", commonDirectory: "C:\\repo\\.git", indexPath: "C:\\repo\\.git\\index", objectFormat: "sha1", refFormat: "files" },
    head: { state: "branch", target: "refs/heads/main", oid: HEAD_A },
    operationState: "normal",
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
    submoduleNotice: { count: 0, paths: [], filter: "applied" },
    entryCount: entries.length,
    entries,
    cursor: null,
    ...fields,
  };
}

function page(generation: number, head: string): HistoryPage {
  return {
    generation,
    scope: "current-checkout",
    head: { state: "branch", target: "refs/heads/main", oid: head },
    shallowFingerprint: null,
    rows: [{ oid: head, parents: [], subject: "First", author: { name: "A", email: "a@example.com" }, date: 1_700_000_000, encoding: null }],
    boundaries: { page: [], shallow: [] },
    completeness: { state: "complete" },
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
  const requests = createRequests({ bridge: double.bridge, clock: time.clock, focus: focus.focus });
  requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
  await flush();
  const first = snapshot(1, entries);
  workspaceResponse(double.last("readWorkspace"), first);
  echo(double.last("readHistory"), { result: page(1, HEAD_A) });
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
  test("the first read is a full read without refresh, and readHistory goes out beside it", async () => {
    const double = bridgeDouble();
    const time = clockDouble();
    const requests = createRequests({ bridge: double.bridge, clock: time.clock, focus: focusDouble(true).focus });
    requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
    await flush();
    expect(double.of("readWorkspace").map((c) => c.payload)).toEqual([{ refresh: false, check: "full" }]);
    expect(double.of("readHistory").map((c) => c.target)).toEqual([{ repositoryId: REPOSITORY, repositoryGeneration: 1 }]);
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

describe("history responses", () => {
  test("an older-generation history response replaces the view when its captured HEAD equals the newest observed HEAD", async () => {
    const double = bridgeDouble();
    const requests = createRequests({ bridge: double.bridge, clock: clockDouble().clock, focus: focusDouble(true).focus });
    requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
    await flush();
    const history = double.last("readHistory");
    workspaceResponse(double.last("readWorkspace"), snapshot(2, []));
    await flush();
    const late = page(1, HEAD_A);
    echo(history, { result: late });
    await flush();
    expect(requests.state().history).toEqual(late);
    requests.dispose();
  });

  test("a history response with another HEAD never replaces the view", async () => {
    const double = bridgeDouble();
    const requests = createRequests({ bridge: double.bridge, clock: clockDouble().clock, focus: focusDouble(true).focus });
    requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
    await flush();
    const history = double.last("readHistory");
    workspaceResponse(double.last("readWorkspace"), snapshot(2, [], { head: { state: "branch", target: "refs/heads/main", oid: HEAD_B } }));
    await flush();
    echo(history, { result: page(1, HEAD_A) });
    await flush();
    expect(requests.state().history).toBeNull();
    requests.dispose();
  });

  test("REPOSITORY_CHANGED for readHistory sends one new request with the current generation", async () => {
    const double = bridgeDouble();
    const requests = createRequests({ bridge: double.bridge, clock: clockDouble().clock, focus: focusDouble(true).focus });
    requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
    await flush();
    const history = double.last("readHistory");
    workspaceResponse(double.last("readWorkspace"), snapshot(2, []));
    await flush();
    const before = double.of("readHistory").length;
    history.resolve({ requestId: crypto.randomUUID(), state: "rejected", code: "REPOSITORY_CHANGED", repositoryGeneration: 1 });
    await flush();
    expect(double.of("readHistory").slice(before).map((c) => c.target)).toEqual([{ repositoryId: REPOSITORY, repositoryGeneration: 2 }]);
    requests.dispose();
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
    const requests = createRequests({ bridge: double.bridge, clock: clockDouble().clock, focus: focusDouble(true).focus });
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
    const requests = createRequests({ bridge: double.bridge, clock: clockDouble().clock, focus: focusDouble(true).focus });
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
      const requests = createRequests({ bridge: double.bridge, clock: clockDouble().clock, focus: focusDouble(true).focus });
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
