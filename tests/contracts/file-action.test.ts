// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { decideFileAction, decideResolve, FILE_ACTION_REASONS, type FileActionDecision, type FileActionInput, type ResolveDecision, type ResolveReason } from "../../src/contracts/file-action";
import { WHOLE_FILE_STAGE_INPUT_BYTES } from "../../src/contracts/limits";
import { printOrigin } from "../origin";

printOrigin("../../src/contracts/file-action.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);

// Contract §4 "File staging" and data-model §5 "File-action decision" (T195, T198).

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const concat = (...parts: (string | Uint8Array)[]): Uint8Array => {
  const chunks = parts.map((part) => (typeof part === "string" ? bytes(part) : part));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

const ZERO = "0".repeat(40);
const HEAD_OID = "1".repeat(40);
const INDEX_OID = "2".repeat(40);
const ZERO_256 = "0".repeat(64);
const HEAD_256 = "a".repeat(64);
const INDEX_256 = "b".repeat(64);
// Invalid UTF-8 path bytes: a lone continuation byte and a truncated sequence.
const BAD_PATH = new Uint8Array([0x62, 0x61, 0x64, 0x80, 0xe4, 0xb8, 0x2e, 0x74, 0x78, 0x74]);

// git-status(1) "Porcelain Format Version 2". Each record holds the bytes that `status --porcelain=v2 -z` writes for it, without the final NUL.
// A type 2 record keeps the NUL between the path and the original path.
const ordinary = (xy: string, sub: string, mH: string, mI: string, mW: string, hH: string, hI: string, path: string | Uint8Array) =>
  concat(`1 ${xy} ${sub} ${mH} ${mI} ${mW} ${hH} ${hI} `, path);
const renamed = (xy: string, mH: string, mI: string, mW: string, hH: string, hI: string, score: string, path: string, orig: string) =>
  concat(`2 ${xy} N... ${mH} ${mI} ${mW} ${hH} ${hI} ${score} ${path}`, new Uint8Array([0]), orig);
const unmerged = (path: string) => concat(`u UU N... 100644 100644 100644 100644 ${HEAD_OID} ${INDEX_OID} ${"3".repeat(40)} ${path}`);
const untracked = (path: string | Uint8Array) => concat("? ", path);

const NO_FLAGS = { intentToAdd: false, assumeUnchanged: false, skipWorktree: false };

function input(category: FileActionInput["category"], record: Uint8Array, path: string | Uint8Array, over: Partial<FileActionInput> = {}): FileActionInput {
  const diskPath = typeof path === "string" ? bytes(path) : path;
  return {
    category,
    record,
    headUnborn: false,
    indexFlags: NO_FLAGS,
    attributes: {},
    working: { type: "file", size: 10, diskPath },
    ...over,
  };
}

// The changed paths compare as hex path bytes. `update-index --index-info` removes a path with mode 0 whatever its object ID, so a mode-0 entry compares without it.
type ChangedEntry = { path: string; mode?: number; objectId?: string };
type Normalized =
  | { direction: "stage" | "unstage"; changedPaths: ChangedEntry[] }
  | { direction: null; code: string; reason?: string };

function normalize(decision: FileActionDecision): Normalized {
  if (decision.direction === null) return decision as Normalized;
  const changedPaths = decision.changedPaths
    .map((entry) => {
      const out: ChangedEntry = { path: hex(entry.path) };
      if (entry.mode !== undefined) out.mode = entry.mode;
      if (entry.objectId !== undefined && entry.mode !== 0) out.objectId = entry.objectId;
      return out;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return { direction: decision.direction, changedPaths };
}

const decide = (value: FileActionInput) => normalize(decideFileAction(value));
const stageOf = (path: string | Uint8Array): Normalized => ({ direction: "stage", changedPaths: [{ path: hex(typeof path === "string" ? bytes(path) : path) }] });
const head = (path: string, mode: number, objectId: string): ChangedEntry => ({ path: hex(bytes(path)), mode, objectId });
const removed = (path: string): ChangedEntry => ({ path: hex(bytes(path)), mode: 0 });
const refused = (reason: string): Normalized => ({ direction: null, code: "UNSUPPORTED_COMPARISON", reason });

describe("closed reason list (contract §4 'File staging')", () => {
  // Feature 003 contract Δ4 adds `missing`.
  test("FILE_ACTION_REASONS holds exactly the contract reasons", () => {
    expect<string[]>([...FILE_ACTION_REASONS].sort()).toEqual(["LFS", "blob-proof", "filter", "index-flag", "path", "rename", "size", "submodule", "symlink", "type", "missing"].sort());
  });
});

describe("stage rows (contract §4 table)", () => {
  test("an Unstaged modified entry gives stage with its path", () => {
    const r = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "src/a.txt");
    expect(decide(input("unstaged", r, "src/a.txt"))).toEqual(stageOf("src/a.txt"));
  });

  test("an Unstaged deletion gives stage, so the entry leaves the index", () => {
    const r = ordinary(".D", "N...", "100644", "100644", "000000", HEAD_OID, INDEX_OID, "gone.txt");
    expect(decide(input("unstaged", r, "gone.txt", { working: { type: "absent" } }))).toEqual(stageOf("gone.txt"));
  });

  test("an Unstaged mode change gives stage", () => {
    const r = ordinary(".M", "N...", "100644", "100644", "100755", HEAD_OID, INDEX_OID, "run.sh");
    expect(decide(input("unstaged", r, "run.sh"))).toEqual(stageOf("run.sh"));
  });

  test("an Untracked regular file gives stage, text or binary", () => {
    expect(decide(input("untracked", untracked("new.txt"), "new.txt"))).toEqual(stageOf("new.txt"));
    const binary = input("untracked", untracked("new.bin"), "new.bin", { content: { binary: true } });
    expect(decide(binary)).toEqual(stageOf("new.bin"));
  });

  test("a path with spaces and non-ASCII characters keeps its literal bytes", () => {
    const path = "dir with space/é中.txt";
    const r = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, path);
    expect(decide(input("unstaged", r, path))).toEqual(stageOf(path));
  });

  // The decision needs no text support (contract §4). These are hunk limits only.
  test("binary, mixed line endings, invalid UTF-8, encoding conversion, and a 1,048,577-byte entry still give stage", () => {
    const r = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "f.dat");
    const cases: Partial<FileActionInput>[] = [
      { content: { binary: true } },
      { content: { lineEndings: "mixed" } },
      { content: { validUtf8: false } },
      { working: { type: "file", size: 1_048_577, diskPath: bytes("f.dat") } },
      { attributes: { "working-tree-encoding": "UTF-16LE-BOM" } },
      { content: { binary: true, validUtf8: false, lineEndings: "mixed" }, working: { type: "file", size: 1_048_577, diskPath: bytes("f.dat") } },
    ];
    for (const over of cases) expect(decide(input("unstaged", r, "f.dat", over))).toEqual(stageOf("f.dat"));
    expect(decide(input("untracked", untracked("f.dat"), "f.dat", cases[5]))).toEqual(stageOf("f.dat"));
  });
});

describe("unstage rows (contract §4 table)", () => {
  test("a Staged modification gets its HEAD mode and object ID", () => {
    const r = ordinary("M.", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "src/a.txt");
    expect(decide(input("staged", r, "src/a.txt"))).toEqual({ direction: "unstage", changedPaths: [head("src/a.txt", 0o100644, HEAD_OID)] });
  });

  test("a Staged deletion gets its HEAD entry back", () => {
    const r = ordinary("D.", "N...", "100644", "000000", "000000", HEAD_OID, ZERO, "gone.txt");
    expect(decide(input("staged", r, "gone.txt", { working: { type: "absent" } }))).toEqual({
      direction: "unstage",
      changedPaths: [head("gone.txt", 0o100644, HEAD_OID)],
    });
  });

  test("a Staged mode change gets its HEAD mode", () => {
    const r = ordinary("M.", "N...", "100755", "100644", "100644", HEAD_OID, INDEX_OID, "run.sh");
    expect(decide(input("staged", r, "run.sh"))).toEqual({ direction: "unstage", changedPaths: [head("run.sh", 0o100755, HEAD_OID)] });
  });

  test("a Staged addition without a HEAD entry leaves the index with mode 0", () => {
    const r = ordinary("A.", "N...", "000000", "100644", "100644", ZERO, INDEX_OID, "new.txt");
    expect(decide(input("staged", r, "new.txt"))).toEqual({ direction: "unstage", changedPaths: [removed("new.txt")] });
  });

  test("a Staged entry with any content gives unstage", () => {
    const r = ordinary("M.", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "f.bin");
    const over = { content: { binary: true, validUtf8: false, lineEndings: "mixed" as const }, working: { type: "file" as const, size: WHOLE_FILE_STAGE_INPUT_BYTES + 1, diskPath: bytes("f.bin") } };
    expect(decide(input("staged", r, "f.bin", over))).toEqual({ direction: "unstage", changedPaths: [head("f.bin", 0o100644, HEAD_OID)] });
  });

  test("a staged rename lists both paths: the source gets its HEAD entry, and the destination leaves the index", () => {
    const r = renamed("R.", "100644", "100644", "100644", HEAD_OID, HEAD_OID, "R100", "new/name.txt", "old/name.txt");
    const decision = decide(input("staged", r, "new/name.txt"));
    expect(decision).toEqual({
      direction: "unstage",
      changedPaths: [head("old/name.txt", 0o100644, HEAD_OID), removed("new/name.txt")].sort((a, b) => a.path.localeCompare(b.path)),
    });
  });

  test("a staged copy lists only its destination", () => {
    const r = renamed("C.", "100644", "100644", "100644", HEAD_OID, HEAD_OID, "C75", "copy.txt", "orig.txt");
    expect(decide(input("staged", r, "copy.txt"))).toEqual({ direction: "unstage", changedPaths: [removed("copy.txt")] });
  });

  test("an unborn HEAD gives mode 0 for every path", () => {
    const a = ordinary("A.", "N...", "000000", "100644", "100644", ZERO, INDEX_OID, "a.txt");
    const b = ordinary("A.", "N...", "000000", "100755", "100755", ZERO, INDEX_OID, "b.sh");
    for (const [r, path] of [[a, "a.txt"], [b, "b.sh"]] as const) {
      const raw = decideFileAction(input("staged", r, path, { headUnborn: true }));
      expect(raw.direction).toBe("unstage");
      if (raw.direction === null) continue;
      expect(raw.changedPaths.map((entry) => entry.mode)).toEqual([0]);
      expect(normalize(raw)).toEqual({ direction: "unstage", changedPaths: [removed(path)] });
    }
  });

  test("SHA-256 object IDs pass through unchanged", () => {
    const r = ordinary("M.", "N...", "100644", "100644", "100644", HEAD_256, INDEX_256, "a.txt");
    expect(decide(input("staged", r, "a.txt"))).toEqual({ direction: "unstage", changedPaths: [head("a.txt", 0o100644, HEAD_256)] });
    const added = ordinary("A.", "N...", "000000", "100644", "100644", ZERO_256, INDEX_256, "n.txt");
    expect(decide(input("staged", added, "n.txt"))).toEqual({ direction: "unstage", changedPaths: [removed("n.txt")] });
  });
});

describe("refusal reasons (contract §4 'File staging', data-model §5)", () => {
  test("type: a working path that is not a regular file", () => {
    const deleted = ordinary(".D", "N...", "100644", "100644", "000000", HEAD_OID, INDEX_OID, "was-file");
    expect(decide(input("unstaged", deleted, "was-file", { working: { type: "directory", diskPath: bytes("was-file") } }))).toEqual(refused("type"));
    const modified = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "pipe");
    expect(decide(input("unstaged", modified, "pipe", { working: { type: "other", diskPath: bytes("pipe") } }))).toEqual(refused("type"));
    expect(decide(input("untracked", untracked("dev"), "dev", { working: { type: "other", diskPath: bytes("dev") } }))).toEqual(refused("type"));
  });

  test("type: a type-change record gives no direction in either category", () => {
    const staged = ordinary("T.", "N...", "100644", "120000", "120000", HEAD_OID, INDEX_OID, "t");
    const unstaged = ordinary(".T", "N...", "100644", "100644", "120000", HEAD_OID, INDEX_OID, "t");
    for (const [category, r] of [["staged", staged], ["unstaged", unstaged]] as const) {
      expect(decide(input(category, r, "t", { working: { type: "symlink", diskPath: bytes("t") } }))).toEqual(refused("type"));
    }
  });

  test("symlink: a symbolic link on either side", () => {
    const staged = ordinary("M.", "N...", "120000", "120000", "120000", HEAD_OID, INDEX_OID, "link");
    expect(decide(input("staged", staged, "link", { working: { type: "symlink", diskPath: bytes("link") } }))).toEqual(refused("symlink"));
    const addedLink = ordinary("A.", "N...", "000000", "120000", "120000", ZERO, INDEX_OID, "link2");
    expect(decide(input("staged", addedLink, "link2", { working: { type: "symlink", diskPath: bytes("link2") } }))).toEqual(refused("symlink"));
    const deletedLink = ordinary("D.", "N...", "120000", "000000", "000000", HEAD_OID, ZERO, "link3");
    expect(decide(input("staged", deletedLink, "link3", { working: { type: "absent" } }))).toEqual(refused("symlink"));
    const unstaged = ordinary(".M", "N...", "120000", "120000", "120000", HEAD_OID, INDEX_OID, "link");
    expect(decide(input("unstaged", unstaged, "link", { working: { type: "symlink", diskPath: bytes("link") } }))).toEqual(refused("symlink"));
    expect(decide(input("untracked", untracked("ulink"), "ulink", { working: { type: "symlink", diskPath: bytes("ulink") } }))).toEqual(refused("symlink"));
  });

  test("submodule: a gitlink on either side, or an untracked nested repository", () => {
    const staged = ordinary("M.", "SC..", "160000", "160000", "160000", HEAD_OID, INDEX_OID, "sub");
    expect(decide(input("staged", staged, "sub", { working: { type: "directory", diskPath: bytes("sub") } }))).toEqual(refused("submodule"));
    const added = ordinary("A.", "S...", "000000", "160000", "160000", ZERO, INDEX_OID, "sub2");
    expect(decide(input("staged", added, "sub2", { working: { type: "directory", diskPath: bytes("sub2") } }))).toEqual(refused("submodule"));
    const unstaged = ordinary(".M", "SC..", "160000", "160000", "160000", HEAD_OID, HEAD_OID, "sub");
    expect(decide(input("unstaged", unstaged, "sub", { working: { type: "directory", diskPath: bytes("sub") } }))).toEqual(refused("submodule"));
    // With `--untracked-files=all`, Git lists a directory record only for a nested repository.
    expect(decide(input("untracked", untracked("nested/"), "nested/", { working: { type: "directory", diskPath: bytes("nested/") } }))).toEqual(refused("submodule"));
  });

  test("index-flag: intent-to-add, assume-unchanged, and skip-worktree entries", () => {
    const r = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "f.txt");
    for (const flag of ["intentToAdd", "assumeUnchanged", "skipWorktree"] as const) {
      expect(decide(input("unstaged", r, "f.txt", { indexFlags: { ...NO_FLAGS, [flag]: true } }))).toEqual(refused("index-flag"));
    }
    const ita = ordinary(".A", "N...", "000000", "000000", "100644", ZERO, ZERO, "ita.txt");
    expect(decide(input("unstaged", ita, "ita.txt", { indexFlags: { ...NO_FLAGS, intentToAdd: true } }))).toEqual(refused("index-flag"));
    const staged = ordinary("M.", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "s.txt");
    expect(decide(input("staged", staged, "s.txt", { indexFlags: { ...NO_FLAGS, skipWorktree: true } }))).toEqual(refused("index-flag"));
  });

  test("path: invalid UTF-8 path bytes refuse both directions", () => {
    const unstaged = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, BAD_PATH);
    expect(decide(input("unstaged", unstaged, BAD_PATH))).toEqual(refused("path"));
    const staged = ordinary("M.", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, BAD_PATH);
    expect(decide(input("staged", staged, BAD_PATH))).toEqual(refused("path"));
    expect(decide(input("untracked", untracked(BAD_PATH), BAD_PATH))).toEqual(refused("path"));
  });

  test("path: an on-disk name that differs from the index path bytes, letter case included", () => {
    const r = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "Readme.md");
    expect(decide(input("unstaged", r, "Readme.md", { working: { type: "file", size: 10, diskPath: bytes("README.md") } }))).toEqual(refused("path"));
    expect(decide(input("untracked", untracked("New.txt"), "New.txt", { working: { type: "file", size: 1, diskPath: bytes("new.txt") } }))).toEqual(refused("path"));
  });

  test("path: a working path that the service cannot read", () => {
    const r = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "deep/x.txt");
    expect(decide(input("unstaged", r, "deep/x.txt", { working: { type: "unreadable" } }))).toEqual(refused("path"));
  });

  test("rename: an Unstaged rename record", () => {
    const r = renamed(".R", "000000", "000000", "100644", ZERO, ZERO, "R100", "moved.txt", "orig.txt");
    expect(decide(input("unstaged", r, "moved.txt"))).toEqual(refused("rename"));
  });

  test("filter: an Unstaged or Untracked path with a filter attribute; unstage accepts it", () => {
    const attributes = { filter: "custom" };
    const unstaged = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "f.txt");
    expect(decide(input("unstaged", unstaged, "f.txt", { attributes }))).toEqual(refused("filter"));
    expect(decide(input("untracked", untracked("u.txt"), "u.txt", { attributes }))).toEqual(refused("filter"));
    const staged = ordinary("M.", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "f.txt");
    expect(decide(input("staged", staged, "f.txt", { attributes }))).toEqual({ direction: "unstage", changedPaths: [head("f.txt", 0o100644, HEAD_OID)] });
  });

  // Git LFS installs its driver as the `lfs` value of the `filter` attribute (git-lfs `.gitattributes`: `filter=lfs`).
  test("LFS: the lfs filter driver gives LFS for stage and unstage for a Staged entry", () => {
    const attributes = { filter: "lfs" };
    const unstaged = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "big.psd");
    expect(decide(input("unstaged", unstaged, "big.psd", { attributes }))).toEqual(refused("LFS"));
    const staged = ordinary("M.", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "big.psd");
    expect(decide(input("staged", staged, "big.psd", { attributes }))).toEqual({ direction: "unstage", changedPaths: [head("big.psd", 0o100644, HEAD_OID)] });
  });

  test("an unspecified filter attribute is no refusal", () => {
    const r = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "f.txt");
    expect(decide(input("unstaged", r, "f.txt", { attributes: { filter: "unspecified" } }))).toEqual(stageOf("f.txt"));
  });

  test("size: a stage working file of 536,870,913 bytes; 536,870,912 bytes still stage", () => {
    expect(WHOLE_FILE_STAGE_INPUT_BYTES).toBe(536_870_912);
    const r = ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "huge.bin");
    const at = (size: number) => ({ working: { type: "file" as const, size, diskPath: bytes("huge.bin") } });
    expect(decide(input("unstaged", r, "huge.bin", at(536_870_913)))).toEqual(refused("size"));
    expect(decide(input("unstaged", r, "huge.bin", at(536_870_912)))).toEqual(stageOf("huge.bin"));
    expect(decide(input("untracked", untracked("huge.bin"), "huge.bin", at(536_870_913)))).toEqual(refused("size"));
  });

  test("blob-proof never comes from the decision", () => {
    const records: FileActionInput[] = [
      input("unstaged", ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "a"), "a", { content: { lineEndings: "mixed" }, attributes: { ident: "set" } }),
      input("untracked", untracked("b"), "b", { attributes: { text: "auto", eol: "crlf" } }),
    ];
    for (const value of records) expect(decideFileAction(value)).not.toMatchObject({ reason: "blob-proof" });
    expect(records.map(decide)).toEqual([stageOf("a"), stageOf("b")]);
  });
});

