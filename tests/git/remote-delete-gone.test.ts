// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 T012: the gone recovery after a stale lease (plan.md D8, user decision Q1 option a, research.md R2 P15, P16, P18, R5 U8).
// The oracle runs Git's own lease delete, `ls-remote --exit-code`, and `update-ref -d` on a copy.

import { expect } from "bun:test";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { buildBase, copyOf, DELETE_ARGS, fileUrl, gitDelete, isLsRemote, isUpdateRef, LS_REMOTE_ARGS, logHook, moveRemote, NETWORK_LIMITS, outcome, payloadOf, phasesOf, stateOf, SUCCEEDED, type Base, type Copy } from "./remote-delete-harness";
import { gitRun, revParse } from "./remote-fixtures";
import { caseTest, type Service } from "./service-harness";
import { callsFrom, register, remoteCalls, reviewed, sendSync, sync, TIMEOUT_MS, withSync, type SyncResult } from "./sync-harness";

useFixtureRoot();

const TASK = "T012";
const SHELL = ["shell-double"] as const;
const FEATURE = "refs/remotes/origin/feature";
const DST = "refs/heads/feature";

let base: Base | null = null;
const own = (): Copy => copyOf((base ??= buildBase("t012-base")));
// Another clone deleted the remote branch (research.md R2 P18).
const goneOnRemote = (c: Copy) => gitRun(c.h, c.origin, ["update-ref", "-d", DST]);

type DeleteResult = SyncResult & { remoteGone?: true; localNotDeleted?: true };

async function approve(service: Service, repositoryId: string): Promise<void> {
  expect((await service.readTrust(repositoryId)).result!.approvalRequired.sync).toBe(true);
  expect((await service.approveTrust(repositoryId)).state).toBe("succeeded");
}

