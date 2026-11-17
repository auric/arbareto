// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 contract Δ3 `readSubmoduleChange` and `readSubmoduleWork`, Δ5 bounds, Δ12, data-model §15 and §16, plan.md D19, research.md R18.
// Inside a submodule, these reads start only the `submodule*Args` commands of `commands.ts`, in the form `-C <worktree> --git-dir=.git`.
// In WSL, `readSubmoduleWork` runs its three commands through the fixed script `submoduleWork` (contract Δ3 "WSL route").

import type { FileFact } from "../contracts/channel";
import type { ErrorCode } from "../contracts/errors";
import type { GitlinkFact } from "../contracts/file-action";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  GIT_PROCESS_DEADLINE_MS,
  STATUS_LISTING_BYTES,
  SUBMODULE_CHANGE_COMMITS,
  SUBMODULE_CHANGE_OUTPUT_BYTES,
  SUBMODULE_GITMODULES_BYTES,
  SUBMODULE_WORK_PAGE,
  SUBMODULE_WORK_PARALLEL,
  SUBMODULE_WORK_TARGETS,
  TRUST_INPUT_BYTES,
  WINDOWS_COMMAND_LINE_UNITS,
} from "../contracts/limits";
import { MATCHING_PROBE_WSL_FOLDER } from "../contracts/matching-probe";
import { both, fail, Stop, CLOSED, type InspectionOutcome, type InspectionTarget } from "./commit-changes";
import {
  isObjectId,
  isOneLevelRefName,
  objectCheckArgs,
  submoduleCommitExistsArgs,
  submoduleConfigListArgs,
  submoduleCountArgs,
  submoduleHeadOidArgs,
  submoduleHeadTargetArgs,
  submoduleLogArgs,
  submoduleRefExistsArgs,
  submoduleStatusArgs,
  submoduleToplevelArgs,
  submoduleWorkArgs,
  OID_HEX,
  type ObjectFormat,
  type SubmoduleLocation,
} from "./commands";
import { createCollector, exitKind, RunnerRefusal, workScriptUnits, type Collector, type GitExit, type GitRunner } from "./git-runner";
import { contextOf, latin1, runRead, strictUtf8, type ReadStep, type ReadTarget } from "./read-steps";
import type { ChangeSnapshot, IndexEntry, ReadInstallation } from "./snapshot";
import { createStatusParser, displayPath } from "./status-parser";
import { submoduleStageArgs } from "./submodule-open";
import { gitmodulesSource, headGitmodulesOf, parseGitmodules, pathForms, type GitmodulesIndexEntry } from "./submodule-review";
import { isComponent, keyParts, listSubmoduleTrust, parseConfigListing, requestFacts, type ConfigEntry, type FactEntry, type ServiceEnvironment, type Trust } from "./trust";

const GITLINK = "160000";
const NUL = 0x00;
const LF = 0x0a;
const ZERO = /^0+$/;

// Data-model §15: the IDs that the source gives. `head`: the submodule HEAD, read inside the submodule.
export interface ChangeRequest {
  path: Uint8Array;
  old: string | null;
  new: string | null | "head";
  // Workspace source: the snapshot index. Commit source: undefined, so the read lists `.gitmodules` and checks the path in the index (plan.md D11 check 3).
  index?: readonly IndexEntry[];
  // Contract §5: a status bound cut the snapshot index listing, so the read refuses with OUTPUT_LIMIT.
  indexCut?: true;
  // Plan.md D20 rule 2: the row is a `movedGitlink` record, so a failed D11 check gives `not-located`.
  moved?: true;
}

// An all-zero ID marks the absent side (git-status(1), diff-format(5)).
export const sideId = (mode: string | undefined, oid: string | undefined): string | null => (mode === GITLINK && oid !== undefined && !ZERO.test(oid) ? oid : null);

// Contract §6 "File facts": the path components, or null when a component breaks the channel rule or the bytes are no valid UTF-8.
export function componentsOf(path: Uint8Array): string[] | null {
  let text: string;
  try {
    text = strictUtf8.decode(path);
  } catch {
    return null;
  }
  const parts = text.split("/");
  return parts.every(isComponent) ? parts : null;
}

// One LF-ended line of UTF-8 text without another LF, or null.
function oneLine(bytes: Uint8Array): string | null {
  if (bytes.length < 2 || bytes[bytes.length - 1] !== LF) return null;
  let text: string;
  try {
    text = strictUtf8.decode(bytes.subarray(0, -1));
  } catch {
    return null;
  }
  return text.includes("\n") ? null : text;
}

// Contract Δ3 `readSubmoduleWork`: a repository-controlled command of these keys can run in a status read (001 §7, §12 "Submodule programs").
function statusProgram(key: string): boolean {
  const p = keyParts(key);
  if (p === null) return false;
  if (p.section === "core" && p.subsection === null) return p.variable === "fsmonitor";
  return p.section === "filter" && p.subsection !== null && (p.variable === "clean" || p.variable === "process");
}
// The entries of the status program keys. The last entry of a key wins in Git, and each key keeps all its entries in order.
const statusProgramEntries = (entries: readonly ConfigEntry[]) => entries.filter((e) => statusProgram(e.key));

// Contract Δ3 `readSubmoduleChange` and `readSubmoduleWork`: a path that no argv item or `fileFacts` component can carry.
const PATH_REFUSAL: InspectionOutcome = { result: "failed", code: "SUBMODULE_UNAVAILABLE", value: { reason: "path" } };

type StageRecord = GitmodulesIndexEntry & { mode: string };
// Git keeps at most three stages of one path. A fourth record means another path.
const STAGE_RECORDS = 3;

// ---- Plan.md D11 checks 3 to 5 and the submodule HEAD read. D19 `locate` throws a failure, and D20 rule 2 returns it. ----

