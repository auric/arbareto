// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon, ArrowTurnBackwardIcon, CherryIcon, Copy01Icon, GitBranchIcon, GitCommitIcon, Tag01Icon, Undo03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import { MERGE_MESSAGE_BYTES } from "../../contracts/limits";
import { tagNameRefusal } from "../../contracts/tag-name";
import { useCopy } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge } from "../bridge";
import { refusalText } from "../branches/texts";
import { ActionMenu, type ActionItem } from "../components/action-menu";
import { ConfirmPopover } from "../components/confirm-popover";
import { AlertConfirm } from "../changes/RevertConfirm";
import { TEXTS } from "../integrate/texts";
import { KEYS } from "../keyboard/shortcuts";
import { isObject } from "../lib/utils";
import { shortRef } from "../refs/ReferencesSidebar";
import type { Workbench } from "../state/workbench";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import { reviewWithTrust, WORKBENCH_TRUST, type AskTrust } from "../trust/ask";
import { AT_COMMIT, CLOSE_NAMES, EXPIRED, ITEM_BRANCH, ITEM_CHECKOUT, ITEM_COPY, ITEM_PICK, ITEM_RESET, ITEM_REVERT, ITEM_TAG, MENU_NAME, PICK, RESET, REVIEW_PENDING, RUNNING, TAG, TAG_REASON } from "./commit-texts";
import { branchName } from "./HistoryView";

// Feature 010 spec FR-010 to FR-015, FR-020 to FR-022, FR-030, FR-040, FR-044, FR-050. Plan D1 to D5, D11, D13 "Actions hook" and "Hard dialog". Data-model §1, §3, §4.

type Bridge = ReturnType<typeof createBridge>;
type Target = { repositoryId: string; repositoryGeneration: number };
type Head = WorkspaceSnapshot["head"];
type Mode = "soft" | "mixed" | "hard";
type PickAction = "cherry-pick" | "revert-commit";
type RunAction = PickAction | "reset" | "create-tag";
type Parent = { oid: string; subject: string | null };
type Payload = Parameters<Bridge["reviewWorkbench"]>[1];
/** Data-model §3 `ResetPlan`: the fields that the popover and the dialog read. */
type ResetPlan = { mode: Mode; branch: string; leave: number; gain: number; reflogOnly: number; forceNote: { trackingRef: string } | null; trackedChanges: number; ignoredReplaced: number };
type Signs = { light: boolean; annotated: boolean };

type Overlay =
  | { kind: "tag"; anchor: Element | null; oid: string; name: string; annotated: boolean; message: string; signs: Signs | null; error: string | null }
  | { kind: "reset"; anchor: Element | null; oid: string; mode: Mode; plan: ResetPlan | null; token: string | null; error: string | null; inTheWay: { paths: string[]; more: number } | null }
  | { kind: "hard"; anchor: Element | null; oid: string; plan: ResetPlan; token: string }
  | { kind: "pick"; action: PickAction; anchor: Element | null; oid: string; mainline: number | null; parents: Parent[]; branch: string | null; token: string | null; pending: boolean; error: string | null; note: string | null };

export type CommitActionsOptions = {
  bridge: Pick<Bridge, "reviewWorkbench" | "runWorkbench">;
  target(): Target | null;
  repositoryId: string | null;
  head: Head | null;
  /** Plan D1 "Availability": the reason that blocks every item but Copy, or null. */
  blockedReason: string | null;
  /** `blockedReason` is the running or the reconcile reason. It then shows only in the tooltip and the accessible description. */
  blockedRunning: boolean;
  onOperation(op: StatusOperation): void;
  onNotice(text: ReactNode): void;
  workbench: Pick<Workbench, "ended">;
  /** The 004 actions that the menu reuses (plan D2). */
  branches: { checkout(oid: string, anchor: Element | null): void; create(start: string | null, anchor: Element | null, commit: boolean): void };
  askTrust?: AskTrust;
};

