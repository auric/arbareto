// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T024: `applyFiles` and the status cut (spec FR-030, FR-034 to FR-040, SC-006, contract Δ4, Δ5, data-model §6, plan.md D8 and O-17, quickstart.md Q15 and Q19).
// Git's own `add` and `reset` in a disposable copy are the oracle (contract §4 "Tests compare each result with `git add` in a disposable copy").

import { describe, expect } from "bun:test";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MULTI_FILE_ACTION_FILES, STATUS_LISTING_RECORDS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import type { RecordedCall } from "./bun-runner";
import { cachedF16Status } from "../windows/fixture-cache";
import { useFixtureRoot } from "./fixture-root";
import { buildF04Stage, put } from "./fixtures";
import { indexEntries, rawIndexDigest, workingFileDigests } from "./git-oracle";
import { candidateFiles, copyRepo, git, gitPath, gitText, outcome, readOk, repoOf, review, subcommand, SUCCEEDED, valuesOf, withService as hunkService } from "./hunk-harness";
import { caseTest, keepConfigs, siblingDeadline, type Capability, type ChangeEntry, type HunkCheckpoint, type Service, type WorkspaceResult } from "./service-harness";
import { buildWorkbench } from "./workbench-fixtures";

// SC-009 (T096): each case keeps the bytes of every configuration file of the repositories that it registers.
const withService = (options: Parameters<typeof hunkService>[0], body: (service: Service) => Promise<void>) => hunkService(options, (service) => keepConfigs(service, body));

const TASK = "T024";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 180_000;
// The 100,000-file cases build the files and read them several times.
const LARGE_TIMEOUT_MS = 900_000;

useFixtureRoot();
printOrigin("../../src/git-service/multi-publish.ts", import.meta.dir);
printOrigin("../../src/git-service/status.ts", import.meta.dir);

let builds = 0;
const tree = () => buildWorkbench(gitPath(), "staging-tree", `t024-tree-${++builds}`).repo;

type Kind = "selected" | "folder" | "all-untracked" | "all-changes" | "all-staged";
type Direction = "stage" | "unstage";

// Every entry of the snapshot, from the first page and each `readEntries` page.
async function allEntries(service: Service, repositoryId: string, read: WorkspaceResult): Promise<ChangeEntry[]> {
  const entries = [...read.entries];
  for (let cursor = read.cursor; cursor !== null; ) {
    const page = await service.readEntries(repositoryId, read.generation, read.snapshotId, cursor);
    expect(["succeeded", "limited"]).toContain(page.state);
    entries.push(...page.result!.entries);
    cursor = page.result!.cursor;
  }
  return entries;
}

// Contract Δ3 `applyFiles`: `{snapshotId, entryIds, direction, kind, folder?}` without `repositoryGeneration`.
// A set of thousands of files takes longer than the default response wait of the harness.
function applyFiles(service: Service, repositoryId: string, read: WorkspaceResult, ids: readonly string[], direction: Direction, kind: Kind, folder?: string) {
  const requestId = service.send("applyFiles", { snapshotId: read.snapshotId, entryIds: ids, direction, kind, ...(folder === undefined ? {} : { folder: Buffer.from(folder).toString("base64") }) }, { repositoryId });
  return service.response(requestId, TIMEOUT_MS);
}

const callsOf = (service: Service, operationId: string) => service.runner.calls.filter((c) => c.operationId === operationId);
const pick = (entries: readonly ChangeEntry[], category: ChangeEntry["category"], ...paths: string[]) =>
  paths.map((path) => {
    const e = entries.find((x) => x.path === path && x.category === category);
    expect({ path, category, listed: e !== undefined }).toEqual({ path, category, listed: true });
    return e!;
  });

