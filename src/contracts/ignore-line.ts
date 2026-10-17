// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// FR-046 and plan.md D9: the line that Add to .gitignore and Add to info/exclude append.
// The service and the renderer import this module. It has no runtime import and does not use `process`.

// Contract Δ5 "Ignore line".
export const IGNORE_LINE_BYTES = 4096;

export type IgnoreLine = { ok: true; line: string } | { ok: false; reason: "path" | "limit" };

// `ignoreBOM` keeps a leading U+FEFF, which is part of the name.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// `path` holds the worktree-relative path bytes as Git prints them. gitignore(5): a leading `/` anchors the pattern,
// a trailing `/` matches folders only, a backslash quotes `*`, `?`, `[`, and itself, and a quoted trailing space stays.
export function ignoreLine(path: Uint8Array, folder: boolean): IgnoreLine {
  let text: string;
  try {
    text = utf8.decode(path);
  } catch {
    return { ok: false, reason: "path" };
  }
  if (text === "" || /\p{Cc}/u.test(text)) return { ok: false, reason: "path" };
  const escaped = text.replace(/[*?[\\]/g, "\\$&").replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length));
  const line = `/${escaped}${folder ? "/" : ""}`;
  return new TextEncoder().encode(line).length > IGNORE_LINE_BYTES ? { ok: false, reason: "limit" } : { ok: true, line };
}
