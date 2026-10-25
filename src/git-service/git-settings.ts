// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Feature 004 contract Δ3 `readGitSettings` and `config-save`, Δ6 `globalConfig`, data-model §2 and §9, plan.md D11, and spec FR-058 to FR-068.
// Only Git's own `config set` and `config unset` write. The service reads no configuration file itself.

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { ProcessContext } from "../contracts/channel";
import { CONFIG_EXIT_REASONS } from "../contracts/envelope";
import { DIAGNOSTIC_RETAINED_BYTES_PER_STREAM, GIT_PROCESS_DEADLINE_MS, TRUST_INPUT_BYTES } from "../contracts/limits";
import { configGlobalPathArgs, configListArgs, configSystemPathArgs } from "./commands";
import { parseConfigPaths } from "./git-installation";
import { createCollector, RunnerRefusal, type GitExit, type GitRunner } from "./git-runner";
import type { Fact, Failure, Stop } from "./hunk-publish";
import { latin1 } from "./read-steps";
import type { Workspace } from "./registration";
import { environmentValue, keyParts, parseConfigListing, redactUrlUserInfo, type ConfigEntry, type ServiceEnvironment } from "./trust";
import { configFileArgs, configSetArgs, configUnsetArgs } from "./workbench-commands";
import { configReading, configView, type ConfigView, type ConfigViewEntry } from "./workbench-parsers";
import { conclude, registerWorkbenchAction, unavailable, type StepEnd } from "./workbench-review";

// Spec FR-060 in page order, as Git prints each key: section and variable in lowercase.
export const SETTINGS_KEYS = [
  "user.name",
  "user.email",
  "core.editor",
  "commit.template",
  "credential.helper",
  "diff.tool",
  "merge.tool",
  "core.autocrlf",
  "i18n.filesencoding",
  "pull.rebase",
  "fetch.prune",
  "merge.autostash",
  "rebase.autostash",
  "rebase.autosquash",
  "rebase.updaterefs",
  "rerere.enabled",
  "rerere.autoupdate",
  "pull.ff",
  "push.default",
  "push.autosetupremote",
] as const;
const FIXED: ReadonlySet<string> = new Set(SETTINGS_KEYS);
// Contract Δ3: the tool keys of the effective `diff.tool` and `merge.tool` values.
const TOOLS = [["diff.tool", "difftool"], ["merge.tool", "mergetool"]] as const;
const TOOL_VARIABLES = ["path", "cmd"];

type Scope = "local" | "global";
type Repository = Pick<Workspace, "repositoryId" | "gitInstallationId" | "commonDirectory" | "wsl">;

export interface GitSettings {
  values: ConfigView[];
  // Data-model §9 `files`: the file that a save of each scope writes. Null: no repository, or no file that the service can name.
  files: { local: string | null; global: string | null; system: string | null };
}

export interface SettingsTarget {
  runner: GitRunner;
  operationId: string;
  signal: AbortSignal;
  gitInstallationId: string;
  // The service environment. Each `read` child keeps its `GIT_CONFIG_GLOBAL` (src/contracts/git-environment.json).
  environment: ServiceEnvironment;
  // Null: no open repository. The listing then runs in the `globalConfig` context (contract Δ6).
  workspace: Repository | null;
}

type Runs = Pick<SettingsTarget, "runner" | "operationId" | "signal">;

const registered = (w: Repository): ProcessContext => ({ contextKind: "registeredOperation", gitInstallationId: w.gitInstallationId, repositoryId: w.repositoryId });

// Git `parse_config_key` folds the section and the variable with the ASCII `tolower`. The subsection keeps its case.
export function canonicalKey(key: string): string | null {
  const p = keyParts(key);
  if (p === null) return null;
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return p.subsection === null ? `${lower(p.section)}.${lower(p.variable)}` : `${lower(p.section)}.${p.subsection}.${lower(p.variable)}`;
}

// A tool value that is no valid UTF-8 has no exact key text, so it gives no tool key.
export function toolKeys(listing: readonly ConfigEntry[]): string[] {
  const keys: string[] = [];
  for (const [key, section] of TOOLS) {
    const tool = listing.filter((e) => e.key === key).at(-1);
    if (tool === undefined || tool.value === null || !tool.exact) continue;
    for (const variable of TOOL_VARIABLES) keys.push(`${section}.${tool.value}.${variable}`);
  }
  return keys;
}

