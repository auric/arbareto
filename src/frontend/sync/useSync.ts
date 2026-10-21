// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useRef, useState } from "react";
import type { SYNC_ACTIONS } from "../../contracts/channel";
import type { PushNotice } from "../app/NoticeBand";
import type { BridgeResponse, createBridge } from "../bridge";
import { branchName } from "../history/HistoryView";
import { shortRef } from "../refs/ReferencesSidebar";
import { isObject } from "../lib/utils";
import { SYNC_NAMES, type StatusOperation } from "../status/OperationStatus";
import type { ConflictPlan } from "./ConflictActions";
import type { ForcePlan } from "./ForcePushConfirm";
import type { ReviewPayload } from "./PullSplitButton";
import { reviewWithTrust, SYNC_TRUST, type AskTrust } from "../trust/ask";
import type { NeedsDestination, PushChoice } from "./PushPanel";

type SyncAction = (typeof SYNC_ACTIONS)[number];

// Feature 003 contract Δ3 `reviewSync` and `sync`, Δ8, data-model §2 to §8, spec FR-001 to FR-004, FR-014 to FR-016, FR-023 to FR-026, and plan.md D4, D5, D12.

type Bridge = ReturnType<typeof createBridge>;
type Target = { repositoryId: string; repositoryGeneration: number };
/** Contract Δ3 `SyncPlan`: the fields that the renderer reads. */
type Plan = {
  remotes: string[];
  destination?: { remote: string; ref: string; trackingRef: string | null };
  lease?: ForcePlan["lease"];
  needsDestination?: NeedsDestination;
} & ConflictPlan;
type Reviewed = { action: SyncAction; plan: Plan; syncReviewToken?: unknown };
/** Data-model §5 and §7: the result fields that decide the notice. */
type Result = { push?: { status: string; lease: boolean }; integration?: { state: string } };

const isReviewed = (value: unknown): value is Reviewed => isObject(value) && isObject(value.plan) && Array.isArray(value.plan.remotes);
const PUSHING: readonly SyncAction[] = ["push", "force-push"];
type Confirmed = "abort" | "skip";
const CLEARS_MODE: readonly SyncAction[] = ["pull", "integrate", "abort", "continue", "skip"];

export type UseSyncOptions = {
  bridge: Pick<Bridge, "reviewSync" | "sync">;
  /** The repository and the newest generation, or null without a repository. */
  target(): Target | null;
  /** The open repository. Another repository ends the panel, the confirmation, and the notice. */
  repositoryId: string | null;
  /** The HEAD target (`refs/heads/<branch>`) of the newest `readWorkspace`, null for a detached HEAD, undefined before the first read. */
  headTarget: string | null | undefined;
  /** The HEAD object ID of the newest `readWorkspace`, null for an unborn branch, undefined before the first read. */
  headOid: string | null | undefined;
  /** Each start, progress event, and terminal response, and each refused review, for the status bar. */
  onOperation(op: StatusOperation): void;
  /** The status bar text of a review that the renderer refuses because it lacks a contract field. */
  onRefused(text: string): void;
  /** A terminal `sync` response. The caller reads the workspace, the refs, the history, and the tracking again (FR-004, FR-013, FR-040). */
  onEnded(response: BridgeResponse): void;
  /** Feature 004 plan.md D12 "Ask": a review that needs trust asks once, then runs again. */
  askTrust?: AskTrust;
};

