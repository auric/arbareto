// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T032: Delete and Delete permanently, service part (feature 005 plan.md D6, contract Δ3 `reviewWorkbench` `delete`, `runWorkbench`, Δ6 `fileDelete`,
// data-model §4 and §5, quickstart.md Q12 to Q16). The shell test double of `bun-runner.ts` serves `fileDelete` by the contract Δ6 rules.
// The double moves a Recycle Bin item into its own owned folder, so no test touches the Windows Recycle Bin. Each test purges what it moved.

import { describe, expect } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewWorkbenchResult, RunWorkbenchResult } from "../../src/contracts/envelope";
import { comparePaths } from "../../src/contracts/tree-order";
import { printOrigin } from "../origin";
import { buildConflicted, buildFiles, faGit, write, type FaFixture } from "./file-actions-fixtures";
import { useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { gitPath, outcome, readOk, SUCCEEDED, subcommand, until, withService } from "./hunk-harness";
import { caseTest, type Capability, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";
import { canary } from "./workbench-fixtures";

for (const module of ["file-delete", "workbench-review", "native-runner", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T032";
const SHELL: Capability[] = ["shell-double"];
const WINDOWS_RULES: Capability[] = ["shell-double", "windows-path-rules"];
const TIMEOUT_MS = 120_000;
const WINDOWS = process.platform === "win32";
const SLASH = "/";

let builds = 0;
const files = (): FaFixture => buildFiles(gitPath(), `t032-files-${++builds}`);
const git = (repo: string, args: string[], allowExit = [0]) => faGit(gitPath(), repo, args, { allowExit }).toString("utf8");

type Review = { action: "delete"; plan: { mode: string; entryIds: string[]; files: { count: number; paths: string[] }; tracked: number; folder: string | null; wsl: boolean }; workbenchToken: string };
type Outcome = { entryId: string; outcome: string; code?: string; recycledPath?: string };
type DeleteRun = { action: "delete"; entries: Outcome[]; folders: { pathBytes: string; outcome: string; code?: string }[] };

async function open(service: Service, f: FaFixture): Promise<{ r: RegistrationResult; read: WorkspaceResult }> {
  const r = await service.register(f.repo);
  return { r, read: await readOk(service, r.repositoryId) };
}

// Every entry of the snapshot, also the later `readEntries` pages.
async function allEntries(service: Service, r: RegistrationResult, read: WorkspaceResult): Promise<WorkspaceResult["entries"]> {
  const entries = [...read.entries];
  for (let cursor = read.cursor; cursor !== null; ) {
    const page = await service.readEntries(r.repositoryId, read.generation, read.snapshotId, cursor);
    expect(outcome(page)).toEqual(SUCCEEDED);
    entries.push(...page.result!.entries);
    cursor = page.result!.cursor;
  }
  return entries;
}

// The entry of `path` in the Changes list: unstaged, untracked, or conflicted.
function idOf(read: WorkspaceResult, path: string): string {
  const entry = read.entries.find((e) => e.path === path && e.category !== "staged");
  expect({ path, listed: entry !== undefined }).toEqual({ path, listed: true });
  return entry!.entryId;
}

function review(service: Service, r: RegistrationResult, read: WorkspaceResult, entryIds: string[], mode: "recycle" | "permanent", folder?: string): Promise<ServiceResponse<Review>> {
  return service.request<Review>("reviewWorkbench", { action: "delete", snapshotId: read.snapshotId, entryIds, mode, ...(folder === undefined ? {} : { folder: Buffer.from(folder).toString("base64") }) }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
}

async function reviewOk(service: Service, r: RegistrationResult, read: WorkspaceResult, entryIds: string[], mode: "recycle" | "permanent", folder?: string): Promise<Review> {
  const response = await review(service, r, read, entryIds, mode, folder);
  expect({ ...outcome(response), result: response.state === "succeeded" ? "plan" : response.result }).toEqual({ ...SUCCEEDED, result: "plan" });
  expect(ReviewWorkbenchResult.safeParse(response.result).success).toBe(true);
  return response.result!;
}

const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
async function run(service: Service, r: RegistrationResult, token: string): Promise<ServiceResponse<DeleteRun>> {
  const response = await service.response<DeleteRun>(sendRun(service, r, token));
  if (response.result !== undefined) expect(RunWorkbenchResult.safeParse(response.result).success).toBe(true);
  return response;
}

const refusal = (response: ServiceResponse<unknown>) => ({ state: response.state, code: response.code, result: response.result });
const unavailable = (reason: string) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason } });
const deleteFrames = (service: Service, from = 0) => service.runner.frames.slice(from).filter((f) => f.type === "fileDelete") as unknown as { mode: string; entries: { path: string; expected: unknown }[]; folders: string[] }[];
const indexSha = (repo: string) => new Bun.CryptoHasher("sha256").update(readFileSync(join(repo, ".git", "index"))).digest("hex");
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const outcomeOf = (run: DeleteRun, entryId: string) => run.entries.find((e) => e.entryId === entryId);

// Data-model §5: each recycled item names its place in the double's owned bin. The test removes it there, never in the Windows Recycle Bin.
function purge(service: Service, run: DeleteRun | undefined): void {
  for (const e of run?.entries ?? []) {
    if (e.recycledPath === undefined) continue;
    expect(e.recycledPath.startsWith(service.runner.recycleBin)).toBe(true);
    rmSync(e.recycledPath, { recursive: true, force: true });
  }
}

describe("review refusals before any token (plan.md D6, contract Δ3 and Δ9)", () => {
  caseTest(TASK, "a submodule row, a nested repository, and a fully deleted tracked file each refuse with its reason, and a staged entry gives INVALID_REQUEST", SHELL, () =>
    withService({ name: "t032-reasons" }, async (service) => {
      const f = files();
      rmSync(join(f.repo, "top.txt"));
      git(f.repo, ["add", "--", "t/b.txt"]);
      writeFileSync(join(f.repo, "t", "b.txt"), "t/b.txt staged then changed\n");
      git(f.repo, ["add", "--", "t/b.txt"]);
      const { r, read } = await open(service, f);
      expect(refusal(await review(service, r, read, [idOf(read, "mod")], "recycle"))).toEqual(unavailable("submodule"));
      expect(refusal(await review(service, r, read, [idOf(read, "nested/")], "permanent"))).toEqual(unavailable("nested-repository"));
      expect(refusal(await review(service, r, read, [idOf(read, "top.txt")], "recycle"))).toEqual(unavailable("nothing-to-delete"));
      // The snapshot decides after the common reads, as the 004 `ignore` review does, so the review ends failed.
      const staged = read.entries.find((e) => e.path === "t/b.txt" && e.category === "staged")!;
      expect(outcome(await review(service, r, read, [staged.entryId], "permanent"))).toEqual({ state: "failed", code: "INVALID_REQUEST" });
      expect(outcome(await review(service, r, read, [crypto.randomUUID()], "permanent"))).toEqual({ state: "failed", code: "INVALID_REQUEST" });
      // A fully deleted tracked file beside a file with content leaves the plan.
      const plan = await reviewOk(service, r, read, [idOf(read, "top.txt"), idOf(read, "u1.txt")], "permanent");
      expect({ entryIds: plan.plan.entryIds, count: plan.plan.files.count }).toEqual({ entryIds: [idOf(read, "u1.txt")], count: 1 });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a selection above 10,000 entries gives INVALID_REQUEST; a folder with more than 10,000 listed entries gives limit", SHELL, () =>
    withService({ name: "t032-limit" }, async (service) => {
      const f = files();
      mkdirSync(join(f.repo, "many"));
      for (let i = 0; i <= 10_000; i++) writeFileSync(join(f.repo, "many", `f${String(i).padStart(5, "0")}.txt`), "x\n");
      const { r, read } = await open(service, f);
      const entries = await allEntries(service, r, read);
      const many = entries.filter((e) => e.path.startsWith("many/")).map((e) => e.entryId);
      expect(many.length).toBe(10_001);
      expect(outcome(await review(service, r, read, many, "permanent"))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      expect(refusal(await review(service, r, read, many.slice(0, 10_000), "permanent", "many"))).toEqual(unavailable("limit"));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "names that end in a period or a space give path, and the shell never sees them (plan.md D7 N9)", WINDOWS_RULES, () =>
    withService({ name: "t032-path" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const from = service.runner.frames.length;
      for (const name of ["x.", "x "]) {
        for (const mode of ["recycle", "permanent"] as const) expect({ name, mode, ...refusal(await review(service, r, read, [idOf(read, name)], mode)) }).toEqual({ name, mode, ...unavailable("path") });
      }
      expect(deleteFrames(service, from)).toEqual([]);
      expect(readFileSync(join(f.repo, "x"), "utf8")).toBe("x\n");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "plain Delete of a path of 260 or more UTF-16 units gives long-path, and Delete permanently reviews it", WINDOWS_RULES, () =>
    withService({ name: "t032-long" }, async (service) => {
      const f = files();
      git(f.repo, ["config", "core.longpaths", "true"]);
      const deep = `${"l".repeat(120)}/${"m".repeat(120)}/long.txt`;
      write(f.repo, deep, "long\n");
      expect(join(f.repo, ...deep.split(SLASH)).length).toBeGreaterThanOrEqual(260);
      const { r, read } = await open(service, f);
      expect(refusal(await review(service, r, read, [idOf(read, deep)], "recycle"))).toEqual(unavailable("long-path"));
      const plan = await reviewOk(service, r, read, [idOf(read, deep)], "permanent");
      const done = await run(service, r, plan.workbenchToken);
      expect(outcome(done)).toEqual(SUCCEEDED);
      expect(existsSync(join(f.repo, ...deep.split(SLASH)))).toBe(false);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a file that the service cannot read gives unreadable", ["shell-double", "read-denial"], () =>
    withService({ name: "t032-unreadable" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const target = join(f.repo, "u2.txt");
      denyRead(target, true);
      try {
        expect(refusal(await review(service, r, read, [idOf(read, "u2.txt")], "permanent"))).toEqual(unavailable("unreadable"));
      } finally {
        denyRead(target, false);
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "during a merge, OPERATION_IN_PROGRESS; with unmerged entries and no marker, a conflicted row gives conflicted and another row CONFLICTED with the count", SHELL, () =>
    withService({ name: "t032-conflicts" }, async (service) => {
      const merging = buildConflicted(gitPath(), `t032-merging-${++builds}`, "merging");
      const m = await open(service, merging);
      expect(outcome(await review(service, m.r, m.read, [idOf(m.read, "free.txt")], "permanent"))).toEqual({ state: "failed", code: "OPERATION_IN_PROGRESS" });
      const quit = buildConflicted(gitPath(), `t032-unmerged-${++builds}`, "unmerged");
      const q = await open(service, quit);
      const conflicted = q.read.entries.find((e) => e.category === "conflicted")!;
      expect(refusal(await review(service, q.r, q.read, [conflicted.entryId], "permanent"))).toEqual(unavailable("conflicted"));
      const unmerged = new Set(q.read.entries.filter((e) => e.category === "conflicted").map((e) => e.path)).size;
      expect(refusal(await review(service, q.r, q.read, [idOf(q.read, "free.txt")], "permanent"))).toEqual({ state: "failed", code: "CONFLICTED", result: { unmerged } });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a folder set that differs from the snapshot entries below the folder, the hidden rows included, gives STALE_SELECTION", SHELL, () =>
    withService({ name: "t032-folder-set" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const logs = ["logs/1.log", "logs/2.log", "logs/3.log", "logs/4.log"].map((p) => idOf(read, p));
      expect(outcome(await review(service, r, read, logs.slice(0, 3), "recycle", "logs"))).toEqual({ state: "failed", code: "STALE_SELECTION" });
      expect(outcome(await review(service, r, read, [...logs, idOf(read, "u1.txt")], "recycle", "logs"))).toEqual({ state: "failed", code: "STALE_SELECTION" });
      // A folder that is no prefix of its entries.
      expect(outcome(await review(service, r, read, logs, "recycle", "log"))).toEqual({ state: "failed", code: "STALE_SELECTION" });
    }),
    TIMEOUT_MS,
  );
});

// Windows `icacls /deny <user>:(R)` takes the read right of the current account. The second call removes the deny entry.
function denyRead(path: string, deny: boolean): void {
  if (!WINDOWS) return void chmodSync(path, deny ? 0o000 : 0o644);
  const { userInfo } = require("node:os") as typeof import("node:os");
  const args = deny ? [path, "/deny", `${userInfo().username}:(R)`] : [path, "/remove:d", userInfo().username];
  const proc = Bun.spawnSync(["icacls", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`icacls ${args.join(" ")} exited ${proc.exitCode}`);
}

describe("the plan and the token (data-model §4)", () => {
  caseTest(TASK, "the plan holds mode, entryIds, files with the first paths in tree order, tracked, folder, and wsl; the token expires after 60 s", SHELL, () => {
    let clock = 0;
    return withService({ name: "t032-plan", approvalClock: () => clock }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const paths = ["u3.txt", "t/a.txt", "u1.txt", "a/b/c/x.txt", "big.bin"];
      const plan = await reviewOk(service, r, read, paths.map((p) => idOf(read, p)), "recycle");
      const sorted = [...paths].sort((a, b) => comparePaths(Buffer.from(a), Buffer.from(b)));
      expect(plan.plan).toEqual({
        mode: "recycle",
        entryIds: sorted.map((p) => idOf(read, p)),
        files: { count: 5, paths: sorted.map((p) => Buffer.from(p).toString("base64")) },
        tracked: 1,
        folder: null,
        wsl: false,
      });
      clock = 60_001;
      expect(outcome(await run(service, r, plan.workbenchToken))).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED" });
      expect(deleteFrames(service)).toEqual([]);
    });
  }, TIMEOUT_MS);
});

describe("the run (plan.md D6, contract Δ3 `runWorkbench`)", () => {
  caseTest(TASK, "Q12: three untracked files and a changed tracked file go to the bin; the .git/index SHA-256 and every other working byte stay; the tracked file then shows as deleted", SHELL, () =>
    withService({ name: "t032-recycle" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const paths = ["u1.txt", "u2.txt", "u3.txt", "t/a.txt"];
      const before = workingFileDigests(f.repo);
      const index = indexSha(f.repo);
      const plan = await reviewOk(service, r, read, paths.map((p) => idOf(read, p)), "recycle");
      const done = await run(service, r, plan.workbenchToken);
      try {
        expect(outcome(done)).toEqual(SUCCEEDED);
        for (const p of paths) {
          expect({ p, outcome: outcomeOf(done.result!, idOf(read, p))?.outcome, present: exists(join(f.repo, p)) }).toEqual({ p, outcome: "recycled", present: false });
          expect(readFileSync(outcomeOf(done.result!, idOf(read, p))!.recycledPath!, "utf8")).toBe(p === "t/a.txt" ? "t/a.txt changed\n" : `${p}\n`);
        }
        const after = workingFileDigests(f.repo);
        expect(after).toEqual(Object.fromEntries(Object.entries(before).filter(([p]) => !paths.includes(p))));
        expect(indexSha(f.repo)).toBe(index);
        const fresh = await readOk(service, r.repositoryId);
        expect(fresh.entries.some((e) => e.path === "t/a.txt" && e.category === "unstaged" && e.xy?.[1] === "D")).toBe(true);
        expect(deleteFrames(service).map((frame) => frame.mode)).toEqual(["recycle"]);
      } finally {
        purge(service, done.result);
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "Delete permanently removes the file, and the index and every other byte stay", SHELL, () =>
    withService({ name: "t032-permanent" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const index = indexSha(f.repo);
      const before = workingFileDigests(f.repo);
      const plan = await reviewOk(service, r, read, [idOf(read, "big.bin")], "permanent");
      const done = await run(service, r, plan.workbenchToken);
      expect(outcome(done)).toEqual(SUCCEEDED);
      expect(done.result!.entries).toEqual([{ entryId: idOf(read, "big.bin"), outcome: "deleted" }]);
      expect(exists(join(f.repo, "big.bin"))).toBe(false);
      const { "big.bin": _gone, ...rest } = before;
      expect(workingFileDigests(f.repo)).toEqual(rest);
      expect(indexSha(f.repo)).toBe(index);
      // Contract Δ5: a file above 1 MiB binds its size and `lastWrite`, without a digest.
      const [frame] = deleteFrames(service);
      expect(frame!.entries[0]!.expected).toEqual({ kind: "file", size: 1_048_577, lastWrite: expect.any(String) });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "US2-5: a fact change between the review and the run gives STALE_REVIEW files-changed, and no fileDelete request goes out", SHELL, () =>
    withService({ name: "t032-stale" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const plan = await reviewOk(service, r, read, [idOf(read, "u1.txt"), idOf(read, "u2.txt")], "recycle");
      writeFileSync(join(f.repo, "u2.txt"), "u2.txt edited\n");
      const done = await run(service, r, plan.workbenchToken);
      expect(refusal(done)).toEqual({ state: "failed", code: "STALE_REVIEW", result: { action: "delete", reason: "files-changed" } });
      expect(deleteFrames(service)).toEqual([]);
      expect([existsSync(join(f.repo, "u1.txt")), readFileSync(join(f.repo, "u2.txt"), "utf8")]).toEqual([true, "u2.txt edited\n"]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "fileDelete requests hold at most 64 entries in tree order", SHELL, () =>
    withService({ name: "t032-batches" }, async (service) => {
      const f = files();
      const names = Array.from({ length: 70 }, (_, i) => `batch/${i % 2 === 0 ? "B" : "a"}${String(i).padStart(2, "0")}.txt`);
      for (const name of names) write(f.repo, name, "b\n");
      const { r, read } = await open(service, f);
      const entries = await allEntries(service, r, read);
      const ids = names.map((n) => entries.find((e) => e.path === n)!.entryId);
      const plan = await reviewOk(service, r, read, ids, "permanent", "batch");
      const done = await run(service, r, plan.workbenchToken);
      expect(outcome(done)).toEqual(SUCCEEDED);
      const frames = deleteFrames(service);
      expect(frames.map((frame) => [frame.entries.length, frame.folders.length])).toEqual([[64, 0], [6, 0], [0, 1]]);
      const sent = frames.flatMap((frame) => frame.entries.map((e) => e.path));
      const order = [...names].sort((a, b) => comparePaths(Buffer.from(a), Buffer.from(b))).map((n) => join(f.repo, ...n.split(SLASH)));
      expect(sent).toEqual(order);
      expect(exists(join(f.repo, "batch"))).toBe(false);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "Q13: the folder logs loses its 4 listed files and keeps the ignored one and itself; the folder a loses a/b/c/x.txt, then c, b, and a, deepest first", SHELL, () =>
    withService({ name: "t032-folders" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const logs = ["logs/1.log", "logs/2.log", "logs/3.log", "logs/4.log"].map((p) => idOf(read, p));
      const logsPlan = await reviewOk(service, r, read, logs, "permanent", "logs");
      expect(logsPlan.plan.folder).toBe(Buffer.from("logs").toString("base64"));
      const logsRun = await run(service, r, logsPlan.workbenchToken);
      expect(outcome(logsRun)).toEqual(SUCCEEDED);
      expect(logsRun.result!.folders).toEqual([{ pathBytes: Buffer.from("logs").toString("base64"), outcome: "kept" }]);
      expect([existsSync(join(f.repo, "logs", "skip.tmp")), existsSync(join(f.repo, "logs", "1.log"))]).toEqual([true, false]);
      const again = await readOk(service, r.repositoryId);
      const from = service.runner.frames.length;
      const aPlan = await reviewOk(service, r, again, [idOf(again, "a/b/c/x.txt")], "recycle", "a");
      const aRun = await run(service, r, aPlan.workbenchToken);
      try {
        expect(outcome(aRun)).toEqual(SUCCEEDED);
        const folders = deleteFrames(service, from).flatMap((frame) => frame.folders);
        expect(folders).toEqual([join(f.repo, "a", "b", "c"), join(f.repo, "a", "b"), join(f.repo, "a")]);
        expect(aRun.result!.folders.map((x) => [Buffer.from(x.pathBytes, "base64").toString(), x.outcome])).toEqual([["a/b/c", "removed"], ["a/b", "removed"], ["a", "removed"]]);
        expect(exists(join(f.repo, "a"))).toBe(false);
      } finally {
        purge(service, aRun.result);
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "US2-6: a link to a folder outside goes as the link itself, and the target folder and its file stay", ["shell-double", "symlink"], () =>
    withService({ name: "t032-link" }, async (service) => {
      const f = files();
      const outside = String(f.notes.outside);
      symlinkSync(outside, join(f.repo, "dirlink"), "dir");
      const { r, read } = await open(service, f);
      const plan = await reviewOk(service, r, read, [idOf(read, "dirlink")], "permanent");
      const done = await run(service, r, plan.workbenchToken);
      expect(outcome(done)).toEqual(SUCCEEDED);
      expect([exists(join(f.repo, "dirlink")), readFileSync(join(outside, "keep.txt"), "utf8")]).toEqual([false, "outside\n"]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "Git lists the file below a junction, and the review refuses it and the folder row with STALE_SELECTION before any request", ["shell-double", "ntfs-junction"], () =>
    withService({ name: "t032-junction" }, async (service) => {
      const f = files();
      const outside = String(f.notes.outside);
      symlinkSync(outside, join(f.repo, "junction"), "junction");
      const { r, read } = await open(service, f);
      const listedBelow = read.entries.filter((e) => e.path.startsWith("junction")).map((e) => e.path);
      console.log(`OBSERVATION T032: git status lists the junction as ${JSON.stringify(listedBelow)}`);
      expect(listedBelow).toEqual(["junction/keep.txt"]);
      const below = idOf(read, "junction/keep.txt");
      expect(outcome(await review(service, r, read, [below], "permanent"))).toEqual({ state: "failed", code: "STALE_SELECTION" });
      expect(outcome(await review(service, r, read, [below], "recycle", "junction"))).toEqual({ state: "failed", code: "STALE_SELECTION" });
      expect(deleteFrames(service)).toEqual([]);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    }),
    TIMEOUT_MS,
  );

  // Q14: a folder on the path becomes a junction or a folder link to an outside copy of the rest of the path.
  for (const [kind, capability] of [["junction", "ntfs-junction"], ["dir", "symlink"]] as const) {
    caseTest(TASK, `Q14: a folder on the path swapped for a ${kind} link gives STALE_REVIEW files-changed at the check phase, and not-regular under the shell walk; nothing outside changes`, ["shell-double", capability], () =>
      withService({ name: `t032-swap-${kind}` }, async (service) => {
        const f = files();
        const target = join(f.root, `swap-target-${kind}`);
        write(target, "c/x.txt", "outside x\n");
        const swap = () => {
          renameSync(join(f.repo, "a", "b"), join(f.repo, "a", "b-moved"));
          symlinkSync(target, join(f.repo, "a", "b"), kind);
        };
        // A Windows folder link or junction goes with `rmdir`, which never enters the target.
        const restore = () => {
          if (lstatSync(join(f.repo, "a", "b")).isSymbolicLink()) (WINDOWS ? rmdirSync : unlinkSync)(join(f.repo, "a", "b"));
          renameSync(join(f.repo, "a", "b-moved"), join(f.repo, "a", "b"));
        };
        const { r, read } = await open(service, f);
        const first = await reviewOk(service, r, read, [idOf(read, "a/b/c/x.txt")], "permanent");
        swap();
        try {
          expect(refusal(await run(service, r, first.workbenchToken))).toEqual({ state: "failed", code: "STALE_REVIEW", result: { action: "delete", reason: "files-changed" } });
          expect(deleteFrames(service)).toEqual([]);
        } finally {
          restore();
        }
        const again = await readOk(service, r.repositoryId);
        const entryId = idOf(again, "a/b/c/x.txt");
        const second = await reviewOk(service, r, again, [entryId], "permanent");
        service.runner.inject.holdWalk = async (walk) => {
          if (walk === "fileDelete") swap();
        };
        try {
          const done = await run(service, r, second.workbenchToken);
          expect({ state: done.state, entries: done.result?.entries }).toEqual({ state: "failed", entries: [{ entryId, outcome: "not-regular" }] });
        } finally {
          service.runner.inject.holdWalk = null;
          restore();
        }
        expect([readFileSync(join(target, "c", "x.txt"), "utf8"), readFileSync(join(f.repo, "a", "b", "c", "x.txt"), "utf8")]).toEqual(["outside x\n", "a/b/c/x.txt\n"]);
      }),
      TIMEOUT_MS,
    );
  }

  caseTest(TASK, "Delete permanently of a read-only file keeps it with error access-denied, and the response is failed", WINDOWS_RULES, () =>
    withService({ name: "t032-read-only" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const plan = await reviewOk(service, r, read, [idOf(read, "ro.txt")], "permanent");
      const done = await run(service, r, plan.workbenchToken);
      expect({ state: done.state, entries: done.result?.entries }).toEqual({ state: "failed", entries: [{ entryId: idOf(read, "ro.txt"), outcome: "error", code: "access-denied" }] });
      expect(readFileSync(join(f.repo, "ro.txt"), "utf8")).toBe("ro.txt\n");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a change under the shell handle gives changed for that file only, and the response is failed-with-effects", SHELL, () =>
    withService({ name: "t032-shell-stale" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const plan = await reviewOk(service, r, read, [idOf(read, "u1.txt"), idOf(read, "u2.txt")], "permanent");
      let held = false;
      service.runner.inject.holdWalk = async (kind) => {
        if (held || kind !== "fileDelete") return;
        held = true;
        writeFileSync(join(f.repo, "u2.txt"), "u2.txt changed under the handle\n");
      };
      try {
        const done = await run(service, r, plan.workbenchToken);
        expect({ state: done.state, code: done.code, entries: done.result!.entries }).toEqual({
          state: "failed-with-effects",
          code: "FAILED_WITH_EFFECTS",
          entries: [
            { entryId: idOf(read, "u1.txt"), outcome: "deleted" },
            { entryId: idOf(read, "u2.txt"), outcome: "changed" },
          ],
        });
        expect([exists(join(f.repo, "u1.txt")), readFileSync(join(f.repo, "u2.txt"), "utf8")]).toEqual([false, "u2.txt changed under the handle\n"]);
      } finally {
        service.runner.inject.holdWalk = null;
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "Cancel during the held fileDelete walk gives canceled with each fresh outcome, never an undo", SHELL, () =>
    withService({ name: "t032-cancel" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const plan = await reviewOk(service, r, read, [idOf(read, "u1.txt"), idOf(read, "u2.txt")], "permanent");
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      service.runner.inject.holdWalk = (kind) => (kind === "fileDelete" ? gate : Promise.resolve());
      try {
        const requestId = sendRun(service, r, plan.workbenchToken);
        await until(() => service.runner.frames.some((frame) => frame.type === "fileDelete"), "fileDelete frame");
        await service.cancel(await service.operationId(requestId));
        const done = await service.response<DeleteRun>(requestId);
        expect({ state: done.state, code: done.code, entries: done.result?.entries }).toEqual({
          state: "canceled",
          code: "CANCELED",
          entries: [
            { entryId: idOf(read, "u1.txt"), outcome: "stopped" },
            { entryId: idOf(read, "u2.txt"), outcome: "stopped" },
          ],
        });
        expect([existsSync(join(f.repo, "u1.txt")), existsSync(join(f.repo, "u2.txt"))]).toEqual([true, true]);
      } finally {
        release();
        service.runner.inject.holdWalk = null;
      }
    }),
    TIMEOUT_MS,
  );

  // Plan.md D6 "Response state": the delete phase does not stop, so a Cancel never hides a removed file.
  caseTest(TASK, "Cancel after the first fileDelete request: the 64 removed files give failed-with-effects, and the rest stay with stopped", SHELL, () =>
    withService({ name: "t032-cancel-after" }, async (service) => {
      const f = files();
      const names = Array.from({ length: 70 }, (_, i) => `batch/f${String(i).padStart(2, "0")}.txt`);
      for (const name of names) write(f.repo, name, "b\n");
      const { r, read } = await open(service, f);
      const entries = await allEntries(service, r, read);
      const ids = names.map((n) => entries.find((e) => e.path === n)!.entryId);
      const plan = await reviewOk(service, r, read, ids, "permanent");
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let requests = 0;
      service.runner.inject.holdWalk = (kind) => (kind === "fileDelete" && ++requests === 2 ? gate : Promise.resolve());
      try {
        const requestId = sendRun(service, r, plan.workbenchToken);
        await until(() => deleteFrames(service).length === 2, "the second fileDelete frame");
        await service.cancel(await service.operationId(requestId));
        const done = await service.response<DeleteRun>(requestId);
        const counts = (outcome: string) => done.result?.entries.filter((e) => e.outcome === outcome).length;
        expect({ state: done.state, code: done.code, deleted: counts("deleted"), stopped: counts("stopped") }).toEqual({ state: "failed-with-effects", code: "FAILED_WITH_EFFECTS", deleted: 64, stopped: 6 });
      } finally {
        release();
        service.runner.inject.holdWalk = null;
      }
    }),
    TIMEOUT_MS,
  );

  // Plan.md D6 table: a request without an entry reply can have removed a file, as a WSL `interrupted` request or a reply after the wait.
  caseTest(TASK, "a file that is gone after a request without an entry reply counts as an effect: Cancel gives failed-with-effects", SHELL, () =>
    withService({ name: "t032-gone-no-reply" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const plan = await reviewOk(service, r, read, [idOf(read, "u1.txt"), idOf(read, "u2.txt")], "permanent");
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      service.runner.inject.holdWalk = (kind) => {
        if (kind !== "fileDelete") return Promise.resolve();
        rmSync(join(f.repo, "u1.txt"));
        return gate;
      };
      try {
        const requestId = sendRun(service, r, plan.workbenchToken);
        await until(() => deleteFrames(service).length === 1, "the fileDelete frame");
        await service.cancel(await service.operationId(requestId));
        const done = await service.response<DeleteRun>(requestId);
        expect({ state: done.state, code: done.code, entries: done.result?.entries }).toEqual({
          state: "failed-with-effects",
          code: "FAILED_WITH_EFFECTS",
          entries: [
            { entryId: idOf(read, "u1.txt"), outcome: "absent" },
            { entryId: idOf(read, "u2.txt"), outcome: "stopped" },
          ],
        });
      } finally {
        release();
        service.runner.inject.holdWalk = null;
      }
    }),
    TIMEOUT_MS,
  );

  // Contract Δ3: only the service deadline of the request gives DEADLINE. The shell walk deadline replies `stopped`, which names no cause.
  caseTest(TASK, "a shell stop before the delete phase without the service deadline gives failed GIT_FAILED with stopped outcomes", SHELL, () =>
    withService({ name: "t032-shell-stop" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const plan = await reviewOk(service, r, read, [idOf(read, "u1.txt")], "permanent");
      // The walk takes this deadline at its start. The Git processes after it take the 001 deadline again.
      service.runner.inject.deadlineMs = 1_500;
      service.runner.inject.holdWalk = (kind) => {
        if (kind !== "fileDelete") return Promise.resolve();
        service.runner.inject.deadlineMs = null;
        return new Promise<void>(() => {});
      };
      try {
        const done = await run(service, r, plan.workbenchToken);
        expect({ state: done.state, code: done.code, entries: done.result?.entries }).toEqual({ state: "failed", code: "GIT_FAILED", entries: [{ entryId: idOf(read, "u1.txt"), outcome: "stopped" }] });
        expect(existsSync(join(f.repo, "u1.txt"))).toBe(true);
      } finally {
        service.runner.inject.holdWalk = null;
        service.runner.inject.deadlineMs = null;
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "an operation that starts between the review and the run gives OPERATION_IN_PROGRESS, not STALE_REVIEW", SHELL, () =>
    withService({ name: "t032-run-in-progress" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const plan = await reviewOk(service, r, read, [idOf(read, "u1.txt")], "permanent");
      // A MERGE_HEAD marker starts a merge for Git (git-merge(1) "HOW CONFLICTS ARE PRESENTED").
      writeFileSync(join(f.repo, ".git", "MERGE_HEAD"), `${git(f.repo, ["rev-parse", "HEAD"]).trim()}\n`);
      try {
        expect(outcome(await run(service, r, plan.workbenchToken))).toEqual({ state: "failed", code: "OPERATION_IN_PROGRESS" });
        expect(deleteFrames(service)).toEqual([]);
      } finally {
        rmSync(join(f.repo, ".git", "MERGE_HEAD"));
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "in a repository whose command-valued core.fsmonitor needs trust, the review and the run of Delete never run it", SHELL, () =>
    withService({ name: "t032-canary" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const monitor = canary(f.root, "t032-fsmonitor");
      git(f.repo, ["config", "core.fsmonitor", monitor.command]);
      const plan = await reviewOk(service, r, read, [idOf(read, "u1.txt")], "permanent");
      expect(existsSync(monitor.log)).toBe(false);
      expect(outcome(await run(service, r, plan.workbenchToken))).toEqual(SUCCEEDED);
      expect([existsSync(join(f.repo, "u1.txt")), existsSync(monitor.log)]).toEqual([false, false]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a second mutation of the repository gives BUSY while a Delete runs, and the run starts no index-reading Git process before the reconcile read", SHELL, () =>
    withService({ name: "t032-busy" }, async (service) => {
      const f = files();
      const { r, read } = await open(service, f);
      const first = await reviewOk(service, r, read, [idOf(read, "u1.txt")], "permanent");
      const second = await reviewOk(service, r, read, [idOf(read, "u2.txt")], "permanent");
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      service.runner.inject.holdWalk = (kind) => (kind === "fileDelete" ? gate : Promise.resolve());
      const calls = service.runner.calls.length;
      const requestId = sendRun(service, r, first.workbenchToken);
      try {
        await until(() => service.runner.frames.some((frame) => frame.type === "fileDelete"), "fileDelete frame");
        expect(outcome(await run(service, r, second.workbenchToken))).toEqual({ state: "rejected", code: "BUSY" });
      } finally {
        release();
        service.runner.inject.holdWalk = null;
      }
      expect(outcome(await service.response(requestId))).toEqual(SUCCEEDED);
      const operationId = await service.operationId(requestId);
      const own = service.runner.calls.slice(calls).filter((call) => call.operationId === operationId).map((call) => subcommand(call.arguments));
      const reconcile = own.indexOf("status");
      expect(reconcile).toBeGreaterThan(-1);
      expect(own.slice(0, reconcile).filter((name) => !["config", "rev-parse", "symbolic-ref", "show-ref"].includes(name ?? ""))).toEqual([]);
    }),
    TIMEOUT_MS,
  );
});
