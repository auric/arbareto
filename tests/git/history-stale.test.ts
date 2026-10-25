// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T024: the contract Δ8 freshness rules of a history view, the plan.md D2 re-read rule, and load cancel (plan.md P3, D2, D3).
// Spec FR-002, FR-005, FR-006, FR-007, FR-044, FR-045, FR-051, FR-054, SC-010, SC-012, SC-013.

import { describe, expect } from "bun:test";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_CHUNK_BYTES, HISTORY_LOAD_MARGIN } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import type { RecordedCall } from "./bun-runner";
import { FIXED_IDENTITY, FIXTURE_ROOT, fixtureDir, fixturePath, useFixtureRoot } from "./fixture-root";
import { buildF17, fiCommit } from "./fixtures";
import { H200K, largeCase, repositoryDigest, startPoints } from "./history-fixtures";
import { allRows, commitGraphFiles, copyLarge, git, gitPath, gitText, isLoad, isReplaceRead, isSearch, load, loadSteps, opened, openView, oracle, rows, search, waitFor } from "./history-view-harness";
import { caseTest, openService, siblingDeadline, type Service } from "./service-harness";

printOrigin("../../src/git-service/history-view.ts", import.meta.dir);
printOrigin("../../src/git-service/history-topology.ts", import.meta.dir);
printOrigin("../../src/git-service/history.ts", import.meta.dir);

const TASK = "T024";
const SHELL = ["shell-double"] as const;
const TIMEOUT_MS = 300_000;
const LARGE_TIMEOUT_MS = 30 * 60_000;
// A `siblingDeadline` case that never releases its target ends here, not at the read timeout.
const SIBLING_TIMEOUT_MS = 120_000;
// Contract Δ3: the first load with `{row: 0}` stops at 1 + 2·M rows.
const FIRST_STOP = 1 + 2 * HISTORY_LOAD_MARGIN;
// Spec SC-010 (proposed, O-2): a load cancel stops within 1 s, and no process of it remains after 5 s.
const CANCEL_MS = 1_000;
const END_MS = 5_000;

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

// One line of `count` commits with rising dates. Row i of the view is mark `count - i`.
const CHAIN = 3000;
let chainSource: string | null = null;
function chainRepo(name: string): { repo: string; rowOid: (row: number) => string } {
  if (chainSource === null) {
    chainSource = fixtureDir("t024-chain-source/repo");
    git(chainSource, ["init", "-q", "-b", "main"]);
    git(chainSource, ["fast-import", "--quiet"], { input: Buffer.concat(Array.from({ length: CHAIN }, (_, i) => fiCommit({ mark: i + 1, time: 1_767_225_600 + i, message: `c${i + 1}\n`, from: i === 0 ? undefined : i }))) });
    git(chainSource, ["reset", "-q", "--hard"]);
  }
  const repo = fixturePath(name);
  cpSync(chainSource, repo, { recursive: true });
  const order = oracle(repo).map((r) => r.oid);
  return { repo, rowOid: (row) => order[row]! };
}

// The responses that carry a fixture commit ID.
const leaked = (service: Service, oids: readonly string[]) => {
  const text = JSON.stringify(service.responses);
  return oids.filter((oid) => text.includes(oid));
};

// A load `{end: true}` whose replace read never starts, canceled after its stream ended. The topology then holds every row, and the view serves no new row.
async function uncheckedLoad(service: Service, repositoryId: string, viewId: string, served: number): Promise<void> {
  const loads = service.runner.calls.filter(isLoad).length;
  const release = service.runner.holdStart(isReplaceRead);
  try {
    const request = service.send("loadHistory", { viewId, need: { end: true } }, { repositoryId });
    const operationId = await service.operationId(request);
    await waitFor("the stream of the unchecked load", () => service.runner.calls.filter(isLoad)[loads]?.exit !== undefined);
    await service.cancel(operationId);
    release();
    const canceled = await service.response(request);
    expect({ state: canceled.state, result: canceled.result }).toEqual({ state: "canceled", result: { rows: served, complete: false } });
  } finally {
    release();
  }
}

