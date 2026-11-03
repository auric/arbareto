// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ShieldAlertIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { ReviewCommitResult, WorkspaceSnapshot } from "../../contracts/envelope";
import type { TerminalState } from "../../contracts/errors";
import { COMMIT_MESSAGE_BYTES } from "../../contracts/limits";
import { codeText, failureText, unknownFormText } from "../app/RepositoryStates";
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
import { isObject } from "../lib/utils";
import { GuideLines, guideStyle, SummaryCounter } from "./MessageGuide";
import { isTrustReport, trustBeforeReview, trustFailureCode, type TrustReport } from "../trust/TrustChip";
import type { Spelling } from "../spelling/engine";
import { SpellChip, spellStatus } from "../spelling/SpellChip";
import { useSpellMenu } from "../spelling/SpellMenu";
import { SpellMirror } from "../spelling/SpellMirror";

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
  /** Asks for trust through the shell (feature 004 plan.md D12). Resolves true after an approval. */
  requestTrust(report: TrustReport): Promise<boolean>;
  /** Feature 004 spec FR-072: the inline reason after Not now, or null. Commit is then unavailable. */
  trustReason?: string | null;
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
  /** Feature 006 plan.md D8: the spell check of the message editor. Without it, the editor shows no marks and no chip. */
  spelling?: Spelling;
};

// Feature 004 plan.md D15 "Commit view texts".
export const AMEND_LABEL = "Amend last commit";
const AMEND_UNBORN = "The branch has no commits yet.";
export const amendStatement = (oid: string) => `Commit replaces commit ${shortId(oid)}.`;
// Contract Δ3 `reviewCommit` with `amend` (src/contracts/envelope.ts `ReviewCommitResult`). The renderer bundle holds no zod, so this check reads the fields that the tray uses.
type CommitReview = Extract<ReviewCommitResult, { disclosure: unknown }>;
type AmendReview = NonNullable<CommitReview["amend"]>;
const TRUST_STATES: readonly unknown[] = ["untrusted", "approved", "changed", "revoked"];
function amendOf(a: unknown): AmendReview | null | undefined {
  if (a === undefined) return undefined;
  if (!isObject(a) || typeof a.headOid !== "string" || typeof a.message !== "string") return null;
  const u = a.upstream;
  const r = a.rewritesUpstream;
  if (u === null) return r === false ? (a as AmendReview) : null;
  if (!isObject(u) || (u.name !== null && typeof u.name !== "string") || typeof u.present !== "boolean") return null;
  return (u.present ? u.name !== null && typeof r === "boolean" : r === "unknown") ? (a as AmendReview) : null;
}
/** The parsed result of a `succeeded` review, or null for a result of another form. */
function commitReviewOf(result: unknown): CommitReview | null {
  if (!isObject(result) || !isObject(result.disclosure) || typeof result.disclosure.approvalRequired !== "boolean" || !TRUST_STATES.includes(result.disclosure.trust)) return null;
  if (result.reviewToken !== undefined && typeof result.reviewToken !== "string") return null;
  return amendOf(result.amend) === null ? null : (result as CommitReview);
}
// Contract Δ3: the review disclosure states the approval need of an amend, which also runs `post-rewrite`.
const amendNeedsTrust = (r: CommitReview) => r.disclosure.approvalRequired && r.disclosure.trust !== "approved";
/** D15: a null name reads "the upstream branch". A present ref is local, so it takes its short name. An absent one names the remote-side ref in full. */
const upstreamName = (u: AmendReview["upstream"]) => (u?.name == null ? "the upstream branch" : u.present ? shortRef(u.name) : `the upstream branch ${u.name}`);
/** FR-100: the confirmation text for `rewritesUpstream` true, and for `unknown`. */
export const rewriteText = (a: AmendReview) =>
  a.rewritesUpstream === true
    ? `Amend rewrites commit ${shortId(a.headOid)}, which ${upstreamName(a.upstream)} already has. The next push needs Force push with lease.`
    : `Arbareto cannot check whether ${upstreamName(a.upstream)} holds this commit. Amend rewrites it if it was pushed.`;
