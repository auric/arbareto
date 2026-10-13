// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T032: `searchHistory` and `readHistoryRows` mode `filter` through the in-process service (plan.md P5, D4, D5; contract Δ3 `searchHistory`, data-model §6 and §7).
// Spec FR-019, FR-020, FR-021, FR-030, FR-032, FR-033, FR-035, FR-039, FR-045, SC-008, SC-009, SC-010, SC-013.

import { describe, expect, spyOn, test } from "bun:test";
import { cpSync } from "node:fs";
import { HISTORY_LOAD_MARGIN } from "../../src/contracts/limits";
import { EMPTY_STATE, layoutStep, type Cell } from "../../src/git-service/history-layout";
import { SearchMerge } from "../../src/git-service/history-search";
import { HistoryTopology } from "../../src/git-service/history-topology";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureDir, fixturePath, useFixtureRoot } from "./fixture-root";
import { fiCommit } from "./fixtures";
import { buildSmallFixtures, H200K, largeCase, LONG_BODY_WORD, MARKER_WORD, repositoryDigest, shallowCommits, type SmallName } from "./history-fixtures";
import {
  allFilterRows,
  commitGraphFiles,
  copyLarge,
  filterRows,
  git,
  gitPath,
  grepOracle,
  isLoad,
  isProbe,
  isSearch,
  load,
  opened,
  oracle,
  rows,
  search,
  waitFor,
  type OracleRow,
  type Searched,
  type ViewRow,
} from "./history-view-harness";
import { caseTest, once, openService, type Service, type ServiceResponse } from "./service-harness";

