// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  HISTORY_COMMIT_OBJECT_BYTES,
  HISTORY_PARENTS_PER_COMMIT,
  HISTORY_PARENTS_PER_PAGE,
  HISTORY_STREAM_ROWS,
} from "../../src/contracts/limits";
import { batchCommandArgs, type ObjectFormat } from "../../src/git-service/commands";
import type { Completeness } from "../../src/git-service/snapshot";
import { parseCommitObjects } from "../../src/git-service/history-parser";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { cachedF16History } from "../windows/fixture-cache";
import { buildF19, F16_OBJECT_LIMIT, type Built, type F16HistoryVariant, type F19Variant } from "./fixtures";
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
const BOUNDS = { HISTORY_PARENTS_PER_COMMIT, HISTORY_PARENTS_PER_PAGE, HISTORY_COMMIT_OBJECT_BYTES };
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

// The read under test: exactly the T076 array.
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
    objectCase(`F16 ${variant}`, () => cachedF16History(gitPath(), `t286-objects-f16-${variant}`, variant).built, bound);
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
    "F19 shallow: the shallow commit keeps its raw parent header",
    [],
    () => {
      const built = buildF19(gitPath(), "t286-shallow", "shallow");
      const repo = repoOf(built);
      const format = formatOf(repo);
      const shallow = (built.facts.notes.shallow as string[])[0]!;
      // The builder facts name the parent from the source repository, which the shallow clone lacks.
      const rawParent = (built.facts.notes.parents as Record<string, string[]>)[shallow]!;
      expect(rawParent.length).toBe(1);
      git(repo, ["cat-file", "-e", rawParent[0]!], { allowExit: [1, 128] });
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
        // Two names share the first 48 characters, so the hash keeps each folder distinct.
        const built = cachedF16History(gitPath(), `t286-bound-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 48)}-${Bun.hash(name).toString(36)}`, variant).built;
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
