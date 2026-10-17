// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T021: `reviewWorkbench` and `runWorkbench` with action `switch` (contract Δ3, data-model §2 and §3, plan.md D3, quickstart Q5 to Q8).
// The oracle is a second build of the same fixture with Git's own commands. Fresh Git reads decide every expectation, never message text.

import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localNameOf } from "../../src/git-service/workbench-parsers";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { sha256, workingFileDigests } from "./git-oracle";
import { caseTest, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { gitExe, native, TIMEOUT_MS, until, withSync } from "./sync-harness";
import { buildWorkbench, repoOf, wb, type WbFixture, type WbFixtureName } from "./workbench-fixtures";

for (const module of ["switch", "workbench-review", "session"]) {
  try {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  } catch {
    console.log(`ORIGIN absent src/git-service/${module}.ts`);
  }
}
useFixtureRoot();

const TASK = "T021";
const SHELL = ["shell-double"] as const;
const TARGET = "refs/heads/target";
const MESSAGE = "Arbareto: switch to target";
const SUCCEEDED = { state: "succeeded", code: undefined };
const WITH_EFFECTS = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const unavailable = (reason: string, extra: object = {}) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason, ...extra } });
const refusalOf = (r: ServiceResponse<unknown>) => ({ ...outcome(r), result: r.result });

interface Reviewed {
  action: string;
  plan: Record<string, unknown>;
  workbenchToken: string;
}

interface SwitchResult {
  action: string;
  head: { state: string; target?: string; oid?: string };
  stash: { oid: string | null; state: string } | null;
  conflicted: number;
  remedy?: { text: string; command: string | null };
  outputTail?: string;
}

let builds = 0;
const build = (fixture: WbFixtureName): WbFixture => buildWorkbench(gitExe(), fixture, `t021-${fixture}-${++builds}`);
const git = (f: WbFixture, args: string[], allowExit: number[] = [0], dir = f.repo) => wb(repoOf(f, dir), args, { allowExit }).stdout.toString("utf8");
const oid = (f: WbFixture, rev: string, dir = f.repo) => git(f, ["rev-parse", "--verify", "-q", rev], [0], dir).trim();

// SC-001: HEAD, the index, every working byte, the stash list, every ref, and the local configuration bytes.
function stateOf(f: WbFixture, dir = f.repo) {
  return {
    head: git(f, ["symbolic-ref", "-q", "HEAD"], [0, 1], dir).trim(),
    oid: git(f, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1], dir).trim(),
    index: git(f, ["ls-files", "-s", "-z"], [0], dir),
    files: workingFileDigests(dir),
    stash: git(f, ["stash", "list", "--format=%H"], [0], dir),
    refs: git(f, ["for-each-ref", "--format=%(refname) %(objectname)"], [0], dir),
    config: sha256(readFileSync(f.configs.local!)),
  };
}

const put = (f: WbFixture, path: string, content: string) => writeFileSync(join(f.repo, path), content);

// The fixtures run no repository program, so approval is needed only if the trust listing says so.
async function open(service: Service, dir: string): Promise<RegistrationResult> {
  const r = await service.register(native(dir));
  const trust = await service.readTrust(r.repositoryId);
  if (trust.result!.approvalRequired.sync) expect((await service.approveTrust(r.repositoryId, trust.result!.fingerprint, r.generation)).state).toBe("succeeded");
  return r;
}

