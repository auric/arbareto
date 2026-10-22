// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { SYNC_ACTIONS, TrustAction, WORKBENCH_ACTIONS } from "../../contracts/channel";
import type { BridgeResponse } from "../bridge";
import { isObject } from "../lib/utils";

// Feature 004 plan.md D12 "Ask", spec FR-069 and FR-072. Contract Δ6 names the dialog action, Δ7 the refusal codes.

/** Asks through the shell task dialog. True after an approval and the full read that follows it. */
export type AskTrust = (action: TrustAction) => Promise<boolean>;

/** Contract Δ7: a class that needs approval without one refuses with one of these codes before any process. */
export const needsTrust = (response: BridgeResponse) => response.code === "TRUST_REQUIRED" || response.code === "TRUST_CHANGED";

/** Feature 004 contract Δ3 `reviewWorkbench`: the gate of a trust refusal (plan.md O-20), or null when the result names none. */
export function trustGate(response: BridgeResponse): "repository" | "target" | null {
  const gate = isObject(response.result) ? response.result.trustGate : undefined;
  return gate === "repository" || gate === "target" ? gate : null;
}

/** Feature 003 contract Δ3: `abort`, `continue`, and `skip` act on the integration of a pull. */
export const SYNC_TRUST: Record<(typeof SYNC_ACTIONS)[number], TrustAction> = {
  "fetch": "fetch",
  "fetch-all": "fetch",
  pull: "pull",
  integrate: "pull",
  push: "push",
  "force-push": "push",
  abort: "pull",
  continue: "pull",
  skip: "pull",
};

/** Contract Δ7 "Mutation trust": `ignore` and `config-save` use no class, so they never ask. Feature 005 contract Δ7: `delete` and `ignore-save` too. */
export const WORKBENCH_TRUST: Record<(typeof WORKBENCH_ACTIONS)[number], TrustAction | null> = {
  switch: "switch",
  "create-branch": "branch",
  "rename-branch": "branch",
  "delete-branch": "branch",
  merge: "merge",
  rebase: "rebase",
  "choose-side": "resolve",
  mergetool: "mergetool",
  ignore: null,
  "worktree-add": "worktree",
  "worktree-remove": "worktree",
  "worktree-prune": "worktree",
  "config-save": null,
  delete: null,
  "ignore-save": null,
};

/**
 * Runs `review`. A trust refusal asks once for `action`. After an approval and the full read, `review` runs once more and so takes a new token.
 * Not now, a failed approval, or no `ask` returns the first refusal, so the caller shows its inline reason.
 * Plan.md O-20: a refusal of the `target` gate never asks. No approval of this repository opens that gate.
 */
export async function reviewWithTrust(review: () => Promise<BridgeResponse>, action: TrustAction | null, ask: AskTrust | undefined): Promise<BridgeResponse> {
  const first = await review();
  if (!needsTrust(first) || trustGate(first) === "target" || action === null || ask === undefined) return first;
  return (await ask(action)) ? review() : first;
}
