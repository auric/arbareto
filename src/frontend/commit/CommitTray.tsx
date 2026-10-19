// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import type { TerminalState } from "../../contracts/errors";
import { COMMIT_MESSAGE_BYTES } from "../../contracts/limits";
import { codeText } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge } from "../bridge";
import { BLOCKED_TEXT, STALE_TEXT, type Blocked, type StagingTarget } from "../changes/HunkControls";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { RUNNING_REASON, RunningTooltip } from "../components/running-tooltip";
import { branchName } from "../history/HistoryView";
import { shortRef } from "../refs/ReferencesSidebar";
import type { createDrafts } from "../state/drafts";
import type { Amend } from "../state/workbench";
import { shortId, trackOperation, type StatusOperation } from "../status/OperationStatus";
import { GuideLines, guideStyle, SummaryCounter } from "./MessageGuide";
import { isTrustReport, trustBeforeReview, trustFailureCode, type TrustReport } from "../trust/TrustDialog";

// plan.md "Task flow and command placement" (Compose a commit, Commit, Commit outcome) and "Keyboard and focus" (Message, Unavailable control).
// Feature 004 spec FR-047 (message guide), FR-098 to FR-100 (Amend last commit), plan.md D8 "Amend last commit", and D15 (running rule, texts).

type Head = WorkspaceSnapshot["head"];
type Drafts = ReturnType<typeof createDrafts>;

export const HOOK_DISCLOSURE = "Git will run approved hooks. They or other Git tools can change the result during execution.";
// Contract §5: `commit -F` refuses a message of only U+0020, U+0009, U+000A, and U+000D (src/contracts/envelope.ts `CommitMessage`).
const BLANK = /^[ \t\n\r]*$/;
const encoder = new TextEncoder();

export type CommitTrayProps = {
  bridge: Pick<ReturnType<typeof createBridge>, "readTrust" | "reviewCommit" | "commit">;
  /** The repository and the generation of the shown snapshot. */
  target: StagingTarget | null;
  /** The shown snapshot ID. Null before the first status read. */
  snapshotId: string | null;
  /** Contract §3 `worktreeKey`: the draft key. */
  worktreeKey: string | null;
  drafts: Drafts;
  head: Head | null;
  /** The entry count of the Staged list. */
  staged: number;
  /** `incomplete` for a limited status read, `loading` while a status page loads. */
  status: "incomplete" | "loading" | null;
  /** A workspace state that blocks the commit, such as a running operation. */
  blocked?: Blocked;
  /** Opens the Trust dialog. Resolves true after an approval. */
  requestTrust(report: TrustReport): Promise<boolean>;
  onOperation?(op: StatusOperation): void;
  /** A terminal `commit` response, or a refused `reviewCommit`. The read after it reconciles the view (contract §3). It can resolve when that read ends. */
  onEnded?(response: BridgeResponse): void | Promise<void>;
  fieldRef?: Ref<HTMLTextAreaElement>;
  /** Feature 003 FR-038: Commit and push runs this after a `succeeded` commit. Without it, the tray shows no Commit and push. */
  onPush?(): void;
  /** Why Push cannot run, or null (feature 003 FR-017). */
  pushReason?: string | null;
  operationState?: WorkspaceSnapshot["operationState"];
  /** Feature 004 FR-098: the Amend last commit state of the window session. Without it, the tray shows no check box. */
  amend?: { value: Amend | null; onChange(next: Amend | null): void };
};

