// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect } from "bun:test";
import { printOrigin } from "../origin";
import { copyPerfFixture, ensurePerfFixture, PERF_L, PERF_M, type PerfFacts, type PerfSpec } from "../windows/perf-fixtures";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { GIT } from "./git-binary";
import { caseTest, openService, type Service, type WorkspaceResult } from "./service-harness";

printOrigin("../../src/git-service/watch.ts", import.meta.dir);
printOrigin("../../src/git-service/status.ts", import.meta.dir);

const TASK = "T192";
// The first run builds the cached L fixture (T164), then copies it.
const TIMEOUT_MS: Record<string, number> = { [PERF_M.name]: 900_000, [PERF_L.name]: 2_700_000 };
const RUNS = 20;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

// One copy per fixture for this file. The cache stays unchanged (perf-fixtures.ts).
const copies = new Map<string, { repo: string; facts: PerfFacts }>();
function copyOf(spec: PerfSpec): { repo: string; facts: PerfFacts } {
  let copy = copies.get(spec.name);
  if (copy === undefined) {
    const cached = ensurePerfFixture(gitPath(), spec);
    copy = { repo: copyPerfFixture(gitPath(), cached, `t192-${spec.name}`), facts: cached.manifest.facts };
    copies.set(spec.name, copy);
  }
  return copy;
}

// Hints stay off, so only the contract §8 stat tuple can start a full read.
async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name, watchHints: false });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

const FULL = { refresh: false, check: "full" } as const;
const CHANGES = { refresh: false, check: "changes" } as const;

async function readSucceeded(service: Service, repositoryId: string, payload: typeof FULL | typeof CHANGES): Promise<WorkspaceResult> {
  const response = await service.readWorkspace(repositoryId, payload);
  expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
  return response.result!;
}

const isStatus = (args: readonly string[]) => args.includes("status");
const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

// Wall time and CPU time of one read. CPU is the service process delta plus every Git child of the read (task text).
async function measure(service: Service, read: () => Promise<unknown>): Promise<{ wallMs: number; cpuMs: number; calls: number }> {
  const first = service.runner.calls.length;
  const cpu = process.cpuUsage();
  const start = performance.now();
  await read();
  const wallMs = performance.now() - start;
  const own = process.cpuUsage(cpu);
  const children = service.runner.calls.slice(first).reduce((sum, call) => sum + (call.cpuMicros ?? 0), 0);
  return { wallMs, cpuMs: (own.user + own.system + children) / 1000, calls: service.runner.calls.length - first };
}

for (const spec of [PERF_M, PERF_L]) {
  const timeout = TIMEOUT_MS[spec.name]!;

  describe(`fixture ${spec.name} (contract §8 "Change check")`, () => {
    caseTest(
      TASK,
      `${spec.name}: with no hint and an unchanged stat tuple, a check "changes" read starts no Git process and returns the same snapshotId and generation`,
      ["windows-shell-double"],
      () =>
        withService(`t192-${spec.name}-unchanged`, async (service) => {
          const { repositoryId } = await service.register(copyOf(spec).repo);
          const full = await readSucceeded(service, repositoryId, FULL);
          for (let i = 0; i < 3; i++) {
            const before = service.runner.calls.length;
            const poll = await readSucceeded(service, repositoryId, CHANGES);
            expect({ poll: i, runs: service.runner.calls.length - before, snapshotId: poll.snapshotId, generation: poll.generation }).toEqual({
              poll: i,
              runs: 0,
              snapshotId: full.snapshotId,
              generation: full.generation,
            });
          }
        }),
      timeout,
    );

    caseTest(
      TASK,
      `${spec.name}: after an index change, a check "changes" read runs one full read`,
      ["windows-shell-double"],
      () =>
        withService(`t192-${spec.name}-index`, async (service) => {
          const { repo, facts } = copyOf(spec);
          const { repositoryId } = await service.register(repo);
          const full = await readSucceeded(service, repositoryId, FULL);
          const path = facts.unstaged.find((p) => p !== facts.c8.path && p !== facts.mixed.path)!;
          ownedGit(gitPath(), FIXTURE_ROOT, repo, ["--literal-pathspecs", "add", "--", path]);
          const before = service.runner.calls.length;
          const poll = await readSucceeded(service, repositoryId, CHANGES);
          const calls = service.runner.calls.slice(before);
          expect(calls.filter((c) => isStatus(c.arguments)).length).toBe(1);
          expect(poll.generation).toBeGreaterThan(full.generation);
          expect(poll.snapshotId).not.toBe(full.snapshotId);
          expect(poll.entries.some((e) => e.path === path && e.category === "staged")).toBe(true);
        }),
      timeout,
    );

    caseTest(
      TASK,
      `OBSERVATION ${spec.name}: medians of wall and CPU time for ${RUNS} check "full" reads and ${RUNS} no-change check "changes" reads`,
      ["windows-shell-double"],
      () =>
        withService(`t192-${spec.name}-medians`, async (service) => {
          const { repositoryId } = await service.register(copyOf(spec).repo);
          await readSucceeded(service, repositoryId, FULL);
          const full: { wallMs: number; cpuMs: number; calls: number }[] = [];
          for (let i = 0; i < RUNS; i++) full.push(await measure(service, () => readSucceeded(service, repositoryId, FULL)));
          const changes: { wallMs: number; cpuMs: number; calls: number }[] = [];
          for (let i = 0; i < RUNS; i++) changes.push(await measure(service, () => readSucceeded(service, repositoryId, CHANGES)));
          expect(changes.map((m) => m.calls)).toEqual(Array.from({ length: RUNS }, () => 0));
          const fmt = (list: { wallMs: number; cpuMs: number }[]) => `median wall ${median(list.map((m) => m.wallMs)).toFixed(1)} ms, median CPU ${median(list.map((m) => m.cpuMs)).toFixed(1)} ms`;
          console.log(`OBSERVATION ${TASK}: R6 fixture ${spec.name}: ${RUNS} check "full" reads: ${fmt(full)} (CPU = service process plus Git children)`);
          console.log(`OBSERVATION ${TASK}: R6 fixture ${spec.name}: ${RUNS} no-change check "changes" reads: ${fmt(changes)} (CPU = service process plus Git children)`);
        }),
      timeout,
    );

    caseTest(
      TASK,
      `OBSERVATION ${spec.name}: wall time of restoreWorkspace`,
      ["windows-shell-double"],
      () =>
        withService(`t192-${spec.name}-restore`, async (service) => {
          const { repo } = copyOf(spec);
          const start = performance.now();
          const response = await service.restoreWorkspace(repo);
          const wallMs = performance.now() - start;
          expect(response.state).toBe("succeeded");
          console.log(`OBSERVATION ${TASK}: R6 fixture ${spec.name}: restoreWorkspace wall time ${wallMs.toFixed(1)} ms (first restore in a new service session)`);
        }),
      timeout,
    );
  });
}
