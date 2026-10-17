// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T022: `reviewWorkbench` and `runWorkbench` with `create-branch`, `rename-branch`, and `delete-branch` (contract Δ3, data-model §2 and §4, plan.md D4, quickstart Q9).
// The oracle is a second build of the same fixture with Git's own branch commands.

import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { sha256, workingFileDigests } from "./git-oracle";
import { caseTest, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { gitExe, native, TIMEOUT_MS, until, withSync } from "./sync-harness";
import { buildWorkbench, repoOf, wb, type WbFixture } from "./workbench-fixtures";

for (const module of ["branch-ops", "workbench-review", "session"]) {
  try {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  } catch {
    console.log(`ORIGIN absent src/git-service/${module}.ts`);
  }
}
useFixtureRoot();

const TASK = "T022";
const SHELL = ["shell-double"] as const;
const SUCCEEDED = { state: "succeeded", code: undefined };
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const unavailable = (reason: string, extra: object = {}) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason, ...extra } });

interface Reviewed {
  action: string;
  plan: Record<string, unknown>;
  workbenchToken: string;
}

interface BranchResult {
  action: string;
  head: { state: string; target?: string; oid?: string };
  refs: { ref: string; oldObjectId: string | null; newObjectId: string | null }[];
  outputTail?: string;
}

let builds = 0;
const build = (): WbFixture => buildWorkbench(gitExe(), "branches", `t022-branches-${++builds}`);
const git = (f: WbFixture, args: string[], allowExit: number[] = [0]) => wb(repoOf(f), args, { allowExit }).stdout.toString("utf8");
const oid = (f: WbFixture, rev: string) => git(f, ["rev-parse", "--verify", "-q", rev]).trim();
const reachable = (f: WbFixture) => new Set(git(f, ["rev-list", "--branches", "--tags", "--remotes"]).trim().split("\n"));

// SC-009: every ref, HEAD, the index, every working byte, the local configuration bytes, and the HEAD reflog.
function stateOf(f: WbFixture) {
  return {
    head: git(f, ["symbolic-ref", "-q", "HEAD"], [0, 1]).trim(),
    refs: git(f, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    index: git(f, ["ls-files", "-s", "-z"]),
    files: workingFileDigests(f.repo),
    config: sha256(readFileSync(f.configs.local!)),
    headLog: git(f, ["log", "-g", "--format=%H%x00%gs", "HEAD", "--"]),
  };
}

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
  return response.result as Reviewed;
}

async function run(service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<BranchResult>> {
  return service.response<BranchResult>(sendRun(service, r, (await reviewed(service, r, payload)).workbenchToken));
}

const steps = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [...c.arguments]);
const refused = (response: ServiceResponse<unknown>) => ({ ...outcome(response), result: response.result });

caseTest(TASK, "FR-015 and quickstart Q9: Create branch here with and without Switch to the new branch sets no upstream and equals Git's own command on a copy", SHELL, async () => {
  for (const switchTo of [false, true]) {
    const f = build();
    const o = build();
    const name = switchTo ? "new-b" : "new-a";
    const start = f.oids.second!;
    await withSync(`t022-create-${name}`, async (service) => {
      const r = await open(service, f.repo);
      const rv = await reviewed(service, r, { action: "create-branch", name, start, switchTo });
      expect(rv.plan).toEqual({ name, start, switchTo });
      const from = service.runner.calls.length;
      const response = await service.response<BranchResult>(sendRun(service, r, rv.workbenchToken));
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(response.result!.refs).toEqual([{ ref: `refs/heads/${name}`, oldObjectId: null, newObjectId: start }]);
      expect(response.result!.head).toEqual(switchTo ? { state: "branch", target: `refs/heads/${name}`, oid: start } : { state: "branch", target: "refs/heads/main", oid: f.oids.main });
      expect(steps(service, from)).toEqual([switchTo ? ["--no-lazy-fetch", "checkout", "--no-recurse-submodules", "-b", name, start, "--"] : ["--no-lazy-fetch", "branch", "--end-of-options", name, start]]);
    });
    git(o, switchTo ? ["checkout", "-q", "-b", name, start, "--"] : ["branch", "--end-of-options", name, start]);
    expect(stateOf(f)).toEqual(stateOf(o));
    expect(git(f, ["config", "list", "--local"]).includes(`branch.${name}.`)).toBe(false);
  }
}, TIMEOUT_MS);

