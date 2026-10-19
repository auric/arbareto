// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Copy01Icon, Delete02Icon, GitBranchIcon, GitCompareArrowsIcon, GitMergeIcon, PencilEdit02Icon, PlusSignIcon, Upload04Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import { useCopy } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge } from "../bridge";
import { ActionMenu, type ActionItem } from "../components/action-menu";
import { ConfirmPopover } from "../components/confirm-popover";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { branchName } from "../history/HistoryView";
import { KEYS, type ScopedAction } from "../keyboard/shortcuts";
import { SHOW_BRANCH_HISTORY, shortRef } from "../refs/ReferencesSidebar";
import { isObject } from "../lib/utils";
import type { BranchEntry, Workbench } from "../state/workbench";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import { reviewWithTrust, WORKBENCH_TRUST, type AskTrust } from "../trust/ask";
import { OUTCOME, refusalText, STASH, T } from "./texts";

// Feature 004 spec FR-009 to FR-020, plan.md D3, D4, D15, D16, data-model §3 and §4, contract Δ3 and Δ14.

type Bridge = ReturnType<typeof createBridge>;
type Target = { repositoryId: string; repositoryGeneration: number };
type Choice = "keep" | "stash" | "discard";
type SwitchTarget = { ref: string } | { track: { ref: string; name: string } } | { detach: string };
/** Data-model §3: the plan fields that the confirmation reads. */
type SwitchPlan = { trackedChanges: number; unreachable: string | null; choice: Choice };
/** Data-model §4. */
type DeletePlan = { oid: string; onlyHere: number; reflogKeeps: boolean };

/** The preselected choice. `known` is false when `readSyncSettings` failed, so no choice shows the Default tag. */
type Preset = { choice: Choice; known: boolean };

type Overlay =
  | { kind: "switch"; anchor: Element | null; display: string; target: SwitchTarget; heldBy: string | null; preset: Choice | null; choice: Choice; plan: SwitchPlan | null; token: string | null; error: string | null }
  | { kind: "remote"; anchor: Element | null; entry: BranchEntry; mode: "track" | "detach"; name: string; error: string | null; existing?: string }
  | { kind: "create"; anchor: Element | null; start: string; name: string; switchTo: boolean; error: string | null }
  | { kind: "rename"; anchor: Element | null; entry: BranchEntry; name: string; error: string | null }
  | { kind: "delete"; entry: BranchEntry; plan: DeletePlan | null; token: string | null; error: string | null };

export type BranchActionsOptions = {
  bridge: Pick<Bridge, "reviewWorkbench" | "runWorkbench" | "readSyncSettings">;
  target(): Target | null;
  /** The open repository. A new one reads the branches. */
  repositoryId: string | null;
  /** The newest `readRefs.refsDigest`. Each new value reads the branches again. */
  refsDigest: string | null;
  /** Reports a run to the status bar (`StatusOperation` kind `runWorkbench`). */
  onOperation(op: StatusOperation): void;
  workbench: Workbench;
  head: WorkspaceSnapshot["head"] | null;
  /** The reason that blocks every branch action: an operation in progress, a running mutation, or an unknown state. */
  blockedReason: string | null;
  /** Shows a text in the status bar. Null clears it. */
  onNotice(text: ReactNode): void;
  onOpenWorktree(path: string): void;
  /** The 003 push of the current branch and its unavailable reason. */
  push: { reason: string | null; run(): void };
  onShowBranchHistory(): void;
  /** The WP13 Merge and Rebase panels. Without one, its item states that it cannot start here. `opener` is the row or label that started the action. */
  onMerge?(entry: BranchEntry, opener: Element | null): void;
  onRebase?(entry: BranchEntry, opener: Element | null): void;
  /** Feature 004 plan.md D12 "Ask": a review that needs trust asks once, then runs again. */
  askTrust?: AskTrust;
};

