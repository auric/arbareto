// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 006 plan.md D5 and data-model §3: the dictionary folder, the staging folder, the install, the manifest, the checks, and the release reconcile.

import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CatalogEntry, compareNames, type Catalog } from "../contracts/dictionaries";
import { DICTIONARY_CATALOG_ENTRIES, DICTIONARY_MANIFEST_BYTES } from "../contracts/limits";
import { decodeStrictJson, isObject } from "../contracts/strict-json";

type Entry = Catalog["entries"][number];
type CatalogFile = Entry["files"][number];

const READ_STEP_BYTES = 1 << 20;
const STAGING = ".staging-";

export const errnoOf = (error: unknown): unknown => (isObject(error) ? error.code : undefined);
export const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

// Reads at most `limit` bytes from the start of the file. The caller compares the length. An abort between steps throws.
export async function readBounded(path: string, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const out = new Uint8Array(limit);
    let n = 0;
    while (n < limit) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(out, n, Math.min(limit - n, READ_STEP_BYTES), n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return out.subarray(0, n);
  } finally {
    await handle.close();
  }
}

export function createDictionaryStore(folder: string, catalog: Catalog) {
  const byId = new Map(catalog.entries.map((e) => [e.id, e]));
  const changed = new Set<string>();
  const removed: { language: string; name: string }[] = [];
  let reconciled: Promise<void> | null = null;
  // Data-model §3: `.staging-<id>-<32 hex>`.
  const stagingPath = (id: string) => join(folder, `${STAGING}${id}-${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`);

  // Data-model §3: at most DICTIONARY_MANIFEST_BYTES of `{version: 1, entry}`. Any other form is no valid manifest.
  async function manifest(dir: string): Promise<CatalogEntry | null> {
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(join(dir, "entry.json"), DICTIONARY_MANIFEST_BYTES + 1);
    } catch {
      return null;
    }
    if (bytes.length > DICTIONARY_MANIFEST_BYTES) return null;
    const decoded = decodeStrictJson(bytes);
    if (!decoded.ok || !isObject(decoded.value) || Object.keys(decoded.value).length !== 2 || decoded.value.version !== 1) return null;
    const entry = CatalogEntry.safeParse(decoded.value.entry);
    return entry.success ? entry.data : null;
  }

  // The bytes of a regular file with the catalog size and SHA-256, else null.
  async function checkedFile(dir: string, file: CatalogFile): Promise<Uint8Array | null> {
    const path = join(dir, file.name);
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.size !== file.size) return null;
      const bytes = await readBounded(path, file.size + 1);
      return bytes.length === file.size && sha256(bytes) === file.sha256 ? bytes : null;
    } catch {
      return null;
    }
  }

  // Null: `<id>/` does not exist. False: it is no folder.
  async function isFolder(dir: string): Promise<boolean | null> {
    try {
      return (await lstat(dir)).isDirectory();
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return null;
      return false;
    }
  }

  const holds = async (dir: string, entry: Entry) => {
    const m = await manifest(dir);
    return m !== null && Bun.deepEquals(m, entry, true);
  };

  // Data-model §3 table. Each removal that fails stays for the reconcile of the next service process.
  async function reconcileOnce(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return;
    }
    for (const name of names.sort(compareNames)) {
      const path = join(folder, name);
      const gone = () => rm(path, { recursive: true, force: true }).then(() => true, () => false);
      // Data-model §3: only the exact name form of `stagingPath` is a staging leftover.
      const staged = /^\.staging-(.+)-[0-9a-f]{32}$/.exec(name);
      if (staged !== null && byId.has(staged[1]!)) {
        await gone();
        continue;
      }
      if ((await isFolder(path)) !== true) continue;
      const entry = byId.get(name);
      const m = await manifest(path);
      if (m === null) continue;
      if (entry !== undefined) {
        if (!Bun.deepEquals(m, entry, true) && (await gone())) changed.add(name);
      } else if (m.id === name && (await gone())) removed.push({ language: name, name: m.name });
    }
  }

  return {
    entry: (id: string): Entry | undefined => byId.get(id),
    folderOf: (id: string): string => join(folder, id),

    // One reconcile per service process. Every dictionary operation awaits it.
    reconcile(): Promise<void> {
      return (reconciled ??= reconcileOnce().catch(() => {}));
    },

    // Data-model §4: the first DICTIONARY_CATALOG_ENTRIES removed names, and the count of the rest.
    notices(id: string): { notice?: "catalog-changed" } {
      return changed.has(id) ? { notice: "catalog-changed" } : {};
    },
    removedNotices(): { removed: { language: string; name: string }[]; more: number } {
      return { removed: removed.slice(0, DICTIONARY_CATALOG_ENTRIES).map((r) => ({ ...r })), more: Math.max(0, removed.length - DICTIONARY_CATALOG_ENTRIES) };
    },

    // Data-model §3 language check.
    async languageState(entry: Entry): Promise<"not-downloaded" | "changed" | "ready"> {
      const dir = join(folder, entry.id);
      const kind = await isFolder(dir);
      if (kind === null) return "not-downloaded";
      if (!kind || !(await holds(dir, entry))) return "changed";
      for (const file of entry.files) if ((await checkedFile(dir, file)) === null) return "changed";
      return "ready";
    },

    // Data-model §3 file check: the bytes of the requested file, or the refusal reason.
    async fileBytes(entry: Entry, file: CatalogFile): Promise<Uint8Array | "absent" | "changed"> {
      const dir = join(folder, entry.id);
      const kind = await isFolder(dir);
      if (kind === null) return "absent";
      if (!kind || !(await holds(dir, entry))) return "changed";
      return (await checkedFile(dir, file)) ?? "changed";
    },

    // A rejection is a file system error of the staging.
    async stage(id: string): Promise<string> {
      await mkdir(folder, { recursive: true });
      const path = stagingPath(id);
      await mkdir(path);
      return path;
    },

    writeFile: (staging: string, name: string, bytes: Uint8Array) => writeFile(join(staging, name), bytes, { flag: "wx" }),

    // Plan.md D5: the manifest; the old `<id>/` moves aside; the staging folder moves into place; the old folder goes.
    // A failed move into place moves the old folder back, so a reinstall that fails keeps the working install.
    async install(staging: string, entry: Entry): Promise<void> {
      await writeFile(join(staging, "entry.json"), JSON.stringify({ version: 1, entry }), { flag: "wx" });
      const target = join(folder, entry.id);
      const old = (await isFolder(target)) === null ? null : stagingPath(entry.id);
      if (old !== null) await rename(target, old);
      try {
        await rename(staging, target);
      } catch (error) {
        if (old !== null) await rename(old, target).catch(() => {});
        throw error;
      }
      // A failed removal stays for the next reconcile.
      if (old !== null) await rm(old, { recursive: true, force: true }).catch(() => {});
      changed.delete(entry.id);
    },

    // A failed removal stays for the next reconcile.
    discard: (staging: string): Promise<void> => rm(staging, { recursive: true, force: true }).catch(() => {}),

    // False: `<id>/` did not exist. A rejection is the `remove` failure.
    async remove(id: string): Promise<boolean> {
      const dir = join(folder, id);
      if ((await isFolder(dir)) === null) return false;
      await rm(dir, { recursive: true });
      return true;
    },
  };
}

export type DictionaryStore = ReturnType<typeof createDictionaryStore>;
