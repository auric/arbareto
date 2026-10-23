// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { z } from "zod";

// Data-model §2: a language ID, at most 32 bytes. The form holds only ASCII, so the code point bound is the byte bound.
export const LANGUAGE_ID_BYTES = 32;
export const LanguageId = z
  .string()
  .max(LANGUAGE_ID_BYTES)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
export type LanguageId = z.infer<typeof LanguageId>;

// Data-model §2: the names that a catalog entry `files` can hold, in the download order.
export const DICTIONARY_FILE_NAMES = ["index.aff", "index.dic", "license", "licence", "readme.md"] as const;
export const DictionaryFileName = z.enum(DICTIONARY_FILE_NAMES);

// Data-model §4: the service state of a catalog entry, and its notice.
export const LANGUAGE_STATES = ["not-downloaded", "ready", "changed", "downloading", "importing"] as const;
export const LANGUAGE_NOTICES = ["catalog-changed"] as const;
