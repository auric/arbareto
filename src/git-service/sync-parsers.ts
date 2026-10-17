// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Contract Δ3 grammars, data-model §1, §3 to §6, and plan.md D4 and D6. A null result means `MALFORMED_GIT_OUTPUT`.
// No rule reads message text. Configuration values follow Git's last-value rule.

import { isUtf8 } from "node:buffer";
import { FETCH_FLAGS } from "../contracts/envelope";
import { SYNC_FETCH_LISTED_REFS } from "../contracts/limits";
import { isObjectId, type ObjectFormat } from "./commands";
import { type ConfigEntry, parseMaybeBool } from "./trust";

export { FETCH_FLAGS, SYNC_FETCH_LISTED_REFS };

const LF = 0x0a;
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

// ---- Fetch porcelain (git-fetch(1) OUTPUT) ----

export type FetchFlag = (typeof FETCH_FLAGS)[number];

export interface FetchUpdate {
  flag: FetchFlag;
  oldObjectId: string;
  newObjectId: string;
  ref: string;
}

export interface FetchList {
  updates: FetchUpdate[];
  counts: Record<FetchFlag, number>;
}

// The contract `\S` is ASCII. git-check-ref-format(1) refuses ASCII spaces and controls in a ref name.
const FETCH_LINE = /^([ +\-t*!=]) ([0-9a-f]+) ([0-9a-f]+) ([^ \t\n\v\f\r]+)$/;

// Takes stdout in frames of any size. One broken line makes the whole list malformed.
export function createFetchParser(objectFormat: ObjectFormat) {
  const updates: FetchUpdate[] = [];
  const counts = Object.fromEntries(FETCH_FLAGS.map((flag) => [flag, 0])) as Record<FetchFlag, number>;
  let pending = new Uint8Array(0);
  let broken = false;

  const line = (bytes: Uint8Array) => {
    const m = FETCH_LINE.exec(utf8.decode(bytes));
    if (!m || !isObjectId(m[2]!, objectFormat) || !isObjectId(m[3]!, objectFormat)) {
      broken = true;
      return;
    }
    const flag = m[1] as FetchFlag;
    counts[flag]++;
    if (updates.length < SYNC_FETCH_LISTED_REFS) updates.push({ flag, oldObjectId: m[2]!, newObjectId: m[3]!, ref: m[4]! });
  };

  return {
    push(chunk: Uint8Array): void {
      if (broken) return;
      const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let at = 0;
      for (let lf = data.indexOf(LF); lf >= 0 && !broken; lf = data.indexOf(LF, at)) {
        line(data.subarray(at, lf));
        at = lf + 1;
      }
      pending = Uint8Array.from(data.subarray(at));
    },
    end(): FetchList | null {
      return broken || pending.length > 0 ? null : { updates, counts };
    },
  };
}

// ---- Push porcelain (git-push(1) OUTPUT, transport.c `print_ref_status`) ----

export type PushStatus = "pushed" | "forced" | "created" | "up-to-date" | "rejected" | "remote-rejected" | "remote-failure" | "none";
export interface PushLine {
  status: PushStatus;
  // Display only (FR-015).
  reasonText: string | null;
}

const PUSHED: ReadonlyMap<string, PushStatus> = new Map([
  [" ", "pushed"],
  ["+", "forced"],
  ["*", "created"],
  ["=", "up-to-date"],
]);
const REFUSED: ReadonlyMap<string, PushStatus> = new Map([
  ["[rejected]", "rejected"],
  ["[remote rejected]", "remote-rejected"],
  ["[remote failure]", "remote-failure"],
]);
const STATUS_LINE = /^(.)\t([^\t]*)\t(.*)$/;
const NONE: PushLine = { status: "none", reasonText: null };

// `<summary>[ (<reason>)]`. Only a bracketed summary holds a space.
function pushLine(flag: string, rest: string): PushLine | null {
  const end = rest.startsWith("[") ? rest.indexOf("]") + 1 : rest.includes(" ") ? rest.indexOf(" ") : rest.length;
  if (end <= 0) return null;
  const tail = rest.slice(end);
  if (tail !== "" && !(tail.startsWith(" (") && tail.endsWith(")"))) return null;
  const status = flag === "!" ? REFUSED.get(rest.slice(0, end)) : PUSHED.get(flag);
  return status === undefined ? null : { status, reasonText: tail === "" ? null : tail.slice(2, -1) };
}

