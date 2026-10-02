// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, beforeAll } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { GIT } from "./git-binary";

export class FixturePathRefusal extends Error {}

// The 8.3 form of the temporary directory differs from the form that Git prints, so the root holds the long form.
export const FIXTURE_ROOT: string = join(realpathSync.native(tmpdir()), `arbareto-fixtures-${crypto.randomUUID()}`);
export const FIXTURE_HOME = join(FIXTURE_ROOT, "home");
export const FIXTURE_GLOBAL_CONFIG = join(FIXTURE_HOME, ".gitconfig");
export const FIXED_IDENTITY = { name: "Arbareto Fixture", email: "fixture@arbareto.invalid" } as const;
export const FIXED_TIMESTAMPS = { GIT_AUTHOR_DATE: "2026-01-01T00:00:00+0000", GIT_COMMITTER_DATE: "2026-01-01T00:00:00+0000" } as const;

// Read-only. Git prints the global files that the real environment selects (`git var GIT_CONFIG_GLOBAL`).
export function realGlobalConfigDigests(git: string): string[] {
  const proc = Bun.spawnSync([git, "var", "GIT_CONFIG_GLOBAL"], { cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const paths = proc.stdout.toString().trim().split(/\r?\n/).filter((p) => p !== "");
  if (proc.exitCode !== 0 || paths.length === 0) throw new Error(`git var GIT_CONFIG_GLOBAL exited ${proc.exitCode}`);
  const digest = (p: string) => (existsSync(p) ? new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex") : "missing");
  return paths.map((p) => `${p} ${digest(p)}`);
}

// Bun test runs no process exit handler, so each test file owns the root from its first test to its last.
// The non-recursive `mkdirSync` fails when another process holds the name.
export function useFixtureRoot(): void {
  let before: string[] = [];
  beforeAll(() => {
    if (GIT !== null) before = realGlobalConfigDigests(GIT);
    for (const line of before) console.log(`GLOBAL_CONFIG_SHA256 before ${line}`);
    mkdirSync(FIXTURE_ROOT);
    console.log(`FIXTURE_ROOT ${FIXTURE_ROOT}`);
    mkdirSync(join(FIXTURE_HOME, ".config"), { recursive: true });
    writeFileSync(
      FIXTURE_GLOBAL_CONFIG,
      `[user]\n\tname = ${FIXED_IDENTITY.name}\n\temail = ${FIXED_IDENTITY.email}\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n`,
    );
  });
  afterAll(() => {
    removeFixtureRoot();
    if (GIT === null) return;
    const after = realGlobalConfigDigests(GIT);
    for (const line of after) console.log(`GLOBAL_CONFIG_SHA256 after ${line}`);
    if (after.join("\n") !== before.join("\n")) throw new Error("the real global Git configuration changed");
  });
}

function canonical(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

// Resolves the deepest existing ancestor through the file system, so `..` segments and junctions resolve before the check.
export function fixturePath(...segments: string[]): string {
  const target = resolve(FIXTURE_ROOT, ...segments);
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new FixturePathRefusal(`no existing ancestor: ${target}`);
    existing = parent;
  }
  const real = join(realpathSync.native(existing), relative(existing, target));
  if (!canonical(real + sep).startsWith(canonical(FIXTURE_ROOT + sep)) || canonical(real) === canonical(FIXTURE_ROOT)) {
    throw new FixturePathRefusal(`outside the fixture root: ${target}`);
  }
  return real;
}

// T043 removes these from every fixture and service-under-test process.
const REMOVED = [/^GIT_CONFIG_PARAMETERS$/i, /^GIT_CONFIG_COUNT$/i, /^GIT_CONFIG_(KEY|VALUE)_\d+$/i, /^GIT_CONFIG$/i, /^GIT_(AUTHOR|COMMITTER)_/i, /^EMAIL$/i];
const REDIRECTED = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];

type Env = Record<string, string | undefined>;

// Windows variable names ignore case, so the filters compare without case.
function ownedEnv(base: Env, extra: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || REMOVED.some((r) => r.test(key)) || REDIRECTED.includes(key.toUpperCase())) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: FIXTURE_HOME,
    USERPROFILE: FIXTURE_HOME,
    XDG_CONFIG_HOME: join(FIXTURE_HOME, ".config"),
    GIT_CONFIG_GLOBAL: FIXTURE_GLOBAL_CONFIG,
  });
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}

// The environment of a fixture construction process.
export function fixtureEnv(extra: Env = {}, base: Env = process.env): Record<string, string> {
  return ownedEnv(base, { GIT_CONFIG_NOSYSTEM: "1", ...extra });
}

// The environment of a service-under-test process. It sets no `GIT_CONFIG_NOSYSTEM`.
export function serviceEnv(extra: Env = {}, base: Env = process.env): Record<string, string> {
  return ownedEnv(base, extra);
}

// Runs one fixture construction Git command with the fixed timestamps.
export function fixtureGit(git: string, cwd: string, args: string[], input?: string): string {
  const proc = Bun.spawnSync([git, ...args], {
    cwd: fixturePath(relative(FIXTURE_ROOT, cwd)),
    env: fixtureEnv({ ...FIXED_TIMESTAMPS }),
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

// Creates a directory under the root.
export function fixtureDir(name: string): string {
  const dir = fixturePath(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Never follows a link or junction. It removes the link only.
function removeTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    try {
      unlinkSync(path);
    } catch {
      rmdirSync(path);
    }
    return;
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) removeTree(join(path, name));
    rmdirSync(path);
    return;
  }
  // Git writes object files read-only.
  chmodSync(path, 0o666);
  unlinkSync(path);
}

export function removeFixtureRoot(): void {
  if (!existsSync(FIXTURE_ROOT)) return;
  removeTree(FIXTURE_ROOT);
  console.log(`FIXTURE_ROOT_REMOVED ${FIXTURE_ROOT} exists=${existsSync(FIXTURE_ROOT)}`);
}
