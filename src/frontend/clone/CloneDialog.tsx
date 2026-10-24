// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Cancel01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { suggestCloneName } from "../../contracts/clone-name";
import { codeText, CommandRemedy, OutputTail, unknownReadText } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge, ProgressEvent } from "../bridge";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/ui/button";
import { isObject } from "../lib/utils";
import { ConnectButton, puttyUnavailableText } from "../settings/ConnectTerminal";

// Feature 003 spec FR-046 to FR-050 and FR-054, plan.md D10 and D12 "Clone panel", contract Δ3 `clone` and `connectInTerminal`, and data-model §8, §10, §11.

type Bridge = ReturnType<typeof createBridge>;
/** Data-model §10: the fields that the clone panel reads. */
type CloneSettings = { sshClient: "git" | "plink"; lastCloneParent: string | null; defaultCloneFolder: string | null };
type SettingsRead = { state: "loading" } | { state: "loaded"; value: CloneSettings } | { state: "failed"; text: string };

const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
function settingsOf(response: BridgeResponse): SettingsRead {
  const r = response.result;
  if (response.state === "succeeded" && isObject(r) && (r.sshClient === "git" || r.sshClient === "plink") && textOrNull(r.lastCloneParent) && textOrNull(r.defaultCloneFolder)) {
    return { state: "loaded", value: { sshClient: r.sshClient, lastCloneParent: r.lastCloneParent, defaultCloneFolder: r.defaultCloneFolder } };
  }
  return { state: "failed", text: response.state === "succeeded" ? unknownReadText("The clone settings") : `The clone settings did not load: ${response.code ?? response.state}.` };
}

/** FR-050 and data-model §8: the folder state from `exists` and `empty`. A result without both is unknown. */
export function folderStateText(result: unknown): string {
  if (!isObject(result) || typeof result.exists !== "boolean" || typeof result.empty !== "boolean") return "The folder state is unknown.";
  if (!result.exists) return "The folder does not exist.";
  return result.empty ? "The folder is empty." : "The folder is not empty. Arbareto deleted and moved no file.";
}

// Contract Δ9 `DESTINATION_NOT_EMPTY_REASONS`.
const NOT_EMPTY: Record<string, string> = {
  "not-empty": "The destination folder is not empty: ",
  file: "The destination is a file: ",
  other: "The destination is not a folder: ",
};

// Plan.md D12 "Clone panel": the 001 status texts with the name "Clone".
function endLine(response: BridgeResponse): ReactNode {
  const code = response.code ?? response.state;
  if (response.state === "canceled") return "Clone canceled";
  if (response.state === "failed") return codeText("Clone did not complete: ", code);
  if (response.state === "rejected") return codeText("Clone did not start: ", code);
  return "State unknown";
}

function CloneResult({ response, connect }: { response: BridgeResponse; connect?: () => Promise<BridgeResponse> }) {
  const r = isObject(response.result) ? response.result : {};
  const notEmpty = response.code === "DESTINATION_NOT_EMPTY" && typeof r.reason === "string" && Object.hasOwn(NOT_EMPTY, r.reason) && typeof r.path === "string";
  const remedy = isObject(r.remedy) ? r.remedy : undefined;
  return (
    <div role="alert" className="flex flex-col items-start gap-2">
      <p>{endLine(response)}</p>
      {notEmpty ? (
        <p>
          {NOT_EMPTY[r.reason as string]}
          <code className="break-all">{r.path as string}</code>
        </p>
      ) : null}
      {puttyUnavailableText(response) === null ? null : <p>{puttyUnavailableText(response)}</p>}
      {response.code === "DESTINATION_NOT_EMPTY" ? null : <p>{folderStateText(response.result)}</p>}
      {typeof r.outputTail === "string" && r.outputTail !== "" ? <OutputTail text={r.outputTail} /> : null}
      <CommandRemedy remedy={remedy as { text?: string; command?: string | null } | undefined} />
      {connect === undefined ? null : <ConnectButton connect={connect} />}
    </div>
  );
}

export type CloneDialogProps = {
  bridge: Pick<Bridge, "readSyncSettings" | "clone" | "cancel" | "connectInTerminal">;
  /** The path separator of the destination platform. */
  separator: "\\" | "/";
  /** A succeeded clone. Its result is the `chooseRepository` result (contract Δ3 `clone` step 5). */
  onOpened(response: BridgeResponse): void;
  onClose(): void;
  /** Feature 005 spec FR-044: runs the start, or asks first about unsaved ignore editor text. */
  guard?(start: () => void): void;
};

// plan.md D12 "Clone panel".
const RUNNING_CLOSE = "The clone is running. Select Cancel to stop it, then close the panel.";
const CANCEL_WAITS = "Cancel is available after the clone starts.";

type Run = { destination: string; operationId?: string; percent?: number; cancelRequested: boolean };

