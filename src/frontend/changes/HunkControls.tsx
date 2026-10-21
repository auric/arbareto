// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Fragment, useId, useRef, useState, type RefObject } from "react";
import type { ChangeEntry, Comparison, WorkspaceSnapshot } from "../../contracts/envelope";
import { WarningIcon } from "../app/NoticeBand";
import type { BridgeResponse, createBridge } from "../bridge";
import { RUNNING_REASON, RunningTooltip } from "../components/running-tooltip";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import type { TrustReport } from "../trust/TrustChip";
import { BUSY_REASON } from "./ChangesPane";
import type { LineState } from "./ComparisonView";
import { changeRows, pickLines } from "./hunk-mapping";
import { LIMITATION_TEXT } from "./limitation-text";

// plan.md "Task flow and command placement" (Select a hunk, Stage or unstage), "Hunk toolbar layout", "Long text" (reason line), and "Keyboard and focus" (Comparison, Unavailable control).

type Category = ChangeEntry["category"];
type Direction = "next" | "previous";
export type StagingTarget = { repositoryId: string; repositoryGeneration: number };
export type Eligibility = WorkspaceSnapshot["hunkEligibility"];
/**
 * A workspace state that blocks hunk and file actions. `busy` is a running file action, `running` any other mutation.
 * `operation` is a merge or a rebase in progress, which the notice band conflict row finishes (feature 003 FR-030). `conflicted` is every other state that is not `normal`.
 */
export type Blocked = "conflicted" | "operation" | "loading" | "incomplete" | "stale" | "expired" | "busy" | "running" | "unknown" | null;

export const BLOCKED_TEXT: Record<NonNullable<Blocked>, string> = {
  conflicted: "Arbareto blocks changes until the Git operation ends outside Arbareto. Then select Refresh (F5).",
  operation: "A merge or a rebase is in progress. Finish it with Mark resolved and the actions in the Notices band.",
  loading: "A status page is still loading.",
  incomplete: "The status read is incomplete, so changes stay blocked.",
  stale: "The comparison is not current. Wait for the new comparison.",
  expired: "The approval expired. Arbareto reads the comparison again.",
  busy: BUSY_REASON,
  running: "A Git operation is running. Wait for its result, or select Cancel.",
  unknown: "State unknown. Select Refresh (F5) first.",
};
/** The block of an operation state that is not `normal`. Only `merging` and `rebasing` have the conflict row. */
export const operationBlock = (operationState: WorkspaceSnapshot["operationState"]): Blocked =>
  operationState === "normal" ? null : operationState === "merging" || operationState === "rebasing" ? "operation" : "conflicted";
export const TRUST_TEXT = "Staging needs trust. Select Not trusted in the status bar.";
// plan.md "Required visible states", Stale selection.
export const STALE_TEXT = "The comparison or the staged scope changed. Arbareto reads it again.";
const COMPARISON_INCOMPLETE = "The comparison is incomplete.";
const MAPPING_FAILED = "Hunk actions are unavailable: DISPLAY_MAPPING_FAILED";
const NO_HUNK = "No hunk is selected.";
// Feature 004 plan.md D8 and D15 "Commit view texts": the reasons of contract Δ4 `LINE_ACTION_REASONS`.
export const LINE_TEXT: Record<"context-only" | "several-hunks" | "deleted-file" | "new-file" | "eof-newline", string> = {
  "context-only": "The selection holds only context lines. Select added or removed lines.",
  "several-hunks": "The selection covers two hunks. Select lines of one hunk.",
  "deleted-file": "Git cannot stage or unstage part of a deleted file.",
  "new-file": "Git cannot unstage part of a new file.",
  "eof-newline": 'This hunk holds the Git marker "No newline at end of file". Stage or unstage the whole hunk.',
};
const linesLabel = (unstage: boolean, n: number) => `${unstage ? "Unstage" : "Stage"} ${n} ${n === 1 ? "line" : "lines"}`;
// Contract §4 "Split index" gives this text. The other reasons show the contract §9 code and the reason value.
const SPLIT_INDEX_TEXT = "Git's split index is on for this repository. Arbareto stages hunks and files only with a full index. Stage this change in a terminal.";

/** The reason that blocks every hunk and file action, or null. Contract §7 "Mutation trust": only required read approval blocks. */
export function stagingReason({ blocked, trust, eligibility }: { blocked?: Blocked; trust?: TrustReport | null; eligibility?: Eligibility }): string | null {
  if (blocked) return BLOCKED_TEXT[blocked];
  if (trust?.approvalRequired.reads && trust.state !== "approved") return TRUST_TEXT;
  if (eligibility?.eligible === false) return eligibility.reason === "split-index" ? SPLIT_INDEX_TEXT : `Hunk and file staging are unavailable: UNSUPPORTED_HUNK_PROFILE ${eligibility.reason}`;
  return null;
}

