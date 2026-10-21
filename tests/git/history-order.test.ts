// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T003: Git order facts of the history view (plan.md P0.2, research.md R1 and R4).
// A fact that fails is a finding, not a red test (tasks.md "Test harness rules"). The test prints it as an OBSERVATION line.
// The test asserts the documented `--date-order` rule, the commit set, and the unchanged repository bytes (SC-013).

import { expect, test } from "bun:test";
import { PERF_CACHE_ROOT } from "../windows/perf-fixtures";
import { FIXED_IDENTITY, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, useFixtureRoot } from "./fixture-root";
import { describeGit, fixtureGitPath } from "./git-binary";
import { buildSmallFixtures, H1M, H200K, largeCase, largeFixture, MARKER_WORD, repositoryDigest, startPoints, withCommitGraph, type LargeSpec, type SmallFixture } from "./history-fixtures";
import { FactLog, orderFacts, searchArgs } from "./history-order-facts";

// This file imports no `src/` module. `fixture-root.ts` and `history-fixtures.ts` print the ORIGIN lines of the contract files they read.

const TASK = "T003";
const EXPECTED_GIT = "git version 2.56.0.windows.2";
const SMALL_TIMEOUT_MS = 600_000;
const LARGE_TIMEOUT_MS = 60 * 60_000;

const log = new FactLog(TASK);

describeGit("history order facts", (git) => {
  useFixtureRoot();

  test("the Git version under test", () => {
    const version = ownedGit(git, FIXTURE_ROOT, fixtureDir("t003-version"), ["version"]).toString().trim();
    console.log(`OBSERVATION ${TASK}: ${version}`);
    if (version !== EXPECTED_GIT) console.log(`OBSERVATION ${TASK}: the Git version is not ${EXPECTED_GIT}; record the facts below for ${version}`);
    expect(version.startsWith("git version ")).toBe(true);
  });

  // The facts of one repository. The repository bytes stay unchanged (SC-013).
  function facts(label: string, root: string, repo: string, matches: (oids: string[]) => string[] | number): Buffer {
    const before = repositoryDigest(repo);
    // Contract Δ3: the `search` policy adds `LC_ALL=C.UTF-8` to the `read` policy.
    const run = (args: string[], starts: string[], search?: boolean) => ownedGit(git, root, repo, args, { input: Buffer.from(starts.map((s) => `${s}\n`).join("")), env: search ? { LC_ALL: "C.UTF-8" } : {} });
    const full = orderFacts({ label, run, starts: startPoints(git, root, repo), searchArgs: searchArgs(MARKER_WORD), matches }, log);
    expect(repositoryDigest(repo)).toBe(before);
    return full;
  }

  const small = (f: SmallFixture) =>
    facts(`${f.name}${f.commitGraph ? " with commit-graph" : ""}`, FIXTURE_ROOT, f.repo, (oids) => oids.filter((oid) => f.messages.get(oid)!.toString("utf8").toLowerCase().includes(MARKER_WORD)));

  test("small fixtures: order facts with and without a commit-graph", () => {
    for (const f of buildSmallFixtures(git, "t003")) {
      const plain = small(f);
      const graph = small(withCommitGraph(git, f));
      log.record("the output is equal with and without a commit-graph", f.name, graph.equals(plain));
    }
  }, SMALL_TIMEOUT_MS);

  function large(spec: LargeSpec): void {
    const [plain, graph] = [false, true].map((commitGraph) => {
      const f = largeFixture(git, spec, commitGraph);
      // Every 50th commit has the marker word (`history-fixtures.ts` `largeMessage`).
      return facts(`${spec.name}${commitGraph ? " with commit-graph" : ""}`, PERF_CACHE_ROOT, f.repo, () => Math.ceil(spec.commits / 50));
    });
    log.record("the output is equal with and without a commit-graph", spec.name, graph!.equals(plain!));
  }

  largeCase(TASK, "H200K: order facts with and without a commit-graph", H200K, () => large(H200K), LARGE_TIMEOUT_MS);
  largeCase(TASK, "H1M: order facts with and without a commit-graph", H1M, () => large(H1M), LARGE_TIMEOUT_MS);

  // Data-model §3: a repeated parent is kept as Git prints it and drawn as one edge. This fact shows whether Git accepts and prints one.
  test("a commit object with a repeated parent line: hash-object and rev-list --parents", () => {
    const repo = fixtureDir("t003-repeated-parent/repo");
    const run = (args: string[], input?: string) => {
      const proc = Bun.spawnSync([fixtureGitPath(git), ...args], { cwd: repo, env: fixtureEnv(), stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
      return { exitCode: proc.exitCode, out: proc.stdout.toString() };
    };
    expect(run(["init", "-q", "-b", "main"]).exitCode).toBe(0);
    const tree = run(["hash-object", "-t", "tree", "-w", "--stdin"], "").out.trim();
    const ident = (time: number) => `${FIXED_IDENTITY.name} <${FIXED_IDENTITY.email}> ${time} +0000`;
    const commit = (parents: string[], time: number) => run(["hash-object", "-t", "commit", "-w", "--stdin"], `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}author ${ident(time)}\ncommitter ${ident(time)}\n\nc${time}\n`);
    const root = commit([], 1_767_225_600);
    expect(root.exitCode).toBe(0);
    const base = root.out.trim();
    const twice = commit([base, base], 1_767_225_700);
    console.log(`OBSERVATION ${TASK}: hash-object -t commit -w exited ${twice.exitCode} for a commit object with the parent line ${base} twice (experiment)`);
    if (twice.exitCode !== 0) return;
    const tip = twice.out.trim();
    const listed = run(["--no-optional-locks", "rev-list", "--parents", "--date-order", "--stdin"], `${tip}\n`);
    expect(listed.exitCode).toBe(0);
    const line = listed.out.split("\n").find((l) => l.startsWith(`${tip} `) || l === tip)!;
    const parents = line.split(" ").slice(1);
    console.log(`OBSERVATION ${TASK}: rev-list --parents printed ${parents.length} parent fields for that commit, ${parents.filter((p) => p === base).length} of them the repeated parent: "${line}" (experiment)`);
    expect(listed.out.split("\n").filter((l) => l !== "").length).toBe(2);
  });

  test("report the facts for research.md", () => {
    log.report();
    const runs = log.results.get("two runs give the same bytes")!;
    expect(runs.held.length + runs.failed.length).toBeGreaterThan(0);
  });
});
