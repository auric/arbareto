// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fixtures for the installed build and the clean environment (T141). Usage:
//   bun tests/windows/make-fixture.ts <Fxx>
//   bun tests/windows/make-fixture.ts --snapshot <fixture path>
//   bun tests/windows/make-fixture.ts --manifest <root>
//   bun tests/windows/make-fixture.ts --late-write <fixture path> <file>
// The tool never removes a built root. `removeTree` of `tests/git/fixture-root.ts` removes it.

import { appendFileSync, lstatSync, readdirSync, readlinkSync, realpathSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createFixtureRoot, FIXED_IDENTITY, FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, FixturePathRefusal, ownedGit, ownedPath, realGlobalConfigDigests, removeTree } from "../git/fixture-root";
import {
  buildChanged,
  buildF01,
  buildF02,
  buildF03,
  buildF04,
  buildF05,
  buildF06,
  buildF07,
  buildF08,
  buildF10,
  buildF11,
  buildF12,
  buildF14,
  buildF15,
  buildF16Status,
  buildF17,
  buildF18,
  buildF19,
  buildF20,
  buildF27,
  buildF28,
  buildF29,
  buildF30,
  CapabilitySkip,
  type Built,
} from "../git/fixtures";
import { GIT } from "../git/git-binary";
import { fileSha256, gitPath, historyRows, indexEntries, rawIndexDigest, refState, workingFileDigests } from "../git/git-oracle";

// One variant per name. A name without a "base" variant uses its first listed variant, except F19, which needs merge lanes for T158.
const BUILDERS: Record<string, (git: string, name: string) => Built> = {
  F01: (g, n) => buildF01(g, n, "unborn-added"),
  F02: (g, n) => buildF02(g, n, "base"),
  F03: (g, n) => buildF03(g, n),
  F04: (g, n) => buildF04(g, n, "autocrlf-false"),
  F05: (g, n) => buildF05(g, n, "base"),
  F06: (g, n) => buildF06(g, n),
  F07: (g, n) => buildF07(g, n),
  F08: (g, n) => buildF08(g, n, "sha1"),
  F09: (g, n) => buildChanged(g, n, "F09"),
  F10: (g, n) => buildF10(g, n, "lock"),
  F11: (g, n) => buildF11(g, n, "traditional"),
  F12: (g, n) => buildF12(g, n, "gc-auto"),
  F13: (g, n) => buildChanged(g, n, "F13"),
  F14: (g, n) => buildF14(g, n, "slow"),
  F15: (g, n) => buildF15(g, n),
  F16: (g, n) => buildF16Status(g, n, "at-limit"),
  F17: (g, n) => buildF17(g, n, "trust"),
  F18: (g, n) => buildF18(g, n, "files"),
  F19: (g, n) => buildF19(g, n, "merge"),
  F20: (g, n) => buildF20(g, n, "base"),
  F27: (g, n) => buildF27(g, n, "base"),
  F28: (g, n) => buildF28(g, n, "detached-unsaved"),
  F29: (g, n) => buildF29(g, n, "base"),
  F30: (g, n) => buildF30(g, n, "clone"),
};

const MANIFEST_NAME = "manifest.sha256";
const LATE_WRITE_TIMEOUT_MS = 30_000;
const LATE_WRITE_MARKER = "arbareto late write\n";
const TEMP = realpathSync.native(tmpdir());

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function requireGit(): string {
  if (GIT === null) fail("REFUSED no Git executable");
  return GIT;
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

// The owned `arbareto-fixtures-` root that holds `path`, and the resolved path. The root itself is allowed only when `allowRoot` is set.
function owned(path: string, allowRoot = false): { root: string; path: string } {
  let real: string;
  try {
    real = realpathSync.native(resolve(path));
  } catch {
    throw new FixturePathRefusal(`no such path: ${path}`);
  }
  const rel = relative(TEMP, real);
  const first = rel.split(sep)[0]!;
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || !fold(first).startsWith("arbareto-fixtures-")) {
    throw new FixturePathRefusal(`outside an arbareto-fixtures- root: ${real}`);
  }
  const root = join(TEMP, first);
  if (fold(real) === fold(root)) {
    if (!allowRoot) throw new FixturePathRefusal(`the fixture root is not a fixture path: ${real}`);
    return { root, path: root };
  }
  return { root, path: ownedPath(root, relative(root, real)) };
}

