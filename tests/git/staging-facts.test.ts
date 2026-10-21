// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T004: the Git facts F25 to F28 of research.md R21 (plan.md D8). A fact prints `OBSERVATION T004:` lines. A `match=false` line is a finding for research.md "Results", not a failure.
// The expected values come from the fixture construction and the research.md R10 and R11 rules, never from `src/git-service/`.

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { factTests, obs, READ, same, STEP, type Observation } from "./fact-runner";
import { useFixtureRoot } from "./fixture-root";
import { describeGit } from "./git-binary";
import { indexEntries, sha256 } from "./git-oracle";
import { buildWorkbench, repoOf, wb, type GitOptions, type GitResult, type WbFixtureName, type WbRepo } from "./workbench-fixtures";

printOrigin("./workbench-fixtures.ts", import.meta.dir);
useFixtureRoot();

const TASK = "T004";
const FACT_MS = 300_000;
// The 001 hunk patch options (contract §4).
const PATCH = ["-p", "--no-textconv", "--no-ext-diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--ignore-submodules=dirty"];
// The 001 status read (contract §7).
const STATUS = [...READ, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--find-renames", "--ignore-submodules=dirty"];
// plan.md D8 `MULTI_FILE_ACTION_FILES`.
const MULTI_FILES = 10_000;

const run = (r: WbRepo, args: string[], o: GitOptions = {}): GitResult => wb(r, args, { allowExit: "any", ...o });
const stdout = (res: GitResult) => res.stdout.toString("latin1");

let copies = 0;
// A second build is the copy (T001 proves that two builds are equal).
const copy = (git: string, name: WbFixtureName) => repoOf(buildWorkbench(git, name, `${name}-t004-${++copies}`));

// ---- F25: line staging ----

type Kind = " " | "-" | "+";
interface HunkLine {
  kind: Kind;
  text: string;
  // False when a `\` marker follows the line (gitformat-diff).
  eol: boolean;
}
interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

// One file diff with exactly one hunk. A count without a comma is 1 (gitformat-diff "combined diff format" and GNU unified format).
function oneHunk(patch: string): Hunk {
  const at = patch.indexOf("\n@@ ");
  if (at < 0 || patch.indexOf("\n@@ ", at + 1) >= 0) throw new Error(`patch is not one hunk: ${JSON.stringify(patch)}`);
  const header = patch.slice(0, at + 1);
  const rows = patch.slice(at + 1).split("\n");
  if (rows.at(-1) !== "") throw new Error("patch does not end with LF");
  rows.pop();
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[0]!);
  if (m === null) throw new Error(`hunk header refused: ${JSON.stringify(rows[0])}`);
  const lines: HunkLine[] = [];
  for (const row of rows.slice(1)) {
    if (row.startsWith("\\")) {
      if (lines.length === 0) throw new Error("marker before a line");
      lines.at(-1)!.eol = false;
      continue;
    }
    const kind = row[0] as Kind;
    if (kind !== " " && kind !== "-" && kind !== "+") throw new Error(`hunk line refused: ${JSON.stringify(row)}`);
    lines.push({ kind, text: row.slice(1), eol: true });
  }
  return { header, oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), lines };
}

// Every non-empty subset of the ordinals 0..n-1, in ascending order.
function selections(n: number): number[][] {
  const out: number[][] = [];
  for (let mask = 1; mask < 1 << n; mask++) out.push(Array.from({ length: n }, (_, i) => i).filter((i) => (mask & (1 << i)) !== 0));
  return out;
}

const textLines = (blob: string) => blob.split("\n").filter((l, i, all) => i < all.length - 1 || l !== "");
const content = (lines: HunkLine[]) => lines.map((l) => l.text + (l.eol ? "\n" : "")).join("");

