// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 007 T007: `scripts/release/check.ts` in real temporary repositories (contracts/release.md §2, plan.md D3, spec FR-012 to FR-014).
// Each case owns a repository with a bare `origin` that holds `main`. `git merge-base` run directly is the oracle of the git-failed code.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { printOrigin } from "../origin";
import { fixtureDir, fixtureEnv, fixtureGit, useFixtureRoot } from "./fixture-root";
import { describeGit, fixtureGitPath } from "./git-binary";

const CHECK = printOrigin("../../scripts/release/check.ts", import.meta.dir);
useFixtureRoot();

const TIMEOUT_MS = 60_000;
const CARGO = Bun.which("cargo");
const SIGNPATH = ["SIGNPATH_ORGANIZATION_ID", "SIGNPATH_PROJECT_SLUG", "SIGNPATH_POLICY_SLUG", "SIGNPATH_TOKEN_SET"];
const SIGNPATH_SET = { SIGNPATH_ORGANIZATION_ID: "org", SIGNPATH_PROJECT_SLUG: "project", SIGNPATH_POLICY_SLUG: "policy", SIGNPATH_TOKEN_SET: "true" };

interface Options {
  packageVersion?: string;
  tauriConfig?: Record<string, unknown>;
  previewConfig?: Record<string, unknown>;
  tag?: string | null;
  sideTag?: boolean;
  untracked?: boolean;
  /** One commit on `main` after the tag, pushed to `origin`. */
  headAhead?: boolean;
}

let count = 0;

function build(git: string, options: Options = {}): string {
  const root = fixtureDir(`release-check-${++count}`);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src-tauri", "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "arbareto", version: options.packageVersion ?? "0.1.0" }, null, 2)}\n`);
  writeFileSync(join(repo, "src-tauri", "Cargo.toml"), '[package]\nname = "arbareto"\nversion = "0.1.0"\nedition = "2024"\n');
  writeFileSync(join(repo, "src-tauri", "src", "main.rs"), "fn main() {}\n");
  writeFileSync(join(repo, "src-tauri", "tauri.conf.json"), `${JSON.stringify(options.tauriConfig ?? { productName: "Arbareto" }, null, 2)}\n`);
  if (options.previewConfig) writeFileSync(join(repo, "src-tauri", "tauri.preview.conf.json"), `${JSON.stringify(options.previewConfig, null, 2)}\n`);
  fixtureGit(git, root, ["init", "-q", "--bare", "-b", "main", "origin.git"]);
  fixtureGit(git, repo, ["init", "-q", "-b", "main"]);
  fixtureGit(git, repo, ["add", "--", "."]);
  fixtureGit(git, repo, ["commit", "-q", "--no-verify", "-m", "base"]);
  fixtureGit(git, repo, ["remote", "add", "origin", join(root, "origin.git")]);
  fixtureGit(git, repo, ["push", "-q", "origin", "main"]);
  if (options.sideTag) {
    fixtureGit(git, repo, ["switch", "-q", "-c", "side"]);
    fixtureGit(git, repo, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "side"]);
  }
  const tag = options.tag === undefined ? "v0.1.0" : options.tag;
  if (tag !== null) fixtureGit(git, repo, ["tag", "-a", "-m", tag, tag]);
  if (options.sideTag) fixtureGit(git, repo, ["switch", "-q", "main"]);
  if (options.headAhead) {
    fixtureGit(git, repo, ["commit", "-q", "--no-verify", "--allow-empty", "-m", "ahead"]);
    fixtureGit(git, repo, ["push", "-q", "origin", "main"]);
  }
  if (options.untracked) writeFileSync(join(repo, "untracked.txt"), "x\n");
  return repo;
}

// The child keeps the real Cargo and rustup homes (rustup documents `~/.cargo` and `~/.rustup` as the defaults), and finds the test Git first on PATH.
function childEnv(git: string, extra: Record<string, string>): Record<string, string> {
  const env = fixtureEnv({
    CARGO_HOME: process.env.CARGO_HOME || join(homedir(), ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME || join(homedir(), ".rustup"),
  });
  for (const key of Object.keys(env)) if (SIGNPATH.includes(key.toUpperCase())) delete env[key];
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${dirname(git)}${delimiter}${env[pathKey] ?? ""}`;
  return { ...env, ...extra };
}

function check(git: string, repo: string, args: string[], extra: Record<string, string> = {}): { code: number | null; lines: string[] } {
  const proc = Bun.spawnSync([process.execPath, CHECK, ...args], { cwd: repo, env: childEnv(git, extra), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS });
  const stderr = proc.stderr.toString();
  return { code: proc.exitCode, lines: stderr === "" ? [] : stderr.replace(/\r?\n$/, "").split(/\r?\n/) };
}

const release = (tag: string) => ["--mode", "release", "--tag", tag, "--signing", "off"];
const dryRun = ["--mode", "dry-run", "--signing", "off"];

function expectUsage(result: { code: number | null; lines: string[] }): void {
  expect(result.lines[0]?.split(" ").slice(0, 2)).toEqual(["RELEASE_CHECK", "usage"]);
  expect(result.code).toBe(1);
}

function expectRefusal(result: { code: number | null; lines: string[] }, line: string): void {
  expect(result.lines).toEqual([line]);
  expect(result.code).toBe(1);
}

