// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T007: writes src/contracts/dictionaries.json from the pinned wooorm/dictionaries commit (006 plan.md D3, data-model §1, §2).
// Usage: bun scripts/dictionary-catalog.ts [--offline]. ARBARETO_DICTIONARY_CACHE names the cache folder, outside the repository.
// The script reads only api.github.com (the tree) and raw.githubusercontent.com (the files). `--offline` reads only the cache.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Catalog, compareNames, DICTIONARY_LANGUAGE_BYTES, type CatalogEntry } from "../src/contracts/dictionaries";

const COMMIT = "8cfea406b505e4d7df52d5a19bce525df98c54ab";
const REPOSITORY = "wooorm/dictionaries";
const URL_PREFIX = `https://raw.githubusercontent.com/${REPOSITORY}/${COMMIT}/dictionaries/`;
const TREE_URL = `https://api.github.com/repos/${REPOSITORY}/git/trees/${COMMIT}?recursive=1`;
const REQUEST_TIMEOUT_MS = 120_000;
const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = join(ROOT, "src", "contracts", "dictionaries.json");
const GATE = join(ROOT, "scripts", "dictionary-gate.json");
const ENGLISH = join(ROOT, "node_modules", "dictionary-en");

// Reviewed names for the IDs that `Intl.DisplayNames("en", {type: "language"})` returns unchanged in Bun 1.4.4.
// `hyw`: the ISO 639-3 reference name.
const NAME_OVERRIDES: Record<string, string> = { hyw: "Western Armenian" };

type TreeItem = { path: string; type: string; sha: string; size?: number };
type Gate = { failures: { id: string }[] };

class Refusal extends Error {}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
// The Git blob ID: SHA-1 of "blob <size>\0" and the bytes. The tree names each file by it.
const blobId = (bytes: Uint8Array) => new Bun.CryptoHasher("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function cacheFolder(): string {
  const cache = process.env.ARBARETO_DICTIONARY_CACHE;
  if (cache === undefined || cache === "" || !isAbsolute(cache)) throw new Refusal("set ARBARETO_DICTIONARY_CACHE to an absolute folder");
  const inside = relative(ROOT, resolve(cache));
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) throw new Refusal("ARBARETO_DICTIONARY_CACHE must lie outside the repository");
  return join(resolve(cache), COMMIT);
}

