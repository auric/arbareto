// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T010: the feature 006 contract changes (contract Δ1 to Δ3, Δ5, Δ9, Δ10; data-model §4, §7, §8; spec FR-009, FR-016, FR-027).

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { printOrigin } from "../origin";
import * as envelope from "../../src/contracts/envelope";
import * as errors from "../../src/contracts/errors";
import * as limits from "../../src/contracts/limits";
import { isWindows } from "../../src/contracts/native-path";
import * as operations from "../../src/contracts/operations";

printOrigin("../../src/contracts/envelope.ts", import.meta.dir);
printOrigin("../../src/contracts/errors.ts", import.meta.dir);
printOrigin("../../src/contracts/limits.ts", import.meta.dir);
printOrigin("../../src/contracts/operations.ts", import.meta.dir);

// The module namespaces give `undefined` for a missing export, so each case fails on its own before T013.
const L = limits as unknown as Record<string, number>;
const E = errors as unknown as Record<string, readonly string[]>;
const R = envelope as unknown as Record<string, z.ZodType>;

const id = () => crypto.randomUUID();
const ok = (schema: z.ZodType | undefined, value: unknown) => schema !== undefined && schema.safeParse(value).success;
const request = (operation: string, payload: unknown, target: Record<string, unknown> = {}) => ({ version: 1, sessionId: id(), requestId: id(), operation, ...target, payload });
const check = (value: unknown, side: "renderer" | "service" = "renderer") => {
  const result = envelope.validateRequest(value, side);
  return result.ok ? "ok" : result.code;
};
const native = (value: unknown) => envelope.NativeFirstEnvelope.safeParse(value).success;
const FOLDER = isWindows ? "D:\\dictionaries\\uk" : "/dictionaries/uk";
const CHUNK = 1_048_576;

const NEW_SERVICE = ["listDictionaries", "readDictionary", "downloadDictionary", "importDictionary", "removeDictionary"];
const NEW_SHELL = ["setSpelling", "openLicenceLink"];
const REASONS = ["busy", "not-https", "redirect", "http-not-found", "http-rate-limit", "http-status", "transport", "mismatch", "save", "import-mismatch", "import-unreadable", "absent", "changed", "remove", "link"];

describe("contract Δ5 bounds", () => {
  test("each bound has its exact value", () => {
    expect({
      DICTIONARY_CATALOG_ENTRIES: L.DICTIONARY_CATALOG_ENTRIES,
      DICTIONARY_LANGUAGE_BYTES: L.DICTIONARY_LANGUAGE_BYTES,
      DICTIONARY_MANIFEST_BYTES: L.DICTIONARY_MANIFEST_BYTES,
      DICTIONARY_CHUNK_BYTES: L.DICTIONARY_CHUNK_BYTES,
      DICTIONARY_DOWNLOAD_DEADLINE_MS: L.DICTIONARY_DOWNLOAD_DEADLINE_MS,
      DICTIONARY_LOAD_DEADLINE_MS: L.DICTIONARY_LOAD_DEADLINE_MS,
      DICTIONARY_PROGRESS_EVENTS_PER_SECOND: L.DICTIONARY_PROGRESS_EVENTS_PER_SECOND,
      SPELLING_LANGUAGES: L.SPELLING_LANGUAGES,
      SPELLING_SUGGESTIONS: L.SPELLING_SUGGESTIONS,
      PERSONAL_WORDS: L.PERSONAL_WORDS,
      PERSONAL_WORD_CODE_POINTS: L.PERSONAL_WORD_CODE_POINTS,
    }).toEqual({
      DICTIONARY_CATALOG_ENTRIES: 92,
      DICTIONARY_LANGUAGE_BYTES: 12_582_912,
      DICTIONARY_MANIFEST_BYTES: 65_536,
      DICTIONARY_CHUNK_BYTES: 1_048_576,
      DICTIONARY_DOWNLOAD_DEADLINE_MS: 120_000,
      DICTIONARY_LOAD_DEADLINE_MS: 30_000,
      DICTIONARY_PROGRESS_EVENTS_PER_SECOND: 4,
      SPELLING_LANGUAGES: 3,
      SPELLING_SUGGESTIONS: 5,
      PERSONAL_WORDS: 10_000,
      PERSONAL_WORD_CODE_POINTS: 100,
    });
  });

  test("the download deadline equals REGISTERED_DEADLINE_CAP_MS, and the load deadline equals READ_DEADLINE_MS", () => {
    expect(L.DICTIONARY_DOWNLOAD_DEADLINE_MS).toBe(limits.REGISTERED_DEADLINE_CAP_MS);
    expect(L.DICTIONARY_LOAD_DEADLINE_MS).toBe(limits.READ_DEADLINE_MS);
  });
});

