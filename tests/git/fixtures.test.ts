// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ATTRIBUTION_EVIDENCE_BYTES, ATTRIBUTION_EVIDENCE_RECORDS, CANONICAL_DIFF_BYTES, CANONICAL_DIFF_LINES, WHOLE_FILE_STAGE_INPUT_BYTES } from "../../src/contracts/limits";
import { describeGit } from "./git-binary";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureDir, fixtureEnv, ownedGit, useFixtureRoot } from "./fixture-root";
import { gitOpenssl, loopbackCertificate, startHttp401 } from "./http-401";
import { hookListArgs, indexEntries, operationMarkers, rawIndexDigest, refState, sha256, submoduleUpdateOracle, workingFileDigests } from "./git-oracle";
import * as F from "./fixtures";
import { cachedF16Status } from "../windows/f16-status-cache";

// This file imports no `src/` module, so it prints no ORIGIN line for `src/`. `fixture-root.ts` prints the ORIGIN of its contract file.

const TIMEOUT = 300_000;
// research.md R14 S18 saw the 401 failure after 1.9 seconds. Bun ends the process after this wait.
const HTTP_401_WAIT_MS = 30_000;

// Git for Windows stores no device or inode number, and the builder fixes the creation time, so only there the raw index repeats.
const RAW_INDEX_REPEATS = process.platform === "win32";

// `disarm` keeps the index read from starting a fixture monitor.
function snapshot(git: string, repo: string, disarm: string[]) {
  return {
    entries: indexEntries(git, repo, disarm),
    rawIndex: RAW_INDEX_REPEATS ? rawIndexDigest(git, repo) : "not compared",
    files: workingFileDigests(repo),
    refs: refState(git, repo),
    markers: operationMarkers(git, repo),
  };
}

// Each repository that a case of this file builds. The last case reads its `core.filemode`.
const builtRepos: string[] = [];
// A builder that sets local `core.filemode=true` names the repository in `notes.filemode`.
const filemodeExceptions = new Map<string, string>();

const paths = (out: Buffer) => [...new Set(out.toString("utf8").split("\0").filter((p) => p !== ""))].sort();

// Checks one repository against the facts of its builder through Git plumbing and the oracle.
function verify(git: string, repo: string, facts: F.RepoFacts, disarm: string[]): void {
  const g = (args: string[], allowExit = [0]) => ownedGit(git, FIXTURE_ROOT, repo, ["--no-optional-locks", ...disarm, ...args], { allowExit });
  expect(g(["rev-parse", "--show-object-format"]).toString().trim()).toBe(facts.objectFormat);
  const refs = refState(git, repo);
  expect(refs.refs).toEqual(facts.refs);
  expect({ target: refs.headTarget, oid: refs.headOid }).toEqual(facts.head);
  expect(operationMarkers(git, repo)).toEqual(facts.markers);
  expect(paths(g(["diff", "--cached", "--no-renames", "--no-ext-diff", "--name-only", "-z"]))).toEqual(facts.staged);
  expect(paths(g(["diff-files", "--no-renames", "--ignore-submodules=dirty", "--name-only", "-z"]))).toEqual(facts.unstaged);
  expect(paths(g(["ls-files", "-o", "-z", "--exclude-standard"]))).toEqual(facts.untracked);
  const unmerged = g(["ls-files", "-u", "-z"]).toString("utf8").split("\0").filter((r) => r !== "").map((r) => r.slice(r.indexOf("\t") + 1));
  expect([...new Set(unmerged)].sort()).toEqual(facts.conflicted);
  const entries = indexEntries(git, repo, disarm);
  for (const expected of facts.entries) expect(entries).toContainEqual(expect.objectContaining(expected));
}

function canaryRuns(built: F.Built): Record<string, boolean> {
  return Object.fromEntries(Object.entries(built.facts.canaries).map(([name, log]) => [name, existsSync(join(built.root, log))]));
}

// Builds twice, then compares the facts, the oracle snapshots, and Git with the facts.
// `rebuild` gives the second build. A cached second build must equal the fresh first build.
function check(git: string, label: string, build: (name: string) => F.Built, extra?: (git: string, built: F.Built) => void, rebuild = build): void {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const started = performance.now();
  let a: F.Built;
  try {
    a = build(`${slug}-1`);
    builtRepos.push(...Object.keys(a.facts.repos).map((key) => join(a.root, key)));
    for (const [key, value] of Object.entries((a.facts.notes.filemode as Record<string, string> | undefined) ?? {})) filemodeExceptions.set(join(a.root, key), value);
  } catch (error) {
    if (!(error instanceof F.CapabilitySkip)) throw error;
    console.log(`SKIP ${label}: missing capability ${error.capability} (unverified)`);
    return;
  }
  const first = performance.now();
  const b = rebuild(`${slug}-2`);
  console.log(`BUILD ${label} ${(first - started).toFixed(0)} ms, rebuild ${(performance.now() - first).toFixed(0)} ms`);
  for (const built of [a, b]) {
    const runs = canaryRuns(built);
    expect(runs).toEqual(Object.fromEntries(Object.keys(runs).map((k) => [k, false])));
  }
  expect(b.facts).toEqual(a.facts);
  expect(Object.keys(a.facts.repos).length).toBeGreaterThan(0);
  for (const [key, facts] of Object.entries(a.facts.repos)) {
    const one = snapshot(git, join(a.root, key), a.facts.disarm);
    expect(snapshot(git, join(b.root, key), b.facts.disarm)).toEqual(one);
    if (key === Object.keys(a.facts.repos)[0]) console.log(`FACTS ${label} ${key}: head ${facts.head.target ?? "detached"} ${facts.head.oid ?? "unborn"}, index ${one.entries.length} entries ${one.rawIndex ?? "absent"}, staged ${facts.staged.length}, unstaged ${facts.unstaged.length}, untracked ${facts.untracked.length}, conflicted ${facts.conflicted.length}, markers [${facts.markers.join(",")}]`);
    verify(git, join(a.root, key), facts, a.facts.disarm);
  }
  extra?.(git, a);
  for (const name of (a.facts.notes.unverified as string[] | undefined) ?? []) console.log(`SKIP ${label}: missing capability ${name} (unverified)`);
}

