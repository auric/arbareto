// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { admitGitProbe, type GitAdmission, IMAGE_HEAD_BYTES, isX64Image, MINIMUM_GIT_VERSION } from "../../src/git-service/admission";
import { isWindows } from "../../src/contracts/native-path";

printOrigin("../../src/git-service/admission.ts", import.meta.dir);
printOrigin("../../src/contracts/native-path.ts", import.meta.dir);

// plan.md "Provisional prerequisite admission". These strings are test inputs, not claims that such releases exist.
const MINIMUM = "2.55.0.windows.3";
// data-model.md §1 `admission`: the rule on other platforms.
const POSIX_MINIMUM = "2.55.0";

// `git version` output (git-version(1)).
const versionOutput = (version: string) => `git version ${version}\n`;

// Microsoft "PE Format": `IMAGE_FILE_MACHINE_*` values.
const AMD64 = 0x8664;
const ARM64 = 0xaa64;
const I386 = 0x14c;
// System V gABI "ELF Header" `e_machine` values.
const EM_X86_64 = 62;
const EM_AARCH64 = 183;

// A minimal PE head: `MZ`, `e_lfanew` at 0x3C, then the signature `PE\0\0` and `IMAGE_FILE_HEADER.Machine`.
function pe(machine: number, lfanew = 0x80, signature = [0x50, 0x45, 0, 0]): Uint8Array {
  const head = new Uint8Array(lfanew + 24);
  const view = new DataView(head.buffer);
  head.set([0x4d, 0x5a]);
  view.setUint32(0x3c, lfanew, true);
  head.set(signature, lfanew);
  view.setUint16(lfanew + 4, machine, true);
  return head;
}

// A minimal ELF head: the magic, `EI_CLASS`, `EI_DATA`, and `e_machine` at offset 18 in the byte order of `EI_DATA`.
function elf(machine: number, elfClass = 2, data = 1): Uint8Array {
  const head = new Uint8Array(64);
  head.set([0x7f, 0x45, 0x4c, 0x46, elfClass, data, 1]);
  new DataView(head.buffer).setUint16(18, machine, data === 1);
  return head;
}

describe("Git admission (T049)", () => {
  test("the minimum is the provisional reference-host version on Windows, and 2.55.0 elsewhere", () => {
    expect(MINIMUM_GIT_VERSION).toBe(isWindows ? MINIMUM : POSIX_MINIMUM);
  });

  for (const version of ["2.55.0.windows.3", "2.55.0.windows.4", "2.56.0.windows.1", "2.55.0.windows.10", "2.55.10.windows.1", "3.0.0.windows.1"]) {
    test(`${version} is admitted, and qualification stays unverified`, () => {
      const result = admitGitProbe(versionOutput(version), true);
      expect(result).toEqual({ admission: "admitted", detectedVersion: version, minimumVersion: MINIMUM, qualification: "unverified" });
    });
  }

  for (const version of ["2.55.0.windows.2", "2.54.0.windows.1", "2.9.0.windows.9", "2.54.99.windows.99"]) {
    test(`${version} gives GIT_UNSUPPORTED with the detected and minimum versions`, () => {
      const result = admitGitProbe(versionOutput(version), true);
      expect(result).toEqual({
        admission: "unsupported",
        gitCode: "GIT_UNSUPPORTED",
        detectedVersion: version,
        minimumVersion: MINIMUM,
        qualification: "unverified",
      });
    });
  }

  test("a non-Windows 2.55.0 build gives GIT_UNSUPPORTED", () => {
    const result = admitGitProbe(versionOutput("2.55.0"), true);
    expect(result).toMatchObject({ admission: "unsupported", gitCode: "GIT_UNSUPPORTED", minimumVersion: MINIMUM, qualification: "unverified" });
  });

  // T413: the image header decides the machine (`isX64Image`). Diagnostic `--build-options` lines decide nothing.
  test("version output without a cpu line is admitted", () => {
    const result = admitGitProbe(versionOutput("2.55.0.windows.3"), true);
    expect(result).toEqual({ admission: "admitted", detectedVersion: "2.55.0.windows.3", minimumVersion: MINIMUM, qualification: "unverified" });
  });

  for (const output of ["", "garbage\n", "git version\n", "git version 2.55.windows.3\n", "git version 2.55.0.windows.x\n", "unknown option: --build-options\n"]) {
    test(`unparseable output ${JSON.stringify(output)} gives GIT_UNSUPPORTED`, () => {
      const result = admitGitProbe(output, true);
      expect(result).toMatchObject({ admission: "unsupported", gitCode: "GIT_UNSUPPORTED", minimumVersion: MINIMUM, qualification: "unverified" });
    });
  }

  test("a missing executable gives GIT_UNAVAILABLE", () => {
    const result = admitGitProbe(null, true);
    expect(result).toEqual({ gitCode: "GIT_UNAVAILABLE", minimumVersion: MINIMUM, qualification: "unverified" });
  });
});

