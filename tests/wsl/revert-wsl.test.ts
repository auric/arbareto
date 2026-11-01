// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T042: the three revert actions in a repository of the distro of `ARBARETO_WSL_DISTRO` (spec US5, SC-008, FR-043; plan.md D9; contract Δ11). `Local: WSL`, alone.
// Each case runs the service with the `tests/git/bun-runner.ts` double. The double runs the `fileFacts` and `wslFiles` Perl texts of `src/contracts/wsl-process.json`
// through the contract §11 wrapper with the arguments of `src-tauri/src/wsl.rs`, so every read and write in the distro is the shell's Perl. The frame layer is the double.
// Oracle (plan.md D13): Git's own command on a `cp -a` copy in the same distro. Digests come from `sha256sum` and modes from GNU `stat` inside the distro.
// T045: the safety case of research.md R15 "Probe L8 (T057)" runs the Perl text without the wrapper, as probe L8 does.

import { describe, expect } from "bun:test";
import { RunWorkbenchResult } from "../../src/contracts/envelope";
import { COMPARED_RAW_VERSION_BYTES } from "../../src/contracts/limits";
import { PROFILE_TEXTS } from "../../src/git-service/hunk-publish";
import { printOrigin } from "../origin";
import { serviceEnv, useFixtureRoot } from "../git/fixture-root";
import { compare, entryOf, hunksOf, outcome, patchOf, readOk, resultOf, SUCCEEDED } from "../git/hunk-harness";
import type { GitHost } from "../git/remote-fixtures";
import { openService, type RegistrationResult, type Service, type ServiceResponse, type WorkspaceResult } from "../git/service-harness";
import { gitExe } from "../git/sync-harness";
import { distroGitHost, globalConfig, sh } from "./fixtures";
import { listScopes, pgrep, uncPath, useWslFolder, WSL_FILES_TEXT, wslExec, wslTest, type WslCapability, type WslHost } from "./wsl-host";

for (const module of ["revert", "workbench-review", "wsl-files"]) printOrigin(`../../src/git-service/${module}.ts`, import.meta.dir);
printOrigin("../../src/contracts/wsl-process.json", import.meta.dir);
printOrigin("../git/bun-runner.ts", import.meta.dir);
printOrigin("./revert-wsl.test.ts", import.meta.dir);
useFixtureRoot();
useWslFolder();

const NEEDS: WslCapability[] = ["wsl-fixture-fs-id", "systemd-user-manager", "setsid", "distro-git-2.55", "perl"];
const CASE_MS = 900_000;
// Each WSL step runs several `wsl.exe` processes, so a response can take longer than the default wait of the harness.
const RESPONSE_MS = 300_000;
const HELD_MS = 60_000;
const PERL = "/usr/bin/perl";
const GLOBAL = "[user]\n\tname = Arbareto Fixture\n\temail = fixture@arbareto.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n";
const MIB = 1024 * 1024;

type FileOutcome = { entryId: string; outcome: string; code?: string; reason?: string };
type RevertRun = { action: string; files: FileOutcome[]; foldersCreated: string[]; index: string; reason?: string };
type Reviewed = { action: string; plan: Record<string, unknown>; workbenchToken: string };
type Category = "staged" | "unstaged" | "untracked";

// ---- The distro repositories ----

interface Repo {
  w: WslHost;
  h: GitHost;
  dir: string;
}

let distroHost: GitHost | undefined;
const hostOf = (w: WslHost) => (distroHost ??= distroGitHost(w, "t042", GLOBAL));
const owned = (w: WslHost, path: string) => {
  if (!path.startsWith(`${w.folder}/`)) throw new Error(`outside the owned folder: ${path}`);
  return path;
};