const reviewedOf = (response: BridgeResponse) => (response.state === "succeeded" && isObject(response.result) && isObject(response.result.plan) ? { plan: response.result.plan, token: typeof response.result.workbenchToken === "string" ? response.result.workbenchToken : null } : null);
const reasonOf = (response: BridgeResponse) => (isObject(response.result) && typeof response.result.reason === "string" ? response.result.reason : null);
const parentsOf = (value: unknown): Parent[] => (Array.isArray(value) ? value.filter((p): p is Parent => isObject(p) && typeof p.oid === "string" && (typeof p.subject === "string" || p.subject === null)) : []);
const invalid = { requestId: "", state: "rejected", code: "INVALID_REQUEST" } as BridgeResponse;
const BLANK = /^[ \t\n\r]*$/;

/** The menu, the popovers, and the Hard dialog of a History commit row. */
export function useCommitActions({ bridge, target, repositoryId, head, blockedReason, blockedRunning, onOperation, onNotice, workbench, branches, askTrust }: CommitActionsOptions) {
  const [menu, setMenu] = useState<{ oid: string; anchor: Element; byKey: boolean; merge: boolean; pointerX: number | null } | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  // Each review takes a number. A response of an older review or of a closed popover changes nothing.
  const seq = useRef(0);
  const busy = useRef(false);
  // True when the selected item opens a popover that takes the focus. The menu then returns no focus to the list.
  const handoff = useRef(false);
  const field = useRef<HTMLElement | null>(null);
  const [shownFor, setShownFor] = useState(repositoryId);
  if (shownFor !== repositoryId) {
    setShownFor(repositoryId);
    setMenu(null);
    setOverlay(null);
  }

  const current = head === null || head.state === "detached" ? null : branchName(head.target);
  const listOf = (anchor: Element | null) => (anchor?.closest<HTMLElement>('[role="listbox"]') ?? null) as HTMLElement | null;

  async function review(payload: Payload): Promise<BridgeResponse | null> {
    const t = target();
    return t === null ? null : reviewWithTrust(() => bridge.reviewWorkbench(target() ?? t, payload), WORKBENCH_TRUST[payload.action], askTrust);
  }
  /** Reviews `payload` and applies the newest response only. */
  async function reviewLatest(payload: Payload, apply: (response: BridgeResponse) => void) {
    const mine = ++seq.current;
    const response = await review(payload);
    if (response !== null && mine === seq.current) apply(response);
  }
  const close = () => {
    seq.current++;
    setOverlay(null);
  };

  async function run(token: string, action: RunAction, done: (response: BridgeResponse) => Partial<StatusOperation>) {
    const t = target();
    if (t === null || busy.current) return;
    busy.current = true;
    try {
      onNotice(null);
      const name = CLOSE_NAMES[action];
      const texts: [string, string, string] = [name, RUNNING[action], `${name} details`];
      const response = await trackOperation(
        "runWorkbench",
        undefined,
        (onProgress) => bridge.runWorkbench({ repositoryId: t.repositoryId }, { workbenchToken: token, start: true }, onProgress),
        (op) => onOperation({ ...op, texts, ...(op.response === null ? {} : op.response.code === "APPROVAL_EXPIRED" ? { outcome: EXPIRED(name) } : done(op.response)) }),
      );
      workbench.ended("runWorkbench", response);
    } finally {
      busy.current = false;
    }
  }

  // ---- Menu (plan D1) ----

  function reasons(oid: string) {
    const noBranch = head?.state === "detached" ? TEXTS.detached : head?.state === "unborn" ? TEXTS.unborn : null;
    return {
      checkout: blockedReason ?? (head?.state === "detached" && head.oid === oid ? AT_COMMIT : null),
      branch: blockedReason,
      tag: blockedReason,
      pick: blockedReason ?? noBranch,
      revert: blockedReason ?? noBranch,
      reset: blockedReason ?? noBranch,
    };
  }

  function groups(m: NonNullable<typeof menu>, copy: (text: string) => void): ActionItem[][] {
    const r = reasons(m.oid);
    const item = (label: string, icon: IconSvgElement, reason: string | null, start: () => void, keys?: ActionItem["keys"]): ActionItem => ({
      label,
      icon,
      keys,
      reason,
      running: blockedRunning && reason !== null && reason === blockedReason,
      onSelect: () => {
        handoff.current = reason === null;
        setMenu(null);
        if (reason === null) start();
      },
    });
    return [
      [
        item(ITEM_CHECKOUT, GitCommitIcon, r.checkout, () => branches.checkout(m.oid, m.anchor)),
        item(ITEM_BRANCH, GitBranchIcon, r.branch, () => branches.create(m.oid, m.anchor, true), { aria: KEYS.createBranch.aria, text: KEYS.createBranch.text }),
        item(ITEM_TAG, Tag01Icon, r.tag, () => startTag(m.oid, m.anchor)),
      ],
      [item(ITEM_PICK, CherryIcon, r.pick, () => startPick("cherry-pick", m.oid, m.anchor, m.merge)), item(ITEM_REVERT, Undo03Icon, r.revert, () => startPick("revert-commit", m.oid, m.anchor, m.merge))],
      [item(ITEM_RESET(head?.state === "detached" ? null : current), ArrowTurnBackwardIcon, r.reset, () => startReset(m.oid, m.anchor))],
      [{ label: ITEM_COPY, icon: Copy01Icon, onSelect: () => (setMenu(null), copy(m.oid)) }],
    ];
  }

  // ---- Create tag (plan D3) ----

  function startTag(oid: string, anchor: Element | null) {
    setOverlay({ kind: "tag", anchor, oid, name: "", annotated: false, message: "", signs: null, error: null });
    void reviewLatest({ action: "create-tag", name: null, target: oid, message: null }, (response) => {
      const reviewed = reviewedOf(response);
      const signs = reviewed !== null && isObject(reviewed.plan.signs) ? (reviewed.plan.signs as Signs) : null;
      setOverlay((o) => (o?.kind === "tag" && o.oid === oid ? { ...o, signs, error: reviewed === null ? tagRefusal(response, o.name) : o.error } : o));
    });
  }

  function confirmTag(o: Extract<Overlay, { kind: "tag" }>) {
    void reviewLatest({ action: "create-tag", name: o.name, target: o.oid, message: o.annotated ? o.message : null }, (response) => {
      const reviewed = reviewedOf(response);
      if (reviewed === null || reviewed.token === null) {
        setOverlay((x) => (x?.kind === "tag" ? { ...x, error: tagRefusal(response, o.name) } : x));
        // Mockup board 5: the refusal names the tag name, so Tag name takes the focus.
        return field.current?.focus();
      }
      close();
      void run(reviewed.token, "create-tag", (r) => (r.state === "succeeded" ? { outcome: TAG.done(o.name, o.oid) } : {}));
    });
  }

  // ---- Reset (plan D4) ----

  function reviewReset(oid: string, mode: Mode) {
    void reviewLatest({ action: "reset", target: oid, mode }, (response) => {
      const reviewed = reviewedOf(response);
      const r = isObject(response.result) ? response.result : {};
      const inTheWay = response.code === "UNTRACKED_IN_WAY" && Array.isArray(r.paths) ? { paths: r.paths.filter((p): p is string => typeof p === "string"), more: typeof r.more === "number" ? r.more : 0 } : null;
      setOverlay((o) =>
        o?.kind === "reset" && o.oid === oid
          ? reviewed !== null && reviewed.token !== null
            ? { ...o, plan: reviewed.plan as ResetPlan, token: reviewed.token, error: null, inTheWay: null }
            : { ...o, plan: null, token: null, inTheWay, error: inTheWay === null ? refusalText(response, current ?? "") : null }
          : o,
      );
    });
  }

  function startReset(oid: string, anchor: Element | null) {
    // User decision 2026-11-04: Mixed is preselected each time.
    setOverlay({ kind: "reset", anchor, oid, mode: "mixed", plan: null, token: null, error: null, inTheWay: null });
    reviewReset(oid, "mixed");
  }

  function confirmReset(o: Extract<Overlay, { kind: "reset" }>) {
    if (o.plan === null || o.token === null) return;
    if (o.mode === "hard") return setOverlay({ kind: "hard", anchor: o.anchor, oid: o.oid, plan: o.plan, token: o.token });
    close();
    void runReset(o.token, o.oid, o.plan);
  }

  const runReset = (token: string, oid: string, plan: ResetPlan) => run(token, "reset", (r) => (r.state === "succeeded" ? { outcome: RESET.done(branchName(plan.branch), oid) } : {}));

  // ---- Cherry-pick and Revert (plan D5) ----

  function reviewPick(action: PickAction, oid: string, mainline: number | null) {
    const update = (change: (o: Extract<Overlay, { kind: "pick" }>) => Overlay) => setOverlay((o) => (o?.kind === "pick" && o.oid === oid ? change(o) : o));
    update((o) => ({ ...o, mainline, token: null, pending: true, error: null }));
    void reviewLatest({ action, commit: oid, mainline }, (response) => {
      const reviewed = reviewedOf(response);
      const reason = response.code === "WORKBENCH_UNAVAILABLE" ? reasonOf(response) : null;
      if (reviewed !== null && reviewed.token !== null) {
        const plan = reviewed.plan;
        return update((o) => ({ ...o, parents: parentsOf(plan.parents), mainline: typeof plan.mainline === "number" ? plan.mainline : null, branch: typeof plan.branch === "string" ? branchName(plan.branch) : o.branch, token: reviewed.token, pending: false }));
      }
      // Plan D5: the refusal names the parents. Parent 1 is preselected, and the popover reviews with it.
      if (reason === "mainline-needed") {
        update((o) => ({ ...o, parents: parentsOf(isObject(response.result) ? response.result.parents : undefined), note: null }));
        return reviewPick(action, oid, 1);
      }
      // The next Cherry-pick or Revert reviews again without a parent. No review starts by itself, so two refusals cannot alternate.
      if (reason === "not-merge") return update((o) => ({ ...o, parents: [], mainline: null, pending: false, note: PICK.notMerge }));
      update((o) => ({ ...o, pending: false, error: pickRefusal(response, action === "cherry-pick", o.branch ?? current ?? "") }));
    });
  }

  function startPick(action: PickAction, oid: string, anchor: Element | null, merge: boolean) {
    // Plan D5: a row with two or more parents sends mainline 1.
    const mainline = merge ? 1 : null;
    setOverlay({ kind: "pick", action, anchor, oid, mainline, parents: [], branch: current, token: null, pending: true, error: null, note: null });
    reviewPick(action, oid, mainline);
  }

  function confirmPick(o: Extract<Overlay, { kind: "pick" }>) {
    if (o.token === null) return reviewPick(o.action, o.oid, o.mainline);
    const pick = o.action === "cherry-pick";
    const branch = o.branch ?? "";
    close();
    void run(o.token, o.action, (r) => {
      const result = isObject(r.result) ? r.result : {};
      if (r.state === "succeeded") return { outcome: PICK.done(pick, o.oid, branch) };
      if (r.state !== "failed-with-effects" || (result.operationState !== "cherry-picking" && result.operationState !== "reverting")) return {};
      const unmerged = typeof result.unmerged === "number" ? result.unmerged : 0;
      return unmerged > 0 ? { outcome: PICK.stoppedConflicts(pick, unmerged) } : { outcome: PICK.stopped(pick), opens: typeof result.outputTail === "string" };
    });
  }

  // ---- Overlays ----

  const focusList = (anchor: Element | null) => () => listOf(anchor) ?? true;
  const fieldRef = (element: HTMLElement | null) => void (element === null || (field.current = element));

  const overlays = (
    <>
      {menu === null ? null : <CommitMenu label={MENU_NAME(menu.oid)} groups={(copy) => groups(menu, copy)} anchor={menu.anchor} pointerX={menu.pointerX} byKey={menu.byKey} handoff={handoff} onClose={() => setMenu(null)} />}
      {overlay?.kind === "tag" ? <TagPopover o={overlay} field={field} fieldRef={fieldRef} finalFocus={focusList(overlay.anchor)} onChange={setOverlay} onConfirm={() => confirmTag(overlay)} onCancel={close} /> : null}
      {overlay?.kind === "reset" ? (
        <ResetPopover
          o={overlay}
          branch={current ?? ""}
          field={field}
          fieldRef={fieldRef}
          finalFocus={focusList(overlay.anchor)}
          onMode={(mode) => {
            setOverlay({ ...overlay, mode, plan: null, token: null, error: null, inTheWay: null });
            reviewReset(overlay.oid, mode);
          }}
          onConfirm={() => confirmReset(overlay)}
          onCancel={close}
        />
      ) : null}
      {overlay?.kind === "hard" ? (
        <AlertConfirm
          title={RESET.hardTitle(branchName(overlay.plan.branch), overlay.oid)}
          body={RESET.hardBody(overlay.plan.trackedChanges, overlay.oid)}
          paths={null}
          more={null}
          notices={[...(overlay.plan.ignoredReplaced > 0 ? [RESET.hardIgnored(overlay.plan.ignoredReplaced, overlay.oid)] : []), ...(overlay.plan.reflogOnly > 0 ? [RESET.reflog(overlay.plan.reflogOnly)] : [])]}
          button={RESET.hardConfirm}
          cancel={RESET.hardCancel}
          onConfirm={() => {
            close();
            void runReset(overlay.token, overlay.oid, overlay.plan);
          }}
          onCancel={close}
          finalFocus={focusList(overlay.anchor)}
        />
      ) : null}
      {overlay?.kind === "pick" ? (
        <PickPopover
          o={overlay}
          field={field}
          fieldRef={fieldRef}
          finalFocus={focusList(overlay.anchor)}
          onParent={(mainline) => reviewPick(overlay.action, overlay.oid, mainline)}
          onConfirm={() => confirmPick(overlay)}
          onCancel={close}
        />
      ) : null}
    </>
  );

  return {
    /** Plan D13 "Menu": a right-click, Shift+F10, or the Menu key on a commit row. `merge` is true for a row with two or more parents. */
    openMenu(oid: string, anchor: Element, byKey: boolean, merge: boolean, pointerX?: number) {
      handoff.current = false;
      setMenu({ oid, anchor, byKey, merge, pointerX: byKey || pointerX === undefined ? null : pointerX });
    },
    overlays,
  };
}

