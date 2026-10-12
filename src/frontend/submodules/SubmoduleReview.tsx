// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import type { SubmodulePlanRow, SubmoduleProgram, SubmoduleRefusalReason } from "../../contracts/submodules";
import { CopyButton } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge, ProgressEvent } from "../bridge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { dialogSize, type Size } from "../layout/profiles";
import { shortId as short, trackOperation, type StatusOperation } from "../status/OperationStatus";

// plan.md "Required visible states" (Submodule review), "Dialog sizes", "Keyboard and focus" (Submodule review dialog row), and the Update submodules row of "Task flow and command placement".
// Contract §12 "Plan", "Refusals", and "Update protocol" step 3.

// Contract §9 `UNSUPPORTED_SUBMODULE` as the review lists it.
export type SubmoduleRefusal = { code: "UNSUPPORTED_SUBMODULE"; reason: SubmoduleRefusalReason; path: string; text: string; remedy: { command: string | null; text?: string } | null };
/** The `reviewSubmodules` result value (contract §12 "Plan"). */
export type SubmoduleReviewValue = { generation: number; rows: SubmodulePlanRow[]; programs: SubmoduleProgram[]; refusals: SubmoduleRefusal[]; submoduleReviewToken: string };
type Bridge = Pick<ReturnType<typeof createBridge>, "reviewSubmodules" | "updateSubmodules">;
type Target = Parameters<Bridge["updateSubmodules"]>[0];

export type SubmoduleReviewProps = {
  open: boolean;
  bridge: Bridge;
  target: Target;
  /** The generation and snapshot ID of the current read. An expired token reads the review again for them, because each full read issues a new snapshot ID (contract §8). */
  current(): { repositoryGeneration: number; snapshotId: string };
  review: SubmoduleReviewValue;
  /** The main window client size in DIPs. */
  client: Size;
  /** The opener, or the nearest surviving logical control. The mount also passes it to `OperationStatus` as `declinedFocus`. */
  finalFocus: RefObject<HTMLElement | null> | (() => HTMLElement | null);
  /** Cancel in the status bar. */
  startFocus: () => HTMLElement | null;
  onCancel(): void;
  /** Each `trackOperation` report of the `updateSubmodules` request. The dialog hides itself when `passedAcceptance` holds. */
  onOperation(op: StatusOperation): void;
  /** The reason of a workbench state that blocks mutations, or null (plan.md "Busy" and "Unavailable control"). */
  blockedReason?: string | null;
};

/**
 * Contract §2: the `accepted` event comes before the approval checks, and a `rejected` response can follow it.
 * Data-model §7: the state leaves `accepted` only after the checks pass. Contract §9: only `rejected` keeps the token unconsumed.
 */
export const passedAcceptance = (op: StatusOperation) => (op.progress !== null && op.progress.state !== "accepted") || (op.response !== null && op.response.state !== "rejected");

const DISCLOSURE = "Git connects to each URL. Your credential helper can show its own window.";
const PROGRAMS = "Programs from submodule settings and hooks that Git can run";
const UNCHECKED = "Arbareto cannot check this file before the run.";
const NO_ROWS = "No submodules found.";

function actionText(row: SubmodulePlanRow): string {
  switch (row.action) {
    case "clone":
      return "Clone";
    case "reuse":
      return "Reuse the existing Git folder";
    case "checkout":
      return `Check out ${short(row.target)}`;
    case "fetch-checkout":
      return `Fetch, then move from ${short(row.head)} to ${short(row.target)}`;
    case "none":
      return "No change";
    case "skip":
      return "Skip";
  }
}

const focusOf = (target: SubmoduleReviewProps["finalFocus"]) => (typeof target === "function" ? target() : target.current);

