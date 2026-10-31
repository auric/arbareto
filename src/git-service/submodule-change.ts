// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 005 contract Δ3 `readSubmoduleChange` and `readSubmoduleWork`, Δ5 bounds, Δ12, data-model §15 and §16, plan.md D19, research.md R18.
// Inside a submodule, these reads start only the `submodule*Args` commands of `commands.ts`, in the form `-C <worktree> --git-dir=.git`.

import type { FileFact } from "../contracts/channel";
import type { ErrorCode } from "../contracts/errors";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, SUBMODULE_CHANGE_COMMITS, SUBMODULE_CHANGE_OUTPUT_BYTES, SUBMODULE_GITMODULES_BYTES, SUBMODULE_WORK_PARALLEL, SUBMODULE_WORK_TARGETS, TRUST_INPUT_BYTES } from "../contracts/limits";
import { both, fail, Stop, CLOSED, type InspectionOutcome, type InspectionTarget } from "./commit-changes";
import {
  isObjectId,
  objectCheckArgs,
  submoduleCommitExistsArgs,
  submoduleConfigListArgs,
  submoduleCountArgs,
  submoduleHeadOidArgs,
  submoduleLogArgs,
  submoduleStatusArgs,
  submoduleToplevelArgs,
  OID_HEX,
  type SubmoduleLocation,
} from "./commands";
import { createCollector, exitKind, type Collector, type GitExit, type GitRunner } from "./git-runner";
import { latin1, runRead, strictUtf8 } from "./read-steps";
import type { ChangeSnapshot, IndexEntry } from "./snapshot";
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

export interface SubmoduleReadsOptions {
  runner: GitRunner;
  trust: Trust;
  environment: ServiceEnvironment;
  // Contract Δ3 `readSubmoduleWork`: the 001 read deadline of the whole read.
  readDeadlineMs: number;
}

