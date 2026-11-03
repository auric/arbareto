// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T025: the unstaged `revert-lines` review and run of `src/git-service/revert.ts` (plan.md D3, D13; data-model §4, §6, §7; spec FR-013 to FR-015).
// Oracles (plan.md D13): the line oracle (the blob of `apply --cached -R` after `add` on a copy, and the raw bytes of every unselected line),
// and Git's `apply -R` on a copy in the fixtures without a line-ending conversion. Each partial patch comes from the hunk text here, never from `src/git-service/`.

import { describe, expect } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RunWorkbenchResult } from "../../src/contracts/envelope";
import type { RevertCheckpoint } from "../../src/git-service/workbench-review";
import { printOrigin } from "../origin";
import { faGit, write } from "./file-actions-fixtures";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { buildF05 } from "./fixtures";
import { workingFileDigests } from "./git-oracle";
import { approve, compare, copyRepo, gitPath, gitPathOf, hunksOf, outcome, patchOf, readOk, repoOf, resultOf, subcommand, SUCCEEDED, TIMEOUT_MS, withService, type Comparison } from "./hunk-harness";
import { caseTest, siblingDeadline, type Capability, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

for (const module of ["revert", "workbench-review", "comparison"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T025";
const SHELL: Capability[] = ["shell-double"];
const LONG_TIMEOUT_MS = 600_000;

type RevertRun = { action: string; files: { entryId: string; outcome: string; code?: string; reason?: string }[]; foldersCreated: string[]; index: string };
type Reviewed = { action: string; plan: { scope: string; fileBytes: string; lines: number | null }; workbenchToken: string };

// The line-ending keys and `core.filemode` of `tests/git/fixtures.ts` `lineEndings`. A case adds its own keys after them.
const LINE_ENDINGS: [string, string][] = [
  ["core.autocrlf", "false"],
  ["core.eol", "lf"],
  ["core.safecrlf", "false"],
  ["core.filemode", "false"],
];

let builds = 0;
const g = (repo: string, args: string[], input?: string | Uint8Array) => faGit(gitPath(), repo, args, input === undefined ? {} : { input });
const b64 = (path: string) => Buffer.from(path).toString("base64");
const latin = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

// `files` is the committed content. `working` is the content after the commit: bytes, or null for a deleted file.
function build(name: string, files: Record<string, string | Uint8Array>, working: Record<string, string | Uint8Array | null>, config: [string, string][] = []): string {
  const repo = join(fixtureDir(`t025-${name}-${++builds}`), "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [...LINE_ENDINGS, ...config]) g(repo, ["config", key, value]);
  for (const [path, content] of Object.entries(files)) write(repo, path, content);
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
  for (const [path, content] of Object.entries(working)) {
    if (content === null) rmSync(join(repo, ...path.split("/")));
    else write(repo, path, content);
  }
  return repo;
}

const rawIndex = (repo: string) => new Bun.CryptoHasher("sha256").update(readFileSync(gitPathOf(repo, "index"))).digest("hex");
const state = (repo: string) => ({ index: g(repo, ["ls-files", "--stage", "-z"]).toString("latin1"), raw: rawIndex(repo), files: workingFileDigests(repo) });

// ---- The hunk text and the partial patch (plan.md D3 `unstage` rule) ----

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  // The body lines without their LF, as latin1 text.
  body: string[];
}

function parseHunk(text: string): Hunk {
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[0]!)!;
  return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), body: rows.slice(1) };
}

// The 1-based ordinals of the `+` and `-` lines of the body (004 data-model §6).
const changeOrdinals = (h: Hunk) => h.body.flatMap((line, i) => (line[0] === "+" || line[0] === "-" ? [i + 1] : []));

