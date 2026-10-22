// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T016: the builder self-check of `tests/git/history-diff-fixtures.ts` (plan.md P0.1).
// T018: the Git facts F1 to F9 and F17 of research.md R16 (plan.md P0.2). Each fact compares with Git's own result on a copy and prints its OBSERVATION line.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePatch } from "../../src/git-service/diff-parser";
import { mapLine, parseHunks } from "../../src/git-service/line-map";
import { printOrigin } from "../origin";
import { FIXTURE_HOME, FIXTURE_ROOT, fixturePath, useFixtureRoot } from "./fixture-root";
import { GIT } from "./git-binary";
import { sha256 } from "./git-oracle";
import {
  blameLarge,
  buildBlame,
  buildBranches,
  buildHistory,
  buildPartialClone,
  buildRenames,
  buildShallowHistory,
  buildWide,
  EMPTY_TREE,
  gitExit,
  gitVersion,
  RENAME_PAIRS,
  runGit,
  WIDE_FILES,
  wideLarge,
  type Built,
} from "./history-diff-fixtures";
import { canary } from "./workbench-fixtures";

printOrigin("../../src/git-service/diff-parser.ts", import.meta.dir);
printOrigin("../../src/git-service/line-map.ts", import.meta.dir);
printOrigin("./history-diff-fixtures.ts", import.meta.dir);

useFixtureRoot();

const EXPECTED_VERSION = "git version 2.56.0.windows.2";
const TIMEOUT_MS = 300_000;
const LARGE_TIMEOUT_MS = 20 * 60_000;
const NUL = "\0";

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};
const version = GIT === null ? "none" : gitVersion(GIT);
const g = (repo: string, args: string[], options: { input?: Uint8Array; env?: Record<string, string | undefined>; allowExit?: number[] } = {}) => runGit(gitPath(), FIXTURE_ROOT, repo, args, options);
const text = (repo: string, args: string[], options: { input?: Uint8Array; env?: Record<string, string | undefined> } = {}) => g(repo, args, options).toString("utf8");
const run = (repo: string, args: string[], env: Record<string, string | undefined> = {}, input?: Uint8Array) => gitExit(gitPath(), FIXTURE_ROOT, repo, args, env, input);

// tasks.md "Harness and tick rules": each fact prints its line with the observed Git version.
function observe(task: string, fact: string, holds: boolean): void {
  console.log(`OBSERVATION ${task}: ${fact} ${holds ? "holds" : "DOES NOT HOLD"} (${version})`);
}

const gitCase = (name: string, body: () => unknown, timeoutMs = TIMEOUT_MS) => (GIT === null ? test.skip(`${name} (SKIP: Git executable absent)`, () => {}) : test(name, async () => void (await body()), timeoutMs));

// diff-format(5) "Raw output format" with `-z`. A test-own splitter, independent of `src/git-service/`.
interface RawRecord {
  modes: [string, string];
  oids: [string, string];
  status: string;
  paths: string[];
}
function rawRecords(out: Buffer): RawRecord[] {
  const parts = out.toString("latin1").split(NUL);
  if (parts.pop() !== "") throw new Error("raw output does not end with NUL");
  const records: RawRecord[] = [];
  for (let i = 0; i < parts.length; ) {
    const m = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/.exec(parts[i]!);
    if (m === null) throw new Error(`raw header ${JSON.stringify(parts[i])}`);
    const n = /^[RC]/.test(m[5]!) ? 2 : 1;
    records.push({ modes: [m[1]!, m[2]!], oids: [m[3]!, m[4]!], status: m[5]!, paths: parts.slice(i + 1, i + 1 + n) });
    i += 1 + n;
  }
  return records;
}

