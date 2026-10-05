// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { printOrigin } from "../origin";
import { NATIVE, PATH_RULES } from "../../src/contracts/native-path";

printOrigin("../../src/contracts/native-path.ts", import.meta.dir);

describe("the Windows rule set", () => {
  const rules = PATH_RULES.windows;

  test.each(["C:\\x", "c:/x", "\\\\server\\share", "//server/share"])("isAbsolute accepts %p", (path) => {
    expect(rules.isAbsolute(path)).toBe(true);
  });

  // Rust `Path::is_absolute` also refuses `\\server`, `\\server\`, and `\\.`.
  test.each(["x", "C:x", "\\x", "/x", "\\\\server", "\\\\server\\", "\\\\.", "\\\\.\\pipe\\x", "\\\\?\\C:\\x", "//./pipe/x", "//?/C:/x"])(
    "isAbsolute refuses %p",
    (path) => {
      expect(rules.isAbsolute(path)).toBe(false);
    },
  );

  test("isGitExecutable accepts git.exe in any letter case and refuses git.cmd", () => {
    expect(rules.isGitExecutable("C:\\Git\\cmd\\GIT.EXE")).toBe(true);
    expect(rules.isGitExecutable("C:\\Git\\cmd\\git.cmd")).toBe(false);
  });

  test("fold changes only the ASCII letters A to Z", () => {
    expect(rules.fold("C:\\Git\\\u212A")).toBe("c:\\git\\\u212A");
  });

  test.each(["pre-commit", "a.b", "é"])("isComponent accepts %p", (name) => {
    expect(rules.isComponent(name)).toBe(true);
  });

  test.each(["", ".", "..", "a\\b", "a/b", "x:y", "a<b", "nul", "COM1.txt", "x.", "x ", "a\u0001b"])("isComponent refuses %p", (name) => {
    expect(rules.isComponent(name)).toBe(false);
  });

  // Contract §7 "Inside and outside": a UNC path and a device path get no identity request.
  test.each(["\\\\server\\share\\x", "//server/share", "\\/server/share", "\\\\server", "\\\\.\\pipe\\x", "\\\\?\\C:\\x", "//./pipe/x", "//?/C:/x", "\\\\?\\UNC\\server\\share\\x"])(
    "isUncOrDevice accepts %p",
    (path) => {
      expect(rules.isUncOrDevice(path)).toBe(true);
    },
  );

  test.each(["C:\\x", "c:/x", "\\x", "/x", "x", "C:x"])("isUncOrDevice refuses %p", (path) => {
    expect(rules.isUncOrDevice(path)).toBe(false);
  });

  // Contract §7 "Program file digests": the absolute target of a link is its NT `SubstituteName` (MS-FSCC 2.1.2.4 and 2.1.2.5).
  test.each([
    ["\\??\\C:\\repo\\scripts\\h.sh", "C:\\repo\\scripts\\h.sh"],
    ["\\??\\c:\\", "c:\\"],
    ["\\??\\UNC\\server\\share\\x", "\\\\server\\share\\x"],
    ["\\??\\UNC\\server\\share", "\\\\server\\share"],
  ])("linkTarget maps %p to %p", (target, path) => {
    expect(rules.linkTarget(target)).toBe(path);
  });

  test("linkTarget gives a UNC path for the UNC form, so isUncOrDevice keeps it out of the roots", () => {
    expect(rules.isUncOrDevice(rules.linkTarget("\\??\\UNC\\server\\share\\x")!)).toBe(true);
    expect(rules.isUncOrDevice(rules.linkTarget("\\??\\C:\\x")!)).toBe(false);
  });

  test.each([
    "",
    "\\??\\",
    "\\??\\C:",
    "\\??\\C:x",
    "\\??\\C:/x",
    "\\??\\CC:\\x",
    "\\??\\Volume{0b5a9f3c-1c2d-4e5f-8a9b-0c1d2e3f4a5b}\\x",
    "\\??\\GLOBALROOT\\Device\\HarddiskVolume1\\x",
    "\\??\\UNC\\",
    "\\??\\UNC\\server",
    "\\??\\UNC\\server\\",
    "\\??\\UNC\\\\share",
    "\\??\\unc\\server\\share",
    "\\?\\C:\\x",
    "\\\\?\\C:\\x",
    "\\Device\\HarddiskVolume1\\x",
    "C:\\x",
    "\\\\server\\share",
    "/x",
  ])("linkTarget refuses %p", (target) => {
    expect(rules.linkTarget(target)).toBeNull();
  });
});

describe("the POSIX rule set", () => {
  const rules = PATH_RULES.posix;

  test.each(["/", "/x"])("isAbsolute accepts %p", (path) => {
    expect(rules.isAbsolute(path)).toBe(true);
  });

  test.each(["x", "C:\\x", "\\\\server\\share"])("isAbsolute refuses %p", (path) => {
    expect(rules.isAbsolute(path)).toBe(false);
  });

  test("isGitExecutable accepts git and refuses git.exe", () => {
    expect(rules.isGitExecutable("/usr/bin/git")).toBe(true);
    expect(rules.isGitExecutable("/usr/bin/git.exe")).toBe(false);
  });

  test("fold changes nothing", () => {
    expect(rules.fold("/Git/\u212A")).toBe("/Git/\u212A");
  });

  test.each(["x:y", "nul"])("isComponent accepts %p", (name) => {
    expect(rules.isComponent(name)).toBe(true);
  });

  test.each(["", ".", "..", "a/b", "a\u0000b"])("isComponent refuses %p", (name) => {
    expect(rules.isComponent(name)).toBe(false);
  });

  test.each(["//server/share", "/x", "\\\\server\\share", "\\\\.\\pipe\\x"])("isUncOrDevice refuses %p", (path) => {
    expect(rules.isUncOrDevice(path)).toBe(false);
  });

  // POSIX.1-2024 XBD 4.16: a link text that begins with a slash is an absolute pathname.
  test.each(["/", "/x/y", "//x/y"])("linkTarget keeps the absolute target %p", (target) => {
    expect(rules.linkTarget(target)).toBe(target);
  });

  test.each(["", "x", "../x", "\\??\\C:\\x"])("linkTarget refuses %p", (target) => {
    expect(rules.linkTarget(target)).toBeNull();
  });
});

test("NATIVE is the Windows rule set exactly when the host is win32", () => {
  expect(NATIVE === PATH_RULES.windows).toBe(process.platform === "win32");
  expect(NATIVE === PATH_RULES.posix).toBe(process.platform !== "win32");
});

test("no exported schema holds the Windows drive-letter pattern", () => {
  const root = join(import.meta.dir, "..", "..", "src", "contracts", "schemas");
  const hits = readdirSync(root).filter((name) => readFileSync(join(root, name), "utf8").includes("A-Za-z]:"));
  expect(hits).toEqual([]);
});
