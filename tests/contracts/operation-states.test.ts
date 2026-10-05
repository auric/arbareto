// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { transition, workspaceTransition } from "../../src/contracts/outcome";

printOrigin("../../src/contracts/outcome.ts", import.meta.dir);

type Snapshot = Parameters<typeof transition>[0];
type Event = Parameters<typeof transition>[1];

const READ = "readComparison";
const COMMIT = "commit";
const HUNK = "applyHunk";
const SUBMODULES = "updateSubmodules";
const TERMINAL = ["succeeded", "limited", "failed", "canceled", "completed-with-effects", "failed-with-effects", "unknown", "rejected"];

const ROLLBACK = /roll[\s_-]?back|undo|revert/i;

// Constitution I: a result never reports cancellation, or any other outcome, as rollback.
function step(snapshot: Snapshot, event: Event) {
  const result = transition(snapshot, event);
  for (const text of [result.state, result.reason, result.cause, ...result.actions]) expect(String(text ?? "")).not.toMatch(ROLLBACK);
  return result;
}

function expectStep(snapshot: Snapshot, event: Event, expected: Record<string, unknown>, actions: string[] = []) {
  const result = step(snapshot, event);
  expect(result).toMatchObject(expected);
  expect(result.actions).toEqual(expect.arrayContaining(actions));
  expect(result.terminalResponse).toBe(TERMINAL.includes(result.state));
  return result;
}

function expectNoCode(result: { code?: unknown }) {
  expect(result.code ?? null).toBeNull();
}

describe("accepted", () => {
  test("a valid read starts running", () => {
    expectStep({ operation: READ, state: "accepted" }, { type: "valid-read" }, { state: "running" });
  });

  test("mutation exclusion unavailable rejects without queueing", () => {
    expectStep(
      { operation: COMMIT, state: "accepted" },
      { type: "exclusion-unavailable", code: "BUSY" },
      { state: "rejected", code: "BUSY" },
      ["no-queue", "start-no-process"],
    );
  });

  test.each([["STALE_REVIEW"], ["TRUST_REQUIRED"], ["TRUST_CHANGED"], ["STATE_UNKNOWN"], ["APPROVAL_EXPIRED"]])(
    "an invalid approval, trust, or state rejects with %s and starts no process",
    (code) => {
      expectStep({ operation: COMMIT, state: "accepted" }, { type: "invalid-approval", code }, { state: "rejected", code }, [
        "start-no-process",
      ]);
    },
  );

  test.each([[COMMIT], [HUNK], ["applyFile"], [SUBMODULES]])("%s starts running when the shell replies with the marker ID", (operation) => {
    const result = expectStep({ operation, state: "accepted" }, { type: "marker-recorded" }, { state: "running" });
    expectNoCode(result);
  });

  test("a mutation cannot enter running through the read row, and a read cannot through the marker row", () => {
    expect(() => step({ operation: COMMIT, state: "accepted" }, { type: "valid-read" })).toThrow();
    expect(() => step({ operation: READ, state: "accepted" }, { type: "marker-recorded" } as Event)).toThrow();
  });

  test.each([["BUSY"], ["RECOVERY_MARKER_FAILED"]])("a %s reply to started rejects, releases the exclusion, and starts no process", (code) => {
    expectStep({ operation: COMMIT, state: "accepted" }, { type: "marker-refused", code } as Event, { state: "rejected", code }, [
      "release-exclusion",
      "start-no-process",
    ]);
  });

  test("an accepted commit reaches succeeded through the table only", () => {
    const running = step({ operation: COMMIT, state: "accepted" }, { type: "marker-recorded" } as Event);
    const reconciling = step({ operation: COMMIT, ...running } as Snapshot, { type: "execution-ended", lingeringDescendants: 0 });
    expect(step({ operation: COMMIT, ...reconciling } as Snapshot, { type: "intended-effects-confirmed" }).state).toBe("succeeded");
  });
});