type ReadFailure = { code: ErrorCode } | { stop: "canceled" | "deadline" };
type LineRead = { exit: GitExit; line: string | null };
// 001 contract §6 "Process replies": a Job close. `both` takes it last, so D19 throws the `CLOSED` value for it.
const JOB_CLOSED: ReadFailure = { code: "GIT_FAILED" };

// Plan.md D11 check 3: exactly one stage-0 record at the exact path, with mode 160000.
const oneGitlink = (at: readonly { path: Uint8Array; stage: number; mode: string }[], path: Uint8Array): boolean =>
  at.length === 1 && at[0]!.stage === 0 && at[0]!.mode === GITLINK && Buffer.compare(at[0]!.path, path) === 0;

// Plan.md D11 check 4: a folder and a `.git` file or folder. Neither fact follows a link. Null: a file fact error.
const initializedFacts = (folder: FileFact, git: FileFact): boolean | null =>
  folder.kind === "error" || git.kind === "error" ? null : folder.kind === "directory" && (git.kind === "file" || git.kind === "directory");

// One small read inside the submodule. A process stopped at the output bound gives a null line.
async function lineOf(runner: GitRunner, t: ReadTarget, args: string[]): Promise<LineRead | ReadFailure> {
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const s = await runRead(runner, t, args, out);
  if (t.signal.aborted) return { stop: "canceled" };
  if ("refused" in s) return { code: s.refused };
  if (s.exit.deadline !== undefined) return { stop: "deadline" };
  if (s.exit.diagnosticLimit) return { code: "OUTPUT_LIMIT" };
  if (exitKind(s.exit, "read", out) === "jobClosed") return JOB_CLOSED;
  return { exit: s.exit, line: out.limited ? null : oneLine(out.take()) };
}

// Plan.md D11 check 5: the worktree root that Git prints for `--git-dir=.git` is the folder.
const locatedFrom = (exitCode: number | null, line: string | null, worktree: string): boolean => exitCode === 0 && line === worktree;

async function locatedFact(runner: GitRunner, t: ReadTarget, location: { worktree: string }): Promise<boolean | ReadFailure> {
  const top = await lineOf(runner, t, submoduleToplevelArgs(location));
  return "exit" in top ? locatedFrom(top.exit.exitCode, top.line, location.worktree) : top;
}

// Contract Δ3 `readSubmoduleWork` step 2: the entries of the status program keys. `limited`: the output passed TRUST_INPUT_BYTES.
function configFrom(limited: boolean, exitCode: number | null, bytes: Uint8Array): ConfigEntry[] | ErrorCode {
  if (limited) return "OUTPUT_LIMIT";
  if (exitCode !== 0) return "GIT_FAILED";
  const entries = parseConfigListing(bytes, false);
  return entries === null ? "MALFORMED_GIT_OUTPUT" : statusProgramEntries(entries);
}

type WorkFacts = { modified: boolean; untracked: boolean };

// Contract Δ3 `readSubmoduleWork` step 3. `out` is `limited` when both facts are set or a status bound is reached, so the read can stop there.
function statusFrom(objectFormat: ObjectFormat) {
  let modified = false;
  let untracked = false;
  let size = 0;
  const parser = createStatusParser(objectFormat, false, (record) => {
    if (record.kind === "untracked") untracked = true;
    else if (record.kind !== "ignored") modified = true;
  });
  const out: Collector = {
    push(chunk) {
      size += chunk.length;
      parser.push(chunk);
    },
    get bytes() {
      return size;
    },
    records: 0,
    get limited() {
      return parser.limited || (modified && untracked);
    },
  };
  // `cut`: the output passed its bound, so only the facts of its first bytes count.
  const end = (exitCode: number | null, cut: boolean): WorkFacts | ErrorCode => {
    if (modified && untracked) return { modified, untracked };
    if (parser.limited || cut) return "OUTPUT_LIMIT";
    if (exitCode !== 0) return "GIT_FAILED";
    if (parser.end().state !== "complete") return "MALFORMED_GIT_OUTPUT";
    return { modified, untracked };
  };
  return { out, end };
}

// ---- Contract Δ3 `readSubmoduleWork` "WSL route": the frames of the `submoduleWork` script ----

// One command output. `end` gets the Git exit code, or `limit` when the output passed the bound.
interface FrameSink {
  out: Pick<Collector, "push" | "limited">;
  end(exit: number | "limit"): void;
}

// `<i> <exit> <n>` or `<i> limit <bound>`. The script prints each number in decimal without a leading zero.
const FRAME_HEAD = /^(0|[1-9][0-9]*) (?:limit (0|[1-9][0-9]*)|(0|[1-9][0-9]*) (0|[1-9][0-9]*))$/;
// The shell gives an exit status from 0 to 255.
const EXIT_STATUS_MAX = 255;

