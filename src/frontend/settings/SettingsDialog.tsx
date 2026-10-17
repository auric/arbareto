// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Cancel01Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BridgeResponse, createBridge } from "../bridge";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { isObject } from "../lib/utils";
import { PUTTY_PROGRAM_NAMES, puttyUnavailableText } from "./ConnectTerminal";

// Feature 003 spec FR-032 to FR-037 and FR-054, plan.md D9 and D12 "Settings panel", O-7, O-8, contract Δ3 shell-only settings operations, and data-model §10.
// Feature 004 moves the sections into its Settings view (004 plan O-7). Each section takes only `settings`, `change`, and its own facts.

type Bridge = ReturnType<typeof createBridge>;
type SettingsBridge = Pick<Bridge, "readSyncSettings" | "setSshClient" | "chooseSyncPath" | "clearSyncPath" | "launchPuttygen">;

/** Data-model §10: the `readSyncSettings` fields that the settings show. */
export type SyncSettings = {
  sshClient: "git" | "plink";
  plinkPath: string | null;
  programs: { program: string; path: string; present: boolean }[];
  remoteKeyFiles: { worktreeKey: string; remote: string; path: string }[];
  defaultCloneFolder: string | null;
};
/** A `remote.<name>.puttykeyfile` value of `readTrust`. It is only a proposal (O-8). */
export type KeyProposal = { remote: string; path: string };

const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isProgram = (p: unknown) => isObject(p) && typeof p.program === "string" && typeof p.path === "string" && typeof p.present === "boolean";
const isKeyFile = (k: unknown) => isObject(k) && typeof k.worktreeKey === "string" && typeof k.remote === "string" && typeof k.path === "string";

/** The settings of a `succeeded` settings response, or null when a field is missing. */
export function syncSettingsOf(response: BridgeResponse): SyncSettings | null {
  const r = response.result;
  if (response.state !== "succeeded" || !isObject(r)) return null;
  if (r.sshClient !== "git" && r.sshClient !== "plink") return null;
  if (!textOrNull(r.plinkPath) || !textOrNull(r.defaultCloneFolder)) return null;
  if (!Array.isArray(r.programs) || !r.programs.every(isProgram) || !Array.isArray(r.remoteKeyFiles) || !r.remoteKeyFiles.every(isKeyFile)) return null;
  return { sshClient: r.sshClient, plinkPath: r.plinkPath, programs: r.programs, remoteKeyFiles: r.remoteKeyFiles, defaultCloneFolder: r.defaultCloneFolder } as SyncSettings;
}

/** Sends one settings operation. It gives the new settings, or null after a canceled picker or a failure. */
export type Change = (send: () => Promise<BridgeResponse>) => Promise<SyncSettings | null>;
type SectionProps = { settings: SyncSettings; change: Change; bridge: SettingsBridge };

const Path = ({ value }: { value: string | null }) => (value === null ? <span className="text-muted-text">Not set</span> : <code className="break-all">{value}</code>);
const ROW = "grid items-center gap-x-3 gap-y-1";
const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const COLUMNS = { gridTemplateColumns: "150px minmax(0, 1fr)" };

