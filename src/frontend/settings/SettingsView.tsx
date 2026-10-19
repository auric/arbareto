// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Cancel01Icon, Search01Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { unknownFormText, unknownReadText } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge } from "../bridge";
import { ConfirmPopover } from "../components/confirm-popover";
import { IconButton } from "../components/icon-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { scopedAction } from "../keyboard/shortcuts";
import type { StatusOperation } from "../status/OperationStatus";
import { PULL_ACTIONS } from "../sync/PullSplitButton";
import { puttyUnavailableText } from "./ConnectTerminal";
import { GIT_PAGES, GitPage, keyMatches, pageKeys, ScopePicker, useGitSettings, type GitBridge } from "./git/GitSettingsPage";
import { TEXTS, type Scope } from "./git/texts";
import { CloneFolderSettings, KeyFileSettings, SshClientSettings, syncSettingsOf, type Change, type KeyProposal, type SettingsBridge, type SyncSettings } from "./SettingsDialog";

// Feature 004 plan.md D15 "Views", "Settings", and the F6 order, O-7. Spec FR-058 to FR-068. Contract Δ3 `readGitSettings`, `config-save`, `setSwitchChoice`, Δ14.

const APP_PAGES = ["SSH", "Clone", "Branch switch"];
const PAGES = [...GIT_PAGES.map((p) => p.name), ...APP_PAGES];

export type SettingsViewProps = {
  bridge: SettingsBridge & GitBridge & Pick<ReturnType<typeof createBridge>, "setDefaultPullAction" | "setSwitchChoice">;
  /** The open repository and its generation, or null. Without it, the Git pages need an open repository (plan D15). */
  target: { repositoryId: string; repositoryGeneration: number } | null;
  /** The open repository: its `worktreeKey` and the `readTrust` key file proposals. Null without a repository. */
  repository: { worktreeKey: string; proposals: KeyProposal[] } | null;
  /** True while a Git operation runs (plan D15 running rule). */
  operationRunning: boolean;
  onOperation(op: StatusOperation): void;
  onEnded(response: BridgeResponse): void;
  /** Each response that carries new app settings. */
  onSettings?(response: BridgeResponse): void;
  /** The page to open on, such as "Editor and tools" (spec FR-093). Without it, the view opens on its D15 first page. */
  page?: string;
  /** Returns to the earlier view without a write (FR-068). */
  onClose(): void;
};

type Read = { state: "loading" } | { state: "loaded"; value: SyncSettings } | { state: "failed"; text: string };

/** An app setting radio group, such as the Pull button default (FR-066) and the switch choice (FR-068). */
function AppChoice<T extends string>({ slot, heading, note, options, value, onChange }: { slot: string; heading: string; note: string; options: { value: T; label: string }[]; value: T; onChange(value: T): void }) {
  const ids = { heading: useId(), note: useId() };
  return (
    <section data-slot={slot} aria-labelledby={ids.heading} className="flex flex-col gap-1 border-b border-divider pb-3">
      <h3 id={ids.heading} className="font-semibold">
        {heading}
      </h3>
      <p className="text-muted-text">{TEXTS.appSetting}</p>
      <div role="radiogroup" aria-labelledby={ids.heading} aria-describedby={ids.note} className="flex flex-col gap-1">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2">
            <input type="radio" name={slot} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      <p id={ids.note} className="text-muted-text">
        {note}
      </p>
    </section>
  );
}