describe("Git admission on other platforms (T293)", () => {
  for (const version of ["2.55.0", "2.56.1"]) {
    test(`${version} is admitted with the minimum 2.55.0, and qualification stays unverified`, () => {
      const result = admitGitProbe(versionOutput(version), false);
      expect(result).toEqual({ admission: "admitted", detectedVersion: version, minimumVersion: POSIX_MINIMUM, qualification: "unverified" });
    });
  }

  test("2.54.9 gives GIT_UNSUPPORTED with the detected version and the minimum 2.55.0", () => {
    const result = admitGitProbe(versionOutput("2.54.9"), false);
    expect(result).toEqual({
      admission: "unsupported",
      gitCode: "GIT_UNSUPPORTED",
      detectedVersion: "2.54.9",
      minimumVersion: POSIX_MINIMUM,
      qualification: "unverified",
    });
  });

  test("a Git for Windows version gives GIT_UNSUPPORTED with the minimum 2.55.0", () => {
    const result = admitGitProbe(versionOutput("2.55.0.windows.3"), false);
    expect(result).toMatchObject({ admission: "unsupported", gitCode: "GIT_UNSUPPORTED", minimumVersion: POSIX_MINIMUM, qualification: "unverified" });
  });

  test("version output without a cpu line is admitted with the minimum 2.55.0", () => {
    expect(admitGitProbe(versionOutput("2.55.0"), false)).toEqual({ admission: "admitted", detectedVersion: "2.55.0", minimumVersion: POSIX_MINIMUM, qualification: "unverified" });
  });

  test("the default rule is the rule of the host", () => {
    const output = versionOutput("2.55.0");
    const expected: GitAdmission = isWindows
      ? { admission: "unsupported", gitCode: "GIT_UNSUPPORTED", detectedVersion: "2.55.0", minimumVersion: MINIMUM, qualification: "unverified" }
      : { admission: "admitted", detectedVersion: "2.55.0", minimumVersion: POSIX_MINIMUM, qualification: "unverified" };
    expect(admitGitProbe(output)).toEqual(expected);
    expect(admitGitProbe(output, isWindows)).toEqual(expected);
  });
});

describe("Git image machine (T413)", () => {
  test("a PE head with IMAGE_FILE_MACHINE_AMD64 is x64 on Windows", () => {
    expect(isX64Image(pe(AMD64), true)).toBe(true);
  });

  for (const [name, machine] of [["ARM64", ARM64], ["I386", I386], ["UNKNOWN", 0]] as const) {
    test(`a PE head with IMAGE_FILE_MACHINE_${name} is not x64`, () => {
      expect(isX64Image(pe(machine), true)).toBe(false);
    });
  }

  test("a bad PE signature, a missing MZ, or a truncated PE head is not x64", () => {
    const noMz = pe(AMD64);
    noMz[0] = 0;
    for (const head of [pe(AMD64, 0x80, [0x50, 0x45, 0, 1]), noMz, pe(AMD64).subarray(0, 0x80 + 5), pe(AMD64).subarray(0, 0x3f), new Uint8Array(0)]) {
      expect(isX64Image(head, true)).toBe(false);
    }
  });

  test("the PE head bound: Machine must end inside the first IMAGE_HEAD_BYTES bytes", () => {
    expect(isX64Image(pe(AMD64, IMAGE_HEAD_BYTES - 6).subarray(0, IMAGE_HEAD_BYTES), true)).toBe(true);
    expect(isX64Image(pe(AMD64, IMAGE_HEAD_BYTES - 5).subarray(0, IMAGE_HEAD_BYTES), true)).toBe(false);
  });

  test("an ELF head is not x64 on Windows, and a PE head is not x64 elsewhere", () => {
    expect(isX64Image(elf(EM_X86_64), true)).toBe(false);
    expect(isX64Image(pe(AMD64), false)).toBe(false);
  });

  test("an ELFCLASS64 ELFDATA2LSB head with EM_X86_64 is x64 on other platforms", () => {
    expect(isX64Image(elf(EM_X86_64), false)).toBe(true);
  });

  test("another e_machine, class, byte order, a bad magic, or a truncated ELF head is not x64", () => {
    const badMagic = elf(EM_X86_64);
    badMagic[1] = 0;
    for (const head of [elf(EM_AARCH64), elf(EM_X86_64, 1), elf(EM_X86_64, 2, 2), badMagic, elf(EM_X86_64).subarray(0, 19), new Uint8Array(0)]) {
      expect(isX64Image(head, false)).toBe(false);
    }
  });

  test("the default rule is the rule of the host", () => {
    expect(isX64Image(isWindows ? pe(AMD64) : elf(EM_X86_64))).toBe(true);
  });
});
