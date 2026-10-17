// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract Δ3 grammars, data-model §1, §8, §9, research.md R2, and plan.md D11, D13. A null result means `MALFORMED_GIT_OUTPUT`.

import { isUtf8 } from "node:buffer";
import type { ConfigScope } from "../contracts/envelope";
import { isObjectId, type ObjectFormat } from "./commands";
import { latin1 } from "./read-steps";
import { parseMaybeBool, urlHelper, type ConfigEntry } from "./trust";

// Byte strings: `latin1` maps each byte to one code unit, so equal strings mean equal bytes.
const decoded = (raw: string): { text: string; exact: boolean } => {
  const bytes = Buffer.from(raw, "latin1");
  return { text: bytes.toString("utf8"), exact: isUtf8(bytes) };
};

// ---- readBranches (contract Δ3) ----

export interface BranchRecord {
  ref: string;
  kind: "local" | "remote";
  name: string;
  // True when the ref bytes are no valid UTF-8, so `ref` is not the name that Git uses.
  invalidUtf8: boolean;
  oid: string;
  upstream: string | null;
  current: boolean;
}

const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/";
const isRefField = (field: string) => field === "" || field.startsWith("refs/");

// Five fields with four NUL bytes and LF. A record with a non-empty `symref` is no branch entry.
export function parseBranches(stdout: Uint8Array, objectFormat: ObjectFormat): BranchRecord[] | null {
  const raw = latin1(stdout);
  if (raw === "") return [];
  if (!raw.endsWith("\n")) return null;
  const entries: BranchRecord[] = [];
  let current = 0;
  for (const line of raw.slice(0, -1).split("\n")) {
    const f = line.split("\0");
    if (f.length !== 5) return null;
    const [refname, oid, upstream, head, symref] = f as [string, string, string, string, string];
    const prefix = refname.startsWith(HEADS) ? HEADS : refname.startsWith(REMOTES) ? REMOTES : null;
    if (prefix === null || refname.length === prefix.length || !isObjectId(oid, objectFormat) || !isRefField(upstream) || !isRefField(symref)) return null;
    if (head !== " " && !(head === "*" && prefix === HEADS && ++current === 1)) return null;
    if (symref !== "") continue;
    const ref = decoded(refname);
    entries.push({
      ref: ref.text,
      kind: prefix === HEADS ? "local" : "remote",
      name: ref.text.slice(prefix.length),
      invalidUtf8: !ref.exact,
      oid,
      upstream: upstream === "" ? null : decoded(upstream).text,
      current: head === "*",
    });
  }
  return entries;
}

// ---- readWorktrees (data-model §8) ----

export interface WorktreeRecord {
  path: string;
  // True when the path or the branch bytes are no valid UTF-8.
  invalidUtf8: boolean;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  // `reason` is untrusted text.
  locked: { reason: string | null } | null;
  prunable: { reason: string | null } | null;
  main: boolean;
}

// git-worktree(1) "Porcelain Format": an attribute is a label, or a label, a space, and a value.
function labelled(line: string, label: string): { reason: string | null } | undefined {
  if (line === label) return { reason: null };
  if (!line.startsWith(`${label} `) || line.length === label.length + 1) return undefined;
  return { reason: decoded(line.slice(label.length + 1)).text };
}