function build(id: string): void {
  const builder = BUILDERS[id];
  if (builder === undefined) fail(`REFUSED unknown fixture ${id}. Known: ${Object.keys(BUILDERS).join(" ")}`);
  const git = requireGit();
  const before = realGlobalConfigDigests(git);
  createFixtureRoot();
  try {
    // Git `Documentation/config/worktree.adoc`: `worktree.useRelativePaths` makes `worktree add` act as `--relative-paths`.
    if (id === "F07") appendFileSync(FIXTURE_GLOBAL_CONFIG, "[worktree]\n\tuseRelativePaths = true\n");
    const built = builder(git, id);
    if (id === "F02" || id === "F07") {
      for (const key of Object.keys(built.facts.repos)) {
        const dir = join(built.root, key);
        ownedGit(git, FIXTURE_ROOT, dir, ["config", "--local", "user.name", FIXED_IDENTITY.name]);
        ownedGit(git, FIXTURE_ROOT, dir, ["config", "--local", "user.email", FIXED_IDENTITY.email]);
      }
    }
    for (const key of Object.keys(built.facts.repos)) console.log(`REPO ${join(built.root, key)}`);
    console.log(`FIXTURE ${built.id} ${built.variant} ${built.root}`);
  } catch (error) {
    removeTree(FIXTURE_ROOT);
    if (error instanceof CapabilitySkip) fail(`REFUSED ${error.message}`);
    throw error;
  } finally {
    if (realGlobalConfigDigests(git).join("\n") !== before.join("\n")) fail("FAILED the real global Git configuration changed", 1);
  }
}

function snapshot(target: string): void {
  const git = requireGit();
  const { path } = owned(target);
  const refs = refState(git, path);
  const result = {
    path,
    entries: indexEntries(git, path),
    rawIndexSha256: rawIndexDigest(git, path),
    files: workingFileDigests(path),
    refs: refs.refs,
    headTarget: refs.headTarget,
    history: historyRows(git, path),
  };
  console.log(`SNAPSHOT ${JSON.stringify(result)}`);
}

// Lines in `sha256sum` form with `/` separators. A link is never followed. It is printed and left out of the file.
function manifest(target: string): void {
  const { path: root } = owned(target, true);
  const lines: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = prefix + name;
      if (key === MANIFEST_NAME) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) console.log(`MANIFEST_LINK ${key} -> ${readlinkSync(path)}`);
      else if (stat.isDirectory()) walk(path, `${key}/`);
      else lines.push(`${fileSha256(path)}  ${key}`);
    }
  };
  walk(root, "");
  const out = join(root, MANIFEST_NAME);
  writeFileSync(out, lines.map((l) => `${l}\n`).join(""));
  console.log(`MANIFEST ${out} ${lines.length} files`);
}

function lateWrite(target: string, fileArg: string): void {
  const git = requireGit();
  const { path: repo } = owned(target);
  const { path: file } = owned(fileArg);
  const [indexPath] = gitPath(git, repo, ["index"]);
  const indexName = basename(indexPath!);
  const watcher = watch(dirname(indexPath!));
  const timer = setTimeout(() => {
    watcher.close();
    fail(`LATE_WRITE_TIMEOUT no rename of ${indexPath} within ${LATE_WRITE_TIMEOUT_MS} ms`, 1);
  }, LATE_WRITE_TIMEOUT_MS);
  watcher.on("error", (error) => {
    clearTimeout(timer);
    fail(`LATE_WRITE_FAILED ${error.message}`, 1);
  });
  watcher.on("change", (eventType, filename) => {
    if (eventType !== "rename" || filename !== indexName) return;
    const eventTime = new Date().toISOString();
    watcher.close();
    clearTimeout(timer);
    appendFileSync(file, LATE_WRITE_MARKER);
    const writeTime = new Date().toISOString();
    console.log(`LATE_WRITE_EVENT ${eventTime}`);
    console.log(`LATE_WRITE_WRITTEN ${writeTime}`);
    console.log(`LATE_WRITE_SHA256 ${fileSha256(file)}`);
    process.exit(0);
  });
  console.log(`LATE_WRITE_WATCHING ${indexPath}`);
}

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === "--snapshot" && args.length === 1) snapshot(args[0]!);
  else if (mode === "--manifest" && args.length === 1) manifest(args[0]!);
  else if (mode === "--late-write" && args.length === 2) lateWrite(args[0]!, args[1]!);
  else if (mode !== undefined && !mode.startsWith("--") && args.length === 0) build(mode);
  else fail("usage: bun tests/windows/make-fixture.ts <Fxx> | --snapshot <fixture path> | --manifest <root> | --late-write <fixture path> <file>");
} catch (error) {
  if (error instanceof FixturePathRefusal) fail(`REFUSED ${error.message}`);
  throw error;
}
