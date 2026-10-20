// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
// Type-only imports keep zod out of the renderer bundle.
import type { z } from "zod";
import type { ReadGitSettingsResult } from "../../../contracts/envelope";
import { codeText, OutputTail, unknownFormText, unknownReadText } from "../../app/RepositoryStates";
import type { BridgeResponse, createBridge } from "../../bridge";
import { RUNNING_REASON, RunningTooltip } from "../../components/running-tooltip";
import { matches } from "../../components/switcher-popover";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { KEYS } from "../../keyboard/shortcuts";
import { isObject } from "../../lib/utils";
import { trackOperation, type StatusOperation } from "../../status/OperationStatus";
import { PRESETS, type Preset } from "./presets";
import { ENUM_LABELS, TEXTS, type EntryScope, type Scope } from "./texts";

// Feature 004 spec FR-058 to FR-065 and FR-067, plan.md D11 and D15 "Settings", contract Δ3 `readGitSettings` and `config-save`, data-model §2 and §9.

export type GitSettings = z.infer<typeof ReadGitSettingsResult>;
export type ConfigValue = GitSettings["values"][number];
type ConfigEntry = ConfigValue["entries"][number];
type Writable = "local" | "global";
type Target = { repositoryId: string; repositoryGeneration: number };
export type GitBridge = Pick<ReturnType<typeof createBridge>, "readGitSettings" | "reviewWorkbench" | "runWorkbench">;

/** The FR-060 pages in page order. A tool key of `readGitSettings` follows its tool key (contract Δ3). */
export const GIT_PAGES: { name: string; keys: string[] }[] = [
  { name: "User", keys: ["user.name", "user.email"] },
  { name: "Editor and tools", keys: ["core.editor", "commit.template", "diff.tool", "merge.tool"] },
  { name: "Line endings", keys: ["core.autocrlf", "i18n.filesencoding"] },
  { name: "Pull and push", keys: ["pull.rebase", "pull.ff", "push.default", "push.autosetupremote"] },
  { name: "Fetch", keys: ["fetch.prune"] },
  { name: "Merge and rebase", keys: ["merge.autostash", "rebase.autostash", "rebase.autosquash", "rebase.updaterefs"] },
  { name: "Credentials", keys: ["credential.helper"] },
  { name: "Advanced", keys: ["rerere.enabled", "rerere.autoupdate"] },
];
const TOOL_SECTIONS: Record<string, string> = { "diff.tool": "difftool.", "merge.tool": "mergetool." };

/** Pending changes of one scope: the new value, or null to unset. */
type Pending = Record<string, string | null>;
type Read = { state: "loading" } | { state: "loaded"; value: GitSettings } | { state: "failed"; text: ReactNode };

export type GitSettingsProps = {
  bridge: GitBridge;
  /** Null without an open repository. The hook then reads nothing (plan D15). */
  target: Target | null;
  /** True while any Git operation runs. Save then gives the running reason in its tooltip only (plan D15 running rule). */
  operationRunning: boolean;
  onOperation(op: StatusOperation): void;
  /** The store's `ended("runWorkbench", response)`. */
  onEnded(response: BridgeResponse): void;
};

const own = (value: ConfigValue, scope: Writable): ConfigEntry | undefined => value.scopes[scope][0];
const writable = (scope: Scope): scope is Writable => scope === "local" || scope === "global";
type PlanChange = { key: string; earlier: { origin: string; value: string | null } | null };
// Contract Δ3: a `config-save` plan change holds `key` and `earlier`.
const isPlanChange = (c: unknown): c is PlanChange =>
  isObject(c) && typeof c.key === "string" && (c.earlier === null || (isObject(c.earlier) && typeof c.earlier.origin === "string" && (c.earlier.value === null || typeof c.earlier.value === "string")));

