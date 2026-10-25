// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 contract Δ3 `previewIgnore`, Δ6 `shadow`, data-model §7 and §13, plan.md D9 (spec FR-038 to FR-041, SC-005).
// Git's own matcher decides each verdict: `check-ignore --no-index` in two throwaway shadow repositories that hold only the ignore files,
// `s` with the saved text and `c` with the candidate text. A self-check against Git's index-aware listings RI and RT comes before any result.

import type { ErrorCode } from "../contracts/errors";
import { FILE_FACT_ENTRIES, GIT_PROCESS_DEADLINE_MS, IGNORE_TARGET_BYTES, PREVIEW_GROUP_PATHS, PREVIEW_IGNORE_FILES, PREVIEW_PATHS, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS, WINDOWS_COMMAND_LINE_UNITS } from "../contracts/limits";
import { isWindows, NATIVE } from "../contracts/native-path";
import { compareKeys, treeKey } from "../contracts/tree-order";
import { routeWslPath } from "../contracts/wsl-route";
import { indexEntryArgs } from "./commands";
import { createCollector, exitKind, RunnerRefusal, settleSteps, stepUnits, type Collector, type FileFact, type GitExit, type GitRunner, type ProcessContext, type WalkStop } from "./git-runner";
import { readIgnoreFile, targetOf, type IgnoreTarget } from "./ignore";
import { encodeIgnore } from "./ignore-text";
import { contextOf, latin1 } from "./read-steps";
import type { Workspace } from "./registration";
import type { ReadInstallation } from "./snapshot";
import { parseIndexListing } from "./status";
import { parseMaybeBool, type ConfigEntry, type Trust } from "./trust";

export type PreviewOutcome = { result: "succeeded" | "failed"; code?: ErrorCode; value?: unknown } | { result: "canceled" } | { result: "deadline" };
export interface PreviewTarget {
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
  installation: ReadInstallation;
}
type Payload = { target: IgnoreTarget; text: string; snapshotId: string };
type Reason = "paths" | "listing" | "name-case" | "shadow-copy" | "self-check" | "unreadable" | "deadline";
type Repo = "s" | "c";

// The outcome that ends a preview early: a typed limit (a succeeded response), a failure, or a Cancel.
class End {
  constructor(readonly outcome: PreviewOutcome) {}
}
const limit = (reason: Reason, bound?: string) => new End({ result: "succeeded", value: { unavailable: { reason, ...(bound === undefined ? {} : { bound }) } } });
const failed = (code: ErrorCode) => new End({ result: "failed", code });
const CANCELED = new End({ result: "canceled" });
// 001 contract §5: a Job close ends a step with `exitCode` null. The cause is a sibling end, so `steps` takes a deadline first and a Job close last.
const CLOSED = new End({ result: "failed", code: "GIT_FAILED" });
const DEADLINE = limit("deadline");
const stopped = (stop: WalkStop["stop"]) => (stop === "deadline" ? DEADLINE : CANCELED);
// Contract Δ5 `PREVIEW_PATHS`: the inputs of the whole preview, without the folder probes (plan.md D9 `paths`). Each count includes every earlier input.
const inputsFit = (count: number) => {
  if (count > PREVIEW_PATHS) throw limit("paths", "PREVIEW_PATHS");
};

const NUL = 0x00;
const LF = 0x0a;
const SLASH = 0x2f;
const COLON = 0x3a;
const BANG = 0x21;
const READ = ["--no-lazy-fetch", "--no-optional-locks", "--literal-pathspecs"];
// Contract Δ5: 100 notices, plus a count.
const PREVIEW_NOTICES = 100;
// Plan.md D9 step 6: the `check-ignore` processes that run at the same time in one preview. A round of the S and C checks gives each check half.
// Git checks the type of each path for a folder-only pattern (dir.c `last_matching_pattern_from_list`). Above 4 processes, a check of 100,000 paths took longer (2026-10-25).
const CHECK_PROCESSES = 4;
const DIAGNOSTIC_BYTES = 64 * 1024;
const GITIGNORE = Buffer.from(".gitignore");
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// ---- Repository commands (contract Δ3 `previewIgnore`) ----

const universeArgs = () => [...READ, "ls-files", "-o", "-z", "--directory", "--no-empty-directory"];
const expansionArgs = (folders: readonly string[]) => [...READ, "ls-files", "-o", "-z", "--", ...folders];
// RI and RT read the index, so a skip-worktree `.gitignore` that is absent on disk counts from its blob (dir.c:1174-1178). RI takes no pathspec (builtin/ls-files.c:154-155).
const ignoredArgs = () => [...READ, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"];
const matchedArgs = () => [...READ, "ls-files", "-c", "-i", "--exclude-standard", "-z"];
const blobsArgs = () => ["--no-lazy-fetch", "--no-optional-locks", "cat-file", "--batch"];

// ---- Shadow commands (contract Δ6 `shadow`, src-tauri/src/shadow.rs `fits`) ----

const longPaths = (windows: boolean) => (windows ? ["-c", "core.longpaths=true"] : []);
const SHADOW = {
  init: () => ["--no-lazy-fetch", "init", "-q", "--template="],
  blob: () => ["--no-lazy-fetch", "hash-object", "-w", "--no-filters", "--stdin"],
  copy: (windows: boolean) => ["--no-lazy-fetch", ...longPaths(windows), "hash-object", "-w", "--no-filters", "--stdin-paths"],
  verify: (windows: boolean) => ["--no-lazy-fetch", ...longPaths(windows), "hash-object", "--no-filters", "--stdin-paths"],
  index: () => ["--no-lazy-fetch", "update-index", "-z", "--index-info"],
  checkout: (windows: boolean, exclude: boolean) => ["--no-lazy-fetch", ...longPaths(windows), "-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f", ...(exclude ? ["--prefix=.git/info/"] : [])],
  check: (windows: boolean, ignoreCase: boolean, excludesFile: string | null) => [
    "--no-lazy-fetch",
    ...longPaths(windows),
    "-c",
    `core.ignorecase=${ignoreCase}`,
    ...(excludesFile === null ? [] : ["-c", `core.excludesFile=${excludesFile}`]),
    "check-ignore",
    "--no-index",
    "-z",
    "--stdin",
    "-v",
    "-n",
  ],
};

// quote.c `unquote_c_style` reads a line that starts with `"`, so every line is quoted: `\\`, `\"`, and octal escapes for control and non-ASCII bytes.
function quoted(path: string): string {
  let out = '"';
  for (const b of Buffer.from(path)) out += b === 0x5c ? "\\\\" : b === 0x22 ? '\\"' : b < 0x20 || b >= 0x7f ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b);
  return `${out}"`;
}

