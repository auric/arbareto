// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { FINISHED_OPERATION_RECORDS } from "../../src/contracts/limits";
import { createSessionLog } from "../../src/git-service/log";
import { createOperationRegistry } from "../../src/git-service/operations";
import { createSession, type SessionOptions } from "../../src/git-service/session";

printOrigin("../../src/git-service/operations.ts", import.meta.dir);
printOrigin("../../src/git-service/log.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

type Sent = { kind: "response" | "progress" | "closeJob" | "ended"; value: Record<string, unknown> };

// `sent` holds the frames to the renderer. `timeline` also holds the shell frames, in order.
function registry() {
  const sent: Sent[] = [];
  const timeline: Sent[] = [];
  const renderer = (entry: Sent) => {
    sent.push(entry);
    timeline.push(entry);
  };
  const ops = createOperationRegistry(
    (value) => renderer({ kind: "response", value: { ...value } }),
    (value) => renderer({ kind: "progress", value: { ...value } }),
    createSessionLog(),
    {
      closeJob: (operationId) => void timeline.push({ kind: "closeJob", value: { operationId } }),
      ended: (operationId, endProcesses) => void timeline.push({ kind: "ended", value: { operationId, endProcesses } }),
    },
  );
  return { ops, sent, timeline, progress: () => sent.filter((s) => s.kind === "progress").map((s) => s.value) };
}

type Ops = ReturnType<typeof registry>["ops"];

// A read that reaches `succeeded`.
function finishRead(ops: Ops): string {
  const { operationId } = ops.start("readHistory", crypto.randomUUID());
  ops.apply(operationId, { type: "valid-read" });
  ops.apply(operationId, { type: "read-complete", result: "succeeded" });
  return operationId;
}

// A commit that consumed its approval: the marker reply moved it to `running`.
function finishCommit(ops: Ops): string {
  const { operationId } = ops.start("commit", crypto.randomUUID());
  ops.apply(operationId, { type: "marker-recorded" });
  ops.apply(operationId, { type: "execution-ended", lingeringDescendants: 0 });
  ops.apply(operationId, { type: "intended-effects-confirmed" });
  return operationId;
}

const PROGRESS_FIELDS = ["requestId", "operationId", "state", "phase", "counters", "stalled"];

describe("operation registry", () => {
  test("start sends the accepted event before any transition", () => {
    const { ops, sent } = registry();
    const requestId = crypto.randomUUID();
    const { operationId } = ops.start("readHistory", requestId);
    expect(sent).toEqual([{ kind: "progress", value: { requestId, operationId, state: "accepted", counters: {} } }]);
  });

  test("every progress event carries the requestId and the current state", () => {
    const { ops, progress } = registry();
    const requestId = crypto.randomUUID();
    const { operationId } = ops.start("commit", requestId);
    ops.apply(operationId, { type: "marker-recorded" });
    ops.progress(operationId, "preflight", { done: 1 });
    ops.apply(operationId, { type: "stall" });
    ops.progress(operationId, "commit-handoff");
    ops.apply(operationId, { type: "cancel" });
    ops.progress(operationId, "commit-handoff");
    const events = progress();
    expect(events.length).toBe(4);
    for (const event of events) {
      expect(event.requestId).toBe(requestId);
      expect(event.operationId).toBe(operationId);
    }
    expect(events.map((e) => e.state)).toEqual(["accepted", "running", "running", "cancel-requested"]);
    expect(events[1]).toEqual({ requestId, operationId, state: "running", phase: "preflight", counters: { done: 1 } });
    expect(events[2]).toEqual({ requestId, operationId, state: "running", phase: "commit-handoff", counters: {}, stalled: true });
  });

  test("progress after the terminal response throws and sends nothing", () => {
    const { ops, sent } = registry();
    const { operationId } = ops.start("readHistory", crypto.randomUUID());
    ops.apply(operationId, { type: "valid-read" });
    ops.apply(operationId, { type: "read-complete", result: "succeeded" });
    const before = sent.length;
    expect(sent.at(-1)?.kind).toBe("response");
    expect(() => ops.progress(operationId, "preflight")).toThrow();
    expect(sent.length).toBe(before);
  });

  test("the phases follow data-model §7", () => {
    const { ops } = registry();
    const { operationId } = ops.start("updateSubmodules", crypto.randomUUID());
    ops.apply(operationId, { type: "marker-recorded" });
    for (const phase of ["wsl-starting", "fetch", "update"]) expect(() => ops.progress(operationId, phase as never)).not.toThrow();
    for (const phase of ["submodule-fetch", "submodule-update", "running"]) expect(() => ops.progress(operationId, phase as never)).toThrow();
  });

  test("a progress event has only the contract §2 fields, and only commit and updateSubmodules carry stalled", () => {
    const { ops, progress } = registry();
    const read = ops.start("readWorkspace", crypto.randomUUID()).operationId;
    ops.apply(read, { type: "valid-read" });
    ops.progress(read, "preflight", { files: 3 });
    expect(() => ops.apply(read, { type: "stall" })).toThrow();
    for (const name of ["commit", "updateSubmodules"] as const) {
      const id = ops.start(name, crypto.randomUUID()).operationId;
      ops.apply(id, { type: "marker-recorded" });
      ops.apply(id, { type: "stall" });
      ops.progress(id, name === "commit" ? "commit-handoff" : "update");
      ops.apply(id, { type: "activity" });
      ops.progress(id, name === "commit" ? "commit-handoff" : "update");
    }
    const events = progress();
    for (const event of events) {
      expect(Object.keys(event).every((k) => PROGRESS_FIELDS.includes(k))).toBe(true);
      expect(["accepted", "running", "cancel-requested", "reconciling"]).toContain(event.state as string);
    }
    const readEvents = events.filter((e) => e.operationId === read);
    expect(readEvents.map((e) => Object.hasOwn(e, "stalled"))).toEqual([false, false]);
    expect(readEvents[1]).toEqual({ requestId: readEvents[0].requestId, operationId: read, state: "running", phase: "preflight", counters: { files: 3 } });
    expect(events.filter((e) => Object.hasOwn(e, "stalled")).map((e) => e.stalled)).toEqual([true, false, true, false]);
  });

  test("progress refuses counters that are not bounded nonnegative integers", () => {
    const { ops, sent } = registry();
    const { operationId } = ops.start("readWorkspace", crypto.randomUUID());
    ops.apply(operationId, { type: "valid-read" });
    const before = sent.length;
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "1"]) {
      expect(() => ops.progress(operationId, "preflight", { files: value as number })).toThrow();
    }
    expect(sent.length).toBe(before);
  });

  test("cancel moves a running read to cancel-requested and signals its processes", () => {
    const { ops } = registry();
    const { operationId, signal } = ops.start("readWorkspace", crypto.randomUUID());
    ops.apply(operationId, { type: "valid-read" });
    expect(ops.cancel(operationId)).toMatchObject({ operationId, operation: "readWorkspace", state: "cancel-requested" });
    expect(signal.aborted).toBe(true);
    expect(ops.get(operationId)?.state).toBe("cancel-requested");
    ops.apply(operationId, { type: "processes-stopped" });
    expect(ops.cancel(operationId)).toMatchObject({ state: "canceled", code: "CANCELED" });
    expect(ops.cancel(crypto.randomUUID())).toBeUndefined();
  });

  test("cancel during reconciling keeps the reads and sets endProcesses", () => {
    const { ops } = registry();
    const { operationId, signal } = ops.start("commit", crypto.randomUUID());
    ops.apply(operationId, { type: "marker-recorded" });
    ops.apply(operationId, { type: "execution-ended", lingeringDescendants: 2 });
    expect(ops.cancel(operationId)).toMatchObject({ state: "reconciling", endProcesses: true, lingeringDescendants: 0 });
    expect(signal.aborted).toBe(false);
  });

  test("getOperation returns the current state and the retained terminal state", () => {
    const { ops } = registry();
    const { operationId } = ops.start("readHistory", crypto.randomUUID());
    expect(ops.get(operationId)).toMatchObject({ operationId, operation: "readHistory", state: "accepted" });
    ops.apply(operationId, { type: "valid-read" });
    expect(ops.get(operationId)?.state).toBe("running");
    ops.apply(operationId, { type: "read-complete", result: "limited", code: "OUTPUT_LIMIT" });
    expect(ops.get(operationId)).toMatchObject({ state: "limited", code: "OUTPUT_LIMIT" });
    expect(ops.get(crypto.randomUUID())).toBeUndefined();
  });

  test("a terminal record above 256 removes the oldest terminal record first", () => {
    const { ops } = registry();
    // `late` starts first but ends last, so the terminal order decides.
    const late = ops.start("readHistory", crypto.randomUUID()).operationId;
    ops.apply(late, { type: "valid-read" });
    const ids = Array.from({ length: FINISHED_OPERATION_RECORDS - 1 }, () => finishRead(ops));
    ops.apply(late, { type: "read-complete", result: "succeeded" });
    for (const id of [...ids, late]) expect(ops.get(id)).toBeDefined();
    const next = finishRead(ops);
    expect(ops.get(ids[0])).toBeUndefined();
    expect(ops.get(late)).toBeDefined();
    expect(ops.get(next)).toBeDefined();
    for (let i = 1; i < ids.length; i++) finishRead(ops);
    expect(ops.get(late)).toBeDefined();
    finishRead(ops);
    expect(ops.get(late)).toBeUndefined();
  });

  test("a rejected request counts as a terminal record", () => {
    const { ops } = registry();
    const busy = ops.start("commit", crypto.randomUUID()).operationId;
    ops.apply(busy, { type: "marker-refused", code: "BUSY" });
    for (let i = 0; i < FINISHED_OPERATION_RECORDS - 1; i++) finishRead(ops);
    expect(ops.get(busy)).toMatchObject({ state: "rejected", code: "BUSY" });
    finishRead(ops);
    expect(ops.get(busy)).toBeUndefined();
  });

  test("eviction never removes a non-terminal record or a mutation record that consumed an approval", () => {
    const { ops } = registry();
    const running = ops.start("readWorkspace", crypto.randomUUID()).operationId;
    ops.apply(running, { type: "valid-read" });
    const accepted = ops.start("readHistory", crypto.randomUUID()).operationId;
    const commit = finishCommit(ops);
    expect(ops.get(commit)?.state).toBe("succeeded");
    for (let i = 0; i < FINISHED_OPERATION_RECORDS * 2 + 1; i++) finishRead(ops);
    expect(ops.get(running)?.state).toBe("running");
    expect(ops.get(accepted)?.state).toBe("accepted");
    expect(ops.get(commit)?.state).toBe("succeeded");
  });

  test("closeJob follows the terminal response of an operation without a marker, and ended follows a marker", () => {
    const { ops, timeline: sent } = registry();
    const read = finishRead(ops);
    const own = (id: string) => sent.filter((s) => s.value.operationId === id && s.kind !== "progress").map((s) => s.kind);
    expect(own(read)).toEqual(["response", "closeJob"]);

    const busy = ops.start("applyFile", crypto.randomUUID()).operationId;
    ops.apply(busy, { type: "marker-refused", code: "BUSY" });
    expect(own(busy)).toEqual(["response", "closeJob"]);

    const commit = ops.start("commit", crypto.randomUUID()).operationId;
    ops.apply(commit, { type: "marker-recorded" });
    ops.apply(commit, { type: "execution-ended", lingeringDescendants: 1 });
    expect(own(commit)).toEqual([]);
    ops.apply(commit, { type: "cancel" });
    ops.apply(commit, { type: "intended-effects-confirmed" });
    expect(own(commit)).toEqual(["response", "ended"]);
    expect(sent.at(-1)?.value).toEqual({ operationId: commit, endProcesses: true });
  });
});

