// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T232: submodule review and update of a WSL repository with F31 (contract §6 "Activity and stall notice", §11, §12 "WSL repositories").
// T233 routes `submodule-review.ts` and `submodule-update.ts` through contract §11. The oracle is the distro Git in a disposable copy.

import { afterEach, describe, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { STALL_NOTICE_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { psQuote, valuesOf } from "../git/hunk-harness";
import { withFsCalls, type FsCall } from "../git/service-harness";
import { commandOf, isTrackCall, objectsWith, oracleExcept, shortUpstream, statusBranchMark } from "../git/submodule-harness";
import type { SubmodulePlanRow, SubmoduleRowResult } from "../../src/contracts/submodules";
import { buildF31, distroGit, distroSubmoduleOracle, distroSubmoduleState, globalConfig, startSession, writeLinux, type F31, type WslRepo, type WslSession } from "./fixtures";
import { inDistro, listScopes, pgrep, uncPath, useWslFolder, WSL_EXE, wslTest, type WslCapability, type WslHost } from "./wsl-host";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);

const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"];
const CASE_TIMEOUT_MS = 600_000;
// Contract §11 "Process ownership": no Linux process of the operation remains 1 second after the Job close.
const AFTER_CLOSE_MS = 1_000;
// plan.md F31: the sleeping hook shows the stall notice within 20 seconds through the anchor CPU-time sum.
const STALL_BOUND_MS = 20_000;
// T232: a silent fetch of the F31 blob completes under a test-injected 2-second inactivity limit.
const SHORT_INACTIVITY_MS = 2_000;
// Contract §6 "Activity and stall notice": a blocked read uses no CPU time, so a test-injected 3-second stall limit fires.
// The bound adds the 1-second sample period and the checkout start before the hook.
const SHORT_STALL_MS = 3_000;
const READ_STALL_BOUND_MS = 10_000;

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
let caseHost: WslHost | undefined;
// Each dispose ends the WSL scopes of the runner through `wsl.exe`, so the hook takes the case bound.
// An F31 folder holds up to 2 GB. Its Linux page cache stays until the files go, so each case removes its F31 folders.
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
  const host = caseHost;
  caseHost = undefined;
  if (host === undefined) return;
  inDistro(host.distro, ["/usr/bin/find", host.folder, "-mindepth", "1", "-maxdepth", "1", "-name", "f31-*", "-exec", "/usr/bin/rm", "-rf", "--one-file-system", "--", "{}", "+"], { timeoutMs: 120_000 });
}, CASE_TIMEOUT_MS);

// Prints the ORIGIN line of each module under test and loads it.
async function underTest(): Promise<void> {
  for (const module of ["submodule-review", "submodule-update"]) {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
    await import(`../../src/git-service/${module}.ts`);
  }
}

const wslCase = (name: string, body: (host: WslHost) => Promise<void>) =>
  wslTest(
    name,
    NEEDS,
    (host) => {
      caseHost = host;
      return body(host);
    },
    CASE_TIMEOUT_MS,
  );

function setup(host: WslHost): { runner: BunRunner; s: WslSession } {
  const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment: serviceEnv(), wslGlobalConfig: globalConfig(host) });
  runners.push(runner);
  return { runner, s: startSession(runner) };
}

interface Prepared {
  repositoryId: string;
  generation: number;
  trustId: string;
  token: string;
}

