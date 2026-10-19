// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T054: Amend last commit (spec FR-098 to FR-100, SC-016, plan.md D8 "Amend last commit", contract Δ3 `reviewCommit` and `commit`, quickstart.md Q28).
// The oracle is Git's own `commit --amend` on a second build of the same fixture. The fixed fixture dates make the object IDs of both builds equal.

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { put } from "./fixtures";
import { workingFileDigests } from "./git-oracle";
import { caseTest, keepConfigs, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";
import { gitExe, native, TIMEOUT_MS, withSync as syncService } from "./sync-harness";
import { buildWorkbench, canary, repoOf, wb, type WbRepo } from "./workbench-fixtures";

// SC-009 (T096): each case keeps the bytes of every configuration file of the repositories that it registers.
const withSync = (name: string, body: (service: Service) => Promise<void>, options?: Parameters<typeof syncService>[2]) => syncService(name, (service) => keepConfigs(service, body), options);

for (const module of ["commit-review", "commit", "reconcile", "attribution", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T054";
const SHELL = ["shell-double"] as const;
const L = "--no-lazy-fetch";
const READ = [L, "--no-optional-locks", "--literal-pathspecs"];
const SUCCEEDED = { state: "succeeded", code: undefined };
const UPSTREAM = "refs/remotes/origin/main";
const MESSAGE = "Amend subject\n\nBody line one\nBody line two\n";
const NEW_MESSAGE = "Amended subject\n\nNew body line\n";
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const refused = (r: ServiceResponse<unknown>) => ({ ...outcome(r), result: r.result });

interface AmendFacts {
  headOid: string;
  message: string;
  upstream: { name: string; present: boolean } | null;
  rewritesUpstream: boolean | "unknown";
}

interface Reviewed {
  amend?: AmendFacts;
  reviewToken?: string;
  scope: unknown[];
  disclosure: { approvalRequired: boolean; trust: string };
}

// `holds`: the upstream ref points at HEAD. `behind`: it points at the parent of HEAD. `absent`: the configuration names an upstream, and no such ref exists.
// `untracked`: `branch.main.merge` is set, and no fetch refspec stores it as a remote-tracking branch, so `%(upstream)` is empty. `none`: the branch has no upstream.
type Upstream = "holds" | "behind" | "absent" | "untracked" | "none";
// The `branch.main.merge` value: the branch on the remote.
const MERGE = "refs/heads/main";

const git = (r: WbRepo, args: string[], allowExit: readonly number[] = [0], input?: string) => wb(r, args, { allowExit, ...(input === undefined ? {} : { input }) });
const text = (r: WbRepo, args: string[]) => git(r, args).stdout.toString("utf8");
const oid = (r: WbRepo, rev: string) => text(r, ["rev-parse", "--verify", "-q", rev]).trim();

let builds = 0;
// A two-commit history on `main` with LF line endings. `tag` names the folder. Each build of the same arguments gives the same object IDs.
function build(tag: string, upstream: Upstream = "none"): WbRepo {
  const r: WbRepo = { git: gitExe(), dir: join(fixtureDir(`t054-${tag}-${++builds}`), "repo"), env: {} };
  mkdirSync(r.dir, { recursive: true });
  git(r, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"], ["core.filemode", "false"]] as const) git(r, ["config", key, value]);
  put(r.dir, "a.txt", "one\n");
  git(r, ["add", "--", "a.txt"]);
  git(r, ["commit", "-q", "-m", "base"]);
  put(r.dir, "a.txt", "two\n");
  git(r, ["add", "--", "a.txt"]);
  git(r, ["commit", "-q", "--file=-"], [0], MESSAGE);
  if (upstream !== "none") {
    // `%(upstream)` maps `branch.main.merge` through the fetch refspec of the remote (git-for-each-ref(1)). No fetch runs.
    git(r, ["config", "remote.origin.url", "https://host.invalid/origin.git"]);
    if (upstream !== "untracked") git(r, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(r, ["config", "branch.main.remote", "origin"]);
    git(r, ["config", "branch.main.merge", MERGE]);
    if (upstream === "holds" || upstream === "behind") git(r, ["update-ref", UPSTREAM, upstream === "holds" ? "HEAD" : "HEAD~1"]);
  }
  return r;
}

// gitformat-commit: the header lines, one empty line, then the message bytes.
function headMessage(r: WbRepo): string {
  const raw = git(r, ["cat-file", "commit", "HEAD"]).stdout;
  return raw.subarray(raw.indexOf("\n\n") + 2).toString("utf8");
}

// SC-016: the refs, HEAD, the HEAD commit object (tree, parents, author, committer, message), the index, and every working byte.
function stateOf(r: WbRepo) {
  return {
    refs: text(r, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    head: text(r, ["symbolic-ref", "-q", "HEAD"]),
    commit: text(r, ["cat-file", "commit", "HEAD"]),
    index: text(r, ["ls-files", "-s", "-z"]),
    files: workingFileDigests(r.dir),
  };
}

const open = (service: Service, r: WbRepo): Promise<RegistrationResult> => service.register(native(r.dir));

async function readOk(service: Service, reg: RegistrationResult): Promise<WorkspaceResult> {
  const read = await service.readWorkspace(reg.repositoryId);
  expect(outcome(read)).toEqual(SUCCEEDED);
  return read.result!;
}

async function review(service: Service, reg: RegistrationResult, amend = true): Promise<{ read: WorkspaceResult; response: ServiceResponse<Reviewed> }> {
  const read = await readOk(service, reg);
  const response = await service.request<Reviewed>("reviewCommit", { snapshotId: read.snapshotId, ...(amend ? { amend: true } : {}) }, { repositoryId: reg.repositoryId, repositoryGeneration: read.generation });
  return { read, response };
}

async function reviewed(service: Service, reg: RegistrationResult, amend = true): Promise<{ read: WorkspaceResult; result: Reviewed; token: string }> {
  const { read, response } = await review(service, reg, amend);
  expect({ ...outcome(response), token: typeof response.result?.reviewToken }).toEqual({ ...SUCCEEDED, token: "string" });
  return { read, result: response.result!, token: response.result!.reviewToken! };
}

function commit(service: Service, reg: RegistrationResult, at: { read: WorkspaceResult; token: string }, message: string, extra: object = { amend: true }): Promise<ServiceResponse<{ commitOid?: string }>> {
  return service.request("commit", { reviewToken: at.token, message, confirmFullScope: true, ...extra }, { repositoryId: reg.repositoryId, repositoryGeneration: at.read.generation });
}

const isCommit = (args: readonly string[]) => args.includes("commit") && args.includes("--file=-");
const commitCalls = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => isCommit(c.arguments)).map((c) => [...c.arguments]);
const argsOf = (service: Service, from: number) => service.runner.calls.slice(from).map((c) => [...c.arguments]);
// Contract §5 "Pending reads": a failed read runs the registration recheck. It is no step of the review.
const RECHECK = [...READ, "rev-parse", "--is-bare-repository", "--is-inside-git-dir"];
const reviewSteps = (service: Service, from: number) => argsOf(service, from).filter((a) => !Bun.deepEquals(a, RECHECK));
const amendReads = (service: Service, from: number) => argsOf(service, from).filter((a) => a.includes("--format=%(upstream)") || a.includes(UPSTREAM));
// The upstream facts of a review: the full ref and whether the repository holds it.
// An untracked upstream has no local ref, so its name is the `branch.main.merge` value.
const upstreamOf = (upstream: Upstream) => (upstream === "none" ? null : upstream === "untracked" ? { name: MERGE, present: false } : { name: UPSTREAM, present: upstream !== "absent" });
const REWRITES: Record<Upstream, boolean | "unknown"> = { holds: true, behind: false, absent: "unknown", untracked: "unknown", none: false };

caseTest(TASK, "FR-098 and contract Δ3: reviewCommit with amend returns the HEAD message from cat-file commit, the upstream, and rewritesUpstream from show-ref --exists and merge-base --is-ancestor; an empty staged scope still gets a token", SHELL, async () => {
  for (const upstream of ["none", "behind", "holds", "absent", "untracked"] as const) {
    const f = build(`review-${upstream}`, upstream);
    await withSync(`t054-review-${upstream}`, async (service) => {
      const reg = await open(service, f);
      // Contract §3: an empty staged scope gets no token without amend.
      const plain = await review(service, reg, false);
      expect({ upstream, ...outcome(plain.response), token: plain.response.result?.reviewToken }).toEqual({ upstream, ...SUCCEEDED, token: undefined });
      const from = service.runner.calls.length;
      const r = await reviewed(service, reg);
      expect({ upstream, scope: r.result.scope, amend: r.result.amend }).toEqual({
        upstream,
        scope: [],
        amend: { headOid: oid(f, "HEAD"), message: headMessage(f), upstream: upstreamOf(upstream), rewritesUpstream: REWRITES[upstream] },
      });
      expect(argsOf(service, from)).toContainEqual([...READ, "cat-file", "commit", oid(f, "HEAD")]);
      // git-show-ref(1) `--exists`: exit 2 for a missing ref, so no merge-base read follows.
      const reads = [
        [...READ, "for-each-ref", "--format=%(upstream)", "refs/heads/main"],
        ...(upstream === "none" || upstream === "untracked" ? [] : [[...READ, "show-ref", "--exists", UPSTREAM]]),
        ...(upstream === "holds" || upstream === "behind" ? [[...READ, "merge-base", "--is-ancestor", "HEAD", UPSTREAM]] : []),
      ];
      expect({ upstream, reads: amendReads(service, from) }).toEqual({ upstream, reads });
    });
  }
}, TIMEOUT_MS);

caseTest(TASK, "contract Δ3: a show-ref --exists exit other than 0 and 2 and a merge-base --is-ancestor exit other than 0 and 1 give GIT_FAILED, and a detached HEAD has no upstream", SHELL, async () => {
  const f = build("exit", "holds");
  await withSync("t054-exit", async (service) => {
    const reg = await open(service, f);
    for (const command of ["show-ref", "merge-base"]) {
      service.runner.inject.exit = (call) => (call.arguments.includes(command) && call.arguments.includes(UPSTREAM) ? 128 : undefined);
      try {
        expect({ command, ...outcome((await review(service, reg)).response) }).toEqual({ command, state: "failed", code: "GIT_FAILED" });
      } finally {
        service.runner.inject.exit = undefined;
      }
    }
    git(f, ["checkout", "-q", "--detach", "HEAD"]);
    const from = service.runner.calls.length;
    const r = await reviewed(service, reg);
    expect(r.result.amend).toEqual({ headOid: oid(f, "HEAD"), message: headMessage(f), upstream: null, rewritesUpstream: false });
    expect(amendReads(service, from)).toEqual([]);
  });
}, TIMEOUT_MS);

caseTest(TASK, "FR-100 and contract Δ3: a token with rewritesUpstream true and no confirmRewrite: true gives INVALID_REQUEST; amend must equal the review; confirmRewrite needs amend; no commit process starts", SHELL, async () => {
  const f = build("confirm", "holds");
  const o = build("confirm", "holds");
  const g = build("confirm-plain", "holds");
  await withSync("t054-confirm", async (service) => {
    // A plain review of a staged change cannot carry an amend.
    const other = await open(service, g);
    put(g.dir, "a.txt", "three\n");
    git(g, ["add", "--", "a.txt"]);
    const plain = await reviewed(service, other, false);
    expect(outcome(await commit(service, other, plain, NEW_MESSAGE))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
    const reg = await open(service, f);
    const r = await reviewed(service, reg);
    expect(r.result.amend?.rewritesUpstream).toBe(true);
    expect(outcome(await commit(service, reg, r, NEW_MESSAGE))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
    expect(outcome(await commit(service, reg, r, NEW_MESSAGE, {}))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
    expect(outcome(await commit(service, reg, r, NEW_MESSAGE, { confirmRewrite: true }))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
    expect(commitCalls(service)).toEqual([]);
    // The same review token stays unconsumed, and the confirmed amend runs.
    const done = await commit(service, reg, r, NEW_MESSAGE, { amend: true, confirmRewrite: true });
    expect(outcome(done)).toEqual(SUCCEEDED);
    expect(commitCalls(service)).toEqual([[L, "commit", "--quiet", "--amend", "--file=-"]]);
    expect(done.result?.commitOid).toBe(oid(f, "HEAD"));
  });
  git(o, ["commit", "--quiet", "--amend", "--file=-"], [0], NEW_MESSAGE);
  expect(stateOf(f)).toEqual(stateOf(o));
}, TIMEOUT_MS);

// An upstream that the configuration names, but that the repository does not hold, such as one that was never fetched. No fact tells whether the remote
// holds HEAD, so the review reports `unknown`, and the amend asks as for an upstream that holds HEAD. Unknown never counts as safe.
caseTest(TASK, "FR-100 and contract Δ3: an upstream ref that show-ref --exists does not find gives rewritesUpstream unknown, which needs confirmRewrite: true; a ref that appears after the review gives STALE_REVIEW", SHELL, async () => {
  const f = build("absent", "absent");
  const o = build("absent", "absent");
  await withSync("t054-absent", async (service) => {
    const reg = await open(service, f);
    const r = await reviewed(service, reg);
    expect(r.result.amend).toMatchObject({ upstream: { name: UPSTREAM, present: false }, rewritesUpstream: "unknown" });
    expect(outcome(await commit(service, reg, r, NEW_MESSAGE))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
    expect(commitCalls(service)).toEqual([]);
    // Data-model §2: the token binds `unknown`. A fetch that writes the ref changes the fact, so the confirmed run refuses.
    git(f, ["update-ref", UPSTREAM, "HEAD"]);
    expect(outcome(await commit(service, reg, r, NEW_MESSAGE, { amend: true, confirmRewrite: true }))).toEqual({ state: "failed", code: "STALE_REVIEW" });
    git(f, ["update-ref", "-d", UPSTREAM]);
    const again = await reviewed(service, reg);
    expect(again.result.amend?.rewritesUpstream).toBe("unknown");
    expect(outcome(await commit(service, reg, again, NEW_MESSAGE, { amend: true, confirmRewrite: true }))).toEqual(SUCCEEDED);
    expect(commitCalls(service)).toEqual([[L, "commit", "--quiet", "--amend", "--file=-"]]);
  });
  git(o, ["commit", "--quiet", "--amend", "--file=-"], [0], NEW_MESSAGE);
  expect(stateOf(f)).toEqual(stateOf(o));
}, TIMEOUT_MS);

// remote.c `branch_get_upstream`: `%(upstream)` is empty also for a `branch.main.merge` value that no fetch refspec stores as a remote-tracking branch.
// The branch still has an upstream on the remote, which can hold HEAD, so the review must not report "no upstream".
caseTest(TASK, "FR-100: an upstream that Git does not store as a remote-tracking branch gives rewritesUpstream unknown with the branch.main.merge name, and the amend needs confirmRewrite: true", SHELL, async () => {
  const f = build("untracked", "untracked");
  const o = build("untracked", "untracked");
  expect(text(f, ["for-each-ref", "--format=%(upstream)", "refs/heads/main"])).toBe("\n");
  await withSync("t054-untracked", async (service) => {
    const reg = await open(service, f);
    const r = await reviewed(service, reg);
    expect(r.result.amend).toMatchObject({ upstream: { name: MERGE, present: false }, rewritesUpstream: "unknown" });
    expect(outcome(await commit(service, reg, r, NEW_MESSAGE))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
    expect(commitCalls(service)).toEqual([]);
    expect(outcome(await commit(service, reg, r, NEW_MESSAGE, { amend: true, confirmRewrite: true }))).toEqual(SUCCEEDED);
  });
  git(o, ["commit", "--quiet", "--amend", "--file=-"], [0], NEW_MESSAGE);
  expect(stateOf(f)).toEqual(stateOf(o));
}, TIMEOUT_MS);

caseTest(TASK, "FR-099 and SC-016: Amend equals Git's own commit --amend on a copy in tree, parents, message, and refs, with and without staged changes, and for a merge commit", SHELL, async () => {
  for (const variant of ["message-only", "staged", "merge-commit"] as const) {
    const make = () => {
      const r = build(`equal-${variant}`);
      if (variant === "staged") {
        put(r.dir, "a.txt", "three\n");
        put(r.dir, "b.txt", "new\n");
        git(r, ["add", "--", "a.txt", "b.txt"]);
      }
      if (variant === "merge-commit") {
        git(r, ["checkout", "-q", "-b", "side", "HEAD~1"]);
        put(r.dir, "s.txt", "side\n");
        git(r, ["add", "--", "s.txt"]);
        git(r, ["commit", "-q", "-m", "side"]);
        git(r, ["checkout", "-q", "main"]);
        git(r, ["merge", "-q", "--no-ff", "--no-edit", "side"]);
      }
      return r;
    };
    const f = make();
    const o = make();
    const before = oid(f, "HEAD");
    const parents = text(f, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1);
    expect({ variant, parents: parents.length }).toEqual({ variant, parents: variant === "merge-commit" ? 2 : 1 });
    await withSync(`t054-equal-${variant}`, async (service) => {
      const reg = await open(service, f);
      const r = await reviewed(service, reg);
      expect(r.result.amend?.headOid).toBe(before);
      const from = service.runner.calls.length;
      const done = await commit(service, reg, r, NEW_MESSAGE);
      expect({ variant, ...outcome(done) }).toEqual({ variant, ...SUCCEEDED });
      expect(commitCalls(service, from)).toEqual([[L, "commit", "--quiet", "--amend", "--file=-"]]);
      expect(done.result?.commitOid).toBe(oid(f, "HEAD"));
    });
    git(o, ["commit", "--quiet", "--amend", "--file=-"], [0], NEW_MESSAGE);
    expect({ variant, state: stateOf(f) }).toEqual({ variant, state: stateOf(o) });
    expect(text(f, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1)).toEqual(parents);
    expect(oid(f, "HEAD")).not.toBe(before);
  }
}, TIMEOUT_MS);

caseTest(TASK, "FR-099: a moved HEAD and a moved upstream after the review give STALE_REVIEW, and no commit process starts", SHELL, async () => {
  const f = build("stale", "behind");
  await withSync("t054-stale", async (service) => {
    const reg = await open(service, f);
    const moved = await reviewed(service, reg);
    git(f, ["commit", "-q", "--allow-empty", "-m", "moved"]);
    expect(outcome(await commit(service, reg, moved, NEW_MESSAGE))).toEqual({ state: "failed", code: "STALE_REVIEW" });
    // Data-model §2: the token binds rewritesUpstream, so an upstream that now holds HEAD refuses.
    const upstream = await reviewed(service, reg);
    expect(upstream.result.amend?.rewritesUpstream).toBe(false);
    git(f, ["update-ref", UPSTREAM, "HEAD"]);
    expect(outcome(await commit(service, reg, upstream, NEW_MESSAGE))).toEqual({ state: "failed", code: "STALE_REVIEW" });
    expect(commitCalls(service)).toEqual([]);
  });
}, TIMEOUT_MS);

caseTest(TASK, "FR-098 and contract Δ3: an unborn HEAD gives WORKBENCH_UNAVAILABLE reason unborn, a merge or a rebase gives OPERATION_IN_PROGRESS, and no Git process of the review starts", SHELL, async () => {
  const unborn: WbRepo = { git: gitExe(), dir: join(fixtureDir("t054-unborn"), "repo"), env: {} };
  mkdirSync(unborn.dir, { recursive: true });
  git(unborn, ["init", "-q", "-b", "main"]);
  put(unborn.dir, "a.txt", "a\n");
  git(unborn, ["add", "--", "a.txt"]);
  const repos = { unborn, merge: repoOf(buildWorkbench(gitExe(), "conflict-merge", "t054-merge")), rebase: repoOf(buildWorkbench(gitExe(), "conflict-rebase", "t054-rebase")) };
  await withSync("t054-refusals", async (service) => {
    for (const [name, r] of Object.entries(repos)) {
      const reg = await open(service, r);
      const read = await readOk(service, reg);
      const from = service.runner.calls.length;
      const response = await service.request("reviewCommit", { snapshotId: read.snapshotId, amend: true }, { repositoryId: reg.repositoryId, repositoryGeneration: read.generation });
      expect({ name, ...refused(response) }).toEqual({ name, ...(name === "unborn" ? { state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "unborn" } } : { state: "failed", code: "OPERATION_IN_PROGRESS", result: undefined }) });
      expect({ name, calls: reviewSteps(service, from) }).toEqual({ name, calls: [] });
    }
  });
}, TIMEOUT_MS);

caseTest(TASK, "contract Δ3: a HEAD commit with an encoding header that Git does not treat as UTF-8 gives COMMIT_ENCODING_UNSUPPORTED", SHELL, async () => {
  const f = build("encoding");
  git(f, ["-c", "i18n.commitEncoding=ISO-8859-1", "commit", "-q", "--allow-empty", "-m", "latin"]);
  expect(text(f, ["cat-file", "commit", "HEAD"])).toContain("\nencoding ISO-8859-1\n");
  await withSync("t054-encoding", async (service) => {
    const reg = await open(service, f);
    expect(outcome((await review(service, reg)).response)).toEqual({ state: "failed", code: "COMMIT_ENCODING_UNSUPPORTED" });
  });
}, TIMEOUT_MS);

// githooks(5): `git commit --amend` runs `post-rewrite` with the argument `amend`, beside the commit hooks.
caseTest(TASK, "001 hooks: an approved amend runs the commit hooks and post-rewrite as Git's own amend does; post-rewrite alone needs approval for an amend, but not for a plain commit", SHELL, async () => {
  const EVENTS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite"];
  const withHooks = (tag: string, events: readonly string[]) => {
    const r = build(tag);
    const log = canary(join(r.dir, ".."), "hooks");
    for (const event of events) put(r.dir, `.git/hooks/${event}`, `#!/bin/sh\nexec ${log.command} ${event} "$@"\n`);
    return { r, log: log.log };
  };
  const f = withHooks("hooks", EVENTS);
  const o = withHooks("hooks", EVENTS);
  await withSync("t054-hooks", async (service) => {
    const reg = await open(service, f.r);
    expect((await service.readTrust(reg.repositoryId)).result!.approvalRequired.commit).toBe(true);
    expect((await service.approveTrust(reg.repositoryId, "commit")).state).toBe("succeeded");
    const r = await reviewed(service, reg);
    expect(outcome(await commit(service, reg, r, NEW_MESSAGE))).toEqual(SUCCEEDED);
  });
  git(o.r, ["commit", "--quiet", "--amend", "--file=-"], [0], NEW_MESSAGE);
  expect(readFileSync(f.log, "utf8")).toBe(readFileSync(o.log, "utf8"));
  expect(readFileSync(f.log, "utf8")).toContain("hooks post-rewrite amend\n");
  expect(stateOf(f.r)).toEqual(stateOf(o.r));

  const only = withHooks("post-rewrite", ["post-rewrite"]);
  await withSync("t054-post-rewrite", async (service) => {
    const reg = await open(service, only.r);
    expect((await service.readTrust(reg.repositoryId)).result!.approvalRequired.commit).toBe(false);
    const r = await reviewed(service, reg);
    expect(r.result.disclosure.approvalRequired).toBe(true);
    expect(outcome(await commit(service, reg, r, NEW_MESSAGE))).toEqual({ state: "rejected", code: "TRUST_REQUIRED" });
    expect(commitCalls(service)).toEqual([]);
    put(only.r.dir, "a.txt", "plain\n");
    git(only.r, ["add", "--", "a.txt"]);
    const plain = await reviewed(service, reg, false);
    expect(plain.result.disclosure.approvalRequired).toBe(false);
    expect(outcome(await commit(service, reg, plain, "plain\n", {}))).toEqual(SUCCEEDED);
  });
  expect(existsSync(only.log)).toBe(false);
}, TIMEOUT_MS);
