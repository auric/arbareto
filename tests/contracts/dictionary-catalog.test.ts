// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T001: the dictionary catalog (data-model §1, §2; plan.md D3; spec FR-015, FR-017) and the dependency check of contract Δ10.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import catalogFile from "../../src/contracts/dictionaries.json";
import { Catalog, compareNames } from "../../src/contracts/dictionaries";
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
