// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T093: `readComparison` (contract §3, §4, §5, §7; data-model §5). `src/git-service/comparison.ts` comes with T105.

import { describe, expect } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { COMPARED_RAW_VERSION_BYTES, NATIVE_CHUNK_BYTES, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS } from "../../src/contracts/limits";
import { fixtureDir, fixtureEnv, useFixtureRoot } from "./fixture-root";
import { buildF01, buildF02, buildF03, buildF04, buildF04Stage, buildF05, buildF10, buildF16Comparison, buildF17, buildFileAccepted, put, run, type F04Variant, type Repo } from "./fixtures";
import { indexEntries } from "./git-oracle";
import {
  approve,
  blobBytes,
  blobOf,
  compare,
  copyRepo,
  entryOf,
  git,
  gitPath,
  gitText,
  hunksOf,
  newSide,
  one,
  oraclePatch,
  outcome,
  patchOf,
  readOk,
  repoOf,
  repoState,
  resultOf,
  SUCCEEDED,
  TIMEOUT_MS,
  todoCase,
  underTest,
  valuesOf,
  withService,
  type Comparison,
} from "./hunk-harness";
import { caseTest, type Capability, type Service } from "./service-harness";

const TASK = "T093";
const SHELL: Capability[] = ["shell-double"];

useFixtureRoot();

const REMEDY_TEXT = "This command stages or unstages the whole file with your Git settings. Run it in a terminal.";
// Contract §4 "Quoting rule": PowerShell ends a single-quoted string at these five characters.
const QUOTES = ["'", "‘", "’", "‚", "‛"] as const;
const quote = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
const addRemedy = (root: string, ...paths: string[]) => `& ${quote(gitPath())} --literal-pathspecs -C ${quote(root)} add -- ${paths.map(quote).join(" ")}`;
const restoreRemedy = (root: string, path: string) => `& ${quote(gitPath())} --literal-pathspecs -C ${quote(root)} restore --staged -- ${quote(path)}`;
const rmCachedRemedy = (root: string, path: string) => `& ${quote(gitPath())} --literal-pathspecs -C ${quote(root)} rm --cached -- ${quote(path)}`;

const support = (c: Comparison) => one<string>(resultOf(c), "support");
const fileAction = (c: Comparison) => one<string>(resultOf(c), "fileAction");
const scope = (c: Comparison) => one<string>(resultOf(c), "scope");
const remedies = (c: Comparison) => valuesOf(resultOf(c), "remedy").filter((r) => r !== null && r !== undefined) as { text: string; command: string | null }[];
const remedy = (c: Comparison) => {
  const found = remedies(c);
  expect(found.length).toBe(1);
  return found[0]!;
};

// Twelve lines; lines 2 and 11 changed, as `buildF04` writes them.
const eolText = (style: "lf" | "crlf" | "mixed", changed: boolean) =>
  Array.from({ length: 12 }, (_, i) => i + 1)
    .map((n) => `line ${n}${changed && (n === 2 || n === 11) ? " changed" : ""}${style === "crlf" || (style === "mixed" && n % 2 === 1) ? "\r\n" : "\n"}`)
    .join("");

// The four untracked files of the T092 probe in `folder`. `u-noeol.txt` is LF text without the last LF.
function putUntracked(repo: string, folder: string): string[] {
  const files = { "u-lf.txt": eolText("lf", true), "u-crlf.txt": eolText("crlf", true), "u-mixed.txt": eolText("mixed", true), "u-noeol.txt": eolText("lf", true).slice(0, -1) };
  for (const [name, text] of Object.entries(files)) put(repo, `${folder}${name}`, text);
  return Object.keys(files).map((name) => `${folder}${name}`);
}

const F04_FOLDERS: Record<F04Variant, string[]> = {
  "autocrlf-false": [""],
  "autocrlf-true": [""],
  "autocrlf-input": [""],
  "eol-crlf": [""],
  safecrlf: [""],
  attributes: ["text/", "auto/", "binary/", "eol/", "crlf/"],
};

// A logging canary outside the worktree.
function canary(root: string, name: string): { command: string; log: string } {
  const log = join(root, "canaries", `t093-${name}.log`);
  const script = put(root, `canaries/t093-${name}.sh`, `#!/bin/sh\necho "${name} $*" >> '${log.replaceAll("\\", "/")}'\ncat "$1" 2>/dev/null\n`);
  return { command: `'${script.replaceAll("\\", "/")}'`, log };
}

