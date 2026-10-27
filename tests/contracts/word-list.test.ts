// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";

// tasks.md T024. 006 data-model §9, plan.md D10, spec FR-006.
// Bun has no IndexedDB. The double copies the rules that the store uses: a request result arrives in a later task,
// a transaction publishes its writes on `complete` only, and a failed `add` request aborts its transaction.

printOrigin("../../src/frontend/spelling/word-list.ts", import.meta.dir);
const { createWordList } = await import("../../src/frontend/spelling/word-list");

type Req = { result: unknown; error: unknown; onsuccess: ((event: unknown) => void) | null; onerror: ((event: { preventDefault(): void }) => void) | null; onupgradeneeded?: (() => void) | null };
type Tx = { mode: string; options: unknown; ops: string[] };

function idbDouble(fields: { seed?: readonly unknown[]; failOpen?: boolean; failRead?: boolean; failCommit?: boolean } = {}) {
  const records = new Map<unknown, unknown>((fields.seed ?? []).map((record, i) => [(record as { word?: unknown })?.word ?? i, record]));
  const opens: { name: string; version: number }[] = [];
  const stores: { name: string; keyPath: unknown }[] = [];
  const transactions: Tx[] = [];
  let created = false;
  const later = (run: () => void) => setTimeout(run, 0);
  const database = {
    createObjectStore(name: string, options: { keyPath: unknown }) {
      stores.push({ name, keyPath: options.keyPath });
      created = true;
    },
    transaction(_store: string, mode: string, options?: unknown) {
      const log: Tx = { mode, options, ops: [] };
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
          later(() => tx.onabort?.());
        },
        objectStore: () => store,
      };
      const finish = () => {
        if (open > 0 || finished) return;
        finished = true;
        if (fields.failCommit && mode === "readwrite") {
          tx.error = new DOMException("quota", "QuotaExceededError");
          tx.onabort?.();
          return;
        }
        records.clear();
        for (const [key, value] of working) records.set(key, value);
        tx.oncomplete?.();
      };
      const request = (op: string, run: () => unknown, fail?: () => DOMException | null): Req => {
        log.ops.push(op);
        const r: Req = { result: undefined, error: null, onsuccess: null, onerror: null };
        open++;
        later(() => {
          open--;
          const error = fail?.() ?? null;
          if (error !== null) {
            r.error = error;
            let prevented = false;
            r.onerror?.({ preventDefault: () => void (prevented = true) });
            if (!prevented && !finished) {
              finished = true;
              tx.error = error;
              later(() => tx.onabort?.());
            }
            return;
          }
          r.result = run();
          r.onsuccess?.({});
          later(finish);
        });
        return r;
      };
      const store = {
        count: () => request("count", () => working.size),
        getAll: (query: unknown, count?: number) =>
          request(`getAll:${String(query)}:${count}`, () => [...working.values()].slice(0, count), () => (fields.failRead ? new DOMException("read", "UnknownError") : null)),
        add: (record: { word: string }) =>
          request(`add:${record.word}`, () => (working.set(record.word, structuredClone(record)), record.word), () => (working.has(record.word) ? new DOMException("exists", "ConstraintError") : null)),
        put: (record: { word: string }) => request(`put:${record.word}`, () => working.set(record.word, record)),
        delete: (key: string) => request(`delete:${key}`, () => void working.delete(key)),
      };
      later(finish);
      return tx;
    },
  };
  const factory = {
    open(name: string, version: number) {
      opens.push({ name, version });
      const r: Req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        if (fields.failOpen) {
          r.error = new DOMException("open", "UnknownError");
          r.onerror?.({ preventDefault() {} });
          return;
        }
        r.result = database;
        if (!created) r.onupgradeneeded?.();
        r.onsuccess?.({});
      });
      return r;
    },
  } as unknown as IDBFactory;
  const writes = () => transactions.filter((t) => t.mode === "readwrite");
  return { factory, records, opens, stores, transactions, writes };
}

const words = (n: number) => Array.from({ length: n }, (_, i) => ({ word: `w${i}` }));
const listOver = (double: ReturnType<typeof idbDouble>) => createWordList(() => double.factory);

