// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import { WarningIcon } from "../app/NoticeBand";
import { CopyButton } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge, ProgressEvent } from "../bridge";
import { Button } from "../components/ui/button";
import { branchName } from "../history/HistoryView";
import type { Panel } from "../keyboard/shortcuts";
import { splitPath, WINDOWS_SEPARATORS } from "../lib/path";
import { cn } from "../lib/utils";

// plan.md "Status area", "Status and fallback texts", "Required visible states" (Succeeded, Busy, Cancel requested, Canceled, Completed with effects, State unknown), "Keyboard and focus" (Status area row), and the Commit outcome row of "Task flow and command placement".

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
  /** The `worktreeRoot` of the workspace. */
  worktreeRoot: string;
  /** The HEAD that the commit used. */
  head: Head | null;
  /** The workspace holds a current trust ID (contract §9 "Lingering count"). */
  trusted: boolean;
  /** The docked panel (plan.md "Dock region"). */
  panel: Panel;
  /** The docked commit panel element. Commit sits inside it. */
  commitPanel?: RefObject<HTMLElement | null>;
  modalOpen: boolean;
  /** The Space refusal of the second live element. Null clears it. */
  refusal: string | null;
  onFocusMessageField(): void;
  onClearMessage(): void;
  onRefresh(): void;
  /** The plan.md "Status area" maximum in DIPs (`statusAreaHeight`). */
  areaMaxHeight?: number;
  /** A workbench status text in its own live element before the operation text: "No repository open", "Refreshing…", "State unknown", a WSL start, or a notice. An outcome never hides it. */
  notice?: ReactNode;
  /** The end of the status bar, outside every live region: the Git segment. */
  children?: ReactNode;
  ref?: Ref<StatusRegionHandle>;
};

/** Sends one mutation and reports its start, each progress event, and its terminal response as one `StatusOperation`. */
export async function trackOperation(
  kind: StatusOperation["kind"],
  direction: StatusOperation["direction"],
  send: (onProgress: (event: ProgressEvent) => void) => Promise<BridgeResponse>,
  report?: (op: StatusOperation) => void,
): Promise<BridgeResponse> {
  let op: StatusOperation = { requestId: crypto.randomUUID(), kind, direction, progress: null, response: null };
  report?.(op);
  const response = await send((event) => {
    op = { ...op, progress: event };
    report?.(op);
  });
  report?.({ ...op, response });
  return response;
}

type Outcome = {
  commitOid?: string;
  outputTail?: string;
  remedy?: { text?: string; command?: string | null };
  foreign?: string[];
  lingeringDescendants?: number;
  failure?: string;
  path?: string;
  reason?: string;
  effects?: Record<EffectField, boolean>;
};
type StallRemedy = { text: string; command?: string };
type Head = WorkspaceSnapshot["head"];
/** A status text: `lead`, then `code` in the code font, then `tail`. */
type Line = { lead: string; code?: string; tail: string };

