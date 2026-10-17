// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T033: `reviewSync` and `sync` with `fetch` and `fetch-all` (contract Δ3, data-model §4 and §8, plan.md D3, FR-001 to FR-008, FR-011, FR-012, FR-037, FR-041, SC-001, SC-004, SC-006, SC-010).
// The oracle is Git's own `fetch` on a copy. Counters decide, never message text or timing other than the contract bounds.

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_LIFETIME_MS, RECONCILIATION_TARGET_MS, STALL_NOTICE_MS, SUBMODULE_UPDATE_CEILING_MS, SUBMODULE_UPDATE_INACTIVITY_MS, SYNC_FETCH_LISTED_REFS } from "../../src/contracts/limits";
import { startHttpRemote, type HttpRemote } from "../support/http-remote";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { operationMarkers, rawIndexDigest, workingFileDigests } from "./git-oracle";
import { buildCredentialRemote, buildFetchAll, buildFetchFlags, buildSubmodule, configDigests, fc, FETCH_ALL_REMOTES, gitRun, HTTP_PASSWORD, HTTP_USER, importStream, nativeEnv, refMap, revParse, type GitHost } from "./remote-fixtures";
import { caseTest, type Service } from "./service-harness";
import { callsFrom, callsOf, gitExe, hostFor, native, register, remoteCalls, reviewed, reviewSync, run, sendSync, subcommandOf, sync, TIMEOUT_MS, withSync, type SyncResult, refusalOf, helperGlobal } from "./sync-harness";

useFixtureRoot();

const TASK = "T033";
const SHELL = ["shell-double"] as const;
const WINDOWS = ["shell-double", "git-for-windows"] as const;
const FETCH = (remote: string) => ["--no-lazy-fetch", "fetch", "--porcelain", "--progress", "--no-recurse-submodules", "--", remote];
const NETWORK_LIMITS = { inactivityMs: SUBMODULE_UPDATE_INACTIVITY_MS, ceilingMs: SUBMODULE_UPDATE_CEILING_MS, stallMs: STALL_NOTICE_MS };
const isFetch = (call: { arguments: readonly string[] }) => subcommandOf(call.arguments) === "fetch";
const SYNC_COUNTERS = ["percent", "remoteIndex", "remoteCount"];

// A clone that is behind its remote, without the moved tag, so Git's own fetch exits 0.
function behindClone(h: GitHost, tag: string): { origin: string; clone: string } {
  const f = buildFetchFlags(h);
  const clone = `${h.root}/${tag}`;
  h.copy(f.clone, clone);
  gitRun(h, clone, ["tag", "-d", "t1"]);
  return { origin: f.origin, clone };
}

function oracleFetch(h: GitHost, repo: string, tag: string, args: string[] = ["origin"]): Record<string, string> {
  const copy = `${h.root}/${tag}-oracle`;
  h.copy(repo, copy);
  gitRun(h, copy, ["fetch", "-q", ...args]);
  return refMap(h, copy);
}

const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const progressOf = (service: Service, requestId: string) => (service.progress as { requestId?: string; phase?: string; counters?: Record<string, number>; stalled?: boolean }[]).filter((p) => p.requestId === requestId);

const repoFacts = (h: GitHost, repo: string) => ({ head: revParse(h, repo, "HEAD"), index: rawIndexDigest(gitExe(), native(repo)), files: workingFileDigests(native(repo)), markers: operationMarkers(gitExe(), native(repo)) });

// An HTTP remote with Basic sign-in. The clone's `origin` URL holds no user information, and an owned global file names the test credential helper.
async function withHttp(h: GitHost, body: (server: HttpRemote, clone: string, env: Record<string, string>) => Promise<void>): Promise<void> {
  const project = `${h.root}/http`;
  mkdirSync(project, { recursive: true });
  const bare = buildCredentialRemote(h, project);
  const clone = `${h.root}/http-clone`;
  gitRun(h, h.root, ["clone", "-q", "--", bare, clone]);
  importStream(h, bare, [fc({ mark: 1, ref: "refs/heads/later", message: "later\n", files: { "later.txt": "later\n" } })]);
  const global = helperGlobal(h, HTTP_USER, HTTP_PASSWORD);
  const server = startHttpRemote({ git: gitExe(), projectRoot: project, user: HTTP_USER, password: HTTP_PASSWORD, env: nativeEnv() });
  try {
    gitRun(h, clone, ["remote", "set-url", "origin", `${server.url}/cred.git`]);
    await body(server, clone, nativeEnv({ GIT_CONFIG_GLOBAL: global }));
  } finally {
    await server.stop();
  }
}

