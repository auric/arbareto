// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
// Type-only imports keep zod out of the renderer bundle.
import type { z } from "zod";
import type { ReadWorktreesResult, ReviewWorkbenchResult } from "../../contracts/envelope";
import { unknownFormText } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge } from "../bridge";
import { OUTCOME, T as B } from "../branches/texts";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { splitPath, WINDOWS_SEPARATORS } from "../lib/path";
import { isObject } from "../lib/utils";
import { shortRef } from "../refs/ReferencesSidebar";
import type { Workbench } from "../state/workbench";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import { needsTrust, reviewWithTrust, trustGate, WORKBENCH_TRUST, type AskTrust } from "../trust/ask";
import { AddWorktreePanel, type AddRequest, type AddSelection } from "./AddWorktreePanel";
import { RUN_TEXTS, W, worktreeRefusal } from "./texts";

// Feature 004 spec FR-049 to FR-057, plan.md D10 and D15, data-model §8, contract Δ3 `readWorktrees`, `reviewWorkbench`, and `runWorkbench`.

type Bridge = ReturnType<typeof createBridge>;
type Target = { repositoryId: string; repositoryGeneration: number };
export type WorktreeEntry = Extract<z.infer<typeof ReadWorktreesResult>, { entries: unknown }>["entries"][number];
type Reviewed = Extract<z.infer<typeof ReviewWorkbenchResult>, { workbenchToken: string }>;
type RemovePlan = Extract<Reviewed, { action: "worktree-remove" }>["plan"];
type WorktreeAction = keyof typeof RUN_TEXTS;

/** The newest `readWorktrees` result of one repository. `failure` is the visible text of a failed read. */
type List = { repositoryId: string; entries: WorktreeEntry[] | null; failure: string | null };
type RemoveOverlay = { entry: WorktreeEntry; force: boolean; deleteBranch: boolean; plan: RemovePlan | null; token: string | null; pending: boolean; error: string | null };

export type WorktreeActionsOptions = {
  bridge: Pick<Bridge, "readWorktrees" | "reviewWorkbench" | "runWorkbench" | "chooseWorktreeFolder">;
  /** Plan D12 "Ask". It asks only for the gate of this repository. A refusal of the target worktree gate asks nothing (plan O-20). */
  askTrust?: AskTrust;
  target(): Target | null;
  /** The open repository. A new one reads the worktrees. */
  repositoryId: string | null;
  /** The newest `readRefs.refsDigest`. Each new value reads the worktrees again. */
  refsDigest: string | null;
  workbench: Workbench;
  /** The root of the open worktree. The folder suggestion of Add worktree starts beside it. */
  worktreeRoot: string | null;
  /** The commit that a new branch starts at: the selected history commit, else HEAD. Null on an unborn branch. */
  start: string | null;
  /** The reason that blocks every mutation, or null. */
  blockedReason: string | null;
  /** True while a mutation runs (plan D15 running rule). */
  running: boolean;
  onOperation(op: StatusOperation): void;
  /** Shows a text in the status bar. Null clears it. */
  onNotice(text: ReactNode): void;
  /** The 001 open flow through `openWorktree` (spec FR-051). */
  onOpen(path: string): void;
  /** Shows the History view, whose dock holds the Add worktree panel. */
  onDock(): void;
};

const short = (ref: string | null) => (ref === null ? null : shortRef(ref));
const tokenOf = (response: BridgeResponse) => (response.state === "succeeded" && isObject(response.result) && typeof response.result.workbenchToken === "string" ? response.result.workbenchToken : null);
const planOf = (response: BridgeResponse) => (isObject(response.result) && isObject(response.result.plan) ? response.result.plan : null);

/** The last folder name of a record path. */
export const folderOf = (path: string) => splitPath(path.replace(/[\\/]+$/, ""), WINDOWS_SEPARATORS)[1] || path;
/** The branch, the detached commit, the unresolved mark, or the bare mark of a record (data-model §8). */
export const branchText = (e: WorktreeEntry) => (e.bare ? W.bare : e.branch !== null ? shortRef(e.branch) : e.detached && e.head !== null ? W.detached(e.head) : e.headUnresolved ? W.headUnknown : null);
/** The current, main, locked, and prunable marks (spec FR-049). */
export function marks(e: WorktreeEntry): string[] {
  const out: string[] = [];
  if (e.main) out.push(W.main);
  if (e.current) out.push(W.current);
  if (e.locked !== null) out.push(W.locked(e.locked.reason));
  if (e.prunable !== null) out.push(W.prunable);
  return out;
}
/** The accessible name of a record row: folder, branch, path, then the marks. */
export const entryLabel = (e: WorktreeEntry) => [folderOf(e.path), branchText(e), e.path, ...marks(e)].filter((part) => part !== null).join(", ");

