// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T008: the early report of gate step 2 (006 plan.md D3; facts F12, F13; data-model §16). A Bun time decides nothing (spec SC-002).
// T023: the service path of spec SC-002: download, read back, and import through `createSession`.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import catalogFile from "../../src/contracts/dictionaries.json";
import { Catalog } from "../../src/contracts/dictionaries";
import { DICTIONARY_CHUNK_BYTES } from "../../src/contracts/limits";
import { printOrigin } from "../origin";
import { LATIN_NEGATIVES, languageFixture } from "../support/language-fixture";

const HUNSPELL = printOrigin("hunspell-wasm", import.meta.dir);
const CATALOG_FILE = printOrigin("../../src/contracts/dictionaries.json", import.meta.dir);
const CATALOG_MODULE = printOrigin("../../src/contracts/dictionaries.ts", import.meta.dir);
const SESSION = printOrigin("../../src/git-service/session.ts", import.meta.dir);
printOrigin("../../src/git-service/dictionaries.ts", import.meta.dir);
const FIXTURE = printOrigin("../support/language-fixture.ts", import.meta.dir);
const CHILD_TIMEOUT_MS = 60_000;
const catalog = Catalog.parse(catalogFile);
const CACHE = process.env.ARBARETO_DICTIONARY_CACHE;
const folder = CACHE === undefined || CACHE === "" ? undefined : join(CACHE, catalog.source.commit);
const languages = [catalog.bundled, ...catalog.entries].map((e) => e.id).filter((id) => folder !== undefined && existsSync(join(folder, id, "index.aff")) && existsSync(join(folder, id, "index.dic")));
const work = mkdtempSync(join(tmpdir(), "arbareto-gate-"));
const children: Bun.Subprocess[] = [];

afterAll(() => {
  for (const child of children) if (child.exitCode === null) process.kill(child.pid);
  rmSync(work, { recursive: true, force: true });
});

const utf8 = new TextDecoder("utf-8", { fatal: true });
// The child loads one language and prints one JSON line. `testSpelling` gets the NFC form of each word.
const CHILD = `
const job = JSON.parse(await Bun.file(process.argv[1]).text());
const utf8 = new TextDecoder("utf-8", { fatal: true });
const aff = utf8.decode(await Bun.file(job.aff).bytes());
const dic = utf8.decode(await Bun.file(job.dic).bytes());
const { createHunspellFromStrings } = await import(job.hunspell);
const rss = process.memoryUsage().rss;
const start = performance.now();
const h = await createHunspellFromStrings(aff, dic);
const load = performance.now() - start;
const grown = process.memoryUsage().rss - rss;
const failedPositives = job.positives.filter((w) => !h.testSpelling(w.normalize("NFC")));
const failedNegatives = job.negatives.filter((w) => h.testSpelling(w.normalize("NFC")));
const latinAccepted = job.latin.filter((w) => h.testSpelling(w)).length;
console.log(JSON.stringify({ load, rss: grown, nfcAff: aff === aff.normalize("NFC"), nfcDic: dic === dic.normalize("NFC"), failedPositives, failedNegatives, latinAccepted }));
`;

