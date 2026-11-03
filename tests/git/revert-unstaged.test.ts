// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T034: the `revert-unstaged` review and run of `src/git-service/revert.ts` (plan.md D5a, D6, D10; data-model §5, §7, §8; spec US3, FR-026 to FR-030).
// Oracle (plan.md D13): Git's own `restore .` on a copy of the fixture. Tests compare index bytes through `ls-files --stage -z` and working bytes by SHA-256.

import { describe, expect } from "bun:test";
import { heapStats } from "bun:jsc";
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunWorkbenchResult } from "../../src/contracts/envelope";
import { MULTI_FILE_ACTION_FILES } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { faGit, write } from "./file-actions-fixtures";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { copyRepo, gitPath, gitPathOf, outcome, readOk, SUCCEEDED, TIMEOUT_MS, until, withService } from "./hunk-harness";
import { caseTest, type Capability, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

for (const module of ["revert", "workbench-review", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T034";
const SHELL: Capability[] = ["shell-double"];
const LONG_TIMEOUT_MS = 600_000;
// Spec FR-030 and US3 scenario 7: Cancel stops the action before the next file.
const CANCEL_MS = 1_000;

type FileOutcome = { entryId: string; outcome: string; code?: string; reason?: string };
type RevertRun = { action: string; files: FileOutcome[]; foldersCreated: string[]; index: string; reason?: string };
type Reviewed = { action: string; plan: { count: number; paths: string[]; submodules: number }; workbenchToken: string };

// The line-ending keys and `core.filemode` of `tests/git/fixtures.ts` `lineEndings`.
const LINE_ENDINGS: [string, string][] = [
  ["core.autocrlf", "false"],
  ["core.eol", "lf"],
  ["core.safecrlf", "false"],
  ["core.filemode", "false"],
];

let builds = 0;
const g = (repo: string, args: string[], input?: string | Uint8Array) => faGit(gitPath(), repo, args, input === undefined ? {} : { input });
const b64 = (path: string) => Buffer.from(path).toString("base64");
const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function init(dir: string): string {
  mkdirSync(dir, { recursive: true });
  g(dir, ["init", "-q", "-b", "main"]);
  for (const [key, value] of LINE_ENDINGS) g(dir, ["config", key, value]);
  return dir;
}

function commitAll(repo: string, message: string): string {
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "--no-verify", "-m", message]);
  return g(repo, ["rev-parse", "HEAD"]).toString("utf8").trim();
}

// `files` is the committed content. `after` runs after the commit.
function build(name: string, files: Record<string, string | Uint8Array>, after?: (repo: string) => void): string {
  const repo = init(join(fixtureDir(`t034-${name}-${++builds}`), "repo"));
  for (const [path, content] of Object.entries(files)) write(repo, path, content);
  commitAll(repo, "base");
  after?.(repo);
  return repo;
}

// A gitlink `mod` without `.gitmodules`. Its index entry records the first commit, and its HEAD moves to a second commit with a dirty file (porcelain v2 `SCM.`).
function addSubmodule(repo: string): void {
  const mod = init(join(repo, "mod"));
  write(mod, "m.txt", "m1\n");
  const first = commitAll(mod, "m1");
  g(repo, ["update-index", "--add", "--cacheinfo", `160000,${first},mod`]);
  g(repo, ["commit", "-q", "--no-verify", "-m", "record mod"]);
  write(mod, "m.txt", "m2\n");
  commitAll(mod, "m2");
  write(mod, "m.txt", "m3 dirty\n");
}

const indexOf = (repo: string) => g(repo, ["ls-files", "--stage", "-z"]).toString("latin1");
const rawIndex = (repo: string) => sha256(readFileSync(gitPathOf(repo, "index")));
const state = (repo: string) => ({ index: indexOf(repo), raw: rawIndex(repo), files: workingFileDigests(repo) });
const gitTemps = (repo: string) => readdirSync(repo).filter((name) => name.startsWith(".merge_file_"));
const below = (files: Record<string, string>, prefixes: readonly string[]) => Object.fromEntries(Object.entries(files).filter(([path]) => prefixes.some((p) => path === p || path.startsWith(`${p}/`))));

// Git's own `restore .` on a copy (plan.md D13).
function restored(repo: string): Record<string, string> {
  const copy = copyRepo(repo, `t034-oracle-${++builds}`);
  g(copy, ["restore", "."]);
  return workingFileDigests(copy);
}

async function open(service: Service, repo: string): Promise<{ r: RegistrationResult; read: WorkspaceResult }> {
  const r = await service.register(repo);
  return { r, read: await readOk(service, r.repositoryId) };
}

const review = (service: Service, r: RegistrationResult, read: WorkspaceResult, extra: object = {}) =>
  service.request<Reviewed>("reviewWorkbench", { snapshotId: read.snapshotId, action: "revert-unstaged", ...extra }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });

