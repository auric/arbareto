// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 004 T081 and 006 T032, T034 service cases: worktrees, settings, trust, submodules, and the Global save through the distro Git (quickstart.md Q20 to Q23). The harness is `workbench-wsl-harness.ts`.

import { describe, expect } from "bun:test";
import { join } from "node:path";
import { GIT_PROCESS_DEADLINE_MS } from "../../src/contracts/limits";
import type { SubmoduleRowResult } from "../../src/contracts/submodules";
import wslProcess from "../../src/contracts/wsl-process.json";
import { createCollector, PROCESS_LIMITS, type GitCall } from "../../src/git-service/git-runner";
import { createBunRunner, createTrustStore } from "../git/bun-runner";
import { obs, observationLine, same, type Observation } from "../git/fact-runner";
import { fixtureDir, serviceEnv } from "../git/fixture-root";
import { commit, commitCalls, outcome, readOk, reviewOk, SUCCEEDED, until, valuesOf } from "../git/hunk-harness";
import { gitRun } from "../git/remote-fixtures";
import { openService, type RegistrationResult, type Service, type ServiceResponse } from "../git/service-harness";
import { commandOf, objectsWith, refusalsOf, resultsOf, updateSteps } from "../git/submodule-harness";
import { gitExe } from "../git/sync-harness";
import { buildF31, distroGit, distroSubmoduleOracle, distroSubmoduleState, globalConfig, seamRepository, sh, startSession } from "./fixtures";
import { inDistro, listScopes, OWN_SCOPE_OPERATIONS, pgrep, uncPath, wslExec, type WslHost } from "./wsl-host";
import { AFTER_CLOSE_MS, at, bytes, canary, changed, confirms, copy, type DistroFixture, fileDigest, globalText, hostOf, L, localConfig, logLines, open, oracleEntries, out, own, refusalOf, request, RESPONSE_MS, review, reviewRun, run, runToken, sendRun, shared, state, steps, subjects, text, token, unavailable, useWorkbenchWsl, W, WITH_EFFECTS, withWsl, worktreeState } from "./workbench-wsl-harness";

useWorkbenchWsl();