// `refspec` is `<from>:<to>` as the push argv holds it. Exactly one status line must carry it.
export function parsePushPorcelain(stdout: Uint8Array, refspec: string, exitCode: number): PushLine | null {
  const text = utf8.decode(stdout);
  if (text !== "" && !text.endsWith("\n")) return null;
  let found: PushLine | null = null;
  let matches = 0;
  let unknown = false;
  for (const line of text.split("\n").slice(0, -1)) {
    if (line === "Done" || line.startsWith("To ")) continue;
    const m = STATUS_LINE.exec(line);
    if (!m) unknown = true;
    else if (m[2] === refspec) {
      matches++;
      found = pushLine(m[1]!, m[3]!);
      if (!found) unknown = true;
    }
  }
  if (matches > 1) return null;
  if (found && !unknown) return found;
  return exitCode !== 0 ? NONE : null;
}

// `remote get-url --push --all`: one URL per line. O-11 accepts exactly one.
export function parsePushUrls(stdout: Uint8Array): { url: string } | { reason: "push-urls" } | null {
  const text = utf8.decode(stdout);
  if (text === "") return { reason: "push-urls" };
  if (!text.endsWith("\n")) return null;
  const urls = text.slice(0, -1).split("\n");
  if (urls.includes("")) return null;
  return urls.length === 1 ? { url: urls[0]! } : { reason: "push-urls" };
}

// ---- Tracking records (contract Δ3 `readTracking`, data-model §1) ----

export type Track = { state: "none" } | { state: "gone" } | { state: "counts"; ahead: number; behind: number };

export interface TrackingEntry {
  name: string;
  invalidUtf8: boolean;
  objectId: string;
  upstream: string | null;
  upstreamObjectId: string | null;
  track: Track;
  current: boolean;
}

// ref-filter.c `msgs`: the untranslated plumbing forms without brackets.
const TRACK = /^(?:|gone|ahead [1-9][0-9]*|behind [1-9][0-9]*|ahead [1-9][0-9]*, behind [1-9][0-9]*)$/;
const COUNT = /(ahead|behind) ([0-9]+)/g;
const HEADS = "refs/heads/";

// Byte strings: `latin1` maps each byte to one code unit, so equal strings mean equal bytes.
const text = (bytes: string): string => Buffer.from(bytes, "latin1").toString("utf8");

export function parseTracking(stdout: Uint8Array, objectFormat: ObjectFormat): TrackingEntry[] | null {
  const raw = Buffer.from(stdout).toString("latin1");
  if (raw === "") return [];
  if (!raw.endsWith("\n")) return null;
  const records: string[][] = [];
  let current = 0;
  for (const line of raw.slice(0, -1).split("\n")) {
    const f = line.split("\0");
    if (f.length !== 5) return null;
    const [refname, oid, upstream, track, head] = f as [string, string, string, string, string];
    const local = refname.startsWith(HEADS);
    if (!local && !refname.startsWith("refs/remotes/")) return null;
    if (!isObjectId(oid, objectFormat) || (upstream !== "" && !upstream.startsWith("refs/"))) return null;
    if (!TRACK.test(track) || (track !== "" && !(local && upstream !== ""))) return null;
    if (head !== " " && !(head === "*" && local && ++current === 1)) return null;
    records.push(f);
  }
  const oids = new Map(records.map(([refname, oid]) => [refname!, oid!]));
  return records
    .filter(([refname]) => refname!.startsWith(HEADS))
    .map(([refname, oid, upstream, track, head]) => {
      const name = Buffer.from(refname!.slice(HEADS.length), "latin1");
      let state: Track = { state: "none" };
      if (track === "gone") state = { state: "gone" };
      else if (upstream !== "") {
        const counts = { ahead: 0, behind: 0 };
        for (const [, side, n] of track!.matchAll(COUNT)) counts[side as "ahead" | "behind"] = Number(n);
        state = { state: "counts", ...counts };
      }
      return {
        name: name.toString("utf8"),
        invalidUtf8: !isUtf8(name),
        objectId: oid!,
        upstream: upstream === "" ? null : text(upstream!),
        upstreamObjectId: (upstream !== "" && oids.get(upstream!)) || null,
        track: state,
        current: head === "*",
      };
    });
}

// git-rev-list(1) `--left-right --count`: "left TAB right" (builtin/rev-list.c).
export function parseAheadBehind(stdout: Uint8Array): { ahead: number; behind: number } | null {
  const m = /^(0|[1-9][0-9]*)\t(0|[1-9][0-9]*)\n$/.exec(utf8.decode(stdout));
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
}

