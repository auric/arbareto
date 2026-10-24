// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Data-model §11 to §13 and §15, plan.md D9 and D17: the word rules of the commit message spell check.
// The renderer and the spell workers import this module. It has no runtime import and does not use `process`.
// Offsets are UTF-16 code unit offsets of the editor text.

export interface WordRange {
  start: number;
  end: number;
  // The text of the range, as typed.
  raw: string;
  // The NFC form for the lookups.
  word: string;
}

// Data-model §11: a token with one of these code points is skipped.
const SKIPPED_TOKEN = /[\p{Nd}_/\\@:]/u;
const segmenter = new Intl.Segmenter("und", { granularity: "word" });

function skipped(token: string): boolean {
  if (SKIPPED_TOKEN.test(token)) return true;
  const dot = token.indexOf(".", 1);
  return dot !== -1 && dot < token.length - 1;
}

// Data-model §11. `base` is the offset of `text` in the editor text, so a worker can check one line.
export function words(text: string, base = 0): WordRange[] {
  const found: WordRange[] = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    // Half-open skipped ranges in line offsets.
    const skips: [number, number][] = [];
    const ticks = [...line.matchAll(/`/g)].map((m) => m.index);
    for (let i = 0; i + 1 < ticks.length; i += 2) skips.push([ticks[i], ticks[i + 1] + 1]);
    for (const token of line.matchAll(/\P{White_Space}+/gu)) if (skipped(token[0])) skips.push([token.index, token.index + token[0].length]);
    for (const { segment, index, isWordLike } of segmenter.segment(line)) {
      const end = index + segment.length;
      if (!isWordLike || skips.some(([s, e]) => index < e && s < end)) continue;
      found.push({ start: base + lineStart + index, end: base + lineStart + end, raw: segment, word: segment.normalize("NFC") });
    }
    lineStart += line.length + 1;
  }
  return found;
}

// Data-model §12: each listed NFC word w gives w, cap(w), and upper(w).
export function acceptedSet(list: Iterable<string>): Set<string> {
  const accepted = new Set<string>();
  for (const w of list) {
    const first = w.slice(0, (w.codePointAt(0) ?? 0) > 0xffff ? 2 : 1);
    accepted.add(w).add(first.toUpperCase() + w.slice(first.length)).add(w.toUpperCase());
  }
  return accepted;
}

// Data-model §13: the line indices of the edit from A to B. Lines `first` to `lastA` of A became lines `first` to `lastB` of B.
export interface LineChange {
  first: number;
  lastA: number;
  lastB: number;
}

const lineOf = (text: string, offset: number) => {
  let line = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
};

function edit(a: string, b: string) {
  const most = Math.min(a.length, b.length);
  let p = 0;
  while (p < most && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < most - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { p, endA: a.length - s, endB: b.length - s };
}

export function changedLines(a: string, b: string): LineChange {
  const { p, endA, endB } = edit(a, b);
  return { first: lineOf(a, p), lastA: lineOf(a, endA), lastB: lineOf(b, endB) };
}

// Data-model §13 "Shift": the ranges of A as ranges of B. A range never crosses a line feed (§11).
export function shiftRanges<T extends { start: number; end: number }>(ranges: readonly T[], a: string, b: string): T[] {
  if (a === b) return [...ranges];
  const { first, lastA } = changedLines(a, b);
  let firstStart = 0;
  for (let line = 0; line < first; line++) firstStart = a.indexOf("\n", firstStart) + 1;
  let lastEnd = firstStart;
  for (let line = first; line <= lastA; line++) {
    const feed = a.indexOf("\n", lastEnd);
    lastEnd = feed === -1 ? a.length : line < lastA ? feed + 1 : feed;
  }
  const delta = b.length - a.length;
  const shifted: T[] = [];
  for (const range of ranges) {
    if (range.start < firstStart) shifted.push(range);
    else if (range.start > lastEnd) shifted.push({ ...range, start: range.start + delta, end: range.end + delta });
  }
  return shifted;
}

// Data-model §13 "Round" and "Merge". A newer round drops an older one that has not merged, and carries its lines through the edit.
export function createRounds() {
  let current: { round: number; workers: Set<string>; replied: Set<string>; lines: Set<number> } | null = null;
  let last = 0;
  return {
    start(workers: Iterable<string>, lines: Iterable<number>, change?: LineChange): { round: number; lines: number[] } {
      const carried = new Set(lines);
      for (const line of current?.lines ?? []) {
        if (change === undefined || line < change.first) carried.add(line);
        else if (line > change.lastA) carried.add(line + change.lastB - change.lastA);
        else for (let l = change.first; l <= change.lastB; l++) carried.add(l);
      }
      current = { round: ++last, workers: new Set(workers), replied: new Set(), lines: carried };
      return { round: last, lines: [...carried].toSorted((x, y) => x - y) };
    },
    // True when this reply completes the current round. The caller then merges the replies of the round.
    reply(round: number, worker: string): boolean {
      if (current === null || current.round !== round || !current.workers.has(worker) || current.replied.has(worker)) return false;
      current.replied.add(worker);
      if (current.replied.size < current.workers.size) return false;
      current = null;
      return true;
    },
  };
}

// Data-model §13 "Script": the values of `scripts` that hold a `\p{L}` code point of `word` by the Unicode Script property.
// The catalog values hold no Common and no Inherited, so apostrophes and combining marks never count.
const scriptTests = new Map<string, RegExp>();
export function scriptsOf(word: string, scripts: Iterable<string>): Set<string> {
  const found = new Set<string>();
  for (const script of scripts) {
    let test = scriptTests.get(script);
    if (test === undefined) scriptTests.set(script, (test = new RegExp(`(?=\\p{L})\\p{Script=${script}}`, "u")));
    if (test.test(word)) found.add(script);
  }
  return found;
}

// Data-model §13 "Merge": a range of the union with a responsible language, refused by every responsible language, whose `word` no list accepts.
export function mergeMarks<T extends WordRange>(languages: readonly { script: string; refused: readonly T[] }[], accepts: (word: string) => boolean): T[] {
  const key = (r: T) => `${r.start}:${r.end}`;
  const sets = languages.map((l) => new Set(l.refused.map(key)));
  const union = new Map<string, T>();
  for (const l of languages) for (const r of l.refused) if (!union.has(key(r))) union.set(key(r), r);
  const scripts = languages.map((l) => l.script);
  const marks: T[] = [];
  for (const [k, r] of union) {
    const own = scriptsOf(r.word, scripts);
    const responsible = languages.flatMap((l, i) => (own.has(l.script) ? [i] : []));
    if (responsible.length > 0 && responsible.every((i) => sets[i]!.has(k)) && !accepts(r.word)) marks.push(r);
  }
  return marks.sort((a, b) => a.start - b.start);
}

// Contract Δ5 `SPELLING_SUGGESTIONS`. This module has no runtime import (plan.md Structure Decision), so the value repeats. spell-words.test.ts checks it.
const SPELLING_SUGGESTIONS = 5;

// Data-model §15: the lists in selection order, repeats dropped by equality after NFC, cut to 5.
export function mergeSuggestions(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const suggestion of lists.flat()) {
    const nfc = suggestion.normalize("NFC");
    if (seen.has(nfc)) continue;
    seen.add(nfc);
    merged.push(suggestion);
    if (merged.length === SPELLING_SUGGESTIONS) break;
  }
  return merged;
}

// Plan.md D17: "<x.xx> MB", with x.xx = floor((bytes + 5,000) / 10,000) / 100.
export function sizeText(bytes: number): string {
  const hundredths = Math.floor((bytes + 5_000) / 10_000);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")} MB`;
}