/** FR-098: the box is unavailable for an unborn branch and while a merge or a rebase is in progress. The second reason is quiet (FR-105). */
export function amendReason(head: Head | null, operationState: WorkspaceSnapshot["operationState"] | undefined): string | null {
  if (head?.state === "unborn") return AMEND_UNBORN;
  return operationState === "merging" || operationState === "rebasing" ? BLOCKED_TEXT.operation : null;
}


/** plan.md "Compose a commit": the summary line. A count of 1 takes the singular ("Long text"). */
export function summaryLine(head: Head, staged: number): string {
  return `${head.state === "detached" ? "Detached HEAD" : branchName(head.target)}, ${staged} staged ${staged === 1 ? "file" : "files"}`;
}

/** The message that Commit sends: the amend text while the box is checked, else the draft. */
const messageOf = (props: CommitTrayProps) => props.amend?.value?.text ?? (props.worktreeKey === null ? null : props.drafts.draft(props.worktreeKey)?.text) ?? "";
/** Feature 004 plan.md D15: a mutation runs. Its reason goes only into the tooltip and the accessible description. */
const runningBlock = (blocked: Blocked | undefined) => blocked === "running" || blocked === "busy";
/** Feature 004 spec FR-105: a merge or a rebase in progress follows the same rule. */
const quietBlock = (blocked: Blocked | undefined) => runningBlock(blocked) || blocked === "operation";
/** A text of the amend column. It adds no content width, so the button row sets the column width and the text wraps to it. */
const COLUMN_TEXT = { contain: "inline-size" } as const;
const noSubscribe = () => () => {};
const noValue = () => null;

/** The reason of a block. It comes before the trust reason. */
const blockReason = (blocked: Blocked | undefined): string | null => (runningBlock(blocked) ? RUNNING_REASON : blocked ? BLOCKED_TEXT[blocked] : null);

