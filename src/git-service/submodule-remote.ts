// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §12 "Update protocol" step 5: the fallback remote of a row.
// Ports of Git v2.56.0 (tag 2478544319491bbd2a42cc57a83e3d2f4730a280, commit a018953688f1b10bddf91bff8747068f5f4746a4):
// `relative_url` and `chop_last_dir` (remote.c:3003-3096), `alias_url` (remote.c:49-73), `remotes_remote_for_branch` (remote.c:673-687),
// `repo_default_remote` and `repo_remote_from_url` (remote.c:1830-1861), and `builtin/submodule--helper.c:48-119`.
// Git v2.55.0 (tag 5ce91c059e41090e7d2cffad39c04af8acf98dc1, commit e9019fcafe0040228b8631c30f97ae1adb61bcdc) has the same
// `relative_url` (remote.c:2910-3003) and helper (builtin/submodule--helper.c:48-115). Its `repo_remote_from_url` (remote.c:1812-1835)
// compares the `.gitmodules` URL without `alias_url`. The probed Git version selects the rule.

import { keyParts, type ConfigEntry } from "./trust";

// Git for Windows (compat/win32/path-utils.h) or another Git (git-compat-util.h). The caller names the platform of the Git that runs.
export type GitPlatform = "windows" | "posix";

const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const DOT = 0x2e;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// `is_xplatform_dir_sep`.
const isXplatformSep = (c: number | undefined): boolean => c === SLASH || c === BACKSLASH;
// `is_dir_sep`.
const isSep = (c: number | undefined, platform: GitPlatform): boolean => (platform === "windows" ? isXplatformSep(c) : c === SLASH);

// `win32_has_dos_drive_prefix`: the length of the prefix, or 0. Git without a drive prefix rule gives 0.
function dosDrivePrefix(s: Uint8Array, platform: GitPlatform): number {
  if (platform !== "windows" || s.length === 0) return 0;
  if (!(s[0]! & 0x80)) return s[1] === COLON ? 2 : 0;
  let i = 1;
  while (i < 4 && (s[i] ?? 0) & 0x80) i++;
  return s[i] === COLON ? i + 1 : 0;
}

// `is_absolute_path`.
const isAbsolute = (s: Uint8Array, platform: GitPlatform): boolean => isSep(s[0], platform) || dosDrivePrefix(s, platform) > 0;

// `url_is_local_not_ssh`. `is_valid_path` cannot change a result here: a drive prefix makes the path absolute, so both callers then treat it alike.
function isLocalNotSsh(s: Uint8Array, platform: GitPlatform): boolean {
  const colon = s.indexOf(COLON);
  const slash = s.indexOf(SLASH);
  return colon < 0 || (slash >= 0 && slash < colon) || dosDrivePrefix(s, platform) > 0;
}

// `path_match_flags`: `./` or `../` with a native separator, or with either separator for the non-native form.
function dotSlash(s: Uint8Array, dots: 1 | 2, sep: (c: number | undefined) => boolean): boolean {
  for (let i = 0; i < dots; i++) if (s[i] !== DOT) return false;
  return sep(s[dots]);
}

// `find_last_dir_sep`.
function lastSep(s: Uint8Array, platform: GitPlatform): number {
  for (let i = s.length - 1; i >= 0; i--) if (isSep(s[i], platform)) return i;
  return -1;
}

// Thrown where Git dies (`chop_last_dir`) or hits `BUG` (an empty remote URL). Git then sets no URL and chooses no remote.
export class SubmoduleUrlError extends Error {}

// `relative_url` with `up_path` NULL, as `resolve_relative_url` calls it from `init_submodule` and `get_default_remote_submodule`.
export function relativeUrl(remoteUrl: string, url: string, platform: GitPlatform): string {
  const sep = (c: number | undefined) => isSep(c, platform);
  let u: Uint8Array = encoder.encode(url);
  if (!isLocalNotSsh(u, platform) || isAbsolute(u, platform)) return url;
  let remote: Uint8Array = encoder.encode(remoteUrl);
  if (remote.length === 0) throw new SubmoduleUrlError("invalid empty remote_url");
  if (sep(remote[remote.length - 1])) remote = remote.subarray(0, remote.length - 1);
  const isRelative = isLocalNotSsh(remote, platform) && !isAbsolute(remote, platform);
  if (isRelative && !dotSlash(remote, 1, sep) && !dotSlash(remote, 2, sep)) remote = Buffer.concat([encoder.encode("./"), remote]);
  let colonsep = false;
  for (;;) {
    if (dotSlash(u, 2, sep)) {
      u = u.subarray(3);
      // `chop_last_dir`.
      const at = lastSep(remote, platform);
      const colon = remote.lastIndexOf(COLON);
      if (at >= 0) remote = remote.subarray(0, at);
      else if (colon >= 0) {
        remote = remote.subarray(0, colon);
        colonsep = true;
      } else if (isRelative || (remote.length === 1 && remote[0] === DOT)) throw new SubmoduleUrlError("cannot strip one component off url");
      else remote = encoder.encode(".");
    } else if (dotSlash(u, 1, sep)) u = u.subarray(2);
    else break;
  }
  let out = Buffer.concat([remote, encoder.encode(colonsep ? ":" : "/"), u]);
  if (u[u.length - 1] === SLASH) out = out.subarray(0, out.length - 1);
  if (dotSlash(out, 1, sep)) out = out.subarray(2);
  return decoder.decode(out);
}

