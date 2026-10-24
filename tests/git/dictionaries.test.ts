// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T019: the service dictionary operations (006 contract Δ3, Δ5, Δ9; data-model §3 to §7; plan.md D2, D4 to D7; quickstart.md Q14 to Q19).
// No case uses the network. Each case injects `fetch` and owns its dictionary folder.

import { describe, expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import catalogFile from "../../src/contracts/dictionaries.json";
import { Catalog, type CatalogEntry } from "../../src/contracts/dictionaries";
import { DICTIONARY_CHUNK_BYTES, DICTIONARY_DOWNLOAD_DEADLINE_MS, DICTIONARY_MANIFEST_BYTES, READ_DEADLINE_MS } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { fixtureDir, useFixtureRoot } from "./fixture-root";
import { buildF01 } from "./fixtures";
import { approve, commit, gitPath, outcome, readOk, repoOf, reviewOk, SUCCEEDED, until } from "./hunk-harness";
import { caseTest, openService, type Capability, type OpenOptions, type Service, type ServiceResponse } from "./service-harness";

printOrigin("../../src/git-service/dictionaries.ts", import.meta.dir);
printOrigin("../../src/git-service/dictionary-store.ts", import.meta.dir);

const TASK = "T019";
const SHELL: Capability[] = ["shell-double"];
const TIMEOUT_MS = 120_000;

useFixtureRoot();

// ---- Synthetic catalog ----

const real = Catalog.parse(catalogFile);
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();

function content(id: string, name: string, size: number): Uint8Array {
  const seed = encoder.encode(`${id}/${name} `);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = seed[i % seed.length]! ^ ((i >> 10) & 0x0f);
  return out;
}

interface Language {
  entry: CatalogEntry;
  bytes: Record<string, Uint8Array>;
}

function language(id: string, name: string, dicSize = 5_000): Language {
  const sizes: [string, number][] = [["index.aff", 300], ["index.dic", dicSize], ["license", 120]];
  const bytes: Record<string, Uint8Array> = {};
  const files = sizes.map(([file, size]) => {
    bytes[file] = content(id, file, size);
    return { name: file as "index.aff", url: `${real.source.urlPrefix}${id}/${file}`, size, sha256: sha256(bytes[file]!) };
  });
  return { entry: { id, name, license: "MIT", commit: real.source.commit, files, licences: ["license"] }, bytes };
}

const NL = language("nl", "Dutch");
const FR = language("fr", "French");
// Three read chunks: 1 MiB, 1 MiB, and the rest.
const DE = language("de", "German", 2 * DICTIONARY_CHUNK_BYTES + 402_848);
const UK = language("uk", "Ukrainian");
const LANGUAGES = [NL, FR, DE, UK];
const CATALOG: Catalog = Catalog.parse({ version: 1, source: real.source, bundled: real.bundled, entries: LANGUAGES.map((l) => l.entry) });
const BYTES = new Map(LANGUAGES.flatMap((l) => l.entry.files.map((f) => [f.url, l.bytes[f.name]!] as const)));
const urlOf = (l: Language, file: string) => l.entry.files.find((f) => f.name === file)!.url;

// ---- Fetch double ----

type FetchInit = RequestInit & { proxy?: unknown; tls?: unknown };
type Reply = (url: string, init: FetchInit) => Response | Promise<Response>;
interface FetchDouble {
  fetch: NonNullable<OpenOptions["fetch"]>;
  calls: { url: string; init: FetchInit }[];
}

function fetchDouble(reply: Reply = (url, init) => ok(BYTES.get(url) ?? new Uint8Array(), init)): FetchDouble {
  const calls: FetchDouble["calls"] = [];
  const fetch = ((input: unknown, init: FetchInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve().then(() => reply(url, init));
  }) as unknown as FetchDouble["fetch"];
  return { fetch, calls };
}

interface StreamOptions {
  chunk?: number;
  delayMs?: number;
  hold?: Promise<unknown>;
  // The bytes that the stream gave, and whether the reader canceled it.
  pulled?: { bytes: number; canceled: boolean };
  error?: Error;
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

// A body that ends with an AbortError when the request signal aborts, as Bun fetch does (research R13 F5).
function stream(bytes: Uint8Array, signal: AbortSignal | null | undefined, o: StreamOptions = {}): ReadableStream<Uint8Array> {
  let at = 0;
  const chunk = o.chunk ?? 65_536;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        try {
          controller.error(abortError());
        } catch {}
      }, { once: true });
    },
    async pull(controller) {
      if (o.hold !== undefined) await o.hold;
      if (o.delayMs !== undefined) await Bun.sleep(o.delayMs);
      if (signal?.aborted) return;
      if (at >= bytes.length) {
        if (o.error !== undefined) return controller.error(o.error);
        return controller.close();
      }
      const part = bytes.slice(at, at + chunk);
      at += part.length;
      if (o.pulled) o.pulled.bytes += part.length;
      controller.enqueue(part);
    },
    cancel() {
      if (o.pulled) o.pulled.canceled = true;
    },
  });
}