describe("dictionary gate step 2, early report (T008)", () => {
  if (folder === undefined) {
    test.skip("dictionary cache absent: set ARBARETO_DICTIONARY_CACHE", () => {});
    console.log("dictionary cache absent: set ARBARETO_DICTIONARY_CACHE");
    return;
  }

  test("data-model §16: the stem, flag, and word rules", () => {
    const aff = "SET UTF-8\nFLAG long\nFORBIDDENWORD Zx\nNEEDAFFIX Na\n";
    const dic = "6\nalpha/AbZx\nbeta/Na\ngamma/Ab\nfollow-up\nv1\ndelta\tpo:noun\n";
    expect(languageFixture(aff, dic).positives.slice(0, 3)).toEqual(["gamma", "gamma", "gamma"]);
    expect(languageFixture(aff, dic).positives.at(-1)).toBe("delta");
    expect(languageFixture("FLAG num\nONLYINCOMPOUND 7\n", "2\nab/1,7\ncd/12\n").positives.slice(0, 1)).toEqual(["cd"]);
    expect(languageFixture("", "1\nab/x\n").negatives).toEqual([...LATIN_NEGATIVES, ...Array(5).fill("abqzxqzx")]);
  });

  test("data-model §16: AF aliases, homonyms, phrases, WARN, morphological fields, and escaped slashes", () => {
    // tk form: FLAG num with AF aliases; alias 2 holds the NEEDAFFIX flag 100.
    const tk = languageFixture("FLAG num\nNEEDAFFIX 100\nAF 2\nAF 101,102 # 1\nAF 100,176 # 2\n", "2\nakjyg/2\nbaba/1\n");
    expect(tk.positives[0]).toBe("baba");
    // hu form: FORBIDDENWORD on one homonym refuses the word for every line.
    expect(languageFixture("FORBIDDENWORD w\n", "3\nmeg/w\nmeg/ab\nkut/ab\n").positives[0]).toBe("kut");
    // ia form: a phrase line is not one word.
    expect(languageFixture("", "2\nAbu Dhabi/_G\nAbuja/_G\n").positives[0]).toBe("Abuja");
    // WARN refuses only with FORBIDWARN.
    expect(languageFixture("WARN r\n", "2\nrare/r\nzz\n").positives[0]).toBe("rare");
    expect(languageFixture("WARN r\nFORBIDWARN\n", "2\nrare/r\nzz\n").positives[0]).toBe("zz");
    // A morphological field after a space, and an escaped slash.
    expect(languageFixture("", "2\nhouse po:noun\nand\\/or\n").positives[0]).toBe("house");
    expect(languageFixture("FLAG UTF-8\nONLYINCOMPOUND ž\n", "2\nab/ž\ncd/x\n").positives[0]).toBe("cd");
  });

  test("data-model §16: the negative words follow the one script of the positive words", () => {
    const uk = languageFixture("", "3\nабвгґдеєж\nзиіїйклмн\n");
    expect(uk.script).toBe("Cyrillic");
    expect(uk.negatives.slice(0, 2)).toEqual(["абвабвабв", "бвгбвгбвг"]);
    expect(uk.negatives[5]).toBe("абвгґдеєжабвабв");
    // n = 2 lines: steps 0 to 198 take line 1, step 199 takes line 2.
    expect(languageFixture("", "2\nabc\nабв\n").script).toBe("Latin");
    expect(languageFixture("", "2\nα\nабвгґдеєж\n").problem).toBe("script-letters 1");
    expect(languageFixture("", "3\nab\nабвгґдеєж\nвгдеєжзий\n")).toMatchObject({ script: "Cyrillic", problem: null });
    expect(languageFixture("", "1\nабab\n").problem).toBe("script-tie Cyrillic,Latin");
    expect(languageFixture("", "1\nабв\n").problem).toBe("script-letters 3");
    expect(languageFixture("", "1\n\u{F8D0}\u{F8D1}\n").problem).toBe("no-positive-words");
    expect(languageFixture("", "1\nabc\n").script).toBe("Latin");
  });

  test.each(languages)(
    "%s",
    async (id) => {
      const aff = join(folder, id, "index.aff");
      const dic = join(folder, id, "index.dic");
      const { positives, negatives, script, problem } = languageFixture(utf8.decode(readFileSync(aff)), utf8.decode(readFileSync(dic)));
      if (problem !== null) {
        console.log(`OBSERVATION T008: ${id} fixture refused: ${problem} positives=${positives.length} bun=${Bun.version}`);
        console.log(`GATE_FAILURE ${JSON.stringify({ id, step: 2, reason: problem })}`);
        expect(problem).toBeNull();
        return;
      }
      // Plan.md D3 "Script": the catalog value is the fixture Script of the cached files.
      expect([catalog.bundled, ...catalog.entries].find((e) => e.id === id)!.script as string).toBe(script!);
      const jobFile = join(work, `${id}.json`);
      writeFileSync(jobFile, JSON.stringify({ aff, dic, hunspell: pathToFileURL(HUNSPELL).href, positives, negatives, latin: LATIN_NEGATIVES }));
      const proc = Bun.spawn([process.execPath, "-e", CHILD, jobFile], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS });
      children.push(proc);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (proc.exitCode !== 0) {
        console.log(`OBSERVATION T008: ${id} ${proc.signalCode === null ? `exit=${proc.exitCode}` : "no load within 60 s"} bun=${Bun.version}`);
        console.error(err);
        expect(proc.exitCode).toBe(0);
        return;
      }
      const r = JSON.parse(out.trim().split("\n").at(-1)!) as { load: number; rss: number; nfcAff: boolean; nfcDic: boolean; failedPositives: string[]; failedNegatives: string[]; latinAccepted: number };
      console.log(
        `OBSERVATION T008: ${id} load=${Math.round(r.load)} rss=${(r.rss / 1048576).toFixed(1)} nfc=${r.nfcAff}/${r.nfcDic} fixture=${r.failedPositives.length}/${r.failedNegatives.length} positives=${positives.length} script=${script} latinAccepted=${r.latinAccepted}/${LATIN_NEGATIVES.length} bun=${Bun.version}`,
      );
      if (r.failedPositives.length + r.failedNegatives.length > 0) console.log(`GATE_FAILURE ${JSON.stringify({ id, step: 2, reason: "fixture", failedPositives: r.failedPositives, failedNegatives: r.failedNegatives })}`);
      expect([r.failedPositives, r.failedNegatives]).toEqual([[], []]);
    },
    CHILD_TIMEOUT_MS + 10_000,
  );
});