// research.md R11: the sub-hunk of the selected `+` and `-` ordinals, and the expected blob of its apply.
// Stage: an unselected `-` line becomes context, and an unselected `+` line goes. Unstage applies with `--reverse`, so the roles of `+` and `-` swap.
function subHunk(h: Hunk, picked: Set<number>, direction: "stage" | "unstage"): { patch: string; region: string } {
  const [keep, drop]: [Kind, Kind] = direction === "stage" ? ["-", "+"] : ["+", "-"];
  const kept: HunkLine[] = [];
  const region: HunkLine[] = [];
  let ordinal = 0;
  for (const l of h.lines) {
    if (l.kind === " ") {
      kept.push(l);
      region.push(l);
      continue;
    }
    const selected = picked.has(ordinal++);
    if (selected) kept.push(l);
    else if (l.kind === keep) kept.push({ ...l, kind: " " });
    // The result side: stage keeps the `+` side of a selected line, unstage keeps the `-` side.
    if (selected ? l.kind === drop : l.kind === keep) region.push(l);
  }
  const oldCount = kept.filter((l) => l.kind !== "+").length;
  const newCount = kept.filter((l) => l.kind !== "-").length;
  const body = kept.map((l) => `${l.kind}${l.text}\n${l.eol ? "" : "\\ No newline at end of file\n"}`).join("");
  return { patch: `${h.header}@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@\n${body}`, region: content(region) };
}

// The base blob with the hunk side that `apply` matches replaced by `region`. xdiff `xdl_emit_hunk_hdr`: a count of 0 names the line before.
function expectedBlob(base: string, h: Hunk, region: string, direction: "stage" | "unstage"): string {
  const [start, count] = direction === "stage" ? [h.oldStart, h.oldCount] : [h.newStart, h.newCount];
  const lines = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const at = count === 0 ? start : start - 1;
  return lines.slice(0, at).join("") + region + lines.slice(at + count).join("");
}

// `ls-files -s -z` of the index that `GIT_INDEX_FILE` names.
function stageEntries(r: WbRepo, index: string): string[] {
  return stdout(wb(r, [...READ, "ls-files", "-s", "-z"], { env: { GIT_INDEX_FILE: index } })).split("\0").filter((x) => x !== "");
}

const LINE_FILES = ["added.txt", "removed.txt", "mixed.txt", "eof.txt"];

function f25(git: string): Observation[] {
  const out: Observation[] = [];
  const stage = copy(git, "staging-hunks");
  const unstage = copy(git, "staging-hunks");
  wb(unstage, [...STEP, "add", "--", ...LINE_FILES]);
  let n = 0;
  for (const [direction, r] of [["stage", stage], ["unstage", unstage]] as const) {
    const canonical = join(r.dir, ".git", "index");
    for (const path of LINE_FILES) {
      const diff = direction === "stage" ? [...READ, "diff-files", ...PATCH, "--", path] : [...READ, "diff-index", "--cached", ...PATCH, "HEAD", "--", path];
      const h = oneHunk(stdout(wb(r, diff)));
      const base = stdout(wb(r, [...READ, "cat-file", "blob", `:${path}`]));
      const ordinals = h.lines.filter((l) => l.kind !== " ").length;
      for (const picked of selections(ordinals)) {
        const sub = subHunk(h, new Set(picked), direction);
        const want = expectedBlob(base, h, sub.region, direction);
        const wantOid = stdout(wb(r, [...STEP, "hash-object", "--no-filters", "--stdin"], { input: Buffer.from(want, "latin1") })).trim();
        // The 001 owned candidate: a copy of the canonical index that `GIT_INDEX_FILE` names.
        const candidate = join(r.dir, ".git", `t004-candidate-${++n}`);
        copyFileSync(canonical, candidate);
        const before = stageEntries(r, candidate).filter((e) => !e.endsWith(`\t${path}`));
        const apply = run(r, [...STEP, "apply", "--cached", ...(direction === "unstage" ? ["--reverse"] : [])], { input: Buffer.from(sub.patch, "latin1"), env: { GIT_INDEX_FILE: candidate } });
        const after = stageEntries(r, candidate);
        const entry = after.find((e) => e.endsWith(`\t${path}`));
        const others = same(after.filter((e) => !e.endsWith(`\t${path}`)), before);
        rmSync(candidate);
        const oid = apply.exitCode === 0 ? (entry?.split(" ")[1] ?? null) : null;
        // A line selection only keeps or drops whole lines, so every result line is a line of the base or of the hunk.
        const known = new Set([...textLines(base), ...h.lines.map((l) => l.text)]);
        const foreign = oid === null ? [] : textLines(stdout(wb(r, [...READ, "cat-file", "blob", oid]))).filter((l) => !known.has(l));
        out.push(obs(`F25 ${direction} ${path} ${JSON.stringify(picked)} of ${ordinals}`, { exit: 0, oid: wantOid, others: true, foreign: [] }, { exit: apply.exitCode, oid, others, foreign }));
      }
    }
  }
  return out;
}

