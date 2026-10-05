// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  HISTORY_COMMIT_OBJECT_BYTES,
  HISTORY_PARENTS_PER_COMMIT,
  HISTORY_PARENTS_PER_PAGE,
  HISTORY_STREAM_BYTES,
  HISTORY_STREAM_ROWS,
} from "../../src/contracts/limits";
import { batchCommandArgs, revListArgs, type ObjectFormat } from "../../src/git-service/commands";
import type { Completeness } from "../../src/git-service/snapshot";
import { parseCommitObjects, parseTraversal } from "../../src/git-service/history-parser";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { buildF01, buildF16History, buildF19, F16_OBJECT_LIMIT, type Built, type F16HistoryVariant, type F19Variant } from "./fixtures";
import { GIT } from "./git-binary";
import { caseTest } from "./service-harness";

printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/commands.ts", import.meta.dir);
printOrigin("../../src/git-service/history-parser.ts", import.meta.dir);

const TASK = "T286";
const TIMEOUT_MS = 120_000;

useFixtureRoot();

const gitPath = (): string => {
  if (GIT === null) throw new Error("Git executable absent");
  return GIT;
};

// Contract §5 history bounds that apply to the parser input. The keys are the export names in `limits.ts`.
const BOUNDS = { HISTORY_STREAM_ROWS, HISTORY_STREAM_BYTES, HISTORY_PARENTS_PER_COMMIT, HISTORY_PARENTS_PER_PAGE, HISTORY_COMMIT_OBJECT_BYTES };
type HistoryBound = keyof typeof BOUNDS;

// Contract §9: `limited` carries `OUTPUT_LIMIT` with the reached §5 bound, or `OBJECT_MISSING`. `failed` carries the specific code.
// The shape is the `Completeness` of `src/git-service/snapshot.ts`.
const COMPLETE = { state: "complete" } as const;
const limited = (reason: HistoryBound) => ({ state: "limited", code: "OUTPUT_LIMIT", reason }) as const;
const OBJECT_MISSING = { state: "limited", code: "OBJECT_MISSING" } as const;
// Research R2 "Machine-readable reads": an incomplete record is never success. Contract §9 permits `limited` only for a §5 bound or a missing object.
const MALFORMED = { state: "failed", code: "MALFORMED_GIT_OUTPUT" } as const;

const repoOf = (built: Built) => join(built.root, "repo");

// Oracle reads. They use other options than the reads under test.
const git = (repo: string, args: string[], options: { input?: Uint8Array; allowExit?: number[] } = {}) =>
  ownedGit(gitPath(), FIXTURE_ROOT, repo, ["--no-lazy-fetch", "--no-optional-locks", ...args], options);

const formatOf = (repo: string): ObjectFormat => {
  const format = git(repo, ["rev-parse", "--show-object-format"]).toString().trim();
  if (format !== "sha1" && format !== "sha256") throw new Error(`object format ${format}`);
  return format;
};
const headOf = (repo: string): string => git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim();

// The reads under test: exactly the T076 arrays.
const revList = (repo: string, oid: string, format: ObjectFormat): Buffer => ownedGit(gitPath(), FIXTURE_ROOT, repo, revListArgs(oid, format));
// gitdoc git-cat-file "--batch-command" and "-Z": each command is `contents <object>` and ends with NUL.
const batchInput = (oids: readonly string[]): Buffer => Buffer.from(oids.map((oid) => `contents ${oid}\0`).join(""), "latin1");
const catFile = (repo: string, oids: readonly string[]): Buffer => ownedGit(gitPath(), FIXTURE_ROOT, repo, batchCommandArgs(), { input: batchInput(oids) });

interface Row {
  oid: string;
  parents: string[];
}

// Oracle traversal: `git log` with `%H %P` in Git date order. In a shallow repository `%P` gives the effective parents.
function oracleRows(repo: string, tip: string, count = HISTORY_STREAM_ROWS): Row[] {
  const out = git(repo, ["log", "--date-order", `--max-count=${count}`, "--format=%H %P", tip]).toString("latin1");
  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [oid, ...parents] = line.split(" ").filter((part) => part !== "");
      return { oid: oid!, parents };
    });
}

