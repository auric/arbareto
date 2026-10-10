// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T230: the pure row and outcome classification of `updateSubmodules` (contract §12 "Reconciliation and outcome", data-model §9 "Row result").
// `classifyUpdate` in `src/git-service/reconcile.ts` comes with T230. Before it, each case fails with "classifyUpdate is not a function".

import { describe, expect, test } from "bun:test";
import type { OperationEvent } from "../../src/contracts/outcome";
import { SubmoduleRowResult, type SubmoduleFailedRead } from "../../src/contracts/submodules";
import { underTest } from "./hunk-harness";
import { TEXTS } from "./submodule-harness";

type RowRemedy = { command: string | null; text?: string };

// The `submodule.<name>.*` keys of the parent configuration of one row, with their values in Git's order.
type RowKeys = Record<string, readonly string[]>;

interface UpdatePhase {
  // A fetch step of the row started.
  fetched: boolean;
  // A clone step, a connect step, or the checkout step of a `reuse` row started.
  connected: boolean;
  // A refusal during the run (contract §12 "Refusals during the run").
  refusal?: { reason: NonNullable<SubmoduleRowResult["reason"]>; text: string; remedy?: RowRemedy };
  // A run read failed (contract §12 "Update protocol", read failures).
  failedRead?: SubmoduleFailedRead;
  // The last step of the row exited non-zero. A connect step exit that step 5 expects is not recorded.
  // `firstFetch`: the step is the first fetch. It counts as exit 0 when the row then reaches its target.
  failedStep?: { firstFetch: boolean; outputTail: string; remedy: RowRemedy };
}

interface RowObservation {
  // The submodule HEAD commit. Null: no HEAD commit.
  head: string | null;
  // A `.git` entry exists in the submodule folder.
  gitEntry: boolean;
  // `show-ref --exists` exited 0. False: it exited 2. Read only when `gitEntry` is true.
  refs: boolean;
  keys: RowKeys;
}

interface UpdateRowFacts {
  rowId: string;
  // The display path, relative to the superproject worktree.
  path: string;
  // The review did not list the row.
  found: boolean;
  // The planned state of the row action, a noted registration included.
  planned: "cloned" | "moved" | "unchanged";
  // The HEAD commit at the review, or null.
  oldCommit: string | null;
  // The recorded commit of the row, or null.
  target: string | null;
  // The preflight keys, or the keys of the step 6 level read.
  baseline: RowKeys;
  phase: UpdatePhase;
  // The reconciliation read of the row: a value, a failure with its code, or a deadline stop.
  observed: { value: RowObservation } | { code: string } | { stop: "deadline" };
}

interface UpdateFacts {
  rows: UpdateRowFacts[];
  // A Cancel or a process deadline stopped the run. Null: neither.
  stop: "canceled" | "deadline" | null;
}

type ClassifyUpdate = (facts: UpdateFacts) => { event: OperationEvent; rows: SubmoduleRowResult[] };

async function classify(facts: UpdateFacts): Promise<{ event: OperationEvent; rows: SubmoduleRowResult[] }> {
  const { classifyUpdate } = (await underTest("reconcile")) as { classifyUpdate: ClassifyUpdate };
  const result = classifyUpdate(facts);
  for (const row of result.rows) expect({ path: row.path, parsed: SubmoduleRowResult.safeParse(row).success }).toEqual({ path: row.path, parsed: true });
  return result;
}

const OLD = "1".repeat(40);
const TARGET = "2".repeat(40);
const OTHER = "3".repeat(40);
const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const KEYS: RowKeys = { "submodule.solo.active": ["true"], "submodule.solo.url": ["C:/fixture/solo.git"] };
const TAIL = "fatal: clone of 'C:/fixture/solo.git' into submodule path 'solo' failed\n";
const CLONE_REMEDY: RowRemedy = { command: "& 'C:/git.exe' --no-lazy-fetch -C 'C:/super' submodule update --init -- ':(literal)solo'", text: "clone" };
const PROGRAMS = { reason: "programs" as const, text: TEXTS.programs("solo") };

const idle: UpdatePhase = { fetched: false, connected: false };
const seen = (head: string | null, keys: RowKeys = KEYS, gitEntry = head !== null, refs = head !== null) => ({ value: { head, gitEntry, refs, keys } });