export function createSubmoduleReads({ runner, trust, environment, readDeadlineMs }: SubmoduleReadsOptions) {
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
  // Plan.md D11 check 4: a folder and a `.git` file or folder, no link. A file fact error fails the read.
  const initialized = (folder: FileFact, git: FileFact): boolean => {
    if (folder.kind === "error" || git.kind === "error") throw fail("REPOSITORY_UNAVAILABLE");
    return folder.kind === "directory" && (git.kind === "file" || git.kind === "directory");
  };
  const factsOf = (parts: readonly string[]): FactEntry[] => [
    { root: "worktreeRoot", path: [...parts] },
    { root: "worktreeRoot", path: [...parts, ".git"] },
  ];

  // Plan.md D11 check 5 for a read: the worktree root that Git prints for `--git-dir=.git` is the folder. False: the check fails.
  async function located(t: InspectionTarget, location: { worktree: string }): Promise<boolean> {
    const out = small();
    const exit = await step(t, submoduleToplevelArgs(location), out);
    return exit.exitCode === 0 && !out.limited && oneLine(out.take()) === location.worktree;
  }

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

  // `log -z --format=%H%x00%s`: object ID, NUL, subject bytes, NUL per commit. `limited`: the output bound cut the list after its whole records.
  async function commitsOf(t: InspectionTarget, location: SubmoduleLocation, include: string, exclude: string, count: number) {
    if (count === 0) return { commits: [] as { oid: string; subject: string }[], limited: false };
    const out = createCollector({ maxBytes: SUBMODULE_CHANGE_OUTPUT_BYTES });
    const exit = await step(t, submoduleLogArgs(location, include, exclude, t.workspace.objectFormat, SUBMODULE_CHANGE_COMMITS), out);
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
      const kind = await kindOf(t, request.path, exists(fileFacts[0]!, 1), index);
      if (!needLocation) return { result: "succeeded", value: value(kind, { state: "single" }) };

      const at = records === null ? request.index!.filter((e) => Buffer.from(e.path).equals(request.path)) : records[1];
      const one = at !== null && at.length === 1 ? at[0]! : null;
      const checkThree = one !== null && one.stage === 0 && one.mode === GITLINK && Buffer.from(one.path).equals(request.path);
      const location = { worktree };
      if (!(checkThree && initialized(fileFacts[1]!, fileFacts[2]!) && (await located(t, location)))) return { result: "succeeded", value: value(kind, { state: "not-initialized" }) };

      if (next === "head") {
        const out = small();
        const exit = await step(t, submoduleHeadOidArgs(location), out);
        const head = exit.exitCode === 0 && !out.limited ? oneLine(out.take()) : null;
        if (head === null || !isObjectId(head, fmt)) return { result: "failed", code: "GIT_FAILED" };
        next = head;
      }
      if (old === null || next === null) return { result: "succeeded", value: value(kind, { state: "single" }) };
      const [o, n] = [old, next];

      // git-cat-file(1) `-e`: a non-zero exit means that the commit is not present. No command fetches.
      const present = async (oid: string) => (await step(t, submoduleCommitExistsArgs(location, oid, fmt), small())).exitCode === 0;
      const [hasOld, hasNew] = await both(present(o), present(n));
      if (!hasOld || !hasNew) return { result: "succeeded", value: value(kind, { state: "missing", which: !hasOld && !hasNew ? "both" : hasOld ? "new" : "old" }) };

      const countOut = small();
      const counted = await step(t, submoduleCountArgs(location, o, n, fmt), countOut);
      if (counted.exitCode !== 0) return { result: "failed", code: "GIT_FAILED" };
      const counts = countOut.limited ? null : /^([0-9]+)\t([0-9]+)\n$/.exec(latin1(countOut.take()));
      if (counts === null || !Number.isSafeInteger(Number(counts[1])) || !Number.isSafeInteger(Number(counts[2]))) return { result: "failed", code: "MALFORMED_GIT_OUTPUT" };
      // git-rev-list(1): for `<old>...<new>`, left counts the commits only in `<old>`, right the commits only in `<new>`.
      const removed = Number(counts[1]);
      const added = Number(counts[2]);
      const [addedList, removedList] = await both(commitsOf(t, location, n, o, added), commitsOf(t, location, o, n, removed));
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
    | { state: "not-initialized" }
    | { state: "unchecked"; reason: "programs" }
    | { state: "unchecked"; reason: "failed"; code: ErrorCode }
  );

  // Contract Δ3 `readSubmoduleWork` step 1 check 5 and steps 2 and 3 for one target. Null: the target is not initialized.
  async function workOf(t: InspectionTarget, location: { worktree: string }): Promise<{ modified: boolean; untracked: boolean } | "programs" | null> {
    const config = createCollector({ maxBytes: TRUST_INPUT_BYTES });
    // Both commands load no index and run no program, so the listing runs beside the location check.
    const [here, listedExit] = await both(located(t, location), step(t, submoduleConfigListArgs(location), config));
    if (!here) return null;
    if (config.limited) throw fail("OUTPUT_LIMIT");
    if (listedExit.exitCode !== 0) throw fail("GIT_FAILED");
    const entries = parseConfigListing(config.take(), false);
    if (entries === null) throw fail("MALFORMED_GIT_OUTPUT");
    // 001 §12 "Submodule programs": every local and worktree entry of a submodule is repository-controlled. The 001 §7 rule decides the other scopes.
    const listing = await listSubmoduleTrust(runner, { operationId: t.operationId, signal: t.signal, workspace: t.workspace }, environment, statusProgramEntries(entries), null, { root: location.worktree, gitDirectory: null });
    if (t.signal.aborted) throw new Stop({ result: "canceled" });
    if (!listing.ok) throw new Stop("stop" in listing ? { result: listing.stop } : { result: "failed", code: listing.code });
    if (listing.listing.integrations.some((i) => i.repositoryControlled && statusProgram(i.key))) return "programs";

    let modified = false;
    let untracked = false;
    const parser = createStatusParser(t.workspace.objectFormat, false, (record) => {
      if (record.kind === "untracked") untracked = true;
      else if (record.kind !== "ignored") modified = true;
    });
    let size = 0;
    // A `limited` collector stops its process (contract §6 "Byte caps"). Both facts, or a status bound, end the status.
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
    const exit = await step(t, submoduleStatusArgs(location), out);
    if (modified && untracked) return { modified, untracked };
    if (parser.limited) throw fail("OUTPUT_LIMIT");
    if (exit.exitCode !== 0) throw fail("GIT_FAILED");
    if (parser.end().state !== "complete") throw fail("MALFORMED_GIT_OUTPUT");
    return { modified, untracked };
  }

  async function readSubmoduleWork(
    t: InspectionTarget,
    snapshot: Pick<ChangeSnapshot, "snapshotId" | "indexEntries" | "indexCut" | "completeness"> & { entries: readonly { pathBytes: string }[] },
  ): Promise<InspectionOutcome> {
    // Contract §5: a cut index listing names no gitlink, so no target list exists.
    if (snapshot.indexCut) return { result: "failed", code: "OUTPUT_LIMIT" };
    const w = t.workspace;
    const forms = pathForms(w, t.installation);
    const root = forms.gitRoot.endsWith("/") ? forms.gitRoot : `${forms.gitRoot}/`;
    const gitlinks = snapshot.indexEntries.filter((e) => e.stage === 0 && e.mode === GITLINK);
    const named = (e: IndexEntry) => ({ pathBytes: Buffer.from(e.path).toString("base64"), path: displayPath(e.path) });
    const targets = gitlinks.slice(0, SUBMODULE_WORK_TARGETS);
    // Null: plan.md D11 check 4 or 5 failed, so the target gives `not-initialized`.
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
        const worker = async () => {
          for (let job = queue.shift(); job !== undefined && !signal.aborted; job = queue.shift()) {
            const { i, p } = job;
            const base = named(targets[i]!);
            try {
              const work = await workOf(inner, { worktree: root + p.join("/") });
              results[i] = work === null ? null : work === "programs" ? { ...base, state: "unchecked", reason: "programs" } : { ...base, state: "checked", ...work };
            } catch (error) {
              // Any other error ends the read. The abort stops the other workers before they start more Git processes.
              if (!(error instanceof Stop)) {
                deadline.abort();
                throw error;
              }
              if (t.signal.aborted) throw new Stop({ result: "canceled" });
              const o = error.outcome;
              const code: ErrorCode = deadline.signal.aborted || o.result === "deadline" ? "DEADLINE" : o.result === "failed" && o.code !== undefined ? o.code : "GIT_FAILED";
              results[i] = { ...base, state: "unchecked", reason: "failed", code };
            }
          }
        };
        await Promise.all(Array.from({ length: SUBMODULE_WORK_PARALLEL }, worker));
      } catch (error) {
        // A read deadline during the gate or the file facts leaves every target without a result, so each gives DEADLINE below.
        if (!(error instanceof Stop) || t.signal.aborted || !deadline.signal.aborted) throw error;
      }
      if (t.signal.aborted) return { result: "canceled" };
      const entries: WorkEntry[] = [];
      results.forEach((r, i) => {
        if (r === undefined) entries.push({ ...named(targets[i]!), state: "unchecked", reason: "failed", code: "DEADLINE" });
        else entries.push(r ?? { ...named(targets[i]!), state: "not-initialized" });
      });
      // Spec FR-075: a gitlink with local edits and no parent status record. A cut status listing names no such set.
      const listed = new Set(snapshot.entries.map((e) => e.pathBytes));
      const extraRows =
        snapshot.completeness.state === "complete"
          ? entries.filter((e) => e.state === "checked" && (e.modified || e.untracked) && !listed.has(e.pathBytes)).map(({ pathBytes, path }) => ({ pathBytes, path }))
          : [];
      // Contract Δ3: the gitlinks after the first SUBMODULE_WORK_TARGETS in index order are not checked.
      return { result: "succeeded", value: { snapshotId: snapshot.snapshotId, entries, extraRows, limited: gitlinks.length - targets.length } };
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
