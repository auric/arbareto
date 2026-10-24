// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T021: feature 005 contract Δ3 `readCommitChanges` and `readCommitFile` through the in-process service (plan.md P4, D2, D3).
// Quickstart.md Q4, Q5, Q7, Q8. Spec FR-002, FR-003, FR-006, FR-008 to FR-012, SC-001, SC-002. The oracle is Git's own diff-tree on a second build.

import { describe, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ReadCommitChangesResult, ReadCommitFileResult } from "../../src/contracts/envelope";
import { COMMIT_CHANGES_RESULT_BYTES, GIT_PROCESS_DEADLINE_MS, STATUS_LISTING_RECORDS } from "../../src/contracts/limits";
import { OBJECT_MISSING_REMEDY } from "../../src/git-service/status";
import { printOrigin } from "../origin";
import { once, siblingDeadline } from "./service-harness";
import { FIXTURE_ROOT, fixturePath, serviceEnv, useFixtureRoot } from "./fixture-root";
import {
  buildHistory,
  buildPartialClone,
  buildPatchBounds,
  buildShallowHistory,
  buildWide,
  copyRepo,
  EMPTY_TREE,
  GITLINK_1,
  GITLINK_2,
  HISTORY_LABELS,
  runGit,
  WIDE_FILES,
  wideLarge,
} from "./history-diff-fixtures";
import { fits, gitPath, load, waitFor } from "./history-view-harness";
import { caseTest, openService, type Service, type ServiceResponse } from "./service-harness";
import { canary } from "./workbench-fixtures";

printOrigin("../../src/git-service/commit-changes.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);
printOrigin("../../src/git-service/history-view.ts", import.meta.dir);

useFixtureRoot();

const TASK = "T021";
const SHELL = ["shell-double"] as const;
const TIMEOUT_MS = 300_000;
const LARGE_TIMEOUT_MS = 20 * 60_000;
// A `siblingDeadline` case that never releases its target ends here, not at the read timeout.
const SIBLING_TIMEOUT_MS = 120_000;
const READ = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
const STATUS: Record<string, string> = { A: "added", D: "deleted", M: "modified", R: "renamed", T: "type-changed" };

interface FileEntry {
  fileId: number;
  status: string;
  score?: number;
  pathBytes: string;
  oldPathBytes?: string;
  kind: "file" | "link" | "submodule";
}
interface Changes {
  changesId: string;
  viewId: string;
  oid: string;
  parents: string[];
  base: { kind: "parent"; index: number; oid: string } | { kind: "empty-tree"; oid: string } | { kind: "shallow" };
  files: FileEntry[];
  completeness: { state: "complete" } | { state: "limited"; code: string; reason: string; shown: number };
  remedy?: { text: string };
}
interface CommitFile {
  changesId: string;
  fileId: number;
  facts: { rename?: { oldPath: string; score: number }; mode?: { old: string; new: string }; submodule?: { old: string | null; new: string | null }; typeChange?: { old: string; new: string } };
  binary: boolean;
  patch: string | null;
  completeness: { state: string; code?: string; reason?: string };
  remedy?: { text: string };
}

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
const git = (repo: string, args: string[], options: { input?: Uint8Array; env?: Record<string, string | undefined> } = {}) => runGit(gitPath(), FIXTURE_ROOT, repo, args, options);
const text = (repo: string, args: string[]) => git(repo, args).toString("utf8");

async function withService(name: string, body: (service: Service) => Promise<void>): Promise<void> {
  const service = await openService({ git: gitPath(), name, watchHints: false, environment: serviceEnv({ GIT_CONFIG_NOSYSTEM: "1" }) });
  try {
    await body(service);
  } finally {
    await service.dispose();
  }
}

interface Viewed {
  repositoryId: string;
  repositoryGeneration: number;
  viewId: string;
}

// Registers `repo`, opens a view of all refs, and loads every row, so each commit has its row (contract Δ3 target).
async function viewOf(service: Service, repo: string): Promise<Viewed> {
  const { repositoryId, generation } = await service.register(repo);
  const opened = await service.request<{ viewId: string }>("openHistory", { scope: "all" }, { repositoryId, repositoryGeneration: generation });
  expect(opened.state).toBe("succeeded");
  const viewId = opened.result!.viewId;
  expect((await load(service, repositoryId, viewId, { end: true })).state).toBe("succeeded");
  return { repositoryId, repositoryGeneration: generation, viewId };
}

const readChanges = (service: Service, v: Viewed, oid: string, parent = 0, viewId = v.viewId) =>
  service.request<Changes>("readCommitChanges", { viewId, oid, parent }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });
