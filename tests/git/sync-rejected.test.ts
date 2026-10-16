// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T035: the rejected-push flow and `force-push` (contract Δ3, plan.md D5, FR-023 to FR-025, SC-002, SC-010).
// The lease oracle is `rev-list` of the fixture. A lost remote commit shows in the remote refs and objects.

import { expect } from "bun:test";
import { SYNC_LEASE_COMMITS } from "../../src/contracts/limits";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { buildPush, fc, gitOut, gitRun, importStream, refMap, revParse, type GitHost, type PushFixture } from "./remote-fixtures";
import { caseTest } from "./service-harness";
import { copyWithRemotes, hostFor, register, remoteCalls, reviewed, reviewSync, run, subcommandOf, sync, TIMEOUT_MS, withSync, refusalOf } from "./sync-harness";

useFixtureRoot();

const TASK = "T035";
const SHELL = ["shell-double"] as const;
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const SUCCEEDED = { state: "succeeded", code: undefined };
// The remote branch gets this many commits that the local branch lacks.
const REMOTE_COMMITS = SYNC_LEASE_COMMITS + 5;

// Every object that the remote can reach from a ref. A force push that loses a commit drops it from this set.
const reachable = (h: GitHost, repo: string) => gitOut(h, repo, ["rev-list", "--all", "--objects"]).split("\n").filter((l) => l !== "").sort();

