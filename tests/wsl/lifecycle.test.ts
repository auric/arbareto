// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T209: WSL process lifetime with F25 (contract §6 "Lingering Jobs", §11 "Process ownership").
// The seam case runs first and needs no Git 2.55.0 (tasks.md "Test harness rules"). The other cases re-probe the research R13 design change.

import { afterEach, describe, expect } from "bun:test";
import { createBunRunner, type BunRunner } from "../git/bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { buildF25, globalConfig, seamProbe, startSession, type WslRepo, type WslSession } from "./fixtures";
import { inDistro, listScopes, pgrep, uncPath, useWslFolder, wslTest, type WslCapability, type WslHost } from "./wsl-host";

const CASE_TIMEOUT_MS = 240_000;
const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55"];
// Contract §11 "Process ownership": no Linux process of the operation remains 1 second after the Job close.
const AFTER_CLOSE_MS = 1_000;
const CLOSE_TARGET_MS = 5_000;

useFixtureRoot();
useWslFolder();

let runners: BunRunner[] = [];
afterEach(async () => {
  for (const runner of runners) await runner.dispose();
  runners = [];
});

function setup(host: WslHost): { runner: BunRunner; s: WslSession } {
  const runner = createBunRunner({ git: GIT ?? "git", directory: fixtureDir(`runner-${crypto.randomUUID()}`), environment: serviceEnv(), wslGlobalConfig: globalConfig(host) });
  runners.push(runner);
  return { runner, s: startSession(runner) };
}

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(100);
  }
  return true;
}

interface Prepared {
  repositoryId: string;
  generation: number;
  trustId: string;
  snapshotId: string;
}

// Registration, trust approval for the hooks, and a fresh snapshot.
async function prepare(s: WslSession, repo: WslRepo): Promise<Prepared> {
  const registered = await s.response(s.chooseRepository(uncPath(repo.host, repo.dir)));
  expect(registered).toMatchObject({ state: "succeeded" });
  const { repositoryId, generation } = registered.result as { repositoryId: string; generation: number };
  const envelope = { repositoryId, repositoryGeneration: generation };
  const trust = await s.response(s.request("readTrust", {}, { repositoryId }));
  const fingerprint = (trust.result as { fingerprint: string }).fingerprint;
  const approved = await s.response(s.request("approveTrust", { fingerprint, approve: true }, envelope));
  expect(approved).toMatchObject({ state: "succeeded" });
  const read = await s.response(s.request("readWorkspace", { refresh: false, check: "full" }, { repositoryId }));
  const result = read.result as { snapshotId: string; generation: number };
  return { repositoryId, generation: result.generation, trustId: (approved.result as { trustId: string }).trustId, snapshotId: result.snapshotId };
}

// Sends `commit` after `reviewCommit` and returns its request ID.
async function commit(s: WslSession, p: Prepared): Promise<string> {
  const envelope = { repositoryId: p.repositoryId, repositoryGeneration: p.generation };
  const review = await s.response(s.request("reviewCommit", { snapshotId: p.snapshotId }, envelope));
  expect(review).toMatchObject({ state: "succeeded" });
  const reviewToken = (review.result as { reviewToken: string }).reviewToken;
  return s.request("commit", { reviewToken, message: "T209 commit", confirmFullScope: true }, envelope);
}

const operationOf = (s: WslSession, requestId: string) => s.progressOf(requestId)[0]?.operationId;