// A registered `moved` row by default: HEAD moves from OLD to TARGET.
function row(fields: Partial<UpdateRowFacts> = {}): UpdateRowFacts {
  return { rowId: ID, path: "solo", found: false, planned: "moved", oldCommit: OLD, target: TARGET, baseline: KEYS, phase: idle, observed: seen(TARGET), ...fields };
}

const result = (fields: Partial<SubmoduleRowResult>): SubmoduleRowResult => ({ rowId: ID, path: "solo", state: "moved", oldCommit: OLD, newCommit: TARGET, fetched: false, connected: false, found: false, registered: false, ...fields });

describe("row states (contract §12 \"Reconciliation and outcome\", first match wins)", () => {
  test("a refusal during the run gives refused with its reason, text, and remedy, before a failed step", async () => {
    const remedy = { command: null, text: "save" };
    const { rows } = await classify({ rows: [row({ observed: seen(OLD), phase: { ...idle, fetched: true, refusal: { ...PROGRAMS, remedy }, failedStep: { firstFetch: true, outputTail: TAIL, remedy: CLONE_REMEDY } } })], stop: null });
    expect(rows).toEqual([result({ state: "refused", newCommit: OLD, fetched: true, ...PROGRAMS, remedy })]);
  });

  test("a refusal without a remedy gives refused without a remedy", async () => {
    const { rows } = await classify({ rows: [row({ observed: seen(OLD), phase: { ...idle, refusal: PROGRAMS } })], stop: null });
    expect(rows).toEqual([result({ state: "refused", newCommit: OLD, ...PROGRAMS })]);
  });

  test("a failed run read gives failed with the read name and no remedy or output, before a failed step", async () => {
    const { rows } = await classify({ rows: [row({ observed: seen(OLD), phase: { ...idle, failedRead: "check", failedStep: { firstFetch: false, outputTail: TAIL, remedy: CLONE_REMEDY } } })], stop: null });
    expect(rows).toEqual([result({ state: "failed", newCommit: OLD, failedRead: "check" })]);
  });

  test("a failed step gives failed with its outputTail and remedy, also when HEAD reached the target", async () => {
    const { rows } = await classify({ rows: [row({ phase: { ...idle, failedStep: { firstFetch: false, outputTail: TAIL, remedy: CLONE_REMEDY } } })], stop: null });
    expect(rows).toEqual([result({ state: "failed", outputTail: TAIL, remedy: CLONE_REMEDY })]);
  });

  test("a failed first fetch of a row that reaches its target gives moved", async () => {
    const { rows, event } = await classify({ rows: [row({ phase: { ...idle, fetched: true, failedStep: { firstFetch: true, outputTail: TAIL, remedy: CLONE_REMEDY } } })], stop: null });
    expect({ rows, event }).toEqual({ rows: [result({ fetched: true })], event: { type: "intended-effects-confirmed" } });
  });

  test("a failed first fetch of a row that misses its target gives failed", async () => {
    const { rows } = await classify({ rows: [row({ observed: seen(OLD), phase: { ...idle, fetched: true, failedStep: { firstFetch: true, outputTail: TAIL, remedy: CLONE_REMEDY } } })], stop: null });
    expect(rows).toEqual([result({ state: "failed", newCommit: OLD, fetched: true, outputTail: TAIL, remedy: CLONE_REMEDY })]);
  });

  test("a .git entry whose show-ref --exists exits 2 gives clone-interrupted with its folder path and text", async () => {
    const { rows } = await classify({ rows: [row({ planned: "cloned", oldCommit: null, phase: { ...idle, connected: true }, observed: seen(null, KEYS, true, false) })], stop: "canceled" });
    expect(rows).toEqual([result({ state: "clone-interrupted", oldCommit: null, newCommit: null, connected: true, folderPath: "solo", text: TEXTS.cloneInterrupted("solo") })]);
  });

  test("HEAD at the target without an old commit gives cloned", async () => {
    const { rows } = await classify({ rows: [row({ planned: "cloned", oldCommit: null, phase: { ...idle, connected: true } })], stop: null });
    expect(rows).toEqual([result({ state: "cloned", oldCommit: null, connected: true })]);
  });

  test("HEAD at the target, which differs from the old commit, gives moved with both commits", async () => {
    const { rows } = await classify({ rows: [row()], stop: null });
    expect(rows).toEqual([result({ state: "moved" })]);
  });

  test("HEAD at the old commit gives unchanged", async () => {
    const { rows } = await classify({ rows: [row({ planned: "unchanged", observed: seen(OLD) })], stop: null });
    expect(rows).toEqual([result({ state: "unchanged", newCommit: OLD })]);
  });

  test("no HEAD before and after gives unchanged", async () => {
    const { rows } = await classify({ rows: [row({ planned: "unchanged", oldCommit: null, baseline: {}, observed: seen(null, {}) })], stop: null });
    expect(rows).toEqual([result({ state: "unchanged", oldCommit: null, newCommit: null })]);
  });

  test("HEAD at neither the old nor the target commit gives changed-elsewhere", async () => {
    const { rows } = await classify({ rows: [row({ observed: seen(OTHER) })], stop: null });
    expect(rows).toEqual([result({ state: "changed-elsewhere", newCommit: OTHER })]);
  });
});