/** The D11 text of a Create tag refusal. Other codes use the 004 fallback (plan D11). */
function tagRefusal(response: BridgeResponse, name: string): string {
  const reason = reasonOf(response);
  return response.code === "WORKBENCH_UNAVAILABLE" && reason !== null && Object.hasOwn(TAG_REASON, reason) ? TAG_REASON[reason]!(name) : refusalText(response, name);
}

function pickRefusal(response: BridgeResponse, pick: boolean, branch: string): string {
  const reason = response.code === "WORKBENCH_UNAVAILABLE" ? reasonOf(response) : null;
  if (reason === "already-on-branch") return PICK.alreadyOnBranch(branch);
  if (reason === "dirty-tree") return PICK.dirtyTree(pick);
  return refusalText(response, branch);
}

/** The menu reads the copy helper inside the `CopyFailed` provider of the window. */
function CommitMenu({ label, groups, anchor, pointerX, byKey, handoff, onClose }: { label: string; groups(copy: (text: string) => void): ActionItem[][]; anchor: Element; pointerX: number | null; byKey: boolean; handoff: RefObject<boolean>; onClose(): void }) {
  const copy = useCopy();
  // Mockup default 2: a right-click anchors the menu below the row at the pointer x. A key anchors it below the row start.
  const at = useMemo(() => (pointerX === null ? anchor : { contextElement: anchor, getBoundingClientRect: () => { const row = anchor.getBoundingClientRect(); return new DOMRect(pointerX, row.top, 0, row.height); } }), [anchor, pointerX]);
  // Mockup default 3: a menu with an unavailable item has width 320, so each reason wraps below its label.
  const items = groups(copy);
  const reasoned = items.some((group) => group.some((item) => item.reason != null));
  // The option is no focus target under aria-activedescendant, so the focus goes back to its list.
  return <ActionMenu label={label} groups={items} open anchor={at} side="bottom" width={reasoned ? 320 : undefined} byKey={byKey} finalFocus={() => (handoff.current ? false : (anchor.closest<HTMLElement>('[role="listbox"]') ?? true))} onOpenChange={(next) => void (next || onClose())} />;
}