// A committed repository in `dir` whose working file `path` changed. A `filter` attribute without a driver gives the file reason `filter`.
function filteredRepo(dir: string, path: string): Repo {
  mkdirSync(dir, { recursive: true });
  const r: Repo = { git: gitPath(), dir, pre: [] };
  run(r, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"], ["core.filemode", "false"]]) run(r, ["config", key!, value!]);
  put(dir, ".gitattributes", "*.txt filter=t093\n");
  put(dir, path, "one\n");
  run(r, ["--literal-pathspecs", "add", "--", ".gitattributes", path]);
  run(r, ["commit", "-q", "--no-verify", "-m", "base"]);
  put(dir, path, "two\n");
  return r;
}

// Contract §7 "Protected programs that change trust": a system-scope `git-lfs filter-process` can install hooks during the first F05 read. The user then approves the new fingerprint.
async function approvedRead(service: Service, repositoryId: string) {
  await approve(service, repositoryId);
  await service.readWorkspace(repositoryId);
  await approve(service, repositoryId);
  return readOk(service, repositoryId);
}

const MARKER = "arbareto-t093-marker";
// Contract §4 quoting cases: one worktree root and one file name per quote character, each with the payload `; ni <marker>`. The root payload ends with `#`.
const hostile = (q: string, i: number) => ({ dir: join(fixtureDir(`t093-quote-${i}`), `w${q}; ni ${MARKER}#`), path: `f${q}; ni ${MARKER}.txt` });

describe("comparison scopes and tracked hunks (contract §4, data-model §5)", () => {
  caseTest(TASK, `F02 gives two distinct entryId values and comparisons for one path, and each tracked hunk equals the git add -p oracle hunk, sent as base64`, SHELL, () =>
    withService({ name: "t093-scopes" }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), "t093-scopes"));
      const expected = { staged: hunksOf(oraclePatch(repo, "multi.txt", "head-to-index")), unstaged: hunksOf(oraclePatch(repo, "multi.txt", "index-to-worktree")) };
      expect({ staged: expected.staged.length, unstaged: expected.unstaged.length }).toEqual({ staged: 1, unstaged: 2 });
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const staged = await compare(service, repositoryId, "multi.txt", "staged", read);
      const unstaged = await compare(service, repositoryId, "multi.txt", "unstaged", read);
      expect({ staged: outcome(staged.response), unstaged: outcome(unstaged.response) }).toEqual({ staged: SUCCEEDED, unstaged: SUCCEEDED });
      expect(staged.entry.entryId).not.toBe(unstaged.entry.entryId);
      expect(staged.comparisonId).not.toBe(unstaged.comparisonId);
      expect({ staged: scope(staged), unstaged: scope(unstaged) }).toEqual({ staged: "head-to-index", unstaged: "index-to-worktree" });
      expect({ staged: support(staged), unstaged: support(unstaged) }).toEqual({ staged: "supported", unstaged: "supported" });
      expect(hunksOf(patchOf(staged.response.result))).toEqual(expected.staged);
      expect(hunksOf(patchOf(unstaged.response.result))).toEqual(expected.unstaged);
      expect({ staged: staged.hunkIds.length, unstaged: unstaged.hunkIds.length }).toEqual({ staged: 1, unstaged: 2 });
      expect(new Set([...staged.hunkIds, ...unstaged.hunkIds]).size).toBe(3);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F01: an unborn staged comparison uses an empty committed baseline`, SHELL, () =>
    withService({ name: "t093-unborn" }, async (service) => {
      const repo = repoOf(buildF01(gitPath(), "t093-unborn", "unborn-added"));
      const expected = hunksOf(oraclePatch(repo, "first.txt", "head-to-index", true));
      expect(expected.length).toBe(1);
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "first.txt", "staged");
      expect(outcome(c.response)).toEqual(SUCCEEDED);
      expect(scope(c)).toBe("head-to-index");
      expect(hunksOf(patchOf(c.response.result))).toEqual(expected);
      expect(c.hunkIds.length).toBe(1);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F01: a metadata-only empty-file change has no selectable hunk`, SHELL, () =>
    withService({ name: "t093-empty-file" }, async (service) => {
      const repo = repoOf(buildF01(gitPath(), "t093-empty-file", "unborn-added"));
      expect(hunksOf(oraclePatch(repo, "empty.txt", "head-to-index", true))).toEqual([]);
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const c = await compare(service, repositoryId, "empty.txt", "staged");
      expect(outcome(c.response)).toEqual(SUCCEEDED);
      expect(c.hunkIds).toEqual([]);
    }),
    TIMEOUT_MS,
  );
});