const review = (service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<unknown>> => service.request("reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });

async function reviewed(service: Service, r: RegistrationResult, payload: object): Promise<Reviewed> {
  const response = await review(service, r, payload);
  expect({ ...outcome(response), result: response.state === "succeeded" ? "result" : response.result }).toEqual({ ...SUCCEEDED, result: "result" });
  const result = response.result as Reviewed;
  expect(typeof result.workbenchToken).toBe("string");
  return result;
}

async function run(service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<SwitchResult>> {
  return service.response<SwitchResult>(sendRun(service, r, (await reviewed(service, r, payload)).workbenchToken));
}

const switchTo = (choice: string, target: object = { ref: TARGET }) => ({ action: "switch", target, choice });
// The step arguments of the `integrate` policy (plan.md D2), in call order.
const steps = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [...c.arguments]);
const subcommands = (service: Service, from = 0) => steps(service, from).map((a) => a.slice(1, a[1] === "stash" ? 3 : 2).join(" "));
const isStep = (call: { arguments: readonly string[] }, ...words: string[]) => words.every((w, i) => call.arguments[i + 1] === w);

caseTest(TASK, "FR-009, FR-010, and SC-001: a clean review has no default choice and gives a token that runWorkbench uses at once; the result equals Git's own checkout on a copy", SHELL, async () => {
  const f = build("switch-clean");
  const o = build("switch-clean");
  await withSync("t021-clean", async (service) => {
    const r = await open(service, f.repo);
    // FR-010: the payload names the choice. A review without it is refused, so no choice is a default.
    expect(outcome(await review(service, r, { action: "switch", target: { ref: TARGET } }))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
    const rv = await reviewed(service, r, switchTo("keep"));
    expect(rv).toEqual({ action: "switch", plan: { target: { local: TARGET }, trackedChanges: 0, unreachable: null, heldBy: null, choice: "keep", inTheWay: null }, workbenchToken: rv.workbenchToken });
    const from = service.runner.calls.length;
    const response = await service.response<SwitchResult>(sendRun(service, r, rv.workbenchToken));
    expect(outcome(response)).toEqual(SUCCEEDED);
    expect(response.result).toMatchObject({ action: "switch", head: { state: "branch", target: TARGET, oid: f.oids.target }, stash: null, conflicted: 0 });
    expect(steps(service, from)).toEqual([["--no-lazy-fetch", "checkout", "--no-guess", "--no-recurse-submodules", "target", "--"]]);
    // Contract §2: a consumed token answers a repeat with its operation, and no process starts.
    const calls = service.runner.calls.length;
    const repeat = await service.response<{ operationId: string; state: string }>(sendRun(service, r, rv.workbenchToken));
    expect({ ...outcome(repeat), operationId: repeat.operationId, view: repeat.result?.state }).toEqual({ ...SUCCEEDED, operationId: response.operationId, view: "succeeded" });
    expect(service.runner.calls.length).toBe(calls);
    // Plan.md D3: a switch to the current branch has no effect but the choice, so it refuses.
    expect(refusalOf(await review(service, r, switchTo("discard")))).toEqual(unavailable("same-branch"));
  });
  git(o, ["checkout", "-q", "--no-guess", "target", "--"]);
  expect(stateOf(f)).toEqual(stateOf(o));
  expect(stateOf(f).config).toBe(f.digests.local!);
}, TIMEOUT_MS);

caseTest(TASK, "SC-001 and SC-002: a dirty tree with Keep changes, Stash and reapply, and Discard changes equals Git's own commands on a copy, and untracked files stay", SHELL, async () => {
  const oracle: Record<string, string[][]> = {
    keep: [["checkout", "-q", "--no-guess", "target", "--"]],
    stash: [["stash", "push", "--quiet", "-m", MESSAGE], ["checkout", "-q", "--no-guess", "target", "--"], ["stash", "apply", "--index"], ["stash", "drop", "--quiet"]],
    discard: [["stash", "push", "--quiet", "-m", MESSAGE], ["checkout", "-q", "--no-guess", "target", "--"], ["stash", "drop", "--quiet"]],
  };
  const expectedSteps: Record<string, string[]> = { keep: ["checkout"], stash: ["stash push", "checkout", "stash apply", "stash drop"], discard: ["stash push", "checkout", "stash drop"] };
  for (const choice of ["keep", "stash", "discard"]) {
    const f = build("switch-dirty");
    const o = build("switch-dirty");
    const notes = readFileSync(join(f.repo, "notes.txt"));
    const seen = { stash: null as string | null };
    await withSync(`t021-dirty-${choice}`, async (service) => {
      const r = await open(service, f.repo);
      const rv = await reviewed(service, r, switchTo(choice));
      expect(rv.plan).toEqual({ target: { local: TARGET }, trackedChanges: 4, unreachable: null, heldBy: null, choice, inTheWay: null });
      const from = service.runner.calls.length;
      const response = await service.response<SwitchResult>(sendRun(service, r, rv.workbenchToken));
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(subcommands(service, from)).toEqual(expectedSteps[choice]!);
      expect(response.result!.head).toEqual({ state: "branch", target: TARGET, oid: f.oids.target });
      const stashed = response.result!.stash?.oid ?? null;
      seen.stash = stashed;
      expect(response.result!.stash?.state ?? null).toBe(choice === "keep" ? null : "dropped");
      // FR-012: the reapply names S by its object ID, and the drop removes the entry at its reflog position.
      if (choice === "stash") expect(steps(service, from)[2]).toEqual(["--no-lazy-fetch", "stash", "apply", "--index", stashed!]);
      if (choice !== "keep") expect(steps(service, from).at(-1)).toEqual(["--no-lazy-fetch", "stash", "drop", "--quiet", "stash@{0}"]);
    });
    for (const args of oracle[choice]!) {
      git(o, args);
      if (args[1] === "push") expect(seen.stash).toBe(oid(o, "refs/stash"));
    }
    expect(stateOf(f)).toEqual(stateOf(o));
    expect(readFileSync(join(f.repo, "notes.txt"))).toEqual(notes);
  }
}, TIMEOUT_MS);

caseTest(TASK, "research.md R21 F3: Keep changes with a conflicting change fails as Git refuses, and HEAD, the index, and every working byte stay unchanged", SHELL, async () => {
  const f = build("switch-conflict");
  const before = stateOf(f);
  await withSync("t021-keep-conflict", async (service) => {
    const r = await open(service, f.repo);
    const response = await run(service, r, switchTo("keep"));
    expect(outcome(response)).toEqual({ state: "failed", code: "GIT_FAILED" });
    expect(response.result).toMatchObject({ action: "switch", head: { state: "branch", target: "refs/heads/main", oid: f.oids.base }, stash: null, conflicted: 0 });
    expect(typeof response.result!.outputTail).toBe("string");
  });
  expect(stateOf(f)).toEqual(before);
}, TIMEOUT_MS);

caseTest(TASK, "FR-012: Stash and reapply with a reapply conflict keeps the stash, names its commit ID, shows the unmerged entry, and equals Git's own commands on a copy", SHELL, async () => {
  const f = build("switch-conflict");
  const o = build("switch-conflict");
  let result: SwitchResult | undefined;
  await withSync("t021-reapply-conflict", async (service) => {
    const r = await open(service, f.repo);
    const from = service.runner.calls.length;
    const response = await run(service, r, switchTo("stash"));
    expect(outcome(response)).toEqual(WITH_EFFECTS);
    result = response.result!;
    expect(subcommands(service, from)).toEqual(["stash push", "checkout", "stash apply"]);
  });
  git(o, ["stash", "push", "--quiet", "-m", MESSAGE]);
  git(o, ["checkout", "-q", "--no-guess", "target", "--"]);
  git(o, ["stash", "apply", "--index", oid(o, "refs/stash")], [1]);
  expect(result).toMatchObject({ head: { state: "branch", target: TARGET, oid: f.oids.target }, stash: { oid: oid(o, "refs/stash"), state: "kept-conflicts" }, conflicted: 1 });
  expect(result!.remedy).toBeUndefined();
  expect(oid(f, "refs/stash")).toBe(result!.stash!.oid!);
  expect(git(f, ["ls-files", "-z", "--unmerged"]).split("\0").filter((l) => l !== "").map((l) => l.split("\t")[1])).toEqual(["a.txt", "a.txt", "a.txt"]);
  expect(stateOf(f)).toEqual(stateOf(o));
}, TIMEOUT_MS);

caseTest(TASK, "FR-012: a failed checkout after the stash reapplies nothing; the stash stays with its commit ID and Git's own command to apply it", SHELL, async () => {
  const f = build("switch-untracked");
  const o = build("switch-untracked");
  for (const x of [f, o]) put(x, "b.txt", "b changed\n");
  let result: SwitchResult | undefined;
  let root = "";
  await withSync("t021-checkout-fails", async (service) => {
    const r = await open(service, f.repo);
    root = r.worktreeRoot;
    const from = service.runner.calls.length;
    const response = await run(service, r, switchTo("stash"));
    expect(outcome(response)).toEqual(WITH_EFFECTS);
    result = response.result!;
    expect(subcommands(service, from)).toEqual(["stash push", "checkout"]);
  });
  git(o, ["stash", "push", "--quiet", "-m", MESSAGE]);
  git(o, ["checkout", "-q", "--no-guess", "target", "--"], [1]);
  const stash = oid(o, "refs/stash");
  expect(result).toMatchObject({ head: { state: "branch", target: "refs/heads/main", oid: f.oids.base }, stash: { oid: stash, state: "kept-failed-checkout" }, conflicted: 0 });
  expect(result!.remedy!.command).toBe(`& '${gitExe()}' --no-lazy-fetch -C '${root.replace(/[\\/]+$/, "")}' stash apply '${stash}'`);
  expect(readFileSync(join(f.repo, "new.txt"), "utf8")).toBe("new local\n");
  expect(stateOf(f)).toEqual(stateOf(o));
}, TIMEOUT_MS);

caseTest(TASK, "FR-011 and SC-002: Discard with an untracked file or folder in the way refuses with UNTRACKED_IN_WAY before any Git step, and every untracked byte stays; an ignored file in the way is replaceable", SHELL, async () => {
  for (const [fixture, paths] of [["switch-untracked", ["new.txt"]], ["switch-folder", ["dirfile"]]] as const) {
    const f = build(fixture);
    put(f, "b.txt", "b changed\n");
    const before = stateOf(f);
    await withSync(`t021-in-the-way-${fixture}`, async (service) => {
      const r = await open(service, f.repo);
      const from = service.runner.calls.length;
      const response = await review(service, r, switchTo("discard"));
      expect({ ...outcome(response), result: response.result }).toEqual({ state: "failed", code: "UNTRACKED_IN_WAY", result: { reason: "untracked-in-way", paths, more: 0 } });
      expect(steps(service, from)).toEqual([]);
    });
    expect(stateOf(f)).toEqual(before);
  }
  const f = build("switch-ignored");
  const o = build("switch-ignored");
  for (const x of [f, o]) put(x, "b.txt", "b changed\n");
  await withSync("t021-in-the-way-ignored", async (service) => {
    const r = await open(service, f.repo);
    const rv = await reviewed(service, r, switchTo("discard"));
    expect(rv.plan.inTheWay).toBeNull();
    expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual(SUCCEEDED);
  });
  for (const args of [["stash", "push", "--quiet", "-m", MESSAGE], ["checkout", "-q", "--no-guess", "target", "--"], ["stash", "drop", "--quiet"]]) git(o, args);
  expect(stateOf(f)).toEqual(stateOf(o));
}, TIMEOUT_MS);

caseTest(TASK, "plan.md D3 stash protocol: nothing to stash runs as Keep changes and creates no stash", SHELL, async () => {
  const f = build("switch-clean");
  await withSync("t021-nothing-to-stash", async (service) => {
    const r = await open(service, f.repo);
    const from = service.runner.calls.length;
    const response = await run(service, r, switchTo("stash"));
    expect(outcome(response)).toEqual(SUCCEEDED);
    expect(response.result!.stash).toBeNull();
    expect(subcommands(service, from)).toEqual(["stash push", "checkout"]);
  });
  expect(git(f, ["stash", "list", "--format=%H"])).toBe("");
  expect(stateOf(f).head).toBe(TARGET);
}, TIMEOUT_MS);

caseTest(TASK, "plan.md D3 stash protocol: another stash after the push stops the switch before the checkout, and the result names refs/stash", SHELL, async () => {
  const f = build("switch-dirty");
  await withSync("t021-stash-changed", async (service) => {
    const r = await open(service, f.repo);
    const rv = await reviewed(service, r, switchTo("stash"));
    const pushed = (operationId: string) => service.runner.calls.some((c) => c.operationId === operationId && isStep(c, "stash", "push"));
    const release = service.runner.holdStart((call) => call.arguments.includes("refs/stash") && pushed(call.operationId));
    const requestId = sendRun(service, r, rv.workbenchToken);
    const operationId = await service.operationId(requestId);
    await until(() => service.runner.calls.some((c) => c.operationId === operationId && c.arguments.includes("refs/stash") && pushed(operationId) && c.exit === undefined), "held refs/stash read");
    put(f, "a.txt", "external\n");
    git(f, ["stash", "push", "--quiet", "-m", "external"]);
    const external = oid(f, "refs/stash");
    release();
    const response = await service.response<SwitchResult>(requestId);
    expect(outcome(response)).toEqual(WITH_EFFECTS);
    expect(response.result).toMatchObject({ head: { state: "branch", target: "refs/heads/main", oid: f.oids.base }, stash: { oid: external, state: "kept-stash-changed" } });
    expect(subcommands(service).filter((s) => s === "checkout")).toEqual([]);
  });
  expect(git(f, ["stash", "list", "--format=%H"]).trim().split("\n")).toHaveLength(2);
}, TIMEOUT_MS);

caseTest(TASK, "plan.md D3 drop step: with two earlier stashes and a stash pushed before the reapply, the reapply takes S by its object ID and the drop removes exactly the entry S", SHELL, async () => {
  const f = build("switch-dirty");
  const o = build("switch-dirty");
  for (const x of [f, o]) {
    for (const n of [1, 2]) {
      put(x, "a.txt", `early ${n}\n`);
      git(x, ["stash", "push", "--quiet", "-m", `early ${n}`, "--", "a.txt"]);
    }
  }
  const early = git(f, ["stash", "list", "--format=%H"]).trim().split("\n");
  let stash = "";
  let external = "";
  await withSync("t021-two-earlier", async (service) => {
    const r = await open(service, f.repo);
    const rv = await reviewed(service, r, switchTo("stash"));
    const release = service.runner.holdStart((call) => isStep(call, "stash", "apply"));
    const requestId = sendRun(service, r, rv.workbenchToken);
    await until(() => service.runner.calls.some((c) => isStep(c, "stash", "apply")), "held stash apply");
    put(f, "a.txt", "external\n");
    git(f, ["stash", "push", "--quiet", "-m", "external", "--", "a.txt"]);
    external = oid(f, "refs/stash");
    release();
    const response = await service.response<SwitchResult>(requestId);
    // The external stash is an observed effect that the switch did not intend (data-model §7).
    expect(outcome(response)).toEqual({ state: "completed-with-effects", code: "COMPLETED_WITH_EFFECTS" });
    stash = response.result!.stash!.oid!;
    expect(response.result!.stash).toEqual({ oid: stash, state: "dropped" });
    expect(steps(service).filter((a) => a[1] === "stash").slice(1)).toEqual([["--no-lazy-fetch", "stash", "apply", "--index", stash], ["--no-lazy-fetch", "stash", "drop", "--quiet", "stash@{1}"]]);
  });
  expect(git(f, ["stash", "list", "--format=%H"]).trim().split("\n")).toEqual([external, ...early]);
  git(o, ["stash", "push", "--quiet", "-m", MESSAGE]);
  expect(oid(o, "refs/stash")).toBe(stash);
  git(o, ["checkout", "-q", "--no-guess", "target", "--"]);
  put(o, "a.txt", "external\n");
  git(o, ["stash", "push", "--quiet", "-m", "external", "--", "a.txt"]);
  git(o, ["stash", "apply", "--index", stash]);
  git(o, ["stash", "drop", "--quiet", "stash@{1}"]);
  expect(stateOf(f)).toEqual(stateOf(o));
}, TIMEOUT_MS);

caseTest(TASK, "FR-013 and research.md R21 F8: a remote branch with one, zero, and two mapping refspecs; the new branch and its branch.<name> keys equal Git's own checkout --track on a copy", SHELL, async () => {
  for (const [ref, mapped, name] of [["refs/remotes/one/topic", "topic", "topic"], ["refs/remotes/zero/topic", null, "typed-zero"], ["refs/remotes/two/x/topic", null, "typed-two"]] as const) {
    const f = build("switch-clean");
    const o = build("switch-clean");
    const config = git(f, ["config", "list", "--local", "-z"]).split("\0").filter((e) => e !== "").map((e) => ({ key: e.slice(0, e.indexOf("\n")), value: e.slice(e.indexOf("\n") + 1) }));
    // Research.md R2: the default name comes from the one mapping refspec. Zero or several give an empty field.
    expect(localNameOf(ref, config)).toBe(mapped);
    const seen = { succeeded: false };
    await withSync(`t021-track-${name}`, async (service) => {
      const r = await open(service, f.repo);
      const from = service.runner.calls.length;
      const response = await run(service, r, switchTo("keep", { track: { ref, name } }));
      seen.succeeded = response.state === "succeeded";
      expect(steps(service, from)).toEqual([["--no-lazy-fetch", "checkout", "--no-guess", "--no-recurse-submodules", "-b", name, "--track=direct", ref, "--"]]);
    });
    // Without a mapping refspec, Git writes the start tree and then refuses the tracking setup. Both runs must leave the same state.
    const own = wb(repoOf(o), ["checkout", "-q", "-b", name, "--track", ref.slice("refs/remotes/".length), "--"], { allowExit: "any" });
    expect({ name, succeeded: seen.succeeded }).toEqual({ name, succeeded: own.exitCode === 0 });
    expect(stateOf(f)).toEqual(stateOf(o));
    expect(readFileSync(f.configs.local!)).toEqual(readFileSync(o.configs.local!));
  }
}, TIMEOUT_MS);

caseTest(TASK, "FR-013 and plan.md D4: a taken track name gives name-exists with the branch to switch to; the track name @ and the branches refs/heads/@ and refs/heads/-f refuse before any Git process", SHELL, async () => {
  const f = build("switch-clean");
  git(f, ["update-ref", "refs/heads/@", f.oids.target!]);
  git(f, ["update-ref", "refs/heads/-f", f.oids.target!]);
  const before = stateOf(f);
  await withSync("t021-names", async (service) => {
    const r = await open(service, f.repo);
    let from = service.runner.calls.length;
    const taken = await review(service, r, switchTo("keep", { track: { ref: "refs/remotes/one/topic", name: "target" } }));
    expect({ ...outcome(taken), result: taken.result }).toEqual(unavailable("name-exists", { ref: TARGET }));
    expect(steps(service, from)).toEqual([]);
    for (const [target, reason] of [[{ track: { ref: "refs/remotes/one/topic", name: "@" } }, "reserved-name"], [{ ref: "refs/heads/@" }, "reserved-name"], [{ ref: "refs/heads/-f" }, "invalid-name"]] as const) {
      from = service.runner.calls.length;
      const response = await review(service, r, switchTo("keep", target));
      expect({ ...outcome(response), result: response.result }).toEqual(unavailable(reason));
      expect(service.runner.calls.length).toBe(from);
    }
  });
  expect(stateOf(f)).toEqual(before);
}, TIMEOUT_MS);

caseTest(TASK, "FR-013: a branch that another worktree holds gives other-worktree with that worktree path; the switch away from a detached commit that no ref holds names that commit", SHELL, async () => {
  const f = build("branches");
  const records = git(f, ["worktree", "list", "--porcelain", "-z"]).split("\0\0").filter((r) => r !== "").map((r) => r.split("\0"));
  const holder = records.find((r) => r.includes("branch refs/heads/wt-held"))!;
  await withSync("t021-worktrees", async (service) => {
    const r = await open(service, f.repo);
    const response = await review(service, r, switchTo("keep", { ref: "refs/heads/wt-held" }));
    expect({ ...outcome(response), result: response.result }).toEqual(unavailable("other-worktree", { worktree: holder[0]!.slice("worktree ".length) }));
    const detached = await open(service, join(f.root, "wt-detached"));
    expect((await reviewed(service, detached, switchTo("keep", { ref: "refs/heads/merged" }))).plan.unreachable).toBe(f.oids.unreachable!);
  });
  const c = build("switch-clean");
  git(c, ["checkout", "-q", "--detach", "main"]);
  await withSync("t021-reachable-detached", async (service) => {
    const r = await open(service, c.repo);
    expect((await reviewed(service, r, switchTo("keep"))).plan.unreachable).toBeNull();
  });
}, TIMEOUT_MS);

caseTest(TASK, "data-model §2: a moved target or a new tracked change after the review gives STALE_REVIEW, and no step starts", SHELL, async () => {
  for (const change of ["target", "tracked"] as const) {
    const f = build("switch-clean");
    await withSync(`t021-stale-${change}`, async (service) => {
      const r = await open(service, f.repo);
      const rv = await reviewed(service, r, switchTo("keep"));
      if (change === "target") git(f, ["update-ref", TARGET, f.oids.base!]);
      else put(f, "a.txt", "a changed\n");
      const before = stateOf(f);
      const from = service.runner.calls.length;
      const response = await service.response(sendRun(service, r, rv.workbenchToken));
      expect(outcome(response)).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(steps(service, from)).toEqual([]);
      expect(stateOf(f)).toEqual(before);
      // Data-model §2: a refused validation consumes no token, so the reviewed state makes the same token valid again.
      if (change === "target") git(f, ["update-ref", TARGET, f.oids.target!]);
      else git(f, ["checkout", "--", "a.txt"]);
      expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual(SUCCEEDED);
    });
  }
  // Contract §5 "Approval lifetime": a token older than 60 s gives APPROVAL_EXPIRED, and no step starts.
  const f = build("switch-clean");
  let clock = 0;
  await withSync("t021-expired", async (service) => {
    const r = await open(service, f.repo);
    const rv = await reviewed(service, r, switchTo("keep"));
    clock += 60_001;
    const from = service.runner.calls.length;
    expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED" });
    expect(service.runner.calls.length).toBe(from);
  }, { approvalClock: () => clock });
}, TIMEOUT_MS);

caseTest(TASK, "contract Δ3 common refusals: a merge in progress gives OPERATION_IN_PROGRESS, and an unmerged entry without a marker gives CONFLICTED with the count; no step starts", SHELL, async () => {
  const merging = build("conflict-merge");
  await withSync("t021-in-progress", async (service) => {
    const r = await open(service, merging.repo);
    expect(refusalOf(await review(service, r, switchTo("keep", { ref: "refs/heads/topic" })))).toEqual({ state: "failed", code: "OPERATION_IN_PROGRESS", result: undefined });
    expect(steps(service)).toEqual([]);
  });
  const f = build("switch-conflict");
  await withSync("t021-conflicted", async (service) => {
    const r = await open(service, f.repo);
    expect(outcome(await run(service, r, switchTo("stash")))).toEqual(WITH_EFFECTS);
    const from = service.runner.calls.length;
    expect(refusalOf(await review(service, r, switchTo("keep", { ref: "refs/heads/main" })))).toEqual({ state: "failed", code: "CONFLICTED", result: { unmerged: 1 } });
    expect(steps(service, from)).toEqual([]);
  });
}, TIMEOUT_MS);

caseTest(TASK, "contract Δ8: Cancel at each step of Stash and reapply starts no later step, and the result states the observed HEAD and stash", SHELL, async () => {
  const cases = [
    { at: ["stash", "push"], state: { state: "canceled", code: "CANCELED" }, head: "refs/heads/main", stash: null, later: [] },
    { at: ["checkout"], state: WITH_EFFECTS, head: "refs/heads/main", stash: "kept-failed-checkout", later: ["stash apply", "stash drop"] },
    { at: ["stash", "apply"], state: WITH_EFFECTS, head: TARGET, stash: "kept-failed-apply", later: ["stash drop"] },
    { at: ["stash", "drop"], state: WITH_EFFECTS, head: TARGET, stash: "kept-not-found", later: [] },
  ];
  for (const c of cases) {
    const f = build("switch-dirty");
    await withSync(`t021-cancel-${c.at.join("-")}`, async (service) => {
      const r = await open(service, f.repo);
      const rv = await reviewed(service, r, switchTo("stash"));
      const release = service.runner.holdStart((call) => isStep(call, ...c.at));
      const requestId = sendRun(service, r, rv.workbenchToken);
      const operationId = await service.operationId(requestId);
      await until(() => service.runner.calls.some((call) => call.operationId === operationId && isStep(call, ...c.at)), `held ${c.at.join(" ")}`);
      await service.cancel(operationId);
      release();
      const response = await service.response<SwitchResult>(requestId);
      expect({ at: c.at, ...outcome(response) }).toEqual({ at: c.at, ...c.state });
      const head = { state: "branch", target: c.head, oid: oid(f, "HEAD") };
      expect(response.result!.head).toEqual(head);
      expect(c.head).toBe(stateOf(f).head);
      expect(response.result!.stash).toEqual(c.stash === null ? null : { oid: oid(f, "refs/stash"), state: c.stash });
      const ran = subcommands(service);
      for (const later of c.later) expect({ at: c.at, later, ran: ran.includes(later) }).toEqual({ at: c.at, later, ran: false });
    });
  }
}, TIMEOUT_MS);
