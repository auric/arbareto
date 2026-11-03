// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Alert02Icon, SpellCheckIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import type { SpellView } from "./engine";
import type { SpellingSetting, SpellingState } from "./store";
import { SPELLING_TEXTS as T } from "./texts";

// 006 plan.md D8 "Chip" and "Count", D16 "Commit editor", D17 "Commit editor".

export type SpellStatus = { text: string; lines: string[]; tone: "normal" | "off" | "warning"; count: string | null };

/** The chip text. Plan.md D17: the loaded languages in selection order. */
export function chipText(setting: SpellingSetting, languages: SpellingState["languages"], languageName: (id: string) => string): string {
  if (!setting.enabled) return T.off;
  const loaded = setting.languages.filter((id) => languages.get(id) === "loaded");
  return loaded.length > 0 ? T.chip(loaded.map(languageName)) : T.none;
}

/** The chip, its tooltip lines, and the count. Null until the first settings response, and with spell check on until the catalog loads. */
export function spellStatus(state: SpellingState, view: SpellView): SpellStatus | null {
  const setting = state.setting;
  if (setting === null) return null;
  if (!setting.enabled) return { text: T.off, lines: [T.off], tone: "off", count: null };
  const catalog = state.catalog;
  if (catalog === null) return null;
  // The shell drops every ID outside the catalog (plan.md D11).
  const languageName = (id: string) => catalog.get(id)?.name ?? id;
  const loaded = setting.languages.filter((id) => state.languages.get(id) === "loaded");
  const failed = setting.languages.filter((id) => state.languages.get(id) === "failed");
  const loading = setting.languages.filter((id) => !loaded.includes(id) && !failed.includes(id));
  const text = chipText(setting, state.languages, languageName);
  const lines = [text, ...failed.map((id) => T.cannotLoad(languageName(id))), ...loading.map((id) => T.stillLoads(languageName(id))), ...(view.limited ? [T.limit] : [])];
  // The count stays away above 64 KiB, because no round checked that text.
  const count = loaded.length > 0 && !view.composing && !view.limited ? T.count(view.marks.length) : null;
  return { text, lines, tone: loaded.length === 0 || failed.length > 0 ? "warning" : "normal", count };
}

const TONES = {
  normal: "border-accent-role text-accent-role",
  off: "border-control-border text-muted-text",
  warning: "border-warning text-warning",
} as const;

/** Static text with a tooltip, not a control. `linesId` names the element with the tooltip lines for the editor description. */
export function SpellChip({ status, linesId }: { status: SpellStatus; linesId: string }) {
  const icon = status.tone === "off" ? null : status.tone === "warning" ? Alert02Icon : SpellCheckIcon;
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<span className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[4px] border px-1 whitespace-nowrap forced-colors:border-[CanvasText] ${TONES[status.tone]}`} />}>
          {icon === null ? null : <HugeiconsIcon icon={icon} size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />}
          <span data-slot="spell-chip">{status.text}</span>
        </TooltipTrigger>
        <TooltipContent className="flex-col items-start">
          {status.lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </TooltipContent>
      </Tooltip>
      <span id={linesId} hidden>
        {status.lines.join(" ")}
      </span>
    </>
  );
}