function suite(git: string): void {
  test("a tag v0.1.0 on main with Cargo and package.json at 0.1.0 exits 0", () => {
    expect(check(git, build(git), release("v0.1.0"))).toEqual({ code: 0, lines: [] });
  }, TIMEOUT_MS);

  test("tag v0.1.1 gives tag-version", () => {
    expectRefusal(check(git, build(git, { tag: "v0.1.1" }), release("v0.1.1")), "RELEASE_CHECK tag-version v0.1.1 0.1.0");
  }, TIMEOUT_MS);

  test("tag v0.1 gives tag-version", () => {
    expectRefusal(check(git, build(git, { tag: "v0.1" }), release("v0.1")), "RELEASE_CHECK tag-version v0.1 0.1.0");
  }, TIMEOUT_MS);

  test("package.json 0.1.1 gives version-mismatch", () => {
    expectRefusal(check(git, build(git, { packageVersion: "0.1.1" }), release("v0.1.0")), "RELEASE_CHECK version-mismatch 0.1.0 0.1.1");
  }, TIMEOUT_MS);

  test("a version key in src-tauri/tauri.conf.json gives config-version", () => {
    const repo = build(git, { tauriConfig: { productName: "Arbareto", version: "0.1.0" } });
    expectRefusal(check(git, repo, release("v0.1.0")), "RELEASE_CHECK config-version src-tauri/tauri.conf.json");
  }, TIMEOUT_MS);

  test("a version key in src-tauri/tauri.preview.conf.json gives config-version", () => {
    const repo = build(git, { previewConfig: { version: "0.1.0" } });
    expectRefusal(check(git, repo, release("v0.1.0")), "RELEASE_CHECK config-version src-tauri/tauri.preview.conf.json");
  }, TIMEOUT_MS);

  test("--mode release without --tag gives usage", () => {
    expectUsage(check(git, build(git), ["--mode", "release", "--signing", "off"]));
  }, TIMEOUT_MS);

  test("a tag on main with HEAD one commit ahead gives not-tag-commit", () => {
    expectRefusal(check(git, build(git, { headAhead: true }), release("v0.1.0")), "RELEASE_CHECK not-tag-commit");
  }, TIMEOUT_MS);

  test("a tag on a commit outside origin/main gives not-on-main", () => {
    expectRefusal(check(git, build(git, { sideTag: true }), release("v0.1.0")), "RELEASE_CHECK not-on-main");
  }, TIMEOUT_MS);

  test("an unknown tag commit gives git-failed with the git merge-base exit code", () => {
    const repo = build(git, { tag: null });
    const oracle = Bun.spawnSync([fixtureGitPath(git), "merge-base", "--is-ancestor", "refs/tags/v0.1.0^{commit}", "refs/remotes/origin/main"], {
      cwd: repo,
      env: fixtureEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode;
    expect(oracle === 0 || oracle === 1).toBe(false);
    expectRefusal(check(git, repo, release("v0.1.0")), `RELEASE_CHECK git-failed ${oracle}`);
  }, TIMEOUT_MS);

  test("one untracked file gives dirty", () => {
    expectRefusal(check(git, build(git, { untracked: true }), release("v0.1.0")), "RELEASE_CHECK dirty");
  }, TIMEOUT_MS);

  test("--signing other gives signing-value", () => {
    expectRefusal(check(git, build(git), ["--mode", "release", "--tag", "v0.1.0", "--signing", "other"]), "RELEASE_CHECK signing-value other");
  }, TIMEOUT_MS);

  test("--signing signpath without SIGNPATH_PROJECT_SLUG gives signing-missing SIGNPATH_PROJECT_SLUG", () => {
    const args = ["--mode", "release", "--tag", "v0.1.0", "--signing", "signpath"];
    const extra = { SIGNPATH_ORGANIZATION_ID: "org", SIGNPATH_POLICY_SLUG: "policy" };
    expectRefusal(check(git, build(git), args, extra), "RELEASE_CHECK signing-missing SIGNPATH_PROJECT_SLUG");
  }, TIMEOUT_MS);

  // The workflow sets SIGNPATH_TOKEN_SET from `secrets.SIGNPATH_API_TOKEN != ''`, which gives the text `true` or `false`.
  for (const value of [undefined, "false", "True"]) {
    test(`--signing signpath with SIGNPATH_TOKEN_SET ${value ?? "absent"} gives signing-missing SIGNPATH_API_TOKEN`, () => {
      const args = ["--mode", "release", "--tag", "v0.1.0", "--signing", "signpath"];
      const { SIGNPATH_TOKEN_SET: _, ...names } = SIGNPATH_SET;
      const extra = value === undefined ? names : { ...names, SIGNPATH_TOKEN_SET: value };
      expectRefusal(check(git, build(git), args, extra), "RELEASE_CHECK signing-missing SIGNPATH_API_TOKEN");
    }, TIMEOUT_MS);
  }

  test("--signing signpath with the three SignPath variables and SIGNPATH_TOKEN_SET true exits 0", () => {
    const args = ["--mode", "release", "--tag", "v0.1.0", "--signing", "signpath"];
    expect(check(git, build(git), args, SIGNPATH_SET)).toEqual({ code: 0, lines: [] });
  }, TIMEOUT_MS);

  test("--mode dry-run skips the tag and main checks", () => {
    expect(check(git, build(git, { tag: null }), dryRun)).toEqual({ code: 0, lines: [] });
  }, TIMEOUT_MS);

  test("--mode dry-run keeps the version check", () => {
    expectRefusal(check(git, build(git, { packageVersion: "0.1.1" }), dryRun), "RELEASE_CHECK version-mismatch 0.1.0 0.1.1");
  }, TIMEOUT_MS);

  test("--mode dry-run keeps the tree check", () => {
    expectRefusal(check(git, build(git, { untracked: true }), dryRun), "RELEASE_CHECK dirty");
  }, TIMEOUT_MS);
}

describeGit("release check (T007)", (git) => {
  if (CARGO === null) {
    console.log("SKIP: cargo absent");
    describe.skip("release check (SKIP: cargo absent)", () => {});
    return;
  }
  suite(git);
});
