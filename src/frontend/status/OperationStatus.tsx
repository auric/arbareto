// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import { WarningIcon } from "../app/NoticeBand";
import { CopyButton } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge, ProgressEvent } from "../bridge";
import { Button } from "../components/ui/button";
import { branchName } from "../history/HistoryView";
import type { Mode } from "../keyboard/shortcuts";
import { cn } from "../lib/utils";

// plan.md "Status area", "Required visible states" (Succeeded, Busy, State unknown), "Keyboard and focus" (Status area row), and the Confirm row of "Task flow and command placement".

export type StatusOperation = {
  /** A new value starts a new operation: the area and its content clear. */
  requestId: string;
  kind: "commit" | "applyHunk" | "applyFile" | "updateSubmodules";
  direction?: "stage" | "unstage";
  /** The latest progress event, or null before the first one. */
  progress: ProgressEvent | null;
  /** The terminal response, or null while the operation runs. */
  response: BridgeResponse | null;
};
export type StatusRegionHandle = {
  /** The F6 target of the status region, or null when the region is no F6 stop. */
  entry(): HTMLElement | null;
};
export type OperationStatusProps = {
  bridge: Pick<ReturnType<typeof createBridge>, "cancel" | "getOperation">;
  /** Null after another repository opens. */
  operation: StatusOperation | null;
  /** The HEAD that the commit used. */
  head: Head | null;
  /** The workspace holds a current trust ID (contract §9 "Lingering count"). */
  trusted: boolean;
  mode: Mode;
  modalOpen: boolean;
  /** The Space refusal of the second live element. Null clears it. */
  refusal: string | null;
  onFocusMessageField(): void;
  onClearMessage(): void;
  onRefresh(): void;
  /** The plan.md "Status area" maximum in DIPs (`statusAreaHeight`). */
  areaMaxHeight?: number;
  ref?: Ref<StatusRegionHandle>;
};

type Outcome = {
  commitOid?: string;
  outputTail?: string;
  remedy?: { text?: string; command?: string | null };
  foreign?: string[];
  lingeringDescendants?: number;
  failure?: string;
  path?: string;
};
type StallRemedy = { text: string; command?: string };
type Head = WorkspaceSnapshot["head"];

