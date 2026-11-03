// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T029: the `revert-files` review and run of `src/git-service/revert.ts` (plan.md D5, D5a, D7, D10; data-model §3, §5, §7, §8; spec FR-005, FR-021, FR-022, FR-025, FR-041).
// Oracle (plan.md D13): Git's own `restore --staged --worktree --source=HEAD` on a copy of the fixture. Tests compare index bytes through `ls-files --stage -z` and working bytes by SHA-256.
// The defect cases at the end: every review answers (a staged-lines review once got no response), and the missing-object refusal fits the review result schema.

import { describe, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Response, RunWorkbenchResult } from "../../src/contracts/envelope";
import { MULTI_FILE_ACTION_FILES, PIPE_FRAME_BYTES } from "../../src/contracts/limits";
import { RunnerRefusal } from "../../src/git-service/git-runner";
import { PROFILE_TEXTS } from "../../src/git-service/hunk-publish";
import { LOCKED_REMEDY } from "../../src/git-service/index-lock";
import { OBJECT_MISSING_REMEDY } from "../../src/git-service/status";
import type { RevertCheckpoint } from "../../src/git-service/workbench-review";
import { printOrigin } from "../origin";
import { faGit, write } from "./file-actions-fixtures";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { compare, copyRepo, gitPath, gitPathOf, outcome, readOk, SUCCEEDED, TIMEOUT_MS, withService } from "./hunk-harness";
import { caseTest, type Capability, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

for (const module of ["revert", "workbench-review", "multi-publish", "hunk-publish", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T029";
const SHELL: Capability[] = ["shell-double"];
const LONG_TIMEOUT_MS = 600_000;
const MIB = 1024 * 1024;

type FileOutcome = { entryId: string; outcome: string; code?: string; reason?: string };
type RevertRun = { action: string; files: FileOutcome[]; foldersCreated: string[]; index: string; reason?: string };
type Reviewed = { action: string; plan: { count: number; paths: string[]; newFiles: number; staged: number; unstaged: number }; workbenchToken: string };
type Category = "unstaged" | "staged" | "untracked";

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

// `files` is the committed content, or null for an unborn branch. `after` runs after the commit.
function build(name: string, files: Record<string, string | Uint8Array> | null, after?: (repo: string) => void): string {
  const repo = join(fixtureDir(`t029-${name}-${++builds}`), "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, ["init", "-q", "-b", "main"]);
  for (const [key, value] of LINE_ENDINGS) g(repo, ["config", key, value]);
  if (files !== null) {
    for (const [path, content] of Object.entries(files)) write(repo, path, content);
    g(repo, ["add", "-A"]);
    g(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
  }
  after?.(repo);
  return repo;
}

const indexOf = (repo: string) => g(repo, ["ls-files", "--stage", "-z"]).toString("latin1");
const rawIndex = (repo: string) => sha256(readFileSync(gitPathOf(repo, "index")));
const state = (repo: string) => ({ index: indexOf(repo), raw: rawIndex(repo), files: workingFileDigests(repo) });
const gitTemps = (repo: string) => readdirSync(repo).filter((name) => name.startsWith(".merge_file_"));
const add = (repo: string, ...paths: string[]) => g(repo, ["--literal-pathspecs", "add", "--", ...paths]);

// Git's own `restore --staged --worktree --source=HEAD` on a copy (plan.md D13).
function restored(repo: string, paths: readonly string[]): { index: string; files: Record<string, string> } {
  const copy = copyRepo(repo, `t029-oracle-${++builds}`);
  g(copy, ["--literal-pathspecs", "restore", "--staged", "--worktree", "--source=HEAD", "--", ...paths]);
  return { index: indexOf(copy), files: workingFileDigests(copy) };
}

const idOf = (read: WorkspaceResult, path: string, category: Category) => {
  const entry = read.entries.find((e) => e.path === path && e.category === category);
  if (entry === undefined) throw new Error(`no ${category} entry for ${path}`);
  return entry.entryId;
};

async function open(service: Service, repo: string): Promise<{ r: RegistrationResult; read: WorkspaceResult }> {
  const r = await service.register(repo);
  return { r, read: await readOk(service, r.repositoryId) };
}

const review = (service: Service, r: RegistrationResult, read: WorkspaceResult, entryIds: string[]) =>
  service.request<Reviewed>("reviewWorkbench", { snapshotId: read.snapshotId, action: "revert-files", entryIds }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });

async function reviewOk(service: Service, r: RegistrationResult, read: WorkspaceResult, entryIds: string[]): Promise<Reviewed> {
  const response = await review(service, r, read, entryIds);
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

// Two unstaged changes and no index part.
const TWO = { "a.txt": "a\n", "sub/c.txt": "c\n", "keep.txt": "keep\n" };
const changeTwo = (repo: string) => {
  write(repo, "a.txt", "a changed\n");
  write(repo, "sub/c.txt", "c changed\n");
};

describe("revert files: Git's restore bytes, the index part, and the plan (plan.md D5, D7, D13)", () => {
  caseTest(TASK, "modified, staged, partly staged, staged and unstaged deletions, binary, CRLF, working-tree-encoding, and ident files equal git restore --staged --worktree --source=HEAD", SHELL, () =>
    withService({ name: "t029-oracle" }, async (service) => {
      const binary = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
      const repo = build(
        "oracle",
        {
          ".gitattributes": "crlf.txt text eol=crlf\nwte.txt text working-tree-encoding=UTF-16LE\nident.txt ident\n",
          "mod.txt": "m1\n",
          "staged.txt": "s1\n",
          "part.txt": "p1\n",
          "sdel.txt": "d1\n",
          "deep/er/udel.txt": "u1\n",
          "bin.dat": binary,
          "crlf.txt": "a\r\nb\r\n",
          "wte.txt": Buffer.from("w1\nw2\n", "utf16le"),
          "ident.txt": "a\n$Id$\n",
          "keep.txt": "keep\n",
        },
        (r) => {
          write(r, "mod.txt", "m2\n");
          write(r, "staged.txt", "s2\n");
          add(r, "staged.txt");
          write(r, "part.txt", "p2\n");
          add(r, "part.txt");
          write(r, "part.txt", "p3\n");
          g(r, ["--literal-pathspecs", "rm", "-q", "--", "sdel.txt"]);
          rmSync(join(r, "deep"), { recursive: true });
          write(r, "bin.dat", binary.map((b) => b ^ 0x5a));
          write(r, "crlf.txt", "a\r\nB\r\n");
          write(r, "wte.txt", Buffer.from("w1\nW2\n", "utf16le"));
          write(r, "ident.txt", "b\n$Id$\n");
        },
      );
      const paths = ["mod.txt", "staged.txt", "part.txt", "sdel.txt", "deep/er/udel.txt", "bin.dat", "crlf.txt", "wte.txt", "ident.txt"];
      const oracle = restored(repo, paths);
      const { r, read } = await open(service, repo);
      // Both rows of the partly staged file name one file, so the first picked row stands for it.
      const picked: [string, Category][] = [
        ["mod.txt", "unstaged"],
        ["part.txt", "unstaged"],
        ["part.txt", "staged"],
        ["staged.txt", "staged"],
        ["sdel.txt", "staged"],
        ["deep/er/udel.txt", "unstaged"],
        ["bin.dat", "unstaged"],
        ["crlf.txt", "unstaged"],
        ["wte.txt", "unstaged"],
        ["ident.txt", "unstaged"],
      ];
      const reviewed = await reviewOk(service, r, read, picked.map(([path, category]) => idOf(read, path, category)));
      // Data-model §5: `staged` counts the index changes, and `unstaged` the worktree letters. The 005 tree order puts a folder first.
      expect({ ...reviewed.plan, paths: [...reviewed.plan.paths].sort() }).toEqual({ count: 9, paths: paths.map(b64).sort(), newFiles: 0, staged: 3, unstaged: 7 });
      expect(reviewed.plan.paths[0]).toBe(b64("deep/er/udel.txt"));
      const done = await run(service, r, reviewed.workbenchToken);
      const ids = picked.filter(([path, category]) => !(path === "part.txt" && category === "staged")).map(([path, category]) => idOf(read, path, category));
      expect({ ...outcome(done), index: done.result?.index, outcomes: done.result?.files.map((f) => f.outcome), ids: done.result?.files.map((f) => f.entryId).sort() }).toEqual({
        ...SUCCEEDED,
        index: "published",
        outcomes: Array(9).fill("reverted"),
        ids: ids.sort(),
      });
      expect({ index: indexOf(repo), files: workingFileDigests(repo) }).toEqual(oracle);
      expect(gitTemps(repo)).toEqual([]);
      // Spec FR-022: one `update-index --index-info` covers every index change, so the index changes for all files or none.
      const updates = service.runner.calls.filter((c) => c.arguments.includes("update-index"));
      expect(updates.length).toBe(1);
      expect(["staged.txt", "part.txt", "sdel.txt"].map((p) => Buffer.from(updates[0]!.input!).toString("latin1").includes(`\t${p}\0`))).toEqual([true, true, true]);
      // Data-model §8: `revert-index` comes before `revert-files`.
      const phases = (service.progress as { phase?: string }[]).map((p) => p.phase);
      expect(phases.indexOf("revert-index")).toBeGreaterThanOrEqual(0);
      expect(phases.indexOf("revert-index")).toBeLessThan(phases.indexOf("revert-files"));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a staged new file loses its index entry and keeps its working file (G7, spec FR-021)", SHELL, () =>
    withService({ name: "t029-new" }, async (service) => {
      const repo = build("new", { "base.txt": "base\n" }, (r) => {
        write(r, "new.txt", "n\n");
        write(r, "newmod.txt", "x\n");
        write(r, "gone.txt", "g\n");
        add(r, "new.txt", "newmod.txt", "gone.txt");
        write(r, "newmod.txt", "y\n");
        rmSync(join(r, "gone.txt"));
      });
      const before = state(repo);
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read, ["new.txt", "newmod.txt", "gone.txt"].map((p) => idOf(read, p, "staged")));
      expect({ ...reviewed.plan, paths: undefined }).toEqual({ count: 3, paths: undefined, newFiles: 3, staged: 3, unstaged: 2 });
      const done = await run(service, r, reviewed.workbenchToken);
      expect({ ...outcome(done), index: done.result?.index, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, index: "published", outcomes: ["reverted", "reverted", "reverted"] });
      expect(indexOf(repo)).toBe(g(repo, ["ls-files", "--stage", "-z", "--", "base.txt"]).toString("latin1"));
      expect(indexOf(repo).includes("new.txt")).toBe(false);
      expect(workingFileDigests(repo)).toEqual(before.files);
      // No Git temporary file and no working write: the working files stay as they are.
      expect({ checkout: service.runner.calls.filter((c) => c.arguments.includes("checkout-index")).length, writes: frames(service, "fileReplace").length }).toEqual({ checkout: 0, writes: 0 });
      expect((await readOk(service, r.repositoryId)).entries.filter((e) => e.category === "untracked").map((e) => e.path).sort()).toEqual(["new.txt", "newmod.txt"]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "on an unborn branch every file loses its index entry and keeps its working file (spec FR-021)", SHELL, () =>
    withService({ name: "t029-unborn" }, async (service) => {
      const repo = build("unborn", null, (r) => {
        write(r, "a.txt", "a\n");
        write(r, "sub/b.txt", "b\n");
        write(r, "m.txt", "m\n");
        add(r, "a.txt", "sub/b.txt", "m.txt");
        write(r, "m.txt", "m changed\n");
      });
      const before = state(repo);
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read, [idOf(read, "a.txt", "staged"), idOf(read, "sub/b.txt", "staged"), idOf(read, "m.txt", "unstaged")]);
      expect({ ...reviewed.plan, paths: undefined }).toEqual({ count: 3, paths: undefined, newFiles: 3, staged: 3, unstaged: 1 });
      const done = await run(service, r, reviewed.workbenchToken);
      expect({ ...outcome(done), outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, outcomes: ["reverted", "reverted", "reverted"] });
      expect(indexOf(repo)).toBe("");
      expect(workingFileDigests(repo)).toEqual(before.files);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a 40 MiB binary file reverts above the 16 MiB frame, and no request carries its bytes (spec FR-025)", SHELL, () =>
    withService({ name: "t029-big" }, async (service) => {
      const size = 40 * MIB;
      expect(size).toBeGreaterThan(PIPE_FRAME_BYTES);
      const committed = randomBytes(size);
      const changed = Buffer.from(committed);
      changed[0] = changed[0]! ^ 0xff;
      changed[size - 1] = changed[size - 1]! ^ 0xff;
      const repo = build("big", { "big.bin": committed, "keep.txt": "keep\n" }, (r) => write(r, "big.bin", changed));
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read, [idOf(read, "big.bin", "unstaged")]);
      expect(outcome(await run(service, r, reviewed.workbenchToken))).toEqual(SUCCEEDED);
      expect(sha256(readFileSync(join(repo, "big.bin")))).toBe(sha256(committed));
      expect(gitTemps(repo)).toEqual([]);
      // Git writes the file, and the shell copies it. No frame, no process input, and no response holds the content.
      const largest = (sizes: number[]) => Math.max(0, ...sizes);
      expect({
        frames: largest(service.runner.frames.map((f) => Buffer.byteLength(JSON.stringify(f)))) < MIB,
        inputs: largest(service.runner.calls.map((c) => c.input?.length ?? 0)) < MIB,
        responses: largest(service.responses.map((x) => Buffer.byteLength(JSON.stringify(x)))) < MIB,
        bytes: frames(service, "fileReplace").some((f) => "bytes" in f),
      }).toEqual({ frames: true, inputs: true, responses: true, bytes: false });
    }),
    LONG_TIMEOUT_MS,
  );
});

describe("revert files: refusals (data-model §7, spec FR-022)", () => {
  caseTest(TASK, "an untracked record at the path gives in-the-way, and an untracked entry gives untracked; nothing changes", SHELL, () =>
    withService({ name: "t029-refusals" }, async (service) => {
      const repo = build("refusals", { "f.txt": "f\n", "keep.txt": "keep\n" }, (r) => {
        g(r, ["--literal-pathspecs", "rm", "-q", "--cached", "--", "f.txt"]);
        write(r, "u.txt", "u\n");
      });
      const before = state(repo);
      const { r, read } = await open(service, repo);
      expect(refusal(await review(service, r, read, [idOf(read, "u.txt", "untracked"), idOf(read, "f.txt", "staged")]))).toEqual({
        state: "failed",
        code: "WORKBENCH_UNAVAILABLE",
        result: {
          reason: "in-the-way",
          files: [
            { path: b64("f.txt"), reason: "in-the-way" },
            { path: b64("u.txt"), reason: "untracked" },
          ],
          more: 0,
        },
      });
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  // Review of batch 2: status runs without `--ignored`, so an ignored file at a staged deletion has no untracked record. The OS fact decides (spec FR-020).
  caseTest(TASK, "an ignored file at a staged-deletion path gives in-the-way and keeps its bytes", SHELL, () =>
    withService({ name: "t029-ignored" }, async (service) => {
      const repo = build("ignored", { ".gitignore": ".env\n", "keep.txt": "keep\n" }, (r) => {
        write(r, ".env", "secret=1\n");
        g(r, ["--literal-pathspecs", "add", "-f", "--", ".env"]);
        g(r, ["commit", "-q", "--no-verify", "-m", "env"]);
        g(r, ["--literal-pathspecs", "rm", "-q", "--cached", "--", ".env"]);
        write(r, ".env", "secret=2\n");
      });
      const before = state(repo);
      const { r, read } = await open(service, repo);
      expect(read.entries.filter((e) => e.path === ".env").map((e) => e.category)).toEqual(["staged"]);
      expect(refusal(await review(service, r, read, [idOf(read, ".env", "staged")]))).toEqual({
        state: "failed",
        code: "WORKBENCH_UNAVAILABLE",
        result: { reason: "in-the-way", files: [{ path: b64(".env"), reason: "in-the-way" }], more: 0 },
      });
      expect(state(repo)).toEqual(before);
      expect(readFileSync(join(repo, ".env"), "utf8")).toBe("secret=2\n");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a file that appears at a staged-deletion path after the status read refuses the run and the review", SHELL, () =>
    withService({ name: "t029-appears" }, async (service) => {
      const repo = build("appears", { "g.txt": "g\n", "keep.txt": "keep\n" }, (r) => g(r, ["--literal-pathspecs", "rm", "-q", "--", "g.txt"]));
      const { r, read } = await open(service, repo);
      const ids = [idOf(read, "g.txt", "staged")];
      // The review binds the absent target. The file appears before the run, so the bound changed (data-model §2).
      const reviewed = await reviewOk(service, r, read, ids);
      write(repo, "g.txt", "new\n");
      const before = state(repo);
      expect(refusal(await run(service, r, reviewed.workbenchToken))).toEqual({ state: "failed", code: "STALE_REVIEW", result: { action: "revert-files", reason: "revert-changed" } });
      expect(refusal(await review(service, r, read, ids))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "in-the-way", files: [{ path: b64("g.txt"), reason: "in-the-way" }], more: 0 } });
      expect(state(repo)).toEqual(before);
      expect(readFileSync(join(repo, "g.txt"), "utf8")).toBe("new\n");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `the payload bound is ${MULTI_FILE_ACTION_FILES} files: one more gives INVALID_REQUEST before any read (spec FR-022 limit)`, SHELL, () =>
    withService({ name: "t029-limit" }, async (service) => {
      const repo = build("limit", TWO, changeTwo);
      const { r, read } = await open(service, repo);
      const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
      const calls = service.runner.calls.length;
      // Contract Δ3: 1 to 10,000 IDs. Above it, the request is no valid payload, so no read starts.
      expect(outcome(await review(service, r, read, ids(MULTI_FILE_ACTION_FILES + 1)))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      expect(service.runner.calls.length).toBe(calls);
      // At the bound, the review reads and refuses the IDs of no entry of the snapshot.
      expect(outcome(await review(service, r, read, ids(MULTI_FILE_ACTION_FILES)))).toEqual({ state: "failed", code: "INVALID_REQUEST" });
    }),
    TIMEOUT_MS,
  );
});

describe("revert files: the run steps and the seams (plan.md D5a, D7, D10, data-model §8)", () => {
  caseTest(TASK, "an index change between D5a steps 1 and 3 gives STALE_REVIEW, and the run removes the Git temporary files", SHELL, async () => {
    let repo = "";
    await withService(
      {
        name: "t029-step3",
        revertCheckpoint: (c: RevertCheckpoint) => {
          if (c.step === "checkout-index") add(repo, "new.txt");
        },
      },
      async (service) => {
        repo = build("step3", TWO, (r) => {
          changeTwo(r);
          write(r, "new.txt", "n\n");
        });
        const { r, read } = await open(service, repo);
        const reviewed = await reviewOk(service, r, read, [idOf(read, "a.txt", "unstaged"), idOf(read, "sub/c.txt", "unstaged")]);
        const before = workingFileDigests(repo);
        const done = await run(service, r, reviewed.workbenchToken);
        // T059: the multi-file STALE_REVIEW result names revert-changed (contract Δ9), so the renderer shows the plan.md D11 multi-file stale text.
        expect({ state: done.state, code: done.code, index: done.result?.index, reason: done.result?.reason, outcomes: done.result?.files.map((f) => [f.outcome, f.code]) }).toEqual({
          state: "failed",
          code: "STALE_REVIEW",
          index: "none",
          reason: "revert-changed",
          outcomes: [
            ["not-changed", "stale"],
            ["not-changed", "stale"],
          ],
        });
        expect({ temps: gitTemps(repo), removes: frames(service, "tempRemove").length, writes: frames(service, "fileReplace").length }).toEqual({ temps: [], removes: 2, writes: 0 });
        expect(workingFileDigests(repo)).toEqual(before);
      },
    );
  }, TIMEOUT_MS);

  caseTest(TASK, "a malformed checkout-index record gives MALFORMED_GIT_OUTPUT and removes the named Git temporary file", SHELL, () =>
    withService({ name: "t029-malformed" }, async (service) => {
      const repo = build("malformed", TWO, changeTwo);
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read, [idOf(read, "a.txt", "unstaged"), idOf(read, "sub/c.txt", "unstaged")]);
      const before = state(repo);
      // One complete record names a file that Git wrote. The second record has no TAB.
      const name = ".merge_file_t029aa";
      writeFileSync(join(repo, name), "a\n");
      service.runner.inject.stdout = (call) => (call.arguments.includes("checkout-index") ? Buffer.from(`${name}\tsub/c.txt\0broken\0`, "latin1") : undefined);
      try {
        expect(outcome(await run(service, r, reviewed.workbenchToken))).toEqual({ state: "failed", code: "MALFORMED_GIT_OUTPUT" });
      } finally {
        service.runner.inject.stdout = undefined;
      }
      expect(frames(service, "tempRemove").map((f) => f.name)).toEqual([name]);
      expect(gitTemps(repo)).toEqual([]);
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  // Review of batch 2: a Git temporary file that stays is an effect, so the run never ends succeeded (plan.md D10, spec FR-036).
  for (const reply of [{ result: "error", code: "access-denied" }, { result: "stale" }, { result: "stopped" }] as const) {
    caseTest(TASK, `a kept source whose tempRemove gives ${reply.result} ends failed-with-effects`, SHELL, () =>
      withService({ name: `t029-kept-${reply.result}` }, async (service) => {
        const repo = build(`kept-${reply.result}`, TWO, changeTwo);
        const { r, read } = await open(service, repo);
        const reviewed = await reviewOk(service, r, read, [idOf(read, "a.txt", "unstaged"), idOf(read, "sub/c.txt", "unstaged")]);
        service.runner.inject.replaceStep = (step, path) => (step === "renamed" && path.endsWith("a.txt") ? "keep-source" : undefined);
        service.runner.inject.tempRemoveReply = () => reply;
        try {
          const done = await run(service, r, reviewed.workbenchToken);
          expect({ state: done.state, code: done.code, outcomes: done.result?.files.map((f) => f.outcome), removes: frames(service, "tempRemove").length }).toEqual({
            state: "failed-with-effects",
            code: "FAILED_WITH_EFFECTS",
            outcomes: ["reverted", "reverted"],
            removes: 1,
          });
        } finally {
          service.runner.inject.replaceStep = null;
          service.runner.inject.tempRemoveReply = null;
        }
        expect(gitTemps(repo).length).toBe(1);
        for (const name of gitTemps(repo)) rmSync(join(repo, name));
      }),
      TIMEOUT_MS,
    );
  }

  // Review of batch 2: a refused index part ends with the value of its refusal. Both values fit the response and the result schema.
  caseTest(TASK, "a stale index part gives STALE_REVIEW with revert-changed, and both index-part refusal values fit the response schema", SHELL, async () => {
    let repo = "";
    let act: "stale" | "lock" = "stale";
    await withService(
      {
        name: "t029-shapes",
        revertCheckpoint: (c: RevertCheckpoint) => {
          if (c.step !== "before-index") return;
          if (act === "stale") add(repo, "other.txt");
          else writeFileSync(`${gitPathOf(repo, "index")}.lock`, "");
        },
      },
      async (service) => {
        repo = build("shapes", { "a.txt": "a\n", "keep.txt": "keep\n" }, (r) => {
          write(r, "a.txt", "a2\n");
          add(r, "a.txt");
          write(r, "other.txt", "o\n");
        });
        const { r, read } = await open(service, repo);
        const ids = [idOf(read, "a.txt", "staged")];
        const stale = await run(service, r, (await reviewOk(service, r, read, ids)).workbenchToken);
        expect(refusal(stale)).toEqual({ state: "failed", code: "STALE_REVIEW", result: { action: "revert-files", reason: "revert-changed" } });
        g(repo, ["--literal-pathspecs", "rm", "-q", "--cached", "--", "other.txt"]);
        act = "lock";
        const fresh = await readOk(service, r.repositoryId);
        const locked = await run(service, r, (await reviewOk(service, r, fresh, [idOf(fresh, "a.txt", "staged")])).workbenchToken);
        rmSync(`${gitPathOf(repo, "index")}.lock`);
        expect(refusal(locked)).toEqual({ state: "failed", code: "LOCKED", result: { path: expect.stringMatching(/index\.lock$/), remedy: { text: LOCKED_REMEDY } } });
        for (const response of [stale, locked]) expect({ response: Response.safeParse(response).success, result: RunWorkbenchResult.safeParse(response.result).success }).toEqual({ response: true, result: true });
        expect(frames(service, "fileReplace").length).toBe(0);
      },
    );
  }, TIMEOUT_MS);

  // T059 (contract "Contract gaps"): the file result names the eligibility reason of a refused index part.
  caseTest("T059", "an index part that a split index refuses names split-index and its remedy in the file result, and no file changes", SHELL, async () => {
    let repo = "";
    await withService(
      {
        name: "t059-split",
        revertCheckpoint: (c: RevertCheckpoint) => {
          if (c.step === "before-index") g(repo, ["update-index", "--split-index"]);
        },
      },
      async (service) => {
        repo = build("split", { "a.txt": "a\n", "keep.txt": "keep\n" }, (r) => {
          write(r, "a.txt", "a2\n");
          add(r, "a.txt");
        });
        const { r, read } = await open(service, repo);
        const id = idOf(read, "a.txt", "staged");
        const reviewed = await reviewOk(service, r, read, [id]);
        const files = workingFileDigests(repo);
        const done = await run(service, r, reviewed.workbenchToken);
        expect(refusal(done)).toEqual({
          state: "failed",
          code: "UNSUPPORTED_HUNK_PROFILE",
          result: { action: "revert-files", files: [{ entryId: id, outcome: "not-started" }], foldersCreated: [], index: "refused", reason: "split-index", remedy: { text: PROFILE_TEXTS["split-index"] } },
        });
        expect({ files: workingFileDigests(repo), writes: frames(service, "fileReplace").length }).toEqual({ files, writes: 0 });
      },
    );
  }, TIMEOUT_MS);

  // T062 (plan.md D10): a refused `tempRemove` frame leaves Git's temporary file, which is an effect, so the run never ends succeeded.
  caseTest("T062", "a RunnerRefusal of tempRemove ends failed-with-effects and keeps Git's temporary file", SHELL, () =>
    withService({ name: "t062-temp-refusal" }, async (service) => {
      const repo = build("temp-refusal", TWO, changeTwo);
      const { r, read } = await open(service, repo);
      const reviewed = await reviewOk(service, r, read, [idOf(read, "a.txt", "unstaged"), idOf(read, "sub/c.txt", "unstaged")]);
      service.runner.inject.replaceStep = (step, path) => (step === "renamed" && path.endsWith("a.txt") ? "keep-source" : undefined);
      service.runner.inject.tempRemoveReply = () => {
        throw new RunnerRefusal("INVALID_REQUEST", "test seam");
      };
      try {
        const done = await run(service, r, reviewed.workbenchToken);
        expect({ state: done.state, code: done.code, outcomes: done.result?.files.map((f) => f.outcome), removes: frames(service, "tempRemove").length }).toEqual({
          state: "failed-with-effects",
          code: "FAILED_WITH_EFFECTS",
          outcomes: ["reverted", "reverted"],
          removes: 1,
        });
      } finally {
        service.runner.inject.replaceStep = null;
        service.runner.inject.tempRemoveReply = null;
      }
      expect({ a: readFileSync(join(repo, "a.txt"), "utf8"), temps: gitTemps(repo).map((name) => readFileSync(join(repo, name), "utf8")) }).toEqual({ a: "a\n", temps: ["a\n"] });
      for (const name of gitTemps(repo)) rmSync(join(repo, name));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a stop after checkout-index removes every unused Git temporary file through tempRemove", SHELL, async () => {
    let target: Service | null = null;
    await withService(
      {
        name: "t029-stop",
        revertCheckpoint: async (c: RevertCheckpoint) => {
          if (c.step === "checkout-index") await target!.cancel(c.operationId);
        },
      },
      async (service) => {
        target = service;
        const repo = build("stop", TWO, changeTwo);
        const { r, read } = await open(service, repo);
        const reviewed = await reviewOk(service, r, read, [idOf(read, "a.txt", "unstaged"), idOf(read, "sub/c.txt", "unstaged")]);
        const before = state(repo);
        const done = await run(service, r, reviewed.workbenchToken);
        expect({ state: done.state, code: done.code, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ state: "canceled", code: "CANCELED", outcomes: ["not-started", "not-started"] });
        expect({ temps: gitTemps(repo), removes: frames(service, "tempRemove").length, writes: frames(service, "fileReplace").length }).toEqual({ temps: [], removes: 2, writes: 0 });
        expect(state(repo)).toEqual(before);
      },
    );
  }, TIMEOUT_MS);

  caseTest(TASK, "the index part changes all files or none: a failed update-index and a lock before publication change nothing", SHELL, async () => {
    let repo = "";
    let lockAtIndex = false;
    await withService(
      {
        name: "t029-none",
        revertCheckpoint: (c: RevertCheckpoint) => {
          if (c.step === "before-index" && lockAtIndex) writeFileSync(`${gitPathOf(repo, "index")}.lock`, "");
        },
      },
      async (service) => {
        repo = build("none", { "a.txt": "a\n", "b.txt": "b\n", "keep.txt": "keep\n" }, (r) => {
          write(r, "a.txt", "a2\n");
          write(r, "b.txt", "b2\n");
          add(r, "a.txt", "b.txt");
        });
        const { r, read } = await open(service, repo);
        const ids = [idOf(read, "a.txt", "staged"), idOf(read, "b.txt", "staged")];
        const before = state(repo);
        const gitFiles = readdirSync(join(repo, ".git"));
        service.runner.inject.exit = (call) => (call.arguments.includes("update-index") ? 1 : undefined);
        try {
          const done = await run(service, r, (await reviewOk(service, r, read, ids)).workbenchToken);
          expect({ state: done.state, code: done.code, index: done.result?.index, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ state: "failed", code: "GIT_FAILED", index: "refused", outcomes: ["not-started", "not-started"] });
        } finally {
          service.runner.inject.exit = undefined;
        }
        expect({ state: state(repo), gitFiles: readdirSync(join(repo, ".git")) }).toEqual({ state: before, gitFiles });
        // Plan.md D7: a lock refusal gives the 001 lock guidance, and no working file changes.
        lockAtIndex = true;
        const locked = await run(service, r, (await reviewOk(service, r, read, ids)).workbenchToken);
        lockAtIndex = false;
        rmSync(`${gitPathOf(repo, "index")}.lock`);
        expect(refusal(locked)).toEqual({ state: "failed", code: "LOCKED", result: { path: expect.stringMatching(/index\.lock$/), remedy: { text: LOCKED_REMEDY } } });
        expect({ state: state(repo), writes: frames(service, "fileReplace").length }).toEqual({ state: before, writes: 0 });
      },
    );
  }, TIMEOUT_MS);

  caseTest(TASK, "a file that changes between the index part and its write gives unstaged-only (the before-write seam)", SHELL, async () => {
    let repo = "";
    const seen: string[] = [];
    await withService(
      {
        name: "t029-unstaged-only",
        revertCheckpoint: (c: RevertCheckpoint) => {
          seen.push(c.step);
          // A second hard link keeps the bytes and changes the bound link count (plan.md D8 `facts`).
          if (c.step === "before-write") linkSync(join(repo, "f.txt"), join(fixtureDir(`t029-link-${builds}`), "f-link.txt"));
        },
      },
      async (service) => {
        repo = build("unstaged-only", { "f.txt": "f1\n" }, (r) => {
          write(r, "f.txt", "f2\n");
          add(r, "f.txt");
        });
        const { r, read } = await open(service, repo);
        const reviewed = await reviewOk(service, r, read, [idOf(read, "f.txt", "staged")]);
        const head = g(repo, ["ls-tree", "-z", "HEAD", "--", "f.txt"]).toString("latin1");
        const done = await run(service, r, reviewed.workbenchToken);
        // Spec FR-017: the outcome names why the write did not change the file, with the reply code of not-changed.
        expect({ state: done.state, code: done.code, index: done.result?.index, files: done.result?.files }).toEqual({
          state: "failed-with-effects",
          code: "FAILED_WITH_EFFECTS",
          index: "published",
          files: [{ entryId: idOf(read, "f.txt", "staged"), outcome: "unstaged-only", code: "refused", reason: "hard-link" }],
        });
        expect(seen).toEqual(["before-index", "checkout-index", "before-write"]);
        // The index holds the HEAD entry, and the working file keeps its bytes. Status then shows the change as unstaged.
        expect(indexOf(repo).split("\t")[0]!.split(" ")[1]).toBe(head.split(" ")[2]!.split("\t")[0]);
        expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("f2\n");
        expect(gitTemps(repo)).toEqual([]);
      },
    );
  }, TIMEOUT_MS);

  for (const code of ["sharing-violation", "access-denied", "disk-full", "read-only-volume"] as const) {
    caseTest(TASK, `a ${code} reply gives failed with that code and the old bytes (spec FR-041)`, SHELL, () =>
      withService({ name: `t029-${code}` }, async (service) => {
        const repo = build(code, TWO, changeTwo);
        const { r, read } = await open(service, repo);
        const reviewed = await reviewOk(service, r, read, [idOf(read, "a.txt", "unstaged")]);
        const before = state(repo);
        service.runner.inject.workingReply = () => ({ result: "error", code });
        try {
          const done = await run(service, r, reviewed.workbenchToken);
          // Data-model §8: `error` with the reply code as `reason` selects the FR-041 text.
          expect({ state: done.state, code: done.code, files: done.result?.files }).toEqual({ state: "failed", code: "GIT_FAILED", files: [{ entryId: idOf(read, "a.txt", "unstaged"), outcome: "not-changed", code: "error", reason: code }] });
        } finally {
          service.runner.inject.workingReply = null;
        }
        expect(state(repo)).toEqual(before);
        expect(gitTemps(repo)).toEqual([]);
      }),
      TIMEOUT_MS,
    );
  }
});

describe("revert reviews always answer, and their refusal values fit the result schema (defects of batch 2)", () => {
  // T039 (plan.md D4): the staged-lines review answers with its plan.
  caseTest(TASK, "a staged-lines review answers with the staged plan", SHELL, () =>
    withService({ name: "t029-staged-lines" }, async (service) => {
      const repo = build("staged-lines", { "f.txt": "a\nb\nc\n" }, (r) => {
        write(r, "f.txt", "a\nB\nc\n");
        add(r, "f.txt");
      });
      const { r, read } = await open(service, repo);
      const c = await compare(service, r.repositoryId, "f.txt", "staged", read);
      const response = await service.request<{ plan: unknown }>("reviewWorkbench", { snapshotId: read.snapshotId, action: "revert-lines", comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
      expect({ ...outcome(response), plan: response.result?.plan }).toEqual({ ...SUCCEEDED, plan: { scope: "staged", fileBytes: b64("f.txt"), lines: null } });
    }),
    TIMEOUT_MS,
  );

  for (const promisor of [true, false]) {
    caseTest(TASK, `a missing HEAD blob ${promisor ? "with a promisor remote gives OBJECT_MISSING with the file path and the 001 remedy" : "without a promisor remote gives GIT_FAILED"} (spec FR-005)`, SHELL, () =>
      withService({ name: `t029-missing-${promisor}` }, async (service) => {
        const repo = build(`missing-${promisor}`, { "f.txt": "f1\n" }, (r) => write(r, "f.txt", "f2\n"));
        if (promisor) g(repo, ["config", "--local", "remote.origin.promisor", "true"]);
        const oid = g(repo, ["rev-parse", "HEAD:f.txt"]).toString("utf8").trim();
        const before = workingFileDigests(repo);
        const { r, read } = await open(service, repo);
        // The status read needs no blob of an unstaged change. The review asks `cat-file --batch-check` for the HEAD blob.
        rmSync(join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
        const response = await review(service, r, read, [idOf(read, "f.txt", "unstaged")]);
        expect(refusal(response)).toEqual(promisor ? { state: "failed", code: "OBJECT_MISSING", result: { path: expect.stringMatching(/f\.txt$/), remedy: { text: OBJECT_MISSING_REMEDY } } } : { state: "failed", code: "GIT_FAILED", result: undefined });
        expect(workingFileDigests(repo)).toEqual(before);
      }),
      TIMEOUT_MS,
    );
  }
});