// ---- Inputs ----

// `tracked`: a T path. `file`: an untracked file. `folder`: an untracked folder record or a folder below an expanded one.
// `nested`: a nested repository, `x/` in Git's listings (dir.c:2045). `gitlink` marks a tracked gitlink, which needs a folder in the shadow (report E1).
// `record` marks a U folder record. Only such a folder stays one input, so only it can expand for one preview.
type Kind = "tracked" | "file" | "folder" | "nested";
interface Input {
  path: Uint8Array;
  kind: Kind;
  gitlink?: true;
  record?: true;
}
// One ignore file of a shadow. `real`: the path that `hash-object --stdin-paths` reads. `bytes`: an index blob or the candidate.
interface IgnoreFile {
  rel: Uint8Array;
  real?: string;
  bytes?: Uint8Array;
}
type Tracked = ReadonlyMap<string, { oid: string; skip: boolean }>;
// The C verdicts of the base inputs, and of the folder probes above each `.gitignore` (spec FR-040).
type Checked = { inputs: Uint8Array; probes: Input[]; probed: Uint8Array };

const keyOf = (path: Uint8Array) => latin1(path);
const startsWith = (path: Uint8Array, prefix: Uint8Array) => path.length >= prefix.length && Buffer.compare(path.subarray(0, prefix.length), prefix) === 0;
const withSlash = (path: Uint8Array) => Buffer.concat([path, Uint8Array.of(SLASH)]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const isGitignore = (path: Uint8Array) =>
  path.length >= GITIGNORE.length && (path.length === GITIGNORE.length || path[path.length - GITIGNORE.length - 1] === SLASH) && Buffer.compare(path.subarray(path.length - GITIGNORE.length), GITIGNORE) === 0;
const folderOf = (rel: Uint8Array) => rel.subarray(0, Math.max(0, rel.length - GITIGNORE.length - 1));
// The folders above a path, root first. The root is the empty path.
function ancestors(path: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [new Uint8Array()];
  for (let i = 0; i < path.length; i++) if (path[i] === SLASH) out.push(path.subarray(0, i));
  return out;
}

// `-z` records that end with NUL. Null: the output does not end with NUL.
function records(bytes: Uint8Array): Uint8Array[] | null {
  if (bytes.length > 0 && bytes[bytes.length - 1] !== NUL) return null;
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const nul = bytes.indexOf(NUL, at);
    out.push(bytes.subarray(at, nul));
    at = nul + 1;
  }
  return out;
}

// A `check-ignore` stdin path that starts with `:` would be pathspec magic, so it gets `./` (report Q2, F13). Git echoes it unchanged.
const stdinPath = (path: Uint8Array) => (path[0] === COLON ? Buffer.concat([Buffer.from("./"), path]) : path);

// git-check-ignore(1) OUTPUT with `-z -v -n`: `<source> NUL <line> NUL <pattern> NUL <path> NUL`, one record per input in input order.
// A record whose pattern is not empty and does not start with `!` is ignored (data-model §7). The parse keeps the verdicts, not the text.
// `output` counts the bytes of every batch of one check, so the listing bound covers the whole check.
function verdictCollector(sent: readonly Uint8Array[], output: { bytes: number }): Collector & { verdicts: Uint8Array; done(): boolean } {
  const verdicts = new Uint8Array(sent.length);
  let field = 0;
  let record = 0;
  let bytes = 0;
  let first = -1;
  let empty = true;
  let at = 0;
  let same = true;
  let malformed = false;
  return {
    verdicts,
    push(chunk: Uint8Array): void {
      bytes += chunk.length;
      output.bytes += chunk.length;
      for (const b of chunk) {
        if (b !== NUL) {
          if (field === 2 && empty) {
            empty = false;
            first = b;
          }
          if (field === 3) {
            const expected = sent[record];
            same &&= expected !== undefined && at < expected.length && expected[at] === b;
            at++;
          }
          continue;
        }
        if (field < 3) {
          field++;
          continue;
        }
        if (!same || at !== sent[record]?.length) malformed = true;
        else verdicts[record] = !empty && first !== BANG ? 1 : 0;
        record++;
        field = 0;
        empty = true;
        at = 0;
        same = true;
      }
    },
    get bytes() {
      return bytes;
    },
    get records() {
      return record;
    },
    // Contract Δ5: an output above the listing byte bound gives `listing`.
    get limited() {
      return output.bytes > STATUS_LISTING_BYTES;
    },
    done: () => !malformed && field === 0 && record === sent.length,
  };
}

// ---- The base (data-model §7) ----

interface Base {
  snapshotId: string;
  ignoreCase: boolean;
  excludesFile: string | null;
  // The real `info/exclude` in Git's form, or null when it gives no rules.
  exclude: string | null;
  ignoreFiles: IgnoreFile[];
  // Listed `.gitignore` paths that are links: Git does not read them (dir.c:1779 `PATTERN_NOFOLLOW`).
  links: Uint8Array[];
  inputs: Input[];
  s: Uint8Array;
  // The expansion of each U folder record, by folder key, also of those that only a candidate opens.
  expansions: Map<string, Uint8Array[]>;
  selfCheck: Reason | null;
  // The folders whose exact `.gitignore` the listings name, and the folders that `name-case` probed.
  listedFolders: Set<string>;
  probed: Set<string>;
}

