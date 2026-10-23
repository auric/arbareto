// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The test groups of `tests/groups.json` (T324) and the group check. `tests/run.ts` and `tests/contracts/groups.test.ts` use it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Groups {
  roots: string[];
  // File to the reason that it measures time.
  serial: Record<string, string>;
  parallel: string[];
  // Files, or folders that end with "/".
  fast: string[];
}

export const REPO = join(import.meta.dir, "..");
export const slash = (p: string) => p.replaceAll("\\", "/");
// Bun 1.4.4 docs/test/discovery.mdx: the default test file name patterns.
const TEST_FILE = new Bun.Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}");

/** True when a `fast` entry selects the file. */
export const inFast = (groups: Groups, f: string) => groups.fast.some((e) => (e.endsWith("/") ? f.startsWith(e) : f === e));

/** Reads the groups and the discovered test files, and runs the group check: each discovered file is in exactly one group, and each listed entry exists. */
export function checkGroups(): { groups: Groups; discovered: string[]; serial: string[]; problems: string[] } {
  const groups = JSON.parse(readFileSync(join(import.meta.dir, "groups.json"), "utf8")) as Groups;
  const discovered = groups.roots.flatMap((root) => [...TEST_FILE.scanSync({ cwd: join(REPO, root) })].map((f) => `${root}/${slash(f)}`)).sort();
  const serial = Object.keys(groups.serial);
  const problems: string[] = [];
  const listed = [...serial, ...groups.parallel];
  for (const f of discovered) {
    const n = listed.filter((l) => l === f).length;
    if (n !== 1) problems.push(`${f} is in ${n} groups`);
  }
  for (const f of listed) if (!discovered.includes(f)) problems.push(`${f} is listed but is not a discovered test file`);
  for (const e of groups.fast) if (!discovered.some((f) => (e.endsWith("/") ? f.startsWith(e) : f === e))) problems.push(`fast entry ${e} selects no discovered test file`);
  return { groups, discovered, serial, problems };
}