/** The Settings view, a full view inside the main window (FR-068). It holds the Git configuration pages and the app pages. */
export function SettingsView({ bridge, target, repository, operationRunning, onOperation, onEnded, onSettings, page: initialPage, onClose }: SettingsViewProps) {
  const heading = useId();
  const [page, setPage] = useState(initialPage ?? (target === null ? "SSH" : "User"));
  const [scope, setScope] = useState<Scope>("local");
  const [query, setQuery] = useState("");
  const git = useGitSettings({ bridge, target, operationRunning, onOperation, onEnded });
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [failure, setFailure] = useState<ReactNode>(null);
  const busy = useRef(false);
  const section = useRef<HTMLElement>(null);
  const scopeBar = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  // Esc and Close never drop Git setting changes without a confirmation.
  const close = () => (Object.keys(git.pending.local).length + Object.keys(git.pending.global).length > 0 ? setClosing(true) : onClose());
  useEffect(() => {
    let current = true;
    void bridge.readSyncSettings().then((response) => {
      if (!current) return;
      const value = syncSettingsOf(response);
      setRead(value !== null ? { state: "loaded", value } : { state: "failed", text: response.state === "succeeded" ? unknownReadText("The settings") : `The settings did not load: ${response.code ?? response.state}.` });
    });
    return () => void (current = false);
  }, [bridge]);
  // Focus moves into the view at open and back to the opener at close.
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
        setFailure(puttyUnavailableText(response) ?? (response.state === "succeeded" ? unknownFormText("The setting change") : `${TEXTS.appFailed}${response.code ?? response.state}.`));
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

  const app = (render: (settings: SyncSettings) => ReactNode) =>
    read.state === "loading" ? <p className="text-muted-text">The settings are still loading…</p> : read.state === "failed" ? <p role="alert">{read.text}</p> : render(read.value);
  const gitPage = (name: string) => (target === null ? <p>{TEXTS.needsRepository}</p> : <GitPage name={name} scope={scope} query={query} settings={git} />);
  // Plan D15 "Find a setting": a query keeps only the Git pages with a matching key. The app pages hold no Git key.
  const values = git.read.state === "loaded" ? git.read.value.values : null;
  const shown = query === "" ? PAGES : GIT_PAGES.map((p) => p.name).filter((name) => pageKeys(name, values).some((key) => keyMatches(key, query)));
  const active = shown.includes(page) ? page : (shown[0] ?? null);
  function content(name: string): ReactNode {
    if (name === "SSH")
      return app((settings) => (
        <>
          <SshClientSettings settings={settings} change={change} bridge={bridge} />
          <KeyFileSettings settings={settings} change={change} bridge={bridge} repository={repository} />
        </>
      ));
    if (name === "Clone") return app((settings) => <CloneFolderSettings settings={settings} change={change} bridge={bridge} />);
    if (name === "Branch switch")
      return app((settings) => (
        <AppChoice
          slot="switch-choice"
          heading={TEXTS.switchChoice}
          note={TEXTS.switchChoiceNote}
          options={[
            { value: "keep", label: TEXTS.keep },
            { value: "stash", label: TEXTS.stash },
          ]}
          value={settings.switchChoice}
          onChange={(choice) => void change(() => bridge.setSwitchChoice({ choice }))}
        />
      ));
    if (name === "Pull and push")
      return (
        <>
          {query !== "" ? null : app((settings) => (
            <AppChoice
              slot="pull-default"
              heading={TEXTS.pullDefault}
              note={TEXTS.pullDefaultNote}
              options={PULL_ACTIONS.map((a) => ({ value: a.action, label: a.item }))}
              value={settings.defaultPullAction}
              onChange={(action) => void change(() => bridge.setDefaultPullAction({ action }))}
            />
          ))}
          {gitPage(name)}
        </>
      );
    return gitPage(name);
  }

  return (
    <section
      ref={section}
      data-view="settings"
      data-slot="settings-panel"
      aria-labelledby={heading}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (scopedAction(event.nativeEvent, "settingsView") === "save") {
          event.preventDefault();
          if (scope === "local" || scope === "global") void git.save(scope);
          return;
        }
        if (event.key !== "Escape" || closing) return;
        event.preventDefault();
        close();
      }}
    >
      <div ref={scopeBar} data-section="scopeBar" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-divider px-2 py-1" style={{ minHeight: "var(--h-pane-heading)" }}>
        <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
        <h2 id={heading} tabIndex={-1} className="font-semibold">
          {TEXTS.heading}
        </h2>
        {target === null ? null : <ScopePicker scope={scope} onScope={setScope} files={git.read.state === "loaded" ? git.read.value.files : null} />}
        <span className="flex-1" />
        <IconButton icon={Cancel01Icon} label={TEXTS.close} keys={{ aria: "Escape", text: "Esc" }} onClick={close} />
      </div>
      <Tabs orientation="vertical" value={active} onValueChange={(value) => setPage(String(value))} className="min-h-0 flex-1 gap-0">
        <div data-section="pageList" className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-divider p-1">
          <div className="relative flex shrink-0 items-center">
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden="true" className="pointer-events-none absolute left-2 size-(--icon-size) text-muted-text" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <input
                    type="text"
                    aria-label={TEXTS.find}
                    aria-keyshortcuts="Control+F"
                    placeholder={TEXTS.findPlaceholder}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-(--h-button) w-full rounded-sm border border-control-border bg-surface pr-2 pl-7"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                }
              />
              <TooltipContent>{TEXTS.findTooltip}</TooltipContent>
            </Tooltip>
          </div>
          <TabsList variant="line" activateOnFocus aria-label={TEXTS.pages} className="w-full items-stretch">
            {shown.map((name) => (
              <TabsTrigger key={name} value={name} className="justify-start px-2">
                {name}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div data-section="pageContent" className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-2">
          {failure === null ? null : <p role="alert">{failure}</p>}
          {active === null ? (
            <p className="text-muted-text">{TEXTS.noMatch}</p>
          ) : (
            <TabsContent value={active} className="flex max-w-[880px] flex-col gap-3">
              {content(active)}
            </TabsContent>
          )}
        </div>
      </Tabs>
      <ConfirmPopover
        open={closing}
        anchor={scopeBar.current}
        title={TEXTS.discardTitle}
        confirmLabel={TEXTS.discard}
        cancelLabel={TEXTS.keepEditing}
        danger
        onConfirm={() => {
          setClosing(false);
          onClose();
        }}
        onCancel={() => setClosing(false)}
      />
    </section>
  );
}
