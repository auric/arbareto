// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 011 T010: the combined delete of a remote branch and its local branch (plan.md D4 read 7, D6 step 7, D7 and D16, data-model §5, SC-004, SC-006).
// The oracle is Git's own lease delete, `update-ref -d`, and `config --remove-section` on copies.

import { expect } from "bun:test";
import { renameSync, rmSync } from "node:fs";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { buildBase, copyOf, DELETE_ARGS, fileUrl, gitDelete, isUpdateRef, logHook, outcome, payloadOf, phaseAt, phasesOf, stateOf, STEP_REMEDY, SUCCEEDED, type Base, type Copy } from "./remote-delete-harness";
import { gitOut, gitRun, revParse } from "./remote-fixtures";
import { caseTest, type Service } from "./service-harness";
import { callsFrom, native, refusalOf, register, remoteCalls, reviewed, reviewSync, sendSync, sync, TIMEOUT_MS, until, withSync, type SyncResult } from "./sync-harness";

useFixtureRoot();

const TASK = "T010";
const SHELL = ["shell-double"] as const;
const FEATURE = "refs/remotes/origin/feature";
const LOCAL = "refs/heads/feature";
const SECTION = ["--no-lazy-fetch", "config", "--local", "--remove-section", "branch.feature"];

let base: Base | null = null;
// A copy with the local branch `feature` that tracks `origin/feature` (git-branch(1) `--track`).
function own(): Copy {
  const c = copyOf((base ??= buildBase("t010-base")));
  gitRun(c.h, c.repo, ["branch", "-q", "--track", "feature", "origin/feature"]);
  return c;
}

type DeleteResult = SyncResult & { remoteGone?: true; localNotDeleted?: true };

async function approve(service: Service, repositoryId: string): Promise<void> {
  expect((await service.readTrust(repositoryId)).result!.approvalRequired.sync).toBe(true);
  expect((await service.approveTrust(repositoryId)).state).toBe("succeeded");
}

// Git's own steps of the combined delete on `c` (plan.md D16): the lease delete, then the local ref and the section.
function gitCombined(c: Copy, tip: string, expectOid: string, section: boolean): void {
  expect(gitDelete(c, "refs/heads/feature", expectOid)).toBe(0);
  gitRun(c.h, c.repo, ["update-ref", "--no-deref", "-d", LOCAL, tip]);
  if (section) gitRun(c.h, c.repo, ["config", "--local", "--remove-section", "branch.feature"]);
}

