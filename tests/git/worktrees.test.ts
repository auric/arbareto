// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T049: worktrees (spec FR-049 to FR-057, SC-008, plan.md D10, contract Δ3 `readWorktrees`, `openWorktree`, and `reviewWorkbench` `worktree-add`, `worktree-remove`, `worktree-prune`, quickstart.md Q20).
// The oracle is Git's own command on a second build of the same fixture. The fixed fixture dates make the commit object IDs of both builds equal.

import { expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessContext } from "../../src/git-service/git-runner";
import type { ObserveContext } from "../../src/git-service/hunk-publish";
import type { Workspace } from "../../src/git-service/registration";
import { printOrigin } from "../origin";
import { FIXTURE_GLOBAL_CONFIG, removeTree, useFixtureRoot } from "./fixture-root";
import { put } from "./fixtures";
import { sha256, workingFileDigests } from "./git-oracle";
import { caseTest, type RegistrationResult, type Service, type ServiceResponse } from "./service-harness";
import { gitExe, native, TIMEOUT_MS, until, withSync } from "./sync-harness";
import { buildWorkbench, repoOf, wb, type WbFixture } from "./workbench-fixtures";

for (const module of ["worktrees", "workbench-review", "branch-ops", "session"]) {
  try {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  } catch {
    console.log(`ORIGIN absent src/git-service/${module}.ts`);
  }
}
// Until T060 imports `worktrees.ts` in `session.ts`, this import registers the worktree actions in the dispatcher of `workbench-review.ts`.
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
  refs: { ref: string; oldObjectId: string | null; newObjectId: string | null }[];
  worktrees: string[];
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
    return { path, invalidUtf8: false, head: valueOf(lines, "HEAD") ?? null, branch: valueOf(lines, "branch") ?? null, bare: flag("bare"), detached: flag("detached"), locked: reason("locked"), prunable: reason("prunable"), main: i === 0, current: path === current };
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
  if (trust.result!.approvalRequired.workbench) expect((await service.approveTrust(r.repositoryId, trust.result!.fingerprint, r.generation)).state).toBe("succeeded");
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
      expect(response.result!.refs).toEqual(variant === "new" ? [{ ref: "refs/heads/new-b", oldObjectId: null, newObjectId: start }] : []);
      expect(response.result!.head).toEqual({ state: "branch", target: "refs/heads/main", oid: start });
      expect(response.result!.worktrees).toEqual(recordsOf(f).map((x) => valueOf(x, "worktree")!));
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
    expect(steps(service)).toEqual([]);
  });
  expect(stateOf(f)).toEqual(before);
}, TIMEOUT_MS);

caseTest(TASK, "FR-054: Remove is unavailable for the main, the current, and a locked worktree, and a path that no fresh record names gives UNKNOWN_TARGET; no step starts", SHELL, async () => {
  const f = build();
  const before = stateOf(f);
  await withSync("t049-remove-unavailable", async (service) => {
    const r = await open(service, f.repo);
    expect(refused(await review(service, r, removePayload(recordPath(f, "repo"), true, true)))).toEqual(unavailable("main-worktree"));
    for (const name of ["wt-locked-reason", "wt-locked"]) expect(refused(await review(service, r, removePayload(recordPath(f, name), true, false)))).toEqual(unavailable("locked"));
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
    const plan = { worktree: dirty, branch: "refs/heads/dirty-b", head: f.oids.base, ...counts, force: false, deleteBranch: null };
    expect(refused(await review(service, r, removePayload(dirty, false, false)))).toEqual(unavailable("dirty-tree", { plan }));
    expect(workingFileDigests(folder(f, "wt-dirty"))).toEqual(files);
    expect(steps(service)).toEqual([]);
    const rv = await reviewed(service, r, removePayload(dirty, true, false));
    expect(rv.plan).toEqual({ ...plan, force: true });
    const from = service.runner.calls.length;
    const response = await service.response<WorktreeRun>(sendRun(service, r, rv.workbenchToken));
    expect(outcome(response)).toEqual(SUCCEEDED);
    expect(steps(service, from)).toEqual([[L, "worktree", "remove", "--force", "--", dirty]]);
    expect(response.result!.worktrees).not.toContain(dirty);
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
      expect(response.result!.refs).toEqual([{ ref: "refs/heads/spaces-b", oldObjectId: tip, newObjectId: null }]);
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
