// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T049: worktrees (spec FR-049 to FR-057, SC-008, plan.md D10, contract Δ3 `readWorktrees`, `openWorktree`, and `reviewWorkbench` `worktree-add`, `worktree-remove`, `worktree-prune`, quickstart.md Q20).
// The oracle is Git's own command on a second build of the same fixture. The fixed fixture dates make the commit object IDs of both builds equal.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessContext } from "../../src/git-service/git-runner";
import type { ObserveContext } from "../../src/git-service/hunk-publish";
import type { Workspace } from "../../src/git-service/registration";
import { STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, removeTree, serviceEnv, useFixtureRoot } from "./fixture-root";
import { put } from "./fixtures";
import { sha256, workingFileDigests } from "./git-oracle";
import { caseTest, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { gitExe, native, TIMEOUT_MS, until, withSync } from "./sync-harness";
import { buildWorkbench, canary, repoOf, wb, type WbFixture } from "./workbench-fixtures";

for (const module of ["worktrees", "workbench-review", "branch-ops", "session"]) {
  printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
}
// The module-level cases call `worktrees.ts` directly. `session.ts` imports it too, so the session cases reach the same actions.
const worktrees = await import("../../src/git-service/worktrees");

useFixtureRoot();

const TASK = "T049";
const SHELL = ["shell-double"] as const;
const L = "--no-lazy-fetch";
const SUCCEEDED = { state: "succeeded", code: undefined };
const PRUNABLE_REASON = "gitdir file points to non-existent location";
const outcome = (r: { state: string; code?: string }) => ({ state: r.state, code: r.code });
const unavailable = (reason: string, extra: object = {}) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason, ...extra } });
const refused = (response: ServiceResponse<unknown>) => ({ ...outcome(response), result: response.result });

interface Reviewed {
  action: string;
  plan: Record<string, unknown>;
  workbenchToken: string;
}

interface WorktreeRun {
  action: string;
  head: { state: string; target?: string; oid?: string };
  refs: { ref: string }[];
  outputTail?: string;
}

let builds = 0;
const build = (): WbFixture => buildWorkbench(gitExe(), "worktrees", `t049-worktrees-${++builds}`);
const git = (f: WbFixture, args: string[], allowExit: number[] = [0], dir = f.repo) => wb(repoOf(f, dir), args, { allowExit }).stdout.toString("utf8");
const oid = (f: WbFixture, rev: string) => git(f, ["rev-parse", "--verify", "-q", rev]).trim();
const slash = (p: string) => p.replaceAll("\\", "/");
const folder = (f: WbFixture, name: string) => join(f.root, name);

// The records of Git's own `worktree list --porcelain -z`: each line ends with NUL, and one more NUL ends the record.
const recordsOf = (f: WbFixture): string[][] =>
  git(f, ["worktree", "list", "--porcelain", "-z"])
    .split("\0\0")
    .filter((r) => r !== "")
    .map((r) => r.split("\0"));
const valueOf = (lines: string[], label: string): string | null | undefined => {
  const line = lines.find((l) => l === label || l.startsWith(`${label} `));
  return line === undefined ? undefined : line === label ? null : line.slice(label.length + 1);
};
// The record path that Git prints for a fixture folder.
const recordPath = (f: WbFixture, name: string): string => {
  const path = recordsOf(f)
    .map((r) => valueOf(r, "worktree")!)
    .find((p) => slash(p).toLowerCase() === slash(folder(f, name)).toLowerCase());
  if (path === undefined) throw new Error(`no worktree record for ${name}`);
  return path;
};

// Data-model §8 from Git's own list. `current` names the record path of the opened worktree.
function oracleEntries(f: WbFixture, current: string) {
  return recordsOf(f).map((lines, i) => {
    const flag = (label: string) => valueOf(lines, label) !== undefined;
    const reason = (label: string) => (flag(label) ? { reason: valueOf(lines, label) ?? null } : null);
    const path = valueOf(lines, "worktree")!;
    // Data-model §8 `headUnresolved`: a record without `bare`, `branch`, and `detached`.
    const unresolved = !flag("bare") && !flag("branch") && !flag("detached");
    return { path, invalidUtf8: false, head: unresolved ? null : (valueOf(lines, "HEAD") ?? null), branch: valueOf(lines, "branch") ?? null, bare: flag("bare"), detached: flag("detached"), headUnresolved: unresolved, locked: reason("locked"), prunable: reason("prunable"), main: i === 0, current: path === current };
  });
}

