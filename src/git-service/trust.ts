// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract §7 "Startup, trust, and environment": the trust listing, the read gate, the configuration fingerprint, and the trust operations.
// Upstream rules cite git-for-windows 49d759b (v2.56.0.windows.1), the revision of the T280 probe (research R5).

import { IdentityReply, TRUST_DIALOG_NAMES, type FileFact, type TrustAction, type TrustDetails, type TrustRecord } from "../contracts/channel";
import type { ConfigScope } from "../contracts/envelope";
import type { ErrorCode } from "../contracts/errors";
import {
  DIAGNOSTIC_RETAINED_BYTES_PER_STREAM,
  FILE_FACT_COMPONENT_UNITS,
  FILE_FACT_ENTRIES,
  GIT_PROCESS_DEADLINE_MS,
  IDENTITY_PATHS,
  TRUST_DIGEST_FILES,
  TRUST_INPUT_BYTES,
  TRUST_LINK_HOPS,
  TRUST_REPORT_ENTRIES,
  TRUST_REPORT_HOOKS,
} from "../contracts/limits";
import { NATIVE, PATH_RULES } from "../contracts/native-path";
import { wslIdentityPath } from "../contracts/wsl-route";
import { gitPathText } from "./wsl";
import { configListArgs, HOOK_EVENTS, hooksPathArgs } from "./commands";
import { worktreeConfigListArgs, worktreeHooksPathArgs } from "./workbench-commands";
import type { ReadInstallation } from "./snapshot";
import { createCollector, RunnerRefusal, type FileFactsRequest, type GitRunner, type WalkStop, type WslIndexResult, type WslRunner } from "./git-runner";
import { sameIdentity, type PhysicalIdentity } from "./identity";
import type { Workspace } from "./registration";

// ---- URL user information (contract §7) ----

// Contract §7 "URL user information": for each `://`, the authority runs to the next `/`, `?`, `#`, or the end.
// When it holds `@`, the text before its last `@` becomes `<redacted>`. Git `transport_anonymize_url` does the same for one URL (research R5).
export function redactUrlUserInfo(text: string): string {
  let out = "";
  let at = 0;
  for (let scheme = text.indexOf("://"); scheme >= 0; scheme = text.indexOf("://", scheme + 3)) {
    const start = scheme + 3;
    let end = start;
    while (end < text.length && text[end] !== "/" && text[end] !== "?" && text[end] !== "#") end++;
    const user = text.lastIndexOf("@", end - 1);
    if (user < start) continue;
    out += text.slice(at, start) + "<redacted>";
    at = user;
  }
  return out + text.slice(at);
}

// ---- Environment seam ----

// The service environment. Each Git child of the `read` policy keeps its `PATH`, `HOME`, and `GIT_CONFIG_*` values (src/contracts/git-environment.json).
export type ServiceEnvironment = Readonly<Record<string, string | undefined>>;

// Contract §7: environment names ignore case on Windows. `NATIVE.fold` gives that rule.
export function environmentValue(environment: ServiceEnvironment, name: string): string | undefined {
  const wanted = NATIVE.fold(name);
  for (const [key, value] of Object.entries(environment)) if (NATIVE.fold(key) === wanted && value !== undefined) return value;
  return undefined;
}

// ---- Git value parsers ----

// Git `parse.c` `git_parse_maybe_bool`: 1, 0, or -1 for a value that is no boolean. A key without `=` is true.
export function parseMaybeBool(value: string | null): -1 | 0 | 1 {
  if (value === null) return 1;
  // Git compares the words with `strcasecmp`, which folds only ASCII letters. ECMA-262 Canonicalize without the `u` flag never folds a non-ASCII character to ASCII.
  if (/^(?:|false|no|off)$/i.test(value)) return 0;
  if (/^(?:true|yes|on)$/i.test(value)) return 1;
  const number = parseConfigInt(value);
  return number === null ? -1 : number === 0 ? 0 : 1;
}

const INT_MAX = 2 ** 31 - 1;
// `get_unit_factor` compares the unit with `strcasecmp`, which folds only ASCII letters.
const UNIT: ReadonlyMap<string, number> = new Map([
  ["", 1],
  ["k", 1024],
  ["K", 1024],
  ["m", 1024 * 1024],
  ["M", 1024 * 1024],
  ["g", 1024 * 1024 * 1024],
  ["G", 1024 * 1024 * 1024],
]);

// `git_parse_int`: C `strtoimax` with base 0 (blanks, a sign, then hex, octal, or decimal digits), one optional unit, and the `int` range.
function parseConfigInt(value: string): number | null {
  const match = /^[ \t\n\v\f\r]*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)(.*)$/s.exec(value);
  if (!match) return null;
  const [, sign, digits, rest] = match as unknown as [string, string, string, string];
  const factor = UNIT.get(rest);
  if (factor === undefined) return null;
  const magnitude = /^0[xX]/.test(digits) ? BigInt(digits) : digits.length > 1 && digits.startsWith("0") ? BigInt(`0o${digits.slice(1)}`) : BigInt(digits);
  const signed = (sign === "-" ? -magnitude : magnitude) * BigInt(factor);
  if (signed > BigInt(INT_MAX) || signed < BigInt(-INT_MAX - 1)) return null;
  return Number(signed);
}

// POSIX XCU 2.4 reserved words and XCU 2.14 special built-ins, and `command`. Each can run another command that this rule does not see.
const SHELL_WORDS = new Set([
  "!", "{", "}", "case", "do", "done", "elif", "else", "esac", "fi", "for", "if", "in", "then", "until", "while",
  "break", ":", "continue", ".", "eval", "exec", "exit", "export", "readonly", "return", "set", "shift", "times", "trap", "unset", "command",
]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// XCU 2.6.2: a `$NAME` or `${NAME}` parameter expansion. It runs no program. -1: any other expansion.
const PARAMETER = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/;
const parameterEnd = (line: string, at: number): number => {
  const match = PARAMETER.exec(line.slice(at));
  return match === null ? -1 : at + match[0].length;
};

// The program word of a shell command line (POSIX XCU 2.2 quoting and 2.3 token recognition), after quote removal.
// Git runs these values through `sh -c` when they hold a shell metacharacter (run-command.c `prepare_shell_cmd`), and runs a plain word directly.
// Null: an expansion, an operator, a pattern, or a compound command can start a program that the service cannot name.
// `parameters`: after the program word, a parameter expansion of `parameterEnd` passes.
export function shellProgram(line: string, parameters = false): string | null {
  let i = 0;
  while (line[i] === " " || line[i] === "\t") i++;
  let word = "";
  let plain = true;
  for (; i < line.length && line[i] !== " " && line[i] !== "\t"; i++) {
    const c = line[i]!;
    if (c === "\\") {
      if (i + 1 >= line.length || line[i + 1] === "\n") return null;
      word += line[++i];
      plain = false;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      word += line.slice(i + 1, end);
      i = end;
      plain = false;
    } else if (c === '"') {
      const quoted = doubleQuoted(line, i);
      if (quoted === null) return null;
      word += quoted.text;
      i = quoted.end;
      plain = false;
    } else if ("|&;<>()$`\n*?[".includes(c) || (word === "" && plain && (c === "~" || c === "#"))) {
      return null;
    } else if (c === "=" && plain && NAME.test(word)) {
      // XCU 2.9.1: `NAME=value` before the command is an assignment, so the program comes later.
      return null;
    } else {
      word += c;
    }
  }
  if (word === "" || (plain && SHELL_WORDS.has(word))) return null;
  // A later operator or expansion starts more programs.
  for (; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") i++;
    else if (c === "'") {
      i = line.indexOf("'", i + 1);
      if (i < 0) return null;
    } else if (c === '"') {
      const quoted = doubleQuoted(line, i, parameters);
      if (quoted === null) return null;
      i = quoted.end;
    } else if (c === "$" && parameters) {
      i = parameterEnd(line, i) - 1;
      if (i < 0) return null;
    } else if ("|&;<>()$`\n".includes(c)) return null;
  }
  return word;
}

// XCU 2.2.3: inside double quotes, `\` escapes only `$`, `` ` ``, `"`, `\`, and newline. `$` and `` ` `` expand, so they give null.
// `parameters`: a parameter expansion of `parameterEnd` passes, and the text holds it as written.
function doubleQuoted(line: string, open: number, parameters = false): { text: string; end: number } | null {
  let text = "";
  for (let i = open + 1; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') return { text, end: i };
    if (c === "$" && parameters) {
      const end = parameterEnd(line, i);
      if (end < 0) return null;
      text += line.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "$" || c === "`") return null;
    if (c === "\\" && i + 1 < line.length && '$`"\\\n'.includes(line[i + 1]!)) {
      if (line[i + 1] === "\n") return null;
      text += line[++i];
    } else text += c;
  }
  return null;
}

// alias.c `split_cmdline`: the first argument. Git `isspace` is space, TAB, LF, and CR (ctype.c).
function splitCmdlineProgram(line: string): string | null {
  let word = "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "" && " \t\n\r".includes(c)) break;
    if (quote === "" && (c === "'" || c === '"')) quote = c;
    else if (c === quote) quote = "";
    else if (c === "\\" && quote !== "'") {
      if (++i >= line.length) return null;
      word += line[i];
    } else word += c;
  }
  return quote === "" && word !== "" ? word : null;
}

// path.c `interpolate_path`: `~/` takes `HOME`. `~user/` and `%(prefix)/` need facts that the service does not hold, so they give null.
function interpolatePath(value: string, home: string | undefined): string | null {
  if (value.startsWith("%(prefix)/")) return null;
  if (!value.startsWith("~")) return value;
  const slash = value.indexOf("/");
  if (slash !== 1 && !(slash < 0 && value.length === 1)) return null;
  return home === undefined ? null : home + (slash < 0 ? "" : value.slice(slash));
}

// ---- Listing ----

const SCOPES: ReadonlySet<string> = new Set(["system", "global", "local", "worktree", "command", "submodule", "unknown"]);
// Git `config.c` `config_origin_type_name`.
const ORIGIN_TYPES = ["file:", "blob:", "standard input:", "submodule-blob:", "command line:"];

export interface ConfigEntry {
  scope: ConfigScope;
  // As Git prints it, such as `file:.git/config` or `command line:`. A local origin is relative to the worktree root.
  origin: string;
  key: string;
  // Null for a key without `=`.
  value: string | null;
  // False when the origin or the value bytes are no valid UTF-8, so the decoded text is not the text that Git uses.
  exact: boolean;
  // The unredacted bytes of the origin and of the key and value field. The fingerprint covers them.
  originBytes: Uint8Array;
  keyValueBytes: Uint8Array;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossy = new TextDecoder("utf-8", { ignoreBOM: true });
const decode = (bytes: Uint8Array): { text: string; exact: boolean } => {
  try {
    return { text: utf8.decode(bytes), exact: true };
  } catch {
    return { text: lossy.decode(bytes), exact: false };
  }
};

// `config list --show-scope --show-origin -z`: scope NUL origin NUL key, then LF and the value when it has one, then NUL (builtin/config.c).
// `truncated` drops an incomplete last entry. Null: the output is not that format.
export function parseConfigListing(bytes: Uint8Array, truncated: boolean): ConfigEntry[] | null {
  const entries: ConfigEntry[] = [];
  let at = 0;
  while (at < bytes.length) {
    const ends: number[] = [];
    for (let from = at; ends.length < 3; ) {
      const nul = bytes.indexOf(0, from);
      if (nul < 0) break;
      ends.push(nul);
      from = nul + 1;
    }
    if (ends.length < 3) return truncated ? entries : null;
    const [scopeEnd, originEnd, entryEnd] = ends as [number, number, number];
    const scope = decode(bytes.subarray(at, scopeEnd)).text;
    const originBytes = bytes.subarray(scopeEnd + 1, originEnd);
    const keyValueBytes = bytes.subarray(originEnd + 1, entryEnd);
    const origin = decode(originBytes);
    const keyValue = decode(keyValueBytes);
    const lf = keyValue.text.indexOf("\n");
    const key = lf < 0 ? keyValue.text : keyValue.text.slice(0, lf);
    if (!SCOPES.has(scope) || !ORIGIN_TYPES.some((type) => origin.text.startsWith(type)) || key === "") return null;
    entries.push({
      scope: scope as ConfigScope,
      origin: origin.text,
      key,
      value: lf < 0 ? null : keyValue.text.slice(lf + 1),
      exact: origin.exact && keyValue.exact,
      originBytes,
      keyValueBytes,
    });
    at = entryEnd + 1;
  }
  return entries;
}

export interface KeyParts {
  section: string;
  subsection: string | null;
  variable: string;
}

// Git `parse_config_key`: the section ends at the first dot and the variable starts after the last dot. Git prints both in lowercase.
export function keyParts(key: string): KeyParts | null {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first <= 0 || last === key.length - 1) return null;
  return { section: key.slice(0, first), subsection: first === last ? null : key.slice(first + 1, last), variable: key.slice(last + 1) };
}

