// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §4 "Split index": the service reads the raw index `link` extension itself.
// Layout: Git `Documentation/gitformat-index.adoc` and `read-cache.c` (git-for-windows 52ca1113).

import { parseMaybeBool, type ConfigEntry, type TrustListing } from "./trust";

export type ObjectFormat = "sha1" | "sha256";

// gitformat-index: checksums and object names use the hash of the repository object format.
const HASH_BYTES: Record<ObjectFormat, number> = { sha1: 20, sha256: 32 };

const DIRC = 0x44495243;
const HEADER_BYTES = 12;
// read-cache.c `struct ondisk_cache_entry`: ten 32-bit stat fields come before the object name.
const STAT_BYTES = 40;
const CE_NAMEMASK = 0x0fff;
const CE_EXTENDED = 0x4000;
// read-cache.c `create_from_disk` refuses any second-field bit except skip-worktree and intent-to-add.
const CE_EXTENDED_FLAGS = 0x6000;
const LINK = 0x6c696e6b;
// read-cache.c `read_index_extension` understands only these two required extensions.
const SPARSE_DIRECTORIES = 0x73646972;

// The bytes are not an index that Git can read. A caller must never treat this as "no link".
export class IndexFormatError extends Error {}

const refuse = (detail: string): never => {
  throw new IndexFormatError(detail);
};

// varint.c `decode_varint`. A value above `limit` is malformed, so the loop stops before a precision loss.
function varint(raw: Uint8Array, at: number, end: number, limit: number): { value: number; next: number } {
  if (at >= end) refuse("truncated name prefix");
  let c = raw[at++]!;
  let value = c & 127;
  while (c & 128) {
    value += 1;
    if (value > limit || at >= end) refuse("bad name prefix");
    c = raw[at++]!;
    value = value * 128 + (c & 127);
  }
  return { value, next: at };
}

// One logical index entry without its stat data.
export interface RawIndexEntry {
  path: Uint8Array;
  // Six octal digits, as `ls-files --stage` prints them.
  mode: string;
  oid: string;
  stage: number;
  assumeUnchanged: boolean;
  skipWorktree: boolean;
  intentToAdd: boolean;
}

// gitformat-index: `ctime`, `mtime`, `dev`, and `ino` come before the 32-bit mode.
const MODE_AT = 24;
const CE_VALID = 0x8000;
const CE_STAGEMASK = 0x3000;
const CE_SKIP_WORKTREE = 0x4000;
const CE_INTENT_TO_ADD = 0x2000;

// Returns the link hash in hex, or null without a `link` extension. Every read stays below `raw.length`.
// With `entries`, it also adds each entry to that list.
function walk(raw: Uint8Array, hashBytes: number, entries?: RawIndexEntry[]): string | null {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const end = raw.length - hashBytes;
  if (end < HEADER_BYTES || view.getUint32(0) !== DIRC) refuse("bad header");
  const version = view.getUint32(4);
  if (version < 2 || version > 4) refuse("bad version");
  const count = view.getUint32(8);
  let at = HEADER_BYTES;
  let previous = 0;
  let previousName = new Uint8Array();
  // Each entry consumes at least one byte, so the loop ends within `raw.length` steps.
  for (let i = 0; i < count; i++) {
    const flagsAt = at + STAT_BYTES + hashBytes;
    if (flagsAt + 2 > end) refuse("truncated entry");
    const flags = view.getUint16(flagsAt);
    let nameAt = flagsAt + 2;
    let extended = 0;
    if (flags & CE_EXTENDED) {
      if (nameAt + 2 > end || view.getUint16(nameAt) & ~CE_EXTENDED_FLAGS) refuse("bad extended flags");
      extended = view.getUint16(nameAt);
      nameAt += 2;
    }
    const add = (path: Uint8Array) =>
      entries?.push({
        path,
        mode: view.getUint32(at + MODE_AT).toString(8).padStart(6, "0"),
        oid: Buffer.from(raw.buffer, raw.byteOffset + at + STAT_BYTES, hashBytes).toString("hex"),
        stage: (flags & CE_STAGEMASK) >> 12,
        assumeUnchanged: (flags & CE_VALID) !== 0,
        skipWorktree: (extended & CE_SKIP_WORKTREE) !== 0,
        intentToAdd: (extended & CE_INTENT_TO_ADD) !== 0,
      });
    let length = flags & CE_NAMEMASK;
    if (version === 4) {
      // gitformat-index: strip N bytes from the previous name, then append the NUL-terminated suffix. No padding follows.
      const strip = varint(raw, nameAt, end, previous);
      if (strip.value > previous) refuse("bad name prefix");
      const nul = raw.indexOf(0, strip.next);
      if (nul < 0 || nul >= end) refuse("unterminated name");
      const full = previous - strip.value + (nul - strip.next);
      if (length !== CE_NAMEMASK && length !== full) refuse("bad name length");
      if (entries !== undefined) {
        previousName = Buffer.concat([previousName.subarray(0, previous - strip.value), raw.subarray(strip.next, nul)]);
        add(previousName);
      }
      previous = full;
      at = nul + 1;
      continue;
    }
    if (length === CE_NAMEMASK) {
      const nul = raw.indexOf(0, nameAt);
      if (nul < 0 || nul >= end) refuse("unterminated name");
      length = nul - nameAt;
    }
    // read-cache.c `ondisk_ce_size`: 1 to 8 NUL bytes pad the entry to a multiple of 8 bytes.
    const next = at + ((nameAt - at + length + 8) & ~7);
    if (next > end) refuse("truncated entry");
    for (let k = nameAt + length; k < next; k++) if (raw[k] !== 0) refuse("bad padding");
    add(raw.subarray(nameAt, nameAt + length));
    at = next;
  }
  let link: string | null = null;
  while (at < end) {
    if (at + 8 > end) refuse("truncated extension");
    const signature = view.getUint32(at);
    const size = view.getUint32(at + 4);
    const dataAt = at + 8;
    if (size > end - dataAt) refuse("truncated extension");
    if (signature === LINK) {
      // split-index.c `read_link_extension`: the data starts with the shared index hash.
      if (link !== null || size < hashBytes) refuse("bad link extension");
      link = Buffer.from(raw.buffer, raw.byteOffset + dataAt, hashBytes).toString("hex");
    } else if (signature !== SPARSE_DIRECTORIES && !(raw[at]! >= 0x41 && raw[at]! <= 0x5a)) {
      // gitformat-index: an extension is optional only when its first byte is 'A'..'Z'.
      refuse("unknown required extension");
    }
    at = dataAt + size;
  }
  // read-cache.c `verify_hdr`: an all-zero trailer means no checksum (`index.skipHash`).
  const trailer = raw.subarray(end);
  if (trailer.some((b) => b !== 0)) {
    const sum = new Bun.CryptoHasher(hashBytes === HASH_BYTES.sha1 ? "sha1" : "sha256").update(raw.subarray(0, end)).digest();
    if (!sum.equals(trailer)) refuse("bad checksum");
  }
  return link;
}