describe("worktrees, settings, trust, and submodules through the distro Git (quickstart.md Q20 to Q23)", () => {
  W("Q20 FR-049 to FR-057: readWorktrees gives the distro list with Linux paths; Remove of a dirty worktree needs force and Prune equal the distro Git's own commands on a copy", async (w) => {
    const f = copy(w, "worktrees");
    const o = copy(w, "worktrees");
    const dirty = `${f.root}/wt-dirty`;
    await withWsl(w, "t081-worktrees", async (s) => {
      const r = await open(s, w, f.repo);
      const read = await request<{ entries: unknown[] }>(s, "readWorktrees", {}, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
      expect(outcome(read)).toEqual(SUCCEEDED);
      expect(read.result!.entries).toEqual(oracleEntries(f, f.repo));
      const plan = { worktree: dirty, branch: "refs/heads/dirty-b", head: f.oids.base, tracked: 1, untracked: 1, force: false, deleteBranch: null, submodules: false };
      expect(refusalOf(await review(s, r, { action: "worktree-remove", worktree: dirty, force: false, deleteBranch: false }))).toEqual(unavailable("dirty-tree", { plan }));
      const rv = await token(s, r, { action: "worktree-remove", worktree: dirty, force: true, deleteBranch: false });
      expect(rv.plan).toEqual({ ...plan, force: true });
      let from = s.runner.calls.length;
      expect(outcome(await runToken(s, r, rv.workbenchToken))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([[L, "worktree", "remove", "--force", "--", dirty]]);
      const prune = await token(s, r, { action: "worktree-prune" });
      expect((prune.plan.prunable as { path: string }[]).map((x) => x.path)).toEqual([`${f.root}/wt-prunable`]);
      from = s.runner.calls.length;
      expect(outcome(await runToken(s, r, prune.workbenchToken))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([[L, "worktree", "prune"]]);
    });
    own(o, ["worktree", "remove", "--force", "--", `${o.root}/wt-dirty`]);
    own(o, ["worktree", "prune"]);
    expect(worktreeState(f)).toEqual(worktreeState(o));
    expect(f.h.existing([dirty])).toEqual([]);
  });

  // Spec FR-023: Add worktree through the double's WSL `worktreeAdd` route and its `destination` check.
  W("T034 Q20 FR-052 and FR-053: Add worktree through the service with a new and an existing branch equals the distro Git's own worktree add on a copy; a folder that is not empty and a file give DESTINATION_NOT_EMPTY", async (w) => {
    for (const variant of ["new", "existing"] as const) {
      const f = copy(w, "worktrees");
      const o = copy(w, "worktrees");
      for (const x of [f, o]) own(x, ["branch", "free", x.oids.base!]);
      // An empty folder is a valid destination (contract Δ3 `worktree-add`).
      if (variant === "existing") for (const x of [f, o]) inDistro(w.distro, ["/usr/bin/mkdir", "--", `${x.root}/wt-new`]);
      const dest = `${f.root}/wt-new`;
      const start = f.oids.base!;
      const branch = variant === "new" ? { new: "new-b", start } : { existing: "refs/heads/free" };
      await withWsl(w, `t034-add-${variant}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, { action: "worktree-add", branch, bootstrapId: s.runner.addWorktreeAdd(uncPath(w, dest), r.repositoryId) });
        expect(rv.plan).toEqual({ branch: variant === "new" ? branch : { existing: "refs/heads/free", oid: start }, path: dest, destination: variant === "new" ? "absent" : "empty" });
        const from = s.runner.calls.length;
        const response = await runToken(s, r, rv.workbenchToken);
        expect(outcome(response)).toEqual(SUCCEEDED);
        const run = s.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [c.contextKind, ...c.arguments]);
        expect(run).toEqual([variant === "new" ? ["worktreeAdd", L, "worktree", "add", "-b", "new-b", "--", dest, start] : ["worktreeAdd", L, "worktree", "add", "--", dest, "free"]]);
        expect(response.result!.head).toEqual({ state: "branch", target: "refs/heads/main", oid: start });
      });
      own(o, variant === "new" ? ["worktree", "add", "-q", "-b", "new-b", "--", `${o.root}/wt-new`, start] : ["worktree", "add", "-q", "--", `${o.root}/wt-new`, "free"]);
      expect({ variant, state: worktreeState(f) }).toEqual({ variant, state: worktreeState(o) });
    }
    const f = copy(w, "worktrees");
    f.h.write(`${f.root}/wt-full/keep.txt`, "keep\n");
    f.h.write(`${f.root}/wt-file`, "file\n");
    const before = worktreeState(f);
    await withWsl(w, "t034-add-refused", async (s) => {
      const r = await open(s, w, f.repo);
      for (const [name, reason] of [["wt-full", "not-empty"], ["wt-file", "file"]] as const) {
        const response = await review(s, r, { action: "worktree-add", branch: { new: "fresh", start: f.oids.base! }, bootstrapId: s.runner.addWorktreeAdd(uncPath(w, `${f.root}/${name}`), r.repositoryId) });
        expect({ name, ...refusalOf(response) }).toEqual({ name, state: "failed", code: "DESTINATION_NOT_EMPTY", result: { reason } });
      }
      expect(steps(s)).toEqual([]);
    });
    expect(worktreeState(f)).toEqual(before);
  });

  W("T034 Q20 FR-051 and FR-054: Open worktree registers a listed worktree, and a folder that no record names gives UNKNOWN_TARGET; Remove is unavailable for the main and a locked worktree, and no step starts", async (w) => {
    const f = copy(w, "worktrees");
    inDistro(w.distro, ["/usr/bin/mkdir", "--", `${f.root}/elsewhere`]);
    const before = worktreeState(f);
    const spaces = `${f.root}/wt with spaces`;
    await withWsl(w, "t034-open-remove", async (s) => {
      const r = await open(s, w, f.repo);
      expect(refusalOf(await review(s, r, { action: "worktree-remove", worktree: f.repo, force: true, deleteBranch: true }))).toEqual(unavailable("main-worktree"));
      for (const name of ["wt-locked-reason", "wt-locked"]) expect({ name, ...refusalOf(await review(s, r, { action: "worktree-remove", worktree: `${f.root}/${name}`, force: true, deleteBranch: false })) }).toEqual({ name, ...unavailable("locked") });
      const openWorktree = (path: string, repositoryId: string) => s.response<RegistrationResult>(s.send("openWorktree", { repositoryId, bootstrapId: s.runner.addContext("repositoryDiscovery", uncPath(w, path)) }), RESPONSE_MS);
      const opened = await openWorktree(spaces, r.repositoryId);
      expect(outcome(opened)).toEqual(SUCCEEDED);
      const list = await request<{ entries: { path: string; current: boolean }[] }>(s, "readWorktrees", {}, { repositoryId: opened.result!.repositoryId, repositoryGeneration: opened.result!.generation });
      expect(list.result!.entries.filter((e) => e.current).map((e) => e.path)).toEqual([spaces]);
      expect(list.result!.entries).toEqual(oracleEntries(f, spaces));
      expect(outcome(await openWorktree(`${f.root}/elsewhere`, opened.result!.repositoryId))).toEqual({ state: "failed", code: "UNKNOWN_TARGET" });
      expect(steps(s)).toEqual([]);
    });
    expect(worktreeState(f)).toEqual(before);
  });

  W("Q21 FR-064 and SC-009: a Local save writes only that key in the local file, as the distro Git's own config set on a copy; the global file stays", async (w) => {
    const f = copy(w, "branches");
    const o = copy(w, "branches");
    const global = fileDigest(at(f), f.h.globalConfig);
    await withWsl(w, "t081-config-save", async (s) => {
      const r = await open(s, w, f.repo);
      for (const [key, value] of [["user.name", "Saved Name"], ["fetch.prune", "true"]] as const) {
        const from = s.runner.calls.length;
        const response = await reviewRun(s, r, { action: "config-save", scope: "local", changes: [{ key, value }] });
        expect({ key, ...outcome(response), result: response.result }).toEqual({ key, ...SUCCEEDED, result: { action: "config-save", scope: "local", written: [key] } });
        expect(steps(s, from)).toEqual([[L, "config", "set", "--local", "--", key, value]]);
        own(o, ["config", "set", "--local", "--", key, value]);
      }
    });
    expect(fileDigest(at(f), localConfig(at(f)))).toBe(fileDigest(at(o), localConfig(at(o))));
    expect(fileDigest(at(f), f.h.globalConfig)).toBe(global);
  });

  W("Q22 SC-010: a session without repository programs sends no confirm frame; a pre-commit hook asks exactly once, runs only after approval, and a hook rewrite asks nothing", async (w) => {
    const f = copy(w, "switch-dirty");
    const log = `${f.root}/pre-commit.log`;
    const hook = (body: string) => f.h.write(`${f.repo}/.git/hooks/pre-commit`, `#!/bin/sh\n${body}: >> '${log}'\n`);
    const stageChange = (path: string) => {
      f.h.write(`${f.repo}/${path}`, `${path} change\n`);
      own(f, ["add", "--", path]);
    };
    await withWsl(w, "t081-trust", async (s) => {
      const r = await open(s, w, f.repo);
      const trust = await s.readTrust(r.repositoryId);
      expect({ state: trust.result!.state, approvalRequired: trust.result!.approvalRequired }).toEqual({ state: "untrusted", approvalRequired: { reads: false, commit: false, sync: false, workbench: false, mergetool: false } });
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "no programs\n"))).toEqual(SUCCEEDED);
      expect(confirms(s)).toEqual([]);
      hook("");
      stageChange("a.txt");
      expect((await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "needs trust\n")).code).toBe("TRUST_REQUIRED");
      expect({ confirms: confirms(s).length, canary: f.h.existing([log]) }).toEqual({ confirms: 0, canary: [] });
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual(SUCCEEDED);
      expect(confirms(s).length).toBe(1);
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "after approval\n"))).toEqual(SUCCEEDED);
      expect(logLines(at(f), log)).toEqual([]);
      expect(f.h.existing([log])).toEqual([log]);
      hook("echo rewritten >/dev/null\n");
      stageChange("b.txt");
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "after rewrite\n"))).toEqual(SUCCEEDED);
      expect(confirms(s).length).toBe(1);
    });
    expect(subjects(at(f), [`${f.oids.base}..HEAD`])).toEqual(["no programs", "after approval", "after rewrite"]);
  });

  // A pre-commit hook that records each run in `log`, and one staged change.
  function hookedRepo(w: WslHost): { f: DistroFixture; log: string; stage: (path: string) => void } {
    const f = copy(w, "switch-dirty");
    const log = `${f.root}/pre-commit.log`;
    f.h.write(`${f.repo}/.git/hooks/pre-commit`, `#!/bin/sh\n: >> '${log}'\n`);
    const stage = (path: string) => {
      f.h.write(`${f.repo}/${path}`, `${path} change\n`);
      own(f, ["add", "--", path]);
    };
    stage("a.txt");
    return { f, log, stage };
  }
  const records = (s: Service) => s.trustStore.records as unknown as Record<string, unknown>[];

  W("T034 Q22 FR-072 and FR-074: Not now ends canceled with no Git process and no hook run; Stop trusting removes the record, and the next commit needs trust again", async (w) => {
    const { f, log, stage } = hookedRepo(w);
    await withWsl(w, "t034-not-now", async (s) => {
      const r = await open(s, w, f.repo);
      expect({ state: (await s.readTrust(r.repositoryId)).result!.state, commit: (await s.readTrust(r.repositoryId)).result!.approvalRequired.commit }).toEqual({ state: "untrusted", commit: true });
      const from = s.runner.calls.length;
      expect((await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "needs trust\n")).code).toBe("TRUST_REQUIRED");
      expect(commitCalls(s, from)).toEqual([]);
      s.runner.inject.confirmResult = "declined";
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual({ state: "canceled", code: "CANCELED" });
      const frames = confirms(s) as { callsBefore: number }[];
      expect(frames.length).toBe(1);
      // Spec FR-072: after Not now, no Git process starts.
      expect(s.runner.calls.length).toBe(frames[0]!.callsBefore);
      expect({ log: f.h.existing([log]), records: records(s), state: (await s.readTrust(r.repositoryId)).result!.state }).toEqual({ log: [], records: [], state: "untrusted" });
      s.runner.inject.confirmResult = "approved";
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual(SUCCEEDED);
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "approved\n"))).toEqual(SUCCEEDED);
      expect(f.h.existing([log])).toEqual([log]);
      const trust = (await s.readTrust(r.repositoryId)).result!;
      const revoked = await s.revokeTrust(r.repositoryId, (trust as { trustId?: string }).trustId!);
      expect(outcome(revoked)).toEqual(SUCCEEDED);
      expect({ state: (await s.readTrust(r.repositoryId)).result!.state, records: records(s) }).toEqual({ state: "revoked", records: [] });
      stage("b.txt");
      const next = s.runner.calls.length;
      expect((await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "after revoke\n")).code).toBe("TRUST_REQUIRED");
      expect(commitCalls(s, next)).toEqual([]);
    });
    expect(subjects(at(f), [`${f.oids.base}..HEAD`])).toEqual(["approved"]);
  });

  W("T034 Q22 plan.md O-5: a version 1 record gives changed and asks once, and its version 2 record replaces it; the next session asks nothing", async (w) => {
    const { f, stage } = hookedRepo(w);
    const store = createTrustStore();
    // One session at application start with the shared record store. After the close, no scope of this process remains.
    const inSession = async (name: string, body: (s: Service, r: RegistrationResult) => Promise<void>) => {
      const s = await openService({ git: gitExe(), name, environment: serviceEnv(), wslGlobalConfig: globalConfig(w), trustStore: store });
      try {
        await body(s, await open(s, w, f.repo));
      } finally {
        await s.dispose();
      }
      expect(listScopes(w)).toEqual([]);
    };
    await inSession("t034-v1-first", async (s, r) => {
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual(SUCCEEDED);
      // The 001 record form of the same worktree. Its fingerprint is the approved one when the store wrote a version 1 record.
      const stored = records(s)[0]!;
      const v1 = {
        commonDirectory: stored.commonDirectory,
        commonIdentity: stored.commonIdentity,
        worktreeRoot: stored.worktreeRoot,
        gitDirectory: stored.adminDirectory ?? stored.gitDirectory,
        worktreeIdentity: stored.worktreeIdentity,
        configurationFingerprint: stored.configurationFingerprint ?? "f".repeat(64),
        approvedAt: stored.approvedAt,
        gitSelectedPath: stored.gitSelectedPath,
      };
      store.records = [v1 as never];
    });
    await inSession("t034-v1-second", async (s, r) => {
      expect((await s.readTrust(r.repositoryId)).result!.state).toBe("changed");
      expect((await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "v1\n")).code).toBe("TRUST_CHANGED");
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual(SUCCEEDED);
      expect(confirms(s).length).toBe(1);
      expect(records(s).map((x) => ({ policyVersion: x.policyVersion, fingerprint: "configurationFingerprint" in x }))).toEqual([{ policyVersion: 2, fingerprint: false }]);
    });
    await inSession("t034-v1-third", async (s, r) => {
      expect((await s.readTrust(r.repositoryId)).result!.state).toBe("approved");
      stage("b.txt");
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "v2\n"))).toEqual(SUCCEEDED);
      expect(confirms(s)).toEqual([]);
    });
    expect(subjects(at(f), [`${f.oids.base}..HEAD`])).toEqual(["v2"]);
  });

  W("Q23 SC-011 and FR-076 to FR-082: a one-click update equals the distro Git's own update in a copy; a scoped update of one row touches only that row", async (w) => {
    const full = buildF31(w, "base");
    const oracle = distroSubmoduleOracle(full.sup, `${full.root}/oracle`);
    const scoped = buildF31(w, "base");
    const scopedCopy = `${scoped.root}/scoped-oracle`;
    inDistro(w.distro, ["/usr/bin/cp", "-a", "--", scoped.sup.dir, scopedCopy]);
    const scopedOracle = scoped.sup.host.probe.paths.git!;
    const oracleRun = wslExec(["--distribution", w.distro, "--cd", scopedCopy, "--exec", "/usr/bin/env", `HOME=${w.folder}/home`, `GIT_CONFIG_GLOBAL=${globalConfig(w)}`, "GIT_CONFIG_NOSYSTEM=1", scopedOracle, "submodule", "update", "--init", "--recursive", "--", ":(literal)solo"], { timeoutMs: 120_000 });
    expect(oracleRun.exitCode).toBe(0);
    const scopedExpected = distroSubmoduleState({ host: w, dir: scopedCopy });
    for (const [f, scope] of [[full, undefined], [scoped, "solo"]] as const) {
      await withWsl(w, `t081-submodules-${scope ?? "all"}`, async (s) => {
        const r = await open(s, w, f.sup.dir);
        // The "base" fixture holds no hook, filter, or program, so no class needs approval.
        expect((await s.readTrust(r.repositoryId)).result!.approvalRequired).toEqual({ reads: false, commit: false, sync: false, workbench: false, mergetool: false });
        const read = await readOk(s, r.repositoryId);
        const reviewed = await request(s, "reviewSubmodules", { snapshotId: read.snapshotId, ...(scope === undefined ? {} : { scope: { path: scope } }) }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
        expect({ scope, ...outcome(reviewed), refusals: valuesOf(reviewed.result, "reason") }).toEqual({ scope, ...SUCCEEDED, refusals: [] });
        const updated = await request(s, "updateSubmodules", { submoduleReviewToken: valuesOf(reviewed.result, "submoduleReviewToken")[0], start: true }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
        expect({ scope, ...outcome(updated) }).toEqual({ scope, ...SUCCEEDED });
        if (scope !== undefined) expect(objectsWith<SubmoduleRowResult>(updated.result, ["rowId", "state", "fetched"]).map((row) => row.path)).toEqual([scope]);
      });
    }
    expect({ oracle: oracle.exitCode, state: distroSubmoduleState(full.sup) }).toEqual({ oracle: 0, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
    expect(distroSubmoduleState(scoped.sup)).toEqual(scopedExpected);
  });

  // `reviewSubmodules` of a fresh read, with `scope` when `path` is given (contract Δ12).
  async function submoduleReview(s: Service, repositoryId: string, path?: string) {
    const read = await readOk(s, repositoryId);
    const response = await request(s, "reviewSubmodules", { snapshotId: read.snapshotId, ...(path === undefined ? {} : { scope: { path } }) }, { repositoryId, repositoryGeneration: read.generation });
    return { response, generation: read.generation, token: valuesOf(response.result, "submoduleReviewToken")[0] as string | undefined, refusals: refusalsOf(response.result), hosts: valuesOf(response.result, "hosts")[0] };
  }
  type SubmoduleReviewed = Awaited<ReturnType<typeof submoduleReview>>;
  const sendUpdate = (s: Service, repositoryId: string, r: SubmoduleReviewed, confirmHosts = false) =>
    s.send("updateSubmodules", { submoduleReviewToken: r.token, start: true, ...(confirmHosts ? { confirmHosts: true } : {}) }, { repositoryId, repositoryGeneration: r.generation });
  const runUpdate = (s: Service, repositoryId: string, r: SubmoduleReviewed, confirmHosts = false) => s.response(sendUpdate(s, repositoryId, r, confirmHosts), RESPONSE_MS);
  const rowStates = (response: ServiceResponse) => Object.fromEntries(resultsOf(response).map((row) => [row.path, row.state]));

  W("T034 Q23 FR-049 and FR-079: a refusal gives UNSUPPORTED_SUBMODULE and starts no step; a host line waits for confirmHosts, and the same token then runs and equals the distro Git's own update on a copy", async (w) => {
    // `submodule.solo.active` holds no boolean, so the review refuses it (001 FR-049).
    const refused = buildF31(w, "base");
    distroGit(refused.sup, ["config", "submodule.solo.active", "maybe"]);
    const before = distroSubmoduleState(refused.sup);
    // `solo` fetches from its local `origin`, and the registered URL names another host. No process reaches that host.
    const hosted = buildF31(w, "uploadpack");
    distroGit({ host: w, dir: `${hosted.sup.dir}/solo` }, ["config", "--unset", "remote.origin.uploadpack"]);
    distroGit(hosted.sup, ["config", "submodule.solo.url", "https://git.example.net/solo.git"]);
    const oracle = distroSubmoduleOracle(hosted.sup, `${hosted.root}/oracle`);
    await withWsl(w, "t034-submodule-refusal-hosts", async (s) => {
      const rr = await open(s, w, refused.sup.dir);
      const review = await submoduleReview(s, rr.repositoryId);
      expect(review.refusals.map((x) => x.reason)).toContain("active-value");
      let from = s.runner.calls.length;
      const response = await runUpdate(s, rr.repositoryId, review);
      expect({ code: response.code, reasons: refusalsOf(response.result).map((x) => x.reason), steps: updateSteps(s, from).length }).toEqual({ code: "UNSUPPORTED_SUBMODULE", reasons: review.refusals.map((x) => x.reason), steps: 0 });
      const rh = await open(s, w, hosted.sup.dir);
      const hosts = await submoduleReview(s, rh.repositoryId);
      expect({ ...outcome(hosts.response), refusals: hosts.refusals, hosts: hosts.hosts }).toEqual({ ...SUCCEEDED, refusals: [], hosts: [{ path: "solo", fetch: { kind: "local" }, settings: { kind: "host", name: "git.example.net" } }] });
      from = s.runner.calls.length;
      const waiting = await runUpdate(s, rh.repositoryId, hosts);
      expect({ ...outcome(waiting), reason: valuesOf(waiting.result, "reason"), steps: updateSteps(s, from).length }).toEqual({ state: "rejected", code: "STALE_REVIEW", reason: ["hosts"], steps: 0 });
      expect(outcome(await runUpdate(s, rh.repositoryId, hosts, true))).toEqual(SUCCEEDED);
    });
    expect(distroSubmoduleState(refused.sup)).toEqual(before);
    expect({ oracle: oracle.exitCode, state: distroSubmoduleState(hosted.sup) }).toEqual({ oracle: 0, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
  });

  W("T034 Q23 FR-081 and 001 §12: a failed row, then Retry of that row, equal the distro Git's own update on a copy; Cancel states each row from a fresh read, and no process or scope remains", async (w) => {
    const f = buildF31(w, "base");
    const oracle = distroSubmoduleOracle(f.sup, `${f.root}/oracle`);
    // Without its remote, the `solo` clone fails. The move back is the fix before Retry.
    const remote = `${f.root}/solo.git`;
    inDistro(w.distro, ["/usr/bin/mv", "--", remote, `${remote}.away`]);
    const c = buildF31(w, "base");
    await withWsl(w, "t034-submodule-retry-cancel", async (s) => {
      const r = await open(s, w, f.sup.dir);
      const failed = await runUpdate(s, r.repositoryId, await submoduleReview(s, r.repositoryId));
      expect(rowStates(failed)).toEqual({ mid: "cloned", "mid/leaf": "cloned", solo: "failed" });
      inDistro(w.distro, ["/usr/bin/mv", "--", `${remote}.away`, remote]);
      // FR-081: Retry updates that row and its nested rows only.
      const retry = await submoduleReview(s, r.repositoryId, "solo");
      expect(outcome(retry.response)).toEqual(SUCCEEDED);
      const retried = await runUpdate(s, r.repositoryId, retry);
      expect({ ...outcome(retried), rows: rowStates(retried) }).toEqual({ ...SUCCEEDED, rows: { solo: "cloned" } });

      const rc = await open(s, w, c.sup.dir);
      const review = await submoduleReview(s, rc.repositoryId);
      const isSoloClone = (call: { arguments: readonly string[] }) => commandOf(call.arguments).join(" ") === "submodule update --init --progress -- :(literal)solo";
      const release = s.runner.holdStart(isSoloClone);
      const from = s.runner.calls.length;
      const requestId = sendUpdate(s, rc.repositoryId, review);
      await until(() => s.runner.calls.slice(from).some(isSoloClone) || s.responseAt.has(requestId), "the held solo clone", RESPONSE_MS);
      const operationId = await s.operationId(requestId);
      await s.cancel(operationId);
      release();
      const response = await s.response(requestId, RESPONSE_MS);
      expect(response.state).not.toBe("succeeded");
      const rows = resultsOf(response);
      const heads = distroSubmoduleState(c.sup).heads;
      expect(rows.map((row) => [row.path, row.newCommit])).toEqual(rows.map((row) => [row.path, heads[row.path] ?? null]));
      await Bun.sleep(AFTER_CLOSE_MS);
      expect(pgrep(w, operationId)).toEqual([]);
    });
    expect({ oracle: oracle.exitCode, state: distroSubmoduleState(f.sup) }).toEqual({ oracle: 0, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
  });
});

// ---- Feature 006 T032: the Global save through the distro Git (quickstart.md Q22, plan.md D13 and D14, spec FR-018 to FR-025, SC-005) ----

describe("the Global save through the distro Git (feature 006 T032)", () => {
  const T032 = "T032";
  const WRAPPER = wslProcess.wrapper.join("\n");
  const factLine = (w: WslHost, o: Observation) => console.log(observationLine(T032, o, `git=${w.gitVersion ?? "unknown"}@${w.distro}`));
  const ownedGlobal = (w: WslHost) => globalConfig(w);
  const oracleGlobal = (w: WslHost) => `${w.folder}/home/oracle.gitconfig`;
  const includedGlobal = (w: WslHost) => `${w.folder}/home/included.gitconfig`;
  // Spec FR-060 in Git's canonical form (git-config(1)). The test keeps its own copy, as tests/git/git-settings.test.ts does.
  const FR060 = ["user.name", "user.email", "core.editor", "commit.template", "credential.helper", "diff.tool", "merge.tool", "core.autocrlf", "i18n.filesencoding", "pull.rebase", "fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "pull.ff", "push.default", "push.autosetupremote"];
  const BOOLS = new Set(["fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "push.autosetupremote"]);
  const ENUMS: Record<string, string[]> = { "core.autocrlf": ["true", "false", "input"], "pull.rebase": ["true", "false", "merges", "interactive"], "pull.ff": ["true", "false", "only"], "push.default": ["nothing", "current", "upstream", "simple", "matching"] };
  // A value that differs from the current one and that Git reads for the key type.
  const newValue = (key: string, current: string | null): string => (BOOLS.has(key) ? (current === "true" ? "false" : "true") : (ENUMS[key]?.find((v) => v !== current) ?? `saved ${key}`));
  // The FR-060 keys besides the `globalText` keys. Two `credential.helper` values are multi-valued, and `core.editor` comes from an include (004 plan.md D11).
  const globalKeys = (w: WslHost) =>
    `[include]\n\tpath = ${includedGlobal(w)}\n[commit]\n\ttemplate = global-template.txt\n[credential]\n\thelper = global-helper-1\n\thelper = global-helper-2\n` +
    `[diff]\n\ttool = global-diff\n[difftool "global-diff"]\n\tpath = global-difftool-path\n\tcmd = global-difftool $LOCAL $REMOTE\n` +
    `[merge]\n\ttool = global-merge\n\tautostash = false\n[mergetool "global-merge"]\n\tpath = global-mergetool-path\n\tcmd = global-mergetool $MERGED\n` +
    `[i18n]\n\tfilesEncoding = utf-8\n[pull]\n\trebase = merges\n\tff = only\n[fetch]\n\tprune = false\n[rebase]\n\tautostash = false\n\tautosquash = false\n\tupdateRefs = false\n` +
    `[rerere]\n\tenabled = false\n\tautoUpdate = false\n[push]\n\tdefault = current\n\tautoSetupRemote = false\n`;

  type SaveResult = { action: string; scope: string; written: string[]; failed?: { key: string; exitCode: number | null; reason?: string }; stale?: string; outputTail?: string };
  const save = (changes: { key: string; value: string | null }[]) => ({ action: "config-save", scope: "global", changes });
  const writes = (s: Service, from = 0) => s.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [c.contextKind, ...c.arguments]);
  const globalValues = (f: DistroFixture, key: string) => out(at(f), ["config", "get", "--all", "--global", key], { allowExit: [0, 1] }).split("\n").filter((l) => l !== "");
  const globalDigest = (f: DistroFixture) => fileDigest(at(f), ownedGlobal(f.w));
  const runSave = async (s: Service, r: RegistrationResult, changes: { key: string; value: string | null }[]) => s.response<SaveResult>(sendRun(s, r, (await token(s, r, save(changes))).workbenchToken), RESPONSE_MS);

  let wrapperRuns = 0;
  // The prefix of the file header. The unit of each run is `arbareto-<operation ID>-1.scope`.
  function wrapperOperation(): string {
    const id = `0f0f0f0f-0000-4000-800a-${(process.pid * 0x1000 + ++wrapperRuns).toString(16).padStart(12, "0")}`;
    OWN_SCOPE_OPERATIONS.add(id);
    return id;
  }
  // Contract §11 "Process launch": the wrapper in mode `integrate` around `program`, with no forwarded variable, as the shell starts a Git process.
  // The stdout after the start byte, or null for another exit or no start byte.
  function underWrapper(w: WslHost, program: string[]): string | null {
    const p = w.probe.paths;
    const r = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/bin/sh", "-c", WRAPPER, "sh", `arbareto-${wrapperOperation()}-1.scope`, "integrate", "", p["systemd-run"]!, p.systemctl!, p.setsid!, w.probe.noexpand === "0" ? "1" : "", ...program], { timeoutMs: 60_000 });
    return r.exitCode === 0 && r.bytes[0] === 0x53 ? Buffer.from(r.bytes.subarray(1)).toString("utf8") : null;
  }

  // Spec FR-025: the SHA-256 of the real `~/.gitconfig` and of the real XDG file, read inside the distro without the forwarding. `absent` stands for a missing file.
  const REAL_FILES = 'for f in "$HOME/.gitconfig" "${XDG_CONFIG_HOME:-$HOME/.config}/git/config"; do if [ -e "$f" ]; then sha256sum < "$f"; else echo absent; fi; done';
  function realDigests(w: WslHost): string[] {
    const r = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/bin/sh", "-c", REAL_FILES]);
    if (r.exitCode !== 0) throw new Error(`the real file digests exited ${r.exitCode}: ${r.stderr}`);
    const lines = r.stdout.split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(2);
    return lines;
  }

  // The registration, and the Git installation ID of its `run` requests. The hook refuses nothing.
  async function openWithGit(s: Service, w: WslHost, dir: string): Promise<{ r: RegistrationResult; gitInstallationId: string }> {
    let gitInstallationId = "";
    s.runner.inject.refuse = (call) => {
      const context = (call as Partial<GitCall>).context;
      if (context !== undefined && "gitInstallationId" in context) gitInstallationId = context.gitInstallationId;
      return undefined;
    };
    const r = await open(s, w, dir);
    s.runner.inject.refuse = undefined;
    expect(gitInstallationId).not.toBe("");
    return { r, gitInstallationId };
  }

  // Spec FR-023: before the first write, Git in the distro names the owned global file through the double.
  async function expectOwnedGlobal(s: Service, w: WslHost, r: RegistrationResult, gitInstallationId: string): Promise<void> {
    const stdout = createCollector({ maxBytes: 65_536 });
    const stderr = createCollector({ maxBytes: 65_536 });
    const context = { contextKind: "registeredOperation" as const, gitInstallationId, repositoryId: r.repositoryId };
    const exit = await s.runner.run({ operationId: crypto.randomUUID(), context, arguments: [L, "var", "GIT_CONFIG_GLOBAL"], environmentPolicy: "read", limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS }, stdout, stderr, signal: new AbortController().signal });
    expect({ exitCode: exit.exitCode, stdout: new TextDecoder().decode(stdout.take()) }).toEqual({ exitCode: 0, stdout: `${ownedGlobal(w)}\n` });
  }

  // One Global case. The real files keep their SHA-256 (spec FR-025), and the owned global file is the target before the first write.
  async function withGlobal(w: WslHost, f: DistroFixture, name: string, body: (s: Service, r: RegistrationResult) => Promise<void>): Promise<void> {
    const real = realDigests(w);
    await withWsl(w, name, async (s) => {
      const { r, gitInstallationId } = await openWithGit(s, w, f.repo);
      await expectOwnedGlobal(s, w, r, gitInstallationId);
      await body(s, r);
    });
    expect(realDigests(w)).toEqual(real);
  }

  W("Q22 FR-018, FR-019, and SC-005: Save and remove of each FR-060 key in Global equal the distro Git's own config set and unset --global on a copy of the owned global file; a multi-valued key and an included value stay read only; every other configuration byte stays", async (w) => {
    const h = hostOf(w, globalKeys(w));
    h.write(includedGlobal(w), "[core]\n\teditor = included-editor\n");
    h.copy(ownedGlobal(w), oracleGlobal(w));
    const f = copy(w, "branches");
    const oracle = (args: string[]) => gitRun(h, h.root, args, { env: { GIT_CONFIG_GLOBAL: oracleGlobal(w) } });
    const xdg = `${w.folder}/home/.config/git/config`;
    const before = { local: fileDigest(at(f), localConfig(at(f))), included: fileDigest(at(f), includedGlobal(w)), xdg: f.h.existing([xdg]) };
    await withGlobal(w, f, "t032-global-save", async (s, r) => {
      // The tool keys of the effective tools go first, because a later `diff.tool` or `merge.tool` save changes those tools.
      for (const key of ["difftool.global-diff.path", "difftool.global-diff.cmd", "mergetool.global-merge.path", "mergetool.global-merge.cmd", ...FR060]) {
        const current = globalValues(f, key);
        // `config get --global` reads no include, so the included `core.editor` lists no value there.
        const reason = key === "core.editor" ? "included" : current.length > 1 ? "multi-value" : null;
        if (reason !== null) {
          const global = globalDigest(f);
          const from = s.runner.calls.length;
          expect({ key, ...refusalOf(await review(s, r, save([{ key, value: "x" }]))) }).toEqual({ key, ...unavailable(reason) });
          expect({ key, writes: writes(s, from), global: globalDigest(f) }).toEqual({ key, writes: [], global });
          continue;
        }
        for (const value of [newValue(key, current[0] ?? null), null]) {
          const from = s.runner.calls.length;
          const response = await runSave(s, r, [{ key, value }]);
          expect({ key, value, ...outcome(response), result: response.result }).toEqual({ key, value, ...SUCCEEDED, result: { action: "config-save", scope: "global", written: [key] } });
          const args = value === null ? ["config", "unset", "--global", "--", key] : ["config", "set", "--global", "--", key, value];
          expect({ key, value, writes: writes(s, from) }).toEqual({ key, value, writes: [["globalConfig", L, ...args]] });
          oracle(args);
          expect({ key, value, global: globalDigest(f) }).toEqual({ key, value, global: fileDigest(at(f), oracleGlobal(w)) });
        }
      }
    });
    expect({ local: fileDigest(at(f), localConfig(at(f))), included: fileDigest(at(f), includedGlobal(w)), xdg: f.h.existing([xdg]) }).toEqual(before);
    // Research.md R9: `GIT_CONFIG_GLOBAL` wins over the XDG file, and the double forwards it. The spec edge case of a user without `HOME` needs no forwarding.
    console.log(`OBSERVATION ${T032}: unverified XDG global file through the double`);
    console.log(`OBSERVATION ${T032}: unverified save without HOME`);
  });

  W("Q22 FR-019 and FR-022: a change before the review shows in the plan and writes nothing; a change after the review gives stale and keeps the other value; Git's exit 5 and a held lock name the key and the output tail; Cancel writes nothing; the fresh listing decides each result", async (w) => {
    const h = hostOf(w);
    const f = copy(w, "branches");
    const other = (args: string[]) => gitRun(h, h.root, ["config", "set", "--global", ...args]);
    await withGlobal(w, f, "t032-global-stale", async (s, r) => {
      const settings = await request<{ values: { key: string; scopes: { global: { value: string | null }[] } }[]; files: { global: string | null } }>(s, "readGitSettings", {}, { repositoryId: r.repositoryId });
      expect(outcome(settings)).toEqual(SUCCEEDED);
      // Contract §11 and 004 data-model §9: a WSL workspace names no global file, and Git's `--global` rule applies in the distro.
      expect(settings.result!.files.global).toBeNull();
      expect(settings.result!.values.find((v) => v.key === "user.name")!.scopes.global.map((e) => e.value)).toEqual(["Arbareto Fixture"]);
      // A change before the review: the plan shows the other value, so the renderer gives the 004 `changedOutside` text and runs nothing.
      other(["user.name", "Other Program"]);
      let from = s.runner.calls.length;
      const changed = await token(s, r, save([{ key: "user.name", value: "Mine" }]));
      expect(changed.plan).toEqual({ scope: "global", changes: [{ key: "user.name", value: "Mine", earlier: { origin: `file:${ownedGlobal(w)}`, value: "Other Program" } }] });
      expect(writes(s, from)).toEqual([]);

      // A change after the review, before the write of its key.
      const two = await token(s, r, save([{ key: "user.name", value: "Mine" }, { key: "user.email", value: "mine@arbareto.invalid" }]));
      const release = s.runner.holdStart((c) => c.arguments[2] === "set" && c.arguments.includes("user.name"));
      from = s.runner.calls.length;
      const requestId = sendRun(s, r, two.workbenchToken);
      await until(() => s.runner.calls.slice(from).some((c) => c.environmentPolicy === "integrate"), "the held user.name write", RESPONSE_MS);
      other(["user.email", "other@arbareto.invalid"]);
      release();
      const stale = await s.response<SaveResult>(requestId, RESPONSE_MS);
      // 004 plan.md D11: `written` names only the keys whose write ran, so the other program's `user.email` entry is not in it.
      expect({ ...outcome(stale), result: stale.result }).toEqual({ ...WITH_EFFECTS, result: { action: "config-save", scope: "global", written: ["user.name"], stale: "user.email" } });
      expect(writes(s, from)).toEqual([["globalConfig", L, "config", "set", "--global", "--", "user.name", "Mine"]]);
      expect({ name: globalValues(f, "user.name"), email: globalValues(f, "user.email") }).toEqual({ name: ["Mine"], email: ["other@arbareto.invalid"] });

      // git-config(1) exit 5: the owned global file holds no `rerere.autoUpdate` to remove.
      const absent = await runSave(s, r, [{ key: "rerere.autoupdate", value: null }]);
      expect({ ...outcome(absent), failed: absent.result!.failed, written: absent.result!.written }).toEqual({ state: "failed", code: "GIT_FAILED", failed: { key: "rerere.autoupdate", exitCode: 5, reason: "nothing-set" }, written: [] });
      // A held lock: Git exits 255, which git-config(1) does not document, so the result names the key, the exit, and the output tail.
      const lock = `${ownedGlobal(w)}.lock`;
      const locked = await token(s, r, save([{ key: "pull.ff", value: "only" }]));
      h.write(lock, "");
      let global = globalDigest(f);
      const failed = await s.response<SaveResult>(sendRun(s, r, locked.workbenchToken), RESPONSE_MS);
      inDistro(w.distro, ["/usr/bin/rm", "-f", "--", lock]);
      const tail = failed.result?.outputTail;
      expect({ ...outcome(failed), failed: failed.result!.failed, written: failed.result!.written, tail: typeof tail === "string" && tail.length > 0 }).toEqual({ state: "failed", code: "GIT_FAILED", failed: { key: "pull.ff", exitCode: 255 }, written: [], tail: true });
      expect(globalDigest(f)).toBe(global);

      // Cancel while the write waits to start: no write, and the fresh listing names no written key.
      const canceled = await token(s, r, save([{ key: "fetch.prune", value: "true" }]));
      const hold = s.runner.holdStart((c) => c.arguments[2] === "set" && c.arguments.includes("fetch.prune"));
      from = s.runner.calls.length;
      const id = sendRun(s, r, canceled.workbenchToken);
      await until(() => s.runner.calls.slice(from).some((c) => c.environmentPolicy === "integrate"), "the held fetch.prune write", RESPONSE_MS);
      global = globalDigest(f);
      const operationId = await s.operationId(id);
      await s.cancel(operationId);
      hold();
      const done = await s.response<SaveResult>(id, RESPONSE_MS);
      expect({ ...outcome(done), written: done.result?.written }).toEqual({ state: "canceled", code: "CANCELED", written: [] });
      expect(globalDigest(f)).toBe(global);
      await Bun.sleep(AFTER_CLOSE_MS);
      expect(pgrep(w, operationId)).toEqual([]);
    });
  });

  W("Q22 SC-005, F9, and F10: with core.sharedRepository=0660 in the repository and no owned global file, the save from / creates the global file with mode 0666 & ~umask of the wrapper", async (w) => {
    hostOf(w);
    const f = copy(w, "branches");
    own(f, ["config", "--local", "core.sharedRepository", "0660"]);
    const umaskText = underWrapper(w, ["/bin/sh", "-c", "umask"]);
    expect(umaskText).toMatch(/^[0-7]{3,4}\n$/);
    const mode = (0o666 & ~Number.parseInt(umaskText!.trim(), 8)).toString(8);
    // SC-005: the mode cannot show the difference then.
    if (mode === "660") throw new Error(`the wrapper umask ${umaskText!.trim()} gives mode 660, so the case cannot run`);
    const home = underWrapper(w, ["/usr/bin/printenv", "HOME"]);
    factLine(w, obs("F10 HOME set under the wrapper in mode integrate", true, home !== null && home.trim() !== ""));
    await withGlobal(w, f, "t032-global-mode", async (s, r) => {
      inDistro(w.distro, ["/usr/bin/rm", "-f", "--", ownedGlobal(w)]);
      const from = s.runner.calls.length;
      const response = await runSave(s, r, [{ key: "user.name", value: "Mode Case" }]);
      const created = inDistro(w.distro, ["/usr/bin/stat", "-c", "%a", "--", ownedGlobal(w)]).trim();
      factLine(w, obs("F9 global file mode of a save from / with core.sharedRepository=0660", mode, created));
      expect(created).toBe(mode);
      expect({ ...outcome(response), result: response.result }).toEqual({ ...SUCCEEDED, result: { action: "config-save", scope: "global", written: ["user.name"] } });
      expect(writes(s, from)).toEqual([["globalConfig", L, "config", "set", "--global", "--", "user.name", "Mode Case"]]);
    });
    expect(f.h.read(ownedGlobal(w))!.toString("utf8")).toBe("[user]\n\tname = Mode Case\n");
  });

  // Spec FR-023: each WSL route fails closed without the owned global file. The seam registration starts no process, and `inject.exit` replaces every later process.
  W("Q22 FR-023: the double without wslGlobalConfig refuses the WSL globalConfig, worktreeAdd, and destination routes before any process", async (w) => {
    const runner = createBunRunner({ git: gitExe(), directory: fixtureDir(`t032-no-global-${crypto.randomUUID()}`), environment: serviceEnv() });
    try {
      const repo = seamRepository(w, runner);
      const seam = runner.inject.stdout!;
      let gitInstallationId = "";
      // Without the forwarding, a Git process would read the real global file, so a call without a seam output starts no process.
      runner.inject.refuse = (call) => {
        const context = (call as Partial<GitCall>).context;
        if (context !== undefined && "gitInstallationId" in context) gitInstallationId = context.gitInstallationId;
        return seam({ operationId: call.operationId, arguments: call.arguments }) === undefined ? "INVALID_REQUEST" : undefined;
      };
      const s = startSession(runner);
      const registered = await s.response(s.chooseRepository(repo.path));
      expect(registered).toMatchObject({ state: "succeeded" });
      expect(gitInstallationId).not.toBe("");
      const repositoryId = (registered.result as unknown as { repositoryId: string }).repositoryId;
      // A missing refusal then ends with exit 0 and no process, so the case fails without a Git run.
      runner.inject.refuse = undefined;
      runner.inject.exit = () => 0;
      const spawned = runner.spawned;
      const call = (context: GitCall["context"], args: string[], environmentPolicy: GitCall["environmentPolicy"]) =>
        runner.run({ operationId: crypto.randomUUID(), context, arguments: args, environmentPolicy, limits: environmentPolicy === "read" ? { deadlineMs: GIT_PROCESS_DEADLINE_MS } : PROCESS_LIMITS.network, stdout: createCollector({ maxBytes: 1_024 }), stderr: createCollector({ maxBytes: 1_024 }), signal: new AbortController().signal });
      await expect(call({ contextKind: "globalConfig", gitInstallationId }, [L, "--no-optional-locks", "--literal-pathspecs", "config", "list", "--show-scope", "--show-origin", "-z"], "read")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      const dest = `${w.folder}/t032-wt`;
      const bootstrapId = runner.addWorktreeAdd(uncPath(w, dest), repositoryId);
      await expect(call({ contextKind: "worktreeAdd", gitInstallationId, repositoryId, bootstrapId }, [L, "worktree", "add", "--", dest, "main"], "integrate")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(runner.destinationFacts({ operationId: crypto.randomUUID(), bootstrapId })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(runner.spawned).toBe(spawned);
    } finally {
      await runner.dispose();
    }
  });
});
