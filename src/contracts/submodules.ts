// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Data-model §9 and contract §12 "Submodules": the plan, program, row result, and progress types, the progress parser, the output tail, and the remedy commands.

import { z } from "zod";
import { Base64 } from "./channel";
import { COMMIT_OUTPUT_TAIL_BYTES, COMMIT_OUTPUT_TAIL_LINES, PROCESS_EXIT_CODE_MAX } from "./limits";
import { Count, Fingerprint, Identifier, OutputTail, Phase, ProgressFields, Text } from "./operations";
import { buildRemedyCommand, type RemedyValue } from "./remedy-command";

export const SUBMODULE_ACTIONS = ["clone", "reuse", "checkout", "fetch-checkout", "none", "skip"] as const;
export type SubmoduleAction = (typeof SUBMODULE_ACTIONS)[number];

// The reasons of `UNSUPPORTED_SUBMODULE` (contract §12 "Refusals").
export const SUBMODULE_REFUSAL_REASONS = [
  "unsaved-commits",
  "update-mode",
  "clone-interrupted",
  "folder-not-empty",
  "no-url",
  "path",
  "active-value",
  "remote-name",
  // Feature 004 contract Δ12: a scoped review of a nested row whose parent row has no `.git` entry, and of a row outside the active set.
  "parent-not-initialized",
  "inactive",
  "gitdir-config",
  "limit",
] as const;
export type SubmoduleRefusalReason = (typeof SUBMODULE_REFUSAL_REASONS)[number];

// Contract §12 "Refusals during the run": these reasons exist only during the run.
export const SUBMODULE_RUN_REFUSAL_REASONS = ["programs", "changed-after-review"] as const;
export type SubmoduleRunRefusalReason = (typeof SUBMODULE_RUN_REFUSAL_REASONS)[number];

// Feature 004 contract Δ12: the `STALE_REVIEW` reason of an `updateSubmodules` request without `confirmHosts` after a review with host lines.
export const SUBMODULE_STALE_REVIEW_REASONS = ["hosts"] as const;
export type SubmoduleStaleReviewReason = (typeof SUBMODULE_STALE_REVIEW_REASONS)[number];

export const SUBMODULE_ROW_STATES = ["cloned", "moved", "unchanged", "failed", "clone-interrupted", "changed-elsewhere", "refused"] as const;
export type SubmoduleRowState = (typeof SUBMODULE_ROW_STATES)[number];

export const SUBMODULE_PROGRESS_PHASES = ["fetch", "update"] as const;
export type SubmoduleProgressPhase = (typeof SUBMODULE_PROGRESS_PHASES)[number];

// Contract §12 "Update protocol" step 5 "Read failures" and step 6: the reads whose failure ends a row `failed`.
export const SUBMODULE_FAILED_READS = ["check", "remote-get-url", "folder", "clone-check", "level", "url"] as const;
export type SubmoduleFailedRead = (typeof SUBMODULE_FAILED_READS)[number];

const ObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

// Data-model §9 "Plan row". `url` is null for a gitlink without a `.gitmodules` entry (reason `no-url`).
export const SubmodulePlanRow = z
  .strictObject({
    rowId: Identifier,
    pathBytes: Base64,
    path: Text,
    name: Text,
    depth: Count,
    parentRowId: Identifier.nullable(),
    url: Text.nullable(),
    head: ObjectId.nullable(),
    target: ObjectId.nullable(),
    remotes: z.array(z.strictObject({ name: Text, url: Text, default: z.boolean() })),
    action: z.enum(SUBMODULE_ACTIONS),
    notes: z.array(Text),
    refusal: z.enum(SUBMODULE_REFUSAL_REASONS).nullable(),
  })
  // A top-level row has no parent row. The plan marks one default remote at most.
  .refine((row) => (row.depth === 0) === (row.parentRowId === null) && row.remotes.filter((remote) => remote.default).length <= 1);
export type SubmodulePlanRow = z.infer<typeof SubmodulePlanRow>;

