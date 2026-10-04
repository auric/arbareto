// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { printOrigin } from "../origin";
import { foldAscii } from "../../src/contracts/fold-ascii";
import { insideInstallation } from "../../src/git-service/git-installation";

printOrigin("../../src/git-service/git-installation.ts", import.meta.dir);

// Contract §6 "Startup contexts": Windows paths compare with ASCII letter folding only.
describe("ASCII letter folding", () => {
  test("the installation-root check ignores ASCII letter case", () => {
    expect(insideInstallation("C:\\Git\\cmd\\git.exe", "c:\\GIT\\mingw64\\bin\\git.exe")).toBe(true);
    expect(insideInstallation("C:\\Git\\cmd\\git.exe", "C:\\Other\\mingw64\\bin\\git.exe")).toBe(false);
  });

  test("the Kelvin sign U+212A does not fold to k", () => {
    expect(foldAscii("AZaz\u212A\u00C4")).toBe("azaz\u212A\u00C4");
    expect(insideInstallation("C:\\Kit\\cmd\\git.exe", "C:\\\u212Ait\\mingw64\\bin\\git.exe")).toBe(false);
    expect(insideInstallation("C:\\\u212Ait\\cmd\\git.exe", "C:\\kit\\mingw64\\bin\\git.exe")).toBe(false);
  });
});