function worktreeRecord(lines: string[], objectFormat: ObjectFormat, main: boolean): WorktreeRecord | null {
  const first = lines[0]!;
  if (!first.startsWith("worktree ") || first.length === "worktree ".length) return null;
  const path = decoded(first.slice("worktree ".length));
  const r: WorktreeRecord = { path: path.text, invalidUtf8: !path.exact, head: null, branch: null, bare: false, detached: false, locked: null, prunable: null, main };
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const label = line.split(" ", 1)[0]!;
    if (seen.has(label)) return null;
    seen.add(label);
    const reason = label === "locked" || label === "prunable" ? labelled(line, label) : undefined;
    if (label === "HEAD" && isObjectId(line.slice(5), objectFormat)) r.head = line.slice(5);
    else if (label === "branch" && line.startsWith("branch refs/")) {
      const branch = decoded(line.slice(7));
      r.branch = branch.text;
      r.invalidUtf8 ||= !branch.exact;
    } else if (line === "bare") r.bare = true;
    else if (line === "detached") r.detached = true;
    else if (reason !== undefined) r[label as "locked" | "prunable"] = reason;
    else return null;
  }
  // builtin/worktree.c `show_worktree_porcelain`: `bare`, or `HEAD` with at most one of `detached` and `branch`.
  if (r.bare === (r.head !== null) || (r.branch !== null && r.detached)) return null;
  if (r.bare && (r.branch !== null || r.detached)) return null;
  return r;
}

// `worktree list --porcelain -z`: each attribute line ends with NUL, and one more NUL ends the record.
export function parseWorktrees(stdout: Uint8Array, objectFormat: ObjectFormat): WorktreeRecord[] | null {
  const raw = latin1(stdout);
  if (raw === "") return [];
  if (!raw.endsWith("\0")) return null;
  const records: WorktreeRecord[] = [];
  let lines: string[] = [];
  for (const line of raw.slice(0, -1).split("\0")) {
    if (line !== "") {
      lines.push(line);
      continue;
    }
    const record = lines.length === 0 ? null : worktreeRecord(lines, objectFormat, records.length === 0);
    if (record === null) return null;
    records.push(record);
    lines = [];
  }
  return lines.length === 0 ? records : null;
}

// ---- Tracked status (`trackedStatusArgs` and `rebaseStatusArgs`, plan.md D3 and D6) ----

const statusRecord = (kind: string, modes: number, oids: number, score: string, hex: number) => new RegExp(`^${kind} \\S\\S \\S{4}( [0-7]{6}){${modes}}( [0-9a-f]{${hex}}){${oids}}${score} [^]+$`);
const STATUS_RECORDS = new Map(
  (["sha1", "sha256"] as const).map((format) => {
    const hex = format === "sha1" ? 40 : 64;
    return [format, { ordinary: statusRecord("1", 3, 2, "", hex), renamed: statusRecord("2", 3, 2, " [RC][0-9]{1,3}", hex), unmerged: statusRecord("u", 4, 3, "", hex) }];
  }),
);

// git-status(1) "Porcelain Format Version 2" with `-z` and without untracked entries. A `2` record has one more NUL field, the original path.
// Header lines start with `# ` and come before the entries. Parsers ignore headers they do not know, such as `# stash <n>` of `status.showStash`.
export function parseTrackedStatus(stdout: Uint8Array, objectFormat: ObjectFormat): { records: number; unmerged: number } | null {
  const raw = latin1(stdout);
  if (raw === "") return { records: 0, unmerged: 0 };
  if (!raw.endsWith("\0")) return null;
  const { ordinary, renamed, unmerged: conflict } = STATUS_RECORDS.get(objectFormat)!;
  const fields = raw.slice(0, -1).split("\0");
  let records = 0;
  let unmerged = 0;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (/^# [^ ]/.test(field) && records === 0) continue;
    if (renamed.test(field)) {
      if (++i >= fields.length) return null;
    } else if (conflict.test(field)) unmerged++;
    else if (!ordinary.test(field)) return null;
    records++;
  }
  return { records, unmerged };
}

// ---- Configuration value view (data-model §9, plan.md D11) ----

export type ConfigType = { kind: "bool" } | { kind: "enum"; values: readonly string[] } | { kind: "text" };

export interface ConfigViewEntry {
  scope: ConfigScope;
  origin: string;
  value: string | null;
  // The value as Git reads it for the key type. Null: Git cannot read it, or a text key has no value.
  reading: string | null;
}

export interface ConfigView {
  key: string;
  type: ConfigType;
  // Listing order.
  entries: ConfigViewEntry[];
  effective: ConfigViewEntry | null;
  readOnly: { local: boolean; global: boolean };
}

