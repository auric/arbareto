// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T045: `reviewSync` and `sync` with `abort`, `continue`, and `skip` (contract Δ3 reads 7 and 8, data-model §2, §7, and §8, plan.md D7, FR-001, FR-004, FR-030, FR-042 to FR-045, SC-012).
// The oracle is the same Git command by hand on a copy. The kind of operation comes from the markers, never from message text.

import { expect } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { indexStageArgs, syncRefsArgs } from "../../src/git-service/sync-commands";
import type { RecordedCall } from "./bun-runner";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { compare } from "./hunk-harness";
import { buildMergeConflict, buildPull, buildRebaseConflict, buildRebaseSkip, fc, gitOut, gitPaths, gitRun, importStream, markers, pullRowCopy, refMap, revParse, type GitHost } from "./remote-fixtures";
import { caseTest, siblingDeadline, type Service } from "./service-harness";
import type { RegistrationResult } from "./service-harness";
import {
  ANY_EXIT,
  callsOf,
  gitExe,
  hostFor,
  INTEGRATE_ENV,
  native,
  refreshIndex,
  refusalOf,
  register,
  repoShape,
  reviewed,
  reviewSync,
  run,
  sendSync,
  subcommandOf,
  subcommandsOf,
  sync,
  TIMEOUT_MS,
  unmergedPaths,
  until,
  withSync,
  type SyncResult,
} from "./sync-harness";

useFixtureRoot();

const TASK = "T045";
const SHELL = ["shell-double"] as const;
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const SUCCEEDED = { state: "succeeded", code: undefined };
const WITH_EFFECTS = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };
const unavailable = (reason: string) => ({ state: "failed", code: "SYNC_UNAVAILABLE", result: { reason } });
const integrateCalls = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate");
// SC-012 compares HEAD, the index, the working files, the markers, and every ref.
const stateOf = (h: GitHost, repo: string) => ({ ...repoShape(h, repo), refs: refMap(h, repo), headOid: gitRun(h, repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] }).stdout.toString("utf8").trim() });

// The fixture filter drivers and hooks are repository-controlled, so the sync class needs approval (plan.md D11).
async function approved(service: Service, repo: string): Promise<RegistrationResult> {
  const r = await register(service, repo);
  const trust = await service.readTrust(r.repositoryId);
  if (trust.result!.approvalRequired.sync) expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
  return r;
}

function initRepo(h: GitHost, path: string): string {
  gitRun(h, h.root, ["init", "-q", "-b", "main", "--", path]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, path, ["config", key, value]);
  return path;
}

// The fact (l) history with the `apply` backend, which keeps its state in `rebase-apply` (plan.md D7: both backends allow Continue and Skip).
// `step a` stops on `a.txt`. With `secondConflicts`, `step b` then stops on `c.txt`.
function applyRebase(h: GitHost, name: string, secondConflicts: boolean): { repo: string; stopped: string; upstream: string } {
  const repo = initRepo(h, `${h.root}/${name}`);
  const marks = importStream(h, repo, [
    fc({ mark: 1, message: "base\n", files: { "a.txt": "base\n", "c.txt": "base\n" } }),
    fc({ mark: 2, ref: "refs/heads/up", message: "up\n", from: 1, files: { "a.txt": "up\n", "c.txt": "up\n" } }),
    fc({ mark: 3, message: "step a\n", from: 1, files: { "a.txt": "topic\n" } }),
    fc({ mark: 4, message: "step b\n", from: 3, files: secondConflicts ? { "c.txt": "topic\n" } : { "b.txt": "topic\n" } }),
  ]);
  gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
  gitRun(h, repo, ["rebase", "--apply", "up"], { allowExit: ANY_EXIT });
  expect(markers(h, repo)).toEqual(["rebase-apply"]);
  return { repo, stopped: marks.get(3)!, upstream: marks.get(2)! };
}