// SC-008: the worktree list, the refs, every HEAD, the administration files, and the configuration bytes. Paths below the fixture root compare as `<root>`.
function stateOf(f: WbFixture) {
  const norm = (text: string) => text.replaceAll(slash(f.root), "<root>").replaceAll(f.root, "<root>");
  const admin = join(f.repo, ".git", "worktrees");
  const records = recordsOf(f);
  return {
    list: norm(records.map((r) => r.join("\n")).join("\n\n")),
    refs: git(f, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    head: git(f, ["symbolic-ref", "-q", "HEAD"], [0, 1]),
    admin: existsSync(admin)
      ? readdirSync(admin)
          .sort()
          .map((id) => ({ id, files: readdirSync(join(admin, id)).filter((n) => ["gitdir", "HEAD", "locked", "commondir"].includes(n)).sort().map((n) => `${n}=${norm(readFileSync(join(admin, id, n), "utf8"))}`) }))
      : [],
    links: records.slice(1).map((r) => {
      const dir = valueOf(r, "worktree")!;
      return existsSync(join(dir, ".git")) ? norm(readFileSync(join(dir, ".git"), "utf8")) : "absent";
    }),
    files: records.map((r) => {
      const dir = valueOf(r, "worktree")!;
      return existsSync(dir) ? workingFileDigests(dir) : "absent";
    }),
    config: sha256(readFileSync(f.configs.local!)),
  };
}

// The counts of Git's own status of one worktree: changed, renamed, and unmerged records are tracked changes.
function statusCounts(f: WbFixture, dir: string): { tracked: number; untracked: number } {
  const fields = git(f, ["-C", dir, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]).split("\0").filter((x) => x !== "");
  let tracked = 0;
  let untracked = 0;
  for (let i = 0; i < fields.length; i++) {
    const kind = fields[i]!.slice(0, 2);
    if (kind === "? ") untracked++;
    else if (kind === "1 " || kind === "u ") tracked++;
    else if (kind === "2 ") {
      tracked++;
      i++;
    }
  }
  return { tracked, untracked };
}

async function open(service: Service, dir: string): Promise<RegistrationResult> {
  const r = await service.register(native(dir));
  const trust = await service.readTrust(r.repositoryId);
  if (trust.result!.approvalRequired.workbench) expect((await service.approveTrust(r.repositoryId)).state).toBe("succeeded");
  return r;
}

const review = (service: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<unknown>> => service.request("reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });

async function reviewed(service: Service, r: RegistrationResult, payload: object): Promise<Reviewed> {
  const response = await review(service, r, payload);
  expect({ ...outcome(response), result: response.state === "succeeded" ? "result" : response.result }).toEqual({ ...SUCCEEDED, result: "result" });
  return response.result as Reviewed;
}

const steps = (service: Service, from = 0) => service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [...c.arguments]);
const addPayload = (branch: object, bootstrapId: string) => ({ action: "worktree-add", branch, bootstrapId });
const removePayload = (worktree: string, force: boolean, deleteBranch: boolean) => ({ action: "worktree-remove", worktree, force, deleteBranch });

// The module-level context of `worktrees.ts`: the registered workspace as the service holds it, with the identity of its worktree root.
async function moduleContext(service: Service, r: RegistrationResult): Promise<ObserveContext> {
  let gitInstallationId: string | undefined;
  const release = service.runner.holdStart((call) => {
    gitInstallationId ??= (call as unknown as { context: { gitInstallationId?: string } }).context.gitInstallationId;
    return false;
  });
  const read = await service.readWorkspace(r.repositoryId);
  release();
  expect(read.state).toBe("succeeded");
  const { worktreeRoot, gitDirectory, commonDirectory, indexPath, objectFormat, refFormat } = read.result!.identity;
  const signal = new AbortController().signal;
  const context: ProcessContext = { contextKind: "registeredOperation", gitInstallationId: gitInstallationId!, repositoryId: r.repositoryId };
  const ids = await service.runner.identities(crypto.randomUUID(), context, [worktreeRoot, gitDirectory, commonDirectory], signal);
  if (!Array.isArray(ids)) throw new Error("identity walk stopped");
  const workspace = { repositoryId: r.repositoryId, gitInstallationId, worktreeRoot, gitDirectory, commonDirectory, indexPath, objectFormat, refFormat, generation: read.result!.generation, worktreeIdentity: [ids[0], ids[1]], commonIdentity: ids[2] } as unknown as Workspace;
  return { runner: service.runner, operationId: crypto.randomUUID(), signal, workspace } as unknown as ObserveContext;
}
const fresh = (ctx: ObserveContext): ObserveContext => ({ ...ctx, operationId: crypto.randomUUID() });

caseTest(TASK, "FR-049 and data-model §8: readWorktrees equals Git's own list, marks the first record as main and the opened worktree as current, and sends at most 8 paths per identity request", SHELL, async () => {
  const f = build();
  // Nine records give two identity requests.
  for (const n of [1, 2, 3]) git(f, ["worktree", "add", "-q", "--detach", "--", folder(f, `wt-extra-${n}`), f.oids.base!]);
  expect(recordsOf(f).length).toBe(9);
  await withSync("t049-read", async (service) => {
    const r = await open(service, f.repo);
    const ctx = await moduleContext(service, r);
    const read = await worktrees.readWorktreeList(ctx);
    expect("value" in read).toBe(true);
    const listed = (read as { value: { entries: unknown[] } }).value.entries;
    expect(listed).toEqual(oracleEntries(f, recordsOf(f).map((x) => valueOf(x, "worktree")!)[0]!));
    const sizes = service.runner.identityCalls.filter((c) => c.operationId === ctx.operationId).map((c) => c.paths.length);
    expect(sizes).toEqual([8, 1]);
    // The locked reasons and the prunable reason come unquoted (research.md R21 F20). Git lists `wt-locked` before `wt-locked-reason`.
    expect(listed.filter((e) => (e as { locked: unknown }).locked !== null).map((e) => (e as { locked: unknown }).locked)).toEqual([{ reason: null }, { reason: "fixture reason\nwith newline" }]);
    expect(listed.filter((e) => (e as { prunable: unknown }).prunable !== null).map((e) => (e as { prunable: unknown }).prunable)).toEqual([{ reason: PRUNABLE_REASON }]);

    const spaces = await service.register(native(folder(f, "wt with spaces")));
    const other = await worktrees.readWorktreeList(await moduleContext(service, spaces));
    expect((other as { value: { entries: unknown[] } }).value.entries).toEqual(oracleEntries(f, recordPath(f, "wt with spaces")));
  });
}, TIMEOUT_MS);

caseTest(TASK, "FR-052, FR-053, and SC-008: Add worktree with a new branch and with an existing branch equals Git's own worktree add on a copy and changes no configuration byte", SHELL, async () => {
  for (const variant of ["new", "existing"] as const) {
    const f = build();
    const o = build();
    for (const x of [f, o]) git(x, ["branch", "free", x.oids.base!]);
    // An empty folder is a valid destination (contract Δ3 `worktree-add`).
    if (variant === "existing") for (const x of [f, o]) mkdirSync(folder(x, "wt-new"));
    const global = sha256(readFileSync(FIXTURE_GLOBAL_CONFIG));
    const dest = folder(f, "wt-new");
    const start = f.oids.base!;
    const branch = variant === "new" ? { new: "new-b", start } : { existing: "refs/heads/free" };
    await withSync(`t049-add-${variant}`, async (service) => {
      const r = await open(service, f.repo);
      const rv = await reviewed(service, r, addPayload(branch, service.runner.addWorktreeAdd(dest, r.repositoryId)));
      expect(rv.plan).toEqual({ branch: variant === "new" ? branch : { existing: "refs/heads/free", oid: start }, path: dest, destination: variant === "new" ? "absent" : "empty" });
      const from = service.runner.calls.length;
      const response = await service.response<WorktreeRun>(sendRun(service, r, rv.workbenchToken));
      expect(outcome(response)).toEqual(SUCCEEDED);
      const run = service.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate");
      expect(run.map((c) => [c.contextKind, ...c.arguments])).toEqual([variant === "new" ? ["worktreeAdd", L, "worktree", "add", "-b", "new-b", "--", dest, start] : ["worktreeAdd", L, "worktree", "add", "--", dest, "free"]]);
      expect(response.result!.refs).toEqual(variant === "new" ? [{ ref: "refs/heads/new-b" }] : []);
      expect(response.result!.head).toEqual({ state: "branch", target: "refs/heads/main", oid: start });
    });
    git(o, variant === "new" ? ["worktree", "add", "-q", "-b", "new-b", "--", folder(o, "wt-new"), start] : ["worktree", "add", "-q", "--", folder(o, "wt-new"), "free"]);
    expect(stateOf(f)).toEqual(stateOf(o));
    expect(sha256(readFileSync(f.configs.local!))).toBe(f.digests.local!);
    expect(sha256(readFileSync(FIXTURE_GLOBAL_CONFIG))).toBe(global);
    expect(wb(repoOf(f), ["config", "--get", "worktree.useRelativePaths"], { allowExit: [1] }).exitCode).toBe(1);
  }
}, TIMEOUT_MS);

caseTest(TASK, "FR-052 and plan.md D4: refs/heads/@ and a new @ give reserved-name before any Git process, held branches give current-branch and other-worktree, and a folder that is not empty gives DESTINATION_NOT_EMPTY; no worktree add starts", SHELL, async () => {
  const f = build();
  git(f, ["update-ref", "refs/heads/@", f.oids.base!]);
  const before = stateOf(f);
  // Git refuses a branch that another worktree holds, also a branch of a prunable record (builtin/worktree.c `die_if_checked_out`).
  const o = build();
  expect(wb(repoOf(o), ["worktree", "add", "--", folder(o, "wt-x"), "prunable-b"], { allowExit: "any" }).exitCode).toBe(128);
  put(f.root, "wt-full/keep.txt", "keep\n");
  put(f.root, "wt-file", "file\n");
  await withSync("t049-add-refused", async (service) => {
    const r = await open(service, f.repo);
    for (const branch of [{ existing: "refs/heads/@" }, { new: "@", start: f.oids.base! }]) {
      const from = service.runner.calls.length;
      expect(refused(await review(service, r, addPayload(branch, service.runner.addWorktreeAdd(folder(f, "wt-new"), r.repositoryId))))).toEqual(unavailable("reserved-name"));
      expect(service.runner.calls.length).toBe(from);
    }
    const add = (branch: object, name = "wt-new") => review(service, r, addPayload(branch, service.runner.addWorktreeAdd(folder(f, name), r.repositoryId)));
    expect(refused(await add({ existing: "refs/heads/main" }))).toEqual(unavailable("current-branch"));
    expect(refused(await add({ existing: "refs/heads/dirty-b" }))).toEqual(unavailable("other-worktree", { worktree: recordPath(f, "wt-dirty") }));
    expect(refused(await add({ existing: "refs/heads/prunable-b" }))).toEqual(unavailable("other-worktree", { worktree: recordPath(f, "wt-prunable") }));
    expect(refused(await add({ existing: "refs/heads/absent" }))).toEqual({ state: "failed", code: "UNKNOWN_TARGET", result: undefined });
    expect(refused(await add({ new: "main", start: f.oids.base! }))).toEqual(unavailable("name-exists", { ref: "refs/heads/main" }));
    expect(refused(await add({ new: "fresh", start: f.oids.base! }, "wt-full"))).toEqual({ state: "failed", code: "DESTINATION_NOT_EMPTY", result: { reason: "not-empty" } });
    expect(refused(await add({ new: "fresh", start: f.oids.base! }, "wt-file"))).toEqual({ state: "failed", code: "DESTINATION_NOT_EMPTY", result: { reason: "file" } });
    // An `error` reply is no destination type, so it refuses as feature 003 `clone` step 2 does.
    service.runner.inject.worktreeAddFacts = () => ({ result: "error", code: "access-denied" });
    expect(refused(await add({ new: "fresh", start: f.oids.base! }, "wt-denied"))).toEqual({ state: "failed", code: "REPOSITORY_UNAVAILABLE", result: { path: folder(f, "wt-denied") } });
    service.runner.inject.worktreeAddFacts = null;
    expect(steps(service)).toEqual([]);
  });
  expect(stateOf(f)).toEqual(before);
}, TIMEOUT_MS);

caseTest(TASK, "FR-054: Remove is unavailable for the main, the current, a locked, and a prunable worktree, and a path that no fresh record names gives UNKNOWN_TARGET; no step starts", SHELL, async () => {
  const f = build();
  const before = stateOf(f);
  await withSync("t049-remove-unavailable", async (service) => {
    const r = await open(service, f.repo);
    expect(refused(await review(service, r, removePayload(recordPath(f, "repo"), true, true)))).toEqual(unavailable("main-worktree"));
    for (const name of ["wt-locked-reason", "wt-locked"]) expect(refused(await review(service, r, removePayload(recordPath(f, name), true, false)))).toEqual(unavailable("locked"));
    // The folder of a prunable record is missing, so no Git process runs in it. Prune removes the record (FR-057).
    const prunable = recordPath(f, "wt-prunable");
    expect(refused(await review(service, r, removePayload(prunable, true, true)))).toEqual(unavailable("prunable"));
    expect(service.runner.calls.some((c) => c.arguments.includes(prunable))).toBe(false);
    expect(refused(await review(service, r, removePayload(slash(folder(f, "wt-none")), false, false)))).toEqual({ state: "failed", code: "UNKNOWN_TARGET", result: undefined });
    const spaces = await open(service, folder(f, "wt with spaces"));
    expect(refused(await review(service, spaces, removePayload(recordPath(f, "wt with spaces"), false, false)))).toEqual(unavailable("current-worktree"));
    expect(refused(await review(service, spaces, removePayload(recordPath(f, "repo"), false, false)))).toEqual(unavailable("main-worktree"));
    expect(steps(service)).toEqual([]);
  });
  expect(stateOf(f)).toEqual(before);
}, TIMEOUT_MS);

caseTest(TASK, "FR-055 and SC-008: a dirty worktree states both counts and needs force: true; then the remove equals Git's own worktree remove --force on a copy", SHELL, async () => {
  const f = build();
  const o = build();
  const dirty = recordPath(f, "wt-dirty");
  const counts = statusCounts(f, folder(f, "wt-dirty"));
  expect(counts).toEqual({ tracked: 1, untracked: 1 });
  const files = workingFileDigests(folder(f, "wt-dirty"));
  await withSync("t049-remove-dirty", async (service) => {
    const r = await open(service, f.repo);
    const plan = { worktree: dirty, branch: "refs/heads/dirty-b", head: f.oids.base, ...counts, force: false, deleteBranch: null, submodules: false };
    expect(refused(await review(service, r, removePayload(dirty, false, false)))).toEqual(unavailable("dirty-tree", { plan }));
    expect(workingFileDigests(folder(f, "wt-dirty"))).toEqual(files);
    expect(steps(service)).toEqual([]);
    const rv = await reviewed(service, r, removePayload(dirty, true, false));
    expect(rv.plan).toEqual({ ...plan, force: true });
    const from = service.runner.calls.length;
    const response = await service.response<WorktreeRun>(sendRun(service, r, rv.workbenchToken));
    expect(outcome(response)).toEqual(SUCCEEDED);
    expect(steps(service, from)).toEqual([[L, "worktree", "remove", "--force", "--", dirty]]);
    expect(recordsOf(f).map((x) => valueOf(x, "worktree"))).not.toContain(dirty);
  });
  git(o, ["worktree", "remove", "--force", "--", recordPath(o, "wt-dirty")]);
  expect(stateOf(f)).toEqual(stateOf(o));
  expect(existsSync(folder(f, "wt-dirty"))).toBe(false);
}, TIMEOUT_MS);

caseTest(TASK, "FR-055: a clean worktree gets no --force, a changed status before the start gives STALE_REVIEW, and Git's own refusal guards a change after the re-read, so no branch delete runs", SHELL, async () => {
  const f = build();
  const spaces = recordPath(f, "wt with spaces");
  const dir = folder(f, "wt with spaces");
  await withSync("t049-remove-stale", async (service) => {
    const r = await open(service, f.repo);
    // Contract Δ3: `--force` goes only with the check box, and only for a worktree with changes.
    expect((await reviewed(service, r, removePayload(spaces, true, false))).plan).toMatchObject({ tracked: 0, untracked: 0, force: false });
    for (const change of [() => put(dir, "new.txt", "new\n"), () => put(dir, "w.txt", "w changed\n")]) {
      const rv = await reviewed(service, r, removePayload(spaces, true, false));
      change();
      const files = workingFileDigests(dir);
      const from = service.runner.calls.length;
      expect(outcome(await service.response(sendRun(service, r, rv.workbenchToken)))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(steps(service, from)).toEqual([]);
      expect(workingFileDigests(dir)).toEqual(files);
    }
    git(f, ["checkout", "-q", "--", "w.txt"], [0], dir);
    git(f, ["clean", "-q", "-f", "--", "new.txt"], [0], dir);
    const rv = await reviewed(service, r, removePayload(spaces, false, true));
    const release = service.runner.holdStart((call) => call.arguments[1] === "worktree" && call.arguments[2] === "remove");
    const requestId = sendRun(service, r, rv.workbenchToken);
    await until(() => service.runner.calls.some((c) => c.arguments[1] === "worktree" && c.arguments[2] === "remove"), "held worktree remove");
    put(dir, "late.txt", "late\n");
    release();
    const response = await service.response<WorktreeRun>(requestId);
    expect(outcome(response)).toEqual({ state: "failed", code: "GIT_FAILED" });
    expect(steps(service).slice(-1)).toEqual([[L, "worktree", "remove", "--", spaces]]);
    expect(steps(service).some((a) => a[1] === "update-ref")).toBe(false);
    expect(readFileSync(join(dir, "late.txt"), "utf8")).toBe("late\n");
    expect(oid(f, "refs/heads/spaces-b")).toBe(f.oids.base!);
    expect(recordsOf(f).some((x) => valueOf(x, "worktree") === spaces)).toBe(true);
  });
}, TIMEOUT_MS);

caseTest(TASK, "FR-056, FR-018, and SC-008: Also delete the branch runs the D4 delete after a fresh list confirms the removal, states the commits only the branch holds, and equals Git's own remove and branch -D", SHELL, async () => {
  for (const variant of ["merged", "unmerged"] as const) {
    const f = build();
    const o = build();
    // A commit in the worktree that only its branch holds. The fixed dates give both builds the same object ID.
    if (variant === "unmerged")
      for (const x of [f, o]) {
        put(folder(x, "wt with spaces"), "only.txt", "only here\n");
        git(x, ["add", "--", "only.txt"], [0], folder(x, "wt with spaces"));
        git(x, ["commit", "-q", "-m", "only here"], [0], folder(x, "wt with spaces"));
      }
    const spaces = recordPath(f, "wt with spaces");
    const tip = oid(f, "refs/heads/spaces-b");
    expect(tip).toBe(oid(o, "refs/heads/spaces-b"));
    const reachable = (x: WbFixture) => new Set(git(x, ["rev-list", "--branches", "--tags", "--remotes"]).trim().split("\n"));
    const all = reachable(o);
    const headLog = git(f, ["log", "-g", "--format=%H", "HEAD", "--"]).trim().split("\n");
    await withSync(`t049-remove-branch-${variant}`, async (service) => {
      const r = await open(service, f.repo);
      const rv = await reviewed(service, r, removePayload(spaces, false, true));
      expect(rv.plan.deleteBranch).toEqual({ ref: "refs/heads/spaces-b", oid: tip, onlyHere: variant === "merged" ? 0 : 1, reflogKeeps: headLog.includes(tip) });
      const from = service.runner.calls.length;
      const response = await service.response<WorktreeRun>(sendRun(service, r, rv.workbenchToken));
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(steps(service, from)).toEqual([[L, "worktree", "remove", "--", spaces], [L, "update-ref", "--no-deref", "-d", "refs/heads/spaces-b", tip]]);
      // The fresh list read comes between the remove and the delete.
      const calls = service.runner.calls.slice(from).map((c) => c.arguments.join(" "));
      const removeAt = calls.findIndex((c) => c.includes("worktree remove"));
      const listAt = calls.findIndex((c, i) => i > removeAt && c.endsWith("worktree list --porcelain -z"));
      expect(removeAt < listAt && listAt < calls.findIndex((c) => c.includes("update-ref"))).toBe(true);
      expect(response.result!.refs).toEqual([{ ref: "refs/heads/spaces-b" }]);
    });
    git(o, ["worktree", "remove", "--", recordPath(o, "wt with spaces")]);
    git(o, ["branch", "-D", "--end-of-options", "spaces-b"]);
    expect(stateOf(f)).toEqual(stateOf(o));
    expect(readFileSync(f.configs.local!)).toEqual(readFileSync(o.configs.local!));
    expect([...all].filter((c) => !reachable(o).has(c)).length).toBe(variant === "merged" ? 0 : 1);
  }
}, TIMEOUT_MS);

caseTest(TASK, "FR-056 and plan.md D4: Also delete the branch is unavailable for a detached worktree, and remove refuses a branch that another worktree also holds", SHELL, async () => {
  const f = build();
  git(f, ["worktree", "add", "-q", "--detach", "--", folder(f, "wt-detached"), f.oids.base!]);
  // `--force` lets Git check out a branch in a second worktree (git-worktree(1) `add --force`).
  git(f, ["worktree", "add", "-q", "--force", "--", folder(f, "wt-twice"), "spaces-b"]);
  const before = stateOf(f);
  await withSync("t049-remove-branch-refused", async (service) => {
    const r = await open(service, f.repo);
    expect(refused(await review(service, r, removePayload(recordPath(f, "wt-detached"), false, true)))).toEqual(unavailable("detached"));
    expect(refused(await review(service, r, removePayload(recordPath(f, "wt-twice"), false, true)))).toEqual(unavailable("other-worktree", { worktree: recordPath(f, "wt with spaces") }));
    expect(steps(service)).toEqual([]);
  });
  expect(stateOf(f)).toEqual(before);
}, TIMEOUT_MS);

caseTest(TASK, "FR-057 and SC-008: Prune runs only with a prunable record and equals Git's own worktree prune, which skips a locked record; then nothing-to-prune", SHELL, async () => {
  const f = build();
  const o = build();
  // A locked worktree without its folder: Git prints `locked` and no `prunable`, and prune keeps it (builtin/worktree.c `prune`).
  for (const x of [f, o]) removeTree(folder(x, "wt-locked"));
  expect(existsSync(folder(f, "wt-locked"))).toBe(false);
  const locked = recordsOf(f).find((x) => valueOf(x, "worktree") === recordPath(f, "wt-locked"))!;
  expect([valueOf(locked, "locked"), valueOf(locked, "prunable")]).toEqual([null, undefined]);
  await withSync("t049-prune", async (service) => {
    const r = await open(service, f.repo);
    const rv = await reviewed(service, r, { action: "worktree-prune" });
    expect(rv.plan).toEqual({ prunable: [{ path: recordPath(f, "wt-prunable"), reason: PRUNABLE_REASON }] });
    const from = service.runner.calls.length;
    const response = await service.response<WorktreeRun>(sendRun(service, r, rv.workbenchToken));
    expect(outcome(response)).toEqual(SUCCEEDED);
    expect(steps(service, from)).toEqual([[L, "worktree", "prune"]]);
    const next = service.runner.calls.length;
    expect(refused(await review(service, r, { action: "worktree-prune" }))).toEqual(unavailable("nothing-to-prune"));
    expect(steps(service, next)).toEqual([]);
  });
  git(o, ["worktree", "prune"]);
  expect(stateOf(f)).toEqual(stateOf(o));
  expect(recordsOf(f).some((x) => valueOf(x, "worktree") === recordPath(f, "wt-locked"))).toBe(true);
}, TIMEOUT_MS);

caseTest(TASK, "FR-051 and contract Δ3 openWorktree: the bound path must have the identity of a record of a fresh list, else UNKNOWN_TARGET", SHELL, async () => {
  const f = build();
  mkdirSync(join(folder(f, "wt-dirty"), "sub"));
  mkdirSync(folder(f, "elsewhere"));
  await withSync("t049-open", async (service) => {
    const r = await open(service, f.repo);
    const ctx = await moduleContext(service, r);
    const bind = (path: string) => ({ context: { contextKind: "repositoryDiscovery" as const, bootstrapId: service.runner.addContext("repositoryDiscovery", native(path)), gitInstallationId: ctx.workspace.gitInstallationId }, path: native(path) });
    const found = await worktrees.openWorktreeTarget(fresh(ctx), bind(folder(f, "wt-dirty")));
    expect("value" in found && found.value.path).toBe(recordPath(f, "wt-dirty"));
    for (const path of [join(folder(f, "wt-dirty"), "sub"), folder(f, "elsewhere"), folder(f, "wt-prunable")]) expect(await worktrees.openWorktreeTarget(fresh(ctx), bind(path))).toEqual({ refused: "UNKNOWN_TARGET" });
    // A record that Git removes after the native step: the fresh list decides.
    const late = bind(folder(f, "wt with spaces"));
    git(f, ["worktree", "remove", "--", recordPath(f, "wt with spaces")]);
    mkdirSync(folder(f, "wt with spaces"));
    expect(await worktrees.openWorktreeTarget(fresh(ctx), late)).toEqual({ refused: "UNKNOWN_TARGET" });
  });
}, TIMEOUT_MS);

// ---- T060: the session handlers and the per-worktree trust of plan.md O-20 ----

caseTest("T060", "FR-049 and contract Δ3 readWorktrees through the session: the result equals Git's own list, and a stale generation gives REPOSITORY_CHANGED before any Git process", SHELL, async () => {
  const f = build();
  await withSync("t060-read", async (service) => {
    const r = await open(service, f.repo);
    const read = await service.request<{ entries: unknown[] }>("readWorktrees", {}, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
    expect(outcome(read)).toEqual(SUCCEEDED);
    expect(read.result!.entries).toEqual(oracleEntries(f, recordsOf(f).map((x) => valueOf(x, "worktree")!)[0]!));
    const from = service.runner.calls.length;
    expect(outcome(await service.request("readWorktrees", {}, { repositoryId: r.repositoryId, repositoryGeneration: r.generation + 1 }))).toEqual({ state: "rejected", code: "REPOSITORY_CHANGED" });
    expect(service.runner.calls.length).toBe(from);
  });
}, TIMEOUT_MS);

caseTest("T060", "FR-051 and contract Δ3 openWorktree through the session: a bound worktree folder registers through the 001 flow; a folder that no record names gives UNKNOWN_TARGET, and an unknown repository is rejected", SHELL, async () => {
  const f = build();
  mkdirSync(folder(f, "elsewhere"));
  await withSync("t060-open", async (service) => {
    const r = await open(service, f.repo);
    const send = (path: string, repositoryId = r.repositoryId) => service.request<RegistrationResult>("openWorktree", { repositoryId, bootstrapId: service.runner.addContext("repositoryDiscovery", native(path)) });
    const opened = await send(folder(f, "wt with spaces"));
    expect(outcome(opened)).toEqual(SUCCEEDED);
    expect(slash(opened.result!.worktreeRoot).toLowerCase()).toBe(slash(recordPath(f, "wt with spaces")).toLowerCase());
    const list = await service.request<{ entries: { path: string; current: boolean }[] }>("readWorktrees", {}, { repositoryId: opened.result!.repositoryId, repositoryGeneration: opened.result!.generation });
    expect(list.result!.entries.filter((e) => e.current).map((e) => e.path)).toEqual([recordPath(f, "wt with spaces")]);
    expect(outcome(await send(folder(f, "elsewhere"), opened.result!.repositoryId))).toEqual({ state: "failed", code: "UNKNOWN_TARGET" });
    expect(outcome(await send(folder(f, "wt-dirty"), crypto.randomUUID()))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
    // T384, 001 contract §6 "Registration reuse and release": the open of another worktree released the left one.
    expect(outcome(await send(folder(f, "wt-dirty")))).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
  });
}, TIMEOUT_MS);

// Research.md R21 F18: Git runs `core.fsmonitor` of the target worktree for its `-C <path> status` read and for `worktree remove`.
// The monitor sits in the `config.worktree` file of that worktree, so the listing of the opened worktree does not name it.
caseTest("T060", "plan.md O-20: worktree-remove takes the trust listing of the target worktree; a monitor in that worktree's own configuration gives TRUST_REQUIRED before its status read, and its canary runs only after that worktree's approval", SHELL, async () => {
  const plant = (x: WbFixture) => {
    const log = canary(x.root, "o20-monitor");
    git(x, ["config", "extensions.worktreeConfig", "true"]);
    git(x, ["config", "--worktree", "core.fsmonitor", log.command], [0], folder(x, "wt with spaces"));
    return log.log;
  };
  const f = build();
  const o = build();
  const log = plant(f);
  // Git's own status in that worktree of the copy runs the monitor, so the canary is live.
  const live = plant(o);
  git(o, ["-C", folder(o, "wt with spaces"), "status", "--porcelain"]);
  expect(existsSync(live)).toBe(true);
  const target = recordPath(f, "wt with spaces");
  await withSync("t060-o20", async (service) => {
    const r = await open(service, f.repo);
    expect((await service.readTrust(r.repositoryId)).result!.approvalRequired.workbench).toBe(false);
    const from = service.runner.calls.length;
    // Contract Δ3: the refusal names the gate of that worktree, so the renderer asks nothing for this repository.
    expect(refused(await review(service, r, removePayload(target, false, false)))).toEqual({ state: "failed", code: "TRUST_REQUIRED", result: { trustGate: "target" } });
    expect(service.runner.calls.slice(from).some((c) => c.arguments.includes("status"))).toBe(false);
    expect(existsSync(log)).toBe(false);
    // That worktree as its own workspace: its listing names the monitor, and its approval binds its own folders.
    // 001 contract §6 "Registration reuse and release": each open releases the other worktree, so the review runs in a new registration of the repository.
    const own = await service.register(native(folder(f, "wt with spaces")));
    expect((await service.readTrust(own.repositoryId)).result!.approvalRequired.workbench).toBe(true);
    expect((await service.approveTrust(own.repositoryId, "worktree")).state).toBe("succeeded");
    expect(existsSync(log)).toBe(false);
    const again = await open(service, f.repo);
    const rv = await reviewed(service, again, removePayload(target, false, false));
    expect(rv.plan).toMatchObject({ worktree: target, tracked: 0, untracked: 0, force: false });
    expect(existsSync(log)).toBe(true);
    const response = await service.response<WorktreeRun>(sendRun(service, again, rv.workbenchToken));
    expect(outcome(response)).toEqual(SUCCEEDED);
    expect(recordsOf(f).map((x) => valueOf(x, "worktree"))).not.toContain(target);
  });
}, TIMEOUT_MS);

caseTest("T060", "plan.md O-20: a target worktree approval that ends between the review and the run refuses the run with TRUST_REQUIRED and the gate target, and the worktree stays", SHELL, async () => {
  const f = build();
  const log = canary(f.root, "o20-run-monitor");
  git(f, ["config", "extensions.worktreeConfig", "true"]);
  git(f, ["config", "--worktree", "core.fsmonitor", log.command], [0], folder(f, "wt with spaces"));
  const target = recordPath(f, "wt with spaces");
  await withSync("t060-o20-run", async (service) => {
    // 001 contract §6 "Registration reuse and release": each open releases the other worktree.
    // 001 contract §7 `revoke`: Stop trusting in the repository ends the approval of every worktree of its common folder.
    const own = await service.register(native(folder(f, "wt with spaces")));
    expect((await service.approveTrust(own.repositoryId, "worktree")).state).toBe("succeeded");
    const r = await open(service, f.repo);
    const approved = await service.approveTrust(r.repositoryId);
    expect(approved.state).toBe("succeeded");
    const rv = await reviewed(service, r, removePayload(target, false, false));
    expect((await service.revokeTrust(r.repositoryId, (approved.result as { trustId: string }).trustId)).state).toBe("succeeded");
    const from = service.runner.calls.length;
    const response = await service.response(sendRun(service, r, rv.workbenchToken));
    expect(refused(response)).toEqual({ state: "failed", code: "TRUST_REQUIRED", result: { trustGate: "target" } });
    expect(steps(service, from)).toEqual([]);
  });
  expect(recordsOf(f).some((rec) => valueOf(rec, "worktree") === target)).toBe(true);
}, TIMEOUT_MS);

caseTest("T060", "plan.md O-20: a monitor in this repository's configuration refuses worktree-remove with TRUST_REQUIRED and the gate repository before any worktree read, and the canary does not run", SHELL, async () => {
  const f = build();
  const log = canary(f.root, "o20-own-monitor");
  git(f, ["config", "core.fsmonitor", log.command]);
  const target = recordPath(f, "wt with spaces");
  await withSync("t060-o20-own", async (service) => {
    const r = await service.register(native(f.repo));
    expect((await service.readTrust(r.repositoryId)).result!.approvalRequired.workbench).toBe(true);
    const from = service.runner.calls.length;
    expect(refused(await review(service, r, removePayload(target, false, false)))).toEqual({ state: "failed", code: "TRUST_REQUIRED", result: { trustGate: "repository" } });
    expect(service.runner.calls.slice(from).some((c) => c.arguments.includes("worktree"))).toBe(false);
  });
  expect(existsSync(log.log)).toBe(false);
}, TIMEOUT_MS);

// git-worktree(1) `remove`: "Unclean worktrees or ones with submodules can be removed with --force." builtin/worktree.c `validate_no_submodules` refuses
// a worktree whose administration folder holds `modules`, or whose index holds a gitlink of a populated submodule.
caseTest("T060", "FR-055 and git-worktree(1): a clean worktree with an initialized submodule states it in the plan and needs force: true; then the remove equals Git's own worktree remove --force on a copy", SHELL, async () => {
  const withSubmodule = (x: WbFixture) => {
    const origin = join(x.root, "sub-origin");
    mkdirSync(origin, { recursive: true });
    git(x, ["init", "-q", "-b", "main"], [0], origin);
    put(origin, "s.txt", "sub\n");
    git(x, ["add", "--", "s.txt"], [0], origin);
    git(x, ["commit", "-q", "-m", "sub"], [0], origin);
    const dir = folder(x, "wt with spaces");
    // git-submodule(1): without a remote, a relative URL resolves against the working folder, so both builds write the same `.gitmodules`.
    git(x, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", "--", "../sub-origin", "lib"], [0], dir);
    git(x, ["commit", "-q", "-m", "add lib"], [0], dir);
    // The local configuration holds the absolute URL of each build. Git's submodule check reads no such key.
    git(x, ["config", "--remove-section", "submodule.lib"]);
  };
  const f = build();
  const o = build();
  for (const x of [f, o]) withSubmodule(x);
  expect(statusCounts(f, folder(f, "wt with spaces"))).toEqual({ tracked: 0, untracked: 0 });
  // Git's own remove without --force refuses on the copy, and the worktree stays.
  expect(wb(repoOf(o), ["worktree", "remove", "--", recordPath(o, "wt with spaces")], { allowExit: "any" }).exitCode).not.toBe(0);
  expect(existsSync(folder(o, "wt with spaces"))).toBe(true);
  const target = recordPath(f, "wt with spaces");
  await withSync("t060-remove-submodule", async (service) => {
    const r = await open(service, f.repo);
    const plan = { worktree: target, branch: "refs/heads/spaces-b", head: oid(f, "refs/heads/spaces-b"), tracked: 0, untracked: 0, force: false, deleteBranch: null, submodules: true };
    expect(refused(await review(service, r, removePayload(target, false, false)))).toEqual(unavailable("dirty-tree", { plan }));
    expect(steps(service)).toEqual([]);
    const rv = await reviewed(service, r, removePayload(target, true, false));
    expect(rv.plan).toEqual({ ...plan, force: true });
    const from = service.runner.calls.length;
    const response = await service.response<WorktreeRun>(sendRun(service, r, rv.workbenchToken));
    expect(outcome(response)).toEqual(SUCCEEDED);
    expect(steps(service, from)).toEqual([[L, "worktree", "remove", "--force", "--", target]]);
  });
  git(o, ["worktree", "remove", "--force", "--", recordPath(o, "wt with spaces")]);
  expect(stateOf(f)).toEqual(stateOf(o));
}, TIMEOUT_MS);

// Contract Δ3 `worktree-remove` "Submodules": the gitlink stream of `ls-files -z --stage`. The records come in chunks of one to seven bytes.
caseTest("T060", "the gitlink stream keeps only the gitlinks in any chunk split, gives null for a path that is no UTF-8, and marks each record that breaks the form", [], async () => {
  const A = "a".repeat(40);
  const rec = (mode: string, path: Uint8Array | string, oid = A, stage = "0") => Buffer.concat([Buffer.from(`${mode} ${oid} ${stage}\t`), Buffer.from(path), Buffer.of(0)]);
  const feed = (bytes: Uint8Array, step: number) => {
    const s = worktrees.gitlinkStream("sha1");
    for (let at = 0; at < bytes.length && !s.limited; at += step) s.push(bytes.subarray(at, at + step));
    return { paths: s.paths, broken: s.broken, partial: s.partial, bound: s.bound };
  };
  const good = Buffer.concat([rec("100644", "f.txt"), rec("160000", "lib"), rec("120000", "l"), rec("160000", Buffer.of(0x73, 0xff)), rec("160000", "ü/x")]);
  for (const step of [1, 2, 3, 7, good.length]) expect(feed(good, step)).toEqual({ paths: ["lib", null, "ü/x"], broken: false, partial: false, bound: null });
  const broken: [string, Uint8Array][] = [
    ["mode", rec("16000x", "lib")],
    ["short object ID", rec("160000", "lib", "a".repeat(39))],
    ["stage", rec("160000", "lib", A, "4")],
    ["empty path", rec("160000", "")],
    ["NUL in the fields", Buffer.from(`160000 ${A}\0`)],
  ];
  for (const [what, bytes] of broken) for (const step of [1, 5, bytes.length]) expect({ what, ...feed(Buffer.concat([rec("100644", "f"), bytes, rec("160000", "z")]), step) }).toMatchObject({ what, broken: true, bound: null });
  expect(feed(good.subarray(0, good.length - 1), 4)).toMatchObject({ broken: false, partial: true });
  // STATUS_LISTING_RECORDS gitlinks fit. One more stops the stream.
  const many = (n: number) => Buffer.concat(Array.from({ length: n }, (_, i) => rec("160000", `m${i}`)));
  expect(feed(many(STATUS_LISTING_RECORDS), 1 << 20)).toMatchObject({ broken: false, partial: false, bound: null });
  expect(feed(many(STATUS_LISTING_RECORDS + 1), 1 << 20)).toMatchObject({ bound: "STATUS_LISTING_RECORDS" });
}, TIMEOUT_MS);

// An `ls-files -z --stage` listing above STATUS_LISTING_BYTES keeps no non-gitlink record. The entries have the skip-worktree bit, so the worktree stays clean without files.
caseTest("T060", "FR-055: a clean worktree whose index listing is larger than STATUS_LISTING_BYTES gets a plan with submodules: false and a token", SHELL, async () => {
  const f = build();
  const dir = folder(f, "wt with spaces");
  const blob = wb(repoOf(f, dir), ["hash-object", "-w", "--stdin"], { input: "x\n" }).stdout.toString("utf8").trim();
  const pad = "p".repeat(1000);
  const paths = Array.from({ length: 34_000 }, (_, i) => `big/${String(i).padStart(5, "0")}-${pad}`);
  wb(repoOf(f, dir), ["update-index", "-z", "--index-info"], { input: paths.map((p) => `100644 ${blob}\t${p}\0`).join("") });
  wb(repoOf(f, dir), ["update-index", "-z", "--skip-worktree", "--stdin"], { input: paths.map((p) => `${p}\0`).join("") });
  git(f, ["commit", "-q", "-m", "big index"], [0], dir);
  const listed = wb(repoOf(f, dir), ["ls-files", "-z", "--stage"]).stdout.length;
  expect(listed).toBeGreaterThan(STATUS_LISTING_BYTES);
  expect(statusCounts(f, dir)).toEqual({ tracked: 0, untracked: 0 });
  const target = recordPath(f, "wt with spaces");
  await withSync("t060-remove-large-index", async (service) => {
    const r = await open(service, f.repo);
    const rv = await reviewed(service, r, removePayload(target, false, false));
    expect(rv.plan).toEqual({ worktree: target, branch: "refs/heads/spaces-b", head: oid(f, "refs/heads/spaces-b"), tracked: 0, untracked: 0, force: false, deleteBranch: null, submodules: false });
    expect(steps(service)).toEqual([]);
  });
}, TIMEOUT_MS);

// ---- Cancel (FR-003, T098) ----

caseTest("T098", "FR-003: Cancel while a remove with Also delete the branch waits at its worktree remove or at its branch delete stops there, and the result states the refs and the worktree list that Git shows", SHELL, async () => {
  const isRemove = (call: { arguments: readonly string[] }) => call.arguments[1] === "worktree" && call.arguments[2] === "remove";
  const isDelete = (call: { arguments: readonly string[] }) => call.arguments[1] === "update-ref";
  for (const [at, match] of [["worktree-remove", isRemove], ["update-ref", isDelete]] as const) {
    const f = build();
    const o = build();
    const spaces = recordPath(f, "wt with spaces");
    await withSync(`t098-remove-${at}`, async (service) => {
      const r = await open(service, f.repo);
      const rv = await reviewed(service, r, removePayload(spaces, false, true));
      const release = service.runner.holdStart(match);
      const requestId = sendRun(service, r, rv.workbenchToken);
      try {
        await until(() => service.runner.calls.some(match), `held ${at}`);
        await service.cancel(await service.operationId(requestId));
      } finally {
        release();
      }
      const response = await service.response<WorktreeRun>(requestId);
      expect({ at, exit: service.runner.calls.find(match)!.exit?.exitCode ?? null }).toEqual({ at, exit: null });
      // The worktree remove ran in the second case, so the list lacks the worktree and the branch stays.
      expect({ at, ...outcome(response), refs: response.result!.refs }).toEqual({ at, ...(at === "worktree-remove" ? { state: "canceled", code: "CANCELED" } : { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" }), refs: [] });
    });
    if (at === "update-ref") git(o, ["worktree", "remove", "--", recordPath(o, "wt with spaces")]);
    expect({ at, state: stateOf(f) }).toEqual({ at, state: stateOf(o) });
  }
}, TIMEOUT_MS);

type Call = { operationId: string; arguments: readonly string[] };
// Each Git process that starts after the step process. The first one is a reconciliation read.
const afterStep = (service: Service, step: (call: Call) => boolean) => (call: Call) => {
  const calls: readonly Call[] = service.runner.calls;
  const i = calls.findIndex(step);
  return i >= 0 && calls.indexOf(call) > i;
};
// The refs whose values differ between two `for-each-ref` reads of Git, by name.
const refValues = (f: WbFixture) => new Map(git(f, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim().split("\n").map((l) => l.split(" ") as [string, string]));
const changedNames = (before: Map<string, string>, after: Map<string, string>) => [...new Set([...before.keys(), ...after.keys()])].filter((ref) => before.get(ref) !== after.get(ref)).sort();

caseTest("T098", "FR-003: Cancel while an add or a prune waits at its one Git step leaves the state of an untouched copy; Cancel after the step leaves the changed refs and the worktree list of Git's own command on a copy", SHELL, async () => {
  const actions = [
    { name: "add", payload: (service: Service, f: WbFixture, r: RegistrationResult) => addPayload({ new: "new-b", start: f.oids.base! }, service.runner.addWorktreeAdd(folder(f, "wt-new"), r.repositoryId)), own: (f: WbFixture) => ["worktree", "add", "-q", "-b", "new-b", "--", folder(f, "wt-new"), f.oids.base!], verb: "add" },
    { name: "prune", payload: () => ({ action: "worktree-prune" }), own: () => ["worktree", "prune"], verb: "prune" },
  ];
  for (const { name, payload, own, verb } of actions) {
    const isStep = (call: Call) => call.arguments[1] === "worktree" && call.arguments[2] === verb;
    for (const at of ["step", "after"] as const) {
      const label = `${name} ${at}`;
      const f = build();
      const o = build();
      await withSync(`t098-${name}-${at}`, async (service) => {
        const r = await open(service, f.repo);
        const rv = await reviewed(service, r, payload(service, f, r));
        const match = at === "step" ? isStep : afterStep(service, isStep);
        const release = service.runner.holdStart(match);
        const requestId = sendRun(service, r, rv.workbenchToken);
        try {
          await until(() => service.runner.calls.some(match), `held ${label}`);
          await service.cancel(await service.operationId(requestId));
        } finally {
          release();
        }
        const response = await service.response<WorktreeRun>(requestId);
        if (at === "step") {
          expect({ label, exit: service.runner.calls.find(isStep)!.exit?.exitCode ?? null }).toEqual({ label, exit: null });
          expect({ label, ...outcome(response), refs: response.result!.refs }).toEqual({ label, state: "canceled", code: "CANCELED", refs: [] });
        } else {
          // The step exited 0 before the Cancel, so the run keeps its effects.
          const before = refValues(o);
          git(o, own(o));
          expect({ label, exit: service.runner.calls.find(isStep)!.exit?.exitCode }).toEqual({ label, exit: 0 });
          expect({ label, ...outcome(response), refs: response.result!.refs.map((x) => x.ref).sort() }).toEqual({ label, ...SUCCEEDED, refs: changedNames(before, refValues(o)) });
        }
        expect({ label, steps: steps(service).length }).toEqual({ label, steps: 1 });
        expect({ label, head: response.result!.head }).toEqual({ label, head: { state: "branch", target: "refs/heads/main", oid: oid(f, "HEAD") } });
      });
      expect({ label, state: stateOf(f) }).toEqual({ label, state: stateOf(o) });
    }
  }
}, TIMEOUT_MS);

// T119 and data-model §8: Git prints `HEAD` with the null object ID and neither `branch` nor `detached` when it cannot resolve the HEAD of a record (worktree.c `add_head_info`).
// Without `core.longpaths`, Git for Windows cannot open a loose ref path of 260 or more UTF-16 units. Only the setup commands pass `-c core.longpaths=true`.
const T119 = "FR-013, FR-017, FR-049, and data-model §8: a record whose HEAD Git cannot resolve lists as headUnresolved, and Delete of a free branch gives head-unresolved";
const longCase = process.platform === "win32" ? caseTest : (task: string, name: string) => (console.log(`SKIP ${task} ${name}: the MAX_PATH ref limit exists only on Windows`), test.skip(name, () => {}));
// A worktrees fixture with `wt-long`, whose HEAD names a branch with a loose ref path of at least 270 UTF-16 units, and the free branch `t119-free`.
// The effective `core.longpaths` of the service environment, which reads the system file (`serviceEnv`). git-config(1): exit 1 means no value.
function serviceLongPaths(dir: string): { scope: string; value: string } | null {
  const p = Bun.spawnSync([gitExe(), "config", "--show-scope", "--type=bool", "--get", "core.longpaths"], { cwd: dir, env: serviceEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (p.exitCode === 1) return null;
  if (p.exitCode !== 0) throw new Error(`git config --get core.longpaths exited ${p.exitCode}`);
  const [scope, value] = p.stdout.toString().trimEnd().split("	");
  return { scope: scope!, value: value! };
}

async function withUnresolved(name: string, body: (f: WbFixture, path: string, service: Service, r: RegistrationResult) => Promise<void>): Promise<void> {
  const f = build();
  const longPaths = serviceLongPaths(f.repo);
  if (longPaths?.value === "true") return void console.log(`SKIP T119 ${name}: the service environment sets core.longpaths=true in the ${longPaths.scope} scope, so Git resolves the long ref`);
  // Components of 100 units each.
  const segments = Math.ceil(Math.max(0, 270 - join(f.repo, ".git", "refs", "heads", "t119").length) / 101);
  const branch = ["t119", ...Array.from({ length: segments }, () => "p".repeat(100))].join("/");
  expect(join(f.repo, ".git", "refs", "heads", branch).length).toBeGreaterThanOrEqual(260);
  const long = ["-c", "core.longpaths=true"];
  git(f, [...long, "worktree", "add", "-q", "-b", branch, "--", folder(f, "wt-long"), f.oids.base!]);
  git(f, ["branch", "t119-free", f.oids.base!]);
  const path = recordPath(f, "wt-long");
  // Git's own list without `core.longpaths`: the null object ID, and no `branch` or `detached` line.
  expect(recordsOf(f).find((r) => valueOf(r, "worktree") === path)).toEqual([`worktree ${path}`, `HEAD ${"0".repeat(40)}`]);
  try {
    await withSync(name, async (service) => body(f, path, service, await open(service, f.repo)));
  } finally {
    git(f, [...long, "worktree", "remove", "--force", "--", folder(f, "wt-long")]);
    git(f, [...long, "branch", "-D", branch]);
  }
}

longCase("T119", T119, SHELL, () =>
  withUnresolved("t119-unresolved", async (f, path, service, r) => {
    const read = await worktrees.readWorktreeList(await moduleContext(service, r));
    const listed = (read as { value: { entries: Record<string, unknown>[] } }).value.entries;
    expect(listed).toEqual(oracleEntries(f, recordsOf(f).map((x) => valueOf(x, "worktree")!)[0]!));
    expect(listed.find((e) => e.path === path)).toMatchObject({ head: null, branch: null, detached: false, bare: false, headUnresolved: true });
    expect(refused(await review(service, r, { action: "delete-branch", ref: "refs/heads/t119-free" }))).toEqual(unavailable("head-unresolved", { worktree: path }));
    expect(steps(service)).toEqual([]);
  }), TIMEOUT_MS);

const T119_HELD = "FR-016, FR-017, FR-026, FR-052, FR-055, and data-model §8: with a headUnresolved record, Add worktree of an existing branch, Rename, Remove with Also delete the branch, and a rebase under rebase.updateRefs give head-unresolved; the branch list names no holder it cannot prove";
longCase("T119", T119_HELD, SHELL, () =>
  withUnresolved("t119-held", async (f, path, service, r) => {
    const branches = await service.request<{ entries: { ref: string; heldBy: string | null }[] }>("readBranches", {}, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
    // Data-model §1 `heldBy`: only a `branch` line names a holder. The renderer reads `headUnresolved` from `readWorktrees`.
    expect(branches.state).toBe("succeeded");
    expect(branches.result!.entries.find((e) => e.ref === "refs/heads/t119-free")).toMatchObject({ heldBy: null });
    const add = await review(service, r, addPayload({ existing: "refs/heads/t119-free" }, service.runner.addWorktreeAdd(folder(f, "wt-add"), r.repositoryId)));
    expect(refused(add)).toEqual(unavailable("head-unresolved", { worktree: path }));
    // builtin/branch.c `replace_each_worktree_head_symref` skips a worktree without `head_ref`, so its HEAD would keep the old name.
    expect(refused(await review(service, r, { action: "rename-branch", ref: "refs/heads/t119-free", name: "t119-renamed" }))).toEqual(unavailable("head-unresolved", { worktree: path }));
    expect(refused(await review(service, r, removePayload(recordPath(f, "wt with spaces"), false, true)))).toEqual(unavailable("head-unresolved", { worktree: path }));
    expect(refused(await review(service, r, removePayload(path, false, true)))).toEqual(unavailable("head-unresolved", { worktree: path }));
    git(f, ["config", "rebase.updateRefs", "true"]);
    const onto = git(f, ["commit-tree", `${f.oids.base!}^{tree}`, "-p", f.oids.base!, "-m", "onto"]).trim();
    git(f, ["branch", "t119-onto", onto]);
    expect(refused(await review(service, r, { action: "rebase", ref: "refs/heads/t119-onto", autostash: false, autosquash: false }))).toEqual(unavailable("head-unresolved", { worktree: path }));
    expect(steps(service)).toEqual([]);
  }), TIMEOUT_MS);