describe("operation state keeps its own code (contract §4 'File staging')", () => {
  test("a conflicted entry gives CONFLICTED and no direction", () => {
    expect(decide(input("conflicted", unmerged("c.txt"), "c.txt"))).toEqual({ direction: null, code: "CONFLICTED" });
  });
});

describe("an entry changed in the index and in the working file (contract §4 'File staging')", () => {
  test("MM gives unstage as Staged and stage as Unstaged", () => {
    const r = ordinary("MM", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "both.txt");
    expect(decide(input("staged", r, "both.txt"))).toEqual({ direction: "unstage", changedPaths: [head("both.txt", 0o100644, HEAD_OID)] });
    expect(decide(input("unstaged", r, "both.txt"))).toEqual(stageOf("both.txt"));
  });
});

describe("an unmerged record keeps its own code in every category", () => {
  test("a u record gives CONFLICTED outside the conflicted category", () => {
    for (const category of ["staged", "unstaged", "untracked"] as const) {
      expect(decide(input(category, unmerged("c.txt"), "c.txt"))).toEqual({ direction: null, code: "CONFLICTED" });
    }
  });
});

describe("malformed status records give MALFORMED_GIT_OUTPUT (git-status(1) 'Porcelain Format Version 2')", () => {
  const MALFORMED = { direction: null, code: "MALFORMED_GIT_OUTPUT" };
  const modified = (xy: string, path = "f.txt") => ordinary(xy, "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, path);

  test("a record that does not parse", () => {
    const records: [FileActionInput["category"], Uint8Array][] = [
      ["unstaged", bytes("! ignored.txt")],
      ["unstaged", bytes("1 .M N... 100644 100644")],
      ["unstaged", modified(".X")],
      ["unstaged", ordinary(".M", "X...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "f.txt")],
      ["unstaged", ordinary(".M", "N...", "100644", "100644", "10064", HEAD_OID, INDEX_OID, "f.txt")],
      ["unstaged", ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_256, "f.txt")],
      ["unstaged", ordinary(".M", "N...", "100644", "100644", "100644", "A".repeat(40), INDEX_OID, "f.txt")],
      ["unstaged", modified(".M", "")],
      ["unstaged", concat(modified(".M", "a"), new Uint8Array([0]), "b")],
      ["staged", concat(`2 R. N... 100644 100644 100644 ${HEAD_OID} ${HEAD_OID} R100 new.txt`)],
      ["staged", renamed("R.", "100644", "100644", "100644", HEAD_OID, HEAD_OID, "X100", "new.txt", "old.txt")],
      ["staged", renamed("R.", "100644", "100644", "100644", HEAD_OID, HEAD_OID, "R100", "new.txt", "")],
      ["untracked", bytes("? ")],
    ];
    for (const [category, record] of records) expect(decide(input(category, record, "f.txt"))).toEqual(MALFORMED);
  });

  test("a record kind that does not match the category", () => {
    expect(decide(input("untracked", modified(".M"), "f.txt"))).toEqual(MALFORMED);
    expect(decide(input("staged", untracked("u.txt"), "u.txt"))).toEqual(MALFORMED);
    expect(decide(input("unstaged", untracked("u.txt"), "u.txt"))).toEqual(MALFORMED);
  });

  test("a side without a change in its own category", () => {
    expect(decide(input("staged", modified(".M"), "f.txt"))).toEqual(MALFORMED);
    expect(decide(input("unstaged", modified("M."), "f.txt"))).toEqual(MALFORMED);
  });

  test("a staged index state that has no unstage entry", () => {
    expect(decide(input("staged", modified("U."), "f.txt"))).toEqual(MALFORMED);
    expect(decide(input("staged", modified("R."), "f.txt"))).toEqual(MALFORMED);
    expect(decide(input("staged", renamed("M.", "100644", "100644", "100644", HEAD_OID, HEAD_OID, "R100", "new.txt", "old.txt"), "new.txt"))).toEqual(MALFORMED);
  });
});

describe("Mark resolved: the decision resolve (contract Δ4, data-model §9, T018)", () => {
  const S1 = "1".repeat(40);
  const S2 = "2".repeat(40);
  const S3 = "3".repeat(40);
  // git-status(1) "Unmerged entries": `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`. An absent stage has mode 000000 and the zero OID.
  const MODES: Record<string, [string, string, string]> = {
    UU: ["100644", "100644", "100644"],
    AA: ["000000", "100644", "100644"],
    AU: ["000000", "100644", "000000"],
    UA: ["000000", "000000", "100644"],
    DU: ["100644", "000000", "100644"],
    UD: ["100644", "100644", "000000"],
    DD: ["100644", "000000", "000000"],
  };
  const conflict = (xy: string, path: string | Uint8Array = "c.txt", modes = MODES[xy]!, mW = "100644", sub = "N...") => {
    const oids = modes.map((m, i) => (m === "000000" ? ZERO : [S1, S2, S3][i]!));
    return concat(`u ${xy} ${sub} ${modes.join(" ")} ${mW} ${oids.join(" ")} `, path);
  };
  const resolveInput = (record: Uint8Array, path: string | Uint8Array = "c.txt", over: Partial<FileActionInput> = {}) => input("conflicted", record, path, over);
  const RESOLVE = { direction: "resolve", changedPaths: [{ path: hex(bytes("c.txt")), mode: "100644" }] };
  // The `update-index --index-info` mode as octal text.
  const norm = (value: ReturnType<typeof decideResolve>) =>
    value.direction === "resolve" ? { direction: "resolve", changedPaths: value.changedPaths.map((p) => ({ path: hex(p.path), mode: p.mode.toString(8) })) } : value;
  const refuse = (reason: ResolveReason): ResolveDecision => ({ direction: null, code: "UNSUPPORTED_COMPARISON", reason });

  test("each accepted unmerged kind with a regular working file gives resolve", () => {
    for (const xy of ["UU", "AA", "AU", "UA", "DU", "UD"]) expect(norm(decideResolve(resolveInput(conflict(xy))))).toEqual(RESOLVE);
  });

  // Research R16 i: `mW` equals the `git add` mode, also where `update-index --add` writes 100644.
  test("the decision carries the working mode mW of the u record, and 100755 stays 100755", () => {
    for (const xy of ["UU", "AA", "AU", "UA", "DU", "UD"]) {
      const decision = norm(decideResolve(resolveInput(conflict(xy, "c.txt", MODES[xy]!, "100755"))));
      expect(decision).toEqual({ direction: "resolve", changedPaths: [{ path: hex(bytes("c.txt")), mode: "100755" }] });
    }
    expect(norm(decideResolve(resolveInput(conflict("UU", "c.txt", ["100755", "100644", "100755"], "100644"))))).toEqual(RESOLVE);
  });

  test("an mW without a regular file gives missing, and another mode gives type", () => {
    expect(decideResolve(resolveInput(conflict("UU", "c.txt", MODES.UU!, "000000")))).toEqual(refuse("missing"));
    expect(decideResolve(resolveInput(conflict("UU", "c.txt", MODES.UU!, "040000")))).toEqual(refuse("type"));
  });

  test("a file at the size limit gives resolve, one byte more gives size", () => {
    const at = { working: { type: "file" as const, size: WHOLE_FILE_STAGE_INPUT_BYTES, diskPath: bytes("c.txt") } };
    const over = { working: { type: "file" as const, size: WHOLE_FILE_STAGE_INPUT_BYTES + 1, diskPath: bytes("c.txt") } };
    expect(norm(decideResolve(resolveInput(conflict("UU"), "c.txt", at)))).toEqual(RESOLVE);
    expect(decideResolve(resolveInput(conflict("UU"), "c.txt", over))).toEqual(refuse("size"));
  });

  test("DD and a missing working file give missing", () => {
    expect(decideResolve(resolveInput(conflict("DD")))).toEqual(refuse("missing"));
    expect(decideResolve(resolveInput(conflict("DD"), "c.txt", { working: { type: "absent" } }))).toEqual(refuse("missing"));
    for (const xy of ["UU", "DU", "UD"]) expect(decideResolve(resolveInput(conflict(xy), "c.txt", { working: { type: "absent" } }))).toEqual(refuse("missing"));
  });

  test("a symbolic link gives symlink", () => {
    expect(decideResolve(resolveInput(conflict("UU"), "c.txt", { working: { type: "symlink", diskPath: bytes("c.txt") } }))).toEqual(refuse("symlink"));
    expect(decideResolve(resolveInput(conflict("UU", "c.txt", ["100644", "120000", "100644"])))).toEqual(refuse("symlink"));
    expect(decideResolve(resolveInput(conflict("UU", "c.txt", MODES.UU!, "120000")))).toEqual(refuse("symlink"));
  });

  test("a gitlink gives submodule", () => {
    expect(decideResolve(resolveInput(conflict("UU", "c.txt", ["160000", "160000", "160000"], "160000", "SC..")))).toEqual(refuse("submodule"));
    expect(decideResolve(resolveInput(conflict("UU", "c.txt", ["100644", "100644", "160000"])))).toEqual(refuse("submodule"));
  });

  test("the other data-model §9 refusals", () => {
    expect(decideResolve(resolveInput(conflict("UU"), "c.txt", { working: { type: "directory", diskPath: bytes("c.txt") } }))).toEqual(refuse("type"));
    expect(decideResolve(resolveInput(conflict("UU"), "c.txt", { working: { type: "other", diskPath: bytes("c.txt") } }))).toEqual(refuse("type"));
    expect(decideResolve(resolveInput(conflict("UU"), "c.txt", { working: { type: "unreadable" } }))).toEqual(refuse("path"));
    expect(decideResolve(resolveInput(conflict("UU"), "c.txt", { working: { type: "file", size: 1, diskPath: bytes("C.txt") } }))).toEqual(refuse("path"));
    expect(decideResolve(resolveInput(conflict("UU", BAD_PATH), BAD_PATH))).toEqual(refuse("path"));
    expect(decideResolve(resolveInput(conflict("UU"), "c.txt", { attributes: { filter: "crypt" } }))).toEqual(refuse("filter"));
    expect(decideResolve(resolveInput(conflict("UU"), "c.txt", { attributes: { filter: "lfs" } }))).toEqual(refuse("LFS"));
    expect(norm(decideResolve(resolveInput(conflict("UU"), "c.txt", { attributes: { filter: "unset" } })))).toEqual(RESOLVE);
  });

  test("the decision reads no file text", () => {
    const facts = { content: { binary: true, validUtf8: false, lineEndings: "mixed" as const } };
    expect(norm(decideResolve(resolveInput(conflict("UU"), "c.txt", facts)))).toEqual(RESOLVE);
  });

  test("a record that is no unmerged record gives MALFORMED_GIT_OUTPUT", () => {
    const MALFORMED: ResolveDecision = { direction: null, code: "MALFORMED_GIT_OUTPUT" };
    const records = [
      ordinary(".M", "N...", "100644", "100644", "100644", HEAD_OID, INDEX_OID, "c.txt"),
      conflict("MM", "c.txt", MODES.UU!),
      conflict("UU", ""),
      conflict("UU", "c.txt", ["100644", "100644", "10064"]),
      conflict("UU", "c.txt", MODES.UU!, "100644", "X..."),
      concat(`u UU N... 100644 100644 100644 100644 ${S1} ${S2} ${"3".repeat(64)} c.txt`),
      concat(`u UU N... 100644 100644 100644 100644 ${S1} ${S2} c.txt`),
    ];
    for (const record of records) expect(decideResolve(resolveInput(record))).toEqual(MALFORMED);
  });

  test("Stage file still refuses a conflicted entry (001 FR-038)", () => {
    expect(decide(input("conflicted", conflict("UU"), "c.txt"))).toEqual({ direction: null, code: "CONFLICTED" });
    expect(decide(input("unstaged", conflict("AA"), "c.txt"))).toEqual({ direction: null, code: "CONFLICTED" });
  });
});