describe("running", () => {
  test("a cancellation request signals only owned processes", () => {
    for (const operation of [READ, COMMIT]) {
      expectStep({ operation, state: "running" }, { type: "cancel" }, { state: "cancel-requested" }, ["signal-owned-processes"]);
    }
  });

  test("a completed read ends succeeded without a code", () => {
    const result = expectStep({ operation: READ, state: "running" }, { type: "read-complete", result: "succeeded" }, { state: "succeeded" }, [
      "check-generation",
    ]);
    expectNoCode(result);
  });

  test.each([["OUTPUT_LIMIT"], ["OBJECT_MISSING"], ["WORKTREE_CHANGING"]])("a limited read carries %s", (code) => {
    expectStep(
      { operation: READ, state: "running" },
      { type: "read-complete", result: "limited", code },
      { state: "limited", code },
      ["check-generation"],
    );
  });

  test.each([["GIT_FAILED"], ["DEADLINE"], ["CANCELED"], [undefined]])("a limited read with code %j is refused", (code) => {
    expect(() => step({ operation: READ, state: "running" }, { type: "read-complete", result: "limited", code } as Event)).toThrow();
  });

  test("a failed read carries its failure code", () => {
    expectStep(
      { operation: READ, state: "running" },
      { type: "read-complete", result: "failed", code: "GIT_FAILED" },
      { state: "failed", code: "GIT_FAILED" },
      ["check-generation"],
    );
  });

  test("a finished or failed mutation enters reconciling and blocks mutations", () => {
    for (const operation of [COMMIT, HUNK, SUBMODULES]) {
      expectStep(
        { operation, state: "running" },
        { type: "execution-ended", lingeringDescendants: 0 },
        { state: "reconciling", lingeringDescendants: 0 },
        ["block-mutations"],
      );
    }
  });

  test("a read deadline closes the Job, refreshes state, and ends failed with DEADLINE", () => {
    expectStep(
      { operation: READ, state: "running" },
      { type: "read-deadline" },
      { state: "failed", code: "DEADLINE" },
      ["close-job", "refresh-state"],
    );
  });

  test("a declined submodule program confirmation ends canceled and resolves the marker", () => {
    expectStep(
      { operation: SUBMODULES, state: "running" },
      { type: "program-confirmation-declined" },
      { state: "canceled", code: "CANCELED" },
      ["start-no-process", "resolve-marker"],
    );
  });

  test.each([["STALE_REVIEW"], ["TRUST_CHANGED"]])("a changed re-check after program approval ends failed with %s", (code) => {
    expectStep(
      { operation: SUBMODULES, state: "running" },
      { type: "recheck-changed", code },
      { state: "failed", code },
      ["keep-token-consumed", "start-no-process", "resolve-marker"],
    );
  });

  test.each([[COMMIT], [SUBMODULES]])("%s stays running and sets stalled after 15 seconds without activity", (operation) => {
    const stalled = expectStep({ operation, state: "running" }, { type: "stall" }, { state: "running", stalled: true }, [
      "show-stall-notice",
    ]);
    expect(stalled.actions).not.toContain("close-job");
    expectStep({ operation, ...stalled }, { type: "activity" }, { state: "running", stalled: false });
  });

  test.each([["row-refused"], ["row-read-failed"], ["level-read-failed"]])(
    "submodule event %s keeps the operation running and starts no process for the row or its nested rows",
    (type) => {
      const result = expectStep({ operation: SUBMODULES, state: "running" }, { type, rowId: "row-1" } as Event, { state: "running", rowId: "row-1" }, [
        "start-no-process-for-row-and-nested",
      ]);
      expect(result.actions).not.toContain("start-no-later-process");
      expect(result.actions).not.toContain("close-job");
    },
  );

  test.each([["inactivity"], ["ceiling"]])("a submodule process %s deadline enters reconciling with DEADLINE", (reason) => {
    expectStep(
      { operation: SUBMODULES, state: "running" },
      { type: "update-process-deadline", reason },
      { state: "reconciling", cause: "DEADLINE", reason },
      ["close-job", "start-no-later-process"],
    );
  });

  test.each([[COMMIT], [HUNK], ["applyFile"]])("a %s step, preflight, or process deadline enters reconciling with cause DEADLINE", (operation) => {
    expectStep({ operation, state: "running" }, { type: "mutation-deadline" }, { state: "reconciling", cause: "DEADLINE" }, ["close-job"]);
  });
});

