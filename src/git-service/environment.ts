// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { ErrorCode } from "../contracts/errors";
import { RECOVERY_MARKERS_PER_HANDSHAKE } from "../contracts/limits";
import { MINIMUM_GIT_VERSION } from "./admission";
import type { GitProbeResult, GitReason } from "./git-installation";
import type { Handshake } from "./session";

// Data-model §1 `qualification`: version sets of recorded passing packaged runs. This slice ships the list empty.
export const QUALIFIED_VERSION_SETS: readonly { git: string; webView2: string; osBuild: number }[] = [];

// Contract §3 `getEnvironment`. No environment variable enters this result.
export interface Environment {
  buildIdentity: { version: string; commit: string; signing: "unsigned" };
  platformScope: "qualification-target" | "other";
  selectedPath?: string;
  executablePath?: string;
  detectedVersion?: string;
  // The saved version when this startup admitted another version.
  previousVersion?: string;
  minimumVersion: string;
  admission?: "admitted" | "unsupported";
  qualification: "unverified" | "passed";
  gitCode?: ErrorCode;
  reason?: GitReason;
  path?: string;
  markers: { markerId: string; kind: string; startedAt: string; worktreeRoot: string }[];
  markerLimit?: number;
  unloadedMarkers?: number;
  damagedMarkers: { markerId: string; fileName: string }[];
}

// `git` is null when the handshake carried no `savedGit` and no `chooseGit` succeeded.
export function getEnvironment(handshake: Handshake, git: GitProbeResult | null): Environment {
  const { version, commit, signing } = handshake.buildIdentity;
  const detectedVersion = git === null ? undefined : git.ok ? git.installation.version : git.detectedVersion;
  const qualified =
    git?.ok === true && QUALIFIED_VERSION_SETS.some((s) => s.git === detectedVersion && s.webView2 === handshake.webView2Version && s.osBuild === handshake.osBuild);
  const markers = handshake.markers.map((m) => ({
    markerId: m.markerId as string,
    kind: m.kind as string,
    startedAt: m.startedAt as string,
    worktreeRoot: m.worktreeRoot as string,
  }));
  return {
    buildIdentity: { version, commit, signing },
    platformScope: handshake.platformScope,
    ...(git?.ok ? { selectedPath: git.installation.selectedPath, executablePath: git.installation.executablePath } : {}),
    ...(detectedVersion === undefined ? {} : { detectedVersion }),
    ...(git?.ok && git.installation.previousVersion !== undefined ? { previousVersion: git.installation.previousVersion } : {}),
    minimumVersion: MINIMUM_GIT_VERSION,
    ...(git?.ok ? { admission: "admitted" as const } : git?.gitCode === "GIT_UNSUPPORTED" ? { admission: "unsupported" as const } : {}),
    qualification: qualified ? "passed" : "unverified",
    ...(git === null ? { gitCode: "GIT_UNAVAILABLE" as const } : git.ok ? {} : { gitCode: git.gitCode }),
    ...(git?.ok === false && git.reason !== undefined ? { reason: git.reason } : {}),
    ...(git?.ok === false && git.path !== undefined ? { path: git.path } : {}),
    markers,
    // Contract §5 "Recovery markers": above 64 marker files, the shell loads 64 and counts the rest.
    ...(handshake.unloadedMarkers > 0 ? { markerLimit: RECOVERY_MARKERS_PER_HANDSHAKE, unloadedMarkers: handshake.unloadedMarkers } : {}),
    // Contract §6 "Damaged markers": the ID and the file name only.
    damagedMarkers: handshake.damagedMarkers.map(({ markerId, fileName }) => ({ markerId, fileName })),
  };
}
