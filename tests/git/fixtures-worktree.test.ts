// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fixture builders F01 to F09 and F13 (T066). `fixture-root.ts` prints the ORIGIN of its contract file.

import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expectHunks, fixtureChecks, git1, paths, TIMEOUT } from "./fixture-checks";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { rawIndexDigest, sha256, workingFileDigests } from "./git-oracle";
import * as F from "./fixtures";

describeGit("fixture builders: F01 to F09 and F13", (git) => {
  useFixtureRoot();

  describe("cases", () => {
    const { check, filemodeTest } = fixtureChecks(git);

    test("F01 empty", () => check("F01 empty", (n) => F.buildF01(git, n, "empty"), (g, b) => expect(rawIndexDigest(g, join(b.root, "repo"))).toBeNull()), TIMEOUT);
    test("F01 unborn-added", () => check("F01 unborn-added", (n) => F.buildF01(git, n, "unborn-added")), TIMEOUT);

    for (const variant of ["base", "staged-hunks", "racy"] as const) {
      test(`F02 ${variant}`, () =>
        check(`F02 ${variant}`, (n) => F.buildF02(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          expectHunks(g, repo, b);
          if (variant !== "racy") return;
          // Racily clean: equal size and mtime in the index entry and the file, and the index file has the same second.
          const racy = b.facts.notes.racy as { path: string; unixSeconds: number };
          const stat = lstatSync(join(repo, racy.path));
          const index = lstatSync(join(repo, git1(g, repo, ["rev-parse", "--git-path", "index"]).toString().trim()));
          expect([Math.floor(stat.mtimeMs / 1000), Math.floor(index.mtimeMs / 1000), stat.size]).toEqual([racy.unixSeconds, racy.unixSeconds, Number(git1(g, repo, ["cat-file", "-s", `:${racy.path}`]).toString())]);
        }), TIMEOUT);
    }

    for (const variant of ["autocrlf-false", "autocrlf-true", "autocrlf-input", "eol-crlf", "safecrlf", "attributes"] as const) {
      test(`F04 ${variant}`, () =>
        check(`F04 ${variant}`, (n) => F.buildF04(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          const eol = F.eolInfo({ git: g, dir: repo, pre: [] });
          expect(eol).toEqual(b.facts.notes.eol as typeof eol);
          for (const [path, info] of Object.entries(eol)) if (path.endsWith(".txt")) expect(`${path} ${info.working}`).toBe(`${path} ${path.slice(path.lastIndexOf("/") + 1, -4)}`);
          expectHunks(g, repo, b);
          if (variant !== "safecrlf") return;
          // `git add` refuses the mixed file. It runs on a copy of the index, so the fixture stays unchanged.
          const copy = join(b.root, "index-copy");
          copyFileSync(join(repo, ".git", "index"), copy);
          expect(ownedGit(g, FIXTURE_ROOT, repo, ["add", "--", "mixed.txt"], { env: { GIT_INDEX_FILE: copy }, allowExit: [0, 128] }).length).toBe(0);
          expect(readFileSync(copy)).toEqual(readFileSync(join(repo, ".git", "index")));
        }), TIMEOUT);
    }

    for (const variant of ["index-crlf", "index-attribute", "ident-crlf", "mixed-over-lf", "ident"] as const) {
      test(`F04 stage ${variant}`, () =>
        check(`F04 stage ${variant}`, (n) => F.buildF04Stage(git, n, variant), (g, b) => {
          const repo = join(b.root, "repo");
          if (variant === "index-attribute") {
            expect(existsSync(join(repo, ".gitattributes"))).toBe(false);
            expect(git1(g, repo, ["check-attr", "--cached", "-z", "eol", "--", "f.txt"]).toString()).toBe("f.txt\0eol\0crlf\0");
          }
          // The candidate form (contract §4 step 5) on an index copy equals `git add` on another copy. Then both proofs run against its blob.
          const staged = (args: string[], input: string) => {
            const copy = join(b.root, `index-${args[0]}`);
            copyFileSync(join(repo, ".git", "index"), copy);
            ownedGit(g, FIXTURE_ROOT, repo, args, { env: { GIT_INDEX_FILE: copy }, input: Buffer.from(input) });
            const record = ownedGit(g, FIXTURE_ROOT, repo, ["ls-files", "-z", "--stage", "--", "f.txt"], { env: { GIT_INDEX_FILE: copy } }).toString();
            return record.slice(record.indexOf(" ") + 1, record.indexOf(" ", record.indexOf(" ") + 1));
          };
          const oid = staged(["update-index", "--add", "--remove", "-z", "--stdin"], "f.txt\0");
          expect(staged(["add", "--", "f.txt"], "")).toBe(oid);
          const working = readFileSync(join(repo, "f.txt"));
          const proofA = sha256(git1(g, repo, ["cat-file", "--filters", "--path=f.txt", oid])) === sha256(working);
          const proofB = ownedGit(g, FIXTURE_ROOT, repo, ["hash-object", "--stdin", "--path=f.txt"], { input: working }).toString().trim() === oid;
          expect({ a: proofA, b: proofB }).toEqual(b.facts.notes.blobProofs as { a: boolean; b: boolean });
        }), TIMEOUT);
    }

    test("F05 file-refusals", () =>
      check("F05 file-refusals", (n) => F.buildF05(git, n, "file-refusals"), (g, b) => {
        const repo = join(b.root, "super");
        expect(git1(g, join(repo, "nested"), ["rev-parse", "--show-toplevel"]).toString().trim()).toBe(realpathSync.native(join(repo, "nested")).replaceAll("\\", "/"));
        expect(git1(g, repo, ["diff", "--cached", "--no-renames", "--raw", "-z", "--", "new-link"]).toString().split("\0")[0]).toMatch(/^:000000 120000 /);
      }), TIMEOUT);

    test("F06 file-accepted", () =>
      check("F06 file-accepted", (n) => F.buildFileAccepted(git, n), (g, b) => {
        const repo = join(b.root, "repo");
        // Porcelain v2 `-z`: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>", and "2 <XY> ... <X><score> <path>" followed by the original path.
        const fields = git1(g, repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z"]).toString("utf8").split("\0");
        const renames: { xy: string; path: string; orig: string }[] = [];
        const modes: Record<string, [string, string]> = {};
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i]!.split(" ");
          if (f[0] === "2") renames.push({ xy: f[1]!, path: f.slice(9).join(" "), orig: fields[++i]! });
          if (f[0] === "1") modes[f.slice(8).join(" ")] = [f[4]!, f[5]!];
        }
        expect(renames.sort((x, y) => x.path.localeCompare(y.path))).toEqual([...(b.facts.notes.renames as typeof renames)].sort((x, y) => x.path.localeCompare(y.path)));
        const mode = b.facts.notes.modeChange as { path: string; index: string; working: string };
        expect(modes[mode.path]).toEqual([mode.index, mode.working]);
      }), TIMEOUT);

    for (const id of ["F09", "F13"] as const) {
      test(id, () => check(id, (n) => F.buildChanged(git, n, id), (g, b) => expectHunks(g, join(b.root, "repo"), b)), TIMEOUT);
    }

    test("F03", () =>
      check("F03", (n) => F.buildF03(git, n), (g, b) => {
        const repo = join(b.root, "repo");
        const long = b.facts.notes.longPath as { path: string; utf16Units: number; bunWrote: boolean };
        expect(long.utf16Units).toBeGreaterThanOrEqual(260);
        if (long.bunWrote) expect(Object.keys(workingFileDigests(repo))).toContain(long.path);
        const raw = git1(g, repo, ["ls-files", "-z", "--stage"]);
        expect(raw.includes(Buffer.from(b.facts.notes.invalidUtf8IndexPath as string, "hex"))).toBe(true);
        // `git init` probes the letter case of the file system and sets `core.ignorecase` only when it ignores case.
        const ignoreCase = git1(g, repo, ["config", "--get", "--type=bool", "core.ignorecase"], [0, 1]).toString().trim() === "true";
        expect({ ignoreCase }).toEqual({ ignoreCase: !((b.facts.notes.unverified as string[] | undefined) ?? []).includes("case-insensitive-fs") });
        console.log(`OBSERVATION T066: F03 long path of ${long.utf16Units} UTF-16 units: Bun wrote and read it back = ${long.bunWrote}; Git without core.longpaths lists it as untracked = ${paths(git1(g, repo, ["ls-files", "-o", "-z"])).includes(long.path)}`);
      }), TIMEOUT);

    test("F05", () =>
      check("F05", (n) => F.buildF05(git, n), (g, b) => {
        const subs = b.facts.notes.submodules as Record<string, { recorded: string; checkedOut: string }>;
        for (const [path, s] of Object.entries(subs)) expect(git1(g, join(b.root, "super", path), ["rev-parse", "HEAD"]).toString().trim()).toBe(s.checkedOut);
        expect(readFileSync(join(b.root, "super", ".gitmodules"), "utf8")).toContain("url = ../sub-src");
      }), TIMEOUT);

    test("F06", () => check("F06", (n) => F.buildF06(git, n)), TIMEOUT);

    test("F07", () =>
      check("F07", (n) => F.buildF07(git, n), (g, b) => {
        for (const [alias, target] of Object.entries((b.facts.notes.junctions as Record<string, string>) ?? {})) {
          expect(lstatSync(join(b.root, alias)).isSymbolicLink()).toBe(true);
          expect(realpathSync.native(join(b.root, alias))).toBe(realpathSync.native(join(b.root, target)));
        }
        const common = (wt: string) => git1(g, join(b.root, wt), ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
        const own = (wt: string) => git1(g, join(b.root, wt), ["rev-parse", "--path-format=absolute", "--git-dir"]).toString().trim();
        expect(common("wt-a")).toBe(common("main"));
        expect(new Set([own("main"), own("wt-a"), own("wt-b")]).size).toBe(3);
        expect(git1(g, join(b.root, "bare.git"), ["rev-parse", "--is-bare-repository"]).toString().trim()).toBe("true");
        expect(git1(g, join(b.root, "broken"), ["rev-parse", "--git-dir"], [128]).length).toBe(0);
      }), TIMEOUT);

    for (const variant of ["sha1", "sha256", "detached"] as const) {
      test(`F08 ${variant}`, () => check(`F08 ${variant}`, (n) => F.buildF08(git, n, variant)), TIMEOUT);
    }

    filemodeTest();
  });
});
