// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import catalog from "../../contracts/dictionaries.json";
import { SPELLING_LANGUAGES } from "../../contracts/limits";
import { acceptedSet } from "../../contracts/spell-words";
import type { BridgeResponse } from "../bridge";
import { createWordList, type AddOutcome, type WordList, type WordListState } from "./word-list";

// 006 plan.md D15: the selection, the language states, the word list state, the Ignore list, and the subscriptions.

export type LanguageState = "loading" | "loaded" | "failed";
export type SpellingSetting = { enabled: boolean; languages: readonly string[] };
export type SpellingState = {
  /** Null until the first settings response. */
  setting: SpellingSetting | null;
  /** The check worker state of each language that the engine started. */
  languages: ReadonlyMap<string, LanguageState>;
  words: WordListState;
  /** Data-model §10: the NFC words of the Ignore list. */
  ignored: ReadonlySet<string>;
};

// Data-model §8: the default and the value after a read failure.
const DEFAULT: SpellingSetting = { enabled: true, languages: ["en"] };
const NAMES = new Map<string, string>([[catalog.bundled.id, catalog.bundled.name], ...catalog.entries.map((entry) => [entry.id, entry.name] as [string, string])]);
/** The catalog name of a language. The shell drops every ID outside the catalog (plan.md D11). */
export const languageName = (id: string) => NAMES.get(id) ?? id;

/** Data-model §8 `spelling` of a `readSyncSettings` or `setSpelling` result. The renderer bundle holds no zod, so this reads the fields it uses. */
function settingOf(response: BridgeResponse): SpellingSetting {
  const spelling = (response.result as { spelling?: { enabled?: unknown; languages?: unknown } } | undefined)?.spelling;
  if (response.state !== "succeeded" || typeof spelling?.enabled !== "boolean" || !Array.isArray(spelling.languages)) return DEFAULT;
  const languages = spelling.languages;
  if (languages.length > SPELLING_LANGUAGES || !languages.every((id) => typeof id === "string") || new Set(languages).size !== languages.length) return DEFAULT;
  return { enabled: spelling.enabled, languages };
}

export function createSpellingStore(wordList: WordList = createWordList()) {
  let state: SpellingState = { setting: null, languages: new Map(), words: { kind: "loading" }, ignored: new Set() };
  let accepted = new Set<string>();
  const listeners = new Set<() => void>();
  // 001 latest-wins rule: a response applies only when no later request has applied.
  let issued = 0;
  let applied = 0;
  let wordsRead = false;

  function set(next: Partial<SpellingState>) {
    state = { ...state, ...next };
    if (next.words !== undefined || next.ignored !== undefined) {
      const listed = state.words.kind === "loaded" ? state.words.words : [];
      accepted = new Set([...acceptedSet(listed), ...acceptedSet(state.ignored)]);
    }
    for (const listener of [...listeners]) listener();
  }

  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Takes the `spelling` value of a settings response. */
    settings(response: Promise<BridgeResponse>) {
      const seq = ++issued;
      void response.then((r) => {
        if (seq <= applied) return;
        applied = seq;
        set({ setting: settingOf(r) });
      });
    },
    setLanguage(id: string, language: LanguageState | null) {
      const languages = new Map(state.languages);
      if (language === null) languages.delete(id);
      else languages.set(id, language);
      set({ languages });
    },
    /** Plan.md D10: the first editor show reads the list once. */
    readWords() {
      if (wordsRead) return;
      wordsRead = true;
      void wordList.read().then((words) => set({ words }));
    },
    ignore(word: string) {
      set({ ignored: new Set(state.ignored).add(word) });
    },
    async add(word: string): Promise<AddOutcome> {
      const outcome = await wordList.add(word);
      const words = state.words;
      if ((outcome === "added" || outcome === "listed") && words.kind === "loaded" && !words.words.includes(word)) set({ words: { kind: "loaded", words: [...words.words, word] } });
      return outcome;
    },
    /** Data-model §12: the personal word list or the Ignore list accepts the NFC word. */
    accepts: (word: string) => accepted.has(word),
  };
}

export type SpellingStore = ReturnType<typeof createSpellingStore>;
