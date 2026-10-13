// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T010: the P0.2 order facts and the P0.5 matching probe with the distro Git (plan.md P0.2, P0.5, research.md R10). `Local: WSL`.
// The Windows builder makes each fixture. `tar` copies its bytes into the owned distro folder, so the distro Git reads the same repository.
// A failed fact, a missing C.UTF-8 locale, and a probe mismatch are findings. They print OBSERVATION lines (tasks.md "Test harness rules").
// T063: the service probe and search through the T206 double and the distro Git. The distro Git builds those repositories itself.

import { afterEach, expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import { MATCHING_PROBE_COMMITS, MATCHING_PROBE_RUNS, MATCHING_PROBE_STREAM, MATCHING_PROBE_TIP, MATCHING_PROBE_WSL_FOLDER } from "../../src/contracts/matching-probe";
import type { ProbeRun } from "../../src/git-service/history-search";
import { printOrigin } from "../origin";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { FIXTURE_ROOT, fixtureDir, ownedGit, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { buildSmallFixtures, H200K, largeCase, largeFixture, MARKER_WORD, startPoints, withCommitGraph, type SmallFixture } from "../git/history-fixtures";
import { FactLog, orderFacts, searchArgs, VIEW } from "../git/history-order-facts";
import { isProbe, isSearch, probeLabel, probeOidsOf, SC007_CASES } from "../git/history-view-harness";
import { PERF_CACHE_ROOT } from "../windows/perf-fixtures";
import { buildImported, globalConfig, distroGit as repoGit, startSession, type WslRepo, type WslSession } from "./fixtures";
import { inDistro, missingCapability, uncPath, useWslFolder, wslExec, wslHost, wslTest, type WslCapability, type WslHost } from "./wsl-host";

printOrigin("../../src/contracts/matching-probe.ts", import.meta.dir);
printOrigin("../../src/git-service/history-search.ts", import.meta.dir);
printOrigin("../../src/git-service/git-runner.ts", import.meta.dir);

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

// ---- T063: the matching probe through the `run` field `script` (contract Δ3 "Matching probe", Δ6, Δ11). `Local: WSL`. ----

const T063 = "T063";
const SESSION_NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"];
const SESSION_TIMEOUT_MS = 300_000;
// Case (d): a space, `"`, `\"`, `\`, `$`, `'`, and a backtick. It holds no `\E`, so the filter text check admits it.
const SPECIAL = 'x "q" \\"b\\" \\ $HOME \'s\' `id` y';
// The probe stream, then one commit on `refs/heads/probe` whose message holds SPECIAL.
const SPECIAL_STREAM = (() => {
  const message = Buffer.from(`probe special ${SPECIAL}\n`);
  const at = `Arbareto Probe <probe@arbareto.invalid> ${1_700_000_000 + MATCHING_PROBE_COMMITS.length} +0000`;
  const head = `commit refs/heads/probe\nmark :${MATCHING_PROBE_COMMITS.length + 1}\nauthor ${at}\ncommitter ${at}\ndata ${message.length}\n`;
  return Buffer.concat([MATCHING_PROBE_STREAM, Buffer.from(head), message, Buffer.from(`\nfrom :${MATCHING_PROBE_COMMITS.length}\n\n`)]);
})();

let runners: BunRunner[] = [];
// Each dispose ends the WSL scopes of the runner through `wsl.exe`, so the hook takes the case bound.
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
}, SESSION_TIMEOUT_MS);

function probeSession(host: WslHost, options: { historyProbeRuns?: ProbeRun[]; wslLocalePath?: string } = {}) {
  const { wslLocalePath, ...session } = options;
  const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment: serviceEnv(), wslGlobalConfig: globalConfig(host), ...(wslLocalePath ? { wslLocalePath } : {}) });
  runners.push(runner);
  return { runner, s: startSession(runner, session) };
}

type ProbeView = { repositoryId: string; viewId: string };

async function openProbeView(s: WslSession, host: WslHost, repo: WslRepo): Promise<ProbeView> {
  const registered = await s.response(s.chooseRepository(uncPath(host, repo.dir)));
  expect(registered).toMatchObject({ state: "succeeded" });
  const w = registered.result as { repositoryId: string; generation: number };
  const opened = await s.response(s.request("openHistory", { scope: "all" }, { repositoryId: w.repositoryId, repositoryGeneration: w.generation }));
  expect(opened).toMatchObject({ state: "succeeded" });
  return { repositoryId: w.repositoryId, viewId: (opened.result as { viewId: string }).viewId };
}

