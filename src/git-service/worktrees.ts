// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `readWorktrees`, `openWorktree`, and the `reviewWorkbench` actions `worktree-add`, `worktree-remove`, and `worktree-prune`.
// Plan.md D10, data-model §2 and §8, and spec FR-049 to FR-057. Git's own refusal stays the second guard of each step.

import { IdentityReply } from "../contracts/channel";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, IDENTITY_PATHS, STATUS_LISTING_BYTES, STATUS_LISTING_RECORDS, WINDOWS_COMMAND_LINE_UNITS } from "../contracts/limits";
import { wslIdentityPath } from "../contracts/wsl-route";
import { deleteFacts, deleteSteps, nameRefusal, newName, type DeleteFacts } from "./branch-ops";
import { isObjectId, isRefName, type ObjectFormat } from "./commands";
import { RunnerRefusal, stepUnits, type EnvironmentPolicy, type GitRunner, type ProcessContext, type SyncRunner } from "./git-runner";
import { stepOf, type Fact, type ObserveContext } from "./hunk-publish";
import { NO_FILE, sameIdentity, type PhysicalIdentity } from "./identity";
import { contextOf, latin1, strictUtf8 } from "./read-steps";
import type { Workspace } from "./registration";
import { changedRefs, changes } from "./sync";
import { observe } from "./sync-integrate";
import { readOut, refKey } from "./sync-review";
import { refCommit } from "./switch";
import { worktreeAddExistingArgs, worktreeAddNewArgs, worktreeAddTrackArgs, worktreeIndexArgs, worktreeLayoutArgs, worktreePruneArgs, worktreeRemoveArgs, worktreeStatusArgs } from "./workbench-commands";
import { parseWorktreeStatus, trackingRemotes, type WorktreeRecord } from "./workbench-parsers";
import { conclude, heldElsewhere, killed, readWorktrees, refTarget, registerWorkbenchAction, unavailable, type PayloadOf, type Refused, type StepEnd, type WorkbenchRun } from "./workbench-review";

const HEADS = "refs/heads/";
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

// ---- Identities (plan.md D10, 001 contract §6 identity request) ----

// Only `absent` proves a missing path. Any other refusal refuses the read (001 contract §6 "Process fields").
type Located = PhysicalIdentity | "absent";

// A record path in its identity request form. A WSL record holds a Linux path (contract Δ11). Null: the text is not the exact path.
function identityPath(ctx: ObserveContext, r: WorktreeRecord): string | null {
  if (r.invalidUtf8) return null;
  const wsl = ctx.workspace.wsl;
  return wsl === undefined ? r.path : wslIdentityPath(wsl.distro, r.path);
}

function located(reply: unknown, ctx: ObserveContext): Located | null {
  const parsed = IdentityReply.safeParse(reply);
  if (!parsed.success) return null;
  const r = parsed.data;
  const wsl = ctx.workspace.wsl;
  if ("code" in r) return r.reason === "absent" ? "absent" : null;
  if ("fileId" in r) return wsl === undefined && !NO_FILE.test(r.fileId) ? r : null;
  return wsl !== undefined && r.distroGuid === wsl.guid ? r : null;
}

async function identities(ctx: ObserveContext, context: ProcessContext, paths: readonly string[]): Promise<Fact<Located[]>> {
  const found: Located[] = [];
  for (let i = 0; i < paths.length; i += IDENTITY_PATHS) {
    const batch = paths.slice(i, i + IDENTITY_PATHS);
    let replies;
    try {
      replies = await ctx.runner.identities(ctx.operationId, context, batch, ctx.signal);
    } catch (error) {
      if (error instanceof RunnerRefusal) return { code: error.code };
      return ctx.signal.aborted ? { stop: "canceled" } : { code: "GIT_FAILED" };
    }
    if (!Array.isArray(replies)) return { stop: replies.stop };
    if (replies.length !== batch.length) return { code: "UNSUPPORTED_REPOSITORY" };
    for (const reply of replies) {
      const one = located(reply, ctx);
      if (one === null) return { code: "UNSUPPORTED_REPOSITORY" };
      found.push(one);
    }
  }
  return { value: found };
}