const ok = (bytes: Uint8Array, init: FetchInit, o?: StreamOptions) => new Response(stream(bytes, init.signal, o), { status: 200 });
// A request that never answers. It rejects with an AbortError when its signal aborts.
const hanging = (init: FetchInit) =>
  new Promise<Response>((_, reject) => {
    if (init.signal?.aborted) return reject(abortError());
    init.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// The fake clock of the dictionary deadlines.
function fakeClock() {
  const timers: { ms: number; fire: () => void; cleared: boolean }[] = [];
  return {
    timers,
    timer: (ms: number, fire: () => void) => {
      const t = { ms, fire, cleared: false };
      timers.push(t);
      return () => void (t.cleared = true);
    },
    fire(ms: number) {
      const t = timers.find((x) => x.ms === ms && !x.cleared);
      if (t === undefined) throw new Error(`no running timer of ${ms} ms`);
      t.fire();
    },
  };
}

// ---- Service ----

interface Fixture {
  service: Service;
  folder: string;
  double: FetchDouble;
}

async function withDictionaries(name: string, o: { reply?: Reply; catalog?: Catalog; timer?: OpenOptions["dictionaryTimer"]; setup?: (folder: string) => void }, body: (f: Fixture) => Promise<void>): Promise<void> {
  const folder = join(fixtureDir(`${name}-data`), "dictionaries");
  o.setup?.(folder);
  const double = fetchDouble(o.reply);
  const service = await openService({ git: gitPath(), name, dictionaryFolder: folder, catalog: o.catalog ?? CATALOG, fetch: double.fetch, ...(o.timer === undefined ? {} : { dictionaryTimer: o.timer }) });
  try {
    await body({ service, folder, double });
  } finally {
    await service.dispose();
  }
}

type Row = { language: string; state: string; notice?: string };
type ListResult = { languages: Row[]; removed: { language: string; name: string }[]; more: number };
type Chunk = { language: string; file: string; size: number; offset: number; bytes: string };

const list = (s: Service) => s.request<ListResult>("listDictionaries", {});
const download = (s: Service, id: string) => s.request("downloadDictionary", { language: id });
const importFrom = (s: Service, id: string, folder: string) => s.request("importDictionary", { language: id, folder });
const remove = (s: Service, id: string) => s.request("removeDictionary", { language: id });
const read = (s: Service, id: string, file: string, offset = 0) => s.request<Chunk>("readDictionary", { language: id, file, offset });
const end = (r: ServiceResponse) => ({ state: r.state, code: r.code, result: r.result });
const refused = (reason: string, extra: object = {}) => ({ state: "failed", code: "DICTIONARY_UNAVAILABLE", result: { reason, ...extra } });
const READY = (id: string) => ({ state: "succeeded", code: undefined, result: { language: id, state: "ready" } });
const rowOf = async (s: Service, id: string) => ((await list(s)).result as ListResult).languages.find((r) => r.language === id);

// Every entry of the dictionary folder that a failed run of `id` could leave.
const leftovers = (folder: string, id: string) => (existsSync(folder) ? readdirSync(folder).filter((n) => n.startsWith(".staging-") || n === id) : []);

function expectInstalled(folder: string, l: Language): void {
  const dir = join(folder, l.entry.id);
  expect(readdirSync(dir).sort()).toEqual(["entry.json", ...l.entry.files.map((f) => f.name)].sort());
  for (const f of l.entry.files) expect(sha256(readFileSync(join(dir, f.name)))).toBe(f.sha256);
  expect(JSON.parse(readFileSync(join(dir, "entry.json"), "utf8"))).toEqual({ version: 1, entry: l.entry });
}

// Writes the files and the manifest of `l` into the folder, as an install does.
function place(folder: string, l: Language, manifest: unknown = { version: 1, entry: l.entry }): string {
  const dir = join(folder, l.entry.id);
  mkdirSync(dir, { recursive: true });
  for (const f of l.entry.files) writeFileSync(join(dir, f.name), l.bytes[f.name]!);
  if (manifest !== null) writeFileSync(join(dir, "entry.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return dir;
}

// The catalog files of `l` in a picked folder.
function source(name: string, l: Language): string {
  const dir = join(fixtureDir(name), l.entry.id);
  mkdirSync(dir, { recursive: true });
  for (const f of l.entry.files) writeFileSync(join(dir, f.name), l.bytes[f.name]!);
  return dir;
}

const fsError = (code: string) => Object.assign(new Error(code), { code });

describe("T019 downloadDictionary", () => {
  caseTest(TASK, "a download installs <id>/ with entry.json, and every request names the direct strict options", SHELL, () =>
    withDictionaries("download-ready", {}, async ({ service, folder, double }) => {
      expect(end(await download(service, "nl"))).toEqual(READY("nl"));
      expectInstalled(folder, NL);
      expect(readdirSync(folder)).toEqual(["nl"]);
      expect(double.calls.map((c) => c.url)).toEqual(NL.entry.files.map((f) => f.url));
      for (const { init } of double.calls) {
        expect({ redirect: init.redirect, proxy: init.proxy, tls: init.tls, keepalive: init.keepalive }).toEqual({ redirect: "manual", proxy: false, tls: { rejectUnauthorized: true, ca: rootCertificates }, keepalive: false });
        expect(init.signal).toBeInstanceOf(AbortSignal);
      }
      expect(await rowOf(service, "nl")).toEqual({ language: "nl", state: "ready" });
    }), TIMEOUT_MS);

  caseTest(TASK, "progress of phase dictionary carries received and total, at most 4 events per second", SHELL, () =>
    withDictionaries("download-progress", { reply: (url, init) => ok(BYTES.get(url)!, init, { chunk: 65_536, delayMs: 25 }) }, async ({ service }) => {
      const from = service.progress.length;
      expect(end(await download(service, "de"))).toEqual(READY("de"));
      const total = DE.entry.files.reduce((sum, f) => sum + f.size, 0);
      const events = service.progress.slice(from).map((e, i) => ({ e: e as Record<string, unknown>, at: service.progressAt[from + i]! })).filter(({ e }) => e.phase === "dictionary");
      expect(events.length).toBeGreaterThanOrEqual(2);
      let previous = 0;
      for (const { e } of events) {
        // Contract Δ2: events carry no URL, path, or name.
        expect(Object.keys(e).sort()).toEqual(["counters", "operationId", "phase", "requestId", "state"]);
        const counters = e.counters as { received: number; total: number };
        expect(Object.keys(counters).sort()).toEqual(["received", "total"]);
        expect(counters.total).toBe(total);
        expect(counters.received).toBeGreaterThanOrEqual(previous);
        expect(counters.received).toBeLessThanOrEqual(total);
        previous = counters.received;
      }
      // Contract Δ5: at most 4 events in any second.
      for (let i = 0; i + 4 < events.length; i++) expect(events[i + 4]!.at - events[i]!.at).toBeGreaterThanOrEqual(999);
    }), TIMEOUT_MS);

  caseTest(TASK, "Cancel gives canceled, and no file and no staging folder stays", SHELL, () => {
    const hold = deferred();
    return withDictionaries("download-cancel", { reply: (url, init) => ok(BYTES.get(url)!, init, url === urlOf(NL, "index.dic") ? { hold: hold.promise } : {}) }, async ({ service, folder, double }) => {
      const requestId = service.send("downloadDictionary", { language: "nl" });
      await until(() => double.calls.length === 2, "the index.dic request");
      await service.cancel(await service.operationId(requestId));
      expect(end(await service.response(requestId))).toEqual({ state: "canceled", code: "CANCELED", result: undefined });
      hold.resolve();
      expect(leftovers(folder, "nl")).toEqual([]);
      expect(await rowOf(service, "nl")).toEqual({ language: "nl", state: "not-downloaded" });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "one changed byte, a short body, and a long body give mismatch; a long body writes at most the catalog size", SHELL, async () => {
    const dic = NL.bytes["index.dic"]!;
    const changed = dic.slice();
    changed[2_000] ^= 0x01;
    const long = new Uint8Array(dic.length + 50_000);
    long.set(dic);
    const pulled = { bytes: 0, canceled: false };
    const bodies: [string, Uint8Array, StreamOptions][] = [
      ["changed", changed, {}],
      ["short", dic.slice(0, dic.length - 1), {}],
      ["long", long, { chunk: 1_000, pulled }],
    ];
    for (const [name, body, o] of bodies) {
      const written: { path: string; bytes: number }[] = [];
      const real = fsp.writeFile;
      const spy = spyOn(fsp, "writeFile").mockImplementation(((path: string, data: Uint8Array, ...rest: unknown[]) => {
        written.push({ path: String(path), bytes: data.length });
        return (real as (...a: unknown[]) => Promise<void>)(path, data, ...rest);
      }) as never);
      try {
        await withDictionaries(`download-mismatch-${name}`, { reply: (url, init) => ok(url === urlOf(NL, "index.dic") ? body : BYTES.get(url)!, init, url === urlOf(NL, "index.dic") ? o : {}) }, async ({ service, folder }) => {
          expect({ name, ...end(await download(service, "nl")) }).toEqual({ name, ...refused("mismatch") });
          expect(leftovers(folder, "nl")).toEqual([]);
        });
      } finally {
        spy.mockRestore();
      }
      for (const w of written.filter((x) => x.path.endsWith("index.dic"))) expect(w.bytes).toBeLessThanOrEqual(dic.length);
    }
    // Plan.md D4 step 4: the read ends at byte size + 1. A ReadableStream reads at most one chunk ahead.
    expect(pulled.canceled).toBe(true);
    expect(pulled.bytes).toBeLessThanOrEqual(dic.length + 2 * 1_000);
  }, TIMEOUT_MS);

  caseTest(TASK, "status rule: 301 to the same host and 302 to another host give redirect; 404, 429, and 503 give their reasons", SHELL, async () => {
    const cases: [number, Record<string, string>, object][] = [
      [301, { location: urlOf(NL, "index.aff").replace("index.aff", "moved.aff") }, refused("redirect")],
      [302, { location: "https://example.invalid/index.aff" }, refused("redirect")],
      [404, {}, refused("http-not-found")],
      [429, {}, refused("http-rate-limit")],
      [503, {}, refused("http-status", { status: 503 })],
    ];
    for (const [status, headers, expected] of cases) {
      await withDictionaries(`download-status-${status}`, { reply: () => new Response(null, { status, headers }) }, async ({ service, folder, double }) => {
        expect({ status, ...end(await download(service, "nl")) } as object).toEqual({ status, ...expected });
        expect(double.calls.length).toBe(1);
        expect(leftovers(folder, "nl")).toEqual([]);
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "an http: entry gives not-https with no request", SHELL, () => {
    const plain = { ...CATALOG, entries: CATALOG.entries.map((e) => (e.id === "nl" ? { ...e, files: e.files.map((f, i) => (i === 1 ? { ...f, url: f.url.replace("https:", "http:") } : f)) } : e)) };
    return withDictionaries("download-http", { catalog: plain }, async ({ service, folder, double }) => {
      expect(end(await download(service, "nl"))).toEqual(refused("not-https"));
      expect(double.calls.length).toBe(0);
      expect(leftovers(folder, "nl")).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a rejected fetch and a rejected body read give transport", SHELL, async () => {
    const refusedPort = Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" });
    await withDictionaries("download-transport", { reply: () => Promise.reject(refusedPort) }, async ({ service, folder }) => {
      expect(end(await download(service, "nl"))).toEqual(refused("transport"));
      expect(leftovers(folder, "nl")).toEqual([]);
    });
    await withDictionaries("download-transport-body", { reply: (url, init) => ok(BYTES.get(url)!.slice(0, 10), init, { error: new TypeError("socket closed") }) }, async ({ service, folder }) => {
      expect(end(await download(service, "nl"))).toEqual(refused("transport"));
      expect(leftovers(folder, "nl")).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "the 120 s deadline (fake clock) gives DEADLINE, and no staging folder stays", SHELL, () => {
    const clock = fakeClock();
    return withDictionaries("download-deadline", { reply: (_, init) => hanging(init), timer: clock.timer }, async ({ service, folder, double }) => {
      const requestId = service.send("downloadDictionary", { language: "nl" });
      await until(() => double.calls.length === 1, "the first request");
      clock.fire(DICTIONARY_DOWNLOAD_DEADLINE_MS);
      expect(end(await service.response(requestId))).toEqual({ state: "failed", code: "DEADLINE", result: undefined });
      expect(leftovers(folder, "nl")).toEqual([]);
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "a write error and a rename error give save with the folder path", SHELL, async () => {
    const failures: [string, "writeFile" | "rename", string][] = [
      ["write", "writeFile", "ENOSPC"],
      ["rename", "rename", "EPERM"],
    ];
    for (const [name, call, code] of failures) {
      await withDictionaries(`download-save-${name}`, {}, async ({ service, folder }) => {
        const spy = spyOn(fsp, call).mockImplementation((() => Promise.reject(fsError(code))) as never);
        let response: ServiceResponse;
        try {
          response = await download(service, "nl");
        } finally {
          spy.mockRestore();
        }
        expect({ name, ...end(response) }).toEqual({ name, ...refused("save", { folder: join(folder, "nl") }) });
        expect(leftovers(folder, "nl")).toEqual([]);
      });
    }
  }, TIMEOUT_MS);
});

describe("T019 importDictionary", () => {
  caseTest(TASK, "the catalog files install with 0 fetch calls", SHELL, () =>
    withDictionaries("import-ready", {}, async ({ service, folder, double }) => {
      const picked = source("import-ready-src", NL);
      expect(end(await importFrom(service, "nl", picked))).toEqual(READY("nl"));
      expectInstalled(folder, NL);
      expect(double.calls.length).toBe(0);
    }), TIMEOUT_MS);

  caseTest(TASK, "a changed, missing, other-size, or other-type file gives import-mismatch", SHELL, async () => {
    const breaks: [string, (dir: string) => void][] = [
      ["changed", (dir) => writeFileSync(join(dir, "index.dic"), Uint8Array.from(NL.bytes["index.dic"]!, (b, i) => (i === 7 ? b ^ 1 : b)))],
      ["missing", (dir) => rmSync(join(dir, "license"))],
      ["size", (dir) => writeFileSync(join(dir, "index.aff"), new Uint8Array([...NL.bytes["index.aff"]!, 0x0a]))],
      ["type", (dir) => {
        rmSync(join(dir, "index.dic"));
        mkdirSync(join(dir, "index.dic"));
      }],
    ];
    for (const [name, change] of breaks) {
      await withDictionaries(`import-mismatch-${name}`, {}, async ({ service, folder }) => {
        const picked = source(`import-mismatch-${name}-src`, NL);
        change(picked);
        expect({ name, ...end(await importFrom(service, "nl", picked)) }).toEqual({ name, ...refused("import-mismatch") });
        expect(leftovers(folder, "nl")).toEqual([]);
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "a read error other than ENOENT gives import-unreadable with the picked folder", SHELL, () =>
    withDictionaries("import-unreadable", {}, async ({ service, folder }) => {
      const picked = source("import-unreadable-src", NL);
      const real = fsp.open;
      const spy = spyOn(fsp, "open").mockImplementation(((path: string, ...rest: unknown[]) =>
        String(path) === join(picked, "index.dic") ? Promise.reject(fsError("EACCES")) : (real as (...a: unknown[]) => Promise<unknown>)(path, ...rest)) as never);
      try {
        expect(end(await importFrom(service, "nl", picked))).toEqual(refused("import-unreadable", { folder: picked }));
      } finally {
        spy.mockRestore();
      }
      expect(leftovers(folder, "nl")).toEqual([]);
    }), TIMEOUT_MS);

  caseTest(TASK, "the 120 s deadline (fake clock) gives DEADLINE", SHELL, () => {
    const clock = fakeClock();
    return withDictionaries("import-deadline", { timer: clock.timer }, async ({ service, folder }) => {
      const picked = source("import-deadline-src", NL);
      const hold = deferred();
      let held = false;
      const real = fsp.open;
      const spy = spyOn(fsp, "open").mockImplementation((async (path: string, ...rest: unknown[]) => {
        if (String(path) === join(picked, "index.dic")) {
          held = true;
          await hold.promise;
        }
        return (real as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
      }) as never);
      try {
        const requestId = service.send("importDictionary", { language: "nl", folder: picked });
        await until(() => held, "the index.dic open");
        clock.fire(DICTIONARY_DOWNLOAD_DEADLINE_MS);
        hold.resolve();
        expect(end(await service.response(requestId))).toEqual({ state: "failed", code: "DEADLINE", result: undefined });
      } finally {
        spy.mockRestore();
      }
      expect(leftovers(folder, "nl")).toEqual([]);
    });
  }, TIMEOUT_MS);
});

describe("T019 readDictionary", () => {
  caseTest(TASK, "chunks of 1,048,576 bytes join to the catalog bytes", SHELL, () =>
    withDictionaries("read-chunks", { setup: (folder) => place(folder, DE) }, async ({ service }) => {
      const dic = DE.entry.files[1]!;
      const parts: Buffer[] = [];
      for (let offset = 0; offset < dic.size; offset += DICTIONARY_CHUNK_BYTES) {
        const r = await read(service, "de", "index.dic", offset);
        expect(outcome(r)).toEqual(SUCCEEDED);
        expect({ ...r.result!, bytes: undefined }).toEqual({ language: "de", file: "index.dic", size: dic.size, offset, bytes: undefined });
        parts.push(Buffer.from(r.result!.bytes, "base64"));
      }
      expect(parts.map((p) => p.length)).toEqual([DICTIONARY_CHUNK_BYTES, DICTIONARY_CHUNK_BYTES, dic.size - 2 * DICTIONARY_CHUNK_BYTES]);
      expect(sha256(Buffer.concat(parts))).toBe(dic.sha256);
      // Contract Δ3: another language, file, or offset gives INVALID_REQUEST.
      for (const payload of [{ language: "de", file: "index.dic", offset: 3 * DICTIONARY_CHUNK_BYTES }, { language: "de", file: "readme.md", offset: 0 }, { language: "xx", file: "index.dic", offset: 0 }]) {
        expect(outcome(await service.request("readDictionary", payload))).toEqual({ state: "rejected", code: "INVALID_REQUEST" });
      }
    }), TIMEOUT_MS);

  caseTest(TASK, "a changed byte, a missing requested file, and a 65,537-byte entry.json give changed; a missing folder gives absent", SHELL, async () => {
    const manifest = JSON.stringify({ version: 1, entry: NL.entry });
    const variants: [string, (folder: string) => void, string, object][] = [
      ["byte", (folder) => {
        const dir = place(folder, NL);
        writeFileSync(join(dir, "index.dic"), Uint8Array.from(NL.bytes["index.dic"]!, (b, i) => (i === 9 ? b ^ 1 : b)));
      }, "index.dic", refused("changed")],
      ["missing", (folder) => rmSync(join(place(folder, NL), "index.aff")), "index.aff", refused("changed")],
      ["manifest-over", (folder) => place(folder, NL, manifest.padEnd(DICTIONARY_MANIFEST_BYTES + 1, " ")), "index.aff", refused("changed")],
      ["manifest-bound", (folder) => place(folder, NL, manifest.padEnd(DICTIONARY_MANIFEST_BYTES, " ")), "index.aff", { state: "succeeded" }],
      ["absent", () => {}, "index.aff", refused("absent")],
    ];
    for (const [name, setup, file, expected] of variants) {
      await withDictionaries(`read-${name}`, { setup }, async ({ service }) => {
        const r = end(await read(service, "nl", file));
        expect({ name, ...(name === "manifest-bound" ? { state: r.state } : r) } as object).toEqual({ name, ...expected });
      });
    }
  }, TIMEOUT_MS);

  caseTest(TASK, "reads wait for the reconcile, a fourth concurrent read gets BUSY, and cancel gives canceled", SHELL, () =>
    withDictionaries("read-busy", { setup: (folder) => place(folder, NL) }, async ({ service, folder }) => {
      const gate = deferred();
      let listed = false;
      const real = fsp.readdir;
      const spy = spyOn(fsp, "readdir").mockImplementation((async (path: string, ...rest: unknown[]) => {
        if (String(path) === folder) {
          listed = true;
          await gate.promise;
        }
        return (real as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
      }) as never);
      try {
        const ids = [0, 1, 2].map(() => service.send("readDictionary", { language: "nl", file: "index.aff", offset: 0 }));
        await until(() => listed, "the reconcile listing");
        expect(outcome(await read(service, "nl", "index.aff"))).toEqual({ state: "rejected", code: "BUSY" });
        await service.cancel(await service.operationId(ids[2]!));
        await Bun.sleep(200);
        expect(ids.map((id) => service.responses.some((r) => r.requestId === id))).toEqual([false, false, false]);
        gate.resolve();
        const ends = await Promise.all(ids.map((id) => service.response(id)));
        expect(ends.map(outcome)).toEqual([SUCCEEDED, SUCCEEDED, { state: "canceled", code: "CANCELED" }]);
      } finally {
        spy.mockRestore();
      }
    }), TIMEOUT_MS);
});

describe("T019 listDictionaries and the release reconcile", () => {
  caseTest(TASK, "the states not-downloaded, ready, changed, downloading, and importing, with the full language check", SHELL, () => {
    const hold = deferred();
    return withDictionaries("list-states", {
      reply: (url, init) => (url === urlOf(DE, "index.aff") ? hanging(init) : ok(BYTES.get(url)!, init)),
      setup: (folder) => {
        place(folder, NL);
        // The licence document is no Hunspell file, and the language check still reads it.
        writeFileSync(join(place(folder, FR), "license"), Uint8Array.from(FR.bytes.license!, (b, i) => (i === 0 ? b ^ 1 : b)));
      },
    }, async ({ service, double }) => {
      const first = (await list(service)).result!;
      expect(first).toEqual({ languages: [{ language: "nl", state: "ready" }, { language: "fr", state: "changed" }, { language: "de", state: "not-downloaded" }, { language: "uk", state: "not-downloaded" }], removed: [], more: 0 });
      const running = service.send("downloadDictionary", { language: "de" });
      await until(() => double.calls.length === 1, "the de request");
      expect(await rowOf(service, "de")).toEqual({ language: "de", state: "downloading" });
      await service.cancel(await service.operationId(running));
      expect(outcome(await service.response(running))).toEqual({ state: "canceled", code: "CANCELED" });

      const picked = source("list-states-src", UK);
      let held = false;
      const real = fsp.open;
      const spy = spyOn(fsp, "open").mockImplementation((async (path: string, ...rest: unknown[]) => {
        if (String(path) === join(picked, "index.aff")) {
          held = true;
          await hold.promise;
        }
        return (real as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
      }) as never);
      try {
        const importing = service.send("importDictionary", { language: "uk", folder: picked });
        await until(() => held, "the uk open");
        expect(await rowOf(service, "uk")).toEqual({ language: "uk", state: "importing" });
        hold.resolve();
        expect(end(await service.response(importing))).toEqual(READY("uk"));
      } finally {
        spy.mockRestore();
      }
      expect(await rowOf(service, "uk")).toEqual({ language: "uk", state: "ready" });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "the reconcile follows the data-model §3 table, and a download clears catalog-changed", SHELL, () => {
    const other = { ...FR.entry, license: "GPL-2.0" };
    const gone = { ...language("zz-gone", "Gone").entry };
    let notes = "";
    return withDictionaries("reconcile", {
      setup: (folder) => {
        mkdirSync(join(folder, `.staging-nl-${"a".repeat(32)}`), { recursive: true });
        writeFileSync(join(folder, `.staging-nl-${"a".repeat(32)}`, "index.aff"), "partial");
        place(folder, FR, { version: 1, entry: other });
        place(folder, NL);
        place(folder, UK, null);
        mkdirSync(join(folder, "zz-gone"));
        writeFileSync(join(folder, "zz-gone", "entry.json"), JSON.stringify({ version: 1, entry: gone }));
        mkdirSync(join(folder, "notes"));
        notes = join(folder, "notes", "todo.txt");
        writeFileSync(notes, "keep me");
      },
    }, async ({ service, folder }) => {
      expect((await list(service)).result).toEqual({
        languages: [{ language: "nl", state: "ready" }, { language: "fr", state: "not-downloaded", notice: "catalog-changed" }, { language: "de", state: "not-downloaded" }, { language: "uk", state: "changed" }],
        removed: [{ language: "zz-gone", name: "Gone" }],
        more: 0,
      });
      expect(readdirSync(folder).sort()).toEqual(["nl", "notes", "uk"]);
      expect(readFileSync(notes, "utf8")).toBe("keep me");
      // The reconcile runs once per service process, so the notices stay.
      expect((await list(service)).result!.removed).toEqual([{ language: "zz-gone", name: "Gone" }]);
      expect(end(await download(service, "fr"))).toEqual(READY("fr"));
      expect(await rowOf(service, "fr")).toEqual({ language: "fr", state: "ready" });
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "93 IDs that left the catalog: all 93 folders go, and the result lists 92 removed rows and more 1", SHELL, () =>
    withDictionaries("reconcile-93", {
      setup: (folder) => {
        for (let i = 1; i <= 93; i++) {
          const id = `zz-r${String(i).padStart(3, "0")}`;
          mkdirSync(join(folder, id), { recursive: true });
          writeFileSync(join(folder, id, "entry.json"), JSON.stringify({ version: 1, entry: language(id, `Removed ${i}`).entry }));
        }
      },
    }, async ({ service, folder }) => {
      const r = (await list(service)).result!;
      expect(r.removed.length).toBe(92);
      expect(r.more).toBe(1);
      expect(r.removed[0]).toEqual({ language: "zz-r001", name: "Removed 1" });
      expect(readdirSync(folder)).toEqual([]);
    }), TIMEOUT_MS);
});

describe("T019 one run at a time and removeDictionary", () => {
  caseTest(TASK, "a second run gets busy before any byte, and Remove of the language under the run gets busy", SHELL, () =>
    withDictionaries("busy", { reply: (url, init) => (url === urlOf(NL, "index.aff") ? hanging(init) : ok(BYTES.get(url)!, init)) }, async ({ service, double }) => {
      const running = service.send("downloadDictionary", { language: "nl" });
      await until(() => double.calls.length === 1, "the nl request");
      expect(end(await download(service, "fr"))).toEqual(refused("busy"));
      expect(end(await importFrom(service, "fr", source("busy-src", FR)))).toEqual(refused("busy"));
      expect(double.calls.length).toBe(1);
      expect(end(await remove(service, "nl"))).toEqual(refused("busy"));
      expect(end(await remove(service, "fr"))).toEqual({ state: "succeeded", code: undefined, result: { language: "fr", removed: false } });
      await service.cancel(await service.operationId(running));
      expect(outcome(await service.response(running))).toEqual({ state: "canceled", code: "CANCELED" });
    }), TIMEOUT_MS);

  caseTest(TASK, "Remove removes the folder with no confirmation step; removed is false for an absent folder; a held file gives remove", SHELL, () =>
    withDictionaries("remove", { setup: (folder) => place(folder, NL) }, async ({ service, folder }) => {
      expect(end(await remove(service, "nl"))).toEqual({ state: "succeeded", code: undefined, result: { language: "nl", removed: true } });
      expect(existsSync(join(folder, "nl"))).toBe(false);
      expect(end(await remove(service, "nl"))).toEqual({ state: "succeeded", code: undefined, result: { language: "nl", removed: false } });
      place(folder, NL);
      // A held file: Windows refuses the delete with EBUSY or EPERM. The seam gives the same rejection on every platform.
      const spy = spyOn(fsp, "rm").mockImplementation((() => Promise.reject(fsError("EBUSY"))) as never);
      let response: ServiceResponse;
      try {
        response = await remove(service, "nl");
      } finally {
        spy.mockRestore();
      }
      expect(end(response)).toEqual(refused("remove", { folder: join(folder, "nl") }));
    }), TIMEOUT_MS);
});

describe("T019 independence from Git and the session log", () => {
  caseTest(TASK, "a Git read and a commit run during a download, and neither waits", SHELL, () => {
    const hold = deferred();
    return withDictionaries("git-during", { reply: (url, init) => ok(BYTES.get(url)!, init, url === urlOf(NL, "index.dic") ? { hold: hold.promise } : {}) }, async ({ service, double }) => {
      const built = buildF01(gitPath(), "dictionaries-f01", "unborn-added");
      const { repositoryId } = await service.register(repoOf(built));
      const running = service.send("downloadDictionary", { language: "nl" });
      await until(() => double.calls.length === 2, "the index.dic request");
      await approve(service, repositoryId);
      const r = await reviewOk(service, repositoryId, await readOk(service, repositoryId));
      expect(outcome(await commit(service, repositoryId, r, "during a download\n"))).toEqual(SUCCEEDED);
      await readOk(service, repositoryId);
      expect(service.responses.some((x) => x.requestId === running)).toBe(false);
      hold.resolve();
      expect(end(await service.response(running))).toEqual(READY("nl"));
    });
  }, TIMEOUT_MS);

  caseTest(TASK, "the session log holds only kind, operationId, durationMs, code, and count", SHELL, () =>
    withDictionaries("log", { reply: () => new Response(null, { status: 404 }) }, async ({ service }) => {
      await list(service);
      await download(service, "nl");
      await read(service, "nl", "index.aff");
      await remove(service, "nl");
      const kinds = ["listDictionaries", "downloadDictionary", "readDictionary", "removeDictionary"];
      const entries = service.log().filter((e) => kinds.includes((e as { kind: string }).kind));
      expect(entries.map((e) => (e as { kind: string }).kind)).toEqual(kinds);
      for (const e of entries) for (const key of Object.keys(e as object)) expect(["kind", "operationId", "durationMs", "code", "count"]).toContain(key);
    }), TIMEOUT_MS);

  caseTest(TASK, "the list, read, and remove deadline is READ_DEADLINE_MS", SHELL, () => {
    const clock = fakeClock();
    return withDictionaries("read-deadline", { timer: clock.timer, setup: (folder) => place(folder, NL) }, async ({ service, folder }) => {
      const gate = deferred();
      let listed = false;
      const real = fsp.readdir;
      const spy = spyOn(fsp, "readdir").mockImplementation((async (path: string, ...rest: unknown[]) => {
        if (String(path) === folder) {
          listed = true;
          await gate.promise;
        }
        return (real as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
      }) as never);
      try {
        const ids = ["listDictionaries", "readDictionary", "removeDictionary"].map((op) => service.send(op, op === "listDictionaries" ? {} : op === "readDictionary" ? { language: "nl", file: "index.aff", offset: 0 } : { language: "nl" }));
        await until(() => listed && clock.timers.filter((t) => t.ms === READ_DEADLINE_MS && !t.cleared).length === 3, "three read deadlines");
        for (const t of clock.timers) t.fire();
        gate.resolve();
        const ends = await Promise.all(ids.map((id) => service.response(id)));
        expect(ends.map(outcome)).toEqual(Array(3).fill({ state: "failed", code: "DEADLINE" }));
      } finally {
        spy.mockRestore();
      }
    });
  }, TIMEOUT_MS);
});
