// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T025: line staging through `applyHunk` with `lines` (spec FR-041 to FR-044, SC-006, contract Δ4, data-model §6, quickstart.md Q16).
// The expected index content comes from the research.md R11 line rule on the hunk text, never from `src/git-service/`.

import { describe, expect } from "bun:test";
import { printOrigin } from "../origin";
import { useFixtureRoot } from "./fixture-root";
import { put } from "./fixtures";
import { indexEntries, workingFileDigests } from "./git-oracle";
import { applyHunk, blobBytes, blobOf, compare, git, gitPath, gitText, hunksOf, outcome, patchOf, resultOf, scriptedPatch, selectHunks, subcommand, SUCCEEDED, TIMEOUT_MS, withoutPath, withService as hunkService, type Comparison, type Direction } from "./hunk-harness";
import { caseTest, keepConfigs, type Capability, type Service } from "./service-harness";
import { buildWorkbench } from "./workbench-fixtures";

// SC-009 (T096): each case keeps the bytes of every configuration file of the repositories that it registers.
const withService = (options: Parameters<typeof hunkService>[0], body: (service: Service) => Promise<void>) => hunkService(options, (service) => keepConfigs(service, body));

const TASK = "T025";
const SHELL: Capability[] = ["shell-double"];
const LONG_TIMEOUT_MS = 600_000;

useFixtureRoot();
printOrigin("../../src/git-service/hunk-publish.ts", import.meta.dir);
printOrigin("../../src/git-service/line-patch.ts", import.meta.dir);

let builds = 0;
const hunks = () => buildWorkbench(gitPath(), "staging-hunks", `t025-hunks-${++builds}`).repo;

// The one hunk of a comparison: its header values and its body lines without LF.
function hunkOf(c: Comparison): { oldStart: number; oldCount: number; newStart: number; newCount: number; body: string[] } {
  const all = hunksOf(patchOf(resultOf(c)));
  expect(all.length).toBe(1);
  const rows = all[0]!.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[0]!)!;
  return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), body: rows.slice(1) };
}

// The 1-based ordinals of the `+` and `-` lines of the body (data-model §6).
const changeOrdinals = (body: string[]) => body.flatMap((line, i) => (line[0] === "+" || line[0] === "-" ? [i + 1] : []));

// Research.md R11. Stage applies to the index side: a picked `-` line goes, an unpicked `-` line stays, a picked `+` line comes in, and an unpicked `+` line stays out.
// Unstage applies to the staged index content: a picked `+` line goes, an unpicked `+` line stays, a picked `-` line comes back, and an unpicked `-` line stays out.
function expectedContent(base: Buffer, h: ReturnType<typeof hunkOf>, picked: number[], direction: Direction): Buffer {
  const lines = base.toString("latin1").split(/(?<=\n)/);
  const [start, count] = direction === "stage" ? [h.oldStart, h.oldCount] : [h.newStart, h.newCount];
  const at = count === 0 ? start : start - 1;
  const region: string[] = [];
  h.body.forEach((line, i) => {
    const kind = line[0];
    const text = `${line.slice(1)}\n`;
    const chosen = picked.includes(i + 1);
    if (kind === " ") region.push(text);
    else if (direction === "stage" ? (kind === "-" ? !chosen : chosen) : kind === "+" ? !chosen : chosen) region.push(text);
  });
  return Buffer.from([...lines.slice(0, at), ...region, ...lines.slice(at + count)].join(""), "latin1");
}

// Every non-empty subset of `ordinals`.
const subsets = (ordinals: number[]) => Array.from({ length: (1 << ordinals.length) - 1 }, (_, m) => ordinals.filter((_, i) => ((m + 1) & (1 << i)) !== 0));

const linesOf = (service: Service, repositoryId: string, c: Comparison, direction: Direction, lines: number[]) => applyHunk(service, repositoryId, c, c.hunkIds[0]!, direction, { lines });

// One line selection: the index entry of `path` holds the expected blob, every other entry stays, and every working byte stays (SC-006).
async function selection(service: Service, repo: string, repositoryId: string, path: string, category: "unstaged" | "staged" | "untracked", direction: Direction, pick: (all: number[]) => number[]): Promise<void> {
  const before = { entries: indexEntries(gitPath(), repo), files: workingFileDigests(repo) };
  const c = await selectHunks(service, repositoryId, path, category);
  const h = hunkOf(c);
  const picked = pick(changeOrdinals(h.body));
  const oid = blobOf(repo, path);
  const base = oid === null ? Buffer.alloc(0) : blobBytes(repo, oid);
  const expected = gitText(repo, ["hash-object", "--stdin"], { input: expectedContent(base, h, picked, direction) }).trim();
  const response = await linesOf(service, repositoryId, c, direction, picked);
  expect({ path, picked, ...outcome(response) }).toEqual({ path, picked, ...SUCCEEDED });
  expect({ path, picked, oid: blobOf(repo, path) }).toEqual({ path, picked, oid: expected });
  expect(withoutPath(indexEntries(gitPath(), repo), path)).toEqual(withoutPath(before.entries, path));
  expect(workingFileDigests(repo)).toEqual(before.files);
}

