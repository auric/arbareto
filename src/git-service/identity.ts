// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { FileIdentity, IdentityReply, WslIdentity } from "../contracts/channel";
import type { GitRunner, ProcessContext, WalkStop } from "./git-runner";
import { identityRefusal, MIXED_LOCATION_REFUSAL, NO_FS_UUID_REFUSAL, type WslGit, type WslRefusal } from "./wsl";

// Contract §6 "Registration bootstrap": the remedy of an identity refusal.
export const IDENTITY_REMEDY = "Open the repository from an NTFS or ReFS volume";

// A Windows identity, or a WSL identity (contract §11 "Paths and file access").
export type PhysicalIdentity = FileIdentity | WslIdentity;

export type IdentityResult =
  | { ok: true; identities: FileIdentity[] }
  | { ok: false; code: "UNSUPPORTED_REPOSITORY"; remedy: typeof IDENTITY_REMEDY }
  | { ok: false; stop: WalkStop["stop"] };

// MS-FSCC: the all-zero and the all-ones file ID name no file (research R2).
export const NO_FILE = /^(0{32}|f{32})$/;

const refused: IdentityResult = { ok: false, code: "UNSUPPORTED_REPOSITORY", remedy: IDENTITY_REMEDY };

// Contract §6: the shell supplies each physical identity. The service never reads one through `fs.stat`.
// The replies keep the order of `paths`. A `RunnerRefusal` keeps its own code and rejects the call.
export async function requestIdentities(runner: GitRunner, operationId: string, context: ProcessContext, paths: readonly string[], signal: AbortSignal): Promise<IdentityResult> {
  const replies: unknown[] | WalkStop = await runner.identities(operationId, context, paths, signal);
  if (!Array.isArray(replies)) return { ok: false, stop: replies.stop };
  if (replies.length !== paths.length) return refused;
  const identities: FileIdentity[] = [];
  for (const reply of replies) {
    const identity = FileIdentity.safeParse(reply);
    if (!identity.success || NO_FILE.test(identity.data.fileId)) return refused;
    identities.push(identity.data);
  }
  return { ok: true, identities };
}

// Contract §11 "Paths and file access": the identity probe of a WSL Git gives each identity. The shell gives an identity only for type `ef53`.
// Type `1021997` (`v9fs`) is a Windows drive. Each reply must name the distro GUID of the installation (gaps.md W2). Another failure gets the WSL identity remedy.
export async function requestWslIdentities(
  runner: GitRunner,
  operationId: string,
  context: ProcessContext,
  paths: readonly string[],
  git: Pick<WslGit, "guid" | "distro">,
  signal: AbortSignal,
): Promise<{ ok: true; identities: WslIdentity[] } | WslRefusal | { ok: false; stop: WalkStop["stop"] }> {
  const replies: unknown[] | WalkStop = await runner.identities(operationId, context, paths, signal);
  if (!Array.isArray(replies)) return { ok: false, stop: replies.stop };
  const failed = identityRefusal(git.distro);
  if (replies.length !== paths.length) return failed;
  const identities: WslIdentity[] = [];
  for (const reply of replies) {
    const identity = WslIdentity.safeParse(reply);
    if (identity.success) {
      if (identity.data.distroGuid !== git.guid) return failed;
      identities.push(identity.data);
      continue;
    }
    const refusal = IdentityReply.safeParse(reply);
    const reason = refusal.success && "code" in refusal.data ? refusal.data.reason : undefined;
    return reason === "mixed-location" ? MIXED_LOCATION_REFUSAL : reason === "no-fs-uuid" ? NO_FS_UUID_REFUSAL : failed;
  }
  return { ok: true, identities };
}

export const sameIdentity = (a: PhysicalIdentity, b: PhysicalIdentity): boolean =>
  "distroGuid" in a
    ? "distroGuid" in b && a.distroGuid === b.distroGuid && a.fileSystemId === b.fileSystemId && a.inode === b.inode
    : "volumeSerial" in b && a.volumeSerial === b.volumeSerial && a.fileId === b.fileId;
