// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { WarningIcon } from "../app/NoticeBand";

// Feature 004 spec FR-047 and plan.md D15 "Message editor": a guide at column 72, the summary counter, and the line 2 mark.
// The marks never block a commit and never change the text.

export const SUMMARY_COLUMNS = 72;
export const GUIDE_TEXT = "Keep the summary at 72 characters or less. Leave line 2 blank. The body wraps at 72.";
export const LINE_TWO_TEXT = "Line 2 is not blank.";

/** Columns count Unicode code points (spec FR-047). The string iterator yields one code point per step. */
export function summaryColumns(text: string): number {
  const end = text.indexOf("\n");
  return [...(end < 0 ? text : text.slice(0, end))].length;
}
export const lineTwoFilled = (text: string) => {
  const lines = text.split("\n");
  return lines.length > 1 && lines[1]!.replace(/\r$/, "") !== "";
};

/**
 * The column 72 guide as a background of the field. `ch` is the advance width of "0" in the code font, which is the cell width of a monospace font.
 * `local` keeps the guide on the text when the field scrolls.
 */
export function guideStyle(padding: number) {
  const at = `calc(${SUMMARY_COLUMNS}ch + ${padding}px)`;
  const end = `calc(${SUMMARY_COLUMNS}ch + ${padding + 1}px)`;
  return {
    backgroundImage: `linear-gradient(to right, transparent ${at}, var(--divider) ${at}, var(--divider) ${end}, transparent ${end})`,
    backgroundAttachment: "local",
  } as const;
}

/** The counter, such as "Summary 47/72". Above 72, a Warning icon adds a cue that does not depend on color. */
export function SummaryCounter({ id, text }: { id: string; text: string }) {
  const n = summaryColumns(text);
  return (
    <span id={id} data-slot="summary-counter" className={`flex items-center gap-1 ${n > SUMMARY_COLUMNS ? "text-warning" : "text-muted-text"}`}>
      {n > SUMMARY_COLUMNS ? <WarningIcon /> : null}
      <span className="num">{`Summary ${n}/${SUMMARY_COLUMNS}`}</span>
    </span>
  );
}

/** The help line, and the line 2 mark while line 2 holds text. */
export function GuideLines({ id, text }: { id: string; text: string }) {
  return (
    <div id={id} className="flex flex-col text-muted-text">
      <span>{GUIDE_TEXT}</span>
      {lineTwoFilled(text) ? (
        <span data-slot="line-two-mark" className="flex items-center gap-1 text-warning">
          <WarningIcon />
          {LINE_TWO_TEXT}
        </span>
      ) : null}
    </div>
  );
}
