// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T038: the staged `revert-lines` review and run of `src/git-service/revert.ts` (plan.md D4, D7, D10, D13; data-model §4, §7, §8; spec FR-016, FR-017).
// Oracles (plan.md D13): Git's `apply --cached -R` of the same partial patch on a copy gives the index. The working file has no unstaged change,
// so `hash-object --path` of its new bytes must give the new index blob, and Git's `apply -R` on a copy gives its bytes in a fixture without a conversion.
// Each partial patch comes from the hunk text here, never from `src/git-service/`.

import { describe, expect } from "bun:test";
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunWorkbenchResult } from "../../src/contracts/envelope";
import { PROFILE_TEXTS } from "../../src/git-service/hunk-publish";
import { LOCKED_REMEDY } from "../../src/git-service/index-lock";
import type { RevertCheckpoint } from "../../src/git-service/workbench-review";
import { printOrigin } from "../origin";
import { faGit, write } from "./file-actions-fixtures";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { workingFileDigests } from "./git-oracle";
import { compare, copyRepo, gitPath, gitPathOf, hunksOf, outcome, patchOf, readOk, resultOf, SUCCEEDED, TIMEOUT_MS, withService } from "./hunk-harness";
import { caseTest, type Capability, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "./service-harness";

for (const module of ["revert", "workbench-review", "hunk-publish", "hunk-candidate"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
useFixtureRoot();

const TASK = "T038";
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
const add = (repo: string, ...paths: string[]) => g(repo, ["--literal-pathspecs", "add", "--", ...paths]);

// `files` is the committed content. `staged` is written and added after the commit, so its paths have no unstaged change.
function build(name: string, files: Record<string, string>, staged: Record<string, string>, config: [string, string][] = []): string {
  const repo = join(fixtureDir(`t038-${name}-${++builds}`), "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [...LINE_ENDINGS, ...config]) g(repo, ["config", key, value]);
  for (const [path, content] of Object.entries(files)) write(repo, path, content);
  add(repo, ".");
  g(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
  for (const [path, content] of Object.entries(staged)) write(repo, path, content);
  if (Object.keys(staged).length > 0) add(repo, ...Object.keys(staged));
  return repo;
}

const indexOf = (repo: string) => g(repo, ["ls-files", "--stage", "-z"]).toString("latin1");
const rawIndex = (repo: string) => new Bun.CryptoHasher("sha256").update(readFileSync(gitPathOf(repo, "index"))).digest("hex");
const state = (repo: string) => ({ index: indexOf(repo), raw: rawIndex(repo), files: workingFileDigests(repo) });
const blobAt = (repo: string, path: string) => /^\d{6} ([0-9a-f]+) 0\t/.exec(g(repo, ["--literal-pathspecs", "ls-files", "-s", "--", path]).toString("utf8"))![1]!;
const others = (files: Record<string, string>, path: string) => Object.fromEntries(Object.entries(files).filter(([p]) => p !== path));

// ---- The hunk text and the partial patch (plan.md D3 `unstage` rule, which plan.md D4 keeps) ----

interface Hunk {
  oldStart: number;
  newStart: number;
  // The body lines without their LF, as latin1 text.
  body: string[];
}

function parseHunk(text: string): Hunk {
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rows[0]!)!;
  return { oldStart: Number(m[1]), newStart: Number(m[2]), body: rows.slice(1) };
}

// The 1-based ordinals of the `+` and `-` lines of the body (004 data-model §6).
const changeOrdinals = (h: Hunk) => h.body.flatMap((line, i) => (line[0] === "+" || line[0] === "-" ? [i + 1] : []));

// The unstage rule: an unselected `+` line becomes context, and an unselected `-` line drops. Null: the whole hunk.
function partialPatch(header: string, h: Hunk, picked: readonly number[] | null): Buffer {
  const body: string[] = [];
  h.body.forEach((line, i) => {
    if (picked === null || line[0] === " " || picked.includes(i + 1)) body.push(line);
    else if (line[0] === "+") body.push(` ${line.slice(1)}`);
  });
  const oldCount = body.filter((l) => l[0] !== "+").length;
  const newCount = body.filter((l) => l[0] !== "-").length;
  return Buffer.from(`${header}@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@\n${body.map((l) => `${l}\n`).join("")}`, "latin1");
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

async function run(service: Service, r: RegistrationResult, token: string): Promise<ServiceResponse<RevertRun>> {
  const response = await service.response<RevertRun>(service.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId }));
  if (response.result !== undefined) expect(RunWorkbenchResult.safeParse(response.result).success).toBe(true);
  return response;
}

const refusal = (response: ServiceResponse<unknown>) => ({ state: response.state, code: response.code, result: response.result });
const writes = (service: Service) => service.runner.frames.filter((f) => f.type === "fileReplace").length;

// The comparison of `path` in `category` and its hunks as text.
async function comparisonOf(service: Service, r: RegistrationResult, read: WorkspaceResult, path: string, category: "staged" | "unstaged" = "staged") {
  const c = await compare(service, r.repositoryId, path, category, read);
  expect({ path, ...outcome(c.response) }).toEqual({ path, ...SUCCEEDED });
  const patch = patchOf(resultOf(c));
  return { c, hunks: hunksOf(patch).map(parseHunk), header: headerOf(patch) };
}

// Plan.md D13: the index of Git's `apply --cached -R` of `patch` on a copy, and with `worktree` the bytes of Git's `apply -R` on another copy.
function oracle(repo: string, path: string, patch: Buffer, worktree: boolean): { index: string; blob: string; bytes: string | null } {
  const cached = copyRepo(repo, `t038-cached-${++builds}`);
  g(cached, ["apply", "--cached", "-R"], patch);
  let bytes: string | null = null;
  if (worktree) {
    const copy = copyRepo(repo, `t038-apply-${++builds}`);
    g(copy, ["apply", "-R"], patch);
    bytes = latin(readFileSync(join(copy, ...path.split("/"))));
  }
  return { index: indexOf(cached), blob: blobAt(cached, path), bytes };
}

// One staged revert of `picked` lines of hunk `index` (null: the whole hunk), checked against the oracles. `applyReverse`: the fixture has no line-ending conversion.
async function stagedCase(service: Service, r: RegistrationResult, repo: string, path: string, index: number, pick: (h: Hunk) => number[] | null, applyReverse: boolean, bytes?: string): Promise<void> {
  const read = await readOk(service, r.repositoryId);
  const { c, hunks, header } = await comparisonOf(service, r, read, path);
  const h = hunks[index]!;
  const picked = pick(h);
  const label = { path, index, picked };
  const working = readFileSync(join(repo, ...path.split("/")));
  const before = state(repo);
  const expected = oracle(repo, path, partialPatch(header, h, picked), applyReverse);

  const reviewed = await reviewOk(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[index]!, ...(picked === null ? {} : { lines: picked }) });
  expect({ ...label, plan: reviewed.plan }).toEqual({ ...label, plan: { scope: "staged", fileBytes: b64(path), lines: picked === null ? null : picked.length } });
  const done = await run(service, r, reviewed.workbenchToken);
  expect({ ...label, ...outcome(done), result: done.result }).toEqual({ ...label, ...SUCCEEDED, result: { action: "revert-lines", files: [{ entryId: c.entry.entryId, outcome: "reverted" }], foldersCreated: [], index: "published" } });

  // Spec FR-016: the index equals Git's own reverse apply, and the working file loses the same changes.
  expect({ ...label, index: indexOf(repo) }).toEqual({ ...label, index: expected.index });
  const after = readFileSync(join(repo, ...path.split("/")));
  const checkIn = g(repo, ["hash-object", `--path=${path}`, "--stdin"], after).toString("utf8").trim();
  expect({ ...label, checkIn }).toEqual({ ...label, checkIn: expected.blob });
  if (expected.bytes !== null) expect({ ...label, bytes: latin(after) }).toEqual({ ...label, bytes: expected.bytes });
  if (bytes !== undefined) expect({ ...label, bytes: latin(after) }).toEqual({ ...label, bytes });
  // The other working files stay.
  expect({ ...label, files: others(state(repo).files, path) }).toEqual({ ...label, files: others(before.files, path) });
  // The next case starts from the same staged bytes.
  write(repo, path, working);
  add(repo, path);
}

// Twelve lines with a changed, an added, and a removed line in one hunk, and a file with two hunks.
const TWELVE = Array.from({ length: 12 }, (_, i) => `l${i + 1}\n`).join("");
const MIXED = TWELVE.replace("l2\n", "L2\n").replace("l5\n", "l5\nnew\n").replace("l8\n", "");
const THIRTY = Array.from({ length: 30 }, (_, i) => `t${i + 1}\n`).join("");
const TWO_HUNKS = THIRTY.replace("t3\n", "T3\nT3b\n").replace("t25\n", "");
const FILE = { "f.txt": "a\nb\nc\nd\n" };
const STAGED = { "f.txt": "a\nB\nc\nd\n" };

describe("revert staged lines and hunks in the index and the working file (spec FR-016, plan.md D4, D13)", () => {
  caseTest(TASK, "line selections and whole hunks: the index equals git apply --cached -R on a copy, and the working file loses the same changes", SHELL, () =>
    withService({ name: "t038-lines" }, async (service) => {
      const repo = build("lines", { "mixed.txt": TWELVE, "two.txt": THIRTY, "ü/файл.txt": "u1\nu2\nu3\n", "keep.txt": "keep\n" }, { "mixed.txt": MIXED, "two.txt": TWO_HUNKS, "ü/файл.txt": "u1\nU2\nu3\nu4\n" });
      const r = await service.register(repo);
      // Mixed body: ` l1 -l2 +L2 l3 l4 l5 +new l6 l7 -l8 l9 l10 l11`. Each pick names positions in the list of its change ordinals.
      const picks: (number[] | null)[] = [[0], [1], [2], [3], [1, 2, 3], null];
      for (const pick of picks) await stagedCase(service, r, repo, "mixed.txt", 0, (h) => (pick === null ? null : pick.map((k) => changeOrdinals(h)[k]!)), true);
      // The second hunk starts at its index-side line, after the line count change of the first hunk.
      await stagedCase(service, r, repo, "two.txt", 1, () => null, true);
      await stagedCase(service, r, repo, "two.txt", 0, (h) => [changeOrdinals(h)[1]!], true);
      await stagedCase(service, r, repo, "ü/файл.txt", 0, (h) => [changeOrdinals(h).at(-1)!], true);
    }),
    LONG_TIMEOUT_MS,
  );

  // Spec FR-015 and data-model §6: with `core.autocrlf=true`, the index holds LF and the working file CRLF. A restored line takes CRLF.
  caseTest(TASK, "crlf-autocrlf-true: a restored line takes the working CRLF ending, and the index equals the oracle", SHELL, () =>
    withService({ name: "t038-crlf" }, async (service) => {
      const repo = build("crlf", { "f.txt": "a\r\nb\r\nc\r\nd\r\n" }, { "f.txt": "a\r\nB\r\nc\r\nd\r\n" }, [["core.autocrlf", "true"]]);
      const r = await service.register(repo);
      // Body ` a -b +B c d`: only the removed line, then the whole hunk.
      await stagedCase(service, r, repo, "f.txt", 0, (h) => [h.body.findIndex((l) => l[0] === "-") + 1], false, "a\r\nb\r\nB\r\nc\r\nd\r\n");
      await stagedCase(service, r, repo, "f.txt", 0, () => null, false, "a\r\nb\r\nc\r\nd\r\n");
    }),
    TIMEOUT_MS,
  );
});

describe("revert staged lines: refusals (data-model §7, plan.md D2, D4)", () => {
  async function refused(service: Service, r: RegistrationResult, repo: string, path: string, expected: { code: string; result?: object }): Promise<void> {
    const read = await readOk(service, r.repositoryId);
    const { c } = await comparisonOf(service, r, read, path);
    const before = state(repo);
    const response = await review(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! });
    expect({ path, ...refusal(response) }).toEqual({ path, state: "failed", code: expected.code, result: expected.result });
    expect({ path, state: state(repo), writes: writes(service) }).toEqual({ path, state: before, writes: 0 });
  }

  caseTest(TASK, "a file with unstaged changes refuses with unstaged-changes, and nothing changes (spec FR-016)", SHELL, () =>
    withService({ name: "t038-unstaged" }, async (service) => {
      const repo = build("unstaged", FILE, STAGED);
      write(repo, "f.txt", "a\nB\nc\nd\nE\n");
      const r = await service.register(repo);
      await refused(service, r, repo, "f.txt", { code: "WORKBENCH_UNAVAILABLE", result: { reason: "unstaged-changes" } });
    }),
    TIMEOUT_MS,
  );

  // Plan.md D2 and D7: only the staged part writes the index, so the unstaged revert of another file stays available.
  caseTest(TASK, "a post-index-change hook refuses the staged revert with index-change-hook and its remedy; an unstaged revert stays available", SHELL, () =>
    withService({ name: "t038-hook" }, async (service) => {
      const repo = build("hook", { ...FILE, "g.txt": "g1\ng2\n" }, STAGED);
      write(repo, "g.txt", "g1\nG2\n");
      const hook = join(gitPathOf(repo, "hooks"), "post-index-change");
      writeFileSync(hook, "#!/bin/sh\nexit 0\n");
      chmodSync(hook, 0o755);
      const r = await service.register(repo);
      await refused(service, r, repo, "f.txt", { code: "UNSUPPORTED_HUNK_PROFILE", result: { reason: "index-change-hook", remedy: { text: PROFILE_TEXTS["index-change-hook"] } } });
      const read = await readOk(service, r.repositoryId);
      const { c } = await comparisonOf(service, r, read, "g.txt", "unstaged");
      expect((await reviewOk(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! })).plan.scope).toBe("unstaged");
    }),
    TIMEOUT_MS,
  );

  // Contract §4 "WSL index publication": the double hosts no WSL workspace without a distro, so this case checks the eligibility rule of the review directly.
  // T042 runs the same refusal in `Ubuntu-26.04`.
  caseTest(TASK, "WSL: core.sharedRepository refuses only a review with an index part (shared-repository)", SHELL, async () => {
    // A dynamic import, so this case fails alone before T039 exports the rule.
    const revert = await import("../../src/git-service/revert");
    const shared = { scope: "local", origin: "file:.git/config", key: "core.sharedrepository", value: "group", exact: true, originBytes: new Uint8Array(), keyValueBytes: new Uint8Array() };
    const listing = { entries: [shared], hooks: { configured: [], folder: [], fatal: false } } as unknown as Parameters<typeof revert.revertEligibility>[2];
    expect({
      stagedWsl: revert.revertEligibility(null, "sha1", listing, true, true),
      unstagedWsl: revert.revertEligibility(null, "sha1", listing, true, false),
      stagedWindows: revert.revertEligibility(null, "sha1", listing, false, true),
    }).toEqual({ stagedWsl: { eligible: false, reason: "shared-repository" }, unstagedWsl: { eligible: true }, stagedWindows: { eligible: true } });
  });

  caseTest(TASK, "an index lock at the review, before the run, or at the index part refuses with LOCKED and the 001 lock guidance, and nothing changes", SHELL, async () => {
    let repo = "";
    let lockAtIndex = false;
    const lock = () => writeFileSync(`${gitPathOf(repo, "index")}.lock`, "");
    const unlock = () => rmSync(`${gitPathOf(repo, "index")}.lock`);
    await withService(
      {
        name: "t038-lock",
        revertCheckpoint: (c: RevertCheckpoint) => {
          if (c.step === "before-index" && lockAtIndex) lock();
        },
      },
      async (service) => {
        repo = build("lock", FILE, STAGED);
        const r = await service.register(repo);
        const read = await readOk(service, r.repositoryId);
        const { c } = await comparisonOf(service, r, read, "f.txt");
        const payload = { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! };
        const locked = { state: "failed", code: "LOCKED", result: { path: expect.stringMatching(/index\.lock$/), remedy: { text: LOCKED_REMEDY } } };
        const before = state(repo);
        lock();
        expect({ at: "review", ...refusal(await review(service, r, read, payload)) }).toEqual({ at: "review", ...locked });
        unlock();
        const token = (await reviewOk(service, r, read, payload)).workbenchToken;
        lock();
        expect({ at: "run start", ...refusal(await run(service, r, token)) }).toEqual({ at: "run start", ...locked });
        unlock();
        lockAtIndex = true;
        expect({ at: "index part", ...refusal(await run(service, r, (await reviewOk(service, r, read, payload)).workbenchToken)) }).toEqual({ at: "index part", ...locked });
        lockAtIndex = false;
        unlock();
        expect({ state: state(repo), writes: writes(service) }).toEqual({ state: before, writes: 0 });
      },
    );
  }, TIMEOUT_MS);
});

