// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T200: the pure decisions of `applyFile` (contract §4 "File staging" steps 5 and 6, "Blob proof"). No Git process runs in them.
// T118: Stage file, Unstage file, and Stage all changes of a moved gitlink in real temporary repositories (feature 005 plan.md D20, contract Δ4, SC-013).
// Git's own `add`, `restore --staged`, and `add -A` on a copy are the oracle. They compare `ls-files -z --stage` bytes, because `--index-info` writes zero stat data.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadComparisonResult } from "../../src/contracts/envelope";
import { decideFileAction, type FileActionCategory } from "../../src/contracts/file-action";
import type { RawIndexEntry } from "../../src/git-service/eligibility";
import { changedEntries, digestSink, fileApproval, indexInfoInput, type ExpectedChange, type FileAction } from "../../src/git-service/file-publish";
import type { RetainedComparison } from "../../src/git-service/comparison";
import type { ChangeSnapshot } from "../../src/git-service/snapshot";
import type { Workspace } from "../../src/git-service/registration";
import { printOrigin } from "../origin";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { rawIndexDigest, workingFileDigests } from "./git-oracle";
import { candidateFiles, compare, copyRepo, git, gitPath, gitText, one, outcome, readOk, subcommand, SUCCEEDED, valuesOf, withService, type Comparison } from "./hunk-harness";
import { caseTest, type Capability, type HunkCheckpoint, type Service, type WorkspaceResult } from "./service-harness";

