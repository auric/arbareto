// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { GitCompareArrowsIcon, GitMergeIcon } from "@hugeicons/core-free-icons";
// Type-only imports keep zod out of the renderer bundle.
import { useEffect, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import type { z } from "zod";
import type { ReviewWorkbenchResult } from "../../contracts/envelope";
import { MERGE_MESSAGE_BYTES } from "../../contracts/limits";
import { codeText, unknownFormText } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge } from "../bridge";
import { DockedPanel } from "../components/docked-panel";
import { isObject } from "../lib/utils";
import { shortRef } from "../refs/ReferencesSidebar";
import { trackOperation, type StatusOperation } from "../status/OperationStatus";
import { reviewWithTrust, WORKBENCH_TRUST, type AskTrust } from "../trust/ask";
import { TEXTS, type ConfigSource } from "./texts";

// Feature 004 spec FR-021 to FR-028, plan.md D5, D6, D15 "Docked panel", contract Δ3 `reviewWorkbench` and `runWorkbench` merge and rebase.

/** Opens a panel. `ref` is the full source or onto ref, and `name` its short display name. */
export type IntegrateRequest = { action: "merge" | "rebase"; ref: string; name: string };
type Reviewed = Extract<z.infer<typeof ReviewWorkbenchResult>, { workbenchToken: string }>;
type MergePlan = Extract<Reviewed, { action: "merge" }>["plan"];
type RebasePlan = Extract<Reviewed, { action: "rebase" }>["plan"];
type Review = { response: BridgeResponse | null; token: string | null; plan: MergePlan | RebasePlan | null; reason: string | null; code: string | null; unmerged: number | null };

export type IntegratePanelProps = {
  request: IntegrateRequest;
  /** The short name of the current branch. */
  current: string;
  bridge: Pick<ReturnType<typeof createBridge>, "reviewWorkbench" | "runWorkbench">;
  target: { repositoryId: string; repositoryGeneration: number } | null;
  /** The workbench reason that blocks every mutation, or null. */
  blockedReason: string | null;
  /** True while a mutation runs. Plan D15 running rule: the reason then shows only in the tooltip and the accessible description. */
  operationRunning: boolean;
  /** Reports the run to the status bar (`StatusOperation` kind `runWorkbench`). */
  onOperation(op: StatusOperation): void;
  /** The store's `ended("runWorkbench", response)`. */
  onEnded(response: BridgeResponse): void;
  /** The control that opened the panel. Close returns the focus to it. */
  opener?: Element | null;
  onClose(): void;
  /** Feature 004 plan.md D12 "Ask": a review that needs trust asks once, then runs again. */
  askTrust?: AskTrust;
};

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

function reviewOf(response: BridgeResponse): Review {
  const result = isObject(response.result) ? response.result : {};
  const token = response.state === "succeeded" && typeof result.workbenchToken === "string" ? result.workbenchToken : null;
  const plan = isObject(result.plan) ? (result.plan as MergePlan | RebasePlan) : null;
  const unmerged = typeof result.unmerged === "number" ? result.unmerged : null;
  return { response, token, plan, reason: typeof result.reason === "string" ? result.reason : null, code: token === null ? (response.code ?? response.state) : null, unmerged };
}

/** The plan facts that the panel states (plan D5, D6). The options that the plan echoes are left out. */
const factsOf = (plan: MergePlan | RebasePlan | null) =>
  plan === null ? null : JSON.stringify("facts" in plan ? [plan.facts, plan.preview] : [plan.moved, plan.rewritten, plan.held, plan.forceNote, plan.movedBranches, plan.autostash]);

