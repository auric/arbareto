// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `create-branch`, `rename-branch`, and `delete-branch`, plan.md D4, data-model §4, and spec FR-014 to FR-020.
// A delete binds the shown object ID, so Git refuses it when the branch moved (git-update-ref(1)).

import { branchNameRefusal } from "../contracts/branch-name";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, REFLOG_SCAN_ENTRIES } from "../contracts/limits";
import { headRefExistsArgs, isObjectId, isRefName } from "./commands";
import { createCollector } from "./git-runner";
import { stepOf, type Fact, type ObserveContext } from "./hunk-publish";
import { latin1 } from "./read-steps";
import type { Head } from "./snapshot";
import { changes } from "./sync";
import { refKey } from "./sync-review";
import { branchNameCheckArgs, createArgs, createSwitchArgs, deleteRefArgs, headReflogArgs, headReflogExistsArgs, removeBranchSectionArgs, renameArgs, unmergedCountArgs } from "./workbench-commands";
import { heldElsewhere, observeRepository, readOut, readWorktrees, refOid, registerWorkbenchAction, unavailable, conclude, type Refused, type StepEnd, type WorkbenchRun } from "./workbench-review";

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
  // `-z` ends each `%H` entry with NUL. `-n` caps the entries at REFLOG_SCAN_ENTRIES.
  const read = await readOut(ctx, headReflogArgs(), REFLOG_SCAN_ENTRIES * 65);
  if (!("value" in read)) return read;
  const text = latin1(read.value);
  const oids = text === "" ? [] : text.endsWith("\0") ? text.slice(0, -1).split("\0") : null;
  if (oids === null || !oids.every((oid) => isObjectId(oid, ctx.workspace.objectFormat))) return { code: "MALFORMED_GIT_OUTPUT" };
  return { value: oids.includes(tip) };
}

// Contract Δ3 `runWorkbench` step 4 for a ref action. `expect` holds the refs and HEAD that the action intends.
async function settle(r: WorkbenchRun, action: string, ends: StepEnd[], expect: { refs: Map<string, string>; head: Head }): Promise<void> {
  const settled = await r.reconcile(ends);
  if (settled === null) return r.unknown({ code: "GIT_FAILED" }, { action });
  const o = await observeRepository(r.q);
  if (!("value" in o)) return r.unknown(o, { action });
  const { refs, head, state } = o.value;
  const result = { action, head, refs: changes(r.before.refs, refs) };
  const sameState = state === r.common.operationState;
  conclude(
    r,
    {
      done: ends.every((end) => end.exit?.exitCode === 0),
      intended: changes(expect.refs, refs).length === 0 && Bun.deepEquals(head, expect.head, true) && sameState,
      changed: result.refs.length > 0 || !Bun.deepEquals(head, r.common.head, true) || !sameState,
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
    const oid = await refOid(ctx, p.ref);
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

interface DeleteBound {
  oid: string;
  onlyHere: number;
  reflogKeeps: boolean;
  worktrees: string;
  section: boolean;
}

registerWorkbenchAction("delete-branch", {
  precheck: (p) => (isRefName(p.ref) ? null : { refused: "INVALID_REQUEST" }),
  async observe(ctx, p, common) {
    const { head } = common;
    if (head.state !== "detached" && head.target === p.ref) return unavailable("current-branch");
    const worktrees = await readWorktrees(ctx);
    if (!("value" in worktrees)) return worktrees;
    const held = heldElsewhere(worktrees.value.records, p.ref, head);
    if (held !== null) return unavailable("other-worktree", { worktree: held.path });
    const tip = await refOid(ctx, p.ref);
    if (!("value" in tip)) return tip;
    const counted = await readOut(ctx, unmergedCountArgs(tip.value, short(p.ref), ctx.workspace.objectFormat));
    if (!("value" in counted)) return counted;
    const count = /^(0|[1-9][0-9]*)\n$/.exec(latin1(counted.value));
    if (count === null) return { code: "MALFORMED_GIT_OUTPUT" };
    const keeps = await headReflogKeeps(ctx, tip.value);
    if (!("value" in keeps)) return keeps;
    // builtin/branch.c `delete_branch_config` removes the `branch.<name>` section. A key prints as section, subsection, and a variable without a dot.
    const section = common.listing.entries.some((e) => e.scope === "local" && e.key.slice(0, e.key.lastIndexOf(".")) === `branch.${short(p.ref)}`);
    const bound: DeleteBound = { oid: tip.value, onlyHere: Number(count[1]), reflogKeeps: keeps.value, worktrees: worktrees.value.digest, section };
    return { bound, plan: { ref: p.ref, oid: tip.value, onlyHere: bound.onlyHere, reflogKeeps: bound.reflogKeeps, heldBy: null, current: false } };
  },
  started: () => "delete-branch",
  async run(r, p, b: DeleteBound) {
    const name = short(p.ref);
    const ends = [await r.step(deleteRefArgs(name, b.oid, r.ctx.workspace.objectFormat), "branch")];
    // A nonzero `update-ref` exit runs no second step (contract Δ3).
    if (ends[0]!.exit?.exitCode === 0 && b.section) ends.push(await r.step(removeBranchSectionArgs(name), "branch"));
    const refs = new Map(r.before.refs);
    refs.delete(refKey(p.ref));
    await settle(r, "delete-branch", ends, { refs, head: r.common.head });
  },
});