// Registration, trust approval for the hooks and programs, a fresh snapshot, and a review without a refusal.
async function prepare(s: WslSession, f: F31): Promise<Prepared> {
  const registered = await s.response(s.chooseRepository(uncPath(f.sup.host, f.sup.dir)));
  expect(registered).toMatchObject({ state: "succeeded" });
  const { repositoryId, generation } = registered.result as { repositoryId: string; generation: number };
  const envelope = { repositoryId, repositoryGeneration: generation };
  const trust = await s.response(s.request("readTrust", {}, { repositoryId }));
  expect(trust).toMatchObject({ state: "succeeded" });
  const approved = await s.response(s.request("approveTrust", { action: "submodules" }, { repositoryId }));
  expect(approved).toMatchObject({ state: "succeeded" });
  const read = await s.response(s.request("readWorkspace", { refresh: false, check: "full" }, { repositoryId }));
  const snapshot = read.result as { snapshotId: string; generation: number };
  const review = await s.response(s.request("reviewSubmodules", { snapshotId: snapshot.snapshotId }, { repositoryId, repositoryGeneration: snapshot.generation }));
  expect({ state: review.state, code: review.code, refusals: valuesOf(review.result, "reason") }).toEqual({ state: "succeeded", code: undefined, refusals: [] });
  return { repositoryId, generation: snapshot.generation, trustId: (approved.result as { trustId: string }).trustId, token: valuesOf(review.result, "submoduleReviewToken")[0] as string };
}

const sendUpdate = (s: WslSession, p: Prepared) => s.request("updateSubmodules", { submoduleReviewToken: p.token, start: true }, { repositoryId: p.repositoryId, repositoryGeneration: p.generation });
const rowOf = (result: unknown, path: string) => objectsWith<SubmoduleRowResult>(result, ["rowId", "state", "fetched"]).filter((row) => row.path === path);
const operationOf = (s: WslSession, requestId: string) => s.progressOf(requestId)[0]?.operationId;
const headOf = (f: F31, path: string) => distroGit({ host: f.sup.host, dir: `${f.sup.dir}/${path}` }, ["rev-parse", "HEAD"]).trim();
const readCanary = (f: F31) => inDistro(f.sup.host.distro, ["/usr/bin/cat", "--", f.canary]);
// Git's own update in a copy runs the hooks and programs of `f`, so the case removes their canary file before the service run.
function oracleOf(f: F31): ReturnType<typeof distroSubmoduleOracle> {
  const oracle = distroSubmoduleOracle(f.sup, `${f.root}/oracle`);
  inDistro(f.sup.host.distro, ["/usr/bin/rm", "-f", "--", f.canary]);
  return oracle;
}
const expectOracle = (f: F31, oracle: ReturnType<typeof distroSubmoduleOracle>, except?: Parameters<typeof oracleExcept>[1]) =>
  expect({ oracle: oracle.exitCode, state: distroSubmoduleState(f.sup) }).toEqual({ oracle: 0, state: oracleExcept(oracle, except) });
const tmpPacks = (f: F31, name: string) => inDistro(f.sup.host.distro, ["/usr/bin/find", `${f.sup.dir}/.git/modules/${name}/objects/pack`, "-name", "tmp_pack_*"], { allowExit: [0, 1] }).trim();

async function until(condition: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await Bun.sleep(100);
  }
}

// T141, T151: the rows and the runs of the WSL list-time record. Spec SC-018 and SC-020 set no WSL budget. The T151 control builds the fixture with 19 rows.
const SC018_ROWS = 20;
const SC018_RUNS = 3;