async function download(url: string): Promise<Uint8Array> {
  // Fact F2 (006 research.md R13): `proxy: false` ignores the proxy variables. Bun types name only a proxy URL.
  const direct = { proxy: false } as unknown as RequestInit;
  const response = await fetch(url, { ...direct, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": "arbareto-dictionary-catalog" } });
  if (response.status !== 200) throw new Refusal(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// The cached file when its blob ID matches the tree, else one download that must match.
async function file(cache: string, offline: boolean, item: TreeItem): Promise<Uint8Array> {
  const local = join(cache, item.path.slice("dictionaries/".length));
  if (existsSync(local)) {
    const bytes = new Uint8Array(readFileSync(local));
    if (blobId(bytes) === item.sha) return bytes;
    if (offline) throw new Refusal(`${local}: the blob ID differs from the tree`);
  } else if (offline) throw new Refusal(`${local}: absent from the cache`);
  const bytes = await download(`${URL_PREFIX}${item.path.slice("dictionaries/".length)}`);
  if (blobId(bytes) !== item.sha || bytes.length !== item.size) throw new Refusal(`${item.path}: the download differs from the tree`);
  mkdirSync(join(local, ".."), { recursive: true });
  writeFileSync(local, bytes);
  return bytes;
}

function displayName(id: string): string {
  const name = new Intl.DisplayNames("en", { type: "language" }).of(id);
  if (name !== undefined && name !== id) return name;
  const override = NAME_OVERRIDES[id];
  if (override === undefined) throw new Refusal(`${id}: Intl.DisplayNames returns the ID, and NAME_OVERRIDES has no name`);
  return override;
}

async function main(): Promise<number> {
  const offline = process.argv.includes("--offline");
  const cache = cacheFolder();
  mkdirSync(cache, { recursive: true });
  const treeFile = join(cache, "tree.json");
  if (!offline) writeFileSync(treeFile, await download(TREE_URL));
  if (!existsSync(treeFile)) throw new Refusal(`${treeFile}: absent from the cache`);
  // The API names the tree object in `sha`, not the commit. `TREE_URL` names the commit.
  const tree = JSON.parse(readFileSync(treeFile, "utf8")) as { truncated: boolean; tree: TreeItem[] };
  if (tree.truncated !== false) throw new Refusal("tree.json is truncated");

  const folders = new Map<string, Map<string, TreeItem>>();
  for (const item of tree.tree) {
    const match = /^dictionaries\/([^/]+)\/([^/]+)$/.exec(item.path);
    if (item.type !== "blob" || match === null) continue;
    const [, id, name] = match as unknown as [string, string, string];
    if (!folders.has(id)) folders.set(id, new Map());
    folders.get(id)!.set(name, item);
  }
  const gate = JSON.parse(readFileSync(GATE, "utf8")) as Gate;
  const failed = new Set(gate.failures.map((f) => f.id));

  const entries: CatalogEntry[] = [];
  let english: CatalogEntry | undefined;
  for (const [id, items] of folders) {
    // plan.md D3: every file named license or licence, in that order, else readme.md.
    const licences = ["license", "licence"].filter((name) => items.has(name));
    if (licences.length === 0) licences.push("readme.md");
    const names = ["index.aff", "index.dic", ...licences];
    const missing = [...names, "package.json"].filter((name) => !items.has(name));
    if (missing.length > 0) throw new Refusal(`${id}: the tree holds no ${missing.join(", ")}`);
    const size = names.reduce((sum, name) => sum + items.get(name)!.size!, 0);
    // Gate step 1 (spec FR-017): the files together are at most DICTIONARY_LANGUAGE_BYTES.
    if (size > DICTIONARY_LANGUAGE_BYTES) {
      console.log(`LEFT_OUT ${id} size=${size}`);
      continue;
    }
    if (failed.has(id)) {
      console.log(`LEFT_OUT ${id} gate`);
      continue;
    }
    const files = [];
    for (const name of names) {
      const bytes = await file(cache, offline, items.get(name)!);
      files.push({ name, url: `${URL_PREFIX}${id}/${name}`, size: bytes.length, sha256: sha256(bytes) });
    }
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file(cache, offline, items.get("package.json")!))) as { license?: unknown };
    if (typeof manifest.license !== "string") throw new Refusal(`${id}: package.json has no string license field`);
    const entry = { id, name: id === "en" ? "English" : displayName(id), license: manifest.license, commit: COMMIT, files, licences };
    if (id === "en") english = entry;
    else entries.push(entry);
  }
  if (english === undefined) throw new Refusal("the tree holds no dictionaries/en");

  // plan.md D3: the bundled dictionary-en files must equal the pinned dictionaries/en files.
  const installed = JSON.parse(readFileSync(join(ENGLISH, "package.json"), "utf8")) as { name: string; version: string; license: string };
  for (const f of english.files) {
    const bytes = new Uint8Array(readFileSync(join(ENGLISH, f.name)));
    if (bytes.length !== f.size || sha256(bytes) !== f.sha256) throw new Refusal(`node_modules/dictionary-en/${f.name} differs from dictionaries/en/${f.name}`);
  }
  if (installed.license !== english.license) throw new Refusal("the dictionary-en licence differs from dictionaries/en/package.json");

  entries.sort((a, b) => compareNames(a.name, b.name));
  const catalog = Catalog.parse({
    version: 1,
    source: { repository: REPOSITORY, commit: COMMIT, urlPrefix: URL_PREFIX },
    bundled: { ...english, package: { name: installed.name, version: installed.version } },
    entries,
  });
  writeFileSync(OUTPUT, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`dictionaries.json: ${catalog.entries.length} entries, commit ${COMMIT}${offline ? ", offline" : ""}`);
  return 0;
}

try {
  process.exit(await main());
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error(`DICTIONARY_CATALOG ${e.message}`);
  process.exit(1);
}
