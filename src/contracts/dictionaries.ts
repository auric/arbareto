// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 006 data-model §1 and §2: the schema of src/contracts/dictionaries.json. The service, the renderer, and the build parse the file with it.

import { z } from "zod";
import { DICTIONARY_CATALOG_ENTRIES, DICTIONARY_LANGUAGE_BYTES } from "./limits";
import { compareNames as compareNameBytes } from "./tree-order";

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

// Data-model §2 and §16: the Unicode Script property values (long names) of a catalog entry. No entry holds Common or Inherited.
export const DICTIONARY_SCRIPTS = [
  "Latin", "Cyrillic", "Greek", "Armenian", "Hebrew", "Arabic", "Syriac", "Thaana", "Georgian", "Ethiopic", "Cherokee", "Canadian_Aboriginal", "Mongolian", "Tifinagh",
  "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan", "Myanmar", "Khmer", "Hangul", "Han", "Hiragana", "Katakana",
] as const;

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LICENCE_FORMS = ["license", "licence", "license,licence", "readme.md"];
const utf8 = new TextEncoder();
const bytes = (text: string) => utf8.encode(text).length;

// The 005 name order over the UTF-8 bytes of the names.
export const compareNames = (a: string, b: string): number => compareNameBytes(utf8.encode(a), utf8.encode(b));

const CatalogFile = z.strictObject({
  name: DictionaryFileName,
  url: z.string(),
  size: z.number().int().min(1).max(DICTIONARY_LANGUAGE_BYTES),
  sha256: z.string().regex(SHA256),
});

const entryFields = {
  id: LanguageId,
  name: z.string().refine((name) => [...name].length >= 1 && [...name].length <= 64),
  license: z.string().refine((license) => bytes(license) >= 1 && bytes(license) <= 128),
  script: z.enum(DICTIONARY_SCRIPTS),
  commit: z.string().regex(COMMIT),
  files: z.array(CatalogFile).min(3).max(4),
  licences: z.array(z.enum(["license", "licence", "readme.md"])).min(1).max(2),
};

type EntryShape = { files: { name: string; size: number }[]; licences: string[] };
const entryRules = (entry: EntryShape, ctx: z.RefinementCtx) => {
  if (!LICENCE_FORMS.includes(entry.licences.join(","))) ctx.addIssue({ code: "custom", message: "licences form", path: ["licences"] });
  if (entry.files.map((f) => f.name).join(",") !== ["index.aff", "index.dic", ...entry.licences].join(",")) ctx.addIssue({ code: "custom", message: "files order", path: ["files"] });
  if (entry.files.reduce((sum, f) => sum + f.size, 0) > DICTIONARY_LANGUAGE_BYTES) ctx.addIssue({ code: "custom", message: "DICTIONARY_LANGUAGE_BYTES", path: ["files"] });
};

export const CatalogEntry = z.strictObject(entryFields).superRefine(entryRules);
export type CatalogEntry = z.infer<typeof CatalogEntry>;

const BundledEntry = z
  .strictObject({ ...entryFields, id: z.literal("en"), script: z.literal("Latin"), package: z.strictObject({ name: z.literal("dictionary-en"), version: z.string() }) })
  .superRefine(entryRules);

export const Catalog = z
  .strictObject({
    version: z.literal(1),
    source: z.strictObject({ repository: z.literal("wooorm/dictionaries"), commit: z.string().regex(COMMIT), urlPrefix: z.string() }),
    bundled: BundledEntry,
    entries: z.array(CatalogEntry).max(DICTIONARY_CATALOG_ENTRIES),
  })
  .superRefine((catalog, ctx) => {
    const { commit, urlPrefix } = catalog.source;
    if (urlPrefix !== `https://raw.githubusercontent.com/wooorm/dictionaries/${commit}/dictionaries/`) ctx.addIssue({ code: "custom", message: "urlPrefix", path: ["source", "urlPrefix"] });
    const ids = new Set<string>();
    for (const [i, entry] of [catalog.bundled, ...catalog.entries].entries()) {
      const path = i === 0 ? ["bundled"] : ["entries", i - 1];
      if (entry.commit !== commit) ctx.addIssue({ code: "custom", message: "commit", path });
      for (const f of entry.files) if (f.url !== `${urlPrefix}${entry.id}/${f.name}`) ctx.addIssue({ code: "custom", message: "url", path });
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", message: "duplicate id", path });
      ids.add(entry.id);
    }
    for (let i = 1; i < catalog.entries.length; i++) {
      if (compareNames(catalog.entries[i - 1]!.name, catalog.entries[i]!.name) > 0) ctx.addIssue({ code: "custom", message: "compareNames order", path: ["entries", i] });
    }
  });
export type Catalog = z.infer<typeof Catalog>;