// The unstage rule: an unselected `+` line becomes context, and an unselected `-` line drops. Null: the whole hunk.
function partialBody(h: Hunk, picked: readonly number[] | null): string[] {
  if (picked === null) return h.body;
  const kept: string[] = [];
  h.body.forEach((line, i) => {
    if (line[0] === " " || picked.includes(i + 1)) kept.push(line);
    else if (line[0] === "+") kept.push(` ${line.slice(1)}`);
  });
  return kept;
}

function partialPatch(header: string, h: Hunk, picked: readonly number[] | null): Buffer {
  const body = partialBody(h, picked);
  const oldCount = body.filter((l) => l[0] !== "+" && l[0] !== "\\").length;
  const newCount = body.filter((l) => l[0] !== "-" && l[0] !== "\\").length;
  return Buffer.from(`${header}@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@\n${body.map((l) => `${l}\n`).join("")}`, "latin1");
}

const splitLines = (bytes: Uint8Array) => latin(bytes).match(/[^\n]*\n|[^\n]+$/g) ?? [];
const withoutEnding = (line: string) => line.replace(/\r?\n$/, "");

// Plan.md D13 line oracle, second check: every working line outside the reverted lines keeps its raw bytes, and each restored line holds its comparison text.
function expectKeptLines(before: Uint8Array, after: Uint8Array, h: Hunk, picked: readonly number[] | null, label: object): void {
  const old = splitLines(before);
  const at = h.newCount === 0 ? h.newStart : h.newStart - 1;
  const expected: ({ raw: string } | { restored: string })[] = old.slice(0, at).map((raw) => ({ raw }));
  let w = at;
  for (const line of partialBody(h, picked)) {
    if (line[0] === " ") expected.push({ raw: old[w++]! });
    else if (line[0] === "+") w++;
    else if (line[0] === "-") expected.push({ restored: withoutEnding(`${line.slice(1)}\n`) });
  }
  expected.push(...old.slice(w).map((raw) => ({ raw })));
  const now = splitLines(after).map((line, i) => ("restored" in (expected[i] ?? {}) ? { restored: withoutEnding(line) } : { raw: line }));
  expect({ ...label, lines: now }).toEqual({ ...label, lines: expected });
}

// The file header of a comparison patch: every line before the first hunk.
const headerOf = (patch: Uint8Array) => latin(patch).slice(0, latin(patch).search(/^@@ /m));

// ---- Service steps ----

const review = (service: Service, r: RegistrationResult, read: WorkspaceResult, payload: object) =>
  service.request<Reviewed>("reviewWorkbench", { snapshotId: read.snapshotId, action: "revert-lines", ...payload }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });

async function reviewOk(service: Service, r: RegistrationResult, read: WorkspaceResult, payload: object): Promise<Reviewed> {
  const response = await review(service, r, read, payload);
  expect({ payload, ...outcome(response), result: response.state === "succeeded" ? "plan" : response.result }).toEqual({ payload, ...SUCCEEDED, result: "plan" });
  return response.result!;
}

const sendRun = (service: Service, r: RegistrationResult, token: string) => service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
async function run(service: Service, r: RegistrationResult, token: string): Promise<ServiceResponse<RevertRun>> {
  const response = await service.response<RevertRun>(sendRun(service, r, token));
  if (response.result !== undefined) expect(RunWorkbenchResult.safeParse(response.result).success).toBe(true);
  return response;
}

const refusal = (response: ServiceResponse<unknown>) => ({ state: response.state, code: response.code, result: response.result });

// The comparison of `path` and its hunks as text.
async function comparisonOf(service: Service, r: RegistrationResult, read: WorkspaceResult, path: string, category: "unstaged" | "staged" | "untracked" = "unstaged"): Promise<{ c: Comparison; hunks: Hunk[]; header: string }> {
  const c = await compare(service, r.repositoryId, path, category, read);
  expect({ path, ...outcome(c.response) }).toEqual({ path, ...SUCCEEDED });
  const patch = patchOf(resultOf(c));
  return { c, hunks: hunksOf(patch).map(parseHunk), header: headerOf(patch) };
}

