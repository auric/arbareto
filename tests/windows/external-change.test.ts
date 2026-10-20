// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { describeGit } from "../git/git-binary";
import { FIXTURE_ROOT, fixtureDir, fixtureGit, useFixtureRoot } from "../git/fixture-root";
import { indexEntries, rawIndexDigest, refState, workingFileDigests } from "../git/git-oracle";
import { buildImported, distroGit, writeLinux, type WslRepo } from "../wsl/fixtures";
import { useWslFolder, wslTest } from "../wsl/wsl-host";

const HELPER = printOrigin("./external-change.ts", import.meta.dir);
const TEST_BRANCH = "refs/heads/arbareto-external-change";
const TIMEOUT_MS = 60_000;

function run(args: string[]): { exitCode: number; out: string } {
  const proc = Bun.spawnSync([process.execPath, HELPER, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
  const out = proc.stdout.toString() + proc.stderr.toString();
  console.log(out.trimEnd());
  return { exitCode: proc.exitCode, out };
}

const helper = (git: string, args: string[]) => run([...args, "--git", git]);

function change(git: string, kind: string, repo: string, extra: string[] = ["--git", git]): { path: string | null } {
  const { exitCode, out } = run([kind, repo, ...extra]);
  expect(exitCode).toBe(0);
  const line = /^EXTERNAL_CHANGE kind=(\w+) start=(\d+) end=(\d+)(?: path=(.*))?$/m.exec(out);
  expect(line).not.toBeNull();
  expect(line![1]).toBe(kind);
  expect(BigInt(line![2]!)).toBeLessThan(BigInt(line![3]!));
  return { path: line![4] ?? null };
}

// A clean file `a.txt`, a file `b.txt` with two unstaged hunks, and an untracked file.
function makeRepo(git: string, name: string): string {
  const repo = fixtureDir(name);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  fixtureGit(git, repo, ["init", "-q"]);
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  writeFileSync(join(repo, "b.txt"), lines.join("\n") + "\n");
  fixtureGit(git, repo, ["add", "a.txt", "b.txt"]);
  fixtureGit(git, repo, ["commit", "-q", "-m", "base"]);
  fixtureGit(git, repo, ["branch", "side"]);
  writeFileSync(join(repo, "b.txt"), lines.map((l, i) => (i === 1 || i === 27 ? `${l} changed` : l)).join("\n") + "\n");
  writeFileSync(join(repo, "untracked.txt"), "untracked\n");
  return repo;
}

function repoState(git: string, repo: string) {
  return { index: rawIndexDigest(git, repo), entries: indexEntries(git, repo), refs: refState(git, repo), files: workingFileDigests(repo), status: fixtureGit(git, repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]) };
}

describeGit("T244 external-change helper", (git) => {
  useFixtureRoot();

  test(
    "the file change appends a line to a clean tracked file, and --restore returns it",
    () => {
      const repo = makeRepo(git, "file");
      const before = repoState(git, repo);
      const { path } = change(git, "file", repo);
      expect(path).toBe("a.txt");
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toMatch(/^alpha\n.+\n$/);
      expect(helper(git, ["file", repo]).exitCode).not.toBe(0);
      expect(helper(git, ["--restore", repo]).exitCode).toBe(0);
      expect(repoState(git, repo).files).toEqual(before.files);
      expect(repoState(git, repo).status).toBe(before.status);
    },
    TIMEOUT_MS,
  );

  test(
    "the index change stages a new blob for the file, and --restore returns the entry",
    () => {
      const repo = makeRepo(git, "index");
      const before = repoState(git, repo);
      change(git, "index", repo);
      const after = repoState(git, repo);
      expect(after.files).toEqual(before.files);
      expect(after.entries.find((e) => e.path === "a.txt")!.oid).not.toBe(before.entries.find((e) => e.path === "a.txt")!.oid);
      expect(helper(git, ["--restore", repo]).exitCode).toBe(0);
      expect(repoState(git, repo).entries).toEqual(before.entries);
      expect(repoState(git, repo).status).toBe(before.status);
    },
    TIMEOUT_MS,
  );

  test(
    "the ref change creates the test branch, and --restore deletes it",
    () => {
      const repo = makeRepo(git, "ref");
      const before = repoState(git, repo);
      change(git, "ref", repo);
      const after = refState(git, repo);
      expect(after.refs[TEST_BRANCH]).toBe(after.headOid!);
      expect(helper(git, ["--restore", repo]).exitCode).toBe(0);
      expect(refState(git, repo)).toEqual(before.refs);
    },
    TIMEOUT_MS,
  );

  test(
    "--restore-state returns the snapshot after a hunk stage and a commit, in place",
    () => {
      const repo = makeRepo(git, "state");
      const ids = () => [statSync(repo, { bigint: true }).ino, statSync(join(repo, ".git"), { bigint: true }).ino];
      const idsBefore = ids();
      expect(helper(git, ["--snapshot", repo]).exitCode).toBe(0);
      const before = repoState(git, repo);
      // Stage the first of the two hunks of b.txt.
      const patch = fixtureGit(git, repo, ["diff", "--", "b.txt"]);
      const second = patch.indexOf("\n@@", patch.indexOf("@@") + 2);
      fixtureGit(git, repo, ["apply", "--cached", "-"], patch.slice(0, second + 1));
      expect(fixtureGit(git, repo, ["diff", "--cached", "--name-only"])).toBe("b.txt\n");
      fixtureGit(git, repo, ["commit", "-q", "-m", "one hunk"]);
      fixtureGit(git, repo, ["branch", "extra"]);
      fixtureGit(git, repo, ["symbolic-ref", "HEAD", "refs/heads/side"]);
      expect(repoState(git, repo).refs).not.toEqual(before.refs);
      expect(helper(git, ["--restore-state", repo]).exitCode).toBe(0);
      const after = repoState(git, repo);
      expect(after.index).toBe(before.index);
      expect(after.refs).toEqual(before.refs);
      expect(after.files).toEqual(before.files);
      expect(after.status).toBe(before.status);
      expect(ids()).toEqual(idsBefore);
    },
    TIMEOUT_MS,
  );

  test("refuses a path outside an arbareto-fixtures- root, and the root itself", () => {
    const repo = makeRepo(git, "refuse");
    for (const path of [FIXTURE_ROOT, join(FIXTURE_ROOT, ".."), join(repo, "..", "..", "elsewhere")]) {
      const { exitCode, out } = helper(git, ["file", path]);
      expect(exitCode).toBe(3);
      expect(out).toContain("REFUSED");
    }
    expect(existsSync(`${repo}.external-change.json`)).toBe(false);
  });

  test("refuses a junction inside the root that leads outside it", () => {
    const escape = join(FIXTURE_ROOT, "escape");
    symlinkSync(tmpdir(), escape, "junction");
    const { exitCode, out } = helper(git, ["file", escape]);
    expect(exitCode).toBe(3);
    expect(out).toContain("REFUSED");
  });

  test("--restore-state takes index.lock before it writes a file, and refuses while the lock exists", () => {
    const repo = makeRepo(git, "locked");
    expect(helper(git, ["--snapshot", repo]).exitCode).toBe(0);
    writeFileSync(join(repo, "b.txt"), "changed after the snapshot\n");
    const lock = join(repo, ".git", "index.lock");
    writeFileSync(lock, "held by another process");
    expect(helper(git, ["--restore-state", repo]).exitCode).toBe(4);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("changed after the snapshot\n");
    expect(readFileSync(lock, "utf8")).toBe("held by another process");
    unlinkSync(lock);
  });

  test("--snapshot refuses a listed path that is a link or a reparse point", () => {
    const repo = makeRepo(git, "linked");
    const target = fixtureDir("link-target");
    writeFileSync(join(target, "inside.txt"), "inside\n");
    symlinkSync(target, join(repo, "junction"), "junction");
    const { exitCode, out } = helper(git, ["--snapshot", repo]);
    expect(exitCode).toBe(7);
    expect(out).toContain("LINK");
  });

  test("refuses without --git or ARBARETO_TEST_GIT", () => {
    const repo = makeRepo(git, "no-git");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key.toUpperCase() !== "ARBARETO_TEST_GIT") env[key] = value;
    const proc = Bun.spawnSync([process.execPath, HELPER, "file", repo], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    console.log(proc.stdout.toString() + proc.stderr.toString());
    expect(proc.exitCode).toBe(2);
    expect(existsSync(`${repo}.external-change.json`)).toBe(false);
  });
});

// The WSL case runs only when `ARBARETO_WSL_DISTRO` names the distro, so a plain run never starts the default distro.
const DISTRO = process.env.ARBARETO_WSL_DISTRO;
const WSL_NAME = "the --wsl path makes each change in the distro, and --restore returns the start state";
if (!DISTRO) {
  console.log(`SKIP ARBARETO_WSL_DISTRO unset: ${WSL_NAME}`);
  test.skip(`${WSL_NAME} (SKIP: ARBARETO_WSL_DISTRO unset)`, () => {});
} else {
  useWslFolder();
  // A clean file `a.txt`, a changed file `b.txt`, and an untracked file. Every read runs in the distro.
  const STREAM = "commit refs/heads/probe\ncommitter Arbareto Fixture <fixture@arbareto.invalid> 1767225600 +0000\ndata 4\nbase\nM 100644 inline a.txt\ndata 6\nalpha\n\nM 100644 inline b.txt\ndata 2\nb\n\n";
  const distroState = (r: WslRepo) => ({
    status: distroGit(r, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    entries: distroGit(r, ["--no-optional-locks", "ls-files", "-s", "-z"]),
    refs: distroGit(r, ["--no-optional-locks", "for-each-ref", "--format=%(refname)%00%(objectname)"]),
    files: distroGit(r, ["hash-object", "--no-filters", "--", "a.txt", "b.txt", "untracked.txt"]),
  });
  wslTest(
    WSL_NAME,
    ["wsl-fixture-fs-id"],
    (host) => {
      const r = buildImported(host, "repo", Buffer.from(STREAM));
      distroGit(r, ["reset", "-q", "--hard"]);
      writeLinux(host, `${r.dir}/b.txt`, "b changed\n");
      writeLinux(host, `${r.dir}/untracked.txt`, "untracked\n");
      const before = distroState(r);
      const head = distroGit(r, ["rev-parse", "--verify", "HEAD"]).trim();
      const alpha = distroGit(r, ["rev-parse", "--verify", ":a.txt"]).trim();
      const wsl = ["--wsl", host.distro];
      expect(change("", "file", r.dir, wsl).path).toBe("a.txt");
      expect(distroGit(r, ["hash-object", "--no-filters", "--", "a.txt"])).toBe(distroGit(r, ["hash-object", "--no-filters", "--stdin"], { input: Buffer.from("alpha\narbareto external change\n") }));
      expect(run(["--restore", r.dir, ...wsl]).exitCode).toBe(0);
      expect(distroState(r)).toEqual(before);
      expect(change("", "index", r.dir, wsl).path).toBe("a.txt");
      expect(distroGit(r, ["rev-parse", "--verify", ":a.txt"]).trim()).not.toBe(alpha);
      expect(distroGit(r, ["hash-object", "--no-filters", "--", "a.txt", "b.txt", "untracked.txt"])).toBe(before.files);
      expect(run(["--restore", r.dir, ...wsl]).exitCode).toBe(0);
      expect(distroState(r)).toEqual(before);
      expect(change("", "ref", r.dir, wsl).path).toBeNull();
      expect(distroGit(r, ["rev-parse", "--verify", TEST_BRANCH]).trim()).toBe(head);
      expect(run(["--restore", r.dir, ...wsl]).exitCode).toBe(0);
      expect(distroState(r)).toEqual(before);
    },
    4 * TIMEOUT_MS,
  );
}