caseTest(TASK, "FR-015 and FR-016: check-ref-format refusals and an expanded @{-1} give invalid-name, an existing name gives name-exists, and @ gives reserved-name for create and rename before any Git process; no ref changes", SHELL, async () => {
  const f = build();
  // A checkout reflog entry gives `@{-1}` a value, so `check-ref-format --branch` prints `merged`.
  git(f, ["checkout", "-q", "merged"]);
  git(f, ["checkout", "-q", "main"]);
  expect(git(f, ["check-ref-format", "--branch", "@{-1}"])).toBe("merged\n");
  const before = stateOf(f);
  const start = f.oids.second!;
  await withSync("t022-names", async (service) => {
    const r = await open(service, f.repo);
    for (const name of ["a..b", "@{-1}", "-x", "x.lock"]) expect(refused(await review(service, r, { action: "create-branch", name, start, switchTo: false }))).toEqual(unavailable("invalid-name"));
    expect(refused(await review(service, r, { action: "rename-branch", ref: "refs/heads/merged", name: "a..b" }))).toEqual(unavailable("invalid-name"));
    expect(refused(await review(service, r, { action: "create-branch", name: "merged", start, switchTo: true }))).toEqual(unavailable("name-exists", { ref: "refs/heads/merged" }));
    expect(refused(await review(service, r, { action: "rename-branch", ref: "refs/heads/merged", name: "held" }))).toEqual(unavailable("name-exists", { ref: "refs/heads/held" }));
    for (const payload of [{ action: "create-branch", name: "@", start, switchTo: false }, { action: "rename-branch", ref: "refs/heads/merged", name: "@" }]) {
      const from = service.runner.calls.length;
      expect(refused(await review(service, r, payload))).toEqual(unavailable("reserved-name"));
      expect(service.runner.calls.length).toBe(from);
    }
    expect(steps(service)).toEqual([]);
  });
  expect(stateOf(f)).toEqual(before);
}, TIMEOUT_MS);

caseTest(TASK, "research.md R21 F29 and FR-016: Rename from an existing @ renames that branch, and a rename moves the branch.<old> section and the reflog, as Git's own branch -m does", SHELL, async () => {
  for (const [old, name] of [["@", "from-at"], ["unmerged", "renamed"]] as const) {
    const f = build();
    const o = build();
    for (const x of [f, o]) if (old === "@") git(x, ["update-ref", "refs/heads/@", x.oids.held!]);
    await withSync(`t022-rename-${name}`, async (service) => {
      const r = await open(service, f.repo);
      const from = service.runner.calls.length;
      const response = await run(service, r, { action: "rename-branch", ref: `refs/heads/${old}`, name });
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(steps(service, from)).toEqual([["--no-lazy-fetch", "branch", "-m", "--end-of-options", old, name]]);
    });
    git(o, ["branch", "-m", "--end-of-options", old, name]);
    expect(stateOf(f)).toEqual(stateOf(o));
    expect(git(f, ["log", "-g", "--format=%H%x00%gs", `refs/heads/${name}`, "--"])).toBe(git(o, ["log", "-g", "--format=%H%x00%gs", `refs/heads/${name}`, "--"]));
    expect(existsSync(join(f.repo, ".git", "logs", "refs", "heads", old))).toBe(false);
  }
}, TIMEOUT_MS);

caseTest(TASK, "FR-017: Delete is unavailable for the current branch and for a branch that another worktree holds, and no step starts", SHELL, async () => {
  const f = build();
  const records = git(f, ["worktree", "list", "--porcelain", "-z"]).split("\0\0").filter((r) => r !== "").map((r) => r.split("\0"));
  const holder = records.find((r) => r.includes("branch refs/heads/wt-held"))!;
  await withSync("t022-delete-unavailable", async (service) => {
    const r = await open(service, f.repo);
    expect(refused(await review(service, r, { action: "delete-branch", ref: "refs/heads/main" }))).toEqual(unavailable("current-branch"));
    expect(refused(await review(service, r, { action: "delete-branch", ref: "refs/heads/wt-held" }))).toEqual(unavailable("other-worktree", { worktree: holder[0]!.slice("worktree ".length) }));
    expect(steps(service)).toEqual([]);
  });
}, TIMEOUT_MS);

caseTest(TASK, "FR-018, research.md R21 F10, and data-model §4: onlyHere equals the commits that Git's own branch -D makes unreachable, and reflogKeeps is true only when HEAD's reflog holds the tip", SHELL, async () => {
  const f = build();
  // A checkout of `unmerged` puts its tip into HEAD's reflog.
  git(f, ["checkout", "-q", "unmerged"]);
  git(f, ["checkout", "-q", "main"]);
  const headLog = git(f, ["log", "-g", "--format=%H", "HEAD", "--"]).trim().split("\n");
  const counts: Record<string, number> = {};
  for (const branch of ["unmerged", "merged", "held", "feature/a/b"]) {
    const o = build();
    const before = reachable(o);
    git(o, ["branch", "-D", "--end-of-options", branch]);
    const after = reachable(o);
    counts[branch] = [...before].filter((c) => !after.has(c)).length;
  }
  expect(counts).toEqual({ unmerged: 2, merged: 0, held: 0, "feature/a/b": 1 });
  await withSync("t022-delete-plan", async (service) => {
    const r = await open(service, f.repo);
    for (const branch of Object.keys(counts)) {
      const tip = oid(f, `refs/heads/${branch}`);
      const rv = await reviewed(service, r, { action: "delete-branch", ref: `refs/heads/${branch}` });
      expect(rv.plan).toEqual({ ref: `refs/heads/${branch}`, oid: tip, onlyHere: counts[branch], reflogKeeps: headLog.includes(tip), heldBy: null, current: false });
    }
  });
  expect(headLog.includes(f.oids.unmerged!)).toBe(true);
  expect(headLog.includes(oid(f, "refs/heads/held"))).toBe(false);
}, TIMEOUT_MS);