type Searched = { state: string; code?: string; result?: Record<string, unknown>; oids: string[] };

// One search, and the OIDs of its filter rows. One page holds every match of these repositories.
async function searchView(s: WslSession, view: ProbeView, text: string): Promise<Searched> {
  const done = await s.response(s.request("searchHistory", { viewId: view.viewId, text }, { repositoryId: view.repositoryId }));
  if (done.state !== "succeeded") return { state: done.state, code: done.code, result: done.result, oids: [] };
  const page = await s.response(s.request("readHistoryRows", { viewId: view.viewId, mode: "filter", searchId: done.operationId, at: { row: 0 }, count: 512, text: "none" }, { repositoryId: view.repositoryId }));
  const rows = (page.result?.rows ?? []) as { oid: string }[];
  expect({ state: page.state, rows: rows.length }).toEqual({ state: "succeeded", rows: done.result!.matches as number });
  return { state: done.state, oids: rows.map((r) => r.oid) };
}

// The type, mode, size, modification time, and path of each entry, and the bytes of each file. The digest runs in the distro.
function distroDigest(host: WslHost, dir: string): string {
  const script = 'cd "$1" && { /usr/bin/find . -printf "%y %m %s %T@ %p\\n" | LC_ALL=C /usr/bin/sort; /usr/bin/find . -type f -print0 | LC_ALL=C /usr/bin/sort -z | /usr/bin/xargs -0 -r /usr/bin/sha256sum; } | /usr/bin/sha256sum';
  return inDistro(host.distro, ["/bin/sh", "-c", script, "sh", dir]).trim();
}

// test(1): exit 0 when the path exists, 1 when it does not.
const testExists = (host: WslHost, path: string) => wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/test", "-e", path]).exitCode;

const refusal = (got: Searched) => {
  const remedy = got.result?.remedy as { text: string; command: string | null } | undefined;
  return { state: got.state, code: got.code, reason: got.result?.reason, command: remedy?.command, remedy: (remedy?.text.length ?? 0) > 0 };
};
const UNSUPPORTED = { state: "failed", code: "SEARCH_UNSUPPORTED", reason: "matching", command: null, remedy: true };

wslTest(
  "T063 (a): the first search runs one matchingProbe script call, each SC-007 case matches exactly its probe commits, the probe folder is gone, and the repository does not change",
  SESSION_NEEDS,
  async (host) => {
    const repo = buildImported(host, "t063-probe", SPECIAL_STREAM);
    const { runner, s } = probeSession(host);
    const view = await openProbeView(s, host, repo);
    const before = distroDigest(host, repo.dir);
    for (const [text, labels] of SC007_CASES) {
      const got = await searchView(s, view, text);
      expect({ text, state: got.state, code: got.code, labels: got.oids.map(probeLabel).toSorted() }).toEqual({ text, state: "succeeded", code: undefined, labels: probeOidsOf(labels).map(probeLabel).toSorted() });
    }
    // Only the first search runs the probe.
    const probes = runner.calls.filter(isProbe);
    expect(probes.map((c) => ({ script: c.script, policy: c.environmentPolicy, exit: c.exit?.exitCode }))).toEqual([{ script: "matchingProbe", policy: "search", exit: 0 }]);
    expect(runner.calls.findIndex(isSearch)).toBeGreaterThan(runner.calls.indexOf(probes[0]!));
    expect(runner.calls.filter(isSearch).length).toBe(SC007_CASES.length);
    const dir = probes[0]!.arguments[0]!;
    expect(dir.startsWith(MATCHING_PROBE_WSL_FOLDER)).toBe(true);
    expect(testExists(host, dir)).toBe(1);
    expect(distroDigest(host, repo.dir)).toBe(before);
  },
  SESSION_TIMEOUT_MS,
);

wslTest(
  "T063 (b): a probe mismatch gives SEARCH_UNSUPPORTED reason matching with a remedy, command null, and no search process, and the next search gives the same without a probe",
  SESSION_NEEDS,
  async (host) => {
    const repo = buildImported(host, "t063-mismatch", SPECIAL_STREAM);
    // The test-only session option: one expected match leaves each run, so the real probe output no longer equals it.
    const { runner, s } = probeSession(host, { historyProbeRuns: MATCHING_PROBE_RUNS.map((run) => ({ grep: run.grep, matches: run.matches.slice(1) })) });
    const view = await openProbeView(s, host, repo);
    for (const attempt of [1, 2]) {
      expect({ attempt, ...refusal(await searchView(s, view, "probe")) }).toEqual({ attempt, ...UNSUPPORTED });
      expect({ attempt, probes: runner.calls.filter(isProbe).length, searches: runner.calls.filter(isSearch).length }).toEqual({ attempt, probes: 1, searches: 0 });
    }
  },
  SESSION_TIMEOUT_MS,
);