// The fact (l) history with the merge backend: `step a` stops on `a.txt`. `extra` holds options such as `-x true`.
function mergeRebase(h: GitHost, name: string, extra: string[] = []): string {
  const repo = initRepo(h, `${h.root}/${name}`);
  importStream(h, repo, [
    fc({ mark: 1, message: "base\n", files: { "a.txt": "base\n" } }),
    fc({ mark: 2, ref: "refs/heads/up", message: "up\n", from: 1, files: { "a.txt": "up\n" } }),
    fc({ mark: 3, message: "step a\n", from: 1, files: { "a.txt": "topic\n" } }),
    fc({ mark: 4, message: "step b\n", from: 3, files: { "b.txt": "topic\n" } }),
  ]);
  gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
  gitRun(h, repo, ["rebase", ...extra, "up"], { allowExit: ANY_EXIT, env: INTEGRATE_ENV });
  expect(markers(h, repo)).toEqual(["rebase-merge"]);
  return repo;
}
const todoOf = (h: GitHost, repo: string) => gitPaths(h, repo, ["rebase-merge/git-rebase-todo"])[0]!;
const psQuote = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

// `git am` stops with `rebase-apply/applying`, which data-model §2 maps to `unknown`.
function amStop(h: GitHost, name: string): string {
  const repo = initRepo(h, `${h.root}/${name}`);
  importStream(h, repo, [
    fc({ mark: 1, message: "base\n", files: { "a.txt": "base\n" } }),
    fc({ mark: 2, ref: "refs/heads/other", message: "other\n", from: 1, files: { "a.txt": "other\n" } }),
    fc({ mark: 3, message: "mine\n", from: 1, files: { "a.txt": "mine\n" } }),
  ]);
  gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
  const patch = gitOut(h, repo, ["format-patch", "-1", "--stdout", "other"]);
  gitRun(h, repo, ["am", "--3way"], { input: Buffer.from(patch), allowExit: ANY_EXIT });
  expect(markers(h, repo)).toEqual(["rebase-apply", "rebase-apply/applying"]);
  return repo;
}

