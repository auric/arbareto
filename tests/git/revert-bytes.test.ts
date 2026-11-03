// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 008 T025 and T060: the pure functions of `src/git-service/revert-bytes.ts` (data-model §6, research.md R5, plan.md D3).
// The expected bytes come from the data-model §6 table. The expected blob IDs come from Git's own `hash-object` in owned repositories.

import { describe, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PatchHunk } from "../../src/git-service/diff-parser";
import { printOrigin } from "../origin";
import { faGit } from "./file-actions-fixtures";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { gitPath } from "./hunk-harness";
import { caseTest } from "./service-harness";

useFixtureRoot();

const TASK = "T025";
// The module does not exist before T026, so each case loads it and fails alone. The first load prints the ORIGIN line.
let origin = false;
function load(): Promise<typeof import("../../src/git-service/revert-bytes.ts")> {
  if (!origin) origin = Boolean(printOrigin("../../src/git-service/revert-bytes.ts", import.meta.dir));
  return import("../../src/git-service/revert-bytes.ts");
}

const enc = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const text = (bytes: Uint8Array | string) => (typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("latin1"));

// A hunk as `parsePatch` gives it: the header line through the last body or marker line, each with its LF.
function hunk(lines: string[]): PatchHunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[0]!)!;
  const bytes = enc(lines.map((l) => `${l}\n`).join(""));
  return { ordinal: 1, oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes };
}

const NO_NEWLINE = "\\ No newline at end of file";