// Feature 004 plan.md D15 "Commit view texts".
export const AMEND_LABEL = "Amend last commit";
const AMEND_UNBORN = "The branch has no commits yet.";
const AMEND_OPERATION = "A merge or a rebase is in progress.";
export const amendStatement = (oid: string) => `Commit replaces commit ${shortId(oid)}.`;
// Contract Δ3 `reviewCommit` with `amend`: the result adds `amend`. `reviewCommit` has no result schema (contract Δ3 gap), so the reads stay typed loosely.
type AmendReview = { headOid: string; message: string; upstream: { name: string | null; present: boolean } | null; rewritesUpstream: boolean | "unknown" };
const amendOf = (result: unknown) => {
  const a = (result as { amend?: AmendReview } | undefined)?.amend;
  return typeof a?.headOid === "string" && typeof a.message === "string" ? a : null;
};
// Contract Δ3: the review disclosure states the approval need of an amend, which also runs `post-rewrite`.
const amendNeedsTrust = (result: unknown) => {
  const d = (result as { disclosure?: { approvalRequired?: unknown; trust?: unknown } } | undefined)?.disclosure;
  return d?.approvalRequired !== false && d?.trust !== "approved";
};
/** D15: a null name reads "the upstream branch". A present ref is local, so it takes its short name. An absent one keeps the full name. */
const upstreamName = (u: AmendReview["upstream"]) => (u?.name == null ? "the upstream branch" : u.present ? shortRef(u.name) : u.name);
/** FR-100: the confirmation text for `rewritesUpstream` true, and for `unknown`. */
export const rewriteText = (a: AmendReview) =>
  a.rewritesUpstream === true
    ? `Amend rewrites commit ${shortId(a.headOid)}, which ${upstreamName(a.upstream)} already has. The next push needs Force push with lease.`
    : `Arbareto cannot check whether ${upstreamName(a.upstream)} holds this commit. Amend rewrites it if it was pushed.`;
/** FR-098: the box is unavailable for an unborn branch and while a merge or a rebase is in progress. */
export function amendReason(head: Head | null, operationState: WorkspaceSnapshot["operationState"] | undefined): string | null {
  if (head?.state === "unborn") return AMEND_UNBORN;
  return operationState === "merging" || operationState === "rebasing" ? AMEND_OPERATION : null;
}


/** plan.md "Compose a commit": the summary line. A count of 1 takes the singular ("Long text"). */
export function summaryLine(head: Head, staged: number): string {
  return `${head.state === "detached" ? "Detached HEAD" : branchName(head.target)}, ${staged} staged ${staged === 1 ? "file" : "files"}`;
}

/** The message that Commit sends: the amend text while the box is checked, else the draft. */
const messageOf = (props: CommitTrayProps) => props.amend?.value?.text ?? (props.worktreeKey === null ? null : props.drafts.draft(props.worktreeKey)?.text) ?? "";
/** Feature 004 plan.md D15: a mutation runs. Its reason goes only into the tooltip and the accessible description. */
const runningBlock = (blocked: Blocked | undefined) => blocked === "running" || blocked === "busy";

/** plan.md Commit row: the visible reason that disables Commit, or null. An amend without staged changes changes only the message (FR-099). */
function disableReason(props: CommitTrayProps, composing: boolean): string | null {
  const { blocked = null, status, snapshotId, target, staged } = props;
  const text = messageOf(props);
  return (
    (runningBlock(blocked) ? RUNNING_REASON : blocked ? BLOCKED_TEXT[blocked] : null) ??
    (status === "incomplete" ? BLOCKED_TEXT.incomplete : null) ??
    (status === "loading" || snapshotId === null || target === null ? BLOCKED_TEXT.loading : null) ??
    (staged === 0 && props.amend?.value == null ? "The Staged list is empty." : null) ??
    (BLANK.test(text) ? "The commit message is empty." : null) ??
    (text.includes("\u0000") || encoder.encode(text).length > COMMIT_MESSAGE_BYTES ? "The commit message is longer than 64 KiB or holds a NUL character." : null) ??
    (composing ? "Text input is still composing." : null)
  );
}