/** The non-modal clone panel (plan.md D12). Clone starts only at the explicit start, with the destination that the panel shows. */
export function CloneDialog({ bridge, separator, onOpened, onClose, guard = (start) => start() }: CloneDialogProps) {
  const ids = { heading: useId(), url: useId(), destination: useId(), key: useId(), reason: useId(), close: useId(), cancel: useId() };
  const [settings, setSettings] = useState<SettingsRead>({ state: "loading" });
  const [url, setUrl] = useState("");
  // FR-054: null until the first destination edit. Then the destination stays.
  const [edited, setEdited] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [ended, setEnded] = useState<BridgeResponse | null>(null);
  const urlField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    void bridge.readSyncSettings().then((response) => void (current && setSettings(settingsOf(response))));
    return () => void (current = false);
  }, [bridge]);
  // Focus moves into the panel at open and back to the opener at close.
  useLayoutEffect(() => {
    const opener = document.activeElement;
    urlField.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const loaded = settings.state === "loaded" ? settings.value : null;
  const destination = edited ?? suggestCloneName({ url, lastCloneParent: loaded?.lastCloneParent ?? null, defaultCloneFolder: loaded?.defaultCloneFolder ?? null, separator });
  const plink = loaded?.sshClient === "plink";
  const reason = settings.state === "loading" ? "The clone settings are still loading…" : url === "" ? "Enter the remote URL." : destination === "" ? "Enter the destination folder." : null;

  async function start() {
    if (reason !== null || run !== null) return;
    setEnded(null);
    setRun({ destination, cancelRequested: false });
    const onProgress = (event: ProgressEvent) =>
      setRun((r) => (r === null ? r : { ...r, operationId: event.operationId, percent: event.phase === "clone" ? (event.counters.percent ?? r.percent) : r.percent, cancelRequested: r.cancelRequested || event.state === "cancel-requested" }));
    const response = await bridge.clone({ url, destination, keyFile: plink && picked ? "picked" : "none" }, onProgress);
    setRun(null);
    if (response.state === "succeeded") return onOpened(response);
    setEnded(response);
  }
  const operationId = ended?.operationId;
  const endedResult = ended?.result;
  // Data-model §11: only a kept connect target offers it. Contract Δ2: a clone target carries no `repositoryId`.
  const connect = operationId !== undefined && isObject(endedResult) && endedResult.connectTarget === true ? () => bridge.connectInTerminal({}, { operationId }) : undefined;

  return (
    <section
      data-slot="clone-panel"
      aria-labelledby={ids.heading}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (run === null) onClose();
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-divider px-2" style={{ minHeight: "var(--h-pane-heading)" }}>
        <HugeiconsIcon icon={Download04Icon} strokeWidth={2} aria-hidden="true" className="size-(--icon-size)" />
        <h2 id={ids.heading} className="flex-1 font-semibold">
          Clone repository
        </h2>
        <IconButton
          icon={Cancel01Icon}
          label="Close clone panel"
          keys={{ aria: "Escape", text: "Esc" }}
          disabled={run !== null}
          focusableWhenDisabled
          aria-describedby={run === null ? undefined : ids.close}
          onClick={() => run === null && onClose()}
        />
      </div>
      {run === null ? null : (
        <p id={ids.close} className="px-2 text-muted-text">
          {RUNNING_CLOSE}
        </p>
      )}
      <form
        className="flex min-h-0 max-w-[720px] flex-col gap-2 overflow-auto p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason === null && run === null) guard(() => void start());
        }}
      >
        {settings.state === "failed" ? <p className="text-muted-text">{settings.text}</p> : null}
        <div className="grid items-center gap-x-3 gap-y-2" style={{ gridTemplateColumns: "130px minmax(0, 1fr)" }}>
          <label htmlFor={ids.url}>Remote URL</label>
          <input
            ref={urlField}
            id={ids.url}
            name="url"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={url}
            disabled={run !== null}
            className="h-(--h-row) min-w-0 rounded-sm border border-control-border bg-surface px-2 font-mono"
            onChange={(event) => setUrl(event.target.value)}
          />
          <label htmlFor={ids.destination}>Destination folder</label>
          <input
            id={ids.destination}
            name="destination"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={destination}
            disabled={run !== null}
            className="h-(--h-row) min-w-0 rounded-sm border border-control-border bg-surface px-2 font-mono"
            onChange={(event) => setEdited(event.target.value)}
          />
        </div>
        {plink ? (
          <div className="flex flex-col gap-1" style={{ paddingLeft: 142 }}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={picked} disabled={run !== null} aria-describedby={ids.key} onChange={(event) => setPicked(event.target.checked)} />
              Pick a PuTTY key file at the start
            </label>
            <span id={ids.key} className="text-muted-text" style={{ paddingLeft: 22 }}>
              Arbareto does not save this key file.
            </span>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2" style={{ paddingLeft: 142 }}>
          {run === null ? (
            <>
              <Button type="submit" disabled={reason !== null} focusableWhenDisabled aria-describedby={reason === null ? undefined : ids.reason}>
                Clone
              </Button>
              {reason === null ? null : (
                <span id={ids.reason} className="text-muted-text">
                  {reason}
                </span>
              )}
            </>
          ) : (
            <>
              <span role="status">{run.cancelRequested ? "Cancel requested" : `Cloning into ${run.destination}…`}</span>
              {run.percent === undefined ? null : <span className="tabular-nums">{run.percent}%</span>}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={run.operationId === undefined}
                focusableWhenDisabled
                aria-describedby={run.operationId === undefined ? ids.cancel : undefined}
                onClick={() => run.operationId !== undefined && !run.cancelRequested && void bridge.cancel({ operationId: run.operationId })}
              >
                Cancel
              </Button>
              {/* Contract Δ2: Cancel names the operation, and the first progress event carries its ID. */}
              {run.operationId === undefined ? (
                <span id={ids.cancel} className="text-muted-text">
                  {CANCEL_WAITS}
                </span>
              ) : null}
            </>
          )}
        </div>
        {ended === null ? null : <CloneResult response={ended} connect={connect} />}
      </form>
    </section>
  );
}
