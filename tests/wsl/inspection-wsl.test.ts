// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T059: the WSL rows of quickstart.md Q33, Q16, Q22, and Q25 in the distro of `ARBARETO_WSL_DISTRO` (feature 005 plan.md P9, WP8). `Local: WSL`.
// The Windows builders make each fixture, and a `tar` stream on stdin copies it into the owned distro folder. The oracle is the distro Git on a copy.
// Each fact prints `OBSERVATION T059: <fact> holds|DOES NOT HOLD (<Git version>)`. A failed fact is a finding for research.md R17.
// The `wslFiles` cases run the Perl text of `src/contracts/wsl-process.json` through the contract §11 wrapper, with the arguments and the stdin tokens
// of `src-tauri/src/wsl.rs` `files_perl`. Their operation IDs start with `0f0f0f0f-0000-4000-8009-`, and no other test uses that prefix.
// T078: the Delete, preview, and Save rows run through the WSL file actions of the shell test double `tests/git/bun-runner.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import wslProcess from "../../src/contracts/wsl-process.json";
import { parsePatch } from "../../src/git-service/diff-parser";
import { mapLine, parseHunks } from "../../src/git-service/line-map";
import { printOrigin } from "../origin";
import { buildCaseNames, buildConflicted, buildFiles, buildIgnoreForm, buildLinkedWorktree, buildReport, buildSubmodules, REPORT_ROOT_TEXT } from "../git/file-actions-fixtures";
import { fixturePath, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { GIT } from "../git/git-binary";
import { sha256 } from "../git/git-oracle";
import { buildBlame, buildBranches, buildHistory, buildPartialClone, buildRenames, EMPTY_TREE, HISTORY_LABELS, RENAME_PAIRS, type Built, type ObjectFormat } from "../git/history-diff-fixtures";
import { outcome, readOk, subcommand, SUCCEEDED, until } from "../git/hunk-harness";
import { gitOut, gitRun, type GitHost, type RunOptions } from "../git/remote-fixtures";
import { OPERATION_MARKERS } from "../../src/git-service/commands";
import { PREVIEW_GROUP_PATHS } from "../../src/contracts/limits";
import { comparePaths } from "../../src/contracts/tree-order";
import { openService, withFsCalls, type Envelope, type FsCall, type RegistrationResult, type Service, type ServiceResponse } from "../git/service-harness";
import { distroGitHost, globalConfig, sh } from "./fixtures";
import { inDistro, listScopes, OWN_SCOPE_OPERATIONS, pgrep, uncPath, useWslFolder, WSL_ENV, WSL_EXE, WSL_FILES_TEXT, wslExec, wslTest, type WslCapability, type WslHost } from "./wsl-host";

for (const module of ["commit-changes", "blame", "ignore", "file-delete", "workbench-review", "submodule-open", "submodule-change", "session"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
printOrigin("../../src/git-service/diff-parser.ts", import.meta.dir);
printOrigin("../../src/git-service/commands.ts", import.meta.dir);
printOrigin("../../src/git-service/line-map.ts", import.meta.dir);
printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);

useFixtureRoot();
useWslFolder();

const TASK = "T059";
const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55", "perl"];
const FACT_MS = 900_000;
const CASE_MS = 900_000;
// Each WSL step runs several `wsl.exe` processes, so a service read can take longer than the default response wait of the harness.
const RESPONSE_MS = 300_000;
// Contract §11 "Process ownership": no Linux process of the operation remains 1 second after the Job close.
const AFTER_CLOSE_MS = 1_000;
// The bounds of one `wslFiles` run, of the test seam hold, and of one `tar` stream.
const RUN_MS = 120_000;
const HELD_MS = 60_000;
const TAR_MS = 120_000;
const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const READ = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
const NUL = "\0";
const GLOBAL = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

// ---- The distro host and the fixture transfer ----

let distroHost: GitHost | undefined;
const hostOf = (w: WslHost): GitHost => (distroHost ??= distroGitHost(w, "t059", GLOBAL));

let transfers = 0;
// The Windows fixture folder goes into `<owned folder>/t059/<label>-<n>` through a tar stream on stdin.
function copyIn(w: WslHost, folder: string, label: string): string {
  const dest = `${hostOf(w).root}/${label}-${++transfers}`;
  inDistro(w.distro, ["/usr/bin/mkdir", "-p", "--", dest]);
  const tar = Bun.spawnSync([TAR, "--no-acls", "--no-xattrs", "--no-fflags", "-c", "-f", "-", "-C", folder, "."], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TAR_MS });
  if (tar.exitCode !== 0) throw new Error(`tar -c of ${folder} exited ${tar.exitCode}: ${tar.stderr.toString()}`);
  const x = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/usr/bin/tar", "-x", "-f", "-", "-C", dest], { input: new Uint8Array(tar.stdout), timeoutMs: TAR_MS });
  if (x.exitCode !== 0) throw new Error(`tar -x into ${dest} exited ${x.exitCode}: ${x.stderr}`);
  return dest;
}

// Git for Windows writes `core.symlinks`, `core.ignorecase`, and `core.filemode` at `init` (Windows facts), so each copied repository drops them.
// The copy gives every file new stat data, so the index entries get a refresh.
function prepare(h: GitHost, repos: string[]): void {
  for (const repo of repos) {
    for (const key of ["core.symlinks", "core.ignorecase", "core.filemode"]) gitRun(h, repo, ["config", "--local", "--unset", key], { allowExit: [0, 5] });
    gitRun(h, repo, ["update-index", "-q", "--refresh"], { allowExit: [0, 1] });
  }
}

const slash = (p: string) => p.replaceAll("\\", "/");
// gitrepository-layout(5) `worktrees/<id>/gitdir` and the `.git` file of a linked worktree hold the Windows paths of the build.
function rewritePrefix(h: GitHost, file: string, from: string, to: string): void {
  const content = h.read(file)?.toString("utf8") ?? "";
  const at = content.indexOf(from);
  if (at < 0) throw new Error(`${file} does not name ${from}: ${JSON.stringify(content)}`);
  h.write(file, `${content.slice(0, at)}${to}${content.slice(at + from.length)}`);
}

const g = (h: GitHost, dir: string, args: string[], o: RunOptions & { allowExit?: number[] } = {}) => gitRun(h, dir, args, o).stdout;
const t = (h: GitHost, dir: string, args: string[], o: RunOptions & { allowExit?: number[] } = {}) => g(h, dir, args, o).toString("utf8");
const records = (out: Buffer): string[] => {
  const parts = out.toString("utf8").split(NUL);
  if (parts.pop() !== "") throw new Error("a -z listing does not end with NUL");
  return parts;
};
const byBytes = (paths: Iterable<string>) => [...new Set(paths)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const listed = (h: GitHost, dir: string, args: string[]) => byBytes(records(g(h, dir, args)));
// The kind of each absolute path: `l` link, `d` folder, `f` regular file, `o` other, `a` absent. One line per argument.
function kinds(w: WslHost, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const script = 'for p; do if [ -L "$p" ]; then echo l; elif [ -d "$p" ]; then echo d; elif [ -f "$p" ]; then echo f; elif [ -e "$p" ]; then echo o; else echo a; fi; done';
  return sh(w, script, paths).stdout.split("\n").slice(0, paths.length);
}

// ---- Facts F1 to F19 on the distro Git (research.md R16) ----

let version = "";
function observe(fact: string, holds: boolean): void {
  console.log(`OBSERVATION ${TASK}: ${fact} ${holds ? "holds" : "DOES NOT HOLD"} (${version})`);
}

// One case per fact. Each case needs the Windows Git for the builders.
function factCase(name: string, body: (w: WslHost, h: GitHost) => void): void {
  if (GIT === null) {
    console.log(`SKIP ${TASK} ${name}: Git executable absent`);
    test.skip(name, () => {});
    return;
  }
  wslTest(
    name,
    NEEDS,
    (w) => {
      const h = hostOf(w);
      version ||= gitOut(h, h.root, ["version"]).trim();
      body(w, h);
    },
    FACT_MS,
  );
}

interface History {
  b: Built;
  repo: string;
}
function historyIn(w: WslHost, name: string, format: ObjectFormat = "sha1"): History {
  const b = buildHistory(gitPath(), name, format);
  const repo = `${copyIn(w, fixturePath(name), name)}/repo`;
  prepare(hostOf(w), [repo]);
  return { b, repo };
}
function blameIn(w: WslHost, name: string): History {
  const b = buildBlame(gitPath(), name);
  const repo = `${copyIn(w, fixturePath(name), name)}/repo`;
  prepare(hostOf(w), [repo]);
  return { b, repo };
}
const firstParent = (h: GitHost, { b, repo }: History, label: string) => (b.parents[label] === 0 ? EMPTY_TREE[b.objectFormat] : t(h, repo, ["rev-parse", `${b.oids[label]}^1`]).trim());

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
  const result: RawRecord[] = [];
  for (let i = 0; i < parts.length; ) {
    const m = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/.exec(parts[i]!);
    if (m === null) throw new Error(`raw header ${JSON.stringify(parts[i])}`);
    const n = /^[RC]/.test(m[5]!) ? 2 : 1;
    result.push({ modes: [m[1]!, m[2]!], oids: [m[3]!, m[4]!], status: m[5]!, paths: parts.slice(i + 1, i + 1 + n) });
    i += 1 + n;
  }
  return result;
}
const diffTree = (h: GitHost, repo: string, base: string, oid: string, extra: string[] = []) => rawRecords(g(h, repo, [...READ, ...extra, "diff-tree", "-r", "-z", "--raw", "-M", "-l1000", base, oid]));

// A POSIX canary in `dir`. Each run appends one line to `log`.
function canaryIn(h: GitHost, dir: string, name: string): { command: string; log: string } {
  const log = `${dir}/canaries/${name}.log`;
  const script = `${dir}/canaries/${name}.sh`;
  h.write(script, `#!/bin/sh\necho "${name} $*" >> '${log}'\n`);
  return { command: `'${script}'`, log };
}

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

// git-check-ignore(1) OUTPUT with `-z -v -n`: `<source> NUL <line> NUL <pattern> NUL <path> NUL`, one record per input.
function checkIgnore(h: GitHost, dir: string, paths: readonly string[], extra: string[] = [], env: Record<string, string | undefined> = {}): { path: string; pattern: string; source: string }[] {
  const out = g(h, dir, ["--no-lazy-fetch", ...extra, "check-ignore", "--no-index", "-z", "--stdin", "-v", "-n"], { input: Buffer.from(paths.map((p) => `${p}${NUL}`).join("")), env, allowExit: [0, 1] });
  const parts = records(out);
  const result: { path: string; pattern: string; source: string }[] = [];
  for (let i = 0; i < parts.length; i += 4) result.push({ source: parts[i]!, pattern: parts[i + 2]!, path: parts[i + 3]! });
  return result;
}
const ignoredBy = (r: { pattern: string }) => r.pattern !== "" && !r.pattern.startsWith("!");
const U_ARGS = [...READ, "ls-files", "-o", "-z", "--directory", "--no-empty-directory"];
const RI_ARGS = [...READ, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"];
const RT_ARGS = [...READ, "ls-files", "-c", "-i", "--exclude-standard", "-z"];
const IGNORED_ARGS = ["ls-files", "-o", "-i", "--exclude-standard", "-z"];

let copies = 0;
// A `cp -a` copy of `repo` beside the owned host folders.
function copyOf(h: GitHost, repo: string, name: string): string {
  const to = `${h.root}/${name}-${++copies}`;
  h.copy(repo, to);
  return to;
}
function reportIn(w: WslHost, name: string): string {
  buildReport(gitPath(), name);
  const repo = `${copyIn(w, fixturePath(name), name)}/repo`;
  prepare(hostOf(w), [repo, `${repo}/nested`]);
  return repo;
}

describe("T059 Git facts F1 to F19 on the distro Git (research.md R16)", () => {
  factCase("Git version", (_w, h) => {
    observe(`Git version ${version} is a Git 2.55 release:`, /^git version 2\.55\.\d+$/.test(version));
    expect(gitOut(h, h.root, ["version"]).trim()).toBe(version);
  });

  factCase("F1: the raw -z grammar for A, D, M, R, T, a gitlink, and a link; the root against the empty tree in SHA-1 and SHA-256; diff-tree <merge> alone prints nothing", (w, h) => {
    const hi = historyIn(w, "t059-f1");
    const all = (["root", "normal", "rename", "mode", "binary", "submodule", "typechange", "filedir"] as const).flatMap((l) => diffTree(h, hi.repo, firstParent(h, hi, l), hi.b.oids[l]!));
    const statuses = new Set(all.map((r) => r.status));
    const grammar = all.every((r) => /^(?:[ADMT]|R(?:0[0-9]{2}|100))$/.test(r.status) && r.oids.every((o) => /^[0-9a-f]{40}$/.test(o)));
    const zeroSides = all.filter((r) => r.status === "A").every((r) => r.modes[0] === "000000" && /^0{40}$/.test(r.oids[0])) && all.filter((r) => r.status === "D").every((r) => r.modes[1] === "000000" && /^0{40}$/.test(r.oids[1]));
    const renamed = all.find((r) => r.status.startsWith("R"));
    const empty1 = t(h, hi.repo, ["hash-object", "-t", "tree", "--stdin"], { input: new Uint8Array() }).trim();
    const h256 = historyIn(w, "t059-f1-256", "sha256");
    const empty256 = t(h, h256.repo, ["hash-object", "-t", "tree", "--stdin"], { input: new Uint8Array() }).trim();
    const root256 = diffTree(h, h256.repo, empty256, h256.b.oids.root!);
    const merge = h.run(hi.repo, ["--no-lazy-fetch", "--no-optional-locks", "diff-tree", "-r", "-z", "--raw", "-M", "-l1000", hi.b.oids.merge2!]);
    const holds =
      ["A", "D", "M", "R092", "T"].every((s) => statuses.has(s)) &&
      grammar &&
      zeroSides &&
      renamed?.paths.join(",") === "ren.txt,renamed.txt" &&
      all.some((r) => r.modes.includes("160000")) &&
      all.some((r) => r.modes.includes("120000") && r.status === "A") &&
      empty1 === EMPTY_TREE.sha1 &&
      empty256 === EMPTY_TREE.sha256 &&
      root256.length === 10 &&
      root256.every((r) => r.status === "A" && /^0{64}$/.test(r.oids[0])) &&
      merge.exitCode === 0 &&
      merge.stdout.length === 0;
    observe("F1 raw grammar A D M R092 T, gitlink and link records, empty-tree roots in SHA-1 and SHA-256, and an empty diff-tree <merge>:", holds);
    expect(holds).toBe(true);
  });

  factCase("F2: above -l1000 Git prints D and A records, and diff.renameLimit has no effect", (w, h) => {
    buildRenames(gitPath(), "t059-f2");
    const repo = `${copyIn(w, fixturePath("t059-f2"), "t059-f2")}/repo`;
    const oids = { before: t(h, repo, ["rev-parse", "main~1"]).trim(), after: t(h, repo, ["rev-parse", "main"]).trim() };
    const limited = diffTree(h, repo, oids.before, oids.after);
    const configured = diffTree(h, repo, oids.before, oids.after, ["-c", "diff.renameLimit=5000"]);
    const wider = rawRecords(g(h, repo, ["diff-tree", "-r", "-z", "--raw", "-M", "-l2000", oids.before, oids.after]));
    const count = (rs: RawRecord[], s: string) => rs.filter((r) => r.status.startsWith(s)).length;
    const holds = count(limited, "D") === RENAME_PAIRS && count(limited, "A") === RENAME_PAIRS && count(limited, "R") === 0 && JSON.stringify(configured) === JSON.stringify(limited) && count(wider, "R") === RENAME_PAIRS;
    observe("F2 -l1000 gives 1,001 D and 1,001 A records, diff.renameLimit=5000 changes nothing, and -l2000 pairs all 1,001:", holds);
    expect(holds).toBe(true);
  });

  factCase("F3: the path-pair patch of a rename parses with the extended header rules; a type change gives two patch sections and one numstat record", (w, h) => {
    const hi = historyIn(w, "t059-f3");
    const patchArgs = [...READ, "diff-tree", "-p", "--no-textconv", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=dirty", "-M", "-l1000"];
    const rename = g(h, hi.repo, [...patchArgs, firstParent(h, hi, "rename"), hi.b.oids.rename!, "--", "renamed.txt", "ren.txt"]);
    const header = rename.toString("utf8").split("\n").slice(0, 7);
    const parsed = parsePatch(new Uint8Array(rename), Buffer.from("renamed.txt"), Buffer.from("ren.txt"));
    const typePatch = t(h, hi.repo, [...patchArgs, firstParent(h, hi, "typechange"), hi.b.oids.typechange!, "--", "typ"]);
    const sections = typePatch.split("\n").filter((l) => l.startsWith("diff --git "));
    const typeNumstat = g(h, hi.repo, [...READ, "diff-tree", "--numstat", "-z", "--no-textconv", "--no-ext-diff", "--no-relative", "--ignore-submodules=dirty", "-M", "-l1000", firstParent(h, hi, "typechange"), hi.b.oids.typechange!, "--", "typ"]).toString("latin1");
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
    observe("F3 the rename patch header order of diff.c fill_metainfo, its parse, and a type change as two sections with one numstat record:", holds);
    expect(holds).toBe(true);
  });

  factCase("F4: diff-tree and ls-files run a command-valued core.fsmonitor; git diff of trees and blobs, ls-tree, cat-file, blame <commit>, and check-ignore --no-index do not", (w, h) => {
    const hi = historyIn(w, "t059-f4");
    const c = canaryIn(h, `${h.root}/t059-f4-canary`, "fsmonitor");
    g(h, hi.repo, ["config", "core.fsmonitor", c.command]);
    const blobA = t(h, hi.repo, ["rev-parse", `${hi.b.oids.root}:a.txt`]).trim();
    const blobB = t(h, hi.repo, ["rev-parse", `${hi.b.oids.normal}:a.txt`]).trim();
    const R = ["--no-lazy-fetch", "--no-optional-locks"];
    const L = [...R, "--literal-pathspecs"];
    const ran = (args: string[], input?: Uint8Array) => {
      h.write(c.log, "");
      h.run(hi.repo, args, input === undefined ? {} : { input });
      return (h.read(c.log)?.length ?? 0) > 0;
    };
    const runs = {
      "diff-tree": ran([...L, "diff-tree", "-r", "-z", "--raw", "-M", "-l1000", hi.b.oids.root!, hi.b.oids.normal!]),
      "ls-files": ran([...L, "ls-files", "-z"]),
    };
    const quiet = {
      "diff trees": ran([...L, "diff", "--numstat", "-z", "--no-textconv", "--no-ext-diff", "--no-relative", "--no-renames", EMPTY_TREE.sha1, hi.b.oids.normal!, "--", "a.txt"]),
      "diff blobs": ran([...R, "diff", "-U0", "--inter-hunk-context=0", "--no-textconv", "--no-ext-diff", "--no-color", blobA, blobB]),
      "ls-tree": ran([...L, "ls-tree", "-z", "-l", "--full-tree", hi.b.oids.normal!, "--", "a.txt"]),
      "cat-file": ran([...R, "cat-file", "blob", blobB]),
      blame: ran([...L, "blame", "--incremental", "--no-textconv", "--encoding=none", hi.b.oids.normal!, "--", "a.txt"]),
      "check-ignore": ran(["--no-lazy-fetch", "check-ignore", "--no-index", "-z", "--stdin", "-v", "-n"], Buffer.from("a.txt\0")),
      config: ran([...R, "config", "get", "--all", "--type=path", "-z", "blame.ignoreRevsFile"]),
    };
    const holds = Object.values(runs).every(Boolean) && !Object.values(quiet).some(Boolean);
    observe(`F4 canary runs ${JSON.stringify(runs)} and stays absent ${JSON.stringify(quiet)}:`, holds);
    expect({ runs, quiet }).toEqual({ runs: { "diff-tree": true, "ls-files": true }, quiet: Object.fromEntries(Object.keys(quiet).map((k) => [k, false])) as typeof quiet });
  });

  factCase("F5: the ls-tree -z -l --full-tree record for a blob, a link, and a gitlink; a missing tree in a partial clone exits non-zero with --no-lazy-fetch", (w, h) => {
    const hi = historyIn(w, "t059-f5");
    const record = (path: string) => t(h, hi.repo, [...READ, "ls-tree", "-z", "-l", "--full-tree", hi.b.oids.normal!, "--", path]);
    // builtin/ls-tree.c `show_tree_long`: `"%06o %s %s %7s\t"`, so the padding follows the separator space.
    const form = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}) ( *)(-|0|[1-9][0-9]*)\t([^\0]+)\0$/;
    const width = (m: RegExpExecArray) => m[4]!.length === Math.max(0, 7 - m[5]!.length);
    const blob = form.exec(record("a.txt"));
    const link = form.exec(record("lnk"));
    const gitlink = form.exec(record("lib"));
    const size = (oid: string) => t(h, hi.repo, ["cat-file", "-s", oid]).trim();
    buildPartialClone(gitPath(), buildHistory(gitPath(), "t059-f5-source"), "t059-f5-partial", "tree:0");
    const partial = `${copyIn(w, fixturePath("t059-f5-partial"), "t059-f5-partial")}/repo`;
    const tip = t(h, partial, ["rev-parse", "HEAD"]).trim();
    const missing = h.run(partial, [...READ, "ls-tree", "-z", "-l", "--full-tree", tip, "--", "a.txt"]);
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
    observe(`F5 ls-tree blob, link, and gitlink records ${JSON.stringify([blob?.slice(1), link?.slice(1), gitlink?.slice(1)])} with a %7s size field, and a missing tree exit ${missing.exitCode}:`, holds);
    expect(holds).toBe(true);
  });

  factCase("F6: both blame grammars: previous, filename, boundary, the porcelain marks under the -c keys, no marks in incremental output, and the count of a last line without LF", (w, h) => {
    const bi = blameIn(w, "t059-f6");
    h.write(`${bi.repo}/.revs`, `${bi.b.oids.b7}\n`);
    const marks = ["-c", "blame.markIgnoredLines=true", "-c", "blame.markUnblamableLines=true"];
    const blame = (config: string[], form: "--incremental" | "--porcelain", commit: string, path: string) => t(h, bi.repo, [...READ, ...config, "blame", form, "--no-textconv", "--encoding=none", commit, "--", path]);
    const incremental = blame([...marks, "-c", "blame.ignoreRevsFile=.revs"], "--incremental", bi.b.oids.b7!, "tale.txt");
    const porcelain = blame([...marks, "-c", "blame.ignoreRevsFile=.revs"], "--porcelain", bi.b.oids.b7!, "tale.txt");
    const plain = blame(["-c", "blame.ignoreRevsFile=.revs"], "--porcelain", bi.b.oids.b7!, "tale.txt");
    const has = (out: string, key: string) => out.split("\n").some((l) => l === key || l.startsWith(`${key} `));
    const counted = blame([], "--incremental", bi.b.oids.b8!, "nolf.txt")
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
    observe("F6 incremental and porcelain headers, marks only in porcelain with the -c keys, and a last line without LF counted:", holds);
    expect(holds).toBe(true);
  });

  factCase("F7: a missing relative blame.ignoreRevsFile exits 128 in both toggle states; an empty value resets nothing; --ignore-revs-file= clears; ~/ and :(optional) through config get --all --type=path -z", (w, h) => {
    const bi = blameIn(w, "t059-f7");
    h.write(`${bi.repo}/.revs`, `${bi.b.oids.b7}\n`);
    const marks = ["-c", "blame.markIgnoredLines=true", "-c", "blame.markUnblamableLines=true"];
    const blame = (config: string[], extra: string[] = []) => h.run(bi.repo, [...READ, ...marks, ...config.flatMap((v) => ["-c", `blame.ignoreRevsFile=${v}`]), "blame", "--porcelain", "--no-textconv", "--encoding=none", ...extra, bi.b.oids.b7!, "--", "tale.txt"]);
    const marked = (r: { stdout: Buffer }) => r.stdout.toString().split("\n").filter((l) => l === "ignored" || l === "unblamable").length;
    const missing = blame(["missing.revs"]).exitCode;
    const missingOff = blame(["missing.revs"], ["--ignore-revs-file="]).exitCode;
    const missingIncremental = h.run(bi.repo, [...READ, "-c", "blame.ignoreRevsFile=missing.revs", "blame", "--incremental", "--no-textconv", "--encoding=none", "--ignore-revs-file=", bi.b.oids.b7!, "--", "tale.txt"]).exitCode;
    const one = marked(blame([".revs"]));
    const emptyAfter = marked(blame([".revs", ""]));
    const cleared = marked(blame([".revs"], ["--ignore-revs-file="]));
    // `distroGitHost` sets HOME to the owned home folder, so `~/` names it.
    const home = `${w.folder}/home`;
    h.write(`${home}/home.revs`, `${bi.b.oids.b7}\n`);
    for (const value of [".revs", "", "~/home.revs", ":(optional)absent.revs", ":(optional).revs"]) g(h, bi.repo, ["config", "--add", "blame.ignoreRevsFile", value]);
    const listedValues = t(h, bi.repo, ["--no-lazy-fetch", "--no-optional-locks", "config", "get", "--all", "--type=path", "-z", "blame.ignoreRevsFile"]);
    const none = h.run(blameIn(w, "t059-f7-none").repo, ["--no-lazy-fetch", "--no-optional-locks", "config", "get", "--all", "--type=path", "-z", "blame.ignoreRevsFile"]);
    const holds = missing === 128 && missingOff === 128 && missingIncremental === 128 && one > 0 && emptyAfter === one && cleared === 0 && listedValues === `.revs\0\0${home}/home.revs\0.revs\0` && none.exitCode === 1 && none.stdout.length === 0;
    observe(`F7 missing file exits ${missing}/${missingOff}/${missingIncremental}, an empty value keeps ${emptyAfter} of ${one} marks, --ignore-revs-file= leaves ${cleared}, config get lists ${JSON.stringify(listedValues)}:`, holds);
    expect(holds).toBe(true);
  });

  factCase("F8: the incremental attribution equals git blame --porcelain with -w, -M, and -C on every fixture line", (w, h) => {
    const bi = blameIn(w, "t059-f8");
    const results: string[] = [];
    let holds = true;
    for (const opts of [[], ["-w"], ["-M"], ["-C"], ["-w", "-M", "-C"]]) {
      for (const [commit, path] of [[bi.b.oids.b7!, "tale.txt"], [bi.b.oids.b7!, "other.txt"], [bi.b.oids.b8!, "nolf.txt"], [bi.b.oids.b2!, "story.txt"]] as const) {
        const inc = perLine(t(h, bi.repo, [...READ, "blame", "--incremental", "--no-textconv", "--encoding=none", ...opts, commit, "--", path]), "incremental");
        const por = perLine(t(h, bi.repo, [...READ, "blame", "--porcelain", "--no-textconv", "--encoding=none", ...opts, commit, "--", path]), "porcelain");
        const same = JSON.stringify(inc) === JSON.stringify(por) && inc.length > 0;
        holds &&= same;
        results.push(`${path}${opts.join("")}:${same}`);
      }
    }
    observe(`F8 incremental equals porcelain ${results.join(" ")}:`, holds);
    expect(holds).toBe(true);
  });

  factCase("F9: the diff -U0 --inter-hunk-context=0 hunk headers of two blobs, the FR-056 map on unchanged lines, also with diff.interHunkContext=3", (w, h) => {
    const bi = blameIn(w, "t059-f9");
    const repo = bi.repo;
    const oldText = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join("");
    const newText = oldText.replace("line 3\n", "line three\n").replace("line 6\n", "line six\nline six b\n").replace("line 9\n", "");
    const hash = (text: string) => t(h, repo, ["hash-object", "-w", "--stdin"], { input: Buffer.from(text) }).trim();
    const blob = (rev: string) => t(h, repo, ["rev-parse", rev]).trim();
    const pairs: [string, string][] = [
      [hash(oldText), hash(newText)],
      [blob(`${bi.b.oids.b2}:story.txt`), blob(`${bi.b.oids.b3}:tale.txt`)],
      [blob(`${bi.b.oids.b3}:tale.txt`), blob(`${bi.b.oids.b4}:tale.txt`)],
      [blob(`${bi.b.oids.b6}:tale.txt`), blob(`${bi.b.oids.b7}:tale.txt`)],
    ];
    const R = ["--no-lazy-fetch", "--no-optional-locks"];
    const diff = (a: string, z: string, config: string[] = [], flag = true) => g(h, repo, [...R, ...config, "diff", "-U0", ...(flag ? ["--inter-hunk-context=0"] : []), "--no-textconv", "--no-ext-diff", "--no-color", a, z]);
    const headers = (out: Buffer) => out.toString("utf8").split("\n").filter((l) => l.startsWith("@@ "));
    let holds = true;
    const notes: string[] = [];
    for (const [a, z] of pairs) {
      const plain = diff(a, z);
      const configured = diff(a, z, ["-c", "diff.interHunkContext=3"]);
      const hunks = parseHunks(new Uint8Array(plain));
      const oldLines = t(h, repo, ["cat-file", "blob", a]).split("\n").slice(0, -1);
      const newLines = t(h, repo, ["cat-file", "blob", z]).split("\n").slice(0, -1);
      const sameHeaders = JSON.stringify(headers(plain)) === JSON.stringify(headers(configured));
      let mapped = hunks !== null;
      if (hunks !== null) {
        for (let o = 1; o <= newLines.length; o++) {
          const inside = hunks.some((k) => k.newCount > 0 && k.newStart <= o && o < k.newStart + k.newCount);
          if (!inside && oldLines[(mapLine(o, hunks, oldLines.length) ?? 0) - 1] !== newLines[o - 1]) mapped = false;
        }
      }
      holds &&= sameHeaders && mapped;
      notes.push(`${headers(plain).length} hunks same=${sameHeaders} mapped=${mapped}`);
    }
    // Without the option, the configured context merges the two near hunks of the first pair.
    const merged = headers(diff(pairs[0]![0], pairs[0]![1], ["-c", "diff.interHunkContext=3"], false)).length < headers(diff(pairs[0]![0], pairs[0]![1])).length;
    holds &&= merged;
    observe(`F9 ${notes.join("; ")}; diff.interHunkContext=3 merges hunks without the option: ${merged}:`, holds);
    expect(holds).toBe(true);
  });

  factCase("F10: each folder without tracked entries is one record, a nested repository is nested/, the expansion lists every untracked file, and a nested repository expands to nested/", (w, h) => {
    const repo = reportIn(w, "t059-f10");
    const universe = listed(h, repo, U_ARGS);
    const expected = byBytes(["Upper.LOG", "build/out.o", "deep/", "ign/", "keep.log", "local", "nested/", "node_modules/", "secret.txt", "sub/deeper/", "sub/local", "sub/secret.txt", "sub/y.log", "swt/a.swt", "swt/b.txt", "untr/", "x.log"]);
    observe(`F10 ls-files -o --directory --no-empty-directory gives one record per folder without tracked entries, nested/ for a repository, and no emptyign/: ${JSON.stringify(universe)}`, JSON.stringify(universe) === JSON.stringify(expected));
    expect(universe).toEqual(expected);
    const plain = listed(h, repo, [...READ, "ls-files", "-o", "-z"]);
    for (const folder of ["untr/", "deep/", "ign/", "node_modules/", "sub/deeper/"]) {
      const expansion = listed(h, repo, [...READ, "ls-files", "-o", "-z", "--", folder]);
      const below = plain.filter((p) => p.startsWith(folder));
      observe(`F10 the expansion of ${folder} lists every untracked file below it`, JSON.stringify(expansion) === JSON.stringify(below));
      expect(expansion).toEqual(below);
    }
    const nested = listed(h, repo, [...READ, "ls-files", "-o", "-z", "--", "nested/"]);
    observe(`F10 a nested repository expands to the one record nested/: ${JSON.stringify(nested)}`, JSON.stringify(nested) === JSON.stringify(["nested/"]));
    expect(nested).toEqual(["nested/"]);
  });

  factCase("F10: with the text nested/, RI gives nested/; inside the excluded ign/, RI gives ign/ only; RI with a pathspec below an excluded folder exits 128", (w, h) => {
    const copy = copyOf(h, reportIn(w, "t059-f10-ri"), "t059-f10-ri-copy");
    h.write(`${copy}/.gitignore`, `${REPORT_ROOT_TEXT}nested/\n`);
    const inner = `${copy}/ign/inner-repo`;
    h.write(`${inner}/f.txt`, "");
    g(h, inner, ["init", "-q"]);
    g(h, inner, ["add", "f.txt"]);
    g(h, inner, ["commit", "-q", "-m", "inner"]);
    const ri = listed(h, copy, RI_ARGS);
    const nestedHolds = ri.includes("nested/") && ri.includes("ign/") && !ri.some((p) => p.startsWith("ign/") && p !== "ign/");
    observe(`F10 RI gives nested/ for an excluded repository whose parent is not excluded, and ign/ alone covers ign/inner-repo: ${JSON.stringify(ri)}`, nestedHolds);
    expect(nestedHolds).toBe(true);
    const below = h.run(copy, [...RI_ARGS, "--", "ign/inner-repo/"]).exitCode;
    observe(`F10 RI with the pathspec ign/inner-repo/ below the excluded ign/ exits ${below}`, below === 128);
    expect(below).toBe(128);
  });

  // A test-own shadow by the report method: every ignore file that the listings name, the edited text, and an empty folder for each gitlink and nested repository.
  function shadowVerdicts(w: WslHost, h: GitHost, repo: string, name: string, edited: string, candidate: string | null): { ignored: string[]; trackedMatched: string[] } {
    const shadow = `${h.root}/${name}-${++copies}/shadow`;
    sh(w, 'mkdir -p -- "$1"', [shadow]);
    const env = { GIT_DIR: `${shadow}/.git` };
    g(h, shadow, ["--no-lazy-fetch", "init", "-q", "--template="], { env });
    const all = records(g(h, repo, [...READ, "ls-files", "-o", "-z"]));
    const tracked = new Map<string, { mode: string; oid: string; tag: string }>();
    for (const rec of records(g(h, repo, [...READ, "ls-files", "-z", "--stage", "-v"]))) {
      const m = /^(\S) ([0-7]{6}) ([0-9a-f]+) ([0-3])\t(.*)$/s.exec(rec)!;
      if (!tracked.has(m[5]!)) tracked.set(m[5]!, { tag: m[1]!, mode: m[2]!, oid: m[3]! });
    }
    const entries: string[] = [];
    const hash = (input: Uint8Array) => t(h, shadow, ["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin"], { env, input }).trim();
    const gitignores = byBytes([...all, ...tracked.keys()].filter((p) => p === ".gitignore" || p.endsWith("/.gitignore")));
    const found = kinds(w, gitignores.map((p) => `${repo}/${p}`));
    for (const [i, path] of gitignores.entries()) {
      if (path === edited && candidate !== null) continue;
      const tr = tracked.get(path);
      if (found[i] === "a" && tr?.tag === "S") entries.push(`100644 ${hash(g(h, repo, ["cat-file", "blob", tr.oid]))}\t${path}`);
      else if (found[i] === "f") entries.push(`100644 ${hash(h.read(`${repo}/${path}`)!)}\t${path}`);
    }
    if (candidate !== null && edited !== ".git/info/exclude") entries.push(`100644 ${hash(Buffer.from(candidate))}\t${edited}`);
    const folderOid = hash(new Uint8Array());
    for (const [path, tr] of tracked) if (tr.mode === "160000") entries.push(`160000 ${tr.oid}\t${path}`);
    for (const path of all) if (path.endsWith("/")) entries.push(`160000 ${folderOid}\t${path.slice(0, -1)}`);
    const index = { ...env, GIT_INDEX_FILE: `${shadow}/.git/index` };
    g(h, shadow, ["--no-lazy-fetch", "update-index", "-z", "--index-info"], { env: index, input: Buffer.from(entries.map((e) => `${e}${NUL}`).join("")) });
    g(h, shadow, ["--no-lazy-fetch", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f"], { env: index });
    const exclude = edited === ".git/info/exclude" && candidate !== null ? Buffer.from(candidate) : h.read(`${repo}/.git/info/exclude`);
    if (exclude !== null) {
      const oid = hash(exclude);
      const excludeEnv = { ...env, GIT_INDEX_FILE: `${shadow}/.git/exclude.index` };
      g(h, shadow, ["--no-lazy-fetch", "update-index", "-z", "--index-info"], { env: excludeEnv, input: Buffer.from(`100644 ${oid}\texclude${NUL}`) });
      g(h, shadow, ["--no-lazy-fetch", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f", "--prefix=.git/info/"], { env: excludeEnv });
    }
    const ignoreCase = t(h, repo, ["config", "--type=bool", "core.ignorecase"], { allowExit: [0, 1] }).trim() || "false";
    const flags = ["-c", `core.ignorecase=${ignoreCase}`];
    const untracked = checkIgnore(h, shadow, all.map((p) => (p.endsWith("/") ? p.slice(0, -1) : p)), flags, env);
    const matched = checkIgnore(h, shadow, [...tracked.keys()], flags, env);
    return { ignored: byBytes(untracked.filter(ignoredBy).map((r) => (all.includes(`${r.path}/`) ? `${r.path}/` : r.path))), trackedMatched: byBytes(matched.filter(ignoredBy).map((r) => r.path)) };
  }

  // Git's own answer after a real save on a copy.
  function realSave(h: GitHost, repo: string, name: string, edited: string, candidate: string): { ignored: string[]; trackedMatched: string[] } {
    const copy = copyOf(h, repo, name);
    h.write(`${copy}/${edited}`, candidate);
    return { ignored: listed(h, copy, [...READ, ...IGNORED_ARGS]), trackedMatched: listed(h, copy, RT_ARGS) };
  }

  const CASES: [label: string, edited: string, candidate: string][] = [
    ["C0 unchanged root", ".gitignore", `${REPORT_ROOT_TEXT}emptyign/\nx\n`],
    ["C1 root: drop folders, add *.txt and !a.txt", ".gitignore", "*.log\n!keep.log\n**/tmp/**\n*.txt\n!a.txt\n"],
    ["C2 sub: anchored and negation", "sub/.gitignore", "*.log\n/local\n!secret.txt\nsecret.txt\n"],
    ["C3 info/exclude", ".git/info/exclude", "*.txt\n!untr/b.txt\nnode_modules/pkg/\n"],
    ["C4 case: *.LOG, DEEP/, nested/", ".gitignore", "*.LOG\nDEEP/\nnested/\n"],
    ["C5 ignored folder with a negation inside, ** forms", ".gitignore", "node_modules\n!node_modules/pkg/index.js\n**/sub/**/local\nuntr/**\n!untr/b.txt\n"],
    ["C6 sub: folder-only and leading **", "sub/.gitignore", "deeper/\n**/secret.txt\n"],
    ["C7 empty root", ".gitignore", ""],
    ["C8 CRLF, BOM, and trailing spaces", ".gitignore", "\u{feff}*.log\r\n!keep.log  \r\nign/\\ \r\n"],
    ["E1 gitlink against mod/", ".gitignore", "mod/\n"],
  ];

  factCase("F11: the S shadow equals RI and RT, and each C shadow equals Git's listings after a real save, for C0 to C8 and E1 with a gitlink and a skip-worktree .gitignore", (w, h) => {
    const repo = reportIn(w, "t059-f11");
    const saved = shadowVerdicts(w, h, repo, "t059-f11-s", ".gitignore", null);
    const real = { ignored: listed(h, repo, [...READ, ...IGNORED_ARGS]), trackedMatched: listed(h, repo, RT_ARGS) };
    observe(`F11 the S shadow equals Git's ignored and tracked-matched listings: ${JSON.stringify(saved)}`, JSON.stringify(saved) === JSON.stringify(real));
    expect(saved).toEqual(real);
    for (const [label, edited, candidate] of CASES) {
      const shadow = shadowVerdicts(w, h, repo, `t059-f11-${label.slice(0, 2)}`, edited, candidate);
      const truth = realSave(h, repo, `t059-f11-${label.slice(0, 2)}-copy`, edited, candidate);
      observe(`F11 ${label}: the C shadow equals the real save`, JSON.stringify(shadow) === JSON.stringify(truth));
      expect({ label, ...shadow }).toEqual({ label, ...truth });
    }
  });

  // The W1 additions of `buildReport` with `links`. A Windows link needs a privilege, so the distro makes the same entries on the copy.
  factCase("F11 W1: a folder link against folder patterns and a linked sub2/.gitignore", (w, h) => {
    const repo = copyOf(h, reportIn(w, "t059-f11-w1"), "t059-f11-w1-links");
    sh(w, 'cd -- "$1" && mkdir -p realdir sub2 && : > realdir/f && printf "*\\n" > ruleset && : > sub2/kept && ln -s realdir linkdir && ln -s ../ruleset sub2/.gitignore && : > "[br].txt" && : > "sp ace.txt"', [repo]);
    const candidate = `${REPORT_ROOT_TEXT}linkdir/\nrealdir/\n\\[br].txt\n`;
    const shadow = shadowVerdicts(w, h, repo, "t059-f11-w1-c", ".gitignore", candidate);
    const truth = realSave(h, repo, "t059-f11-w1-copy", ".gitignore", candidate);
    observe("F11 W1: the C shadow equals the real save", JSON.stringify(shadow) === JSON.stringify(truth));
    expect(shadow).toEqual(truth);
  });

  factCase("F12: below a folder record that check-ignore ignores as a folder, every untracked file is ignored too", (w, h) => {
    const repo = reportIn(w, "t059-f12");
    const folders = listed(h, repo, U_ARGS).filter((p) => p.endsWith("/"));
    const verdicts = checkIgnore(h, repo, folders.map((p) => p.slice(0, -1)));
    let checked = 0;
    for (const [i, folder] of folders.entries()) {
      if (!ignoredBy(verdicts[i]!)) continue;
      const files = listed(h, repo, [...READ, "ls-files", "-o", "-z", "--", folder]).filter((p) => !p.endsWith("/"));
      const holds = checkIgnore(h, repo, files).every(ignoredBy);
      observe(`F12 every file below the ignored folder ${folder} is ignored`, holds);
      expect({ folder, holds }).toEqual({ folder, holds: true });
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  factCase("F13: a stdin path that starts with : is literal in the ./ form, and Git echoes it unchanged", (w, h) => {
    const copy = copyOf(h, reportIn(w, "t059-f13"), "t059-f13-copy");
    h.write(`${copy}/.gitignore`, ":x.log\nsub/y.log\n");
    const [plain, dotted] = checkIgnore(h, copy, [":x.log", "./:x.log"]);
    const holds = dotted!.path === "./:x.log" && dotted!.pattern === ":x.log";
    observe(`F13 ./:x.log matches the pattern :x.log and Git echoes ./:x.log; the bare :x.log gives pattern ${JSON.stringify(plain!.pattern)}`, holds);
    expect(holds).toBe(true);
  });

  factCase("F14: hash-object --stdin-paths reads C-quoted lines; checkout-index writes equal bytes and an empty folder for a gitlink; info/exclude goes in through a second index", (w, h) => {
    const root = `${h.root}/t059-f14-${++copies}`;
    const real = `${root}/real dir é`;
    const crlf = Buffer.from("*.log\r\n!keep.log\r\n");
    h.write(`${real}/.gitignore`, crlf);
    const shadow = `${root}/shadow`;
    sh(w, 'mkdir -p -- "$1"', [shadow]);
    const env = { GIT_DIR: `${shadow}/.git` };
    g(h, shadow, ["--no-lazy-fetch", "init", "-q", "--template="], { env });
    const bare = t(h, shadow, ["config", "--get", "core.bare"], { env }).trim();
    observe(`F14 init with GIT_DIR <dir>/.git gives core.bare ${bare}`, bare === "false");
    expect(bare).toBe("false");
    const [info] = kinds(w, [`${shadow}/.git/info/exclude`]);
    observe("F14 init --template= creates no info/exclude", info === "a");
    expect(info).toBe("a");
    // Git's C quoting (quote.c `quote_c_style`): a backslash, a double quote, and each byte outside 0x20 to 0x7e as an octal escape.
    const quoted = `"${[...Buffer.from(`${real}/.gitignore`)].map((b) => (b === 0x5c ? "\\\\" : b === 0x22 ? '\\"' : b < 0x20 || b >= 0x7f ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b))).join("")}"`;
    const fromPaths = t(h, shadow, ["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin-paths"], { env, input: Buffer.from(`${quoted}\n`) }).trim();
    const fromStdin = t(h, shadow, ["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin"], { env, input: crlf }).trim();
    observe("F14 a C-quoted --stdin-paths line gives the OID of the bytes", fromPaths === fromStdin);
    expect(fromPaths).toBe(fromStdin);
    const index = { ...env, GIT_INDEX_FILE: `${shadow}/.git/index` };
    g(h, shadow, ["--no-lazy-fetch", "update-index", "-z", "--index-info"], { env: index, input: Buffer.from(`100644 ${fromPaths}\t.gitignore${NUL}160000 ${fromPaths}\tmod${NUL}`) });
    g(h, shadow, ["--no-lazy-fetch", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f"], { env: index });
    const same = Buffer.compare(h.read(`${shadow}/.gitignore`) ?? Buffer.alloc(0), crlf) === 0;
    const folder = kinds(w, [`${shadow}/mod`])[0] === "d";
    observe(`F14 checkout-index writes equal bytes (${same}) and an empty folder for a gitlink (${folder})`, same && folder);
    expect({ same, folder }).toEqual({ same: true, folder: true });
    expect(t(h, shadow, ["--no-lazy-fetch", "hash-object", "--no-filters", "--stdin-paths"], { env, input: Buffer.from(".gitignore\n") }).trim()).toBe(fromPaths);
    const exclude = { ...env, GIT_INDEX_FILE: `${shadow}/.git/exclude.index` };
    g(h, shadow, ["--no-lazy-fetch", "update-index", "-z", "--index-info"], { env: exclude, input: Buffer.from(`100644 ${fromPaths}\texclude${NUL}`) });
    g(h, shadow, ["--no-lazy-fetch", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f", "--prefix=.git/info/"], { env: exclude });
    const placed = Buffer.compare(h.read(`${shadow}/.git/info/exclude`) ?? Buffer.alloc(0), crlf) === 0;
    observe("F14 checkout-index --prefix=.git/info/ of the entry exclude writes .git/info/exclude with equal bytes", placed);
    expect(placed).toBe(true);
  });

  // Research.md R16 F15 is a Windows fact: Git for Windows `core.longpaths` and paths of 260 or more UTF-16 units. A distro has no such limit.
  console.log(`SKIP ${TASK} F15 long shadow paths: missing capability windows-path-rules (unverified)`);
  test.skip("F15: long shadow paths need Windows (SKIP: windows-path-rules)", () => {});

  factCase("F16: ls-files --stage gives one gitlink record; an uninitialized folder resolves to the parent; a .git file with a missing Git folder fails the discovery", (w, h) => {
    const s = buildSubmodules(gitPath(), "t059-f16");
    const sup = `${copyIn(w, s.root, "t059-f16")}/super`;
    prepare(h, [sup, `${sup}/solo`, `${sup}/mid`, `${sup}/mid/leaf`]);
    const stage = records(g(h, sup, [...READ, "ls-files", "-z", "--stage", "--", "solo"]));
    const one = stage.length === 1 && /^160000 [0-9a-f]{40} 0\tsolo$/.test(stage[0]!);
    observe(`F16 ls-files -z --stage -- solo gives one stage-0 gitlink record: ${JSON.stringify(stage)}`, one);
    expect(one).toBe(true);
    const top = (dir: string) => h.run(dir, ["--no-lazy-fetch", "rev-parse", "--show-toplevel"]);
    const bare = top(`${sup}/bare`);
    const resolves = bare.exitCode === 0 && bare.stdout.toString().trim() === sup;
    observe("F16 the uninitialized folder bare resolves to the superproject top level", resolves);
    expect(resolves).toBe(true);
    const broken = top(`${sup}/broken`);
    observe(`F16 rev-parse in broken, whose .git file names a missing folder, exits ${broken.exitCode}`, broken.exitCode === 128);
    expect(broken.exitCode).toBe(128);
    expect(top(`${sup}/solo`).stdout.toString().trim()).toBe(`${sup}/solo`);
  });

  factCase("F18: rev-parse --path-format=absolute --git-path info/exclude in a linked worktree names the common info/exclude", (w, h) => {
    const f = buildLinkedWorktree(gitPath(), "t059-f18");
    const dest = copyIn(w, f.root, "t059-f18");
    const from = `${slash(f.root)}/`;
    rewritePrefix(h, `${dest}/repo/.git/worktrees/linked/gitdir`, from, `${dest}/`);
    rewritePrefix(h, `${dest}/linked/.git`, from, `${dest}/`);
    prepare(h, [`${dest}/repo`, `${dest}/linked`]);
    const out = t(h, `${dest}/linked`, [...READ, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
    const common = t(h, `${dest}/repo`, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    const holds = out === `${common}/info/exclude\n`;
    observe(`F18 the linked worktree gives ${JSON.stringify(out)}`, holds);
    expect(holds).toBe(true);
  });

  factCase("F19: RI gives an excluded folder as one record, a folder of only ignored paths as d/ beside its records, the empty excluded folder, and the skip-worktree rules; RT gives the matched tracked files", (w, h) => {
    const copy = copyOf(h, reportIn(w, "t059-f19"), "t059-f19-copy");
    h.write(`${copy}/sub/.gitignore`, "!*.log\n/local\ndeeper/\n");
    const ri = listed(h, copy, RI_ARGS);
    const rt = listed(h, copy, RT_ARGS);
    observe(`F19 RI records ${JSON.stringify(ri)}; RT records ${JSON.stringify(rt)}`, true);
    const excluded = ["ign/", "node_modules/", "emptyign/", "sub/deeper/"].every((d) => ri.includes(d) && !ri.some((p) => p !== d && p.startsWith(d)));
    const onlyIgnored = ri.includes("deep/") && ri.includes("deep/tmp/z");
    const skipWorktree = ri.includes("swt/a.swt");
    observe("F19 an excluded folder is one record without records below it", excluded);
    observe("F19 a folder of only ignored paths gives deep/ beside deep/tmp/z", onlyIgnored);
    observe("F19 RI reads the skip-worktree swt/.gitignore from its index blob", skipWorktree);
    observe(`F19 RT holds build/keep.txt below the excluded /build/: ${rt.includes("build/keep.txt")}`, rt.includes("build/keep.txt"));
    expect({ excluded, onlyIgnored, skipWorktree, keep: rt.includes("build/keep.txt") }).toEqual({ excluded: true, onlyIgnored: true, skipWorktree: true, keep: true });
  });

  factCase("F19: in the distro, up/.GITIGNORE and dot/.gıtignore give no rules", (w, h) => {
    const f = buildCaseNames(gitPath(), "t059-f19-case");
    // Windows `tar.exe` (bsdtar 3.8.9) ends with an access violation on the name `.gıtignore` (U+0131), so that one file crosses as bytes.
    const odd = join(f.repo, "dot", ".gıtignore");
    const bytes = readFileSync(odd);
    unlinkSync(odd);
    const repo = `${copyIn(w, f.root, "t059-f19-case")}/repo`;
    h.write(`${repo}/dot/.gıtignore`, bytes);
    prepare(h, [repo]);
    const ignored = listed(h, repo, IGNORED_ARGS);
    const [up, dot] = checkIgnore(h, repo, ["up/a.txt", "dot/a.txt"]);
    const holds = up!.pattern === "" && dot!.pattern === "" && ignored.length === 0;
    observe(`F19 name case: up/a.txt pattern ${JSON.stringify(up!.pattern)}, dot/a.txt pattern ${JSON.stringify(dot!.pattern)}, ignored ${JSON.stringify(ignored)}`, holds);
    expect(holds).toBe(true);
  });

  factCase("F17: %(upstream) names a pruned upstream whose ref is missing, and is empty for a removed remote", (w, h) => {
    buildBranches(gitPath(), "t059-f17");
    const repo = `${copyIn(w, fixturePath("t059-f17"), "t059-f17")}/repo`;
    const rows = Object.fromEntries(
      t(h, repo, ["for-each-ref", "--format=%(refname)%00%(upstream)", "refs/heads"])
        .trim()
        .split("\n")
        .map((l) => l.split(NUL) as [string, string]),
    );
    const gone = rows["refs/heads/gone"];
    const holds = gone === "refs/remotes/origin/gone" && h.run(repo, ["show-ref", "--exists", gone]).exitCode === 2 && rows["refs/heads/noremote"] === "" && rows["refs/heads/plain"] === "" && rows["refs/heads/present"] === "refs/remotes/origin/present";
    observe(`F17 pruned upstream ${JSON.stringify(gone)} missing, removed remote ${JSON.stringify(rows["refs/heads/noremote"])}:`, holds);
    expect(holds).toBe(true);
  });
});

// ---- `wslFiles` modes `delete`, `replace`, and `scratch` (contract Δ11) ----

const WRAPPER = wslProcess.wrapper.join("\n");
// `src-tauri/src/wsl.rs` `PERL`, `DELETE_OUTPUT_BYTES`, and `SCRATCH_OUTPUT_BYTES` (`LINK_TARGET_BYTES` is 4,095).
const PERL = "/usr/bin/perl";
const DELETE_OUTPUT_BYTES = 64 * (64 + 64);
const SCRATCH_OUTPUT_BYTES = 64 * (4_095 + 64);
// The wrapper writes this byte to stdout inside a started scope (contract §11 "Process launch").
const STARTED = 0x53;
// Feature 005 contract Δ5 `IGNORE_TARGET_BYTES`, the `replace` bound of `wsl.rs` `replace_command`.
const IGNORE_TARGET_BYTES = 1_048_576;

let operations = 0;
// One operation ID per run. The scope of the run is `arbareto-<operation ID>-1.scope`.
function operationId(): string {
  const id = `0f0f0f0f-0000-4000-8009-${(process.pid * 0x1000 + ++operations).toString(16).padStart(12, "0")}`;
  OWN_SCOPE_OPERATIONS.add(id);
  return id;
}

interface FilesRun {
  operation: string;
  proc: ReturnType<typeof Bun.spawn>;
}
// `wsl.rs` `files_perl`: the Perl text in mode `probe` through the wrapper, the three Linux roots, the Git and SHA-256 programs, and the tokens on stdin.
// `sha` is the approved `sha256sum` path, or the test seam below.
function startFiles(w: WslHost, mode: "delete" | "replace" | "scratch", roots: readonly string[], tokens: readonly string[], sha = w.probe.paths.sha256sum!): FilesRun {
  const operation = operationId();
  const p = w.probe.paths;
  const argv = [WSL_EXE, "--distribution", w.distro, "--cd", "/", "--exec", "/bin/sh", "-c", WRAPPER, "sh", `arbareto-${operation}-1.scope`, "probe", "", p["systemd-run"]!, p.systemctl!, p.setsid!, w.probe.noexpand === "0" ? "1" : "", PERL, "-e", WSL_FILES_TEXT, "--", mode, ...roots, p.git!, sha];
  const proc = Bun.spawn(argv, { env: WSL_ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(Buffer.from(tokens.map((token) => `${token}${NUL}`).join("")));
  proc.stdin.end();
  return { operation, proc };
}

// The exit code and stdout, or the kill at the bound.
async function finish(run: FilesRun, ms = RUN_MS): Promise<{ exitCode: number | null; stdout: Uint8Array }> {
  const timer = setTimeout(() => run.proc.kill(), ms);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(run.proc.stdout as ReadableStream<Uint8Array>).bytes(), run.proc.exited]);
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
  }
}

// `wsl.rs` `started` and `Records`: exit 0, the start byte, then NUL-ended tokens within the cap. Null mirrors `None`.
function tokensOf(out: { exitCode: number | null; stdout: Uint8Array }, cap: number): string[] | null {
  if (out.exitCode !== 0 || out.stdout[0] !== STARTED) return null;
  const body = Buffer.from(out.stdout.subarray(1));
  if (body.length > cap || (body.length > 0 && body[body.length - 1] !== 0)) return null;
  return body.length === 0 ? [] : body.subarray(0, -1).toString("latin1").split(NUL);
}

// `wsl.rs` `delete_reply`: one result per entry, then one per folder; `error` carries its code. Anything else is `interrupted`.
function deleteReply(out: { exitCode: number | null; stdout: Uint8Array }, entries: number, folders: number): { entries: string[]; folders: string[] } | "interrupted" {
  const tokens = tokensOf(out, DELETE_OUTPUT_BYTES);
  if (tokens === null) return "interrupted";
  let at = 0;
  const next = (allowed: string[]): string | null => {
    const kind = tokens[at++];
    if (kind === "error") {
      const code = tokens[at++];
      return code === "access-denied" || code === "io-error" || code === "other-error" ? `error ${code}` : null;
    }
    return kind !== undefined && allowed.includes(kind) ? kind : null;
  };
  const e = Array.from({ length: entries }, () => next(["deleted", "stale", "absent", "not-regular"]));
  const f = Array.from({ length: folders }, () => next(["removed", "kept", "absent", "not-regular"]));
  return [...e, ...f].includes(null) || at !== tokens.length ? "interrupted" : { entries: e as string[], folders: f as string[] };
}

// `wsl.rs` `replace_reply`.
function replaceReply(out: { exitCode: number | null; stdout: Uint8Array }): string {
  const tokens = tokensOf(out, DELETE_OUTPUT_BYTES);
  if (tokens === null) return "interrupted";
  if (tokens.length === 1 && ["replaced", "stale", "refused"].includes(tokens[0]!)) return tokens[0]!;
  return tokens.length === 2 && tokens[0] === "error" ? `error ${tokens[1]}` : "interrupted";
}

// `wsl.rs` `scratch_reply`.
function scratchReply(out: { exitCode: number | null; stdout: Uint8Array }): string[] | "error" {
  const tokens = tokensOf(out, SCRATCH_OUTPUT_BYTES);
  return tokens === null ? "error" : tokens;
}

// The stdin form of one `delete` entry (`wsl.rs` `delete_command`). `lastWrite` is `st_mtime` in whole nanoseconds.
type Expected = { kind: "file"; size: string; lastWrite: string; digest: string | null } | { kind: "link"; target: string };
const entryTokens = (root: 0 | 1 | 2, path: string[], e: Expected) => [String(root), String(path.length), ...path, ...(e.kind === "file" ? ["file", e.size, e.lastWrite, e.digest ?? "-"] : ["link", e.target])];
const folderTokens = (root: 0 | 1 | 2, path: string[]) => [String(root), String(path.length), ...path];

// The review fact of a file in the distro: `stat` size and seconds, and its SHA-256.
function factOf(w: WslHost, path: string, digest = true): Expected {
  const lines = sh(w, 'stat -c "%s %Y" -- "$1" && sha256sum -- "$1"', [path]).stdout.split("\n");
  const [size, seconds] = lines[0]!.split(" ");
  return { kind: "file", size: size!, lastWrite: `${seconds}000000000`, digest: digest ? lines[1]!.slice(0, 64) : null };
}

// A test seam in place of `sha256sum`: the first call waits until the test creates `go`, then each call runs the real program.
// So the walk of the Perl text holds its working folder while the test swaps the folder on the path. The wait has a 60-second bound.
function seam(w: WslHost, h: GitHost, name: string): { path: string; held: string; go: string } {
  const dir = `${h.root}/seams/${name}`;
  const path = `${dir}/sha256sum-hold`;
  const held = `${dir}/held`;
  const go = `${dir}/go`;
  h.write(path, `#!/bin/sh\n: > '${held}'\ni=0\nwhile [ ! -e '${go}' ]; do\n  i=$((i + 1))\n  [ "$i" -gt 600 ] && exit 1\n  sleep 0.1\ndone\nexec '${w.probe.paths.sha256sum}' "$@"\n`);
  return { path, held, go };
}

async function waitHeld(w: WslHost, held: string): Promise<void> {
  for (const end = performance.now() + HELD_MS; kinds(w, [held])[0] !== "f"; await Bun.sleep(100)) {
    if (performance.now() >= end) throw new Error(`the seam did not hold within ${HELD_MS} ms`);
  }
}

// The files of `buildFiles` in the distro. The Windows-only names `x.` and `x ` stay out (plan.md D7 N9).
function filesIn(w: WslHost, name: string): { dest: string; repo: string } {
  const f = buildFiles(gitPath(), name);
  for (const odd of ["x.", "x "]) unlinkSync(`\\\\?\\${join(f.repo, odd)}`);
  const dest = copyIn(w, f.root, name);
  const repo = `${dest}/repo`;
  prepare(hostOf(w), [repo]);
  return { dest, repo };
}
const rootsOf = (repo: string) => [repo, `${repo}/.git`, `${repo}/.git`] as const;
const without = (digests: Record<string, string>, paths: string[]) => Object.fromEntries(Object.entries(digests).filter(([p]) => !paths.includes(p)));
const indexSha = (h: GitHost, repo: string) => sha256(h.read(`${repo}/.git/index`)!);

// Contract §11 "Process ownership": after a run, no scope and no process of its operation remains.
async function noneLeft(w: WslHost, operation: string, seamPath?: string): Promise<void> {
  await Bun.sleep(AFTER_CLOSE_MS);
  expect({ operation: pgrep(w, operation), seam: seamPath === undefined ? [] : pgrep(w, seamPath), scopes: listScopes(w) }).toEqual({ operation: [], seam: [], scopes: [] });
}

const W = (name: string, body: (w: WslHost) => Promise<void>) => {
  if (GIT === null) {
    console.log(`SKIP ${TASK} ${name}: Git executable absent`);
    test.skip(name, () => {});
    return;
  }
  wslTest(name, NEEDS, (w) => body(w), CASE_MS);
};

describe("T059 wslFiles delete, replace, and scratch through the wrapper (quickstart.md Q16, Q22, contract Δ11)", () => {
  W("delete: listed files, a link as a link, and folders deepest first go; a stale and an absent entry stay; every other byte and the index stay", async (w) => {
    const h = hostOf(w);
    const { dest, repo } = filesIn(w, "t059-delete");
    sh(w, 'ln -s ../outside/keep.txt "$1/lnk"', [repo]);
    const outside = h.digests(`${dest}/outside`);
    const before = h.digests(repo);
    const index = indexSha(h, repo);
    const stale = factOf(w, `${repo}/u3.txt`);
    // A file without a digest binds its size and `lastWrite` only (contract Δ5 "Delete digest").
    const sizeOnly = factOf(w, `${repo}/logs/2.log`, false);
    const entries: [string[], Expected][] = [
      [["u1.txt"], factOf(w, `${repo}/u1.txt`)],
      [["u2.txt"], factOf(w, `${repo}/u2.txt`, false)],
      [["logs", "1.log"], factOf(w, `${repo}/logs/1.log`)],
      [["a", "b", "c", "x.txt"], factOf(w, `${repo}/a/b/c/x.txt`)],
      [["lnk"], { kind: "link", target: "../outside/keep.txt" }],
      [["u3.txt"], stale.kind === "file" ? { ...stale, size: String(Number(stale.size) + 1) } : stale],
      [["logs", "2.log"], sizeOnly.kind === "file" ? { ...sizeOnly, size: String(Number(sizeOnly.size) + 1) } : sizeOnly],
      [["gone.txt"], { kind: "file", size: "1", lastWrite: "0", digest: null }],
      [["big.bin"], factOf(w, `${repo}/big.bin`, false)],
      [["ro.txt"], factOf(w, `${repo}/ro.txt`)],
    ];
    const folders = [["a", "b", "c"], ["a", "b"], ["a"]];
    const run = startFiles(w, "delete", rootsOf(repo), [String(entries.length), ...entries.flatMap(([p, e]) => entryTokens(0, p, e)), String(folders.length), ...folders.flatMap((p) => folderTokens(0, p))]);
    const reply = deleteReply(await finish(run), entries.length, folders.length);
    expect(reply).toEqual({ entries: ["deleted", "deleted", "deleted", "deleted", "deleted", "stale", "stale", "absent", "deleted", "deleted"], folders: ["removed", "removed", "removed"] });
    const gone = ["u1.txt", "u2.txt", "logs/1.log", "a/b/c/x.txt", "lnk", "big.bin", "ro.txt"];
    expect(kinds(w, gone.map((p) => `${repo}/${p}`))).toEqual(gone.map(() => "a"));
    expect(kinds(w, [`${repo}/a`, `${repo}/u3.txt`, `${repo}/logs/2.log`])).toEqual(["a", "f", "f"]);
    expect(h.digests(repo)).toEqual(without(before, gone));
    expect(h.digests(`${dest}/outside`)).toEqual(outside);
    expect(indexSha(h, repo)).toBe(index);
    await noneLeft(w, run.operation);
  });

  W("delete: a folder swapped for a link before the walk gives not-regular, and the link target stays", async (w) => {
    const h = hostOf(w);
    const { dest, repo } = filesIn(w, "t059-delete-swap-before");
    const fact = factOf(w, `${repo}/logs/2.log`);
    sh(w, 'mkdir -p "$2" && cp -a "$1/logs/." "$2/" && mv "$1/logs" "$1/logs.real" && ln -s "$2" "$1/logs"', [repo, `${dest}/outside-logs`]);
    const outside = h.digests(`${dest}/outside-logs`);
    const real = h.digests(`${repo}/logs.real`);
    const run = startFiles(w, "delete", rootsOf(repo), ["1", ...entryTokens(0, ["logs", "2.log"], fact), "1", ...folderTokens(0, ["logs"])]);
    expect(deleteReply(await finish(run), 1, 1)).toEqual({ entries: ["not-regular"], folders: ["not-regular"] });
    expect({ outside: h.digests(`${dest}/outside-logs`), real: h.digests(`${repo}/logs.real`), link: kinds(w, [`${repo}/logs`]) }).toEqual({ outside, real, link: ["l"] });
    await noneLeft(w, run.operation);
  });

  W("delete: a folder swapped for a link during the walk: the held folder loses only the reviewed file, the next entry gives not-regular, and the link target stays", async (w) => {
    const h = hostOf(w);
    const { dest, repo } = filesIn(w, "t059-delete-swap-during");
    const facts = [factOf(w, `${repo}/logs/3.log`), factOf(w, `${repo}/logs/4.log`)];
    sh(w, 'mkdir -p "$2" && cp -a "$1/logs/." "$2/"', [repo, `${dest}/outside-logs`]);
    const outside = h.digests(`${dest}/outside-logs`);
    const hold = seam(w, h, "delete-during");
    const run = startFiles(w, "delete", rootsOf(repo), ["2", ...entryTokens(0, ["logs", "3.log"], facts[0]!), ...entryTokens(0, ["logs", "4.log"], facts[1]!), "1", ...folderTokens(0, ["logs"])], hold.path);
    try {
      await waitHeld(w, hold.held);
      sh(w, 'mv "$1/logs" "$1/logs.held" && ln -s "$2" "$1/logs"', [repo, `${dest}/outside-logs`]);
    } finally {
      h.write(hold.go, "");
    }
    expect(deleteReply(await finish(run), 2, 1)).toEqual({ entries: ["deleted", "not-regular"], folders: ["not-regular"] });
    expect(kinds(w, [`${repo}/logs.held/3.log`, `${repo}/logs.held/4.log`, `${repo}/logs`])).toEqual(["a", "f", "l"]);
    expect(h.digests(`${dest}/outside-logs`)).toEqual(outside);
    await noneLeft(w, run.operation, hold.path);
  });

  W("delete: Cancel during the walk ends the scope and every process within 1 second, the reply is interrupted, and the file stays", async (w) => {
    const h = hostOf(w);
    const { repo } = filesIn(w, "t059-delete-cancel");
    const fact = factOf(w, `${repo}/u1.txt`);
    const hold = seam(w, h, "delete-cancel");
    const run = startFiles(w, "delete", rootsOf(repo), ["1", ...entryTokens(0, ["u1.txt"], fact), "0"], hold.path);
    try {
      await waitHeld(w, hold.held);
      // The shell ends the `wsl.exe` of a stopped walk with its Job (contract §11 "Process ownership").
      run.proc.kill();
      expect(deleteReply(await finish(run), 1, 0)).toBe("interrupted");
      await noneLeft(w, run.operation, hold.path);
    } finally {
      h.write(hold.go, "");
    }
    expect(kinds(w, [`${repo}/u1.txt`])).toEqual(["f"]);
  });

  W("replace: a present and an absent target get the new bytes in one rename with the old mode; a stale state and a link at the target change nothing; no temporary file stays", async (w) => {
    const h = hostOf(w);
    const { dest, repo } = filesIn(w, "t059-replace");
    const target = `${repo}/.git/info/exclude`;
    const data = Buffer.from("# saved by T059\n*.tmp\n");
    const hex = data.toString("hex");
    const stateOf = (path: string): string[] => {
      const bytes = h.read(path)!;
      return ["present", String(bytes.length), sha256(bytes)];
    };
    const tokens = (root: 0 | 1 | 2, path: string[], state: string[], bytes: string) => [String(IGNORE_TARGET_BYTES), String(root), String(path.length), ...path, ...state, bytes];
    const mode = () => sh(w, 'stat -c %a -- "$1"', [target]).stdout.trim();
    h.write(target, "# exclude\n");
    const oldMode = mode();
    let run = startFiles(w, "replace", rootsOf(repo), tokens(2, ["info", "exclude"], stateOf(target), hex));
    expect(replaceReply(await finish(run))).toBe("replaced");
    expect({ bytes: h.read(target)!.equals(data), mode: mode() }).toEqual({ bytes: true, mode: oldMode });
    await noneLeft(w, run.operation);
    // A stale state: another program changed the file after the review.
    const kept = h.read(target)!;
    run = startFiles(w, "replace", rootsOf(repo), tokens(2, ["info", "exclude"], ["present", String(kept.length), "0".repeat(64)], Buffer.from("other\n").toString("hex")));
    expect(replaceReply(await finish(run))).toBe("stale");
    expect(h.read(target)!.equals(kept)).toBe(true);
    // An absent target: the new file gets its bytes through `link` of the complete temporary file.
    sh(w, 'rm -- "$1/.gitignore"', [repo]);
    run = startFiles(w, "replace", rootsOf(repo), tokens(0, [".gitignore"], ["absent"], hex));
    expect(replaceReply(await finish(run))).toBe("replaced");
    expect(h.read(`${repo}/.gitignore`)!.equals(data)).toBe(true);
    // A link at the target refuses (contract Δ11 `replace`), and the link target stays.
    const keep = h.read(`${dest}/outside/keep.txt`)!;
    sh(w, 'rm -- "$1/.gitignore" && ln -s ../outside/keep.txt "$1/.gitignore"', [repo]);
    run = startFiles(w, "replace", rootsOf(repo), tokens(0, [".gitignore"], ["present", String(keep.length), sha256(keep)], hex));
    expect(replaceReply(await finish(run))).toBe("refused");
    expect({ link: kinds(w, [`${repo}/.gitignore`]), target: h.read(`${dest}/outside/keep.txt`)!.equals(keep) }).toEqual({ link: ["l"], target: true });
    const leftovers = sh(w, 'find "$1" "$1/.git/info" -maxdepth 1 -name ".arbareto-*-replace.tmp" -print', [repo]).stdout;
    expect(leftovers).toBe("");
    await noneLeft(w, run.operation);
  });

  W("replace: a folder on the path swapped for a link before the walk refuses; swapped during the walk, the held folder gets the bytes, and the link target stays", async (w) => {
    const h = hostOf(w);
    const { dest, repo } = filesIn(w, "t059-replace-swap");
    const info = `${repo}/.git/info`;
    const outside = `${dest}/outside-info`;
    sh(w, 'mkdir -p "$2" && cp -a "$1/." "$2/"', [info, outside]);
    const outsideBefore = h.digests(outside);
    const data = Buffer.from("# swapped\n");
    const state = (bytes: Buffer) => ["present", String(bytes.length), sha256(bytes)];
    const tokens = (s: string[]) => [String(IGNORE_TARGET_BYTES), "2", "2", "info", "exclude", ...s, data.toString("hex")];
    // Before the walk: `info` is a link.
    sh(w, 'mv "$1" "$1.real" && ln -s "$2" "$1"', [info, outside]);
    let run = startFiles(w, "replace", rootsOf(repo), tokens(state(h.read(`${info}.real/exclude`)!)));
    expect(replaceReply(await finish(run))).toBe("refused");
    expect(h.digests(outside)).toEqual(outsideBefore);
    await noneLeft(w, run.operation);
    sh(w, 'rm -- "$1" && mv "$1.real" "$1"', [info]);
    // During the walk: the seam holds after the walk entered `info`.
    const hold = seam(w, h, "replace-during");
    run = startFiles(w, "replace", rootsOf(repo), tokens(state(h.read(`${info}/exclude`)!)), hold.path);
    try {
      await waitHeld(w, hold.held);
      sh(w, 'mv "$1" "$1.held" && ln -s "$2" "$1"', [info, outside]);
    } finally {
      h.write(hold.go, "");
    }
    expect(replaceReply(await finish(run))).toBe("replaced");
    expect({ held: h.read(`${info}.held/exclude`)!.equals(data), outside: h.digests(outside), link: kinds(w, [info]) }).toEqual({ held: true, outside: outsideBefore, link: ["l"] });
    await noneLeft(w, run.operation, hold.path);
  });

  W("scratch: create makes the shadow folder with s and c at mode 0700; sweep lists a folder that no remove followed; remove deletes it without following a link; other names refuse", async (w) => {
    const h = hostOf(w);
    // A name that `src-tauri/src/shadow.rs` `parse_name` refuses, so a shell sweep keeps it for this test.
    const name = `arbareto-preview-t059-${process.pid}-${crypto.randomUUID()}`;
    const linkName = `arbareto-preview-t059-link-${process.pid}-${crypto.randomUUID()}`;
    const outside = `${h.root}/scratch-outside`;
    h.write(`${outside}/keep.txt`, "keep\n");
    const kept = h.digests(outside);
    const scratch = async (tokens: string[]) => {
      const run = startFiles(w, "scratch", ["/", "/", "/"], tokens);
      const reply = scratchReply(await finish(run));
      await noneLeft(w, run.operation);
      return reply;
    };
    try {
      expect(await scratch(["create", name])).toEqual(["created"]);
      const uid = sh(w, "id -u").stdout.trim();
      expect(sh(w, 'stat -c "%a %u %F" -- "$1" "$1/s" "$1/c"', [`/tmp/${name}`]).stdout.trim().split("\n")).toEqual(["700 directory", "700 directory", "700 directory"].map((s) => s.replace(" ", ` ${uid} `)));
      // A shadow run of a killed service leaves the folder with its files. The next create sweeps it (plan.md D14).
      sh(w, 'git_dir="$1/s/.git" && mkdir -p "$git_dir" && : > "$git_dir/index" && : > "$1/c/f" && ln -s "$2" "$1/s/out"', [`/tmp/${name}`, outside]);
      const swept = await scratch(["sweep"]);
      expect(swept === "error" ? swept : { first: swept[0], listed: swept.includes(name) }).toEqual({ first: "swept", listed: true });
      expect(await scratch(["remove", name])).toEqual(["removed"]);
      expect(kinds(w, [`/tmp/${name}`])).toEqual(["a"]);
      expect(h.digests(outside)).toEqual(kept);
      // A name below the prefix that is a link: remove refuses, and the link target stays.
      sh(w, 'ln -s "$1" "/tmp/$2"', [outside, linkName]);
      expect(await scratch(["remove", linkName])).toEqual(["error", "other-error"]);
      expect(h.digests(outside)).toEqual(kept);
      // A name without the prefix refuses for create and remove.
      expect(await scratch(["create", `t059-${process.pid}`])).toEqual(["error", "other-error"]);
      expect(await scratch(["remove", `t059-${process.pid}`])).toEqual(["error", "other-error"]);
      expect(kinds(w, [`/tmp/t059-${process.pid}`])).toEqual(["a"]);
    } finally {
      sh(w, 'rm -f -- "/tmp/$2"; [ -L "/tmp/$1" ] || rm -rf --one-file-system -- "/tmp/$1"', [name, linkName]);
    }
  });
});

// ---- Service rows through the shell test double and the distro Git ----

async function withWsl(w: WslHost, name: string, body: (s: Service) => Promise<void>): Promise<void> {
  const s = await openService({ git: gitPath(), name, environment: serviceEnv(), wslGlobalConfig: globalConfig(w) });
  try {
    await body(s);
  } finally {
    await s.dispose();
  }
  // Contract §11 "Process ownership": no scope of this process remains after the close.
  await Bun.sleep(AFTER_CLOSE_MS);
  expect(listScopes(w)).toEqual([]);
}
const request = <R>(s: Service, operation: string, payload: object, envelope: Envelope) => s.response<R>(s.send(operation, payload, envelope), RESPONSE_MS);
const b64 = (bytes: string | Uint8Array) => Buffer.from(bytes).toString("base64");
const refusal = (r: ServiceResponse<unknown>) => ({ state: r.state, code: r.code, result: r.result });
const unavailable = (reason: string) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason } });
// The UNC paths of the shell and the harness name the same Linux path after the `\\<server>\<distro>` prefix.
const linuxOf = (unc: string) => `/${unc.replaceAll("\\", "/").split("/").slice(4).join("/")}`;

interface Viewed {
  repositoryId: string;
  repositoryGeneration: number;
  viewId: string;
}
async function viewOf(s: Service, w: WslHost, repo: string): Promise<Viewed> {
  const r = await s.register(uncPath(w, repo));
  const opened = await request<{ viewId: string }>(s, "openHistory", { scope: "all" }, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
  expect(opened.state).toBe("succeeded");
  const loaded = await request<{ complete: boolean }>(s, "loadHistory", { viewId: opened.result!.viewId, need: { end: true } }, { repositoryId: r.repositoryId });
  expect({ state: loaded.state, complete: loaded.result?.complete }).toEqual({ state: "succeeded", complete: true });
  return { repositoryId: r.repositoryId, repositoryGeneration: r.generation, viewId: opened.result!.viewId };
}

const STATUS: Record<string, string> = { A: "added", D: "deleted", M: "modified", R: "renamed", T: "type-changed" };
// diff-format(5) raw `-z` records of the distro Git's own listing, as data-model §1 entries.
function listingOracle(h: GitHost, repo: string, base: string, oid: string) {
  return diffTree(h, repo, base, oid).map((r) => {
    const kind = r.modes.includes("160000") ? "submodule" : r.modes.includes("120000") ? "link" : "file";
    const two = r.status.startsWith("R");
    return { status: STATUS[r.status[0]!]!, ...(two ? { score: Number(r.status.slice(1)) } : {}), pathBytes: b64(Buffer.from(r.paths.at(-1)!, "latin1")), ...(two ? { oldPathBytes: b64(Buffer.from(r.paths[0]!, "latin1")) } : {}), kind };
  });
}

describe("T059 service rows through the shell test double and the distro Git (quickstart.md Q33)", () => {
  W("Q4 FR-006, FR-008: readCommitChanges and readCommitFile of a WSL repository equal the distro Git's diff-tree listing and patch on a copy", async (w) => {
    const h = hostOf(w);
    const hi = historyIn(w, "t059-q4");
    const copy = copyOf(h, hi.repo, "t059-q4-copy");
    const patchArgs = [...READ, "diff-tree", "-p", "--no-textconv", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=dirty", "-M", "-l1000"];
    await withWsl(w, "t059-q4", async (s) => {
      const v = await viewOf(s, w, hi.repo);
      expect((await readOk(s, v.repositoryId)).location.kind).toBe("wsl");
      const envelope = { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration };
      let patches = 0;
      for (const label of HISTORY_LABELS) {
        const oid = hi.b.oids[label]!;
        const base = firstParent(h, { b: hi.b, repo: copy }, label);
        const changes = await request<{ changesId: string; files: { fileId: number; status: string; pathBytes: string; oldPathBytes?: string; kind: string }[] }>(s, "readCommitChanges", { viewId: v.viewId, oid, parent: 0 }, envelope);
        expect({ label, state: changes.state, files: changes.result!.files.map(({ fileId: _id, ...rest }) => rest) }).toEqual({ label, state: "succeeded", files: listingOracle(h, copy, base, oid) });
        if (!["normal", "rename"].includes(label)) continue;
        for (const entry of changes.result!.files.filter((f) => f.kind === "file" && f.status !== "type-changed")) {
          // The fixture paths are valid UTF-8, so each pathspec argument carries the same bytes.
          const path = Buffer.from(entry.pathBytes, "base64").toString("utf8");
          const old = entry.oldPathBytes === undefined ? [] : [Buffer.from(entry.oldPathBytes, "base64").toString("utf8")];
          const file = await request<{ binary: boolean; patch: string | null }>(s, "readCommitFile", { changesId: changes.result!.changesId, fileId: entry.fileId }, envelope);
          const own = g(h, copy, [...patchArgs, base, oid, "--", path, ...old]);
          expect({ label, path, state: file.state, patch: file.result!.patch === null ? null : Buffer.from(file.result!.patch, "base64").toString("latin1") }).toEqual({ label, path, state: "succeeded", patch: own.toString("latin1") });
          patches++;
        }
      }
      expect(patches).toBeGreaterThan(0);
    });
  });

  W("Q27 FR-053 to FR-058: each blame attribution of a WSL repository equals the distro Git's blame --porcelain with the same options, with the ignore list on and off", async (w) => {
    const h = hostOf(w);
    const bi = blameIn(w, "t059-q27");
    h.write(`${bi.repo}/.revs`, `${bi.b.oids.b7}\n`);
    g(h, bi.repo, ["config", "blame.ignoreRevsFile", ".revs"]);
    const copy = copyOf(h, bi.repo, "t059-q27-copy");
    type Options = { ignoreWhitespace: boolean; detectMoves: boolean; detectCopies: boolean; ignoreList: boolean };
    const base: Options = { ignoreWhitespace: false, detectMoves: false, detectCopies: false, ignoreList: true };
    const flags = (o: Options) => [...(o.ignoreWhitespace ? ["-w"] : []), ...(o.detectMoves ? ["-M"] : []), ...(o.detectCopies ? ["-C"] : [])];
    // One line of `git blame --porcelain`: the commit, the original line, and the marks.
    const oracle = (o: Options) => {
      const config = o.ignoreList ? ["-c", "blame.markIgnoredLines=true", "-c", "blame.markUnblamableLines=true"] : [];
      const out = t(h, copy, [...READ, ...config, "blame", "--porcelain", "--no-textconv", "--encoding=none", ...flags(o), ...(o.ignoreList ? [] : ["--ignore-revs-file="]), bi.b.oids.b7!, "--", "tale.txt"]);
      const lines: { oid: string; orig: number; ignored: boolean; unblamable: boolean }[] = [];
      let current: (typeof lines)[number] | null = null;
      for (const line of out.split("\n")) {
        const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
        if (header !== null) current = { oid: header[1]!, orig: Number(header[2]), ignored: false, unblamable: false };
        else if (line === "ignored") current!.ignored = true;
        else if (line === "unblamable") current!.unblamable = true;
        else if (line.startsWith("\t")) lines.push({ ...current! });
      }
      return lines;
    };
    await withWsl(w, "t059-q27", async (s) => {
      const v = await viewOf(s, w, bi.repo);
      const envelope = { repositoryId: v.repositoryId, repositoryGeneration: v.repositoryGeneration };
      const changes = await request<{ changesId: string; files: { fileId: number; pathBytes: string }[] }>(s, "readCommitChanges", { viewId: v.viewId, oid: bi.b.oids.b7, parent: 0 }, envelope);
      const fileId = changes.result!.files.find((f) => f.pathBytes === b64("tale.txt"))!.fileId;
      const variants: Options[] = [base, { ...base, ignoreWhitespace: true }, { ...base, detectMoves: true }, { ...base, detectCopies: true }, { ...base, ignoreList: false }];
      for (const o of variants) {
        type Blame = { ignoreList: string; groups: { commit: number; origStart: number; count: number; ignored: boolean; unblamable: boolean }[]; commits: { oid: string }[] };
        const blame = await request<Blame>(s, "readBlame", { source: { changesId: changes.result!.changesId, fileId }, options: o }, envelope);
        expect({ o, state: blame.state, code: blame.code }).toEqual({ o, state: "succeeded", code: undefined });
        const lines = blame.result!.groups.flatMap((gr) => Array.from({ length: gr.count }, (_, i) => ({ oid: blame.result!.commits[gr.commit]!.oid, orig: gr.origStart + i, ignored: gr.ignored, unblamable: gr.unblamable })));
        expect({ o, ignoreList: blame.result!.ignoreList, lines }).toEqual({ o, ignoreList: o.ignoreList ? "on" : "off", lines: oracle(o) });
      }
    });
  });

  W("Q12 to Q16 FR-029: Delete in a WSL repository reviews a permanent delete with the WSL line; the Recycle Bin refuses with no-recycle-bin; submodule and nested-repository rows refuse", async (w) => {
    const { repo } = filesIn(w, "t059-q12");
    await withWsl(w, "t059-q12", async (s) => {
      const r = await s.register(uncPath(w, repo));
      const read = await readOk(s, r.repositoryId);
      expect(read.location.kind).toBe("wsl");
      const id = (path: string) => read.entries.find((e) => e.path === path && e.category !== "staged")!.entryId;
      const envelope = { repositoryId: r.repositoryId, repositoryGeneration: read.generation };
      type Review = { action: string; plan: { mode: string; entryIds: string[]; files: { count: number; paths: string[] }; tracked: number; folder: string | null; wsl: boolean } };
      const review = (entryIds: string[], mode: "recycle" | "permanent", folder?: string) => request<Review>(s, "reviewWorkbench", { action: "delete", snapshotId: read.snapshotId, entryIds, mode, ...(folder === undefined ? {} : { folder: b64(folder) }) }, envelope);
      expect(refusal(await review([id("u1.txt")], "recycle"))).toEqual(unavailable("no-recycle-bin"));
      // Data-model §4: the plan names the entries and the first paths in tree order.
      const plain = await review([id("u3.txt"), id("u1.txt"), id("u2.txt")], "permanent");
      expect({ ...outcome(plain), plan: plain.result?.plan }).toEqual({ ...SUCCEEDED, plan: { mode: "permanent", entryIds: [id("u1.txt"), id("u2.txt"), id("u3.txt")], files: { count: 3, paths: ["u1.txt", "u2.txt", "u3.txt"].map((p) => b64(p)) }, tracked: 0, folder: null, wsl: true } });
      const logs = ["logs/1.log", "logs/2.log", "logs/3.log", "logs/4.log"];
      const folder = await review(logs.map(id), "permanent", "logs");
      expect({ ...outcome(folder), folder: folder.result?.plan.folder, count: folder.result?.plan.files.count, wsl: folder.result?.plan.wsl }).toEqual({ ...SUCCEEDED, folder: b64("logs"), count: 4, wsl: true });
      expect(refusal(await review([id("mod")], "permanent"))).toEqual(unavailable("submodule"));
      expect(refusal(await review([id("nested/")], "permanent"))).toEqual(unavailable("nested-repository"));
    });
    const conflicted = buildConflicted(gitPath(), "t059-q15-merging", "merging");
    const crepo = `${copyIn(w, conflicted.root, "t059-q15-merging")}/repo`;
    prepare(hostOf(w), [crepo]);
    await withWsl(w, "t059-q15", async (s) => {
      const r = await s.register(uncPath(w, crepo));
      const read = await readOk(s, r.repositoryId);
      const free = read.entries.find((e) => e.path === "free.txt")!.entryId;
      const response = await request(s, "reviewWorkbench", { action: "delete", snapshotId: read.snapshotId, entryIds: [free], mode: "permanent" }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
      expect(outcome(response)).toEqual({ state: "failed", code: "OPERATION_IN_PROGRESS" });
    });
  });

  W("Q23 and Q25 FR-043: the ignore editor reads .gitignore and info/exclude through the distro, with no \\\\wsl.localhost call besides the seven operation-marker stat calls, and the Save review binds the read state", async (w) => {
    const h = hostOf(w);
    const f = buildIgnoreForm(gitPath(), "t059-q25", "crlf");
    const repo = `${copyIn(w, f.root, "t059-q25")}/repo`;
    prepare(h, [repo]);
    // 001 contract §11 "Paths and file access" keeps the seven operation-marker `stat` calls through UNC (`commands.ts` `OPERATION_MARKERS`).
    // Every other `\\wsl.localhost` call fails FR-043.
    const markers = OPERATION_MARKERS.map((m) => `${uncPath(w, `${repo}/.git`)}\\${m.replaceAll("/", "\\")}`.toLowerCase());
    const crossing = (calls: FsCall[]) => calls.filter((c) => /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]/i.test(c.path) && !(c.name === "stat" && markers.includes(c.path.toLowerCase())));
    await withWsl(w, "t059-q25", async (s) => {
      const r = await s.register(uncPath(w, repo));
      const envelope = { repositoryId: r.repositoryId, repositoryGeneration: r.generation };
      type IgnoreFile = { target: string; file: string; state: string; text: string; lineEnding: string; bom: boolean; expected: "absent" | { size: number; sha256: string } };
      const { value: reads, calls } = await withFsCalls(async () => [await request<IgnoreFile>(s, "readIgnoreFile", { target: "gitignore" }, envelope), await request<IgnoreFile>(s, "readIgnoreFile", { target: "exclude" }, envelope)]);
      expect(crossing(calls)).toEqual([]);
      const gitignore = h.read(`${repo}/.gitignore`)!;
      const exclude = h.read(`${repo}/.git/info/exclude`)!;
      // Data-model §6 `file`: `<worktree root>/.gitignore`, or the distro Git's `rev-parse --path-format=absolute --git-path info/exclude` result.
      expect({ state: reads[0]!.state, result: reads[0]!.result }).toEqual({
        state: "succeeded",
        result: { target: "gitignore", file: `${r.worktreeRoot}/.gitignore`, state: "file", text: "*.log\n/out/\n", lineEnding: "crlf", bom: false, expected: { size: gitignore.length, sha256: sha256(gitignore) } },
      });
      const excludePath = t(h, repo, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).trimEnd();
      expect({ state: reads[1]!.state, file: reads[1]!.result!.file, expected: reads[1]!.result!.expected }).toEqual({ state: "succeeded", file: excludePath, expected: { size: exclude.length, sha256: sha256(exclude) } });
      const text = "*.log\n/out/\n!keep.log\n";
      const saved = Buffer.from(text.replaceAll("\n", "\r\n"));
      const { value: review, calls: reviewCalls } = await withFsCalls(() => request<{ plan: { target: string; size: number; sha256: string } }>(s, "reviewWorkbench", { action: "ignore-save", target: "gitignore", text: b64(text), expected: reads[0]!.result!.expected }, envelope));
      expect(crossing(reviewCalls)).toEqual([]);
      expect({ ...outcome(review), plan: review.result && { target: review.result.plan.target, size: review.result.plan.size, sha256: review.result.plan.sha256 } }).toEqual({ ...SUCCEEDED, plan: { target: "gitignore", size: saved.length, sha256: sha256(saved) } });
      const stale = await request(s, "reviewWorkbench", { action: "ignore-save", target: "gitignore", text: b64(text), expected: { size: gitignore.length, sha256: "0".repeat(64) } }, envelope);
      expect(refusal(stale)).toEqual({ state: "failed", code: "STALE_REVIEW", result: { reason: "ignore-changed" } });
      expect(h.read(`${repo}/.gitignore`)!.equals(gitignore)).toBe(true);
    });
  });

  W("Q26 FR-047 to FR-052: Open submodule through the §11 route registers the distro submodule; uninitialized, broken, linked, and plain paths refuse with their reasons", async (w) => {
    const h = hostOf(w);
    const sub = buildSubmodules(gitPath(), "t059-q26");
    const sup = `${copyIn(w, sub.root, "t059-q26")}/super`;
    prepare(h, [sup, `${sup}/solo`, `${sup}/mid`, `${sup}/mid/leaf`]);
    const head = t(h, sup, ["rev-parse", "HEAD"]).trim();
    g(h, sup, ["update-index", "--add", "--cacheinfo", `160000,${head},lnk`]);
    sh(w, 'ln -s solo "$1/lnk"', [sup]);
    await withWsl(w, "t059-q26", async (s) => {
      // Contract Δ3 `openSubmodule`: the shell joins the path to the UNC root by the §11 route and binds a `repositoryDiscovery` context.
      const open = (from: RegistrationResult, root: string, path: string) =>
        request<RegistrationResult & { reason?: string }>(s, "openSubmodule", { repositoryId: from.repositoryId, bootstrapId: s.runner.addContext("repositoryDiscovery", uncPath(w, `${root}/${path}`)), path }, {});
      // A registration releases the parent (T035), so each open starts from a fresh parent registration.
      const opened = await open(await s.register(uncPath(w, sup)), sup, "solo");
      expect({ ...outcome(opened), root: opened.result && linuxOf(opened.result.worktreeRoot) }).toEqual({ ...SUCCEEDED, root: `${sup}/solo` });
      expect((await readOk(s, opened.result!.repositoryId)).location.kind).toBe("wsl");
      // A nested submodule opens level by level: `mid` from the parent, then `leaf` from `mid`.
      const mid = await open(await s.register(uncPath(w, sup)), sup, "mid");
      expect({ ...outcome(mid), root: mid.result && linuxOf(mid.result.worktreeRoot) }).toEqual({ ...SUCCEEDED, root: `${sup}/mid` });
      const leaf = await open(mid.result!, `${sup}/mid`, "leaf");
      expect({ ...outcome(leaf), root: leaf.result && linuxOf(leaf.result.worktreeRoot) }).toEqual({ ...SUCCEEDED, root: `${sup}/mid/leaf` });
      const parent = await s.register(uncPath(w, sup));
      for (const [path, reason] of [["bare", "submodule-not-initialized"], ["broken", "submodule-not-initialized"], ["lnk", "path"], ["super.txt", "not-submodule"]] as const) {
        expect({ path, ...refusal(await open(parent, sup, path)) }).toEqual({ path, state: "failed", code: "SUBMODULE_UNAVAILABLE", result: { reason } });
      }
      // The parent stays registered after each refusal.
      expect(outcome(await s.readWorkspace(parent.repositoryId))).toEqual(SUCCEEDED);
    });
  });

  // T106 to T108: contract Δ3 `readSubmoduleChange` and `readSubmoduleWork` through the distro wrapper (spec FR-076, SC-012).
  W("FR-071, FR-074, FR-076: readSubmoduleChange equals the distro Git's rev-list and log inside the submodule; readSubmoduleWork equals the distro parent status with none on a copy", async (w) => {
    const h = hostOf(w);
    const sub = buildSubmodules(gitPath(), "t106-wsl");
    const sup = `${copyIn(w, sub.root, "t106-wsl")}/super`;
    prepare(h, [sup, `${sup}/solo`, `${sup}/mid`, `${sup}/mid/leaf`]);
    const old = t(h, `${sup}/solo`, ["rev-parse", "HEAD"]).trim();
    sh(w, 'printf "a\\n" > "$1/solo/wsl-a.txt" && printf "u\\n" > "$1/mid/wsl-u.txt"', [sup]);
    g(h, `${sup}/solo`, ["add", "--", "wsl-a.txt"]);
    g(h, `${sup}/solo`, ["commit", "-q", "--no-verify", "-m", "wsl one"]);
    const next = t(h, `${sup}/solo`, ["rev-parse", "HEAD"]).trim();
    const [removed, added] = t(h, `${sup}/solo`, ["rev-list", "--left-right", "--count", `${old}...${next}`]).trim().split("\t").map(Number);
    const subject = t(h, `${sup}/solo`, ["log", "-z", "--format=%H%x00%s", "--max-count=50", next, `^${old}`]).split(NUL);
    sh(w, 'cp -a "$1" "$1-oracle"', [sup]);
    const oracle: Record<string, { modified: boolean; untracked: boolean }> = {};
    for (const record of t(h, `${sup}-oracle`, ["status", "--porcelain=v2", "-z", "--ignore-submodules=none", "--", "solo", "mid"]).split(NUL)) {
      const m = /^1 \S\S S[C.]([M.])([U.]) \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record);
      if (m) oracle[m[3]!] = { modified: m[1] === "M", untracked: m[2] === "U" };
    }
    await withWsl(w, "t106-wsl", async (s) => {
      const r = await s.register(uncPath(w, sup));
      const read = await readOk(s, r.repositoryId);
      const entry = read.entries.find((e) => e.path === "solo" && e.category === "unstaged")!;
      const env = { repositoryId: r.repositoryId, repositoryGeneration: read.generation };
      const change = await request<{ old: string; new: string; state: { state: string; added: number; removed: number; addedCommits: { oid: string; subject: string }[] } }>(s, "readSubmoduleChange", { source: { kind: "workspace", snapshotId: read.snapshotId, entryId: entry.entryId } }, env);
      expect(outcome(change)).toEqual(SUCCEEDED);
      expect({ old: change.result!.old, new: change.result!.new, added: change.result!.state.added, removed: change.result!.state.removed, list: change.result!.state.addedCommits }).toEqual({ old, new: next, added, removed, list: [{ oid: subject[0]!, subject: subject[1]! }] });
      const work = await request<{ entries: { path: string; state: string; modified?: boolean; untracked?: boolean }[] }>(s, "readSubmoduleWork", { snapshotId: read.snapshotId }, env);
      expect(outcome(work)).toEqual(SUCCEEDED);
      const shown = Object.fromEntries(work.result!.entries.filter((e) => e.state === "checked" && (e.modified || e.untracked)).map((e) => [e.path, { modified: e.modified!, untracked: e.untracked! }]));
      expect(shown).toEqual(Object.fromEntries(Object.entries(oracle).filter(([, v]) => v.modified || v.untracked)));
    });
  });

  W("SC-012: readSubmoduleWork time of 100 initialized clean submodules in the distro, median of 10 warm runs", async (w) => {
    const h = hostOf(w);
    const sub = buildSubmodules(gitPath(), "t108-wsl");
    const sup = `${copyIn(w, sub.root, "t108-wsl")}/super`;
    prepare(h, [sup, `${sup}/solo`]);
    const head = t(h, `${sup}/solo`, ["rev-parse", "HEAD"]).trim();
    sh(w, 'i=0; while [ $i -lt 100 ]; do n=$(printf "%03d" $i); mkdir -p "$1/m" && cp -a "$1/solo" "$1/m/$n" && rm -f "$1/m/$n/.git" && cp -a "$1/.git/modules/solo" "$1/m/$n/.git" && git -C "$1/m/$n" config --unset core.worktree; i=$((i+1)); done', [sup]);
    const info = Array.from({ length: 100 }, (_, i) => `160000 ${head}\tm/${String(i).padStart(3, "0")}`).join("\n");
    g(h, sup, ["update-index", "--index-info"], { input: Buffer.from(`${info}\n`) });
    await withWsl(w, "t108-wsl", async (s) => {
      const r = await s.register(uncPath(w, sup));
      const times: number[] = [];
      for (let run = 0; run < 11; run++) {
        const read = await readOk(s, r.repositoryId);
        const started = performance.now();
        const work = await request<{ entries: { state: string; reason?: string; code?: string }[] }>(s, "readSubmoduleWork", { snapshotId: read.snapshotId }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
        if (run > 0) times.push(performance.now() - started);
        expect(outcome(work)).toEqual(SUCCEEDED);
        const tally = new Map<string, number>();
        for (const e of work.result!.entries) tally.set(`${e.state}${e.reason ? ` ${e.reason}` : ""}${e.code ? ` ${e.code}` : ""}`, (tally.get(`${e.state}${e.reason ? ` ${e.reason}` : ""}${e.code ? ` ${e.code}` : ""}`) ?? 0) + 1);
        console.log(`SC012 WSL run ${run}: ${(performance.now() - started).toFixed(0)} ms, ${[...tally].map(([k, n]) => `${k}=${n}`).join(", ")}`);
        // Contract Δ3: a target without a result at the 30 s read deadline gives `failed` with DEADLINE. The time is the T108 record.
        expect(work.result!.entries.filter((e) => e.state !== "checked" && e.code !== "DEADLINE")).toEqual([]);
      }
      times.sort((a, b) => a - b);
      console.log(`SC012 WSL 100 submodules: median ${((times[4]! + times[5]!) / 2).toFixed(0)} ms, min ${times[0]!.toFixed(0)} ms, max ${times.at(-1)!.toFixed(0)} ms (${w.distro})`);
    });
  });
});

// ---- Delete, preview, and Save through the WSL file actions of the shell test double (T078) ----

// 001 contract §11 "Paths and file access" keeps the seven operation-marker `stat` calls through UNC (`commands.ts` `OPERATION_MARKERS`),
// and the raw index bytes after a changed index digest in a read ("Change polling"). Every other `\\wsl.localhost` call of a WSL repository fails FR-043.
function crossingIn(w: WslHost, repo: string): (calls: FsCall[]) => FsCall[] {
  const git = uncPath(w, `${repo}/.git`);
  const markers = OPERATION_MARKERS.map((m) => `${git}\\${m.replaceAll("/", "\\")}`.toLowerCase());
  const index = `${git}\\index`.toLowerCase();
  return (calls) => calls.filter((c) => /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]/i.test(c.path) && !(c.name === "stat" && markers.includes(c.path.toLowerCase())) && !(c.name === "open" && c.path.toLowerCase() === index));
}

type DeleteRun = { action: "delete"; entries: { entryId: string; outcome: string }[]; folders: { pathBytes: string; outcome: string }[] };
type Group = { count: number; paths: string[] };
type Preview = { preview: { newlyIgnored: Group; noLongerIgnored: Group; trackedMatched: number } } | { unavailable: { reason: string } };
type IgnoreRead = { expected: "absent" | { size: number; sha256: string } };
const isCheck = (call: { arguments: readonly string[] }) => subcommand(call.arguments) === "check-ignore";
const shadowCalls = (s: Service, from = 0) => s.runner.calls.slice(from).filter((c) => c.contextKind === "ignorePreview");

// Data-model §7 groups: the full count and the first 1,000 paths by `comparePaths`. A record that ends with `/` is a folder row.
function group(paths: string[]): Group {
  const sorted = [...paths].sort((a, b) => comparePaths(Buffer.from(a.replace(/\/$/, "")), Buffer.from(b.replace(/\/$/, "")), a.endsWith("/"), b.endsWith("/")));
  return { count: paths.length, paths: sorted.slice(0, PREVIEW_GROUP_PATHS).map((p) => b64(p)) };
}

// SC-005: the distro Git's change of the ignored set and of the matched tracked set after a real save of `bytes` on a copy.
function previewOracle(h: GitHost, repo: string, name: string, file: string, bytes: Uint8Array): { newlyIgnored: Group; noLongerIgnored: Group; trackedMatched: number } {
  const copy = copyOf(h, repo, name);
  h.write(`${copy}/${file}`, bytes);
  const matched = ["--no-optional-locks", "ls-files", "-c", "-i", "--exclude-standard", "-z"];
  const before = new Set(records(g(h, repo, ["--no-optional-locks", ...IGNORED_ARGS])));
  const after = new Set(records(g(h, copy, ["--no-optional-locks", ...IGNORED_ARGS])));
  const matchedBefore = new Set(records(g(h, repo, matched)));
  return {
    newlyIgnored: group([...after].filter((p) => !before.has(p))),
    noLongerIgnored: group([...before].filter((p) => !after.has(p))),
    trackedMatched: records(g(h, copy, matched)).filter((p) => !matchedBefore.has(p)).length,
  };
}

// The `arbareto-preview-<pid>-*` folders of this test process below the distro `/tmp` (contract Δ11 `scratch`).
const shadowsOf = (w: WslHost) => sh(w, 'find /tmp -maxdepth 1 -name "arbareto-preview-$1-*" -printf "%f\\n"', [String(process.pid)]).stdout.split("\n").filter((n) => n !== "");

async function deleteRun(s: Service, r: RegistrationResult, read: { snapshotId: string; generation: number }, entryIds: string[], folder?: string): Promise<ServiceResponse<DeleteRun>> {
  const review = await request<{ workbenchToken: string; plan: { wsl: boolean } }>(s, "reviewWorkbench", { action: "delete", snapshotId: read.snapshotId, entryIds, mode: "permanent", ...(folder === undefined ? {} : { folder: b64(folder) }) }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
  expect({ ...outcome(review), wsl: review.result?.plan.wsl }).toEqual({ ...SUCCEEDED, wsl: true });
  return request<DeleteRun>(s, "runWorkbench", { workbenchToken: review.result!.workbenchToken, start: true }, { repositoryId: r.repositoryId });
}

describe("T078 Delete, preview, and Save through the WSL file actions of the shell test double (quickstart.md Q16, Q18 to Q25)", () => {
  W("Q16 FR-029, FR-031, SC-003: Delete through the service in a WSL repository: the listed paths go, every other byte and the index stay, and a folder swapped for a link during the walk changes nothing outside the reviewed paths", async (w) => {
    const h = hostOf(w);
    const { dest, repo } = filesIn(w, "t059-q16-delete");
    sh(w, 'ln -s ../outside/keep.txt "$1/lnk" && mkdir -p "$1/swap" "$2" && printf one > "$1/swap/1.txt" && printf two > "$1/swap/2.txt" && cp -a "$1/swap/." "$2/"', [repo, `${dest}/outside-swap`]);
    const outside = { keep: h.digests(`${dest}/outside`), swap: h.digests(`${dest}/outside-swap`) };
    const before = h.digests(repo);
    const index = indexSha(h, repo);
    const hold = seam(w, h, "q16-delete");
    await withWsl(w, "t059-q16-delete", async (s) => {
      const r = await s.register(uncPath(w, repo));
      // Each run changes the workspace, so each review takes a new snapshot.
      const fresh = async () => {
        const read = await readOk(s, r.repositoryId);
        return { read, id: (path: string) => read.entries.find((e) => e.path === path && e.category !== "staged")!.entryId };
      };
      let { read, id } = await fresh();
      const plain = await deleteRun(s, r, read, [id("u1.txt"), id("lnk")]);
      expect({ ...outcome(plain), entries: plain.result?.entries }).toEqual({ ...SUCCEEDED, entries: [id("lnk"), id("u1.txt")].map((entryId) => ({ entryId, outcome: "deleted" })) });
      const logs = ["logs/1.log", "logs/2.log", "logs/3.log", "logs/4.log"];
      ({ read, id } = await fresh());
      const folder = await deleteRun(s, r, read, logs.map(id), "logs");
      // The ignored `logs/skip.tmp` is not in the review, so the candidate folder stays (plan.md D7).
      expect({ ...outcome(folder), entries: folder.result?.entries.map((e) => e.outcome), folders: folder.result?.folders }).toEqual({ ...SUCCEEDED, entries: logs.map(() => "deleted"), folders: [{ pathBytes: b64("logs"), outcome: "kept" }] });
      const gone = ["u1.txt", "lnk", ...logs];
      expect(kinds(w, [...gone, "logs", "logs/skip.tmp"].map((p) => `${repo}/${p}`))).toEqual([...gone.map(() => "a"), "d", "f"]);
      // A folder with only reviewed files goes with its emptied parents, deepest first.
      ({ read, id } = await fresh());
      const nested = await deleteRun(s, r, read, [id("a/b/c/x.txt")], "a");
      expect({ ...outcome(nested), entries: nested.result?.entries.map((e) => e.outcome), folders: nested.result?.folders.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, entries: ["deleted"], folders: ["removed", "removed", "removed"] });
      expect(kinds(w, [`${repo}/a`])).toEqual(["a"]);
      // The seam holds the walk inside `swap` after its first check. Then `swap` becomes a link to the outside copy.
      ({ read, id } = await fresh());
      s.runner.inject.wslSha256sum = hold.path;
      try {
        const pending = deleteRun(s, r, read, [id("swap/1.txt"), id("swap/2.txt")], "swap");
        try {
          await waitHeld(w, hold.held);
          sh(w, 'mv "$1/swap" "$1/swap.held" && ln -s "$2" "$1/swap"', [repo, `${dest}/outside-swap`]);
        } finally {
          h.write(hold.go, "");
        }
        const swapped = await pending;
        // The fresh read finds both paths through the link, so the walk's delete in the held folder shows as `changed` (plan.md D6 "Outcome per file").
        expect({ ...outcome(swapped), entries: swapped.result?.entries.map((e) => e.outcome), folders: swapped.result?.folders.map((f) => f.outcome) }).toEqual({ state: "failed", code: "STALE_REVIEW", entries: ["changed", "not-regular"], folders: ["not-regular"] });
      } finally {
        s.runner.inject.wslSha256sum = null;
      }
    });
    expect(kinds(w, [`${repo}/swap.held/1.txt`, `${repo}/swap.held/2.txt`, `${repo}/swap`])).toEqual(["a", "f", "l"]);
    expect({ keep: h.digests(`${dest}/outside`), swap: h.digests(`${dest}/outside-swap`) }).toEqual(outside);
    // The swap test step adds the link `swap` and moves `swap/2.txt` to `swap.held/2.txt`.
    const after = without(h.digests(repo), ["swap", "swap.held/2.txt"]);
    expect(after).toEqual(without(before, ["u1.txt", "lnk", "logs/1.log", "logs/2.log", "logs/3.log", "logs/4.log", "a/b/c/x.txt", "swap/1.txt", "swap/2.txt"]));
    expect(indexSha(h, repo)).toBe(index);
  });

  W("Q16 FR-029: Cancel during a WSL Delete walk ends its processes, and each file outcome comes from the fresh read", async (w) => {
    const h = hostOf(w);
    const { repo } = filesIn(w, "t059-q16-cancel");
    const hold = seam(w, h, "q16-cancel");
    await withWsl(w, "t059-q16-cancel", async (s) => {
      const r = await s.register(uncPath(w, repo));
      const read = await readOk(s, r.repositoryId);
      const id = (path: string) => read.entries.find((e) => e.path === path && e.category !== "staged")!.entryId;
      const review = await request<{ workbenchToken: string }>(s, "reviewWorkbench", { action: "delete", snapshotId: read.snapshotId, entryIds: [id("u1.txt"), id("u2.txt")], mode: "permanent" }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
      expect(outcome(review)).toEqual(SUCCEEDED);
      s.runner.inject.wslSha256sum = hold.path;
      try {
        const requestId = s.send("runWorkbench", { workbenchToken: review.result!.workbenchToken, start: true }, { repositoryId: r.repositoryId });
        await waitHeld(w, hold.held);
        const operation = await s.operationId(requestId);
        await s.cancel(operation);
        const done = await s.response<DeleteRun>(requestId, RESPONSE_MS);
        expect({ state: done.state, code: done.code, entries: done.result?.entries }).toEqual({ state: "canceled", code: "CANCELED", entries: [id("u1.txt"), id("u2.txt")].map((entryId) => ({ entryId, outcome: "stopped" })) });
        await noneLeft(w, operation, hold.path);
      } finally {
        h.write(hold.go, "");
        s.runner.inject.wslSha256sum = null;
      }
    });
    expect(kinds(w, [`${repo}/u1.txt`, `${repo}/u2.txt`])).toEqual(["f", "f"]);
  });

  W("Q18 to Q20, Q25 FR-043, SC-005: each preview of a WSL repository equals the distro Git's listings after a real save on a copy, with the text on stdin and no \\\\wsl.localhost call besides the operation markers", async (w) => {
    const h = hostOf(w);
    const repo = reportIn(w, "t059-q18");
    const crossing = crossingIn(w, repo);
    const cases: [label: string, target: "gitignore" | "exclude", text: string][] = [
      ["US5-1 *.txt on top", "gitignore", `${REPORT_ROOT_TEXT}emptyign/\n*.txt\n`],
      ["C1 root: drop folders, add *.txt and !a.txt", "gitignore", "*.log\n!keep.log\n**/tmp/**\n*.txt\n!a.txt\n"],
      ["C3 info/exclude", "exclude", "*.txt\n!untr/b.txt\nnode_modules/pkg/\n"],
      ["C5 ignored folder with a negation inside, ** forms", "gitignore", "node_modules\n!node_modules/pkg/index.js\n**/sub/**/local\nuntr/**\n!untr/b.txt\n"],
    ];
    await withWsl(w, "t059-q18", async (s) => {
      const r = await s.register(uncPath(w, repo));
      const read = await readOk(s, r.repositoryId);
      expect(read.location.kind).toBe("wsl");
      for (const [label, target, text] of cases) {
        const from = s.runner.calls.length;
        const { value: got, calls } = await withFsCalls(() => request<Preview>(s, "previewIgnore", { target, text: b64(text), snapshotId: read.snapshotId }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation }));
        expect({ label, crossing: crossing(calls) }).toEqual({ label, crossing: [] });
        expect({ label, ...outcome(got), kind: got.result === undefined ? null : Object.keys(got.result)[0] }).toEqual({ label, ...SUCCEEDED, kind: "preview" });
        const preview = (got.result as Extract<Preview, { preview: unknown }>).preview;
        const want = previewOracle(h, repo, "t059-q18-copy", target === "gitignore" ? ".gitignore" : ".git/info/exclude", Buffer.from(text));
        expect({ label, newlyIgnored: preview.newlyIgnored, noLongerIgnored: preview.noLongerIgnored, trackedMatched: preview.trackedMatched }).toEqual({ label, ...want });
        // Contract Δ6 fixed shadow arrays: the candidate text reaches the distro Git only as the stdin of one shadow call.
        expect({ label, onStdin: shadowCalls(s, from).some((c) => c.input !== undefined && Buffer.from(c.input).equals(Buffer.from(text))) }).toEqual({ label, onStdin: true });
      }
    });
  });

  W("Q22 FR-041: the WSL shadow folder goes after the preview end and after Cancel, and a killed run's folder goes at the next preview", async (w) => {
    const repo = reportIn(w, "t059-q22");
    // A killed run leaves the folder of another process: this PID with another creation time (plan.md D14).
    const leftover = `/tmp/arbareto-preview-${process.pid}-1-0123456789abcdef`;
    const own = () => shadowsOf(w).filter((n) => `/tmp/${n}` !== leftover);
    await withWsl(w, "t059-q22", async (s) => {
      const r = await s.register(uncPath(w, repo));
      const read = await readOk(s, r.repositoryId);
      const envelope = { repositoryId: r.repositoryId, repositoryGeneration: read.generation };
      const preview = async (text: string) => expect(outcome(await request<Preview>(s, "previewIgnore", { target: "gitignore", text: b64(text), snapshotId: read.snapshotId }, envelope))).toEqual(SUCCEEDED);
      await preview("*.md\n");
      await until(() => own().length === 0, "the shadow folder of the finished preview", HELD_MS);
      const release = s.runner.holdStart(isCheck);
      const from = s.runner.calls.length;
      const requestId = s.send("previewIgnore", { target: "gitignore", text: b64("*.txt\n"), snapshotId: read.snapshotId }, envelope);
      try {
        await until(() => shadowCalls(s, from).some(isCheck), "the held check", HELD_MS);
        expect(own().length).toBe(1);
        await s.cancel(await s.operationId(requestId));
      } finally {
        release();
      }
      expect(outcome(await s.response(requestId, RESPONSE_MS))).toEqual({ state: "canceled", code: "CANCELED" });
      await until(() => own().length === 0, "the shadow folder of the canceled preview", HELD_MS);
      sh(w, 'mkdir -p "$1/s" && : > "$1/s/left.txt"', [leftover]);
      try {
        await preview("*.md\n");
        await until(() => kinds(w, [leftover])[0] === "a", "the leftover shadow folder", HELD_MS);
      } finally {
        sh(w, 'rm -rf --one-file-system -- "$1"', [leftover]);
      }
    });
  });

  W("Q23, Q25 FR-043: Save in a WSL repository replaces the file through wslFiles replace: CRLF and the BOM stay, an absent file saves with LF, and info/exclude saves in the common folder", async (w) => {
    const h = hostOf(w);
    const cases: [form: "crlf" | "bom" | "absent", target: "gitignore" | "exclude", text: string, bytes: Buffer][] = [
      ["crlf", "gitignore", "*.log\n/out/\n/new/\n", Buffer.from("*.log\r\n/out/\r\n/new/\r\n")],
      ["bom", "gitignore", "*.log\n/new/\n", Buffer.from("\u{feff}*.log\n/new/\n")],
      ["absent", "gitignore", "/new/\n", Buffer.from("/new/\n")],
      // The exclude case replaces the LF template with CRLF text first, so its save keeps CRLF too.
      ["crlf", "exclude", "secret.txt\n", Buffer.from("secret.txt\r\n")],
    ];
    for (const [form, target, text, bytes] of cases) {
      const f = buildIgnoreForm(gitPath(), `t059-q23-${form}-${target}`, form);
      const repo = `${copyIn(w, f.root, `t059-q23-${form}-${target}`)}/repo`;
      prepare(h, [repo]);
      const file = target === "gitignore" ? `${repo}/.gitignore` : `${repo}/.git/info/exclude`;
      if (target === "exclude") h.write(file, "# exclude\r\n");
      const crossing = crossingIn(w, repo);
      await withWsl(w, `t059-q23-${form}-${target}`, async (s) => {
        const r = await s.register(uncPath(w, repo));
        const envelope = { repositoryId: r.repositoryId, repositoryGeneration: r.generation };
        const read = await request<IgnoreRead>(s, "readIgnoreFile", { target }, envelope);
        expect(outcome(read)).toEqual(SUCCEEDED);
        const from = s.runner.frames.length;
        const { value: saved, calls } = await withFsCalls(async () => {
          const review = await request<{ workbenchToken: string }>(s, "reviewWorkbench", { action: "ignore-save", target, text: b64(text), expected: read.result!.expected }, envelope);
          expect({ form, target, ...outcome(review) }).toEqual({ form, target, ...SUCCEEDED });
          return request<{ action: string; outcome?: string }>(s, "runWorkbench", { workbenchToken: review.result!.workbenchToken, start: true }, { repositoryId: r.repositoryId });
        });
        expect({ form, target, ...outcome(saved), result: saved.result, crossing: crossing(calls) }).toEqual({ form, target, ...SUCCEEDED, result: { action: "ignore-save", outcome: "replaced" }, crossing: [] });
        expect({ form, target, frames: s.runner.frames.slice(from).filter((frame) => frame.type === "fileReplace").length }).toEqual({ form, target, frames: 1 });
      });
      expect({ form, target, bytes: [...h.read(file)!] }).toEqual({ form, target, bytes: [...bytes] });
      expect(sh(w, 'find "$1" "$1/.git/info" -maxdepth 1 -name ".arbareto-*" -print', [repo]).stdout).toBe("");
    }
  });
});