const diffTree = (repo: string, base: string, oid: string, extra: string[] = [], env: Record<string, string | undefined> = {}, root = FIXTURE_ROOT) =>
  rawRecords(runGit(gitPath(), root, repo, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", ...extra, "diff-tree", "-r", "-z", "--raw", "-M", "-l1000", base, oid], { env }));

function treeOf(repo: string, oid: string): Record<string, string> {
  const out = g(repo, ["ls-tree", "-r", "-z", oid]).toString("utf8").split(NUL).filter((r) => r !== "");
  return Object.fromEntries(out.map((r) => [r.slice(r.indexOf("\t") + 1), r.slice(0, 6)]));
}

const firstParent = (b: Built, label: string) => (b.parents[label] === 0 ? EMPTY_TREE[b.objectFormat] : text(b.repo, ["rev-parse", `${b.oids[label]}^1`]).trim());

// T016: the declared trees, parent counts, and changed-file counts against Git.
function checkFixture(b: Built): void {
  for (const label of Object.keys(b.oids)) {
    const oid = b.oids[label]!;
    expect({ label, tree: treeOf(b.repo, oid) }).toEqual({ label, tree: b.trees[label]! });
    const parents = text(b.repo, ["rev-list", "--parents", "-n", "1", oid]).trim().split(" ").length - 1;
    expect({ label, parents }).toEqual({ label, parents: b.parents[label]! });
    if (b.changes[label] !== undefined) expect({ label, changes: diffTree(b.repo, firstParent(b, label), oid).length }).toEqual({ label, changes: b.changes[label]! });
  }
}

const refsOf = (repo: string) => text(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
const indexDigest = (repo: string) => sha256(g(repo, ["ls-files", "-s", "-z"]));

function sameBuilds(a: Built, b: Built): void {
  expect(refsOf(b.repo)).toBe(refsOf(a.repo));
  expect(b.oids).toEqual(a.oids);
  expect(indexDigest(b.repo)).toBe(indexDigest(a.repo));
  for (const oid of Object.values(a.oids)) expect(treeOf(b.repo, oid)).toEqual(treeOf(a.repo, oid));
}

describe("T016 builder self-check (plan.md P0.1)", () => {
  gitCase("history: trees, parent counts, changed-file counts, and index digest; two builds give equal trees and refs", () => {
    const a = buildHistory(gitPath(), "t016-history-a");
    const b = buildHistory(gitPath(), "t016-history-b");
    checkFixture(a);
    checkFixture(b);
    sameBuilds(a, b);
  });

  gitCase("history in SHA-256: the same declared facts", () => {
    const a = buildHistory(gitPath(), "t016-history256-a", "sha256");
    const b = buildHistory(gitPath(), "t016-history256-b", "sha256");
    expect(text(a.repo, ["rev-parse", "--show-object-format"]).trim()).toBe("sha256");
    checkFixture(a);
    sameBuilds(a, b);
  });

  gitCase("shallow clone: the tip is the only shallow commit and has no parent in the clone", () => {
    const source = buildHistory(gitPath(), "t016-shallow-source");
    const repo = buildShallowHistory(gitPath(), source, "t016-shallow");
    const shallowFile = join(repo, ".git", "shallow");
    expect(readFileSync(shallowFile, "utf8")).toBe(`${source.oids.merge3}\n`);
    expect(text(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim()).toBe(source.oids.merge3!);
  });

  gitCase("partial clone: the commits and trees are present, and every blob is missing", () => {
    const source = buildHistory(gitPath(), "t016-partial-source");
    const repo = buildPartialClone(gitPath(), source, "t016-partial");
    const blob = text(source.repo, ["rev-parse", `${source.oids.normal}:a.txt`]).trim();
    const checked = run(repo, ["--no-lazy-fetch", "cat-file", "--batch-check"], {}, Buffer.from(`${blob}\n${source.oids.normal}\n`));
    expect(checked.stdout.toString()).toBe(`${blob} missing\n${source.oids.normal} commit ${text(source.repo, ["cat-file", "-s", source.oids.normal!]).trim()}\n`);
    expect(text(repo, ["config", "remote.origin.promisor"]).trim()).toBe("true");
  });

  gitCase("wide 1,000-file commit and the 1,001 inexact renames", () => {
    const wide = buildWide(gitPath(), "t016-wide");
    checkFixture(wide);
    const renames = buildRenames(gitPath(), "t016-renames");
    checkFixture(renames);
    sameBuilds(renames, buildRenames(gitPath(), "t016-renames-b"));
  });

  gitCase("blame: trees, parents, counts, and equal builds", () => {
    const a = buildBlame(gitPath(), "t016-blame-a");
    checkFixture(a);
    sameBuilds(a, buildBlame(gitPath(), "t016-blame-b"));
    expect(readFileSync(join(a.repo, "nolf.txt"), "utf8")).toBe("x\ny\nz");
  });

  gitCase("branches: the pruned upstream, the removed remote, no upstream, and the packed case-variant names", () => {
    const b = buildBranches(gitPath(), "t016-branches");
    const refs = text(b.repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]).trim().split("\n");
    expect(refs.toSorted()).toEqual(["refs/heads/Feature/a", "refs/heads/feature/b", "refs/heads/gone", "refs/heads/main", "refs/heads/noremote", "refs/heads/plain", "refs/heads/present"]);
    const packed = readFileSync(join(b.repo, ".git", "packed-refs"), "utf8");
    expect(packed.includes(" refs/heads/feature/b\n") && packed.includes(" refs/heads/Feature/a\n")).toBe(true);
    expect(run(b.repo, ["show-ref", "--exists", "refs/remotes/origin/gone"]).exitCode).toBe(2);
    expect(sha256(Buffer.from(refsOf(b.repo)))).toBe(sha256(Buffer.from(refsOf(buildBranches(gitPath(), "t016-branches-b").repo))));
  });

  gitCase(
    "the cached 100,001-file commit and the cached 10,000-line, 5,000-commit file",
    () => {
      const wide = wideLarge(gitPath());
      expect(diffTree(wide.repo, wide.oids.base!, wide.oids.wide!, [], {}, wide.root).length).toBe(WIDE_FILES);
      expect(runGit(gitPath(), wide.root, wide.repo, ["rev-list", "--parents", "-n", "1", wide.oids.wide!]).toString().trim().split(" ").length).toBe(2);
      const big = blameLarge(gitPath());
      expect(runGit(gitPath(), big.root, big.repo, ["rev-list", "--count", "HEAD"]).toString().trim()).toBe("5000");
      expect(readFileSync(join(big.repo, "big.txt"), "utf8").split("\n").length - 1).toBe(10_000);
    },
    LARGE_TIMEOUT_MS,
  );
});

// ---- T018 facts ----

describe("T018 Git facts F1 to F9 and F17 (research.md R16)", () => {
  gitCase("Git version", () => {
    observe("T018", `Git version ${version} equals ${EXPECTED_VERSION}:`, version === EXPECTED_VERSION);
  });

  gitCase("F1: the raw -z grammar for A, D, M, R, T, a gitlink, and a link; the root against the empty tree in SHA-1 and SHA-256; diff-tree <merge> alone prints nothing", () => {
    const b = buildHistory(gitPath(), "t018-f1");
    const all = (["root", "normal", "rename", "mode", "binary", "submodule", "typechange", "filedir"] as const).flatMap((l) => diffTree(b.repo, firstParent(b, l), b.oids[l]!));
    const statuses = new Set(all.map((r) => r.status));
    const grammar = all.every((r) => /^(?:[ADMT]|R(?:0[0-9]{2}|100))$/.test(r.status) && r.oids.every((o) => /^[0-9a-f]{40}$/.test(o)));
    const zeroSides = all.filter((r) => r.status === "A").every((r) => r.modes[0] === "000000" && /^0{40}$/.test(r.oids[0])) && all.filter((r) => r.status === "D").every((r) => r.modes[1] === "000000" && /^0{40}$/.test(r.oids[1]));
    const renamed = all.find((r) => r.status.startsWith("R"));
    const gitlink = all.some((r) => r.modes.includes("160000"));
    const link = all.some((r) => r.modes.includes("120000") && r.status === "A");
    const empty1 = text(b.repo, ["hash-object", "-t", "tree", "--stdin"], { input: new Uint8Array() }).trim();
    const b256 = buildHistory(gitPath(), "t018-f1-256", "sha256");
    const empty256 = text(b256.repo, ["hash-object", "-t", "tree", "--stdin"], { input: new Uint8Array() }).trim();
    const root256 = diffTree(b256.repo, empty256, b256.oids.root!);
    const merge = run(b.repo, ["--no-lazy-fetch", "--no-optional-locks", "diff-tree", "-r", "-z", "--raw", "-M", "-l1000", b.oids.merge2!]);
    const holds =
      ["A", "D", "M", "R092", "T"].every((s) => statuses.has(s)) &&
      grammar &&
      zeroSides &&
      renamed?.paths.join(",") === "ren.txt,renamed.txt" &&
      gitlink &&
      link &&
      empty1 === EMPTY_TREE.sha1 &&
      empty256 === EMPTY_TREE.sha256 &&
      root256.length === 10 &&
      root256.every((r) => r.status === "A" && /^0{64}$/.test(r.oids[0])) &&
      merge.exitCode === 0 &&
      merge.stdout.length === 0;
    observe("T018", "F1 raw grammar A D M R092 T, gitlink and link records, empty-tree roots in SHA-1 and SHA-256, and an empty diff-tree <merge>:", holds);
    expect(holds).toBe(true);
  });

  gitCase("F2: above -l1000 Git prints D and A records, and diff.renameLimit has no effect", () => {
    const b = buildRenames(gitPath(), "t018-f2");
    const limited = diffTree(b.repo, b.oids.before!, b.oids.after!);
    const configured = diffTree(b.repo, b.oids.before!, b.oids.after!, ["-c", "diff.renameLimit=5000"]);
    const wider = rawRecords(g(b.repo, ["diff-tree", "-r", "-z", "--raw", "-M", "-l2000", b.oids.before!, b.oids.after!]));
    const count = (rs: RawRecord[], s: string) => rs.filter((r) => r.status.startsWith(s)).length;
    const holds =
      count(limited, "D") === RENAME_PAIRS &&
      count(limited, "A") === RENAME_PAIRS &&
      count(limited, "R") === 0 &&
      JSON.stringify(configured) === JSON.stringify(limited) &&
      count(wider, "R") === RENAME_PAIRS;
    observe("T018", "F2 -l1000 gives 1,001 D and 1,001 A records, diff.renameLimit=5000 changes nothing, and -l2000 pairs all 1,001:", holds);
    expect(holds).toBe(true);
  });

  gitCase("F3: the path-pair patch of a rename parses with the extended header rules; a type change gives two patch sections and one numstat record", () => {
    const b = buildHistory(gitPath(), "t018-f3");
    const patchArgs = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "diff-tree", "-p", "--no-textconv", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=dirty", "-M", "-l1000"];
    const rename = g(b.repo, [...patchArgs, firstParent(b, "rename"), b.oids.rename!, "--", "renamed.txt", "ren.txt"]);
    const header = rename.toString("utf8").split("\n").slice(0, 7);
    const parsed = parsePatch(new Uint8Array(rename), Buffer.from("renamed.txt"), Buffer.from("ren.txt"));
    const typePatch = g(b.repo, [...patchArgs, firstParent(b, "typechange"), b.oids.typechange!, "--", "typ"]).toString("utf8");
    const sections = typePatch.split("\n").filter((l) => l.startsWith("diff --git "));
    const typeNumstat = g(b.repo, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "diff-tree", "--numstat", "-z", "--no-textconv", "--no-ext-diff", "--no-relative", "--ignore-submodules=dirty", "-M", "-l1000", firstParent(b, "typechange"), b.oids.typechange!, "--", "typ"]).toString("latin1");
    const holds =
      header[0] === "diff --git a/ren.txt b/renamed.txt" &&
      header[1] === "similarity index 92%" &&
      header[2] === "rename from ren.txt" &&
      header[3] === "rename to renamed.txt" &&
      /^index [0-9a-f]+\.\.[0-9a-f]+ 100644$/.test(header[4]!) &&
      header[5] === "--- a/ren.txt" &&
      header[6] === "+++ b/renamed.txt" &&
      parsed.ok &&
      parsed.patch.hunks.length === 1 &&
      sections.length === 2 &&
      sections.every((s) => s === "diff --git a/typ b/typ") &&
      typePatch.includes("\ndeleted file mode 100644\n") &&
      typePatch.includes("\nnew file mode 120000\n") &&
      typeNumstat === "1\t1\ttyp\0";
    observe("T018", "F3 the rename patch header order of diff.c fill_metainfo, its parse, and a type change as two sections with one numstat record:", holds);
    expect(holds).toBe(true);
  });

  gitCase("F4: diff-tree and ls-files run a command-valued core.fsmonitor; git diff of trees and blobs, ls-tree, cat-file, blame <commit>, and check-ignore --no-index do not", () => {
    const b = buildHistory(gitPath(), "t018-f4");
    const c = canary(fixturePath("t018-f4"), "fsmonitor");
    g(b.repo, ["config", "core.fsmonitor", c.command]);
    const blobA = text(b.repo, ["rev-parse", `${b.oids.root}:a.txt`]).trim();
    const blobB = text(b.repo, ["rev-parse", `${b.oids.normal}:a.txt`]).trim();
    const R = ["--no-lazy-fetch", "--no-optional-locks"];
    const L = [...R, "--literal-pathspecs"];
    const ran = (args: string[], input?: Uint8Array) => {
      if (existsSync(c.log)) writeFileSync(c.log, "");
      run(b.repo, args, {}, input);
      return existsSync(c.log) && readFileSync(c.log, "utf8").length > 0;
    };
    const runs = {
      "diff-tree": ran([...L, "diff-tree", "-r", "-z", "--raw", "-M", "-l1000", b.oids.root!, b.oids.normal!]),
      "ls-files": ran([...L, "ls-files", "-z"]),
    };
    const quiet = {
      "diff trees": ran([...L, "diff", "--numstat", "-z", "--no-textconv", "--no-ext-diff", "--no-relative", "--no-renames", EMPTY_TREE.sha1, b.oids.normal!, "--", "a.txt"]),
      "diff blobs": ran([...R, "diff", "-U0", "--inter-hunk-context=0", "--no-textconv", "--no-ext-diff", "--no-color", blobA, blobB]),
      "ls-tree": ran([...L, "ls-tree", "-z", "-l", "--full-tree", b.oids.normal!, "--", "a.txt"]),
      "cat-file": ran([...R, "cat-file", "blob", blobB]),
      blame: ran([...L, "blame", "--incremental", "--no-textconv", "--encoding=none", b.oids.normal!, "--", "a.txt"]),
      "check-ignore": ran(["--no-lazy-fetch", "check-ignore", "--no-index", "-z", "--stdin", "-v", "-n"], Buffer.from("a.txt\0")),
      config: ran([...R, "config", "get", "--all", "--type=path", "-z", "blame.ignoreRevsFile"]),
    };
    const holds = Object.values(runs).every(Boolean) && !Object.values(quiet).some(Boolean);
    observe("T018", `F4 canary runs ${JSON.stringify(runs)} and stays absent ${JSON.stringify(quiet)}:`, holds);
    expect({ runs, quiet }).toEqual({ runs: { "diff-tree": true, "ls-files": true }, quiet: Object.fromEntries(Object.keys(quiet).map((k) => [k, false])) as typeof quiet });
  });

  gitCase("F5: the ls-tree -z -l --full-tree record for a blob, a link, and a gitlink; a missing tree in a partial clone exits non-zero with --no-lazy-fetch", () => {
    const b = buildHistory(gitPath(), "t018-f5");
    const record = (path: string) => g(b.repo, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "ls-tree", "-z", "-l", "--full-tree", b.oids.normal!, "--", path]).toString("utf8");
    // builtin/ls-tree.c `show_tree_long`: `"%06o %s %s %7s\t"`, so the padding follows the separator space.
    const form = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}) ( *)(-|0|[1-9][0-9]*)\t([^\0]+)\0$/;
    const width = (m: RegExpExecArray) => m[4]!.length === Math.max(0, 7 - m[5]!.length);
    const blob = form.exec(record("a.txt"));
    const link = form.exec(record("lnk"));
    const gitlink = form.exec(record("lib"));
    const size = (oid: string) => text(b.repo, ["cat-file", "-s", oid]).trim();
    const partial = buildPartialClone(gitPath(), buildHistory(gitPath(), "t018-f5-source"), "t018-f5-partial", "tree:0");
    const tip = text(partial, ["rev-parse", "HEAD"]).trim();
    const missing = run(partial, ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "ls-tree", "-z", "-l", "--full-tree", tip, "--", "a.txt"]);
    const holds =
      blob !== null &&
      blob[1] === "100644" &&
      blob[5] === size(blob[3]!) &&
      width(blob) &&
      link !== null &&
      link[1] === "120000" &&
      link[2] === "blob" &&
      link[5] === size(link[3]!) &&
      width(link) &&
      gitlink !== null &&
      gitlink[1] === "160000" &&
      gitlink[2] === "commit" &&
      gitlink[5] === "-" &&
      width(gitlink) &&
      missing.exitCode !== 0 &&
      missing.stdout.length === 0;
    observe("T018", `F5 ls-tree blob, link, and gitlink records ${JSON.stringify([blob?.slice(1), link?.slice(1), gitlink?.slice(1)])} with a %7s size field, and a missing tree exit ${missing.exitCode}:`, holds);
    expect(holds).toBe(true);
  });

  gitCase("F6: both blame grammars: previous, filename, boundary, the porcelain marks under the -c keys, no marks in incremental output, and the count of a last line without LF", () => {
    const b = buildBlame(gitPath(), "t018-f6");
    writeFileSync(join(b.repo, ".revs"), `${b.oids.b7}\n`);
    const B = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
    const marks = ["-c", "blame.markIgnoredLines=true", "-c", "blame.markUnblamableLines=true"];
    const incremental = text(b.repo, [...B, ...marks, "-c", "blame.ignoreRevsFile=.revs", "blame", "--incremental", "--no-textconv", "--encoding=none", b.oids.b7!, "--", "tale.txt"]);
    const porcelain = text(b.repo, [...B, ...marks, "-c", "blame.ignoreRevsFile=.revs", "blame", "--porcelain", "--no-textconv", "--encoding=none", b.oids.b7!, "--", "tale.txt"]);
    const plain = text(b.repo, [...B, "-c", "blame.ignoreRevsFile=.revs", "blame", "--porcelain", "--no-textconv", "--encoding=none", b.oids.b7!, "--", "tale.txt"]);
    const has = (out: string, key: string) => out.split("\n").some((l) => l === key || l.startsWith(`${key} `));
    const nolf = text(b.repo, [...B, "blame", "--incremental", "--no-textconv", "--encoding=none", b.oids.b8!, "--", "nolf.txt"]);
    const counted = nolf
      .split("\n")
      .map((l) => /^[0-9a-f]{40} \d+ \d+ (\d+)$/.exec(l))
      .filter((m) => m !== null)
      .reduce((n, m) => n + Number(m![1]), 0);
    const holds =
      has(incremental, "previous") &&
      has(incremental, "filename") &&
      has(incremental, "boundary") &&
      !has(incremental, "ignored") &&
      !has(incremental, "unblamable") &&
      (has(porcelain, "ignored") || has(porcelain, "unblamable")) &&
      !has(plain, "ignored") &&
      !has(plain, "unblamable") &&
      counted === 3;
    observe("T018", "F6 incremental and porcelain headers, marks only in porcelain with the -c keys, and a last line without LF counted:", holds);
    expect(holds).toBe(true);
  });

  gitCase("F7: a missing relative blame.ignoreRevsFile exits 128 in both toggle states; an empty value resets nothing; --ignore-revs-file= clears; ~/ and :(optional) through config get --all --type=path -z", () => {
    const b = buildBlame(gitPath(), "t018-f7");
    writeFileSync(join(b.repo, ".revs"), `${b.oids.b7}\n`);
    const B = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
    const marks = ["-c", "blame.markIgnoredLines=true", "-c", "blame.markUnblamableLines=true"];
    const blame = (config: string[], extra: string[] = []) => run(b.repo, [...B, ...marks, ...config.flatMap((v) => ["-c", `blame.ignoreRevsFile=${v}`]), "blame", "--porcelain", "--no-textconv", "--encoding=none", ...extra, b.oids.b7!, "--", "tale.txt"]);
    const marked = (r: { stdout: Buffer }) => r.stdout.toString().split("\n").filter((l) => l === "ignored" || l === "unblamable").length;
    const missing = blame(["missing.revs"]).exitCode;
    const missingOff = blame(["missing.revs"], ["--ignore-revs-file="]).exitCode;
    const missingIncremental = run(b.repo, [...B, "-c", "blame.ignoreRevsFile=missing.revs", "blame", "--incremental", "--no-textconv", "--encoding=none", "--ignore-revs-file=", b.oids.b7!, "--", "tale.txt"]).exitCode;
    const one = marked(blame([".revs"]));
    const emptyAfter = marked(blame([".revs", ""]));
    const cleared = marked(blame([".revs"], ["--ignore-revs-file="]));
    writeFileSync(join(FIXTURE_HOME, "home.revs"), `${b.oids.b7}\n`);
    for (const value of [".revs", "", "~/home.revs", ":(optional)absent.revs", ":(optional).revs"]) g(b.repo, ["config", "--add", "blame.ignoreRevsFile", value]);
    const listed = g(b.repo, ["--no-lazy-fetch", "--no-optional-locks", "config", "get", "--all", "--type=path", "-z", "blame.ignoreRevsFile"]).toString("utf8");
    const none = run(buildBlame(gitPath(), "t018-f7-none").repo, ["--no-lazy-fetch", "--no-optional-locks", "config", "get", "--all", "--type=path", "-z", "blame.ignoreRevsFile"]);
    const home = join(FIXTURE_HOME, "home.revs").replaceAll("\\", "/");
    const holds =
      missing === 128 &&
      missingOff === 128 &&
      missingIncremental === 128 &&
      one > 0 &&
      emptyAfter === one &&
      cleared === 0 &&
      (listed === `.revs\0\0${home}\0.revs\0` || listed === `.revs\0\0${join(FIXTURE_HOME, "home.revs")}\0.revs\0`) &&
      none.exitCode === 1 &&
      none.stdout.length === 0;
    observe("T018", `F7 missing file exits ${missing}/${missingOff}/${missingIncremental}, an empty value keeps ${emptyAfter} of ${one} marks, --ignore-revs-file= leaves ${cleared}, config get lists ${JSON.stringify(listed)}:`, holds);
    expect(holds).toBe(true);
  });

  gitCase("F8: the incremental attribution equals git blame --porcelain with -w, -M, and -C on every fixture line", () => {
    const b = buildBlame(gitPath(), "t018-f8");
    const B = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
    const results: string[] = [];
    let holds = true;
    for (const opts of [[], ["-w"], ["-M"], ["-C"], ["-w", "-M", "-C"]]) {
      for (const [commit, path] of [[b.oids.b7!, "tale.txt"], [b.oids.b7!, "other.txt"], [b.oids.b8!, "nolf.txt"], [b.oids.b2!, "story.txt"]] as const) {
        const inc = perLine(text(b.repo, [...B, "blame", "--incremental", "--no-textconv", "--encoding=none", ...opts, commit, "--", path]), "incremental");
        const por = perLine(text(b.repo, [...B, "blame", "--porcelain", "--no-textconv", "--encoding=none", ...opts, commit, "--", path]), "porcelain");
        const same = JSON.stringify(inc) === JSON.stringify(por) && inc.length > 0;
        holds &&= same;
        results.push(`${path}${opts.join("")}:${same}`);
      }
    }
    observe("T018", `F8 incremental equals porcelain ${results.join(" ")}:`, holds);
    expect(holds).toBe(true);
  });

  gitCase("F9: the diff -U0 --inter-hunk-context=0 hunk headers of two blobs, the FR-056 map on unchanged lines, also with diff.interHunkContext=3", () => {
    const b = buildBlame(gitPath(), "t018-f9");
    const oldText = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join("");
    const newText = oldText.replace("line 3\n", "line three\n").replace("line 6\n", "line six\nline six b\n").replace("line 9\n", "");
    const hash = (t: string) => text(b.repo, ["hash-object", "-w", "--stdin"], { input: Buffer.from(t) }).trim();
    const pairs: [string, string][] = [
      [hash(oldText), hash(newText)],
      [text(b.repo, ["rev-parse", `${b.oids.b2}:story.txt`]).trim(), text(b.repo, ["rev-parse", `${b.oids.b3}:tale.txt`]).trim()],
      [text(b.repo, ["rev-parse", `${b.oids.b3}:tale.txt`]).trim(), text(b.repo, ["rev-parse", `${b.oids.b4}:tale.txt`]).trim()],
      [text(b.repo, ["rev-parse", `${b.oids.b6}:tale.txt`]).trim(), text(b.repo, ["rev-parse", `${b.oids.b7}:tale.txt`]).trim()],
    ];
    const R = ["--no-lazy-fetch", "--no-optional-locks"];
    const diff = (a: string, z: string, config: string[] = [], flag = true) => g(b.repo, [...R, ...config, "diff", "-U0", ...(flag ? ["--inter-hunk-context=0"] : []), "--no-textconv", "--no-ext-diff", "--no-color", a, z]);
    const headers = (out: Buffer) => out.toString("utf8").split("\n").filter((l) => l.startsWith("@@ "));
    let holds = true;
    const notes: string[] = [];
    for (const [a, z] of pairs) {
      const plain = diff(a, z);
      const configured = diff(a, z, ["-c", "diff.interHunkContext=3"]);
      const hunks = parseHunks(new Uint8Array(plain));
      const oldLines = text(b.repo, ["cat-file", "blob", a]).split("\n").slice(0, -1);
      const newLines = text(b.repo, ["cat-file", "blob", z]).split("\n").slice(0, -1);
      const sameHeaders = JSON.stringify(headers(plain)) === JSON.stringify(headers(configured));
      let mapped = hunks !== null;
      if (hunks !== null) {
        for (let o = 1; o <= newLines.length; o++) {
          const inside = hunks.some((h) => h.newCount > 0 && h.newStart <= o && o < h.newStart + h.newCount);
          if (!inside && oldLines[mapLine(o, hunks, oldLines.length) - 1] !== newLines[o - 1]) mapped = false;
        }
      }
      holds &&= sameHeaders && mapped;
      notes.push(`${headers(plain).length} hunks same=${sameHeaders} mapped=${mapped}`);
    }
    // Without the option, the configured context merges the two near hunks of the first pair.
    const merged = headers(diff(pairs[0]![0], pairs[0]![1], ["-c", "diff.interHunkContext=3"], false)).length < headers(diff(pairs[0]![0], pairs[0]![1])).length;
    holds &&= merged;
    observe("T018", `F9 ${notes.join("; ")}; diff.interHunkContext=3 merges hunks without the option: ${merged}:`, holds);
    expect(holds).toBe(true);
  });

  gitCase("F17: %(upstream) names a pruned upstream whose ref is missing, and is empty for a removed remote", () => {
    const b = buildBranches(gitPath(), "t018-f17");
    const rows = Object.fromEntries(
      text(b.repo, ["for-each-ref", "--format=%(refname)%00%(upstream)", "refs/heads"])
        .trim()
        .split("\n")
        .map((l) => l.split(NUL) as [string, string]),
    );
    const gone = rows["refs/heads/gone"];
    const holds = gone === "refs/remotes/origin/gone" && run(b.repo, ["show-ref", "--exists", gone]).exitCode === 2 && rows["refs/heads/noremote"] === "" && rows["refs/heads/plain"] === "" && rows["refs/heads/present"] === "refs/remotes/origin/present";
    observe("T018", `F17 pruned upstream ${JSON.stringify(gone)} missing, removed remote ${JSON.stringify(rows["refs/heads/noremote"])}:`, holds);
    expect(holds).toBe(true);
  });
});

// git-blame(1): the commit of each final line. A test-own parse, independent of `src/git-service/blame-parser.ts`.
function perLine(out: string, mode: "incremental" | "porcelain"): string[] {
  const at: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (m === null) continue;
    const count = mode === "incremental" ? Number(m[4]) : 1;
    for (let i = 0; i < count; i++) at[Number(m[3]) - 1 + i] = `${m[1]}:${Number(m[2]) + i}`;
  }
  return at;
}