type PopoverParts = { field: RefObject<HTMLElement | null>; fieldRef(element: HTMLElement | null): void; finalFocus(): HTMLElement | boolean; onCancel(): void; onConfirm(): void };

/** A radio with its label and its Muted hint below, as in the 004 switch choices. */
function Choice({ name, checked, label, hint, danger = false, inputRef, onSelect }: { name: string; checked: boolean; label: string; hint?: string; danger?: boolean; inputRef?: (element: HTMLElement | null) => void; onSelect(): void }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2">
        <input ref={inputRef} type="radio" name={name} checked={checked} onChange={onSelect} />
        <span className={danger ? "danger-text" : undefined}>{label}</span>
      </span>
      {hint === undefined ? null : <span className="ml-6 text-muted-text">{hint}</span>}
    </label>
  );
}

const inputClass = "rounded-sm border border-control-border bg-surface px-2";

function TagPopover({ o, field, fieldRef, finalFocus, onChange, onConfirm, onCancel }: PopoverParts & { o: Extract<Overlay, { kind: "tag" }>; onChange(o: Overlay): void }) {
  const signsLight = !o.annotated && o.signs?.light === true;
  const bytes = new TextEncoder().encode(o.message).length;
  // The contract refuses these requests before the service, so they are never sent (contract Δ3 TagName and TagMessage).
  const requestInvalid = (o.name !== "" && tagNameRefusal(o.name)?.code === "INVALID_REQUEST") || (o.annotated && !BLANK.test(o.message) && (!o.message.isWellFormed() || o.message.includes("\u0000")));
  const reason =
    o.name === "" ? { reason: null }
    : signsLight ? { reason: TAG_REASON["tag-signing"]!(o.name) }
    : o.annotated && BLANK.test(o.message) ? { reason: TAG.messageNeeded }
    : o.annotated && bytes > MERGE_MESSAGE_BYTES ? { reason: TAG_REASON["message-size"]!(o.name) }
    : requestInvalid ? { reason: refusalText(invalid, o.name) }
    : undefined;
  return (
    <ConfirmPopover open anchor={o.anchor} title={TAG.title(o.oid)} confirmLabel={TAG.button} initialFocus={field} finalFocus={finalFocus} unavailable={reason} onConfirm={onConfirm} onCancel={onCancel}>
      <label className="flex flex-col gap-1">
        <span>{TAG.name}</span>
        <input
          ref={fieldRef}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={o.error !== null}
          className={`h-(--h-button) ${inputClass}`}
          value={o.name}
          onChange={(event) => onChange({ ...o, name: event.target.value, error: null })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && reason === undefined) {
              event.preventDefault();
              onConfirm();
            }
          }}
        />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2">{TAG.kind}</legend>
        <Choice name="tag-kind" checked={!o.annotated} label={TAG.light} hint={TAG.lightHint} onSelect={() => onChange({ ...o, annotated: false, message: "", error: null })} />
        <Choice name="tag-kind" checked={o.annotated} label={TAG.annotated} hint={TAG.annotatedHint} onSelect={() => onChange({ ...o, annotated: true, error: null })} />
      </fieldset>
      <label className="flex flex-col gap-1">
        <span>{TAG.message}</span>
        {/* Plan D3: a typed message selects Annotated tag. */}
        <textarea rows={3} className={`py-1 ${inputClass}`} value={o.message} onChange={(event) => onChange({ ...o, message: event.target.value, annotated: event.target.value === "" ? o.annotated : true, error: null })} />
      </label>
      {o.annotated && o.signs?.annotated === true ? <p>{TAG.signs}</p> : null}
      {o.error === null ? null : <p role="alert">{o.error}</p>}
    </ConfirmPopover>
  );
}

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: "soft", label: RESET.soft, hint: RESET.softHint },
  { mode: "mixed", label: RESET.mixed, hint: RESET.mixedHint },
  { mode: "hard", label: RESET.hard, hint: RESET.hardHint },
];

