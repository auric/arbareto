// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useEffect } from "react";

// T054 and T062 fix the `getEnvironment` result. These names follow the contract §6 handshake and data-model §1.
export interface Environment {
  buildIdentity: { version: string; commit: string; signing: string };
  platformScope: "qualification-target" | "other";
  selectedGit?: string;
  detectedVersion?: string;
  minimumVersion: string;
  admission?: string;
  qualification: string;
  gitCode?: string;
  markers: { markerId: string; kind: string; startedAt: string; worktreeRoot: string }[];
  markerLimit?: number;
  unloadedMarkers?: number;
}

export type BootProps =
  | { state: "loading" }
  | { state: "unavailable"; code: string; session?: boolean }
  | { state: "facts"; environment: Environment; onSelectGit: () => void; onDismissMarker: (markerId: string) => void };

const GIT_BLOCKED: Record<string, string> = {
  GIT_UNAVAILABLE: "Git unavailable",
  GIT_UNSUPPORTED: "Git version unsupported",
  GIT_CHANGED: "Git changed",
};

// T193 needs exactly one mark for each page life.
let marked = false;

export function BootView(props: BootProps) {
  const facts = props.state === "facts";
  useEffect(() => {
    if (!facts || marked) return;
    marked = true;
    performance.mark("arbareto:boot-view");
  }, [facts]);

  if (props.state === "loading") return <p>Loading…</p>;
  if (props.state === "unavailable") {
    const text = !props.session ? "Git service not connected" : props.code === "SERVICE_UNAVAILABLE" ? "Environment not available yet" : "Environment request failed";
    return (
      <p>
        {text}: {props.code}
      </p>
    );
  }

  const env = props.environment;
  const blocked = env.gitCode === undefined ? undefined : (GIT_BLOCKED[env.gitCode] ?? "Git check failed");
  return (
    <main>
      <h1>Arbareto</h1>
      <p>
        Build: {env.buildIdentity.version} {env.buildIdentity.commit}
      </p>
      {env.buildIdentity.signing === "unsigned" && <p>Unsigned local test package</p>}
      <p>Platform scope: {env.platformScope}</p>
      {env.platformScope === "other" && <p>Unqualified platform</p>}
      {env.selectedGit !== undefined && <p>Selected Git: {env.selectedGit}</p>}
      <p>Detected Git version: {env.detectedVersion ?? "none"}</p>
      <p>Minimum Git version: {env.minimumVersion}</p>
      {env.admission !== undefined && <p>Admission: {env.admission}</p>}
      <p>Qualification: {env.qualification}</p>
      {blocked !== undefined && (
        <section>
          <p>
            {blocked}: {env.gitCode}
          </p>
          <button type="button" onClick={props.onSelectGit}>
            Select Git
          </button>
        </section>
      )}
      {env.markers.length > 0 && (
        <section>
          <h2>Recovery markers</h2>
          <ul>
            {env.markers.map((marker) => (
              <li key={marker.markerId}>
                {marker.kind} {marker.worktreeRoot} {marker.startedAt}{" "}
                <button type="button" onClick={() => props.onDismissMarker(marker.markerId)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {env.markerLimit !== undefined && <p>Marker limit: {env.markerLimit}</p>}
      {env.unloadedMarkers !== undefined && <p>Unloaded marker files: {env.unloadedMarkers}</p>}
    </main>
  );
}