const isRefused = (response: BridgeResponse) => response.state !== "succeeded";
const reviewedOf = (response: BridgeResponse) => (isObject(response.result) && typeof response.result.workbenchToken === "string" && isObject(response.result.plan) ? { token: response.result.workbenchToken, plan: response.result.plan } : null);
const ACTION_NAMES: Record<string, string> = { switch: "Switch", "create-branch": "Create branch", "rename-branch": "Rename", "delete-branch": "Delete" };
// Plan D15: the status bar name, running text, and area heading of each run.
const RUN_TEXTS: Record<string, [string, string, string]> = {
  switch: ["Switch", "Switching", "Switch details"],
  "create-branch": ["Create branch", "Creating branch", "Create branch details"],
  "rename-branch": ["Rename", "Renaming", "Rename details"],
  "delete-branch": ["Delete", "Deleting", "Delete details"],
};

/** The branch actions of the toolbar list, the references sidebar, and the history labels. It returns the actions and their overlays. */
export function useBranchActions(options: BranchActionsOptions) {
  const { bridge, target, repositoryId, refsDigest, onOperation, workbench, head, blockedReason, onNotice, onOpenWorktree, push, onShowBranchHistory, onMerge, onRebase, askTrust } = options;
  const snapshot = () => workbench.getState().branches;
  const branches = useSyncExternalStore(workbench.subscribe, snapshot, snapshot);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [menu, setMenu] = useState<{ ref: string; entry: BranchEntry; anchor: Element } | null>(null);
  const busy = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  // True when the selected menu item opens a panel or a popover that takes the focus. The menu then returns no focus to its row.
  const handoff = useRef(false);

  // A new repository and each new refs digest read the branches. The list and the menu read them again when they open, and the store after each 004 outcome.
  // The store keeps only the newest response of the current repository generation.
  useEffect(() => {
    if (repositoryId !== null) workbench.readBranches();
  }, [workbench, repositoryId, refsDigest]);
  const openMenu = (entry: BranchEntry, anchor: Element) => {
    handoff.current = false;
    setMenu({ ref: entry.ref, entry, anchor });
    workbench.readBranches();
  };
  const [shownFor, setShownFor] = useState(repositoryId);
  if (shownFor !== repositoryId) {
    setShownFor(repositoryId);
    setOverlay(null);
    setMenu(null);
  }

  const entries = branches !== null && branches.repositoryId === repositoryId ? branches.entries : null;
  const current = head?.state === "branch" ? branchName(head.target) : null;
  const entryOf = (ref: string) => entries?.find((e) => e.ref === ref) ?? null;

  /** Data-model §13: `switchChoice` preselects. An unborn HEAD takes Keep changes, because Git can stash only after the first commit. */
  async function preset(): Promise<Preset> {
    if (head?.state === "unborn") return { choice: "keep", known: false };
    const response = await bridge.readSyncSettings();
    if (response.state !== "succeeded" || !isObject(response.result)) return { choice: "keep", known: false };
    return { choice: response.result.switchChoice === "stash" ? "stash" : "keep", known: true };
  }

  async function review(payload: Parameters<Bridge["reviewWorkbench"]>[1]): Promise<BridgeResponse | null> {
    const t = target();
    // The second review takes the generation of the full read after the approval.
    return t === null ? null : reviewWithTrust(() => bridge.reviewWorkbench(target() ?? t, payload), WORKBENCH_TRUST[payload.action], askTrust);
  }

  async function run(token: string, action: string, display: string) {
    const t = target();
    if (t === null) return;
    onNotice(null);
    const texts = RUN_TEXTS[action]!;
    const response = await trackOperation("runWorkbench", undefined, (onProgress) => bridge.runWorkbench({ repositoryId: t.repositoryId }, { workbenchToken: token, start: true }, onProgress), (op) => onOperation({ ...op, texts }));
    workbench.ended("runWorkbench", response);
    onNotice(outcomeText(action, display, response));
  }

  /** Runs `step` once at a time. A second request while one runs does nothing. */
  async function once(step: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    try {
      await step();
    } finally {
      busy.current = false;
    }
  }

  /** Spec FR-009: a pick switches at once on a clean tree. `confirm` (a double-click) always shows the confirmation. */
  function startSwitch(entry: BranchEntry, anchor: Element | null, confirm: boolean) {
    if (blockedReason !== null) return onNotice(blockedReason);
    if (entry.kind === "remote") return setOverlay({ kind: "remote", anchor, entry, mode: "track", name: entry.localName ?? "", error: null });
    const base = { kind: "switch" as const, anchor, display: entry.name, target: { ref: entry.ref }, heldBy: null, preset: null, choice: "keep" as Choice, plan: null, token: null };
    if (entry.current) return confirm ? setOverlay({ ...base, error: T.sameBranch(entry.name) }) : onNotice(T.sameBranch(entry.name));
    // Spec FR-013: a branch that another worktree holds offers Open instead of a switch.
    if (entry.heldBy !== null) return confirm ? setOverlay({ ...base, heldBy: entry.heldBy, error: null }) : onOpenWorktree(entry.heldBy);
    void once(async () => {
      if (confirm) setOverlay({ ...base, error: null });
      await reviewSwitch(base.target, entry.name, anchor, confirm, await preset());
    });
  }

  async function reviewSwitch(switchTarget: SwitchTarget, display: string, anchor: Element | null, confirm: boolean, { choice, known }: Preset) {
    const response = await review({ action: "switch", target: switchTarget, choice });
    if (response === null) return;
    const reviewed = reviewedOf(response);
    if (isRefused(response) || reviewed === null) {
      const text = refusalText(response, display);
      if (confirm) setOverlay((o) => (o?.kind === "switch" ? { ...o, error: text } : o));
      else onNotice(text);
      return;
    }
    const plan = reviewed.plan as SwitchPlan;
    if (!confirm && plan.trackedChanges === 0 && plan.unreachable === null) return run(reviewed.token, "switch", display);
    const shown: Overlay = { kind: "switch", anchor, display, target: switchTarget, heldBy: null, preset: known ? choice : null, choice, plan, token: reviewed.token, error: null };
    // A confirmation that the user closed during the review stays closed.
    setOverlay((o) => (!confirm || (o?.kind === "switch" && o.display === display) ? shown : o));
  }

  function confirmSwitch(o: Extract<Overlay, { kind: "switch" }>) {
    if (o.heldBy !== null) {
      setOverlay(null);
      return onOpenWorktree(o.heldBy);
    }
    void once(async () => {
      let token = o.token;
      // The review token binds the choice, so another choice needs a new review.
      if (o.choice !== o.plan?.choice || token === null) {
        const response = await review({ action: "switch", target: o.target, choice: o.choice });
        if (response === null) return;
        const reviewed = reviewedOf(response);
        if (isRefused(response) || reviewed === null) return setOverlay({ ...o, error: refusalText(response, o.display) });
        // The run needs the facts that the confirmation showed. Other facts show first, and the next confirm runs that plan.
        const plan = reviewed.plan as SwitchPlan;
        if (o.plan === null || plan.trackedChanges !== o.plan.trackedChanges || plan.unreachable !== o.plan.unreachable) return setOverlay({ ...o, plan, token: reviewed.token, error: null });
        token = reviewed.token;
      }
      setOverlay(null);
      await run(token, "switch", o.display);
    });
  }

  function confirmRemote(o: Extract<Overlay, { kind: "remote" }>) {
    const display = o.mode === "track" ? o.name : o.entry.name;
    const switchTarget: SwitchTarget = o.mode === "track" ? { track: { ref: o.entry.ref, name: o.name } } : { detach: o.entry.oid };
    void once(async () => {
      const chosen = await preset();
      const response = await review({ action: "switch", target: switchTarget, choice: chosen.choice });
      if (response === null) return;
      const reviewed = reviewedOf(response);
      if (isRefused(response) || reviewed === null) {
        // Plan D3: a taken track name offers a switch to that branch.
        const r = isObject(response.result) ? response.result : {};
        const existing = r.reason === "name-exists" && typeof r.ref === "string" ? r.ref : undefined;
        return setOverlay({ ...o, error: refusalText(response, display), existing });
      }
      setOverlay(null);
      // The plan decides: with tracked changes or an unreachable commit, the confirmation follows.
      const plan = reviewed.plan as SwitchPlan;
      if (plan.trackedChanges === 0 && plan.unreachable === null) return run(reviewed.token, "switch", display);
      setOverlay({ kind: "switch", anchor: o.anchor, display, target: switchTarget, heldBy: null, preset: chosen.known ? plan.choice : null, choice: plan.choice, plan, token: reviewed.token, error: null });
    });
  }

  /** Switches to the branch that a `name-exists` refusal names. The review decides, so a stale branch list cannot pick the target. */
  function switchExisting(o: Extract<Overlay, { kind: "remote" }>, ref: string) {
    setOverlay(null);
    void once(async () => reviewSwitch({ ref }, shortRef(ref), o.anchor, false, await preset()));
  }

  /** `start` is null on an unborn branch, which has no commit to start from. */
  function startCreate(start: string | null, anchor: Element | null) {
    if (blockedReason !== null) return onNotice(blockedReason);
    if (start === null) return onNotice(T.noCommit);
    setOverlay({ kind: "create", anchor, start, name: "", switchTo: true, error: null });
  }

  function confirmName(o: Extract<Overlay, { kind: "create" | "rename" }>) {
    void once(async () => {
      const payload = o.kind === "create" ? { action: "create-branch" as const, name: o.name, start: o.start, switchTo: o.switchTo } : { action: "rename-branch" as const, ref: o.entry.ref, name: o.name };
      const response = await review(payload);
      if (response === null) return;
      const reviewed = reviewedOf(response);
      if (isRefused(response) || reviewed === null) return setOverlay({ ...o, error: refusalText(response, o.kind === "rename" ? o.entry.name : o.name) });
      setOverlay(null);
      await run(reviewed.token, payload.action, o.name);
    });
  }

  function startDelete(entry: BranchEntry) {
    const reason = reasons(entry).delete;
    if (reason !== null) return onNotice(reason);
    void once(async () => {
      const response = await review({ action: "delete-branch", ref: entry.ref });
      if (response === null) return;
      const reviewed = reviewedOf(response);
      if (reviewed !== null && !isRefused(response)) return setOverlay({ kind: "delete", entry, plan: reviewed.plan as DeletePlan, token: reviewed.token, error: null });
      // Plan D15: the confirmation states `config-in-include`. Other refusals go to the status bar.
      const reason = isObject(response.result) ? response.result.reason : undefined;
      if (reason === "config-in-include") setOverlay({ kind: "delete", entry, plan: null, token: null, error: refusalText(response, entry.name) });
      else onNotice(refusalText(response, entry.name));
    });
  }

  /** The unavailable reason of each action on `entry`, or null (spec FR-014, FR-017, plan D4). */
  function reasons(entry: BranchEntry): Record<ScopedAction | "push", string | null> {
    const isCurrent = entry.kind === "local" && entry.current;
    const noCurrent = head?.state === "detached" ? T.detachedReason : head?.state === "unborn" ? T.noCommit : null;
    const integrate = (own: string, handler: unknown) => (isCurrent ? own : (noCurrent ?? blockedReason ?? (handler === undefined ? T.noPanel : null)));
    return {
      switch: isCurrent ? T.sameBranch(entry.name) : blockedReason,
      merge: integrate(T.mergeCurrent(entry.name), onMerge),
      rebase: integrate(T.rebaseCurrent(entry.name), onRebase),
      createBranch: blockedReason,
      rename: blockedReason,
      delete: isCurrent ? T.deleteCurrent : entry.heldBy !== null ? T.otherWorktree(entry.heldBy) : blockedReason,
      push: isCurrent ? push.reason : T.pushOther,
      stageLines: null,
      unstageLines: null,
      stageEntry: null,
      previousHunk: null,
      nextHunk: null,
      primary: null,
    };
  }

  /** Runs a D15 key or a menu item on `entry`. An unavailable action shows its reason in the status bar. */
  function act(entry: BranchEntry, action: ScopedAction | "push", anchor: Element | null) {
    const reason = reasons(entry)[action];
    if (reason !== null) return onNotice(reason);
    if (action === "switch") startSwitch(entry, anchor, false);
    else if (action === "merge") onMerge?.(entry, anchor);
    else if (action === "rebase") onRebase?.(entry, anchor);
    else if (action === "createBranch") startCreate(entry.oid, anchor);
    else if (action === "rename" && entry.kind === "local") setOverlay({ kind: "rename", anchor, entry, name: entry.name, error: null });
    else if (action === "delete" && entry.kind === "local") startDelete(entry);
    else if (action === "push") push.run();
  }

  function menuGroups(entry: BranchEntry, copy: (text: string) => void): ActionItem[][] {
    const r = reasons(entry);
    const item = (label: string, action: ScopedAction | "push", icon: IconSvgElement, danger = false): ActionItem => ({
      label,
      icon,
      keys: action === "push" ? undefined : { aria: KEYS[action].aria, text: KEYS[action].text },
      reason: r[action],
      danger,
      onSelect: () => {
        // Base UI returns the menu focus after the new panel or popover took it, so these items keep the focus where they put it.
        handoff.current = r[action] === null && (action === "merge" || action === "rebase" || action === "createBranch" || action === "rename" || (action === "switch" && entry.kind === "remote"));
        setMenu(null);
        act(entry, action, menu?.anchor ?? null);
      },
    });
    // D16 "Branch menu groups": (1) Switch, Merge, Rebase; (2) Create branch here, Rename, Delete; (3) Push, Copy branch name.
    const copyItem: ActionItem = { label: T.copy, icon: Copy01Icon, onSelect: () => (setMenu(null), copy(entry.name)) };
    const integrate = [item(T.switch, "switch", GitBranchIcon), item(T.merge(current), "merge", GitMergeIcon), item(T.rebase(current, entry.name), "rebase", GitCompareArrowsIcon)];
    const create = item(T.createHere, "createBranch", PlusSignIcon);
    if (entry.kind === "remote") return [integrate, [create], [copyItem]];
    const groups = [integrate, [create, item(T.rename, "rename", PencilEdit02Icon), item(T.delete, "delete", Delete02Icon, true)], [item(T.push, "push", Upload04Icon), copyItem]];
    // 002 FR-049 change: the item stays on the current branch.
    if (entry.current) groups.push([{ label: SHOW_BRANCH_HISTORY, keys: { aria: "Control+Shift+B", text: "Ctrl+Shift+B" }, onSelect: () => (setMenu(null), onShowBranchHistory()) }]);
    return groups;
  }

  const overlays = (
    <>
      {menu === null ? null : (
        <BranchMenu label={T.menu(menu.entry.name)} groups={(copy) => menuGroups(entryOf(menu.ref) ?? menu.entry, copy)} anchor={menu.anchor} handoff={handoff} onClose={() => setMenu(null)} />
      )}
      {overlay?.kind === "switch" ? <SwitchConfirm overlay={overlay} unborn={head?.state === "unborn"} onChange={setOverlay} onConfirm={() => confirmSwitch(overlay)} onCancel={() => setOverlay(null)} /> : null}
      {overlay?.kind === "remote" ? (
        <ConfirmPopover
          open
          anchor={overlay.anchor}
          title={T.switchTitle(overlay.entry.name)}
          confirmLabel={overlay.mode === "track" ? T.createSwitch : T.switch}
          onConfirm={overlay.mode === "track" && overlay.name === "" ? undefined : () => confirmRemote(overlay)}
          onCancel={() => setOverlay(null)}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{T.switchTitle(overlay.entry.name)}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="remote-mode" checked={overlay.mode === "track"} onChange={() => setOverlay({ ...overlay, mode: "track", error: null, existing: undefined })} />
              {T.createLocal}
            </label>
            {overlay.mode === "track" ? (
              <div className="ml-6 flex flex-col gap-1">
                <input
                  aria-label={T.branchName}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-(--h-button) rounded-sm border border-control-border bg-surface px-2"
                  value={overlay.name}
                  onChange={(event) => setOverlay({ ...overlay, name: event.target.value, error: null, existing: undefined })}
                />
                <p className="text-muted-text">{T.tracks(overlay.entry.name)}</p>
              </div>
            ) : null}
            <label className="flex items-center gap-2">
              <input type="radio" name="remote-mode" checked={overlay.mode === "detach"} onChange={() => setOverlay({ ...overlay, mode: "detach", error: null, existing: undefined })} />
              {T.detach}
            </label>
            {overlay.mode === "detach" ? <p className="ml-6 text-muted-text">{T.detachNote}</p> : null}
          </fieldset>
          {overlay.error === null ? null : <p role="alert">{overlay.error}</p>}
          {overlay.existing === undefined ? null : (
            <Button variant="outline" className="self-start" onClick={() => switchExisting(overlay, overlay.existing!)}>
              {T.switchExisting(shortRef(overlay.existing))}
            </Button>
          )}
        </ConfirmPopover>
      ) : null}
      {overlay?.kind === "create" || overlay?.kind === "rename" ? (
        <ConfirmPopover
          open
          anchor={overlay.anchor}
          title={overlay.kind === "create" ? T.createTitle(overlay.start) : T.renameTitle(overlay.entry.name)}
          confirmLabel={overlay.kind === "create" ? T.create : T.renameButton}
          initialFocus={field}
          onConfirm={overlay.name === "" ? undefined : () => confirmName(overlay)}
          onCancel={() => setOverlay(null)}
        >
          <input
            ref={field}
            aria-label={overlay.kind === "create" ? T.branchName : T.newName}
            aria-invalid={overlay.error !== null}
            spellCheck={false}
            autoComplete="off"
            className="h-(--h-button) rounded-sm border border-control-border bg-surface px-2"
            value={overlay.name}
            onChange={(event) => setOverlay({ ...overlay, name: event.target.value, error: null })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && overlay.name !== "") {
                event.preventDefault();
                confirmName(overlay);
              }
            }}
          />
          {overlay.kind === "create" ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={overlay.switchTo} onChange={(event) => setOverlay({ ...overlay, switchTo: event.target.checked })} />
              {T.switchNew}
            </label>
          ) : null}
          {overlay.error === null ? null : <p role="alert">{overlay.error}</p>}
        </ConfirmPopover>
      ) : null}
      {overlay?.kind === "delete" ? (
        <DeleteConfirm
          overlay={overlay}
          onCancel={() => setOverlay(null)}
          onConfirm={(token) => {
            setOverlay(null);
            void once(() => run(token, "delete-branch", overlay.entry.name));
          }}
        />
      ) : null}
    </>
  );

  return {
    /** The newest `readBranches` entries of the open repository, or null while they load or after a failed read. */
    entries,
    /** The code of a failed `readBranches`. */
    failure: branches !== null && branches.repositoryId === repositoryId && branches.entries === null ? branches.code : null,
    entryOf,
    /** A pick in the toolbar list. */
    pick: (entry: BranchEntry, anchor: Element | null) => startSwitch(entry, anchor, false),
    /** A double-click on a sidebar row: the confirmation always opens. */
    confirm: (entry: BranchEntry, anchor: Element | null) => startSwitch(entry, anchor, true),
    act,
    openMenu,
    /** Reads the branches again, such as when the list opens. */
    refresh: () => workbench.readBranches(),
    /** A sidebar row or a history label by its 002 kind and short name. A ref outside the newest `readBranches` result does nothing. */
    onRef(kind: "branch" | "remote", name: string, action: "menu" | "confirm" | ScopedAction, anchor: HTMLElement) {
      const entry = entryOf(`${kind === "branch" ? "refs/heads/" : "refs/remotes/"}${name}`);
      if (entry === null) return;
      if (action === "menu") openMenu(entry, anchor);
      else if (action === "confirm") startSwitch(entry, anchor, true);
      else act(entry, action, anchor);
    },
    /** New branch… in the list, and Ctrl+B on a history row. */
    create: startCreate,
    overlays,
  };
}

