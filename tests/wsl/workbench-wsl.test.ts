// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T081: the WSL rows of quickstart.md Q26 and the plan.md D18 checks in the distro of `ARBARETO_WSL_DISTRO` (spec FR-006).
// The Windows builder (`tests/git/workbench-fixtures.ts`) makes each fixture, and a `tar` stream on stdin copies it into the owned distro folder.
// The oracle is the distro Git on a second copy. Fact cases print `OBSERVATION T081` lines: a `match=false` line is a finding for research.md R21, not a failure.
// The service gives the distro Git no fixed commit dates, so service cases compare commits by tree, subject, and parent shapes, never by object ID (plan.md D19).
// Feature 006 T032 and T034 (plan.md D14): the WSL Global save through the double and the 004 research.md R21 rows without a WSL case. Fact lines print `OBSERVATION T032` and `OBSERVATION T034`.
// The wrapper runs of this file outside the double use operation IDs that start with `0f0f0f0f-0000-4000-800a-`. No other test uses that prefix.

import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GIT_PROCESS_DEADLINE_MS, STATUS_LISTING_RECORDS } from "../../src/contracts/limits";
import type { SubmoduleRowResult } from "../../src/contracts/submodules";
import wslProcess from "../../src/contracts/wsl-process.json";
import { createCollector, PROCESS_LIMITS, type GitCall } from "../../src/git-service/git-runner";
import { printOrigin } from "../origin";
import { createBunRunner, createTrustStore } from "../git/bun-runner";
import { obs, observationLine, READ, same, STEP, type Observation } from "../git/fact-runner";
import { fixtureDir, serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { sha256 } from "../git/git-oracle";
import { applyHunk, commit, commitCalls, compare, hunksOf, outcome, patchOf, readOk, resultOf, reviewOk, selectHunks, subcommand, SUCCEEDED, until, valuesOf, type Comparison, type Direction } from "../git/hunk-harness";
import { fc, gitOut, gitPaths, gitRun, importStream, markers, refMap, stageEntries, type GitHost, type GitResult, type RunOptions } from "../git/remote-fixtures";
import { openService, type ChangeEntry, type HunkCheckpoint, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "../git/service-harness";
import { commandOf, objectsWith, refusalsOf, resultsOf, updateSteps } from "../git/submodule-harness";
import { ANY_EXIT, gitExe, INTEGRATE_ENV, sendSync } from "../git/sync-harness";
import { buildWorkbench, FIXTURE_MERGE_RESULT, repoOf, wb, type WbFixture, type WbFixtureName } from "../git/workbench-fixtures";
import { buildF31, distroGit, distroGitHost, distroSubmoduleOracle, distroSubmoduleState, globalConfig, seamRepository, sh, startSession } from "./fixtures";
import { inDistro, listScopes, OWN_SCOPE_OPERATIONS, pgrep, uncPath, useWslFolder, wslExec, wslTest, type WslCapability, type WslHost } from "./wsl-host";

for (const module of ["session", "workbench-review", "switch", "branch-ops", "merge-rebase", "resolve", "worktrees", "git-settings", "trust", "file-publish", "hunk-publish", "multi-publish", "submodule-review", "submodule-update"]) {
  printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
}
printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);
printOrigin("../git/workbench-fixtures.ts", import.meta.dir);
printOrigin("../git/bun-runner.ts", import.meta.dir);

useFixtureRoot();
useWslFolder();

const TASK = "T081";
const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55", "perl"];
const FACT_MS = 900_000;
const CASE_MS = 900_000;
// Each WSL step runs several `wsl.exe` processes, so a run can take longer than the default response wait of the harness.
const RESPONSE_MS = 300_000;
// research.md R21 F21: an empty standard input ends the merge tool question at once.
const MERGETOOL_MS = 60_000;
// Contract §11 "Process ownership": no Linux process of the operation remains 1 second after the Job close.
const AFTER_CLOSE_MS = 1_000;
const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const L = "--no-lazy-fetch";
// `check-ignore` refuses the literal pathspec magic (research.md R21 F1), so its reads omit it.
const READ_IGNORE = ["--no-lazy-fetch", "--no-optional-locks"];
const EMPTY = new Uint8Array();
const TARGET = "refs/heads/target";
const MESSAGE = "Arbareto: switch to target";
const PUSH = [...STEP, "stash", "push", "--quiet", "-m", MESSAGE];
const CHECKOUT_TARGET = [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "target", "--"];
const REBASE_UP = [...STEP, "rebase", "--no-autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"];
const FIXED_USER = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";

// ---- The distro host, the owned global file, and the fixture transfer ----

const mergeTool = (w: WslHost) => `${w.folder}/home/fixture-merge-tool.sh`;
// The quickstart.md fixture merge tool. A `\"` in a configuration value is a literal quote (git-config(1) "Syntax").
// Without `trustExitCode`, git-mergetool--lib `check_unchanged` decides by `test "$MERGED" -nt "$BACKUP"`. F21 `untrusted-fixture-tool-times` observed equal `%.9Y` times for this tool, so Git asks.
// With it, Git decides by the exit code (git-config(1) `mergetool.<tool>.trustExitCode`).
const globalText = (w: WslHost, extra = "") => `${FIXED_USER}[mergetool "fixture"]\n\tcmd = '${mergeTool(w)}' \\"$MERGED\\"\n\ttrustExitCode = true\n${extra}`;

// The default `core.excludesFile` of the owned home (git-config(1)). The oracle reads it through `HOME`, and the double through `XDG_CONFIG_HOME`.
const XDG_IGNORED = "xdg-ignored.txt";

let distroHost: GitHost | undefined;
// One host for the file.
function ensureHost(w: WslHost): GitHost {
  if (distroHost === undefined) {
    distroHost = distroGitHost(w, "wb", globalText(w), INTEGRATE_ENV);
    distroHost.write(mergeTool(w), `#!/bin/sh\nprintf '${FIXTURE_MERGE_RESULT.replace("\n", "\\n")}' > "$1"\n`);
    distroHost.write(`${w.folder}/home/.config/git/ignore`, `${XDG_IGNORED}\n`);
  }
  return distroHost;
}
// Each case starts with the owned global file of `globalText`, because `buildF31` rewrites it.
function hostOf(w: WslHost, extra = ""): GitHost {
  const h = ensureHost(w);
  h.write(h.globalConfig, globalText(w, extra));
  return h;
}

// A fixture in the distro: the Linux paths of its root and main worktree, and the labels of its construction.
interface DistroFixture {
  w: WslHost;
  h: GitHost;
  name: string;
  root: string;
  repo: string;
  oids: Record<string, string>;
  refs: Record<string, string>;
}

const slash = (p: string) => p.replaceAll("\\", "/");
// The raw attribute lines of each `worktree list --porcelain -z` record (git-worktree(1) "Porcelain Format").
const recordLines = (raw: string): string[][] => raw.split("\0\0").filter((r) => r !== "").map((r) => r.split("\0"));
const valueOf = (lines: string[], label: string): string | null | undefined => {
  const line = lines.find((l) => l === label || l.startsWith(`${label} `));
  return line === undefined ? undefined : line === label ? null : line.slice(label.length + 1);
};

let transfers = 0;
// The `tar` stream of the Windows build goes to `tar -x` in the distro. Git for Windows writes `core.symlinks`, `core.ignorecase`, and `core.filemode` at `init` (Windows facts), so the copy drops them.
// The linked worktrees hold Windows paths. Each `gitdir` file of the main Git folder takes the Linux prefix, also for a removed folder (gitrepository-layout(5) `worktrees/<id>/gitdir`).
// Then `git worktree repair` with the new paths rewrites the `.git` file of each existing linked worktree (git-worktree(1) "repair").
function toDistro(w: WslHost, f: WbFixture): DistroFixture {
  const h = ensureHost(w);
  const root = `${h.root}/${f.name}-${++transfers}`;
  inDistro(w.distro, ["/usr/bin/mkdir", "-p", "--", root]);
  const tar = Bun.spawnSync([TAR, "--no-acls", "--no-xattrs", "--no-fflags", "-c", "-f", "-", "-C", f.root, "."], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  if (tar.exitCode !== 0) throw new Error(`tar -c of ${f.root} exited ${tar.exitCode}: ${tar.stderr.toString()}`);
  const x = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/usr/bin/tar", "-x", "-f", "-", "-C", root], { input: new Uint8Array(tar.stdout), timeoutMs: 120_000 });
  if (x.exitCode !== 0) throw new Error(`tar -x into ${root} exited ${x.exitCode}: ${x.stderr}`);
  const prefix = `${slash(f.root)}/`;
  const linked = recordLines(wb(repoOf(f), ["worktree", "list", "--porcelain", "-z"]).stdout.toString("utf8"))
    .slice(1)
    .map((lines) => valueOf(lines, "worktree")!)
    .filter((p) => existsSync(p))
    .map((p) => {
      if (!slash(p).startsWith(prefix)) throw new Error(`a linked worktree outside the fixture: ${p}`);
      return `${root}/${slash(p).slice(prefix.length)}`;
    });
  const repo = `${root}/repo`;
  for (const key of ["core.symlinks", "core.ignorecase", "core.filemode"]) gitRun(h, repo, ["config", "--local", "--unset", key], { allowExit: [0, 5] });
  const admin = sh(w, 'for g in .git/worktrees/*/gitdir; do [ -f "$g" ] && printf "%s\\0" "$g"; done; exit 0', [], { cwd: repo }).stdout;
  for (const rel of nul(admin)) {
    const path = `${repo}/${rel}`;
    const content = h.read(path)!.toString("utf8");
    if (!content.startsWith(prefix)) throw new Error(`a gitdir file outside the fixture: ${path}: ${content}`);
    h.write(path, `${root}/${content.slice(prefix.length)}`);
  }
  if (linked.length > 0) gitRun(h, repo, ["worktree", "repair", "--", ...linked]);
  for (const dir of [repo, ...linked]) gitRun(h, dir, ["update-index", "-q", "--refresh"], { allowExit: ANY_EXIT });
  const listed = recordLines(gitOut(h, repo, ["worktree", "list", "--porcelain", "-z"])).map((lines) => valueOf(lines, "worktree")!);
  for (const dir of [repo, ...linked]) if (!listed.includes(dir)) throw new Error(`worktree ${dir} is not in the distro list: ${JSON.stringify(listed)}`);
  return { w, h, name: f.name, root, repo, oids: f.oids, refs: f.refs };
}

let builds = 0;
// A new Windows build in the distro. T001 proves that two builds are equal, so a second build is the copy.
const copy = (w: WslHost, name: WbFixtureName): DistroFixture => toDistro(w, buildWorkbench(gitExe(), name, `t081-${name}-${++builds}`));
const sharedBuilds = new Map<WbFixtureName, DistroFixture>();
// One build per fixture for reads only.
function shared(w: WslHost, name: WbFixtureName): DistroFixture {
  if (!sharedBuilds.has(name)) sharedBuilds.set(name, copy(w, name));
  return sharedBuilds.get(name)!;
}

// ---- Git calls in the distro ----

interface Repo {
  w: WslHost;
  h: GitHost;
  dir: string;
}
const at = (f: DistroFixture, dir = f.repo): Repo => ({ w: f.w, h: f.h, dir });
const run = (r: Repo, args: string[], o: RunOptions = {}): GitResult => r.h.run(r.dir, args, o);
const text = (res: GitResult) => res.stdout.toString("utf8");
const out = (r: Repo, args: string[], o: RunOptions & { allowExit?: number[] } = {}) => gitOut(r.h, r.dir, args, o);
const nul = (s: string) => s.split("\0").filter((x) => x !== "");
const bytes = (s: string) => Buffer.from(s, "utf8");
// A timeout gives -1, which is no Git exit.
const exitObs = (fact: string, expected: number | "nonzero", exit: number) => obs(fact, expected, exit, expected === "nonzero" ? exit > 0 : exit === expected);

function headOf(r: Repo): string {
  const sym = run(r, ["symbolic-ref", "-q", "HEAD"]);
  return sym.exitCode === 0 ? text(sym).trim() : out(r, ["rev-parse", "HEAD"]).trim();
}
const localConfig = (r: Repo) => gitPaths(r.h, r.dir, ["config"])[0]!;
const fileDigest = (r: Repo, path: string) => {
  const b = r.h.read(path);
  return b === null ? "absent" : sha256(b);
};
const indexDigest = (r: Repo) => fileDigest(r, gitPaths(r.h, r.dir, ["index"])[0]!);

// HEAD, refs, the index, working bytes, operation markers, and the local configuration bytes (the T003 `state`).
function state(r: Repo): Record<string, unknown> {
  return { head: headOf(r), refs: refMap(r.h, r.dir), index: stageEntries(r.h, r.dir), files: r.h.digests(r.dir), markers: markers(r.h, r.dir), config: fileDigest(r, localConfig(r)) };
}
const changed = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).filter((k) => !same(a[k], b[k]));

function stashValue(r: Repo): string | null {
  const res = run(r, [...READ, "rev-parse", "--verify", "-q", "refs/stash"]);
  return res.exitCode === 0 ? text(res).trim() : null;
}
// `show-ref --exists` exits 2 for a missing ref (git-show-ref(1)).
function stashReflog(r: Repo): string[] {
  if (run(r, [...READ, "show-ref", "--exists", "refs/stash"]).exitCode !== 0) return [];
  return nul(out(r, [...READ, "log", "-g", "-z", "--no-show-signature", "--format=%H", "refs/stash", "--"]));
}
const message = (r: Repo, rev: string) => {
  const raw = out(r, ["cat-file", "commit", rev]);
  return raw.slice(raw.indexOf("\n\n") + 2);
};
const subjects = (r: Repo, range: string[]) => out(r, ["log", "--reverse", "--format=%s", ...range]).split("\n").filter((l) => l !== "");
const count = (r: Repo, args: string[]) => Number(out(r, [...READ, "rev-list", "--count", ...args]).trim());
// F10: the commits that a branch, tag, or remote-tracking ref reaches.
const reachable = (r: Repo) => new Set(out(r, ["rev-list", "--branches", "--tags", "--remotes"]).split("\n").filter((l) => l !== ""));
const stages = (r: Repo, path: string) => stageEntries(r.h, r.dir, [path]).map((e) => `${e.mode} ${e.stage}`);
const logLines = (r: Repo, log: string) => (r.h.read(log)?.toString("utf8") ?? "").split("\n").filter((l) => l !== "");

// The kind of each path relative to `r.dir`: `l` link, `d` folder, `f` other, `a` absent. The output has one line per argument in order.
function kindsOf(r: Repo, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const script = 'for p; do if [ -L "$p" ]; then echo l; elif [ -d "$p" ]; then echo d; elif [ -e "$p" ]; then echo f; else echo a; fi; done';
  return sh(r.w, script, paths, { cwd: r.dir }).stdout.split("\n").slice(0, paths.length);
}

// The plan.md D3 in-the-way check (research.md R4), built from its text. `bytes: false` counts a file only without a stage-0 entry at its path.
function inTheWay(r: Repo, head: string, target: string, compareBytes = true): string[] {
  const fields = out(r, [...READ, "diff-tree", "-r", "-z", "--no-renames", "--name-status", head, target]).split("\0");
  const writes = new Set<string>();
  const candidates = new Set<string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [status, path] = [fields[i]!, fields[i + 1]!];
    candidates.add(path);
    if (status === "D") continue;
    writes.add(path);
    const parts = path.split("/");
    for (let k = 1; k < parts.length; k++) candidates.add(parts.slice(0, k).join("/"));
  }
  const index = new Map(stageEntries(r.h, r.dir).filter((e) => e.stage === 0).map((e) => [e.path, e.oid]));
  const list = [...candidates];
  const kinds = kindsOf(r, list);
  const counted = list.filter((c, i) => {
    if (kinds[i] === "a") return false;
    if (kinds[i] === "d") return writes.has(c);
    const oid = index.get(c);
    return oid === undefined || (compareBytes && out(r, ["hash-object", "--no-filters", "--", c]).trim() !== oid);
  });
  if (counted.length === 0) return [];
  // `check-ignore` exits 1 when no path is ignored (git-check-ignore(1)).
  const ignored = new Set(nul(out(r, [...READ_IGNORE, "check-ignore", "-z", "--stdin", "--no-index"], { input: bytes(counted.map((c) => `${c}\0`).join("")), allowExit: [0, 1] })));
  return counted.filter((c) => !ignored.has(c)).sort();
}

// A POSIX shell canary in `root/canaries`. Each run appends one line to `log`.
function canary(r: Repo, root: string, name: string, tail = ""): { command: string; log: string } {
  const log = `${root}/canaries/${name}.log`;
  const script = `${root}/canaries/${name}.sh`;
  r.h.write(script, `#!/bin/sh\necho "${name} $*" >> '${log}'\n${tail}`);
  return { command: `'${script}'`, log };
}
// A hook canary in the common Git folder. Git starts a hook only when its file exists and is executable.
function hookCanary(f: DistroFixture, event: string): string {
  const log = `${f.root}/canaries/${event}.log`;
  f.h.write(`${f.root}/canaries/.keep`, "");
  f.h.write(`${f.repo}/.git/hooks/${event}`, `#!/bin/sh\necho "${event} $*" >> '${log}'\n`);
  return log;
}

// ---- Facts F1 to F24 and F29 to F31 in the distro (research.md R21, plan.md D18) ----

