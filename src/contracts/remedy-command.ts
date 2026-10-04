// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §4 "Quoting rule" and "Path form". Every remedy command of the contract is built here.

export type RemedyValueKind =
  | "gitPath"
  | "worktreeRoot"
  | "path"
  | "submoduleWorktree"
  | "gitDirectory"
  | "remoteName"
  | "branchName"
  | "commitId"
  | "distroName"
  // Contract §11 "Remedy commands": `<System32 path>\wsl.exe`.
  | "wslExecutable";

// `windows`: the service removes trailing separators. `linux` and `git-reported` (the §6 `safe.directory` path) keep their form.
export type RemedyValueForm = "windows" | "linux" | "git-reported";

export interface RemedyValue {
  kind: RemedyValueKind;
  text: string | Uint8Array;
  form?: RemedyValueForm;
}

export type RemedyCommand = { command: string } | { command: null; refused: string };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// PowerShell ends a single-quoted string at U+0027, U+2018, U+2019, U+201A, and U+201B.
const SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g;
// U+0022, U+201C to U+201E, and the control characters U+0000 to U+001F and U+007F to U+009F.
const REFUSED = /["\u201C-\u201E\u0000-\u001F\u007F-\u009F]/;
const DRIVE_ROOT = /^[A-Za-z]:\\$/;

function quote(value: RemedyValue): string | null {
  let text: string;
  try {
    text = typeof value.text === "string" ? value.text : utf8.decode(value.text);
  } catch {
    return null;
  }
  if (!text.isWellFormed() || REFUSED.test(text)) return null;
  if (value.form === "windows") {
    const stripped = text.replace(/[\\/]+$/, "");
    // A drive root keeps its first separator.
    text = stripped !== text && /^[A-Za-z]:$/.test(stripped) ? text.slice(0, 3) : stripped;
  }
  if (text.endsWith("\\") && !DRIVE_ROOT.test(text)) return null;
  return `'${text.replace(SINGLE_QUOTES, "$&$&")}'`;
}

// The template is a constant. Each `{name}` takes the quoted value of that name.
export function buildRemedyCommand(template: string, values: Record<string, RemedyValue>): RemedyCommand {
  const quoted = new Map<string, string>();
  for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
    if (quoted.has(name)) continue;
    const value = values[name];
    if (value === undefined) throw new Error(`remedy template names no value ${name}`);
    const text = quote(value);
    if (text === null) return { command: null, refused: value.kind };
    quoted.set(name, text);
  }
  return { command: template.replace(/\{(\w+)\}/g, (_m, name: string) => quoted.get(name) as string) };
}
