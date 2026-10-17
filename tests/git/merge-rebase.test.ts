// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T023: `reviewWorkbench` and `runWorkbench` with `merge` and `rebase` (contract Δ3, data-model §2 and §5, plan.md D5 and D6, FR-021 to FR-028, SC-005).
// The oracle is Git's own command on a second build or a copy. The fixed fixture dates make the commit object IDs of both sides equal.

import { expect } from "bun:test";
import { MERGE_MESSAGE_BYTES } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { commit, compare, outcome, reviewOk, SUCCEEDED } from "./hunk-harness";
import { fc, gitOut, gitPaths, gitRun, importStream, markers, refMap, type GitHost } from "./remote-fixtures";
import { caseTest, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { ANY_EXIT, gitExe, hostFor, INTEGRATE_ENV, refreshIndex, register, repoShape, reviewed, subcommandOf, sync, TIMEOUT_MS, withSync } from "./sync-harness";
import { buildWorkbench, type WbFixture, type WbFixtureName } from "./workbench-fixtures";

for (const module of ["merge-rebase", "workbench-review"]) {
  try {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  } catch {
    console.log(`ORIGIN absent src/git-service/${module}.ts`);
  }
}

useFixtureRoot();

const TASK = "T023";
const SHELL = ["shell-double"] as const;
const L = "--no-lazy-fetch";
const READ = [L, "--no-optional-locks", "--literal-pathspecs"];
const COMPLETED = { state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" };
const WITH_EFFECTS = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };
const unavailable = (reason: string) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", reason });

type Source = { scope: string; origin: string } | "default";
interface MergePlan {
  source: { ref: string; oid: string };
  result: "merge" | "squash";
  noFastForward: boolean;
  noCommit: boolean;
  preview: string | null;
  message: string | null;
  facts: { ahead: number; behind: number; fastForward: boolean; mergeFf: { value: string; source: Source } };
}
interface RebasePlan {
  onto: { ref: string; oid: string };
  moved: number;
  rewritten: number;
  held: number;
  forceNote: { trackingRef: string } | null;
  movedBranches: { refs: string[]; more: number } | null;
  autostash: { value: boolean; source: Source };
  autosquash: boolean;
}
interface Review<P> {
  action: string;
  plan: P;
  workbenchToken: string;
  reason?: string;
  unmerged?: number;
}
interface RunResult {
  action: string;
  head: { state: string; target?: string; oid?: string };
  refs: { ref: string; oldObjectId: string | null; newObjectId: string | null }[];
  operationState: string;
  unmerged: number;
  stash: { oid: string } | null;
  outputTail?: string;
}

const MERGE = (ref: string, o: Partial<{ result: "merge" | "squash"; noFastForward: boolean; noCommit: boolean; message: string | null }> = {}) => ({
  action: "merge",
  ref,
  result: "merge",
  noFastForward: false,
  noCommit: false,
  message: null,
  ...o,
});
const REBASE = (ref: string, o: Partial<{ autostash: boolean; autosquash: boolean }> = {}) => ({ action: "rebase", ref, autostash: false, autosquash: false, ...o });

const reviewWb = <P>(service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<Review<P>>> =>
  service.request("reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });

async function tokenOf<P>(service: Service, r: RegistrationResult, payload: object): Promise<Review<P>> {
  const response = await reviewWb<P>(service, r, payload);
  expect({ ...outcome(response), reason: response.result?.reason }).toEqual({ ...SUCCEEDED, reason: undefined });
  expect(typeof response.result!.workbenchToken).toBe("string");
  return response.result!;
}

const runWb = (service: Service, r: RegistrationResult, token: string): Promise<ServiceResponse<RunResult>> =>
  service.request("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });

async function reviewAndRun(service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<RunResult>> {
  return runWb(service, r, (await tokenOf(service, r, payload)).workbenchToken);
}

const refusal = (response: ServiceResponse<{ reason?: string } | undefined>) => ({ state: response.state, code: response.code, reason: response.result?.reason });
const integrateCalls = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate");
// The merge and rebase processes of every policy. A refused review starts none.
const integrations = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => ["merge", "rebase"].includes(subcommandOf(c.arguments) ?? ""));

// HEAD, the commit shape, every ref, the index, the working files, the markers, and the merge message files.
function stateOf(h: GitHost, repo: string) {
  const [mergeMsg, squashMsg, mergeMode] = gitPaths(h, repo, ["MERGE_MSG", "SQUASH_MSG", "MERGE_MODE"]).map((p) => h.read(p)?.toString("utf8") ?? null);
  const headOid = gitRun(h, repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] }).stdout.toString("utf8").trim();
  return { ...repoShape(h, repo), refs: refMap(h, repo), headOid, mergeMsg, squashMsg, mergeMode };
}
const own = (h: GitHost, repo: string, args: string[], allowExit = [0]) => gitRun(h, repo, args, { env: INTEGRATE_ENV, allowExit });
const messageOf = (h: GitHost, repo: string, rev = "HEAD") => {
  const raw = gitOut(h, repo, ["cat-file", "commit", rev]);
  return raw.slice(raw.indexOf("\n\n") + 2);
};
const subjects = (h: GitHost, repo: string, range: string) => gitOut(h, repo, ["log", "--reverse", "--format=%s", range]).split("\n").filter((l) => l !== "");
const count = (h: GitHost, repo: string, args: string[]) => Number(gitOut(h, repo, ["rev-list", "--count", ...args]).trim());

let builds = 0;
// Two builds of one fixture: the first for the service, the second for Git's own command. T001 proves that two builds are equal.
function pair(name: WbFixtureName, tag: string, prepare: (f: WbFixture) => void = () => {}): [WbFixture, WbFixture] {
  const n = ++builds;
  const make = (side: string) => {
    const f = buildWorkbench(gitExe(), name, `t023-${tag}-${n}-${side}`);
    prepare(f);
    return f;
  };
  return [make("app"), make("git")];
}

// The fact (l) history of feature 003: `up` changes `a.txt`, and `main` holds `step a` (`a.txt`) and `step b` (`b.txt`).
// A merge of `up` stops on `a.txt`. A rebase of `main` onto `up` stops at `step a`.
function conflictRepo(h: GitHost, name: string): string {
  const repo = `${h.root}/${name}`;
  gitRun(h, h.root, ["init", "-q", "-b", "main", "--", repo]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
  importStream(h, repo, [
    fc({ mark: 1, message: "base\n", files: { "a.txt": "base\n" } }),
    fc({ mark: 2, ref: "refs/heads/up", message: "up\n", from: 1, files: { "a.txt": "up\n" } }),
    fc({ mark: 3, message: "step a\n", from: 1, files: { "a.txt": "topic\n" } }),
    fc({ mark: 4, message: "step b\n", from: 3, files: { "b.txt": "topic\n" } }),
  ]);
  gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
  return repo;
}

// Repository hooks are repository-controlled, so they need approval before a review (plan.md D12).
async function approved(service: Service, repo: string): Promise<RegistrationResult> {
  const r = await register(service, repo);
  const trust = await service.readTrust(r.repositoryId);
  if (trust.result!.approvalRequired.sync) expect((await service.approveTrust(r.repositoryId, trust.result!.fingerprint, r.generation)).state).toBe("succeeded");
  return r;
}

describeGit("merge and rebase (T023)", () => {
  let copies = 0;
  const copyOf = (h: GitHost, repo: string) => {
    const to = `${h.root}/copy-${++copies}`;
    h.copy(repo, to);
    return refreshIndex(h, to);
  };

  // ---- Merge (plan.md D5) ----

  caseTest(TASK, "FR-021: the merge counts equal rev-list --left-right --count, and merge-base --is-ancestor exit 0 and 1 decide fast-forward", SHELL, async () => {
    const h = hostFor("t023-facts");
    for (const name of ["merge-ff", "merge-diverged"] as const) {
      const [f] = pair(name, "facts");
      const [ahead, behind] = gitOut(h, f.repo, ["rev-list", "--left-right", "--count", "HEAD...refs/heads/topic"]).trim().split("\t").map(Number);
      const exit = gitRun(h, f.repo, ["merge-base", "--is-ancestor", "HEAD", "refs/heads/topic"], { allowExit: [0, 1] }).exitCode;
      await withSync(`t023-facts-${name}`, async (service) => {
        const r = await register(service, f.repo);
        const from = service.runner.calls.length;
        const review = await tokenOf<MergePlan>(service, r, MERGE("refs/heads/topic"));
        expect({ name, source: review.plan.source, facts: review.plan.facts }).toEqual({
          name,
          source: { ref: "refs/heads/topic", oid: f.oids.topic! },
          facts: { ahead: ahead!, behind: behind!, fastForward: exit === 0, mergeFf: { value: "true", source: "default" } },
        });
        const args = service.runner.calls.slice(from).map((c) => c.arguments);
        expect({ name, counts: args.filter((a) => a.includes("--left-right")), ancestor: args.filter((a) => a.includes("--is-ancestor")) }).toEqual({
          name,
          counts: [[...READ, "rev-list", "--left-right", "--count", `HEAD...${f.oids.topic}`]],
          ancestor: [[...READ, "merge-base", "--is-ancestor", "HEAD", f.oids.topic!]],
        });
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "contract Δ3: a merge-base --is-ancestor exit other than 0 and 1 gives GIT_FAILED, and the review issues no token", SHELL, async () => {
    const [f] = pair("merge-diverged", "ancestor-exit");
    await withSync("t023-ancestor-exit", async (service) => {
      const r = await register(service, f.repo);
      service.runner.inject.exit = (call) => (call.arguments.includes("--is-ancestor") ? 128 : undefined);
      const response = await reviewWb(service, r, MERGE("refs/heads/topic"));
      service.runner.inject.exit = undefined;
      expect({ ...outcome(response), token: response.result?.workbenchToken }).toEqual({ state: "failed", code: "GIT_FAILED", token: undefined });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-022 and SC-005: each option and each allowed combination gives the state of Git's own merge with the same option, under the integrate policy", SHELL, async () => {
    const h = hostFor("t023-options");
    const combinations: [WbFixtureName, Parameters<typeof MERGE>[1], string[]][] = [
      ["merge-diverged", {}, []],
      ["merge-diverged", { noFastForward: true }, ["--no-ff"]],
      ["merge-diverged", { noCommit: true }, ["--no-commit"]],
      ["merge-diverged", { noFastForward: true, noCommit: true }, ["--no-ff", "--no-commit"]],
      ["merge-diverged", { result: "squash" }, ["--squash"]],
      ["merge-ff", {}, []],
      ["merge-ff", { noFastForward: true }, ["--no-ff"]],
      ["merge-ff", { noFastForward: true, noCommit: true }, ["--no-ff", "--no-commit"]],
      ["merge-ff", { result: "squash" }, ["--squash"]],
    ];
    for (const [name, options, flags] of combinations) {
      const label = `${name} ${flags.join(" ") || "default"}`;
      const [app, git] = pair(name, "options");
      await withSync(`t023-options-${builds}`, async (service) => {
        const r = await register(service, app.repo);
        const review = await tokenOf<MergePlan>(service, r, MERGE("refs/heads/topic", options));
        const from = service.runner.calls.length;
        const response = await runWb(service, r, review.workbenchToken);
        expect({ label, ...outcome(response) }).toEqual({ label, ...SUCCEEDED });
        const squash = options?.result === "squash";
        // Git's own merge writes the preview without its final LF into MERGE_MSG, so the `-m` item holds no final LF.
        const message = squash ? [] : ["--no-log", "-m", review.plan.preview!.replace(/\n$/, "")];
        expect({ label, calls: integrateCalls(service, from).map((c) => c.arguments) }).toEqual({
          label,
          calls: [[L, "merge", "--no-autostash", "--no-edit", ...flags, ...message, "--end-of-options", "refs/heads/topic"]],
        });
      });
      own(h, git.repo, ["merge", "--no-edit", ...flags, "topic"]);
      expect({ label, state: stateOf(h, app.repo) }).toEqual({ label, state: stateOf(h, git.repo) });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "data-model §5: Squash with No fast-forward, Don't commit, or a message is refused before any Git process", SHELL, async () => {
    const [f] = pair("merge-diverged", "squash-combinations");
    await withSync("t023-squash-combinations", async (service) => {
      const r = await register(service, f.repo);
      for (const extra of [{ noFastForward: true }, { noCommit: true }, { message: "Squash text\n" }]) {
        const from = service.runner.calls.length;
        const response = await reviewWb(service, r, MERGE("refs/heads/topic", { result: "squash", ...extra }));
        expect({ extra, state: response.state, code: response.code }).toEqual({ extra, state: "rejected", code: "INVALID_REQUEST" });
        expect(service.runner.calls.length).toBe(from);
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "plan.md D5: Don't commit with a possible fast-forward needs No fast-forward, and with it the merge equals Git's own merge --no-ff --no-commit", SHELL, async () => {
    const h = hostFor("t023-no-commit-ff");
    const [app, git] = pair("merge-ff", "no-commit-ff");
    await withSync("t023-no-commit-ff", async (service) => {
      const r = await register(service, app.repo);
      const response = await reviewWb(service, r, MERGE("refs/heads/topic", { noCommit: true }));
      expect({ ...outcome(response), token: response.result?.workbenchToken }).toEqual({ state: "failed", code: "INVALID_REQUEST", token: undefined });
      expect(integrations(service)).toEqual([]);
      const done = await reviewAndRun(service, r, MERGE("refs/heads/topic", { noCommit: true, noFastForward: true }));
      expect({ ...outcome(done), operationState: done.result!.operationState, unmerged: done.result!.unmerged }).toEqual({ ...SUCCEEDED, operationState: "merging", unmerged: 0 });
    });
    own(h, git.repo, ["merge", "--no-edit", "--no-ff", "--no-commit", "topic"]);
    expect(stateOf(h, app.repo)).toEqual(stateOf(h, git.repo));
  }, TIMEOUT_MS);

  caseTest(TASK, "plan.md D5: merge.ff=only without a possible fast-forward gives ff-only for Merge commit and Squash; No fast-forward overrides it as in Git's own merge", SHELL, async () => {
    const h = hostFor("t023-ff-only");
    const [app, git] = pair("merge-ff-only", "ff-only");
    await withSync("t023-ff-only", async (service) => {
      const r = await register(service, app.repo);
      for (const result of ["merge", "squash"] as const) {
        const response = await reviewWb(service, r, MERGE("refs/heads/topic", { result }));
        expect({ result, ...refusal(response), token: response.result?.workbenchToken }).toEqual({ result, ...unavailable("ff-only"), token: undefined });
      }
      expect(integrations(service)).toEqual([]);
      const review = await tokenOf<MergePlan>(service, r, MERGE("refs/heads/topic", { noFastForward: true }));
      expect(review.plan.facts.mergeFf).toEqual({ value: "only", source: { scope: "local", origin: "file:.git/config" } });
      expect(outcome(await runWb(service, r, review.workbenchToken))).toEqual(SUCCEEDED);
    });
    own(h, git.repo, ["merge", "--no-edit", "--no-ff", "topic"]);
    expect(stateOf(h, app.repo)).toEqual(stateOf(h, git.repo));
  }, TIMEOUT_MS);

  caseTest(TASK, "F12: the preview equals Git's own merge message, and a merge with the preview or an edited text through --no-log -m commits that message, with and without merge.log", SHELL, async () => {
    const h = hostFor("t023-message");
    const cases: [string, boolean, string, string][] = [
      ["local", false, "refs/heads/topic", "topic"],
      ["local merge.log", true, "refs/heads/topic", "topic"],
      ["remote-tracking", false, "refs/remotes/origin/topic", "origin/topic"],
      ["remote-tracking merge.log", true, "refs/remotes/origin/topic", "origin/topic"],
    ];
    const EDITED = "Edited merge text\n\nSecond paragraph.\n";
    for (const [label, log, ref, short] of cases) {
      const prepare = (f: WbFixture) => void (log && gitRun(h, f.repo, ["config", "merge.log", "true"]));
      const [app, git] = pair("merge-diverged", "message", prepare);
      const [edited, gitEdited] = pair("merge-diverged", "message-edited", prepare);
      own(h, git.repo, ["merge", "--no-edit", short]);
      own(h, gitEdited.repo, ["merge", "--no-edit", "--no-log", "-m", EDITED, short]);
      await withSync(`t023-message-${builds}`, async (service) => {
        const r = await register(service, app.repo);
        const review = await tokenOf<MergePlan>(service, r, MERGE(ref));
        expect({ label, preview: review.plan.preview }).toEqual({ label, preview: messageOf(h, git.repo) });
        expect({ label, ...outcome(await runWb(service, r, review.workbenchToken)) }).toEqual({ label, ...SUCCEEDED });
        const e = await register(service, edited.repo);
        expect({ label, ...outcome(await reviewAndRun(service, e, MERGE(ref, { message: EDITED }))) }).toEqual({ label, ...SUCCEEDED });
      });
      expect({ label, message: messageOf(h, app.repo), state: stateOf(h, app.repo) }).toEqual({ label, message: messageOf(h, git.repo), state: stateOf(h, git.repo) });
      expect({ label, message: messageOf(h, edited.repo), state: stateOf(h, edited.repo) }).toEqual({ label, message: EDITED, state: stateOf(h, gitEdited.repo) });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "contract Δ5: a preview above MERGE_MESSAGE_BYTES gives message-size for Merge commit and no process starts; Squash sends no message; the schema refuses a longer edited message", SHELL, async () => {
    const h = hostFor("t023-message-size");
    // One topic commit whose subject alone is above the bound. `merge.log` puts it into the preview.
    const [f] = pair("merge-diverged", "message-size", (w) => {
      gitRun(h, w.repo, ["config", "merge.log", "true"]);
      const subject = "s".repeat(MERGE_MESSAGE_BYTES + 1);
      const tree = gitOut(h, w.repo, ["rev-parse", "refs/heads/topic^{tree}"]).trim();
      const oid = gitOut(h, w.repo, ["commit-tree", "-p", "refs/heads/topic", "-m", subject, tree]).trim();
      gitRun(h, w.repo, ["update-ref", "refs/heads/topic", oid]);
    });
    await withSync("t023-message-size", async (service) => {
      const r = await register(service, f.repo);
      const response = await reviewWb<MergePlan>(service, r, MERGE("refs/heads/topic"));
      expect({ ...refusal(response), token: response.result?.workbenchToken }).toEqual({ ...unavailable("message-size"), token: undefined });
      expect(await tokenOf<MergePlan>(service, r, MERGE("refs/heads/topic", { message: "Short text\n" }))).toBeDefined();
      const squash = await tokenOf<MergePlan>(service, r, MERGE("refs/heads/topic", { result: "squash" }));
      expect(squash.plan.preview).toBeNull();
      const from = service.runner.calls.length;
      const longer = await reviewWb(service, r, MERGE("refs/heads/topic", { message: "m".repeat(MERGE_MESSAGE_BYTES + 1) }));
      expect({ state: longer.state, code: longer.code, calls: service.runner.calls.length - from }).toEqual({ state: "rejected", code: "INVALID_REQUEST", calls: 0 });
      expect(integrations(service)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "F30: Squash sends no -m, SQUASH_MSG equals Git's own merge --squash, and the later 001 commit takes the commit box text", SHELL, async () => {
    const h = hostFor("t023-squash");
    const [app, git] = pair("merge-diverged", "squash", (f) => void gitRun(h, f.repo, ["config", "merge.log", "true"]));
    const TEXT = "Commit box text\n";
    await withSync("t023-squash", async (service) => {
      const r = await register(service, app.repo);
      const from = service.runner.calls.length;
      expect(outcome(await reviewAndRun(service, r, MERGE("refs/heads/topic", { result: "squash" })))).toEqual(SUCCEEDED);
      expect(integrateCalls(service, from).map((c) => c.arguments)).toEqual([[L, "merge", "--no-autostash", "--no-edit", "--squash", "--end-of-options", "refs/heads/topic"]]);
      own(h, git.repo, ["merge", "--squash", "topic"]);
      expect(stateOf(h, app.repo)).toEqual(stateOf(h, git.repo));
      const committed = await commit(service, r.repositoryId, await reviewOk(service, r.repositoryId), TEXT);
      expect(outcome(committed)).toEqual(SUCCEEDED);
    });
    gitRun(h, git.repo, ["commit", "--quiet", "--file=-"], { input: Buffer.from(TEXT) });
    expect({ message: messageOf(h, app.repo), state: stateOf(h, app.repo) }).toEqual({ message: TEXT, state: stateOf(h, git.repo) });
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-023: a pre-merge-commit hook that rejects leaves the merge as Git's own merge leaves it", SHELL, async () => {
    const h = hostFor("t023-hook");
    const [app, git] = pair("merge-diverged", "hook", (f) => h.write(`${f.repo}/.git/hooks/pre-merge-commit`, "#!/bin/sh\nexit 1\n"));
    await withSync("t023-hook", async (service) => {
      const r = await approved(service, app.repo);
      const response = await reviewAndRun(service, r, MERGE("refs/heads/topic"));
      expect({ ...outcome(response), operationState: response.result!.operationState, tail: typeof response.result!.outputTail }).toEqual({ ...WITH_EFFECTS, operationState: "merging", tail: "string" });
    });
    own(h, git.repo, ["merge", "--no-edit", "topic"], [1]);
    expect(stateOf(h, app.repo)).toEqual(stateOf(h, git.repo));
  }, TIMEOUT_MS);

  caseTest(TASK, "contract Δ2: the merge phase carries no counter, also when a hook prints a Git progress counter", SHELL, async () => {
    const h = hostFor("t023-hook-progress");
    const [f] = pair("merge-diverged", "hook-progress", (w) => h.write(`${w.repo}/.git/hooks/post-merge`, "#!/bin/sh\necho 'hook:  50% (1/2)' >&2\n"));
    await withSync("t023-hook-progress", async (service) => {
      const r = await approved(service, f.repo);
      const review = await tokenOf(service, r, MERGE("refs/heads/topic"));
      const requestId = service.send("runWorkbench", { workbenchToken: review.workbenchToken, start: true }, { repositoryId: r.repositoryId });
      expect(outcome(await service.response(requestId))).toEqual(SUCCEEDED);
      const operationId = await service.operationId(requestId);
      const events = (service.progress as { operationId: string; phase?: string; counters: Record<string, number> }[]).filter((e) => e.operationId === operationId && e.phase === "merge");
      expect({ events: events.length > 0, counters: events.map((e) => e.counters) }).toEqual({ events: true, counters: events.map(() => ({})) });
    });
  }, TIMEOUT_MS);

  // ---- Rebase (plan.md D6) ----

  caseTest(TASK, "F13 and FR-024: the moved count equals the commits of Git's own rebase with patch-same, empty, and merge commits; the held count; the force note of the push destination", SHELL, async () => {
    const h = hostFor("t023-moved");
    const [app, git] = pair("rebase-mix", "moved");
    const up = app.oids.up!;
    const rewritten = count(h, app.repo, [`${up}..HEAD`]);
    const held = rewritten - count(h, app.repo, [`${up}..HEAD`, "--not", "--remotes"]);
    await withSync("t023-moved", async (service) => {
      const r = await register(service, app.repo);
      const review = await tokenOf<RebasePlan>(service, r, REBASE("refs/heads/up"));
      own(h, git.repo, ["rebase", "--no-autostash", "--no-autosquash", "up"]);
      expect(review.plan).toEqual({
        onto: { ref: "refs/heads/up", oid: up },
        moved: subjects(h, git.repo, `${up}..HEAD`).length,
        rewritten,
        held,
        forceNote: { trackingRef: "refs/remotes/origin/topic" },
        movedBranches: null,
        autostash: { value: false, source: "default" },
        autosquash: false,
      });
      expect(held).toBeGreaterThan(0);
      expect(outcome(await runWb(service, r, review.workbenchToken))).toEqual(SUCCEEDED);
    });
    expect(stateOf(h, app.repo)).toEqual(stateOf(h, git.repo));
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-024: a rewritten commit that only another remote-tracking branch holds counts as held and gives no force note", SHELL, async () => {
    const h = hostFor("t023-held");
    const [f] = pair("rebase-mix", "held", (w) => {
      gitRun(h, w.repo, ["update-ref", "refs/remotes/origin/topic", w.oids.base!]);
      gitRun(h, w.repo, ["update-ref", "refs/remotes/fork/topic", w.oids.empty!]);
    });
    await withSync("t023-held", async (service) => {
      const r = await register(service, f.repo);
      const review = await tokenOf<RebasePlan>(service, r, REBASE("refs/heads/up"));
      expect({ held: review.plan.held, forceNote: review.plan.forceNote }).toEqual({ held: count(h, f.repo, [`${f.oids.up}..HEAD`]) - count(h, f.repo, [`${f.oids.up}..HEAD`, "--not", "--remotes"]), forceNote: null });
      expect(review.plan.held).toBeGreaterThan(0);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "F16: under rebase.updateRefs the moved-branch list leaves out the branch of another worktree and equals the refs that Git's own rebase moves", SHELL, async () => {
    const h = hostFor("t023-update-refs");
    const [app, git] = pair("rebase-update-refs", "update-refs");
    const before = refMap(h, git.repo, ["refs/heads"]);
    own(h, git.repo, ["rebase", "--no-autostash", "--no-autosquash", "up"]);
    const after = refMap(h, git.repo, ["refs/heads"]);
    const moved = Object.keys(before).filter((k) => before[k] !== after[k]).sort();
    expect(moved).not.toContain("refs/heads/wt-part");
    await withSync("t023-update-refs", async (service) => {
      const r = await register(service, app.repo);
      const review = await tokenOf<RebasePlan>(service, r, REBASE("refs/heads/up"));
      expect(review.plan.movedBranches).toEqual({ refs: moved, more: 0 });
      expect(outcome(await runWb(service, r, review.workbenchToken))).toEqual(SUCCEEDED);
    });
    expect(stateOf(h, app.repo)).toEqual(stateOf(h, git.repo));
  }, TIMEOUT_MS);

  caseTest(TASK, "F15: Autosquash is false at review also with rebase.autoSquash=true, and each explicit form equals Git's own rebase with that form", SHELL, async () => {
    const h = hostFor("t023-autosquash");
    for (const autosquash of [false, true]) {
      const [app, git] = pair("rebase-fixup", "autosquash", (f) => void gitRun(h, f.repo, ["config", "rebase.autoSquash", "true"]));
      await withSync(`t023-autosquash-${autosquash}`, async (service) => {
        const r = await register(service, app.repo);
        const review = await tokenOf<RebasePlan>(service, r, REBASE("refs/heads/up", { autosquash }));
        expect(review.plan.autosquash).toBe(false);
        expect(outcome(await runWb(service, r, review.workbenchToken))).toEqual(SUCCEEDED);
      });
      own(h, git.repo, ["rebase", autosquash ? "--autosquash" : "--no-autosquash", "up"]);
      expect({ autosquash, state: stateOf(h, app.repo) }).toEqual({ autosquash, state: stateOf(h, git.repo) });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-025: Autostash starts from rebase.autoStash and names its scope and file", SHELL, async () => {
    const h = hostFor("t023-autostash");
    for (const [label, value, source] of [
      ["unset", false, "default"],
      ["local true", true, { scope: "local", origin: "file:.git/config" }],
    ] as [string, boolean, Source][]) {
      const [f] = pair("rebase-mix", "autostash", (w) => void (value && gitRun(h, w.repo, ["config", "rebase.autoStash", "true"])));
      await withSync(`t023-autostash-${builds}`, async (service) => {
        const r = await register(service, f.repo);
        expect({ label, autostash: (await tokenOf<RebasePlan>(service, r, REBASE("refs/heads/up"))).plan.autostash }).toEqual({ label, autostash: { value, source } });
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "F14: a tracked change without Autostash gives dirty-tree before any process; with Autostash the rebase equals Git's own rebase --autostash", SHELL, async () => {
    const h = hostFor("t023-dirty");
    const [app, git] = pair("rebase-mix", "dirty", (f) => h.write(`${f.repo}/f.txt`, "f changed\n"));
    await withSync("t023-dirty", async (service) => {
      const r = await register(service, app.repo);
      const response = await reviewWb(service, r, REBASE("refs/heads/up"));
      expect({ ...refusal(response), token: response.result?.workbenchToken }).toEqual({ ...unavailable("dirty-tree"), token: undefined });
      expect(integrations(service)).toEqual([]);
      const done = await reviewAndRun(service, r, REBASE("refs/heads/up", { autostash: true }));
      expect({ ...outcome(done), stash: done.result!.stash }).toEqual({ ...SUCCEEDED, stash: null });
    });
    own(h, git.repo, ["rebase", "--autostash", "--no-autosquash", "up"]);
    expect(stateOf(h, app.repo)).toEqual(stateOf(h, git.repo));
  }, TIMEOUT_MS);

  caseTest(TASK, "plan.md D6: an autostash that Git cannot reapply names the new stash commit, and the state equals Git's own rebase --autostash", SHELL, async () => {
    const h = hostFor("t023-autostash-conflict");
    // `up-1` adds `u.txt`. A staged addition with other bytes conflicts with it when Git applies the autostash.
    const [app, git] = pair("rebase-mix", "autostash-conflict", (f) => {
      h.write(`${f.repo}/u.txt`, "mine\n");
      gitRun(h, f.repo, ["add", "--", "u.txt"]);
    });
    await withSync("t023-autostash-conflict", async (service) => {
      const r = await register(service, app.repo);
      const done = await reviewAndRun(service, r, REBASE("refs/heads/up", { autostash: true }));
      const stash = gitOut(h, app.repo, ["rev-parse", "--verify", "-q", "refs/stash"]).trim();
      expect({ ...outcome(done), stash: done.result!.stash }).toEqual({ ...COMPLETED, stash: { oid: stash } });
    });
    own(h, git.repo, ["rebase", "--autostash", "--no-autosquash", "up"]);
    expect(stateOf(h, app.repo)).toEqual(stateOf(h, git.repo));
  }, TIMEOUT_MS);

  // ---- Both (FR-028) ----

  caseTest(TASK, "FR-028: merge and rebase are unavailable for a detached HEAD, an unborn branch, the current branch, and an operation in progress; unmerged entries give CONFLICTED with the count", SHELL, async () => {
    const h = hostFor("t023-unavailable");
    const [detached] = pair("merge-diverged", "detached", (f) => void gitRun(h, f.repo, ["checkout", "-q", "--detach"]));
    const [current] = pair("merge-diverged", "current");
    const unborn = `${h.root}/unborn`;
    gitRun(h, h.root, ["init", "-q", "-b", "main", "--", unborn]);
    const merging = conflictRepo(h, "merging");
    own(h, merging, ["merge", "--no-edit", "up"], [1]);
    const rebasing = conflictRepo(h, "rebasing");
    own(h, rebasing, ["rebase", "up"], [1]);
    const squashed = conflictRepo(h, "squashed");
    own(h, squashed, ["merge", "--squash", "up"], [1]);
    const cases: [string, string, string, { state: string; code: string; reason: string | undefined }][] = [
      ["detached", detached.repo, "refs/heads/topic", unavailable("detached")],
      ["unborn", unborn, "refs/heads/topic", unavailable("unborn")],
      ["current branch", current.repo, "refs/heads/main", unavailable("same-branch")],
      ["merging", merging, "refs/heads/up", { state: "failed", code: "OPERATION_IN_PROGRESS", reason: undefined }],
      ["rebasing", rebasing, "refs/heads/up", { state: "failed", code: "OPERATION_IN_PROGRESS", reason: undefined }],
    ];
    await withSync("t023-unavailable", async (service) => {
      for (const [label, repo, ref, expected] of cases) {
        const r = await register(service, repo);
        for (const payload of [MERGE(ref), REBASE(ref)]) {
          const response = await reviewWb(service, r, payload);
          expect({ label, action: payload.action, ...refusal(response), token: response.result?.workbenchToken }).toEqual({ label, action: payload.action, ...expected, token: undefined });
        }
      }
      const r = await register(service, squashed);
      for (const payload of [MERGE("refs/heads/up"), REBASE("refs/heads/up")]) {
        const response = await reviewWb(service, r, payload);
        expect({ action: payload.action, state: response.state, code: response.code, unmerged: response.result?.unmerged }).toEqual({ action: payload.action, state: "failed", code: "CONFLICTED", unmerged: 1 });
      }
      expect(integrations(service)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "data-model §2: a source ref that moved after the review gives STALE_REVIEW, and no process starts", SHELL, async () => {
    const h = hostFor("t023-stale");
    const [f] = pair("merge-diverged", "stale");
    await withSync("t023-stale", async (service) => {
      const r = await register(service, f.repo);
      for (const payload of [MERGE("refs/heads/topic"), REBASE("refs/heads/topic")]) {
        const review = await tokenOf(service, r, payload);
        gitRun(h, f.repo, ["update-ref", "refs/heads/topic", payload.action === "merge" ? f.oids["topic-1"]! : f.oids.topic!]);
        const from = service.runner.calls.length;
        const response = await runWb(service, r, review.workbenchToken);
        expect({ action: payload.action, ...outcome(response) }).toEqual({ action: payload.action, state: "failed", code: "STALE_REVIEW" });
        expect(integrations(service, from)).toEqual([]);
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "contract §8 token invalidation: a refresh read ends the unused workbench token, so runWorkbench gives UNKNOWN_TARGET and no process starts", SHELL, async () => {
    const [f] = pair("merge-diverged", "invalidated");
    await withSync("t023-invalidated", async (service) => {
      const r = await register(service, f.repo);
      const review = await tokenOf(service, r, MERGE("refs/heads/topic"));
      expect(outcome(await service.readWorkspace(r.repositoryId, { refresh: true, check: "full" }, r.generation))).toEqual(SUCCEEDED);
      const from = service.runner.calls.length;
      expect((await runWb(service, r, review.workbenchToken)).code).toBe("UNKNOWN_TARGET");
      expect(integrations(service, from)).toEqual([]);
    });
  }, TIMEOUT_MS);

  // ---- Stops with conflicts and the 003 actions (FR-023, FR-027) ----

  caseTest(TASK, "FR-023: a merge that stops with conflicts leaves the markers of Git's own merge, and the 003 Abort, and Mark resolved with Continue, finish it as Git's own commands do", SHELL, async () => {
    const h = hostFor("t023-merge-stop");
    for (const finish of ["abort", "continue"] as const) {
      const repo = conflictRepo(h, `merge-${finish}`);
      const oracle = copyOf(h, repo);
      await withSync(`t023-merge-stop-${finish}`, async (service) => {
        const r = await register(service, repo);
        const stopped = await reviewAndRun(service, r, MERGE("refs/heads/up"));
        expect({ finish, ...outcome(stopped), operationState: stopped.result!.operationState, unmerged: stopped.result!.unmerged }).toEqual({ finish, ...WITH_EFFECTS, operationState: "merging", unmerged: 1 });
        own(h, oracle, ["merge", "--no-edit", "up"], [1]);
        // Contract gap: the full-ref argv of plan.md D5 labels the conflict side `refs/heads/up`, where Git's own `git merge up` writes `up`.
        expect(h.read(`${repo}/a.txt`)!.toString("utf8")).toBe(h.read(`${oracle}/a.txt`)!.toString("utf8").replace(">>>>>>> up\n", ">>>>>>> refs/heads/up\n"));
        const [app, git] = [stateOf(h, repo), stateOf(h, oracle)];
        expect({ finish, state: { ...app, files: { ...app.files, "a.txt": "label" } } }).toEqual({ finish, state: { ...git, files: { ...git.files, "a.txt": "label" } } });
        if (finish === "continue") {
          h.write(`${repo}/a.txt`, "resolved\n");
          h.write(`${oracle}/a.txt`, "resolved\n");
          const c = await compare(service, r.repositoryId, "a.txt", "conflicted");
          const resolved = await service.request("applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction: "resolve" }, { repositoryId: r.repositoryId, repositoryGeneration: c.read.generation });
          expect(outcome(resolved)).toEqual(SUCCEEDED);
          own(h, oracle, ["add", "--", "a.txt"]);
        }
        expect({ finish, ...outcome(await sync(service, r, (await reviewed(service, r, { action: finish })).syncReviewToken)) }).toEqual({ finish, ...SUCCEEDED });
      });
      own(h, oracle, finish === "abort" ? ["merge", "--abort"] : ["commit", "--quiet"]);
      expect({ finish, state: stateOf(h, repo) }).toEqual({ finish, state: stateOf(h, oracle) });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-027: a rebase that stops with conflicts leaves the markers of Git's own rebase, and the 003 Abort, Skip, and Mark resolved with Continue finish it as Git's own commands do", SHELL, async () => {
    const h = hostFor("t023-rebase-stop");
    for (const finish of ["abort", "skip", "continue"] as const) {
      const repo = conflictRepo(h, `rebase-${finish}`);
      const oracle = copyOf(h, repo);
      await withSync(`t023-rebase-stop-${finish}`, async (service) => {
        const r = await register(service, repo);
        const stopped = await reviewAndRun(service, r, REBASE("refs/heads/up"));
        expect({ finish, ...outcome(stopped), operationState: stopped.result!.operationState, unmerged: stopped.result!.unmerged }).toEqual({ finish, ...WITH_EFFECTS, operationState: "rebasing", unmerged: 1 });
        own(h, oracle, ["rebase", "--no-autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"], [1]);
        expect({ finish, state: stateOf(h, repo) }).toEqual({ finish, state: stateOf(h, oracle) });
        if (finish === "continue") {
          h.write(`${repo}/a.txt`, "resolved\n");
          h.write(`${oracle}/a.txt`, "resolved\n");
          const c = await compare(service, r.repositoryId, "a.txt", "conflicted");
          const resolved = await service.request("applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction: "resolve" }, { repositoryId: r.repositoryId, repositoryGeneration: c.read.generation });
          expect(outcome(resolved)).toEqual(SUCCEEDED);
          own(h, oracle, ["add", "--", "a.txt"]);
        }
        expect({ finish, ...outcome(await sync(service, r, (await reviewed(service, r, { action: finish })).syncReviewToken)) }).toEqual({ finish, ...SUCCEEDED });
      });
      own(h, oracle, ["rebase", `--${finish}`], ANY_EXIT);
      expect({ finish, state: stateOf(h, repo) }).toEqual({ finish, state: stateOf(h, oracle) });
    }
  }, TIMEOUT_MS);

  // ---- Configuration that the review cannot bind, and trust ----

  caseTest(TASK, "plan.md D5: branch.<current>.mergeoptions with any value makes Merge and Squash unavailable with merge-options; Rebase stays available", SHELL, async () => {
    const h = hostFor("t023-merge-options");
    for (const value of ["--no-ff", ""]) {
      const [f] = pair("merge-diverged", "merge-options", (w) => void gitRun(h, w.repo, ["config", "branch.main.mergeOptions", value]));
      await withSync(`t023-merge-options-${builds}`, async (service) => {
        const r = await register(service, f.repo);
        for (const result of ["merge", "squash"] as const) {
          const response = await reviewWb(service, r, MERGE("refs/heads/topic", { result }));
          expect({ value, result, ...refusal(response), token: response.result?.workbenchToken }).toEqual({ value, result, ...unavailable("merge-options"), token: undefined });
        }
        expect(integrations(service)).toEqual([]);
        expect((await tokenOf(service, r, REBASE("refs/heads/topic"))).workbenchToken).toBeDefined();
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "plan.md D5: Squash with merge.ff=false gives squash-no-ff before any process, because Git's own merge --squash refuses it with exit 128", SHELL, async () => {
    const h = hostFor("t023-squash-no-ff");
    const [app, git] = pair("merge-diverged", "squash-no-ff", (f) => void gitRun(h, f.repo, ["config", "merge.ff", "false"]));
    await withSync("t023-squash-no-ff", async (service) => {
      const r = await register(service, app.repo);
      const response = await reviewWb(service, r, MERGE("refs/heads/topic", { result: "squash" }));
      expect({ ...refusal(response), token: response.result?.workbenchToken }).toEqual({ ...unavailable("squash-no-ff"), token: undefined });
      expect(integrations(service)).toEqual([]);
    });
    expect(own(h, git.repo, ["merge", "--squash", "topic"], ANY_EXIT).exitCode).toBe(128);
    expect(stateOf(h, app.repo)).toEqual(stateOf(h, git.repo));
  }, TIMEOUT_MS);

  caseTest(TASK, "plan.md D6: a rebase.autoStash, rebase.updateRefs, or rebase.rebaseMerges value that Git's own rebase stops on gives invalid-config before any process", SHELL, async () => {
    const h = hostFor("t023-invalid-config");
    for (const key of ["rebase.autoStash", "rebase.updateRefs", "rebase.rebaseMerges"]) {
      const [app, git] = pair("rebase-mix", "invalid-config", (f) => void gitRun(h, f.repo, ["config", key, "maybe"]));
      await withSync(`t023-invalid-config-${builds}`, async (service) => {
        const r = await register(service, app.repo);
        const response = await reviewWb(service, r, REBASE("refs/heads/up"));
        expect({ key, ...refusal(response), token: response.result?.workbenchToken }).toEqual({ key, ...unavailable("invalid-config"), token: undefined });
        expect(integrations(service)).toEqual([]);
      });
      expect({ key, exit: own(h, git.repo, ["rebase", "up"], ANY_EXIT).exitCode }).toEqual({ key, exit: 128 });
      expect({ key, state: stateOf(h, app.repo) }).toEqual({ key, state: stateOf(h, git.repo) });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "feature 003 plan.md D7: a git am stop (rebase-apply/applying) is no known operation, so merge and rebase give unknown-operation", SHELL, async () => {
    const h = hostFor("t023-unknown");
    const repo = conflictRepo(h, "am");
    gitRun(h, repo, ["am", "--3way"], { input: Buffer.from(gitOut(h, repo, ["format-patch", "-1", "--stdout", "up"])), allowExit: ANY_EXIT });
    expect(markers(h, repo)).toEqual(["rebase-apply", "rebase-apply/applying"]);
    await withSync("t023-unknown", async (service) => {
      const r = await register(service, repo);
      for (const payload of [MERGE("refs/heads/up"), REBASE("refs/heads/up")]) {
        const response = await reviewWb(service, r, payload);
        expect({ action: payload.action, ...refusal(response), token: response.result?.workbenchToken }).toEqual({ action: payload.action, ...unavailable("unknown-operation"), token: undefined });
      }
      expect(integrations(service)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "git-status(1): with status.showStash=true the `# stash` header is no tracked change, so a clean tree rebases and a changed tree gives dirty-tree", SHELL, async () => {
    const h = hostFor("t023-show-stash");
    const [f] = pair("rebase-mix", "show-stash", (w) => {
      gitRun(h, w.repo, ["config", "status.showStash", "true"]);
      h.write(`${w.repo}/f.txt`, "stashed\n");
      gitRun(h, w.repo, ["stash", "push", "-q"]);
    });
    expect(gitRun(h, f.repo, ["status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=all"]).stdout.toString("latin1")).toBe("# stash 1\0");
    await withSync("t023-show-stash", async (service) => {
      const r = await register(service, f.repo);
      expect((await tokenOf(service, r, REBASE("refs/heads/up"))).workbenchToken).toBeDefined();
      h.write(`${f.repo}/f.txt`, "changed\n");
      expect(refusal(await reviewWb(service, r, REBASE("refs/heads/up")))).toEqual(unavailable("dirty-tree"));
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "plan.md D12 and contract Δ7: a repository merge driver needs approval before the review, and after approval it runs as in Git's own merge", SHELL, async () => {
    const h = hostFor("t023-driver");
    const [app, git] = pair("merge-driver", "driver");
    const log = `${app.root}/canaries/merge-driver.log`;
    await withSync("t023-driver", async (service) => {
      const r = await register(service, app.repo);
      const refused = await reviewWb(service, r, MERGE("refs/heads/topic"));
      expect({ ...outcome(refused), token: refused.result?.workbenchToken }).toEqual({ state: "failed", code: "TRUST_REQUIRED", token: undefined });
      expect({ calls: integrations(service), log: h.read(log) }).toEqual({ calls: [], log: null });
      const trust = await service.readTrust(r.repositoryId);
      expect((await service.approveTrust(r.repositoryId, trust.result!.fingerprint, r.generation)).state).toBe("succeeded");
      expect(outcome(await reviewAndRun(service, r, MERGE("refs/heads/topic")))).toEqual(SUCCEEDED);
    });
    own(h, git.repo, ["merge", "--no-edit", "topic"]);
    const runs = (h.read(log)?.toString("utf8") ?? "").split("\n").filter((l) => l !== "").length;
    expect({ runs, state: stateOf(h, app.repo) }).toEqual({ runs: 1, state: stateOf(h, git.repo) });
  }, TIMEOUT_MS);
});
