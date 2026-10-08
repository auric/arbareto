// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { COMPARED_NORMALIZED_VERSION_BYTES, COMPARED_RAW_VERSION_BYTES } from "../../src/contracts/limits";
import { type NumstatResult, parseNumstat, parsePatch } from "../../src/git-service/diff-parser";
import type { StatusRecord } from "../../src/git-service/status-parser";
import { decideSupport, parseAttributes, parseEolListing, SUPPORT_REASONS, type SupportDecision, type SupportInput, type SupportReason } from "../../src/git-service/support";
import { printOrigin } from "../origin";

printOrigin("../../src/git-service/support.ts", import.meta.dir);
printOrigin("../../src/git-service/diff-parser.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);

// T103: contract §4 and data-model §5 "Support decision".

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));
const HEAD_OID = "1".repeat(40);
const INDEX_OID = "2".repeat(40);
const NO_ATTRIBUTES = { filter: "unspecified", diff: "unspecified", text: "unspecified", eol: "unspecified", crlf: "unspecified", "working-tree-encoding": "unspecified" };

const BINARY: NumstatResult = { ok: true, binary: true };
const TEXT: NumstatResult = { ok: true, binary: false };

// `ls-files --eol -z` (builtin/ls-files.c `write_eolinfo`): `i/%-5s w/%-5s attr/%-17s` and a tab before the path.
const eolRecord = (index: string, working: string, attr: string, path: string) => `i/${index.padEnd(5)} w/${working.padEnd(5)} attr/${attr.padEnd(17)}\t${path}\0`;

function ordinary(xy: string, modes: [string, string, string], path: string, submodule = "N..."): StatusRecord {
  return { kind: "ordinary", xy, submodule, modes, oids: [HEAD_OID, INDEX_OID], path: { bytes: bytes(path), display: path } };
}

