// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { printOrigin } from "../origin";
import type { DraftDatabase, DraftRecord } from "../../src/frontend/state/draft-store";

printOrigin("../../src/frontend/state/draft-store.ts", import.meta.dir);
const { createDraftStore } = await import("../../src/frontend/state/draft-store");

// plan.md "Stored drafts", data-model §2 "Stored draft". Bun has no IndexedDB, so the double copies its transaction rules:
// a request result arrives in a later task, and a transaction completes when no request is open after its last result.
// A transaction works on a copy of the records and publishes it only on `complete`, so a record is whole or absent.
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KIB = 1024;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}

type Request = { result: unknown; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null };
type Transaction = { mode: string; options: unknown; puts: DraftRecord[]; deletes: string[] };

function databaseDouble(seed: DraftRecord[] = []) {
  const records = new Map(seed.map((record) => [record.worktreeKey, record]));
  const transactions: Transaction[] = [];
  const held: (() => void)[] = [];
  const state = { hold: false, fail: false };
  const database: DraftDatabase = {
    transaction(_store, mode, options) {
      const log: Transaction = { mode, options, puts: [], deletes: [] };
      transactions.push(log);
      const working = new Map(records);
      let open = 0;
      let finished = false;
      const tx = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        error: null as unknown,
        abort() {
          if (finished) throw new DOMException("finished", "InvalidStateError");
          finished = true;
          tx.error = new DOMException("aborted", "AbortError");
          setTimeout(() => tx.onabort?.());
        },
        objectStore: () => store,
      };
      const finish = () => {
        if (open > 0 || finished) return;
        finished = true;
        const end = () => {
          if (state.fail) {
            tx.error = new DOMException("quota", "QuotaExceededError");
            tx.onabort?.();
            return;
          }
          records.clear();
          for (const [key, value] of working) records.set(key, value);
          tx.oncomplete?.();
        };
        if (state.hold) held.push(end);
        else end();
      };
      const request = (run: () => unknown): Request => {
        const r: Request = { result: undefined, error: null, onsuccess: null, onerror: null };
        open++;
        setTimeout(() => {
          r.result = run();
          open--;
          r.onsuccess?.();
          setTimeout(finish);
        });
        return r;
      };
      const store = {
        get: (key: string) => request(() => working.get(key)),
        count: () => request(() => working.size),
        getAll: () => request(() => [...working.keys()].sort().map((key) => working.get(key))),
        put: (record: DraftRecord) => request(() => (log.puts.push(structuredClone(record)), working.set(record.worktreeKey, structuredClone(record)), record.worktreeKey)),
        delete: (key: string) => request(() => (log.deletes.push(key), working.delete(key), undefined)),
      };
      setTimeout(finish);
      return tx as never;
    },
  };
  const release = () => {
    state.hold = false;
    for (const end of held.splice(0)) end();
  };
  return { database, records, transactions, state, release };
}

function storeOver(double: ReturnType<typeof databaseDouble>, now = () => 1_000) {
  return createDraftStore(() => Promise.resolve(double.database), now);
}