function git(r: Repo, args: string[], input?: Uint8Array): Buffer {
  const res = r.h.run(r.dir, args, input === undefined ? {} : { input });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${res.exitCode}: ${res.stderr.toString()}`);
  return res.stdout;
}

function put(r: Repo, path: string, content: string | Uint8Array, mode = ""): void {
  sh(r.w, 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1" && if [ -n "$2" ]; then chmod -- "$2" "$1"; fi', [owned(r.w, `${r.dir}/${path}`), mode], { input: Buffer.from(content) });
}

// One `/bin/sh` script in the worktree root with the arguments as an argument array.
const inRepo = (r: Repo, script: string, args: string[] = []) => sh(r.w, `cd -- "$1" && shift && ${script}`, [owned(r.w, r.dir), ...args]);

let builds = 0;
// `files` is the committed content, with its mode bits as the second value. `after` runs after the commit.
function build(w: WslHost, name: string, files: Record<string, string | [string, string]>, after?: (r: Repo) => void, config: [string, string][] = []): Repo {
  const h = hostOf(w);
  const r: Repo = { w, h, dir: owned(w, `${h.root}/${name}-${++builds}`) };
  sh(w, 'mkdir -p -- "$1"', [r.dir]);
  git(r, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.eol", "lf"], ["core.safecrlf", "false"], ...config]) git(r, ["config", key!, value!]);
  for (const [path, value] of Object.entries(files)) {
    const [content, mode] = typeof value === "string" ? [value, ""] : value;
    put(r, path, content, mode);
  }
  git(r, ["add", "-A"]);
  git(r, ["commit", "-q", "--no-verify", "-m", "base"]);
  after?.(r);
  return r;
}

const add = (r: Repo, ...paths: string[]) => git(r, ["--literal-pathspecs", "add", "--", ...paths]);
const indexOf = (r: Repo) => git(r, ["ls-files", "--stage", "-z"]).toString("latin1");
// The index entries and the SHA-256 of every working file, both from inside the distro.
const state = (r: Repo) => ({ index: indexOf(r), files: r.h.digests(r.dir) });
// GNU stat `%a %u %g %h`: the mode bits, the owner, the group, and the link count of each path.
function stats(r: Repo, paths: string[]): Record<string, string> {
  const lines = inRepo(r, 'stat -c "%a %u %g %h" -- "$@"', paths).stdout.trim().split("\n");
  return Object.fromEntries(paths.map((p, i) => [p, lines[i]!]));
}
// The Git temporary files and the `replace` temporary names in the worktree root.
const temps = (r: Repo) => inRepo(r, 'find . -maxdepth 1 \\( -name ".merge_file_*" -o -name ".arbareto-*" \\) -printf "%f\\n"').stdout.split("\n").filter((n) => n !== "");

// `cp -a` gives new inodes and change times, so the copy refreshes its index stat data before `apply --index` compares it (git-update-index(1) `--refresh`).
function copyOf(r: Repo): Repo {
  const copy = { ...r, dir: owned(r.w, `${r.dir}-oracle-${++builds}`) };
  r.h.copy(r.dir, copy.dir);
  r.h.run(copy.dir, ["update-index", "-q", "--refresh"]);
  return copy;
}

// One program as root in the distro, for a file of another distro user. False without root access.
const asRoot = (w: WslHost, program: string[]) => wslExec(["--distribution", w.distro, "--user", "root", "--cd", "/", "--exec", ...program]).exitCode === 0;
// `SYS_setxattr` from `syscall.ph`, as probe L6 sets `user.test` (research.md R15). False when the call fails.
const setUserTest = (r: Repo, path: string) =>
  wslExec(["--distribution", r.w.distro, "--cd", "/", "--exec", PERL, "-e", 'require "syscall.ph"; my ($path, $name, $value) = (@ARGV, "user.test", "v"); syscall(main::SYS_setxattr(), $path, $name, $value, 1, 0) == 0 or exit 1', "--", owned(r.w, `${r.dir}/${path}`)]).exitCode === 0;

// ---- The hunk text and the partial patch (plan.md D3 `unstage` rule), as `tests/git/revert-lines.test.ts` builds them ----

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  body: string[];
}

function parseHunk(text: string): Hunk {
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[0]!)!;
  return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), body: rows.slice(1) };
}

const changeOrdinals = (h: Hunk) => h.body.flatMap((line, i) => (line[0] === "+" || line[0] === "-" ? [i + 1] : []));

// An unselected `+` line becomes context, and an unselected `-` line drops. Null: the whole hunk.
function partialPatch(header: string, h: Hunk, picked: readonly number[] | null): Buffer {
  const body: string[] = [];
  h.body.forEach((line, i) => {
    if (picked === null || line[0] === " " || picked.includes(i + 1)) body.push(line);
    else if (line[0] === "+") body.push(` ${line.slice(1)}`);
  });
  const oldCount = body.filter((l) => l[0] !== "+" && l[0] !== "\\").length;
  const newCount = body.filter((l) => l[0] !== "-" && l[0] !== "\\").length;
  return Buffer.from(`${header}@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@\n${body.map((l) => `${l}\n`).join("")}`, "latin1");
}

// ---- Service steps ----

// One service session with the owned distro global file. After the close, no scope of this process remains.
async function withWsl(w: WslHost, name: string, body: (s: Service) => Promise<void>): Promise<void> {
  const s = await openService({ git: gitExe(), name, environment: serviceEnv(), wslGlobalConfig: globalConfig(w) });
  try {
    await body(s);
  } finally {
    await s.dispose();
  }
  expect(listScopes(w)).toEqual([]);
}

const b64 = (path: string) => Buffer.from(path).toString("base64");
const ask = <R>(s: Service, operation: string, payload: object, envelope: object) => s.response<R>(s.send(operation, payload, envelope), RESPONSE_MS);
const review = (s: Service, r: RegistrationResult, read: WorkspaceResult, payload: object) => ask<Reviewed>(s, "reviewWorkbench", { snapshotId: read.snapshotId, ...payload }, { repositoryId: r.repositoryId, repositoryGeneration: read.generation });
const refusal = (res: ServiceResponse<unknown>) => ({ state: res.state, code: res.code, result: res.result });
const idOf = (read: WorkspaceResult, path: string, category: Category) => entryOf(read, path, category).entryId;

async function reviewOk(s: Service, r: RegistrationResult, read: WorkspaceResult, payload: object): Promise<Reviewed> {
  const res = await review(s, r, read, payload);
  expect({ payload, ...outcome(res), result: res.state === "succeeded" ? "plan" : res.result }).toEqual({ payload, ...SUCCEEDED, result: "plan" });
  return res.result!;
}

const sendRun = (s: Service, r: RegistrationResult, token: string) => s.send("runWorkbench", { workbenchToken: token, start: true }, { repositoryId: r.repositoryId });
async function run(s: Service, r: RegistrationResult, token: string, requestId = sendRun(s, r, token)): Promise<ServiceResponse<RevertRun>> {
  const res = await s.response<RevertRun>(requestId, RESPONSE_MS);
  if (res.result !== undefined) expect(RunWorkbenchResult.safeParse(res.result).success).toBe(true);
  return res;
}

// The comparison of `path` and its hunks as text.
async function hunks(s: Service, r: RegistrationResult, read: WorkspaceResult, path: string, category: "staged" | "unstaged") {
  const c = await compare(s, r.repositoryId, path, category, read);
  expect({ path, ...outcome(c.response) }).toEqual({ path, ...SUCCEEDED });
  const patch = patchOf(resultOf(c));
  const text = Buffer.from(patch).toString("latin1");
  return { c, hunks: hunksOf(patch).map(parseHunk), header: text.slice(0, text.search(/^@@ /m)) };
}

// A revert of `picked` lines of hunk `at` (null: the whole hunk). `oracle` applies the same partial patch on a copy with Git.
async function linesCase(s: Service, r: RegistrationResult, repo: Repo, path: string, category: "staged" | "unstaged", at: number, pick: (h: Hunk) => number[] | null, oracle: string[]): Promise<void> {
  const read = await readOk(s, r.repositoryId);
  const { c, hunks: list, header } = await hunks(s, r, read, path, category);
  const h = list[at]!;
  const picked = pick(h);
  const label = { path, at, picked };
  const copy = copyOf(repo);
  git(copy, oracle, partialPatch(header, h, picked));
  const before = stats(repo, [path]);
  const reviewed = await reviewOk(s, r, read, { action: "revert-lines", comparisonId: c.comparisonId, hunkId: c.hunkIds[at]!, ...(picked === null ? {} : { lines: picked }) });
  expect({ ...label, plan: reviewed.plan }).toEqual({ ...label, plan: { scope: category, fileBytes: b64(path), lines: picked === null ? null : picked.length } });
  const done = await run(s, r, reviewed.workbenchToken);
  const index = category === "staged" ? "published" : "none";
  expect({ ...label, ...outcome(done), result: done.result }).toEqual({ ...label, ...SUCCEEDED, result: { action: "revert-lines", files: [{ entryId: c.entry.entryId, outcome: "reverted" }], foldersCreated: [], index } });
  // SC-008: the result equals Git's own command on the copy, and the mode bits, the owner, the group, and the link count stay.
  expect({ ...label, state: state(repo), stats: stats(repo, [path]) }).toEqual({ ...label, state: state(copy), stats: before });
}

const TWELVE = Array.from({ length: 12 }, (_, i) => `l${i + 1}\n`).join("");
const MIXED = TWELVE.replace("l2\n", "L2\n").replace("l5\n", "l5\nnew\n").replace("l8\n", "");
const THIRTY = Array.from({ length: 30 }, (_, i) => `t${i + 1}\n`).join("");
const TWO_HUNKS = THIRTY.replace("t3\n", "T3\nT3b\n").replace("t25\n", "");

const W = (name: string, body: (w: WslHost) => Promise<void>) => wslTest(name, NEEDS, (w) => body(w), CASE_MS);

describe("T042 the revert actions in the distro equal Git's own commands on a copy (spec US5, SC-008, plan.md D9)", () => {
  W("US1 lines and a hunk: the working bytes equal git apply -R on a copy; the 0755 mode, owner, group, and link count stay; the index stays", async (w) => {
    const repo = build(w, "us1", { "run.sh": [TWELVE, "755"], "two.txt": THIRTY, "keep.txt": "keep\n" }, (r) => {
      put(r, "run.sh", MIXED);
      put(r, "two.txt", TWO_HUNKS);
    });
    expect(stats(repo, ["run.sh"])["run.sh"]!.split(" ")[0]).toBe("755");
    await withWsl(w, "t042-us1", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      // Mixed body: ` l1 -l2 +L2 l3 l4 l5 +new l6 l7 -l8 l9 l10 l11`. The third change ordinal is the added `new` line.
      await linesCase(s, r, repo, "run.sh", "unstaged", 0, (h) => [changeOrdinals(h)[2]!], ["apply", "-R"]);
      await linesCase(s, r, repo, "run.sh", "unstaged", 0, () => null, ["apply", "-R"]);
      await linesCase(s, r, repo, "two.txt", "unstaged", 1, () => null, ["apply", "-R"]);
    });
  });

  W("US2 revert files: the index and the working bytes equal git restore --staged --worktree --source=HEAD on a copy; a staged new file keeps its working file; modes and folders equal Git's checkout", async (w) => {
    const files = { "run.sh": ["#!/bin/sh\necho 1\n", "755"] as [string, string], "mod.txt": "m1\n", "staged.txt": "s1\n", "part.txt": "p1\n", "sdel.txt": "d1\n", "deep/er/udel.txt": "u1\n", "keep.txt": "keep\n" };
    const repo = build(w, "us2", files, (r) => {
      put(r, "run.sh", "#!/bin/sh\necho 2\n");
      put(r, "mod.txt", "m2\n");
      put(r, "staged.txt", "s2\n");
      put(r, "part.txt", "p2\n");
      put(r, "new.txt", "n\n");
      add(r, "staged.txt", "part.txt", "new.txt");
      put(r, "part.txt", "p3\n");
      git(r, ["--literal-pathspecs", "rm", "-q", "--", "sdel.txt"]);
      inRepo(r, "rm -r -- deep");
    });
    const paths = ["run.sh", "mod.txt", "staged.txt", "part.txt", "sdel.txt", "deep/er/udel.txt"];
    const copy = copyOf(repo);
    git(copy, ["--literal-pathspecs", "restore", "--staged", "--worktree", "--source=HEAD", "--", ...paths]);
    // Spec FR-021: a staged new file loses its index entry and keeps its working file.
    git(copy, ["--literal-pathspecs", "rm", "-q", "--cached", "--", "new.txt"]);
    const before = stats(repo, ["run.sh"]);
    await withWsl(w, "t042-us2", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      const read = await readOk(s, r.repositoryId);
      const picked: [string, Category][] = [["run.sh", "unstaged"], ["mod.txt", "unstaged"], ["staged.txt", "staged"], ["part.txt", "unstaged"], ["sdel.txt", "staged"], ["deep/er/udel.txt", "unstaged"], ["new.txt", "staged"]];
      const reviewed = await reviewOk(s, r, read, { action: "revert-files", entryIds: picked.map(([path, category]) => idOf(read, path, category)) });
      expect<Record<string, unknown>>({ ...reviewed.plan, paths: (reviewed.plan.paths as string[]).toSorted() }).toEqual({ count: 7, paths: [...paths, "new.txt"].map(b64).toSorted(), newFiles: 1, staged: 4, unstaged: 4 });
      const done = await run(s, r, reviewed.workbenchToken);
      expect({ ...outcome(done), index: done.result?.index, outcomes: done.result?.files.map((f) => f.outcome), folders: done.result?.foldersCreated.toSorted() }).toEqual({ ...SUCCEEDED, index: "published", outcomes: Array(7).fill("reverted"), folders: [b64("deep"), b64("deep/er")] });
    });
    expect(state(repo)).toEqual(state(copy));
    expect(temps(repo)).toEqual([]);
    // SC-008: the written file keeps its mode bits, owner, group, and link count. A file and its folders that the write created equal Git's checkout.
    expect(stats(repo, ["run.sh"])).toEqual(before);
    expect(stats(repo, ["deep", "deep/er", "deep/er/udel.txt", "sdel.txt"])).toEqual(stats(copy, ["deep", "deep/er", "deep/er/udel.txt", "sdel.txt"]));
  });

  W("US3 revert all unstaged changes: the working bytes equal git restore . on a copy; the index, the staged-only file, and the untracked file stay; the 0755 mode stays", async (w) => {
    const repo = build(w, "us3", { "run.sh": ["#!/bin/sh\necho 1\n", "755"], "mod.txt": "m1\n", "part.txt": "p1\n", "del.txt": "d1\n", "staged.txt": "s1\n" }, (r) => {
      put(r, "run.sh", "#!/bin/sh\necho 2\n");
      put(r, "mod.txt", "m2\n");
      put(r, "part.txt", "p2\n");
      put(r, "staged.txt", "s2\n");
      add(r, "part.txt", "staged.txt");
      put(r, "part.txt", "p3\n");
      put(r, "untracked.txt", "u\n");
      inRepo(r, "rm -- del.txt");
    });
    const copy = copyOf(repo);
    git(copy, ["restore", "."]);
    const before = stats(repo, ["run.sh"]);
    await withWsl(w, "t042-us3", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      const read = await readOk(s, r.repositoryId);
      const reviewed = await reviewOk(s, r, read, { action: "revert-unstaged" });
      expect<Record<string, unknown>>({ ...reviewed.plan, paths: (reviewed.plan.paths as string[]).toSorted() }).toEqual({ count: 4, paths: ["del.txt", "mod.txt", "part.txt", "run.sh"].map(b64).toSorted(), submodules: 0 });
      const done = await run(s, r, reviewed.workbenchToken);
      expect({ ...outcome(done), index: done.result?.index, outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, index: "none", outcomes: Array(4).fill("reverted") });
    });
    expect(state(repo)).toEqual(state(copy));
    expect({ temps: temps(repo), run: stats(repo, ["run.sh"]), del: stats(repo, ["del.txt"]) }).toEqual({ temps: [], run: before, del: stats(copy, ["del.txt"]) });
  });

  W("US4 staged lines: the index equals git apply --cached -R and the working bytes git apply -R on a copy; the 0755 mode stays", async (w) => {
    const repo = build(w, "us4", { "run.sh": [TWELVE, "755"], "keep.txt": "keep\n" }, (r) => {
      put(r, "run.sh", MIXED);
      add(r, "run.sh");
    });
    await withWsl(w, "t042-us4", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      // The working file has no unstaged change, so `apply --index -R` reverts the index and the working file together.
      await linesCase(s, r, repo, "run.sh", "staged", 0, (h) => [changeOrdinals(h)[0]!, changeOrdinals(h)[1]!], ["apply", "--index", "-R"]);
      await linesCase(s, r, repo, "run.sh", "staged", 0, () => null, ["apply", "--index", "-R"]);
    });
  });

  W("the gid copy keeps a supplementary group; a file of another distro user refuses with owner at the review, a group outside the user's groups at the write; both keep their bytes", async (w) => {
    const groups = sh(w, "id -G").stdout.trim().split(/\s+/).map(Number);
    const second = groups.find((g) => g !== Number(sh(w, "id -g").stdout.trim()));
    const repo = build(w, "owner", { "grp.txt": "g1\n", "other.txt": "o1\n", "foreign.txt": "f1\n" }, (r) => {
      for (const name of ["grp.txt", "other.txt", "foreign.txt"]) put(r, name, `${name} changed\n`);
    });
    if (second !== undefined) inRepo(repo, 'chgrp -- "$1" grp.txt', [String(second)]);
    else console.log("SKIP supplementary-group: the distro user has one group (unverified)");
    const root = asRoot(w, ["/usr/bin/chown", "0", "--", `${repo.dir}/other.txt`]) && asRoot(w, ["/usr/bin/chgrp", "0", "--", `${repo.dir}/foreign.txt`]);
    if (!root) console.log("SKIP second-distro-user: no root access for a file of another distro user (unverified)");
    const copy = copyOf(repo);
    git(copy, ["--literal-pathspecs", "restore", "--worktree", "--", "grp.txt"]);
    await withWsl(w, "t042-owner", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      if (second !== undefined) {
        const before = stats(repo, ["grp.txt"]);
        const read = await readOk(s, r.repositoryId);
        const done = await run(s, r, (await reviewOk(s, r, read, { action: "revert-files", entryIds: [idOf(read, "grp.txt", "unstaged")] })).workbenchToken);
        expect({ ...outcome(done), outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, outcomes: ["reverted"] });
        expect({ stats: stats(repo, ["grp.txt"]), digest: state(repo).files["grp.txt"] }).toEqual({ stats: before, digest: state(copy).files["grp.txt"] });
        expect(before["grp.txt"]!.split(" ")[2]).toBe(String(second));
      }
      if (!root) return;
      const kept = (name: string) => ({ stats: stats(repo, [name]), digest: state(repo).files[name], temps: temps(repo) });
      // The `detail` read gives `own: false` by the rule of the write (`st_uid == $>`, plan.md D9), so the review refuses.
      const other = kept("other.txt");
      let read = await readOk(s, r.repositoryId);
      expect(refusal(await review(s, r, read, { action: "revert-files", entryIds: [idOf(read, "other.txt", "unstaged")] }))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "owner", files: [{ path: b64("other.txt"), reason: "owner" }], more: 0 } });
      expect(kept("other.txt")).toEqual(other);
      // The group needs the write: `fchown(-1, old gid)` on the temporary file gives EPERM, which refuses with owner (plan.md D9).
      const foreign = kept("foreign.txt");
      read = await readOk(s, r.repositoryId);
      const id = idOf(read, "foreign.txt", "unstaged");
      const done = await run(s, r, (await reviewOk(s, r, read, { action: "revert-files", entryIds: [id] })).workbenchToken);
      expect(refusal(done)).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { action: "revert-files", files: [{ entryId: id, outcome: "not-changed", code: "refused", reason: "owner" }], foldersCreated: [], index: "none" } });
      expect(kept("foreign.txt")).toEqual(foreign);
    });
  });

  W("xattr: a file with an extended attribute refuses each action at the review with xattr, and nothing changes", async (w) => {
    const repo = build(w, "xattr", { "x.txt": TWELVE }, (r) => put(r, "x.txt", MIXED));
    if (!setUserTest(repo, "x.txt")) {
      console.log("SKIP user-xattr: setxattr failed (unverified)");
      return;
    }
    const before = state(repo);
    await withWsl(w, "t042-xattr", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      const read = await readOk(s, r.repositoryId);
      const files = { reason: "xattr", files: [{ path: b64("x.txt"), reason: "xattr" }], more: 0 };
      expect(refusal(await review(s, r, read, { action: "revert-files", entryIds: [idOf(read, "x.txt", "unstaged")] }))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: files });
      expect(refusal(await review(s, r, read, { action: "revert-unstaged" }))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: files });
      const { c } = await hunks(s, r, read, "x.txt", "unstaged");
      expect(refusal(await review(s, r, read, { action: "revert-lines", comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! }))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "xattr" } });
    });
    expect(state(repo)).toEqual(before);
  });

  W("core.sharedRepository refuses a staged part with shared-repository; the revert of unstaged lines stays available and equals git apply -R on a copy", async (w) => {
    const repo = build(w, "shared", { "s.txt": TWELVE, "u.txt": THIRTY }, (r) => {
      put(r, "s.txt", MIXED);
      add(r, "s.txt");
      put(r, "u.txt", TWO_HUNKS);
    }, [["core.sharedRepository", "group"]]);
    const before = state(repo);
    const shared = { state: "failed", code: "UNSUPPORTED_HUNK_PROFILE", result: { reason: "shared-repository", remedy: { text: PROFILE_TEXTS["shared-repository"] } } };
    await withWsl(w, "t042-shared", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      const read = await readOk(s, r.repositoryId);
      const { c } = await hunks(s, r, read, "s.txt", "staged");
      expect(refusal(await review(s, r, read, { action: "revert-lines", comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! }))).toEqual(shared);
      expect(refusal(await review(s, r, read, { action: "revert-files", entryIds: [idOf(read, "s.txt", "staged")] }))).toEqual(shared);
      expect(state(repo)).toEqual(before);
      // Spec US5 scenario 3: an unstaged revert writes no repository file, so the reason does not apply to it.
      expect(outcome(await review(s, r, read, { action: "revert-unstaged" }))).toEqual(SUCCEEDED);
      await linesCase(s, r, repo, "u.txt", "unstaged", 0, () => null, ["apply", "-R"]);
    });
  });

  W("a 40 MiB whole file reverts with no file content across the boundary: Git's temporary file copies inside the distro, and each digest streams there", async (w) => {
    const repo = build(w, "big", { "keep.txt": "keep\n" }, (r) => {
      inRepo(r, "head -c 41943040 /dev/urandom > big.bin && chmod 755 big.bin");
      add(r, "big.bin");
      git(r, ["commit", "-q", "--no-verify", "-m", "big"]);
      inRepo(r, "printf X | dd of=big.bin bs=1 seek=20000000 conv=notrunc status=none");
    });
    const copy = copyOf(repo);
    git(copy, ["--literal-pathspecs", "restore", "--staged", "--worktree", "--source=HEAD", "--", "big.bin"]);
    const before = stats(repo, ["big.bin"]);
    await withWsl(w, "t042-big", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      const read = await readOk(s, r.repositoryId);
      const [frames, facts, calls] = [s.runner.frames.length, s.runner.fileFactCalls.length, s.runner.calls.length];
      const done = await run(s, r, (await reviewOk(s, r, read, { action: "revert-files", entryIds: [idOf(read, "big.bin", "unstaged")] })).workbenchToken);
      expect({ ...outcome(done), outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, outcomes: ["reverted"] });
      // Contract Δ11: the write names Git's temporary file and carries no bytes. The strict `working_reply` parse proves an output within 8 KiB.
      const writes = s.runner.frames.slice(frames).filter((f) => f.type === "fileReplace");
      expect(writes.map((f) => ({ bytes: "bytes" in f, size: (f.source as { size?: number } | undefined)?.size }))).toEqual([{ bytes: false, size: 40 * MIB }]);
      // No fact carries bytes. A digest of big.bin comes from `sha256sum` in the distro, because the bounded form gives no digest above 1 MiB.
      const read40 = s.runner.fileFactCalls.slice(facts).flatMap((call) => call.facts.map((fact, i) => ({ path: call.files[i]!.path.join("/"), fact })));
      expect(read40.filter(({ fact }) => "bytes" in fact)).toEqual([]);
      expect(read40.filter(({ path, fact }) => path === "big.bin" && "digest" in fact).length).toBeGreaterThan(0);
      // git-cat-file(1) `--batch-check`, git-checkout-index(1) `--temp`, and the other commands print names, modes, object IDs, or sizes, never blob content.
      const used = s.runner.calls.slice(calls);
      expect(used.filter((c) => (c.input?.length ?? 0) > 64 * 1024).map((c) => c.arguments.join(" "))).toEqual([]);
      const printing = used.filter((c) => {
        const sub = c.arguments.find((a) => !a.startsWith("-"));
        if (sub === "cat-file") return !c.arguments.includes("--batch-check");
        if (sub === "checkout-index") return !c.arguments.includes("--temp");
        return !["status", "ls-files", "check-attr", "version", "rev-parse", "config", "for-each-ref", "update-index", "symbolic-ref", "show-ref"].includes(sub ?? "");
      });
      console.log(`T042 big: Git subcommands ${JSON.stringify([...new Set(used.map((c) => c.arguments.filter((a) => !a.startsWith("--no-")).slice(0, 2).join(" ")))])}`);
      expect(printing.map((c) => c.arguments.join(" "))).toEqual([]);
    });
    expect(state(repo)).toEqual(state(copy));
    expect({ stats: stats(repo, ["big.bin"]), temps: temps(repo) }).toEqual({ stats: before, temps: [] });
  });

  W("a line revert of a 1 MiB file crosses at most 1 MiB out of the distro in one fileFacts content read and at most 1 MiB into it", async (w) => {
    // 16,384 lines of 64 bytes are 1,048,576 bytes. HEAD has line 100 one byte shorter.
    const lines = (short: number) => `awk 'BEGIN { for (i = 0; i < 16384; i++) printf(i == ${short} ? "%062d\\n" : "%063d\\n", i) }' > m.txt`;
    const repo = build(w, "mib", { "keep.txt": "keep\n" }, (r) => {
      inRepo(r, lines(100));
      add(r, "m.txt");
      git(r, ["commit", "-q", "--no-verify", "-m", "m"]);
      inRepo(r, lines(-1));
    });
    expect(Number(inRepo(repo, "stat -c %s -- m.txt").stdout.trim())).toBe(COMPARED_RAW_VERSION_BYTES);
    await withWsl(w, "t042-mib", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      const [frames, facts, calls] = [s.runner.frames.length, s.runner.fileFactCalls.length, s.runner.calls.length];
      await linesCase(s, r, repo, "m.txt", "unstaged", 0, () => null, ["apply", "-R"]);
      // Contract Δ11: out of the distro, the working bytes of one file through `fileFacts` `content`; into it, the new bytes of one file.
      const out = s.runner.fileFactCalls.slice(facts).map((call) => call.facts.flatMap((fact) => ("bytes" in fact && typeof fact.bytes === "string" ? [Buffer.from(fact.bytes, "base64").length] : []))).filter((sizes) => sizes.length > 0);
      expect(out.length).toBeGreaterThan(0);
      expect(out.filter((sizes) => sizes.length !== 1 || sizes[0]! > COMPARED_RAW_VERSION_BYTES)).toEqual([]);
      const into = [
        ...s.runner.frames.slice(frames).flatMap((f) => (f.type === "fileReplace" && typeof f.bytes === "string" ? [Buffer.from(f.bytes, "base64").length] : [])),
        ...s.runner.calls.slice(calls).flatMap((c) => (c.input === undefined ? [] : [c.input.length])),
      ];
      expect({ writes: into.length > 0, above: into.filter((n) => n > COMPARED_RAW_VERSION_BYTES) }).toEqual({ writes: true, above: [] });
    });
  });

  W("a Cancel during the WSL write gives interrupted: no fresh read comes before the process-end fact, the run ends canceled, and the file keeps its bytes", async (w) => {
    const repo = build(w, "interrupted", { "f.txt": "committed\n" }, (r) => put(r, "f.txt", "changed\n"));
    const before = state(repo);
    // A seam in place of `sha256sum`: the first call, the target digest of `replace_one`, waits until the test creates `go`. The wait has a 60-second bound.
    const own = owned(w, `${repo.dir}-seam`);
    const [seam, held, go] = [`${own}/sha256sum-hold`, `${own}/held`, `${own}/go`];
    sh(w, 'mkdir -p -- "$1"', [own]);
    put({ ...repo, dir: own }, "sha256sum-hold", `#!/bin/sh\necho x >> '${own}/calls'\nif [ "$(wc -l < '${own}/calls')" -eq 1 ]; then\n  : > '${held}'\n  i=0\n  while [ ! -e '${go}' ]; do\n    i=$((i + 1))\n    [ "$i" -gt 600 ] && exit 1\n    sleep 0.1\n  done\nfi\nexec '${w.probe.paths.sha256sum}' "$@"\n`, "755");
    const exists = (path: string) => sh(w, '[ -e "$1" ] && echo yes || echo no', [path]).stdout.trim() === "yes";
    await withWsl(w, "t042-interrupted", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      const read = await readOk(s, r.repositoryId);
      const id = idOf(read, "f.txt", "unstaged");
      const reviewed = await reviewOk(s, r, read, { action: "revert-files", entryIds: [id] });
      const walks: { kind: string; at: number }[] = [];
      s.runner.inject.holdWalk = async (kind) => void walks.push({ kind, at: performance.now() });
      s.runner.inject.wslSha256sum = seam;
      let stopAt = 0;
      let done: ServiceResponse<RevertRun>;
      let lingering: string[];
      try {
        const requestId = sendRun(s, r, reviewed.workbenchToken);
        const operationId = await s.operationId(requestId);
        for (const end = performance.now() + HELD_MS; !exists(held); await Bun.sleep(200)) {
          if (performance.now() >= end) throw new Error(`the seam did not hold within ${HELD_MS} ms`);
        }
        stopAt = performance.now();
        await s.cancel(operationId);
        done = await run(s, r, reviewed.workbenchToken, requestId);
        // The held seam belongs to the stopped process, so it ends before the process-end fact.
        lingering = pgrep(w, seam);
      } finally {
        sh(w, ': > "$1"', [go]);
        s.runner.inject.wslSha256sum = null;
        s.runner.inject.holdWalk = null;
      }
      // Plan.md D9 and workbench-review.ts `reconcile`: after `interrupted`, a `git version` exit with no active descendant is the process-end fact.
      const probe = (c: (typeof s.runner.calls)[number]) => c.environmentPolicy === "mutation" && c.arguments.join(" ") === "--no-lazy-fetch version";
      const facts = s.runner.calls.filter((c) => c.at >= stopAt && probe(c) && c.exit?.exitCode != null && c.exit.activeDescendants === 0 && c.durationMs !== undefined);
      expect(facts.length).toBeGreaterThan(0);
      const factEnd = Math.min(...facts.map((c) => c.at + c.durationMs!));
      const early = [...s.runner.calls.filter((c) => c.at >= stopAt && c.at < factEnd && !probe(c)).map((c) => c.arguments.join(" ")), ...walks.filter((x) => x.kind === "fileFacts" && x.at >= stopAt && x.at < factEnd).map((x) => x.kind)];
      expect({ early, lingering, ...refusal(done) }).toEqual({ early: [], lingering: [], state: "canceled", code: "CANCELED", result: { action: "revert-files", files: [{ entryId: id, outcome: "not-changed" }], foldersCreated: [], index: "none" } });
    });
    expect({ state: state(repo), temps: temps(repo) }).toEqual({ state: before, temps: [] });
  });
});