describe("personal word list storage", () => {
  test("it opens the database arbareto-spelling version 1 with the store words and the key path word", async () => {
    const double = idbDouble();
    expect(await listOver(double).read()).toEqual({ kind: "loaded", words: [] });
    expect(double.opens).toEqual([{ name: "arbareto-spelling", version: 1 }]);
    expect(double.stores).toEqual([{ name: "words", keyPath: "word" }]);
  });

  test("a read asks for at most 10,001 records and gives the listed words", async () => {
    const double = idbDouble({ seed: [{ word: "kubectl" }, { word: "iPhone" }] });
    expect(await listOver(double).read()).toEqual({ kind: "loaded", words: ["kubectl", "iPhone"] });
    expect(double.transactions.map((t) => [t.mode, t.ops])).toEqual([["readonly", ["getAll:null:10001"]]]);
  });

  test("Add is one readwrite transaction with durability strict: count, then add of the record {word}, and never put", async () => {
    const double = idbDouble();
    const list = listOver(double);
    await list.read();
    expect(await list.add("kubectl")).toBe("added");
    expect(double.writes().map((t) => [t.options, t.ops])).toEqual([[{ durability: "strict" }, ["count", "add:kubectl"]]]);
    expect([...double.records.values()]).toEqual([{ word: "kubectl" }]);
  });

  test("Add of a listed word gives listed through ConstraintError, and the record stays", async () => {
    const double = idbDouble({ seed: [{ word: "kubectl" }] });
    const list = listOver(double);
    await list.read();
    expect(await list.add("kubectl")).toBe("listed");
    expect(double.writes().flatMap((t) => t.ops)).toEqual(["count", "add:kubectl"]);
    expect([...double.records.values()]).toEqual([{ word: "kubectl" }]);
  });

  test("Add at 10,000 records is refused after count, with no add", async () => {
    const double = idbDouble({ seed: words(10_000) });
    const list = listOver(double);
    expect((await list.read()).kind).toBe("loaded");
    expect(await list.add("kubectl")).toBe("full");
    expect(double.writes().flatMap((t) => t.ops)).toEqual(["count"]);
    expect(double.records.size).toBe(10_000);
  });

  test("Add of a word above 100 code points, or of a word that is not NFC, starts no transaction", async () => {
    const double = idbDouble();
    const list = listOver(double);
    await list.read();
    expect(await list.add("𝒜".repeat(101))).toBe("long");
    expect(await list.add("é")).toBe("long");
    expect(await list.add("𝒜".repeat(100))).toBe("added");
    expect(double.writes().length).toBe(1);
  });

  test("Remove deletes one key", async () => {
    const double = idbDouble({ seed: [{ word: "kubectl" }, { word: "iPhone" }] });
    const list = listOver(double);
    await list.read();
    expect(await list.remove("kubectl")).toBe("removed");
    expect(double.writes().map((t) => t.ops)).toEqual([["delete:kubectl"]]);
    expect([...double.records.keys()]).toEqual(["iPhone"]);
  });

  test("a failed commit gives failed", async () => {
    const double = idbDouble({ failCommit: true });
    const list = listOver(double);
    await list.read();
    expect(await list.add("kubectl")).toBe("failed");
    expect(double.records.size).toBe(0);
  });

  for (const [name, fields] of [
    ["more than 10,000 records", { seed: words(10_001) }],
    ["a record above 100 code points", { seed: [{ word: "a".repeat(101) }] }],
    ["an empty word", { seed: [{ word: "" }] }],
    ["a record that is not NFC", { seed: [{ word: "é" }] }],
    ["a record with another field", { seed: [{ word: "kubectl", note: 1 }] }],
    ["a record whose word is no string", { seed: [{ word: 7 }] }],
    ["a read error", { failRead: true }],
  ] as const) {
    test(`${name} gives unreadable, and then no write reaches the store`, async () => {
      const double = idbDouble(fields);
      const list = listOver(double);
      expect(await list.read()).toEqual({ kind: "unreadable" });
      expect(await list.add("kubectl")).toBe("unreadable");
      expect(await list.remove("kubectl")).toBe("unreadable");
      expect(double.writes()).toEqual([]);
    });
  }

  test("a failed open gives unavailable, and then no write starts", async () => {
    const double = idbDouble({ failOpen: true });
    const list = listOver(double);
    expect(await list.read()).toEqual({ kind: "unavailable" });
    expect(await list.add("kubectl")).toBe("unavailable");
    expect(await list.remove("kubectl")).toBe("unavailable");
    expect(double.transactions).toEqual([]);
  });

  test("a factory that throws gives unavailable", async () => {
    const list = createWordList(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(await list.read()).toEqual({ kind: "unavailable" });
  });

  test("Add before the first read waits for that read, so an unreadable list gets no write", async () => {
    const double = idbDouble({ seed: words(10_001) });
    const list = listOver(double);
    expect(await list.add("kubectl")).toBe("unreadable");
    expect(double.writes()).toEqual([]);
  });
});