// The frames of one run in argument order: `perTarget` frames per target, and `sinks[k]` takes frame k.
// Output in another form sets `malformed`, and `limited` then stops the run.
function frameReader(bound: number, perTarget: number, sinks: readonly FrameSink[]) {
  // The `limit` head of the last target is the longest valid head, because an exit has at most 3 digits and `n` is at most `bound`.
  const longest = `${sinks.length / perTarget - 1} limit ${bound}\n`.length;
  let head = "";
  // The output bytes that the current frame still holds. -1: the next bytes are a head.
  let left = -1;
  let exit: number | "limit" = "limit";
  let done = 0;
  let malformed = false;
  let size = 0;
  const finish = () => {
    sinks[done]!.end(exit);
    done++;
    left = -1;
  };
  const start = (line: string): boolean => {
    const m = FRAME_HEAD.exec(line);
    if (m === null || Number(m[1]) !== Math.floor(done / perTarget)) return false;
    const limit = m[2] !== undefined;
    const n = Number(limit ? m[2] : m[4]);
    if (limit ? n !== bound : Number(m[3]) > EXIT_STATUS_MAX || n > bound) return false;
    exit = limit ? "limit" : Number(m[3]);
    left = n;
    if (left === 0) finish();
    return true;
  };
  return {
    push(chunk: Uint8Array): void {
      size += chunk.length;
      for (let at = 0; at < chunk.length && !malformed; ) {
        if (left < 0) {
          const lf = chunk.indexOf(LF, at);
          head += latin1(chunk.subarray(at, lf < 0 ? chunk.length : lf));
          at = lf < 0 ? chunk.length : lf + 1;
          if (done === sinks.length || head.length >= longest) malformed = true;
          else if (lf >= 0) {
            malformed = !start(head);
            head = "";
          }
          continue;
        }
        const take = Math.min(left, chunk.length - at);
        const sink = sinks[done]!;
        if (!sink.out.limited) sink.out.push(chunk.subarray(at, at + take));
        at += take;
        left -= take;
        if (left === 0) finish();
      }
    },
    get bytes() {
      return size;
    },
    records: 0,
    get limited() {
      return malformed;
    },
    // The count of whole frames.
    get done() {
      return done;
    },
  };
}

// `rev-parse --verify -q HEAD`: exit 0 with one object ID line names the HEAD commit. Null: no such line.
const headId = (head: LineRead, objectFormat: ReadTarget["workspace"]["objectFormat"]): string | null =>
  head.exit.exitCode === 0 && head.line !== null && isObjectId(head.line, objectFormat) ? head.line : null;

// The D19 form of a core result: a failure ends the read.
function orThrow<T>(r: T | ReadFailure): T {
  if (r === JOB_CLOSED) throw CLOSED;
  if (typeof r === "object" && r !== null && "stop" in r) throw new Stop({ result: r.stop });
  if (typeof r === "object" && r !== null && "code" in r) throw fail(r.code);
  return r as T;
}

// Contract Δ3 `readSubmoduleWork` "Pages": the targets in index order, then the `pathBytes` of the unlisted moved gitlinks while a position is free.
// A cut index listing has one page.
export function workPlan(snapshot: Pick<ChangeSnapshot, "indexEntries" | "indexCut">, moved: ReadonlySet<string>): { positions: (IndexEntry | string)[]; limited: number; pages: number } {
  if (snapshot.indexCut) return { positions: [], limited: 0, pages: 1 };
  const gitlinks = snapshot.indexEntries.filter((e) => e.stage === 0 && e.mode === GITLINK);
  const targets = gitlinks.slice(0, SUBMODULE_WORK_TARGETS);
  // Plan.md D11 check 3: a moved gitlink without its stage-0 gitlink entry in the snapshot index is no target. It gives `not-located`.
  const indexed = new Set(gitlinks.map((e) => Buffer.from(e.path).toString("base64")));
  const unlisted = [...moved].filter((p) => !indexed.has(p));
  const shown = unlisted.slice(0, SUBMODULE_WORK_TARGETS - targets.length);
  const positions = [...targets, ...shown];
  return { positions, limited: gitlinks.length - targets.length + unlisted.length - shown.length, pages: Math.max(1, Math.ceil(positions.length / SUBMODULE_WORK_PAGE)) };
}

export interface SubmoduleReadsOptions {
  runner: GitRunner;
  trust: Trust;
  environment: ServiceEnvironment;
  // Contract Δ3 `readSubmoduleWork`: the 001 read deadline of each page.
  readDeadlineMs: number;
  // Test seam (T115): a WSL page takes the per-target route of v0.1.0, the reference of the script route. No frame sets it.
  wslPerTarget?: true;
}