// The facts of one repository that Git's remote choice reads.
export interface RemoteContext {
  // The `config list --show-scope --show-origin -z` entries, in Git's order.
  listing: readonly ConfigEntry[];
  // The `symbolic-ref -q HEAD` ref name, or null for a detached HEAD.
  headRef: string | null;
}

// `handle_config` dies for a value-less key that needs a value.
function needValue(entry: ConfigEntry): string {
  if (entry.value === null) throw new SubmoduleUrlError(`missing value for '${entry.key}'`);
  return entry.value;
}

// `repo_default_remote`: `branch.<current>.remote`, else the only remote, else `origin`.
// Each `remote.<name>.<variable>` key creates its remote, except a name that starts with `/`.
export function defaultRemote(context: RemoteContext): string {
  const branch = context.headRef?.startsWith("refs/heads/") ? context.headRef.slice("refs/heads/".length) : null;
  const remotes = new Set<string>();
  let branchRemote: string | null = null;
  for (const entry of context.listing) {
    const p = keyParts(entry.key);
    if (p === null || p.subsection === null) continue;
    if (p.section === "branch" && p.subsection === "") throw new SubmoduleUrlError(`bad config key '${entry.key}'`);
    if (p.section === "branch" && p.variable === "remote") {
      const value = needValue(entry);
      if (p.subsection === branch) branchRemote = value;
    } else if (p.section === "remote" && !p.subsection.startsWith("/")) remotes.add(p.subsection);
  }
  if (branchRemote !== null) return branchRemote;
  if (remotes.size === 1) return [...remotes][0]!;
  return "origin";
}

// `resolve_relative_url` as `init_submodule` and `get_default_remote_submodule` use it.
// `worktreeRoot` is Git's current folder: the `rev-parse --show-toplevel` text of the parent.
// A URL that does not start with `./` or `../`, with either separator, stays as written.
export function resolveGitmodulesUrl(url: string, parent: RemoteContext, worktreeRoot: string, platform: GitPlatform): string {
  const u = encoder.encode(url);
  if (!dotSlash(u, 1, isXplatformSep) && !dotSlash(u, 2, isXplatformSep)) return url;
  const key = `remote.${defaultRemote(parent)}.url`;
  let base: string | null = null;
  // `repo_config_get_string`: the last value wins.
  for (const entry of parent.listing) if (entry.key === key) base = needValue(entry);
  return relativeUrl(base ?? worktreeRoot, url, platform);
}

// `alias_url`: the longest `url.<base>.insteadOf` prefix wins. A tie goes to the base that the listing names first (`make_rewrite` order).
function aliasUrl(url: string, listing: readonly ConfigEntry[]): string {
  const rewrites = new Map<string, string[]>();
  for (const entry of listing) {
    const p = keyParts(entry.key);
    if (p === null || p.section !== "url" || p.subsection === null || p.variable !== "insteadof") continue;
    const prefixes = rewrites.get(p.subsection) ?? [];
    prefixes.push(needValue(entry));
    rewrites.set(p.subsection, prefixes);
  }
  let best: { base: string; length: number } | null = null;
  for (const [base, prefixes] of rewrites) {
    for (const prefix of prefixes) if (url.startsWith(prefix) && (best === null || best.length < prefix.length)) best = { base, length: prefix.length };
  }
  return best === null ? url : best.base + url.slice(best.length);
}

// The admitted version text of the Git probe, such as `2.56.0.windows.1` or `2.55.0`.
const GIT_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\.windows\.\d+)?$/;

// Git v2.56.0 added the `alias_url` step to `repo_remote_from_url`.
function aliasesGitmodulesUrl(gitVersion: string): boolean {
  const m = GIT_VERSION.exec(gitVersion);
  if (m === null) throw new TypeError("Git version refused");
  const [major, minor] = [BigInt(m[1]!), BigInt(m[2]!)];
  return major > 2n || (major === 2n && minor >= 56n);
}

// `get_default_remote_submodule` after the URL resolution: the first remote that has the URL, else the default remote.
// `remoteUrls` holds the `remote get-url --all -- <name>` lines of each remote. The remote order is the order of `listing`.
// `gitVersion` is the probed version of the Git that runs the update.
export function fallbackRemote(resolvedUrl: string, submodule: RemoteContext, remoteUrls: ReadonlyMap<string, readonly string[]>, gitVersion: string): string {
  const url = aliasesGitmodulesUrl(gitVersion) ? aliasUrl(resolvedUrl, submodule.listing) : resolvedUrl;
  const names = new Set<string>();
  for (const entry of submodule.listing) {
    const p = keyParts(entry.key);
    if (p !== null && p.section === "remote" && p.subsection !== null && !p.subsection.startsWith("/")) names.add(p.subsection);
  }
  for (const name of names) if (remoteUrls.get(name)?.includes(url)) return name;
  return defaultRemote(submodule);
}
