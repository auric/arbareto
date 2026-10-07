// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T285: tests of the streaming porcelain v2 `-z` parser (T078). `src/contracts/` defines no status record type, so this file fixes the parser API.
// - `createStatusParser(objectFormat)` returns `{ push(chunk: Uint8Array): void; end(): StatusParseResult }`.
// - `end()` gives `complete` with `branch` and `records`. It gives `limited` with `code` `OUTPUT_LIMIT`, `reason`, `branch`, and the records before the bound. Or it gives `failed` with `code` `MALFORMED_GIT_OUTPUT`.
// - `reason` is the export name of the reached bound in `limits.ts`, as in `tests/git/status.test.ts`.
// - `branch` holds `oid`, `head`, `upstream`, `ahead`, and `behind`. An absent header, `(initial)`, and `(detached)` give `null`.
// - A record holds `kind` and `path`. `path` is `{ bytes: Uint8Array; display: string }`.
// - Kinds `ordinary`, `rename`, and `unmerged` also hold `xy`, `submodule`, `modes`, and `oids` in git-status(1) field order. `rename` adds `score` and `originalPath`.
// - Branch headers are not records. A rename record counts as one record.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { codeFitsState, type ErrorCode } from "../../src/contracts/errors";
import * as LIMITS from "../../src/contracts/limits";
import { statusArgs, type ObjectFormat } from "../../src/git-service/commands";
import { createStatusParser, type StatusParseResult } from "../../src/git-service/status-parser";
import { printOrigin } from "../origin";
import { FIXTURE_ROOT, ownedGit, useFixtureRoot } from "./fixture-root";
import { cachedF16Status } from "../windows/f16-status-cache";
import { buildF01, buildF02, buildF03, buildF06, buildF10, F16_STATUS_RECORDS, type Built } from "./fixtures";
import { describeGit } from "./git-binary";
import { indexEntries } from "./git-oracle";

printOrigin("../../src/contracts/errors.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/git-service/commands.ts", import.meta.dir);
printOrigin("../../src/git-service/status-parser.ts", import.meta.dir);

const TASK = "T285";
const TIMEOUT_MS = 120_000;
const F16_TIMEOUT_MS = 600_000;
// Outputs up to this size also run every byte offset, one-byte chunks, and every cut.
const SMALL_OUTPUT_BYTES = 4096;

useFixtureRoot();

const MALFORMED: ErrorCode = "MALFORMED_GIT_OUTPUT";
const OUTPUT_LIMIT: ErrorCode = "OUTPUT_LIMIT";
const RECORDS_BOUND = "STATUS_LISTING_RECORDS" satisfies keyof typeof LIMITS;
const BYTES_BOUND = "STATUS_LISTING_BYTES" satisfies keyof typeof LIMITS;

const hex = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("hex");

// ---------------------------------------------------------------------------------------------------------------------
// Oracle: the git-status(1) "Porcelain Format Version 2" record rules, applied to a whole real listing.

type Kind = "ordinary" | "rename" | "unmerged" | "untracked" | "ignored";
interface ViewPath {
  hex: string;
  display: string;
}
interface View {
  kind: Kind;
  xy?: string;
  submodule?: string;
  modes?: string[];
  oids?: string[];
  score?: string;
  path: ViewPath;
  originalPath?: ViewPath;
}
interface Branch {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}
interface Span {
  start: number;
  end: number;
}
interface Item {
  start: number;
  // The offset after the last NUL of the record.
  end: number;
  header: boolean;
  tokens: Span[];
  separators: number[];
  paths: Span[];
  nuls: number[];
}
interface Oracle {
  items: Item[];
  branch: Branch;
  records: View[];
}

// git-status(1): the space-separated fields before the path. A rename record holds its original path after one more NUL.
const FIXED_TOKENS: Record<string, { tokens: number; kind: Kind }> = {
  "1": { tokens: 8, kind: "ordinary" },
  "2": { tokens: 9, kind: "rename" },
  u: { tokens: 10, kind: "unmerged" },
  "?": { tokens: 1, kind: "untracked" },
  "!": { tokens: 1, kind: "ignored" },
};