// Contract §7 "Value display allowlist".
export function valueShown(p: KeyParts): boolean {
  const { section, subsection, variable } = p;
  if (section === "filter") return subsection !== null && (variable === "clean" || variable === "process" || variable === "smudge");
  if (section === "core") return subsection === null && ["fsmonitor", "hookspath", "sshcommand", "gitproxy", "askpass"].includes(variable);
  if (section === "hook") return subsection !== null && variable === "command";
  if (section === "diff") return subsection === null ? variable === "external" : variable === "textconv" || variable === "command";
  if (section === "gpg") return variable === "program" || (subsection === "ssh" && variable === "defaultkeycommand");
  // Feature 003 contract Δ7: the transport programs and the PuTTY key proposal (O-8).
  if (section === "credential") return variable === "helper";
  if (section === "remote") return subsection !== null && ["uploadpack", "receivepack", "puttykeyfile", "vcs"].includes(variable);
  // Feature 004 contract Δ7: the merge driver keys and the merge tool keys.
  if (section === "merge") return subsection === null ? variable === "tool" : variable === "driver" || variable === "recursive";
  if (section === "mergetool") return subsection !== null && (variable === "cmd" || variable === "path");
  return false;
}

// Contract §7 "Submodule registration keys": the fingerprint omits them.
function submoduleRegistration(p: KeyParts, value: string | null): boolean {
  if (p.section !== "submodule" || p.subsection === null) return false;
  return p.variable === "url" || p.variable === "active" || (p.variable === "update" && !(value ?? "").startsWith("!"));
}

// How Git starts the program of a key. `shell`: `use_shell`. `monitor`: a path value that runs with `use_shell` (fsmonitor-settings.c).
// `pathname`: `git_config_pathname`, run directly (gpg-interface.c). `split`: `split_cmdline` (gpg-interface.c).
// `credential`: credential.c `run_credential_helper` runs each helper with `use_shell`. A `!` value is a shell snippet, an absolute path runs as written, and any other name becomes `git credential-<name>` (gitcredentials(7)).
// `direct`: `git_config_string`, run without the shell (prompt.c `do_askpass`). `proxy`: connect.c `git_proxy_command_options` takes the text before " for ", and `git_proxy_connect` runs it without the shell.
// `helper`: transport-helper.c runs `git remote-<name>` (`git_cmd`), so the program word is `git`, as for a `credential-<name>` helper.
// `toolcmd`: git-mergetool--lib `setup_user_tool` runs `( eval $merge_tool_cmd )` (`toolCommandProgram`).
type ProgramForm = "shell" | "monitor" | "pathname" | "split" | "credential" | "direct" | "proxy" | "helper" | "toolcmd";