describe("reverseLines: the data-model §6 cases", () => {
  // Each row: the working bytes, the partial patch against the working side, the `ls-files --eol` `w/` and `attr/` values, `core.autocrlf`, and the restored bytes.
  // The `restoreEol` value of the facts is the `eol` argument, as `revert.ts` passes it (T060).
  type Autocrlf = "true" | "false" | "input";
  const rows: { task: string; name: string; working: string; patch: string[]; eol: { working: string; attr: string }; autocrlf: Autocrlf; out: string }[] = [
    { task: TASK, name: "LF, no conversion: the restored line keeps its comparison bytes (LF)", working: "a\nB\nc\n", patch: ["@@ -2 +2 @@", "-b", "+B"], eol: { working: "lf", attr: "" }, autocrlf: "false", out: "a\nb\nc\n" },
    { task: TASK, name: "CRLF, no conversion, index CRLF: the restored line keeps its comparison bytes (CRLF)", working: "a\r\nB\r\nc\r\n", patch: ["@@ -2 +2 @@", "-b\r", "+B\r"], eol: { working: "crlf", attr: "" }, autocrlf: "false", out: "a\r\nb\r\nc\r\n" },
    { task: TASK, name: "CRLF, core.autocrlf=true, index LF: the LF line gets a CR before its LF", working: "a\r\nB\r\nc\r\n", patch: ["@@ -2 +2 @@", "-b", "+B"], eol: { working: "crlf", attr: "" }, autocrlf: "true", out: "a\r\nb\r\nc\r\n" },
    { task: TASK, name: "CRLF, text eol=crlf: the LF line gets a CR before its LF", working: "x\r\ny\r\nZ\r\n", patch: ["@@ -1,3 +1,3 @@", " x", " y", "-z", "+Z"], eol: { working: "crlf", attr: "text eol=crlf" }, autocrlf: "false", out: "x\r\ny\r\nz\r\n" },
    { task: TASK, name: "LF, core.autocrlf=true, index LF: the restored line ends with LF", working: "a\nB\nc\n", patch: ["@@ -2 +2 @@", "-b", "+B"], eol: { working: "lf", attr: "" }, autocrlf: "true", out: "a\nb\nc\n" },
    // Git's checkout writes the LF blob bytes without a conversion, and check-in keeps CRLF, so the restored lines keep LF (T060).
    { task: "T060", name: "CRLF, no conversion, index LF: every restored line keeps its comparison bytes (LF)", working: "a\r\nB\r\nc\r\n", patch: ["@@ -1,3 +1,3 @@", "-a", "-b", "-c", "+a\r", "+B\r", "+c\r"], eol: { working: "crlf", attr: "" }, autocrlf: "false", out: "a\nb\nc\n" },
    { task: "T060", name: "CRLF, -text, index LF: the restored line keeps its comparison bytes (LF), also with core.autocrlf=true", working: "a\r\nB\r\n", patch: ["@@ -2 +2 @@", "-b", "+B\r"], eol: { working: "crlf", attr: "-text" }, autocrlf: "true", out: "a\r\nb\n" },
    { task: TASK, name: "mixed: any other value keeps the comparison bytes", working: "a\nB\r\nc\n", patch: ["@@ -2 +2 @@", "-b", "+B\r"], eol: { working: "mixed", attr: "text" }, autocrlf: "false", out: "a\nb\nc\n" },
    { task: TASK, name: "an empty value keeps the comparison bytes", working: "a\r\nB\r\n", patch: ["@@ -2 +2 @@", "-b", "+B"], eol: { working: "", attr: "text=auto" }, autocrlf: "false", out: "a\r\nb\n" },
  ];
  for (const row of rows) {
    caseTest(row.task, row.name, [], async () => {
      const { restoreEol, reverseLines } = await load();
      expect(text(reverseLines(enc(row.working), hunk(row.patch), restoreEol(row.eol, row.autocrlf)) as Uint8Array)).toBe(row.out);
    });
  }

  // Git v2.56.0 `convert.c` `convert_attrs`, `get_convert_attr_ascii`, and `output_eol`: only CRLF_BINARY converts in neither direction.
  caseTest("T060", "restoreEol: the attribute actions -text and, with core.autocrlf=false, the unset action keep the comparison bytes; every other action takes the w/ value", [], async () => {
    const { restoreEol } = await load();
    const attrs = ["", "-text", "text", "text eol=lf", "text eol=crlf", "text=auto", "text=auto eol=crlf", "text=auto eol=lf"];
    const got = attrs.flatMap((attr) => (["true", "false", "input"] as const).map((autocrlf) => ({ attr, autocrlf, crlf: restoreEol({ working: "crlf", attr }, autocrlf), lf: restoreEol({ working: "lf", attr }, autocrlf) })));
    const binary = (attr: string, autocrlf: string) => attr === "-text" || (attr === "" && autocrlf === "false");
    expect(got).toEqual(got.map(({ attr, autocrlf }) => ({ attr, autocrlf, crlf: binary(attr, autocrlf) ? "" : "crlf", lf: binary(attr, autocrlf) ? "" : "lf" })));
    expect(got.filter((g) => g.crlf === "").map((g) => [g.attr, g.autocrlf])).toEqual([
      ["", "false"],
      ["-text", "true"],
      ["-text", "false"],
      ["-text", "input"],
    ]);
  });

  caseTest(TASK, "a pure addition goes, a pure removal comes back at its place, and every other line keeps its raw bytes", [], async () => {
    const { reverseLines } = await load();
    expect(text(reverseLines(enc("a\r\nx\ny\r\nc\n"), hunk(["@@ -1,0 +2,2 @@", "+x", "+y"]), "mixed") as Uint8Array)).toBe("a\r\nc\n");
    // A count of 0 prints the line before the change as its start (xdiff `xdl_emit_hunk_hdr`).
    expect(text(reverseLines(enc("a\r\nd\r\n"), hunk(["@@ -2,2 +1,0 @@", "-b", "-c"]), "crlf") as Uint8Array)).toBe("a\r\nb\r\nc\r\nd\r\n");
    expect(text(reverseLines(enc("b\nc\n"), hunk(["@@ -1 +0,0 @@", "-a"]), "lf") as Uint8Array)).toBe("a\nb\nc\n");
  });

  caseTest(TASK, "a partial patch of the unstage rule keeps the unselected added line as context", [], async () => {
    const { reverseLines } = await load();
    // The hunk `-b +B +C` with only `+C` selected: the unselected `+B` is context, and the unselected `-b` drops.
    expect(text(reverseLines(enc("a\r\nB\r\nC\r\nd\r\n"), hunk(["@@ -1,3 +1,4 @@", " a", " B", "+C", " d"]), "crlf") as Uint8Array)).toBe("a\r\nB\r\nd\r\n");
  });

  caseTest(TASK, "a line without an ending: a working line without LF matches, and a restored line without an ending keeps its comparison bytes", [], async () => {
    const { reverseLines } = await load();
    expect(text(reverseLines(enc("a\nB"), hunk(["@@ -2 +2 @@", "-b", NO_NEWLINE, "+B", NO_NEWLINE]), "lf") as Uint8Array)).toBe("a\nb");
    expect(text(reverseLines(enc("a\r\nb\r\nc\r\n"), hunk(["@@ -2 +2,2 @@", "-b", NO_NEWLINE, "+b", "+c"]), "crlf") as Uint8Array)).toBe("a\r\nb");
    expect(text(reverseLines(enc("a\nc"), hunk(["@@ -2 +2 @@", "-b", "+c", NO_NEWLINE]), "lf") as Uint8Array)).toBe("a\nb\n");
  });

  caseTest(TASK, "a context or added line that the working bytes do not hold gives stale", [], async () => {
    const { reverseLines } = await load();
    const patch = hunk(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"]);
    expect(reverseLines(enc("a\nB\nZ\n"), patch, "lf")).toBe("stale");
    expect(reverseLines(enc("a\nX\nc\n"), patch, "lf")).toBe("stale");
    // A CR is the only byte that check-in drops, so another byte before LF is a mismatch.
    expect(reverseLines(enc("a\nB \nc\n"), patch, "lf")).toBe("stale");
    // The working file ends before the hunk does.
    expect(reverseLines(enc("a\nB\n"), patch, "lf")).toBe("stale");
  });
});

describe("autocrlfOf: core.autocrlf as Git reads it (T060)", () => {
  // Git v2.56.0 `environment.c` `git_default_core_config`: "input" by `strcasecmp`, else `git_config_bool`. A key without `=` is true.
  const entry = (value: string | null, exact = true) => ({ key: "core.autocrlf", value, exact });
  const listing = (entries: { key: string; value: string | null; exact: boolean }[], inputLimited = false) => ({ entries, inputLimited }) as unknown as Parameters<Awaited<ReturnType<typeof load>>["autocrlfOf"]>[0];

  caseTest("T060", "the last entry wins, false is the default, and a value that Git cannot read, a cut listing, or an inexact value gives null", [], async () => {
    const { autocrlfOf } = await load();
    const values: [string | null, string | null][] = [
      ["true", "true"],
      ["Yes", "true"],
      ["1", "true"],
      [null, "true"],
      ["false", "false"],
      ["off", "false"],
      ["", "false"],
      ["0", "false"],
      ["input", "input"],
      ["INPUT", "input"],
      ["crlf", null],
    ];
    for (const [value, expected] of values) expect({ value, got: autocrlfOf(listing([entry(value)])) as string | null }).toEqual({ value, got: expected });
    expect(autocrlfOf(listing([]))).toBe("false");
    expect(autocrlfOf(listing([{ key: "core.eol", value: "crlf", exact: true }]))).toBe("false");
    expect(autocrlfOf(listing([entry("true"), entry("false")]))).toBe("false");
    expect(autocrlfOf(listing([entry("true", false)]))).toBe(null);
    expect(autocrlfOf(listing([entry("true")], true))).toBe(null);
  });
});

describe("blobId: the blob ID of the proof (research.md R5)", () => {
  const contents = ["", "a\nb\nc\n", "a\r\nb\r\nc\r\n", "x\u0000y"];
  for (const format of ["sha1", "sha256"] as const) {
    caseTest(TASK, `blobId equals git hash-object in a ${format} repository`, [], async () => {
      const { blobId } = await load();
      const repo = join(fixtureDir(`t025-blob-${format}`), "repo");
      mkdirSync(repo, { recursive: true });
      faGit(gitPath(), repo, ["init", "-q", `--object-format=${format}`]);
      for (const content of contents) {
        const expected = faGit(gitPath(), repo, ["hash-object", "--no-filters", "--stdin"], { input: enc(content) }).toString("utf8").trim();
        expect({ format, content, id: blobId(enc(content), format) }).toEqual({ format, content, id: expected });
      }
    });
  }

  // Without a conversion, check-in keeps CR, so a CRLF restored line fails the proof (T060 keeps the LF comparison bytes).
  caseTest(TASK, "CRLF bytes have another blob ID than the LF index content", [], async () => {
    const { blobId } = await load();
    expect(blobId(enc("a\r\nb\r\nc\r\n"), "sha1")).not.toBe(blobId(enc("a\nb\nc\n"), "sha1"));
  });
});
