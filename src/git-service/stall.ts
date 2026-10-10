// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §6 "Activity and stall notice" and data-model §7 `stalled` and `stallRemedy`.

import type { StallRemedy } from "../contracts/submodules";
import type { OperationRegistry } from "./operations";

// Maps the shell activity events of one tracked process to the stall state of its operation.
// `report` sends a progress event with the new flag. `remedy` builds the command by the contract §4 quoting rule.
export function trackStall(registry: OperationRegistry, operationId: string, report: () => void, remedy: () => StallRemedy) {
  const stalled = () => registry.get(operationId)?.stalled === true;
  const set = (type: "stall" | "activity") => {
    // Data-model §7 has the stall transitions only for `running`.
    if (registry.get(operationId)?.state !== "running") return;
    registry.apply(operationId, { type });
    if (type === "stall") registry.setStallRemedy(operationId, remedy());
    report();
  };
  return {
    onActivity(state: "stalled" | "active"): void {
      if (state === "stalled" && !stalled()) set("stall");
      else if (state === "active" && stalled()) set("activity");
    },
    // The tracked process exited, so its stall ends with it.
    end(): void {
      if (stalled()) set("activity");
    },
  };
}
