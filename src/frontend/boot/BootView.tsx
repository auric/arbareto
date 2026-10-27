// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { CancelCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import type { Environment } from "../../contracts/envelope";
import { codeText, wslStartingText } from "../app/RepositoryStates";
import type { BridgeResponse, createBridge, OnProgress } from "../bridge";

// Contract §3 `getEnvironment`. A type-only import keeps zod out of the renderer bundle.
export type { Environment };

export type BootProps =
  | { state: "loading" }
  | { state: "unavailable"; code: string; session?: boolean }
  | { state: "facts"; environment: Environment; onSelectGit: () => Promise<BridgeResponse>; onDismissMarker: (markerId: string, onProgress?: OnProgress) => unknown };

const GIT_BLOCKED: Record<string, string> = {
  GIT_UNAVAILABLE: "Git unavailable",
  GIT_UNSUPPORTED: "Git version unsupported",
  GIT_CHANGED: "Git changed",
};

// T193 needs exactly one mark for each page life.
let marked = false;
export function markBootView() {
  if (marked) return;
  marked = true;
  performance.mark("arbareto:boot-view");
}

type Bridge = ReturnType<typeof createBridge>;
export function bootActions(bridge: Pick<Bridge, "chooseGit" | "dismissRecoveryMarker">, reload: () => void) {
  return {
    /** A success reloads the environment. The view shows every other result except `canceled`. */
    onSelectGit: async () => {
      const response = await bridge.chooseGit();
      if (response.state === "succeeded") reload();
      return response;
    },
    onDismissMarker: async (markerId: string, onProgress?: OnProgress) => {
      await bridge.dismissRecoveryMarker({ markerId }, onProgress);
      reload();
    },
  };
}

/** The one-view frame: one header row at the plan.md header height and one centered Surface panel. Only the panel scrolls. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-clip bg-canvas text-text">
      <header className="flex shrink-0 items-center border-b border-divider px-2" style={{ height: "var(--h-header)" }}>
        <h1 className="font-semibold">Arbareto</h1>
      </header>
      <main className="flex min-h-0 flex-1 overflow-auto p-4">
        <div className="m-auto flex w-full max-w-[640px] flex-col gap-3 rounded-md border border-divider bg-surface p-4">{children}</div>
      </main>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** A `chooseGit` result other than `succeeded` or `canceled`, with its code and the result text (contract §3, §9). */
function GitRefused({ response }: { response: BridgeResponse }) {
  const result = typeof response.result === "object" && response.result !== null ? (response.result as Record<string, unknown>) : {};
  const facts = (["text", "reason", "path"] as const).filter((key) => typeof result[key] === "string");
  return (
    <section role="alert" className="flex flex-col items-start gap-2">
      <p className="flex items-center gap-2">
        <HugeiconsIcon icon={CancelCircleIcon} size="1em" strokeWidth={2} aria-hidden="true" className="shrink-0 text-removed" />
        <span>
          Select Git did not complete: <code>{response.code ?? response.state}</code>
        </span>
      </p>
      {facts.map((key) => (key === "text" ? <p key={key}>{result.text as string}</p> : <code key={key}>{result[key] as string}</code>))}
    </section>
  );
}

