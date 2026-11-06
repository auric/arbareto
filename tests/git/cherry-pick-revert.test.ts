// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T009: `reviewWorkbench` and `runWorkbench` with `cherry-pick` and `revert-commit` (feature 010 contract Δ3, data-model §2 to §6, plan.md D5, SC-003, SC-007).
// The oracle is Git's own command on a copy. The fixed fixture dates make the commit object IDs of both sides equal. No message text decides.
// Control: drop the `-m` item; the merge case must fail.

import { expect } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { fc, gitOut, gitPaths, gitRun, importStream, markers, refMap, type GitHost } from "./remote-fixtures";
import type { RecordedCall } from "./bun-runner";
import { caseTest, keepConfigs, siblingDeadline, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { ANY_EXIT, hostFor, INTEGRATE_ENV, native, refreshIndex, register, repoShape, TIMEOUT_MS, until, withSync as syncService } from "./sync-harness";
import { hookEvents, logHooks } from "./workbench-fixtures";

// FR-005: each case keeps the bytes of every configuration file of the repositories that it registers.
const withSync = (name: string, body: (service: Service) => Promise<void>, options?: Parameters<typeof syncService>[2]) => syncService(name, (service) => keepConfigs(service, body), options);

for (const module of ["commit-actions", "workbench-review"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T009";
const SIBLING_TIMEOUT_MS = 60_000;
const SHELL = ["shell-double"] as const;
const L = "--no-lazy-fetch";
const MAIN = "refs/heads/main";
const SUCCEEDED = { state: "succeeded", code: undefined };
const WITH_EFFECTS = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const refusal = (r: ServiceResponse<unknown>) => ({ ...outcome(r), result: r.result });
const unavailable = (reason: string, extra: object = {}) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason, ...extra } });

type Action = "cherry-pick" | "revert-commit";
interface PickPlan {
  commit: string;
  parents: { oid: string; subject: string | null }[];
  mainline: number | null;
  branch: string;
}
interface Reviewed {
  action: string;
  plan: PickPlan;
  workbenchToken: string;
}
interface PickRun {
  action: Action;
  head: { state: string; target?: string; oid?: string };
  refs: { ref: string }[];
  operationState: string;
  unmerged: number;
  outputTail?: string;
}

const PICK = (action: Action, commit: string, mainline: number | null = null) => ({ action, commit, mainline });
const review = (service: Service, r: RegistrationResult, payload: object) => service.request<Reviewed>("reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });

async function reviewed(service: Service, r: RegistrationResult, payload: object): Promise<Reviewed> {
  const response = await review(service, r, payload);
  expect({ payload, ...outcome(response), result: response.state === "succeeded" ? "result" : response.result }).toEqual({ payload, ...SUCCEEDED, result: "result" });
  expect(typeof response.result!.workbenchToken).toBe("string");
  return response.result!;
}

const run = async (service: Service, r: RegistrationResult, payload: object) => service.response<PickRun>(sendRun(service, r, (await reviewed(service, r, payload)).workbenchToken));
const steps = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [...c.arguments]);
const isStep = (call: { arguments: readonly string[] }) => call.arguments[1] === "cherry-pick" || call.arguments[1] === "revert";
// SC-010b: the `conflicted` read, the `detachCommit` read, and the parent subjects read of the review.
const isIndexRead = (call: { arguments: readonly string[] }) => call.arguments.includes("ls-files") && call.arguments.includes("--stage");
const batchInput = (call: { arguments: readonly string[]; input?: Uint8Array }) => (call.arguments.includes("cat-file") && call.input !== undefined ? Buffer.from(call.input).toString("latin1") : "");
const isDetachOf = (oid: string) => (call: { arguments: readonly string[]; input?: Uint8Array }) => batchInput(call) === `info ${oid}^{commit}\0`;
const isSubjects = (call: { arguments: readonly string[]; input?: Uint8Array }) => batchInput(call).startsWith("contents ");
// The most calls that ran at once. A call runs from `at` to its exit.
const peak = (calls: readonly RecordedCall[]) => Math.max(...calls.map((c) => calls.filter((d) => d.at <= c.at && c.at < d.at + (d.durationMs ?? Infinity)).length));