describe("contract Δ9 code and reasons", () => {
  test("DICTIONARY_UNAVAILABLE is a code with its fifteen reasons", () => {
    expect(errors.ERROR_CODES).toContain("DICTIONARY_UNAVAILABLE" as never);
    expect([...(E.DICTIONARY_UNAVAILABLE_REASONS ?? [])]).toEqual(REASONS);
  });

  const refusal = (fields: Record<string, unknown>) => ok(R.DictionaryRefusal, fields);
  test("http-status carries an integer status from 100 to 599, and no other reason carries one", () => {
    expect(refusal({ reason: "http-status", status: 503 })).toBe(true);
    expect(refusal({ reason: "http-status", status: 100 })).toBe(true);
    expect(refusal({ reason: "http-status", status: 599 })).toBe(true);
    for (const status of [99, 600, 503.5, "503", -1]) expect(refusal({ reason: "http-status", status })).toBe(false);
    expect(refusal({ reason: "http-status" })).toBe(false);
    expect(refusal({ reason: "redirect", status: 301 })).toBe(false);
  });

  test("save, import-unreadable, and remove carry folder, and no other reason carries one", () => {
    for (const reason of ["save", "import-unreadable", "remove"]) {
      expect(refusal({ reason, folder: FOLDER })).toBe(true);
      expect(refusal({ reason })).toBe(false);
      expect(refusal({ reason, folder: "relative\\uk" })).toBe(false);
    }
    expect(refusal({ reason: "import-mismatch", folder: FOLDER })).toBe(false);
  });

  test("link carries url, and no other reason carries one", () => {
    const url = "https://raw.githubusercontent.com/wooorm/dictionaries/8cfea406b505e4d7df52d5a19bce525df98c54ab/dictionaries/uk/license";
    expect(refusal({ reason: "link", url })).toBe(true);
    expect(refusal({ reason: "link" })).toBe(false);
    expect(refusal({ reason: "transport", url })).toBe(false);
  });

  test("each other reason carries no field, and an unknown reason or field fails", () => {
    for (const reason of ["busy", "not-https", "redirect", "http-not-found", "http-rate-limit", "transport", "mismatch", "import-mismatch", "absent", "changed"]) expect(refusal({ reason })).toBe(true);
    expect(refusal({ reason: "timeout" })).toBe(false);
    expect(refusal({ reason: "busy", message: "Another run holds the lock." })).toBe(false);
  });
});

describe("contract Δ1 operations", () => {
  test("the operation list holds the five service operations and the two shell-only operations", () => {
    expect(operations.OPERATIONS).toEqual(expect.arrayContaining([...NEW_SERVICE, ...NEW_SHELL]));
    expect(operations.SHELL_ONLY).toEqual(expect.arrayContaining(NEW_SHELL));
    for (const name of NEW_SERVICE) expect(operations.SHELL_ONLY).not.toContain(name);
  });

  test("importDictionary, setSpelling, and openLicenceLink are native-first, and the other dictionary operations are not", () => {
    const names = (envelope.NativeFirstEnvelope.options as readonly { shape: { operation: { value: string } } }[]).map((o) => o.shape.operation.value);
    expect(names).toEqual(expect.arrayContaining(["importDictionary", ...NEW_SHELL]));
    for (const name of ["listDictionaries", "readDictionary", "downloadDictionary", "removeDictionary"]) expect(names).not.toContain(name);
  });

  test("the service never gets setSpelling or openLicenceLink", () => {
    expect(check(request("setSpelling", { enabled: true, languages: ["en"] }), "service")).toBe("UNKNOWN_OPERATION");
    expect(check(request("openLicenceLink", { language: "en" }), "service")).toBe("UNKNOWN_OPERATION");
  });
});

