// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 T018: the remote branch delete through the distro Git of `ARBARETO_WSL_DISTRO` (spec FR-015, SC-010; plan.md D10). `Local: WSL`, alone.
// Run it only in `Ubuntu-26.04` (Git 2.55.0). Never set `ARBARETO_WSL_ORDER_DISTROS`. Never run `wsl --shutdown`, `--terminate`, or `--unregister`.
// The cases never touch PuTTY, Pageant, or `~/.ssh`. They write no `.gitconfig`. The harness owns the global file in the fixture folder.
// The bare remote lies in the owned distro folder, and its URL is its Linux path. Each work clone holds a repository-local commit identity.
// The oracle is the distro Git's own steps on a `cp -a` copy in the same distro. sha256sum hashes the configuration file in the distro.
// Control: give the oracle push of the success case the `main` commit as the expect. The state comparison must fail.

import { expect } from "bun:test";
import { printOrigin } from "../origin";
import { outcome, readOk, SUCCEEDED } from "../git/hunk-harness";
import { fc, gitOut, gitRun, importStream, refMap, type GitHost } from "../git/remote-fixtures";
import type { RegistrationResult, Service } from "../git/service-harness";
import { ANY_EXIT, remoteCalls, sendSync, until, type Reviewed, type SyncResult } from "../git/sync-harness";
import { AFTER_CLOSE_MS, headOf, hostOf, L, localConfig, open, refusalOf, type Repo, request, RESPONSE_MS, steps, useWorkbenchWsl, W, withWsl } from "./workbench-wsl-harness";
import { inDistro, listScopes, pgrep, wslExec, type WslHost } from "./wsl-host";