const isToolForm = (key: string): boolean => {
  const p = keyParts(key);
  return p !== null && p.subsection !== null && TOOLS.some(([, section]) => section === p.section) && TOOL_VARIABLES.includes(p.variable);
};

// One `read` process with bounded stdout.
async function read(c: Runs, context: ProcessContext, args: string[], maxBytes: number): Promise<{ value: { exit: GitExit; bytes: Uint8Array; stderrBytes: number } } | Failure | Stop> {
  const stdout = createCollector({ maxBytes });
  const stderr = createCollector({ maxBytes: DIAGNOSTIC_RETAINED_BYTES_PER_STREAM });
  let exit: GitExit;
  try {
    exit = await c.runner.run({ operationId: c.operationId, context, arguments: args, environmentPolicy: "read", limits: { deadlineMs: GIT_PROCESS_DEADLINE_MS }, stdout, stderr, signal: c.signal });
  } catch (error) {
    if (c.signal.aborted) return { stop: "canceled" };
    if (error instanceof RunnerRefusal) return { code: error.code };
    throw error;
  }
  if (c.signal.aborted) return { stop: "canceled" };
  if (exit.deadline !== undefined) return { stop: "deadline" };
  if (exit.diagnosticLimit || stdout.limited) return { code: "OUTPUT_LIMIT" };
  return { value: { exit, bytes: stdout.take(), stderrBytes: stderr.bytes } };
}

// The 001 configuration listing with the 001 trust input bound.
async function listing(c: Runs, context: ProcessContext, args = configListArgs()): Promise<Fact<ConfigEntry[]>> {
  const out = await read(c, context, args, TRUST_INPUT_BYTES);
  if (!("value" in out)) return out;
  if (out.value.exit.exitCode !== 0) return { code: "GIT_FAILED" };
  const entries = parseConfigListing(out.value.bytes, false);
  return entries === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: entries };
}

// Contract §7 "Configuration file paths": git-var(1) lines. Exit 1 without output means that Git reads no such file.
async function varLines(c: Runs, context: ProcessContext, args: string[]): Promise<Fact<string[]>> {
  const out = await read(c, context, args, DIAGNOSTIC_RETAINED_BYTES_PER_STREAM);
  if (!("value" in out)) return out;
  const lines = parseConfigPaths(out.value.exit.exitCode, out.value.bytes, out.value.stderrBytes);
  return lines === null ? { code: "MALFORMED_GIT_OUTPUT" } : { value: lines };
}

// Git `access_or_warn(path, R_OK, 0)`: any failure counts as unreadable.
const readable = (path: string): Promise<boolean> => access(path, constants.R_OK).then(
  () => true,
  () => false,
);

// Git `git_global_config` over the `git_config_val_global` lines of git-var(1). Without `GIT_CONFIG_GLOBAL`, Git prints the XDG file, then `~/.gitconfig`.
// One line without `GIT_CONFIG_GLOBAL` is the XDG file alone: Git then has no home folder and no `--global` file.
async function globalFile(lines: readonly string[], environment: ServiceEnvironment): Promise<string | null> {
  if (environmentValue(environment, "GIT_CONFIG_GLOBAL") !== undefined) return lines.length === 1 ? lines[0]! : null;
  if (lines.length !== 2) return null;
  const [xdg, user] = lines as [string, string];
  return !(await readable(user)) && (await readable(xdg)) ? xdg : user;
}

async function saveFiles(t: SettingsTarget, w: Repository): Promise<Fact<GitSettings["files"]>> {
  const context = registered(w);
  const system = await varLines(t, context, configSystemPathArgs());
  if (!("value" in system)) return system;
  const global = await varLines(t, context, configGlobalPathArgs());
  if (!("value" in global)) return global;
  // Contract §11: a WSL path is a Linux path, so the service cannot check it. Its XDG choice stays unknown.
  const file = w.wsl === undefined ? await globalFile(global.value, t.environment) : null;
  // The separator follows `submoduleLocks` of `reconcile.ts`.
  return { value: { local: `${w.commonDirectory}${w.wsl === undefined ? "/" : "\\"}config`, global: file, system: system.value.length === 1 ? system.value[0]! : null } };
}

