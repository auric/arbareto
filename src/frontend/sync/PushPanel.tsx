// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Cancel01Icon, Upload04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { branchName } from "../history/HistoryView";

// Feature 003 spec FR-014 and FR-016, plan.md D4 step 0, contract Δ3 `reviewSync` (`needsDestination`), and the approved "Push panel" mockup.

/** Contract Δ3 `NeedsDestination`. */
export type NeedsDestination = { remotes: string[]; prefill: { remote: string; ref: string } | null; setUpstream: boolean };
export type PushChoice = { remote: string; branch: string; setUpstream: boolean };

export type PushPanelProps = {
  /** The local branch name. */
  branch: string;
  plan: NeedsDestination;
  /** The explicit start. It sends `reviewSync {action: "push", destination}`. */
  onPush(choice: PushChoice): void;
  onCancel(): void;
};

/**
 * The docked push panel. Plan.md D4 step 1: without a prefill, the remote is `origin` when `git remote` lists it, as git-push(1) documents.
 * Otherwise the user chooses.
 */
export function PushPanel({ branch, plan, onPush, onCancel }: PushPanelProps) {
  const ids = { heading: useId(), branch: useId(), full: useId(), note: useId(), reason: useId() };
  const [remote, setRemote] = useState<string | null>(plan.prefill?.remote ?? (plan.remotes.includes("origin") ? "origin" : null));
  const [name, setName] = useState(plan.prefill?.ref.startsWith("refs/heads/") ? branchName(plan.prefill.ref) : branch);
  const [upstream, setUpstream] = useState(plan.setUpstream);
  const reason = remote === null ? "Choose a remote." : name.trim() === "" ? "Enter the remote branch name." : null;
  return (
    <section
      data-slot="push-panel"
      aria-labelledby={ids.heading}
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <HugeiconsIcon icon={Upload04Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
        <h2 id={ids.heading} className="flex-1 font-semibold">{`Push ${branch}`}</h2>
        <IconButton icon={Cancel01Icon} label="Close push panel" keys={{ aria: "Escape", text: "Esc" }} onClick={onCancel} />
      </div>
      <form
        className="flex min-h-0 flex-col gap-2 overflow-auto p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason === null) onPush({ remote: remote!, branch: name, setUpstream: upstream });
        }}
      >
        <p className="text-muted-text">{plan.setUpstream ? "This branch has no upstream. Choose where the push goes." : "Git's push configuration names no single destination for this branch. Choose one."}</p>
        <fieldset className="grid items-start gap-x-3 gap-y-1" style={{ gridTemplateColumns: "110px minmax(0, 1fr)" }}>
          <legend className="float-left w-[110px]">Remote</legend>
          <div role="radiogroup" aria-label="Remote" className="flex flex-col gap-1">
            {plan.remotes.map((r) => (
              <label key={r} className="flex items-center gap-2">
                <input type="radio" name="remote" value={r} checked={remote === r} onChange={() => setRemote(r)} />
                <span>{r}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid items-center gap-3" style={{ gridTemplateColumns: "110px minmax(0, 1fr)" }}>
          <label htmlFor={ids.branch}>Remote branch</label>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              id={ids.branch}
              type="text"
              value={name}
              spellCheck={false}
              aria-describedby={ids.full}
              className="h-(--h-row) w-64 rounded-sm border border-control-border bg-surface px-2 font-mono"
              onChange={(event) => setName(event.target.value)}
            />
            <span id={ids.full} className="text-muted-text">{`Destination: refs/heads/${name}${remote === null ? "" : ` on ${remote}`}`}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1" style={{ paddingLeft: 122 }}>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={upstream} aria-describedby={ids.note} onChange={(event) => setUpstream(event.target.checked)} />
            Set upstream
          </label>
          <span id={ids.note} className="text-muted-text" style={{ paddingLeft: 22 }}>
            {`Writes the upstream of ${branch} into this repository's configuration${remote === null ? "" : `: ${remote}/${name}`}.`}
          </span>
        </div>
        <div className="flex items-center gap-2" style={{ paddingLeft: 122 }}>
          <Button type="submit" disabled={reason !== null} focusableWhenDisabled aria-describedby={reason === null ? undefined : ids.reason}>
            Push
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {reason === null ? null : (
            <span id={ids.reason} className="text-muted-text">
              {reason}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