const stateOf = (h: GitHost, repo: string) => ({ ...repoShape(h, repo), refs: refMap(h, repo), headOid: gitRun(h, repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] }).stdout.toString("utf8").trim() });
// Git's own command of each action with the step options of plan.md D5.
const own = (action: Action, commit: string, mainline: number | null = null) => [action === "cherry-pick" ? "cherry-pick" : "revert", ...(action === "revert-commit" ? ["--no-edit"] : []), ...(mainline === null ? [] : ["-m", String(mainline)]), commit];

type Labels = "base" | "m1" | "m2" | "m3" | "t1" | "t2" | "s1" | "x1" | "merge" | "root" | "dup";
interface Fixture {
  repo: string;
  c: Record<Labels, string>;
}

// main: base → m1 (b.txt) → m2 (d.txt) → m3 (b.txt). topic: t1 (t.txt) → t2 (b.txt). side: s1, then the merge of x1.
// `root` is a second history. `dup` adds the d.txt of m2 again outside main (research.md R2 P6).
function build(h: GitHost, name: string, extra: Buffer[] = []): Fixture {
  const repo = `${h.root}/${name}`;
  gitRun(h, h.root, ["init", "-q", "-b", "main", "--", repo]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
  const marks = importStream(h, repo, [
    fc({ mark: 1, message: "base\n", files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" } }),
    fc({ mark: 2, message: "m1\n", from: 1, files: { "b.txt": "b main\n" } }),
    fc({ mark: 3, message: "m2\n", from: 2, files: { "d.txt": "d\n" } }),
    fc({ mark: 4, message: "m3\n", from: 3, files: { "b.txt": "b main3\n" } }),
    fc({ mark: 5, ref: "refs/heads/topic", message: "t1\n", from: 1, files: { "t.txt": "t\n" } }),
    fc({ mark: 6, ref: "refs/heads/topic", message: "t2\n", from: 5, files: { "b.txt": "b topic\n" } }),
    fc({ mark: 7, ref: "refs/heads/side", message: "s1\n", from: 1, files: { "s.txt": "s\n" } }),
    fc({ mark: 8, ref: "refs/heads/xbr", message: "x1\n", from: 1, files: { "x.txt": "x\n" } }),
    fc({ mark: 9, ref: "refs/heads/side", message: "merge x1\n", from: 7, merge: [8], files: { "x.txt": "x\n" } }),
    fc({ mark: 10, ref: "refs/heads/root", message: "root\n", files: { "r.txt": "r\n" } }),
    fc({ mark: 11, ref: "refs/heads/dup", message: "dup\n", from: 1, files: { "d.txt": "d\n" } }),
    ...extra,
  ]);
  gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
  const labels: Labels[] = ["base", "m1", "m2", "m3", "t1", "t2", "s1", "x1", "merge", "root", "dup"];
  return { repo, c: Object.fromEntries(labels.map((l, i) => [l, marks.get(i + 1)!])) as Record<Labels, string> };
}

async function approved(service: Service, repo: string): Promise<RegistrationResult> {
  const r = await register(service, repo);
  const trust = await service.readTrust(r.repositoryId);
  if (trust.result!.approvalRequired.workbench) expect((await service.approveTrust(r.repositoryId, "cherry-pick")).state).toBe("succeeded");
  return r;
}

describeGit("cherry-pick commit and revert commit (T009)", () => {
  let copies = 0;
  const copyOf = (h: GitHost, repo: string) => {
    const to = `${h.root}/copy-${++copies}`;
    h.copy(repo, to);
    return refreshIndex(h, to);
  };

  interface OracleCase {
    name: string;
    action: Action;
    commit: (c: Fixture["c"]) => string;
    mainline?: number;
    // Runs before the copy, on the fixture.
    prepare?: (h: GitHost, f: Fixture) => void;
    expect: { state: string; code: string | undefined };
    operationState: string;
    unmerged: number;
    tail: boolean;
  }

  // One fixture per case. The service runs the action; Git's own command runs on a copy; both states must be equal.
  async function oracle(tag: string, cases: OracleCase[]): Promise<void> {
    const h = hostFor(tag);
    for (const k of cases) {
      const f = build(h, k.name.replaceAll(" ", "-"));
      k.prepare?.(h, f);
      const o = copyOf(h, f.repo);
      const head = gitOut(h, f.repo, ["symbolic-ref", "HEAD"]).trim();
      const oid = gitOut(h, f.repo, ["rev-parse", "HEAD"]).trim();
      const commit = k.commit(f.c);
      await withSync(`${tag}-${copies}`, async (service) => {
        const r = await approved(service, f.repo);
        const rv = await reviewed(service, r, PICK(k.action, commit, k.mainline ?? null));
        expect({ name: k.name, branch: rv.plan.branch, mainline: rv.plan.mainline }).toEqual({ name: k.name, branch: head, mainline: k.mainline ?? null });
        const from = service.runner.calls.length;
        const response = await service.response<PickRun>(sendRun(service, r, rv.workbenchToken));
        expect({ name: k.name, steps: steps(service, from) }).toEqual({ name: k.name, steps: [[L, ...own(k.action, commit, k.mainline ?? null)]] });
        expect({ name: k.name, ...outcome(response) }).toEqual({ name: k.name, ...k.expect });
        const result = response.result!;
        const now = gitOut(h, f.repo, ["rev-parse", "HEAD"]).trim();
        expect({ name: k.name, result: { ...result, outputTail: typeof result.outputTail } }).toEqual({
          name: k.name,
          result: { action: k.action, head: { state: "branch", target: head, oid: now }, refs: now === oid ? [] : [{ ref: head }], operationState: k.operationState, unmerged: k.unmerged, outputTail: k.tail ? "string" : "undefined" },
        });
      });
      gitRun(h, o, own(k.action, commit, k.mainline ?? null), { env: INTEGRATE_ENV, allowExit: ANY_EXIT });
      expect({ name: k.name, state: stateOf(h, f.repo) }).toEqual({ name: k.name, state: stateOf(h, o) });
    }
  }

  caseTest(TASK, "SC-003 and FR-053: a clean pick and revert, a pick and a revert conflict, and a root commit equal Git's own command on a copy", SHELL, () =>
    oracle("t009-basic", [
      { name: "clean pick", action: "cherry-pick", commit: (c) => c.t1, expect: SUCCEEDED, operationState: "normal", unmerged: 0, tail: false },
      { name: "clean revert", action: "revert-commit", commit: (c) => c.m2, expect: SUCCEEDED, operationState: "normal", unmerged: 0, tail: false },
      { name: "pick conflict", action: "cherry-pick", commit: (c) => c.t2, expect: WITH_EFFECTS, operationState: "cherry-picking", unmerged: 1, tail: false },
      { name: "revert conflict", action: "revert-commit", commit: (c) => c.m1, expect: WITH_EFFECTS, operationState: "reverting", unmerged: 1, tail: false },
      // Research.md R2 P12 and P5: Git picks a root commit of another history and reverts a root commit.
      { name: "root pick", action: "cherry-pick", commit: (c) => c.root, expect: SUCCEEDED, operationState: "normal", unmerged: 0, tail: false },
      { name: "root revert", action: "revert-commit", commit: (c) => c.root, prepare: (h, f) => gitRun(h, f.repo, ["checkout", "-q", "root"]), expect: SUCCEEDED, operationState: "normal", unmerged: 0, tail: false },
    ]), TIMEOUT_MS);

  caseTest(TASK, "SC-003 and FR-050: a merge commit with -m 1 and -m 2 equals Git's own command on a copy, and the plan names both parents with their subjects", SHELL, async () => {
    await oracle("t009-merge", [
      { name: "pick merge m1", action: "cherry-pick", commit: (c) => c.merge, mainline: 1, expect: SUCCEEDED, operationState: "normal", unmerged: 0, tail: false },
      { name: "pick merge m2", action: "cherry-pick", commit: (c) => c.merge, mainline: 2, expect: SUCCEEDED, operationState: "normal", unmerged: 0, tail: false },
      { name: "revert merge m1", action: "revert-commit", commit: (c) => c.merge, mainline: 1, prepare: (h, f) => gitRun(h, f.repo, ["checkout", "-q", "side"]), expect: SUCCEEDED, operationState: "normal", unmerged: 0, tail: false },
      { name: "revert merge m2", action: "revert-commit", commit: (c) => c.merge, mainline: 2, prepare: (h, f) => gitRun(h, f.repo, ["checkout", "-q", "side"]), expect: SUCCEEDED, operationState: "normal", unmerged: 0, tail: false },
    ]);
    const h = hostFor("t009-merge-plan");
    const f = build(h, "plan");
    await withSync("t009-merge-plan", async (service) => {
      const r = await approved(service, f.repo);
      const parents = [{ oid: f.c.s1, subject: "s1" }, { oid: f.c.x1, subject: "x1" }];
      for (const action of ["cherry-pick", "revert-commit"] as const) {
        expect((await reviewed(service, r, PICK(action, f.c.merge, 2))).plan).toEqual({ commit: f.c.merge, parents, mainline: 2, branch: MAIN });
        // A pick of m2 refuses `already-on-branch`, so the pick plan takes t2.
        const [one, parent]: [string, { oid: string; subject: string }] = action === "cherry-pick" ? [f.c.t2, { oid: f.c.t1, subject: "t1" }] : [f.c.m2, { oid: f.c.m1, subject: "m1" }];
        expect((await reviewed(service, r, PICK(action, one))).plan).toEqual({ commit: one, parents: [parent], mainline: null, branch: MAIN });
        expect((await reviewed(service, r, PICK(action, f.c.root))).plan.parents).toEqual([]);
        // Research.md R2 P7 and plan.md D5 read 5: Git refuses a merge without -m, so the review names the parents first.
        expect({ action, ...refusal(await review(service, r, PICK(action, f.c.merge))) }).toEqual({ action, ...unavailable("mainline-needed", { parents }) });
        expect({ action, ...refusal(await review(service, r, PICK(action, f.c.t1, 1))) }).toEqual({ action, ...unavailable("not-merge") });
        expect({ action, ...refusal(await review(service, r, PICK(action, f.c.root, 1))) }).toEqual({ action, ...unavailable("not-merge") });
        expect({ action, ...refusal(await review(service, r, PICK(action, f.c.merge, 3))) }).toEqual({ action, state: "failed", code: "INVALID_REQUEST", result: undefined });
      }
      expect(steps(service)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-003 and FR-053: an empty pick (P6) and a signing failure (P11) stop with no unmerged entry, give failed-with-effects with the output tail, and equal Git's own command on a copy", SHELL, async () => {
    await oracle("t009-stops", [
      { name: "empty pick", action: "cherry-pick", commit: (c) => c.dup, expect: WITH_EFFECTS, operationState: "cherry-picking", unmerged: 0, tail: true },
      {
        name: "signing failure",
        action: "cherry-pick",
        commit: (c) => c.t1,
        prepare: (h, f) => {
          const signer = `${h.root}/signer.sh`;
          h.write(signer, "#!/bin/sh\ncat > /dev/null\nexit 1\n");
          gitRun(h, f.repo, ["config", "commit.gpgSign", "true"]);
          gitRun(h, f.repo, ["config", "gpg.program", signer]);
        },
        expect: WITH_EFFECTS,
        operationState: "cherry-picking",
        unmerged: 0,
        tail: true,
      },
    ]);
  }, TIMEOUT_MS);

  caseTest(TASK, "FR-051: detached, unborn, CONFLICTED, already-on-branch, more than 64 parents, mainline-needed for exactly 64 parents, UNKNOWN_TARGET, and dirty-tree for each P10 case refuse before any step; every byte stays", SHELL, async () => {
    const h = hostFor("t009-refusals");
    // 65 commits and one commit with all 65 as parents. Fast-import writes the parents in the order of `from` and `merge`.
    const many = Array.from({ length: 65 }, (_, i) => fc({ mark: 20 + i, ref: `refs/heads/p${i}`, message: `p${i}\n`, from: 1, files: { [`p${i}.txt`]: `${i}\n` } }));
    const octopus = fc({ mark: 85, ref: "refs/heads/octopus", message: "octopus\n", from: 20, merge: Array.from({ length: 64 }, (_, i) => 21 + i) });
    const octopus64 = fc({ mark: 86, ref: "refs/heads/octopus", message: "octopus\n", from: 20, merge: Array.from({ length: 63 }, (_, i) => 21 + i) });
    type Expected = { state: string; code: string; result: unknown };
    const cases: [string, (f: Fixture) => void, Action[], (c: Fixture["c"], f: Fixture) => string, number | null, Expected | ((f: Fixture) => Expected)][] = [
      ["detached", (f) => gitRun(h, f.repo, ["checkout", "-q", "--detach", "main"]), ["cherry-pick", "revert-commit"], (c) => c.t1, null, unavailable("detached")],
      ["unborn", (f) => gitRun(h, f.repo, ["checkout", "-q", "--orphan", "fresh"]), ["cherry-pick", "revert-commit"], (c) => c.t1, null, unavailable("unborn")],
      [
        "conflicted",
        (f) => {
          const blob = gitOut(h, f.repo, ["rev-parse", "HEAD:a.txt"]).trim();
          gitRun(h, f.repo, ["update-index", "--index-info"], { input: Buffer.from(`0 ${"0".repeat(40)}\ta.txt\n100644 ${blob} 1\ta.txt\n100644 ${blob} 2\ta.txt\n100644 ${blob} 3\ta.txt\n`) });
        },
        ["cherry-pick", "revert-commit"],
        (c) => c.t1,
        null,
        { state: "failed", code: "CONFLICTED", result: { unmerged: 1 } },
      ],
      ["already on the branch", () => {}, ["cherry-pick"], (c) => c.m1, null, unavailable("already-on-branch")],
      ["more than 64 parents", () => {}, ["cherry-pick", "revert-commit"], (_, f) => gitOut(h, f.repo, ["rev-parse", "octopus"]).trim(), 1, unavailable("limit")],
      [
        "exactly 64 parents",
        () => {},
        ["cherry-pick", "revert-commit"],
        (_, f) => gitOut(h, f.repo, ["rev-parse", "octopus"]).trim(),
        null,
        (f) => unavailable("mainline-needed", { parents: Array.from({ length: 64 }, (_, i) => ({ oid: gitOut(h, f.repo, ["rev-parse", `p${i}`]).trim(), subject: `p${i}` })) }),
      ],
      ["missing commit", () => {}, ["cherry-pick", "revert-commit"], () => "0123456789abcdef0123456789abcdef01234567", null, { state: "failed", code: "UNKNOWN_TARGET", result: undefined }],
      // Research.md R2 P10: Git runs the first case and refuses the other two. The documentation rule refuses all three (research.md R4).
      ["P10 unstaged unrelated", (f) => h.write(`${f.repo}/a.txt`, "a edited\n"), ["cherry-pick", "revert-commit"], (c) => c.t1, null, unavailable("dirty-tree")],
      [
        "P10 staged unrelated",
        (f) => {
          h.write(`${f.repo}/c.txt`, "c staged\n");
          gitRun(h, f.repo, ["add", "--", "c.txt"]);
        },
        ["cherry-pick", "revert-commit"],
        (c) => c.t1,
        null,
        unavailable("dirty-tree"),
      ],
      // The pick of t2 and the revert of m3 both change b.txt.
      ["P10 unstaged overlap", (f) => h.write(`${f.repo}/b.txt`, "b edited\n"), ["cherry-pick", "revert-commit"], (c) => c.t2, null, unavailable("dirty-tree")],
    ];
    for (const [name, prepare, actions, commit, mainline, expected] of cases) {
      const f = build(h, name.replaceAll(" ", "-"), name === "more than 64 parents" ? [...many, octopus] : name === "exactly 64 parents" ? [...many, octopus64] : []);
      if (name === "more than 64 parents") expect(gitOut(h, f.repo, ["rev-list", "--parents", "-n", "1", "octopus", "--"]).trim().split(" ").length).toBe(66);
      if (name === "exactly 64 parents") expect(gitOut(h, f.repo, ["rev-list", "--parents", "-n", "1", "octopus", "--"]).trim().split(" ").length).toBe(65);
      const want = typeof expected === "function" ? expected(f) : expected;
      prepare(f);
      const before = stateOf(h, f.repo);
      await withSync(`t009-refusal-${name.replaceAll(" ", "-")}`, async (service) => {
        const r = await approved(service, f.repo);
        for (const action of actions) {
          const payload = action === "revert-commit" && name === "P10 unstaged overlap" ? PICK(action, f.c.m3) : PICK(action, commit(f.c, f), mainline);
          expect({ name, action, ...refusal(await review(service, r, payload)) }).toEqual({ name, action, ...want });
        }
        expect({ name, steps: steps(service) }).toEqual({ name, steps: [] });
        if (name === "already on the branch") expect(outcome(await review(service, r, PICK("revert-commit", f.c.m1)))).toEqual(SUCCEEDED);
      });
      expect({ name, state: stateOf(h, f.repo) }).toEqual({ name, state: before });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-010b: with parallel reads, CONFLICTED comes before UNKNOWN_TARGET, already-on-branch, and dirty-tree; UNKNOWN_TARGET and the mainline refusals come before already-on-branch and dirty-tree", SHELL, async () => {
    const h = hostFor("t009-order");
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const conflicted = build(h, "order-conflicted");
    const blob = gitOut(h, conflicted.repo, ["rev-parse", "HEAD:a.txt"]).trim();
    gitRun(h, conflicted.repo, ["update-index", "--index-info"], { input: Buffer.from(`0 ${"0".repeat(40)}\ta.txt\n100644 ${blob} 1\ta.txt\n100644 ${blob} 2\ta.txt\n100644 ${blob} 3\ta.txt\n`) });
    h.write(`${conflicted.repo}/c.txt`, "c edited\n");
    const dirty = build(h, "order-dirty");
    h.write(`${dirty.repo}/c.txt`, "c edited\n");
    const CONFLICTED = { state: "failed", code: "CONFLICTED", result: { unmerged: 1 } };
    const UNKNOWN = { state: "failed", code: "UNKNOWN_TARGET", result: undefined };
    const parents = [{ oid: dirty.c.s1, subject: "s1" }, { oid: dirty.c.x1, subject: "x1" }];
    const cases: [Fixture, string, object, { state: string; code: string; result: unknown }][] = [
      [conflicted, "conflicted, on the branch", PICK("cherry-pick", conflicted.c.m1), CONFLICTED],
      [conflicted, "conflicted, missing pick", PICK("cherry-pick", missing), CONFLICTED],
      [conflicted, "conflicted, missing revert", PICK("revert-commit", missing), CONFLICTED],
      [conflicted, "conflicted, dirty revert", PICK("revert-commit", conflicted.c.m2), CONFLICTED],
      [dirty, "dirty, on the branch", PICK("cherry-pick", dirty.c.m1), unavailable("already-on-branch")],
      [dirty, "dirty, on the branch with -m", PICK("cherry-pick", dirty.c.m1, 1), unavailable("not-merge")],
      [dirty, "dirty, revert with -m", PICK("revert-commit", dirty.c.t1, 1), unavailable("not-merge")],
      [dirty, "dirty, missing pick", PICK("cherry-pick", missing), UNKNOWN],
      [dirty, "dirty, missing revert", PICK("revert-commit", missing), UNKNOWN],
      [dirty, "dirty, merge pick", PICK("cherry-pick", dirty.c.merge), unavailable("mainline-needed", { parents })],
      [dirty, "dirty, merge revert", PICK("revert-commit", dirty.c.merge), unavailable("mainline-needed", { parents })],
      [dirty, "dirty, merge -m 3", PICK("cherry-pick", dirty.c.merge, 3), { state: "failed", code: "INVALID_REQUEST", result: undefined }],
      [dirty, "dirty, merge -m 1", PICK("revert-commit", dirty.c.merge, 1), unavailable("dirty-tree")],
    ];
    for (const f of [conflicted, dirty]) {
      const before = stateOf(h, f.repo);
      await withSync(`t009-order-${f === dirty ? "dirty" : "conflicted"}`, async (service) => {
        const r = await approved(service, f.repo);
        for (const [, name, payload, want] of cases.filter(([g]) => g === f)) expect({ name, ...refusal(await review(service, r, payload)) }).toEqual({ name, ...want });
        expect(steps(service)).toEqual([]);
      });
      expect(stateOf(h, f.repo)).toEqual(before);
    }
  }, TIMEOUT_MS);

  const ownOf = (service: Service, from: number, operationId: string | undefined) => service.runner.calls.slice(from).filter((c) => c.operationId === operationId);
  const PAIRS = (f: Fixture) => [["cherry-pick", f.c.t1], ["revert-commit", f.c.m2]] as const;

  caseTest(TASK, "SC-010b: the review reads of one stage run in parallel, at most 4 at once", SHELL, async () => {
    const h = hostFor("t009-parallel");
    const f = build(h, "parallel");
    await withSync("t009-parallel", async (service) => {
      const r = await approved(service, f.repo);
      for (const [action, commit] of PAIRS(f)) {
        const isDetach = isDetachOf(commit);
        const release = service.runner.holdStart(isIndexRead);
        let requestId = "";
        try {
          requestId = service.send("reviewWorkbench", PICK(action, commit), { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
          const operationId = await service.operationId(requestId);
          await until(() => service.runner.calls.some((c) => c.operationId === operationId && isDetach(c)), `${action}: detachCommit read while the conflicted read waits`);
        } finally {
          release();
        }
        const response = await service.response<Reviewed>(requestId);
        expect({ action, ...outcome(response) }).toEqual({ action, ...SUCCEEDED });
        const most = peak(ownOf(service, 0, response.operationId));
        console.log(`OBSERVATION SC-010b: ${action} review peak=${most}`);
        expect(most).toBeLessThanOrEqual(4);
      }
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-010b: an already-on-branch refusal of a one-parent commit starts no subjects read", SHELL, async () => {
    const h = hostFor("t009-no-subjects");
    const f = build(h, "no-subjects");
    await withSync("t009-no-subjects", async (service) => {
      const r = await approved(service, f.repo);
      const from = service.runner.calls.length;
      const refused = await review(service, r, PICK("cherry-pick", f.c.m1));
      const own = ownOf(service, from, refused.operationId);
      expect({ ...refusal(refused), parents: own.filter((c) => c.arguments.includes("--parents")).length, subjects: own.filter(isSubjects).length }).toEqual({ ...unavailable("already-on-branch"), parents: 1, subjects: 0 });
      expect(steps(service)).toEqual([]);
    });
  }, TIMEOUT_MS);

  // Serial reads never start the detachCommit read while the conflicted read waits, so this case ends at SIBLING_TIMEOUT_MS.
  caseTest(TASK, "SC-010b: a deadline of one stage-1 review read gives DEADLINE, every read ends before the reply, and no parents read starts", SHELL, async () => {
    const h = hostFor("t009-deadline");
    const f = build(h, "deadline");
    await withSync("t009-deadline", async (service) => {
      const r = await approved(service, f.repo);
      for (const [action, commit] of PAIRS(f)) {
        const isDetach = isDetachOf(commit);
        const from = service.runner.calls.length;
        const stop = siblingDeadline(service, isDetach, isIndexRead);
        const late = await review(service, r, PICK(action, commit)).finally(stop);
        const own = ownOf(service, from, late.operationId);
        const endOf = (c: RecordedCall | undefined) => c?.exit?.deadline ?? (c?.exit?.exitCode === null ? "closed" : String(c?.exit?.exitCode));
        expect({ action, ...outcome(late), exits: [own.find(isDetach), own.find(isIndexRead)].map(endOf), running: own.filter((c) => c.exit === undefined && c.refused === undefined).length, parents: own.filter((c) => c.arguments.includes("--parents")).length }).toEqual({
          action,
          state: "failed",
          code: "DEADLINE",
          exits: ["deadline", "closed"],
          running: 0,
          parents: 0,
        });
      }
      expect(steps(service)).toEqual([]);
    });
  }, SIBLING_TIMEOUT_MS);

  caseTest(TASK, "FR-003 and FR-007: an external commit after the review gives STALE_REVIEW, Cancel before the step changes nothing, and a step killed while index.lock exists gives failed-with-effects", SHELL, async () => {
    const h = hostFor("t009-stale");
    const f = build(h, "stale");
    await withSync("t009-stale", async (service) => {
      const r = await approved(service, f.repo);
      const rv = await reviewed(service, r, PICK("cherry-pick", f.c.t1));
      gitRun(h, f.repo, ["commit", "-q", "--allow-empty", "-m", "external"]);
      const before = stateOf(h, f.repo);
      expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(steps(service)).toEqual([]);
      const held = await reviewed(service, r, PICK("revert-commit", f.c.m2));
      const release = service.runner.holdStart(isStep);
      const requestId = sendRun(service, r, held.workbenchToken);
      const operationId = await service.operationId(requestId);
      await until(() => service.runner.calls.some((c) => c.operationId === operationId && isStep(c)), "held revert");
      await service.cancel(operationId);
      release();
      const response = await service.response<PickRun>(requestId);
      expect({ ...outcome(response), operationState: response.result!.operationState }).toEqual({ state: "canceled", code: "CANCELED", operationState: "normal" });
      expect(stateOf(h, f.repo)).toEqual(before);
    });

    const k = build(h, "killed");
    const lock = native(gitPaths(h, k.repo, ["index.lock"])[0]!);
    const started = `${h.root}/killed.started`;
    const stop = `${h.root}/killed.release`;
    // The hook runs in the process tree of `git cherry-pick`, so the kill ends it with the lock in place. It waits at most 30 seconds.
    h.write(`${gitPaths(h, k.repo, ["hooks"])[0]!}/reference-transaction`, `#!/bin/sh\n[ "$1" = prepared ] || exit 0\n: > '${lock}'\n: > '${started}'\ni=0\nwhile [ ! -f '${stop}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done\nexit 0\n`);
    try {
      await withSync("t009-killed", async (service) => {
        const r = await approved(service, k.repo);
        const requestId = sendRun(service, r, (await reviewed(service, r, PICK("cherry-pick", k.c.t1))).workbenchToken);
        await until(() => existsSync(native(started)), "reference-transaction hook start", 30_000);
        await service.cancel(await service.operationId(requestId));
        const response = await service.response<PickRun>(requestId);
        expect(service.runner.calls.filter(isStep).map((c) => c.exit?.exitCode)).toEqual([null]);
        expect(outcome(response)).toEqual(WITH_EFFECTS);
        expect(markers(h, k.repo)).toContain("index.lock");
      });
    } finally {
      h.write(stop, "");
      rmSync(lock, { force: true });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "SC-007 and FR-004: the hooks run only after the workbench approval with the event set of research.md R2 P2, and a post-commit hook that edits a tracked file gives failed-with-effects as Git's own command on a copy", SHELL, async () => {
    const h = hostFor("t009-hooks");
    const P2 = ["post-commit", "post-index-change", "prepare-commit-msg", "reference-transaction"];
    for (const [action, commit] of [["cherry-pick", "t1"], ["revert-commit", "m2"]] as const) {
      const f = build(h, `hooks-${action}`);
      const o = copyOf(h, f.repo);
      const [log, oracleLog] = [`${h.root}/hooks-${action}.log`, `${h.root}/hooks-${action}-oracle.log`];
      logHooks(gitPaths(h, f.repo, ["hooks"])[0]!, log);
      logHooks(gitPaths(h, o, ["hooks"])[0]!, oracleLog);
      await withSync(`t009-hooks-${action}`, async (service) => {
        const r = await register(service, f.repo);
        expect((await service.readTrust(r.repositoryId)).result!.approvalRequired.workbench).toBe(true);
        expect({ action, ...refusal(await review(service, r, PICK(action, f.c[commit]))) }).toEqual({ action, state: "failed", code: "TRUST_REQUIRED", result: { trustGate: "repository" } });
        expect({ action, steps: steps(service), log: existsSync(native(log)) }).toEqual({ action, steps: [], log: false });
        expect((await service.approveTrust(r.repositoryId, action === "cherry-pick" ? "cherry-pick" : "revert")).state).toBe("succeeded");
        expect({ action, ...outcome(await run(service, r, PICK(action, f.c[commit]))) }).toEqual({ action, ...SUCCEEDED });
      });
      gitRun(h, o, own(action, f.c[commit]), { env: INTEGRATE_ENV });
      expect({ action, events: hookEvents(native(log)) }).toEqual({ action, events: P2 });
      expect({ action, log: h.read(log)?.toString() }).toEqual({ action, log: h.read(oracleLog)?.toString() });
      expect({ action, state: stateOf(h, f.repo) }).toEqual({ action, state: stateOf(h, o) });
    }
    await oracle("t009-post-commit", [
      {
        name: "post-commit edit",
        action: "cherry-pick",
        commit: (c) => c.t1,
        prepare: (g, f) => g.write(`${gitPaths(g, f.repo, ["hooks"])[0]!}/post-commit`, "#!/bin/sh\necho hooked >> a.txt\n"),
        expect: WITH_EFFECTS,
        operationState: "normal",
        unmerged: 0,
        tail: false,
      },
    ]);
  }, TIMEOUT_MS);
});
