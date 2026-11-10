// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T006: the T005 Git facts (a) to (m) inside the WSL distro (plan.md P0.2). The fixtures live in the owned distro folder and use the distro Git, never `/mnt`.
// Each fact prints `OBSERVATION T006` lines. A `match=false` line is a finding for research.md, not a failure.
// T075: fetch, pull in each mode, push, force push with lease, and Mark resolved through the distro Git (spec SC-001, SC-014; plan.md D13). `Local: WSL`, alone.
// Run it only in `Ubuntu-26.04`. Never set `ARBARETO_WSL_ORDER_DISTROS`. Never run `wsl --shutdown`, `--terminate`, or `--unregister`.
// The bare remotes lie in the owned distro folder, and their URLs are Linux paths. The oracle is the distro Git's own step on a `cp -a` copy.
// Control: give the oracle push of the push case the `second` remote. The remote ref comparison must fail.

import { expect } from "bun:test";
import { printOrigin } from "../origin";
import { compare, outcome, readOk, SUCCEEDED } from "../git/hunk-harness";
import { FACTS, gitVersion, observationLine } from "../git/remote-facts";
import { buildFetchFlags, buildMergeConflict, buildPull, buildPush, configDigests, fc, gitRun, importStream, leftRight, MARKER_TEXT, pullRowCopy, PULL_ROWS, refMap, revParse, stageEntries, type GitHost, type PushFixture } from "../git/remote-fixtures";
import type { RegistrationResult, Service } from "../git/service-harness";
import { ANY_EXIT, copyWithRemotes, INTEGRATE_ENV, pullFlags, refreshIndex, remoteCalls, repoShape, sendSync, type Reviewed, type SyncResult } from "../git/sync-harness";
import { distroGitHost } from "./fixtures";
import { hostOf, open, request, RESPONSE_MS, useWorkbenchWsl, W, withWsl } from "./workbench-wsl-harness";
import { WSL_MINIMUM_GIT, wslTest, type WslHost } from "./wsl-host";