export function BootView(props: BootProps) {
  const facts = props.state === "facts";
  const [refused, setRefused] = useState<BridgeResponse | null>(null);
  // Contract §11 "Distro start": a dismissal in phase `wsl-starting`, until the response of that dismissal. It has no Cancel.
  const [starting, setStarting] = useState<{ distro: string; operationId: string } | null>(null);
  useEffect(() => {
    if (facts) markBootView();
  }, [facts]);

  if (props.state === "loading")
    return (
      <Frame>
        <p>Loading…</p>
      </Frame>
    );
  if (props.state === "unavailable") {
    const text = !props.session ? "Git service not connected" : props.code === "SERVICE_UNAVAILABLE" ? "Environment not available yet" : "Environment request failed";
    return (
      <Frame>
        <p>{codeText(`${text}: `, props.code)}</p>
      </Frame>
    );
  }

  const env = props.environment;
  const onDismissMarker = props.onDismissMarker;
  async function dismiss(markerId: string) {
    let operationId: string | null = null;
    await onDismissMarker(markerId, (event) => {
      if (event.phase !== "wsl-starting" || event.distro === undefined) return;
      operationId = event.operationId;
      setStarting({ distro: event.distro, operationId });
    });
    setStarting((current) => (current !== null && current.operationId === operationId ? null : current));
  }
  const onSelectGit = props.onSelectGit;
  async function selectGit() {
    setRefused(null);
    const response = await onSelectGit();
    if (response.state !== "succeeded" && response.state !== "canceled") setRefused(response);
  }
  const blocked = env.gitCode === undefined ? undefined : (GIT_BLOCKED[env.gitCode] ?? "Git check failed");
  return (
    <Frame>
      {blocked !== undefined && (
        <section className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{codeText(`${blocked}: `, env.gitCode!)}</p>
          <Button onClick={selectGit}>Select Git</Button>
          {refused === null ? null : <GitRefused response={refused} />}
        </section>
      )}
      {env.buildIdentity.channel === "local" ? <p className="text-warning">Unsigned local test package</p> : <p>Preview</p>}
      {env.platformScope === "other" && <p className="text-warning">Unqualified platform</p>}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 [&_dd]:break-all [&_dt]:text-muted-text">
        <Fact label="Build">
          {env.buildIdentity.version} {env.buildIdentity.commit}
        </Fact>
        <Fact label="Platform scope">{env.platformScope}</Fact>
        {env.selectedPath !== undefined && <Fact label="Selected Git">{env.selectedPath}</Fact>}
        {env.executablePath !== undefined && env.executablePath !== env.selectedPath && <Fact label="Runs">{env.executablePath}</Fact>}
        <Fact label="Detected Git version">{env.detectedVersion ?? "none"}</Fact>
        {env.previousVersion !== undefined && <Fact label="Git updated">{`${env.previousVersion} → ${env.detectedVersion}`}</Fact>}
        <Fact label="Minimum Git version">{env.minimumVersion}</Fact>
        {env.admission !== undefined && <Fact label="Admission">{env.admission}</Fact>}
        <Fact label="Qualification">{env.qualification}</Fact>
        {blocked !== undefined && env.reason !== undefined && <Fact label="Reason">{env.reason}</Fact>}
        {blocked !== undefined && env.path !== undefined && <Fact label="Path">{env.path}</Fact>}
      </dl>
      {/* A direct call keeps the marker buttons in the BootView element tree. RecoveryMarkers uses no hooks. */}
      {RecoveryMarkers({ environment: env, onDismissMarker: (markerId) => void dismiss(markerId) })}
      <p role="status">{starting === null ? null : wslStartingText(starting.distro)}</p>
    </Frame>
  );
}

/** True when `getEnvironment` reports a recovery marker, a damaged marker, or the marker limit. */
export function hasMarkers(env: Environment): boolean {
  return env.markers.length > 0 || env.damagedMarkers.length > 0 || env.markerLimit !== undefined || env.unloadedMarkers !== undefined;
}

/** The recovery marker sections with their Dismiss actions (contract §6 "Dismissal"). The workbench shows them too. */
export function RecoveryMarkers({ environment: env, onDismissMarker }: { environment: Environment; onDismissMarker: (markerId: string) => void }) {
  return (
    <>
      {env.markers.length > 0 && (
        <section>
          <h2>Recovery markers</h2>
          <ul>
            {env.markers.map((marker) => (
              <li key={marker.markerId}>
                {marker.kind} {marker.worktreeRoot} {marker.startedAt}{" "}
                <button type="button" onClick={() => onDismissMarker(marker.markerId)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {env.damagedMarkers.length > 0 && (
        <section>
          <h2>Damaged recovery markers</h2>
          <ul>
            {env.damagedMarkers.map((marker) => (
              <li key={marker.markerId}>
                Damaged recovery marker {marker.fileName}{" "}
                <button type="button" onClick={() => onDismissMarker(marker.markerId)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {env.markerLimit !== undefined && <p>Marker limit: {env.markerLimit}</p>}
      {env.unloadedMarkers !== undefined && <p>Unloaded marker files: {env.unloadedMarkers}</p>}
    </>
  );
}