async function locate(ctx: ObserveContext, records: readonly WorktreeRecord[]): Promise<Fact<Located[]>> {
  const paths = records.map((r) => identityPath(ctx, r));
  if (paths.some((p) => p === null)) return { code: "UNSUPPORTED_REPOSITORY" };
  return identities(ctx, contextOf(ctx.workspace), paths as string[]);
}

// Plan.md D10: the current record has the identity of the workspace worktree root.
const isCurrent = (ctx: ObserveContext, id: Located): boolean => id !== "absent" && sameIdentity(id, ctx.workspace.worktreeIdentity[0]);

// ---- readWorktrees and openWorktree (contract Δ3) ----

// Data-model §8. `branchKey` stays in the service.
export type WorktreeEntry = Omit<WorktreeRecord, "branchKey"> & { current: boolean };

const entryOf = ({ branchKey: _key, ...r }: WorktreeRecord, current: boolean): WorktreeEntry => ({ ...r, current });

export async function readWorktreeList(ctx: ObserveContext): Promise<Fact<{ entries: WorktreeEntry[]; digest: string }>> {
  const list = await readWorktrees(ctx);
  if (!("value" in list)) return list;
  const ids = await locate(ctx, list.value.records);
  if (!("value" in ids)) return ids;
  return { value: { entries: list.value.records.map((r, i) => entryOf(r, isCurrent(ctx, ids.value[i]!))), digest: list.value.digest } };
}

// The shell bound `path` in `context`, and `path` is its identity request form. The 001 registration flow with the same `bootstrapId` follows (spec FR-051).
export async function openWorktreeTarget(ctx: ObserveContext, bound: { context: ProcessContext; path: string }): Promise<Fact<WorktreeEntry> | Refused> {
  const target = await identities(ctx, bound.context, [bound.path]);
  if (!("value" in target)) return target;
  const id = target.value[0]!;
  if (id === "absent") return { refused: "UNKNOWN_TARGET" };
  const list = await readWorktrees(ctx);
  if (!("value" in list)) return list;
  const ids = await locate(ctx, list.value.records);
  if (!("value" in ids)) return ids;
  const at = ids.value.findIndex((x) => x !== "absent" && sameIdentity(x, id));
  return at < 0 ? { refused: "UNKNOWN_TARGET" } : { value: entryOf(list.value.records[at]!, isCurrent(ctx, ids.value[at]!)) };
}

// ---- Shared steps ----

// Contract §6 command-line bound under the measure of the route.
const fits = (ctx: ObserveContext, policy: EnvironmentPolicy, args: string[]) => stepUnits(ctx, policy, args) <= WINDOWS_COMMAND_LINE_UNITS;

// Contract Δ3 `runWorkbench` step 4 with the worktree list. `took`: the fresh list shows the worktree effect of the action.
async function settle(r: WorkbenchRun, action: string, ends: StepEnd[], expect: { refs: Map<string, string>; done: boolean; took: (after: readonly WorktreeRecord[]) => boolean }): Promise<void> {
  const settled = await r.reconcile(ends);
  if (settled === null) return r.unknown({ code: "GIT_FAILED" }, { action });
  const o = await observe(r.q, killed(ends));
  if (!("value" in o)) return r.unknown(o, { action });
  const list = await readWorktrees(r.q);
  if (!("value" in list)) return r.unknown(list, { action });
  const { refs, head, state, lock } = o.value;
  const took = expect.took(list.value.records);
  const result = { action, head, refs: changedRefs(r.before.refs, refs) };
  const same = Bun.deepEquals(head, r.common.head, true) && state === r.common.operationState;
  conclude(
    r,
    {
      done: expect.done && ends.every((end) => end.exit?.exitCode === 0),
      intended: took && !lock && changes(expect.refs, refs).length === 0 && same,
      changed: took || lock || result.refs.length > 0 || !same,
      canceled: settled.canceled,
      failed: ends.find((end) => end.exit?.exitCode !== 0) ?? null,
    },
    result,
  );
}

