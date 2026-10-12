// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T010: the P0.2 order facts and the P0.5 matching probe with the distro Git (plan.md P0.2, P0.5, research.md R10). `Local: WSL`.
// The Windows builder makes each fixture. `tar` copies its bytes into the owned distro folder, so the distro Git reads the same repository.
// A failed fact, a missing C.UTF-8 locale, and a probe mismatch are findings. They print OBSERVATION lines (tasks.md "Test harness rules").

import { afterEach, expect } from "bun:test";
import { basename, dirname, join } from "node:path";
import { MATCHING_PROBE_COMMITS, MATCHING_PROBE_RUNS, MATCHING_PROBE_STREAM, MATCHING_PROBE_TIP } from "../../src/contracts/matching-probe";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { buildSmallFixtures, H200K, largeCase, largeFixture, MARKER_WORD, startPoints, withCommitGraph, type SmallFixture } from "../git/history-fixtures";
import { FactLog, orderFacts, searchArgs, VIEW } from "../git/history-order-facts";
import { PERF_CACHE_ROOT } from "../windows/perf-fixtures";
import { inDistro, missingCapability, useWslFolder, wslExec, wslHost, wslTest, type WslCapability, type WslHost } from "./wsl-host";

printOrigin("../../src/contracts/matching-probe.ts", import.meta.dir);

const TASK = "T010";
const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "distro-git-2.55"];
const CASE_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 120_000;
const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const LARGE_DIR = "h200k";

useFixtureRoot();
useWslFolder();

const log = new FactLog(TASK);
const sameAsWindows: { held: string[]; failed: string[] } = { held: [], failed: [] };

// A WSL page cache of large fixtures stays while the VM is busy, so each case removes its large fixtures.
let caseHost: WslHost | undefined;
afterEach(() => {
  const host = caseHost;
  caseHost = undefined;
  if (host !== undefined) inDistro(host.distro, ["/usr/bin/rm", "-rf", "--one-file-system", "--", `${host.folder}/${LARGE_DIR}`], { timeoutMs: GIT_TIMEOUT_MS });
}, GIT_TIMEOUT_MS + 10_000);

// The `read` policy, plus `LC_ALL=C.UTF-8` for the `search` policy (contract Δ3). The owned home keeps the user's configuration out.
function distroCommand(host: WslHost, search: boolean, gitArgs: string[]): string[] {
  const git = host.probe.paths.git;
  if (!git) throw new Error("no distro Git");
  const home = `${host.folder}/home`;
  return ["/usr/bin/env", `HOME=${home}`, `GIT_CONFIG_GLOBAL=${home}/.gitconfig`, "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", ...(search ? ["LC_ALL=C.UTF-8"] : []), git, ...gitArgs];
}

function distroGit(host: WslHost, search: boolean, gitArgs: string[], input?: Uint8Array): Buffer {
  const result = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", ...distroCommand(host, search, gitArgs)], { input, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new Error(`distro git ${gitArgs.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
  return Buffer.from(result.bytes);
}