describe("deadline reconciliation classifies from observed state", () => {
  const afterDeadline = () => {
    const entered = step({ operation: COMMIT, state: "running" }, { type: "mutation-deadline" });
    return { operation: COMMIT, ...entered } as Snapshot;
  };

  test("no observed effects give failed with DEADLINE", () => {
    expectStep(afterDeadline(), { type: "no-effects", observed: "failed" }, { state: "failed", code: "DEADLINE" });
  });

  test("confirmed intended effects give succeeded", () => {
    expectStep(afterDeadline(), { type: "intended-effects-confirmed" }, { state: "succeeded" });
  });

  test("left effects give failed-with-effects", () => {
    expectStep(afterDeadline(), { type: "failed-with-effects" }, { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
  });
});

describe("cancel-requested", () => {
  test("a mutation enters reconciling when processes stop", () => {
    expectStep({ operation: COMMIT, state: "cancel-requested" }, { type: "processes-stopped" }, { state: "reconciling" });
  });

  test("a mutation enters reconciling when the deadline expires", () => {
    expectStep({ operation: COMMIT, state: "cancel-requested" }, { type: "cancel-deadline" }, { state: "reconciling" });
  });

  test("a canceled read refreshes relevant state and ends canceled", () => {
    expectStep(
      { operation: READ, state: "cancel-requested" },
      { type: "processes-stopped" },
      { state: "canceled", code: "CANCELED" },
      ["refresh-state"],
    );
  });

  test("a read deadline before the stop ends failed with DEADLINE", () => {
    expectStep(
      { operation: READ, state: "cancel-requested" },
      { type: "read-deadline" },
      { state: "failed", code: "DEADLINE" },
      ["close-job", "refresh-state"],
    );
  });
});

describe("reconciling", () => {
  const reconciling = (lingeringDescendants = 0): Snapshot => ({ operation: COMMIT, state: "reconciling", lingeringDescendants });

  test("confirmed intended effects give succeeded without a code", () => {
    expectNoCode(expectStep(reconciling(), { type: "intended-effects-confirmed" }, { state: "succeeded" }));
  });

  test("confirmed intended effects after a late cancellation give succeeded", () => {
    const canceled = step({ operation: COMMIT, state: "running" }, { type: "cancel" });
    const stopped = step({ operation: COMMIT, ...canceled } as Snapshot, { type: "processes-stopped" });
    expect(stopped.state).toBe("reconciling");
    expectNoCode(expectStep({ operation: COMMIT, ...stopped } as Snapshot, { type: "intended-effects-confirmed" }, { state: "succeeded" }));
  });

  test("no confirmed effects give canceled with CANCELED", () => {
    expectStep(reconciling(), { type: "no-effects", observed: "canceled" }, { state: "canceled", code: "CANCELED" });
  });

  test("no confirmed effects give failed with the observed code", () => {
    expectStep(reconciling(), { type: "no-effects", observed: "failed", code: "HOOK_FAILED" }, { state: "failed", code: "HOOK_FAILED" });
  });

  test("differing effects give completed-with-effects", () => {
    expectStep(
      reconciling(),
      { type: "differing-effects" },
      { state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" },
      ["preserve-draft", "require-fresh-review"],
    );
  });

  test("a refused submodule row alone gives completed-with-effects", () => {
    expectStep(
      { operation: SUBMODULES, state: "reconciling", lingeringDescendants: 0 },
      { type: "differing-effects" },
      { state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" },
    );
  });

  test("left effects after failure give failed-with-effects and preserve the draft", () => {
    expectStep(reconciling(), { type: "failed-with-effects" }, { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" }, ["preserve-draft"]);
  });

  test.each([["ambiguous"], ["evidence-limit"], ["no-retained-request"]])(
    "undetermined attribution gives unknown with STATE_UNKNOWN and reason %s",
    (reason) => {
      expectStep(
        reconciling(),
        { type: "attribution-undetermined", reason },
        { state: "unknown", code: "STATE_UNKNOWN", reason },
        ["block-mutations", "keep-marker"],
      );
    },
  );

  test("a cancellation keeps reconciling, sets endProcesses, and zeroes lingeringDescendants", () => {
    const result = expectStep(
      reconciling(2),
      { type: "cancel" },
      { state: "reconciling", endProcesses: true, lingeringDescendants: 0 },
      ["continue-reconciliation-reads"],
    );
    expect(result.actions).not.toContain("signal-owned-processes");
    const outcome = step({ operation: COMMIT, ...result } as Snapshot, { type: "intended-effects-confirmed" });
    expect(outcome).toMatchObject({ state: "succeeded", lingeringDescendants: 0 });
  });

  test("a reconciliation read deadline gives unknown and keeps the marker", () => {
    expectStep(
      reconciling(),
      { type: "reconciliation-read-deadline" },
      { state: "unknown", code: "STATE_UNKNOWN" },
      ["close-job", "block-mutations", "keep-marker"],
    );
  });

  test("interrupt and close sends no terminal response and keeps the marker", () => {
    const result = step(reconciling(), { type: "interrupt-and-close" });
    expect(result.terminalResponse).toBe(false);
    expect(result.actions).toEqual(expect.arrayContaining(["close-job", "keep-marker", "follow-application-close"]));
  });
});

describe("lingeringDescendants", () => {
  const outcomes: Array<[string, Event]> = [
    ["succeeded", { type: "intended-effects-confirmed" }],
    ["canceled", { type: "no-effects", observed: "canceled" }],
    ["failed", { type: "no-effects", observed: "failed", code: "GIT_FAILED" }],
    ["completed-with-effects", { type: "differing-effects" }],
    ["failed-with-effects", { type: "failed-with-effects" }],
    ["unknown", { type: "attribution-undetermined", reason: "ambiguous" }],
  ];

  for (const [state, event] of outcomes) {
    test(`a ${state} mutation outcome carries a non-negative integer count`, () => {
      for (const count of [0, 1, 3]) {
        const entered = step({ operation: COMMIT, state: "running" }, { type: "execution-ended", lingeringDescendants: count });
        const outcome = step({ operation: COMMIT, ...entered } as Snapshot, event);
        expect(outcome.state).toBe(state);
        expect(Number.isSafeInteger(outcome.lingeringDescendants)).toBe(true);
        expect(outcome.lingeringDescendants).toBe(count);
      }
    });
  }

  test("a count of 1 keeps succeeded", () => {
    const entered = step({ operation: COMMIT, state: "running" }, { type: "execution-ended", lingeringDescendants: 1 });
    expect(step({ operation: COMMIT, ...entered } as Snapshot, { type: "intended-effects-confirmed" })).toMatchObject({
      state: "succeeded",
      lingeringDescendants: 1,
    });
  });

  test("a canceled mutation never reports a rollback in any outcome", () => {
    const canceled = step({ operation: COMMIT, state: "running" }, { type: "cancel" });
    const stopped = step({ operation: COMMIT, ...canceled } as Snapshot, { type: "processes-stopped", lingeringDescendants: 0 });
    for (const [, event] of outcomes) step({ operation: COMMIT, ...stopped } as Snapshot, event);
  });

  test.each([[-1], [1.5], [Number.NaN]])("a count of %p is refused", (count) => {
    expect(() => step({ operation: COMMIT, state: "running" }, { type: "execution-ended", lingeringDescendants: count })).toThrow();
  });
});

describe("revokeTrust", () => {
  test("a terminal mutation with a lingering Job closes it and reports the ended count", () => {
    const result = step(
      { operation: COMMIT, state: "succeeded", lingering: true, lingeringDescendants: 2 } as Snapshot,
      { type: "revoke-trust", endedProcesses: 2 },
    );
    expect(result).toMatchObject({ state: "succeeded", endedProcesses: 2 });
    expect(result.actions).toContain("close-lingering-job");
  });

  const toReconciling: Record<string, Event | null> = {
    running: { type: "execution-ended", lingeringDescendants: 2 },
    "cancel-requested": { type: "processes-stopped" },
    reconciling: null,
  };

  test.each([["running"], ["cancel-requested"], ["reconciling"]])(
    "during %s it cancels nothing, sets endProcesses, and the outcome has lingeringDescendants 0",
    (state) => {
      const result = step({ operation: COMMIT, state, lingeringDescendants: 2 } as Snapshot, { type: "revoke-trust" });
      expect(result).toMatchObject({ state, endProcesses: true });
      expect(result.actions).not.toContain("signal-owned-processes");
      expect(result.actions).not.toContain("close-job");
      const enter = toReconciling[state];
      const entered = enter ? step({ operation: COMMIT, ...result } as Snapshot, enter) : result;
      expect(entered.state).toBe("reconciling");
      const outcome = step({ operation: COMMIT, ...entered } as Snapshot, { type: "intended-effects-confirmed" });
      expect(outcome).toMatchObject({ state: "succeeded", lingeringDescendants: 0 });
    },
  );
});

describe("workspace recovery", () => {
  test("a recovery refresh that completes reconciliation makes the workspace ready", () => {
    const result = workspaceTransition("unknown", {
      type: "read",
      refresh: true,
      observation: "complete",
      priorOutcome: { state: "succeeded" },
    });
    expect(result).toMatchObject({ state: "ready", priorOutcome: { state: "succeeded" } });
    expect(result.actions).toEqual(expect.arrayContaining(["resolve-marker", "invalidate-prior-tokens"]));
  });

  test("a completed recovery refresh makes the workspace ready also when attribution stays unknown", () => {
    const priorOutcome = { state: "unknown", reason: "ambiguous" };
    const result = workspaceTransition("unknown", { type: "read", refresh: true, observation: "complete", priorOutcome });
    expect(result).toMatchObject({ state: "ready", priorOutcome });
    expect(result.actions).toContain("invalidate-prior-tokens");
  });

  test.each([["failed"], ["limited"]])("a %s observation during the recovery refresh keeps the workspace unknown", (observation) => {
    const result = workspaceTransition("unknown", { type: "read", refresh: true, observation });
    expect(result.state).toBe("unknown");
    expect(result.actions).toContain("keep-marker");
    expect(result.actions).not.toContain("resolve-marker");
  });

  test("a status-only success keeps the workspace unknown", () => {
    const result = workspaceTransition("unknown", { type: "read", refresh: false, observation: "complete" });
    expect(result.state).toBe("unknown");
    expect(result.actions).not.toContain("resolve-marker");
  });

  test("registration that matches a marker without a retained request starts unknown with no-retained-request", () => {
    const result = workspaceTransition("none", { type: "registration", marker: true, retainedRequest: false, restarted: false });
    expect(result).toMatchObject({ state: "unknown", reason: "no-retained-request" });
  });

  test("registration after Restart service starts unknown, and only a refresh read releases it", () => {
    const registered = workspaceTransition("none", { type: "registration", marker: false, retainedRequest: false, restarted: true });
    expect(registered.state).toBe("unknown");
    expect(workspaceTransition("unknown", { type: "read", refresh: false, observation: "complete" }).state).toBe("unknown");
    const released = workspaceTransition("unknown", { type: "read", refresh: true, observation: "complete" });
    expect(released).toMatchObject({ state: "ready", priorOutcome: null });
  });
});