/** One listbox with one Tab stop and roving focus (plan.md "Keyboard and focus"). */
function RovingList({ labelledBy, children }: { labelledBy: string; children: ReactNode[] }) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const at = Math.min(active, children.length - 1);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const last = children.length - 1;
    const to = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (to === null) return;
    event.preventDefault();
    const next = Math.min(last, Math.max(0, to));
    setActive(next);
    list.current?.querySelectorAll<HTMLElement>(':scope > [role="option"]')[next]?.focus();
  }

  return (
    <div ref={list} role="listbox" aria-labelledby={labelledBy} className="flex flex-col" onKeyDown={onKeyDown}>
      {children.map((child, i) => (
        <div key={i} role="option" aria-selected={i === at} tabIndex={i === at ? 0 : -1} className="list-row px-2 py-1" onFocus={() => setActive(i)}>
          {child}
        </div>
      ))}
    </div>
  );
}

export function SubmoduleReview({ open, bridge, target, current, review, client, finalFocus, startFocus, onCancel, onOperation, blockedReason = null }: SubmoduleReviewProps) {
  const headingId = useId();
  const reasonId = useId();
  const programsId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [value, setValue] = useState(review);
  const [source, setSource] = useState(review);
  // The target of the shown review. A new review after `APPROVAL_EXPIRED` can name a newer generation.
  const [reviewed, setReviewed] = useState(target);
  const [accepted, setAccepted] = useState(false);
  // The code of a failed new review after `APPROVAL_EXPIRED`. The token is then dead.
  const [rereadFailed, setRereadFailed] = useState<string | null>(null);
  // The code of a rejection other than `APPROVAL_EXPIRED`. A rejected response is a refusal at or before acceptance and consumes no review token (contract §9), so Start update stays enabled.
  const [rejected, setRejected] = useState<string | null>(null);
  const sent = useRef(false);
  const toStart = useRef(false);
  const size = dialogSize("updateSubmodules", client);

  // A new review from the opener starts a new dialog session.
  if (source !== review) {
    setSource(review);
    setValue(review);
    setReviewed(target);
    setAccepted(false);
    setRereadFailed(null);
    setRejected(null);
    sent.current = false;
    toStart.current = false;
  }

  const refused = value.refusals.length > 0;
  const blocked = refused || rereadFailed !== null || blockedReason !== null;
  const reasons = [...value.refusals.map((_, i) => `${reasonId}-${i}`), ...(rereadFailed === null ? [] : [`${reasonId}-reread`]), ...(blockedReason === null ? [] : [`${reasonId}-busy`])];
  const pathOf = new Map(value.rows.map((row) => [row.rowId, row.path]));

  async function start() {
    if (blocked || sent.current) return;
    sent.current = true;
    setRejected(null);
    let seen = false;
    const response: BridgeResponse = await trackOperation(
      "updateSubmodules",
      undefined,
      (onProgress: (event: ProgressEvent) => void) => bridge.updateSubmodules(reviewed, { submoduleReviewToken: value.submoduleReviewToken, start: true }, onProgress),
      (op) => {
        onOperation(op);
        if (!seen && passedAcceptance(op)) {
          seen = true;
          toStart.current = true;
          setAccepted(true);
        }
      },
    );
    if (seen) return;
    if (response.state === "rejected" && response.code === "APPROVAL_EXPIRED") {
      const now = current();
      const next = { repositoryId: reviewed.repositoryId, repositoryGeneration: now.repositoryGeneration };
      const fresh = await bridge.reviewSubmodules(next, { snapshotId: now.snapshotId });
      if (fresh.state === "succeeded") {
        setValue(fresh.result as SubmoduleReviewValue);
        setReviewed(next);
      } else setRereadFailed(fresh.code ?? fresh.state);
    } else if (response.state === "rejected") setRejected(response.code ?? response.state);
    sent.current = false;
  }

  // Base UI reads `finalFocus` when the dialog closes: Cancel in the status bar after acceptance, else the opener.
  const returnFocus = () => (toStart.current ? startFocus() : focusOf(finalFocus));
  // A sent request can still start the update, so the dialog stays until its acceptance or rejection.
  const cancel = () => void (sent.current || onCancel());

  return (
    <Dialog open={open && !accepted} onOpenChange={(next) => void (next || cancel())}>
      <DialogContent
        showCloseButton={false}
        initialFocus={heading}
        finalFocus={returnFocus}
        className="flex max-w-none flex-col gap-0 p-0 sm:max-w-none"
        style={{ width: size.width, height: size.height }}
      >
        <DialogTitle ref={heading} id={headingId} tabIndex={-1} className="px-4 py-3">
          Update submodules
        </DialogTitle>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-4 py-2">
          <p>{DISCLOSURE}</p>
          {value.rows.length === 0 ? (
            <p>{NO_ROWS}</p>
          ) : (
            <RovingList labelledBy={headingId}>
              {value.rows.map((row) => (
                <div key={row.rowId} style={{ paddingLeft: 16 * row.depth }}>
                  <p className="break-all">
                    {row.path}
                    {row.parentRowId === null || !pathOf.has(row.parentRowId) ? null : <span className="sr-only">{`, in ${pathOf.get(row.parentRowId)}`}</span>}
                  </p>
                  {row.url === null ? null : <code className="block break-all">{row.url}</code>}
                  <p>{actionText(row)}</p>
                  {row.remotes.map((remote) => (
                    <p key={remote.name} className="break-all">
                      <code>{remote.url}</code>
                      {remote.default ? " (default)" : null}
                    </p>
                  ))}
                  {row.notes.map((note, i) => (
                    <p key={i}>{note}</p>
                  ))}
                </div>
              ))}
            </RovingList>
          )}
          {value.refusals.map((refusal, i) => (
            <div key={i} className="flex flex-col gap-1">
              <p id={`${reasonId}-${i}`}>{refusal.text}</p>
              {refusal.remedy?.text === undefined ? null : <p>{refusal.remedy.text}</p>}
              {typeof refusal.remedy?.command === "string" ? <code className="block break-all">{refusal.remedy.command}</code> : null}
              <div>
                {typeof refusal.remedy?.command === "string" ? <CopyButton text={refusal.remedy.command}>Copy command</CopyButton> : <CopyButton text={refusal.path}>Copy path</CopyButton>}
              </div>
            </div>
          ))}
          {rereadFailed === null ? null : (
            <p id={`${reasonId}-reread`} role="alert">
              Submodule review did not complete: <code>{rereadFailed}</code>
            </p>
          )}
          {rejected === null ? null : (
            <p role="alert">
              Update submodules did not start: <code>{rejected}</code>
            </p>
          )}
          {blockedReason === null ? null : <p id={`${reasonId}-busy`}>{blockedReason}</p>}
          {value.programs.length === 0 ? null : (
            <>
              <p id={programsId}>{PROGRAMS}</p>
              <RovingList labelledBy={programsId}>
                {value.programs.map((program, i) => (
                  <div key={i}>
                    {/* A row ID outside the plan has no path. Its row ID shows, never an empty path. */}
                    <p className="break-all">{"rowId" in program ? (pathOf.get(program.rowId) ?? <code>{program.rowId}</code>) : program.gitDirectory}</p>
                    <p className="break-all">
                      <code>{program.key}</code> <code>{program.program}</code>
                    </p>
                    <p className="break-all">
                      {program.scope} <code>{program.origin}</code>
                    </p>
                    {program.digest === "unchecked" ? <p>{UNCHECKED}</p> : null}
                  </div>
                ))}
              </RovingList>
            </>
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 px-4 py-3">
          <Button type="button" variant="outline" onClick={cancel}>
            Cancel
          </Button>
          <Button type="button" disabled={blocked} focusableWhenDisabled aria-describedby={blocked ? reasons.join(" ") : undefined} onClick={() => void start()}>
            Start update
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
