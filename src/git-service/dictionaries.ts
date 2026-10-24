// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// 006 contract Δ3 and plan.md D2, D4, D6, D7: the five dictionary operations. They name no repository, run no Git process, and take no read slot.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import type { Catalog } from "../contracts/dictionaries";
import type { ServiceRequest } from "../contracts/envelope";
import type { DictionaryUnavailableReason, ErrorCode } from "../contracts/errors";
import { DICTIONARY_CHUNK_BYTES, DICTIONARY_DOWNLOAD_DEADLINE_MS, DICTIONARY_PROGRESS_EVENTS_PER_SECOND, READ_DEADLINE_MS, SPELLING_LANGUAGES } from "../contracts/limits";
import { createDictionaryStore, errnoOf, readBounded, sha256 } from "./dictionary-store";
import type { OperationRegistry } from "./operations";

type Entry = Catalog["entries"][number];
type Request<K extends string> = Extract<ServiceRequest, { operation: K }>;
type Refusal = { reason: DictionaryUnavailableReason; status?: number; folder?: string };
type Outcome = { value: unknown } | { refusal: Refusal };

// Bun `fetch` with its own request options (plan.md D4 step 2).
export type DictionaryFetch = (url: string, init: RequestInit & { proxy: false; tls: { rejectUnauthorized: true; ca: readonly string[] } }) => Promise<Response>;
// Starts one deadline timer and returns its clear function.
export type DictionaryTimer = (ms: number, fire: () => void) => () => void;

export interface DictionaryOptions {
  folder: string;
  catalog: Catalog;
  registry: OperationRegistry;
  reject(requestId: string, code: ErrorCode): void;
  fetch?: DictionaryFetch;
  timer?: DictionaryTimer;
  readDeadlineMs?: number;
}

const PROGRESS_INTERVAL_MS = 1000 / DICTIONARY_PROGRESS_EVENTS_PER_SECOND;
const realTimer: DictionaryTimer = (ms, fire) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};
const refuse = (reason: DictionaryUnavailableReason, extra: Omit<Refusal, "reason"> = {}): Outcome => ({ refusal: { reason, ...extra } });

// Contract Δ3 status rule. No message text decides a reason.
function statusRefusal(status: number): Outcome {
  if (status >= 300 && status <= 399) return refuse("redirect");
  if (status === 404) return refuse("http-not-found");
  if (status === 429) return refuse("http-rate-limit");
  return refuse("http-status", { status });
}

