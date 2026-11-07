// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 T009: `reviewSync` and `sync` with `delete-remote-branch` for a remote branch alone (plan.md D4 to D6 and D16, data-model §2 to §6, SC-001 to SC-003, SC-006).
// The oracle is Git's own lease delete on a copy with its own copy of the remote.

import { describe, expect } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { CANCELED_PUSH_TEXT } from "../../src/git-service/sync";
import { startHttpRemote } from "../support/http-remote";
import { useFixtureRoot } from "./fixture-root";
import { describeGit, fixtureGitPath } from "./git-binary";
import { buildBase, copyOf, DELETE_ARGS, fileUrl, gitDelete, isLsRemote, isPush, LONG_COMMITS, moveRemote, NETWORK_LIMITS, outcome, payloadOf, phasesOf, pruneText, stateOf, STEP_REMEDY, SUCCEEDED, type Base, type Copy } from "./remote-delete-harness";
import { buildCredentialRemote, fc, gitOut, gitRun, HTTP_PASSWORD, HTTP_USER, importStream, nativeEnv, revParse } from "./remote-fixtures";
import { caseTest, type Service } from "./service-harness";
import { callsFrom, gitExe, helperGlobal, hostFor, native, refusalOf, register, remoteCalls, reviewed, reviewSync, sendSync, subcommandOf, sync, TIMEOUT_MS, until, withSync, type SyncResult } from "./sync-harness";

useFixtureRoot();

const TASK = "T009";
const SHELL = ["shell-double"] as const;
const WINDOWS = ["shell-double", "git-for-windows"] as const;
const FEATURE = "refs/remotes/origin/feature";

let base: Base | null = null;
const own = (): Copy => copyOf((base ??= buildBase("t009-base")));

async function approve(service: Service, repositoryId: string): Promise<void> {
  expect((await service.readTrust(repositoryId)).result!.approvalRequired.sync).toBe(true);
  expect((await service.approveTrust(repositoryId)).state).toBe("succeeded");
}