describe("contract Δ2 and Δ3 payloads", () => {
  test("listDictionaries takes an empty payload on both sides", () => {
    for (const side of ["renderer", "service"] as const) {
      expect(check(request("listDictionaries", {}), side)).toBe("ok");
      expect(check(request("listDictionaries", { language: "uk" }), side)).toBe("INVALID_REQUEST");
    }
  });

  test("no dictionary operation takes a repository target", () => {
    const payloads: Record<string, unknown> = {
      listDictionaries: {},
      readDictionary: { language: "uk", file: "index.aff", offset: 0 },
      downloadDictionary: { language: "uk" },
      importDictionary: { language: "uk" },
      removeDictionary: { language: "uk" },
      setSpelling: { enabled: true, languages: [] },
      openLicenceLink: { language: "uk" },
    };
    for (const [operation, payload] of Object.entries(payloads)) {
      expect(check(request(operation, payload))).toBe("ok");
      expect(check(request(operation, payload, { repositoryId: id() }))).toBe("INVALID_REQUEST");
      expect(check(request(operation, payload, { repositoryId: id(), repositoryGeneration: 0 }))).toBe("INVALID_REQUEST");
    }
  });

  test("a language ID has the data-model §2 form and at most 32 bytes", () => {
    for (const language of ["en", "uk", "de-CH", "sr-Latn", "ca-valencia", "tlh-Latn", "hyw"]) expect(check(request("downloadDictionary", { language }))).toBe("ok");
    for (const language of ["", "e", "EN", "uk_UA", "de-", "de-C", "de-CHCHCHCHC", "abcd", "uk/..", "../uk", `uk-${"ab".repeat(15)}`, 1, null]) {
      expect(check(request("downloadDictionary", { language }))).toBe("INVALID_REQUEST");
    }
    // 32 bytes pass; 33 bytes fail.
    const at = `uk${"-abcdefgh".repeat(3)}-ab`;
    expect(at.length).toBe(32);
    expect(check(request("removeDictionary", { language: at }))).toBe("ok");
    expect(check(request("removeDictionary", { language: `${at}x` }))).toBe("INVALID_REQUEST");
  });

  test("readDictionary takes a catalog file name and an offset of 0 or a multiple of DICTIONARY_CHUNK_BYTES", () => {
    for (const file of ["index.aff", "index.dic", "license", "licence", "readme.md"]) expect(check(request("readDictionary", { language: "uk", file, offset: 0 }), "service")).toBe("ok");
    for (const file of ["entry.json", "../index.aff", "INDEX.AFF", "index.aff ", ""]) expect(check(request("readDictionary", { language: "uk", file, offset: 0 }))).toBe("INVALID_REQUEST");
    for (const offset of [0, CHUNK, 8 * CHUNK]) expect(check(request("readDictionary", { language: "uk", file: "index.dic", offset }))).toBe("ok");
    for (const offset of [1, CHUNK - 1, CHUNK + 1, -CHUNK, 0.5, "0", null]) expect(check(request("readDictionary", { language: "uk", file: "index.dic", offset }))).toBe("INVALID_REQUEST");
    expect(check(request("readDictionary", { language: "uk", file: "index.dic" }))).toBe("INVALID_REQUEST");
  });

  test("importDictionary takes {language} from the renderer and {language, folder} on the service side", () => {
    expect(check(request("importDictionary", { language: "uk" }))).toBe("ok");
    expect(native(request("importDictionary", { language: "uk" }))).toBe(true);
    expect(check(request("importDictionary", { language: "uk", folder: FOLDER }))).toBe("INVALID_REQUEST");
    expect(check(request("importDictionary", { language: "uk", folder: FOLDER }), "service")).toBe("ok");
    expect(check(request("importDictionary", { language: "uk" }), "service")).toBe("INVALID_REQUEST");
    // Contract Δ3: a path with a lone surrogate gives INVALID_REQUEST.
    expect(check(request("importDictionary", { language: "uk", folder: `${FOLDER}\uD800` }), "service")).toBe("INVALID_REQUEST");
    expect(check(request("importDictionary", { language: "uk", folder: "uk" }), "service")).toBe("INVALID_REQUEST");
  });

  test("setSpelling takes enabled and 0 to 3 unique language IDs", () => {
    const set = (payload: unknown) => check(request("setSpelling", payload));
    expect(set({ enabled: true, languages: [] })).toBe("ok");
    expect(set({ enabled: false, languages: ["en", "uk", "de-CH"] })).toBe("ok");
    expect(native(request("setSpelling", { enabled: false, languages: ["uk", "en"] }))).toBe(true);
    expect(set({ enabled: true, languages: ["en", "uk", "de-CH", "fr"] })).toBe("INVALID_REQUEST");
    expect(set({ enabled: true, languages: ["en", "en"] })).toBe("INVALID_REQUEST");
    expect(set({ enabled: true, languages: ["EN"] })).toBe("INVALID_REQUEST");
    expect(set({ enabled: "true", languages: [] })).toBe("INVALID_REQUEST");
    expect(set({ enabled: true })).toBe("INVALID_REQUEST");
    expect(set({ languages: [] })).toBe("INVALID_REQUEST");
  });

  test("openLicenceLink takes a language and never a URL", () => {
    expect(check(request("openLicenceLink", { language: "en" }))).toBe("ok");
    expect(native(request("openLicenceLink", { language: "oc" }))).toBe(true);
    expect(check(request("openLicenceLink", { language: "en", url: "https://example.test/" }))).toBe("INVALID_REQUEST");
    expect(check(request("openLicenceLink", { url: "https://example.test/" }))).toBe("INVALID_REQUEST");
  });

  test("an unknown payload field gives INVALID_REQUEST", () => {
    const extra = { extra: 1 };
    expect(check(request("readDictionary", { language: "uk", file: "index.aff", offset: 0, ...extra }))).toBe("INVALID_REQUEST");
    expect(check(request("downloadDictionary", { language: "uk", url: "https://example.test/uk.dic" }))).toBe("INVALID_REQUEST");
    expect(check(request("removeDictionary", { language: "uk", confirm: true }))).toBe("INVALID_REQUEST");
    expect(check(request("setSpelling", { enabled: true, languages: [], ...extra }))).toBe("INVALID_REQUEST");
  });
});

