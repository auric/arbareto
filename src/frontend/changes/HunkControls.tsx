// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Fragment, useId, useRef, useState, type RefObject } from "react";
import type { ChangeEntry, Comparison, WorkspaceSnapshot } from "../../contracts/envelope";
import { WarningIcon } from "../app/NoticeBand";
import type { BridgeResponse, createBridge } from "../bridge";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import type { TrustReport } from "../trust/TrustDialog";
import { BUSY_REASON } from "./ChangesPane";
import { LIMITATION_TEXT } from "./limitation-text";

// plan.md "Task flow and command placement" (Select a hunk, Stage or unstage), "Hunk toolbar layout", "Long text" (reason line), and "Keyboard and focus" (Comparison, Unavailable control).

type Category = ChangeEntry["category"];
type Direction = "next" | "previous";
export type StagingTarget = { repositoryId: string; repositoryGeneration: number };
export type Eligibility = WorkspaceSnapshot["hunkEligibility"];
/** A workspace state that blocks hunk and file actions. `busy` is a running file action, `running` any other mutation. */
export type Blocked = "conflicted" | "loading" | "incomplete" | "stale" | "expired" | "busy" | "running" | "unknown" | null;

export const BLOCKED_TEXT: Record<NonNullable<Blocked>, string> = {
  conflicted: "Arbareto blocks changes until the Git operation ends outside Arbareto. Then select Refresh (F5).",
  loading: "A status page is still loading.",
  incomplete: "The status read is incomplete, so changes stay blocked.",
  stale: "The comparison is not current. Wait for the new comparison.",
  expired: "The approval expired. Arbareto reads the comparison again.",
  busy: BUSY_REASON,
  running: "A Git operation is running. Wait for its result, or select Cancel.",
  unknown: "State unknown. Select Refresh (F5) first.",
};
export const TRUST_TEXT = "Reads need trust approval. Use Review repository trust in the Repository menu.";
// plan.md "Required visible states", Stale selection.
export const STALE_TEXT = "The comparison or the staged scope changed. Arbareto reads it again.";
const COMPARISON_INCOMPLETE = "The comparison is incomplete.";
const MAPPING_FAILED = "Hunk actions are unavailable: DISPLAY_MAPPING_FAILED";
const NO_HUNK = "No hunk is selected.";
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
};

export type ReasonPart = { id: string; text: string | null };

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
  const nodes = parts.map(({ id, text }) => {
    if (text === null) return null;
    const plain = sentence(text);
    if (shown.has(plain))
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

/** The hunk controls of the comparison heading and their reason line. The heading lays them out with CSS flex wrap, which follows `wrapHunkToolbar`. */
export function HunkControls(props: HunkControlsProps) {
  const { comparison, category, selectedHunk, anchoredHunk, onSelectHunk, reasons = [] } = props;
  const base = useId();
  const ids = { action: `${base}-action`, notice: `${base}-notice`, previous: `${base}-previous`, next: `${base}-next` };
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
  const actionReason =
    stagingReason(props) ??
    (comparison.support !== "supported" ? (comparison.support === null ? COMPARISON_INCOMPLETE : LIMITATION_TEXT[comparison.support]) : null) ??
    (comparison.completeness.state !== "complete" ? COMPARISON_INCOMPLETE : null) ??
    (props.displayFailed ? MAPPING_FAILED : null) ??
    (props.target ? null : BLOCKED_TEXT.stale) ??
    (hunk === undefined ? NO_HUNK : null);
  const shownNotice = notice?.comparisonId === comparison.comparisonId ? notice.text : null;

  async function act() {
    if (actionReason !== null || running.current || !hunk || !props.target) return;
    running.current = true;
    const direction = unstage ? "unstage" : "stage";
    const payload = { comparisonId: comparison.comparisonId, hunkId: hunk.hunkId, snapshotId: comparison.snapshotId, direction } as const;
    const target = props.target;
    try {
      const response = await trackOperation("applyHunk", direction, (onProgress) => props.bridge.applyHunk(target, payload, onProgress), props.onOperation);
      if (response.code === "STALE_SELECTION") setNotice({ comparisonId: comparison.comparisonId, text: STALE_TEXT });
      props.onEnded?.(response, hunk.ordinal);
    } finally {
      running.current = false;
    }
  }

  return (
    <>
      <div role="toolbar" aria-label="Hunk controls" className="flex flex-wrap items-center gap-x-2" style={{ minHeight: "var(--h-hunk-toolbar)" }}>
        {navButton({ label: "Previous hunk", icon: ArrowUp01Icon, keys: ["Alt+ArrowUp", "Alt+Up"], reason: navReason.previous, reasonId: ids.previous, onStep: () => step("previous") })}
        {navButton({ label: "Next hunk", icon: ArrowDown01Icon, keys: ["Alt+ArrowDown", "Alt+Down"], reason: navReason.next, reasonId: ids.next, onStep: () => step("next") })}
        <Button variant="outline" size="sm" disabled={actionReason !== null} focusableWhenDisabled aria-describedby={actionReason === null ? undefined : ids.action} onClick={() => void act()}>
          {label}
        </Button>
      </div>
      <ReasonLine
        parts={[
          { id: ids.action, text: actionReason },
          { id: ids.notice, text: shownNotice },
          ...reasons,
          { id: ids.previous, text: navReason.previous },
          { id: ids.next, text: navReason.next },
        ]}
      />
    </>
  );
}