// The hex hash of the shared index that the raw `link` extension names, or null without that extension.
// An all-zero hash means that no shared file is needed (gitformat-index "Split index"); it still is a `link` extension.
// Without `objectFormat`, each format is tried. A result counts only when every format that parses gives it.
export function splitIndexLink(rawIndex: Uint8Array, objectFormat?: ObjectFormat): string | null {
  const formats = objectFormat === undefined ? (Object.keys(HASH_BYTES) as ObjectFormat[]) : [objectFormat];
  const answers: (string | null)[] = [];
  let failure: unknown;
  for (const format of formats) {
    try {
      answers.push(walk(rawIndex, HASH_BYTES[format]));
    } catch (error) {
      if (!(error instanceof IndexFormatError)) throw error;
      failure = error;
    }
  }
  if (answers.length === 0) throw failure;
  if (answers.some((a) => a !== answers[0])) refuse("object format is ambiguous");
  return answers[0]!;
}

// The logical entries of a raw index in index order, and its `link` hash. Throws IndexFormatError for bytes that are no Git index.
export function rawIndexEntries(rawIndex: Uint8Array, objectFormat: ObjectFormat): { link: string | null; entries: RawIndexEntry[] } {
  const entries: RawIndexEntry[] = [];
  const link = walk(rawIndex, HASH_BYTES[objectFormat], entries);
  return { link, entries };
}

// ---- Hunk eligibility (contract §4 "Hunk eligibility and publication", data-model §2 `hunkEligibility`) ----

// Order of the contract §4 list. The first reason that applies wins.
export const HUNK_REFUSAL_REASONS = ["sparse-index", "split-index", "index-change-hook", "executable-monitor", "unqualified-monitor"] as const;
export type HunkRefusalReason = (typeof HUNK_REFUSAL_REASONS)[number];
export type HunkEligibility = { eligible: true } | { eligible: false; reason: HunkRefusalReason };

const INDEX_CHANGE_EVENT = "post-index-change";

// The last entry of a key gives its value (Git `config.c` `git_configset_get_value`). Undefined when no scope sets the key.
// Git prints the section and the variable in lowercase. These keys have no subsection, so the whole key compares in lowercase.
function effective(entries: readonly ConfigEntry[], key: string): ConfigEntry | undefined {
  let found: ConfigEntry | undefined;
  for (const entry of entries) if (entry.key.toLowerCase() === key) found = entry;
  return found;
}

// `rawIndex` holds the index file bytes that the read captured, or null when the index file is absent.
// `{ link }` holds the `link` hash of index bytes that an earlier read parsed (contract §11 "Change polling").
// This function starts no process and never asks Git for the shared index path (contract §6).
// It throws IndexFormatError for bytes that are no Git index. The caller must not treat that as eligible.
export function hunkEligibility(rawIndex: Uint8Array | null | { link: string | null }, objectFormat: ObjectFormat, listing: Pick<TrustListing, "entries" | "hooks">): HunkEligibility {
  const refuse = (reason: HunkRefusalReason): HunkEligibility => ({ eligible: false, reason });
  const { entries, hooks } = listing;
  // repo-settings.c `prepare_repo_settings`: `index.sparse` is a Git boolean.
  const sparse = effective(entries, "index.sparse");
  if (sparse !== undefined && parseMaybeBool(sparse.value) === 1) return refuse("sparse-index");
  if (rawIndex !== null && (rawIndex instanceof Uint8Array ? splitIndexLink(rawIndex, objectFormat) : rawIndex.link) !== null) return refuse("split-index");
  // config.c `repo_config_get_split_index`: only a valid true value splits the index.
  const split = effective(entries, "core.splitindex");
  if (split !== undefined && parseMaybeBool(split.value) === 1) return refuse("split-index");
  // Research R3: every registration counts, also a disabled one or one of a disabled event.
  if (hooks.configured.some((hook) => hook.event === INDEX_CHANGE_EVENT) || hooks.folder.some((hook) => hook.event === INDEX_CHANGE_EVENT)) return refuse("index-change-hook");
  // fsmonitor-settings.c `lookup_fsmonitor_settings`: true names the built-in daemon, false disables, and another value is a command.
  const monitor = effective(entries, "core.fsmonitor");
  if (monitor !== undefined) {
    const mode = parseMaybeBool(monitor.value);
    if (mode === -1) return refuse("executable-monitor");
    if (mode === 1) return refuse("unqualified-monitor");
  }
  return { eligible: true };
}