// T141: `<root>/super` with one submodule of `<root>/leaf.git` at each path. The distro Git's own update leaves each one detached at the tip of `origin/main`.
function markWorld(host: WslHost, name: string, paths: readonly string[]): { root: string; sup: WslRepo } {
  const root = `${host.folder}/${name}-${crypto.randomUUID().slice(0, 8)}`;
  writeLinux(host, globalConfig(host), '[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[protocol "file"]\n\tallow = always\n');
  inDistro(host.distro, ["/usr/bin/mkdir", "-p", "--", `${root}/src/leaf`, `${root}/src/super`]);
  const top = { host, dir: root };
  const leaf = { host, dir: `${root}/src/leaf` };
  const work = { host, dir: `${root}/src/super` };
  for (const bare of ["leaf.git", "super.git"]) distroGit(top, ["init", "-q", "--bare", "-b", "main", bare]);
  distroGit(leaf, ["init", "-q", "-b", "main"]);
  for (const n of [1, 2]) distroGit(leaf, ["commit", "-q", "--allow-empty", "-m", `leaf ${n}`]);
  distroGit(leaf, ["push", "-q", `${root}/leaf.git`, "HEAD:refs/heads/main"]);
  const tip = distroGit(leaf, ["rev-parse", "HEAD"]).trim();
  distroGit(work, ["init", "-q", "-b", "main"]);
  writeLinux(host, `${work.dir}/.gitmodules`, paths.map((p) => `[submodule "${p}"]\n\tpath = ${p}\n\turl = ../leaf.git\n`).join(""));
  distroGit(work, ["add", "--", ".gitmodules"]);
  distroGit(work, ["update-index", "-z", "--index-info"], { input: Buffer.from(paths.map((p) => `160000 ${tip} 0\t${p}\0`).join("")) });
  distroGit(work, ["commit", "-q", "-m", "super"]);
  distroGit(work, ["push", "-q", `${root}/super.git`, "HEAD:refs/heads/main"]);
  distroGit(top, ["clone", "-q", `${root}/super.git`, "super"]);
  const sup = { host, dir: `${root}/super` };
  distroGit(sup, ["submodule", "update", "--init", "-q"], { timeoutMs: 300_000 });
  return { root, sup };
}

// Registration and trust approval, as `prepare` does.
async function registerTrusted(s: WslSession, sup: WslRepo): Promise<string> {
  const registered = await s.response(s.chooseRepository(uncPath(sup.host, sup.dir)));
  expect(registered).toMatchObject({ state: "succeeded" });
  const { repositoryId } = registered.result as { repositoryId: string };
  expect(await s.response(s.request("readTrust", {}, { repositoryId }))).toMatchObject({ state: "succeeded" });
  expect(await s.response(s.request("approveTrust", { action: "submodules" }, { repositoryId }))).toMatchObject({ state: "succeeded" });
  return repositoryId;
}

// A fresh snapshot, then the timed list review.
async function listReview(s: WslSession, repositoryId: string): Promise<{ review: Awaited<ReturnType<WslSession["response"]>>; ms: number }> {
  const read = await s.response(s.request("readWorkspace", { refresh: false, check: "full" }, { repositoryId }));
  const snapshot = read.result as { snapshotId: string; generation: number };
  const at = performance.now();
  const review = await s.response(s.request("reviewSubmodules", { snapshotId: snapshot.snapshotId }, { repositoryId, repositoryGeneration: snapshot.generation }));
  return { review, ms: performance.now() - at };
}

