// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import type { FileFact } from "../../src/contracts/channel";
import { DISCARD_CHECK_PATHS } from "../../src/contracts/limits";
import { discardCandidates, ignoredFilesOf, ignoreRead, inTheWay, IN_THE_WAY_PATHS, nestedVerdict, sortFacts, untrackedOf } from "../../src/git-service/switch-check";

printOrigin("../../src/git-service/switch-check.ts", import.meta.dir);

// FR-011, plan.md D3, research.md R4, R21 F1, F7, and contract Δ3 `reviewWorkbench` `switch` (T011).
// The Git outputs follow the forms that Git 2.56.0.windows.2 printed for a fixture of the same shape.

const raw = (text: string): Uint8Array => Buffer.from(text, "latin1");
const utf8 = (text: string): string => Buffer.from(text, "utf8").toString("latin1");
const A = "a".repeat(40);

const FILE: FileFact = { kind: "file", size: 1, lastWrite: "1" };
const DIR: FileFact = { kind: "directory" };
const ABSENT: FileFact = { kind: "absent" };
const link = (component: number): FileFact => ({ kind: "link", component, tag: "symlink", target: "t", relative: true });

const DIFF_TREE = "M\0a.txt\0A\0dir/x.txt\0D\0gone.txt\0A\0new.txt\0A\0deep/er/y.txt\0T\0swap\0";
const stage0 = (...paths: string[]) => raw(paths.map((p) => `100644 ${A} 0\t${p}\0`).join(""));

describe("discard candidates (research.md R4)", () => {
  test("A, M, and T paths with each leading folder, and D paths", () => {
    const c = discardCandidates(raw(DIFF_TREE));
    if (typeof c === "string") throw new Error(c);
    expect(c.paths).toEqual(["a.txt", "dir/x.txt", "dir", "gone.txt", "new.txt", "deep/er/y.txt", "deep", "deep/er", "swap"]);
    expect([...c.writes]).toEqual(["a.txt", "dir/x.txt", "new.txt", "deep/er/y.txt", "swap"]);
  });

  test("a folder that several paths share is one candidate", () => {
    const c = discardCandidates(raw("A\0d/a\0A\0d/b\0"));
    expect(typeof c !== "string" && c.paths).toEqual(["d/a", "d", "d/b"]);
  });

  test("equal trees give no candidate", () => expect(discardCandidates(raw(""))).toEqual({ paths: [], writes: new Set() }));

  test("paths are byte strings", () => {
    const c = discardCandidates(raw(utf8("A\0ä/ü.txt\0")));
    expect(typeof c !== "string" && c.paths).toEqual([utf8("ä/ü.txt"), utf8("ä")]);
  });

  test(`above ${DISCARD_CHECK_PATHS} candidates the check refuses`, () => {
    expect(DISCARD_CHECK_PATHS).toBe(20_000);
    const files = (n: number) => raw(Array.from({ length: n }, (_, i) => `A\0f${i}\0`).join(""));
    expect(discardCandidates(files(20_000))).toMatchObject({ paths: { length: 20_000 } });
    expect(discardCandidates(files(20_001))).toBe("limit");
    // Each file in its own folder gives two candidates, so the leading folders count.
    const nested = (n: number) => raw(Array.from({ length: n }, (_, i) => `A\0d${i}/f\0`).join(""));
    expect(discardCandidates(nested(10_000))).toMatchObject({ paths: { length: 20_000 } });
    expect(discardCandidates(nested(10_001))).toBe("limit");
  });

  const malformed: [string, string][] = [
    ["no final NUL", "A\0a"],
    ["a status without a path", "A\0"],
    ["an empty path", "A\0\0"],
    ["a rename status", "R100\0a\0b\0"],
    ["an unknown status", "X\0a\0"],
    ["a path with a leading slash", "A\0/a\0"],
    ["a path with an empty component", "A\0a//b\0"],
  ];
  for (const [name, output] of malformed) test(`${name} is malformed`, () => expect(discardCandidates(raw(output))).toBe("malformed"));
});