// ---- Add worktree (contract Δ3 `worktree-add`, Δ6 `worktreeAdd`) ----

interface AddBound {
  // The bound path in Git's form for the route (contract Δ6).
  path: string;
  destination: "absent" | "empty";
  oid: string;
}

// Research.md R21 F17: `worktree add` checks out a branch only for its short name.
function addArgs(p: PayloadOf<"worktree-add">, path: string, objectFormat: ObjectFormat): string[] {
  const b = p.branch;
  if ("track" in b) return worktreeAddTrackArgs(b.track.name, path, b.track.ref);
  return "existing" in b ? worktreeAddExistingArgs(path, b.existing.slice(HEADS.length)) : worktreeAddNewArgs(b.new, path, b.start, objectFormat);
}

// Contract Δ3: `absent` or `empty` passes. An `error` reply is no destination type, so it gives REPOSITORY_UNAVAILABLE with the path, as feature 003 `clone` step 2 does.
// Every other reply gives DESTINATION_NOT_EMPTY with its result as the reason.
async function destination(ctx: ObserveContext, bootstrapId: string): Promise<Fact<Omit<AddBound, "oid">> | Refused> {
  // `session.ts` gives the workbench its full runner, which also serves the feature 003 private requests.
  const runner = ctx.runner as GitRunner & Pick<SyncRunner, "destinationFacts">;
  let facts;
  try {
    facts = await runner.destinationFacts({ operationId: ctx.operationId, bootstrapId });
  } catch (error) {
    if (error instanceof RunnerRefusal) return { refused: error.code };
    return ctx.signal.aborted ? { stop: "canceled" } : { code: "GIT_FAILED" };
  }
  if (!("path" in facts)) return { code: "GIT_FAILED" };
  if (facts.result === "absent" || facts.result === "empty") return { value: { path: facts.path, destination: facts.result } };
  return facts.result === "error" ? { refused: "REPOSITORY_UNAVAILABLE", result: { path: facts.path } } : { refused: "DESTINATION_NOT_EMPTY", result: { reason: facts.result } };
}

