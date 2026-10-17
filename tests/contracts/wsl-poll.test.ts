// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { ChangeEntry, WorkspaceSnapshot } from "../../src/contracts/envelope";
import type { BridgeResponse, OnProgress } from "../../src/frontend/bridge";
import { printOrigin } from "../origin";
import { createRequests } from "../../src/frontend/state/requests";
import { contractChecked } from "./bridge-contract";

printOrigin("../../src/frontend/state/requests.ts", import.meta.dir);

// tasks.md T215. Spec FR-042, contract §11 "Change polling", §5 "Concurrent reads", data-model "WSL start and poll transitions".

type Call = { operation: string; target: Record<string, unknown>; payload: Record<string, unknown>; onProgress?: OnProgress; resolve(response: BridgeResponse): void };

// Each call stays pending until the test resolves it.
function bridgeDouble() {
  const calls: Call[] = [];
  const record = (operation: string, target: Record<string, unknown> = {}, payload: Record<string, unknown> = {}, onProgress?: OnProgress) =>
    new Promise<BridgeResponse>((resolve) => calls.push({ operation, target, payload, onProgress, resolve }));
  const bridge = {
    restoreWorkspace: () => record("restoreWorkspace"),
    readWorkspace: (target: Record<string, unknown>, payload: Record<string, unknown>, onProgress?: OnProgress) => record("readWorkspace", target, payload, onProgress),
    readEntries: (target: Record<string, unknown>, payload: Record<string, unknown>) => record("readEntries", target, payload),
    readComparison: (target: Record<string, unknown>, payload: Record<string, unknown>) => record("readComparison", target, payload),
    readRefs: (target: Record<string, unknown>) => record("readRefs", target),
    cancel: (payload: Record<string, unknown>) => record("cancel", {}, payload),
  };
  // The history view participant. Its `openHistory` request goes through `track`, as the workbench sends it (feature 002 contract Δ3).
  let store: { track<T>(request: Promise<T>): Promise<T>; target(): { repositoryId: string; repositoryGeneration: number } | null } | null = null;
  const history = {
    open: () => store!.track(record("openHistory", store!.target() ?? {}, { scope: "all" })),
    refresh: () => store!.track(record("openHistory", store!.target() ?? {}, { scope: "all" })),
  };
  const bind = <T extends NonNullable<typeof store>>(requests: T) => ((store = requests), requests);
  const of = (operation: string) => calls.filter((call) => call.operation === operation);
  const last = (operation: string) => {
    const found = of(operation).at(-1);
    if (!found) throw new Error(`no ${operation} call`);
    return found;
  };
  return { bridge: contractChecked(bridge), calls, of, last, history, bind };
}

