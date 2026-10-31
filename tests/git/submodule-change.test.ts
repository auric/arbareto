// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T106 to T108: feature 005 contract Δ3 `readSubmoduleChange` and `readSubmoduleWork` through the in-process service (plan.md D19, data-model §15 and §16).
// Spec FR-069 to FR-076, SC-012. The oracle is Git's own `rev-list`, `log`, and `status` inside the submodule, and the parent status with `--ignore-submodules=none` on a copy.

import { describe, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadSubmoduleChangeResult, ReadSubmoduleWorkResult } from "../../src/contracts/envelope";
import { FILE_FACT_COMPONENT_UNITS, STATUS_LISTING_RECORDS, SUBMODULE_WORK_PARALLEL, SUBMODULE_WORK_TARGETS } from "../../src/contracts/limits";
import { statusArgs } from "../../src/git-service/commands";
import { printOrigin } from "../origin";
import { fixtureDir, serviceEnv, useFixtureRoot } from "./fixture-root";
import { git, gitPath, gitText, readOk, withService } from "./hunk-harness";
import { load } from "./history-view-harness";
import { caseTest, type Capability, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";
import { canary } from "./workbench-fixtures";

for (const module of ["submodule-change", "session", "commands"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
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
  state: { state: "commits"; added: number; removed: number; addedCommits: Commit[]; removedCommits: Commit[] } | { state: "missing"; which: string } | { state: "not-initialized" } | { state: "single" };
  limited: boolean;
}
type WorkEntry =
  | { pathBytes: string; path: string; state: "checked"; modified: boolean; untracked: boolean }
  | { pathBytes: string; path: string; state: "not-initialized" }
  | { pathBytes: string; path: string; state: "unchecked"; reason: string; code?: string };
interface Work {
  snapshotId: string;
  entries: WorkEntry[];
  extraRows: { pathBytes: string; path: string }[];
  limited: number;
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

  caseTest("T106", "a snapshot whose index listing reached STATUS_LISTING_RECORDS gives OUTPUT_LIMIT for both reads, before any submodule process", SHELL, () =>
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
      const work = await service.request<Work>("readSubmoduleWork", { snapshotId: read.result!.snapshotId }, envelope(read.result!, repositoryId));
      expect({ state: work.state, code: work.code }).toEqual({ state: "failed", code: "OUTPUT_LIMIT" });
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

async function readWork(service: Service, sup: string): Promise<{ work: Work; read: WorkspaceResult; response: ServiceResponse<Work>; repositoryId: string; ms: number }> {
  const { repositoryId } = await service.register(sup);
  const read = await readOk(service, repositoryId);
  const started = performance.now();
  const response = await service.request<Work>("readSubmoduleWork", { snapshotId: read.snapshotId }, envelope(read, repositoryId));
  const ms = performance.now() - started;
  expect({ state: response.state, code: response.code }).toEqual({ state: "succeeded", code: undefined });
  expect(ReadSubmoduleWorkResult.safeParse(response.result).success).toBe(true);
  return { work: response.result!, read, response, repositoryId, ms };
}

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
  Object.fromEntries(work.entries.map((e) => [e.path, e.state === "checked" ? { modified: e.modified, untracked: e.untracked } : e.state === "not-initialized" ? { state: e.state } : { reason: e.reason, code: e.code }]));

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
      const { work, response } = await readWork(service, w.sup);
      // Contract Δ3: the gitlinks after the 256th in index order give one count and no entry.
      expect({ limited: work.limited, entries: work.entries.length, last: work.entries.at(-1)!.path }).toEqual({ limited: 1, entries: SUBMODULE_WORK_TARGETS, last: `m/${SUBMODULE_WORK_TARGETS - 2}` });
      const operationId = await service.operationId(response.requestId!);
      // Tasks.md T107 (4): the status processes. Each target runs its location check and its `config list` side by side.
      const runs = service.runner.calls.filter((c) => c.operationId === operationId && c.arguments.includes("--git-dir=.git") && c.arguments.includes("status"));
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
      const { work, response } = await readWork(service, w.sup);
      expect(states(work).lib).toEqual({ modified: true, untracked: true });
      const operationId = await service.operationId(response.requestId!);
      const status = service.runner.calls.find((c) => c.operationId === operationId && c.arguments.includes("status"))!;
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
      const r = await service.request<Work>("readSubmoduleWork", { snapshotId: first.snapshotId }, envelope(second, repositoryId));
      expect({ failed: r.state !== "succeeded", code: r.code }).toEqual({ failed: true, code: "UNKNOWN_TARGET" });
    }),
    TIMEOUT_MS,
  );
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
