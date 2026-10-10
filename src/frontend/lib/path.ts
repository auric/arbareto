// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A Git path (data-model §5, `ChangeEntry.path`) separates components with "/" only. "\" is a name byte, and the `\xNN` display escapes hold it too.
export const GIT_SEPARATORS = ["/"] as const;
// A native absolute path on Windows (contract §6 "Channel frames", `worktreeRoot`) takes "\" and "/".
export const WINDOWS_SEPARATORS = ["/", "\\"] as const;

/** Splits a path after its last separator. The folder part keeps that separator. */
export function splitPath(path: string, separators: readonly string[]): [string, string] {
  const cut = Math.max(...separators.map((s) => path.lastIndexOf(s))) + 1;
  return [path.slice(0, cut), path.slice(cut)];
}