// Data-model §9 "Submodule program": a row ID or a kept Git directory, never both.
const programFields = {
  key: Text,
  scope: Text,
  origin: Text,
  program: Text,
  digest: z.union([Fingerprint, z.enum(["absent", "unchecked"])]),
};
export const SubmoduleProgram = z.union([z.strictObject({ rowId: Identifier, ...programFields }), z.strictObject({ gitDirectory: Text, ...programFields })]);
export type SubmoduleProgram = z.infer<typeof SubmoduleProgram>;

// A remedy without a command keeps its text (contract §12 "Remedies").
const RowRemedy = z.strictObject({ command: Text.nullable(), text: Text.optional() }).refine((remedy) => remedy.command !== null || remedy.text !== undefined);

// Data-model §9 "Row result" and contract §12 "Reconciliation and outcome".
export const SubmoduleRowResult = z
  .strictObject({
    rowId: Identifier,
    path: Text,
    state: z.enum(SUBMODULE_ROW_STATES),
    oldCommit: ObjectId.nullable(),
    newCommit: ObjectId.nullable(),
    fetched: z.boolean(),
    connected: z.boolean(),
    found: z.boolean(),
    registered: z.boolean(),
    reason: z.enum([...SUBMODULE_REFUSAL_REASONS, ...SUBMODULE_RUN_REFUSAL_REASONS]).optional(),
    text: Text.optional(),
    remedy: RowRemedy.optional(),
    outputTail: OutputTail.optional(),
    // Feature 004 contract Δ12: the Git exit code of the failed step. Null: the step ended without an exit code, such as after a kill.
    exitCode: z.int().min(0).max(PROCESS_EXIT_CODE_MAX).nullable().optional(),
    failedRead: z.enum(SUBMODULE_FAILED_READS).optional(),
    folderPath: Text.optional(),
  })
  .refine((row) => {
    const refused = row.state === "refused";
    if (refused !== (row.reason !== undefined) || (refused && row.text === undefined)) return false;
    if (row.text !== undefined && !refused && row.state !== "clone-interrupted") return false;
    if ((row.state === "clone-interrupted") !== (row.folderPath !== undefined)) return false;
    if (row.state === "moved" && (row.oldCommit === null || row.newCommit === null)) return false;
    // A failed read carries no remedy and no process output.
    if (row.failedRead !== undefined && (row.state !== "failed" || row.remedy !== undefined || row.outputTail !== undefined)) return false;
    if (row.outputTail !== undefined && row.state !== "failed") return false;
    // A failed step carries its output tail and its exit code together.
    if ((row.exitCode !== undefined) !== (row.outputTail !== undefined)) return false;
    return row.remedy === undefined || row.state === "failed" || refused || row.state === "clone-interrupted";
  });
export type SubmoduleRowResult = z.infer<typeof SubmoduleRowResult>;

// Data-model §9 "Progress" and contract §12 "Progress": a contract §2 progress event. No Git text.
// `rowIndex` is the `<i>` of "(<i> of <n>)" and names the row in the ordered row list. An absent `percent` means none.
// `path` is the row path of the row result, also for a found nested row.
export const SubmoduleProgress = ProgressFields.extend({
  phase: Phase.extract(SUBMODULE_PROGRESS_PHASES),
  path: SubmoduleRowResult.shape.path,
  counters: z.strictObject({ rowIndex: Count, rowCount: Count, percent: Count.max(100).optional() }),
  stalled: z.boolean(),
}).refine((event) => event.counters.rowIndex >= 1 && event.counters.rowIndex <= event.counters.rowCount);
export type SubmoduleProgress = z.infer<typeof SubmoduleProgress>;

// Data-model §7 `stallRemedy`. When the contract §4 rule refuses a value, the field holds the text without a command.
export const StallRemedy = z.strictObject({ command: Text.optional(), text: Text });
export type StallRemedy = z.infer<typeof StallRemedy>;