describe("WSL submodule update with Git 2.55.0 (T232)", () => {
  wslCase("F31 base: the review and the update give the HEADs, Git folders, and submodule keys of the distro Git's own update --init --recursive in a copy", async (host) => {
    await underTest();
    const f = buildF31(host, "base");
    const oracle = distroSubmoduleOracle(f.sup, `${f.root}/oracle`);
    const { s } = setup(host);
    const response = await s.response(sendUpdate(s, await prepare(s, f)));
    expect({ state: response.state, code: response.code, oracle: oracle.exitCode }).toEqual({ state: "succeeded", code: undefined, oracle: 0 });
    expect(distroSubmoduleState(f.sup)).toEqual({ heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys });
  });

  // T116 B3-4, contract §12 "WSL repositories": after a refusal of a step `run` past its start, it is open whether Git ran.
  wslCase("F31 refused: a refusal after the first step start sends the process-end version run before any other process", async (host) => {
    await underTest();
    const { RunnerRefusal } = await import("../../src/git-service/git-runner");
    const f = buildF31(host, "base");
    const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment: serviceEnv(), wslGlobalConfig: globalConfig(host) });
    runners.push(runner);
    // The real step runs, and its reply then counts as malformed. `startSession` copies the runner, so the wrapper comes first.
    const run = runner.run;
    let refusedAt: number | null = null;
    runner.run = async (call) => {
      const exit = await run(call);
      if (refusedAt !== null || call.environmentPolicy !== "network") return exit;
      refusedAt = performance.now();
      throw new RunnerRefusal("PROCESS_OWNERSHIP_FAILED");
    };
    const s = startSession(runner);
    const requestId = sendUpdate(s, await prepare(s, f));
    const response = await s.response(requestId);
    const operationId = operationOf(s, requestId);
    const next = runner.calls.find((c) => c.operationId === operationId && refusedAt !== null && c.at >= refusedAt);
    expect({ refused: refusedAt !== null, state: response.state, next: next && { arguments: next.arguments, policy: next.environmentPolicy, count: next.exit?.activeDescendants } }).toEqual({
      refused: true,
      state: "failed-with-effects",
      next: { arguments: ["--no-lazy-fetch", "version"], policy: "mutation", count: 0 },
    });
  });

  wslCase("F31 tty: the post-checkout hook cannot open /dev/tty, and it sees GIT_TERMINAL_PROMPT=0", async (host) => {
    await underTest();
    const f = buildF31(host, "tty");
    const oracle = oracleOf(f);
    const { s } = setup(host);
    const response = await s.response(sendUpdate(s, await prepare(s, f)));
    expect(response.state).toBe("succeeded");
    expectOracle(f, oracle);
    const fields = /^prompt=(\S+) tty=(\d+)\n$/.exec(readCanary(f));
    expect({ prompt: fields?.[1], ttyFailed: fields !== null && fields[2] !== "0" }).toEqual({ prompt: "0", ttyFailed: true });
  });

  wslCase("F31 linger: the anchor counts the lingering hook child in lingeringDescendants, and Revoke trust ends it", async (host) => {
    await underTest();
    const f = buildF31(host, "linger");
    const { s } = setup(host);
    const p = await prepare(s, f);
    const response = await s.response(sendUpdate(s, p));
    expect({ state: response.state, lingering: valuesOf(response.result, "lingeringDescendants") }).toEqual({ state: "succeeded", lingering: [1] });
    expect(pgrep(host, f.pattern).length).toBe(1);
    const revoked = await s.response(s.request("revokeTrust", { trustId: p.trustId }, { repositoryId: p.repositoryId }));
    expect({ state: revoked.state, ended: valuesOf(revoked.result, "endedProcesses") }).toEqual({ state: "succeeded", ended: [1] });
    await Bun.sleep(AFTER_CLOSE_MS);
    expect(pgrep(host, f.pattern)).toEqual([]);
  });

  wslCase("F31 silent-fetch: the fetch of the 300 MB blob completes under a test-injected 2-second inactivity limit, because the anchor CPU-time sum changes", async (host) => {
    await underTest();
    const f = buildF31(host, "silent-fetch");
    const oracle = oracleOf(f);
    const { runner, s } = setup(host);
    const p = await prepare(s, f);
    runner.inject.limits = { inactivityMs: SHORT_INACTIVITY_MS };
    const from = runner.calls.length;
    const response = await s.response(sendUpdate(s, p));
    const fetches = runner.calls.slice(from).filter((c) => commandOf(c.arguments)[0] === "fetch");
    expect({ state: response.state, fetches: fetches.length > 0, deadlines: fetches.map((c) => c.exit?.deadline ?? null) }).toEqual({ state: "succeeded", fetches: true, deadlines: fetches.map(() => null) });
    expect(headOf(f, "big")).toBe(f.recorded.big!);
    expectOracle(f, oracle);
  });

  wslCase("F31 uploadpack: the fetch step runs with GIT_PROTOCOL_FROM_USER=0 inside the distro", async (host) => {
    await underTest();
    const f = buildF31(host, "uploadpack");
    const oracle = oracleOf(f);
    const { s } = setup(host);
    const response = await s.response(sendUpdate(s, await prepare(s, f)));
    expect({ state: response.state, canary: readCanary(f), head: headOf(f, "solo") }).toEqual({ state: "succeeded", canary: "0\n", head: f.recorded.solo! });
    expectOracle(f, oracle);
  });

  wslCase("F31 prune: a row whose HEAD only a pruned remote-tracking ref holds ends refused with unsaved-commits, and its HEAD stays", async (host) => {
    await underTest();
    const f = buildF31(host, "prune");
    const oracle = oracleOf(f);
    const { s } = setup(host);
    const response = await s.response(sendUpdate(s, await prepare(s, f)));
    const rows = rowOf(response.result, "solo");
    expect(rows.map((row) => ({ state: row.state, reason: row.reason, fetched: row.fetched }))).toEqual([{ state: "refused", reason: "unsaved-commits", fetched: true }]);
    expect(headOf(f, "solo")).toBe(f.heads.solo!);
    // Contract §11 "Remedy commands" and §12 "Refusals": the WSL form of the save command names the Linux submodule worktree.
    const head = f.heads.solo!;
    const save = `& ${psQuote(WSL_EXE)} --distribution ${psQuote(host.distro)} --cd / --exec ${psQuote(host.probe.paths.git!)} --no-lazy-fetch -C ${psQuote(`${f.sup.dir}/solo`)} --git-dir=.git branch ${psQuote(`arbareto-saved-${head.slice(0, 12)}`)} ${psQuote(head)}`;
    expect(rows[0]?.remedy?.command).toBe(save);
    expectOracle(f, oracle, { heads: { solo: f.heads.solo! } });
  });

  // Contract §11 "Paths and file access": Git gets Linux paths, and the service reads submodule folders only as UNC metadata.
  wslCase("F31 reuse: the review and the update of a deinitialized submodule pass only Linux paths to Git and read its folders only as UNC metadata", async (host) => {
    await underTest();
    const f = buildF31(host, "tty");
    // `solo` is one commit behind its recorded commit, which `deinit` counts as a local modification.
    distroGit(f.sup, ["submodule", "deinit", "-q", "-f", "--", "solo"]);
    const oracle = oracleOf(f);
    const { runner, s } = setup(host);
    const unc = (linux: string) => uncPath(host, linux);
    // A rooted path without a drive or a UNC prefix is a Linux path that reached a Windows file call.
    const linuxCalls = (calls: FsCall[]) => calls.filter((c) => /^[\\/](?![\\/])/.test(c.path));
    const below = (calls: FsCall[], name: FsCall["name"], linux: string) => calls.filter((c) => c.name === name && c.path.toLowerCase().startsWith(unc(linux).toLowerCase()));
    const reviewed = await withFsCalls(() => prepare(s, f));
    const updated = await withFsCalls(() => s.response(sendUpdate(s, reviewed.value)));
    const calls = [...reviewed.calls, ...updated.calls];
    const solo = `${f.sup.dir}/solo`;
    const modules = `${f.sup.dir}/.git/modules`;
    expect({
      state: updated.value.state,
      head: headOf(f, "solo"),
      linux: linuxCalls(calls),
      opens: [...below(calls, "open", solo), ...below(calls, "open", modules)],
      walked: below(calls, "readdir", modules).length > 0,
      kept: below(calls, "lstat", `${modules}/solo`).length > 0,
      folder: below(calls, "lstat", solo).length > 0,
    }).toEqual({ state: "succeeded", head: f.recorded.solo!, linux: [], opens: [], walked: true, kept: true, folder: true });
    // Every `-C`, `--git-dir`, and `--work-tree` value of a submodule process is a Linux path or the `.git` entry name.
    const values = runner.calls.flatMap((c) => c.arguments.flatMap((a, i) => (a === "-C" ? [c.arguments[i + 1]!] : /^--(?:git-dir|work-tree)=/.test(a) ? [a.slice(a.indexOf("=") + 1)] : [])));
    expect(values.filter((v) => v !== ".git" && !v.startsWith("/"))).toEqual([]);
    expect(values).toContain(`${modules}/solo`);
    expectOracle(f, oracle);
  });

  wslCase("F31 sleep: the sleeping hook sends stalled within 20 seconds through the anchor CPU-time sum, getOperation returns the WSL checkout command in stallRemedy, no progress event holds it, and Cancel ends it", async (host) => {
    await underTest();
    const f = buildF31(host, "sleep");
    const { runner, s } = setup(host);
    const p = await prepare(s, f);
    const from = runner.calls.length;
    const requestId = sendUpdate(s, p);
    const checkout = () => runner.calls.slice(from).find((c) => c.arguments.includes(":(literal)solo") && c.arguments.includes("--no-fetch"));
    await until(() => checkout() !== undefined, "solo checkout step", 120_000);
    const stalled = () => (s.progressOf(requestId) as { stalled?: boolean }[]).some((e) => e.stalled === true);
    await until(stalled, "stalled event", STALL_BOUND_MS + 10_000);
    const elapsed = performance.now() - checkout()!.at;
    console.log(`OBSERVATION T232: the F31 sleeping hook reached stalled ${Math.round(elapsed)} ms after its checkout step started (threshold ${STALL_NOTICE_MS} ms)`);
    expect(elapsed).toBeLessThanOrEqual(STALL_BOUND_MS);
    // Contract §6 "Activity and stall notice", §11 "Remedy commands", and §12 "Remedies": the WSL form of the running checkout step.
    const command = `& ${psQuote(WSL_EXE)} --distribution ${psQuote(host.distro)} --cd / --exec ${psQuote(host.probe.paths.git!)} --no-lazy-fetch -C ${psQuote(f.sup.dir)} submodule update --init --no-fetch -- ${psQuote(":(literal)solo")}`;
    const operation = await s.response(s.request("getOperation", { operationId: operationOf(s, requestId) }));
    expect(valuesOf(operation.result, "stallRemedy")).toEqual([{ command, text: "This command checks out this submodule in a terminal, where Git can ask for input. Then use Update submodules again." }]);
    expect(JSON.stringify(s.progressOf(requestId)).includes(JSON.stringify(command).slice(1, -1))).toBe(false);
    s.request("cancel", { operationId: operationOf(s, requestId) });
    await s.response(requestId);
    await Bun.sleep(AFTER_CLOSE_MS);
    expect(pgrep(host, operationOf(s, requestId)!)).toEqual([]);
  });

  wslCase("F31 read: a hook blocked in a read keeps the anchor CPU-time sum unchanged, so it reaches stalled under a test-injected 3-second stall limit, and Cancel ends it", async (host) => {
    await underTest();
    const f = buildF31(host, "read");
    const { runner, s } = setup(host);
    const p = await prepare(s, f);
    runner.inject.limits = { stallMs: SHORT_STALL_MS };
    const from = runner.calls.length;
    const requestId = sendUpdate(s, p);
    const checkout = () => runner.calls.slice(from).find((c) => c.arguments.includes(":(literal)solo") && c.arguments.includes("--no-fetch"));
    await until(() => checkout() !== undefined, "solo checkout step", 120_000);
    const seen = s.progressOf(requestId).length;
    const stalled = () => (s.progressOf(requestId).slice(seen) as { stalled?: boolean }[]).some((e) => e.stalled === true);
    await until(stalled, "stalled event", READ_STALL_BOUND_MS + 10_000);
    const elapsed = performance.now() - checkout()!.at;
    console.log(`OBSERVATION T233: the F31 read hook reached stalled ${Math.round(elapsed)} ms after its checkout step started (injected limit ${SHORT_STALL_MS} ms)`);
    expect({ canary: readCanary(f), inBound: elapsed <= READ_STALL_BOUND_MS }).toEqual({ canary: "", inBound: true });
    s.request("cancel", { operationId: operationOf(s, requestId) });
    await s.response(requestId);
    await Bun.sleep(AFTER_CLOSE_MS);
    expect(pgrep(host, operationOf(s, requestId)!)).toEqual([]);
  });

  // Contract §11 "Paths and file access": a name without a UNC form is a `path` refusal, never REPOSITORY_UNAVAILABLE.
  wslCase("F31 unc: a gitlink path and a kept-directory walk folder without a UNC form give UNSUPPORTED_SUBMODULE reason path", async (host) => {
    await underTest();
    const f = buildF31(host, "unc");
    const { s } = setup(host);
    const registered = await s.response(s.chooseRepository(uncPath(f.sup.host, f.sup.dir)));
    const { repositoryId } = registered.result as { repositoryId: string };
    const trust = await s.response(s.request("readTrust", {}, { repositoryId }));
    expect(trust).toMatchObject({ state: "succeeded" });
    await s.response(s.request("approveTrust", { action: "submodules" }, { repositoryId }));
    const read = await s.response(s.request("readWorkspace", { refresh: false, check: "full" }, { repositoryId }));
    const snapshot = read.result as { snapshotId: string; generation: number };
    const review = await s.response(s.request("reviewSubmodules", { snapshotId: snapshot.snapshotId }, { repositoryId, repositoryGeneration: snapshot.generation }));
    const refusals = objectsWith<{ reason: string; path: string }>(review.result, ["reason", "path", "text"]).map((r) => ({ reason: r.reason, path: r.path }));
    // The oracle of the walk folder name is the Windows listing of the UNC folder.
    const listed = readdirSync(uncPath(host, `${f.sup.dir}/.git/modules`)).filter((name) => name.startsWith("kept"));
    expect(listed.length).toBe(1);
    expect({ state: review.state, code: review.code, refusals }).toEqual({
      state: "succeeded",
      code: undefined,
      refusals: [
        { reason: "path", path: "bad|link" },
        { reason: "path", path: `${f.sup.dir}/.git/modules/${listed[0]}` },
      ],
    });
  });

  // T141, T151: feature 004 contract Δ12 "Branch marks", spec SC-018 and SC-020 (WSL record without a budget).
  wslCase("branch marks: ahead 1, detached, and gone equal the distro status headers, and the list time per row is recorded for branch and detached HEADs", async (host) => {
    await underTest();
    const named = ["ahead", "detached", "gone"];
    const m = markWorld(host, "t141-marks", named);
    const sub = (path: string) => ({ host, dir: `${m.sup.dir}/${path}` });
    distroGit(sub("ahead"), ["checkout", "-q", "-B", "main", "--track", "origin/main"]);
    distroGit(sub("ahead"), ["commit", "-q", "--allow-empty", "-m", "ahead"]);
    distroGit(sub("gone"), ["checkout", "-q", "-b", "topic", "--track", "origin/main"]);
    distroGit(sub("gone"), ["config", "branch.topic.merge", "refs/heads/missing"]);
    const { runner, s } = setup(host);
    const repositoryId = await registerTrusted(s, m.sup);
    const { review } = await listReview(s, repositoryId);
    const rows = objectsWith<SubmodulePlanRow>(review.result, ["rowId", "action"]);
    const pathOf = new Map(rows.map((row) => [row.rowId, row.path]));
    const marks = Object.fromEntries((valuesOf(review.result, "branches")[0] as { rowId: string; upstream?: string | null }[]).map((mark) => [pathOf.get(mark.rowId), shortUpstream({ ...mark, rowId: undefined })]));
    const oracle = Object.fromEntries(named.map((path) => [path, statusBranchMark(distroGit(sub(path), ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=no"]))]));
    expect({ state: review.state, marks, tracks: runner.calls.filter((c) => isTrackCall(c.arguments)).length }).toEqual({ state: "succeeded", marks: oracle, tracks: 2 });
    expect(marks).toEqual({
      ahead: { state: "branch", ref: "refs/heads/main", upstream: "origin/main", track: { state: "counts", ahead: 1, behind: 0 } },
      detached: { state: "detached" },
      gone: { state: "branch", ref: "refs/heads/topic", upstream: "origin/missing", track: { state: "gone" } },
    });

    // The SC-018 difference in the distro: a branch with an upstream in every row, then every HEAD detached at the same commit.
    const paths = Array.from({ length: SC018_ROWS }, (_, i) => `m${i}`);
    const t = markWorld(host, "t141-time", paths);
    const each = (args: string[]) => {
      for (const path of paths) distroGit({ host, dir: `${t.sup.dir}/${path}` }, args);
    };
    each(["checkout", "-q", "-B", "main", "--track", "origin/main"]);
    const timed = await registerTrusted(s, t.sup);
    await listReview(s, timed);
    const times: Record<"branch" | "detached", number[]> = { branch: [], detached: [] };
    for (let run = 0; run < SC018_RUNS; run++) {
      for (const mode of ["branch", "detached"] as const) {
        each(mode === "branch" ? ["checkout", "-q", "main"] : ["checkout", "-q", "--detach"]);
        const { review: r, ms } = await listReview(s, timed);
        const rows = objectsWith<SubmodulePlanRow>(r.result, ["rowId", "action"]).length;
        expect({ mode, state: r.state, rows, marks: (valuesOf(r.result, "branches")[0] as unknown[]).length }).toEqual({ mode, state: "succeeded", rows: 20, marks: 20 });
        times[mode].push(ms);
      }
    }
    const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;
    const perRow = (mode: "branch" | "detached") => median(times[mode]) / SC018_ROWS;
    console.log(
      `OBSERVATION T151: WSL ${host.distro} SC-020 list time of ${SC018_ROWS} rows, median of ${SC018_RUNS}: branch ${median(times.branch).toFixed(1)} ms, detached ${median(times.detached).toFixed(1)} ms`,
    );
    console.log(
      `OBSERVATION T141: WSL ${host.distro} list review of ${SC018_ROWS} rows, median of ${SC018_RUNS}: branch ${perRow("branch").toFixed(1)} ms per row, detached ${perRow("detached").toFixed(1)} ms per row, difference ${(perRow("branch") - perRow("detached")).toFixed(1)} ms per row (runs: ${JSON.stringify(times)})`,
    );
  });

  for (const ending of ["cancel", "close"] as const) {
    wslCase(`F31 big-clone: after ${ending === "cancel" ? "Cancel" : "a simulated close"} during the clone, pgrep finds no process of the operation, and no arbareto-* scope remains`, async (host) => {
      await underTest();
      const f = buildF31(host, "big-clone");
      const { runner, s } = setup(host);
      const p = await prepare(s, f);
      const requestId = sendUpdate(s, p);
      await until(() => operationOf(s, requestId) !== undefined, "accepted event", 60_000);
      const deadline = Date.now() + 300_000;
      while (tmpPacks(f, "big") === "") {
        if (Date.now() > deadline) throw new Error("tmp_pack file of the big clone: not within 300000 ms");
        await Bun.sleep(200);
      }
      if (ending === "cancel") {
        const from = runner.calls.length;
        s.request("cancel", { operationId: operationOf(s, requestId) });
        await s.response(requestId);
        // Contract §12 "WSL repositories": the process-end run follows the Cancel, and the shell accepts it in a new Job.
        const ends = runner.calls.slice(from).filter((c) => c.environmentPolicy === "mutation" && c.arguments.join(" ") === "--no-lazy-fetch version");
        expect(ends.map((c) => ({ refused: c.refused ?? null, exitCode: c.exit?.exitCode ?? null }))[0]).toEqual({ refused: null, exitCode: 0 });
      } else runner.failService();
      await Bun.sleep(AFTER_CLOSE_MS);
      expect(pgrep(host, operationOf(s, requestId)!)).toEqual([]);
      expect(listScopes(host)).toEqual([]);
    });
  }
});