export function createIgnorePreview({ runner, trust }: { runner: GitRunner; trust: Trust }) {
  const bases = new Map<string, Map<IgnoreTarget, Base>>();

  async function preview(t: PreviewTarget, p: Payload): Promise<PreviewOutcome> {
    try {
      return await run(t, p);
    } catch (error) {
      if (error instanceof End) return error.outcome;
      if (t.signal.aborted) return { result: "canceled" };
      throw error;
    }
  }

  async function run(t: PreviewTarget, p: Payload): Promise<PreviewOutcome> {
    const w = t.workspace;
    // Plan.md D2: `ls-files` loads the index, so the 001 read gate comes before the first Git process.
    const listed = await trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: w });
    if (!listed.ok) return "stop" in listed ? { result: listed.stop } : { result: "failed", code: listed.code };
    const gate = trust.gate(w, listed.listing, t.installation, "reads");
    if (gate !== null) return { result: "failed", code: gate };
    // The candidate takes the BOM and the line endings of the loaded file (plan.md D9 step 2).
    const loaded = settle(await readIgnoreFile({ runner, operationId: t.operationId, signal: t.signal, workspace: w }, p.target)).value;
    const candidate = encodeIgnore(new Uint8Array(Buffer.from(p.text, "base64")), loaded.state === "absent" ? { lineEnding: "lf", bom: false } : loaded);
    const own = bases.get(w.repositoryId) ?? new Map<IgnoreTarget, Base>();
    bases.set(w.repositoryId, own);
    const created = await runner.shadow({ operationId: t.operationId, repositoryId: w.repositoryId, op: "create" });
    if (!("shadowId" in created)) throw limit("shadow-copy");
    const shadow = new Shadow(runner, t, created.shadowId, w.wsl === undefined && isWindows);
    let base = own.get(p.target);
    let c: Checked;
    if (base?.snapshotId === p.snapshotId) {
      if (base.selfCheck !== null) throw limit(base.selfCheck);
      inputsFit(base.inputs.length);
      // A built base runs one C check (plan.md D9 "Time"). The folder probes join it.
      await shadow.fill("c", candidateFiles(base, p.target, candidate), base.inputs);
      await shadow.exclude("c", p.target === "exclude" ? { bytes: candidate } : base.exclude === null ? null : { real: base.exclude });
      const probes = probesOf(base.ignoreFiles, new Set());
      const all = await shadow.check("c", [...base.inputs, ...probes], base.ignoreCase, base.excludesFile);
      c = { inputs: all.subarray(0, base.inputs.length), probes, probed: all.subarray(base.inputs.length) };
    } else {
      own.delete(p.target);
      const built = await build(t, p, listed.listing.entries, shadow, candidate);
      base = built.base;
      own.set(p.target, base);
      if (base.selfCheck !== null) throw limit(base.selfCheck);
      c = built.c;
    }
    return finish(t, p, base, shadow, c);
  }

  // The ignore files of the C shadow: every file of S, with the candidate in place of the root `.gitignore`.
  const candidateFiles = (base: Base, target: IgnoreTarget, candidate: Uint8Array): IgnoreFile[] =>
    target !== "gitignore" ? base.ignoreFiles : [...base.ignoreFiles.filter((f) => Buffer.compare(f.rel, GITIGNORE) !== 0), { rel: GITIGNORE, bytes: candidate }];

  // Plan.md D9 "Base": the listings, the S verdicts, the expansions of the folders that S does not ignore, and the self-check.
  async function build(t: PreviewTarget, p: Payload, entries: readonly ConfigEntry[], shadow: Shadow, candidate: Uint8Array): Promise<{ base: Base; c: Checked }> {
    const w = t.workspace;
    const ignoreCase = effectiveIgnoreCase(entries);
    const excludesFile = effectiveExcludesFile(entries, w);
    const exclude = settle(await targetOf({ runner, operationId: t.operationId, signal: t.signal, workspace: w }, "exclude"));
    // The self-check listings run at the same time as the first round (plan.md O-3). A failure ends the preview only when the self-check needs them.
    const pending = [listing(t, ignoredArgs()), listing(t, matchedArgs())] as const;
    for (const read of pending) read.catch(() => undefined);
    try {
      const [stage, universe] = await steps([listing(t, indexEntryArgs()), listing(t, universeArgs())]);
      const index = parseIndexListing(stage, w.objectFormat);
      const untracked = records(universe);
      if (index === null || untracked === null) throw failed("MALFORMED_GIT_OUTPUT");
      // ls-files(1): the first record of each path counts, so unmerged stages count once.
      const tracked = new Map<string, { oid: string; skip: boolean }>();
      const inputs: Input[] = [];
      for (const e of index) {
        if (tracked.has(keyOf(e.path))) continue;
        tracked.set(keyOf(e.path), { oid: e.oid, skip: e.skipWorktree });
        inputs.push({ path: e.path, kind: "tracked", ...(e.mode === "160000" ? { gitlink: true as const } : {}) });
      }
      for (const r of untracked) inputs.push(r.at(-1) === SLASH ? { path: r.subarray(0, -1), kind: "folder", record: true } : { path: r, kind: "file" });
      const base: Base = {
        snapshotId: p.snapshotId,
        ignoreCase,
        excludesFile,
        exclude: (await excludeGivesRules(t)) ? exclude.file : null,
        ignoreFiles: [],
        links: [],
        inputs,
        s: new Uint8Array(),
        expansions: new Map(),
        selfCheck: null,
        listedFolders: new Set(),
        probed: new Set(),
      };
      const first = await ignoreFiles(t, base, named(inputs), tracked);
      base.ignoreFiles.push(...first.files);
      base.links.push(...first.links);
      await nameCase(t, base, p.target, inputs);
      inputsFit(inputs.length);
      await steps([shadow.fill("s", base.ignoreFiles, inputs), shadow.fill("c", candidateFiles(base, p.target, candidate), inputs)]);
      await steps([
        shadow.exclude("s", base.exclude === null ? null : { real: base.exclude }),
        shadow.exclude("c", p.target === "exclude" ? { bytes: candidate } : base.exclude === null ? null : { real: base.exclude }),
      ]);
      const half = CHECK_PROCESSES / 2;
      const [s1, c1] = await steps([shadow.check("s", inputs, ignoreCase, excludesFile, half), shadow.check("c", inputs, ignoreCase, excludesFile, half)]);

      // A U folder record that S does not ignore expands in the base. Its files join the inputs, and its subfolders join as folder inputs.
      const open = inputs.map((input, i) => ({ input, i })).filter(({ input, i }) => input.kind === "folder" && s1[i] === 0);
      const expanded = await expand(t, base, open.map(({ input }) => input.path));
      const added: Input[] = [];
      for (const { input, i } of open) {
        const found = expanded.get(keyOf(input.path))!;
        if (isNested(input.path, found)) inputs[i] = { path: input.path, kind: "nested" };
        else added.push(...expansionInputs(input.path, found));
      }
      const { files: fresh, links } = await ignoreFiles(t, base, named(added), tracked);
      base.ignoreFiles.push(...fresh);
      base.links.push(...links);
      await nameCase(t, base, p.target, added);
      inputs.push(...added);
      inputsFit(inputs.length);
      await steps([shadow.fill("s", fresh, added), shadow.fill("c", fresh, added)]);
      const probes = probesOf(base.ignoreFiles, new Set());
      const [s2, c2] = await steps([shadow.check("s", added, ignoreCase, excludesFile, half), shadow.check("c", [...added, ...probes], ignoreCase, excludesFile, half)]);
      base.s = Buffer.concat([s1, s2]);

      // Plan.md D9 "Self-check", exact by the RI and RT record forms.
      const [ri, rt] = await steps(pending);
      base.selfCheck = selfCheck(base, ri, rt);
      return { base, c: { inputs: Buffer.concat([c1, c2.subarray(0, added.length)]), probes, probed: c2.subarray(added.length) } };
    } catch (error) {
      // A self-check listing at its deadline closes the Job of the other steps.
      if (error === CLOSED) await steps(pending);
      throw error;
    }
  }

  // Plan.md D9 "Classification" and "Results".
  async function finish(t: PreviewTarget, p: Payload, base: Base, shadow: Shadow, checked: Checked): Promise<PreviewOutcome> {
    const c = checked.inputs;
    // A U folder record that S ignores stays one input while C also ignores it. Otherwise it expands for this preview,
    // and its files take the S verdict ignored by the excluded-folder rule (dir.c `prep_exclude`).
    const reopened = base.inputs.filter((input, i) => input.record === true && base.s[i] === 1 && c[i] === 0);
    const expanded = await expand(t, base, reopened.map((input) => input.path));
    const extra: Input[] = [];
    // A nested repository stays one path, `x/` (dir.c:2045).
    for (const input of reopened) {
      const found = expanded.get(keyOf(input.path))!;
      extra.push(...(isNested(input.path, found) ? [{ path: input.path, kind: "nested" as const }] : expansionInputs(input.path, found)));
    }
    // Their `.gitignore` files join only the C shadow.
    const { files: local, links } = await ignoreFiles(t, base, named(extra), new Map());
    await nameCase(t, base, p.target, extra);
    const rels = [...base.ignoreFiles, ...local].map((f) => f.rel);
    const probes = probesOf(local, new Set(checked.probes.map((probe) => keyOf(probe.path))));
    inputsFit(base.inputs.length + extra.length);
    await shadow.fill("c", local, extra);
    const more = await shadow.check("c", [...extra, ...probes], base.ignoreCase, base.excludesFile);

    const newly: Input[] = [];
    const noLonger: Input[] = [];
    let trackedMatched = 0;
    // A folder input is no path of Git's listings, so it enters no group. A folder that both texts ignore counts as one path (spec FR-039).
    const visit = (input: Input, s: number, cv: number) => {
      if (input.kind === "tracked") trackedMatched += cv === 1 && s === 0 ? 1 : 0;
      else if (input.kind !== "folder" && cv !== s) (cv === 1 ? newly : noLonger).push(input);
    };
    base.inputs.forEach((input, i) => visit(input, base.s[i]!, c[i]!));
    extra.forEach((input, i) => visit(input, 1, more[i]!));
    const ignoredFolders = [...checked.probes.filter((_, i) => checked.probed[i] === 1), ...probes.filter((_, i) => more[extra.length + i] === 1)].map((probe) => withSlash(probe.path));
    const inside = rels.filter((rel) => ignoredFolders.some((folder) => startsWith(rel, folder)));
    const notices = [...[...base.links, ...links].map((path) => ({ kind: "link" as const, path })), ...inside.map((path) => ({ kind: "inside-ignored" as const, path }))]
      .map((n) => ({ n, key: treeKey(n.path) }))
      .sort((a, b) => compareKeys(a.key, b.key))
      .map(({ n }) => n);
    return {
      result: "succeeded",
      value: {
        preview: {
          newlyIgnored: group(newly),
          noLongerIgnored: group(noLonger),
          trackedMatched,
          notices: { entries: notices.slice(0, PREVIEW_NOTICES).map((n) => ({ kind: n.kind, pathBytes: b64(n.path) })), more: Math.max(0, notices.length - PREVIEW_NOTICES) },
        },
      },
    };
  }

  // ---- Repository reads ----

  // One repository listing with the status listing bounds. Above either bound, the preview gives `listing` (plan.md D9).
  async function listing(t: PreviewTarget, args: string[], input?: Uint8Array): Promise<Uint8Array> {
    const out = createCollector({ maxBytes: STATUS_LISTING_BYTES, maxRecords: STATUS_LISTING_RECORDS, separator: NUL });
    const exit = await git(runner, t, contextOf(t.workspace), args, out, input);
    if (out.limited) throw limit("listing", out.records > STATUS_LISTING_RECORDS ? "STATUS_LISTING_RECORDS" : "STATUS_LISTING_BYTES");
    if (exit.exitCode !== 0) throw failed("GIT_FAILED");
    return out.take();
  }

  // Plan.md D9 step 2: the fact of each listed `.gitignore`. A regular file goes in by its path, a skip-worktree file absent on disk by its index blob.
  // A link stays out and gets a notice. Other kinds give no rules. `base.listedFolders` gets the folder of each listed name.
  async function ignoreFiles(t: PreviewTarget, base: Base, paths: readonly Uint8Array[], tracked: Tracked): Promise<{ files: IgnoreFile[]; links: Uint8Array[] }> {
    if (paths.length === 0) return { files: [], links: [] };
    const facts = await factsOf(t, paths);
    const out: IgnoreFile[] = [];
    const blobs: { rel: Uint8Array; oid: string }[] = [];
    const links: Uint8Array[] = [];
    paths.forEach((rel, i) => {
      const fact = facts[i]!;
      const entry = tracked.get(keyOf(rel));
      base.listedFolders.add(keyOf(folderOf(rel)));
      if (fact.kind === "file") {
        if (fact.size > IGNORE_TARGET_BYTES) throw limit("listing", "IGNORE_TARGET_BYTES");
        out.push({ rel, real: realPath(t.workspace, rel) });
      } else if (fact.kind === "link") links.push(rel);
      else if (fact.kind === "error") throw limit("unreadable");
      else if (fact.kind === "absent" && entry?.skip === true) blobs.push({ rel, oid: entry.oid });
    });
    if (base.ignoreFiles.length + out.length + blobs.length > PREVIEW_IGNORE_FILES) throw limit("listing", "PREVIEW_IGNORE_FILES");
    const contents = blobs.length === 0 ? [] : await blobsOf(t, blobs.map((b) => b.oid));
    return { files: [...out, ...blobs.map((b, i) => ({ rel: b.rel, bytes: contents[i]! }))], links };
  }

  // git-cat-file(1) BATCH OUTPUT: `<oid> SP <type> SP <size> LF <contents> LF` for each object.
  async function blobsOf(t: PreviewTarget, oids: readonly string[]): Promise<Uint8Array[]> {
    const out = createCollector({ maxBytes: oids.length * (IGNORE_TARGET_BYTES + 200) });
    const exit = await git(runner, t, contextOf(t.workspace), blobsArgs(), out, Buffer.from(`${oids.join("\n")}\n`));
    if (exit.exitCode !== 0) throw failed("GIT_FAILED");
    const bytes = out.take();
    const blobs: Uint8Array[] = [];
    let at = 0;
    for (const oid of oids) {
      const lf = bytes.indexOf(LF, at);
      const header = lf < 0 ? null : /^([0-9a-f]+) blob ([0-9]+)$/.exec(latin1(bytes.subarray(at, lf)));
      if (header === null || header[1] !== oid) throw failed("MALFORMED_GIT_OUTPUT");
      const size = Number(header[2]);
      if (size > IGNORE_TARGET_BYTES) throw limit("listing", "IGNORE_TARGET_BYTES");
      if (bytes[lf + 1 + size] !== LF) throw failed("MALFORMED_GIT_OUTPUT");
      blobs.push(bytes.slice(lf + 1, lf + 1 + size));
      at = lf + 2 + size;
    }
    if (at !== bytes.length) throw failed("MALFORMED_GIT_OUTPUT");
    return blobs;
  }

  // Contract §6 "File facts" without a digest, in frames of 64 entries. A name that the walk refuses makes the file unreadable for the preview.
  async function factsOf(t: PreviewTarget, paths: readonly Uint8Array[]): Promise<FileFact[]> {
    const facts: FileFact[] = [];
    for (let at = 0; at < paths.length; at += FILE_FACT_ENTRIES) {
      let files: { root: "worktreeRoot"; path: string[] }[];
      try {
        files = paths.slice(at, at + FILE_FACT_ENTRIES).map((p) => ({ root: "worktreeRoot", path: utf8.decode(p).split("/") }));
      } catch {
        throw limit("unreadable");
      }
      let reply: FileFact[] | WalkStop;
      try {
        reply = await runner.fileFacts({ operationId: t.operationId, ...contextOf(t.workspace), digest: false, files }, t.signal);
      } catch (error) {
        if (error instanceof RunnerRefusal) throw limit("unreadable");
        throw error;
      }
      if ("stop" in reply) throw stopped(reply.stop);
      facts.push(...reply);
    }
    return facts;
  }

  // Plan.md D9 `name-case`: Git opens `<folder>/.gitignore` by that exact name without following a link. One `fileFacts` entry for each folder of an input
  // that lists no exact `.gitignore`. The volume case rule of the walk decides (`file_facts.rs:502`). The root is left out for the target `gitignore`.
  async function nameCase(t: PreviewTarget, base: Base, target: IgnoreTarget, inputs: readonly Input[]): Promise<void> {
    const folders = new Map<string, Uint8Array>();
    for (const input of inputs) {
      for (const folder of ancestors(input.path)) {
        const key = keyOf(folder);
        if ((folder.length > 0 || target !== "gitignore") && !base.listedFolders.has(key) && !base.probed.has(key)) folders.set(key, folder);
      }
    }
    for (const key of folders.keys()) base.probed.add(key);
    if (folders.size === 0) return;
    const facts = await factsOf(t, [...folders.values()].map((folder) => (folder.length === 0 ? GITIGNORE : Buffer.concat([withSlash(folder), GITIGNORE]))));
    if (facts.some((fact) => fact.kind === "file")) throw limit("name-case");
    if (facts.some((fact) => fact.kind === "error")) throw limit("unreadable");
  }

  // Git follows a link at `info/exclude` (report Q1), so a file or a link gives rules. A folder and an absent file give none.
  async function excludeGivesRules(t: PreviewTarget): Promise<boolean> {
    let reply: FileFact[] | WalkStop;
    try {
      reply = await runner.fileFacts({ operationId: t.operationId, ...contextOf(t.workspace), digest: false, files: [{ root: "commonDirectory", path: ["info", "exclude"] }] }, t.signal);
    } catch (error) {
      if (error instanceof RunnerRefusal) throw limit("unreadable");
      throw error;
    }
    if ("stop" in reply) throw stopped(reply.stop);
    if (reply[0]!.kind === "error") throw limit("unreadable");
    return reply[0]!.kind === "file" || reply[0]!.kind === "link";
  }

  // `ls-files -o -z -- <d>/ …` in batches that fit the command line (001 §6). The base keeps each expansion (data-model §7 `expansions`).
  async function expand(t: PreviewTarget, base: Base, folders: readonly Uint8Array[]): Promise<Map<string, Uint8Array[]>> {
    const missing = folders.filter((f) => !base.expansions.has(keyOf(f)));
    let texts: string[];
    try {
      texts = missing.map((f) => `${utf8.decode(f)}/`);
    } catch {
      throw limit("unreadable");
    }
    const measure = (batch: readonly number[]) => stepUnits({ operationId: t.operationId, workspace: t.workspace, installation: t.installation }, "read", expansionArgs(batch.map((i) => texts[i]!)));
    const batches: number[][] = [];
    for (let i = 0; i < missing.length; i++) {
      const last = batches.at(-1);
      if (last !== undefined && measure([...last, i]) <= WINDOWS_COMMAND_LINE_UNITS) last.push(i);
      else batches.push([i]);
    }
    for (const batch of batches) {
      const found = records(await listing(t, expansionArgs(batch.map((i) => texts[i]!))));
      if (found === null) throw failed("MALFORMED_GIT_OUTPUT");
      for (const i of batch) {
        const prefix = withSlash(missing[i]!);
        base.expansions.set(keyOf(missing[i]!), found.filter((r) => startsWith(r, prefix)));
      }
    }
    return new Map(folders.map((f) => [keyOf(f), base.expansions.get(keyOf(f))!]));
  }

  return {
    preview,
    // Data-model §7 "Lifetime of the base": a registration release drops it.
    release: (repositoryId: string) => void bases.delete(repositoryId),
  };
}