// FR-060 boolean keys, as Git prints them: section and variable in lowercase.
const BOOL_KEYS: ReadonlySet<string> = new Set(["fetch.prune", "merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs", "rerere.enabled", "rerere.autoupdate", "push.autosetupremote"]);

const boolReading = (value: string | null): string | null => ["false", "true"][parseMaybeBool(value)] ?? null;
const PUSH_DEFAULTS = ["nothing", "current", "upstream", "simple", "matching", "tracking"];

// Plan.md D11 enumerations with Git's readers: config.c `core.autocrlf` (`strcasecmp` "input", then `git_config_bool`),
// rebase.c `rebase_parse_value`, builtin/pull.c `config_get_ff`, and config.c `git_default_push_config` (`strcmp`).
const ENUMS: ReadonlyMap<string, { values: readonly string[]; read: (value: string | null) => string | null }> = new Map([
  ["core.autocrlf", { values: ["true", "false", "input"], read: (v) => (v !== null && /^input$/i.test(v) ? "input" : boolReading(v)) }],
  ["pull.rebase", { values: ["true", "false", "merges", "interactive"], read: (v) => boolReading(v) ?? (v === "merges" || v === "m" ? "merges" : v === "interactive" || v === "i" ? "interactive" : null) }],
  ["pull.ff", { values: ["true", "false", "only"], read: (v) => boolReading(v) ?? (v === "only" ? "only" : null) }],
  ["push.default", { values: PUSH_DEFAULTS, read: (v) => (v !== null && PUSH_DEFAULTS.includes(v) ? v : null) }],
]);

// `key` is the canonical key as Git prints it. The effective value is the last entry (git-config(1)).
export function configView(listing: readonly ConfigEntry[], key: string): ConfigView {
  const kind = ENUMS.get(key);
  const type: ConfigType = BOOL_KEYS.has(key) ? { kind: "bool" } : kind ? { kind: "enum", values: kind.values } : { kind: "text" };
  const read = BOOL_KEYS.has(key) ? boolReading : (kind?.read ?? ((v: string | null) => v));
  const entries = listing.filter((e) => e.key === key).map(({ scope, origin, value }) => ({ scope, origin, value, reading: read(value) }));
  // FR-063: several entries in one scope. Plan.md D11: a boolean that Git cannot read.
  const readOnly = (scope: ConfigScope) => {
    const own = entries.filter((e) => e.scope === scope);
    return own.length > 1 || (type.kind === "bool" && own.length === 1 && own[0]!.reading === null);
  };
  return { key, type, entries, effective: entries.at(-1) ?? null, readOnly: { local: readOnly("local"), global: readOnly("global") } };
}

// ---- Refspec map (research.md R2, remote.c `query_refspecs`) ----

interface Refspec {
  negative: boolean;
  src: string;
  // Null for a refspec without `:`, which stores no ref.
  dst: string | null;
  pattern: boolean;
}

// refs.c `refname_disposition` for ASCII: 1 ends a component, 2 is `.`, 3 is `{`, 4 is refused, and 5 is `*`. Every other byte is 0.
function disposition(code: number): number {
  if (code === 0x2f) return 1;
  if (code < 0x20 || code === 0x7f || " :?[\\^~".includes(String.fromCharCode(code))) return 4;
  return code === 0x2e ? 2 : code === 0x7b ? 3 : code === 0x2a ? 5 : 0;
}

// refs.c `check_refname_format` with REFNAME_ALLOW_ONELEVEL. `pattern` is REFNAME_REFSPEC_PATTERN: one `*` in the whole name.
function refnameOk(name: string, pattern: boolean): boolean {
  if (name === "@") return false;
  let star = pattern;
  for (const component of name.split("/")) {
    if (component === "" || component.startsWith(".") || component.endsWith(".lock")) return false;
    let last = 0;
    for (let i = 0; i < component.length; i++) {
      const code = component.charCodeAt(i);
      const d = disposition(code);
      if (d === 4 || (d === 2 && last === 0x2e) || (d === 3 && last === 0x40)) return false;
      if (d === 5) {
        if (!star) return false;
        star = false;
      }
      last = code;
    }
  }
  return !name.endsWith(".");
}