export function createSubmoduleReads({ runner, trust, environment, readDeadlineMs, wslPerTarget }: SubmoduleReadsOptions) {
  async function step(t: InspectionTarget, args: string[], out: Collector, input?: Uint8Array): Promise<GitExit> {
    const s = await runRead(runner, t, args, out, input);
    if (t.signal.aborted) throw new Stop({ result: "canceled" });
    if ("refused" in s) throw fail(s.refused);
    if (s.exit.deadline !== undefined) throw new Stop({ result: "deadline" });
    if (s.exit.diagnosticLimit) throw fail("OUTPUT_LIMIT");
    if (exitKind(s.exit, "read", out) === "jobClosed") throw CLOSED;
    return s.exit;
  }
  const small = () => createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });

  // The parent 001 §7 `reads` gate, before the first Git process.
  async function gate(t: InspectionTarget): Promise<void> {
    const listed = await trust.listTrust({ operationId: t.operationId, signal: t.signal, workspace: t.workspace });
    if (!listed.ok) throw new Stop("stop" in listed ? { result: listed.stop } : { result: "failed", code: listed.code });
    const refused = trust.gate(t.workspace, listed.listing, t.installation, "reads");
    if (refused !== null) throw fail(refused);
  }

  async function facts(t: InspectionTarget, files: FactEntry[]): Promise<FileFact[]> {
    if (files.length === 0) return [];
    const reply = await requestFacts(runner, t.operationId, t.workspace, false, files, t.signal);
    if (t.signal.aborted) throw new Stop({ result: "canceled" });
    if (!Array.isArray(reply)) throw new Stop("stop" in reply ? { result: reply.stop } : { result: "failed", code: reply.code });
    return reply;
  }
  // A link before the last component means that no entry exists at the path. The walk never follows a link.
  const exists = (fact: FileFact, length: number) => fact.kind !== "absent" && (fact.kind !== "link" || fact.component === length);
  // A file fact error fails the read.
  const initialized = (folder: FileFact, git: FileFact): boolean => {
    const ok = initializedFacts(folder, git);
    if (ok === null) throw fail("REPOSITORY_UNAVAILABLE");
    return ok;
  };
  const factsOf = (parts: readonly string[]): FactEntry[] => [
    { root: "worktreeRoot", path: [...parts] },
    { root: "worktreeRoot", path: [...parts, ".git"] },
  ];

  const located = async (t: InspectionTarget, location: { worktree: string }): Promise<boolean> => orThrow(await locatedFact(runner, t, location));

  // ---- readSubmoduleChange ----

  // `ls-files -z --stage` records of one path: `<mode> SP <object> SP <stage> TAB <path> NUL`. Null: more records than the bound.
  async function stageRecords(t: InspectionTarget, path: string): Promise<StageRecord[] | null> {
    const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, maxRecords: STAGE_RECORDS, separator: NUL });
    const exit = await step(t, submoduleStageArgs(path), out);
    if (out.limited) return null;
    if (exit.exitCode !== 0) throw fail("GIT_FAILED");
    const header = new RegExp(`^([0-7]{6}) (${OID_HEX[t.workspace.objectFormat]}) ([0-3])\t`);
    const records: StageRecord[] = [];
    const bytes = out.take();
    if (bytes.length > 0 && bytes[bytes.length - 1] !== NUL) throw fail("MALFORMED_GIT_OUTPUT");
    for (let at = 0; at < bytes.length; ) {
      const end = bytes.indexOf(NUL, at);
      const record = bytes.subarray(at, end);
      const m = header.exec(latin1(record));
      if (m === null) throw fail("MALFORMED_GIT_OUTPUT");
      records.push({ path: record.subarray(m[0].length), stage: Number(m[3]), oid: m[2]!, mode: m[1]! });
      at = end + 1;
    }
    return records;
  }

  // Plan.md D19 "Kind": the first `.gitmodules` source of 001 §12 "Review reads" maps the path to a name. None of these sources loads the index.
  async function kindOf(t: InspectionTarget, path: Uint8Array, worktreeFile: boolean, index: readonly GitmodulesIndexEntry[]): Promise<"submodule" | "nested"> {
    const fmt = t.workspace.objectFormat;
    const source = await gitmodulesSource(worktreeFile, index, fmt, async () => {
      const out = small();
      const exit = await step(t, objectCheckArgs(), out, new TextEncoder().encode("HEAD:.gitmodules\n"));
      if (exit.exitCode !== 0) throw fail("GIT_FAILED");
      const has = out.limited ? null : headGitmodulesOf(out.take(), fmt);
      if (has === null) throw fail("MALFORMED_GIT_OUTPUT");
      return has;
    });
    // Null: no `.gitmodules` source exists. `headHas` returns only booleans, so no other value passes through.
    if (!Array.isArray(source)) return "nested";
    const out = createCollector({ maxBytes: SUBMODULE_GITMODULES_BYTES });
    const exit = await step(t, source, out);
    if (out.limited) throw fail("OUTPUT_LIMIT");
    if (exit.exitCode !== 0) throw fail("GIT_FAILED");
    const parsed = parseGitmodules(out.take());
    if (parsed === null) throw fail("MALFORMED_GIT_OUTPUT");
    return parsed.nameOf.has(latin1(path)) ? "submodule" : "nested";
  }

  // The `log` of one side. It starts beside `rev-list`, so `commitsOf` checks it only after the counts.
  async function logOf(t: InspectionTarget, location: SubmoduleLocation, include: string, exclude: string) {
    const out = createCollector({ maxBytes: SUBMODULE_CHANGE_OUTPUT_BYTES });
    const exit = await step(t, submoduleLogArgs(location, include, exclude, t.workspace.objectFormat, SUBMODULE_CHANGE_COMMITS), out);
    return { exit, out };
  }

  // `log -z --format=%H%x00%s`: object ID, NUL, subject bytes, NUL per commit. `limited`: the output bound cut the list after its whole records.
  // A side with a count of 0 must print nothing.
  function commitsOf(t: InspectionTarget, { exit, out }: Awaited<ReturnType<typeof logOf>>, count: number) {
    if (!out.limited && exit.exitCode !== 0) throw fail("GIT_FAILED");
    const bytes = out.take();
    const commits: { oid: string; subject: string }[] = [];
    let at = 0;
    while (at < bytes.length) {
      const idEnd = bytes.indexOf(NUL, at);
      const subjectEnd = idEnd < 0 ? -1 : bytes.indexOf(NUL, idEnd + 1);
      if (subjectEnd < 0) break;
      const oid = latin1(bytes.subarray(at, idEnd));
      if (!isObjectId(oid, t.workspace.objectFormat)) throw fail("MALFORMED_GIT_OUTPUT");
      commits.push({ oid, subject: displayPath(bytes.subarray(idEnd + 1, subjectEnd)) });
      at = subjectEnd + 1;
    }
    const expected = Math.min(count, SUBMODULE_CHANGE_COMMITS);
    if (commits.length > expected || (!out.limited && (at !== bytes.length || commits.length !== expected))) throw fail("MALFORMED_GIT_OUTPUT");
    return { commits, limited: out.limited };
  }

  async function readSubmoduleChange(t: InspectionTarget, request: ChangeRequest): Promise<InspectionOutcome> {
    const w = t.workspace;
    const fmt = w.objectFormat;
    if (request.indexCut) return { result: "failed", code: "OUTPUT_LIMIT" };
    const old = request.old;
    let next = request.new;
    const value = (kind: "submodule" | "nested", state: object, limited = false) => ({
      pathBytes: Buffer.from(request.path).toString("base64"),
      path: displayPath(request.path),
      kind,
      old,
      new: next === "head" ? null : next,
      state,
      limited,
    });
    const needLocation = (old !== null && next !== null) || next === "head";
    // A `single` change needs no path item. Every other state needs the path in argv and in `fileFacts`.
    const parts = needLocation ? componentsOf(request.path) : [];
    if (parts === null) return PATH_REFUSAL;
    const pathText = parts.join("/");
    const forms = pathForms(w, t.installation);
    const worktree = (forms.gitRoot.endsWith("/") ? forms.gitRoot : `${forms.gitRoot}/`) + pathText;
    try {
      await gate(t);
      const files: FactEntry[] = [{ root: "worktreeRoot", path: [".gitmodules"] }, ...(needLocation ? factsOf(parts) : [])];
      // Plan.md D11 check 3: a workspace source takes the snapshot index, a commit source lists the path in the index.
      const listed = request.index === undefined ? both(stageRecords(t, ".gitmodules"), needLocation ? stageRecords(t, pathText) : Promise.resolve(null)) : null;
      const [fileFacts, records] = await both(facts(t, files), listed ?? Promise.resolve(null));
      // Git keeps at most three stages of `.gitmodules`, so more records are no valid listing.
      const index = records === null ? request.index! : records[0];
      if (index === null) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
      const kindRead = kindOf(t, request.path, exists(fileFacts[0]!, 1), index);
      if (!needLocation) return { result: "succeeded", value: value(await kindRead, { state: "single" }) };

      const at = records === null ? request.index!.filter((e) => Buffer.from(e.path).equals(request.path)) : records[1];
      const checkThree = at !== null && oneGitlink(at, request.path);
      const location = { worktree };
      // Plan.md D11: check 5 starts only after checks 3 and 4 pass, and every other submodule Git run only after check 5. The parent `kindOf` runs beside them.
      // False: a check failed. A string: the submodule HEAD. Null: a `head` read failed.
      const locate = async (): Promise<boolean | string | null> => {
        if (!(checkThree && initialized(fileFacts[1]!, fileFacts[2]!) && (await located(t, location)))) return false;
        if (next !== "head") return true;
        return headId(orThrow(await lineOf(runner, t, submoduleHeadOidArgs(location))), fmt);
      };
      const [kind, here] = await both(kindRead, locate());
      if (here === false) return { result: "succeeded", value: value(kind, { state: request.moved ? "not-located" : "not-initialized" }) };
      if (here === null) return { result: "failed", code: "GIT_FAILED" };
      if (typeof here === "string") next = here;
      if (old === null || next === null) return { result: "succeeded", value: value(kind, { state: "single" }) };
      const [o, n] = [old, next];

      const countOut = small();
      const [counted, [addedLog, removedLog]] = await both(step(t, submoduleCountArgs(location, o, n, fmt), countOut), both(logOf(t, location, n, o), logOf(t, location, o, n)));
      if (counted.exitCode !== 0) {
        // git-cat-file(1) `-e`: a non-zero exit means that the commit is not present. Only this exit gives `missing`. No command fetches.
        const present = async (oid: string) => (await step(t, submoduleCommitExistsArgs(location, oid, fmt), small())).exitCode === 0;
        const [hasOld, hasNew] = await both(present(o), present(n));
        if (!hasOld || !hasNew) return { result: "succeeded", value: value(kind, { state: "missing", which: !hasOld && !hasNew ? "both" : hasOld ? "new" : "old" }) };
        return { result: "failed", code: "GIT_FAILED" };
      }
      const counts = countOut.limited ? null : /^([0-9]+)\t([0-9]+)\n$/.exec(latin1(countOut.take()));
      if (counts === null || !Number.isSafeInteger(Number(counts[1])) || !Number.isSafeInteger(Number(counts[2]))) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
      // git-rev-list(1): for `<old>...<new>`, left counts the commits only in `<old>`, right the commits only in `<new>`.
      const removed = Number(counts[1]);
      const added = Number(counts[2]);
      const addedList = commitsOf(t, addedLog, added);
      const removedList = commitsOf(t, removedLog, removed);
      return {
        result: "succeeded",
        value: value(kind, { state: "commits", added, removed, addedCommits: addedList.commits, removedCommits: removedList.commits }, addedList.limited || removedList.limited),
      };
    } catch (error) {
      if (error instanceof Stop) return error.outcome;
      throw error;
    }
  }

  // ---- readSubmoduleWork ----

  type WorkEntry = { pathBytes: string; path: string } & (
    | { state: "checked"; modified: boolean; untracked: boolean }
    | { state: "not-initialized" | "not-located" }
    | { state: "unchecked"; reason: "programs" }
    | { state: "unchecked"; reason: "failed"; code: ErrorCode }
  );

  // 001 §12 "Submodule programs": every local and worktree entry of a submodule is repository-controlled. The 001 §7 rule decides the other scopes.
  async function programsIn(t: InspectionTarget, root: string, entries: ConfigEntry[]): Promise<boolean> {
    const listing = await listSubmoduleTrust(runner, { operationId: t.operationId, signal: t.signal, workspace: t.workspace }, environment, entries, null, { root, gitDirectory: null });
    if (t.signal.aborted) throw new Stop({ result: "canceled" });
    if (!listing.ok) throw new Stop("stop" in listing ? { result: listing.stop } : { result: "failed", code: listing.code });
    return listing.listing.integrations.some((i) => i.repositoryControlled && statusProgram(i.key));
  }

  // Contract Δ3 `readSubmoduleWork` step 1 check 5 and steps 2 and 3 for one target. Null: the target is not initialized.
  async function workOf(t: InspectionTarget, location: { worktree: string }): Promise<WorkFacts | "programs" | null> {
    const config = createCollector({ maxBytes: TRUST_INPUT_BYTES });
    // Both commands load no index and run no program, so the listing runs beside the location check.
    const [here, listedExit] = await both(located(t, location), step(t, submoduleConfigListArgs(location), config));
    if (!here) return null;
    const entries = configFrom(config.limited, listedExit.exitCode, config.take());
    if (typeof entries === "string") throw fail(entries);
    if (await programsIn(t, location.worktree, entries)) return "programs";
    // A `limited` collector stops its process (contract §6 "Byte caps"). Both facts, or a status bound, end the status.
    const status = statusFrom(t.workspace.objectFormat);
    const exit = await step(t, submoduleStatusArgs(location), status.out);
    const facts = status.end(exit.exitCode, false);
    if (typeof facts === "string") throw fail(facts);
    return facts;
  }

  // One run of the fixed script. A runner refusal gives its code.
  async function runScript(t: InspectionTarget, args: string[], stdout: Collector): Promise<ReadStep> {
    const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    try {
      const exit = await runner.run({ operationId: t.operationId, context: contextOf(t.workspace), arguments: args, script: "submoduleWork", environmentPolicy: "read", limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS }, stdout, stderr, signal: t.signal });
      return { exit, stderrBytes: stderr.bytes };
    } catch (error) {
      if (error instanceof RunnerRefusal) return { refused: error.code };
      throw error;
    }
  }

  // Contract Δ3 "WSL route" "Command lines" and "Failures": the runs of one phase. Each run takes the next targets in page order that fit.
  // `sinksOf(j)` gives the frame sinks of target j. `failed(j, code)` ends a target without whole frames. False: a deadline ended the page.
  async function phaseRuns(t: InspectionTarget, outer: AbortSignal, deadline: AbortSignal, phase: "a" | "b", targets: readonly string[], sinksOf: (j: number) => FrameSink[], failed: (j: number, code: ErrorCode) => void): Promise<boolean> {
    const bound = phase === "a" ? TRUST_INPUT_BYTES : STATUS_LISTING_BYTES;
    const perTarget = phase === "a" ? 2 : 1;
    const folder = () => `${MATCHING_PROBE_WSL_FOLDER}${crypto.randomUUID()}`;
    const sample = folder();
    const fits = (run: readonly number[]) => workScriptUnits(t, submoduleWorkArgs(sample, phase, bound, run.map((j) => targets[j]!))) <= WINDOWS_COMMAND_LINE_UNITS;
    const runs: number[][] = [];
    targets.forEach((_, j) => {
      const last = runs.at(-1);
      if (last !== undefined && fits([...last, j])) last.push(j);
      else if (fits([j])) runs.push([j]);
      else failed(j, "INVALID_REQUEST");
    });
    for (const run of runs) {
      if (deadline.aborted) return false;
      const reader = frameReader(bound, perTarget, run.flatMap(sinksOf));
      const s = await runScript(t, submoduleWorkArgs(folder(), phase, bound, run.map((j) => targets[j]!)), reader);
      if (outer.aborted) throw new Stop({ result: "canceled" });
      if ("refused" in s) {
        run.forEach((j) => failed(j, s.refused));
        continue;
      }
      if (s.exit.deadline !== undefined || deadline.aborted) return false;
      const open = run.slice(Math.floor(reader.done / perTarget));
      // Contract §5: the stderr bound ends the run with OUTPUT_LIMIT, as `step` ends a Windows command.
      const code: ErrorCode | null = s.exit.diagnosticLimit ? "OUTPUT_LIMIT" : reader.limited ? "MALFORMED_GIT_OUTPUT" : s.exit.exitCode !== 0 ? "GIT_FAILED" : open.length > 0 ? "MALFORMED_GIT_OUTPUT" : null;
      if (code !== null) open.forEach((j) => failed(j, code));
    }
    return true;
  }

  // Contract Δ3 `readSubmoduleWork` "WSL route": phase a, the step 2 trust check of each target, then phase b. `set` gives a target its result.
  // A target without a result after a deadline gives DEADLINE.
  async function scriptWork(t: InspectionTarget, outer: AbortSignal, deadline: AbortSignal, jobs: readonly { i: number; worktree: string }[], set: (i: number, r: WorkFacts | "programs" | null | { code: ErrorCode }) => void): Promise<void> {
    const listed: { i: number; worktree: string; entries: ConfigEntry[] }[] = [];
    const phaseA = await phaseRuns(
      t,
      outer,
      deadline,
      "a",
      jobs.map((job) => job.worktree),
      (j) => {
        const job = jobs[j]!;
        const top = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
        const config = createCollector({ maxBytes: TRUST_INPUT_BYTES });
        let topExit: number | "limit" = "limit";
        const decide = (exit: number | "limit") => {
          if (topExit === "limit" || top.limited) return set(job.i, { code: "OUTPUT_LIMIT" });
          if (!locatedFrom(topExit, oneLine(top.take()), job.worktree)) return set(job.i, null);
          const entries = configFrom(exit === "limit" || config.limited, exit === "limit" ? null : exit, config.take());
          if (typeof entries === "string") set(job.i, { code: entries });
          else listed.push({ ...job, entries });
        };
        return [
          { out: top, end: (exit) => void (topExit = exit) },
          { out: config, end: decide },
        ];
      },
      (j, code) => set(jobs[j]!.i, { code }),
    );
    if (!phaseA) return;
    const passed: typeof listed = [];
    const queue = [...listed];
    const worker = async () => {
      for (let job = queue.shift(); job !== undefined && !t.signal.aborted; job = queue.shift()) {
        try {
          if (await programsIn(t, job.worktree, job.entries)) set(job.i, "programs");
          else passed.push(job);
        } catch (error) {
          if (!(error instanceof Stop)) throw error;
          if (outer.aborted) throw new Stop({ result: "canceled" });
          const o = error.outcome;
          if (deadline.aborted || o.result === "deadline") continue;
          set(job.i, { code: o.result === "failed" && o.code !== undefined ? o.code : "GIT_FAILED" });
        }
      }
    };
    await Promise.all(Array.from({ length: SUBMODULE_WORK_PARALLEL }, worker));
    if (deadline.aborted || passed.length === 0) return;
    // The workers finish out of order. Phase b takes the targets in page order.
    passed.sort((x, y) => x.i - y.i);
    await phaseRuns(
      t,
      outer,
      deadline,
      "b",
      passed.map((job) => job.worktree),
      (j) => {
        const status = statusFrom(t.workspace.objectFormat);
        return [
          {
            out: status.out,
            end: (exit) => {
              const facts = status.end(exit === "limit" ? null : exit, exit === "limit");
              set(passed[j]!.i, typeof facts === "string" ? { code: facts } : facts);
            },
          },
        ];
      },
      (j, code) => set(passed[j]!.i, { code }),
    );
  }

  async function readSubmoduleWork(
    t: InspectionTarget,
    snapshot: Pick<ChangeSnapshot, "snapshotId" | "indexEntries" | "indexCut" | "completeness"> & { entries: readonly { pathBytes: string }[] },
    // Plan.md D20 rule 2: the `pathBytes` of the `movedGitlink` records of the snapshot.
    moved: ReadonlySet<string>,
    // Contract Δ3 "Pages": the session refuses a page at or above the page count.
    page: number,
  ): Promise<InspectionOutcome> {
    // Contract §5: a cut index listing names no gitlink, so no target list exists.
    if (snapshot.indexCut) return { result: "failed", code: "OUTPUT_LIMIT" };
    const w = t.workspace;
    const forms = pathForms(w, t.installation);
    const root = forms.gitRoot.endsWith("/") ? forms.gitRoot : `${forms.gitRoot}/`;
    const named = (e: IndexEntry) => ({ pathBytes: Buffer.from(e.path).toString("base64"), path: displayPath(e.path) });
    const plan = workPlan(snapshot, moved);
    const positions = plan.positions.slice(page * SUBMODULE_WORK_PAGE, (page + 1) * SUBMODULE_WORK_PAGE);
    const targets = positions.filter((p): p is IndexEntry => typeof p !== "string");
    // Null: plan.md D11 check 4 or 5 failed, so the target gives `not-initialized`, or `not-located` for a moved gitlink.
    const results: (WorkEntry | null | undefined)[] = targets.map(() => undefined);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), readDeadlineMs);
    const signal = AbortSignal.any([t.signal, deadline.signal]);
    const inner: InspectionTarget = { ...t, signal };
    try {
      try {
        await gate(inner);
        const parts = targets.map((e) => componentsOf(e.path));
        const checked = parts.flatMap((p, i) => (p === null ? [] : [{ i, p }]));
        parts.forEach((p, i) => {
          if (p === null) results[i] = { ...named(targets[i]!), state: "unchecked", reason: "failed", code: "SUBMODULE_UNAVAILABLE" };
        });
        // Plan.md D11 check 4 for every target, in requests of at most 64 entries.
        const factList = await facts(inner, checked.flatMap(({ p }) => factsOf(p)));
        const queue = checked.filter(({ i }, k) => {
          let ok: boolean;
          try {
            ok = initialized(factList[2 * k]!, factList[2 * k + 1]!);
          } catch {
            results[i] = { ...named(targets[i]!), state: "unchecked", reason: "failed", code: "REPOSITORY_UNAVAILABLE" };
            return false;
          }
          if (!ok) results[i] = null;
          return ok;
        });
        const entryOf = (i: number, r: WorkFacts | "programs" | null | { code: ErrorCode }): WorkEntry | null => {
          const base = named(targets[i]!);
          if (r === null) return null;
          if (r === "programs") return { ...base, state: "unchecked", reason: "programs" };
          return "code" in r ? { ...base, state: "unchecked", reason: "failed", code: r.code } : { ...base, state: "checked", ...r };
        };
        const worker = async () => {
          for (let job = queue.shift(); job !== undefined && !signal.aborted; job = queue.shift()) {
            const { i, p } = job;
            try {
              results[i] = entryOf(i, await workOf(inner, { worktree: root + p.join("/") }));
            } catch (error) {
              // Any other error ends the read. The abort stops the other workers before they start more Git processes.
              if (!(error instanceof Stop)) {
                deadline.abort();
                throw error;
              }
              if (t.signal.aborted) throw new Stop({ result: "canceled" });
              const o = error.outcome;
              const code: ErrorCode = deadline.signal.aborted || o.result === "deadline" ? "DEADLINE" : o.result === "failed" && o.code !== undefined ? o.code : "GIT_FAILED";
              results[i] = entryOf(i, { code });
            }
          }
        };
        if (w.wsl !== undefined && wslPerTarget !== true) {
          await scriptWork(inner, t.signal, deadline.signal, queue.map(({ i, p }) => ({ i, worktree: root + p.join("/") })), (i, r) => void (results[i] = entryOf(i, r)));
        } else await Promise.all(Array.from({ length: SUBMODULE_WORK_PARALLEL }, worker));
      } catch (error) {
        // A read deadline during the gate or the file facts leaves every target without a result, so each gives DEADLINE below.
        if (!(error instanceof Stop) || t.signal.aborted || !deadline.signal.aborted) throw error;
      }
      if (t.signal.aborted) return { result: "canceled" };
      const entries: WorkEntry[] = [];
      results.forEach((r, i) => {
        if (r === undefined) entries.push({ ...named(targets[i]!), state: "unchecked", reason: "failed", code: "DEADLINE" });
        else entries.push(r ?? { ...named(targets[i]!), state: moved.has(named(targets[i]!).pathBytes) ? "not-located" : "not-initialized" });
      });
      // Plan.md D11 check 3: the unlisted moved gitlinks of the page come after its targets. Each gives `not-located`.
      for (const pathBytes of positions.filter((p): p is string => typeof p === "string")) entries.push({ pathBytes, path: displayPath(Buffer.from(pathBytes, "base64")), state: "not-located" });
      // Spec FR-075: a gitlink with local edits and no parent status record. A cut status listing names no such set.
      const listed = new Set(snapshot.entries.map((e) => e.pathBytes));
      const extraRows =
        snapshot.completeness.state === "complete"
          ? entries.filter((e) => e.state === "checked" && (e.modified || e.untracked) && !listed.has(e.pathBytes)).map(({ pathBytes, path }) => ({ pathBytes, path }))
          : [];
      // Contract Δ3: the gitlinks after the first SUBMODULE_WORK_TARGETS entries are not checked.
      return { result: "succeeded", value: { snapshotId: snapshot.snapshotId, entries, extraRows, limited: plan.limited, next: page + 1 < plan.pages ? page + 1 : null } };
    } catch (error) {
      if (error instanceof Stop) return error.outcome;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return { readSubmoduleChange, readSubmoduleWork };
}