// Plan.md D11 "Included": the entries of each scope file alone. Git exits 128 for an absent `--global` file, so a scope without entries runs no read.
async function scopeFiles(c: Runs, w: Repository, entries: readonly ConfigEntry[], scopes: readonly Scope[]): Promise<Fact<Partial<Record<Scope, ConfigEntry[]>>>> {
  const files: Partial<Record<Scope, ConfigEntry[]>> = {};
  for (const scope of scopes) {
    if (!entries.some((e) => e.scope === scope)) continue;
    const file = await listing(c, registered(w), configFileArgs(scope));
    if (!("value" in file)) return file;
    files[scope] = file.value;
  }
  return { value: files };
}

const shown = (text: string | null): string | null => (text === null ? null : redactUrlUserInfo(text));
const shownEntry = (e: ConfigViewEntry): ConfigViewEntry => ({ scope: e.scope, origin: redactUrlUserInfo(e.origin), value: shown(e.value), reading: shown(e.reading) });

// Contract §7 "URL user information": every key, origin, and value passes the redaction.
function shownView(v: ConfigView): ConfigView {
  const scopes = Object.fromEntries(Object.entries(v.scopes).map(([scope, entries]) => [scope, entries.map(shownEntry)])) as ConfigView["scopes"];
  return { ...v, key: redactUrlUserInfo(v.key), entries: v.entries.map(shownEntry), effective: v.effective === null ? null : shownEntry(v.effective), scopes };
}

// Contract Δ3 `readGitSettings`. With a repository, the files come from git-var(1) and Git's `--global` rule (plan.md D11).
export async function readGitSettings(t: SettingsTarget): Promise<Fact<GitSettings>> {
  const w = t.workspace;
  const listed = await listing(t, w === null ? { contextKind: "globalConfig", gitInstallationId: t.gitInstallationId } : registered(w));
  if (!("value" in listed)) return listed;
  // Contract Δ6: the `globalConfig` context admits the listing only, so no git-var(1) read runs there.
  // Without a repository, no scope file listing runs, so no entry counts as included. No save exists then (plan.md D15).
  const own = w === null ? { value: {} } : await scopeFiles(t, w, listed.value, ["local", "global"]);
  if (!("value" in own)) return own;
  const files = w === null ? { value: { local: null, global: null, system: null } } : await saveFiles(t, w);
  if (!("value" in files)) return files;
  const keys = [...SETTINGS_KEYS, ...toolKeys(listed.value)];
  return { value: { values: keys.map((key) => shownView(configView(listed.value, key, own.value))), files: files.value } };
}

// ---- config-save (contract Δ3, data-model §2) ----

interface BoundChange {
  key: string;
  value: string | null;
  // The exact bytes of each entry of the key in the scope: origin, NUL, and the key and value field.
  earlier: string[];
}

const ownEntries = (entries: readonly ConfigEntry[], key: string, scope: Scope) => entries.filter((e) => e.key === key && e.scope === scope);
const exactOf = (e: ConfigEntry) => `${latin1(e.originBytes)}\0${latin1(e.keyValueBytes)}`;
const sameEntries = (entries: readonly ConfigEntry[], c: BoundChange, scope: Scope) => Bun.deepEquals(ownEntries(entries, c.key, scope).map(exactOf), c.earlier, true);

const exitReason = (code: number | null) => (code !== null && code >= 1 && code <= CONFIG_EXIT_REASONS.length ? { reason: CONFIG_EXIT_REASONS[code - 1]! } : {});