// T023: one language per child. The child starts the service with `createSession`, an owned folder, the real catalog, and a `fetch` that serves the cached files.
// It downloads, reads `index.aff` and `index.dic` back, and runs the fixture; then it removes, imports from the cache folder, and runs the fixture again.
const SERVICE_CHILD = `
const job = JSON.parse(await Bun.file(process.argv[1]).text());
const { join } = await import("node:path");
const { createSession } = await import(job.session);
const { Catalog } = await import(job.catalogModule);
const { languageFixture } = await import(job.fixture);
const { createHunspellFromStrings } = await import(job.hunspell);
const utf8 = new TextDecoder("utf-8", { fatal: true });
const catalog = Catalog.parse(JSON.parse(await Bun.file(job.catalogFile).text()));
const entry = catalog.entries.find((e) => e.id === job.id);
const served = new Map(entry.files.map((f) => [f.url, join(job.cache, job.id, f.name)]));
let fetches = 0;
const fetch = async (url) => {
  fetches += 1;
  const path = served.get(url);
  return path === undefined ? new Response(null, { status: 404 }) : new Response(await Bun.file(path).bytes());
};
const waiting = new Map();
const writer = {
  write(frame) {
    const r = frame.kind === "public" ? frame.response : undefined;
    if (r !== undefined && waiting.has(r.requestId)) {
      waiting.get(r.requestId)(r);
      waiting.delete(r.requestId);
    }
  },
  async flush() {},
};
const runner = { closeJob() {}, ended() {}, receive: () => false };
const session = createSession({ writer, runner, fail() {}, dictionaryFolder: job.dictionaries, catalog, fetch });
const send = (frame) => session.receive({ type: "frame", body: new TextEncoder().encode(JSON.stringify(frame)) });
send({ kind: "handshake", handshake: { version: 1, restarted: false, platformScope: "other", osBuild: 26200, webView2Version: "140.0.0.0", buildIdentity: { version: "0.1.0", commit: "0".repeat(40), signing: "unsigned" }, markers: [], unloadedMarkers: 0, damagedMarkers: [], trustRecords: [] } });
if (session.sessionId === null) throw new Error("handshake refused");
const request = (operation, payload) => new Promise((resolve) => {
  const requestId = crypto.randomUUID();
  waiting.set(requestId, resolve);
  send({ kind: "public", request: { version: 1, sessionId: session.sessionId, requestId, operation, payload } });
});
const outcome = (r) => (r.state === "succeeded" ? r.result.state ?? "succeeded" : r.state + ":" + (r.code ?? "") + ":" + (r.result?.reason ?? ""));
async function readBack(name) {
  const { size } = entry.files.find((f) => f.name === name);
  const parts = [];
  for (let offset = 0; offset < size; offset += job.chunk) {
    const r = await request("readDictionary", { language: job.id, file: name, offset });
    if (r.state !== "succeeded") throw new Error("readDictionary " + name + " " + outcome(r));
    parts.push(Buffer.from(r.result.bytes, "base64"));
  }
  return utf8.decode(Buffer.concat(parts));
}
async function fixture() {
  const aff = await readBack("index.aff");
  const dic = await readBack("index.dic");
  const f = languageFixture(aff, dic);
  if (f.problem !== null) return { problem: f.problem };
  const h = await createHunspellFromStrings(aff, dic);
  return { problem: null, failedPositives: f.positives.filter((w) => !h.testSpelling(w.normalize("NFC"))).length, failedNegatives: f.negatives.filter((w) => h.testSpelling(w.normalize("NFC"))).length };
}
const downloaded = await request("downloadDictionary", { language: job.id });
const first = downloaded.state === "succeeded" ? await fixture() : null;
const downloadFetches = fetches;
const removed = await request("removeDictionary", { language: job.id });
const imported = await request("importDictionary", { language: job.id, folder: join(job.cache, job.id) });
const second = imported.state === "succeeded" ? await fixture() : null;
console.log(JSON.stringify({ download: outcome(downloaded), import: outcome(imported), removed: removed.result?.removed ?? null, downloadFetches, importFetches: fetches - downloadFetches, fixtures: [first, second] }));
process.exit(0);
`;