for (const module of ["file-publish", "multi-publish", "comparison", "submodule-change"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
printOrigin("../../src/contracts/file-action.ts", import.meta.dir);
useFixtureRoot();

const HEAD = "1".repeat(40);
const INDEX = "2".repeat(40);
const STAGED = "3".repeat(40);
const ZERO = "0".repeat(40);
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const text = (value: Uint8Array) => Buffer.from(value).toString("latin1");

// One `status --porcelain=v2 -z` record without its final NUL, and its decided file action.
function actionOf(category: FileActionCategory, record: string, headUnborn = false): FileAction {
  const decision = decideFileAction({ category, record: bytes(record), headUnborn, indexFlags: { intentToAdd: false, assumeUnchanged: false, skipWorktree: false }, attributes: {}, working: { type: "absent" } });
  if (decision.direction === null) throw new Error(`refused: ${JSON.stringify(decision)}`);
  return decision;
}
const unstageRows = (action: FileAction) => (action.direction === "unstage" ? action.changedPaths : []);

describe("indexInfoInput (contract §4 step 5, git-update-index(1) `--index-info`)", () => {
  test.each([
    ["modified", actionOf("staged", `1 M. N... 100644 100644 100644 ${HEAD} ${INDEX} a.txt`), `100644 ${HEAD}\ta.txt\0`],
    ["executable", actionOf("staged", `1 M. N... 100755 100644 100644 ${HEAD} ${INDEX} a.sh`), `100755 ${HEAD}\ta.sh\0`],
    ["added, mode 0", actionOf("staged", `1 A. N... 000000 100644 100644 ${ZERO} ${INDEX} new.txt`), `0 ${ZERO}\tnew.txt\0`],
    ["rename, 2 rows", actionOf("staged", `2 R. N... 100644 100644 100644 ${HEAD} ${INDEX} R100 dst.txt\0src.txt`), `100644 ${HEAD}\tsrc.txt\0` + `0 ${ZERO}\tdst.txt\0`],
    ["copy, destination only", actionOf("staged", `2 C. N... 100644 100644 100644 ${HEAD} ${INDEX} C100 dst.txt\0src.txt`), `0 ${ZERO}\tdst.txt\0`],
    ["unborn", actionOf("staged", `1 A. N... 000000 100644 100644 ${ZERO} ${INDEX} first.txt`, true), `0 ${ZERO}\tfirst.txt\0`],
    ["path with space and tab", actionOf("staged", `1 M. N... 100644 100644 100644 ${HEAD} ${INDEX} a b\tc.txt`), `100644 ${HEAD}\ta b\tc.txt\0`],
  ])("%s", (_name, action, expected) => {
    expect(text(indexInfoInput(unstageRows(action)))).toBe(expected);
  });
});

describe("changedEntries (contract §4 step 6)", () => {
  const CLEAN = { stage: 0, assumeUnchanged: false, skipWorktree: false, intentToAdd: false };
  const entry = (path: string, oid: string, mode = "100644", extra: Partial<RawIndexEntry> = {}): RawIndexEntry => ({ path: bytes(path), mode, oid, ...CLEAN, ...extra });
  const canonical = [entry("a.txt", INDEX), entry("b.txt", INDEX)];
  const stage = (path: string): FileAction => ({ direction: "stage", changedPaths: [{ path: bytes(path) }] });
  const target = (action: FileAction, mode: string | null = "100644", deletion = false): ExpectedChange => ({ action, mode, deletion, objectFormat: "sha1" });
  const unstage = actionOf("staged", `1 M. N... 100644 100644 100644 ${HEAD} ${INDEX} a.txt`);
  const added = actionOf("staged", `1 A. N... 000000 100644 100644 ${ZERO} ${INDEX} a.txt`);
  const rename = actionOf("staged", `2 R. N... 100644 100644 100644 ${HEAD} ${INDEX} R100 a.txt\0src.txt`);

  test.each([
    ["stage: the working mode and a new blob", target(stage("a.txt")), [entry("a.txt", STAGED), entry("b.txt", INDEX)], { staged: STAGED }],
    ["stage: another mode than status reported", target(stage("a.txt")), [entry("a.txt", STAGED, "100755"), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a set assume-unchanged flag", target(stage("a.txt")), [entry("a.txt", STAGED, "100644", { assumeUnchanged: true }), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a set skip-worktree flag", target(stage("a.txt")), [entry("a.txt", STAGED, "100644", { skipWorktree: true }), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a higher stage", target(stage("a.txt")), [entry("a.txt", STAGED, "100644", { stage: 2 }), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a malformed object ID", target(stage("a.txt")), [entry("a.txt", "xyz"), entry("b.txt", INDEX)], { detail: "selected-entry" }],
    ["stage: a changed unrelated entry", target(stage("a.txt")), [entry("a.txt", STAGED), entry("b.txt", STAGED)], { detail: "unrelated-entries" }],
    ["stage: a removed unrelated entry", target(stage("a.txt")), [entry("a.txt", STAGED)], { detail: "unrelated-entries" }],
    ["stage untracked: mode 100644", target(stage("c.txt"), null), [entry("a.txt", INDEX), entry("b.txt", INDEX), entry("c.txt", STAGED)], { staged: STAGED }],
    ["stage untracked: mode 100755", target(stage("c.txt"), null), [entry("a.txt", INDEX), entry("b.txt", INDEX), entry("c.txt", STAGED, "100755")], { staged: STAGED }],
    ["stage untracked: mode 120000", target(stage("c.txt"), null), [entry("a.txt", INDEX), entry("b.txt", INDEX), entry("c.txt", STAGED, "120000")], { detail: "selected-entry" }],
    ["stage untracked: no entry", target(stage("c.txt"), null), canonical, { detail: "selected-entry" }],
    ["stage deletion: the entry is gone", target(stage("a.txt"), "000000", true), [entry("b.txt", INDEX)], { staged: null }],
    ["stage deletion: the entry stays", target(stage("a.txt"), "000000", true), canonical, { detail: "selected-entry" }],
    ["unstage: the HEAD entry", target(unstage, null), [entry("a.txt", HEAD), entry("b.txt", INDEX)], { staged: null }],
    // `--index-info` skips a path that `verify_path` refuses and exits 0 (research R3).
    ["unstage: the canonical entry stays", target(unstage, null), canonical, { detail: "selected-entry" }],
    ["unstage: mode 0 removes the path", target(added, null), [entry("b.txt", INDEX)], { staged: null }],
    ["unstage: mode 0 and the canonical entry stays", target(added, null), canonical, { detail: "selected-entry" }],
    ["unstage rename: the source HEAD entry and no destination", target(rename, null), [entry("b.txt", INDEX), entry("src.txt", HEAD)], { staged: null }],
    ["unstage rename: the destination stays", target(rename, null), [entry("a.txt", INDEX), entry("b.txt", INDEX), entry("src.txt", HEAD)], { detail: "selected-entry" }],
  ] as const)("%s", (_name, t, candidate, expected) => {
    expect(changedEntries(t, candidate, canonical)).toEqual(expected);
  });
});

// Feature 005 plan.md D20 "Publication" steps 5 and 6 (T118): a moved gitlink stages its `--index-info` line, and only that entry may change.
describe("a moved gitlink (feature 005 contract Δ4 steps 5 and 6)", () => {
  const SUB = "4".repeat(40);
  const CLEAN = { stage: 0, assumeUnchanged: false, skipWorktree: false, intentToAdd: false };
  const entry = (path: string, oid: string, mode = "100644", extra: Partial<RawIndexEntry> = {}): RawIndexEntry => ({ path: bytes(path), mode, oid, ...CLEAN, ...extra });
  const moved = decideFileAction({
    category: "unstaged",
    record: bytes(`1 .M SC.. 160000 160000 160000 ${HEAD} ${HEAD} sub`),
    headUnborn: false,
    indexFlags: { intentToAdd: false, assumeUnchanged: false, skipWorktree: false },
    attributes: {},
    working: { type: "directory", diskPath: bytes("sub") },
    gitlink: { head: SUB },
  }) as FileAction;
  const canonical = [entry("a.txt", INDEX), entry("sub", HEAD, "160000")];
  const target: ExpectedChange = { action: moved, mode: "160000", deletion: false, objectFormat: "sha1" };

  test("the --index-info input holds 160000 SP <head> TAB <path> NUL", () => {
    expect(moved.direction).toBe("stage");
    expect(text(indexInfoInput(moved.changedPaths as Parameters<typeof indexInfoInput>[0]))).toBe(`160000 ${SUB}\tsub\0`);
  });

  test.each([
    ["the submodule HEAD at stage 0 with clean flags; no blob was staged", [entry("a.txt", INDEX), entry("sub", SUB, "160000")], { staged: null }],
    ["the old commit stays", canonical, { detail: "selected-entry" }],
    ["the HEAD commit with a file mode", [entry("a.txt", INDEX), entry("sub", SUB)], { detail: "selected-entry" }],
    ["a set skip-worktree flag", [entry("a.txt", INDEX), entry("sub", SUB, "160000", { skipWorktree: true })], { detail: "selected-entry" }],
    ["a higher stage", [entry("a.txt", INDEX), entry("sub", SUB, "160000", { stage: 2 })], { detail: "selected-entry" }],
    ["no entry", [entry("a.txt", INDEX)], { detail: "selected-entry" }],
    ["a changed unrelated entry", [entry("a.txt", STAGED), entry("sub", SUB, "160000")], { detail: "unrelated-entries" }],
  ] as const)("%s", (_name, candidate, expected) => {
    expect(changedEntries(target, candidate, canonical)).toEqual(expected);
  });
});

describe("digestSink (contract §4 \"Blob proof\" proof A)", () => {
  const sha = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

  test("the verified size stays within the bound, and the digest covers the pushed bytes", () => {
    const sink = digestSink(3);
    sink.push(bytes("ab"));
    sink.push(bytes("c"));
    expect({ bytes: sink.bytes, limited: sink.limited, digest: sink.digest() }).toEqual({ bytes: 3, limited: false, digest: sha("abc") });
  });

  test.each([
    ["one chunk", ["abcd"]],
    ["a later chunk", ["abc", "d"]],
  ])("the sink goes limited at the verified size plus one byte: %s", (_name, chunks) => {
    const sink = digestSink(3);
    for (const chunk of chunks) sink.push(bytes(chunk));
    expect({ bytes: sink.bytes, limited: sink.limited, digest: sink.digest() }).toEqual({ bytes: 4, limited: true, digest: sha("abc") });
  });

  test("an empty blob of size 0", () => {
    const sink = digestSink(0);
    expect({ limited: sink.limited, digest: sink.digest() }).toEqual({ limited: false, digest: sha("") });
  });
});

describe("fileApproval (data-model §6, contract §4 \"Binding\")", () => {
  const w = { gitInstallationId: "g", worktreeIdentity: [{}, {}], commonIdentity: {} } as unknown as Workspace;
  const s = { head: { state: "unborn", target: "refs/heads/main" }, indexFingerprint: { rawIndexDigest: null }, indexEntries: [], policyFingerprint: "p", operationState: "normal" } as unknown as ChangeSnapshot;
  const comparison = (fileAction: RetainedComparison["fileAction"]) =>
    ({
      comparisonId: "c",
      repositoryId: "r",
      snapshotId: "s",
      generation: 1,
      entry: { entryId: "e", pathBytes: Buffer.from("a.txt").toString("base64"), category: "unstaged" },
      fileAction,
      working: { size: 3, sha256: "d".repeat(64) },
      attributes: {},
      workingVersion: null,
    }) as unknown as RetainedComparison;

  test("stage binds the whole working file, unstage binds no working values, and a refused entry gets none", () => {
    const staged = fileApproval(comparison({ direction: "stage", changedPaths: [{ path: bytes("a.txt") }] }), s, w);
    const unstaged = fileApproval(comparison({ direction: "unstage", changedPaths: [] }), s, w);
    expect({ kind: staged?.kind, entryId: staged?.entryId, direction: staged?.direction, working: staged?.binding.working }).toEqual({ kind: "file", entryId: "e", direction: "stage", working: { size: 3, sha256: "d".repeat(64) } });
    expect({ direction: unstaged?.direction, working: unstaged?.binding.working }).toEqual({ direction: "unstage", working: null });
    expect(fileApproval(comparison({ direction: null, code: "UNSUPPORTED_COMPARISON", reason: "size" }), s, w)).toBeNull();
    expect(fileApproval(comparison({ direction: "stage", changedPaths: [] }), { ...s, policyFingerprint: null }, w)).toBeNull();
  });
});

// ---- T118: a moved gitlink in real temporary repositories (spec FR-077 to FR-081, SC-013) ----

const T118 = "T118";
const SHELL: Capability[] = ["shell-double"];
const T118_MS = 180_000;
const FILE_ALLOW = ["-c", "protocol.file.allow=always"];
const SUBMODULES = ["sub", "edit", "gone"] as const;
const INDEX_INFO = ["--no-lazy-fetch", "update-index", "-z", "--index-info"];
const ADD_STDIN = ["--no-lazy-fetch", "update-index", "--add", "--remove", "-z", "--stdin"];
// Plan.md D20: Stage file of a gitlink writes no object, runs no filter, and runs no Git porcelain.
const FORBIDDEN = ["add", "hash-object", "reset", "restore", "rm"];
let worlds = 0;

// `rev-parse --verify -q HEAD` prints nothing and exits 1 for an unborn HEAD.
const headOf = (dir: string) => gitText(dir, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [0, 1] }).trim();
function commitIn(dir: string, file: string, content: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, ["add", "--", file]);
  git(dir, ["commit", "-q", "--no-verify", "-m", file]);
  return headOf(dir);
}

// A library with one commit, and a superproject with the submodules `sub`, `edit`, and `gone` at that commit. Then `sub` moves one commit.
function world(): string {
  const root = fixtureDir(`t118-${++worlds}`);
  const lib = join(root, "lib");
  mkdirSync(lib);
  git(lib, ["init", "-q"]);
  commitIn(lib, "f.txt", "one\n");
  const sup = join(root, "super");
  mkdirSync(sup);
  git(sup, ["init", "-q"]);
  commitIn(sup, "s.txt", "base\n");
  for (const name of SUBMODULES) git(sup, [...FILE_ALLOW, "submodule", "add", "-q", "--", lib, name]);
  git(sup, ["commit", "-q", "--no-verify", "-m", "submodules"]);
  commitIn(join(sup, "sub"), "g.txt", "two\n");
  return sup;
}

const listing = (repo: string) => git(repo, ["ls-files", "-z", "--stage"]).toString("latin1");
// Git's own command on a disposable copy, and the `ls-files -z --stage` bytes after it.
const oracle = (sup: string, args: string[]) => {
  const copy = copyRepo(sup, `t118-oracle-${++worlds}`);
  git(copy, args);
  return listing(copy);
};
// The facts that no action may change: the HEAD of each initialized submodule, the SHA-256 of its index, and its working-file bytes.
const submoduleFacts = (sup: string) =>
  Object.fromEntries(SUBMODULES.filter((n) => existsSync(join(sup, n, ".git"))).map((n) => [n, { head: headOf(join(sup, n)), index: rawIndexDigest(gitPath(), join(sup, n)), files: workingFileDigests(join(sup, n)) }]));

const callsOf = (service: Service, operationId: string) => service.runner.calls.filter((c) => c.operationId === operationId);
const updatesOf = (service: Service, operationId: string) =>
  callsOf(service, operationId)
    .filter((c) => subcommand(c.arguments) === "update-index")
    .map((c) => ({ args: [...c.arguments], input: Buffer.from(c.input ?? new Uint8Array()).toString("latin1") }));
const forbiddenOf = (service: Service, operationId: string) =>
  callsOf(service, operationId)
    .filter((c) => FORBIDDEN.includes(subcommand(c.arguments) ?? "") || c.arguments.includes("--filters"))
    .map((c) => c.arguments);
const applyFile = (service: Service, repositoryId: string, c: Comparison, direction: "stage" | "unstage") =>
  service.request("applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction }, { repositoryId, repositoryGeneration: c.read.generation });
const applyFiles = (service: Service, repositoryId: string, read: WorkspaceResult, ids: readonly string[]) =>
  service.response(service.send("applyFiles", { snapshotId: read.snapshotId, entryIds: ids, direction: "stage", kind: "all-changes" }, { repositoryId }), T118_MS);
const changesOf = (read: WorkspaceResult) => read.entries.filter((e) => e.category === "unstaged" || e.category === "untracked");
const refusal = (response: { code?: string; result?: unknown }) => ({ code: response.code, reason: (response.result as { reason?: string } | undefined)?.reason });

describe("T118 Stage file and Unstage file of a moved gitlink (plan.md D20, contract Δ4)", () => {
  caseTest(T118, `SC-013: Stage file of a submodule moved one commit equals git add -- sub, and Unstage file equals git restore --staged -- sub; each runs one update-index --index-info with the 160000 line`, SHELL, () =>
    withService({ name: "t118-file" }, async (service) => {
      const sup = world();
      const subs = submoduleFacts(sup);
      const files = workingFileDigests(sup);
      const head = subs.sub!.head;
      const recorded = gitText(sup, ["rev-parse", "HEAD:sub"]).trim();
      const { repositoryId } = await service.register(sup);

      const added = oracle(sup, ["--literal-pathspecs", "add", "--", "sub"]);
      const c = await compare(service, repositoryId, "sub", "unstaged");
      expect({ ...outcome(c.response), parsed: ReadComparisonResult.safeParse(c.response.result).success }).toEqual({ ...SUCCEEDED, parsed: true });
      expect({ fileAction: one(c.response.result, "fileAction"), gitlink: one(c.response.result, "gitlink") }).toEqual({ fileAction: "stage", gitlink: { oid: head } });
      const staged = await applyFile(service, repositoryId, c, "stage");
      expect(outcome(staged)).toEqual(SUCCEEDED);
      expect(listing(sup)).toBe(added);
      expect(updatesOf(service, staged.operationId!)).toEqual([{ args: INDEX_INFO, input: `160000 ${head}\tsub\0` }]);
      expect(forbiddenOf(service, staged.operationId!)).toEqual([]);

      const restored = oracle(sup, ["--literal-pathspecs", "restore", "--staged", "--", "sub"]);
      const u = await compare(service, repositoryId, "sub", "staged");
      expect({ ...outcome(u.response), fileAction: one(u.response.result, "fileAction"), gitlink: valuesOf(u.response.result, "gitlink") }).toEqual({ ...SUCCEEDED, fileAction: "unstage", gitlink: [] });
      const unstaged = await applyFile(service, repositoryId, u, "unstage");
      expect(outcome(unstaged)).toEqual(SUCCEEDED);
      expect(listing(sup)).toBe(restored);
      expect(updatesOf(service, unstaged.operationId!)).toEqual([{ args: INDEX_INFO, input: `160000 ${recorded}\tsub\0` }]);

      expect(submoduleFacts(sup)).toEqual(subs);
      expect(workingFileDigests(sup)).toEqual(files);
      expect(candidateFiles(sup)).toEqual([]);
    }),
    T118_MS,
  );

  caseTest(T118, `FR-079: a commit inside the submodule between readComparison and the step 7 checkpoint gives STALE_SELECTION, and the index SHA-256 stays`, SHELL, async () => {
    const sup = world();
    let moved = "";
    let after: ReturnType<typeof submoduleFacts> = {};
    let files: Record<string, string> = {};
    // The observer point 5 comes after the Git step and before the step 7 checkpoint (hunk-publish.ts `HunkCheckpoint`).
    const hunkCheckpoint = ({ step }: HunkCheckpoint) => {
      if (step !== 5 || moved !== "") return;
      moved = commitIn(join(sup, "sub"), "h.txt", "three\n");
      after = submoduleFacts(sup);
      files = workingFileDigests(sup);
    };
    await withService({ name: "t118-stale", hunkCheckpoint }, async (service) => {
      const { repositoryId } = await service.register(sup);
      const index = rawIndexDigest(gitPath(), sup);
      const before = listing(sup);
      const c = await compare(service, repositoryId, "sub", "unstaged");
      expect(one(c.response.result, "fileAction")).toBe("stage");
      const response = await applyFile(service, repositoryId, c, "stage");
      expect({ moved: moved !== "" && moved !== (one(c.response.result, "gitlink") as { oid: string }).oid, code: response.code }).toEqual({ moved: true, code: "STALE_SELECTION" });
      expect({ index: rawIndexDigest(gitPath(), sup), listing: listing(sup) }).toEqual({ index, listing: before });
      expect(submoduleFacts(sup)).toEqual(after);
      expect(workingFileDigests(sup)).toEqual(files);
      expect(candidateFiles(sup)).toEqual([]);
    });
  }, T118_MS);

  caseTest(T118, `FR-078: an unborn submodule HEAD gives submodule-unborn, and applyFile starts no update-index`, SHELL, () =>
    withService({ name: "t118-unborn" }, async (service) => {
      const sup = world();
      const { repositoryId } = await service.register(sup);
      const read = await readOk(service, repositoryId);
      // T118 probe on Git 2.56.0.windows.2: the parent status lists no record for a submodule with an unborn HEAD, so the HEAD goes unborn after the read.
      git(join(sup, "sub"), ["checkout", "-q", "--orphan", "fresh"]);
      const subs = submoduleFacts(sup);
      const files = workingFileDigests(sup);
      const index = rawIndexDigest(gitPath(), sup);
      const c = await compare(service, repositoryId, "sub", "unstaged", read);
      expect({ ...outcome(c.response), fileAction: one(c.response.result, "fileAction"), gitlink: valuesOf(c.response.result, "gitlink"), remedy: one(c.response.result, "remedy") }).toEqual({ ...SUCCEEDED, fileAction: "submodule-unborn", gitlink: [], remedy: null });
      const response = await applyFile(service, repositoryId, c, "stage");
      expect(refusal(response)).toEqual({ code: "UNSUPPORTED_COMPARISON", reason: "submodule-unborn" });
      expect(updatesOf(service, response.operationId!)).toEqual([]);
      expect({ index: rawIndexDigest(gitPath(), sup), subs: submoduleFacts(sup), files: workingFileDigests(sup) }).toEqual({ index, subs, files });
    }),
    T118_MS,
  );
});

describe("T118 Stage all changes with a moved gitlink (spec FR-081, 004 contract Δ4)", () => {
  caseTest(T118, `SC-013: Stage all changes with a moved gitlink, a modified file, and no entry for a submodule with only local edits equals git add -A; the gitlink line takes a second update-index step`, SHELL, () =>
    withService({ name: "t118-all" }, async (service) => {
      const sup = world();
      writeFileSync(join(sup, "s.txt"), "changed\n");
      writeFileSync(join(sup, "edit", "f.txt"), "edited\n");
      writeFileSync(join(sup, "edit", "u.txt"), "untracked\n");
      const subs = submoduleFacts(sup);
      const files = workingFileDigests(sup);
      const expected = oracle(sup, ["add", "-A"]);
      const { repositoryId } = await service.register(sup);
      const read = await readOk(service, repositoryId);
      const changes = changesOf(read);
      expect(changes.map((e) => `${e.category} ${e.path}`).sort()).toEqual(["unstaged s.txt", "unstaged sub"]);
      const response = await applyFiles(service, repositoryId, read, changes.map((e) => e.entryId));
      expect(outcome(response)).toEqual(SUCCEEDED);
      expect(listing(sup)).toBe(expected);
      expect(updatesOf(service, response.operationId!)).toEqual([
        { args: ADD_STDIN, input: "s.txt\0" },
        { args: INDEX_INFO, input: `160000 ${subs.sub!.head}\tsub\0` },
      ]);
      expect(submoduleFacts(sup)).toEqual(subs);
      expect(workingFileDigests(sup)).toEqual(files);
      expect(candidateFiles(sup)).toEqual([]);
    }),
    T118_MS,
  );

  caseTest(T118, `FR-081: a set with a deleted gitlink refuses as a whole with reason submodule, names that entry, and keeps the index SHA-256`, SHELL, () =>
    withService({ name: "t118-gone" }, async (service) => {
      const sup = world();
      writeFileSync(join(sup, "s.txt"), "changed\n");
      rmSync(join(sup, "gone"), { recursive: true, force: true });
      const subs = submoduleFacts(sup);
      const files = workingFileDigests(sup);
      const index = rawIndexDigest(gitPath(), sup);
      const { repositoryId } = await service.register(sup);
      const read = await readOk(service, repositoryId);
      const changes = changesOf(read);
      expect(changes.map((e) => `${e.category} ${e.path}`).sort()).toEqual(["unstaged gone", "unstaged s.txt", "unstaged sub"]);
      const response = await applyFiles(service, repositoryId, read, changes.map((e) => e.entryId));
      expect({ ...refusal(response), entryId: (response.result as { entryId?: string } | undefined)?.entryId }).toEqual({ code: "UNSUPPORTED_COMPARISON", reason: "submodule", entryId: changes.find((e) => e.path === "gone")!.entryId });
      expect(updatesOf(service, response.operationId!)).toEqual([]);
      expect({ index: rawIndexDigest(gitPath(), sup), subs: submoduleFacts(sup), files: workingFileDigests(sup) }).toEqual({ index, subs, files });
    }),
    T118_MS,
  );
});
