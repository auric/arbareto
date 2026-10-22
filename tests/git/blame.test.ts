// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T022: feature 005 contract Δ3 `readBlame` through the in-process service (plan.md P4, D12). Quickstart.md Q27 and Q28.
// Spec FR-003, FR-053 to FR-063, SC-006. The oracle is `git blame --porcelain` with the same options on a copy, line by line.

import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadBlameResult } from "../../src/contracts/envelope";
import { BLAME_PROGRESS_EVENTS_PER_SECOND, GIT_PROCESS_DEADLINE_MS, HISTORY_PROCESS_DEADLINE_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { FIXTURE_HOME, FIXTURE_ROOT, fixturePath, serviceEnv, useFixtureRoot } from "./fixture-root";
import { blameLarge, buildBlame, buildHistory, buildPatchBounds, buildShallowHistory, copyRepo, gitExit, runGit, type Built } from "./history-diff-fixtures";
import { fits, gitPath, load, waitFor } from "./history-view-harness";
import { caseTest, openService, type Service, type ServiceResponse } from "./service-harness";
import { canary } from "./workbench-fixtures";

printOrigin("../../src/git-service/blame.ts", import.meta.dir);
printOrigin("../../src/git-service/blame-parser.ts", import.meta.dir);
printOrigin("../../src/git-service/session.ts", import.meta.dir);

useFixtureRoot();

const TASK = "T022";
const SHELL = ["shell-double"] as const;
const TIMEOUT_MS = 300_000;
const LARGE_TIMEOUT_MS = 20 * 60_000;
const READ = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
const MARKS = ["-c", "blame.markIgnoredLines=true", "-c", "blame.markUnblamableLines=true"];

type Options = { ignoreWhitespace: boolean; detectMoves: boolean; detectCopies: boolean; ignoreList: boolean };
const OFF: Options = { ignoreWhitespace: false, detectMoves: false, detectCopies: false, ignoreList: true };
const flags = (o: Options) => [...(o.ignoreWhitespace ? ["-w"] : []), ...(o.detectMoves ? ["-M"] : []), ...(o.detectCopies ? ["-C"] : [])];

interface BlameCommit {
  oid: string;
  author: string;
  authorMail: string;
  authorTime: number;
  authorTz: string;
  summary: string;
  previous: { oid: string; pathBytes: string } | null;
  filenameBytes: string;
  shallow: boolean;
}
interface Blame {
  blameId: string;
  commit: string;
  pathBytes: string;
  content: string;
  lines: number;
  ignoreList: "none" | "on" | "off";
  focusLine?: number;
  groups: { commit: number; origStart: number; finalStart: number; count: number; ignored: boolean; unblamable: boolean }[];
  commits: BlameCommit[];
  reason?: string;
  path?: string;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const git = (repo: string, args: string[], env: Record<string, string | undefined> = {}) => runGit(gitPath(), FIXTURE_ROOT, repo, args, { env });
const text = (repo: string, args: string[]) => git(repo, args).toString("utf8");
const isBlame = (call: { arguments: readonly string[] }) => call.arguments.includes("blame");

async function withService(name: string, body: (service: Service) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const service = await openService({ git: gitPath(), name, watchHints: false, environment: serviceEnv({ GIT_CONFIG_NOSYSTEM: "1", ...env }) });
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
async function viewOf(service: Service, repo: string): Promise<Viewed> {
  const { repositoryId, generation } = await service.register(repo);
  const opened = await service.request<{ viewId: string }>("openHistory", { scope: "all" }, { repositoryId, repositoryGeneration: generation });
  await load(service, repositoryId, opened.result!.viewId, { end: true });
  return { repositoryId, repositoryGeneration: generation, viewId: opened.result!.viewId };
}

// The `{changesId, fileId}` source of `path` in the History listing of `oid` against parent `parent`.
async function historySource(service: Service, v: Viewed, oid: string, path: string, parent = 0): Promise<{ changesId: string; fileId: number }> {
  const changes = await service.request<{ changesId: string; files: { fileId: number; pathBytes: string }[] }>("readCommitChanges", { viewId: v.viewId, oid, parent }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });
  const file = changes.result!.files.find((f) => f.pathBytes === b64(path));
  if (file === undefined) throw new Error(`${path} is not in the listing of ${oid}`);
  return { changesId: changes.result!.changesId, fileId: file.fileId };
}

const readBlame = (service: Service, v: { repositoryId: string; repositoryGeneration: number }, source: object, options: Options = OFF) =>
  service.request<Blame>("readBlame", { source, options }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });

// One line of `git blame --porcelain`: the commit, the original line, the marks, and the filename that Git names for its group.
interface OracleLine {
  oid: string;
  orig: number;
  ignored: boolean;
  unblamable: boolean;
  filename: string;
}
function porcelainOracle(repo: string, commit: string, path: string, args: string[], env: Record<string, string | undefined> = {}): OracleLine[] {
  const out = git(repo, [...READ, ...args.filter((a) => a.startsWith("-c") || a.startsWith("blame.")), "blame", "--porcelain", "--no-textconv", "--encoding=none", ...args.filter((a) => !a.startsWith("-c") && !a.startsWith("blame.")), commit, "--", path], env).toString("latin1");
  const lines: OracleLine[] = [];
  const filenames = new Map<string, string>();
  let current: OracleLine | null = null;
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (header !== null) current = { oid: header[1]!, orig: Number(header[2]), ignored: false, unblamable: false, filename: filenames.get(header[1]!) ?? "" };
    else if (line.startsWith("filename ")) {
      filenames.set(current!.oid, line.slice("filename ".length));
      current!.filename = line.slice("filename ".length);
    } else if (line === "ignored") current!.ignored = true;
    else if (line === "unblamable") current!.unblamable = true;
    else if (line.startsWith("\t")) lines.push(current!);
  }
  return lines;
}