function listOf(repositoryId: string, response: BridgeResponse): List {
  const result = isObject(response.result) ? response.result : {};
  if (response.state === "succeeded" && Array.isArray(result.entries)) return { repositoryId, entries: result.entries as WorktreeEntry[], failure: null };
  const reason = typeof result.reason === "string" ? result.reason : null;
  const failure = reason === "WORKTREE_RECORDS" || reason === "WORKTREE_LISTING_BYTES" ? W[reason] : response.state === "succeeded" ? unknownFormText(W.listName) : W.listFailed(response.code ?? response.state);
  return { repositoryId, entries: null, failure };
}

/** The worktree list of the top bar and the sidebar, and the Open, Remove, Prune, and Add actions. */
export function useWorktreeActions(options: WorktreeActionsOptions) {
  const { bridge, target, repositoryId, refsDigest, workbench, worktreeRoot, start, blockedReason, running, onOperation, onNotice, onOpen, onDock, askTrust } = options;
  const [list, setList] = useState<List | null>(null);
  const [remove, setRemove] = useState<RemoveOverlay | null>(null);
  const [add, setAdd] = useState<{ repositoryId: string; opener: Element | null; initial?: AddSelection } | null>(null);
  const seq = useRef(0);
  const busy = useRef(false);

  // Latest wins. A response for an older generation or another repository is dropped.
  function read() {
    const t = target();
    if (t === null) return;
    const mine = ++seq.current;
    void bridge.readWorktrees(t).then((response) => {
      const now = target();
      if (mine !== seq.current || now === null || now.repositoryId !== t.repositoryId || now.repositoryGeneration !== t.repositoryGeneration) return;
      setList(listOf(t.repositoryId, response));
    });
  }
  useEffect(() => {
    if (repositoryId !== null) read();
  }, [repositoryId, refsDigest]);
  const [shownFor, setShownFor] = useState(repositoryId);
  if (shownFor !== repositoryId) {
    setShownFor(repositoryId);
    setRemove(null);
    setAdd(null);
  }

  const shown = list !== null && list.repositoryId === repositoryId ? list : null;
  const entries = shown?.entries ?? null;
  const prunable = entries?.some((e) => e.prunable !== null) ?? false;

  /** Spec FR-054 and plan D10, in the service order: main, current, locked, prunable. */
  function removeReason(e: WorktreeEntry): string | null {
    if (e.main) return W.mainReason;
    if (e.current) return W.currentReason;
    if (e.locked !== null) return W.lockedReason;
    if (e.prunable !== null) return W.prunableReason;
    if (e.invalidUtf8) return W.invalidUtf8;
    return blockedReason;
  }
  function openReason(e: WorktreeEntry): string | null {
    if (e.current) return W.isOpen;
    if (e.bare) return W.bareReason;
    if (e.prunable !== null) return W.prunableReason;
    if (e.invalidUtf8) return W.invalidUtf8;
    return blockedReason;
  }
  const pruneReason = entries === null ? null : prunable ? blockedReason : W.nothingToPrune;

  async function review(payload: Parameters<Bridge["reviewWorkbench"]>[1]) {
    const t = target();
    // The second review takes the generation of the full read after the approval.
    return t === null ? null : reviewWithTrust(() => bridge.reviewWorkbench(target() ?? t, payload), WORKBENCH_TRUST[payload.action], askTrust);
  }

  /** Runs one reviewed token and reports it in the status bar. It gives the response. `worktree` is the record path of a remove, else null. */
  async function run(token: string, action: WorktreeAction, worktree: string | null): Promise<BridgeResponse | null> {
    const t = target();
    if (t === null) return null;
    onNotice(null);
    const response = await trackOperation("runWorkbench", undefined, (onProgress) => bridge.runWorkbench({ repositoryId: t.repositoryId }, { workbenchToken: token, start: true }, onProgress), (op) => onOperation({ ...op, texts: RUN_TEXTS[action] }));
    workbench.ended("runWorkbench", response);
    read();
    // Plan O-20: a run refusal of the target gate asks nothing and names the worktree, as the review refusal does.
    if (response.state !== "succeeded") onNotice(worktree !== null && needsTrust(response) && trustGate(response) === "target" ? W.targetTrust(worktree) : OUTCOME.failed(RUN_TEXTS[action][0], response.code ?? response.state));
    return response;
  }

  async function once(step: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    try {
      await step();
    } finally {
      busy.current = false;
    }
  }

  function open(e: WorktreeEntry) {
    // Plan D15 running rule: the running reason shows only in the tooltip, never as status bar text.
    if (running) return;
    const reason = openReason(e);
    if (e.current) return;
    if (reason !== null) return onNotice(reason);
    onOpen(e.path);
  }

  /** Each change of a check box needs a new review, because the token binds `force` and `deleteBranch` (contract Δ3). */
  async function reviewRemove(o: RemoveOverlay) {
    setRemove({ ...o, token: null, pending: true, error: null });
    const response = await review({ action: "worktree-remove", worktree: o.entry.path, force: o.force, deleteBranch: o.deleteBranch });
    if (response === null) return;
    const plan = planOf(response) as RemovePlan | null;
    // Plan D15 "Malformed result": a token without a plan never makes Remove available.
    const token = plan === null ? null : tokenOf(response);
    const r = isObject(response.result) ? response.result : {};
    // Spec FR-055: a `dirty-tree` refusal carries the counts. Remove waits for the check box.
    const dirty = response.code === "WORKBENCH_UNAVAILABLE" && r.reason === "dirty-tree" && plan !== null;
    const error = token !== null || dirty ? null : response.state === "succeeded" ? unknownFormText(W.removeButton) : worktreeRefusal(response, "worktree-remove", o.entry.path, short(o.entry.branch) ?? "");
    // A later check box change replaces this review.
    setRemove((now) => (now !== null && now.entry.path === o.entry.path && now.force === o.force && now.deleteBranch === o.deleteBranch ? { ...now, plan: plan ?? now.plan, token, pending: false, error } : now));
  }

  function startRemove(e: WorktreeEntry) {
    if (running) return;
    const reason = removeReason(e);
    if (reason !== null) return onNotice(reason);
    void reviewRemove({ entry: e, force: false, deleteBranch: false, plan: null, token: null, pending: true, error: null });
  }

  function confirmRemove(o: RemoveOverlay) {
    if (o.token === null) return;
    const token = o.token;
    setRemove(null);
    void once(async () => {
      const response = await run(token, "worktree-remove", o.entry.path);
      if (response?.state !== "succeeded") return;
      const branch = o.deleteBranch ? short(o.plan?.deleteBranch?.ref ?? null) : null;
      onNotice(branch === null ? W.removed(o.entry.path) : W.removedBranch(o.entry.path, branch));
    });
  }

  function prune() {
    if (running) return;
    if (pruneReason !== null) return onNotice(pruneReason);
    void once(async () => {
      const response = await review({ action: "worktree-prune" });
      if (response === null) return;
      const token = tokenOf(response);
      const plan = planOf(response);
      if (token === null || plan === null || !Array.isArray(plan.prunable)) return onNotice(worktreeRefusal(response, "worktree-prune", "", ""));
      const done = await run(token, "worktree-prune", null);
      if (done?.state === "succeeded") onNotice(W.pruned(plan.prunable.length));
    });
  }

  /** `initial` is the branch menu selection (spec FR-052). */
  function startAdd(opener: Element | null, initial?: AddSelection) {
    if (repositoryId === null) return;
    if (blockedReason !== null && !running) return onNotice(blockedReason);
    onDock();
    workbench.readBranches();
    setAdd({ repositoryId, opener, initial });
  }

  /** Reviews and runs one add. It gives the visible refusal text, or null after a run. */
  async function submitAdd(request: AddRequest): Promise<string | null> {
    let error: string | null = null;
    await once(async () => {
      const response = await review({ action: "worktree-add", branch: request.branch, path: request.path });
      if (response === null) return;
      const token = tokenOf(response);
      const plan = planOf(response);
      const display = "new" in request.branch ? request.branch.new : "track" in request.branch ? request.branch.track.name : shortRef(request.branch.existing);
      if (token === null || plan === null || typeof plan.path !== "string") return void (error = worktreeRefusal(response, "worktree-add", request.path, display));
      const done = await run(token, "worktree-add", null);
      if (done?.state !== "succeeded") return;
      setAdd(null);
      onNotice(W.added(plan.path));
      if (request.switchTo) onOpen(plan.path);
    });
    return error;
  }

  const addPanel =
    add === null || add.repositoryId !== repositoryId ? null : (
      // A new selection mounts a new panel, so its fields start from that selection.
      <AddWorktreePanel key={JSON.stringify(add.initial ?? null)} initial={add.initial} workbench={workbench} worktreeRoot={worktreeRoot} start={start} blockedReason={blockedReason} running={running} opener={add.opener} onSubmit={submitAdd} onBrowse={() => bridge.chooseWorktreeFolder({ repositoryId: add.repositoryId })} onClose={() => setAdd(null)} />
    );

  const overlays =
    remove === null ? null : (
      <RemoveConfirm
        overlay={remove}
        onChange={(next) => void reviewRemove(next)}
        onCancel={() => setRemove(null)}
        onConfirm={() => confirmRemove(remove)}
      />
    );

  return {
    /** The newest `readWorktrees` entries of the open repository, or null while they load or after a failed read. */
    entries,
    /** The visible text of a failed read. */
    failure: shown?.failure ?? null,
    current: entries?.find((e) => e.current) ?? null,
    refresh: read,
    removeReason,
    openReason,
    pruneReason,
    open,
    startRemove,
    prune,
    startAdd,
    closeAdd: () => setAdd(null),
    addPanel,
    overlays,
  };
}