export type SubmoduleReads = ReturnType<typeof createSubmoduleReads>;

// Contract Δ3 `readSubmoduleChange` "Target": the IDs of a workspace row, or null when the row has no gitlink side (plan.md D19 "Old and new IDs").
export function workspaceIds(entry: { category: string; modes?: readonly string[]; oids?: readonly string[] }): Pick<ChangeRequest, "old" | "new"> | null {
  const { modes, oids } = entry;
  if (modes === undefined || oids === undefined || modes.length !== 3 || !modes.includes(GITLINK)) return null;
  if (entry.category === "staged") return { old: sideId(modes[0], oids[0]), new: sideId(modes[1], oids[1]) };
  if (entry.category === "unstaged") return { old: sideId(modes[1], oids[1]), new: modes[2] === GITLINK ? "head" : null };
  return null;
}

// ---- Feature 005 plan.md D20 rule 2: the facts of a moved gitlink (data-model §17) ----

export type GitlinkRead = { value: GitlinkFact } | ReadFailure;
const NOT_LOCATED: GitlinkRead = { value: { refused: "submodule-not-located" } };
// Contract §6 "File facts": a path that is no valid UTF-8 has no components. `workingParts` lets it reach rule 2.
const PATH_REFUSED: GitlinkRead = { value: { refused: "path" } };
const HEAD_FAILED: { code: ErrorCode } = { code: "GIT_FAILED" };

