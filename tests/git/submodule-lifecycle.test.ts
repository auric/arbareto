// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T224: long submodule steps with F30 (contract §5, §6 "Activity and stall notice", "Lingering Jobs", §8, §12 "Deadlines and Cancel", "Reconciliation and outcome").
// `src/git-service/submodule-update.ts` comes with T230, its reconciliation and recovery parts too. T231 registers the operation in the session.
// The double ends the process tree of a run as the shell Job does. It measures activity from output only (T225 runs the real Job cases).

import { describe, expect } from "bun:test";
import { appendFileSync, existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { RECONCILIATION_TARGET_MS, STALL_NOTICE_MS, SUBMODULE_UPDATE_CEILING_MS, SUBMODULE_UPDATE_INACTIVITY_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { fixtureDir, serviceEnv, useFixtureRoot } from "./fixture-root";
import { buildF27, buildF30, type Built } from "./fixtures";
import { fileSha256, workingFileDigests } from "./git-oracle";
import { gitPath, mutationFrames, one, outcome, progressStates, SUCCEEDED, todoCase, until, valuesOf, withService } from "./hunk-harness";
import { gitOpenssl, loopbackCertificate, startHttp401 } from "./http-401";
import { caseTest, openService, type Capability, type Service, type ServiceResponse } from "./service-harness";
import {
  callsSince,
  cloneRemedy,
  commandOf,
  fixtureGit,
  globalEnv,
  miniWorld,
  moduleDirOf,
  resultOf,
  resultsOf,
  reviewSubmodules,
  sendUpdate,
  STEP_TEXT,
  superOf,
  TEXTS,
  underTestSubmodule,
  updateSteps,
  updateSubmodules,
  withFixture,
  type SubmoduleReview,
} from "./submodule-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);

const TASK = "T224";
const SHELL: Capability[] = ["shell-double"];
// The 300 MB builds and the clone of the large remote.
const LONG_TIMEOUT_MS = 600_000;
// Contract §6 "Lingering Jobs" and §8: the child ends within 5 seconds.
const END_MS = 5_000;
// research.md R14 S18: the loopback 401 update fails within 10 seconds.
const LOOPBACK_MS = 10_000;
// A short test-injected limit that a silent step passes at once.
const SHORT_MS = 2_000;
// Contract §9: a `failed-with-effects` outcome carries `FAILED_WITH_EFFECTS`. Each deadline case changed a row before the deadline.
const DEADLINE_FAILED = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };
const STATE_UNKNOWN = { state: "rejected", code: "STATE_UNKNOWN" };

useFixtureRoot();

const update = () => underTestSubmodule("submodule-update");

async function reviewedOk(service: Service, dir: string): Promise<{ repositoryId: string; r: SubmoduleReview }> {
  const { repositoryId } = await service.register(dir);
  const r = await reviewSubmodules(service, repositoryId);
  expect({ state: r.response.state, refusals: r.refusals.map((x) => [x.path, x.reason]), token: typeof r.token }).toEqual({ state: "succeeded", refusals: [], token: "string" });
  return { repositoryId, r };
}

// The `tmp_pack_*` files of a Git folder (research.md R14 S9). A missing folder has none.
const tmpPacks = (gitDir: string) => {
  const pack = join(gitDir, "objects", "pack");
  return existsSync(pack) ? readdirSync(pack).filter((name) => name.startsWith("tmp_pack_")) : [];
};

// The owned global file makes each transfer write a `tmp_pack_*` file, as in research.md R14 S9 (2026-10-08 runs of the F30 builds):
// - A clone from a local path copies the object files and writes no pack. It finished in 1.8 seconds. The `file://` rewrite clone wrote `tmp_pack_*` after 1 second and took 70 seconds.
// - A fetch of fewer than `fetch.unpackLimit` objects (default 100) writes loose objects. With the limit 1, the fetch wrote `tmp_pack_*` after 6 seconds and took 56 seconds.
function packTransport(b: Built): void {
  const root = b.root.replaceAll("\\", "/");
  appendFileSync(globalEnv(b).GIT_CONFIG_GLOBAL, `[url "file:///${root}/"]\n\tinsteadOf = ${root}/\n[fetch]\n\tunpackLimit = 1\n`);
}

const isStep = (path: string) => (c: { arguments: readonly string[] }) => c.arguments.includes(`:(literal)${path}`) && commandOf(c.arguments)[0] === "submodule";
// Contract §6 "Channel frames": a run Cancel sends the run `cancel`, which closes the Job. Then no update step starts.
const canceledRun = (service: Service, operationId: string) => {
  const frame = service.runner.cancels.find((f) => f.operationId === operationId);
  return { cancel: frame !== undefined, later: frame ? updateSteps(service, frame.callsBefore).map((c) => c.arguments) : null };
};
const endedFrame = (service: Service, operationId: string) => service.runner.frames.find((f) => f.type === "ended" && f.operationId === operationId);
// Contract §9: an `updateSubmodules` process deadline gives `DEADLINE` with reason `inactivity` or `ceiling`.
const deadlineOf = (response: ServiceResponse) => ({ ...outcome(response), reasons: valuesOf(response.result, "reason").filter((r) => r === "inactivity" || r === "ceiling") });

// Gives the first Git process that starts during `reconciling` a deadline of 1 ms (`inject.deadlineMs`), or holds it until `release`.
// The progress state of the service is the only signal for the reconciliation start.
function duringReconciling(service: Service, requestId: () => string | undefined, action: "deadline" | "hold"): () => void {
  let armed = true;
  let open = () => {};
  const held = new Promise<void>((resolve) => (open = resolve));
  const release = service.runner.holdStart((call) => {
    const id = requestId();
    const hit = armed && id !== undefined && progressStates(service, id).includes("reconciling");
    if (hit) armed = false;
    if (action === "deadline") service.runner.inject.deadlineMs = hit ? 1 : null;
    return action === "hold" && hit;
  });
  void held.then(release);
  return open;
}

describe("Cancel and deadlines (contract §12 \"Deadlines and Cancel\", research.md R14 S9)", () => {
  // A killed clone keeps HEAD at Git's placeholder `ref: refs/heads/.invalid`. `symbolic-ref -q HEAD` then exits 128, and reconciliation gives unknown.
  todoCase(TASK, `F30 clone: Cancel during the clone of the large remote sends the run cancel and starts no later step, the outcome arrives within 5 seconds, the row states clone-interrupted with its folder and move-out remedy, every S9 file remains, the next review refuses clone-interrupted, and after the move-out the next update reaches the recorded commit while the moved folder keeps every byte (needs the reconciliation HEAD read of a killed clone)`, SHELL, async () => {
    await update();
    const name = "t224-clone-cancel";
    const b = buildF30(gitPath(), name, "clone");
    packTransport(b);
    const sup = superOf(b);
    const recorded = (b.facts.notes.submodules as Record<string, { recorded: string }>).big!.recorded;
    await withFixture(b, name, async (service) => {
      const { repositoryId, r } = await reviewedOk(service, sup);
      const modules = moduleDirOf(b, sup, "big");
      const requestId = sendUpdate(service, repositoryId, r);
      const operationId = await service.operationId(requestId);
      await until(() => tmpPacks(modules).length > 0, "tmp_pack file of the big clone", 120_000);
      const canceledAt = performance.now();
      await service.cancel(operationId);
      const response = await service.response(requestId);
      expect(service.responseAt.get(requestId)! - canceledAt).toBeLessThanOrEqual(RECONCILIATION_TARGET_MS);
      expect(canceledRun(service, operationId)).toEqual({ cancel: true, later: [] });
      const row = resultOf(response, "big");
      expect({ state: row.state, folder: relative(join(sup, "big"), join(sup, row.folderPath ?? "")) === "", text: row.text, command: row.remedy?.command ?? null, connected: row.connected }).toEqual({
        state: "clone-interrupted",
        folder: true,
        text: TEXTS.cloneInterrupted("big"),
        command: null,
        connected: true,
      });
      // research.md R14 S9: `config`, `HEAD`, a `refs` folder without refs, one `tmp_pack_*` file, the `big/.git` file, and the registered URL and `active`.
      expect({
        config: existsSync(join(modules, "config")),
        head: existsSync(join(modules, "HEAD")),
        refs: fixtureGit(b, sup, ["--git-dir", modules, "for-each-ref", "--format=%(refname)"]),
        packs: tmpPacks(modules).length > 0,
        gitFile: lstatSync(join(sup, "big", ".git")).isFile(),
        url: fixtureGit(b, sup, ["config", "--local", "--get", "submodule.big.url"]).trim() !== "",
        active: fixtureGit(b, sup, ["config", "--local", "--get", "submodule.big.active"]).trim(),
      }).toEqual({ config: true, head: true, refs: "", packs: true, gitFile: true, url: true, active: "true" });

      const again = await reviewSubmodules(service, repositoryId);
      expect(again.refusals.map((x) => [x.path, x.reason, x.text, x.remedy?.command ?? null])).toEqual([["big", "clone-interrupted", TEXTS.cloneInterrupted("big"), null]]);

      // The remedy: move the folder out of the repository after all Git tools stop.
      const moved = join(b.root, "big-moved");
      renameSync(join(sup, "big"), moved);
      const bytes = { ...workingFileDigests(moved), ".git": fileSha256(join(moved, ".git")) };
      const next = await reviewSubmodules(service, repositoryId);
      expect(outcome(await updateSubmodules(service, repositoryId, next))).toEqual(SUCCEEDED);
      expect(fixtureGit(b, join(sup, "big"), ["rev-parse", "HEAD"]).trim()).toBe(recorded);
      expect({ ...workingFileDigests(moved), ".git": fileSha256(join(moved, ".git")) }).toEqual(bytes);
    });
  }, LONG_TIMEOUT_MS);

  for (const [limit, inject] of [
    ["inactivity", { inactivityMs: SHORT_MS }],
    ["ceiling", { ceilingMs: SHORT_MS }],
  ] as const) {
    caseTest(TASK, `F30 silent-hook: a test-injected short ${limit} limit gives DEADLINE with reason ${limit}, no later process starts, and the outcome arrives within 5 seconds after the deadline fires (SC-017)`, SHELL, async () => {
      await update();
      const name = `t224-${limit}`;
      const b = buildF30(gitPath(), name, "silent-hook");
      const sup = superOf(b);
      await withFixture(b, name, async (service) => {
        const { repositoryId, r } = await reviewedOk(service, sup);
        service.runner.inject.limits = inject;
        const from = service.runner.calls.length;
        const requestId = sendUpdate(service, repositoryId, r);
        const response = await service.response(requestId);
        expect(deadlineOf(response)).toEqual({ ...DEADLINE_FAILED, reasons: [limit] });
        const calls = callsSince(service, from);
        const expired = calls.findIndex((c) => c.exit?.deadline === limit);
        expect(expired).toBeGreaterThanOrEqual(0);
        const firedAt = calls[expired]!.at + calls[expired]!.durationMs!;
        expect(service.responseAt.get(requestId)! - firedAt).toBeLessThanOrEqual(RECONCILIATION_TARGET_MS);
        expect(updateSteps(service, from + expired + 1).map((c) => c.arguments)).toEqual([]);
      });
    }, LONG_TIMEOUT_MS);
  }

  caseTest(TASK, `F30 silent-fetch: Cancel during the fetch step sends the run cancel and starts no later step; the row ends unchanged with fetched, and the outcome is failed-with-effects`, SHELL, async () => {
    await update();
    const name = "t224-fetch-cancel";
    const b = buildF30(gitPath(), name, "silent-fetch");
    packTransport(b);
    const sup = superOf(b);
    const head = (b.facts.notes.submodules as Record<string, { head: string }>).big!.head;
    await withFixture(b, name, async (service) => {
      const { repositoryId, r } = await reviewedOk(service, sup);
      const modules = moduleDirOf(b, sup, "big");
      const requestId = sendUpdate(service, repositoryId, r);
      const operationId = await service.operationId(requestId);
      await until(() => tmpPacks(modules).length > 0, "tmp_pack file of the big fetch", 120_000);
      await service.cancel(operationId);
      const response = await service.response(requestId);
      expect(canceledRun(service, operationId)).toEqual({ cancel: true, later: [] });
      const row = resultOf(response, "big");
      expect({ outcome: outcome(response), state: row.state, fetched: row.fetched, head: fixtureGit(b, join(sup, "big"), ["rev-parse", "HEAD"]).trim() }).toEqual({
        outcome: { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" },
        state: "unchanged",
        fetched: true,
        head,
      });
    });
  }, LONG_TIMEOUT_MS);

  caseTest(TASK, `F30 silent-fetch: each update request carries the 300-second inactivity limit, the 4-hour ceiling, and the 15-second stall threshold, and a double-reported inactivity exit gives DEADLINE with reason inactivity`, SHELL, async () => {
    await update();
    const name = "t224-silent-fetch";
    const b = buildF30(gitPath(), name, "silent-fetch");
    await withFixture(b, name, async (service) => {
      const { repositoryId, r } = await reviewedOk(service, superOf(b));
      // `big` is the first row in index order, so its fetch is the first update process.
      service.runner.inject.limits = { inactivityMs: 1 };
      const from = service.runner.calls.length;
      const response = await updateSubmodules(service, repositoryId, r);
      const steps = updateSteps(service, from);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) expect(step.limits).toEqual({ inactivityMs: SUBMODULE_UPDATE_INACTIVITY_MS, ceilingMs: SUBMODULE_UPDATE_CEILING_MS, stallMs: STALL_NOTICE_MS });
      expect({ first: commandOf(steps[0]!.arguments)[0], exit: steps[0]!.exit?.deadline }).toEqual({ first: "fetch", exit: "inactivity" });
      expect(deadlineOf(response)).toEqual({ ...DEADLINE_FAILED, reasons: ["inactivity"] });
      expect(resultOf(response, "big").fetched).toBe(true);
    });
  }, LONG_TIMEOUT_MS);
});

describe("reconciliation and lingering (contract §6 \"Lingering Jobs\", §8, §12 \"Reconciliation and outcome\")", () => {
  caseTest(TASK, `F30 child-hook: Cancel during reconciling lets reconciliation finish, lingeringDescendants is 0, ended sets endProcesses, and the background child ends`, SHELL, async () => {
    await update();
    const name = "t224-cancel-reconciling";
    const b = buildF30(gitPath(), name, "child-hook");
    await withFixture(b, name, async (service) => {
      const { repositoryId, r } = await reviewedOk(service, superOf(b));
      let requestId: string | undefined;
      const release = duringReconciling(service, () => requestId, "hold");
      requestId = sendUpdate(service, repositoryId, r);
      const operationId = await service.operationId(requestId);
      try {
        await until(() => progressStates(service, requestId!).includes("reconciling"), "reconciling", 120_000);
        expect((await service.cancel(operationId)).state).not.toBe("rejected");
      } finally {
        release();
      }
      const response = await service.response(requestId);
      expect({ ...outcome(response), lingering: one<number>(response.result, "lingeringDescendants") }).toEqual({ ...SUCCEEDED, lingering: 0 });
      await until(() => endedFrame(service, operationId) !== undefined, "ended frame");
      expect(endedFrame(service, operationId)!.endProcesses).toBe(true);
      await until(() => service.runner.liveRecorded() === 0, "child end", END_MS);
    });
  }, LONG_TIMEOUT_MS);

  caseTest(TASK, `F30 child-hook: without Cancel the child lingers, lingeringDescendants counts it, and Revoke trust ends it`, SHELL, async () => {
    await update();
    const name = "t224-lingering";
    const b = buildF30(gitPath(), name, "child-hook");
    await withFixture(b, name, async (service) => {
      const { repositoryId } = await service.register(superOf(b));
      const trust = await service.readTrust(repositoryId);
      const approved = await service.approveTrust(repositoryId, trust.result!.fingerprint, trust.result!.generation);
      const r = await reviewSubmodules(service, repositoryId);
      const response = await updateSubmodules(service, repositoryId, r);
      expect({ ...outcome(response), lingering: one<number>(response.result, "lingeringDescendants"), live: service.runner.liveRecorded() }).toEqual({ ...SUCCEEDED, lingering: 1, live: 1 });
      const revoked = await service.revokeTrust(repositoryId, approved.result!.trustId);
      expect({ ...outcome(revoked), ended: revoked.result!.endedProcesses }).toEqual({ ...SUCCEEDED, ended: 1 });
      await until(() => service.runner.liveRecorded() === 0, "child end", END_MS);
    });
  }, LONG_TIMEOUT_MS);

  caseTest(TASK, `F27 base: a reconciliation read past its deadline gives unknown and keeps the marker, and the recovery refresh states each row`, SHELL, async () => {
    await update();
    const name = "t224-reconcile-deadline";
    const b = buildF27(gitPath(), name, "base");
    await withFixture(b, name, async (service) => {
      const { repositoryId, r } = await reviewedOk(service, superOf(b));
      let requestId: string | undefined;
      duringReconciling(service, () => requestId, "deadline");
      requestId = sendUpdate(service, repositoryId, r);
      const response = await service.response(requestId);
      expect(outcome(response)).toEqual({ state: "unknown", code: "STATE_UNKNOWN" });
      expect([...service.runner.markers.values()].map((m) => m.operationId)).toEqual([response.operationId!]);
      const refreshed = await service.readWorkspace(repositoryId, { refresh: true, check: "full" });
      expect(outcome(refreshed)).toEqual(SUCCEEDED);
      // The run adds the found row `mid/leaf` after the `mid` clone (data-model §9 `submoduleResults`).
      expect(resultsOf(refreshed).map((row) => row.path).sort()).toEqual([...r.rows.map((row) => row.path), "mid/leaf"].sort());
      await until(() => mutationFrames(service, response.operationId!).includes("resolved"), "resolved frame");
    });
  }, LONG_TIMEOUT_MS);

  caseTest(TASK, `F27 base: after a handshake with restarted true, updateSubmodules gives STATE_UNKNOWN until a refresh true read`, SHELL, async () => {
    await update();
    const name = "t224-restart";
    const b = buildF27(gitPath(), name, "base");
    const sup = superOf(b);
    const service = await openService({ git: gitPath(), name, environment: serviceEnv(globalEnv(b)) });
    await service.register(sup);
    const next = await service.restart();
    try {
      const restored = await next.restoreWorkspace(sup);
      expect(restored.state).toBe("succeeded");
      const id = (restored.result as { repositoryId: string }).repositoryId;
      expect(outcome(await updateSubmodules(next, id, await reviewSubmodules(next, id)))).toEqual(STATE_UNKNOWN);
      expect(outcome(await next.readWorkspace(id, { refresh: true, check: "full" }))).toEqual(SUCCEEDED);
      expect(outcome(await updateSubmodules(next, id, await reviewSubmodules(next, id)))).toEqual(SUCCEEDED);
    } finally {
      await next.dispose();
    }
  }, LONG_TIMEOUT_MS);
});

describe("prompts without a console (contract §12 \"Environment and console\", research.md R14 S17, S18)", () => {
  // The loopback server answers on the event loop, so no synchronous Git command runs between the update request and its response.
  // Contract §7 only preserves `GIT_CONFIG_NOSYSTEM`. The test service environment sets it, so no system credential helper runs.
  for (const mode of ["http", "https"] as const) {
    for (const user of [false, true]) {
      const needs: Capability[] = mode === "https" ? [...SHELL, "openssl"] : SHELL;
      caseTest(TASK, `loopback 401 ${mode}${user ? " with u@" : ""}: the update fails within 10 seconds, the server counted a request, and the row carries registered, a redacted outputTail, and the clone remedy, and the outcome is failed-with-effects`, needs, async () => {
        await update();
        const name = `t224-401-${mode}${user ? "-user" : ""}`;
        const tls = mode === "https" ? loopbackCertificate(gitOpenssl(gitPath())!, fixtureDir(`${name}-tls`)) : undefined;
        const server = startHttp401(tls);
        try {
          const url = user ? server.url.replace("://", "://u@") : server.url;
          const caInfo = tls === undefined ? "" : `[http]\n\tsslCAInfo = ${tls.cert.replaceAll("\\", "/")}\n`;
          const w = miniWorld(name, [{ name: "web", path: "web", url }], () => caInfo);
          await withService({ name, environment: serviceEnv({ ...w.env, GIT_CONFIG_NOSYSTEM: "1" }) }, async (service) => {
            const { repositoryId, r } = await reviewedOk(service, w.sup.dir);
            const sentAt = performance.now();
            const requestId = sendUpdate(service, repositoryId, r);
            const response = await service.response(requestId);
            expect(service.responseAt.get(requestId)! - sentAt).toBeLessThanOrEqual(LOOPBACK_MS);
            expect(server.requests()).toBeGreaterThanOrEqual(1);
            const row = resultOf(response, "web");
            // research.md R14 S37 case C: the failed clone step registers the row, so the outcome has an effect.
            expect({ outcome: outcome(response), state: row.state, registered: row.registered, tail: typeof row.outputTail, remedy: row.remedy }).toEqual({
              outcome: { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" },
              state: "failed",
              registered: true,
              tail: "string",
              remedy: { command: cloneRemedy(w.sup.dir, "web"), text: STEP_TEXT.clone },
            });
            if (user) expect({ redacted: row.outputTail!.includes("<redacted>"), user: row.outputTail!.includes("u@127.0.0.1") }).toEqual({ redacted: true, user: false });
          });
        } finally {
          server.stop();
        }
      }, LONG_TIMEOUT_MS);
    }
  }

  // `ARBARETO_TEST_SSH_URL` names a test SSH server whose host key the account does not know.
  caseTest(TASK, `SSH unknown host key: the update fails without a wait, and the row carries the SSH output in its tail`, [...SHELL, "ssh-server"], async () => {
    await update();
    const name = "t224-ssh-host";
    const w = miniWorld(name, [{ name: "ssh", path: "ssh", url: process.env.ARBARETO_TEST_SSH_URL! }]);
    await withService({ name, environment: serviceEnv({ ...w.env, GIT_CONFIG_NOSYSTEM: "1" }) }, async (service) => {
      const { repositoryId, r } = await reviewedOk(service, w.sup.dir);
      const from = service.runner.calls.length;
      const response = await updateSubmodules(service, repositoryId, r);
      const row = resultOf(response, "ssh");
      expect({ state: row.state, tail: (row.outputTail ?? "").length > 0 }).toEqual({ state: "failed", tail: true });
      const step = updateSteps(service, from).find(isStep("ssh"))!;
      expect(step.durationMs!).toBeLessThan(STALL_NOTICE_MS);
    });
  }, LONG_TIMEOUT_MS);

  // `ARBARETO_TEST_SSH_KEY` names a passphrase key that the server accepts. The fetching row records `ssh` behind its first commit.
  // Windows OpenSSH reads `~/.ssh` from the account profile, not from `HOME` or `USERPROFILE`, so a `core.sshCommand` without arguments cannot name a fixture key.
  // That case needs the key as the default identity of the account. The test never writes `~/.ssh`.
  for (const withArguments of [false, true]) {
    (withArguments ? todoCase : caseTest)(TASK, `SSH passphrase key through a core.sshCommand ${withArguments ? "with arguments: the double reports stalled, getOperation returns the fetch command in stallRemedy, no progress event carries it, and the step ends at a test-injected 5-second inactivity limit (needs T256)" : "without arguments: the update fails without a wait"}`, [...SHELL, "openssh", "ssh-server", "ssh-key"], async () => {
      await update();
      const name = `t224-ssh-key-${withArguments ? "args" : "plain"}`;
      const ssh = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe").replaceAll("\\", "/");
      const key = process.env.ARBARETO_TEST_SSH_KEY!.replaceAll("\\", "/");
      const command = withArguments ? `'${ssh}' -i '${key}' -o StrictHostKeyChecking=accept-new` : `'${ssh}'`;
      const w = miniWorld(name, [{ name: "ssh", path: "ssh", url: process.env.ARBARETO_TEST_SSH_URL! }], () => `[core]\n\tsshCommand = ${command}\n`);
      await withService({ name, environment: serviceEnv({ ...w.env, GIT_CONFIG_NOSYSTEM: "1" }) }, async (service) => {
        const { repositoryId, r } = await reviewedOk(service, w.sup.dir);
        if (withArguments) service.runner.inject.limits = { inactivityMs: 5_000, stallMs: SHORT_MS };
        const from = service.runner.calls.length;
        const requestId = sendUpdate(service, repositoryId, r);
        const operationId = await service.operationId(requestId);
        if (withArguments) {
          await until(() => (service.progress as { requestId?: string; stalled?: boolean }[]).some((p) => p.requestId === requestId && p.stalled === true), "stalled event", 30_000);
          const stalledAt = performance.now();
          const remedy = valuesOf((await service.getOperation(operationId)).result, "stallRemedy")[0] as { command?: string; text: string };
          expect(remedy).toEqual({ command: cloneRemedy(w.sup.dir, "ssh"), text: STEP_TEXT.clone });
          const response = await service.response(requestId);
          expect(deadlineOf(response)).toEqual({ ...DEADLINE_FAILED, reasons: ["inactivity"] });
          const step = updateSteps(service, from).find(isStep("ssh"))!;
          console.log(`OBSERVATION ${TASK}: an SSH passphrase prompt through a core.sshCommand with arguments reached stalled after ${Math.round(stalledAt - step.at)} ms and ended at ${Math.round(step.durationMs!)} ms`);
          expect(JSON.stringify(service.progress).includes(JSON.stringify(remedy.command).slice(1, -1))).toBe(false);
        } else {
          const response = await service.response(requestId);
          const step = updateSteps(service, from).find(isStep("ssh"))!;
          console.log(`OBSERVATION ${TASK}: an SSH passphrase prompt through a core.sshCommand without arguments failed after ${Math.round(step.durationMs!)} ms`);
          expect({ state: resultOf(response, "ssh").state, fast: step.durationMs! < STALL_NOTICE_MS }).toEqual({ state: "failed", fast: true });
        }
      });
    }, LONG_TIMEOUT_MS);
  }
});
