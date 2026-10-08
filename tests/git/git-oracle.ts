// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Test oracle. It shares no code with `src/git-service/`.

import { closeSync, cpSync, existsSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fixtureEnv } from "./fixture-root";

// In-memory `ce_flags` bits from Git `read-cache-ll.h`. `ls-files --debug` prints that field in hexadecimal (builtin/ls-files.c `print_debug`). The debug format is not a stable interface, so T042 prints the Git version under test.
const CE_STAGEMASK = 0x3000;
const CE_STAGESHIFT = 12;
const CE_VALID = 0x8000;
const CE_INTENT_TO_ADD = 1 << 29;
const CE_SKIP_WORKTREE = 1 << 30;

// Git in-progress state files (Git `wt-status.c` `wt_status_get_state`), plus the canonical index lock.
const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "rebase-apply/applying", "sequencer", "index.lock"];

export interface IndexEntry {
  path: string;
  stage: number;
  mode: string;
  oid: string;
  assumeUnchanged: boolean;
  skipWorktree: boolean;
  intentToAdd: boolean;
}

export interface RefState {
  refs: Record<string, string>;
  headTarget: string | null;
  headOid: string | null;
}

// `config` holds `-c` arguments, such as the `disarm` list of a fixture.
function git(gitPath: string, repo: string, args: string[], allowExit: number[] = [0], config: string[] = [], env: Record<string, string> = {}): Uint8Array {
  const proc = Bun.spawnSync([gitPath, "--no-optional-locks", ...config, ...args], { cwd: repo, env: fixtureEnv(env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (!allowExit.includes(proc.exitCode)) throw new Error(`oracle git ${args.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  return proc.stdout;
}

// `git hook list -z --show-scope <event>` with the read options. The service runs no `hook list` (research R5 "T280 record"), so only the tests and probes build it.
export function hookListArgs(event: string): string[] {
  return ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs", "hook", "list", "-z", "--show-scope", event];
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// Reads in 1 MiB chunks, because a fixture file can be 512 MiB (F16 stage-input).
export function fileSha256(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const chunk = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) hasher.update(chunk.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hasher.digest("hex");
}

export function indexEntries(gitPath: string, repo: string, config: string[] = []): IndexEntry[] {
  const out = Buffer.from(git(gitPath, repo, ["ls-files", "-z", "--stage", "--debug"], [0], config));
  const entries: IndexEntry[] = [];
  let at = 0;
  while (at < out.length) {
    const nul = out.indexOf(0, at);
    const record = out.subarray(at, nul).toString("utf8");
    at = nul + 1;
    // Each entry is followed by five debug lines; the last holds `flags:`.
    let flagsLine = "";
    for (let i = 0; i < 5; i++) {
      const nl = out.indexOf(0x0a, at);
      flagsLine = out.subarray(at, nl).toString("utf8");
      at = nl + 1;
    }
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(record);
    const flagsMatch = /flags: ([0-9a-f]+)$/.exec(flagsLine);
    if (!match || !flagsMatch) throw new Error(`oracle cannot parse index entry: ${JSON.stringify(record)} ${JSON.stringify(flagsLine)}`);
    const flags = Number.parseInt(flagsMatch[1]!, 16);
    const stage = Number(match[3]);
    if (((flags & CE_STAGEMASK) >> CE_STAGESHIFT) !== stage) throw new Error(`oracle stage mismatch for ${match[4]}`);
    entries.push({
      path: match[4]!,
      stage,
      mode: match[1]!,
      oid: match[2]!,
      assumeUnchanged: (flags & CE_VALID) !== 0,
      skipWorktree: (flags & CE_SKIP_WORKTREE) !== 0,
      intentToAdd: (flags & CE_INTENT_TO_ADD) !== 0,
    });
  }
  return entries;
}

function gitPath(gitExe: string, repo: string, names: string[]): string[] {
  const args = names.flatMap((n) => ["--git-path", n]);
  return Buffer.from(git(gitExe, repo, ["rev-parse", ...args])).toString("utf8").trimEnd().split("\n").map((p) => resolve(repo, p));
}

// Null when the index file does not exist.
export function rawIndexDigest(gitExe: string, repo: string): string | null {
  const [path] = gitPath(gitExe, repo, ["index"]);
  return existsSync(path!) ? fileSha256(path!) : null;
}

// Keys are worktree-relative paths with `/`. The top-level `.git` entry is excluded. A link digest covers its target text.
export function workingFileDigests(worktree: string): Record<string, string> {
  const digests: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (prefix === "" && name === ".git") continue;
      const path = join(dir, name);
      const key = prefix + name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) digests[key] = `link:${sha256(Buffer.from(readlinkSync(path)))}`;
      else if (stat.isDirectory()) walk(path, `${key}/`);
      else digests[key] = fileSha256(path);
    }
  };
  walk(worktree, "");
  return digests;
}

export function refState(gitExe: string, repo: string): RefState {
  const refs: Record<string, string> = {};
  const listing = Buffer.from(git(gitExe, repo, ["for-each-ref", "--format=%(refname)%00%(objectname)"])).toString("utf8");
  for (const line of listing.split("\n")) {
    if (line === "") continue;
    const [name, oid] = line.split("\0");
    refs[name!] = oid!;
  }
  // `symbolic-ref -q` exits 1 for a detached HEAD. `rev-parse --verify -q` exits 1 for an unborn branch.
  const target = Buffer.from(git(gitExe, repo, ["symbolic-ref", "-q", "HEAD"], [0, 1])).toString("utf8").trim();
  const oid = Buffer.from(git(gitExe, repo, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1])).toString("utf8").trim();
  return { refs, headTarget: target || null, headOid: oid || null };
}

export interface SubmoduleUpdateResult {
  exitCode: number;
  // Keys are display paths relative to the superproject, nested ones included.
  heads: Record<string, string>;
  // Absolute Git folders, relative to the copy, with `/`.
  gitDirs: Record<string, string>;
  // `submodule.*` keys of the superproject configuration, each with its values in file order.
  keys: Record<string, string[]>;
}

// Git's own `submodule update --init --recursive` in a copy of `superDir`. `env` names the owned global file of the fixture.
export function submoduleUpdateOracle(gitExe: string, superDir: string, copyDir: string, env: Record<string, string>): SubmoduleUpdateResult {
  cpSync(superDir, copyDir, { recursive: true });
  const update = Bun.spawnSync([gitExe, "submodule", "update", "--init", "--recursive"], { cwd: copyDir, env: fixtureEnv(env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const heads: Record<string, string> = {};
  const gitDirs: Record<string, string> = {};
  const script = 'printf "%s\\0%s\\0%s\\0" "$displaypath" "$(git rev-parse HEAD)" "$(git rev-parse --absolute-git-dir)"';
  const fields = Buffer.from(git(gitExe, copyDir, ["submodule", "foreach", "--quiet", "--recursive", script], [0, 1, 128], [], env)).toString("utf8").split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    heads[fields[i]!] = fields[i + 1]!;
    gitDirs[fields[i]!] = relative(copyDir, fields[i + 2]!).replaceAll("\\", "/");
  }
  const keys: Record<string, string[]> = {};
  // `config -z`: each entry is "<key>\n<value>\0".
  for (const entry of Buffer.from(git(gitExe, copyDir, ["config", "--local", "-z", "--get-regexp", "^submodule\\."], [0, 1], [], env)).toString("utf8").split("\0")) {
    if (entry === "") continue;
    const nl = entry.indexOf("\n");
    (keys[entry.slice(0, nl)] ??= []).push(entry.slice(nl + 1));
  }
  return { exitCode: update.exitCode, heads, gitDirs, keys };
}

// The names of the present markers, in `OPERATION_MARKERS` order.
export function operationMarkers(gitExe: string, repo: string): string[] {
  const paths = gitPath(gitExe, repo, OPERATION_MARKERS);
  return OPERATION_MARKERS.filter((_, i) => existsSync(paths[i]!));
}