// One revert of `picked` lines of hunk `index` (null: the whole hunk), checked against the oracles. `applyReverse`: the fixture has no line-ending conversion.
async function revertCase(service: Service, r: RegistrationResult, repo: string, path: string, index: number, pick: (h: Hunk) => number[] | null, applyReverse: boolean, bytes?: string): Promise<void> {
  const read = await readOk(service, r.repositoryId);
  const { c, hunks, header } = await comparisonOf(service, r, read, path);
  const h = hunks[index]!;
  const picked = pick(h);
  const label = { path, index, picked };
  const patch = partialPatch(header, h, picked);
  const before = state(repo);
  const working = readFileSync(join(repo, ...path.split("/")));
  // Plan.md D13 line oracle, first check: `apply --cached -R` of the partial patch on a copy after `add`.
  const cached = copyRepo(repo, `t025-cached-${++builds}`);
  g(cached, ["--literal-pathspecs", "add", "--", path]);
  g(cached, ["apply", "--cached", "-R"], patch);
  const oracleBlob = /^\d{6} ([0-9a-f]+) 0\t/.exec(g(cached, ["--literal-pathspecs", "ls-files", "-s", "--", path]).toString("utf8"))![1];
  let applied: Buffer | null = null;
  if (applyReverse) {
    const copy = copyRepo(repo, `t025-apply-${++builds}`);
    g(copy, ["apply", "-R"], patch);
    applied = readFileSync(join(copy, ...path.split("/")));
  }

  const reviewed = await reviewOk(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[index]!, ...(picked === null ? {} : { lines: picked }) });
  expect({ ...label, plan: reviewed.plan }).toEqual({ ...label, plan: { scope: "unstaged", fileBytes: b64(path), lines: picked === null ? null : picked.length } });
  const done = await run(service, r, reviewed.workbenchToken);
  expect({ ...label, ...outcome(done), result: done.result }).toEqual({ ...label, ...SUCCEEDED, result: { action: "revert-lines", files: [{ entryId: c.entry.entryId, outcome: "reverted" }], foldersCreated: [], index: "none" } });

  const after = readFileSync(join(repo, ...path.split("/")));
  const proof = g(repo, ["hash-object", `--path=${path}`, "--stdin"], after).toString("utf8").trim();
  expect({ ...label, checkIn: proof }).toEqual({ ...label, checkIn: oracleBlob });
  expectKeptLines(working, after, h, picked, label);
  if (applied !== null) expect({ ...label, bytes: latin(after) }).toEqual({ ...label, bytes: latin(applied) });
  if (bytes !== undefined) expect({ ...label, bytes: latin(after) }).toEqual({ ...label, bytes });
  // Spec FR-014: the index and every other working file stay.
  const now = state(repo);
  expect({ ...label, index: now.index, raw: now.raw }).toEqual({ ...label, index: before.index, raw: before.raw });
  const others = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([p]) => p !== path));
  expect({ ...label, files: others(now.files) }).toEqual({ ...label, files: others(before.files) });
  // The next case starts from the same working bytes.
  write(repo, path, working);
}

// Twelve lines with a changed, an added, and a removed line in one hunk, and a file with two hunks.
const TWELVE = Array.from({ length: 12 }, (_, i) => `l${i + 1}\n`).join("");
const MIXED = TWELVE.replace("l2\n", "L2\n").replace("l5\n", "l5\nnew\n").replace("l8\n", "");
const THIRTY = Array.from({ length: 30 }, (_, i) => `t${i + 1}\n`).join("");
const TWO_HUNKS = THIRTY.replace("t3\n", "T3\nT3b\n").replace("t25\n", "");