function clockDouble() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; every: number | null; run: () => void }>();
  const clock = {
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
const HEAD = "a".repeat(40);
// Contract §11 "Route": a WSL identity is the normalized UNC path with the `\\wsl.localhost\` prefix and the listed distro spelling.
const WSL_ROOT = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\tester\\repo";
const WINDOWS_ROOT = "C:\\repo";

const entry = (path: string): ChangeEntry => ({ entryId: crypto.randomUUID(), category: "unstaged", path, pathBytes: Buffer.from(path).toString("base64") });

function snapshot(generation: number, root: string, entries: ChangeEntry[]): WorkspaceSnapshot {
  return {
    generation,
    snapshotId: crypto.randomUUID(),
    readKind: "full",
    identity: { worktreeRoot: root, gitDirectory: `${root}\\.git`, commonDirectory: `${root}\\.git`, indexPath: `${root}\\.git\\index`, objectFormat: "sha1", refFormat: "files" },
    head: { state: "branch", target: "refs/heads/main", oid: HEAD },
    operationState: "normal",
    recoveryState: "ready",
    completeness: { state: "complete" },
    hunkEligibility: { eligible: true },
    // Data-model §2 `location`: the WSL fixture root is in distro Ubuntu-24.04.
    location: root === WSL_ROOT ? { kind: "wsl", distro: "Ubuntu-24.04", git: { path: "/usr/bin/git", version: "2.55.0" } } : { kind: "native" },
    submoduleNotice: { count: 0, paths: [], filter: "applied" },
    entryCount: entries.length,
    entries,
    cursor: null,
  };
}


const succeeded = (call: Call, result: unknown, fields: Partial<BridgeResponse> = {}) =>
  call.resolve({ requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded", repositoryGeneration: 1, result, ...fields });

// An open workspace whose first full read and first history read are answered at time 0.
async function opened(root = WSL_ROOT, focused = true) {
  const double = bridgeDouble();
  const time = clockDouble();
  const focus = focusDouble(focused);
  const requests = double.bind(createRequests({ bridge: double.bridge, history: double.history, clock: time.clock, focus: focus.focus }));
  requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
  await flush();
  const first = snapshot(1, root, [entry("a.txt"), entry("b.txt")]);
  succeeded(double.last("readWorkspace"), first);
  succeeded(double.last("openHistory"), {});
  await flush();
  const reads = () => double.of("readWorkspace");
  // Answers the newest `readWorkspace` with the same snapshot content and a new snapshot ID.
  const answerRead = async (call = double.last("readWorkspace")) => {
    succeeded(call, snapshot(1, root, first.entries));
    await flush();
  };
  return { ...double, ...time, focus, requests, first, reads, answerRead };
}

describe("WSL poll schedule", () => {
  test("a poll is readWorkspace with refresh: false and check: full, and it goes out 1 second after the first read ends", async () => {
    const o = await opened();
    expect(o.reads()).toHaveLength(1);
    await o.advance(999);
    expect(o.reads()).toHaveLength(1);
    await o.advance(1);
    expect(o.reads()).toHaveLength(2);
    expect(o.last("readWorkspace").payload).toEqual({ refresh: false, check: "full" });
    o.requests.dispose();
  });

  test("the next poll starts 1 second after the previous poll ends, not on a fixed interval", async () => {
    const o = await opened();
    await o.advance(1000);
    expect(o.reads()).toHaveLength(2);
    // The poll runs for 1.5 seconds.
    await o.advance(1500);
    expect(o.reads()).toHaveLength(2);
    await o.answerRead();
    await o.advance(999);
    expect(o.reads()).toHaveLength(2);
    await o.advance(1);
    expect(o.reads()).toHaveLength(3);
    expect(o.reads().map((c) => c.payload.check)).toEqual(["full", "full", "full"]);
    o.requests.dispose();
  });

  test("a poll that falls due during a user Refresh starts when that read ends, and never beside it", async () => {
    const o = await opened();
    await o.advance(500);
    o.requests.refresh();
    await flush();
    const refresh = o.last("readWorkspace");
    expect(refresh.payload).toEqual({ refresh: true, check: "full" });
    // The refresh also opens a new history view.
    succeeded(o.last("openHistory"), {});
    await o.advance(2000);
    expect(o.reads()).toHaveLength(2);
    await o.answerRead(refresh);
    expect(o.reads()).toHaveLength(3);
    expect(o.last("readWorkspace").payload).toEqual({ refresh: false, check: "full" });
    o.requests.dispose();
  });

  test("a poll that falls due during a comparison read of that workspace starts when that read ends", async () => {
    const o = await opened();
    o.requests.selectEntry(o.first.entries[0]!.entryId);
    await flush();
    const comparison = o.last("readComparison");
    await o.advance(3000);
    expect(o.reads()).toHaveLength(1);
    succeeded(comparison, { comparisonId: crypto.randomUUID(), snapshotId: o.first.snapshotId, hunks: [] }, { selectionId: comparison.target.selectionId as string });
    await flush();
    expect(o.reads()).toHaveLength(2);
    expect(o.last("readWorkspace").payload).toEqual({ refresh: false, check: "full" });
    o.requests.dispose();
  });

  test("a running poll never gets a second poll beside it", async () => {
    const o = await opened();
    await o.advance(1000);
    expect(o.reads()).toHaveLength(2);
    await o.advance(10_000);
    expect(o.reads()).toHaveLength(2);
    o.requests.dispose();
  });

  test("no poll starts without focus", async () => {
    const o = await opened(WSL_ROOT, false);
    await o.advance(10_000);
    expect(o.reads()).toHaveLength(1);
    o.requests.dispose();
  });

  test("a focus loss lets the running poll finish and starts no further poll", async () => {
    const o = await opened();
    await o.advance(1000);
    expect(o.reads()).toHaveLength(2);
    o.focus.set(false);
    await o.answerRead();
    await o.advance(10_000);
    expect(o.reads()).toHaveLength(2);
    o.requests.dispose();
  });

  test("focus return sends a full read at once, and the next poll goes out 1 second after it ends", async () => {
    const o = await opened(WSL_ROOT, false);
    await o.advance(5000);
    o.focus.set(true);
    await flush();
    expect(o.reads()).toHaveLength(2);
    expect(o.last("readWorkspace").payload).toEqual({ refresh: false, check: "full" });
    await o.advance(400);
    await o.answerRead();
    await o.advance(999);
    expect(o.reads()).toHaveLength(2);
    await o.advance(1);
    expect(o.reads()).toHaveLength(3);
    expect(o.last("readWorkspace").payload).toEqual({ refresh: false, check: "full" });
    o.requests.dispose();
  });

  test("each mutation outcome sends a full read at once", async () => {
    const o = await opened();
    await o.advance(300);
    o.requests.mutationEnded("commit", { requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), state: "succeeded" });
    await flush();
    expect(o.reads()).toHaveLength(2);
    expect(o.last("readWorkspace").payload).toEqual({ refresh: false, check: "full" });
    o.requests.dispose();
  });

  test("no poll shows the Refreshing marker", async () => {
    const o = await opened();
    const marks: boolean[] = [];
    o.requests.subscribe(() => marks.push(o.requests.state().refreshing));
    await o.advance(1000);
    expect(o.reads()).toHaveLength(2);
    expect(o.requests.state().refreshing).toBe(false);
    await o.answerRead();
    expect(marks.every((m) => m === false)).toBe(true);
    o.requests.dispose();
  });
});

describe("WSL poll cancel", () => {
  // A running poll and one comparison read fill both workspace read slots (contract §5 "Concurrent reads": 2 per workspace).
  async function busy() {
    const o = await opened();
    await o.advance(1000);
    const poll = o.last("readWorkspace");
    const operationId = crypto.randomUUID();
    poll.onProgress?.({ requestId: crypto.randomUUID(), operationId, state: "accepted", counters: {} });
    o.requests.selectEntry(o.first.entries[0]!.entryId);
    await flush();
    return { ...o, poll, operationId };
  }

  test("a user read beside a running poll with one free slot cancels nothing", async () => {
    const o = await busy();
    expect(o.of("cancel")).toHaveLength(0);
    o.requests.dispose();
  });

  test("a user read that finds both read slots busy cancels the running poll by its operationId", async () => {
    const o = await busy();
    o.requests.refresh();
    await flush();
    expect(o.of("cancel").map((c) => c.payload)).toEqual([{ operationId: o.operationId }]);
    o.requests.dispose();
  });

  test("a canceled poll shows no read failure, and the next poll goes out 1 second after it ends", async () => {
    const o = await busy();
    o.requests.refresh();
    await flush();
    o.poll.resolve({ requestId: crypto.randomUUID(), operationId: o.operationId, state: "canceled" });
    await flush();
    expect(o.requests.state().readFailure).toBeNull();
    // The refresh, the history read, and each comparison read end, so no other read of the workspace runs.
    // The refresh result has a new snapshot, so the selected entry gets a second comparison read.
    await o.answerRead(o.of("readWorkspace").find((c) => c.payload.refresh === true)!);
    succeeded(o.last("openHistory"), {});
    for (const c of o.of("readComparison")) succeeded(c, { comparisonId: crypto.randomUUID(), snapshotId: o.first.snapshotId, hunks: [] }, { selectionId: c.target.selectionId as string });
    await flush();
    expect(o.of("readComparison")).toHaveLength(2);
    const after = o.reads().length;
    await o.advance(999);
    expect(o.reads().length).toBe(after);
    await o.advance(1);
    expect(o.reads().length).toBe(after + 1);
    expect(o.last("readWorkspace").payload).toEqual({ refresh: false, check: "full" });
    o.requests.dispose();
  });

  test("a user read before the poll's accepted event sends the cancel when the operationId arrives", async () => {
    const o = await opened();
    await o.advance(1000);
    const poll = o.last("readWorkspace");
    o.requests.selectEntry(o.first.entries[0]!.entryId);
    await flush();
    o.requests.refresh();
    await flush();
    expect(o.of("cancel")).toHaveLength(0);
    const operationId = crypto.randomUUID();
    poll.onProgress?.({ requestId: crypto.randomUUID(), operationId, state: "accepted", counters: {} });
    await flush();
    expect(o.of("cancel").map((c) => c.payload)).toEqual([{ operationId }]);
    o.requests.dispose();
  });
});

describe("Windows workspace", () => {
  test("a Windows workspace keeps its check: changes poll on the 1 second interval", async () => {
    const o = await opened(WINDOWS_ROOT);
    await o.advance(1000);
    expect(o.reads()).toHaveLength(2);
    expect(o.last("readWorkspace").payload).toEqual({ refresh: false, check: "changes" });
    o.requests.dispose();
  });
});

describe("no workspace snapshot", () => {
  // Without a snapshot, the location is unknown. Contract §11 "Change polling" forbids `check: "changes"` for a WSL workspace.
  test("after the first full read fails, each interval poll sends check: full, until a snapshot arrives", async () => {
    const double = bridgeDouble();
    const time = clockDouble();
    const focus = focusDouble(true);
    const requests = double.bind(createRequests({ bridge: double.bridge, history: double.history, clock: time.clock, focus: focus.focus }));
    requests.open({ repositoryId: REPOSITORY, generation: 1, worktreeKey: WORKTREE_KEY });
    await flush();
    double.last("readWorkspace").resolve({ requestId: crypto.randomUUID(), state: "failed", code: "REPOSITORY_UNAVAILABLE" });
    succeeded(double.last("openHistory"), {});
    await flush();
    await time.advance(1000);
    expect(double.of("readWorkspace")).toHaveLength(2);
    expect(double.last("readWorkspace").payload).toEqual({ refresh: false, check: "full" });
    double.last("readWorkspace").resolve({ requestId: crypto.randomUUID(), state: "failed", code: "REPOSITORY_UNAVAILABLE" });
    await flush();
    await time.advance(1000);
    expect(double.of("readWorkspace")).toHaveLength(3);
    expect(double.last("readWorkspace").payload).toEqual({ refresh: false, check: "full" });
    // Control: after a Windows snapshot arrives, the interval poll sends check: changes.
    succeeded(double.last("readWorkspace"), snapshot(1, WINDOWS_ROOT, [entry("a.txt")]));
    await flush();
    await time.advance(1000);
    expect(double.of("readWorkspace")).toHaveLength(4);
    expect(double.last("readWorkspace").payload).toEqual({ refresh: false, check: "changes" });
    requests.dispose();
  });
});