for (const module of ["sync", "sync-review", "sync-integrate"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
printOrigin("./sync-wsl.test.ts", import.meta.dir);
useWorkbenchWsl();

const TASK = "T006";
const FACT_MS = 1_800_000;
const NEEDS = ["distro-git-2.55", "wsl-fixture-fs-id"] as const;
const GLOBAL_TEXT = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";

function atLeastFloor(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) return false;
  for (let i = 0; i < 3; i++) if (Number(m[i + 1]) !== WSL_MINIMUM_GIT[i]) return Number(m[i + 1]) > WSL_MINIMUM_GIT[i]!;
  return true;
}

let host: GitHost | undefined;
const h = (w: WslHost) => (host ??= distroGitHost(w, "remote", GLOBAL_TEXT));

wslTest("distro Git version", NEEDS, (w) => {
  const version = gitVersion(h(w));
  console.log(observationLine(TASK, version, { fact: "version", expected: `>=${WSL_MINIMUM_GIT.join(".")}`, observed: version, match: atLeastFloor(version) }));
});

for (const fact of FACTS) {
  wslTest(`(${fact.id}) ${fact.title}`, NEEDS, (w) => {
    const version = gitVersion(h(w));
    const observations = fact.run(h(w));
    expect(observations.length).toBeGreaterThan(0);
    for (const o of observations) console.log(observationLine(TASK, `${version}@${w.distro}`, o));
  }, FACT_MS);
}

// T075 cases. Contract Δ3 `sync`: the argument arrays of the remote steps.
const FETCH = ["--no-lazy-fetch", "fetch", "--porcelain", "--progress", "--no-recurse-submodules", "--", "origin"];
const PUSH = (refspec: string, extra: string[] = []) => ["--no-lazy-fetch", "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", ...extra, "--", "origin", refspec];
const TOPIC = "refs/heads/topic:refs/heads/topic";
const PULL_MODES = ["diverged payload-merge", "diverged payload-rebase"].map((name) => PULL_ROWS.find((row) => row.name === name)!);
// Data-model §9: the accepted kinds of `buildMergeConflict`, with `exec.sh` as the exec-bit stage.
const ACCEPTED: Record<string, string> = { "uu.txt": "UU", "aa.txt": "AA", "au.txt": "AU", "ua.txt": "UA", "du.txt": "DU", "ud.txt": "UD", "exec.sh": "UU" };

let copies = 0;
const copyOf = (g: GitHost, from: string, tag: string): string => {
  const to = `${g.root}/t075-${tag}-${++copies}`;
  g.copy(from, to);
  return refreshIndex(g, to);
};
// The push fixture builds once per file, because its paths under the host root are fixed.
let pushFixture: PushFixture | undefined;
function pushCopy(g: GitHost, tag: string): { repo: string; remotes: Record<string, string> } {
  pushFixture ??= buildPush(g);
  const c = copyWithRemotes(g, pushFixture.clone, { origin: pushFixture.origin, second: pushFixture.second }, `t075-${tag}-${++copies}`);
  gitRun(g, c.repo, ["checkout", "-q", "topic"]);
  return c;
}

async function reviewed(s: Service, r: RegistrationResult, payload: object): Promise<Reviewed & { syncReviewToken: string }> {
  const read = await readOk(s, r.repositoryId);
  const response = await request<Reviewed>(s, "reviewSync", payload, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
  expect(outcome(response)).toEqual(SUCCEEDED);
  expect(typeof response.result!.syncReviewToken).toBe("string");
  return response.result as Reviewed & { syncReviewToken: string };
}
const runSync = (s: Service, r: RegistrationResult, token: string) => s.response<SyncResult>(sendSync(s, r, token), RESPONSE_MS);
const remoteArgs = (s: Service, from: number) => remoteCalls(s, from).map((c) => [...c.arguments]);

// git-fetch(1) `--porcelain`: "<flag> <old-object-id> <new-object-id> <local-reference>", one line per updated ref.
const porcelainUpdates = (out: string) => out.split("\n").filter((l) => l !== "").map((l) => [l[0]!, l.slice(2).split(" ")[2]!]).sort();

// git-status(1) porcelain v2 `u` record: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>".
function worktreeModes(g: GitHost, repo: string): Record<string, string> {
  const modes: Record<string, string> = {};
  for (const record of gitRun(g, repo, ["status", "--porcelain=v2", "-z", "--untracked-files=no"]).stdout.toString("utf8").split("\0")) {
    const m = /^u \S\S \S{4} \d{6} \d{6} \d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ [0-9a-f]+ ([\s\S]+)$/.exec(record);
    if (m) modes[m[2]!] = m[1]!;
  }
  return modes;
}

W("T075 SC-001: a fetch equals the distro Git's own fetch on a copy, lists the same porcelain flags, and keeps the configuration bytes", async (w) => {
  const g = hostOf(w);
  const f = buildFetchFlags(g);
  const app = copyOf(g, f.clone, "fetch");
  // Without the moved tag, Git's own fetch exits 0.
  gitRun(g, app, ["tag", "-d", "t1"]);
  const oracle = copyOf(g, app, "fetch-oracle");
  const config = configDigests(g, app);
  await withWsl(w, "t075-fetch", async (s) => {
    const r = await open(s, w, app);
    const rv = await reviewed(s, r, { action: "fetch" });
    expect(rv.plan.remotes).toEqual(["origin"]);
    const from = s.runner.calls.length;
    const done = await runSync(s, r, rv.syncReviewToken);
    expect(outcome(done)).toEqual(SUCCEEDED);
    const fetched = done.result!.fetch!;
    expect(fetched.remotes.map((x) => [x.name, x.state])).toEqual([["origin", "succeeded"]]);
    const own = gitRun(g, oracle, ["fetch", "--porcelain", "origin"]).stdout.toString("utf8");
    expect(fetched.remotes[0]!.updates.map((u) => [u.flag, u.ref]).sort()).toEqual(porcelainUpdates(own));
    expect(remoteArgs(s, from)).toEqual([FETCH]);
  });
  expect(refMap(g, app)).toEqual(refMap(g, oracle));
  expect(configDigests(g, app)).toEqual(config);
});

W("T075 SC-001: pull with mode merge and with mode rebase equals the distro Git's own pull on a copy and keeps the configuration bytes", async (w) => {
  const g = hostOf(w);
  const f = buildPull(g);
  for (const row of PULL_MODES) {
    const app = refreshIndex(g, pullRowCopy(g, f, row, `${g.root}/t075-pull-${++copies}`));
    const oracle = copyOf(g, app, "pull-oracle");
    const config = configDigests(g, app);
    let result: SyncResult | undefined;
    await withWsl(w, `t075-pull-${copies}`, async (s) => {
      const r = await open(s, w, app);
      const rv = await reviewed(s, r, { action: "pull", mode: row.payload });
      const from = s.runner.calls.length;
      const done = await runSync(s, r, rv.syncReviewToken);
      result = done.result;
      expect({ row: row.name, ...outcome(done), integration: result?.integration?.state, modeSource: result?.modeSource }).toEqual({ row: row.name, ...SUCCEEDED, integration: "done", modeSource: "payload" });
      expect({ row: row.name, fetches: remoteArgs(s, from).filter((a) => a[1] === "fetch") }).toEqual({ row: row.name, fetches: [FETCH] });
    });
    // Git's own pull on the copy: a plain fetch first gives the counts that the pull decides from.
    gitRun(g, oracle, ["fetch", "-q", "origin"]);
    const [ahead, behind] = leftRight(g, oracle, "HEAD", revParse(g, oracle, `refs/remotes/origin/${row.branch}`));
    const pulled = gitRun(g, oracle, ["pull", ...pullFlags(row.payload)], { allowExit: ANY_EXIT, env: INTEGRATE_ENV });
    expect({ row: row.name, exit: pulled.exitCode, counts: result?.counts }).toEqual({ row: row.name, exit: 0, counts: { ahead, behind } });
    expect({ row: row.name, shape: repoShape(g, app) }).toEqual({ row: row.name, shape: repoShape(g, oracle) });
    expect({ row: row.name, config: configDigests(g, app) }).toEqual({ row: row.name, config });
  }
});

W("T075 SC-001: a push gives the remote branch and the tracking ref of the distro Git's own push on a copy, and keeps the configuration bytes", async (w) => {
  const g = hostOf(w);
  const a = pushCopy(g, "push");
  const b = pushCopy(g, "push-oracle");
  const base = revParse(g, a.repo, "refs/remotes/origin/topic");
  const config = configDigests(g, a.repo);
  await withWsl(w, "t075-push", async (s) => {
    const r = await open(s, w, a.repo);
    const rv = await reviewed(s, r, { action: "push" });
    expect(rv.plan.destination).toMatchObject({ remote: "origin", ref: "refs/heads/topic", trackingRef: "refs/remotes/origin/topic", setUpstream: false, source: "push-default-branch" });
    const from = s.runner.calls.length;
    const done = await runSync(s, r, rv.syncReviewToken);
    expect(outcome(done)).toEqual(SUCCEEDED);
    expect(done.result!.push).toMatchObject({ status: "pushed", oldObjectId: base, newObjectId: revParse(g, a.repo, "HEAD"), lease: false, upstreamWritten: false });
    expect(remoteArgs(s, from)).toEqual([PUSH(TOPIC)]);
  });
  gitRun(g, b.repo, ["push", "-q", "origin"]);
  expect(refMap(g, a.remotes.origin!)).toEqual(refMap(g, b.remotes.origin!));
  expect(refMap(g, a.repo, ["refs/remotes"])).toEqual(refMap(g, b.repo, ["refs/remotes"]));
  expect(configDigests(g, a.repo)).toEqual(config);
});

W("T075 SC-001: a force push with lease on an unchanged remote equals the distro Git's own lease push on a copy, and the result names the replaced commit", async (w) => {
  const g = hostOf(w);
  const a = pushCopy(g, "force");
  const base = revParse(g, a.remotes.origin!, "refs/heads/topic");
  importStream(g, a.remotes.origin!, [Buffer.from(`reset refs/heads/topic\nfrom ${base}\n\n`), fc({ mark: 1, ref: "refs/heads/topic", message: "remote only\n", files: { "remote.txt": "remote\n" } })], { force: true });
  gitRun(g, a.repo, ["fetch", "-q", "origin"]);
  const tracking = revParse(g, a.repo, "refs/remotes/origin/topic");
  const head = revParse(g, a.repo, "HEAD");
  const lease = `--force-with-lease=refs/heads/topic:${tracking}`;
  const b = copyWithRemotes(g, a.repo, { origin: a.remotes.origin! }, `t075-force-oracle-${++copies}`);
  await withWsl(w, "t075-force", async (s) => {
    const r = await open(s, w, a.repo);
    const rv = await reviewed(s, r, { action: "force-push" });
    expect(rv.plan.lease).toEqual({ trackingRef: "refs/remotes/origin/topic", expect: tracking, count: 1, commits: [{ objectId: tracking, subject: "remote only" }] });
    const from = s.runner.calls.length;
    const done = await runSync(s, r, rv.syncReviewToken);
    expect(outcome(done)).toEqual(SUCCEEDED);
    expect(done.result!.push).toMatchObject({ status: "forced", oldObjectId: tracking, newObjectId: head, lease: true });
    expect(remoteArgs(s, from)).toEqual([PUSH(TOPIC, [lease])]);
  });
  gitRun(g, b.repo, ["push", "-q", lease, "--", "origin", TOPIC]);
  expect(refMap(g, a.remotes.origin!, ["refs/heads/topic"])).toEqual({ "refs/heads/topic": head });
  expect(refMap(g, a.remotes.origin!)).toEqual(refMap(g, b.remotes.origin!));
  expect(refMap(g, a.repo, ["refs/remotes"])).toEqual(refMap(g, b.repo, ["refs/remotes"]));
});

W("T075 SC-014: Mark resolved of each accepted unmerged kind gives the index of the distro Git's own git add on a copy, one stage-0 entry in mode mW, and unchanged working bytes", async (w) => {
  const g = hostOf(w);
  const { repo } = buildMergeConflict(g, "t075-merge");
  g.write(`${repo}/uu.txt`, MARKER_TEXT);
  await withWsl(w, "t075-resolve", async (s) => {
    const r = await open(s, w, repo);
    // The fixture filter driver is repository-controlled, so the reads need approval (001 contract §7).
    await s.readTrust(r.repositoryId);
    expect((await s.approveTrust(r.repositoryId)).state).toBe("succeeded");
    for (const [path, kind] of Object.entries(ACCEPTED)) {
      const mW = worktreeModes(g, repo)[path];
      const oracle = copyOf(g, repo, "resolve-oracle");
      const files = g.digests(repo);
      const c = await compare(s, r.repositoryId, path, "conflicted");
      expect({ path, kind, state: c.response.state, decision: (c.response.result as { fileAction?: string } | undefined)?.fileAction }).toEqual({ path, kind, state: "succeeded", decision: "resolve" });
      const response = await request<{ reason?: string }>(s, "applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction: "resolve" }, { repositoryId: r.repositoryId, repositoryGeneration: c.read.generation });
      expect({ path, kind, ...outcome(response) }).toEqual({ path, kind, ...SUCCEEDED });
      gitRun(g, oracle, ["--literal-pathspecs", "add", "--", path]);
      expect({ path, kind, index: stageEntries(g, repo) }).toEqual({ path, kind, index: stageEntries(g, oracle) });
      expect({ path, kind, entries: stageEntries(g, repo, [path]).map((e) => ({ mode: e.mode, stage: e.stage })) }).toEqual({ path, kind, entries: [{ mode: mW!, stage: 0 }] });
      expect({ path, kind, files: g.digests(repo) }).toEqual({ path, kind, files });
    }
  });
});
