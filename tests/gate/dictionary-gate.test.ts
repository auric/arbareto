// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T008: the early report of gate step 2 (006 plan.md D3; facts F12, F13; data-model §16). A Bun time decides nothing (spec SC-002).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import catalogFile from "../../src/contracts/dictionaries.json";
import { Catalog } from "../../src/contracts/dictionaries";
import { printOrigin } from "../origin";

const HUNSPELL = printOrigin("hunspell-wasm", import.meta.dir);
printOrigin("../../src/contracts/dictionaries.json", import.meta.dir);
const CHILD_TIMEOUT_MS = 60_000;
const catalog = Catalog.parse(catalogFile);
const CACHE = process.env.ARBARETO_DICTIONARY_CACHE;
const folder = CACHE === undefined || CACHE === "" ? undefined : join(CACHE, catalog.source.commit);
const languages = [catalog.bundled, ...catalog.entries].map((e) => e.id).filter((id) => folder !== undefined && existsSync(join(folder, id, "index.aff")) && existsSync(join(folder, id, "index.dic")));
const work = mkdtempSync(join(tmpdir(), "arbareto-gate-"));
const children: Bun.Subprocess[] = [];

afterAll(() => {
  for (const child of children) if (child.exitCode === null) process.kill(child.pid);
  rmSync(work, { recursive: true, force: true });
});

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const LATIN_NEGATIVES = ["qzxqzxqzx", "xkcdqwvjz", "zzqqxxjj", "vvbbqqzz", "jjqqxxzz"];
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

type Fixture = { positives: string[]; negatives: string[]; script: string | null; problem: string | null };