async function reviewOk(service: Service, r: RegistrationResult, read: WorkspaceResult): Promise<Reviewed> {
  const response = await review(service, r, read);
  expect({ ...outcome(response), result: response.state === "succeeded" ? "plan" : response.result }).toEqual({ ...SUCCEEDED, result: "plan" });
  return response.result!;
}

const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
async function run(service: Service, r: RegistrationResult, token: string): Promise<ServiceResponse<RevertRun>> {
  const response = await service.response<RevertRun>(sendRun(service, r, token));
  if (response.result !== undefined) expect(RunWorkbenchResult.safeParse(response.result).success).toBe(true);
  return response;
}

const refusal = (response: ServiceResponse<unknown>) => ({ state: response.state, code: response.code, result: response.result });
const frames = (service: Service, type: string) => service.runner.frames.filter((f) => f.type === type) as Record<string, unknown>[];
const unstagedIds = (read: WorkspaceResult, paths: readonly string[]) => paths.map((path) => read.entries.find((e) => e.path === path && e.category === "unstaged")!.entryId);
const counters = (service: Service) => (service.progress as { phase?: string; counters?: { fileIndex: number; fileCount: number } }[]).filter((p) => p.phase === "revert-files").map((p) => p.counters!);

describe("revert all unstaged changes: Git's restore bytes, the plan, and the writes (plan.md D5a, D6, D13)", () => {
  // The 005 tree order puts the files of a folder before the files beside it (005 FR-015).
  const COVERED = ["deep/er/udel.txt", "hidden/z.txt", "bin.dat", "crlf.txt", "del.txt", "ident.txt", "mod.txt", "newmod.txt", "part.txt", "wte.txt"];

  caseTest(TASK, "modified, partly staged, deleted, binary, CRLF, working-tree-encoding, ident, and staged-new files equal git restore . on a copy; the index, the untracked files, and the submodule tree stay", SHELL, () =>
    withService({ name: "t034-oracle" }, async (service) => {
      const binary = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
      const repo = build(
        "oracle",
        {
          ".gitattributes": "crlf.txt text eol=crlf\nwte.txt text working-tree-encoding=UTF-16LE\nident.txt ident\n",
          "mod.txt": "m1\n",
          "part.txt": "p1\n",
          "del.txt": "d1\n",
          "deep/er/udel.txt": "u1\n",
          "bin.dat": binary,
          "crlf.txt": "a\r\nb\r\n",
          "wte.txt": Buffer.from("w1\nw2\n", "utf16le"),
          "ident.txt": "a\n$Id$\n",
          "staged.txt": "s1\n",
          "hidden/z.txt": "z1\n",
          "keep.txt": "keep\n",
        },
        (r) => {
          // The submodule commit comes first, because it commits the whole index.
          addSubmodule(r);
          write(r, "mod.txt", "m2\n");
          write(r, "part.txt", "p2\n");
          g(r, ["--literal-pathspecs", "add", "--", "part.txt"]);
          write(r, "part.txt", "p3\n");
          rmSync(join(r, "del.txt"));
          rmSync(join(r, "deep"), { recursive: true });
          write(r, "bin.dat", binary.map((b) => b ^ 0x5a));
          write(r, "crlf.txt", "a\r\nB\r\n");
          write(r, "wte.txt", Buffer.from("w1\nW2\n", "utf16le"));
          write(r, "ident.txt", "b\n$Id$\n");
          // A staged change without a working change is no unstaged entry (spec FR-027).
          write(r, "staged.txt", "s2\n");
          g(r, ["--literal-pathspecs", "add", "--", "staged.txt"]);
          write(r, "hidden/z.txt", "z2\n");
          // A staged new file with a working change: the index entry is the source (data-model §3).
          write(r, "newmod.txt", "x\n");
          g(r, ["--literal-pathspecs", "add", "--", "newmod.txt"]);
          write(r, "newmod.txt", "y\n");
          write(r, "u1.txt", "untracked\n");
          write(r, "u/dir/u2.txt", "untracked too\n");
        },
      );
      const oracle = restored(repo);
      const before = state(repo);
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read);
      // Data-model §5 and spec US3 scenario 4: the plan counts the covered files and the submodule that stays.
      expect({ ...reviewed.plan, paths: [...reviewed.plan.paths].sort() }).toEqual({ count: COVERED.length, paths: COVERED.map(b64).sort(), submodules: 1 });
      expect(reviewed.plan.paths[0]).toBe(b64("deep/er/udel.txt"));
      const done = await run(service, r, reviewed.workbenchToken);
      // Data-model §8 and §9: each covered file names its outcome, and the run has no index part.
      expect({ ...outcome(done), result: done.result && { ...done.result, files: [...done.result.files].sort((a, b) => a.entryId.localeCompare(b.entryId)), foldersCreated: [...done.result.foldersCreated].sort() } }).toEqual({
        ...SUCCEEDED,
        result: {
          action: "revert-unstaged",
          files: unstagedIds(read, COVERED)
            .map((entryId) => ({ entryId, outcome: "reverted" }))
            .sort((a, b) => a.entryId.localeCompare(b.entryId)),
          foldersCreated: [b64("deep"), b64("deep/er")].sort(),
          index: "none",
        },
      });
      const after = state(repo);
      expect(after.files).toEqual(oracle);
      // Spec FR-028: the index does not change. Untracked files and the submodule tree keep every byte (spec FR-027).
      expect({ index: after.index, raw: after.raw }).toEqual({ index: before.index, raw: before.raw });
      expect(below(after.files, ["u1.txt", "u", "mod"])).toEqual(below(before.files, ["u1.txt", "u", "mod"]));
      expect(Object.keys(below(before.files, ["mod"])).length).toBeGreaterThan(0);
      // The source is the index entry, not the HEAD entry.
      expect({ part: readFileSync(join(repo, "part.txt"), "utf8"), newmod: readFileSync(join(repo, "newmod.txt"), "utf8") }).toEqual({ part: "p2\n", newmod: "x\n" });
      expect(gitTemps(repo)).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "the writes go through checkout-index --temp from the index entries, one fileReplace with a source per file, and the revert-files counters count every file (plan.md D5a, contract Δ2)", SHELL, () =>
    withService({ name: "t034-steps" }, async (service) => {
      const paths = ["sub/c.txt", "a.txt", "b.txt"];
      const repo = build("steps", { "a.txt": "a\n", "b.txt": "b\n", "sub/c.txt": "c\n", "keep.txt": "keep\n" }, (r) => {
        for (const path of paths) write(r, path, `${path} changed\n`);
      });
      const oracle = restored(repo);
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read);
      expect(reviewed.plan).toEqual({ count: 3, paths: paths.map(b64), submodules: 0 });
      const done = await run(service, r, reviewed.workbenchToken);
      expect({ ...outcome(done), files: done.result?.files }).toEqual({ ...SUCCEEDED, files: unstagedIds(read, paths).map((entryId) => ({ entryId, outcome: "reverted" })) });
      expect(workingFileDigests(repo)).toEqual(oracle);
      // Plan.md D5a step 2: one batch, the exact argument array, and the batch paths on stdin in tree order.
      const checkouts = service.runner.calls.filter((c) => c.arguments.includes("checkout-index"));
      expect(checkouts.map((c) => ({ first: c.arguments[0], tail: c.arguments.slice(-4), input: Buffer.from(c.input ?? new Uint8Array()).toString("latin1") }))).toEqual([
        { first: "--no-lazy-fetch", tail: ["checkout-index", "--temp", "--stdin", "-z"], input: paths.map((p) => `${p}\0`).join("") },
      ]);
      // Plan.md D5a step 5: each write copies Git's temporary file. No frame carries the bytes, and no Git command writes a target.
      const writes = frames(service, "fileReplace");
      expect(writes.map((f) => ({ target: f.target, bytes: "bytes" in f, source: /^\.merge_file_/.test(String((f.source as { name?: string } | undefined)?.name)) }))).toEqual(paths.map(() => ({ target: "working", bytes: false, source: true })));
      expect(service.runner.calls.some((c) => ["restore", "checkout", "apply", "reset", "stash"].includes(c.arguments.find((a) => !a.startsWith("-")) ?? ""))).toBe(false);
      expect({ removes: frames(service, "tempRemove").length, temps: gitTemps(repo) }).toEqual({ removes: 0, temps: [] });
      // Contract Δ2: `revert-files` counts from 0 to the file count. No index part runs, so no `revert-index` phase comes.
      expect(counters(service)).toEqual([0, 1, 2, 3].map((fileIndex) => ({ fileIndex, fileCount: 3 })));
      expect((service.progress as { phase?: string }[]).some((p) => p.phase === "revert-index")).toBe(false);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "the plan covers every unstaged entry, also the rows that a Filter files text hides, because the payload carries no filter (spec FR-027, 004 FR-101)", SHELL, () =>
    withService({ name: "t034-hidden" }, async (service) => {
      const paths = ["hidden/deep/x.txt", "a.txt", "b.txt"];
      const repo = build("hidden", { "a.txt": "a\n", "b.txt": "b\n", "hidden/deep/x.txt": "x\n" }, (r) => {
        for (const path of paths) write(r, path, `${path} changed\n`);
      });
      const { r, read } = await open(service, repo);
      // Contract Δ3: the payload is `{action, snapshotId}` only, so a filter text is no valid field.
      expect(outcome(await review(service, r, read, { filter: "a.txt" }))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      const reviewed = await reviewOk(service, r, read);
      expect(reviewed.plan).toEqual({ count: 3, paths: paths.map(b64), submodules: 0 });
      const done = await run(service, r, reviewed.workbenchToken);
      expect({ ...outcome(done), outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, outcomes: ["reverted", "reverted", "reverted"] });
    }),
    TIMEOUT_MS,
  );
});

describe("revert all unstaged changes: refusals (data-model §7, spec FR-026, FR-029)", () => {
  caseTest(TASK, "one refused entry makes the action unavailable; the value names the first 20 refused files in tree order with their reasons, and nothing changes", SHELL, () =>
    withService({ name: "t034-refused" }, async (service) => {
      const names = Array.from({ length: 22 }, (_, i) => `h${String(i).padStart(2, "0")}.txt`);
      const files = Object.fromEntries([...names, "ok.txt", "one/ok.txt"].map((name) => [name, `${name}\n`]));
      const repo = build("refused", files, (r) => {
        for (const name of Object.keys(files)) write(r, name, `${name} changed\n`);
        // A second hard link outside the worktree (spec FR-034 `hard-link`).
        for (const name of names) linkSync(join(r, name), join(fixtureDir(`t034-links-${builds}`), name));
      });
      const before = state(repo);
      const { r, read } = await open(service, repo);
      expect(refusal(await review(service, r, read))).toEqual({
        state: "failed",
        code: "WORKBENCH_UNAVAILABLE",
        result: { reason: "hard-link", files: names.slice(0, 20).map((name) => ({ path: b64(name), reason: "hard-link" })), more: 2 },
      });
      expect(state(repo)).toEqual(before);
      // A single refused entry among files that pass refuses the whole action (Clarifications, 2026-10-27).
      for (const name of names.slice(1)) {
        rmSync(join(fixtureDir(`t034-links-${builds}`), name));
      }
      const fresh = await readOk(service, r.repositoryId);
      expect(refusal(await review(service, r, fresh))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "hard-link", files: [{ path: b64("h00.txt"), reason: "hard-link" }], more: 0 } });
      expect({ writes: frames(service, "fileReplace").length, checkouts: service.runner.calls.filter((c) => c.arguments.includes("checkout-index")).length }).toEqual({ writes: 0, checkouts: 0 });
      expect(state(repo).files).toEqual(before.files);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "staged-only changes, untracked files, and a submodule give nothing-to-revert (spec FR-026, FR-027)", SHELL, () =>
    withService({ name: "t034-nothing" }, async (service) => {
      const repo = build("nothing", { "s.txt": "s1\n", "keep.txt": "keep\n" }, (r) => {
        // The submodule commit comes first, because it commits the whole index.
        addSubmodule(r);
        write(r, "s.txt", "s2\n");
        g(r, ["--literal-pathspecs", "add", "--", "s.txt"]);
        write(r, "u.txt", "u\n");
      });
      const before = state(repo);
      const { r, read } = await open(service, repo);
      expect(read.entries.filter((e) => e.category === "unstaged").map((e) => e.path)).toEqual(["mod"]);
      expect(refusal(await review(service, r, read))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "nothing-to-revert" } });
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `more than ${MULTI_FILE_ACTION_FILES} covered files give limit before any file read (spec FR-029)`, SHELL, () =>
    withService({ name: "t034-limit" }, async (service) => {
      const count = MULTI_FILE_ACTION_FILES + 1;
      const name = (i: number) => `many/f${String(i).padStart(5, "0")}.txt`;
      const repo = init(join(fixtureDir(`t034-limit-${++builds}`), "repo"));
      mkdirSync(join(repo, "many"));
      for (let i = 0; i < count; i++) writeFileSync(join(repo, ...name(i).split("/")), "x\n");
      commitAll(repo, "base");
      for (let i = 0; i < count; i++) writeFileSync(join(repo, ...name(i).split("/")), "y\n");
      const { r, read } = await open(service, repo);
      const facts = service.runner.fileFactCalls.length;
      expect(refusal(await review(service, r, read))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "limit" } });
      // Data-model §7 `limit`: the count of the snapshot decides, so the review reads the fact of no target.
      expect(service.runner.fileFactCalls.slice(facts).some((c) => c.files.some((f) => f.path[0] === "many"))).toBe(false);
    }),
    LONG_TIMEOUT_MS,
  );

  // Data-model §2: a consumed token answers only a repeat run, so it keeps no bound facts. Each bound file plan holds one `folders` Array.
  caseTest(TASK, "a consumed token keeps no bound file plans: the JS Array count stays flat from the second to the third review and run", SHELL, () =>
    withService({ name: "t034-consumed" }, async (service) => {
      const count = 2_000;
      const name = (i: number) => `many/f${String(i).padStart(5, "0")}.txt`;
      const repo = init(join(fixtureDir(`t034-consumed-${++builds}`), "repo"));
      mkdirSync(join(repo, "many"));
      for (let i = 0; i < count; i++) writeFileSync(join(repo, ...name(i).split("/")), "x\n");
      commitAll(repo, "base");
      const r = await service.register(repo);
      const arrays: number[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let i = 0; i < count; i++) writeFileSync(join(repo, ...name(i).split("/")), `y${cycle}\n`);
        const read = (await service.readWorkspace(r.repositoryId, { refresh: true, check: "full" })).result!;
        const reviewed = await reviewOk(service, r, read);
        expect(reviewed.plan.count).toBe(count);
        expect(outcome(await run(service, r, reviewed.workbenchToken))).toEqual(SUCCEEDED);
        // The double runner records every frame and call. Production keeps no such record.
        for (const value of Object.values(service.runner)) if (Array.isArray(value)) value.length = 0;
        for (let i = 0; i < 3; i++) Bun.gc(true);
        arrays.push(heapStats().objectTypeCounts.Array ?? 0);
      }
      expect(arrays[2]! - arrays[1]!).toBeLessThan(count / 2);
    }),
    LONG_TIMEOUT_MS,
  );
});