describe("file facts (plan.md D3)", () => {
  const c = discardCandidates(raw(DIFF_TREE));
  if (typeof c === "string") throw new Error(c);
  const facts = (overrides: Record<string, FileFact>) => c.paths.map((p) => overrides[p] ?? ABSENT);

  test("a file, a link, or another entry at a path needs the index read", () => {
    expect(sortFacts(c, facts({ "a.txt": FILE, "new.txt": link(1), "dir/x.txt": { kind: "other" } }))).toEqual({ entries: ["a.txt", "dir/x.txt", "new.txt"], folders: [] });
  });

  test("a link at a leading folder hides the path, and the folder needs the index read", () => {
    expect(sortFacts(c, facts({ dir: link(1), "dir/x.txt": link(1) }))).toEqual({ entries: ["dir"], folders: [] });
  });

  test("a folder counts only where the target writes a file", () => {
    expect(sortFacts(c, facts({ dir: DIR, "new.txt": DIR, deep: DIR, "deep/er": DIR, gone: DIR }))).toEqual({ entries: [], folders: ["new.txt"] });
  });

  test("absent paths give nothing", () => expect(sortFacts(c, facts({}))).toEqual({ entries: [], folders: [] }));

  test("an error fact leaves the check without a verdict", () => {
    expect(sortFacts(c, facts({ "a.txt": { kind: "error", component: 1, code: "access-denied" } }))).toBe("unknown");
  });

  test("a fact count other than the candidate count is refused", () => {
    expect(() => sortFacts(c, facts({}).slice(1))).toThrow(TypeError);
  });
});

describe("the index read", () => {
  test("a file or link counts only without a stage-0 entry at its path", () => {
    expect(untrackedOf(["a.txt", "new.txt", "dir"], stage0("a.txt", "dir/x.txt"), "sha1")).toEqual(["new.txt", "dir"]);
  });

  // Discard stashes the tracked changes first, so a tracked path with changes is no candidate (research.md R21 F7).
  test("a tracked path with changes is no candidate", () => {
    expect(untrackedOf(["a.txt"], stage0("a.txt"), "sha1")).toEqual([]);
  });

  test("only a stage-0 entry protects a path", () => {
    const unmerged = raw([1, 2, 3].map((stage) => `100644 ${A} ${stage}\tc.txt\0`).join(""));
    expect(untrackedOf(["c.txt"], unmerged, "sha1")).toEqual(["c.txt"]);
  });

  test("a SHA-256 index and malformed records", () => {
    expect(untrackedOf(["a"], raw(`100644 ${"b".repeat(64)} 0\ta\0`), "sha256")).toEqual([]);
    for (const output of [`100644 ${A} 0\ta`, `100644 ${A} 0 a\0`, `10064 ${A} 0\ta\0`, `100644 ${A} 4\ta\0`, `100644 ${A} 0\t\0`, `100644 ${"b".repeat(64)} 0\ta\0`]) {
      expect(untrackedOf(["a"], raw(output), "sha1")).toBe("malformed");
    }
  });
});

