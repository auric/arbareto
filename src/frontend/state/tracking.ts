// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { z } from "zod";
// Type-only imports keep zod out of the renderer bundle.
import type { RefsResult, TrackingEntry as TrackingEntrySchema } from "../../contracts/envelope";
import { TRACKING_COUNT_DISPLAY } from "../../contracts/limits";
import { isObject } from "../lib/utils";

// Feature 003 data-model §1 label rule, plan.md D8, spec FR-019 to FR-022.

export type TrackingEntry = z.infer<typeof TrackingEntrySchema>;
/** The visible text, its text alternative, and the track state of the entry (feature 005 spec FR-064). Null: no number shows (FR-021). */
export type TrackLabel = { text: string; label: string; state: TrackingEntry["track"]["state"] } | null;

// FR-022.
export const COUNTS_TOOLTIP = "Counts compare with the remote-tracking branch from the last fetch, not with the remote itself.";
// Plan.md D8: a detached HEAD.
export const NO_BRANCH = "No branch checked out";
const NO_UPSTREAM = "No upstream";
const UPSTREAM_GONE = "Upstream gone";
const KINDS = { branch: "refs/heads/", remote: "refs/remotes/" } as const;

/** Contract Δ3 `readTracking`: a `TrackingList` has `entries`, and a refusal has none. */
export const isTrackingList = (value: unknown): value is { entries: TrackingEntry[] } => isObject(value) && Array.isArray(value.entries);

/** The object ID of each branch and remote-tracking ref of a `readRefs` list, by full ref name. */
export function refIndex(refs: RefsResult | null): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const ref of refs?.refs ?? []) if (ref.kind === "branch" || ref.kind === "remote") index.set(KINDS[ref.kind] + ref.name, ref.objectId);
  return index;
}

const shown = (n: number) => (n > TRACKING_COUNT_DISPLAY ? `${TRACKING_COUNT_DISPLAY}+` : String(n));

/** The label of one entry. A count shows only when both OIDs equal the newest `readRefs` values (FR-021). */
export function trackLabel(entry: TrackingEntry, index: ReadonlyMap<string, string>): TrackLabel {
  const track = entry.track;
  if (track.state === "none") return { text: NO_UPSTREAM, label: NO_UPSTREAM, state: "none" };
  if (track.state === "gone") return { text: UPSTREAM_GONE, label: UPSTREAM_GONE, state: "gone" };
  if (index.get(KINDS.branch + entry.name) !== entry.objectId || entry.upstream === null || index.get(entry.upstream) !== entry.upstreamObjectId) return null;
  const label = `${shown(track.ahead)} ahead, ${shown(track.behind)} behind`;
  return track.ahead === 0 && track.behind === 0 ? { text: "=", label, state: "counts" } : { text: `↑${shown(track.ahead)} ↓${shown(track.behind)}`, label, state: "counts" };
}

/** The labels by local branch name (plan.md D8: the history labels join by branch name). */
export function trackingLabels(entries: readonly TrackingEntry[] | null, refs: RefsResult | null): Map<string, TrackLabel> {
  const index = refIndex(refs);
  const labels = new Map<string, TrackLabel>();
  for (const entry of entries ?? []) labels.set(entry.name, trackLabel(entry, index));
  return labels;
}