printOrigin("../../src/git-service/history-view.ts", import.meta.dir);
printOrigin("../../src/git-service/history-search.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

const TASK = "T032";
const SHELL = ["shell-double"] as const;
const TIMEOUT_MS = 300_000;
const LARGE_TIMEOUT_MS = 30 * 60_000;
// Spec SC-010 (proposed, O-2): a search cancel stops within 1 s, and no process of it remains after 5 s.
const CANCEL_MS = 1_000;
const END_MS = 5_000;
// `history-fixtures.ts` `largeMessage`: each H200K message outside the FR-023 cases starts with this word.
const COMMON_WORD = "commit";

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

const small = (folder: string, names: readonly SmallName[]) => buildSmallFixtures(gitPath(), folder, names);

// One line of 3,000 commits with rising dates. Marks 1,000, 2,000, and 3,000 match MARKER_WORD, so the matches are rows 0, 1,000, and 2,000.
const CHAIN = 3000;
let chainSource: string | null = null;
function chainRepo(name: string): string {
  if (chainSource === null) {
    chainSource = fixtureDir("t032-chain-source/repo");
    git(chainSource, ["init", "-q", "-b", "main"]);
    const message = (mark: number) => `c${mark}${mark % 1000 === 0 ? ` ${MARKER_WORD}` : ""}\n`;
    git(chainSource, ["fast-import", "--quiet"], { input: Buffer.concat(Array.from({ length: CHAIN }, (_, i) => fiCommit({ mark: i + 1, time: 1_767_225_600 + i, message: message(i + 1), from: i === 0 ? undefined : i }))) });
    git(chainSource, ["reset", "-q", "--hard"]);
  }
  const repo = fixturePath(name);
  cpSync(chainSource, repo, { recursive: true });
  return repo;
}

// The filter rows of SC-008 by brute force. A nearest matching ancestor has no other match on some parent path (FR-033).
// The reduced parents of a match are its nearest matching ancestors in stream order. Each cell is the T009 fold over the matches.
// A skip edge marks its node-to-bottom segment with `skip: true` (FR-034). A match with Git parents has no root mark.
function filterOracle(view: readonly OracleRow[], matches: ReadonlySet<string>, shallow: ReadonlySet<string>): { oids: string[]; cells: Cell[] } {
  const index = new Map(view.map((r, i) => [r.oid, i]));
  const matchRows = view.flatMap((r, i) => (matches.has(r.oid) ? [i] : []));
  let state = EMPTY_STATE;
  const cells = matchRows.map((m) => {
    const parents = new Set(view[m]!.parents.map((p) => index.get(p)!));
    const nearest = new Map<number, boolean>();
    const seen = new Set<number>();
    const queue = [...parents];
    while (queue.length > 0) {
      const x = queue.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      if (matches.has(view[x]!.oid)) nearest.set(x, parents.has(x));
      else queue.push(...view[x]!.parents.map((p) => index.get(p)!));
    }
    const targets = [...nearest].sort((a, b) => a[0] - b[0]);
    const step = layoutStep(state, { oid: view[m]!.oid, parents: targets.map(([x]) => view[x]!.oid), shallow: shallow.has(view[m]!.oid) });
    state = step.state;
    let k = 0;
    const segments = step.cell.segments.map((s) => (s.shape === "line" && s.from.at === "node" && !targets[k++]![1] ? { ...s, skip: true as const } : s));
    return { ...step.cell, segments, marks: view[m]!.parents.length > 0 ? [] : step.cell.marks };
  });
  return { oids: matchRows.map((m) => view[m]!.oid), cells };
}

// The cells that differ from the oracle, by match index.
const wrongCells = (got: readonly ViewRow[], cells: readonly Cell[]) => got.flatMap((r, q) => (Bun.deepEquals(r.cell, cells[q], true) ? [] : [q]));

// Sends a search and returns its request ID and its `searchId`, the operation ID of the accepted event (contract Δ2).
async function startSearch(service: Service, repositoryId: string, viewId: string, text: string): Promise<{ request: string; searchId: string }> {
  const request = service.send("searchHistory", { viewId, text }, { repositoryId });
  return { request, searchId: await service.operationId(request) };
}

// Contract Δ3 "Progress": phase `history-search` with the counters `matches` and `settled`. The load inside the search reports phase `history-load`.
function checkProgress(service: Service, searchId: string, finalMatches: number): void {
  const events = (service.progress as { operationId: string; state: string; phase?: string; counters: Record<string, number> }[]).filter((e) => e.operationId === searchId && e.state !== "accepted");
  for (const e of events) expect(["history-load", "history-search"]).toContain(e.phase!);
  const searching = events.filter((e) => e.phase === "history-search");
  expect(searching.length).toBeGreaterThan(0);
  for (const e of searching) {
    expect(Object.keys(e.counters).sort()).toEqual(["matches", "settled"]);
    expect(e.counters.settled!).toBeLessThanOrEqual(e.counters.matches!);
    expect(e.counters.matches!).toBeLessThanOrEqual(finalMatches);
  }
}

describe("filter mode against Git and the BFS oracle (SC-008, FR-032, FR-033)", () => {
  largeCase(
    TASK,
    "H200K: filter mode shows exactly the rev-list --grep matches in full-history order, and each cell equals the fold of the BFS oracle edges",
    H200K,
    () =>
      withService("t032-h200k", async (service) => {
        const repo = copyLarge(H200K, true, "t032-h200k-repo");
        const view = oracle(repo);
        const greps = grepOracle(repo, MARKER_WORD);
        const expected = filterOracle(view, new Set(greps), new Set());
        // research.md R15: `--grep` equals the full order without the non-matches.
        expect(expected.oids).toEqual(greps);
        await unchanged(repo, async () => {
          const { repositoryId, generation } = await service.register(repo);
          const opening = await opened(service, repositoryId, generation);
          const { request, searchId } = await startSearch(service, repositoryId, opening.viewId, MARKER_WORD);
          const done = await service.response<Searched>(request);
          expect({ state: done.state, result: done.result }).toEqual({ state: "succeeded", result: { matches: greps.length, shallow: false } });
          // The search loaded the view to its end inside its own operation (contract Δ3).
          expect(service.runner.calls.filter(isLoad).map((c) => c.operationId)).toEqual([searchId]);
          const got = await allFilterRows(service, repositoryId, opening.viewId, searchId, greps.length);
          expect(got.map((r) => r.oid)).toEqual(greps);
          expect(got.map((r) => r.index)).toEqual(greps.map((_, q) => q));
          expect(got.every((r) => r.match === true)).toBe(true);
          expect(wrongCells(got, expected.cells)).toEqual([]);
          const skips = got.filter((r) => r.cell!.segments.some((s) => s.shape === "line" && (s as { skip?: true }).skip === true)).length;
          console.log(`OBSERVATION ${TASK}: H200K "${MARKER_WORD}": ${greps.length} matches; ${skips} filter rows draw an edge that skips commits`);
          expect(skips).toBeGreaterThan(0);
          const last = await filterRows(service, repositoryId, opening.viewId, searchId, { end: true }, 1);
          expect(last.result).toMatchObject({ target: "found", rowCount: view.length, complete: true });
          expect(last.result!.rows!.map((r) => [r.index, r.oid])).toEqual([[greps.length - 1, greps.at(-1)!]]);
          checkProgress(service, searchId, greps.length);

          // A record, not a gate: the most matches that wait for their rows during a search of a common word on a new view (contract Δ3 "Merge into the view").
          const common = grepOracle(repo, COMMON_WORD).length;
          const add = SearchMerge.prototype.add;
          let peak = 0;
          const spy = spyOn(SearchMerge.prototype, "add").mockImplementation(function (this: SearchMerge, oid: string, served: number) {
            add.call(this, oid, served);
            peak = Math.max(peak, this.waiting);
          });
          let wide: ServiceResponse<Searched>;
          try {
            const fresh = await opened(service, repositoryId, generation);
            wide = await search(service, repositoryId, fresh.viewId, COMMON_WORD);
          } finally {
            spy.mockRestore();
          }
          expect({ state: wide.state, result: wide.result }).toEqual({ state: "succeeded", result: { matches: common, shallow: false } });
          console.log(`OBSERVATION ${TASK}: H200K with a commit-graph "${COMMON_WORD}" on a new view: ${common} matches; the search queue held at most ${peak} matches (experiment)`);
        });
      }),
    LARGE_TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "small fixtures: the filter rows equal rev-list --grep, each cell equals the oracle fold, and a shallow view states its scope",
    SHELL,
    () =>
      withService("t032-small", async (service) => {
        const names: SmallName[] = ["criss-cross", "octopus-10", "merges-only", "tips-50", "equal-dates", "clock-skew", "shallow"];
        for (const fixture of small("t032-small", names)) {
          const view = oracle(fixture.repo);
          const greps = grepOracle(fixture.repo, MARKER_WORD);
          const expected = filterOracle(view, new Set(greps), shallowCommits(gitPath(), FIXTURE_ROOT, fixture.repo));
          expect({ name: fixture.name, oids: expected.oids }).toEqual({ name: fixture.name, oids: greps });
          await unchanged(fixture.repo, async () => {
            const { repositoryId, generation } = await service.register(fixture.repo);
            const opening = await opened(service, repositoryId, generation);
            const { request, searchId } = await startSearch(service, repositoryId, opening.viewId, MARKER_WORD.toUpperCase());
            const done = await service.response<Searched>(request);
            expect({ name: fixture.name, state: done.state, result: done.result }).toEqual({ name: fixture.name, state: "succeeded", result: { matches: greps.length, shallow: fixture.name === "shallow" } });
            const got = await allFilterRows(service, repositoryId, opening.viewId, searchId, greps.length);
            expect({ name: fixture.name, oids: got.map((r) => r.oid), wrong: wrongCells(got, expected.cells) }).toEqual({ name: fixture.name, oids: greps, wrong: [] });
            // Contract Δ3 reviewer default: `at: {row: k}` names match k, each `index` is the match index, and `rowCount` stays the view row count.
            const k = Math.floor(greps.length / 2);
            const at = await filterRows(service, repositoryId, opening.viewId, searchId, { row: k }, 2, "rows");
            expect(at.result).toMatchObject({ target: "found", rowCount: view.length });
            expect(at.result!.rows!.map((r) => [r.index, r.oid, r.parents])).toEqual(greps.slice(k, k + 2).map((oid, i) => [k + i, oid, view.find((r) => r.oid === oid)!.parents]));
            expect(at.result!.rows!.every((r) => typeof r.subject === "string")).toBe(true);
            const other = view.find((r) => !greps.includes(r.oid))!.oid;
            expect((await filterRows(service, repositoryId, opening.viewId, searchId, { oid: other }, 1)).result).toMatchObject({ target: "none" });
            expect((await filterRows(service, repositoryId, opening.viewId, searchId, { oid: greps.at(-1)! }, 1)).result!.rows!.map((r) => r.index)).toEqual([greps.length - 1]);
            expect((await filterRows(service, repositoryId, opening.viewId, searchId, { row: greps.length }, 1)).result).toMatchObject({ target: "none" });
          });
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a search on a view that holds only its first load step loads to the end inside the search, a filter row has cell null until it is settled, and a load meanwhile gives BUSY",
    SHELL,
    () =>
      withService("t032-settle", async (service) => {
        const repo = chainRepo("t032-settle-repo");
        const view = oracle(repo);
        const expected = filterOracle(view, new Set(grepOracle(repo, MARKER_WORD)), new Set());
        await unchanged(repo, async () => {
          const { repositoryId, generation } = await service.register(repo);
          const opening = await opened(service, repositoryId, generation);
          const first = await load(service, repositoryId, opening.viewId, { row: 0 });
          expect(first.result).toEqual({ rows: 1 + 2 * HISTORY_LOAD_MARGIN, complete: false });
          // The load of the search stops before its second stdout read. One read holds at most NATIVE_CHUNK_BYTES, fewer than the 2,049 held rows, so the root row stays unread.
          let chunks = 0;
          const release = service.runner.pauseStdout((call) => isLoad(call) && ++chunks > 1);
          try {
            const { request, searchId } = await startSearch(service, repositoryId, opening.viewId, MARKER_WORD);
            await waitFor("the load of the search", () => chunks > 1);
            // Contract Δ2: the renderer reads filter rows with the `searchId` of the accepted event while the search runs.
            const third = await filterRows(service, repositoryId, opening.viewId, searchId, { row: 2 }, 1);
            expect({ state: third.state, target: third.result?.target }).toEqual({ state: "succeeded", target: "found" });
            const running = await filterRows(service, repositoryId, opening.viewId, searchId, { row: 0 }, 3);
            expect(running.result).toMatchObject({ target: "found", rowCount: 1 + 2 * HISTORY_LOAD_MARGIN, complete: false });
            // Match 2 at row 2,000 waits for the root row, so its cell stays null (data-model §5).
            expect(running.result!.rows!.map((r) => r.cell)).toEqual([expected.cells[0]!, expected.cells[1]!, null]);
            expect((await load(service, repositoryId, opening.viewId, { end: true })).code).toBe("BUSY");
            const loads = service.runner.calls.filter(isLoad);
            expect(loads.length).toBe(2);
            expect(loads[1]!.operationId).toBe(searchId);
            release();
            const done = await service.response<Searched>(request);
            expect({ state: done.state, result: done.result }).toEqual({ state: "succeeded", result: { matches: 3, shallow: false } });
            const final = await filterRows(service, repositoryId, opening.viewId, searchId, { row: 0 }, 3);
            expect(final.result).toMatchObject({ target: "found", rowCount: CHAIN, complete: true });
            expect(final.result!.rows!.map((r) => r.cell)).toEqual(expected.cells);
            checkProgress(service, searchId, 3);
            expect(service.runner.liveRecorded()).toBe(0);
          } finally {
            release();
          }
        });
      }),
    TIMEOUT_MS,
  );
});

describe("refusals and limits (SC-009, contract Δ3 `searchHistory`)", () => {
  caseTest(
    TASK,
    "each refused text gives its reason, carries no found character, and starts no Git process",
    SHELL,
    () =>
      withService("t032-refused", async (service) => {
        const [fixture] = small("t032-refused", ["criss-cross"]);
        const { repositoryId, generation } = await service.register(fixture!.repo);
        const opening = await opened(service, repositoryId, generation);
        const cases: [string, string][] = [
          ["a\nb", "line-break"],
          ["a\rb", "line-break"],
          ["a\0b", "nul"],
          ["x\\Ey", "quote-end"],
          ["x".repeat(1025), "length"],
          ["é".repeat(513), "length"],
          ["\ud800", "length"],
          ["a\nb\0", "line-break"],
          [`${"x".repeat(1100)}\0`, "nul"],
        ];
        for (const [text, reason] of cases) {
          const calls = service.runner.calls.length;
          const response = await search(service, repositoryId, opening.viewId, text);
          expect({ text, state: response.state, code: response.code, result: response.result, runs: service.runner.calls.length - calls }).toEqual({ text, state: "rejected", code: "UNSUPPORTED_FILTER_TEXT", result: { reason }, runs: 0 });
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a searchHistory while a load runs gives BUSY, and a search on a limited view ends limited with HISTORY_VIEW_COMMITS and starts no Git process",
    SHELL,
    () =>
      withService(
        "t032-busy",
        async (service) => {
          const repo = chainRepo("t032-busy-repo");
          const { repositoryId, generation } = await service.register(repo);
          const opening = await opened(service, repositoryId, generation);
          const release = service.runner.pauseStdout(isLoad);
          try {
            const loading = service.send("loadHistory", { viewId: opening.viewId, need: { end: true } }, { repositoryId });
            await service.operationId(loading);
            const busy = await search(service, repositoryId, opening.viewId, MARKER_WORD);
            expect({ state: busy.state, code: busy.code, operationId: busy.operationId }).toEqual({ state: "rejected", code: "BUSY", operationId: undefined });
            release();
            expect((await service.response(loading)).result).toEqual({ rows: 1000, complete: false, reason: "HISTORY_VIEW_COMMITS" });
          } finally {
            release();
          }
          const calls = service.runner.calls.length;
          const limited = await search(service, repositoryId, opening.viewId, MARKER_WORD);
          expect({ state: limited.state, code: limited.code, result: limited.result, runs: service.runner.calls.length - calls }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", result: { reason: "HISTORY_VIEW_COMMITS" }, runs: 0 });
        },
        { historyViewCommits: 1000 },
      ),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a search whose own load reaches HISTORY_VIEW_COMMITS ends limited, and its searchId ends with it",
    SHELL,
    () =>
      withService(
        "t032-limit",
        async (service) => {
          const repo = chainRepo("t032-limit-repo");
          const { repositoryId, generation } = await service.register(repo);
          const opening = await opened(service, repositoryId, generation);
          const { request, searchId } = await startSearch(service, repositoryId, opening.viewId, MARKER_WORD);
          const limited = await service.response<Searched>(request);
          expect({ state: limited.state, code: limited.code, result: limited.result }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", result: { reason: "HISTORY_VIEW_COMMITS" } });
          expect((await filterRows(service, repositoryId, opening.viewId, searchId, { row: 0 }, 1)).code).toBe("UNKNOWN_TARGET");
          expect(service.runner.liveRecorded()).toBe(0);
        },
        { historyViewCommits: 1000 },
      ),
    TIMEOUT_MS,
  );
});

describe("search lifecycle (FR-030, FR-035, FR-039, contract Δ3 and Δ7)", () => {
  caseTest(
    TASK,
    "a new search cancels the old one, the old searchId gives UNKNOWN_TARGET, and a canceled search shows no final count",
    SHELL,
    () =>
      withService("t032-replace", async (service) => {
        const [fixture] = small("t032-replace", ["merges-only"]);
        const greps = grepOracle(fixture!.repo, MARKER_WORD);
        const { repositoryId, generation } = await service.register(fixture!.repo);
        const opening = await opened(service, repositoryId, generation);
        const release = service.runner.pauseStdout(once(isSearch));
        try {
          const old = await startSearch(service, repositoryId, opening.viewId, MARKER_WORD);
          await waitFor("the first search process", () => service.runner.calls.some(isSearch));
          const next = await startSearch(service, repositoryId, opening.viewId, MARKER_WORD);
          const stopped = await service.response<Searched>(old.request);
          expect(stopped.state).toBe("canceled");
          expect(stopped.result?.matches).toBeUndefined();
          const done = await service.response<Searched>(next.request);
          expect({ state: done.state, result: done.result }).toEqual({ state: "succeeded", result: { matches: greps.length, shallow: false } });
          expect((await filterRows(service, repositoryId, opening.viewId, old.searchId, { row: 0 }, 1)).code).toBe("UNKNOWN_TARGET");
          expect((await filterRows(service, repositoryId, opening.viewId, next.searchId, { row: 0 }, 1)).result).toMatchObject({ target: "found" });
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a broken match order fails the search with HISTORY_CHANGED reason order, and the view goes stale: it keeps its rows and refuses loads and searches",
    SHELL,
    () =>
      withService("t032-order", async (service) => {
        const repo = chainRepo("t032-order-repo");
        const greps = grepOracle(repo, MARKER_WORD);
        const { repositoryId, generation } = await service.register(repo);
        const opening = await opened(service, repositoryId, generation);
        const first = await load(service, repositoryId, opening.viewId, { row: 0 });
        expect(first.result).toEqual({ rows: 1 + 2 * HISTORY_LOAD_MARGIN, complete: false });
        // The double answers the search with Git's matches in reverse order. The load of the search holds its stdout, so the view stays incomplete.
        service.runner.inject.stdout = (call) => (isSearch(call) ? Buffer.from(greps.toReversed().map((o) => `${o}\n`).join("")) : undefined);
        const release = service.runner.pauseStdout(isLoad);
        let broken: ServiceResponse<Searched>;
        let searchId: string;
        try {
          const started = await startSearch(service, repositoryId, opening.viewId, MARKER_WORD);
          searchId = started.searchId;
          broken = await service.response<Searched>(started.request);
        } finally {
          release();
          service.runner.inject.stdout = undefined;
        }
        expect({ state: broken.state, code: broken.code, result: broken.result }).toEqual({ state: "failed", code: "HISTORY_CHANGED", result: { reason: "order" } });
        expect((await filterRows(service, repositoryId, opening.viewId, searchId, { row: 0 }, 1)).code).toBe("UNKNOWN_TARGET");
        // Contract Δ8 condition 3: a stale view keeps its rows and refuses loads and searches with its code, and no Git process starts.
        const calls = service.runner.calls.length;
        const refusedLoad = await load(service, repositoryId, opening.viewId, { row: 0 });
        expect({ state: refusedLoad.state, code: refusedLoad.code, result: refusedLoad.result }).toEqual({ state: "failed", code: "HISTORY_CHANGED", result: { ...first.result!, reason: "order" } });
        const refusedSearch = await search(service, repositoryId, opening.viewId, MARKER_WORD);
        expect({ state: refusedSearch.state, code: refusedSearch.code, result: refusedSearch.result }).toEqual({ state: "failed", code: "HISTORY_CHANGED", result: { reason: "order" } });
        expect(service.runner.calls.length).toBe(calls);
        expect((await rows(service, repositoryId, opening.viewId, { row: 0 }, 1)).result).toMatchObject({ target: "found" });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a broken match order on a complete view makes it stale, and the refused load keeps complete: true with reason order",
    SHELL,
    () =>
      withService("t032-order-complete", async (service) => {
        const repo = chainRepo("t032-order-complete-repo");
        const greps = grepOracle(repo, MARKER_WORD);
        const { repositoryId, generation } = await service.register(repo);
        const opening = await opened(service, repositoryId, generation);
        const full = await load(service, repositoryId, opening.viewId, { end: true });
        expect({ state: full.state, result: full.result }).toEqual({ state: "succeeded", result: { rows: CHAIN, complete: true } });
        // The view is complete, so the search runs no load, and each reversed match breaks the merge.
        service.runner.inject.stdout = (call) => (isSearch(call) ? Buffer.from(greps.toReversed().map((o) => `${o}\n`).join("")) : undefined);
        let broken: ServiceResponse<Searched>;
        try {
          broken = await search(service, repositoryId, opening.viewId, MARKER_WORD);
        } finally {
          service.runner.inject.stdout = undefined;
        }
        expect({ state: broken.state, code: broken.code, result: broken.result }).toEqual({ state: "failed", code: "HISTORY_CHANGED", result: { reason: "order" } });
        // Contract Δ3 "Refusal result": `complete` states the view, so a refused load of a stale complete view carries `complete: true`.
        const calls = service.runner.calls.length;
        const refusedLoad = await load(service, repositoryId, opening.viewId, { row: 0 });
        expect({ state: refusedLoad.state, code: refusedLoad.code, result: refusedLoad.result }).toEqual({ state: "failed", code: "HISTORY_CHANGED", result: { rows: CHAIN, complete: true, reason: "order" } });
        expect(service.runner.calls.length).toBe(calls);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "an unexpected runner error of the search process ends the load of the search, so the view takes a new load",
    SHELL,
    () =>
      withService("t032-throw", async (service) => {
        const repo = chainRepo("t032-throw-repo");
        const { repositoryId, generation } = await service.register(repo);
        const opening = await opened(service, repositoryId, generation);
        // The load of the search holds its stdout, and the search process starts only after the load process.
        const paused = service.runner.pauseStdout(isLoad);
        const held = service.runner.holdStart(isSearch);
        try {
          const { request } = await startSearch(service, repositoryId, opening.viewId, MARKER_WORD);
          await waitFor("the load of the search", () => service.runner.calls.some(isLoad));
          service.runner.inject.stdout = (call) => {
            if (isSearch(call)) throw new Error("unexpected runner error");
            return undefined;
          };
          held();
          const failed = await service.response<Searched>(request);
          expect({ state: failed.state, code: failed.code }).toEqual({ state: "failed", code: "GIT_FAILED" });
          // The search ends only after the load of the search returned, so its process exit is already recorded.
          expect(service.runner.calls.find(isLoad)!.exit).toBeDefined();
        } finally {
          service.runner.inject.stdout = undefined;
          held();
          paused();
        }
        const next = await load(service, repositoryId, opening.viewId, { end: true });
        expect({ state: next.state, code: next.code, result: next.result }).toEqual({ state: "succeeded", code: undefined, result: { rows: CHAIN, complete: true } });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a match after the 16 KiB body bound shows, no match gives zero rows, and a canary search text reaches no log",
    SHELL,
    () =>
      withService("t032-text", async (service) => {
        const [fixture] = small("t032-text", ["long-body"]);
        const view = oracle(fixture!.repo);
        await unchanged(fixture!.repo, async () => {
          const { repositoryId, generation } = await service.register(fixture!.repo);
          const opening = await opened(service, repositoryId, generation);
          // FR-019: the search covers the whole message, also after the display bound.
          const body = await startSearch(service, repositoryId, opening.viewId, LONG_BODY_WORD);
          expect((await service.response<Searched>(body.request)).result).toEqual({ matches: 1, shallow: false });
          const found = await filterRows(service, repositoryId, opening.viewId, body.searchId, { row: 0 }, 1, "rows");
          expect(found.result!.rows!.map((r) => [r.oid, r.subject])).toEqual([[view[1]!.oid, "long body"]]);
          // FR-035 and contract Δ7: no match, and the search text enters no log or diagnostic.
          const canary = "arbareto-canary-5f1c9e";
          const none = await startSearch(service, repositoryId, opening.viewId, canary);
          expect((await service.response<Searched>(none.request)).result).toEqual({ matches: 0, shallow: false });
          expect((await filterRows(service, repositoryId, opening.viewId, none.searchId, { row: 0 }, 1)).result).toMatchObject({ target: "none", rowCount: view.length });
          expect((await filterRows(service, repositoryId, opening.viewId, none.searchId, { end: true }, 1)).result).toMatchObject({ target: "none" });
          expect(JSON.stringify(service.log())).not.toContain(canary);
          expect(JSON.stringify([service.responses, service.progress])).not.toContain(canary);
          // Contract Δ7: the search runs under policy `search`, and the probe writes only its own folder.
          for (const call of service.runner.calls.filter((c) => isSearch(c) || isProbe(c))) expect({ args: call.arguments, policy: call.environmentPolicy }).toEqual({ args: call.arguments, policy: "search" });
        });
      }),
    TIMEOUT_MS,
  );

  largeCase(
    TASK,
    `H200K: a search cancel ends within ${CANCEL_MS} ms, no process of the search remains after ${END_MS} ms, no count is final, and the loaded rows stay`,
    H200K,
    () =>
      withService("t032-cancel", async (service) => {
        const repo = copyLarge(H200K, false, "t032-cancel-repo");
        const { repositoryId, generation } = await service.register(repo);
        const opening = await opened(service, repositoryId, generation);
        const { request, searchId } = await startSearch(service, repositoryId, opening.viewId, MARKER_WORD);
        await waitFor("the search process", () => service.runner.calls.some(isSearch), 60_000);
        const start = performance.now();
        await service.cancel(searchId);
        const response: ServiceResponse<Searched> = await service.response<Searched>(request);
        const stopped = performance.now() - start;
        expect({ state: response.state, fast: stopped <= CANCEL_MS, matches: response.result?.matches }).toEqual({ state: "canceled", fast: true, matches: undefined });
        console.log(`OBSERVATION ${TASK}: the search cancel ended in ${Math.round(stopped)} ms on H200K without a commit-graph`);
        await waitFor("no search process", () => service.runner.liveRecorded() === 0, END_MS);
        expect((await filterRows(service, repositoryId, opening.viewId, searchId, { row: 0 }, 1)).code).toBe("UNKNOWN_TARGET");
        // Cancel leaves the view idle (contract Δ8).
        expect((await load(service, repositoryId, opening.viewId, { row: 0 })).state).toBe("succeeded");
      }),
    LARGE_TIMEOUT_MS,
  );
});

describe("SearchMerge (contract Δ3 \"Merge into the view\")", () => {
  test("a match that waits for the row at which the queue emptied is merged when that row is served", () => {
    const oid = (n: number) => n.toString(16).padStart(40, "0");
    const topology = new HistoryTopology("sha1");
    topology.beginStep();
    expect(topology.push(new TextEncoder().encode(`${oid(1)} ${oid(2)}\n${oid(2)} ${oid(3)}\n`))).toBeNull();
    const merge = new SearchMerge(topology, () => false, 1000);
    merge.add(oid(1), 0);
    merge.advance(1);
    merge.add(oid(2), 1);
    merge.advance(2);
    merge.endStream(2);
    expect({ count: merge.count, waiting: merge.waiting, final: merge.final, broken: merge.broken }).toEqual({ count: 2, waiting: 0, final: true, broken: false });
  });
});
