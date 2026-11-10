// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { REGISTER_VERSION_BYTES } from "../contracts/limits";
import { isWindows } from "../contracts/native-path";
import { WSL_MINIMUM_GIT_VERSION } from "../contracts/wsl-route";

// plan.md "Provisional prerequisite admission": the reference-host version on 2026-09-29, not an upstream requirement.
const WINDOWS_MINIMUM = "2.55.0.windows.3";
// Data-model §1 `admission`: the rule on other platforms makes no support claim.
export const MINIMUM_GIT_VERSION = isWindows ? WINDOWS_MINIMUM : WSL_MINIMUM_GIT_VERSION;

export type GitAdmission =
  | { admission: "admitted"; detectedVersion: string; minimumVersion: string; qualification: "unverified" }
  | { admission: "unsupported"; gitCode: "GIT_UNSUPPORTED"; detectedVersion?: string; minimumVersion: string; qualification: "unverified" }
  | { gitCode: "GIT_UNAVAILABLE"; minimumVersion: string; qualification: "unverified" };

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\.windows\.(\d+))?$/;

// Numeric parts of a version. The Windows rule needs `windows.N`. The other rule refuses it.
function versionParts(version: string, windows: boolean): bigint[] | null {
  const m = VERSION.exec(version);
  return m && (m[4] !== undefined) === windows ? m.slice(1, windows ? 5 : 4).map(BigInt) : null;
}

function compare(a: bigint[], b: bigint[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

const WINDOWS_PARTS = versionParts(WINDOWS_MINIMUM, true)!;
const OTHER_PARTS = versionParts(WSL_MINIMUM_GIT_VERSION, false)!;

// Contract §5 "Git executable digest input": the image header must end inside these first bytes of the file.
export const IMAGE_HEAD_BYTES = 4096;
// Microsoft "PE Format" `IMAGE_FILE_MACHINE_AMD64`. System V gABI "ELF Header" `EM_X86_64`.
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const EM_X86_64 = 62;

// Contract §6 `gitProbe` architecture: the x64 rule reads the image header, never Git output.
// Windows, PE: `MZ`, `e_lfanew` at 0x3C, the signature `PE\0\0` there, then `IMAGE_FILE_HEADER.Machine`.
// Other platforms, ELF: the magic, ELFCLASS64, ELFDATA2LSB (x86-64 psABI), and `e_machine` at offset 18.
// `head` holds the first bytes of the file. A short or malformed head is not x64.
export function isX64Image(head: Uint8Array, windows = isWindows): boolean {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (!windows) return head.length >= 20 && view.getUint32(0) === 0x7f454c46 && head[4] === 2 && head[5] === 1 && view.getUint16(18, true) === EM_X86_64;
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return false;
  const pe = view.getUint32(0x3c, true);
  return pe + 6 <= head.length && view.getUint32(pe) === 0x50450000 && view.getUint16(pe + 4, true) === IMAGE_FILE_MACHINE_AMD64;
}

// `output` is the stdout of `git version`. `null` means that no executable exists.
export function admitGitProbe(output: string | null, windows = isWindows): GitAdmission {
  const base = { minimumVersion: windows ? WINDOWS_MINIMUM : WSL_MINIMUM_GIT_VERSION, qualification: "unverified" as const };
  if (output === null) return { gitCode: "GIT_UNAVAILABLE", ...base };
  const lines = output.split(/\r?\n/);
  const token = /^git version (\S+)$/.exec(lines[0])?.[1];
  // The register `version` field is printable ASCII with at most 64 bytes (contract §6 "Context rules").
  const detectedVersion = token !== undefined && token.length <= REGISTER_VERSION_BYTES && VERSION.test(token) ? token : undefined;
  const unsupported = { admission: "unsupported" as const, gitCode: "GIT_UNSUPPORTED" as const, ...(detectedVersion ? { detectedVersion } : {}), ...base };
  const parts = detectedVersion === undefined ? null : versionParts(detectedVersion, windows);
  if (!parts || compare(parts, windows ? WINDOWS_PARTS : OTHER_PARTS) < 0) return unsupported;
  return { admission: "admitted", detectedVersion: detectedVersion!, ...base };
}