// Contract Δ3 read 8: `show-ref --verify REBASE_HEAD` prints "<oid> REBASE_HEAD" and LF.
export function parseRebaseHead(stdout: Uint8Array, objectFormat: ObjectFormat): string | null {
  const text = utf8.decode(stdout);
  const suffix = " REBASE_HEAD\n";
  if (!text.endsWith(suffix)) return null;
  const oid = text.slice(0, -suffix.length);
  return isObjectId(oid, objectFormat) ? oid : null;
}

// Plan.md D7: a line of `rebase-merge/git-rebase-todo` that Git runs with the shell. sequencer.c `todo_list_parse_insn_buffer` ends a line at LF and drops a final CR.
// `parse_insn_line` drops leading spaces and tabs. `is_command` takes `exec` or its abbreviation `x` before a space, a tab, CR, LF, or the end (`todo_command_info`).
// `sequencer_parse_todo_command` matches the commands before `comment_line_str`, so `core.commentChar` cannot turn such a line into a comment.
export function holdsExec(todo: Uint8Array): boolean {
  return Buffer.from(todo)
    .toString("latin1")
    .split("\n")
    .some((line) => {
      const word = /^[ \t]*([^ \t\r\0]*)/.exec(line)![1];
      return word === "exec" || word === "x";
    });
}

// git-rev-list(1) `--count`: one decimal line. Plan.md D5 counts the commits that a force push removes.
export function parseRevListCount(stdout: Uint8Array): number | null {
  const m = /^(0|[1-9][0-9]*)\n$/.exec(utf8.decode(stdout));
  return m ? Number(m[1]) : null;
}

// ---- Configuration ----

export type ConfigValue = Pick<ConfigEntry, "key" | "value">;

// `git_config_get_value`: the last value wins. Git prints the section and the variable in lowercase.
function lastEntry(config: readonly ConfigValue[], key: string): ConfigValue | undefined {
  let found: ConfigValue | undefined;
  for (const entry of config) if (entry.key === key) found = entry;
  return found;
}

// ---- D4 push destination (remote.c `branch_get_push_1`) ----

// The plan.md D4 `for-each-ref` record of `refs/heads/<branch>`. Empty fields are "".
export interface PushRecord {
  branch: string;
  upstream: string;
  upstreamRemote: string;
  upstreamRemoteRef: string;
  push: string;
  pushRemote: string;
  pushRemoteRef: string;
}

// The pattern `refs/heads/<branch>` also matches the refs below it, so only the record with an equal refname counts.
// "absent": no such branch.
export function parsePushRecord(stdout: Uint8Array, branch: string, objectFormat: ObjectFormat): PushRecord | "absent" | null {
  const raw = Buffer.from(stdout).toString("latin1");
  if (raw === "") return "absent";
  if (!raw.endsWith("\n")) return null;
  const wanted = Buffer.from(`${HEADS}${branch}`, "utf8").toString("latin1");
  const isRef = (field: string) => field === "" || field.startsWith("refs/");
  let found: string[] | undefined;
  for (const line of raw.slice(0, -1).split("\n")) {
    const f = line.split("\0");
    if (f.length !== 8 || !f[0]!.startsWith(HEADS) || !isObjectId(f[1]!, objectFormat)) return null;
    if (![f[2], f[4], f[5], f[7]].every((field) => isRef(field!))) return null;
    if (f[0] !== wanted) continue;
    if (found) return null;
    found = f.map(text);
  }
  if (!found) return "absent";
  const [, , upstream, upstreamRemote, upstreamRemoteRef, push, pushRemote, pushRemoteRef] = found as [string, string, string, string, string, string, string, string];
  return { branch, upstream, upstreamRemote, upstreamRemoteRef, push, pushRemote, pushRemoteRef };
}

export interface PushDestination {
  remote: string;
  ref: string;
  // Null gives `no-lease` for Force push with lease (plan.md D5).
  trackingRef: string | null;
  source: "remote-push-refspec" | "push-default-upstream" | "push-default-branch" | "push-default-triangular";
}

export type PushDecision =
  | { kind: "destination"; destination: PushDestination }
  | { kind: "panel"; prefill: PushDestination | null }
  | { kind: "refused"; reason: "remote-missing" | "mirror" | "push-remote-differs" | "several-merge-refs" | "invalid-config" };

const PANEL: PushDecision = { kind: "panel", prefill: null };

const severalMergeRefs = (config: readonly ConfigValue[], branch: string): boolean => config.filter((e) => e.key === `branch.${branch}.merge`).length > 1;