const git1 = (git: string, cwd: string, args: string[], allowExit = [0]) => ownedGit(git, FIXTURE_ROOT, cwd, args, { allowExit });

// Checks the submodule HEADs and kept Git folders of `notes`, then Git's own update in a copy against `notes.oracle`.
function checkSubmodules(git: string, b: F.Built): void {
  const sup = join(b.root, "super");
  for (const [path, s] of Object.entries(b.facts.notes.submodules as Record<string, { head: string | null }>)) {
    if (s.head !== null) expect(`${path} ${git1(git, join(sup, path), ["rev-parse", "--verify", "-q", "HEAD"]).toString().trim()}`).toBe(`${path} ${s.head}`);
  }
  for (const [path, dir] of Object.entries((b.facts.notes.kept as Record<string, string> | undefined) ?? {})) {
    // research.md R14 S11: a kept folder whose `core.worktree` is absent needs `--work-tree` beside `--git-dir`.
    const absolute = git1(git, b.root, ["--git-dir", join(b.root, dir), "--work-tree", join(b.root, dir), "rev-parse", "--absolute-git-dir"]).toString().trim();
    expect(`${path} ${relative(b.root, absolute).replaceAll("\\", "/")}`).toBe(`${path} ${dir}`);
  }
  const oracle = b.facts.notes.oracle as { exit: number; heads?: Record<string, string> } | null;
  if (oracle === null) return;
  const result = submoduleUpdateOracle(git, sup, join(b.root, "oracle-copy"), { GIT_CONFIG_GLOBAL: join(b.root, b.facts.notes.globalConfig as string) });
  expect(oracle.heads === undefined ? { exit: result.exitCode } : { exit: result.exitCode, heads: result.heads }).toEqual(oracle);
}

// Counts the `@@ ` hunk headers of each path in `notes.hunks`, for the staged and the unstaged side.
function expectHunks(git: string, repo: string, b: F.Built): void {
  const hunks = (args: string[], path: string) => (git1(git, repo, ["--literal-pathspecs", ...args, "-p", "--no-ext-diff", "--no-textconv", "--", path]).toString().match(/^@@ /gm) ?? []).length;
  for (const [path, expected] of Object.entries(b.facts.notes.hunks as Record<string, { staged?: number[]; unstaged: number[] }>)) {
    expect(`${path} ${hunks(["diff", "--cached"], path)}`).toBe(`${path} ${expected.staged?.length ?? 0}`);
    expect(`${path} ${hunks(["diff-files"], path)}`).toBe(`${path} ${expected.unstaged.length}`);
  }
}