const HEX_LENGTH: Record<ObjectFormat, number> = { sha1: 40, sha256: 64 };

// refspec.c `parse_refspec` for fetch. Null: Git refuses the refspec, so every Git command that reads the remotes stops.
function parseFetchRefspec(value: string | null, objectFormat: ObjectFormat): Refspec | null {
  if (value === null) return null;
  const negative = value.startsWith("^");
  const lhs = negative || value.startsWith("+") ? value.slice(1) : value;
  const colon = lhs.lastIndexOf(":");
  if (negative && colon >= 0) return null;
  const left = colon < 0 ? lhs : lhs.slice(0, colon);
  const dst = colon < 0 ? null : lhs.slice(colon + 1);
  let pattern = dst !== null && dst.includes("*");
  if (left.includes("*")) {
    if ((dst !== null && !pattern) || (dst === null && !negative)) return null;
    pattern = true;
  } else if (pattern) return null;
  const src = left === "@" ? "HEAD" : left;
  // `get_oid_hex` reads upper and lower case.
  const hex = left.length === HEX_LENGTH[objectFormat] && /^[0-9a-fA-F]+$/.test(left);
  if (negative) return src !== "" && !hex && refnameOk(src, pattern) ? { negative, src, dst, pattern } : null;
  if (src !== "" && !hex && !refnameOk(src, pattern)) return null;
  if (dst !== null && dst !== "" && !refnameOk(dst, pattern)) return null;
  return { negative, src, dst, pattern };
}

// remote.c `match_name_with_pattern`: the text that the `*` of `key` matches, put into the `*` of `value`.
function matchPattern(key: string, name: string, value: string): string | null {
  const star = key.indexOf("*");
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  if (!name.startsWith(prefix) || name.length < prefix.length + suffix.length || !name.endsWith(suffix)) return null;
  const valueStar = value.indexOf("*");
  return value.slice(0, valueStar) + name.slice(prefix.length, name.length - suffix.length) + value.slice(valueStar + 1);
}

const matchesNegative = (name: string, negatives: readonly Refspec[]) => negatives.some((n) => (n.pattern ? matchPattern(n.src, name, n.src) !== null : n.src === name));

// The sources that the refspecs of one remote map `remoteRef` to.
function remoteSources(remoteRef: string, specs: readonly Refspec[]): string[] {
  const positive = specs.filter((s) => !s.negative);
  const negatives = specs.filter((s) => s.negative);
  // remote.c `query_matches_negative_refspec`: the reversed names of the positive refspecs, checked against each negative one.
  const reversed = positive.flatMap((s) => (s.pattern ? (matchPattern(s.dst ?? s.src, remoteRef, s.src) ?? []) : remoteRef === s.src ? [s.src] : []));
  if (reversed.some((name) => matchesNegative(name, negatives))) return [];
  return positive.flatMap((s) => (s.dst === null ? [] : s.pattern ? (matchPattern(s.dst, remoteRef, s.src) ?? []) : remoteRef === s.dst ? [s.src] : []));
}

type ConfigLines = readonly { key: string; value: string | null }[];

// remote.c `handle_config`: the fetch refspecs of each remote. Null: Git refuses one of them.
function fetchRefspecs(config: ConfigLines, objectFormat: ObjectFormat): Map<string, Refspec[]> | null {
  const remotes = new Map<string, Refspec[]>();
  for (const { key, value } of config) {
    if (!key.startsWith("remote.") || !key.endsWith(".fetch") || key.length < "remote..fetch".length) continue;
    const name = key.slice("remote.".length, -".fetch".length);
    // remote.c `handle_config` skips a remote name that starts with `/`.
    if (name.startsWith("/")) continue;
    const spec = parseFetchRefspec(value, objectFormat);
    if (spec === null) return null;
    remotes.set(name, [...(remotes.get(name) ?? []), spec]);
  }
  return remotes;
}

