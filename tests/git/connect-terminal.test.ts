// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T053: `connectInTerminal` (contract Δ3 and Δ6, data-model §11, plan.md D9, O-9, O-10, FR-009, FR-034, FR-037).
// The service sends `pageant` only on a Windows Git, so every case needs Git for Windows.
// Limits of the shell double:
// - It opens no console and runs no `ls-remote`. A `started` reply only means that the checks passed.
// - `plink.exe` is an empty file that the test makes. The double checks only that it exists.
// - The pull target waits for batch 3 (T066).

import { expect } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { buildFetchFlags, gitRun, type GitHost } from "./remote-fixtures";
import { caseTest, type RegistrationResult, type Service } from "./service-harness";
import { hostFor, native, register, reviewed, run, sendSync, strings, TIMEOUT_MS, withSync } from "./sync-harness";

useFixtureRoot();
printOrigin("../../src/git-service/clone.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

const TASK = "T053";
const WINDOWS = ["shell-double", "git-for-windows"] as const;
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const SECRET = "connect-secret-5d1c";
// Port 9 (discard) has no listener on the test machine, so the push fails at connect.
const PUSH_URL = `http://arbareto-user:${SECRET}@127.0.0.1:9/none.git`;

interface Fixture {
  h: GitHost;
  repo: string;
  plink: string;
  canary: string;
  log: string;
}

// A clone whose `origin` names a missing local path, so each fetch fails. The empty `plink.exe` stand-in only has to exist.
function fixture(tag: string): Fixture {
  const h = hostFor(tag);
  const f = buildFetchFlags(h);
  const repo = `${h.root}/repo`;
  h.copy(f.clone, repo);
  gitRun(h, repo, ["remote", "set-url", "origin", native(`${h.root}/missing.git`)]);
  mkdirSync(native(`${h.root}/putty`));
  const plink = native(`${h.root}/putty/plink.exe`);
  writeFileSync(plink, "");
  const log = `${h.root}/canary.log`;
  const canary = `${h.root}/canary.sh`;
  h.write(canary, `#!/bin/sh\necho ran >> '${log}'\nexit 1\n`);
  return { h, repo, plink, canary, log };
}

const terminals = (service: Service) => service.runner.frames.filter((f) => f.type === "terminal");

function connect(service: Service, operationId: string, repositoryId?: string) {
  return service.request("connectInTerminal", { operationId }, repositoryId === undefined ? {} : { repositoryId });
}

// A failed fetch under plink. Its `pageant` reply is `none`.
async function failedFetch(service: Service, r: RegistrationResult): Promise<string> {
  const response = await run(service, r, { action: "fetch" });
  expect(outcome(response)).toEqual({ state: "failed", code: "GIT_FAILED" });
  return response.operationId!;
}

describeGit("connect in a terminal (T053)", () => {
  caseTest(TASK, "a failed fetch, push, and clone under plink each keep one target; the terminal gets the remote name, the push URL, and the clone URL; no result, log, or event holds the URL", WINDOWS, async () => {
    const f = fixture("t053-targets");
    gitRun(f.h, f.repo, ["config", "remote.origin.pushurl", PUSH_URL]);
    await withSync("t053-targets", async (service) => {
      service.runner.inject.sshClient = { plink: f.plink };
      const r = await register(service, f.repo);
      const first = await failedFetch(service, r);
      const fetch = await failedFetch(service, r);
      // Data-model §11: only the last failed operation of the workspace keeps a target.
      expect(outcome(await connect(service, first, r.repositoryId))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
      expect(terminals(service)).toEqual([]);
      const connected = await connect(service, fetch, r.repositoryId);
      expect({ ...outcome(connected), result: connected.result }).toEqual({ state: "succeeded", code: undefined, result: undefined });
      const [fetchTerminal] = terminals(service);
      expect(fetchTerminal).toMatchObject({ type: "terminal", operationId: connected.operationId, repositoryId: r.repositoryId, target: "origin" });

      gitRun(f.h, f.repo, ["checkout", "-q", "-b", "feature"]);
      const review = await reviewed(service, r, { action: "push", destination: { remote: "origin", branch: "feature", setUpstream: false } });
      const pushed = await service.response(sendSync(service, r, review.syncReviewToken));
      expect(pushed.state).toBe("failed");
      expect(outcome(await connect(service, pushed.operationId!, r.repositoryId))).toEqual({ state: "succeeded", code: undefined });
      expect(terminals(service)[1]).toMatchObject({ repositoryId: r.repositoryId, target: PUSH_URL });

      const destination = native(`${f.h.root}/cloned`);
      const url = native(`${f.h.root}/missing-clone.git`);
      const ids = service.runner.addClone(destination, url);
      const cloned = await service.response(service.send("clone", { url, ...ids }), 120_000);
      expect(outcome(cloned)).toEqual({ state: "failed", code: "GIT_FAILED" });
      expect(outcome(await connect(service, cloned.operationId!))).toEqual({ state: "succeeded", code: undefined });
      const cloneTerminal = terminals(service)[2]!;
      expect(cloneTerminal).toMatchObject({ type: "terminal", target: url });
      expect("repositoryId" in cloneTerminal).toBe(false);
      // The same Git installation runs every terminal.
      expect(new Set(terminals(service).map((t) => t.gitInstallationId)).size).toBe(1);

      // The push URL holds user information. The clone URL shows only in its remedy and output tail (contract Δ3 `clone` step 6).
      const outputs = strings([service.responses, service.progress, service.log()]);
      expect(outputs.filter((t) => t.includes(SECRET) || t.includes(PUSH_URL))).toEqual([]);
      expect(strings(service.log()).filter((t) => t.includes("missing-clone.git") || t.includes("127.0.0.1"))).toEqual([]);
      expect(service.runner.frames.filter((x) => strings(x).some((t) => t.includes(SECRET))).map((x) => x.type)).toEqual(["terminal"]);
      service.runner.inject.sshClient = "git";
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "data-model §11: no target, a sync target without its repositoryId, a clone target with a repositoryId, and the repositoryId of another workspace give UNKNOWN_TARGET, and no terminal request goes out", WINDOWS, async () => {
    const f = fixture("t053-unknown");
    // A linked worktree shares the common directory, so its registration keeps the first workspace (contract §6 "Registration reuse and release").
    const other = `${f.h.root}/other`;
    gitRun(f.h, f.repo, ["worktree", "add", "-q", "-b", "side", "--", other]);
    await withSync("t053-unknown", async (service) => {
      service.runner.inject.sshClient = { plink: f.plink };
      const r = await register(service, f.repo);
      const o = await register(service, other);
      const fetch = await failedFetch(service, r);
      const url = native(`${f.h.root}/missing-clone.git`);
      const ids = service.runner.addClone(native(`${f.h.root}/cloned`), url);
      const cloned = await service.response(service.send("clone", { url, ...ids }), 120_000);
      expect(outcome(cloned)).toEqual({ state: "failed", code: "GIT_FAILED" });
      const unknown = { state: "rejected", code: "UNKNOWN_TARGET" };
      expect(outcome(await connect(service, crypto.randomUUID(), r.repositoryId))).toEqual(unknown);
      expect(outcome(await connect(service, crypto.randomUUID()))).toEqual(unknown);
      expect(outcome(await connect(service, fetch))).toEqual(unknown);
      expect(outcome(await connect(service, cloned.operationId!, r.repositoryId))).toEqual(unknown);
      expect(outcome(await connect(service, fetch, o.repositoryId))).toEqual(unknown);
      expect(terminals(service)).toEqual([]);
      service.runner.inject.sshClient = "git";
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a pageant reply git keeps no target, and a missing plink.exe at connect time gives PUTTY_UNAVAILABLE", WINDOWS, async () => {
    const f = fixture("t053-putty");
    await withSync("t053-putty", async (service) => {
      const r = await register(service, f.repo);
      const plain = await failedFetch(service, r);
      expect(service.runner.frames.filter((x) => x.type === "pageant").length).toBe(1);
      expect(outcome(await connect(service, plain, r.repositoryId))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });

      service.runner.inject.sshClient = { plink: f.plink };
      const fetch = await failedFetch(service, r);
      rmSync(f.plink);
      const response = await connect(service, fetch, r.repositoryId);
      expect({ ...outcome(response), result: response.result }).toEqual({ state: "failed", code: "PUTTY_UNAVAILABLE", result: { reason: "missing", program: "plink", path: f.plink } });
      expect(terminals(service).length).toBe(1);
      service.runner.inject.sshClient = "git";
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-009: a sync target checks approvalRequired.sync and the trust fingerprint first; a difference gives TRUST_REQUIRED or TRUST_CHANGED, and no terminal request goes out", WINDOWS, async () => {
    const f = fixture("t053-trust");
    await withSync("t053-trust", async (service) => {
      service.runner.inject.sshClient = { plink: f.plink };
      const r = await register(service, f.repo);
      const fetch = await failedFetch(service, r);
      gitRun(f.h, f.repo, ["config", "core.sshCommand", f.canary]);
      expect(outcome(await connect(service, fetch, r.repositoryId))).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(terminals(service)).toEqual([]);

      const trust = await service.readTrust(r.repositoryId);
      expect(trust.result!.approvalRequired.sync).toBe(true);
      expect((await service.approveTrust(r.repositoryId, trust.result!.fingerprint, r.generation)).state).toBe("succeeded");
      expect(outcome(await connect(service, fetch, r.repositoryId))).toEqual({ state: "succeeded", code: undefined });
      expect(terminals(service).length).toBe(1);

      const second = `${f.h.root}/canary-2.sh`;
      f.h.write(second, `#!/bin/sh\necho ran >> '${f.log}'\nexit 1\n`);
      gitRun(f.h, f.repo, ["config", "core.sshCommand", second]);
      expect(outcome(await connect(service, fetch, r.repositoryId))).toEqual({ state: "failed", code: "TRUST_CHANGED" });
      expect(terminals(service).length).toBe(1);
      expect(existsSync(native(f.log))).toBe(false);
      service.runner.inject.sshClient = "git";
    });
  }, TIMEOUT_MS);
});
