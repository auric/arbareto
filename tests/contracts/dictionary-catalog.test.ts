// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T001: the dictionary catalog (data-model §1, §2; plan.md D3; spec FR-015, FR-017) and the dependency check of contract Δ10.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import catalogFile from "../../src/contracts/dictionaries.json";
import { Catalog, compareNames, DICTIONARY_SCRIPTS } from "../../src/contracts/dictionaries";
import { printOrigin } from "../origin";

printOrigin("../../src/contracts/dictionaries.ts", import.meta.dir);
printOrigin("../../src/contracts/dictionaries.json", import.meta.dir);

const ROOT = join(import.meta.dir, "..", "..");
const COMMIT = "8cfea406b505e4d7df52d5a19bce525df98c54ab";
const PREFIX = `https://raw.githubusercontent.com/wooorm/dictionaries/${COMMIT}/dictionaries/`;
const MAX = 12_582_912;
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const file = (id: string, name: string, size = 10) => ({ name, url: `${PREFIX}${id}/${name}`, size, sha256: "a".repeat(64) });
const entry = (id: string, name: string, licences: string[] = ["license"]) => ({
  id,
  name,
  license: "MIT",
  script: "Latin",
  commit: COMMIT,
  files: [file(id, "index.aff"), file(id, "index.dic"), ...licences.map((l) => file(id, l))],
  licences,
});
const valid = () => ({
  version: 1,
  source: { repository: "wooorm/dictionaries", commit: COMMIT, urlPrefix: PREFIX },
  bundled: { ...entry("en", "English"), package: { name: "dictionary-en", version: "4.0.0" } },
  entries: [entry("eu", "Basque", ["readme.md"]), entry("fr", "French"), entry("oc", "Occitan", ["license", "licence"]), entry("uk", "Ukrainian")],
});
type Draft = ReturnType<typeof valid>;
const refused = (change: (c: Draft) => void) => {
  const c = valid();
  change(c);
  return Catalog.safeParse(c).success;
};