// One accepted action. The full logical index equals Git's own command in a copy, every working byte stays, and one `update-index` ran with every path.
async function accepted(service: Service, repo: string, direction: Direction, kind: Kind, choose: (entries: ChangeEntry[]) => ChangeEntry[], oracle: string[], folder?: string): Promise<string> {
  const { repositoryId } = await service.register(repo);
  const read = await readOk(service, repositoryId);
  const chosen = choose(await allEntries(service, repositoryId, read));
  const copy = copyRepo(repo, `t024-oracle-${++builds}`);
  git(copy, oracle);
  const files = workingFileDigests(repo);
  const response = await applyFiles(service, repositoryId, read, chosen.map((e) => e.entryId), direction, kind, folder);
  expect({ kind, ...outcome(response) }).toEqual({ kind, ...SUCCEEDED });
  expect({ kind, entries: indexEntries(gitPath(), repo) }).toEqual({ kind, entries: indexEntries(gitPath(), copy) });
  expect({ kind, files: workingFileDigests(repo) }).toEqual({ kind, files });
  expect(candidateFiles(repo)).toEqual([]);
  const updates = callsOf(service, response.operationId!).filter((c) => subcommand(c.arguments) === "update-index");
  expect(updates.map((c) => c.arguments)).toEqual([direction === "stage" ? ["--no-lazy-fetch", "update-index", "--add", "--remove", "-z", "--stdin"] : ["--no-lazy-fetch", "update-index", "-z", "--index-info"]]);
  if (direction === "stage") expect(Buffer.from(updates[0]!.input!).toString("utf8")).toBe(chosen.map((e) => `${e.path}\0`).join(""));
  return response.operationId!;
}

const isProofA = (args: readonly string[], path: string) => subcommand(args) === "cat-file" && args.includes("--filters") && args.includes(`--path=${path}`);
const isProofB = (args: readonly string[], path: string) => subcommand(args) === "hash-object" && args.includes("--stdin") && args.includes(`--path=${path}`);
// Plan.md O-17: each file takes proof A, and proof B only after a failed proof A.
function proofs(service: Service, operationId: string, path: string): string {
  const calls = callsOf(service, operationId);
  const kinds = calls.flatMap((c) => (isProofA(c.arguments, path) ? ["A"] : isProofB(c.arguments, path) ? ["B"] : []));
  return kinds.join("");
}

