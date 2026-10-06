// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { FileIdentity } from "../contracts/channel";
import type { GitRunner, ProcessContext, WalkStop } from "./git-runner";

// Contract §6 "Registration bootstrap": the remedy of an identity refusal.
export const IDENTITY_REMEDY = "Open the repository from an NTFS or ReFS volume";

export type IdentityResult =
  | { ok: true; identities: FileIdentity[] }
  | { ok: false; code: "UNSUPPORTED_REPOSITORY"; remedy: typeof IDENTITY_REMEDY }
  | { ok: false; stop: WalkStop["stop"] };

// MS-FSCC: the all-zero and the all-ones file ID name no file (research R2).
const NO_FILE = /^(0{32}|f{32})$/;

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

export const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.volumeSerial === b.volumeSerial && a.fileId === b.fileId;