describeGit("gone recovery (011 T012)", () => {
  caseTest(TASK, "P18: a remote branch that another clone deleted gives intended with remoteGone; the stale tracking ref goes as with Git's own steps on a copy", SHELL, async () => {
    const a = own();
    const b = own();
    goneOnRemote(a);
    goneOnRemote(b);
    const expectOid = revParse(a.h, a.repo, FEATURE);
    const before = stateOf(a);
    await withSync("t012-gone", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE));
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(response.result as DeleteResult).toEqual({ action: "delete-remote-branch", push: { status: "rejected", oldObjectId: expectOid, newObjectId: null, reasonText: "stale info", lease: true, upstreamWritten: false, upstreamNotSet: false, outputTail: expect.any(String) }, remoteGone: true });
      expect(remoteCalls(service, from).map((c) => [c.arguments, c.environmentPolicy, c.limits])).toEqual([
        [DELETE_ARGS("origin", DST, expectOid), "remote", NETWORK_LIMITS],
        [LS_REMOTE_ARGS("origin", DST), "remote", NETWORK_LIMITS],
        [["--no-lazy-fetch", "update-ref", "--no-deref", "-d", FEATURE, expectOid], "remote", NETWORK_LIMITS],
      ]);
    });
    expect(gitDelete(b, DST, expectOid)).toBe(1);
    expect(gitRun(b.h, b.repo, ["ls-remote", "--exit-code", "--", "origin", DST], { allowExit: [2] }).exitCode).toBe(2);
    gitRun(b.h, b.repo, ["update-ref", "--no-deref", "-d", FEATURE, expectOid]);
    const after = stateOf(a);
    expect({ refs: after.refs, remote: after.remote, head: after.head }).toEqual((({ refs, remote, head }) => ({ refs, remote, head }))(stateOf(b)));
    expect(after.config).toBe(before.config);
  }, TIMEOUT_MS);

  caseTest(TASK, "D8: a moved remote branch keeps the stale outcome; the exact ls-remote line names it, so no update-ref runs", SHELL, async () => {
    const a = own();
    moveRemote(a, "feature");
    const before = stateOf(a);
    await withSync("t012-moved", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE));
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect({ ...outcome(response), reason: response.result!.reason, remoteGone: (response.result as DeleteResult).remoteGone }).toEqual({ state: "failed", code: "PUSH_REJECTED", reason: "stale-lease", remoteGone: undefined });
      expect(callsFrom(service, from).filter(isLsRemote).map((c) => c.exit?.exitCode)).toEqual([0]);
      expect(callsFrom(service, from).filter(isUpdateRef)).toEqual([]);
    });
    expect(stateOf(a)).toEqual(before);
  }, TIMEOUT_MS);

  caseTest(TASK, "P16: with a pushurl in other bytes than the URL, a gone remote branch runs no gone check and keeps the stale outcome", SHELL, async () => {
    const a = own();
    goneOnRemote(a);
    gitRun(a.h, a.repo, ["config", "remote.origin.pushurl", fileUrl(a.origin)]);
    const before = stateOf(a);
    await withSync("t012-pushurl", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE));
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect({ ...outcome(response), reason: response.result!.reason }).toEqual({ state: "failed", code: "PUSH_REJECTED", reason: "stale-lease" });
      expect(callsFrom(service, from).filter(isLsRemote)).toEqual([]);
    });
    expect(stateOf(a)).toEqual(before);
  }, TIMEOUT_MS);

  // Research.md R2 P15: a pattern matches a ref tail, so only an exact `<dst>` line names the branch.
  caseTest(TASK, "P15: a remote that holds refs/heads/x/refs/heads/feature but not refs/heads/feature is gone by the exact parse", SHELL, async () => {
    const a = own();
    const tail = `refs/heads/x/${DST}`;
    const kept = revParse(a.h, a.origin, DST);
    gitRun(a.h, a.origin, ["update-ref", tail, kept]);
    goneOnRemote(a);
    expect(gitRun(a.h, a.repo, ["ls-remote", "--exit-code", "--", "origin", DST]).stdout.toString("utf8")).toContain(`\t${tail}\n`);
    await withSync("t012-tail", async (service) => {
      const r = await register(service, a.repo);
      const response = await sync(service, r, (await reviewed(service, r, payloadOf(FEATURE))).syncReviewToken);
      expect({ ...outcome(response), remoteGone: (response.result as DeleteResult).remoteGone }).toEqual({ ...SUCCEEDED, remoteGone: true });
    });
    const after = stateOf(a);
    expect({ tracking: after.refs[FEATURE], tail: after.remote[tail] }).toEqual({ tracking: undefined, tail: kept });
  }, TIMEOUT_MS);

  // Research.md R5 U8: Git runs the pre-push hook when the lease refuses every ref.
  caseTest(TASK, "D8: an approved pre-push hook that moves the tracking ref during the run makes the bound update-ref -d refuse; the stale outcome stays and the hook log shows the run", SHELL, async () => {
    const a = own();
    goneOnRemote(a);
    const log = `${a.h.root}/${a.repo.split("/").at(-1)}-pre-push.log`;
    const main = revParse(a.h, a.repo, "refs/remotes/origin/main");
    logHook(a, "pre-push", log, `git update-ref ${FEATURE} ${main}\nexit 0`);
    await withSync("t012-hook-moves", async (service) => {
      const r = await register(service, a.repo);
      await approve(service, r.repositoryId);
      const review = await reviewed(service, r, payloadOf(FEATURE));
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      // The hook changed a ref, so the outcome has effects (plan.md D6 "Any failure with a changed ref").
      expect({ ...outcome(response), reason: response.result!.reason, remoteGone: (response.result as DeleteResult).remoteGone }).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS", reason: "stale-lease", remoteGone: undefined });
      const removal = callsFrom(service, from).filter(isUpdateRef);
      expect(removal.map((c) => c.exit?.exitCode === 0)).toEqual([false]);
    });
    expect(stateOf(a).refs[FEATURE]).toBe(main);
    expect(a.h.read(log)?.toString("utf8")).toBe("run\n");
  }, TIMEOUT_MS);

  caseTest(TASK, "sync.ts staleOf: a tracking ref move before the run refuses with STALE_REVIEW before any network process", SHELL, async () => {
    const a = own();
    goneOnRemote(a);
    await withSync("t012-moved-before", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE));
      gitRun(a.h, a.repo, ["update-ref", FEATURE, revParse(a.h, a.repo, "refs/remotes/origin/main")]);
      const before = stateOf(a);
      const from = service.runner.calls.length;
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(remoteCalls(service, from)).toEqual([]);
      expect(stateOf(a)).toEqual(before);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "D7: the combined form removes the stale ref, then the local branch and its section, with one sync-delete-local event", SHELL, async () => {
    const a = own();
    gitRun(a.h, a.repo, ["branch", "-q", "--track", "feature", "origin/feature"]);
    goneOnRemote(a);
    const tip = revParse(a.h, a.repo, "refs/heads/feature");
    await withSync("t012-combined", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE, "refs/heads/feature"));
      const from = service.runner.calls.length;
      const requestId = sendSync(service, r, review.syncReviewToken);
      const response = await service.response<DeleteResult>(requestId);
      expect({ ...outcome(response), remoteGone: response.result!.remoteGone, localNotDeleted: response.result!.localNotDeleted }).toEqual({ ...SUCCEEDED, remoteGone: true, localNotDeleted: undefined });
      expect(remoteCalls(service, from).map((c) => c.arguments[1])).toEqual(["push", "ls-remote", "update-ref", "update-ref", "config"]);
      expect(remoteCalls(service, from)[3]!.arguments).toEqual(["--no-lazy-fetch", "update-ref", "--no-deref", "-d", "refs/heads/feature", tip]);
      expect(phasesOf(service, requestId).filter((p) => p === "sync-delete-local")).toEqual(["sync-delete-local"]);
    });
    const after = stateOf(a);
    expect({ tracking: after.refs[FEATURE], local: after.refs["refs/heads/feature"], section: after.config.includes('[branch "feature"]') }).toEqual({ tracking: undefined, local: undefined, section: false });
  }, TIMEOUT_MS);
});