describeGit("sync fetch and fetch-all (T033)", () => {
  caseTest(TASK, "SC-001: a fetch equals Git's own fetch on a copy, lists its porcelain lines, keeps the configuration bytes, and reports sync-fetch progress", SHELL, async () => {
    const h = hostFor("t033-fetch");
    const { clone } = behindClone(h, "fetch");
    const oracle = oracleFetch(h, clone, "fetch");
    const before = configDigests(h, clone);
    await withSync("t033-fetch", async (service) => {
      const r = await register(service, clone);
      const review = await reviewed(service, r, { action: "fetch" });
      expect(review.plan.remotes).toEqual(["origin"]);
      const from = service.runner.calls.length;
      const requestId = sendSync(service, r, review.syncReviewToken);
      const response = await service.response<SyncResult>(requestId);
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      expect(refMap(h, clone)).toEqual(oracle);
      const fetched = response.result!.fetch!;
      expect(fetched.observed).toEqual([]);
      expect(fetched.remotes.map((x) => [x.name, x.state])).toEqual([["origin", "succeeded"]]);
      const flags = fetched.remotes[0]!.updates.map((u) => [u.flag, u.ref]).sort();
      expect(flags).toEqual([
        [" ", "refs/remotes/origin/ff"],
        ["*", "refs/remotes/origin/new"],
        ["*", "refs/tags/t1"],
        ["+", "refs/remotes/origin/forced"],
        ["+", "refs/remotes/origin/rewound"],
      ]);
      expect(fetched.remotes[0]!.counts).toMatchObject({ " ": 1, "*": 2, "+": 2 });
      const fetches = remoteCalls(service, from);
      expect(fetches.map((c) => [c.arguments, c.limits])).toEqual([[FETCH("origin"), NETWORK_LIMITS]]);
      expect(fetches.map((c) => c.environmentPolicy)).toEqual(["remote"]);
      const events = progressOf(service, requestId);
      expect(events.some((p) => p.phase === "sync-fetch")).toBe(true);
      for (const p of events.filter((e) => e.phase === "sync-fetch")) expect(Object.keys(p.counters ?? {}).every((k) => SYNC_COUNTERS.includes(k))).toBe(true);
      expect(events.filter((e) => e.phase === "sync-fetch").every((p) => p.counters?.remoteIndex === 1 && p.counters?.remoteCount === 1)).toBe(true);
      expect(configDigests(h, clone)).toEqual(before);

      // A second fetch has no porcelain line, so the result states that nothing changed.
      const again = await run(service, r, { action: "fetch" });
      expect(outcome(again)).toEqual({ state: "succeeded", code: undefined });
      expect(again.result!.fetch!.remotes[0]!.updates).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-011: the user's prune setting applies, and the app adds no option", SHELL, async () => {
    const h = hostFor("t033-prune");
    const { clone } = behindClone(h, "prune");
    gitRun(h, clone, ["config", "fetch.prune", "true"]);
    const oracle = oracleFetch(h, clone, "prune");
    expect(oracle["refs/remotes/origin/gone-soon"]).toBeUndefined();
    await withSync("t033-prune", async (service) => {
      const r = await register(service, clone);
      const from = service.runner.calls.length;
      const response = await run(service, r, { action: "fetch" });
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      expect(refMap(h, clone)).toEqual(oracle);
      expect(response.result!.fetch!.remotes[0]!.updates.filter((u) => u.flag === "-").map((u) => u.ref)).toEqual(["refs/remotes/origin/gone-soon"]);
      expect(remoteCalls(service, from).map((c) => c.arguments)).toEqual([FETCH("origin")]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "D3: the remote is branch.<branch>.remote, else origin, and origin on a detached HEAD; a missing remote, the value '.', and an unlisted payload remote refuse before any remote process", SHELL, async () => {
    const h = hostFor("t033-select");
    const { origin, clone } = behindClone(h, "select");
    gitRun(h, clone, ["remote", "add", "second", origin]);
    await withSync("t033-select", async (service) => {
      const r = await register(service, clone);
      gitRun(h, clone, ["config", "branch.main.remote", "second"]);
      expect((await reviewed(service, r, { action: "fetch" })).plan.remotes).toEqual(["second"]);
      gitRun(h, clone, ["config", "branch.main.remote", "nowhere"]);
      let from = service.runner.calls.length;
      const missing = await reviewSync(service, r, { action: "fetch" });
      expect(refusalOf(missing)).toEqual({ state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "remote-missing" } });
      gitRun(h, clone, ["config", "branch.main.remote", "."]);
      const local = await reviewSync(service, r, { action: "fetch" });
      expect(refusalOf(local)).toEqual({ state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "local-upstream" } });
      const unlisted = await reviewSync(service, r, { action: "fetch", remote: "nowhere" });
      expect(unlisted.code).toBe("INVALID_REQUEST");
      expect(remoteCalls(service, from)).toEqual([]);
      gitRun(h, clone, ["config", "--unset", "branch.main.remote"]);
      expect((await reviewed(service, r, { action: "fetch" })).plan.remotes).toEqual(["origin"]);
      gitRun(h, clone, ["config", "branch.main.remote", "second"]);
      gitRun(h, clone, ["checkout", "-q", "--detach", "HEAD"]);
      from = service.runner.calls.length;
      expect(outcome(await run(service, r, { action: "fetch" }))).toEqual({ state: "succeeded", code: undefined });
      expect(remoteCalls(service, from).map((c) => c.arguments)).toEqual([FETCH("origin")]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, `FR-012: above ${SYNC_FETCH_LISTED_REFS} porcelain lines, the result lists ${SYNC_FETCH_LISTED_REFS} and counts every line`, SHELL, async () => {
    const h = hostFor("t033-many-lines");
    const { origin, clone } = behindClone(h, "many-lines");
    const base = revParse(h, origin, "refs/heads/main");
    const lines = Array.from({ length: SYNC_FETCH_LISTED_REFS + 1 }, (_, i) => `create refs/heads/n${String(i).padStart(4, "0")} ${base}\n`).join("");
    gitRun(h, origin, ["update-ref", "--stdin"], { input: Buffer.from(lines) });
    const oracle = oracleFetch(h, clone, "many-lines");
    await withSync("t033-many-lines", async (service) => {
      const r = await register(service, clone);
      const response = await run(service, r, { action: "fetch" });
      expect(outcome(response)).toEqual({ state: "succeeded", code: undefined });
      expect(refMap(h, clone)).toEqual(oracle);
      const remote = response.result!.fetch!.remotes[0]!;
      expect(remote.updates.length).toBe(SYNC_FETCH_LISTED_REFS);
      expect(remote.counts["*"]).toBe(SYNC_FETCH_LISTED_REFS + 3);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a ref change that the porcelain lines do not list gives completed-with-effects with the observed list", SHELL, async () => {
    const h = hostFor("t033-observed");
    const { clone } = behindClone(h, "observed");
    const head = revParse(h, clone, "HEAD");
    await withSync("t033-observed", async (service) => {
      const r = await register(service, clone);
      const review = await reviewed(service, r, { action: "fetch" });
      const release = service.runner.holdStart(isFetch);
      const requestId = sendSync(service, r, review.syncReviewToken);
      await until(() => service.runner.calls.some(isFetch), "fetch call");
      gitRun(h, clone, ["update-ref", "refs/heads/extra", head]);
      release();
      const response = await service.response<SyncResult>(requestId);
      expect(outcome(response)).toEqual({ state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" });
      expect(response.result!.fetch!.observed).toEqual([{ ref: "refs/heads/extra", oldObjectId: null, newObjectId: head }]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "fetch-all: one process per remote in git remote order, skipped by the last skipFetchAll or skipDefaultUpdate value (R16 k), each with its own state; a failed remote does not stop the next", SHELL, async () => {
    const h = hostFor("t033-all");
    const repo = buildFetchAll(h);
    const copy = `${h.root}/fetch-all-oracle`;
    h.copy(repo, copy);
    gitRun(h, copy, ["fetch", "-q", "--all"]);
    const oracle = refMap(h, copy);
    expect(Object.keys(FETCH_ALL_REMOTES)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    const failing = `${h.root}/fetch-all-failing`;
    h.copy(repo, failing);
    gitRun(h, failing, ["remote", "set-url", "r1", `${h.root}/missing.git`]);
    await withSync("t033-all", async (service) => {
      const r = await register(service, repo);
      const review = await reviewed(service, r, { action: "fetch-all" });
      expect(review.plan.remotes).toEqual(["r1", "r5"]);
      let from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      // git-config(1) `remote.<name>.followRemoteHEAD`: Git's fetch creates `refs/remotes/<remote>/HEAD`, and no porcelain line names it.
      const heads = Object.keys(oracle).filter((ref) => /^refs\/remotes\/r[15]\/HEAD$/.test(ref)).sort();
      expect(outcome(response)).toEqual(heads.length > 0 ? { state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" } : { state: "succeeded", code: undefined });
      expect(response.result!.fetch!.observed.map((o) => o.ref)).toEqual(heads);
      expect(refMap(h, repo)).toEqual(oracle);
      expect(remoteCalls(service, from).map((c) => c.arguments)).toEqual([FETCH("r1"), FETCH("r5")]);
      expect(response.result!.fetch!.remotes.map((x) => [x.name, x.state])).toEqual([["r1", "succeeded"], ["r5", "succeeded"]]);

      const f = await register(service, failing);
      from = service.runner.calls.length;
      const failed = await run(service, f, { action: "fetch-all" });
      expect(outcome(failed)).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
      expect(failed.result!.fetch!.remotes.map((x) => [x.name, x.state])).toEqual([["r1", "failed"], ["r5", "succeeded"]]);
      expect(failed.result!.fetch!.remotes[0]!.outputTail).not.toBe("");
      expect(remoteCalls(service, from).map((c) => c.arguments)).toEqual([FETCH("r1"), FETCH("r5")]);
      expect(refMap(h, failing, ["refs/remotes/r5"])).toEqual(refMap(h, copy, ["refs/remotes/r5"]));
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "R16 m: an invalid mirror, skipFetchAll, skipDefaultUpdate, prune, or pruneTags value on any remote gives invalid-config for fetch and fetch-all, and no remote read or remote process starts", SHELL, async () => {
    const h = hostFor("t033-invalid");
    const repo = buildFetchAll(h);
    await withSync("t033-invalid", async (service) => {
      const r = await register(service, repo);
      for (const key of ["mirror", "skipFetchAll", "skipDefaultUpdate", "prune", "pruneTags"]) {
        gitRun(h, repo, ["config", "--add", `remote.r2.${key}`, "maybe"]);
        for (const action of ["fetch", "fetch-all"]) {
          const from = service.runner.calls.length;
          const response = await reviewSync(service, r, { action });
          expect({ key, action, ...refusalOf(response) }).toEqual({ key, action, state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "invalid-config" } });
          expect(callsFrom(service, from).filter((c) => subcommandOf(c.arguments) === "remote")).toEqual([]);
          expect(remoteCalls(service, from)).toEqual([]);
        }
        gitRun(h, repo, ["config", "--unset", `remote.r2.${key}`, "^maybe$"]);
      }
      // Git skips a remote name that starts with "/".
      gitRun(h, repo, ["config", "remote./x.prune", "maybe"]);
      expect((await reviewed(service, r, { action: "fetch-all" })).plan.remotes).toEqual(["r1", "r5"]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "001 FR-016 delta: fetch and fetch-all run during a merge in progress and keep HEAD, the index, the working files, and the markers", SHELL, async () => {
    const h = hostFor("t033-merging");
    const { clone } = behindClone(h, "merging");
    gitRun(h, clone, ["checkout", "-q", "-b", "side"]);
    gitRun(h, clone, ["commit", "-q", "--allow-empty", "-m", "side"]);
    gitRun(h, clone, ["checkout", "-q", "main"]);
    gitRun(h, clone, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
    const before = repoFacts(h, clone);
    expect(before.markers).toContain("MERGE_HEAD");
    await withSync("t033-merging", async (service) => {
      const r = await register(service, clone);
      const review = await reviewed(service, r, { action: "fetch" });
      expect(review.plan.operationState).toBe("merging");
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual({ state: "succeeded", code: undefined });
      expect(outcome(await run(service, r, { action: "fetch-all" }))).toEqual({ state: "succeeded", code: undefined });
      expect(repoFacts(h, clone)).toEqual(before);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-007: the fetch never recurses into a submodule, also with submodule.recurse=true", SHELL, async () => {
    const h = hostFor("t033-submodule");
    const f = buildSubmodule(h);
    importStream(h, f.sub, [fc({ mark: 1, ref: "refs/heads/main", message: "s3\n", from: undefined, files: { "s.txt": "3\n" } })], { force: true });
    gitRun(h, f.clone, ["config", "submodule.recurse", "true"]);
    gitRun(h, f.clone, ["config", "fetch.recurseSubmodules", "true"]);
    const subRefs = refMap(h, `${f.clone}/sub`);
    await withSync("t033-submodule", async (service) => {
      const r = await register(service, f.clone);
      const from = service.runner.calls.length;
      expect(outcome(await run(service, r, { action: "fetch" }))).toEqual({ state: "succeeded", code: undefined });
      expect(remoteCalls(service, from).map((c) => c.arguments)).toEqual([FETCH("origin")]);
      expect(refMap(h, `${f.clone}/sub`)).toEqual(subRefs);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "an unreachable remote fails with the redacted output tail and the fetch remedy, and no branch, index entry, or working file changes", SHELL, async () => {
    const h = hostFor("t033-unreachable");
    const { clone } = behindClone(h, "unreachable");
    gitRun(h, clone, ["remote", "set-url", "origin", "http://127.0.0.1:1/none.git"]);
    const before = { refs: refMap(h, clone), ...repoFacts(h, clone) };
    await withSync("t033-unreachable", async (service) => {
      const r = await register(service, clone);
      const response = await run(service, r, { action: "fetch" });
      expect(outcome(response)).toEqual({ state: "failed", code: "GIT_FAILED" });
      const remote = response.result!.fetch!.remotes[0]!;
      expect(remote.state).toBe("failed");
      expect(remote.outputTail).not.toBe("");
      expect(response.result!.remedy).toEqual({
        text: "This command runs the step in a terminal, where Git and SSH can ask for input. Then use the action again.",
        command: `& ${psQuote(gitExe())} --no-lazy-fetch -C ${psQuote(r.worktreeRoot)} fetch -- 'origin'`,
      });
      expect({ refs: refMap(h, clone), ...repoFacts(h, clone) }).toEqual(before);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-001: a second mutation during a fetch gives BUSY, and reads stay available", SHELL, async () => {
    const h = hostFor("t033-busy");
    const { clone } = behindClone(h, "busy");
    await withSync("t033-busy", async (service) => {
      const r = await register(service, clone);
      const first = await reviewed(service, r, { action: "fetch" });
      const second = await reviewed(service, r, { action: "fetch" });
      const release = service.runner.holdStart(isFetch);
      const requestId = sendSync(service, r, first.syncReviewToken);
      await until(() => service.runner.calls.some(isFetch), "fetch call");
      expect(outcome(await sync(service, r, second.syncReviewToken))).toEqual({ state: "rejected", code: "BUSY" });
      const read = await service.request("readTracking", {}, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
      expect(read.state).toBe("succeeded");
      release();
      expect(outcome(await service.response(requestId))).toEqual({ state: "succeeded", code: undefined });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-004: Cancel before the fetch process and during a paused HTTP fetch reach a reconciled outcome within 5 seconds, claim no rollback, and leave no process", SHELL, async () => {
    const h = hostFor("t033-cancel");
    await withHttp(h, async (server, clone, environment) => {
      await withSync("t033-cancel", async (service) => {
        const r = await register(service, clone);
        const before = refMap(h, clone);
        // Before the process: the held start never runs Git.
        let review = await reviewed(service, r, { action: "fetch" });
        const release = service.runner.holdStart(isFetch);
        let requestId = sendSync(service, r, review.syncReviewToken);
        await until(() => service.runner.calls.some(isFetch), "held fetch call");
        let canceledAt = performance.now();
        await service.cancel(await service.operationId(requestId));
        release();
        let response = await service.response<SyncResult>(requestId);
        expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
        expect(service.responseAt.get(requestId)! - canceledAt).toBeLessThanOrEqual(RECONCILIATION_TARGET_MS);

        // During the process: the paused server holds the answer, so Git waits.
        review = await reviewed(service, r, { action: "fetch" });
        server.pause();
        const served = server.requests();
        const from = service.runner.calls.length;
        requestId = sendSync(service, r, review.syncReviewToken);
        await until(() => server.requests() > served, "a paused request");
        canceledAt = performance.now();
        await service.cancel(await service.operationId(requestId));
        response = await service.response<SyncResult>(requestId);
        expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
        expect(service.responseAt.get(requestId)! - canceledAt).toBeLessThanOrEqual(RECONCILIATION_TARGET_MS);
        expect(response.result!.fetch!.remotes.map((x) => x.state)).toEqual(["canceled"]);
        const fetch = remoteCalls(service, from)[0]!;
        await until(() => fetch.exit !== undefined, "process end", RECONCILIATION_TARGET_MS);
        expect(fetch.exit!.exitCode).toBeNull();
        server.resume();
        expect(refMap(h, clone)).toEqual(before);
      }, { environment });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-004: the inactivity end of a paused fetch gives failed with DEADLINE within 5 seconds, and the stall event comes first with the fetch remedy", SHELL, async () => {
    const h = hostFor("t033-inactivity");
    await withHttp(h, async (server, clone, environment) => {
      await withSync("t033-inactivity", async (service) => {
        const r = await register(service, clone);
        const review = await reviewed(service, r, { action: "fetch" });
        service.runner.inject.limits = { stallMs: 300, inactivityMs: 3_000 };
        server.pause();
        const requestId = sendSync(service, r, review.syncReviewToken);
        const operationId = await service.operationId(requestId);
        await until(() => progressOf(service, requestId).some((p) => p.stalled === true), "stalled event", 20_000);
        const stalled = await service.getOperation(operationId);
        expect((stalled.result as { stallRemedy?: unknown }).stallRemedy).toEqual({
          command: `& ${psQuote(gitExe())} --no-lazy-fetch -C ${psQuote(r.worktreeRoot)} fetch -- 'origin'`,
          text: "This command runs the step in a terminal, where Git and SSH can ask for input. Then use the action again.",
        });
        const response = await service.response<SyncResult>(requestId, 60_000);
        const fetch = callsOf(service, operationId).find(isFetch)!;
        expect(outcome(response)).toEqual({ state: "failed", code: "DEADLINE" });
        expect(fetch.exit?.deadline).toBe("inactivity");
        expect(service.responseAt.get(requestId)! - (fetch.at + fetch.durationMs!)).toBeLessThanOrEqual(RECONCILIATION_TARGET_MS);
        expect(response.result!.fetch!.remotes.map((x) => x.state)).toEqual(["deadline"]);
        service.runner.inject.limits = {};
        server.resume();
      }, { environment });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "Δ3 sync step 3: fetch-all sends pageant before each remote; a failed pageant after a fetched remote keeps that fetch and names reason, program, and path (Δ9)", WINDOWS, async () => {
    const h = hostFor("t033-pageant-each");
    const repo = buildFetchAll(h);
    const failing = `${h.root}/pageant-failing`;
    h.copy(repo, failing);
    const plink = join(native(h.root), "putty", "plink.exe");
    await withSync("t033-pageant-each", async (service) => {
      const pageants = () => service.runner.frames.filter((f) => f.type === "pageant").map((f) => f.remote);
      const fetchOf = (remote: string) => (c: { arguments: readonly string[] }) => isFetch(c) && c.arguments.at(-1) === remote;
      // Holds the fetch start of `remote` and gives the pageant remotes that came before it.
      const heldAt = async (remote: string) => {
        await until(() => service.runner.calls.some(fetchOf(remote)), `fetch of ${remote}`);
        return pageants();
      };
      const r = await register(service, repo);
      const review = await reviewed(service, r, { action: "fetch-all" });
      const [releaseR1, releaseR5] = [service.runner.holdStart(fetchOf("r1")), service.runner.holdStart(fetchOf("r5"))];
      const requestId = sendSync(service, r, review.syncReviewToken);
      expect(await heldAt("r1")).toEqual(["r1"]);
      releaseR1();
      expect(await heldAt("r5")).toEqual(["r1", "r5"]);
      releaseR5();
      expect((await service.response<SyncResult>(requestId)).result!.fetch!.remotes.map((x) => x.state)).toEqual(["succeeded", "succeeded"]);

      // The plink setting changes while the fetch of r1 waits, so only the pageant of r5 fails.
      const f = await register(service, failing);
      const second = await reviewed(service, f, { action: "fetch-all" });
      const from = service.runner.calls.length;
      const release = service.runner.holdStart(fetchOf("r1"));
      const failedId = sendSync(service, f, second.syncReviewToken);
      await until(() => service.runner.calls.slice(from).some(fetchOf("r1")), "fetch of r1");
      service.runner.inject.sshClient = { plink };
      release();
      const response = await service.response<SyncResult>(failedId);
      service.runner.inject.sshClient = "git";
      expect(outcome(response)).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
      expect(pageants().slice(2)).toEqual(["r1", "r5"]);
      expect(response.result!.fetch!.remotes.map((x) => [x.name, x.state])).toEqual([["r1", "succeeded"], ["r5", "not-started"]]);
      expect({ reason: response.result!.reason, program: response.result!.program, path: response.result!.path }).toEqual({ reason: "missing", program: "plink", path: plink });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "contract §2: a repeated consumed sync token answers with its operation and starts no process; an expired token gives APPROVAL_EXPIRED and starts no process", SHELL, async () => {
    const h = hostFor("t033-token");
    const { clone } = behindClone(h, "token");
    let elapsed = 0;
    await withSync(
      "t033-token",
      async (service) => {
        const r = await register(service, clone);
        const review = await reviewed(service, r, { action: "fetch" });
        const first = await sync(service, r, review.syncReviewToken);
        expect(outcome(first)).toEqual({ state: "succeeded", code: undefined });
        const from = service.runner.calls.length;
        const repeat = await sync(service, r, review.syncReviewToken);
        expect({ state: repeat.state, operationId: repeat.operationId, calls: service.runner.calls.length - from }).toEqual({ state: "succeeded", operationId: first.operationId, calls: 0 });

        const expiring = await reviewed(service, r, { action: "fetch" });
        elapsed = APPROVAL_LIFETIME_MS + 1;
        const at = service.runner.calls.length;
        const expired = await sync(service, r, expiring.syncReviewToken);
        expect({ ...outcome(expired), calls: service.runner.calls.length - at }).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED", calls: 0 });
      },
      { approvalClock: () => performance.now() + elapsed },
    );
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-037: under plink with a missing plink.exe, the pageant reply is failed, the sync gives PUTTY_UNAVAILABLE, and no Git process starts", WINDOWS, async () => {
    const h = hostFor("t033-plink");
    const { clone } = behindClone(h, "plink");
    const plink = join(native(h.root), "putty", "plink.exe");
    await withSync("t033-plink", async (service) => {
      const r = await register(service, clone);
      const review = await reviewed(service, r, { action: "fetch" });
      service.runner.inject.sshClient = { plink };
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect(refusalOf(response)).toEqual({ state: "failed", code: "PUTTY_UNAVAILABLE", result: { reason: "missing", program: "plink", path: plink } });
      expect(remoteCalls(service, from)).toEqual([]);
      expect(service.runner.frames.filter((f) => f.type === "pageant").map((f) => f.remote)).toEqual(["origin"]);
      service.runner.inject.sshClient = "git";
    });
  }, TIMEOUT_MS);

  caseTest("T044", "Δ3: the inactivity end of a pull fetch gives the outcome, the remedy, and the connect target of a plain fetch", WINDOWS, async () => {
    const h = hostFor("t044-fetch-deadline");
    await withHttp(h, async (server, clone, environment) => {
      const plink = putty(h);
      await withSync("t044-fetch-deadline", async (service) => {
        service.runner.inject.sshClient = { plink };
        const r = await register(service, clone);
        const ends = [];
        for (const action of ["fetch", "pull"]) {
          const review = await reviewed(service, r, { action });
          service.runner.inject.limits = { stallMs: 300, inactivityMs: 3_000 };
          server.pause();
          const response = await service.response<SyncResult>(sendSync(service, r, review.syncReviewToken), 60_000);
          service.runner.inject.limits = {};
          server.resume();
          ends.push(await fetchEnd(service, r.repositoryId, response));
        }
        expect(ends[0]).toEqual({
          outcome: { state: "failed", code: "DEADLINE" },
          remotes: ["deadline"],
          remedy: { command: `& ${psQuote(gitExe())} --no-lazy-fetch -C ${psQuote(r.worktreeRoot)} fetch -- 'origin'`, text: "This command runs the step in a terminal, where Git and SSH can ask for input. Then use the action again." },
          connect: { state: "succeeded", code: undefined },
          target: "origin",
        });
        expect(ends[1]).toEqual(ends[0]);
        service.runner.inject.sshClient = "git";
      }, { environment });
    });
  }, TIMEOUT_MS);

  caseTest("T044", "Δ3: a broken porcelain line of a pull fetch gives the outcome, the remedy, and the connect target of a plain fetch", WINDOWS, async () => {
    const h = hostFor("t044-fetch-malformed");
    const { clone } = behindClone(h, "malformed");
    const plink = putty(h);
    await withSync("t044-fetch-malformed", async (service) => {
      service.runner.inject.sshClient = { plink };
      const r = await register(service, clone);
      const before = refMap(h, clone);
      const ends = [];
      for (const action of ["fetch", "pull"]) {
        const review = await reviewed(service, r, { action });
        service.runner.inject.stdout = (c) => (isFetch(c) ? new TextEncoder().encode("broken line\n") : undefined);
        const response = await sync(service, r, review.syncReviewToken);
        service.runner.inject.stdout = undefined;
        ends.push(await fetchEnd(service, r.repositoryId, response));
      }
      expect(ends[0]).toEqual({ outcome: { state: "failed", code: "MALFORMED_GIT_OUTPUT" }, remotes: ["failed"], remedy: undefined, connect: { state: "rejected", code: "UNKNOWN_TARGET" }, target: undefined });
      expect(ends[1]).toEqual(ends[0]);
      expect(refMap(h, clone)).toEqual(before);
      service.runner.inject.sshClient = "git";
    });
  }, TIMEOUT_MS);
});

// An empty `plink.exe` stand-in. The shell double checks only that it exists.
function putty(h: GitHost): string {
  mkdirSync(native(`${h.root}/putty`));
  const plink = native(`${h.root}/putty/plink.exe`);
  writeFileSync(plink, "");
  return plink;
}

// The fetch facts of one sync, then `connectInTerminal` for its operation (data-model §11).
async function fetchEnd(service: Service, repositoryId: string, response: Awaited<ReturnType<typeof sync>>) {
  const terminals = () => service.runner.frames.filter((f) => f.type === "terminal");
  const known = terminals().length;
  const connected = await service.request("connectInTerminal", { operationId: response.operationId! }, { repositoryId });
  return {
    outcome: outcome(response),
    remotes: response.result!.fetch!.remotes.map((x) => x.state),
    remedy: response.result!.remedy,
    connect: outcome(connected),
    target: (terminals()[known] as { target?: string } | undefined)?.target,
  };
}

const psQuote = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > end) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await Bun.sleep(20);
  }
}
