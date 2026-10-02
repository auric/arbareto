// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { createSessionLog } from "../../src/git-service/log";
import { createOperationRegistry } from "../../src/git-service/operations";

printOrigin("../../src/git-service/operations.ts", import.meta.dir);
printOrigin("../../src/git-service/log.ts", import.meta.dir);

type Sent = { kind: "response" | "progress"; value: Record<string, unknown> };

function registry() {
  const sent: Sent[] = [];
  const ops = createOperationRegistry(
    (value) => sent.push({ kind: "response", value: { ...value } }),
    (value) => sent.push({ kind: "progress", value: { ...value } }),
    createSessionLog(),
  );
  return { ops, sent, progress: () => sent.filter((s) => s.kind === "progress").map((s) => s.value) };
}

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
});
