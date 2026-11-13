// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T035: the rejected-push flow and `force-push` (contract Δ3, plan.md D5, FR-023 to FR-025, SC-002, SC-010).
// The lease oracle is `rev-list` of the fixture. A lost remote commit shows in the remote refs and objects.

import { expect } from "bun:test";
import { HISTORY_COMMIT_OBJECT_BYTES, SYNC_LEASE_COMMITS } from "../../src/contracts/limits";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { fileUrl } from "./remote-delete-harness";
import { buildPush, fc, gitOut, gitRun, importStream, refMap, revParse, type GitHost, type PushFixture } from "./remote-fixtures";
import { caseTest, type Service } from "./service-harness";
import { ANY_EXIT, copyWithRemotes, hostFor, INTEGRATE_ENV, pullFlags, refreshIndex, register, remoteCalls, repoShape, reviewed, reviewSync, run, subcommandOf, sync, TIMEOUT_MS, withSync, refusalOf } from "./sync-harness";

useFixtureRoot();

const TASK = "T035";
const SHELL = ["shell-double"] as const;
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const SUCCEEDED = { state: "succeeded", code: undefined };
// The remote branch gets this many commits that the local branch lacks.
const REMOTE_COMMITS = SYNC_LEASE_COMMITS + 5;

// Every object that the remote can reach from a ref. A force push that loses a commit drops it from this set.
const reachable = (h: GitHost, repo: string) => gitOut(h, repo, ["rev-list", "--all", "--objects"]).split("\n").filter((l) => l !== "").sort();
// T092: the `ls-remote` re-reads after call `from`. T093: the review read `ls-remote --get-url` has no remote policy.
const lsRemoteRereads = (service: Service, from: number) => remoteCalls(service, from).filter((c) => subcommandOf(c.arguments) === "ls-remote");
const lsRemoteExits = (service: Service, from: number) => lsRemoteRereads(service, from).map((c) => c.exit?.exitCode);

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
      expect({ ...outcome(rejected), reason: rejected.result!.reason }).toEqual({ state: "failed", code: "PUSH_REJECTED", reason: "rejected" });
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

  caseTest(TASK, "contract Δ3 read 6: a lease commit object above HISTORY_COMMIT_OBJECT_BYTES gives subject null, and sync takes the review", SHELL, async () => {
    const a = diverged(false);
    const tip = revParse(a.h, a.remotes.origin!, "refs/heads/topic");
    importStream(a.h, a.remotes.origin!, [Buffer.from(`reset refs/heads/topic\nfrom ${tip}\n\n`), fc({ mark: 1, ref: "refs/heads/topic", message: `large\n\n${"x".repeat(HISTORY_COMMIT_OBJECT_BYTES)}\n`, files: { "large.txt": "large\n" } })]);
    gitRun(a.h, a.repo, ["fetch", "-q", "origin"]);
    const tracking = revParse(a.h, a.repo, "refs/remotes/origin/topic");
    expect(Number(gitOut(a.h, a.repo, ["cat-file", "-s", tracking]).trim())).toBeGreaterThan(HISTORY_COMMIT_OBJECT_BYTES);
    await withSync("t035-large-subject", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, { action: "force-push" });
      const commits = review.plan.lease!.commits;
      expect({ count: review.plan.lease!.count, first: commits[0], second: commits[1] }).toEqual({ count: REMOTE_COMMITS + 1, first: { objectId: tracking, subject: null }, second: { objectId: tip, subject: `remote ${REMOTE_COMMITS}` } });
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual(SUCCEEDED);
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
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect({ ...outcome(response), reason: response.result!.reason }).toEqual({ state: "failed", code: "PUSH_REJECTED", reason: "stale-lease" });
      expect(response.result!.push).toMatchObject({ status: "rejected", lease: true });
      // T092, contract Δ9: the stale claim comes from the remote re-read.
      expect(lsRemoteExits(service, from)).toEqual([0]);
      expect(refMap(a.h, a.remotes.origin!)).toEqual(refsBefore);
      expect(reachable(a.h, a.remotes.origin!)).toEqual(objectsBefore);
    });
  }, TIMEOUT_MS);

  // T092, contract Δ9. Git sets the lease status before it runs the pre-push hook (transport.c `transport_push`), and it runs the hook also when
  // the lease refuses every ref (011 research.md R5 U8). So the hook can change the remote between Git's lease check and the re-read.
  // The remote moves after the fetch, so Git's lease check refuses. Then the pre-push hook runs `hook` with the remote path and the lease value.
  // `pushurl`: the push URL in other bytes than the fetch URL, so the review binds `sameUrl` false (011 remote-delete-gone.test.ts P16).
  // `setup` writes more configuration before the registration, so the trust approval covers it.
  const leaseHookCase = async (name: string, hook: (origin: string, expectOid: string) => string, { reason = "rejected", pushurl = false, setup = (_a: ReturnType<typeof diverged>) => {} } = {}) => {
    const a = diverged(true);
    const expectOid = revParse(a.h, a.repo, "refs/remotes/origin/topic");
    importStream(a.h, a.remotes.origin!, [Buffer.from(`reset refs/heads/topic\nfrom ${expectOid}\n\n`), fc({ mark: 1, ref: "refs/heads/topic", message: "after the fetch\n", files: { "late.txt": "late\n" } })]);
    a.h.write(`${a.repo}/.git/hooks/pre-push`, `#!/bin/sh\ncat > /dev/null\n${hook(a.remotes.origin!, expectOid)}\n`);
    if (pushurl) gitRun(a.h, a.repo, ["config", "remote.origin.pushurl", fileUrl(a.remotes.origin!)]);
    setup(a);
    let exits: (number | null | undefined)[] = [];
    let args: string[][] = [];
    await withSync(name, async (service) => {
      const r = await register(service, a.repo);
      expect((await service.readTrust(r.repositoryId)).result!.approvalRequired.sync).toBe(true);
      expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
      const review = await reviewed(service, r, { action: "force-push" });
      expect(review.plan.lease!.expect).toBe(expectOid);
      const from = service.runner.calls.length;
      const response = await sync(service, r, review.syncReviewToken);
      expect({ ...outcome(response), reason: response.result!.reason }).toEqual({ state: "failed", code: "PUSH_REJECTED", reason });
      expect(response.result!.push).toMatchObject({ status: "rejected", lease: true, reasonText: "stale info" });
      exits = lsRemoteExits(service, from);
      args = lsRemoteRereads(service, from).map((c) => [...c.arguments]);
    });
    return { a, exits, args, expectOid };
  };

  caseTest("T092", "contract Δ9: a [rejected] lease push whose remote re-read equals the lease value gives reason rejected with Git's reasonText", SHELL, async () => {
    const seen = await leaseHookCase("t092-equal", (origin, expectOid) => `git --git-dir='${origin}' update-ref refs/heads/topic ${expectOid}`);
    expect(seen.exits).toEqual([0]);
    expect(revParse(seen.a.h, seen.a.remotes.origin!, "refs/heads/topic")).toBe(seen.expectOid);
  }, TIMEOUT_MS);

  // git-ls-remote(1) runs `git-upload-pack` in the remote. setup.c `check_repository_format_gently` refuses a format version above 1.
  caseTest("T092", "contract Δ9: a [rejected] lease push whose remote re-read fails gives reason rejected and no stale claim", SHELL, async () => {
    const seen = await leaseHookCase("t092-read-fails", (origin) => `git --git-dir='${origin}' config core.repositoryformatversion 99`);
    expect(seen.exits).toHaveLength(1);
    expect([0, 2]).not.toContain(seen.exits[0]);
  }, TIMEOUT_MS);

  caseTest("T092", "contract Δ9: a [rejected] lease push whose remote branch is gone at the re-read (ls-remote exit 2) gives reason stale-lease", SHELL, async () => {
    const seen = await leaseHookCase("t092-gone", (origin) => `git --git-dir='${origin}' update-ref -d refs/heads/topic`, { reason: "stale-lease" });
    expect(seen.exits).toEqual([2]);
  }, TIMEOUT_MS);

  // T093, plan.md D5: with `sameUrl` false the re-read names the bound push URL. The `file://` push URL names the moved remote.
  caseTest("T093", "contract Δ9: with a pushurl in other bytes than the URL, a [rejected] lease push re-reads the push URL, and the moved remote gives reason stale-lease", SHELL, async () => {
    const seen = await leaseHookCase("t093-pushurl-moved", () => "exit 0", { pushurl: true, reason: "stale-lease" });
    expect(seen.exits).toEqual([0]);
    expect(seen.args).toEqual([["--no-lazy-fetch", "ls-remote", "--exit-code", "--", fileUrl(seen.a.remotes.origin!), "refs/heads/topic"]]);
  }, TIMEOUT_MS);

  caseTest("T093", "contract Δ9: with a pushurl in other bytes than the URL, a failed re-read of the push URL gives reason rejected and no stale claim", SHELL, async () => {
    const seen = await leaseHookCase("t093-pushurl-fails", (origin) => `git --git-dir='${origin}' config core.repositoryformatversion 99`, { pushurl: true });
    expect(seen.args.map((a) => a[4])).toEqual([fileUrl(seen.a.remotes.origin!)]);
    expect([0, 2]).not.toContain(seen.exits[0]);
  }, TIMEOUT_MS);

  // remote.c `alias_all_urls`: `pushInsteadOf` makes the push URL from `url`, and `insteadOf` does not rewrite that push URL.
  // `ls-remote <push URL>` applies `insteadOf` to it, so it would read the `second` remote. Its `topic` is not the lease value.
  caseTest("T093", "plan.md D5: when ls-remote --get-url rewrites the push URL to another remote, a [rejected] lease push runs no re-read and gives reason rejected", SHELL, async () => {
    const seen = await leaseHookCase("t093-insteadof", () => "exit 0", {
      setup: (a) => {
        const url = gitOut(a.h, a.repo, ["config", "remote.origin.url"]).trim();
        gitRun(a.h, a.repo, ["config", `url.${fileUrl(a.remotes.origin!)}.pushInsteadOf`, url]);
        gitRun(a.h, a.repo, ["config", `url.${fileUrl(a.remotes.second!)}.insteadOf`, fileUrl(a.remotes.origin!)]);
        expect(gitOut(a.h, a.repo, ["remote", "get-url", "--push", "origin"]).trim()).toBe(fileUrl(a.remotes.origin!));
        expect(gitOut(a.h, a.repo, ["ls-remote", "--get-url", "--", fileUrl(a.remotes.origin!)]).trim()).toBe(fileUrl(a.remotes.second!));
      },
    });
    expect(seen.args).toEqual([]);
  }, TIMEOUT_MS);

  // A `remote.origin.vcs` push runs a remote helper and never gives a `[rejected]` line here. So only the review read is checked.
  // remote.c `remotes_remote_get_1`: a remote named as the push URL gives `ls-remote <url>` its settings.
  caseTest("T093", "plan.md D5: with a pushurl in other bytes than the URL, a remote.origin.vcs entry or a remote named as the push URL gives no ls-remote --get-url read in the force-push review", SHELL, async () => {
    const cases: [string, string, (a: ReturnType<typeof diverged>) => [string, string]][] = [
      ["vcs", "t093-review-vcs", () => ["remote.origin.vcs", "arbareto-none"]],
      ["remote named as the push URL", "t093-review-named", (a) => [`remote.${fileUrl(a.remotes.origin!)}.uploadpack`, "git-upload-pack"]],
    ];
    for (const [name, tag, entry] of cases) {
      const a = diverged(true);
      gitRun(a.h, a.repo, ["config", "remote.origin.pushurl", fileUrl(a.remotes.origin!)]);
      gitRun(a.h, a.repo, ["config", ...entry(a)]);
      await withSync(tag, async (service) => {
        const r = await register(service, a.repo);
        expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
        const from = service.runner.calls.length;
        await reviewed(service, r, { action: "force-push" });
        const getUrl = service.runner.calls.slice(from).filter((c) => c.arguments.includes("--get-url"));
        expect({ name, getUrl: getUrl.length }).toEqual({ name, getUrl: 0 });
      });
    }
  }, TIMEOUT_MS);

  // User decision 2026-11-11 (contract "Contract gaps"): an scp form has no password field, so its user name may go into process arguments.
  // The test sends no token: a push to the `.invalid` host would start ssh. So only the review read is checked.
  caseTest("T093", "contract gaps: with an scp pushurl user@host:path, the force-push review runs ls-remote --get-url on the push URL", SHELL, async () => {
    const a = diverged(true);
    const scp = "git@arbareto.invalid:org/repo.git";
    gitRun(a.h, a.repo, ["config", "remote.origin.pushurl", scp]);
    expect(gitOut(a.h, a.repo, ["ls-remote", "--get-url", "--", scp]).trim()).toBe(scp);
    await withSync("t093-review-scp", async (service) => {
      const r = await register(service, a.repo);
      const from = service.runner.calls.length;
      await reviewed(service, r, { action: "force-push" });
      const getUrl = service.runner.calls.slice(from).filter((c) => c.arguments.includes("--get-url"));
      expect(getUrl.map((c) => c.arguments.at(-1))).toEqual([scp]);
    });
  }, TIMEOUT_MS);

  // T046 (FR-026, SC-002): the pull choices of the notice.
  caseTest("T046", "FR-026: after a rejected push, pull with mode rebase and with mode merge each equal Git's own pull --rebase and pull --no-rebase on a copy, and a push then succeeds", SHELL, async () => {
    for (const mode of ["rebase", "merge"] as const) {
      const a = diverged(false);
      refreshIndex(a.h, a.repo);
      const oracle = `${a.h.root}/oracle-${mode}-${copies}`;
      a.h.copy(a.repo, oracle);
      refreshIndex(a.h, oracle);
      await withSync(`t046-${mode}`, async (service) => {
        const r = await register(service, a.repo);
        expect({ mode, ...outcome(await run(service, r, { action: "push" })) }).toEqual({ mode, state: "failed", code: "PUSH_REJECTED" });
        const pulled = await run(service, r, { action: "pull", mode });
        expect({ mode, ...outcome(pulled), integration: pulled.result!.integration, modeSource: pulled.result!.modeSource }).toEqual({ mode, ...SUCCEEDED, integration: { state: "done" }, modeSource: "payload" });
        gitRun(a.h, oracle, ["pull", ...pullFlags(mode)], { allowExit: ANY_EXIT, env: INTEGRATE_ENV });
        expect({ mode, shape: repoShape(a.h, a.repo) }).toEqual({ mode, shape: repoShape(a.h, oracle) });
        const pushed = await run(service, r, { action: "push" });
        expect({ mode, ...outcome(pushed), status: pushed.result!.push!.status }).toEqual({ mode, ...SUCCEEDED, status: "pushed" });
        expect(refMap(a.h, a.remotes.origin!, ["refs/heads/topic"])).toEqual({ "refs/heads/topic": revParse(a.h, a.repo, "HEAD") });
      });
    }
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
