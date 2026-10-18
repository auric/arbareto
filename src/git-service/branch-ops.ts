// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `create-branch`, `rename-branch`, and `delete-branch`, plan.md D4, data-model §4, and spec FR-014 to FR-020.
// A delete binds the shown object ID, so Git refuses it when the branch moved (git-update-ref(1)).

import { branchNameRefusal } from "../contracts/branch-name";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, REFLOG_SCAN_ENTRIES, TRUST_INPUT_BYTES } from "../contracts/limits";
import { headRefExistsArgs, isObjectId, isRefName } from "./commands";
import { createCollector } from "./git-runner";
import { stepOf, type Fact, type ObserveContext } from "./hunk-publish";
import type { Head } from "./snapshot";
import { changes } from "./sync";
import { observe } from "./sync-integrate";
import { readOut, refKey } from "./sync-review";
import { parseConfigListing, type ConfigEntry, type TrustListing } from "./trust";
import { branchNameCheckArgs, createArgs, createSwitchArgs, deleteRefArgs, headReflogArgs, headReflogExistsArgs, localConfigArgs, removeBranchSectionArgs, renameArgs, unmergedCountArgs } from "./workbench-commands";
import { oidList } from "./workbench-parsers";
import { heldElsewhere, killed, readWorktrees, refTarget, registerWorkbenchAction, revCount, unavailable, conclude, type Refused, type StepEnd, type WorkbenchRun } from "./workbench-review";

const HEADS = "refs/heads/";
const short = (ref: string) => ref.slice(HEADS.length);

// Plan.md D4: the `branch-name.ts` rule. It runs before any Git process.
export function nameRefusal(name: string): Refused | null {
  const refusal = branchNameRefusal(name);
  if (refusal === null) return null;
  return refusal.code === "INVALID_REQUEST" ? { refused: "INVALID_REQUEST" } : unavailable(refusal.reason);
}

// Plan.md D4: `check-ref-format --branch` passes only with exit 0 and stdout equal to the name, because `--branch` expands `@{-n}`.
async function nameCheck(ctx: ObserveContext, name: string): Promise<Fact<null> | Refused> {
  const out = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  const step = await stepOf(ctx, branchNameCheckArgs(name), out);
  if (!("exit" in step)) return step;
  const exact = step.exit.exitCode === 0 && !out.limited && Buffer.from(out.take()).equals(Buffer.from(`${name}\n`, "utf8"));
  // The argv builders take a name only after the ref rule of `commands.ts`.
  return exact && isRefName(`${HEADS}${name}`) ? { value: null } : unavailable("invalid-name");
}

// git-show-ref(1) `--exists`: exit 0 for an existing ref, 2 for a missing ref.
export async function refExists(ctx: ObserveContext, ref: string): Promise<Fact<boolean>> {
  const step = await stepOf(ctx, headRefExistsArgs(ref), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
  if (!("exit" in step)) return step;
  return step.exit.exitCode === 0 ? { value: true } : step.exit.exitCode === 2 ? { value: false } : { code: "GIT_FAILED" };
}

// Plan.md D4 for a new name: Git's check, then an absent `refs/heads/<name>`. `name-exists` names the branch, so the panel can offer a switch to it.
export async function newName(ctx: ObserveContext, name: string): Promise<Fact<null> | Refused> {
  const checked = await nameCheck(ctx, name);
  if (!("value" in checked)) return checked;
  const exists = await refExists(ctx, `${HEADS}${name}`);
  if (!("value" in exists)) return exists;
  return exists.value ? unavailable("name-exists", { ref: `${HEADS}${name}` }) : { value: null };
}

// Data-model §4 `reflogKeeps`. builtin/reflog.c `cmd_reflog_exists`: exit 0 when the reflog exists, 1 when it does not.
async function headReflogKeeps(ctx: ObserveContext, tip: string): Promise<Fact<boolean>> {
  const exists = await stepOf(ctx, headReflogExistsArgs(), createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM }));
  if (!("exit" in exists)) return exists;
  if (exists.exit.exitCode === 1) return { value: false };
  if (exists.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  // `-n` caps the entries at REFLOG_SCAN_ENTRIES, so more bytes break the grammar.
  const read = await readOut(ctx, headReflogArgs(), REFLOG_SCAN_ENTRIES * 65);
  if ("limited" in read) return { code: "MALFORMED_GIT_OUTPUT" };
  if (!("value" in read)) return read;
  const oids = oidList(read.value, ctx.workspace.objectFormat);
  return oids === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: oids.includes(tip) };
}