// The unquoted expansion splits the value into fields at IFS and expands each pattern (XCU 2.6.5, 2.6.6). So a `*`, `?`, or `[` can bring
// repository file names into the text that `eval` reads, and a set IFS gives fields that the service cannot know. Without either, `eval` reads
// the fields joined by spaces. Git sets `$BASE`, `$LOCAL`, `$REMOTE`, and `$MERGED` for the command (git-mergetool(1)), so parameters pass.
function toolCommandProgram(value: string, defaultIfs: boolean): string | null {
  const fields = value.split(/[ \t\n]+/).filter((field) => field !== "");
  return defaultIfs && !fields.some((field) => /[*?[]/.test(field)) ? shellProgram(fields.join(" "), true) : null;
}

// transport.c `transport_get` (Git 2.56) takes the first match: a `<name>::` prefix (`is_urlschemechar`), `rsync:` (no helper), a local bundle file,
// then `!is_url(url)` or the prefixes `file://`, `git://`, `ssh://`, `git+ssh://`, and `ssh+git://` (Git's own transport).
// Any other `<scheme>://` URL runs `git remote-<scheme>` (`external_specification_len`). Makefile `REMOTE_CURL_NAMES` installs Git's own helpers
// for `http`, `https`, `ftp`, and `ftps`, so they do not count. A one-letter scheme is a DOS drive path that can name a bundle file
// (url.c `url_is_local_not_ssh`). It counts, because the service reads no such file. `starts_with` compares case-sensitively, so `HTTPS://` counts.
// Plan.md D11 accepts both over-reports. Null: no helper.
const SCHEME = /^[A-Za-z0-9][A-Za-z0-9+.-]*/;
const BUILTIN_TRANSPORTS = ["file://", "git://", "ssh://", "git+ssh://", "ssh+git://"];
const CURL_HELPERS: ReadonlySet<string> = new Set(["http", "https", "ftp", "ftps"]);
export function urlHelper(url: string): string | null {
  const scheme = SCHEME.exec(url)?.[0] ?? "";
  if (url.startsWith(`${scheme}::`)) return scheme;
  if (url.startsWith("rsync:") || scheme === "" || !url.startsWith(`${scheme}://`) || BUILTIN_TRANSPORTS.some((prefix) => url.startsWith(prefix))) return null;
  return CURL_HELPERS.has(scheme) ? null : scheme;
}

// Feature 003 plan.md D11: true when an entry of the `helper` form counts. A `remote.<name>.vcs` value names the helper. A remote URL counts by
// `urlHelper`. remote.c rewrites remote URLs with each `url.<base>.insteadOf` and `pushInsteadOf` entry, and the service does not copy that
// rewrite. So such an entry counts with any base and any value, also an empty one.
function selectsHelper(p: KeyParts, value: string): boolean {
  return p.section === "url" || p.variable === "vcs" || urlHelper(value) !== null;
}

// Contract §7: the read blocking class and the "Mutation trust" `commit` class. A configured hook joins `commit` through its events.
// Feature 003 plan.md D11: the `sync` class. Feature 004 plan.md D12: the `workbench` class.
interface ProgramKey {
  form: ProgramForm;
  reads: boolean;
  commit: boolean;
  sync: boolean;
  workbench: boolean;
  mergetool: boolean;
}

// The classes of a transport program: only `sync` (feature 003 plan.md D11).
const TRANSPORT = { reads: false, commit: false, sync: true, workbench: false, mergetool: false } as const;
// Feature 004 plan.md D12: a merge tool key takes only the class `mergetool`.
const MERGE_TOOL = { reads: false, commit: false, sync: false, workbench: false, mergetool: true } as const;

// Contract §12 "Trust" and feature 003 plan.md D11: the transport programs that a fetch or a push can run (probe S6).
// git-config(1): Git runs `core.sshCommand` and `remote.<name>.uploadpack` through the shell.
function programKey(p: KeyParts): ProgramKey | null {
  const { section, subsection, variable } = p;
  if (section === "core" && subsection === null && variable === "sshcommand") return { form: "shell", ...TRANSPORT };
  if (section === "core" && subsection === null && variable === "askpass") return { form: "direct", ...TRANSPORT };
  if (section === "core" && subsection === null && variable === "gitproxy") return { form: "proxy", ...TRANSPORT };
  if (section === "remote" && subsection !== null && (variable === "uploadpack" || variable === "receivepack")) return { form: "shell", ...TRANSPORT };
  if (section === "credential" && variable === "helper") return { form: "credential", ...TRANSPORT };
  // Feature 003 plan.md D11: a remote helper. Only an entry that `selectsHelper` becomes a program.
  if ((section === "remote" && subsection !== null && (variable === "vcs" || variable === "url" || variable === "pushurl")) || (section === "url" && subsection !== null && (variable === "insteadof" || variable === "pushinsteadof"))) {
    return { form: "helper", ...TRANSPORT };
  }
  // Feature 003 plan.md D11: fetch-pack.c `for_each_alternate_ref` runs it with `use_shell` (`fill_alternate_refs_command`). A probe saw no 001 read or commit run it.
  if (section === "core" && subsection === null && variable === "alternaterefscommand") return { form: "shell", ...TRANSPORT };
  // Feature 003 plan.md D11 and feature 004 plan.md D12: ll-merge.c `ll_ext_merge` runs a merge driver with `use_shell`, so a merge or a rebase can run it.
  if (section === "merge" && subsection !== null && variable === "driver") return { form: "shell", reads: false, commit: false, sync: true, workbench: true, mergetool: false };
  // Feature 004 plan.md D12: git-mergetool--lib runs a built-in tool program by a bare name, so the 001 §7 PATH rule takes the `merge.tool` value.
  // The script runs `mergetool.<tool>.cmd` with `eval`, and `mergetool.<tool>.path` as one quoted word (git-mergetool--lib, mergetools/*).
  if (section === "merge" && subsection === null && variable === "tool") return { form: "direct", ...MERGE_TOOL };
  if (section === "mergetool" && subsection !== null && variable === "cmd") return { form: "toolcmd", ...MERGE_TOOL };
  if (section === "mergetool" && subsection !== null && variable === "path") return { form: "direct", ...MERGE_TOOL };
  // Research.md R9: the mergetool script runs `checkout-index` and `git add`, so each filter and the monitor can run there.
  if (section === "filter" && subsection !== null) {
    if (variable === "clean" || variable === "process") return { form: "shell", reads: true, commit: true, sync: true, workbench: true, mergetool: true };
    if (variable === "smudge") return { form: "shell", reads: false, commit: false, sync: true, workbench: true, mergetool: true };
  }
  if (section === "core" && subsection === null && variable === "fsmonitor") return { form: "monitor", reads: true, commit: true, sync: true, workbench: true, mergetool: true };
  if (section === "hook" && subsection !== null && variable === "command") return { form: "shell", reads: false, commit: false, sync: false, workbench: false, mergetool: false };
  if (section === "diff" && (subsection === null ? variable === "external" : variable === "textconv" || variable === "command")) return { form: "shell", reads: false, commit: false, sync: false, workbench: false, mergetool: false };
  if (section === "gpg" && variable === "program") return { form: "pathname", reads: false, commit: true, sync: true, workbench: true, mergetool: false };
  if (section === "gpg" && subsection === "ssh" && variable === "defaultkeycommand") return { form: "split", reads: false, commit: true, sync: true, workbench: true, mergetool: false };
  return null;
}

// connect.c `git_proxy_command_options`: the command is the text before the first " for ", and "none" names no proxy.
function proxyText(value: string): string {
  const at = value.indexOf(" for ");
  return at < 0 ? value : value.slice(0, at);
}
function proxyCommand(value: string): string {
  const command = proxyText(value);
  return command === "none" ? "" : command;
}

export type Program = { kind: "path"; text: string } | { kind: "bare"; name: string } | { kind: "unresolved" };

function programOf(form: ProgramForm, value: string, home: string | undefined, rules: Rules, defaultIfs: boolean): Program {
  let word: string | null;
  if (form === "shell") word = shellProgram(value);
  else if (form === "toolcmd") word = toolCommandProgram(value, defaultIfs);
  else if (form === "credential") word = value.startsWith("!") ? shellProgram(value.slice(1)) : rules.isAbsolute(value) ? shellProgram(value) : "git";
  else if (form === "split") word = splitCmdlineProgram(value);
  else if (form === "direct") word = value;
  else if (form === "proxy") word = proxyCommand(value);
  else if (form === "helper") word = "git";
  else {
    const path = interpolatePath(value, home);
    word = path === null ? null : form === "monitor" ? shellProgram(path) : path;
  }
  if (word === null || word === "") return { kind: "unresolved" };
  return rules.separator.test(word) ? { kind: "path", text: word } : { kind: "bare", name: word };
}

// ---- Repository-controlled resolution (contract §7) ----

// The path rules of a listing. A WSL workspace takes the POSIX rules (contract §11 "Trust and environment").
type Rules = typeof NATIVE;

interface Layout {
  rules: Rules;
  // The worktree root is the directory where each `registeredOperation` Git process runs (contract §6 "Process fields").
  root: string;
  pathEntries: string[];
  relativeEntries: string[];
  home: string | undefined;
  // The Git child gets no IFS, so its shell splits fields at space, TAB, and LF (XCU 2.5.3).
  defaultIfs: boolean;
}

const resolveIn = (layout: Layout, path: string) => layout.rules.path.resolve(layout.root, path);
const folded = (rules: Rules, path: string) => rules.fold(rules.path.resolve(path));

// The file of a `file:` origin, resolved against the directory where Git ran. Null for another origin type.
function originFile(entry: ConfigEntry, layout: Layout): string | null {
  return entry.origin.startsWith("file:") ? resolveIn(layout, entry.origin.slice("file:".length)) : null;
}

// The relative child `PATH` entries in order. Both the control rule and the bare-name lookup take them from here.
// An empty entry takes `emptyPathEntry`. run-command.c `locate_in_PATH` and Git for Windows `path_lookup` find no program in an empty `PATH`.
export function relativePathEntries(path: string | undefined, rules: typeof NATIVE = NATIVE): string[] {
  if (path === undefined || path === "") return [];
  const out: string[] = [];
  for (const raw of path.split(rules.path.delimiter)) {
    const entry = raw === "" ? rules.emptyPathEntry : raw;
    if (entry !== null && !rules.isAbsolute(entry)) out.push(entry);
  }
  return out;
}
const repositoryScope = (entry: ConfigEntry) => entry.scope === "local" || entry.scope === "worktree";

// The three program rules. A program that the service cannot name counts as repository-controlled.
function programControlled(program: Program, layout: Layout, inside: (path: string) => boolean): boolean {
  if (program.kind === "path") return inside(resolveIn(layout, program.text));
  if (program.kind === "bare") return layout.relativeEntries.length > 0;
  return true;
}

// ---- Inside and outside (contract §7) ----

// One `fileFacts` entry: a root of the workspace and the name components below it (contract §6 "File facts").
export type FactEntry = FileFactsRequest["files"][number];
type RootName = FactEntry["root"];
// On equal components, the first root in this order wins.
const ROOT_NAMES: readonly RootName[] = ["worktreeRoot", "gitDirectory", "commonDirectory"];

interface Roots {
  rules: Rules;
  paths: Record<RootName, string>;
  components: Record<RootName, string[]>;
}

// The components of an absolute path after text normalization. A file system root, such as `/`, keeps one component.
function componentsOf(path: string, rules: Rules): string[] {
  const parts = rules.path.resolve(path).split(rules.separator);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const pathOf = (parts: readonly string[], rules: Rules): string => (parts.length === 1 ? parts[0]! + rules.path.sep : parts.join(rules.path.sep));

function rootsOf(paths: Record<RootName, string>, rules: Rules): Roots {
  const components = { worktreeRoot: componentsOf(paths.worktreeRoot, rules), gitDirectory: componentsOf(paths.gitDirectory, rules), commonDirectory: componentsOf(paths.commonDirectory, rules) };
  return { rules, paths, components };
}

// One listing view of a workspace: the path rules, the roots in their form, the child `PATH` and `HOME`, and the path of an identity request.
interface View {
  rules: Rules;
  roots: Record<RootName, string>;
  path: string | undefined;
  home: string | undefined;
  defaultIfs: boolean;
  // Contract §6 "Process fields": an identity request names a Windows path. Null: the path has no such form.
  identityPath: (path: string) => string | null;
}

// Contract §11 "Trust and environment": a WSL workspace lists with the POSIX rules on the Linux paths of its distro, because Linux Git prints those.
// Its roots hold the `wslIdentityPath` form `\\wsl.localhost\<distro>\<name>…`, so the Linux path is `/` and the names after the distro.
// The bare-name rule takes the `PATH` of the Git probe. The probe reads no `HOME`, so a `~/` value stays unresolved.
// The probe reads no IFS either, so the IFS of a WSL Git child stays unknown.
function viewOf(w: Workspace, environment: ServiceEnvironment): View {
  const roots = { worktreeRoot: w.worktreeRoot, gitDirectory: w.gitDirectory, commonDirectory: w.commonDirectory };
  if (w.wsl === undefined) {
    return { rules: NATIVE, roots, path: environmentValue(environment, "PATH"), home: environmentValue(environment, "HOME"), defaultIfs: environmentValue(environment, "IFS") === undefined, identityPath: (path) => path };
  }
  const { distro, pathEnv } = w.wsl;
  const linux = (unc: string) => `/${unc.split("\\").slice(4).join("/")}`;
  return {
    rules: PATH_RULES.posix,
    roots: { worktreeRoot: linux(roots.worktreeRoot), gitDirectory: linux(roots.gitDirectory), commonDirectory: linux(roots.commonDirectory) },
    path: pathEnv,
    home: undefined,
    defaultIfs: false,
    identityPath: (path) => wslIdentityPath(distro, path),
  };
}

// `below`: the components below the root. An empty list names the root itself.
type Inside = { inside: true; root: RootName; below: string[] };
type Place = Inside | { inside: false };

const outside: Place = { inside: false };

// Contract §7: by text, a path lies under a root when its components start with the components of the root. The longest matching root wins.
// The Windows `fold` folds only the ASCII letters. A text match proves "inside" only. It never proves "outside".
function textPlace(parts: readonly string[], roots: Roots): Place {
  let best: RootName | null = null;
  for (const name of ROOT_NAMES) {
    const base = roots.components[name];
    if (base.length > parts.length || (best !== null && base.length <= roots.components[best].length)) continue;
    if (base.every((part, i) => roots.rules.fold(part) === roots.rules.fold(parts[i]!))) best = name;
  }
  return best === null ? outside : { inside: true, root: best, below: parts.slice(roots.components[best].length) };
}

// The service never opens a repository-controlled path outside the roots. Such a path takes only this rule.
const placeByText = (path: string, roots: Roots): Place => textPlace(componentsOf(path, roots.rules), roots);

const pathAt = (roots: Roots, at: Inside): string => roots.rules.path.join(roots.paths[at.root], ...at.below);

// The path and each text ancestor, deepest first, with the components below each one.
function ancestry(path: string, rules: Rules): { path: string; below: string[] }[] {
  const chain = [{ path, below: [] as string[] }];
  for (let at = path, parent = rules.path.dirname(at); parent !== at; at = parent, parent = rules.path.dirname(at)) {
    chain.push({ path: parent, below: [rules.path.basename(at), ...chain[chain.length - 1]!.below] });
  }
  return chain;
}

type PlaceFailure = { ok: false; stop: WalkStop["stop"] } | { ok: false; code: ErrorCode };

// Contract §7 "Inside and outside" for protected paths.
function createPlaces(runner: GitRunner, target: ListingTarget, roots: Roots, identityPath: View["identityPath"]) {
  const { workspace: w, operationId, signal } = target;
  const identities: { root: RootName; identity: PhysicalIdentity }[] = [
    { root: "worktreeRoot", identity: w.worktreeIdentity[0] },
    { root: "gitDirectory", identity: w.worktreeIdentity[1] },
    { root: "commonDirectory", identity: w.commonIdentity },
  ];
  const context = { contextKind: "registeredOperation" as const, gitInstallationId: w.gitInstallationId, repositoryId: w.repositoryId };
  // Null: the shell reported the path absent. Only a not-found open gives that reason (contract §6 "Process fields").
  // `foreign`: the path exists on a file system that holds no root.
  const replies = new Map<string, PhysicalIdentity | "foreign" | null>();
  const places = new Map<string, Place>();

  // The deepest ancestor with a root identity maps the path below that root.
  // Without a match, the path is outside only when each absent reply names a deeper path than each identity reply.
  // An absent reply for an ancestor of an existing path shows a change during the requests.
  function placeOf(path: string): Place | null {
    const chain = ancestry(path, roots.rules);
    for (const { path: at, below } of chain) {
      const identity = replies.get(at);
      const root = typeof identity === "object" && identity !== null ? identities.find((r) => sameIdentity(r.identity, identity)) : undefined;
      if (root !== undefined) return { inside: true, root: root.root, below };
    }
    const first = chain.findIndex(({ path: at }) => replies.get(at) !== null);
    return first < 0 || chain.slice(first).every(({ path: at }) => replies.get(at) !== null) ? outside : null;
  }

  return {
    // A path under a root by text gets no request. A UNC or device path gets no request and stays outside, as a location only.
    async decide(paths: readonly string[]): Promise<PlaceFailure | null> {
      if (signal.aborted) return { ok: false, stop: "canceled" };
      const open = [...new Set(paths)].filter((path) => !places.has(path));
      const asked = new Set<string>();
      for (const path of open) {
        const text = placeByText(path, roots);
        if (text.inside) places.set(path, text);
        else if (roots.rules.isUncOrDevice(path)) places.set(path, outside);
        else for (const { path: at } of ancestry(path, roots.rules)) if (!replies.has(at)) asked.add(at);
      }
      // Contract §6 "Process fields": one identity request carries at most 8 paths.
      // Each asked path with the path form of its request.
      const forms: [string, string][] = [];
      for (const path of asked) {
        const form = identityPath(path);
        // A path without a request form has no identity, so its place stays unknown.
        if (form === null) return { ok: false, code: "REPOSITORY_UNAVAILABLE" };
        forms.push([path, form]);
      }
      const chunks: [string, string][][] = [];
      for (let at = 0; at < forms.length; at += IDENTITY_PATHS) chunks.push(forms.slice(at, at + IDENTITY_PATHS));
      // Every chunk settles before the decision ends, so no identity call outlives the listing.
      const settled = await Promise.allSettled(chunks.map((chunk) => runner.identities(operationId, context, chunk.map(([, form]) => form), signal)));
      const answers: (unknown[] | WalkStop)[] = [];
      for (const result of settled) {
        if (result.status === "fulfilled") answers.push(result.value);
        else if (result.reason instanceof RunnerRefusal) return { ok: false, code: result.reason.code };
        else throw result.reason;
      }
      if (signal.aborted) return { ok: false, stop: "canceled" };
      for (const [i, chunk] of chunks.entries()) {
        const answer = answers[i]!;
        if (!Array.isArray(answer)) return { ok: false, stop: answer.stop };
        // Contract §6 "Errors": a malformed reply fails the call with PROCESS_OWNERSHIP_FAILED.
        if (answer.length !== chunk.length) return { ok: false, code: "PROCESS_OWNERSHIP_FAILED" };
        for (const [j, [path]] of chunk.entries()) {
          const reply = IdentityReply.safeParse(answer[j]);
          if (!reply.success) return { ok: false, code: "PROCESS_OWNERSHIP_FAILED" };
          // An identity of another form or another distro can never match a root, so the reply is malformed.
          const data = reply.data;
          if (!("code" in data) && (w.wsl === undefined ? "distroGuid" in data : !("distroGuid" in data) || data.distroGuid !== w.wsl.guid)) {
            return { ok: false, code: "PROCESS_OWNERSHIP_FAILED" };
          }
          // T212 decision W10: WSL roots lie on ext4 (contract §11), so a path on another file system cannot alias a root.
          const foreign = w.wsl !== undefined && "code" in reply.data && (reply.data.reason === "mixed-location" || reply.data.reason === "no-fs-uuid");
          // Any other identity error leaves the place unknown, so the listing fails as an unknown identity does below.
          if ("code" in reply.data && reply.data.reason !== "absent" && !foreign) return { ok: false, code: "REPOSITORY_UNAVAILABLE" };
          replies.set(path, foreign ? "foreign" : "code" in reply.data ? null : reply.data);
        }
      }
      for (const path of open) {
        if (places.has(path)) continue;
        const place = placeOf(path);
        // Contract §7 "Program file digests" ends the listing with REPOSITORY_UNAVAILABLE for an `error` fact. An unknown identity gets the same code.
        if (place === null) return { ok: false, code: "REPOSITORY_UNAVAILABLE" };
        places.set(path, place);
      }
      return null;
    },
    at(path: string): Place {
      const place = places.get(path);
      if (place === undefined) throw new Error(`trust listing: no place decided for ${path}`);
      return place;
    },
  };
}

// ---- Hook registrations (contract §7, research R5 "T280 record") ----

// Contract §7 "Mutation trust": the hook events that `git commit` can run.
const COMMIT_EVENTS: ReadonlySet<string> = new Set(["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change", "reference-transaction", "pre-auto-gc"]);
// Feature 003 plan.md D11: the hook events that fetch, push, merge, rebase, and Continue can run.
const SYNC_EVENTS: ReadonlySet<string> = new Set([...COMMIT_EVENTS, "pre-push", "pre-merge-commit", "post-merge", "post-checkout", "pre-rebase", "post-rewrite"]);
// Feature 004 plan.md D12 `workbench`: the hook events that switch, the branch actions, merge, and rebase can run.
const WORKBENCH_EVENTS: ReadonlySet<string> = new Set([
  "post-checkout",
  "post-merge",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-rewrite",
  "reference-transaction",
  "post-index-change",
  "pre-auto-gc",
]);
const KNOWN_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENTS);

export interface ConfiguredHook {
  event: string;
  name: string;
  // The scope of the last `hook.<name>.event` entry, as `git hook list --show-scope` prints it.
  eventScope: ConfigScope;
  // False when the bytes of that entry are no valid UTF-8, so `event` is not the text that Git uses.
  eventExact: boolean;
  // The last `hook.<name>.command` entry. Git runs its value from any scope (hook.c `hook_config_lookup_all`).
  command: ConfigEntry | null;
  disabled: boolean;
  eventDisabled: boolean;
}

export interface FolderHook {
  event: string;
  path: string;
}

// unsorted_string_list_delete_item (string-list.c) moves the last item into the freed slot.
function removeName(list: { name: string; scope: ConfigScope; exact: boolean }[], name: string): void {
  const i = list.findIndex((item) => item.name === name);
  if (i < 0) return;
  list[i] = list[list.length - 1]!;
  list.pop();
}

// hook.c `hook_config_lookup_all` and `build_hook_config_map`. `fatal`: every `git hook` call and hook run dies, so no hook runs.
// The derivation still lists each registration, so the approval rule stays conservative.
export function configuredHooks(entries: readonly ConfigEntry[]): { hooks: ConfiguredHook[]; fatal: boolean } {
  const events = new Map<string, { name: string; scope: ConfigScope; exact: boolean }[]>();
  const commands = new Map<string, ConfigEntry>();
  const disabled = new Set<string>();
  const parallel = new Set<string>();
  let fatal = false;
  for (const entry of entries) {
    const parts = keyParts(entry.key);
    if (parts === null || parts.section !== "hook" || parts.subsection === null) continue;
    const { subsection: name, variable } = parts;
    if (entry.value === null) {
      fatal = true;
      continue;
    }
    if (variable === "event") {
      if (entry.value === "") {
        for (const list of events.values()) removeName(list, name);
        continue;
      }
      if (KNOWN_EVENTS.has(name)) fatal = true;
      const list = events.get(entry.value) ?? [];
      removeName(list, name);
      list.push({ name, scope: entry.scope, exact: entry.exact });
      events.set(entry.value, list);
    } else if (variable === "command") commands.set(name, entry);
    else if (variable === "enabled") {
      const enabled = parseMaybeBool(entry.value);
      if (enabled === 0) disabled.add(name);
      if (enabled === 1) disabled.delete(name);
    } else if (variable === "parallel" && parseMaybeBool(entry.value) >= 0) parallel.add(name);
  }
  // hook.c `is_friendly_name`: a name with a command, a parallel flag, or an event. Another disabled name switches off its event.
  const friendly = (name: string) => commands.has(name) || parallel.has(name) || [...events.values()].some((list) => list.some((h) => h.name === name));
  const disabledEvents = new Set([...disabled].filter((name) => !friendly(name)));
  const order = [...HOOK_EVENTS.filter((event) => events.has(event)), ...[...events.keys()].filter((event) => !KNOWN_EVENTS.has(event))];
  const hooks: ConfiguredHook[] = [];
  for (const event of order) {
    for (const { name, scope, exact } of events.get(event)!) {
      const command = commands.get(name) ?? null;
      if (command === null && !disabled.has(name)) fatal = true;
      hooks.push({ event, name, eventScope: scope, eventExact: exact, command, disabled: disabled.has(name), eventDisabled: disabledEvents.has(event) });
    }
  }
  return { hooks, fatal };
}

// ---- Program file facts (contract §6 "File facts", §7 "Program file digests") ----

// Contract §7 "Program file digests" and §12 "Trust": only a submodule listing still reads digests (feature 004 contract Δ7 and Δ12).
type TrustBound = "file-count" | "file-bytes" | "total-bytes" | "link" | "name" | "worktree";
export type FileState = { kind: "digest"; digest: string } | { kind: "absent" } | { kind: "unchecked"; bound: TrustBound };

// Contract §8 "Change check": one phase-1 `fileFacts` entry of a trust listing, with its fact.
// The change check sends `root` and `path` again with `digest: false`. Any difference in a fact changes the tuple.
export interface ProgramFile {
  root: RootName;
  path: string[];
  fact: FileFact;
}

type FinalFact = Exclude<FileFact, { kind: "link" | "error" }>;
type LinkFact = Extract<FileFact, { kind: "link" }>;
// The target text of one link. Null: tag `other`, which carries no text.
type Hop = string | null;
// One phase-1 path after link resolution (contract §7 fact table). `unresolved` names the bound of an entry without a final fact.
type Walked =
  | { kind: "fact"; at: Inside; fact: FinalFact; hops: Hop[] }
  | { kind: "outside"; location: string; hops: Hop[] }
  | { kind: "unresolved"; bound: "link" | "name" | "worktree"; hops: Hop[] };

type ListingFailure = Exclude<ListingOutcome, { ok: true }>;

// Contract §6 "Index digest in a read": only a WSL listing calls `indexedFileFacts`.
type ListingRunner = GitRunner & Partial<Pick<WslRunner, "indexedFileFacts">>;

// The `index` of the first phase-1 request, and the receiver of its result.
interface IndexAsk {
  request: { sharedIndex?: string };
  got(result: WslIndexResult): void;
}

// Contract §7 "Program file digests": the text names the path and the `code` of an `error` fact, never an OS message text.
const unreadable = (path: string, reason: string): ListingFailure => ({
  ok: false,
  code: "REPOSITORY_UNAVAILABLE",
  text: `Arbareto cannot read ${redactUrlUserInfo(path)}: ${reason}.`,
});
// A phase-2 fact that is no file: the entry changed after its phase-1 fact.
const CHANGED = "the file changed during the read";

// Contract §6 "File facts" component rule: 1 to 255 UTF-16 units, no lone surrogate, and the native name rule.
export const isComponent = (name: string) => name.length >= 1 && name.length <= FILE_FACT_COMPONENT_UNITS && name.isWellFormed() && NATIVE.isComponent(name);

// Entries that differ only in ASCII letter case name one file on Windows, so the key folds as the Windows `fold` does.
const keyOf = (at: Inside, rules: Rules) => JSON.stringify([at.root, ...at.below.map(rules.fold)]);

// Contract §7 "Program file digests": one link hop, by text. Null: the link cannot be resolved.
function follow(at: Inside, link: LinkFact, roots: Roots): Inside | { inside: false; location: string } | null {
  if (link.target === undefined) return null;
  // The folder of the link, and the components of the entry after the link.
  const folder = [...roots.components[at.root], ...at.below.slice(0, link.component - 1)];
  const rest = at.below.slice(link.component);
  let parts: string[];
  if (link.relative) {
    const names = link.target.split(roots.rules.separator);
    // A run of `..` components may start the target. A later `..`, a `.`, and an empty or root-relative start break the component rule.
    let up = 0;
    while (names[up] === "..") up++;
    // A `..` above the file system root names no folder.
    if (up >= folder.length || !names.slice(up).every(isComponent)) return null;
    parts = [...folder.slice(0, folder.length - up), ...names.slice(up)];
  } else {
    // `linkTarget` maps the absolute target text. Contract §7: a UNC target and an unmapped form cannot be resolved.
    const mapped = roots.rules.linkTarget(link.target);
    if (mapped === null || roots.rules.isUncOrDevice(mapped)) return null;
    // The first component is the drive or the empty name before the root separator.
    const names = mapped.split(roots.rules.separator);
    if (!names.slice(1).every(isComponent)) return null;
    parts = names;
  }
  const full = [...parts, ...rest];
  const place = textPlace(full, roots);
  if (!place.inside) return { inside: false, location: pathOf(full, roots.rules) };
  return place.below.every(isComponent) ? place : null;
}

// A place that needs no `fileFacts` entry. A root is a directory: git-rev-parse(1) prints it for `--show-toplevel` or `--git-dir`.
// Contract §6 "File facts" refuses a component that breaks its rule, so such a place gets `unchecked` with bound `name`.
function settled(at: Inside, hops: Hop[]): Walked | null {
  if (at.below.length === 0) return { kind: "fact", at, fact: { kind: "directory" }, hops };
  return at.below.every(isComponent) ? null : { kind: "unresolved", bound: "name", hops };
}

// Contract §5 "File facts": at most 64 entries per request. A refusal keeps its code, and a walk stop ends the requests.
// `index` goes with the first request only.
export async function requestFacts(
  runner: ListingRunner,
  operationId: string,
  w: Workspace,
  digest: boolean,
  files: readonly FactEntry[],
  signal: AbortSignal,
  index?: IndexAsk,
): Promise<FileFact[] | { code: ErrorCode } | WalkStop> {
  const context = { operationId, contextKind: "registeredOperation" as const, gitInstallationId: w.gitInstallationId, repositoryId: w.repositoryId };
  const out: FileFact[] = [];
  for (let i = 0; i < files.length; i += FILE_FACT_ENTRIES) {
    const chunk = files.slice(i, i + FILE_FACT_ENTRIES).map(({ root, path }) => ({ root, path: [...path] }));
    let reply: FileFact[] | WalkStop;
    try {
      if (i === 0 && index !== undefined) {
        if (runner.indexedFileFacts === undefined) throw new Error("trust listing: the runner has no indexedFileFacts");
        const indexed = await runner.indexedFileFacts({ ...context, digest, files: chunk, index: index.request }, signal);
        if ("stop" in indexed) reply = indexed;
        else {
          index.got(indexed.index);
          reply = indexed.facts;
        }
      } else reply = await runner.fileFacts({ ...context, digest, files: chunk }, signal);
    } catch (error) {
      if (error instanceof RunnerRefusal) return { code: error.code };
      throw error;
    }
    if (!Array.isArray(reply)) return reply;
    // Contract §6 "Errors": a malformed reply fails the call with PROCESS_OWNERSHIP_FAILED.
    if (reply.length !== chunk.length) return { code: "PROCESS_OWNERSHIP_FAILED" };
    out.push(...reply);
  }
  return out;
}

// Contract §8 "Change check": the facts of the program-file entries of a listing, read again with phase-1 requests.
// Null: a refusal, a malformed reply, or an `error` fact. Then no compare can prove that nothing changed.
// A walk stop is no unknown fact. It ends the check with the outcome of its step (contract §5 "Deadline outcomes").
export async function readProgramFiles(runner: GitRunner, operationId: string, w: Workspace, files: readonly ProgramFile[], signal: AbortSignal): Promise<FileFact[] | WalkStop | null> {
  const reply = await requestFacts(runner, operationId, w, false, files, signal);
  if (!Array.isArray(reply)) return "stop" in reply ? reply : null;
  return reply.every((fact) => fact.kind !== "error") ? reply : null;
}

// Contract §7 "Program file digests". The service reads repository-controlled program and hook paths only through these requests.
function createFactReader(runner: ListingRunner, target: ListingTarget, roots: Roots) {
  const { workspace: w, operationId, signal } = target;
  const facts = new Map<string, FileFact>();
  // Contract §8 "Change check": each phase-1 entry with its fact, in request order.
  const programFiles: ProgramFile[] = [];
  // Contract §6 "Index digest in a read": the first phase-1 request carries `index`.
  let indexResult: WslIndexResult | undefined;
  let indexAsk: IndexAsk | undefined = target.index && { request: target.index, got: (result) => void (indexResult = result) };

  async function send(digest: boolean, places: readonly Inside[]): Promise<FileFact[] | ListingFailure> {
    if (signal.aborted) return { ok: false, stop: "canceled" };
    const ask = digest ? undefined : indexAsk;
    if (!digest) indexAsk = undefined;
    const reply = await requestFacts(runner, operationId, w, digest, places.map((at) => ({ root: at.root, path: at.below })), signal, ask);
    if (signal.aborted) return { ok: false, stop: "canceled" };
    if (Array.isArray(reply)) return reply;
    return "stop" in reply ? { ok: false, stop: reply.stop } : { ok: false, code: reply.code };
  }

  // Phase 1 (`digest: false`) for each place without a fact.
  async function ask(places: readonly Inside[]): Promise<ListingFailure | null> {
    const open = new Map<string, Inside>();
    for (const at of places) if (!facts.has(keyOf(at, roots.rules))) open.set(keyOf(at, roots.rules), at);
    const pending = [...open.values()];
    const reply = await send(false, pending);
    if (!Array.isArray(reply)) return reply;
    for (const [i, at] of pending.entries()) {
      facts.set(keyOf(at, roots.rules), reply[i]!);
      programFiles.push({ root: at.root, path: [...at.below], fact: reply[i]! });
    }
    return null;
  }

  return {
    programFiles,
    // The `index` result of the first phase-1 request. Undefined when no phase-1 request ran.
    index: () => indexResult,

    // Phase 1. Each link adds one request round, at most 8 hops (contract §5). The result maps the `keyOf` key of each start.
    async walk(starts: readonly Inside[]): Promise<Map<string, Walked> | ListingFailure> {
      // Plan.md O-20: the `fileFacts` roots name the registered worktree, so a listing `at` another worktree reads only below the common directory.
      // A place below the own roots of that worktree stays unresolved, so it counts as listed and found.
      const place = (at: Inside, hops: Hop[]): Walked | null =>
        target.at === undefined || at.root === "commonDirectory" || at.below.length === 0 ? settled(at, hops) : { kind: "unresolved", bound: "worktree", hops };
      const states = new Map<string, { at: Inside; hops: Hop[]; done: Walked | null }>();
      for (const at of starts) if (!states.has(keyOf(at, roots.rules))) states.set(keyOf(at, roots.rules), { at, hops: [], done: place(at, []) });
      for (let round = 0; round <= TRUST_LINK_HOPS; round++) {
        const open = [...states.values()].filter((s) => s.done === null);
        if (open.length === 0) break;
        const failure = await ask(open.map((s) => s.at));
        if (failure !== null) return failure;
        for (const s of open) {
          const fact = facts.get(keyOf(s.at, roots.rules))!;
          if (fact.kind === "error") return unreadable(pathAt(roots, { ...s.at, below: s.at.below.slice(0, fact.component) }), fact.code);
          if (fact.kind !== "link") {
            s.done = { kind: "fact", at: s.at, fact, hops: s.hops };
            continue;
          }
          s.hops.push(fact.target ?? null);
          const next = s.hops.length > TRUST_LINK_HOPS ? null : follow(s.at, fact, roots);
          if (next === null) s.done = { kind: "unresolved", bound: "link", hops: s.hops };
          else if (!next.inside) s.done = { kind: "outside", location: next.location, hops: s.hops };
          else {
            s.at = next;
            s.done = place(next, s.hops);
          }
        }
      }
      return new Map([...states].map(([key, s]) => [key, s.done ?? { kind: "unresolved", bound: "link", hops: s.hops }]));
    },

    // Phase 2 (`digest: true`): the resolved files in fingerprint order. The 64-file bound keeps them in one request.
    async digests(files: readonly Inside[]): Promise<FileFact[] | ListingFailure> {
      return files.length === 0 ? [] : send(true, files);
    },
  };
}

// Contract §7 fact table, column "Listed as a hook". hook.c `find_hook`: POSIX Git lists an entry after `access(X_OK)`.
// Git for Windows lists each existing entry.
function listedHook(walked: Walked, rules: Rules): boolean {
  if (walked.kind !== "fact") return true;
  const { fact } = walked;
  if (fact.kind === "absent") return false;
  if (!rules.executeBit) return true;
  return (fact.kind === "file" || fact.kind === "directory") && fact.executable === true;
}

// run-command.c `is_executable` (POSIX) and compat/mingw.c `lookup_prog` (Windows). POSIX Git tests only the `S_IXUSR` bit, never `access(X_OK)`.
// A link outside the roots, or one that cannot be resolved, counts as found, because Git can start its target.
function programFound(walked: Walked, suffixed: boolean, rules: Rules): boolean {
  if (walked.kind !== "fact") return true;
  const { fact } = walked;
  if (fact.kind === "absent") return false;
  if (rules.executeBit) return fact.kind === "file" && fact.ownerExecute === true;
  return suffixed || fact.kind !== "directory";
}

// Contract §7 "Program file digests": the bare-name candidates in each relative child `PATH` entry, resolved against the worktree root.
function bareCandidates(name: string, layout: Layout): { entry: string; candidates: { path: string; suffixed: boolean }[] }[] {
  const { rules } = layout;
  const suffixes = rules.programSuffixes.filter((suffix) => suffix === "" || !rules.fold(name).endsWith(rules.fold(suffix)));
  const out: { entry: string; candidates: { path: string; suffixed: boolean }[] }[] = [];
  for (const entry of layout.relativeEntries) {
    out.push({ entry, candidates: suffixes.map((suffix) => ({ path: rules.path.resolve(layout.root, entry, name + suffix), suffixed: suffix !== "" })) });
  }
  return out;
}

interface BareLookup {
  // The relative entries up to the entry of the found candidate.
  relative: string[];
  // The candidate as resolved, and its phase-1 result.
  found: string | null;
  walked: Walked | null;
}

// Only candidates inside the roots have phase-1 results. A candidate outside the roots stays a location only.
function lookupBareName(name: string, layout: Layout, placeOf: (path: string) => Place, walkedAt: (at: Inside) => Walked): BareLookup {
  const relative: string[] = [];
  for (const { entry, candidates } of bareCandidates(name, layout)) {
    relative.push(entry);
    for (const { path, suffixed } of candidates) {
      const place = placeOf(path);
      if (!place.inside) continue;
      const walked = walkedAt(place);
      if (programFound(walked, suffixed, layout.rules)) return { relative, found: path, walked };
    }
  }
  return { relative, found: null, walked: null };
}

// ---- Fingerprint ----

// SHA-256 over tagged, length-prefixed fields. No field can shift into the next one.
class Digest {
  private readonly hasher = new Bun.CryptoHasher("sha256");
  private length(n: number): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(n));
    this.hasher.update(bytes);
    return this;
  }
  field(tag: string, value: string | Uint8Array | boolean | null): this {
    const tagBytes = Buffer.from(tag, "utf8");
    this.length(tagBytes.length).hasher.update(tagBytes);
    if (value === null) return this.length(0).length(0);
    const bytes = value instanceof Uint8Array ? value : Buffer.from(String(value), "utf8");
    this.length(1).length(bytes.length).hasher.update(bytes);
    return this;
  }
  hex(): string {
    return this.hasher.digest("hex");
  }
}