// Copies a Windows repository folder into `<owned folder>/<sub>/<name>` through a tar stream on stdin.
function copyIn(host: WslHost, repo: string, sub: string): string {
  const tar = Bun.spawnSync([TAR, "-c", "-f", "-", "-C", dirname(repo), basename(repo)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(`tar of ${repo} exited ${tar.exitCode}: ${tar.stderr.toString()}`);
  const dest = `${host.folder}/${sub}`;
  inDistro(host.distro, ["/usr/bin/mkdir", "-p", "--", dest]);
  inDistro(host.distro, ["/usr/bin/tar", "-x", "-f", "-", "-C", dest], { input: tar.stdout, timeoutMs: GIT_TIMEOUT_MS });
  return `${dest}/${basename(repo)}`;
}

// Runs the facts with the distro Git on a copy of `repo`. Also compares the view bytes with the Windows Git bytes.
function distroFacts(host: WslHost, label: string, root: string, repo: string, sub: string, matches: (oids: string[]) => string[] | number): Buffer {
  const git = GIT!;
  const dir = copyIn(host, repo, sub);
  const starts = startPoints(git, root, repo);
  const input = (s: string[]) => Buffer.from(s.map((x) => `${x}\n`).join(""));
  const run = (args: string[], s: string[], search?: boolean) => distroGit(host, search === true, ["-C", dir, ...args], input(s));
  const full = orderFacts({ label, run, starts, searchArgs: searchArgs(MARKER_WORD), matches }, log);
  const windows = ownedGit(git, root, repo, VIEW, { input: input(starts) });
  sameAsWindows[windows.equals(full) ? "held" : "failed"].push(label);
  if (!windows.equals(full)) console.log(`OBSERVATION ${TASK}: ${label}: the distro view bytes differ from the Windows Git bytes (experiment)`);
  return full;
}

const caseOf = (name: string, body: (host: WslHost) => void) =>
  wslTest(
    name,
    NEEDS,
    (host) => {
      caseHost = host;
      body(host);
    },
    CASE_TIMEOUT_MS,
  );

caseOf("the distro Git version and the C.UTF-8 locale", (host) => {
  const version = distroGit(host, false, ["version"]).toString().trim();
  console.log(`OBSERVATION ${TASK}: ${host.distro}: ${version}`);
  // locale(1): `charmap` prints the codeset of the selected locale. A missing locale prints a warning and the C codeset.
  const charmap = wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/env", "LC_ALL=C.UTF-8", "/usr/bin/locale", "charmap"]);
  const held = charmap.exitCode === 0 && charmap.stdout === "UTF-8\n" && charmap.stderr === "";
  console.log(`OBSERVATION ${TASK}: ${host.distro}: LC_ALL=C.UTF-8 locale charmap gives ${JSON.stringify(charmap.stdout)} with exit ${charmap.exitCode}${charmap.stderr === "" ? "" : ` and stderr ${JSON.stringify(charmap.stderr)}`}; the C.UTF-8 locale is ${held ? "present" : "missing (finding)"} (experiment)`);
  expect(version.startsWith("git version ")).toBe(true);
});

caseOf("the matching probe stream gives the contract matches with the distro Git and LC_ALL=C.UTF-8", (host) => {
  const probe = `${host.folder}/probe`;
  distroGit(host, false, ["init", "--bare", "-q", "--template=", "--object-format=sha1", probe]);
  distroGit(host, false, [`--git-dir=${probe}`, "fast-import", "--quiet"], MATCHING_PROBE_STREAM);
  const oids = (b: Buffer) => b.toString("utf8").split("\n").filter((l) => l !== "");
  expect(oids(distroGit(host, false, [`--git-dir=${probe}`, "rev-list", "--reverse", MATCHING_PROBE_TIP]))).toEqual(MATCHING_PROBE_COMMITS.map((c) => c.oid));
  const label = (oid: string) => MATCHING_PROBE_COMMITS.find((c) => c.oid === oid)?.label ?? oid;
  let agree = 0;
  MATCHING_PROBE_RUNS.forEach((run, r) => {
    // Contract Δ3 `searchHistory` argv with the probe patterns. Stdin holds the probe tip.
    const args = [`--git-dir=${probe}`, ...searchArgs(...run.grep)];
    const found = oids(distroGit(host, true, args, Buffer.from(`${MATCHING_PROBE_TIP}\n`)));
    const held = JSON.stringify([...found].sort()) === JSON.stringify([...run.matches].sort());
    if (held) agree++;
    console.log(`OBSERVATION ${TASK}: ${host.distro}: probe run ${r + 1} (${run.grep.join(" ")}) matched [${found.map(label).join(", ")}]${held ? "" : `; the contract expects [${run.matches.map(label).join(", ")}] (finding)`} (experiment)`);
  });
  console.log(`OBSERVATION ${TASK}: ${host.distro}: ${agree} of ${MATCHING_PROBE_RUNS.length} probe runs give the contract matches (experiment)`);
});

caseOf("small fixtures: the order facts with the distro Git, with and without a commit-graph", (host) => {
  const git = GIT!;
  const marked = (f: SmallFixture) => (oids: string[]) => oids.filter((oid) => f.messages.get(oid)!.toString("utf8").toLowerCase().includes(MARKER_WORD));
  for (const f of buildSmallFixtures(git, "t010")) {
    const g = withCommitGraph(git, f);
    const plain = distroFacts(host, `${host.distro} ${f.name}`, FIXTURE_ROOT, f.repo, "small", marked(f));
    const graph = distroFacts(host, `${host.distro} ${f.name} with commit-graph`, FIXTURE_ROOT, g.repo, "small", marked(g));
    log.record("the output is equal with and without a commit-graph", `${host.distro} ${f.name}`, graph.equals(plain));
  }
});

// The H200K case needs WSL and the fixture. `largeCase` prints the skip of a missing fixture.
const h200kName = "H200K: the order facts with the distro Git, with and without a commit-graph";
if (missingCapability(NEEDS) !== null) caseOf(h200kName, () => {});
else
  largeCase(
    TASK,
    h200kName,
    H200K,
    () => {
      const host = wslHost()!;
      caseHost = host;
      const [plain, graph] = [false, true].map((commitGraph) => {
        const f = largeFixture(GIT!, H200K, commitGraph);
        // Every 50th commit has the marker word (`history-fixtures.ts` `largeMessage`).
        // Each variant gets its own folder, so the commit-graph copy does not depend on the pack names.
        return distroFacts(host, `${host.distro} H200K${commitGraph ? " with commit-graph" : ""}`, PERF_CACHE_ROOT, f.repo, `${LARGE_DIR}/${commitGraph ? "cg" : "plain"}`, () => Math.ceil(H200K.commits / 50));
      });
      log.record("the output is equal with and without a commit-graph", `${host.distro} H200K`, graph!.equals(plain!));
    },
    CASE_TIMEOUT_MS,
  );

caseOf("report the facts for research.md", () => {
  log.report();
  console.log(`OBSERVATION ${TASK}: "the distro view bytes equal the Windows Git bytes" held on ${sameAsWindows.held.length} of ${sameAsWindows.held.length + sameAsWindows.failed.length} fixture runs (experiment)${sameAsWindows.failed.length > 0 ? `; failed on: ${sameAsWindows.failed.join("; ")}` : ""}`);
  const runs = log.results.get("two runs give the same bytes")!;
  expect(runs.held.length + runs.failed.length).toBeGreaterThan(0);
});