describeGit("fixture builders", (git) => {
  useFixtureRoot();

  test("F01 empty", () => check(git, "F01 empty", (n) => F.buildF01(git, n, "empty"), (g, b) => expect(rawIndexDigest(g, join(b.root, "repo"))).toBeNull()), TIMEOUT);
  test("F01 unborn-added", () => check(git, "F01 unborn-added", (n) => F.buildF01(git, n, "unborn-added")), TIMEOUT);

  for (const variant of ["base", "staged-hunks", "racy"] as const) {
    test(`F02 ${variant}`, () =>
      check(git, `F02 ${variant}`, (n) => F.buildF02(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        expectHunks(g, repo, b);
        if (variant !== "racy") return;
        // Racily clean: equal size and mtime in the index entry and the file, and the index file has the same second.
        const racy = b.facts.notes.racy as { path: string; unixSeconds: number };
        const stat = lstatSync(join(repo, racy.path));
        const index = lstatSync(join(repo, git1(g, repo, ["rev-parse", "--git-path", "index"]).toString().trim()));
        expect([Math.floor(stat.mtimeMs / 1000), Math.floor(index.mtimeMs / 1000), stat.size]).toEqual([racy.unixSeconds, racy.unixSeconds, Number(git1(g, repo, ["cat-file", "-s", `:${racy.path}`]).toString())]);
      }), TIMEOUT);
  }

  for (const variant of ["autocrlf-false", "autocrlf-true", "autocrlf-input", "eol-crlf", "safecrlf", "attributes"] as const) {
    test(`F04 ${variant}`, () =>
      check(git, `F04 ${variant}`, (n) => F.buildF04(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        const eol = F.eolInfo({ git: g, dir: repo, pre: [] });
        expect(eol).toEqual(b.facts.notes.eol as typeof eol);
        for (const [path, info] of Object.entries(eol)) if (path.endsWith(".txt")) expect(`${path} ${info.working}`).toBe(`${path} ${path.slice(path.lastIndexOf("/") + 1, -4)}`);
        expectHunks(g, repo, b);
        if (variant !== "safecrlf") return;
        // `git add` refuses the mixed file. It runs on a copy of the index, so the fixture stays unchanged.
        const copy = join(b.root, "index-copy");
        copyFileSync(join(repo, ".git", "index"), copy);
        expect(ownedGit(g, FIXTURE_ROOT, repo, ["add", "--", "mixed.txt"], { env: { GIT_INDEX_FILE: copy }, allowExit: [0, 128] }).length).toBe(0);
        expect(readFileSync(copy)).toEqual(readFileSync(join(repo, ".git", "index")));
      }), TIMEOUT);
  }

  for (const variant of ["index-crlf", "index-attribute", "ident-crlf", "mixed-over-lf", "ident"] as const) {
    test(`F04 stage ${variant}`, () =>
      check(git, `F04 stage ${variant}`, (n) => F.buildF04Stage(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        if (variant === "index-attribute") {
          expect(existsSync(join(repo, ".gitattributes"))).toBe(false);
          expect(git1(g, repo, ["check-attr", "--cached", "-z", "eol", "--", "f.txt"]).toString()).toBe("f.txt\0eol\0crlf\0");
        }
        // The candidate form (contract §4 step 5) on an index copy equals `git add` on another copy. Then both proofs run against its blob.
        const staged = (args: string[], input: string) => {
          const copy = join(b.root, `index-${args[0]}`);
          copyFileSync(join(repo, ".git", "index"), copy);
          ownedGit(g, FIXTURE_ROOT, repo, args, { env: { GIT_INDEX_FILE: copy }, input: Buffer.from(input) });
          const record = ownedGit(g, FIXTURE_ROOT, repo, ["ls-files", "-z", "--stage", "--", "f.txt"], { env: { GIT_INDEX_FILE: copy } }).toString();
          return record.slice(record.indexOf(" ") + 1, record.indexOf(" ", record.indexOf(" ") + 1));
        };
        const oid = staged(["update-index", "--add", "--remove", "-z", "--stdin"], "f.txt\0");
        expect(staged(["add", "--", "f.txt"], "")).toBe(oid);
        const working = readFileSync(join(repo, "f.txt"));
        const proofA = sha256(git1(g, repo, ["cat-file", "--filters", "--path=f.txt", oid])) === sha256(working);
        const proofB = ownedGit(g, FIXTURE_ROOT, repo, ["hash-object", "--stdin", "--path=f.txt"], { input: working }).toString().trim() === oid;
        expect({ a: proofA, b: proofB }).toEqual(b.facts.notes.blobProofs as { a: boolean; b: boolean });
      }), TIMEOUT);
  }

  test("F05 file-refusals", () =>
    check(git, "F05 file-refusals", (n) => F.buildF05(git, n, "file-refusals"), (g, b) => {
      const repo = join(b.root, "super");
      expect(git1(g, join(repo, "nested"), ["rev-parse", "--show-toplevel"]).toString().trim()).toBe(realpathSync.native(join(repo, "nested")).replaceAll("\\", "/"));
      expect(git1(g, repo, ["diff", "--cached", "--no-renames", "--raw", "-z", "--", "new-link"]).toString().split("\0")[0]).toMatch(/^:000000 120000 /);
    }), TIMEOUT);

  test("F06 file-accepted", () =>
    check(git, "F06 file-accepted", (n) => F.buildFileAccepted(git, n), (g, b) => {
      const repo = join(b.root, "repo");
      // Porcelain v2 `-z`: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>", and "2 <XY> ... <X><score> <path>" followed by the original path.
      const fields = git1(g, repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z"]).toString("utf8").split("\0");
      const renames: { xy: string; path: string; orig: string }[] = [];
      const modes: Record<string, [string, string]> = {};
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i]!.split(" ");
        if (f[0] === "2") renames.push({ xy: f[1]!, path: f.slice(9).join(" "), orig: fields[++i]! });
        if (f[0] === "1") modes[f.slice(8).join(" ")] = [f[4]!, f[5]!];
      }
      expect(renames.sort((x, y) => x.path.localeCompare(y.path))).toEqual([...(b.facts.notes.renames as typeof renames)].sort((x, y) => x.path.localeCompare(y.path)));
      const mode = b.facts.notes.modeChange as { path: string; index: string; working: string };
      expect(modes[mode.path]).toEqual([mode.index, mode.working]);
    }), TIMEOUT);

  for (const id of ["F09", "F13"] as const) {
    test(id, () => check(git, id, (n) => F.buildChanged(git, n, id), (g, b) => expectHunks(g, join(b.root, "repo"), b)), TIMEOUT);
  }

  test("F03", () =>
    check(git, "F03", (n) => F.buildF03(git, n), (g, b) => {
      const repo = join(b.root, "repo");
      const long = b.facts.notes.longPath as { path: string; utf16Units: number; bunWrote: boolean };
      expect(long.utf16Units).toBeGreaterThanOrEqual(260);
      if (long.bunWrote) expect(Object.keys(workingFileDigests(repo))).toContain(long.path);
      const raw = git1(g, repo, ["ls-files", "-z", "--stage"]);
      expect(raw.includes(Buffer.from(b.facts.notes.invalidUtf8IndexPath as string, "hex"))).toBe(true);
      // `git init` probes the letter case of the file system and sets `core.ignorecase` only when it ignores case.
      const ignoreCase = git1(g, repo, ["config", "--get", "--type=bool", "core.ignorecase"], [0, 1]).toString().trim() === "true";
      expect({ ignoreCase }).toEqual({ ignoreCase: !((b.facts.notes.unverified as string[] | undefined) ?? []).includes("case-insensitive-fs") });
      console.log(`OBSERVATION T066: F03 long path of ${long.utf16Units} UTF-16 units: Bun wrote and read it back = ${long.bunWrote}; Git without core.longpaths lists it as untracked = ${paths(git1(g, repo, ["ls-files", "-o", "-z"])).includes(long.path)}`);
    }), TIMEOUT);

  test("F05", () =>
    check(git, "F05", (n) => F.buildF05(git, n), (g, b) => {
      const subs = b.facts.notes.submodules as Record<string, { recorded: string; checkedOut: string }>;
      for (const [path, s] of Object.entries(subs)) expect(git1(g, join(b.root, "super", path), ["rev-parse", "HEAD"]).toString().trim()).toBe(s.checkedOut);
      expect(readFileSync(join(b.root, "super", ".gitmodules"), "utf8")).toContain("url = ../sub-src");
    }), TIMEOUT);

  test("F06", () => check(git, "F06", (n) => F.buildF06(git, n)), TIMEOUT);

  test("F07", () =>
    check(git, "F07", (n) => F.buildF07(git, n), (g, b) => {
      for (const [alias, target] of Object.entries((b.facts.notes.junctions as Record<string, string>) ?? {})) {
        expect(lstatSync(join(b.root, alias)).isSymbolicLink()).toBe(true);
        expect(realpathSync.native(join(b.root, alias))).toBe(realpathSync.native(join(b.root, target)));
      }
      const common = (wt: string) => git1(g, join(b.root, wt), ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
      const own = (wt: string) => git1(g, join(b.root, wt), ["rev-parse", "--path-format=absolute", "--git-dir"]).toString().trim();
      expect(common("wt-a")).toBe(common("main"));
      expect(new Set([own("main"), own("wt-a"), own("wt-b")]).size).toBe(3);
      expect(git1(g, join(b.root, "bare.git"), ["rev-parse", "--is-bare-repository"]).toString().trim()).toBe("true");
      expect(git1(g, join(b.root, "broken"), ["rev-parse", "--git-dir"], [128]).length).toBe(0);
    }), TIMEOUT);

  for (const variant of ["sha1", "sha256", "detached"] as const) {
    test(`F08 ${variant}`, () => check(git, `F08 ${variant}`, (n) => F.buildF08(git, n, variant)), TIMEOUT);
  }

  for (const variant of ["lock", "merge", "rebase", "cherry-pick", "sequencer", "am", "revert", "split-index", "split-config", "split-global", "flags", "sparse"] as const) {
    test(`F10 ${variant}`, () =>
      check(git, `F10 ${variant}`, (n) => F.buildF10(git, n, variant), (g, b) => {
        const gitDir = join(b.root, "repo", ".git");
        const shared = readdirSync(gitDir).filter((f) => f.startsWith("sharedindex."));
        expect(shared.length).toBe(variant === "split-index" ? 1 : 0);
        if (variant === "split-config") expect(git1(g, join(b.root, "repo"), ["config", "--local", "core.splitIndex"]).toString().trim()).toBe("true");
        if (variant === "split-global") {
          const global = join(b.root, b.facts.notes.globalConfig as string);
          expect(git1(g, join(b.root, "repo"), ["config", "--file", global, "--type=bool", "core.splitIndex"]).toString().trim()).toBe("true");
          expect(ownedGit(g, FIXTURE_ROOT, join(b.root, "repo"), ["config", "--show-scope", "--type=bool", "core.splitIndex"], { env: { GIT_CONFIG_GLOBAL: global } }).toString().trim()).toBe("global\ttrue");
        }
        if (variant === "lock") for (const lock of b.facts.notes.locks as string[]) expect(existsSync(join(b.root, "repo", lock))).toBe(true);
      }), TIMEOUT);
  }

  for (const variant of ["traditional", "configured", "disabled", "post-index-change", "fsmonitor", "changing", "rejecting"] as const) {
    test(`F11 ${variant}`, () =>
      check(git, `F11 ${variant}`, (n) => F.buildF11(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        const hooks = b.facts.notes.hooks as Record<string, { configured: string[]; hookFolder: boolean }>;
        // A configured record is "<scope>\t[disabled\t]<name>". A hook-folder record has no scope and no tab.
        for (const [event, expected] of Object.entries(hooks)) {
          const records = git1(g, repo, hookListArgs(event), [0, 1]).toString("utf8").split("\0").filter((r) => r !== "");
          expect({ event, configured: records.filter((r) => r.includes("\t")), hookFolder: records.filter((r) => !r.includes("\t")).length }).toEqual({ event, configured: expected.configured, hookFolder: expected.hookFolder ? 1 : 0 });
        }
        if (variant === "fsmonitor") {
          // The monitor canary must be live: `status` without the disarm loads the index and asks the monitor.
          git1(g, repo, ["status", "--porcelain=v2"]);
          expect(canaryRuns(b)).toEqual({ fsmonitor: true });
          return;
        }
        // Each canary must be live, and a disabled registration must stay silent.
        for (const event of Object.keys(hooks)) git1(g, repo, ["hook", "run", event], [0, 1]);
        const runs = canaryRuns(b);
        expect(runs).toEqual(Object.fromEntries(Object.keys(runs).map((k) => [k, variant !== "disabled"])));
      }), TIMEOUT);
  }

  for (const variant of ["gc-auto", "ssh-signing"] as const) {
    test(`F12 ${variant}`, () =>
      check(git, `F12 ${variant}`, (n) => F.buildF12(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        if (variant === "gc-auto") {
          const gc = b.facts.notes.gcAuto as { threshold: number; looseIn17: number };
          const folder = join(repo, git1(g, repo, ["rev-parse", "--git-path", "objects/17"]).toString().trim());
          expect([git1(g, repo, ["config", "--local", "--type=int", "gc.auto"]).toString().trim(), readdirSync(folder).length]).toEqual([String(gc.threshold), gc.looseIn17]);
          expect(gc.looseIn17).toBeGreaterThan(Math.floor((gc.threshold + 255) / 256));
          return;
        }
        // The key canary must be live: the signing commit asks it for a key, gets none, and fails without a commit.
        const head = git1(g, repo, ["rev-parse", "HEAD"]).toString();
        git1(g, repo, ["commit", "-q", "--no-verify", "-m", "signed"], [128]);
        expect([git1(g, repo, ["rev-parse", "HEAD"]).toString(), canaryRuns(b)["ssh-default-key"]]).toEqual([head, true]);
      }), TIMEOUT);
  }

  for (const variant of ["slow", "descendant", "orphan", "monitor", "lingering", "lock"] as const) {
    test(`F14 ${variant}`, () =>
      check(git, `F14 ${variant}`, (n) => F.buildF14(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        const event = { slow: "pre-commit", descendant: "pre-commit", orphan: "pre-commit", monitor: null, lingering: "post-commit", lock: "post-commit" }[variant];
        if (event !== null) expect(git1(g, repo, hookListArgs(event)).toString("utf8").split("\0").filter((r) => r !== "").length).toBe(1);
        expect(readdirSync(join(b.root, b.facts.notes.records as string))).toEqual([]);
        if (variant === "lock") expect(existsSync(join(b.root, b.facts.notes.lock as string))).toBe(false);
        if (variant !== "monitor") return;
        expect(git1(g, repo, ["config", "--local", "--type=bool", "core.fsmonitor"]).toString().trim()).toBe("true");
        // Git builtin/fsmonitor--daemon.c `do_as_client__status`: exit 0 when a daemon watches the worktree, 1 otherwise. No fixture read may start one.
        if (process.platform === "win32") git1(g, repo, ["fsmonitor--daemon", "status"], [1]);
      }), TIMEOUT);
  }

  // The hook script must run: its child creates the Git-resolved lock and records itself. The test ends the child by its record.
  test("F14 lock child creates the index lock and records itself", () => {
    const b = F.buildF14(git, "f14-lock-live", "lock");
    const repo = join(b.root, "repo");
    builtRepos.push(repo);
    // The child inherits the hook output, so the run gets no pipe that the child would hold open.
    const run = Bun.spawnSync([git, "hook", "run", "post-commit"], { cwd: repo, env: fixtureEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    expect(run.exitCode).toBe(0);
    const host = require(join(import.meta.dir, process.platform === "win32" ? "win32.ts" : "linux.ts")) as typeof import("./win32");
    const records = readdirSync(join(b.root, b.facts.notes.records as string)).map((name) => name.split("-").map(BigInt) as [bigint, bigint]);
    try {
      expect(records.length).toBe(1);
      expect(host.processCreationTime(Number(records[0]![0]))).toBe(records[0]![1]);
      expect(existsSync(join(b.root, b.facts.notes.lock as string))).toBe(true);
    } finally {
      for (const [pid, created] of records) host.terminateRecorded(Number(pid), created);
    }
  }, TIMEOUT);

  for (const variant of ["side-at-limit", "side-over-limit", "lines-at-limit", "lines-over-limit", "patch-bytes"] as const) {
    test(`F16 comparison ${variant}`, () =>
      check(git, `F16 comparison ${variant}`, (n) => F.buildF16Comparison(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        const patch = git1(g, repo, ["diff-files", "-p", "--no-ext-diff", "--no-textconv", "--", "big.txt"]);
        // Contract §5: count every patch line, headers included, and ignore the empty segment after the final newline.
        const patchLines = patch.toString("utf8").split("\n").length - 1;
        const sides = [Number(git1(g, repo, ["cat-file", "-s", "HEAD:big.txt"]).toString()), lstatSync(join(repo, "big.txt")).size];
        if (variant.startsWith("side")) expect(sides).toEqual([b.facts.notes.sideBytes as number, b.facts.notes.sideBytes as number]);
        if (variant.startsWith("lines")) expect(patchLines).toBe(b.facts.notes.diffLines as number);
        if (variant === "patch-bytes") expect([patch.length > CANONICAL_DIFF_BYTES, patchLines < CANONICAL_DIFF_LINES]).toEqual([true, true]);
        console.log(`FACTS F16 comparison ${variant}: sides ${sides.join("/")} bytes, patch ${patchLines} lines, ${patch.length} bytes`);
      }), TIMEOUT);
  }

  for (const variant of ["base", "reflog-records", "reflog-bytes"] as const) {
    test(`F20 ${variant}`, () =>
      check(git, `F20 ${variant}`, (n) => F.buildF20(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        expectHunks(g, repo, b);
        if (variant === "base") return;
        const reflog = b.facts.notes.reflog as { ref: string; records: number; bytes: number };
        const records = git1(g, repo, ["reflog", "show", "--format=%H", reflog.ref]).toString().split("\n").length - 1;
        expect(records).toBe(reflog.records);
        if (variant === "reflog-records") expect([records > ATTRIBUTION_EVIDENCE_RECORDS, reflog.bytes < ATTRIBUTION_EVIDENCE_BYTES]).toEqual([true, true]);
        else expect([records < ATTRIBUTION_EVIDENCE_RECORDS, reflog.bytes > ATTRIBUTION_EVIDENCE_BYTES]).toEqual([true, true]);
      }), TIMEOUT);
  }

  test("F16 stage-input", () =>
    check(git, "F16 stage-input", (n) => F.buildF16StageInput(git, n), (_g, b) => {
      const sizes = b.facts.notes.sizes as Record<string, number>;
      expect(Object.values(sizes)).toEqual([WHOLE_FILE_STAGE_INPUT_BYTES, WHOLE_FILE_STAGE_INPUT_BYTES + 1]);
      for (const [path, bytes] of Object.entries(sizes)) expect(lstatSync(join(b.root, "repo", path)).size).toBe(bytes);
    }), TIMEOUT);

  test("F15", () =>
    check(git, "F15", (n) => F.buildF15(git, n), (_g, b) => {
      expect(existsSync(join(b.root, "plain", ".git"))).toBe(false);
      const hostile = b.facts.notes.hostile as string[];
      expect(hostile.length).toBe(process.platform === "win32" ? F.POWERSHELL_QUOTES.length : 0);
      if (hostile.length > 0) expect(readdirSync(join(b.root, "hostile")).sort()).toEqual([...hostile].sort());
    }), TIMEOUT);

  for (const variant of ["at-limit", "over-limit"] as const) {
    test(`F16 status ${variant}`, () =>
      check(git, `F16 status ${variant}`, (n) => F.buildF16Status(git, n, variant), (_g, b) => {
        expect(b.facts.repos.repo!.unstaged.length).toBe(F.F16_STATUS_RECORDS + (variant === "over-limit" ? 1 : 0));
      }, (n) => cachedF16Status(git, n, variant).built), TIMEOUT);
  }

  for (const variant of ["parents-64", "parents-65", "parent-refs", "object-at-limit", "object-over-limit", "traversal"] as const) {
    test(`F16 history ${variant}`, () =>
      check(git, `F16 history ${variant}`, (n) => F.buildF16History(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        const rows = git1(g, repo, ["rev-list", "--parents", "--date-order", "--max-count=100", "HEAD"]).toString().trim().split("\n");
        const parentRefs = rows.reduce((sum, row) => sum + row.split(" ").length - 1, 0);
        const maxParents = Math.max(...rows.map((row) => row.split(" ").length - 1));
        if (variant === "parents-64") expect(maxParents).toBe(64);
        if (variant === "parents-65") expect(maxParents).toBe(65);
        if (variant === "parent-refs") expect([parentRefs > 1024, maxParents <= 64]).toEqual([true, true]);
        if (variant.startsWith("object")) expect(Number(git1(g, repo, ["cat-file", "-s", "HEAD"]).toString())).toBe(b.facts.notes.objectBytes as number);
        if (variant === "traversal") {
          const text = git1(g, repo, ["rev-list", "--max-count=100", "--format=%H %P %s", "HEAD"]);
          expect([rows.length, text.length > 128 * 1024]).toEqual([100, true]);
          expect(Math.max(...rows.map((r) => Number(git1(g, repo, ["cat-file", "-s", r.split(" ")[0]!]).toString())))).toBeLessThan(F.F16_OBJECT_LIMIT);
        }
        console.log(`FACTS F16 history ${variant}: rows ${rows.length}, parent references ${parentRefs}, max parents ${maxParents}`);
      }), TIMEOUT);
  }

  test("F17 trust", () =>
    check(git, "F17 trust", (n) => F.buildF17(git, n, "trust"), (g, b) => {
      const repo = join(b.root, "repo");
      const local = git1(g, repo, ["config", "--local", "--list"]).toString();
      for (const key of ["filter.canary.clean=./tools/clean.sh", "filter.proc.process=", "core.fsmonitor=", "diff.external=", "diff.tcv.textconv="]) expect(local).toContain(key);
      expect(existsSync(join(repo, "tools", "clean.sh"))).toBe(true);
      // The clean canary must be live: `hash-object --path` applies the clean filter of that path.
      expect(canaryRuns(b).clean).toBe(false);
      ownedGit(git, FIXTURE_ROOT, repo, ["hash-object", "--path=data.dat", "--stdin"], { input: Buffer.from("x\n") });
      expect(canaryRuns(b).clean).toBe(true);
    }), TIMEOUT);

  // The canaries must run from their files: the clean filter and the hook canary need the executable bit.
  test("F17 trust canaries run through the clean filter and the pre-commit hook", () => {
    const b = F.buildF17(git, "f17-canaries", "trust");
    const repo = join(b.root, "repo");
    builtRepos.push(repo);
    git1(git, repo, ["hash-object", "--path=data.dat", "data.dat"]);
    git1(git, repo, ["hook", "run", "pre-commit"]);
    expect(canaryRuns(b)).toMatchObject({ clean: true, "pre-commit": true });
  }, TIMEOUT);

  for (const variant of ["partial-reset-soft", "partial-read-tree"] as const) {
    test(`F17 ${variant}`, () =>
      check(git, `F17 ${variant}`, (n) => F.buildF17(git, n, variant), (g, b) => {
        const clone = join(b.root, "clone");
        const missing = b.facts.notes.missingBlobs as string[];
        expect(missing.length).toBe(2);
        for (const oid of missing) expect(git1(g, clone, ["--no-lazy-fetch", "cat-file", "-e", oid], [1, 128]).length).toBe(0);
        expect(canaryRuns(b)).toEqual({ uploadpack: false });
        // The canary must be live: one lazy fetch outside the facts runs it.
        git1(g, clone, ["cat-file", "-p", missing[0]!]);
        expect(canaryRuns(b)).toEqual({ uploadpack: true });
      }), TIMEOUT);
  }

  for (const variant of ["files", "reftable"] as const) {
    test(`F18 ${variant}`, () =>
      check(git, `F18 ${variant}`, (n) => F.buildF18(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        expect(git1(g, repo, ["rev-parse", "--show-ref-format"]).toString().trim()).toBe(variant);
        if (variant === "files") expect(readFileSync(join(repo, ".git", "packed-refs"), "utf8")).toContain("refs/heads/packed");
      }), TIMEOUT);
  }

  for (const variant of ["linear", "merge", "octopus", "skewed", "roots", "long", "wide", "encoding", "shallow", "sha256"] as const) {
    test(`F19 ${variant}`, () =>
      check(git, `F19 ${variant}`, (n) => F.buildF19(git, n, variant), (g, b) => {
        const repo = join(b.root, "repo");
        const expected = b.facts.notes.parents as Record<string, string[]>;
        const shallow = (b.facts.notes.shallow as string[] | undefined) ?? [];
        const rows = git1(g, repo, ["rev-list", "--parents", "HEAD"]).toString().trim().split("\n").map((r) => r.split(" "));
        for (const [oid, ...parents] of rows) if (!shallow.includes(oid!)) expect(parents).toEqual(expected[oid!]!);
        if (variant === "shallow") {
          expect(readFileSync(join(repo, ".git", "shallow"), "utf8").trim().split("\n")).toEqual(shallow);
          expect(rows.length).toBe(b.facts.notes.depth as number);
        } else {
          expect(rows.length).toBe(Object.keys(expected).length);
        }
        if (variant === "encoding") {
          const raw = git1(g, repo, ["cat-file", "commit", "HEAD"]);
          expect(raw.includes(Buffer.from("encoding ISO-8859-1\n"))).toBe(true);
          expect(raw.includes(Buffer.from([0x4a, 0x6f, 0x73, 0xe9]))).toBe(true);
        }
      }), TIMEOUT);
  }

  for (const variant of ["base", "behind-present", "behind-fetch", "deinit-kept", "update-none", "literal-paths", "kept-remote", "spaces", "token-url", "unreachable-target", "headless-kept"] as const) {
    test(`F27 ${variant}`, () =>
      check(git, `F27 ${variant}`, (n) => F.buildF27(git, n, variant), (g, b) => {
        checkSubmodules(g, b);
        if (variant === "unreachable-target") {
          const u = b.facts.notes.unreachable as { path: string; target: string };
          // research.md R14 S23: `rev-list -n 1 <target> --not --all` prints a target that is present without a ref.
          expect(git1(g, join(b.root, "super", u.path), ["rev-list", "-n", "1", u.target, "--not", "--all"]).toString().trim()).toBe(u.target);
        }
      }), TIMEOUT);
  }

  const f28 = ["detached-unsaved", "update-merge", "update-rebase", "update-command", "gitmodules-command", "no-url", "interrupted", "blocked", "inactive", "active-pathspec", "deinit-unsaved", "folder", "moved-folder", "path", "prune", "keep", "remote-name", "unregistered-block"] as const;
  for (const variant of f28) {
    test(`F28 ${variant}`, () =>
      check(git, `F28 ${variant}`, (n) => F.buildF28(git, n, variant), (g, b) => {
        checkSubmodules(g, b);
        const sup = join(b.root, "super");
        const kept = (path: string) => join(b.root, (b.facts.notes.kept as Record<string, string>)[path]!);
        const inKept = (path: string, args: string[], allowExit = [0]) => git1(g, b.root, ["--git-dir", kept(path), "--work-tree", kept(path), ...args], allowExit).toString();
        const config = (key: string) => git1(g, sup, ["config", "--local", "--get", key], [0, 1]).toString().trim();
        switch (variant) {
          case "detached-unsaved":
            expect(git1(g, join(sup, "solo"), ["for-each-ref", "--contains=HEAD"]).toString()).toBe("");
            break;
          case "deinit-unsaved": {
            const unsaved = b.facts.notes.unsaved as { path: string; commit: string };
            expect([existsSync(join(sup, "solo", ".git")), inKept("solo", ["for-each-ref", `--contains=${unsaved.commit}`]), inKept("solo", ["cat-file", "-t", unsaved.commit]).trim()]).toEqual([false, "", "commit"]);
            break;
          }
          case "update-merge":
          case "update-rebase":
            expect(config("submodule.solo.update")).toBe(variant.slice("update-".length));
            break;
          case "update-command":
            expect(config("submodule.solo.update").startsWith("!")).toBe(true);
            break;
          case "gitmodules-command":
            expect(git1(g, sup, ["config", "--file", ".gitmodules", "submodule.solo.update"]).toString().trim()).toBe("!../../canaries/gitmodules-update.sh");
            break;
          case "no-url":
            expect(git1(g, sup, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\.orphan\\."], [1]).toString()).toBe("");
            break;
          case "interrupted":
          case "moved-folder": {
            const i = b.facts.notes.interrupted as { path: string; gitDir: string };
            expect(readFileSync(join(sup, i.path, ".git"), "utf8")).toBe("gitdir: ../.git/modules/solo\n");
            expect([readdirSync(join(b.root, i.gitDir, "refs")), readdirSync(join(b.root, i.gitDir, "objects", "pack"))]).toEqual([[], ["tmp_pack_arbareto"]]);
            expect([config("submodule.solo.url") !== "", config("submodule.solo.active")]).toEqual([true, "true"]);
            break;
          }
          case "blocked":
          case "unregistered-block":
            expect(readFileSync(join(sup, "solo", "solo.txt"), "utf8")).toBe("solo 1 edited\n");
            expect(config("submodule.solo.url") === "").toBe(variant === "unregistered-block");
            break;
          case "inactive":
            expect([config("submodule.solo.active"), config("submodule.active")]).toEqual(["false", ""]);
            break;
          case "active-pathspec":
            expect(config("submodule.active")).toBe("mid");
            break;
          case "folder": {
            const folder = b.facts.notes.folder as { path: string; files: Record<string, string> };
            expect(existsSync(join(sup, folder.path, ".git"))).toBe(false);
            for (const [file, digest] of Object.entries(folder.files)) expect(sha256(readFileSync(join(sup, folder.path, file)))).toBe(digest);
            break;
          }
          case "path":
            expect(git1(g, sup, ["ls-files", "-z", "--stage"]).includes(Buffer.from(b.facts.notes.invalidPath as string, "hex"))).toBe(true);
            break;
          case "prune":
          case "keep": {
            const p = b.facts.notes.prune as { path: string; head: string; ref: string; prune: boolean };
            const s = join(sup, p.path);
            expect(git1(g, s, ["for-each-ref", "--contains=HEAD", "--format=%(refname)"]).toString().trim()).toBe(p.ref);
            expect(git1(g, s, ["config", "--local", "--get", "fetch.prune"], [0, 1]).toString().trim()).toBe(p.prune ? "true" : "");
            break;
          }
          case "remote-name":
            expect(inKept("solo", ["config", "--local", "--name-only", "--get-regexp", "^remote\\.--upload-pack="]).trim().endsWith(".url")).toBe(true);
            break;
        }
      }), TIMEOUT);
  }

  for (const variant of ["base", "kept-folder", "kept-nested", "gitdir-extension", "gitdir-outside", "gitdir-nested", "relative-hooks", "nested-programs", "row-programs"] as const) {
    test(`F29 ${variant}`, () =>
      check(git, `F29 ${variant}`, (n) => F.buildF29(git, n, variant), (g, b) => {
        checkSubmodules(g, b);
        const sup = join(b.root, "super");
        const inDir = (dir: string, args: string[], allowExit = [0]) => git1(g, b.root, ["--git-dir", dir, "--work-tree", dir, ...args], allowExit).toString();
        // Each hook file must name a hook event of this Git: `hook list` exits 0 with one record, and an unknown name exits 1.
        for (const [label, rel] of Object.entries((b.facts.notes.programs as Record<string, string> | undefined) ?? {})) {
          const dir = join(b.root, rel);
          for (const event of F.F29_HOOK_EVENTS) expect(`${label} ${event} ${inDir(dir, ["hook", "list", "-z", event], [0, 1]).split("\0").filter((r) => r !== "").length}`).toBe(`${label} ${event} 1`);
          for (const key of ["core.fsmonitor", "filter.f29.clean", "filter.f29.smudge", "core.sshCommand", "credential.helper", "remote.origin.uploadpack"]) expect(git1(g, b.root, ["config", "--file", join(dir, "config"), "--get", key]).length).toBeGreaterThan(0);
          expect(readFileSync(join(dir, "info", "attributes"), "utf8")).toBe("* filter=f29\n");
        }
        const superConfig = (key: string) => git1(g, sup, ["config", "--local", "--get", key], [0, 1]).toString().trim();
        switch (variant) {
          case "base":
            expect(superConfig("submodule.ext.url").startsWith("ext::")).toBe(true);
            git1(g, b.root, ["config", "--file", join(b.root, b.facts.notes.globalNoFile as string), "--get", "protocol.file.allow"], [1]);
            break;
          case "kept-folder":
            git1(g, b.root, ["--git-dir", join(b.root, b.facts.notes.nonGitFolder as string), "rev-parse", "--absolute-git-dir"], [128]);
            expect(Object.keys(b.facts.notes.kept as Record<string, string>).sort()).toEqual(["grouped", "mid", "mid/leaf"]);
            break;
          case "gitdir-extension":
            expect([superConfig("core.repositoryformatversion"), superConfig("extensions.submodulePathConfig")]).toEqual(["1", "true"]);
            break;
          case "gitdir-outside":
            expect(superConfig("submodule.solo.gitdir")).not.toBe("");
            break;
          case "gitdir-nested":
            expect(git1(g, b.root, ["config", "--file", join(b.root, (b.facts.notes.programs as Record<string, string>).mid!, "config"), "--get", "submodule.leaf.gitdir"]).length).toBeGreaterThan(0);
            break;
          case "relative-hooks": {
            const { A, B } = b.facts.notes.commits as { A: string; B: string };
            const global = join(b.root, b.facts.notes.globalConfig as string);
            expect(git1(g, b.root, ["config", "--file", global, "--get", "core.hooksPath"]).toString().trim()).toBe(".githooks");
            git1(g, join(sup, "hk-checkout"), ["cat-file", "-e", B]);
            git1(g, join(sup, "hk-fetch"), ["--no-lazy-fetch", "cat-file", "-e", B], [1, 128]);
            expect(git1(g, join(sup, "hk-checkout"), ["ls-tree", "--format=%(objectmode) %(path)", A, ".githooks/"]).toString()).toBe("100755 .githooks/post-checkout\n100755 .githooks/reference-transaction\n");
            break;
          }
        }
      }), TIMEOUT);
  }

  for (const variant of ["clone", "silent-hook", "child-hook", "silent-fetch", "stall"] as const) {
    test(`F30 ${variant}`, () =>
      check(git, `F30 ${variant}`, (n) => F.buildF30(git, n, variant), (g, b) => {
        checkSubmodules(g, b);
        const sup = join(b.root, "super");
        const subs = b.facts.notes.submodules as Record<string, { recorded: string }>;
        if (variant === "clone" || variant === "silent-fetch") {
          expect(Number(git1(g, join(b.root, "big.git"), ["cat-file", "-s", `${subs.big!.recorded}:big.bin`]).toString())).toBe(F.F30_BIG_BYTES);
          if (variant === "silent-fetch") git1(g, join(sup, "big"), ["--no-lazy-fetch", "cat-file", "-e", subs.big!.recorded], [1, 128]);
        }
        if (variant === "silent-hook" || variant === "child-hook") expect(git1(g, join(sup, "solo"), ["hook", "list", "-z", "post-checkout"]).toString().split("\0").filter((r) => r !== "").length).toBe(1);
        if (variant === "child-hook") expect(readdirSync(join(b.root, b.facts.notes.records as string))).toEqual([]);
        if (variant === "stall") {
          const s = join(sup, "solo");
          expect(git1(g, s, ["config", "--local", "--get", "remote.origin.url"]).toString().trim()).toBe(F.F30_SSH_URL);
          expect(git1(g, s, ["config", "--local", "--get", "core.sshCommand"]).toString().trim().endsWith(" #")).toBe(true);
          for (const file of [b.facts.notes.key as string, `${b.facts.notes.key}.pub`]) expect(existsSync(join(b.root, file))).toBe(true);
          git1(g, s, ["--no-lazy-fetch", "cat-file", "-e", subs.solo!.recorded], [1, 128]);
        }
      }), TIMEOUT);
  }

  // research.md R14 S18: Git without a prompt gets the 401 answer and exits 128. The `https` mode trusts the test certificate through an owned global file.
  for (const mode of ["http", "https"] as const) {
    test(`http-401 ${mode}`, async () => {
      const dir = fixtureDir(`http-401-${mode}`);
      const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
      let tls: { key: string; cert: string } | undefined;
      if (mode === "https") {
        const openssl = gitOpenssl(git);
        if (openssl === null) {
          console.log("SKIP http-401 https: missing capability openssl (unverified)");
          return;
        }
        tls = loopbackCertificate(openssl, join(dir, "keys"));
        env.GIT_CONFIG_GLOBAL = join(dir, "global.gitconfig");
        writeFileSync(env.GIT_CONFIG_GLOBAL, `${readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8")}[http]\n\tsslCAInfo = ${tls.cert.replaceAll("\\", "/")}\n`);
      }
      const server = startHttp401(tls);
      try {
        const proc = Bun.spawn([git, "ls-remote", server.url], { cwd: dir, env: fixtureEnv(env), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: HTTP_401_WAIT_MS });
        expect({ exit: await proc.exited, requested: server.requests() >= 1 }).toEqual({ exit: 128, requested: true });
      } finally {
        server.stop();
      }
    }, TIMEOUT);
  }

  // Git on Linux and macOS sets `core.filemode` from a probe. The builders fix it at local scope, to false unless `notes.filemode` names another value.
  test("each built repository has its fixed core.filemode", () => {
    expect(builtRepos.length).toBeGreaterThan(0);
    const key = (repo: string) => relative(FIXTURE_ROOT, repo).replaceAll("\\", "/");
    const values = Object.fromEntries(builtRepos.map((repo) => [key(repo), git1(git, repo, ["config", "--local", "--get", "core.filemode"], [0, 1]).toString().trim()]));
    expect(values).toEqual(Object.fromEntries(builtRepos.map((repo) => [key(repo), filemodeExceptions.get(repo) ?? "false"])));
  }, TIMEOUT);
});