function f1(w: WslHost): Observation[] {
  const o: Observation[] = [];
  const step = (label: string, r: Repo, args: string[], exits: number[], opt: RunOptions = {}) => {
    const res = run(r, args, opt);
    o.push(obs(`F1.${label}`, exits, res.exitCode, exits.includes(res.exitCode)));
    return res;
  };
  const b = shared(w, "branches");
  const br = at(b);
  step("readBranches.for-each-ref", br, [...READ, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00%(symref)", "refs/heads", "refs/remotes"], [0]);
  step("readWorktrees", br, [...READ, "worktree", "list", "--porcelain", "-z"], [0]);
  step("readGitSettings", br, [...READ, "config", "list", "--show-scope", "--show-origin", "-z"], [0]);
  step("switch.status", br, [...READ, "status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=dirty"], [0]);
  step("switch.rev-parse-commit", br, [...READ, "rev-parse", "--verify", "-q", "refs/heads/merged^{commit}"], [0]);
  step("switch.contains", br, [...READ, "for-each-ref", `--contains=${b.oids.unreachable}`, "--count=1", "--format=%(refname)"], [0]);
  step("switch.stash-exists", br, [...READ, "show-ref", "--exists", "refs/stash"], [2]);
  step("switch.stash-value", br, [...READ, "rev-parse", "--verify", "-q", "refs/stash"], [1]);
  step("track.name-exists", br, [...READ, "show-ref", "--exists", "refs/heads/main"], [0]);
  step("create-branch.check-ref-format", br, [...READ, "check-ref-format", "--branch", "topic"], [0]);
  step("delete-branch.count", br, [...READ, "rev-list", "--count", b.oids.unmerged!, "--not", "--exclude=unmerged", "--branches", "--tags", "--remotes"], [0]);
  step("delete-branch.reflog-exists", br, [...READ, "reflog", "exists", "HEAD"], [0]);
  step("delete-branch.reflog", br, [...READ, "log", "-g", "-z", "--no-show-signature", "--format=%H", "-n", "10000", "HEAD", "--"], [0]);
  step("amend.cat-file", br, [...READ, "cat-file", "commit", b.oids.main!], [0]);
  step("amend.upstream", br, [...READ, "for-each-ref", "--format=%(upstream)", "refs/heads/unmerged"], [0]);
  step("worktree-remove.status", br, [...READ, "-C", `${b.root}/wt-other`, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty"], [0]);

  const u = shared(w, "switch-untracked");
  const ur = at(u);
  step("discard.diff-tree", ur, [...READ, "diff-tree", "-r", "-z", "--no-renames", "--name-status", u.oids.base!, u.oids.target!], [0]);
  step("discard.ls-files", ur, [...READ, "ls-files", "-z", "--stage", "--", "a.txt", "new.txt"], [0]);
  step("discard.check-ignore", ur, [...READ_IGNORE, "check-ignore", "-z", "--stdin", "--no-index"], [0], { input: bytes("new.txt\0build.log\0") });
  step("discard.check-ignore.with-literal-pathspecs", ur, [...READ, "check-ignore", "-z", "--stdin", "--no-index"], [128], { input: bytes("new.txt\0build.log\0") });

  const m = shared(w, "merge-diverged");
  const mr = at(m);
  step("merge.left-right", mr, [...READ, "rev-list", "--left-right", "--count", `HEAD...${m.oids.topic}`], [0]);
  step("merge.is-ancestor", mr, [...READ, "merge-base", "--is-ancestor", "HEAD", m.oids.topic!], [1]);
  step("merge.fmt-merge-msg", mr, [...READ, "fmt-merge-msg"], [0], { input: bytes(`${m.oids.topic}\t\tbranch 'topic' of .\n`) });

  const x = shared(w, "rebase-mix");
  const xr = at(x);
  const up = x.oids.up!;
  step("rebase.moved", xr, [...READ, "rev-list", "--count", "--right-only", "--cherry-pick", "--no-merges", `${up}...HEAD`], [0]);
  step("rebase.moved.rebase-merges", xr, [...READ, "rev-list", "--count", "--right-only", "--cherry-pick", `${up}...HEAD`], [0]);
  step("rebase.rewritten", xr, [...READ, "rev-list", "--count", `${up}..HEAD`], [0]);
  step("rebase.held", xr, [...READ, "rev-list", "--count", `${up}..HEAD`, "--not", "--remotes"], [0]);
  step("rebase.force-note", xr, [...READ, "rev-list", "--count", `${up}..HEAD`, "--not", "refs/remotes/origin/topic"], [0]);
  step("rebase.update-refs", xr, [...READ, "for-each-ref", "--merged=HEAD", `--no-merged=${up}`, "--format=%(refname)", "refs/heads"], [0]);

  step("choose-side.ls-files", at(shared(w, "conflict-merge")), [...READ, "ls-files", "-z", "--stage", "--", "uu.txt"], [0]);
  step("ignore.exclude-path", at(shared(w, "worktrees")), [...READ, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], [0]);
  step("amend.is-ancestor", at(shared(w, "amend-on-upstream")), [...READ, "merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"], [0]);

  const s = copy(w, "switch-clean");
  const sr = at(s);
  step("switch.keep", sr, CHECKOUT_TARGET, [0]);
  step("switch.detach", sr, [...STEP, "checkout", "--no-recurse-submodules", "--detach", s.oids.base!, "--"], [0]);
  step("switch.track", sr, [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/one/topic", "--"], [0]);
  step("create-branch.checkout", sr, [...STEP, "checkout", "--no-recurse-submodules", "-b", "fresh", s.oids.base!, "--"], [0]);

  const d = at(copy(w, "switch-dirty"));
  step("stash.push", d, PUSH, [0]);
  step("stash.drop-read", d, [...READ, "log", "-g", "-z", "--no-show-signature", "--format=%H", "refs/stash", "--"], [0]);
  step("stash.apply-index", d, [...STEP, "stash", "apply", "--index", stashValue(d) ?? "refs/stash"], [0]);
  step("stash.drop", d, [...STEP, "stash", "drop", "--quiet", "stash@{0}"], [0]);

  const c = copy(w, "branches");
  const cr = at(c);
  step("create-branch.branch", cr, [...STEP, "branch", "--end-of-options", "new-b", c.oids.main!], [0]);
  step("rename-branch", cr, [...STEP, "branch", "-m", "--end-of-options", "new-b", "new-c"], [0]);
  step("delete-branch.update-ref", cr, [...STEP, "update-ref", "--no-deref", "-d", "refs/heads/unmerged", c.oids.unmerged!], [0]);
  step("delete-branch.remove-section", cr, [...STEP, "config", "--local", "--remove-section", "branch.unmerged"], [0]);
  step("worktree-add.new", cr, [...STEP, "worktree", "add", "-b", "wt-new", "--", `${c.root}/wt-new`, c.oids.main!], [0]);
  step("worktree-add.existing", cr, [...STEP, "worktree", "add", "--", `${c.root}/wt-merged`, "merged"], [0]);
  step("worktree-remove", cr, [...STEP, "worktree", "remove", "--", `${c.root}/wt-new`], [0]);
  c.h.write(`${c.root}/wt-merged/untracked.txt`, "untracked\n");
  step("worktree-remove.force", cr, [...STEP, "worktree", "remove", "--force", "--", `${c.root}/wt-merged`], [0]);
  step("worktree-prune", cr, [...STEP, "worktree", "prune"], [0]);
  step("config-save.set", cr, [...STEP, "config", "set", "--local", "--", "user.name", "Fixture Name"], [0]);
  step("config-save.unset", cr, [...STEP, "config", "unset", "--local", "--", "user.name"], [0]);

  for (const [label, fixture, flags] of [
    ["merge", "merge-diverged", ["--no-log", "-m", "Edited message"]],
    ["merge.no-ff", "merge-ff", ["--no-ff", "--no-log", "-m", "Edited message"]],
    ["merge.no-commit", "merge-diverged", ["--no-commit", "--no-log", "-m", "Edited message"]],
    ["merge.no-ff-no-commit", "merge-ff", ["--no-ff", "--no-commit", "--no-log", "-m", "Edited message"]],
    ["merge.squash", "merge-diverged", ["--squash"]],
  ] as [string, WbFixtureName, string[]][]) {
    step(label, at(copy(w, fixture)), [...STEP, "merge", "--no-autostash", "--no-edit", ...flags, "--end-of-options", "refs/heads/topic"], [0]);
  }
  step("rebase.no-options", at(copy(w, "rebase-mix")), REBASE_UP, [0]);
  step("rebase.options", at(copy(w, "rebase-mix")), [...STEP, "rebase", "--autostash", "--autosquash", "--end-of-options", "refs/heads/up"], [0]);

  const k = at(copy(w, "conflict-merge"));
  step("choose-side.ours", k, [...STEP, "--literal-pathspecs", "checkout", "--no-recurse-submodules", "--ours", "--", "uu.txt"], [0]);
  step("choose-side.theirs", k, [...STEP, "--literal-pathspecs", "checkout", "--no-recurse-submodules", "--theirs", "--", "aa.txt"], [0]);
  step("mergetool", k, [...STEP, "--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", "uu.txt"], [0], { input: EMPTY, timeoutMs: MERGETOOL_MS });

  step("amend.commit", at(copy(w, "amend-on-upstream")), [...STEP, "commit", "--quiet", "--amend", "--file=-"], [0], { input: bytes("Amended message\n") });
  return [...o, ...colonPaths(w)];
}

// research.md R21 F1: plan.md D3 reads the in-the-way candidates with `check-ignore -z --stdin --no-index` without `--literal-pathspecs`.
// The ignore lines `:x.txt` and `:(top)y.txt` match only the literal names. A pathspec read of `:x.txt` or `:(top)y.txt` names `x.txt` or `y.txt`, which no line matches.
function colonPaths(w: WslHost): Observation[] {
  const f = copy(w, "switch-clean");
  const r = at(f);
  f.h.write(`${f.repo}/.gitignore`, "*.log\n:x.txt\n:(top)y.txt\n");
  for (const name of [":x.txt", ":(top)y.txt", "x.txt", "y.txt"]) f.h.write(`${f.repo}/${name}`, "x\n");
  const read = (input: string) => {
    const res = run(r, [...READ_IGNORE, "check-ignore", "-z", "--stdin", "--no-index"], { input: bytes(input) });
    return { exit: res.exitCode, paths: nul(text(res)) };
  };
  return [
    obs("F1.colon.literal-read", { exit: 0, paths: [":x.txt", ":(top)y.txt"] }, read(":x.txt\0:(top)y.txt\0")),
    obs("F1.colon.short-magic", { exit: 0, paths: [":x.txt"] }, read(":x.txt\0")),
    obs("F1.colon.long-magic", { exit: 0, paths: [":(top)y.txt"] }, read(":(top)y.txt\0")),
    obs("F1.colon.control-plain-names", { exit: 1, paths: [] }, read("x.txt\0y.txt\0")),
    ...COLON_FORMS.map(([label, input, expected]) => obs(`F1.colon.form.${label}`, expected, read(`${input}\0`))),
  ];
}

// The stdin forms that name a path with a leading `:` without magic, from gitglossary(7) "pathspec" and pathspec.c `parse_short_magic`, `init_pathspec_item`.
// A form without a leading `:` takes no magic. `:(top)` and `:/` allow only `top`, and the empty short magic ends at the second `:`.
// check-ignore prints `pathspec.items[i].original`, the stdin form (builtin/check-ignore.c), and refuses every magic except `top` with exit 128.
const COLON_FORMS: [string, string, { exit: number; paths: string[] }][] = [
  ["dot-slash", "./:x.txt", { exit: 0, paths: ["./:x.txt"] }],
  ["dot-slash-long-name", "./:(top)y.txt", { exit: 0, paths: ["./:(top)y.txt"] }],
  ["top-word", ":(top):x.txt", { exit: 0, paths: [":(top):x.txt"] }],
  ["top-word-long-name", ":(top):(top)y.txt", { exit: 0, paths: [":(top):(top)y.txt"] }],
  ["top-mnemonic", ":/::x.txt", { exit: 0, paths: [":/::x.txt"] }],
  ["empty-magic", ":::x.txt", { exit: 0, paths: [":::x.txt"] }],
  ["control-empty-magic-names-x", "::x.txt", { exit: 1, paths: [] }],
  ["control-literal-word-refused", ":(literal):x.txt", { exit: 128, paths: [] }],
];

function f2(w: WslHost): Observation[] {
  const o: Observation[] = [];
  const cases: [string, (f: DistroFixture) => string[]][] = [
    ["track", () => [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/one/topic", "--"]],
    ["start", (f) => [...STEP, "checkout", "--no-recurse-submodules", "-b", "topic", f.oids.target!, "--"]],
  ];
  for (const [label, args] of cases) {
    const f = copy(w, "switch-conflict");
    const r = at(f);
    const before = state(r);
    o.push(exitObs(`F2.${label}.exit`, "nonzero", run(r, args(f)).exitCode));
    o.push(obs(`F2.${label}.branch-exists-exit`, 2, run(r, [...READ, "show-ref", "--exists", "refs/heads/topic"]).exitCode));
    o.push(obs(`F2.${label}.changed`, [], changed(before, state(r))));
  }
  return o;
}

function f3(w: WslHost): Observation[] {
  const r = at(copy(w, "switch-conflict"));
  const before = state(r);
  return [exitObs("F3.exit", "nonzero", run(r, CHECKOUT_TARGET).exitCode), obs("F3.changed", [], changed(before, state(r)))];
}

// The plan.md D3 stash protocol observations.
function f4(w: WslHost): Observation[] {
  const protocol = (r: Repo, head: string) => {
    const p = stashValue(r);
    const exit = run(r, PUSH).exitCode;
    const s = stashValue(r);
    const created = s !== p;
    const label = (oid: string) => (created && oid === s ? "S" : oid === p ? "P" : "other");
    return { exit, created, reflog: stashReflog(r).slice(0, 2).map(label), parentIsHead: created ? out(r, ["rev-parse", `${s}^1`]).trim() === head : null };
  };
  const earlier = (r: Repo, n: number, apply: boolean) => {
    for (let i = 1; i <= n; i++) {
      gitRun(r.h, r.dir, [...STEP, "stash", "push", "--quiet", "-m", `earlier ${i}`]);
      if (apply) gitRun(r.h, r.dir, [...STEP, "stash", "apply", "--quiet", "--index", "stash@{0}"]);
    }
  };
  const o: Observation[] = [];
  for (const [label, fixture, n, apply, expected] of [
    ["none-earlier", "switch-dirty", 0, true, { exit: 0, created: true, reflog: ["S"], parentIsHead: true }],
    ["one-earlier", "switch-dirty", 1, true, { exit: 0, created: true, reflog: ["S", "P"], parentIsHead: true }],
    ["two-earlier", "switch-dirty", 2, true, { exit: 0, created: true, reflog: ["S", "P"], parentIsHead: true }],
    ["nothing", "switch-clean", 0, false, { exit: 0, created: false, reflog: [], parentIsHead: null }],
    ["nothing-one-earlier", "switch-dirty", 1, false, { exit: 0, created: false, reflog: ["P"], parentIsHead: null }],
  ] as [string, WbFixtureName, number, boolean, unknown][]) {
    const f = copy(w, fixture);
    const r = at(f);
    earlier(r, n, apply);
    o.push(obs(`F4.${label}`, expected, protocol(r, f.oids.base!)));
  }
  return o;
}

function f5(w: WslHost): Observation[] {
  const f = copy(w, "switch-clean");
  const r = at(f);
  f.h.write(`${f.repo}/a.txt`, "a staged\n");
  gitRun(f.h, f.repo, ["add", "--", "a.txt"]);
  gitRun(f.h, f.repo, PUSH);
  const s = stashValue(r)!;
  const checkout = run(r, CHECKOUT_TARGET).exitCode;
  const before = state(r);
  const apply = run(r, [...STEP, "stash", "apply", "--index", s]).exitCode;
  return [exitObs("F5.checkout", 0, checkout), exitObs("F5.apply-index.exit", "nonzero", apply), obs("F5.apply-index.changed", [], changed(before, state(r)))];
}

function f6(w: WslHost): Observation[] {
  const a = at(copy(w, "switch-dirty"));
  const push = run(a, PUSH).exitCode;
  const s = stashValue(a)!;
  const checkout = run(a, CHECKOUT_TARGET).exitCode;
  const n = stashReflog(a).indexOf(s);
  const drop = run(a, [...STEP, "stash", "drop", "--quiet", `stash@{${n}}`]).exitCode;
  const b = at(copy(w, "switch-dirty"));
  const force = run(b, [...STEP, "checkout", "--no-recurse-submodules", "--force", "target", "--"]).exitCode;
  const sa = state(a);
  return [
    obs("F6.exits", { push: 0, checkout: 0, drop: 0, force: 0 }, { push, checkout, drop, force }),
    obs("F6.differs-from-force", [], changed(sa, state(b))),
    obs("F6.untracked-kept", sha256(Buffer.from("notes\n")), (sa.files as Record<string, string>)["notes.txt"] ?? "absent"),
  ];
}

function f7(w: WslHost): Observation[] {
  const o: Observation[] = [];
  for (const [label, fixture, setup, stashFirst] of [
    ["untracked-file", "switch-untracked", null, false],
    ["ignored-file", "switch-ignored", null, false],
    ["folder-for-file", "switch-folder", null, false],
    ["file-for-folder", "switch-clean", (f: DistroFixture) => f.h.write(`${f.repo}/sub`, "sub file\n"), false],
    ["tracked-conflict", "switch-conflict", null, true],
    ["tracked-dirty", "switch-dirty", null, true],
  ] as [string, WbFixtureName, ((f: DistroFixture) => void) | null, boolean][]) {
    const f = copy(w, fixture);
    const r = at(f);
    setup?.(f);
    const found = inTheWay(r, f.oids.base!, f.oids.target!);
    const untrackedOnly = inTheWay(r, f.oids.base!, f.oids.target!, false);
    if (stashFirst) gitRun(f.h, f.repo, PUSH);
    const gitRefused = run(r, CHECKOUT_TARGET).exitCode !== 0;
    o.push(obs(`F7.${label}`, { refusedImpliesFound: true }, { gitRefused, found }, !gitRefused || found.length > 0));
    o.push(obs(`F7.${label}.index-entry-rule`, { foundEqualsRefused: true }, { gitRefused, found: untrackedOnly }, gitRefused === untrackedOnly.length > 0));
  }
  return o;
}

function f8(w: WslHost): Observation[] {
  const a = at(copy(w, "switch-clean"));
  const contract = run(a, [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/one/topic", "--"]).exitCode;
  const b = at(copy(w, "switch-clean"));
  const own = run(b, ["checkout", "--track", "one/topic"]).exitCode;
  const keys = (r: Repo) => text(run(r, ["config", "--local", "-z", "--get-regexp", "^branch\\.topic\\."]));
  return [obs("F8.exits", { contract: 0, own: 0 }, { contract, own }), obs("F8.branch-keys", keys(b), keys(a)), obs("F8.differs-from-own", [], changed(state(a), state(b)))];
}

function f9(w: WslHost): Observation[] {
  const view = (f: DistroFixture) => {
    const r = at(f);
    return {
      refs: refMap(f.h, f.repo),
      branchReflogExists: run(r, ["reflog", "exists", "refs/heads/unmerged"]).exitCode,
      headReflog: nul(out(r, [...READ, "log", "-g", "-z", "--format=%H", "HEAD", "--"])),
      config: fileDigest(r, localConfig(r)),
    };
  };
  const a = copy(w, "branches");
  const deleted = run(at(a), [...STEP, "update-ref", "--no-deref", "-d", "refs/heads/unmerged", a.oids.unmerged!]).exitCode;
  const section = run(at(a), [...STEP, "config", "--local", "--remove-section", "branch.unmerged"]).exitCode;
  const b = copy(w, "branches");
  const own = run(at(b), ["branch", "-D", "unmerged"]).exitCode;
  const c = copy(w, "branches");
  const before = state(at(c));
  const moved = run(at(c), [...STEP, "update-ref", "--no-deref", "-d", "refs/heads/unmerged", c.oids.main!]).exitCode;
  const [va, vb] = [view(a), view(b)];
  return [
    obs("F9.exits", { updateRef: 0, removeSection: 0, branchD: 0 }, { updateRef: deleted, removeSection: section, branchD: own }),
    obs("F9.refs", vb.refs, va.refs),
    obs("F9.branch-reflog-exists-exit", vb.branchReflogExists, va.branchReflogExists),
    obs("F9.head-reflog", vb.headReflog, va.headReflog),
    obs("F9.config-bytes", vb.config, va.config),
    exitObs("F9.moved.exit", "nonzero", moved),
    obs("F9.moved.changed", [], changed(before, state(at(c)))),
  ];
}

function f10(w: WslHost): Observation[] {
  const s = shared(w, "branches");
  const o: Observation[] = [];
  for (const name of ["unmerged", "merged", "held", "feature/a/b"]) {
    const counted = count(at(s), [s.refs[`refs/heads/${name}`]!, "--not", `--exclude=${name}`, "--branches", "--tags", "--remotes"]);
    const r = at(copy(w, "branches"));
    const before = reachable(r);
    gitRun(r.h, r.dir, ["branch", "-D", name]);
    const after = reachable(r);
    o.push(obs(`F10.${name}`, [...before].filter((x) => !after.has(x)).length, counted));
  }
  return o;
}

function f11(w: WslHost): Observation[] {
  const f = copy(w, "branches");
  const r = at(f);
  gitRun(f.h, f.repo, ["checkout", "-q", "merged", "--"]);
  gitRun(f.h, f.repo, ["checkout", "-q", "main", "--"]);
  const check = (name: string) => {
    const res = run(r, [...READ, "check-ref-format", "--branch", name]);
    return { exit: res.exitCode, stdout: text(res) };
  };
  const o: Observation[] = [];
  const exact = (kind: string, name: string, stdout: string) => ({ kind, name, expected: { exit: 0, stdout } as unknown, match: (c: { exit: number; stdout: string }) => same(c, { exit: 0, stdout }) });
  const cases = [
    ...["topic", "feature/x", "a.b"].map((name) => exact("valid", name, `${name}\n`)),
    ...["a..b", "-dash", "HEAD", "with space", "x.lock", "@", "a~b", "a/", "/a"].map((name) => ({ kind: "invalid", name, expected: { exit: "nonzero" } as unknown, match: (c: { exit: number }) => c.exit > 0 })),
    exact("previous", "@{-1}", "merged\n"),
  ];
  for (const { kind, name, expected, match } of cases) {
    const c = check(name);
    o.push(obs(`F11.${kind}.${name}`, expected, c, match(c)));
    const accepted = c.exit === 0 && c.stdout === `${name}\n`;
    const created = run(r, [...STEP, "branch", "--end-of-options", name, f.oids.main!]).exitCode === 0;
    o.push(obs(`F11.${kind}.${name}.d4-rule-vs-branch`, { d4Accepts: created }, { d4Accepts: accepted }));
  }
  return o;
}

function f12(w: WslHost): Observation[] {
  const o: Observation[] = [];
  const cases: [string, string | null, boolean, string, string, string][] = [
    ["main", null, false, "branch 'topic'", "topic", "refs/heads/topic"],
    ["main.merge-log", null, true, "branch 'topic'", "topic", "refs/heads/topic"],
    ["other", "other", false, "branch 'topic'", "topic", "refs/heads/topic"],
    ["other.merge-log", "other", true, "branch 'topic'", "topic", "refs/heads/topic"],
    ["main.remote-tracking", null, false, "remote-tracking branch 'origin/topic'", "origin/topic", "refs/remotes/origin/topic"],
  ];
  for (const [label, branch, log, source, short, ref] of cases) {
    const setup = () => {
      const f = copy(w, "merge-diverged");
      if (branch !== null) gitRun(f.h, f.repo, ["checkout", "-q", branch, "--"]);
      if (log) gitRun(f.h, f.repo, ["config", "merge.log", "true"]);
      return { f, r: at(f) };
    };
    const { f, r } = setup();
    const preview = out(r, [...READ, "fmt-merge-msg"], { input: bytes(`${f.oids.topic}\t\t${source} of .\n`) });
    gitRun(f.h, f.repo, ["merge", "--no-edit", short]);
    const own = message(r, "HEAD");
    const c = setup();
    gitRun(c.f.h, c.f.repo, [...STEP, "merge", "--no-autostash", "--no-edit", "--end-of-options", ref]);
    const m = setup();
    gitRun(m.f.h, m.f.repo, [...STEP, "merge", "--no-autostash", "--no-edit", "--no-log", "-m", preview, "--end-of-options", ref]);
    o.push(obs(`F12.${label}.git-merge`, own, preview));
    o.push(obs(`F12.${label}.contract-argv`, message(c.r, "HEAD"), preview));
    o.push(obs(`F12.${label}.preview-as-message`, own, message(m.r, "HEAD")));
  }
  return o;
}

function f13(w: WslHost): Observation[] {
  const s = shared(w, "rebase-mix");
  const sr = at(s);
  const up = s.oids.up!;
  const walk = [`${up}...HEAD`, "--right-only", "--cherry-pick", "--no-merges"];
  const counted = count(sr, walk);
  const rewritten = count(sr, [`${up}..HEAD`]);
  const notTracked = count(sr, [`${up}..HEAD`, "--not", "refs/remotes/origin/topic"]);
  const r = at(copy(w, "rebase-mix"));
  const exit = run(r, REBASE_UP).exitCode;
  const created = subjects(r, [`${up}..HEAD`]);
  return [exitObs("F13.exit", 0, exit), obs("F13.count", created.length, counted), obs("F13.subjects", created, subjects(sr, walk)), obs("F13.force-note", "record", { notTracked, rewritten }, true)];
}

function f14(w: WslHost): Observation[] {
  const f = copy(w, "rebase-mix");
  const r = at(f);
  f.h.write(`${f.repo}/f.txt`, "f changed\n");
  const before = state(r);
  return [exitObs("F14.exit", "nonzero", run(r, REBASE_UP).exitCode), obs("F14.changed", [], changed(before, state(r)))];
}

function f15(w: WslHost): Observation[] {
  const squashed = ["feature", "other"];
  const kept = ["feature", "other", "fixup! feature"];
  const o: Observation[] = [];
  for (const [label, config, flags, expected] of [
    ["config-only", ["-c", "rebase.autoSquash=true"], [], null],
    ["autosquash", [], ["--autosquash"], squashed],
    ["no-autosquash", [], ["--no-autosquash"], kept],
    ["config-and-no-autosquash", ["-c", "rebase.autoSquash=true"], ["--no-autosquash"], kept],
  ] as [string, string[], string[], string[] | null][]) {
    const f = copy(w, "rebase-fixup");
    const r = at(f);
    const exit = run(r, [...STEP, ...config, "rebase", "--no-autostash", ...flags, "--end-of-options", "refs/heads/up"]).exitCode;
    const observed = { exit, subjects: subjects(r, [`${f.oids.up}..HEAD`]) };
    o.push(expected === null ? obs(`F15.${label}`, "record", observed, exit === 0) : obs(`F15.${label}`, { exit: 0, subjects: expected }, observed));
  }
  return o;
}

function f16(w: WslHost): Observation[] {
  const s = shared(w, "rebase-update-refs");
  const listed = out(at(s), [...READ, "for-each-ref", "--merged=HEAD", `--no-merged=${s.oids.up}`, "--format=%(refname)", "refs/heads"]).split("\n").filter((l) => l !== "").sort();
  const r = at(copy(w, "rebase-update-refs"));
  const before = refMap(r.h, r.dir);
  const exit = run(r, REBASE_UP).exitCode;
  const after = refMap(r.h, r.dir);
  const moved = Object.keys(before).filter((k) => k.startsWith("refs/heads/") && before[k] !== after[k]).sort();
  const held = new Set(recordLines(out(at(s), ["worktree", "list", "--porcelain", "-z"])).slice(1).map((lines) => valueOf(lines, "branch")).filter((b): b is string => typeof b === "string"));
  return [exitObs("F16.exit", 0, exit), obs("F16.moved", moved, listed), obs("F16.moved-without-other-worktrees", moved, listed.filter((ref) => !held.has(ref)))];
}

function f17(w: WslHost): Observation[] {
  const o: Observation[] = [];
  for (const tagged of [false, true]) {
    const f = copy(w, "branches");
    const r = at(f);
    if (tagged) gitRun(f.h, f.repo, ["tag", "merged", f.oids.main!]);
    const path = `${f.root}/wt-f17`;
    const exit = run(r, [...STEP, "worktree", "add", "--", path, "merged"]).exitCode;
    const wt = at(f, path);
    const sym = run(wt, ["symbolic-ref", "-q", "HEAD"]);
    const observed = { exit, head: sym.exitCode === 0 ? text(sym).trim() : "detached", atBranch: out(wt, ["rev-parse", "HEAD"]).trim() === f.oids.second };
    o.push(obs(`F17.${tagged ? "tag-of-same-name" : "plain"}`, { exit: 0, head: "refs/heads/merged", atBranch: true }, observed));
  }
  return o;
}

function f18(w: WslHost): Observation[] {
  const f = copy(w, "worktrees");
  const r = at(f);
  const target = `${f.root}/wt with spaces`;
  const filter = canary(r, f.root, "f18-clean", "cat\n");
  const monitor = canary(r, f.root, "f18-fsmonitor", "exit 1\n");
  f.h.write(`${f.repo}/.git/info/attributes`, "* filter=f18\n");
  gitRun(f.h, f.repo, ["config", "filter.f18.clean", filter.command]);
  gitRun(f.h, f.repo, ["config", "core.fsmonitor", monitor.command]);
  // A new file time makes the status read compare the content through the clean filter.
  sh(w, "touch -d 2026-01-02T00:00:00Z -- w.txt", [], { cwd: target });
  const exit = run(r, [...STEP, "worktree", "remove", "--", target]).exitCode;
  const present = new Set(f.h.existing([filter.log, monitor.log, target]));
  return [obs("F18.remove", { exit: 0, filterRan: true, monitorRan: true, removed: true }, { exit, filterRan: present.has(filter.log), monitorRan: present.has(monitor.log), removed: !present.has(target) })];
}

function f19(w: WslHost): Observation[] {
  const o: Observation[] = [];
  for (const fixture of ["conflict-merge", "conflict-rebase"] as WbFixtureName[]) {
    const f = copy(w, fixture);
    const r = at(f);
    const indexLog = hookCanary(f, "post-index-change");
    const checkoutLog = hookCanary(f, "post-checkout");
    const before = indexDigest(r);
    const exit = run(r, [...STEP, "checkout", "--no-recurse-submodules", "--ours", "--", "uu.txt"]).exitCode;
    const observed = {
      exit,
      indexWritten: indexDigest(r) !== before,
      postIndexChange: logLines(r, indexLog).length > 0,
      postCheckoutFlag: logLines(r, checkoutLog).map((l) => l.split(" ").at(-1)),
      stages: stages(r, "uu.txt"),
      working: f.h.read(`${f.repo}/uu.txt`)?.toString("utf8") ?? null,
    };
    o.push(obs(`F19.${fixture}`, { exit: 0, indexWritten: true, postIndexChange: true, postCheckoutFlag: ["0"], stages: ["100644 1", "100644 2", "100644 3"], working: "uu ours\n" }, observed));
  }
  return o;
}

// The distro list holds Linux paths (plan.md D18).
function f20(w: WslHost): Observation[] {
  const f = shared(w, "worktrees");
  const raw = out(at(f), [...READ, "worktree", "list", "--porcelain", "-z"]);
  const records = recordLines(raw);
  const byPath = (rel: string) => records.find((lines) => lines[0] === `worktree ${f.root}/${rel}`) ?? null;
  const attrs = (rel: string) => byPath(rel)?.slice(1).map((l) => l.split(" ")[0]) ?? null;
  const locked = byPath("wt-locked-reason")?.find((l) => l.startsWith("locked")) ?? null;
  const prunable = byPath("wt-prunable")?.find((l) => l.startsWith("prunable")) ?? null;
  return [
    obs("F20.record-end", true, raw.endsWith("\0\0")),
    obs("F20.main-first", `worktree ${f.repo}`, records[0]?.[0] ?? null),
    obs("F20.spaces", ["HEAD", "branch"], attrs("wt with spaces")),
    obs("F20.locked-reason", "locked fixture reason\nwith newline", locked),
    obs("F20.locked-no-reason", ["HEAD", "branch", "locked"], byPath("wt-locked")?.slice(1).map((l) => (l.startsWith("locked") ? l : l.split(" ")[0])) ?? null),
    obs("F20.prunable", "prunable <reason>", prunable === null ? null : prunable.length > "prunable ".length && prunable.startsWith("prunable ") ? "prunable <reason>" : prunable),
    obs("F20.linux-paths", true, records.every((lines) => (lines[0] ?? "").startsWith(`worktree ${f.root}/`))),
  ];
}

function f21(w: WslHost): Observation[] {
  const mergetool = (r: Repo, config: string[], tool: string) => run(r, [...STEP, "--literal-pathspecs", ...config, "mergetool", `--tool=${tool}`, "--no-prompt", "--", "uu.txt"], { input: EMPTY, timeoutMs: MERGETOOL_MS }).exitCode;
  const a = copy(w, "conflict-merge");
  const ra = at(a);
  const fixtureExit = mergetool(ra, [], "fixture");
  const b = copy(w, "conflict-merge");
  const rb = at(b);
  const working = b.h.read(`${b.repo}/uu.txt`)!;
  // `true` leaves $MERGED unchanged, so Git's script asks on its standard input (git-mergetool--lib `check_unchanged`).
  const keepExit = mergetool(rb, ["-c", "mergetool.keep.cmd=true"], "keep");
  const keptWorking = b.h.read(`${b.repo}/uu.txt`)!.equals(working);
  // The fixture tool without `trustExitCode`. The tool command runs in a subshell of git-mergetool, so it sees `$BACKUP` (git-mergetool--lib.sh `merge_cmd`).
  // It records the file times and the `test -nt` result of that `/bin/sh`, which `check_unchanged` uses next.
  const c = copy(w, "conflict-merge");
  const rc = at(c);
  const original = c.h.read(`${c.repo}/uu.txt`)!;
  const log = `${c.root}/f21-times.log`;
  const timed = `'${mergeTool(w)}' "$MERGED"; /usr/bin/stat --format=%.9Y -- "$MERGED" "$BACKUP" > '${log}'; if test "$MERGED" -nt "$BACKUP"; then echo newer; else echo not-newer; fi >> '${log}'`;
  const timedExit = mergetool(rc, ["-c", `mergetool.timed.cmd=${timed}`, "-c", "mergetool.timed.trustExitCode=false"], "timed");
  const [mergedTime, backupTime, nt] = (c.h.read(log)?.toString("utf8") ?? "").split("\n");
  const timedWorking = c.h.read(`${c.repo}/uu.txt`)!;
  const times = { exit: timedExit, mergedTime, backupTime, test: nt, stages: stages(rc, "uu.txt"), working: timedWorking.equals(original) ? "original" : timedWorking.toString("utf8") === FIXTURE_MERGE_RESULT ? "tool-result" : "other" };
  // git-mergetool.sh `merge_file`: a failed `check_unchanged` moves `$BACKUP` over `$MERGED`. So `not-newer` gives exit 1, stages 1 to 3, and the original bytes.
  const consistent = nt === "newer" ? timedExit === 0 && times.working === "tool-result" : nt === "not-newer" && timedExit > 0 && times.working === "original" && same(times.stages, ["100644 1", "100644 2", "100644 3"]);
  return [
    obs("F21.untrusted-fixture-tool-times", "record", times, consistent),
    obs(
      "F21.fixture-tool",
      { exit: 0, stages: ["100644 0"], working: FIXTURE_MERGE_RESULT, backup: true },
      { exit: fixtureExit, stages: stages(ra, "uu.txt"), working: a.h.read(`${a.repo}/uu.txt`)?.toString("utf8") ?? null, backup: a.h.existing([`${a.repo}/uu.txt.orig`]).length === 1 },
    ),
    obs(
      "F21.unchanged-tool",
      { exit: "nonzero", stages: ["100644 1", "100644 2", "100644 3"], workingUnchanged: true },
      { exit: keepExit, stages: stages(rb, "uu.txt"), workingUnchanged: keptWorking },
      keepExit > 0 && same(stages(rb, "uu.txt"), ["100644 1", "100644 2", "100644 3"]) && keptWorking,
    ),
  ];
}

function f22(w: WslHost): Observation[] {
  const f = copy(w, "config-scopes");
  const r = at(f);
  const others = () => [`${f.root}/system.gitconfig`, `${f.root}/home/.gitconfig`, `${f.repo}/.git/included.gitconfig`, f.h.globalConfig].map((p) => fileDigest(r, p));
  const before = others();
  const set = run(r, [...STEP, "config", "set", "--local", "--", "user.name", "-value"]).exitCode;
  const value = text(run(r, ["config", "get", "--local", "user.name"]));
  const unset = run(r, [...STEP, "config", "unset", "--local", "--", "user.name"]).exitCode;
  const after = run(r, ["config", "get", "--local", "user.name"]).exitCode;
  return [obs("F22.set", { exit: 0, value: "-value\n", otherFilesUnchanged: true }, { exit: set, value, otherFilesUnchanged: same(before, others()) }), obs("F22.unset", { exit: 0, getExitAfter: 1 }, { exit: unset, getExitAfter: after })];
}

function f23(w: WslHost): Observation[] {
  const f = copy(w, "worktrees");
  const linked = at(f, `${f.root}/wt with spaces`);
  const path = out(linked, [...READ, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).trim();
  f.h.write(`${f.repo}/.git/info/exclude`, "f23-excluded.txt\n");
  f.h.write(`${linked.dir}/f23-excluded.txt`, "excluded\n");
  const ignored = run(linked, [...READ_IGNORE, "check-ignore", "-q", "--", "f23-excluded.txt"]).exitCode;
  return [obs("F23.path", "repo/.git/info/exclude", path.startsWith(`${f.root}/`) ? path.slice(f.root.length + 1) : path), obs("F23.check-ignore-exit", 0, ignored)];
}

// The merge tool names of the distro Git: the entries of `<exec path>/mergetools` (research.md R14).
function f24(w: WslHost): Observation[] {
  const f = shared(w, "branches");
  const r = at(f);
  const exec = out(r, ["--exec-path"]).trim();
  const listed = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/usr/bin/find", `${exec}/mergetools`, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0"]);
  const names = listed.exitCode === 0 ? nul(listed.stdout).sort() : null;
  return [obs("F24.mergetools-folder", "record", names, names !== null && names.length > 0), exitObs("F24.tool-help-exit", 0, run(r, ["mergetool", "--tool-help"]).exitCode)];
}

function f29(w: WslHost): Observation[] {
  const f = copy(w, "branches");
  const r = at(f);
  gitRun(f.h, f.repo, ["update-ref", "refs/heads/@", f.oids.second!]);
  const before = state(r);
  const exit = run(r, [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "@", "--"]).exitCode;
  const checkout = { exit, head: headOf(r), changed: changed(before, state(r)) };
  const path = `${f.root}/wt-f29`;
  const addExit = run(r, [...STEP, "worktree", "add", "--", path, "@"]).exitCode;
  const wt = at(f, path);
  const add = { exit: addExit, head: headOf(wt), atBranch: out(wt, ["rev-parse", "HEAD"]).trim() === f.oids.second };
  const g = copy(w, "branches");
  gitRun(g.h, g.repo, ["update-ref", "refs/heads/@", g.oids.second!]);
  const renameExit = run(at(g), [...STEP, "branch", "-m", "--end-of-options", "@", "from-at"]).exitCode;
  const refs = refMap(g.h, g.repo);
  const rename = { exit: renameExit, at: refs["refs/heads/@"] ?? null, renamed: refs["refs/heads/from-at"] === g.oids.second, main: refs["refs/heads/main"] === g.oids.main };
  return [
    obs("F29.checkout-at", { exit: 0, head: "refs/heads/main", changed: [] }, checkout),
    obs("F29.worktree-add-at", { exit: 0, head: "refs/heads/@", atBranch: true }, add),
    obs("F29.rename-from-at", { exit: 0, at: null, renamed: true, main: true }, rename),
  ];
}

function f30(w: WslHost): Observation[] {
  const given = "F30 explicit message";
  const squash = (withMessage: boolean) => {
    const f = copy(w, "merge-diverged");
    const r = at(f);
    const head = out(r, ["rev-parse", "HEAD"]).trim();
    const exit = run(r, [...STEP, "merge", "--no-autostash", "--no-edit", "--squash", ...(withMessage ? ["--no-log", "-m", given] : []), "--end-of-options", "refs/heads/topic"]).exitCode;
    const file = out(r, ["rev-parse", "--path-format=absolute", "--git-path", "SQUASH_MSG"]).trim();
    const squashMsg = f.h.read(file)?.toString("utf8") ?? null;
    return { r, exit, squashMsg, headMoved: out(r, ["rev-parse", "HEAD"]).trim() !== head };
  };
  const m = squash(true);
  const plain = squash(false);
  gitRun(m.r.h, m.r.dir, [...STEP, "commit", "--quiet", "--file=-"], { input: bytes("F30 commit box text\n") });
  return [
    exitObs("F30.squash-m-exit", 0, m.exit),
    obs("F30.squash-msg-holds-m", "record", m.squashMsg?.includes(given) ?? null, m.squashMsg !== null),
    obs("F30.squash-msg-equals-without-m", plain.squashMsg, m.squashMsg),
    obs("F30.head-moved", false, m.headMoved),
    obs("F30.later-commit-message", "F30 commit box text\n", message(m.r, "HEAD")),
  ];
}

// Every byte as a C octal escape, so no byte of the name ends or changes the line (builtin/hash-object.c `hash_stdin_paths`).
const cQuote = (p: string) => `"${[...Buffer.from(p, "utf8")].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("")}"`;
const hashPaths = (r: Repo, input: string) => {
  const res = run(r, [...READ, "hash-object", "--stdin-paths"], { input: bytes(input) });
  return { exit: res.exitCode, ids: text(res).split("\n").filter((l) => l !== "") };
};

function f31(w: WslHost): Observation[] {
  const f = copy(w, "branches");
  const r = at(f);
  const files: Record<string, string> = { ".gitattributes": "*.crlf eol=crlf\n", "x.crlf": "a\r\nb\r\n", "plain.txt": "plain\n", "with space.txt": "sp\n", " lead.txt": "lead\n" };
  for (const [rel, content] of Object.entries(files)) f.h.write(`${f.repo}/${rel}`, content);
  gitRun(f.h, f.repo, [...STEP, "--literal-pathspecs", "add", "--", ...Object.keys(files)]);
  const paths = ["x.crlf", "plain.txt", "with space.txt", " lead.txt"];
  const ids: Record<string, string> = {};
  for (const rec of nul(out(r, [...READ, "ls-files", "-z", "--stage", "--", ...paths]))) ids[rec.slice(rec.indexOf("\t") + 1)] = rec.split(" ")[1]!;
  const indexIds = paths.map((p) => ids[p] ?? null);
  const before = indexDigest(r);
  return [
    obs("F31.raw-lines", { exit: 0, ids: indexIds }, hashPaths(r, paths.map((p) => `${p}\n`).join(""))),
    obs("F31.quoted-lines", { exit: 0, ids: indexIds }, hashPaths(r, paths.map((p) => `${cQuote(p)}\n`).join(""))),
    obs("F31.cr-before-lf-stripped", { exit: 0, ids: [indexIds[1]] }, hashPaths(r, "plain.txt\r\n")),
    exitObs("F31.bad-quote", "nonzero", hashPaths(r, '"plain.txt\n').exit),
    obs("F31.index-unchanged", before, indexDigest(r)),
    ...f31Names(w),
  ];
}

// research.md R21 F31: NTFS cannot hold LF, CR, or tab in a name. The distro creates the names with `printf` octal escapes, and Git takes them on stdin, so no argument holds them.
function f31Names(w: WslHost): Observation[] {
  const f = copy(w, "branches");
  const r = at(f);
  const names = ["lf\nname.txt", "cr\rname.txt", "tab\tname.txt"];
  sh(w, 'for n in "lf\\012name.txt" "cr\\015name.txt" "tab\\011name.txt"; do p=$(printf "${n}X"); printf "%s\\n" "$n" > "${p%X}"; done', [], { cwd: f.repo });
  gitRun(f.h, f.repo, [...STEP, "--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: bytes(names.map((n) => `${n}\0`).join("")) });
  const ids: Record<string, string> = {};
  for (const rec of nul(out(r, [...READ, "ls-files", "-z", "--stage"]))) ids[rec.slice(rec.indexOf("\t") + 1)] = rec.split(" ")[1]!;
  const indexIds = names.map((n) => ids[n] ?? null);
  const before = indexDigest(r);
  return [
    obs("F31.names.added", true, indexIds.every((id) => id !== null)),
    obs("F31.names.quoted-lines", { exit: 0, ids: indexIds }, hashPaths(r, names.map((n) => `${cQuote(n)}\n`).join(""))),
    // A raw line cannot hold LF. A CR inside the line stays; only a CR before the LF goes.
    obs("F31.names.raw-cr-and-tab", { exit: 0, ids: indexIds.slice(1) }, hashPaths(r, names.slice(1).map((n) => `${n}\n`).join(""))),
    obs("F31.names.index-unchanged", before, indexDigest(r)),
  ];
}

const FACTS: [string, string, (w: WslHost) => Observation[]][] = [
  ["F1", "every contract argv is accepted, and a stdin path that starts with : in check-ignore", f1],
  ["F2", "a refused checkout -b creates no branch", f2],
  ["F3", "Keep changes with a conflicting change changes nothing", f3],
  ["F4", "the stash protocol observations", f4],
  ["F5", "a refused stash apply --index changes no file", f5],
  ["F6", "Discard through a stash equals checkout --force", f6],
  ["F7", "the in-the-way check finds each Git refusal", f7],
  ["F8", "the track checkout writes Git's branch keys", f8],
  ["F9", "update-ref -d and remove-section equal branch -D", f9],
  ["F10", "the unmerged count equals the lost commits", f10],
  ["F11", "check-ref-format --branch exit and output", f11],
  ["F12", "the fmt-merge-msg preview equals Git's merge message", f12],
  ["F13", "the moved count equals the created commits", f13],
  ["F14", "rebase --no-autostash with tracked changes changes nothing", f14],
  ["F15", "rebase.autoSquash in a non-interactive rebase", f15],
  ["F16", "the moved-branch list equals the update-refs moves", f16],
  ["F17", "worktree add checks out the branch", f17],
  ["F18", "worktree remove runs the filters and the monitor", f18],
  ["F19", "checkout --ours writes the index and runs post-index-change", f19],
  ["F20", "the worktree list -z grammar with Linux paths", f20],
  ["F21", "mergetool --no-prompt with empty standard input", f21],
  ["F22", "config set -- with a value that starts with a dash", f22],
  ["F23", "the info/exclude path in a linked worktree", f23],
  ["F24", "the merge tool names", f24],
  ["F29", "switch and worktree add with a branch named @", f29],
  ["F30", "merge --squash with --no-log -m", f30],
  ["F31", "hash-object --stdin-paths equals the index after git add, also for names with LF, CR, and tab", f31],
];

describe("Git facts F1 to F24 and F29 to F31 in the distro (T081, research.md R21)", () => {
  const versionOf = (w: WslHost) => `git=${(w.gitVersion ?? "unknown")}@${w.distro}`;
  for (const [id, title, fact] of FACTS) {
    wslTest(`${id} ${title}`, NEEDS, (w) => {
      hostOf(w);
      const observations = fact(w);
      expect(observations.length).toBeGreaterThan(0);
      for (const o of observations) console.log(observationLine(TASK, o, versionOf(w)));
    }, FACT_MS);
  }
});

// ---- Service cases (quickstart.md Q26) ----

// Commit object IDs differ by time, so each commit counts as its tree, its subject, and the shapes of its parents (plan.md D19).
function shapeState(r: Repo) {
  const reflog = stashReflog(r);
  const nodes = new Map<string, { tree: string; parents: string[]; subject: string }>();
  for (const line of out(r, ["log", "--topo-order", "--format=%H%x00%T%x00%P%x00%s", "--all", ...reflog, "--"]).split("\n")) {
    if (line === "") continue;
    const [oid, tree, parents, subject] = line.split("\0") as [string, string, string, string];
    nodes.set(oid, { tree, parents: parents === "" ? [] : parents.split(" "), subject });
  }
  const memo = new Map<string, string>();
  const shape = (oid: string): string => {
    const known = memo.get(oid);
    if (known !== undefined) return known;
    const n = nodes.get(oid);
    const value = n === undefined ? `object ${oid}` : sha256(Buffer.from(`${n.tree}\0${n.subject}\0${n.parents.map(shape).join(",")}`));
    memo.set(oid, value);
    return value;
  };
  const sym = run(r, ["symbolic-ref", "-q", "HEAD"]);
  const messages = gitPaths(r.h, r.dir, ["MERGE_MSG", "SQUASH_MSG", "MERGE_MODE"]).map((p) => r.h.read(p)?.toString("utf8") ?? null);
  return {
    head: sym.exitCode === 0 ? text(sym).trim() : "detached",
    headShape: shape(out(r, ["rev-parse", "HEAD"]).trim()),
    refs: Object.fromEntries(Object.entries(refMap(r.h, r.dir)).map(([ref, oid]) => [ref, shape(oid)])),
    stash: reflog.map(shape),
    index: stageEntries(r.h, r.dir),
    files: r.h.digests(r.dir),
    markers: markers(r.h, r.dir),
    messages,
    config: fileDigest(r, localConfig(r)),
  };
}

type Envelope = { repositoryId: string; repositoryGeneration?: number };
interface Reviewed {
  action: string;
  plan: Record<string, unknown>;
  workbenchToken: string;
  reason?: string;
}
type RunResult = Record<string, unknown> & { action: string; head?: { state: string; target?: string; oid?: string }; stash?: { oid: string | null; state: string } | null; staged?: boolean; operationState?: string; unmerged?: number };

const unavailable = (reason: string, extra: object = {}) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason, ...extra } });
const refusalOf = (r: ServiceResponse<unknown>) => ({ ...outcome(r), result: r.result });
const WITH_EFFECTS = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };

// One service session with the owned distro global file (BunRunnerOptions `wslGlobalConfig`). After the close, no scope of this process remains.
async function withWsl(w: WslHost, name: string, body: (s: Service) => Promise<void>): Promise<void> {
  const s = await openService({ git: gitExe(), name, environment: serviceEnv(), wslGlobalConfig: globalConfig(w) });
  try {
    await body(s);
  } finally {
    await s.dispose();
  }
  expect(listScopes(w)).toEqual([]);
}

const open = (s: Service, w: WslHost, dir: string): Promise<RegistrationResult> => s.register(uncPath(w, dir));
const request = <R>(s: Service, operation: string, payload: object, envelope: Envelope) => s.response<R>(s.send(operation, payload, envelope), RESPONSE_MS);

// A review from a fresh read, so the generation is current.
async function review(s: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<Reviewed>> {
  const read = await readOk(s, r.repositoryId);
  return request<Reviewed>(s, "reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
}
async function token(s: Service, r: RegistrationResult, payload: object): Promise<Reviewed> {
  const response = await review(s, r, payload);
  expect({ ...outcome(response), reason: response.result?.reason }).toEqual({ ...SUCCEEDED, reason: undefined });
  expect(typeof response.result!.workbenchToken).toBe("string");
  return response.result!;
}
const sendRun = (s: Service, r: RegistrationResult, workbenchToken: string) => s.send("runWorkbench", { workbenchToken, start: true }, { repositoryId: r.repositoryId });
const runToken = (s: Service, r: RegistrationResult, workbenchToken: string) => s.response<RunResult>(sendRun(s, r, workbenchToken), RESPONSE_MS);
const reviewRun = async (s: Service, r: RegistrationResult, payload: object) => runToken(s, r, (await token(s, r, payload)).workbenchToken);
const steps = (s: Service, from = 0, policies = ["integrate"]) => s.runner.calls.slice(from).filter((c) => policies.includes(c.environmentPolicy)).map((c) => [...c.arguments]);
const subcommands = (s: Service, from = 0) => steps(s, from).map((a) => a.slice(1, a[1] === "stash" ? 3 : 2).join(" "));
const confirms = (s: Service) => s.runner.frames.filter((f) => f.type === "confirm");
const own = (f: DistroFixture, args: string[], allowExit = [0], dir = f.repo) => gitRun(f.h, dir, args, { allowExit });
const switchTo = (choice: string, target: object = { ref: TARGET }) => ({ action: "switch", target, choice });

const W = (name: string, body: (w: WslHost) => Promise<void>) =>
  wslTest(
    name,
    NEEDS,
    (w) => {
      hostOf(w);
      return body(w);
    },
    CASE_MS,
  );

describe("switch through the distro Git (quickstart.md Q5 to Q8)", () => {
  W("Q5 SC-001: a clean and a dirty tree with Keep changes, Stash and reapply, and Discard changes equal the distro Git's own commands on a copy", async (w) => {
    const oracle: Record<string, string[][]> = {
      keep: [["checkout", "-q", "--no-guess", "target", "--"]],
      stash: [["stash", "push", "--quiet", "-m", MESSAGE], ["checkout", "-q", "--no-guess", "target", "--"], ["stash", "apply", "--index"], ["stash", "drop", "--quiet"]],
      discard: [["stash", "push", "--quiet", "-m", MESSAGE], ["checkout", "-q", "--no-guess", "target", "--"], ["stash", "drop", "--quiet"]],
    };
    const expected: Record<string, string[]> = { keep: ["checkout"], stash: ["stash push", "checkout", "stash apply", "stash drop"], discard: ["stash push", "checkout", "stash drop"] };
    for (const [fixture, choice] of [["switch-clean", "keep"], ["switch-dirty", "keep"], ["switch-dirty", "stash"], ["switch-dirty", "discard"]] as const) {
      const f = copy(w, fixture);
      const o = copy(w, fixture);
      await withWsl(w, `t081-switch-${fixture}-${choice}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, switchTo(choice));
        expect(rv.plan).toMatchObject({ target: { local: TARGET }, choice, inTheWay: null, unreachable: null, heldBy: null });
        const from = s.runner.calls.length;
        const response = await runToken(s, r, rv.workbenchToken);
        expect({ fixture, choice, ...outcome(response) }).toEqual({ fixture, choice, ...SUCCEEDED });
        expect(response.result).toMatchObject({ action: "switch", head: { state: "branch", target: TARGET, oid: f.oids.target } });
        expect(response.result!.stash?.state ?? null).toBe(choice === "keep" ? null : "dropped");
        expect(subcommands(s, from)).toEqual(expected[choice]!);
      });
      for (const args of oracle[choice]!) own(o, args);
      expect({ fixture, choice, state: shapeState(at(f)) }).toEqual({ fixture, choice, state: shapeState(at(o)) });
    }
  });

  W("Q6 FR-011: Keep changes with a conflicting change fails as the distro Git refuses and changes nothing; Discard with an untracked file in the way refuses before any Git step", async (w) => {
    const f = copy(w, "switch-conflict");
    const before = shapeState(at(f));
    const u = copy(w, "switch-untracked");
    u.h.write(`${u.repo}/b.txt`, "b changed\n");
    const untracked = shapeState(at(u));
    await withWsl(w, "t081-keep-conflict", async (s) => {
      const r = await open(s, w, f.repo);
      const response = await reviewRun(s, r, switchTo("keep"));
      expect(outcome(response)).toEqual({ state: "failed", code: "GIT_FAILED" });
      expect(response.result).toMatchObject({ action: "switch", head: { state: "branch", target: "refs/heads/main", oid: f.oids.base }, stash: null, conflicted: 0 });
      const ru = await open(s, w, u.repo);
      const from = s.runner.calls.length;
      expect(refusalOf(await review(s, ru, switchTo("discard")))).toEqual({ state: "failed", code: "UNTRACKED_IN_WAY", result: { reason: "untracked-in-way", paths: ["new.txt"], more: 0 } });
      expect(steps(s, from)).toEqual([]);
    });
    expect(shapeState(at(f))).toEqual(before);
    expect(shapeState(at(u))).toEqual(untracked);
  });

  W("Q7 FR-012: Stash and reapply with a reapply conflict keeps the stash and shows the unmerged entry; a failed checkout reapplies nothing; both equal the distro Git's own commands on a copy", async (w) => {
    const f = copy(w, "switch-conflict");
    const o = copy(w, "switch-conflict");
    const g = copy(w, "switch-untracked");
    const p = copy(w, "switch-untracked");
    for (const x of [g, p]) x.h.write(`${x.repo}/b.txt`, "b changed\n");
    await withWsl(w, "t081-reapply", async (s) => {
      const r = await open(s, w, f.repo);
      const from = s.runner.calls.length;
      const response = await reviewRun(s, r, switchTo("stash"));
      expect(outcome(response)).toEqual(WITH_EFFECTS);
      expect(subcommands(s, from)).toEqual(["stash push", "checkout", "stash apply"]);
      expect(response.result).toMatchObject({ head: { state: "branch", target: TARGET, oid: f.oids.target }, stash: { oid: stashValue(at(f)), state: "kept-conflicts" }, conflicted: 1 });
      const rg = await open(s, w, g.repo);
      const next = s.runner.calls.length;
      const failed = await reviewRun(s, rg, switchTo("stash"));
      expect(outcome(failed)).toEqual(WITH_EFFECTS);
      expect(subcommands(s, next)).toEqual(["stash push", "checkout"]);
      expect(failed.result).toMatchObject({ head: { state: "branch", target: "refs/heads/main", oid: g.oids.base }, stash: { oid: stashValue(at(g)), state: "kept-failed-checkout" }, conflicted: 0 });
      // Feature 003 contract Δ3 `reviewSync` and `clone`: a remedy is text only for a WSL Git, so the command is null.
      const remedy = (failed.result as { remedy?: { text: unknown; command: unknown } }).remedy;
      expect({ text: typeof remedy?.text, command: remedy?.command }).toEqual({ text: "string", command: null });
    });
    own(o, ["stash", "push", "--quiet", "-m", MESSAGE]);
    own(o, ["checkout", "-q", "--no-guess", "target", "--"]);
    own(o, ["stash", "apply", "--index", stashValue(at(o))!], [1]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
    own(p, ["stash", "push", "--quiet", "-m", MESSAGE]);
    own(p, ["checkout", "-q", "--no-guess", "target", "--"], [1]);
    expect(shapeState(at(g))).toEqual(shapeState(at(p)));
    expect(g.h.read(`${g.repo}/new.txt`)!.toString("utf8")).toBe("new local\n");
  });

  W("Q8 FR-013: a remote branch with one and zero mapping refspecs, a branch of another worktree with its Linux path, and a switch away from an unreachable detached commit", async (w) => {
    const f = copy(w, "switch-clean");
    const o = copy(w, "switch-clean");
    const z = copy(w, "switch-clean");
    const zero = shapeState(at(z));
    const b = shared(w, "branches");
    const holder = recordLines(out(at(b), ["worktree", "list", "--porcelain", "-z"])).find((lines) => lines.includes("branch refs/heads/wt-held"))!;
    expect(valueOf(holder, "worktree")).toBe(`${b.root}/wt-other`);
    await withWsl(w, "t081-track", async (s) => {
      const r = await open(s, w, f.repo);
      const from = s.runner.calls.length;
      expect(outcome(await reviewRun(s, r, switchTo("keep", { track: { ref: "refs/remotes/one/topic", name: "topic" } })))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([[L, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/one/topic", "--"]]);
      const rz = await open(s, w, z.repo);
      const next = s.runner.calls.length;
      expect(refusalOf(await review(s, rz, switchTo("keep", { track: { ref: "refs/remotes/zero/topic", name: "typed-zero" } })))).toEqual(unavailable("no-tracking-refspec"));
      expect(steps(s, next)).toEqual([]);
      const rb = await open(s, w, b.repo);
      expect(refusalOf(await review(s, rb, switchTo("keep", { ref: "refs/heads/wt-held" })))).toEqual(unavailable("other-worktree", { worktree: valueOf(holder, "worktree") }));
      const detached = await open(s, w, `${b.root}/wt-detached`);
      expect((await token(s, detached, switchTo("keep", { ref: "refs/heads/merged" }))).plan.unreachable).toBe(b.oids.unreachable!);
    });
    own(o, ["checkout", "-q", "-b", "topic", "--track", "one/topic", "--"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
    expect(shapeState(at(z))).toEqual(zero);
  });

  W("T034 Q8 FR-013 and 004 research.md R21 F8: a remote branch with two mapping refspecs tracks as the distro Git's own checkout --track on a copy", async (w) => {
    const f = copy(w, "switch-clean");
    const o = copy(w, "switch-clean");
    await withWsl(w, "t034-track-two", async (s) => {
      const r = await open(s, w, f.repo);
      const from = s.runner.calls.length;
      expect(outcome(await reviewRun(s, r, switchTo("keep", { track: { ref: "refs/remotes/two/x/topic", name: "typed-two" } })))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([[L, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "typed-two", "--track=direct", "refs/remotes/two/x/topic", "--"]]);
    });
    own(o, ["checkout", "-q", "-b", "typed-two", "--track", "two/x/topic", "--"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
  });
});

describe("branches, merge, and rebase through the distro Git (quickstart.md Q9 to Q12)", () => {
  W("Q9 FR-015 to FR-018: create with and without switch, rename, delete with the onlyHere count, and the current-branch refusal equal the distro Git's own commands on a copy", async (w) => {
    const f = copy(w, "branches");
    const o = copy(w, "branches");
    const start = f.oids.second!;
    // F10: the commits that Git's own branch -D makes unreachable.
    const c = copy(w, "branches");
    const before = reachable(at(c));
    own(c, ["branch", "-D", "--end-of-options", "feature/a/b"]);
    const after = reachable(at(c));
    const onlyHere = [...before].filter((x) => !after.has(x)).length;
    await withWsl(w, "t081-branches", async (s) => {
      const r = await open(s, w, f.repo);
      let from = s.runner.calls.length;
      expect(outcome(await reviewRun(s, r, { action: "create-branch", name: "new-a", start, switchTo: false }))).toEqual(SUCCEEDED);
      expect(outcome(await reviewRun(s, r, { action: "create-branch", name: "new-b", start, switchTo: true }))).toEqual(SUCCEEDED);
      expect(outcome(await reviewRun(s, r, { action: "rename-branch", ref: "refs/heads/unmerged", name: "renamed" }))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([
        [L, "branch", "--end-of-options", "new-a", start],
        [L, "checkout", "--no-recurse-submodules", "-b", "new-b", start, "--"],
        [L, "branch", "-m", "--end-of-options", "unmerged", "renamed"],
      ]);
      const rv = await token(s, r, { action: "delete-branch", ref: "refs/heads/feature/a/b" });
      expect(rv.plan).toMatchObject({ ref: "refs/heads/feature/a/b", oid: f.refs["refs/heads/feature/a/b"], onlyHere, heldBy: null, current: false });
      from = s.runner.calls.length;
      expect(outcome(await runToken(s, r, rv.workbenchToken))).toEqual(SUCCEEDED);
      expect(steps(s, from).map((a) => a[1])).toEqual(["update-ref"]);
      expect(refusalOf(await review(s, r, { action: "delete-branch", ref: "refs/heads/new-b" }))).toEqual(unavailable("current-branch"));
    });
    own(o, ["branch", "--end-of-options", "new-a", start]);
    own(o, ["checkout", "-q", "-b", "new-b", start, "--"]);
    own(o, ["branch", "-m", "--end-of-options", "unmerged", "renamed"]);
    own(o, ["branch", "-D", "--end-of-options", "feature/a/b"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
  });

  W("Q10 FR-021 to FR-023: Merge commit, a fast-forward, Squash, and a pre-merge-commit hook that rejects equal the distro Git's own merge on a copy", async (w) => {
    const MERGE = (o: object = {}) => ({ action: "merge", ref: "refs/heads/topic", result: "merge", noFastForward: false, noCommit: false, message: null, ...o });
    for (const [fixture, options, flags] of [["merge-diverged", {}, []], ["merge-ff", {}, []], ["merge-diverged", { result: "squash" }, ["--squash"]]] as [WbFixtureName, object, string[]][]) {
      const f = copy(w, fixture);
      const o = copy(w, fixture);
      await withWsl(w, `t081-merge-${fixture}-${flags.join("")}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, MERGE(options));
        const from = s.runner.calls.length;
        expect({ fixture, flags, ...outcome(await runToken(s, r, rv.workbenchToken)) }).toEqual({ fixture, flags, ...SUCCEEDED });
        const preview = rv.plan.preview as string | null;
        const message = flags.length > 0 ? [] : ["--no-log", "-m", preview!.replace(/\n$/, "")];
        expect(steps(s, from)).toEqual([[L, "merge", "--no-autostash", "--no-edit", ...flags, ...message, "--end-of-options", "refs/heads/topic"]]);
      });
      gitRun(o.h, o.repo, ["merge", "--no-edit", ...flags, "topic"]);
      expect({ fixture, flags, state: shapeState(at(f)) }).toEqual({ fixture, flags, state: shapeState(at(o)) });
    }
    // A repository hook is repository-controlled, so the merge asks once (plan.md D12).
    const f = copy(w, "merge-diverged");
    const o = copy(w, "merge-diverged");
    for (const x of [f, o]) x.h.write(`${x.repo}/.git/hooks/pre-merge-commit`, "#!/bin/sh\nexit 1\n");
    await withWsl(w, "t081-merge-hook", async (s) => {
      const r = await open(s, w, f.repo);
      expect(outcome(await review(s, r, MERGE()))).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(outcome(await s.approveTrust(r.repositoryId, "merge"))).toEqual(SUCCEEDED);
      expect(confirms(s).length).toBe(1);
      const response = await reviewRun(s, r, MERGE());
      expect({ ...outcome(response), operationState: response.result!.operationState }).toEqual({ ...WITH_EFFECTS, operationState: "merging" });
    });
    gitRun(o.h, o.repo, ["merge", "--no-edit", "topic"], { allowExit: [1] });
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
  });

  W("Q11 FR-024 to FR-027: rebase with patch-same commits, Autosquash, Autostash, and rebase.updateRefs equals the distro Git's own rebase on a copy; the plan counts equal Git's counts", async (w) => {
    const REBASE = (o: object = {}) => ({ action: "rebase", ref: "refs/heads/up", autostash: false, autosquash: false, ...o });
    const cases: [WbFixtureName, object, string[], ((x: DistroFixture) => void) | null][] = [
      ["rebase-mix", {}, ["--no-autostash", "--no-autosquash"], null],
      ["rebase-fixup", { autosquash: true }, ["--no-autostash", "--autosquash"], null],
      ["rebase-mix", { autostash: true }, ["--autostash", "--no-autosquash"], (x) => x.h.write(`${x.repo}/f.txt`, "f changed\n")],
      ["rebase-update-refs", {}, ["--no-autostash", "--no-autosquash"], null],
    ];
    for (const [fixture, options, flags, prepare] of cases) {
      const f = copy(w, fixture);
      const o = copy(w, fixture);
      prepare?.(f);
      prepare?.(o);
      const up = f.oids.up!;
      const movedBefore = refMap(o.h, o.repo);
      gitRun(o.h, o.repo, ["rebase", ...flags, "--end-of-options", "refs/heads/up"]);
      const created = subjects(at(o), [`${up}..HEAD`]).length;
      const movedAfter = refMap(o.h, o.repo);
      const movedRefs = Object.keys(movedBefore).filter((k) => k.startsWith("refs/heads/") && movedBefore[k] !== movedAfter[k]).sort();
      await withWsl(w, `t081-rebase-${fixture}-${flags.join("")}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, REBASE(options));
        // F13: the moved count equals the commits of Git's own rebase. F16: the moved-branch list leaves out the branch of another worktree.
        if (!("autosquash" in options)) expect({ fixture, moved: rv.plan.moved }).toEqual({ fixture, moved: created });
        if (fixture === "rebase-update-refs") expect(rv.plan.movedBranches).toEqual({ refs: movedRefs, more: 0 });
        const from = s.runner.calls.length;
        expect({ fixture, flags, ...outcome(await runToken(s, r, rv.workbenchToken)) }).toEqual({ fixture, flags, ...SUCCEEDED });
        expect(steps(s, from).filter((a) => a[1] === "rebase")).toEqual([[L, "rebase", ...flags, "--end-of-options", "refs/heads/up"]]);
      });
      expect({ fixture, flags, state: shapeState(at(f)) }).toEqual({ fixture, flags, state: shapeState(at(o)) });
    }
  });

  W("T034 Q9 FR-017 and FR-019: Delete of a branch that another worktree holds names its Linux path; a branch that moved after the review gives STALE_REVIEW before the run, update-ref refuses it during the run, and no ref changes", async (w) => {
    const b = copy(w, "branches");
    const holder = recordLines(out(at(b), ["worktree", "list", "--porcelain", "-z"])).find((lines) => lines.includes("branch refs/heads/wt-held"))!;
    const f = copy(w, "branches");
    const g = copy(w, "branches");
    const DELETE = { action: "delete-branch", ref: "refs/heads/unmerged" };
    await withWsl(w, "t034-delete", async (s) => {
      const rb = await open(s, w, b.repo);
      const held = shapeState(at(b));
      let from = s.runner.calls.length;
      expect(refusalOf(await review(s, rb, { action: "delete-branch", ref: "refs/heads/wt-held" }))).toEqual(unavailable("other-worktree", { worktree: valueOf(holder, "worktree") }));
      expect(steps(s, from)).toEqual([]);
      expect(shapeState(at(b))).toEqual(held);
      const r = await open(s, w, f.repo);
      const rv = await token(s, r, DELETE);
      own(f, ["update-ref", "refs/heads/unmerged", f.oids.tagged!]);
      const moved = shapeState(at(f));
      from = s.runner.calls.length;
      expect(outcome(await runToken(s, r, rv.workbenchToken))).toEqual({ state: "failed", code: "STALE_REVIEW" });
      expect(steps(s, from)).toEqual([]);
      expect(shapeState(at(f))).toEqual(moved);
      const rg = await open(s, w, g.repo);
      const during = await token(s, rg, DELETE);
      const release = s.runner.holdStart((c) => c.arguments[1] === "update-ref");
      from = s.runner.calls.length;
      const requestId = sendRun(s, rg, during.workbenchToken);
      await until(() => s.runner.calls.slice(from).some((c) => c.arguments[1] === "update-ref"), "the held update-ref", RESPONSE_MS);
      own(g, ["update-ref", "refs/heads/unmerged", g.oids.tagged!]);
      const external = shapeState(at(g));
      release();
      const response = await s.response<RunResult>(requestId, RESPONSE_MS);
      // The fresh reads see the external move as an effect, and `update-ref` exited nonzero, so the delete failed.
      expect({ ...outcome(response), refs: response.result!.refs }).toEqual({ ...WITH_EFFECTS, refs: [{ ref: "refs/heads/unmerged" }] });
      expect(s.runner.calls.slice(from).find((c) => c.arguments[1] === "update-ref")!.exit!.exitCode).not.toBe(0);
      expect(steps(s, from).map((a) => a[1])).toEqual(["update-ref"]);
      expect(shapeState(at(g))).toEqual(external);
    });
    expect(out(at(g), ["rev-parse", "--verify", "-q", "refs/heads/unmerged"]).trim()).toBe(g.oids.tagged!);
  });

  W("T034 Q10 FR-022 and SC-005: No fast-forward, Don't commit, both, and Squash of a fast-forward equal the distro Git's own merge with the same options on a copy", async (w) => {
    const MERGE = (o: object) => ({ action: "merge", ref: "refs/heads/topic", result: "merge", noFastForward: false, noCommit: false, message: null, ...o });
    // The T081 Q10 case runs Merge commit and Squash of `merge-diverged` and the fast-forward of `merge-ff`, so these complete the 004 combinations.
    const combinations: [WbFixtureName, object, string[]][] = [
      ["merge-diverged", { noFastForward: true }, ["--no-ff"]],
      ["merge-diverged", { noCommit: true }, ["--no-commit"]],
      ["merge-diverged", { noFastForward: true, noCommit: true }, ["--no-ff", "--no-commit"]],
      ["merge-ff", { noFastForward: true }, ["--no-ff"]],
      ["merge-ff", { noFastForward: true, noCommit: true }, ["--no-ff", "--no-commit"]],
      ["merge-ff", { result: "squash" }, ["--squash"]],
    ];
    for (const [fixture, options, flags] of combinations) {
      const label = `${fixture} ${flags.join(" ")}`;
      const f = copy(w, fixture);
      const o = copy(w, fixture);
      await withWsl(w, `t034-merge-${fixture}-${flags.join("")}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, MERGE(options));
        const from = s.runner.calls.length;
        expect({ label, ...outcome(await runToken(s, r, rv.workbenchToken)) }).toEqual({ label, ...SUCCEEDED });
        const message = flags.includes("--squash") ? [] : ["--no-log", "-m", (rv.plan.preview as string).replace(/\n$/, "")];
        expect({ label, steps: steps(s, from) }).toEqual({ label, steps: [[L, "merge", "--no-autostash", "--no-edit", ...flags, ...message, "--end-of-options", "refs/heads/topic"]] });
      });
      gitRun(o.h, o.repo, ["merge", "--no-edit", ...flags, "topic"]);
      expect({ label, state: shapeState(at(f)) }).toEqual({ label, state: shapeState(at(o)) });
    }
  });

  W("T034 Q11 FR-024: with a bare remote in the owned distro folder, the force note names the ref of the distro Git's own topic@{push}, the held count equals Git's counts, and the rebase equals Git's own rebase on a copy", async (w) => {
    const h = hostOf(w);
    const remote = `${h.root}/q11-origin-${crypto.randomUUID().slice(0, 8)}.git`;
    gitRun(h, h.root, ["init", "-q", "--bare", "--", remote]);
    const f = copy(w, "rebase-mix");
    const o = copy(w, "rebase-mix");
    // The fixture `origin` names a host that no test reaches. Both copies get the same bare remote, so their configuration bytes stay equal.
    for (const x of [f, o]) own(x, ["config", "--local", "remote.origin.url", remote]);
    own(f, ["push", "-q", remote, `${f.oids.empty}:refs/heads/topic`]);
    for (const x of [f, o]) own(x, ["fetch", "-q", "origin"]);
    const up = f.oids.up!;
    const trackingRef = out(at(o), ["rev-parse", "--symbolic-full-name", "topic@{push}"]).trim();
    const rewritten = count(at(o), [`${up}..HEAD`]);
    const held = rewritten - count(at(o), [`${up}..HEAD`, "--not", "--remotes"]);
    await withWsl(w, "t034-force-note", async (s) => {
      const r = await open(s, w, f.repo);
      const rv = await token(s, r, { action: "rebase", ref: "refs/heads/up", autostash: false, autosquash: false });
      expect({ forceNote: rv.plan.forceNote, rewritten: rv.plan.rewritten, held: rv.plan.held }).toEqual({ forceNote: { trackingRef }, rewritten, held });
      expect(outcome(await runToken(s, r, rv.workbenchToken))).toEqual(SUCCEEDED);
    });
    expect({ trackingRef, held: held > 0 }).toEqual({ trackingRef: "refs/remotes/origin/topic", held: true });
    own(o, ["rebase", "--no-autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
  });

  W("Q12 FR-023 and FR-027: a merge and a rebase that stop with conflicts; the 003 Abort, Skip, and Mark resolved with Continue finish them as the distro Git's own commands do", async (w) => {
    const h = hostOf(w);
    let n = 0;
    // The fact (l) history of feature 003: `up` changes `a.txt`, and `main` holds `step a` (`a.txt`) and `step b` (`b.txt`).
    const conflictRepo = (): string => {
      const repo = `${h.root}/q12-${++n}`;
      gitRun(h, h.root, ["init", "-q", "-b", "main", "--", repo]);
      for (const [key, value] of [["core.autocrlf", "false"], ["core.eol", "lf"], ["core.safecrlf", "false"]] as const) gitRun(h, repo, ["config", key, value]);
      importStream(h, repo, [
        fc({ mark: 1, message: "base\n", files: { "a.txt": "base\n" } }),
        fc({ mark: 2, ref: "refs/heads/up", message: "up\n", from: 1, files: { "a.txt": "up\n" } }),
        fc({ mark: 3, message: "step a\n", from: 1, files: { "a.txt": "topic\n" } }),
        fc({ mark: 4, message: "step b\n", from: 3, files: { "b.txt": "topic\n" } }),
      ]);
      gitRun(h, repo, ["reset", "-q", "--hard", "main"]);
      return repo;
    };
    const repoAt = (dir: string): Repo => ({ w, h, dir });
    const copyOf = (repo: string) => {
      const to = `${repo}-oracle`;
      h.copy(repo, to);
      gitRun(h, to, ["update-index", "-q", "--refresh"], { allowExit: ANY_EXIT });
      return to;
    };
    const label = (state: ReturnType<typeof shapeState>) => ({ ...state, files: { ...state.files, "a.txt": "label" } });
    for (const [kind, finish] of [["merge", "abort"], ["merge", "continue"], ["rebase", "abort"], ["rebase", "skip"], ["rebase", "continue"]] as const) {
      const repo = conflictRepo();
      const oracle = copyOf(repo);
      await withWsl(w, `t081-stop-${kind}-${finish}`, async (s) => {
        const r = await open(s, w, repo);
        const payload = kind === "merge" ? { action: "merge", ref: "refs/heads/up", result: "merge", noFastForward: false, noCommit: false, message: null } : { action: "rebase", ref: "refs/heads/up", autostash: false, autosquash: false };
        const stopped = await reviewRun(s, r, payload);
        expect({ kind, ...outcome(stopped), operationState: stopped.result!.operationState, unmerged: stopped.result!.unmerged }).toEqual({ kind, ...WITH_EFFECTS, operationState: kind === "merge" ? "merging" : "rebasing", unmerged: 1 });
        if (kind === "merge") gitRun(h, oracle, ["merge", "--no-edit", "up"], { allowExit: [1] });
        else gitRun(h, oracle, ["rebase", "--no-autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"], { allowExit: [1] });
        // Contract gap of T023: the full-ref merge argv labels the conflict side `refs/heads/up`, where Git's own `git merge up` writes `up`.
        expect({ kind, state: label(shapeState(repoAt(repo))) }).toEqual({ kind, state: label(shapeState(repoAt(oracle))) });
        if (finish === "continue") {
          h.write(`${repo}/a.txt`, "resolved\n");
          h.write(`${oracle}/a.txt`, "resolved\n");
          const c = await compare(s, r.repositoryId, "a.txt", "conflicted");
          const resolved = await request(s, "applyFile", { comparisonId: c.comparisonId, snapshotId: c.read.snapshotId, direction: "resolve" }, { repositoryId: r.repositoryId, repositoryGeneration: c.read.generation });
          expect(outcome(resolved)).toEqual(SUCCEEDED);
          gitRun(h, oracle, ["add", "--", "a.txt"]);
        }
        const read = await readOk(s, r.repositoryId);
        const reviewed = await s.response<{ syncReviewToken?: string }>(s.send("reviewSync", { action: finish }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation }), RESPONSE_MS);
        expect({ kind, finish, ...outcome(reviewed) }).toEqual({ kind, finish, ...SUCCEEDED });
        const done = await s.response(sendSync(s, { ...r, generation: read.generation }, reviewed.result!.syncReviewToken!), RESPONSE_MS);
        expect({ kind, finish, ...outcome(done) }).toEqual({ kind, finish, ...SUCCEEDED });
      });
      if (kind === "merge") gitRun(h, oracle, finish === "abort" ? ["merge", "--abort"] : ["commit", "--quiet"]);
      else gitRun(h, oracle, ["rebase", `--${finish}`], { allowExit: ANY_EXIT });
      expect({ kind, finish, state: shapeState(repoAt(repo)) }).toEqual({ kind, finish, state: shapeState(repoAt(oracle)) });
    }
  });
});

describe("conflict resolve and the merge tool through the distro Git (quickstart.md Q13, Q14, plan.md D18)", () => {
  // The shown read and one conflicted entry of it (contract Δ3).
  async function shown(s: Service, r: RegistrationResult, path: string) {
    const read = await readOk(s, r.repositoryId);
    const entry = read.entries.find((e) => e.path === path && e.category === "conflicted");
    expect({ path, listed: entry !== undefined }).toEqual({ path, listed: true });
    return { generation: read.generation, entry: { snapshotId: read.snapshotId, entryId: entry!.entryId } };
  }
  async function resolveReview(s: Service, r: RegistrationResult, path: string, payload: object) {
    const sel = await shown(s, r, path);
    return request<Reviewed>(s, "reviewWorkbench", { ...payload, ...sel.entry }, { repositoryId: r.repositoryId, repositoryGeneration: sel.generation });
  }
  async function resolveRun(s: Service, r: RegistrationResult, path: string, payload: object) {
    const response = await resolveReview(s, r, path, payload);
    expect({ path, ...outcome(response) }).toEqual({ path, ...SUCCEEDED });
    return { plan: response.result!.plan, done: await runToken(s, r, response.result!.workbenchToken) };
  }

  W("Q13 FR-089 to FR-096: Choose ours, Choose theirs, and Open in merge tool equal the distro Git's own checkout and mergetool on a copy; the merge tool runs under the mergetool policy", async (w) => {
    hostOf(w, "[merge]\n\ttool = fixture\n");
    const f = copy(w, "conflict-merge");
    const o = copy(w, "conflict-merge");
    const g = copy(w, "conflict-rebase");
    const p = copy(w, "conflict-rebase");
    await withWsl(w, "t081-resolve", async (s) => {
      const r = await open(s, w, f.repo);
      for (const [path, side] of [["uu.txt", "ours"], ["du.txt", "theirs"]] as const) {
        const from = s.runner.calls.length;
        const { done } = await resolveRun(s, r, path, { action: "choose-side", side });
        expect({ path, ...outcome(done), result: done.result }).toEqual({ path, ...SUCCEEDED, result: { action: "choose-side", staged: false, operationState: "merging" } });
        expect(steps(s, from)).toEqual([[L, "--literal-pathspecs", "checkout", "--no-recurse-submodules", `--${side}`, "--", path]]);
      }
      const from = s.runner.calls.length;
      const { plan, done } = await resolveRun(s, r, "aa.txt", { action: "mergetool" });
      expect(plan.tool).toMatchObject({ name: "fixture", scope: "global" });
      expect({ ...outcome(done), result: done.result }).toEqual({ ...SUCCEEDED, result: { action: "mergetool", staged: true, operationState: "merging" } });
      expect(steps(s, from, ["integrate", "mergetool"])).toEqual([[L, "--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", "aa.txt"]]);
      expect(s.runner.calls.slice(from).filter((c) => c.environmentPolicy === "mergetool").map((c) => c.input)).toEqual([undefined]);
      const rg = await open(s, w, g.repo);
      const { done: rebased } = await resolveRun(s, rg, "uu.txt", { action: "choose-side", side: "ours" });
      expect({ ...outcome(rebased), result: rebased.result }).toEqual({ ...SUCCEEDED, result: { action: "choose-side", staged: false, operationState: "rebasing" } });
    });
    own(o, ["--literal-pathspecs", "checkout", "--ours", "--", "uu.txt"]);
    own(o, ["--literal-pathspecs", "checkout", "--theirs", "--", "du.txt"]);
    gitRun(o.h, o.repo, ["--literal-pathspecs", "mergetool", "--tool=fixture", "--no-prompt", "--", "aa.txt"], { input: EMPTY, timeoutMs: MERGETOOL_MS });
    own(p, ["--literal-pathspecs", "checkout", "--ours", "--", "uu.txt"]);
    expect(shapeState(at(f))).toEqual(shapeState(at(o)));
    expect(shapeState(at(g))).toEqual(shapeState(at(p)));
    expect(f.h.read(`${f.repo}/aa.txt`)!.toString("utf8")).toBe(FIXTURE_MERGE_RESULT);
  });

  W("T034 Q13 FR-089 to FR-092: AU, UA, UD, DD, and the link stage give their kinds, plans, and refusals; Choose ours and Choose theirs equal the distro Git's own checkout on a copy and keep each path unmerged", async (w) => {
    // The entries of `buildConflict` with their porcelain v2 XY code and the data-model §11 text.
    const KINDS: Record<string, [string, string]> = { "uu.txt": ["UU", "Both modified"], "aa.txt": ["AA", "Both added"], "au.txt": ["AU", "Added by us"], "ua.txt": ["UA", "Added by them"], "du.txt": ["DU", "Deleted by us"], "ud.txt": ["UD", "Deleted by them"], "dd.txt": ["DD", "Both deleted"], link: ["UU", "Both modified"] };
    for (const side of ["ours", "theirs"] as const) {
      const f = copy(w, "conflict-merge");
      const o = copy(w, "conflict-merge");
      const stagesOf = (path: string) => stageEntries(f.h, f.repo, [path]).map((e) => ({ stage: e.stage, mode: e.mode, oid: e.oid }));
      const names = { ours: { oid: out(at(f), ["rev-parse", "main"]).trim(), refs: ["refs/heads/main"] }, theirs: { oid: out(at(f), ["rev-parse", "topic"]).trim(), refs: ["refs/heads/topic"] } };
      const ran: string[] = [];
      await withWsl(w, `t034-choose-${side}`, async (s) => {
        const r = await open(s, w, f.repo);
        for (const [path, [xy, kind]] of Object.entries(KINDS)) {
          const stages = stagesOf(path);
          const response = await resolveReview(s, r, path, { action: "choose-side", side });
          // FR-092: a link stage is no regular file, so the copy gets no command.
          if (path === "link") {
            expect({ path, ...refusalOf(response) }).toEqual({ path, ...unavailable("side-not-regular", { names }) });
            continue;
          }
          // Git's own command on the copy decides whether the side exists.
          if (run(at(o), ["--literal-pathspecs", "checkout", `--${side}`, "--", path]).exitCode !== 0) {
            expect({ path, ...refusalOf(response) }).toEqual({ path, ...unavailable("side-missing", { names }) });
            continue;
          }
          expect({ path, ...outcome(response) }).toEqual({ path, ...SUCCEEDED });
          expect(response.result!.plan).toEqual({ path: Buffer.from(path).toString("base64"), kind: { xy, text: kind }, stages, names, operation: "merging", side });
          const from = s.runner.calls.length;
          const done = await runToken(s, r, response.result!.workbenchToken);
          expect({ path, ...outcome(done), result: done.result }).toEqual({ path, ...SUCCEEDED, result: { action: "choose-side", staged: false, operationState: "merging" } });
          expect(steps(s, from)).toEqual([[L, "--literal-pathspecs", "checkout", "--no-recurse-submodules", `--${side}`, "--", path]]);
          expect(stagesOf(path)).toEqual(stages);
          ran.push(path);
        }
      });
      expect(ran).toEqual(side === "ours" ? ["uu.txt", "aa.txt", "au.txt", "ud.txt"] : ["uu.txt", "aa.txt", "ua.txt", "du.txt"]);
      expect({ side, state: shapeState(at(f)) }).toEqual({ side, state: shapeState(at(o)) });
    }
  });

  W("Q14 FR-097: a merge tool from the repository scope in an untrusted repository gives TRUST_REQUIRED before any Git process of the action, and the canary does not run", async (w) => {
    const f = copy(w, "conflict-merge");
    const tool = canary(at(f), f.root, "repository-tool");
    own(f, ["config", "--local", "merge.tool", "repository"]);
    own(f, ["config", "--local", "mergetool.repository.cmd", `${tool.command} "$MERGED"`]);
    await withWsl(w, "t081-repository-tool", async (s) => {
      const r = await open(s, w, f.repo);
      expect((await s.readTrust(r.repositoryId)).result!.approvalRequired).toEqual({ reads: false, commit: false, sync: false, workbench: false, mergetool: true });
      const sel = await shown(s, r, "uu.txt");
      const from = s.runner.calls.length;
      const response = await request(s, "reviewWorkbench", { action: "mergetool", ...sel.entry }, { repositoryId: r.repositoryId, repositoryGeneration: sel.generation });
      expect(outcome(response)).toEqual({ state: "failed", code: "TRUST_REQUIRED" });
      expect(s.runner.calls.slice(from).map((c) => c.arguments.find((a) => !a.startsWith("-")))).not.toContain("ls-files");
      expect(steps(s, from, ["integrate", "mergetool"])).toEqual([]);
      expect(confirms(s)).toEqual([]);
    });
    expect(f.h.existing([tool.log])).toEqual([]);
  });

  W("plan.md D18: a merge tool that needs a terminal ends at once, because setsid --wait removes the terminal; the path stays unmerged", async (w) => {
    const f = copy(w, "conflict-merge");
    const log = `${f.root}/tty.log`;
    // The tool opens /dev/tty and records the exit status of that open. Its program lies outside the repository, so it needs no approval (plan.md D12).
    const tool = `${w.folder}/home/tty-tool.sh`;
    const h = hostOf(w, `[merge]\n\ttool = tty\n[mergetool "tty"]\n\tcmd = '${tool}'\n`);
    h.write(tool, `#!/bin/sh\n( : </dev/tty ) 2>/dev/null\nprintf 'tty=%s\\n' "$?" > '${log}'\n`);
    const index = stageEntries(f.h, f.repo);
    await withWsl(w, "t081-tty-tool", async (s) => {
      const r = await open(s, w, f.repo);
      const { done } = await resolveRun(s, r, "uu.txt", { action: "mergetool" });
      // FR-096: the exit code decides nothing. The fresh read says Git staged nothing.
      expect({ ...outcome(done), staged: done.result?.staged }).toEqual({ state: "failed", code: "GIT_FAILED", staged: false });
    });
    const tty = f.h.read(log)?.toString("utf8") ?? null;
    console.log(`OBSERVATION ${TASK}: D18.tty-open expected="tty=<nonzero>" observed=${JSON.stringify(tty).replaceAll(" ", "\\u0020")} match=${tty !== null && /^tty=[1-9][0-9]*\n$/.test(tty)} git=${w.gitVersion}@${w.distro}`);
    expect(tty).toMatch(/^tty=[1-9][0-9]*\n$/);
    expect(stageEntries(f.h, f.repo)).toEqual(index);
  });

  for (const ending of ["cancel", "close"] as const) {
    W(`FR-095 and contract §11: after ${ending === "cancel" ? "Cancel" : "a simulated close"} while the merge tool runs, pgrep finds no tool process, no arbareto-* scope remains, and the path stays unmerged`, async (w) => {
      const f = copy(w, "conflict-merge");
      const pattern = `sleep 300 0.${crypto.getRandomValues(new Uint32Array(1))[0]}`;
      // `exec` replaces the script command line, so the `sleep` arguments carry the pattern.
      const tool = `${w.folder}/home/block-tool.sh`;
      const h = hostOf(w, `[merge]\n\ttool = block\n[mergetool "block"]\n\tcmd = '${tool}'\n`);
      h.write(tool, `#!/bin/sh\nexec ${pattern}\n`);
      const index = stageEntries(f.h, f.repo);
      const s = await openService({ git: gitExe(), name: `t081-block-${ending}`, environment: serviceEnv(), wslGlobalConfig: globalConfig(w) });
      try {
        const r = await open(s, w, f.repo);
        const reviewed = await resolveReview(s, r, "uu.txt", { action: "mergetool" });
        expect(outcome(reviewed)).toEqual(SUCCEEDED);
        const requestId = sendRun(s, r, reviewed.result!.workbenchToken);
        const operationId = await s.operationId(requestId);
        const deadline = Date.now() + 60_000;
        while (pgrep(w, pattern).length === 0) {
          if (Date.now() > deadline) throw new Error("the merge tool start: not within 60000 ms");
          await Bun.sleep(200);
        }
        expect(s.progress.filter((e) => (e as { operationId?: string }).operationId === operationId).map((e) => (e as { phase?: string }).phase)).toContain("mergetool");
        if (ending === "cancel") {
          await s.cancel(operationId);
          const done = await s.response<RunResult>(requestId, RESPONSE_MS);
          expect({ ...outcome(done), staged: done.result?.staged }).toEqual({ state: "canceled", code: "CANCELED", staged: false });
        } else s.runner.failService();
        await Bun.sleep(AFTER_CLOSE_MS);
        expect(pgrep(w, pattern)).toEqual([]);
        expect(pgrep(w, operationId)).toEqual([]);
        expect(listScopes(w)).toEqual([]);
      } finally {
        await s.dispose();
      }
      expect(listScopes(w)).toEqual([]);
      expect(stageEntries(f.h, f.repo)).toEqual(index);
    });
  }
});

describe("staging through the distro Git (quickstart.md Q15, Q16, Q19)", () => {
  async function allEntries(s: Service, repositoryId: string, read: WorkspaceResult): Promise<ChangeEntry[]> {
    const entries = [...read.entries];
    for (let cursor = read.cursor; cursor !== null; ) {
      const page = await s.readEntries(repositoryId, read.generation, read.snapshotId, cursor);
      expect(["succeeded", "limited"]).toContain(page.state);
      entries.push(...page.result!.entries);
      cursor = page.result!.cursor;
    }
    return entries;
  }
  const applyFiles = (s: Service, repositoryId: string, read: WorkspaceResult, ids: readonly string[], direction: Direction, kind: string, folder?: string) =>
    s.response(s.send("applyFiles", { snapshotId: read.snapshotId, entryIds: ids, direction, kind, ...(folder === undefined ? {} : { folder: Buffer.from(folder).toString("base64") }) }, { repositoryId }), RESPONSE_MS);

  W("Q15 FR-034 to FR-040: Stage selected, Stage all untracked, and Unstage all equal the distro Git's add and reset of the same paths, and every working byte stays", async (w) => {
    const cases: [string, Direction, string, (e: ChangeEntry) => boolean, string[], boolean][] = [
      ["selected", "stage", "selected", (e) => (e.category === "unstaged" && ["src/a.txt", "docs/d.txt"].includes(e.path)) || (e.category === "untracked" && e.path === "top-new.txt"), ["add", "--", "src/a.txt", "docs/d.txt", "top-new.txt"], false],
      ["all-untracked", "stage", "all-untracked", (e) => e.category === "untracked", ["add", "--", "src/lib/new.txt", "src/new-dir/n1.txt", "src/new-dir/n2.txt", "top-new.txt"], false],
      ["all-staged", "unstage", "all-staged", (e) => e.category === "staged", ["reset", "-q"], true],
    ];
    for (const [label, direction, kind, choose, oracle, addFirst] of cases) {
      const f = copy(w, "staging-tree");
      const o = copy(w, "staging-tree");
      for (const x of [f, o]) x.h.write(`${x.repo}/${XDG_IGNORED}`, "ignored by the owned home\n");
      if (addFirst) for (const x of [f, o]) own(x, ["add", "-A"]);
      const files = f.h.digests(f.repo);
      // git-status(1) porcelain v2: `? <path>` is an untracked record.
      const untracked = nul(out(at(o), ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"])).filter((rec) => rec.startsWith("? ")).map((rec) => rec.slice(2)).sort();
      expect(untracked).not.toContain(XDG_IGNORED);
      await withWsl(w, `t081-files-${label}`, async (s) => {
        const r = await open(s, w, f.repo);
        const read = await readOk(s, r.repositoryId);
        const entries = await allEntries(s, r.repositoryId, read);
        expect({ label, untracked: entries.filter((e) => e.category === "untracked").map((e) => e.path).sort() }).toEqual({ label, untracked });
        const chosen = entries.filter(choose);
        expect(chosen.length).toBeGreaterThan(0);
        const response = await applyFiles(s, r.repositoryId, read, chosen.map((e) => e.entryId), direction, kind);
        expect({ label, ...outcome(response) }).toEqual({ label, ...SUCCEEDED });
      });
      own(o, oracle);
      expect({ label, index: stageEntries(f.h, f.repo) }).toEqual({ label, index: stageEntries(o.h, o.repo) });
      expect({ label, files: f.h.digests(f.repo) }).toEqual({ label, files });
    }
  });

  // The owned candidate files of the multi-file publication (004 plan.md O-17) in the Git folder of the main worktree.
  const candidates = (f: DistroFixture) => nul(sh(f.w, 'for p in "$1"/arbareto-candidate-*; do [ -e "$p" ] && printf "%s\\0" "$p"; done; exit 0', [`${f.repo}/.git`]).stdout);
  const UNDER = ["src/a.txt", "src/lib/deep/c.txt", "src/lib/new.txt", "src/new-dir/n1.txt", "src/new-dir/n2.txt"];

  W("T034 Q15 FR-034 to FR-036: Stage folder, Stage all changes, and Unstage folder equal the distro Git's add and reset of the same paths, and every working byte stays", async (w) => {
    const cases: [string, Direction, string, (e: ChangeEntry) => boolean, string[], boolean][] = [
      ["stage folder", "stage", "folder", (e) => e.category !== "staged" && UNDER.includes(e.path), ["add", "--", ...UNDER], false],
      ["stage all changes", "stage", "all-changes", (e) => e.category !== "staged", ["add", "-A"], false],
      ["unstage folder", "unstage", "folder", (e) => e.category === "staged" && UNDER.includes(e.path), ["reset", "-q", "--", ...UNDER], true],
    ];
    for (const [label, direction, kind, choose, oracle, addFirst] of cases) {
      const f = copy(w, "staging-tree");
      const o = copy(w, "staging-tree");
      if (addFirst) for (const x of [f, o]) own(x, ["add", "-A"]);
      const files = f.h.digests(f.repo);
      await withWsl(w, `t034-files-${label.replaceAll(" ", "-")}`, async (s) => {
        const r = await open(s, w, f.repo);
        const read = await readOk(s, r.repositoryId);
        const chosen = (await allEntries(s, r.repositoryId, read)).filter(choose);
        expect({ label, paths: [...new Set(chosen.map((e) => e.path))].sort() }).toEqual({ label, paths: kind === "folder" ? UNDER : expect.any(Array) });
        const response = await applyFiles(s, r.repositoryId, read, chosen.map((e) => e.entryId), direction, kind, kind === "folder" ? "src" : undefined);
        expect({ label, ...outcome(response) }).toEqual({ label, ...SUCCEEDED });
      });
      own(o, oracle);
      expect({ label, index: stageEntries(f.h, f.repo) }).toEqual({ label, index: stageEntries(o.h, o.repo) });
      expect({ label, files: f.h.digests(f.repo) }).toEqual({ label, files });
      expect(candidates(f)).toEqual([]);
    }
  });

  W("T034 Q15 FR-038 to FR-040: one refused file refuses the whole set with its entry and reason; a change of the set after step 5 gives STALE_SELECTION; neither publishes anything", async (w) => {
    const f = copy(w, "staging-tree");
    // git-add(1) `-N`: an intent-to-add entry, which the 001 decision refuses with reason `index-flag`.
    own(f, ["add", "-N", "--", "top-new.txt"]);
    const g = copy(w, "staging-tree");
    let fire = false;
    const hunkCheckpoint = (c: HunkCheckpoint) => {
      if (fire && c.step === 5) {
        fire = false;
        g.h.write(`${g.repo}/top-new.txt`, "changed during staging\n");
      }
    };
    const s = await openService({ git: gitExe(), name: "t034-set-refusals", environment: serviceEnv(), wslGlobalConfig: globalConfig(w), hunkCheckpoint });
    try {
      const r = await open(s, w, f.repo);
      const read = await readOk(s, r.repositoryId);
      const entries = await allEntries(s, r.repositoryId, read);
      const pick = (category: string, path: string) => entries.find((e) => e.category === category && e.path === path)!;
      const ita = pick("unstaged", "top-new.txt");
      const before = { index: indexDigest(at(f)), files: f.h.digests(f.repo) };
      const response = await applyFiles(s, r.repositoryId, read, [pick("unstaged", "src/a.txt").entryId, ita.entryId], "stage", "selected");
      expect({ ...outcome(response), reason: (response.result as { reason?: string }).reason, entryId: (response.result as { entryId?: string }).entryId }).toEqual({ state: "rejected", code: "UNSUPPORTED_COMPARISON", reason: "index-flag", entryId: ita.entryId });
      expect(s.runner.calls.filter((c) => c.operationId === response.operationId && subcommand(c.arguments) === "update-index")).toEqual([]);
      expect({ index: indexDigest(at(f)), files: f.h.digests(f.repo), candidates: candidates(f) }).toEqual({ ...before, candidates: [] });

      const rg = await open(s, w, g.repo);
      const gRead = await readOk(s, rg.repositoryId);
      const gEntries = await allEntries(s, rg.repositoryId, gRead);
      const ids = [gEntries.find((e) => e.category === "unstaged" && e.path === "src/a.txt")!, gEntries.find((e) => e.category === "untracked" && e.path === "top-new.txt")!].map((e) => e.entryId);
      const index = indexDigest(at(g));
      fire = true;
      const stale = await applyFiles(s, rg.repositoryId, gRead, ids, "stage", "selected");
      expect(outcome(stale)).toEqual({ state: "failed", code: "STALE_SELECTION" });
      expect({ index: indexDigest(at(g)), candidates: candidates(g), changed: g.h.read(`${g.repo}/top-new.txt`)!.toString("utf8") }).toEqual({ index, candidates: [], changed: "changed during staging\n" });
      expect(out(at(g), ["show", ":src/a.txt"])).toBe(out(at(g), ["show", "HEAD:src/a.txt"]));
    } finally {
      await s.dispose();
    }
    expect(listScopes(w)).toEqual([]);
  });

  // One hunk: its header values and its body lines without LF.
  function hunkOf(c: Comparison) {
    const all = hunksOf(patchOf(resultOf(c)));
    expect(all.length).toBe(1);
    const rows = all[0]!.split("\n");
    if (rows.at(-1) === "") rows.pop();
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[0]!)!;
    return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), body: rows.slice(1) };
  }
  // Research.md R11, as `tests/git/line-stage.test.ts` states it.
  function expectedContent(base: Buffer, h: ReturnType<typeof hunkOf>, picked: number[], direction: Direction): Buffer {
    const lines = base.toString("latin1").split(/(?<=\n)/);
    const [start, n] = direction === "stage" ? [h.oldStart, h.oldCount] : [h.newStart, h.newCount];
    const from = n === 0 ? start : start - 1;
    const region: string[] = [];
    h.body.forEach((line, i) => {
      const kind = line[0];
      const chosen = picked.includes(i + 1);
      if (kind === " ") region.push(`${line.slice(1)}\n`);
      else if (direction === "stage" ? (kind === "-" ? !chosen : chosen) : kind === "+" ? !chosen : chosen) region.push(`${line.slice(1)}\n`);
    });
    return Buffer.from([...lines.slice(0, from), ...region, ...lines.slice(from + n)].join(""), "latin1");
  }

  W("Q16 FR-041 to FR-044: staging and unstaging selected lines of the mixed hunk gives the expected index blob through the distro Git, and the working file stays", async (w) => {
    const f = copy(w, "staging-hunks");
    const r = at(f);
    const blob = (path: string) => stageEntries(f.h, f.repo, [path]).find((e) => e.stage === 0)?.oid ?? null;
    const content = (oid: string) => gitRun(f.h, f.repo, ["cat-file", "blob", oid]).stdout;
    const files = f.h.digests(f.repo);
    await withWsl(w, "t081-lines", async (s) => {
      const reg = await open(s, w, f.repo);
      for (const [direction, category] of [["stage", "unstaged"], ["unstage", "staged"]] as const) {
        if (direction === "unstage") own(f, ["add", "--", "mixed.txt"]);
        const c = await selectHunks(s, reg.repositoryId, "mixed.txt", category);
        const h = hunkOf(c);
        const changes = h.body.flatMap((line, i) => (line[0] === "+" || line[0] === "-" ? [i + 1] : []));
        const picked = [changes[0]!, changes.at(-1)!];
        const base = content(blob("mixed.txt")!);
        const expected = out(r, ["hash-object", "--stdin"], { input: expectedContent(base, h, picked, direction) }).trim();
        const response = await applyHunk(s, reg.repositoryId, c, c.hunkIds[0]!, direction, { lines: picked });
        expect({ direction, ...outcome(response) }).toEqual({ direction, ...SUCCEEDED });
        expect({ direction, oid: blob("mixed.txt") }).toEqual({ direction, oid: expected });
      }
    });
    expect(f.h.digests(f.repo)).toEqual(files);
  });

  W("T034 Q16 FR-041 to FR-044: every line selection of the added and removed hunks stages and unstages the expected blob; deleted-file, new-file, eof-newline, binary, an invalid ordinal, and a stale working file refuse and change nothing", async (w) => {
    const f = copy(w, "staging-hunks");
    const r = at(f);
    const blob = (path: string) => stageEntries(f.h, f.repo, [path]).find((e) => e.stage === 0)?.oid ?? null;
    const content = (oid: string) => gitRun(f.h, f.repo, ["cat-file", "blob", oid]).stdout;
    const changeOrdinals = (body: string[]) => body.flatMap((line, i) => (line[0] === "+" || line[0] === "-" ? [i + 1] : []));
    const subsets = (ordinals: number[]) => Array.from({ length: (1 << ordinals.length) - 1 }, (_, m) => ordinals.filter((_, i) => ((m + 1) & (1 << i)) !== 0));
    const lines = (s: Service, id: string, c: Comparison, direction: Direction, picked: number[]) => applyHunk(s, id, c, c.hunkIds[0]!, direction, { lines: picked });
    await withWsl(w, "t034-lines", async (s) => {
      const reg = await open(s, w, f.repo);
      const id = reg.repositoryId;
      const files = f.h.digests(f.repo);
      for (const path of ["added.txt", "removed.txt"]) {
        for (const [direction, category] of [["stage", "unstaged"], ["unstage", "staged"]] as const) {
          if (direction === "unstage") own(f, ["add", "--", path]);
          const all = changeOrdinals(hunkOf(await selectHunks(s, id, path, category)).body);
          for (const picked of subsets(all)) {
            const c = await selectHunks(s, id, path, category);
            const h = hunkOf(c);
            const base = content(blob(path)!);
            const expected = out(r, ["hash-object", "--stdin"], { input: expectedContent(base, h, picked, direction) }).trim();
            expect({ path, direction, picked, ...outcome(await lines(s, id, c, direction, picked)) }).toEqual({ path, direction, picked, ...SUCCEEDED });
            expect({ path, direction, picked, oid: blob(path) }).toEqual({ path, direction, picked, oid: expected });
            // `reset` and `add` write only the index, so each selection starts from the same side.
            own(f, direction === "stage" ? ["reset", "-q", "--", path] : ["add", "--", path]);
          }
          own(f, ["reset", "-q", "--", path]);
        }
      }
      expect(f.h.digests(f.repo)).toEqual(files);

      // Each refusal changes no index entry and no working byte.
      const refused = async (path: string, category: "unstaged" | "staged", direction: Direction, pick: (all: number[], body: string[]) => number[], expected: { code: string; reason?: string }) => {
        const before = { index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) };
        const c = await selectHunks(s, id, path, category);
        const h = hunkOf(c);
        const response = await lines(s, id, c, direction, pick(changeOrdinals(h.body), h.body));
        const reason = (response.result as { reason?: string } | undefined)?.reason;
        expect({ path, state: response.state, code: response.code, ...(expected.reason === undefined ? {} : { reason }) }).toEqual({ path, state: "rejected", ...expected });
        expect({ path, index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) }).toEqual({ path, ...before });
        return response.operationId!;
      };
      f.h.write(`${f.repo}/fresh.txt`, "fresh 1\nfresh 2\n");
      own(f, ["add", "--", "fresh.txt"]);
      await refused("deleted.txt", "unstaged", "stage", (all) => all, { code: "UNSUPPORTED_COMPARISON", reason: "deleted-file" });
      await refused("fresh.txt", "staged", "unstage", (all) => [all[0]!], { code: "UNSUPPORTED_COMPARISON", reason: "new-file" });
      // 004 research.md R21 F25: each partial end-of-file selection refuses before `apply --cached` runs.
      const eof = changeOrdinals(hunkOf(await selectHunks(s, id, "eof.txt", "unstaged")).body);
      for (const picked of subsets(eof).filter((x) => x.length < eof.length)) {
        const operationId = await refused("eof.txt", "unstaged", "stage", () => picked, { code: "UNSUPPORTED_COMPARISON", reason: "eof-newline" });
        expect(s.runner.calls.filter((call) => call.operationId === operationId && subcommand(call.arguments) === "apply")).toEqual([]);
      }
      // The file holds one hunk, so the whole hunk stages the working bytes, as the distro Git's own hash-object of the file names them.
      const c = await selectHunks(s, id, "eof.txt", "unstaged");
      expect(outcome(await lines(s, id, c, "stage", changeOrdinals(hunkOf(c).body)))).toEqual(SUCCEEDED);
      expect(blob("eof.txt")).toBe(out(r, ["hash-object", "--", "eof.txt"]).trim());
      for (const pick of [(_: number[], body: string[]) => [body.findIndex((l) => l[0] === " ") + 1], (_: number[], body: string[]) => [body.length + 1], () => []]) {
        await refused("mixed.txt", "unstaged", "stage", pick, { code: "INVALID_REQUEST" });
      }
      // A working file that changed after the line selection refuses as a stale selection, and its new bytes stay.
      const index = stageEntries(f.h, f.repo);
      const selected = await selectHunks(s, id, "mixed.txt", "unstaged");
      f.h.write(`${f.repo}/mixed.txt`, "changed after the selection\n");
      const changed = f.h.digests(f.repo);
      expect(outcome(await lines(s, id, selected, "stage", [changeOrdinals(hunkOf(selected).body)[0]!])).code).toBe("STALE_SELECTION");
      expect({ index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) }).toEqual({ index, files: changed });
      // 001 FR-011: lines of a binary comparison give reason binary.
      f.h.write(`${f.repo}/bin.dat`, Uint8Array.of(1, 0, 2, 0, 3));
      own(f, ["add", "--", "bin.dat"]);
      own(f, ["commit", "-q", "-m", "binary", "--", "bin.dat"]);
      f.h.write(`${f.repo}/bin.dat`, Uint8Array.of(1, 0, 2, 0, 4));
      const binaryBefore = { index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) };
      const binary = await compare(s, id, "bin.dat", "unstaged");
      const response = await applyHunk(s, id, binary, crypto.randomUUID(), "stage", { lines: [1] });
      expect({ ...outcome(response), reason: (response.result as { reason?: string } | undefined)?.reason }).toEqual({ state: "rejected", code: "UNSUPPORTED_COMPARISON", reason: "binary" });
      expect({ index: stageEntries(f.h, f.repo), files: f.h.digests(f.repo) }).toEqual(binaryBefore);
    });
  });

  W("Q19 FR-030 and FR-048: a read cut inside the untracked records gives cut untracked with the complete tracked and staged lists of the distro Git", async (w) => {
    const f = copy(w, "staging-tree");
    own(f, ["add", "--", "docs/d.txt"]);
    sh(w, 'for d in $(seq -f %03.0f 0 99); do mkdir -p "u/$d" && seq -f "u/$d/f%04.0f.txt" 0 999 | xargs touch; done', [], { cwd: f.repo });
    // git-status(1) porcelain v2 without untracked files: the tracked entries by category, as `readWorkspace` splits XY.
    // The fixture has no rename (`2 `) or unmerged (`u `) record, so every record is an ordinary `1 ` record.
    const records = nul(out(at(f), ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=no"]));
    expect(records.filter((rec) => !rec.startsWith("1 "))).toEqual([]);
    const tracked = records.flatMap((rec) => {
      const fields = rec.split(" ");
      const path = fields.slice(8).join(" ");
      return [...(fields[1]![0] !== "." ? [`staged ${path}`] : []), ...(fields[1]![1] !== "." ? [`unstaged ${path}`] : [])];
    }).sort();
    await withWsl(w, "t081-cut", async (s) => {
      const r = await open(s, w, f.repo);
      const read = await s.readWorkspace(r.repositoryId);
      expect(outcome(read)).toEqual({ state: "limited", code: "OUTPUT_LIMIT" });
      const result = read.result as WorkspaceResult & { cut?: string | null };
      expect({ completeness: result.completeness, cut: result.cut }).toEqual({ completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_RECORDS" }, cut: "untracked" });
      const entries = await allEntries(s, r.repositoryId, result);
      expect(entries.filter((e) => e.category !== "untracked").map((e) => `${e.category} ${e.path}`).sort()).toEqual(tracked);
      expect(entries.length).toBe(STATUS_LISTING_RECORDS);
      const committed = await reviewOk(s, r.repositoryId, result);
      expect(valuesOf(committed.response.result, "pathBytes")).toEqual([Buffer.from("docs/d.txt").toString("base64")]);
    });
  });
});

// Data-model §8 from the distro list. `current` names the record path of the opened worktree.
function oracleEntries(f: DistroFixture, current: string) {
  return recordLines(out(at(f), ["worktree", "list", "--porcelain", "-z"])).map((lines, i) => {
    const flag = (label: string) => valueOf(lines, label) !== undefined;
    const reason = (label: string) => (flag(label) ? { reason: valueOf(lines, label) ?? null } : null);
    const path = valueOf(lines, "worktree")!;
    // Data-model §8 `headUnresolved`: a record without `bare`, `branch`, and `detached`.
    const unresolved = !flag("bare") && !flag("branch") && !flag("detached");
    return { path, invalidUtf8: false, head: unresolved ? null : (valueOf(lines, "HEAD") ?? null), branch: valueOf(lines, "branch") ?? null, bare: flag("bare"), detached: flag("detached"), headUnresolved: unresolved, locked: reason("locked"), prunable: reason("prunable"), main: i === 0, current: path === current };
  });
}
// SC-008: the worktree list with the fixture root as `<root>`, the refs, and HEAD.
const worktreeState = (f: DistroFixture) => ({
  list: recordLines(out(at(f), ["worktree", "list", "--porcelain", "-z"])).map((lines) => lines.join("\n").replaceAll(f.root, "<root>")),
  refs: refMap(f.h, f.repo),
  head: headOf(at(f)),
  config: fileDigest(at(f), localConfig(at(f))),
});

describe("worktrees, settings, trust, and submodules through the distro Git (quickstart.md Q20 to Q23)", () => {
  W("Q20 FR-049 to FR-057: readWorktrees gives the distro list with Linux paths; Remove of a dirty worktree needs force and Prune equal the distro Git's own commands on a copy", async (w) => {
    const f = copy(w, "worktrees");
    const o = copy(w, "worktrees");
    const dirty = `${f.root}/wt-dirty`;
    await withWsl(w, "t081-worktrees", async (s) => {
      const r = await open(s, w, f.repo);
      const read = await request<{ entries: unknown[] }>(s, "readWorktrees", {}, { repositoryId: r.repositoryId, repositoryGeneration: r.generation });
      expect(outcome(read)).toEqual(SUCCEEDED);
      expect(read.result!.entries).toEqual(oracleEntries(f, f.repo));
      const plan = { worktree: dirty, branch: "refs/heads/dirty-b", head: f.oids.base, tracked: 1, untracked: 1, force: false, deleteBranch: null, submodules: false };
      expect(refusalOf(await review(s, r, { action: "worktree-remove", worktree: dirty, force: false, deleteBranch: false }))).toEqual(unavailable("dirty-tree", { plan }));
      const rv = await token(s, r, { action: "worktree-remove", worktree: dirty, force: true, deleteBranch: false });
      expect(rv.plan).toEqual({ ...plan, force: true });
      let from = s.runner.calls.length;
      expect(outcome(await runToken(s, r, rv.workbenchToken))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([[L, "worktree", "remove", "--force", "--", dirty]]);
      const prune = await token(s, r, { action: "worktree-prune" });
      expect((prune.plan.prunable as { path: string }[]).map((x) => x.path)).toEqual([`${f.root}/wt-prunable`]);
      from = s.runner.calls.length;
      expect(outcome(await runToken(s, r, prune.workbenchToken))).toEqual(SUCCEEDED);
      expect(steps(s, from)).toEqual([[L, "worktree", "prune"]]);
    });
    own(o, ["worktree", "remove", "--force", "--", `${o.root}/wt-dirty`]);
    own(o, ["worktree", "prune"]);
    expect(worktreeState(f)).toEqual(worktreeState(o));
    expect(f.h.existing([dirty])).toEqual([]);
  });

  // Spec FR-023: Add worktree through the double's WSL `worktreeAdd` route and its `destination` check.
  W("T034 Q20 FR-052 and FR-053: Add worktree through the service with a new and an existing branch equals the distro Git's own worktree add on a copy; a folder that is not empty and a file give DESTINATION_NOT_EMPTY", async (w) => {
    for (const variant of ["new", "existing"] as const) {
      const f = copy(w, "worktrees");
      const o = copy(w, "worktrees");
      for (const x of [f, o]) own(x, ["branch", "free", x.oids.base!]);
      // An empty folder is a valid destination (contract Δ3 `worktree-add`).
      if (variant === "existing") for (const x of [f, o]) inDistro(w.distro, ["/usr/bin/mkdir", "--", `${x.root}/wt-new`]);
      const dest = `${f.root}/wt-new`;
      const start = f.oids.base!;
      const branch = variant === "new" ? { new: "new-b", start } : { existing: "refs/heads/free" };
      await withWsl(w, `t034-add-${variant}`, async (s) => {
        const r = await open(s, w, f.repo);
        const rv = await token(s, r, { action: "worktree-add", branch, bootstrapId: s.runner.addWorktreeAdd(uncPath(w, dest), r.repositoryId) });
        expect(rv.plan).toEqual({ branch: variant === "new" ? branch : { existing: "refs/heads/free", oid: start }, path: dest, destination: variant === "new" ? "absent" : "empty" });
        const from = s.runner.calls.length;
        const response = await runToken(s, r, rv.workbenchToken);
        expect(outcome(response)).toEqual(SUCCEEDED);
        const run = s.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [c.contextKind, ...c.arguments]);
        expect(run).toEqual([variant === "new" ? ["worktreeAdd", L, "worktree", "add", "-b", "new-b", "--", dest, start] : ["worktreeAdd", L, "worktree", "add", "--", dest, "free"]]);
        expect(response.result!.head).toEqual({ state: "branch", target: "refs/heads/main", oid: start });
      });
      own(o, variant === "new" ? ["worktree", "add", "-q", "-b", "new-b", "--", `${o.root}/wt-new`, start] : ["worktree", "add", "-q", "--", `${o.root}/wt-new`, "free"]);
      expect({ variant, state: worktreeState(f) }).toEqual({ variant, state: worktreeState(o) });
    }
    const f = copy(w, "worktrees");
    f.h.write(`${f.root}/wt-full/keep.txt`, "keep\n");
    f.h.write(`${f.root}/wt-file`, "file\n");
    const before = worktreeState(f);
    await withWsl(w, "t034-add-refused", async (s) => {
      const r = await open(s, w, f.repo);
      for (const [name, reason] of [["wt-full", "not-empty"], ["wt-file", "file"]] as const) {
        const response = await review(s, r, { action: "worktree-add", branch: { new: "fresh", start: f.oids.base! }, bootstrapId: s.runner.addWorktreeAdd(uncPath(w, `${f.root}/${name}`), r.repositoryId) });
        expect({ name, ...refusalOf(response) }).toEqual({ name, state: "failed", code: "DESTINATION_NOT_EMPTY", result: { reason } });
      }
      expect(steps(s)).toEqual([]);
    });
    expect(worktreeState(f)).toEqual(before);
  });

  W("T034 Q20 FR-051 and FR-054: Open worktree registers a listed worktree, and a folder that no record names gives UNKNOWN_TARGET; Remove is unavailable for the main and a locked worktree, and no step starts", async (w) => {
    const f = copy(w, "worktrees");
    inDistro(w.distro, ["/usr/bin/mkdir", "--", `${f.root}/elsewhere`]);
    const before = worktreeState(f);
    const spaces = `${f.root}/wt with spaces`;
    await withWsl(w, "t034-open-remove", async (s) => {
      const r = await open(s, w, f.repo);
      expect(refusalOf(await review(s, r, { action: "worktree-remove", worktree: f.repo, force: true, deleteBranch: true }))).toEqual(unavailable("main-worktree"));
      for (const name of ["wt-locked-reason", "wt-locked"]) expect({ name, ...refusalOf(await review(s, r, { action: "worktree-remove", worktree: `${f.root}/${name}`, force: true, deleteBranch: false })) }).toEqual({ name, ...unavailable("locked") });
      const openWorktree = (path: string, repositoryId: string) => s.response<RegistrationResult>(s.send("openWorktree", { repositoryId, bootstrapId: s.runner.addContext("repositoryDiscovery", uncPath(w, path)) }), RESPONSE_MS);
      const opened = await openWorktree(spaces, r.repositoryId);
      expect(outcome(opened)).toEqual(SUCCEEDED);
      const list = await request<{ entries: { path: string; current: boolean }[] }>(s, "readWorktrees", {}, { repositoryId: opened.result!.repositoryId, repositoryGeneration: opened.result!.generation });
      expect(list.result!.entries.filter((e) => e.current).map((e) => e.path)).toEqual([spaces]);
      expect(list.result!.entries).toEqual(oracleEntries(f, spaces));
      expect(outcome(await openWorktree(`${f.root}/elsewhere`, opened.result!.repositoryId))).toEqual({ state: "failed", code: "UNKNOWN_TARGET" });
      expect(steps(s)).toEqual([]);
    });
    expect(worktreeState(f)).toEqual(before);
  });

  W("Q21 FR-064 and SC-009: a Local save writes only that key in the local file, as the distro Git's own config set on a copy; the global file stays", async (w) => {
    const f = copy(w, "branches");
    const o = copy(w, "branches");
    const global = fileDigest(at(f), f.h.globalConfig);
    await withWsl(w, "t081-config-save", async (s) => {
      const r = await open(s, w, f.repo);
      for (const [key, value] of [["user.name", "Saved Name"], ["fetch.prune", "true"]] as const) {
        const from = s.runner.calls.length;
        const response = await reviewRun(s, r, { action: "config-save", scope: "local", changes: [{ key, value }] });
        expect({ key, ...outcome(response), result: response.result }).toEqual({ key, ...SUCCEEDED, result: { action: "config-save", scope: "local", written: [key] } });
        expect(steps(s, from)).toEqual([[L, "config", "set", "--local", "--", key, value]]);
        own(o, ["config", "set", "--local", "--", key, value]);
      }
    });
    expect(fileDigest(at(f), localConfig(at(f)))).toBe(fileDigest(at(o), localConfig(at(o))));
    expect(fileDigest(at(f), f.h.globalConfig)).toBe(global);
  });

  W("Q22 SC-010: a session without repository programs sends no confirm frame; a pre-commit hook asks exactly once, runs only after approval, and a hook rewrite asks nothing", async (w) => {
    const f = copy(w, "switch-dirty");
    const log = `${f.root}/pre-commit.log`;
    const hook = (body: string) => f.h.write(`${f.repo}/.git/hooks/pre-commit`, `#!/bin/sh\n${body}: >> '${log}'\n`);
    const stageChange = (path: string) => {
      f.h.write(`${f.repo}/${path}`, `${path} change\n`);
      own(f, ["add", "--", path]);
    };
    await withWsl(w, "t081-trust", async (s) => {
      const r = await open(s, w, f.repo);
      const trust = await s.readTrust(r.repositoryId);
      expect({ state: trust.result!.state, approvalRequired: trust.result!.approvalRequired }).toEqual({ state: "untrusted", approvalRequired: { reads: false, commit: false, sync: false, workbench: false, mergetool: false } });
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "no programs\n"))).toEqual(SUCCEEDED);
      expect(confirms(s)).toEqual([]);
      hook("");
      stageChange("a.txt");
      expect((await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "needs trust\n")).code).toBe("TRUST_REQUIRED");
      expect({ confirms: confirms(s).length, canary: f.h.existing([log]) }).toEqual({ confirms: 0, canary: [] });
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual(SUCCEEDED);
      expect(confirms(s).length).toBe(1);
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "after approval\n"))).toEqual(SUCCEEDED);
      expect(logLines(at(f), log)).toEqual([]);
      expect(f.h.existing([log])).toEqual([log]);
      hook("echo rewritten >/dev/null\n");
      stageChange("b.txt");
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "after rewrite\n"))).toEqual(SUCCEEDED);
      expect(confirms(s).length).toBe(1);
    });
    expect(subjects(at(f), [`${f.oids.base}..HEAD`])).toEqual(["no programs", "after approval", "after rewrite"]);
  });

  // A pre-commit hook that records each run in `log`, and one staged change.
  function hookedRepo(w: WslHost): { f: DistroFixture; log: string; stage: (path: string) => void } {
    const f = copy(w, "switch-dirty");
    const log = `${f.root}/pre-commit.log`;
    f.h.write(`${f.repo}/.git/hooks/pre-commit`, `#!/bin/sh\n: >> '${log}'\n`);
    const stage = (path: string) => {
      f.h.write(`${f.repo}/${path}`, `${path} change\n`);
      own(f, ["add", "--", path]);
    };
    stage("a.txt");
    return { f, log, stage };
  }
  const records = (s: Service) => s.trustStore.records as unknown as Record<string, unknown>[];

  W("T034 Q22 FR-072 and FR-074: Not now ends canceled with no Git process and no hook run; Stop trusting removes the record, and the next commit needs trust again", async (w) => {
    const { f, log, stage } = hookedRepo(w);
    await withWsl(w, "t034-not-now", async (s) => {
      const r = await open(s, w, f.repo);
      expect({ state: (await s.readTrust(r.repositoryId)).result!.state, commit: (await s.readTrust(r.repositoryId)).result!.approvalRequired.commit }).toEqual({ state: "untrusted", commit: true });
      const from = s.runner.calls.length;
      expect((await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "needs trust\n")).code).toBe("TRUST_REQUIRED");
      expect(commitCalls(s, from)).toEqual([]);
      s.runner.inject.confirmResult = "declined";
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual({ state: "canceled", code: "CANCELED" });
      const frames = confirms(s) as { callsBefore: number }[];
      expect(frames.length).toBe(1);
      // Spec FR-072: after Not now, no Git process starts.
      expect(s.runner.calls.length).toBe(frames[0]!.callsBefore);
      expect({ log: f.h.existing([log]), records: records(s), state: (await s.readTrust(r.repositoryId)).result!.state }).toEqual({ log: [], records: [], state: "untrusted" });
      s.runner.inject.confirmResult = "approved";
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual(SUCCEEDED);
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "approved\n"))).toEqual(SUCCEEDED);
      expect(f.h.existing([log])).toEqual([log]);
      const trust = (await s.readTrust(r.repositoryId)).result!;
      const revoked = await s.revokeTrust(r.repositoryId, (trust as { trustId?: string }).trustId!);
      expect(outcome(revoked)).toEqual(SUCCEEDED);
      expect({ state: (await s.readTrust(r.repositoryId)).result!.state, records: records(s) }).toEqual({ state: "revoked", records: [] });
      stage("b.txt");
      const next = s.runner.calls.length;
      expect((await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "after revoke\n")).code).toBe("TRUST_REQUIRED");
      expect(commitCalls(s, next)).toEqual([]);
    });
    expect(subjects(at(f), [`${f.oids.base}..HEAD`])).toEqual(["approved"]);
  });

  W("T034 Q22 plan.md O-5: a version 1 record gives changed and asks once, and its version 2 record replaces it; the next session asks nothing", async (w) => {
    const { f, stage } = hookedRepo(w);
    const store = createTrustStore();
    // One session at application start with the shared record store. After the close, no scope of this process remains.
    const inSession = async (name: string, body: (s: Service, r: RegistrationResult) => Promise<void>) => {
      const s = await openService({ git: gitExe(), name, environment: serviceEnv(), wslGlobalConfig: globalConfig(w), trustStore: store });
      try {
        await body(s, await open(s, w, f.repo));
      } finally {
        await s.dispose();
      }
      expect(listScopes(w)).toEqual([]);
    };
    await inSession("t034-v1-first", async (s, r) => {
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual(SUCCEEDED);
      // The 001 record form of the same worktree. Its fingerprint is the approved one when the store wrote a version 1 record.
      const stored = records(s)[0]!;
      const v1 = {
        commonDirectory: stored.commonDirectory,
        commonIdentity: stored.commonIdentity,
        worktreeRoot: stored.worktreeRoot,
        gitDirectory: stored.adminDirectory ?? stored.gitDirectory,
        worktreeIdentity: stored.worktreeIdentity,
        configurationFingerprint: stored.configurationFingerprint ?? "f".repeat(64),
        approvedAt: stored.approvedAt,
        gitSelectedPath: stored.gitSelectedPath,
      };
      store.records = [v1 as never];
    });
    await inSession("t034-v1-second", async (s, r) => {
      expect((await s.readTrust(r.repositoryId)).result!.state).toBe("changed");
      expect((await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "v1\n")).code).toBe("TRUST_CHANGED");
      expect(outcome(await s.approveTrust(r.repositoryId, "commit"))).toEqual(SUCCEEDED);
      expect(confirms(s).length).toBe(1);
      expect(records(s).map((x) => ({ policyVersion: x.policyVersion, fingerprint: "configurationFingerprint" in x }))).toEqual([{ policyVersion: 2, fingerprint: false }]);
    });
    await inSession("t034-v1-third", async (s, r) => {
      expect((await s.readTrust(r.repositoryId)).result!.state).toBe("approved");
      stage("b.txt");
      expect(outcome(await commit(s, r.repositoryId, await reviewOk(s, r.repositoryId), "v2\n"))).toEqual(SUCCEEDED);
      expect(confirms(s)).toEqual([]);
    });
    expect(subjects(at(f), [`${f.oids.base}..HEAD`])).toEqual(["v2"]);
  });

  W("Q23 SC-011 and FR-076 to FR-082: a one-click update equals the distro Git's own update in a copy; a scoped update of one row touches only that row", async (w) => {
    const full = buildF31(w, "base");
    const oracle = distroSubmoduleOracle(full.sup, `${full.root}/oracle`);
    const scoped = buildF31(w, "base");
    const scopedCopy = `${scoped.root}/scoped-oracle`;
    inDistro(w.distro, ["/usr/bin/cp", "-a", "--", scoped.sup.dir, scopedCopy]);
    const scopedOracle = scoped.sup.host.probe.paths.git!;
    const oracleRun = wslExec(["--distribution", w.distro, "--cd", scopedCopy, "--exec", "/usr/bin/env", `HOME=${w.folder}/home`, `GIT_CONFIG_GLOBAL=${globalConfig(w)}`, "GIT_CONFIG_NOSYSTEM=1", scopedOracle, "submodule", "update", "--init", "--recursive", "--", ":(literal)solo"], { timeoutMs: 120_000 });
    expect(oracleRun.exitCode).toBe(0);
    const scopedExpected = distroSubmoduleState({ host: w, dir: scopedCopy });
    for (const [f, scope] of [[full, undefined], [scoped, "solo"]] as const) {
      await withWsl(w, `t081-submodules-${scope ?? "all"}`, async (s) => {
        const r = await open(s, w, f.sup.dir);
        // The "base" fixture holds no hook, filter, or program, so no class needs approval.
        expect((await s.readTrust(r.repositoryId)).result!.approvalRequired).toEqual({ reads: false, commit: false, sync: false, workbench: false, mergetool: false });
        const read = await readOk(s, r.repositoryId);
        const reviewed = await request(s, "reviewSubmodules", { snapshotId: read.snapshotId, ...(scope === undefined ? {} : { scope: { path: scope } }) }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
        expect({ scope, ...outcome(reviewed), refusals: valuesOf(reviewed.result, "reason") }).toEqual({ scope, ...SUCCEEDED, refusals: [] });
        const updated = await request(s, "updateSubmodules", { submoduleReviewToken: valuesOf(reviewed.result, "submoduleReviewToken")[0], start: true }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
        expect({ scope, ...outcome(updated) }).toEqual({ scope, ...SUCCEEDED });
        if (scope !== undefined) expect(objectsWith<SubmoduleRowResult>(updated.result, ["rowId", "state", "fetched"]).map((row) => row.path)).toEqual([scope]);
      });
    }
    expect({ oracle: oracle.exitCode, state: distroSubmoduleState(full.sup) }).toEqual({ oracle: 0, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
    expect(distroSubmoduleState(scoped.sup)).toEqual(scopedExpected);
  });

  // `reviewSubmodules` of a fresh read, with `scope` when `path` is given (contract Δ12).
  async function submoduleReview(s: Service, repositoryId: string, path?: string) {
    const read = await readOk(s, repositoryId);
    const response = await request(s, "reviewSubmodules", { snapshotId: read.snapshotId, ...(path === undefined ? {} : { scope: { path } }) }, { repositoryId, repositoryGeneration: read.generation });
    return { response, generation: read.generation, token: valuesOf(response.result, "submoduleReviewToken")[0] as string | undefined, refusals: refusalsOf(response.result), hosts: valuesOf(response.result, "hosts")[0] };
  }
  type SubmoduleReviewed = Awaited<ReturnType<typeof submoduleReview>>;
  const sendUpdate = (s: Service, repositoryId: string, r: SubmoduleReviewed, confirmHosts = false) =>
    s.send("updateSubmodules", { submoduleReviewToken: r.token, start: true, ...(confirmHosts ? { confirmHosts: true } : {}) }, { repositoryId, repositoryGeneration: r.generation });
  const runUpdate = (s: Service, repositoryId: string, r: SubmoduleReviewed, confirmHosts = false) => s.response(sendUpdate(s, repositoryId, r, confirmHosts), RESPONSE_MS);
  const rowStates = (response: ServiceResponse) => Object.fromEntries(resultsOf(response).map((row) => [row.path, row.state]));

  W("T034 Q23 FR-049 and FR-079: a refusal gives UNSUPPORTED_SUBMODULE and starts no step; a host line waits for confirmHosts, and the same token then runs and equals the distro Git's own update on a copy", async (w) => {
    // `submodule.solo.active` holds no boolean, so the review refuses it (001 FR-049).
    const refused = buildF31(w, "base");
    distroGit(refused.sup, ["config", "submodule.solo.active", "maybe"]);
    const before = distroSubmoduleState(refused.sup);
    // `solo` fetches from its local `origin`, and the registered URL names another host. No process reaches that host.
    const hosted = buildF31(w, "uploadpack");
    distroGit({ host: w, dir: `${hosted.sup.dir}/solo` }, ["config", "--unset", "remote.origin.uploadpack"]);
    distroGit(hosted.sup, ["config", "submodule.solo.url", "https://git.example.net/solo.git"]);
    const oracle = distroSubmoduleOracle(hosted.sup, `${hosted.root}/oracle`);
    await withWsl(w, "t034-submodule-refusal-hosts", async (s) => {
      const rr = await open(s, w, refused.sup.dir);
      const review = await submoduleReview(s, rr.repositoryId);
      expect(review.refusals.map((x) => x.reason)).toContain("active-value");
      let from = s.runner.calls.length;
      const response = await runUpdate(s, rr.repositoryId, review);
      expect({ code: response.code, reasons: refusalsOf(response.result).map((x) => x.reason), steps: updateSteps(s, from).length }).toEqual({ code: "UNSUPPORTED_SUBMODULE", reasons: review.refusals.map((x) => x.reason), steps: 0 });
      const rh = await open(s, w, hosted.sup.dir);
      const hosts = await submoduleReview(s, rh.repositoryId);
      expect({ ...outcome(hosts.response), refusals: hosts.refusals, hosts: hosts.hosts }).toEqual({ ...SUCCEEDED, refusals: [], hosts: [{ path: "solo", fetch: { kind: "local" }, settings: { kind: "host", name: "git.example.net" } }] });
      from = s.runner.calls.length;
      const waiting = await runUpdate(s, rh.repositoryId, hosts);
      expect({ ...outcome(waiting), reason: valuesOf(waiting.result, "reason"), steps: updateSteps(s, from).length }).toEqual({ state: "rejected", code: "STALE_REVIEW", reason: ["hosts"], steps: 0 });
      expect(outcome(await runUpdate(s, rh.repositoryId, hosts, true))).toEqual(SUCCEEDED);
    });
    expect(distroSubmoduleState(refused.sup)).toEqual(before);
    expect({ oracle: oracle.exitCode, state: distroSubmoduleState(hosted.sup) }).toEqual({ oracle: 0, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
  });

  W("T034 Q23 FR-081 and 001 §12: a failed row, then Retry of that row, equal the distro Git's own update on a copy; Cancel states each row from a fresh read, and no process or scope remains", async (w) => {
    const f = buildF31(w, "base");
    const oracle = distroSubmoduleOracle(f.sup, `${f.root}/oracle`);
    // Without its remote, the `solo` clone fails. The move back is the fix before Retry.
    const remote = `${f.root}/solo.git`;
    inDistro(w.distro, ["/usr/bin/mv", "--", remote, `${remote}.away`]);
    const c = buildF31(w, "base");
    await withWsl(w, "t034-submodule-retry-cancel", async (s) => {
      const r = await open(s, w, f.sup.dir);
      const failed = await runUpdate(s, r.repositoryId, await submoduleReview(s, r.repositoryId));
      expect(rowStates(failed)).toEqual({ mid: "cloned", "mid/leaf": "cloned", solo: "failed" });
      inDistro(w.distro, ["/usr/bin/mv", "--", `${remote}.away`, remote]);
      // FR-081: Retry updates that row and its nested rows only.
      const retry = await submoduleReview(s, r.repositoryId, "solo");
      expect(outcome(retry.response)).toEqual(SUCCEEDED);
      const retried = await runUpdate(s, r.repositoryId, retry);
      expect({ ...outcome(retried), rows: rowStates(retried) }).toEqual({ ...SUCCEEDED, rows: { solo: "cloned" } });

      const rc = await open(s, w, c.sup.dir);
      const review = await submoduleReview(s, rc.repositoryId);
      const isSoloClone = (call: { arguments: readonly string[] }) => commandOf(call.arguments).join(" ") === "submodule update --init --progress -- :(literal)solo";
      const release = s.runner.holdStart(isSoloClone);
      const from = s.runner.calls.length;
      const requestId = sendUpdate(s, rc.repositoryId, review);
      await until(() => s.runner.calls.slice(from).some(isSoloClone) || s.responseAt.has(requestId), "the held solo clone", RESPONSE_MS);
      const operationId = await s.operationId(requestId);
      await s.cancel(operationId);
      release();
      const response = await s.response(requestId, RESPONSE_MS);
      expect(response.state).not.toBe("succeeded");
      const rows = resultsOf(response);
      const heads = distroSubmoduleState(c.sup).heads;
      expect(rows.map((row) => [row.path, row.newCommit])).toEqual(rows.map((row) => [row.path, heads[row.path] ?? null]));
      await Bun.sleep(AFTER_CLOSE_MS);
      expect(pgrep(w, operationId)).toEqual([]);
    });
    expect({ oracle: oracle.exitCode, state: distroSubmoduleState(f.sup) }).toEqual({ oracle: 0, state: { heads: oracle.heads, gitDirs: oracle.gitDirs, keys: oracle.keys } });
  });
});

// ---- Feature 006 T032: the Global save through the distro Git (quickstart.md Q22, plan.md D13 and D14, spec FR-018 to FR-025, SC-005) ----

describe("the Global save through the distro Git (feature 006 T032)", () => {
  const T032 = "T032";
  const WRAPPER = wslProcess.wrapper.join("\n");
  const factLine = (w: WslHost, o: Observation) => console.log(observationLine(T032, o, `git=${w.gitVersion ?? "unknown"}@${w.distro}`));
  const ownedGlobal = (w: WslHost) => globalConfig(w);
  const oracleGlobal = (w: WslHost) => `${w.folder}/home/oracle.gitconfig`;
  const includedGlobal = (w: WslHost) => `${w.folder}/home/included.gitconfig`;
  // Spec FR-060 in Git's canonical form (git-config(1)). The test keeps its own copy, as tests/git/git-settings.test.ts does.
  const FR060 = ["user.name", "user.email", "core.editor", "commit.template", "credential.helper", "diff.tool", "merge.tool", "core.autocrlf", "i18n.filesencoding", "pull.rebase", "fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "pull.ff", "push.default", "push.autosetupremote"];
  const BOOLS = new Set(["fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "push.autosetupremote"]);
  const ENUMS: Record<string, string[]> = { "core.autocrlf": ["true", "false", "input"], "pull.rebase": ["true", "false", "merges", "interactive"], "pull.ff": ["true", "false", "only"], "push.default": ["nothing", "current", "upstream", "simple", "matching"] };
  // A value that differs from the current one and that Git reads for the key type.
  const newValue = (key: string, current: string | null): string => (BOOLS.has(key) ? (current === "true" ? "false" : "true") : (ENUMS[key]?.find((v) => v !== current) ?? `saved ${key}`));
  // The FR-060 keys besides the `globalText` keys. Two `credential.helper` values are multi-valued, and `core.editor` comes from an include (004 plan.md D11).
  const globalKeys = (w: WslHost) =>
    `[include]\n\tpath = ${includedGlobal(w)}\n[commit]\n\ttemplate = global-template.txt\n[credential]\n\thelper = global-helper-1\n\thelper = global-helper-2\n` +
    `[diff]\n\ttool = global-diff\n[difftool "global-diff"]\n\tpath = global-difftool-path\n\tcmd = global-difftool $LOCAL $REMOTE\n` +
    `[merge]\n\ttool = global-merge\n\tautostash = false\n[mergetool "global-merge"]\n\tpath = global-mergetool-path\n\tcmd = global-mergetool $MERGED\n` +
    `[i18n]\n\tfilesEncoding = utf-8\n[pull]\n\trebase = merges\n\tff = only\n[fetch]\n\tprune = false\n[rebase]\n\tautostash = false\n\tautosquash = false\n\tupdateRefs = false\n` +
    `[rerere]\n\tenabled = false\n\tautoUpdate = false\n[push]\n\tdefault = current\n\tautoSetupRemote = false\n`;

  type SaveResult = { action: string; scope: string; written: string[]; failed?: { key: string; exitCode: number | null; reason?: string }; stale?: string; outputTail?: string };
  const save = (changes: { key: string; value: string | null }[]) => ({ action: "config-save", scope: "global", changes });
  const writes = (s: Service, from = 0) => s.runner.calls.slice(from).filter((c) => c.environmentPolicy === "integrate").map((c) => [c.contextKind, ...c.arguments]);
  const globalValues = (f: DistroFixture, key: string) => out(at(f), ["config", "get", "--all", "--global", key], { allowExit: [0, 1] }).split("\n").filter((l) => l !== "");
  const globalDigest = (f: DistroFixture) => fileDigest(at(f), ownedGlobal(f.w));
  const runSave = async (s: Service, r: RegistrationResult, changes: { key: string; value: string | null }[]) => s.response<SaveResult>(sendRun(s, r, (await token(s, r, save(changes))).workbenchToken), RESPONSE_MS);

  let wrapperRuns = 0;
  // The prefix of the file header. The unit of each run is `arbareto-<operation ID>-1.scope`.
  function wrapperOperation(): string {
    const id = `0f0f0f0f-0000-4000-800a-${(process.pid * 0x1000 + ++wrapperRuns).toString(16).padStart(12, "0")}`;
    OWN_SCOPE_OPERATIONS.add(id);
    return id;
  }
  // Contract §11 "Process launch": the wrapper in mode `integrate` around `program`, with no forwarded variable, as the shell starts a Git process.
  // The stdout after the start byte, or null for another exit or no start byte.
  function underWrapper(w: WslHost, program: string[]): string | null {
    const p = w.probe.paths;
    const r = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/bin/sh", "-c", WRAPPER, "sh", `arbareto-${wrapperOperation()}-1.scope`, "integrate", "", p["systemd-run"]!, p.systemctl!, p.setsid!, w.probe.noexpand === "0" ? "1" : "", ...program], { timeoutMs: 60_000 });
    return r.exitCode === 0 && r.bytes[0] === 0x53 ? Buffer.from(r.bytes.subarray(1)).toString("utf8") : null;
  }

  // Spec FR-025: the SHA-256 of the real `~/.gitconfig` and of the real XDG file, read inside the distro without the forwarding. `absent` stands for a missing file.
  const REAL_FILES = 'for f in "$HOME/.gitconfig" "${XDG_CONFIG_HOME:-$HOME/.config}/git/config"; do if [ -e "$f" ]; then sha256sum < "$f"; else echo absent; fi; done';
  function realDigests(w: WslHost): string[] {
    const r = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/bin/sh", "-c", REAL_FILES]);
    if (r.exitCode !== 0) throw new Error(`the real file digests exited ${r.exitCode}: ${r.stderr}`);
    const lines = r.stdout.split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(2);
    return lines;
  }

  // The registration, and the Git installation ID of its `run` requests. The hook refuses nothing.
  async function openWithGit(s: Service, w: WslHost, dir: string): Promise<{ r: RegistrationResult; gitInstallationId: string }> {
    let gitInstallationId = "";
    s.runner.inject.refuse = (call) => {
      const context = (call as Partial<GitCall>).context;
      if (context !== undefined && "gitInstallationId" in context) gitInstallationId = context.gitInstallationId;
      return undefined;
    };
    const r = await open(s, w, dir);
    s.runner.inject.refuse = undefined;
    expect(gitInstallationId).not.toBe("");
    return { r, gitInstallationId };
  }

  // Spec FR-023: before the first write, Git in the distro names the owned global file through the double.
  async function expectOwnedGlobal(s: Service, w: WslHost, r: RegistrationResult, gitInstallationId: string): Promise<void> {
    const stdout = createCollector({ maxBytes: 65_536 });
    const stderr = createCollector({ maxBytes: 65_536 });
    const context = { contextKind: "registeredOperation" as const, gitInstallationId, repositoryId: r.repositoryId };
    const exit = await s.runner.run({ operationId: crypto.randomUUID(), context, arguments: [L, "var", "GIT_CONFIG_GLOBAL"], environmentPolicy: "read", limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS }, stdout, stderr, signal: new AbortController().signal });
    expect({ exitCode: exit.exitCode, stdout: new TextDecoder().decode(stdout.take()) }).toEqual({ exitCode: 0, stdout: `${ownedGlobal(w)}\n` });
  }

  // One Global case. The real files keep their SHA-256 (spec FR-025), and the owned global file is the target before the first write.
  async function withGlobal(w: WslHost, f: DistroFixture, name: string, body: (s: Service, r: RegistrationResult) => Promise<void>): Promise<void> {
    const real = realDigests(w);
    await withWsl(w, name, async (s) => {
      const { r, gitInstallationId } = await openWithGit(s, w, f.repo);
      await expectOwnedGlobal(s, w, r, gitInstallationId);
      await body(s, r);
    });
    expect(realDigests(w)).toEqual(real);
  }

  W("Q22 FR-018, FR-019, and SC-005: Save and remove of each FR-060 key in Global equal the distro Git's own config set and unset --global on a copy of the owned global file; a multi-valued key and an included value stay read only; every other configuration byte stays", async (w) => {
    const h = hostOf(w, globalKeys(w));
    h.write(includedGlobal(w), "[core]\n\teditor = included-editor\n");
    h.copy(ownedGlobal(w), oracleGlobal(w));
    const f = copy(w, "branches");
    const oracle = (args: string[]) => gitRun(h, h.root, args, { env: { GIT_CONFIG_GLOBAL: oracleGlobal(w) } });
    const xdg = `${w.folder}/home/.config/git/config`;
    const before = { local: fileDigest(at(f), localConfig(at(f))), included: fileDigest(at(f), includedGlobal(w)), xdg: f.h.existing([xdg]) };
    await withGlobal(w, f, "t032-global-save", async (s, r) => {
      // The tool keys of the effective tools go first, because a later `diff.tool` or `merge.tool` save changes those tools.
      for (const key of ["difftool.global-diff.path", "difftool.global-diff.cmd", "mergetool.global-merge.path", "mergetool.global-merge.cmd", ...FR060]) {
        const current = globalValues(f, key);
        // `config get --global` reads no include, so the included `core.editor` lists no value there.
        const reason = key === "core.editor" ? "included" : current.length > 1 ? "multi-value" : null;
        if (reason !== null) {
          const global = globalDigest(f);
          const from = s.runner.calls.length;
          expect({ key, ...refusalOf(await review(s, r, save([{ key, value: "x" }]))) }).toEqual({ key, ...unavailable(reason) });
          expect({ key, writes: writes(s, from), global: globalDigest(f) }).toEqual({ key, writes: [], global });
          continue;
        }
        for (const value of [newValue(key, current[0] ?? null), null]) {
          const from = s.runner.calls.length;
          const response = await runSave(s, r, [{ key, value }]);
          expect({ key, value, ...outcome(response), result: response.result }).toEqual({ key, value, ...SUCCEEDED, result: { action: "config-save", scope: "global", written: [key] } });
          const args = value === null ? ["config", "unset", "--global", "--", key] : ["config", "set", "--global", "--", key, value];
          expect({ key, value, writes: writes(s, from) }).toEqual({ key, value, writes: [["globalConfig", L, ...args]] });
          oracle(args);
          expect({ key, value, global: globalDigest(f) }).toEqual({ key, value, global: fileDigest(at(f), oracleGlobal(w)) });
        }
      }
    });
    expect({ local: fileDigest(at(f), localConfig(at(f))), included: fileDigest(at(f), includedGlobal(w)), xdg: f.h.existing([xdg]) }).toEqual(before);
    // Research.md R9: `GIT_CONFIG_GLOBAL` wins over the XDG file, and the double forwards it. The spec edge case of a user without `HOME` needs no forwarding.
    console.log(`OBSERVATION ${T032}: unverified XDG global file through the double`);
    console.log(`OBSERVATION ${T032}: unverified save without HOME`);
  });

  W("Q22 FR-019 and FR-022: a change before the review shows in the plan and writes nothing; a change after the review gives stale and keeps the other value; Git's exit 5 and a held lock name the key and the output tail; Cancel writes nothing; the fresh listing decides each result", async (w) => {
    const h = hostOf(w);
    const f = copy(w, "branches");
    const other = (args: string[]) => gitRun(h, h.root, ["config", "set", "--global", ...args]);
    await withGlobal(w, f, "t032-global-stale", async (s, r) => {
      const settings = await request<{ values: { key: string; scopes: { global: { value: string | null }[] } }[]; files: { global: string | null } }>(s, "readGitSettings", {}, { repositoryId: r.repositoryId });
      expect(outcome(settings)).toEqual(SUCCEEDED);
      // Contract §11 and 004 data-model §9: a WSL workspace names no global file, and Git's `--global` rule applies in the distro.
      expect(settings.result!.files.global).toBeNull();
      expect(settings.result!.values.find((v) => v.key === "user.name")!.scopes.global.map((e) => e.value)).toEqual(["Arbareto Fixture"]);
      // A change before the review: the plan shows the other value, so the renderer gives the 004 `changedOutside` text and runs nothing.
      other(["user.name", "Other Program"]);
      let from = s.runner.calls.length;
      const changed = await token(s, r, save([{ key: "user.name", value: "Mine" }]));
      expect(changed.plan).toEqual({ scope: "global", changes: [{ key: "user.name", value: "Mine", earlier: { origin: `file:${ownedGlobal(w)}`, value: "Other Program" } }] });
      expect(writes(s, from)).toEqual([]);

      // A change after the review, before the write of its key.
      const two = await token(s, r, save([{ key: "user.name", value: "Mine" }, { key: "user.email", value: "mine@arbareto.invalid" }]));
      const release = s.runner.holdStart((c) => c.arguments[2] === "set" && c.arguments.includes("user.name"));
      from = s.runner.calls.length;
      const requestId = sendRun(s, r, two.workbenchToken);
      await until(() => s.runner.calls.slice(from).some((c) => c.environmentPolicy === "integrate"), "the held user.name write", RESPONSE_MS);
      other(["user.email", "other@arbareto.invalid"]);
      release();
      const stale = await s.response<SaveResult>(requestId, RESPONSE_MS);
      // 004 plan.md D11: `written` comes from the fresh listing, so the other program's `user.email` entry counts as changed too.
      expect({ ...outcome(stale), result: stale.result }).toEqual({ ...WITH_EFFECTS, result: { action: "config-save", scope: "global", written: ["user.name", "user.email"], stale: "user.email" } });
      expect(writes(s, from)).toEqual([["globalConfig", L, "config", "set", "--global", "--", "user.name", "Mine"]]);
      expect({ name: globalValues(f, "user.name"), email: globalValues(f, "user.email") }).toEqual({ name: ["Mine"], email: ["other@arbareto.invalid"] });

      // git-config(1) exit 5: the owned global file holds no `rerere.autoUpdate` to remove.
      const absent = await runSave(s, r, [{ key: "rerere.autoupdate", value: null }]);
      expect({ ...outcome(absent), failed: absent.result!.failed, written: absent.result!.written }).toEqual({ state: "failed", code: "GIT_FAILED", failed: { key: "rerere.autoupdate", exitCode: 5, reason: "nothing-set" }, written: [] });
      // A held lock: Git exits 255, which git-config(1) does not document, so the result names the key, the exit, and the output tail.
      const lock = `${ownedGlobal(w)}.lock`;
      const locked = await token(s, r, save([{ key: "pull.ff", value: "only" }]));
      h.write(lock, "");
      let global = globalDigest(f);
      const failed = await s.response<SaveResult>(sendRun(s, r, locked.workbenchToken), RESPONSE_MS);
      inDistro(w.distro, ["/usr/bin/rm", "-f", "--", lock]);
      const tail = failed.result?.outputTail;
      expect({ ...outcome(failed), failed: failed.result!.failed, written: failed.result!.written, tail: typeof tail === "string" && tail.length > 0 }).toEqual({ state: "failed", code: "GIT_FAILED", failed: { key: "pull.ff", exitCode: 255 }, written: [], tail: true });
      expect(globalDigest(f)).toBe(global);

      // Cancel while the write waits to start: no write, and the fresh listing names no written key.
      const canceled = await token(s, r, save([{ key: "fetch.prune", value: "true" }]));
      const hold = s.runner.holdStart((c) => c.arguments[2] === "set" && c.arguments.includes("fetch.prune"));
      from = s.runner.calls.length;
      const id = sendRun(s, r, canceled.workbenchToken);
      await until(() => s.runner.calls.slice(from).some((c) => c.environmentPolicy === "integrate"), "the held fetch.prune write", RESPONSE_MS);
      global = globalDigest(f);
      const operationId = await s.operationId(id);
      await s.cancel(operationId);
      hold();
      const done = await s.response<SaveResult>(id, RESPONSE_MS);
      expect({ ...outcome(done), written: done.result?.written }).toEqual({ state: "canceled", code: "CANCELED", written: [] });
      expect(globalDigest(f)).toBe(global);
      await Bun.sleep(AFTER_CLOSE_MS);
      expect(pgrep(w, operationId)).toEqual([]);
    });
  });

  W("Q22 SC-005, F9, and F10: with core.sharedRepository=0660 in the repository and no owned global file, the save from / creates the global file with mode 0666 & ~umask of the wrapper", async (w) => {
    hostOf(w);
    const f = copy(w, "branches");
    own(f, ["config", "--local", "core.sharedRepository", "0660"]);
    const umaskText = underWrapper(w, ["/bin/sh", "-c", "umask"]);
    expect(umaskText).toMatch(/^[0-7]{3,4}\n$/);
    const mode = (0o666 & ~Number.parseInt(umaskText!.trim(), 8)).toString(8);
    // SC-005: the mode cannot show the difference then.
    if (mode === "660") throw new Error(`the wrapper umask ${umaskText!.trim()} gives mode 660, so the case cannot run`);
    const home = underWrapper(w, ["/usr/bin/printenv", "HOME"]);
    factLine(w, obs("F10 HOME set under the wrapper in mode integrate", true, home !== null && home.trim() !== ""));
    await withGlobal(w, f, "t032-global-mode", async (s, r) => {
      inDistro(w.distro, ["/usr/bin/rm", "-f", "--", ownedGlobal(w)]);
      const from = s.runner.calls.length;
      const response = await runSave(s, r, [{ key: "user.name", value: "Mode Case" }]);
      const created = inDistro(w.distro, ["/usr/bin/stat", "-c", "%a", "--", ownedGlobal(w)]).trim();
      factLine(w, obs("F9 global file mode of a save from / with core.sharedRepository=0660", mode, created));
      expect(created).toBe(mode);
      expect({ ...outcome(response), result: response.result }).toEqual({ ...SUCCEEDED, result: { action: "config-save", scope: "global", written: ["user.name"] } });
      expect(writes(s, from)).toEqual([["globalConfig", L, "config", "set", "--global", "--", "user.name", "Mode Case"]]);
    });
    expect(f.h.read(ownedGlobal(w))!.toString("utf8")).toBe("[user]\n\tname = Mode Case\n");
  });

  // Spec FR-023: each WSL route fails closed without the owned global file. The seam registration starts no process, and `inject.exit` replaces every later process.
  W("Q22 FR-023: the double without wslGlobalConfig refuses the WSL globalConfig, worktreeAdd, and destination routes before any process", async (w) => {
    const runner = createBunRunner({ git: gitExe(), directory: fixtureDir(`t032-no-global-${crypto.randomUUID()}`), environment: serviceEnv() });
    try {
      const repo = seamRepository(w, runner);
      const seam = runner.inject.stdout!;
      let gitInstallationId = "";
      // Without the forwarding, a Git process would read the real global file, so a call without a seam output starts no process.
      runner.inject.refuse = (call) => {
        const context = (call as Partial<GitCall>).context;
        if (context !== undefined && "gitInstallationId" in context) gitInstallationId = context.gitInstallationId;
        return seam({ operationId: call.operationId, arguments: call.arguments }) === undefined ? "INVALID_REQUEST" : undefined;
      };
      const s = startSession(runner);
      const registered = await s.response(s.chooseRepository(repo.path));
      expect(registered).toMatchObject({ state: "succeeded" });
      expect(gitInstallationId).not.toBe("");
      const repositoryId = (registered.result as unknown as { repositoryId: string }).repositoryId;
      // A missing refusal then ends with exit 0 and no process, so the case fails without a Git run.
      runner.inject.refuse = undefined;
      runner.inject.exit = () => 0;
      const spawned = runner.spawned;
      const call = (context: GitCall["context"], args: string[], environmentPolicy: GitCall["environmentPolicy"]) =>
        runner.run({ operationId: crypto.randomUUID(), context, arguments: args, environmentPolicy, limits: environmentPolicy === "read" ? { deadlineMs: GIT_PROCESS_DEADLINE_MS } : PROCESS_LIMITS.network, stdout: createCollector({ maxBytes: 1_024 }), stderr: createCollector({ maxBytes: 1_024 }), signal: new AbortController().signal });
      await expect(call({ contextKind: "globalConfig", gitInstallationId }, [L, "--no-optional-locks", "--literal-pathspecs", "config", "list", "--show-scope", "--show-origin", "-z"], "read")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      const dest = `${w.folder}/t032-wt`;
      const bootstrapId = runner.addWorktreeAdd(uncPath(w, dest), repositoryId);
      await expect(call({ contextKind: "worktreeAdd", gitInstallationId, repositoryId, bootstrapId }, [L, "worktree", "add", "--", dest, "main"], "integrate")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(runner.destinationFacts({ operationId: crypto.randomUUID(), bootstrapId })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(runner.spawned).toBe(spawned);
    } finally {
      await runner.dispose();
    }
  });
});
