// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, CloudIcon, GitBranchIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../../contracts/envelope";
import { SwitcherPopover } from "../components/switcher-popover";
import { KEYS } from "../keyboard/shortcuts";
import { branchName } from "../history/HistoryView";
import { GIT_SEPARATORS, splitPath } from "../lib/path";
import { shortRef } from "../refs/ReferencesSidebar";
import type { BranchEntry } from "../state/workbench";
import type { TrackLabel } from "../state/tracking";
import type { useBranchActions } from "./BranchActions";
import { BranchCard, GoneMark, isCut, isGone, UPSTREAM_GONE_NAME, type CardFacts } from "./BranchCard";
import { T } from "./texts";

// Feature 004 spec FR-007, FR-008, FR-013, plan.md D15 "Branch button" and "Switcher popover", the BranchSwitcher board.
// Feature 005 spec FR-064 to FR-066, plan.md D13: the gone mark in the branch list, and the branch card on the button and the list rows.

type Card = { key: string; instant: boolean } | null;
const BUTTON = "button";
const gone = (e: BranchEntry) => e.kind === "local" && isGone(e.upstream, e.upstreamPresent);

/** Spec FR-066. `heldBy` names another worktree only: the open worktree holds the current branch. */
const factsOf = (e: BranchEntry, tracking: ReadonlyMap<string, TrackLabel>): CardFacts =>
  e.kind === "remote"
    ? { kind: "name", name: e.name }
    : { kind: "local", name: e.name, upstream: e.upstream === null ? null : shortRef(e.upstream), upstreamPresent: e.upstreamPresent, track: tracking.get(e.name) ?? null, heldBy: e.current ? null : e.heldBy };

type ListNameProps = { entry: BranchEntry; facts: CardFacts; active: boolean; card: Card; cardId: string; setCard(next: Card | ((open: Card) => Card)): void };

/** A list row name. The active option is the keyboard focus of the list (`aria-activedescendant`), so it opens the card of a cut name at once. */
function ListName({ entry, facts, active, card, cardId, setCard }: ListNameProps) {
  const name = useRef<HTMLSpanElement>(null);
  const key = entry.ref;
  const open = card?.key === key;
  useLayoutEffect(() => {
    if (active && isCut([name.current])) setCard({ key, instant: true });
    else if (!active) setCard((shown) => (shown?.key === key && shown.instant ? null : shown));
  }, [active, key, setCard]);
  return (
    <BranchCard
      facts={facts}
      id={cardId}
      open={open}
      instant={open && card?.instant === true}
      onOpenChange={(next) => setCard(next ? { key, instant: false } : (shown) => (shown?.key === key ? null : shown))}
      names={() => [name.current]}
      trigger={
        // Git Extensions shows the current branch in bold.
        <span ref={name} data-slot="branch-name" className={entry.current ? "min-w-0 truncate font-semibold" : "min-w-0 truncate"}>
          {entry.name}
        </span>
      }
    />
  );
}

export type BranchButtonProps = {
  /** The group heading height in DIPs (`metrics(...).subgroupHeading`). */
  headingHeight: number;
  head: WorkspaceSnapshot["head"];
  operationState: WorkspaceSnapshot["operationState"];
  /** The 003 count label of the current branch. */
  counts: TrackLabel;
  /** The 003 count labels by local branch name. */
  tracking: ReadonlyMap<string, TrackLabel>;
  actions: ReturnType<typeof useBranchActions>;
  /** The reason that blocks the switch, such as a merge in progress. The list then shows it instead of the branches. */
  blockedReason: string | null;
  rowHeight: number;
};

/** Spec FR-007: the branch, "Detached at <short ID>", or the operation in progress. An unborn branch keeps the 001 header text. */
function buttonText(head: WorkspaceSnapshot["head"], operationState: WorkspaceSnapshot["operationState"]): string {
  if (operationState === "merging") return T.merging;
  if (operationState === "rebasing") return T.rebasing;
  if (head.state === "detached") return T.detached(head.oid);
  return head.state === "unborn" ? `${branchName(head.target)}, no commits yet` : branchName(head.target);
}