const fileValue = (state: FileState) => (state.kind === "digest" ? state.digest : state.kind);

// ---- Contract §8 "Change check" candidates ----

export interface ChangeFiles {
  // Each configuration origin file and each candidate configuration file. A path can name an absent file.
  configPaths: string[];
  // Each phase-1 `fileFacts` entry of the listing with its fact. The service reads these paths only through `fileFacts` (`readProgramFiles`).
  programFiles: ProgramFile[];
  // False when a candidate needs a fact that the service does not hold, such as the `git var` lines or `HOME`. A change check then cannot prove "no change".
  complete: boolean;
}

// Git `config.c` `do_git_config_sequence` and `handle_path_include`, resolved from the `git var` lines, the environment seam, and the listing.
// `configFiles` holds the kept `git var` lines of the installation (contract §7 "Configuration file paths"). Git already applied its overrides to them.
function configPaths(entries: readonly ConfigEntry[], roots: Roots, layout: Layout, configFiles: readonly string[] | undefined): { paths: string[]; complete: boolean } {
  const { rules } = layout;
  const paths: string[] = [];
  let complete = true;
  const add = (path: string) => paths.push(resolveIn(layout, path));
  for (const entry of entries) {
    const file = originFile(entry, layout);
    if (file !== null) paths.push(file);
  }
  if (configFiles === undefined) complete = false;
  else for (const file of configFiles) add(file);
  add(rules.path.join(roots.paths.commonDirectory, "config"));
  // Contract §8: `config.worktree` is a candidate when `extensions.worktreeConfig` is set.
  if (entries.some((e) => e.key === "extensions.worktreeconfig" && parseMaybeBool(e.value) === 1)) add(rules.path.join(roots.paths.gitDirectory, "config.worktree"));
  for (const entry of entries) {
    const parts = keyParts(entry.key);
    if (parts === null || parts.variable !== "path" || !(parts.section === "include" ? parts.subsection === null : parts.section === "includeif" && parts.subsection !== null)) continue;
    if (entry.value === null) continue;
    const target = interpolatePath(entry.value, layout.home);
    const file = originFile(entry, layout);
    if (target === null || !entry.exact) complete = false;
    else if (rules.isAbsolute(target)) add(target);
    // A relative include needs a file origin. Git refuses another one.
    else if (file !== null) paths.push(rules.path.resolve(rules.path.dirname(file), target));
  }
  const seen = new Set<string>();
  return { paths: paths.filter((path) => !seen.has(folded(rules, path)) && seen.add(folded(rules, path))), complete };
}

