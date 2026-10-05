// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { admitGitProbe, type GitAdmission, MINIMUM_GIT_VERSION } from "../../src/git-service/admission";
import { isWindows } from "../../src/contracts/native-path";

printOrigin("../../src/git-service/admission.ts", import.meta.dir);
printOrigin("../../src/contracts/native-path.ts", import.meta.dir);

// plan.md "Provisional prerequisite admission". These strings are test inputs, not claims that such releases exist.
const MINIMUM = "2.55.0.windows.3";
// data-model.md §1 `admission`: the rule on other platforms.
const POSIX_MINIMUM = "2.55.0";

// `git version --build-options` output. The lines after `cpu:` follow Git 2.55.0.windows.3 on the reference host.
function buildOptions(version: string, cpu = "x86_64"): string {
  return [
    `git version ${version}`,
    `cpu: ${cpu}`,
    "built from commit: 52ca1113d651127f89477a8763f86ab20f645e1d",
    "sizeof-long: 4",
    "sizeof-size_t: 8",
    "shell-path: D:/git-sdk-64/usr/bin/sh",
    "feature: fsmonitor--daemon",
    "default-ref-format: files",
    "default-hash: sha1",
    "",
  ].join("\n");
}

describe("Git admission (T049)", () => {
  test("the minimum is the provisional reference-host version on Windows, and 2.55.0 elsewhere", () => {
    expect(MINIMUM_GIT_VERSION).toBe(isWindows ? MINIMUM : POSIX_MINIMUM);
  });

  for (const version of ["2.55.0.windows.3", "2.55.0.windows.4", "2.56.0.windows.1", "2.55.0.windows.10", "2.55.10.windows.1", "3.0.0.windows.1"]) {
    test(`x64 ${version} is admitted, and qualification stays unverified`, () => {
      const result = admitGitProbe(buildOptions(version), true);
      expect(result).toEqual({ admission: "admitted", detectedVersion: version, minimumVersion: MINIMUM, qualification: "unverified" });
    });
  }

  for (const version of ["2.55.0.windows.2", "2.54.0.windows.1", "2.9.0.windows.9", "2.54.99.windows.99"]) {
    test(`x64 ${version} gives GIT_UNSUPPORTED with the detected and minimum versions`, () => {
      const result = admitGitProbe(buildOptions(version), true);
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
    const result = admitGitProbe(buildOptions("2.55.0"), true);
    expect(result).toMatchObject({ admission: "unsupported", gitCode: "GIT_UNSUPPORTED", minimumVersion: MINIMUM, qualification: "unverified" });
  });

  test("ARM64 build options give GIT_UNSUPPORTED", () => {
    const result = admitGitProbe(buildOptions("2.55.0.windows.3", "aarch64"), true);
    expect(result).toMatchObject({ admission: "unsupported", gitCode: "GIT_UNSUPPORTED", minimumVersion: MINIMUM, qualification: "unverified" });
  });

  test("build options without a cpu line give GIT_UNSUPPORTED", () => {
    const result = admitGitProbe("git version 2.55.0.windows.3\n", true);
    expect(result).toMatchObject({ admission: "unsupported", gitCode: "GIT_UNSUPPORTED" });
  });

  for (const output of ["", "garbage\n", "git version\ncpu: x86_64\n", "git version 2.55.windows.3\ncpu: x86_64\n", "git version 2.55.0.windows.x\ncpu: x86_64\n", "unknown option: --build-options\n"]) {
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
    test(`x64 ${version} is admitted with the minimum 2.55.0, and qualification stays unverified`, () => {
      const result = admitGitProbe(buildOptions(version), false);
      expect(result).toEqual({ admission: "admitted", detectedVersion: version, minimumVersion: POSIX_MINIMUM, qualification: "unverified" });
    });
  }

  test("x64 2.54.9 gives GIT_UNSUPPORTED with the detected version and the minimum 2.55.0", () => {
    const result = admitGitProbe(buildOptions("2.54.9"), false);
    expect(result).toEqual({
      admission: "unsupported",
      gitCode: "GIT_UNSUPPORTED",
      detectedVersion: "2.54.9",
      minimumVersion: POSIX_MINIMUM,
      qualification: "unverified",
    });
  });

  test("a Git for Windows version gives GIT_UNSUPPORTED with the minimum 2.55.0", () => {
    const result = admitGitProbe(buildOptions("2.55.0.windows.3"), false);
    expect(result).toMatchObject({ admission: "unsupported", gitCode: "GIT_UNSUPPORTED", minimumVersion: POSIX_MINIMUM, qualification: "unverified" });
  });

  test("build options without a cpu: x86_64 line give GIT_UNSUPPORTED with the minimum 2.55.0", () => {
    for (const output of ["git version 2.55.0\n", buildOptions("2.55.0", "aarch64")]) {
      expect(admitGitProbe(output, false)).toEqual({
        admission: "unsupported",
        gitCode: "GIT_UNSUPPORTED",
        detectedVersion: "2.55.0",
        minimumVersion: POSIX_MINIMUM,
        qualification: "unverified",
      });
    }
  });

  test("the default rule is the rule of the host", () => {
    const output = buildOptions("2.55.0");
    const expected: GitAdmission = isWindows
      ? { admission: "unsupported", gitCode: "GIT_UNSUPPORTED", detectedVersion: "2.55.0", minimumVersion: MINIMUM, qualification: "unverified" }
      : { admission: "admitted", detectedVersion: "2.55.0", minimumVersion: POSIX_MINIMUM, qualification: "unverified" };
    expect(admitGitProbe(output)).toEqual(expected);
    expect(admitGitProbe(output, isWindows)).toEqual(expected);
  });
});