// Git progress.c prints the counter with the untranslated format `"%3u%% (%"PRIuMAX"/%"PRIuMAX")%s"`.
const COUNTER = /(\d+)% \(\d+\/\d+\)/g;

// Contract §12 "Progress". `null` means no counter in the newest segment; the caller then keeps the last percentage.
export function parseSubmoduleProgress(stderr: string): number | null {
  const newest = stderr
    .split(/[\r\n]/)
    .filter((segment) => segment !== "")
    .at(-1);
  if (newest === undefined) return null;
  const last = [...newest.matchAll(COUNTER)].at(-1);
  if (!last) return null;
  const percent = Number(last[1]);
  return percent <= 100 ? percent : null;
}

// Contract §7 "URL user information". Each `://` starts its own authority, so a match never hides a later URL.
export function redactUrlUserInfo(text: string): string {
  let out = "";
  let from = 0;
  for (let at = text.indexOf("://"); at >= 0; at = text.indexOf("://", at + 1)) {
    const start = at + 3;
    if (start < from) continue;
    const end = text.slice(start).search(/[/?#]/);
    const authority = end < 0 ? text.slice(start) : text.slice(start, start + end);
    const userEnd = authority.lastIndexOf("@");
    if (userEnd < 0) continue;
    out += `${text.slice(from, start)}<redacted>`;
    from = start + userEnd;
  }
  return out + text.slice(from);
}

// Feature 004 plan.md D13: the host of a URL. `local` is this computer. `unknown` means that no exact host follows from the URL.
export const SubmoduleHost = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("host"), name: Text }), z.strictObject({ kind: z.literal("local") }), z.strictObject({ kind: z.literal("unknown") })]);
export type SubmoduleHost = z.infer<typeof SubmoduleHost>;

// Contract Δ12 host line: a row whose fetch host differs from the host of its effective `submodule.<name>.url`.
export const SubmoduleHostLine = z.strictObject({ path: Text, fetch: SubmoduleHost, settings: SubmoduleHost });
export type SubmoduleHostLine = z.infer<typeof SubmoduleHostLine>;

const LOCAL_HOST: SubmoduleHost = { kind: "local" };
const UNKNOWN_HOST: SubmoduleHost = { kind: "unknown" };
// transport.c `transport_get`: Git connects to these schemes itself, or through its own `git remote-http`, `remote-https`, `remote-ftp`, and `remote-ftps`.
const HOST_SCHEMES: ReadonlySet<string> = new Set(["ssh", "git+ssh", "ssh+git", "git", "http", "https", "ftp", "ftps"]);
// compat/mingw.c `is_valid_win32_path` with `core.protectNTFS`, the Git for Windows default. A name that this check cannot clear gives no exact host.
const WIN32_NAME = /^(?:\.{1,2}|[^\u0000-\u001f:<>"|?*]*[^\u0000-\u001f:<>"|?* .])$/;
const DOS_DEVICE = /^(?:aux|nul|prn|con|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .:]|$)/i;

// connect.c `url_is_local_not_ssh`. Null: Git can read the drive path as the scp form, and this check cannot tell.
function localPath(url: string, platform: "windows" | "posix"): boolean | null {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon < 0 || (slash >= 0 && slash < colon)) return true;
  // `win32_has_dos_drive_prefix`: one character of at most four UTF-8 bytes, then `:`.
  const bytes = new TextEncoder().encode(url);
  if (platform !== "windows") return false;
  let i = 1;
  if (bytes[0]! & 0x80) while (i < 4 && (bytes[i] ?? 0) & 0x80) i++;
  if (bytes[i] !== 0x3a) return false;
  const rest = new TextDecoder().decode(bytes.subarray(i + 1));
  return rest.split(/[\\/]/).every((name) => name === "" || (WIN32_NAME.test(name) && !DOS_DEVICE.test(name))) ? true : null;
}