describe("draft store writes", () => {
  test("a write stores the key, the text, the revision, and the time as one record", async () => {
    const double = databaseDouble();
    const result = await storeOver(double, () => 1_234).write(KEY_A, "Fix the parser", 3);
    expect(result).toBe("saved");
    expect([...double.records.values()]).toEqual([{ worktreeKey: KEY_A, message: "Fix the parser", draftRevision: 3, writtenAt: 1_234 }]);
    expect(double.transactions.map((t) => t.puts.length)).toEqual([1]);
  });

  test("each write asks for a readwrite transaction with durability strict", async () => {
    const double = databaseDouble();
    const store = storeOver(double);
    await store.write(KEY_A, "one", 1);
    await store.write(KEY_B, "two", 1);
    await store.write(KEY_A, " ", 2);
    await store.remove(KEY_B);
    expect(double.transactions.length).toBe(4);
    for (const t of double.transactions) expect([t.mode, t.options]).toEqual(["readwrite", { durability: "strict" }]);
  });

  test("the record of each key is written separately", async () => {
    const double = databaseDouble();
    const store = storeOver(double);
    await Promise.all([store.write(KEY_A, "first", 1), store.write(KEY_B, "second", 1)]);
    expect(double.records.get(KEY_A)?.message).toBe("first");
    expect(double.records.get(KEY_B)?.message).toBe("second");
  });

  test("while a write runs, later writes wait, and only the latest text follows", async () => {
    const double = databaseDouble();
    const store = storeOver(double);
    double.state.hold = true;
    const results = [store.write(KEY_A, "a", 1)];
    await settle();
    results.push(store.write(KEY_A, "ab", 2), store.write(KEY_A, "abc", 3));
    await settle();
    expect(double.transactions.length).toBe(1);
    double.release();
    expect(await Promise.all(results)).toEqual(["saved", "saved", "saved"]);
    expect(double.transactions.flatMap((t) => t.puts.map((p) => p.message))).toEqual(["a", "abc"]);
    expect(double.records.get(KEY_A)).toMatchObject({ message: "abc", draftRevision: 3 });
  });

  test("a delete that waits behind a write keeps its order, so the record stays deleted", async () => {
    const double = databaseDouble();
    const store = storeOver(double);
    double.state.hold = true;
    const write = store.write(KEY_A, "a", 1);
    await settle();
    const later = [store.write(KEY_A, "ab", 2), store.remove(KEY_A)];
    double.release();
    expect(await Promise.all([write, ...later])).toEqual(["saved", "saved", "saved"]);
    expect(double.records.has(KEY_A)).toBe(false);
  });

  test("text above 64 KiB or with NUL is refused, and the old record stays", async () => {
    const old = { worktreeKey: KEY_A, message: "old", draftRevision: 1, writtenAt: 5 };
    const double = databaseDouble([old]);
    const store = storeOver(double);
    // U+00E9 takes 2 UTF-8 bytes, so 32 KiB of it plus one byte passes the bound with fewer code units.
    for (const text of ["x".repeat(64 * KIB + 1), "é".repeat(32 * KIB) + "x", "a\u0000b"]) {
      expect(await store.write(KEY_A, text, 2)).toBe("refused");
    }
    expect(double.transactions).toEqual([]);
    expect(double.records.get(KEY_A)).toEqual(old);
  });

  test("text of exactly 64 KiB of UTF-8 is stored", async () => {
    const double = databaseDouble();
    const text = "é".repeat(32 * KIB);
    expect(await storeOver(double).write(KEY_A, text, 1)).toBe("saved");
    expect(double.records.get(KEY_A)?.message).toBe(text);
  });

  test("blank text deletes the record", async () => {
    // The contract §5 blank rule: only U+0020, U+0009, U+000A, and U+000D. Git commits a message of U+00A0 or U+3000.
    for (const blank of ["", " ", "\t\r\n "]) {
      const double = databaseDouble([{ worktreeKey: KEY_A, message: "old", draftRevision: 1, writtenAt: 5 }]);
      expect(await storeOver(double).write(KEY_A, blank, 2)).toBe("saved");
      expect(double.records.has(KEY_A)).toBe(false);
      expect(double.transactions.flatMap((t) => t.puts)).toEqual([]);
    }
    for (const text of [" ", "　", "\u000b"]) {
      const double = databaseDouble();
      await storeOver(double).write(KEY_A, text, 1);
      expect(double.records.get(KEY_A)?.message).toBe(text);
    }
  });

  test("a 257th key deletes the record with the oldest write time", async () => {
    const seed = Array.from({ length: 256 }, (_, i) => ({ worktreeKey: i.toString(16).padStart(64, "0"), message: `m${i}`, draftRevision: 1, writtenAt: 10_000 - i }));
    const oldest = seed[255]!.worktreeKey;
    const double = databaseDouble(seed);
    const store = storeOver(double, () => 20_000);
    expect(await store.write(KEY_A, "new", 1)).toBe("saved");
    expect(double.records.size).toBe(256);
    expect(double.records.has(oldest)).toBe(false);
    expect(double.records.get(KEY_A)?.message).toBe("new");
    // A write for a key that already has a record deletes nothing.
    expect(await store.write(KEY_A, "newer", 2)).toBe("saved");
    expect(double.records.size).toBe(256);
    expect(double.transactions.flatMap((t) => t.deletes)).toEqual([oldest]);
  });

  test("a failed transaction reports a failure and throws nothing", async () => {
    const double = databaseDouble([{ worktreeKey: KEY_A, message: "old", draftRevision: 1, writtenAt: 5 }]);
    const store = storeOver(double);
    double.state.fail = true;
    expect(await store.write(KEY_A, "new", 2)).toBe("failed");
    expect(await store.remove(KEY_A)).toBe("failed");
    expect(await store.read(KEY_A)).toBe("failed");
    expect(double.records.get(KEY_A)?.message).toBe("old");
    double.state.fail = false;
    expect(await store.write(KEY_A, "new", 2)).toBe("saved");
  });

  test("a database that does not open reports a failure and throws nothing", async () => {
    const store = createDraftStore(() => Promise.reject(new DOMException("blocked", "UnknownError")));
    expect(await store.write(KEY_A, "text", 1)).toBe("failed");
    expect(await store.remove(KEY_A, 1)).toBe("failed");
    expect(await store.read(KEY_A)).toBe("failed");
  });

  test("a transaction that cannot start reports a failure and throws nothing", async () => {
    const database: DraftDatabase = {
      transaction() {
        throw new DOMException("closing", "InvalidStateError");
      },
    };
    const store = createDraftStore(() => Promise.resolve(database));
    expect(await store.write(KEY_A, "text", 1)).toBe("failed");
  });
});