// ---- The listing ----

export interface ProgramIntegration {
  key: string;
  entry: ConfigEntry;
  program: Program;
  repositoryControlled: boolean;
  reads: boolean;
  commit: boolean;
  sync: boolean;
  workbench: boolean;
  mergetool: boolean;
}

export interface HookView {
  configured: (ConfiguredHook & { repositoryControlled: boolean })[];
  folder: (FolderHook & { repositoryControlled: boolean })[];
  fatal: boolean;
}

export interface TrustListing {
  entries: ConfigEntry[];
  // `rev-parse --git-path hooks` resolved against the worktree root. Null when the input bound cut it.
  hooksDirectory: string | null;
  hooks: HookView;
  integrations: ProgramIntegration[];
  // Data-model §3 `configurationFingerprint`. Feature 004 contract Δ7: a repository listing covers the phase-1 fact kind of each program file, not its bytes.
  // No trust approval binds it. The policy fingerprint and the review tokens bind it.
  fingerprint: string;
  // Contract §5 "Effective configuration/trust input": overflow blocks approval, so reads and `commit` need an approval that cannot come.
  inputLimited: boolean;
  approvalRequired: { reads: boolean; commit: boolean; sync: boolean; workbench: boolean; mergetool: boolean };
  // Feature 004 data-model §10 `programs` and contract Δ6 `details`.
  programs: TrustDetails;
  changeFiles: ChangeFiles;
  // The file state of each integration and each folder hook, in list order. Null: the file lies outside the roots, the integration is not repository-controlled,
  // or the listing reads no digests. Only a submodule listing reads digests (contract §12 "Trust").
  files: { integrations: (FileState | null)[]; folder: (FileState | null)[] };
  // Contract §12 "Trust": a submodule listing whose repository-controlled hooks folder lies outside the roots. It lists no hook of that folder.
  hooksOutside?: true;
  // Contract §11 "Change polling": the index digest of the first phase-1 request, when the target asked for it.
  index?: WslIndexResult;
}

export interface ListingTarget {
  operationId: string;
  signal: AbortSignal;
  workspace: Workspace;
  // Contract §6 "Index digest in a read": only a WSL `readWorkspace` sets it.
  index?: { sharedIndex?: string };
  // Plan.md O-20: another worktree of the registered repository, as its record path names it. Git lists there with `-C`.
  // `workspace` then holds the roots and identities of that worktree. The shell serves `fileFacts` only below the registered roots.
  at?: string;
}

// `text` names the path and the reason of a file failure.
export type ListingOutcome = { ok: true; listing: TrustListing } | { ok: false; stop: "canceled" | "deadline" } | { ok: false; code: ErrorCode; text?: string };

const NEWLINE = 0x0a;

// Contract §7 "Hook registrations": the trust listing starts two Git processes and no `hook list`. Neither runs a filter or loads the index.
// `configFiles` holds the kept `git var` lines of the workspace installation, or undefined when the installation keeps none.
export async function listTrust(runner: ListingRunner, target: ListingTarget, environment: ServiceEnvironment, configFiles: readonly string[] | undefined): Promise<ListingOutcome> {
  const { workspace, operationId, signal } = target;
  const context = { contextKind: "registeredOperation" as const, gitInstallationId: workspace.gitInstallationId, repositoryId: workspace.repositoryId };
  const call = (args: string[]) => {
    const stdout = createCollector({ maxBytes: TRUST_INPUT_BYTES });
    const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
    const exit = runner.run({ operationId, context, arguments: args, environmentPolicy: "read", limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS }, stdout, stderr, signal });
    return exit.then((value) => ({ exit: value, stdout }));
  };
  const refused = (reason: unknown): ListingOutcome => {
    if (reason instanceof RunnerRefusal) return { ok: false, code: reason.code };
    throw reason;
  };
  // A refusal of one call still waits for the other, so no listing process outlives the listing.
  const at = target.at;
  const [configCall, hooksCall] = await Promise.allSettled([call(at === undefined ? configListArgs() : worktreeConfigListArgs(at)), call(at === undefined ? hooksPathArgs() : worktreeHooksPathArgs(at))]);
  if (configCall.status === "rejected") return refused(configCall.reason);
  if (hooksCall.status === "rejected") return refused(hooksCall.reason);
  const [config, hooks] = [configCall.value, hooksCall.value];
  if (signal.aborted) return { ok: false, stop: "canceled" };
  if (config.exit.deadline || hooks.exit.deadline) return { ok: false, stop: "deadline" };
  if (config.exit.diagnosticLimit || hooks.exit.diagnosticLimit) return { ok: false, code: "OUTPUT_LIMIT" };
  const inputLimited = config.stdout.limited || hooks.stdout.limited || config.stdout.bytes + hooks.stdout.bytes > TRUST_INPUT_BYTES;
  if (!config.stdout.limited && config.exit.exitCode !== 0) return { ok: false, code: "GIT_FAILED" };
  if (!hooks.stdout.limited && hooks.exit.exitCode !== 0) return { ok: false, code: "GIT_FAILED" };
  const entries = parseConfigListing(config.stdout.take(), config.stdout.limited);
  if (entries === null) return { ok: false, code: "MALFORMED_GIT_OUTPUT" };
  let hooksText: string | null = null;
  if (!hooks.stdout.limited) {
    const raw = hooks.stdout.take();
    const text = raw.length > 1 && raw[raw.length - 1] === NEWLINE ? decode(raw.subarray(0, -1)) : null;
    if (text === null || !text.exact || text.text.includes("\n")) return { ok: false, code: "MALFORMED_GIT_OUTPUT" };
    hooksText = text.text;
  }
  return buildListing(runner, target, entries, hooksText, inputLimited, viewOf(workspace, environment), configFiles);
}

// Contract §12 "Trust": the listing of a submodule Git directory from its own `config list` output. `root` is the folder where Git runs its programs.
// `hooksDirectory` is the absolute hooks folder, or null. The workspace roots decide inside and outside.
// A path below `gitDirectory` but outside the roots is repository-controlled, as a location only (contract §6 "File facts").
// A null `gitDirectory`: a `clone` row before its clone.
export function listSubmoduleTrust(
  runner: ListingRunner,
  target: ListingTarget,
  environment: ServiceEnvironment,
  entries: ConfigEntry[],
  hooksDirectory: string | null,
  submodule: { root: string; gitDirectory: string | null },
): Promise<ListingOutcome> {
  return buildListing(runner, target, entries, hooksDirectory, false, viewOf(target.workspace, environment), undefined, submodule);
}