/** FR-032, FR-033, FR-036, FR-037, O-7: the SSH client, plink, the PuTTY programs, and PuTTYgen. */
export function SshClientSettings({ settings, change, bridge }: SectionProps) {
  const ids = { heading: useId(), note: useId(), gen: useId(), clear: useId() };
  const [generated, setGenerated] = useState<ReactNode>(null);
  // HTML "radio button state": an arrow key moves the selection and fires `change` during its keydown. Only a click or Space may open the picker.
  const arrow = useRef(false);
  async function choosePlinkClient() {
    let next: SyncSettings | null = settings;
    // FR-033: the user selects the plink program first.
    if (next.plinkPath === null) next = await change(() => bridge.chooseSyncPath({ target: "plink" }));
    if (next === null || next.plinkPath === null) return;
    await change(() => bridge.setSshClient({ kind: "plink" }));
  }
  async function generate() {
    setGenerated(null);
    const next = await change(() => bridge.launchPuttygen());
    setGenerated(next === null ? null : "PuTTYgen started.");
  }
  const genReason = settings.plinkPath === null ? "Choose the plink program first." : null;
  // FR-033: the shell refuses to clear the plink program while the client is plink.
  const clearReason = settings.sshClient === "plink" ? "Select Git's own configuration before you clear the plink program." : null;
  return (
    <section aria-labelledby={ids.heading} className="flex flex-col gap-2">
      <h3 id={ids.heading} className="font-semibold">
        SSH client
      </h3>
      <fieldset
        aria-describedby={ids.note}
        className="flex flex-col gap-1"
        onKeyDown={(event) => void (arrow.current = ARROWS.includes(event.key))}
        onKeyUp={() => void (arrow.current = false)}
      >
        <legend className="sr-only">SSH client</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="sshClient" value="git" checked={settings.sshClient === "git"} onChange={() => void change(() => bridge.setSshClient({ kind: "git" }))} />
          Git's own configuration
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="sshClient" value="plink" checked={settings.sshClient === "plink"} onChange={() => void (arrow.current && settings.plinkPath === null ? undefined : choosePlinkClient())} />
          PuTTY (plink)
        </label>
      </fieldset>
      <p id={ids.note} className="text-muted-text">
        PuTTY applies only to Windows repositories. A WSL repository uses the SSH setup of its distro.
      </p>
      <div className={ROW} style={COLUMNS}>
        <span>Plink program</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Path value={settings.plinkPath} />
          <Button variant="outline" size="sm" onClick={() => void change(() => bridge.chooseSyncPath({ target: "plink" }))}>
            Choose plink…
          </Button>
          {settings.plinkPath === null ? null : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={clearReason !== null}
                focusableWhenDisabled
                aria-describedby={clearReason === null ? undefined : ids.clear}
                onClick={() => clearReason === null && void change(() => bridge.clearSyncPath({ target: "plink" }))}
              >
                Clear plink
              </Button>
              {clearReason === null ? null : (
                <span id={ids.clear} className="text-muted-text">
                  {clearReason}
                </span>
              )}
            </>
          )}
        </div>
      </div>
      {settings.programs.length === 0 ? null : (
        <ul className="flex flex-col gap-1" style={{ paddingLeft: 162 }}>
          {settings.programs.map((p) => (
            <li key={p.program}>
              {`${PUTTY_PROGRAM_NAMES[p.program] ?? p.program}: `}
              <code className="break-all">{p.path}</code>
              {p.present ? null : <span className="text-removed"> Not available</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2" style={{ paddingLeft: 162 }}>
        <Button variant="outline" size="sm" disabled={genReason !== null} focusableWhenDisabled aria-describedby={genReason === null ? undefined : ids.gen} onClick={() => genReason === null && void generate()}>
          Generate or convert a key
        </Button>
        <span id={ids.gen} role="status" className="text-muted-text">
          {genReason ?? generated}
        </span>
      </div>
    </section>
  );
}

/** FR-035 and O-8: one key file for each repository and remote. A Git Extensions value is only a proposal until the user chooses a file. */
export function KeyFileSettings({ settings, change, bridge, repository }: SectionProps & { repository: { worktreeKey: string; proposals: KeyProposal[] } | null }) {
  const ids = { heading: useId(), remote: useId(), reason: useId() };
  const [remote, setRemote] = useState("");
  if (repository === null) {
    return (
      <section aria-labelledby={ids.heading} className="flex flex-col gap-2">
        <h3 id={ids.heading} className="font-semibold">
          Key files for this repository
        </h3>
        <p className="text-muted-text">Open a repository to set its key files.</p>
      </section>
    );
  }
  const { worktreeKey } = repository;
  const saved = new Map(settings.remoteKeyFiles.filter((k) => k.worktreeKey === worktreeKey).map((k) => [k.remote, k.path]));
  const proposed = new Map(repository.proposals.map((p) => [p.remote, p.path]));
  const remotes = [...new Set([...saved.keys(), ...proposed.keys()])];
  const choose = (name: string) => change(() => bridge.chooseSyncPath({ target: "remoteKey", worktreeKey, remote: name }));
  const addReason = remote === "" ? "Enter the remote name." : null;
  return (
    <section aria-labelledby={ids.heading} className="flex flex-col gap-2">
      <h3 id={ids.heading} className="font-semibold">
        Key files for this repository
      </h3>
      {remotes.map((name) => (
        <div key={name} className={ROW} style={COLUMNS}>
          <span className="break-all">{name}</span>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {saved.has(name) ? <code className="break-all">{saved.get(name)}</code> : <span className="text-muted-text">No key file</span>}
              <Button variant="outline" size="sm" onClick={() => void choose(name)}>
                {`Choose key file for ${name}…`}
              </Button>
              {saved.has(name) ? (
                <Button variant="outline" size="sm" onClick={() => void change(() => bridge.clearSyncPath({ target: "remoteKey", worktreeKey, remote: name }))}>
                  {`Clear key file for ${name}`}
                </Button>
              ) : null}
            </div>
            {proposed.has(name) ? (
              <span className="text-muted-text">
                {"Git Extensions setting: "}
                <code className="break-all">{proposed.get(name)}</code>
              </span>
            ) : null}
          </div>
        </div>
      ))}
      <p>Add a key file for another remote</p>
      <div className={ROW} style={COLUMNS}>
        <label htmlFor={ids.remote}>Remote</label>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            id={ids.remote}
            name="remote"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={remote}
            className="h-(--h-row) w-48 rounded-sm border border-control-border bg-surface px-2 font-mono"
            onChange={(event) => setRemote(event.target.value)}
          />
          <Button variant="outline" size="sm" disabled={addReason !== null} focusableWhenDisabled aria-describedby={addReason === null ? undefined : ids.reason} onClick={() => addReason === null && void choose(remote).then((next) => next !== null && setRemote(""))}>
            Choose key file…
          </Button>
          {addReason === null ? null : (
            <span id={ids.reason} className="text-muted-text">
              {addReason}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/** FR-054: the default clone folder. */
export function CloneFolderSettings({ settings, change, bridge }: SectionProps) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2">
      <h3 id={heading} className="font-semibold">
        Default clone folder
      </h3>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Path value={settings.defaultCloneFolder} />
        <Button variant="outline" size="sm" onClick={() => void change(() => bridge.chooseSyncPath({ target: "cloneFolder" }))}>
          Choose default clone folder…
        </Button>
        {settings.defaultCloneFolder === null ? null : (
          <Button variant="outline" size="sm" onClick={() => void change(() => bridge.clearSyncPath({ target: "cloneFolder" }))}>
            Clear default clone folder
          </Button>
        )}
      </div>
    </section>
  );
}

export type SettingsDialogProps = {
  bridge: SettingsBridge;
  /** The open repository: its `worktreeKey` and the `readTrust` key file proposals. Null without a repository. */
  repository: { worktreeKey: string; proposals: KeyProposal[] } | null;
  /** Each response that carries new settings. */
  onSettings?(response: BridgeResponse): void;
  onClose(): void;
};

type Read = { state: "loading" } | { state: "loaded"; value: SyncSettings } | { state: "failed"; code: string };

/** The non-modal settings panel (plan.md D12). */
export function SettingsDialog({ bridge, repository, onSettings, onClose }: SettingsDialogProps) {
  const heading = useId();
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [failure, setFailure] = useState<ReactNode>(null);
  const busy = useRef(false);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    let current = true;
    void bridge.readSyncSettings().then((response) => {
      if (!current) return;
      const value = syncSettingsOf(response);
      setRead(value === null ? { state: "failed", code: response.code ?? response.state } : { state: "loaded", value });
    });
    return () => void (current = false);
  }, [bridge]);
  // Focus moves into the panel at open and back to the opener at close.
  useLayoutEffect(() => {
    const opener = document.activeElement;
    section.current?.querySelector<HTMLElement>("h2")?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const change: Change = async (send) => {
    if (busy.current) return null;
    busy.current = true;
    try {
      const response = await send();
      if (response.state === "canceled") return null;
      const next = syncSettingsOf(response);
      if (next === null) {
        setFailure(puttyUnavailableText(response) ?? `The setting did not change: ${response.code ?? response.state}.`);
        return null;
      }
      setFailure(null);
      setRead({ state: "loaded", value: next });
      onSettings?.(response);
      return next;
    } finally {
      busy.current = false;
    }
  };

  return (
    <section
      ref={section}
      data-slot="settings-panel"
      aria-labelledby={heading}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
        <h2 id={heading} tabIndex={-1} className="flex-1 font-semibold">
          Settings
        </h2>
        <IconButton icon={Cancel01Icon} label="Close settings" keys={{ aria: "Escape", text: "Esc" }} onClick={onClose} />
      </div>
      <div className="flex min-h-0 max-w-[720px] flex-col gap-4 overflow-auto p-3">
        {read.state === "loading" ? <p className="text-muted-text">The settings are still loading…</p> : null}
        {read.state === "failed" ? <p role="alert">{`The settings did not load: ${read.code}.`}</p> : null}
        {failure === null ? null : <p role="alert">{failure}</p>}
        {read.state === "loaded" ? (
          <>
            <SshClientSettings settings={read.value} change={change} bridge={bridge} />
            <KeyFileSettings settings={read.value} change={change} bridge={bridge} repository={repository} />
            <CloneFolderSettings settings={read.value} change={change} bridge={bridge} />
          </>
        ) : null}
      </div>
    </section>
  );
}
