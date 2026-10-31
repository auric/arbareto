// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The read end of `src/git-service/read-scheduler.ts` with the real operation registry (data-model §7, contract §2 "one terminal response").
// A read end that the registry refuses, such as `failed` with SERVICE_UNAVAILABLE (contract §9), must still give one terminal response.

import { describe, expect, test } from "bun:test";
import type { Response } from "../../src/contracts/envelope";
import { createSessionLog } from "../../src/git-service/log";
import { createOperationRegistry } from "../../src/git-service/operations";
import { createReadScheduler, type ReadEnd } from "../../src/git-service/read-scheduler";
import { printOrigin } from "../origin";

for (const module of ["read-scheduler", "operations"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);

type Outcome = { code: "SERVICE_UNAVAILABLE" | "GIT_FAILED" };

// One review read whose outcome names `code`. `end` maps each scheduler end to a registry event, as `session.ts` `endRead` does.
function harness(options: { pipeFails?: boolean; endThrows?: boolean } = {}) {
  const responses: Response[] = [];
  const closed: string[] = [];
  const kinds: string[] = [];
  const registry = createOperationRegistry(
    (response) => {
      if (options.pipeFails) throw new Error("pipe write failed");
      responses.push(response);
    },
    () => {},
    createSessionLog(),
    { closeJob: () => {}, ended: () => {} },
  );
  const scheduler = createReadScheduler({ closeJob: (operationId) => void closed.push(operationId), cancel: () => {} });
  const start = (code: Outcome["code"]) => {
    const { operationId, signal } = registry.start("reviewWorkbench", crypto.randomUUID());
    registry.apply(operationId, { type: "valid-read" });
    scheduler.schedule<Outcome, null>({
      operationId,
      repositoryId: "r",
      signal,
      run: async () => ({ code }),
      failed: () => false,
      reread: async () => null,
      end: (end: ReadEnd<Outcome, null>) => {
        kinds.push(end.kind);
        if (options.endThrows) throw new Error("end failed");
        if (end.kind === "outcome") return void registry.apply(operationId, { type: "read-complete", result: "failed", code: end.outcome.code });
        if (end.kind === "failed") return void registry.apply(operationId, { type: "read-complete", result: "failed", code: "GIT_FAILED" });
      },
    });
    return operationId;
  };
  return { registry, responses, closed, kinds, start };
}

// Bounded wait for the asynchronous read end.
async function settle(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
}

describe("read end (data-model §7, contract §2 and §9)", () => {
  test("an end that does not fit its state still gives one terminal response: failed with GIT_FAILED", async () => {
    const h = harness();
    const operationId = h.start("SERVICE_UNAVAILABLE");
    await settle(() => h.responses.length > 0);
    expect(h.kinds).toEqual(["outcome", "failed"]);
    expect(h.responses.map(({ operationId: id, state, code }) => ({ id, state, code }))).toEqual([{ id: operationId, state: "failed", code: "GIT_FAILED" }]);
    expect(h.registry.get(operationId)?.state).toBe("failed");
    // A fitting end needs no fallback.
    const second = h.start("GIT_FAILED");
    await settle(() => h.responses.length > 1);
    expect(h.responses.map((r) => r.operationId)).toEqual([operationId, second]);
    expect(h.kinds).toEqual(["outcome", "failed", "outcome"]);
  });

  test("a fallback end that also throws closes the Job, and the next read still runs", async () => {
    const h = harness({ endThrows: true });
    const first = h.start("GIT_FAILED");
    await settle(() => h.closed.length > 0);
    expect({ kinds: h.kinds, closed: h.closed }).toEqual({ kinds: ["outcome", "failed"], closed: [first] });
    const second = h.start("GIT_FAILED");
    await settle(() => h.closed.length > 1);
    expect(h.closed).toEqual([first, second]);
  });

  test("a failed pipe write leaves the terminal state, and the scheduler closes the Job", async () => {
    const h = harness({ pipeFails: true });
    const operationId = h.start("GIT_FAILED");
    await settle(() => h.closed.length > 0);
    expect({ state: h.registry.get(operationId)?.state, closed: h.closed, responses: h.responses.length }).toEqual({ state: "failed", closed: [operationId], responses: 0 });
  });
});