// Data-model §16: the positive and negative words of one language, or the exact reason that the fixture cannot exist.
function languageFixture(aff: string, dic: string): Fixture {
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

// The child loads one language and prints one JSON line. `testSpelling` gets the NFC form of each word.
const CHILD = `
const job = JSON.parse(await Bun.file(process.argv[1]).text());
const utf8 = new TextDecoder("utf-8", { fatal: true });
const aff = utf8.decode(await Bun.file(job.aff).bytes());
const dic = utf8.decode(await Bun.file(job.dic).bytes());
const { createHunspellFromStrings } = await import(job.hunspell);
const rss = process.memoryUsage().rss;
const start = performance.now();
const h = await createHunspellFromStrings(aff, dic);
const load = performance.now() - start;
const grown = process.memoryUsage().rss - rss;
const failedPositives = job.positives.filter((w) => !h.testSpelling(w.normalize("NFC")));
const failedNegatives = job.negatives.filter((w) => h.testSpelling(w.normalize("NFC")));
const latinAccepted = job.latin.filter((w) => h.testSpelling(w)).length;
console.log(JSON.stringify({ load, rss: grown, nfcAff: aff === aff.normalize("NFC"), nfcDic: dic === dic.normalize("NFC"), failedPositives, failedNegatives, latinAccepted }));
`;

describe("dictionary gate step 2, early report (T008)", () => {
  if (folder === undefined) {
    test.skip("dictionary cache absent: set ARBARETO_DICTIONARY_CACHE", () => {});
    console.log("dictionary cache absent: set ARBARETO_DICTIONARY_CACHE");
    return;
  }

  test("data-model §16: the stem, flag, and word rules", () => {
    const aff = "SET UTF-8\nFLAG long\nFORBIDDENWORD Zx\nNEEDAFFIX Na\n";
    const dic = "6\nalpha/AbZx\nbeta/Na\ngamma/Ab\nfollow-up\nv1\ndelta\tpo:noun\n";
    expect(languageFixture(aff, dic).positives.slice(0, 3)).toEqual(["gamma", "gamma", "gamma"]);
    expect(languageFixture(aff, dic).positives.at(-1)).toBe("delta");
    expect(languageFixture("FLAG num\nONLYINCOMPOUND 7\n", "2\nab/1,7\ncd/12\n").positives.slice(0, 1)).toEqual(["cd"]);
    expect(languageFixture("", "1\nab/x\n").negatives).toEqual([...LATIN_NEGATIVES, ...Array(5).fill("abqzxqzx")]);
  });

  test("data-model §16: AF aliases, homonyms, phrases, WARN, morphological fields, and escaped slashes", () => {
    // tk form: FLAG num with AF aliases; alias 2 holds the NEEDAFFIX flag 100.
    const tk = languageFixture("FLAG num\nNEEDAFFIX 100\nAF 2\nAF 101,102 # 1\nAF 100,176 # 2\n", "2\nakjyg/2\nbaba/1\n");
    expect(tk.positives[0]).toBe("baba");
    // hu form: FORBIDDENWORD on one homonym refuses the word for every line.
    expect(languageFixture("FORBIDDENWORD w\n", "3\nmeg/w\nmeg/ab\nkut/ab\n").positives[0]).toBe("kut");
    // ia form: a phrase line is not one word.
    expect(languageFixture("", "2\nAbu Dhabi/_G\nAbuja/_G\n").positives[0]).toBe("Abuja");
    // WARN refuses only with FORBIDWARN.
    expect(languageFixture("WARN r\n", "2\nrare/r\nzz\n").positives[0]).toBe("rare");
    expect(languageFixture("WARN r\nFORBIDWARN\n", "2\nrare/r\nzz\n").positives[0]).toBe("zz");
    // A morphological field after a space, and an escaped slash.
    expect(languageFixture("", "2\nhouse po:noun\nand\\/or\n").positives[0]).toBe("house");
    expect(languageFixture("FLAG UTF-8\nONLYINCOMPOUND ž\n", "2\nab/ž\ncd/x\n").positives[0]).toBe("cd");
  });

  test("data-model §16: the negative words follow the one script of the positive words", () => {
    const uk = languageFixture("", "3\nабвгґдеєж\nзиіїйклмн\n");
    expect(uk.script).toBe("Cyrillic");
    expect(uk.negatives.slice(0, 2)).toEqual(["абвабвабв", "бвгбвгбвг"]);
    expect(uk.negatives[5]).toBe("абвгґдеєжабвабв");
    // n = 2 lines: steps 0 to 198 take line 1, step 199 takes line 2.
    expect(languageFixture("", "2\nabc\nабв\n").script).toBe("Latin");
    expect(languageFixture("", "2\nα\nабвгґдеєж\n").problem).toBe("script-letters 1");
    expect(languageFixture("", "3\nab\nабвгґдеєж\nвгдеєжзий\n")).toMatchObject({ script: "Cyrillic", problem: null });
    expect(languageFixture("", "1\nабab\n").problem).toBe("script-tie Cyrillic,Latin");
    expect(languageFixture("", "1\nабв\n").problem).toBe("script-letters 3");
    expect(languageFixture("", "1\n\u{F8D0}\u{F8D1}\n").problem).toBe("no-positive-words");
    expect(languageFixture("", "1\nabc\n").script).toBe("Latin");
  });

  test.each(languages)(
    "%s",
    async (id) => {
      const aff = join(folder, id, "index.aff");
      const dic = join(folder, id, "index.dic");
      const { positives, negatives, script, problem } = languageFixture(utf8.decode(readFileSync(aff)), utf8.decode(readFileSync(dic)));
      if (problem !== null) {
        console.log(`OBSERVATION T008: ${id} fixture refused: ${problem} positives=${positives.length} bun=${Bun.version}`);
        console.log(`GATE_FAILURE ${JSON.stringify({ id, step: 2, reason: problem })}`);
        expect(problem).toBeNull();
        return;
      }
      const jobFile = join(work, `${id}.json`);
      writeFileSync(jobFile, JSON.stringify({ aff, dic, hunspell: pathToFileURL(HUNSPELL).href, positives, negatives, latin: LATIN_NEGATIVES }));
      const proc = Bun.spawn([process.execPath, "-e", CHILD, jobFile], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS });
      children.push(proc);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (proc.exitCode !== 0) {
        console.log(`OBSERVATION T008: ${id} ${proc.signalCode === null ? `exit=${proc.exitCode}` : "no load within 60 s"} bun=${Bun.version}`);
        console.error(err);
        expect(proc.exitCode).toBe(0);
        return;
      }
      const r = JSON.parse(out.trim().split("\n").at(-1)!) as { load: number; rss: number; nfcAff: boolean; nfcDic: boolean; failedPositives: string[]; failedNegatives: string[]; latinAccepted: number };
      console.log(
        `OBSERVATION T008: ${id} load=${Math.round(r.load)} rss=${(r.rss / 1048576).toFixed(1)} nfc=${r.nfcAff}/${r.nfcDic} fixture=${r.failedPositives.length}/${r.failedNegatives.length} positives=${positives.length} script=${script} latinAccepted=${r.latinAccepted}/${LATIN_NEGATIVES.length} bun=${Bun.version}`,
      );
      if (r.failedPositives.length + r.failedNegatives.length > 0) console.log(`GATE_FAILURE ${JSON.stringify({ id, step: 2, reason: "fixture", failedPositives: r.failedPositives, failedNegatives: r.failedNegatives })}`);
      expect([r.failedPositives, r.failedNegatives]).toEqual([[], []]);
    },
    CHILD_TIMEOUT_MS + 10_000,
  );
});
