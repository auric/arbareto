// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { attributeArgs, lineEndingArgs, stagedNumstatArgs, stagedPatchArgs, unstagedNumstatArgs, unstagedPatchArgs, untrackedNumstatArgs, untrackedPatchArgs } from "../../src/git-service/commands";
import { parseNumstat, parsePatch } from "../../src/git-service/diff-parser";
import type { StatusRecord } from "../../src/git-service/status-parser";
import { decideSupport, parseAttributes, parseEolListing, type SupportInput } from "../../src/git-service/support";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, fixtureDir, fixtureGit, ownedGit, useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";

printOrigin("../../src/git-service/commands.ts", import.meta.dir);
printOrigin("../../src/git-service/diff-parser.ts", import.meta.dir);
printOrigin("../../src/git-service/support.ts", import.meta.dir);

// T103: reason `binary` comes from `--numstat -z` (git-diff(1) `--numstat`: "For binary files, outputs two `-` instead of saying `0 0`").

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const DEV_NULL = bytes("/dev/null");
const NO_FLAGS = { intentToAdd: false, assumeUnchanged: false, skipWorktree: false };

describeGit("numstat binary signal", (git) => {
  useFixtureRoot();

  test("real numstat bytes decide binary for each scope, and a lone-CR text file is not binary", () => {
    const repo = fixtureDir("numstat-repo");
    const run = (...args: string[]) => fixtureGit(git, repo, args);
    // `diff --no-index` exits 1 when the sides differ (git-diff(1) `--exit-code`, implied by `--no-index`).
    const read = (args: string[], input?: string) => new Uint8Array(ownedGit(git, FIXTURE_ROOT, repo, args, { allowExit: [0, 1], input: input === undefined ? undefined : Buffer.from(input) }));
    run("init", "--quiet", "-b", "main");
    run("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "hb.dat"), "a\0b");
    writeFileSync(join(repo, "cr.txt"), "x\ry\rz\n");
    run("add", "hb.dat", "cr.txt");
    run("commit", "--quiet", "-m", "base");
    const head = run("rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "hb.dat"), "text now\n");
    run("add", "hb.dat");
    writeFileSync(join(repo, "cr.txt"), "x\rq\rz\n");
    writeFileSync(join(repo, "u.bin"), "\0\x01\x02bin");

    const staged = read(stagedNumstatArgs(head, "sha1", "hb.dat"));
    const unstaged = read(unstagedNumstatArgs("cr.txt"));
    const untracked = read(untrackedNumstatArgs("u.bin"));
    expect(Buffer.from(staged).toString("latin1")).toBe("-\t-\thb.dat\0");
    expect(Buffer.from(unstaged).toString("latin1")).toBe("1\t1\tcr.txt\0");
    expect(Buffer.from(untracked).toString("latin1")).toBe("-\t-\t\0/dev/null\0u.bin\0");
    expect(parseNumstat(staged, bytes("hb.dat"), null)).toEqual({ ok: true, binary: true });
    expect(parseNumstat(unstaged, bytes("cr.txt"), null)).toEqual({ ok: true, binary: false });
    expect(parseNumstat(untracked, bytes("u.bin"), DEV_NULL)).toEqual({ ok: true, binary: true });
    // A malformed record from real bytes: one `-` and one count.
    const broken = Uint8Array.from(unstaged);
    broken[0] = 0x2d;
    expect(parseNumstat(broken, bytes("cr.txt"), null)).toEqual({ ok: false, completeness: { state: "failed", code: "MALFORMED_GIT_OUTPUT" } });

    const eol = parseEolListing(read(lineEndingArgs()))!;
    // convert.c `convert_is_binary` counts a lone CR as binary, so `ls-files --eol` prints `-text`. Git's diff still treats the file as text.
    expect(eol.get("cr.txt")).toEqual([{ index: "-text", working: "-text", attr: "" }]);
    const attributes = (path: string) => parseAttributes(read(attributeArgs(), `${path}\0`), [bytes(path)])![0]!;
    const entry = (record: StatusRecord, scope: SupportInput["scope"], patchArgs: string[], numstat: Uint8Array, from: Uint8Array | null): SupportInput => {
      const path = record.path.bytes;
      return {
        scope,
        record,
        indexFlags: NO_FLAGS,
        attributes: attributes(record.path.display),
        working: { type: "file", size: 9, diskPath: path },
        eol,
        sizes: { raw: [3, 9], normalized: [3, 9] },
        patch: parsePatch(read(patchArgs), path),
        numstat: parseNumstat(numstat, path, from),
      };
    };
    const path = (p: string) => ({ bytes: bytes(p), display: p });
    const oids: [string, string] = [head, head];
    const unsupported = (reason: string) => ({ supported: false, code: "UNSUPPORTED_COMPARISON", reason });

    const stagedRecord: StatusRecord = { kind: "ordinary", xy: "M.", submodule: "N...", modes: ["100644", "100644", "100644"], oids, path: path("hb.dat") };
    expect(decideSupport(entry(stagedRecord, "head-to-index", stagedPatchArgs(head, "sha1", "hb.dat"), staged, null))).toEqual(unsupported("binary") as ReturnType<typeof decideSupport>);
    const untrackedRecord: StatusRecord = { kind: "untracked", path: path("u.bin") };
    expect(decideSupport(entry(untrackedRecord, "empty-to-untracked", untrackedPatchArgs("u.bin"), untracked, DEV_NULL))).toEqual(unsupported("binary") as ReturnType<typeof decideSupport>);
    const crRecord: StatusRecord = { kind: "ordinary", xy: ".M", submodule: "N...", modes: ["100644", "100644", "100644"], oids, path: path("cr.txt") };
    expect(decideSupport(entry(crRecord, "index-to-worktree", unstagedPatchArgs("cr.txt"), unstaged, null))).toEqual({ supported: true });
  });
});