describe("support decisions (data-model §5)", () => {
  caseTest(TASK, `each F05 case returns its reason, and no comparison runs a filter canary`, SHELL, () =>
    withService({ name: "t093-f05" }, async (service) => {
      const built = buildF05(gitPath(), "t093-f05");
      const repo = repoOf(built, "super");
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await approvedRead(service, repositoryId);
      // Contract §7: an approved read may run the approved clean filter. Status reads it for a stat-dirty path. No comparison may run it.
      const canaryLogs = () => Object.fromEntries(readdirSync(join(built.root, "canaries")).filter((name) => name.endsWith(".log")).map((name) => [name, readFileSync(join(built.root, "canaries", name), "utf8")]));
      const before = canaryLogs();
      // Each path, category, and reason by contract §4 and data-model §5.
      const cases: [string, "staged" | "unstaged", string[]][] = [
        ["rename-dst.txt", "staged", ["rename"]],
        ["mode.sh", "staged", ["mode"]],
        ["binary.dat", "unstaged", ["binary"]],
        ["invalid-utf8.txt", "unstaged", ["encoding"]],
        ["text.u16", "unstaged", ["encoding"]],
        ["link", "unstaged", ["symlink"]],
        ["sub-moved", "unstaged", ["submodule"]],
        ["asset.psd", "unstaged", ["LFS"]],
        ["custom.cf", "unstaged", ["filter"]],
        // Contract §4 "File staging": a type change with a symbolic link on either side gives `type`. `symlink` applies only without a type change.
        // Status prints `TM` with modes 100644 120000 120000: only the staged side is a type change, and the unstaged side compares two symbolic links.
        ["type-change.txt", "staged", ["type"]],
        ["type-change.txt", "unstaged", ["symlink"]],
      ];
      for (const [path, category, reasons] of cases) {
        const c = await compare(service, repositoryId, path, category, read);
        expect({ path, category, ...outcome(c.response) }).toEqual({ path, category, ...SUCCEEDED });
        const reason = support(c);
        expect({ path, category, reason: reasons.includes(reason) ? reasons : reason, hunks: c.hunkIds }).toEqual({ path, category, reason: reasons, hunks: [] });
      }
      expect(canaryLogs()).toEqual(before);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F04 mixed files give line-endings and no hunk, and a normalization-only difference gives no selectable hunk`, SHELL, () =>
    withService({ name: "t093-mixed" }, async (service) => {
      const built = buildF04(gitPath(), "t093-mixed", "autocrlf-true");
      const repo = repoOf(built);
      const eol = built.facts.notes.eol as Record<string, { index: string; working: string }>;
      expect(eol["mixed.txt"]!.working).toBe("mixed");
      // lf.txt: the committed text with CRLF. Under core.autocrlf=true only the raw bytes differ.
      put(repo, "lf.txt", eolText("crlf", false));
      const listed = gitText(repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]).split("\0").some((r) => r.startsWith("1 ") && r.endsWith(" lf.txt"));
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const mixed = await compare(service, repositoryId, "mixed.txt", "unstaged", read);
      expect(outcome(mixed.response)).toEqual(SUCCEEDED);
      expect({ reason: support(mixed), hunks: mixed.hunkIds }).toEqual({ reason: "line-endings", hunks: [] });
      // Git's status decides whether the entry exists. Listed or not, it has no selectable hunk.
      if (listed) expect((await compare(service, repositoryId, "lf.txt", "unstaged", read)).hunkIds).toEqual([]);
      else expect(read.entries.filter((e) => e.path === "lf.txt")).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F10 flagged entries give index-flag and no hunk`, SHELL, () =>
    withService({ name: "t093-flags" }, async (service) => {
      const repo = repoOf(buildF10(gitPath(), "t093-flags", "flags"));
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const c = await compare(service, repositoryId, "ita.txt", "unstaged", read);
      expect(outcome(c.response)).toEqual(SUCCEEDED);
      expect({ reason: support(c), fileAction: fileAction(c), hunks: c.hunkIds, remedies: remedies(c) }).toEqual({ reason: "index-flag", fileAction: "index-flag", hunks: [], remedies: [] });
      // Git lists no assume-unchanged or skip-worktree entry, so no entry exists for them.
      expect(read.entries.filter((e) => e.path === "keep.txt" || e.path === "conflict.txt")).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F03 case-differing names, case-colliding index paths, and a path of 260 or more UTF-16 units give path`, [...SHELL, "windows-path-rules"], () =>
    withService({ name: "t093-paths" }, async (service) => {
      const built = buildF03(gitPath(), "t093-paths");
      const repo = repoOf(built);
      const r: Repo = { git: gitPath(), dir: repo, pre: [] };
      const long = built.facts.notes.longPath as { path: string; utf16Units: number; bunWrote: boolean };
      // A case-differing name: the index holds a.txt, and the disk holds A.txt with other content.
      renameSync(join(repo, "a.txt"), join(repo, "A.txt"));
      put(repo, "A.txt", "glob target changed\n");
      // Both case-colliding index paths name the one working file.
      put(repo, "collide/Name.txt", "collide changed\n");
      // The long path becomes an index entry, so Git lists it.
      const oid = gitText(repo, ["hash-object", "-w", "--stdin"], { input: Buffer.from("long changed\n") }).trim();
      run(r, ["update-index", "-z", "--index-info"], { input: Buffer.from(`100644 ${oid} 0\t${long.path}\0`) });
      console.log(`OBSERVATION ${TASK}: Bun ${Bun.version} readFileSync of the ${long.utf16Units}-unit relative path ${long.bunWrote ? "returned the written bytes" : "failed"}`);
      console.log(`OBSERVATION ${TASK}: Bun readdirSync of collide/ gives ${JSON.stringify(readdirSync(join(repo, "collide")))} for index paths collide/Name.txt and collide/name.txt`);
      console.log(`OBSERVATION ${TASK}: Bun realpathSync.native of a.txt gives on-disk name ${JSON.stringify(basename(realpathSync.native(join(repo, "a.txt"))))}`);
      const unstaged = gitText(repo, ["--no-optional-locks", "diff-files", "--name-only", "-z"]).split("\0");
      expect(unstaged).toContain("a.txt");
      expect(unstaged).toContain("collide/name.txt");
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      for (const path of ["a.txt", "collide/Name.txt", "collide/name.txt", long.path].filter((p) => unstaged.includes(p))) {
        const c = await compare(service, repositoryId, path, "unstaged", read);
        expect({ path, ...outcome(c.response) }).toEqual({ path, ...SUCCEEDED });
        expect({ path, reason: support(c), fileAction: fileAction(c), hunks: c.hunkIds }).toEqual({ path, reason: "path", fileAction: "path", hunks: [] });
      }
    }),
    TIMEOUT_MS,
  );
});

describe("bounds (contract §5)", () => {
  caseTest(TASK, `F16: 1,048,576-byte sides and 20,000 diff lines are supported; one byte or one line more, or more than 4 MiB of patch bytes, gives size or limited with no hunk`, SHELL, async () => {
    const builds = (["side-at-limit", "lines-at-limit", "side-over-limit", "lines-over-limit", "patch-bytes"] as const).map((variant) => {
      const built = buildF16Comparison(gitPath(), `t093-f16-${variant}`, variant);
      const repo = repoOf(built);
      if (variant === "side-at-limit" || variant === "side-over-limit") expect(built.facts.notes.sideBytes).toBe(COMPARED_RAW_VERSION_BYTES + (variant === "side-over-limit" ? 1 : 0));
      return { variant, repo, oracle: hunksOf(oraclePatch(repo, "big.txt", "index-to-worktree")) };
    });
    await underTest("comparison");
    for (const { variant, repo, oracle } of builds) {
      await withService({ name: `t093-f16-${variant}` }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const c = await compare(service, repositoryId, "big.txt", "unstaged");
        if (variant.endsWith("at-limit")) {
          expect({ variant, ...outcome(c.response), reason: support(c) }).toEqual({ variant, ...SUCCEEDED, reason: "supported" });
          expect(hunksOf(patchOf(c.response.result))).toEqual(oracle);
          expect(c.hunkIds.length).toBeGreaterThan(0);
        } else {
          const limited = c.response.state === "limited";
          expect({ variant, refused: limited || valuesOf(c.response.result, "support").includes("size"), hunks: c.hunkIds }).toEqual({ variant, refused: true, hunks: [] });
        }
      });
    }
  }, TIMEOUT_MS);

  // `ls-files --eol -z` records of a fixed width. A cut listing is never parsed, so only the record count and the byte total matter.
  const eolRecords = (from: number, count: number, width: number) =>
    Buffer.concat(Array.from({ length: count }, (_, i) => Buffer.from(`${`i/lf    w/lf    attr/                 \tf/${from + i}/`.padEnd(width - 1, "x")}\0`)));
  const eolLimit = async (name: string, listing: Buffer) => {
    let completeness: { state: string; reason?: string } | undefined;
    await withService({ name }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), name));
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      let injected = 0;
      service.runner.inject.stdout = (call) => (call.arguments.includes("--eol") ? (injected++, listing) : undefined);
      const c = await compare(service, repositoryId, "multi.txt", "unstaged", read);
      service.runner.inject.stdout = undefined;
      expect(injected).toBe(1);
      completeness = one(c.response.result, "completeness");
    });
    return completeness;
  };

  caseTest(TASK, `a line-ending listing cut at record ${STATUS_LISTING_RECORDS + 1} gives limited with reason STATUS_LISTING_RECORDS`, SHELL, async () => {
    const completeness = await eolLimit("t093-eol-records", eolRecords(0, STATUS_LISTING_RECORDS + 1, 48));
    expect(completeness).toMatchObject({ state: "limited", reason: "STATUS_LISTING_RECORDS" });
  }, TIMEOUT_MS);

  caseTest(TASK, `a line-ending listing cut at byte ${STATUS_LISTING_BYTES} gives limited with reason STATUS_LISTING_BYTES, also when the cut chunk brings more than ${STATUS_LISTING_RECORDS} NUL separators`, SHELL, async () => {
    // Wide records fill the byte bound below the record bound. Narrow records follow, so the chunk of the cut holds many more separators.
    const WIDE = 340;
    const wide = Math.ceil((STATUS_LISTING_BYTES + 1) / WIDE);
    const listing = Buffer.concat([eolRecords(0, wide, WIDE), eolRecords(wide, 4096, 42)]);
    const nuls = (end: number) => listing.subarray(0, end).reduce((n, b) => n + (b === 0 ? 1 : 0), 0);
    // The harness sends injected stdout in chunks of NATIVE_CHUNK_BYTES from byte 0, so the cut chunk starts at the byte bound.
    expect(STATUS_LISTING_BYTES % NATIVE_CHUNK_BYTES).toBe(0);
    expect(nuls(STATUS_LISTING_BYTES)).toBeLessThan(STATUS_LISTING_RECORDS);
    expect(nuls(STATUS_LISTING_BYTES + NATIVE_CHUNK_BYTES)).toBeGreaterThan(STATUS_LISTING_RECORDS);
    const completeness = await eolLimit("t093-eol-bytes", listing);
    expect(completeness).toMatchObject({ state: "limited", reason: "STATUS_LISTING_BYTES" });
  }, TIMEOUT_MS);

  // `applyHunk` has no handler before T110, so a refusal here would prove nothing about eviction.
  todoCase(TASK, `retained comparisons cap at 4, and eviction invalidates their approvals: a hunk of the evicted comparison is refused and starts no Git process (needs T110)`, SHELL, () =>
    withService({ name: "t093-retained" }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), "t093-retained"));
      put(repo, "new.txt", "new\n");
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      const first = await compare(service, repositoryId, "multi.txt", "staged", read);
      expect(outcome(first.response)).toEqual(SUCCEEDED);
      expect(first.hunkIds.length).toBe(1);
      for (const [path, category] of [["multi.txt", "unstaged"], ["other-a.txt", "staged"], ["other-b.txt", "staged"], ["new.txt", "untracked"]] as const) {
        expect(outcome((await compare(service, repositoryId, path, category, read)).response)).toEqual(SUCCEEDED);
      }
      const before = repoState(repo);
      const calls = service.runner.calls.length;
      const response = await service.request("applyHunk", { comparisonId: first.comparisonId, hunkId: first.hunkIds[0], snapshotId: read.snapshotId, direction: "unstage" }, { repositoryId, repositoryGeneration: read.generation });
      expect({ state: response.state, runs: service.runner.calls.length - calls }).toEqual({ state: "rejected", runs: 0 });
      expect(repoState(repo)).toEqual(before);
    }),
  );
});

describe("isolation (contract §4, §7)", () => {
  caseTest(TASK, `diff.<driver>.textconv, diff.<driver>.command, and diff.external canaries never run, also for an untracked entry`, SHELL, () =>
    withService({ name: "t093-canaries" }, async (service) => {
      const built = buildF02(gitPath(), "t093-canaries");
      const repo = repoOf(built);
      const r: Repo = { git: gitPath(), dir: repo, pre: [] };
      const canaries = { textconv: canary(built.root, "textconv"), command: canary(built.root, "command"), external: canary(built.root, "external") };
      run(r, ["config", "diff.t093.textconv", canaries.textconv.command]);
      run(r, ["config", "diff.t093.command", canaries.command.command]);
      run(r, ["config", "diff.external", canaries.external.command]);
      put(repo, ".git/info/attributes", "* diff=t093\n");
      put(repo, "new.txt", "new\n");
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      await approve(service, repositoryId);
      const read = await readOk(service, repositoryId);
      for (const [path, category] of [["multi.txt", "staged"], ["multi.txt", "unstaged"], ["new.txt", "untracked"]] as const) {
        const c = await compare(service, repositoryId, path, category, read);
        expect({ path, category, ...outcome(c.response) }).toEqual({ path, category, ...SUCCEEDED });
        expect(c.hunkIds.length).toBeGreaterThan(0);
      }
      expect(Object.values(canaries).filter((c) => readdirSync(join(built.root, "canaries")).includes(basename(c.log)))).toEqual([]);
    }),
    TIMEOUT_MS,
  );

  // Contract §7: the trust gate runs before any comparison limit check.
  caseTest(TASK, `an entry without index flags gives TRUST_REQUIRED, not limited, when a repository-controlled read key appears after the read`, SHELL, () =>
    withService({ name: "t093-untrusted-cut" }, async (service) => {
      const repo = repoOf(buildF02(gitPath(), "t093-untrusted-cut"));
      const oid = gitText(repo, ["rev-parse", "HEAD:multi.txt"]).trim();
      // An index listing cut at record STATUS_LISTING_RECORDS + 1 leaves every tracked entry without flags (contract §5).
      const cut = Buffer.from(Array.from({ length: STATUS_LISTING_RECORDS + 1 }, (_, i) => `H 100644 ${oid} 0\tcut/${i}\0`).join(""));
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      service.runner.inject.stdout = (call) => (call.arguments.includes("--stage") ? cut : undefined);
      const read = await service.readWorkspace(repositoryId);
      service.runner.inject.stdout = undefined;
      expect({ state: read.state, completeness: read.result?.completeness }).toMatchObject({ state: "limited", completeness: { state: "limited", reason: "STATUS_LISTING_RECORDS" } });
      const entry = entryOf(read.result!, "multi.txt", "unstaged");
      expect(entry.flags).toBeUndefined();
      // A repository-controlled `filter.<driver>.clean` blocks reads until approval (contract §7).
      run({ git: gitPath(), dir: repo, pre: [] }, ["config", "filter.t093.clean", "t093-untrusted"]);
      const response = await service.request("readComparison", { snapshotId: read.result!.snapshotId, entryId: entry.entryId }, { repositoryId, repositoryGeneration: read.result!.generation, selectionId: crypto.randomUUID() });
      expect(outcome(response)).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F17 partial-read-tree: an unstaged comparison whose index blob is missing gives OBJECT_MISSING and no hunk, and i/none is never a line-ending value`, SHELL, () =>
    withService({ name: "t093-missing-blob" }, async (service) => {
      const built = buildF17(gitPath(), "t093-missing-blob", "partial-read-tree");
      const clone = repoOf(built, "clone");
      // Contract §4: ls-files --eol exits 0 and reports i/none for a missing index blob.
      expect(gitText(clone, ["--no-lazy-fetch", "--no-optional-locks", "ls-files", "--eol", "--", "data.txt"])).toStartWith("i/none");
      await underTest("comparison");
      const { repositoryId } = await service.register(clone);
      const c = await compare(service, repositoryId, "data.txt", "unstaged");
      expect(c.response.code).toBe("OBJECT_MISSING");
      expect(c.hunkIds).toEqual([]);
      expect(valuesOf(c.response.result, "support")).not.toContain("line-endings");
      expect(readdirSync(join(built.root, "canaries")).filter((name) => name.endsWith(".log"))).toEqual([]);
    }),
    TIMEOUT_MS,
  );
});

describe("untracked hunks (research.md R3 \"Untracked hunk content\")", () => {
  caseTest(TASK, `untracked hunks of every F04 variant except safecrlf equal the git add blob of the T092 oracle`, SHELL, async () => {
    const builds = (["autocrlf-false", "autocrlf-true", "autocrlf-input", "eol-crlf", "attributes"] as const).map((variant) => {
      const repo = repoOf(buildF04(gitPath(), `t093-untracked-${variant}`, variant));
      const paths = F04_FOLDERS[variant].flatMap((folder) => putUntracked(repo, folder));
      const oracle = copyRepo(repo, `t093-untracked-${variant}-oracle`);
      git(oracle, ["--literal-pathspecs", "add", "--", ...paths]);
      return { variant, repo, paths, oracle };
    });
    await underTest("comparison");
    for (const { variant, repo, paths, oracle } of builds) {
      await withService({ name: `t093-untracked-${variant}` }, async (service) => {
        const { repositoryId } = await service.register(repo);
        const read = await readOk(service, repositoryId);
        for (const path of paths) {
          const c = await compare(service, repositoryId, path, "untracked", read);
          expect({ variant, path, ...outcome(c.response), scope: scope(c) }).toEqual({ variant, path, ...SUCCEEDED, scope: "empty-to-untracked" });
          expect(c.hunkIds.length).toBe(1);
          expect({ variant, path, bytes: newSide(patchOf(c.response.result)).toString("hex") }).toEqual({ variant, path, bytes: blobBytes(oracle, blobOf(oracle, path)!).toString("hex") });
        }
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, `an untracked entry gives line-endings and no hunk when only the index holds .gitattributes for its folder`, SHELL, () =>
    withService({ name: "t093-index-attribute" }, async (service) => {
      const repo = repoOf(buildF04Stage(gitPath(), "t093-index-attribute", "index-attribute"));
      const paths = putUntracked(repo, "");
      expect(indexEntries(gitPath(), repo).some((e) => e.path === ".gitattributes")).toBe(true);
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      for (const path of paths) {
        const c = await compare(service, repositoryId, path, "untracked", read);
        expect({ path, ...outcome(c.response), reason: support(c), hunks: c.hunkIds }).toEqual({ path, ...SUCCEEDED, reason: "line-endings", hunks: [] });
      }
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `under core.safecrlf=true, untracked hunks stay selectable and equal the git add -N then git add -p oracle`, SHELL, () =>
    withService({ name: "t093-safecrlf" }, async (service) => {
      const repo = repoOf(buildF04(gitPath(), "t093-safecrlf", "safecrlf"));
      expect(gitText(repo, ["config", "core.safecrlf"]).trim()).toBe("true");
      const paths = putUntracked(repo, "");
      const oracle = copyRepo(repo, "t093-safecrlf-oracle");
      for (const path of paths) {
        git(oracle, ["--literal-pathspecs", "add", "-N", "--", path]);
        git(oracle, ["-c", "core.pager=cat", "--literal-pathspecs", "add", "-p", "--", path], { input: Buffer.from("y\n") });
        // research.md R3 re-probe: every hunk is staged, and the entry has no intent-to-add flag.
        git(oracle, ["--literal-pathspecs", "diff-files", "--quiet", "--", path]);
      }
      expect(indexEntries(gitPath(), oracle).filter((e) => paths.includes(e.path) && e.intentToAdd)).toEqual([]);
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      for (const path of paths) {
        const c = await compare(service, repositoryId, path, "untracked", read);
        expect({ path, ...outcome(c.response), reason: support(c) }).toEqual({ path, ...SUCCEEDED, reason: "supported" });
        expect(c.hunkIds.length).toBe(1);
        expect({ path, bytes: newSide(patchOf(c.response.result)).toString("hex") }).toEqual({ path, bytes: blobBytes(oracle, blobOf(oracle, path)!).toString("hex") });
      }
    }),
    TIMEOUT_MS,
  );
});

describe("limitation remedies and file-action decisions (contract §4)", () => {
  caseTest(TASK, `F05: a filtered Unstaged entry carries the add remedy, a staged type or symlink entry carries restore --staged, and binary and staged rename entries carry none; each carries its file-action decision`, SHELL, () =>
    withService({ name: "t093-f05-remedies" }, async (service) => {
      const repo = repoOf(buildF05(gitPath(), "t093-f05-remedies"), "super");
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await approvedRead(service, repositoryId);
      const root = read.identity.worktreeRoot;
      const custom = await compare(service, repositoryId, "custom.cf", "unstaged", read);
      expect({ fileAction: fileAction(custom), remedy: remedy(custom) }).toEqual({ fileAction: "filter", remedy: { text: REMEDY_TEXT, command: addRemedy(root, "custom.cf") } });
      const type = await compare(service, repositoryId, "type-change.txt", "staged", read);
      expect({ fileAction: fileAction(type), remedy: remedy(type) }).toEqual({ fileAction: "type", remedy: { text: REMEDY_TEXT, command: restoreRemedy(root, "type-change.txt") } });
      const binary = await compare(service, repositoryId, "binary.dat", "unstaged", read);
      expect({ fileAction: fileAction(binary), remedies: remedies(binary) }).toEqual({ fileAction: "stage", remedies: [] });
      const rename = await compare(service, repositoryId, "rename-dst.txt", "staged", read);
      expect({ fileAction: fileAction(rename), remedies: remedies(rename) }).toEqual({ fileAction: "unstage", remedies: [] });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `F01 unborn: a staged symbolic-link entry carries rm --cached`, SHELL, () =>
    withService({ name: "t093-unborn-link" }, async (service) => {
      const repo = repoOf(buildF01(gitPath(), "t093-unborn-link", "unborn-added"));
      const r: Repo = { git: gitPath(), dir: repo, pre: [] };
      const oid = gitText(repo, ["hash-object", "-w", "--stdin"], { input: Buffer.from("first.txt") }).trim();
      run(r, ["update-index", "-z", "--index-info"], { input: Buffer.from(`120000 ${oid} 0\tnew-link\0`) });
      await underTest("comparison");
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      expect(read.head.state).toBe("unborn");
      const c = await compare(service, repositoryId, "new-link", "staged", read);
      expect({ fileAction: fileAction(c), remedy: remedy(c) }).toEqual({ fileAction: "symlink", remedy: { text: REMEDY_TEXT, command: rmCachedRemedy(read.identity.worktreeRoot, "new-link") } });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `an Unstaged rename record carries an add remedy that names the source and the destination path`, SHELL, () =>
    withService({ name: "t093-rename-record" }, async (service) => {
      const built = buildFileAccepted(gitPath(), "t093-rename-record");
      expect(built.facts.notes.renames).toContainEqual({ xy: ".R", path: "ita-dst.txt", orig: "ita-src.txt" });
      await underTest("comparison");
      const { repositoryId } = await service.register(repoOf(built));
      const read = await readOk(service, repositoryId);
      const c = await compare(service, repositoryId, "ita-dst.txt", "unstaged", read);
      expect({ fileAction: fileAction(c), remedy: remedy(c) }).toEqual({ fileAction: "rename", remedy: { text: REMEDY_TEXT, command: addRemedy(read.identity.worktreeRoot, "ita-src.txt", "ita-dst.txt") } });
    }),
    TIMEOUT_MS,
  );

  caseTest(TASK, `an F03 path with invalid UTF-8 bytes, a conflicted entry, and an index-flag entry carry no remedy`, SHELL, async () => {
    const built = buildF03(gitPath(), "t093-no-remedy-f03");
    const invalid = Buffer.from(built.facts.notes.invalidUtf8IndexPath as string, "hex");
    const conflict = repoOf(buildF10(gitPath(), "t093-no-remedy-conflict", "merge"));
    const flags = repoOf(buildF10(gitPath(), "t093-no-remedy-flag", "flags"));
    await underTest("comparison");
    await withService({ name: "t093-no-remedy-f03" }, async (service) => {
      const { repositoryId } = await service.register(repoOf(built));
      const read = await readOk(service, repositoryId);
      const entry = read.entries.find((e) => e.category === "staged" && Buffer.from(e.pathBytes, "base64").equals(invalid));
      expect(entry).toBeDefined();
      const c = await service.request("readComparison", { snapshotId: read.snapshotId, entryId: entry!.entryId }, { repositoryId, repositoryGeneration: read.generation, selectionId: crypto.randomUUID() });
      expect(outcome(c)).toEqual(SUCCEEDED);
      expect({ fileAction: one(c.result, "fileAction"), remedies: valuesOf(c.result, "remedy").filter((v) => v != null) }).toEqual({ fileAction: "path", remedies: [] });
    });
    for (const [repo, path, category] of [[conflict, "conflict.txt", "conflicted"], [flags, "ita.txt", "unstaged"]] as const) {
      await withService({ name: `t093-no-remedy-${category}` }, async (service) => {
        const { repositoryId } = await service.register(repo);
        expect({ path, remedies: remedies(await compare(service, repositoryId, path, category)) }).toEqual({ path, remedies: [] });
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, `a staged symbolic-link entry whose path holds U+0022 or TAB, and a remedy whose worktree root holds U+201C, carry no command and show the value as text`, SHELL, async () => {
    const repo = repoOf(buildF02(gitPath(), "t093-refused-paths"));
    const r: Repo = { git: gitPath(), dir: repo, pre: [] };
    const oid = gitText(repo, ["hash-object", "-w", "--stdin"], { input: Buffer.from("multi.txt") }).trim();
    const names = ['link"quote', "link\ttab"];
    // Git for Windows skips such a path without an error under the default `core.protectNTFS=true`, so only this write turns it off.
    run(r, ["-c", "core.protectNTFS=false", "update-index", "-z", "--index-info"], { input: Buffer.from(names.map((name) => `120000 ${oid} 0\t${name}\0`).join("")) });
    expect(indexEntries(gitPath(), repo).filter((e) => names.includes(e.path)).length).toBe(2);
    const root = join(fixtureDir("t093-refused-root"), "r\u201Croot");
    filteredRepo(root, "f.txt");
    await underTest("comparison");
    await withService({ name: "t093-refused-paths" }, async (service) => {
      const { repositoryId } = await service.register(repo);
      const read = await readOk(service, repositoryId);
      for (const name of names) {
        const c = await compare(service, repositoryId, name, "staged", read);
        const found = remedy(c);
        expect({ name, fileAction: fileAction(c), command: found.command, shown: found.text.includes(name) }).toEqual({ name, fileAction: "symlink", command: null, shown: true });
      }
    });
    await withService({ name: "t093-refused-root" }, async (service) => {
      const { repositoryId } = await service.register(root);
      const read = await readOk(service, repositoryId);
      const found = remedy(await compare(service, repositoryId, "f.txt", "unstaged", read));
      expect({ command: found.command, shown: found.text.includes(read.identity.worktreeRoot) }).toEqual({ command: null, shown: true });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, `each remedy doubles all five quote characters in the file name and the worktree root`, SHELL, async () => {
    const repos = QUOTES.map((q, i) => ({ q, i, ...hostile(q, i) }));
    for (const { dir, path } of repos) filteredRepo(dir, path);
    await underTest("comparison");
    for (const { q, i, dir, path } of repos) {
      await withService({ name: `t093-quote-${i}` }, async (service) => {
        const { repositoryId } = await service.register(dir);
        const read = await readOk(service, repositoryId);
        const c = await compare(service, repositoryId, path, "unstaged", read);
        expect({ q, fileAction: fileAction(c), remedy: remedy(c) }).toEqual({ q, fileAction: "filter", remedy: { text: REMEDY_TEXT, command: addRemedy(read.identity.worktreeRoot, path) } });
      });
    }
  }, TIMEOUT_MS);

  // Contract §4: PowerShell 7 and Windows PowerShell 5.1 must keep each value literal. The oracle index equals `git add` of that path.
  for (const [shell, capability] of [["pwsh", "pwsh"], ["powershell", "windows-powershell"]] as const) {
    caseTest(TASK, `each quoted remedy runs in ${shell} -NoProfile -Command without the marker payload, and the index equals git add`, [...SHELL, capability], async () => {
      const repos = QUOTES.map((q, i) => {
        const { dir, path } = hostile(q, i);
        const name = `t093-${shell}-${i}`;
        const repo = filteredRepo(join(fixtureDir(name), basename(dir)), path).dir;
        const oracle = copyRepo(repo, `${name}-oracle`);
        git(oracle, ["--literal-pathspecs", "add", "--", path]);
        return { q, name, repo, path, oracle };
      });
      await underTest("comparison");
      for (const { q, name, repo, path, oracle } of repos) {
        let command = "";
        await withService({ name }, async (service) => {
          const { repositoryId } = await service.register(repo);
          const read = await readOk(service, repositoryId);
          command = remedy(await compare(service, repositoryId, path, "unstaged", read)).command!;
        });
        const cwd = fixtureDir(`${name}-cwd`);
        const proc = Bun.spawnSync([Bun.which(shell)!, "-NoProfile", "-Command", command], { cwd, env: fixtureEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        expect({ shell, q, exit: proc.exitCode }).toEqual({ shell, q, exit: 0 });
        const markers = [cwd, repo].flatMap((d) => readdirSync(d, { recursive: true }).map(String)).filter((p) => basename(p) === MARKER);
        expect({ shell, q, markers }).toEqual({ shell, q, markers: [] });
        expect({ shell, q, entries: indexEntries(gitPath(), repo) }).toEqual({ shell, q, entries: indexEntries(gitPath(), oracle) });
        rmSync(cwd, { recursive: true, force: true });
      }
    }, TIMEOUT_MS);
  }
});