// connect.c `host_end`, `get_host_and_port`, and `get_port` on `[user@]host[:port]`: a host in brackets ends at `]`, and a decimal port or a lone `:` goes.
function authorityHost(authority: string): SubmoduleHost {
  const parts = authority.split("@");
  if (parts.length > 2) return UNKNOWN_HOST;
  let name = parts.at(-1)!;
  if (name.startsWith("[")) {
    const close = name.indexOf("]");
    if (close < 0 || !/^(?::\d*)?$/.test(name.slice(close + 1))) return UNKNOWN_HOST;
    name = name.slice(1, close);
  }
  const colon = name.indexOf(":");
  const port = colon < 0 ? null : name.slice(colon + 1);
  if (port !== null && /^\d*$/.test(port) && (port === "" || Number(port) < 65536)) name = name.slice(0, colon);
  return name === "" ? UNKNOWN_HOST : { kind: "host", name };
}

// git-fetch(1) "GIT URLS" with transport.c `transport_get`, url.c `is_url`, and connect.c `parse_connect_url`. `platform` names the Git that fetches.
export function submoduleUrlHost(url: string, platform: "windows" | "posix"): SubmoduleHost {
  // `<transport>::<address>` runs `git remote-<transport>`. Git refuses `rsync:`.
  if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(url) || url.startsWith("rsync:")) return UNKNOWN_HOST;
  const scheme = /^([A-Za-z0-9][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme !== null) {
    if (scheme[1] === "file") return LOCAL_HOST;
    if (!HOST_SCHEMES.has(scheme[1]!)) return UNKNOWN_HOST;
    const rest = url.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    // Git decodes `%XX` (url.c `url_decode`), and `host_end` finds `@[` anywhere in the text. Neither gives an exact host here.
    const at = rest.indexOf("@[");
    if (slash < 0 || /[%\\]/.test(rest.slice(0, slash)) || at > slash) return UNKNOWN_HOST;
    return authorityHost(rest.slice(0, slash));
  }
  const local = localPath(url, platform);
  if (local !== false) return local === true ? LOCAL_HOST : UNKNOWN_HOST;
  // The scp form `[user@]host:path`. `host_end`: a host in brackets, also after `user@`, ends at `]`, and the path `:` must follow it.
  const colon = url.indexOf(":");
  const at = url.indexOf("@[");
  if (at > colon) return UNKNOWN_HOST;
  const start = at >= 0 ? at + 1 : 0;
  if (url[start] !== "[") return authorityHost(url.slice(0, colon));
  const close = url.indexOf("]", start);
  return close < 0 || url[close + 1] !== ":" ? UNKNOWN_HOST : authorityHost(url.slice(0, close + 1));
}

// RFC 4343: host names compare without regard to ASCII letter case. An unknown host never compares equal.
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const sameSubmoduleHost = (a: SubmoduleHost, b: SubmoduleHost): boolean =>
  a.kind === "local" ? b.kind === "local" : a.kind === "host" && b.kind === "host" && asciiLower(a.name) === asciiLower(b.name);

const LF = 0x0a;
// ECMA-48 control strings (OSC, DCS, SOS, PM, APC) end at ST or BEL. Their content holds no control character, so no line is lost.
const CONTROL_STRING = /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[^\u0000-\u001f\u007f-\u009f]*(?:\u0007|\u001b\\|\u009c)/g;
// ECMA-48 control sequences: CSI, parameter bytes, intermediate bytes, and a final byte.
const CONTROL_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// ECMA-35 escape sequences: ESC, intermediate bytes, and a final byte.
const ESCAPE_SEQUENCE = /\u001b[ -/]*[0-~]/g;
// C0 controls except TAB, LF, and CR, then DEL and C1 controls. CR stays for the line rule.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