// Contract §5 "History page": the page keeps the rows before the first row that passes the bound.
function boundedRows(rows: Row[]): { rows: Row[]; reason: HistoryBound | null } {
  let references = 0;
  for (const [i, row] of rows.entries()) {
    if (i >= HISTORY_STREAM_ROWS) return { rows: rows.slice(0, i), reason: "HISTORY_STREAM_ROWS" };
    if (row.parents.length > HISTORY_PARENTS_PER_COMMIT) return { rows: rows.slice(0, i), reason: "HISTORY_PARENTS_PER_COMMIT" };
    references += row.parents.length;
    if (references > HISTORY_PARENTS_PER_PAGE) return { rows: rows.slice(0, i), reason: "HISTORY_PARENTS_PER_PAGE" };
  }
  return { rows, reason: null };
}

const traversalOf = (parsed: { rows: readonly Row[]; completeness: object }) => ({
  rows: parsed.rows.map((row) => ({ oid: row.oid, parents: row.parents })),
  completeness: parsed.completeness,
});

interface ObjectFacts {
  oid: string;
  size: number;
  sha256: string;
  parents: string[];
  encoding: string | null;
}

const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

// Raw `parent` header lines: the header block ends at the first empty line (gitdoc git-cat-file "-p", commit object format).
const headerParents = (content: Buffer) =>
  content
    .subarray(0, content.indexOf("\n\n"))
    .toString("latin1")
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length));

// Oracle objects: one `cat-file commit` and `cat-file -s` per object, and the `encoding` header through `log --no-walk --format=%e`.
function oracleObjects(repo: string, oids: readonly string[]): ObjectFacts[] {
  return oids.map((oid) => {
    const content = git(repo, ["cat-file", "commit", oid]);
    const size = Number(git(repo, ["cat-file", "-s", oid]).toString().trim());
    const encoding = git(repo, ["log", "--no-walk", "--format=%e", oid]).toString("latin1").replace(/\n$/, "");
    return { oid, size, sha256: digest(content), parents: headerParents(content), encoding: encoding === "" ? null : encoding };
  });
}

interface ParsedObject {
  oid: string;
  size: number;
  content: Uint8Array;
  parents: string[];
  encoding: string | null;
}

const factsOf = (objects: readonly ParsedObject[]): ObjectFacts[] =>
  objects.map((o) => ({ oid: o.oid, size: o.size, sha256: digest(o.content), parents: o.parents, encoding: o.encoding }));

// gitdoc git-cat-file "BATCH OUTPUT" with `-Z`: `<oid> SP <type> SP <size> NUL <contents> NUL` for each object.
const framedLength = (objects: readonly ObjectFacts[], type = "commit") =>
  objects.reduce((n, o) => n + `${o.oid} ${type} ${o.size}`.length + 1 + o.size + 1, 0);

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const bytes = (text: string) => Buffer.from(text, "latin1");
const lines = (out: string) => out.split("\n").slice(0, -1);
const text = (rows: string[]) => `${rows.join("\n")}\n`;

// Replaces the header of the first frame. The content bytes stay.
function withFirstHeader(out: Buffer, edit: (header: string) => string): Buffer {
  const end = out.indexOf(0);
  return Buffer.concat([bytes(edit(latin1(out.subarray(0, end)))), out.subarray(end)]);
}

// A well-formed object ID that names no object in the repository. `cat-file -e` proves the absence.
function absentOid(repo: string, format: ObjectFormat): string {
  const oid = new Bun.CryptoHasher(format).update(`t286-absent-${repo}`).digest("hex");
  git(repo, ["cat-file", "-e", oid], { allowExit: [1, 128] });
  return oid;
}

const F19_VARIANTS: F19Variant[] = ["linear", "merge", "octopus", "skewed", "roots", "long", "wide", "encoding", "shallow", "sha256"];

// Each F16 history variant with the bound that its traversal reaches, or null.
const F16_CASES: [F16HistoryVariant, HistoryBound | null][] = [
  ["parents-64", null],
  ["parents-65", "HISTORY_PARENTS_PER_COMMIT"],
  ["parent-refs", "HISTORY_PARENTS_PER_PAGE"],
  ["object-at-limit", null],
  ["object-over-limit", null],
  ["traversal", null],
];