describe("Catalog schema (data-model §1, §2)", () => {
  test("the synthetic catalog passes", () => {
    expect(Catalog.safeParse(valid()).error).toBeUndefined();
  });

  test("version, source, and commit", () => {
    expect(refused((c) => (c.version = 2))).toBe(false);
    expect(refused((c) => (c.source.repository = "other/dictionaries"))).toBe(false);
    expect(refused((c) => (c.source.commit = COMMIT.toUpperCase()))).toBe(false);
    expect(refused((c) => (c.source.commit = COMMIT.slice(1)))).toBe(false);
    expect(refused((c) => (c.source.urlPrefix = PREFIX.replace("https:", "http:")))).toBe(false);
    expect(refused((c) => (c.entries[0]!.commit = "b".repeat(40)))).toBe(false);
    expect(refused((c) => (c.bundled.commit = "b".repeat(40)))).toBe(false);
  });

  test("every URL is the prefix, the ID, a slash, and the name, exactly", () => {
    expect(refused((c) => (c.entries[1]!.files[0]!.url = `${PREFIX}de/index.aff`))).toBe(false);
    expect(refused((c) => (c.entries[1]!.files[1]!.url = `${PREFIX}fr/index.dic?x`))).toBe(false);
    expect(refused((c) => (c.entries[1]!.files[2]!.url = file("fr", "license").url.replace(COMMIT, "c".repeat(40))))).toBe(false);
    expect(refused((c) => (c.bundled.files[0]!.url = `${PREFIX}en-GB/index.aff`))).toBe(false);
  });

  test("ID form and length", () => {
    for (const id of ["uk", "de-CH", "sr-Latn", "ca-valencia", "tlh-Latn", "hyw"]) expect(refused((c) => (c.entries[3] = { ...entry(id, "Zz"), id }))).toBe(true);
    for (const id of ["u", "UK", "abcd", "de-", "de-C", "de-ABCDEFGHI", "de_CH", "de-CH-", `ab${"-abcdefgh".repeat(4)}`]) {
      expect(refused((c) => (c.entries[3] = { ...entry(id, "Zz"), id }))).toBe(false);
    }
  });

  test("name and licence lengths", () => {
    expect(refused((c) => (c.entries[3]!.name = ""))).toBe(false);
    expect(refused((c) => (c.entries[3]!.name = "Z" + "\u{1F600}".repeat(63)))).toBe(true);
    expect(refused((c) => (c.entries[3]!.name = "Z" + "\u{1F600}".repeat(64)))).toBe(false);
    expect(refused((c) => (c.entries[3]!.license = ""))).toBe(false);
    expect(refused((c) => (c.entries[3]!.license = "é".repeat(64)))).toBe(true);
    expect(refused((c) => (c.entries[3]!.license = "é".repeat(64) + "x"))).toBe(false);
  });

  test("files: 3 or 4, in the order index.aff, index.dic, then the licence documents", () => {
    expect(refused((c) => c.entries[3]!.files.pop())).toBe(false);
    expect(refused((c) => c.entries[3]!.files.reverse())).toBe(false);
    expect(refused((c) => c.entries[3]!.files.push(file("uk", "licence")))).toBe(false);
    expect(refused((c) => (c.entries[3]!.files[2] = file("uk", "readme.md")))).toBe(false);
    expect(refused((c) => (c.entries[3]!.files[0] = file("uk", "index.js")))).toBe(false);
  });

  test("file size and SHA-256 form", () => {
    expect(refused((c) => (c.entries[3]!.files[0]!.size = 0))).toBe(false);
    expect(refused((c) => (c.entries[3]!.files[0]!.size = 1.5))).toBe(false);
    expect(refused((c) => (c.entries[3]!.files[0]!.size = MAX - 20))).toBe(true);
    expect(refused((c) => (c.entries[3]!.files[0]!.size = MAX))).toBe(false);
    expect(refused((c) => (c.entries[3]!.files[0]!.size = MAX + 1))).toBe(false);
    expect(refused((c) => (c.entries[3]!.files[0]!.sha256 = "A".repeat(64)))).toBe(false);
    expect(refused((c) => (c.entries[3]!.files[0]!.sha256 = "a".repeat(63)))).toBe(false);
  });

  test("licences: only the four forms", () => {
    expect(refused((c) => (c.entries[3] = entry("uk", "Ukrainian", ["licence"])))).toBe(true);
    expect(refused((c) => (c.entries[3] = entry("uk", "Ukrainian", ["licence", "license"])))).toBe(false);
    expect(refused((c) => (c.entries[3] = entry("uk", "Ukrainian", ["license", "readme.md"])))).toBe(false);
    expect(refused((c) => (c.entries[3] = entry("uk", "Ukrainian", [])))).toBe(false);
    expect(refused((c) => (c.entries[3]!.licences = ["licence"]))).toBe(false);
  });

  test("script: one Script value of the data-model §16 list, required", () => {
    for (const script of ["Cyrillic", "Hebrew", "Canadian_Aboriginal", "Han"]) expect(refused((c) => (c.entries[3]!.script = script))).toBe(true);
    for (const script of ["Common", "Inherited", "Latn", "latin", "", "Klingon"]) expect(refused((c) => (c.entries[3]!.script = script))).toBe(false);
    expect(refused((c) => delete (c.entries[3] as Record<string, unknown>).script)).toBe(false);
    expect(refused((c) => delete (c.bundled as Record<string, unknown>).script)).toBe(false);
    expect(refused((c) => (c.bundled.script = "Cyrillic"))).toBe(false);
    // Each value is a Script property value of the regular expression engine.
    for (const script of DICTIONARY_SCRIPTS) expect(new RegExp(`\\p{Script=${script}}`, "u").test("")).toBe(false);
  });

  test("no en entry, unique IDs, compareNames order, unknown fields", () => {
    expect(refused((c) => c.entries.push(entry("en", "Zz")))).toBe(false);
    expect(refused((c) => c.entries.push(entry("uk", "Zz")))).toBe(false);
    expect(refused((c) => c.entries.reverse())).toBe(false);
    expect(refused((c) => ((c.entries[0] as Record<string, unknown>).extra = 1))).toBe(false);
    expect(refused((c) => ((c as Record<string, unknown>).extra = 1))).toBe(false);
    expect(refused((c) => (c.bundled.id = "en-GB"))).toBe(false);
  });

  test("compareNames maps A to Z to a to z, compares unsigned bytes, then the raw bytes", () => {
    expect(compareNames("a", "B")).toBeLessThan(0);
    expect(compareNames("B", "b")).toBeLessThan(0);
    expect(compareNames("b", "B")).toBeGreaterThan(0);
    expect(compareNames("Z", "_")).toBeGreaterThan(0);
    expect(compareNames("z", "é")).toBeLessThan(0);
    expect(compareNames("Norwegian", "Norwegian Bokmål")).toBeLessThan(0);
    expect(compareNames("x", "x")).toBe(0);
  });
});

