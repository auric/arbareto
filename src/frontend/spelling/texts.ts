// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 006 plan.md D17 "Commit editor": every visible text of the editor spell check.

const count = (n: number) => n.toLocaleString("en-US");

export const SPELLING_TEXTS = {
  chip: (languages: readonly string[]) => `Spelling: ${languages.join(", ")}`,
  off: "Spelling: Off",
  none: "Spelling: No language loaded",
  cannotLoad: (language: string) => `Arbareto cannot load the ${language} dictionary. Spell check uses the other languages.`,
  stillLoads: (language: string) => `Arbareto still loads the ${language} dictionary.`,
  limit: "Spell check covers at most 64 KiB of text.",
  count: (n: number) => (n === 0 ? "No possible misspellings" : n === 1 ? "1 possible misspelling" : `${count(n)} possible misspellings`),
  menu: (word: string) => `Spelling of ${word}`,
  finding: "Finding suggestions…",
  ignore: "Ignore",
  add: "Add to dictionary",
  cut: "Cut",
  copy: "Copy",
  selectAll: "Select all",
  full: "The personal word list holds 10,000 words. Remove a word first.",
  long: "A word in the personal word list can have at most 100 characters.",
  unreadable: "Arbareto could not read the personal word list.",
  unavailable: "Arbareto cannot save words, because the app storage is not available.",
  selectFirst: "Select text first.",
  addFailed: "Arbareto could not save the word. The commit and the draft are not affected.",
  replaceFailed: "Arbareto could not replace the word. The text stays unchanged.",
} as const;
