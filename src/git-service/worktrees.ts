// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `readWorktrees`, `openWorktree`, and the `reviewWorkbench` actions `worktree-add`, `worktree-remove`, and `worktree-prune`.
// Plan.md D10, data-model §2 and §8, and spec FR-049 to FR-057. Git's own refusal stays the second guard of each step.

import { IdentityReply } from "../contracts/channel";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, IDENTITY_PATHS, STATUS_LISTING_BYTES, WINDOWS_COMMAND_LINE_UNITS } from "../contracts/limits";
import { wslIdentityPath } from "../contracts/wsl-route";
import { deleteFacts, deleteSteps, nameRefusal, newName, type DeleteFacts } from "./branch-ops";
import { isObjectId, isRefName, type ObjectFormat } from "./commands";
import { RunnerRefusal, stepUnits, type EnvironmentPolicy, type GitRunner, type ProcessContext, type SyncRunner } from "./git-runner";
import type { Fact, ObserveContext } from "./hunk-publish";
import { NO_FILE, sameIdentity, type PhysicalIdentity } from "./identity";
import { contextOf } from "./read-steps";
import type { Workspace } from "./registration";
import { changes } from "./sync";
import { observe } from "./sync-integrate";
import { readOut, refKey } from "./sync-review";
import { worktreeAddExistingArgs, worktreeAddNewArgs, worktreeLayoutArgs, worktreePruneArgs, worktreeRemoveArgs, worktreeStatusArgs } from "./workbench-commands";
import { parseWorktreeStatus, type WorktreeRecord } from "./workbench-parsers";
import { conclude, killed, readWorktrees, refTarget, registerWorkbenchAction, unavailable, type PayloadOf, type Refused, type StepEnd, type WorkbenchRun } from "./workbench-review";

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
  const result = { action, head, refs: changes(r.before.refs, refs), worktrees: list.value.records.map((x) => x.path) };
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
      const held = list.value.records.find((r) => r.branchKey === refKey(b.existing));
      if (held !== undefined) return unavailable("other-worktree", { worktree: held.path });
      oid = tip.value;
    } else {
      const fresh = await newName(ctx, b.new);
      if (!("value" in fresh)) return fresh;
      oid = b.start;
    }
    const dest = await destination(ctx, p.bootstrapId);
    if (!("value" in dest)) return dest;
    if (!fits(ctx, "integrate", addArgs(p, dest.value.path, ctx.workspace.objectFormat))) return unavailable("limit");
    const branch = "existing" in b ? { existing: b.existing, oid } : { new: b.new, start: b.start };
    return { bound: { ...dest.value, oid }, plan: { branch, ...dest.value } };
  },
  started: () => "worktree-add",
  async run(r, p, b) {
    const w = r.ctx.workspace;
    const context: ProcessContext = { contextKind: "worktreeAdd", gitInstallationId: w.gitInstallationId, repositoryId: w.repositoryId, bootstrapId: p.bootstrapId };
    const end = await r.step(addArgs(p, b.path, w.objectFormat), "worktree", { context });
    const ref = "existing" in p.branch ? p.branch.existing : `${HEADS}${p.branch.new}`;
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
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Plan.md O-20 and D12 "Other worktrees": Git runs the clean filter and `core.fsmonitor` of that worktree for `-C <path> status` and `worktree remove`
// (research.md R21 F18). So both take the class `workbench` of its own listing and its own trust state. Git names its folders.
// A top level or a common folder with another identity is no worktree of this repository. The contract names no reason, so it gives UNKNOWN_TARGET.
async function targetTrust(ctx: ObserveContext, record: WorktreeRecord, root: Located): Promise<Fact<{ required: boolean; fingerprint: string }> | Refused> {
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
  if (gate !== null) return { refused: gate };
  return { value: { required: listed.listing.approvalRequired.workbench, fingerprint: listed.listing.fingerprint } };
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
    // Plan.md O-20: the layout read is the longest read of the trust listing in that worktree.
    const fitting = [statusArgs, worktreeLayoutArgs(record.path)].every((args) => fits(ctx, "read", args)) && fits(ctx, "integrate", worktreeRemoveArgs(record.path, true));
    if (!fitting) return unavailable("limit");
    let branch: DeleteFacts | null = null;
    if (p.deleteBranch) {
      const ref = record.branch;
      if (ref === null) return unavailable("detached");
      // Plan.md D4: another worktree must not hold the branch. The removal releases the branch of this record only.
      if (common.head.state !== "detached" && common.head.target === ref) return unavailable("current-branch");
      const other = records.find((r) => r !== record && r.branchKey === record.branchKey);
      if (other !== undefined) return unavailable("other-worktree", { worktree: other.path });
      if (!ref.startsWith(HEADS) || !isRefName(ref)) return unavailable("invalid-name");
      const facts = await deleteFacts(ctx, ref, common.listing);
      if (!("value" in facts)) return facts;
      branch = facts.value;
    }
    const trust = await targetTrust(ctx, record, id.value[0]!);
    if (!("value" in trust)) return trust;
    const status = await statusOf(ctx, statusArgs);
    if (!("value" in status)) return status;
    const { tracked, untracked } = status.value;
    const dirty = tracked + untracked > 0;
    // FR-055: Git's force option only after the check box, and only for a worktree with changes, so Git's own check guards a clean one.
    const force = p.force && dirty;
    const deleteBranch = branch === null ? null : { ref: record.branch, oid: branch.oid, onlyHere: branch.onlyHere, reflogKeeps: branch.reflogKeeps };
    const plan = { worktree: record.path, branch: record.branch, head: record.head, tracked, untracked, force, deleteBranch };
    if (dirty && !p.force) return unavailable("dirty-tree", { plan });
    return { bound: { record, status: status.value.digest, force, branch, trust: trust.value }, plan };
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