// Rule 2 step 1 (plan.md D11 check 3) on the snapshot index entries.
const gitlinkEntry = (index: readonly IndexEntry[], path: Uint8Array): boolean => oneGitlink(index.filter((e) => Buffer.compare(e.path, path) === 0), path);

// Rule 2 steps 2 to 5 inside the submodule, in the 001 §12 "Review reads" form. These commands load no index and run no filter, hook, or status program.
// The caller runs step 1 first. A checkpoint covers it with the bound index digest.
export async function submoduleHead(runner: GitRunner, t: ReadTarget & { installation: Pick<ReadInstallation, "selectedPath"> }, path: Uint8Array): Promise<GitlinkRead> {
  const parts = componentsOf(path);
  if (parts === null) return PATH_REFUSED;
  const facts = await requestFacts(runner, t.operationId, t.workspace, false, [{ root: "worktreeRoot", path: parts }, { root: "worktreeRoot", path: [...parts, ".git"] }], t.signal);
  if (t.signal.aborted) return { stop: "canceled" };
  if (!Array.isArray(facts)) return facts;
  const initialized = initializedFacts(facts[0]!, facts[1]!);
  if (initialized === null) return { code: "REPOSITORY_UNAVAILABLE" };
  if (!initialized) return NOT_LOCATED;
  const gitRoot = pathForms(t.workspace, t.installation).gitRoot;
  const location = { worktree: (gitRoot.endsWith("/") ? gitRoot : `${gitRoot}/`) + parts.join("/") };
  const run = (args: string[]) => lineOf(runner, t, args);
  const top = await locatedFact(runner, t, location);
  if (top !== true) return top === false ? NOT_LOCATED : top;
  const head = await run(submoduleHeadOidArgs(location));
  if (!("exit" in head)) return head;
  if (head.exit.exitCode === 0) {
    const id = headId(head, t.workspace.objectFormat);
    return id === null ? HEAD_FAILED : { value: { head: id } };
  }
  // A process stopped at the output bound has no exit status.
  if (head.exit.exitCode === null) return HEAD_FAILED;
  // Rule 2 step 5, as the parent HEAD capture does: a symbolic HEAD whose reference is missing names no commit.
  const symbolic = await run(submoduleHeadTargetArgs(location));
  if (!("exit" in symbolic)) return symbolic;
  if (symbolic.exit.exitCode !== 0 || symbolic.line === null || !isOneLevelRefName(symbolic.line)) return HEAD_FAILED;
  const exists = await run(submoduleRefExistsArgs(location, symbolic.line));
  if (!("exit" in exists)) return exists;
  // git-show-ref(1) `--exists`: exit 2 means that the reference is missing.
  return exists.exit.exitCode === 2 ? { value: { refused: "submodule-unborn" } } : HEAD_FAILED;
}

// Rule 2 steps 1 to 5 for a decision. Contract §5: a cut index listing names no entry, so the read refuses with OUTPUT_LIMIT, as `readSubmoduleChange` does.
export const gitlinkFact = (runner: GitRunner, t: Parameters<typeof submoduleHead>[1], snapshot: Pick<ChangeSnapshot, "indexEntries" | "indexCut">, path: Uint8Array): Promise<GitlinkRead> =>
  snapshot.indexCut ? Promise.resolve({ code: "OUTPUT_LIMIT" }) : gitlinkEntry(snapshot.indexEntries, path) ? submoduleHead(runner, t, path) : Promise.resolve(NOT_LOCATED);
