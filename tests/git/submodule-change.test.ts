// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T106 to T108 and T114: feature 005 contract Δ3 `readSubmoduleChange` and `readSubmoduleWork` through the in-process service (plan.md D19, data-model §15 and §16).
// Spec FR-069 to FR-076, SC-012. The oracle is Git's own `rev-list`, `log`, and `status` inside the submodule, and the parent status with `--ignore-submodules=none` on a copy.

import { describe, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadSubmoduleChangeResult } from "../../src/contracts/envelope";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  FILE_FACT_COMPONENT_UNITS,
  READ_DEADLINE_MS,
  STATUS_LISTING_BYTES,
  STATUS_LISTING_RECORDS,
  SUBMODULE_WORK_PAGE,
  SUBMODULE_WORK_PARALLEL,
  SUBMODULE_WORK_TARGETS,
  TRUST_INPUT_BYTES,
  WINDOWS_COMMAND_LINE_UNITS,
} from "../../src/contracts/limits";
import { MATCHING_PROBE_WSL_FOLDER } from "../../src/contracts/matching-probe";
import { isIdentifier } from "../../src/contracts/operations";
import wslProcess from "../../src/contracts/wsl-process.json";
import { statusArgs } from "../../src/git-service/commands";
import { checkCall, commandLineUnits, RunnerRefusal, type GitCall, type GitExit, type GitRunner } from "../../src/git-service/git-runner";
import type { Workspace } from "../../src/git-service/registration";
import type { IndexEntry } from "../../src/git-service/snapshot";
import { createSubmoduleReads, submoduleHead } from "../../src/git-service/submodule-change";
import type { Trust } from "../../src/git-service/trust";
import { printOrigin } from "../origin";
import type { CallMatch } from "./bun-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "./fixture-root";
import { git, gitPath, gitText, outcome, readOk, SUCCEEDED, until, withService, workPages } from "./hunk-harness";
import { load } from "./history-view-harness";
import { caseTest, type Capability, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";
import { gitLocation } from "./submodule-harness";
import { canary } from "./workbench-fixtures";

for (const module of ["submodule-change", "session", "commands", "git-runner"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const SHELL: Capability[] = ["shell-double"];
const BACKSLASH = "\\";
const TIMEOUT_MS = 300_000;
const FILE_ALLOW = ["-c", "protocol.file.allow=always"];

interface Commit {
  oid: string;
  subject: string;
}
interface Change {
  pathBytes: string;
  path: string;
  kind: "submodule" | "nested";
  old: string | null;
  new: string | null;
  state: { state: "commits"; added: number; removed: number; addedCommits: Commit[]; removedCommits: Commit[] } | { state: "missing"; which: string } | { state: "not-initialized" } | { state: "not-located" } | { state: "single" };
  limited: boolean;
}
type WorkEntry =
  | { pathBytes: string; path: string; state: "checked"; modified: boolean; untracked: boolean }
  | { pathBytes: string; path: string; state: "not-initialized" }
  | { pathBytes: string; path: string; state: "not-located" }
  | { pathBytes: string; path: string; state: "unchecked"; reason: string; code?: string };
interface Work {
  snapshotId: string;
  entries: WorkEntry[];
  extraRows: { pathBytes: string; path: string }[];
  limited: number;
  next: number | null;
}

let builds = 0;
const commitIn = (repo: string, message: string, file = "f.txt") => {
  writeFileSync(join(repo, file), `${message}\n`);
  git(repo, ["add", "--", file]);
  git(repo, ["commit", "-q", "--no-verify", "-m", message]);
  return gitText(repo, ["rev-parse", "HEAD"]).trim();
};
const head = (repo: string) => gitText(repo, ["rev-parse", "HEAD"]).trim();

// A library repository with three commits, and a superproject with `lib` at the first one.
function world(name = "sub"): { root: string; lib: string; sup: string; c: string[] } {
  const root = fixtureDir(`t106-${name}-${++builds}`);
  const lib = join(root, "lib");
  mkdirSync(lib);
  git(lib, ["init", "-q"]);
  const c = ["one", "two", "three"].map((m) => commitIn(lib, m));
  git(lib, ["checkout", "-q", "--detach", c[0]!]);
  const sup = join(root, "super");
  mkdirSync(sup);
  git(sup, ["init", "-q"]);
  commitIn(sup, "base", "s.txt");
  git(sup, [...FILE_ALLOW, "submodule", "add", "-q", "--", lib, "lib"]);
  git(sup, ["commit", "-q", "--no-verify", "-m", "add lib"]);
  return { root, lib, sup, c };
}
const inLib = (w: { sup: string }) => join(w.sup, "lib");

const envelope = (r: WorkspaceResult, repositoryId: string) => ({ repositoryId, repositoryGeneration: r.generation });

async function workspaceChange(service: Service, sup: string, path: string, category: "staged" | "unstaged") {
  const { repositoryId } = await service.register(sup);
  const read = await readOk(service, repositoryId);
  const entry = read.entries.find((e) => e.path === path && e.category === category);
  expect({ path, category, listed: entry !== undefined }).toEqual({ path, category, listed: true });
  const response = await service.request<Change>("readSubmoduleChange", { source: { kind: "workspace", snapshotId: read.snapshotId, entryId: entry!.entryId } }, envelope(read, repositoryId));
  return { response, repositoryId, read };
}
const changed = (response: ServiceResponse<Change>): Change => {
  expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
  expect(ReadSubmoduleChangeResult.safeParse(response.result).success).toBe(true);
  return response.result!;
};

// Git's own counts and lists inside the submodule.
function oracle(sub: string, old: string, next: string) {
  const [removed, added] = gitText(sub, ["rev-list", "--left-right", "--count", `${old}...${next}`]).trim().split("\t").map(Number) as [number, number];
  const list = (a: string, b: string) =>
    gitText(sub, ["log", "-z", "--format=%H%x00%s", "--max-count=50", a, `^${b}`])
      .split("\0")
      .slice(0, -1)
      .reduce<Commit[]>((out, v, i, all) => (i % 2 === 0 ? [...out, { oid: v, subject: all[i + 1]! }] : out), []);
  return { state: "commits", added, removed, addedCommits: added === 0 ? [] : list(next, old), removedCommits: removed === 0 ? [] : list(old, next) };
}

// The submodule Git runs of one readSubmoduleChange request, in start order.
async function submoduleRuns(service: Service, response: ServiceResponse<Change>) {
  const operationId = await service.operationId(response.requestId!);
  return service.runner.calls.filter((c) => c.operationId === operationId && c.arguments.includes("--git-dir=.git")).map((c) => ({ args: c.arguments, start: c.at, end: c.at + c.durationMs! }));
}
type Run = Awaited<ReturnType<typeof submoduleRuns>>[number];
const runOf = (runs: Run[], ...words: string[]) => runs.filter((r) => words.every((w) => r.args.includes(w)));
// Plan.md D11 check 5 ends before any other submodule Git run starts.
function locatedFirst(runs: Run[]) {
  const [toplevel] = runOf(runs, "--show-toplevel");
  expect(toplevel).toBeDefined();
  expect(runs.filter((r) => r !== toplevel && r.start < toplevel!.end).map((r) => r.args)).toEqual([]);
}

describe("readSubmoduleChange (contract Δ3, plan.md D19)", () => {
  caseTest("T106", "(1)(2) new, removed, both, and 51 new commits equal Git's rev-list and log inside the submodule; unstaged takes hI and the submodule HEAD", SHELL, () =>
    withService({ name: "t106-commits" }, async (service) => {
      const w = world("commits");
      const sub = inLib(w);
      // New commits: the worktree submodule HEAD moves past the recorded commit.
      git(sub, ["checkout", "-q", "--detach", w.c[2]!]);
      let c = changed((await workspaceChange(service, w.sup, "lib", "unstaged")).response);
      expect({ old: c.old, new: c.new, kind: c.kind, limited: c.limited }).toEqual({ old: w.c[0]!, new: w.c[2]!, kind: "submodule", limited: false });
      expect(c.state).toEqual(oracle(sub, w.c[0]!, w.c[2]!) as Change["state"]);
      expect(c.state).toMatchObject({ added: 2, removed: 0 });
      // Removed commits: record the third commit, then check out the first.
      git(w.sup, ["add", "--", "lib"]);
      git(w.sup, ["commit", "-q", "--no-verify", "-m", "lib three"]);
      git(sub, ["checkout", "-q", "--detach", w.c[0]!]);
      c = changed((await workspaceChange(service, w.sup, "lib", "unstaged")).response);
      expect(c.state).toEqual(oracle(sub, w.c[2]!, w.c[0]!) as Change["state"]);
      expect(c.state).toMatchObject({ added: 0, removed: 2 });
      // Both sides: a branch from the first commit.
      git(sub, ["checkout", "-q", "-b", "side", w.c[0]!]);
      const side = commitIn(sub, "side");
      c = changed((await workspaceChange(service, w.sup, "lib", "unstaged")).response);
      expect(c.state).toEqual(oracle(sub, w.c[2]!, side) as Change["state"]);
      expect(c.state).toMatchObject({ added: 1, removed: 2 });
      // 51 new commits list 50 and keep the exact count.
      for (let i = 0; i < 51; i++) commitIn(sub, `n${i}`);
      c = changed((await workspaceChange(service, w.sup, "lib", "unstaged")).response);
      expect(c.state).toEqual(oracle(sub, w.c[2]!, head(sub)) as Change["state"]);
      expect(c.state).toMatchObject({ added: 52, removed: 2 });
      expect((c.state as { addedCommits: Commit[] }).addedCommits.length).toBe(50);
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "(2) a staged row takes hH and hI; a History row takes the raw record IDs", SHELL, () =>
    withService({ name: "t106-sources" }, async (service) => {
      const w = world("sources");
      const sub = inLib(w);
      git(sub, ["checkout", "-q", "--detach", w.c[1]!]);
      git(w.sup, ["add", "--", "lib"]);
      const staged = changed((await workspaceChange(service, w.sup, "lib", "staged")).response);
      expect({ old: staged.old, new: staged.new }).toEqual({ old: w.c[0]!, new: w.c[1]! });
      expect(staged.state).toEqual(oracle(sub, w.c[0]!, w.c[1]!) as Change["state"]);
      git(w.sup, ["commit", "-q", "--no-verify", "-m", "lib two"]);
      const oid = head(w.sup);
      const { repositoryId, generation } = await service.register(w.sup);
      const opened = await service.request<{ viewId: string }>("openHistory", { scope: "all" }, { repositoryId, repositoryGeneration: generation });
      const viewId = opened.result!.viewId;
      expect((await load(service, repositoryId, viewId, { end: true })).state).toBe("succeeded");
      const changes = await service.request<{ files: { fileId: number; kind: string }[] }>("readCommitChanges", { viewId, oid, parent: 0 }, { repositoryId, repositoryGeneration: generation });
      const record = changes.result!.files.find((f) => f.kind === "submodule")!.fileId;
      const history = changed(await service.request<Change>("readSubmoduleChange", { source: { kind: "commit", viewId, oid, parent: 0, record } }, { repositoryId, repositoryGeneration: generation }));
      expect({ old: history.old, new: history.new }).toEqual({ old: w.c[0]!, new: w.c[1]! });
      expect(history.state).toEqual(oracle(sub, w.c[0]!, w.c[1]!) as Change["state"]);
      // A parent index or an oid that the retained listing does not hold gives UNKNOWN_TARGET.
      const wrong = await service.request<Change>("readSubmoduleChange", { source: { kind: "commit", viewId, oid: w.c[0]!, parent: 0, record } }, { repositoryId, repositoryGeneration: generation });
      expect(wrong.code).toBe("UNKNOWN_TARGET");
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "(3) a new commit absent from the submodule gives missing, and no fetch runs from its promisor remote", SHELL, () =>
    withService({ name: "t106-missing" }, async (service) => {
      const w = world("missing");
      const sub = inLib(w);
      const upload = canary(w.root, "t106-upload-pack");
      git(sub, ["config", "core.repositoryformatversion", "1"]);
      git(sub, ["config", "extensions.partialclone", "origin"]);
      git(sub, ["config", "remote.origin.promisor", "true"]);
      git(sub, ["config", "remote.origin.uploadpack", upload.command]);
      const absent = "1".repeat(40);
      git(w.sup, ["update-index", "--cacheinfo", `160000,${absent},lib`]);
      const c = changed((await workspaceChange(service, w.sup, "lib", "staged")).response);
      expect({ old: c.old, new: c.new, state: c.state }).toEqual({ old: w.c[0]!, new: absent, state: { state: "missing", which: "new" } });
      expect(existsSync(upload.log)).toBe(false);
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "(3) an absent old, new, or both commits give missing from the cat-file exit, and cat-file runs only after a failed rev-list", SHELL, () =>
    withService({ name: "t106-missing-sides" }, async (service) => {
      const w = world("missing-sides");
      const [absentA, absentB] = ["1".repeat(40), "2".repeat(40)];
      const recorded = (oid: string) => {
        git(w.sup, ["update-index", "--cacheinfo", `160000,${oid},lib`]);
        git(w.sup, ["commit", "-q", "--no-verify", "-m", `lib ${oid}`]);
      };
      for (const [headOid, indexOid, which] of [
        [w.c[0]!, absentA, "new"],
        [absentA, w.c[1]!, "old"],
        [absentA, absentB, "both"],
      ] as const) {
        if (gitText(w.sup, ["rev-parse", "HEAD:lib"]).trim() !== headOid) recorded(headOid);
        git(w.sup, ["update-index", "--cacheinfo", `160000,${indexOid},lib`]);
        const { response } = await workspaceChange(service, w.sup, "lib", "staged");
        const c = changed(response);
        expect({ old: c.old, new: c.new, state: c.state }).toEqual({ old: headOid, new: indexOid, state: { state: "missing", which } });
        const runs = await submoduleRuns(service, response);
        locatedFirst(runs);
        const [count] = runOf(runs, "rev-list", "--left-right");
        const exists = runOf(runs, "cat-file", "-e");
        expect({ which, count: count !== undefined, exists: exists.length }).toEqual({ which, count: true, exists: 2 });
        expect(exists.filter((r) => r.start < count!.end).map((r) => r.args)).toEqual([]);
      }
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "(3) a failed rev-list with both commits present gives GIT_FAILED, not missing", SHELL, () =>
    withService({ name: "t106-count-fails" }, async (service) => {
      const w = world("count-fails");
      git(inLib(w), ["checkout", "-q", "--detach", w.c[2]!]);
      service.runner.inject.exit = (call) => (call.arguments.includes("rev-list") && call.arguments.includes("--left-right") ? 128 : undefined);
      const { response } = await workspaceChange(service, w.sup, "lib", "unstaged");
      service.runner.inject.exit = undefined;
      expect({ state: response.state, code: response.code }).toEqual({ state: "failed", code: "GIT_FAILED" });
      expect(runOf(await submoduleRuns(service, response), "cat-file", "-e").length).toBe(2);
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "(1) a side with no commits lists none; no submodule run starts before --show-toplevel ends, and no cat-file runs after a good rev-list", SHELL, () =>
    withService({ name: "t106-timeline" }, async (service) => {
      const w = world("timeline");
      git(inLib(w), ["checkout", "-q", "--detach", w.c[2]!]);
      const { response } = await workspaceChange(service, w.sup, "lib", "unstaged");
      const c = changed(response);
      expect(c.state).toMatchObject({ added: 2, removed: 0, removedCommits: [] });
      const runs = await submoduleRuns(service, response);
      locatedFirst(runs);
      expect(runOf(runs, "cat-file").map((r) => r.args)).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "(4) not initialized, nested with commit facts, and an added gitlink as single", SHELL, () =>
    withService({ name: "t106-kinds" }, async (service) => {
      const w = world("kinds");
      // An uninitialized submodule: a clone without the submodule, with a staged gitlink change.
      const clone = join(w.root, "clone");
      git(w.root, [...FILE_ALLOW, "clone", "-q", "--", w.sup, clone]);
      git(clone, ["update-index", "--cacheinfo", `160000,${w.c[1]!},lib`]);
      let c = changed((await workspaceChange(service, clone, "lib", "staged")).response);
      expect({ state: c.state, old: c.old, new: c.new, kind: c.kind }).toEqual({ state: { state: "not-initialized" }, old: w.c[0]!, new: w.c[1]!, kind: "submodule" });
      // A nested repository without a .gitmodules entry.
      const nested = join(w.sup, "nest");
      mkdirSync(nested);
      git(nested, ["init", "-q"]);
      const n0 = commitIn(nested, "n0");
      git(w.sup, ["add", "--", "nest"]);
      c = changed((await workspaceChange(service, w.sup, "nest", "staged")).response);
      expect({ state: c.state, old: c.old, new: c.new, kind: c.kind }).toEqual({ state: { state: "single" }, old: null, new: n0, kind: "nested" });
      git(w.sup, ["commit", "-q", "--no-verify", "-m", "nest"]);
      const n1 = commitIn(nested, "n1");
      c = changed((await workspaceChange(service, w.sup, "nest", "unstaged")).response);
      expect({ kind: c.kind, old: c.old, new: c.new }).toEqual({ kind: "nested", old: n0, new: n1 });
      expect(c.state).toEqual(oracle(nested, n0, n1) as Change["state"]);
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "(5) a command-valued core.fsmonitor, a clean filter, and log.showSignature with gpg.program in the submodule run no canary", SHELL, () =>
    withService({ name: "t106-canaries" }, async (service) => {
      const w = world("canaries");
      const sub = inLib(w);
      git(sub, ["checkout", "-q", "--detach", w.c[2]!]);
      const monitor = canary(w.root, "t106-fsmonitor");
      const clean = canary(w.root, "t106-clean", "cat\n");
      const gpg = canary(w.root, "t106-gpg");
      git(sub, ["config", "core.fsmonitor", monitor.command]);
      git(sub, ["config", "filter.canary.clean", clean.command]);
      git(sub, ["config", "log.showSignature", "true"]);
      git(sub, ["config", "gpg.program", gpg.command]);
      writeFileSync(join(sub, "f.txt"), "edited\n");
      writeFileSync(join(sub, ".gitattributes"), "* filter=canary\n");
      const c = changed((await workspaceChange(service, w.sup, "lib", "unstaged")).response);
      expect(c.state).toEqual(oracle(sub, w.c[0]!, w.c[2]!) as Change["state"]);
      for (const log of [monitor.log, clean.log, gpg.log]) expect({ log, ran: existsSync(log) }).toEqual({ log, ran: false });
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "(6)(7) subject bytes that are not UTF-8 give the lossless display text; log output above 256 KiB gives limited with exact counts", SHELL, () =>
    withService({ name: "t106-subjects" }, async (service) => {
      const w = world("subjects");
      const sub = inLib(w);
      // `git commit` rewrites bytes that are not UTF-8 (commit.c `verify_utf8`), so the commit object is written directly.
      const tree = gitText(sub, ["rev-parse", "HEAD^{tree}"]).trim();
      const person = "F <f@example.test> 1767225600 +0000";
      const body = Buffer.concat([Buffer.from(`tree ${tree}\nparent ${head(sub)}\nauthor ${person}\ncommitter ${person}\n\nbad `), Buffer.from([0xff]), Buffer.from("\n")]);
      const bad = gitText(sub, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: body }).trim();
      git(sub, ["checkout", "-q", "--detach", bad]);
      let c = changed((await workspaceChange(service, w.sup, "lib", "unstaged")).response);
      expect((c.state as { addedCommits: Commit[] }).addedCommits[0]!.subject).toBe("bad \\xff");
      const long = "x".repeat(8000);
      for (let i = 0; i < 40; i++) {
        writeFileSync(join(sub, "f.txt"), `${i}\n`);
        git(sub, ["commit", "-q", "--no-verify", "-a", "-m", `${i} ${long}`]);
      }
      c = changed((await workspaceChange(service, w.sup, "lib", "unstaged")).response);
      expect(c.limited).toBe(true);
      expect(c.state).toMatchObject({ added: 41, removed: 0 });
      const listed = (c.state as { addedCommits: Commit[] }).addedCommits;
      expect(listed.length).toBeLessThan(41);
      expect(listed).toEqual((oracle(sub, w.c[0]!, head(sub)).addedCommits as Commit[]).slice(0, listed.length));
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "a snapshot whose index listing reached STATUS_LISTING_RECORDS gives OUTPUT_LIMIT for both reads, before any submodule process; work page 1 gives INVALID_REQUEST", SHELL, () =>
    withService({ name: "t106-index-cut" }, async (service) => {
      const w = world("index-cut");
      git(inLib(w), ["checkout", "-q", "--detach", w.c[1]!]);
      // The index listing of `readWorkspace` (`ls-files -z --stage -v`) gives one record more than the bound.
      const record = Buffer.from(`H 160000 ${w.c[0]!} 0\tlib\0`);
      service.runner.inject.stdout = (call) => (call.arguments.includes("-v") && call.arguments.includes("ls-files") ? Buffer.concat(Array.from({ length: STATUS_LISTING_RECORDS + 1 }, () => record)) : undefined);
      const { repositoryId } = await service.register(w.sup);
      const read = await service.readWorkspace(repositoryId);
      service.runner.inject.stdout = undefined;
      expect(read.result!.completeness).toMatchObject({ state: "limited", reason: "STATUS_LISTING_RECORDS" });
      const before = service.runner.calls.length;
      const work = await service.request<Work>("readSubmoduleWork", { snapshotId: read.result!.snapshotId, page: 0 }, envelope(read.result!, repositoryId));
      expect({ state: work.state, code: work.code }).toEqual({ state: "failed", code: "OUTPUT_LIMIT" });
      // T114 (5): contract Δ3 "Pages": a cut index listing has one page.
      const page1 = await service.request<Work>("readSubmoduleWork", { snapshotId: read.result!.snapshotId, page: 1 }, envelope(read.result!, repositoryId));
      expect(outcome(page1)).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      const entry = read.result!.entries.find((e) => e.path === "lib" && e.category === "unstaged")!;
      const change = await service.request<Change>("readSubmoduleChange", { source: { kind: "workspace", snapshotId: read.result!.snapshotId, entryId: entry.entryId } }, envelope(read.result!, repositoryId));
      expect({ state: change.state, code: change.code }).toEqual({ state: "failed", code: "OUTPUT_LIMIT" });
      expect(service.runner.calls.slice(before).filter((c) => c.arguments.includes("--git-dir=.git"))).toEqual([]);
      // `reviewSubmodules` refuses the same snapshot: a cut index listing leaves no index fingerprint (contract §3, status.ts).
      const review = await service.request("reviewSubmodules", { snapshotId: read.result!.snapshotId }, envelope(read.result!, repositoryId));
      expect({ succeeded: review.state === "succeeded", code: review.code }).toEqual({ succeeded: false, code: "OUTPUT_LIMIT" });
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "a path that breaks the component rule gives SUBMODULE_UNAVAILABLE path for a commit change, and an added gitlink at such a path gives single", SHELL, () =>
    withService({ name: "t106-path" }, async (service) => {
      const w = world("path");
      // Contract §6 "File facts": a component holds at most FILE_FACT_COMPONENT_UNITS (255) UTF-16 units. Git accepts a longer index path.
      const [x, y] = ["x".repeat(FILE_FACT_COMPONENT_UNITS + 1), "y".repeat(FILE_FACT_COMPONENT_UNITS + 1)];
      git(w.sup, ["update-index", "--add", "--cacheinfo", `160000,${w.c[0]!},${x}`]);
      git(w.sup, ["commit", "-q", "--no-verify", "-m", "long"]);
      git(w.sup, ["update-index", "--cacheinfo", `160000,${w.c[1]!},${x}`]);
      git(w.sup, ["update-index", "--add", "--cacheinfo", `160000,${w.c[1]!},${y}`]);
      const changed1 = await workspaceChange(service, w.sup, x, "staged");
      expect({ state: changed1.response.state, code: changed1.response.code, result: changed1.response.result }).toEqual({ state: "failed", code: "SUBMODULE_UNAVAILABLE", result: { reason: "path" } as never });
      expect(ReadSubmoduleChangeResult.safeParse(changed1.response.result).success).toBe(true);
      const added = changed((await workspaceChange(service, w.sup, y, "staged")).response);
      expect({ state: added.state, old: added.old, new: added.new }).toEqual({ state: { state: "single" }, old: null, new: w.c[1]! });
    }),
    TIMEOUT_MS,
  );

  caseTest("T106", "an untrusted parent with a command-valued core.fsmonitor gives TRUST_REQUIRED before any submodule process", SHELL, () =>
    withService({ name: "t106-gate" }, async (service) => {
      const w = world("gate");
      git(inLib(w), ["checkout", "-q", "--detach", w.c[1]!]);
      const { repositoryId } = await service.register(w.sup);
      const read = await readOk(service, repositoryId);
      const entry = read.entries.find((e) => e.path === "lib")!;
      const monitor = canary(w.root, "t106-parent-fsmonitor");
      git(w.sup, ["config", "core.fsmonitor", monitor.command]);
      const r = await service.request<Change>("readSubmoduleChange", { source: { kind: "workspace", snapshotId: read.snapshotId, entryId: entry.entryId } }, envelope(read, repositoryId));
      expect({ state: r.state, code: r.code }).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(service.runner.calls.some((call) => call.arguments.includes("--git-dir=.git"))).toBe(false);
      expect(existsSync(monitor.log)).toBe(false);
    }),
    TIMEOUT_MS,
  );
});

// ---- readSubmoduleWork ----

// Four submodules of one library: an edited tracked file, an untracked file, both, and clean. `moved` also has a changed commit.
function workWorld(name: string): { root: string; sup: string; lib: string; c: string[] } {
  const w = world(name);
  for (const path of ["tracked", "untracked", "both", "clean", "moved"]) git(w.sup, [...FILE_ALLOW, "submodule", "add", "-q", "--", w.lib, path]);
  git(w.sup, ["commit", "-q", "--no-verify", "-m", "five"]);
  writeFileSync(join(w.sup, "tracked", "f.txt"), "edit\n");
  writeFileSync(join(w.sup, "untracked", "new.txt"), "new\n");
  writeFileSync(join(w.sup, "both", "f.txt"), "edit\n");
  writeFileSync(join(w.sup, "both", "new.txt"), "new\n");
  git(join(w.sup, "moved"), ["checkout", "-q", "--detach", w.c[2]!]);
  writeFileSync(join(w.sup, "moved", "new.txt"), "new\n");
  return w;
}

// All pages of one snapshot, joined (contract Δ3 "Pages").
async function readWork(service: Service, sup: string): Promise<{ work: Work; read: WorkspaceResult; responses: ServiceResponse<Work>[]; repositoryId: string; ms: number }> {
  const { repositoryId } = await service.register(sup);
  const read = await readOk(service, repositoryId);
  const started = performance.now();
  const { work, responses } = await workPages<Work>(service, repositoryId, read);
  return { work, read, responses, repositoryId, ms: performance.now() - started };
}
// The submodule Git runs of the page operations of `responses`.
async function pageRuns(service: Service, responses: ServiceResponse<Work>[], match: CallMatch) {
  const operations = new Set(await Promise.all(responses.map((r) => service.operationId(r.requestId!))));
  return service.runner.calls.filter((c) => operations.has(c.operationId) && c.arguments.includes("--git-dir=.git") && match(c));
}
const isStatus: CallMatch = (c) => c.arguments.includes("--git-dir=.git") && c.arguments.includes("status");

// The `<m>` and `<u>` fields of Git's own parent status with `--ignore-submodules=none`, on a copy.
function parentOracle(root: string, sup: string): Record<string, { modified: boolean; untracked: boolean }> {
  const copy = join(root, "oracle-copy");
  cpSync(sup, copy, { recursive: true });
  const out: Record<string, { modified: boolean; untracked: boolean }> = {};
  for (const record of gitText(copy, ["status", "--porcelain=v2", "-z", "--ignore-submodules=none"]).split("\0")) {
    const m = /^1 \S\S (S[C.]([M.])([U.])) \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record);
    if (m) out[m[4]!] = { modified: m[2] === "M", untracked: m[3] === "U" };
  }
  return out;
}
const states = (work: Work) =>
  Object.fromEntries(work.entries.map((e) => [e.path, e.state === "checked" ? { modified: e.modified, untracked: e.untracked } : e.state === "not-initialized" || e.state === "not-located" ? { state: e.state } : { reason: e.reason, code: e.code }]));

describe("readSubmoduleWork (contract Δ3, plan.md D19)", () => {
  caseTest("T107", "(1)(2) each state equals the <m> and <u> fields of the parent status with none; extraRows holds only unchanged commits with local edits", SHELL, () =>
    withService({ name: "t107-states" }, async (service) => {
      const w = workWorld("states");
      const { work } = await readWork(service, w.sup);
      const expected = parentOracle(w.root, w.sup);
      for (const path of ["lib", "clean"]) expected[path] ??= { modified: false, untracked: false };
      expect(states(work)).toEqual(expected);
      expect(work.extraRows.map((r) => r.path).sort()).toEqual(["both", "tracked", "untracked"]);
    }),
    TIMEOUT_MS,
  );

  caseTest("T107", "(3) a command-valued core.fsmonitor or a clean filter in the submodule local configuration gives programs, and no canary runs; a global fsmonitor outside the roots runs", SHELL, async () => {
    const w = workWorld("programs");
    const monitor = canary(w.root, "t107-fsmonitor");
    const clean = canary(w.root, "t107-clean", "cat\n");
    git(join(w.sup, "tracked"), ["config", "core.fsmonitor", monitor.command]);
    git(join(w.sup, "both"), ["config", "filter.canary.clean", clean.command]);
    writeFileSync(join(w.sup, "both", ".gitattributes"), "* filter=canary\n");
    await withService({ name: "t107-programs" }, async (service) => {
      const { work } = await readWork(service, w.sup);
      expect(states(work).tracked).toEqual({ reason: "programs", code: undefined });
      expect(states(work).both).toEqual({ reason: "programs", code: undefined });
      expect(existsSync(monitor.log)).toBe(false);
      expect(existsSync(clean.log)).toBe(false);
    });
    // The same key from global scope with a program outside the roots runs as a protected program.
    const global = join(w.root, "global.gitconfig");
    const outside = canary(w.root, "t107-global-fsmonitor");
    writeFileSync(global, `[user]\n\tname = F\n\temail = f@example.test\n[core]\n\tfsmonitor = ${outside.command}\n`);
    git(join(w.sup, "tracked"), ["config", "--unset", "core.fsmonitor"]);
    await withService({ name: "t107-global", environment: serviceEnv({ GIT_CONFIG_GLOBAL: global }) }, async (service) => {
      const { work } = await readWork(service, w.sup);
      expect(states(work).tracked).toEqual({ modified: true, untracked: false });
    });
  }, TIMEOUT_MS);

  caseTest("T107", "(3) filter.*.process, an include.path file and an includeIf file that set core.fsmonitor, and config.worktree with extensions.worktreeConfig each give programs, and no canary runs", SHELL, async () => {
    const w = workWorld("program-forms");
    const sub = (name: string) => join(w.sup, name);
    const process = canary(w.root, "t107-process");
    const included = canary(w.root, "t107-include");
    const conditional = canary(w.root, "t107-include-if");
    const perWorktree = canary(w.root, "t107-worktree");
    git(sub("tracked"), ["config", "filter.p.process", process.command]);
    writeFileSync(join(sub("tracked"), ".gitattributes"), "* filter=p\n");
    const includeFile = join(w.root, "include.gitconfig").replaceAll(BACKSLASH, "/");
    writeFileSync(includeFile, `[core]\n\tfsmonitor = ${included.command}\n`);
    git(sub("untracked"), ["config", "include.path", includeFile]);
    const conditionalFile = join(w.root, "include-if.gitconfig").replaceAll(BACKSLASH, "/");
    writeFileSync(conditionalFile, `[core]\n\tfsmonitor = ${conditional.command}\n`);
    // `onbranch:` matches on a checked-out branch. A `gitdir:` pattern did not match a submodule Git directory on Git 2.56.0.windows.2 (probe of 2026-10-31).
    git(sub("both"), ["checkout", "-q", "-B", "work"]);
    git(sub("both"), ["config", "includeIf.onbranch:work.path", conditionalFile]);
    expect(gitText(sub("both"), ["config", "--show-scope", "--get", "core.fsmonitor"]).startsWith("local")).toBe(true);
    git(sub("clean"), ["config", "extensions.worktreeConfig", "true"]);
    git(sub("clean"), ["config", "--worktree", "core.fsmonitor", perWorktree.command]);
    expect(gitText(sub("clean"), ["config", "--show-scope", "--get", "core.fsmonitor"]).startsWith("worktree")).toBe(true);
    await withService({ name: "t107-program-forms" }, async (service) => {
      const { work } = await readWork(service, w.sup);
      const s = states(work);
      expect({ tracked: s.tracked, untracked: s.untracked, both: s.both, clean: s.clean }).toEqual(Object.fromEntries(["tracked", "untracked", "both", "clean"].map((k) => [k, { reason: "programs", code: undefined }])) as never);
      for (const log of [process.log, included.log, conditional.log, perWorktree.log]) expect({ log, ran: existsSync(log) }).toEqual({ log, ran: false });
    });
  }, TIMEOUT_MS);

  caseTest("T107", "each of the first 256 gitlinks has an entry: an uninitialized one, one with a .git file that names a missing Git folder, and a plain gitlink folder give not-initialized", SHELL, () =>
    withService({ name: "t107-not-initialized" }, async (service) => {
      const w = world("not-initialized");
      const clone = join(w.root, "clone");
      git(w.root, [...FILE_ALLOW, "clone", "-q", "--", w.sup, clone]);
      for (const path of ["broken", "plain"]) git(clone, ["update-index", "--add", "--cacheinfo", `160000,${w.c[0]!},${path}`]);
      mkdirSync(join(clone, "broken"));
      writeFileSync(join(clone, "broken", ".git"), "gitdir: ../.git/modules/arbareto-missing\n");
      mkdirSync(join(clone, "plain"));
      const { work } = await readWork(service, clone);
      expect({ states: states(work), limited: work.limited }).toEqual({ states: { broken: { state: "not-initialized" }, lib: { state: "not-initialized" }, plain: { state: "not-initialized" } }, limited: 0 });
      // A `.git` file passes check 4, so `broken` runs its location check and `config list` side by side. No status runs.
      expect(service.runner.calls.filter((c) => c.arguments.includes("--git-dir=.git") && c.arguments.includes("status"))).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest("T107", "(4) 257 initialized submodules give 256 states and one limit, with more than 4 and at most 8 status processes at the same time", SHELL, () =>
    withService({ name: "t107-limit" }, async (service) => {
      const w = world("limit");
      const index: string[] = [];
      // `lib` and 256 more gitlinks give 257 targets.
      for (let i = 0; i < SUBMODULE_WORK_TARGETS; i++) {
        const path = `m/${String(i).padStart(3, "0")}`;
        cpSync(w.lib, join(w.sup, ...path.split("/")), { recursive: true });
        index.push(`160000 ${w.c[0]!}\t${path}`);
      }
      git(w.sup, ["update-index", "--index-info"], { input: Buffer.from(`${index.join("\n")}\n`) });
      const { work, responses } = await readWork(service, w.sup);
      // Contract Δ3: the gitlinks after the 256th in index order give one count and no entry.
      expect({ limited: work.limited, entries: work.entries.length, last: work.entries.at(-1)!.path }).toEqual({ limited: 1, entries: SUBMODULE_WORK_TARGETS, last: `m/${SUBMODULE_WORK_TARGETS - 2}` });
      // Tasks.md T107 (4): the status processes. Each target runs its location check and its `config list` side by side. The pages run one after another.
      const runs = await pageRuns(service, responses, isStatus);
      let peak = 0;
      for (const run of runs) peak = Math.max(peak, runs.filter((o) => o.at <= run.at && o.at + (o.durationMs ?? 0) > run.at).length);
      expect(peak).toBeLessThanOrEqual(SUBMODULE_WORK_PARALLEL);
      expect(peak).toBeGreaterThan(4);
    }),
    TIMEOUT_MS,
  );

  caseTest("T107", "(5) the status ends after the first tracked and the first untracked record", SHELL, () =>
    withService({ name: "t107-early" }, async (service) => {
      const w = world("early");
      const sub = inLib(w);
      writeFileSync(join(sub, "f.txt"), "edit\n");
      for (let i = 0; i < 10_000; i++) writeFileSync(join(sub, `u${i}.txt`), "u\n");
      const { work, responses } = await readWork(service, w.sup);
      expect(states(work).lib).toEqual({ modified: true, untracked: true });
      const status = (await pageRuns(service, responses, isStatus))[0]!;
      // Contract §6 `stop`: a limited collector stops the call, so it ends without an exit status.
      expect({ limited: status.stdoutLimited, exitCode: status.exit?.exitCode }).toEqual({ limited: true, exitCode: null });
    }),
    TIMEOUT_MS,
  );

  caseTest("T107", "(6) the parent statusArgs keep --ignore-submodules=dirty", [], () => {
    expect(statusArgs()).toContain("--ignore-submodules=dirty");
  });

  caseTest("T107", "an old snapshot gives UNKNOWN_TARGET", SHELL, () =>
    withService({ name: "t107-old" }, async (service) => {
      const w = world("old");
      const { repositoryId } = await service.register(w.sup);
      const first = await readOk(service, repositoryId);
      writeFileSync(join(w.sup, "later.txt"), "later\n");
      const second = await readOk(service, repositoryId);
      expect(second.snapshotId).not.toBe(first.snapshotId);
      const r = await service.request<Work>("readSubmoduleWork", { snapshotId: first.snapshotId, page: 0 }, envelope(second, repositoryId));
      expect({ failed: r.state !== "succeeded", code: r.code }).toEqual({ failed: true, code: "UNKNOWN_TARGET" });
    }),
    TIMEOUT_MS,
  );
});

// ---- T121: a moved gitlink that plan.md D11 check 3, 4, or 5 does not locate (spec FR-078) ----

const MOVED_RECORD = "1 .M SC.. 160000 160000 160000";
// The first six fields of the parent status record of `path`.
const parentRecord = (sup: string, path: string) =>
  gitText(sup, ["status", "--porcelain=v2", "-z", "--ignore-submodules=dirty"])
    .split("\0")
    .find((r) => r.endsWith(` ${path}`))
    ?.split(" ")
    .slice(0, 6)
    .join(" ");
// The real `ls-files -z --stage -v` records of `sup`, without the records of `path` when `drop` is set.
const indexListing = (sup: string, path: string, drop: boolean) =>
  Buffer.from(
    git(sup, ["ls-files", "-z", "--stage", "-v"])
      .toString("latin1")
      .split("\0")
      .filter((r) => r !== "" && !(drop && r.endsWith(`\t${path}`)))
      .map((r) => `${r}\0`)
      .join(""),
    "latin1",
  );

// Both reads of the unstaged `lib` row of one snapshot. `listing` replaces the snapshot index listing.
async function bothReads(service: Service, sup: string, listing?: Buffer): Promise<{ change: Change; lib: WorkEntry | undefined; work: Work; responses: ServiceResponse<Work>[] }> {
  const { repositoryId } = await service.register(sup);
  if (listing !== undefined) service.runner.inject.stdout = (call) => (call.arguments.includes("ls-files") && call.arguments.includes("-v") ? listing : undefined);
  const read = await readOk(service, repositoryId).finally(() => (service.runner.inject.stdout = undefined));
  const entry = read.entries.find((e) => e.path === "lib" && e.category === "unstaged");
  expect({ listed: entry !== undefined }).toEqual({ listed: true });
  const change = changed(await service.request<Change>("readSubmoduleChange", { source: { kind: "workspace", snapshotId: read.snapshotId, entryId: entry!.entryId } }, envelope(read, repositoryId)));
  const { work, responses } = await workPages<Work>(service, repositoryId, read);
  return { change, lib: work.entries.find((e) => e.path === "lib"), work, responses };
}
const NOT_LOCATED = { change: { state: "not-located" }, kind: "submodule", lib: "not-located" };
const shape = (r: Pick<Awaited<ReturnType<typeof bothReads>>, "change" | "lib">): unknown => ({ change: r.change.state.state === "commits" ? { state: "commits" } : r.change.state, kind: r.change.kind, lib: r.lib?.state });

describe("a moved gitlink that the D11 checks do not locate (spec FR-078, contract Δ3)", () => {
  caseTest("T121", "check 4: a junction at the submodule path gives not-located for both reads; the real folder gives commits and checked", ["shell-double", "ntfs-junction"], () =>
    withService({ name: "t121-junction" }, async (service) => {
      const w = world("junction");
      git(inLib(w), ["checkout", "-q", "--detach", w.c[2]!]);
      const real = join(w.sup, "lib-real");
      renameSync(inLib(w), real);
      symlinkSync(real, inLib(w), "junction");
      expect(parentRecord(w.sup, "lib")).toBe(MOVED_RECORD);
      expect(shape(await bothReads(service, w.sup))).toEqual(NOT_LOCATED);
      unlinkSync(inLib(w));
      renameSync(real, inLib(w));
      expect(parentRecord(w.sup, "lib")).toBe(MOVED_RECORD);
      expect(shape(await bothReads(service, w.sup))).toEqual({ change: { state: "commits" }, kind: "submodule", lib: "checked" });
    }),
    TIMEOUT_MS,
  );

  caseTest("T121", "check 5: core.worktree of the submodule names a folder inside it, so both reads give not-located; without it they give commits and checked", SHELL, () =>
    withService({ name: "t121-worktree" }, async (service) => {
      const w = world("worktree");
      const sub = inLib(w);
      git(sub, ["checkout", "-q", "--detach", w.c[2]!]);
      const inner = join(sub, "inner");
      mkdirSync(inner);
      git(sub, ["config", "core.worktree", inner.replaceAll(BACKSLASH, "/")]);
      expect(parentRecord(w.sup, "lib")).toBe(MOVED_RECORD);
      expect(shape(await bothReads(service, w.sup))).toEqual(NOT_LOCATED);
      git(sub, ["config", "--unset", "core.worktree"]);
      expect(parentRecord(w.sup, "lib")).toBe(MOVED_RECORD);
      expect(shape(await bothReads(service, w.sup))).toEqual({ change: { state: "commits" }, kind: "submodule", lib: "checked" });
    }),
    TIMEOUT_MS,
  );

  caseTest("T121", "check 3: a snapshot index listing without the gitlink entry gives not-located for both reads; the unchanged listing gives commits and checked", SHELL, () =>
    withService({ name: "t121-index" }, async (service) => {
      const w = world("index");
      git(inLib(w), ["checkout", "-q", "--detach", w.c[2]!]);
      expect(parentRecord(w.sup, "lib")).toBe(MOVED_RECORD);
      expect(shape(await bothReads(service, w.sup, indexListing(w.sup, "lib", true)))).toEqual(NOT_LOCATED);
      expect(shape(await bothReads(service, w.sup, indexListing(w.sup, "lib", false)))).toEqual({ change: { state: "commits" }, kind: "submodule", lib: "checked" });
    }),
    TIMEOUT_MS,
  );
});

// `<path>` as a copy of the library and a stage-0 gitlink at its first commit, without a `.gitmodules` entry.
const addGitlinks = (w: { sup: string; lib: string; c: string[] }, paths: readonly string[]) => {
  for (const path of paths) cpSync(w.lib, join(w.sup, ...path.split("/")), { recursive: true });
  git(w.sup, ["update-index", "--add", "--index-info"], { input: Buffer.from(paths.map((p) => `160000 ${w.c[0]!}\t${p}\n`).join("")) });
};
const mPaths = (count: number) => Array.from({ length: count }, (_, i) => `m/${String(i).padStart(3, "0")}`);

// T121 analyze finding T1: the place and the bound of the entries of unlisted moved gitlinks (contract Δ3, data-model §16).
describe("readSubmoduleWork entries of unlisted moved gitlinks (contract Δ3 step 1, data-model §16)", () => {
  caseTest("T121", "an unlisted moved gitlink comes after the index entries; with its index entry it keeps its index place", SHELL, () =>
    withService({ name: "t121-order" }, async (service) => {
      const w = world("order");
      git(inLib(w), ["checkout", "-q", "--detach", w.c[2]!]);
      addGitlinks(w, ["z"]);
      expect(parentRecord(w.sup, "lib")).toBe(MOVED_RECORD);
      const dropped = await bothReads(service, w.sup, indexListing(w.sup, "lib", true));
      expect(dropped.work.entries.map((e) => `${e.path} ${e.state}`)).toEqual(["z checked", "lib not-located"]);
      const kept = await bothReads(service, w.sup, indexListing(w.sup, "lib", false));
      expect(kept.work.entries.map((e) => `${e.path} ${e.state}`)).toEqual(["lib checked", "z checked"]);
    }),
    TIMEOUT_MS,
  );

  caseTest("T121", "256 targets and one unlisted moved gitlink give limited 1 and no entry for it; with its index entry it is the first target", SHELL, () =>
    withService({ name: "t121-bound" }, async (service) => {
      const w = world("bound");
      git(inLib(w), ["checkout", "-q", "--detach", w.c[2]!]);
      addGitlinks(w, Array.from({ length: SUBMODULE_WORK_TARGETS }, (_, i) => `m/${String(i).padStart(3, "0")}`));
      expect(parentRecord(w.sup, "lib")).toBe(MOVED_RECORD);
      const dropped = await bothReads(service, w.sup, indexListing(w.sup, "lib", true));
      expect({ entries: dropped.work.entries.length, limited: dropped.work.limited, lib: dropped.lib }).toEqual({ entries: SUBMODULE_WORK_TARGETS, limited: 1, lib: undefined });
      // Control: `lib` sorts before `m/`, so it is a target, and the last `m/` gitlink is past the bound.
      const kept = await bothReads(service, w.sup, indexListing(w.sup, "lib", false));
      expect({ entries: kept.work.entries.length, limited: kept.work.limited, lib: kept.lib?.state }).toEqual({ entries: SUBMODULE_WORK_TARGETS, limited: 1, lib: "checked" });
    }),
    TIMEOUT_MS,
  );
});

// ---- T114: readSubmoduleWork in pages (contract Δ3 "Pages", data-model §16, plan.md D19 "Pages" and "Deadline per page") ----

const pageOutcome = (r: ServiceResponse<Work>) => ({
  ...outcome(r),
  snapshotId: r.result?.snapshotId,
  entries: r.result?.entries.map((e) => `${e.path} ${e.state === "unchecked" ? `${e.reason} ${e.code}` : e.state}`),
  next: r.result?.next,
});
// `lib` and `m/000` to `m/014` in index order: page 0 of a world with more than SUBMODULE_WORK_PAGE gitlinks.
const PAGE_0 = ["lib", ...mPaths(SUBMODULE_WORK_PAGE - 1)];
// The test-injected read deadline of each page (`readDeadlineMs` seam).
const PAGE_DEADLINE_MS = 3_000;

describe("readSubmoduleWork pages (contract Δ3 \"Pages\", data-model §16)", () => {
  caseTest("T114", "(1) 33 gitlinks give pages of 16, 16, and 1 with next 1, 2, and null and limited 0; the joined pages equal Git's index order and parent status; each page runs status only for its own paths", SHELL, () =>
    withService({ name: "t114-pages" }, async (service) => {
      const w = world("pages");
      addGitlinks(w, mPaths(32));
      git(w.sup, ["commit", "-q", "--no-verify", "-m", "many"]);
      // One edit on each page: untracked, tracked, and both.
      writeFileSync(join(w.sup, "m", "003", "new.txt"), "new\n");
      writeFileSync(join(w.sup, "m", "020", "f.txt"), "edit\n");
      writeFileSync(join(w.sup, "m", "031", "f.txt"), "edit\n");
      writeFileSync(join(w.sup, "m", "031", "new.txt"), "new\n");
      const { work, responses } = await readWork(service, w.sup);
      const pages = responses.map((r) => r.result!);
      expect(pages.map((p) => ({ entries: p.entries.length, next: p.next, limited: p.limited, extraRows: p.extraRows.map((r) => r.path) }))).toEqual([
        { entries: 16, next: 1, limited: 0, extraRows: ["m/003"] },
        { entries: 16, next: 2, limited: 0, extraRows: ["m/020"] },
        { entries: 1, next: null, limited: 0, extraRows: ["m/031"] },
      ]);
      // Git's own facts: the stage-0 160000 records of `ls-files -z --stage` in index order, and the parent status with none on a copy.
      const gitlinks = gitText(w.sup, ["ls-files", "-z", "--stage"]).split("\0").filter((r) => /^160000 \S+ 0\t/.test(r)).map((r) => r.slice(r.indexOf("\t") + 1));
      expect(work.entries.map((e) => e.path)).toEqual(gitlinks);
      const expected = parentOracle(w.root, w.sup);
      for (const path of gitlinks) expected[path] ??= { modified: false, untracked: false };
      expect(states(work)).toEqual(expected);
      // git-status(1) porcelain v2 with dirty gives no record, so each edited gitlink is an extra row (spec FR-075).
      expect(gitText(w.sup, ["status", "--porcelain=v2", "-z", "--ignore-submodules=dirty"])).toBe("");
      expect(work.extraRows.map((r) => r.path)).toEqual(gitlinks.filter((p) => expected[p]!.modified || expected[p]!.untracked));
      const top = gitText(w.sup, ["rev-parse", "--show-toplevel"]).trim();
      for (const [page, r] of responses.entries()) {
        const at = (await pageRuns(service, [r], isStatus)).map((c) => gitLocation(c.arguments)!).map((l) => (l.startsWith(`${top}/`) ? l.slice(top.length + 1) : l));
        expect({ page, at: at.sort() }).toEqual({ page, at: r.result!.entries.map((e) => e.path).sort() });
      }
    }),
    TIMEOUT_MS,
  );

  caseTest("T114", "(2) an unlisted moved gitlink after 16 targets is the only entry of page 1, and page 1 starts no submodule process", SHELL, () =>
    withService({ name: "t114-moved" }, async (service) => {
      const w = world("page-moved");
      git(inLib(w), ["checkout", "-q", "--detach", w.c[2]!]);
      addGitlinks(w, mPaths(SUBMODULE_WORK_PAGE));
      expect(parentRecord(w.sup, "lib")).toBe(MOVED_RECORD);
      const { work, responses } = await bothReads(service, w.sup, indexListing(w.sup, "lib", true));
      expect(responses.map(pageOutcome)).toEqual([
        { ...SUCCEEDED, snapshotId: work.snapshotId, entries: mPaths(SUBMODULE_WORK_PAGE).map((p) => `${p} checked`), next: 1 },
        { ...SUCCEEDED, snapshotId: work.snapshotId, entries: ["lib not-located"], next: null },
      ]);
      expect((await pageRuns(service, [responses[1]!], () => true)).map((c) => c.arguments)).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest("T114", "(3) a snapshot without gitlinks gives page 0 with no entries and next null; page 1 gives INVALID_REQUEST and starts no Git process", SHELL, () =>
    withService({ name: "t114-none" }, async (service) => {
      const repo = join(fixtureDir(`t114-none-${++builds}`), "repo");
      mkdirSync(repo);
      git(repo, ["init", "-q"]);
      commitIn(repo, "one");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const { pages } = await workPages<Work>(service, repositoryId, read);
      expect(pages).toEqual([{ snapshotId: read.snapshotId, entries: [], extraRows: [], limited: 0, next: null }]);
      const before = service.runner.calls.length;
      const r = await service.request<Work>("readSubmoduleWork", { snapshotId: read.snapshotId, page: 1 }, envelope(read, repositoryId));
      expect(outcome(r)).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      expect(service.runner.calls.slice(before).map((c) => c.arguments)).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest("T114", "(4) after a new snapshot, page 1 of the replaced snapshot gives UNKNOWN_TARGET and starts no Git process; page 1 of the new snapshot succeeds", SHELL, () =>
    withService({ name: "t114-old" }, async (service) => {
      const w = world("page-old");
      addGitlinks(w, mPaths(SUBMODULE_WORK_PAGE));
      const { repositoryId } = await service.register(w.sup);
      const s1 = await readOk(service, repositoryId);
      const page0 = await service.request<Work>("readSubmoduleWork", { snapshotId: s1.snapshotId, page: 0 }, envelope(s1, repositoryId));
      expect(pageOutcome(page0)).toEqual({ ...SUCCEEDED, snapshotId: s1.snapshotId, entries: PAGE_0.map((p) => `${p} checked`), next: 1 });
      writeFileSync(join(w.sup, "later.txt"), "later\n");
      const s2 = await readOk(service, repositoryId);
      expect(s2.snapshotId).not.toBe(s1.snapshotId);
      const before = service.runner.calls.length;
      const old = await service.request<Work>("readSubmoduleWork", { snapshotId: s1.snapshotId, page: 1 }, envelope(s2, repositoryId));
      expect(outcome(old)).toEqual({ state: "rejected", code: "UNKNOWN_TARGET" });
      expect(service.runner.calls.slice(before).map((c) => c.arguments)).toEqual([]);
      const current = await service.request<Work>("readSubmoduleWork", { snapshotId: s2.snapshotId, page: 1 }, envelope(s2, repositoryId));
      expect(pageOutcome(current)).toEqual({ ...SUCCEEDED, snapshotId: s2.snapshotId, entries: ["m/015 checked"], next: null });
    }),
    TIMEOUT_MS,
  );

  caseTest("T114", `(6) each page has its own read deadline: with a ${PAGE_DEADLINE_MS} ms deadline and a held status on page 0, only the page 0 targets give DEADLINE, and page 1 gives checked`, SHELL, () =>
    withService({ name: "t114-deadline", readDeadlineMs: PAGE_DEADLINE_MS }, async (service) => {
      const w = world("page-deadline");
      addGitlinks(w, mPaths(SUBMODULE_WORK_PAGE));
      const { repositoryId } = await service.register(w.sup);
      const read = await readOk(service, repositoryId);
      // A paused stdout holds each submodule status until the abort of the page deadline releases it.
      const release = service.runner.pauseStdout(isStatus);
      const page0 = await service.request<Work>("readSubmoduleWork", { snapshotId: read.snapshotId, page: 0 }, envelope(read, repositoryId)).finally(release);
      const page1 = await service.request<Work>("readSubmoduleWork", { snapshotId: read.snapshotId, page: 1 }, envelope(read, repositoryId));
      expect([page0, page1].map(pageOutcome)).toEqual([
        { ...SUCCEEDED, snapshotId: read.snapshotId, entries: PAGE_0.map((p) => `${p} failed DEADLINE`), next: 1 },
        { ...SUCCEEDED, snapshotId: read.snapshotId, entries: ["m/015 checked"], next: null },
      ]);
    }),
    TIMEOUT_MS,
  );

  caseTest("T114", "(7) a page accepted on the old snapshot ends succeeded with its entries and next after a new readWorkspace", SHELL, () =>
    withService({ name: "t114-across" }, async (service) => {
      const w = world("page-across");
      addGitlinks(w, mPaths(SUBMODULE_WORK_PAGE));
      const { repositoryId } = await service.register(w.sup);
      const s1 = await readOk(service, repositoryId);
      const release = service.runner.holdStart(isStatus);
      const sent = service.send("readSubmoduleWork", { snapshotId: s1.snapshotId, page: 0 }, envelope(s1, repositoryId));
      let s2: WorkspaceResult;
      try {
        const operationId = await service.operationId(sent);
        await until(() => service.runner.calls.some((c) => c.operationId === operationId && isStatus(c)), "a held page 0 status", TIMEOUT_MS / 10);
        writeFileSync(join(w.sup, "later.txt"), "later\n");
        s2 = await readOk(service, repositoryId);
      } finally {
        release();
      }
      expect(s2.snapshotId).not.toBe(s1.snapshotId);
      expect(pageOutcome(await service.response<Work>(sent))).toEqual({ ...SUCCEEDED, snapshotId: s1.snapshotId, entries: PAGE_0.map((p) => `${p} checked`), next: 1 });
    }),
    TIMEOUT_MS,
  );
});

// ---- T115: the WSL route of the fixed script `submoduleWork` through a stub runner (contract Δ3 `readSubmoduleWork` "WSL route", Δ6, plan.md D19 "WSL") ----
// The stub workspace names a distro that no case starts. Each case calls `createSubmoduleReads` directly, so no `wsl.exe` process starts.

const WSL_DISTRO = "Arbareto-Test";
const WSL_SUPER = "/home/u/super";
const WSL_LAUNCH = { wslExecutable: "C:\\Windows\\System32\\wsl.exe", systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", setsid: "/usr/bin/setsid", noexpand: true };
const WSL_GIT = "/usr/bin/git";
const uncOf = (linux: string) => `\\\\wsl.localhost\\${WSL_DISTRO}${linux.replaceAll("/", BACKSLASH)}`;
const STUB_WORKSPACE = {
  repositoryId: crypto.randomUUID(),
  gitInstallationId: crypto.randomUUID(),
  worktreeRoot: uncOf(WSL_SUPER),
  gitDirectory: uncOf(`${WSL_SUPER}/.git`),
  commonDirectory: uncOf(`${WSL_SUPER}/.git`),
  worktreeIdentity: [{}, {}],
  commonIdentity: {},
  objectFormat: "sha1",
  wsl: { distro: WSL_DISTRO, guid: "{00000000-0000-4000-8000-000000000000}", path: WSL_GIT, pathEnv: "/usr/bin:/bin", ...WSL_LAUNCH },
} as unknown as Workspace;
// The parent gate passes. The stub has no other trust fact.
const STUB_TRUST = { listTrust: async () => ({ ok: true, listing: {} }), gate: () => null } as unknown as Trust;
// Contract §5 "Native stdout/stderr chunk".
const STUB_CHUNK = 64 * 1024;
const STUB_HOLD_MS = 10_000;
const STUB_DEADLINE_MS = 1_000;
const OID = "1".repeat(40);
const MODIFIED = `1 .M N... 100644 100644 100644 ${OID} ${OID} f.txt\0`;
const UNTRACKED = "? new.txt\0";
const CLEAN = { modified: false, untracked: false };
const failedWith = (code: string) => ({ reason: "failed", code });
const at = (path: string) => `${WSL_SUPER}/${path}`;

// `<i> <exit> <n>\n` and the output, or `<i> limit <bound>\n` and the first `bound` bytes of the output.
const frame = (i: number, exit: number, out: string | Buffer) => Buffer.concat([Buffer.from(`${i} ${exit} ${Buffer.byteLength(out)}\n`), Buffer.from(out)]);
const limitFrame = (i: number, bound: number, out: Buffer) => Buffer.concat([Buffer.from(`${i} limit ${bound}\n`), out.subarray(0, bound)]);

type StubRun = { phase: string; bound: string; folder: string; targets: string[]; call: GitCall };
type StubReply = { out?: Buffer; exit?: Partial<GitExit>; refuse?: true; hold?: true };
// The facts of one submodule by distro path. `top`: the check 5 output, by default the folder. `config` and `status`: the outputs, empty by default.
type StubFacts = { top?: string; config?: string; status?: string };

// Each command of a run exits 0 with the output of `facts`.
const framesOf = (run: StubRun, facts: Record<string, StubFacts> = {}) =>
  Buffer.concat(
    run.targets.flatMap((target, i) => {
      const f = facts[target] ?? {};
      return run.phase === "a" ? [frame(i, 0, f.top ?? `${target}\n`), frame(i, 0, f.config ?? "")] : [frame(i, 0, f.status ?? "")];
    }),
  );

// A runner that answers each `submoduleWork` run through `reply`. Any other Git run fails the case. `absent` names the folders that do not exist.
function workStub(reply: (run: StubRun) => StubReply, absent: ReadonlySet<string> = new Set()) {
  const runs: StubRun[] = [];
  const runner = {
    async run(call: GitCall): Promise<GitExit> {
      if (call.script !== "submoduleWork") throw new Error(`a Git run without the script: ${call.arguments.join(" ")}`);
      checkCall(call);
      const [folder = "", phase = "", bound = "", ...targets] = call.arguments;
      const run = { phase, bound, folder, targets, call };
      runs.push(run);
      const r = reply(run);
      if (r.refuse) throw new RunnerRefusal("INVALID_REQUEST", "submoduleWork");
      const out = r.out ?? Buffer.alloc(0);
      // Contract §6 `stop`: a limited stdout collector of a read ends the run.
      for (let i = 0; i < out.length && !call.stdout.limited; i += STUB_CHUNK) call.stdout.push(out.subarray(i, i + STUB_CHUNK));
      if (r.hold) {
        await new Promise((resolve) => {
          call.signal.addEventListener("abort", resolve, { once: true });
          setTimeout(resolve, STUB_HOLD_MS);
        });
      }
      return { exitCode: call.signal.aborted || call.stdout.limited ? null : 0, activeDescendants: 0, ...r.exit };
    },
    async fileFacts(request: { files: { path: string[] }[] }) {
      return request.files.map(({ path }) => {
        const git = path.at(-1) === ".git";
        return absent.has((git ? path.slice(0, -1) : path).join("/")) ? { kind: "absent" } : { kind: git ? "file" : "directory" };
      });
    },
  };
  return { runner: runner as unknown as GitRunner, runs };
}

const gitlinkOf = (path: string): IndexEntry => ({ path: Buffer.from(path), stage: 0, mode: "160000", oid: OID, intentToAdd: false, assumeUnchanged: false, skipWorktree: false });
// One page on the stub workspace. The snapshot index holds `paths` as gitlinks in this order.
async function stubPage(runner: GitRunner, paths: readonly string[], page = 0, readDeadlineMs = READ_DEADLINE_MS): Promise<Work> {
  const reads = createSubmoduleReads({ runner, trust: STUB_TRUST, environment: {}, readDeadlineMs });
  const snapshot = { snapshotId: crypto.randomUUID(), indexEntries: paths.map(gitlinkOf), indexCut: undefined, completeness: { state: "complete" }, entries: [] };
  const t = { operationId: crypto.randomUUID(), signal: new AbortController().signal, workspace: STUB_WORKSPACE, installation: { selectedPath: null } };
  const r = await reads.readSubmoduleWork(t as never, snapshot as never, new Set(), page);
  expect({ result: r.result, code: "code" in r ? r.code : undefined }).toEqual({ result: "succeeded", code: undefined });
  return (r as { value: Work }).value;
}
const runsOf = (runs: StubRun[]) => runs.map((r) => `${r.phase} ${r.targets.map((t) => t.slice(WSL_SUPER.length + 1)).join(" ")}`);

// The `wsl.exe` command line of a script run with the widest unit number, as `tests/git/bun-runner.ts` and src-tauri/src/wsl.rs `submodule_work_command` build it.
const scriptUnits = (call: Pick<GitCall, "operationId" | "arguments">) =>
  commandLineUnits(WSL_LAUNCH.wslExecutable, [
    ...["--distribution", WSL_DISTRO, "--cd", "/", "--exec", "/bin/sh", "-c", wslProcess.wrapper.join("\n"), "sh", `arbareto-${call.operationId}-4294967295.scope`, "read", ""],
    ...[WSL_LAUNCH.systemdRun, WSL_LAUNCH.systemctl, WSL_LAUNCH.setsid, "1", "/bin/sh", "-c", wslProcess.submoduleWork.join("\n"), "sh", WSL_GIT, ...call.arguments],
  ]);

describe("readSubmoduleWork WSL route through a stub runner (contract Δ3 \"WSL route\", Δ6)", () => {
  caseTest("T115", "phase a runs once for the targets that pass check 4, phase b once for the located targets without programs, and each state follows its frames", [], async () => {
    const facts: Record<string, StubFacts> = {
      [at("both")]: { status: MODIFIED + UNTRACKED },
      [at("modified")]: { status: MODIFIED },
      [at("untracked")]: { status: UNTRACKED },
      [at("elsewhere")]: { top: `${at("elsewhere")}/inner\n` },
      [at("prog")]: { config: "local\0file:.git/config\0core.fsmonitor\n/usr/bin/false\0" },
    };
    const stub = workStub((run) => ({ out: framesOf(run, facts) }), new Set(["gone"]));
    const work = await stubPage(stub.runner, ["both", "clean", "elsewhere", "gone", "modified", "prog", "untracked"]);
    expect(states(work)).toEqual({
      both: { modified: true, untracked: true },
      clean: CLEAN,
      elsewhere: { state: "not-initialized" },
      gone: { state: "not-initialized" },
      modified: { modified: true, untracked: false },
      prog: { reason: "programs", code: undefined },
      untracked: { modified: false, untracked: true },
    });
    expect(work.extraRows.map((r) => r.path)).toEqual(["both", "modified", "untracked"]);
    expect(runsOf(stub.runs)).toEqual(["a both clean elsewhere modified prog untracked", "b both clean modified untracked"]);
    expect(stub.runs.map((r) => r.bound)).toEqual([String(TRUST_INPUT_BYTES), String(STATUS_LISTING_BYTES)]);
    // Each run takes its own `/tmp/arbareto-probe-<uuid>` folder, the policy `read`, and the registered context.
    const folders = stub.runs.map((r) => r.folder);
    expect({ owned: folders.map((f) => f.startsWith(MATCHING_PROBE_WSL_FOLDER) && isIdentifier(f.slice(MATCHING_PROBE_WSL_FOLDER.length))), distinct: new Set(folders).size }).toEqual({ owned: [true, true], distinct: 2 });
    const context = { contextKind: "registeredOperation" as const, gitInstallationId: STUB_WORKSPACE.gitInstallationId, repositoryId: STUB_WORKSPACE.repositoryId };
    expect(stub.runs.map((r) => ({ policy: r.call.environmentPolicy, context: r.call.context, transaction: r.call.transaction, input: r.call.input }))).toEqual([0, 1].map(() => ({ policy: "read", context, transaction: undefined, input: undefined })));
  });

  caseTest("T115", "a config limit frame and a check 5 output above 64 KiB give OUTPUT_LIMIT; a failed check 5 gives not-initialized before its config limit frame", [], async () => {
    const config = Buffer.alloc(TRUST_INPUT_BYTES, "x");
    const stub = workStub((run) => {
      if (run.phase === "b") return { out: framesOf(run) };
      const t = run.targets;
      return {
        out: Buffer.concat([
          frame(0, 0, `${t[0]}\n`),
          limitFrame(0, TRUST_INPUT_BYTES, config),
          frame(1, 0, `/${"x".repeat(DIAGNOSTIC_RETAINED_BYTES_PER_STREAM)}\n`),
          frame(1, 0, ""),
          frame(2, 0, `${t[2]}/inner\n`),
          limitFrame(2, TRUST_INPUT_BYTES, config),
          frame(3, 0, `${t[3]}\n`),
          frame(3, 0, ""),
        ]),
      };
    });
    const work = await stubPage(stub.runner, ["a", "b", "c", "d"]);
    expect(states(work)).toEqual({ a: failedWith("OUTPUT_LIMIT"), b: failedWith("OUTPUT_LIMIT"), c: { state: "not-initialized" }, d: CLEAN });
    expect(runsOf(stub.runs)).toEqual(["a a b c d", "b d"]);
  });

  caseTest("T115", "a status limit frame gives checked when its bytes set both facts; without both facts it gives OUTPUT_LIMIT, also when the bytes end on a record boundary", [], async () => {
    // Records of 512 bytes: the first STATUS_LISTING_BYTES bytes end on a record boundary and hold fewer records than STATUS_LISTING_RECORDS.
    const size = 512;
    const record = (head: string) => Buffer.from(`${head}${"p".repeat(size - head.length - 1)}\0`);
    const modified = record(`1 .M N... 100644 100644 100644 ${OID} ${OID} `);
    expect({ records: STATUS_LISTING_BYTES / size < STATUS_LISTING_RECORDS, whole: STATUS_LISTING_BYTES % size }).toEqual({ records: true, whole: 0 });
    const only = Buffer.alloc(STATUS_LISTING_BYTES, modified);
    const both = Buffer.alloc(STATUS_LISTING_BYTES, modified);
    record("? ").copy(both, size);
    const stub = workStub((run) => ({ out: run.phase === "a" ? framesOf(run) : Buffer.concat([limitFrame(0, STATUS_LISTING_BYTES, both), limitFrame(1, STATUS_LISTING_BYTES, only)]) }));
    const work = await stubPage(stub.runner, ["both", "one"]);
    expect(states(work)).toEqual({ both: { modified: true, untracked: true }, one: failedWith("OUTPUT_LIMIT") });
  });

  // Target `a` has whole frames in phase a. The output breaks after them.
  for (const [name, broken] of [
    ["a leading zero in n", "1 0 01\nx"],
    ["an index out of order", "2 0 0\n"],
    ["an exit above 255", "1 256 0\n"],
    ["an n above the bound", `1 0 ${TRUST_INPUT_BYTES + 1}\n`],
    ["a limit head with another bound", "1 limit 1\nx"],
    ["a head longer than the longest head", `1 0 ${"9".repeat(40)}`],
    ["an output that ends inside a frame", "1 0 9\n/x"],
    ["an output without the later frames", ""],
  ] as const) {
    caseTest("T115", `${name} gives MALFORMED_GIT_OUTPUT to each target of the run without whole frames; the target before it keeps its state`, [], async () => {
      const stub = workStub((run) => ({ out: run.phase === "a" ? Buffer.concat([frame(0, 0, `${run.targets[0]}\n`), frame(0, 0, ""), Buffer.from(broken)]) : framesOf(run) }));
      const work = await stubPage(stub.runner, ["a", "b", "c"]);
      expect(states(work)).toEqual({ a: CLEAN, b: failedWith("MALFORMED_GIT_OUTPUT"), c: failedWith("MALFORMED_GIT_OUTPUT") });
      expect(runsOf(stub.runs)).toEqual(["a a b c", "b a"]);
    });
  }

  caseTest("T115", "bytes after the last frame stop the run, and each target keeps the state of its whole frames", [], async () => {
    const stub = workStub((run) => ({ out: Buffer.concat([framesOf(run, { [at("b")]: { status: MODIFIED } }), Buffer.from("0 0 0\n")]) }));
    const work = await stubPage(stub.runner, ["a", "b"]);
    expect(states(work)).toEqual({ a: CLEAN, b: { modified: true, untracked: false } });
    expect(stub.runs.map((r) => r.call.stdout.limited)).toEqual([true, true]);
  });

  caseTest("T115", "a script exit 125, an exit 1 after whole frames, a refusal, and the diagnostic bound give each target of the run without whole frames its failure", [], async () => {
    const page = async (reply: (run: StubRun) => StubReply) => {
      const stub = workStub(reply);
      return { states: states(await stubPage(stub.runner, ["a", "b", "c"])), runs: runsOf(stub.runs) };
    };
    const each = (code: string) => ({ a: failedWith(code), b: failedWith(code), c: failedWith(code) });
    const firstOnly = (run: StubRun) => framesOf({ ...run, targets: run.targets.slice(0, 1) });
    expect(await page((run) => (run.phase === "a" ? { exit: { exitCode: 125 } } : { out: framesOf(run) }))).toEqual({ states: each("GIT_FAILED"), runs: ["a a b c"] });
    expect(await page((run) => (run.phase === "a" ? { out: firstOnly(run), exit: { exitCode: 1 } } : { out: framesOf(run) }))).toEqual({
      states: { a: CLEAN, b: failedWith("GIT_FAILED"), c: failedWith("GIT_FAILED") },
      runs: ["a a b c", "b a"],
    });
    expect(await page((run) => (run.phase === "a" ? { refuse: true } : { out: framesOf(run) }))).toEqual({ states: each("INVALID_REQUEST"), runs: ["a a b c"] });
    expect(await page((run) => (run.phase === "b" ? { refuse: true } : { out: framesOf(run) }))).toEqual({ states: each("INVALID_REQUEST"), runs: ["a a b c", "b a b c"] });
    expect(await page((run) => (run.phase === "b" ? { out: firstOnly(run), exit: { exitCode: null, diagnosticLimit: true } } : { out: framesOf(run) }))).toEqual({
      states: { a: CLEAN, b: failedWith("OUTPUT_LIMIT"), c: failedWith("OUTPUT_LIMIT") },
      runs: ["a a b c", "b a b c"],
    });
  });

  caseTest("T115", "a deadline in the middle of phase b keeps the states of whole frames and of phase a, and gives DEADLINE to each other target of the page", [], async () => {
    const DEADLINE = failedWith("DEADLINE");
    for (const ending of [{ hold: true } as const, { exit: { exitCode: null, deadline: "deadline" } } as const]) {
      const stub = workStub(
        (run) => (run.phase === "a" ? { out: framesOf(run, { [at("elsewhere")]: { top: "/elsewhere\n" } }) } : { out: Buffer.concat([frame(0, 0, MODIFIED), Buffer.from("1 0 100\n1 .M")]), ...ending }),
        new Set(["gone"]),
      );
      const work = await stubPage(stub.runner, ["a", "b", "c", "elsewhere", "gone"], 0, "hold" in ending ? STUB_DEADLINE_MS : READ_DEADLINE_MS);
      expect({ ending, states: states(work), runs: runsOf(stub.runs) }).toEqual({
        ending,
        states: { a: { modified: true, untracked: false }, b: DEADLINE, c: DEADLINE, elsewhere: { state: "not-initialized" }, gone: { state: "not-initialized" } },
        runs: ["a a b c elsewhere", "b a b c"],
      });
    }
  });

  caseTest("T115", "a phase whose targets pass the command-line bound splits into runs in page order; a target that fits no run alone gives INVALID_REQUEST and no run", [], async () => {
    const long = (components: number) => Array.from({ length: components }, () => "x".repeat(FILE_FACT_COMPONENT_UNITS)).join("/");
    const paths = Array.from({ length: SUBMODULE_WORK_PAGE }, (_, i) => `t${String(i).padStart(2, "0")}/${long(i === 3 ? 130 : 11)}`);
    const stub = workStub((run) => ({ out: framesOf(run) }));
    const work = await stubPage(stub.runner, paths);
    expect(work.entries.map((e) => (e.state === "unchecked" ? e.code : e.state))).toEqual(paths.map((_, i) => (i === 3 ? "INVALID_REQUEST" : "checked")));
    const fitting = paths.filter((_, i) => i !== 3).map(at);
    for (const phase of ["a", "b"]) {
      const runs = stub.runs.filter((r) => r.phase === phase);
      expect({ phase, runs: runs.length, targets: runs.flatMap((r) => r.targets) }).toEqual({ phase, runs: 2, targets: fitting });
      for (const [k, r] of runs.entries()) {
        expect({ phase, k, fits: scriptUnits(r.call) <= WINDOWS_COMMAND_LINE_UNITS }).toEqual({ phase, k, fits: true });
        // Each run takes the next targets in page order that fit, so the first target of the next run does not fit this run.
        const next = runs[k + 1]?.targets[0];
        if (next !== undefined) expect({ phase, k, fits: scriptUnits({ ...r.call, arguments: [...r.call.arguments, next] }) <= WINDOWS_COMMAND_LINE_UNITS }).toEqual({ phase, k, fits: false });
      }
    }
  });

  caseTest("T115", "33 gitlinks give 3 pages, and each page runs phase a once and phase b once on its own targets", [], async () => {
    const paths = mPaths(33);
    const stub = workStub((run) => ({ out: framesOf(run) }));
    for (let page = 0; page < 3; page++) {
      const from = stub.runs.length;
      const work = await stubPage(stub.runner, paths, page);
      const own = paths.slice(page * SUBMODULE_WORK_PAGE, (page + 1) * SUBMODULE_WORK_PAGE);
      expect({ page, next: work.next, entries: work.entries.map((e) => `${e.path} ${e.state}`) }).toEqual({ page, next: page < 2 ? page + 1 : null, entries: own.map((p) => `${p} checked`) });
      expect(runsOf(stub.runs.slice(from))).toEqual([`a ${own.join(" ")}`, `b ${own.join(" ")}`]);
    }
  });
});

// T121 analyze finding U1: `workingParts` passes a path that is no valid UTF-8 (WSL), so rule 2 refuses it with reason `path`.
describe("submoduleHead of a path without components (contract §6 \"File facts\", plan.md D20 rule 2)", () => {
  caseTest("T121", "a path that is no valid UTF-8 gives {refused: path} before any Git process", [], async () => {
    const runner = { run: () => { throw new Error("no Git process may start"); } };
    const t = { operationId: "o", signal: new AbortController().signal, workspace: {}, installation: { selectedPath: "git" } };
    expect(await submoduleHead(runner as never, t as never, Uint8Array.of(0x6c, 0xff))).toEqual({ value: { refused: "path" } });
  });
});

// ---- T108: SC-012 cost on the service ----

describe("SC-012 local-edit marks cost (plan.md O-11, service read)", () => {
  for (const count of [100, SUBMODULE_WORK_TARGETS]) {
    caseTest("T108", `${count} initialized clean submodules: the readSubmoduleWork time, median of 10 warm runs`, SHELL, () =>
      withService({ name: `t108-${count}` }, async (service) => {
        const w = world(`cost-${count}`);
        const index: string[] = [];
        // `lib` and `count - 1` more gitlinks give `count` targets.
        for (let i = 0; i < count - 1; i++) {
          const path = `m/${String(i).padStart(3, "0")}`;
          cpSync(w.lib, join(w.sup, ...path.split("/")), { recursive: true });
          index.push(`160000 ${w.c[0]!}\t${path}`);
        }
        git(w.sup, ["update-index", "--index-info"], { input: Buffer.from(`${index.join("\n")}\n`) });
        git(w.sup, ["commit", "-q", "--no-verify", "-m", "many"]);
        for (let i = 0; i < count - 1; i++) git(join(w.sup, "m", String(i).padStart(3, "0")), ["status", "-s"]);
        const times: number[] = [];
        for (let run = 0; run < 11; run++) {
          const { work, ms } = await readWork(service, w.sup);
          if (run > 0) times.push(ms);
          expect(work.entries.filter((e) => !(e.state === "checked" && !e.modified && !e.untracked))).toEqual([]);
        }
        const kinds = new Map<string, number[]>();
        for (const c of service.runner.calls.filter((c) => c.arguments.includes("--git-dir=.git"))) {
          const k = c.arguments.slice(4, 6).join(" ");
          kinds.set(k, [...(kinds.get(k) ?? []), c.durationMs ?? 0]);
        }
        for (const [k, v] of kinds) console.log(`SC012 ${count} step ${k}: ${v.length} runs, mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(0)} ms`);
        times.sort((a, b) => a - b);
        console.log(`SC012 ${count} submodules: median ${((times[4]! + times[5]!) / 2).toFixed(0)} ms, min ${times[0]!.toFixed(0)} ms, max ${times.at(-1)!.toFixed(0)} ms (readSubmoduleWork response after the readWorkspace result, warm, in-process service)`);
      }),
      TIMEOUT_MS,
    );
  }
});
