// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { describeGit, fixtureGitPath } from "../git/git-binary";
import { fixtureDir, fixtureEnv, fixtureGit, useFixtureRoot } from "../git/fixture-root";
import { renderNotices } from "../../scripts/release/notices-text";
import { readBlocks, releaseNotes } from "../../scripts/release/notes";
import { archiveName, hunspellSource, TAR } from "../../scripts/release/hunspell-source";
import type { Notices } from "../../src/frontend/build/notices";

// T018: the release file scripts (contracts/release.md §2 and §3, plan.md D5, D6, D9). Before T019 to T022 the imports fail, so every case fails.

printOrigin("../../scripts/release/notices-text.ts", import.meta.dir);
printOrigin("../../scripts/release/sums.ts", import.meta.dir);
printOrigin("../../scripts/release/notes.ts", import.meta.dir);
printOrigin("../../scripts/release/hunspell-source.ts", import.meta.dir);

useFixtureRoot();

const SCRIPTS = join(import.meta.dir, "..", "..", "scripts", "release");
const BLOCKS = join(import.meta.dir, "..", "..", ".github", "release-notes");

/** Runs one release script as a child. `tokens` holds the first two stderr tokens (contracts/release.md §2). */
function script(name: string, args: string[]): { code: number; stdout: string; tokens: string } {
  const proc = Bun.spawnSync([process.execPath, join(SCRIPTS, name), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), tokens: proc.stderr.toString().split(/\s+/).slice(0, 2).join(" ") };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const NOTICES: Notices = {
  repositoryUrl: "https://github.com/auric/arbareto",
  project: { license: "PROJECT-LICENCE-TEXT", notice: "PROJECT-NOTICE-TEXT" },
  texts: ["TEXT-ALPHA", "TEXT-BRAVO", "TEXT-CHARLIE"],
  groups: [
    { license: "Apache-2.0", packages: [{ name: "pkg-one", version: "1.0.0", files: [{ name: "LICENSE", text: 0 }] }] },
    {
      license: "MIT",
      packages: [
        { name: "pkg-two", version: "2.0.0", files: [{ name: "LICENSE", text: 1 }, { name: "NOTICE", text: 2 }] },
        { name: "pkg-three", files: [{ name: "LICENSE", text: 1 }] },
      ],
    },
  ],
};

describe("notices-text.ts", () => {
  test("every package with its version and every licence text appears exactly once, in JSON order", () => {
    const text = renderNotices(NOTICES);
    const needles = ["PROJECT-LICENCE-TEXT", "PROJECT-NOTICE-TEXT", "pkg-one 1.0.0", "pkg-two 2.0.0", "pkg-three", "TEXT-ALPHA", "TEXT-BRAVO", "TEXT-CHARLIE"];
    for (const needle of needles) expect(count(text, needle)).toBe(1);
    const positions = needles.map((n) => text.indexOf(n));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("a missing input gives RELEASE_NOTICES input", () => {
    const out = fixtureDir("notices-out");
    const result = script("notices-text.ts", ["--input", join(out, "absent.json"), "--out", out]);
    expect([result.code, result.tokens]).toEqual([1, "RELEASE_NOTICES input"]);
  });
});

describe("sums.ts", () => {
  const files = { "b-file.txt": "bravo\n", "a-file.tar.gz": "alpha", "C_File-1.exe": "charlie" };
  function release(name: string): string {
    const dir = fixtureDir(name);
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
    expect(script("sums.ts", ["write", dir]).code).toBe(0);
    return dir;
  }

  test("write gives sorted sha256sum lines with LF ends and one final LF", () => {
    const text = readFileSync(join(release("sums-write"), "SHA256SUMS.txt"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text.includes("\r")).toBe(false);
    const lines = text.slice(0, -1).split("\n");
    for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64} {2}[A-Za-z0-9._-]+$/);
    const names = lines.map((l) => l.slice(66));
    expect(names).toEqual(Object.keys(files).sort());
    expect(lines[names.indexOf("a-file.tar.gz")]!.slice(0, 64)).toBe(new Bun.CryptoHasher("sha256").update("alpha").digest("hex"));
  });

  test("verify passes on the written set", () => {
    expect(script("sums.ts", ["verify", release("sums-pass")]).code).toBe(0);
  });

  test("a changed byte gives RELEASE_SUMS mismatch", () => {
    const dir = release("sums-mismatch");
    writeFileSync(join(dir, "b-file.txt"), "bravO\n");
    const result = script("sums.ts", ["verify", dir]);
    expect([result.code, result.tokens]).toEqual([1, "RELEASE_SUMS mismatch"]);
  });

  test("a missing file gives RELEASE_SUMS missing", () => {
    const dir = release("sums-missing");
    rmSync(join(dir, "C_File-1.exe"));
    const result = script("sums.ts", ["verify", dir]);
    expect([result.code, result.tokens]).toEqual([1, "RELEASE_SUMS missing"]);
  });

  test("an extra file gives RELEASE_SUMS extra", () => {
    const dir = release("sums-extra");
    appendFileSync(join(dir, "d-extra.txt"), "delta");
    const result = script("sums.ts", ["verify", dir]);
    expect([result.code, result.tokens]).toEqual([1, "RELEASE_SUMS extra"]);
  });
});

describe("notes.ts", () => {
  const block = (name: string) => readFileSync(join(BLOCKS, name), "utf8");

  function notes(signing: string): string {
    const out = fixtureDir(`notes-${signing}`);
    const result = script("notes.ts", ["--version", "0.1.0", "--signing", signing, "--out", out]);
    expect(result.code).toBe(0);
    const path = result.stdout.trim();
    expect(existsSync(path)).toBe(true);
    return readFileSync(path, "utf8");
  }

  test("--signing off holds the CHANGELOG.md 0.1.0 section, then preview.md, prerequisites.md, and unsigned.md", () => {
    const text = notes("off");
    const parts = ["## [0.1.0]", block("preview.md"), block("prerequisites.md"), block("unsigned.md")];
    const positions = parts.map((p) => text.indexOf(p));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text.indexOf(block("signed.md"))).toBe(-1);
  });

  test("--signing signpath uses signed.md instead of unsigned.md", () => {
    const text = notes("signpath");
    expect(text.indexOf(block("signed.md"))).toBeGreaterThan(text.indexOf(block("prerequisites.md")));
    expect(text.indexOf(block("unsigned.md"))).toBe(-1);
  });

  test("a missing block file gives RELEASE_NOTES block with the file name", async () => {
    const dir = fixtureDir("notes-blocks");
    for (const name of ["preview.md", "prerequisites.md"]) writeFileSync(join(dir, name), block(name));
    expect(await readBlocks(dir, "off")).toEqual({ refusal: "RELEASE_NOTES block unsigned.md" });
    writeFileSync(join(dir, "unsigned.md"), "U\n");
    expect(await readBlocks(dir, "off")).toEqual({ blocks: { "preview.md": block("preview.md"), "prerequisites.md": block("prerequisites.md"), "unsigned.md": "U\n" } });
  });

  test("a missing section gives RELEASE_NOTES missing", () => {
    expect(releaseNotes("# Changelog\n\n## [0.0.9] - 2026-01-01\n\n- Item.\n", "0.1.0", {}, "off")).toBeNull();
    const result = script("notes.ts", ["--version", "0.0.0", "--signing", "off", "--out", fixtureDir("notes-missing")]);
    expect([result.code, result.tokens]).toEqual([1, "RELEASE_NOTES missing"]);
  });
});

describeGit("hunspell-source.ts", (git) => {
  // Two local bare repositories stand for github.com. No case uses the network.
  function upstream(label: string): { base: string; pins: { hunspell: string; hunspellWasm: string } } {
    const base = fixtureDir(`upstream-${label}`);
    const commit = (repo: string, file: string) => {
      const work = fixtureDir(`work-${label}-${file}`);
      fixtureGit(git, work, ["init", "--quiet"]);
      writeFileSync(join(work, file), `${file}\n`);
      fixtureGit(git, work, ["add", "--", file]);
      fixtureGit(git, work, ["commit", "--quiet", "-m", file]);
      const bare = join(base, repo);
      mkdirSync(join(bare, ".."), { recursive: true });
      fixtureGit(git, work, ["clone", "--quiet", "--bare", "--", work, bare]);
      return fixtureGit(git, work, ["rev-parse", "HEAD"]).trimEnd();
    };
    return { base, pins: { hunspell: commit("hunspell/hunspell", "hunspell.txt"), hunspellWasm: commit("rotemdan/hunspell-wasm", "wasm.txt") } };
  }

  test("the archive holds hunspell/, hunspell-wasm/, and SOURCE.txt with both commit IDs", () => {
    const { base, pins } = upstream("present");
    const out = fixtureDir("source-out");
    const result = hunspellSource({ version: "0.1.0", out, upstream: base, pins, git: fixtureGitPath(git), env: fixtureEnv(), work: fixtureDir("source-work") });
    expect(result).toEqual({ path: join(out, archiveName("0.1.0")) });
    const unpacked = fixtureDir("source-unpacked");
    const tar = Bun.spawnSync([TAR, "-xzf", join(out, archiveName("0.1.0")), "-C", unpacked], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(tar.exitCode).toBe(0);
    expect(readFileSync(join(unpacked, "hunspell", "hunspell.txt"), "utf8")).toBe("hunspell.txt\n");
    expect(readFileSync(join(unpacked, "hunspell-wasm", "wasm.txt"), "utf8")).toBe("wasm.txt\n");
    const source = readFileSync(join(unpacked, "SOURCE.txt"), "utf8");
    expect(count(source, pins.hunspell)).toBe(1);
    expect(count(source, pins.hunspellWasm)).toBe(1);
    expect(source).toContain("LGPL-2.1");
  });

  test("a pin that the upstream lacks gives RELEASE_SOURCE fetch", () => {
    const { base, pins } = upstream("absent");
    const out = fixtureDir("source-absent-out");
    const result = hunspellSource({ version: "0.1.0", out, upstream: base, pins: { ...pins, hunspell: "0123456789abcdef0123456789abcdef01234567" }, git: fixtureGitPath(git), env: fixtureEnv(), work: fixtureDir("source-absent-work") });
    expect("refusal" in result ? result.refusal.split(" ").slice(0, 3).join(" ") : "").toBe("RELEASE_SOURCE fetch hunspell/hunspell");
    expect(existsSync(join(out, archiveName("0.1.0")))).toBe(false);
  });
});
