// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { REGISTER_VERSION_BYTES } from "../contracts/limits";

// plan.md "Provisional prerequisite admission": the reference-host version on 2026-09-29, not an upstream requirement.
export const MINIMUM_GIT_VERSION = "2.55.0.windows.3";

export type GitAdmission =
  | { admission: "admitted"; detectedVersion: string; minimumVersion: string; qualification: "unverified" }
  | { admission: "unsupported"; gitCode: "GIT_UNSUPPORTED"; detectedVersion?: string; minimumVersion: string; qualification: "unverified" }
  | { gitCode: "GIT_UNAVAILABLE"; minimumVersion: string; qualification: "unverified" };

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\.windows\.(\d+))?$/;

// Numeric parts of a Git for Windows version. A version without `windows.N` gives null.
function windowsParts(version: string): bigint[] | null {
  const m = VERSION.exec(version);
  return m && m[4] !== undefined ? m.slice(1, 5).map(BigInt) : null;
}

function compare(a: bigint[], b: bigint[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

const MINIMUM_PARTS = windowsParts(MINIMUM_GIT_VERSION)!;

// `output` is the stdout of `git version --build-options`. `null` means that no executable exists.
export function admitGitProbe(output: string | null): GitAdmission {
  const base = { minimumVersion: MINIMUM_GIT_VERSION, qualification: "unverified" as const };
  if (output === null) return { gitCode: "GIT_UNAVAILABLE", ...base };
  const lines = output.split(/\r?\n/);
  const token = /^git version (\S+)$/.exec(lines[0])?.[1];
  // The register `version` field is printable ASCII with at most 64 bytes (contract §6 "Context rules").
  const detectedVersion = token !== undefined && token.length <= REGISTER_VERSION_BYTES && VERSION.test(token) ? token : undefined;
  const unsupported = { admission: "unsupported" as const, gitCode: "GIT_UNSUPPORTED" as const, ...(detectedVersion ? { detectedVersion } : {}), ...base };
  const parts = detectedVersion === undefined ? null : windowsParts(detectedVersion);
  if (!parts || !lines.includes("cpu: x86_64") || compare(parts, MINIMUM_PARTS) < 0) return unsupported;
  return { admission: "admitted", detectedVersion: detectedVersion!, ...base };
}