/**
 * plan.md "Hunk toolbar layout". Each width includes the gap after its control. `room.heading` is the heading width less 120 DIPs of path text and Copy path.
 * The controls stay in the heading, else move to one row below it, else the hunk action moves to a second row. No button shrinks.
 */
export function wrapHunkToolbar(widths: { previous: number; next: number; hunkAction: number }, room: { heading: number; row: number }): { heading: string[]; rows: string[][] } {
  const all = ["previous", "next", "hunkAction"];
  const total = widths.previous + widths.next + widths.hunkAction;
  if (total <= room.heading) return { heading: all, rows: [] };
  if (total <= room.row) return { heading: [], rows: [all] };
  return { heading: [], rows: [["previous", "next"], ["hunkAction"]] };
}

/** plan.md "Select a hunk": without a selection, the anchored hunk, else the first or the last hunk. Null disables the direction. */
function stepTarget(ids: readonly string[], selected: string | null, anchored: string | null, direction: Direction): string | null {
  const at = selected === null ? -1 : ids.indexOf(selected);
  if (at < 0) return anchored !== null && ids.includes(anchored) ? anchored : ((direction === "next" ? ids[0] : ids.at(-1)) ?? null);
  return ids[direction === "next" ? at + 1 : at - 1] ?? null;
}

export type HunkControlsProps = {
  bridge: Pick<ReturnType<typeof createBridge>, "applyHunk">;
  /** The repository and the generation of the current capability. Null blocks the hunk action. */
  target?: StagingTarget | null;
  comparison: Comparison;
  category: Category;
  selectedHunk: string | null;
  /** The hunk that the last successful hunk action anchored the viewport to. */
  anchoredHunk: string | null;
  onSelectHunk(hunkId: string): void;
  blocked?: Blocked;
  trust?: TrustReport | null;
  eligibility?: Eligibility;
  /** Contract §4: the display mapping disagrees with the service hunks. */
  displayFailed?: boolean;
  /** More reason line parts, each with the ID that its control takes as its accessible description: the file action and the Stage key. */
  reasons?: readonly ReasonPart[];
  onOperation?(op: StatusOperation): void;
  /** A terminal response of `applyHunk`, with the ordinal of the acted hunk. */
  onEnded?(response: BridgeResponse, ordinal: number): void;
  /** Receives the step function for Alt+Up and Alt+Down in the comparison pane (the T127 page handler). */
  stepRef?: RefObject<((direction: Direction) => void) | null>;
  /** Feature 004 plan.md D15 "Line selection": the line selection of the shown diff. */
  lines?: LineState;
};

/** `quiet` keeps the text as the description of its control only (plan D15 running rule). */
export type ReasonPart = { id: string; text: string | null; quiet?: boolean };

type NavProps = { label: string; icon: IconSvgElement; keys: [aria: string, text: string]; reason: string | null; reasonId: string; onStep(): void };

// A plain call, not a component: the element tree holds the trigger itself.
function navButton({ label, icon, keys, reason, reasonId, onStep }: NavProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" disabled={reason !== null} focusableWhenDisabled style={{ width: "var(--h-row-button)", height: "var(--h-row-button)" }} />}
        aria-label={label}
        aria-keyshortcuts={keys[0]}
        aria-describedby={reason === null ? undefined : reasonId}
        onClick={() => reason === null && onStep()}
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
      </TooltipTrigger>
      <TooltipContent>{`${label} (${keys[1]})`}</TooltipContent>
    </Tooltip>
  );
}

const sentence = (text: string) => text.replace(/\.$/, "");

/**
 * plan.md "Long text": one reason line with an end ellipsis. Each part keeps the ID of its control. ". " joins the shown parts.
 * A part with the text of an earlier part stays as hidden text, so its control keeps its description.
 */
export function ReasonLine({ parts }: { parts: readonly ReasonPart[] }) {
  const shown = new Set<string>();
  const nodes = parts.map(({ id, text, quiet }) => {
    if (text === null) return null;
    const plain = sentence(text);
    if (quiet || shown.has(plain))
      return (
        <span key={id} id={id} hidden>
          {plain}
        </span>
      );
    const first = shown.size === 0;
    shown.add(plain);
    return (
      <Fragment key={id}>
        {first ? null : ". "}
        <span id={id}>{plain}</span>
      </Fragment>
    );
  });
  return (
    <p data-slot="reason-line" className="flex basis-full items-center gap-1 truncate text-muted-text" style={{ height: "var(--h-reason-line)", lineHeight: "var(--h-reason-line)" }}>
      {shown.size === 0 ? null : <WarningIcon />}
      <span className="truncate">
        {nodes}
        {shown.size === 0 ? null : "."}
      </span>
    </p>
  );
}

