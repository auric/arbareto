// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useEffect, useRef, useState } from "react";
import type { ChangeEntry, Comparison } from "../../contracts/envelope";
import { CopyButton } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge } from "../bridge";
import { Button } from "../components/ui/button";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import type { TrustReport } from "../trust/TrustChip";
import type { FileActionResult } from "./ChangesPane";
import { BLOCKED_TEXT, STALE_TEXT, stagingReason, type Blocked, type Eligibility, type StagingTarget } from "./HunkControls";
import { LIMITATION_TEXT } from "./limitation-text";

// plan.md "Task flow and command placement" (Stage or unstage, File controls), "Limitation text", "Keyboard and focus" (File actions, Stage key row), and contract §4 "File staging" and "Limitation remedies".

export type FileControlsProps = {
  bridge: Pick<ReturnType<typeof createBridge>, "applyFile">;
  /** The repository and the generation of the current capability. Null blocks the action. */
  target: StagingTarget | null;
  /** The shown comparison of the selected entry, with its file-action decision. */
  comparison: Comparison;
  category: ChangeEntry["category"];
  blocked?: Blocked;
  trust?: TrustReport | null;
  eligibility?: Eligibility;
  /** The ID of the T145 reason line. A disabled button takes it as its accessible description. */
  reasonId: string;
  /** Feeds the reason line. Null clears it. */
  onReason?(text: string | null): void;
  /** Runs after each terminal response. The read after a mutation outcome reconciles the view (contract §3). */
  onRefresh?(response: BridgeResponse): void;
  /** Runs after each terminal response other than `succeeded`. The comparison pane shows a `GIT_FAILED` output (T202). */
  onFailed?(response: BridgeResponse): void;
  /** "File staged", "File unstaged", or "File marked resolved" after `succeeded`. */
  onOutcome?(text: string): void;
  /** Runs once after a button success. T133 then moves focus and selection. */
  onSuccess?(): void;
  onOperation?(op: StatusOperation): void;
};

type Direction = "stage" | "unstage" | "resolve";
type Decision = { label: "Stage file" | "Unstage file" | "Mark resolved"; direction: Direction; reason: string | null };
type Refused = Exclude<Comparison["fileAction"], Direction>;

// plan.md "Limitation text", plus the feature 003 data-model §9 `missing` refusal of Mark resolved.
const REFUSAL_TEXT: Record<Refused, string> = { ...LIMITATION_TEXT, missing: "The working file of this conflicted path is missing." };
const LABEL: Record<Direction, Decision["label"]> = { stage: "Stage file", unstage: "Unstage file", resolve: "Mark resolved" };
const OUTCOME: Record<Direction, string> = { stage: "File staged", unstage: "File unstaged", resolve: "File marked resolved" };

/** The file-action decision of the comparison (contract §4, feature 003 contract Δ4), then the workspace and trust state. */
export function decide(props: Omit<FileControlsProps, "reasonId">): Decision {
  const { comparison, category } = props;
  const action = comparison.fileAction;
  const accepted = action === "stage" || action === "unstage" || action === "resolve";
  // Feature 003 FR-052: a Conflicted entry offers Mark resolved. The 001 `state` refusal keeps the Stage file label.
  const direction: Direction = accepted ? action : category === "staged" ? "unstage" : category === "conflicted" && action !== "state" ? "resolve" : "stage";
  const refusal = accepted ? null : REFUSAL_TEXT[action];
  // A merge or a rebase in progress blocks staging, but Mark resolved exists for it. The service checks the bound operation state (plan.md D7).
  const blocked = direction === "resolve" && (props.blocked === "conflicted" || props.blocked === "operation") ? null : props.blocked;
  return { label: LABEL[direction], direction, reason: refusal ?? stagingReason({ ...props, blocked }) ?? (props.target ? null : BLOCKED_TEXT.stale) };
}

async function send(props: Omit<FileControlsProps, "reasonId">, decision: Decision): Promise<BridgeResponse> {
  const { comparison } = props;
  const payload = { comparisonId: comparison.comparisonId, snapshotId: comparison.snapshotId, direction: decision.direction };
  const target = props.target!;
  const response = await trackOperation("applyFile", decision.direction, (onProgress) => props.bridge.applyFile(target, payload, onProgress), props.onOperation);
  props.onRefresh?.(response);
  if (response.state === "succeeded") props.onOutcome?.(OUTCOME[decision.direction]);
  else props.onFailed?.(response);
  return response;
}

/** The one file action of the stage bar buttons and the Space key. A refusing decision sends nothing. */
export async function runFileAction(props: Omit<FileControlsProps, "reasonId">): Promise<FileActionResult> {
  const decision = decide(props);
  if (decision.reason !== null) return { state: "refused", text: `${decision.label} is unavailable: ${decision.reason}` };
  return (await send(props, decision)).state === "succeeded" ? { state: "succeeded" } : { state: "failed" };
}

type FailedResult = { outputTail?: unknown; remedy?: { text?: unknown; command?: unknown } };

/** plan.md "Task flow and command placement": a Stage file `GIT_FAILED` shows its output tail as plain text, then the `add` remedy with Copy command. */
export function FileFailure({ response }: { response: BridgeResponse }) {
  const result = (response.result ?? {}) as FailedResult;
  const tail = response.code === "GIT_FAILED" && typeof result.outputTail === "string" ? result.outputTail : null;
  const command = response.code === "GIT_FAILED" && typeof result.remedy?.command === "string" ? result.remedy.command : null;
  if (tail === null && command === null) return null;
  return (
    <div className="flex flex-col items-start gap-1 border-b border-divider px-2 py-1">
      {tail === null ? null : (
        <pre tabIndex={0} aria-label="Git output" className="max-h-24 w-full overflow-auto font-mono whitespace-pre-wrap select-text">
          {tail}
        </pre>
      )}
      {command === null ? null : (
        <>
          {typeof result.remedy?.text === "string" ? <p>{result.remedy.text}</p> : null}
          <code className="break-all">{command}</code>
          <CopyButton text={command}>Copy command</CopyButton>
        </>
      )}
    </div>
  );
}

/** "Stage file (Space)", "Unstage file (Space)", or "Mark resolved (Space)" in the stage bar. */
export function FileControls(props: FileControlsProps) {
  const decision = decide(props);
  const running = useRef(false);
  const [stale, setStale] = useState<string | null>(null);
  const { onReason } = props;
  useEffect(() => onReason?.(decision.reason), [decision.reason]);
  useEffect(() => () => onReason?.(null), []);

  async function activate() {
    if (decision.reason !== null || running.current) return;
    running.current = true;
    try {
      const response = await send(props, decision);
      setStale(response.code === "STALE_SELECTION" ? props.comparison.comparisonId : null);
      if (response.state === "succeeded") props.onSuccess?.();
    } finally {
      running.current = false;
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1 py-1">
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        aria-keyshortcuts="Space"
        disabled={decision.reason !== null}
        focusableWhenDisabled
        aria-describedby={decision.reason === null ? undefined : props.reasonId}
        onClick={() => void activate()}
      >
        {decision.label} (Space)
      </Button>
      {/* The live element stays mounted. Only its text changes. */}
      <p role="status">{stale === props.comparison.comparisonId ? STALE_TEXT : null}</p>
    </div>
  );
}