export function CommitTray(props: CommitTrayProps) {
  const { bridge, target, snapshotId, worktreeKey, drafts, head, staged } = props;
  const reasonId = useId();
  const field = useRef<HTMLTextAreaElement | null>(null);
  // The props after each await: a trust approval runs a new full read, so the review names the snapshot that shows then.
  const live = useRef(props);
  live.current = props;
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  // A refusal text of this tray: a trust read failure, a refused review, or the Stale selection text.
  const [notice, setNotice] = useState<ReactNode>(null);
  const draft = useSyncExternalStore(drafts.subscribe, () => (worktreeKey === null ? null : drafts.draft(worktreeKey)));
  const failure = useSyncExternalStore(drafts.subscribe, () => (worktreeKey === null ? null : drafts.failure(worktreeKey)));
  const amending = props.amend?.value ?? null;
  // FR-098: the check box keeps the earlier draft. The field shows the amend text while the box is checked.
  const text = amending?.text ?? draft?.text ?? "";
  // FR-100: the open rewrite confirmation, with the facts of the review that asks for it.
  const [rewrite, setRewrite] = useState<{ text: string; resolve(confirmed: boolean): void } | null>(null);
  const cancelRewrite = useRef<HTMLButtonElement>(null);

  const composingRef = useRef(composing);
  composingRef.current = composing;
  const reason = disableReason(props, composing);
  const disabled = reason !== null || busy;

  const focusField = () => field.current?.focus();

  async function activate(push = false) {
    if (disabled || running.current || target === null || snapshotId === null || worktreeKey === null) return;
    running.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const amended = (props.amend?.value ?? null) !== null;
      // Opens the Trust dialog when `needed` holds for the report. False after a failed read or a refused approval.
      const trusted = async (needed: (report: TrustReport) => boolean) => {
        const trust = await bridge.readTrust({ repositoryId: target.repositoryId });
        if (trust.state === "succeeded" && isTrustReport(trust.result)) return !needed(trust.result) || (await props.requestTrust(trust.result));
        setNotice(codeText("Trust review did not complete: ", trustFailureCode(trust)));
        return false;
      };
      // The awaits can change the workspace, the staged list, the message, or the box. The disable rules apply again.
      const shown = () => {
        const now = live.current;
        const same = now.target !== null && now.snapshotId !== null && now.target.repositoryId === target.repositoryId && now.worktreeKey === worktreeKey && (now.amend?.value != null) === amended;
        return same && disableReason(now, composingRef.current) === null ? { now, reviewed: now.target!, snapshotId: now.snapshotId! } : null;
      };
      // plan.md Commit row: the Trust dialog opens first when `commit` needs an approval that the workspace lacks.
      // An amend takes the need from its review disclosure instead (contract Δ3).
      if (!amended && !(await trusted(trustBeforeReview))) return focusField();
      let current = shown();
      if (current === null) return focusField();
      let review = await bridge.reviewCommit(current.reviewed, amended ? { snapshotId: current.snapshotId, amend: true } : { snapshotId: current.snapshotId });
      if (amended && review.state === "succeeded" && amendNeedsTrust(review.result)) {
        if (!(await trusted(() => true))) return focusField();
        // The approval runs a new full read, so the review names the snapshot that shows then.
        current = shown();
        if (current === null) return focusField();
        review = await bridge.reviewCommit(current.reviewed, { snapshotId: current.snapshotId, amend: true });
      }
      const { reviewed } = current;
      const amend = current.now.amend?.value ?? null;
      const token = review.state === "succeeded" ? (review.result as { reviewToken?: unknown } | undefined)?.reviewToken : undefined;
      if (typeof token !== "string") {
        // Contract §3 `reviewCommit`: a result without `reviewToken` reviewed an empty staged scope, so the shown Staged list is stale.
        setNotice(review.state === "succeeded" || review.code === "STALE_REVIEW" ? STALE_TEXT : codeText("Commit did not start: ", review.code ?? review.state));
        props.onEnded?.(review);
        return focusField();
      }
      let response: BridgeResponse;
      if (amend !== null) {
        // FR-099: the amend binds to the HEAD commit whose message the box loaded. A moved HEAD refuses and asks for a refresh.
        const reviewedAmend = amendOf(review.result);
        if (reviewedAmend === null || reviewedAmend.headOid !== amend.headOid) {
          setNotice(STALE_TEXT);
          props.onEnded?.(review);
          return focusField();
        }
        // FR-100: `true` and `unknown` need the destructive confirmation first. Only `false` skips it. Cancel has the first focus.
        const confirm = reviewedAmend.rewritesUpstream !== false;
        if (confirm && !(await new Promise<boolean>((resolve) => setRewrite({ text: rewriteText(reviewedAmend), resolve })))) return focusField();
        const payload = { reviewToken: token, message: amend.text, confirmFullScope: true as const, amend: true as const, ...(confirm ? { confirmRewrite: true as const } : {}) };
        response = await trackOperation("commit", undefined, (onProgress) => bridge.commit(reviewed, payload, onProgress), props.onOperation);
        if (response.code === "STALE_REVIEW") setNotice(STALE_TEXT);
        if (response.state === "succeeded") live.current.amend?.onChange(null);
      } else {
        const submission = drafts.submit(worktreeKey)!;
        response = await trackOperation("commit", undefined, (onProgress) => bridge.commit(reviewed, { reviewToken: token, message: submission.text, confirmFullScope: true }, onProgress), props.onOperation);
        if (response.code === "STALE_REVIEW") setNotice(STALE_TEXT);
        void drafts.complete(submission, response.state as TerminalState);
      }
      const reconciled = props.onEnded?.(response);
      // Feature 003 FR-038: only a reconciled intended success starts the push.
      // The reconcile read advances the generation after the new HEAD (contract §8), so the push review waits for it.
      if (push && response.state === "succeeded") {
        await reconciled;
        if (live.current.target?.repositoryId === target.repositoryId) live.current.onPush?.();
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  // FR-098: checking loads the HEAD message through `reviewCommit` with `amend` (contract Δ3). Clearing shows the draft again.
  const checking = useRef(false);
  const amendBlock = amendReason(head, props.operationState);
  async function toggleAmend(checked: boolean) {
    const box = props.amend;
    if (box === undefined || checking.current) return;
    if (!checked) return box.onChange(null);
    if (amendBlock !== null || target === null || snapshotId === null) return;
    checking.current = true;
    setNotice(null);
    try {
      const review = await bridge.reviewCommit(target, { snapshotId, amend: true });
      if (review.state !== "succeeded") return setNotice(codeText(`${AMEND_LABEL} did not start: `, review.code ?? review.state));
      // D15: a succeeded amend review always holds the amend part.
      const loaded = amendOf(review.result);
      if (loaded !== null) live.current.amend?.onChange({ headOid: loaded.headOid, message: loaded.message, text: loaded.message });
    } finally {
      checking.current = false;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    // During IME composition every key goes to the IME (plan.md Message row).
    if (event.repeat || event.nativeEvent.isComposing || composing) return;
    void activate();
  }

  const shownReason = busy ? null : reason;
  const pushReason = busy ? null : (reason ?? props.pushReason ?? null);
  // Plan.md D15: a reason because an operation runs shows only in the tooltip and the accessible description.
  const hideReason = runningBlock(props.blocked);
  const commitButton = (
    <Button aria-keyshortcuts="Control+Enter" disabled={disabled} focusableWhenDisabled aria-describedby={shownReason === null ? undefined : reasonId} onClick={() => void activate()}>
      Commit (Ctrl+Enter)
    </Button>
  );
  return (
    <div className="grid h-full min-h-0 gap-x-2 gap-y-1" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", gridTemplateRows: "auto minmax(0, 1fr) auto" }}>
      <div className="col-span-2 flex items-center gap-2">
        <span className="font-semibold">Commit message</span>
        <span className="ml-auto">
          <SummaryCounter id={`${reasonId}-counter`} text={text} />
        </span>
      </div>
      <textarea
        ref={(element) => {
          field.current = element;
          const r = props.fieldRef;
          if (typeof r === "function") r(element);
          else if (r) r.current = element;
        }}
        aria-label="Commit message"
        aria-describedby={[`${reasonId}-counter`, `${reasonId}-guide`, failure === null ? null : `${reasonId}-save`].filter(Boolean).join(" ")}
        value={text}
        spellCheck={false}
        disabled={worktreeKey === null}
        data-guide-column="72"
        className="min-h-0 resize-none rounded-md border border-control-border bg-surface px-2 py-1 font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        style={guideStyle(8)}
        onChange={(event) => {
          const value = event.target.value;
          if (amending !== null) props.amend?.onChange({ ...amending, text: value });
          else if (worktreeKey !== null) void drafts.change(worktreeKey, value);
        }}
        onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
      <div className="flex max-w-64 flex-col items-start gap-1">
        {props.amend === undefined ? null : (
          <AmendBox checked={amending !== null} reason={amendBlock} onChange={(checked) => void toggleAmend(checked)} />
        )}
        {amending === null ? null : <p data-slot="amend-statement">{amendStatement(amending.headOid)}</p>}
        <div className="flex flex-wrap gap-2">
          <RunningTooltip reason={hideReason ? shownReason : null}>{commitButton}</RunningTooltip>
          {props.onPush === undefined ? null : (
            <Button
              variant="outline"
              disabled={disabled || pushReason !== null}
              focusableWhenDisabled
              aria-describedby={pushReason === null ? undefined : pushReason === shownReason ? reasonId : `${reasonId}-push`}
              onClick={() => void (pushReason === null && activate(true))}
            >
              Commit and push
            </Button>
          )}
        </div>
        <p className="text-muted-text">{HOOK_DISCLOSURE}</p>
      </div>
      <div className="col-span-2 flex min-w-0 flex-col">
        <GuideLines id={`${reasonId}-guide`} text={text} />
        {head === null ? null : <p className="truncate">{summaryLine(head, staged)}</p>}
        <p id={reasonId} hidden={hideReason} className="truncate text-muted-text">
          {shownReason}
        </p>
        {pushReason === null || pushReason === shownReason ? null : (
          <p id={`${reasonId}-push`} className="truncate text-muted-text">
            {`Commit and push: ${pushReason}`}
          </p>
        )}
        {/* The live element stays mounted. Only its text changes. */}
        <p role="status">{notice}</p>
        {failure === null ? null : <p id={`${reasonId}-save`}>{failure}</p>}
      </div>
      {rewrite === null ? null : (
        <Dialog open onOpenChange={(open) => void (open || (rewrite.resolve(false), setRewrite(null)))}>
          <DialogContent showCloseButton={false} initialFocus={cancelRewrite} finalFocus={field} className="flex flex-col gap-2 sm:max-w-lg">
            <DialogTitle>{`${AMEND_LABEL}?`}</DialogTitle>
            <p>{rewrite.text}</p>
            <div className="flex justify-end gap-2">
              <Button ref={cancelRewrite} variant="outline" onClick={() => (rewrite.resolve(false), setRewrite(null))}>
                Cancel
              </Button>
              <Button className="danger-button" onClick={() => (rewrite.resolve(true), setRewrite(null))}>
                Amend
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** FR-098: the check box beside the message editor. An unavailable box states its reason. */
function AmendBox({ checked, reason, onChange }: { checked: boolean; reason: string | null; onChange(checked: boolean): void }) {
  const reasonId = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          aria-disabled={reason !== null && !checked}
          aria-describedby={reason === null ? undefined : reasonId}
          onChange={(event) => {
            if (reason !== null && event.target.checked) return;
            onChange(event.target.checked);
          }}
        />
        {AMEND_LABEL}
      </label>
      {reason === null ? null : (
        <p id={reasonId} className="text-muted-text">
          {`${AMEND_LABEL} is unavailable: ${reason}`}
        </p>
      )}
    </div>
  );
}