describeGit("rejected push and force push with lease (T035)", () => {
  let fixture: { h: GitHost; f: PushFixture } | null = null;
  let copies = 0;
  // A copy of the push clone on `topic` with its own remotes. The remote `topic` holds REMOTE_COMMITS commits that the local branch lacks.
  const diverged = (fetched: boolean) => {
    if (fixture === null) {
      const h = hostFor("t035-push");
      fixture = { h, f: buildPush(h) };
    }
    const { h, f } = fixture;
    const copy = copyWithRemotes(h, f.clone, { origin: f.origin, second: f.second }, `diverged-${++copies}`);
    const base = revParse(h, f.origin, "refs/heads/topic");
    const commits = Array.from({ length: REMOTE_COMMITS }, (_, i) => fc({ mark: i + 1, ref: "refs/heads/topic", message: `remote ${i + 1}\n\nbody ${i + 1}\n`, from: i === 0 ? undefined : i, files: { "remote.txt": `${i + 1}\n` } }));
    importStream(h, copy.remotes.origin!, [Buffer.from(`reset refs/heads/topic\nfrom ${base}\n\n`), ...commits], { force: true });
    gitRun(h, copy.repo, ["checkout", "-q", "topic"]);
    if (fetched) gitRun(h, copy.repo, ["fetch", "-q", "origin"]);
    return { h, ...copy };
  };

  caseTest(TASK, "FR-023: a diverged remote gives PUSH_REJECTED reason rejected, and the fetch choice with the push remote equals Git's own fetch on a copy (SC-002)", SHELL, async () => {
    const a = diverged(false);
    const oracle = `${a.h.root}/oracle-${copies}`;
    a.h.copy(a.repo, oracle);
    gitRun(a.h, oracle, ["fetch", "-q", "origin"]);
    await withSync("t035-rejected", async (service) => {
      const r = await register(service, a.repo);
      const rejected = await run(service, r, { action: "push" });
      expect(outcome(rejected)).toEqual({ state: "failed", code: "PUSH_REJECTED" });
      expect(rejected.result!.push).toMatchObject({ status: "rejected", lease: false });
      const fetched = await run(service, r, { action: "fetch", remote: "origin" });
      expect(outcome(fetched)).toEqual(SUCCEEDED);
      expect(refMap(a.h, a.repo)).toEqual(refMap(a.h, oracle));
    });
  }, TIMEOUT_MS);

  caseTest(TASK, `D5: the force-push review reads the tracking OID, the exact count, and at most ${SYNC_LEASE_COMMITS} subjects; an unchanged remote takes the local branch and the result names the replaced commit`, SHELL, async () => {
    const a = diverged(true);
    const tracking = revParse(a.h, a.repo, "refs/remotes/origin/topic");
    const head = revParse(a.h, a.repo, "HEAD");
    const listed = gitOut(a.h, a.repo, ["rev-list", `--max-count=${SYNC_LEASE_COMMITS}`, tracking, `^${head}`]).split("\n").filter((l) => l !== "");
    const subjects = listed.map((oid) => gitOut(a.h, a.repo, ["log", "-1", "--format=%s", oid]).trim());
    const count = Number(gitOut(a.h, a.repo, ["rev-list", "--count", tracking, `^${head}`]).trim());
    expect(count).toBe(REMOTE_COMMITS);
    await withSync("t035-force", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, { action: "force-push" });
      expect(review.plan.lease).toEqual({ trackingRef: "refs/remotes/origin/topic", expect: tracking, count, commits: listed.map((objectId, i) => ({ objectId, subject: subjects[i]! })) });
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(response.result!.push).toMatchObject({ status: "forced", oldObjectId: tracking, newObjectId: head, lease: true });
      expect(refMap(a.h, a.remotes.origin!, ["refs/heads/topic"])).toEqual({ "refs/heads/topic": head });
      expect(remoteCalls(service, from).map((c) => c.arguments)).toEqual([
        ["--no-lazy-fetch", "push", "--porcelain", "--progress", "--no-recurse-submodules", "--no-follow-tags", `--force-with-lease=refs/heads/topic:${tracking}`, "--", "origin", "refs/heads/topic:refs/heads/topic"],
      ]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "D5: without a tracking ref the reason is no-lease", SHELL, async () => {
    const a = diverged(true);
    gitRun(a.h, a.repo, ["update-ref", "-d", "refs/remotes/origin/topic"]);
    await withSync("t035-no-lease", async (service) => {
      const r = await register(service, a.repo);
      const response = await reviewSync(service, r, { action: "force-push" });
      expect(refusalOf(response)).toEqual({ state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "no-lease" } });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "D5: a tracking OID that changes between review and sync gives STALE_REVIEW and starts no process", SHELL, async () => {
    const a = diverged(true);
    const base = revParse(a.h, a.repo, "refs/remotes/origin/topic~1");
    await withSync("t035-stale", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, { action: "force-push" });
      gitRun(a.h, a.repo, ["update-ref", "refs/remotes/origin/topic", base]);
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect(outcome(response)).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(remoteCalls(service, from)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-025: a remote that moved after the last fetch refuses the lease with stale-lease, and the remote keeps every commit and object", SHELL, async () => {
    const a = diverged(true);
    await withSync("t035-stale-lease", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, { action: "force-push" });
      importStream(a.h, a.remotes.origin!, [Buffer.from(`reset refs/heads/topic\nfrom ${review.plan.lease!.expect}\n\n`), fc({ mark: 1, ref: "refs/heads/topic", message: "after the fetch\n", files: { "late.txt": "late\n" } })]);
      const refsBefore = refMap(a.h, a.remotes.origin!);
      const objectsBefore = reachable(a.h, a.remotes.origin!);
      const response = await sync(service, r, review.syncReviewToken);
      expect(outcome(response)).toEqual({ state: "failed", code: "PUSH_REJECTED" });
      expect(response.result!.push).toMatchObject({ status: "rejected", lease: true });
      expect(refMap(a.h, a.remotes.origin!)).toEqual(refsBefore);
      expect(reachable(a.h, a.remotes.origin!)).toEqual(objectsBefore);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-025: no push process of this file forces without a lease", SHELL, async () => {
    const a = diverged(true);
    await withSync("t035-no-force", async (service) => {
      const r = await register(service, a.repo);
      await run(service, r, { action: "push" });
      await run(service, r, { action: "force-push" });
      const pushes = service.runner.calls.filter((c) => subcommandOf(c.arguments) === "push");
      expect(pushes.length).toBe(2);
      for (const p of pushes) {
        const forcing = p.arguments.filter((x) => x.startsWith("--force") || x === "-f" || /^\+/.test(x));
        expect(forcing.every((x) => /^--force-with-lease=refs\/heads\/[^:]+:[0-9a-f]{40}$/.test(x))).toBe(true);
      }
    });
  }, TIMEOUT_MS);
});