// ---- F26: the batch proof A ----

const BATCH_PATHS = ["lead.txt", " lead.txt", "\tlead.txt", "a b.txt", "plain.txt"];

const BLOB = "x\ny\n";

function f26(git: string): Observation[] {
  const r = copy(git, "staging-tree");
  // gitattributes(5): a pattern without `/` matches the base name. `?` matches the space, and no pattern matches a leading space.
  writeFileSync(join(r.dir, ".gitattributes"), "lead.txt eol=crlf\na?b.txt eol=crlf\n");
  const oid = stdout(wb(r, [...STEP, "hash-object", "-w", "--stdin"], { input: BLOB })).trim();
  const single = (path: string) => wb(r, [...READ, "cat-file", "--filters", `--path=${path}`, oid]).stdout;
  const input = BATCH_PATHS.map((p) => `${oid} ${p}\0`).join("");
  const res = run(r, [...READ, "cat-file", "--batch", "--filters", "-Z"], { input });
  const out: Observation[] = [obs("F26 batch exit", 0, res.exitCode)];
  const raw = res.stdout;
  // git-cat-file(1) "BATCH OUTPUT": `<oid> SP <type> SP <size> LF <contents> LF`, and `-Z` makes both ends NUL.
  // The size can differ from the filtered length, so the single-file proof A of each path candidate frames the contents.
  let at = 0;
  BATCH_PATHS.forEach((path, i) => {
    const nul = raw.indexOf(0, at);
    const header = nul < 0 ? raw.subarray(at).toString("latin1") : raw.subarray(at, nul).toString("latin1");
    const size = /^([0-9a-f]+) blob (\d+)$/.exec(header)?.[2];
    const asGiven = single(path);
    const stripped = single(path.replace(/^[ \t]+/, ""));
    const fits = (c: Buffer) => nul >= 0 && raw.subarray(nul + 1, nul + 1 + c.length).equals(c) && raw[nul + 1 + c.length] === 0;
    const content = fits(stripped) ? stripped : fits(asGiven) ? asGiven : null;
    out.push(obs(`F26 ${JSON.stringify(path)} header form`, true, header.startsWith(`${oid} blob `) && size !== undefined));
    // The stored blob has BLOB.length bytes; the CRLF paths filter it to more bytes.
    out.push(obs(`F26 ${JSON.stringify(path)} header size equals the filtered length`, content?.length ?? null, size === undefined ? null : Number(size)));
    out.push(obs(`F26 ${JSON.stringify(path)} record ends with NUL`, true, content !== null));
    // research.md R10: Git splits at the first white space and drops the run of white space.
    out.push(obs(`F26 ${JSON.stringify(path)} equals single-file proof A of the same path`, !/^[ \t]/.test(path) || asGiven.equals(stripped), content !== null && content.equals(asGiven)));
    out.push(obs(`F26 ${JSON.stringify(path)} equals single-file proof A without leading white space`, true, content !== null && content.equals(stripped)));
    at = content === null ? raw.length : nul + 1 + content.length + 1;
  });
  out.push(obs("F26 output fully read", raw.length, at));
  return out;
}

// ---- F27: the multi-file stage ----