registerWorkbenchAction<"worktree-add", AddBound>("worktree-add", {
  // Plan.md D4 and D10: Git reads `worktree add -- <path> @` as the branch `@` (research.md R21 F29), so `@` refuses before any Git process.
  precheck(p, w) {
    const b = p.branch;
    if ("existing" in b) return b.existing === `${HEADS}@` ? unavailable("reserved-name") : null;
    if ("track" in b) return nameRefusal(b.track.name) ?? (isRefName(b.track.ref) ? null : { refused: "INVALID_REQUEST" });
    return nameRefusal(b.new) ?? (isObjectId(b.start, w.objectFormat) ? null : { refused: "INVALID_REQUEST" });
  },
  async observe(ctx, p, common) {
    const b = p.branch;
    let oid: string;
    if ("existing" in b) {
      const tip = await refTarget(ctx, b.existing);
      if (!("value" in tip)) return tip;
      const list = await readWorktrees(ctx);
      if (!("value" in list)) return list;
      // FR-052: Git checks out a branch in one worktree only, also for a prunable record (builtin/worktree.c `die_if_checked_out`).
      if (common.head.state !== "detached" && common.head.target === b.existing) return unavailable("current-branch");
      const held = heldElsewhere(list.value.records, b.existing, common.head);
      if (held !== null) return held;
      oid = tip.value;
    } else if ("track" in b) {
      // Plan.md D3 Track rule. Git's own `branch --track` step refuses the other remote counts with exit 255 (research.md R13).
      const remotes = trackingRemotes(b.track.ref, common.listing.entries, ctx.workspace.objectFormat);
      if (remotes === null || remotes.length === 0) return unavailable("no-tracking-refspec");
      if (remotes.length > 1) return unavailable("several-tracking-remotes", { remotes });
      const fresh = await newName(ctx, b.track.name);
      if (!("value" in fresh)) return fresh;
      const start = await refCommit(ctx, b.track.ref);
      if (!("value" in start)) return start;
      oid = start.value;
    } else {
      const fresh = await newName(ctx, b.new);
      if (!("value" in fresh)) return fresh;
      oid = b.start;
    }
    const dest = await destination(ctx, p.bootstrapId);
    if (!("value" in dest)) return dest;
    if (!fits(ctx, "integrate", addArgs(p, dest.value.path, ctx.workspace.objectFormat))) return unavailable("limit");
    const branch = "existing" in b ? { existing: b.existing, oid } : "track" in b ? { track: b.track, oid } : { new: b.new, start: b.start };
    return { bound: { ...dest.value, oid }, plan: { branch, ...dest.value } };
  },
  started: () => "worktree-add",
  async run(r, p, b) {
    const w = r.ctx.workspace;
    const context: ProcessContext = { contextKind: "worktreeAdd", gitInstallationId: w.gitInstallationId, repositoryId: w.repositoryId, bootstrapId: p.bootstrapId };
    const end = await r.step(addArgs(p, b.path, w.objectFormat), "worktree", { context });
    const pb = p.branch;
    const ref = "existing" in pb ? pb.existing : `${HEADS}${"track" in pb ? pb.track.name : pb.new}`;
    const refs = new Map(r.before.refs);
    if (!("existing" in p.branch)) refs.set(refKey(ref), b.oid);
    // Git prints its own form of the new path, so the record that holds the branch at the bound commit shows the add.
    await settle(r, "worktree-add", [end], { refs, done: true, took: (after) => after.some((x) => x.branchKey === refKey(ref) && x.head === b.oid) });
  },
});

// ---- Remove worktree (contract Δ3 `worktree-remove`, spec FR-054 to FR-056) ----

interface RemoveBound {
  record: WorktreeRecord;
  // The SHA-256 of the status listing of that worktree.
  status: string;
  force: boolean;
  branch: DeleteFacts | null;
  // Plan.md O-20: the class flag and the fingerprint of the listing of that worktree.
  trust: { required: boolean; fingerprint: string };
  submodules: boolean;
}