/** plan.md Commit row: the visible reason that disables Commit, or null. An amend without staged changes changes only the message (FR-099). */
function disableReason(props: CommitTrayProps, composing: boolean): string | null {
  const { blocked = null, status, snapshotId, target, staged } = props;
  const text = messageOf(props);
  return (
    blockReason(blocked) ??
    props.trustReason ??
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

  // Feature 006 plan.md D8 and D15: the engine sees every text change, and the editor shows from the first mount.
  const spelling = props.spelling;
  const spellBox = useRef<HTMLDivElement | null>(null);
  const spellView = useSyncExternalStore(spelling?.engine.subscribe ?? noSubscribe, spelling?.engine.view ?? noValue);
  const spellState = useSyncExternalStore(spelling?.store.subscribe ?? noSubscribe, spelling?.store.state ?? noValue);
  const spellShown = spellState === null || spellView === null ? null : spellStatus(spellState, spellView);
  useLayoutEffect(() => spelling?.engine.show(), [spelling]);
  useLayoutEffect(() => spelling?.engine.setText(text), [spelling, text]);
  const spellMenu = useSpellMenu(spelling, field, spellBox, (text) => setNotice(text));

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
        setNotice(failureText("Trust review", trust, trustFailureCode(trust)));
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
      // The commit sends the message that the disable rules checked. An edit during the review stays as the draft.
      const submission = amended ? null : drafts.submit(worktreeKey);
      let review = await bridge.reviewCommit(current.reviewed, amended ? { snapshotId: current.snapshotId, amend: true } : { snapshotId: current.snapshotId });
      let parsed = review.state === "succeeded" ? commitReviewOf(review.result) : null;
      if (amended && parsed !== null && amendNeedsTrust(parsed)) {
        if (!(await trusted(() => true))) return focusField();
        // The approval runs a new full read, so the review names the snapshot that shows then.
        current = shown();
        if (current === null) return focusField();
        review = await bridge.reviewCommit(current.reviewed, { snapshotId: current.snapshotId, amend: true });
        parsed = review.state === "succeeded" ? commitReviewOf(review.result) : null;
      }
      const { reviewed } = current;
      const amend = current.now.amend?.value ?? null;
      const token = parsed?.reviewToken;
      if (token === undefined) {
        // Contract §3 `reviewCommit`: a result without `reviewToken` reviewed an empty staged scope, so the shown Staged list is stale.
        const malformed = review.state === "succeeded" && parsed === null;
        setNotice(malformed ? unknownFormText("Commit") : review.state === "succeeded" || review.code === "STALE_REVIEW" ? STALE_TEXT : codeText("Commit did not start: ", review.code ?? review.state));
        props.onEnded?.(review);
        return focusField();
      }
      let response: BridgeResponse;
      if (amend !== null) {
        // FR-099: the amend binds to the HEAD commit whose message the box loaded. A moved HEAD refuses and asks for a refresh.
        const reviewedAmend = parsed!.amend ?? null;
        // An amend review always carries the amend part, so a result without it has an unknown form.
        if (reviewedAmend === null || reviewedAmend.headOid !== amend.headOid) {
          setNotice(reviewedAmend === null ? unknownFormText("Commit") : STALE_TEXT);
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
        // The passed disable check holds a non-blank draft, so `submission` is set.
        response = await trackOperation("commit", undefined, (onProgress) => bridge.commit(reviewed, { reviewToken: token, message: submission!.text, confirmFullScope: true }, onProgress), props.onOperation);
        if (response.code === "STALE_REVIEW") setNotice(STALE_TEXT);
        void drafts.complete(submission!, response.state as TerminalState);
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
      const loaded = review.state === "succeeded" ? (commitReviewOf(review.result)?.amend ?? null) : null;
      if (loaded === null) return setNotice(failureText(AMEND_LABEL, review, undefined, `${AMEND_LABEL} did not start: `));
      live.current.amend?.onChange({ headOid: loaded.headOid, message: loaded.message, text: loaded.message });
    } finally {
      checking.current = false;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (spellMenu.onKeyDown(event)) return;
    if (event.key !== "Enter" || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    // During IME composition every key goes to the IME (plan.md Message row).
    if (event.repeat || event.nativeEvent.isComposing || composing) return;
    void activate();
  }

  const shownReason = busy ? null : reason;
  const pushReason = busy ? null : (reason ?? props.pushReason ?? null);
  // The Commit reason also blocks Commit and push. Its line then serves both buttons.
  const pushSharesReason = shownReason !== null;
  // Plan.md D15: a reason because an operation runs shows only in the tooltip and the accessible description.
  const hideReason = quietBlock(props.blocked);
  // Plan.md D15 "Trust texts": the Commit trust reason shows beside Commit, after the shield icon.
  const trustShown = shownReason !== null && blockReason(props.blocked) === null && props.trustReason != null;
  const commitButton = (
    <Button aria-keyshortcuts="Control+Enter" disabled={disabled} focusableWhenDisabled aria-describedby={shownReason === null ? undefined : reasonId} onClick={() => void activate()}>
      Commit (Ctrl+Enter)
    </Button>
  );
  return (
    <div className="grid h-full min-h-0 gap-x-2 gap-y-1" style={{ gridTemplateColumns: "minmax(0, 1fr) fit-content(50%)", gridTemplateRows: "auto minmax(0, 1fr) auto" }}>
      <div className="col-span-2 flex items-center gap-2">
        <span className="font-semibold">Commit message</span>
        {/* Plan.md D8 "Chip": a 12 px gap after the label. */}
        {spellShown === null ? null : (
          <span className="ml-1 flex">
            <SpellChip status={spellShown} linesId={`${reasonId}-spell`} />
          </span>
        )}
        {spellShown?.count == null ? null : (
          <span id={`${reasonId}-count`} className="sr-only">
            {spellShown.count}
          </span>
        )}
        <span className="ml-auto">
          <SummaryCounter id={`${reasonId}-counter`} text={text} />
        </span>
      </div>
      <div ref={spellBox} className="grid min-h-0">
        <SpellMirror view={spellView} field={field}>
          <textarea
            ref={(element) => {
              field.current = element;
              const r = props.fieldRef;
              if (typeof r === "function") r(element);
              else if (r) r.current = element;
            }}
            aria-label="Commit message"
            aria-describedby={[
              `${reasonId}-counter`,
              `${reasonId}-guide`,
              failure === null ? null : `${reasonId}-save`,
              spellShown?.count == null ? null : `${reasonId}-count`,
              spellShown === null ? null : `${reasonId}-spell`,
            ]
              .filter(Boolean)
              .join(" ")}
            value={text}
            spellCheck={false}
            disabled={worktreeKey === null}
            data-guide-column="72"
            className="relative block size-full min-h-0 resize-none border-0 bg-transparent px-2 py-1 font-mono outline-none"
            style={guideStyle(8)}
            onChange={(event) => {
              const value = event.target.value;
              if (amending !== null) props.amend?.onChange({ ...amending, text: value });
              else if (worktreeKey !== null) void drafts.change(worktreeKey, value);
            }}
            onKeyDown={onKeyDown}
            onContextMenu={spellMenu.onContextMenu}
            onCompositionStart={() => {
              spelling?.engine.setComposing(true);
              setComposing(true);
            }}
            onCompositionEnd={() => {
              spelling?.engine.setComposing(false);
              setComposing(false);
            }}
          />
        </SpellMirror>
      </div>
      {spellMenu.menu}
      {/* The amend column spans the editor row and the lines below it, so the lines never run under it. */}
      <div className="flex flex-col items-start gap-1" style={{ gridColumn: "2", gridRow: "2 / span 2" }}>
        {props.amend === undefined ? null : (
          <AmendBox checked={amending !== null} reason={amendBlock} quiet={head?.state !== "unborn" && (props.operationState === "merging" || props.operationState === "rebasing")} onChange={(checked) => void toggleAmend(checked)} />
        )}
        {amending === null ? null : <p data-slot="amend-statement" className="self-stretch" style={COLUMN_TEXT}>{amendStatement(amending.headOid)}</p>}
        {trustShown ? (
          <p id={reasonId} className="flex items-start gap-2 self-stretch" style={COLUMN_TEXT}>
            <HugeiconsIcon icon={ShieldAlertIcon} strokeWidth={2} aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            {shownReason}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <RunningTooltip reason={hideReason ? shownReason : null}>{commitButton}</RunningTooltip>
          {props.onPush === undefined ? null : (
            <Button
              variant="outline"
              disabled={disabled || pushReason !== null}
              focusableWhenDisabled
              aria-describedby={pushReason === null ? undefined : pushSharesReason ? reasonId : `${reasonId}-push`}
              onClick={() => void (pushReason === null && activate(true))}
            >
              Commit and push
            </Button>
          )}
        </div>
        <p className="self-stretch text-muted-text" style={COLUMN_TEXT}>
          {HOOK_DISCLOSURE}
        </p>
      </div>
      <div className="flex min-w-0 flex-col" style={{ gridColumn: "1" }}>
        <GuideLines id={`${reasonId}-guide`} text={text} />
        {/* Plan.md D15 "Message editor": the lines wrap to the column and show their full text. */}
        {head === null ? null : <p className="break-words">{summaryLine(head, staged)}</p>}
        {trustShown ? null : (
          <p id={reasonId} hidden={hideReason} className="break-words text-muted-text">
            {shownReason}
          </p>
        )}
        {pushReason === null || pushSharesReason ? null : (
          <p id={`${reasonId}-push`} className="break-words text-muted-text">
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
function AmendBox({ checked, reason, quiet, onChange }: { checked: boolean; reason: string | null; quiet: boolean; onChange(checked: boolean): void }) {
  const reasonId = useId();
  return (
    <div className="flex flex-col gap-1 self-stretch">
      <label className="flex items-center gap-2">
        <RunningTooltip reason={quiet ? reason : null}>
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
        </RunningTooltip>
        {AMEND_LABEL}
      </label>
      {reason === null ? null : (
        <p id={reasonId} hidden={quiet} className="text-muted-text" style={COLUMN_TEXT}>
          {reason}
        </p>
      )}
    </div>
  );
}