describe("stage and unstage selected lines (spec FR-041, FR-042, SC-006)", () => {
  caseTest(TASK, `every line selection of the added, removed, and mixed hunks stages the expected blob, and every working byte stays`, SHELL, () =>
    withService({ name: "t025-stage" }, async (service) => {
      const repo = hunks();
      const { repositoryId } = await service.register(repo);
      for (const path of ["added.txt", "removed.txt", "mixed.txt"]) {
        const h = hunkOf(await selectHunks(service, repositoryId, path, "unstaged"));
        for (const picked of subsets(changeOrdinals(h.body))) {
          await selection(service, repo, repositoryId, path, "unstaged", "stage", () => picked);
          // `reset` writes only the index, so the next selection starts from HEAD.
          git(repo, ["reset", "-q", "--", path]);
        }
      }
    }),
    LONG_TIMEOUT_MS,
  );

  caseTest(TASK, `every line selection of the staged added, removed, and mixed hunks unstages to the expected blob, and every working byte stays`, SHELL, () =>
    withService({ name: "t025-unstage" }, async (service) => {
      const repo = hunks();
      const { repositoryId } = await service.register(repo);
      for (const path of ["added.txt", "removed.txt", "mixed.txt"]) {
        git(repo, ["add", "--", path]);
        const h = hunkOf(await selectHunks(service, repositoryId, path, "staged"));
        for (const picked of subsets(changeOrdinals(h.body))) {
          await selection(service, repo, repositoryId, path, "staged", "unstage", () => picked);
          git(repo, ["add", "--", path]);
        }
      }
    }),
    LONG_TIMEOUT_MS,
  );

  caseTest(TASK, `lines of an untracked file stage as a new entry with only the selected lines`, SHELL, () =>
    withService({ name: "t025-untracked" }, async (service) => {
      const repo = hunks();
      put(repo, "fresh.txt", "fresh 1\nfresh 2\nfresh 3\n");
      const { repositoryId } = await service.register(repo);
      await selection(service, repo, repositoryId, "fresh.txt", "untracked", "stage", (all) => [all[0]!, all[2]!]);
      expect(blobBytes(repo, blobOf(repo, "fresh.txt")!).toString()).toBe("fresh 1\nfresh 3\n");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `every + and - line of a hunk is the whole hunk: it stages as scripted git add -p does`, SHELL, () =>
    withService({ name: "t025-whole" }, async (service) => {
      const repo = hunks();
      const oracle = scriptedPatch(repo, "t025-whole-oracle", "add", "mixed.txt", ["y"]);
      const { repositoryId } = await service.register(repo);
      await selection(service, repo, repositoryId, "mixed.txt", "unstaged", "stage", (all) => all);
      expect(blobOf(repo, "mixed.txt")).toBe(blobOf(oracle, "mixed.txt"));
    }),
    TIMEOUT_MS,
  );
});

describe("line refusals (spec FR-044, contract Δ4, data-model §6)", () => {
  // A refusal changes no index entry and no working byte.
  async function refused(service: Service, repo: string, repositoryId: string, path: string, category: "unstaged" | "staged", direction: Direction, pick: (all: number[], body: string[]) => number[], expected: { code: string; reason?: string }): Promise<string> {
    const before = { entries: indexEntries(gitPath(), repo), files: workingFileDigests(repo) };
    const c = await selectHunks(service, repositoryId, path, category);
    const h = hunkOf(c);
    const response = await linesOf(service, repositoryId, c, direction, pick(changeOrdinals(h.body), h.body));
    const reason = (response.result as { reason?: string } | undefined)?.reason;
    expect({ path, state: response.state, code: response.code, ...(expected.reason === undefined ? {} : { reason }) }).toEqual({ path, state: "rejected", ...expected });
    expect({ path, entries: indexEntries(gitPath(), repo), files: workingFileDigests(repo) }).toEqual({ path, ...before });
    return response.operationId!;
  }

  caseTest(TASK, `deleted-file, new-file, and eof-newline refuse with UNSUPPORTED_COMPARISON; a partial end-of-file selection starts no apply, and the whole end-of-file hunk still stages as git add -p does`, SHELL, () =>
    withService({ name: "t025-refusals" }, async (service) => {
      const repo = hunks();
      put(repo, "fresh.txt", "fresh 1\nfresh 2\n");
      git(repo, ["add", "--", "fresh.txt"]);
      const oracle = scriptedPatch(repo, "t025-eof-oracle", "add", "eof.txt", ["y"]);
      const { repositoryId } = await service.register(repo);
      await refused(service, repo, repositoryId, "deleted.txt", "unstaged", "stage", (all) => all, { code: "UNSUPPORTED_COMPARISON", reason: "deleted-file" });
      await refused(service, repo, repositoryId, "fresh.txt", "staged", "unstage", (all) => [all[0]!], { code: "UNSUPPORTED_COMPARISON", reason: "new-file" });
      // Research.md R21 F25: the marker follows one side of the hunk. Each partial selection refuses before `apply --cached` runs.
      const eof = hunkOf(await selectHunks(service, repositoryId, "eof.txt", "unstaged"));
      for (const picked of subsets(changeOrdinals(eof.body)).filter((s) => s.length < changeOrdinals(eof.body).length)) {
        const operationId = await refused(service, repo, repositoryId, "eof.txt", "unstaged", "stage", () => picked, { code: "UNSUPPORTED_COMPARISON", reason: "eof-newline" });
        expect(service.runner.calls.filter((call) => call.operationId === operationId && subcommand(call.arguments) === "apply")).toEqual([]);
      }
      const c = await selectHunks(service, repositoryId, "eof.txt", "unstaged");
      expect(outcome(await linesOf(service, repositoryId, c, "stage", changeOrdinals(hunkOf(c).body)))).toEqual(SUCCEEDED);
      expect(blobOf(repo, "eof.txt")).toBe(blobOf(oracle, "eof.txt"));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `an ordinal of a context line, an ordinal outside the hunk, and an empty selection give INVALID_REQUEST; context-only has no service form`, SHELL, () =>
    withService({ name: "t025-invalid" }, async (service) => {
      const repo = hunks();
      const { repositoryId } = await service.register(repo);
      await refused(service, repo, repositoryId, "mixed.txt", "unstaged", "stage", (_, body) => [body.findIndex((l) => l[0] === " ") + 1], { code: "INVALID_REQUEST" });
      await refused(service, repo, repositoryId, "mixed.txt", "unstaged", "stage", (_, body) => [body.length + 1], { code: "INVALID_REQUEST" });
      await refused(service, repo, repositoryId, "mixed.txt", "unstaged", "stage", () => [], { code: "INVALID_REQUEST" });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a 001 FR-011 refusal keeps its reason: lines of a binary comparison give UNSUPPORTED_COMPARISON with reason binary`, SHELL, () =>
    withService({ name: "t025-binary" }, async (service) => {
      const repo = hunks();
      put(repo, "bin.dat", Uint8Array.of(1, 0, 2, 0, 3));
      git(repo, ["add", "--", "bin.dat"]);
      git(repo, ["commit", "-q", "-m", "binary"]);
      put(repo, "bin.dat", Uint8Array.of(1, 0, 2, 0, 4));
      const { repositoryId } = await service.register(repo);
      const before = { entries: indexEntries(gitPath(), repo), files: workingFileDigests(repo) };
      const c = await compare(service, repositoryId, "bin.dat", "unstaged");
      const response = await applyHunk(service, repositoryId, c, crypto.randomUUID(), "stage", { lines: [1] });
      expect({ ...outcome(response), reason: (response.result as { reason?: string })?.reason }).toEqual({ state: "rejected", code: "UNSUPPORTED_COMPARISON", reason: "binary" });
      expect({ entries: indexEntries(gitPath(), repo), files: workingFileDigests(repo) }).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `a working file that changed after the line selection refuses as a stale selection, and its new bytes stay`, SHELL, () =>
    withService({ name: "t025-stale" }, async (service) => {
      const repo = hunks();
      const { repositoryId } = await service.register(repo);
      const before = indexEntries(gitPath(), repo);
      const c = await selectHunks(service, repositoryId, "mixed.txt", "unstaged");
      put(repo, "mixed.txt", "changed after the selection\n");
      const files = workingFileDigests(repo);
      const response = await linesOf(service, repositoryId, c, "stage", [changeOrdinals(hunkOf(c).body)[0]!]);
      expect(outcome(response).code).toBe("STALE_SELECTION");
      expect({ entries: indexEntries(gitPath(), repo), files: workingFileDigests(repo) }).toEqual({ entries: before, files });
    }),
    TIMEOUT_MS,
  );
});