describe("rev-list --parents rows (contract §3 \"HistoryPage result\")", () => {
  for (const variant of F19_VARIANTS) {
    caseTest(
      TASK,
      `F19 ${variant}: rows equal git log --date-order --format="%H %P" in Git row order, with full OIDs and ordered parents`,
      [],
      () => {
        const built = buildF19(gitPath(), `t286-rows-f19-${variant}`, variant);
        const repo = repoOf(built);
        const format = formatOf(repo);
        const tip = headOf(repo);
        expect(tip).toBe(built.facts.notes.tip as string);
        expect(format).toBe(variant === "sha256" ? "sha256" : "sha1");
        const expected = oracleRows(repo, tip);
        const parsed = traversalOf(parseTraversal(revList(repo, tip, format), format));
        expect(parsed).toEqual({ rows: expected, completeness: COMPLETE });
        if (variant === "long") expect(parsed.rows.length).toBe(HISTORY_STREAM_ROWS);
        if (variant === "shallow") {
          // The shallow commit is a row with no effective parent.
          const shallow = (built.facts.notes.shallow as string[])[0]!;
          expect(parsed.rows.find((row) => row.oid === shallow)?.parents).toEqual([]);
        }
      },
      TIMEOUT_MS,
    );
  }

  for (const [variant, reason] of F16_CASES) {
    caseTest(
      TASK,
      reason === null
        ? `F16 ${variant}: the traversal is complete and equals the oracle`
        : `F16 ${variant}: the traversal gives limited with reason ${reason}, and the rows are the oracle rows before the first row that passes the bound`,
      [],
      () => {
        const built = buildF16History(gitPath(), `t286-rows-f16-${variant}`, variant);
        const repo = repoOf(built);
        const format = formatOf(repo);
        const tip = headOf(repo);
        expect(tip).toBe((built.facts.notes.commits as Record<string, string>).tip!);
        const out = revList(repo, tip, format);
        const oracle = oracleRows(repo, tip);
        const bounded = boundedRows(oracle);
        expect(bounded.reason).toBe(reason);
        const parsed = traversalOf(parseTraversal(out, format));
        expect(parsed).toEqual({ rows: bounded.rows, completeness: reason === null ? COMPLETE : limited(reason) });
        if (reason !== null) expect(parsed.rows.length).toBeLessThan(oracle.length);
        if (variant === "traversal") {
          // Research.md line 1636 names the traversal output as the 128 KiB input. This output stays far below it.
          expect(out.length).toBeLessThan(HISTORY_STREAM_BYTES);
          console.log(`OBSERVATION ${TASK}: F16 history-traversal rev-list --parents output is ${out.length} bytes for ${parsed.rows.length} rows, below HISTORY_STREAM_BYTES ${HISTORY_STREAM_BYTES}`);
        }
      },
      TIMEOUT_MS,
    );
  }

  caseTest(
    TASK,
    "F01 empty and unborn-added: HEAD names no commit, so empty traversal and cat-file output give an empty complete result",
    [],
    () => {
      for (const variant of ["empty", "unborn-added"] as const) {
        const repo = repoOf(buildF01(gitPath(), `t286-f01-${variant}`, variant));
        const format = formatOf(repo);
        // `rev-parse --verify -q` exits 1 for an unborn HEAD, so no read has an OID to anchor.
        git(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], { allowExit: [1] });
        expect(git(repo, ["symbolic-ref", "HEAD"]).toString().trim()).toBe("refs/heads/main");
        expect(traversalOf(parseTraversal(new Uint8Array(0), format))).toEqual({ rows: [], completeness: COMPLETE });
        const objects = parseCommitObjects(new Uint8Array(0), [], format);
        expect({ objects: factsOf(objects.objects), completeness: objects.completeness }).toEqual({ objects: [], completeness: COMPLETE });
      }
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `F19 long: rev-list --max-count=${HISTORY_STREAM_ROWS + 1} output gives limited with reason HISTORY_STREAM_ROWS and the first ${HISTORY_STREAM_ROWS} rows`,
    [],
    () => {
      const repo = repoOf(buildF19(gitPath(), "t286-rows-limit", "long"));
      const format = formatOf(repo);
      const tip = headOf(repo);
      const out = git(repo, ["rev-list", "--parents", `--max-count=${HISTORY_STREAM_ROWS + 1}`, "--date-order", tip]);
      expect(latin1(out).split("\n").filter((line) => line !== "").length).toBe(HISTORY_STREAM_ROWS + 1);
      expect(traversalOf(parseTraversal(out, format))).toEqual({ rows: oracleRows(repo, tip), completeness: limited("HISTORY_STREAM_ROWS") });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `F19 linear: the real rows and then one LF-ended line of 130 KiB give limited with reason HISTORY_STREAM_BYTES and keep the real rows`,
    [],
    () => {
      const repo = repoOf(buildF19(gitPath(), "t286-rows-stream-bytes", "linear"));
      const format = formatOf(repo);
      const tip = headOf(repo);
      const out = text([...lines(latin1(revList(repo, tip, format))), "a".repeat(130 * 1024)]);
      expect(traversalOf(parseTraversal(bytes(out), format))).toEqual({ rows: oracleRows(repo, tip), completeness: limited("HISTORY_STREAM_BYTES") });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `F19 long: ${HISTORY_STREAM_ROWS} real rows and then a row without its LF give limited with reason HISTORY_STREAM_ROWS, not a truncation result`,
    [],
    () => {
      const repo = repoOf(buildF19(gitPath(), "t286-rows-limit-no-lf", "long"));
      const format = formatOf(repo);
      const tip = headOf(repo);
      const out = git(repo, ["rev-list", "--parents", `--max-count=${HISTORY_STREAM_ROWS + 1}`, "--date-order", tip]).subarray(0, -1);
      expect(traversalOf(parseTraversal(out, format))).toEqual({ rows: oracleRows(repo, tip), completeness: limited("HISTORY_STREAM_ROWS") });
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    `F16 parents-65: one non-hex parent in the row with ${HISTORY_PARENTS_PER_COMMIT + 1} parents gives limited with reason HISTORY_PARENTS_PER_COMMIT, not a malformed result`,
    [],
    () => {
      const repo = repoOf(buildF16History(gitPath(), "t286-rows-parents-non-hex", "parents-65"));
      const format = formatOf(repo);
      const tip = headOf(repo);
      const all = lines(latin1(revList(repo, tip, format)));
      const at = all.findIndex((line) => line.split(" ").length - 1 > HISTORY_PARENTS_PER_COMMIT);
      const fields = all[at]!.split(" ");
      fields[1] = `g${fields[1]!.slice(1)}`;
      all[at] = fields.join(" ");
      const bounded = boundedRows(oracleRows(repo, tip));
      expect(bounded.reason).toBe("HISTORY_PARENTS_PER_COMMIT");
      expect(traversalOf(parseTraversal(bytes(text(all)), format))).toEqual({ rows: bounded.rows, completeness: limited("HISTORY_PARENTS_PER_COMMIT") });
    },
    TIMEOUT_MS,
  );
});

describe("rev-list --parents refusals (contract §3: \"Reject duplicate rows, malformed OIDs, and invalid in-page parent ordering\")", () => {
  // One real traversal per case. `edit` derives the refused bytes from it.
  const refusal = (name: string, variant: F19Variant, edit: (out: string, rows: Row[]) => string, format?: (actual: ObjectFormat) => ObjectFormat) =>
    caseTest(
      TASK,
      name,
      [],
      () => {
        const repo = repoOf(buildF19(gitPath(), `t286-refuse-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 48)}`, variant));
        const actual = formatOf(repo);
        const tip = headOf(repo);
        const out = latin1(revList(repo, tip, actual));
        const derived = edit(out, oracleRows(repo, tip));
        // A format case keeps the real bytes and changes only the object format.
        expect(derived !== out || format !== undefined).toBe(true);
        expect(parseTraversal(bytes(derived), format?.(actual) ?? actual).completeness).toEqual(MALFORMED);
      },
      TIMEOUT_MS,
    );

  refusal("duplicate row: the last (root) line of F19 linear appended once more", "linear", (out) => text([...lines(out), lines(out).at(-1)!]));
  refusal("duplicate row: the F19 merge side line repeated directly after itself", "merge", (out, rows) => {
    const at = rows.findIndex((row) => row.parents.length === 1 && rows.some((r) => r.parents.length === 2 && r.parents[1] === row.oid));
    const all = lines(out);
    return text([...all.slice(0, at + 1), all[at]!, ...all.slice(at + 1)]);
  });

  // The rule: each parent that is a row of the page has a later row index than its child (Git child-before-parent order, data-model §4 "Row order").
  refusal("invalid in-page parent order: the first two lines of F19 linear swapped", "linear", (out) => {
    const [a, b, ...rest] = lines(out);
    return text([b!, a!, ...rest]);
  });
  refusal("invalid in-page parent order: the F19 merge root line moved to the top", "merge", (out) => {
    const all = lines(out);
    return text([all.at(-1)!, ...all.slice(0, -1)]);
  });
  refusal("invalid in-page parent order: an F19 linear row names its own OID as parent", "linear", (out, rows) =>
    out.replace(`${rows[0]!.oid} ${rows[0]!.parents[0]!}`, `${rows[0]!.oid} ${rows[0]!.oid}`),
  );

  refusal("object format: the real F19 sha256 output parsed as sha1", "sha256", (out) => out, () => "sha1");
  refusal("object format: the real F19 linear sha1 output parsed as sha256", "linear", (out) => out, () => "sha256");
  refusal("object format: the first row OID of F19 linear in uppercase", "linear", (out, rows) => out.replace(rows[0]!.oid, rows[0]!.oid.toUpperCase()));
  refusal("object format: the first parent OID of F19 merge in uppercase", "merge", (out, rows) => out.replace(` ${rows[0]!.parents[0]!}`, ` ${rows[0]!.parents[0]!.toUpperCase()}`));
  refusal("object format: one non-hex digit in the parent OID of the first F19 linear row", "linear", (out, rows) => out.replace(` ${rows[0]!.parents[0]!}`, ` g${rows[0]!.parents[0]!.slice(1)}`));
  refusal("object format: the first row OID of F19 linear one digit short", "linear", (out, rows) => out.replace(`${rows[0]!.oid} `, `${rows[0]!.oid.slice(1)} `));
  refusal("object format: the first parent OID of F19 sha256 one digit long", "sha256", (out, rows) => out.replace(` ${rows[0]!.parents[0]!}`, ` ${rows[0]!.parents[0]!}0`));

  refusal("truncated stream: F19 linear output without its final LF", "linear", (out) => out.slice(0, -1));
  refusal("truncated stream: F19 merge output cut inside the second row OID", "merge", (out) => out.slice(0, out.indexOf("\n") + 1 + 20));
  refusal("framing: F19 linear output with CRLF line ends", "linear", (out) => out.replaceAll("\n", "\r\n"));
  refusal("framing: F19 merge output with two spaces before the first parent", "merge", (out) => out.replace(" ", "  "));
  refusal("framing: F19 linear output with an empty line after the first row", "linear", (out) => out.replace("\n", "\n\n"));
});

describe("cat-file --batch-command -Z framing by object type and byte length (research.md R2)", () => {
  const objectCase = (name: string, build: () => Built, bound: HistoryBound | null) =>
    caseTest(
      TASK,
      bound === null
        ? `${name}: each object equals cat-file commit and -s, with the raw parent headers and the encoding header`
        : `${name}: the objects give limited with reason ${bound}, and the objects before the first object that passes the bound`,
      [],
      () => {
        const built = build();
        const repo = repoOf(built);
        const format = formatOf(repo);
        const oids = oracleRows(repo, headOf(repo)).map((row) => row.oid);
        const out = catFile(repo, oids);
        const expected = oracleObjects(repo, oids);
        // The real stream is exactly the documented frames.
        expect(out.length).toBe(framedLength(expected));
        let kept = expected;
        if (bound === "HISTORY_PARENTS_PER_COMMIT") kept = expected.slice(0, expected.findIndex((o) => o.parents.length > HISTORY_PARENTS_PER_COMMIT));
        if (bound === "HISTORY_PARENTS_PER_PAGE") {
          let references = 0;
          kept = expected.slice(0, expected.findIndex((o) => (references += o.parents.length) > HISTORY_PARENTS_PER_PAGE));
        }
        if (bound === "HISTORY_COMMIT_OBJECT_BYTES") kept = expected.slice(0, expected.findIndex((o) => o.size > HISTORY_COMMIT_OBJECT_BYTES));
        const parsed = parseCommitObjects(out, oids, format);
        expect({ objects: factsOf(parsed.objects), completeness: parsed.completeness }).toEqual({
          objects: kept,
          completeness: bound === null ? COMPLETE : limited(bound),
        });
        if (bound !== null) expect(kept.length).toBeLessThan(expected.length);
      },
      TIMEOUT_MS,
    );

  for (const variant of F19_VARIANTS) objectCase(`F19 ${variant}`, () => buildF19(gitPath(), `t286-objects-f19-${variant}`, variant), null);
  const OBJECT_BOUNDS: Record<F16HistoryVariant, HistoryBound | null> = {
    "parents-64": null,
    "parents-65": "HISTORY_PARENTS_PER_COMMIT",
    "parent-refs": "HISTORY_PARENTS_PER_PAGE",
    "object-at-limit": null,
    "object-over-limit": "HISTORY_COMMIT_OBJECT_BYTES",
    traversal: null,
  };
  for (const [variant, bound] of Object.entries(OBJECT_BOUNDS) as [F16HistoryVariant, HistoryBound | null][]) {
    objectCase(`F16 ${variant}`, () => buildF16History(gitPath(), `t286-objects-f16-${variant}`, variant), bound);
  }

  caseTest(
    TASK,
    "F19 encoding: the legacy commit gives encoding ISO-8859-1 from its header, and each other commit gives none",
    [],
    () => {
      const built = buildF19(gitPath(), "t286-encoding", "encoding");
      const repo = repoOf(built);
      const tip = headOf(repo);
      const oids = oracleRows(repo, tip).map((row) => row.oid);
      const parsed = parseCommitObjects(catFile(repo, oids), oids, formatOf(repo));
      expect(parsed.completeness).toEqual(COMPLETE);
      expect(parsed.objects.map((o: ParsedObject) => [o.oid, o.encoding])).toEqual(oids.map((oid) => [oid, oid === tip ? "ISO-8859-1" : null]));
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "F19 shallow: the shallow commit keeps its raw parent header, and its traversal row has no parent",
    [],
    () => {
      const built = buildF19(gitPath(), "t286-shallow", "shallow");
      const repo = repoOf(built);
      const format = formatOf(repo);
      const tip = headOf(repo);
      const shallow = (built.facts.notes.shallow as string[])[0]!;
      // The builder facts name the parent from the source repository, which the shallow clone lacks.
      const rawParent = (built.facts.notes.parents as Record<string, string[]>)[shallow]!;
      expect(rawParent.length).toBe(1);
      git(repo, ["cat-file", "-e", rawParent[0]!], { allowExit: [1, 128] });
      const rows = parseTraversal(revList(repo, tip, format), format).rows;
      expect(rows.find((row: Row) => row.oid === shallow)?.parents).toEqual([]);
      const objects = parseCommitObjects(catFile(repo, [shallow]), [shallow], format).objects;
      expect(objects.map((o: ParsedObject) => o.parents)).toEqual([rawParent]);
    },
    TIMEOUT_MS,
  );

  caseTest(
    TASK,
    "parent and encoding lines in the message body are no headers: hash-object commit in an F19 linear copy",
    [],
    () => {
      const repo = repoOf(buildF19(gitPath(), "t286-body-headers", "linear"));
      const format = formatOf(repo);
      const tip = headOf(repo);
      const tree = git(repo, ["rev-parse", `${tip}^{tree}`]).toString().trim();
      const ident = "Arbareto Fixture <fixture@arbareto.invalid> 1767225600 +0000";
      const body = `tree ${tree}\nparent ${tip}\nauthor ${ident}\ncommitter ${ident}\n\nsubject\n\nparent ${tree}\nencoding ISO-8859-1\n`;
      const oid = git(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: bytes(body) }).toString().trim();
      const parsed = parseCommitObjects(catFile(repo, [oid]), [oid], format);
      expect({ objects: factsOf(parsed.objects), completeness: parsed.completeness }).toEqual({ objects: oracleObjects(repo, [oid]), completeness: COMPLETE });
      expect(parsed.objects.map((o: ParsedObject) => [o.parents, o.encoding])).toEqual([[[tip], null]]);
    },
    TIMEOUT_MS,
  );
});

describe("cat-file framing results (contract §7 \"Missing objects\", §9)", () => {
  // One real F19 merge stream of the oracle rows per case. `derive` returns the stream, the requests, and the format.
  const framing = (
    name: string,
    expected: Completeness,
    derive: (ctx: { repo: string; format: ObjectFormat; oids: string[]; out: Buffer }) => { out: Uint8Array; oids: string[]; format?: ObjectFormat },
    variant: F19Variant = "merge",
  ) =>
    caseTest(
      TASK,
      name,
      [],
      () => {
        const repo = repoOf(buildF19(gitPath(), `t286-frame-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 48)}`, variant));
        const format = formatOf(repo);
        const oids = oracleRows(repo, headOf(repo)).map((row) => row.oid);
        const derived = derive({ repo, format, oids, out: catFile(repo, oids) });
        expect(parseCommitObjects(derived.out, derived.oids, derived.format ?? format).completeness).toEqual(expected);
      },
      TIMEOUT_MS,
    );

  caseTest(
    TASK,
    "missing object answer: real `<oid> missing` after two commits gives limited with OBJECT_MISSING and keeps the two commits",
    [],
    () => {
      const repo = repoOf(buildF19(gitPath(), "t286-missing", "merge"));
      const format = formatOf(repo);
      const [tip, ...rest] = oracleRows(repo, headOf(repo)).map((row) => row.oid);
      const absent = absentOid(repo, format);
      const oids = [tip!, rest.at(-1)!, absent];
      const out = catFile(repo, oids);
      expect(latin1(out).endsWith(`${absent} missing\0`)).toBe(true);
      const parsed = parseCommitObjects(out, oids, format);
      expect({ objects: factsOf(parsed.objects), completeness: parsed.completeness }).toEqual({ objects: oracleObjects(repo, oids.slice(0, 2)), completeness: OBJECT_MISSING });
    },
    TIMEOUT_MS,
  );

  framing("wrong object type: the real tree answer for the tip tree OID", MALFORMED, ({ repo, oids }) => {
    const tree = git(repo, ["rev-parse", `${oids[0]!}^{tree}`]).toString().trim();
    const requests = [oids[0]!, tree];
    return { out: catFile(repo, requests), oids: requests };
  });
  framing("wrong object type: the first header type field changed from commit to blob", MALFORMED, ({ out, oids }) => ({
    out: withFirstHeader(out, (h) => h.replace(" commit ", " blob ")),
    oids,
  }));
  framing("size mismatch: the first header size field one byte larger", MALFORMED, ({ out, oids }) => ({
    out: withFirstHeader(out, (h) => h.replace(/ (\d+)$/, (_, n: string) => ` ${Number(n) + 1}`)),
    oids,
  }));
  framing("size mismatch: the first header size field one byte smaller", MALFORMED, ({ out, oids }) => ({
    out: withFirstHeader(out, (h) => h.replace(/ (\d+)$/, (_, n: string) => ` ${Number(n) - 1}`)),
    oids,
  }));
  framing("header length: the first header size field replaced by 1 MiB of decimal digits", MALFORMED, ({ out, oids }) => ({
    out: withFirstHeader(out, (h) => h.replace(/ (\d+)$/, ` ${"9".repeat(1024 * 1024)}`)),
    oids,
  }));
  framing("size field: the first header size field not decimal", MALFORMED, ({ out, oids }) => ({ out: withFirstHeader(out, (h) => h.replace(/ (\d+)$/, " 0x10")), oids }));
  framing("truncated stream: the real stream without its final NUL", MALFORMED, ({ out, oids }) => ({ out: out.subarray(0, -1), oids }));
  framing("truncated stream: the real stream cut inside the first object content", MALFORMED, ({ out, oids }) => ({ out: out.subarray(0, out.indexOf(0) + 10), oids }));
  framing("truncated stream: the real stream cut inside the first header", MALFORMED, ({ out, oids }) => ({ out: out.subarray(0, 20), oids }));
  framing("fewer answers than requests: the real stream of all rows with one more request", MALFORMED, ({ repo, format, out, oids }) => ({
    out,
    oids: [...oids, absentOid(repo, format)],
  }));
  framing("more answers than requests: the real stream of all rows with the last request removed", MALFORMED, ({ out, oids }) => ({ out, oids: oids.slice(0, -1) }));
  framing("answer order: the real stream with the requests in reverse order", MALFORMED, ({ out, oids }) => ({ out, oids: [...oids].reverse() }));
  framing("object format: the first header OID in uppercase", MALFORMED, ({ out, oids }) => ({ out: withFirstHeader(out, (h) => h.replace(oids[0]!, oids[0]!.toUpperCase())), oids }));
  framing("object format: the real F19 sha256 stream parsed as sha1", MALFORMED, ({ out, oids }) => ({ out, oids, format: "sha1" }), "sha256");
  framing("object format: the real F19 merge sha1 stream parsed as sha256", MALFORMED, ({ out, oids }) => ({ out, oids, format: "sha256" }));
});

describe(`the ${HISTORY_COMMIT_OBJECT_BYTES}-byte object bound applies before the content (research.md R2 "Bound commit objects before reading their content")`, () => {
  // The F16 object variants: requests [root, tip], so the kept prefix holds the root object.
  const objectBound = (name: string, variant: "object-at-limit" | "object-over-limit", expected: Completeness | null, derive: (out: Buffer, tipFrame: number) => Buffer) =>
    caseTest(
      TASK,
      name,
      [],
      () => {
        const built = buildF16History(gitPath(), `t286-bound-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 48)}`, variant);
        const repo = repoOf(built);
        const format = formatOf(repo);
        const commits = built.facts.notes.commits as Record<string, string>;
        const oids = [commits.root!, commits.tip!];
        expect(F16_OBJECT_LIMIT).toBe(HISTORY_COMMIT_OBJECT_BYTES);
        const facts = oracleObjects(repo, oids);
        expect(facts[1]!.size).toBe(built.facts.notes.objectBytes as number);
        const out = catFile(repo, oids);
        const tipFrame = framedLength(facts.slice(0, 1));
        const parsed = parseCommitObjects(derive(out, tipFrame), oids, format);
        expect({ objects: factsOf(parsed.objects), completeness: parsed.completeness }).toEqual(
          expected === null ? { objects: facts, completeness: COMPLETE } : { objects: facts.slice(0, 1), completeness: expected },
        );
      },
      TIMEOUT_MS,
    );

  const tipHeaderEnd = (out: Buffer, tipFrame: number) => out.indexOf(0, tipFrame);
  const editTipSize = (out: Buffer, tipFrame: number, size: string) => {
    const end = tipHeaderEnd(out, tipFrame);
    const header = latin1(out.subarray(tipFrame, end)).replace(/ \d+$/, ` ${size}`);
    return Buffer.concat([out.subarray(0, tipFrame), bytes(header), out.subarray(end)]);
  };

  objectBound(`F16 object-at-limit: a ${HISTORY_COMMIT_OBJECT_BYTES}-byte commit is complete`, "object-at-limit", null, (out) => out);
  objectBound(
    `F16 object-over-limit: a ${HISTORY_COMMIT_OBJECT_BYTES + 1}-byte commit gives limited with reason HISTORY_COMMIT_OBJECT_BYTES`,
    "object-over-limit",
    limited("HISTORY_COMMIT_OBJECT_BYTES"),
    (out) => out,
  );
  objectBound(
    "F16 object-over-limit: the real stream cut 10 bytes after the over-limit header gives the bound result, not a truncation result",
    "object-over-limit",
    limited("HISTORY_COMMIT_OBJECT_BYTES"),
    (out, tipFrame) => out.subarray(0, tipHeaderEnd(out, tipFrame) + 1 + 10),
  );
  objectBound(
    "F16 object-over-limit: the real stream cut directly after the over-limit header gives the bound result",
    "object-over-limit",
    limited("HISTORY_COMMIT_OBJECT_BYTES"),
    (out, tipFrame) => out.subarray(0, tipHeaderEnd(out, tipFrame) + 1),
  );
  objectBound(
    "F16 object-over-limit: the over-limit content replaced by 0xFF bytes of the same length gives the bound result, not a malformed result",
    "object-over-limit",
    limited("HISTORY_COMMIT_OBJECT_BYTES"),
    (out, tipFrame) => {
      const start = tipHeaderEnd(out, tipFrame) + 1;
      return Buffer.concat([out.subarray(0, start), Buffer.alloc(out.length - 1 - start, 0xff), out.subarray(-1)]);
    },
  );
  objectBound(
    `F16 object-at-limit: the tip size field changed to ${HISTORY_COMMIT_OBJECT_BYTES + 1} gives the bound result, not a size mismatch`,
    "object-at-limit",
    limited("HISTORY_COMMIT_OBJECT_BYTES"),
    (out, tipFrame) => editTipSize(out, tipFrame, String(HISTORY_COMMIT_OBJECT_BYTES + 1)),
  );
  objectBound(
    "F16 object-at-limit: the tip size field changed to 2^40 and the stream cut after 10 content bytes gives the bound result",
    "object-at-limit",
    limited("HISTORY_COMMIT_OBJECT_BYTES"),
    (out, tipFrame) => {
      const edited = editTipSize(out, tipFrame, String(2 ** 40));
      return edited.subarray(0, tipHeaderEnd(edited, tipFrame) + 1 + 10);
    },
  );
});