registerWorkbenchAction<"config-save", { changes: BoundChange[] }>("config-save", {
  // Contract Δ3: each key from the FR-060 list or a tool key, each key once, and a value that Git reads for the key type.
  // Feature 006 contract Δ11: a WSL Global save runs in the WSL form of the `globalConfig` context, at `/` (spec FR-018).
  precheck(p) {
    const keys = p.changes.map((c) => canonicalKey(c.key));
    if (new Set(keys).size !== keys.length) return { refused: "INVALID_REQUEST" };
    for (const [i, key] of keys.entries()) {
      if (key === null || !(FIXED.has(key) || isToolForm(key))) return { refused: "INVALID_REQUEST" };
      const value = p.changes[i]!.value;
      if (value !== null && configReading(key, value) === null) return { refused: "INVALID_REQUEST" };
    }
    return null;
  },
  async observe(ctx, p) {
    const listed = await listing(ctx, registered(ctx.workspace));
    if (!("value" in listed)) return listed;
    const allowed = new Set([...SETTINGS_KEYS, ...toolKeys(listed.value)]);
    const own = await scopeFiles(ctx, ctx.workspace, listed.value, [p.scope]);
    if (!("value" in own)) return own;
    const changes: (BoundChange & { shown: ConfigEntry | undefined })[] = [];
    for (const c of p.changes) {
      const key = canonicalKey(c.key)!;
      if (!allowed.has(key)) return { refused: "INVALID_REQUEST" };
      // The view rule: `multi-value` (Git's exit 5 without `--all`), `included` (a write of the scope file is not the effective entry), `unreadable-value`.
      const readOnly = configView(listed.value, key, own.value).readOnly[p.scope];
      if (readOnly !== null) return unavailable(readOnly);
      const earlier = ownEntries(listed.value, key, p.scope);
      changes.push({ key, value: c.value, earlier: earlier.map(exactOf), shown: earlier[0] });
    }
    return {
      bound: { changes: changes.map(({ key, value, earlier }) => ({ key, value, earlier })) },
      plan: {
        scope: p.scope,
        changes: changes.map((c) => ({ key: redactUrlUserInfo(c.key), value: shown(c.value), earlier: c.shown === undefined ? null : { origin: redactUrlUserInfo(c.shown.origin), value: shown(c.shown.value) } })),
      },
    };
  },
  started: () => "config-save",
  // Contract Δ3 `runWorkbench` `config-save`: per change, the listing again, then one write. Global writes run in the `globalConfig` context (contract Δ6).
  async run(r, p, b) {
    const w = r.ctx.workspace;
    const context: ProcessContext | undefined = p.scope === "global" ? { contextKind: "globalConfig", gitInstallationId: w.gitInstallationId } : undefined;
    const ends: StepEnd[] = [];
    let failed: { key: string; end: StepEnd } | null = null;
    let stopped: Failure | Stop | null = null;
    let stale: string | null = null;
    for (const [i, c] of b.changes.entries()) {
      const again = await listing(r.ctx, registered(w));
      if (!("value" in again)) {
        stopped = again;
        break;
      }
      // Plan.md D11 "Stale check": a different entry set for that key.
      if (!sameEntries(again.value, c, p.scope)) {
        stale = c.key;
        break;
      }
      const end = await r.step(c.value === null ? configUnsetArgs(p.scope, c.key) : configSetArgs(p.scope, c.key, c.value), "config", { context, counters: { keyIndex: i + 1, keyCount: b.changes.length } });
      ends.push(end);
      if (end.exit?.exitCode !== 0) {
        failed = { key: c.key, end };
        break;
      }
    }
    const settledRun = await r.reconcile(ends);
    const base = { action: "config-save" as const, scope: p.scope };
    if (settledRun === null) return r.unknown({ code: "GIT_FAILED" }, base);
    // Spec FR-065: the fresh listing decides which keys Git wrote. Only a key whose step ran can be written.
    const fresh = await listing(r.q, registered(w));
    if (!("value" in fresh)) return r.unknown(fresh, base);
    const written = b.changes.slice(0, ends.length).filter((c) => !sameEntries(fresh.value, c, p.scope)).map((c) => redactUrlUserInfo(c.key));
    const intended = b.changes.every((c) => {
      const own = ownEntries(fresh.value, c.key, p.scope);
      const last = own.at(-1);
      return c.value === null ? own.length === 0 : last !== undefined && last.exact && last.value === c.value;
    });
    const end = failed?.end;
    const result = {
      ...base,
      written,
      ...(failed === null || end!.canceled ? {} : { failed: { key: redactUrlUserInfo(failed.key), exitCode: end!.exit?.exitCode ?? null, ...exitReason(end!.exit?.exitCode ?? null) } }),
      ...(stale === null ? {} : { stale: redactUrlUserInfo(stale) }),
    };
    if (stale !== null || stopped !== null) {
      if (written.length > 0) return r.finish({ type: "failed-with-effects" }, result);
      if (settledRun.canceled || (stopped !== null && "stop" in stopped && stopped.stop === "canceled")) return r.finish({ type: "no-effects", observed: "canceled" }, result);
      const code = stale !== null ? "STALE_REVIEW" : "code" in stopped! ? stopped.code : "DEADLINE";
      return r.finish({ type: "no-effects", observed: "failed", code }, result);
    }
    conclude(r, { done: failed === null, intended, changed: written.length > 0, canceled: settledRun.canceled, failed: end ?? null }, result);
  },
});
