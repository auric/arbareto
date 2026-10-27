// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { PERSONAL_WORD_CODE_POINTS, PERSONAL_WORDS } from "../../contracts/limits";

// 006 plan.md D10, data-model §9: the personal word list in the IndexedDB database of the WebView2 profile.

export type WordListState = { kind: "loading" } | { kind: "loaded"; words: readonly string[] } | { kind: "unreadable" } | { kind: "unavailable" };
/** `long`: the word is not NFC, or it has 0 or more than 100 code points. */
export type AddOutcome = "added" | "listed" | "full" | "long" | "unreadable" | "unavailable" | "failed";
export type RemoveOutcome = "removed" | "unreadable" | "unavailable" | "failed";
export type WordList = { read(): Promise<WordListState>; add(word: string): Promise<AddOutcome>; remove(word: string): Promise<RemoveOutcome> };

const DATABASE = "arbareto-spelling";
const STORE = "words";

/** Data-model §9: NFC, 1 to 100 code points. */
export function wordFits(word: unknown): word is string {
  if (typeof word !== "string" || word.normalize("NFC") !== word) return false;
  const points = [...word].length;
  return points >= 1 && points <= PERSONAL_WORD_CODE_POINTS;
}
const recordFits = (record: unknown) => typeof record === "object" && record !== null && Object.keys(record).length === 1 && wordFits((record as { word?: unknown }).word);

const settle = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "word" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs `body` in one transaction and resolves after `complete`. A request error or an abort rejects with that error. */
async function transact<T>(database: IDBDatabase, mode: IDBTransactionMode, body: (store: IDBObjectStore, tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = database.transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  done.catch(() => {});
  const result = await body(tx.objectStore(STORE), tx);
  await done;
  return result;
}

/** The first `read` decides the state. In `unreadable` and `unavailable`, no later call writes to the store. */
export function createWordList(factory: () => IDBFactory = () => indexedDB): WordList {
  let database: IDBDatabase | null = null;
  let first: Promise<WordListState> | null = null;

  async function read(): Promise<WordListState> {
    try {
      database ??= await open(factory());
    } catch {
      return { kind: "unavailable" };
    }
    try {
      const records = await transact(database, "readonly", (store) => settle(store.getAll(null, PERSONAL_WORDS + 1)));
      if (records.length > PERSONAL_WORDS || !records.every(recordFits)) return { kind: "unreadable" };
      return { kind: "loaded", words: records.map((record) => (record as { word: string }).word) };
    } catch {
      return { kind: "unreadable" };
    }
  }

  /** The database while the first read gave `loaded`, else that state. */
  async function writable(): Promise<IDBDatabase | "unreadable" | "unavailable"> {
    first ??= read();
    const state = await first;
    return state.kind === "unreadable" || state.kind === "unavailable" ? state.kind : database!;
  }

  return {
    read() {
      const next = read();
      first ??= next;
      return next;
    },
    async add(word) {
      const db = await writable();
      if (typeof db === "string") return db;
      if (!wordFits(word)) return "long";
      // `full` and `listed` end the transaction with an abort, so the outcome cannot come from the transaction error.
      let refused: "full" | "listed" | null = null;
      try {
        await transact(db, "readwrite", async (store, tx) => {
          if ((await settle(store.count())) >= PERSONAL_WORDS) {
            refused = "full";
            return tx.abort();
          }
          try {
            await settle(store.add({ word }));
          } catch (error) {
            // IndexedDB: `add` of an existing key fails with ConstraintError.
            if (error instanceof DOMException && error.name === "ConstraintError") refused = "listed";
            throw error;
          }
        });
        return "added";
      } catch {
        return refused ?? "failed";
      }
    },
    async remove(word) {
      const db = await writable();
      if (typeof db === "string") return db;
      try {
        await transact(db, "readwrite", (store) => settle(store.delete(word)));
        return "removed";
      } catch {
        return "failed";
      }
    },
  };
}