/** The D15 text of a refused review. `source` is the short name of the source or onto branch. Unmapped codes and reasons show the code. */
function refusalText(review: Review, action: "Merge" | "Rebase", current: string, source: string, plan: MergePlan | RebasePlan | null): string {
  const ff = plan !== null && "facts" in plan ? plan.facts.mergeFf.source : "default";
  if (review.response?.state === "succeeded") return unknownFormText(action);
  if (review.code === "TRUST_REQUIRED" || review.code === "TRUST_CHANGED") return TEXTS.trust;
  if (review.code === "CONFLICTED" && review.unmerged !== null) return TEXTS.conflicted(review.unmerged);
  if (review.code === "OPERATION_IN_PROGRESS") return TEXTS.operationInProgress;
  if (review.code !== "WORKBENCH_UNAVAILABLE" || review.reason === null) return TEXTS.unavailable(action) + (review.code ?? "unknown");
  const texts: Record<string, string> = {
    detached: TEXTS.detached,
    unborn: TEXTS.unborn,
    "same-branch": action === "Merge" ? TEXTS.sameMerge(source) : TEXTS.sameRebase(source),
    "ff-only": TEXTS.ffOnly(ff as ConfigSource),
    "message-size": TEXTS.messageSize,
    "squash-no-ff": TEXTS.squashNoFf(ff as ConfigSource),
    "merge-options": TEXTS.mergeOptions(current),
    "invalid-config": TEXTS.invalidConfig,
    "unknown-operation": TEXTS.unknownOperation,
    "apply-backend": TEXTS.applyBackend,
    "dirty-tree": TEXTS.dirtyTree,
  };
  return texts[review.reason] ?? TEXTS.unavailable(action) + review.reason;
}

type Keyed = { key: string; value: Review };
/** Latest wins: each new payload key sends one review, and an older response is dropped. */
function useReview(bridge: IntegratePanelProps["bridge"], target: IntegratePanelProps["target"], key: string, setReview: (review: Keyed) => void, askTrust: AskTrust | undefined) {
  const seq = useRef(0);
  // The second review after an approval takes the generation of the full read.
  const latest = useRef(target);
  latest.current = target;
  const ask = useRef(askTrust);
  ask.current = askTrust;
  const repositoryId = target?.repositoryId ?? null;
  const generation = target?.repositoryGeneration ?? null;
  useEffect(() => {
    if (repositoryId === null || generation === null) return;
    const mine = ++seq.current;
    const payload = JSON.parse(key) as Parameters<IntegratePanelProps["bridge"]["reviewWorkbench"]>[1];
    const send = () => bridge.reviewWorkbench(latest.current ?? { repositoryId, repositoryGeneration: generation }, payload);
    void reviewWithTrust(send, WORKBENCH_TRUST[payload.action], ask.current).then((response) => {
      if (mine === seq.current) setReview({ key, value: reviewOf(response) });
    });
  }, [bridge, repositoryId, generation, key, setReview]);
}

