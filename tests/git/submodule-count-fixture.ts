// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T156 (feature 004 plan D20 "Count", contract Δ12 "Submodule count"): real repositories for the submodule count cases. Every remote is a local path.
// The caller holds FIXTURE_ROOT through `useFixtureRoot`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_GLOBAL_CONFIG, FIXTURE_ROOT, fixtureDir, ownedGit } from "./fixture-root";
import { put } from "./fixtures";
import { gitPath } from "./hunk-harness";
import type { TreeWorld } from "./submodule-harness";

/** The path of row `i`: `m/<g>/<i>` in 16 folders, as the packaged twins of `tests/windows/submodule-tree-fixture.ts`. */
export const countPath = (i: number) => `m/${String(i % 16).padStart(2, "0")}/${String(i).padStart(3, "0")}`;
/** A flat name holds no `/`. */
export const flatName = (i: number) => `s${String(i).padStart(3, "0")}`;

export interface Entry {
  path: string;
  name: string;
}

interface Options {
  // `git submodule update --init --recursive --jobs 8` clones each row. Without it, no row has a Git directory.
  clone?: boolean;
  // The nested rows of the row named `p`.
  nested?: readonly Entry[];
  // Runs in the superproject after its clone, before the submodule clones.
  beforeInit?: (sup: string) => void;
}

/**
 * `<root>/super` is a clone of `<root>/super.git`. Its `main` records each entry at `<root>/leaf.git` `second`, with the `.gitmodules` name of the entry.
 * The URLs are relative, so Git resolves them against the remote of the parent. The row named `p` uses `<root>/p.git`, which records `nested`.
 */
export function countWorld(name: string, entries: readonly Entry[], options: Options = {}): TreeWorld {
  const root = fixtureDir(name);
  const env = { GIT_CONFIG_GLOBAL: put(root, "global.gitconfig", `${readFileSync(FIXTURE_GLOBAL_CONFIG, "utf8")}[protocol "file"]\n\tallow = always\n`) };
  const g = (cwd: string, args: string[], input?: Uint8Array) => ownedGit(gitPath(), FIXTURE_ROOT, cwd, args, { env, input }).toString("utf8");
  const url = (bare: string) => join(root, bare).replaceAll("\\", "/");
  // Commits each text in order, with the gitlinks of `links` in the last commit, and pushes `main` to `<root>/<bare>`.
  const publish = (bare: string, texts: string[], links: readonly (Entry & { url: string; oid: string })[] = []): string[] => {
    g(root, ["init", "-q", "--bare", "-b", "main", bare]);
    const work = join(root, "src", bare);
    g(root, ["init", "-q", "-b", "main", work]);
    return texts.map((text, i) => {
      put(work, "file.txt", text);
      g(work, ["add", "--", "file.txt"]);
      if (i === texts.length - 1 && links.length > 0) {
        put(work, ".gitmodules", links.map((l) => `[submodule "${l.name}"]\n\tpath = ${l.path}\n\turl = ${l.url}\n`).join(""));
        g(work, ["add", "--", ".gitmodules"]);
        g(work, ["update-index", "-z", "--index-info"], Buffer.from(links.map((l) => `160000 ${l.oid} 0\t${l.path}\0`).join("")));
      }
      g(work, ["commit", "-q", "-m", text]);
      const commit = g(work, ["rev-parse", "HEAD"]).trim();
      if (i === texts.length - 1) g(work, ["push", "-q", url(bare), "HEAD:refs/heads/main"]);
      return commit;
    });
  };
  const [first, second] = publish("leaf.git", ["leaf 1\n", "leaf 2\n"]) as [string, string];
  const leafLinks = (list: readonly Entry[]) => list.map((e) => ({ ...e, url: "../leaf.git", oid: second }));
  const parent = options.nested === undefined ? null : publish("p.git", ["p\n"], leafLinks(options.nested))[0]!;
  publish("super.git", ["super\n"], entries.map((e) => (e.name === "p" && parent !== null ? { ...e, url: "../p.git", oid: parent } : leafLinks([e])[0]!)));
  g(root, ["clone", "-q", url("super.git"), "super"]);
  const sup = join(root, "super");
  options.beforeInit?.(sup);
  if (options.clone !== false) g(sup, ["submodule", "update", "--init", "--recursive", "--jobs", "8", "-q"]);
  return { root, sup, env, leaf: { first, second } };
}

/** `n` cloned rows at `countPath(i)` with the flat names `flatName(i)`. */
export const flatWorld = (name: string, n: number, options: Omit<Options, "nested"> = {}) => countWorld(name, Array.from({ length: n }, (_, i) => ({ path: countPath(i), name: flatName(i) })), options);

/** `n` cloned rows at `countPath(i)` with names equal to their paths, as the packaged twins. The kept Git directories lie below 17 name folders. */
export const folderWorld = (name: string, n: number) => countWorld(name, Array.from({ length: n }, (_, i) => ({ path: countPath(i), name: countPath(i) })));

/** One cloned row `p` with `k` cloned nested rows at `countPath(i)` with the flat names `flatName(i)`. */
export const nestedFlat = (name: string, k: number) => countWorld(name, [{ path: "p", name: "p" }], { nested: Array.from({ length: k }, (_, i) => ({ path: countPath(i), name: flatName(i) })) });

/**
 * 64 rows `d<ii>` without a clone. The name of row `ii` is `n<ii>/a/.../a/x` with 15 `a` folders, and 16 for row 63.
 * Each row has an empty kept Git directory (`init --bare`), so it is a `reuse` row. The walk meets 64 * 16 + 1 = 1,025 name folders.
 */
export function deepWorld(name: string): { world: TreeWorld; names: string[] } {
  const names = Array.from({ length: 64 }, (_, i) => [`n${String(i).padStart(2, "0")}`, ...Array<string>(i === 63 ? 16 : 15).fill("a"), "x"].join("/"));
  const world = countWorld(name, names.map((n, i) => ({ path: `d${String(i).padStart(2, "0")}`, name: n })), { clone: false });
  for (const n of names) ownedGit(gitPath(), FIXTURE_ROOT, world.root, ["init", "-q", "--bare", "-b", "main", join(world.sup, ".git", "modules", ...n.split("/"))], { env: world.env });
  return { world, names };
}