// The count of local file keys that `keep` takes. The listing of the review counts the included files too (git-config(1) `--no-includes`).
async function localSectionKeys(ctx: ObserveContext, keep: (e: ConfigEntry) => boolean): Promise<Fact<number>> {
  const read = await readOut(ctx, localConfigArgs(), TRUST_INPUT_BYTES);
  if ("limited" in read) return { code: "OUTPUT_LIMIT" };
  if (!("value" in read)) return read;
  const entries = parseConfigListing(read.value, false);
  return entries === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: entries.filter(keep).length };
}

// Contract Δ3 `runWorkbench` step 4 for a ref action. `expect` holds the refs and HEAD that the action intends.
async function settle(r: WorkbenchRun, action: string, ends: StepEnd[], expect: { refs: Map<string, string>; head: Head }): Promise<void> {
  const settled = await r.reconcile(ends);
  if (settled === null) return r.unknown({ code: "GIT_FAILED" }, { action });
  const o = await observe(r.q, killed(ends));
  if (!("value" in o)) return r.unknown(o, { action });
  const { refs, head, state, lock } = o.value;
  const result = { action, head, refs: changes(r.before.refs, refs) };
  const sameState = state === r.common.operationState;
  conclude(
    r,
    {
      done: ends.every((end) => end.exit?.exitCode === 0),
      intended: !lock && changes(expect.refs, refs).length === 0 && Bun.deepEquals(head, expect.head, true) && sameState,
      changed: lock || result.refs.length > 0 || !Bun.deepEquals(head, r.common.head, true) || !sameState,
      canceled: settled.canceled,
      failed: ends.find((end) => end.exit?.exitCode !== 0) ?? null,
    },
    result,
  );
}

// ---- Create branch here ----

registerWorkbenchAction("create-branch", {
  precheck: (p, w) => nameRefusal(p.name) ?? (isObjectId(p.start, w.objectFormat) ? null : { refused: "INVALID_REQUEST" }),
  async observe(ctx, p) {
    const fresh = await newName(ctx, p.name);
    if (!("value" in fresh)) return fresh;
    // Data-model §2: the name, the start object ID, and the absent target ref.
    return { bound: { absent: true }, plan: { name: p.name, start: p.start, switchTo: p.switchTo } };
  },
  started: () => "create-branch",
  async run(r, p) {
    const of = r.ctx.workspace.objectFormat;
    const ref = `${HEADS}${p.name}`;
    // git-branch(1) `branch.autoSetupMerge`: an object ID start point gets no upstream.
    const end = await r.step(p.switchTo ? createSwitchArgs(p.name, p.start, of) : createArgs(p.name, p.start, of), "branch");
    const refs = new Map(r.before.refs).set(refKey(ref), p.start);
    await settle(r, "create-branch", [end], { refs, head: p.switchTo ? { state: "branch", target: ref, oid: p.start } : r.common.head });
  },
});

// ---- Rename ----

registerWorkbenchAction("rename-branch", {
  // Research.md R21 F29: `branch -m` reads an old name `@` as a branch name, so only the new name takes the rule.
  precheck: (p) => nameRefusal(p.name) ?? (isRefName(p.ref) ? null : { refused: "INVALID_REQUEST" }),
  async observe(ctx, p) {
    const oid = await refTarget(ctx, p.ref);
    if (!("value" in oid)) return oid;
    const fresh = await newName(ctx, p.name);
    if (!("value" in fresh)) return fresh;
    return { bound: { oid: oid.value }, plan: { ref: p.ref, oid: oid.value, name: p.name } };
  },
  started: () => "rename-branch",
  async run(r, p, b: { oid: string }) {
    const end = await r.step(renameArgs(short(p.ref), p.name), "branch");
    const refs = new Map(r.before.refs);
    refs.delete(refKey(p.ref));
    refs.set(refKey(`${HEADS}${p.name}`), b.oid);
    // builtin/branch.c `copy_or_rename_branch` moves the HEAD of each worktree that holds the branch.
    const h = r.common.head;
    await settle(r, "rename-branch", [end], { refs, head: h.state !== "detached" && h.target === p.ref ? { ...h, target: `${HEADS}${p.name}` } : h });
  },
});