caseTest(TASK, "FR-019 and SC-004: a branch that moved after the review is never deleted; before the run it gives STALE_REVIEW, during the run update-ref refuses, and no ref changes", SHELL, async () => {
  const f = build();
  await withSync("t022-moved-before", async (service) => {
    const r = await open(service, f.repo);
    const rv = await reviewed(service, r, { action: "delete-branch", ref: "refs/heads/unmerged" });
    git(f, ["update-ref", "refs/heads/unmerged", f.oids.tagged!]);
    const before = stateOf(f);
    const from = service.runner.calls.length;
    expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual({ state: "failed", code: "STALE_REVIEW" });
    expect(steps(service, from)).toEqual([]);
    expect(stateOf(f)).toEqual(before);
  });
  const g = build();
  await withSync("t022-moved-during", async (service) => {
    const r = await open(service, g.repo);
    const rv = await reviewed(service, r, { action: "delete-branch", ref: "refs/heads/unmerged" });
    const release = service.runner.holdStart((call) => call.arguments[1] === "update-ref");
    const requestId = sendRun(service, r, rv.workbenchToken);
    await until(() => service.runner.calls.some((c) => c.arguments[1] === "update-ref"), "held update-ref");
    git(g, ["update-ref", "refs/heads/unmerged", g.oids.tagged!]);
    const before = stateOf(g);
    release();
    const response = await service.response<BranchResult>(requestId);
    // The fresh reads see the external move as an effect, and `update-ref` exited nonzero, so the delete failed.
    expect(outcome(response)).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" });
    expect(response.result!.refs).toEqual([{ ref: "refs/heads/unmerged", oldObjectId: g.oids.unmerged, newObjectId: g.oids.tagged }]);
    expect(service.runner.calls.find((c) => c.arguments[1] === "update-ref")!.exit!.exitCode).not.toBe(0);
    expect(steps(service).map((a) => a[1])).toEqual(["update-ref"]);
    expect(stateOf(g)).toEqual(before);
    expect(oid(g, "refs/heads/unmerged")).toBe(g.oids.tagged!);
  });
}, TIMEOUT_MS);

caseTest(TASK, "research.md R21 F9: Delete equals Git's own branch -D in refs, reflogs, and configuration bytes", SHELL, async () => {
  for (const branch of ["unmerged", "merged"]) {
    const f = build();
    const o = build();
    const tip = f.refs[`refs/heads/${branch}`]!;
    await withSync(`t022-delete-${branch}`, async (service) => {
      const r = await open(service, f.repo);
      const from = service.runner.calls.length;
      const response = await run(service, r, { action: "delete-branch", ref: `refs/heads/${branch}` });
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(response.result!.refs).toEqual([{ ref: `refs/heads/${branch}`, oldObjectId: tip, newObjectId: null }]);
      const config = branch === "unmerged" ? [["--no-lazy-fetch", "config", "--local", "--remove-section", `branch.${branch}`]] : [];
      expect(steps(service, from)).toEqual([["--no-lazy-fetch", "update-ref", "--no-deref", "-d", `refs/heads/${branch}`, tip], ...config]);
    });
    git(o, ["branch", "-D", "--end-of-options", branch]);
    expect(stateOf(f)).toEqual(stateOf(o));
    expect(readFileSync(f.configs.local!)).toEqual(readFileSync(o.configs.local!));
    expect(existsSync(join(f.repo, ".git", "logs", "refs", "heads", branch))).toBe(existsSync(join(o.repo, ".git", "logs", "refs", "heads", branch)));
  }
}, TIMEOUT_MS);

caseTest(TASK, "FR-014: a remote-tracking branch offers no Rename and no Delete", SHELL, async () => {
  const f = build();
  await withSync("t022-remote", async (service) => {
    const r = await open(service, f.repo);
    for (const payload of [{ action: "rename-branch", ref: "refs/remotes/origin/held", name: "x" }, { action: "delete-branch", ref: "refs/remotes/origin/held" }]) {
      expect(outcome(await review(service, r, payload))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
    }
  });
}, TIMEOUT_MS);