describe("revert staged lines: the index part stays when the working part does not revert (spec FR-017, plan.md D10)", () => {
  // The before-write seam: a second hard link keeps the bytes and changes the bound link count; a synthetic `stale` reply; another writer.
  const SEAMS = [
    { id: "hard-link", file: { outcome: "unstaged-only", code: "refused", reason: "hard-link" }, other: false },
    { id: "stale", file: { outcome: "unstaged-only", code: "stale" }, other: false },
    { id: "another-writer", file: { outcome: "changed-outside" }, other: true },
  ] as const;

  caseTest(TASK, "a published index part followed by a write that does not revert gives failed-with-effects; the index equals the oracle, and the file keeps its bytes", SHELL, async () => {
    let repo = "";
    let seam: (typeof SEAMS)[number]["id"] = "hard-link";
    let link = "";
    const seen: string[] = [];
    await withService(
      {
        name: "t038-partial",
        revertCheckpoint: (c: RevertCheckpoint) => {
          seen.push(c.step);
          if (c.step !== "before-write") return;
          if (seam === "hard-link") linkSync(join(repo, "f.txt"), link);
          if (seam === "another-writer") write(repo, "f.txt", "another writer\n");
        },
      },
      async (service) => {
        repo = build("partial", FILE, STAGED);
        link = join(fixtureDir("t038-link"), "f-link.txt");
        const r = await service.register(repo);
        for (const s of SEAMS) {
          seam = s.id;
          seen.length = 0;
          const read = await readOk(service, r.repositoryId);
          const { c, hunks, header } = await comparisonOf(service, r, read, "f.txt");
          const expected = oracle(repo, "f.txt", partialPatch(header, hunks[0]!, null), false);
          const reviewed = await reviewOk(service, r, read, { comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! });
          if (seam === "stale") service.runner.inject.workingReply = () => ({ result: "stale" });
          let done: ServiceResponse<RevertRun>;
          try {
            done = await run(service, r, reviewed.workbenchToken);
          } finally {
            service.runner.inject.workingReply = null;
          }
          expect({ seam, state: done.state, code: done.code, index: done.result?.index, files: done.result?.files }).toEqual({ seam, state: "failed-with-effects", code: "FAILED_WITH_EFFECTS", index: "published", files: [{ entryId: c.entry.entryId, ...s.file }] });
          expect({ seam, seen: [...seen] }).toEqual({ seam, seen: ["before-index", "before-write"] });
          // Spec FR-017: the index part stays, and the working file keeps its bytes or the other writer's bytes.
          expect({ seam, index: indexOf(repo), bytes: readFileSync(join(repo, "f.txt"), "utf8") }).toEqual({ seam, index: expected.index, bytes: s.other ? "another writer\n" : STAGED["f.txt"] });
          rmSync(link, { force: true });
          write(repo, "f.txt", STAGED["f.txt"]);
          add(repo, "f.txt");
        }
      },
    );
  }, TIMEOUT_MS);
});