/** The renderer side of the sync flow: review, then the push panel, the force-push confirmation, or the start. */
export function useSync({ bridge, target, repositoryId, headTarget, headOid, onOperation, onRefused, onEnded, askTrust }: UseSyncOptions) {
  const [panel, setPanel] = useState<NeedsDestination | null>(null);
  const [confirm, setConfirm] = useState<{ plan: Plan & ForcePlan; token: string } | null>(null);
  // FR-023: the notice and the HEAD target that it belongs to.
  const [notice, setNotice] = useState<(PushNotice & { target: string; remote: string }) | null>(null);
  // FR-027: a pull that needs a mode, with the HEAD commit that it belongs to.
  const [modeChoice, setModeChoice] = useState<{ oid: string | null } | null>(null);
  // FR-042, FR-044: the reviewed Abort or Skip that waits for its confirmation.
  const [conflictConfirm, setConflictConfirm] = useState<{ action: Confirmed; plan: Plan & { operationState: "merging" | "rebasing" }; token: string } | null>(null);
  const busy = useRef(false);
  const [shownFor, setShownFor] = useState(repositoryId);
  if (shownFor !== repositoryId) {
    setShownFor(repositoryId);
    setPanel(null);
    setConfirm(null);
    setNotice(null);
    setModeChoice(null);
    setConflictConfirm(null);
  }
  const head = useRef(headTarget);
  head.current = headTarget;
  // FR-023: a change of the HEAD target removes the notice.
  if (notice !== null && headTarget !== undefined && headTarget !== notice.target) setNotice(null);
  if (modeChoice !== null && headOid !== undefined && headOid !== modeChoice.oid) setModeChoice(null);
  const oid = useRef(headOid);
  oid.current = headOid;

  async function start(action: SyncAction, plan: Plan, token: string, fromNotice: boolean) {
    const t = target();
    if (t === null) return;
    let op: StatusOperation = { requestId: crypto.randomUUID(), kind: "sync", sync: { action, remotes: plan.remotes }, progress: null, response: null };
    onOperation(op);
    const response = await bridge.sync({ repositoryId: t.repositoryId }, { syncReviewToken: token, start: true }, (event) => {
      op = { ...op, progress: event };
      onOperation(op);
    });
    onOperation({ ...op, response });
    const result = (isObject(response.result) ? response.result : {}) as Result;
    const status = result.push?.status;
    const current = head.current;
    if (PUSHING.includes(action) && response.state === "succeeded") setNotice(null);
    // Data-model §5: a `rejected` status with a lease means that the remote branch changed (FR-025).
    else if (PUSHING.includes(action) && response.code === "PUSH_REJECTED" && status === "rejected" && plan.destination !== undefined && typeof current === "string") {
      const d = plan.destination;
      setNotice({ kind: result.push!.lease ? "stale" : "rejected", tracking: d.trackingRef === null ? `${shortRef(d.ref)} on ${d.remote}` : shortRef(d.trackingRef), branch: branchName(current), target: current, remote: d.remote });
    }
    // FR-026: a pull from the notice that integrated offers Push. Data-model §7 `done` and `up-to-date` decide.
    const integrated = result.integration?.state === "done" || result.integration?.state === "up-to-date";
    if (fromNotice && action === "pull" && response.state === "succeeded" && integrated) setNotice((n) => (n === null ? n : { ...n, kind: "pulled" }));
    // Data-model §7: only `mode-required` asks. Its outcome is `succeeded`, and no integration ran.
    if (action === "pull" && response.state === "succeeded" && result.integration?.state === "mode-required" && oid.current !== undefined) setModeChoice({ oid: oid.current });
    onEnded(response);
  }

  /** Resolves with the review response when the review refused, else with null. */
  async function run(payload: ReviewPayload, fromNotice = false): Promise<BridgeResponse | null> {
    const t = target();
    if (t === null || busy.current) return null;
    busy.current = true;
    // A new pull, integrate, or conflict action replaces the question of the last pull.
    if (CLEARS_MODE.includes(payload.action)) setModeChoice(null);
    try {
      // The second review takes the generation of the full read after the approval.
      const review = await reviewWithTrust(() => bridge.reviewSync(target() ?? t, payload), SYNC_TRUST[payload.action], askTrust);
      const result = review.result;
      if (review.state !== "succeeded" || !isReviewed(result)) {
        // A refused review starts nothing. The status bar shows its code and reason.
        onOperation({ requestId: crypto.randomUUID(), kind: "sync", sync: { action: payload.action, remotes: [] }, progress: null, response: review });
        return review;
      }
      if (result.plan.needsDestination !== undefined) {
        setPanel(result.plan.needsDestination);
        return null;
      }
      const token = result.syncReviewToken;
      // FR-024: a force push starts only from the confirmation, and the confirmation needs the destination and the lease.
      const force = payload.action === "force-push";
      // FR-042, FR-044: the confirmations need the operation kind, and Skip also the skipped commit.
      const confirmed = payload.action === "abort" || payload.action === "skip" ? payload.action : null;
      const plan = result.plan;
      const incomplete =
        typeof token !== "string" ||
        (force && (plan.destination === undefined || plan.lease === undefined)) ||
        (confirmed !== null && (plan.operationState === undefined || (confirmed === "skip" && plan.skippedCommit === undefined)));
      if (incomplete) {
        onRefused(`${SYNC_NAMES[payload.action]} did not start: the review is incomplete.`);
        return null;
      }
      if (force) {
        setConfirm({ plan: plan as Plan & ForcePlan, token });
        return null;
      }
      if (confirmed !== null) {
        setConflictConfirm({ action: confirmed, plan: plan as Plan & { operationState: "merging" | "rebasing" }, token });
        return null;
      }
      await start(payload.action, plan, token, fromNotice);
      return null;
    } finally {
      busy.current = false;
    }
  }

  return {
    run: (payload: ReviewPayload) => void run(payload),
    /** Contract Δ3 abort, continue, and skip. Resolves with a refused review response, else null. */
    conflictAction: (action: "abort" | "continue" | "skip") => run({ action }),
    modeChoice: modeChoice !== null,
    chooseMode: (mode: "rebase" | "merge") => void run({ action: "integrate", mode }),
    cancelMode: () => setModeChoice(null),
    conflictConfirm,
    confirmConflict: () => {
      if (conflictConfirm === null) return;
      setConflictConfirm(null);
      busy.current = true;
      void start(conflictConfirm.action, conflictConfirm.plan, conflictConfirm.token, false).finally(() => void (busy.current = false));
    },
    cancelConflict: () => setConflictConfirm(null),
    panel,
    push: (choice: PushChoice) => {
      setPanel(null);
      void run({ action: "push", destination: choice });
    },
    closePanel: () => setPanel(null),
    confirm,
    confirmForce: () => {
      if (confirm === null) return;
      setConfirm(null);
      busy.current = true;
      void start("force-push", confirm.plan, confirm.token, true).finally(() => void (busy.current = false));
    },
    cancelForce: () => setConfirm(null),
    notice,
    noticeActions: {
      onPull: (mode: "rebase" | "merge") => void run({ action: "pull", mode }, true),
      onFetch: () => void (notice === null ? undefined : run({ action: "fetch", remote: notice.remote }, true)),
      onForcePush: () => void run({ action: "force-push" }, true),
      onPush: () => void run({ action: "push" }, true),
      onDismiss: () => setNotice(null),
    },
  };
}
