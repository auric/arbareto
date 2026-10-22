// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDataTransferVerticalIcon, CloudIcon, FolderGitIcon, Unlink01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactElement, ReactNode } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card";
import type { TrackLabel } from "../state/tracking";

// Feature 005 spec FR-064 to FR-066, plan.md D13, D15 "Branch card", D16, the BranchCard board.

/** `upstream` is the short name. `upstreamPresent` undefined: the read did not state it, so no gone mark shows. `heldBy` undefined: no `readBranches` result is loaded. */
export type CardFacts =
  | { kind: "name"; name: string }
  | { kind: "local"; name: string; upstream: string | null; upstreamPresent: boolean | undefined; track: TrackLabel; heldBy: string | null | undefined };

/** Spec FR-064: the reference read names an upstream, and the same read shows no reference of that name. */
export const isGone = (upstream: string | null, upstreamPresent: boolean | undefined) => upstream !== null && upstreamPresent === false;
export const goneTooltip = (upstream: string) => `The upstream ${upstream} no longer exists.`;
export const UPSTREAM_GONE_NAME = "upstream gone";

/** Spec FR-065: "cut" is a layout fact. The caller reads it at hover or focus time. */
export const isCut = (elements: readonly (Element | null | undefined)[]) => elements.some((e) => e != null && e.scrollWidth > e.clientWidth);

/** The gone mark: its shape is the cue, and the row name states it. */
export function GoneMark({ upstream }: { upstream: string }) {
  return (
    <span data-slot="gone-mark" aria-hidden="true" title={goneTooltip(upstream)} className="flex shrink-0">
      <HugeiconsIcon icon={Unlink01Icon} strokeWidth={2} className="size-4" />
    </span>
  );
}

function Line({ icon, muted = true, children }: { icon: IconSvgElement; muted?: boolean; children: ReactNode }) {
  return (
    <span className="flex items-start gap-2 [overflow-wrap:anywhere]">
      <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className={muted ? "mt-px size-4 shrink-0 text-muted-text" : "mt-px size-4 shrink-0"} />
      <span>{children}</span>
    </span>
  );
}

// Feature 003 `trackLabel`: only the count form has a visible text that differs from its label, and "=" is its form for zero and zero.
function counts(track: TrackLabel): string | null {
  if (track === null || track.text === track.label) return null;
  return track.text === "=" ? "Up to date" : track.label;
}

function CardText({ facts }: { facts: CardFacts }) {
  const name = <span className="font-semibold [overflow-wrap:anywhere]">{facts.name}</span>;
  if (facts.kind === "name") return name;
  const { upstream, upstreamPresent, track, heldBy } = facts;
  const ahead = upstream === null || isGone(upstream, upstreamPresent) || upstreamPresent !== true ? null : counts(track);
  return (
    <>
      {name}
      <Line icon={CloudIcon}>{upstream === null ? "No upstream" : `Upstream: ${upstream}`}</Line>
      {upstream !== null && isGone(upstream, upstreamPresent) ? (
        <Line icon={Unlink01Icon} muted={false}>
          {`Upstream gone: ${upstream} no longer exists`}
        </Line>
      ) : null}
      {ahead === null ? null : (
        <Line icon={ArrowDataTransferVerticalIcon}>
          <span className="num">{ahead}</span>
        </Line>
      )}
      {heldBy == null ? null : (
        <Line icon={FolderGitIcon}>
          Checked out in <code>{heldBy}</code>
        </Line>
      )}
    </>
  );
}

export type BranchCardProps = {
  facts: CardFacts;
  /** The popup ID. The row names it in `aria-describedby` while the card shows. */
  id: string;
  open: boolean;
  /** A keyboard focus opened the card, so it shows without motion (plan.md D16 "Motion"). */
  instant?: boolean;
  onOpenChange(open: boolean): void;
  /** The name elements whose layout decides "cut". */
  names(): readonly (Element | null | undefined)[];
  /** The element that opens the card on hover. */
  trigger: ReactElement;
  side?: "inline-end" | "bottom";
};

/** Base UI PreviewCard opens it after its default hover delay. The caller opens it at once on keyboard focus. Escape closes it. It starts no bridge call. */
export function BranchCard({ facts, id, open, instant = false, onOpenChange, names, trigger, side = "inline-end" }: BranchCardProps) {
  return (
    <HoverCard open={open} onOpenChange={(next) => void ((!next || isCut(names())) && next !== open && onOpenChange(next))}>
      <HoverCardTrigger render={trigger} />
      <HoverCardContent
        id={id}
        side={side}
        align="start"
        {...(instant ? { "data-instant": "" } : {})}
        className="flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-1.5 rounded-[6px] border border-control-border p-3 text-text ring-0"
      >
        <CardText facts={facts} />
      </HoverCardContent>
    </HoverCard>
  );
}