// ---- T045: the safety case of the T057 decision (research.md R15 "Probe L8 (T057)", plan.md D9) ----

// perlfunc `require`: a subroutine at the start of @INC runs first, and its `die` ends the `require`, as on a distro with only `perl-base`.
const HIDE_SYSCALL_PH = String.raw`BEGIN { unshift @INC, sub { die "T045 hides syscall.ph\n" if $_[1] eq 'syscall.ph'; return; } }`;
// perlsub "Overriding Built-in Functions": `CORE::GLOBAL::link` replaces `link` in the code compiled after it.
// The SIGKILL ends the process after the `link` of the temporary name to the target and before its `unlink`, as a stop of the shell does.
const STOP_AFTER_LINK = String.raw`BEGIN { *CORE::GLOBAL::link = sub { my $r = CORE::link($_[0], $_[1]); kill 'KILL', $$ if $r && $_[0] =~ /\A\.arbareto-[0-9]+-replace\.tmp\z/; $r } }`;

// The `wslFiles` text in mode `replace` without the wrapper, as probe L8 runs it. Null tokens: no exit 0, or the output does not end with NUL.
function replacePerl(r: Repo, before: string[], tokens: string[]): { exitCode: number | null; tokens: string[] | null } {
  const p = r.w.probe.paths;
  const program = [...before, WSL_FILES_TEXT].flatMap((part) => ["-e", part]);
  const res = wslExec(["--distribution", r.w.distro, "--cd", "/", "--exec", PERL, ...program, "--", "replace", r.dir, `${r.dir}/.git`, `${r.dir}/.git`, p.git!, p.sha256sum!], { input: Buffer.from(tokens.map((t) => `${t}\0`).join("")), timeoutMs: 60_000 });
  const body = Buffer.from(res.bytes);
  const ended = res.exitCode === 0 && body.length > 0 && body[body.length - 1] === 0;
  return { exitCode: res.exitCode, tokens: ended ? body.subarray(0, -1).toString("latin1").split("\0") : null };
}