// remote.c `remote_for_branch`: a push without an explicit remote goes to `origin` (git-push(1)).
const DEFAULT_REMOTE = "origin";

function destinationSteps(r: PushRecord, remotes: readonly string[], config: readonly ConfigValue[]): PushDecision {
  const remote = r.pushRemote === "" ? DEFAULT_REMOTE : r.pushRemote;
  if (r.pushRemote === "" && !remotes.includes(remote)) return PANEL;
  if (!remotes.includes(remote)) return { kind: "refused", reason: "remote-missing" };
  const mirror = lastEntry(config, `remote.${remote}.mirror`);
  const isMirror = mirror === undefined ? 0 : parseMaybeBool(mirror.value);
  if (isMirror < 0) return { kind: "refused", reason: "invalid-config" };
  if (isMirror === 1) return { kind: "refused", reason: "mirror" };
  const to = (ref: string, source: PushDestination["source"], trackingRef: string | null = r.push || null): PushDecision => ({ kind: "destination", destination: { remote, ref, trackingRef, source } });
  if (r.pushRemoteRef !== "") return to(r.pushRemoteRef, "remote-push-refspec");
  const branchRef = `refs/heads/${r.branch}`;
  // config.c `git_default_push_config` compares with `strcmp`. Unset means `simple`.
  const entry = lastEntry(config, "push.default");
  const mode = entry === undefined ? "simple" : entry.value;
  if (mode === "current") return to(branchRef, "push-default-branch");
  // builtin/push.c `get_upstream_ref` stops on more than one `branch.<name>.merge` value.
  const severalMerges = severalMergeRefs(config, r.branch);
  if (mode === "simple") {
    // builtin/push.c `is_same_remote`: Git pushes a triangular `simple` like `current`. `branch_get_push_1` gives no `%(push)` for it.
    if ((lastEntry(config, `branch.${r.branch}.remote`)?.value ?? DEFAULT_REMOTE) !== remote) return to(branchRef, "push-default-triangular", null);
    if (severalMerges) return { kind: "refused", reason: "several-merge-refs" };
    return r.push === "" ? PANEL : to(branchRef, "push-default-branch");
  }
  if (mode === "upstream" || mode === "tracking") {
    if (r.upstreamRemote !== remote) return { kind: "refused", reason: "push-remote-differs" };
    if (severalMerges) return { kind: "refused", reason: "several-merge-refs" };
    return r.upstream === "" ? PANEL : to(r.upstreamRemoteRef, "push-default-upstream");
  }
  // Git pushes a `matching` branch only when the remote advertises its name at push time. The review contacts no remote.
  if (mode === "matching") return PANEL;
  return { kind: "refused", reason: "invalid-config" };
}

// remote.c `handle_config` (Git 2.56.0) reads every entry of these keys. A bad value stops `git remote`, fetch, push, and each `%(upstream)` or `%(push)` read.
// It skips a `remote.<name>` key whose name starts with "/" (research R16 m, contract Δ3 `reviewSync`).
// `git_config_bool` keys of `remote.<name>`.
const BOOLEAN_REMOTE_KEYS: ReadonlySet<string> = new Set(["mirror", "skipdefaultupdate", "skipfetchall", "prune", "prunetags"]);
// Keys that stop Git without a value, by section. `git_config_string`, `config_error_nonbool`, and `parse_transport_option` refuse them (exit 128).
// `tagopt` and `followremotehead` pass the missing value to `strcmp` (exit 139 on 2.56.0.windows.2). `remote.pushdefault` has no subsection.
const STRING_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["branch", new Set(["remote", "pushremote", "merge"])],
  ["url", new Set(["insteadof", "pushinsteadof"])],
  ["remote", new Set(["url", "pushurl", "push", "fetch", "receivepack", "uploadpack", "tagopt", "proxy", "proxyauthmethod", "vcs", "serveroption", "negotiationrestrict", "negotiationinclude", "followremotehead"])],
]);

function stopsGit({ key, value }: ConfigValue): boolean {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  const section = key.slice(0, first);
  if (first === last) return key === "remote.pushdefault" && value === null;
  if (section === "remote" && key[first + 1] === "/") return false;
  const variable = key.slice(last + 1);
  if (section === "remote" && BOOLEAN_REMOTE_KEYS.has(variable)) return parseMaybeBool(value) < 0;
  return value === null && (STRING_KEYS.get(section)?.has(variable) ?? false);
}