describe("draft store deletes and reads", () => {
  const record = { worktreeKey: KEY_A, message: "submitted", draftRevision: 4, writtenAt: 5 };

  test("a delete with another revision keeps the record", async () => {
    const double = databaseDouble([record]);
    expect(await storeOver(double).remove(KEY_A, 3)).toBe("saved");
    expect(double.records.get(KEY_A)).toEqual(record);
  });

  test("a delete with the stored revision deletes the record", async () => {
    const double = databaseDouble([record]);
    expect(await storeOver(double).remove(KEY_A, 4)).toBe("saved");
    expect(double.records.has(KEY_A)).toBe(false);
  });

  test("a delete without a revision deletes the record", async () => {
    const double = databaseDouble([record]);
    await storeOver(double).remove(KEY_A);
    expect(double.records.has(KEY_A)).toBe(false);
  });

  test("a read returns the record of the key, or null", async () => {
    const double = databaseDouble([record]);
    const store = storeOver(double);
    expect(await store.read(KEY_A)).toEqual(record);
    expect(await store.read(KEY_B)).toBeNull();
    expect(double.transactions.map((t) => t.mode)).toEqual(["readonly", "readonly"]);
  });

  test("a read waits for the writes that started before it", async () => {
    const double = databaseDouble([record]);
    const store = storeOver(double);
    double.state.hold = true;
    void store.write(KEY_A, "later", 5);
    await settle();
    const read = store.read(KEY_A);
    double.release();
    expect(await read).toMatchObject({ message: "later", draftRevision: 5 });
  });
});

describe("draft store logging", () => {
  const spies: ReturnType<typeof spyOn>[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("no log or console call receives the text", async () => {
    for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) spies.push(spyOn(console, name).mockImplementation(() => {}));
    const secret = "draft-canary-7f3e";
    const double = databaseDouble();
    const store = storeOver(double);
    await store.write(KEY_A, secret, 1);
    await store.write(KEY_A, `${secret}\u0000`, 2);
    await store.write(KEY_A, secret.repeat(5_000), 3);
    double.state.fail = true;
    await store.write(KEY_A, `${secret}!`, 4);
    await store.read(KEY_A);
    await createDraftStore(() => Promise.reject(new Error(secret))).write(KEY_A, secret, 1);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain("canary");
  });
});