describe("operation records through the session", () => {
  const encoder = new TextEncoder();
  const HANDSHAKE = {
    kind: "handshake",
    handshake: {
      version: 1,
      restarted: false,
      platformScope: "other",
      osBuild: 26200,
      webView2Version: "140.0.0.0",
      buildIdentity: { version: "0.1.0", commit: "0".repeat(40), signing: "unsigned" },
      markers: [],
      unloadedMarkers: 0,
      trustRecords: [],
    },
  };

  test("getOperation and cancel with a removed operationId give UNKNOWN_TARGET", () => {
    const frames: Record<string, Record<string, unknown>>[] = [];
    const closed: string[] = [];
    const runner = { receive: () => false, closeJob: (id: string) => void closed.push(id), ended: () => {} };
    const session = createSession({
      writer: { write: (frame) => void frames.push(frame as never), flush: async () => {} },
      runner: runner as unknown as SessionOptions["runner"],
      fail: () => {},
    });
    session.receive({ type: "frame", body: encoder.encode(JSON.stringify(HANDSHAKE)) });
    const sessionId = session.sessionId as string;
    const finish = () => {
      const { operationId } = session.registry.start("readHistory", crypto.randomUUID());
      session.registry.apply(operationId, { type: "valid-read" });
      session.registry.apply(operationId, { type: "read-complete", result: "succeeded" });
      return operationId;
    };
    const first = finish();
    const second = finish();
    for (let i = 0; i < FINISHED_OPERATION_RECORDS - 1; i++) finish();
    expect(closed.length).toBe(FINISHED_OPERATION_RECORDS + 1);
    const ask = (operation: string, operationId: string) => {
      const requestId = crypto.randomUUID();
      const request = { version: 1, sessionId, requestId, operation, payload: { operationId } };
      session.receive({ type: "frame", body: encoder.encode(JSON.stringify({ kind: "public", request })) });
      return frames.findLast((f) => f.response?.requestId === requestId)?.response;
    };
    expect(ask("getOperation", first)).toMatchObject({ state: "rejected", code: "UNKNOWN_TARGET" });
    expect(ask("cancel", first)).toMatchObject({ state: "rejected", code: "UNKNOWN_TARGET" });
    expect(ask("getOperation", second)).toMatchObject({ state: "succeeded", result: { operationId: second, state: "succeeded" } });
  });
});