const readFile = (service: Service, v: Viewed, changesId: string, fileId: number) =>
  service.request<CommitFile>("readCommitFile", { changesId, fileId }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });

// diff-format(5) raw `-z` records of Git's own listing, as data-model §1 entries.
function oracle(repo: string, base: string, oid: string): Omit<FileEntry, "fileId">[] {
  const out = git(repo, [...READ, "diff-tree", "-r", "-z", "--raw", "-M", "-l1000", base, oid]);
  const parts: Buffer[] = [];
  for (let at = 0; at < out.length; ) {
    const nul = out.indexOf(0, at);
    parts.push(out.subarray(at, nul));
    at = nul + 1;
  }
  const entries: Omit<FileEntry, "fileId">[] = [];
  for (let i = 0; i < parts.length; ) {
    const [modeA, modeB, , , status] = parts[i]!.toString("latin1").slice(1).split(" ") as [string, string, string, string, string];
    const two = status.startsWith("R");
    const paths = parts.slice(i + 1, i + (two ? 3 : 2));
    const kind = [modeA, modeB].includes("160000") ? "submodule" : [modeA, modeB].includes("120000") ? "link" : "file";
    entries.push({ status: STATUS[status[0]!]!, ...(two ? { score: Number(status.slice(1)) } : {}), pathBytes: b64(paths.at(-1)!), ...(two ? { oldPathBytes: b64(paths[0]!) } : {}), kind });
    i += two ? 3 : 2;
  }
  return entries;
}

const parentsOf = (repo: string, oid: string) => text(repo, ["rev-list", "--parents", "-n", "1", oid]).trim().split(" ").slice(1);
const withoutIds = (files: FileEntry[]) => files.map(({ fileId: _id, ...rest }) => rest);
const isDiffTree = (call: { arguments: readonly string[] }) => call.arguments.includes("diff-tree");