// `wsl.rs` `working_command` of one file in the worktree root with present facts: GNU stat `%s %f %u %g %h` (`%f` is the raw `st_mode` in hex) and `sha256sum`.
function presentTokens(r: Repo, name: string, bytes: string): string[] {
  const m = /^(\d+) ([0-9a-f]+) (\d+) (\d+) (\d+)\n([0-9a-f]{64}) /.exec(inRepo(r, 'stat -c "%s %f %u %g %h" -- "$1" && sha256sum -- "$1"', [name]).stdout)!;
  return ["0", "0", "1", name, "working", "present", m[1]!, m[6]!, String(parseInt(m[2]!, 16)), m[3]!, m[4]!, m[5]!, "0", "bytes", Buffer.from(bytes).toString("hex")];
}

describe("T045 a stop between link and unlink without syscall.ph (research.md R15 \"Probe L8 (T057)\")", () => {
  W("the stop leaves .arbareto-<pid>-replace.tmp as a second link of the target; each next revert of that file refuses with hard-link and changes nothing; after the temporary name goes, the revert runs", async (w) => {
    const repo = build(w, "t045", { "f.txt": "base\n", "keep.txt": "keep\n" }, (r) => inRepo(r, "rm -- f.txt"));
    // The revert of the deleted file: an absent target with the HEAD bytes. Without `linkat`, `replace_one` takes the 005 named temporary file, then `link`.
    const stopped = replacePerl(repo, [HIDE_SYSCALL_PH, STOP_AFTER_LINK], ["0", "0", "1", "f.txt", "working", "absent", "100644", "0", "bytes", Buffer.from("base\n").toString("hex")]);
    // `wsl.rs` `working_reply`: an exit other than 0 with no reply is the unknown outcome `interrupted`.
    expect({ exit: stopped.exitCode === 0, tokens: stopped.tokens }).toEqual({ exit: false, tokens: null });
    const left = temps(repo);
    expect({ count: left.length, name: /^\.arbareto-[0-9]+-replace\.tmp$/.test(left[0] ?? "") }).toEqual({ count: 1, name: true });
    const tmp = left[0]!;
    // GNU stat `%i %h`: the inode and the link count. Both names hold the HEAD bytes in one inode.
    const inode = (name: string) => inRepo(repo, 'stat -c "%i %h" -- "$1"', [name]).stdout.trim();
    expect({ tmp: inode(tmp), links: inode("f.txt").split(" ")[1], bytes: repo.h.read(`${repo.dir}/f.txt`)?.toString() }).toEqual({ tmp: inode("f.txt"), links: "2", bytes: "base\n" });
    // The user edits the file through its name. Both names keep one inode with two links.
    inRepo(repo, 'printf "edit\\n" >> f.txt');
    const edited = { state: state(repo), stats: stats(repo, ["f.txt", tmp]) };
    // The next revert in the shell's Perl, without and with `syscall.ph`: the link count check comes before the `xattr` and `linkat` steps.
    for (const before of [[HIDE_SYSCALL_PH], []]) {
      const next = replacePerl(repo, before, presentTokens(repo, "f.txt", "base\n"));
      expect({ hidden: before.length === 1, tokens: next.tokens }).toEqual({ hidden: before.length === 1, tokens: ["refused", "hard-link", "0"] });
    }
    expect({ state: state(repo), stats: stats(repo, ["f.txt", tmp]) }).toEqual(edited);
    const hardLink = { reason: "hard-link", files: [{ path: b64("f.txt"), reason: "hard-link" }], more: 0 };
    await withWsl(w, "t045-hard-link", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      const read = await readOk(s, r.repositoryId);
      expect(refusal(await review(s, r, read, { action: "revert-files", entryIds: [idOf(read, "f.txt", "unstaged")] }))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: hardLink });
      expect(refusal(await review(s, r, read, { action: "revert-unstaged" }))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: hardLink });
      const { c } = await hunks(s, r, read, "f.txt", "unstaged");
      expect(refusal(await review(s, r, read, { action: "revert-lines", comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! }))).toEqual({ state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "hard-link" } });
      expect({ state: state(repo), stats: stats(repo, ["f.txt", tmp]) }).toEqual(edited);
      // Until the temporary name goes. Then the link count is 1, and Revert file restores the HEAD bytes.
      inRepo(repo, 'rm -- "$1"', [tmp]);
      const now = await readOk(s, r.repositoryId);
      const done = await run(s, r, (await reviewOk(s, r, now, { action: "revert-files", entryIds: [idOf(now, "f.txt", "unstaged")] })).workbenchToken);
      expect({ ...outcome(done), outcomes: done.result?.files.map((f) => f.outcome) }).toEqual({ ...SUCCEEDED, outcomes: ["reverted"] });
    });
    expect({ bytes: repo.h.read(`${repo.dir}/f.txt`)?.toString(), links: inode("f.txt").split(" ")[1], temps: temps(repo) }).toEqual({ bytes: "base\n", links: "1", temps: [] });
  });
});