export type WorktreeActions = ReturnType<typeof useWorktreeActions>;

/** Spec FR-054 to FR-056: the modal confirmation. Cancel has the first focus, as in the WP12 delete confirmation. */
function RemoveConfirm({ overlay: o, onChange, onCancel, onConfirm }: { overlay: RemoveOverlay; onChange(o: RemoveOverlay): void; onCancel(): void; onConfirm(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const plan = o.plan;
  const dirty = plan !== null && plan.tracked + plan.untracked > 0;
  // Spec FR-055: initialized submodules need the same check box, also without changes.
  const submodules = plan?.submodules === true;
  const needsForce = dirty || submodules;
  const branch = short(o.entry.branch);
  const facts = o.deleteBranch ? (plan?.deleteBranch ?? null) : null;
  const ready = o.token !== null && !o.pending && (!needsForce || o.force);
  return (
    <Dialog open onOpenChange={(next) => void (next || onCancel())}>
      <DialogContent showCloseButton={false} initialFocus={cancel} className="flex flex-col gap-2 sm:max-w-lg">
        <DialogTitle>{W.removeTitle(o.entry.path)}</DialogTitle>
        {plan === null && o.pending ? <p className="text-muted-text">{W.reading}</p> : null}
        {dirty ? (
          <div data-slot="remove-notice" className="flex gap-2 rounded-sm bg-removed-fill p-2">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden="true" className="mt-0.5 size-(--icon-size) shrink-0 text-removed" />
            <div className="flex flex-col">
              <strong className="font-semibold">{W.counts(plan.tracked, plan.untracked)}</strong>
              <p>{W.lostNote}</p>
            </div>
          </div>
        ) : null}
        {submodules ? <p>{W.submodules}</p> : null}
        <p>{W.folderNote}</p>
        {needsForce ? (
          <label className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <input type="checkbox" checked={o.force} onChange={(event) => onChange({ ...o, force: event.target.checked })} />
              {dirty ? W.force : W.forceSubmodules}
            </span>
            {o.force ? null : <span className="ml-6 text-muted-text">{W.forceHint}</span>}
          </label>
        ) : null}
        {branch === null ? null : (
          <label className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <input type="checkbox" checked={o.deleteBranch} onChange={(event) => onChange({ ...o, deleteBranch: event.target.checked })} />
              {W.deleteBranch}
              <code className="text-muted-text">{branch}</code>
            </span>
            {facts === null ? null : (
              <span className="ml-6 flex flex-col">
                <span>{facts.onlyHere > 0 ? B.onlyHere(branch, facts.onlyHere) : B.noneLost(branch)}</span>
                <span>{facts.reflogKeeps ? B.reflogKeeps(facts.oid) : B.noReflog(facts.oid)}</span>
              </span>
            )}
          </label>
        )}
        {o.error === null ? null : <p role="alert">{o.error}</p>}
        <div className="flex justify-end gap-2">
          <Button ref={cancel} variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button className="danger-button" disabled={!ready} focusableWhenDisabled onClick={() => ready && onConfirm()}>
            {dirty ? W.removeForce : submodules ? W.removeSubmodules : W.removeButton}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