describe("readCommitChanges (contract Δ3, plan.md D3)", () => {
  caseTest(TASK, "every History fixture commit and every parent equals git diff-tree -r -z --raw -M -l1000 on a copy, with the base and the parents of the view", SHELL, () =>
    withService("t021-lists", async (service) => {
      const built = buildHistory(gitPath(), "t021-lists");
      const copy = buildHistory(gitPath(), "t021-lists-copy").repo;
      const v = await viewOf(service, built.repo);
      for (const label of HISTORY_LABELS) {
        const oid = built.oids[label]!;
        const parents = parentsOf(copy, oid);
        for (let parent = 0; parent < Math.max(1, parents.length); parent++) {
          const response = await readChanges(service, v, oid, parent);
          fits(ReadCommitChangesResult, response.result);
          const base = parents.length === 0 ? EMPTY_TREE.sha1 : parents[parent]!;
          expect({ label, parent, state: response.state, files: withoutIds(response.result!.files) }).toEqual({ label, parent, state: "succeeded", files: oracle(copy, base, oid) });
          expect(response.result!.files.map((f) => f.fileId)).toEqual(response.result!.files.map((_, i) => i));
          expect(response.result!.parents).toEqual(parents);
          expect(response.result!.base).toEqual(parents.length === 0 ? { kind: "empty-tree", oid: EMPTY_TREE.sha1 } : { kind: "parent", index: parent, oid: parents[parent] });
          expect(response.result!.completeness).toEqual({ state: "complete" });
        }
      }
      // Every diff-tree array starts with the read options (contract Δ3) and names the base and the commit.
      const listings = service.runner.calls.filter(isDiffTree);
      expect(listings.length).toBeGreaterThan(0);
      expect(listings.every((c) => READ.every((o, i) => c.arguments[i] === o))).toBe(true);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "the 1,000-file commit equals Git's listing (SC-001)", SHELL, () =>
    withService("t021-wide", async (service) => {
      const built = buildWide(gitPath(), "t021-wide");
      const v = await viewOf(service, built.repo);
      const response = await readChanges(service, v, built.oids.wide!);
      expect(response.state).toBe("succeeded");
      expect(withoutIds(response.result!.files)).toEqual(oracle(buildWide(gitPath(), "t021-wide-copy").repo, built.oids.base!, built.oids.wide!));
      expect(response.result!.files).toHaveLength(1000);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a parent index at or above the parent count gives INVALID_REQUEST; another view, a released view, and an unknown OID give UNKNOWN_TARGET", SHELL, () =>
    withService("t021-targets", async (service) => {
      const built = buildHistory(gitPath(), "t021-targets");
      const v = await viewOf(service, built.repo);
      const calls = service.runner.calls.length;
      expect((await readChanges(service, v, built.oids.merge2!, 2)).code).toBe("INVALID_REQUEST");
      expect((await readChanges(service, v, built.oids.normal!, 1)).code).toBe("INVALID_REQUEST");
      expect((await readChanges(service, v, built.oids.root!, 1)).code).toBe("INVALID_REQUEST");
      expect((await readChanges(service, v, "f".repeat(40))).code).toBe("UNKNOWN_TARGET");
      expect((await readChanges(service, v, built.oids.normal!, 0, crypto.randomUUID())).code).toBe("UNKNOWN_TARGET");
      expect(service.runner.calls.length).toBe(calls);
      const old = v.viewId;
      const second = await service.request<{ viewId: string }>("openHistory", { scope: "all" }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });
      await load(service, v.repositoryId, second.result!.viewId, { end: true });
      expect((await readChanges(service, v, built.oids.normal!, 0, old)).code).toBe("UNKNOWN_TARGET");
      await service.request("closeHistory", { viewId: second.result!.viewId }, { repositoryId: v.repositoryId });
      expect((await readChanges(service, v, built.oids.normal!, 0, second.result!.viewId)).code).toBe("UNKNOWN_TARGET");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a root commit compares with the empty tree in SHA-1 and in SHA-256", SHELL, () =>
    withService("t021-root", async (service) => {
      for (const format of ["sha1", "sha256"] as const) {
        const built = buildHistory(gitPath(), `t021-root-${format}`, format);
        const v = await viewOf(service, built.repo);
        const response = await readChanges(service, v, built.oids.root!);
        expect({ format, state: response.state, base: response.result!.base }).toEqual({ format, state: "succeeded", base: { kind: "empty-tree", oid: EMPTY_TREE[format] } });
        expect(withoutIds(response.result!.files)).toEqual(oracle(built.repo, EMPTY_TREE[format], built.oids.root!));
        expect(response.result!.files.every((f) => f.status === "added")).toBe(true);
        const normal = await readChanges(service, v, built.oids.normal!);
        expect(withoutIds(normal.result!.files)).toEqual(oracle(built.repo, built.oids.root!, built.oids.normal!));
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a commit whose parent is not in a shallow clone gives base shallow, no file, and no Git process", SHELL, () =>
    withService("t021-shallow", async (service) => {
      const source = buildHistory(gitPath(), "t021-shallow-source");
      const repo = buildShallowHistory(gitPath(), source, "t021-shallow");
      const v = await viewOf(service, repo);
      const calls = service.runner.calls.length;
      const response = await readChanges(service, v, source.oids.merge3!);
      expect({ state: response.state, base: response.result!.base, files: response.result!.files, parents: response.result!.parents }).toEqual({ state: "succeeded", base: { kind: "shallow" }, files: [], parents: [] });
      expect(service.runner.calls.length).toBe(calls);
      // A shallow listing has no file, so every fileId is outside it.
      expect((await readFile(service, v, response.result!.changesId, 0)).code).toBe("INVALID_REQUEST");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a new readCommitChanges and a released view drop the older changesId", SHELL, () =>
    withService("t021-retained", async (service) => {
      const built = buildHistory(gitPath(), "t021-retained");
      const v = await viewOf(service, built.repo);
      const first = (await readChanges(service, v, built.oids.normal!)).result!;
      expect((await readFile(service, v, first.changesId, 0)).state).toBe("succeeded");
      const second = (await readChanges(service, v, built.oids.rename!)).result!;
      expect((await readFile(service, v, first.changesId, 0)).code).toBe("UNKNOWN_TARGET");
      expect((await readFile(service, v, second.changesId, second.files.length)).code).toBe("INVALID_REQUEST");
      await service.request("closeHistory", { viewId: v.viewId }, { repositoryId: v.repositoryId });
      expect((await readFile(service, v, second.changesId, 0)).code).toBe("UNKNOWN_TARGET");
    }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the 100,001-file commit gives exactly the first whole records up to the bound, limited, and shown (SC-002)",
    SHELL,
    () =>
      withService("t021-large", async (service) => {
        const cached = wideLarge(gitPath());
        const repo = copyRepo(cached.repo, "t021-large-repo");
        const v = await viewOf(service, repo);
        const response = await readChanges(service, v, cached.oids.wide!);
        const result = response.result!;
        expect(response.state).toBe("limited");
        expect(response.code).toBe("OUTPUT_LIMIT");
        if (result.completeness.state !== "limited") throw new Error("expected a limited listing");
        const { reason, shown } = result.completeness;
        expect(shown).toBe(result.files.length);
        expect(shown).toBeLessThan(WIDE_FILES);
        expect(shown).toBeLessThanOrEqual(STATUS_LISTING_RECORDS);
        expect(["STATUS_LISTING_RECORDS", "COMMIT_CHANGES_RESULT_BYTES"]).toContain(reason);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(COMMIT_CHANGES_RESULT_BYTES);
        // One more record would pass the reached bound.
        if (reason === "COMMIT_CHANGES_RESULT_BYTES") expect(Buffer.byteLength(JSON.stringify({ ...result, files: [...result.files, { ...result.files.at(-1)!, fileId: shown }] }))).toBeGreaterThan(COMMIT_CHANGES_RESULT_BYTES);
        expect(withoutIds(result.files)).toEqual(oracle(repo, cached.oids.base!, cached.oids.wide!).slice(0, shown));
      }),
    LARGE_TIMEOUT_MS,
  );
});

describe("readCommitFile (contract Δ3, plan.md D3)", () => {
  caseTest(TASK, "each patch equals Git's patch for the path pair; the facts, the binary state, and the submodule entry come from the listing", SHELL, () =>
    withService("t021-files", async (service) => {
      const built = buildHistory(gitPath(), "t021-files");
      const copy = buildHistory(gitPath(), "t021-files-copy").repo;
      const v = await viewOf(service, built.repo);
      const patchArgs = [...READ, "diff-tree", "-p", "--no-textconv", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=dirty", "-M", "-l1000"];
      const seen = new Set<string>();
      for (const label of ["root", "normal", "rename", "mode", "binary", "submodule", "typechange", "filedir", "merge2"] as const) {
        const oid = built.oids[label]!;
        const changes = (await readChanges(service, v, oid)).result!;
        const base = changes.base.kind === "shallow" ? "" : changes.base.oid;
        for (const entry of changes.files) {
          const path = Buffer.from(entry.pathBytes, "base64").toString("utf8");
          const old = entry.oldPathBytes === undefined ? null : Buffer.from(entry.oldPathBytes, "base64").toString("utf8");
          const before = service.runner.calls.length;
          const response = await readFile(service, v, changes.changesId, entry.fileId);
          fits(ReadCommitFileResult, response.result);
          const file = response.result!;
          const where = { label, path };
          expect({ ...where, state: response.state }).toEqual({ ...where, state: "succeeded" });
          // Plan.md D3: a submodule row passes the read gate and runs no Git read.
          if (entry.kind === "submodule") {
            expect(service.runner.calls.slice(before).filter(isDiffTree)).toEqual([]);
            seen.add("submodule");
            continue;
          }
          const calls = service.runner.calls.slice(before).filter(isDiffTree);
          expect(calls).toHaveLength(2);
          for (const c of calls) {
            expect(READ.every((o, i) => c.arguments[i] === o)).toBe(true);
            expect(c.arguments.slice(c.arguments.indexOf("--") + 1)).toEqual(old === null ? [path] : [path, old]);
          }
          const gitPatch = git(copy, [...patchArgs, base, oid, "--", ...(old === null ? [path] : [path, old])]);
          // Plan.md D3 step 5: the pathspec `a` also matches `a/x`, so the expected patch is the section of `a` only.
          const own = path === "a" && label === "filedir" ? gitPatch.subarray(0, gitPatch.indexOf("\ndiff --git a/a/x") + 1) : gitPatch;
          if (entry.status === "type-changed") {
            expect({ ...where, patch: file.patch, typeChange: file.facts.typeChange }).toEqual({ ...where, patch: null, typeChange: { old: "file", new: "link" } });
            seen.add("type-change");
          } else if (path === "bin.dat") {
            expect({ ...where, binary: file.binary, patch: file.patch }).toEqual({ ...where, binary: true, patch: null });
            seen.add("binary");
          } else if (entry.status === "modified" && path === "mode.sh") {
            expect({ ...where, mode: file.facts.mode, patch: file.patch }).toEqual({ ...where, mode: { old: "100644", new: "100755" }, patch: null });
            seen.add("mode");
          } else {
            expect({ ...where, binary: file.binary, patch: file.patch === null ? null : Buffer.from(file.patch, "base64").toString("latin1") }).toEqual({ ...where, binary: false, patch: own.toString("latin1") });
            if (entry.status === "renamed") {
              expect(file.facts.rename).toEqual({ oldPath: entry.oldPathBytes!, score: 92 });
              seen.add("rename");
            }
            if (path === "a") seen.add("folder");
          }
          expect(file.completeness).toEqual({ state: "complete" });
        }
      }
      expect([...seen].toSorted()).toEqual(["binary", "folder", "mode", "rename", "submodule", "type-change"]);
      const sub = (await readChanges(service, v, built.oids.submodule!)).result!;
      const lib = await readFile(service, v, sub.changesId, 0);
      expect(lib.result!.facts.submodule).toEqual({ old: GITLINK_1, new: GITLINK_2 });
      expect(lib.result!.patch).toBeNull();
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a missing, extra, or foreign section in Git's patch or numstat gives MALFORMED_GIT_OUTPUT", SHELL, () =>
    withService("t021-sections", async (service) => {
      const built = buildHistory(gitPath(), "t021-sections");
      const v = await viewOf(service, built.repo);
      const changes = (await readChanges(service, v, built.oids.normal!)).result!;
      const entry = changes.files.find((f) => Buffer.from(f.pathBytes, "base64").toString() === "a.txt")!;
      const real = git(built.repo, [...READ, "diff-tree", "-p", "--no-textconv", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=dirty", "-M", "-l1000", built.oids.root!, built.oids.normal!, "--", "added.txt"]);
      const patchCall = (c: { arguments: readonly string[] }) => isDiffTree(c) && c.arguments.includes("-p");
      const numstatCall = (c: { arguments: readonly string[] }) => isDiffTree(c) && c.arguments.includes("--numstat");
      const outcomes: Record<string, string | undefined> = {};
      for (const [name, match, bytes] of [
        ["missing patch section", patchCall, new Uint8Array()],
        ["foreign patch section", patchCall, real],
        ["extra numstat record", numstatCall, Buffer.from("1\t0\ta.txt\x001\t0\tadded.txt\0")],
        ["missing numstat record", numstatCall, new Uint8Array()],
      ] as const) {
        service.runner.inject.stdout = (call) => (match(call) ? bytes : undefined);
        outcomes[name] = (await readFile(service, v, changes.changesId, entry.fileId)).code;
      }
      service.runner.inject.stdout = undefined;
      expect(outcomes).toEqual({ "missing patch section": "MALFORMED_GIT_OUTPUT", "foreign patch section": "MALFORMED_GIT_OUTPUT", "extra numstat record": "MALFORMED_GIT_OUTPUT", "missing numstat record": "MALFORMED_GIT_OUTPUT" });
      expect((await readFile(service, v, changes.changesId, entry.fileId)).state).toBe("succeeded");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "the 001 diff bounds give the limited result", SHELL, () =>
    withService("t021-bounds", async (service) => {
      const built = buildPatchBounds(gitPath(), "t021-bounds");
      const v = await viewOf(service, built.repo);
      for (const [label, reason] of [["lines", "CANONICAL_DIFF_LINES"], ["bytes", "CANONICAL_DIFF_BYTES"]] as const) {
        const changes = (await readChanges(service, v, built.oids[label]!)).result!;
        const response = await readFile(service, v, changes.changesId, 0);
        fits(ReadCommitFileResult, response.result);
        expect({ label, state: response.state, code: response.code, completeness: response.result!.completeness, patch: response.result!.patch }).toEqual({ label, state: "limited", code: "OUTPUT_LIMIT", completeness: { state: "limited", code: "OUTPUT_LIMIT", reason }, patch: null });
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a missing blob in a partial clone gives OBJECT_MISSING with the 001 remedy and fetches nothing (FR-011)", SHELL, () =>
    withService("t021-partial", async (service) => {
      const source = buildHistory(gitPath(), "t021-partial-source");
      const repo = buildPartialClone(gitPath(), source, "t021-partial");
      const v = await viewOf(service, repo);
      // `binary` changes one file and adds none, so the listing needs no blob for rename detection.
      const changes = await readChanges(service, v, source.oids.binary!);
      expect(changes.state).toBe("succeeded");
      const entry = changes.result!.files.find((f) => Buffer.from(f.pathBytes, "base64").toString() === "bin.dat")!;
      const response = await readFile(service, v, changes.result!.changesId, entry.fileId);
      fits(ReadCommitFileResult, response.result);
      expect({ state: response.state, code: response.code, completeness: response.result!.completeness, remedy: response.result!.remedy, patch: response.result!.patch }).toEqual({
        state: "limited",
        code: "OBJECT_MISSING",
        completeness: { state: "limited", code: "OBJECT_MISSING" },
        remedy: { text: OBJECT_MISSING_REMEDY },
        patch: null,
      });
      const blob = text(source.repo, ["rev-parse", `${source.oids.binary}:bin.dat`]).trim();
      expect(git(repo, ["--no-lazy-fetch", "cat-file", "--batch-check"], { input: Buffer.from(`${blob}\n`) }).toString()).toBe(`${blob} missing\n`);
      expect(service.runner.calls.filter((c) => c.contextKind === "registeredOperation").every((c) => c.arguments[0] === "--no-lazy-fetch")).toBe(true);
    }),
    TIMEOUT_MS,
  );
});

describe("sibling steps and refused reads", () => {
  caseTest(TASK, "a refused numstat step ends the read only after the patch process of the same read ended", SHELL, () =>
    withService("t021-sibling", async (service) => {
      const built = buildHistory(gitPath(), "t021-sibling");
      const v = await viewOf(service, built.repo);
      const changes = (await readChanges(service, v, built.oids.normal!)).result!;
      const entry = changes.files.find((f) => Buffer.from(f.pathBytes, "base64").toString() === "a.txt")!;
      service.runner.inject.refuse = (call) => (isDiffTree(call) && call.arguments.includes("--numstat") ? "INVALID_REQUEST" : undefined);
      const response = await readFile(service, v, changes.changesId, entry.fileId);
      service.runner.inject.refuse = undefined;
      expect({ state: response.state, code: response.code }).toEqual({ state: "failed", code: "INVALID_REQUEST" });
      const patch = service.runner.calls.filter((c) => isDiffTree(c) && c.arguments.includes("-p")).at(-1)!;
      expect(patch.exit).toBeDefined();
      expect(service.runner.liveRecorded()).toBe(0);
    }),
    TIMEOUT_MS,
  );

  // T399 guard, 001 contract §5 "Deadline outcomes": the deadline closes the operation Job, so the patch step ends with `exitCode` null and no `deadline`.
  caseTest("T399", "readCommitFile gives DEADLINE when the numstat step expires and the Job close ends the patch step first", SHELL, () =>
    withService("t399-commit-file", async (service) => {
      const built = buildHistory(gitPath(), "t399-commit-file");
      const v = await viewOf(service, built.repo);
      const changes = (await readChanges(service, v, built.oids.normal!)).result!;
      const entry = changes.files.find((f) => Buffer.from(f.pathBytes, "base64").toString() === "a.txt")!;
      const isNumstat = (call: { arguments: readonly string[] }) => isDiffTree(call) && call.arguments.includes("--numstat");
      const isPatch = (call: { arguments: readonly string[] }) => isDiffTree(call) && call.arguments.includes("-p");
      const before = service.runner.calls.length;
      const release = siblingDeadline(service, isNumstat, isPatch);
      const response = await readFile(service, v, changes.changesId, entry.fileId).finally(release);
      const exits = service.runner.calls.slice(before).filter(isDiffTree).map(({ exit }) => exit?.deadline ?? (exit?.exitCode === null ? "closed" : String(exit?.exitCode)));
      console.log(`OBSERVATION T399: commit file diff-tree exits=${exits.join(",")} state=${response.state} code=${response.code}`);
      expect({ exits: exits.toSorted(), state: response.state, code: response.code }).toEqual({ exits: ["closed", "deadline"], state: "failed", code: "DEADLINE" });
    }),
    SIBLING_TIMEOUT_MS,
  );

  caseTest(TASK, "a readCommitChanges that gets BUSY keeps the retained listing of the view", SHELL, () =>
    withService("t021-busy", async (service) => {
      const built = buildHistory(gitPath(), "t021-busy");
      const v = await viewOf(service, built.repo);
      const kept = (await readChanges(service, v, built.oids.normal!)).result!;
      // Contract §5: two running reads of the workspace and eight waiting reads fill every slot.
      const release = service.runner.pauseStdout((c) => c.arguments.includes("config") && c.arguments.includes("list"));
      const held: string[] = [];
      try {
        for (let i = 0; i < 10; i++) held.push(service.send("readTrust", {}, { repositoryId: v.repositoryId }));
        await waitFor("two held listings", () => service.runner.calls.filter((c) => c.arguments.includes("config") && c.arguments.includes("list") && c.exit === undefined).length >= 2);
        expect((await readChanges(service, v, built.oids.rename!)).code).toBe("BUSY");
      } finally {
        release();
      }
      for (const id of held) await service.response(id);
      expect((await readFile(service, v, kept.changesId, 0)).state).toBe("succeeded");
    }),
    TIMEOUT_MS,
  );
});

describe("read gate, Cancel, and the deadline (contract Δ3, Δ7, plan.md D2)", () => {
  caseTest(TASK, "in an untrusted repository with a command-valued core.fsmonitor, both reads give TRUST_REQUIRED and the canary stays absent until approval (FR-003)", SHELL, () =>
    withService("t021-gate", async (service) => {
      const built = buildHistory(gitPath(), "t021-gate");
      const v = await viewOf(service, built.repo);
      // The `submodule` listing holds only the submodule row `lib`: the read gate refuses it too (plan.md D3 step 1).
      const ready = (await readChanges(service, v, built.oids.submodule!)).result!;
      expect(ready.files.map((f) => f.kind)).toEqual(["submodule"]);
      const c = canary(fixturePath("t021-gate"), "fsmonitor");
      git(built.repo, ["config", "core.fsmonitor", c.command]);
      const before = service.runner.calls.length;
      // `readFile` first: a new readCommitChanges drops the older listing (contract Δ8).
      expect((await readFile(service, v, ready.changesId, 0)).code).toBe("TRUST_REQUIRED");
      expect((await readChanges(service, v, built.oids.rename!)).code).toBe("TRUST_REQUIRED");
      expect(service.runner.calls.slice(before).filter(isDiffTree)).toEqual([]);
      expect(existsSync(c.log)).toBe(false);
      expect((await service.approveTrust(v.repositoryId, "read")).state).toBe("succeeded");
      expect((await readChanges(service, v, built.oids.rename!)).state).toBe("succeeded");
      expect(existsSync(c.log) && readFileSync(c.log, "utf8").length > 0).toBe(true);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "Cancel ends the Job of the listing, and each diff-tree process runs under the 30-second deadline", SHELL, () =>
    withService("t021-cancel", async (service) => {
      const built = buildHistory(gitPath(), "t021-cancel");
      const v = await viewOf(service, built.repo);
      const release = service.runner.pauseStdout(once(isDiffTree));
      try {
        const request = service.send("readCommitChanges", { viewId: v.viewId, oid: built.oids.normal!, parent: 0 }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });
        await waitFor("diff-tree call", () => service.runner.calls.some(isDiffTree));
        await service.cancel(await service.operationId(request));
        const response: ServiceResponse = await service.response(request);
        expect(response.state).toBe("canceled");
      } finally {
        release();
      }
      await waitFor("no live process", () => service.runner.liveRecorded() === 0, 10_000);
      const ok = (await readChanges(service, v, built.oids.normal!)).result!;
      await readFile(service, v, ok.changesId, 0);
      expect(service.runner.calls.filter(isDiffTree).every((c) => c.limits?.deadlineMs === GIT_PROCESS_DEADLINE_MS)).toBe(true);
    }),
    TIMEOUT_MS,
  );
});