// ---- T045: the `owner` finding of T042. The `detail` read gives `own` by the rule of the write (plan.md D9) ----

describe("T045 a file of another distro user is unavailable at the review (spec US5 scenario 2, data-model §7 `owner`)", () => {
  W("Revert file and Revert lines of a file that another distro user owns refuse at the review with owner", async (w) => {
    const repo = build(w, "owner-review", { "login.ts": TWELVE }, (r) => put(r, "login.ts", MIXED));
    if (!asRoot(w, ["/usr/bin/chown", "0", "--", `${repo.dir}/login.ts`])) {
      console.log("SKIP second-distro-user: no root access for a file of another distro user (unverified)");
      return;
    }
    await withWsl(w, "t042-owner-review", async (s) => {
      const r = await s.register(uncPath(w, repo.dir));
      const read = await readOk(s, r.repositoryId);
      const { c } = await hunks(s, r, read, "login.ts", "unstaged");
      const files = await review(s, r, read, { action: "revert-files", entryIds: [idOf(read, "login.ts", "unstaged")] });
      const lines = await review(s, r, read, { action: "revert-lines", comparisonId: c.comparisonId, hunkId: c.hunkIds[0]! });
      expect({ files: refusal(files), lines: refusal(lines) }).toEqual({
        files: { state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "owner", files: [{ path: b64("login.ts"), reason: "owner" }], more: 0 } },
        lines: { state: "failed", code: "WORKBENCH_UNAVAILABLE", result: { reason: "owner" } },
      });
    });
  });
});
