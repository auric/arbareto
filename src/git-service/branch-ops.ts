// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `create-branch`, `rename-branch`, and `delete-branch`, plan.md D4, data-model §4, and spec FR-014 to FR-020.
// A delete binds the shown object ID, so Git refuses it when the branch moved (git-update-ref(1)).

import { branchNameRefusal } from "../contracts/branch-name";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM } from "../contracts/limits";
import { headRefExistsArgs, isObjectId, isRefName } from "./commands";
import { createCollector } from "./git-runner";
import { stepOf, type Fact, type ObserveContext } from "./hunk-publish";
import { deleteFacts, heldElsewhere, readWorktrees, refTarget, unavailable, unresolvedRefusal, type DeleteFacts, type Refused } from "./ref-facts";
import type { Head } from "./snapshot";
import { changedRefs, changes } from "./sync";
import { observe } from "./sync-integrate";
import { refKey } from "./sync-review";
import { branchNameCheckArgs, createArgs, createSwitchArgs, deleteRefArgs, removeBranchSectionArgs, renameArgs } from "./workbench-commands";
import { killed, registerWorkbenchAction, conclude, type StepEnd, type WorkbenchRun } from "./workbench-review";

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

// Contract Δ3 `runWorkbench` step 4 for a ref action. `expect` holds the refs and HEAD that the action intends.
async function settle(r: WorkbenchRun, action: string, ends: StepEnd[], expect: { refs: Map<string, string>; head: Head }): Promise<void> {
  const settled = await r.reconcile(ends);
  if (settled === null) return r.unknown({ code: "GIT_FAILED" }, { action });
  const o = await observe(r.q, killed(ends));
  if (!("value" in o)) return r.unknown(o, { action });
  const { refs, head, state, lock } = o.value;
  const result = { action, head, refs: changedRefs(r.before.refs, refs) };
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
    // builtin/branch.c `replace_each_worktree_head_symref` skips a worktree without `head_ref`, so that HEAD would keep the old name.
    const worktrees = await readWorktrees(ctx);
    if (!("value" in worktrees)) return worktrees;
    const unknown = unresolvedRefusal(worktrees.value.records);
    if (unknown !== null) return unknown;
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
    if (held !== null) return held;
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
