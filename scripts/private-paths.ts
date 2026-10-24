// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The repository is public. Text must not name a local user folder, a Claude scratch folder, or a %TEMP% fixture folder.

// Each name is a synthetic fixture name that tests already use. A name outside a list is a real user folder.
const WINDOWS_NAMES = new Set(["u", "a", "me", "sample"]);
const LINUX_NAMES = new Set(["u", "dev", "user"]);

// Windows file names exclude `<>:"/\|?*` and control characters. NTFS compares names without case.
const WINDOWS_PROFILE = /[A-Za-z]:[\\/]+Users[\\/]+([^<>:"/\\|?*\x00-\x1f]+)[\\/]/gi;
// useradd(8): a user name holds letters, digits, `_`, and `-`, does not start with `-`, and can end with `$`.
const LINUX_HOME = /\/home\/([A-Za-z0-9_][A-Za-z0-9_-]*\$?)\//g;
const CLAUDE_SCRATCH = /AppData[\\/]+Local[\\/]+Temp[\\/]+claude[\\/]/i;
const TEMP_FIXTURE = /Temp[\\/]+arbareto-fixtures-/i;

export const BUILT_IN_RULES = ["Windows user profile", "Linux home", "Claude scratch", "%TEMP% fixture"] as const;
export type BuiltInRule = (typeof BUILT_IN_RULES)[number];

/** The names of the built-in rules that `line` breaks, once per match. */
export function privatePathHits(line: string): BuiltInRule[] {
  const hits: BuiltInRule[] = [];
  for (const [, name] of line.matchAll(WINDOWS_PROFILE)) if (!WINDOWS_NAMES.has(name!.toLowerCase())) hits.push(BUILT_IN_RULES[0]);
  for (const [, name] of line.matchAll(LINUX_HOME)) if (!LINUX_NAMES.has(name!)) hits.push(BUILT_IN_RULES[1]);
  if (CLAUDE_SCRATCH.test(line)) hits.push(BUILT_IN_RULES[2]);
  if (TEMP_FIXTURE.test(line)) hits.push(BUILT_IN_RULES[3]);
  return hits;
}
