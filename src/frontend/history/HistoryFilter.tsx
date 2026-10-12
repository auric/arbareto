// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon, FilterIcon, HighlighterIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type Ref } from "react";
import { IconButton } from "../components/icon-button";
import type { HistoryMode, SearchState } from "../state/history-view";

// Feature 002 spec FR-027 to FR-042 and plan.md D5, D6. Texts follow the approved mockup canvas of plan.md D6.

export const FILTER_LABEL = "Filter commit messages";
const fmt = new Intl.NumberFormat("en-US");
const matchesText = (n: number) => `${fmt.format(n)} ${n === 1 ? "match" : "matches"}`;

/** Spec FR-039: the count states that more can follow until the search ends, and then that it is final. A stopped search shows no count. */
export function countText(search: SearchState | null): string | null {
  if (search === null) return null;
  if (search.state === "running") return `${matchesText(search.matches)} so far, more can follow`;
  if (search.state === "finished") return `${matchesText(search.matches)}, search complete`;
  if (search.state === "stopped") return "Search stopped";
  return null;
}

export type HistoryFilterProps = {
  search: SearchState | null;
  /** The reason why the filter is unavailable, or null. */
  unavailable: string | null;
  /** The ID of the element that states the count and the refusals. */
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
  onSearch(text: string, mode: HistoryMode): void;
  onClear(): void;
  onMode(mode: HistoryMode): void;
  onMatch(direction: "next" | "previous"): void;
};

/** The message filter: the text box, the match display toggle, and the match moves. Only Enter starts a search (spec FR-029). */
export function HistoryFilter({ search, unavailable, describedBy, inputRef, onSearch, onClear, onMode, onMatch }: HistoryFilterProps) {
  const [text, setText] = useState("");
  const [preferred, setPreferred] = useState<HistoryMode>("filter");
  const mode = search?.mode ?? preferred;
  const moves = search?.searchId != null && (search.state === "running" || search.state === "finished");

  function clear() {
    setText("");
    onClear();
  }

  function chooseMode(next: HistoryMode) {
    setPreferred(next);
    if (search !== null) onMode(next);
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className="relative flex items-center">
        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" className="pointer-events-none absolute left-1.5 size-(--icon-size) text-muted-text" />
        <input
          ref={inputRef}
          type="text"
          aria-label={FILTER_LABEL}
          aria-keyshortcuts="Control+F"
          aria-describedby={describedBy}
          placeholder={FILTER_LABEL}
          disabled={unavailable !== null}
          spellCheck={false}
          className="h-(--h-button) w-64 rounded-sm border border-control-border bg-surface pr-7 pl-7"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            // Spec FR-030: a changed or cleared text stops the search, and the full history returns.
            if (search !== null) onClear();
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              onSearch(text, mode);
            } else if (event.key === "Escape" && (text !== "" || search !== null)) {
              event.preventDefault();
              clear();
            }
          }}
        />
        {text === "" ? null : (
          <span className="absolute right-0.5">
            <IconButton icon={Cancel01Icon} label="Clear filter" keys={{ aria: "Escape", text: "Esc" }} onClick={clear} />
          </span>
        )}
      </div>
      <div role="group" aria-label="Match display" className="flex items-center gap-0.5">
        <IconButton icon={FilterIcon} label="Show only matching commits" aria-pressed={mode === "filter"} disabled={unavailable !== null} onClick={() => chooseMode("filter")} />
        <IconButton icon={HighlighterIcon} label="Highlight matching commits" aria-pressed={mode === "highlight"} disabled={unavailable !== null} onClick={() => chooseMode("highlight")} />
        <IconButton icon={ArrowUp01Icon} label="Previous match" keys={{ aria: "Shift+F3", text: "Shift+F3" }} disabled={!moves} onClick={() => onMatch("previous")} />
        <IconButton icon={ArrowDown01Icon} label="Next match" keys={{ aria: "F3", text: "F3" }} disabled={!moves} onClick={() => onMatch("next")} />
      </div>
    </div>
  );
}
