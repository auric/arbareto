// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { batchCommandArgs, configListArgs, discoveryLayoutArgs, discoveryProfiles, hooksPathArgs, refsArgs, revListArgs, shallowPathArgs, statusArgs } from "../../src/git-service/commands";
import { printOrigin } from "../origin";
import { copyPerfFixture, ensurePerfFixture, PERF_L, PERF_M, type PerfFacts, type PerfSpec } from "../windows/perf-fixtures";
import { FIXTURE_ROOT, ownedGit, serviceEnv, useFixtureRoot } from "./fixture-root";
import { GIT } from "./git-binary";
import type { RecordedCall } from "./bun-runner";
import { caseTest, openService, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

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

// One copy per fixture variant for this file. The cache stays unchanged (perf-fixtures.ts).
// Only the plan.md "Git processes per read" row uses the variant without a commit-graph file.
const copies = new Map<string, { repo: string; facts: PerfFacts }>();
function copyOf(spec: PerfSpec, commitGraph = true): { repo: string; facts: PerfFacts } {
  const key = commitGraph ? spec.name : `${spec.name}-no-commit-graph`;
  let copy = copies.get(key);
  if (copy === undefined) {
    const cached = ensurePerfFixture(gitPath(), spec, commitGraph);
    copy = { repo: copyPerfFixture(gitPath(), cached, `t192-${key}`), facts: cached.manifest.facts };
    copies.set(key, copy);
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
      ["shell-double"],
      () =>
        withService(`t192-${spec.name}-unchanged`, async (service) => {
          const { repositoryId } = await service.register(copyOf(spec).repo);
          const first = await readSucceeded(service, repositoryId, FULL);
          // T088 decision E3: the first read after registration keeps no stat tuple, so the first poll is one full read with the same generation.
          const from = service.runner.calls.length;
          const full = await readSucceeded(service, repositoryId, CHANGES);
          expect({ status: service.runner.calls.slice(from).filter((c) => isStatus(c.arguments)).length, generation: full.generation }).toEqual({ status: 1, generation: first.generation });
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
      ["shell-double"],
      () =>
        withService(`t192-${spec.name}-index`, async (service) => {
          const { repo, facts } = copyOf(spec);
          const { repositoryId } = await service.register(repo);
          await readSucceeded(service, repositoryId, FULL);
          // T088 decision E3: the first poll after registration is one full read. It leaves the tuple that the next poll compares.
          const full = await readSucceeded(service, repositoryId, CHANGES);
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
      ["shell-double"],
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
      ["shell-double"],
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

// plan.md "Git processes per read". Facts come from the runner `Bun.spawn` records. A refused call started no process.
interface ReadFacts<R = unknown> {
  wallMs: number;
  bytes: number;
  calls: RecordedCall[];
  result: R;
}

const sameArgs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((arg, i) => arg === b[i]);
const countOf = (calls: readonly RecordedCall[], args: readonly string[]) => calls.filter((c) => sameArgs(c.arguments, args)).length;
// Contract §7 "Hook registrations" (research R5 "T280 record"): the trust listing is these 2 Git processes.
const isListing = (args: readonly string[]) => sameArgs(args, configListArgs()) || sameArgs(args, hooksPathArgs());
const sortedArgs = (calls: readonly RecordedCall[]) => calls.map((c) => c.arguments.join(" ")).sort();
// T082 and research R2 "T283 record": the first query, the two-call layout query, then `symbolic-ref` and `show-ref` for a HEAD with a commit.
const [firstQuery, , , , , , , headTarget, headCommit] = discoveryProfiles();
const DISCOVERY_CALLS = [firstQuery!, discoveryLayoutArgs(), headTarget!, headCommit!];

async function readFacts<R>(service: Service, read: () => Promise<ServiceResponse<R>>): Promise<ReadFacts<R>> {
  const first = service.runner.calls.length;
  const spawned = service.runner.spawned;
  const start = performance.now();
  const response = await read();
  const wallMs = performance.now() - start;
  expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
  const calls = service.runner.calls.slice(first).filter((c) => c.contextKind !== "gitProbe" && c.refused === undefined);
  expect(calls.length).toBe(service.runner.spawned - spawned);
  return { wallMs, bytes: Buffer.byteLength(JSON.stringify(response)), calls, result: response.result! };
}

// Contract §7 "Shared listing": the tuple files are the index, HEAD, packed-refs, the branch ref file, and each config origin.
function tupleFiles(repo: string): string[] {
  const gitDir = join(repo, ".git");
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) throw new Error(`HEAD is not a symbolic ref: ${head}`);
  const config = Bun.spawnSync([gitPath(), "config", "list", "--show-origin", "-z"], { cwd: repo, env: serviceEnv() });
  if (config.exitCode !== 0) throw new Error(`git config list exited ${config.exitCode}`);
  // `-z` prints origin NUL key LF value NUL for each entry.
  const fields = config.stdout.toString().split("\0").slice(0, -1);
  const origins = new Set<string>();
  for (let i = 0; i < fields.length; i += 2) if (fields[i]!.startsWith("file:")) origins.add(resolve(repo, fields[i]!.slice("file:".length)));
  return [join(gitDir, "index"), join(gitDir, "HEAD"), join(gitDir, "packed-refs"), join(gitDir, head.slice("ref: ".length)), ...origins];
}

function statFacts(paths: readonly string[]): Map<string, string> {
  const facts = new Map<string, string>();
  for (const path of paths) {
    try {
      const s = statSync(path, { bigint: true });
      facts.set(path, `${s.size}:${s.mtimeNs}`);
    } catch (e) {
      facts.set(path, `error:${(e as NodeJS.ErrnoException).code}`);
    }
  }
  return facts;
}

const factChanges = (a: Map<string, string>, b: Map<string, string>) => [...a].filter(([path, fact]) => b.get(path) !== fact).map(([path, fact]) => `${path}: ${fact} -> ${b.get(path)}`);

const KINDS = ["discovery", "trust listing", 'readWorkspace check "full"', 'no-change readWorkspace check "changes"', "readHistory with its own trust listing", "readHistory with a shared trust listing", "readRefs with its own trust listing", "readRefs with a shared trust listing"] as const;
type Kind = (typeof KINDS)[number];

// The subcommand and its arguments, without the global options. An object ID prints as `<oid>`.
const processLabel = (args: readonly string[]) => {
  const at = args.findIndex((arg) => !arg.startsWith("-"));
  return args.slice(at < 0 ? 0 : at).map((arg) => (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(arg) ? "<oid>" : arg)).join(" ");
};

function reportKind(fixture: string, kind: Kind, samples: readonly ReadFacts[]): void {
  const counts = [...new Set(samples.map((s) => s.calls.length))].sort((a, b) => a - b);
  const byProcess = new Map<string, { cpu: number[]; wall: number[] }>();
  for (const sample of samples) {
    for (const call of sample.calls) {
      const entry = byProcess.get(processLabel(call.arguments)) ?? { cpu: [], wall: [] };
      entry.cpu.push((call.cpuMicros ?? 0) / 1000);
      entry.wall.push(call.durationMs ?? 0);
      byProcess.set(processLabel(call.arguments), entry);
    }
  }
  const processes = [...byProcess]
    .map(([label, { cpu, wall }]) => `${label}: ${cpu.length} runs, median CPU ${median(cpu).toFixed(1)} ms, median wall ${median(wall).toFixed(1)} ms, max wall ${Math.max(...wall).toFixed(1)} ms`)
    .join("; ");
  console.log(
    `OBSERVATION ${TASK}: R6 Git processes per read: fixture ${fixture}: ${kind}: ${samples.length} reads, Git process count ${counts.join(" or ")}, median read wall ${median(samples.map((s) => s.wallMs)).toFixed(1)} ms, median response bytes ${median(samples.map((s) => s.bytes))}; per process: ${processes || "none"}`,
  );
}

for (const spec of [PERF_M, PERF_L]) {
  for (const commitGraph of [true, false]) {
    const fixture = `${spec.name} ${commitGraph ? "with commit-graph" : "without commit-graph"}`;
    const key = `${spec.name}-${commitGraph ? "cg" : "nocg"}`;

    describe(`fixture ${fixture} (plan.md "Git processes per read")`, () => {
      caseTest(
        TASK,
        `OBSERVATION ${fixture}: Git process count, process times, and response bytes of ${RUNS} reads of each kind`,
        ["shell-double"],
        async () => {
          const { repo, facts } = copyOf(spec, commitGraph);
          expect(facts.commitGraph).toBe(commitGraph);
          const tuplePaths = tupleFiles(repo);
          const samples = new Map<Kind, ReadFacts[]>(KINDS.map((kind) => [kind, []]));
          const add = (kind: Kind, sample: ReadFacts) => samples.get(kind)!.push(sample);
          for (let run = 0; run < RUNS; run++) {
            // Each kind that names a trust listing starts in a new service session, so no earlier listing of the generation exists.
            await withService(`t192-${key}-trust-${run}`, async (service) => {
              const discovery = await readFacts(service, () => service.chooseRepository(repo));
              expect(sortedArgs(discovery.calls.filter((c) => c.contextKind === "repositoryDiscovery"))).toEqual(DISCOVERY_CALLS.map((p) => p.join(" ")).sort());
              add("discovery", discovery);
              const { repositoryId } = discovery.result as RegistrationResult;
              const trust = await readFacts(service, () => service.readTrust(repositoryId));
              expect(sortedArgs(trust.calls)).toEqual([configListArgs().join(" "), hooksPathArgs().join(" ")].sort());
              add("trust listing", trust);
            });
            let own!: ReadFacts;
            await withService(`t192-${key}-own-${run}`, async (service) => {
              const { repositoryId, generation } = await service.register(repo);
              own = await readFacts(service, () => service.readHistory(repositoryId, generation));
              // T357: no `readWorkspace` listing exists, so `readRefs` runs its own listing.
              const ownRefs = await readFacts(service, () => service.request("readRefs", {}, { repositoryId, repositoryGeneration: generation }));
              expect(sortedArgs(ownRefs.calls)).toEqual([configListArgs().join(" "), hooksPathArgs().join(" "), refsArgs().join(" ")].sort());
              add("readRefs with its own trust listing", ownRefs);
            });
            add("readHistory with its own trust listing", own);
            await withService(`t192-${key}-shared-${run}`, async (service) => {
              const { repositoryId } = await service.register(repo);
              // T088 decision E6: the first full read after registration has no tuple before its listing, so it shares no listing. This warm-up read is not a sample.
              await readFacts(service, () => service.readWorkspace(repositoryId, FULL));
              const factCalls = service.runner.fileFactCalls.length;
              const before = statFacts(tuplePaths);
              const full = await readFacts(service, () => service.readWorkspace(repositoryId, FULL));
              const between = statFacts(tuplePaths);
              expect(countOf(full.calls, statusArgs())).toBe(1);
              add('readWorkspace check "full"', full);
              const shared = await readFacts(service, () => service.readHistory(repositoryId, full.result.generation));
              const after = statFacts(tuplePaths);
              add("readHistory with a shared trust listing", shared);
              const sharedRefs = await readFacts(service, () => service.request("readRefs", {}, { repositoryId, repositoryGeneration: full.result.generation }));
              const afterRefs = statFacts(tuplePaths);
              add("readRefs with a shared trust listing", sharedRefs);
              // Contract §7 "Shared listing": any tuple difference or unknown fact requires an own listing.
              // Blind spot: a `stat` failure inside the service is not visible to the test.
              const differences = [
                ...factChanges(before, between).map((d) => `during readWorkspace: ${d}`),
                ...factChanges(between, after).map((d) => `during readHistory: ${d}`),
                ...service.runner.fileFactCalls.slice(factCalls).filter((c) => c.facts.some((f) => f.kind === "error")).map((c) => `fileFacts error in ${c.operationId}: ${JSON.stringify(c.facts)}, NTSTATUS ${JSON.stringify(c.statuses?.map((s) => (s === null ? null : `0x${s.toString(16)}`)))}`),
              ];
              const listings = { ownListing: own.calls.filter((c) => isListing(c.arguments)).length, sharedListing: shared.calls.filter((c) => isListing(c.arguments)).length };
              if (differences.length === 0) {
                // The shared listing removes exactly the 2 listing processes from the second read.
                expect(listings).toEqual({ ownListing: 2, sharedListing: 0 });
                expect(sortedArgs(shared.calls)).toEqual(sortedArgs(own.calls.filter((c) => !isListing(c.arguments))));
              } else {
                console.log(`OBSERVATION ${TASK}: fixture ${fixture} run ${run}: tuple facts differ, so readHistory runs its own listing: ${differences.join("; ")}`);
                expect(listings).toEqual({ ownListing: 2, sharedListing: 2 });
              }
              // T357: `readRefs` follows the same shared listing rule. Its only own process is the `for-each-ref` step.
              const refsDifferences = [...differences, ...factChanges(after, afterRefs).map((d) => `during readRefs: ${d}`)];
              if (refsDifferences.length === 0) expect(sortedArgs(sharedRefs.calls)).toEqual([refsArgs().join(" ")]);
              else {
                console.log(`OBSERVATION ${TASK}: fixture ${fixture} run ${run}: tuple facts differ, so readRefs runs its own listing: ${refsDifferences.join("; ")}`);
                expect(sharedRefs.calls.filter((c) => isListing(c.arguments)).length).toBe(2);
              }
              // Contract §7 "Held history steps": each history step runs once.
              for (const args of [shallowPathArgs(), revListArgs(facts.tip, full.result.identity.objectFormat), batchCommandArgs()]) expect({ args, runs: countOf(shared.calls, args) }).toEqual({ args, runs: 1 });
              const changeCalls = service.runner.fileFactCalls.length;
              const changes = await readFacts(service, () => service.readWorkspace(repositoryId, CHANGES));
              // Contract §8 "Change check": an unknown or changed tuple fact requires a full read.
              const unknown = [
                ...differences,
                ...service.runner.fileFactCalls.slice(changeCalls).filter((c) => c.facts.some((f) => f.kind === "error")).map((c) => `fileFacts error in ${c.operationId}: ${JSON.stringify(c.facts)}, NTSTATUS ${JSON.stringify(c.statuses?.map((s) => (s === null ? null : `0x${s.toString(16)}`)))}`),
                ...factChanges(afterRefs, statFacts(tuplePaths)).map((d) => `during the "changes" read: ${d}`),
              ];
              if (unknown.length === 0) {
                expect(changes.calls.length).toBe(0);
                add('no-change readWorkspace check "changes"', changes);
              } else console.log(`OBSERVATION ${TASK}: fixture ${fixture} run ${run}: the "changes" read is not counted, because a tuple fact was unknown or differed: ${unknown.join("; ")}`);
            });
          }
          expect(samples.get('no-change readWorkspace check "changes"')!.length).toBeGreaterThan(0);
          for (const kind of KINDS) reportKind(fixture, kind, samples.get(kind)!);
        },
        TIMEOUT_MS[spec.name]! * 2,
      );
    });
  }
}