describe("revert lines and hunks in the working file (spec FR-014, FR-015, plan.md D13)", () => {
  caseTest(TASK, "line selections and whole hunks pass the line oracle, equal git apply -R without a conversion, and keep the index", SHELL, () =>
    withService({ name: "t025-lines" }, async (service) => {
      const repo = build("lines", { "mixed.txt": TWELVE, "two.txt": THIRTY, "ü/файл.txt": "u1\nu2\nu3\n" }, { "mixed.txt": MIXED, "two.txt": TWO_HUNKS, "ü/файл.txt": "u1\nU2\nu3\nu4\n" });
      const r = await service.register(repo);
      // Mixed body: ` l1 -l2 +L2 l3 l4 l5 +new l6 l7 -l8 l9 l10 l11`. Each pick names positions in the list of its change ordinals.
      const picks: (number[] | null)[] = [[0], [1], [2], [3], [0, 1], [1, 2, 3], [0, 1, 2, 3], null];
      for (const pick of picks) await revertCase(service, r, repo, "mixed.txt", 0, (h) => (pick === null ? null : pick.map((k) => changeOrdinals(h)[k]!)), true);
      // The second hunk needs the working side of every hunk (data-model §4 `expectedBlobId`).
      await revertCase(service, r, repo, "two.txt", 1, () => null, true);
      await revertCase(service, r, repo, "two.txt", 0, (h) => [changeOrdinals(h)[1]!], true);
      await revertCase(service, r, repo, "ü/файл.txt", 0, (h) => [changeOrdinals(h).at(-1)!], true);
    }),
    LONG_TIMEOUT_MS,
  );

  // Data-model §6 and spec US1 scenario 7: a restored line ends with CRLF in a CRLF working file, and every other byte stays.
  const CRLF_CASES: { id: string; config: [string, string][]; files: Record<string, string>; working: string; applyReverse: boolean; restored: string; whole: string }[] = [
    { id: "crlf-none-index-crlf", config: [], files: { "f.txt": "a\r\nb\r\nc\r\nd\r\n" }, working: "a\r\nB\r\nc\r\nd\r\n", applyReverse: true, restored: "a\r\nb\r\nB\r\nc\r\nd\r\n", whole: "a\r\nb\r\nc\r\nd\r\n" },
    { id: "crlf-autocrlf-true", config: [["core.autocrlf", "true"]], files: { "f.txt": "a\r\nb\r\nc\r\nd\r\n" }, working: "a\r\nB\r\nc\r\nd\r\n", applyReverse: false, restored: "a\r\nb\r\nB\r\nc\r\nd\r\n", whole: "a\r\nb\r\nc\r\nd\r\n" },
    { id: "crlf-text-eol-crlf", config: [], files: { ".gitattributes": "f.txt text eol=crlf\n", "f.txt": "a\r\nb\r\nc\r\nd\r\n" }, working: "a\r\nB\r\nc\r\nd\r\n", applyReverse: false, restored: "a\r\nb\r\nB\r\nc\r\nd\r\n", whole: "a\r\nb\r\nc\r\nd\r\n" },
    // Git's `apply -R` converts the whole file again and gives CRLF for every line here, so only the line oracle applies (research.md R15 G5).
    { id: "lf-autocrlf-true", config: [["core.autocrlf", "true"]], files: { "f.txt": "a\nb\nc\nd\n" }, working: "a\nB\nc\nd\n", applyReverse: false, restored: "a\nb\nB\nc\nd\n", whole: "a\nb\nc\nd\n" },
  ];
  for (const k of CRLF_CASES) {
    caseTest(TASK, `${k.id}: a restored line takes the working line ending, and the proof passes`, SHELL, () =>
      withService({ name: `t025-${k.id}` }, async (service) => {
        const repo = build(k.id, k.files, { "f.txt": k.working }, k.config);
        const r = await service.register(repo);
        // Body ` a -b +B c d`: only the removed line.
        await revertCase(service, r, repo, "f.txt", 0, (h) => [h.body.findIndex((l) => l[0] === "-") + 1], k.applyReverse, k.restored);
        await revertCase(service, r, repo, "f.txt", 0, () => null, k.applyReverse, k.whole);
      }),
      TIMEOUT_MS,
    );
  }

  // T060: without a conversion, Git's checkout writes the LF index bytes, and check-in keeps each CR (Git `convert.c` `output_eol`, CRLF_BINARY).
  // So a restored line keeps its LF comparison bytes, and the proof passes. Every line differs, so the hunk is `-a -b -c -d +a\r +B\r +c\r +d\r`.
  caseTest("T060", "a CRLF working file that Git stores with LF without a conversion reverts with LF restored lines and passes the line oracle", SHELL, () =>
    withService({ name: "t060-line-endings" }, async (service) => {
      const repo = build("line-endings", { "f.txt": "a\nb\nc\nd\n" }, { "f.txt": "a\r\nB\r\nc\r\nd\r\n" });
      const r = await service.register(repo);
      await revertCase(service, r, repo, "f.txt", 0, (h) => [changeOrdinals(h)[1]!], true, "b\na\r\nB\r\nc\r\nd\r\n");
      await revertCase(service, r, repo, "f.txt", 0, (h) => [changeOrdinals(h)[1]!, changeOrdinals(h)[5]!], true, "b\na\r\nc\r\nd\r\n");
      await revertCase(service, r, repo, "f.txt", 0, () => null, true, "a\nb\nc\nd\n");
    }),
    TIMEOUT_MS,
  );
});