// Case (c) needs a fact of the distro: `LC_ALL=C.UTF-8 locale charmap` with an empty `LOCPATH` folder prints the C codeset.
// The check runs before the case. Another answer is a finding, and the case skips with the capability name.
const LOCALE_CAPABILITY = "empty-locpath-hides-c-utf8";
const C_CODESET = "ANSI_X3.4-1968";
const emptyLocaleCharmap = (host: WslHost, folder: string) =>
  wslExec(["--distribution", host.distro, "--cd", "/", "--exec", "/usr/bin/env", "LC_ALL=C.UTF-8", `LOCPATH=${folder}`, "/usr/bin/locale", "charmap"]);
const localeCase = "T063 (c): with an empty LOCPATH folder, the probe gives SEARCH_UNSUPPORTED reason matching with a remedy and no search process";
const localeHost = missingCapability(SESSION_NEEDS) === null ? wslHost() : null;
const localeFact = (() => {
  if (localeHost === null) return null;
  const folder = inDistro(localeHost.distro, ["/usr/bin/mktemp", "-d"]).trim();
  try {
    return emptyLocaleCharmap(localeHost, folder);
  } finally {
    inDistro(localeHost.distro, ["/usr/bin/rmdir", "--", folder]);
  }
})();
if (localeFact !== null && (localeFact.exitCode !== 0 || localeFact.stdout !== `${C_CODESET}\n`)) {
  console.log(`OBSERVATION ${T063}: ${localeHost!.distro}: LC_ALL=C.UTF-8 locale charmap with an empty LOCPATH folder gives ${JSON.stringify(localeFact.stdout)} with exit ${localeFact.exitCode}, not ${C_CODESET} (finding)`);
  console.log(`SKIP ${LOCALE_CAPABILITY}: ${localeCase}`);
  test.skip(`${localeCase} (SKIP: ${LOCALE_CAPABILITY})`, () => {});
} else
  wslTest(
    localeCase,
    SESSION_NEEDS,
    async (host) => {
      const locale = `${host.folder}/t063-empty-locale`;
      inDistro(host.distro, ["/usr/bin/mkdir", "--", locale]);
      const charmap = emptyLocaleCharmap(host, locale);
      console.log(`OBSERVATION ${T063}: ${host.distro}: LC_ALL=C.UTF-8 locale charmap with LOCPATH=${locale} gives ${JSON.stringify(charmap.stdout)} with exit ${charmap.exitCode}`);
      expect({ exit: charmap.exitCode, stdout: charmap.stdout }).toEqual({ exit: 0, stdout: `${C_CODESET}\n` });
      const repo = buildImported(host, "t063-locale", SPECIAL_STREAM);
      const { runner, s } = probeSession(host, { wslLocalePath: locale });
      const view = await openProbeView(s, host, repo);
      expect(refusal(await searchView(s, view, "probe"))).toEqual(UNSUPPORTED);
      expect({ probes: runner.calls.filter(isProbe).map((c) => c.script), searches: runner.calls.filter(isSearch).length }).toEqual({ probes: ["matchingProbe"], searches: 0 });
    },
    SESSION_TIMEOUT_MS,
  );

wslTest(
  "T063 (d): a text with a space, a quote, a backslash-quote, a backslash, a dollar sign, an apostrophe, and a backtick matches exactly its fast-import commit",
  SESSION_NEEDS,
  async (host) => {
    const repo = buildImported(host, "t063-special", SPECIAL_STREAM);
    const tip = repoGit(repo, ["rev-parse", "--verify", "refs/heads/probe"]).trim();
    expect(repoGit(repo, ["log", "-1", "--format=%B", tip])).toBe(`probe special ${SPECIAL}\n\n`);
    const { s } = probeSession(host);
    const view = await openProbeView(s, host, repo);
    expect(await searchView(s, view, SPECIAL)).toEqual({ state: "succeeded", oids: [tip] });
  },
  SESSION_TIMEOUT_MS,
);