for (const module of ["sync", "sync-review", "remote-delete", "sync-commands", "sync-parsers"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
printOrigin("./remote-delete-wsl.test.ts", import.meta.dir);
useWorkbenchWsl();

const ACTION = "delete-remote-branch";
const FEATURE = "refs/heads/feature";
const TRACKING = "refs/remotes/origin/feature";
const IDENTITY = [["user.name", "Arbareto Fixture"], ["user.email", "fixture@arbareto.invalid"]] as const;
const HOOK_START_MS = 120_000;
const DESTINATION = { remote: "origin", ref: FEATURE, trackingRef: TRACKING, setUpstream: false, upstreamRebase: false, source: "tracking-ref" };

// Contract Δ3 `sync`: the argument arrays of the run, in order.
const pushDelete = (expect: string) => [L, "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", `--force-with-lease=${FEATURE}:${expect}`, "--", "origin", `:${FEATURE}`];
const LS_REMOTE = [L, "ls-remote", "--exit-code", "--", "origin", FEATURE];
const dropTracking = (expect: string) => [L, "update-ref", "--no-deref", "-d", TRACKING, expect];
const combined = (tip: string) => [pushDelete(tip), [L, "update-ref", "--no-deref", "-d", FEATURE, tip], [L, "config", "--local", "--remove-section", "branch.feature"]];

type DeleteResult = SyncResult & { remoteGone?: true; localNotDeleted?: true };

interface World {
  w: WslHost;
  h: GitHost;
  root: string;
  tip: string;
}
const remoteOf = (root: string) => `${root}/origin.git`;
const workOf = (root: string) => `${root}/work`;
const oracleOf = (x: World) => `${x.root}-oracle`;

let builds = 0;
// `main` holds `base`. `feature` holds `base` and `feature`, so only `feature` and its tracking ref hold the tip (plan.md D4 read 10).
function world(w: WslHost, name: string): World {
  const h = hostOf(w);
  const root = `${h.root}/t018-${name}-${++builds}`;
  gitRun(h, h.root, ["init", "-q", "--bare", "-b", "main", "--", remoteOf(root)]);
  const marks = importStream(h, remoteOf(root), [
    fc({ mark: 1, message: "base\n", files: { "a.txt": "a\n" } }),
    fc({ mark: 2, ref: FEATURE, message: "feature\n", from: 1, files: { "f.txt": "f\n" } }),
  ]);
  gitRun(h, h.root, ["clone", "-q", "--", remoteOf(root), workOf(root)]);
  for (const [key, value] of IDENTITY) gitRun(h, workOf(root), ["config", "--local", key, value]);
  return { w, h, root, tip: marks.get(2)! };
}
const leaseOf = (x: World) => ({ trackingRef: TRACKING, expect: x.tip, count: 1, commits: [{ objectId: x.tip, subject: "feature" }] });

// Plan.md D16: the refs of the work clone and the bare remote, HEAD, and the local configuration bytes.
function stateAt(x: World, root: string) {
  const r: Repo = { w: x.w, h: x.h, dir: workOf(root) };
  return { head: headOf(r), local: refMap(x.h, r.dir), remote: refMap(x.h, remoteOf(root)), config: inDistro(x.w.distro, ["/usr/bin/sha256sum", "--", localConfig(r)]).slice(0, 64) };
}

// The copy holds the work clone and the bare remote. Make it before the service run.
const copyOracle = (x: World) => x.h.copy(x.root, oracleOf(x));
// git-config(1) `url.<base>.insteadOf` sends the steps of the copy to the copied remote. So the copied configuration bytes stay equal to the fixture bytes.
function oracle(x: World, args: string[][]): number[] {
  const url = gitOut(x.h, workOf(x.root), ["config", "--get", "remote.origin.url"]).trim();
  const rewrite = `url.${remoteOf(oracleOf(x))}.insteadOf=${url}`;
  return args.map((a) => gitRun(x.h, workOf(oracleOf(x)), ["-c", rewrite, ...a], { allowExit: ANY_EXIT }).exitCode);
}

async function trusted(s: Service, w: WslHost, dir: string): Promise<RegistrationResult> {
  const r = await open(s, w, dir);
  const trust = await request<{ approvalRequired: { sync: boolean } }>(s, "readTrust", {}, { repositoryId: r.repositoryId });
  if (trust.result!.approvalRequired.sync) expect((await request(s, "approveTrust", { action: "push" }, { repositoryId: r.repositoryId })).state).toBe("succeeded");
  return r;
}
async function reviewDelete(s: Service, r: RegistrationResult, payload: { ref: string; local?: string }) {
  const read = await readOk(s, r.repositoryId);
  return request<Reviewed>(s, "reviewSync", { action: ACTION, ...payload }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
}
async function reviewed(s: Service, r: RegistrationResult, payload: { ref: string; local?: string }): Promise<Reviewed & { syncReviewToken: string }> {
  const response = await reviewDelete(s, r, payload);
  expect(outcome(response)).toEqual(SUCCEEDED);
  expect(typeof response.result!.syncReviewToken).toBe("string");
  return response.result as Reviewed & { syncReviewToken: string };
}
const runDelete = (s: Service, r: RegistrationResult, token: string) => s.response<DeleteResult>(sendSync(s, r, token), RESPONSE_MS);
const flagsOf = (result: DeleteResult) => ({ remoteGone: result.remoteGone, localNotDeleted: result.localNotDeleted });

W("T018 SC-001: a remote-only delete with the lease equals the distro Git's own lease delete on a copy, and the configuration bytes stay", async (w) => {
  const x = world(w, "success");
  copyOracle(x);
  const before = stateAt(x, x.root);
  await withWsl(w, "t018-success", async (s) => {
    const r = await trusted(s, w, workOf(x.root));
    const rv = await reviewed(s, r, { ref: TRACKING });
    expect(rv.plan).toMatchObject({ remotes: ["origin"], destination: DESTINATION, lease: leaseOf(x) });
    const from = s.runner.calls.length;
    const done = await runDelete(s, r, rv.syncReviewToken);
    expect(outcome(done)).toEqual(SUCCEEDED);
    expect(done.result!.push).toMatchObject({ status: "deleted", oldObjectId: x.tip, newObjectId: null, lease: true, upstreamWritten: false, upstreamNotSet: false });
    expect(flagsOf(done.result!)).toEqual({ remoteGone: undefined, localNotDeleted: undefined });
    expect(steps(s, from, ["remote"])).toEqual([pushDelete(x.tip)]);
  });
  const exits = oracle(x, [pushDelete(x.tip)]);
  expect(stateAt(x, x.root)).toEqual(stateAt(x, oracleOf(x)));
  expect(exits).toEqual([0]);
  expect(stateAt(x, x.root).config).toBe(before.config);
});

W("T018 SC-002: a remote branch that moved after the fetch refuses the lease with stale-lease; the remote keeps every commit, and no ref changes", async (w) => {
  const x = world(w, "stale");
  importStream(x.h, remoteOf(x.root), [Buffer.from(`reset ${FEATURE}\nfrom ${x.tip}\n\n`), fc({ mark: 1, ref: FEATURE, message: "after the fetch\n", files: { "late.txt": "late\n" } })]);
  copyOracle(x);
  const before = stateAt(x, x.root);
  await withWsl(w, "t018-stale", async (s) => {
    const r = await trusted(s, w, workOf(x.root));
    const rv = await reviewed(s, r, { ref: TRACKING });
    expect(rv.plan).toMatchObject({ destination: DESTINATION, lease: leaseOf(x) });
    const from = s.runner.calls.length;
    const done = await runDelete(s, r, rv.syncReviewToken);
    expect({ ...outcome(done), reason: done.result!.reason }).toEqual({ state: "failed", code: "PUSH_REJECTED", reason: "stale-lease" });
    expect(done.result!.push).toMatchObject({ status: "rejected", oldObjectId: x.tip, newObjectId: x.tip, lease: true });
    expect(flagsOf(done.result!)).toEqual({ remoteGone: undefined, localNotDeleted: undefined });
    // Feature 003 contract Δ3: a remedy is text only for a WSL Git, so the command is null.
    expect({ text: typeof done.result!.remedy?.text, command: done.result!.remedy?.command }).toEqual({ text: "string", command: null });
    // Plan.md D8: the fetch URL equals the push URL, so the run checks the remote. The exact `<dst>` line keeps the stale outcome.
    expect(steps(s, from, ["remote"])).toEqual([pushDelete(x.tip), LS_REMOTE]);
  });
  const exits = oracle(x, [pushDelete(x.tip), LS_REMOTE]);
  expect(stateAt(x, x.root)).toEqual(before);
  expect(stateAt(x, x.root)).toEqual(stateAt(x, oracleOf(x)));
  expect(exits).toEqual([1, 0]);
});

W("T018 SC-003: the default branch of origin refuses with default-branch, and no network process starts", async (w) => {
  const x = world(w, "default");
  const before = stateAt(x, x.root);
  await withWsl(w, "t018-default", async (s) => {
    const r = await trusted(s, w, workOf(x.root));
    const from = s.runner.calls.length;
    expect(refusalOf(await reviewDelete(s, r, { ref: "refs/remotes/origin/main" }))).toEqual({ state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "default-branch" } });
    expect(remoteCalls(s, from)).toEqual([]);
  });
  expect(stateAt(x, x.root)).toEqual(before);
});

W("T018 SC-004: the combined delete equals the distro Git's lease delete, update-ref, and config --remove-section on a copy", async (w) => {
  const x = world(w, "combined");
  gitRun(x.h, workOf(x.root), ["branch", "--track", "feature", TRACKING]);
  copyOracle(x);
  await withWsl(w, "t018-combined", async (s) => {
    const r = await trusted(s, w, workOf(x.root));
    const rv = await reviewed(s, r, { ref: TRACKING, local: FEATURE });
    expect(rv.plan).toMatchObject({ remotes: ["origin"], destination: DESTINATION, lease: leaseOf(x), local: { ref: FEATURE, oid: x.tip } });
    const from = s.runner.calls.length;
    const done = await runDelete(s, r, rv.syncReviewToken);
    expect(outcome(done)).toEqual(SUCCEEDED);
    expect(done.result!.push).toMatchObject({ status: "deleted", oldObjectId: x.tip, newObjectId: null, lease: true });
    expect(flagsOf(done.result!)).toEqual({ remoteGone: undefined, localNotDeleted: undefined });
    expect(steps(s, from, ["remote"])).toEqual(combined(x.tip));
  });
  const exits = oracle(x, combined(x.tip));
  expect(stateAt(x, x.root)).toEqual(stateAt(x, oracleOf(x)));
  expect(exits).toEqual([0, 0, 0]);
});

W("T018 plan.md D8: a remote branch deleted after the fetch gives remoteGone; ls-remote exits 2, and update-ref with the expect removes the stale ref as on a copy", async (w) => {
  const x = world(w, "gone");
  gitRun(x.h, remoteOf(x.root), ["update-ref", "-d", FEATURE]);
  copyOracle(x);
  await withWsl(w, "t018-gone", async (s) => {
    const r = await trusted(s, w, workOf(x.root));
    const rv = await reviewed(s, r, { ref: TRACKING });
    const from = s.runner.calls.length;
    const done = await runDelete(s, r, rv.syncReviewToken);
    expect(outcome(done)).toEqual(SUCCEEDED);
    expect(done.result!.push).toMatchObject({ status: "rejected", oldObjectId: x.tip, newObjectId: null, lease: true });
    expect(flagsOf(done.result!)).toEqual({ remoteGone: true, localNotDeleted: undefined });
    expect(steps(s, from, ["remote"])).toEqual([pushDelete(x.tip), LS_REMOTE, dropTracking(x.tip)]);
  });
  const exits = oracle(x, [pushDelete(x.tip), LS_REMOTE, dropTracking(x.tip)]);
  expect(stateAt(x, x.root)).toEqual(stateAt(x, oracleOf(x)));
  expect(exits).toEqual([1, 2, 0]);
});

W("T018 SC-010: Cancel during a slow pre-receive hook of the remote ends canceled; no ref changes, and no process of the operation stays in the distro", async (w) => {
  const x = world(w, "cancel");
  const pidFile = `${x.root}/hook.pid`;
  // The hook keeps its PID through `exec`, so the PID file names the sleeping process.
  x.h.write(`${remoteOf(x.root)}/hooks/pre-receive`, `#!/bin/sh\necho $$ > '${pidFile}'\nexec /usr/bin/sleep 600\n`);
  const before = stateAt(x, x.root);
  await withWsl(w, "t018-cancel", async (s) => {
    const r = await trusted(s, w, workOf(x.root));
    const rv = await reviewed(s, r, { ref: TRACKING });
    const requestId = sendSync(s, r, rv.syncReviewToken);
    const operationId = await s.operationId(requestId);
    await until(() => /^\d+\n$/.test(x.h.read(pidFile)?.toString("utf8") ?? ""), "pre-receive hook start", HOOK_START_MS);
    const pid = x.h.read(pidFile)!.toString("utf8").trim();
    await s.cancel(operationId);
    expect(outcome(await s.response(requestId, RESPONSE_MS))).toEqual({ state: "canceled", code: "CANCELED" });
    await Bun.sleep(AFTER_CLOSE_MS);
    // proc(5): `/proc/<pid>` exists while the process exists. test(1) exits 1 for an absent path.
    const hook = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/usr/bin/test", "-e", `/proc/${pid}`]).exitCode;
    if (hook === 0) inDistro(w.distro, ["/usr/bin/kill", "-KILL", pid], { allowExit: [0, 1] });
    expect({ scopes: listScopes(w), operation: pgrep(w, operationId), hook }).toEqual({ scopes: [], operation: [], hook: 1 });
  });
  expect(stateAt(x, x.root)).toEqual(before);
});