describe("contract Δ2 progress", () => {
  const event = (fields: Record<string, unknown>) => ({ requestId: id(), operationId: id(), state: "running", phase: "dictionary", counters: { received: 10, total: 100 }, ...fields });
  test("phase dictionary carries only received and total", () => {
    expect(ok(envelope.ProgressEvent, event({}))).toBe(true);
    expect(ok(envelope.ProgressEvent, event({ counters: {} }))).toBe(true);
    expect(ok(envelope.ProgressEvent, event({ counters: { received: 1, total: 2, percent: 50 } }))).toBe(false);
    expect(ok(envelope.ProgressEvent, event({ path: "uk" }))).toBe(false);
    expect(ok(envelope.ProgressEvent, event({ distro: "Ubuntu-26.04" }))).toBe(false);
    expect(ok(envelope.ProgressEvent, event({ url: "https://example.test/" }))).toBe(false);
  });
});

describe("data-model §4 and §7 results", () => {
  test("listDictionaries gives one state per catalog entry, at most DICTIONARY_CATALOG_ENTRIES removed names, and the count of the rest", () => {
    const S = R.ListDictionariesResult;
    const languages = [
      { language: "uk", state: "ready" },
      { language: "de-CH", state: "not-downloaded", notice: "catalog-changed" },
      { language: "fr", state: "changed" },
      { language: "oc", state: "downloading" },
      { language: "eu", state: "importing" },
    ];
    const removed = (n: number) => Array.from({ length: n }, () => ({ language: "xx", name: "Old language" }));
    expect(ok(S, { languages, removed: removed(1), more: 0 })).toBe(true);
    expect(ok(S, { languages: [], removed: [], more: 0 })).toBe(true);
    expect(ok(S, { languages, removed: removed(92), more: 7 })).toBe(true);
    expect(ok(S, { languages, removed: removed(93), more: 0 })).toBe(false);
    expect(ok(S, { languages, removed: [], more: -1 })).toBe(false);
    expect(ok(S, { languages, removed: [] })).toBe(false);
    expect(ok(S, { languages: [{ language: "uk", state: "failed" }], removed: [], more: 0 })).toBe(false);
    expect(ok(S, { languages: [{ language: "uk", state: "ready", notice: "catalog-removed" }], removed: [], more: 0 })).toBe(false);
    expect(ok(S, { languages: [languages[0], languages[0]], removed: [], more: 0 })).toBe(false);
    expect(ok(S, { languages, removed: [{ language: "xx", name: "" }], more: 0 })).toBe(false);
    expect(ok(S, { languages, removed: [{ language: "xx", name: "x".repeat(65) }], more: 0 })).toBe(false);
    expect(ok(S, { languages, more: 0 })).toBe(false);
  });

  test("readDictionary gives one chunk of at most DICTIONARY_CHUNK_BYTES bytes from the offset, or a refusal", () => {
    const S = R.ReadDictionaryResult;
    const chunk = (bytes: number) => Buffer.alloc(bytes, 0x61).toString("base64");
    expect(ok(S, { language: "uk", file: "index.aff", size: 3, offset: 0, bytes: chunk(3) })).toBe(true);
    expect(ok(S, { language: "uk", file: "index.dic", size: CHUNK + 5, offset: 0, bytes: chunk(CHUNK) })).toBe(true);
    expect(ok(S, { language: "uk", file: "index.dic", size: CHUNK + 5, offset: CHUNK, bytes: chunk(5) })).toBe(true);
    // The chunk length must equal the bytes from the offset up to the chunk size.
    expect(ok(S, { language: "uk", file: "index.dic", size: CHUNK + 5, offset: CHUNK, bytes: chunk(4) })).toBe(false);
    expect(ok(S, { language: "uk", file: "index.dic", size: CHUNK + 5, offset: 0, bytes: chunk(CHUNK + 1) })).toBe(false);
    expect(ok(S, { language: "uk", file: "index.dic", size: CHUNK, offset: CHUNK, bytes: "" })).toBe(false);
    expect(ok(S, { language: "uk", file: "index.dic", size: 2 * CHUNK, offset: 1, bytes: chunk(3) })).toBe(false);
    expect(ok(S, { language: "uk", file: "index.dic", size: 12_582_913, offset: 0, bytes: chunk(CHUNK) })).toBe(false);
    expect(ok(S, { language: "uk", file: "index.aff", size: 3, offset: 0, bytes: "not base64!" })).toBe(false);
    expect(ok(S, { reason: "absent" })).toBe(true);
    expect(ok(S, { reason: "changed" })).toBe(true);
  });

  test("download and import give the ready state, and remove gives the removed flag, or a refusal", () => {
    expect(ok(R.DictionaryRunResult, { language: "uk", state: "ready" })).toBe(true);
    expect(ok(R.DictionaryRunResult, { language: "uk", state: "downloading" })).toBe(false);
    expect(ok(R.DictionaryRunResult, { reason: "http-status", status: 503 })).toBe(true);
    expect(ok(R.DictionaryRunResult, { reason: "save", folder: FOLDER })).toBe(true);
    expect(ok(R.RemoveDictionaryResult, { language: "uk", removed: false })).toBe(true);
    expect(ok(R.RemoveDictionaryResult, { language: "uk" })).toBe(false);
    expect(ok(R.RemoveDictionaryResult, { reason: "remove", folder: FOLDER })).toBe(true);
    expect(ok(R.OpenLicenceLinkResult, {})).toBe(true);
    expect(ok(R.OpenLicenceLinkResult, { reason: "link", url: "https://example.test/license" })).toBe(true);
    expect(ok(R.OpenLicenceLinkResult, { url: "https://example.test/license" })).toBe(false);
  });
});

describe("data-model §8 and contract Δ12 spelling setting", () => {
  const settings = {
    sshClient: "git",
    defaultPullAction: "pull",
    switchChoice: "keep",
    plinkPath: null,
    programs: [],
    remoteKeyFiles: [],
    defaultCloneFolder: null,
    lastCloneParent: null,
  };
  test("readSyncSettings carries spelling with enabled and 0 to 3 unique languages", () => {
    const S = envelope.SyncSettingsResult;
    expect(ok(S, { ...settings, spelling: { enabled: true, languages: ["en"] } })).toBe(true);
    expect(ok(S, { ...settings, spelling: { enabled: false, languages: [] } })).toBe(true);
    expect(ok(S, settings)).toBe(false);
    expect(ok(S, { ...settings, spelling: { enabled: true, languages: ["en", "uk", "fr", "de"] } })).toBe(false);
    expect(ok(S, { ...settings, spelling: { enabled: true, languages: ["uk", "uk"] } })).toBe(false);
    expect(ok(S, { ...settings, spelling: { enabled: true } })).toBe(false);
  });
});
