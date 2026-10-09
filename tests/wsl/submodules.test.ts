// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T232: submodule review and update of a WSL repository with F31 (contract §6 "Activity and stall notice", §11, §12 "WSL repositories").
// The WSL routes of `submodule-review.ts` and `submodule-update.ts` come with T233, after T229 and T230. The oracle is the distro Git in a disposable copy.

import { afterEach, describe, expect, test } from "bun:test";
import { STALL_NOTICE_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { valuesOf } from "../git/hunk-harness";
import { commandOf, objectsWith } from "../git/submodule-harness";
import type { SubmoduleRowResult } from "../../src/contracts/submodules";
import { buildF31, distroGit, distroSubmoduleOracle, distroSubmoduleState, globalConfig, startSession, type F31, type WslSession } from "./fixtures";
import { inDistro, listScopes, missingCapability, pgrep, uncPath, useWslFolder, wslHost, type WslCapability, type WslHost } from "./wsl-host";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);

const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"];
const TODO = "(needs T230/T231/T233)";
const CASE_TIMEOUT_MS = 600_000;
// Contract §11 "Process ownership": no Linux process of the operation remains 1 second after the Job close.
const AFTER_CLOSE_MS = 1_000;
// plan.md F31: the sleeping hook shows the stall notice within 20 seconds through the anchor I/O sum.
const STALL_BOUND_MS = 20_000;
// T232: a silent fetch of the F31 blob completes under a test-injected 2-second inactivity limit.
const SHORT_INACTIVITY_MS = 2_000;

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
// Each dispose ends the WSL scopes of the runner through `wsl.exe`, so the hook takes the case bound.
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
}, CASE_TIMEOUT_MS);

// Prints the ORIGIN line of each module under test and loads it. Before T229 and T230, a module is missing, and this throws.
async function underTest(): Promise<void> {
  for (const module of ["submodule-review", "submodule-update"]) {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
    await import(`../../src/git-service/${module}.ts`);
  }
}

// A todo case of a module that does not exist yet. A missing capability skips it and names the capability, as `wslTest` does.
function wslTodo(name: string, body: (host: WslHost) => Promise<void>): void {
  const missing = missingCapability(NEEDS);
  if (missing !== null) {
    console.log(`SKIP ${missing}: ${name}`);
    test.skip(`${name} (SKIP: ${missing})`, () => {});
    return;
  }
  test.todo(`${name} ${TODO}`, () => body(wslHost()!), CASE_TIMEOUT_MS);
}

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
  const approved = await s.response(s.request("approveTrust", { fingerprint: (trust.result as { fingerprint: string }).fingerprint, approve: true }, envelope));
  expect(approved).toMatchObject({ state: "succeeded" });
  const read = await s.response(s.request("readWorkspace", { refresh: false, check: "full" }, { repositoryId }));
  const snapshot = read.result as { snapshotId: string; generation: number };
  const review = await s.response(s.request("reviewSubmodules", { snapshotId: snapshot.snapshotId }, { repositoryId, repositoryGeneration: snapshot.generation }));
  expect({ state: review.state, refusals: valuesOf(review.result, "reason") }).toEqual({ state: "succeeded", refusals: [] });
  return { repositoryId, generation: snapshot.generation, trustId: (approved.result as { trustId: string }).trustId, token: valuesOf(review.result, "submoduleReviewToken")[0] as string };
}

const sendUpdate = (s: WslSession, p: Prepared) => s.request("updateSubmodules", { submoduleReviewToken: p.token, start: true }, { repositoryId: p.repositoryId, repositoryGeneration: p.generation });
const rowOf = (result: unknown, path: string) => objectsWith<SubmoduleRowResult>(result, ["rowId", "state", "fetched"]).filter((row) => row.path === path);
const operationOf = (s: WslSession, requestId: string) => s.progressOf(requestId)[0]?.operationId;
const headOf = (f: F31, path: string) => distroGit({ host: f.sup.host, dir: `${f.sup.dir}/${path}` }, ["rev-parse", "HEAD"]).trim();
const readCanary = (f: F31) => inDistro(f.sup.host.distro, ["/usr/bin/cat", "--", f.canary]);
const tmpPacks = (f: F31, name: string) => inDistro(f.sup.host.distro, ["/usr/bin/find", `${f.sup.dir}/.git/modules/${name}/objects/pack`, "-name", "tmp_pack_*"], { allowExit: [0, 1] }).trim();

async function until(condition: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await Bun.sleep(100);
  }
}

