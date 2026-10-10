// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// research.md R9: Pierre's name for a language outside the shipped set fails the highlight task. `text` is Pierre's plain-text path.

import { getFiletypeFromFileName, type FileDiffMetadata, type SupportedLanguages } from "@pierre/diffs";
import { LANGUAGES } from "./set";

const SHIPPED = new Set(Object.entries(LANGUAGES).flatMap(([id, { aliases }]) => [id, ...aliases]));

/** Pierre's language for a file name, or `text` when the set does not ship it. */
export function shippedLanguage(name: string): SupportedLanguages {
  const lang = getFiletypeFromFileName(name);
  return SHIPPED.has(lang) ? lang : "text";
}

/** `text` when one side of the diff has no shipped language. Otherwise undefined, so Pierre picks the language of each side. */
export function diffLanguage(file: Pick<FileDiffMetadata, "name" | "prevName">): "text" | undefined {
  const names = file.prevName === undefined ? [file.name] : [file.name, file.prevName];
  return names.some((name) => shippedLanguage(name) === "text") ? "text" : undefined;
}