async function buildListing(
  runner: ListingRunner,
  target: ListingTarget,
  entries: ConfigEntry[],
  hooksText: string | null,
  inputLimited: boolean,
  view: View,
  configFiles: readonly string[] | undefined,
  submodule?: { root: string; gitDirectory: string | null },
): Promise<ListingOutcome> {
  const { rules, path } = view;
  const roots = rootsOf(view.roots, rules);
  const layout: Layout = {
    rules,
    root: submodule?.root ?? roots.paths.worktreeRoot,
    pathEntries: path === undefined || path === "" ? [] : path.split(rules.path.delimiter),
    relativeEntries: relativePathEntries(path, rules),
    home: view.home,
    defaultIfs: view.defaultIfs,
  };
  // Contract §7: resolve the printed directory against the directory where Git ran.
  const hooksDirectory = hooksText === null ? null : resolveIn(layout, hooksText);
  const places = createPlaces(runner, target, roots, view.identityPath);
  const placeFor = (at: string, controlled: boolean): Place => (controlled ? placeByText(at, roots) : places.at(at));
  // Contract §12 "Trust": a submodule Git directory outside the roots is repository-controlled by its Git-printed text. The service reads nothing there.
  const ownGitDirectory = submodule?.gitDirectory == null ? null : componentsOf(submodule.gitDirectory, rules);
  const inOwnGitDirectory = (at: string): boolean => {
    if (ownGitDirectory === null) return false;
    const parts = componentsOf(at, rules);
    return ownGitDirectory.length <= parts.length && ownGitDirectory.every((part, i) => rules.fold(part) === rules.fold(parts[i]!));
  };
  const inRepository = (at: string): boolean => places.at(at).inside || inOwnGitDirectory(at);

  // Contract §7 "Repository-controlled resolution", the two entry rules. An origin that Git printed in another encoding counts as inside.
  // The origin places decide which values are repository-controlled. So they come before the identity requests for those values.
  const origins: string[] = [];
  for (const entry of entries) {
    const file = repositoryScope(entry) || !entry.exact ? null : originFile(entry, layout);
    if (file !== null) origins.push(file);
  }
  const originFailure = await places.decide(origins);
  if (originFailure !== null) return originFailure;
  const entryControlled = (entry: ConfigEntry): boolean => {
    if (repositoryScope(entry)) return true;
    const file = originFile(entry, layout);
    return file !== null && (!entry.exact || inRepository(file));
  };

  // The last entry of a key wins (Git `config.c` `git_config_get_value`). An empty value names no program.
  const last = new Map<string, ConfigEntry>();
  for (const entry of entries) last.set(entry.key, entry);
  const programs: { entry: ConfigEntry; kind: ProgramKey; program: Program; controlled: boolean }[] = [];
  for (const entry of entries) {
    const parts = keyParts(entry.key);
    const kind = parts && programKey(parts);
    // Git runs every `credential.helper` value in order (credential.c), so each one counts. The `core.gitProxy` entry that matches the host decides, so each one counts too.
    // Each remote URL, `vcs`, and `insteadOf` entry counts. An empty value of the `helper` form can still count (`selectsHelper`).
    const each = kind !== null && (kind.form === "credential" || kind.form === "proxy" || kind.form === "helper");
    if (!kind || (!each && last.get(entry.key) !== entry) || entry.value === null || (entry.value === "" && kind.form !== "helper")) continue;
    if (kind.form === "proxy" && proxyCommand(entry.value) === "") continue;
    if (kind.form === "helper" && !selectsHelper(parts!, entry.value)) continue;
    // fsmonitor-settings.c: a boolean `core.fsmonitor` names the built-in daemon, not a command (contract §7).
    if (kind.form === "monitor" && parseMaybeBool(entry.value) !== -1) continue;
    const program = entry.exact ? programOf(kind.form, entry.value, layout.home, rules, layout.defaultIfs) : ({ kind: "unresolved" } as const);
    programs.push({ entry, kind, program, controlled: entryControlled(entry) });
  }
  const hooksPath = last.get("core.hookspath");
  const hooksPathControlled = hooksPath !== undefined && entryControlled(hooksPath);

  // Contract §7 "Inside and outside": each protected path outside every root by text gets an identity request.
  const protectedPaths: string[] = [];
  for (const { program, controlled } of programs) {
    if (controlled) continue;
    if (program.kind === "path") protectedPaths.push(resolveIn(layout, program.text));
    else if (program.kind === "bare") for (const { candidates } of bareCandidates(program.name, layout)) protectedPaths.push(...candidates.map((c) => c.path));
  }
  if (hooksDirectory !== null && !hooksPathControlled) protectedPaths.push(hooksDirectory);
  const pathFailure = await places.decide(protectedPaths);
  if (pathFailure !== null) return pathFailure;

  const integrations: ProgramIntegration[] = programs.map(({ entry, kind, program, controlled }) => ({
    key: entry.key,
    entry,
    program,
    repositoryControlled: controlled || programControlled(program, layout, inRepository),
    reads: kind.reads,
    commit: kind.commit,
    sync: kind.sync,
    workbench: kind.workbench,
    mergetool: kind.mergetool,
  }));
  const programPlace = (i: number, at: string) => placeFor(at, programs[i]!.controlled);

  const derived = configuredHooks(entries);
  // A command entry without a program record, such as an empty value, counts as repository-controlled.
  const commandControlled = new Map(integrations.filter((i) => keyParts(i.key)?.section === "hook").map((i) => [i.entry, i.repositoryControlled]));
  const configured = derived.hooks.map((hook) => ({ ...hook, repositoryControlled: hook.command !== null && (commandControlled.get(hook.command) ?? true) }));

  // Contract §7 "Program file digests": phase 1 reads the hooks folder and each `<event>` with its native suffixes.
  // It also reads each bare-name candidate and each program path inside the roots. A folder outside every root gets no request.
  const folderPlace = hooksDirectory === null ? outside : placeFor(hooksDirectory, hooksPathControlled);
  // Contract §12 "Trust": a repository-controlled submodule hooks folder outside the roots enters the list as a location only.
  const hooksOutside = submodule !== undefined && hooksDirectory !== null && !folderPlace.inside && (hooksPathControlled || inOwnGitDirectory(hooksDirectory));
  const eventAt = (folder: Inside, name: string): Inside => ({ inside: true, root: folder.root, below: [...folder.below, name] });
  const starts: Inside[] = [];
  if (folderPlace.inside) {
    starts.push(folderPlace);
    for (const event of HOOK_EVENTS) for (const suffix of rules.hookSuffixes) starts.push(eventAt(folderPlace, event + suffix));
  }
  for (const [i, { repositoryControlled, program }] of integrations.entries()) {
    if (!repositoryControlled) continue;
    const paths = program.kind === "path" ? [resolveIn(layout, program.text)] : program.kind === "bare" ? bareCandidates(program.name, layout).flatMap((e) => e.candidates.map((c) => c.path)) : [];
    for (const path of paths) {
      const place = programPlace(i, path);
      if (place.inside) starts.push(place);
    }
  }
  const reader = createFactReader(runner, target, roots);
  const walked = await reader.walk(starts);
  if (!(walked instanceof Map)) return walked;
  const walkedAt = (at: Inside): Walked => {
    const found = walked.get(keyOf(at, rules));
    if (found === undefined) throw new Error(`trust listing: no phase-1 fact for ${pathAt(roots, at)}`);
    return found;
  };

  // A folder whose link resolves outside the roots, or cannot be resolved, lists no entry. Its location and hop texts enter the fingerprint.
  const folderWalk = folderPlace.inside ? walkedAt(folderPlace) : null;
  const listedFolder: { hook: FolderHook; walked: Walked }[] = [];
  if (folderPlace.inside && folderWalk!.kind === "fact") {
    for (const event of HOOK_EVENTS) {
      for (const suffix of rules.hookSuffixes) {
        const entry = walkedAt(eventAt(folderPlace, event + suffix));
        // hook.c `find_hook`: Git for Windows tries `<event>.exe` only when `<event>` does not exist.
        if (entry.kind === "fact" && entry.fact.kind === "absent") continue;
        if (listedHook(entry, rules)) listedFolder.push({ hook: { event, path: rules.path.join(hooksDirectory!, event + suffix) }, walked: entry });
        break;
      }
    }
  }
  // Only a folder inside a root lists entries, so each listed hook is repository-controlled.
  const folder = listedFolder.map(({ hook }) => ({ ...hook, repositoryControlled: true }));
  const folderUnlisted = folderWalk !== null && folderWalk.kind !== "fact";

  // Fingerprint order: program integrations in listing order, then hooks-folder hooks in event order.
  const lookups = new Map<ProgramIntegration, BareLookup>();
  const ordered: Walked[] = [];
  for (const [i, integration] of integrations.entries()) {
    if (!integration.repositoryControlled) continue;
    const { program } = integration;
    if (program.kind === "path") {
      const place = programPlace(i, resolveIn(layout, program.text));
      if (place.inside) ordered.push(walkedAt(place));
    } else if (program.kind === "bare") {
      const lookup = lookupBareName(program.name, layout, (at) => programPlace(i, at), walkedAt);
      lookups.set(integration, lookup);
      if (lookup.walked !== null) ordered.push(lookup.walked);
    }
  }
  for (const { walked: entry } of listedFolder) ordered.push(entry);

  // Contract §12 "Trust": a submodule listing digests its program files. Feature 004 contract Δ7: a repository listing runs no phase 2.
  const digests = submodule !== undefined;
  // Contract §7 "Program file digests": phase 2 digests at most 64 distinct `file` facts in fingerprint order. No other fact counts.
  const slots = new Map<string, number>();
  const phase2: Inside[] = [];
  for (const entry of digests ? ordered : []) {
    if (entry.kind !== "fact" || entry.fact.kind !== "file" || slots.has(keyOf(entry.at, rules))) continue;
    slots.set(keyOf(entry.at, rules), slots.size);
    if (slots.size <= TRUST_DIGEST_FILES) phase2.push(entry.at);
  }
  const digested = await reader.digests(phase2);
  if (!Array.isArray(digested)) return digested;
  const states = new Map<string, FileState>();
  for (const [i, at] of phase2.entries()) {
    const fact = digested[i]!;
    if (fact.kind === "error") return unreadable(pathAt(roots, { ...at, below: at.below.slice(0, fact.component) }), fact.code);
    if (fact.kind !== "file") return unreadable(pathAt(roots, at), CHANGED);
    // Contract §6 "File facts": with `digest: true`, a file fact holds `digest` or `bound`.
    if (fact.digest !== undefined) states.set(keyOf(at, rules), { kind: "digest", digest: fact.digest });
    else if (fact.bound !== undefined) states.set(keyOf(at, rules), { kind: "unchecked", bound: fact.bound });
    else return { ok: false, code: "PROCESS_OWNERSHIP_FAILED" };
  }
  const stateOf = (entry: Extract<Walked, { kind: "fact" }>): FileState => {
    if ((slots.get(keyOf(entry.at, rules)) ?? 0) >= TRUST_DIGEST_FILES) return { kind: "unchecked", bound: "file-count" };
    return states.get(keyOf(entry.at, rules)) ?? { kind: "absent" };
  };

  const digest = new Digest().field("format", "arbareto-trust-1").field("inputLimited", inputLimited);
  // Contract §7 fact table. Null: the file lies outside the roots, or the listing reads no digests.
  const fileFields = (entry: Walked): FileState | null => {
    for (const hop of entry.hops) digest.field("hop", hop);
    if (entry.kind === "outside") {
      digest.field("resolved", entry.location).field("file", "outside");
      return null;
    }
    // Feature 004 spec FR-071: a repository listing covers no file bytes, so an edit of a program file changes no fingerprint.
    // As phase 2 did, only a `file` fact counts as a file.
    if (!digests) {
      digest.field("file", entry.kind === "unresolved" ? "unchecked" : entry.fact.kind === "file" ? "file" : "absent");
      return null;
    }
    const state: FileState = entry.kind === "unresolved" ? { kind: "unchecked", bound: entry.bound } : stateOf(entry);
    digest.field("file", fileValue(state));
    return state;
  };
  const integrationFiles: (FileState | null)[] = integrations.map(() => null);
  const folderFiles: (FileState | null)[] = [];
  for (const entry of entries) {
    const parts = keyParts(entry.key);
    if (parts !== null && submoduleRegistration(parts, entry.value)) continue;
    digest.field("scope", entry.scope).field("origin", entry.originBytes).field("entry", entry.keyValueBytes);
  }
  digest.field("hooksDirectory", hooksDirectory);
  if (folderWalk !== null) {
    for (const hop of folderWalk.hops) digest.field("hooksFolderHop", hop);
    if (folderWalk.kind === "outside") digest.field("hooksFolderResolved", folderWalk.location);
    if (folderWalk.kind === "unresolved") digest.field("hooksFolder", "unchecked");
  }
  for (const [i, integration] of integrations.entries()) {
    if (!integration.repositoryControlled) continue;
    const { program } = integration;
    digest.field("integration", integration.key).field("program", program.kind);
    if (program.kind === "path") {
      const location = resolveIn(layout, program.text);
      const place = programPlace(i, location);
      digest.field("location", location);
      if (place.inside) integrationFiles[i] = fileFields(walkedAt(place));
      else digest.field("file", "outside");
    } else if (program.kind === "bare") {
      const lookup = lookups.get(integration)!;
      digest.field("name", program.name).field("path", layout.pathEntries.join(rules.path.delimiter));
      for (const entry of lookup.relative) digest.field("relativeEntry", entry);
      digest.field("found", lookup.found);
      if (lookup.walked === null) {
        digest.field("file", "absent");
        integrationFiles[i] = { kind: "absent" };
      } else integrationFiles[i] = fileFields(lookup.walked);
    }
  }
  for (const { hook, walked: entry } of listedFolder) {
    digest.field("hook", hook.event).field("location", hook.path);
    folderFiles.push(fileFields(entry));
  }

  const activeHooks = [...configured.filter((h) => !h.disabled && !h.eventDisabled), ...folder];
  const commitHooks = activeHooks.some((h) => COMMIT_EVENTS.has(h.event) && h.repositoryControlled);
  // Feature 003 plan.md D11: a repository-controlled `protocol.allow` or `protocol.<name>.allow` entry changes Git's transport policy.
  const protocolEntries = entries.filter((e) => {
    const p = keyParts(e.key);
    return p !== null && p.section === "protocol" && p.variable === "allow" && entryControlled(e);
  });
  const protocolControlled = protocolEntries.length > 0;
  const approvalRequired = {
    reads: inputLimited || integrations.some((i) => i.reads && i.repositoryControlled),
    commit: inputLimited || hooksPathControlled || folderUnlisted || commitHooks || integrations.some((i) => i.commit && i.repositoryControlled),
    sync: inputLimited || hooksPathControlled || folderUnlisted || protocolControlled || activeHooks.some((h) => SYNC_EVENTS.has(h.event) && h.repositoryControlled) || integrations.some((i) => i.sync && i.repositoryControlled),
    workbench: inputLimited || hooksPathControlled || folderUnlisted || activeHooks.some((h) => WORKBENCH_EVENTS.has(h.event) && h.repositoryControlled) || integrations.some((i) => i.workbench && i.repositoryControlled),
    // Feature 004 plan.md D12: the script runs `git add`, which can run `post-index-change` (research.md R9).
    mergetool: inputLimited || hooksPathControlled || folderUnlisted || activeHooks.some((h) => h.event === "post-index-change" && h.repositoryControlled) || integrations.some((i) => i.mergetool && i.repositoryControlled),
  };
  const config = configPaths(entries, roots, layout, configFiles);
  return {
    ok: true,
    listing: {
      entries,
      hooksDirectory,
      hooks: { configured, folder, fatal: derived.fatal },
      integrations,
      fingerprint: digest.hex(),
      inputLimited,
      approvalRequired,
      programs: programNames(activeHooks, hooksDirectory, integrations, [...(hooksPathControlled ? [hooksPath!] : []), ...protocolEntries]),
      changeFiles: { configPaths: config.paths, programFiles: reader.programFiles, complete: config.complete },
      files: { integrations: integrationFiles, folder: folderFiles },
      ...(hooksOutside ? { hooksOutside: true as const } : {}),
      ...(reader.index() === undefined ? {} : { index: reader.index() }),
    },
  };
}