// A refusal of a shared read: a stop, a reason, or a code. A reason of the target read means that the preview cannot read an ignore file.
function settle<T>(value: T | WalkStop | { code: ErrorCode; reason?: string }): T {
  if (typeof value === "object" && value !== null && "stop" in value) throw stopped(value.stop);
  if (typeof value === "object" && value !== null && "code" in value) throw value.reason !== undefined ? limit("unreadable") : failed(value.code);
  return value as T;
}

// One Git process with the 30 s deadline of plan.md D9. A deadline gives `deadline`, a refusal its code, and a Cancel `canceled`.
async function git(runner: GitRunner, t: PreviewTarget, context: ProcessContext, args: string[], stdout: Collector, input?: Uint8Array): Promise<GitExit> {
  let exit: GitExit;
  try {
    exit = await runner.run({ operationId: t.operationId, context, arguments: args, ...(input === undefined ? {} : { input }), environmentPolicy: "read", limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS }, stdout, stderr: createCollector({ maxBytes: DIAGNOSTIC_BYTES }), signal: t.signal });
  } catch (error) {
    if (t.signal.aborted) throw CANCELED;
    if (error instanceof RunnerRefusal) throw failed(error.code);
    throw error;
  }
  if (t.signal.aborted) throw CANCELED;
  if (exit.deadline !== undefined) throw DEADLINE;
  if (exit.diagnosticLimit) throw failed("OUTPUT_LIMIT");
  if (exitKind(exit, "read", stdout) === "jobClosed") throw CLOSED;
  return exit;
}