describeGit("remote branch delete (011 T009)", () => {
  caseTest(TASK, "SC-001: the delete of a branch and of a name with a slash equals Git's own lease delete on a copy; the plan, the one push array, and equal configuration bytes", SHELL, async () => {
    for (const [name, subject] of [["feature", "feature"], ["a/b", "slash"]] as const) {
      const a = own();
      const b = own();
      const ref = `refs/remotes/origin/${name}`;
      const dst = `refs/heads/${name}`;
      const expectOid = revParse(a.h, a.repo, ref);
      // Spec FR-009: a local branch that tracks the deleted branch keeps its upstream.
      // It starts at `main`: research.md R2 P14 drops the commits that a local branch holds from the lease count.
      for (const c of [a, b]) {
        gitRun(c.h, c.repo, ["branch", "-q", "keep", "main"]);
        gitRun(c.h, c.repo, ["branch", "-q", "--set-upstream-to", `origin/${name}`, "keep"]);
      }
      const before = stateOf(a);
      await withSync(`t009-success-${name.replace("/", "-")}`, async (service) => {
        const r = await register(service, a.repo);
        const review = await reviewed(service, r, payloadOf(ref));
        expect(review.plan).toEqual({
          remotes: ["origin"],
          destination: { remote: "origin", ref: dst, trackingRef: ref, url: a.origin, setUpstream: false, upstreamRebase: false, source: "tracking-ref" },
          lease: { trackingRef: ref, expect: expectOid, count: 1, commits: [{ objectId: expectOid, subject }] },
        });
        const from = service.runner.calls.length;
        const requestId = sendSync(service, r, review.syncReviewToken);
        const response = await service.response<SyncResult>(requestId);
        expect({ name, ...outcome(response) }).toEqual({ name, ...SUCCEEDED });
        expect(response.result).toEqual({ action: "delete-remote-branch", push: { status: "deleted", oldObjectId: expectOid, newObjectId: null, reasonText: null, lease: true, upstreamWritten: false, upstreamNotSet: false, outputTail: expect.any(String) } });
        expect(remoteCalls(service, from).map((c) => [c.arguments, c.environmentPolicy, c.limits])).toEqual([[DELETE_ARGS("origin", dst, expectOid), "remote", NETWORK_LIMITS]]);
        expect(phasesOf(service, requestId)).toContain("sync-push");
      });
      expect(gitDelete(b, dst, expectOid)).toBe(0);
      const after = stateOf(a);
      const oracle = stateOf(b);
      expect({ name, refs: after.refs, remote: after.remote, head: after.head }).toEqual({ name, refs: oracle.refs, remote: oracle.remote, head: oracle.head });
      expect({ name, config: after.config }).toEqual({ name, config: before.config });
      const upstream = (key: string) => gitOut(a.h, a.repo, ["config", "--get", `branch.keep.${key}`]);
      expect({ name, remote: upstream("remote"), merge: upstream("merge") }).toEqual({ name, remote: "origin\n", merge: `${dst}\n` });
      expect(after.refs[ref]).toBeUndefined();
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "D4 read 10: a branch with 150 commits that only it holds gives count 150 and the first 100 commits with subjects", SHELL, async () => {
    const a = own();
    await withSync("t009-long", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf("refs/remotes/origin/long"));
      const lease = review.plan.lease!;
      expect({ count: lease.count, listed: lease.commits.length }).toEqual({ count: LONG_COMMITS, listed: 100 });
      expect(lease.commits[0]).toEqual({ objectId: revParse(a.h, a.repo, "refs/remotes/origin/long"), subject: `long ${LONG_COMMITS - 1}` });
      expect(lease.commits.map((c) => c.subject)).toEqual(Array.from({ length: 100 }, (_, i) => `long ${LONG_COMMITS - 1 - i}`));
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual(SUCCEEDED);
      expect(stateOf(a).remote["refs/heads/long"]).toBeUndefined();
    });
  }, TIMEOUT_MS);

  // Research.md R2 P8 and P11: the lease keeps every remote commit of a moved branch.
  caseTest(TASK, "SC-002: the remote moved after the fetch, so the lease refuses with stale-lease; every remote commit stays, as with Git's own lease delete", SHELL, async () => {
    const a = own();
    const b = own();
    const expectOid = revParse(a.h, a.repo, FEATURE);
    const moved = moveRemote(a, "feature");
    expect(moveRemote(b, "feature")).toBe(moved);
    const before = stateOf(a);
    await withSync("t009-moved", async (service) => {
      const r = await register(service, a.repo);
      const response = await sync(service, r, (await reviewed(service, r, payloadOf(FEATURE))).syncReviewToken);
      expect(outcome(response)).toEqual({ state: "failed", code: "PUSH_REJECTED" });
      expect({ status: response.result!.push!.status, reason: response.result!.reason, remoteGone: (response.result as { remoteGone?: true }).remoteGone }).toEqual({ status: "rejected", reason: "stale-lease", remoteGone: undefined });
      expect(response.result!.remedy).toEqual({ text: pruneText("origin"), command: expect.stringContaining(" fetch --prune -- 'origin'") });
    });
    expect(gitDelete(b, "refs/heads/feature", expectOid)).toBe(1);
    expect(stateOf(a)).toEqual(before);
    expect(stateOf(a).remote["refs/heads/feature"]).toBe(moved);
    expect(stateOf(b).remote).toEqual(stateOf(a).remote);
  }, TIMEOUT_MS);

  caseTest(TASK, "P9 and P16: an absent remote branch with a pushurl in other bytes than the URL gives stale-lease, runs no gone check, and changes nothing", SHELL, async () => {
    const a = own();
    gitRun(a.h, a.origin, ["update-ref", "-d", "refs/heads/feature"]);
    gitRun(a.h, a.repo, ["config", "remote.origin.pushurl", fileUrl(a.origin)]);
    const before = stateOf(a);
    await withSync("t009-absent-pushurl", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE));
      expect(review.plan.destination!.url).toBe(fileUrl(a.origin));
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect(outcome(response)).toEqual({ state: "failed", code: "PUSH_REJECTED" });
      expect(response.result!.reason).toBe("stale-lease");
      expect(callsFrom(service, from).filter(isLsRemote)).toEqual([]);
    });
    expect(stateOf(a)).toEqual(before);
  }, TIMEOUT_MS);

  caseTest(TASK, "P3 to P6: receive.denyDeletes, the HEAD branch of a bare remote behind a stale origin/HEAD, a checked-out branch of a non-bare remote, and a pre-receive hook give PUSH_REJECTED remote-rejected; nothing changes", SHELL, async () => {
    const cases: [string, (c: Copy) => string][] = [
      ["receive.denyDeletes", (c) => (gitRun(c.h, c.origin, ["config", "receive.denyDeletes", "true"]), FEATURE)],
      ["remote HEAD branch", (c) => (gitRun(c.h, c.origin, ["symbolic-ref", "HEAD", "refs/heads/feature"]), FEATURE)],
      [
        "non-bare remote",
        (c) => {
          const nb = `${c.repo}-nb`;
          gitRun(c.h, c.h.root, ["clone", "-q", "-b", "feature", "--", c.origin, nb]);
          gitRun(c.h, nb, ["branch", "-q", "main", "origin/main"]);
          gitRun(c.h, c.repo, ["remote", "add", "nb", nb]);
          gitRun(c.h, c.repo, ["fetch", "-q", "nb"]);
          // The local symref names another branch, so the review passes and the remote decides.
          gitRun(c.h, c.repo, ["remote", "set-head", "nb", "main"]);
          return "refs/remotes/nb/feature";
        },
      ],
      ["pre-receive hook", (c) => (c.h.write(`${c.origin}/hooks/pre-receive`, "#!/bin/sh\nexit 1\n"), FEATURE)],
    ];
    await withSync("t009-remote-rejected", async (service) => {
      for (const [name, setup] of cases) {
        const a = own();
        const ref = setup(a);
        const before = stateOf(a);
        const r = await register(service, a.repo);
        const response = await sync(service, r, (await reviewed(service, r, payloadOf(ref))).syncReviewToken);
        expect({ name, ...outcome(response), status: response.result?.push?.status, reason: response.result?.reason }).toEqual({ name, state: "failed", code: "PUSH_REJECTED", status: "remote-rejected", reason: "remote-rejected" });
        expect({ name, state: stateOf(a) }).toEqual({ name, state: before });
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "P7: a local pre-push hook that declines after approval gives GIT_FAILED with status none; nothing changes", SHELL, async () => {
    const a = own();
    a.h.write(`${a.repo}/.git/hooks/pre-push`, "#!/bin/sh\nexit 1\n");
    const before = stateOf(a);
    await withSync("t009-pre-push", async (service) => {
      const r = await register(service, a.repo);
      expect(refusalOf(await reviewSync(service, r, payloadOf(FEATURE))).code).toBe("TRUST_REQUIRED");
      await approve(service, r.repositoryId);
      const response = await sync(service, r, (await reviewed(service, r, payloadOf(FEATURE))).syncReviewToken);
      expect({ ...outcome(response), status: response.result!.push!.status }).toEqual({ state: "failed", code: "GIT_FAILED", status: "none" });
      expect(response.result!.remedy!.text).toBe(STEP_REMEDY);
    });
    expect(stateOf(a)).toEqual(before);
  }, TIMEOUT_MS);

  // Spec FR-008: the loopback HTTP remote asks for credentials, and the only helper fails.
  caseTest(TASK, "FR-008: a credential helper that exits non-zero gives GIT_FAILED with status none and the terminal remedy; the remote branch stays", SHELL, async () => {
    const h = hostFor("t009-credential-fails");
    const project = `${h.root}/http`;
    mkdirSync(native(project), { recursive: true });
    const bare = buildCredentialRemote(h, project);
    importStream(h, bare, [fc({ mark: 2, ref: "refs/heads/feature", message: "feature\n", files: { "f.txt": "f\n" } })]);
    const clone = `${h.root}/clone`;
    gitRun(h, h.root, ["clone", "-q", "--", bare, clone]);
    const tip = revParse(h, bare, "refs/heads/feature");
    const global = helperGlobal(h, HTTP_USER, HTTP_PASSWORD);
    // helperGlobal names this script. The replacement gives no credential and exits 1.
    h.write(`${h.root}/credential-helper.sh`, "#!/bin/sh\nexit 1\n");
    const server = startHttpRemote({ git: fixtureGitPath(gitExe()), projectRoot: project, user: HTTP_USER, password: HTTP_PASSWORD, env: nativeEnv() });
    try {
      gitRun(h, clone, ["remote", "set-url", "origin", `${server.url}/cred.git`]);
      await withSync("t009-credential-fails", async (service) => {
        const r = await register(service, clone);
        const response = await sync(service, r, (await reviewed(service, r, payloadOf(FEATURE))).syncReviewToken);
        expect({ ...outcome(response), status: response.result!.push!.status }).toEqual({ state: "failed", code: "GIT_FAILED", status: "none" });
        expect(response.result!.remedy!.text).toBe(STEP_REMEDY);
      }, { environment: nativeEnv({ GIT_CONFIG_GLOBAL: global }) });
    } finally {
      await server.stop();
    }
    expect(revParse(h, bare, "refs/heads/feature")).toBe(tip);
  }, TIMEOUT_MS);

  // Research.md R2 P13 and spec FR-004: only the local symref names the default branch, so these refusals start no network process.
  // Contract Δ3 `SyncRefused`: both reasons name the remote, so the renderer needs no split of the tracking name (plan.md D13 X13, X14).
  caseTest(TASK, "SC-003: the default branch gives default-branch; an absent, a non-symbolic, and a followRemoteHEAD=never origin/HEAD give default-unknown; no network process starts", SHELL, async () => {
    const cases: [string, (c: Copy) => void, string, string][] = [
      ["default branch", () => {}, "refs/remotes/origin/main", "default-branch"],
      ["absent origin/HEAD", (c) => gitRun(c.h, c.repo, ["remote", "set-head", "origin", "-d"]), FEATURE, "default-unknown"],
      [
        "non-symbolic origin/HEAD",
        (c) => {
          gitRun(c.h, c.repo, ["remote", "set-head", "origin", "-d"]);
          gitRun(c.h, c.repo, ["update-ref", "--no-deref", "refs/remotes/origin/HEAD", revParse(c.h, c.repo, "refs/remotes/origin/main")]);
        },
        FEATURE,
        "default-unknown",
      ],
      [
        "followRemoteHEAD=never",
        (c) => {
          gitRun(c.h, c.repo, ["config", "remote.origin.followRemoteHEAD", "never"]);
          gitRun(c.h, c.repo, ["remote", "set-head", "origin", "-d"]);
          gitRun(c.h, c.repo, ["fetch", "-q", "origin"]);
        },
        FEATURE,
        "default-unknown",
      ],
    ];
    await withSync("t009-default", async (service) => {
      for (const [name, setup, ref, reason] of cases) {
        const a = own();
        setup(a);
        const before = stateOf(a);
        const r = await register(service, a.repo);
        const from = service.runner.calls.length;
        expect({ name, ...refusalOf(await reviewSync(service, r, payloadOf(ref))) }).toEqual({ name, state: "failed", code: "SYNC_UNAVAILABLE", result: { reason, remote: "origin" } });
        expect({ name, calls: remoteCalls(service, from) }).toEqual({ name, calls: [] });
        expect({ name, state: stateOf(a) }).toEqual({ name, state: before });
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "D4 read 3: two remotes that map the ref, a refspec to refs/tags/, and a forward mapping that names another ref give no-remote-branch before any network process", SHELL, async () => {
    const cases: [string, (c: Copy) => string][] = [
      [
        "two remotes",
        (c) => {
          gitRun(c.h, c.repo, ["remote", "add", "other", c.origin]);
          gitRun(c.h, c.repo, ["config", "--replace-all", "remote.other.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
          return FEATURE;
        },
      ],
      [
        "refs/tags refspec",
        (c) => {
          gitRun(c.h, c.repo, ["remote", "add", "tagger", c.origin]);
          gitRun(c.h, c.repo, ["config", "--replace-all", "remote.tagger.fetch", "+refs/tags/*:refs/remotes/tagger/*"]);
          gitRun(c.h, c.repo, ["update-ref", "refs/remotes/tagger/v1", revParse(c.h, c.repo, "HEAD")]);
          return "refs/remotes/tagger/v1";
        },
      ],
      [
        "forward mapping to another ref",
        (c) => {
          gitRun(c.h, c.repo, ["config", "--unset-all", "remote.origin.fetch"]);
          gitRun(c.h, c.repo, ["config", "--add", "remote.origin.fetch", "+refs/heads/feature:refs/remotes/origin/other"]);
          gitRun(c.h, c.repo, ["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
          return FEATURE;
        },
      ],
    ];
    await withSync("t009-no-remote-branch", async (service) => {
      for (const [name, setup] of cases) {
        const a = own();
        const ref = setup(a);
        const r = await register(service, a.repo);
        const from = service.runner.calls.length;
        expect({ name, ...refusalOf(await reviewSync(service, r, payloadOf(ref))) }).toEqual({ name, state: "failed", code: "SYNC_UNAVAILABLE", result: { reason: "no-remote-branch" } });
        expect({ name, calls: remoteCalls(service, from) }).toEqual({ name, calls: [] });
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "two push URLs, a mirror remote, an operation in progress, an absent ref, a ref name that fails isRefName, and trust required refuse before any network process; no hook runs", SHELL, async () => {
    const log = (c: Copy) => `${c.h.root}/${c.repo.split("/").at(-1)}-hook.log`;
    const cases: [string, (c: Copy) => string, { code: string; result?: unknown }][] = [
      ["push-urls", (c) => (gitRun(c.h, c.repo, ["config", "--add", "remote.origin.pushurl", c.origin]), gitRun(c.h, c.repo, ["config", "--add", "remote.origin.pushurl", fileUrl(c.origin)]), FEATURE), { code: "SYNC_UNAVAILABLE", result: { reason: "push-urls" } }],
      ["mirror", (c) => (gitRun(c.h, c.repo, ["config", "remote.origin.mirror", "true"]), FEATURE), { code: "SYNC_UNAVAILABLE", result: { reason: "mirror" } }],
      [
        "merging",
        (c) => {
          gitRun(c.h, c.repo, ["merge", "-q", "--no-ff", "--no-commit", "refs/remotes/origin/feature"]);
          return "refs/remotes/origin/a/b";
        },
        { code: "OPERATION_IN_PROGRESS" },
      ],
      ["absent ref", () => "refs/remotes/origin/nothing", { code: "UNKNOWN_TARGET" }],
      ["trust required", (c) => (c.h.write(`${c.repo}/.git/hooks/pre-push`, `#!/bin/sh\necho ran >> '${log(c)}'\nexit 0\n`), FEATURE), { code: "TRUST_REQUIRED" }],
    ];
    await withSync("t009-refusals", async (service) => {
      for (const [name, setup, expected] of cases) {
        const a = own();
        const ref = setup(a);
        const r = await register(service, a.repo);
        const from = service.runner.calls.length;
        const response = refusalOf(await reviewSync(service, r, payloadOf(ref)));
        expect({ name, code: response.code, result: response.result }).toEqual({ name, code: expected.code, result: expected.result });
        expect({ name, calls: remoteCalls(service, from) }).toEqual({ name, calls: [] });
        expect({ name, hook: existsSync(native(log(a))) }).toEqual({ name, hook: false });
      }
      // D4 read 0: the payload rule comes before any Git process.
      const a = own();
      const r = await register(service, a.repo);
      const from = service.runner.calls.length;
      expect((await reviewSync(service, r, payloadOf("refs/remotes/origin/a..b"))).code).toBe("INVALID_REQUEST");
      expect((await reviewSync(service, r, payloadOf(FEATURE, "refs/heads/a..b"))).code).toBe("INVALID_REQUEST");
      // session.ts `reviewSync` rechecks the repository with `rev-parse` after a failed review. No review read runs.
      expect(callsFrom(service, from).map((c) => subcommandOf(c.arguments)).filter((s) => s !== "rev-parse")).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "Δ8: the token expires after 60 s through the approval clock, and an external fetch after the review gives STALE_REVIEW; no push starts", SHELL, async () => {
    let clock = 0;
    const a = own();
    const b = own();
    await withSync("t009-expiry", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE));
      clock += 60_001;
      let from = service.runner.calls.length;
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED" });
      expect(callsFrom(service, from).filter(isPush)).toEqual([]);

      const s = await register(service, b.repo);
      const stale = await reviewed(service, s, payloadOf(FEATURE));
      moveRemote(b, "feature");
      gitRun(b.h, b.repo, ["fetch", "-q", "origin"]);
      from = service.runner.calls.length;
      expect(outcome(await sync(service, s, stale.syncReviewToken))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(callsFrom(service, from).filter(isPush)).toEqual([]);
    }, { approvalClock: () => clock });
  }, TIMEOUT_MS);

  caseTest(TASK, "Δ8: Cancel during a slow pre-receive hook gives canceled with the remedy text; the remote branch and the tracking ref stay", SHELL, async () => {
    const a = own();
    const started = `${a.h.root}/${a.repo.split("/").at(-1)}-receive.started`;
    a.h.write(`${a.origin}/hooks/pre-receive`, `#!/bin/sh\n: > '${started}'\nsleep 15\nexit 1\n`);
    const before = stateOf(a);
    await withSync("t009-cancel", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE));
      const requestId = sendSync(service, r, review.syncReviewToken);
      await until(() => existsSync(native(started)), "the pre-receive hook start", 30_000);
      await service.cancel(await service.operationId(requestId));
      const response = await service.response<SyncResult>(requestId);
      expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
      expect(response.result!.remedy).toEqual({ text: CANCELED_PUSH_TEXT, command: null });
    });
    expect(stateOf(a)).toEqual(before);
  }, TIMEOUT_MS);

  describe("Windows", () => {
    caseTest(TASK, "R10: the run sends the pageant frame for the remote before the push starts", WINDOWS, async () => {
      const a = own();
      await withSync("t009-pageant", async (service) => {
        const r = await register(service, a.repo);
        const review = await reviewed(service, r, payloadOf(FEATURE));
        const release = service.runner.holdStart(isPush);
        try {
          const requestId = sendSync(service, r, review.syncReviewToken);
          await until(() => service.runner.calls.some(isPush), "the push start");
          expect(service.runner.frames.filter((f) => f.type === "pageant").map((f) => f.remote)).toEqual(["origin"]);
          release();
          expect(outcome(await service.response<SyncResult>(requestId))).toEqual(SUCCEEDED);
        } finally {
          release();
        }
      });
    }, TIMEOUT_MS);
  });
});