describeGit("combined remote and local branch delete (011 T010)", () => {
  caseTest(TASK, "SC-004: the combined delete removes the remote branch, the tracking ref, the local branch, and its section, as Git's own steps do; one sync-delete-local event comes before the first local write", SHELL, async () => {
    const a = own();
    const b = own();
    const tip = revParse(a.h, a.repo, LOCAL);
    const expectOid = revParse(a.h, a.repo, FEATURE);
    // A copy that keeps the remote URL of `a`, so its configuration bytes can equal those of `a`.
    const bytes = `${a.repo}-bytes`;
    a.h.copy(a.repo, bytes);
    await withSync("t010-success", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE, LOCAL));
      expect((review.plan as { local?: unknown }).local).toEqual({ ref: LOCAL, oid: tip, reflogKeeps: false });
      expect(review.plan.lease).toMatchObject({ trackingRef: FEATURE, expect: expectOid, count: 1 });
      const from = service.runner.calls.length;
      const requestId = sendSync(service, r, review.syncReviewToken);
      const response = await service.response<DeleteResult>(requestId);
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(response.result).toEqual({ action: "delete-remote-branch", push: { status: "deleted", oldObjectId: expectOid, newObjectId: null, reasonText: null, lease: true, upstreamWritten: false, upstreamNotSet: false, outputTail: expect.any(String) } });
      expect(remoteCalls(service, from).map((c) => c.arguments)).toEqual([DELETE_ARGS("origin", "refs/heads/feature", expectOid), ["--no-lazy-fetch", "update-ref", "--no-deref", "-d", LOCAL, tip], SECTION]);
      expect(phasesOf(service, requestId).filter((p) => p === "sync-delete-local")).toEqual(["sync-delete-local"]);
      const write = callsFrom(service, from).find(isUpdateRef)!;
      expect(phaseAt(service, requestId, "sync-delete-local")!).toBeLessThanOrEqual(write.at);
    });
    gitCombined(b, tip, expectOid, true);
    gitRun(a.h, bytes, ["update-ref", "--no-deref", "-d", LOCAL, tip]);
    gitRun(a.h, bytes, ["config", "--local", "--remove-section", "branch.feature"]);
    const after = stateOf(a);
    expect({ refs: after.refs, remote: after.remote, head: after.head }).toEqual((({ refs, remote, head }) => ({ refs, remote, head }))(stateOf(b)));
    expect(after.config).toEqual(a.h.read(`${bytes}/.git/config`)!);
    expect(after.config.includes('[branch "feature"]')).toBe(false);
  }, TIMEOUT_MS);

  caseTest(TASK, "D6 step 7: a branch without a branch.<name> section in the local file runs only update-ref; the local configuration bytes stay equal", SHELL, async () => {
    const c = copyOf((base ??= buildBase("t010-base")));
    gitRun(c.h, c.repo, ["branch", "-q", "--no-track", "feature", "origin/feature"]);
    // git-config(1) `extensions.worktreeConfig`: the upstream keys live in `config.worktree`, so the local file holds no `branch.feature` key.
    gitRun(c.h, c.repo, ["config", "extensions.worktreeConfig", "true"]);
    gitRun(c.h, c.repo, ["config", "--worktree", "branch.feature.remote", "origin"]);
    gitRun(c.h, c.repo, ["config", "--worktree", "branch.feature.merge", "refs/heads/feature"]);
    const tip = revParse(c.h, c.repo, LOCAL);
    const before = stateOf(c);
    await withSync("t010-no-section", async (service) => {
      const r = await register(service, c.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE, LOCAL));
      const from = service.runner.calls.length;
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual(SUCCEEDED);
      expect(remoteCalls(service, from).slice(1).map((x) => x.arguments)).toEqual([["--no-lazy-fetch", "update-ref", "--no-deref", "-d", LOCAL, tip]]);
    });
    const after = stateOf(c);
    expect({ local: after.refs[LOCAL], tracking: after.refs[FEATURE], config: after.config }).toEqual({ local: undefined, tracking: undefined, config: before.config });
  }, TIMEOUT_MS);

  caseTest(TASK, "D4 read 7: not-upstream after an external branch --set-upstream-to, current-branch, other-worktree, and config-in-include refuse before any network process; nothing changes", SHELL, async () => {
    const cases: [string, (c: Copy) => void, { code: string; result: Record<string, unknown> }][] = [
      ["not-upstream", (c) => gitRun(c.h, c.repo, ["branch", "-q", "--set-upstream-to=origin/keep", "feature"]), { code: "SYNC_UNAVAILABLE", result: { reason: "not-upstream" } }],
      ["current-branch", (c) => gitRun(c.h, c.repo, ["checkout", "-q", "feature"]), { code: "WORKBENCH_UNAVAILABLE", result: { reason: "current-branch" } }],
      ["other-worktree", (c) => gitRun(c.h, c.repo, ["worktree", "add", "-q", "--", `${c.repo}-wt`, "feature"]), { code: "WORKBENCH_UNAVAILABLE", result: { reason: "other-worktree", worktree: "" } }],
      [
        "config-in-include",
        (c) => {
          c.h.write(`${c.repo}/.git/inc.cfg`, '[branch "feature"]\n\tdescription = included\n');
          gitRun(c.h, c.repo, ["config", "--local", "include.path", "inc.cfg"]);
        },
        { code: "WORKBENCH_UNAVAILABLE", result: { reason: "config-in-include" } },
      ],
    ];
    await withSync("t010-refusals", async (service) => {
      for (const [name, setup, expected] of cases) {
        const a = own();
        setup(a);
        const before = stateOf(a);
        const r = await register(service, a.repo);
        const from = service.runner.calls.length;
        const refused = refusalOf(await reviewSync(service, r, payloadOf(FEATURE, LOCAL)));
        const result = refused.result as Record<string, unknown> | undefined;
        // The worktree path is the Git-reported path of the other worktree.
        const shown = name === "other-worktree" && typeof result?.worktree === "string" ? { ...result, worktree: "" } : result;
        expect({ name, code: refused.code, result: shown }).toEqual({ name, code: expected.code, result: expected.result });
        if (name === "other-worktree") expect(native(String(result!.worktree)).toLowerCase()).toBe(native(`${a.repo}-wt`).toLowerCase());
        expect({ name, calls: remoteCalls(service, from) }).toEqual({ name, calls: [] });
        expect({ name, state: stateOf(a) }).toEqual({ name, state: before });
      }
    });
  }, TIMEOUT_MS);

  // Plan.md D4: the reads start together, but the first failing check in the read order decides. Each pair also refuses alone with each reason.
  // The read 8 push URL read ends before the local section read starts, so config-in-include fails later in time than push-urls.
  caseTest(TASK, "D4 order: read 6 default-branch wins over a local branch that another worktree holds, and config-in-include wins over the earlier-read push-urls", SHELL, async () => {
    const otherWorktree = { code: "WORKBENCH_UNAVAILABLE", result: { reason: "other-worktree", worktree: "" } };
    const cases: [string, (c: Copy) => void, [string, string | undefined, { code: string; result: Record<string, unknown> }][]][] = [
      [
        "default-branch and other-worktree",
        (c) => {
          gitRun(c.h, c.repo, ["branch", "-q", "--track", "side", "origin/main"]);
          gitRun(c.h, c.repo, ["worktree", "add", "-q", "--", `${c.repo}-wt`, "side"]);
        },
        [
          ["refs/remotes/origin/main", "refs/heads/side", { code: "SYNC_UNAVAILABLE", result: { reason: "default-branch", remote: "origin" } }],
          [FEATURE, "refs/heads/side", otherWorktree],
        ],
      ],
      [
        "config-in-include and push-urls",
        (c) => {
          c.h.write(`${c.repo}/.git/inc.cfg`, '[branch "feature"]\n\tdescription = included\n');
          gitRun(c.h, c.repo, ["config", "--local", "include.path", "inc.cfg"]);
          gitRun(c.h, c.repo, ["config", "--add", "remote.origin.pushurl", c.origin]);
          gitRun(c.h, c.repo, ["config", "--add", "remote.origin.pushurl", fileUrl(c.origin)]);
        },
        [
          [FEATURE, LOCAL, { code: "WORKBENCH_UNAVAILABLE", result: { reason: "config-in-include" } }],
          [FEATURE, undefined, { code: "SYNC_UNAVAILABLE", result: { reason: "push-urls" } }],
        ],
      ],
    ];
    await withSync("t010-order", async (service) => {
      for (const [name, setup, reviews] of cases) {
        const a = own();
        setup(a);
        const before = stateOf(a);
        const r = await register(service, a.repo);
        for (const [ref, local, expected] of reviews) {
          const from = service.runner.calls.length;
          const refused = refusalOf(await reviewSync(service, r, payloadOf(ref, local)));
          const result = refused.result as Record<string, unknown> | undefined;
          const shown = result?.reason === "other-worktree" ? { ...result, worktree: "" } : result;
          expect({ name, ref, local, code: refused.code, result: shown }).toEqual({ name, ref, local, code: expected.code, result: expected.result });
          expect({ name, ref, local, calls: remoteCalls(service, from) }).toEqual({ name, ref, local, calls: [] });
        }
        expect({ name, state: stateOf(a) }).toEqual({ name, state: before });
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "data-model §2: an external commit on the local branch after the review gives STALE_REVIEW; no push starts", SHELL, async () => {
    const a = own();
    await withSync("t010-stale", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE, LOCAL));
      const moved = gitOut(a.h, a.repo, ["commit-tree", "-p", LOCAL, "-m", "external", `${LOCAL}^{tree}`]).trim();
      gitRun(a.h, a.repo, ["update-ref", LOCAL, moved]);
      const before = stateOf(a);
      const from = service.runner.calls.length;
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(remoteCalls(service, from)).toEqual([]);
      expect(stateOf(a)).toEqual(before);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "D7: an approved pre-push hook that commits on the local branch during the run gives failed-with-effects with localNotDeleted; the local ref keeps the new commit", SHELL, async () => {
    const a = own();
    const log = `${a.h.root}/${a.repo.split("/").at(-1)}-pre-push.log`;
    const commit = `new=$(git -c user.name=Hook -c user.email=hook@example.invalid commit-tree -p ${LOCAL} -m hook '${LOCAL}^{tree}') && git update-ref ${LOCAL} "$new"`;
    logHook(a, "pre-push", log, `${commit}\nexit 0`);
    await withSync("t010-hook-commit", async (service) => {
      const r = await register(service, a.repo);
      await approve(service, r.repositoryId);
      const review = await reviewed(service, r, payloadOf(FEATURE, LOCAL));
      const tip = revParse(a.h, a.repo, LOCAL);
      const response = await sync(service, r, review.syncReviewToken);
      expect(outcome(response)).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
      expect({ status: response.result!.push!.status, localNotDeleted: (response.result as DeleteResult).localNotDeleted }).toEqual({ status: "deleted", localNotDeleted: true });
      const after = stateOf(a);
      expect(after.remote["refs/heads/feature"]).toBeUndefined();
      expect(gitOut(a.h, a.repo, ["rev-parse", `${LOCAL}^`]).trim()).toBe(tip);
      expect(after.config.includes('[branch "feature"]')).toBe(true);
    });
    expect(a.h.read(log)?.toString("utf8")).toEndWith("run\n");
  }, TIMEOUT_MS);

  caseTest(TASK, "D7: Cancel while the first local write waits gives failed-with-effects with localNotDeleted; the remote branch is gone, and the local branch and its section stay", SHELL, async () => {
    const a = own();
    const tip = revParse(a.h, a.repo, LOCAL);
    await withSync("t010-cancel", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE, LOCAL));
      const release = service.runner.holdStart(isUpdateRef);
      const requestId = sendSync(service, r, review.syncReviewToken);
      try {
        await until(() => service.runner.calls.some(isUpdateRef), "the held update-ref");
        await service.cancel(await service.operationId(requestId));
      } finally {
        release();
      }
      const response = await service.response<DeleteResult>(requestId);
      expect(outcome(response)).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
      expect({ status: response.result!.push!.status, localNotDeleted: response.result!.localNotDeleted }).toEqual({ status: "deleted", localNotDeleted: true });
      expect(phasesOf(service, requestId).filter((p) => p === "sync-delete-local")).toEqual(["sync-delete-local"]);
    });
    const after = stateOf(a);
    expect({ remote: after.remote["refs/heads/feature"], tracking: after.refs[FEATURE], local: after.refs[LOCAL], section: after.config.includes('[branch "feature"]') }).toEqual({ remote: undefined, tracking: undefined, local: tip, section: true });
  }, TIMEOUT_MS);

  // Constitution I: the mark follows the fresh ref listing, not the exit codes of the local writes.
  caseTest(TASK, "D7: a failed section removal after the local ref delete gives failed-with-effects without localNotDeleted; the local branch is gone, and its section stays", SHELL, async () => {
    const a = own();
    const tip = revParse(a.h, a.repo, LOCAL);
    const expectOid = revParse(a.h, a.repo, FEATURE);
    const lock = `${a.repo}/.git/config.lock`;
    await withSync("t010-section-fails", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE, LOCAL));
      // git-config(1): a held `config.lock` fails each config write. Push and update-ref write no config.
      a.h.write(lock, "");
      const from = service.runner.calls.length;
      let response: Awaited<ReturnType<typeof sync>>;
      try {
        response = await sync(service, r, review.syncReviewToken);
      } finally {
        rmSync(native(lock));
      }
      expect(remoteCalls(service, from).map((c) => c.arguments)).toEqual([DELETE_ARGS("origin", "refs/heads/feature", expectOid), ["--no-lazy-fetch", "update-ref", "--no-deref", "-d", LOCAL, tip], SECTION]);
      expect(outcome(response)).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
      expect({ status: response.result!.push!.status, localNotDeleted: (response.result as DeleteResult).localNotDeleted }).toEqual({ status: "deleted", localNotDeleted: undefined });
    });
    const after = stateOf(a);
    expect({ remote: after.remote["refs/heads/feature"], tracking: after.refs[FEATURE], local: after.refs[LOCAL], section: after.config.includes('[branch "feature"]') }).toEqual({ remote: undefined, tracking: undefined, local: undefined, section: true });
  }, TIMEOUT_MS);

  caseTest(TASK, "D7: a network failure leaves both branches unchanged, runs no local write, and reports no sync-delete-local event", SHELL, async () => {
    const a = own();
    const before = stateOf(a);
    await withSync("t010-network", async (service) => {
      const r = await register(service, a.repo);
      const review = await reviewed(service, r, payloadOf(FEATURE, LOCAL));
      renameSync(native(a.origin), native(`${a.origin}-away`));
      const from = service.runner.calls.length;
      const requestId = sendSync(service, r, review.syncReviewToken);
      const response = await service.response<DeleteResult>(requestId);
      renameSync(native(`${a.origin}-away`), native(a.origin));
      expect({ ...outcome(response), status: response.result!.push!.status, localNotDeleted: response.result!.localNotDeleted }).toEqual({ state: "failed", code: "GIT_FAILED", status: "none", localNotDeleted: undefined });
      expect(response.result!.remedy!.text).toBe(STEP_REMEDY);
      expect(callsFrom(service, from).filter(isUpdateRef)).toEqual([]);
      expect(phasesOf(service, requestId)).not.toContain("sync-delete-local");
    });
    expect(stateOf(a)).toEqual(before);
  }, TIMEOUT_MS);

  // Research.md R2 P14: the commits that only the two refs hold count in the combined form alone.
  caseTest(TASK, "P14: with the local branch at the tracking tip, the remote-only count and the local delete count are 0, and the combined count is 1", SHELL, async () => {
    const a = own();
    await withSync("t010-count", async (service) => {
      const r = await register(service, a.repo);
      expect((await reviewed(service, r, payloadOf(FEATURE))).plan.lease!.count).toBe(0);
      const local = await service.request<{ plan: { onlyHere: number } }>("reviewWorkbench", { action: "delete-branch", ref: LOCAL }, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
      expect(local.result!.plan.onlyHere).toBe(0);
      expect((await reviewed(service, r, payloadOf(FEATURE, LOCAL))).plan.lease!.count).toBe(1);
    });
  }, TIMEOUT_MS);
});