const plainPatch = (path: string, body = "@@ -1,2 +1,2 @@\n a\n-b\n+c\n") => `diff --git a/${path} b/${path}\nindex 1234567..89abcde 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
const creationPatch = (path: string, line = "x") => `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`;

function input(scope: SupportInput["scope"], record: StatusRecord, overrides: Partial<SupportInput> = {}): SupportInput {
  const path = record.path.bytes;
  const text = new TextDecoder().decode(path);
  const eol = scope === "empty-to-untracked" ? "" : eolRecord("lf", "lf", "", text);
  const patchText = scope === "empty-to-untracked" ? creationPatch(text) : plainPatch(text);
  return {
    scope,
    record,
    indexFlags: { intentToAdd: false, assumeUnchanged: false, skipWorktree: false },
    attributes: NO_ATTRIBUTES,
    working: { type: "file", size: 4, diskPath: path },
    eol: parseEolListing(bytes(eol))!,
    sizes: { raw: [4, 4], normalized: [4, 4] },
    patch: parsePatch(bytes(patchText), path),
    numstat: TEXT,
    ...overrides,
  };
}

const SUPPORTED: SupportDecision = { supported: true };
const reason = (r: SupportReason): SupportDecision => ({ supported: false, code: "UNSUPPORTED_COMPARISON", reason: r });
const unstaged = (path = "a.txt") => ordinary(".M", ["100644", "100644", "100644"], path);
const staged = (path = "a.txt") => ordinary("M.", ["100644", "100644", "100644"], path);
const untracked = (path = "u.txt"): StatusRecord => ({ kind: "untracked", path: { bytes: bytes(path), display: path } });

describe("support decision", () => {
  test("the reason list is the data-model §5 list", () => {
    expect([...SUPPORT_REASONS].sort()).toEqual((["binary", "encoding", "size", "rename", "mode", "type", "symlink", "submodule", "LFS", "filter", "state", "line-endings", "index-flag", "path"] as SupportReason[]).sort());
  });

  test("ordinary text comparisons are supported in each scope", () => {
    expect(decideSupport(input("index-to-worktree", unstaged()))).toEqual(SUPPORTED);
    expect(decideSupport(input("head-to-index", staged()))).toEqual(SUPPORTED);
    expect(decideSupport(input("empty-to-untracked", untracked()))).toEqual(SUPPORTED);
  });

  test("a metadata-only empty-file patch is supported and has no hunk", () => {
    const record = ordinary("A.", ["000000", "100644", "100644"], "e.txt");
    const patch = parsePatch(bytes("diff --git a/e.txt b/e.txt\nnew file mode 100644\nindex 0000000..e69de29\n"), bytes("e.txt"));
    expect(decideSupport(input("head-to-index", record, { patch }))).toEqual(SUPPORTED);
  });

  const cases: [string, SupportInput, SupportReason][] = [
    ["an unmerged entry gives state", input("index-to-worktree", { kind: "unmerged", xy: "UU", submodule: "N...", modes: ["100644", "100644", "100644", "100644"], oids: [HEAD_OID, HEAD_OID, HEAD_OID], path: { bytes: bytes("a.txt"), display: "a.txt" } }), "state"],
    ["an invalid UTF-8 path gives path", input("index-to-worktree", unstaged(), { record: { ...unstaged(), path: { bytes: latin1("a\xff.txt"), display: "a\\xff.txt" } } }), "path"],
    ["an on-disk name in another letter case gives path", input("index-to-worktree", unstaged(), { working: { type: "file", size: 4, diskPath: bytes("A.txt") } }), "path"],
    ["an unreadable working entry gives path", input("index-to-worktree", unstaged(), { working: { type: "unreadable" } }), "path"],
    ["intent-to-add gives index-flag", input("index-to-worktree", unstaged(), { indexFlags: { intentToAdd: true, assumeUnchanged: false, skipWorktree: false } }), "index-flag"],
    ["assume-unchanged gives index-flag", input("index-to-worktree", unstaged(), { indexFlags: { intentToAdd: false, assumeUnchanged: true, skipWorktree: false } }), "index-flag"],
    ["skip-worktree gives index-flag", input("head-to-index", staged(), { indexFlags: { intentToAdd: false, assumeUnchanged: false, skipWorktree: true } }), "index-flag"],
    ["a gitlink gives submodule", input("head-to-index", ordinary("M.", ["160000", "160000", "160000"], "sub", "SC..")), "submodule"],
    ["an untracked nested repository gives submodule", input("empty-to-untracked", untracked("nested/"), { working: { type: "directory", diskPath: bytes("nested/") } }), "submodule"],
    ["a staged type change gives type", input("head-to-index", ordinary("T.", ["100644", "120000", "120000"], "a.txt")), "type"],
    ["an untracked directory entry that is no file gives type", input("empty-to-untracked", untracked(), { working: { type: "other", diskPath: bytes("u.txt") } }), "type"],
    ["a staged symbolic link gives symlink", input("head-to-index", ordinary("M.", ["120000", "120000", "120000"], "l")), "symlink"],
    ["an untracked symbolic link gives symlink", input("empty-to-untracked", untracked("l"), { working: { type: "symlink", diskPath: bytes("l") } }), "symlink"],
    [
      "a staged rename gives rename",
      input("head-to-index", { kind: "rename", xy: "R.", submodule: "N...", modes: ["100644", "100644", "100644"], oids: [HEAD_OID, HEAD_OID], score: "R100", originalPath: { bytes: bytes("old.txt"), display: "old.txt" }, path: { bytes: bytes("a.txt"), display: "a.txt" } }),
      "rename",
    ],
    ["a staged mode change gives mode", input("head-to-index", ordinary("M.", ["100644", "100755", "100755"], "a.txt")), "mode"],
    ["an unstaged mode change gives mode", input("index-to-worktree", ordinary(".M", ["100644", "100644", "100755"], "a.txt")), "mode"],
    ["a filter attribute gives filter", input("index-to-worktree", unstaged(), { attributes: { ...NO_ATTRIBUTES, filter: "crypt" } }), "filter"],
    ["filter=lfs gives LFS", input("head-to-index", staged(), { attributes: { ...NO_ATTRIBUTES, filter: "lfs" } }), "LFS"],
    ["a working-tree-encoding attribute gives encoding", input("index-to-worktree", unstaged(), { attributes: { ...NO_ATTRIBUTES, "working-tree-encoding": "UTF-16LE" } }), "encoding"],
    ["a raw side above 1,048,576 bytes gives size", input("index-to-worktree", unstaged(), { sizes: { raw: [4, COMPARED_RAW_VERSION_BYTES + 1], normalized: [4, 4] } }), "size"],
    ["a normalized side above 1,048,576 bytes gives size", input("head-to-index", staged(), { sizes: { raw: [4, 4], normalized: [COMPARED_NORMALIZED_VERSION_BYTES + 1, 4] } }), "size"],
    ["a binary numstat record gives binary for an unstaged comparison", input("index-to-worktree", unstaged(), { numstat: BINARY }), "binary"],
    ["a binary numstat record gives binary for a staged comparison", input("head-to-index", staged(), { numstat: BINARY }), "binary"],
    ["a binary numstat record gives binary for an untracked comparison", input("empty-to-untracked", untracked(), { numstat: BINARY }), "binary"],
    ["mixed on the index side gives line-endings", input("index-to-worktree", unstaged(), { eol: parseEolListing(bytes(eolRecord("mixed", "lf", "", "a.txt")))! }), "line-endings"],
    ["mixed on the working side gives line-endings", input("head-to-index", staged(), { eol: parseEolListing(bytes(eolRecord("lf", "mixed", "text=auto eol=crlf", "a.txt")))! }), "line-endings"],
    ["a canonical diff bound gives size", input("index-to-worktree", unstaged(), { patch: { ok: false, completeness: { state: "limited", code: "OUTPUT_LIMIT", reason: "CANONICAL_DIFF_LINES" } } }), "size"],
    ["invalid UTF-8 content gives encoding", input("index-to-worktree", unstaged(), { patch: parsePatch(latin1(plainPatch("a.txt", "@@ -1,2 +1,2 @@\n a\n-b\n+\xe9\n")), bytes("a.txt")) }), "encoding"],
  ];
  for (const [name, value, expected] of cases) {
    test(name, () => expect(decideSupport(value)).toEqual(reason(expected)));
  }

  test("a function heading cut inside a UTF-8 sequence is not content", () => {
    const patch = parsePatch(latin1(plainPatch("a.txt", "@@ -1,2 +1,2 @@ f\xc3\n a\n-b\n+c\n")), bytes("a.txt"));
    expect(decideSupport(input("index-to-worktree", unstaged(), { patch }))).toEqual(SUPPORTED);
  });

  test("a malformed patch gives MALFORMED_GIT_OUTPUT", () => {
    const patch = parsePatch(bytes("diff --git a/a.txt b/a.txt\nindex 1234567..89abcde 100644\nBinary files a/a.txt and b/a.txt differ\n"), bytes("a.txt"));
    expect(decideSupport(input("index-to-worktree", unstaged(), { patch }))).toEqual({ supported: false, code: "MALFORMED_GIT_OUTPUT" });
  });

  test("a tracked entry without its ls-files record gives MALFORMED_GIT_OUTPUT", () => {
    expect(decideSupport(input("index-to-worktree", unstaged(), { eol: parseEolListing(new Uint8Array())! }))).toEqual({ supported: false, code: "MALFORMED_GIT_OUTPUT" });
  });

  test("i/none is no line-ending refusal", () => {
    expect(decideSupport(input("index-to-worktree", unstaged(), { eol: parseEolListing(bytes(eolRecord("none", "lf", "", "a.txt")))! }))).toEqual(SUPPORTED);
  });

  test("-text on either ls-files side is no binary signal", () => {
    expect(decideSupport(input("index-to-worktree", unstaged(), { eol: parseEolListing(bytes(eolRecord("-text", "-text", "", "a.txt")))! }))).toEqual(SUPPORTED);
  });

  test("a malformed numstat result gives MALFORMED_GIT_OUTPUT", () => {
    const numstat = parseNumstat(bytes("-\t3\ta.txt\0"), bytes("a.txt"), null);
    expect(decideSupport(input("index-to-worktree", unstaged(), { numstat }))).toEqual({ supported: false, code: "MALFORMED_GIT_OUTPUT" });
  });

  test("the reasons follow the pinned order", () => {
    const all = input("index-to-worktree", ordinary(".M", ["100644", "100644", "100755"], "a.txt"), {
      attributes: { ...NO_ATTRIBUTES, filter: "crypt", "working-tree-encoding": "UTF-16LE" },
      sizes: { raw: [COMPARED_RAW_VERSION_BYTES + 1, 4], normalized: [4, 4] },
      eol: parseEolListing(bytes(eolRecord("mixed", "lf", "", "a.txt")))!,
      numstat: BINARY,
    });
    const order: [Partial<SupportInput>, SupportReason][] = [
      [{}, "mode"],
      [{ record: unstaged() }, "filter"],
      [{ record: unstaged(), attributes: { ...NO_ATTRIBUTES, "working-tree-encoding": "UTF-16LE" } }, "encoding"],
      [{ record: unstaged(), attributes: NO_ATTRIBUTES }, "size"],
      [{ record: unstaged(), attributes: NO_ATTRIBUTES, sizes: { raw: [4, 4], normalized: [4, 4] } }, "binary"],
      [{ record: unstaged(), attributes: NO_ATTRIBUTES, sizes: { raw: [4, 4], normalized: [4, 4] }, numstat: TEXT }, "line-endings"],
    ];
    for (const [change, expected] of order) expect(decideSupport({ ...all, ...change })).toEqual(reason(expected));
  });
});

// Research R3 "Untracked hunk content" (T092): Git reads the index `.gitattributes` only without a working file (attr.c `read_attr`).
describe("index-only .gitattributes refuses untracked hunks", () => {
  const listing = (...records: string[]) => parseEolListing(bytes(records.join("")))!;

  test("an index .gitattributes without a working file in the same folder gives line-endings", () => {
    const eol = listing(eolRecord("lf", "", "", "dir/.gitattributes"));
    expect(decideSupport(input("empty-to-untracked", untracked("dir/u.txt"), { eol }))).toEqual(reason("line-endings"));
  });

  test("an index .gitattributes without a working file in an ancestor folder gives line-endings", () => {
    for (const at of [".gitattributes", "a/.gitattributes"]) {
      const eol = listing(eolRecord("lf", "", "", at));
      expect(decideSupport(input("empty-to-untracked", untracked("a/b/u.txt"), { eol }))).toEqual(reason("line-endings"));
    }
  });

  test("a regular working .gitattributes keeps untracked hunks", () => {
    const eol = listing(eolRecord("lf", "lf", "", ".gitattributes"), eolRecord("lf", "crlf", "", "a/.gitattributes"));
    expect(decideSupport(input("empty-to-untracked", untracked("a/u.txt"), { eol }))).toEqual(SUPPORTED);
  });

  test("an index .gitattributes in a sibling or child folder keeps untracked hunks", () => {
    const eol = listing(eolRecord("lf", "", "", "b/.gitattributes"), eolRecord("lf", "", "", "a/c/.gitattributes"), eolRecord("lf", "", "", "a/x.gitattributes"));
    expect(decideSupport(input("empty-to-untracked", untracked("a/u.txt"), { eol }))).toEqual(SUPPORTED);
  });

  test("the decision takes no configuration, so core.safecrlf gives no untracked refusal", () => {
    // The `buildF04` "safecrlf" files equal the `git add -p` oracle (research R3 re-probe).
    for (const path of ["u-lf.txt", "u-crlf.txt", "u-mixed.txt", "u-noeol.txt"]) {
      expect(decideSupport(input("empty-to-untracked", untracked(path)))).toEqual(SUPPORTED);
    }
  });
});

describe("check-attr -z output", () => {
  const triples = (path: string, values: string[]) => ["filter", "diff", "text", "eol", "crlf", "working-tree-encoding"].map((name, i) => `${path}\0${name}\0${values[i]}\0`).join("");
  const six = (value: string) => [value, value, value, value, value, value];

  test("each path gets its six values in request order", () => {
    const out = bytes(triples("a b.txt", ["lfs", "unset", "set", "crlf", "unspecified", "UTF-16LE"]) + triples("c", six("unspecified")));
    const parsed = parseAttributes(out, [bytes("a b.txt"), bytes("c")]);
    expect(parsed?.[0]).toEqual({ filter: "lfs", diff: "unset", text: "set", eol: "crlf", crlf: "unspecified", "working-tree-encoding": "UTF-16LE" });
    expect(parsed?.[1]).toEqual(NO_ATTRIBUTES);
  });

  test("a missing, extra, reordered, or foreign triple gives null", () => {
    const good = triples("a", six("unspecified"));
    const paths = [bytes("a")];
    expect(parseAttributes(bytes(good.slice(0, -1)), paths)).toBeNull();
    expect(parseAttributes(bytes(good + "a\0filter\0set\0"), paths)).toBeNull();
    expect(parseAttributes(bytes(good.replace("filter", "diff")), paths)).toBeNull();
    expect(parseAttributes(bytes(triples("b", six("unspecified"))), paths)).toBeNull();
  });
});

describe("ls-files --eol -z output", () => {
  test("records parse by the fixed write_eolinfo layout, also for an 18-character attribute", () => {
    const listing = parseEolListing(bytes(eolRecord("lf", "crlf", "text=auto eol=crlf", "a\tb.txt") + eolRecord("", "", "-text", "gone.bin")));
    expect(listing?.get("a\tb.txt")).toEqual([{ index: "lf", working: "crlf", attr: "text=auto eol=crlf" }]);
    expect(listing?.get("gone.bin")).toEqual([{ index: "", working: "", attr: "-text" }]);
  });

  test("an unknown value, a wrong width, or a missing NUL gives null", () => {
    expect(parseEolListing(bytes(eolRecord("cr", "lf", "", "a")))).toBeNull();
    expect(parseEolListing(bytes(eolRecord("lf", "lf", "text eol=cr", "a")))).toBeNull();
    expect(parseEolListing(bytes("i/lf w/lf    attr/                 \ta\0"))).toBeNull();
    expect(parseEolListing(bytes(eolRecord("lf", "lf", "", "a").slice(0, -1)))).toBeNull();
    expect(parseEolListing(bytes(eolRecord("lf", "lf", "", "")))).toBeNull();
  });
});