/** The reason that blocks every hunk action of this comparison, or null. A running mutation gives the D15 running reason. */
function hunkReason(props: HunkControlsProps): string | null {
  const { comparison } = props;
  return (
    (props.blocked === "running" ? RUNNING_REASON : null) ??
    stagingReason(props) ??
    (comparison.support !== "supported" ? (comparison.support === null ? COMPARISON_INCOMPLETE : LIMITATION_TEXT[comparison.support]) : null) ??
    (comparison.completeness.state !== "complete" ? COMPARISON_INCOMPLETE : null) ??
    (props.displayFailed ? MAPPING_FAILED : null) ??
    (props.target ? null : BLOCKED_TEXT.stale)
  );
}

/** One `applyHunk` of `hunk`, with the line ordinals of a line selection (contract Δ4). */
async function sendHunk(props: HunkControlsProps, hunk: Comparison["hunks"][number], lines?: number[]): Promise<BridgeResponse> {
  const { comparison } = props;
  const direction = props.category === "staged" ? "unstage" : "stage";
  const payload = { comparisonId: comparison.comparisonId, hunkId: hunk.hunkId, snapshotId: comparison.snapshotId, direction, ...(lines === undefined ? {} : { lines }) } as const;
  const target = props.target!;
  const response = await trackOperation("applyHunk", direction, (onProgress) => props.bridge.applyHunk(target, payload, onProgress), props.onOperation);
  props.onEnded?.(response, hunk.ordinal);
  return response;
}

/** Spec FR-037: the Stage hunk or Unstage hunk button on one hunk of the diff. */
export function HunkButton(props: HunkControlsProps & { index: number }) {
  const reasonId = useId();
  const running = useRef(false);
  const hunk = props.comparison.hunks[props.index];
  const reason = hunkReason(props);
  const label = props.category === "staged" ? "Unstage hunk" : "Stage hunk";
  if (hunk === undefined) return null;
  return (
    <>
      <RunningTooltip reason={props.blocked === "running" ? reason : null}>
        <Button
          variant="outline"
          size="sm"
          disabled={reason !== null}
          focusableWhenDisabled
          aria-describedby={reason === null ? undefined : reasonId}
          onClick={async () => {
            if (reason !== null || running.current) return;
            running.current = true;
            try {
              await sendHunk(props, hunk);
            } finally {
              running.current = false;
            }
          }}
        >
          {label}
        </Button>
      </RunningTooltip>
      {reason === null ? null : (
        <span id={reasonId} hidden>
          {reason}
        </span>
      )}
    </>
  );
}