describe("revert lines: refusals (data-model §7, spec FR-013, FR-038)", () => {
  // Each refusal changes no index entry and no working byte.
  async function refused(service: Service, r: RegistrationResult, repo: string, read: WorkspaceResult, path: string, category: "unstaged" | "staged" | "untracked", lines: ((ordinals: number[]) => number[]) | null, expected: { code: string; result?: object }): Promise<void> {
    const c = await compare(service, r.repositoryId, path, category, read);
    expect({ path, ...outcome(c.response) }).toEqual({ path, ...SUCCEEDED });
    const patch = patchOf(resultOf(c));
    const ordinals = hunksOf(patch).length === 0 ? [] : changeOrdinals(parseHunk(hunksOf(patch)[0]!));
    const before = state(repo);
    // An unsupported comparison has no hunk, so the request names a hunk ID that no comparison holds.
    const hunkId = c.hunkIds[0] ?? crypto.randomUUID();
    const response = await review(service, r, read, { comparisonId: c.comparisonId, hunkId, ...(lines === null ? {} : { lines: lines(ordinals) }) });
    expect({ path, ...refusal(response) }).toEqual({ path, state: "failed", code: expected.code, result: expected.result });
    expect({ path, state: state(repo) }).toEqual({ path, state: before });
  }
  const unsupported = (reason: string) => ({ code: "UNSUPPORTED_COMPARISON", result: { reason } });
  const unavailable = (reason: string) => ({ code: "WORKBENCH_UNAVAILABLE", result: { reason } });

  caseTest(TASK, "ident, attributes, untracked, deleted-file, new-file, eof-newline, rename, and mode refuse with their code and reason; a context ordinal gives INVALID_REQUEST", SHELL, () =>
    withService({ name: "t025-refusals" }, async (service) => {
      const repo = build(
        "refusals",
        { ".gitattributes": "ident.txt ident\n", "ident.txt": "a\n$Id$\nc\n", "attr.txt": "a\nb\nc\n", "gone.txt": "a\nb\n", "eof.txt": "a\nb", "ctx.txt": "a\nb\nc\n", "old.txt": "r1\nr2\nr3\n" },
        { ".gitattributes": "ident.txt ident\nattr.txt text\n", "ident.txt": "a\n$Id$\nC\n", "attr.txt": "a\nB\nc\n", "gone.txt": null, "eof.txt": "a\nb\nc\nd\n", "ctx.txt": "a\nB\nc\n", "new.txt": "n\n", "staged.txt": "s\n" },
      );
      g(repo, ["--literal-pathspecs", "add", "--", "staged.txt"]);
      g(repo, ["--literal-pathspecs", "mv", "--", "old.txt", "renamed.txt"]);
      write(repo, "renamed.txt", "r1\nR2\nr3\n");
      const r = await service.register(repo);
      const read = await readOk(service, r.repositoryId);
      await refused(service, r, repo, read, "ident.txt", "unstaged", null, unavailable("ident"));
      await refused(service, r, repo, read, "attr.txt", "unstaged", null, unavailable("attributes"));
      await refused(service, r, repo, read, "new.txt", "untracked", null, unavailable("untracked"));
      await refused(service, r, repo, read, "gone.txt", "unstaged", null, unsupported("deleted-file"));
      await refused(service, r, repo, read, "gone.txt", "unstaged", (o) => [o[0]!], unsupported("deleted-file"));
      // A staged new file: the `unstage` rule refuses its lines and its hunk (spec Edge Cases).
      await refused(service, r, repo, read, "staged.txt", "staged", null, unsupported("new-file"));
      // Body `a -b \ +b +c +d`: a part of a hunk with the marker refuses, and the whole hunk passes (spec FR-013).
      await refused(service, r, repo, read, "eof.txt", "unstaged", (o) => [o.at(-1)!], unsupported("eof-newline"));
      await refused(service, r, repo, read, "renamed.txt", "unstaged", null, unsupported("rename"));
      // Contract Δ4 (004): `context-only` has no service form, because a context ordinal is no line selection.
      await refused(service, r, repo, read, "ctx.txt", "unstaged", () => [1], { code: "INVALID_REQUEST" });
      await revertCase(service, r, repo, "eof.txt", 0, () => null, true, "a\nb");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "an unstaged mode change refuses with mode", SHELL, () =>
    withService({ name: "t025-mode" }, async (service) => {
      // `core.filemode=true`: the working file has no executable bit, and the index entry has mode 100755.
      const repo = build("mode", { "mode.sh": "a\nb\n" }, {}, [["core.filemode", "true"]]);
      g(repo, ["update-index", "--chmod=+x", "--", "mode.sh"]);
      g(repo, ["commit", "-q", "--no-verify", "-m", "mode"]);
      write(repo, "mode.sh", "a\nB\n");
      const r = await service.register(repo);
      await refused(service, r, repo, await readOk(service, r.repositoryId), "mode.sh", "unstaged", null, unsupported("mode"));
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "binary, symlink, submodule, LFS, and filter refuse with the 001 support reason (F05)", SHELL, () =>
    withService({ name: "t025-f05" }, async (service) => {
      const repo = repoOf(buildF05(gitPath(), "t025-f05"), "super");
      const r = await service.register(repo);
      // Contract §7: the F05 filters need trust for the reads. The revert actions take no class (contract Δ7).
      await approve(service, r.repositoryId);
      await service.readWorkspace(r.repositoryId);
      await approve(service, r.repositoryId);
      const read = await readOk(service, r.repositoryId);
      for (const [path, reason] of [
        ["binary.dat", "binary"],
        ["link", "symlink"],
        ["sub-moved", "submodule"],
        ["asset.psd", "LFS"],
        ["custom.cf", "filter"],
      ] as const) {
        await refused(service, r, repo, read, path, "unstaged", null, unsupported(reason));
      }
    }),
    TIMEOUT_MS,
  );
});

describe("revert lines: the bound and the token (spec FR-011, plan.md D2, D13)", () => {
  const FILE = { "f.txt": "a\nb\nc\nd\n" };
  const CHANGED = { "f.txt": "a\nB\nc\nd\n" };

  caseTest(TASK, "a change between the review and the run gives STALE_REVIEW with revert-changed, and nothing changes", SHELL, () =>
    withService({ name: "t025-stale" }, async (service) => {
      const repo = build("stale", FILE, CHANGED);
      const r = await service.register(repo);
      const read = await readOk(service, r.repositoryId);
      const { c } = await comparisonOf(service, r, read, "f.txt");
      const reviewed = await reviewOk(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! });
      write(repo, "f.txt", "a\nB\nc\nd\nE\n");
      const before = state(repo);
      expect(refusal(await run(service, r, reviewed.workbenchToken))).toEqual({ state: "failed", code: "STALE_REVIEW", result: { action: "revert-lines", reason: "revert-changed" } });
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  // The `revertCheckpoint` seam: another writer changes the file after the run observed it again and before the write.
  caseTest(TASK, "a change at the before-write checkpoint: the expected check refuses the write, and the fresh read names changed-outside", SHELL, async () => {
    const seen: RevertCheckpoint[] = [];
    let repo = "";
    await withService(
      {
        name: "t025-checkpoint",
        revertCheckpoint: (checkpoint: RevertCheckpoint) => {
          seen.push(checkpoint);
          write(repo, "f.txt", "another writer\n");
        },
      },
      async (service) => {
        repo = build("checkpoint", FILE, CHANGED);
        const r = await service.register(repo);
        const read = await readOk(service, r.repositoryId);
        const { c } = await comparisonOf(service, r, read, "f.txt");
        const reviewed = await reviewOk(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! });
        const index = state(repo).index;
        const done = await run(service, r, reviewed.workbenchToken);
        expect({ state: done.state, files: done.result?.files }).toEqual({ state: "failed-with-effects", files: [{ entryId: c.entry.entryId, outcome: "changed-outside" }] });
        expect(seen.map(({ step, path }) => ({ step, path }))).toEqual([{ step: "before-write", path: b64("f.txt") }]);
        // The shell got the bound size and SHA-256 as `expected` and wrote nothing.
        const frames = service.runner.frames.filter((f) => f.type === "fileReplace") as { expected: { size: number; sha256: string } }[];
        expect(frames.map((f) => f.expected)).toEqual([{ size: 8, sha256: new Bun.CryptoHasher("sha256").update(CHANGED["f.txt"]).digest("hex") }]);
        expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("another writer\n");
        expect(state(repo).index).toBe(index);
      },
    );
  }, TIMEOUT_MS);

  let clock = 0;
  caseTest(TASK, "a run after the 60 s token lifetime gives APPROVAL_EXPIRED, and nothing changes (the approval clock seam)", SHELL, () =>
    withService({ name: "t025-expired", approvalClock: () => clock }, async (service) => {
      const repo = build("expired", FILE, CHANGED);
      const r = await service.register(repo);
      const read = await readOk(service, r.repositoryId);
      const { c } = await comparisonOf(service, r, read, "f.txt");
      clock = 1_000;
      const reviewed = await reviewOk(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! });
      clock += 60_001;
      const before = state(repo);
      expect(outcome(await run(service, r, reviewed.workbenchToken))).toEqual({ state: "rejected", code: "APPROVAL_EXPIRED" });
      expect(state(repo)).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a comparison of another snapshot gives INVALID_REQUEST, and an unknown comparison or hunk gives UNKNOWN_TARGET", SHELL, () =>
    withService({ name: "t025-targets" }, async (service) => {
      const repo = build("targets", FILE, CHANGED);
      const r = await service.register(repo);
      const read = await readOk(service, r.repositoryId);
      const { c } = await comparisonOf(service, r, read, "f.txt");
      expect(outcome(await review(service, r, read, { comparisonId: crypto.randomUUID(), hunkId: c.hunkIds[0]! }))).toEqual({ state: "failed", code: "UNKNOWN_TARGET" });
      expect(outcome(await review(service, r, read, { comparisonId: c.comparisonId, hunkId: crypto.randomUUID() }))).toEqual({ state: "failed", code: "UNKNOWN_TARGET" });
      write(repo, "g.txt", "g\n");
      const later = await readOk(service, r.repositoryId);
      expect(outcome(await review(service, r, later, { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! }))).toEqual({ state: "failed", code: "INVALID_REQUEST" });
    }),
    TIMEOUT_MS,
  );
});

describe("revert lines: the read round of the review (T074, spec SC-007)", () => {
  const FILE = { "f.txt": "a\nb\nc\nd\n" };
  const CHANGED = { "f.txt": "a\nB\nc\nd\n" };
  type Call = { arguments: readonly string[] };
  // The Git reads of a line review that need no result of another read.
  const ROUND: [string, (call: Call) => boolean][] = [
    ["ls-files --stage", (c) => subcommand(c.arguments) === "ls-files" && c.arguments.includes("--stage")],
    ["check-attr", (c) => subcommand(c.arguments) === "check-attr" && !c.arguments.includes("--cached")],
    ["check-attr --cached", (c) => subcommand(c.arguments) === "check-attr" && c.arguments.includes("--cached")],
    ["ls-files --eol", (c) => subcommand(c.arguments) === "ls-files" && c.arguments.includes("--eol")],
    ["cat-file blob", (c) => subcommand(c.arguments) === "cat-file" && c.arguments.includes("blob")],
  ];

  caseTest("T074", "read round: ls-files --stage, check-attr, check-attr --cached, ls-files --eol, and cat-file all start before the first of them ends", SHELL, () =>
    withService({ name: "t074-round" }, async (service) => {
      const repo = build("round", FILE, CHANGED);
      const r = await service.register(repo);
      const read = await readOk(service, r.repositoryId);
      const { c } = await comparisonOf(service, r, read, "f.txt");
      const from = service.runner.calls.length;
      await reviewOk(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! });
      const calls = service.runner.calls.slice(from);
      const round = ROUND.map(([name, match]) => ({ name, found: calls.filter(match) }));
      expect(round.map(({ name, found }) => ({ name, count: found.length }))).toEqual(ROUND.map(([name]) => ({ name, count: 1 })));
      // The double records `at` before the start and `durationMs` after the exit, both from `performance.now()`.
      const firstEnd = Math.min(...round.map(({ found }) => found[0]!.at + found[0]!.durationMs!));
      expect(round.map(({ name, found }) => ({ name, startedBeforeFirstEnd: found[0]!.at < firstEnd }))).toEqual(ROUND.map(([name]) => ({ name, startedBeforeFirstEnd: true })));
    }),
    TIMEOUT_MS,
  );

  // T399 seam, 001 contract §5 "Deadline outcomes": the cat-file deadline closes the operation Job, so ls-files --stage ends with `exitCode` null and no `deadline`.
  caseTest("T074", "read round: a cat-file deadline gives DEADLINE when the Job close ends ls-files --stage, whose check comes first", SHELL, () =>
    withService({ name: "t074-deadline" }, async (service) => {
      const repo = build("deadline", FILE, CHANGED);
      const r = await service.register(repo);
      const read = await readOk(service, r.repositoryId);
      const { c } = await comparisonOf(service, r, read, "f.txt");
      const [stage, blob] = [ROUND[0]![1], ROUND[4]![1]];
      const from = service.runner.calls.length;
      const release = siblingDeadline(service, blob, stage);
      const response = await review(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! }).finally(release);
      const calls = service.runner.calls.slice(from);
      const exitOf = (match: (call: Call) => boolean) => calls.filter(match).map(({ exit }) => exit?.deadline ?? (exit?.exitCode === null ? "closed" : String(exit?.exitCode)));
      expect({ stage: exitOf(stage), blob: exitOf(blob), state: response.state, code: response.code }).toEqual({ stage: ["closed"], blob: ["deadline"], state: "failed", code: "DEADLINE" });
    }),
    TIMEOUT_MS,
  );
});