// The result expanded to lines in the oracle form.
function resultLines(b: Blame): OracleLine[] {
  const lines: OracleLine[] = [];
  for (const g of b.groups) {
    const c = b.commits[g.commit]!;
    for (let i = 0; i < g.count; i++) lines.push({ oid: c.oid, orig: g.origStart + i, ignored: g.ignored, unblamable: g.unblamable, filename: Buffer.from(c.filenameBytes, "base64").toString("latin1") });
  }
  return lines;
}

function expectAttribution(response: ServiceResponse<Blame>, oracle: OracleLine[], content: Buffer, where: object): void {
  fits(ReadBlameResult, response.result);
  const b = response.result!;
  expect({ ...where, state: response.state }).toEqual({ ...where, state: "succeeded" });
  expect({ ...where, lines: resultLines(b) }).toEqual({ ...where, lines: oracle });
  expect({ ...where, n: b.lines, content: Buffer.from(b.content, "base64").equals(content) }).toEqual({ ...where, n: oracle.length, content: true });
  expect(b.groups.reduce((n, g) => n + g.count, 0)).toBe(b.lines);
}

const CASES: [label: string, path: string][] = [
  ["b7", "tale.txt"],
  ["b5", "other.txt"],
  ["b8", "nolf.txt"],
  ["b2", "story.txt"],
  ["b4", "tale.txt"],
];
const OPTION_SETS: Options[] = [
  OFF,
  { ...OFF, ignoreWhitespace: true },
  { ...OFF, detectMoves: true },
  { ...OFF, detectCopies: true },
  { ignoreWhitespace: true, detectMoves: true, detectCopies: true, ignoreList: true },
];