describe("revert all unstaged changes: Cancel and the per-file outcomes (plan.md D10, spec FR-030, FR-039)", () => {
  caseTest(TASK, "Cancel during the second write stops the action before the next file within 1 s, names each file outcome, and leaves no Git temporary file", SHELL, () =>
    withService({ name: "t034-cancel" }, async (service) => {
      const paths = ["sub/c.txt", "a.txt", "b.txt"];
      const repo = build("cancel", { "a.txt": "a\n", "b.txt": "b\n", "sub/c.txt": "c\n" }, (r) => {
        for (const path of paths) write(r, path, `${path} changed\n`);
      });
      const committed = Object.fromEntries(paths.map((path) => [path, sha256(`${path.slice(path.lastIndexOf("/") + 1, -4)}\n`)]));
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read);
      const before = state(repo);
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let writes = 0;
      service.runner.inject.holdWalk = (kind) => (kind === "fileReplace" && ++writes === 2 ? gate : Promise.resolve());
      try {
        const requestId = sendRun(service, r, reviewed.workbenchToken);
        await until(() => frames(service, "fileReplace").length === 2, "the held second fileReplace frame");
        const canceledAt = performance.now();
        await service.cancel(await service.operationId(requestId));
        const done = await service.response<RevertRun>(requestId);
        expect(RunWorkbenchResult.safeParse(done.result).success).toBe(true);
        expect(service.responseAt.get(requestId)! - canceledAt).toBeLessThan(CANCEL_MS);
        // Plan.md D10: the first file reverted, the held write stopped before it wrote, and the third file got no request.
        expect({ state: done.state, code: done.code, files: done.result?.files }).toEqual({
          state: "failed-with-effects",
          code: "FAILED_WITH_EFFECTS",
          files: [
            { entryId: unstagedIds(read, paths)[0], outcome: "reverted" },
            { entryId: unstagedIds(read, paths)[1], outcome: "not-changed" },
            { entryId: unstagedIds(read, paths)[2], outcome: "not-started" },
          ],
        });
        expect(frames(service, "fileReplace").length).toBe(2);
        const after = state(repo);
        expect({ c: after.files["sub/c.txt"], a: after.files["a.txt"], b: after.files["b.txt"] }).toEqual({ c: committed["sub/c.txt"], a: before.files["a.txt"], b: before.files["b.txt"] });
        expect({ index: after.index, raw: after.raw }).toEqual({ index: before.index, raw: before.raw });
        // Plan.md D5a step 6: every unused Git temporary file goes through tempRemove.
        expect({ temps: gitTemps(repo), removes: frames(service, "tempRemove").length }).toEqual({ temps: [], removes: 2 });
      } finally {
        release();
        service.runner.inject.holdWalk = null;
      }
    }),
    TIMEOUT_MS,
  );
});