describe("file sets stage and unstage as Git's own commands (spec FR-034 to FR-036, FR-038, SC-006)", () => {
  caseTest(TASK, `Stage selected, Stage folder, Stage all untracked, and Stage all changes equal git add of the same paths; each staged file takes proof A`, SHELL, () =>
    withService({ name: "t024-stage" }, async (service) => {
      const selected = await accepted(service, tree(), "stage", "selected", (all) => [...pick(all, "unstaged", "src/a.txt", "docs/d.txt"), ...pick(all, "untracked", "top-new.txt")], ["add", "--", "src/a.txt", "docs/d.txt", "top-new.txt"]);
      for (const path of ["src/a.txt", "docs/d.txt", "top-new.txt"]) expect({ path, proofs: proofs(service, selected, path) }).toEqual({ path, proofs: "A" });
      const under = ["src/a.txt", "src/lib/deep/c.txt", "src/lib/new.txt", "src/new-dir/n1.txt", "src/new-dir/n2.txt"];
      await accepted(service, tree(), "stage", "folder", (all) => all.filter((e) => e.category !== "staged" && under.includes(e.path)), ["add", "--", ...under], "src");
      const untracked = ["src/lib/new.txt", "src/new-dir/n1.txt", "src/new-dir/n2.txt", "top-new.txt"];
      await accepted(service, tree(), "stage", "all-untracked", (all) => all.filter((e) => e.category === "untracked"), ["add", "--", ...untracked]);
      await accepted(service, tree(), "stage", "all-changes", (all) => all.filter((e) => e.category !== "staged"), ["add", "-A"]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `Unstage all and Unstage folder equal git reset of the same paths`, SHELL, () =>
    withService({ name: "t024-unstage" }, async (service) => {
      const all = tree();
      git(all, ["add", "-A"]);
      await accepted(service, all, "unstage", "all-staged", (entries) => entries.filter((e) => e.category === "staged"), ["reset", "-q"]);
      const folder = tree();
      git(folder, ["add", "-A"]);
      const under = ["src/a.txt", "src/lib/deep/c.txt", "src/lib/new.txt", "src/new-dir/n1.txt", "src/new-dir/n2.txt"];
      await accepted(service, folder, "unstage", "folder", (entries) => entries.filter((e) => e.category === "staged" && under.includes(e.path)), ["reset", "-q", "--", ...under], "src");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a set whose step 7 status read needs several processes under the command-line bound stages as git add`, SHELL, () =>
    withService({ name: "t024-batches" }, async (service) => {
      const repo = tree();
      // 3,200 names of 11 units hold more than the 32,767 units of one command line (contract §6). A batch then ends less than one name below the bound,
      // so a measure with a shorter program path than the shell's gives a refused process. The oracle adds the folder, which holds only these names.
      const names = Array.from({ length: 3200 }, (_, i) => `s/${String(i).padStart(4, "0")}.txt`);
      for (const name of names) put(repo, name, `${name}\n`);
      const operationId = await accepted(service, repo, "stage", "selected", (all) => all.filter((e) => e.category === "untracked" && e.path.startsWith("s/")), ["add", "--", "s"]);
      const statuses = callsOf(service, operationId).filter((c) => subcommand(c.arguments) === "status");
      expect(statuses.length).toBeGreaterThan(1);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `Cancel during the parallel proofs ends every proof process, publishes nothing, and leaves no candidate (plan.md O-17)`, SHELL, () =>
    withService({ name: "t024-cancel" }, async (service) => {
      const repo = tree();
      const names = Array.from({ length: 200 }, (_, i) => `c/${String(i).padStart(3, "0")}.txt`);
      for (const name of names) put(repo, name, `${name}\n`);
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const ids = (await allEntries(service, repositoryId, read)).filter((e) => e.category === "untracked" && e.path.startsWith("c/")).map((e) => e.entryId);
      const before = rawIndexDigest(gitPath(), repo);
      // The first `stage-files` event comes after one proof. The cancel request goes after the current frame write.
      let canceled: Promise<unknown> | null = null;
      const push = service.progress.push.bind(service.progress);
      service.progress.push = (...events: unknown[]) => {
        const length = push(...events);
        for (const e of events as { phase?: string; operationId?: string }[]) if (e.phase === "stage-files" && canceled === null) canceled = Bun.sleep(0).then(() => service.cancel(e.operationId!));
        return length;
      };
      const response = await applyFiles(service, repositoryId, read, ids, "stage", "selected");
      await canceled;
      expect(outcome(response)).toEqual({ state: "canceled", code: "CANCELED" });
      expect(rawIndexDigest(gitPath(), repo)).toBe(before);
      expect(candidateFiles(repo)).toEqual([]);
      expect(callsOf(service, response.operationId!).filter((c) => subcommand(c.arguments) === "cat-file" && c.arguments.includes("--filters")).length).toBeLessThan(names.length);
      expect(service.runner.liveRecorded()).toBe(0);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a file whose proof A fails takes proof B, and the set still equals git add (research.md R3 probe 7, plan.md O-17)`, SHELL, () =>
    withService({ name: "t024-proof-b" }, async (service) => {
      const repo = repoOf(buildF04Stage(gitPath(), "t024-proof-b", "mixed-over-lf"));
      // A NUL byte makes the file binary, so `core.autocrlf=true` converts nothing and proof A holds (gitattributes(5) `text`).
      put(repo, "extra.dat", Uint8Array.of(0x65, 0x00, 0x0a));
      const operationId = await accepted(service, repo, "stage", "selected", (all) => [...pick(all, "unstaged", "f.txt"), ...pick(all, "untracked", "extra.dat")], ["add", "--", "f.txt", "extra.dat"]);
      expect({ f: proofs(service, operationId, "f.txt"), extra: proofs(service, operationId, "extra.dat") }).toEqual({ f: "AB", extra: "A" });
    }),
    TIMEOUT_MS,
  );
});

describe("refusals stage nothing (spec FR-038 to FR-040)", () => {
  // The index stays byte for byte, every working byte stays, and no owned candidate stays.
  async function refused(service: Service, repo: string, send: (repositoryId: string, read: WorkspaceResult, entries: ChangeEntry[]) => Promise<{ state: string; code?: string; result?: unknown; operationId?: string }>, expected: object) {
    const { repositoryId } = await service.register(repo);
    const read = await readOk(service, repositoryId);
    const entries = await allEntries(service, repositoryId, read);
    const before = { index: rawIndexDigest(gitPath(), repo), files: workingFileDigests(repo) };
    const response = await send(repositoryId, read, entries);
    expect({ ...outcome(response), ...(response.result as object | undefined) }).toMatchObject(expected);
    expect({ index: rawIndexDigest(gitPath(), repo), files: workingFileDigests(repo) }).toEqual(before);
    expect(candidateFiles(repo)).toEqual([]);
    return response;
  }

  caseTest(TASK, `one refused file refuses the whole set and names the entry and its reason; no update-index runs`, SHELL, () =>
    withService({ name: "t024-one-refused" }, async (service) => {
      const repo = tree();
      // git-add(1) `-N`: an intent-to-add entry, which the 001 decision refuses with reason `index-flag`.
      git(repo, ["add", "-N", "--", "top-new.txt"]);
      let ita = "";
      const response = await refused(
        service,
        repo,
        (repositoryId, read, entries) => {
          const chosen = [...pick(entries, "unstaged", "src/a.txt", "top-new.txt")];
          ita = chosen[1]!.entryId;
          return applyFiles(service, repositoryId, read, chosen.map((e) => e.entryId), "stage", "selected");
        },
        { state: "rejected", code: "UNSUPPORTED_COMPARISON", reason: "index-flag" },
      );
      expect((response.result as { entryId?: string }).entryId).toBe(ita);
      expect(callsOf(service, response.operationId!).filter((c) => subcommand(c.arguments) === "update-index")).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a file without a blob proof refuses the whole set with reason blob-proof after the candidate, and nothing is published`, SHELL, () =>
    withService({ name: "t024-blob-proof" }, async (service) => {
      const repo = repoOf(buildF04Stage(gitPath(), "t024-blob-proof", "index-attribute"));
      put(repo, "extra.dat", Uint8Array.of(0x65, 0x00, 0x0a));
      let f = "";
      const response = await refused(
        service,
        repo,
        (repositoryId, read, entries) => {
          const chosen = [...pick(entries, "unstaged", "f.txt"), ...pick(entries, "untracked", "extra.dat")];
          f = chosen[0]!.entryId;
          return applyFiles(service, repositoryId, read, chosen.map((e) => e.entryId), "stage", "selected");
        },
        { state: "failed", code: "UNSUPPORTED_COMPARISON", reason: "blob-proof" },
      );
      expect((response.result as { entryId?: string }).entryId).toBe(f);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a change of the set after step 5 gives STALE_SELECTION, nothing is published, and the changed bytes stay`, SHELL, async () => {
    const repo = tree();
    let fire = false;
    const hunkCheckpoint = (c: HunkCheckpoint) => {
      if (fire && c.step === 5) {
        fire = false;
        writeFileSync(join(repo, "top-new.txt"), "changed during staging\n");
      }
    };
    await withService({ name: "t024-stale", hunkCheckpoint }, async (service) => {
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const entries = await allEntries(service, repositoryId, read);
      const before = rawIndexDigest(gitPath(), repo);
      fire = true;
      const response = await applyFiles(service, repositoryId, read, [...pick(entries, "unstaged", "src/a.txt"), ...pick(entries, "untracked", "top-new.txt")].map((e) => e.entryId), "stage", "selected");
      expect(outcome(response)).toEqual({ state: "failed", code: "STALE_SELECTION" });
      expect(rawIndexDigest(gitPath(), repo)).toBe(before);
      expect(gitText(repo, ["show", ":src/a.txt"])).toBe(gitText(repo, ["show", "HEAD:src/a.txt"]));
      expect(Bun.file(join(repo, "top-new.txt")).size).toBe("changed during staging\n".length);
      expect(candidateFiles(repo)).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, `above 512 MiB of working bytes the set refuses with reason limit before any process; above ${MULTI_FILE_ACTION_FILES} entry IDs the request refuses by its schema`, SHELL, () =>
    withService({ name: "t024-bytes" }, async (service) => {
      const repo = tree();
      for (const name of ["big-1.bin", "big-2.bin"]) {
        writeFileSync(join(repo, name), "");
        truncateSync(join(repo, name), 300 * 1024 * 1024);
      }
      const response = await refused(
        service,
        repo,
        (repositoryId, read, entries) => applyFiles(service, repositoryId, read, pick(entries, "untracked", "big-1.bin", "big-2.bin").map((e) => e.entryId), "stage", "selected"),
        { state: "rejected", code: "WORKBENCH_UNAVAILABLE", reason: "limit" },
      );
      expect(callsOf(service, response.operationId!).filter((c) => subcommand(c.arguments) === "update-index")).toEqual([]);
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const many = Array.from({ length: MULTI_FILE_ACTION_FILES + 1 }, () => crypto.randomUUID());
      expect(outcome(await applyFiles(service, repositoryId, read, many, "stage", "selected")).code).toBe("INVALID_REQUEST");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `an entry set that differs from the derived set of the kind gives INVALID_REQUEST, and a snapshot that a newer read replaced is refused`, SHELL, () =>
    withService({ name: "t024-derived" }, async (service) => {
      const repo = tree();
      await refused(
        service,
        repo,
        (repositoryId, read, entries) => applyFiles(service, repositoryId, read, pick(entries, "untracked", "top-new.txt").map((e) => e.entryId), "stage", "all-untracked"),
        { state: "rejected", code: "INVALID_REQUEST" },
      );
      const { repositoryId } = await service.register(repo);
      const old = await readOk(service, repositoryId);
      const ids = pick(await allEntries(service, repositoryId, old), "untracked", "top-new.txt").map((e) => e.entryId);
      put(repo, "later.txt", "later\n");
      await readOk(service, repositoryId);
      const before = rawIndexDigest(gitPath(), repo);
      const response = await applyFiles(service, repositoryId, old, ids, "stage", "selected");
      expect(response.state).toBe("rejected");
      expect(["UNKNOWN_TARGET", "REPOSITORY_CHANGED"]).toContain(response.code!);
      expect(rawIndexDigest(gitPath(), repo)).toBe(before);
    }),
    TIMEOUT_MS,
  );
});

describe("the status cut (contract Δ4 \"Status cut\", research.md R18 and R21 F28)", () => {
  // 100 folders of 1,000 files under `u/`, after the tracked changes of the tree fixture and one staged change.
  function build100k(): string {
    const repo = tree();
    git(repo, ["add", "--", "docs/d.txt"]);
    for (let d = 0; d < 100; d++) {
      const dir = join(repo, "u", String(d).padStart(3, "0"));
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 1000; i++) writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.txt`), "x\n");
    }
    return repo;
  }

  // git-status(1) porcelain v2 without untracked files: the tracked entries by category, as `readWorkspace` splits XY.
  function trackedOracle(repo: string): string[] {
    const records = gitText(repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=no"]).split("\0").filter((r) => r.startsWith("1 "));
    return records.flatMap((r) => {
      const fields = r.split(" ");
      const path = fields.slice(8).join(" ");
      return [...(fields[1]![0] !== "." ? [`staged ${path}`] : []), ...(fields[1]![1] !== "." ? [`unstaged ${path}`] : [])];
    }).sort();
  }

  caseTest(TASK, `a read cut inside the untracked records gives cut untracked with complete tracked and staged lists and an unblocked Commit; a derived stage set refuses with limit, and a selected tracked file stages`, SHELL, () =>
    withService({ name: "t024-cut" }, async (service) => {
      const repo = build100k();
      const { repositoryId } = await service.register(repo);
      const read = await service.readWorkspace(repositoryId);
      expect(outcome(read)).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
      const result = read.result as WorkspaceResult & { cut?: string | null };
      expect({ completeness: result.completeness, cut: result.cut }).toEqual({ completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS" }, cut: "untracked" });
      const entries = await allEntries(service, repositoryId, result);
      expect(entries.filter((e) => e.category !== "untracked").map((e) => `${e.category} ${e.path}`).sort()).toEqual(trackedOracle(repo));
      // Three tracked records come first, then the untracked records up to the record bound.
      expect(entries.length).toBe(STATUS_LISTING_RECORDS);
      const r = await review(service, repositoryId, result);
      expect({ ...outcome(r.response), token: typeof r.token }).toEqual({ ...SUCCEEDED, token: "string" });
      expect(valuesOf(r.response.result, "pathBytes")).toEqual([Buffer.from("docs/d.txt").toString("base64")]);
      const before = rawIndexDigest(gitPath(), repo);
      const untracked = entries.filter((e) => e.category === "untracked").slice(0, MULTI_FILE_ACTION_FILES);
      for (const [kind, folder] of [["all-untracked", undefined], ["all-changes", undefined], ["folder", "u"]] as const) {
        const response = await applyFiles(service, repositoryId, result, untracked.map((e) => e.entryId), "stage", kind, folder);
        expect({ kind, ...outcome(response), reason: (response.result as { reason?: string })?.reason }).toEqual({ kind, state: "rejected", code: "WORKBENCH_UNAVAILABLE", reason: "limit" });
      }
      expect(rawIndexDigest(gitPath(), repo)).toBe(before);
      // A copy of 100,000 files costs minutes, so the oracle is the blob that git add stores for this file without attributes.
      const others = indexEntries(gitPath(), repo).filter((e) => e.path !== "src/a.txt");
      const blob = gitText(repo, ["hash-object", "--", "src/a.txt"]).trim();
      const response = await applyFiles(service, repositoryId, result, pick(entries, "unstaged", "src/a.txt").map((e) => e.entryId), "stage", "selected");
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect({ others: indexEntries(gitPath(), repo).filter((e) => e.path !== "src/a.txt"), blob: indexEntries(gitPath(), repo).find((e) => e.path === "src/a.txt")?.oid }).toEqual({ others, blob });
      // A complete read of exactly 100,000 untracked records: Stage all untracked derives more than 10,000 entries.
      git(repo, ["reset", "-q", "--hard"]);
      for (const path of ["top-new.txt", "src/lib/new.txt", "src/new-dir"]) rmSync(join(repo, path), { recursive: true });
      const complete = await readOk(service, repositoryId);
      expect({ entryCount: complete.entryCount, cut: (complete as { cut?: unknown }).cut }).toEqual({ entryCount: STATUS_LISTING_RECORDS, cut: null });
      const all = await applyFiles(service, repositoryId, complete, (await allEntries(service, repositoryId, complete)).slice(0, MULTI_FILE_ACTION_FILES).map((e) => e.entryId), "stage", "all-untracked");
      expect({ ...outcome(all), reason: (all.result as { reason?: string })?.reason }).toEqual({ state: "rejected", code: "WORKBENCH_UNAVAILABLE", reason: "limit" });
      expect(callsOf(service, all.operationId!)).toEqual([]);
    }),
    LARGE_TIMEOUT_MS,
  );

  caseTest(TASK, `a read cut inside the tracked records gives cut other, and the Commit review stays limited by the 001 rule`, SHELL, () =>
    withService({ name: "t024-cut-other" }, async (service) => {
      const built = cachedF16Status(gitPath(), "t024-cut-other", "over-limit").built;
      const { repositoryId } = await service.register(repoOf(built));
      const read = await service.readWorkspace(repositoryId);
      const result = read.result as WorkspaceResult & { cut?: string | null };
      expect({ ...outcome(read), cut: result.cut }).toEqual({ state: "limited", code: "OUTPUT_LIMIT", cut: "other" });
      const r = await review(service, repositoryId, result);
      expect(outcome(r.response)).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
    }),
    LARGE_TIMEOUT_MS,
  );

  caseTest(TASK, `a complete read gives cut null`, SHELL, () =>
    withService({ name: "t024-cut-null" }, async (service) => {
      const { repositoryId } = await service.register(tree());
      expect((await readOk(service, repositoryId) as { cut?: unknown }).cut).toBeNull();
    }),
    TIMEOUT_MS,
  );
});

// T399, 001 contract §5 "Deadline outcomes": a proof at its deadline closes the operation Job, so the proof beside it ends with `exitCode` null and no `deadline`.
// The proofs run before publication, so the set ends failed with DEADLINE and stages nothing (001 contract §5, §9).
describe("parallel proof deadline (T399)", () => {
  caseTest("T399", `proof A of one file expires while the Job close ends proof B of another file first; the set gives DEADLINE, not the blob-proof refusal of the closed proof`, SHELL, () =>
    withService({ name: "t399-proofs" }, async (service) => {
      const repo = repoOf(buildF04Stage(gitPath(), "t399-proofs", "mixed-over-lf"));
      // As in the proof B case above: `f.txt` takes proof B, and `extra.dat` holds proof A.
      put(repo, "extra.dat", Uint8Array.of(0x65, 0x00, 0x0a));
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const ids = [...pick(read.entries, "unstaged", "f.txt"), ...pick(read.entries, "untracked", "extra.dat")].map((e) => e.entryId);
      const before = rawIndexDigest(gitPath(), repo);
      const target = (call: { arguments: readonly string[] }) => isProofA(call.arguments, "extra.dat");
      const sibling = (call: { arguments: readonly string[] }) => isProofB(call.arguments, "f.txt");
      const from = service.runner.calls.length;
      const release = siblingDeadline(service, target, sibling);
      const response = await applyFiles(service, repositoryId, read, ids, "stage", "selected").finally(release);
      const calls = service.runner.calls.slice(from);
      const endOf = (call: RecordedCall | undefined) => call?.exit?.deadline ?? (call?.exit?.exitCode === null ? "closed" : String(call?.exit?.exitCode));
      const exits = [calls.find(target), calls.find(sibling)].map(endOf);
      console.log(`OBSERVATION T399: proofs exits=${exits.join(",")} state=${response.state} code=${response.code}`);
      expect({ exits, ...outcome(response), index: rawIndexDigest(gitPath(), repo), candidates: candidateFiles(repo) }).toEqual({ exits: ["deadline", "closed"], state: "failed", code: "DEADLINE", index: before, candidates: [] });
    }),
    120_000,
  );
});
