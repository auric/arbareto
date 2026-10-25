// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T022: `openHistory`, `loadHistory`, `readHistoryRows`, and `closeHistory` through the in-process service (plan.md P3, D2, D3; contract Δ3, Δ5).
// Spec FR-001, FR-003, FR-004, FR-009, FR-010, FR-011, FR-014, FR-017, FR-018, FR-054, SC-001, SC-003, SC-004, SC-013.

import { describe, expect, spyOn } from "bun:test";
import { join } from "node:path";
import { HISTORY_BODY_BYTES } from "../../src/contracts/envelope";
import { HISTORY_COMMIT_OBJECT_BYTES, HISTORY_LOAD_MARGIN, HISTORY_PAGE_BYTES, HISTORY_PROGRESS_EVENTS_PER_SECOND } from "../../src/contracts/limits";
import { headTargetArgs, historyRefsArgs, topologyPathArgs } from "../../src/git-service/commands";
import { HistoryTopology } from "../../src/git-service/history-topology";
import { printOrigin } from "../origin";
import type { RecordedCall } from "./bun-runner";
import { FIXTURE_ROOT, fixtureDir, useFixtureRoot } from "./fixture-root";
import { fiCommit } from "./fixtures";
import { buildSmallFixtures, H200K, LONG_BODY_WORD, largeCase, repositoryDigest, shallowCommits, startPoints, type SmallName } from "./history-fixtures";
import { allRows, commitGraphFiles, copyLarge, fold, git, gitPath, gitText, isLoad, isReplaceRead, isTextRead, load, loadSteps, opened, openView, oracle, rows, waitFor } from "./history-view-harness";
import { caseTest, openService, siblingDeadline, type Service } from "./service-harness";