// ---- Delete ----

// Data-model §4 facts of one local branch. `section`: the local file holds a `branch.<name>` key.
export interface DeleteFacts {
  oid: string;
  onlyHere: number;
  reflogKeeps: boolean;
  section: boolean;
}

// Plan.md D4 delete reads after the worktree check. Feature 004 plan.md D10 "Also delete the branch" reads them too.
export async function deleteFacts(ctx: ObserveContext, ref: string, listing: Pick<TrustListing, "entries">): Promise<Fact<DeleteFacts> | Refused> {
  const tip = await refTarget(ctx, ref);
  if (!("value" in tip)) return tip;
  const count = await revCount(ctx, unmergedCountArgs(tip.value, short(ref), ctx.workspace.objectFormat));
  if (!("value" in count)) return count;
  const keeps = await headReflogKeeps(ctx, tip.value);
  if (!("value" in keeps)) return keeps;
  // builtin/branch.c `delete_branch_config` removes the `branch.<name>` section. A key prints as section, subsection, and a variable without a dot.
  const inSection = (e: ConfigEntry) => e.scope === "local" && e.key.slice(0, e.key.lastIndexOf(".")) === `branch.${short(ref)}`;
  const listed = listing.entries.filter(inSection).length;
  const own = listed === 0 ? { value: 0 } : await localSectionKeys(ctx, inSection);
  if (!("value" in own)) return own;
  // `config --local --remove-section` changes the local file alone. A key of an included file would stay, and Git exits 128 when the local file holds no key.
  if (own.value < listed) return unavailable("config-in-include");
  return { value: { oid: tip.value, onlyHere: count.value, reflogKeeps: keeps.value, section: own.value > 0 } };
}

// Contract Δ3 `delete-branch` steps. A nonzero `update-ref` exit runs no second step.
export async function deleteSteps(r: WorkbenchRun, ref: string, b: Pick<DeleteFacts, "oid" | "section">): Promise<StepEnd[]> {
  const name = short(ref);
  const ends = [await r.step(deleteRefArgs(name, b.oid, r.ctx.workspace.objectFormat), "branch")];
  if (ends[0]!.exit?.exitCode === 0 && b.section) ends.push(await r.step(removeBranchSectionArgs(name), "branch"));
  return ends;
}

type DeleteBound = DeleteFacts & { worktrees: string };

registerWorkbenchAction("delete-branch", {
  precheck: (p) => (isRefName(p.ref) ? null : { refused: "INVALID_REQUEST" }),
  async observe(ctx, p, common) {
    const { head } = common;
    if (head.state !== "detached" && head.target === p.ref) return unavailable("current-branch");
    const worktrees = await readWorktrees(ctx);
    if (!("value" in worktrees)) return worktrees;
    const held = heldElsewhere(worktrees.value.records, p.ref, head);
    if (held !== null) return unavailable("other-worktree", { worktree: held.path });
    const facts = await deleteFacts(ctx, p.ref, common.listing);
    if (!("value" in facts)) return facts;
    const bound: DeleteBound = { ...facts.value, worktrees: worktrees.value.digest };
    return { bound, plan: { ref: p.ref, oid: bound.oid, onlyHere: bound.onlyHere, reflogKeeps: bound.reflogKeeps, heldBy: null, current: false } };
  },
  started: () => "delete-branch",
  async run(r, p, b: DeleteBound) {
    const ends = await deleteSteps(r, p.ref, b);
    const refs = new Map(r.before.refs);
    refs.delete(refKey(p.ref));
    await settle(r, "delete-branch", ends, { refs, head: r.common.head });
  },
});