const steps = <T extends readonly unknown[] | []>(work: T) => settleSteps(work, (end) => end === DEADLINE, (end) => end === CLOSED);

// One folder probe for each folder above a `.gitignore`. The shadow holds each such folder, because it holds the file below it. `skip`: probes that ran.
function probesOf(files: readonly IgnoreFile[], skip: ReadonlySet<string>): Input[] {
  const folders = new Map<string, Uint8Array>();
  for (const f of files) for (const folder of ancestors(f.rel)) if (folder.length > 0 && !skip.has(keyOf(folder))) folders.set(keyOf(folder), folder);
  return [...folders.values()].map((path) => ({ path, kind: "folder" }));
}

// The listed `.gitignore` names of `inputs`.
const named = (inputs: readonly Input[]) => inputs.filter((i) => (i.kind === "file" || i.kind === "tracked") && isGitignore(i.path)).map((i) => i.path);

// dir.c:2045: the expansion of a nested repository prints the one record `<d>/`.
const isNested = (folder: Uint8Array, found: readonly Uint8Array[]) => found.length === 1 && Buffer.compare(found[0]!, withSlash(folder)) === 0;

// The expansion of folder `d`: each file record joins as a file, each `x/` record as a nested repository, and each folder between `d` and a record as a folder input.
function expansionInputs(folder: Uint8Array, found: readonly Uint8Array[]): Input[] {
  const out: Input[] = [];
  const folders = new Map<string, Uint8Array>();
  for (const r of found) {
    const nested = r.at(-1) === SLASH;
    const path = nested ? r.subarray(0, -1) : r;
    out.push({ path, kind: nested ? "nested" : "file" });
    for (const a of ancestors(path)) if (a.length > folder.length) folders.set(keyOf(a), a);
  }
  for (const path of folders.values()) out.push({ path, kind: "folder" });
  return out;
}