function ResetPopover({ o, branch, field, fieldRef, finalFocus, onMode, onConfirm, onCancel }: PopoverParts & { o: Extract<Overlay, { kind: "reset" }>; branch: string; onMode(mode: Mode): void }) {
  const plan = o.plan;
  const name = plan === null ? branch : branchName(plan.branch);
  const hard = o.mode === "hard";
  const notes =
    plan === null
      ? []
      : [
          plan.leave > 0 ? RESET.leave(plan.leave, name) : null,
          plan.gain > 0 ? RESET.gain(plan.gain, name) : null,
          plan.reflogOnly > 0 ? RESET.reflog(plan.reflogOnly) : null,
          plan.forceNote === null ? null : RESET.force(shortRef(plan.forceNote.trackingRef)),
          plan.trackedChanges > 0 ? RESET.tracked(plan.trackedChanges) : null,
        ].filter((t) => t !== null);
  const refused = o.error !== null || o.inTheWay !== null;
  return (
    <ConfirmPopover
      open
      anchor={o.anchor}
      title={RESET.title(name, o.oid)}
      confirmLabel={hard ? RESET.hardButton : RESET.button}
      danger={hard}
      initialFocus={field}
      finalFocus={finalFocus}
      onConfirm={refused ? undefined : onConfirm}
      unavailable={plan === null && !refused ? { reason: null } : undefined}
      onCancel={onCancel}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2">{RESET.legend}</legend>
        {MODES.map(({ mode, label, hint }) => (
          <Choice key={mode} name="reset-mode" checked={o.mode === mode} label={label} hint={hint} danger={mode === "hard"} inputRef={o.mode === mode ? fieldRef : undefined} onSelect={() => onMode(mode)} />
        ))}
      </fieldset>
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {plan === null && !refused ? <p className="text-muted-text">{REVIEW_PENDING}</p> : null}
      {o.inTheWay === null ? null : (
        <div role="alert" className="flex min-h-0 flex-col gap-1">
          <p className="flex items-start gap-2">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden="true" className="mt-px size-(--icon-size) shrink-0 text-removed" />
            <span>{RESET.inTheWayLead}</span>
          </p>
          <ul className="max-h-[160px] min-h-0 overflow-y-auto rounded-sm border border-divider bg-canvas px-2 py-1.5 font-mono leading-[18px] select-text">
            {o.inTheWay.paths.map((path) => (
              <li key={path} className="break-all">
                {path}
              </li>
            ))}
          </ul>
          <p>{RESET.inTheWayTail(o.inTheWay.more)}</p>
        </div>
      )}
      {o.error === null ? null : <p role="alert">{o.error}</p>}
    </ConfirmPopover>
  );
}