// githooks(5) `post-rewrite`: `git commit --amend` runs it. The 001 class `commit` lists no such event, so an amend also needs approval for it.
export function rewriteHooks(listing: Pick<TrustListing, "hooks">): boolean {
  const { configured, folder } = listing.hooks;
  return [...configured.filter((h) => !h.disabled && !h.eventDisabled), ...folder].some((h) => h.event === "post-rewrite" && h.repositoryControlled);
}

// Plan.md D14: a name that is empty, that holds invalid UTF-8, or that holds a character of the Unicode general category Cc, Cf, Zl, or Zp
// shows as this text. Such a character, such as U+202E RIGHT-TO-LEFT OVERRIDE, can make a name read differently from its bytes.
export const UNSHOWN_NAME = "a name that Arbareto cannot show";
const UNSHOWN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// `exact`: false when the decoder replaced invalid UTF-8.
export const shownName = (text: string, exact = true): string => (!exact || text === "" || !text.isWellFormed() || UNSHOWN_CHARACTER.test(text) ? UNSHOWN_NAME : text);

// Feature 004 data-model §10 `programs` and contract Δ6 `details`: each repository-controlled program by name and scope, never a value.
// Every text is redacted (contract §7 "URL user information") and passes `shownName`. A kind lists at most 20 names, then the count of the others.
// `keys`: the repository-controlled `core.hooksPath` and `protocol.allow` entries, which need approval without a program of their own.
function programNames(
  hooks: readonly ((ConfiguredHook & { repositoryControlled: boolean }) | (FolderHook & { repositoryControlled: boolean }))[],
  hooksDirectory: string | null,
  integrations: readonly ProgramIntegration[],
  keys: readonly ConfigEntry[],
): TrustDetails {
  const kinds = {
    hooks: [] as TrustDetails["hooks"]["names"],
    filters: [] as TrustDetails["filters"]["names"],
    monitors: [] as TrustDetails["monitors"]["names"],
    mergeDrivers: [] as TrustDetails["mergeDrivers"]["names"],
    mergeTools: [] as TrustDetails["mergeTools"]["names"],
    signing: [] as TrustDetails["signing"]["names"],
    other: [] as TrustDetails["other"]["names"],
  };
  const seen = new Set<string>();
  // Two names that both show as UNSHOWN_NAME stay two names, so `add` compares the texts before `shownName`.
  const add = <K extends keyof typeof kinds>(kind: K, item: (typeof kinds)[K][number], exact: boolean) => {
    const key = JSON.stringify([kind, item, exact]);
    if (seen.has(key)) return;
    seen.add(key);
    (kinds[kind] as unknown[]).push(Object.fromEntries(Object.entries(item).map(([field, text]) => [field, field === "scope" ? text : shownName(text as string, exact)])));
  };
  for (const hook of hooks) {
    if (!hook.repositoryControlled) continue;
    // `listTrust` refuses a hooks folder text that is no valid UTF-8, and `HOOK_EVENTS` holds ASCII names only.
    if ("path" in hook) add("hooks", { event: hook.event, folder: redactUrlUserInfo(hooksDirectory!) }, true);
    else if (hook.command !== null) add("hooks", { event: redactUrlUserInfo(hook.event), scope: hook.command.scope }, hook.eventExact);
  }
  for (const { key, entry, repositoryControlled, reads, commit, sync, workbench } of integrations) {
    const p = keyParts(key);
    if (!repositoryControlled || p === null) continue;
    const { section, subsection, variable } = p;
    const { scope, exact } = entry;
    if (section === "filter") add("filters", { driver: redactUrlUserInfo(subsection!), scope }, exact);
    else if (section === "core" && variable === "fsmonitor") add("monitors", { scope }, exact);
    else if (section === "merge" && variable === "driver") add("mergeDrivers", { driver: redactUrlUserInfo(subsection!), scope }, exact);
    // The tool name is the value of `merge.tool` and the subsection of `mergetool.<tool>.*`.
    else if (section === "merge" && variable === "tool") add("mergeTools", { tool: redactUrlUserInfo(entry.value ?? ""), scope }, exact);
    else if (section === "mergetool") add("mergeTools", { tool: redactUrlUserInfo(subsection!), scope }, exact);
    else if (section === "gpg") add("signing", { key: redactUrlUserInfo(key), scope }, exact);
    // A `hook.<name>.command` program shows as its hooks. A program of no class needs no approval, such as `diff.<driver>.textconv`.
    else if (section !== "hook" && (reads || commit || sync || workbench)) add("other", { key: redactUrlUserInfo(key), scope }, exact);
  }
  for (const entry of keys) add("other", { key: redactUrlUserInfo(entry.key), scope: entry.scope }, entry.exact);
  const capped = <T>(items: T[]) => ({ names: items.slice(0, TRUST_DIALOG_NAMES), more: Math.max(0, items.length - TRUST_DIALOG_NAMES) });
  return { hooks: capped(kinds.hooks), filters: capped(kinds.filters), monitors: capped(kinds.monitors), mergeDrivers: capped(kinds.mergeDrivers), mergeTools: capped(kinds.mergeTools), signing: capped(kinds.signing), other: capped(kinds.other) };
}

const SHELL_COMMAND = "<shell command>";

// Feature 003 contract Δ7: a transport value can hold a secret in its arguments or its snippet, so the display keeps only the program.
// Git runs these values with `use_shell`. A `!` helper, or a program word that the service cannot name, shows SHELL_COMMAND.
// `core.gitProxy` keeps the command before " for " (connect.c `git_proxy_command_options`). Git runs it without arguments.
function displayValue(p: KeyParts, value: string): string {
  const { section, subsection, variable } = p;
  if (section === "core" && subsection === null && variable === "gitproxy") return proxyText(value);
  const helper = section === "credential" && variable === "helper";
  const shell = helper || (section === "core" && subsection === null && variable === "sshcommand") || (section === "remote" && subsection !== null && (variable === "uploadpack" || variable === "receivepack"));
  if (!shell || value === "") return value;
  if (helper && value.startsWith("!")) return SHELL_COMMAND;
  return shellProgram(value) ?? SHELL_COMMAND;
}

// Contract §3 `readTrust` display: values only for the allowlist, and every text redacted (contract §7).
// Feature 003 contract Δ7: a remote URL that `urlHelper` classifies shows only the helper name. Other URLs and every `insteadOf` value stay hidden.
function displayEntries(listing: TrustListing) {
  return listing.entries.map((entry) => {
    const parts = keyParts(entry.key);
    const url = parts !== null && parts.section === "remote" && (parts.variable === "url" || parts.variable === "pushurl");
    const value = entry.value === null ? null : url ? urlHelper(entry.value) : parts !== null && valueShown(parts) ? displayValue(parts, entry.value) : null;
    return { key: redactUrlUserInfo(entry.key), scope: entry.scope, origin: redactUrlUserInfo(entry.origin), ...(value === null ? {} : { value: redactUrlUserInfo(value) }) };
  });
}

function displayHooks(listing: TrustListing) {
  return [
    ...listing.hooks.configured.map((hook) => ({
      event: redactUrlUserInfo(hook.event),
      name: redactUrlUserInfo(hook.name),
      scope: hook.eventScope,
      ...(hook.command === null ? {} : { commandScope: hook.command.scope, commandOrigin: redactUrlUserInfo(hook.command.origin) }),
      disabled: hook.disabled || hook.eventDisabled,
      repositoryControlled: hook.repositoryControlled,
    })),
    ...listing.hooks.folder.map((hook) => ({ event: hook.event, path: redactUrlUserInfo(hook.path), repositoryControlled: hook.repositoryControlled })),
  ];
}

// ---- Shared listing (contract §7) ----

export interface ListingSlot {
  // The contract §8 change tuple that `status.ts` read before the listing started.
  tuple: string;
  listing: Promise<ListingOutcome>;
  // The generation of the `readWorkspace` that started the listing. Without a request generation, the generation of its result. Null until the service knows it.
  generation(): number | null;
}