export function createDictionaries({ folder, catalog, registry, reject, fetch: fetchFile = (url, init) => fetch(url, init), timer = realTimer, readDeadlineMs = READ_DEADLINE_MS }: DictionaryOptions) {
  const store = createDictionaryStore(folder, catalog);
  let running: { id: string; kind: "downloading" | "importing" } | null = null;
  let reads = 0;

  // Plan.md D2: the registry operation, its deadline flag, and Cancel. The flags decide DEADLINE and CANCELED, never an error object.
  // The response follows the end of `work`, so the staging folder is gone before it.
  function run(operation: ServiceRequest["operation"], requestId: string, deadlineMs: number, work: (o: { operationId: string; signal: AbortSignal }) => Promise<Outcome>, fallback: Refusal | null, done?: () => void): void {
    const { operationId, signal } = registry.start(operation, requestId);
    registry.apply(operationId, { type: "valid-read" });
    const stop = new AbortController();
    let deadline = false;
    const abort = () => stop.abort();
    signal.addEventListener("abort", abort, { once: true });
    const clear = timer(deadlineMs, () => {
      deadline = true;
      stop.abort();
    });
    const end = (outcome: Outcome) => {
      clear();
      signal.removeEventListener("abort", abort);
      done?.();
      if (deadline) return void registry.apply(operationId, { type: "read-deadline" });
      if (registry.get(operationId)?.state === "cancel-requested") return void registry.apply(operationId, { type: "processes-stopped" });
      if ("value" in outcome) return void registry.apply(operationId, { type: "read-complete", result: "succeeded" }, outcome.value);
      registry.apply(operationId, { type: "read-complete", result: "failed", code: "DICTIONARY_UNAVAILABLE" }, outcome.refusal);
    };
    work({ operationId, signal: stop.signal }).then(end, (error: unknown) => {
      if (fallback === null) throw error;
      end({ refusal: fallback });
    });
  }

  const entryOf = (request: { requestId: string; payload: { language: string } }): Entry | null => {
    const entry = store.entry(request.payload.language);
    if (entry === undefined) reject(request.requestId, "INVALID_REQUEST");
    return entry ?? null;
  };

  // Plan.md D2: one run holds the lock. A second run gets `busy` before any byte moves.
  async function locked(entry: Entry, kind: "downloading" | "importing", signal: AbortSignal, steps: (staging: string) => Promise<Outcome>): Promise<Outcome> {
    await store.reconcile();
    if (running !== null) return refuse("busy");
    running = { id: entry.id, kind };
    const save = refuse("save", { folder: store.folderOf(entry.id) });
    let staging: string | null = null;
    try {
      try {
        staging = await store.stage(entry.id);
      } catch {
        return save;
      }
      const outcome = await steps(staging);
      if ("refusal" in outcome || signal.aborted) return outcome;
      try {
        await store.install(staging, entry);
      } catch {
        return save;
      }
      staging = null;
      return { value: { language: entry.id, state: "ready" } };
    } finally {
      if (staging !== null) await store.discard(staging);
      running = null;
    }
  }

  // Plan.md D4 step 4: the decoded bytes count. At most `size` bytes stay, and byte `size + 1` cancels the stream.
  async function body(response: Response, size: number, received: (n: number) => void): Promise<Uint8Array | "mismatch" | "transport"> {
    if (response.body === null) return "mismatch";
    const reader = response.body.getReader();
    const out = new Uint8Array(size);
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > size) {
          received(size - n);
          reader.cancel().catch(() => {});
          return "mismatch";
        }
        out.set(value, n);
        n += value.length;
        received(value.length);
      }
    } catch {
      // The run's own flags decide Cancel and the deadline (plan.md D2).
      return "transport";
    }
    return n === size ? out : "mismatch";
  }

  const download = (request: Request<"downloadDictionary">) => {
    const entry = entryOf(request);
    if (entry === null) return;
    const total = entry.files.reduce((sum, f) => sum + f.size, 0);
    run(
      "downloadDictionary",
      request.requestId,
      DICTIONARY_DOWNLOAD_DEADLINE_MS,
      ({ operationId, signal }) =>
        locked(entry, "downloading", signal, async (staging) => {
          // Plan.md D4 step 1: the check of every file comes before any request.
          if (entry.files.some((f) => new URL(f.url).protocol !== "https:")) return refuse("not-https");
          let received = 0;
          let last = -Infinity;
          const progress = (n: number) => {
            received += n;
            const now = performance.now();
            if (signal.aborted || now - last < PROGRESS_INTERVAL_MS) return;
            last = now;
            registry.progress(operationId, "dictionary", { received, total });
          };
          for (const file of entry.files) {
            let response: Response;
            try {
              response = await fetchFile(file.url, { redirect: "manual", proxy: false, tls: { rejectUnauthorized: true, ca: rootCertificates }, signal, keepalive: false });
            } catch {
              return refuse("transport");
            }
            if (response.status !== 200) {
              response.body?.cancel().catch(() => {});
              return statusRefusal(response.status);
            }
            const bytes = await body(response, file.size, progress);
            if (typeof bytes === "string") return refuse(bytes);
            if (sha256(bytes) !== file.sha256) return refuse("mismatch");
            try {
              await store.writeFile(staging, file.name, bytes);
            } catch {
              return refuse("save", { folder: store.folderOf(entry.id) });
            }
          }
          return { value: null };
        }),
      { reason: "save", folder: store.folderOf(entry.id) },
    );
  };

  const importDictionary = (request: Request<"importDictionary">) => {
    const entry = entryOf(request);
    if (entry === null) return;
    const { folder: picked } = request.payload;
    run(
      "importDictionary",
      request.requestId,
      DICTIONARY_DOWNLOAD_DEADLINE_MS,
      ({ signal }) =>
        locked(entry, "importing", signal, async (staging) => {
          for (const file of entry.files) {
            const path = join(picked, file.name);
            let bytes: Uint8Array;
            try {
              const st = await stat(path);
              if (!st.isFile() || st.size !== file.size) return refuse("import-mismatch");
              bytes = await readBounded(path, file.size + 1, signal);
            } catch (error) {
              // Plan.md D6: ENOENT is a missing file. Any other read error names the picked folder.
              return errnoOf(error) === "ENOENT" ? refuse("import-mismatch") : refuse("import-unreadable", { folder: picked });
            }
            if (bytes.length !== file.size || sha256(bytes) !== file.sha256) return refuse("import-mismatch");
            try {
              await store.writeFile(staging, file.name, bytes);
            } catch {
              return refuse("save", { folder: store.folderOf(entry.id) });
            }
          }
          return { value: null };
        }),
      { reason: "save", folder: store.folderOf(entry.id) },
    );
  };

  const read = (request: Request<"readDictionary">) => {
    const entry = entryOf(request);
    if (entry === null) return;
    const { file: name, offset } = request.payload;
    const file = entry.files.find((f) => f.name === name);
    if (file === undefined || offset >= file.size) return reject(request.requestId, "INVALID_REQUEST");
    // Contract Δ3: at most SPELLING_LANGUAGES calls at the same time.
    if (reads >= SPELLING_LANGUAGES) return reject(request.requestId, "BUSY");
    reads += 1;
    run(
      "readDictionary",
      request.requestId,
      readDeadlineMs,
      async ({ signal }) => {
        await store.reconcile();
        if (signal.aborted) return refuse("changed");
        const bytes = await store.fileBytes(entry, file);
        if (typeof bytes === "string") return refuse(bytes);
        const chunk = bytes.subarray(offset, offset + DICTIONARY_CHUNK_BYTES);
        return { value: { language: entry.id, file: name, size: file.size, offset, bytes: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64") } };
      },
      { reason: "changed" },
      () => (reads -= 1),
    );
  };

  const list = (request: Request<"listDictionaries">) =>
    run(
      "listDictionaries",
      request.requestId,
      readDeadlineMs,
      async ({ signal }) => {
        await store.reconcile();
        const languages = [];
        // One language at a time, so at most one language's files are in memory.
        for (const entry of catalog.entries) {
          if (signal.aborted) break;
          const state = running?.id === entry.id ? running.kind : await store.languageState(entry);
          languages.push({ language: entry.id, state, ...store.notices(entry.id) });
        }
        return { value: { languages, ...store.removedNotices() } };
      },
      null,
    );

  const remove = (request: Request<"removeDictionary">) => {
    const entry = entryOf(request);
    if (entry === null) return;
    run(
      "removeDictionary",
      request.requestId,
      readDeadlineMs,
      async ({ signal }) => {
        await store.reconcile();
        if (running?.id === entry.id) return refuse("busy");
        if (signal.aborted) return refuse("remove", { folder: store.folderOf(entry.id) });
        try {
          return { value: { language: entry.id, removed: await store.remove(entry.id) } };
        } catch {
          return refuse("remove", { folder: store.folderOf(entry.id) });
        }
      },
      { reason: "remove", folder: store.folderOf(entry.id) },
    );
  };

  return { listDictionaries: list, readDictionary: read, downloadDictionary: download, importDictionary, removeDictionary: remove };
}