/** The menu reads the copy helper inside the `CopyFailed` provider of the window. */
function BranchMenu({ label, groups, anchor, handoff, onClose }: { label: string; groups(copy: (text: string) => void): ActionItem[][]; anchor: Element; handoff: RefObject<boolean>; onClose(): void }) {
  const copy = useCopy();
  return <ActionMenu label={label} groups={groups(copy)} open anchor={anchor} finalFocus={() => (handoff.current ? false : (anchor as HTMLElement))} onOpenChange={(next) => void (next || onClose())} />;
}

function outcomeText(action: string, display: string, response: BridgeResponse): ReactNode {
  const r = isObject(response.result) ? response.result : {};
  const stash = isObject(r.stash) && typeof r.stash.state === "string" && r.stash.state in STASH ? STASH[r.stash.state]!(typeof r.stash.oid === "string" ? r.stash.oid : "") : null;
  const remedy = isObject(r.remedy) ? r.remedy : null;
  const lead =
    response.state !== "succeeded"
      ? OUTCOME.failed(ACTION_NAMES[action] ?? action, response.code ?? response.state)
      : action === "switch"
        ? OUTCOME.switched(display)
        : action === "create-branch"
          ? OUTCOME.created(display)
          : action === "rename-branch"
            ? OUTCOME.renamed(display)
            : OUTCOME.deleted(display);
  return (
    <>
      {[lead, stash, typeof remedy?.text === "string" ? remedy.text : null].filter((part) => part !== null).join(" ")}
      {typeof remedy?.command === "string" ? (
        <>
          {" "}
          <code>{remedy.command}</code>
        </>
      ) : null}
    </>
  );
}