// Plan.md O-20 and D12 "Other worktrees": Git runs the clean filter and `core.fsmonitor` of that worktree for `-C <path> status` and `worktree remove`
// (research.md R21 F18). So both take the class `workbench` of its own listing and its own trust state. Git names its folders.
// A top level or a common folder with another identity is no worktree of this repository. The contract names no reason, so it gives UNKNOWN_TARGET.
// `folders`: the top level and the administration folder as Git printed them.
async function targetTrust(ctx: ObserveContext, record: WorktreeRecord, root: Located): Promise<Fact<{ trust: RemoveBound["trust"]; folders: { top: string; admin: string } }> | Refused> {
  const w = ctx.workspace;
  if (root === "absent") return { refused: "UNKNOWN_TARGET" };
  const read = await readOut(ctx, worktreeLayoutArgs(record.path), DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if ("limited" in read) return { code: "MALFORMED_GIT_OUTPUT" };
  if (!("value" in read)) return read;
  let lines: string[];
  try {
    lines = strictUtf8.decode(read.value).split("\n");
  } catch {
    return { code: "UNSUPPORTED_REPOSITORY" };
  }
  if (lines.length !== 4 || lines[3] !== "" || lines.slice(0, 3).some((line) => line === "")) return { code: "MALFORMED_GIT_OUTPUT" };
  // Contract §11: Linux Git prints Linux paths, and the workspace roots are their UNC identity forms.
  const forms = lines.slice(0, 3).map((path) => (w.wsl === undefined ? path : path.startsWith("/") ? wslIdentityPath(w.wsl.distro, path) : null));
  if (forms.some((path) => path === null)) return { code: "UNSUPPORTED_REPOSITORY" };
  const [top, admin, common] = forms as [string, string, string];
  const ids = await identities(ctx, contextOf(w), [top, admin, common]);
  if (!("value" in ids)) return ids;
  const [topId, adminId, commonId] = ids.value as [Located, Located, Located];
  if (topId === "absent" || adminId === "absent" || commonId === "absent" || !sameIdentity(topId, root) || !sameIdentity(commonId, w.commonIdentity)) return { refused: "UNKNOWN_TARGET" };
  const target: Workspace = { ...w, worktreeRoot: top, gitDirectory: admin, worktreeIdentity: [topId, adminId] };
  const listed = await ctx.trust.listTrust({ operationId: ctx.operationId, signal: ctx.signal, workspace: target, at: record.path });
  if (!listed.ok) return "stop" in listed ? { stop: listed.stop } : { code: listed.code };
  const gate = ctx.trust.gate(target, listed.listing, ctx.installation, "workbench");
  if (gate !== null) return { refused: gate, result: { trustGate: "target" } };
  return { value: { trust: { required: listed.listing.approvalRequired.workbench, fingerprint: listed.listing.fingerprint }, folders: { top: lines[0]!, admin: lines[1]! } } };
}

// git-ls-files(1) `--stage -z`: `<mode> SP <object> SP <stage> TAB <path> NUL`. Mode 160000 is a gitlink (gitformat-index(5)).
// The stream keeps only gitlink paths, within STATUS_LISTING_RECORDS records and STATUS_LISTING_BYTES path bytes. Other paths are counted, not kept.
// A record that breaks the form sets `broken`. A broken record or a reached bound sets `limited`, and that stops Git.
export function gitlinkStream(objectFormat: ObjectFormat) {
  const NUL = 0;
  const width = 6 + 1 + (objectFormat === "sha1" ? 40 : 64) + 1 + 1 + 1;
  // A path that is no valid UTF-8 gives null.
  const paths: (string | null)[] = [];
  let header: number[] = [];
  let inPath = false;
  let pathBytes = 0;
  let kept: Uint8Array[] | null = null;
  let keptBytes = 0;
  let bytes = 0;
  let broken = false;
  let bound: "STATUS_LISTING_BYTES" | "STATUS_LISTING_RECORDS" | null = null;
  return {
    push(chunk: Uint8Array): void {
      bytes += chunk.length;
      for (let at = 0; at < chunk.length && !broken && bound === null; ) {
        if (!inPath) {
          const end = Math.min(chunk.length, at + width - header.length);
          for (; at < end; at++) {
            if (chunk[at] === NUL) return void (broken = true);
            header.push(chunk[at]!);
          }
          if (header.length < width) return;
          const m = /^([0-7]{6}) ([0-9a-f]+) [0-3]\t$/.exec(latin1(Uint8Array.from(header)));
          if (m === null || !isObjectId(m[2]!, objectFormat)) return void (broken = true);
          inPath = true;
          pathBytes = 0;
          kept = m[1] === "160000" ? [] : null;
          continue;
        }
        const nul = chunk.indexOf(NUL, at);
        const end = nul === -1 ? chunk.length : nul;
        pathBytes += end - at;
        if (kept !== null && end > at) {
          keptBytes += end - at;
          if (keptBytes > STATUS_LISTING_BYTES) return void (bound = "STATUS_LISTING_BYTES");
          kept.push(new Uint8Array(chunk.subarray(at, end)));
        }
        if (nul === -1) return;
        at = nul + 1;
        if (pathBytes === 0) return void (broken = true);
        if (kept !== null) {
          if (paths.length >= STATUS_LISTING_RECORDS) return void (bound = "STATUS_LISTING_RECORDS");
          try {
            paths.push(strictUtf8.decode(Buffer.concat(kept)));
          } catch {
            paths.push(null);
          }
        }
        inPath = false;
        header = [];
        kept = null;
      }
    },
    get bytes() {
      return bytes;
    },
    records: 0,
    get limited() {
      return broken || bound !== null;
    },
    get bound() {
      return bound;
    },
    get broken() {
      return broken;
    },
    // A partial record at the end of the stream.
    get partial() {
      return inPath || header.length > 0;
    },
    paths,
  };
}

// git-worktree(1): a worktree with submodules needs `--force`. builtin/worktree.c `validate_no_submodules` refuses when `<administration folder>/modules`
// is a folder, or when a gitlink of that index holds a populated submodule (`is_submodule_populated_gently`: `<gitlink>/.git`).
// Any existing entry counts, and so does a path without an identity form. So these facts hold Git's check, and the box comes first.
async function submodulesOf(ctx: ObserveContext, record: WorktreeRecord, folders: { top: string; admin: string }): Promise<Fact<boolean>> {
  const w = ctx.workspace;
  const out = gitlinkStream(w.objectFormat);
  const step = await stepOf(ctx, worktreeIndexArgs(record.path), out);
  if (!("exit" in step)) return step;
  if (out.bound !== null) return { code: "OUTPUT_LIMIT", reason: out.bound };
  if (out.broken) return { code: "MALFORMED_GIT_OUTPUT" };
  if (step.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  if (out.partial) return { code: "MALFORMED_GIT_OUTPUT" };
  const paths = [`${folders.admin}/modules`, ...out.paths.map((path) => (path === null ? null : `${folders.top}/${path}/.git`))];
  // Contract §11: an identity request names the UNC form of a Linux path.
  const forms = paths.map((path) => (path === null ? null : w.wsl === undefined ? path : wslIdentityPath(w.wsl.distro, path)));
  if (forms.some((path) => path === null)) return { value: true };
  const ids = await identities(ctx, contextOf(w), forms as string[]);
  if (!("value" in ids)) return ids;
  return { value: ids.value.some((id) => id !== "absent") };
}

// Plan.md D10: the status of that worktree with `-C <path>`.
async function statusOf(ctx: ObserveContext, args: string[]): Promise<Fact<{ tracked: number; untracked: number; digest: string }>> {
  const read = await readOut(ctx, args, STATUS_LISTING_BYTES);
  if ("limited" in read) return { code: "OUTPUT_LIMIT", reason: "STATUS_LISTING_BYTES" };
  if (!("value" in read)) return read;
  const counts = parseWorktreeStatus(read.value, ctx.workspace.objectFormat);
  return counts === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: { ...counts, digest: sha256(read.value) } };
}

registerWorkbenchAction<"worktree-remove", RemoveBound>("worktree-remove", {
  async observe(ctx, p, common) {
    const list = await readWorktrees(ctx);
    if (!("value" in list)) return list;
    const records = list.value.records;
    // Contract Δ11: the service matches the path text with a fresh list.
    const record = records.find((r) => r.path === p.worktree && !r.invalidUtf8);
    if (record === undefined) return { refused: "UNKNOWN_TARGET" };
    if (record.main) return unavailable("main-worktree");
    const id = await locate(ctx, [record]);
    if (!("value" in id)) return id;
    if (isCurrent(ctx, id.value[0]!)) return unavailable("current-worktree");
    // git-worktree(1) `remove`: a locked worktree needs `--force` twice, and the app passes it once at most.
    if (record.locked !== null) return unavailable("locked");
    // The list marks a record prunable when its folder is missing, so no read can run in it. Prune removes the record.
    if (record.prunable !== null) return unavailable("prunable");
    const statusArgs = worktreeStatusArgs(record.path);
    // Plan.md O-20: the reads in that worktree. The layout read is the longest read of its trust listing.
    const fitting = [statusArgs, worktreeLayoutArgs(record.path), worktreeIndexArgs(record.path)].every((args) => fits(ctx, "read", args)) && fits(ctx, "integrate", worktreeRemoveArgs(record.path, true));
    if (!fitting) return unavailable("limit");
    let branch: DeleteFacts | null = null;
    if (p.deleteBranch) {
      const ref = record.branch;
      // Data-model §8: Git names no branch for a `headUnresolved` record.
      if (ref === null) return record.headUnresolved ? unavailable("head-unresolved", { worktree: record.path }) : unavailable("detached");
      // Plan.md D4: another worktree must not hold the branch. The removal releases the branch of this record only.
      if (common.head.state !== "detached" && common.head.target === ref) return unavailable("current-branch");
      const other = heldElsewhere(records.filter((r) => r !== record), ref, common.head);
      if (other !== null) return other;
      if (!ref.startsWith(HEADS) || !isRefName(ref)) return unavailable("invalid-name");
      const facts = await deleteFacts(ctx, ref, common.listing);
      if (!("value" in facts)) return facts;
      branch = facts.value;
    }
    const target = await targetTrust(ctx, record, id.value[0]!);
    if (!("value" in target)) return target;
    const status = await statusOf(ctx, statusArgs);
    if (!("value" in status)) return status;
    const submodules = await submodulesOf(ctx, record, target.value.folders);
    if (!("value" in submodules)) return submodules;
    const { tracked, untracked } = status.value;
    // FR-055: Git's force option only after the check box, and only for a worktree with changes or submodules, so Git's own check guards another one.
    const needsForce = tracked + untracked > 0 || submodules.value;
    const force = p.force && needsForce;
    const deleteBranch = branch === null ? null : { ref: record.branch, oid: branch.oid, onlyHere: branch.onlyHere, reflogKeeps: branch.reflogKeeps };
    const plan = { worktree: record.path, branch: record.branch, head: record.head, tracked, untracked, force, deleteBranch, submodules: submodules.value };
    if (needsForce && !p.force) return unavailable("dirty-tree", { plan });
    return { bound: { record, status: status.value.digest, force, branch, trust: target.value.trust, submodules: submodules.value }, plan };
  },
  started: () => "worktree-remove",
  async run(r, _p, b) {
    const path = b.record.path;
    const ends = [await r.step(worktreeRemoveArgs(path, b.force), "worktree")];
    let deleted = b.branch === null;
    // FR-056 and plan.md D10: the branch delete runs only after a fresh list without that path.
    if (b.branch !== null && ends[0]!.exit?.exitCode === 0) {
      const list = await readWorktrees(r.q);
      if ("value" in list && !list.value.records.some((x) => x.path === path)) {
        ends.push(...(await deleteSteps(r, b.record.branch!, b.branch)));
        deleted = true;
      }
    }
    const refs = new Map(r.before.refs);
    if (b.branch !== null) refs.delete(refKey(b.record.branch!));
    await settle(r, "worktree-remove", ends, { refs, done: deleted, took: (after) => !after.some((x) => x.path === path) });
  },
});

// ---- Prune missing worktrees (contract Δ3 `worktree-prune`, spec FR-057) ----

registerWorkbenchAction<"worktree-prune", WorktreeRecord[]>("worktree-prune", {
  async observe(ctx) {
    const list = await readWorktrees(ctx);
    if (!("value" in list)) return list;
    // builtin/worktree.c `prune` removes what the list marks prunable. Git marks no locked record prunable.
    const prunable = list.value.records.filter((r) => r.prunable !== null);
    if (prunable.length === 0) return unavailable("nothing-to-prune");
    return { bound: prunable, plan: { prunable: prunable.map((r) => ({ path: r.path, reason: r.prunable!.reason })) } };
  },
  started: () => "worktree-prune",
  async run(r, _p, prunable) {
    const end = await r.step(worktreePruneArgs(), "worktree");
    await settle(r, "worktree-prune", [end], { refs: r.before.refs, done: true, took: (after) => prunable.every((p) => !after.some((x) => x.path === p.path)) });
  },
});