describeGit("conflict actions abort, continue, and skip (T045)", () => {
  let copies = 0;
  const host = (tag: string) => hostFor(`t045-${tag}`);
  const copyOf = (h: GitHost, repo: string) => {
    const to = `${h.root}/copy-${++copies}`;
    h.copy(repo, to);
    return refreshIndex(h, to);
  };

  caseTest(TASK, "SC-012: Abort gives the HEAD, index, working files, markers, and refs of Git's own merge --abort or rebase --abort on a copy, for a merge, a merge-backend rebase, and an apply-backend rebase", SHELL, async () => {
    const h = host("abort");
    const fixtures: [string, string, "merge" | "rebase"][] = [
      ["merge", buildMergeConflict(h, "merge").repo, "merge"],
      ["merge-backend rebase", buildRebaseConflict(h, "rebase").repo, "rebase"],
      ["apply-backend rebase", applyRebase(h, "apply", true).repo, "rebase"],
    ];
    for (const [name, repo, kind] of fixtures) {
      const oracle = copyOf(h, repo);
      await withSync(`t045-abort-${copies}`, async (service) => {
        const r = await approved(service, repo);
        const review = await reviewed(service, r, { action: "abort" });
        expect({ name, plan: review.plan }).toEqual({ name, plan: { remotes: [], operationState: kind === "merge" ? "merging" : "rebasing" } });
        const from = service.runner.calls.length;
        const response = await sync(service, r, review.syncReviewToken);
        expect({ name, ...outcome(response), integration: response.result!.integration }).toEqual({ name, ...SUCCEEDED, integration: { state: "done" } });
        expect({ name, calls: integrateCalls(service, from).map((c) => c.arguments) }).toEqual({ name, calls: [["--no-lazy-fetch", kind, "--abort"]] });
      });
      gitRun(h, oracle, [kind, "--abort"], { env: INTEGRATE_ENV });
      expect({ name, state: stateOf(h, repo) }).toEqual({ name, state: stateOf(h, oracle) });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "data-model §8: an Abort that exits 0 while another operation remains gives failed-with-effects, not succeeded", SHELL, async () => {
    const h = host("abort-left");
    const repo = buildMergeConflict(h, "merge").repo;
    // `merge --abort` keeps a sequencer directory (sequencer.c `sequencer_post_commit_cleanup` needs CHERRY_PICK_HEAD or REVERT_HEAD).
    mkdirSync(native(gitPaths(h, repo, ["sequencer"])[0]!));
    expect(markers(h, repo)).toEqual(["MERGE_HEAD", "sequencer"]);
    await withSync("t045-abort-left", async (service) => {
      const r = await approved(service, repo);
      const review = await reviewed(service, r, { action: "abort" });
      expect(review.plan.operationState).toBe("merging");
      const response = await sync(service, r, review.syncReviewToken);
      expect({ ...outcome(response), integration: response.result!.integration }).toEqual({ ...WITH_EFFECTS, integration: { state: "done" } });
    });
    expect(markers(h, repo)).toEqual(["sequencer"]);
  }, TIMEOUT_MS);

  caseTest(TASK, "D7 and FR-043: Continue reviews refuse CONFLICTED with the unmerged count while an unmerged entry exists, also beside a resolved file with marker-like text; no process starts", SHELL, async () => {
    const h = host("conflicted");
    for (const repo of [buildMergeConflict(h, "merge").repo, applyRebase(h, "apply", false).repo]) {
      const count = unmergedPaths(h, repo).length;
      expect(count).toBeGreaterThan(0);
      await withSync(`t045-conflicted-${++copies}`, async (service) => {
        const r = await approved(service, repo);
        const from = service.runner.calls.length;
        expect(refusalOf(await reviewSync(service, r, { action: "continue" }))).toEqual({ state: "failed", code: "CONFLICTED", result: { unmerged: count } });
        expect(integrateCalls(service, from)).toEqual([]);
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-012 and research R4: a merge Continue with every path staged takes MERGE_MSG without comment lines, stages no file, and equals Git's own commit on a copy; a file with marker-like text does not block it", SHELL, async () => {
    const h = host("continue-merge");
    const { repo } = buildMergeConflict(h, "merge");
    gitRun(h, repo, ["add", "-A"]);
    expect(unmergedPaths(h, repo)).toEqual([]);
    const [msgPath] = gitPaths(h, repo, ["MERGE_MSG"]);
    const stripped = gitRun(h, repo, ["stripspace", "--strip-comments"], { input: h.read(msgPath!)! }).stdout.toString("utf8");
    const oracle = copyOf(h, repo);
    await withSync("t045-continue-merge", async (service) => {
      const r = await approved(service, repo);
      const review = await reviewed(service, r, { action: "continue" });
      expect(review.plan).toEqual({ remotes: [], operationState: "merging" });
      const requestId = sendSync(service, r, review.syncReviewToken);
      const response = await service.response<SyncResult>(requestId);
      expect({ ...outcome(response), integration: response.result!.integration }).toEqual({ ...SUCCEEDED, integration: { state: "done" } });
      const subcommands = subcommandsOf(service, await service.operationId(requestId));
      expect({ commit: subcommands.filter((s) => s === "commit").length, staging: subcommands.filter((s) => s === "add" || s === "update-index" || s === "stage") }).toEqual({ commit: 1, staging: [] });
      expect(integrateCalls(service).map((c) => c.arguments)).toEqual([["--no-lazy-fetch", "commit", "--quiet"]]);
    });
    gitRun(h, oracle, ["commit", "--quiet"], { env: INTEGRATE_ENV });
    expect(stateOf(h, repo)).toEqual(stateOf(h, oracle));
    const raw = gitOut(h, repo, ["cat-file", "commit", "HEAD"]);
    expect(raw.slice(raw.indexOf("\n\n") + 2)).toBe(stripped);
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-045: an apply-backend rebase Continue that stops again gives failed-with-effects with integration stopped and equals Git's own rebase --continue on a copy", SHELL, async () => {
    const h = host("continue-rebase");
    const { repo } = applyRebase(h, "apply", true);
    gitRun(h, repo, ["add", "--", "a.txt"]);
    const oracle = copyOf(h, repo);
    await withSync("t045-continue-rebase", async (service) => {
      const r = await approved(service, repo);
      const response = await run(service, r, { action: "continue" });
      expect({ ...outcome(response), integration: response.result!.integration }).toEqual({ ...WITH_EFFECTS, integration: { state: "stopped", operation: "rebasing", unmerged: 1 } });
    });
    gitRun(h, oracle, ["rebase", "--continue"], { allowExit: ANY_EXIT, env: INTEGRATE_ENV });
    expect(unmergedPaths(h, repo)).toEqual(["c.txt"]);
    expect(stateOf(h, repo)).toEqual(stateOf(h, oracle));
  }, TIMEOUT_MS);

  // Plan.md D7: builtin/rebase.c `init_basic_state` writes `rebase-merge/interactive` for every merge-backend rebase, so every rebase stop offers Continue and Skip.
  caseTest(TASK, "D7: a default-backend pull rebase that stops on a conflict, then Mark resolved, then Continue equals Git's own rebase --continue with GIT_EDITOR=: on a copy", SHELL, async () => {
    const h = host("pull-continue");
    const f = buildPull(h);
    const repo = refreshIndex(h, pullRowCopy(h, f, { name: "pull-continue", branch: "p-diverged", config: [], expect: "rebase" }, `${h.root}/app`));
    // Both sides add `remote.txt` with other content.
    h.write(`${repo}/remote.txt`, "local\n");
    gitRun(h, repo, ["add", "--", "remote.txt"]);
    gitRun(h, repo, ["commit", "-q", "-m", "local remote.txt"]);
    let oracle = "";
    await withSync("t045-pull-continue", async (service) => {
      const r = await approved(service, repo);
      const pulled = await run(service, r, { action: "pull", mode: "rebase" });
      expect({ ...outcome(pulled), integration: pulled.result!.integration }).toEqual({ ...WITH_EFFECTS, integration: { state: "stopped", operation: "rebasing", unmerged: 1 } });
      expect(h.existing(gitPaths(h, repo, ["rebase-merge/interactive"]))).toHaveLength(1);
      oracle = copyOf(h, repo);
      for (const at of [repo, oracle]) h.write(`${at}/remote.txt`, "resolved\n");
      const c = await compare(service, r.repositoryId, "remote.txt", "conflicted");
      expect(outcome(await service.request("applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction: "resolve" }, { repositoryId: r.repositoryId, repositoryGeneration: c.read.generation }))).toEqual(SUCCEEDED);
      gitRun(h, oracle, ["--literal-pathspecs", "add", "--", "remote.txt"]);
      const review = await reviewed(service, r, { action: "continue" });
      expect(review.plan).toEqual({ remotes: [], operationState: "rebasing" });
      const response = await sync(service, r, review.syncReviewToken);
      expect({ ...outcome(response), integration: response.result!.integration }).toEqual({ ...SUCCEEDED, integration: { state: "done" } });
    });
    gitRun(h, oracle, ["rebase", "--continue"], { env: INTEGRATE_ENV });
    expect(stateOf(h, repo)).toEqual(stateOf(h, oracle));
    expect(markers(h, repo)).toEqual([]);
  }, TIMEOUT_MS);

  caseTest(TASK, "D7: Skip at a default-backend rebase stop names REBASE_HEAD and equals Git's own rebase --skip on a copy", SHELL, async () => {
    const h = host("skip-default");
    const { clean, upstream } = buildRebaseSkip(h);
    expect(h.existing(gitPaths(h, clean, ["rebase-merge/interactive"]))).toHaveLength(1);
    const stopped = revParse(h, clean, "REBASE_HEAD");
    const oracle = copyOf(h, clean);
    await withSync("t045-skip-default", async (service) => {
      const r = await approved(service, clean);
      const review = await reviewed(service, r, { action: "skip" });
      expect(review.plan).toEqual({ remotes: [], operationState: "rebasing", skippedCommit: { objectId: stopped, subject: "step a" } });
      const response = await sync(service, r, review.syncReviewToken);
      expect({ ...outcome(response), integration: response.result!.integration }).toEqual({ ...SUCCEEDED, integration: { state: "done" } });
    });
    gitRun(h, oracle, ["rebase", "--skip"], { env: INTEGRATE_ENV });
    expect(stateOf(h, clean)).toEqual(stateOf(h, oracle));
    expect(revParse(h, clean, "HEAD^")).toBe(upstream);
  }, TIMEOUT_MS);

  caseTest(TASK, "D7: Continue at a fixup stop of an --autosquash rebase keeps Git's prepared message and equals Git's own rebase --continue with GIT_EDITOR=: on a copy", SHELL, async () => {
    const h = host("autosquash");
    const repo = initRepo(h, `${h.root}/autosquash`);
    importStream(h, repo, [
      fc({ mark: 1, message: "base\n", files: { "a.txt": "base\n", "c.txt": "base\n" } }),
      fc({ mark: 2, ref: "refs/heads/up", message: "up\n", from: 1, files: { "c.txt": "up\n" } }),
      fc({ mark: 3, message: "work\n\nbody\n", from: 1, files: { "a.txt": "work\n" } }),
      fc({ mark: 4, message: "fixup! work\n", from: 3, files: { "c.txt": "fix\n" } }),
    ]);
    gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
    // The pick of `work` applies. The fixup stops on `c.txt`.
    gitRun(h, repo, ["rebase", "--no-autostash", "--autosquash", "up"], { allowExit: ANY_EXIT, env: INTEGRATE_ENV });
    expect({ markers: markers(h, repo), unmerged: unmergedPaths(h, repo) }).toEqual({ markers: ["rebase-merge"], unmerged: ["c.txt"] });
    h.write(`${repo}/c.txt`, "resolved\n");
    gitRun(h, repo, ["add", "--", "c.txt"]);
    const oracle = copyOf(h, repo);
    await withSync("t045-autosquash", async (service) => {
      const r = await approved(service, repo);
      const response = await run(service, r, { action: "continue" });
      expect({ ...outcome(response), integration: response.result!.integration }).toEqual({ ...SUCCEEDED, integration: { state: "done" } });
    });
    gitRun(h, oracle, ["rebase", "--continue"], { env: INTEGRATE_ENV });
    expect(stateOf(h, repo)).toEqual(stateOf(h, oracle));
    const raw = gitOut(h, repo, ["cat-file", "commit", "HEAD"]);
    expect({ message: raw.slice(raw.indexOf("\n\n") + 2), parents: gitOut(h, repo, ["rev-parse", "HEAD^"]).trim(), files: gitOut(h, repo, ["show", "HEAD:c.txt"]) }).toEqual({ message: "work\n\nbody\n", parents: revParse(h, repo, "up"), files: "resolved\n" });
  }, TIMEOUT_MS);

  caseTest(TASK, "D7 and contract Δ3 read 8: the skip review names the REBASE_HEAD commit and its subject; Skip equals Git's own rebase --skip on a copy, and the index and files equal HEAD of the next step", SHELL, async () => {
    const h = host("skip");
    const f = applyRebase(h, "apply", false);
    expect(revParse(h, f.repo, "REBASE_HEAD")).toBe(f.stopped);
    const oracle = copyOf(h, f.repo);
    await withSync("t045-skip", async (service) => {
      const r = await approved(service, f.repo);
      const review = await reviewed(service, r, { action: "skip" });
      expect(review.plan).toEqual({ remotes: [], operationState: "rebasing", skippedCommit: { objectId: f.stopped, subject: "step a" } });
      const response = await sync(service, r, review.syncReviewToken);
      expect({ ...outcome(response), integration: response.result!.integration }).toEqual({ ...SUCCEEDED, integration: { state: "done" } });
    });
    gitRun(h, oracle, ["rebase", "--skip"], { env: INTEGRATE_ENV });
    expect(stateOf(h, f.repo)).toEqual(stateOf(h, oracle));
    expect({
      markers: markers(h, f.repo),
      indexEqualsHead: gitRun(h, f.repo, ["diff-index", "--quiet", "--cached", "HEAD", "--"], { allowExit: ANY_EXIT }).exitCode,
      filesEqualIndex: gitRun(h, f.repo, ["diff-files", "--quiet"], { allowExit: ANY_EXIT }).exitCode,
      parentIsUpstream: revParse(h, f.repo, "HEAD^") === f.upstream,
    }).toEqual({ markers: [], indexEqualsHead: 0, filesEqualIndex: 0, parentIsUpstream: true });
  }, TIMEOUT_MS);

  caseTest(TASK, "contract Δ3 read 8: without REBASE_HEAD the skip review gives no-skip-commit, and a REBASE_HEAD that changes after the review gives STALE_REVIEW; neither starts a process", SHELL, async () => {
    const h = host("skip-head");
    const gone = applyRebase(h, "gone", false);
    gitRun(h, gone.repo, ["update-ref", "-d", "REBASE_HEAD"]);
    const moved = applyRebase(h, "moved", false);
    // The service holds one workspace, so each repository gets its own service.
    await withSync("t045-skip-gone", async (service) => {
      const a = await approved(service, gone.repo);
      expect(refusalOf(await reviewSync(service, a, { action: "skip" }))).toEqual(unavailable("no-skip-commit"));
      expect(integrateCalls(service)).toEqual([]);
    });
    await withSync("t045-skip-moved", async (service) => {
      const b = await approved(service, moved.repo);
      const review = await reviewed(service, b, { action: "skip" });
      gitRun(h, moved.repo, ["update-ref", "REBASE_HEAD", moved.upstream]);
      expect(outcome(await sync(service, b, review.syncReviewToken))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(integrateCalls(service)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "D7: every action needs a merge or a rebase in progress (no-operation), Skip refuses a merge (not-rebasing), and git am, whose state is unknown, gives unknown-operation", SHELL, async () => {
    const h = host("no-operation");
    const clean = initRepo(h, `${h.root}/clean`);
    importStream(h, clean, [fc({ mark: 1, message: "base\n", files: { "a.txt": "base\n" } })]);
    gitRun(h, clean, ["reset", "-q", "--hard", "main"]);
    const am = amStop(h, "am");
    const merge = buildMergeConflict(h, "merge").repo;
    for (const [name, repo, reason] of [["clean", clean, "no-operation"], ["am", am, "unknown-operation"]] as const) {
      await withSync(`t045-no-operation-${name}`, async (service) => {
        const r = await approved(service, repo);
        for (const action of ["abort", "continue", "skip"]) expect({ action, repo: name, ...refusalOf(await reviewSync(service, r, { action })) }).toEqual({ action, repo: name, ...unavailable(reason) });
        expect(integrateCalls(service)).toEqual([]);
      });
    }
    await withSync("t045-not-rebasing", async (service) => {
      const r = await approved(service, merge);
      expect(refusalOf(await reviewSync(service, r, { action: "skip" }))).toEqual(unavailable("not-rebasing"));
      expect(integrateCalls(service)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "contract Δ3: while git am stops, whose state is unknown, pull, integrate, push, and force-push reviews give unknown-operation; no remote or integrate process starts", SHELL, async () => {
    const h = host("unknown-sync");
    const am = amStop(h, "am");
    await withSync("t045-unknown-sync", async (service) => {
      const r = await approved(service, am);
      for (const payload of [{ action: "pull" }, { action: "integrate", mode: "merge" }, { action: "push" }, { action: "force-push" }]) expect({ ...payload, ...refusalOf(await reviewSync(service, r, payload)) }).toEqual({ ...payload, ...unavailable("unknown-operation") });
      expect(service.runner.calls.filter((c) => c.environmentPolicy === "integrate" || c.environmentPolicy === "remote")).toEqual([]);
    });
  }, TIMEOUT_MS);

  // Plan.md D7: repository content is untrusted, and Git runs each `exec` line of the todo with the shell (sequencer.c `todo_command_info`).
  caseTest(TASK, "D7: a rebase whose todo holds exec lines refuses Continue and Skip with rebase-exec and the terminal command, keeps Abort, starts no process, and leaves Git's state unchanged", SHELL, async () => {
    const h = host("rebase-exec");
    const repo = mergeRebase(h, "exec", ["-x", "true"]);
    expect(h.read(todoOf(h, repo))!.toString("utf8").split("\n").filter((l) => l.startsWith("exec "))).toEqual(["exec true", "exec true"]);
    const before = stateOf(h, repo);
    await withSync("t045-rebase-exec", async (service) => {
      const r = await approved(service, repo);
      const from = service.runner.calls.length;
      for (const action of ["continue", "skip"]) {
        const response = await reviewSync(service, r, { action });
        expect({ action, ...refusalOf(response) }).toEqual({
          action,
          state: "failed",
          code: "SYNC_UNAVAILABLE",
          result: {
            reason: "rebase-exec",
            remedy: {
              text: "This rebase holds exec lines, and Git runs them as shell commands. Arbareto does not run them. Read the todo list, then continue in a terminal.",
              command: `& ${psQuote(gitExe())} --no-lazy-fetch -C ${psQuote(r.worktreeRoot)} rebase --${action}`,
            },
          },
        });
      }
      expect(outcome(await reviewSync(service, r, { action: "abort" }))).toEqual(SUCCEEDED);
      expect(integrateCalls(service, from)).toEqual([]);
    });
    expect(stateOf(h, repo)).toEqual(before);
  }, TIMEOUT_MS);

  caseTest(TASK, "D7: a planted leading-space x line refuses, a comment line '# exec' does not run and does not refuse, and an unreadable todo refuses; the canary never runs", SHELL, async () => {
    const h = host("planted");
    const canary = `${h.root}/planted.ran`;
    const x = mergeRebase(h, "x-line");
    h.write(todoOf(h, x), `  x touch '${canary}'\n${h.read(todoOf(h, x))!.toString("utf8")}`);
    const comment = mergeRebase(h, "comment-line");
    h.write(todoOf(h, comment), `# exec touch '${canary}'\n${h.read(todoOf(h, comment))!.toString("utf8")}`);
    const oracle = copyOf(h, comment);
    const unreadable = mergeRebase(h, "unreadable");
    rmSync(native(todoOf(h, unreadable)));
    mkdirSync(native(todoOf(h, unreadable)));
    const texts = {
      "x-line": "This rebase holds exec lines, and Git runs them as shell commands. Arbareto does not run them. Read the todo list, then continue in a terminal.",
      unreadable: "Arbareto cannot read the rebase todo list. Continue in a terminal.",
    };
    for (const [name, repo] of [["x-line", x], ["unreadable", unreadable]] as const) {
      await withSync(`t045-planted-${name}`, async (service) => {
        const r = await approved(service, repo);
        for (const action of ["continue", "skip"]) {
          const result = refusalOf(await reviewSync(service, r, { action })).result as { reason?: string; remedy?: { text: string } };
          expect({ name, action, reason: result.reason, text: result.remedy?.text }).toEqual({ name, action, reason: "rebase-exec", text: texts[name] });
        }
        expect(integrateCalls(service)).toEqual([]);
      });
    }
    await withSync("t045-planted-comment", async (service) => {
      const r = await approved(service, comment);
      const response = await run(service, r, { action: "skip" });
      expect({ ...outcome(response), integration: response.result!.integration }).toEqual({ ...SUCCEEDED, integration: { state: "done" } });
    });
    gitRun(h, oracle, ["rebase", "--skip"], { env: INTEGRATE_ENV });
    expect(stateOf(h, comment)).toEqual(stateOf(h, oracle));
    expect(existsSync(native(canary))).toBe(false);
  }, TIMEOUT_MS);

  caseTest(TASK, "contract Δ3: a todo that changes after the review gives STALE_REVIEW and starts no process", SHELL, async () => {
    const h = host("todo-stale");
    const repo = mergeRebase(h, "stale");
    await withSync("t045-todo-stale", async (service) => {
      const r = await approved(service, repo);
      const review = await reviewed(service, r, { action: "skip" });
      h.write(todoOf(h, repo), `${h.read(todoOf(h, repo))!.toString("utf8")}# a later line\n`);
      const from = service.runner.calls.length;
      expect(outcome(await sync(service, r, review.syncReviewToken))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(integrateCalls(service, from)).toEqual([]);
    });
    expect(markers(h, repo)).toEqual(["rebase-merge"]);
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-001: each action is a mutation, so a second mutation of the repository gives BUSY while it runs, and reads stay available", SHELL, async () => {
    const h = host("busy");
    for (const action of ["abort", "continue", "skip"] as const) {
      const { repo } = applyRebase(h, `busy-${action}`, false);
      if (action === "continue") gitRun(h, repo, ["add", "--", "a.txt"]);
      await withSync(`t045-busy-${action}`, async (service) => {
        const r = await approved(service, repo);
        const first = await reviewed(service, r, { action });
        const second = await reviewed(service, r, { action: "abort" });
        const isStep = (c: { arguments: readonly string[] }) => subcommandOf(c.arguments) === "rebase" || subcommandOf(c.arguments) === "commit";
        const release = service.runner.holdStart(isStep);
        const requestId = sendSync(service, r, first.syncReviewToken);
        await until(() => service.runner.calls.some(isStep), `${action} call`);
        expect({ action, ...outcome(await sync(service, r, second.syncReviewToken)) }).toEqual({ action, state: "rejected", code: "BUSY" });
        expect((await service.readWorkspace(r.repositoryId)).state).toBe("succeeded");
        release();
        const response = await service.response<SyncResult>(requestId);
        expect({ action, done: response.state === "succeeded" || response.state === "failed-with-effects" }).toEqual({ action, done: true });
        expect(callsOf(service, await service.operationId(requestId)).some(isStep)).toBe(true);
      });
    }
  }, TIMEOUT_MS);

  // T399, 001 contract §5 "Deadline outcomes": a read at its deadline closes the operation Job, so the sibling read ends with `exitCode` null and no `deadline`.
  // The reads before the step refuse with DEADLINE, and no step starts.
  caseTest("T399", "T399: an Abort gives DEADLINE when its index read before the step expires and the Job close ends the refs listing first; no step starts", SHELL, async () => {
    const h = host("t399-abort");
    const repo = buildMergeConflict(h, "t399-merge").repo;
    await withSync("t399-abort", async (service) => {
      const r = await approved(service, repo);
      const review = await reviewed(service, r, { action: "abort" });
      const isArgs = (args: readonly string[]) => (call: { arguments: readonly string[] }) => call.arguments.length === args.length && call.arguments.every((a, i) => a === args[i]);
      const [index, refs] = [isArgs(indexStageArgs()), isArgs(syncRefsArgs())];
      const from = service.runner.calls.length;
      const release = siblingDeadline(service, index, refs);
      const response = await sync(service, r, review.syncReviewToken).finally(release);
      const own = service.runner.calls.slice(from).filter((c) => c.operationId === response.operationId);
      const endOf = (call: RecordedCall | undefined) => call?.exit?.deadline ?? (call?.exit?.exitCode === null ? "closed" : String(call?.exit?.exitCode));
      const exits = [own.find(index), own.find(refs)].map(endOf);
      console.log(`OBSERVATION T399: abort exits=${exits.join(",")} state=${response.state} code=${response.code}`);
      expect({ exits, ...outcome(response), steps: integrateCalls(service, from).length }).toEqual({ exits: ["deadline", "closed"], state: "failed", code: "DEADLINE", steps: 0 });
    });
  }, 120_000);
});