/** The read, the pending changes of each writable scope, and Save. One instance lives for the open Settings view. */
export function useGitSettings({ bridge, target, operationRunning, onOperation, onEnded }: GitSettingsProps) {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [pending, setPending] = useState<Record<Writable, Pending>>({ local: {}, global: {} });
  const [message, setMessage] = useState<ReactNode>(null);
  const [saving, setSaving] = useState(false);
  // Cancel and each new read remount the rows, so a row drops its local state, such as an open Custom field.
  const [epoch, setEpoch] = useState(0);
  const seq = useRef(0);
  const repositoryId = target?.repositoryId ?? null;
  const repositoryGeneration = target?.repositoryGeneration ?? null;

  const reload = useCallback(() => {
    const mine = ++seq.current;
    if (repositoryId === null) return;
    void bridge.readGitSettings({ repositoryId }).then((response) => {
      if (mine !== seq.current) return;
      const result = response.result as Partial<GitSettings> | undefined;
      const ok = response.state === "succeeded" && Array.isArray(result?.values) && isObject(result?.files);
      setRead(ok ? { state: "loaded", value: result as GitSettings } : { state: "failed", text: response.state === "succeeded" ? unknownReadText("The Git settings") : codeText(TEXTS.loadFailed, response.code ?? response.state) });
      setEpoch((e) => e + 1);
    });
  }, [bridge, repositoryId]);
  useEffect(() => reload(), [reload, repositoryGeneration]);

  function change(scope: Writable, value: ConfigValue, next: string | null) {
    const entry = own(value, scope);
    setPending((p) => {
      const scoped = { ...p[scope] };
      // A value equal to the read is no change.
      if (entry === undefined ? next === null : next === entry.value) delete scoped[value.key];
      else scoped[value.key] = next;
      return { ...p, [scope]: scoped };
    });
  }
  const cancel = (scope: Writable) => {
    setPending((p) => ({ ...p, [scope]: {} }));
    setMessage(null);
    setEpoch((e) => e + 1);
  };

  async function save(scope: Writable) {
    if (target === null || repositoryId === null || read.state !== "loaded" || saving || operationRunning) return;
    const shown = read.value;
    const scoped = pending[scope];
    const changes = Object.entries(scoped).map(([key, value]) => ({ key, value }));
    if (changes.length === 0) return;
    setSaving(true);
    setMessage(null);
    const review = await bridge.reviewWorkbench(target, { action: "config-save", scope, changes });
    const reviewed = isObject(review.result) ? review.result : {};
    const token = review.state === "succeeded" && typeof reviewed.workbenchToken === "string" ? reviewed.workbenchToken : null;
    if (token === null) {
      setSaving(false);
      const reason = typeof reviewed.reason === "string" ? reviewed.reason : null;
      setMessage(review.state === "succeeded" ? unknownFormText(TEXTS.save) : codeText(TEXTS.unavailable, reason ?? review.code ?? review.state));
      if (reason !== null) reload();
      return;
    }
    // Contract Δ3: the plan `earlier` entry shows a change between the read and the review. The run needs the shown values.
    const plan = isObject(reviewed.plan) && Array.isArray(reviewed.plan.changes) ? (reviewed.plan.changes as unknown[]) : null;
    // Plan D15 "Malformed result": without the plan changes of known form, the earlier check has no input.
    if (plan === null || !plan.every(isPlanChange)) {
      setSaving(false);
      setMessage(unknownFormText(TEXTS.save));
      reload();
      return;
    }
    const same = plan.every((c) => {
      const value = shown.values.find((v) => v.key === c.key);
      const entry = value === undefined ? undefined : own(value, scope);
      return c.earlier === null ? entry === undefined : entry !== undefined && entry.origin === c.earlier.origin && entry.value === c.earlier.value;
    });
    if (!same) {
      setSaving(false);
      setMessage(TEXTS.changedOutside);
      reload();
      return;
    }
    const response = await trackOperation(
      "runWorkbench",
      undefined,
      (onProgress) => bridge.runWorkbench({ repositoryId }, { workbenchToken: token, start: true }, onProgress),
      (op) => onOperation({ ...op, texts: TEXTS.run }),
    );
    onEnded(response);
    setSaving(false);
    const result = isObject(response.result) ? response.result : {};
    const written = new Set(Array.isArray(result.written) ? (result.written as string[]) : []);
    const failed = isObject(result.failed) && typeof result.failed.key === "string" ? (result.failed as { key: string; exitCode: number | null; reason?: string }) : null;
    const stale = typeof result.stale === "string" ? result.stale : null;
    const tail = typeof result.outputTail === "string" && result.outputTail !== "" ? result.outputTail : null;
    const done = response.state === "succeeded" && failed === null && stale === null;
    setPending((p) => ({ ...p, [scope]: done ? {} : Object.fromEntries(Object.entries(p[scope]).filter(([key]) => !written.has(key))) }));
    if (done) setMessage(TEXTS.saved);
    else if (response.code === "STALE_REVIEW") setMessage(TEXTS.staleReview);
    else
      setMessage(
        <>
          {failed !== null ? <p>{TEXTS.writeFailed(failed.key, failed.reason, failed.exitCode)}</p> : null}
          {stale !== null ? <p>{TEXTS.staleKey(stale)}</p> : null}
          {failed === null && stale === null ? <p>{codeText(TEXTS.failed, response.code ?? response.state)}</p> : null}
          {tail === null ? null : <OutputTail text={tail} />}
        </>,
      );
    reload();
  }

  return { read, pending, message, saving, operationRunning, epoch, change, cancel, save };
}
export type GitSettingsState = ReturnType<typeof useGitSettings>;