// The check of every review, on the trust listing entries before the `remote` read. True gives `invalid-config`.
export function invalidRemoteValue(config: readonly ConfigValue[]): boolean {
  return config.some(stopsGit);
}

export function decidePushDestination(record: PushRecord, remotes: readonly string[], config: readonly ConfigValue[]): PushDecision {
  if (invalidRemoteValue(config)) return { kind: "refused", reason: "invalid-config" };
  const steps = destinationSteps(record, remotes, config);
  if (record.upstream !== "") return steps;
  return { kind: "panel", prefill: steps.kind === "destination" ? steps.destination : null };
}

// ---- D6 pull decision (builtin/pull.c `cmd_pull`, data-model §6) ----

export type ModeSource = "payload" | "branch" | "pull" | "pull-ff";

export type PullDecision =
  | { kind: "up-to-date" }
  | { kind: "mode-required" }
  | { kind: "fast-forward"; source: ModeSource | null }
  | { kind: "merge"; ff: "--ff" | "--no-ff" | null; source: ModeSource | null }
  | { kind: "rebase"; rebaseMerges: boolean; source: ModeSource }
  | { kind: "refused"; reason: "ff-only" | "interactive-rebase" | "invalid-config" | "several-merge-refs" };

export interface PullInput {
  ahead: number;
  behind: number;
  branch: string;
  mode: "rebase" | "merge" | null;
  config: readonly ConfigValue[];
}

type Rebase = "false" | "true" | "merges" | "interactive";

// rebase.c `rebase_parse_value`: Git compares the words with `strcmp`.
function rebaseValue(value: string | null): Rebase | null {
  const bool = parseMaybeBool(value);
  if (bool >= 0) return bool === 1 ? "true" : "false";
  if (value === "merges" || value === "m") return "merges";
  if (value === "interactive" || value === "i") return "interactive";
  return null;
}

const refusePull = (reason: Extract<PullDecision, { kind: "refused" }>["reason"]): PullDecision => ({ kind: "refused", reason });

export function decidePull(input: PullInput): PullDecision {
  const { config, branch } = input;
  if (severalMergeRefs(config, branch)) return refusePull("several-merge-refs");

  // `config_get_ff`: Git reads `pull.ff` first and stops on an invalid value.
  let ff: "--ff" | "--no-ff" | "--ff-only" | null = null;
  const ffEntry = lastEntry(config, "pull.ff");
  if (ffEntry !== undefined) {
    const bool = parseMaybeBool(ffEntry.value);
    ff = bool === 1 ? "--ff" : bool === 0 ? "--no-ff" : ffEntry.value === "only" ? "--ff-only" : null;
    if (ff === null) return refusePull("invalid-config");
  }

  // An explicit mode turns `--ff-only` into `--ff`, and Git then reads no rebase value (`config_get_rebase`).
  let rebase: Rebase | null = null;
  let source: ModeSource | null = null;
  if (input.mode !== null) {
    rebase = input.mode === "rebase" ? "true" : "false";
    source = "payload";
    if (ff === "--ff-only") ff = "--ff";
  } else {
    const branchEntry = lastEntry(config, `branch.${branch}.rebase`);
    const entry = branchEntry ?? lastEntry(config, "pull.rebase");
    if (entry !== undefined) {
      rebase = rebaseValue(entry.value);
      if (rebase === null) return refusePull("invalid-config");
      source = branchEntry !== undefined ? "branch" : "pull";
    }
  }

  if (input.behind === 0) return { kind: "up-to-date" };
  const diverged = input.ahead > 0;
  // "ff-only takes precedence over rebase".
  if (ff === "--ff-only") return diverged ? refusePull("ff-only") : { kind: "fast-forward", source: "pull-ff" };
  if (diverged && ff === null && rebase === null) return { kind: "mode-required" };
  source ??= ff === null ? null : "pull-ff";
  if (rebase === "true" || rebase === "merges" || rebase === "interactive") {
    // A rebase pull that can fast-forward runs `merge --ff-only`, also with `pull.ff=false`.
    if (!diverged) return { kind: "fast-forward", source };
    if (rebase === "interactive") return refusePull("interactive-rebase");
    return { kind: "rebase", rebaseMerges: rebase === "merges", source: source! };
  }
  // Without a `pull.ff` option, Git's pull runs `merge` with none, so `merge.ff` applies also when only behind.
  if (!diverged && ff === "--ff") return { kind: "fast-forward", source };
  return { kind: "merge", ff, source };
}