printOrigin("../../src/git-service/history-view.ts", import.meta.dir);
printOrigin("../../src/git-service/history-topology.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);

const TASK = "T022";
// The batch 2 verification records of research.md R13.
const T030 = "T030";
const SHELL = ["shell-double"] as const;
const TIMEOUT_MS = 300_000;
const LARGE_TIMEOUT_MS = 20 * 60_000;
// A `siblingDeadline` case that never releases its target ends here, not at the read timeout.
const SIBLING_TIMEOUT_MS = 120_000;
// Contract Δ3 `loadHistory`: S = max(n + 1 + 2·M, 2·L₀).
const M = HISTORY_LOAD_MARGIN;
const FIRST_STOP = 40 + 1 + 2 * M;

useFixtureRoot();

async function withService(name: string, body: (service: Service) => Promise<void>, options: { historyViewCommits?: number } = {}): Promise<void> {
  const service = await openService({ git: gitPath(), name, watchHints: false, ...options });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

// SC-013: the repository bytes stay equal, and no commit-graph file appears.
async function unchanged(repo: string, body: () => Promise<void>): Promise<void> {
  const before = repositoryDigest(repo);
  const graphs = commitGraphFiles(repo);
  await body();
  expect(repositoryDigest(repo)).toBe(before);
  expect(commitGraphFiles(repo)).toEqual(graphs);
}

const small = (folder: string, name: SmallName) => buildSmallFixtures(gitPath(), folder, [name])[0]!;

// One line of `count` commits with rising dates.
function chainRepo(name: string, count: number): string {
  const repo = fixtureDir(`${name}/repo`);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["fast-import", "--quiet"], { input: Buffer.concat(Array.from({ length: count }, (_, i) => fiCommit({ mark: i + 1, time: 1_767_225_600 + i, message: `c${i + 1}\n`, from: i === 0 ? undefined : i }))) });
  git(repo, ["reset", "-q", "--hard"]);
  return repo;
}

describe("H200K (SC-001, SC-003, SC-004, FR-054, plan.md D2)", () => {
  largeCase(
    TASK,
    "H200K: the D2 stop rule loads 2,089, then 4,178, then 52,049 rows with one argv and no remaining process; an unreachable OID loads to the end",
    H200K,
    () =>
      withService("t022-steps", async (service) => {
        const repo = copyLarge(H200K, false, "t022-steps-repo");
        const expected = oracle(repo);
        const dangling = gitText(repo, ["commit-tree", "-m", "dangling", gitText(repo, ["rev-parse", "HEAD^{tree}"]).trim()]).trim();
        await unchanged(repo, async () => {
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          const first = await load(service, repositoryId, view.viewId, { row: 40 });
          expect({ state: first.state, result: first.result }).toEqual({ state: "succeeded", result: { rows: FIRST_STOP, complete: false } });
          // No process of the load remains after its result.
          expect(service.runner.liveRecorded()).toBe(0);
          const before = await rows(service, repositoryId, view.viewId, { row: 100 }, 64, "rows");
          const second = await load(service, repositoryId, view.viewId, { row: 1065 });
          expect(second.result).toEqual({ rows: 2 * FIRST_STOP, complete: false });
          const loads = service.runner.calls.filter(isLoad);
          expect(loads.length).toBe(2);
          expect(loads[1]!.arguments).toEqual(loads[0]!.arguments);
          expect(Buffer.from(loads[1]!.input ?? []).equals(Buffer.from(loads[0]!.input ?? []))).toBe(true);
          expect(loads[0]!.arguments.some((a) => a.startsWith("--skip") || a.startsWith("--max-count"))).toBe(false);
          // SC-003: no row changes position across reads. FR-011: a reread gives the same commit, text, and cell.
          expect((await rows(service, repositoryId, view.viewId, { row: 100 }, 64, "rows")).result).toEqual({ ...before.result!, rowCount: 2 * FIRST_STOP, lanes: expect.any(Number), bytes: expect.any(Number) });
          const third = await load(service, repositoryId, view.viewId, { oid: expected[50_000]!.oid });
          expect(third.result).toEqual({ rows: 50_000 + 1 + 2 * M, complete: false });
          const at = await rows(service, repositoryId, view.viewId, { oid: expected[50_000]!.oid }, 1);
          expect(at.result!.rows!.map((r) => r.index)).toEqual([50_000]);
          const fourth = await load(service, repositoryId, view.viewId, { oid: dangling });
          expect(fourth.result).toEqual({ rows: expected.length, complete: true });
          expect((await rows(service, repositoryId, view.viewId, { oid: dangling }, 1)).result).toMatchObject({ target: "none", complete: true });
          expect(service.runner.liveRecorded()).toBe(0);
          const held = await allRows(service, repositoryId, view.viewId, expected.length);
          expect(held.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(expected);
        });
      }),
    LARGE_TIMEOUT_MS,
  );

  largeCase(
    TASK,
    "H200K: scroll loads until complete equal one uninterrupted rev-list run, the commit set equals git log, every cell equals the fold, and End loads to the end",
    H200K,
    () =>
      withService("t022-full", async (service) => {
        const repo = copyLarge(H200K, false, "t022-full-repo");
        const expected = oracle(repo);
        // A missing `refs/stash` is no revision for `git log`, so the oracle names it only when it exists.
        const stash = git(repo, ["rev-parse", "--verify", "-q", "refs/stash"], { allowExit: [0, 1] }).length > 0 ? ["refs/stash"] : [];
        const logged = gitText(repo, ["--no-optional-locks", "log", "--format=%H", "--branches", "--remotes", "--tags", ...stash, "HEAD"]).split("\n").filter((l) => l !== "");
        await unchanged(repo, async () => {
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          expect(view.startCount).toBe(startPoints(gitPath(), FIXTURE_ROOT, repo).length);
          const steps = await loadSteps(service, repositoryId, view.viewId);
          // FR-010: `complete` and the final count.
          expect(steps.at(-1)!.result).toEqual({ rows: expected.length, complete: true });
          expect(steps.slice(0, -1).every((s) => s.state === "succeeded" && !s.result!.complete)).toBe(true);
          const held = await allRows(service, repositoryId, view.viewId, expected.length);
          expect(held.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(expected);
          expect(new Set(held.map((r) => r.oid))).toEqual(new Set(logged));
          // SC-004: each cell equals the T009 fold.
          const cells = fold(expected, shallowCommits(gitPath(), FIXTURE_ROOT, repo));
          const wrong = held.filter((r, i) => !Bun.deepEquals(r.cell, cells[i], true)).map((r) => r.index);
          expect(wrong).toEqual([]);
          expect(held.map((r) => r.index)).toEqual(expected.map((_, i) => i));
          // FR-010: a load of a complete view starts no Git process.
          const calls = service.runner.calls.length;
          expect((await load(service, repositoryId, view.viewId, { row: 0 })).result).toEqual({ rows: expected.length, complete: true });
          expect(service.runner.calls.length).toBe(calls);

          // End: a new view loads to the end in one step. It releases the old view.
          const end = await opened(service, repositoryId, generation);
          expect((await load(service, repositoryId, view.viewId, { row: 0 })).code).toBe("UNKNOWN_TARGET");
          // T030 records (research.md R13): the CPU of an End load, and the typed-array bytes of the view topology, measured as T012 measures them (R18).
          let topology: HistoryTopology | null = null;
          const beginStep = HistoryTopology.prototype.beginStep;
          const spy = spyOn(HistoryTopology.prototype, "beginStep").mockImplementation(function (this: HistoryTopology) {
            topology = this;
            beginStep.call(this);
          });
          const firstCall = service.runner.calls.length;
          const cpu = process.cpuUsage();
          const started = performance.now();
          let all: Awaited<ReturnType<typeof load>>;
          try {
            all = await load(service, repositoryId, end.viewId, { end: true });
          } finally {
            spy.mockRestore();
          }
          const wallMs = performance.now() - started;
          const own = process.cpuUsage(cpu);
          expect(all.result).toEqual({ rows: expected.length, complete: true });
          const gitCalls = service.runner.calls.slice(firstCall).filter((c) => c.operationId === all.operationId);
          const gitMs = gitCalls.reduce((sum, c) => sum + (c.cpuMicros ?? 0), 0) / 1000;
          console.log(
            `OBSERVATION ${T030}: H200K without a commit-graph: an End load of ${expected.length} rows took ${wallMs.toFixed(1)} ms wall; CPU ${((own.user + own.system) / 1000).toFixed(1)} ms in the service process (the test process, in-process service) and ${gitMs.toFixed(1)} ms in ${gitCalls.length} Git processes (experiment)`,
          );
          const table = topology as HistoryTopology | null;
          expect(table?.rows).toBe(expected.length);
          const bytes = Object.values(table!).reduce((sum: number, v) => sum + (ArrayBuffer.isView(v) ? v.byteLength : 0), 0);
          console.log(`OBSERVATION ${T030}: H200K: after the End load, the view topology holds ${bytes} bytes of typed arrays for ${table!.rows} rows, ${(bytes / table!.rows).toFixed(1)} bytes per loaded commit (SHA-1, allocated capacity; lane checkpoints are JS objects and not counted) (experiment)`);
          // Contract Δ3 and Δ5: phase `history-load` sends at most HISTORY_PROGRESS_EVENTS_PER_SECOND events. Each event follows the one before it by at least 1000 / HISTORY_PROGRESS_EVENTS_PER_SECOND ms of the same clock, inside the measured wall time.
          const events = (service.progress as { operationId: string; phase?: string; counters: { rows?: number } }[]).filter((e) => e.operationId === all.operationId && e.phase === "history-load");
          expect(events.length).toBeGreaterThan(0);
          expect(events.length).toBeLessThanOrEqual(1 + Math.floor((wallMs * HISTORY_PROGRESS_EVENTS_PER_SECOND) / 1000));
          const counted = events.map((e) => e.counters.rows!);
          expect(counted).toEqual(counted.toSorted((a, b) => a - b));
          console.log(`OBSERVATION ${T030}: H200K: the End load sent ${events.length} history-load progress events in ${wallMs.toFixed(1)} ms (at most ${HISTORY_PROGRESS_EVENTS_PER_SECOND} per second) (experiment)`);
          const last = await rows(service, repositoryId, end.viewId, { end: true }, 3);
          expect(last.result!.rows!.map((r) => r.oid)).toEqual(expected.slice(-3).map((r) => r.oid));
          expect(service.runner.liveRecorded()).toBe(0);
        });
      }),
    LARGE_TIMEOUT_MS,
  );

  largeCase(
    TASK,
    "H200K with historyViewCommits 1,000: the load ends limited with HISTORY_VIEW_COMMITS, the rows stay, and a later load gives the same result without a Git process",
    H200K,
    () =>
      withService(
        "t022-bound",
        async (service) => {
          const repo = copyLarge(H200K, true, "t022-bound-repo");
          const expected = oracle(repo);
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          const bounded = await load(service, repositoryId, view.viewId, { end: true });
          expect({ state: bounded.state, code: bounded.code, result: bounded.result }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", result: { rows: 1000, complete: false, reason: "HISTORY_VIEW_COMMITS" } });
          const held = await allRows(service, repositoryId, view.viewId, 1000);
          expect(held.map((r) => r.oid)).toEqual(expected.slice(0, 1000).map((r) => r.oid));
          const calls = service.runner.calls.length;
          const again = await load(service, repositoryId, view.viewId, { row: 999 });
          expect({ state: again.state, code: again.code, result: again.result }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", result: { rows: 1000, complete: false, reason: "HISTORY_VIEW_COMMITS" } });
          expect(service.runner.calls.length).toBe(calls);
          expect((await rows(service, repositoryId, view.viewId, { row: 1000 }, 1)).result).toMatchObject({ target: "unknown", rowCount: 1000 });
        },
        { historyViewCommits: 1000 },
      ),
    LARGE_TIMEOUT_MS,
  );
});

describe("view bound (contract Δ3 `loadHistory`, Δ5 `HISTORY_VIEW_COMMITS`)", () => {
  // S = n + 1 + 2·M for the first load. With n = BOUND - 1 - 2·M, the stop row equals the bound.
  const BOUND = 2100;

  caseTest(
    TASK,
    "a stop row equal to the view bound on a history of exactly that many commits ends complete, and a later load gives the same result without a Git process",
    SHELL,
    () =>
      withService(
        "t022-stop-bound",
        async (service) => {
          const repo = chainRepo("t022-stop-bound", BOUND);
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          const first = await load(service, repositoryId, view.viewId, { row: BOUND - 1 - 2 * M });
          expect({ state: first.state, result: first.result }).toEqual({ state: "succeeded", result: { rows: BOUND, complete: true } });
          const calls = service.runner.calls.length;
          const again = await load(service, repositoryId, view.viewId, { row: BOUND - 1 });
          expect({ state: again.state, result: again.result }).toEqual({ state: "succeeded", result: { rows: BOUND, complete: true } });
          expect(service.runner.calls.length).toBe(calls);
        },
        { historyViewCommits: BOUND },
      ),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a load canceled at the view bound before its check ended, then loaded again, compares every held row and serves the bound",
    SHELL,
    () =>
      withService(
        "t022-held-bound",
        async (service) => {
          const repo = chainRepo("t022-held-bound", BOUND);
          const expected = oracle(repo);
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          // The first load reaches the bound with rows after it, and waits for its replace read, which cannot start.
          const release = service.runner.holdStart(isReplaceRead);
          try {
            const request = service.send("loadHistory", { viewId: view.viewId, need: { end: true } }, { repositoryId });
            const operationId = await service.operationId(request);
            await waitFor("the stream of the first load", () => service.runner.calls.filter(isLoad)[0]?.exit !== undefined);
            await service.cancel(operationId);
            release();
            const canceled = await service.response(request);
            expect({ state: canceled.state, result: canceled.result }).toEqual({ state: "canceled", result: { rows: 0, complete: false } });
            // Contract Δ3: the progress counter `rows` is the served row count, so the unchecked rows do not count.
            const counted = (service.progress as { operationId: string; phase?: string; counters: { rows?: number } }[]).filter((e) => e.operationId === operationId && e.phase === "history-load").map((e) => e.counters.rows);
            expect(counted.length).toBeGreaterThan(0);
            expect(counted.every((rows) => rows === 0)).toBe(true);
          } finally {
            release();
          }
          const limited = await load(service, repositoryId, view.viewId, { end: true });
          expect({ state: limited.state, code: limited.code, result: limited.result }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", result: { rows: 1000, complete: false, reason: "HISTORY_VIEW_COMMITS" } });
          const held = await allRows(service, repositoryId, view.viewId, 1000);
          expect(held.map((r) => r.oid)).toEqual(expected.slice(0, 1000).map((r) => r.oid));
        },
        { historyViewCommits: 1000 },
      ),
    TIMEOUT_MS,
  );
});

describe("targets, text, and views (contract Δ3 `readHistoryRows`, `closeHistory`)", () => {
  caseTest(
    TASK,
    "target unknown while nothing runs, none past a complete view, a load while one runs gives BUSY, and text none starts no Git process",
    SHELL,
    () =>
      withService("t022-targets", async (service) => {
        const fixture = small("t022-targets", "merges-only");
        const expected = oracle(fixture.repo);
        await unchanged(fixture.repo, async () => {
          const { repositoryId, generation } = await service.register(fixture.repo);
          const view = await opened(service, repositoryId, generation);
          expect((await rows(service, repositoryId, view.viewId, { row: 0 }, 5)).result).toMatchObject({ target: "unknown", rowCount: 0, complete: false });
          // A paused load: a second load gives BUSY, and a waiting read gets its rows when the load commits them.
          const release = service.runner.pauseStdout(isLoad);
          const first = service.send("loadHistory", { viewId: view.viewId, need: { end: true } }, { repositoryId });
          const waiting = service.send("readHistoryRows", { viewId: view.viewId, mode: "full", at: { row: 3 }, count: 2, text: "none" }, { repositoryId });
          await Bun.sleep(200);
          expect((await load(service, repositoryId, view.viewId, { row: 0 })).code).toBe("BUSY");
          release();
          expect((await service.response(first)).result).toEqual({ rows: expected.length, complete: true });
          const waited = await service.response<{ target: string; rows: { index: number }[] }>(waiting);
          expect({ state: waited.state, target: waited.result?.target, rows: waited.result?.rows.map((r) => r.index) }).toEqual({ state: "succeeded", target: "found", rows: [3, 4] });
          expect((await rows(service, repositoryId, view.viewId, { row: expected.length }, 1)).result).toMatchObject({ target: "none", rowCount: expected.length, complete: true });
          const calls = service.runner.calls.length;
          const page = await rows(service, repositoryId, view.viewId, { row: 10 }, 7);
          expect(page.result!.rows!.map((r) => r.index)).toEqual([10, 11, 12, 13, 14, 15, 16]);
          expect(page.result!.rows!.every((r) => r.subject === undefined && r.body === undefined)).toBe(true);
          expect(service.runner.calls.length).toBe(calls);
          // `at: {match}` requires `searchId`, and no search exists before batch 3.
          expect((await rows(service, repositoryId, view.viewId, { match: "next", from: 0 }, 1)).code).toBe("INVALID_REQUEST");
          expect((await rows(service, repositoryId, view.viewId, { row: 0 }, 1, "none", { searchId: crypto.randomUUID() })).code).toBe("UNKNOWN_TARGET");
        });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "text rows holds no body, details holds the body up to 16 KiB cut at a character boundary, a reread gives the same text, and children lists the child rows",
    SHELL,
    () =>
      withService("t022-text", async (service) => {
        const fixture = small("t022-text", "long-body");
        const expected = oracle(fixture.repo);
        await unchanged(fixture.repo, async () => {
          const { repositoryId, generation } = await service.register(fixture.repo);
          const view = await opened(service, repositoryId, generation);
          await load(service, repositoryId, view.viewId, { end: true });
          const listed = await rows(service, repositoryId, view.viewId, { row: 0 }, 3, "rows");
          const all = listed.result!.rows!;
          expect(all.map((r) => r.subject)).toEqual(["c3 marker", "long body", "c1"]);
          expect(all.every((r) => r.body === undefined && r.children === undefined && typeof r.date === "number" && r.author !== undefined)).toBe(true);
          expect(service.runner.calls.filter(isTextRead).length).toBe(1);
          const details = await rows(service, repositoryId, view.viewId, { row: 1 }, 1, "details");
          const row = details.result!.rows![0]!;
          expect(row.bodyCut).toBe(true);
          expect(Buffer.byteLength(row.body!)).toBeLessThanOrEqual(HISTORY_BODY_BYTES);
          expect(row.body!.includes(LONG_BODY_WORD)).toBe(false);
          expect(row.children).toEqual([expected[0]!.oid]);
          expect(row.committer).toEqual({ name: "Arbareto Fixture", email: "fixture@arbareto.invalid" });
          const again = await rows(service, repositoryId, view.viewId, { row: 1 }, 1, "details");
          expect(again.result!.rows).toEqual(details.result!.rows);
          const root = await rows(service, repositoryId, view.viewId, { oid: expected[2]!.oid }, 1, "details");
          expect(root.result!.rows![0]).toMatchObject({ index: 2, bodyCut: false, children: [expected[1]!.oid], cell: { marks: ["root"] } });
        });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `a result stays within HISTORY_PAGE_BYTES and sets cut, and an object above ${HISTORY_COMMIT_OBJECT_BYTES} bytes gives textLimit`,
    SHELL,
    () =>
      withService("t022-page", async (service) => {
        const repo = fixtureDir("t022-page/repo");
        git(repo, ["init", "-q", "-b", "main"]);
        // 48 subjects of 200 KiB each: more than HISTORY_PAGE_BYTES together. The last commit has a body above the object bound.
        const big = "s".repeat(200 * 1024);
        const commits = Array.from({ length: 48 }, (_, i) => fiCommit({ mark: i + 1, time: 1_767_225_600 + i, message: `${big}${i}\n`, from: i === 0 ? undefined : i }));
        commits.push(fiCommit({ mark: 49, time: 1_767_225_700, message: `huge\n\n${"b".repeat(HISTORY_COMMIT_OBJECT_BYTES)}\n`, from: 48 }));
        git(repo, ["fast-import", "--quiet"], { input: Buffer.concat(commits) });
        git(repo, ["reset", "-q", "--hard"]);
        await unchanged(repo, async () => {
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          await load(service, repositoryId, view.viewId, { end: true });
          const page = await rows(service, repositoryId, view.viewId, { row: 0 }, 49, "rows");
          const result = page.result!;
          expect(result.cut).toBe(true);
          expect(result.rows!.length).toBeGreaterThan(0);
          expect(result.rows!.length).toBeLessThan(49);
          expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(result)));
          expect(result.bytes).toBeLessThanOrEqual(HISTORY_PAGE_BYTES);
          expect(result.rows![0]).toMatchObject({ index: 0, textLimit: true });
          expect(result.rows![0]!.subject).toBeUndefined();
          expect(result.rows![1]!.subject).toBe(`${big}47`);
        });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "one live view: a new openHistory releases the old view (UNKNOWN_TARGET), and closeHistory frees the view",
    SHELL,
    () =>
      withService("t022-views", async (service) => {
        const fixture = small("t022-views", "criss-cross");
        const { repositoryId, generation } = await service.register(fixture.repo);
        const first = await opened(service, repositoryId, generation);
        const second = await opened(service, repositoryId, generation);
        expect(second.viewId).not.toBe(first.viewId);
        expect((await load(service, repositoryId, first.viewId, { end: true })).code).toBe("UNKNOWN_TARGET");
        expect((await rows(service, repositoryId, first.viewId, { row: 0 }, 1)).code).toBe("UNKNOWN_TARGET");
        expect((await service.request("closeHistory", { viewId: first.viewId }, { repositoryId })).code).toBe("UNKNOWN_TARGET");
        expect((await load(service, repositoryId, second.viewId, { end: true })).result).toEqual({ rows: 10, complete: true });
        expect((await service.request("closeHistory", { viewId: second.viewId }, { repositoryId })).state).toBe("succeeded");
        expect((await rows(service, repositoryId, second.viewId, { row: 0 }, 1)).code).toBe("UNKNOWN_TARGET");
        expect((await service.request("closeHistory", { viewId: second.viewId }, { repositoryId })).code).toBe("UNKNOWN_TARGET");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a new openHistory cancels a running load of the old view",
    SHELL,
    () =>
      withService("t022-release-load", async (service) => {
        const fixture = small("t022-release-load", "merges-only");
        const { repositoryId, generation } = await service.register(fixture.repo);
        const first = await opened(service, repositoryId, generation);
        const release = service.runner.pauseStdout(isLoad);
        try {
          const loading = service.send("loadHistory", { viewId: first.viewId, need: { end: true } }, { repositoryId });
          await service.operationId(loading);
          await opened(service, repositoryId, generation);
          expect((await service.response(loading)).state).toBe("canceled");
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );
});

describe("special repositories (contract Δ3 `openHistory`)", () => {
  caseTest(
    TASK,
    "an empty repository gives startCount 0 and a complete view without rows",
    SHELL,
    () =>
      withService("t022-empty", async (service) => {
        const fixture = small("t022-empty", "empty");
        const { repositoryId, generation } = await service.register(fixture.repo);
        const view = await opened(service, repositoryId, generation);
        expect({ startCount: view.startCount, head: view.head }).toEqual({ startCount: 0, head: { state: "unborn", target: "refs/heads/main" } });
        expect((await load(service, repositoryId, view.viewId, { end: true })).result).toEqual({ rows: 0, complete: true });
        expect((await rows(service, repositoryId, view.viewId, { end: true }, 1)).result).toMatchObject({ target: "none", rowCount: 0 });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an unborn branch beside other refs shows the other commits, and no row is the checkout",
    SHELL,
    () =>
      withService("t022-unborn", async (service) => {
        const fixture = small("t022-unborn", "unborn-beside");
        const expected = oracle(fixture.repo);
        const { repositoryId, generation } = await service.register(fixture.repo);
        const view = await opened(service, repositoryId, generation);
        expect(view.head).toEqual({ state: "unborn", target: "refs/heads/unborn" });
        expect((await load(service, repositoryId, view.viewId, { end: true })).result).toEqual({ rows: expected.length, complete: true });
        const held = await allRows(service, repositoryId, view.viewId, expected.length);
        expect(held.map((r) => r.oid)).toEqual(expected.map((r) => r.oid));
        expect(held.filter((r) => r.checkout)).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a detached HEAD marks its row as the checkout",
    SHELL,
    () =>
      withService("t022-detached", async (service) => {
        const fixture = small("t022-detached", "detached");
        const { repositoryId, generation } = await service.register(fixture.repo);
        const view = await opened(service, repositoryId, generation);
        expect(view.head).toEqual({ state: "detached", oid: fixture.expect.headOid! });
        await load(service, repositoryId, view.viewId, { end: true });
        const held = await allRows(service, repositoryId, view.viewId, 3);
        expect(held.filter((r) => r.checkout).map((r) => r.oid)).toEqual([fixture.expect.headOid!]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the 65-parent fixture ends the load limited with HISTORY_PARENTS_PER_COMMIT, and the rows before it stay",
    SHELL,
    () =>
      withService("t022-octopus", async (service) => {
        const fixture = small("t022-octopus", "octopus-65");
        const { repositoryId, generation } = await service.register(fixture.repo);
        const view = await opened(service, repositoryId, generation);
        const limited = await load(service, repositoryId, view.viewId, { end: true });
        expect({ state: limited.state, code: limited.code, reason: limited.result?.reason, complete: limited.result?.complete }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", reason: "HISTORY_PARENTS_PER_COMMIT", complete: false });
        const calls = service.runner.calls.length;
        expect((await load(service, repositoryId, view.viewId, { end: true })).result).toEqual(limited.result);
        expect(service.runner.calls.length).toBe(calls);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a stale generation gives REPOSITORY_CHANGED at acceptance, and no Git process starts",
    SHELL,
    () =>
      withService("t022-generation", async (service) => {
        const fixture = small("t022-generation", "criss-cross");
        const { repositoryId, generation } = await service.register(fixture.repo);
        const calls = service.runner.calls.length;
        const response = await openView(service, repositoryId, generation + 1);
        expect({ state: response.state, code: response.code, runs: service.runner.calls.length - calls }).toEqual({ state: "rejected", code: "REPOSITORY_CHANGED", runs: 0 });
      }),
    TIMEOUT_MS,
  );
});

// T399, 001 contract §5 "Deadline outcomes": a capture step at its deadline closes the operation Job, so a sibling ends with `exitCode` null and no `deadline`.
describe("capture deadline (T399)", () => {
  const isArgs = (args: readonly string[]) => (call: { arguments: readonly string[] }) => call.arguments.length === args.length && call.arguments.every((a, i) => a === args[i]);
  const isConfigList = (call: { arguments: readonly string[] }) => call.arguments.includes("config") && call.arguments.includes("list");
  const ends = (calls: readonly RecordedCall[], match: (call: RecordedCall) => boolean) => calls.filter(match).map(({ exit }) => exit?.deadline ?? (exit?.exitCode === null ? "closed" : String(exit?.exitCode)));
  const cases = [
    // Two `readWorkspace` reads of the generation record the listing that the open reuses (contract §7 "Shared listing"), so no listing process runs.
    { tag: "capture", name: "the topology path step expires and the Job close ends the HEAD capture first", target: isArgs(topologyPathArgs()), sibling: isArgs(headTargetArgs()), shared: true },
    { tag: "listing", name: "the held ref capture expires and the Job close ends the own trust listing first", target: isArgs(historyRefsArgs()), sibling: isConfigList, shared: false },
  ];
  for (const { tag, name, target, sibling, shared } of cases)
    caseTest(
      "T399",
      `openHistory gives DEADLINE when ${name}`,
      SHELL,
      () =>
        withService(`t399-open-${tag}`, async (service) => {
          const fixture = small(`t399-open-${tag}`, "criss-cross");
          const { repositoryId, generation } = await service.register(fixture.repo);
          // T088 decision E6: the first full read after registration records no listing, so a second one records it.
          const reads = shared ? [await service.readWorkspace(repositoryId), await service.readWorkspace(repositoryId)] : [];
          expect(reads.map((read) => read.state)).toEqual(reads.map(() => "succeeded"));
          const from = service.runner.calls.length;
          const release = siblingDeadline(service, target, sibling);
          const response = await openView(service, repositoryId, reads.at(-1)?.result!.generation ?? generation).finally(release);
          const calls = service.runner.calls.slice(from);
          const exits = ends(calls, (c) => target(c) || sibling(c));
          const listing = ends(calls, isConfigList);
          console.log(`OBSERVATION T399: openHistory ${tag} exits=${exits.join(",")} listing=${listing.join(",")} state=${response.state} code=${response.code}`);
          expect({ exits: exits.toSorted(), listing, state: response.state, code: response.code }).toEqual({ exits: ["closed", "deadline"], listing: shared ? [] : ["closed"], state: "failed", code: "DEADLINE" });
        }),
      SIBLING_TIMEOUT_MS,
    );
});