// Data-model §7 groups: the full count and the first 1,000 paths by `comparePaths`. A nested repository keeps Git's `x/` form.
function group(inputs: readonly Input[]): { count: number; paths: string[] } {
  const keyed = inputs.map((input) => ({ input, key: treeKey(input.path, input.kind === "nested") })).sort((a, b) => compareKeys(a.key, b.key));
  return { count: inputs.length, paths: keyed.slice(0, PREVIEW_GROUP_PATHS).map(({ input }) => b64(input.kind === "nested" ? withSlash(input.path) : input.path)) };
}

// Plan.md D9 "Self-check": Git's verdict of each input from RI and RT, against the S verdict. Null: every input agrees.
function selfCheck(base: Base, riBytes: Uint8Array, rtBytes: Uint8Array): Reason | null {
  const ri = records(riBytes);
  const rt = records(rtBytes);
  if (ri === null || rt === null) return "self-check";
  const riKeys = new Set(ri.map(keyOf));
  const rtKeys = new Set(rt.map(keyOf));
  // An RI folder record `<d>/` with no RI record below it: an excluded folder that the walk did not enter (dir.c:2094-2096).
  const sorted = [...riKeys].sort();
  const excluded = (folderKey: string) => riKeys.has(folderKey) && !prefixed(sorted, folderKey, false);
  const covered = (path: Uint8Array) => ancestors(path).some((a) => a.length > 0 && excluded(keyOf(withSlash(a))));
  const inputKeys = new Set<string>();
  const trackedKeys = new Set<string>();
  for (const [i, input] of base.inputs.entries()) {
    let git: boolean;
    if (input.kind === "tracked") {
      trackedKeys.add(keyOf(input.path));
      git = rtKeys.has(keyOf(input.path));
    } else if (input.kind === "folder") {
      const key = keyOf(withSlash(input.path));
      inputKeys.add(key);
      git = excluded(key);
    } else {
      const key = input.kind === "nested" ? keyOf(withSlash(input.path)) : keyOf(input.path);
      inputKeys.add(key);
      git = riKeys.has(key) || covered(input.path);
    }
    if (git !== (base.s[i] === 1)) return "self-check";
  }
  for (const key of rtKeys) if (!trackedKeys.has(key)) return "self-check";
  // An RI record that is no input must be an empty folder: no U record and no expansion record at or below it (`--no-empty-directory`).
  const known = [...inputKeys, ...[...base.expansions.values()].flat().map(keyOf)].sort();
  for (const key of riKeys) {
    if (inputKeys.has(key)) continue;
    if (!key.endsWith("/") || prefixed(known, key, true) || inputKeys.has(key.slice(0, -1))) return "self-check";
  }
  return null;
}