describe("attribution (SC-006, FR-057, FR-058)", () => {
  caseTest(TASK, "every attribution equals git blame --porcelain with the same options, line by line, with -w, -M, and -C", SHELL, () =>
    withService("t022-attribution", async (service) => {
      const built = buildBlame(gitPath(), "t022-attribution");
      const copy = buildBlame(gitPath(), "t022-attribution-copy").repo;
      const v = await viewOf(service, built.repo);
      for (const [label, path] of CASES) {
        const source = await historySource(service, v, built.oids[label]!, path);
        for (const options of OPTION_SETS) {
          const response = await readBlame(service, v, source, options);
          const where = { label, path, options: flags(options).join("") };
          expectAttribution(response, porcelainOracle(copy, built.oids[label]!, path, flags(options)), git(copy, ["cat-file", "blob", `${built.oids[label]}:${path}`]), where);
          expect({ ...where, ignoreList: response.result!.ignoreList, commit: response.result!.commit, path: response.result!.pathBytes }).toEqual({ ...where, ignoreList: "none", commit: built.oids[label]!, path: b64(path) });
        }
      }
      // The copied lines of b5 keep the other file name (FR-055 "Path in this commit").
      const copied = (await readBlame(service, v, await historySource(service, v, built.oids.b5!, "tale.txt"), { ...OFF, detectCopies: true })).result!;
      expect(copied.commits.some((c) => Buffer.from(c.filenameBytes, "base64").toString() === "other.txt")).toBe(true);
      const blames = service.runner.calls.filter(isBlame);
      expect(blames.every((c) => READ.every((o, i) => c.arguments[i] === o) && c.arguments.includes("--no-textconv") && c.arguments.includes("--encoding=none") && c.arguments.includes("--incremental"))).toBe(true);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "every blame and its diffs pass --no-textconv and --no-ext-diff: the textconv, diff driver, and external diff canaries stay absent", SHELL, () =>
    withService("t022-textconv", async (service) => {
      const built = buildBlame(gitPath(), "t022-textconv");
      const c = canary(fixturePath("t022-textconv"), "textconv", "cat \"$1\"\n");
      for (const key of ["diff.canary.textconv", "diff.canary.command", "diff.external"]) git(built.repo, ["config", key, c.command]);
      writeFileSync(join(built.repo, ".gitattributes"), "* diff=canary\n");
      const v = await viewOf(service, built.repo);
      const response = await readBlame(service, v, await historySource(service, v, built.oids.b7!, "tale.txt"));
      expect(response.state).toBe("succeeded");
      const line = resultLines(response.result!).findIndex((l) => l.oid === built.oids.b7) + 1;
      expect((await readBlame(service, v, { blameId: response.result!.blameId, line })).state).toBe("succeeded");
      expect(service.runner.calls.some((c) => c.arguments.includes("-U0"))).toBe(true);
      expect(existsSync(c.log)).toBe(false);
      // The canary is live: Git's own blame without the option runs it.
      gitExit(gitPath(), FIXTURE_ROOT, built.repo, ["blame", built.oids.b7!, "--", "tale.txt"]);
      expect(existsSync(c.log)).toBe(true);
    }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "the 10,000-line file with 5,000 commits equals git blame --porcelain",
    SHELL,
    () =>
      withService("t022-large", async (service) => {
        const cached = blameLarge(gitPath());
        const repo = copyRepo(cached.repo, "t022-large-repo");
        const { repositoryId } = await service.register(repo);
        writeFileSync(join(repo, "big.txt"), `${readFileSync(join(repo, "big.txt"), "utf8")}tail\n`);
        const again = await service.readWorkspace(repositoryId);
        const entry = again.result!.entries.find((e) => e.path === "big.txt")!;
        const response = await readBlame(service, { repositoryId, repositoryGeneration: again.result!.generation }, { snapshotId: again.result!.snapshotId, entryId: entry.entryId });
        expectAttribution(response, porcelainOracle(repo, cached.oids.tip!, "big.txt", []), git(repo, ["cat-file", "blob", `${cached.oids.tip}:big.txt`]), { file: "big.txt" });
        expect(response.result!.groups.length).toBeGreaterThan(4000);
      }),
    LARGE_TIMEOUT_MS,
  );
});

describe("sources (FR-053)", () => {
  caseTest(TASK, "a History row, a deleted History row at the chosen parent, and a Commit view row at HEAD; an unborn HEAD gives no-history", SHELL, () =>
    withService("t022-sources", async (service) => {
      const history = buildHistory(gitPath(), "t022-sources-history");
      const hv = await viewOf(service, history.repo);
      // Status D blames the old path at the chosen parent.
      const deleted = await readBlame(service, hv, await historySource(service, hv, history.oids.normal!, "del.txt"));
      expectAttribution(deleted, porcelainOracle(history.repo, history.oids.root!, "del.txt", []), git(history.repo, ["cat-file", "blob", `${history.oids.root}:del.txt`]), { source: "deleted" });
      expect(deleted.result!.commit).toBe(history.oids.root!);

      const built = buildBlame(gitPath(), "t022-sources");
      const { repositoryId } = await service.register(built.repo);
      writeFileSync(join(built.repo, "tale.txt"), `${readFileSync(join(built.repo, "tale.txt"), "utf8")}working line\n`);
      const read = (await service.readWorkspace(repositoryId)).result!;
      const entry = read.entries.find((e) => e.path === "tale.txt")!;
      const working = await readBlame(service, { repositoryId, repositoryGeneration: read.generation }, { snapshotId: read.snapshotId, entryId: entry.entryId });
      expectAttribution(working, porcelainOracle(built.repo, built.oids.b8!, "tale.txt", []), git(built.repo, ["cat-file", "blob", `${built.oids.b8}:tale.txt`]), { source: "commit view" });
      expect(working.result!.commit).toBe(built.oids.b8!);

      // An unborn HEAD: a staged file in a repository without commits.
      const unborn = fixturePath("t022-sources-unborn");
      mkdirSync(unborn, { recursive: true });
      git(unborn, ["init", "-q", "-b", "main"]);
      writeFileSync(join(unborn, "new.txt"), "new\n");
      git(unborn, ["add", "new.txt"]);
      const u = await service.register(unborn);
      const ur = (await service.readWorkspace(u.repositoryId)).result!;
      const before = service.runner.calls.length;
      const refused = await readBlame(service, { repositoryId: u.repositoryId, repositoryGeneration: ur.generation }, { snapshotId: ur.snapshotId, entryId: ur.entries[0]!.entryId });
      expect({ state: refused.state, code: refused.code, result: refused.result }).toEqual({ state: "failed", code: "BLAME_UNAVAILABLE", result: { reason: "no-history" } as Blame });
      expect(service.runner.calls.slice(before)).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "refusals before any blame process: submodule, size, binary, lines, no-history, and no-previous", SHELL, () =>
    withService("t022-refusals", async (service) => {
      const built = buildBlame(gitPath(), "t022-refusals");
      const v = await viewOf(service, built.repo);
      const reasons: Record<string, unknown> = {};
      const refusal = async (name: string, view: Viewed, source: object) => {
        const r = await readBlame(service, view, source);
        fits(ReadBlameResult, r.result);
        reasons[name] = { state: r.state, code: r.code, reason: r.result?.reason };
      };
      // A line of the root commit has no `previous` header.
      const root = await readBlame(service, v, await historySource(service, v, built.oids.b1!, "story.txt"));
      const before = service.runner.calls.filter(isBlame).length;
      await refusal("no-previous", v, { blameId: root.result!.blameId, line: 1 });
      await refusal("submodule", v, await historySource(service, v, built.oids.b1!, "lib"));
      await refusal("binary", v, await historySource(service, v, built.oids.b1!, "bin.dat"));
      writeFileSync(join(built.repo, "untracked.txt"), "untracked\n");
      const read = (await service.readWorkspace(v.repositoryId)).result!;
      const untracked = read.entries.find((e) => e.path === "untracked.txt")!;
      await refusal("no-history", { repositoryId: v.repositoryId, repositoryGeneration: read.generation, viewId: v.viewId }, { snapshotId: read.snapshotId, entryId: untracked.entryId });
      // One view per service session: this view releases the first one.
      const bounds = buildPatchBounds(gitPath(), "t022-refusals-bounds");
      const bv = await viewOf(service, bounds.repo);
      await refusal("size", bv, await historySource(service, bv, bounds.oids.bytes!, "wide.txt"));
      await refusal("lines", bv, await historySource(service, bv, bounds.oids.hugelines!, "huge-lines.txt"));
      expect(service.runner.calls.filter(isBlame).length).toBe(before);
      const unavailable = (reason: string) => ({ state: "failed", code: "BLAME_UNAVAILABLE", reason });
      expect(reasons).toEqual({ submodule: unavailable("submodule"), binary: unavailable("binary"), size: unavailable("size"), lines: unavailable("lines"), "no-history": unavailable("no-history"), "no-previous": unavailable("no-previous") });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "Blame before this commit runs for the previous commit and path of the line's group, also with diff.interHunkContext=3 (Q28)", SHELL, () =>
    withService("t022-before", async (service) => {
      const built = buildBlame(gitPath(), "t022-before");
      const v = await viewOf(service, built.repo);
      const first = (await readBlame(service, v, await historySource(service, v, built.oids.b7!, "tale.txt"))).result!;
      const line = resultLines(first).findIndex((l) => l.oid === built.oids.b7) + 1;
      expect(line).toBeGreaterThan(0);
      const diffs = () => service.runner.calls.filter((c) => c.arguments.includes("-U0"));
      for (const configured of [false, true]) {
        if (configured) git(built.repo, ["config", "diff.interHunkContext", "3"]);
        const again = (await readBlame(service, v, await historySource(service, v, built.oids.b7!, "tale.txt"))).result!;
        const before = await readBlame(service, v, { blameId: again.blameId, line });
        const group = again.groups.find((g) => g.finalStart <= line && line < g.finalStart + g.count)!;
        const previous = again.commits[group.commit]!.previous!;
        expect({ configured, state: before.state, commit: before.result!.commit, path: before.result!.pathBytes }).toEqual({ configured, state: "succeeded", commit: previous.oid, path: previous.pathBytes });
        expectAttribution(before, porcelainOracle(built.repo, previous.oid, Buffer.from(previous.pathBytes, "base64").toString(), []), git(built.repo, ["cat-file", "blob", `${previous.oid}:${Buffer.from(previous.pathBytes, "base64").toString()}`]), { configured });
        expect(diffs().at(-1)!.arguments.slice(0, 7)).toEqual(["--no-lazy-fetch", "--no-optional-locks", "diff", "-U0", "--inter-hunk-context=0", "--no-textconv", "--no-ext-diff"]);
        // Data-model §11: the line lies inside a hunk of Git's own zero-context diff, so it maps to that hunk's old start.
        const origin = again.commits[group.commit]!;
        const o = group.origStart + (line - group.finalStart);
        const blobAt = (oid: string, pathBytes: string) => text(built.repo, ["rev-parse", `${oid}:${Buffer.from(pathBytes, "base64").toString()}`]).trim();
        const headers = text(built.repo, ["diff", "-U0", "--inter-hunk-context=0", "--no-textconv", "--no-ext-diff", "--no-color", blobAt(previous.oid, previous.pathBytes), blobAt(origin.oid, origin.filenameBytes)])
          .split("\n")
          .map((l) => /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l))
          .filter((m) => m !== null)
          .map((m) => ({ a: Number(m![1]), b: Number(m![2] ?? 1), c: Number(m![3]), d: Number(m![4] ?? 1) }));
        const hunk = headers.find((h) => h.d > 0 && h.c <= o && o < h.c + h.d)!;
        expect({ configured, focusLine: before.result!.focusLine }).toEqual({ configured, focusLine: hunk.b === 0 ? hunk.a + 1 : hunk.a });
      }
      // Data-model §10: only a `{blameId, line}` source carries `focusLine`.
      expect(first.focusLine).toBeUndefined();
      // An older blameId gives UNKNOWN_TARGET, because the workspace keeps one blame result.
      expect((await readBlame(service, v, { blameId: first.blameId, line })).code).toBe("UNKNOWN_TARGET");
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "Blame before this commit runs steps 1 to 6 for the previous version first: binary and oversize give their reasons before any diff, and an empty version gives no focusLine (contract Δ3)", SHELL, () =>
    withService("t022-before-refusals", async (service) => {
      const built = buildBlame(gitPath(), "t022-before-refusals");
      const v = await viewOf(service, built.repo);
      const diffs = () => service.runner.calls.filter((c) => c.arguments.includes("-U0")).length;
      const beforeOf = async (view: Viewed, oid: string, path: string) => {
        const r = (await readBlame(service, view, await historySource(service, view, oid, path))).result!;
        return readBlame(service, view, { blameId: r.blameId, line: 1 });
      };
      const start = diffs();
      const binary = await beforeOf(v, built.oids.b8!, "bin.dat");
      expect({ state: binary.state, code: binary.code, reason: binary.result?.reason }).toEqual({ state: "failed", code: "BLAME_UNAVAILABLE", reason: "binary" });
      expect(diffs()).toBe(start);
      const empty = await beforeOf(v, built.oids.b8!, "empty.txt");
      fits(ReadBlameResult, empty.result);
      expect({ state: empty.state, commit: empty.result!.commit, lines: empty.result!.lines, focus: "focusLine" in empty.result! }).toEqual({ state: "succeeded", commit: built.oids.b7!, lines: 0, focus: false });
      const bounds = buildPatchBounds(gitPath(), "t022-before-refusals-bounds");
      const bv = await viewOf(service, bounds.repo);
      const at = diffs();
      const size = await beforeOf(bv, bounds.oids.shrink!, "wide.txt");
      expect({ state: size.state, code: size.code, reason: size.result?.reason }).toEqual({ state: "failed", code: "BLAME_UNAVAILABLE", reason: "size" });
      expect(diffs()).toBe(at);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "a path that is no valid UTF-8 gives BLAME_UNAVAILABLE path, and readCommitFile gives UNSUPPORTED_COMPARISON path, before any Git process of the file", SHELL, () =>
    withService("t022-bad-path", async (service) => {
      const repo = fixturePath("t022-bad-path/repo");
      mkdirSync(repo, { recursive: true });
      git(repo, ["init", "-q", "-b", "main"]);
      const stream = Buffer.concat([Buffer.from("commit refs/heads/main\ncommitter F <f@x.invalid> 1767225600 +0000\ndata 2\nc1\nM 100644 inline bad"), Buffer.from([0xff]), Buffer.from(".txt\ndata 2\nx\n\n")]);
      runGit(gitPath(), FIXTURE_ROOT, repo, ["fast-import", "--quiet"], { input: stream });
      const v = await viewOf(service, repo);
      const oid = text(repo, ["rev-parse", "main"]).trim();
      const changes = await service.request<{ changesId: string; files: { fileId: number; pathBytes: string }[] }>("readCommitChanges", { viewId: v.viewId, oid, parent: 0 }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });
      const file = changes.result!.files[0]!;
      expect(Buffer.from(file.pathBytes, "base64")).toEqual(Buffer.concat([Buffer.from("bad"), Buffer.from([0xff]), Buffer.from(".txt")]));
      const before = service.runner.calls.length;
      const blamed = await readBlame(service, v, { changesId: changes.result!.changesId, fileId: file.fileId });
      fits(ReadBlameResult, blamed.result);
      expect({ state: blamed.state, code: blamed.code, result: blamed.result }).toEqual({ state: "failed", code: "BLAME_UNAVAILABLE", result: { reason: "path" } as Blame });
      const read = await service.request<{ reason?: string }>("readCommitFile", { changesId: changes.result!.changesId, fileId: file.fileId }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });
      expect({ state: read.state, code: read.code, result: read.result }).toEqual({ state: "failed", code: "UNSUPPORTED_COMPARISON", result: { reason: "path" } });
      expect(service.runner.calls.slice(before).filter((c) => c.arguments.includes("blame") || c.arguments.includes("ls-tree") || c.arguments.includes("diff-tree"))).toEqual([]);
    }),
    TIMEOUT_MS,
  );
});

describe("ignore list (FR-059, FR-060, plan.md D12 step 4, O-9)", () => {
  caseTest(TASK, "every non-empty value from every scope counts, an empty value resets nothing, and the toggle off runs --incremental with --ignore-revs-file=", SHELL, async () => {
    const home = FIXTURE_HOME;
    const globalConfig = join(home, "t022-global.gitconfig");
    const built = buildBlame(gitPath(), "t022-ignore");
    writeFileSync(join(built.repo, ".revs"), `${built.oids.b7}\n`);
    writeFileSync(join(built.repo, ".revs2"), `${built.oids.b6}\n`);
    writeFileSync(join(home, "t022-home.revs"), `${built.oids.b5}\n`);
    writeFileSync(globalConfig, `${readFileSync(join(home, ".gitconfig"), "utf8")}[blame]\n\tignoreRevsFile = ~/t022-home.revs\n`);
    for (const value of [".revs", "", ".revs2", ":(optional)absent.revs"]) git(built.repo, ["config", "--add", "blame.ignoreRevsFile", value]);
    const env = { GIT_CONFIG_GLOBAL: globalConfig };
    await withService(
      "t022-ignore",
      async (service) => {
        const v = await viewOf(service, built.repo);
        const source = await historySource(service, v, built.oids.b7!, "tale.txt");
        const on = await readBlame(service, v, source, OFF);
        const content = git(built.repo, ["cat-file", "blob", `${built.oids.b7}:tale.txt`]);
        expectAttribution(on, porcelainOracle(built.repo, built.oids.b7!, "tale.txt", MARKS, env), content, { toggle: "on" });
        expect(on.result!.ignoreList).toBe("on");
        expect(on.result!.groups.some((g) => g.ignored || g.unblamable)).toBe(true);
        const onCall = service.runner.calls.filter(isBlame).at(-1)!;
        expect(onCall.arguments.slice(0, 8)).toEqual([...READ, ...MARKS, "blame"]);
        expect(onCall.arguments).toContain("--porcelain");
        // The effective list holds all three files: dropping one changes Git's marks.
        const fewer = porcelainOracle(built.repo, built.oids.b7!, "tale.txt", [...MARKS, "--ignore-revs-file=", "--ignore-revs-file=.revs"], env);
        expect(JSON.stringify(fewer)).not.toBe(JSON.stringify(resultLines(on.result!)));
        const off = await readBlame(service, v, source, { ...OFF, ignoreList: false });
        expectAttribution(off, porcelainOracle(built.repo, built.oids.b7!, "tale.txt", ["--ignore-revs-file="], env), content, { toggle: "off" });
        expect(off.result!.ignoreList).toBe("off");
        expect(off.result!.groups.every((g) => !g.ignored && !g.unblamable)).toBe(true);
        const offCall = service.runner.calls.filter(isBlame).at(-1)!;
        expect(offCall.arguments).toContain("--incremental");
        expect(offCall.arguments).toContain("--ignore-revs-file=");
        expect(offCall.arguments.slice(0, 4)).toEqual([...READ, "blame"]);
      },
      env,
    );
  }, TIMEOUT_MS);

  caseTest(TASK, "a missing relative file gives ignore-revs-file-missing with path in both toggle states, before any blame process", SHELL, () =>
    withService("t022-missing", async (service) => {
      const built = buildBlame(gitPath(), "t022-missing");
      git(built.repo, ["config", "--add", "blame.ignoreRevsFile", "missing.revs"]);
      const v = await viewOf(service, built.repo);
      const source = await historySource(service, v, built.oids.b7!, "tale.txt");
      const before = service.runner.calls.filter(isBlame).length;
      for (const ignoreList of [true, false]) {
        const r = await readBlame(service, v, source, { ...OFF, ignoreList });
        fits(ReadBlameResult, r.result);
        expect({ ignoreList, state: r.state, code: r.code, result: r.result }).toEqual({ ignoreList, state: "failed", code: "BLAME_UNAVAILABLE", result: { reason: "ignore-revs-file-missing", path: "missing.revs" } as Blame });
      }
      expect(service.runner.calls.filter(isBlame).length).toBe(before);
      const configGet = service.runner.calls.filter((c) => c.arguments.includes("config") && c.arguments.includes("get"));
      expect(configGet.at(-1)!.arguments).toEqual(["--no-lazy-fetch", "--no-optional-locks", "config", "get", "--all", "--type=path", "-z", "blame.ignoreRevsFile"]);
    }),
    TIMEOUT_MS,
  );
});

describe("shallow, progress, the read gate, and Cancel", () => {
  caseTest(TASK, "the shallow set decides the shallow state, not the boundary header (FR-062)", SHELL, () =>
    withService("t022-shallow", async (service) => {
      const source = buildBlame(gitPath(), "t022-shallow-source");
      const repo = buildShallowHistory(gitPath(), source as Built, "t022-shallow", 2);
      const v = await viewOf(service, repo);
      const r = (await readBlame(service, v, await historySource(service, v, source.oids.b8!, "nolf.txt"))).result!;
      const byOid = Object.fromEntries(r.commits.map((c) => [c.oid, c.shallow]));
      expect(byOid).toEqual({ [source.oids.b7!]: true, [source.oids.b8!]: false });
      // In a full clone the root commit carries `boundary`, and it is not shallow.
      const full = await viewOf(service, source.repo);
      const rooted = (await readBlame(service, full, await historySource(service, full, source.oids.b2!, "story.txt"))).result!;
      expect(rooted.commits.find((c) => c.oid === source.oids.b1)!.shallow).toBe(false);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "incremental blame sends blame events with blamed and total at most 4 per second; porcelain sends events without counters (FR-063)", SHELL, () =>
    withService("t022-progress", async (service) => {
      const built = buildBlame(gitPath(), "t022-progress");
      writeFileSync(join(built.repo, ".revs"), `${built.oids.b7}\n`);
      const v = await viewOf(service, built.repo);
      const source = await historySource(service, v, built.oids.b7!, "tale.txt");
      const started = performance.now();
      const plain = service.send("readBlame", { source, options: OFF }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });
      const done = (await service.response<Blame>(plain)).result!;
      const elapsed = (performance.now() - started) / 1000;
      const events = (service.progress as { requestId: string; phase?: string; counters: Record<string, number> }[]).filter((e) => e.requestId === plain && e.phase === "blame");
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => Object.keys(e.counters).toSorted().join() === "blamed,total" && e.counters.total === done.lines && e.counters.blamed! <= done.lines)).toBe(true);
      expect(events.length).toBeLessThanOrEqual(Math.ceil(elapsed * BLAME_PROGRESS_EVENTS_PER_SECOND) + 1);
      git(built.repo, ["config", "blame.ignoreRevsFile", ".revs"]);
      const listed = service.send("readBlame", { source, options: OFF }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration });
      await service.response(listed);
      const porcelain = (service.progress as { requestId: string; phase?: string; counters: Record<string, number> }[]).filter((e) => e.requestId === listed && e.phase === "blame");
      expect(porcelain.length).toBeGreaterThan(0);
      expect(porcelain.every((e) => Object.keys(e.counters).length === 0)).toBe(true);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, "no read gate: blame runs in an untrusted repository, and the core.fsmonitor canary stays absent (FR-003)", SHELL, () =>
    withService("t022-gate", async (service) => {
      const built = buildBlame(gitPath(), "t022-gate");
      const v = await viewOf(service, built.repo);
      const source = await historySource(service, v, built.oids.b7!, "tale.txt");
      const c = canary(fixturePath("t022-gate"), "fsmonitor");
      git(built.repo, ["config", "core.fsmonitor", c.command]);
      const r = await readBlame(service, v, source);
      expect(r.state).toBe("succeeded");
      const line = resultLines(r.result!).findIndex((l) => l.oid === built.oids.b7) + 1;
      expect((await readBlame(service, v, { blameId: r.result!.blameId, line })).state).toBe("succeeded");
      expect(existsSync(c.log)).toBe(false);
      // The repository is untrusted now: the gated History read refuses.
      expect((await service.request("readCommitChanges", { viewId: v.viewId, oid: built.oids.b6!, parent: 0 }, { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration })).code).toBe("TRUST_REQUIRED");
      expect(existsSync(c.log)).toBe(false);
    }),
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "Cancel ends Git within 1 s, with and without an ignore list; the blame step runs under the 120-second deadline and every other step under 30 s",
    SHELL,
    () =>
      withService("t022-cancel", async (service) => {
        const cached = blameLarge(gitPath());
        const repo = copyRepo(cached.repo, "t022-cancel-repo");
        writeFileSync(join(repo, ".revs"), `${text(repo, ["rev-parse", "HEAD~1"]).trim()}\n`);
        const { repositoryId } = await service.register(repo);
        writeFileSync(join(repo, "big.txt"), `${readFileSync(join(repo, "big.txt"), "utf8")}tail\n`);
        const read = (await service.readWorkspace(repositoryId)).result!;
        const entry = read.entries.find((e) => e.path === "big.txt")!;
        const target = { repositoryId, repositoryGeneration: read.generation };
        for (const list of [false, true]) {
          if (list) git(repo, ["config", "blame.ignoreRevsFile", ".revs"]);
          const request = service.send("readBlame", { source: { snapshotId: read.snapshotId, entryId: entry.entryId }, options: OFF }, target);
          await waitFor("blame process", () => service.runner.calls.some((c) => isBlame(c) && c.exit === undefined), 60_000);
          const at = performance.now();
          await service.cancel(await service.operationId(request));
          const response = await service.response(request);
          await waitFor("no live process", () => service.runner.liveRecorded() === 0, 5_000);
          const took = performance.now() - at;
          console.log(`OBSERVATION ${TASK}: Cancel of a 10,000-line blame with ignore list ${list} ended Git in ${Math.round(took)} ms`);
          expect({ list, state: response.state, within: took <= 1000 }).toEqual({ list, state: "canceled", within: true });
        }
        const calls = service.runner.calls.filter((c) => c.operationId !== undefined && c.contextKind === "registeredOperation");
        const blameDeadlines = new Set(calls.filter(isBlame).map((c) => c.limits?.deadlineMs));
        expect([...blameDeadlines]).toEqual([HISTORY_PROCESS_DEADLINE_MS]);
        const steps = calls.filter((c) => !isBlame(c) && (c.arguments.includes("ls-tree") || c.arguments.includes("cat-file") || (c.arguments.includes("config") && c.arguments.includes("get"))));
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.every((c) => c.limits?.deadlineMs === GIT_PROCESS_DEADLINE_MS)).toBe(true);
      }),
    LARGE_TIMEOUT_MS,
  );
});