describe("WSL process lifetime seam (T209)", () => {
  wslTest(
    "a distro without the systemd user manager gives WSL_UNAVAILABLE reason no-user-manager with its remedy text",
    [],
    async (host) => {
      const { runner, s } = setup(host);
      runner.inject.wslProbe = { stdout: seamProbe(host, { version: "git version 2.55.0", scope: "1" }) };
      const response = await s.response(s.chooseRepository(uncPath(host, host.folder)));
      expect(response).toMatchObject({
        state: "failed",
        code: "WSL_UNAVAILABLE",
        result: {
          reason: "no-user-manager",
          text: "Arbareto needs the systemd user manager in this distro to end the processes that Git starts. Set systemd=true under [boot] in /etc/wsl.conf, then restart the distro.",
        },
      });
      expect(runner.wslConfirmations).toEqual([]);
      expect(listScopes(host)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("WSL process lifetime with Git 2.55.0 (T209)", () => {
  wslTest(
    "a read whose clean-filter canary detaches leaves no process after the read ends",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      const { s } = setup(host);
      await prepare(s, f25.filter);
      expect(await until(() => pgrep(host, f25.pattern).length === 0, AFTER_CLOSE_MS)).toBe(true);
      expect(listScopes(host)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "Cancel of a slow hook, a test-injected deadline, and a service failure each leave no process 1 second after the Job close",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      for (const ending of ["cancel", "deadline", "service-failure"] as const) {
        const { runner, s } = setup(host);
        const p = await prepare(s, f25.slow);
        if (ending === "deadline") runner.inject.deadlineMs = 3_000;
        const requestId = await commit(s, p);
        expect(await until(() => pgrep(host, `${f25.pattern} slow`).length > 0, 60_000)).toBe(true);
        if (ending === "cancel") s.request("cancel", { operationId: operationOf(s, requestId) });
        if (ending === "service-failure") runner.failService();
        const response = await s.response(requestId);
        console.log(`OBSERVATION T209: slow hook ${ending}: ${response.state} ${response.code ?? ""}`);
        if (ending === "deadline") expect(response.code).toBe("DEADLINE");
        await Bun.sleep(AFTER_CLOSE_MS);
        expect(pgrep(host, f25.pattern)).toEqual([]);
        expect(pgrep(host, operationOf(s, requestId)!)).toEqual([]);
      }
      expect(listScopes(host)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "the plain, setsid, and nohup children of a post-commit hook linger and count three, the anchor lives across the mutation, and Revoke trust ends them",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      const { runner, s } = setup(host);
      const p = await prepare(s, f25.linger);
      let operationId = "";
      const anchorSeen: boolean[] = [];
      runner.inject.afterWslExit = async (call) => {
        operationId = call.operationId;
        anchorSeen.push(pgrep(host, call.operationId).length > 0);
      };
      const release = runner.holdStart();
      const requestId = await commit(s, p);
      expect(await until(() => operationOf(s, requestId) !== undefined, 30_000)).toBe(true);
      // The anchor starts before the first Git process of the mutation.
      expect(await until(() => pgrep(host, operationOf(s, requestId)!).length > 0, 30_000)).toBe(true);
      release();
      const response = await s.response(requestId);
      expect(response).toMatchObject({ state: "succeeded", result: { lingeringDescendants: 3 } });
      expect(anchorSeen.length).toBeGreaterThan(0);
      expect(anchorSeen.every(Boolean)).toBe(true);
      const children = pgrep(host, f25.pattern);
      expect(children).toHaveLength(3);
      for (const line of children) {
        const pid = line.split(" ")[0]!;
        const group = inDistro(host.distro, ["/usr/bin/cat", "--", `/proc/${pid}/cgroup`]).trim();
        console.log(`OBSERVATION T209: lingering child ${line} in ${group}`);
      }
      // After `ended`, the anchor answers once per second until the children end.
      const counts: number[] = [];
      for (let i = 0; i < 3; i++) {
        counts.push(await runner.lingeringCount(crypto.randomUUID(), uncPath(host, `${f25.linger.dir}/.git`)));
        await Bun.sleep(1_000);
      }
      console.log(`OBSERVATION T209: lingering count ${response.result?.lingeringDescendants}, counts after ended ${counts.join(" ")}, operation ${operationId}`);
      const revoked = await s.response(s.request("revokeTrust", { trustId: p.trustId }, { repositoryId: p.repositoryId }));
      expect(revoked).toMatchObject({ state: "succeeded" });
      expect(JSON.stringify(revoked.result)).toContain("3");
      expect(await until(() => pgrep(host, f25.pattern).length === 0, AFTER_CLOSE_MS)).toBe(true);
      expect(listScopes(host)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a pre-commit hook that opens /dev/tty fails within 10 seconds with GIT_FAILED and its output tail",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      const { s } = setup(host);
      const p = await prepare(s, f25.tty);
      const started = Date.now();
      const response = await s.response(await commit(s, p));
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(response).toMatchObject({ state: "failed", code: "GIT_FAILED" });
      expect(JSON.stringify(response.result)).toContain("reading the terminal");
      expect(listScopes(host)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  wslTest(
    "a simulated application close ends lingering children within 5 seconds",
    NEEDS,
    async (host) => {
      const f25 = buildF25(host);
      const { runner, s } = setup(host);
      const p = await prepare(s, f25.linger);
      expect(await s.response(await commit(s, p))).toMatchObject({ state: "succeeded" });
      expect(pgrep(host, f25.pattern)).toHaveLength(3);
      await runner.dispose();
      expect(await until(() => pgrep(host, f25.pattern).length === 0, CLOSE_TARGET_MS)).toBe(true);
      expect(listScopes(host)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});