// Exactly one mapping to a `refs/heads/` source gives the local name. Zero or several give null (spec FR-013).
export function localNameOf(remoteRef: string, config: ConfigLines, objectFormat: ObjectFormat): string | null {
  const remotes = fetchRefspecs(config, objectFormat);
  if (remotes === null) return null;
  const sources = [...remotes.values()].flatMap((specs) => remoteSources(remoteRef, specs));
  return sources.length === 1 && sources[0]!.startsWith(HEADS) && sources[0]!.length > HEADS.length ? sources[0]!.slice(HEADS.length) : null;
}

// branch.c `dwim_branch_start` and `setup_tracking`: `--track` needs exactly one remote whose fetch refspecs map the start point (remote.c `query_refspecs`).
// Returns those remotes in configuration order. Null: Git refuses a fetch refspec.
export function trackingRemotes(remoteRef: string, config: ConfigLines, objectFormat: ObjectFormat): string[] | null {
  const remotes = fetchRefspecs(config, objectFormat);
  if (remotes === null) return null;
  return [...remotes].filter(([, specs]) => remoteSources(remoteRef, specs).length > 0).map(([name]) => name);
}

// ---- URL host (plan.md D13, git-fetch(1) "GIT URLS") ----

// `local`: "this computer". Null: no host from the URL grammar, such as a remote helper URL.
export type UrlHost = { host: string } | { local: true } | null;

const lowerAscii = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

// The host of `[user@]host[:port]`, with brackets around an IPv6 address kept.
function authorityHost(authority: string): string {
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const close = hostPort.startsWith("[") ? hostPort.indexOf("]") : -1;
  const end = close >= 0 ? close + 1 : hostPort.indexOf(":");
  return lowerAscii(end < 0 ? hostPort : hostPort.slice(0, end));
}

// `rules.hasDrivePrefix` is the rule of the Git platform: Git for Windows reads `C:` as a drive, POSIX Git does not.
// shortcut: Git for Windows also needs `is_valid_path` for a drive path; a path that it refuses reads as local here.
export function urlHost(url: string, rules: { hasDrivePrefix(path: string): boolean }): UrlHost {
  // transport.c `transport_get`: a remote helper URL (`urlHelper`) has no host that Git connects to, and `rsync:` stops Git.
  if (urlHelper(url) !== null || url.startsWith("rsync:")) return null;
  const scheme = /^[A-Za-z0-9][A-Za-z0-9+.-]*:\/\//.exec(url);
  if (scheme) return url.startsWith("file://") ? { local: true } : { host: authorityHost(/^[^/?#]*/.exec(url.slice(scheme[0].length))![0]) };
  // connect.c `url_is_local_not_ssh`: the scp form holds only when no slash comes before the first colon.
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon < 0 || (slash >= 0 && slash < colon) || rules.hasDrivePrefix(url)) return { local: true };
  // connect.c `host_end` and `parse_connect_url`: a host that starts with `[`, also after the first `@[`, ends at `]`.
  // The path starts at the next `:`. Null: no `:` right after `]`, or a `:` before the `[`, gives no host that the grammar names.
  const open = url.indexOf("@[") + 1;
  if (url[open] === "[") {
    const close = url.indexOf("]", open);
    return close > 0 && url[close + 1] === ":" && !url.slice(0, open).includes(":") ? { host: lowerAscii(url.slice(open, close + 1)) } : null;
  }
  return { host: authorityHost(url.slice(0, colon)) };
}

// RFC 4343: hosts compare without regard to ASCII letter case. A URL without a host compares as different.
export function sameHost(a: UrlHost, b: UrlHost): boolean {
  if (a === null || b === null) return false;
  if ("local" in a || "local" in b) return "local" in a && "local" in b;
  return a.host === b.host;
}