// True when `sorted` holds a key that starts with `key`: `key` itself only with `at`, else a key after it.
function prefixed(sorted: readonly string[], key: string, at: boolean): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at ? sorted[mid]! < key : sorted[mid]! <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]!.startsWith(key);
}

// git-config(1) `core.ignoreCase`: the last entry wins, and an unset key is false. A value that is no boolean makes Git fail, so the preview fails too.
function effectiveIgnoreCase(entries: readonly ConfigEntry[]): boolean {
  const entry = entries.findLast((e) => e.key === "core.ignorecase");
  if (entry === undefined) return false;
  const value = entry.exact ? parseMaybeBool(entry.value) : -1;
  if (value === -1) throw failed("GIT_FAILED");
  return value === 1;
}

// git-config(1) `core.excludesFile`: the last entry wins. Git opens a relative value from the worktree root, so the shadow gets the joined path (report).
// `~/`, `%(prefix)/`, and an absolute path pass unchanged, because Git expands them in the shadow as in the repository (config.c `git_config_pathname`).
// Git for Windows takes a leading `/` or `\` and a drive prefix as absolute (compat/win32/path-utils.h).
function effectiveExcludesFile(entries: readonly ConfigEntry[], w: Workspace): string | null {
  const entry = entries.findLast((e) => e.key === "core.excludesfile");
  if (entry === undefined) return null;
  if (!entry.exact || entry.value === null) throw failed("GIT_FAILED");
  const optional = entry.value.startsWith(":(optional)") ? ":(optional)" : "";
  const rest = entry.value.slice(optional.length);
  const windowsGit = w.wsl === undefined && isWindows;
  const absolute = rest.startsWith("/") || (windowsGit && (rest.startsWith("\\") || NATIVE.hasDrivePrefix(rest)));
  if (rest === "" || absolute || rest.startsWith("~") || rest.startsWith("%(prefix)/")) return entry.value;
  return `${optional}${gitRoot(w)}/${rest}`;
}

// The worktree root in Git's form: Git for Windows prints `C:/…`, and a WSL Git the Linux path (contract §11).
function gitRoot(w: Workspace): string {
  if (w.wsl === undefined) return w.worktreeRoot;
  const route = routeWslPath(w.worktreeRoot, { listed: [w.wsl.distro], registry: [{ name: w.wsl.distro, guid: w.wsl.guid, version: 2 }] });
  if (route.kind !== "wsl") throw failed("GIT_FAILED");
  return route.linuxPath;
}

// The path that `hash-object --stdin-paths` reads: the absolute path of the real file in Git's form.
const realPath = (w: Workspace, rel: Uint8Array) => `${gitRoot(w)}/${utf8.decode(rel)}`;

// ---- The shadow repositories (plan.md D9 steps 1 to 6) ----

class Shadow {
  private readonly ready = new Map<Repo, Promise<string>>();
  // The OID of each file that a shadow holds, by relative path, for the step 5 check.
  private readonly written = new Map<Repo, Map<string, string>>([
    ["s", new Map()],
    ["c", new Map()],
  ]);
  // Each path of a shadow index: the ignore files and the folder entries. A folder above another path needs no entry of its own.
  private readonly parents = new Map<Repo, Set<string>>([
    ["s", new Set()],
    ["c", new Set()],
  ]);
  private readonly folders = new Map<Repo, Set<string>>([
    ["s", new Set()],
    ["c", new Set()],
  ]);

  constructor(
    private readonly runner: GitRunner,
    private readonly t: PreviewTarget,
    private readonly shadowId: string,
    private readonly windows: boolean,
  ) {}

  private run(repo: Repo, index: "index" | "exclude", args: string[], input?: Uint8Array, stdout: Collector = createCollector({ maxBytes: DIAGNOSTIC_BYTES })): Promise<GitExit> {
    const context: ProcessContext = { contextKind: "ignorePreview", gitInstallationId: this.t.workspace.gitInstallationId, shadowId: this.shadowId, shadowRepository: repo, shadowIndex: index };
    return git(this.runner, this.t, context, args, stdout, input);
  }

  // Step 1, then the OID of an empty blob. It gives the object format of the shadow and the OID of each folder entry.
  private init(repo: Repo): Promise<string> {
    let ready = this.ready.get(repo);
    if (ready === undefined) {
      ready = (async () => {
        if ((await this.run(repo, "index", SHADOW.init())).exitCode !== 0) throw limit("shadow-copy");
        return this.blob(repo, new Uint8Array());
      })();
      this.ready.set(repo, ready);
    }
    return ready;
  }

  private async blob(repo: Repo, bytes: Uint8Array): Promise<string> {
    const out = createCollector({ maxBytes: DIAGNOSTIC_BYTES });
    const exit = await this.run(repo, "index", SHADOW.blob(), bytes, out);
    const text = latin1(out.take());
    if (exit.exitCode !== 0 || !text.endsWith("\n") || !OID.test(text.slice(0, -1))) throw limit("shadow-copy");
    return text.slice(0, -1);
  }