export function BranchButton({ headingHeight, head, operationState, counts, tracking, actions, blockedReason, rowHeight }: BranchButtonProps) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<Card>(null);
  const cardId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const parts = useRef<HTMLSpanElement>(null);
  const text = buttonText(head, operationState);
  const [folder, last] = splitPath(text, GIT_SEPARATORS);
  const failure = blockedReason !== null ? <p>{blockedReason}</p> : actions.failure !== null ? <p role="alert">{actions.failure}</p> : undefined;
  // Spec FR-008: "No upstream" shows in the list. A held branch offers Open instead of a switch (FR-013). Feature 005 FR-064: the gone mark replaces the 003 "Upstream gone" label.
  const note = (e: BranchEntry) => (e.heldBy !== null && !e.current ? T.open(e.heldBy) : e.kind === "local" && e.upstream === null ? T.noUpstream : e.kind === "local" && !gone(e) ? (tracking.get(e.name)?.text ?? null) : null);
  const label = (e: BranchEntry) =>
    [e.name, ...(e.current ? [T.current] : []), e.kind === "local" ? T.localNoun : T.remoteNoun, ...(gone(e) ? [UPSTREAM_GONE_NAME] : e.kind === "local" && e.upstream !== null ? [tracking.get(e.name)?.label] : []), note(e)].filter((part) => part != null).join(", ");
  // The card of the button names the current branch of the newest `readBranches` result. Without it, or for another head state, the card shows the text only.
  const currentEntry = head.state === "branch" && operationState !== "merging" && operationState !== "rebasing" ? actions.entries?.find((e) => e.current && e.ref === head.target) : undefined;
  const buttonCard = card?.key === BUTTON;
  const pick = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <SwitcherPopover<BranchEntry>
      open={open}
      onOpenChange={(next) => {
        if (next) actions.refresh();
        setOpen(next);
        setCard(null);
      }}
      trigger={
        <button
          ref={trigger}
          type="button"
          data-slot="branch-button"
          aria-label={counts === null ? text : `${text}, ${counts.label}`}
          aria-describedby={buttonCard ? cardId : undefined}
          // Spec FR-065: a keyboard focus opens the card of a cut name at once.
          onFocus={(event) => {
            if (!open && event.currentTarget.matches(":focus-visible") && isCut([...(parts.current?.querySelectorAll("[data-branch-part]") ?? [])])) setCard({ key: BUTTON, instant: true });
          }}
          onBlur={() => setCard((shown) => (shown?.key === BUTTON ? null : shown))}
          // Plan.md D15 keyboard map: Escape closes the card, and the focus stays on the button.
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !buttonCard) return;
            event.preventDefault();
            setCard(null);
          }}
          className="flex h-(--h-button) min-w-0 max-w-fit items-center gap-1 overflow-hidden rounded-sm border border-control-border px-2 hover:bg-hover-fill"
          // Plan.md D15 "Top bar row": the text basis moves the menu bar, Refresh, and Commit to the next row before the branch text shrinks.
          // The grow factor gives the branch text the free width before the sync reason line (grow 1).
          style={{ order: 3, flex: "1000 1 auto" }}
        />
      }
      tooltip={T.tooltip}
      filterLabel={T.filter}
      listLabel={T.list}
      rowHeight={rowHeight}
      headingHeight={headingHeight}
      items={actions.entries}
      failure={failure}
      itemKey={(e) => e.ref}
      itemText={(e) => e.name}
      itemLabel={label}
      itemGroup={(e) => (e.kind === "local" ? T.localGroup : T.remoteGroup)}
      itemDescribedBy={(e) => (card?.key === e.ref ? cardId : undefined)}
      renderItem={(e, active) => {
        const n = note(e);
        return (
          <>
            {/* Plan D16: the current branch shows a check mark. The option name states "current", so the mark stays hidden. */}
            <span data-slot="current-mark" aria-hidden="true" className="flex size-4 shrink-0 items-center text-accent-role">
              {e.current ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" /> : null}
            </span>
            <HugeiconsIcon icon={e.kind === "local" ? GitBranchIcon : CloudIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
            <ListName entry={e} facts={factsOf(e, tracking)} active={active} card={card} cardId={cardId} setCard={setCard} />
            {gone(e) ? <GoneMark upstream={shortRef(e.upstream!)} /> : null}
            {/* Plan D15 "Rows": a zero basis gives the note only the width that the name leaves. */}
            {n === null ? null : (
              <span title={n} className="num min-w-0 flex-1 truncate text-right text-muted-text">
                {n}
              </span>
            )}
          </>
        );
      }}
      onPick={(e) => pick(() => actions.pick(e, trigger.current))}
      footer={{ label: T.newBranch, keys: { aria: KEYS.createBranch.aria, text: KEYS.createBranch.text }, onPick: () => pick(() => actions.create(head.state === "unborn" ? null : head.oid, trigger.current)) }}
      emptyText={T.empty}
      noMatchText={T.noMatch}
    >
      <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
      {/* plan.md "Header layout": the folder part shrinks first and the last `/` segment last. The title and the hidden text hold the full name. */}
      <BranchCard
        facts={currentEntry === undefined ? { kind: "name", name: text } : factsOf(currentEntry, tracking)}
        id={cardId}
        open={buttonCard}
        instant={buttonCard && card?.instant === true}
        onOpenChange={(next) => setCard(next && !open ? { key: BUTTON, instant: false } : (shown) => (shown?.key === BUTTON ? null : shown))}
        names={() => [...(parts.current?.querySelectorAll("[data-branch-part]") ?? [])]}
        side="bottom"
        trigger={
          <span ref={parts} data-slot="branch-text" title={text} className="flex min-w-0 items-center whitespace-nowrap" style={{ flex: "0 1 auto" }}>
            <span className="sr-only">{text}</span>
            {folder === "" ? null : (
              <span data-branch-part="folder" aria-hidden="true" className="min-w-0 shrink-[1000] truncate">
                {folder}
              </span>
            )}
            <span data-branch-part="last" aria-hidden="true" className="min-w-0 truncate">
              {last}
            </span>
          </span>
        }
      />
      {/* The counts shrink before the branch name. One em keeps their ellipsis. The title and the accessible name hold the full counts. */}
      {counts === null ? null : (
        <span data-slot="branch-counts" aria-hidden="true" title={counts.label} className="num min-w-[1em] shrink-[1000] truncate">
          {counts.text}
        </span>
      )}
      <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size) shrink-0" />
    </SwitcherPopover>
  );
}