// Keeps the end of `text` within the byte bound. Redaction and U+FFFD can lengthen the text after the raw cut.
function boundBytes(text: string): string {
  if (utf8Bytes(text) <= COMMIT_OUTPUT_TAIL_BYTES) return text;
  // Walk back by code point to the earliest start that fits.
  let size = 0;
  let start = text.length;
  for (const char of Array.from(text).reverse()) {
    const next = size + utf8Bytes(char);
    if (next > COMMIT_OUTPUT_TAIL_BYTES) break;
    size = next;
    start -= char.length;
  }
  const kept = text.slice(start);
  // Whole lines go first. Only a single line that is too long loses its start; its URLs are already redacted.
  const lf = kept.indexOf("\n");
  return start > 0 && text[start - 1] !== "\n" && lf >= 0 && lf < kept.length - 1 ? kept.slice(lf + 1) : kept;
}

// Contract §9 "Commit failure output". `progress` adds the §12 "Output tail" change. `retained` holds the raw stderr bytes of the ring buffer.
// `droppedBefore` is true when bytes were dropped before the buffer.
export function buildSubmoduleOutputTail(retained: Uint8Array, droppedBefore: boolean, mode: "progress" | "plain" = "progress"): string {
  let bytes = retained;
  let dropped = droppedBefore;
  if (bytes.length > COMMIT_OUTPUT_TAIL_BYTES) {
    bytes = bytes.subarray(bytes.length - COMMIT_OUTPUT_TAIL_BYTES);
    dropped = true;
  }
  // The first partial line goes, so a URL is never cut at its start.
  if (dropped) {
    const lf = bytes.indexOf(LF);
    bytes = lf < 0 ? new Uint8Array(0) : bytes.subarray(lf + 1);
  }
  const sanitized = new TextDecoder("utf-8", { ignoreBOM: true })
    .decode(bytes)
    .replace(CONTROL_STRING, "")
    .replace(CONTROL_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(CONTROLS, "")
    .replace(mode === "plain" ? /\r\n?/g : /\r\n/g, "\n");
  // A segment that ends with a lone CR gives way to the text after it.
  const collapsed =
    mode === "plain"
      ? sanitized
      : sanitized
          .split("\n")
          .map((line) =>
            line
              .split("\r")
              .filter((segment) => segment !== "")
              .at(-1) ?? "",
          )
          .join("\n");
  const lines = redactUrlUserInfo(collapsed).split("\n");
  const trailing = lines.at(-1) === "";
  const body = trailing ? lines.slice(0, -1) : lines;
  return boundBytes(body.slice(-COMMIT_OUTPUT_TAIL_LINES).join("\n") + (trailing && body.length > 0 ? "\n" : ""));
}

// Contract §12 "Remedies": the text of each step and of the update command.
const FETCH_TEXT = "This command fetches this submodule in a terminal, where Git and SSH can ask for input. Then use Update submodules again.";
const CHECKOUT_TEXT = "This command checks out this submodule in a terminal, where Git can ask for input. Then use Update submodules again.";
const CLONE_TEXT = "This command clones this submodule in a terminal, where Git and SSH can ask for input. Then use Update submodules again.";
const REGISTER_TEXT = "This command registers this submodule in a terminal. Then use Update submodules again.";
const UPDATE_TEXT =
  "This command runs Git's own recursive update without Arbareto's checks. Git can leave submodule commits without a ref. It can overwrite files in reused submodule folders and run a configured update command. Resolve every other refusal first.";

// Contract §11 "Remedy commands". The caller reads the System32 folder.
export interface SubmoduleWslTarget {
  wslExecutable: string;
  distro: string;
}

export type SubmoduleRemedyRequest =
  | { step: "fetch"; gitPath: string; submoduleWorktree: string; wsl?: SubmoduleWslTarget }
  | { step: "fallback-fetch"; gitPath: string; submoduleWorktree: string; remote: string; target: string; wsl?: SubmoduleWslTarget }
  // `nested`: the parent worktree is a submodule worktree.
  | { step: "connect" | "checkout" | "clone" | "register"; gitPath: string; parentWorktree: string; path: string | Uint8Array; nested?: boolean; wsl?: SubmoduleWslTarget };

export interface SubmoduleStepRemedy {
  command: string | null;
  text: string;
}

export interface SubmoduleRemedy {
  command: string | null;
  text?: string;
}

type Source = "review" | "run" | "clone-check";
type Location = { submoduleWorktree: string; gitDirectory?: never } | { gitDirectory: string; submoduleWorktree?: never };

export type SubmoduleRefusalRemedyRequest =
  | { reason: "update-mode"; gitPath: string; parentWorktree: string; path: string | Uint8Array; nested?: boolean; wsl?: SubmoduleWslTarget }
  // A submodule setting names its path. A superproject setting has none.
  | { reason: "gitdir-config"; gitPath: string; parentWorktree: string; path?: string | Uint8Array; nested?: boolean; wsl?: SubmoduleWslTarget }
  | { reason: "limit"; gitPath: string; parentWorktree: string; path?: never; wsl?: SubmoduleWslTarget }
  | ({ reason: "unsaved-commits"; source: Source; gitPath: string; commit: string; wsl?: SubmoduleWslTarget } & Location)
  | {
      reason: "clone-interrupted" | "folder-not-empty" | "no-url" | "path" | "active-value" | "remote-name" | SubmoduleRunRefusalReason;
      gitPath?: string;
      parentWorktree?: string;
      path?: string | Uint8Array;
      wsl?: SubmoduleWslTarget;
    };

const BACKSLASH = 0x5c;
const EQUALS = 0x3d;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LITERAL = new TextEncoder().encode(":(literal)");
const FETCH_ENV = "$env:GIT_PROTOCOL_FROM_USER";

const bytesOf = (text: string | Uint8Array) => (typeof text === "string" ? new TextEncoder().encode(text) : text);
const literalPath = (path: string | Uint8Array): RemedyValue => {
  const bytes = bytesOf(path);
  const text = new Uint8Array(LITERAL.length + bytes.length);
  text.set(LITERAL);
  text.set(bytes, LITERAL.length);
  return { kind: "path", text };
};

// Contract §12 "Review reads": the same form as the service commands. Plain discovery from an invalid `.git` entry reaches the parent repository.
const IN_SUBMODULE = "-C {worktree} --git-dir=.git";
const parentAt = (nested: boolean | undefined) => (nested ? "-C {parent} --git-dir=.git" : "-C {parent}");

// `git` is the template for the Git program with its first argument `--no-lazy-fetch`. The values hold no form for paths; this function adds it.
function build(gitArguments: string, values: Record<string, RemedyValue>, wsl: SubmoduleWslTarget | undefined, fetch: boolean): string | null {
  const form = wsl ? "linux" : "windows";
  const formed: Record<string, RemedyValue> = {};
  for (const [name, value] of Object.entries(values)) {
    const pathKind = value.kind === "gitPath" || value.kind === "worktreeRoot" || value.kind === "submoduleWorktree" || value.kind === "gitDirectory";
    formed[name] = pathKind ? { ...value, form } : value;
  }
  let template: string;
  if (wsl) {
    formed.distro = { kind: "distroName", text: wsl.distro };
    // Contract §11: no value after `--distribution` may hold U+005C.
    if (Object.values(formed).some((value) => bytesOf(value.text).includes(BACKSLASH))) return null;
    // Contract §11: `env` reads an argument with U+003D as an assignment, so such a Git path gives no fetch command.
    if (fetch && bytesOf(formed.git!.text).includes(EQUALS)) return null;
    formed.wsl = { kind: "wslExecutable", text: wsl.wslExecutable, form: "windows" };
    template = `& {wsl} --distribution {distro} --cd / --exec ${fetch ? "/usr/bin/env GIT_PROTOCOL_FROM_USER=0 " : ""}{git} --no-lazy-fetch ${gitArguments}`;
  } else if (fetch) {
    // `$p` stays local to the script block. `finally` restores the earlier value.
    template = `& { $p = ${FETCH_ENV}; ${FETCH_ENV} = '0'; try { & {git} --no-lazy-fetch ${gitArguments} } finally { ${FETCH_ENV} = $p } }`;
  } else {
    template = `& {git} --no-lazy-fetch ${gitArguments}`;
  }
  return buildRemedyCommand(template, formed).command;
}

// Contract §12 "Remedies": the command of a failed step or of a step that shows the stall notice. No step command passes `--recursive`.
export function buildSubmoduleRemedy(request: SubmoduleRemedyRequest): SubmoduleStepRemedy {
  const git: RemedyValue = { kind: "gitPath", text: request.gitPath };
  switch (request.step) {
    case "fetch":
    case "fallback-fetch": {
      const values: Record<string, RemedyValue> = { git, worktree: { kind: "submoduleWorktree", text: request.submoduleWorktree } };
      let fetchArguments = `${IN_SUBMODULE} fetch --no-recurse-submodules`;
      if (request.step === "fallback-fetch") {
        if (!FULL_OBJECT_ID.test(request.target)) return { command: null, text: FETCH_TEXT };
        values.remote = { kind: "remoteName", text: request.remote };
        values.target = { kind: "commitId", text: request.target };
        // `--` keeps the remote name literal (probe S31).
        fetchArguments += " -- {remote} {target}";
      }
      return { command: build(fetchArguments, values, request.wsl, true), text: FETCH_TEXT };
    }
    case "connect":
    case "checkout":
    case "clone":
    case "register": {
      const values = { git, parent: { kind: "worktreeRoot", text: request.parentWorktree } as RemedyValue, path: literalPath(request.path) };
      const [subcommand, text] =
        request.step === "register"
          ? ["submodule init", REGISTER_TEXT]
          : request.step === "clone"
            ? ["submodule update --init", CLONE_TEXT]
            : ["submodule update --init --no-fetch", CHECKOUT_TEXT];
      return { command: build(`${parentAt(request.nested)} ${subcommand} -- {path}`, values, request.wsl, false), text };
    }
  }
}

// Contract §12 "Refusals" and "Remedies". `null`: the reason has no command, or the clone check found the folder.
export function buildRefusalRemedy(request: SubmoduleRefusalRemedyRequest): SubmoduleRemedy | null {
  switch (request.reason) {
    case "update-mode":
    case "gitdir-config":
    case "limit": {
      const values: Record<string, RemedyValue> = {
        git: { kind: "gitPath", text: request.gitPath },
        parent: { kind: "worktreeRoot", text: request.parentWorktree },
      };
      let updateArguments = `${parentAt(request.reason !== "limit" && request.nested)} submodule update --init --recursive`;
      if (request.path !== undefined) {
        values.path = literalPath(request.path);
        updateArguments += " -- {path}";
      }
      return { command: build(updateArguments, values, request.wsl, false), text: UPDATE_TEXT };
    }
    case "unsaved-commits": {
      // Contract §12 "Update protocol" step 5: no review read the found Git directory, so its programs are unlisted.
      if (request.source === "clone-check") return null;
      if (!FULL_OBJECT_ID.test(request.commit)) throw new Error("unsaved-commits remedy needs a full commit ID");
      const values: Record<string, RemedyValue> = {
        git: { kind: "gitPath", text: request.gitPath },
        branch: { kind: "branchName", text: `arbareto-saved-${request.commit.slice(0, 12)}` },
        commit: { kind: "commitId", text: request.commit },
      };
      let where: string;
      if (request.gitDirectory !== undefined) {
        values.directory = { kind: "gitDirectory", text: request.gitDirectory };
        where = "--git-dir={directory} --work-tree={directory}";
      } else {
        values.worktree = { kind: "submoduleWorktree", text: request.submoduleWorktree };
        where = IN_SUBMODULE;
      }
      // The refusal text carries the instruction, so a refused value leaves no remedy.
      const command = build(`${where} branch {branch} {commit}`, values, request.wsl, false);
      return command === null ? null : { command };
    }
    default:
      return null;
  }
}