  // `hash-object --stdin-paths`: one OID line for each path line, in input order.
  private async hashPaths(repo: Repo, args: string[], paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const out = createCollector({ maxBytes: STATUS_LISTING_BYTES });
    const exit = await this.run(repo, "index", args, Buffer.from(`${paths.map(quoted).join("\n")}\n`), out);
    const text = latin1(out.take());
    const oids = text.endsWith("\n") ? text.slice(0, -1).split("\n") : [];
    if (exit.exitCode !== 0 || oids.length !== paths.length || !oids.every((oid) => OID.test(oid))) throw limit("shadow-copy");
    return oids;
  }

  // Steps 2 to 5 for `files` and the folder entries of `inputs`: the blobs, the index entries, the checkout, and the OID check of each written file.
  async fill(repo: Repo, files: readonly IgnoreFile[], inputs: readonly Input[]): Promise<void> {
    const empty = await this.init(repo);
    const written = this.written.get(repo)!;
    const parents = this.parents.get(repo)!;
    const folders = this.folders.get(repo)!;
    const real = files.filter((f) => f.real !== undefined);
    const oids = new Map<string, string>();
    (await this.hashPaths(repo, SHADOW.copy(this.windows), real.map((f) => f.real!))).forEach((oid, i) => oids.set(keyOf(real[i]!.rel), oid));
    for (const f of files) if (f.bytes !== undefined) oids.set(keyOf(f.rel), await this.blob(repo, f.bytes));
    const entries: Uint8Array[] = [];
    for (const f of files) {
      written.set(keyOf(f.rel), oids.get(keyOf(f.rel))!);
      entries.push(Buffer.concat([Buffer.from(`100644 ${oids.get(keyOf(f.rel))}\t`), f.rel, Uint8Array.of(NUL)]));
      for (const a of ancestors(f.rel)) parents.add(keyOf(a));
    }
    // A 160000 entry gives an empty folder at each gitlink, nested repository, and folder input (report E1). `update-index` replaces a folder entry
    // that a deeper path meets later, and the folder stays on disk. A folder above another new path gets no entry, so no deeper entry is lost.
    const boxes = inputs.filter((i) => (i.kind === "folder" || i.kind === "nested" || i.gitlink === true) && !folders.has(keyOf(i.path)));
    for (const box of boxes) for (const a of ancestors(box.path)) parents.add(keyOf(a));
    for (const box of boxes) {
      folders.add(keyOf(box.path));
      if (!parents.has(keyOf(box.path))) entries.push(Buffer.concat([Buffer.from(`160000 ${empty}\t`), box.path, Uint8Array.of(NUL)]));
    }
    if (entries.length === 0) return;
    if ((await this.run(repo, "index", SHADOW.index(), Buffer.concat(entries))).exitCode !== 0) throw limit("shadow-copy");
    if ((await this.run(repo, "index", SHADOW.checkout(this.windows, false))).exitCode !== 0) throw limit("shadow-copy");
    await this.verify(repo, files.map((f) => ({ rel: utf8.decode(f.rel), oid: written.get(keyOf(f.rel))! })));
  }

  // Step 5: each written file must give the OID of its blob.
  private async verify(repo: Repo, files: readonly { rel: string; oid: string }[]): Promise<void> {
    const again = await this.hashPaths(repo, SHADOW.verify(this.windows), files.map((f) => f.rel));
    if (again.some((oid, i) => oid !== files[i]!.oid)) throw limit("shadow-copy");
  }

  // Step 4 for `info/exclude`: a second index with the one entry `exclude`, checked out below `.git/info/`. Git follows a link there, so the saved copy is read by path.
  async exclude(repo: Repo, source: { real: string } | { bytes: Uint8Array } | null): Promise<void> {
    await this.init(repo);
    if (source === null) return;
    const oid = "real" in source ? (await this.hashPaths(repo, SHADOW.copy(this.windows), [source.real]))[0]! : await this.blob(repo, source.bytes);
    if ((await this.run(repo, "exclude", SHADOW.index(), Buffer.from(`100644 ${oid}\texclude\0`))).exitCode !== 0) throw limit("shadow-copy");
    if ((await this.run(repo, "exclude", SHADOW.checkout(this.windows, true))).exitCode !== 0) throw limit("shadow-copy");
    await this.verify(repo, [{ rel: ".git/info/exclude", oid }]);
  }

  // Step 6: `check-ignore` over `inputs` in `batches` parts at the same time, joined in input order. The caller bounds the inputs with `inputsFit`.
  async check(repo: Repo, inputs: readonly Input[], ignoreCase: boolean, excludesFile: string | null, batches = CHECK_PROCESSES): Promise<Uint8Array> {
    if (inputs.length === 0) return new Uint8Array();
    const sent = inputs.map((i) => stdinPath(i.path));
    const size = Math.ceil(sent.length / batches);
    const output = { bytes: 0 };
    const parts = Array.from({ length: Math.ceil(sent.length / size) }, (_, k) => this.checkPart(repo, sent.slice(k * size, (k + 1) * size), output, ignoreCase, excludesFile));
    return Buffer.concat(await steps(parts));
  }

  private async checkPart(repo: Repo, sent: readonly Uint8Array[], output: { bytes: number }, ignoreCase: boolean, excludesFile: string | null): Promise<Uint8Array> {
    const out = verdictCollector(sent, output);
    const exit = await this.run(repo, "index", SHADOW.check(this.windows, ignoreCase, excludesFile), Buffer.concat(sent.flatMap((path) => [path, Uint8Array.of(NUL)])), out);
    if (out.limited) throw limit("listing", "STATUS_LISTING_BYTES");
    // git-check-ignore(1) EXIT STATUS: 0 when a path is ignored, 1 when none is.
    if (exit.exitCode !== 0 && exit.exitCode !== 1) throw failed("GIT_FAILED");
    if (!out.done()) throw failed("MALFORMED_GIT_OUTPUT");
    return out.verdicts;
  }
}