// The changes of the staging-tree fixture, a deleted tracked file, and new files up to 10,000 paths.
function bulkPaths(r: WbRepo): string[] {
  rmSync(join(r.dir, "top.txt"));
  const fixed = ["src/a.txt", "src/lib/deep/c.txt", "docs/d.txt", "src/lib/new.txt", "src/new-dir/n1.txt", "src/new-dir/n2.txt", "top-new.txt", "top.txt", "bulk/space name.txt", "bulk/ünï.txt"];
  const paths = [...fixed];
  for (let i = 0; paths.length < MULTI_FILES; i++) paths.push(`bulk/d${String(Math.floor(i / 100)).padStart(3, "0")}/f${String(i).padStart(5, "0")}.txt`);
  for (const p of paths.slice(fixed.length - 2)) {
    const file = join(r.dir, p);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${p}\n`);
  }
  return paths;
}

function f27(git: string): Observation[] {
  const a = copy(git, "staging-tree");
  const b = copy(git, "staging-tree");
  const paths = bulkPaths(a);
  bulkPaths(b);
  // `update-index` takes the paths in any order; reversed input shows that it sorts.
  const stdin = Buffer.from([...paths].reverse().map((p) => `${p}\0`).join(""), "utf8");
  const ui = run(a, [...STEP, "update-index", "--add", "--remove", "-z", "--stdin"], { input: stdin });
  // The oracle is `git add` of the same literal paths. The command line cannot hold 10,000 paths on Windows, so they go on stdin.
  const add = run(b, [...STEP, "--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: Buffer.from(paths.map((p) => `${p}\0`).join(""), "utf8") });
  const ea = indexEntries(git, a.dir);
  const eb = indexEntries(git, b.dir);
  const tree = (r: WbRepo) => stdout(wb(r, [...STEP, "write-tree"])).trim();
  return [
    obs("F27 exits", { updateIndex: 0, add: 0 }, { updateIndex: ui.exitCode, add: add.exitCode }),
    obs("F27 index entries equal git add", { entries: eb.length, sha256: sha256(Buffer.from(JSON.stringify(eb))) }, { entries: ea.length, sha256: sha256(Buffer.from(JSON.stringify(ea))) }),
    obs("F27 deleted path removed", false, ea.some((e) => e.path === "top.txt")),
    obs("F27 write-tree equals git add", tree(b), tree(a)),
  ];
}

// ---- F28: the status record bound ----

interface StatusEntry {
  kind: string;
  record: string;
}

// `status --porcelain=v2 -z` (git-status(1)): `#` headers first; a "2" record holds one more NUL field, the original path.
function statusEntries(raw: string): StatusEntry[] {
  const fields = raw.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f === "" || f.startsWith("# ")) continue;
    const kind = f[0]!;
    if (!["1", "2", "u", "?", "!"].includes(kind)) throw new Error(`unknown status record: ${JSON.stringify(f)}`);
    entries.push({ kind, record: kind === "2" ? `${f}\0${fields[++i]}` : f });
  }
  return entries;
}

// Run lengths of the record kinds in Git's output order.
function kindRuns(entries: StatusEntry[]): [string, number][] {
  const runs: [string, number][] = [];
  for (const e of entries) {
    const last = runs.at(-1);
    if (last?.[0] === e.kind) last[1]++;
    else runs.push([e.kind, 1]);
  }
  return runs;
}

function f28(git: string): Observation[] {
  const out: Observation[] = [];
  for (const name of ["switch-dirty", "conflict-merge"] as const) {
    const r = copy(git, name);
    if (name === "conflict-merge") {
      writeFileSync(join(r.dir, "staged.txt"), "staged\n");
      wb(r, [...STEP, "add", "--", "staged.txt"]);
    }
    // Untracked paths that sort before and after every tracked path.
    for (let i = 0; i < 20; i++) {
      for (const dir of ["0-untracked", "zz-untracked"]) {
        mkdirSync(join(r.dir, dir), { recursive: true });
        writeFileSync(join(r.dir, dir, `u${String(i).padStart(2, "0")}.txt`), "u\n");
      }
    }
    const entries = statusEntries(stdout(wb(r, STATUS)));
    const untracked = entries.filter((e) => e.kind === "?").length;
    const first = entries.findIndex((e) => e.kind === "?");
    // A lowered record bound: the read keeps the records before the bound and drops the rest.
    const bound = first + Math.floor(untracked / 2);
    const kept = new Set(entries.slice(0, bound).map((e) => e.record));
    const lost = entries.filter((e) => e.kind !== "?" && !kept.has(e.record)).map((e) => e.record.split(" ").at(-1));
    out.push(obs(`F28 ${name} record order`, "tracked and unmerged before untracked", kindRuns(entries), first >= 0 && entries.slice(first).every((e) => e.kind === "?")));
    // The record order above implies an empty list, so this line is a record.
    out.push(obs(`F28 ${name} cut at ${bound} of ${entries.length} keeps every tracked, unmerged, and staged record`, "record", lost, true));
  }
  return out;
}

const FACTS: [string, string, (git: string) => Observation[]][] = [
  ["F25", "the sub-hunk apply equals the expected blob", f25],
  ["F26", "cat-file --batch --filters -Z input and output form", f26],
  ["F27", "update-index --stdin with 10,000 paths equals git add", f27],
  ["F28", "a status cut inside the untracked records keeps the tracked records", f28],
];

describeGit("Git facts F25 to F28 (T004)", (git) => factTests(TASK, git, FACTS, FACT_MS));
