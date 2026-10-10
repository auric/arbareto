// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { COMMIT_MESSAGE_BYTES } from "../../contracts/limits";

// plan.md "Stored drafts", data-model §2 "Stored draft". No log, diagnostic, trace, or telemetry receives draft text.

export type DraftRecord = { worktreeKey: string; message: string; draftRevision: number; writtenAt: number };
/** `saved`: the transaction completed. `refused`: the text breaks the contract §5 bound, and the old record stays. */
export type StoreResult = "saved" | "refused" | "failed";

type Request<T> = { readonly result: T; onsuccess: (() => void) | null; onerror: (() => void) | null; readonly error: unknown };
type ObjectStore = {
  get(key: string): Request<DraftRecord | undefined>;
  count(): Request<number>;
  getAll(): Request<DraftRecord[]>;
  put(record: DraftRecord): Request<unknown>;
  delete(key: string): Request<unknown>;
};
type Transaction = { objectStore(name: string): ObjectStore; oncomplete: (() => void) | null; onabort: (() => void) | null; readonly error: unknown; abort(): void };
/** The part of `IDBDatabase` that the store uses. */
export type DraftDatabase = { transaction(store: string, mode: "readonly" | "readwrite", options?: { durability: "strict" }): Transaction };

const DATABASE = "arbareto-drafts";
const STORE = "drafts";
const RECORD_LIMIT = 256;
// Contract §5 commit message rule: Git 2.55.0 treats only U+0020, U+0009, U+000A, and U+000D as blank (src/contracts/envelope.ts).
const BLANK = /^[ \t\n\r]*$/;
const encoder = new TextEncoder();

/** Opens the one draft database of the page origin. */
export function openDraftDatabase(factory: IDBFactory): Promise<DraftDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "worktreeKey" });
    request.onsuccess = () => resolve(request.result as unknown as DraftDatabase);
    request.onerror = () => reject(request.error);
  });
}

const settle = <T>(request: Request<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

type Result = StoreResult | DraftRecord | null;
type Op = { kind: "put" | "delete" | "read"; key: string; message: string; revision: number | undefined; waiters: ((result: Result) => void)[] };

/**
 * Runs one operation at a time, in call order. A write for a key whose last queued operation is a write replaces that text.
 * So while a write runs, only the latest text follows, and at most the edits of the running write can be lost.
 */
export function createDraftStore(open: () => Promise<DraftDatabase> = () => openDraftDatabase(indexedDB), now: () => number = Date.now) {
  const queue: Op[] = [];
  let running = false;
  let database: Promise<DraftDatabase> | null = null;

  // Every request runs inside `body` after the transaction starts. Awaiting anything else there lets the transaction commit early.
  async function transact<T>(mode: "readonly" | "readwrite", body: (store: ObjectStore) => Promise<T>): Promise<T> {
    database ??= open();
    let tx: Transaction;
    try {
      tx = (await database).transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
    } catch (error) {
      // A failed open or a closed connection opens the database again for the next operation.
      database = null;
      throw error;
    }
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    done.catch(() => {});
    try {
      const result = await body(tx.objectStore(STORE));
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      throw error;
    }
  }

  async function run(op: Op): Promise<void> {
    try {
      if (op.kind === "read") {
        const record = await transact("readonly", (store) => settle(store.get(op.key)));
        for (const waiter of op.waiters) waiter(record ?? null);
        return;
      }
      await transact("readwrite", async (store) => {
        if (op.kind === "delete") {
          if (op.revision === undefined || (await settle(store.get(op.key)))?.draftRevision === op.revision) await settle(store.delete(op.key));
          return;
        }
        if ((await settle(store.get(op.key))) === undefined && (await settle(store.count())) >= RECORD_LIMIT) {
          // ponytail: reads all records only when a new key meets the limit; a `writtenAt` index avoids that if it shows in traces.
          const all = await settle(store.getAll());
          const oldest = all.reduce((a, b) => (b.writtenAt < a.writtenAt ? b : a));
          await settle(store.delete(oldest.worktreeKey));
        }
        await settle(store.put({ worktreeKey: op.key, message: op.message, draftRevision: op.revision!, writtenAt: now() }));
      });
      for (const waiter of op.waiters) waiter("saved");
    } catch {
      for (const waiter of op.waiters) waiter("failed");
    }
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    for (let op = queue.shift(); op; op = queue.shift()) await run(op);
    running = false;
  }

  function enqueue(kind: Op["kind"], key: string, message = "", revision?: number): Promise<Result> {
    return new Promise((resolve) => {
      const last = queue.findLast((op) => op.key === key);
      if (kind === "put" && last?.kind === "put") {
        Object.assign(last, { message, revision });
        last.waiters.push(resolve);
        return;
      }
      queue.push({ kind, key, message, revision, waiters: [resolve] });
      void drain();
    });
  }

  return {
    /** Blank text deletes the record. Text above 64 KiB of UTF-8 or with NUL is refused without a transaction. */
    write(worktreeKey: string, message: string, draftRevision: number): Promise<StoreResult> {
      if (message.includes("\u0000") || encoder.encode(message).length > COMMIT_MESSAGE_BYTES) return Promise.resolve("refused");
      return (BLANK.test(message) ? enqueue("delete", worktreeKey) : enqueue("put", worktreeKey, message, draftRevision)) as Promise<StoreResult>;
    },
    /** With a revision, deletes the record only while it holds that revision. */
    remove(worktreeKey: string, draftRevision?: number): Promise<StoreResult> {
      return enqueue("delete", worktreeKey, "", draftRevision) as Promise<StoreResult>;
    },
    /** Runs after every operation that started before it. */
    read(worktreeKey: string): Promise<DraftRecord | null | "failed"> {
      return enqueue("read", worktreeKey) as Promise<DraftRecord | null | "failed">;
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;