const CHOICES: { value: Choice; label: string }[] = [
  { value: "keep", label: T.keep },
  { value: "stash", label: T.stash },
  { value: "discard", label: T.discard },
];

function SwitchConfirm({ overlay: o, unborn, onChange, onConfirm, onCancel }: { overlay: Extract<Overlay, { kind: "switch" }>; unborn: boolean; onChange(o: Overlay): void; onConfirm(): void; onCancel(): void }) {
  const plan = o.plan;
  const ready = o.error === null && (o.heldBy !== null || plan !== null);
  const notes: Record<Choice, string> = { keep: T.keepNote(o.display), stash: T.stashNote, discard: T.discardNote };
  return (
    <ConfirmPopover
      open
      anchor={o.anchor}
      title={T.switchTitle(o.display)}
      confirmLabel={o.heldBy !== null ? T.open(o.heldBy) : o.choice === "discard" ? T.discardSwitch : T.switch}
      danger={o.heldBy === null && o.choice === "discard"}
      onConfirm={ready ? onConfirm : undefined}
      onCancel={onCancel}
    >
      {o.heldBy !== null ? <p>{T.otherWorktree(o.heldBy)}</p> : null}
      {o.error !== null ? <p role="alert">{o.error}</p> : null}
      {o.error === null && o.heldBy === null && plan === null ? <p className="text-muted-text">Loading…</p> : null}
      {plan?.unreachable ? <p>{T.unreachable(plan.unreachable)}</p> : null}
      {plan !== null && plan.trackedChanges > 0 ? (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2">{T.tracked(plan.trackedChanges)}</legend>
            {CHOICES.map(({ value, label }) => {
              // Plan D3: Git can stash only after the first commit.
              const off = unborn && value !== "keep";
              return (
                <label key={value} className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <input type="radio" name="switch-choice" checked={o.choice === value} disabled={off} onChange={() => onChange({ ...o, choice: value, error: null })} />
                    <span className={value === "discard" ? "danger-text" : undefined}>{label}</span>
                    {value === o.preset ? <span className="chip">{T.defaultTag}</span> : null}
                  </span>
                  <span className="ml-6 text-muted-text">{off ? T.unborn : notes[value]}</span>
                </label>
              );
            })}
          </fieldset>
          <p className="text-muted-text">{T.settingsNote}</p>
        </>
      ) : null}
    </ConfirmPopover>
  );
}

function DeleteConfirm({ overlay: o, onCancel, onConfirm }: { overlay: Extract<Overlay, { kind: "delete" }>; onCancel(): void; onConfirm(token: string): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const plan = o.plan;
  return (
    <Dialog open onOpenChange={(next) => void (next || onCancel())}>
      <DialogContent showCloseButton={false} initialFocus={cancel} className="flex flex-col gap-2 sm:max-w-lg">
        <DialogTitle>{T.deleteTitle(o.entry.name)}</DialogTitle>
        {o.error !== null ? <p role="alert">{o.error}</p> : null}
        {plan === null ? null : (
          <>
            <p>{plan.onlyHere > 0 ? T.onlyHere(o.entry.name, plan.onlyHere) : T.noneLost(o.entry.name)}</p>
            <p>{plan.reflogKeeps ? T.reflogKeeps(plan.oid) : T.noReflog(plan.oid)}</p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button ref={cancel} variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {plan === null || o.token === null ? null : (
            <Button className="danger-button" onClick={() => onConfirm(o.token!)}>
              {T.deleteButton}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