describe("dictionary service path of spec SC-002 (T023)", () => {
  if (folder === undefined) {
    test.skip("dictionary cache absent: set ARBARETO_DICTIONARY_CACHE", () => {});
    console.log("dictionary cache absent: set ARBARETO_DICTIONARY_CACHE");
    return;
  }
  const cached = catalog.entries.filter((e) => e.files.every((f) => existsSync(join(folder, e.id, f.name)))).map((e) => e.id);

  test.each(cached)(
    "%s",
    async (id) => {
      const entry = catalog.entries.find((e) => e.id === id)!;
      const dictionaries = join(work, `service-${id}`, "dictionaries");
      mkdirSync(join(work, `service-${id}`));
      const jobFile = join(work, `service-${id}.json`);
      writeFileSync(jobFile, JSON.stringify({ id, cache: folder, dictionaries, chunk: DICTIONARY_CHUNK_BYTES, session: pathToFileURL(SESSION).href, catalogModule: pathToFileURL(CATALOG_MODULE).href, catalogFile: CATALOG_FILE, fixture: pathToFileURL(FIXTURE).href, hunspell: pathToFileURL(HUNSPELL).href }));
      const proc = Bun.spawn([process.execPath, "-e", SERVICE_CHILD, jobFile], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS });
      children.push(proc);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (proc.exitCode !== 0) {
        console.log(`OBSERVATION T023: ${id} ${proc.signalCode === null ? `exit=${proc.exitCode}` : "no end within 60 s"} bun=${Bun.version}`);
        console.error(err);
        expect(proc.exitCode).toBe(0);
        return;
      }
      type Fixture = { problem: string | null; failedPositives?: number; failedNegatives?: number } | null;
      const r = JSON.parse(out.trim().split("\n").at(-1)!) as { download: string; import: string; removed: boolean | null; downloadFetches: number; importFetches: number; fixtures: [Fixture, Fixture] };
      const failed = (key: "failedPositives" | "failedNegatives") => r.fixtures.reduce((sum, f) => sum + (f?.[key] ?? 0), 0);
      const problems = r.fixtures.map((f) => f?.problem ?? null).filter((p) => p !== null);
      console.log(`OBSERVATION T023: ${id} download=${r.download} import=${r.import} fixture=${failed("failedPositives")}/${failed("failedNegatives")}${problems.length > 0 ? ` refused=${problems.join(",")}` : ""} bun=${Bun.version}`);
      expect({ download: r.download, import: r.import, removed: r.removed, downloadFetches: r.downloadFetches, importFetches: r.importFetches, problems, failedPositives: failed("failedPositives"), failedNegatives: failed("failedNegatives") }).toEqual({
        download: "ready",
        import: "ready",
        removed: true,
        downloadFetches: entry.files.length,
        importFetches: 0,
        problems: [],
        failedPositives: 0,
        failedNegatives: 0,
      });
      expect(r.fixtures.every((f) => f !== null)).toBe(true);
    },
    CHILD_TIMEOUT_MS + 10_000,
  );
});
