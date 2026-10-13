// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T034: `readHistoryRows` with `at: {match}` in mode `full`, the highlight mode of spec US3 (plan.md P5, D5; contract Δ3 `readHistoryRows`).
// Spec FR-036, FR-037, FR-038, FR-039, SC-008.

import { describe, expect } from "bun:test";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { buildSmallFixtures, MARKER_WORD, type SmallName } from "./history-fixtures";
import { allRows, gitPath, grepOracle, isSearch, load, markedRows, opened, oracle, waitFor, type Searched, type ViewRow } from "./history-view-harness";
import { caseTest, once, openService, type Service, type ServiceResponse } from "./service-harness";

printOrigin("../../src/git-service/history-search.ts", import.meta.dir);
printOrigin("../../src/git-service/history-view.ts", import.meta.dir);

const TASK = "T034";
const SHELL = ["shell-double"] as const;
const TIMEOUT_MS = 300_000;

useFixtureRoot();

async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name, watchHints: false });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

describe("match navigation (FR-037, FR-038)", () => {
  caseTest(
    TASK,
    "Next and Previous reach every match in order, from is inclusive, the ends give none without a wrap, and each row carries its match flag",
    SHELL,
    () =>
      withService("t034-steps", async (service) => {
        const names: SmallName[] = ["criss-cross", "merges-only", "clock-skew", "tips-50", "octopus-10"];
        for (const fixture of buildSmallFixtures(gitPath(), "t034-steps", names)) {
          const view = oracle(fixture.repo);
          const greps = grepOracle(fixture.repo, MARKER_WORD);
          const positions = greps.map((oid) => view.findIndex((r) => r.oid === oid));
          const { repositoryId, generation } = await service.register(fixture.repo);
          const opening = await opened(service, repositoryId, generation);
          const request = service.send("searchHistory", { viewId: opening.viewId, text: MARKER_WORD }, { repositoryId });
          const searchId = await service.operationId(request);
          // FR-039: the final count equals Git's count.
          const done: ServiceResponse<Searched> = await service.response<Searched>(request);
          expect({ name: fixture.name, state: done.state, matches: done.result?.matches }).toEqual({ name: fixture.name, state: "succeeded", matches: greps.length });
          const step = async (match: "next" | "previous", from: number): Promise<ViewRow | null> => {
            const r = await markedRows(service, repositoryId, opening.viewId, searchId, { match, from }, 1);
            expect({ state: r.state, target: r.result!.target === "unknown" ? "unknown" : "known" }).toEqual({ state: "succeeded", target: "known" });
            return r.result!.target === "found" ? r.result!.rows![0]! : null;
          };
          const forward: number[] = [];
          for (let row = await step("next", 0); row !== null; row = await step("next", row.index + 1)) forward.push(row.index);
          expect({ name: fixture.name, forward }).toEqual({ name: fixture.name, forward: positions });
          const back: number[] = [];
          for (let from = view.length - 1; from >= 0; ) {
            const row = await step("previous", from);
            if (row === null) break;
            back.push(row.index);
            from = row.index - 1;
          }
          expect({ name: fixture.name, back }).toEqual({ name: fixture.name, back: positions.toReversed() });
          // FR-038: no match before the first one and none after the last one. The selection does not wrap.
          if (positions[0]! > 0) expect(await step("previous", positions[0]! - 1)).toBeNull();
          expect(await step("next", positions.at(-1)! + 1)).toBeNull();
          // Contract Δ3 reviewer default: `from` is inclusive.
          for (const p of positions) {
            expect({ p, next: (await step("next", p))?.index, previous: (await step("previous", p))?.index }).toEqual({ p, next: p, previous: p });
          }
          // FR-036: each highlight row carries its match flag.
          const flagged = await markedRows(service, repositoryId, opening.viewId, searchId, { row: 0 }, 512);
          expect(flagged.result!.rows!.map((r) => r.match)).toEqual(view.slice(0, 512).map((r) => greps.includes(r.oid)));
          const plain = await allRows(service, repositoryId, opening.viewId, view.length);
          expect(plain.every((r) => r.match === undefined)).toBe(true);
        }
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "while the search runs, a match target waits and rows carry match null, and the final answers follow",
    SHELL,
    () =>
      withService("t034-wait", async (service) => {
        const [fixture] = buildSmallFixtures(gitPath(), "t034-wait", ["merges-only"]);
        const view = oracle(fixture!.repo);
        const greps = grepOracle(fixture!.repo, MARKER_WORD);
        const first = view.findIndex((r) => r.oid === greps[0]);
        const { repositoryId, generation } = await service.register(fixture!.repo);
        const opening = await opened(service, repositoryId, generation);
        expect((await load(service, repositoryId, opening.viewId, { end: true })).result).toEqual({ rows: view.length, complete: true });
        const release = service.runner.pauseStdout(once(isSearch));
        try {
          const request = service.send("searchHistory", { viewId: opening.viewId, text: MARKER_WORD }, { repositoryId });
          const searchId = await service.operationId(request);
          await waitFor("the search process", () => service.runner.calls.some(isSearch));
          const unknown = await markedRows(service, repositoryId, opening.viewId, searchId, { row: 0 }, 8);
          expect(unknown.result!.rows!.map((r) => r.match)).toEqual(Array(8).fill(null));
          // FR-037: a target that is not known yet waits on the running search.
          const waiting = service.send("readHistoryRows", { viewId: opening.viewId, mode: "full", searchId, at: { match: "next", from: 0 }, count: 1, text: "none" }, { repositoryId });
          await Bun.sleep(300);
          expect(service.responses.some((r) => r.requestId === waiting)).toBe(false);
          release();
          const found = await service.response<{ target: string; rows: ViewRow[] }>(waiting);
          expect({ state: found.state, target: found.result?.target, index: found.result?.rows[0]?.index }).toEqual({ state: "succeeded", target: "found", index: first });
          expect((await service.response<Searched>(request)).result).toEqual({ matches: greps.length, shallow: false });
          const known = await markedRows(service, repositoryId, opening.viewId, searchId, { row: 0 }, 8);
          expect(known.result!.rows!.map((r) => r.match)).toEqual(view.slice(0, 8).map((r) => greps.includes(r.oid)));
        } finally {
          release();
        }
      }),
    TIMEOUT_MS,
  );
});