describe("row flags (contract §12 \"Reconciliation and outcome\")", () => {
  test("fetched, connected, and found come from the phase record and the review", async () => {
    const { rows } = await classify({ rows: [row({ found: true, phase: { ...idle, fetched: true, connected: true } })], stop: null });
    expect(rows).toEqual([result({ found: true, fetched: true, connected: true })]);
  });

  for (const [label, baseline, keys, registered] of [
    ["a key absent at the baseline and present at reconciliation", {}, KEYS, true],
    ["a key present at the baseline and absent at reconciliation", KEYS, {}, true],
    ["a changed value", KEYS, { ...KEYS, "submodule.solo.url": ["C:/other/solo.git"] }, true],
    ["equal keys", KEYS, KEYS, false],
  ] as const) {
    test(`registered: ${label} gives ${registered}`, async () => {
      const { rows } = await classify({ rows: [row({ baseline, observed: seen(TARGET, keys) })], stop: null });
      expect(rows.map((x) => x.registered)).toEqual([registered]);
    });
  }
});

describe("operation outcome (contract §12 \"Reconciliation and outcome\", first match wins)", () => {
  const cancelable = () => row({ planned: "cloned", oldCommit: null, observed: seen(null, KEYS) });

  test("a failed reconciliation read gives reconciliation-read-failed with its code, also after a Cancel", async () => {
    const { event } = await classify({ rows: [row(), row({ rowId: ID2, path: "mid", observed: { code: "GIT_FAILED" } })], stop: "canceled" });
    expect(event).toEqual({ type: "reconciliation-read-failed", code: "GIT_FAILED" });
  });

  test("a reconciliation read past its deadline gives reconciliation-read-deadline", async () => {
    const { event } = await classify({ rows: [row(), row({ rowId: ID2, path: "mid", observed: { stop: "deadline" } })], stop: null });
    expect(event).toEqual({ type: "reconciliation-read-deadline" });
  });

  test("a Cancel without an effect gives canceled", async () => {
    const { event } = await classify({ rows: [cancelable()], stop: "canceled" });
    expect(event).toEqual({ type: "no-effects", observed: "canceled" });
  });

  for (const [label, rows, stop] of [
    ["a Cancel after a fetch", [row({ planned: "moved", observed: seen(OLD), phase: { ...idle, fetched: true } })], "canceled"],
    ["a Cancel after a connect step", [cancelable(), row({ rowId: ID2, path: "mid", planned: "cloned", oldCommit: null, observed: seen(null), phase: { ...idle, connected: true } })], "canceled"],
    ["a deadline after a moved row", [row(), row({ rowId: ID2, path: "mid", planned: "moved", observed: seen(OLD) })], "deadline"],
    ["a failed row beside a moved row", [row(), row({ rowId: ID2, path: "mid", observed: seen(OLD), phase: { ...idle, failedStep: { firstFetch: false, outputTail: TAIL, remedy: CLONE_REMEDY } } })], null],
    ["a failed read beside a cloned row", [row({ planned: "cloned", oldCommit: null }), row({ rowId: ID2, path: "mid", observed: seen(OLD), phase: { ...idle, failedRead: "level" } })], null],
  ] as const) {
    test(`${label} gives failed-with-effects`, async () => {
      const { event } = await classify({ rows: [...rows], stop });
      expect(event).toEqual({ type: "failed-with-effects" });
    });
  }

  // research.md R14 S37: a failed clone step registers the row and leaves no `.git` entry.
  test("a failed clone of an unregistered row registers it, so the outcome is failed-with-effects", async () => {
    const { event, rows } = await classify({
      rows: [row({ planned: "cloned", oldCommit: null, baseline: {}, observed: seen(null, KEYS), phase: { ...idle, connected: true, failedStep: { firstFetch: false, outputTail: TAIL, remedy: CLONE_REMEDY } } })],
      stop: null,
    });
    expect({ event, rows }).toEqual({
      event: { type: "failed-with-effects" },
      rows: [result({ state: "failed", oldCommit: null, newCommit: null, connected: true, registered: true, outputTail: TAIL, remedy: CLONE_REMEDY })],
    });
  });

  // research.md R14 S38: an unmapped entry with a refused `update` value fails every `submodule` step before a write.
  // Contract §12 "Refusals": the started clone step still sets `connected`, which is an effect.
  const failed = { ...idle, failedStep: { firstFetch: false, outputTail: TAIL, remedy: CLONE_REMEDY } };
  const register = row({ rowId: ID2, path: "mid", planned: "unchanged", oldCommit: null, observed: seen(null), phase: failed });
  test("a failed clone step and a failed register step without a key give failed-with-effects", async () => {
    const { event } = await classify({ rows: [row({ planned: "cloned", oldCommit: null, baseline: {}, observed: seen(null, {}), phase: { ...failed, connected: true } }), register], stop: null });
    expect(event).toEqual({ type: "failed-with-effects" });
  });

  test("failed rows without an effect give failed with GIT_FAILED", async () => {
    const { event } = await classify({ rows: [register], stop: null });
    expect(event).toEqual({ type: "no-effects", observed: "failed", code: "GIT_FAILED" });
  });

  test("a refused row after a failed first fetch counts as a failed process, so the outcome is failed-with-effects, not completed-with-effects", async () => {
    const { event } = await classify({ rows: [row({ observed: seen(OLD), phase: { ...idle, fetched: true, refusal: PROGRAMS, failedStep: { firstFetch: true, outputTail: TAIL, remedy: CLONE_REMEDY } } })], stop: null });
    expect(event).toEqual({ type: "failed-with-effects" });
  });

  test("a deadline without an effect gives failed without a code, so the recorded DEADLINE cause stays", async () => {
    const { event } = await classify({ rows: [cancelable()], stop: "deadline" });
    expect(event).toEqual({ type: "no-effects", observed: "failed" });
  });

  test("every row at its planned state gives succeeded, also with effects", async () => {
    const { event } = await classify({ rows: [row({ phase: { ...idle, fetched: true } }), row({ rowId: ID2, path: "mid", planned: "cloned", oldCommit: null, baseline: {}, phase: { ...idle, connected: true } })], stop: null });
    expect(event).toEqual({ type: "intended-effects-confirmed" });
  });

  test("a registration that the plan notes is part of the planned state", async () => {
    const { event, rows } = await classify({ rows: [row({ planned: "unchanged", oldCommit: null, target: TARGET, baseline: {}, observed: seen(null, KEYS) })], stop: null });
    expect({ event, registered: rows[0]!.registered }).toEqual({ event: { type: "intended-effects-confirmed" }, registered: true });
  });

  test("a refused row without a change or a flag gives completed-with-effects", async () => {
    const { event } = await classify({ rows: [row({ observed: seen(OLD), phase: { ...idle, refusal: PROGRAMS } })], stop: null });
    expect(event).toEqual({ type: "differing-effects" });
  });

  test("a row that differs from its plan gives completed-with-effects", async () => {
    const { event } = await classify({ rows: [row({ observed: seen(OTHER) })], stop: null });
    expect(event).toEqual({ type: "differing-effects" });
  });
});