/** The scope part of the scope bar: the four scopes and the file of the selected one (FR-058, FR-059). */
export function ScopePicker({ scope, onScope, files }: { scope: Scope; onScope(scope: Scope): void; files: GitSettings["files"] | null }) {
  const legend = useId();
  const fileId = useId();
  const options: { value: Scope; label: string; readOnly: boolean }[] = [
    { value: "effective", label: "Effective", readOnly: true },
    { value: "local", label: TEXTS.scopeName("local"), readOnly: false },
    { value: "global", label: TEXTS.scopeName("global"), readOnly: false },
    { value: "system", label: TEXTS.scopeName("system"), readOnly: true },
  ];
  const file = files === null ? null : scopeFile(scope, files);
  return (
    <>
      <fieldset data-slot="scope-picker" aria-labelledby={legend} className="flex shrink-0 items-center rounded-sm border border-control-border">
        <legend id={legend} className="sr-only">
          {TEXTS.scope}
        </legend>
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1.5 px-3 has-checked:bg-selected-row has-checked:font-semibold has-focus-visible:outline-2 has-focus-visible:outline-accent-role" style={{ height: "var(--h-button)" }}>
            <input type="radio" name="scope" value={o.value} checked={scope === o.value} onChange={() => onScope(o.value)} aria-describedby={scope === o.value && file !== null ? fileId : undefined} className="sr-only" />
            {o.label}
            {o.readOnly ? " " : null}
            {o.readOnly ? <span className="font-normal text-muted-text">{TEXTS.readOnlyMark}</span> : null}
          </label>
        ))}
      </fieldset>
      {file === null ? null : (
        // Plan D16 "Geometry": the scope bar keeps one row, so a long file line ends with an ellipsis.
        <Tooltip>
          <TooltipTrigger data-slot="scope-file" render={<span id={fileId} className="min-w-0 truncate text-muted-text" />}>
            {file}
          </TooltipTrigger>
          <TooltipContent>{file}</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function scopeFile(scope: Scope, files: GitSettings["files"]): string | null {
  if (scope === "effective") return TEXTS.effectiveNote;
  if (scope === "system") return files.system === null ? null : TEXTS.readsFrom(files.system);
  const file = files[scope];
  return file !== null ? TEXTS.writesTo(file) : scope === "global" ? TEXTS.noGlobalFile : TEXTS.noLocalFile;
}

const Code = ({ children }: { children: string }) => <code className="font-mono break-all">{children}</code>;
const shownValue = (e: ConfigEntry) => e.value ?? "";

function Entries({ entries }: { entries: ConfigEntry[] }) {
  if (entries.length === 0) return <span className="text-muted-text">{TEXTS.notSet}</span>;
  return (
    <ul className="flex flex-col">
      {entries.map((e, i) => (
        <li key={i}>
          <Code>{shownValue(e)}</Code> <span className="text-muted-text">{TEXTS.from(e.scope, e.origin)}</span>
        </li>
      ))}
    </ul>
  );
}

type RowProps = { value: ConfigValue; scope: Writable; locked: boolean; pending: Pending; onChange(next: string | null): void };

function BoolControl({ value, scope, locked, pending, onChange }: RowProps) {
  const name = useId();
  const note = useId();
  const entry = own(value, scope);
  const next = value.key in pending ? pending[value.key] : undefined;
  const state = next !== undefined ? (next === null ? "unset" : next) : entry === undefined ? "unset" : entry.reading;
  const other = value.entries.filter((e) => e.scope !== scope).at(-1);
  const options: [string, string, string | null][] = [
    ["unset", TEXTS.notSet, null],
    ["true", TEXTS.on, "true"],
    ["false", TEXTS.off, "false"],
  ];
  return (
    <div className="flex flex-col gap-0.5">
      <div role="radiogroup" aria-label={TEXTS.label(value.key)} aria-describedby={entry === undefined ? note : undefined} className="flex flex-wrap items-center gap-3">
        {options.map(([id, label, written]) => (
          <label key={id} className="flex items-center gap-1.5">
            <input type="radio" name={name} checked={state === id} disabled={locked} onChange={() => onChange(written)} />
            {label}
          </label>
        ))}
      </div>
      {/* Plan D15: the note shows only when the read of the selected scope holds no entry for the key. */}
      {entry !== undefined ? null : (
        <span id={note} className="text-muted-text">
          {other === undefined ? TEXTS.notSetDefault : TEXTS.notSetOther(other.reading ?? shownValue(other), other.scope)}
        </span>
      )}
    </div>
  );
}

function EnumControl({ value, scope, locked, pending, onChange }: RowProps) {
  const name = useId();
  const entry = own(value, scope);
  const values = value.type.kind === "enum" ? value.type.values : [];
  const next = value.key in pending ? pending[value.key] : undefined;
  const current = next !== undefined ? (next ?? "") : entry === undefined ? "" : (entry.reading ?? shownValue(entry));
  // A value that Git cannot read for the key keeps its own option, so the control shows it unchanged.
  const extra = current !== "" && !values.includes(current) ? current : null;
  const options: [string, ReactNode][] = [
    ["", TEXTS.notSet],
    ...values.map((v): [string, ReactNode] => [
      v,
      <>
        {ENUM_LABELS[value.key]?.[v] ?? v} <span className="text-muted-text">({v})</span>
      </>,
    ]),
    ...(extra === null ? [] : [[extra, <Code key="extra">{extra}</Code>] as [string, ReactNode]]),
  ];
  return (
    <div role="radiogroup" aria-label={TEXTS.label(value.key)} className="flex flex-col gap-0.5">
      {options.map(([v, label]) => (
        <label key={v} className="flex items-center gap-1.5">
          <input type="radio" name={name} value={v} checked={current === v} disabled={locked} onChange={() => onChange(v === "" ? null : v)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

function TextControl({ value, scope, locked, pending, onChange, label }: RowProps & { label?: string }) {
  const entry = own(value, scope);
  const next = value.key in pending ? pending[value.key] : undefined;
  const current = next !== undefined ? (next ?? "") : entry === undefined ? "" : shownValue(entry);
  return (
    <input
      type="text"
      aria-label={label ?? TEXTS.label(value.key)}
      autoComplete="off"
      spellCheck={false}
      readOnly={locked}
      value={current}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className="h-(--h-row) w-full max-w-[480px] rounded-sm border border-control-border bg-surface px-2 font-mono read-only:bg-canvas"
    />
  );
}

function PresetControl(props: RowProps & { presets: readonly Preset[]; wsl: boolean }) {
  const { value, scope, locked, pending, onChange, wsl } = props;
  const presets = wsl ? [] : props.presets;
  const entry = own(value, scope);
  const next = value.key in pending ? pending[value.key] : undefined;
  const current = next !== undefined ? next : entry === undefined ? null : shownValue(entry);
  const isPreset = current !== null && presets.some((p) => p.value === current);
  const [custom, setCustom] = useState(current !== null && !isPreset);
  const selected = custom ? "custom" : current === null ? "" : isPreset ? current : "custom";
  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={TEXTS.label(value.key)}
        disabled={locked}
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          setCustom(v === "custom");
          if (v !== "custom") onChange(v === "" ? null : v);
        }}
        className="h-(--h-row) w-56 rounded-sm border border-control-border bg-surface px-1"
      >
        <option value="">{TEXTS.notSet}</option>
        {presets.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        <option value="custom">{TEXTS.custom}</option>
      </select>
      {selected === "custom" ? <TextControl {...props} label={`${TEXTS.label(value.key)}, ${TEXTS.custom}`} /> : null}
      {current !== null && selected !== "" ? <span className="text-muted-text">{TEXTS.writesPreset(value.key, current)}</span> : null}
      {wsl ? <span className="text-muted-text">{TEXTS.wslPresets}</span> : null}
    </div>
  );
}

/** One key in the selected scope. Effective and System show the entries only (FR-058). */
function KeyRow({ value, scope, files, pending, wsl, onChange }: { value: ConfigValue; scope: Scope; files: GitSettings["files"]; pending: Pending; wsl: boolean; onChange(next: string | null): void }) {
  const label = TEXTS.label(value.key);
  let body: ReactNode;
  if (scope === "effective") body = <Entries entries={value.effective === null ? [] : [value.effective]} />;
  else if (scope === "system") body = <Entries entries={value.scopes.system} />;
  else {
    const reason = value.readOnly[scope];
    const entries = value.scopes[scope];
    const props: RowProps = { value, scope, locked: reason !== null || files[scope] === null, pending, onChange };
    const presets = PRESETS.get(value.key);
    const control =
      reason === "multi-value" ? null : value.type.kind === "bool" ? <BoolControl {...props} /> : value.type.kind === "enum" ? <EnumControl {...props} /> : presets !== undefined ? <PresetControl {...props} presets={presets} wsl={wsl} /> : <TextControl {...props} />;
    const entry = entries[0];
    body = (
      <>
        {reason === "multi-value" || reason === "unreadable-value" ? <Entries entries={entries} /> : null}
        {control}
        {reason === null ? null : <span className="text-warning">{reason === "multi-value" ? TEXTS.readOnly[reason](value.key) : reason === "included" ? TEXTS.readOnly.included(entry?.origin ?? "") : TEXTS.readOnly[reason]()}</span>}
        {value.key in pending ? (
          <span>
            <span className="font-semibold text-accent-role">{TEXTS.changed}</span> <span className="text-muted-text">{TEXTS.was(entry === undefined ? null : shownValue(entry))}</span>
          </span>
        ) : null}
      </>
    );
  }
  return (
    <div data-key={value.key} className="grid gap-x-3 gap-y-1 border-b border-divider py-2" style={{ gridTemplateColumns: "220px minmax(0, 1fr)" }}>
      <div className="flex min-w-0 flex-col">
        <span>{label}</span>
        <span className="font-mono break-all text-muted-text">{value.key}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">{body}</div>
    </div>
  );
}

/** Plan D15 "Find a setting": the 001 switcher rule over the key label and the Git key name. */
export const keyMatches = (key: string, query: string) => query === "" || matches(TEXTS.label(key), query) || matches(key, query);

/** The keys of one FR-060 page in page order. Without a read, the page has no tool keys. */
export function pageKeys(name: string, values: readonly ConfigValue[] | null): string[] {
  const keys = GIT_PAGES.find((p) => p.name === name)?.keys ?? [];
  return values === null ? keys : pageValues(name, values).map((v) => v.key);
}

/** The keys of one FR-060 page, with the tool keys after their tool. */
function pageValues(name: string, values: readonly ConfigValue[]): ConfigValue[] {
  const keys = GIT_PAGES.find((p) => p.name === name)?.keys ?? [];
  return keys.flatMap((key) => {
    const value = values.find((v) => v.key === key);
    const section = TOOL_SECTIONS[key];
    const tools = section === undefined ? [] : values.filter((v) => v.key.startsWith(section));
    return value === undefined ? tools : [value, ...tools];
  });
}

/** One Git configuration page in the selected scope, with the pending changes and Save (FR-064, FR-065). */
export function GitPage({ name, scope, query, settings, wsl }: { name: string; scope: Scope; query: string; settings: GitSettingsState; wsl: boolean }) {
  const { read, pending, message, epoch, change } = settings;
  if (read.state === "loading") return <p className="text-muted-text">{TEXTS.loading}</p>;
  if (read.state === "failed") return <p role="alert">{read.text}</p>;
  const { values, files } = read.value;
  const scoped: Pending = writable(scope) ? pending[scope] : {};
  return (
    <div className="flex flex-col">
      {writable(scope) && files[scope] !== null ? <p className="text-muted-text">{TEXTS.emptyRemoves}</p> : null}
      {pageValues(name, values)
        .filter((value) => keyMatches(value.key, query))
        .map((value) => (
        <KeyRow key={`${scope}:${value.key}:${epoch}`} value={value} scope={scope} files={files} pending={scoped} wsl={wsl} onChange={(next) => writable(scope) && change(scope, value, next)} />
      ))}
      <div role="status" className="flex flex-col gap-1 pt-2">
        {message}
      </div>
    </div>
  );
}

/** The save row of the selected scope. Plan D16 "Geometry": the view shows it as a full-width footer. */
export function SaveRow({ scope, settings }: { scope: Scope; settings: GitSettingsState }) {
  const { read, pending, saving, operationRunning, cancel, save } = settings;
  const reason = useId();
  const count = writable(scope) ? Object.keys(pending[scope]).length : 0;
  if (!writable(scope) || count === 0) return null;
  // `save` refuses without a loaded read, so Save states the read state as its reason.
  const quiet = saving ? TEXTS.saving : operationRunning ? RUNNING_REASON : read.state === "loading" ? TEXTS.loading : read.state === "failed" ? read.text : null;
  return (
    <div data-slot="settings-save" className="flex shrink-0 flex-wrap items-center gap-2 border-t border-divider bg-canvas px-3 py-2">
      <span className="flex-1">{TEXTS.pending(count, scope)}</span>
      <Button variant="outline" disabled={saving} onClick={() => cancel(scope)}>
        {TEXTS.cancel}
      </Button>
      <RunningTooltip reason={quiet}>
        <Button disabled={quiet !== null} focusableWhenDisabled aria-keyshortcuts={KEYS.save.aria} aria-describedby={quiet === null ? undefined : reason} onClick={() => quiet === null && void save(scope)}>
          {`${TEXTS.save} (${KEYS.save.text})`}
        </Button>
      </RunningTooltip>
      {quiet === null ? null : (
        <span id={reason} hidden>
          {quiet}
        </span>
      )}
    </div>
  );
}
