// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract Δ3 `searchHistory`: the filter-text refusals. The service and the renderer run the same checks before any Git process.

// Contract Δ5 "Filter text".
export const FILTER_TEXT_BYTES = 1024;

// Contract Δ9 `UNSUPPORTED_FILTER_TEXT` reasons.
export const FILTER_TEXT_REASONS = ["line-break", "nul", "quote-end", "length"] as const;
export type FilterTextReason = (typeof FILTER_TEXT_REASONS)[number];

// `found` names the refused characters. It is null for the byte bound.
export type FilterText = { kind: "none" } | { kind: "search"; text: string } | { kind: "refused"; reason: FilterTextReason; found: string | null };

export function filterText(text: string): FilterText {
  // Spec FR-027: empty text is no filter.
  if (text === "") return { kind: "none" };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++;
    // Text that is not well-formed has no UTF-8 form, so the byte bound refuses it.
    else if (c >= 0xd800 && c <= 0xdfff) return { kind: "refused", reason: "length", found: text[i]! };
    else if (c === 0x0a || c === 0x0d) return { kind: "refused", reason: "line-break", found: text[i]! };
    else if (c === 0x00) return { kind: "refused", reason: "nul", found: text[i]! };
    // Spec "Assumptions": PCRE2 literal matching quotes the text with \Q and \E, so a \E ends the quote.
    else if (c === 0x5c && text.charCodeAt(i + 1) === 0x45) return { kind: "refused", reason: "quote-end", found: "\\E" };
  }
  if (new TextEncoder().encode(text).length > FILTER_TEXT_BYTES) return { kind: "refused", reason: "length", found: null };
  return { kind: "search", text };
}