const HEADING: Partial<Record<StatusOperation["kind"], string>> = { commit: "Commit details", updateSubmodules: "Update submodules details" };
const STALL_SENTENCE = "Git may be waiting for input.";
// Contract §6 "Activity and stall notice".
const STALL_NOTICE = "Git may be waiting for a prompt that Arbareto cannot show, or for a sign-in window. To answer a hidden prompt, select Cancel and run this command in a terminal.";
// Data-model §7 and plan.md "Status area": these commit states open the area.
const OPENING_COMMIT_STATES = ["failed", "failed-with-effects", "completed-with-effects"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isText = (value: unknown): value is string => typeof value === "string";

function outcomeOf(response: BridgeResponse | null | undefined): Outcome {
  const r = response?.result;
  if (!isObject(r)) return {};
  const remedy = isObject(r.remedy) ? { text: isText(r.remedy.text) ? r.remedy.text : undefined, command: isText(r.remedy.command) ? r.remedy.command : null } : undefined;
  return {
    commitOid: isText(r.commitOid) ? r.commitOid : undefined,
    outputTail: isText(r.outputTail) ? r.outputTail : undefined,
    remedy,
    foreign: Array.isArray(r.foreign) ? r.foreign.filter(isText) : undefined,
    lingeringDescendants: typeof r.lingeringDescendants === "number" ? r.lingeringDescendants : undefined,
    failure: isText(r.failure) ? r.failure : undefined,
    path: isText(r.path) ? r.path : undefined,
  };
}

/** plan.md "Required visible states", Succeeded, and "Long text" (singular count). */
export function lingeringSentence(count: number, trusted: boolean): string {
  const runs = count === 1 ? "1 process that Git or a hook started still runs." : `${count} processes that Git or a hook started still run.`;
  return `${runs} Closing Arbareto ends them.${trusted ? " Revoke trust also ends them." : ""}`;
}

/** The Confirm row: where focus goes at a commit outcome. */
export function outcomeFocus(mode: Mode, modalOpen: boolean, cancelFocused: boolean): "message-field" | "area-heading" | "stay" {
  if (modalOpen) return "stay";
  if (mode === "changes") return "message-field";
  return cancelFocused ? "area-heading" : "stay";
}

// plan.md defines no running text and no canceled, failed, or effects outcome text. These states show no text. T236 adds the submodule step text.
function operationText(op: StatusOperation, head: Head | null, trusted: boolean): string {
  const response = op.response;
  if (response === null) {
    const p = op.progress;
    return p?.state === "cancel-requested" ? "Cancel requested" : "";
  }
  let text = "";
  if (response.state === "unknown") text = "State unknown";
  else if (response.state === "succeeded") {
    const oid = outcomeOf(response).commitOid;
    if (op.kind === "commit" && oid !== undefined && head !== null)
      // plan.md "History graph design": a short ID is the first 12 hex digits.
      text = head.state === "detached" ? `Committed ${oid.slice(0, 12)} on detached HEAD` : `Committed ${oid.slice(0, 12)} to ${branchName(head.target)}`;
    else if (op.kind === "applyHunk") text = op.direction === "unstage" ? "Hunk unstaged" : "Hunk staged";
    else if (op.kind === "applyFile") text = op.direction === "unstage" ? "File unstaged" : "File staged";
    else if (op.kind === "updateSubmodules") text = "Submodules updated";
  }
  const count = outcomeOf(response).lingeringDescendants ?? 0;
  if (count === 0) return text;
  return text === "" ? lingeringSentence(count, trusted) : `${text}. ${lingeringSentence(count, trusted)}`;
}

function readStallRemedy(response: BridgeResponse): StallRemedy | null {
  const value = isObject(response.result) ? response.result.stallRemedy : undefined;
  if (response.state !== "succeeded" || !isObject(value) || !isText(value.text)) return null;
  return isText(value.command) ? { text: value.text, command: value.command } : { text: value.text };
}

type Area = { requestId: string; open: boolean; forStall: boolean };
type Stall = { requestId: string; remedy: StallRemedy | null; ending: boolean };

export function OperationStatus({ bridge, operation: op, head, trusted, mode, modalOpen, refusal, onFocusMessageField, onClearMessage, onRefresh, areaMaxHeight, ref }: OperationStatusProps) {
  const [area, setArea] = useState<Area | null>(null);
  const [stall, setStall] = useState<Stall | null>(null);
  const [truncated, setTruncated] = useState(false);
  const headingId = useId();
  const areaId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const stallCopyRef = useRef<HTMLSpanElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const lastTarget = useRef<HTMLElement | null>(null);
  const firstEntry = useRef(false);
  const focusHeading = useRef(false);
  const handled = useRef<string | null>(null);
  const seen = useRef<string | null>(null);
  const cancelHadFocus = useRef(false);
  const wasStalled = useRef(false);
  const canceled = useRef<string | null>(null);

  const requestId = op?.requestId ?? null;
  const response = op?.response ?? null;
  const outcome = outcomeOf(response);
  const heading = op === null ? undefined : HEADING[op.kind];
  const liveText = op === null ? "" : operationText(op, head, trusted);
  const running = op !== null && response === null;
  const stalled = running && op.progress?.stalled === true;
  const percent = running && op.kind === "updateSubmodules" ? op.progress?.counters.percent : undefined;
  const current = area !== null && area.requestId === requestId ? area : null;
  const notice = stall !== null && stall.requestId === requestId ? stall : null;
  const effects = response?.state === "completed-with-effects" && outcome.commitOid !== undefined;
  const details =
    notice !== null ||
    outcome.outputTail !== undefined ||
    outcome.remedy !== undefined ||
    (outcome.foreign?.length ?? 0) > 0 ||
    (outcome.lingeringDescendants ?? 0) > 0 ||
    outcome.failure !== undefined ||
    outcome.path !== undefined ||
    effects;
  const hasArea = heading !== undefined && (details || truncated || current !== null);
  const open = hasArea && current?.open === true;

  // The outcome removes Cancel before any effect runs, so the focus on Cancel is read before that commit.
  if (response !== null && seen.current !== requestId && typeof document !== "undefined") {
    seen.current = requestId;
    cancelHadFocus.current = cancelRef.current !== null && document.activeElement === cancelRef.current;
  }

  function openArea(forStall: boolean) {
    if (requestId === null) return;
    firstEntry.current = true;
    setArea((a) => (a !== null && a.requestId === requestId && a.open ? a : { requestId, open: true, forStall }));
  }

  // The notice is its text in the content region and its Copy command in the actions row.
  const inNotice = (node: Node | null) => noticeRef.current?.contains(node) === true || stallCopyRef.current?.contains(node) === true;

  function hideNotice(focused: Node | null) {
    setStall(null);
    // An area that opened only for the notice collapses, unless focus is inside it.
    const inside = regionRef.current?.querySelector('[data-slot="status-area"]')?.contains(focused) === true;
    if (!inside) setArea((a) => (a !== null && a.forStall ? null : a));
  }

  // Contract §6: one `getOperation` call after each progress event that sets `stalled`.
  useEffect(() => {
    if (stalled && !wasStalled.current && requestId !== null) {
      setStall({ requestId, remedy: null, ending: false });
      if (current?.open !== true) openArea(true);
      const operationId = op!.progress!.operationId;
      void bridge.getOperation({ operationId }).then((answer) => {
        const remedy = readStallRemedy(answer);
        setStall((s) => (s !== null && s.requestId === requestId && remedy !== null ? { ...s, remedy } : s));
      });
    } else if (!stalled && wasStalled.current && notice !== null) {
      // A notice that holds focus stays until focus leaves it.
      if (inNotice(document.activeElement)) setStall({ ...notice, ending: true });
      else hideNotice(document.activeElement);
    }
    wasStalled.current = stalled;
  }, [stalled, requestId]);

  useLayoutEffect(() => {
    if (op === null || response === null || handled.current === requestId) return;
    handled.current = requestId;
    const target = op.kind === "commit" ? outcomeFocus(mode, modalOpen, cancelHadFocus.current) : "stay";
    const count = outcome.lingeringDescendants ?? 0;
    const opens = target === "area-heading" || (op.kind === "commit" && OPENING_COMMIT_STATES.includes(response.state)) || count > 0 || op.kind === "updateSubmodules";
    if (heading !== undefined && opens) openArea(false);
    if (target === "message-field") onFocusMessageField();
    else if (target === "area-heading" && heading !== undefined) focusHeading.current = true;
  }, [response]);

  useLayoutEffect(() => {
    if (!focusHeading.current || headingRef.current === null) return;
    focusHeading.current = false;
    firstEntry.current = false;
    headingRef.current.focus();
  });

  // plan.md "Long text": a truncated status text shows the toggle. A shown refusal hides the text from view, so it keeps the last value.
  useLayoutEffect(() => {
    const element = textRef.current;
    if (element === null || refusal !== null) return;
    const measure = () => setTruncated(element.scrollWidth > element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [liveText, refusal]);

  useImperativeHandle(ref, () => ({
    entry() {
      if (open && firstEntry.current) {
        firstEntry.current = false;
        return headingRef.current;
      }
      const last = lastTarget.current;
      if (last !== null && last.isConnected && regionRef.current?.contains(last)) return last;
      if (open) return headingRef.current;
      return footerRef.current?.querySelector("button") ?? (liveText === "" ? null : textRef.current);
    },
  }));

  function toggle() {
    if (requestId === null) return;
    if (!open) firstEntry.current = true;
    setArea({ requestId, open: !open, forStall: false });
  }

  function collapse() {
    if (requestId !== null) setArea({ requestId, open: false, forStall: false });
  }

  function cancel() {
    const operationId = op?.progress?.operationId;
    if (operationId === undefined || op?.progress?.state === "cancel-requested" || canceled.current === requestId) return;
    canceled.current = requestId;
    void bridge.cancel({ operationId });
  }

  const copies: { key: string; label: "Copy command" | "Copy path"; text: string }[] = [];
  if (notice?.remedy?.command !== undefined) copies.push({ key: "stall", label: "Copy command", text: notice.remedy.command });
  if (isText(outcome.remedy?.command)) copies.push({ key: "remedy", label: "Copy command", text: outcome.remedy.command });
  if (outcome.path !== undefined) copies.push({ key: "path", label: "Copy path", text: outcome.path });
  for (const path of outcome.foreign ?? []) copies.push({ key: `lock:${path}`, label: "Copy path", text: path });

  return (
    <div
      ref={regionRef}
      data-slot="status-region"
      className="contents"
      onFocus={(event) => void (lastTarget.current = event.target)}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (notice?.ending && !inNotice(next)) hideNotice(next);
      }}
    >
      {open ? (
        <section
          id={areaId}
          data-slot="status-area"
          aria-labelledby={headingId}
          className="grid border-t border-divider px-2"
          style={{ gridTemplateAreas: '"heading hide" "content content" "actions actions"', gridTemplateColumns: "1fr auto", minHeight: "calc(var(--h-area-heading) + 2 * var(--h-row))", maxHeight: areaMaxHeight }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            collapse();
            toggleRef.current?.focus();
          }}
        >
          <h2 ref={headingRef} id={headingId} tabIndex={-1} className="flex items-center font-heading text-sm" style={{ gridArea: "heading", minHeight: "var(--h-area-heading)" }}>
            {heading}
          </h2>
          <div tabIndex={0} aria-labelledby={headingId} className="min-h-0 overflow-auto" style={{ gridArea: "content" }}>
            {liveText === "" ? null : <p>{liveText}</p>}
            {notice === null ? null : (
              <div ref={noticeRef} className="flex gap-2">
                <WarningIcon />
                <div>
                  <p>{STALL_NOTICE}</p>
                  {notice.remedy?.command === undefined ? null : <code className="break-all">{notice.remedy.command}</code>}
                  {notice.remedy === null ? null : <p>{notice.remedy.text}</p>}
                </div>
              </div>
            )}
            {outcome.failure === undefined ? null : <code className="block">{outcome.failure}</code>}
            {outcome.path === undefined ? null : <code className="block break-all">{outcome.path}</code>}
            {outcome.outputTail === undefined ? null : <pre className="font-mono whitespace-pre-wrap">{outcome.outputTail}</pre>}
            {outcome.remedy?.text === undefined ? null : <p>{outcome.remedy.text}</p>}
            {isText(outcome.remedy?.command) ? <code className="block break-all">{outcome.remedy.command}</code> : null}
            {(outcome.foreign ?? []).map((path) => (
              <code key={path} className="block break-all">
                {path}
              </code>
            ))}
            {effects ? <p>{`Git created commit ${outcome.commitOid}. Repository state changed during execution. Review the resulting commit and staged changes.`}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2 py-1" style={{ gridArea: "actions" }}>
            {copies.map((c) =>
              c.key === "stall" ? (
                <span key={c.key} ref={stallCopyRef} className="contents">
                  <CopyButton text={c.text}>{c.label}</CopyButton>
                </span>
              ) : (
                <CopyButton key={c.key} text={c.text}>
                  {c.label}
                </CopyButton>
              ),
            )}
            {effects ? (
              <Button variant="outline" size="sm" onClick={onClearMessage}>
                Clear message
              </Button>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" className="self-center" style={{ gridArea: "hide" }} onClick={collapse}>
            Hide details
          </Button>
        </section>
      ) : null}
      <footer ref={footerRef} className="flex items-center gap-2 border-t border-divider px-2" style={{ minHeight: "var(--h-status-bar)" }}>
        <span ref={textRef} role="status" tabIndex={-1} className={cn("min-w-0 flex-1 truncate", refusal !== null && "sr-only")}>
          <span>{liveText}</span>
          {stalled ? <span> {STALL_SENTENCE}</span> : null}
        </span>
        {percent === undefined ? null : <span className="shrink-0 tabular-nums">{percent}%</span>}
        <span role="status" className="min-w-0 flex-1 truncate">
          {refusal === null ? null : (
            <span className="inline-flex items-center gap-1">
              <WarningIcon />
              {refusal}
            </span>
          )}
        </span>
        {response?.state === "unknown" ? (
          <Button variant="outline" size="sm" onClick={onRefresh}>
            Refresh
          </Button>
        ) : null}
        {hasArea ? (
          <Button ref={toggleRef} variant="ghost" size="sm" aria-expanded={open} aria-controls={open ? areaId : undefined} onClick={toggle}>
            {open ? "Hide details" : "Show details"}
          </Button>
        ) : null}
        {running ? (
          <Button ref={cancelRef} variant="outline" size="sm" onClick={cancel}>
            Cancel
          </Button>
        ) : null}
      </footer>
    </div>
  );
}
