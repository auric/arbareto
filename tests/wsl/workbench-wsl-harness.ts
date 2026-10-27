// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The shared harness of the four `workbench-wsl-*.test.ts` files (006 T056). It holds the helpers and fixtures of the former `workbench-wsl.test.ts`.

// T081: the WSL rows of quickstart.md Q26 and the plan.md D18 checks in the distro of `ARBARETO_WSL_DISTRO` (spec FR-006).
// The Windows builder (`tests/git/workbench-fixtures.ts`) makes each fixture, and a `tar` stream on stdin copies it into the owned distro folder.
// The oracle is the distro Git on a second copy. Fact cases print `OBSERVATION T081` lines: a `match=false` line is a finding for research.md R21, not a failure.
// The service gives the distro Git no fixed commit dates, so service cases compare commits by tree, subject, and parent shapes, never by object ID (plan.md D19).
// Feature 006 T032 and T034 (plan.md D14): the WSL Global save through the double and the 004 research.md R21 rows without a WSL case. Fact lines print `OBSERVATION T032` and `OBSERVATION T034`.
// The wrapper runs of `workbench-wsl-settings.test.ts` outside the double use operation IDs that start with `0f0f0f0f-0000-4000-800a-`. No other test uses that prefix.

import { beforeAll, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { obs, READ, same, STEP, type Observation } from "../git/fact-runner";
import { serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { sha256 } from "../git/git-oracle";
import { commit, compare, outcome, readOk, SUCCEEDED } from "../git/hunk-harness";
import { gitOut, gitPaths, gitRun, markers, refMap, stageEntries, type GitHost, type GitResult, type RunOptions } from "../git/remote-fixtures";
import { openService, type RegistrationResult, type Service, type ServiceResponse } from "../git/service-harness";
import { ANY_EXIT, gitExe, INTEGRATE_ENV } from "../git/sync-harness";
import { buildWorkbench, FIXTURE_MERGE_RESULT, repoOf, wb, type WbFixture, type WbFixtureName } from "../git/workbench-fixtures";
import { buildF31, distroGitHost, globalConfig, sh } from "./fixtures";
import { inDistro, listScopes, uncPath, useWslFolder, wslExec, wslTest, type WslCapability, type WslHost } from "./wsl-host";

// Each test file calls this once at its top level. The fixture root and the owned distro folder end with each file,
// so the next file in the same process starts with a new host and new shared builds.
export function useWorkbenchWsl(): void {
  for (const module of ["session", "workbench-review", "switch", "branch-ops", "merge-rebase", "resolve", "worktrees", "git-settings", "trust", "file-publish", "hunk-publish", "multi-publish", "submodule-review", "submodule-update"]) {
    printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
  }
  printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);
  printOrigin("../git/workbench-fixtures.ts", import.meta.dir);
  printOrigin("../git/bun-runner.ts", import.meta.dir);
  useFixtureRoot();
  useWslFolder();
  printOrigin("./workbench-wsl-harness.ts", import.meta.dir);
  beforeAll(() => {
    distroHost = undefined;
    sharedBuilds.clear();
  });
}

export const TASK = "T081";
export const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55", "perl"];
export const FACT_MS = 900_000;
export const CASE_MS = 900_000;
// Each WSL step runs several `wsl.exe` processes, so a run can take longer than the default response wait of the harness.
export const RESPONSE_MS = 300_000;
// research.md R21 F21: an empty standard input ends the merge tool question at once.
export const MERGETOOL_MS = 60_000;
// Contract §11 "Process ownership": no Linux process of the operation remains 1 second after the Job close.
export const AFTER_CLOSE_MS = 1_000;
export const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
export const L = "--no-lazy-fetch";
// `check-ignore` refuses the literal pathspec magic (research.md R21 F1), so its reads omit it.
export const READ_IGNORE = ["--no-lazy-fetch", "--no-optional-locks"];
export const EMPTY = new Uint8Array();
export const TARGET = "refs/heads/target";
export const MESSAGE = "Arbareto: switch to target";
export const PUSH = [...STEP, "stash", "push", "--quiet", "-m", MESSAGE];
export const CHECKOUT_TARGET = [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "target", "--"];
export const REBASE_UP = [...STEP, "rebase", "--no-autostash", "--no-autosquash", "--end-of-options", "refs/heads/up"];
export const FIXED_USER = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";

// ---- The distro host, the owned global file, and the fixture transfer ----

export const mergeTool = (w: WslHost) => `${w.folder}/home/fixture-merge-tool.sh`;
// The quickstart.md fixture merge tool. A `\"` in a configuration value is a literal quote (git-config(1) "Syntax").
// Without `trustExitCode`, git-mergetool--lib `check_unchanged` decides by `test "$MERGED" -nt "$BACKUP"`. F21 `untrusted-fixture-tool-times` observed equal `%.9Y` times for this tool, so Git asks.
// With it, Git decides by the exit code (git-config(1) `mergetool.<tool>.trustExitCode`).
export const globalText = (w: WslHost, extra = "") => `${FIXED_USER}[mergetool "fixture"]\n\tcmd = '${mergeTool(w)}' \\"$MERGED\\"\n\ttrustExitCode = true\n${extra}`;

// The default `core.excludesFile` of the owned home (git-config(1)). The oracle reads it through `HOME`, and the double through `XDG_CONFIG_HOME`.
export const XDG_IGNORED = "xdg-ignored.txt";

export let distroHost: GitHost | undefined;
// One host for the file.
export function ensureHost(w: WslHost): GitHost {
  if (distroHost === undefined) {
    distroHost = distroGitHost(w, "wb", globalText(w), INTEGRATE_ENV);
    distroHost.write(mergeTool(w), `#!/bin/sh\nprintf '${FIXTURE_MERGE_RESULT.replace("\n", "\\n")}' > "$1"\n`);
    distroHost.write(`${w.folder}/home/.config/git/ignore`, `${XDG_IGNORED}\n`);
  }
  return distroHost;
}
// Each case starts with the owned global file of `globalText`, because `buildF31` rewrites it.
export function hostOf(w: WslHost, extra = ""): GitHost {
  const h = ensureHost(w);
  h.write(h.globalConfig, globalText(w, extra));
  return h;
}

// A fixture in the distro: the Linux paths of its root and main worktree, and the labels of its construction.
export interface DistroFixture {
  w: WslHost;
  h: GitHost;
  name: string;
  root: string;
  repo: string;
  oids: Record<string, string>;
  refs: Record<string, string>;
}

export const slash = (p: string) => p.replaceAll("\\", "/");
// The raw attribute lines of each `worktree list --porcelain -z` record (git-worktree(1) "Porcelain Format").
export const recordLines = (raw: string): string[][] => raw.split("\0\0").filter((r) => r !== "").map((r) => r.split("\0"));
export const valueOf = (lines: string[], label: string): string | null | undefined => {
  const line = lines.find((l) => l === label || l.startsWith(`${label} `));
  return line === undefined ? undefined : line === label ? null : line.slice(label.length + 1);
};

export let transfers = 0;
// The `tar` stream of the Windows build goes to `tar -x` in the distro. Git for Windows writes `core.symlinks`, `core.ignorecase`, and `core.filemode` at `init` (Windows facts), so the copy drops them.
// The linked worktrees hold Windows paths. Each `gitdir` file of the main Git folder takes the Linux prefix, also for a removed folder (gitrepository-layout(5) `worktrees/<id>/gitdir`).
// Then `git worktree repair` with the new paths rewrites the `.git` file of each existing linked worktree (git-worktree(1) "repair").
export function toDistro(w: WslHost, f: WbFixture): DistroFixture {
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

export let builds = 0;
// A new Windows build in the distro. T001 proves that two builds are equal, so a second build is the copy.
export const copy = (w: WslHost, name: WbFixtureName): DistroFixture => toDistro(w, buildWorkbench(gitExe(), name, `t081-${name}-${++builds}`));
export const sharedBuilds = new Map<WbFixtureName, DistroFixture>();
// One build per fixture for reads only.
export function shared(w: WslHost, name: WbFixtureName): DistroFixture {
  if (!sharedBuilds.has(name)) sharedBuilds.set(name, copy(w, name));
  return sharedBuilds.get(name)!;
}

// ---- Git calls in the distro ----

export interface Repo {
  w: WslHost;
  h: GitHost;
  dir: string;
}
export const at = (f: DistroFixture, dir = f.repo): Repo => ({ w: f.w, h: f.h, dir });
export const run = (r: Repo, args: string[], o: RunOptions = {}): GitResult => r.h.run(r.dir, args, o);
export const text = (res: GitResult) => res.stdout.toString("utf8");
export const out = (r: Repo, args: string[], o: RunOptions & { allowExit?: number[] } = {}) => gitOut(r.h, r.dir, args, o);
export const nul = (s: string) => s.split("\0").filter((x) => x !== "");
export const bytes = (s: string) => Buffer.from(s, "utf8");
// A timeout gives -1, which is no Git exit.
export const exitObs = (fact: string, expected: number | "nonzero", exit: number) => obs(fact, expected, exit, expected === "nonzero" ? exit > 0 : exit === expected);

export function headOf(r: Repo): string {
  const sym = run(r, ["symbolic-ref", "-q", "HEAD"]);
  return sym.exitCode === 0 ? text(sym).trim() : out(r, ["rev-parse", "HEAD"]).trim();
}
export const localConfig = (r: Repo) => gitPaths(r.h, r.dir, ["config"])[0]!;
export const fileDigest = (r: Repo, path: string) => {
  const b = r.h.read(path);
  return b === null ? "absent" : sha256(b);
};
export const indexDigest = (r: Repo) => fileDigest(r, gitPaths(r.h, r.dir, ["index"])[0]!);

// HEAD, refs, the index, working bytes, operation markers, and the local configuration bytes (the T003 `state`).
export function state(r: Repo): Record<string, unknown> {
  return { head: headOf(r), refs: refMap(r.h, r.dir), index: stageEntries(r.h, r.dir), files: r.h.digests(r.dir), markers: markers(r.h, r.dir), config: fileDigest(r, localConfig(r)) };
}
export const changed = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).filter((k) => !same(a[k], b[k]));

export function stashValue(r: Repo): string | null {
  const res = run(r, [...READ, "rev-parse", "--verify", "-q", "refs/stash"]);
  return res.exitCode === 0 ? text(res).trim() : null;
}
// `show-ref --exists` exits 2 for a missing ref (git-show-ref(1)).
export function stashReflog(r: Repo): string[] {
  if (run(r, [...READ, "show-ref", "--exists", "refs/stash"]).exitCode !== 0) return [];
  return nul(out(r, [...READ, "log", "-g", "-z", "--no-show-signature", "--format=%H", "refs/stash", "--"]));
}
export const message = (r: Repo, rev: string) => {
  const raw = out(r, ["cat-file", "commit", rev]);
  return raw.slice(raw.indexOf("\n\n") + 2);
};
export const subjects = (r: Repo, range: string[]) => out(r, ["log", "--reverse", "--format=%s", ...range]).split("\n").filter((l) => l !== "");
export const count = (r: Repo, args: string[]) => Number(out(r, [...READ, "rev-list", "--count", ...args]).trim());
// F10: the commits that a branch, tag, or remote-tracking ref reaches.
export const reachable = (r: Repo) => new Set(out(r, ["rev-list", "--branches", "--tags", "--remotes"]).split("\n").filter((l) => l !== ""));
export const stages = (r: Repo, path: string) => stageEntries(r.h, r.dir, [path]).map((e) => `${e.mode} ${e.stage}`);
export const logLines = (r: Repo, log: string) => (r.h.read(log)?.toString("utf8") ?? "").split("\n").filter((l) => l !== "");

// The kind of each path relative to `r.dir`: `l` link, `d` folder, `f` other, `a` absent. The output has one line per argument in order.
export function kindsOf(r: Repo, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const script = 'for p; do if [ -L "$p" ]; then echo l; elif [ -d "$p" ]; then echo d; elif [ -e "$p" ]; then echo f; else echo a; fi; done';
  return sh(r.w, script, paths, { cwd: r.dir }).stdout.split("\n").slice(0, paths.length);
}

// The plan.md D3 in-the-way check (research.md R4), built from its text. `bytes: false` counts a file only without a stage-0 entry at its path.
export function inTheWay(r: Repo, head: string, target: string, compareBytes = true): string[] {
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
export function canary(r: Repo, root: string, name: string, tail = ""): { command: string; log: string } {
  const log = `${root}/canaries/${name}.log`;
  const script = `${root}/canaries/${name}.sh`;
  r.h.write(script, `#!/bin/sh\necho "${name} $*" >> '${log}'\n${tail}`);
  return { command: `'${script}'`, log };
}
// A hook canary in the common Git folder. Git starts a hook only when its file exists and is executable.
export function hookCanary(f: DistroFixture, event: string): string {
  const log = `${f.root}/canaries/${event}.log`;
  f.h.write(`${f.root}/canaries/.keep`, "");
  f.h.write(`${f.repo}/.git/hooks/${event}`, `#!/bin/sh\necho "${event} $*" >> '${log}'\n`);
  return log;
}

// ---- Facts F1 to F24 and F29 to F31 in the distro (research.md R21, plan.md D18) ----

export function f1(w: WslHost): Observation[] {
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
export function colonPaths(w: WslHost): Observation[] {
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
export const COLON_FORMS: [string, string, { exit: number; paths: string[] }][] = [
  ["dot-slash", "./:x.txt", { exit: 0, paths: ["./:x.txt"] }],
  ["dot-slash-long-name", "./:(top)y.txt", { exit: 0, paths: ["./:(top)y.txt"] }],
  ["top-word", ":(top):x.txt", { exit: 0, paths: [":(top):x.txt"] }],
  ["top-word-long-name", ":(top):(top)y.txt", { exit: 0, paths: [":(top):(top)y.txt"] }],
  ["top-mnemonic", ":/::x.txt", { exit: 0, paths: [":/::x.txt"] }],
  ["empty-magic", ":::x.txt", { exit: 0, paths: [":::x.txt"] }],
  ["control-empty-magic-names-x", "::x.txt", { exit: 1, paths: [] }],
  ["control-literal-word-refused", ":(literal):x.txt", { exit: 128, paths: [] }],
];

export function f2(w: WslHost): Observation[] {
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

export function f3(w: WslHost): Observation[] {
  const r = at(copy(w, "switch-conflict"));
  const before = state(r);
  return [exitObs("F3.exit", "nonzero", run(r, CHECKOUT_TARGET).exitCode), obs("F3.changed", [], changed(before, state(r)))];
}

// The plan.md D3 stash protocol observations.
export function f4(w: WslHost): Observation[] {
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

export function f5(w: WslHost): Observation[] {
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

export function f6(w: WslHost): Observation[] {
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

export function f7(w: WslHost): Observation[] {
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

export function f8(w: WslHost): Observation[] {
  const a = at(copy(w, "switch-clean"));
  const contract = run(a, [...STEP, "checkout", "--no-guess", "--no-recurse-submodules", "-b", "topic", "--track=direct", "refs/remotes/one/topic", "--"]).exitCode;
  const b = at(copy(w, "switch-clean"));
  const own = run(b, ["checkout", "--track", "one/topic"]).exitCode;
  const keys = (r: Repo) => text(run(r, ["config", "--local", "-z", "--get-regexp", "^branch\\.topic\\."]));
  return [obs("F8.exits", { contract: 0, own: 0 }, { contract, own }), obs("F8.branch-keys", keys(b), keys(a)), obs("F8.differs-from-own", [], changed(state(a), state(b)))];
}

export function f9(w: WslHost): Observation[] {
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

export function f10(w: WslHost): Observation[] {
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

export function f11(w: WslHost): Observation[] {
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

export function f12(w: WslHost): Observation[] {
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

export function f13(w: WslHost): Observation[] {
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

export function f14(w: WslHost): Observation[] {
  const f = copy(w, "rebase-mix");
  const r = at(f);
  f.h.write(`${f.repo}/f.txt`, "f changed\n");
  const before = state(r);
  return [exitObs("F14.exit", "nonzero", run(r, REBASE_UP).exitCode), obs("F14.changed", [], changed(before, state(r)))];
}

export function f15(w: WslHost): Observation[] {
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

export function f16(w: WslHost): Observation[] {
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

export function f17(w: WslHost): Observation[] {
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

export function f18(w: WslHost): Observation[] {
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

export function f19(w: WslHost): Observation[] {
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
export function f20(w: WslHost): Observation[] {
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

export function f21(w: WslHost): Observation[] {
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

export function f22(w: WslHost): Observation[] {
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

export function f23(w: WslHost): Observation[] {
  const f = copy(w, "worktrees");
  const linked = at(f, `${f.root}/wt with spaces`);
  const path = out(linked, [...READ, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).trim();
  f.h.write(`${f.repo}/.git/info/exclude`, "f23-excluded.txt\n");
  f.h.write(`${linked.dir}/f23-excluded.txt`, "excluded\n");
  const ignored = run(linked, [...READ_IGNORE, "check-ignore", "-q", "--", "f23-excluded.txt"]).exitCode;
  return [obs("F23.path", "repo/.git/info/exclude", path.startsWith(`${f.root}/`) ? path.slice(f.root.length + 1) : path), obs("F23.check-ignore-exit", 0, ignored)];
}

// The merge tool names of the distro Git: the entries of `<exec path>/mergetools` (research.md R14).
export function f24(w: WslHost): Observation[] {
  const f = shared(w, "branches");
  const r = at(f);
  const exec = out(r, ["--exec-path"]).trim();
  const listed = wslExec(["--distribution", w.distro, "--cd", "/", "--exec", "/usr/bin/find", `${exec}/mergetools`, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0"]);
  const names = listed.exitCode === 0 ? nul(listed.stdout).sort() : null;
  return [obs("F24.mergetools-folder", "record", names, names !== null && names.length > 0), exitObs("F24.tool-help-exit", 0, run(r, ["mergetool", "--tool-help"]).exitCode)];
}

export function f29(w: WslHost): Observation[] {
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

export function f30(w: WslHost): Observation[] {
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
export const cQuote = (p: string) => `"${[...Buffer.from(p, "utf8")].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("")}"`;
export const hashPaths = (r: Repo, input: string) => {
  const res = run(r, [...READ, "hash-object", "--stdin-paths"], { input: bytes(input) });
  return { exit: res.exitCode, ids: text(res).split("\n").filter((l) => l !== "") };
};

export function f31(w: WslHost): Observation[] {
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
export function f31Names(w: WslHost): Observation[] {
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

export const FACTS: [string, string, (w: WslHost) => Observation[]][] = [
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

// ---- Service cases (quickstart.md Q26) ----

// Commit object IDs differ by time, so each commit counts as its tree, its subject, and the shapes of its parents (plan.md D19).
export function shapeState(r: Repo) {
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

export type Envelope = { repositoryId: string; repositoryGeneration?: number };
export interface Reviewed {
  action: string;
  plan: Record<string, unknown>;
  workbenchToken: string;
  reason?: string;
}
export type RunResult = Record<string, unknown> & { action: string; head?: { state: string; target?: string; oid?: string }; stash?: { oid: string | null; state: string } | null; staged?: boolean; operationState?: string; unmerged?: number };

export const unavailable = (reason: string, extra: object = {}) => ({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason, ...extra } });
export const refusalOf = (r: ServiceResponse<unknown>) => ({ ...outcome(r), result: r.result });
export const WITH_EFFECTS = { state: "failed-with-effects", code: "FAILED_WITH_EFFECTS" };

// One service session with the owned distro global file (BunRunnerOptions `wslGlobalConfig`). After the close, no scope of this process remains.
export async function withWsl(w: WslHost, name: string, body: (s: Service) => Promise<void>): Promise<void> {
  const s = await openService({ git: gitExe(), name, environment: serviceEnv(), wslGlobalConfig: globalConfig(w) });
  try {
    await body(s);
  } finally {
    await s.dispose();
  }
  expect(listScopes(w)).toEqual([]);
}

export const open = (s: Service, w: WslHost, dir: string): Promise<RegistrationResult> => s.register(uncPath(w, dir));
export const request = <R>(s: Service, operation: string, payload: object, envelope: Envelope) => s.response<R>(s.send(operation, payload, envelope), RESPONSE_MS);

// A review from a fresh read, so the generation is current.
export async function review(s: Service, r: RegistrationResult, payload: object): Promise<ServiceResponse<Reviewed>> {
  const read = await readOk(s, r.repositoryId);
  return request<Reviewed>(s, "reviewWorkbench", payload, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
}
export async function token(s: Service, r: RegistrationResult, payload: object): Promise<Reviewed> {
  const response = await review(s, r, payload);
  expect({ ...outcome(response), reason: response.result?.reason }).toEqual({ ...SUCCEEDED, reason: undefined });
  expect(typeof response.result!.workbenchToken).toBe("string");
  return response.result!;
}
export const sendRun = (s: Service, r: RegistrationResult, workbenchToken: string) => s.send("runWorkbench", { workbenchToken, start: true }, { repositoryId: r.repositoryId });
export const runToken = (s: Service, r: RegistrationResult, workbenchToken: string) => s.response<RunResult>(sendRun(s, r, workbenchToken), RESPONSE_MS);
export const reviewRun = async (s: Service, r: RegistrationResult, payload: object) => runToken(s, r, (await token(s, r, payload)).workbenchToken);
export const steps = (s: Service, from = 0, policies = ["integrate"]) => s.runner.calls.slice(from).filter((c) => policies.includes(c.environmentPolicy)).map((c) => [...c.arguments]);
export const subcommands = (s: Service, from = 0) => steps(s, from).map((a) => a.slice(1, a[1] === "stash" ? 3 : 2).join(" "));
export const confirms = (s: Service) => s.runner.frames.filter((f) => f.type === "confirm");
export const own = (f: DistroFixture, args: string[], allowExit = [0], dir = f.repo) => gitRun(f.h, dir, args, { allowExit });
export const switchTo = (choice: string, target: object = { ref: TARGET }) => ({ action: "switch", target, choice });

export const W = (name: string, body: (w: WslHost) => Promise<void>) =>
  wslTest(
    name,
    NEEDS,
    (w) => {
      hostOf(w);
      return body(w);
    },
    CASE_MS,
  );


// Data-model §8 from the distro list. `current` names the record path of the opened worktree.
export function oracleEntries(f: DistroFixture, current: string) {
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
export const worktreeState = (f: DistroFixture) => ({
  list: recordLines(out(at(f), ["worktree", "list", "--porcelain", "-z"])).map((lines) => lines.join("\n").replaceAll(f.root, "<root>")),
  refs: refMap(f.h, f.repo),
  head: headOf(at(f)),
  config: fileDigest(at(f), localConfig(at(f))),
});