describe("WSL submodule update with Git 2.55.0 (T232)", () => {
  wslTodo("F31 base: the review and the update give the HEADs, Git folders, and submodule keys of the distro Git's own update --init --recursive in a copy", async (host) => {
    await underTest();
    const f = buildF31(host, "base");
    const oracle = distroSubmoduleOracle(f.sup, `${f.root}/oracle`);
    const { s } = setup(host);
    const response = await s.response(sendUpdate(s, await prepare(s, f)));
    expect({ state: response.state, code: response.code, oracle: oracle.exitCode }).toEqual({ state: "succeeded", code: undefined, oracle: 0 });
    expect(distroSubmoduleState(f.sup)).toEqual({ heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys });
  });

  wslTodo("F31 tty: the post-checkout hook cannot open /dev/tty, and it sees GIT_TERMINAL_PROMPT=0", async (host) => {
    await underTest();
    const f = buildF31(host, "tty");
    const { s } = setup(host);
    const response = await s.response(sendUpdate(s, await prepare(s, f)));
    expect(response.state).toBe("succeeded");
    const fields = /^prompt=(\S+) tty=(\d+)\n$/.exec(readCanary(f));
    expect({ prompt: fields?.[1], ttyFailed: fields !== null && fields[2] !== "0" }).toEqual({ prompt: "0", ttyFailed: true });
  });

  wslTodo("F31 linger: the anchor counts the lingering hook child in lingeringDescendants, and Revoke trust ends it", async (host) => {
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

  wslTodo("F31 silent-fetch: the fetch of the 300 MB blob completes under a test-injected 2-second inactivity limit, because the anchor I/O sum changes", async (host) => {
    await underTest();
    const f = buildF31(host, "silent-fetch");
    const { runner, s } = setup(host);
    const p = await prepare(s, f);
    runner.inject.limits = { inactivityMs: SHORT_INACTIVITY_MS };
    const from = runner.calls.length;
    const response = await s.response(sendUpdate(s, p));
    const fetches = runner.calls.slice(from).filter((c) => commandOf(c.arguments)[0] === "fetch");
    expect({ state: response.state, fetches: fetches.length > 0, deadlines: fetches.map((c) => c.exit?.deadline ?? null) }).toEqual({ state: "succeeded", fetches: true, deadlines: fetches.map(() => null) });
    expect(headOf(f, "big")).toBe(f.recorded.big!);
  });

  wslTodo("F31 uploadpack: the fetch step runs with GIT_PROTOCOL_FROM_USER=0 inside the distro", async (host) => {
    await underTest();
    const f = buildF31(host, "uploadpack");
    const { s } = setup(host);
    const response = await s.response(sendUpdate(s, await prepare(s, f)));
    expect({ state: response.state, canary: readCanary(f), head: headOf(f, "solo") }).toEqual({ state: "succeeded", canary: "0\n", head: f.recorded.solo! });
  });

  wslTodo("F31 prune: a row whose HEAD only a pruned remote-tracking ref holds ends refused with unsaved-commits, and its HEAD stays", async (host) => {
    await underTest();
    const f = buildF31(host, "prune");
    const { s } = setup(host);
    const response = await s.response(sendUpdate(s, await prepare(s, f)));
    expect(rowOf(response.result, "solo").map((row) => ({ state: row.state, reason: row.reason, fetched: row.fetched }))).toEqual([{ state: "refused", reason: "unsaved-commits", fetched: true }]);
    expect(headOf(f, "solo")).toBe(f.heads.solo!);
  });

  wslTodo("F31 sleep: the sleeping hook sends stalled within 20 seconds through the anchor I/O sum, and Cancel ends it", async (host) => {
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
    s.request("cancel", { operationId: operationOf(s, requestId) });
    await s.response(requestId);
    await Bun.sleep(AFTER_CLOSE_MS);
    expect(pgrep(host, operationOf(s, requestId)!)).toEqual([]);
  });

  for (const ending of ["cancel", "close"] as const) {
    wslTodo(`F31 big-clone: after ${ending === "cancel" ? "Cancel" : "a simulated close"} during the clone, pgrep finds no process of the operation, and no arbareto-* scope remains`, async (host) => {
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
        s.request("cancel", { operationId: operationOf(s, requestId) });
        await s.response(requestId);
      } else runner.failService();
      await Bun.sleep(AFTER_CLOSE_MS);
      expect(pgrep(host, operationOf(s, requestId)!)).toEqual([]);
      expect(listScopes(host)).toEqual([]);
    });
  }
});