describe("check-ignore (research.md R21 F1)", () => {
  test("the read has no --literal-pathspecs and sends each path with NUL", () => {
    const read = ignoreRead(["new.txt", utf8("ü"), "a:b"]);
    if (read === "path") throw new Error("the read refused a path without a leading colon");
    expect(read.args).toEqual(["--no-lazy-fetch", "--no-optional-locks", "check-ignore", "-z", "--stdin", "--no-index"]);
    expect(read.args).not.toContain("--literal-pathspecs");
    expect(Buffer.from(read.input).toString("latin1")).toBe(`new.txt\0${utf8("ü")}\0a:b\0`);
  });

  // contract Δ3: without `--literal-pathspecs`, a leading `:` can be pathspec magic, so plan.md D3 refuses it until T081.
  test("a candidate with a leading colon refuses with reason path", () => {
    expect(ignoreRead(["new.txt", ":(glob)*"])).toBe("path");
    expect(ignoreRead([":dir"])).toBe("path");
  });

  test("ignored candidates drop out", () => {
    expect(inTheWay(["build.log", "new.txt", "build"], { exitCode: 0, stdout: raw("build.log\0build\0") })).toEqual({ paths: ["new.txt"], more: 0 });
  });

  test("no candidate left passes", () => {
    expect(inTheWay(["build.log"], { exitCode: 0, stdout: raw("build.log\0") })).toBeNull();
    expect(inTheWay([], { exitCode: 1, stdout: raw("") })).toBeNull();
  });

  // git-check-ignore(1) EXIT STATUS: 0 when one or more paths are ignored, 1 when none is, 128 for a fatal error.
  test("exit 1 keeps every candidate", () => {
    expect(inTheWay(["new.txt"], { exitCode: 1, stdout: raw("") })).toEqual({ paths: ["new.txt"], more: 0 });
  });

  test(`at most ${IN_THE_WAY_PATHS} paths with a more count, as UTF-8 text`, () => {
    expect(IN_THE_WAY_PATHS).toBe(100);
    const counted = Array.from({ length: 250 }, (_, i) => utf8(`ä${i}`));
    const result = inTheWay(counted, { exitCode: 1, stdout: raw("") });
    expect(result).toEqual({ paths: Array.from({ length: 100 }, (_, i) => `ä${i}`), more: 150 });
  });

  test("an output that disagrees with the exit status or the input is malformed", () => {
    expect(inTheWay(["a"], { exitCode: 0, stdout: raw("") })).toBe("malformed");
    expect(inTheWay(["a"], { exitCode: 1, stdout: raw("a\0") })).toBe("malformed");
    expect(inTheWay(["a"], { exitCode: 0, stdout: raw("b\0") })).toBe("malformed");
    expect(inTheWay(["a"], { exitCode: 0, stdout: raw("a") })).toBe("malformed");
  });

  test("another exit status fails", () => {
    expect(inTheWay(["a"], { exitCode: 128, stdout: raw("") })).toBe("failed");
    expect(inTheWay(["a"], { exitCode: null, stdout: raw("") })).toBe("failed");
  });
});

// Feature 010 research.md R2 P18: `ls-files -z --others --ignored` prints a nested repository as its folder with a trailing `/`.
describe("ignored files below the folders in the way", () => {
  test("files count, and a record with a trailing slash names a nested repository", () => {
    expect(ignoredFilesOf(["x"], raw("x/a.txt\0x/z/w.txt\0"))).toEqual({ files: 2, nested: [] });
    expect(ignoredFilesOf(["x"], raw("x/\0"))).toEqual({ files: 0, nested: ["x"] });
    expect(ignoredFilesOf(["x", "y"], raw("x/plain.txt\0x/sub/\0y/b\0"))).toEqual({ files: 2, nested: ["x/sub"] });
  });

  test("a record outside the folders or with an empty component is malformed", () => {
    for (const out of ["x\0", "y/a\0", "x//\0", "x/a", "x/a//b\0"]) expect({ out, r: ignoredFilesOf(["x"], raw(out)) }).toEqual({ out, r: "malformed" });
  });

  test("a .git file or folder marks each repository; another reply kind is malformed, and an error leaves no verdict", () => {
    expect(nestedVerdict(["x", "y/sub"], [DIR, FILE])).toEqual({ paths: ["x", "y/sub"], more: 0 });
    expect(nestedVerdict([utf8("ä")], [DIR])).toEqual({ paths: ["ä"], more: 0 });
    expect(nestedVerdict(["x", "y"], [DIR, ABSENT])).toBe("malformed");
    expect(nestedVerdict(["x"], [link(2)])).toBe("malformed");
    expect(nestedVerdict(["x", "y"], [ABSENT, { kind: "error", component: 1, code: "access-denied" }])).toBe("unknown");
    expect(() => nestedVerdict(["x"], [])).toThrow(TypeError);
  });
});