// Only `openHistory` and `readRefs` reuse a listing, and only the listing of a `readWorkspace` of its generation (research R5 "T281 record").
export function createSharedListings() {
  const slots = new Map<string, ListingSlot>();
  return {
    // `readWorkspace` always runs its own listing and records it here.
    record(repositoryId: string, slot: ListingSlot): void {
      slots.set(repositoryId, slot);
    },
    // `tuple` is the change tuple that the reader read again. A running listing is awaited until `signal` aborts. Null: run an own listing.
    // Contract §7: these reads wait for no status step. So a listing whose generation the service does not know yet is not shared.
    async reuse(repositoryId: string, generation: number, tuple: string, signal: AbortSignal): Promise<TrustListing | null> {
      const slot = slots.get(repositoryId);
      if (slot === undefined || slot.tuple !== tuple || slot.generation() !== generation || signal.aborted) return null;
      let stop = () => {};
      const canceled = new Promise<null>((resolve) => (stop = () => resolve(null)));
      signal.addEventListener("abort", stop, { once: true });
      try {
        const outcome = await Promise.race([slot.listing.catch(() => null), canceled]);
        return outcome?.ok ? outcome.listing : null;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },
    release(repositoryId: string): void {
      slots.delete(repositoryId);
    },
  };
}

// ---- Trust state and operations ----

export type TrustState = "untrusted" | "approved" | "changed" | "revoked";

export interface TrustView {
  state: TrustState;
  trustId?: string;
  persistence: "stored" | "session";
  approvalRequired: TrustListing["approvalRequired"];
}

// The terminal result of a trust operation. `rejected` comes only from an acceptance check.
export type TrustOutcome<R> =
  | { result: "succeeded"; value: R }
  | { result: "limited"; code: "OUTPUT_LIMIT"; value: R }
  | { result: "failed"; code: ErrorCode; value?: { remedy: { text: string } } | { reason: "TRUST_REPORT_ENTRIES" | "TRUST_REPORT_HOOKS" } }
  | { result: "canceled" }
  | { result: "deadline" };

export interface TrustTarget extends ListingTarget {
  installation: ReadInstallation;
}

export interface ReadTrustValue {
  generation: number;
  state: TrustState;
  persistence: "stored" | "session";
  trustId?: string;
  approvalRequired: TrustListing["approvalRequired"];
  inputLimited?: true;
  entries: ReturnType<typeof displayEntries>;
  hooks: ReturnType<typeof displayHooks>;
  programs: TrustDetails;
}

// Feature 004 spec FR-071: an approval binds the folders and the selected Git path. The record also binds their identities.
interface Binding {
  commonDirectory: string;
  worktreeRoot: string;
  adminDirectory: string;
  gitSelectedPath: string;
}

interface WorktreeTrust {
  common: PhysicalIdentity;
  commonDirectory: string;
  trustId?: string;
  // A session approval after a failed store. It takes precedence over a stored record.
  approval?: Binding;
  revoked: boolean;
}

// Contract §6 "Startup contexts" case rule for `gitSelectedPath` and record paths.
const samePath = (a: string, b: string) => NATIVE.fold(a) === NATIVE.fold(b);
const worktreeKey = (w: Workspace) => JSON.stringify([w.commonIdentity, w.worktreeIdentity]);

// Contract §7 "Trust approval store": a record of the same worktree. Both record versions hold these fields.
const sameWorktreeRecord = (record: TrustRecord, w: Workspace) =>
  (sameIdentity(record.commonIdentity, w.commonIdentity) &&
    sameIdentity(record.worktreeIdentity[0]!, w.worktreeIdentity[0]) &&
    sameIdentity(record.worktreeIdentity[1]!, w.worktreeIdentity[1])) ||
  (samePath(record.commonDirectory, w.commonDirectory) && samePath(record.worktreeRoot, w.worktreeRoot));

const sameBinding = (b: Binding, w: Workspace, gitSelectedPath: string) =>
  samePath(b.commonDirectory, w.commonDirectory) && samePath(b.worktreeRoot, w.worktreeRoot) && samePath(b.adminDirectory, w.gitDirectory) && samePath(b.gitSelectedPath, gitSelectedPath);

// Feature 004 data-model §10: only a version 2 record with the same identities, folders, and selected Git path approves.
const approvedBy = (record: TrustRecord, w: Workspace, gitSelectedPath: string) =>
  "policyVersion" in record &&
  sameIdentity(record.commonIdentity, w.commonIdentity) &&
  sameIdentity(record.worktreeIdentity[0]!, w.worktreeIdentity[0]) &&
  sameIdentity(record.worktreeIdentity[1]!, w.worktreeIdentity[1]) &&
  sameBinding(record, w, gitSelectedPath);

// T212 decision W8: `confirm` needs the UNC form of the WSL Git path. Without it, `readTrust` and `approveTrust` refuse with the §11 code before any listing.
// Only a WSL Git path has no UNC form (`ReadInstallation`).
const unmappableGit = (w: Workspace): TrustOutcome<never> => ({ result: "failed", code: "UNSUPPORTED_REPOSITORY", value: { remedy: { text: gitPathText(w.wsl!) } } });

const stopped = (outcome: Exclude<ListingOutcome, { ok: true }>): TrustOutcome<never> =>
  "stop" in outcome ? { result: outcome.stop } : { result: "failed", code: outcome.code, ...(outcome.text === undefined ? {} : { value: { remedy: { text: outcome.text } } }) };

export interface TrustOptions {
  runner: ListingRunner;
  environment: ServiceEnvironment;
  // The kept `git var` lines of an installation (contract §7 "Configuration file paths"). Undefined: the installation keeps none.
  configFiles?: (gitInstallationId: string) => readonly string[] | undefined;
}

// One trust store per service session. The handshake records seed it (contract §7 "Trust approval store").
export function createTrust({ runner, environment, configFiles = () => undefined }: TrustOptions) {
  const list = (target: ListingTarget) => listTrust(runner, target, environment, configFiles(target.workspace.gitInstallationId));
  let records: TrustRecord[] = [];
  const worktrees = new Map<string, WorktreeTrust>();
  // Each released `repositoryId`. The registration never issues one again (contract §6 "Registration reuse and release").
  const released = new Set<string>();
  const shared = createSharedListings();

  const worktree = (w: Workspace): WorktreeTrust => {
    const key = worktreeKey(w);
    let found = worktrees.get(key);
    if (found === undefined) worktrees.set(key, (found = { common: w.commonIdentity, commonDirectory: w.commonDirectory, revoked: false }));
    return found;
  };
  const trustIdOf = (t: WorktreeTrust) => (t.trustId ??= crypto.randomUUID());

  // Feature 004 plan.md D12 "State": a matching version 2 record or session approval gives `approved`. Any other record of the worktree gives `changed`,
  // also a version 1 record (plan.md O-5). No listing fact decides the state.
  function stateOf(w: Workspace, gitSelectedPath: string | null): { state: TrustState; trustId?: string; session: boolean } {
    const t = worktree(w);
    if (t.revoked) return { state: "revoked", session: false };
    if (t.approval !== undefined) {
      const same = gitSelectedPath !== null && sameBinding(t.approval, w, gitSelectedPath);
      return { state: same ? "approved" : "changed", trustId: trustIdOf(t), session: true };
    }
    const own = records.filter((r) => sameWorktreeRecord(r, w));
    if (own.length === 0) return { state: "untrusted", session: false };
    const approved = gitSelectedPath !== null && own.some((r) => approvedBy(r, w, gitSelectedPath));
    return { state: approved ? "approved" : "changed", trustId: trustIdOf(t), session: false };
  }

  function view(w: Workspace, listing: Pick<TrustListing, "approvalRequired">, installation: ReadInstallation): TrustView {
    const { state, trustId, session } = stateOf(w, installation.selectedPath);
    // Contract §3 `readTrust` and feature 003 contract Δ7.
    return { state, ...(trustId === undefined ? {} : { trustId }), persistence: session ? "session" : "stored", approvalRequired: { ...listing.approvalRequired } };
  }

  // Contract §7: the gate of reads, of `commit`, of feature 003 `sync`, and of feature 004 `workbench`. Null: the operation may run. An input-limited listing can never pass.
  // Feature 004 plan.md D12: the state comes from the records alone, so the fingerprint takes no part in it.
  function gate(
    w: Workspace,
    listing: Pick<TrustListing, "inputLimited"> & { approvalRequired: Readonly<Partial<TrustListing["approvalRequired"]>> },
    installation: ReadInstallation,
    kind: keyof TrustListing["approvalRequired"],
  ): "TRUST_REQUIRED" | "TRUST_CHANGED" | null {
    if (listing.approvalRequired[kind] !== true) return null;
    const { state } = stateOf(w, installation.selectedPath);
    if (state === "approved" && !listing.inputLimited) return null;
    return state === "changed" ? "TRUST_CHANGED" : "TRUST_REQUIRED";
  }

  return {
    // Contract §6 "Startup handshake" `trustRecords`.
    loadRecords(handshake: readonly TrustRecord[]): void {
      records = [...handshake];
    },

    // Contract §6 "Registration reuse and release": a release clears the session approval and the trust ID of its worktree, and the shared listing of its `repositoryId`.
    release(w: Workspace): void {
      const t = worktrees.get(worktreeKey(w));
      if (t !== undefined) {
        delete t.approval;
        delete t.trustId;
      }
      shared.release(w.repositoryId);
      released.add(w.repositoryId);
    },
    listTrust: list,
    view,
    gate,
    shared,

    // Contract §3 `readTrust`. It never asks (feature 004 spec FR-072).
    async readTrust(target: TrustTarget, generation: number): Promise<TrustOutcome<ReadTrustValue>> {
      if (target.installation.selectedPath === null) return unmappableGit(target.workspace);
      const outcome = await list(target);
      if (!outcome.ok) return stopped(outcome);
      // A release cancels the read (contract §6 "Registration reuse and release").
      if (target.signal.aborted) return { result: "canceled" };
      const { listing } = outcome;
      // Contract §5 "Trust report rows": a report above a bound is refused whole.
      const rows = listing.entries.length > TRUST_REPORT_ENTRIES ? "TRUST_REPORT_ENTRIES" : listing.hooks.configured.length + listing.hooks.folder.length > TRUST_REPORT_HOOKS ? "TRUST_REPORT_HOOKS" : null;
      if (rows !== null) return { result: "failed", code: "OUTPUT_LIMIT", value: { reason: rows } };
      const value: ReadTrustValue = {
        generation,
        ...view(target.workspace, listing, target.installation),
        ...(listing.inputLimited ? { inputLimited: true as const } : {}),
        entries: displayEntries(listing),
        hooks: displayHooks(listing),
        programs: listing.programs,
      };
      return listing.inputLimited ? { result: "limited", code: "OUTPUT_LIMIT", value } : { result: "succeeded", value };
    },

    // Contract §3 `approveTrust` and feature 004 contract Δ6: the shell shows one dialog with the action and the details, and it writes the record.
    async approveTrust(target: TrustTarget, action: TrustAction): Promise<TrustOutcome<{ trustId: string; persistence: "stored" | "session"; saveFailed: boolean }>> {
      const w = target.workspace;
      const gitSelectedPath = target.installation.selectedPath;
      if (gitSelectedPath === null) return unmappableGit(w);
      const outcome = await list(target);
      if (!outcome.ok) return stopped(outcome);
      const { listing } = outcome;
      // Contract §5: input overflow blocks approval.
      if (listing.inputLimited) return { result: "failed", code: "OUTPUT_LIMIT" };
      let reply;
      try {
        reply = await runner.trust({
          type: "confirm",
          worktreeRoot: w.worktreeRoot,
          adminDirectory: w.gitDirectory,
          commonDirectory: w.commonDirectory,
          gitSelectedPath,
          policyVersion: 2,
          action,
          details: listing.programs,
        });
      } catch (error) {
        if (error instanceof RunnerRefusal) return { result: "failed", code: error.code };
        throw error;
      }
      if (!("result" in reply)) return { result: "failed", code: "INVALID_REQUEST" };
      if (reply.result === "declined") return { result: "canceled" };
      // A release during the confirmation invalidates the `repositoryId`, so the approval binds nothing.
      if (released.has(w.repositoryId)) return { result: "failed", code: "UNKNOWN_TARGET" };
      const t = worktree(w);
      t.revoked = false;
      t.trustId = crypto.randomUUID();
      if (reply.stored === true) {
        // Contract §7: the new record replaces every record of the same worktree, a version 1 record too (plan.md O-5).
        records = [...records.filter((r) => !sameWorktreeRecord(r, w)), reply.record];
        delete t.approval;
        return { result: "succeeded", value: { trustId: t.trustId, persistence: "stored", saveFailed: false } };
      }
      // A failed store leaves the stored records unchanged.
      t.approval = { commonDirectory: w.commonDirectory, worktreeRoot: w.worktreeRoot, adminDirectory: w.gitDirectory, gitSelectedPath };
      return { result: "succeeded", value: { trustId: t.trustId, persistence: "session", saveFailed: true } };
    },

    // Contract §3 `revokeTrust`: the payload names the current trust ID of the workspace.
    acceptRevoke(w: Workspace, trustId: string): ErrorCode | null {
      return worktrees.get(worktreeKey(w))?.trustId === trustId ? null : "UNKNOWN_TARGET";
    },

    currentTrustId(w: Workspace): string | undefined {
      return worktrees.get(worktreeKey(w))?.trustId;
    },

    // Contract §7 "Trust approval store" `revoke`: the shell deletes the records of every worktree of the common directory and ends its lingering Jobs.
    async revokeTrust(target: ListingTarget): Promise<TrustOutcome<{ endedProcesses: number }>> {
      const w = target.workspace;
      // Revocation applies in the service also when the shell reply fails, so no later operation relies on it.
      records = records.filter((r) => !sameIdentity(r.commonIdentity, w.commonIdentity) && !samePath(r.commonDirectory, w.commonDirectory));
      worktree(w);
      for (const t of worktrees.values()) {
        if (!sameIdentity(t.common, w.commonIdentity) && !samePath(t.commonDirectory, w.commonDirectory)) continue;
        delete t.approval;
        delete t.trustId;
        t.revoked = true;
      }
      let reply;
      try {
        reply = await runner.trust({ type: "revoke", commonDirectory: w.commonDirectory });
      } catch (error) {
        if (error instanceof RunnerRefusal) return { result: "failed", code: error.code };
        throw error;
      }
      // Contract §5 "Deadline outcomes" (T314): the service revocation stays, and the shell closed no lingering Job.
      if ("stop" in reply) return { result: "failed", code: "DEADLINE" };
      if (!("endedProcesses" in reply)) return { result: "failed", code: "INVALID_REQUEST" };
      return { result: "succeeded", value: { endedProcesses: reply.endedProcesses } };
    },
  };
}

export type Trust = ReturnType<typeof createTrust>;
