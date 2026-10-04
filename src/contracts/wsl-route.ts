// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §11 "WSL repositories": the route rule, the path conversions, the unit name, the WSL remedy commands, and the Git version rule.

import { buildRemedyCommand, type RemedyCommand, type RemedyValue } from "./remedy-command";

export { WSL_UNAVAILABLE_REASONS, type WslUnavailableReason } from "./errors";

// Contract §11 "Git per distro".
export const WSL_MINIMUM_GIT_VERSION = "2.55.0";

// The names that `wsl.exe --list --quiet` prints, and the registration keys whose `DistributionName` is a listed name.
export interface WslDistroFacts {
  listed: readonly string[];
  registry: readonly { name: string; guid: string; version: number }[];
}

export type WslRoute =
  | { kind: "windows" }
  | { kind: "wsl"; distro: string; guid: string; identityPath: string; linuxPath: string }
  | { kind: "refused"; code: "WSL_UNAVAILABLE"; reason: "distro-missing" | "not-wsl2"; distro: string }
  | { kind: "refused"; code: "UNSUPPORTED_REPOSITORY"; reason: "wsl-path" };

// The prefix comparison ignores letter case, as WSL does (research R13 P3).
const PREFIX = /^\\\\(?:wsl\$|wsl\.localhost)\\/i;
// WSL shows a Linux name that Windows names cannot hold with characters in U+F000 to U+F0FF (research R13 P5).
const MAPPED = /[-]/;
// The characters that `wslpath -w` mapped into U+F000 to U+F0FF on the reference distro (2026-10-04).
const UNMAPPABLE = /[\u0001-\u001F"*:<>?\\|]/;

// `wslpath -u` drops empty and `.` segments, resolves `..`, and takes `/` as a separator too (reference distro, 2026-10-04).
function segments(rest: string): string[] {
  const out: string[] = [];
  for (const segment of rest.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out;
}

const identityOf = (distro: string, parts: readonly string[]) => [`\\\\wsl.localhost\\${distro}`, ...parts].join("\\");

export function routeWslPath(path: string, facts: WslDistroFacts): WslRoute {
  const prefix = PREFIX.exec(path);
  if (!prefix) return { kind: "windows" };
  const rest = path.slice(prefix[0].length);
  const end = rest.search(/[\\/]/);
  const segment = end < 0 ? rest : rest.slice(0, end);
  // An exact match wins. Without one, one match that ignores letter case counts.
  const exact = facts.listed.find((name) => name === segment);
  const folded = facts.listed.filter((name) => name.toLowerCase() === segment.toLowerCase());
  const distro = exact ?? (folded.length === 1 ? folded[0] : undefined);
  if (distro === undefined) return { kind: "refused", code: "WSL_UNAVAILABLE", reason: "distro-missing", distro: segment };
  const key = facts.registry.find((k) => k.name === distro);
  if (!key) return { kind: "refused", code: "WSL_UNAVAILABLE", reason: "distro-missing", distro };
  if (key.version !== 2) return { kind: "refused", code: "WSL_UNAVAILABLE", reason: "not-wsl2", distro };
  const parts = segments(end < 0 ? "" : rest.slice(end + 1));
  if (parts.some((part) => MAPPED.test(part))) return { kind: "refused", code: "UNSUPPORTED_REPOSITORY", reason: "wsl-path" };
  return { kind: "wsl", distro, guid: key.guid, identityPath: identityOf(distro, parts), linuxPath: `/${parts.join("/")}` };
}

// The UNC identity of a Git-resolved Linux directory. `null` when a name has no UNC form that the route accepts.
export function wslIdentityPath(distro: string, linuxPath: string): string | null {
  if (!linuxPath.startsWith("/")) return null;
  const parts = linuxPath.split("/").filter((part) => part !== "");
  if (parts.some((part) => UNMAPPABLE.test(part) || MAPPED.test(part))) return null;
  return identityOf(distro, parts);
}

// Contract §11 "Process launch": `<n>` counts the processes of the operation.
export function wslUnitName(operationId: string, n: number): string {
  return `arbareto-${operationId}-${n}.scope`;
}

export type WslRemedyKind = "add" | "restore-staged" | "rm-cached" | "hook";

export interface WslRemedyValues {
  // `%SystemRoot%\System32\wsl.exe`. The caller reads the system folder.
  wslExecutable: string;
  distro: string;
  gitPath: string;
  // The Linux worktree root.
  worktreeRoot: string;
  // The Git path bytes of the entry. The `hook` form takes none.
  path?: string | Uint8Array;
}

const HEAD = "& {wsl} --distribution {distro} --cd / --exec {git}";
const TEMPLATES: Record<WslRemedyKind, string> = {
  add: `${HEAD} --literal-pathspecs -C {root} add -- {path}`,
  "restore-staged": `${HEAD} --literal-pathspecs -C {root} restore --staged -- {path}`,
  "rm-cached": `${HEAD} --literal-pathspecs -C {root} rm --cached -- {path}`,
  hook: `${HEAD} --no-lazy-fetch -C {root} hook run --ignore-missing pre-commit`,
};

// Contract §11 "Remedy commands" on the contract §4 builder. No probe passed U+005C through `wsl.exe`,
// so a value after `--distribution` with U+005C gives no command.
export function buildWslRemedy(kind: WslRemedyKind, values: WslRemedyValues): RemedyCommand {
  const linux: Record<string, RemedyValue> = {
    distro: { kind: "distroName", text: values.distro },
    git: { kind: "gitPath", text: values.gitPath, form: "linux" },
    root: { kind: "worktreeRoot", text: values.worktreeRoot, form: "linux" },
    ...(kind === "hook" ? {} : { path: { kind: "path", text: values.path ?? "", form: "linux" } }),
  };
  for (const value of Object.values(linux)) {
    const text = typeof value.text === "string" ? value.text : new TextDecoder().decode(value.text);
    if (text.includes("\\")) return { command: null, refused: value.kind };
  }
  return buildRemedyCommand(TEMPLATES[kind], { wsl: { kind: "wslExecutable", text: values.wslExecutable, form: "windows" }, ...linux });
}

export type WslGitCheck =
  | { ok: true; version: string }
  | { ok: false; code: "GIT_UNSUPPORTED"; reason: "windows-git" }
  | { ok: false; code: "GIT_UNSUPPORTED"; reason: "version"; detectedVersion?: string; minimumVersion: string };

// Contract §11 "Git per distro": a resolved path under `/mnt/` or a file that starts with `MZ` is a Windows program.
export function isWindowsProgram(path: string, mz: boolean): boolean {
  return mz || path.startsWith("/mnt/");
}

const MINIMUM_PARTS = WSL_MINIMUM_GIT_VERSION.split(".").map(BigInt);

// `versionText` is the `git --version` output line. The rule compares `major.minor.patch` numerically.
export function checkWslGit(git: { path: string; mz: boolean; versionText: string }): WslGitCheck {
  if (isWindowsProgram(git.path, git.mz) || git.versionText.includes(".windows.")) return { ok: false, code: "GIT_UNSUPPORTED", reason: "windows-git" };
  const m = /^git version ((\d+)\.(\d+)\.(\d+)\S*)$/.exec(git.versionText);
  if (!m) {
    // Contract §11: the text names the found version, also an unparseable one.
    const found = git.versionText.replace(/^git version /, "");
    return { ok: false, code: "GIT_UNSUPPORTED", reason: "version", ...(found === "" ? {} : { detectedVersion: found }), minimumVersion: WSL_MINIMUM_GIT_VERSION };
  }
  const parts = m.slice(2, 5).map(BigInt);
  const index = parts.findIndex((part, i) => part !== MINIMUM_PARTS[i]);
  if (index >= 0 && parts[index]! < MINIMUM_PARTS[index]!) {
    return { ok: false, code: "GIT_UNSUPPORTED", reason: "version", detectedVersion: m[1]!, minimumVersion: WSL_MINIMUM_GIT_VERSION };
  }
  return { ok: true, version: m[1]! };
}
