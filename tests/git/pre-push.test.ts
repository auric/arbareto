// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// `.githooks/pre-push` refuses a push whose new commits hold a private string. Real `git push` runs to a bare fixture remote.
// The fixture repository sets `core.hooksPath` in its own configuration only.

import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { describeGit, fixtureGitPath } from "./git-binary";
import { FIXED_TIMESTAMPS, fixtureDir, fixtureEnv, useFixtureRoot } from "./fixture-root";
import { put, run, type Repo } from "./fixtures";

const HOOKS = join(import.meta.dir, "..", "..", ".githooks");
printOrigin("../../scripts/pre-push.ts", import.meta.dir);
printOrigin("../../.githooks/pre-push", import.meta.dir);
useFixtureRoot();

const TIMEOUT_MS = 60_000;
// Joined at run time, so the scan of tracked files finds no private path in this source.
const PROFILE = ["C:", "Users", "jdoe", "notes"].join("\\");
const SECRET = ["acme", "internal"].join("-");

type Pair = Repo & { remote: Repo };

let count = 0;
function setup(git: string): Pair {
  const root = fixtureDir(`pre-push-${(count += 1)}`);
  const r: Pair = { git, dir: join(root, "repo"), pre: [], remote: { git, dir: join(root, "remote.git"), pre: [] } };
  for (const repo of [r.remote, r]) mkdirSync(repo.dir, { recursive: true });
  run(r.remote, ["init", "-q", "--bare", "-b", "main"]);
  run(r, ["init", "-q", "-b", "main"]);
  for (const [key, value] of [["core.autocrlf", "false"], ["core.hooksPath", HOOKS]]) run(r, ["config", key!, value!]);
  run(r, ["remote", "add", "origin", r.remote.dir]);
  return r;
}

function commit(r: Repo, file: string, content: string, message: string, extra: string[] = []): void {
  put(r.dir, file, content);
  run(r, ["add", "--", file]);
  run(r, ["commit", "-q", "--no-verify", "-m", message, ...extra]);
}

function push(r: Repo, args: string[]): { exitCode: number; stderr: string } {
  const child = Bun.spawnSync([fixtureGitPath(r.git), "push", "--porcelain", "origin", ...args], {
    cwd: r.dir,
    env: fixtureEnv(FIXED_TIMESTAMPS),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
  });
  const stderr = child.stderr.toString();
  console.log(stderr.replace(/^/gm, "push> "));
  return { exitCode: child.exitCode, stderr };
}

function patterns(r: Repo, text: string): void {
  writeFileSync(join(r.dir, ".git", "info", "private-patterns"), text);
}

const head = (r: Repo) => run(r, ["rev-parse", "HEAD"]).trim();
const remoteRefs = (r: Pair) => run(r.remote, ["for-each-ref", "--format=%(refname)"]).trim();

describeGit("pre-push hook", (git) => {
  test("Bun is on PATH for the hook", () => {
    expect(Bun.which("bun")).not.toBeNull();
  });

  test("a clean new branch pushes", () => {
    const r = setup(git);
    commit(r, "a.txt", "a\n", "clean");
    expect(push(r, ["main"]).exitCode).toBe(0);
    expect(remoteRefs(r)).toBe("refs/heads/main");
  }, TIMEOUT_MS);

  test("an added line with a private profile path refuses the push and names commit, path, line, and rule", () => {
    const r = setup(git);
    commit(r, "notes.txt", `clean\n${PROFILE}\\x\n`, "notes");
    const result = push(r, ["main"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`pre-push: ${head(r)} notes.txt:2 built-in 1 (Windows user profile)`);
    expect(remoteRefs(r)).toBe("");
  }, TIMEOUT_MS);

  test("a private pattern hit in the message or the author prints the pattern number, never the text", () => {
    const r = setup(git);
    patterns(r, `# local names\n${SECRET}\n\n`);
    commit(r, "a.txt", "a\n", `subject\n\nbody ${SECRET}-42\n`, ["--author", `Dev <${SECRET}@example.invalid>`]);
    const result = push(r, ["main"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`pre-push: ${head(r)} author <private pattern 2>`);
    expect(result.stderr).toContain(`pre-push: ${head(r)} message:3 <private pattern 2>`);
    expect(result.stderr).not.toContain(SECRET);
  }, TIMEOUT_MS);

  test("an invalid pattern refuses the push without the pattern text", () => {
    const r = setup(git);
    patterns(r, `ok\n(${SECRET}\n`);
    commit(r, "a.txt", "a\n", "clean");
    const result = push(r, ["main"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pre-push: line 2 of info/private-patterns is not a valid JavaScript regular expression.");
    expect(result.stderr).not.toContain(SECRET);
  }, TIMEOUT_MS);

  test("commits that the remote already has are out of scope, for an update and for a new branch", () => {
    const r = setup(git);
    commit(r, "old.txt", `${PROFILE}\\x\n`, "old");
    expect(push(r, ["--no-verify", "main"]).exitCode).toBe(0);
    commit(r, "b.txt", "b\n", "update");
    expect(push(r, ["main"]).exitCode).toBe(0);
    run(r, ["switch", "-q", "-c", "topic"]);
    commit(r, "c.txt", "c\n", "topic");
    expect(push(r, ["topic"]).exitCode).toBe(0);
    expect(push(r, [":topic"]).exitCode).toBe(0);
    expect(remoteRefs(r)).toBe("refs/heads/main");
  }, TIMEOUT_MS * 5);
});
