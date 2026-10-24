// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 006 data-model §16: the language fixture of spec SC-002. T023 moved it here from tests/gate/dictionary-gate.test.ts.

const encoder = new TextEncoder();
export const LATIN_NEGATIVES = ["qzxqzxqzx", "xkcdqwvjz", "zzqqxxjj", "vvbbqqzz", "jjqqxxzz"];
// The Script property values that the fixture names. A letter of another script refuses the fixture.
const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Hebrew", "Arabic", "Syriac", "Thaana", "Georgian", "Ethiopic", "Cherokee", "Canadian_Aboriginal", "Mongolian", "Tifinagh",
  "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan", "Myanmar", "Khmer", "Hangul", "Han", "Hiragana", "Katakana"];
const SCRIPT_TESTS = SCRIPTS.map((name) => [name, new RegExp(`^\\p{Script=${name}}$`, "u")] as const);

type FlagMode = "char" | "long" | "num" | "uni";
// Hunspell edb6191 hashmgr.cxx `decode_flags` (hunspell(5) "AFFIX FILE GENERAL OPTIONS", FLAG): bytes by default, byte pairs for `long`, comma-separated decimals for `num`, UTF-16 units for `UTF-8`.
function decodeFlags(text: string, mode: FlagMode): number[] {
  const bytes = [...encoder.encode(text)];
  if (mode === "long") return Array.from({ length: bytes.length >> 1 }, (_, i) => (bytes[2 * i]! << 8) | bytes[2 * i + 1]!);
  if (mode === "num") return text.split(",").map((part) => Number.parseInt(part, 10) || 0);
  if (mode === "uni") return Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  return bytes;
}

// The flags that make a bare stem fail `spell` (Hunspell edb6191 hunspell.cxx `checkword` and `spell`; hunspell(5) "AFFIX FILE OTHER OPTIONS", "OPTIONS FOR COMPOUNDING", "AFFIX FILE OPTIONS FOR SUGGESTION"):
// FORBIDDENWORD, NEEDAFFIX and its old name PSEUDOROOT, ONLYINCOMPOUND, and WARN when FORBIDWARN is set. hunspell(5) has no COMPOUNDONLY directive.
function affixFacts(aff: string): { mode: FlagMode; refused: Set<number>; aliases: number[][] | null } {
  const lines = aff.split("\n").map((l) => l.replace(/\r$/, ""));
  let mode: FlagMode = "char";
  for (const line of lines) {
    // hashmgr.cxx: the mode words match anywhere in the FLAG line, and the last match wins.
    if (/^FLAG\s/.test(line)) for (const [word, m] of [["long", "long"], ["num", "num"], ["UTF-8", "uni"]] as const) if (line.includes(word)) mode = m;
  }
  const token = (line: string) => line.split(/[ \t]+/)[1];
  const first = (key: string) => {
    const line = lines.find((l) => l.startsWith(key));
    const value = line === undefined ? undefined : token(line);
    return value === undefined ? undefined : decodeFlags(value, mode)[0];
  };
  const forbidden = lines.filter((l) => l.startsWith("FORBIDDENWORD")).map((l) => token(l)).filter((v) => v !== undefined).map((v) => decodeFlags(v!, mode)[0]).at(-1);
  const refused = new Set<number>();
  for (const flag of [forbidden, first("NEEDAFFIX") ?? first("PSEUDOROOT"), first("ONLYINCOMPOUND"), lines.some((l) => l.startsWith("FORBIDWARN")) ? first("WARN") : undefined]) if (flag !== undefined) refused.add(flag);
  // hunspell(5) AF: "AF <count>", then <count> lines "AF <flag vector>". A dictionary flag field names an alias by its 1-based number.
  const header = lines.findIndex((l) => /^AF[ \t]/.test(l));
  let aliases: number[][] | null = null;
  if (header >= 0) {
    const count = Number.parseInt(token(lines[header]!) ?? "", 10);
    aliases = lines.slice(header + 1, header + 1 + count).map((l) => decodeFlags(token(l) ?? "", mode));
  }
  return { mode, refused, aliases };
}