describe("re-read rule (plan.md D2, contract Δ3 `loadHistory`)", () => {
  largeCase(
    TASK,
    "H200K: a load canceled at each chunk boundary and resumed gives the rows of one uninterrupted run",
    H200K,
    () =>
      withService("t024-chunks", async (service) => {
        const repo = copyLarge(H200K, true, "t024-chunks-repo");
        const starts = startPoints(gitPath(), FIXTURE_ROOT, repo);
        const expected = oracle(repo, starts);
        // The double sends the bytes of one real `rev-list` run of H200K in chunks of NATIVE_CHUNK_BYTES, so each boundary is exact.
        const stream = git(repo, ["--no-optional-locks", "rev-list", "--parents", "--date-order", "--stdin"], { input: Buffer.from(starts.map((s) => `${s}\n`).join("")) });
        service.runner.inject.stdout = (call) => (isLoad(call) ? stream : undefined);
        const chunks = Math.ceil(stream.length / NATIVE_CHUNK_BYTES);
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        let complete = 0;
        for (let k = 1; k < chunks; k++) {
          // Holds the load after k chunks. The match runs once before each chunk.
          let seen = 0;
          const release = service.runner.pauseStdout((call) => isLoad(call) && ++seen > k);
          try {
            const reads = service.runner.calls.filter(isReplaceRead).length;
            const request = service.send("loadHistory", { viewId: view.viewId, need: { end: true } }, { repositoryId });
            const operationId = await service.operationId(request);
            await waitFor(`chunk ${k}`, () => seen > k);
            await waitFor(`replace read ${k}`, () => service.runner.calls.filter(isReplaceRead).length > reads && service.runner.calls.filter(isReplaceRead).at(-1)!.exit !== undefined);
            await service.cancel(operationId);
            const response = await service.response<{ rows: number; complete: boolean }>(request);
            const lines = stream.subarray(0, k * NATIVE_CHUNK_BYTES).filter((b) => b === 0x0a).length;
            expect({ k, state: response.state, result: response.result }).toEqual({ k, state: "canceled", result: { rows: lines, complete: false } });
            complete = lines;
          } finally {
            release();
          }
        }
        expect(complete).toBeGreaterThan(0);
        const last = await load(service, repositoryId, view.viewId, { end: true });
        expect(last.result).toEqual({ rows: expected.length, complete: true });
        const held = await allRows(service, repositoryId, view.viewId, expected.length);
        expect(held.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(expected);
      }),
    LARGE_TIMEOUT_MS,
  );

  largeCase(
    TASK,
    "H200K: each load that ends at its stop row gives succeeded, and the joined rows of all stop rows equal one uninterrupted run",
    H200K,
    () =>
      withService("t024-stops", async (service) => {
        const repo = copyLarge(H200K, false, "t024-stops-repo");
        const expected = oracle(repo);
        await unchanged(repo, async () => {
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          const steps = await loadSteps(service, repositoryId, view.viewId);
          expect(steps.map((s) => s.state)).toEqual(steps.map(() => "succeeded"));
          expect(steps.length).toBeGreaterThan(2);
          const held = await allRows(service, repositoryId, view.viewId, expected.length);
          expect(held.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(expected);
        });
      }),
    LARGE_TIMEOUT_MS,
  );

  // Research R7: `core.useReplaceRefs` changes parents outside the fingerprint. The replace ref gives commit `row` the root as a second parent.
  for (const [label, row] of [
    ["row 0", 0],
    ["a row inside the held rows", 1000],
    ["the last held row", FIRST_STOP - 1],
  ] as const) {
    caseTest(
      TASK,
      `a re-read difference at ${label} gives HISTORY_CHANGED reason order with an equal fingerprint, and the stale view keeps its rows and refuses loads`,
      SHELL,
      () =>
        withService(`t024-order-${row}`, async (service) => {
          const { repo, rowOid } = chainRepo(`t024-order-${row}-repo`);
          const target = rowOid(row);
          git(repo, ["replace", "--graft", target, rowOid(row + 1), rowOid(CHAIN - 1)]);
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          expect((await load(service, repositoryId, view.viewId, { row: 0 })).result).toEqual({ rows: FIRST_STOP, complete: false });
          const grafted = await rows(service, repositoryId, view.viewId, { row }, 1);
          expect(grafted.result!.rows![0]!.parents).toEqual([rowOid(row + 1), rowOid(CHAIN - 1)]);
          git(repo, ["config", "core.useReplaceRefs", "false"]);
          const changed = await load(service, repositoryId, view.viewId, { row: FIRST_STOP - 1 });
          expect({ state: changed.state, code: changed.code, result: changed.result }).toEqual({ state: "failed", code: "HISTORY_CHANGED", result: { rows: FIRST_STOP, complete: false, reason: "order" } });
          const loads = service.runner.calls.filter(isLoad).length;
          const refused = await load(service, repositoryId, view.viewId, { end: true });
          expect({ state: refused.state, code: refused.code, reason: refused.result?.reason }).toEqual({ state: "failed", code: "HISTORY_CHANGED", reason: "order" });
          expect(service.runner.calls.filter(isLoad).length).toBe(loads);
          expect((await rows(service, repositoryId, view.viewId, { row }, 1)).result!.rows![0]!.parents).toEqual(grafted.result!.rows![0]!.parents);
        }),
      TIMEOUT_MS,
    );
  }

  // Contract Δ3: the view serves the held rows of an unchecked load only after the next load compared them and its check passed.
  caseTest(
    TASK,
    "rows of a load whose check did not finish stay unserved while the next load has compared none of them, also after its check passed",
    SHELL,
    () =>
      withService("t024-unchecked", async (service) => {
        const { repo } = chainRepo("t024-unchecked-repo");
        const expected = oracle(repo);
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        expect((await load(service, repositoryId, view.viewId, { row: 0 })).result).toEqual({ rows: FIRST_STOP, complete: false });
        await uncheckedLoad(service, repositoryId, view.viewId, FIRST_STOP);
        const reads = service.runner.calls.filter(isReplaceRead).length;
        const release = service.runner.pauseStdout(isLoad);
        try {
          const request = service.send("loadHistory", { viewId: view.viewId, need: { end: true } }, { repositoryId });
          await waitFor("the replace read of the paused load", () => {
            const done = service.runner.calls.filter(isReplaceRead);
            return done.length > reads && done.at(-1)!.exit !== undefined;
          });
          expect((await rows(service, repositoryId, view.viewId, { row: 0 }, 1)).result!.rowCount).toBe(FIRST_STOP);
          release();
          expect((await service.response(request)).result).toEqual({ rows: CHAIN, complete: true });
        } finally {
          release();
        }
        const held = await allRows(service, repositoryId, view.viewId, CHAIN);
        expect(held.map((r) => ({ oid: r.oid, parents: r.parents }))).toEqual(expected);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a re-read difference inside rows that the view does not serve yet serves only the compared rows before it",
    SHELL,
    () =>
      withService("t024-unchecked-order", async (service) => {
        const { repo, rowOid } = chainRepo("t024-unchecked-order-repo");
        // A row after the first stop row: the unchecked load holds it, and the view does not serve it.
        const row = 2500;
        git(repo, ["replace", "--graft", rowOid(row), rowOid(row + 1), rowOid(CHAIN - 1)]);
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        expect((await load(service, repositoryId, view.viewId, { row: 0 })).result).toEqual({ rows: FIRST_STOP, complete: false });
        await uncheckedLoad(service, repositoryId, view.viewId, FIRST_STOP);
        git(repo, ["config", "core.useReplaceRefs", "false"]);
        const changed = await load(service, repositoryId, view.viewId, { end: true });
        expect({ state: changed.state, code: changed.code, result: changed.result }).toEqual({ state: "failed", code: "HISTORY_CHANGED", result: { rows: row, complete: false, reason: "order" } });
        expect((await rows(service, repositoryId, view.viewId, { row: 0 }, 1)).result!.rowCount).toBe(row);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a synthetic Git exit 0 before the held row count gives HISTORY_CHANGED reason order",
    SHELL,
    () =>
      withService("t024-short", async (service) => {
        const { repo } = chainRepo("t024-short-repo");
        const starts = startPoints(gitPath(), FIXTURE_ROOT, repo);
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        expect((await load(service, repositoryId, view.viewId, { row: 0 })).result).toEqual({ rows: FIRST_STOP, complete: false });
        // Git cannot end before the held rows with fixed start points, so the double sends the first held rows minus ten, then exit 0.
        const full = git(repo, ["--no-optional-locks", "rev-list", "--parents", "--date-order", "--stdin"], { input: Buffer.from(starts.map((s) => `${s}\n`).join("")) });
        let cut = 0;
        for (let lines = 0; lines < FIRST_STOP - 10; lines++) cut = full.indexOf(0x0a, cut) + 1;
        service.runner.inject.stdout = (call) => (isLoad(call) ? full.subarray(0, cut) : undefined);
        const short = await load(service, repositoryId, view.viewId, { row: FIRST_STOP - 1 });
        expect({ state: short.state, code: short.code, result: short.result }).toEqual({ state: "failed", code: "HISTORY_CHANGED", result: { rows: FIRST_STOP, complete: false, reason: "order" } });
      }),
    TIMEOUT_MS,
  );
});

describe("topology fingerprint (contract Δ8 condition 2)", () => {
  for (const change of ["shallow", "grafts", "replace"] as const) {
    caseTest(
      TASK,
      `a change of the ${change} ${change === "replace" ? "records" : "file"} gives HISTORY_CHANGED reason topology at the next load`,
      SHELL,
      () =>
        withService(`t024-topology-${change}`, async (service) => {
          const { repo, rowOid } = chainRepo(`t024-topology-${change}-repo`);
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          await load(service, repositoryId, view.viewId, { row: 0 });
          const gitDir = gitText(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
          if (change === "shallow") writeFileSync(join(gitDir, "shallow"), `${rowOid(CHAIN - 1)}\n`);
          if (change === "grafts") writeFileSync(join(gitDir, "info", "grafts"), `${rowOid(CHAIN - 1)}\n`);
          if (change === "replace") git(repo, ["replace", "--graft", rowOid(0), rowOid(1), rowOid(CHAIN - 1)]);
          const loads = service.runner.calls.filter(isLoad).length;
          const changed = await load(service, repositoryId, view.viewId, { row: FIRST_STOP - 1 });
          expect({ state: changed.state, code: changed.code, result: changed.result }).toEqual({ state: "failed", code: "HISTORY_CHANGED", result: { rows: FIRST_STOP, complete: false, reason: "topology" } });
          // Contract Δ3: the files are read before the Git start. The replace records are read beside it.
          expect(service.runner.calls.filter(isLoad).length - loads).toBe(change === "replace" ? 1 : 0);
          expect((await rows(service, repositoryId, view.viewId, { row: 0 }, 2)).result!.rows!.map((r) => r.oid)).toEqual([rowOid(0), rowOid(1)]);
        }),
      TIMEOUT_MS,
    );
  }
});

describe("failed loads (contract Δ3, Δ8 condition 1)", () => {
  caseTest(
    TASK,
    "a missing commit in a partial clone gives OBJECT_MISSING reason object-missing, and no lazy fetch runs",
    SHELL,
    () =>
      withService("t024-partial", async (service) => {
        const built = buildF17(gitPath(), "t024-partial", "partial-read-tree");
        const source = join(built.root, "source");
        const clone = join(built.root, "clone");
        git(source, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "unfetched"]);
        const missing = gitText(source, ["rev-parse", "HEAD"]).trim();
        const tree = gitText(clone, ["rev-parse", "HEAD^{tree}"]).trim();
        const ident = `${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> 1767225600 +0000`;
        const tip = gitText(clone, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: Buffer.from(`tree ${tree}\nparent ${missing}\nauthor ${ident}\ncommitter ${ident}\n\nmissing parent\n`) }).trim();
        git(clone, ["update-ref", "refs/heads/main", tip]);
        const { repositoryId, generation } = await service.register(clone);
        const view = await opened(service, repositoryId, generation);
        const failed = await load(service, repositoryId, view.viewId, { end: true });
        expect({ state: failed.state, code: failed.code, reason: failed.result?.reason, complete: failed.result?.complete }).toEqual({ state: "failed", code: "OBJECT_MISSING", reason: "object-missing", complete: false });
        expect(failed.result!.remedy!.command).toBeNull();
        expect(existsSync(join(built.root, built.facts.canaries.uploadpack!))).toBe(false);
        for (const call of service.runner.calls.filter((c) => c.contextKind !== "gitProbe")) expect(call.arguments[0]).toBe("--no-lazy-fetch");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a damaged store without a promisor remote gives REPOSITORY_UNAVAILABLE",
    SHELL,
    () =>
      withService("t024-damaged", async (service) => {
        const repo = fixtureDir("t024-damaged/repo");
        git(repo, ["init", "-q", "-b", "main"]);
        const emptyTree = gitText(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], { input: Buffer.from("") }).trim();
        const commit = (time: number, parents: string[], message: string) =>
          gitText(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], {
            input: Buffer.from(`tree ${emptyTree}\n${parents.map((p) => `parent ${p}\n`).join("")}author ${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> ${time} +0000\ncommitter ${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> ${time} +0000\n\n${message}\n`),
          }).trim();
        const root = commit(1_767_225_600, [], "R");
        const parent = commit(1_767_225_700, [root], "P");
        const tip = commit(1_767_225_800, [parent], "T");
        git(repo, ["update-ref", "refs/heads/main", tip]);
        rmSync(join(repo, ".git", "objects", parent.slice(0, 2), parent.slice(2)), { force: true });
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        const failed = await load(service, repositoryId, view.viewId, { end: true });
        expect({ state: failed.state, code: failed.code }).toEqual({ state: "failed", code: "REPOSITORY_UNAVAILABLE" });
        expect(failed.result!.remedy!.text).toContain("git fsck");
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "cancel and DEADLINE leave the view idle, DEADLINE carries the commit-graph remedy that the service never runs, and a later load resumes",
    SHELL,
    () =>
      withService("t024-deadline", async (service) => {
        const { repo } = chainRepo("t024-deadline-repo");
        const expected = oracle(repo);
        await unchanged(repo, async () => {
          const { repositoryId, generation, worktreeRoot } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          const release = service.runner.pauseStdout(isLoad);
          try {
            const request = service.send("loadHistory", { viewId: view.viewId, need: { end: true } }, { repositoryId });
            await service.cancel(await service.operationId(request));
            expect((await service.response(request)).state).toBe("canceled");
          } finally {
            release();
          }
          // A deadline below the time of the held load ends it.
          service.runner.inject.deadlineMs = 300;
          const stop = service.runner.pauseStdout(isLoad);
          let late;
          try {
            late = await load(service, repositoryId, view.viewId, { end: true });
          } finally {
            stop();
            service.runner.inject.deadlineMs = null;
          }
          expect({ state: late.state, code: late.code, complete: late.result?.complete }).toEqual({ state: "failed", code: "DEADLINE", complete: false });
          expect(late.result!.remedy!.command).toBe(`& '${gitPath()}' --no-lazy-fetch -C '${worktreeRoot}' commit-graph write --reachable`);
          expect(service.runner.calls.filter((c) => c.arguments.includes("commit-graph"))).toEqual([]);
          const resumed = await load(service, repositoryId, view.viewId, { end: true });
          expect(resumed.result).toEqual({ rows: expected.length, complete: true });
        });
      }),
    TIMEOUT_MS,
  );
});

// T399, 001 contract §5 "Deadline outcomes": a view step at its deadline closes the operation Job, so a sibling ends with `exitCode` null and no `deadline`.
// Contract Δ8: a deadline leaves the view fresh, so a later request of the view runs.
describe("sibling deadline (T399)", () => {
  const ends = (calls: readonly RecordedCall[], match: (call: RecordedCall) => boolean) => calls.filter(match).map(({ exit }) => exit?.deadline ?? (exit?.exitCode === null ? "closed" : String(exit?.exitCode)));

  caseTest(
    "T399",
    "loadHistory gives DEADLINE when rev-list expires and the Job close ends the replace check first, and the next load resumes",
    SHELL,
    () =>
      withService("t399-load", async (service) => {
        const { repo } = chainRepo("t399-load-repo");
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        const from = service.runner.calls.length;
        const release = siblingDeadline(service, isLoad, isReplaceRead);
        const late = await load(service, repositoryId, view.viewId, { end: true }).finally(release);
        const exits = ends(service.runner.calls.slice(from), (c) => isLoad(c) || isReplaceRead(c));
        console.log(`OBSERVATION T399: loadHistory exits=${exits.join(",")} state=${late.state} code=${late.code}`);
        const resumed = await load(service, repositoryId, view.viewId, { end: true });
        expect({ exits: exits.toSorted(), state: late.state, code: late.code, resumed: { state: resumed.state, code: resumed.code, result: resumed.result } }).toEqual({
          exits: ["closed", "deadline"],
          state: "failed",
          code: "DEADLINE",
          resumed: { state: "succeeded", code: undefined, result: { rows: CHAIN, complete: true } },
        });
      }),
    SIBLING_TIMEOUT_MS,
  );

  // The view is incomplete, so the search loads it to the end beside the search process (contract Δ3 `searchHistory`).
  for (const { tag, name, target, sibling } of [
    { tag: "load", name: "its load expires and the Job close ends the search process first", target: isLoad, sibling: isSearch },
    { tag: "search", name: "the search process expires and the Job close ends its load first", target: isSearch, sibling: isLoad },
  ])
    caseTest(
      "T399",
      `searchHistory gives DEADLINE when ${name}, and the next search runs`,
      SHELL,
      () =>
        withService(`t399-search-${tag}`, async (service) => {
          const { repo } = chainRepo(`t399-search-${tag}-repo`);
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          const from = service.runner.calls.length;
          const release = siblingDeadline(service, target, sibling);
          const late = await search(service, repositoryId, view.viewId, `c${CHAIN}`).finally(release);
          const exits = ends(service.runner.calls.slice(from), (c) => target(c) || sibling(c));
          console.log(`OBSERVATION T399: searchHistory ${tag} exits=${exits.join(",")} state=${late.state} code=${late.code}`);
          const again = await search(service, repositoryId, view.viewId, `c${CHAIN}`);
          expect({ exits: exits.toSorted(), state: late.state, code: late.code, again: { state: again.state, code: again.code, matches: again.result?.matches } }).toEqual({
            exits: ["closed", "deadline"],
            state: "failed",
            code: "DEADLINE",
            again: { state: "succeeded", code: undefined, matches: 1 },
          });
        }),
      SIBLING_TIMEOUT_MS,
    );

  // 002 contract Δ6: the load ends at the view bound through the `cancel` of its call, which closes the Job of the search process too.
  caseTest(
    "T399",
    "a search whose load reaches HISTORY_VIEW_COMMITS while the search process runs ends limited, and the view stays fresh",
    SHELL,
    () =>
      withService(
        "t399-over",
        async (service) => {
          const { repo } = chainRepo("t399-over-repo");
          const { repositoryId, generation } = await service.register(repo);
          const view = await opened(service, repositoryId, generation);
          const from = service.runner.calls.length;
          // The search keeps one held stdout byte, so only the Job close ends it.
          const prior = service.runner.inject.stdout;
          service.runner.inject.stdout = (call) => (isSearch(call) ? new Uint8Array([0]) : prior?.(call));
          const resume = service.runner.pauseStdout(isSearch);
          let limited: Awaited<ReturnType<typeof search>>;
          try {
            limited = await search(service, repositoryId, view.viewId, `c${CHAIN}`);
          } finally {
            resume();
            service.runner.inject.stdout = prior;
          }
          const exits = ends(service.runner.calls.slice(from), isSearch);
          console.log(`OBSERVATION T399: searchHistory over exits=${exits.join(",")} state=${limited.state} code=${limited.code}`);
          const again = await load(service, repositoryId, view.viewId, { end: true });
          expect({ exits, state: limited.state, code: limited.code, result: limited.result, again: { state: again.state, reason: again.result?.reason } }).toEqual({
            exits: ["closed"],
            state: "limited",
            code: "OUTPUT_LIMIT",
            result: { reason: "HISTORY_VIEW_COMMITS" },
            again: { state: "limited", reason: "HISTORY_VIEW_COMMITS" },
          });
        },
        { historyViewCommits: 1000 },
      ),
    SIBLING_TIMEOUT_MS,
  );
});

describe("ref moves, generations, trust, and network (spec FR-002, FR-005, FR-051)", () => {
  caseTest(
    TASK,
    "a ref move and a HEAD move change no view state, a later generation keeps the view, and a stale generation gives REPOSITORY_CHANGED",
    SHELL,
    () =>
      withService("t024-moves", async (service) => {
        const { repo, rowOid } = chainRepo("t024-moves-repo");
        const expected = oracle(repo);
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        await load(service, repositoryId, view.viewId, { row: 0 });
        // The first read records the change digest. The read after the changes gives a later generation.
        expect((await service.readWorkspace(repositoryId)).result!.generation).toBe(generation);
        git(repo, ["update-ref", "refs/heads/main", rowOid(10)]);
        git(repo, ["checkout", "-q", "--detach", rowOid(20)]);
        writeFileSync(join(repo, "changed.txt"), "changed\n");
        const read = await service.readWorkspace(repositoryId);
        expect(read.result!.generation).toBeGreaterThan(generation);
        expect((await openView(service, repositoryId, generation)).code).toBe("REPOSITORY_CHANGED");
        const resumed = await load(service, repositoryId, view.viewId, { end: true });
        expect(resumed.result).toEqual({ rows: expected.length, complete: true });
        const held = await allRows(service, repositoryId, view.viewId, expected.length);
        expect(held.map((r) => r.oid)).toEqual(expected.map((r) => r.oid));
        expect(held.filter((r) => r.checkout).map((r) => r.index)).toEqual([0]);
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "no captured data leaves before the trust gate passes",
    SHELL,
    () =>
      withService("t024-trust", async (service) => {
        const built = buildF17(gitPath(), "t024-trust", "trust");
        const repo = join(built.root, "repo");
        const commits = oracle(repo).flatMap((r) => [r.oid, ...r.parents]);
        expect(commits.length).toBeGreaterThan(0);
        const { repositoryId, generation } = await service.register(repo);
        const response = await openView(service, repositoryId, generation);
        expect({ code: response.code, succeeded: response.state === "succeeded" }).toEqual({ code: "TRUST_REQUIRED", succeeded: false });
        expect(service.runner.calls.filter(isLoad)).toEqual([]);
        expect(leaked(service, commits)).toEqual([]);
        expect(Object.values(built.facts.canaries).filter((log) => existsSync(join(built.root, log)))).toEqual([]);
      }),
    TIMEOUT_MS,
  );

  // 001 contract §3 `revokeTrust` and §7: a read after a revoke refuses at its gate with TRUST_REQUIRED, and a 001 status read does the same.
  caseTest(
    TASK,
    "after revokeTrust, loadHistory, readHistoryRows, and searchHistory of an open view refuse with TRUST_REQUIRED and start no Git process",
    SHELL,
    () =>
      withService("t024-revoke", async (service) => {
        const repo = join(buildF17(gitPath(), "t024-revoke", "trust").root, "repo");
        const { repositoryId, generation } = await service.register(repo);
        const trust = await service.readTrust(repositoryId);
        const approved = await service.approveTrust(repositoryId);
        expect(approved.state).toBe("succeeded");
        const view = await opened(service, repositoryId, generation);
        expect((await load(service, repositoryId, view.viewId, { row: 0 })).state).toBe("succeeded");
        expect((await service.revokeTrust(repositoryId, approved.result!.trustId)).state).toBe("succeeded");
        const calls = service.runner.calls.length;
        const loaded = await load(service, repositoryId, view.viewId, { end: true });
        const read = await rows(service, repositoryId, view.viewId, { row: 0 }, 1, "rows");
        const searched = await service.request("searchHistory", { viewId: view.viewId, text: "c" }, { repositoryId });
        expect([loaded, read, searched].map((r) => ({ state: r.state, code: r.code }))).toEqual(Array.from({ length: 3 }, () => ({ state: "failed", code: "TRUST_REQUIRED" })));
        expect(service.runner.calls.length).toBe(calls);
        const status = await service.readWorkspace(repositoryId);
        expect({ state: status.state, code: status.code }).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "a configured unreachable remote causes no network process",
    SHELL,
    () =>
      withService("t024-remote", async (service) => {
        const { repo } = chainRepo("t024-remote-repo");
        git(repo, ["remote", "add", "origin", "http://127.0.0.1:9/unreachable.git"]);
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        await load(service, repositoryId, view.viewId, { end: true });
        await rows(service, repositoryId, view.viewId, { row: 0 }, 5, "rows");
        const calls = service.runner.calls.filter((c) => c.contextKind !== "gitProbe");
        for (const call of calls) expect(call.arguments[0]).toBe("--no-lazy-fetch");
        for (const call of calls.filter((c) => c.contextKind === "registeredOperation")) expect({ args: call.arguments, policy: call.environmentPolicy }).toEqual({ args: call.arguments, policy: "read" });
        expect(calls.filter((c) => ["fetch", "ls-remote", "remote"].some((word) => c.arguments.includes(word)))).toEqual([]);
      }),
    TIMEOUT_MS,
  );
});

describe("cancel time (spec SC-010)", () => {
  largeCase(
    TASK,
    `H200K: a load cancel ends within ${CANCEL_MS} ms, and no process of the load remains after ${END_MS} ms`,
    H200K,
    () =>
      withService("t024-cancel", async (service) => {
        const repo = copyLarge(H200K, false, "t024-cancel-repo");
        const { repositoryId, generation } = await service.register(repo);
        const view = await opened(service, repositoryId, generation);
        const request = service.send("loadHistory", { viewId: view.viewId, need: { end: true } }, { repositoryId });
        const operationId = await service.operationId(request);
        await waitFor("load start", () => service.runner.calls.some(isLoad));
        const start = performance.now();
        await service.cancel(operationId);
        const response = await service.response(request);
        const stopped = performance.now() - start;
        expect({ state: response.state, fast: stopped <= CANCEL_MS }).toEqual({ state: "canceled", fast: true });
        console.log(`OBSERVATION ${TASK}: the load cancel ended in ${Math.round(stopped)} ms on H200K without a commit-graph`);
        await waitFor("no load process", () => service.runner.liveRecorded() === 0, END_MS);
        // Cancel leaves the view idle.
        expect((await load(service, repositoryId, view.viewId, { row: 0 })).state).toBe("succeeded");
      }),
    LARGE_TIMEOUT_MS,
  );
});