/** The hunk controls of the comparison heading and their reason line. The heading lays them out with CSS flex wrap, which follows `wrapHunkToolbar`. */
export function HunkControls(props: HunkControlsProps) {
  const { comparison, category, selectedHunk, anchoredHunk, onSelectHunk, reasons = [] } = props;
  const base = useId();
  const ids = { action: `${base}-action`, notice: `${base}-notice`, previous: `${base}-previous`, next: `${base}-next`, lines: `${base}-lines` };
  const running = useRef(false);
  const [notice, setNotice] = useState<{ comparisonId: string; text: string } | null>(null);
  const hunkIds = comparison.hunks.map((h) => h.hunkId);
  const targets = { previous: stepTarget(hunkIds, selectedHunk, anchoredHunk, "previous"), next: stepTarget(hunkIds, selectedHunk, anchoredHunk, "next") };
  const navReason = { previous: targets.previous === null ? "No previous hunk" : null, next: targets.next === null ? "No next hunk" : null };
  const step = (direction: Direction) => {
    const id = targets[direction];
    if (id !== null) onSelectHunk(id);
  };
  if (props.stepRef) props.stepRef.current = step;

  const unstage = category === "staged";
  const label = unstage ? "Unstage selected hunk" : "Stage selected hunk";
  const hunk = comparison.hunks.find((h) => h.hunkId === selectedHunk);
  const blockReason = hunkReason(props);
  const actionReason = blockReason ?? (hunk === undefined ? NO_HUNK : null);
  const shownNotice = notice?.comparisonId === comparison.comparisonId ? notice.text : null;

  async function act(lines?: { hunk: Comparison["hunks"][number]; ordinals: number[] }) {
    const target = lines?.hunk ?? hunk;
    if ((lines === undefined ? actionReason : blockReason) !== null || running.current || !target || !props.target) return;
    running.current = true;
    try {
      const response = await sendHunk(props, target, lines?.ordinals);
      if (response.code === "STALE_SELECTION") setNotice({ comparisonId: comparison.comparisonId, text: STALE_TEXT });
      // Contract Δ4: the service refuses a line selection with its reason. The diff then keeps the selection.
      else if (response.code === "UNSUPPORTED_COMPARISON" && lines !== undefined) {
        const reason = (response.result as { reason?: unknown } | undefined)?.reason;
        const text = typeof reason === "string" ? (LINE_TEXT[reason as keyof typeof LINE_TEXT] ?? LIMITATION_TEXT[reason as keyof typeof LIMITATION_TEXT]) : undefined;
        setNotice({ comparisonId: comparison.comparisonId, text: `${linesLabel(unstage, lines.ordinals.length)} is unavailable: ${text ?? `UNSUPPORTED_COMPARISON ${String(reason)}`}` });
      } else if (lines !== undefined && response.state === "succeeded") props.lines?.clear();
    } finally {
      running.current = false;
    }
  }

  // Spec FR-041 to FR-044: the selected lines of one hunk. A selection in two hunks sends no request (contract Δ4).
  const range = props.lines?.range ?? null;
  const rows = props.lines?.patch ?? null;
  // Undefined: no line selection. Null: a point of the selection names no row of the canonical patch (contract §4).
  const pick = range === null || rows === null ? undefined : pickLines(rows, range, unstage ? "unstage" : "stage");
  const picked = pick?.ok === true ? pick : null;
  const lineReason = pick === undefined ? null : (blockReason ?? (pick === null ? MAPPING_FAILED : pick.ok ? null : LINE_TEXT[pick.reason as keyof typeof LINE_TEXT]));
  const quiet = props.blocked === "running";
  const lineHunk = picked === null ? undefined : comparison.hunks[picked.hunk];
  const runLines = (direction: "stage" | "unstage") => {
    if ((direction === "unstage") !== unstage || lineReason !== null || picked === null || lineHunk === undefined) return;
    void act({ hunk: lineHunk, ordinals: picked.lines });
  };
  if (props.lines) props.lines.action.current = runLines;
  const lineCount = range === null || rows === null ? 0 : (changeRows(rows, range)?.length ?? 0);

  return (
    <>
      <div role="toolbar" aria-label="Hunk controls" className="flex flex-wrap items-center gap-x-2" style={{ minHeight: "var(--h-hunk-toolbar)" }}>
        {navButton({ label: "Previous hunk", icon: ArrowUp01Icon, keys: ["Alt+ArrowUp", "Alt+Up"], reason: navReason.previous, reasonId: ids.previous, onStep: () => step("previous") })}
        {navButton({ label: "Next hunk", icon: ArrowDown01Icon, keys: ["Alt+ArrowDown", "Alt+Down"], reason: navReason.next, reasonId: ids.next, onStep: () => step("next") })}
        <RunningTooltip reason={quiet ? actionReason : null}>
          <Button variant="outline" size="sm" disabled={actionReason !== null} focusableWhenDisabled aria-describedby={actionReason === null ? undefined : ids.action} onClick={() => void act()}>
            {label}
          </Button>
        </RunningTooltip>
        {pick === undefined ? null : (
          <RunningTooltip reason={quiet ? lineReason : null}>
            <Button
              variant="outline"
              size="sm"
              data-slot="line-action"
              aria-keyshortcuts={unstage ? "U" : "S"}
              disabled={lineReason !== null}
              focusableWhenDisabled
              aria-describedby={lineReason === null ? undefined : ids.lines}
              onClick={() => runLines(unstage ? "unstage" : "stage")}
            >
              {`${linesLabel(unstage, lineCount)} (${unstage ? "U" : "S"})`}
            </Button>
          </RunningTooltip>
        )}
      </div>
      <ReasonLine
        parts={[
          { id: ids.action, text: actionReason, quiet },
          { id: ids.notice, text: shownNotice },
          { id: ids.lines, text: lineReason === null ? null : `${linesLabel(unstage, lineCount)} is unavailable: ${lineReason}`, quiet },
          ...reasons,
          { id: ids.previous, text: navReason.previous },
          { id: ids.next, text: navReason.next },
        ]}
      />
    </>
  );
}