// One dictionary line by Hunspell edb6191 hashmgr.cxx `load_tables`: the word, then the flags after the first "/" that no "\" precedes.
function dictionaryLine(line: string, mode: FlagMode, aliases: number[][] | null): { word: string; flags: number[] } {
  let ts = line;
  let dp: number | undefined;
  for (let p = ts.indexOf(":"); p >= 0; p = ts.indexOf(":", p + 1)) {
    if (p > 3 && (ts[p - 3] === " " || ts[p - 3] === "\t")) {
      let q = p - 3;
      while (q > 0 && (ts[q - 1] === " " || ts[q - 1] === "\t")) q -= 1;
      dp = q === 0 ? undefined : q;
      break;
    }
  }
  const tab = ts.indexOf("\t");
  if (tab >= 0 && (dp === undefined || tab < dp)) dp = tab;
  if (dp !== undefined) ts = ts.slice(0, dp);
  // As in load_tables, a "/" at position 0 moves the split to position 1.
  let slash = ts.indexOf("/");
  while (slash >= 0) {
    if (slash === 0) slash = 1;
    else if (ts[slash - 1] !== "\\") break;
    else {
      ts = ts.slice(0, slash - 1) + ts.slice(slash);
      slash = ts.indexOf("/", slash);
    }
  }
  if (slash < 0 || slash >= ts.length) return { word: ts, flags: [] };
  const field = ts.slice(slash + 1);
  const flags = aliases === null ? decodeFlags(field, mode) : (aliases[Number.parseInt(field, 10) - 1] ?? []);
  return { word: ts.slice(0, slash), flags };
}

function scriptOf(point: string): string | undefined {
  return SCRIPT_TESTS.find(([, test]) => test.test(point))?.[0];
}

// Data-model §11 for one stem: one token that no rule skips, and one word-like segment that spans the whole stem.
const segmenter = new Intl.Segmenter("und", { granularity: "word" });
function isOneWord(stem: string): boolean {
  if (stem === "" || /[\p{White_Space}`]/u.test(stem)) return false;
  if (/[\p{Nd}_/\\@:]/u.test(stem)) return false;
  const points = [...stem];
  if (points.slice(1, -1).includes(".")) return false;
  const words = [...segmenter.segment(stem)].filter((s) => s.isWordLike);
  return words.length === 1 && words[0]!.segment === stem;
}

export type Fixture = { positives: string[]; negatives: string[]; script: string | null; problem: string | null };

// Data-model §16: the positive and negative words of one language, or the exact reason that the fixture cannot exist.
export function languageFixture(aff: string, dic: string): Fixture {
  const { mode, refused, aliases } = affixFacts(aff);
  const lines = dic.split("\n").slice(1).map((l) => l.replace(/\r$/, ""));
  if (lines.at(-1) === "") lines.pop();
  const parsed = lines.map((line) => dictionaryLine(line, mode, aliases));
  // Hunspell keeps every line of a word as a homonym. A word with a refusing flag on any homonym is not eligible.
  const refusedWords = new Set(parsed.filter((p) => p.flags.some((f) => refused.has(f))).map((p) => p.word));
  const eligible = parsed.map((p) => !refusedWords.has(p.word) && !/[ \t]/.test(p.word) && isOneWord(p.word));
  const n = parsed.length;
  const positives: string[] = [];
  for (let i = 0; i <= 199; i++) {
    const start = Math.floor((i * (n - 1)) / 199);
    const found = eligible.indexOf(true, start);
    if (found >= 0) positives.push(parsed[found]!.word);
  }
  const fail = (problem: string): Fixture => ({ positives, negatives: [], script: null, problem });
  if (positives.length === 0) return fail("no-positive-words");
  const all = positives.flatMap((w) => [...w.normalize("NFC")]).filter((c) => /^\p{L}$/u.test(c));
  const unlisted = all.find((c) => scriptOf(c) === undefined);
  if (unlisted !== undefined) return fail(`script-unlisted U+${unlisted.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  // Data-model §16: the Script value with the most `\p{L}` letters of the positive words; a tie refuses.
  const counts = new Map<string, number>();
  for (const c of all) counts.set(scriptOf(c)!, (counts.get(scriptOf(c)!) ?? 0) + 1);
  const most = Math.max(...counts.values());
  const top = [...counts].filter(([, n]) => n === most).map(([s]) => s).sort();
  if (top.length !== 1) return fail(`script-tie ${top.join(",")}`);
  const script = top[0]!;
  if (script === "Latin") return { positives, negatives: [...LATIN_NEGATIVES, ...positives.slice(0, 5).map((w) => `${w}qzxqzx`)], script, problem: null };
  // Another script: its letters in the positive words, in code point order, give 5 repeated triples and one suffix.
  const letters = [...new Set(all.filter((c) => scriptOf(c) === script))].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);
  if (letters.length < 7) return fail(`script-letters ${letters.length}`);
  const triple = (k: number) => letters.slice(k, k + 3).join("");
  return { positives, negatives: [0, 1, 2, 3, 4].map((k) => triple(k).repeat(3)).concat(positives.slice(0, 5).map((w) => w + triple(0).repeat(2))), script, problem: null };
}