// Unicode Table 3-7 "Well-Formed UTF-8 Byte Sequences": the length of the sequence at `at`, or 0.
function wellFormedLength(b: Uint8Array, at: number): number {
  const c = b[at]!;
  const cont = (k: number, lo = 0x80, hi = 0xbf) => at + k < b.length && b[at + k]! >= lo && b[at + k]! <= hi;
  if (c < 0x80) return 1;
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0;
  if (c === 0xe0) return cont(1, 0xa0) && cont(2) ? 3 : 0;
  if ((c >= 0xe1 && c <= 0xec) || c === 0xee || c === 0xef) return cont(1) && cont(2) ? 3 : 0;
  if (c === 0xed) return cont(1, 0x80, 0x9f) && cont(2) ? 3 : 0;
  if (c === 0xf0) return cont(1, 0x90) && cont(2) && cont(3) ? 4 : 0;
  if (c >= 0xf1 && c <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (c === 0xf4) return cont(1, 0x80, 0x8f) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

// Data-model §5: valid UTF-8 displays as text, and each byte outside a well-formed sequence displays as `\xNN`.
function displayOf(b: Uint8Array): string {
  let out = "";
  for (let at = 0; at < b.length; ) {
    const n = wellFormedLength(b, at);
    if (n === 0) {
      out += `\\x${b[at]!.toString(16).padStart(2, "0")}`;
      at++;
    } else {
      out += Buffer.from(b.subarray(at, at + n)).toString("utf8");
      at += n;
    }
  }
  return out;
}

// Data-model §5 fixes the `\xNN` form, not the letter case of the hex digits.
const foldEscapes = (display: string) => display.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => `\\x${h.toLowerCase()}`);

function oracle(listing: Buffer): Oracle {
  const items: Item[] = [];
  const records: View[] = [];
  const branch: Branch = { oid: null, head: null, upstream: null, ahead: null, behind: null };
  const text = (s: Span) => listing.subarray(s.start, s.end).toString("latin1");
  const path = (s: Span): ViewPath => ({ hex: hex(listing.subarray(s.start, s.end)), display: displayOf(listing.subarray(s.start, s.end)) });
  for (let at = 0; at < listing.length; ) {
    const nul = listing.indexOf(0, at);
    if (nul < 0) throw new Error(`oracle: unterminated record at ${at}`);
    const type = String.fromCharCode(listing[at]!);
    const item: Item = { start: at, end: nul + 1, header: type === "#", tokens: [], separators: [], paths: [], nuls: [nul] };
    const tokenize = (from: number, count: number, limit: number): number => {
      let s = from;
      for (let t = 0; t < count; t++) {
        const space = listing.indexOf(0x20, s);
        const e = space < 0 || space > limit ? limit : space;
        item.tokens.push({ start: s, end: e });
        if (e === limit) return limit;
        item.separators.push(e);
        s = e + 1;
      }
      return s;
    };
    if (type === "#") {
      tokenize(at, Number.MAX_SAFE_INTEGER, nul);
      const [, key, ...values] = item.tokens.map(text);
      const value = values.join(" ");
      if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") branch.head = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.ab") [branch.ahead, branch.behind] = values.map((v) => Math.abs(Number(v)));
    } else {
      const rule = FIXED_TOKENS[type];
      if (rule === undefined) throw new Error(`oracle: unknown record type ${JSON.stringify(type)}`);
      const pathStart = tokenize(at, rule.tokens, nul);
      item.paths.push({ start: pathStart, end: nul });
      const fields = item.tokens.map(text);
      const view: View = { kind: rule.kind, path: path(item.paths[0]!) };
      if (rule.kind === "ordinary") Object.assign(view, { xy: fields[1], submodule: fields[2], modes: fields.slice(3, 6), oids: fields.slice(6, 8) });
      if (rule.kind === "rename") {
        const second = listing.indexOf(0, nul + 1);
        if (second < 0) throw new Error("oracle: rename record without its original path");
        item.paths.push({ start: nul + 1, end: second });
        item.nuls.push(second);
        item.end = second + 1;
        Object.assign(view, { xy: fields[1], submodule: fields[2], modes: fields.slice(3, 6), oids: fields.slice(6, 8), score: fields[8], originalPath: path(item.paths[1]!) });
      }
      if (rule.kind === "unmerged") Object.assign(view, { xy: fields[1], submodule: fields[2], modes: fields.slice(3, 7), oids: fields.slice(7, 10) });
      records.push(view);
    }
    items.push(item);
    at = item.end;
  }
  return { items, branch, records };
}

// ---------------------------------------------------------------------------------------------------------------------
// Parser access.

// Copies only the API fields, so a parser may hold more fields.
function viewPath(p: { bytes: Uint8Array; display: string }): ViewPath {
  return { hex: hex(p.bytes), display: foldEscapes(p.display) };
}

// The record fields that this file reads. `src/contracts/` has no status record type.
interface ParsedRecord {
  kind: Kind;
  path: { bytes: Uint8Array; display: string };
  xy?: string;
  submodule?: string;
  modes?: readonly string[];
  oids?: readonly string[];
  score?: string;
  originalPath?: { bytes: Uint8Array; display: string };
}

function viewRecord(r: ParsedRecord): View {
  const v: View = { kind: r.kind, path: viewPath(r.path) };
  if (r.kind === "ordinary" || r.kind === "rename" || r.kind === "unmerged") Object.assign(v, { xy: r.xy, submodule: r.submodule, modes: [...(r.modes ?? [])], oids: [...(r.oids ?? [])] });
  if (r.kind === "rename") Object.assign(v, { score: r.score, originalPath: r.originalPath === undefined ? undefined : viewPath(r.originalPath) });
  return v;
}

const viewBranch = (b: Branch): Branch => ({ oid: b.oid, head: b.head, upstream: b.upstream, ahead: b.ahead, behind: b.behind });

interface Summary {
  state: string;
  code?: string;
  reason?: string;
  branch?: Branch;
  records?: View[];
}

function summary(result: StatusParseResult): Summary {
  if (result.state === "failed") return { state: result.state, code: result.code };
  const out: Summary = { state: result.state, branch: viewBranch(result.branch), records: result.records.map(viewRecord) };
  if (result.state === "limited") Object.assign(out, { code: result.code, reason: result.reason });
  return out;
}

// Pushes the listing split at each cut, then ends the input.
function parse(listing: Uint8Array, cuts: Iterable<number> = [], objectFormat: ObjectFormat = "sha1"): StatusParseResult {
  const parser = createStatusParser(objectFormat);
  let from = 0;
  for (const cut of [...new Set(cuts)].sort((a, b) => a - b)) {
    if (cut <= from || cut >= listing.length) continue;
    parser.push(listing.subarray(from, cut));
    from = cut;
  }
  parser.push(listing.subarray(from));
  return parser.end();
}

function parseChunks(listing: Uint8Array, size: number, objectFormat: ObjectFormat = "sha1"): StatusParseResult {
  const parser = createStatusParser(objectFormat);
  for (let at = 0; at < listing.length; at += size) parser.push(listing.subarray(at, Math.min(at + size, listing.length)));
  return parser.end();
}

const json = (result: StatusParseResult) => Bun.hash(JSON.stringify(summary(result))).toString(16);
// A compact record key for large listings.
const key = (v: View) => `${v.kind} ${v.xy ?? ""} ${v.path.hex}`;

