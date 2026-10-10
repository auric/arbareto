// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { BridgeResponse } from "../bridge";
import { metrics, type Density } from "./profiles";

// plan.md "Windows text size": `UISettings.TextScaleFactor` lies from 1.00 to 2.25 (contract §3 `currentSession`).
const MIN = 1;
const MAX = 2.25;

const factorOf = (value: unknown) => (typeof value === "number" && value >= MIN && value <= MAX ? value : MIN);

/** A text-holding height: the density value plus (factor - 1) x the density line height. */
export function textHeight(density: Density, value: number, factor: number): number {
  // The help line at factor 1 is one line height.
  return value + (factor - 1) * metrics(density, 1).helpLine;
}

export type TextScale = ReturnType<typeof createTextScale>;

/** Sets `--text-scale` on `root` from a `currentSession` response and from each `text-scale` event payload. */
export function createTextScale(root: HTMLElement) {
  let factor = MIN;
  // A `currentSession` response can arrive after a newer event.
  let evented = false;
  const listeners = new Set<() => void>();
  const apply = (value: unknown) => {
    factor = factorOf(value);
    root.style.setProperty("--text-scale", String(factor));
    for (const listener of listeners) listener();
  };
  return {
    session(response: BridgeResponse) {
      if (!evented) apply((response.result as { textScale?: unknown } | undefined)?.textScale);
    },
    event(value: unknown) {
      evented = true;
      apply(value);
    },
    current: () => factor,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