describe("the shipped catalog (plan.md D3)", () => {
  const catalog = Catalog.parse(catalogFile);

  test("the source is the pinned commit", () => {
    expect(catalog.source.commit).toBe(COMMIT);
  });

  // Plan.md D3 "Rebuild": the offline rebuild leaves out each failed entry.
  test("no entry of scripts/dictionary-gate.json is in the catalog", () => {
    const gate = JSON.parse(readFileSync(join(ROOT, "scripts", "dictionary-gate.json"), "utf8")) as { failures: { id: string }[] };
    expect(gate.failures.length).toBeGreaterThan(0);
    const ids = new Set(catalog.entries.map((e) => e.id));
    expect(gate.failures.map((f) => f.id).filter((id) => ids.has(id))).toEqual([]);
  });

  // Contract Δ1: the shell reads sizes with `as_u64`, which refuses an exponent. JSON.stringify writes none for these sizes.
  // A checkout with `core.autocrlf` writes CRLF line ends, so the compare uses LF.
  test("the file is the JSON.stringify form with two spaces and a final line feed", () => {
    const text = readFileSync(join(ROOT, "src", "contracts", "dictionaries.json"), "utf8").replaceAll("\r\n", "\n");
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });

  // Plan.md D3 "Script": both values must match the same code points. A reviewed difference needs a row here; Bun 1.4.4 has none (2026-10-24).
  test("each script equals the Script of Intl.Locale(id).maximize(), and bundled is Latin", () => {
    expect(catalog.bundled.script).toBe("Latin");
    const same = new Map<string, boolean>();
    const equal = (a: string, b: string) => {
      const x = new RegExp(`^\\p{Script=${a}}$`, "u");
      const y = new RegExp(`^\\p{Script=${b}}$`, "u");
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const c = String.fromCodePoint(cp);
        if (x.test(c) !== y.test(c)) return false;
      }
      return true;
    };
    const differ: string[] = [];
    for (const e of [catalog.bundled, ...catalog.entries]) {
      const code = new Intl.Locale(e.id).maximize().script;
      if (code === undefined) {
        differ.push(`${e.id} maximize() has no script`);
        continue;
      }
      const key = `${code}=${e.script}`;
      if (!same.has(key)) same.set(key, equal(code, e.script));
      if (!same.get(key)) differ.push(`${e.id} ${code} ${e.script}`);
    }
    expect(differ).toEqual([]);
  });

  test("the renderer build parses the catalog: the buildStart hook refuses a broken file and passes the shipped one", async () => {
    const { catalogCheck } = await import("../../vite.config");
    const dir = mkdtempSync(join(tmpdir(), "arbareto-catalog-build-"));
    try {
      const broken = join(dir, "dictionaries.json");
      writeFileSync(broken, JSON.stringify({ ...catalogFile, version: 2 }));
      const hook = (file?: string) => (catalogCheck(file).buildStart as () => void).call({});
      expect(() => hook(broken)).toThrow();
      expect(() => hook()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("oc holds license and licence; eu and et hold readme.md", () => {
    const licences = (id: string) => catalog.entries.find((e) => e.id === id)?.licences;
    expect(licences("oc")).toEqual(["license", "licence"]);
    expect(licences("eu")).toEqual(["readme.md"]);
    expect(licences("et")).toEqual(["readme.md"]);
  });

  test("the bundled record equals node_modules/dictionary-en in size and SHA-256", () => {
    const dir = join(ROOT, "node_modules", "dictionary-en");
    const installed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string };
    expect([catalog.bundled.package.name, catalog.bundled.package.version]).toEqual([installed.name, installed.version]);
    expect(catalog.bundled.files.map((f) => f.name)).toEqual(["index.aff", "index.dic", "license"]);
    expect(catalog.bundled.files.map((f) => f.size)).toEqual([3_086, 551_762, 15_731]);
    for (const f of catalog.bundled.files) {
      const bytes = readFileSync(join(dir, f.name));
      expect([f.name, bytes.length, sha256(bytes)]).toEqual([f.name, f.size, f.sha256]);
    }
  });
});

describe("dependency check (contract Δ10)", () => {
  test("bun.lock pins hunspell-wasm 0.3.0 with its integrity, and hunspell.wasm has the reviewed SHA-256", () => {
    const lock = Bun.JSONC.parse(readFileSync(join(ROOT, "bun.lock"), "utf8")) as { packages: Record<string, unknown[]> };
    const record = lock.packages["hunspell-wasm"];
    expect(record?.[0]).toBe("hunspell-wasm@0.3.0");
    expect(record?.[3]).toBe("sha512-D7/QLaeekJYYlE37D7KBq5v38vL4tQutTFIUBOUGBl0g9la8OUgfSd8+XbwNPV5uYMHS13umXR9MtdAxStpHJg==");
    const wasm = readFileSync(join(ROOT, "node_modules", "hunspell-wasm", "wasm", "hunspell.wasm"));
    expect(sha256(wasm)).toBe("72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0");
  });
});

describe("catalog script tree check (data-model §2)", () => {
  const SCRIPT = printOrigin("../../scripts/dictionary-catalog.ts", import.meta.dir);
  const RUN_TIMEOUT_MS = 30_000;
  test(
    "a tree folder that is no language ID refuses before any file access",
    async () => {
      const cache = mkdtempSync(join(tmpdir(), "arbareto-catalog-"));
      try {
        const blob = (path: string) => ({ path, type: "blob", sha: "0".repeat(40), size: 1 });
        const items = ["index.aff", "index.dic", "license", "package.json"].map((name) => blob(`dictionaries/../${name}`));
        mkdirSync(join(cache, COMMIT), { recursive: true });
        writeFileSync(join(cache, COMMIT, "tree.json"), JSON.stringify({ truncated: false, tree: items }));
        const run = Bun.spawn([process.execPath, SCRIPT, "--offline"], { cwd: ROOT, env: { ...process.env, ARBARETO_DICTIONARY_CACHE: cache }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: RUN_TIMEOUT_MS });
        const [, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
        expect([run.exitCode, err.trim()]).toEqual([1, "DICTIONARY_CATALOG dictionaries/../index.aff: the folder name is no language ID"]);
      } finally {
        rmSync(cache, { recursive: true, force: true });
      }
    },
    RUN_TIMEOUT_MS + 5_000,
  );
});
