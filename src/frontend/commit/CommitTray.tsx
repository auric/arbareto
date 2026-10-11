// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type Ref } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import type { TerminalState } from "../../contracts/errors";
import { COMMIT_MESSAGE_BYTES } from "../../contracts/limits";
import type { BridgeResponse, createBridge } from "../bridge";
import { BLOCKED_TEXT, STALE_TEXT, type Blocked, type StagingTarget } from "../changes/HunkControls";
import { Button } from "../components/ui/button";
import { branchName } from "../history/HistoryView";
import type { createDrafts } from "../state/drafts";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import { isTrustReport, trustBeforeReview, type TrustReport } from "../trust/TrustDialog";

// plan.md "Task flow and command placement" (Compose a commit, Commit, Commit outcome) and "Keyboard and focus" (Message, Unavailable control).

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
  /** A terminal `commit` response, or a refused `reviewCommit`. The read after it reconciles the view (contract §3). */
  onEnded?(response: BridgeResponse): void;
  fieldRef?: Ref<HTMLTextAreaElement>;
};


/** plan.md "Compose a commit": the summary line. A count of 1 takes the singular ("Long text"). */
export function summaryLine(head: Head, staged: number): string {
  return `${head.state === "detached" ? "Detached HEAD" : branchName(head.target)}, ${staged} staged ${staged === 1 ? "file" : "files"}`;
}

/** plan.md Commit row: the visible reason that disables Commit, or null. */
function disableReason(props: CommitTrayProps, composing: boolean): string | null {
  const { blocked = null, status, snapshotId, target, staged, worktreeKey, drafts } = props;
  const text = (worktreeKey === null ? null : drafts.draft(worktreeKey)?.text) ?? "";
  return (
    (blocked ? BLOCKED_TEXT[blocked] : null) ??
    (status === "incomplete" ? BLOCKED_TEXT.incomplete : null) ??
    (status === "loading" || snapshotId === null || target === null ? BLOCKED_TEXT.loading : null) ??
    (staged === 0 ? "The Staged list is empty." : null) ??
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
  const [notice, setNotice] = useState<string | null>(null);
  const draft = useSyncExternalStore(drafts.subscribe, () => (worktreeKey === null ? null : drafts.draft(worktreeKey)));
  const failure = useSyncExternalStore(drafts.subscribe, () => (worktreeKey === null ? null : drafts.failure(worktreeKey)));
  const text = draft?.text ?? "";

  const composingRef = useRef(composing);
  composingRef.current = composing;
  const reason = disableReason(props, composing);
  const disabled = reason !== null || busy;

  const focusField = () => field.current?.focus();

  async function activate() {
    if (disabled || running.current || target === null || snapshotId === null || worktreeKey === null) return;
    running.current = true;
    setBusy(true);
    setNotice(null);
    try {
      // plan.md Commit row: the Trust dialog opens first when `commit` needs an approval that the workspace lacks.
      const trust = await bridge.readTrust({ repositoryId: target.repositoryId });
      if (trust.state !== "succeeded" || !isTrustReport(trust.result)) {
        setNotice(`Trust review did not complete: ${trust.code ?? trust.state}.`);
        return focusField();
      }
      if (trustBeforeReview(trust.result) && !(await props.requestTrust(trust.result))) return focusField();
      // The awaits can change the workspace, the staged list, or the message. The disable rules apply again.
      const now = live.current;
      if (now.target === null || now.snapshotId === null || now.target.repositoryId !== target.repositoryId || now.worktreeKey !== worktreeKey || disableReason(now, composingRef.current) !== null) {
        setNotice(null);
        return focusField();
      }
      const reviewed = now.target;
      const review = await bridge.reviewCommit(reviewed, { snapshotId: now.snapshotId });
      const token = review.state === "succeeded" ? (review.result as { reviewToken?: unknown } | undefined)?.reviewToken : undefined;
      if (typeof token !== "string") {
        // Contract §3 `reviewCommit`: a result without `reviewToken` reviewed an empty staged scope, so the shown Staged list is stale.
        setNotice(review.state === "succeeded" || review.code === "STALE_REVIEW" ? STALE_TEXT : `Commit did not start: ${review.code ?? review.state}`);
        props.onEnded?.(review);
        return focusField();
      }
      const submission = drafts.submit(worktreeKey)!;
      const response = await trackOperation("commit", undefined, (onProgress) => bridge.commit(reviewed, { reviewToken: token, message: submission.text, confirmFullScope: true }, onProgress), props.onOperation);
      if (response.code === "STALE_REVIEW") setNotice(STALE_TEXT);
      void drafts.complete(submission, response.state as TerminalState);
      props.onEnded?.(response);
    } finally {
      running.current = false;
      setBusy(false);
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
  return (
    <div className="grid h-full min-h-0 gap-x-2 gap-y-1" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", gridTemplateRows: "minmax(0, 1fr) auto" }}>
      <textarea
        ref={(element) => {
          field.current = element;
          const r = props.fieldRef;
          if (typeof r === "function") r(element);
          else if (r) r.current = element;
        }}
        aria-label="Commit message"
        aria-describedby={failure === null ? undefined : `${reasonId}-save`}
        value={text}
        spellCheck={false}
        disabled={worktreeKey === null}
        className="min-h-0 resize-none rounded-md border border-control-border bg-surface px-2 py-1 font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        onChange={(event) => worktreeKey !== null && void drafts.change(worktreeKey, event.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
      <div className="flex max-w-64 flex-col items-start gap-1">
        <Button aria-keyshortcuts="Control+Enter" disabled={disabled} focusableWhenDisabled aria-describedby={shownReason === null ? undefined : reasonId} onClick={() => void activate()}>
          Commit (Ctrl+Enter)
        </Button>
        <p className="text-muted-text">{HOOK_DISCLOSURE}</p>
      </div>
      <div className="col-span-2 flex min-w-0 flex-col">
        {head === null ? null : <p className="truncate">{summaryLine(head, staged)}</p>}
        <p id={reasonId} className="truncate text-muted-text">
          {shownReason}
        </p>
        {/* The live element stays mounted. Only its text changes. */}
        <p role="status">{notice}</p>
        {failure === null ? null : <p id={`${reasonId}-save`}>{failure}</p>}
      </div>
    </div>
  );
}