function PickPopover({ o, field, fieldRef, finalFocus, onParent, onConfirm, onCancel }: PopoverParts & { o: Extract<Overlay, { kind: "pick" }>; onParent(mainline: number): void }) {
  const pick = o.action === "cherry-pick";
  const branch = o.branch ?? "";
  const merge = o.parents.length >= 2;
  // Plan D1: the preselected parent takes the focus when the review names the parents. The popover opens before the review ends.
  useEffect(() => {
    if (merge) field.current?.focus();
  }, [merge, field]);
  return (
    <ConfirmPopover
      open
      anchor={o.anchor}
      title={PICK.title(pick, o.oid, branch)}
      confirmLabel={PICK.button(pick)}
      finalFocus={finalFocus}
      onConfirm={o.error === null ? onConfirm : undefined}
      unavailable={o.pending ? { reason: null } : undefined}
      onCancel={onCancel}
    >
      <p>{PICK.body(pick, branch)}</p>
      {o.note === null ? null : <p>{o.note}</p>}
      {merge ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2">{PICK.legend(pick)}</legend>
          {o.parents.map((parent, index) => (
            <Choice key={parent.oid} name="pick-parent" checked={o.mainline === index + 1} label={PICK.parent(index + 1, parent.oid, parent.subject)} inputRef={o.mainline === index + 1 ? fieldRef : undefined} onSelect={() => onParent(index + 1)} />
          ))}
        </fieldset>
      ) : null}
      {o.pending ? <p className="text-muted-text">{REVIEW_PENDING}</p> : null}
      {o.error === null ? null : <p role="alert">{o.error}</p>}
    </ConfirmPopover>
  );
}