// Task T285: a truncated or malformed record gives `limited` or `MALFORMED_GIT_OUTPUT`. A `limited` result holds only records of the whole listing, in order.
function expectIncomplete(result: StatusParseResult, whole: View[] | null, label: string): void {
  if (result.state === "failed") {
    expect({ label, code: result.code }).toEqual({ label, code: MALFORMED });
    return;
  }
  expect({ label, state: result.state }).toEqual({ label, state: "limited" });
  if (result.state !== "limited") return;
  expect({ label, fits: codeFitsState("limited", result.code) }).toEqual({ label, fits: true });
  if (whole !== null) {
    const got = result.records.map(viewRecord).map(key);
    expect({ label, prefix: got }).toEqual({ label, prefix: whole.slice(0, got.length).map(key) });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Boundary types of task T285.

type Boundary = "fixed" | "between" | "path" | "nul";
const BOUNDARIES: Record<Boundary, string> = {
  fixed: "inside a fixed field",
  between: "between fields",
  path: "inside a path",
  nul: "at each NUL",
};

function itemBoundaries(listing: Buffer, item: Item): Record<Boundary, number[]> {
  const out: Record<Boundary, Set<number>> = { fixed: new Set(), between: new Set(), path: new Set(), nul: new Set() };
  const inside = (s: Span, set: Set<number>) => {
    for (let o = s.start + 1; o < s.end; o++) set.add(o);
  };
  for (const t of item.tokens) inside(t, out.fixed);
  for (const p of item.separators) out.between.add(p).add(p + 1);
  for (const p of item.paths) inside(p, out.path);
  for (const p of item.nuls) out.nul.add(p).add(p + 1);
  const valid = (set: Set<number>) => [...set].filter((o) => o > 0 && o < listing.length).sort((a, b) => a - b);
  return { fixed: valid(out.fixed), between: valid(out.between), path: valid(out.path), nul: valid(out.nul) };
}

// A small listing gives every offset of the type. A large listing gives the first and last offset of the type in its first two, middle, and last two items, because each parse reads the whole listing.
function boundaries(listing: Buffer, items: Item[], boundary: Boundary): number[] {
  if (listing.length <= SMALL_OUTPUT_BYTES) return [...new Set(items.flatMap((i) => itemBoundaries(listing, i)[boundary]))].sort((a, b) => a - b);
  const m = Math.floor(items.length / 2);
  const picked = [items[0]!, items[1]!, items[m]!, items[items.length - 2]!, items[items.length - 1]!];
  const out = new Set<number>();
  for (const item of picked) {
    const offsets = itemBoundaries(listing, item)[boundary];
    if (offsets.length > 0) out.add(offsets[0]!).add(offsets[offsets.length - 1]!);
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures.

interface Case {
  label: string;
  build: (git: string) => Built;
  hasPath: boolean;
  timeout: number;
}

const F10_CONFLICTS = ["merge", "rebase", "cherry-pick", "revert"] as const;

const CASES: Case[] = [
  { label: "F01 empty", build: (g) => buildF01(g, "t285-f01-empty", "empty"), hasPath: false, timeout: TIMEOUT_MS },
  { label: "F01 unborn-added", build: (g) => buildF01(g, "t285-f01-unborn", "unborn-added"), hasPath: true, timeout: TIMEOUT_MS },
  { label: "F02", build: (g) => buildF02(g, "t285-f02"), hasPath: true, timeout: TIMEOUT_MS },
  { label: "F03", build: (g) => buildF03(g, "t285-f03"), hasPath: true, timeout: TIMEOUT_MS },
  { label: "F06", build: (g) => buildF06(g, "t285-f06"), hasPath: true, timeout: TIMEOUT_MS },
  ...F10_CONFLICTS.map((v) => ({ label: `F10 ${v}`, build: (g: string) => buildF10(g, `t285-f10-${v}`, v), hasPath: true, timeout: TIMEOUT_MS })),
  { label: "F10 flags", build: (g) => buildF10(g, "t285-f10-flags", "flags"), hasPath: true, timeout: TIMEOUT_MS },
  { label: "F16 at-limit", build: (g) => cachedF16Status(g, "t285-f16-at", "at-limit").built, hasPath: true, timeout: F16_TIMEOUT_MS },
];

interface Output {
  built: Built;
  repo: string;
  objectFormat: ObjectFormat;
  listing: Buffer;
  oracle: Oracle;
}

describeGit("status parser (T285)", (git) => {
  const outputs = new Map<string, Output>();
  const run = (repo: string, args: string[], allowExit = [0]) => ownedGit(git, FIXTURE_ROOT, repo, args, { allowExit });

  // The T076 builder array, run by the harness process helper in the built repository.
  function output(label: string, build: (git: string) => Built): Output {
    let out = outputs.get(label);
    if (out === undefined) {
      const built = build(git);
      const repo = join(built.root, "repo");
      const listing = run(repo, statusArgs());
      const parsed = oracle(listing);
      out = { built, repo, objectFormat: built.facts.repos.repo!.objectFormat, listing, oracle: parsed };
      outputs.set(label, out);
      const kinds: Record<string, number> = {};
      for (const r of parsed.records) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
      console.log(`FACTS ${TASK} ${label}: ${listing.length} bytes, ${parsed.records.length} records ${JSON.stringify(kinds)}`);
    }
    return out;
  }
  const outputOf = (label: string) => output(label, CASES.find((c) => c.label === label)!.build);

  // Raw `ls-files -z --stage` or `ls-tree -z -r` entries, keyed by the hex of the path bytes.
  function entries(listing: Buffer): Map<string, { mode: string; oid: string; stage: string }> {
    const out = new Map<string, { mode: string; oid: string; stage: string }>();
    for (let at = 0; at < listing.length; ) {
      const nul = listing.indexOf(0, at);
      const record = listing.subarray(at, nul);
      const tab = record.indexOf(0x09);
      const [mode, second, third] = record.subarray(0, tab).toString("latin1").split(" ");
      // ls-files: `<mode> <oid> <stage>`. ls-tree: `<mode> <type> <oid>`.
      const fromTree = second === "blob" || second === "tree" || second === "commit";
      out.set(hex(record.subarray(tab + 1)), { mode: mode!, oid: fromTree ? third! : second!, stage: fromTree ? "0" : third! });
      at = nul + 1;
    }
    return out;
  }
  const indexOf = (repo: string) => entries(run(repo, ["--no-optional-locks", "ls-files", "-z", "--stage"]));
  const headOf = (repo: string) => entries(run(repo, ["--no-optional-locks", "ls-tree", "-z", "-r", "HEAD"]));

  // -------------------------------------------------------------------------------------------------------------------
  describe("real Git output, whole and split", () => {
    for (const c of CASES) {
      const small = () => outputOf(c.label).listing.length <= SMALL_OUTPUT_BYTES;

      test(
        `${c.label}: the whole output parses complete and equals the git-status(1) record rules`,
        () => {
          const o = output(c.label, c.build);
          expect(summary(parse(o.listing, [], o.objectFormat))).toEqual({ state: "complete", branch: o.oracle.branch, records: o.oracle.records });
        },
        c.timeout,
      );

      for (const boundary of Object.keys(BOUNDARIES) as Boundary[]) {
        if (boundary === "path" && !c.hasPath) continue;
        test(
          `${c.label}: a split ${BOUNDARIES[boundary]} gives the whole-output result`,
          () => {
            const o = output(c.label, c.build);
            const whole = json(parse(o.listing, [], o.objectFormat));
            const offsets = boundaries(o.listing, o.oracle.items, boundary);
            expect(offsets.length).toBeGreaterThan(0);
            // Each offset alone, then all offsets of this type at once.
            const wrong = offsets.filter((at) => json(parse(o.listing, [at], o.objectFormat)) !== whole);
            expect({ boundary, wrong: wrong.slice(0, 10) }).toEqual({ boundary, wrong: [] });
            expect(json(parse(o.listing, offsets, o.objectFormat))).toBe(whole);
          },
          c.timeout,
        );
      }

      if (c.label.startsWith("F16")) {
        test(
          `${c.label}: native ${LIMITS.NATIVE_CHUNK_BYTES}-byte chunks and odd 7919-byte chunks give the whole-output result`,
          () => {
            const o = output(c.label, c.build);
            const whole = json(parse(o.listing, [], o.objectFormat));
            expect(json(parseChunks(o.listing, LIMITS.NATIVE_CHUNK_BYTES, o.objectFormat))).toBe(whole);
            expect(json(parseChunks(o.listing, 7919, o.objectFormat))).toBe(whole);
          },
          c.timeout,
        );
        continue;
      }

      test(
        `${c.label}: a split at every byte offset, and one-byte chunks, give the whole-output result`,
        () => {
          const o = output(c.label, c.build);
          expect(small()).toBe(true);
          const whole = json(parse(o.listing, [], o.objectFormat));
          const wrong: number[] = [];
          for (let at = 1; at < o.listing.length; at++) if (json(parse(o.listing, [at], o.objectFormat)) !== whole) wrong.push(at);
          expect(wrong.slice(0, 10)).toEqual([]);
          expect(json(parseChunks(o.listing, 1, o.objectFormat))).toBe(whole);
        },
        c.timeout,
      );

      test(
        `${c.label}: a cut inside a record is never complete, and a cut at a record end after the headers gives the records before it`,
        () => {
          const o = output(c.label, c.build);
          const ends = new Map<number, number>();
          // statusArgs passes --branch, so a listing without both branch.oid and branch.head is incomplete.
          const lastHeader = o.oracle.items.findLast((i) => i.header)!;
          let records = 0;
          let headersDone = false;
          for (const item of o.oracle.items) {
            if (!item.header) {
              headersDone = true;
              records++;
            }
            if (headersDone || item === lastHeader) ends.set(item.end, records);
          }
          for (let at = 1; at < o.listing.length; at++) {
            const prefix = o.listing.subarray(0, at);
            const result = parse(prefix, [], o.objectFormat);
            const count = ends.get(at);
            if (count === undefined) {
              expectIncomplete(result, o.oracle.records, `cut at ${at}`);
              continue;
            }
            expect({ at, result: summary(result) }).toEqual({ at, result: { state: "complete", branch: o.oracle.branch, records: o.oracle.records.slice(0, count) } });
          }
        },
        c.timeout,
      );
    }
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("record kinds and fixture facts", () => {
    const parsed = (label: string): { o: Output; branch: Branch; records: View[] } => {
      const o = outputOf(label);
      const result = parse(o.listing, [], o.objectFormat);
      expect(result.state).toBe("complete");
      if (result.state !== "complete") throw new Error("not complete");
      return { o, branch: viewBranch(result.branch), records: result.records.map(viewRecord) };
    };
    // Code-unit order of the JSON form, so the order needs no locale.
    const shape = (records: View[]) =>
      records
        .map((r) => [r.kind, r.xy ?? null, r.path.display])
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
    const headBranch = (o: Output): Branch => {
      const head = o.built.facts.repos.repo!.head;
      return { oid: head.oid, head: head.target === null ? null : head.target.replace(/^refs\/heads\//, ""), upstream: null, ahead: null, behind: null };
    };

    test(
      "F01 empty: branch headers give an initial oid and the branch main, and no record",
      () => {
        const { branch, records } = parsed("F01 empty");
        expect({ branch, records }).toEqual({ branch: { oid: null, head: "main", upstream: null, ahead: null, behind: null }, records: [] });
      },
      TIMEOUT_MS,
    );

    test(
      "F01 unborn-added: ordinary added records and an untracked record",
      () => {
        const { o, branch, records } = parsed("F01 unborn-added");
        expect(branch).toEqual({ oid: null, head: "main", upstream: null, ahead: null, behind: null });
        expect(shape(records)).toEqual([
          ["ordinary", "A.", "empty.txt"],
          ["ordinary", "A.", "first.txt"],
          ["untracked", null, "untracked-empty.txt"],
        ]);
        const empty = o.built.facts.repos.repo!.entries.find((e) => e.path === "empty.txt")!;
        const record = records.find((r) => r.path.display === "empty.txt")!;
        expect({ modes: record.modes, index: record.oids![1] }).toEqual({ modes: ["000000", "100644", "100644"], index: empty.oid! });
        expect(record.oids![0]).toMatch(/^0{40}$/);
      },
      TIMEOUT_MS,
    );

    test(
      "F02: ordinary records keep the index and worktree status letters and the index object IDs",
      () => {
        const { o, branch, records } = parsed("F02");
        expect(branch).toEqual(headBranch(o));
        expect(shape(records)).toEqual([
          ["ordinary", "A.", "other-b.txt"],
          ["ordinary", "M.", "other-a.txt"],
          ["ordinary", "MM", "multi.txt"],
        ]);
        const index = new Map(indexEntries(git, o.repo).map((e) => [e.path, e]));
        for (const r of records) expect({ path: r.path.display, submodule: r.submodule, index: r.oids![1], mode: r.modes![1] }).toEqual({ path: r.path.display, submodule: "N...", index: index.get(r.path.display)!.oid, mode: index.get(r.path.display)!.mode });
      },
      TIMEOUT_MS,
    );

    test(
      "F03: Unicode, spaced, bracket, and option-like names keep their literal bytes and display",
      () => {
        const { records } = parsed("F03");
        const byName = (name: string) => records.filter((r) => r.path.hex === hex(name)).map((r) => ({ kind: r.kind, xy: r.xy, display: r.path.display }));
        for (const [name, xy] of [["-rf", "M."], ["[abc].txt", ".M"], ["no-newline.txt", ".M"], ["space dir/雪 café.txt", ".M"]] as const) {
          expect({ name, records: byName(name) }).toEqual({ name, records: [{ kind: "ordinary", xy, display: name }] });
        }
        // Unchanged paths get no record. `[abc].txt` is no glob for `a.txt`.
        expect({ option: byName("--output=x"), glob: byName("a.txt") }).toEqual({ option: [], glob: [] });
      },
      TIMEOUT_MS,
    );

    test(
      "F03: the case-only rename gives a rename record with both paths, when Git's index and HEAD probes show it",
      () => {
        const { o, records } = parsed("F03");
        const index = indexOf(o.repo);
        const head = headOf(o.repo);
        const from = head.get(hex("Readme.md"));
        const to = index.get(hex("README.md"));
        // The index and HEAD alone fix the index side of a rename. The worktree side follows the file system.
        const expected = from !== undefined && to !== undefined && !index.has(hex("Readme.md")) && from.oid === to.oid;
        const renames = records.filter((r) => r.kind === "rename");
        console.log(`FACTS ${TASK} F03 rename: index-and-HEAD probe expects one ${expected}; records ${JSON.stringify(renames.map((r) => [r.xy, r.score, r.path.display, r.originalPath!.display]))}`);
        expect(expected).toBe(true);
        expect(renames.map((r) => ({ x: r.xy![0], score: r.score, path: r.path, originalPath: r.originalPath, head: [r.modes![0], r.oids![0]], index: [r.modes![1], r.oids![1]] }))).toEqual([
          {
            x: "R",
            score: "R100",
            path: { hex: hex("README.md"), display: "README.md" },
            originalPath: { hex: hex("Readme.md"), display: "Readme.md" },
            head: [from!.mode, from!.oid],
            index: [to!.mode, to!.oid],
          },
        ]);
      },
      TIMEOUT_MS,
    );

    test(
      "F03: an index path with an invalid UTF-8 byte displays \\xNN and keeps its raw bytes",
      () => {
        const { o, records } = parsed("F03");
        const raw = Buffer.from(o.built.facts.notes.invalidUtf8IndexPath as string, "hex");
        expect(raw.includes(0xff)).toBe(true);
        const staged = indexOf(o.repo).get(hex(raw));
        expect({ inIndex: staged !== undefined, inHead: headOf(o.repo).has(hex(raw)) }).toEqual({ inIndex: true, inHead: false });
        const found = records.filter((r) => r.path.hex === hex(raw));
        expect(found.map((r) => ({ kind: r.kind, x: r.xy![0], display: r.path.display, index: r.oids![1] }))).toEqual([{ kind: "ordinary", x: "A", display: "bad-\\xff.txt", index: staged!.oid }]);
      },
      TIMEOUT_MS,
    );

    test(
      "F03: case-colliding index paths follow core.ignorecase from Git's own probe",
      () => {
        const { o, records } = parsed("F03");
        const probe = run(o.repo, ["config", "--get", "--type=bool", "core.ignorecase"], [0, 1]).toString().trim();
        const ignoreCase = probe === "true";
        console.log(`FACTS ${TASK} F03 core.ignorecase=${probe || "(unset)"}`);
        const collide = records.filter((r) => r.path.display.startsWith("collide/")).map((r) => [r.kind, r.xy, r.path.display]);
        console.log(`FACTS ${TASK} F03 collide records: ${JSON.stringify(collide)}`);
        // With `core.ignorecase` false, the file system is case-sensitive, and only `collide/Name.txt` exists on disk.
        // With it true, the reference host gives no record for either index path.
        expect(collide).toEqual(ignoreCase ? [] : [["ordinary", ".D", "collide/name.txt"]]);
      },
      TIMEOUT_MS,
    );

    test(
      "F06: a staged deletion and an untracked replacement stay separate records",
      () => {
        const { o, branch, records } = parsed("F06");
        expect(branch).toEqual(headBranch(o));
        expect(shape(records)).toEqual([
          ["ordinary", ".D", "deleted.txt"],
          ["ordinary", "A.", "added.txt"],
          ["ordinary", "D.", "replaced.txt"],
          ["untracked", null, "replaced.txt"],
          ["untracked", null, "untracked.txt"],
        ]);
      },
      TIMEOUT_MS,
    );

    for (const variant of F10_CONFLICTS) {
      test(
        `F10 ${variant}: an unmerged record holds the three stage modes and object IDs of the index`,
        () => {
          const { o, branch, records } = parsed(`F10 ${variant}`);
          expect(branch).toEqual(headBranch(o));
          if (variant === "rebase") expect(branch.head).toBeNull();
          expect(shape(records)).toEqual([["unmerged", "UU", "conflict.txt"]]);
          const stages = indexEntries(git, o.repo).filter((e) => e.path === "conflict.txt").sort((a, b) => a.stage - b.stage);
          expect(stages.map((e) => e.stage)).toEqual([1, 2, 3]);
          const record = records[0]!;
          expect({ submodule: record.submodule, modes: record.modes!.slice(0, 3), oids: record.oids }).toEqual({ submodule: "N...", modes: stages.map((e) => e.mode), oids: stages.map((e) => e.oid) });
        },
        TIMEOUT_MS,
      );
    }

    test(
      "F10 flags: an intent-to-add entry gives an ordinary .A record, and assume-unchanged and skip-worktree entries give none",
      () => {
        const { records } = parsed("F10 flags");
        expect(shape(records)).toEqual([["ordinary", ".A", "ita.txt"]]);
      },
      TIMEOUT_MS,
    );

    test(
      `F16 at-limit: exactly ${LIMITS.STATUS_LISTING_RECORDS} records give a complete result`,
      () => {
        const { o, records } = parsed("F16 at-limit");
        expect(F16_STATUS_RECORDS).toBe(LIMITS.STATUS_LISTING_RECORDS);
        expect(records.length).toBe(LIMITS.STATUS_LISTING_RECORDS);
        expect(records.every((r) => r.kind === "ordinary" && r.xy === ".D")).toBe(true);
        expect(records.map((r) => r.path.display)).toEqual(o.built.facts.repos.repo!.unstaged);
      },
      F16_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("synthetic records built from real Git output", () => {
    // Real F02 items: the branch headers, then each record.
    const f02 = () => {
      const o = outputOf("F02");
      const items = o.oracle.items.map((i) => o.listing.subarray(i.start, i.end));
      return { o, headers: items.filter((_, n) => o.oracle.items[n]!.header), records: items.filter((_, n) => !o.oracle.items[n]!.header) };
    };
    const everyOffset = (listing: Buffer) => {
      const whole = json(parse(listing));
      const wrong: number[] = [];
      for (let at = 1; at < listing.length; at++) if (json(parse(listing, [at])) !== whole) wrong.push(at);
      expect(wrong.slice(0, 10)).toEqual([]);
      expect(json(parseChunks(listing, 1))).toBe(whole);
    };

    test(
      "synthetic ignored record (statusArgs has no --ignored option): a real F06 untracked record with type ! gives an ignored record",
      () => {
        const o = outputOf("F06");
        const items = o.oracle.items.map((i) => Buffer.from(o.listing.subarray(i.start, i.end)));
        const untracked = items.find((b) => b[0] === 0x3f && b.subarray(2, b.length - 1).toString() === "untracked.txt")!;
        untracked[0] = 0x21;
        const listing = Buffer.concat(items);
        const result = parse(listing);
        expect(summary(result)).toEqual({ state: "complete", branch: o.oracle.branch, records: oracle(listing).records });
        expect(summary(result).records!.filter((r) => r.kind === "ignored")).toEqual([{ kind: "ignored", path: { hex: hex("untracked.txt"), display: "untracked.txt" } }]);
        everyOffset(listing);
      },
      TIMEOUT_MS,
    );

    test(
      "synthetic invalid UTF-8 path: real F02 record fields with lone and truncated multibyte sequences display \\xNN per byte and keep the raw bytes",
      () => {
        const { headers, records } = f02();
        const record = records.find((b) => b.toString("latin1").endsWith(" other-b.txt\0"))!;
        const fields = record.subarray(0, record.length - "other-b.txt\0".length);
        // 0xff and 0xfe are never valid. `e9 9b` lacks its last byte, and `c3` lacks its continuation. `e9 9b aa` is a valid 雪.
        const path = Buffer.concat([Buffer.from("bad-"), Buffer.from([0xff, 0xfe, 0x2d, 0xe9, 0x9b, 0x2d, 0xe9, 0x9b, 0xaa, 0x2d, 0xc3]), Buffer.from(".txt")]);
        const listing = Buffer.concat([...headers, fields, path, Buffer.from([0])]);
        const result = summary(parse(listing));
        expect(result.state).toBe("complete");
        expect(result.records).toEqual([{ ...oracle(listing).records[0]!, path: { hex: hex(path), display: "bad-\\xff\\xfe-\\xe9\\x9b-雪-\\xc3.txt" } }]);
        everyOffset(listing);
      },
      TIMEOUT_MS,
    );

    test(
      "synthetic branch headers: upstream and ahead-behind headers after the real F02 headers",
      () => {
        const { o, headers, records } = f02();
        const listing = Buffer.concat([...headers, Buffer.from("# branch.upstream origin/main\0# branch.ab +1 -2\0"), ...records]);
        expect(summary(parse(listing))).toEqual({ state: "complete", branch: { ...o.oracle.branch, upstream: "origin/main", ahead: 1, behind: 2 }, records: o.oracle.records });
        everyOffset(listing);
      },
      TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("bounds (contract §5)", () => {
    const headersOf = (label: string) => {
      const o = outputOf(label);
      return Buffer.concat(o.oracle.items.filter((i) => i.header).map((i) => o.listing.subarray(i.start, i.end)));
    };
    const untracked = (name: string, size: number) => {
      // `? ` plus the path plus NUL.
      const b = Buffer.alloc(size, 0x61);
      b.write(`? ${name}`, 0, "latin1");
      b[size - 1] = 0;
      return b;
    };
    // Untracked records of `size` bytes with distinct paths, and one last record that fills the listing to `total` bytes.
    function filled(head: Buffer, total: number, size: number): Buffer {
      const body = total - head.length;
      const count = Math.floor(body / size) - 1;
      const parts = [head];
      for (let i = 0; i < count; i++) parts.push(untracked(`u/${String(i).padStart(6, "0")}`, size));
      parts.push(untracked("v/", body - count * size));
      const listing = Buffer.concat(parts);
      expect(listing.length).toBe(total);
      expect(count + 1).toBeLessThan(LIMITS.STATUS_LISTING_RECORDS);
      return listing;
    }
    const expectLimited = (result: StatusParseResult, reason: string, whole: View[]) => {
      expect({ state: result.state, code: "code" in result ? result.code : undefined }).toEqual({ state: "limited", code: OUTPUT_LIMIT });
      if (result.state !== "limited") return;
      expect(result.reason).toBe(reason);
      expect(result.records.length).toBeLessThanOrEqual(LIMITS.STATUS_LISTING_RECORDS);
      expect(result.records.length).toBeLessThan(whole.length);
      const got = result.records.map(viewRecord).map(key);
      expect(got).toEqual(whole.slice(0, got.length).map(key));
    };

    test(
      `F16 over-limit: ${LIMITS.STATUS_LISTING_RECORDS} records plus one from real Git give limited with reason ${RECORDS_BOUND}`,
      () => {
        const built = cachedF16Status(git, "t285-f16-over", "over-limit").built;
        expect(built.facts.notes.records).toBe(LIMITS.STATUS_LISTING_RECORDS + 1);
        const listing = run(join(built.root, "repo"), statusArgs());
        const whole = oracle(listing).records;
        expect(whole.length).toBe(LIMITS.STATUS_LISTING_RECORDS + 1);
        expectLimited(parse(listing), RECORDS_BOUND, whole);
        expectLimited(parseChunks(listing, LIMITS.NATIVE_CHUNK_BYTES), RECORDS_BOUND, whole);
      },
      F16_TIMEOUT_MS,
    );

    test(
      `a listing of exactly ${LIMITS.STATUS_LISTING_BYTES} bytes is complete`,
      () => {
        const listing = filled(headersOf("F02"), LIMITS.STATUS_LISTING_BYTES, 4096);
        const result = parseChunks(listing, LIMITS.NATIVE_CHUNK_BYTES);
        expect(result.state).toBe("complete");
        if (result.state === "complete") expect(result.records.length).toBe(oracle(listing).records.length);
      },
      TIMEOUT_MS,
    );

    test(
      `a listing of ${LIMITS.STATUS_LISTING_BYTES} bytes plus one gives limited with reason ${BYTES_BOUND}, also when the last byte comes alone`,
      () => {
        const listing = filled(headersOf("F02"), LIMITS.STATUS_LISTING_BYTES + 1, 4096);
        const whole = oracle(listing).records;
        expectLimited(parseChunks(listing, LIMITS.NATIVE_CHUNK_BYTES), BYTES_BOUND, whole);
        expectLimited(parse(listing, [listing.length - 1]), BYTES_BOUND, whole);
      },
      TIMEOUT_MS,
    );

    test(
      `the first reached bound wins: ${RECORDS_BOUND} before ${BYTES_BOUND}`,
      () => {
        const small = Array.from({ length: LIMITS.STATUS_LISTING_RECORDS + 1 }, (_, i) => untracked(`r/${String(i).padStart(6, "0")}`, 12));
        const big = Array.from({ length: 9 }, (_, i) => untracked(`big/${i}`, 4 * 1024 * 1024));
        const listing = Buffer.concat([headersOf("F02"), ...small, ...big]);
        expect(listing.length).toBeGreaterThan(LIMITS.STATUS_LISTING_BYTES);
        expectLimited(parseChunks(listing, LIMITS.NATIVE_CHUNK_BYTES), RECORDS_BOUND, oracle(listing).records);
      },
      TIMEOUT_MS,
    );

    test(
      `one untracked path of 0xff bytes that fills ${LIMITS.STATUS_LISTING_BYTES} bytes parses complete in bounded time`,
      () => {
        const head = headersOf("F02");
        const listing = Buffer.alloc(LIMITS.STATUS_LISTING_BYTES, 0xff);
        head.copy(listing);
        listing.write("? ", head.length, "latin1");
        listing[listing.length - 1] = 0;
        const pathBytes = listing.length - head.length - 3;
        const start = performance.now();
        const result = parseChunks(listing, LIMITS.NATIVE_CHUNK_BYTES);
        const ms = performance.now() - start;
        console.log(`FACTS ${TASK} 0xff path of ${pathBytes} bytes: ${Math.round(ms)} ms`);
        expect(result.state).toBe("complete");
        if (result.state !== "complete") return;
        expect(result.records.length).toBe(1);
        const path = result.records[0]!.path;
        expect({ bytes: path.bytes.length, every: path.bytes.every((b) => b === 0xff), display: path.display === "\\xff".repeat(pathBytes) }).toEqual({ bytes: pathBytes, every: true, display: true });
        // ponytail: coarse guard, not a benchmark. The per-byte string build took 3.3 s to 15.8 s, the fix about 0.35 s. Use a timing harness for tighter limits.
        expect(ms).toBeLessThan(2000);
      },
      TIMEOUT_MS,
    );

    test(
      `the first reached bound wins: ${BYTES_BOUND} before ${RECORDS_BOUND}`,
      () => {
        const big = Array.from({ length: 9 }, (_, i) => untracked(`big/${i}`, 4 * 1024 * 1024));
        const small = Array.from({ length: LIMITS.STATUS_LISTING_RECORDS + 1 }, (_, i) => untracked(`r/${String(i).padStart(6, "0")}`, 12));
        const listing = Buffer.concat([headersOf("F02"), ...big, ...small]);
        expectLimited(parseChunks(listing, LIMITS.NATIVE_CHUNK_BYTES), BYTES_BOUND, oracle(listing).records);
      },
      TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("truncated and malformed records", () => {
    test(
      "F03: a rename record cut after its first NUL, without its original path, is never complete",
      () => {
        const o = outputOf("F03");
        const rename = o.oracle.items.find((i) => o.listing[i.start] === 0x32);
        expect(rename).toBeDefined();
        const cut = rename!.nuls[0]! + 1;
        expectIncomplete(parse(o.listing.subarray(0, cut)), o.oracle.records, "rename without original path");
        expectIncomplete(parseChunks(o.listing.subarray(0, cut), 1), o.oracle.records, "rename without original path, one-byte chunks");
      },
      TIMEOUT_MS,
    );

    test(
      "F16 at-limit: a cut inside the last record is never complete",
      () => {
        const o = outputOf("F16 at-limit");
        const last = o.oracle.items[o.oracle.items.length - 1]!;
        const whole = o.oracle.records;
        for (const at of [last.start + 1, last.paths[0]!.start, last.paths[0]!.start + 3, last.end - 1]) {
          expectIncomplete(parseChunks(o.listing.subarray(0, at), LIMITS.NATIVE_CHUNK_BYTES), whole, `cut at ${at}`);
        }
      },
      F16_TIMEOUT_MS,
    );

    test(
      "F02: statusArgs passes --branch, so output without both branch.oid and branch.head gives MALFORMED_GIT_OUTPUT",
      () => {
        const o = outputOf("F02");
        const items = o.oracle.items.map((i) => o.listing.subarray(i.start, i.end));
        const headers = items.filter((_, n) => o.oracle.items[n]!.header);
        const records = items.filter((_, n) => !o.oracle.items[n]!.header);
        const oid = headers.filter((h) => h.toString("latin1").startsWith("# branch.oid "));
        const head = headers.filter((h) => h.toString("latin1").startsWith("# branch.head "));
        expect({ oid: oid.length, head: head.length }).toEqual({ oid: 1, head: 1 });
        for (const [label, parts] of [
          ["zero bytes", []],
          ["branch.oid alone", oid],
          ["branch.head alone", head],
          ["records without headers", records],
          ["branch.oid and records", [...oid, ...records]],
        ] as [string, Buffer[]][]) {
          expect({ label, result: summary(parse(Buffer.concat(parts))) }).toEqual({ label, result: { state: "failed", code: MALFORMED } });
        }
      },
      TIMEOUT_MS,
    );

    // git-status(1) porcelain v2: each malformed record breaks one record rule. `O` is a real F02 index object ID.
    const malformed = (O: string, Z: string): [string, string, "replace-oid" | "after-headers"][] => [
      ["an unknown record type", "Z junk\0", "after-headers"],
      ["an empty record", "\0", "after-headers"],
      ["an ordinary record with non-hex object IDs", `1 .M N... 100644 100644 100644 ${"z".repeat(40)} ${"y".repeat(40)} multi.txt\0`, "after-headers"],
      ["an ordinary record with too few fields", "1 .M N...\0", "after-headers"],
      ["an ordinary record with an invalid status letter", `1 Q. N... 100644 100644 100644 ${O} ${O} multi.txt\0`, "after-headers"],
      ["an ordinary record with an invalid submodule field", `1 .M X... 100644 100644 100644 ${O} ${O} multi.txt\0`, "after-headers"],
      ["an ordinary record with a non-octal mode", `1 .M N... 100644 10064x 100644 ${O} ${O} multi.txt\0`, "after-headers"],
      ["an ordinary record with a 39-digit object ID", `1 .M N... 100644 100644 100644 ${O.slice(1)} ${O} multi.txt\0`, "after-headers"],
      ["an ordinary record with a SHA-256-length object ID in a SHA-1 listing", `1 .M N... 100644 100644 100644 ${O}${"0".repeat(24)} ${O} multi.txt\0`, "after-headers"],
      ["an ordinary record with an empty path", `1 .M N... 100644 100644 100644 ${O} ${O} \0`, "after-headers"],
      ["a rename record with an invalid score", `2 R. N... 100644 100644 100644 ${O} ${O} X100 new.txt\0old.txt\0`, "after-headers"],
      ["a rename record with a score above 100", `2 R. N... 100644 100644 100644 ${O} ${O} R101 new.txt\0old.txt\0`, "after-headers"],
      ["an ordinary record with an unmerged status pair", `1 UU N... 100644 100644 100644 ${O} ${O} multi.txt\0`, "after-headers"],
      ["a rename record without R or C in its status pair", `2 .M N... 100644 100644 100644 ${O} ${O} R50 a\0b\0`, "after-headers"],
      ["an unmerged record with too few fields", `u UU N... 100644 100644 100644 100644 ${O} ${O} conflict.txt\0`, "after-headers"],
      ["an unmerged record with a status pair outside the seven unmerged pairs", `u .. N... 100644 100644 100644 100644 ${O} ${O} ${O} conflict.txt\0`, "after-headers"],
      ["an untracked record with an empty path", "? \0", "after-headers"],
      ["an untracked record without its space", "?untracked.txt\0", "after-headers"],
      ["a branch.oid header without a value", "# branch.oid\0", "replace-oid"],
      ["a branch.oid header with a non-hex value", `# branch.oid ${"z".repeat(40)}\0`, "replace-oid"],
      ["a branch.oid header with a 38-digit value", `# branch.oid ${Z.slice(2)}\0`, "replace-oid"],
      ["a branch.ab header without signs", "# branch.ab 1 2\0", "after-headers"],
    ];

    // The labels are fixed, so the test names exist before the F02 build.
    for (const [label] of malformed("0".repeat(40), "0".repeat(40))) {
      test(
        `malformed record on real F02 output (${label}) is never complete, whole and in one-byte chunks`,
        () => {
          const o = outputOf("F02");
          const items = o.oracle.items.map((i) => o.listing.subarray(i.start, i.end));
          const headers = items.filter((_, n) => o.oracle.items[n]!.header);
          const records = items.filter((_, n) => !o.oracle.items[n]!.header);
          const O = o.oracle.records.find((r) => r.path.display === "other-b.txt")!.oids![1]!;
          expect(O).toMatch(/^[0-9a-f]{40}$/);
          const [, record, place] = malformed(O, "0".repeat(40)).find(([l]) => l === label)!;
          const head = place === "replace-oid" ? [Buffer.from(record), ...headers.filter((h) => !h.toString("latin1").startsWith("# branch.oid "))] : [...headers, Buffer.from(record)];
          const listing = Buffer.concat([...head, ...records]);
          expectIncomplete(parse(listing), null, `${label}, whole`);
          expectIncomplete(parseChunks(listing, 1), null, `${label}, one-byte chunks`);
        },
        TIMEOUT_MS,
      );
    }
  });
});