function Option({ label, note, reason, ...input }: { label: string; note?: string; reason?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const text = reason ?? note;
  return (
    <div className="flex flex-col">
      <label className="flex items-center gap-2">
        <input {...input} disabled={input.disabled ?? (reason !== null && reason !== undefined)} aria-describedby={text === undefined ? undefined : id} />
        {label}
      </label>
      {text === undefined ? null : (
        <span id={id} className="text-muted-text" style={{ paddingLeft: 22 }}>
          {text}
        </span>
      )}
    </div>
  );
}

/** The docked Merge or Rebase panel. A stop with conflicts closes it, and the 003 conflict row takes over (FR-023, FR-027). */
export function IntegratePanel(props: IntegratePanelProps) {
  const { request, current, bridge, target, blockedReason, operationRunning, onOperation, onEnded, opener, onClose } = props;
  const merge = request.action === "merge";
  const action = merge ? "Merge" : "Rebase";
  // Merge options.
  const [result, setResult] = useState<"merge" | "squash">("merge");
  const [noFf, setNoFf] = useState(false);
  const [noCommit, setNoCommit] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Rebase options. Null Autostash follows the plan's `rebase.autoStash` value.
  const [autostash, setAutostash] = useState<boolean | null>(null);
  const [autosquash, setAutosquash] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<ReactNode>(null);
  const body = useRef<HTMLDivElement>(null);
  // The plan of the newest review. A refusal before the counts holds no plan, so the panel then states no facts.
  const [review, setReview] = useState<Keyed | null>(null);
  const shownPlan = review?.value.plan ?? null;
  useLayoutEffect(() => {
    const inputs = [...(body.current?.querySelectorAll<HTMLInputElement>("input:not(:disabled)") ?? [])];
    (inputs.find((i) => i.checked) ?? inputs[0])?.focus();
  }, []);

  const mergePlan = merge && shownPlan !== null && "facts" in shownPlan ? shownPlan : null;
  const rebasePlan = !merge && shownPlan !== null && "onto" in shownPlan ? shownPlan : null;
  const facts = mergePlan?.facts ?? null;
  const squash = result === "squash";
  // Plan D5 and data-model §5: the service refuses Don't commit without No fast-forward in this case.
  const locked = !squash && noCommit && facts !== null && facts.behind > 0 && facts.fastForward && facts.mergeFf.value !== "false";
  const squashBlocked = facts !== null && facts.mergeFf.value === "false" ? TEXTS.squashNoFf(facts.mergeFf.source as ConfigSource) : null;
  const effectiveAutostash = autostash ?? rebasePlan?.autostash.value ?? false;
  const preview = mergePlan?.preview ?? null;
  const text = message ?? preview;
  const payload = merge
    ? { action: "merge" as const, ref: request.ref, result, noFastForward: !squash && (noFf || locked), noCommit: !squash && noCommit, message: null }
    : { action: "rebase" as const, ref: request.ref, autostash: effectiveAutostash, autosquash };
  const key = JSON.stringify(payload);
  useReview(bridge, target, key, setReview, props.askTrust);

  // The editor bound (contract Δ5): an edited message above MERGE_MESSAGE_BYTES or without text is never sent.
  const messageBytes = text === null ? 0 : utf8Bytes(text);
  const messageReason = !merge || squash || text === null ? null : messageBytes > MERGE_MESSAGE_BYTES ? TEXTS.messageSize : /^[ \t\n\r]*$/.test(text) ? TEXTS.messageEmpty : null;
  const shown = review?.key === key ? review.value : null;
  // The own run comes first: while it runs, the workbench reason is the running reason too.
  const reason: string | null = running
    ? merge
      ? TEXTS.mergeRuns
      : TEXTS.rebaseRuns
    : (blockedReason ?? (shown === null ? TEXTS.pending : shown.token === null ? refusalText(shown, action, current, request.name, shownPlan) : messageReason));

  async function run() {
    if (target === null) return;
    setRunning(true);
    setFailure(null);
    const sent = merge ? { ...payload, message: squash || message === null || message === preview ? null : message } : payload;
    const again = reviewOf(await bridge.reviewWorkbench(target, sent));
    if (again.token === null) {
      setRunning(false);
      setFailure(refusalText(again, action, current, request.name, again.plan ?? shownPlan));
      return;
    }
    // The run needs the facts that the panel showed. Other facts show first, and the next run reviews again.
    if (factsOf(again.plan) !== factsOf(shown?.plan ?? null)) {
      setRunning(false);
      setReview({ key, value: again });
      return;
    }
    const token = again.token;
    const texts = merge ? TEXTS.runMerge : TEXTS.runRebase;
    const response = await trackOperation("runWorkbench", undefined, (onProgress) => bridge.runWorkbench({ repositoryId: target.repositoryId }, { workbenchToken: token, start: true }, onProgress), (op) => onOperation({ ...op, texts }));
    onEnded(response);
    setRunning(false);
    const state = isObject(response.result) ? response.result.operationState : undefined;
    // A success, or a stop that leaves the merge or rebase in progress for the 003 conflict row.
    if (response.state === "succeeded" || response.state === "completed-with-effects" || state === "merging" || state === "rebasing") onClose();
    else setFailure(codeText(TEXTS.failed(action), response.code ?? response.state));
  }

  const ids = { result: useId(), message: useId(), bytes: useId(), branches: useId() };
  return (
    <DockedPanel
      title={merge ? TEXTS.mergeTitle(request.name, current) : TEXTS.rebaseTitle(current, request.name)}
      icon={merge ? GitMergeIcon : GitCompareArrowsIcon}
      closeLabel={merge ? TEXTS.closeMerge : TEXTS.closeRebase}
      primary={{ label: action, reason, quiet: running || operationRunning, onRun: () => void run() }}
      opener={opener}
      onClose={onClose}
    >
      <div ref={body} data-slot="integrate-panel" className="flex flex-col gap-2">
        {mergePlan === null ? null : (
          <div className="flex flex-col">
            <p>{TEXTS.behind(request.name, current, mergePlan.facts.behind)}</p>
            <p>{mergePlan.facts.fastForward ? TEXTS.fastForward : TEXTS.noFastForward(current, request.name, mergePlan.facts.ahead)}</p>
            <p className="text-muted-text">{TEXTS.mergeFf(mergePlan.facts.mergeFf.value, mergePlan.facts.mergeFf.source as ConfigSource)}</p>
          </div>
        )}
        {rebasePlan === null ? null : (
          <div className="flex flex-col">
            <p>{TEXTS.moved(current, request.name, rebasePlan.moved)}</p>
            <p>{TEXTS.held(rebasePlan.rewritten, rebasePlan.held)}</p>
            {rebasePlan.forceNote === null ? null : <p className="text-warning">{TEXTS.forceNote(shortRef(rebasePlan.forceNote.trackingRef))}</p>}
            {rebasePlan.movedBranches === null ? null : (
              <>
                <p id={ids.branches}>{TEXTS.movedBranches}</p>
                <ul aria-labelledby={ids.branches} className="list-disc pl-6 font-mono">
                  {rebasePlan.movedBranches.refs.map((ref) => (
                    <li key={ref}>{shortRef(ref)}</li>
                  ))}
                </ul>
                {rebasePlan.movedBranches.more === 0 ? null : <p>{TEXTS.moreBranches(rebasePlan.movedBranches.more)}</p>}
              </>
            )}
          </div>
        )}
        {merge ? (
          <>
            <fieldset className="flex flex-col gap-1" aria-labelledby={ids.result}>
              <legend id={ids.result} className="font-semibold">
                {TEXTS.result}
              </legend>
              <Option type="radio" name={ids.result} label={TEXTS.mergeCommit} checked={!squash} onChange={() => setResult("merge")} />
              <Option type="radio" name={ids.result} label={TEXTS.squash} note={TEXTS.squashNote} reason={squashBlocked} checked={squash} onChange={() => setResult("squash")} />
            </fieldset>
            <Option
              type="checkbox"
              label={TEXTS.noFf}
              note={TEXTS.noFfNote}
              reason={squash ? TEXTS.noFfSquash : locked ? TEXTS.noFfLocked : null}
              checked={!squash && (noFf || locked)}
              onChange={(event) => setNoFf(event.target.checked)}
            />
            <Option type="checkbox" label={TEXTS.noCommit} note={TEXTS.noCommitNote} reason={squash ? TEXTS.noCommitSquash : null} checked={!squash && noCommit} onChange={(event) => setNoCommit(event.target.checked)} />
            {squash || text === null ? null : (
              <div className="flex min-h-0 flex-col gap-1">
                <label htmlFor={ids.message}>{TEXTS.message}</label>
                <textarea
                  id={ids.message}
                  value={text}
                  rows={4}
                  spellCheck={false}
                  aria-describedby={ids.bytes}
                  aria-invalid={messageReason !== null}
                  className="min-h-24 resize-y rounded-sm border border-control-border bg-surface p-2 font-mono"
                  onChange={(event) => setMessage(event.target.value)}
                />
                <span id={ids.bytes} className="num text-muted-text">
                  {TEXTS.messageBytes(messageBytes)}
                </span>
              </div>
            )}
          </>
        ) : (
          <>
            <Option type="checkbox" label={TEXTS.autostash} note={rebasePlan === null ? TEXTS.autostashNote : `${TEXTS.autostashNote} ${TEXTS.autostashSource(rebasePlan.autostash.source as ConfigSource)}`} checked={effectiveAutostash} onChange={(event) => setAutostash(event.target.checked)} />
            <Option type="checkbox" label={TEXTS.autosquash} note={TEXTS.autosquashNote} checked={autosquash} onChange={(event) => setAutosquash(event.target.checked)} />
            <Option type="checkbox" label={TEXTS.interactive} reason={TEXTS.interactiveReason} checked={false} readOnly />
          </>
        )}
        {failure === null ? null : (
          <p role="alert" className="text-removed">
            {failure}
          </p>
        )}
      </div>
    </DockedPanel>
  );
}