// plan.md "Status and fallback texts" (mutation name), "Required visible states" (Busy running text), and "Status area" (heading).
const TEXTS: Record<string, [name: string, running: string, heading: string]> = {
  commit: ["Commit", "Committing", "Commit details"],
  "applyHunk:stage": ["Hunk staging", "Staging hunk", "Stage hunk details"],
  "applyHunk:unstage": ["Hunk unstaging", "Unstaging hunk", "Unstage hunk details"],
  "applyFile:stage": ["File staging", "Staging file", "Stage file details"],
  "applyFile:unstage": ["File unstaging", "Unstaging file", "Unstage file details"],
  updateSubmodules: ["Update submodules", "Updating submodules", "Update submodules details"],
};
const textsOf = (op: StatusOperation) => TEXTS[op.kind === "applyHunk" || op.kind === "applyFile" ? `${op.kind}:${op.direction ?? "stage"}` : op.kind]!;
// Data-model `effects`: the field order of the sentences.
const EFFECT_FIELDS = ["head", "index", "workingFiles", "operationState"] as const;
type EffectField = (typeof EFFECT_FIELDS)[number];
// plan.md "Required visible states", Completed with effects.
const EFFECT_SENTENCES: Record<string, Record<EffectField, string>> = {
  "completed-with-effects": {
    head: "HEAD differs from the planned result.",
    index: "The index differs from the planned result.",
    workingFiles: "Working files changed.",
    operationState: "The Git operation state differs from the planned result.",
  },
  "failed-with-effects": { head: "HEAD changed.", index: "The index changed.", workingFiles: "Working files changed.", operationState: "The Git operation state changed." },
};
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
  const e = r.effects;
  return {
    reason: isText(r.reason) ? r.reason : undefined,
    effects: isObject(e) && EFFECT_FIELDS.every((f) => typeof e[f] === "boolean") ? (e as Record<EffectField, boolean>) : undefined,
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

/** plan.md Commit outcome row: where focus goes at a commit outcome. `from` is the focus when the outcome arrives. */
export function outcomeFocus(panel: Panel, modalOpen: boolean, from: "cancel" | "panel" | "other"): "message-field" | "area-heading" | "stay" {
  if (modalOpen) return "stay";
  if (panel === "commit") return from === "other" ? "stay" : "message-field";
  return from === "cancel" ? "area-heading" : "stay";
}

/** plan.md "Header layout": the last folder name of the worktree root. A WSL root ends in the same name. */
export function repositoryName(worktreeRoot: string): string {
  return splitPath(worktreeRoot, WINDOWS_SEPARATORS)[1];
}

const plain = (line: Line) => line.lead + (line.code ?? "") + line.tail;
const lineNode = (line: Line) => (
  <>
    {line.lead}
    {line.code === undefined ? null : <code>{line.code}</code>}
    {line.tail}
  </>
);

// T236 replaces the running text of Update submodules with the step text.
function operationText(op: StatusOperation, worktreeRoot: string, head: Head | null, trusted: boolean): Line {
  const [name, verb] = textsOf(op);
  const response = op.response;
  if (response === null) return { lead: op.progress?.state === "cancel-requested" ? "Cancel requested" : `${verb} in ${repositoryName(worktreeRoot)}…`, tail: "" };
  const outcome = outcomeOf(response);
  // plan.md "Status and fallback texts": the contract §9 code, or the result state without a code.
  const coded = (lead: string): Line => ({ lead, code: response.code ?? response.state, tail: outcome.reason === undefined ? "" : ` ${outcome.reason}` });
  // plan.md "History graph design": a short ID is the first 12 hex digits.
  const short = outcome.commitOid?.slice(0, 12);
  let line: Line = { lead: "", tail: "" };
  if (response.state === "unknown") line.lead = "State unknown";
  else if (response.state === "canceled") line.lead = `${name} canceled`;
  else if (response.state === "failed") line = coded(`${name} did not complete: `);
  else if (response.state === "rejected") line = coded(`${name} did not start: `);
  else if (response.state === "failed-with-effects") line = coded(`${name} did not complete and left effects: `);
  else if (response.state === "completed-with-effects") line.lead = op.kind === "commit" && short !== undefined ? `Committed ${short} with effects` : `${name} completed with effects`;
  else if (response.state === "succeeded") {
    if (op.kind === "commit" && short !== undefined && head !== null) line.lead = head.state === "detached" ? `Committed ${short} on detached HEAD` : `Committed ${short} to ${branchName(head.target)}`;
    else if (op.kind === "applyHunk") line.lead = op.direction === "unstage" ? "Hunk unstaged" : "Hunk staged";
    else if (op.kind === "applyFile") line.lead = op.direction === "unstage" ? "File unstaged" : "File staged";
    else if (op.kind === "updateSubmodules") line.lead = "Submodules updated";
  }
  const count = outcome.lingeringDescendants ?? 0;
  if (count === 0) return line;
  // plan.md "Required visible states", Succeeded: "<outcome>. <lingering sentence>".
  return plain(line) === "" ? { lead: lingeringSentence(count, trusted), tail: "" } : { ...line, tail: `${line.tail}. ${lingeringSentence(count, trusted)}` };
}

function readStallRemedy(response: BridgeResponse): StallRemedy | null {
  const value = isObject(response.result) ? response.result.stallRemedy : undefined;
  if (response.state !== "succeeded" || !isObject(value) || !isText(value.text)) return null;
  return isText(value.command) ? { text: value.text, command: value.command } : { text: value.text };
}

type Area = { requestId: string; open: boolean; forStall: boolean };
type Stall = { requestId: string; remedy: StallRemedy | null; ending: boolean };

export function OperationStatus({ bridge, operation: op, worktreeRoot, head, trusted, panel, commitPanel, modalOpen, refusal, onFocusMessageField, onClearMessage, onRefresh, areaMaxHeight, notice: workbenchNotice, children, ref }: OperationStatusProps) {
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
  const focusFrom = useRef<"cancel" | "panel" | "other">("other");
  const wasStalled = useRef(false);
  const canceled = useRef<string | null>(null);

  const requestId = op?.requestId ?? null;
  const response = op?.response ?? null;
  const outcome = outcomeOf(response);
  const heading = op === null ? undefined : textsOf(op)[2];
  const line = op === null ? null : operationText(op, worktreeRoot, head, trusted);
  const liveText = line === null ? "" : plain(line);
  const running = op !== null && response === null;
  const stalled = running && op.progress?.stalled === true;
  const percent = running && op.kind === "updateSubmodules" ? op.progress?.counters.percent : undefined;
  const current = area !== null && area.requestId === requestId ? area : null;
  const notice = stall !== null && stall.requestId === requestId ? stall : null;
  const suggested = op?.kind === "commit" && response?.state === "completed-with-effects" && outcome.commitOid !== undefined;
  const effects = outcome.effects;
  const sentences = response !== null && effects !== undefined && response.state in EFFECT_SENTENCES ? EFFECT_FIELDS.filter((f) => effects[f]).map((f) => EFFECT_SENTENCES[response.state]![f]) : [];
  const markerFailed = response?.code === "RECOVERY_MARKER_FAILED";
  const details =
    notice !== null ||
    sentences.length > 0 ||
    outcome.outputTail !== undefined ||
    outcome.remedy !== undefined ||
    (outcome.foreign?.length ?? 0) > 0 ||
    (outcome.lingeringDescendants ?? 0) > 0 ||
    outcome.failure !== undefined ||
    outcome.path !== undefined ||
    suggested;
  const hasArea = heading !== undefined && (details || truncated || current !== null);
  const open = hasArea && current?.open === true;

  // The outcome removes Cancel before any effect runs, so the focus on Cancel is read before that commit.
  if (response !== null && seen.current !== requestId && typeof document !== "undefined") {
    seen.current = requestId;
    const active = document.activeElement;
    focusFrom.current = cancelRef.current !== null && active === cancelRef.current ? "cancel" : commitPanel?.current?.contains(active) === true ? "panel" : "other";
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
    const commit = op.kind === "commit";
    const target = commit ? outcomeFocus(panel, modalOpen, focusFrom.current) : "stay";
    const count = outcome.lingeringDescendants ?? 0;
    // plan.md "Status area", Opening: every commit outcome opens the area while the commit details are docked.
    const opens = (commit && (panel === "details" || OPENING_COMMIT_STATES.includes(response.state))) || count > 0 || op.kind === "updateSubmodules";
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
            {line === null || liveText === "" ? null : <p>{lineNode(line)}</p>}
            {notice === null ? null : (
              <div ref={noticeRef} data-slot="stall-notice" className="flex gap-2">
                <WarningIcon />
                <div>
                  <p>{STALL_NOTICE}</p>
                  {notice.remedy?.command === undefined ? null : <code className="break-all">{notice.remedy.command}</code>}
                  {notice.remedy === null ? null : <p>{notice.remedy.text}</p>}
                </div>
              </div>
            )}
            {outcome.failure === undefined ? null : markerFailed ? (
              <p>
                Failure class: <code>{outcome.failure}</code>
              </p>
            ) : (
              <code className="block">{outcome.failure}</code>
            )}
            {outcome.path === undefined ? null : markerFailed ? (
              <p className="break-all">
                Recovery folder: <code>{outcome.path}</code>
              </p>
            ) : (
              <code className="block break-all">{outcome.path}</code>
            )}
            {outcome.outputTail === undefined ? null : <pre className="font-mono whitespace-pre-wrap">{outcome.outputTail}</pre>}
            {outcome.remedy?.text === undefined ? null : <p>{outcome.remedy.text}</p>}
            {isText(outcome.remedy?.command) ? <code className="block break-all">{outcome.remedy.command}</code> : null}
            {(outcome.foreign ?? []).map((path) => (
              <code key={path} className="block break-all">
                {path}
              </code>
            ))}
            {sentences.length === 0 ? null : <p>{sentences.join(" ")}</p>}
            {suggested ? <p>{`Git created commit ${outcome.commitOid}. Repository state changed during execution. Review the resulting commit and staged changes.`}</p> : null}
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
            {suggested ? (
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
        {workbenchNotice === undefined ? null : (
          <span role="status" className="min-w-0 shrink truncate">
            {workbenchNotice}
          </span>
        )}
        <span ref={textRef} role="status" tabIndex={-1} className={cn("min-w-0 flex-1 truncate", refusal !== null && "sr-only")}>
          {/* A line with a code is one added element, so the outcome stays one live-node change. */}
          <span>{line === null ? null : line.code === undefined ? plain(line) : <span>{lineNode(line)}</span>}</span>
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
        {children}
      </footer>
    </div>
  );
}
